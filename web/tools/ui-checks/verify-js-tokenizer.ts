/**
 * 语法着色令牌器的单测。
 *
 * 为什么必须单测（而不是截一张有颜色的图）：错色**看起来永远是"还行"**。
 * 少染一个关键字、字符串边界差一格、注释里的引号被当成字符串开头 ——
 * 这些在截图里都是"一片好看的彩色"，只有断言能钉住。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-js-tokenizer.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/js-tokenizer.mjs
 *   node .tmp_ui/js-tokenizer.mjs
 */
import {
  countKinds,
  hasHighlight,
  tokenize,
  wordsOfKind,
  type TokenKind
} from "../../src/panels/jsTokenizer.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

/** 取某段文本的 kind（按区间命中判断）。 */
function kindAt(text: string, snippet: string): TokenKind | null {
  const idx = text.indexOf(snippet);
  if (idx < 0) return null;
  for (const t of tokenize(text)) {
    if (idx >= t.start && idx < t.end) return t.kind;
  }
  return null;
}

/** 不变式：token 必须首尾相接、无重叠、覆盖全文。 */
function contiguous(text: string): { ok: boolean; why: string } {
  const tokens = tokenize(text);
  if (!text) return { ok: tokens.length === 0, why: tokens.length === 0 ? "" : "空文本却返回了 token" };
  let cursor = 0;
  for (const t of tokens) {
    if (t.start !== cursor) return { ok: false, why: `断档：期望 start=${cursor} 实际 ${t.start}` };
    if (t.end <= t.start) return { ok: false, why: `空区间 ${t.start}-${t.end}` };
    cursor = t.end;
  }
  if (cursor !== text.length) return { ok: false, why: `没覆盖到末尾：${cursor} != ${text.length}` };
  return { ok: true, why: "" };
}

// ============================================================================
console.log("== 不变式：连续覆盖 ==");
{
  const samples = [
    "",
    " ",
    "var a = 1;",
    "// 只有注释",
    "/* 块注释 */",
    "function onStart(ctx) {\n  bwe.log('hi');\n}",
    "'未闭合的字符串",
    "/* 未闭合的块注释",
    "`多行\n模板`",
    "Math.max(1, 2) + JSON.stringify({})",
    "bwe.world.find('player')",
    "1.5e-3 + 0x1f + 0b101 + .5",
    "中文注释 // 混排 abc 数字 123",
    "a\r\nb",
    "if (x) { } else { }"
  ];
  let allOk = true;
  const bad: string[] = [];
  for (const s of samples) {
    const r = contiguous(s);
    if (!r.ok) {
      allOk = false;
      bad.push(`「${s.slice(0, 24)}」→ ${r.why}`);
    }
  }
  check("所有样本都连续覆盖全文、无断档无重叠", allOk, bad.join(" | "));
}
{
  const r = contiguous("");
  check("空文本 → 零 token", tokenize("").length === 0, r.why);
}

// ============================================================================
console.log("== 注释 ==");
{
  const t = "// 注释 here\ncode";
  check("行注释整段是 comment", wordsOfKind(t, tokenize(t), "comment")[0] === "// 注释 here");
  const t2 = "var a = 1; // tail";
  check("行尾注释", wordsOfKind(t2, tokenize(t2), "comment")[0] === "// tail");
}
{
  const t = "/* 多行\n注释 */x";
  const c = wordsOfKind(t, tokenize(t), "comment");
  check("块注释跨行", c.length === 1 && c[0].startsWith("/*") && c[0].endsWith("*/"), JSON.stringify(c));
  check("块注释之后的 x 是 plain", kindAt(t, "x") === "plain");
}
{
  const t = "/* 未闭合";
  const c = wordsOfKind(t, tokenize(t), "comment");
  check("未闭合块注释：整篇按注释吃下（打字中间态不抛错）", c.length === 1 && c[0] === "/* 未闭合", JSON.stringify(c));
}
{
  const t = "// function fake() {}";
  const kw = wordsOfKind(t, tokenize(t), "keyword");
  check("注释里的 function 不被当关键字", kw.length === 0, JSON.stringify(kw));
}

