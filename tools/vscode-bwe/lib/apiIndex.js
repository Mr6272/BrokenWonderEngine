/**
 * BWE API 数据表索引（纯 Node，不依赖 `vscode`，可以直接在测试里跑）。
 *
 * 数据来自 `data/bwe-api.json`，那个文件由 `web/tools/gen-vscode-api.mjs` 从
 * `web/src/data/apiDocs.ts` + `web/src/js/bwe.d.ts` + `web/src/js/globals.d.ts` + `docs/api/*.md`
 * 生成。**扩展里不允许手抄 API 名字**，所有补全 / 悬浮 / 签名帮助都走这里。
 *
 * 加载失败（文件缺失 / JSON 坏）不抛异常：退化成空表，扩展照样能用规则检查。
 */

"use strict";

const path = require("node:path");

/** 生命周期全局函数名（globals.d.ts 里声明的那一组；运行时按名字派发）。 */
const LIFECYCLE = [
  "onStart",
  "onUpdate",
  "onClick",
  "onEnter",
  "onLeave",
  "onInteract",
  "onDamage",
  "onDeath",
  "onDestroy",
  "onKey",
  "onSceneStart",
  "onSceneEnd",
];

/** 生命周期参数表：用于 snippet 与签名帮助（与 globals.d.ts 一致）。 */
const LIFECYCLE_PARAMS = {
  onStart: "ctx",
  onUpdate: "ctx, dt",
  onClick: "ctx",
  onEnter: "ctx, other",
  onLeave: "ctx, other",
  onInteract: "ctx, actor",
  onDamage: "ctx, amount, from",
  onDeath: "ctx, by",
  onDestroy: "ctx",
  onKey: "ctx, key",
  onSceneStart: "ctx",
  onSceneEnd: "ctx",
};

/** 只有场景脚本才会被派发的生命周期（这些函数里 ctx.self 是 null）。 */
const SCENE_SCOPED = ["onSceneStart", "onSceneEnd"];

let cached = null;

/**
 * 加载数据表。
 * @param {string} [dataFile] 覆盖路径（测试用）；默认 `data/bwe-api.json`
 * @returns {{apis: object[], groups: object[], groupOrder: string[], meta: object, error?: string}}
 */
function loadTable(dataFile) {
  if (!dataFile && cached) return cached;
  const file = dataFile || path.join(__dirname, "..", "data", "bwe-api.json");
  const empty = { apis: [], groups: [], groupOrder: [], meta: {}, error: "" };
  let raw;
  try {
    // 用 require 而不是 readFile：扩展宿主里同步、带缓存，且打包 vsix 后路径不变。
    // eslint-disable-next-line import/no-dynamic-require
    raw = require(file);
  } catch (e) {
    const result = { ...empty, error: `加载 ${file} 失败：${e && e.message ? e.message : String(e)}` };
    if (!dataFile) cached = result;
    return result;
  }
  if (!raw || !Array.isArray(raw.apis)) {
    const result = { ...empty, error: `${file} 结构不对（缺少 apis 数组）` };
    if (!dataFile) cached = result;
    return result;
  }
  const result = {
    apis: raw.apis,
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    groupOrder: Array.isArray(raw.groupOrder) ? raw.groupOrder : [],
    meta: raw.meta && typeof raw.meta === "object" ? raw.meta : {},
    error: "",
    map: buildMap(raw.apis),
  };
  if (!dataFile) cached = result;
  return result;
}

function buildMap(apis) {
  const map = new Map();
  for (const api of apis) {
    if (api && typeof api.name === "string") map.set(api.name, api);
  }
  return map;
}

function getTable() {
  return loadTable();
}

/** 全表条目（只读副本，避免调用方改到缓存）。 */
function allApis() {
  return getTable().apis.slice();
}

/** 精确查一条。 */
function lookup(name) {
  const t = getTable();
  return t.map ? t.map.get(name) || null : null;
}

/**
 * 前缀过滤：`bwe.` / `bwe.w` / `bwe.world` / `bwe.world.f` 都能用。
 *
 * 排序规则（贴合使用感）：
 *   1. 名字更短（浅层级）的排前面，避免 `bwe.world.find` 被一堆子成员淹掉；
 *   2. 同长度的按字母序。
 * @param {string} prefix 已经是小写前缀（调用方负责 lower）
 * @param {number} [limit]
 */
