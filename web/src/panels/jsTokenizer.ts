/**
 * JS 脚本的**语法着色令牌器**（纯逻辑，不碰 DOM，可单测）。
 *
 * ── 为什么单独一层 ──────────────────────────────────────────────────
 * 着色必须挂在**每一次按键**上（`input` → 重算 → 重绘覆盖层）。如果它和 DOM 写在一起，
 * 唯一能验的方式就只剩"用眼睛看颜色对不对" —— 而错色 / 漏色**看起来永远是"还行"**：
 * 少染一个关键字你不会注意到，字符串边界算错一格你也不会注意到，
 * 直到某个 `'` 里的中文被染成代码色才发现。所以规则全部做成纯函数 + 断言钉死。
 *
 * ── 设计取舍（每条都对应一个具体失败模式）────────────────────────────
 *   1. **单遍扫描，不做正则替换**。用 `/keyword/g` 之类逐个跑会互相污染：
 *      字符串里的 `return` 被当关键字、注释里的引号被当成字符串开头 ——
 *      那种错位的表现形式是"整段代码颜色乱掉"，且只在特定内容下出现。
 *   2. **非法输入（未闭合的字符串/注释）必须能吃下**。用户是在**打字**，
 *      每一帧的文本都是"暂时不合法"的。此时绝不能抛异常，也不能整篇不着色 ——
 *      而是把未闭合部分按"到行尾/到文件尾"染色。否则用户每打一个引号，
 *      整篇代码就闪一下无色。
 *   3. **同类相邻片段要合并**。`bwe.world.find` 是 3 个 token，但视觉上应该是一整段同色；
 *      分成 3 个 `<span>` 各自带 class 会浪费 DOM（一个 2000 行脚本能产生上万个 span，
 *      每次按键重建会卡）。合并后同色连续区只产出一个 span。
 *   4. **token 是按区间给的，不是按"着色意图"给的**。返回值只描述"哪一段是什么"，
 *      颜色由 CSS 决定 —— 这样换主题不需要改一行 TS。
 */

// ============================================================================
// 词表
// ============================================================================

/** 着色类别。CSS 侧一一对应 `.tk-<kind>`（见 web/styles/js-editor.css）。 */
export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "bwe"
  | "global";

export interface Token {
  start: number;
  end: number;
  kind: TokenKind;
}

/**
 * 保留字。
 *
 * 刻意**不含** `undefined` / `NaN` / `Infinity`：它们不是关键字而是全局值（放 global 更准，
 * 用户看到它们与 `Math` 同色，会更容易形成"这是运行时提供的"认知）。
 * 也不含 `get` / `set` / `from` / `async` 里的方法形态：它们在多数位置是普通标识符，
 * 染成关键字会误导（`var get = 1` 合法，但关键字色会让用户以为自己写错了）。
 *
 * ⚠ `of` **收进来**了，尽管它同样是"上下文关键字"：`for (var x of arr)` 是真实代码里
 * 高频出现的形态（TypeScript 降级到 ES5 后会展开成普通循环），而 `var of = 1` 极少见。
 * 这类取舍的原则是「按出现频率站队，而不是按规范严格性」—— 着色是给人扫读的，
 * 不是给解析器用的。
 */
const KEYWORDS = new Set([
  "var", "let", "const", "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "default", "break", "continue", "new", "delete", "typeof",
  "instanceof", "in", "of", "this", "null", "true", "false", "void", "try",
  "catch", "finally", "throw", "class", "extends", "super", "yield", "async",
  "await", "static", "import", "export", "debugger", "with"
]);

/**
 * JS 内置 API（ECMAScript 标准全局）。
 *
 * 为什么要有这一组：用户最常问的是「哪些是语言给的、哪些是 BWE 给的」。
 * 这组与 `bwe.*` 用**不同颜色**，一眼就能分清"我在用标准库还是在用引擎能力"。
 * 不含 `window` / `document` / `require` / `process` / `setTimeout` ——
 * 运行时（Rhino + BWE 沙箱）**没有**这些东西（见 docs/scripting-api.md §0.1），
 * 给它们上色等于暗示"可以用"。
 */
const GLOBALS = new Set([
  "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date",
  "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "EvalError",
  "ReferenceError", "Function", "Symbol", "Map", "Set", "WeakMap", "WeakSet",
  "Promise", "Proxy", "Reflect", "ArrayBuffer", "DataView", "Int8Array",
  "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
  "Uint32Array", "Float32Array", "Float64Array",
  "console", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI",
  "encodeURIComponent", "decodeURI", "decodeURIComponent", "undefined", "NaN",
  "Infinity", "eval"
]);

/**
 * `bwe` 命名空间下的成员名（用于把 `bwe.world` 的 `world` 也染成 bwe 色）。
 *
 * 来源：`web/src/js/bwe.d.ts` 里的 `const xxx: Xxx;`。**这份表是手工同步的** ——
 * 加新命名空间时必须回来补。为什么不用运行时反射：着色在做纯文本扫描，
 * 不能依赖 TS 语言服务（那要 40~150ms，逐键调用会把打字拖成幻灯片）。
 * 漏了的后果只是"这个命名空间不着色"，不会错色，所以手工同步是可接受的取舍。
 */
const BWE_NAMESPACES = new Set([
  "world", "input", "stick", "board", "textinput", "camera", "time", "draw",
  "audio", "mine", "save", "grid", "tilemap", "nav", "interact", "spawner",
  "prefab", "pool", "scene", "spatial", "collision", "actions", "road",
  "vehicle", "combat", "debug", "material", "field", "sense", "ai", "faction",
  "noise", "physics", "target", "light", "prof", "scripts", "save"
]);

