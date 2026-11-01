/**
 * 单测：会话落盘（session.mjs）+ 压缩（compact.mjs）。
 *
 * 契约 §4.3 第 5/6 条是**行为约束**，不是建议：
 *   - 无损续接：history.json 必须能完整读回（含工具调用/结果）；
 *   - 原子写：不能留下半截 JSON（用 .tmp + rename）；
 *   - system prompt 版本变化 → **原地替换该块**，消息顺序与其他内容不动；
 *   - 超 70% 窗口触发压缩，尾部保留 ~20K token；
 *   - **无 key 时降级为结构化裁剪**，不许报错。
 *
 * 用法：node desktop/test/session.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openSession, makeMessage, messageText, workspaceHash, writeJsonAtomic, HISTORY_VERSION
} from "../lib/ai/session.mjs";
import { compactSession, shouldCompact, estimateTokens, structuredTrim, COMPACT_TRIGGER, TAIL_TOKENS } from "../lib/ai/compact.mjs";
import { buildSystemPrompt, PROMPT_VERSION } from "../lib/ai/prefix.mjs";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/** 每个用例一个临时目录，互不污染。 */
const dirs = [];
async function tmpDir() {
  const d = await mkdtemp(join(tmpdir(), "bwe-session-"));
  dirs.push(d);
  return d;
}

test("workspaceHash 稳定且区分大小写路径", () => {
  const a = workspaceHash("D:/githubdesktop/BrokenWonderEngine");
  const b = workspaceHash("D:/githubdesktop/BrokenWonderEngine");
  const c = workspaceHash("D:/other");
  assert.equal(a, b, "同一路径两次必须相同");
  assert.notEqual(a, c, "不同路径必须不同");
  assert.ok(a.length >= 8, "hash 太短会撞");
});

test("原子写：留下的是合法 JSON，且不留 .tmp", async () => {
  const dir = await tmpDir();
  const file = join(dir, "x.json");
  await writeJsonAtomic(file, { hello: "世界" });
  const text = await readFile(file, "utf8");
  assert.deepEqual(JSON.parse(text), { hello: "世界" });
  const files = await readdir(dir);
  assert.ok(!files.includes("x.json.tmp"), `不该留下临时文件：${files.join(",")}`);
});

test("新会话：写入 system 块，history/summary/meta 三件套齐全", async () => {
  const dir = await tmpDir();
  const s = await openSession({ dir, workspace: "D:/repo" });
  const files = await readdir(dir);
  for (const f of ["history.json", "summary.json", "meta.json"]) {
    assert.ok(files.includes(f), `缺少 ${f}`);
  }
  assert.equal(messageText(s.messages()[0] ?? {}).length, 0, "system 块不应出现在 messages() 里");
  assert.equal(s.systemText(), buildSystemPrompt(), "systemText 必须等于常量前缀");
  assert.equal(s.history.version, HISTORY_VERSION);
});

test("无损续接：重启后消息、顺序、工具块全在", async () => {
  const dir = await tmpDir();
  const s1 = await openSession({ dir, workspace: "D:/repo" });
  await s1.append(makeMessage("user", "第一条用户消息"));
  await s1.append(
    makeMessage("assistant", "我查一下", {
      blocks: [
        { type: "text", text: "我查一下" },
        { type: "tool-call", name: "ReadFile", arguments: { path: "world.js" } },
        { type: "tool-result", name: "ReadFile", preview: "…剪枝后的内容…", fullSha1: "abc123" }
      ]
    })
  );
  await s1.append(makeMessage("user", "谢谢"));

  const s2 = await openSession({ dir, workspace: "D:/repo" });
  const msgs = s2.messages();
  assert.equal(msgs.length, 3, `重启后消息数应为 3，实际 ${msgs.length}`);
  assert.equal(messageText(msgs[0]), "第一条用户消息");
  assert.equal(msgs[1].blocks.length, 3, "工具块必须完整保留（无损的要求）");
  assert.equal(msgs[1].blocks[2].fullSha1, "abc123");
  assert.equal(s2.systemText(), buildSystemPrompt());
});

