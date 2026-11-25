/**
 * 脚本「公开字段」的静态解析与合并（纯逻辑，可单测，不碰 DOM）。
 *
 * ## 为什么需要这一层
 *
 * 脚本挂在对象上之后，除了「选哪个脚本」以外没有任何可调的东西：想改一个移动速度，
 * 只能进代码里改字面量，然后所有挂着同一个脚本的对象一起变。Unity 的 `public float speed`
 * 解决的就是这件事——参数是**面板上的字段**，每个对象各存一份覆盖值。
 *
 * 这里的做法不引入任何编译期魔法，只认一段**可静态解析的声明**：
 *
 * ```js
 * bwe.params({
 *   speed: 100,        // 移动速度
 *   hp: 3,
 *   label: "玩家",
 *   alive: true,
 * });
 * ```
 *
 * 解析结果（字段名 + 类型 + 默认值）交给右栏 Inspector 渲染控件；用户改过的值写进
 * `script.js` 模块实例的 `values.params`（JSON 文本），导出时原样进 boot.json，
 * 运行时 `bwe.params(defs)` 返回「默认值 ∪ 覆盖值」。
 *
 * ## 契约（改动前先读）
 *
 * - **只支持字面量**：number / string / true / false / null。嵌套对象、数组、函数、
 *   引用变量、模板字符串、表达式一律报错——它们没法在不开辟执行环境的前提下求值，
 *   面板也就没法给出控件。报错是**一行可读的中文原因 + 行号**，面板照原样显示，不崩。
 * - **键**：标识符，或字符串字面量（`"移动速度": 100`，中文键就是这样写的）。
 * - **容忍**：行注释与块注释、尾逗号、单双引号、多行、`bwe . params( )` 之间的空格。
 * - **多处声明**：只取第一处，并在 `extraCalls` 里报个数（面板提示一句，不报错）。
 * - 本文件是**纯函数**：不读 store、不建 DOM、不依赖浏览器 API，所以能在 node 里直接跑断言。
 */

/** 一个公开字段的类型：由默认值的字面量种类决定，决定面板用什么控件。 */
export type ScriptParamType = "num" | "text" | "bool" | "null";

/** 字段的默认值（与类型一一对应）。 */
export type ScriptParamValue = number | string | boolean | null;

export interface ScriptParamField {
  /** 字段名（原样保留，中文键就是中文） */
  key: string;
  type: ScriptParamType;
  /** 默认值：没被覆盖时面板显示它、运行时的 `bwe.params()` 也用它 */
  def: ScriptParamValue;
  /** 声明的行号（1 开始），给「哪一行写错了」这类提示用 */
  line: number;
  /** 键右边同一行的注释（`speed: 100, // 移动速度`）→ 面板显示成说明 */
  hint?: string;
}

export interface ScriptParamsDecl {
  /** 解析出的字段（保持源码里的顺序 —— 面板顺序要可预期） */
  fields: ScriptParamField[];
  /** 解析失败原因；空 = 成功。面板把这段原文显示成一行提示。 */
  error?: string;
  /** 出错位置的行号（1 开始） */
  errorLine?: number;
  /** 源码里 `bwe.params(...)` 出现的次数（>1 时只用第一处） */
  calls: number;
}

// ---------------- 词法辅助 ----------------

/** 源码扫描器：字符串/注释/正则字面量都要跳过，否则 `// bwe.params({...})` 里那行注释会被当成声明。 */
class Scanner {
  readonly src: string;
  i = 0;

  constructor(src: string) {
    this.src = src;
  }

  eof(): boolean {
    return this.i >= this.src.length;
  }

  peek(offset = 0): string {
    return this.src[this.i + offset] ?? "";
  }

  /** 1 开始的行号。 */
  lineAt(index: number): number {
    let line = 1;
    for (let k = 0; k < index && k < this.src.length; k++) {
      if (this.src.charCodeAt(k) === 10) line++;
    }
    return line;
  }

