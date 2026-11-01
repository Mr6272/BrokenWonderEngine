/**
 * BWE 脚本规则检查器（手写扫描器，不依赖任何第三方包，也不依赖 `vscode`）。
 *
 * 为什么不用 AST 库：扩展要求零 npm 依赖（vsix 里只有纯 JS）。
 * 因此这里做「遮罩 + 定点扫描」：
 *   1. 先把注释与字符串字面量替换成等长空格（换行保留），得到 `masked`；
 *      这样所有下标都能直接映回原文的行/列，且不会把字符串里的 `document` 当成代码；
 *   2. 规则用正则扫 `masked`；命中的下标 → 行列；
 *   3. 需要看「某个函数体内部」的规则（onSceneStart 里的 ctx.self）用花括号配对找 body。
 *
 * 规则只报**能确定会出问题**的写法，宁可漏报也不误报 —— 误报会让用户直接关掉扩展。
 * 规则清单见 README.md 的「规则清单」一节，编号与下面 `code` 一一对应。
 */

"use strict";

const RULES = {
  E001: "不能使用 import（运行时是 Rhino，没有模块系统；跨脚本用 bwe.scripts.call）",
  E002: "不能使用 require（没有模块系统；跨脚本用 bwe.scripts.call / bwe.has）",
  E003: "不能使用 export / module.exports（脚本共享一个全局作用域）",
  E004: "浏览器 / Node 的宿主对象在运行时不存在",
  E005: "没有 setTimeout / setInterval：用 bwe.after(sec, fn) / bwe.every(sec, fn)",
  W001: "console.log 在引擎里被映射到 bwe.log，但这是契约外便利；建议直接写 bwe.log",
  E006: "场景脚本里 ctx.self 是 null（拿对象用 bwe.world.find(...)）",
  W002: "疑似拼错的 bwe 成员（按编辑距离给出最近候选）",
  W003: "不要用 eval：会绕过脚本引擎的编译与诊断",
};

/** 宿主对象（浏览器 / Node）——运行时是 Rhino，这些一律不存在。 */
const HOST_OBJECTS = [
  "document",
  "window",
  "localStorage",
  "sessionStorage",
  "XMLHttpRequest",
  "navigator",
  "location",
  "history",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "WebSocket",
  "process",
  "module",
  "exports",
  "global",
];

/** 这些对象的写法是 `xxx.` 或 `xxx(`，两者都要抓。 */
const HOST_CALLS = ["fetch", "alert", "confirm", "prompt", "open"];

/** 定时器：引擎没有，用 bwe.after / bwe.every。 */
const TIMERS = ["setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval"];

/**
 * 把注释与字符串内容遮成空格（长度不变）。
 *
 * 注意：模板字符串 `${}` 里的表达式也会被遮掉。BWE 脚本按 ES5 写，模板串在 TS 降级后
 * 会变成字符串拼接，遮掉不会漏掉真实问题（宿主 API 不会只出现在 `${}` 里）。
 *
 * @param {string} source
 * @returns {string} 与 source 等长的遮罩文本
 */
function maskSource(source) {
  const src = String(source || "");
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "*") {
      let j = i + 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
      const end = Math.min(src.length, j + 2);
      out += src.slice(i, end).replace(/[^\n]/g, " ");
      i = end - 1;
    } else if (c === "/" && n === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      out += src.slice(i, j).replace(/[^\n]/g, " ");
      i = j - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      const end = Math.min(src.length, j);
      out += quote + src.slice(i + 1, end - 1).replace(/[^\n]/g, " ") + (end > i + 1 ? src[end - 1] : "");
      i = end - 1;
    } else {
      out += c;
    }
  }
  return out;
}

/** 下标 → 1 基行列。 */
function positionOf(text, index) {
  const before = text.slice(0, Math.max(0, index));
  const line = before.split("\n").length;
  const lastNl = before.lastIndexOf("\n");
  const col = index - lastNl; // 1 基
  return { line, col };
}

