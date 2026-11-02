/**
 * 单测：切换会话时中止在途请求（多会话最危险的一条）。
 *
 * ── 为什么这条必须单独测 ───────────────────────────────────────────────
 * 切换会话时若不断开在途请求，旧请求收尾时会把 deltas / 消息**append 进新会话的 history**。
 * 那是**数据写错地方**，比显示错严重得多：用户切到 B 会话，结果 B 的历史里混进了 A 的回答，
 * 而且不会报错、不会有日志，只有翻历史时才会发现内容串了。
 *
 * 所以 `swapSession()` 必须**先 abortAll() 再换绑**（顺序不能反）。
 * 这里用一个"慢速 mock"制造真实在途窗口，切换后断言：
 *   1. 在途请求被中止（返回 aborted > 0）
 *   2. 旧请求的 assistant 消息**没有**写进新会话
 *   3. 新会话本身是干净的
 *
 * 用法：node desktop/test/ai-session-switch.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAiBridge } from "../lib/ai/bridge.mjs";
import { openSession, messageText } from "../lib/ai/session.mjs";
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
  const d = await mkdtemp(join(tmpdir(), "bwe-switch-"));
  dirs.push(d);
  return d;
}

async function makeBridge({ sessionDir }) {
  const session = await openSession({ dir: sessionDir, workspace: REPO });
  const events = [];
  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache: createToolCache(join(sessionDir, "toolCache")),
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
    sceneDigest: async () => "工程摘要",
    sendEvent: (ev) => events.push({ ...ev, _t: Date.now() }),
    log: () => {}
  });
  return { bridge, session, events };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

test("swapSession：返回被中止的在途请求数，且 exchange 后事件不再属于旧请求", async () => {
  const dirA = await tmpDir();
  const dirB = await tmpDir();
  const { bridge, events } = await makeBridge({ sessionDir: dirA });

  // 起一个请求（mock 逐块吐字，约 1 秒），在它跑到一半时切换
  await bridge.aiChat({
    requestId: "req-A",
    messages: [{ role: "user", text: "写一段很长的解释".repeat(3) }],
    intent: "chat"
  });
  // 等它真的开始吐字（确保是"在途"而不是"已完成"）
  const started = Date.now();
  while (Date.now() - started < 2000) {
    if (events.some((e) => e.type === "delta")) break;
    await sleep(50);
  }
  assert.ok(events.some((e) => e.type === "delta"), "请求应已开始吐字（否则不是在途状态）");

  // 切到 B 会话
  const sessionB = await openSession({ dir: dirB, workspace: REPO });
  const { aborted } = await bridge.swapSession(sessionB);
  assert.ok(aborted >= 1, `切换时应中止在途请求，实际 aborted=${aborted}`);
  assert.equal(bridge.currentSession.dir, dirB, "currentSession 应换到新会话");

  // swapSession 内部已 await whenIdle()，返回时旧请求的落盘已完成 —— 不需要再 sleep。

  // 关键断言：B 会话必须是干净的
  const bAfter = await openSession({ dir: dirB, workspace: REPO });
  const bTexts = bAfter.messages().map((m) => messageText(m)).join(" | ");
  assert.ok(
    !bTexts.includes("本地演示模式"),
    `旧请求的内容串进了新会话！新会话内容：${bTexts.slice(0, 200)}`
  );
  assert.equal(bAfter.messages().length, 0, `新会话应为空，实际 ${bAfter.messages().length} 条`);
});

test("abortAll：中止全部在途请求（多请求同时跑也不会漏）", async () => {
  const dir = await tmpDir();
  const { bridge, events } = await makeBridge({ sessionDir: dir });

  await bridge.aiChat({ requestId: "r1", messages: [{ role: "user", text: "问题一".repeat(10) }], intent: "chat" });
  await bridge.aiChat({ requestId: "r2", messages: [{ role: "user", text: "问题二".repeat(10) }], intent: "chat" });
  await sleep(300); // 让两个都进入流式

  const aborted = bridge.abortAll();
  assert.ok(aborted >= 1, `应中止至少 1 个请求，实际 ${aborted}`);
  await sleep(800);

  // 中止后应收到 error（已取消）或 done，且不能再有新的 delta 持续涌入
  const afterAbort = events.filter((e) => e._t > Date.now() - 500);
  const stillStreaming = afterAbort.filter((e) => e.type === "delta").length;
  assert.ok(stillStreaming < 20, `中止后不该继续大量吐字，实际还有 ${stillStreaming} 个 delta`);
});

test("swapSession 后新请求写进新会话（换绑生效）", async () => {
  const dirA = await tmpDir();
  const dirB = await tmpDir();
  const { bridge } = await makeBridge({ sessionDir: dirA });

  const sessionB = await openSession({ dir: dirB, workspace: REPO });
  await bridge.swapSession(sessionB);

  await bridge.aiChat({ requestId: "req-B", messages: [{ role: "user", text: "新会话里的问题" }], intent: "chat" });
  // 等完成
  for (let i = 0; i < 60; i += 1) {
    const s = await openSession({ dir: dirB, workspace: REPO });
    if (s.messages().some((m) => m.role === "assistant")) break;
    await sleep(100);
  }

  const finalB = await openSession({ dir: dirB, workspace: REPO });
  const texts = finalB.messages().map((m) => messageText(m)).join(" | ");
  assert.ok(texts.includes("新会话里的问题"), `新请求应写进新会话，实际：${texts.slice(0, 200)}`);
  // 旧会话不该有这条
  const finalA = await openSession({ dir: dirA, workspace: REPO });
  assert.ok(
    !finalA.messages().map((m) => messageText(m)).join(" | ").includes("新会话里的问题"),
    "新请求不该写进旧会话"
  );
});

test("swapSession 重置会话级用量统计（不把上个会话的量算进来）", async () => {
  const dirA = await tmpDir();
  const dirB = await tmpDir();
  const { bridge } = await makeBridge({ sessionDir: dirA });

  await bridge.aiChat({ requestId: "u1", messages: [{ role: "user", text: "产生一些用量" }], intent: "chat" });
  // 确定性等待该请求结束（不用 sleep：慢机器上 1500ms 可能不够，那是脆测试的典型来源）
  await bridge.whenIdle();
  const usageA = bridge.sessionUsage;
  assert.ok(usageA.inputTokens + usageA.cacheReadTokens + usageA.outputTokens > 0, "第一个会话应有用量");

  const sessionB = await openSession({ dir: dirB, workspace: REPO });
  await bridge.swapSession(sessionB);
  const usageB = bridge.sessionUsage;
  assert.equal(
    usageB.inputTokens + usageB.cacheReadTokens + usageB.outputTokens,
    0,
    "切会话后累计用量应归零（否则「本会话省了多少」会把上个会话也算进来）"
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

console.log(`\nai-session-switch.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
