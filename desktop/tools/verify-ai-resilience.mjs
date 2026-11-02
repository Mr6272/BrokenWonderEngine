/**
 * 端到端验收 harness：复刻 Kimi / DeepSeek「思考模式 + max_tokens 截断 + 工具协议」的真实行为，
 * 驱动**真实的** desktop/lib/ai/bridge.mjs（不是 mock provider），逐场景断言并打印证据表。
 *
 * ── 为什么用假服务而不是 mock provider ────────────────────────────────────
 * mock 分支根本不走网络与工具链路，测不到「400 协议违规 / finish_reason=length /
 * 轮次上限 / 剪枝后模型看到多少内容」这些真实成因。所以这里起一个本地 OpenAI 兼容
 * SSE 服务，按真实服务的规则**主动报错**（400 + JSON 报文）。
 *
 * ── 假服务复刻的四条硬约束（依据 platform.kimi.ai / DeepSeek 文档）──────────
 *   1. 思考模式：先流 reasoning_content，再流 content；
 *      历史里 assistant 若带 tool_calls 却缺 reasoning_content → 返回 400（原文照抄真实报错）。
 *   2. max_tokens 截断：达到预算就停流并给 finish_reason:"length"，正文在句中硬断
 *      —— 这正是用户「答半句就消失」的形态。
 *   3. 工具调用协议：一条 assistant 带全部 tool_calls + 配对的 N 条 tool 消息；
 *      tool_call_id 对不上 → 400。
 *   4. 每次请求体都落进 turn 数组，断言用（「我们到底发了什么」是一等证据）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node desktop/tools/verify-ai-resilience.mjs                        # 验收当前工作区代码
 *   node desktop/tools/verify-ai-resilience.mjs --lib=.tmp_ai/base-lib/desktop/lib/ai
 *                                                                      # 对照「修复前」快照
 *
 *   退出码：0 全部 PASS / 1 有 FAIL。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   · 断言只按**用户可见的结果**写，不按实现细节（不猜 MAX_TOOL_ROUNDS 的具体数值、
 *     不猜剪枝阈值），否则「改实现就假红」，红色会失去证据价值。
 *   · 每条 FAIL 必须带可复核的数值/报文片段。
 *   · 临时目录只落仓库 `.tmp_ai/` 下，结束即删；不写 %APPDATA%。
 */

import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");
const TMP_ROOT = join(REPO, ".tmp_ai");

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};
const LIB_DIR = argOf("lib") ? resolve(REPO, argOf("lib")) : join(DESKTOP, "lib", "ai");
const LABEL = argOf("label") || (argOf("lib") ? argOf("lib") : "desktop/lib/ai");

// 动态 import：让同一份 harness 能驱动「修复前快照」与「当前工作区代码」两套实现。
const { createAiBridge } = await import(pathToFileURL(join(LIB_DIR, "bridge.mjs")).href);
const { openSession } = await import(pathToFileURL(join(LIB_DIR, "session.mjs")).href);
const { createApiIndex, defaultApiDocsPath } = await import(pathToFileURL(join(LIB_DIR, "apiIndex.mjs")).href);
const { createToolCache } = await import(pathToFileURL(join(LIB_DIR, "prune.mjs")).href);
const { createToolRunner } = await import(pathToFileURL(join(LIB_DIR, "tools.mjs")).href);

/** 直接建一个注入了 toolCache 的 toolRunner（与 bridge 内部那份对照，用来二分缺陷位置）。 */
function createToolRunnerFor(repoRoot, toolCache) {
  return createToolRunner({
    repoRoot,
    workspaceRoot: repoRoot,
    apiIndex: createApiIndex(defaultApiDocsPath(repoRoot)),
    toolCache
  });
}

// ---------------------------------------------------------------------------
// 结果收集与打印
// ---------------------------------------------------------------------------

const results = [];
let scenarioKey = "";
let scenarioTitle = "";

function beginScenario(key, title) {
  scenarioKey = key;
  scenarioTitle = title;
  console.log(`\n### ${key} ${title}`);
}

function report(key, ok, detail) {
  results.push({ key, ok: Boolean(ok), detail: String(detail), scenario: scenarioKey });
  console.log(`[${key}] ${ok ? "PASS" : "FAIL"} — ${detail}`);
}

const subIds = new Map();
function sub() {
  const n = (subIds.get(scenarioKey) ?? 0) + 1;
  subIds.set(scenarioKey, n);
  const letters = "abcdefghij";
  return `${scenarioKey}${letters[n - 1] ?? n}`;
}

/** 场景汇总行：`[S1] PASS/FAIL — 细节`。 */
function summarizeScenario(key = scenarioKey) {
  const rows = results.filter((r) => r.scenario === key);
  const okRows = rows.filter((r) => r.ok);
  const failed = rows.filter((r) => !r.ok);
  const ok = failed.length === 0;
  const detail = ok
    ? `${okRows.length}/${rows.length} 子断言通过`
    : `${failed.length}/${rows.length} 子断言失败：${failed.map((r) => `${r.key}`).join(", ")}`;
  console.log(`[${key}] ${ok ? "PASS" : "FAIL"} — ${detail}`);
  return ok;
}

// ---------------------------------------------------------------------------
// 假 OpenAI 兼容服务
// ---------------------------------------------------------------------------

/** 默认 usage（思考模型真实会带 include_usage 打开后的 usage）。 */
const usageOf = ({ prompt = 320, completion = 48 } = {}) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion
});

/**
 * 协议校验：与真实服务同规则，违规就 400。
 * 返回 [] 表示合规；否则返回人类可读的违规原因数组。
 */
function validateProtocol(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i] ?? {};
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const rc = m.reasoning_content;
      if (typeof rc !== "string" || rc.length === 0) {
        out.push(`第 ${i} 条 assistant 带 ${m.tool_calls.length} 个 tool_calls 但缺 reasoning_content`);
      }
      const ids = m.tool_calls.map((c) => c?.id);
      if (new Set(ids).size !== ids.length) out.push(`第 ${i} 条 assistant 的 tool_call id 有重复（${ids.join(",")}）`);
    }
    if (m.role === "tool") {
      const prev = [...messages.slice(0, i)].reverse()
        .find((x) => x?.role === "assistant" && Array.isArray(x.tool_calls) && x.tool_calls.length > 0);
      const ids = (prev?.tool_calls ?? []).map((c) => c?.id);
      if (!ids.includes(m.tool_call_id)) {
        out.push(`第 ${i} 条 tool 的 tool_call_id(${JSON.stringify(m.tool_call_id)}) 对不上前面 assistant 的 tool_calls（${ids.join(",")})`);
      }
    }
  }
  return out;
}

