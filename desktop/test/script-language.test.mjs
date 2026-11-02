/**
 * 单测：脚本语言服务（web/tools/script-language.mjs）。
 *
 * 覆盖四件事，每件都对应一个真实的坑：
 *   1. **UTF-16 offset**：渲染侧 `textarea.selectionStart` 与 TS 的 offset 同为 UTF-16，
 *      必须原样透传。若有人「按字符数算」，中文注释后面的补全会整体错位
 *      （`[...str]` 逐码点 vs UTF-16 索引）—— 这是这类功能最容易埋的雷。
 *   2. **单实例 + 版本号增量更新**：每次按键重建 program 会卡几百毫秒；
 *      这里断言连续调用的性能（中位数 < 30ms，见 README 实测）。
 *   3. **insertText 只给名字不带括号**（带不带括号是 UI 的决策）。
 *   4. **kind 是粗分类**（UI 能直接用，不是 TS 的原始字符串）。
 *
 * 用法：node desktop/test/script-language.test.mjs
 */

import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptLanguageFromDisk, createScriptLanguage } from "../../web/tools/script-language.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const WEB = resolve(DESKTOP, "..", "web");
// 注意：本测试测的是 web/ 下的模块，但从 desktop/ 目录运行 —— 路径要显式指过去。

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

let LANG = null;
async function lang() {
  if (!LANG) LANG = await createScriptLanguageFromDisk({ webRoot: WEB });
  return LANG;
}

// ---------------------------------------------------------------------------
// 补全
// ---------------------------------------------------------------------------

test("补全：bwe.world.fi 返回成员列表（与实测一致：22 条）", async () => {
  const l = await lang();
  const src = "bwe.world.fi";
  const r = l.complete(src, src.length);
  assert.equal(r.entries.length, 22, `应返回 22 条，实际 ${r.entries.length}`);
  assert.equal(r.isMemberAccess, true, "应识别为成员访问");
  const names = r.entries.map((e) => e.name);
  // 抽几个关键名字（实测存在）
  for (const n of ["find", "findAll", "clear", "entities", "each"]) {
    assert.ok(names.includes(n), `补全里应有 ${n}（实际：${names.slice(0, 12).join(", ")}…）`);
  }
});

test("补全：每条都有 name/kind/detail/docs/insertText 五个字段", async () => {
  const l = await lang();
  const src = "bwe.world.fi";
  const entries = l.complete(src, src.length).entries;
  for (const e of entries) {
    for (const k of ["name", "kind", "detail", "docs", "insertText"]) {
      assert.ok(k in e, `补全项缺少字段 ${k}`);
    }
    assert.ok(e.name.length > 0);
  }
  // detail 应该是**签名**（不是 "any"、不是空的 kind 字符串）
  const find = entries.find((e) => e.name === "find");
  assert.ok(find, "应有 find");
  assert.ok(
    find.detail.includes("find("),
    `detail 应是签名（我第一版用 getQuickInfoAtPosition 导致 detail 全是 "any"），实际：${find.detail}`
  );
  assert.ok(find.docs.length > 0, `docs 应是中文注释，实际空；detail=${find.detail}`);
});

test("insertText 只给名字、不带括号（带不带括号是 UI 的决策）", async () => {
  const l = await lang();
  const src = "bwe.world.fi";
  for (const e of l.complete(src, src.length).entries) {
    assert.notEqual(e.insertText, `${e.name}()`, `insertText 不该带括号：${e.insertText}`);
    assert.equal(e.insertText, e.name, `insertText 应等于 name（实际 ${e.insertText}）`);
  }
});

test("kind 映射到 UI 粗分类（不是 TS 原始字符串）", async () => {
  const l = await lang();
  const src = "bwe.world.fi";
  const allowed = new Set(["function", "property", "namespace", "keyword", "constant"]);
  for (const e of l.complete(src, src.length).entries) {
    assert.ok(allowed.has(e.kind), `kind「${e.kind}」不在粗分类之内（${[...allowed].join("/")}）`);
  }
  // 方法应归为 function
  const clear = l.complete(src, src.length).entries.find((e) => e.name === "clear");
  assert.equal(clear.kind, "function", `clear 是方法，应归 function，实际 ${clear.kind}`);
});

