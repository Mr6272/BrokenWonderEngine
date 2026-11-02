/**
 * 脚本补全弹层的**纯逻辑**（不碰 DOM，可单测）。
 *
 * 为什么单独抽：这块最容易做歪，而且错了很难靠截图发现 ——
 *   · 光标定位算错 → 弹层出现在错误位置（截图能看出"位置不对"，但看不出"该在哪"）；
 *   · 按键分派错 → Enter 变成"插入补全 + 换行"（用户得到半截代码 + 一个空行，
 *     这种错只能靠交互发现，截图完全看不出来）。
 * 所以这两个函数都做成纯函数，用单测钉死。
 */

// ============================================================================
// 1. 光标 → 像素坐标
// ============================================================================

export interface CaretPos {
  /** 相对 textarea 内容区左上角的像素坐标 */
  x: number;
  y: number;
  /** 光标所在行高（弹层按这个对齐，不会压住正在编辑的那行） */
  lineHeight: number;
}

export interface CaretMetrics {
  /** 纯文本内容区宽度（不含 border/padding），用于横向夹紧 */
  contentWidth: number;
  /** 纯文本内容区高度 */
  contentHeight: number;
  /** 当前滚动位置 */
  scrollTop: number;
  scrollLeft: number;
  /** 行高（px） */
  lineHeight: number;
  /** 字符宽度（等宽字体下用单值近似；用测量法时可传每个字符的实际宽度） */
  charWidth: number;
  /** tab 宽度（按几个字符算） */
  tabSize: number;
}

/**
 * 计算光标在 textarea 里的像素坐标。
 *
 * 做法（不用隐藏 div 测量法，因为那需要把整段文本再排一次版，长脚本很慢，
 * 而且测量 div 的换行规则必须和 textarea 完全一致 —— 那是个持续的维护负担）：
 *   · 纵向：行号 × 行高 − scrollTop。等宽字体 + `white-space: pre` 下这是精确的；
 *   · 横向：把光标所在行**之前**的字符宽度累加（tab 按 tabSize 折算）− scrollLeft。
 *     只算当前行，所以代价是 O(行宽) 而不是 O(全文)。
 *
 * 边界：
 *   · 空行 x=0；
 *   · 结果夹在 [0, contentWidth/Height] 内 —— 否则当光标在屏幕外（滚动后）
 *     弹层会跑出编辑器可见区。
 */
export function caretToPx(
  text: string,
  offset: number,
  m: CaretMetrics
): CaretPos {
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, text.length));
  const before = text.slice(0, safeOffset);
  const lines = before.split("\n");
  const lineIndex = lines.length - 1;           // 0 起
  const currentLine = lines[lineIndex] ?? "";

  // 横向宽度：累加当前行每个字符（tab 按 tabSize 折）
  let width = 0;
  for (const ch of currentLine) {
    width += ch === "\t" ? m.charWidth * m.tabSize : m.charWidth;
  }

  const rawY = lineIndex * m.lineHeight - m.scrollTop;
  const rawX = width - m.scrollLeft;

  const x = Math.max(0, Math.min(rawX, Math.max(0, m.contentWidth - 1)));
  const y = Math.max(0, Math.min(rawY, Math.max(0, m.contentHeight - m.lineHeight)));
  return { x, y, lineHeight: m.lineHeight };
}

// ============================================================================
// 2. 弹层打开时的按键分派
// ============================================================================

export type KeyAction = "insert" | "move-up" | "move-down" | "close" | "ignore";

export interface KeyDecision {
  action: KeyAction;
  /** 必须 preventDefault（否则 Enter 会换行、Tab 会失焦、方向键会移动光标） */
  preventDefault: boolean;
  /** 必须 stopPropagation（textarea 自己的 keydown 监听器可能也会处理同一个键） */
  stopPropagation: boolean;
}

/**
 * 弹层打开时该对某个键做什么。
 *
 * ⚠ 这是「必须」不是「建议」：
 *   · Enter 不 preventDefault → **插入补全 + 换行 + 光标到下一行**，
 *     用户得到一个空行还得手动删；
 *   · Tab 不 preventDefault → textarea 默认行为是**焦点跳到下一个元素**，
 *     用户突然发现光标跑了（这个体验问题截图完全看不出来）；
 *   · ↑↓ 不 preventDefault → 光标在文本里上下移动，而弹层选中项没变，两边不同步；
 *   · Esc 不 preventDefault → 某些环境会触发外层快捷（例如退出全屏）。
 *
 * @param key       KeyboardEvent.key
 * @param open      弹层是否打开
 * @param itemCount 候选数量（0 时 Enter/Tab 不应"确认"一个不存在的项）
 */
