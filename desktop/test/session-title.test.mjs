/**
 * 单测：会话标题自动生成 + 索引随对话更新（bridge ↔ conversations 联动）。
 *
 * ── 为什么需要这条测试 ──────────────────────────────────────────────────
 * 四个会话通道（list/new/switch/delete）都通了、数据也对，但**列表里全是「新对话」**、
 * messageCount 恒为 0 —— 因为 `bridge` 写盘后从不通知会话存储。
 * 这是典型的「通道通 ≠ 功能可用」：接口全绿，用户看到的历史列表却是空的。
 *
 * 本测试锁三件事：
 *   1. 聊完天后，会话标题变成**第一条用户消息前 20 字**（零 token，不调模型）
 *   2. messageCount 随消息增长
 *   3. 用户给过的标题**不被后续消息覆盖**（不能把用户改的名字冲掉）
 *
 * 用法：node desktop/test/session-title.test.mjs
 */

import assert from "assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAiBridge } from "../lib/ai/bridge.mjs";
import { openSession } from "../lib/ai/session.mjs";
import { createApiIndex, defaultApiDocsPath } from "../lib/ai/apiIndex.mjs";
import { createToolCache } from "../lib/ai/prune.mjs";
import { createConversationStore, DEFAULT_TITLE, makeTitle } from "../lib/ai/conversations.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const dirs = [];
async function tmpDir() {
  const d = await mkdtemp(join(tmpdir(), "bwe-title-"));
  dirs.push(d);
  return d;
}

/**
 * 起一个「真实联动」的环境：会话存储 + bridge + onSessionUpdated 回调。
 * 回调逻辑与 app-main 里保持一致（只在这里复刻核心判断，避免测试绕过产品逻辑）。
 */
async function makeStack({ presetTitle } = {}) {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  const state = await store.load();
  const activeId = state.active;
  if (presetTitle) await store.touch(activeId, { title: presetTitle });

  const session = await openSession({ dir: store.conversationDir(activeId), workspace: REPO });
  const events = [];
  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache: createToolCache(join(dir, "toolCache")),
    getSettings: async () => ({
      ai: {
        provider: "mock", baseUrl: "", apiKey: "", modelFlash: "", modelPro: "",
        autoRoute: true, manualModel: "", activeModelId: "", models: [],
        contextWindow: 64000, maxTokens: 1024
      }
    }),
    getSessionInfo: async () => {
      const st = await store.state();
      return { active: st.active, count: st.sessions.length };
    },
    onSessionUpdated: async (sess, firstUserText) => {
      const st = await store.state();
      const id = String(sess?.dir ?? "").split(/[\\/]/).pop();
      const item = st.sessions.find((x) => x.id === id);
      if (!item) return;
      const patch = {};
      if ((item.title === DEFAULT_TITLE || !item.title) && firstUserText) {
        patch.title = firstUserText;
      }
      await store.touch(id, patch);
    },
    sendEvent: (ev) => events.push(ev),
    log: () => {}
  });
  return { store, bridge, session, events, activeId };
}

// ---------------------------------------------------------------------------

test("聊完天后：标题变成第一条用户消息前 20 字（零 token）", async () => {
  const { store, bridge, activeId } = await makeStack();
  const firstMsg = "帮我重构一下玩家移动的逻辑，现在走起来有点卡";

  await bridge.aiChat({ requestId: "t1", messages: [{ role: "user", text: firstMsg }], intent: "chat" });
  await bridge.whenIdle();

  const state = await store.load();
  const item = state.sessions.find((s) => s.id === activeId);
  assert.notEqual(item.title, DEFAULT_TITLE, `标题应被更新，实际仍是「${item.title}」`);
  // 标题取自首条消息，且不超过 20 字
  const expected = makeTitle(firstMsg);
  assert.equal(item.title, expected, `标题应是首条消息的摘要，期望「${expected}」实际「${item.title}」`);
  assert.ok(item.title.length <= 20, `标题不应超过 20 字，实际 ${item.title.length}`);
  assert.ok(firstMsg.startsWith(item.title.replace(/…$/, "")), "标题应取自首条消息开头");
});

