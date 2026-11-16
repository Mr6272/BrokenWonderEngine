/**
 * 编辑器覆盖层：**语法着色** + 搜索命中底色 + 括号配对 + 当前行高亮。
 *
 * ── 结构（为什么是这个形状）──────────────────────────────────────────
 *
 *   .js-code                          ← 定位父级（position:relative）
 *   ├─ .js-gutter                     ← 行号栏（flex 兄弟）
 *   └─ .js-edit                       ← 与 textarea 同原点（relative）
 *      ├─ textarea.js-source          ← 只负责输入/光标（文字透明，caret 可见）
 *      └─ .js-hl                      ← 显示**所有文字**（彩色）+ 各种底色
 *
 * 上一版把 `.js-hl` 直接挂在 `.js-code` 上、与 textarea 是**跨行号栏的兄弟**，
 * 于是覆盖层原点比 textarea 少了一个行号栏宽度 —— 实测水平偏 40px、垂直偏 6px，
 * 而"padding/font-size/line-height 六项属性全同"的断言是**绿的**（属性相同 ≠ 原点相同）。
 * 这是本次用像素级探针（desktop/tools/probes/overlay-align.probe.js）抓出来的。
 * 现在两者是同一个 `.js-edit` 的子项，原点天然一致，且验收里有 deltaX/deltaY ≈ 0 的断言。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────
 *   1. **排版度量必须与 .js-source 逐项相同**（12px / 19px / padding 8px 10px / pre / tab-size 2）。
 *      任何一侧改字号或行高，另一侧必须同步 —— 否则文字整体错位一行。
 *      验收里有真实 Chromium 的逐项比对。
 *   2. **textarea 的文字必须透明**，否则会和覆盖层叠成"重影"（两份文字差半像素）。
 *      但 `caret-color` 必须保持可见，否则用户看不到光标。
 *   3. **输入法组字期间必须切回"textarea 显示文字"**：中文输入法打拼音时，
 *      组字串在 textarea 里而覆盖层还没更新 —— 文字透明就等于"看不见自己在打什么"。
 *      所以编辑器在 compositionstart/end 时给 `.js-edit` 加/去 `composing` 类。
 */

import { el, escapeHtml } from "../core/dom.ts";
import type { Match } from "./jsEditorLogic.ts";
import { countKinds, tokenize, type TokenKind } from "./jsTokenizer.ts";

/** 一次最多画多少个搜索命中/括号标记。超出部分只影响"看得见"，不影响查找替换的正确性。 */
const MAX_RENDER_MARKS = 600;

/** kind → CSS 类名（见 web/styles/js-editor.css 的 .tk-* 规则）。plain 不加类。 */
const KIND_CLASS: Record<Exclude<TokenKind, "plain">, string> = {
  comment: "tk-comment",
  string: "tk-string",
  number: "tk-number",
  keyword: "tk-keyword",
  bwe: "tk-bwe",
  global: "tk-global"
};

export interface OverlayState {
  text: string;
  /** 搜索命中（空数组 = 没在查找） */
  matches: Match[];
  /** 当前命中下标（-1 = 无） */
  currentIndex: number;
  /** 括号配对的两个区间 */
  bracket: Match[];
  /** 当前行号（0 起，-1 = 不高亮）；用于"当前行"底色 */
  activeLine: number;
  /** 是否开启语法着色 */
  syntax: boolean;
}

export interface HighlightOverlay {
  update(state: OverlayState): void;
  /** 只做滚动平移（滚动时每帧调用，不重排内容） */
  syncScroll(scrollTop: number, scrollLeft: number): void;
  /** 换主题后重画（颜色来自 CSS 变量，内容不用变，但当前行底色需要） */
  destroy(): void;
  /** 着色统计（验收/排查用：确认某个词真的被染上了） */
  stats(): { tokens: number; kinds: Record<TokenKind, number> };
}