  /** 跳过空白与注释；返回是否真的前进了。 */
  skipTrivia(): boolean {
    const start = this.i;
    for (;;) {
      const c = this.peek();
      if (c === "") break;
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        this.i++;
        continue;
      }
      if (c === "/" && this.peek(1) === "/") {
        while (!this.eof() && this.peek() !== "\n") this.i++;
        continue;
      }
      if (c === "/" && this.peek(1) === "*") {
        this.i += 2;
        while (!this.eof() && !(this.peek() === "*" && this.peek(1) === "/")) this.i++;
        this.i += 2;
        continue;
      }
      break;
    }
    return this.i !== start;
  }

  /**
   * 跳过一段「非代码」：字符串字面量、注释、正则字面量。
   * 返回是否跳过了内容（false = 当前位置不是字符串/注释/正则，调用方按普通字符处理）。
   */
  skipNonCode(): boolean {
    const c = this.peek();
    if (c === "/" && this.peek(1) === "/") {
      while (!this.eof() && this.peek() !== "\n") this.i++;
      return true;
    }
    if (c === "/" && this.peek(1) === "*") {
      this.i += 2;
      while (!this.eof() && !(this.peek() === "*" && this.peek(1) === "/")) this.i++;
      this.i += 2;
      return true;
    }
    if (c === '"' || c === "'" || c === "`") {
      this.i++;
      while (!this.eof()) {
        const d = this.peek();
        if (d === "\\") {
          this.i += 2;
          continue;
        }
        this.i++;
        if (d === c) break;
      }
      return true;
    }
    if (c === "/" && this.regexAllowedHere()) {
      // 正则字面量：不能当成除法，否则 `/bwe.params(/` 这类注释性标记会把后续代码吞掉。
      this.i++;
      let inClass = false;
      while (!this.eof()) {
        const d = this.peek();
        if (d === "\\") {
          this.i += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          this.i++;
          break;
        } else if (d === "\n") break; // 非法正则：当成普通字符，别把整份源码吃掉
        this.i++;
      }
      return true;
    }
    return false;
  }

  /** `/` 在这个位置能不能起一个正则字面量（启发式：前一个有效字符是不是运算符/开括号）。 */
  private regexAllowedHere(): boolean {
    for (let k = this.i - 1; k >= 0; k--) {
      const c = this.src[k];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") continue;
      return "=(,:[!&|?{};+-*%<>~^".includes(c);
    }
    return true;
  }
}

// ---------------- 对象字面量解析 ----------------

interface ParsedLiteral {
  value: ScriptParamValue;
  type: ScriptParamType;
  /** 值结束后的位置 */
  end: number;
}

class ParseError extends Error {
  readonly at: number;
  constructor(message: string, at: number) {
    super(message);
    this.at = at;
  }
}

const IDENT_START = /[A-Za-z_$\u00a0-\uffff]/;
const IDENT_PART = /[A-Za-z0-9_$\u00a0-\uffff]/;

/** 从 `{` 开始解析一个「字面量对象」；失败抛 ParseError。 */
function parseObjectLiteral(sc: Scanner): { fields: ScriptParamField[] } {
  const fields: ScriptParamField[] = [];
  if (sc.peek() !== "{") {
    throw new ParseError(
      "bwe.params(...) 的参数必须是一个对象字面量，例如 bwe.params({ speed: 100 })",
      sc.i
    );
  }
  sc.i++; // {
  for (;;) {
    sc.skipTrivia();
    if (sc.eof()) throw new ParseError("对象没有闭合：缺少 }", sc.i);
    if (sc.peek() === "}") {
      sc.i++;
      break;
    }

    const keyLine = sc.lineAt(sc.i);
    const key = parseKey(sc);
    sc.skipTrivia();
    if (sc.peek() !== ":") {
      throw new ParseError(`字段「${key}」后面缺少冒号`, sc.i);
    }
    sc.i++;
    sc.skipTrivia();
    const lit = parseValue(sc, key);
    const field: ScriptParamField = { key, type: lit.type, def: lit.value, line: keyLine };
    fields.push(field);

    // 取「值所在那一行」的注释作说明：`speed: 100, // 移动速度` 与 `speed: 100 // 移动速度,`
    // 两种写法都算（逗号在前在后都是合法 JS，用户不会为面板去记哪一种）。
    const sameLine = sc.lineAt(sc.i);
    // readTrailingComment 遇到换行就停 ⇒ 紧跟在值后面的这段注释天然属于本行，直接采用
    const hint = readTrailingComment(sc);
    if (hint) field.hint = hint;

    sc.skipTrivia();
    if (sc.peek() === ",") {
      sc.i++;
      // 逗号之后、同一行上的注释也算本字段的说明
      const afterComma = readTrailingComment(sc);
      if (!field.hint && afterComma && sc.lineAt(sc.i) === sameLine) field.hint = afterComma;
      continue; // 尾逗号也走这里：下一轮 skipTrivia 后遇到 } 就收尾
    }
    if (sc.peek() === "}") {
      sc.i++;
      break;
    }
    throw new ParseError(`字段「${key}」后面缺少逗号或 }`, sc.i);
  }
  return { fields };
}