export function resolveKey(key: string, open: boolean, itemCount: number): KeyDecision {
  const no: KeyDecision = { action: "ignore", preventDefault: false, stopPropagation: false };
  if (!open) return no;

  switch (key) {
    case "Enter":
    case "Tab":
      // 没有候选项时不要吞掉 Enter（否则用户以为换行坏了）
      if (itemCount <= 0) return no;
      return { action: "insert", preventDefault: true, stopPropagation: true };
    case "Escape":
      return { action: "close", preventDefault: true, stopPropagation: true };
    case "ArrowUp":
      if (itemCount <= 0) return no;
      return { action: "move-up", preventDefault: true, stopPropagation: true };
    case "ArrowDown":
      if (itemCount <= 0) return no;
      return { action: "move-down", preventDefault: true, stopPropagation: true };
    default:
      // 其它键（字母、退格…）交给 textarea 正常处理，弹层内容随后由 input 事件更新
      return no;
  }
}

// ============================================================================
// 3. 触发判定：什么时候该弹补全
// ============================================================================

export type TriggerKind = "auto-member" | "manual";

/**
 * 判断当前是否该自动触发补全。
 *
 * 只在两种情形自动弹（全文都弹会很吵）：
 *   1. 光标前一个字符是 `.`（成员访问，例如 `bwe.` / `bwe.world.`）；
 *   2. 光标前是 `bwe.` 或 `bwe.xxx.` 之后正在打字母（也就是"在 bwe 成员链上打字"）。
 *
 * 其它情况（普通打字、注释里、字符串里）一律不自动弹，只能 Ctrl+Space 手动。
 *
 * @param text    全文
 * @param offset  光标位置
 */
export function shouldAutoTrigger(text: string, offset: number): boolean {
  const i = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, i);
  if (!before) return false;

  // 情形 1：刚打了点号（`bwe.` / `bwe.world.`）
  if (before.endsWith(".")) {
    // 排除小数 `1.`
    const prev = before.slice(-2, -1);
    if (prev && /[0-9]/.test(prev)) return false;
    return isBweChain(before.slice(0, -1));
  }

  // 情形 2：在 bwe 成员链上继续打字母（`bwe.world.fi`、`bwe.world.ent`）
  //
  // ⚠ 关键：先把**光标处的整个词**连同它前面的点一起回退掉，再看剩下的部分。
  //   第一版只回退了"词"，没有回退点号，于是 `bwe.world.fi` 剩下的 `bwe.world`
  //   不以 "." 结尾 → 判定失败（4 条用例红了）。单测当场抓出来的。
  const m = /[A-Za-z0-9_$]*$/.exec(before);
  const wordLen = m ? m[0].length : 0;
  const chainPart = before.slice(0, i - wordLen);   // 形如 "bwe.world."
  if (!chainPart.endsWith(".")) return false;
  return isBweChain(chainPart.slice(0, -1));
}

/**
 * 判断一段文本（去掉末尾点号后）是否属于 `bwe` 成员链。
 *
 * 接受 `bwe`、`bwe.world`、`bwe.world.xxx`…
 * 不接受 `foo.bwe`（点号前还有别的东西）、`obj` 这类非 bwe 链。
 */
function isBweChain(s: string): boolean {
  return /^bwe(?:\.[A-Za-z_$][\w$]*)*$/.test(s);
}

/**
 * 从 text/offset 取出「当前正在补全的前缀」，用于本地过滤与服务端参数。
 * 返回 { prefix, start }（start 是从哪里开始替换）。
 */
export function completionPrefix(text: string, offset: number): { prefix: string; start: number } {
  const i = Math.max(0, Math.min(offset, text.length));
  // 允许前缀里带点：`bwe.world.fi` 的成员访问，替换时应只替换最后一个词 `fi`，
  // 而不是整条 `bwe.world.fi`（否则插入后会变成 `bwe.world.bwe.world.find`）。
  // 所以这里只取**最后一段**标识符。
  const m = /[A-Za-z0-9_$]+$/.exec(text.slice(0, i));
  const prefix = m ? m[0] : "";
  return { prefix, start: i - prefix.length };
}
