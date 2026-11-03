/**
 * 单测：用户报「AI 调用工具居然有次数限制」「Kimi 跑两下就寄、没交付任何东西」的**根因回归**。
 *
 * 这个文件锁的是**行为**（不是实现细节），每条都对应一次真实故障：
 *
 *   H. 工具预算：旧上限 3 轮 → 读大脚本 + 查 API + 改写就被掐断；现在要能跑完，
 *      且 done.extra.toolBudget 如实报出用了几轮几次、是否耗尽。
 *   I. max_tokens 截断：思考模型 reasoning 与正文共享预算 → 正文半句被切；
 *      现在必须自动续写成完整答复，且续写请求本身协议合规（带 reasoning_content）。
 *   J. 剪枝规模：旧上限 600 字符会把 400 行代码削成十几行 → 模型看不到要改的代码；
 *      现在 ReadFile 读 400 行必须**原样**交给模型。
 *   K. 工具止损只对"同参数重复"生效：同工具换参数失败两次**不该**禁用该工具。
 *   L. SearchApi 长句查询不再返回 0 条（旧 AND 语义导致模型误判"API 不存在"）。
 *
 * 用法：node desktop/test/ai-budget.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAiBridge } from "../lib/ai/bridge.mjs";
import { createToolRunner } from "../lib/ai/tools.mjs";
import { createToolCache } from "../lib/ai/prune.mjs";
import { openSession } from "../lib/ai/session.mjs";
import { createApiIndex, defaultApiDocsPath } from "../lib/ai/apiIndex.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const dirs = [];
async function tmpDir() {
  const d = await mkdtemp(join(tmpdir(), "bwe-budget-"));
  dirs.push(d);
  return d;
}

/**
 * 假 OpenAI 兼容服务，与真实服务同规则的协议校验（同 ai-tools.test 的 startStrictModel）。
 *
 * plan(turn, hasTools, messages, maxTokens) 返回 chunk 数组。
 * 这里多看一个 maxTokens：截断场景要按"客户端给了多少预算"来决定吐多少。
 */
async function startFake(plan) {
  let turn = 0;
  const requests = [];
  const violations = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      turn += 1;
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      requests.push(parsed);
      const messages = parsed?.messages ?? [];
      const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
      const maxTokens = parsed?.max_tokens;

      const local = [];
      for (let i = 0; i < messages.length; i += 1) {
        const m = messages[i];
        // ① 带 tool_calls 的 assistant 必须带 reasoning_content（Kimi/DeepSeek 思考模式硬要求）
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && !m.reasoning_content) {
          local.push(`第 ${i} 条 assistant 带 tool_calls 但缺 reasoning_content`);
        }
        // ② tool 消息必须对得上某条 assistant 的 tool_calls
        if (m.role === "tool") {
          const prev = [...messages.slice(0, i)].reverse().find((x) => x.role === "assistant" && x.tool_calls);
          const ids = (prev?.tool_calls ?? []).map((c) => c.id);
          if (!ids.includes(m.tool_call_id)) local.push(`第 ${i} 条 tool 的 id 找不到所属 assistant`);
        }
      }
      if (local.length) {
        violations.push({ turn, v: local });
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `The \`reasoning_content\` in the thinking mode must be passed back to the API. (${local.join("; ")})`,
              type: "invalid_request_error"
            }
          })
        );
        return;
      }

      const chunks = plan(turn, hasTools, messages, maxTokens);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((r) => server.close(r)),
    get turns() {
      return turn;
    },
    get requests() {
      return requests;
    },
    get violations() {
      return violations;
    }
  };
}

function toolCall({ id, name, args = {}, index = 0, reasoning = "先查一下。" }) {
  return [
    ...(reasoning ? [{ choices: [{ index: 0, delta: { reasoning_content: reasoning } }] }] : []),
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
          }
        }
      ]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 10 } }
  ];
}