function parseKey(sc: Scanner): string {
  const c = sc.peek();
  if (c === '"' || c === "'") {
    const lit = parseStringLiteral(sc);
    return lit;
  }
  if (c === "#") {
    // 私有字段 / 别的语言写法：不是合法的 JS 对象键，直接说清楚
    throw new ParseError("字段名不能以 # 开头", sc.i);
  }
  if (!IDENT_START.test(c)) {
    throw new ParseError(`这里需要一个字段名，实际读到「${c || "（结束）"}」`, sc.i);
  }
  const start = sc.i;
  while (!sc.eof() && IDENT_PART.test(sc.peek())) sc.i++;
  const name = sc.src.slice(start, sc.i);
  if (name === "__proto__") {
    // 不是禁止，而是会悄悄改原型、面板上也看不见 —— 明确报错比静默丢字段好
    throw new ParseError("字段名不能是 __proto__", start);
  }
  return name;
}

function parseStringLiteral(sc: Scanner): string {
  const quote = sc.peek();
  const startLine = sc.lineAt(sc.i);
  sc.i++;
  let out = "";
  while (!sc.eof()) {
    const c = sc.peek();
    if (c === "\\") {
      const n = sc.peek(1);
      sc.i += 2;
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "0") out += "\0";
      else if (n === "b") out += "\b";
      else if (n === "f") out += "\f";
      else if (n === "v") out += "\v";
      else if (n === "u") {
        const hex = sc.src.slice(sc.i, sc.i + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          sc.i += 4;
        } else {
          throw new ParseError("\\u 转义后面必须是 4 位十六进制", sc.i - 2);
        }
      } else if (n === "x") {
        const hex = sc.src.slice(sc.i, sc.i + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          sc.i += 2;
        } else {
          throw new ParseError("\\x 转义后面必须是 2 位十六进制", sc.i - 2);
        }
      } else if (n === "\n") {
        // 续行：什么都不加
      } else out += n ?? "";
      continue;
    }
    if (c === "\n") {
      throw new ParseError(`第 ${startLine} 行的字符串没有闭合`, sc.i);
    }
    sc.i++;
    if (c === quote) return out;
    out += c;
  }
  throw new ParseError(`第 ${startLine} 行的字符串没有闭合`, sc.i);
}