export function createHighlightOverlay(host: HTMLElement): HighlightOverlay {
  const layer = el("div", { class: "js-hl" });
  // 内层只做滚动平移；外层负责裁剪（overflow:hidden）与定位
  const inner = el("div");
  inner.className = "js-hl-inner";
  layer.appendChild(inner);
  host.appendChild(layer);

  let lastText = "";
  let lastKey = "";
  let lastKinds: Record<TokenKind, number> = countKinds([]);
  let lastTokens = 0;

  const stats = (): { tokens: number; kinds: Record<TokenKind, number> } => ({
    tokens: lastTokens,
    kinds: lastKinds
  });

  /**
   * 把「着色片段」与「装饰区间（搜索命中 / 括号 / 当前行）」合成一棵 DOM。
   *
   * 为什么用**两层区间合并**而不是"先染语法、再用 innerHTML 替换搜索词"：
   *   后者要对已经拼好的 HTML 做字符串替换，一旦搜索词里有 `<` `&` 等字符就会破坏结构，
   *   而且会重复转义（转义两次 → 用户看到 `&amp;lt;`）。合成一棵树只有一次 escapeHtml。
   */
  const update = (state: OverlayState): void => {
    const { text, matches, currentIndex, bracket, activeLine, syntax } = state;
    const matchKey = matches.length
      ? `${matches.length}/${currentIndex}/${matches[0]?.start}/${matches[matches.length - 1]?.end}`
      : "";
    const bracketKey = bracket.map((b) => b.start).join(",");
    const key = `${matchKey}|${bracketKey}|${activeLine}|${syntax ? 1 : 0}`;

    // 内容 + 装饰都没变就不重排。滚动时每帧都会调到这里，重排两万字符是几毫秒，
    // 而滚动是每帧都要的 —— 不短路会把滚动拖成幻灯片。
    if (text === lastText && key === lastKey) return;
    lastText = text;
    lastKey = key;

    // ---- 1. 语法片段 ----
    const tokens = syntax ? tokenize(text) : [{ start: 0, end: text.length, kind: "plain" as TokenKind }];
    lastKinds = countKinds(tokens);
    lastTokens = tokens.length;

    // ---- 2. 装饰区间 → 按字符位置索引的"区间边界表" ----
    //
    // 做法：把每个要装饰的区间拆成 start/end 两个事件，然后**沿 token 边走边累积**，
    // 保证输出顺序严格与原文一致。直观写法（把 token 与装饰各排序后归并）也可以，
    // 但装饰区间可能与 token 任意交叉（搜索词横跨字符串与代码），
    // 用"边界事件 + 单遍遍历"能一次成型，不会漏掉任何一种交叉组合。
    // `off` 会写进 data-off：它是「这段文字在全文里的起始偏移」。
    // 为什么要有它：验收要断言"高亮位置 == 文字位置"，而验收脚本拿不到内部 token 列表，
    // 只能靠 indexOf 反推 —— 同一个词出现多次时 indexOf 永远返回第一次，
    // 于是断言会对着第二个命中比较第一个的位置（假的 89px 偏移）。
    // 有了 data-off，位置断言从"猜"变成"读"。
    type Deco = { start: number; end: number; cls: string; off?: number };
    const decos: Deco[] = [];
    const shown = Math.min(matches.length, MAX_RENDER_MARKS);
    for (let i = 0; i < shown; i++) {
      const m = matches[i];
      decos.push({ start: m.start, end: m.end, cls: i === currentIndex ? "js-mark current" : "js-mark", off: m.start });
    }
    for (const b of bracket) decos.push({ start: b.start, end: b.end, cls: "js-hl-bracket" });
    // 当前行：整行一个底色块（含行尾，视觉上是一条连续横条）
    if (activeLine >= 0) {
      const lineStart = lineStartOffset(text, activeLine);
      if (lineStart >= 0) {
        const lineEnd = text.indexOf("\n", lineStart);
        decos.push({ start: lineStart, end: lineEnd === -1 ? text.length : lineEnd, cls: "js-line" });
      }
    }

    // 边界表：pos → 该位置开始/结束的装饰编号
    const starts = new Map<number, Deco[]>();
    const ends = new Map<number, Deco[]>();
    for (const d of decos) {
      const s = Math.max(0, Math.min(d.start, text.length));
      const e = Math.max(s, Math.min(d.end, text.length));
      if (e <= s) continue;
      (starts.get(s) ?? starts.set(s, []).get(s)!).push(d);
      (ends.get(e) ?? ends.set(e, []).get(e)!).push(d);
    }

    const parts: string[] = [];
    const open = new Set<Deco>();
    let pos = 0;
    /** 把 [from,to) 这一段输出：先按 token 分类，再套上当前打开的全部装饰。 */
    const emit = (from: number, to: number): void => {
      // 装饰带 off 时（搜索命中），把本段的**绝对偏移**写进 data-off，
      // 供验收脚本/排查工具直接读取真实位置，而不必反推。
      let offAttr = "";
      if (to <= from) return;
      // 找出覆盖这一段的 token（token 覆盖全文且不重叠，所以最多 1 个）
      let kind: TokenKind = "plain";
      for (const t of tokens) {
        if (from >= t.start && from < t.end) {
          kind = t.kind;
          break;
        }
      }
      const raw = escapeHtml(text.slice(from, to));
      const tkCls = kind === "plain" ? "" : KIND_CLASS[kind as Exclude<TokenKind, "plain">];
      // 装饰按"最内层最后开"的顺序包裹：外层是行底色，内层是命中/括号。
      // 顺序固定（line → mark → bracket）避免同类装饰互相嵌套出怪色。
      const decoCls = Array.from(open)
        .map((d) => d.cls)
        .sort((a, b) => decoOrder(a) - decoOrder(b));
      const allCls = [tkCls, ...decoCls].filter(Boolean).join(" ");
      for (const d of open) if (d.off !== undefined && d.start === from) offAttr = ` data-off="${from}"`;
      parts.push(allCls ? `<span class="${allCls}"${offAttr}>${raw}</span>` : raw);
    };

    // ---- 3. 单遍遍历：在装饰边界处切片 ----
    //
    // 所有边界（装饰 start/end）与文本末尾构成切点；相邻切点之间是"装饰状态不变"的一段。
    // token 的边界不参与切分 —— 一段里若跨了两个 token，emit 会按 from 处的 token 染色，
    // 这会错色。所以下面先把切点按 token 边界也补一遍。
    const cuts = new Set<number>([0, text.length]);
    for (const d of decos) {
      cuts.add(Math.max(0, Math.min(d.start, text.length)));
      cuts.add(Math.max(0, Math.min(d.end, text.length)));
    }
    if (syntax) for (const t of tokens) cuts.add(t.start);
    const points = Array.from(cuts).sort((a, b) => a - b);

    for (const p of points) {
      if (p > pos) emit(pos, p);
      // 先关后开：同一位置既有结束又有开始时，结束的要先生效（避免装饰"多留一格"）
      for (const d of ends.get(p) ?? []) open.delete(d);
      for (const d of starts.get(p) ?? []) open.add(d);
      pos = p;
    }
    if (pos < text.length) emit(pos, text.length);

    // 末尾补一个换行：`<div>` 末尾的空行在 HTML 里会被折叠，补一个字符让最后一行高度正确
    inner.innerHTML = parts.join("") + "\n";
    layer.style.display = "";
  };

  const syncScroll = (scrollTop: number, scrollLeft: number): void => {
    // 内层绝对定位在 padding box 原点，所以只需反向平移滚动量。
    // 用 transform 而不是改 top/left：transform 走合成层，滚动时不触发重排。
    inner.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
  };

  return {
    update,
    syncScroll,
    stats,
    destroy: () => layer.remove()
  };
}