/** 正文流，可指定 finish_reason（"stop" / "length"）。 */
function textStream(text, finish = "stop") {
  const out = [];
  for (let i = 0; i < text.length; i += 8) {
    out.push({ choices: [{ index: 0, delta: { content: text.slice(i, i + 8) } }] });
  }
  out.push({
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  });
  return out;
}

async function makeBridge({ baseUrl, maxTokens = 16384 }) {
  const dir = await tmpDir();
  const session = await openSession({ dir, workspace: REPO });
  const events = [];
  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache: createToolCache(join(dir, "tc")),
    getSettings: async () => ({
      ai: {
        provider: "openai-compatible",
        baseUrl,
        apiKey: "sk-test",
        modelFlash: "thinking-model",
        modelPro: "thinking-model",
        autoRoute: true,
        manualModel: "",
        activeModelId: "",
        models: [],
        contextWindow: 128000,
        maxTokens
      }
    }),
    sendEvent: (ev) => events.push(ev),
    log: () => {}
  });
  return { bridge, events, dir };
}

// ---------------------------------------------------------------------------
// H. 工具预算
// ---------------------------------------------------------------------------

 /**
 * H1：**工具没有次数上限**（用户明确要求「工具不该有次数限制」）。
 *
 * 历史三档：3 轮（用户报「调用工具有次数限制」）→ 12 轮/24 次 → **无上限**。
 * 这条用"远超任何旧上限"的轮数（20 轮）来证明：模型要调 20 次工具照样能跑完，
 * 且结束后仍能产出正文 —— 而不是被某个数字掐断。
 */
test("H1: 工具没有次数上限 —— 20 轮工具调用也能跑完并产出正文", async () => {
  // 模型前 20 轮都在调工具（每轮 1 个不同参数的 ReadFile），第 21 轮才给正文。
  // 若实现里还有任何次数上限（3 / 12 / 24），这条会红。
  const TOOL_ROUNDS = 20;
  const fake = await startFake((turn, hasTools) => {
    if (hasTools && turn <= TOOL_ROUNDS) {
      return toolCall({
        id: `call_h1_${turn}`,
        name: "ReadFile",
        args: { path: "package.json", from: turn * 3 + 1, lines: 3 },
        reasoning: `第 ${turn} 轮：读第 ${turn * 3 + 1} 行。`
      });
    }
    return textStream("20 轮工具调用之后给出的结论：脚本问题在 player.js 的 unstick 段。");
  });

  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl });
  await bridge.aiChat({
    requestId: "h1",
    messages: [{ role: "user", text: "看下工程几个脚本" }],
    context: { sceneDigest: "工程「预算测试」1 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const done = events.filter((e) => e.type === "done");
  assert.equal(done.length, 1, "应有一次 done");
  assert.ok(String(done[0].text).trim().length > 0, "20 轮工具后必须仍有正文（有任何次数上限这里就会空）");

  const stats = done[0].extra?.toolBudget;
  assert.ok(stats, "done.extra.toolBudget 必须存在（界面据此显示跑了多少）");
  assert.ok(stats.roundsUsed >= TOOL_ROUNDS, `应真的跑了 ≥${TOOL_ROUNDS} 轮，实际 ${stats.roundsUsed}`);
  assert.ok(stats.callsUsed >= TOOL_ROUNDS, `应记录 ≥${TOOL_ROUNDS} 次工具调用，实际 ${stats.callsUsed}`);
  // ★ 核心：**不存在"触顶"这回事**
  assert.equal(stats.budgetExhausted, false, "没有次数上限，budgetExhausted 必须恒为 false");
  assert.equal(stats.roundsMax, undefined, "不该再有 roundsMax（上限概念已删除）");
  assert.equal(stats.callsMax, undefined, "不该再有 callsMax（上限概念已删除）");
  assert.equal(stats.stopReason, null, `正常收尾时 stopReason 应为 null，实际 ${stats.stopReason}`);
  assert.equal(typeof stats.elapsedMs, "number");
  assert.equal(fake.violations.length, 0, `不该有协议违规：${JSON.stringify(fake.violations)}`);
});

/**
 * H2：唯一的终止条件是**无进展**（死循环），不是次数。
 *
 * 构造：模型每一轮都发**完全相同**的工具调用，而那个工具每次都返回**完全相同**的内容
 * （SearchApi("physics") 是纯查询，同一 query 结果恒定）。
 * → 这是真死循环，必须被中止；且中止后要给出兜底正文，不能静默结束。
 *
 * ⚠ 注意判据是"同一调用 + 同一结果 + 无正文"三件套：只要结果会变（比如 ReadFile 自动翻页），
 *   就不会被判成绕圈 —— 见 H3 的反向锁。
 */
test("H2: 反复做同一调用且结果不变 → 判定为绕圈中止（但仍有兜底正文）", async () => {
  const fake = await startFake((turn, hasTools) => {
    if (hasTools) {
      // 每一轮都是**一模一样**的调用（同 name 同参数）
      return toolCall({ id: `call_h2_${turn}`, name: "SearchApi", args: { query: "physics" }, reasoning: "再查一次。" });
    }
    return textStream("已停止工具循环（绕圈），基于已查到的信息给出结论：先看 bwe.physics.on 的碰撞回调。");
  });

  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl });
  await bridge.aiChat({ requestId: "h2", messages: [{ role: "user", text: "查物理 API" }], context: {} });
  await bridge.whenIdle();
  await fake.close();

  const done = events.filter((e) => e.type === "done");
  assert.equal(done.length, 1);
  assert.ok(String(done[0].text).trim().length > 0, "中止后必须有正文（兜底作答）");

  const stats = done[0].extra?.toolBudget;
  assert.equal(stats?.budgetExhausted, false, "不是次数触顶（那条概念已删除）");
  // ★ 核心：停止原因必须是"绕圈"，并如实上报
  assert.equal(stats?.stopReason, "stalled", `应如实报 stopReason=stalled，实际 ${stats?.stopReason}`);
  assert.ok(stats.roundsUsed > 0, "应记录跑了几轮");
  // 不能无限跑下去：绕圈检测必须在合理轮数内触发（不是几百轮）
  assert.ok(stats.roundsUsed <= 30, `绕圈应尽早被识别，实际跑了 ${stats.roundsUsed} 轮`);
  assert.equal(fake.violations.length, 0, `兜底轮也不能协议违规：${JSON.stringify(fake.violations)}`);
});