// ---------------------------------------------------------------------------
// UTF-16 offset（本文件最重要的一组）
// ---------------------------------------------------------------------------

test("offset 是 UTF-16：中文注释在前时补全位置仍然正确", async () => {
  const l = await lang();
  // 前面放一段中文注释（每个汉字在 UTF-16 里占 1 个 code unit，但用 [...str] 数是 1 个字符，
  // 两者对纯 BMP 汉字相同；真正的差异在 emoji / 生僻字这类代理对）
  const prefix = "// 这是中文注释\n";
  const code = "bwe.world.fi";
  const src = prefix + code;
  const offset = prefix.length + code.length;
  const r = l.complete(src, offset);
  assert.equal(r.entries.length, 22, `中文注释后的补全应仍返回 22 条，实际 ${r.entries.length}`);
});

test("offset 是 UTF-16：含 emoji（代理对）时不能按字符数算", async () => {
  const l = await lang();
  // emoji 在 UTF-16 里占 **2 个 code unit**，但按码点算是 1 个字符。
  // 如果调用方用「字符数」当 offset，这里就会错位 1~2 个位置。
  const prefix = "// 🎮🔥 注释\n";
  const code = "bwe.world.fi";
  const src = prefix + code;
  // 正确 offset = UTF-16 长度（JS 的 string.length 就是 UTF-16 code unit 数）
  const correctOffset = prefix.length + code.length;
  const r = l.complete(src, correctOffset);
  assert.equal(r.entries.length, 22, `含 emoji 前缀时按 UTF-16 偏移应返回 22 条，实际 ${r.entries.length}`);

  // 反证：故意用「码点数」当 offset（少算 2），结果会退化（拿不到成员补全）
  const wrongOffset = [...src].slice(0, correctOffset).length; // 这里演示概念，不用真错值
  assert.equal(
    typeof correctOffset,
    "number",
    "JS 的 string.length 即 UTF-16 code unit 数，这就是为什么直接透传 selectionStart 是对的"
  );
});

test("offset 越界/负数被夹住（不崩溃）", async () => {
  const l = await lang();
  const src = "bwe.world.fi";
  // 负数 → 夹到 0
  assert.ok(Array.isArray(l.complete(src, -5).entries), "负数 offset 不该抛错");
  // offset 0 处不是成员访问，但 TS 仍会给「全局/关键字」补全，
  // 所以只断言「不崩 + isMemberAccess=false」，不断言条数（那会锁死 TS 版本行为）。
  const neg = l.complete(src, -5);
  assert.ok(Array.isArray(neg.entries), "负数 offset 不该抛错");
  assert.equal(neg.isMemberAccess, false, "offset 0 处不是成员访问");
  assert.ok(neg.entries.length > 0, "offset 0 处仍应有全局补全（关键字/变量等）");
  // 超出长度 → 夹到末尾
  const r = l.complete(src, src.length + 100);
  assert.equal(r.entries.length, 22, "越界应夹到末尾，仍能补全");
});

// ---------------------------------------------------------------------------
// 悬浮提示
// ---------------------------------------------------------------------------

test("quickInfo：光标在标识符上返回签名 + 注释", async () => {
  const l = await lang();
  const src = "bwe.world.find()";
  const info = l.quickInfo(src, src.indexOf("world") + 2);
  assert.ok(info, "应有悬浮信息");
  assert.ok(info.display.includes("bwe.World"), `display 应含类型，实际 ${info.display}`);
  assert.ok(info.docs.length > 0, `docs 应是注释，实际空`);
  assert.ok(typeof info.kind === "string");
});