/** 装饰的绘制顺序：行底色最外，命中其次，括号最内。 */
function decoOrder(cls: string): number {
  if (cls.startsWith("js-line")) return 0;
  if (cls.startsWith("js-mark")) return 1;
  if (cls.startsWith("js-hl-bracket")) return 2;
  return 3;
}

/** 第 line 行（0 起）的起始偏移；越界返回 -1。 */
function lineStartOffset(text: string, line: number): number {
  if (line < 0) return -1;
  let cur = 0;
  let off = 0;
  for (let i = 0; i < text.length; i++) {
    if (cur === line) return off;
    if (text[i] === "\n") {
      cur++;
      off = i + 1;
    }
  }
  return cur === line ? off : -1;
}

/**
 * 量一个字符的宽度（等宽字体下用 `0` 的宽度，比取平均值准且不会随内容抖动）。
 *
 * 为什么不用 `getComputedStyle().fontSize` 估算：`var(--mono)` 可能落到 Cascadia Mono /
 * Consolas / 系统等宽，三者的 0 宽与字号不是线性可推的（Consolas 是 0.55em，Cascadia 是 0.6em），
 * 估出来会差 8%，几百列之后就是整行的错位 —— 悬停提示会指到别的词上。
 */
export function measureCharWidth(ta: HTMLTextAreaElement): number {
  const cs = getComputedStyle(ta);
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(10);
  probe.style.cssText =
    "position:absolute;left:-9999px;top:0;white-space:pre;"
    + `font-family:${cs.fontFamily};font-size:${cs.fontSize};letter-spacing:${cs.letterSpacing};`;
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return Number.isFinite(w) && w > 0 ? w : 7.2;
}
