/**
 * 单测：项目知识库（knowledge.mjs）。
 *
 * 这个模块的风险点全在**"悄悄记错/记串"**上，而且表现很隐蔽：
 *   · 两个同名工程共用一份知识库 → AI 拿 A 的经验改 B（错误的自信，比没记忆更糟）；
 *   · 只按路径算键 → 用户换个文件夹就"失忆"；
 *   · 要点提取把正文整段塞进去 → 知识库变成第二份聊天记录（体积膨胀 + 隐私留存）；
 *   · rounds.jsonl 半截写坏 → 整库读不出来；
 *   · 写知识库抛异常 → 拖垮对话本身（最不可接受的形态）。
 * 每条都要断言，且断言的是**行为**（"换个路径后键会变"），不是"看起来对"。
 *
 * 用法：node desktop/test/knowledge.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectKeyOf,
  openKnowledge,
  listProjects,
  extractRoundKnowledge,
  makeRoundRecord,
  oneLine,
  renderDigest,
  POINTS_PER_ROUND_MAX
} from "../lib/ai/knowledge.mjs";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const dirs = [];

async function tmpDir() {
  const d = await mkdtemp(join(tmpdir(), "bwe-kb-"));
  dirs.push(d);
  return d;
}

// ===========================================================================
// A. 项目身份（隔离的核心）
// ===========================================================================
test("A1: 同名不同路径 → 不同的项目键（绝不串记忆）", () => {
  const a = projectKeyOf({ name: "示例工程", file: "D:/a/示例工程.bwproj" });
  const b = projectKeyOf({ name: "示例工程", file: "E:/b/示例工程.bwproj" });
  assert.notEqual(a.key, b.key, `同名不同路径必须分键，实际都是 ${a.key}`);
  assert.equal(a.safeName, b.safeName, "安全化后的名字部分应该相同（便于人识别）");
  assert.match(a.key, /示例工程-/);
});

test("A2: 同一路径的不同写法 → 同一个项目键（Windows 大小写不敏感 + 分隔符统一）", () => {
  const a = projectKeyOf({ name: "P", file: "D:\\proj\\P.bwproj" });
  const b = projectKeyOf({ name: "P", file: "d:/proj/p.bwproj" });
  assert.equal(a.key, b.key, `同一条路径的不同写法必须同键：${a.key} vs ${b.key}`);
});

test("A3: 无路径（示例/未保存工程）→ 键里显式带 local，且不会与有路径的撞", () => {
  const noPath = projectKeyOf({ name: "示例工程" });
  assert.equal(noPath.pathHash, null);
  assert.equal(noPath.hasPath, false);
  assert.match(noPath.key, /-local$/, "无路径必须显式标 local（不要用'省略'来表达）");
  const withPath = projectKeyOf({ name: "示例工程", file: "D:/a/示例工程.bwproj" });
  assert.notEqual(noPath.key, withPath.key);
});

test("A4: 空名字 → 有兜底名，不产生空键", () => {
  const k = projectKeyOf({});
  assert.ok(k.key && k.key.length > 3, `空输入也要有可用的键：${k.key}`);
  assert.ok(!k.key.includes("/"), "键里不能含路径分隔符（它是目录名）");
});

test("A5: 名字里的非法字符被安全化，但仍保留中文（用户要能在文件夹里认出来）", () => {
  const k = projectKeyOf({ name: "我的/工程:测试", file: "D:/x.bwproj" });
  assert.ok(!/[\\/:*?"<>|]/.test(k.safeName), `安全化后仍有非法字符：${k.safeName}`);
  assert.ok(k.safeName.includes("我的"), "中文必须保留");
  assert.ok(k.key.includes("我的"));
});

test("A6: 超长名字被截断且不同长名不撞键", () => {
  const n1 = "非常非常非常非常非常非常非常非常非常非常非常非常非常长的工程名字一二三四五";
  const n2 = "非常非常非常非常非常非常非常非常非常非常非常非常非常长的工程名字一二三四六";
  const a = projectKeyOf({ name: n1 });
  const b = projectKeyOf({ name: n2 });
  assert.ok(a.safeName.length <= 40, `安全化后长度应 ≤40，实际 ${a.safeName.length}`);
  // 前缀相同、尾部不同 → 必须有 hash 尾巴区分，否则两个工程共用一份记忆
  assert.notEqual(a.key, b.key, "两个不同的超长名字不能算出同一个键");
});

// ===========================================================================
// B. 要点提取（零 token、结构化、不存全文）
// ===========================================================================
test("B1: 脚本写操作按脚本聚合，而不是按调用次数罗列", () => {
  const r = extractRoundKnowledge({
    intent: "edit-script",
    userText: "把玩家的速度改快一点",
    scriptOps: [
      { tool: "PatchScript", name: "player", ok: true },
      { tool: "PatchScript", name: "player", ok: true },
      { tool: "PatchScript", name: "player", ok: true }
    ]
  });
  const joined = r.points.join("\n");
  assert.ok(/改动脚本「player」：补丁 3 次/.test(joined), `应聚合成一条，实际：${joined}`);
  assert.equal(
    r.points.filter((p) => p.includes("player")).length,
    1,
    "同一个脚本应只占一条（否则一轮刷屏）"
  );
});

test("B2: 被拒绝的操作保留原话（这是'下次别这么写'的最强线索）", () => {
  const r = extractRoundKnowledge({
    scriptOps: [{ tool: "PatchScript", name: "npcs", ok: false, reason: "patch-ambiguous" }]
  });
  const joined = r.points.join("\n");
  assert.ok(joined.includes("被拒绝"), `应记录被拒绝，实际：${joined}`);
  assert.ok(joined.includes("patch-ambiguous"), "原因原文必须保留（不能只写'失败'）");
});

test("B3: 结论只取首句，不会把整段正文塞进知识库", () => {
  const long = "问题是碰撞体挂错了节点。具体来说，第一……".padEnd(3000, "废话");
  const r = extractRoundKnowledge({ answerText: long });
  const conclusion = r.points.find((p) => p.startsWith("结论："));
  assert.ok(conclusion, "应有结论条目");
  assert.ok(conclusion.length <= 240, `结论必须被压短，实际 ${conclusion.length} 字`);
  assert.ok(conclusion.startsWith("结论：问题是碰撞体挂错了节点"), `应只取首句：${conclusion}`);
});

test("B4: 要点条数有上限（知识库的价值在'能被读完'）", () => {
  const manyOps = Array.from({ length: 30 }, (_, i) => ({ tool: "WriteScript", name: `s${i}`, ok: true }));
  const r = extractRoundKnowledge({ scriptOps: manyOps, userText: "大改", answerText: "改完了。" });
  assert.ok(
    r.points.length <= POINTS_PER_ROUND_MAX,
    `要点数应 ≤ ${POINTS_PER_ROUND_MAX}，实际 ${r.points.length}`
  );
});

test("B5: 异常收尾被记录（绕圈/超时/取消）", () => {
  for (const [stop, word] of [["stalled", "绕圈"], ["timeout", "超时"], ["aborted", "取消"]]) {
    const r = extractRoundKnowledge({ stopReason: stop });
    assert.ok(
      r.points.some((p) => p.includes(word)),
      `stopReason=${stop} 应记成「${word}」，实际：${r.points.join(" | ")}`
    );
  }
});

test("B6: 正常收尾（stopReason=null）不该误报异常", () => {
  const r = extractRoundKnowledge({ stopReason: null, userText: "你好" });
  const joined = r.points.join("\n");
  assert.ok(!joined.includes("绕圈") && !joined.includes("超时") && !joined.includes("取消"), joined);
});

test("B7: 纯空输入不产生任何要点（不造假条目）", () => {
  const r = extractRoundKnowledge({});
  assert.equal(r.points.length, 0, `空输入不该产生要点：${r.points.join(" | ")}`);
});

test("B8: 一行化会把换行与连续空白压成单个空格", () => {
  assert.equal(oneLine("a\n\n  b   c"), "a b c");
  assert.equal(oneLine("   "), "");
  const long = "x".repeat(500);
  assert.ok(oneLine(long).length <= 220);
});

// ===========================================================================
// C. 记录形状 / digest 渲染
// ===========================================================================
test("C1: makeRoundRecord 带齐可追溯字段，且 meaningful 由要点数决定", () => {
  const rec = makeRoundRecord(
    { intent: "edit-script", userText: "改脚本", scriptOps: [{ tool: "PatchScript", name: "p", ok: true }] },
    { requestId: "r1", sessionId: "s1", project: { key: "K", name: "N", file: "F" } }
  );
  assert.equal(rec.requestId, "r1");
  assert.equal(rec.sessionId, "s1");
  assert.equal(rec.project.key, "K");
  assert.equal(rec.meaningful, true);
  assert.ok(rec.at, "必须有时间戳");
  assert.ok(Array.isArray(rec.points) && rec.points.length > 0);

  const empty = makeRoundRecord({}, { requestId: "r2" });
  assert.equal(empty.meaningful, false, "没有要点时应标 meaningful=false，而不是丢掉记录");
});

test("C2: digest.md 里要写清'无磁盘路径'（否则用户以为记忆会跟着文件夹走）", () => {
  const noPath = renderDigest({ key: "k-local", hasPath: false }, { name: "示例工程", roundCount: 0, pointCount: 0 }, []);
  assert.ok(noPath.includes("无磁盘路径"), noPath);
  const withPath = renderDigest(
    { key: "k-abc", hasPath: true },
    { name: "P", file: "D:/P.bwproj", roundCount: 1, pointCount: 1 },
    [{ at: "t", summary: "改了 1 个脚本", points: ["改动脚本「player」：补丁 1 次"] }]
  );
  assert.ok(withPath.includes("D:/P.bwproj"), "有路径时必须写出来");
  assert.ok(withPath.includes("改动脚本"), "必须列出要点");
});

// ===========================================================================
// D. 存储：隔离、追加、坏行容忍、检索不跨项目
// ===========================================================================
test("D1: 两个同名不同路径的工程，知识库物理隔离（各读各的）", async () => {
  const root = await tmpDir();
  const kbA = await openKnowledge({ root, project: { name: "同名工程", file: "D:/a/x.bwproj" } });
  const kbB = await openKnowledge({ root, project: { name: "同名工程", file: "E:/b/x.bwproj" } });
  assert.notEqual(kbA.dir, kbB.dir, "目录必须不同");

  await kbA.appendRound({ userText: "A 工程的改动", scriptOps: [{ tool: "PatchScript", name: "a", ok: true }] });
  await kbB.appendRound({ userText: "B 工程的改动", scriptOps: [{ tool: "PatchScript", name: "b", ok: true }] });

  const roundsA = await kbA.readRounds();
  const roundsB = await kbB.readRounds();
  assert.equal(roundsA.length, 1);
  assert.equal(roundsB.length, 1);
  assert.ok(roundsA[0].points.join().includes("a"), "A 里只该有 A 的内容");
  assert.ok(roundsB[0].points.join().includes("b"), "B 里只该有 B 的内容");
  assert.ok(!roundsA[0].points.join().includes("B 工程的改动"), "★ A 绝不能读到 B 的记忆");

  const hitsA = await kbA.search("改动");
  const hitsB = await kbB.search("改动");
  assert.ok(hitsA.every((h) => !h.point.includes("b")), "检索也不能跨项目");
  assert.ok(hitsB.every((h) => !h.point.includes("a")), "检索也不能跨项目");
});

test("D2: 同一工程多轮追加 → 新的在前，index 统计正确", async () => {
  const root = await tmpDir();
  const kb = await openKnowledge({ root, project: { name: "P", file: "D:/p.bwproj" } });
  await kb.appendRound({ userText: "第一轮", scriptOps: [{ tool: "PatchScript", name: "p", ok: true }] });
  await kb.appendRound({ userText: "第二轮", scriptOps: [{ tool: "WriteScript", name: "q", ok: true }] });

  const rounds = await kb.readRounds();
  assert.equal(rounds.length, 2);
  assert.ok(rounds[0].points.join().includes("第二轮"), "readRounds 必须新的在前");
  const stats = await kb.stats();
  assert.equal(stats.roundCount, 2);
  assert.ok(stats.pointCount >= 2);
  assert.equal(stats.meaningfulRounds, 2);
});

test("D3: rounds.jsonl 里有一行损坏时，其余行仍能读出来（JSONL 的意义）", async () => {
  const root = await tmpDir();
  const kb = await openKnowledge({ root, project: { name: "P" } });
  await kb.appendRound({ userText: "好行一", scriptOps: [{ tool: "PatchScript", name: "p", ok: true }] });
  // 手动注入一行坏数据（模拟写到一半崩溃）
  const { appendFile } = await import("node:fs/promises");
  await appendFile(kb.roundsPath, '{"at":"x","points":["未闭合的 JSON\n', "utf8");
  await kb.appendRound({ userText: "好行二", scriptOps: [{ tool: "PatchScript", name: "q", ok: true }] });

  const rounds = await kb.readRounds();
  assert.equal(rounds.length, 2, `坏行必须被跳过而不是让整库读不出来，实际读到 ${rounds.length} 条`);
});

test("D4: 空知识库可正常打开与查询（不抛异常）", async () => {
  const root = await tmpDir();
  const kb = await openKnowledge({ root, project: { name: "空工程" } });
  assert.deepEqual(await kb.readRounds(), []);
  assert.deepEqual(await kb.search("任何词"), []);
  const stats = await kb.stats();
  assert.equal(stats.roundCount, 0);
});

test("D5: 检索按命中词数排序（多词查询不该被单词命中挤下去）", async () => {
  const root = await tmpDir();
  const kb = await openKnowledge({ root, project: { name: "P" } });
  /**
   * ⚠ 这里必须用**真实的运行数据**构造（userText / scriptOps / answerText），
   * 不能传预先算好的 points —— `makeRoundRecord` 只信 `extractRoundKnowledge` 的输出，
   * 外传的 points 会被忽略。这一点本身是对的（要点只能从运行数据推导，不能凭空塞），
   * 但写成夹具时很容易搞错（我第一次就是传了 points，结果两条都是空要点、检索 0 命中）。
   */
  await kb.appendRound({ userText: "只是物理", answerText: "这里讲的是物理。" });
  await kb.appendRound({
    userText: "物理碰撞体挂错了节点怎么办",
    answerText: "物理碰撞是需要节点、碰撞体一起看的。"
  });
  const hits = await kb.search("物理 碰撞 节点");
  assert.ok(hits.length >= 1, `应至少命中 1 条，实际 ${hits.length}`);
  assert.ok(
    hits[0].point.includes("节点"),
    `命中更多词的应排第一，实际第一是：${hits[0].point}`
  );
});