/** 一个 SSE 事件 → 一行 `data:` 文本。 */
function sseChunk(ev, fallbackUsage) {
  if (ev.kind === "usage") {
    return `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", choices: [], usage: ev.usage })}\n\n`;
  }
  const delta = {};
  if (ev.kind === "reasoning") delta.reasoning_content = ev.text;
  else if (ev.kind === "content") delta.content = ev.text;
  else if (ev.kind === "tool") {
    delta.tool_calls = ev.calls.map((c, idx) => ({
      index: c.index ?? idx,
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}) }
    }));
  }
  const chunk = { id: "chatcmpl-fake", object: "chat.completion.chunk", model: "fake", choices: [{ index: 0, delta }] };
  if (ev.kind === "finish") {
    chunk.choices[0].finish_reason = ev.reason;
    chunk.usage = ev.usage ?? fallbackUsage;
  }
  if (ev.kind !== "finish" && ev.usage) chunk.usage = ev.usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 起假服务。
 *
 * @param {(ctx:{turn:number, body:any, hasTools:boolean, messages:any[], state:any}) =>
 *          {events?:any[], status?:number, payload?:any}} plan
 * @param {object} [initialState]  场景私有状态（会以 ctx.state 传回 plan）
 */
async function makeFakeModel(plan, initialState = {}) {
  const state = {
    turns: [],          // 每次请求体（原文 + 解析结果）
    violations: [],     // 协议违规记录（每条都触发过 400）
    statuses: [],       // 每次响应的 HTTP 状态
    finishReasons: [],  // 每次流里出现过的 finish_reason
    ...initialState
  };

  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("only POST");
      return;
    }
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const turn = state.turns.length + 1;
      state.turns.push({ turn, raw, body });

      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
      const violation = validateProtocol(messages);
      if (violation.length > 0) {
        state.violations.push({ turn, violation });
        state.statuses.push(400);
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          error: {
            message: "The `reasoning_content` in the thinking mode must be passed back to the API. "
              + `(${violation.join("; ")})`,
            type: "invalid_request_error",
            code: "invalid_request_error"
          }
        }));
        return;
      }

      let out;
      try {
        out = plan({ turn, body, hasTools, messages, state });
      } catch (e) {
        out = { status: 500, payload: { error: { message: `fake plan crashed: ${e?.message || e}` } } };
      }
      if (out?.status) {
        state.statuses.push(out.status);
        res.writeHead(out.status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out.payload ?? {}));
        return;
      }

      state.statuses.push(200);
      const events = out?.events ?? [];
      for (const ev of events) {
        if (ev.kind === "finish" && ev.reason) state.finishReasons.push(ev.reason);
      }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      for (const ev of events) res.write(sseChunk(ev, usageOf()));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    state,
    get turnCount() {
      return state.turns.length;
    },
    close: () => new Promise((r) => server.close(r))
  };
}

/** 把一段正文切成 ≤40 字符的增量（像真模型逐 token 吐字）。 */
function contentPieces(text, size = 40) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push({ kind: "content", text: text.slice(i, i + size) });
  return out;
}

/** 一个「调用工具」的 SSE 事件。 */
const toolEvent = (calls) => ({ kind: "tool", calls: [].concat(calls) });

/** 完整一轮「思考 + 工具调用」的事件序列（真实的思考模型形态）。 */
function thinkingToolTurn({ calls, reasoning = "我需要先读一下相关文件再判断。", text = "" }) {
  const events = [{ kind: "reasoning", text: reasoning }];
  if (text) events.push(...contentPieces(text));
  events.push(toolEvent(calls));
  events.push({ kind: "finish", reason: "tool_calls", usage: usageOf() });
  return events;
}

// ---------------------------------------------------------------------------
// 场景脚手架：独立目录 + bridge 装配
// ---------------------------------------------------------------------------

const createdDirs = [];

/**
 * 带重试的 openSession。
 *
 * 为什么需要：Windows 上 `writeJsonAtomic` 的 `rename(.tmp → history.json)` 偶发 EPERM
 * （杀软/索引器/另一个并发进程短暂持有目录）。那是环境抖动，不是被测代码的缺陷；
 * 不重试会让「场景崩溃」污染证据表，把基础设施问题误判成 FAIL。
 */
async function openSessionWithRetry(sessionDir, workspace, attempts = 4) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await openSession({ dir: sessionDir, workspace });
    } catch (e) {
      lastErr = e;
      if (!/EPERM|EACCES|EBUSY|ENOTEMPTY/i.test(String(e?.code ?? e?.message ?? ""))) throw e;
      await sleep(120 * (i + 1));
    }
  }
  throw lastErr;
}

async function makeBridge(scenarioName, baseUrl, opts = {}) {
  const {
    maxTokens = 1024, modelId = "kimi-think", model = "kimi-k2-thinking",
    workspaceRoot = REPO, withToolCache = true
  } = opts;
  await mkdir(TMP_ROOT, { recursive: true });
  const dir = await mkdtemp(join(TMP_ROOT, `${scenarioName}-`));
  createdDirs.push(dir);
  const sessionDir = join(dir, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const session = await openSessionWithRetry(sessionDir, workspaceRoot);

  const events = [];
  const logs = [];
  // withToolCache=false 复刻「完全没配 toolCache」的现场（ReadToolResult 只能靠内存兜底）。
  const toolCache = withToolCache ? createToolCache(join(dir, "tool-cache")) : undefined;
  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache,
    // settings 注入方式与 desktop/test/ai-tools.test.mjs 的 makeBridge 一致：
    // getSettings 返回 { ai: {...} }；activeModelId 强制选中清单里的那一条「思考模型」。
    getSettings: async () => ({
      ai: {
        provider: "openai-compatible",
        baseUrl,
        apiKey: "sk-fake",
        modelFlash: model,
        modelPro: model,
        autoRoute: true,
        manualModel: "",
        activeModelId: modelId,
        models: [{
          id: modelId,
          label: "Kimi 思考（假服务）",
          provider: "openai-compatible",
          baseUrl,
          model,
          apiKey: "sk-fake",
          contextWindow: 128000,
          maxTokens
        }],
        contextWindow: 128000,
        maxTokens
      }
    }),
    sendEvent: (ev) => events.push(ev),
    log: (m) => logs.push(String(m))
  });

  return { bridge, events, logs, dir, session, toolCache };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const doneOf = (events) => events.filter((e) => e.type === "done");
const errorsOf = (events) => events.filter((e) => e.type === "error");
const toolEnds = (events) =>
  events.filter((e) => e.type === "tool" && e.phase === "end");
const toolStarts = (events) =>
  events.filter((e) => e.type === "tool" && e.phase === "start");

/** 从某次请求体里取最后一条 tool 消息的 content（= 「模型实际拿到什么」的铁证）。 */
function lastToolMessageOf(turn) {
  const messages = turn?.body?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "tool") return String(messages[i].content ?? "");
  }
  return "";
}

/** 从某次请求体里取全部 tool 消息。 */
function allToolMessagesOf(turn) {
  return (turn?.body?.messages ?? []).filter((m) => m?.role === "tool").map((m) => String(m.content ?? ""));
}