/**
 * H3：**反向锁** —— ReadFile 自动翻页时，同一个"不带 from"的调用每轮拿到的是**新内容**，
 * 所以**不能**被误判成绕圈。这是 H2 判据的关键反面（否则用户正常读文件会被中断）。
 */
test("H3: 反向锁 —— 同一 ReadFile 调用（不带 from）自动翻页时每轮内容不同，不得判为绕圈", async () => {
  // 模型每一轮都发**完全相同的** ReadFile(path) 调用（不带 from），
  // 靠工具自动游标读 400 行 → 401-800 → 801-1200 …（package.json 只有 46 行，改用 world.js）
  const fake = await startFake((turn, hasTools) => {
    if (hasTools && turn <= 6) {
      return toolCall({
        id: `call_h3_${turn}`,
        name: "ReadFile",
        args: { path: "web/examples/city/scripts/world.js" },
        reasoning: `第 ${turn} 轮：继续读 world.js。`
      });
    }
    return textStream("已经把 world.js 读完了，结论：交通 AI 在 trafficTick 段。");
  });

  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl });
  await bridge.aiChat({ requestId: "h3", messages: [{ role: "user", text: "读 world.js" }], context: {} });
  await bridge.whenIdle();
  await fake.close();

  const done = events.filter((e) => e.type === "done");
  assert.equal(done.length, 1);
  assert.ok(String(done[0].text).trim().length > 0, "应正常收尾并产出正文");
  const stats = done[0].extra?.toolBudget;
  // ★ 核心：没被判成绕圈（否则用户正常翻页会被"死循环保护"打断）
  assert.equal(
    stats?.stopReason,
    null,
    `自动翻页每轮内容不同，不该判为绕圈（stopReason=${stats?.stopReason}，stallPeak=${stats?.stallStreak}）`
  );
  // 而且每轮真的读到了**不同内容**（证明自动游标生效，这也是 stopReason 为 null 的原因）
  const toolEnds = events.filter((e) => e.type === "tool" && e.phase === "end" && e.name === "ReadFile");
  assert.ok(toolEnds.length >= 6, `应真的调用了 6 次，实际 ${toolEnds.length}`);
  // detail 形如「ReadFile world.js · 402 行 / 14.0K 字符」——行数/字符数应随翻页变化。
  // 若 6 次摘要完全相同，说明游标没生效（那时 stopReason 为 null 也是假的）。
  const sizes = [...new Set(toolEnds.map((e) => String(e.detail ?? "")))];
  assert.ok(
    sizes.length >= 2,
    `6 次相同调用应读到不同内容（至少 2 种摘要），实际只有 ${sizes.length} 种：${sizes[0]}`
  );
});