test("D6: listProjects 直接从目录读（不依赖总索引），能列出多个项目并按更新时间排序", async () => {
  const root = await tmpDir();
  const a = await openKnowledge({ root, project: { name: "A工程", file: "D:/a.bwproj" } });
  await a.appendRound({ points: ["A 要点"], summary: "s", meaningful: true });
  const b = await openKnowledge({ root, project: { name: "B工程", file: "D:/b.bwproj" } });
  await b.appendRound({ points: ["B 要点"], summary: "s", meaningful: true });

  const list = await listProjects(root);
  assert.equal(list.length, 2, `应列出 2 个项目，实际 ${list.length}`);
  const names = list.map((p) => p.name).sort();
  assert.deepEqual(names, ["A工程", "B工程"]);
  assert.ok(list.every((p) => p.roundCount === 1));
});

test("D7: 一个没有 index.json 的残留目录不会被当成有效项目", async () => {
  const root = await tmpDir();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "垃圾目录"), { recursive: true });
  const list = await listProjects(root);
  assert.equal(list.length, 0, "没有 index 的目录不是项目");
});

test("D8: digest.md 会真的写到磁盘上（用户能直接打开看）", async () => {
  const root = await tmpDir();
  const kb = await openKnowledge({ root, project: { name: "P", file: "D:/p.bwproj" } });
  await kb.appendRound({
    userText: "把 speed 改成 9",
    scriptOps: [{ tool: "PatchScript", name: "player", ok: true }]
  });
  assert.ok(existsSync(kb.digestPath), "digest.md 应存在");
  const md = await readFile(kb.digestPath, "utf8");
  assert.ok(md.includes("# P · 项目知识库"), md.slice(0, 200));
  assert.ok(md.includes("player"), "digest 里应能看到改过的脚本");
});

// ===========================================================================
// E. 失败隔离（知识库坏了不能拖垮对话）
// ===========================================================================
test("E1: 知识库根不可写时，调用方拿到异常——但这一条只证明'异常是可控的'", async () => {
  // 这里断言的是**接口行为**：openKnowledge 失败会 reject（而不是静默返回半个对象）。
  // 上层 bridge 负责 catch 并只记日志 —— 那一层由 ai-knowledge 的集成测试覆盖。
  const bad = join(tmpdir(), "bwe-kb-not-a-dir", "x");
  let threw = false;
  try {
    // 拿一个"父路径是文件"的位置当根，mkdir 必然失败
    const fileAsRoot = join(tmpdir(), "bwe-kb-file-as-root");
    await writeFile(fileAsRoot, "i am a file", "utf8");
    await openKnowledge({ root: join(fileAsRoot, "sub"), project: { name: "P" } });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "路径不可用时应抛异常（由上层 catch），而不是静默成功");
});

for (const c of cases) {
  try {
    await c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    console.error(`  ✗ ${c.name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}
for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});

console.log(`\nknowledge.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