test("system prompt 版本升级：原地替换，顺序不动", async () => {
  const dir = await tmpDir();
  // 伪造一份「旧版本」会话：system 块内容故意写错，前后各有一条消息。
  const oldHistory = {
    version: HISTORY_VERSION,
    promptVersion: "bwe-prompt-v0",
    messages: [
      { role: "user", at: "2026-01-01T00:00:00Z", blocks: [{ type: "text", text: "老消息在前" }] },
      { role: "system", block: "system", promptVersion: "bwe-prompt-v0", blocks: [{ type: "text", text: "旧前缀" }] },
      { role: "assistant", at: "2026-01-01T00:00:01Z", blocks: [{ type: "text", text: "老回复在后" }] }
    ]
  };
  await writeJsonAtomic(join(dir, "history.json"), oldHistory);
  const s = await openSession({ dir, workspace: "D:/repo" });
  const msgs = s.history.messages;
  // system 块位置不变（仍在 index 1），内容换成新版本，另外两条原地不动。
  assert.equal(msgs.length, 3, "不能新增/删除消息");
  assert.equal(msgs[1].role, "system");
  assert.equal(messageText(msgs[1]), buildSystemPrompt(), "system 块必须换成当前版本");
  assert.equal(messageText(msgs[0]), "老消息在前", "前面的消息顺序与内容都不许动");
  assert.equal(messageText(msgs[2]), "老回复在后", "后面的消息顺序与内容都不许动");
  assert.equal(s.history.promptVersion, PROMPT_VERSION);
  assert.equal(s.systemReplaced, true, "应报告发生了原地替换");
});

test("reset：清空对话但保留 system 块与空摘要", async () => {
  const dir = await tmpDir();
  const s = await openSession({ dir, workspace: "D:/repo" });
  await s.append(makeMessage("user", "会被清掉"));
  await s.reset();
  assert.equal(s.messages().length, 0);
  assert.equal(s.systemText(), buildSystemPrompt());
  assert.equal(s.summary.text, "");
  const reread = await openSession({ dir, workspace: "D:/repo" });
  assert.equal(reread.messages().length, 0, "重启后仍然是清空状态");
});

test("estimateTokens：中文密度高于英文", () => {
  const cjk = estimateTokens("这是一段中文文本用来估算 token 数量");
  const en = estimateTokens("this is an english sentence used to estimate tokens");
  assert.ok(cjk > 0 && en > 0);
  // 同样字符数下中文 token 更多（1.5 字符/token vs 4 字符/token）。
  const zh = "测".repeat(60);
  const en2 = "a".repeat(60);
  assert.ok(estimateTokens(zh) > estimateTokens(en2), `中文 ${estimateTokens(zh)} 应大于英文 ${estimateTokens(en2)}`);
  assert.equal(estimateTokens(""), 0);
});

test("shouldCompact：超 70% 窗口才触发", () => {
  const messages = [makeMessage("user", "x".repeat(1000))];
  assert.equal(COMPACT_TRIGGER, 0.7);
  const small = shouldCompact({ messages, contextWindow: 100000 });
  assert.equal(small.should, false);
  // 造一个远超窗口的消息
  const huge = [makeMessage("user", "x".repeat(400000))];
  const big = shouldCompact({ messages: huge, contextWindow: 100000 });
  assert.equal(big.should, true, `token=${big.tokens} limit=${big.limit}`);
  assert.ok(big.tokens > big.limit);
});