// I. max_tokens 截断续写
// ---------------------------------------------------------------------------

test("I1: finish_reason=length → 自动续写，最终正文是完整答复（不是半句）", async () => {
  const first = "第一步：先定位 player.js 里的 refreshCarSolids。";
  const rest = "第二步：把 vehicles 的 tag 改成 vehicle。第三步：重跑试跑验证。";
  // 第 1 次：正文被截断（finish_reason=length）
  // 第 2 次：续写返回剩下的部分
  const fake = await startFake((turn) => {
    if (turn === 1) return textStream(first, "length");
    return textStream(rest, "stop");
  });

  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl, maxTokens: 4096 });
  await bridge.aiChat({ requestId: "i1", messages: [{ role: "user", text: "怎么修车辆碰撞" }], context: {} });
  await bridge.whenIdle();
  await fake.close();

  const done = events.filter((e) => e.type === "done");
  assert.equal(done.length, 1);
  const text = String(done[0].text);
  // ★ 核心：两段都在，不是只有半句
  assert.ok(text.includes("refreshCarSolids"), `应保留第一段，实际：${text}`);
  assert.ok(text.includes("第三步"), `续写部分必须接上（否则用户看到的是半句），实际：${text}`);
  assert.equal(fake.turns >= 2, true, `应真的发生了续写请求，实际 ${fake.turns} 次请求`);
  assert.equal(done[0].extra?.truncated, false, "续写成功时 truncated 应为 false");
  assert.ok(done[0].extra?.autoContinued >= 1, `autoContinued 应 ≥1，实际 ${done[0].extra?.autoContinued}`);
  assert.equal(fake.violations.length, 0, `续写请求必须协议合规：${JSON.stringify(fake.violations)}`);
  // 续写请求里必须有一条"接着写"的指令（而不是让模型从零重答）
  const second = fake.requests[1];
  const lastUser = [...(second?.messages ?? [])].reverse().find((m) => m.role === "user");
  assert.ok(/继续|接着|不要重复/.test(String(lastUser?.content ?? "")), `续写指令缺失：${lastUser?.content}`);
});

test("I2: 续写次数用尽仍截断 → truncated=true 如实标记（界面要能提示）", async () => {
  // 永远 length：模拟 max_tokens 就是太小，续写也救不回来。
  const fake = await startFake(() => textStream("被截断的内容片段。", "length"));
  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl, maxTokens: 256 });
  await bridge.aiChat({ requestId: "i2", messages: [{ role: "user", text: "写长答案" }], context: {} });
  await bridge.whenIdle();
  await fake.close();

  const done = events.filter((e) => e.type === "done");
  assert.equal(done.length, 1);
  assert.equal(done[0].extra?.truncated, true, "续写用尽时必须如实标记 truncated，不能假装正常完成");
  assert.ok(done[0].extra?.autoContinued >= 1, "应至少尝试过一次续写");
  assert.ok(String(done[0].text).length > 0, "即使截断也要把已产出的内容交给用户，不能丢");
});