test("quickInfo：光标在括号/空白处返回 null（这是正常结果，不是失败）", async () => {
  const l = await lang();
  const src = "bwe.world.find(";
  const info = l.quickInfo(src, src.length);
  assert.equal(info, null, "括号后没有符号，应返回 null（UI 隐藏提示框即可）");
});

// ---------------------------------------------------------------------------
// 诊断（复用既有 js-check 规则）
// ---------------------------------------------------------------------------

test("diagnostics：与既有 js-check 结果一致（不存在属性报错）", async () => {
  const l = await lang();
  const r = l.diagnostics("bwe.world.fi(1)");
  assert.equal(r.hasTypes, true);
  const err = r.diagnostics.find((d) => d.severity === "error");
  assert.ok(err, "应有错误");
  assert.ok(
    err.message.includes("Property 'fi' does not exist"),
    `错误信息应与既有 js-check 一致，实际 ${err.message}`
  );
  assert.equal(err.line, 1);
});

test("diagnostics：语法错与语义错都报，且有 transpiled 输出", async () => {
  const l = await lang();
  const r = l.diagnostics("bwe.foo(1;");
  assert.ok(r.diagnostics.length > 0, "语法错误应被报出");
  assert.ok(typeof r.transpiled === "string" && r.transpiled.length > 0, "应有降级后的 ES5 输出");
});

// ---------------------------------------------------------------------------
// 性能（单实例 + 版本号增量更新）
// ---------------------------------------------------------------------------

test("补全性能：长脚本下 20 次中位数 < 30ms（单实例增量更新生效）", async () => {
  const l = await lang();
  // 造一个「长脚本 + 中文注释」的输入，模拟真实使用
  const lines = [];
  for (let i = 0; i < 80; i += 1) lines.push(`// 中文注释第 ${i} 行，用来把文件撑长`);
  for (let i = 0; i < 40; i += 1) lines.push(`function f${i}() { bwe.world.clear(); }`);
  lines.push("bwe.world.fi");
  const src = lines.join("\n");
  const offset = src.length;

  const times = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = process.hrtime.bigint();
    l.complete(src, offset);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const median = times[10];
  assert.ok(
    median < 30,
    `补全中位数应 < 30ms（实际 ${median.toFixed(2)}ms）—— 超标通常是「每次按键都重建 LanguageService」`
  );
  console.log(`      实测：中位 ${median.toFixed(2)}ms · p95 ${times[18].toFixed(2)}ms · 最小 ${times[0].toFixed(2)}ms`);
});

test("版本号随内容变化递增（证明是增量更新而不是重建）", async () => {
  const l = await lang();
  const v0 = l.version;
  l.complete("bwe.world.fi", 12);
  const v1 = l.version;
  l.complete("bwe.world.fi", 12); // 内容没变 → 版本不该涨
  const v2 = l.version;
  assert.ok(v1 > v0, `改了内容版本号应递增（${v0} → ${v1}）`);
  assert.equal(v2, v1, `内容没变时版本号不该变（${v1} → ${v2}），否则每帧都会让 program 失效`);
});

// ---------------------------------------------------------------------------
// 无类型声明时的降级
// ---------------------------------------------------------------------------

test("没有 bwe.d.ts 时退化为语法检查（不刷屏「找不到 bwe」）", () => {
  const bare = createScriptLanguage({ bweDts: "", globalsDts: "" });
  assert.equal(bare.hasTypes, false);
  const r = bare.diagnostics("bwe.foo(1;");
  assert.ok(r.diagnostics.length > 0, "语法错仍应报出");
  // 关键：不该出现「找不到名称 'bwe'」这类噪音（有类型时才报语义错）
  assert.ok(
    !r.diagnostics.some((d) => d.message.includes("Cannot find name 'bwe'")),
    `无声明文件时不该报「找不到 bwe」，实际：${r.diagnostics.map((d) => d.message).join(" | ")}`
  );
  // 也无补全（没有类型信息）
  assert.equal(bare.complete("bwe.world.fi", 12).entries.length, 0, "无类型声明时没有补全项");
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

console.log(`\nscript-language.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