/** 找「截断/上限」信号：只看**结构化字段与独立事件**，不从正文里猜。 */
function detectTruncationSignal(events, done) {
  const hits = [];
  const extra = done?.extra ?? {};

  // ① 结构化字段：这些字段一旦出现，界面就有依据提示用户「回答被截断」。
  if (extra.truncated === true) hits.push("done.extra.truncated=true");
  if (extra.finishReason) hits.push(`done.extra.finishReason=${JSON.stringify(extra.finishReason)}`);
  if (Number.isFinite(extra.autoContinued) && extra.autoContinued > 0) {
    hits.push(`done.extra.autoContinued=${extra.autoContinued}（发生过自动续写）`);
  }
  if (extra.toolBudget && extra.toolBudget.budgetExhausted === true) {
    hits.push(`done.extra.toolBudget.budgetExhausted=true（${JSON.stringify(extra.toolBudget)}）`);
  }
  if (extra.budgetExhausted === true) hits.push("done.extra.budgetExhausted=true");

  // ② 独立事件：notice/warning/truncated 类事件（不是 delta/usage/route/thinking）。
  const passthrough = new Set(["delta", "usage", "route", "thinking"]);
  for (const e of events) {
    if (passthrough.has(e.type)) continue;
    const kind = String(e.type ?? "");
    if (!/truncat|notice|warning|overflow|limit|budget/i.test(kind)) continue;
    const s = JSON.stringify(e).slice(0, 260);
    hits.push(`${kind} 事件：${s}`);
  }

  // ③ 正文尾部的**显式提示**（用户能看到的道歉/续写说明）。
  const tail = String(done?.text ?? "").slice(-200);
  if (/回答被截断|输出被截断|因长度上限被截断|未写完|回答未完|请回复「继续」|被截断/i.test(tail)) {
    hits.push(`done.text 尾部提示：…${tail.slice(-90)}`);
  }
  return hits;
}

