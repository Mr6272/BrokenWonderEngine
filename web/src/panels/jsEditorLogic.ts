/**
 * JS 编辑器的**纯逻辑**（不碰 DOM，可单测）。
 *
 * 为什么单独抽这一层：编辑器里最容易「看起来能用、实际用起来错位」的六件事都在这里 ——
 *   ① 查找匹配的偏移     算错一格 → 高亮盖住半个字符、替换吃掉一个字母；
 *   ② 下一个/上一个命中  算错方向 → 按 Enter 卡在同一个位置不动；
 *   ③ 整块替换            重叠区间没滤 → 文本被替换成乱码（而且很难看出是从哪一步坏的）；
 *   ④ 光标 ↦ 文本偏移     行列换算差 1 → 悬停提示永远慢一个符号，看着像"后端不准"；
 *   ⑤ 括号配对            跳过字符串/注释时漏判 → 括号高亮跳到十万八千里外的另一个括号；
 *   ⑥ 大纲提取            把注释里的 "function" 当成函数 → 大纲里出现一堆幽灵条目。
 *
 * 这六条都无法靠截图验收（画面看着都正常），所以全部做成纯函数 + 单测钉死。
 * 单测在 web/tools/ui-checks/verify-js-editor.ts。
 */

// ============================================================================
// 1. 查找 / 替换
// ============================================================================

export interface FindOptions {
  /** 区分大小写 */
  caseSensitive?: boolean;
  /** 全词匹配：`cat` 不会命中 `concat` */
  wholeWord?: boolean;
  /** 把查询词按正则解释（非法正则 → 当作没有匹配，绝不抛出去炸掉编辑器） */
  regex?: boolean;
}

/** 文本里的一个命中区间。`end` 是**开区间**（与 String.slice 一致）。 */
export interface Match {
  start: number;
  end: number;
}

/**
 * 命中数上限。
 *
 * 为什么要上限：用户把查询词写成 `.`（正则）+ 打开「正则」后，两万行的脚本会产生
 * 十几万个零宽/一字符命中，全部渲染成 `<mark>` 会让编辑器卡住好几秒 ——
 * 那不是"慢"，是"打字打不进去"。到上限就停，并在计数里显示 `20000+`。
 */
export const MAX_MATCHES = 20000;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 在 text 里找所有命中。
 *
 * 边界（都对应一次真实的失败）：
 *   · 空前缀/空文本 → `[]`（不是「全文一个零宽命中」）；
 *   · 非法正则 → `[]`。用户在输入框里打正则是一步步打出来的，中途 `(` 必然非法，
 *     这时候弹一个红条打断他打字，等于让"正在输入"变成"报错"；
 *   · 零宽命中（`^` / `\b`）必须手动推进 lastIndex，否则 while 循环会永远转下去（页面直接卡死）。
 */
export function findMatches(text: string, query: string, opts: FindOptions = {}): Match[] {
  const src = String(text ?? "");
  const q = String(query ?? "");
  if (!src || !q) return [];

  const flags = "g" + (opts.caseSensitive ? "" : "i");
  let re: RegExp;
  try {
    // 全词用 lookaround 而不是 \b：`bwe.world.find` 里的 `$` `_` 不是 \w，
    // 用 \b 会让 `$el` 这类标识符永远匹配不上。
    const body = opts.regex
      ? (opts.wholeWord ? `(?<![\\w$])(?:${q})(?![\\w$])` : q)
      : (opts.wholeWord ? `(?<![\\w$])${escapeRe(q)}(?![\\w$])` : escapeRe(q));
    re = new RegExp(body, flags);
  } catch {
    return [];
  }

  const out: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[0].length === 0) {
      // 零宽命中：不推进就会死循环；推到最后就收工
      re.lastIndex += 1;
      if (re.lastIndex > src.length) break;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

/** 命中数超过上限时给用户看 `20000+`，而不是让他以为只有两万条。 */
export function formatMatchCount(matches: Match[]): string {
  if (!matches.length) return "无匹配";
  return matches.length >= MAX_MATCHES ? `${MAX_MATCHES}+ 处` : `${matches.length} 处`;
}

/**
 * 下一次/上一次该跳到第几个命中。
 *
 * 语义按 VS Code 来：
 *   · 向下 = 第一个 `start >= caret`（caret 通常是当前命中的末尾，正好跳到下一个）；
 *   · 向上 = 最后一个 `end <= caret`；
 *   · 都没有就回绕（用户按到末尾继续按，应该回到第一个，而不是"没反应"）。
 *
 * @param caret 当前光标偏移（UTF-16）
 */
export function nextMatchIndex(matches: Match[], caret: number, forward: boolean): number {
  if (!matches.length) return -1;
  const pos = Math.max(0, Math.min(Number(caret) || 0, Number.MAX_SAFE_INTEGER));
  if (forward) {
    const i = matches.findIndex((m) => m.start >= pos);
    return i === -1 ? 0 : i;
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].end <= pos) return i;
  }
  return matches.length - 1;
}