/** 解析一个字段的值；只认字面量，其余一律给出可行动的中文原因。 */
function parseValue(sc: Scanner, key: string): ParsedLiteral {
  const c = sc.peek();
  if (c === "") throw new ParseError(`字段「${key}」没有值`, sc.i);

  if (c === '"' || c === "'") {
    return { value: parseStringLiteral(sc), type: "text", end: sc.i };
  }
  if (c === "`") {
    throw new ParseError(`字段「${key}」的值不能是模板字符串（只支持普通字符串字面量）`, sc.i);
  }
  if (c === "{" || c === "[") {
    throw new ParseError(
      `字段「${key}」的值是${c === "{" ? "嵌套对象" : "数组"}，不支持（只支持 数字 / 字符串 / true / false / null）`,
      sc.i
    );
  }
  if (c === "-" || c === "+" || c === "." || /[0-9]/.test(c)) {
    const start = sc.i;
    if (c === "-" || c === "+") sc.i++;
    const digitsStart = sc.i;
    while (!sc.eof() && /[0-9]/.test(sc.peek())) sc.i++;
    if (sc.peek() === ".") {
      sc.i++;
      while (!sc.eof() && /[0-9]/.test(sc.peek())) sc.i++;
    }
    if (sc.peek() === "e" || sc.peek() === "E") {
      sc.i++;
      if (sc.peek() === "-" || sc.peek() === "+") sc.i++;
      while (!sc.eof() && /[0-9]/.test(sc.peek())) sc.i++;
    }
    const text = sc.src.slice(start, sc.i);
    if (sc.i === digitsStart) {
      throw new ParseError(`字段「${key}」的值不是一个完整的数字：「${text}」`, start);
    }
    const n = Number(text);
    if (!Number.isFinite(n)) {
      throw new ParseError(`字段「${key}」的数字超出范围：「${text}」`, start);
    }
    if (sc.src.slice(sc.i, sc.i + 1).match(/[A-Za-z_$]/)) {
      // 0x10 / 1n / 100px 之类：不是纯数字字面量，别猜
      const tail = sc.src.slice(start, sc.i + 12).split(/[\s,}]/)[0];
      throw new ParseError(`字段「${key}」的值「${tail}」不是普通数字字面量`, start);
    }
    return { value: n, type: "num", end: sc.i };
  }

  if (IDENT_START.test(c)) {
    const start = sc.i;
    while (!sc.eof() && IDENT_PART.test(sc.peek())) sc.i++;
    const word = sc.src.slice(start, sc.i);
    // 关键字后面如果紧跟 `(`，说明是函数调用 / 表达式，直接说清楚
    if (word === "true") return { value: true, type: "bool", end: sc.i };
    if (word === "false") return { value: false, type: "bool", end: sc.i };
    if (word === "null") return { value: null, type: "null", end: sc.i };
    if (word === "undefined") {
      throw new ParseError(`字段「${key}」的值不能用 undefined（要「没有值」请写 null）`, start);
    }
    if (word === "function" || word === "new" || word === "await" || word === "async") {
      throw new ParseError(`字段「${key}」的值不能是 ${word} 表达式（只支持字面量）`, start);
    }
    const after = (() => {
      const save = sc.i;
      sc.skipTrivia();
      const ch = sc.peek();
      sc.i = save;
      return ch;
    })();
    if (after === "(") {
      throw new ParseError(`字段「${key}」的值是一次函数调用，不支持（只支持字面量）`, start);
    }
    throw new ParseError(
      `字段「${key}」的值「${word}」是变量或表达式，不支持（只支持 数字 / 字符串 / true / false / null）`,
      start
    );
  }

  throw new ParseError(`字段「${key}」的值无法识别：「${c}」`, sc.i);
}

/** 读「同一行、紧跟在值后面的」注释，作为这个字段的说明。 */
function readTrailingComment(sc: Scanner): string | undefined {
  const save = sc.i;
  let spaces = 0;
  while (sc.peek() === " " || sc.peek() === "\t") {
    sc.i++;
    spaces++;
  }
  let hint: string | undefined;
  if (sc.peek() === "/" && sc.peek(1) === "/" && spaces > 0) {
    sc.i += 2;
    const start = sc.i;
    while (!sc.eof() && sc.peek() !== "\n") sc.i++;
    const text = sc.src.slice(start, sc.i).trim();
    if (text) hint = text;
  } else {
    sc.i = save;
  }
  return hint;
}

// ---------------- 对外入口 ----------------

/**
 * 从脚本源码里解析 `bwe.params({...})` 声明。
 *
 * 永不抛异常：解析失败返回 `error` / `errorLine`，面板据此显示一行提示。
 */
