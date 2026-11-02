/**
 * 补全弹层的纯逻辑单测。
 *
 * 为什么这些必须单测而不是靠截图：
 *   · 光标定位算错 → 弹层位置偏。截图能看出"位置不对"，但**看不出"该在哪"**；
 *   · Enter 按键分派错 → 插入补全 + 换行。截图**完全看不出来**（画面正常，只是多了一个空行）。
 * 这两类都是"看起来能用、实际用起来难受"的问题，只有断言能钉住。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-script-complete.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/verify-complete.mjs
 *   node .tmp_ui/verify-complete.mjs
 */
import {
  caretToPx,
  resolveKey,
  shouldAutoTrigger,
  completionPrefix,
  type CaretMetrics
} from "../../src/panels/scriptCompleteLogic.ts";

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

// 等宽 8px、行高 19px 的常见配置
const M: CaretMetrics = {
  contentWidth: 800,
  contentHeight: 400,
  scrollTop: 0,
  scrollLeft: 0,
  lineHeight: 19,
  charWidth: 8,
  tabSize: 2
};

console.log("== 光标定位 caretToPx ==");
{
  const r = caretToPx("", 0, M);
  check("空文本 → (0,0)", r.x === 0 && r.y === 0, JSON.stringify(r));
}
{
  const text = "abcd";
  const r = caretToPx(text, 2, M);
  check("第 1 行第 2 列 → x=16,y=0", r.x === 16 && r.y === 0, JSON.stringify(r));
}
{
  const text = "abc\ndef";
  const r = caretToPx(text, 5, M); // 在第 2 行第 1 列（d 之后）
  check("第 2 行 → y=19", r.y === 19, `y=${r.y}`);
  check("第 2 行首字符后 → x=8", r.x === 8, `x=${r.x}`);
}
{
  const r = caretToPx("abc\ndef\nghi", 9, M); // 第 3 行第 1 列
  check("第 3 行 → y=38", r.y === 38, `y=${r.y}`);
}
{
  // tab 按 tabSize 折算：一个 tab = 8*2 = 16px
  const r = caretToPx("\tx", 1, M);
  check("tab 宽度 = charWidth × tabSize", r.x === 16, `x=${r.x}`);
}
{
  // 滚动后纵向要减 scrollTop
  const r = caretToPx("a\nb", 3, { ...M, scrollTop: 19 });
  check(
    "滚动 1 行后 y 减 scrollTop 并夹到 0",
    r.y === 0,
    `y=${r.y}（第2行本该 19-19=0）`
  );
}
{
  // 横向超出可视宽度 → 夹到 contentWidth-1（否则弹层跑出编辑器）
  const long = "x".repeat(200);
  const r = caretToPx(long, 200, M);
  check("横向超宽 → 夹到 contentWidth-1", r.x === M.contentWidth - 1, `x=${r.x}`);
}
{
  // 光标在屏幕外（纵向）→ 夹到可见范围
  const many = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n");
  const r = caretToPx(many, many.length, { ...M, scrollTop: 0, contentHeight: 100 });
  check("纵向超出可视高度 → 夹进可见区", r.y <= M.contentHeight - M.lineHeight, `y=${r.y}`);
}
{
  // offset 越界要安全
  const r = caretToPx("ab", 99, M);
  check("offset 超出文本长度 → 不崩且落在末尾", r.x >= 0 && r.y >= 0, JSON.stringify(r));
}

console.log("== 按键分派 resolveKey ==");
{
  const d = resolveKey("Enter", true, 5);
  check("弹层开 + Enter → insert 且必须 preventDefault", d.action === "insert" && d.preventDefault, JSON.stringify(d));
  check("弹层开 + Enter → 必须 stopPropagation", d.stopPropagation, JSON.stringify(d));
}
{
  const d = resolveKey("Enter", false, 5);
  check("弹层关 + Enter → 不拦截（走原生换行）", d.action === "ignore" && !d.preventDefault, JSON.stringify(d));
}
{
  const d = resolveKey("Tab", true, 5);
  check("弹层开 + Tab → insert 且 preventDefault（否则焦点会跳走）", d.action === "insert" && d.preventDefault, JSON.stringify(d));
}
{
  const d = resolveKey("Tab", true, 0);
  check("弹层开但无候选 + Tab → 不拦截", d.action === "ignore" && !d.preventDefault, JSON.stringify(d));
}
{
  const d = resolveKey("Enter", true, 0);
  check("弹层开但无候选 + Enter → 不拦截（否则用户以为换行坏了）", !d.preventDefault, JSON.stringify(d));
}
{
  check("Esc 关闭并拦截", resolveKey("Escape", true, 3).action === "close" && resolveKey("Escape", true, 3).preventDefault);
  check("↑ 上移并拦截", resolveKey("ArrowUp", true, 3).action === "move-up" && resolveKey("ArrowUp", true, 3).preventDefault);
  check("↓ 下移并拦截", resolveKey("ArrowDown", true, 3).action === "move-down" && resolveKey("ArrowDown", true, 3).preventDefault);
  const d = resolveKey("ArrowDown", false, 3);
  check("弹层关 + ↓ → 不拦截（正常移光标）", !d.preventDefault, JSON.stringify(d));
}
{
  const d = resolveKey("a", true, 5);
  check("普通字母 → 不拦截（交给 textarea 继续输入）", d.action === "ignore" && !d.preventDefault, JSON.stringify(d));
}
{
  const d = resolveKey("Backspace", true, 5);
  check("退格 → 不拦截", !d.preventDefault);
}

console.log("== 自动触发判定 shouldAutoTrigger ==");
{
  check("`bwe.` 后 → 触发", shouldAutoTrigger("bwe.", 4));
  check("`bwe.world.` 后 → 触发", shouldAutoTrigger("bwe.world.", 10));
  check("`bwe.world.fi` 打字中 → 触发", shouldAutoTrigger("bwe.world.fi", 12));
  check("普通打字 `cons` → 不触发", !shouldAutoTrigger("cons", 4));
  check("小数 `1.` → 不触发", !shouldAutoTrigger("1.", 2));
  check("`foo.bwe.` → 不触发（不在 bwe 链上）", !shouldAutoTrigger("foo.bwe.", 8));
  check("`obj.` → 不触发", !shouldAutoTrigger("obj.", 4));
  check("空文本 → 不触发", !shouldAutoTrigger("", 0));
  check("`ctx.` → 不触发（ctx 不是 bwe 命名空间）", !shouldAutoTrigger("ctx.", 4));
}
{
  // 多级链：bwe.world.find(...)
  check("`bwe.world.ent` → 触发", shouldAutoTrigger("bwe.world.ent", 13));
  check("`bwe.world.entities.x` 之后的字母 → 触发", shouldAutoTrigger("bwe.world.entities.xy", 20));
}

console.log("== 补全前缀 completionPrefix ==");
{
  const r = completionPrefix("bwe.world.fi", 12);
  check("取出前缀 fi 与起点", r.prefix === "fi" && r.start === 10, JSON.stringify(r));
}
{
  const r = completionPrefix("bwe.", 4);
  check("点号后前缀为空", r.prefix === "" && r.start === 4, JSON.stringify(r));
}
{
  const src = "var x = 1; bwe.world.en";
  const r = completionPrefix(src, src.length);
  check("多 token 前只取最后一个词", r.prefix === "en" && r.start === src.length - 2, JSON.stringify(r));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