/** 当前选区正好是某个命中时返回它的下标（用于"替换"按钮知道该换哪个）。 */
export function matchIndexAtSelection(matches: Match[], selStart: number, selEnd: number): number {
  return matches.findIndex((m) => m.start === selStart && m.end === selEnd);
}

/**
 * 用 replacement 替换给定的若干命中。
 *
 * 三条纪律：
 *   1. **先按 start 排序再滤重叠**：正则里用 `|` 可能产生交叉区间，直接按顺序拼会重复替换同一段；
 *   2. **越界命中忽略**，不尝试修复 —— 修复只能靠猜，猜错就是改坏用户代码；
 *   3. replacement 按**字面量**插入（不解释 `$&`/`$1`）。这里的替换框是给写代码的人用的，
 *      他们既然打开「正则」就是为了匹配，不期待替换串里再有一套美元符语法；
 *      真要捕获组，返回的 count 会让他发现"结果不对"，而不是悄悄改错。
 */
export function replaceMatches(
  text: string,
  matches: Match[],
  replacement: string
): { text: string; count: number } {
  const src = String(text ?? "");
  const repl = String(replacement ?? "");
  const valid = matches
    .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end) && m.end > m.start && m.start >= 0 && m.end <= src.length)
    .sort((a, b) => a.start - b.start);

  const parts: string[] = [];
  let cursor = 0;
  let count = 0;
  for (const m of valid) {
    if (m.start < cursor) continue; // 与上一个替换区间重叠 → 跳过
    parts.push(src.slice(cursor, m.start), repl);
    cursor = m.end;
    count++;
  }
  if (!count) return { text: src, count: 0 };
  parts.push(src.slice(cursor));
  return { text: parts.join(""), count };
}

// ============================================================================
// 2. 光标 ↦ 文本偏移（悬停提示用）
// ============================================================================

export interface ViewMetrics {
  /** 行高（px）：行号栏与正文共用同一个值 */
  lineHeight: number;
  /** 等宽字体下单字符宽度（px） */
  charWidth: number;
  padTop: number;
  padLeft: number;
  scrollTop: number;
  scrollLeft: number;
}

/**
 * 把「相对 textarea 内容区原点」的像素坐标换算成文本偏移。
 *
 * 为什么可以这么做：编辑器是**等宽字体 + `white-space: pre`**（CSS 里写死了 12px / 19px），
 * 所以「第几行」= ⌊y / 行高⌋、「第几列」= ⌊x / 字符宽⌋，不需要为每一行测量。
 * 这也是为什么这条换算必须写成纯函数：字体/行高一改，它就该被单测打红，而不是让悬停悄悄错位。
 *
 * 越界一律夹到合法范围：鼠标在编辑器空白处（行尾之外）时，落到该行末尾 —— 那是用户直觉上
 * "我指着这一行"的位置。
 */
export function pointToOffset(text: string, x: number, y: number, m: ViewMetrics): number {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const lh = m.lineHeight > 0 ? m.lineHeight : 19;
  const cw = m.charWidth > 0 ? m.charWidth : 8;

  const contentY = Math.max(0, y + m.scrollTop - m.padTop);
  const contentX = Math.max(0, x + m.scrollLeft - m.padLeft);

  const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor(contentY / lh)));
  const line = lines[lineIndex] ?? "";
  // +0.35 个字符宽再取整：鼠标落在字符**视觉中心右侧**才算指着下一个字符，
  // 直接 round 会让"指着字母右边缘"跳到右边一格，读起来像慢半拍。
  const col = Math.max(0, Math.min(line.length, Math.floor(contentX / cw + 0.35)));

  let off = 0;
  for (let i = 0; i < lineIndex; i++) off += (lines[i]?.length ?? 0) + 1;
  return off + col;
}

/** 文本里第 line（1 起）行的起始偏移。 */
export function offsetOfLine(text: string, line: number): number {
  const lines = String(text ?? "").split("\n");
  const target = Math.max(1, Math.min(lines.length, Math.round(line) || 1));
  let off = 0;
  for (let i = 0; i < target - 1; i++) off += (lines[i]?.length ?? 0) + 1;
  return off;
}

// ============================================================================
// 3. 标识符与括号
// ============================================================================

const WORD_CHAR = /[A-Za-z0-9_$]/;

export interface WordSpan {
  word: string;
  start: number;
  end: number;
}