// ============================================================================
console.log("== 字符串 ==");
{
  const t = "var s = 'a return b';";
  const str = wordsOfKind(t, tokenize(t), "string");
  check("单引号字符串整段", str[0] === "'a return b'", JSON.stringify(str));
  check("字符串里的 return 不被当关键字", wordsOfKind(t, tokenize(t), "keyword").includes("return") === false);
}
{
  const t = 'var s = "a \\" b"; var x = 1;';
  const str = wordsOfKind(t, tokenize(t), "string");
  check("转义引号不会提前结束字符串", str[0] === '"a \\" b"', JSON.stringify(str));
  check("字符串之后的 var 仍是关键字", wordsOfKind(t, tokenize(t), "keyword").includes("var"));
}
{
  const t = "var s = `line1\nline2`;";
  const str = wordsOfKind(t, tokenize(t), "string");
  check("模板字符串可跨行", str.length === 1 && str[0].includes("\n"), JSON.stringify(str));
}
{
  const t = "var s = '未闭合";
  const str = wordsOfKind(t, tokenize(t), "string");
  check("未闭合单引号：到行尾为止（不吞掉后面的代码）", str.length === 1 && str[0] === "'未闭合", JSON.stringify(str));
  const t2 = "var s = 'a\nvar b = 2;";
  check("单引号不跨行：下一行的 var 仍是关键字",
    wordsOfKind(t2, tokenize(t2), "keyword").includes("var"),
    JSON.stringify(wordsOfKind(t2, tokenize(t2), "keyword")));
}
{
  const t = "bwe.log('Math.max 不该是 global')";
  const g = wordsOfKind(t, tokenize(t), "global");
  check("字符串里的 Math 不被染成 global", g.length === 0, JSON.stringify(g));
}

// ============================================================================
console.log("== 数字 ==");
{
  const cases: [string, string][] = [
    ["var a = 123;", "123"],
    ["var a = 1.5;", "1.5"],
    ["var a = 0x1f;", "0x1f"],
    ["var a = 0b101;", "0b101"],
    ["var a = 0o17;", "0o17"],
    ["var a = 1e-3;", "1e-3"],
    ["var a = 1_000;", "1_000"],
    ["var a = .5;", ".5"]
  ];
  let ok = true;
  const bad: string[] = [];
  for (const [src, want] of cases) {
    const got = wordsOfKind(src, tokenize(src), "number");
    if (got[0] !== want) {
      ok = false;
      bad.push(`${src} → ${JSON.stringify(got)}（期望 ${want}）`);
    }
  }
  check("数字各种写法都识别（含 hex/bin/oct/科学/分隔符/前导点）", ok, bad.join(" | "));
}
{
  const t = "var a = 12 + b2;";
  const nums = wordsOfKind(t, tokenize(t), "number");
  check("标识符里的数字不被切开（b2 不是数字）", nums.length === 1 && nums[0] === "12", JSON.stringify(nums));
}

// ============================================================================
console.log("== 关键字 ==");
{
  const t = "var let const function return if else for while new typeof this null true false";
  const k = wordsOfKind(t, tokenize(t), "keyword");
  check("常见关键字全部染上", k.length === 15, `${k.length} 个：${k.join(",")}`);
}
{
  const t = "var value = 1;";
  check("普通标识符不是关键字（value 不含 var）", wordsOfKind(t, tokenize(t), "keyword").join(",") === "var");
}
{
  const t = "var get = 2; var set = 3; var from = 4;";
  const k = wordsOfKind(t, tokenize(t), "keyword");
  check("get / set / from 不染成关键字（它们常作普通变量名）",
    !k.includes("get") && !k.includes("set") && !k.includes("from"), k.join(","));
}
{
  // of 是**有意的例外**：for-of 是高频真实代码，按出现频率站队而不是规范严格性
  const t = "for (var x of arr) { }";
  check("of 在 for-of 里染成关键字（高频形态，高频优先）",
    wordsOfKind(t, tokenize(t), "keyword").includes("of"));
}

// ============================================================================
console.log("== bwe 命名空间（核心需求）==");
{
  const t = "bwe.world.find('player')";
  const b = wordsOfKind(t, tokenize(t), "bwe");
  check("bwe 与 world 都染成 bwe 色", b.join("+") === "bwe+world", b.join("+"));
  check("方法名 find 不染（保留成员层次感）", !b.includes("find"), b.join("+"));
}
{
  const t = "bwe.draw.text('hi', 1, 2); bwe.audio.play('x'); bwe.camera.shake(4, 0.2);";
  const b = wordsOfKind(t, tokenize(t), "bwe");
  check("draw / audio / camera 都识别", b.includes("draw") && b.includes("audio") && b.includes("camera"), b.join("+"));
}
{
  const t = "function onStart(ctx) {}\nfunction onUpdate(ctx, dt) {}";
  const b = wordsOfKind(t, tokenize(t), "bwe");
  check("生命周期钩子染成 bwe 色（它们是引擎契约，不是语言关键字）",
    b.includes("onStart") && b.includes("onUpdate"), b.join("+"));
  check("生命周期钩子**不是** keyword", !wordsOfKind(t, tokenize(t), "keyword").includes("onStart"));
}
{
  // 未在命名空间表里的 bwe 成员也不该错色
  const t = "bwe.someFutureThing.method()";
  const b = wordsOfKind(t, tokenize(t), "bwe");
  check("未知 bwe 成员：只染 bwe 本身，不错色", b.join("+") === "bwe", b.join("+"));
}
{
  const t = "var bewilder = 1; var world = 2;";
  const b = wordsOfKind(t, tokenize(t), "bwe");
  // `world` 是 bwe 命名空间名，会被染（这是接受的近似：它几乎只作为 bwe.world 出现）。
  // 但 `bewilder` 绝不能因为"包含 bwe"被染。
  check("包含 bwe 的普通词（bewilder）不被染", !b.includes("bewilder"), b.join("+"));
}

