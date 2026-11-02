/**
 * 真实跑一次 mock `aiChat`，打印收到的**完整事件序列**。
 *
 * 为什么需要这个脚本（而不是人肉看日志）：
 *   thinking 事件的顺序本身就是契约的一部分 ——
 *   `connecting → answering → delta… → done` 这个序列错了，UI 的状态机就会卡在"连接中"或跳字。
 *   人肉看一次日志无法回归；做成脚本后，顺序一变就红。
 *
 * 同时验证三条硬约束：
 *   · mock 分支必须发 connecting（无 key 时思考态要能演示）
 *   · answering 只发一次（不是每个 delta 都发）
 *   · thinking 事件只带契约字段（不许出现 mock/message 等私有字段）
 *
 * 用法：
 *   node desktop/tools/verify-thinking-events.mjs
 *   node desktop/tools/verify-thinking-events.mjs --json   # 只输出 JSON（便于粘贴）
 *
 * 退出码：0 符合契约；1 序列或约束不符。
 */

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
const JSON_ONLY = process.argv.includes("--json");

/** thinking 事件允许的字段（与 ipc-contract 里声明的严格一致）。 */
const THINKING_FIELDS = new Set(["type", "requestId", "phase", "chars", "delta"]);
const VALID_PHASES = new Set(["connecting", "reasoning", "answering", "slow"]);

const log = (msg) => {
  if (!JSON_ONLY) console.log(msg);
};

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "bwe-thinking-"));
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
    // 用 mock provider：不需要 key、不发网络，事件形状与真模型一致
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
        maxTokens: 1024
      }
    }),
    sceneDigest: async () => "工程「未命名」 1 场景 / 0 素材",
    sendEvent: (ev) => {
      events.push({ ...ev, _t: Date.now() });
      if (ev.type === "done" || (ev.type === "error" && !ev.recoverable)) resolveDone(ev);
    },
    log: () => {}
  });

  const t0 = Date.now();
  await bridge.aiChat({
    requestId: "thinking-1",
    messages: [{ role: "user", text: "解释一下这个字段" }],
    intent: "chat"
  });
  await Promise.race([donePromise, new Promise((r) => setTimeout(r, 15000))]);

  // ---------------- 输出事件序列 ----------------
  const seq = events.map((e) => {
    if (e.type === "thinking") return `thinking/${e.phase}${e.chars ? `(${e.chars}字)` : ""}`;
    if (e.type === "delta") return `delta(${e.text.length}字)`;
    return e.type;
  });

  log(`事件序列（共 ${events.length} 个事件，耗时 ${Date.now() - t0}ms）：`);
  log(`  ${seq.join(" → ")}`);
  log("");

  // thinking 事件明细
  log("thinking 事件明细：");
  for (const e of events.filter((e) => e.type === "thinking")) {
    log(`  [${e._t - t0}ms] phase=${e.phase} chars=${e.chars ?? "-"} delta=${e.delta ? `"${e.delta.slice(0, 40).replace(/\n/g, "⏎")}"` : "-"}`);
  }
  log("");

  // ---------------- 断言 ----------------
  const failures = [];
  const check = (cond, msg) => {
    if (cond) log(`  ✓ ${msg}`);
    else {
      log(`  ✗ ${msg}`);
      failures.push(msg);
    }
  };

  const thinkingEvents = events.filter((e) => e.type === "thinking");
  const phases = thinkingEvents.map((e) => e.phase);

  // ① 必须发 thinking（这是本功能的核心：UI 要知道模型在思考）
  check(thinkingEvents.length > 0, "发出了 thinking 事件");

  // ② mock 分支必须发 connecting
  check(phases.includes("connecting"), "mock 分支发了 connecting（无 key 时思考态可演示）");

  // ③ connecting 必须在第一个 delta 之前（否则 UI 先看到文字再看到"连接中"，顺序颠倒）
  const firstConnectingIdx = events.findIndex((e) => e.type === "thinking" && e.phase === "connecting");
  const firstDeltaIdx = events.findIndex((e) => e.type === "delta");
  check(
    firstConnectingIdx >= 0 && firstConnectingIdx < firstDeltaIdx,
    `connecting 在首个 delta 之前（connecting@${firstConnectingIdx} < delta@${firstDeltaIdx}）`
  );

  // ④ answering 只发一次（契约硬约束）
  const answeringCount = phases.filter((p) => p === "answering").length;
  check(answeringCount === 1, `answering 只发一次（实际 ${answeringCount} 次）`);

  // ⑤ answering 在首个 delta 之前或同时
  const answeringIdx = events.findIndex((e) => e.type === "thinking" && e.phase === "answering");
  check(
    answeringIdx >= 0 && answeringIdx < firstDeltaIdx,
    `answering 在首个 delta 之前（answering@${answeringIdx} < delta@${firstDeltaIdx}）`
  );

  // ⑥ phase 取值必须合法
  for (const p of phases) {
    check(VALID_PHASES.has(p), `phase「${p}」在契约允许的取值内`);
  }

  // ⑦ thinking 事件只带契约字段（不许扩宽）
  const illegal = [];
  for (const e of thinkingEvents) {
    for (const k of Object.keys(e)) {
      if (!THINKING_FIELDS.has(k) && k !== "_t") illegal.push(k);
    }
  }
  check(illegal.length === 0, `thinking 事件只含契约字段${illegal.length ? `（出现 ${[...new Set(illegal)].join(", ")}）` : ""}`);

  // ⑧ reasoning 的 delta 不能是全量（若出现 reasoning，delta 长度应远小于累计 chars）
  for (const e of thinkingEvents) {
    if (e.phase === "reasoning" && typeof e.delta === "string" && e.chars) {
      const isFull = e.delta.length >= e.chars;
      check(!isFull, `reasoning 的 delta 是增量而非全量（delta ${e.delta.length} < chars ${e.chars}）`);
    }
  }

  // ⑨ mock 的 connecting 应有人为延迟（400~600ms）以便演示；太快说明没加
  const connectingEvent = thinkingEvents.find((e) => e.phase === "connecting");
  if (connectingEvent) {
    const nextEvent = events[events.indexOf(connectingEvent) + 1];
    const gap = nextEvent ? nextEvent._t - connectingEvent._t : 0;
    check(gap >= 300, `mock 的 connecting 有可感知的延迟（${gap}ms，预期 400~600）`);
  }

  // ⑩ 契约清单里必须有 thinking
  check(
    IPC_CONTRACT["ai:event"].eventTypes.includes("thinking"),
    "ipc-contract 的 eventTypes 包含 thinking"
  );

  // ---------------- JSON 输出 ----------------
  if (JSON_ONLY || failures.length) {
    console.log(
      JSON.stringify(
        {
          sequence: seq,
          thinking: thinkingEvents.map((e) => ({
            phase: e.phase,
            chars: e.chars ?? null,
            deltaLength: typeof e.delta === "string" ? e.delta.length : null
          })),
          failures,
          totalEvents: events.length,
          elapsedMs: Date.now() - t0
        },
        null,
        2
      )
    );
  }

  await rm(dir, { recursive: true, force: true }).catch(() => {});

  log("");
  log(failures.length === 0 ? `全部通过（10 项检查）` : `失败 ${failures.length} 项`);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