export function parseScriptParams(source: string): ScriptParamsDecl {
  const text = typeof source === "string" ? source : "";
  const out: ScriptParamsDecl = { fields: [], calls: 0 };
  if (!text) return out;

  const sc = new Scanner(text);
  while (!sc.eof()) {
    sc.skipTrivia();
    if (sc.eof()) break;
    const ch = sc.peek();
    // 只在「可能起一个标识符」的位置看 bwe.params，其余位置整段跳过（字符串/注释/正则）
    if (ch === "/" || ch === '"' || ch === "'" || ch === "`") {
      sc.skipNonCode();
      continue;
    }
    if (!IDENT_START.test(ch)) {
      sc.i++;
      continue;
    }
    const wordStart = sc.i;
    while (!sc.eof() && IDENT_PART.test(sc.peek())) sc.i++;
    if (sc.src.slice(wordStart, sc.i) !== "bwe") continue;

    // bwe . params (
    const afterBwe = sc.i;
    sc.skipTrivia();
    if (sc.peek() !== ".") {
      sc.i = afterBwe;
      continue;
    }
    sc.i++;
    sc.skipTrivia();
    const nameStart = sc.i;
    while (!sc.eof() && IDENT_PART.test(sc.peek())) sc.i++;
    if (sc.src.slice(nameStart, sc.i) !== "params") {
      sc.i = afterBwe;
      continue;
    }
    sc.skipTrivia();
    if (sc.peek() !== "(") {
      sc.i = afterBwe;
      continue;
    }
    sc.i++;

    out.calls++;
    if (out.calls > 1) {
      // 后续声明**不解析**（也不报错）：只提示「有多处」，字段表以第一处为准。
      // 跳过整段括号，避免把里面的标识符当成新声明再扫一遍。
      let depth = 1;
      while (!sc.eof() && depth > 0) {
        const ch = sc.peek();
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (!sc.skipNonCode()) sc.i++;
      }
      continue;
    }
    sc.skipTrivia();
    const callLine = sc.lineAt(sc.i);
    try {
      const { fields } = parseObjectLiteral(sc);
      out.fields = fields;
      if (!fields.length) {
        out.error = `第 ${callLine} 行的 bwe.params({}) 是空的：一个字段都没有，面板上不会显示任何东西`;
        out.errorLine = callLine;
      }
    } catch (e) {
      const err = e as ParseError;
      out.fields = [];
      out.error = `${String(err?.message ?? e)}（第 ${sc.lineAt(err?.at ?? sc.i)} 行）`;
      out.errorLine = sc.lineAt(err?.at ?? sc.i);
      return out; // 一处写错就停：面板只显示第一条原因，别拿半份字段去渲染
    }
  }
  return out;
}

/**
 * 从 `bwe.params(...)` 的声明文本里取出字段表；语法失败时返回空表（调用方用 errText 显示原因）。
 * 这是面板与运行时合并函数最常用的入口（store 里只有 source 字符串）。
 */
export function scriptParamFields(source: string): { fields: ScriptParamField[]; error?: string } {
  const decl = parseScriptParams(source);
  return decl.error ? { fields: [], error: decl.error } : { fields: decl.fields };
}

/** 把值规整成字段类型对应的 JS 值；类型对不上时返回 undefined（表示「忽略这个覆盖」）。 */
export function coerceParamValue(type: ScriptParamType, raw: unknown): ScriptParamValue | undefined {
  if (type === "null") return raw === null || raw === undefined ? null : undefined;
  if (type === "num") {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw.trim());
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  }
  if (type === "bool") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "开" || s === "是") return true;
      if (s === "false" || s === "0" || s === "关" || s === "否") return false;
    }
    if (typeof raw === "number") return raw !== 0;
    return undefined;
  }
  // text
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return undefined;
}

/**
 * 解析对象实例上存的覆盖值（`script.js` 模块 `values.params` 的 JSON 文本）。
 *
 * 只保留字段表里**存在且类型匹配**的键：这样手改坏的工程文件、脚本删掉字段后留下的
 * 残留覆盖，都不会让面板或运行时拿到一个「不该存在的参数」。
 */
