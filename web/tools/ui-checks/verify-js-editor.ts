/**
 * JS 编辑器纯逻辑单测（查找/替换、坐标换算、括号、大纲、移行）。
 *
 * 为什么这些必须单测而不是靠截图：
 *   · 查找偏移错一格 → 高亮盖住半个字符、替换吃掉一个字母。截图**看不出**差一格；
 *   · 重叠区间没滤 → 文本被替换成乱码，而且看不出是哪一步坏的；
 *   · 括号扫描漏跳过字符串 → 高亮跳到十万八千里外。画面正常，只是"跳错地方"；
 *   · 大纲把注释里的 function 当函数 → 大纲里一堆幽灵条目，人眼数不清哪个是真的。
 * 这四类问题的共同点是"看起来能用"，只有断言能钉住。
 *
 * 跑法（与其它 ui-checks 一致）：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-js-editor.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/js-editor.mjs
 *   node .tmp_ui/js-editor.mjs
 */
import {
  MAX_MATCHES,
  bracketPairAt,
  extractOutline,
  findMatches,
  formatMatchCount,
  matchIndexAtSelection,
  moveLine,
  nextMatchIndex,
  offsetOfLine,
  pointToOffset,
  replaceMatches,
  wordAt,
  type ViewMetrics
} from "../../src/panels/jsEditorLogic.ts";

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

/** 等宽 7.2px、行高 19px、padding 8/10 —— 与 .js-source 的实际样式一致。 */
const M: ViewMetrics = {
  lineHeight: 19,
  charWidth: 7.2,
  padTop: 8,
  padLeft: 10,
  scrollTop: 0,
  scrollLeft: 0
};

// ============================================================================
console.log("== 查找 findMatches ==");
{
  const text = "loadLevel(1); loadLevel(2);";
  const m = findMatches(text, "loadLevel");
  check("基本命中 2 处", m.length === 2, JSON.stringify(m));
  check("区间正确（start/end 与 slice 一致）", text.slice(m[0].start, m[0].end) === "loadLevel");
}
{
  check("空查询 → 空结果", findMatches("abc", "").length === 0);
  check("空文本 → 空结果", findMatches("", "a").length === 0);
}
{
  const m = findMatches("Cat cat CAT", "cat", { caseSensitive: true });
  check("区分大小写只命中 1 处", m.length === 1, JSON.stringify(m));
  const m2 = findMatches("Cat cat CAT", "cat");
  check("不区分大小写命中 3 处", m2.length === 3);
}
{
  const m = findMatches("concat cat scatter", "cat", { wholeWord: true });
  check("全词匹配不命中 concat / scatter", m.length === 1, JSON.stringify(m));
  const m2 = findMatches("bwe.world.find($el); $el", "$el", { wholeWord: true });
  check("全词匹配能命中 $el（不能用 \\b）", m2.length === 2, JSON.stringify(m2));
}
{
  const m = findMatches("a1 b2 c3", "\\d", { regex: true });
  check("正则命中 3 处", m.length === 3, JSON.stringify(m));
  check("非法正则（输入到一半）→ 空结果而不抛", findMatches("abc", "(", { regex: true }).length === 0);
  check("非法正则里的 \\ 也不会抛", findMatches("abc", "[a-", { regex: true }).length === 0);
}
{
  // 零宽命中不能死循环 —— 这一条如果坏了，整个页面会卡死
  const m = findMatches("abc\ndef", "^", { regex: true });
  check("正则 ^ 零宽命中不卡死（返回空或有限条）", m.length === 0 || m.length < 10, `len=${m.length}`);
  const m2 = findMatches("hello", "\\b", { regex: true });
  check("正则 \\b 零宽命中不卡死", m2.length === 0 || m2.length < 10, `len=${m2.length}`);
}
{
  const text = "x".repeat(MAX_MATCHES + 500);
  const m = findMatches(text, "x");
  check(`超过上限时截到 ${MAX_MATCHES}`, m.length === MAX_MATCHES, `len=${m.length}`);
  check("计数文案带 +", formatMatchCount(m) === `${MAX_MATCHES}+ 处`, formatMatchCount(m));
}
{
  check("无匹配文案", formatMatchCount([]) === "无匹配");
  check("少量匹配文案", formatMatchCount([{ start: 0, end: 1 }, { start: 2, end: 3 }]) === "2 处");
}