// ---------------------------------------------------------------------------
// J. 剪枝规模
// ---------------------------------------------------------------------------

test("J1: ReadFile 读 400 行（真实代码密度）→ 模型拿到的正文必须完整，不被剪枝", async () => {
  const runner = createToolRunner({
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache: createToolCache(await tmpDir())
  });
  // web/examples/city/scripts/player.js 是用户实际在改的文件（1408 行）
  const out = await runner.run({ name: "ReadFile", arguments: { path: "web/examples/city/scripts/player.js", from: 1, lines: 400 } });
  assert.equal(out.error, undefined, `ReadFile 不该失败：${out.error}`);
  const text = String(out.text);
  assert.ok(!text.includes("已剪枝"), `400 行内容不该被剪枝（旧上限 600 会削成十几行）`);
  assert.ok(out.meta?.lines === 400, `默认应读 400 行，实际 ${out.meta?.lines}`);
  assert.ok(text.length > 8000, `400 行代码应占 >8K 字符，实际 ${text.length}`);
  // 关键：必须包含行号定位信息，模型才能给出"改第 N 行"
  assert.ok(
    /第 1-400 行 \/ 共 1408 行/.test(text.split("\n")[0]),
    `头部应写明行范围，实际：${text.split("\n")[0]}`
  );
});

test("J2: 工具定义里必须有 ReadToolResult（剪枝提示指向的工具必须真的存在）", () => {
  const runner = createToolRunner({
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO))
  });
  const names = runner.definitions.map((d) => d.function.name);
  assert.ok(names.includes("ReadToolResult"), `工具清单缺 ReadToolResult：${names.join(",")}`);
  assert.ok(names.includes("ReadFile") && names.includes("SceneDigest") && names.includes("SearchApi"));
});

// ---------------------------------------------------------------------------
// K. 止损只对"同参数重复"
// ---------------------------------------------------------------------------

test("K: 同一工具换参数失败两次，**不该**被禁用（旧实现按 name 计数会误禁）", async () => {
  // 模型先读两个**不存在但不同**的路径（都失败），第三次读一个存在的路径（必须成功）
  const fake = await startFake((turn, hasTools) => {
    if (!hasTools) return textStream("结论：文件路径要写成仓库相对路径。");
    if (turn === 1) return toolCall({ id: "k1", name: "ReadFile", args: { path: "scripts/player.js" } });
    if (turn === 2) return toolCall({ id: "k2", name: "ReadFile", args: { path: "player.js" } });
    if (turn === 3) return toolCall({ id: "k3", name: "ReadFile", args: { path: "package.json" } });
    return textStream("读到了 package.json，工程正常。");
  });

  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl });
  await bridge.aiChat({ requestId: "k", messages: [{ role: "user", text: "看工程" }], context: {} });
  await bridge.whenIdle();
  await fake.close();

  const ends = events.filter((e) => e.type === "tool" && e.phase === "end" && e.name === "ReadFile");
  assert.equal(ends.length, 3, `应有 3 次 ReadFile 结束事件，实际 ${ends.length}`);
  assert.equal(ends[0].ok, false, "第 1 次（路径不存在）应失败");
  assert.equal(ends[1].ok, false, "第 2 次（换了个路径仍不存在）应失败");
  // ★ 核心：第 3 次换了参数 → 必须真的执行并成功，而不是被判"工具不可用"
  assert.equal(ends[2].ok, true, `换个参数后必须能成功，实际错误：${ends[2].error}`);
  const stopTexts = ends.filter((e) => /当前不可用/.test(String(e.detail ?? "")));
  assert.equal(stopTexts.length, 0, `不同参数不该触发"不可用"止损，实际 ${stopTexts.length} 次`);
});

// ---------------------------------------------------------------------------
// L. SearchApi 不返回 0 条
// ---------------------------------------------------------------------------

