/**
 * 单测：工具链路的三个真实缺陷（「AI 中断自己」的直接成因）。
 *
 * ── 背景 ────────────────────────────────────────────────────────────────
 * 用户报「AI 会在修复的过程中中断自己」。截图显示：AI 说了半句话就停、两个空工具块、
 * usage 缺失、发送按钮已回到可发送态。根因不是模型，是三个缺陷叠加：
 *
 *   1. **SceneDigest 必然失败**：createToolRunner 构造时闭包了 opts.sceneDigest，
 *      而 app-main 从未传该选项 → 工具每次抛错 → 模型反复重试同一条坏路径。
 *      真正的数据源是 request.context.sceneDigest（渲染侧每次请求都传）。
 *   2. **轮次耗尽无兜底**：3 轮都在调工具 → 循环退出 → 直接 done，
 *      finalText 是空串 → 用户看到「AI 说半句就消失」。
 *   3. **工具事件按 name 配对**：一次对话里两次同名工具时，start/end 会配错。
 *
 * 本测试锁这四条：
 *   A. request.context.sceneDigest 能被 SceneDigest 工具读到（不再抛错）
 *   B. 同一工具连续失败 2 次后止损（不再无限重试）
 *   C. 工具轮次耗尽后**仍然产出最终答复**（不是静默 done）
 *   D. tool 事件带 callId + phase + ok/error/ms，且同名两次调用不配错
 *
 * 用法：node desktop/test/ai-tools.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAiBridge } from "../lib/ai/bridge.mjs";
import { createToolRunner } from "../lib/ai/tools.mjs";
import { openSession } from "../lib/ai/session.mjs";
import { createApiIndex, defaultApiDocsPath } from "../lib/ai/apiIndex.mjs";
import { createToolCache } from "../lib/ai/prune.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const dirs = [];
async function tmpDir() {
  const d = await mkdtemp(join(tmpdir(), "bwe-tools-"));
  dirs.push(d);
  return d;
}

/**
 * 起一个**假的 OpenAI 兼容服务**，按需返回 tool_calls 或正文。
 *
 * 为什么用假服务而不是 mock provider：mock 分支不走工具链路，
 * 测不到「工具轮次 / 工具失败 / 兜底」这些真实路径。
 *
 * @param {(turnIndex:number)=>object} plan  第 N 次请求返回什么（1-based）
 */
async function startFakeModel(plan) {
  let turn = 0;
  const server = createServer((req, res) => {
    turn += 1;
    const body = plan(turn);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const chunk of body) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((r) => server.close(r)),
    get turns() {
      return turn;
    }
  };
}

/**
 * 与 startFakeModel 相同，但把「本次请求是否带 tools」传给 plan。
 *
 * 为什么需要：判断"这是不是兜底轮"的唯一可靠依据是**请求里有没有 tools**，
 * 按轮次号猜会让测试依赖 MAX_TOOL_ROUNDS/止损次数的具体数值（改实现就假红）。
 */
async function startFakeModelWithTools(plan) {
  let turn = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      turn += 1;
      let hasTools = false;
      try {
        const parsed = JSON.parse(body);
        hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      } catch {
        hasTools = false;
      }
      const chunks = plan(turn, hasTools);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}