// ============================================================================
console.log("== 下一个命中 nextMatchIndex ==");
{
  const text = "aXaXaXa";
  const m = findMatches(text, "X");
  // 光标在 0（第一个 X 之前）→ 向下应到第 0 个
  check("光标在第一个命中之前 → 跳到它", nextMatchIndex(m, 0, true) === 0);
  // 光标在第一个命中之后（end=2）→ 向下应到第 1 个
  check("从命中末尾向后 → 下一个（不卡在原地）", nextMatchIndex(m, 2, true) === 1, `got=${nextMatchIndex(m, 2, true)}`);
  check("从最后命中之后向后 → 回绕到第 0 个", nextMatchIndex(m, text.length, true) === 0);
  check("向上：从第 1 个命中之前 → 回绕到最后一个", nextMatchIndex(m, 1, false) === m.length - 1);
  check("向上：从第 1 个命中之后 → 回到第 0 个", nextMatchIndex(m, 2, false) === 0);
  check("空命中列表 → -1", nextMatchIndex([], 0, true) === -1);
}
{
  const m = findMatches("abc abc", "abc");
  check("选区正是第一个命中 → 认出下标 0", matchIndexAtSelection(m, 0, 3) === 0);
  check("选区是第二个命中 → 认出下标 1", matchIndexAtSelection(m, 4, 7) === 1);
  check("选区不在命中上 → -1", matchIndexAtSelection(m, 1, 4) === -1);
}

// ============================================================================
console.log("== 替换 replaceMatches ==");
{
  const text = "a-b-c";
  const m = findMatches(text, "-");
  const r = replaceMatches(text, m, "_");
  check("替换全部命中", r.text === "a_b_c" && r.count === 2, JSON.stringify(r));
}
{
  const text = "x1 x2";
  const m = findMatches(text, "x");
  const r = replaceMatches(text, m, "$&!");
  check("替换串里的 $& 按字面量插入（不解释）", r.text === "$&!1 $&!2", JSON.stringify(r));
}
{
  // 重叠区间：必须滤掉，不能重复替换同一段
  const text = "abcdef";
  const r = replaceMatches(text, [{ start: 0, end: 3 }, { start: 2, end: 5 }], "Z");
  check("重叠区间只替换一次", r.text === "Zdef" && r.count === 1, JSON.stringify(r));
}
{
  const text = "abc";
  const r = replaceMatches(text, [{ start: 2, end: 99 }], "Z");
  check("越界命中被忽略（不猜）", r.text === "abc" && r.count === 0, JSON.stringify(r));
}
{
  const text = "abc";
  const r = replaceMatches(text, [{ start: 1, end: 2 }], "");
  check("替换成空串 = 删除（不是不生效）", r.text === "ac" && r.count === 1, JSON.stringify(r));
}
{
  // 命中数量大于 1 且区间乱序：必须先排序
  const text = "abcdef";
  const r = replaceMatches(text, [{ start: 4, end: 5 }, { start: 1, end: 2 }], "Z");
  check("乱序区间按位置正确拼装", r.text === "aZcdZf", JSON.stringify(r));
}