test("L: SearchApi 长句查询命中（旧 AND 语义会返回 0 条，导致模型以为 API 不存在）", async () => {
  const runner = createToolRunner({
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO))
  });
  // 用户实测那轮对话里模型的原话查询
  const queries = [
    "physics collision car vehicle move",
    "world findAll emit on",
    "car vehicle followRoad",
    "collision event hit"
  ];
  for (const q of queries) {
    const out = await runner.run({ name: "SearchApi", arguments: { query: q } });
    const text = String(out.text);
    assert.ok(!text.includes("未找到匹配"), `「${q}」不该 0 条命中，实际：${text.slice(0, 80)}`);
  }
  // 精确 API 必须能被搜到（模型据此确认 API 存在与否）
  const follow = await runner.run({ name: "SearchApi", arguments: { query: "car vehicle followRoad" } });
  assert.ok(String(follow.text).includes("bwe.vehicle.followRoad"), `应命中 bwe.vehicle.followRoad，实际：${follow.text.slice(0, 200)}`);
});

// ---------------------------------------------------------------------------
// M. 剪枝提示承诺的「续读」必须真的可用（harness 实测抓到的信息黑洞）
// ---------------------------------------------------------------------------

/**
 * 构造一个「**没有** toolCache」的 bridge —— 这正是 harness S7 抓到的配置。
 *
 * 缺陷形态：剪枝提示写着「用 ReadToolResult(sha1=…) 续读」，而 bridge 从未把 toolCache
 * 传给 toolRunner → 模型照提示调用 → 得到「本次运行没有配置 toolCache」→ 被剪掉的尾部
 * 成为信息黑洞，模型只能耗轮次重试。**提示指向不存在的能力，比不给提示更糟。**
 */
test("M: 没有 toolCache 时，剪枝后的 ReadToolResult 仍能续读到尾部（内存兜底）", async () => {
  const dir = await tmpDir();
  const session = await openSession({ dir, workspace: REPO });
  const events = [];
  const seenToolText = []; // 模型真正收到的 tool 消息内容
  const fake = await startFake((turn, hasTools, messages) => {
    // 记录上一轮模型收到的 tool 结果（用来断言续读内容）
    for (const m of messages ?? []) {
      if (m.role === "tool") seenToolText.push(String(m.content));
    }
    if (turn === 1) {
      // 必须构造一个**真的会被剪枝**的结果：读 400 行代码只有 ~14K，低于上限 24K 不会剪。
      // 这里读 web/examples/city/assets.json（89K、行很长的 JSON），一次 400 行必然触发剪枝。
      return toolCall({
        id: "m1",
        name: "ReadFile",
        args: { path: "web/examples/city/assets.json", lines: 400 },
        reasoning: "读工程素材清单。"
      });
    }
    if (turn === 2) {
      // 剪掉尾部之后，按提示用 ReadToolResult 续读
      const prev = seenToolText.join("\n");
      const sha = /sha1="([0-9a-f]{40})"/.exec(prev)?.[1];
      return toolCall({
        id: "m2",
        name: "ReadToolResult",
        args: { sha1: sha ?? "deadbeef", from: 200, lines: 100 },
        reasoning: "续读被剪掉的部分。"
      });
    }
    return textStream("读到了要改的代码段。");
  });

  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    // ⚠ 故意 **不传 toolCache**（harness S7 的现场）
    getSettings: async () => ({
      ai: {
        provider: "openai-compatible",
        baseUrl: fake.baseUrl,
        apiKey: "sk-test",
        modelFlash: "m",
        modelPro: "m",
        autoRoute: true,
        models: [],
        contextWindow: 128000,
        maxTokens: 16384
      }
    }),
    sendEvent: (ev) => events.push(ev),
    log: () => {}
  });
  await bridge.aiChat({ requestId: "m", messages: [{ role: "user", text: "读 player.js" }], context: {} });
  await bridge.whenIdle();
  await fake.close();

  const ends = events.filter((e) => e.type === "tool" && e.phase === "end");
  const readTool = ends.find((e) => e.name === "ReadToolResult");
  assert.ok(readTool, "应发生一次 ReadToolResult 调用");
  assert.equal(readTool.ok, true, `没有 toolCache 时也必须能续读，实际错误：${readTool.error}`);
  // 续读拿到的必须是真的尾部内容（不是空/错误文案）
  const lastToolMsg = seenToolText.filter((t) => t.includes("ReadToolResult")).pop() ?? "";
  assert.ok(!lastToolMsg.includes("不可用"), `不该出现「不可用」：${lastToolMsg.slice(0, 120)}`);
  assert.equal(fake.violations.length, 0, `不该协议违规：${JSON.stringify(fake.violations)}`);
});