/**
 * 取光标处的标识符（找不到返回 null）。
 *
 * 光标在词尾（`bwe.world.find|`）时也要算"指着 find"：用户把鼠标停在字母右侧边缘是常态，
 * 只认 offset 处的字符会让提示时有时无。
 */
export function wordAt(text: string, offset: number): WordSpan | null {
  const src = String(text ?? "");
  const n = src.length;
  let i = Math.max(0, Math.min(Number(offset) || 0, n));
  if (i < n && !WORD_CHAR.test(src[i]) && i > 0 && WORD_CHAR.test(src[i - 1])) i -= 1;
  if (i >= n || !WORD_CHAR.test(src[i])) return null;
  let s = i;
  let e = i;
  while (s > 0 && WORD_CHAR.test(src[s - 1])) s--;
  while (e < n && WORD_CHAR.test(src[e])) e++;
  if (e === s) return null;
  return { word: src.slice(s, e), start: s, end: e };
}

const PAIR: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const PAIR_REV: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * 扫描时跳过注释与字符串（返回跳过后的新位置）。
 *
 * ⚠ 不做正则字面量识别：`/[)]/` 里的 `)` 会被当成真括号。
 * 这是**有意接受的近似** —— 正则字面量与除号的区分需要看前一个 token，
 * 那种解析器的复杂度远超"括号高亮"这个需求的收益；而错判的后果只是高亮跳错位置，
 * 不会改坏任何文本。真要精确，应该走 TypeScript 的 syntax tree（那是另一条线）。
 */
function skipNonCode(src: string, i: number): number {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl;
  }
  if (c === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? src.length : end + 2;
  }
  if (c === "'" || c === '"' || c === "`") {
    const quote = c;
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === quote) return j + 1;
      // 普通引号不能跨行：遇到换行就当作字符串没闭合，停在换行处（否则一个漏引号会让后面全被跳过）
      if (src[j] === "\n" && quote !== "`") return j;
      j++;
    }
    return src.length;
  }
  return i;
}

export interface BracketPair {
  open: Match;
  close: Match;
}

/**
 * 光标处的括号配对。
 *
 * 优先看光标**右边**的字符，再看**左边**（用户点在一个括号前后都能触发高亮，
 * 这是编辑器的通识行为；只认一边会让"点不准"变成"高亮不出来"）。
 */
export function bracketPairAt(text: string, offset: number): BracketPair | null {
  const src = String(text ?? "");
  const n = src.length;
  if (!n) return null;
  const at = Math.max(0, Math.min(Number(offset) || 0, n));

  const candidates: { pos: number; ch: string }[] = [];
  if (at < n) candidates.push({ pos: at, ch: src[at] });
  if (at > 0) candidates.push({ pos: at - 1, ch: src[at - 1] });

  for (const { pos, ch } of candidates) {
    if (PAIR[ch]) {
      const close = scanForward(src, pos, ch, PAIR[ch]);
      if (close >= 0) return { open: { start: pos, end: pos + 1 }, close: { start: close, end: close + 1 } };
    } else if (PAIR_REV[ch]) {
      const open = scanBackward(src, pos, ch, PAIR_REV[ch]);
      if (open >= 0) return { open: { start: open, end: open + 1 }, close: { start: pos, end: pos + 1 } };
    }
  }
  return null;
}