// ============================================================================
console.log("== 坐标换算 pointToOffset ==");
{
  // ⚠ 坐标是**相对 textarea 边框盒**的（不是内容区）：换算函数自己扣 padding。
  // 这条约定必须写死在测试里，否则调用方与实现各扣一次/都不扣，表现为「提示总是慢半行」。
  const text = "abc\ndef";
  check("第一行第 0 列", pointToOffset(text, 0, 0, M) === 0);
  const col2 = pointToOffset(text, M.padLeft + 7.2 * 2, 0, M);
  check("第一行第 2 列", col2 === 2, `got=${col2}`);
  const secondLine = pointToOffset(text, 0, M.padTop + 19, M);
  check("第二行第 0 列（y=padding+行高）", secondLine === 4, `got=${secondLine}`);
}
{
  // 尽量靠右但仍在行内 → 落行尾而不是下一行开头
  const text = "ab\ncd";
  const off = pointToOffset(text, M.padLeft + 7.2 * 50, 0, M);
  check("行尾之外（横向越界）→ 夹到该行末尾", off === 2, `got=${off}`);
}
{
  const text = "ab";
  check("y 超出总行数 → 夹到最后一行", pointToOffset(text, 0, 500, M) === 0, `got=${pointToOffset(text, 0, 500, M)}`);
  check("负坐标不崩", pointToOffset(text, -100, -100, M) === 0);
}
{
  // 滚动后：scrollTop 要抵掉（第 2 行的内容顶到第一行位置）
  const text = "a\nb\nc";
  const off = pointToOffset(text, 0, M.padTop, { ...M, scrollTop: 19 });
  check("滚动 1 行后 y=padding 指向第 2 行", off === 2, `got=${off}`);
}
{
  // padding：光标在 padding 区域内应是 0，而不是负
  check("padding 区域内坐标 → 0", pointToOffset("abc", 2, 2, M) === 0);
}

// ============================================================================
console.log("== 行偏移 offsetOfLine ==");
{
  const text = "ab\ncd\nef";
  check("第 1 行 = 0", offsetOfLine(text, 1) === 0);
  check("第 2 行 = 3", offsetOfLine(text, 2) === 3);
  check("第 3 行 = 6", offsetOfLine(text, 3) === 6);
  check("越界行号夹到末行", offsetOfLine(text, 99) === 6);
  check("空文本不崩", offsetOfLine("", 5) === 0);
}

// ============================================================================
console.log("== 标识符 wordAt ==");
{
  const text = "const a = bwe.world.find(q);";
  const start = text.indexOf("find");
  check("光标在词中 → 命中整词", wordAt(text, start + 1)?.word === "find");
  check("光标在词尾（右侧边缘）也算命中", wordAt(text, start + 4)?.word === "find", JSON.stringify(wordAt(text, start + 4)));
  check("空格处 → null", wordAt(text, text.indexOf(" = ") + 1) === null);
  check("$ 和 _ 是标识符字符", wordAt("$el_x", 2)?.word === "$el_x");
  check("空文本 → null", wordAt("", 0) === null);
  check("越界 offset 不崩", wordAt("ab", 999) !== undefined);
}

// ============================================================================
console.log("== 括号配对 bracketPairAt ==");
{
  const text = "f(a, (b + c), d)";
  const outer = bracketPairAt(text, 1);
  check("光标在 ( 上 → 找到配对的最后一个 )", outer?.close.start === text.length - 1, JSON.stringify(outer));
  const inner = bracketPairAt(text, 6);
  // `f(a, (b + c), d)`：内层 `(` 在 5，配对的 `)` 在 11（不是 12，12 是逗号）
  check("内层括号不会串到外层", inner?.close.start === 11, JSON.stringify(inner));
}
{
  // 字符串里的括号不能参与配对
  const text = 'f(")")';
  const pair = bracketPairAt(text, 1);
  check("字符串里的 ) 被跳过", pair?.close.start === 5, JSON.stringify(pair));
}
{
  const text = "{\n  // }\n  a: 1\n}";
  const pair = bracketPairAt(text, 0);
  check("行注释里的 } 被跳过", pair?.close.start === text.length - 1, JSON.stringify(pair));
}
{
  // 反向扫描时**不**跳注释与字符串（这是有意接受的近似，见 jsEditorLogic 里 skipNonCode 的注释）。
  // 所以这里断言的是**不变式**而不是具体结果：要么不配对，要么配出来的确实是括号字符。
  // 这条断言的作用是防止"配到字母上"这种一眼看不出的错位高亮。
  const text = "a /* ) */ b)";
  const pair = bracketPairAt(text, text.length - 1);
  const sane = pair === null || (text[pair.open.start] === "(" && text[pair.close.start] === ")");
  check("反向扫描要么不配对、要么配到的确实是括号字符", sane, JSON.stringify(pair));
}
{
  check("没有配对的括号 → null", bracketPairAt("f(a", 1) === null);
  check("光标不在括号上 → null", bracketPairAt("abc", 1) === null);
  check("空文本 → null", bracketPairAt("", 0) === null);
}
{
  // 光标在括号**右边一格**也要能配对（用户点不准是常态）
  const text = "x(y)";
  check("光标紧邻括号右侧 → 仍然配对", bracketPairAt(text, 2)?.close.start === 3, JSON.stringify(bracketPairAt(text, 2)));
}