/**
 * 生命周期钩子（运行时按同名函数调用，见 globals.d.ts）。
 *
 * 单独染成 bwe 色而不是关键字色，理由：它们**不是**语言关键字，是引擎契约 ——
 * 用户在文件里看到一片同色的 `onStart` / `onUpdate`，立刻知道"这些是引擎会调的入口"。
 */
const LIFECYCLE = new Set([
  "onStart", "onUpdate", "onClick", "onEnter", "onLeave", "onInteract",
  "onDamage", "onDeath", "onDestroy", "onKey", "onSceneStart", "onSceneEnd"
]);

/** 标识符字符（`$` 与 `_` 在 JS 里合法，`$el` 这类必须整体识别）。 */
const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

// ============================================================================
// 主扫描
// ============================================================================

/**
 * 把源码切成着色片段。
 *
 * 返回值**连续覆盖整段文本**（plain 片段也在里面），调用方可以无脑按顺序拼 DOM，
 * 不必自己找"空隙"。这一点很重要：如果只返回"要着色的部分"，调用方就得反算出
 * 中间的 plain 段，那一步的 off-by-one 会让整篇文字错位（而且只有某些内容下才出现）。
 *
 * @param text 源码
 * @returns 按 start 升序、首尾相接的 token 列表
 */
export function tokenize(text: string): Token[] {
  const src = String(text ?? "");
  const out: Token[] = [];
  const push = (start: number, end: number, kind: TokenKind): void => {
    if (end <= start) return;
    const last = out[out.length - 1];
    // 相邻同类合并：`bwe.world.find` 要像一整段，而不是三个 span
    if (last && last.kind === kind && last.end === start) {
      last.end = end;
      return;
    }
    out.push({ start, end, kind });
  };

  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    // ---- 行注释 ----
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      push(i, end, "comment");
      i = end;
      continue;
    }

    // ---- 块注释（未闭合也要吃下：用户在打字）----
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      push(i, end, "comment");
      i = end;
      continue;
    }

    // ---- 字符串 / 模板字符串 ----
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j++;
          closed = true;
          break;
        }
        // 普通引号不能跨行：遇到换行就收工（用户打了一个引号还没收尾）
        if (src[j] === "\n" && quote !== "`") break;
        j++;
      }
      void closed;
      push(i, Math.min(j, n), "string");
      i = Math.min(j, n);
      continue;
    }

    // ---- 数字 ----
    // 覆盖 123 / 1.5 / .5 / 0x1f / 0b101 / 1e-3 / 1_000（ES2021 数值分隔符）
    if (DIGIT.test(c) || (c === "." && DIGIT.test(src[i + 1] ?? ""))) {
      let j = i;
      if (c === "0" && /[xX]/.test(src[i + 1] ?? "")) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
      } else if (c === "0" && /[bB]/.test(src[i + 1] ?? "")) {
        j = i + 2;
        while (j < n && /[01_]/.test(src[j])) j++;
      } else if (c === "0" && /[oO]/.test(src[i + 1] ?? "")) {
        j = i + 2;
        while (j < n && /[0-7_]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;
        if (src[j] === "." && DIGIT.test(src[j + 1] ?? "")) {
          j++;
          while (j < n && /[0-9_]/.test(src[j])) j++;
        }
        if (/[eE]/.test(src[j] ?? "")) {
          let k = j + 1;
          if (src[k] === "+" || src[k] === "-") k++;
          if (DIGIT.test(src[k] ?? "")) {
            j = k;
            while (j < n && /[0-9_]/.test(src[j])) j++;
          }
        }
      }
      push(i, j, "number");
      i = j;
      continue;
    }

    // ---- 标识符 / 关键字 / bwe 链 / 内置 API ----
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      const word = src.slice(i, j);
      push(i, j, classify(word));
      i = j;
      continue;
    }

    // ---- 其它（空格、运算符、标点）----
    push(i, i + 1, "plain");
    i++;
  }

  return out;
}

/** 单个标识符该染什么色。 */
function classify(word: string): TokenKind {
  if (KEYWORDS.has(word)) return "keyword";
  if (word === "bwe") return "bwe";
  if (LIFECYCLE.has(word)) return "bwe";
  // `bwe` 的下一级（world / draw / …）。只染这一级：`bwe.world.find` 里的 `find`
  // 是方法名，与其它对象的成员同色才好读；否则整条链都是一个颜色，反而看不出层次。
  if (BWE_NAMESPACES.has(word)) return "bwe";
  if (GLOBALS.has(word)) return "global";
  return "plain";
}

// ============================================================================
// 供覆盖层使用的便捷出口
// ============================================================================

/**
 * 判断 token 列表里有没有"需要着色"的片段。
 *
 * 用途：纯 plain 的文本（例如用户刚清空、只剩一个空格）不必重建 DOM。
 * 这是一个便宜的短路，能让"打字时的空转"不产生任何 DOM 操作。
 */
export function hasHighlight(tokens: Token[]): boolean {
  for (const t of tokens) if (t.kind !== "plain") return true;
  return false;
}

/** 统计各 kind 的片段数（验收/排查用；也用于断言"某个词真的被染上了"）。 */
export function countKinds(tokens: Token[]): Record<TokenKind, number> {
  const out: Record<TokenKind, number> = {
    plain: 0, comment: 0, string: 0, number: 0, keyword: 0, bwe: 0, global: 0
  };
  for (const t of tokens) out[t.kind]++;
  return out;
}

/** 取某个类别在文本里的所有原文（验收时用来断言"Math 被染成 global"）。 */
export function wordsOfKind(text: string, tokens: Token[], kind: TokenKind): string[] {
  const src = String(text ?? "");
  return tokens.filter((t) => t.kind === kind).map((t) => src.slice(t.start, t.end));
}