test("M2: 剪枝结果真的被剪过时才登记内存（未剪枝的结果不该占位）", async () => {  const runner = createToolRunner({
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO))
  });
  const out = await runner.run({ name: "ReadFile", arguments: { path: "package.json" } });
  const text = String(out.text);
  // package.json 45 行 < 剪枝上限 → 不该出现续读指引
  assert.ok(!text.includes("已剪枝"), "小文件不该被剪枝");
  assert.ok(!text.includes("ReadToolResult"), "未剪枝时不该出现续读指引（否则引导模型去用不存在的 sha）");
});

/**
 * M5：**两条**续读通路都必须支持 8 位前缀。
 *
 * 工具定义写着「sha1（40 位十六进制，也接受前 8 位）」，而 prune.mjs 的剪枝摘要
 * 只显示 8 位 —— 模型完全可能照摘要给 8 位。实测踩过：内存通路修好后只支持完整
 * 40 位 → 「没配 toolCache」这个配置下，模型给 8 位就查不到，尾部又成黑洞。
 * 所以这条同时锁**内存通路（无 toolCache）**与**磁盘通路（有 toolCache）**。
 */
test("M5: 8 位 sha1 前缀在两种配置下都能续读（内存通路 / toolCache 通路）", async () => {
  for (const withToolCache of [false, true]) {
    const label = withToolCache ? "有 toolCache" : "无 toolCache（内存通路）";
    const dir = await tmpDir();
    const session = await openSession({ dir, workspace: REPO });
    const seen = [];
    const fake = await startFake((turn, hasTools, messages) => {
      for (const m of messages ?? []) if (m.role === "tool") seen.push(String(m.content));
      if (turn === 1) {
        return toolCall({
          id: "m5_1",
          name: "ReadFile",
          args: { path: "web/examples/city/assets.json", lines: 400 },
          reasoning: "读大 JSON。"
        });
      }
      if (turn === 2) {
        // 只看剪枝摘要里**显示的形态**：摘要里同时有 40 位与 8 位，这里故意取前 8 位
        const prev = seen.join("\n");
        const shown = /sha1="([0-9a-f]{8,40})"/.exec(prev)?.[1] ?? "";
        return toolCall({
          id: "m5_2",
          name: "ReadToolResult",
          args: { sha1: shown.slice(0, 8), from: 1, lines: 200 },
          reasoning: "按摘要里的 sha 续读。"
        });
      }
      return textStream("续读完成。");
    });

    const bridge = createAiBridge({
      session,
      repoRoot: REPO,
      workspaceRoot: REPO,
      apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
      toolCache: withToolCache ? createToolCache(join(dir, "tc")) : undefined,
      getSettings: async () => ({
        ai: {
          provider: "openai-compatible",
          baseUrl: fake.baseUrl,
          apiKey: "sk-test",
          modelFlash: "m",
          modelPro: "m",
          autoRoute: true,
          models: [],
          contextWindow: 128000,
          maxTokens: 16384
        }
      }),
      sendEvent: () => {},
      log: () => {}
    });
    await bridge.aiChat({ requestId: "m5", messages: [{ role: "user", text: "读大 JSON" }], context: {} });
    await bridge.whenIdle();
    await fake.close();

    const lastResult = seen.filter((t) => t.includes("ReadToolResult")).pop() ?? "";
    assert.ok(
      !lastResult.includes("找不到 sha1"),
      `[${label}] 8 位前缀不该查不到：${lastResult.slice(0, 140)}`
    );
    assert.ok(!lastResult.includes("不可用"), `[${label}] 不该报「不可用」：${lastResult.slice(0, 140)}`);
    assert.ok(lastResult.length > 100, `[${label}] 续读应拿到真实内容，实际 ${lastResult.length} 字符`);
    assert.equal(fake.violations.length, 0, `[${label}] 不该协议违规`);
  }
});