// ============================================================================
console.log("== 大纲 extractOutline ==");
{
  const src = [
    "// ===== 玩家控制 =====",
    "let speed = 120;",
    "function onStart(ctx) {",
    "}",
    "function onUpdate(ctx, dt) {",
    "  const tmp = 1;",
    "}",
    "const helper = (n) => n + 1;",
    "class Foo {}"
  ].join("\n");
  const items = extractOutline(src);
  const labels = items.map((i) => `${i.kind}:${i.label}`);
  check("生命周期排在最前", items[0]?.kind === "lifecycle" && items[0]?.label === "onStart", labels.join("|"));
  check("抽出普通函数", labels.includes("function:helper") || labels.includes("function:onUpdate"), labels.join("|"));
  check("抽出顶层变量", labels.includes("variable:speed"), labels.join("|"));
  check("抽出类", labels.includes("class:Foo"), labels.join("|"));
  check("抽出分节注释", labels.includes("section:玩家控制"), labels.join("|"));
  check("块内临时变量不进大纲（depth>0）", !labels.includes("variable:tmp"), labels.join("|"));
}
{
  const src = "// function fake() {}\n/* function alsoFake() {} */\nfunction real() {}";
  const items = extractOutline(src);
  check("注释里的 function 不算（行注释）", !items.some((i) => i.label === "fake"), items.map((i) => i.label).join("|"));
  check("注释里的 function 不算（块注释）", !items.some((i) => i.label === "alsoFake"));
  check("真函数仍在", items.some((i) => i.label === "real"));
}
{
  const src = "/*\nfunction ghost() {}\n*/\nfunction real() {}";
  const items = extractOutline(src);
  check("跨行块注释里的 function 不算", !items.some((i) => i.label === "ghost"), items.map((i) => i.label).join("|"));
}
{
  check("空脚本 → 空大纲", extractOutline("").length === 0);
  check("只有注释 → 空大纲", extractOutline("// hi\n// there").length === 0);
}
{
  const src = "async function load() {}\nexport function save() {}";
  const items = extractOutline(src).map((i) => i.label);
  check("抽 async 函数", items.includes("load"), items.join("|"));
  check("抽 export 函数", items.includes("save"), items.join("|"));
}
{
  // 行列：点的位置要能精准落到名字上
  const src = "  function inner() {}";
  const it = extractOutline(src).find((x) => x.label === "inner");
  check("col 指向名字（不是行首）", it?.col === 12, JSON.stringify(it));
  check("line 从 1 起", it?.line === 1);
}

// ============================================================================
console.log("== 整行移动 moveLine ==");
{
  const text = "a\nb\nc";
  const down = moveLine(text, 0, 1);
  check("首行下移", down?.text === "b\na\nc", JSON.stringify(down));
  check("下移后光标跟到新行同一列", down?.caret === 2, JSON.stringify(down));
}
{
  const text = "a\nb\nc";
  const up = moveLine(text, 4, -1);
  check("末行上移", up?.text === "a\nc\nb", JSON.stringify(up));
}
{
  const text = "a\nb";
  check("首行继续上移 → null（不吃按键）", moveLine(text, 0, -1) === null);
  check("末行继续下移 → null", moveLine(text, 3, 1) === null);
}
{
  const text = "long line\nx";
  const down = moveLine(text, 5, 1);
  check("短行缺列时夹到行尾（不越界）", down !== null && down.caret <= down.text.length, JSON.stringify(down));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