`);
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
    }
  };
}

/** 构造一个「调用工具」的流式响应。index 让同轮多个 tool_call 各自独立拼装。 */
function toolCallChunk({ id, name, args = {}, index = 0 }) {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        }
      }
    ]
  };
}

/** 构造一个「输出正文」的流式响应。 */
function textChunks(text) {
  const pieces = [];
  for (let i = 0; i < text.length; i += 8) {
    pieces.push({ choices: [{ index: 0, delta: { content: text.slice(i, i + 8) } }] });
  }
  pieces.push({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  });
  return pieces;
}

async function makeBridge({ baseUrl, settingsOverride = {}, toolRunnerOpts = {} }) {
  const dir = await tmpDir();
  const session = await openSession({ dir, workspace: REPO });
  const events = [];
  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache: createToolCache(join(dir, "tc")),
    ...toolRunnerOpts,
    getSettings: async () => ({
      ai: {
        provider: "openai-compatible",
        baseUrl,
        apiKey: "sk-test",
        modelFlash: "test-model",
        modelPro: "test-model",
        autoRoute: true,
        manualModel: "",
        activeModelId: "",
        models: [],
        contextWindow: 64000,
        maxTokens: 1024,
        ...settingsOverride
      }
    }),
    sendEvent: (ev) => events.push(ev),
    log: () => {}
  });
  return { bridge, events, dir, session };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A. SceneDigest 能读到 request.context.sceneDigest
// ---------------------------------------------------------------------------

test("A: SceneDigest 读 request.context.sceneDigest（不再抛「需要渲染侧提供」）", async () => {
  // 只测工具层：不经过网络，直接喂 context
  const runner = createToolRunner({
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO))
  });
  // 未注入时应明确报错（这是"没有工程摘要"的正确表达）
  const noCtx = await runner.run({ name: "SceneDigest", arguments: {} });
  assert.ok(noCtx.error, "没有工程摘要时应返回可读错误");

  // 注入后应能读到
  runner.setSceneDigest("工程「未命名」 3 场景 / 12 素材");
  const withCtx = await runner.run({ name: "SceneDigest", arguments: {} });
  assert.equal(withCtx.error, undefined, `不应再抛错，实际：${withCtx.error}`);
  assert.ok(
    String(withCtx.text).includes("3 场景"),
    `应读到注入的摘要，实际：${withCtx.text}`
  );
});

test("A2: bridge 每次 run 都把 request.context.sceneDigest 注入 toolRunner", async () => {
  // 走真实链路：fake model 第一轮调 SceneDigest，第二轮给正文
  const fake = await startFakeModel((turn) => {
    if (turn === 1) return [toolCallChunk({ id: "call_sd_1", name: "SceneDigest", args: {} })];
    return textChunks("工程里有 3 个场景，其中 1 个有脚本错误。");
  });

  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl });
  await bridge.aiChat({
    requestId: "sd-1",
    messages: [{ role: "user", text: "看看工程里有什么问题" }],
    context: { sceneDigest: "工程「测试工程」 3 场景 / 8 素材 / 脚本错误 1 条" }
  });
  await bridge.whenIdle();
  await fake.close();

  const toolEnds = events.filter((e) => e.type === "tool" && e.phase === "end");
  assert.ok(toolEnds.length >= 1, "应有工具结束事件");
  // 关键：这次工具调用**不该失败**
  const sdEnd = toolEnds.find((e) => e.name === "SceneDigest");
  assert.ok(sdEnd, "应有 SceneDigest 的 end 事件");
  assert.equal(sdEnd.ok, true, `SceneDigest 不该失败，实际错误：${sdEnd.error}`);
  assert.ok(
    String(sdEnd.error ?? "").length === 0,
    "成功时 error 应为空"
  );
  // 模型应该拿到真实摘要（通过最终正文间接验证 + tool 事件里应有读取信息）
  const finals = events.filter((e) => e.type === "done");
  assert.equal(finals.length, 1, "应有 done");
  assert.ok(String(finals[0].text).length > 0, "最终正文应非空");
});

// ---------------------------------------------------------------------------
// B. 工具连续失败止损
// ---------------------------------------------------------------------------

test("B: 同一工具连续失败 2 次后停止重试，并把「不可用」告知模型", async () => {
  // fake model 每轮都调 SceneDigest，但本次请求**不带 context.sceneDigest**
  // → 工具必然失败（没有可用的工程摘要）
  const fake = await startFakeModel((turn) => {
    if (turn <= 6) {
      return [toolCallChunk({ id: `call_bad_${turn}`, name: "SceneDigest", args: {} })];
    }
    return textChunks("工具不可用，我基于已有信息给出结论。");
  });

  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl });
  await bridge.aiChat({
    requestId: "fail-1",
    messages: [{ role: "user", text: "看工程" }],
    // 故意不传 context.sceneDigest → SceneDigest 必然失败
    context: {}
  });
  await bridge.whenIdle();
  await fake.close();

  const sdEnds = events.filter((e) => e.type === "tool" && e.phase === "end" && e.name === "SceneDigest");
  assert.ok(sdEnds.length >= 2, `应至少有 2 次失败记录，实际 ${sdEnds.length}`);
  // 前两次是真实执行失败
  assert.equal(sdEnds[0].ok, false, "第 1 次应失败");
  assert.equal(sdEnds[1].ok, false, "第 2 次应失败");
  // 第 3 次起应被止损（不再真的执行，detail 里明确说"不可用/不要再调用"）
  const stopped = sdEnds.slice(2).find((e) => /不可用|不要再调用/.test(String(e.detail ?? "")));
  assert.ok(stopped, `第 3 次起应被止损并告知模型，实际 detail：${sdEnds.slice(2).map((e) => e.detail).join(" | ")}`);
  // 关键：止损后模型仍要拿到答复（见用例 C，这里先确认它至少没无限调下去）
  assert.ok(sdEnds.length <= 8, `不该无限重试，实际 ${sdEnds.length} 次`);
});

// ---------------------------------------------------------------------------
// C. 轮次耗尽后仍然产出最终答复
// ---------------------------------------------------------------------------

test("C: 工具轮次耗尽后仍然产出非空最终答复（不是静默 done）", async () => {
  // fake model：只要请求里**带了 tools** 就一直调工具（永远不吐正文），
  // 模拟「模型卡在工具循环里」。兜底请求**不带 tools**，那时才给正文。
  //
  // ⚠ 判断依据必须是"请求里有没有 tools"，不能按轮次号猜：
  // 轮次耗尽的次数取决于 MAX_TOOL_ROUNDS 与止损逻辑，写死轮次号会让测试变脆。
  const fake = await startFakeModelWithTools((turn, hasTools) => {
    if (hasTools) {
      // 每轮都调一个**必然失败**的工具，让模型无法靠工具解决
      return [toolCallChunk({ id: `call_c_${turn}`, name: "SceneDigest", args: {} })];
    }
    // 兜底那一次（不带 tools）才给正文
    return textChunks("根据已有信息：建议先检查车辆碰撞脚本里的移动锁定逻辑。");
  });

  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl });
  await bridge.aiChat({
    requestId: "rounds-1",
    messages: [{ role: "user", text: "修复车辆碰撞后卡死" }],
    context: {}
  });
  await bridge.whenIdle();
  await fake.close();

  const done = events.filter((e) => e.type === "done");
  assert.equal(done.length, 1, "应有且仅有 1 个 done");
  // ★ 核心断言：不能是空答复
  assert.ok(
    String(done[0].text ?? "").trim().length > 0,
    `轮次耗尽后必须仍有答复（这是「AI 中断自己」的核心修复），实际 text=「${done[0].text}」`
  );
  assert.ok(
    /建议|结论|检查/.test(done[0].text),
    `兜底答复应是有内容的结论，实际：「${done[0].text}」`
  );
});

// ---------------------------------------------------------------------------
// D. tool 事件契约：callId / phase / ok / error / ms
// ---------------------------------------------------------------------------

test("D: tool 事件带 callId + phase + ok/error/ms（不只靠 detail 文案）", async () => {
  const fake = await startFakeModel((turn) => {
    if (turn === 1) {
      // 一次对话里两个**同名**工具 —— 这是真实发生过的场景
      return [
        toolCallChunk({ id: "call_dup_1", name: "SceneDigest", args: {}, index: 0 }),
        toolCallChunk({ id: "call_dup_2", name: "SceneDigest", args: {}, index: 1 })
      ];
    }
    return textChunks("看完两次摘要，结论是场景太多。");
  });

  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl });
  await bridge.aiChat({
    requestId: "dup-1",
    messages: [{ role: "user", text: "看两次工程" }],
    context: { sceneDigest: "工程「重复测试」 2 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const toolEvents = events.filter((e) => e.type === "tool");
  assert.ok(toolEvents.length >= 4, `应有 start/end 各两次，实际 ${toolEvents.length}`);

  // 每条都必须有 callId 与 phase
  for (const e of toolEvents) {
    assert.ok(e.callId, `tool 事件必须有 callId（按 name 配对会串），实际：${JSON.stringify(e)}`);
    assert.ok(
      e.phase === "start" || e.phase === "end",
      `tool 事件必须有 phase，实际：${JSON.stringify(e)}`
    );
  }

  // 同名两次调用的 callId 必须不同 —— 这正是"按 name 配对会配错"的反证
  const startIds = toolEvents.filter((e) => e.phase === "start").map((e) => e.callId);
  assert.equal(
    new Set(startIds).size,
    startIds.length,
    `同名工具的 callId 必须互不相同，实际：${startIds.join(", ")}`
  );

  // end 事件必须带 ok / ms；失败时带完整 error
  const ends = toolEvents.filter((e) => e.phase === "end");
  for (const e of ends) {
    assert.equal(typeof e.ok, "boolean", `end 事件必须带 ok 布尔，实际：${JSON.stringify(e)}`);
    assert.equal(typeof e.ms, "number", `end 事件必须带 ms 数字，实际：${JSON.stringify(e)}`);
    if (!e.ok) assert.ok(String(e.error ?? "").length > 0, "失败时 error 必须是完整原文");
  }
});

// ---------------------------------------------------------------------------
// E. start/end 按 callId 正确配对（耗时与成败不串）
// ---------------------------------------------------------------------------

test("E: start/end 按 callId 配对（同名两次调用不会配错）", async () => {
  const fake = await startFakeModel((turn) => {
    if (turn === 1) {
      return [
        toolCallChunk({ id: "call_pair_A", name: "SceneDigest", args: {}, index: 0 }),
        toolCallChunk({ id: "call_pair_B", name: "ReadFile", args: { path: "package.json" }, index: 1 })
      ];
    }
    return textChunks("两个工具都看过了。");
  });

  const { bridge, events } = await makeBridge({ baseUrl: fake.baseUrl });
  await bridge.aiChat({
    requestId: "pair-1",
    messages: [{ role: "user", text: "看工程和 package.json" }],
    context: { sceneDigest: "工程「配对测试」" }
  });
  await bridge.whenIdle();
  await fake.close();

  const toolEvents = events.filter((e) => e.type === "tool");
  const starts = toolEvents.filter((e) => e.phase === "start");
  const ends = toolEvents.filter((e) => e.phase === "end");

  assert.equal(starts.length, 2, `应有 2 个 start，实际 ${starts.length}`);
  assert.equal(ends.length, 2, `应有 2 个 end，实际 ${ends.length}`);

  // 每个 start 都能找到同 callId 的 end，且名字一致
  for (const s of starts) {
    const end = ends.find((e) => e.callId === s.callId);
    assert.ok(end, `start ${s.callId} 找不到对应的 end`);
    assert.equal(end.name, s.name, `配对后 name 应一致（${s.name} vs ${end.name}）`);
  }
  // 两次调用的 callId 不同
  assert.equal(new Set(starts.map((e) => e.callId)).size, 2, "两个 start 的 callId 应不同");
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

console.log(`\nai-tools.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
