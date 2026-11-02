/**
 * 单测：多会话存储（desktop/lib/ai/conversations.mjs）。
 *
 * 按 Lead 的要求**先写测试再改实现**。五类行为各有明确的失败模式：
 *
 *   1. **老数据迁移**：旧的单份 `history.json` 必须自动变成第一个会话。
 *      做错的后果是**用户丢历史** —— 这是本功能唯一"不可接受"的失败。
 *   2. **开新会话**：当前会话要保留（不能覆盖掉），新会话 id 不能与已有冲突。
 *   3. **切换会话**：返回目标会话的完整 messages；active 要持久化（重启后还在该会话）。
 *   4. **删除会话**：删掉 active 时要有合理的落点（不能 active 指向已删除的 id）。
 *      删最后一个会话时不能把存储搞成非法状态（下次启动要能正常开新会话）。
 *   5. **标题生成**：第一条用户消息前 20 字，**零 token**（不调模型）。
 *      多行消息要压成一行；空消息要回落到默认标题，不能是空字符串。
 *
 * 另有两条边界：index.json 损坏时不能崩；并发写 index 要原子（先 .tmp 再 rename）。
 *
 * 用法：node desktop/test/conversations.test.mjs
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createConversationStore,
  makeTitle,
  CONVERSATIONS_DIR,
  INDEX_FILE,
  DEFAULT_TITLE,
  TITLE_MAX_CHARS
} from "../lib/ai/conversations.mjs";
import { openSession, makeMessage, messageText } from "../lib/ai/session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const dirs = [];
async function tmpDir() {
  const d = await mkdtemp(join(tmpdir(), "bwe-conv-"));
  dirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// 标题生成（纯函数，零 token）
// ---------------------------------------------------------------------------

test("makeTitle：取第一条消息前 20 字，零 token（不调模型）", () => {
  const long = "请帮我重构一下这个场景里的所有脚本，特别是玩家移动那部分逻辑，现在有点卡";
  const t = makeTitle(long);
  assert.equal(t.length <= TITLE_MAX_CHARS, true, `标题不该超过 ${TITLE_MAX_CHARS} 字，实际 ${t.length}`);
  assert.ok(long.startsWith(t.replace(/…$/, "")), `标题应取自原文开头，实际「${t}」`);
});

test("makeTitle：短消息原样作为标题（不加省略号）", () => {
  const t = makeTitle("解释这段代码");
  assert.equal(t, "解释这段代码");
});

test("makeTitle：多行压成一行（标题栏只有一行）", () => {
  const t = makeTitle("第一行标题\n第二行细节\n第三行");
  assert.ok(!t.includes("\n"), `标题不能含换行，实际「${t}」`);
  assert.ok(t.startsWith("第一行标题"), `应保留开头，实际「${t}」`);
});

test("makeTitle：首尾空白被裁掉", () => {
  assert.equal(makeTitle("   解释这段代码   "), "解释这段代码");
});

test("makeTitle：空/纯空白/null/undefined → 默认标题（不能是空串）", () => {
  for (const bad of ["", "   ", "\n\n", "\u3000\u3000", null, undefined]) {
    const t = makeTitle(bad);
    assert.equal(t, DEFAULT_TITLE, `输入 ${JSON.stringify(bad)} 应回落默认标题，实际「${t}」`);
    assert.ok(t.length > 0, "默认标题不能是空串（列表里会是一行空白）");
  }
  // 数字这类「有内容但不是字符串」的输入，转成字符串当标题是合理的（不该丢内容）；
  // 真正要防的是「空内容 → 空标题」。
  assert.equal(makeTitle(123), "123", "数字转字符串作为标题（有内容就不该回落默认）");
});

// ---------------------------------------------------------------------------
// 老数据迁移（最不能出错的一条）
// ---------------------------------------------------------------------------

test("迁移：旧的单份 history.json 自动变成第一个会话（不丢历史）", async () => {
  const dir = await tmpDir();
  // 造一份「老版本」存储：直接是 sessions/<hash>/history.json + summary.json + meta.json
  const oldHistory = {
    version: 1,
    promptVersion: "bwe-prompt-v0",
    messages: [
      { role: "system", block: "system", promptVersion: "bwe-prompt-v0", blocks: [{ type: "text", text: "旧前缀" }] },
      { role: "user", at: "2026-01-01T00:00:00Z", blocks: [{ type: "text", text: "旧会话里的用户消息" }] },
      { role: "assistant", at: "2026-01-01T00:00:01Z", blocks: [{ type: "text", text: "旧会话里的助手回复" }] }
    ]
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "history.json"), JSON.stringify(oldHistory, null, 2), "utf8");
  await writeFile(join(dir, "summary.json"), JSON.stringify({ text: "旧摘要", coveredMessages: 1 }), "utf8");

  const store = createConversationStore({ dir, workspace: REPO });
  const state = await store.load();

  assert.equal(state.sessions.length, 1, `迁移后应恰好 1 个会话，实际 ${state.sessions.length}`);
  assert.equal(state.active, state.sessions[0].id, "active 应指向迁移出来的会话");

  // 关键：消息一条都不能丢
  const opened = await openSession({ dir: store.conversationDir(state.active), workspace: REPO });
  const texts = opened.messages().map((m) => messageText(m));
  assert.ok(texts.includes("旧会话里的用户消息"), `旧用户消息丢了！实际：${texts.join(" | ")}`);
  assert.ok(texts.includes("旧会话里的助手回复"), `旧助手回复丢了！实际：${texts.join(" | ")}`);
  // 旧摘要也保留
  assert.ok((await store.summaryOf(state.active))?.text?.includes("旧摘要"), "旧摘要应保留");

  // 迁移后旧的顶层文件应被移走（否则下次启动会再次迁移，产生重复会话）
  const filesAtRoot = await readdir(dir);
  assert.ok(!filesAtRoot.includes("history.json"), `迁移后顶层 history.json 应被归档/移除，实际还有：${filesAtRoot.join(", ")}`);
});

test("迁移：没有老数据时创建第一个空会话（而不是报错）", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  const state = await store.load();
  assert.equal(state.sessions.length, 1, "全新目录也应有一个可用会话");
  assert.equal(state.active, state.sessions[0].id);
  assert.equal(state.sessions[0].messageCount, 0);
});

test("迁移只发生一次（重复 load 不会产生第二个会话）", async () => {
  const dir = await tmpDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "history.json"),
    JSON.stringify({ messages: [{ role: "user", blocks: [{ type: "text", text: "旧消息" }] }] }),
    "utf8"
  );
  const store = createConversationStore({ dir, workspace: REPO });
  await store.load();
  const store2 = createConversationStore({ dir, workspace: REPO });
  const state2 = await store2.load();
  assert.equal(state2.sessions.length, 1, `重复 load 应仍只有 1 个会话，实际 ${state2.sessions.length}`);
});

// ---------------------------------------------------------------------------
// 开新会话
// ---------------------------------------------------------------------------

test("new：开新会话时当前会话保留（不覆盖）", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  const s0 = await store.load();
  const firstId = s0.active;

  // 往第一个会话写点内容
  const sess = await openSession({ dir: store.conversationDir(firstId), workspace: REPO });
  await sess.append(makeMessage("user", "第一条会话的消息"));

  const created = await store.create({ title: "第二个会话" });
  assert.notEqual(created.id, firstId, "新会话 id 不能与已有重复");
  const state = await store.load();
  assert.equal(state.sessions.length, 2, `应有 2 个会话，实际 ${state.sessions.length}`);
  assert.equal(state.active, created.id, "active 应切到新会话");

  // 第一个会话内容必须还在
  const reopened = await openSession({ dir: store.conversationDir(firstId), workspace: REPO });
  assert.ok(
    reopened.messages().some((m) => messageText(m).includes("第一条会话的消息")),
    "开新会话不能覆盖旧会话内容"
  );
});

test("new：id 唯一（快速连续创建不冲突）", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  await store.load();
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push((await store.create({ title: `会话 ${i}` })).id);
  assert.equal(new Set(ids).size, ids.length, `id 必须唯一，实际：${ids.join(", ")}`);
  assert.equal((await store.load()).sessions.length, 6, "5 个新建 + 1 个初始 = 6");
});

// ---------------------------------------------------------------------------
// 切换
// ---------------------------------------------------------------------------

test("switch：返回目标会话的完整 messages，且 active 持久化", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  const s0 = await store.load();
  const aId = s0.active;

  const sessA = await openSession({ dir: store.conversationDir(aId), workspace: REPO });
  await sessA.append(makeMessage("user", "A 会话的消息"));
  await sessA.append(makeMessage("assistant", "A 会话的回复"));

  const b = await store.create({ title: "B 会话" });
  const sessB = await openSession({ dir: store.conversationDir(b.id), workspace: REPO });
  await sessB.append(makeMessage("user", "B 会话的消息"));

  const switched = await store.switchTo(aId);
  assert.equal(switched.active, aId);
  assert.ok(switched.messages.length >= 2, `应返回 A 的完整消息，实际 ${switched.messages.length} 条`);
  assert.ok(
    switched.messages.some((m) => (m.text ?? "").includes("A 会话的消息") || JSON.stringify(m).includes("A 会话的消息")),
    "返回的 messages 应属于 A 会话"
  );

  // 重启后 active 仍在 A
  const store2 = createConversationStore({ dir, workspace: REPO });
  assert.equal((await store2.load()).active, aId, "active 必须持久化（重启后停在同一会话）");
});

test("switch：id 不存在时明确失败（不静默切到别的）", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  const state = await store.load();
  await assert.rejects(
    () => store.switchTo("ghost-id"),
    /不存在|不在|not found/i,
    "切到不存在的 id 应明确报错，而不是静默切到别的会话"
  );
  assert.equal((await store.load()).active, state.active, "失败时 active 不该变");
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

test("delete：删非 active 会话，active 不变", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  const s0 = await store.load();
  const aId = s0.active;
  const b = await store.create({ title: "B" });
  await store.switchTo(aId);

  const after = await store.remove(b.id);
  assert.equal(after.sessions.length, 1);
  assert.equal(after.active, aId, "删非 active 时 active 不该变");
});

test("delete：删 active 会话时落到另一个会话（不留悬空 active）", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  const s0 = await store.load();
  const aId = s0.active;
  const b = await store.create({ title: "B" });
  assert.equal((await store.load()).active, b.id, "创建后 active 是 B");

  const after = await store.remove(b.id); // 删掉当前 active
  assert.equal(after.sessions.length, 1);
  assert.equal(after.active, aId, `删掉 active 后应落到剩下的会话，实际 ${after.active}`);
  assert.ok(
    after.sessions.some((s) => s.id === after.active),
    "active 必须指向一个真实存在的会话"
  );

  // 磁盘上也要一致
  const reloaded = await createConversationStore({ dir, workspace: REPO }).load();
  assert.equal(reloaded.active, aId);
});

test("delete：删到只剩 0 个时自动补一个新会话（不留非法状态）", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  const s0 = await store.load();
  const only = s0.active;
  const after = await store.remove(only);
  assert.equal(after.sessions.length, 1, "删光后应自动补一个空会话（否则 UI 没有可用的会话）");
  assert.equal(after.active, after.sessions[0].id);
  // 新补的会话应是空的
  assert.equal(after.sessions[0].messageCount, 0);
});

test("delete：id 不存在时明确失败", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  await store.load();
  await assert.rejects(() => store.remove("ghost"), /不存在|不在|not found/i);
});

// ---------------------------------------------------------------------------
// 索引与健壮性
// ---------------------------------------------------------------------------

test("index.json 结构与约定字段齐全", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  await store.load();
  const idx = JSON.parse(await readFile(join(dir, INDEX_FILE), "utf8"));
  assert.ok(Array.isArray(idx.sessions));
  for (const s of idx.sessions) {
    for (const k of ["id", "title", "createdAt", "updatedAt", "messageCount"]) {
      assert.ok(k in s, `索引项缺少字段 ${k}`);
    }
  }
  assert.ok("active" in idx, "index.json 必须记录 active");
  // 会话内容放在 conversations/<id>/ 下
  const convDirs = await readdir(join(dir, CONVERSATIONS_DIR));
  assert.ok(convDirs.includes(idx.sessions[0].id), `会话目录应叫 conversations/<id>，实际：${convDirs.join(", ")}`);
});

test("index.json 损坏时不崩，能恢复出可用状态", async () => {
  const dir = await tmpDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, INDEX_FILE), "{ broken json", "utf8");
  const store = createConversationStore({ dir, workspace: REPO });
  const state = await store.load(); // 不该抛
  assert.ok(state.sessions.length >= 1, "索引损坏时应能恢复出至少一个会话");
  assert.equal(state.active, state.sessions[0].id);
});

test("原子写：index.json 不留 .tmp 文件", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  await store.load();
  await store.create({ title: "x" });
  const files = await readdir(dir);
  assert.ok(!files.includes(`${INDEX_FILE}.tmp`), `不该残留 .tmp：${files.join(", ")}`);
});

test("messageCount 与 updatedAt 随写入更新", async () => {
  const dir = await tmpDir();
  const store = createConversationStore({ dir, workspace: REPO });
  const s0 = await store.load();
  const id = s0.active;
  const sess = await openSession({ dir: store.conversationDir(id), workspace: REPO });
  await sess.append(makeMessage("user", "消息一"));
  await sess.append(makeMessage("assistant", "消息二"));
  await store.touch(id);
  const state = await store.load();
  const item = state.sessions.find((s) => s.id === id);
  assert.ok(item.messageCount >= 2, `messageCount 应 >= 2，实际 ${item.messageCount}`);
  assert.ok(item.updatedAt > s0.sessions[0].createdAt || item.updatedAt !== s0.sessions[0].updatedAt, "updatedAt 应更新");
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

console.log(`\nconversations.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