const ENDS_CLEAN = (text) => /[。！？.!?）】」"'\]]$/.test(String(text ?? "").trim());

// ---------------------------------------------------------------------------
// S0 · 自检：假服务真的会返回 400 报文（否则 S2/S6 的「无违规」是空断言）
// ---------------------------------------------------------------------------

async function scenarioS0() {
  beginScenario("S0", "假服务自检：故意违反协议时必须返回 400 + JSON 报文（否则「无违规」是空断言）");

  const fake = await makeFakeModel(({ turn }) => ({
    events: [
      ...contentPieces("自检正文"),
      { kind: "finish", reason: "stop", usage: usageOf() }
    ]
  }));

  // ① 违规：assistant 带 tool_calls 但缺 reasoning_content
  const bad1 = await fetch(`${fake.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-fake" },
    body: JSON.stringify({
      model: "kimi-k2-thinking",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_x", type: "function", function: { name: "ReadFile", arguments: "{}" } }] }
      ]
    })
  });
  const body1 = await bad1.text();

  // ② 违规：tool 消息的 tool_call_id 对不上
  const bad2 = await fetch(`${fake.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-fake" },
    body: JSON.stringify({
      model: "kimi-k2-thinking",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "想一下",
          tool_calls: [{ id: "call_y", type: "function", function: { name: "ReadFile", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "call_z", content: "result" }
      ]
    })
  });
  const body2 = await bad2.text();

  // ③ 合规：同样形状但 reasoning_content 齐全、id 配对 → 200
  const good = await fetch(`${fake.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-fake" },
    body: JSON.stringify({
      model: "kimi-k2-thinking",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "想一下",
          tool_calls: [{ id: "call_ok", type: "function", function: { name: "ReadFile", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "call_ok", content: "result" }
      ]
    })
  });
  const goodBody = await good.text();
  await fake.close();

  let msg1 = "";
  try {
    msg1 = JSON.parse(body1)?.error?.message ?? "";
  } catch {
    msg1 = "";
  }

  report(
    sub(),
    bad1.status === 400 && /reasoning_content/i.test(msg1),
    `缺 reasoning_content → HTTP ${bad1.status}，报文 error.message=「${msg1.slice(0, 110)}」`
  );

  report(
    sub(),
    bad2.status === 400 && /tool_call_id/i.test(body2),
    `tool_call_id 不配对 → HTTP ${bad2.status}，报文片段「${body2.slice(0, 140).replace(/\n/g, " ")}」`
  );

  report(
    sub(),
    good.status === 200 && goodBody.includes("自检正文"),
    `合规请求 → HTTP ${good.status}，正常流式返回正文（${goodBody.length} 字节报文）`
  );

  summarizeScenario();
}

// ---------------------------------------------------------------------------
// S1 · 思考模型 + maxTokens=4096 达到预算截断（用户「答半句就消失」的形态）
// ---------------------------------------------------------------------------

/** 一段「没有句末标点、只有结尾一个句号」的长正文 —— 保证任何预算切点都落在句子中间。 */
function buildTruncationAnswer() {
  const parts = [];
  for (let i = 0; i < 720; i += 1) parts.push(`检查项${i}的位置`);
  parts.push("。结论：先把移动锁定改成按帧推进，再复测碰撞退出。");
  return parts.join("");
}

async function scenarioS1() {
  beginScenario("S1", "思考模型 + maxTokens=4096：达到预算就停流并给 finish_reason=length（正文句中硬断）");

  const ANSWER = buildTruncationAnswer();
  const fake = await makeFakeModel(({ body, state }) => {
    // 预算换算：1 token ≈ 0.8 字符（对中文偏保守；这里只求「一定被预算切在句中」）。
    const maxTokens = Number(body?.max_tokens ?? 0);
    const budget = maxTokens > 0 ? Math.max(8, Math.floor(maxTokens * 0.8)) : ANSWER.length;
    const start = state.emitted ?? 0;
    const end = Math.min(ANSWER.length, start + budget);
    state.emitted = end;
    const events = [{ kind: "reasoning", text: "先梳理车辆碰撞与移动锁定的关系，再给出修法。" }];
    events.push(...contentPieces(ANSWER.slice(start, end)));
    events.push({
      kind: "finish",
      reason: end >= ANSWER.length ? "stop" : "length",
      usage: usageOf({ prompt: 900, completion: Math.max(8, Math.floor((end - start) / 1.25)) })
    });
    return { events };
  }, { emitted: 0 });

  const { bridge, events } = await makeBridge("s1", fake.baseUrl, { maxTokens: 4096 });
  await bridge.aiChat({
    requestId: "s1-truncation",
    messages: [{ role: "user", text: "车辆撞墙后角色卡死不动，帮我定位并修掉" }],
    context: { sceneDigest: "工程「碰撞测试」2 场景 / 脚本错误 0 条" }
  });
  await bridge.whenIdle();
  await fake.close();

  const done = doneOf(events)[0];
  const text = String(done?.text ?? "");
  const hits = detectTruncationSignal(events, done);
  const continued = fake.turnCount >= 2;
  const endsClean = ENDS_CLEAN(text);
  const sawLength = fake.state.finishReasons.includes("length");
  const budgetChars = Math.floor(4096 * 0.8);
  const autoContinued = Number(done?.extra?.autoContinued ?? 0);

  report(
    sub(),
    sawLength,
    `环境：假服务确实发生了 max_tokens 截断（finish_reason 序列=${JSON.stringify(fake.state.finishReasons)}，单轮预算=${budgetChars} 字符）`
  );

  report(
    sub(),
    text.length > 0,
    `done.text 非空：${text.length} 字符${done ? "" : "（没有 done 事件）"}`
  );

  report(
    sub(),
    continued && endsClean && text.length > budgetChars,
    endsClean && text.length > budgetChars
      ? `截断被自动续写修好：正文 ${text.length} 字符（单轮预算 ${budgetChars}，请求次数=${fake.turnCount}，autoContinued=${autoContinued}），最终完整到句末`
      : `未修好：正文 ${text.length} 字符，尾部「…${text.slice(-26).replace(/\n/g, "⏎")}」，请求次数=${fake.turnCount}，autoContinued=${autoContinued}`
  );

  report(
    sub(),
    autoContinued >= 1,
    `续写次数可从 done.extra 读出：autoContinued=${autoContinued}（本轮共 ${fake.turnCount} 次请求）`
  );

  report(
    sub(),
    continued || hits.length > 0,
    continued || hits.length > 0
      ? `截断没有被静默吞掉：${continued ? `自动续写（请求次数=${fake.turnCount}）` : ""}${continued && hits.length ? "；" : ""}${hits.length ? `告知信号=${hits.slice(0, 2).join(" | ")}` : ""}`
      : `截断被静默吞掉：只发了 1 次请求、done.extra 无任何截断字段、正文也没有半句提示 —— 用户只看到半句话`
  );

  report(
    sub(),
    hits.length > 0,
    hits.length
      ? `界面可消费的结构化截断信号：${hits.slice(0, 2).join(" | ")}`
      : "无结构化截断信号（stream.mjs 已解析 finishReason 但 bridge/UI 未消费，用户无法得知回答不完整）"
  );

  await scenarioS1b();
  summarizeScenario();
}

/**
 * S1b：模型**永远**在预算边缘截断（续写也截断）→ 必须如实标记 truncated=true，且续写路径本身协议合规。
 *
 * 这一条比 S1 更狠：S1 只要「一次续写就写完」；这里逼到 AUTO_CONTINUE_LIMIT 用尽，
 * 验证两件事：(a) 续写用的 assistant 消息带了 reasoning_content（否则思考模型直接 400）；
 * (b) 用尽后**不静默** —— done.extra.truncated=true 让界面能提示。
 */
async function scenarioS1b() {
  const CHUNK = 900; // 单轮永远吐不完的正文
  const fake = await makeFakeModel(({ turn, state }) => {
    const round = (state.round ?? 0) + 1;
    state.round = round;
    const seg = `【第${round}段】` + "甲".repeat(CHUNK);
    return {
      events: [
        { kind: "reasoning", text: `第 ${round} 轮思考：还要继续写。` },
        ...contentPieces(seg),
        { kind: "finish", reason: "length", usage: usageOf({ prompt: 800, completion: 300 }) }
      ]
    };
  }, { round: 0 });

  const { bridge, events } = await makeBridge("s1b", fake.baseUrl, { maxTokens: 1024 });
  await bridge.aiChat({
    requestId: "s1b-always-truncate",
    messages: [{ role: "user", text: "写一份很长的排查报告" }],
    context: { sceneDigest: "工程「截断测试」1 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const done = doneOf(events)[0];
  const text = String(done?.text ?? "");
  const truncated = done?.extra?.truncated === true;
  const autoContinued = Number(done?.extra?.autoContinued ?? 0);
  const errs = errorsOf(events);

  report(
    sub(),
    fake.state.violations.length === 0 && errs.length === 0,
    `续写路径协议合规：违规 ${fake.state.violations.length} 次、error ${errs.length} 个（请求 ${fake.turnCount} 次，状态码=${JSON.stringify(fake.state.statuses)}）`
      + (fake.state.violations.length ? `；违规=${JSON.stringify(fake.state.violations).slice(0, 240)}` : "")
  );

  report(
    sub(),
    autoContinued >= 1 && fake.turnCount >= 2,
    `确实触发了续写：autoContinued=${autoContinued}，请求次数=${fake.turnCount}`
  );

  report(
    sub(),
    text.length > 0 && !ENDS_CLEAN(text),
    `续写用尽后正文仍完整拼接：${text.length} 字符（各段：${(text.match(/【第\d+段】/g) ?? []).join("")}），尾部「…${text.slice(-24)}」`
  );

  report(
    sub(),
    truncated,
    truncated
      ? `如实标记截断：done.extra.truncated=true（autoContinued=${autoContinued}）→ 界面可提示「回答被截断，请调大最大输出 token」`
      : `未标记：done.extra.truncated=${JSON.stringify(done?.extra?.truncated)}，用户只会看到半句话且不知道原因`
  );
}

// ---------------------------------------------------------------------------
// S2 · 工具轮 + 随后一轮用户追问（多轮重放必须合规，不得 400）
// ---------------------------------------------------------------------------

async function scenarioS2() {
  beginScenario("S2", "工具轮后用户追问：buildMessages 重放历史必须带 reasoning_content + 配对 tool_calls（否则 400）");

  const fake = await makeFakeModel(({ turn }) => {
    if (turn === 1) {
      return {
        events: thinkingToolTurn({
          calls: [{ id: "call_s2_1", name: "ReadFile", args: { path: "package.json" } }],
          reasoning: "先读 package.json 看有哪些脚本。"
        })
      };
    }
    if (turn === 2) {
      return {
        events: [
          { kind: "reasoning", text: "脚本清单看到了，可以作答。" },
          ...contentPieces("package.json 里 scripts 段有 desk:test / verify:models 等条目。"),
          { kind: "finish", reason: "stop", usage: usageOf() }
        ]
      };
    }
    return {
      events: [
        { kind: "reasoning", text: "用户追问测试怎么做，我基于上一轮结论回答。" },
        ...contentPieces("第二轮回答：先跑 desk:test，再跑 verify:models 对照。"),
        { kind: "finish", reason: "stop", usage: usageOf() }
      ]
    };
  });

  const { bridge, events } = await makeBridge("s2", fake.baseUrl, { maxTokens: 1024 });
  await bridge.aiChat({
    requestId: "s2-a",
    messages: [{ role: "user", text: "读一下 package.json 的脚本" }],
    context: { sceneDigest: "工程「协议测试」2 场景" }
  });
  await bridge.whenIdle();
  await bridge.aiChat({
    requestId: "s2-b",
    messages: [{ role: "user", text: "那 AI 层怎么测" }],
    context: { sceneDigest: "工程「协议测试」2 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const third = fake.state.turns[2];
  const msgs = third?.body?.messages ?? [];
  const assistantWithCalls = msgs.find((m) => m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length);
  const toolMsgs = msgs.filter((m) => m?.role === "tool");
  const reasoningOk = Boolean(assistantWithCalls?.reasoning_content && String(assistantWithCalls.reasoning_content).length > 0);
  const pairingOk = toolMsgs.length > 0
    && toolMsgs.every((t) => (assistantWithCalls?.tool_calls ?? []).some((c) => c.id === t.tool_call_id));
  const errs = errorsOf(events);
  const dones = doneOf(events);

  report(
    sub(),
    fake.state.violations.length === 0,
    `假服务协议校验：${fake.state.violations.length} 次违规 / 请求 ${fake.turnCount} 次（状态码=${JSON.stringify(fake.state.statuses)}）${fake.state.violations.length ? "：" + JSON.stringify(fake.state.violations).slice(0, 300) : ""}`
  );

  report(
    sub(),
    reasoningOk && pairingOk,
    `第 3 次请求（重放历史）里 assistant(tool_calls) 带 reasoning_content=${reasoningOk}，tool 消息配对=${pairingOk}（tool 消息 ${toolMsgs.length} 条，assistant tool_calls ${(assistantWithCalls?.tool_calls ?? []).length} 个）`
  );

  report(
    sub(),
    errs.length === 0 && dones.length === 2 && dones.every((d) => String(d.text ?? "").trim().length > 0),
    `两轮对话：done=${dones.length} 个、error=${errs.length} 个；正文长度=${dones.map((d) => String(d.text ?? "").length).join("/")}`
      + (errs.length ? `；error 文案=${errs.map((e) => String(e.message).slice(0, 120)).join(" | ")}` : "")
  );

  summarizeScenario();
}

// ---------------------------------------------------------------------------
// S3 · 模型连续调工具 10 轮：轮次上限行为 + 最终答复非空 + done.extra 可读
// ---------------------------------------------------------------------------

async function scenarioS3() {
  beginScenario("S3", "模型连续 10 轮都要工具（且每次都成功）：上限行为 / 最终答复非空 / done.extra 可读");

  const fake = await makeFakeModel(({ turn, hasTools }) => {
    if (hasTools) {
      const path = turn % 2 === 1 ? "package.json" : "README.md";
      return {
        events: thinkingToolTurn({
          calls: [{ id: `call_s3_${turn}`, name: "ReadFile", args: { path } }],
          reasoning: `第 ${turn} 轮：继续读 ${path} 确认细节。`
        })
      };
    }
    return {
      events: [
        { kind: "reasoning", text: "工具次数到上限了，我基于已读内容作答。" },
        ...contentPieces("基于已读到的 package.json 与 README：建议先跑 desk:test，再跑 verify:models。"),
        { kind: "finish", reason: "stop", usage: usageOf() }
      ]
    };
  });

  const { bridge, events } = await makeBridge("s3", fake.baseUrl, { maxTokens: 1024 });
  await bridge.aiChat({
    requestId: "s3-rounds",
    messages: [{ role: "user", text: "把仓库里所有相关文件都读一遍再下结论" }],
    context: { sceneDigest: "工程「多轮工具」1 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const done = doneOf(events)[0];
  const text = String(done?.text ?? "");
  const extra = done?.extra ?? {};
  const budget = extra.toolBudget ?? null;
  const reads = toolEnds(events).filter((e) => e.name === "ReadFile");
  const okReads = reads.filter((e) => e.ok);
  const fallbackPseudo = (extra.toolCalls ?? []).filter((t) => String(t?.name ?? "") === "(final-answer-fallback)");
  const rounds = extra.rounds;
  const toolCalls = Array.isArray(extra.toolCalls) ? extra.toolCalls : null;

  report(
    sub(),
    text.trim().length > 0,
    `最终答复非空：${text.length} 字符（「${text.slice(0, 40)}…」）`
  );

  report(
    sub(),
    typeof rounds === "number" && rounds >= 1 && toolCalls !== null && toolCalls.length >= 1,
    `done.extra 可读出轮次与工具次数：rounds=${JSON.stringify(rounds)}，toolCalls.length=${toolCalls ? toolCalls.length : "缺失"}，其中名称=${(toolCalls ?? []).map((t) => t?.name).join(",")}`
  );

  report(
    sub(),
    Boolean(budget)
      && typeof budget.roundsUsed === "number"
      && typeof budget.roundsMax === "number"
      && typeof budget.callsUsed === "number"
      && typeof budget.callsMax === "number"
      && typeof budget.budgetExhausted === "boolean",
    `done.extra.toolBudget 五个字段齐全且类型正确：${JSON.stringify(budget)}`
  );

  report(
    sub(),
    Boolean(budget) && budget.budgetExhausted === true && okReads.length >= 10,
    `预算耗尽被如实上报：budgetExhausted=${JSON.stringify(budget?.budgetExhausted)}，callsUsed=${JSON.stringify(budget?.callsUsed)}/${JSON.stringify(budget?.callsMax)}，roundsUsed=${JSON.stringify(budget?.roundsUsed)}/${JSON.stringify(budget?.roundsMax)}，实际执行成功的工具调用 ${okReads.length} 次`
      + `；兜底伪轮=${fallbackPseudo.length ? "出现（" + fallbackPseudo.length + " 条 final-answer-fallback）" : "未出现"}`
  );

  report(
    sub(),
    okReads.length >= 10 && budget?.callsUsed >= 10,
    `「工具有次数限制」的真实额度：旧实现 3 轮封顶（@HEAD 实测仅 4 次成功调用后被迫收尾），`
      + `当前成功调用 ${okReads.length} 次、callsUsed=${budget?.callsUsed}（callsMax=${budget?.callsMax}），未被 3 轮硬上限截断`
  );

  summarizeScenario();
}

// ---------------------------------------------------------------------------
// S4 · ReadFile 读 1408 行文件：模型实际拿到多少内容（能否定位第 190 行）
// ---------------------------------------------------------------------------

const BIG_FILE_LINES = 1408;
const NEEDLE = "NEEDLE_AT_LINE_190";

async function scenarioS4() {
  beginScenario("S4", `ReadFile 读 ${BIG_FILE_LINES} 行文件：模型实际拿到的内容长度（能否定位到第 190 行）`);

  const probeDir = await mkdtemp(join(TMP_ROOT, "s4-file-"));
  createdDirs.push(probeDir);
  const lines = [];
  for (let i = 1; i <= BIG_FILE_LINES; i += 1) {
    if (i === 190) lines.push(`const ${NEEDLE} = "physics-collision-car-vehicle-move";`);
    else lines.push(`// L${String(i).padStart(4, "0")} 填充行用于复刻真实脚本长度 padding padding`);
  }
  const bigFile = join(probeDir, "big.js");
  await writeFile(bigFile, lines.join("\n"), "utf8");
  const relPath = relative(REPO, bigFile).replace(/\\/g, "/");

  const fake = await makeFakeModel(({ turn }) => {
    if (turn === 1) {
      return { events: thinkingToolTurn({ calls: [{ id: "call_s4_1", name: "ReadFile", args: { path: relPath } }] }) };
    }
    return {
      events: [
        { kind: "reasoning", text: "文件内容看到了，可以定位。" },
        ...contentPieces("已定位到脚本中段的问题行，建议按行号改动。"),
        { kind: "finish", reason: "stop", usage: usageOf() }
      ]
    };
  });

  const { bridge, events } = await makeBridge("s4", fake.baseUrl, { maxTokens: 1024 });
  await bridge.aiChat({
    requestId: "s4-readfile",
    messages: [{ role: "user", text: `读 ${relPath} 帮我定位问题行` }],
    context: { sceneDigest: "工程「大文件」1 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const content = lastToolMessageOf(fake.state.turns[1]);
  const fileChars = lines.join("\n").length;
  const prunedMark = /已剪枝/.test(content) ? content.match(/…（已剪枝：[^）]*）/)?.[0] ?? "已剪枝" : "";
  const coveredLines = content.split("\n").length;
  const readMetaLines = fake.state.turns[1] ? 400 : 0;

  report(
    sub(),
    content.length >= 3000,
    `模型实际拿到的工具结果 ${content.length} 字符（文件共 ${fileChars} 字符 / ${BIG_FILE_LINES} 行；行上限=400 行）`
      + (prunedMark ? `；剪枝标记：${prunedMark.slice(0, 130)}` : "；未剪枝（一次读够了）")
  );

  report(
    sub(),
    content.includes(NEEDLE),
    content.includes(NEEDLE)
      ? `结果里能看到第 190 行的标记「${NEEDLE}」→ 模型可以按行号定位`
      : `结果里看不到第 190 行（结果只覆盖 ${coveredLines} 行 / ${content.length} 字符${prunedMark ? "，被剪枝压成头部" : ""}）→ 模型无法定位行号`
  );

  report(
    sub(),
    // 核心：要么给足内容，要么给「可继续读」的明确指引（toolCache 路径模型读不到，不能算指引）。
    content.includes(NEEDLE) || /ReadFile\(from|from=<行号>|ReadToolResult|from\/lines|翻页/i.test(content),
    `可否续读的指引：${content.includes(NEEDLE) ? "内容已完整覆盖" : (/ReadToolResult|ReadFile\(from|from=<行号>|翻页/i.test(content) ? "给了可执行续读方式" : "只给了主进程本地 toolCache 路径（模型读不到）")}`
  );

  summarizeScenario();
}

// ---------------------------------------------------------------------------
// S5 · SearchApi 自然语言多词查询：不能是 0 条
// ---------------------------------------------------------------------------

const S5_QUERY = "physics collision car vehicle move";

async function scenarioS5() {
  beginScenario("S5", `SearchApi 自然语言多词查询「${S5_QUERY}」：不能返回 0 条`);

  const fake = await makeFakeModel(({ turn }) => {
    if (turn === 1) {
      return { events: thinkingToolTurn({ calls: [{ id: "call_s5_1", name: "SearchApi", args: { query: S5_QUERY } }] }) };
    }
    return {
      events: [
        { kind: "reasoning", text: "API 结果看到了。" },
        ...contentPieces("查到的 API 是 bwe.physics / bwe.collision / bwe.vehicle 系列。"),
        { kind: "finish", reason: "stop", usage: usageOf() }
      ]
    };
  });

  const { bridge, events } = await makeBridge("s5", fake.baseUrl, { maxTokens: 1024 });
  await bridge.aiChat({
    requestId: "s5-search",
    messages: [{ role: "user", text: "查一下物理碰撞和载具移动相关的 API" }],
    context: { sceneDigest: "工程「搜索」1 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const content = lastToolMessageOf(fake.state.turns[1]);
  const zeroHit = /未找到匹配/.test(content) || /→ 0 条/.test(content);
  const entries = (content.match(/^· /gm) ?? []).length;

  report(
    sub(),
    !zeroHit && entries >= 1,
    `模型拿到的搜索结果：${entries} 条${zeroHit ? "（未找到匹配 → 0 条）" : ""}；原文首行「${content.split("\n")[0]?.slice(0, 140) ?? ""}」`
  );

  report(
    sub(),
    content.length > 0 && !zeroHit,
    `结果不是 0 条：${zeroHit ? "命中了「未找到匹配」兜底文案（AND 全词匹配的后果：'car' 在库内 0 命中）" : `返回了 ${entries} 条`}`
  );

  summarizeScenario();
}

// ---------------------------------------------------------------------------
// S6 · 同一工具两个**不同参数**连续失败两次：不能被误判「不可用」而禁用
// ---------------------------------------------------------------------------

async function scenarioS6() {
  beginScenario("S6", "同一工具（ReadFile）用两个不同参数连续失败两次：第三次不同参数必须仍可执行");

  const fake = await makeFakeModel(({ turn }) => {
    if (turn === 1) {
      return { events: thinkingToolTurn({ calls: [{ id: "call_s6_a", name: "ReadFile", args: { path: "missing_a.txt" } }] }) };
    }
    if (turn === 2) {
      return { events: thinkingToolTurn({ calls: [{ id: "call_s6_b", name: "ReadFile", args: { path: "missing_b.txt" } }] }) };
    }
    if (turn === 3) {
      return { events: thinkingToolTurn({ calls: [{ id: "call_s6_c", name: "ReadFile", args: { path: "package.json" } }] }) };
    }
    return {
      events: [
        { kind: "reasoning", text: "package.json 读到了。" },
        ...contentPieces("读到 package.json：name=bwe-studio，scripts 里有 desk:test。"),
        { kind: "finish", reason: "stop", usage: usageOf() }
      ]
    };
  });

  const { bridge, events } = await makeBridge("s6", fake.baseUrl, { maxTokens: 1024 });
  await bridge.aiChat({
    requestId: "s6-failstreak",
    messages: [{ role: "user", text: "读几个文件看看" }],
    context: { sceneDigest: "工程「失败计数」1 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const reads = toolEnds(events).filter((e) => e.name === "ReadFile");
  const thirdTurnToolMsgs = allToolMessagesOf(fake.state.turns[3]);
  const thirdResult = thirdTurnToolMsgs[2] ?? "";
  const thirdEndEvent = reads[2];
  const skippedText = /当前不可用|不要再用同样的参数重试|已连续失败/i;

  report(
    sub(),
    reads.length >= 2 && reads[0].ok === false && reads[1].ok === false,
    `前提成立：前两次不同参数都失败（次数=${reads.length}，ok=${reads.map((r) => r.ok).join(",")}，error=${reads.map((r) => String(r.error ?? "").slice(0, 40)).join(" | ")}）`
  );

  report(
    sub(),
    Boolean(thirdEndEvent) && thirdEndEvent.ok === true,
    `第 3 次（参数 package.json，文件存在）真的执行了：ok=${JSON.stringify(thirdEndEvent?.ok)}`
      + `；detail=${String(thirdEndEvent?.detail ?? "").slice(0, 120)}`
  );

  report(
    sub(),
    !skippedText.test(thirdResult) && /bwe-studio|desk:test|scripts/.test(thirdResult),
    `模型收到的第 3 条 tool 结果 ${thirdResult.length} 字符：${skippedText.test(thirdResult) ? "是「判定不可用」截断文案（工具被按 name 误禁）" : "是真实文件内容"}`
      + `；片段「${thirdResult.slice(0, 90).replace(/\n/g, "⏎")}」`
  );

  summarizeScenario();
}

// ---------------------------------------------------------------------------
// S7 · 被剪枝的大结果必须能被 ReadToolResult 续读到（剪枝不能变成「信息黑洞」）
// ---------------------------------------------------------------------------

const HUGE_LINES = 400;
const HUGE_LINE_CHARS = 120;

async function scenarioS7() {
  beginScenario("S7", "超大工具结果被剪枝后，模型能用 ReadToolResult 续读到被省略的尾部（剪枝不是信息黑洞）");

  const probeDir = await mkdtemp(join(TMP_ROOT, "s7-file-"));
  createdDirs.push(probeDir);
  const lines = [];
  for (let i = 1; i <= HUGE_LINES; i += 1) {
    if (i === 350) lines.push(`const TAIL_NEEDLE_LINE_350 = "${"x".repeat(40)}";`);
    else lines.push(`// L${String(i).padStart(3, "0")} ${"y".repeat(HUGE_LINE_CHARS)}`);
  }
  const hugeFile = join(probeDir, "huge.js");
  await writeFile(hugeFile, lines.join("\n"), "utf8");
  const relPath = relative(REPO, hugeFile).replace(/\\/g, "/");

  const fake = await makeFakeModel(({ turn, messages }) => {
    if (turn === 1) {
      return { events: thinkingToolTurn({ calls: [{ id: "call_s7_read", name: "ReadFile", args: { path: relPath } }] }) };
    }
    if (turn === 2) {
      // 从第 1 轮 tool 结果里抠出 sha1（模型会看到「ReadToolResult(sha1="xxx"…)」提示）
      const toolText = [...messages].reverse().find((m) => m?.role === "tool")?.content ?? "";
      const m = /sha1="([0-9a-f]{8,40})"/.exec(String(toolText));
      const sha = m ? m[1] : "";
      return {
        events: thinkingToolTurn({
          calls: [{ id: "call_s7_tail", name: "ReadToolResult", args: { sha1: sha.slice(0, 8), from: 330, lines: 40 } }],
          reasoning: "结果被剪枝了，用 ReadToolResult 取回尾部。"
        })
      };
    }
    return {
      events: [
        { kind: "reasoning", text: "尾部读到了。" },
        ...contentPieces("已拿到被剪枝的尾部内容，可以给结论了。"),
        { kind: "finish", reason: "stop", usage: usageOf() }
      ]
    };
  });

  const { bridge, events, toolCache } = await makeBridge("s7", fake.baseUrl, { maxTokens: 1024 });
  await bridge.aiChat({
    requestId: "s7-toolresult",
    messages: [{ role: "user", text: `读 ${relPath} 并定位问题行` }],
    context: { sceneDigest: "工程「超大文件」1 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const firstToolText = allToolMessagesOf(fake.state.turns[1])[0] ?? "";
  // 第 3 次请求里最后一条 tool 消息 = ReadToolResult 的结果（不要写死下标：轮数会变）。
  const tailText = allToolMessagesOf(fake.state.turns[2]).at(-1) ?? "";
  const shaPromptOk = /ReadToolResult\(sha1="[0-9a-f]{8}/.test(firstToolText);
  const sha = (/sha1="([0-9a-f]{8,40})"/.exec(firstToolText) ?? [])[1] ?? "";
  const endsOfReadTool = toolEnds(events).filter((e) => e.name === "ReadToolResult");
  const needle = /TAIL_NEEDLE_LINE_350/.test(tailText);

  // 关键区分：数据到底有没有落进 toolCache？有 = 缺陷在 bridge→toolRunner 的接线；
  // 没有 = 缺陷在写缓存。两者修法完全不同，不查清楚就会修错地方。
  const cachedRaw = sha ? await toolCache.get(sha) : null;
  const cachedOk = cachedRaw !== null && /TAIL_NEEDLE_LINE_350/.test(String(cachedRaw));
  const directRunnerOk = await (async () => {
    if (!sha) return false;
    try {
      const runner = createToolRunnerFor(REPO, toolCache);
      const r = await runner.run({ name: "ReadToolResult", arguments: { sha1: sha.slice(0, 8), from: 320, lines: 60 } });
      return !r.error && /TAIL_NEEDLE_LINE_350/.test(String(r.text));
    } catch {
      return false;
    }
  })();

  report(
    sub(),
    /已剪枝/.test(firstToolText),
    `前提：大结果确实被剪枝（原文 ${lines.join("\n").length} 字符 → 模型看到 ${firstToolText.length} 字符）；剪枝提示=${(/…（已剪枝：[^）]*）/).exec(firstToolText)?.[0]?.slice(0, 140) ?? "无"}`
  );

  report(
    sub(),
    shaPromptOk,
    `剪枝提示写出了可执行续读句柄 ReadToolResult(sha1="…")=${shaPromptOk}（工具定义里也声明了这个工具）`
  );

  report(
    sub(),
    cachedOk,
    cachedOk
      ? `原始结果确实已落进 toolCache（sha1=${sha.slice(0, 8)}…，${String(cachedRaw).length} 字符，含第 350 行标记）→ 数据面没问题`
      : `原始结果没落进 toolCache（sha1=${sha.slice(0, 8) || "空"}…，get() 返回 ${cachedRaw === null ? "null" : "内容但不含标记"}）`
  );

  report(
    sub(),
    directRunnerOk,
    directRunnerOk
      ? "直接给 toolRunner 注入 toolCache 时 ReadToolResult 能读到尾部 → 缺陷只在 bridge 的接线（bridge 建 toolRunner 时没传 opts.toolCache）"
      : "直接给 toolRunner 注入 toolCache 也读不到 → 缺陷在 ReadToolResult 自身实现"
  );

  report(
    sub(),
    endsOfReadTool.length > 0 && endsOfReadTool.every((e) => e.ok === true),
    `真实链路里 ReadToolResult 调用成功：调用 ${endsOfReadTool.length} 次、ok=${endsOfReadTool.map((e) => e.ok).join(",")}`
      + `；error=「${String(endsOfReadTool[0]?.error ?? "").slice(0, 130)}」`
  );

  report(
    sub(),
    needle,
    needle
      ? `续读拿到了被剪掉的尾部：第 350 行标记「TAIL_NEEDLE_LINE_350」出现在结果里（${tailText.length} 字符）`
      : `续读没拿到尾部：模型收到的结果 ${tailText.length} 字符，片段「${tailText.slice(0, 90).replace(/\n/g, "⏎")}」—— 剪枝省略的部分成了信息黑洞`
  );

  summarizeScenario();
}

// ---------------------------------------------------------------------------
// S7b · 完全不给 toolCache：内存兜底必须也能续读（剪枝指引不能指向「只有磁盘才有」的能力）
// ---------------------------------------------------------------------------

async function scenarioS7b() {
  beginScenario("S7b", "完全未配置 toolCache（withToolCache=false）：ReadToolResult 靠内存兜底必须能续读（含 8 位前缀）");

  const probeDir = await mkdtemp(join(TMP_ROOT, "s7b-file-"));
  createdDirs.push(probeDir);
  const lines = [];
  for (let i = 1; i <= HUGE_LINES; i += 1) {
    if (i === 350) lines.push(`const TAIL_NEEDLE_LINE_350 = "${"x".repeat(40)}";`);
    else lines.push(`// L${String(i).padStart(3, "0")} ${"y".repeat(HUGE_LINE_CHARS)}`);
  }
  const hugeFile = join(probeDir, "huge.js");
  await writeFile(hugeFile, lines.join("\n"), "utf8");
  const relPath = relative(REPO, hugeFile).split("\\").join("/");

  // 第 1 轮读大文件（触发剪枝）→ 第 2 轮用**完整 sha1**续读 → 第 3 轮用**8 位前缀**续读。
  // 两轮分开测，是因为「内存兜底能不能用」与「前缀补全能不能用」是两处独立实现。
  const fake = await makeFakeModel(({ turn, messages }) => {
    if (turn === 1) {
      return { events: thinkingToolTurn({ calls: [{ id: "call_s7b_read", name: "ReadFile", args: { path: relPath } }] }) };
    }
    // ⚠ sha1 必须从**第 1 轮请求**的 tool 结果里取：从第 3 轮起「最后一条 tool 消息」
    //   已经是被续读回来的内容（不再含剪枝提示的 sha1），照抄会让这一场景假红。
    const firstToolText = (messages.find((m) => m?.role === "tool")?.content ?? "");
    const sha = (/sha1="([0-9a-f]{40})"/.exec(String(firstToolText)) ?? [])[1] ?? "";
    if (turn === 2) {
      return {
        events: thinkingToolTurn({
          calls: [{ id: "call_s7b_full", name: "ReadToolResult", args: { sha1: sha, from: 320, lines: 40 } }],
          reasoning: "用完整 sha1 续读。"
        })
      };
    }
    if (turn === 3) {
      return {
        events: thinkingToolTurn({
          calls: [{ id: "call_s7b_prefix", name: "ReadToolResult", args: { sha1: sha.slice(0, 8), from: 320, lines: 40 } }],
          reasoning: "用 8 位前缀续读（工具定义说可只给前 8 位）。"
        })
      };
    }
    return {
      events: [
        { kind: "reasoning", text: "尾部读到了。" },
        ...contentPieces("已拿到被剪枝的尾部内容。"),
        { kind: "finish", reason: "stop", usage: usageOf() }
      ]
    };
  });

  const { bridge, events } = await makeBridge("s7b", fake.baseUrl, { maxTokens: 1024, withToolCache: false });
  await bridge.aiChat({
    requestId: "s7b-memory",
    messages: [{ role: "user", text: `读 ${relPath} 并定位问题行（先用完整 sha1 续读，再用 8 位前缀续读）` }],
    context: { sceneDigest: "工程「无缓存」1 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const firstToolText = allToolMessagesOf(fake.state.turns[1])[0] ?? "";
  const fullShaTail = allToolMessagesOf(fake.state.turns[2]).at(-1) ?? "";
  const prefixTail = allToolMessagesOf(fake.state.turns[3]).at(-1) ?? "";
  const ends = toolEnds(events).filter((e) => e.name === "ReadToolResult");
  const fullOk = ends[0]?.ok === true && /TAIL_NEEDLE_LINE_350/.test(fullShaTail);
  const prefixOk = ends[1]?.ok === true && /TAIL_NEEDLE_LINE_350/.test(prefixTail);

  report(
    sub(),
    /已剪枝/.test(firstToolText),
    `前提：大结果被剪枝（原文 ${lines.join("\n").length} 字符 → 模型看到 ${firstToolText.length} 字符），提示里带完整 sha1`
  );

  report(
    sub(),
    fullOk,
    fullOk
      ? `无 toolCache 时内存兜底可用：完整 sha1 续读成功，尾部标记出现在结果里（${fullShaTail.length} 字符）`
      : `无 toolCache 时内存兜底失效：完整 sha1 续读 ok=${JSON.stringify(ends[0]?.ok)}，error=「${String(ends[0]?.error ?? "").slice(0, 130)}」`
  );

  report(
    sub(),
    prefixOk,
    prefixOk
      ? `8 位前缀也能续读：尾部标记出现在结果里（${prefixTail.length} 字符）`
      : `8 位前缀取不到：ok=${JSON.stringify(ends[1]?.ok)}，error=「${String(ends[1]?.error ?? "").slice(0, 150)}」`
      + `（工具定义写着「可只给前 8 位」、剪枝提示也只显示 8 位 → 前缀补全在无 toolCache 时不可用）`
  );

  summarizeScenario();
}

// ---------------------------------------------------------------------------
// S6b · 止损仍要生效：**完全相同的调用**（同 name 同参数）连续失败两次后必须被拦住
// ---------------------------------------------------------------------------

async function scenarioS6b() {
  beginScenario("S6b", "反向保证：同 name + 同参数连续失败两次后，第三次必须被止损拦住（改键没削弱止损）");

  let readCalls = 0;
  const fake = await makeFakeModel(({ turn, body }) => {
    const msgs = body?.messages ?? [];
    const toolMsgs = msgs.filter((m) => m?.role === "tool");
    // 每次都让模型用**同一个**参数重试同一个坏路径
    if (turn <= 3) {
      return { events: thinkingToolTurn({ calls: [{ id: `call_s6b_${turn}`, name: "ReadFile", args: { path: "same_bad.txt" } }] }) };
    }
    return {
      events: [
        { kind: "reasoning", text: "这条路确实坏了，我换个做法。" },
        ...contentPieces("那个文件不存在，我改为基于已有信息作答。"),
        { kind: "finish", reason: "stop", usage: usageOf() }
      ]
    };
  }, { reads: 0 });

  const { bridge, events } = await makeBridge("s6b", fake.baseUrl, { maxTokens: 1024 });
  await bridge.aiChat({
    requestId: "s6b-sameargs",
    messages: [{ role: "user", text: "反复读同一个文件" }],
    context: { sceneDigest: "工程「止损」1 场景" }
  });
  await bridge.whenIdle();
  await fake.close();

  const reads = toolEnds(events).filter((e) => e.name === "ReadFile");
  const stopped = reads.slice(2).filter((e) => /当前不可用|不要再用同样的参数重试/.test(String(e.detail ?? "")));
  const realExecuted = reads.filter((e) => /找不到文件/.test(String(e.error ?? "")));

  report(
    sub(),
    realExecuted.length === 2,
    `前两次是真实执行失败：真实执行 ${realExecuted.length} 次（ok 序列=${reads.map((r) => r.ok).join(",")}）`
  );

  report(
    sub(),
    stopped.length >= 1,
    `第三次起被止损拦住：止损事件 ${stopped.length} 条，文案「${String(stopped[0]?.detail ?? "").slice(0, 150)}」`
  );

  report(
    sub(),
    doneOf(events).length === 1 && String(doneOf(events)[0]?.text ?? "").trim().length > 0,
    `止损后仍有答复：${String(doneOf(events)[0]?.text ?? "").length} 字符`
  );

  summarizeScenario();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log(`verify-ai-resilience — 被测实现：${LABEL}`);
  console.log(`  lib 目录：${LIB_DIR}`);
  console.log(`  仓库根：${REPO}`);
  await mkdir(TMP_ROOT, { recursive: true });

  const scenarios = [
    scenarioS0, scenarioS1, scenarioS2, scenarioS3,
    scenarioS4, scenarioS5, scenarioS6, scenarioS6b, scenarioS7, scenarioS7b
  ];
  for (const fn of scenarios) {
    try {
      await fn();
    } catch (e) {
      report(`${scenarioKey}-crash`, false, `场景崩溃：${e?.stack || e?.message || e}`);
      summarizeScenario();
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n════ 汇总（${LABEL}）════`);
  for (const s of ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S6b", "S7", "S7b"]) {
    const rows = results.filter((r) => r.scenario === s);
    if (!rows.length) continue;
    const bad = rows.filter((r) => !r.ok);
    console.log(`[${s}] ${bad.length ? "FAIL" : "PASS"} — ${bad.length ? bad.map((r) => r.key).join(", ") + " 失败" : `${rows.length}/${rows.length} 子断言通过`}`);
  }
  for (const r of failed) console.log(`  ✗ [${r.key}] ${r.detail}`);

  for (const d of createdDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }

  const total = results.length;
  const okTotal = total - failed.length;
  console.log(`\nverify-ai-resilience: ${okTotal}/${total} 子断言通过 — ${failed.length === 0 ? "全绿 PASS" : `${failed.length} 项 FAIL`}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