function filterByPrefix(prefix, limit) {
  const t = getTable();
  const p = String(prefix || "").toLowerCase();
  if (!t.apis.length) return [];
  const hits = [];
  for (const api of t.apis) {
    if (!api || typeof api.name !== "string") continue;
    if (!p || api.name.toLowerCase().startsWith(p)) hits.push(api);
  }
  hits.sort((a, b) => {
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const n = typeof limit === "number" && limit > 0 ? limit : hits.length;
  return hits.slice(0, n);
}

/** `bwe.world.find` → ["bwe", "world", "find"]（只按点切，签名里的括号不参与）。 */
function splitName(name) {
  return String(name || "")
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 从一行的光标前缀里判断「正在补全什么」。
 *
 * 返回：
 *   {kind:"member", prefix:"bwe.world.f", segment:"f"}  —— bwe 成员补全
 *   {kind:"namespace", prefix:"bwe"}                     —— 只打了 bwe，提示命名空间/顶层函数
 *   {kind:"lifecycle", prefix:"onS"}                     —— 生命周期函数骨架补全
 *   {kind:"none"}
 *
 * @param {string} linePrefix 光标所在行、光标之前的文本
 */
function completionContext(linePrefix) {
  const text = String(linePrefix || "");
  const trimmed = text.trimStart();
  const m = /(bwe\.[A-Za-z0-9_$.*]*)$/.exec(text);
  if (m) {
    const typed = m[1];
    // `bwe.` 后面已是一个完整方法名 + `(` 时不补全
    const parts = typed.split(".");
    const segment = parts[parts.length - 1];
    if (typed === "bwe." || typed === "bwe") {
      return { kind: "namespace", prefix: "bwe", segment: "" };
    }
    return { kind: "member", prefix: typed, segment: segment };
  }
  if (/^bwe$/.test(trimmed) && text.length <= 3) return { kind: "namespace", prefix: "bwe", segment: "" };
  const lifeRe = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (lifeRe) {
    const seg = lifeRe[1];
    const matched = LIFECYCLE.filter((n) => n.toLowerCase().startsWith(seg.toLowerCase()));
    if (matched.length) return { kind: "lifecycle", prefix: seg, segment: seg };
  }
  return { kind: "none" };
}

/**
 * 补全候选（VS Code 侧的 CompletionItem 由 extension.js 负责，这里只给纯数据）。
 * @returns {{name:string, label:string, signature:string, summary:string, group:string, link:string, kind:string}[]}
 */
function completionCandidates(ctx) {
  if (!ctx || ctx.kind === "none") return [];
  const t = getTable();
  if (ctx.kind === "namespace") {
    // 只打了 `bwe`：给出全部顶层成员（含命名空间本身），按名字短→长排序
    return filterByPrefix("bwe.", 200).map(toCandidate);
  }
  if (ctx.kind === "lifecycle") {
    return LIFECYCLE.filter((n) => n.toLowerCase().startsWith(ctx.segment.toLowerCase())).map((name) => ({
      name,
      label: name,
      signature: `function ${name}(${LIFECYCLE_PARAMS[name] || "ctx"})`,
      summary: "BWE 生命周期函数（运行时按事件按名字派发；没定义就跳过）",
      group: "life",
      link: "",
      kind: "lifecycle",
      snippet: true,
    }));
  }
  if (t.apis.length === 0) return [];
  const prefix = ctx.prefix.toLowerCase();
  return filterByPrefix(prefix, 300).map(toCandidate);
}

/**
 * 纯函数补齐入口（测试与 extension.js 都走它）：
 * 给光标所在行的前缀文本，返回补全结果。
 *
 * @param {string} linePrefix 光标之前、同一行的文本
 * @returns {{kind:"none"|"member"|"namespace"|"lifecycle", prefix:string, items:object[]}}
 */
function completePrefix(linePrefix) {
  const ctx = completionContext(linePrefix);
  if (ctx.kind === "none") return { kind: "none", prefix: ctx.prefix || "", items: [] };
  return { kind: ctx.kind, prefix: ctx.prefix, items: completionCandidates(ctx) };
}

function toCandidate(api) {
  const parts = splitName(api.name);
  const label = parts[parts.length - 1] || api.name;
  return {
    name: api.name,
    label,
    signature: api.signature || api.name,
    summary: api.summary || "",
    group: api.group || "",
    groupLabel: api.groupLabel || api.group || "",
    link: api.link || "",
    kind: api.kind || "member",
    typeOnly: !!api.typeOnly,
  };
}

/**
 * 找出文本位置（offset）所在的 `bwe.a.b` / `e.name` 成员名。
 *
 * 用「标识符链 + 点」的字符扫描，不依赖正则回溯，也不会把字符串里的名字当成 API
 * （调用方传进来的文本应该已经丢掉注释/字符串，或者接受这一点用于 hover 的近似判断）。
 *
 * @param {string} text 整行（或整个文档中该行）
 * @param {number} col  0 基列号
 * @returns {string|null}
 */
function memberAtOffset(text, col) {
  const src = String(text || "");
  const pos = Math.max(0, Math.min(src.length, col));
  // 找出包含 pos 的标识符链：允许 a.b.c，字符集为字母数字 _$ 与点
  let start = pos;
  while (start > 0 && /[A-Za-z0-9_$.]/.test(src[start - 1])) start--;
  let end = pos;
  while (end < src.length && /[A-Za-z0-9_$.]/.test(src[end])) end++;
  let token = src.slice(start, end);
  if (!/[A-Za-z_$]/.test(token)) return null;
  // 不在光标上（例如悬停在空白处）时，尝试向左吃一个链
  if (start === pos && end === pos) {
    // 光标紧跟成员名后面：`bwe.world.find|` → 向左取
    let s2 = pos;
    while (s2 > 0 && /[A-Za-z0-9_$.]/.test(src[s2 - 1])) s2--;
    token = src.slice(s2, pos);
  }
  token = token.replace(/^\.+/, "").replace(/\.+$/, "");
  return token && /^[A-Za-z_$]/.test(token) ? token : null;
}

/**
 * 把悬停到的 token 归一成表里的名字。
 *
 * 规则（宁可不显示，也不瞎猜 —— 悬停错了比没有更糟）：
 *   - `bwe.xxx.yyy`：原样查表；
 *   - `e.xxx` / `Entity.xxx`：归一成 `e.xxx` 再查表（Entity 成员在表里就是 e.xxx）；
 *   - 其它前缀（`player.setPos` / `ctx.self.x`）一律返回 null：那些是局部变量 / 属性路径，
 *     不是 API 名字，猜成 `e.setPos` 反而误导。
 *
 * @param {string} token memberAtOffset 得到的标识符链
 * @param {string} [lineText] 所在行（保留参数，供未来扩展按上下文判断）
 * @param {number} [col]
 */
function resolveHoverName(token, lineText, col) {
  const t = String(token || "").replace(/^\.+/, "").replace(/\.+$/, "");
  if (!t) return null;
  if (/^bwe(\.[A-Za-z0-9_$]+)+$/.test(t) && lookup(t)) return t;
  if (/^(e|Entity)\.[A-Za-z0-9_$]+$/.test(t)) {
    const name = "e." + t.split(".").slice(1).join(".");
    if (lookup(name)) return name;
  }
  // 生命周期全局函数在表里是裸名字（onStart / onUpdate …）
  if (/^[A-Za-z_$][\w$]*$/.test(t) && LIFECYCLE.includes(t)) return t;
  return null;
}

/**
 * 签名帮助用的参数表：把 `bwe.draw.text(x, y, text, opts?)` 拆出参数标签。
 * @returns {{name:string, parameters:string[], signature:string}|null}
 */
function signatureForMember(name) {
  const api = lookup(name);
  if (!api) return null;
  const sig = String(api.signature || api.name);
  const open = sig.indexOf("(");
  const close = open >= 0 ? sig.lastIndexOf(")") : -1;
  if (open < 0 || close < open) {
    return { name, signature: sig, parameters: [], documentation: api.summary || "", link: api.link || "" };
  }
  const inner = sig.slice(open + 1, close).trim();
  const parameters = inner
    ? splitParams(inner).map((p) => formatParamLabel(p.trim()))
    : [];
  return {
    name,
    signature: `${api.name}(${inner})`,
    parameters,
    documentation: [api.summary, api.groupLabel ? `分组：${api.groupLabel}` : ""].filter(Boolean).join("\n"),
    link: api.link || "",
  };
}

/** 按逗号切参数，但忽略 `{}` / `[]` / `()` / `<>` 里的逗号。 */
function splitParams(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  let quote = "";
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * 参数在签名帮助里的「标签」：
 *   `x`                       → "x"
 *   `opts = {}`               → "opts"
 *   `{size = 16, color = "…"}` → "{size, color, …}"（对象解构式参数，显示成一行更可读）
 */
function formatParamLabel(raw) {
  const p = String(raw || "").trim();
  if (!p) return p;
  if (p.startsWith("{")) {
    const inner = p.slice(1, p.lastIndexOf("}") >= 0 ? p.lastIndexOf("}") : p.length).trim();
    if (!inner) return "{}";
    const keys = splitParams(inner)
      .map((k) => {
        const t = k.trim();
        const name = /^([A-Za-z_$][\w$]*)/.exec(t);
        return name ? name[1] : t;
      })
      .filter(Boolean);
    return keys.length > 3 ? `{${keys.slice(0, 3).join(", ")}, …}` : `{${keys.join(", ")}}`;
  }
  const eq = p.indexOf("=");
  const noDefault = eq >= 0 ? p.slice(0, eq).trim() : p;
  return (noDefault || p).replace(/\s+/g, " ");
}

/**
 * 纯函数悬浮入口：给整行文本与 0 基列号，返回该位置的 API 条目（找不到返回 null）。
 * @param {string} lineText 该行文本
 * @param {number} col 0 基列号
 * @returns {object|null}
 */
function hoverFor(lineText, col) {
  const token = memberAtOffset(lineText, col);
  if (!token) return null;
  const name = resolveHoverName(token, lineText, col);
  if (!name) return null;
  return lookup(name);
}

/**
 * 表自检（`test/table.test.mjs` 与 `--check` 都会用）：
 *   - 条目数 > 250
 *   - 名字唯一
 *   - 每条都有 signature / summary / group / link
 *   - 12 个生命周期函数都在表里
 * @returns {{ok:boolean, problems:string[], stats:object}}
 */
function validateTable() {
  const t = getTable();
  const problems = [];
  if (!t.apis.length) problems.push(t.error || "数据表为空");
  if (t.apis.length <= 250) problems.push(`条目数 ${t.apis.length} 未超过 250`);
  const names = t.apis.map((a) => a.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) problems.push(`名字重复：${dup.slice(0, 5).join(", ")}`);
  const missing = t.apis.filter((a) => !a.signature || !a.summary || !a.group || !a.link);
  if (missing.length) problems.push(`${missing.length} 条缺字段：${missing.slice(0, 5).map((a) => a.name).join(", ")}`);
  const lifeMissing = LIFECYCLE.filter((n) => !t.map.has(n));
  if (lifeMissing.length) problems.push(`生命周期函数缺条目：${lifeMissing.join(", ")}`);
  const groupsMissing = t.apis.filter((a) => !t.groups.some((g) => g.id === a.group));
  if (groupsMissing.length) problems.push(`${groupsMissing.length} 条的 group 不在 groups 列表里`);
  return {
    ok: problems.length === 0,
    problems,
    stats: {
      count: t.apis.length,
      typeOnly: t.apis.filter((a) => a.typeOnly).length,
      docBacked: t.apis.filter((a) => !a.typeOnly).length,
      groups: t.groups.length,
      lifecycle: LIFECYCLE.length,
      withDocAnchor: t.apis.filter((a) => String(a.link || "").includes("#")).length,
    },
  };
}

module.exports = {
  LIFECYCLE,
  LIFECYCLE_PARAMS,
  SCENE_SCOPED,
  loadTable,
  allApis,
  lookup,
  filterByPrefix,
  splitName,
  completionContext,
  completionCandidates,
  completePrefix,
  memberAtOffset,
  resolveHoverName,
  hoverFor,
  signatureForMember,
  splitParams,
  validateTable,
};
