/**
 * 单测：thinking 事件序列（bridge 的思考状态机）。
 *
 * 为什么单独成一个测试文件（而不是只靠 verify-thinking-events.mjs 脚本）：
 *   那条脚本是"取证"用的（打印完整序列给人看），但不会在 `npm run desk:test` 之外的
 *   常规回归里自动跑。把**顺序约束**做成单测，才能在每次改动 bridge 时立刻发现退化。
 *
 * 锁住的四条（都来自契约 §4.2 的硬约束）：
 *   1. mock 分支必须发 connecting（无 key 时思考态要能演示）
 *   2. `answering` 只发一次（不是每个 delta 都发）
 *   3. connecting / answering 必须都在首个 delta **之前**（顺序错了 UI 会先显示文字再显示"连接中"）
 *   4. thinking 事件只带契约字段（phase / chars / delta），不许带文案或私有标记
 *
 * 用 mock provider 跑，**不需要网络与 key**，可在 CI 跑。
 *
 * 用法：node desktop/test/thinking.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAiBridge } from "../lib/ai/bridge.mjs";
import { openSession } from "../lib/ai/session.mjs";
import { createApiIndex, defaultApiDocsPath } from "../lib/ai/apiIndex.mjs";
import { createToolCache } from "../lib/ai/prune.mjs";
import { IPC_CONTRACT } from "../lib/ipc-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");

/** thinking 事件允许的字段（与 ipc-contract 严格一致）。 */
const THINKING_FIELDS = new Set(["type", "requestId", "phase", "chars", "delta"]);
const VALID_PHASES = ["connecting", "reasoning", "answering", "slow"];

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const dirs = [];
async function tmpDir() {
  const d = await mkdtemp(join(tmpdir(), "bwe-thinking-"));
  dirs.push(d);
  return d;
}

/**
 * 跑一次 mock aiChat，返回收集到的事件。
 *
 * @param {object} [settingsOverride] 覆盖 getSettings 返回的 ai 段
 */