// ============================================================================
console.log("== JS 内置 API（核心需求）==");
{
  const t = "Math.max(1, 2); JSON.stringify({}); Object.keys(o);";
  const g = wordsOfKind(t, tokenize(t), "global");
  check("Math / JSON / Object 都染成 global", g.includes("Math") && g.includes("JSON") && g.includes("Object"), g.join("+"));
  check("方法名 max / stringify / keys 不染", !g.includes("max") && !g.includes("stringify"), g.join("+"));
}
{
  const t = "Array.isArray(a); String(x); Number(y); Boolean(z); Date.now(); RegExp('a'); parseInt('1'); parseFloat('1.5'); isNaN(n); console.log('x');";
  const g = new Set(wordsOfKind(t, tokenize(t), "global"));
  const want = ["Array", "String", "Number", "Boolean", "Date", "RegExp", "parseInt", "parseFloat", "isNaN", "console"];
  const missing = want.filter((w) => !g.has(w));
  check("十个常用内置 API 全部识别", missing.length === 0, `缺：${missing.join(",")}`);
}
{
  const t = "Error(x); TypeError(y); Promise.resolve(); Map(); Set(); Symbol('s');";
  const g = wordsOfKind(t, tokenize(t), "global");
  check("错误类型 / Promise / Map / Set / Symbol 都识别",
    ["Error", "TypeError", "Promise", "Map", "Set", "Symbol"].every((w) => g.includes(w)), g.join("+"));
}
{
  // 运行时没有的东西不该被染成"可用"
  const t = "window.alert(1); document.title; require('fs'); process.exit(); setTimeout(f, 1);";
  const g = wordsOfKind(t, tokenize(t), "global");
  check("window/document/require/process/setTimeout **不**染成内置 API（运行时没有它们）",
    !["window", "document", "require", "process", "setTimeout"].some((w) => g.includes(w)), g.join("+"));
}
{
  const t = "Math.max; var Math2 = 1;";
  const g = wordsOfKind(t, tokenize(t), "global");
  check("Math2 不被当成 Math", !g.includes("Math2"), g.join("+"));
}

// ============================================================================
console.log("== 组合与合并 ==");
{
  const t = "var a = bwe.world.find('x'); // done";
  const tokens = tokenize(t);
  const kinds = countKinds(tokens);
  check("一个典型行里各类都有", kinds.keyword >= 1 && kinds.bwe >= 2 && kinds.string === 1 && kinds.comment === 1,
    JSON.stringify(kinds));
  // 相邻同类要合并：`var` 前后有空格所以不会合并，但 `bwe` + `.` + `world` 里
  // `.` 是 plain，所以 bwe/world 之间会有 plain 间隔 —— 这个断言验证"不误合并"
  const bweSpans = tokens.filter((x) => x.kind === "bwe");
  check("bwe 与 world 之间被 . 隔开（两个 token，不误合并）", bweSpans.length === 2, JSON.stringify(bweSpans));
  check("连续覆盖仍然成立", contiguous(t).ok, contiguous(t).why);
}
{
  // 相邻同类必须合并：`bwe.world` 与紧随其后的同类词
  const t = "bweworld";
  const b = wordsOfKind(t, tokenize(t), "bwe");
  check("bweworld 是单个标识符，不拆成 bwe+world", b.length === 0, JSON.stringify(b));
}
{
  const t = "   ";
  check("纯空白 → 没有需要着色的片段", hasHighlight(tokenize(t)) === false);
  const t2 = "// x";
  check("只有注释 → 需要着色", hasHighlight(tokenize(t2)) === true);
}

// ============================================================================
console.log("== 性能（逐键重算的可行性）==");
{
  // 造一份约 2000 行的真实体量脚本
  const block = [
    "// 一段注释：玩家移动逻辑",
    "var P_CFG = { speed: 190, half: 10 };",
    "function onUpdate(ctx, dt) {",
    "  var e = ctx.self;",
    "  if (bwe.input.pressed('Space')) {",
    "    bwe.audio.play('swing');",
    "    bwe.camera.shake(4, 0.2);",
    "  }",
    "  var n = Math.max(1, Math.round(190 * dt));",
    "  e.setPos(e.x + n, e.y);",
    "}"
  ].join("\n");
  const big = Array.from({ length: 200 }, () => block).join("\n");
  const t0 = Date.now();
  const tokens = tokenize(big);
  const ms = Date.now() - t0;
  check(`两万字符脚本着色 < 60ms（实测 ${ms}ms，逐键可接受）`, ms < 60, `${big.length} 字符 / ${tokens.length} token`);
  check("大文本仍连续覆盖", contiguous(big).ok, contiguous(big).why);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