/** 从 openBrace 的花括号开始配对，返回闭括号下标（-1 = 没找到）。 */
function matchBrace(masked, openBrace) {
  let depth = 0;
  for (let i = openBrace; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 找 `function onSceneStart(...) { ... }` 的函数体区间。
 * @returns {{start:number,end:number}|null} 花括号之间的区间（不含括号）
 */
function findFunctionBody(masked, fnName) {
  const re = new RegExp(`function\\s+${fnName}\\s*\\(`, "g");
  const m = re.exec(masked);
  if (!m) return null;
  // 跳过参数列表
  let i = m.index + m[0].length - 1;
  let depth = 0;
  const closeParen = (() => {
    for (; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  })();
  if (closeParen < 0) return null;
  const brace = masked.indexOf("{", closeParen);
  if (brace < 0) return null;
  const end = matchBrace(masked, brace);
  if (end < 0) return null;
  return { start: brace + 1, end };
}

/** 构造一条诊断。 */
function diag(text, index, length, severity, code, message) {
  const p = positionOf(text, index);
  const endPos = positionOf(text, Math.min(text.length, index + Math.max(1, length)));
  return {
    line: p.line,
    col: p.col,
    endLine: endPos.line,
    endCol: endPos.col,
    severity,
    code,
    message: `${code} ${message}`,
    rule: code,
    source: "BWE",
  };
}

/** 在 masked 上扫某个标识符（`obj.` 或 `obj(` 两种形态）。 */
function scanIdentifier(text, masked, identifier, severity, code, message, opts) {
  const out = [];
  const allowCall = !opts || opts.allowCall !== false;
  const allowMember = !opts || opts.allowMember !== false;
  const needPrevBoundary = /^[A-Za-z_$]/.test(identifier);
  const re = new RegExp(needPrevBoundary ? `\\b${escapeRe(identifier)}` : escapeRe(identifier), "g");
  let m;
  while ((m = re.exec(masked))) {
    const at = m.index;
    // 跳过对象属性名：`x.setTimeout` / `{ setTimeout: ... }`
    const prevText = masked.slice(Math.max(0, at - 12), at);
    if (/[.$]\s*$/.test(prevText)) continue;
    let after = masked.slice(at + identifier.length);
    let ws = 0;
    while (ws < after.length && (after[ws] === " " || after[ws] === "\t")) ws++;
    const next = after[ws];
    const isMember = next === "." || next === "[";
    const isCall = next === "(";
    if ((isMember && !allowMember) || (isCall && !allowCall)) continue;
    if (!isMember && !isCall) {
      // 单独出现：`var document = ...` 这种声明也不是我们关心的用法
      if (!/^\s*(?:var|let|const)\s/.test(masked.slice(Math.max(0, at - 40), at))) continue;
      continue;
    }
    out.push(diag(text, at, identifier.length, severity, code, message));
  }
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 已知的 bwe 命名空间前缀集合 + 完整成员集合，用于「未知 bwe 成员」规则。 */
function buildKnownNames(indexModule, apis) {
  const entries = new Set();
  const namespaces = new Set();
  const source = apis || (indexModule ? indexModule.allApis() : []);
  for (const api of source) {
    if (!api || typeof api.name !== "string") continue;
    if (!api.name.startsWith("bwe.")) continue;
    entries.add(api.name);
    const parts = api.name.split(".");
    for (let i = 1; i < parts.length; i++) namespaces.add(parts.slice(0, i + 1).join("."));
  }
  // `root` 也算命名空间（`bwe` 本身）
  namespaces.add("bwe");
  return { entries, namespaces };
}

/** 找 token 的最长已知前缀（entries 或 namespaces）。 */
function longestKnownPrefix(token, known) {
  let best = "";
  let bestIsEntry = false;
  for (let i = token.length; i > 0; i--) {
    const p = token.slice(0, i);
    if (known.entries.has(p)) {
      best = p;
      bestIsEntry = true;
      break;
    }
    if (known.namespaces.has(p)) {
      best = p;
      bestIsEntry = false;
      break;
    }
  }
  return { prefix: best, isEntry: bestIsEntry };
}

/**
 * 扫描 `bwe.xxx.yyy` 形式的**疑似拼错**成员。
 *
 * 只报「近似已知成员」的情况（编辑距离 ≤ 2），不报「表里没有」——
 * 因为 `bwe.d.ts` / `apiDocs.ts` 有时落后于 Java 实现（例如 `bwe.textinput.validate`
 * 在 ScriptApi.java 里已注册但 d.ts 里还没有），把「未知」一律报成问题会制造假警报。
 * 例：`bwe.wrold.find` → 提示「可能想写 bwe.world」。
 */
function scanUnknownBweMembers(text, masked, known) {
  const out = [];
  const re = /\bbwe\.[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*/g;
  let m;
  while ((m = re.exec(masked))) {
    const token = m[0];
    const at = m.index;
    if (known.entries.has(token)) continue;
    const { prefix, isEntry } = longestKnownPrefix(token, known);
    if (!prefix || isEntry) continue; // 已知属性下的子字段，不判
    const rest = token.slice(prefix.length + 1);
    const nextSeg = rest.split(".")[0];
    if (!nextSeg) continue;
    const sibling = closestKnown(prefix, nextSeg, known);
    if (!sibling) continue;
    const segAt = at + prefix.length + 1;
    out.push(
      diag(
        text,
        segAt,
        nextSeg.length,
        "warning",
        "W002",
        `可能拼错：${prefix}.${nextSeg}，是不是想写 ${prefix}.${sibling}？`
      )
    );
  }
  return out;
}

/**
 * 在同命名空间里找与 segment 编辑距离 ≤2 的已知名字（取最近的）。
 * 候选取自「条目」与「命名空间」两者：`bwe.world` 本身是命名空间（const world: World），
 * 不在 entries 里，但把 `bwe.wrold` 拼错时最该提示的就是它。
 */
function closestKnown(prefix, segment, known) {
  const scope = prefix + ".";
  let best = "";
  let bestD = 99;
  const consider = (rest) => {
    if (rest.includes(".")) return; // 只比同层
    const d = editDistance(rest.toLowerCase(), segment.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = rest;
    }
  };
  for (const entry of known.entries) {
    if (entry.startsWith(scope)) consider(entry.slice(scope.length));
  }
  for (const ns of known.namespaces) {
    if (ns.startsWith(scope)) consider(ns.slice(scope.length));
  }
  return bestD <= 2 && best ? best : "";
}

/** Levenshtein 距离（只用于短标识符，O(n*m) 足够）。 */
function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[t.length];
}

/**
 * 规则检查主入口。
 *
 * @param {string} source 脚本源码
 * @param {object} [opts]
 * @param {boolean} [opts.enableRules=true]
 * @param {object} [opts.index] lib/apiIndex 模块（传进来便于测试注入）
 * @param {object[]} [opts.apis] 直接给条目表（测试用）
 * @returns {{diagnostics: object[], masked: string}}
 */
function analyze(source, opts) {
  const options = opts || {};
  const text = String(source || "");
  const masked = maskSource(text);
  const diagnostics = [];
  if (options.enableRules === false) return { diagnostics, masked };

  // ---- E001 import ----
  {
    const re = /(?:^|[;{}])\s*import\s*(?:[\s\S]*?\s*from\s*|\s+)?(?=["']|\{|\*)/gm;
    let m;
    while ((m = re.exec(masked))) {
      const idx = m.index + m[0].indexOf("import");
      diagnostics.push(diag(text, idx, "import".length, "error", "E001", RULES.E001));
    }
    // `import(` 动态导入
    const dyn = /\bimport\s*\(/g;
    while ((m = dyn.exec(masked))) {
      diagnostics.push(diag(text, m.index, "import".length, "error", "E001", `${RULES.E001}（动态 import() 同样不支持）`));
    }
  }

  // ---- E002 require ----
  diagnostics.push(...scanIdentifier(text, masked, "require", "error", "E002", RULES.E002, { allowMember: false }));

  // ---- E003 export / module.exports ----
  {
    const re = /\bexport\s+(?:default|const|let|var|function|class|\{|\*)/g;
    let m;
    while ((m = re.exec(masked))) {
      diagnostics.push(diag(text, m.index, 6, "error", "E003", RULES.E003));
    }
    const assigned = /(?:module\.exports|exports\.)\s*[A-Za-z0-9_$[]?[=]/g;
    while ((m = assigned.exec(masked))) {
      diagnostics.push(diag(text, m.index, 6, "error", "E003", RULES.E003));
    }
  }

  // ---- E004 宿主对象 ----
  for (const name of HOST_OBJECTS) {
    diagnostics.push(...scanIdentifier(text, masked, name, "error", "E004", `${RULES.E004}：${name}`));
  }
  for (const name of HOST_CALLS) {
    diagnostics.push(...scanIdentifier(text, masked, name, "error", "E004", `${RULES.E004}：${name}()`));
  }

  // ---- E005 定时器 ----
  for (const name of TIMERS) {
    diagnostics.push(
      ...scanIdentifier(text, masked, name, "warning", "E005", `${RULES.E005}（${name} 改成 bwe.after / bwe.every）`)
    );
  }

  // ---- W001 console ----
  diagnostics.push(
    ...scanIdentifier(text, masked, "console", "warning", "W001", RULES.W001, { allowCall: false, allowMember: true })
  );

  // ---- E006 onSceneStart / onSceneEnd 里的 ctx.self ----
  for (const fn of ["onSceneStart", "onSceneEnd"]) {
    const body = findFunctionBody(masked, fn);
    if (!body) continue;
    const slice = masked.slice(body.start, body.end);
    const re = /\bctx\s*\.\s*self\b/g;
    let m;
    while ((m = re.exec(slice))) {
      const at = body.start + m.index;
      diagnostics.push(
        diag(text, at, "ctx.self".length, "error", "E006", `${RULES.E006}：${fn} 是场景脚本，ctx.self 恒为 null`)
      );
    }
  }

  // ---- W002 未知 bwe 成员 ----
  if (options.index || options.apis) {
    const known = buildKnownNames(options.index, options.apis);
    diagnostics.push(...scanUnknownBweMembers(text, masked, known));
    // `bwe.` 后直接跟空（`bwe.(`）的语法错误交给 TS 检查，不在这里报
  }

  // ---- W003 eval ----
  diagnostics.push(...scanIdentifier(text, masked, "eval", "warning", "W003", RULES.W003, { allowMember: false }));

  // 去重 + 排序（同位置同规则只留一条）
  const seen = new Set();
  const unique = [];
  for (const d of diagnostics) {
    const key = `${d.line}:${d.col}:${d.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(d);
  }
  unique.sort((a, b) => a.line - b.line || a.col - b.col || a.rule.localeCompare(b.rule));
  return { diagnostics: unique, masked };
}

/** 规则清单（README 与测试共用，避免两处漂移）。 */
function ruleCatalog() {
  return Object.keys(RULES).map((code) => ({
    code,
    severity: code.startsWith("E") ? "error" : "warning",
    message: RULES[code],
  }));
}

module.exports = {
  analyze,
  maskSource,
  positionOf,
  findFunctionBody,
  ruleCatalog,
  RULES,
  HOST_OBJECTS,
  HOST_CALLS,
  TIMERS,
};