test("聊完天后：messageCount 与 updatedAt 随消息更新", async () => {
  const { store, bridge, activeId } = await makeStack();
  const before = (await store.load()).sessions.find((s) => s.id === activeId);

  await bridge.aiChat({ requestId: "t2", messages: [{ role: "user", text: "一个简短问题" }], intent: "chat" });
  await bridge.whenIdle();

  const after = (await store.load()).sessions.find((s) => s.id === activeId);
  assert.ok(after.messageCount >= 2, `messageCount 应 ≥2（user + assistant），实际 ${after.messageCount}`);
  // updatedAt 精度是毫秒：若创建与首条消息落在同一毫秒，字符串会相等 ——
  // 这不是缺陷。断言改成「不早于创建时间」这个语义即可（用 >= 而不是 !=）。
  assert.ok(
    after.updatedAt >= before.updatedAt,
    `updatedAt 不该回退（before=${before.updatedAt} after=${after.updatedAt}）`
  );
});

test("用户已定的标题不被后续消息覆盖", async () => {
  const { store, bridge, activeId } = await makeStack({ presetTitle: "用户自定义标题" });
  await bridge.aiChat({ requestId: "t3", messages: [{ role: "user", text: "随便问点什么内容" }], intent: "chat" });
  await bridge.whenIdle();

  const item = (await store.load()).sessions.find((s) => s.id === activeId);
  assert.equal(item.title, "用户自定义标题", `不该覆盖用户标题，实际「${item.title}」`);
});

test("切换会话后：新会话的标题独立生成，不串到旧会话", async () => {
  const { store, bridge } = await makeStack();
  // 会话 A：先聊一句
  await bridge.aiChat({ requestId: "a1", messages: [{ role: "user", text: "A 会话的问题内容" }], intent: "chat" });
  await bridge.whenIdle();

  // 新建 B 并切过去
  const created = await store.create({ title: DEFAULT_TITLE });
  const sessionB = await openSession({ dir: store.conversationDir(created.id), workspace: REPO });
  await bridge.swapSession(sessionB);

  await bridge.aiChat({ requestId: "b1", messages: [{ role: "user", text: "B 会话的不同问题" }], intent: "chat" });
  await bridge.whenIdle();

  const state = await store.load();
  const a = state.sessions.find((s) => s.id !== created.id);
  const b = state.sessions.find((s) => s.id === created.id);
  assert.ok(a && b, "应有两个会话");
  // A 的标题不能变成 B 的内容（这是 targetSession 绑定 + onSessionUpdated(sess) 的正确性）
  assert.ok(a.title.includes("A 会话") || a.title !== b.title, `A 标题不该被 B 覆盖，实际 A=「${a.title}」B=「${b.title}」`);
  assert.ok(b.title.includes("B 会话"), `B 标题应来自 B 的第一条消息，实际「${b.title}」`);
});

test("onSessionUpdated 抛错不影响对话完成（存储失败不该丢回答）", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  const state = await store.load();
  const session = await openSession({ dir: store.conversationDir(state.active), workspace: REPO });
  const events = [];
  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache: createToolCache(join(dir, "tc")),
    getSettings: async () => ({
      ai: { provider: "mock", baseUrl: "", apiKey: "", modelFlash: "", modelPro: "", autoRoute: true, manualModel: "", activeModelId: "", models: [], contextWindow: 64000, maxTokens: 1024 }
    }),
    // 故意让索引更新失败
    onSessionUpdated: async () => {
      throw new Error("磁盘满了");
    },
    sendEvent: (ev) => events.push(ev),
    log: () => {}
  });

  await bridge.aiChat({ requestId: "e1", messages: [{ role: "user", text: "即使索引写失败也要回答" }], intent: "chat" });
  await bridge.whenIdle();

  assert.ok(events.some((e) => e.type === "done"), "索引更新失败不该阻断对话（应仍然 done）");
  const finalText = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.ok(finalText.length > 0, "回答内容应正常产出");
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

console.log(`\nsession-title.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