test("M3: toolWiringReport 必须能查出「剪枝续读通路断了」（这是 harness 抓到缺陷的集中自检）", async () => {
  // 造一个**未传 toolCache** 的 bridge：内存表仍存在 → 通路可达 → 不该报"两条都不可用"
  const dir = await tmpDir();
  const session = await openSession({ dir, workspace: REPO });
  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    getSettings: async () => ({ ai: { provider: "mock", models: [], maxTokens: 16384 } }),
    sendEvent: () => {},
    log: () => {}
  });
  const report = bridge.toolWiringReport();
  assert.ok(Array.isArray(report), "toolWiringReport 必须返回数组");
  assert.ok(
    report.some((w) => /未配置 toolCache/.test(w)),
    `没配 toolCache 必须显式告警（不是"只影响性能"），实际：${report.join(" | ")}`
  );
  // ★ 关键反向断言：不能因为没配 toolCache 就误报"通路都断了" —— 内存表是能用的
  assert.ok(
    !report.some((w) => /两条通路都不可用/.test(w)),
    `有内存表时不该报"通路断了"（误报会让维修方向错），实际：${report.join(" | ")}`
  );
  // 工具定义齐全时不该有"缺某工具"的告警
  assert.ok(!report.some((w) => /工具定义缺/.test(w)), `工具定义应齐全：${report.join(" | ")}`);
});

test("M4: 配了 toolCache + scriptRunner 时 toolWiringReport 应无告警（正常接线）", async () => {
  const dir = await tmpDir();
  const session = await openSession({ dir, workspace: REPO });
  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache: createToolCache(join(dir, "tc")),
    // ⚠ 脚本写类工具的执行器现在也是「接线」的一部分：只读时代的「完整接线」定义已过时。
    //    少它就该告警，所以这条夹具必须一起补上，否则它断言的是旧世界。
    scriptRunner: async (name, args) => ({ text: `stub:${name}:${JSON.stringify(args ?? {})}` }),
    getSettings: async () => ({ ai: { provider: "mock", models: [], maxTokens: 16384 } }),
    sendEvent: () => {},
    log: () => {}
  });
  assert.deepEqual(bridge.toolWiringReport(), [], "接线完整时不该有任何告警");
});

test("M4b: 反向锁 —— 没注入 scriptRunner 时，写类工具的断裂必须被自检报出来", async () => {
  // 为什么要有这条：这正是「工具描述承诺能改脚本、但宿主没接线」的形态。
  // 缺了它，模型会反复拿到「未接线」→ 耗轮次 → 最后什么都没交付，而启动日志一片干净。
  const dir = await tmpDir();
  const session = await openSession({ dir, workspace: REPO });
  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache: createToolCache(join(dir, "tc")),
    getSettings: async () => ({ ai: { provider: "mock", models: [], maxTokens: 16384 } }),
    sendEvent: () => {},
    log: () => {}
  });
  const report = bridge.toolWiringReport();
  assert.ok(
    report.some((w) => /scriptRunner/.test(w)),
    `没注入 scriptRunner 时必须告警，实际：${report.join(" | ")}`
  );
});

for (const c of cases) {
  try {
    await c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    console.error(`  ✗ ${c.name}\n    ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}
for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
console.log(`\nai-budget.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