function scanForward(src: string, from: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = src[i];
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function scanBackward(src: string, from: number, closeCh: string, openCh: string): number {
  let depth = 0;
  let i = from;
  while (i >= 0) {
    const c = src[i];
    if (c === closeCh) depth++;
    else if (c === openCh) {
      depth--;
      if (depth === 0) return i;
    }
    i--;
  }
  return -1;
}

// ============================================================================
// 4. 大纲
// ============================================================================

export type OutlineKind = "lifecycle" | "function" | "class" | "variable" | "section";

export interface OutlineItem {
  /** 显示名（函数名 / 变量名 / 分节标题） */
  label: string;
  kind: OutlineKind;
  /** 1 起 */
  line: number;
  /** 1 起（名字在行内的列） */
  col: number;
  /** 缩进层级，仅用于视觉缩进 */
  depth: number;
}

/**
 * 生命周期钩子是运行时会调用的入口，必须在大纲里排在最前并单独标色 ——
 * 用户打开一份陌生脚本时，第一件事是找"它挂了哪些钩子"，不是找第 3 个内部函数。
 */
const LIFECYCLE_RE = /^on[A-Z][A-Za-z0-9_]*$/;

/**
 * 从脚本源码里抽出大纲条目（不需要语言服务，纯正则 + 行扫描）。
 *
 * 为什么不用 TypeScript 的 syntax tree：大纲要在**每次敲键**后刷新，
 * 而走一次 language service 是 40~150ms（见 script-language.mjs 里的实测），
 * 逐键刷新会把打字拖成幻灯片。这里的正则只做"扫一行"，两万行也就几毫秒。
 *
 * 覆盖不到的形态（刻意不做）：解构声明、IIFE 内层、`if` 块内的局部函数。
 * 它们要么不常出现在 BWE 脚本里（脚本是平铺的过程式代码），要么抽出来只会让大纲变吵。
 */
export function extractOutline(text: string): OutlineItem[] {
  const src = String(text ?? "");
  if (!src.trim()) return [];
  const lines = src.split("\n");
  const out: OutlineItem[] = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    const lineNo = i + 1;
    const indent = raw.length - raw.trimStart().length;
    const depth = Math.min(3, Math.floor(indent / 2));

    if (!trimmed) {
      inBlockComment = inBlockComment && !trimmed.includes("*/");
      continue;
    }
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("//")) {
      // 分节注释：`// ===== 玩家移动 =====` 这类是用户给自己写的目录，值得进大纲
      const sec = /^\/\/\s*[=\-#*]{2,}\s*(.+?)\s*[=\-#*]{2,}\s*$/.exec(trimmed);
      if (sec) out.push({ label: sec[1], kind: "section", line: lineNo, col: 1, depth: 0 });
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const closesSameLine = trimmed.includes("*/");
      if (!closesSameLine) inBlockComment = true;
      continue;
    }

    // function name(args)
    let m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed);
    if (m) {
      out.push({
        label: m[1],
        kind: LIFECYCLE_RE.test(m[1]) ? "lifecycle" : "function",
        line: lineNo,
        col: raw.indexOf(m[1]) + 1,
        depth
      });
      continue;
    }

    // class Name
    m = /^class\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (m) {
      out.push({ label: m[1], kind: "class", line: lineNo, col: raw.indexOf(m[1]) + 1, depth });
      continue;
    }

    // const name = function / const name = (...) => / const name = arg => / let|var 同理
    m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(trimmed);
    if (m) {
      out.push({
        label: m[1],
        kind: LIFECYCLE_RE.test(m[1]) ? "lifecycle" : "function",
        line: lineNo,
        col: raw.indexOf(m[1]) + 1,
        depth
      });
      continue;
    }

    // 顶层普通变量（只收顶层：块内的临时变量进大纲等于噪音）
    if (depth === 0) {
      m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(trimmed);
      if (m) out.push({ label: m[1], kind: "variable", line: lineNo, col: raw.indexOf(m[1]) + 1, depth: 0 });
    }
  }

  // 生命周期在前（稳定排序：同 kind 内保持源码顺序）
  const rank: Record<OutlineKind, number> = { lifecycle: 0, function: 1, class: 2, variable: 3, section: 4 };
  return out
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => rank[a.item.kind] - rank[b.item.kind] || a.idx - b.idx)
    .map((x) => x.item);
}

// ============================================================================
// 5. 整行上移 / 下移（Alt+↑ / Alt+↓）
// ============================================================================

export interface MoveLineResult {
  text: string;
  /** 移动后光标应该落在哪（保持它原来在行内的相对列，而不是跳到行首） */
  caret: number;
}

/**
 * 把光标所在的那一行与相邻行交换。
 *
 * 为什么不用「剪切 → 上下移 → 粘贴」：那样会破坏撤销栈（用户按一次 Ctrl+Z 只撤销一半），
 * 而且缩进会跟着错。这里直接在文本层面交换两行，一次操作一步撤销。
 *
 * 边界：首行往上 / 末行往下 → 返回 null（而不是"复制一行"或"什么也不做但吃掉按键"），
 * 让调用方明确知道"这一步没有变化"，就不必刷新检查与行号。
 */
export function moveLine(text: string, caret: number, direction: -1 | 1): MoveLineResult | null {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const pos = Math.max(0, Math.min(Number(caret) || 0, src.length));

  // 光标所在行号（0 起）
  let lineIndex = 0;
  for (let i = 0; i < pos; i++) if (src[i] === "\n") lineIndex++;
  const target = lineIndex + direction;
  if (target < 0 || target >= lines.length) return null;

  const col = pos - (src.lastIndexOf("\n", Math.max(0, pos - 1)) + 1);
  const swapped = lines.slice();
  [swapped[lineIndex], swapped[target]] = [swapped[target], swapped[lineIndex]];

  // 新光标 = 目标行的起始 + 原列（列超出新行长度就夹到行尾）
  const newLineStart = swapped.slice(0, target).reduce((n, l) => n + l.length + 1, 0);
  const newCaret = newLineStart + Math.min(col, swapped[target].length);
  return { text: swapped.join("\n"), caret: newCaret };
}