async function runOnce(settingsOverride = {}) {
  const dir = await tmpDir();
  const session = await openSession({ dir, workspace: REPO });
  const events = [];
  let resolveDone = null;
  const donePromise = new Promise((r) => {
    resolveDone = r;
  });

  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache: createToolCache(join(dir, "toolCache")),
    getSettings: async () => ({
      ai: {
        provider: "mock",
        baseUrl: "",
        apiKey: "",
        modelFlash: "",
        modelPro: "",
        autoRoute: true,
        manualModel: "",
        activeModelId: "",
        models: [],
        contextWindow: 64000,
        maxTokens: 1024,
        ...settingsOverride
      }
    }),
    sceneDigest: async () => "工程「未命名」 1 场景",
    sendEvent: (ev) => {
      events.push({ ...ev, _t: Date.now() });
      if (ev.type === "done" || (ev.type === "error" && !ev.recoverable)) resolveDone(ev);
    },
    log: () => {}
  });

  const t0 = Date.now();
  await bridge.aiChat({
    requestId: "t1",
    messages: [{ role: "user", text: "解释一下这个字段叫什么" }],
    intent: "chat"
  });
  await Promise.race([donePromise, new Promise((r) => setTimeout(r, 15000))]);
  return { events, elapsedMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// 序列约束
// ---------------------------------------------------------------------------

test("mock 分支：thinking/connecting 在首个 delta 之前", async () => {
  const { events } = await runOnce();
  const firstConnecting = events.findIndex((e) => e.type === "thinking" && e.phase === "connecting");
  const firstDelta = events.findIndex((e) => e.type === "delta");
  assert.ok(firstConnecting >= 0, "mock 必须发 thinking/connecting（无 key 时思考态要能演示）");
  assert.ok(firstDelta >= 0, "应该有 delta");
  assert.ok(
    firstConnecting < firstDelta,
    `connecting（index ${firstConnecting}）必须在首个 delta（index ${firstDelta}）之前`
  );
});

test("answering 只发一次（不是每个 delta 都发）", async () => {
  const { events } = await runOnce();
  const answering = events.filter((e) => e.type === "thinking" && e.phase === "answering");
  assert.equal(answering.length, 1, `answering 应只发一次，实际 ${answering.length} 次`);
  // 反向验证：delta 数量应该远多于 answering 数量（否则说明"只发一次"没做到）
  const deltas = events.filter((e) => e.type === "delta").length;
  assert.ok(deltas >= 3, `mock 应分多块吐字（实际 ${deltas} 块）`);
});

test("answering 也在首个 delta 之前（顺序：connecting → answering → delta）", async () => {
  const { events } = await runOnce();
  const answeringIdx = events.findIndex((e) => e.type === "thinking" && e.phase === "answering");
  const firstDelta = events.findIndex((e) => e.type === "delta");
  assert.ok(
    answeringIdx >= 0 && answeringIdx < firstDelta,
    `answering（${answeringIdx}）必须在首个 delta（${firstDelta}）之前 —— 顺序错了 UI 会先显示正文再显示"连接中"`
  );
});

test("thinking 事件只带契约字段（不许带文案或私有标记）", async () => {
  const { events } = await runOnce();
  const illegal = [];
  for (const e of events.filter((ev) => ev.type === "thinking")) {
    for (const k of Object.keys(e)) {
      if (!THINKING_FIELDS.has(k) && k !== "_t") illegal.push(k);
    }
  }
  assert.equal(
    illegal.length,
    0,
    `thinking 事件带了契约外字段：${[...new Set(illegal)].join(", ")}\n`
    + "  契约只允许 phase / chars / delta —— 加文案会让 UI 与主进程各写一套措辞（迟早不一致）"
  );
});

test("phase 取值都在契约允许的四个之内", async () => {
  const { events } = await runOnce();
  for (const e of events.filter((ev) => ev.type === "thinking")) {
    assert.ok(VALID_PHASES.includes(e.phase), `phase「${e.phase}」不在 ${VALID_PHASES.join("/")} 之内`);
  }
});

test("mock 的 connecting 有可感知的延迟（400~600ms 量级）", async () => {
  const { events } = await runOnce();
  const idx = events.findIndex((e) => e.type === "thinking" && e.phase === "connecting");
  assert.ok(idx >= 0);
  const next = events[idx + 1];
  const gap = next ? next._t - events[idx]._t : 0;
  // 断言"有延迟"而不是精确值：实现是 500ms，留出调度抖动的余量
  assert.ok(gap >= 300, `connecting 到下一个事件的间隔应 >=300ms（实际 ${gap}ms）—— 太短说明 mock 没加思考延迟，UI 截图会抓不到思考态`);
  assert.ok(gap <= 1500, `连接延迟不该大到影响体验（实际 ${gap}ms）`);
});

// ---------------------------------------------------------------------------
// 契约联动
// ---------------------------------------------------------------------------

test("ipc-contract 的 eventTypes 含 thinking，且四个 phase 都有语义说明", () => {
  const spec = IPC_CONTRACT["ai:event"];
  assert.ok(spec.eventTypes.includes("thinking"), "eventTypes 必须含 thinking");
  for (const phase of VALID_PHASES) {
    assert.ok(spec.notes.includes(phase), `契约 notes 缺少 phase「${phase}」的语义`);
  }
  assert.ok(spec.notes.includes("只发一次"), "契约必须写明 answering 只发一次");
  assert.ok(spec.notes.includes("不是全量"), "契约必须写明 reasoning delta 不是全量");
  assert.ok(spec.notes.includes("不许加任何人为延迟"), "契约必须写明真模型不许加延迟");
});

test("reasoning 的 delta 是增量而非全量（静态检查 emit 写法）", async () => {
  const bridge = await readFileUtf8(join(DESKTOP, "lib", "ai", "bridge.mjs"));
  // reasoning 分支必须带 chars（累计）与 delta（增量），而不是把整段塞进 delta
  assert.ok(bridge.includes('emitThinking("reasoning"'), "必须有 reasoning 发射点");
  assert.ok(bridge.includes("reasoningChars +="), "reasoning 必须累计字符数（供 UI 显示「已思考 N 字」）");
});

async function readFileUtf8(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

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

console.log(`\nthinking.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
