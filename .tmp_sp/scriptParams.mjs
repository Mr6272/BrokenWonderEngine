// web/src/core/scriptParams.ts
var Scanner = class {
  src;
  i = 0;
  constructor(src) {
    this.src = src;
  }
  eof() {
    return this.i >= this.src.length;
  }
  peek(offset = 0) {
    return this.src[this.i + offset] ?? "";
  }
  /** 1 开始的行号。 */
  lineAt(index) {
    let line = 1;
    for (let k = 0; k < index && k < this.src.length; k++) {
      if (this.src.charCodeAt(k) === 10) line++;
    }
    return line;
  }
  /** 跳过空白与注释；返回是否真的前进了。 */
  skipTrivia() {
    const start = this.i;
    for (; ; ) {
      const c = this.peek();
      if (c === "") break;
      if (c === " " || c === "	" || c === "\r" || c === "\n") {
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
  skipNonCode() {
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
        } else if (d === "\n") break;
        this.i++;
      }
      return true;
    }
    return false;
  }
  /** `/` 在这个位置能不能起一个正则字面量（启发式：前一个有效字符是不是运算符/开括号）。 */
  regexAllowedHere() {
    for (let k = this.i - 1; k >= 0; k--) {
      const c = this.src[k];
      if (c === " " || c === "	" || c === "\r" || c === "\n") continue;
      return "=(,:[!&|?{};+-*%<>~^".includes(c);
    }
    return true;
  }
};
var ParseError = class extends Error {
  at;
  constructor(message, at) {
    super(message);
    this.at = at;
  }
};
var IDENT_START = /[A-Za-z_$\u00a0-\uffff]/;
var IDENT_PART = /[A-Za-z0-9_$\u00a0-\uffff]/;
function parseObjectLiteral(sc) {
  const fields = [];
  if (sc.peek() !== "{") {
    throw new ParseError(
      "bwe.params(...) \u7684\u53C2\u6570\u5FC5\u987B\u662F\u4E00\u4E2A\u5BF9\u8C61\u5B57\u9762\u91CF\uFF0C\u4F8B\u5982 bwe.params({ speed: 100 })",
      sc.i
    );
  }
  sc.i++;
  for (; ; ) {
    sc.skipTrivia();
    if (sc.eof()) throw new ParseError("\u5BF9\u8C61\u6CA1\u6709\u95ED\u5408\uFF1A\u7F3A\u5C11 }", sc.i);
    if (sc.peek() === "}") {
      sc.i++;
      break;
    }
    const keyLine = sc.lineAt(sc.i);
    const key = parseKey(sc);
    sc.skipTrivia();
    if (sc.peek() !== ":") {
      throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u540E\u9762\u7F3A\u5C11\u5192\u53F7`, sc.i);
    }
    sc.i++;
    sc.skipTrivia();
    const lit = parseValue(sc, key);
    const field = { key, type: lit.type, def: lit.value, line: keyLine };
    fields.push(field);
    const sameLine = sc.lineAt(sc.i);
    const hint = readTrailingComment(sc);
    if (hint) field.hint = hint;
    sc.skipTrivia();
    if (sc.peek() === ",") {
      sc.i++;
      const afterComma = readTrailingComment(sc);
      if (!field.hint && afterComma && sc.lineAt(sc.i) === sameLine) field.hint = afterComma;
      continue;
    }
    if (sc.peek() === "}") {
      sc.i++;
      break;
    }
    throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u540E\u9762\u7F3A\u5C11\u9017\u53F7\u6216 }`, sc.i);
  }
  return { fields };
}
function parseKey(sc) {
  const c = sc.peek();
  if (c === '"' || c === "'") {
    const lit = parseStringLiteral(sc);
    return lit;
  }
  if (c === "#") {
    throw new ParseError("\u5B57\u6BB5\u540D\u4E0D\u80FD\u4EE5 # \u5F00\u5934", sc.i);
  }
  if (!IDENT_START.test(c)) {
    throw new ParseError(`\u8FD9\u91CC\u9700\u8981\u4E00\u4E2A\u5B57\u6BB5\u540D\uFF0C\u5B9E\u9645\u8BFB\u5230\u300C${c || "\uFF08\u7ED3\u675F\uFF09"}\u300D`, sc.i);
  }
  const start = sc.i;
  while (!sc.eof() && IDENT_PART.test(sc.peek())) sc.i++;
  const name = sc.src.slice(start, sc.i);
  if (name === "__proto__") {
    throw new ParseError("\u5B57\u6BB5\u540D\u4E0D\u80FD\u662F __proto__", start);
  }
  return name;
}
function parseStringLiteral(sc) {
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
      else if (n === "t") out += "	";
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
          throw new ParseError("\\u \u8F6C\u4E49\u540E\u9762\u5FC5\u987B\u662F 4 \u4F4D\u5341\u516D\u8FDB\u5236", sc.i - 2);
        }
      } else if (n === "x") {
        const hex = sc.src.slice(sc.i, sc.i + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          sc.i += 2;
        } else {
          throw new ParseError("\\x \u8F6C\u4E49\u540E\u9762\u5FC5\u987B\u662F 2 \u4F4D\u5341\u516D\u8FDB\u5236", sc.i - 2);
        }
      } else if (n === "\n") {
      } else out += n ?? "";
      continue;
    }
    if (c === "\n") {
      throw new ParseError(`\u7B2C ${startLine} \u884C\u7684\u5B57\u7B26\u4E32\u6CA1\u6709\u95ED\u5408`, sc.i);
    }
    sc.i++;
    if (c === quote) return out;
    out += c;
  }
  throw new ParseError(`\u7B2C ${startLine} \u884C\u7684\u5B57\u7B26\u4E32\u6CA1\u6709\u95ED\u5408`, sc.i);
}
function parseValue(sc, key) {
  const c = sc.peek();
  if (c === "") throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u6CA1\u6709\u503C`, sc.i);
  if (c === '"' || c === "'") {
    return { value: parseStringLiteral(sc), type: "text", end: sc.i };
  }
  if (c === "`") {
    throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u7684\u503C\u4E0D\u80FD\u662F\u6A21\u677F\u5B57\u7B26\u4E32\uFF08\u53EA\u652F\u6301\u666E\u901A\u5B57\u7B26\u4E32\u5B57\u9762\u91CF\uFF09`, sc.i);
  }
  if (c === "{" || c === "[") {
    throw new ParseError(
      `\u5B57\u6BB5\u300C${key}\u300D\u7684\u503C\u662F${c === "{" ? "\u5D4C\u5957\u5BF9\u8C61" : "\u6570\u7EC4"}\uFF0C\u4E0D\u652F\u6301\uFF08\u53EA\u652F\u6301 \u6570\u5B57 / \u5B57\u7B26\u4E32 / true / false / null\uFF09`,
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
      throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u7684\u503C\u4E0D\u662F\u4E00\u4E2A\u5B8C\u6574\u7684\u6570\u5B57\uFF1A\u300C${text}\u300D`, start);
    }
    const n = Number(text);
    if (!Number.isFinite(n)) {
      throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u7684\u6570\u5B57\u8D85\u51FA\u8303\u56F4\uFF1A\u300C${text}\u300D`, start);
    }
    if (sc.src.slice(sc.i, sc.i + 1).match(/[A-Za-z_$]/)) {
      const tail = sc.src.slice(start, sc.i + 12).split(/[\s,}]/)[0];
      throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u7684\u503C\u300C${tail}\u300D\u4E0D\u662F\u666E\u901A\u6570\u5B57\u5B57\u9762\u91CF`, start);
    }
    return { value: n, type: "num", end: sc.i };
  }
  if (IDENT_START.test(c)) {
    const start = sc.i;
    while (!sc.eof() && IDENT_PART.test(sc.peek())) sc.i++;
    const word = sc.src.slice(start, sc.i);
    if (word === "true") return { value: true, type: "bool", end: sc.i };
    if (word === "false") return { value: false, type: "bool", end: sc.i };
    if (word === "null") return { value: null, type: "null", end: sc.i };
    if (word === "undefined") {
      throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u7684\u503C\u4E0D\u80FD\u7528 undefined\uFF08\u8981\u300C\u6CA1\u6709\u503C\u300D\u8BF7\u5199 null\uFF09`, start);
    }
    if (word === "function" || word === "new" || word === "await" || word === "async") {
      throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u7684\u503C\u4E0D\u80FD\u662F ${word} \u8868\u8FBE\u5F0F\uFF08\u53EA\u652F\u6301\u5B57\u9762\u91CF\uFF09`, start);
    }
    const after = (() => {
      const save = sc.i;
      sc.skipTrivia();
      const ch = sc.peek();
      sc.i = save;
      return ch;
    })();
    if (after === "(") {
      throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u7684\u503C\u662F\u4E00\u6B21\u51FD\u6570\u8C03\u7528\uFF0C\u4E0D\u652F\u6301\uFF08\u53EA\u652F\u6301\u5B57\u9762\u91CF\uFF09`, start);
    }
    throw new ParseError(
      `\u5B57\u6BB5\u300C${key}\u300D\u7684\u503C\u300C${word}\u300D\u662F\u53D8\u91CF\u6216\u8868\u8FBE\u5F0F\uFF0C\u4E0D\u652F\u6301\uFF08\u53EA\u652F\u6301 \u6570\u5B57 / \u5B57\u7B26\u4E32 / true / false / null\uFF09`,
      start
    );
  }
  throw new ParseError(`\u5B57\u6BB5\u300C${key}\u300D\u7684\u503C\u65E0\u6CD5\u8BC6\u522B\uFF1A\u300C${c}\u300D`, sc.i);
}
function readTrailingComment(sc) {
  const save = sc.i;
  let spaces = 0;
  while (sc.peek() === " " || sc.peek() === "	") {
    sc.i++;
    spaces++;
  }
  let hint;
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
function parseScriptParams(source) {
  const text = typeof source === "string" ? source : "";
  const out = { fields: [], calls: 0 };
  if (!text) return out;
  const sc = new Scanner(text);
  while (!sc.eof()) {
    sc.skipTrivia();
    if (sc.eof()) break;
    const ch = sc.peek();
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
      let depth = 1;
      while (!sc.eof() && depth > 0) {
        const ch2 = sc.peek();
        if (ch2 === "(") depth++;
        else if (ch2 === ")") depth--;
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
        out.error = `\u7B2C ${callLine} \u884C\u7684 bwe.params({}) \u662F\u7A7A\u7684\uFF1A\u4E00\u4E2A\u5B57\u6BB5\u90FD\u6CA1\u6709\uFF0C\u9762\u677F\u4E0A\u4E0D\u4F1A\u663E\u793A\u4EFB\u4F55\u4E1C\u897F`;
        out.errorLine = callLine;
      }
    } catch (e) {
      const err = e;
      out.fields = [];
      out.error = `${String(err?.message ?? e)}\uFF08\u7B2C ${sc.lineAt(err?.at ?? sc.i)} \u884C\uFF09`;
      out.errorLine = sc.lineAt(err?.at ?? sc.i);
      return out;
    }
  }
  return out;
}
function scriptParamFields(source) {
  const decl = parseScriptParams(source);
  return decl.error ? { fields: [], error: decl.error } : { fields: decl.fields };
}
function coerceParamValue(type, raw) {
  if (type === "null") return raw === null || raw === void 0 ? null : void 0;
  if (type === "num") {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw.trim());
      if (Number.isFinite(n)) return n;
    }
    return void 0;
  }
  if (type === "bool") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "\u5F00" || s === "\u662F") return true;
      if (s === "false" || s === "0" || s === "\u5173" || s === "\u5426") return false;
    }
    if (typeof raw === "number") return raw !== 0;
    return void 0;
  }
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return void 0;
}
function parseOverrides(raw, fields) {
  const out = {};
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return out;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(data)) {
    const field = byKey.get(key);
    if (!field) continue;
    const v = coerceParamValue(field.type, value);
    if (v !== void 0) out[key] = v;
  }
  return out;
}
function overridesLookStale(raw, fields) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return false;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return true;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return true;
  const keys = new Set(fields.map((f) => f.key));
  const entries = Object.entries(data);
  if (!entries.length) return true;
  for (const [k] of entries) if (!keys.has(k)) return true;
  return false;
}
function mergeParams(fields, overrides) {
  const out = {};
  for (const f of fields) {
    out[f.key] = Object.prototype.hasOwnProperty.call(overrides, f.key) ? overrides[f.key] : f.def;
  }
  return out;
}
function serializeOverrides(overrides, fields) {
  const kept = {};
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
  return Object.keys(kept).length ? JSON.stringify(kept) : "";
}
function scriptParamsHint(decl) {
  if (decl.error) return `\u811A\u672C\u516C\u5F00\u5B57\u6BB5\u89E3\u6790\u5931\u8D25\uFF1A${decl.error}`;
  if (decl.calls > 1) return `\u811A\u672C\u91CC\u6709 ${decl.calls} \u5904 bwe.params(...) \u58F0\u660E\uFF0C\u53EA\u8BFB\u53D6\u4E86\u7B2C\u4E00\u5904`;
  return "";
}
function collectScriptParamProblems(project) {
  const out = [];
  if (!project) return out;
  const scripts = project.scripts ?? {};
  const checkOne = (owner, modules) => {
    for (const m of modules ?? []) {
      if (m?.defId !== "script.js") continue;
      const raw = m.values?.["params"];
      if (raw === void 0 || String(raw).trim() === "") continue;
      let data;
      try {
        data = JSON.parse(String(raw));
      } catch {
        out.push(`${owner} \u7684\u811A\u672C\u53C2\u6570\u8986\u76D6\u4E0D\u662F\u5408\u6CD5 JSON\uFF0C\u8FD0\u884C\u65F6\u4F1A\u9000\u56DE\u9ED8\u8BA4\u503C`);
        continue;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        out.push(`${owner} \u7684\u811A\u672C\u53C2\u6570\u8986\u76D6\u4E0D\u662F\u5BF9\u8C61\uFF0C\u8FD0\u884C\u65F6\u4F1A\u9000\u56DE\u9ED8\u8BA4\u503C`);
        continue;
      }
      const scriptName = m.values?.["script"] ?? "";
      const decl = parseScriptParams(scripts[scriptName]?.source ?? "");
      if (decl.error) continue;
      const keys = new Set(decl.fields.map((f) => f.key));
      for (const k of Object.keys(data)) {
        if (decl.fields.length && !keys.has(k)) {
          out.push(`${owner} \u7684\u811A\u672C\u53C2\u6570\u8986\u76D6\u91CC\u6709\u300C${k}\u300D\uFF0C\u4F46\u811A\u672C\u300C${scriptName}\u300D\u6CA1\u6709\u58F0\u660E\u8FD9\u4E2A\u5B57\u6BB5\uFF08\u8FD0\u884C\u65F6\u5FFD\u7565\uFF09`);
        }
      }
    }
  };
  for (const scene of project.scenes ?? []) {
    for (const obj of scene.objects ?? []) {
      checkOne(`\u573A\u666F\u300C${scene.name ?? ""}\u300D\u91CC\u7684\u5BF9\u8C61\u300C${obj.name || obj.id || "\u672A\u547D\u540D"}\u300D`, obj.modules);
    }
  }
  for (const prefab of project.prefabs ?? []) {
    checkOne(`\u9884\u5236\u4F53\u300C${prefab.name ?? ""}\u300D`, prefab.modules);
  }
  return out;
}
export {
  coerceParamValue,
  collectScriptParamProblems,
  mergeParams,
  overridesLookStale,
  parseOverrides,
  parseScriptParams,
  scriptParamFields,
  scriptParamsHint,
  serializeOverrides
};