export function parseOverrides(raw: string | undefined | null, fields: ScriptParamField[]): Record<string, ScriptParamValue> {
  const out: Record<string, ScriptParamValue> = {};
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return out;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return out; // 坏 JSON：当成「没有任何覆盖」，面板会另给一行提示
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const field = byKey.get(key);
    if (!field) continue;
    const v = coerceParamValue(field.type, value);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** 覆盖值里是否含有「字段表之外的键」或坏 JSON（面板用来提示「有残留，点重置」）。 */
export function overridesLookStale(raw: string | undefined | null, fields: ScriptParamField[]): boolean {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return false;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return true;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return true;
  const keys = new Set(fields.map((f) => f.key));
  const entries = Object.entries(data as Record<string, unknown>);
  if (!entries.length) return true; // "{}" 是空壳，应该删掉
  for (const [k] of entries) if (!keys.has(k)) return true;
  return false;
}

/** 有效参数 = 默认值被覆盖值覆盖（运行时 `bwe.params(defs)` 的同一套合并规则）。 */
export function mergeParams(
  fields: ScriptParamField[],
  overrides: Record<string, ScriptParamValue>
): Record<string, ScriptParamValue> {
  const out: Record<string, ScriptParamValue> = {};
  for (const f of fields) {
    out[f.key] = Object.prototype.hasOwnProperty.call(overrides, f.key) ? overrides[f.key] : f.def;
  }
  return out;
}

/**
 * 把覆盖值序列化成写进 `values.params` 的文本。
 *
 * **与默认值相同的项一律不写** —— 这是「没改过的字段不落盘」的落点：
 * 面板显示默认值是常态，工程文件里只应该有用户真的动过的那几个键。
 * 没有剩余覆盖时返回空串，调用方据此把 `values.params` 整个删掉（而不是写 `"{}"`）。
 */
export function serializeOverrides(
  overrides: Record<string, ScriptParamValue>,
  fields: ScriptParamField[]
): string {
  const kept: Record<string, ScriptParamValue> = {};
  // 按字段声明顺序写，工程文件 diff 才稳定
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(overrides, f.key)) continue;
    const v = overrides[f.key];
    if (f.type === "null") {
      if (v === null) continue;
      kept[f.key] = v;
      continue;
    }
    if (v === f.def) continue;
    kept[f.key] = v;
  }
  // 字段表之外的键不保留（脚本删了字段，工程里就不该还留着）
  return Object.keys(kept).length ? JSON.stringify(kept) : "";
}

/**
 * 面板/导出用的一行提示：错误优先，其次「多处声明」。
 * 没有可说的返回空串（调用方不渲染这一行）。
 */
export function scriptParamsHint(decl: ScriptParamsDecl): string {
  if (decl.error) return `脚本公开字段解析失败：${decl.error}`;
  if (decl.calls > 1) return `脚本里有 ${decl.calls} 处 bwe.params(...) 声明，只读取了第一处`;
  return "";
}

/**
 * 导出前的一次性体检：把所有对象的脚本参数覆盖检查一遍，返回可显示的问题清单。
 *
 * 为什么在导出前查：覆盖值是 JSON 文本，手改工程 / 旧版本留下的坏值如果直接进 boot.json，
 * 表现是「运行时参数静默变成默认值」——玩家看不出，作者也查不到。这里宁可多说一句。
 */
export function collectScriptParamProblems(
  project: { scenes?: { name?: string; objects?: { name?: string; id?: string; modules?: { defId?: string; values?: Record<string, string> }[] }[] }[]; prefabs?: { name?: string; modules?: { defId?: string; values?: Record<string, string> }[] }[]; scripts?: Record<string, { source?: string }> } | null | undefined
): string[] {
  const out: string[] = [];
  if (!project) return out;
  const scripts = project.scripts ?? {};
  const checkOne = (owner: string, modules: { defId?: string; values?: Record<string, string> }[] | undefined): void => {
    for (const m of modules ?? []) {
      if (m?.defId !== "script.js") continue;
      const raw = m.values?.["params"];
      if (raw === undefined || String(raw).trim() === "") continue;
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        out.push(`${owner} 的脚本参数覆盖不是合法 JSON，运行时会退回默认值`);
        continue;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        out.push(`${owner} 的脚本参数覆盖不是对象，运行时会退回默认值`);
        continue;
      }
      const scriptName = m.values?.["script"] ?? "";
      const decl = parseScriptParams(scripts[scriptName]?.source ?? "");
      if (decl.error) continue; // 脚本自己有问题，另有提示；这里不重复
      const keys = new Set(decl.fields.map((f) => f.key));
      for (const k of Object.keys(data as Record<string, unknown>)) {
        if (decl.fields.length && !keys.has(k)) {
          out.push(`${owner} 的脚本参数覆盖里有「${k}」，但脚本「${scriptName}」没有声明这个字段（运行时忽略）`);
        }
      }
    }
  };
  for (const scene of project.scenes ?? []) {
    for (const obj of scene.objects ?? []) {
      checkOne(`场景「${scene.name ?? ""}」里的对象「${obj.name || obj.id || "未命名"}」`, obj.modules);
    }
  }
  for (const prefab of project.prefabs ?? []) {
    checkOne(`预制体「${prefab.name ?? ""}」`, prefab.modules);
  }
  return out;
}