test("压缩（无 summarize 函数）→ 降级成结构化裁剪，不报错", async () => {
  const dir = await tmpDir();
  const s = await openSession({ dir, workspace: "D:/repo" });
  // 造 20 条长消息，确保超过 70%
  for (let i = 0; i < 20; i++) {
    await s.append(makeMessage(i % 2 ? "assistant" : "user", `第 ${i} 条：${"内容".repeat(900)}`));
  }
  const before = s.messages().length;
  const result = await compactSession({ session: s, contextWindow: 8000, tailTokens: 2000 });
  assert.equal(result.compacted, true, "应该真的压缩了");
  assert.equal(result.mode, "structured", `没给 summarize 时必须降级成 structured，实际 ${result.mode}`);
  assert.ok(result.after < result.before, `压缩后 token 应减少：${result.before} → ${result.after}`);
  assert.ok(result.summary.length > 0, "摘要不能为空");
  assert.ok(s.messages().length < before, "历史应被裁短");
  assert.ok(s.messages().length >= 1, "尾部必须保留原文");
  // 摘要落盘
  const summaryFile = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"));
  assert.ok(summaryFile.text.length > 0, "摘要必须持久化（重启后不重复消耗 token）");
  assert.equal(summaryFile.mode, "structured");
});

test("压缩（summarize 抛错）→ 仍然成功，降级不冒泡", async () => {
  const dir = await tmpDir();
  const s = await openSession({ dir, workspace: "D:/repo" });
  for (let i = 0; i < 20; i++) await s.append(makeMessage("user", `第 ${i} 条：${"内容".repeat(900)}`));
  const result = await compactSession({
    session: s,
    contextWindow: 8000,
    tailTokens: 2000,
    // 模拟「没 key / 网络断了」：摘要函数直接抛错。
    summarize: async () => {
      throw new Error("401 unauthorized");
    }
  });
  assert.equal(result.compacted, true);
  assert.equal(result.mode, "structured", "摘要失败必须降级，不能把整轮对话拖死");
});

test("压缩（summarize 正常）→ mode=llm，且与旧摘要合并", async () => {
  const dir = await tmpDir();
  const s = await openSession({ dir, workspace: "D:/repo" });
  await s.setSummary({ text: "【旧摘要】用户想做一个开放世界模板" });
  for (let i = 0; i < 20; i++) await s.append(makeMessage("user", `第 ${i} 条：${"内容".repeat(900)}`));
  const result = await compactSession({
    session: s,
    contextWindow: 8000,
    tailTokens: 2000,
    summarize: async () => "【新摘要】已经修好碰撞与光照，剩下载具物理。"
  });
  assert.equal(result.mode, "llm");
  assert.ok(result.summary.includes("【旧摘要】"), "旧摘要必须保留（合并而不是覆盖）");
  assert.ok(result.summary.includes("【新摘要】"), "新摘要必须写入");
  assert.ok(result.after < result.before);
});

test("结构化裁剪保留骨架（结论/错误行不丢）", () => {
  const msgs = [
    makeMessage("user", "# 任务\n帮我修一下碰撞\n```\nconst a = 1;\nconst b = 2;\n```\n原因：碰撞体没挂到同一节点。"),
    makeMessage("assistant", "结论：把碰撞体移到角色节点上即可。\n细节很长".repeat(20))
  ];
  const trimmed = structuredTrim(msgs, { maxCharsPerMessage: 300 });
  assert.ok(trimmed.includes("用户"), "要有角色标注");
  assert.ok(trimmed.includes("原因") || trimmed.includes("结论"), "结论/原因行必须留下");
  assert.ok(!trimmed.includes("const b = 2;"), "代码块正文应被折叠");
});

test("压缩时尾部保留原文（不是从头砍）", async () => {
  const dir = await tmpDir();
  const s = await openSession({ dir, workspace: "D:/repo" });
  const last = "最后一条关键消息：别忘了把 tileSize 改成 32";
  for (let i = 0; i < 20; i++) await s.append(makeMessage("user", `历史 ${i}：${"内容".repeat(900)}`));
  await s.append(makeMessage("user", last));
  const result = await compactSession({ session: s, contextWindow: 8000, tailTokens: 3000 });
  const kept = s.messages();
  assert.ok(
    kept.some((m) => messageText(m).includes("最后一条关键消息")),
    "最新的消息必须留在尾部原文里（否则续接会丢上下文）"
  );
  assert.ok(result.keptMessages >= 1);
  assert.ok(TAIL_TOKENS > 0);
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

// 清理临时目录
for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});

console.log(`\nsession.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
