#!/usr/bin/env node
/**
 * 生成 VS Code 扩展的数据表：tools/vscode-bwe/data/bwe-api.json
 *
 * 事实来源（**不手抄、不猜名字**）：
 *   1. `web/src/data/apiDocs.ts`   —— 编辑器右侧「API 速查」的数据（{name, signature, desc, group}）
 *   2. `web/src/js/bwe.d.ts`       —— 脚本契约的类型声明（declare namespace bwe）
 *   3. `web/src/js/globals.d.ts`   —— 生命周期全局函数（onStart / onUpdate …）
 *   4. `docs/api/*.md`             —— Unity 风格文档页（hover 里的文档链接指向这里）
 *
 * 做法：
 *   - apiDocs.ts 是 TypeScript，**用 esbuild（仓库已有 devDependency）打包成临时 mjs 再 import**，
 *     不用正则去啃 TS 里带引号的字符串。
 *   - bwe.d.ts 用「把注释替换成等长空格」的遮罩扫描器解析（偏移量与原文对齐），
 *     `interface` / `const x: {...}` / `function` 三类成员按花括号深度切分，
 *     再回原文取 JSDoc 当摘要。
 *   - 文档链接（`docs/api/<page>.md#<anchor>`）按 GitHub 的标题锚点规则从 docs/api 的标题生成。
 *   - 自检：条目数 > 250、名字唯一、bwe.d.ts 里每个**值成员**都能在表里找到
 *     （要么来自 apiDocs，要么作为「只有类型没有文档」的 typeOnly 条目显式记录）。
 *
 * 用法：
 *   node web/tools/gen-vscode-api.mjs            # 生成 + 自检（失败退出码 1）
 *   node web/tools/gen-vscode-api.mjs --check    # 只校验磁盘上的文件是否与源码同步（不写盘）
 *   node web/tools/gen-vscode-api.mjs --json     # 额外把生成结果打到 stdout
 *
 * 退出码：0 = 通过；1 = 自检失败或 --check 发现过期；2 = 环境问题（找不到 esbuild / 源码）。
 */

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const ROOT = resolve(WEB_ROOT, "..");
const OUT_DIR = join(ROOT, "tools", "vscode-bwe", "data");
const OUT_FILE = join(OUT_DIR, "bwe-api.json");
const DTS_OUT = join(OUT_DIR, "bwe.d.ts");
const TMP_DIR = join(ROOT, "tools", "vscode-bwe", ".tmp");
const TMP_BUNDLE = join(TMP_DIR, "apiDocs.bundle.mjs");

const SRC_DTS = join(WEB_ROOT, "src", "js", "bwe.d.ts");
const SRC_GLOBALS = join(WEB_ROOT, "src", "js", "globals.d.ts");
const SRC_DOCS = join(WEB_ROOT, "src", "data", "apiDocs.ts");
const DOCS_API_DIR = join(ROOT, "docs", "api");

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const JSON_OUT = args.includes("--json");

const problems = [];
const notes = [];
function fail(msg) {
  problems.push(msg);
}
function ok(msg) {
  notes.push(msg);
}

// ============================================================================
// 通用：文件与哈希
// ============================================================================

function readText(p) {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ============================================================================
// bwe.d.ts 解析
// ============================================================================

/** 把注释替换成等长空格（换行保留），使偏移量与原文一一对应，字符串原样保留。 */
function maskComments(src) {
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
    } else {
      out += c;
    }
  }
  return out;
}

/** 跳过字符串字面量（含模板串的基本处理），返回结束引号之后的下标。 */
function skipString(src, i) {
  const q = src[i];
  i += 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    i += 1;
  }
  return i;
}

/** 从 openIdx 的花括号开始找匹配的闭括号下标（忽略字符串里的括号）。 */
function matchBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i) - 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 在 body 里按「花括号/圆括号/方括号深度 0」切出顶层语句。
 * 终止符：`;` 或闭合到深度 0 的 `}`（接口体 / 对象字面量成员不用分号结尾）。
 * 返回 [{text, offset}]，offset 是相对 body 的起点。
 */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(body, i) - 1;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0 && c === "}") {
        out.push({ text: body.slice(start, i + 1), offset: start });
        start = i + 1;
      }
    }
    if (depth === 0 && c === ";") {
      out.push({ text: body.slice(start, i + 1), offset: start });
      start = i + 1;
    }
  }
  const tail = body.slice(start);
  if (tail.trim()) out.push({ text: tail, offset: start });
  return out;
}

/** 收集所有 /** ... *\/ 块，供「成员前面的 JSDoc」查询。 */
function collectDocBlocks(raw) {
  const blocks = [];
  const re = /\*\//g;
  let m;
  while ((m = re.exec(raw))) {
    const end = m.index + 2;
    // 往前找最近的 /**
    let start = -1;
    for (let i = end - 2; i >= 0; i--) {
      if (raw[i] === "/" && raw[i + 1] === "*") {
        start = i;
        break;
      }
      if (raw[i] === "*" && raw[i - 1] === "/") break; // 撞到上一个块的结尾，说明不是块开头
    }
    if (start < 0) continue;
    blocks.push({ start, end, text: raw.slice(start + 2, end - 2) });
    re.lastIndex = end;
  }
  return blocks;
}

/** 取某成员（偏移量）正上方紧邻的 JSDoc 摘要（首句，去掉 @tag 行）。 */
function docSummaryAbove(raw, blocks, memberOffset) {
  let best = null;
  for (const b of blocks) {
    if (b.end > memberOffset) break;
    const between = raw.slice(b.end, memberOffset);
    if (/^[ \t\n]*$/.test(between)) best = b;
  }
  if (!best) return "";
  const text = best.text
    .split(/\n/)
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter((l) => l && !l.startsWith("@"))
    .join(" ");
  // 只留首句，避免 hover 太长
  const first = text.split(/。(?=\s|$)/)[0].trim();
  return first.slice(0, 160);
}

/** 解析成员声明：`name(...)` / `name: type` / `readonly name: type` / `name<T>(...)`。 */
function parseMember(text) {
  const t = text.trim().replace(/\s+/g, " ").replace(/;+\s*$/, "");
  if (!t || t.startsWith("//")) return null;
  if (/^(new|readonly)\s+new/.test(t)) return null;
  let m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*<[^>]*>\s*\(/.exec(t);
  if (m) return { kind: "method", name: m[1] };
  m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(t);
  if (m) return { kind: "method", name: m[1] };
  m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*:\s*([\s\S]+)$/.exec(t);
  if (m) return { kind: "property", name: m[1], type: m[2].trim() };
  return null;
}

/** method 签名 → "bwe.ns.member(params) → ret"；property → "bwe.ns.member → type"。 */
function formatSignature(prefix, text, member) {
  if (member.kind === "property") {
    return `${prefix}${member.name} → ${shrinkType(member.type)}`;
  }
  const t = text.trim().replace(/\s+/g, " ");
  const parenOpen = t.indexOf("(");
  if (parenOpen < 0) return `${prefix}${member.name}()`;
  const closeIdx = matchParen(t, parenOpen);
  const params = closeIdx >= 0 ? t.slice(parenOpen + 1, closeIdx) : t.slice(parenOpen + 1);
  const ret = closeIdx >= 0 ? t.slice(closeIdx + 1).replace(/^[:\s]+/, "").replace(/;\s*$/, "").trim() : "";
  const paramText = params
    .split(/,/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");
  return ret ? `${prefix}${member.name}(${paramText}) → ${shrinkType(ret)}` : `${prefix}${member.name}(${paramText})`;
}

function matchParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i) - 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function shrinkType(type) {
  return String(type)
    .replace(/\s+/g, " ")
    .replace(/:\s+/g, ": ")
    .trim()
    .slice(0, 180);
}

/**
 * 从 bwe.d.ts 抽出全部**值成员**（排除 interface/type 这类纯类型）。
 * 返回 { members: [{name, signature, summary, ns}], interfaces: Map<name, members[]> }
 */
function extractDts(raw) {
  const masked = maskComments(raw);
  const blocks = collectDocBlocks(raw);
  const nsStart = masked.indexOf("declare namespace bwe");
  if (nsStart < 0) throw new Error("bwe.d.ts 里找不到 `declare namespace bwe`");
  const nsBrace = masked.indexOf("{", nsStart);
  const nsEnd = matchBrace(masked, nsBrace);
  if (nsBrace < 0 || nsEnd < 0) throw new Error("bwe.d.ts 的 namespace bwe 花括号不匹配");
  const nsBodyStart = nsBrace + 1;
  const nsBody = masked.slice(nsBodyStart, nsEnd);

  const interfaces = new Map();
  const values = [];
  const consts = []; // 延迟展开：interface 可能写在 const 之后

  for (const stmt of splitTopLevel(nsBody)) {
    const text = stmt.text.trim();
    if (!text) continue;
    const stmtOffset = nsBodyStart + stmt.offset;
    let m = /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(text);
    if (m) {
      const brace = text.indexOf("{");
      const end = matchBrace(text, brace);
      if (brace >= 0 && end > brace) {
        const bodyText = text.slice(brace + 1, end);
        const bodyOffsetInText = brace + 1;
        const members = [];
        for (const mem of splitTopLevel(bodyText)) {
          const memText = mem.text.trim();
          if (!memText || memText.startsWith("}")) continue;
          const parsed = parseMember(memText);
          if (!parsed) continue;
          members.push({
            name: parsed.name,
            text: memText,
            summary: docSummaryAbove(raw, blocks, stmtOffset + bodyOffsetInText + mem.offset),
          });
        }
        interfaces.set(m[1], members);
      }
      continue;
    }
    m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(text);
    if (m) {
      const name = m[1];
      const typeText = m[2].replace(/;\s*$/, "").trim();
      const summary = docSummaryAbove(raw, blocks, stmtOffset);
      if (typeText.startsWith("{")) {
        const brace = typeText.indexOf("{");
        const end = matchBrace(typeText, brace);
        const bodyText = typeText.slice(brace + 1, end);
        const bodyOffset = stmtOffset + typeText.indexOf(bodyText);
        for (const mem of splitTopLevel(bodyText)) {
          const memText = mem.text.trim();
          if (!memText || memText.startsWith("}")) continue;
          const parsed = parseMember(memText);
          if (!parsed) continue;
          values.push({
            name: `bwe.${name}.${parsed.name}`,
            signature: formatSignature(`bwe.${name}.`, memText, parsed),
            summary: docSummaryAbove(raw, blocks, bodyOffset + mem.offset) || summary,
            ns: name,
          });
        }
      } else {
        consts.push({ name, typeRef: typeText, summary });
      }
      continue;
    }
    m = /^(?:declare\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(text);
    if (m) {
      values.push({
        name: `bwe.${m[1]}`,
        signature: formatSignature("bwe.", text, { kind: "method", name: m[1] }),
        summary: docSummaryAbove(raw, blocks, stmtOffset),
        ns: "(root)",
      });
      continue;
    }
  }

  // 展开 `const world: World` → bwe.world（命名空间条目）+ bwe.world.find 等成员
  for (const c of consts) {
    const iface = interfaces.get(c.typeRef);
    if (!iface) {
      values.push({ name: `bwe.${c.name}`, signature: `bwe.${c.name} → ${shrinkType(c.typeRef)}`, summary: c.summary, ns: c.name, typeRef: c.typeRef });
      continue;
    }
    // 命名空间本身也作为一条（hover 悬停在 `bwe.world` 上时用）
    values.push({
      name: `bwe.${c.name}`,
      signature: `bwe.${c.name} → ${c.typeRef}`,
      summary: c.summary || `${c.typeRef} 命名空间`,
      ns: c.name,
      isNamespace: true,
    });
    for (const mem of iface) {
      const parsed = parseMember(mem.text);
      if (!parsed) continue;
      values.push({
        name: `bwe.${c.name}.${mem.name}`,
        signature: formatSignature(`bwe.${c.name}.`, mem.text, parsed),
        summary: mem.summary || c.summary,
        ns: c.name,
      });
    }
  }
  return { members: values, interfaces, consts };
}

/** globals.d.ts 里 declare function 的名字（生命周期全局函数）。 */
function extractGlobals(raw) {
  const names = [];
  const masked = maskComments(raw);
  for (const m of masked.matchAll(/declare\s+function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/g)) {
    names.push(m[1]);
  }
  return names;
}

// ============================================================================
// docs/api 索引（hover 的文档链接）
// ============================================================================

/** GitHub 标题锚点：小写；只保留字母数字 / `-` / `_` / 空格；空格换成 `-`（不折叠）。 */
function ghAnchor(text) {
  let out = "";
  for (const ch of String(text).toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(ch) || ch === "-" || ch === "_") out += ch;
    else if (ch === " ") out += "-";
  }
  return out;
}

/**
 * 从标题里抽成员名：`### bwe.world.find(q) → Entity | null`、`### e.x / e.y → number`、
 * `### onStart(ctx) → void`、`### Entity.setPos(x, y) → void`。
 * 只认「成员名形态」的开头，避免把 `## 一、地图信息` 当成成员。
 */
function headingMembers(text) {
  const head = text.replace(/`/g, "").trim();
  const first = /^([^\s]+)/.exec(head);
  if (!first) return [];
  const token = first[1].replace(/\([\s\S]*$/, "");
  const parts = token.split(/\s*[\/、]\s*/).map((s) => s.trim()).filter(Boolean);
  const names = [];
  for (const p of parts) {
    if (/^(bwe|e|Entity)\.[A-Za-z0-9_$./]+$/.test(p) || /^[A-Za-z_$][\w$]*$/.test(p)) names.push(p);
  }
  // `e.x / e.y`：第一个 token 是 `e.x`，后面的 `e.y` 在 head 里
  for (const m of head.matchAll(/\s(?:[\/、]\s*)?(e|Entity|bwe)\.([A-Za-z0-9_$]+)/g)) {
    const name = `${m[1]}.${m[2]}`;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function buildDocsIndex(docsDir) {
  const index = new Map(); // normalized name -> {page, anchor, heading}
  const pages = [];
  if (!existsSync(docsDir)) return { index, pages };
  for (const file of readdirSync(docsDir)) {
    if (!file.endsWith(".md")) continue;
    pages.push(file);
    const lines = readText(join(docsDir, file)).split("\n");
    for (const line of lines) {
      const m = /^(#{1,4})\s+([\s\S]*)$/.exec(line);
      if (!m) continue;
      const heading = m[2].trim();
      const anchor = ghAnchor(heading);
      for (const name of headingMembers(heading)) {
        const key = normalizeMemberName(name);
        if (!key) continue;
        if (!index.has(key)) index.set(key, { page: file, anchor, heading });
      }
    }
  }
  return { index, pages };
}

/** `Entity.xxx` → `e.xxx`，`bwe.a.b` 小写，去掉参数。 */
function normalizeMemberName(name) {
  const n = String(name).replace(/\([\s\S]*$/, "").replace(/`/g, "").trim();
  if (!n) return "";
  if (n.startsWith("Entity.")) return "e." + n.slice("Entity.".length);
  return n;
}

// ============================================================================
// esbuild 打包 apiDocs.ts 并 import
// ============================================================================

async function loadApiDocs() {
  if (!existsSync(SRC_DOCS)) throw new Error(`找不到 ${SRC_DOCS}`);
  mkdirSync(TMP_DIR, { recursive: true });
  await build({
    entryPoints: [SRC_DOCS],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: TMP_BUNDLE,
    logLevel: "silent",
    allowOverwrite: true,
  });
  const mod = await import(pathToFileURL(TMP_BUNDLE).href + `?v=${Date.now()}`);
  rmSync(TMP_BUNDLE, { force: true });
  if (!Array.isArray(mod.API_DOCS) || !Array.isArray(mod.API_GROUPS)) {
    throw new Error("apiDocs.ts 打包后没有导出 API_DOCS / API_GROUPS");
  }
  return { docs: mod.API_DOCS, groups: mod.API_GROUPS };
}

// ============================================================================
// 组 / 接口映射
// ============================================================================

/** d.ts 里的 interface 名（或顶层 const 名）→ apiDocs 的 group id。 */
const NS_TO_GROUP = {
  world: "world",
  input: "input",
  stick: "input",
  board: "map",
  textinput: "field",
  camera: "camera",
  time: "time",
  draw: "draw",
  audio: "audio",
  mine: "field",
  save: "save",
  grid: "map",
  tilemap: "map",
  nav: "nav",
  interact: "interact",
  spawner: "spawner",
  prefab: "prefab",
  pool: "prefab",
  scripts: "util",
  material: "material",
  field: "field",
  noise: "sense",
  sense: "sense",
  faction: "sense",
  ai: "sense",
  target: "sense",
  physics: "physics",
  seed: "util",
  scene: "scene",
  spatial: "spatial",
  collision: "collision",
  actions: "actions",
  road: "road",
  vehicle: "vehicle",
  combat: "combat",
  debug: "debug",
};

function groupForNs(ns, groupIds) {
  const mapped = NS_TO_GROUP[ns];
  return groupIds.has(mapped) ? mapped : groupIds.has("util") ? "util" : [...groupIds][0];
}

/** 兜底：group → 文档页（按该组已有条目命中的页做多数投票）。 */
function pagePerGroup(entries, docsIndex) {
  const votes = new Map();
  for (const e of entries) {
    const hit = docsIndex.get(normalizeMemberName(e.name));
    if (!hit) continue;
    const key = e.group;
    if (!votes.has(key)) votes.set(key, new Map());
    const m = votes.get(key);
    m.set(hit.page, (m.get(hit.page) || 0) + 1);
  }
  const out = new Map();
  for (const [group, pages] of votes) {
    let best = "";
    let bestN = -1;
    for (const [page, n] of pages) {
      if (n > bestN) {
        best = page;
        bestN = n;
      }
    }
    out.set(group, best);
  }
  return out;
}

function linkFor(name, group, docsIndex, fallbackPages) {
  const hit = docsIndex.get(normalizeMemberName(name));
  if (hit) return `docs/api/${hit.page}${hit.anchor ? "#" + hit.anchor : ""}`;
  const page = fallbackPages.get(group) || "README.md";
  return `docs/api/${page}`;
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  for (const p of [SRC_DTS, SRC_GLOBALS, SRC_DOCS]) {
    if (!existsSync(p)) {
      console.error(`✗ 缺少事实来源文件：${p}`);
      process.exit(2);
    }
  }

  const rawDts = readText(SRC_DTS);
  const rawGlobals = readText(SRC_GLOBALS);
  const { docs, groups } = await loadApiDocs();

  const groupIds = new Set(groups.map((g) => g.id));
  const groupLabels = new Map(groups.map((g) => [g.id, g.label]));
  const groupBlurbs = new Map(groups.map((g) => [g.id, g.blurb]));

  // ---- 1) d.ts 值成员 / 接口 ----
  const dts = extractDts(rawDts);
  const dtsMemberNames = dts.members.map((m) => m.name);
  const dtsMemberSet = new Set(dtsMemberNames);
  const globals = extractGlobals(rawGlobals);

  // ---- 2) apiDocs 条目 ----
  const entries = [];
  const seen = new Set();
  const docEntryNames = [];
  for (const doc of docs) {
    if (!doc || typeof doc.name !== "string" || !doc.name.trim()) continue;
    const name = doc.name.trim();
    docEntryNames.push(name);
    if (seen.has(name)) continue;
    seen.add(name);
    const group = groupIds.has(doc.group) ? doc.group : groupForNs("world", groupIds);
    const isLife = group === "life" && !name.startsWith("bwe.");
    const isEntity = name.startsWith("e.") || name.startsWith("Entity.");
    entries.push({
      name,
      signature: String(doc.signature ?? name),
      summary: String(doc.desc ?? ""),
      group,
      groupLabel: groupLabels.get(group) ?? group,
      kind: isLife ? "lifecycle" : isEntity ? "entity" : name.split(".").length <= 2 ? "member" : "function",
      ...(doc.phase2 ? { phase2: true } : {}),
    });
  }

  // ---- 3) d.ts 里「只有类型没有文档」的值成员 ----
  const typeOnly = [];
  for (const member of dts.members) {
    if (seen.has(member.name)) continue;
    // `bwe.world` 这类「命名空间本身」不在 apiDocs 里，但它有接口文档 → 也算覆盖
    if (member.typeRef && dts.interfaces.has(member.typeRef)) {
      typeOnly.push({
        name: member.name,
        signature: member.signature,
        summary: member.summary || `${member.typeRef} 命名空间（docs 无速查条目）`,
        group: groupForNs(member.ns === "(root)" ? member.name.replace(/^bwe\./, "") : member.ns, groupIds),
        ns: member.ns,
      });
      continue;
    }
    typeOnly.push({
      name: member.name,
      signature: member.signature,
      summary: member.summary ? member.summary : "仅类型声明（docs/api 没有速查条目）",
      group: groupForNs(member.ns === "(root)" ? "util" : member.ns, groupIds),
      ns: member.ns,
    });
  }
  // 接口（Entity / World / Input …）里的成员若没在 apiDocs 里出现，也补成 typeOnly（便于补全/悬浮）
  for (const [iface, members] of dts.interfaces) {
    if (iface !== "Entity") continue; // 只补 Entity：脚本里的 `e.xxx` 是最高频写法
    for (const mem of members) {
      const name = `e.${mem.name}`;
      if (seen.has(name)) continue;
      seen.add(name);
      typeOnly.push({
        name,
        signature: formatSignature("e.", mem.text, { kind: mem.text.includes("(") ? "method" : "property", name: mem.name }),
        summary: mem.summary || "仅类型声明（docs/api 没有速查条目）",
        group: "entity",
        ns: "entity",
      });
    }
  }

  for (const item of typeOnly) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    const group = groupIds.has(item.group) ? item.group : groupForNs("util", groupIds);
    entries.push({
      name: item.name,
      signature: item.signature,
      summary: item.summary,
      group,
      groupLabel: groupLabels.get(group) ?? group,
      kind: item.ns === "entity" ? "entity" : item.ns === "(root)" ? "member" : "typeOnly",
      typeOnly: true,
    });
  }

  // ---- 4) 文档链接 ----
  const docsIndexInfo = buildDocsIndex(DOCS_API_DIR);
  const fallbackPages = pagePerGroup(entries, docsIndexInfo.index);
  let linked = 0;
  for (const e of entries) {
    e.link = linkFor(e.name, e.group, docsIndexInfo.index, fallbackPages);
    if (!e.typeOnly && e.link.includes("#")) linked += 1;
  }

  // ---- 5) 自检 ----
  if (entries.length <= 250) fail(`条目数 ${entries.length} 未超过 250`);
  else ok(`条目数 ${entries.length}（> 250）`);

  const dupNames = entries.map((e) => e.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dupNames.length) fail(`名字重复：${[...new Set(dupNames)].slice(0, 10).join(", ")}`);
  else ok(`名字唯一（${entries.length} 条）`);

  // bwe.d.ts 里每个值成员都要在表里（值成员来自 apiDocs 或 typeOnly）
  const covered = dts.members.filter((m) => seen.has(m.name));
  const missingDts = dts.members.filter((m) => !seen.has(m.name)).map((m) => m.name);
  if (missingDts.length) fail(`bwe.d.ts 有 ${missingDts.length} 个值成员不在表里：${missingDts.slice(0, 10).join(", ")}`);
  else ok(`bwe.d.ts 值成员全部覆盖（${covered.length}/${dts.members.length}）`);

  const coveredLife = globals.filter((g) => seen.has(g));
  const missingLife = globals.filter((g) => !seen.has(g));
  if (missingLife.length) fail(`globals.d.ts 生命周期函数缺条目：${missingLife.join(", ")}`);
  else ok(`生命周期函数全部覆盖（${coveredLife.length}/${globals.length}）`);

  // 反向一致性：apiDocs 里的 `bwe.*` / `e.*` 条目应该在 d.ts 里真实存在（只报告，不致命）
  const entityMembers = new Set((dts.interfaces.get("Entity") || []).map((m) => m.name));
  const fake = [];
  for (const doc of docs) {
    const name = String(doc.name ?? "");
    if (name.startsWith("bwe.") && !dtsMemberSet.has(name)) fake.push(name);
    else if (name.startsWith("e.") && !entityMembers.has(name.slice(2))) fake.push(name);
  }
  if (fake.length) {
    console.log(`  ⚠ apiDocs 有 ${fake.length} 条在 d.ts 里找不到同名成员（仅提示，不阻断）：${fake.slice(0, 8).join(", ")}`);
  } else {
    ok("apiDocs 条目在 bwe.d.ts / Entity 里都能找到同名成员");
  }

  const docLinkCount = entries.filter((e) => e.link.includes("#")).length;
  ok(`文档链接：${docLinkCount}/${entries.length} 条指向 docs/api 的具体小节（其余退到分组页）`);

  // 组顺序
  const groupOrder = groups.map((g) => g.id);

  const payload = {
    meta: {
      generator: "web/tools/gen-vscode-api.mjs",
      sources: {
        apiDocs: "web/src/data/apiDocs.ts",
        types: "web/src/js/bwe.d.ts",
        lifecycle: "web/src/js/globals.d.ts",
        docs: "docs/api/*.md",
      },
      sha256: {
        apiDocsTs: sha256(readText(SRC_DOCS)),
        bweDts: sha256(rawDts),
        globalsDts: sha256(rawGlobals),
      },
      apiDocsEntries: docs.length,
      dtsValueMembers: dts.members.length,
      dtsInterfaces: dts.interfaces.size,
      lifecycleFunctions: globals.length,
      entryCount: entries.length,
      docBackedCount: entries.filter((e) => !e.typeOnly).length,
      typeOnlyCount: entries.filter((e) => e.typeOnly).length,
      docsPages: docsIndexInfo.pages.length,
      docsLinkedCount: docLinkCount,
      typeOnlyMembers: entries.filter((e) => e.typeOnly).map((e) => e.name),
    },
    groupOrder,
    groups: groups.map((g) => ({ id: g.id, label: g.label, blurb: g.blurb })),
    apis: entries,
  };

  const json = JSON.stringify(payload, null, 2) + "\n";

  if (CHECK_ONLY) {
    if (!existsSync(OUT_FILE)) fail("data/bwe-api.json 不存在（先跑一次生成）");
    else {
      const disk = readFileSync(OUT_FILE, "utf8").replace(/\r\n/g, "\n");
      if (disk !== json) fail("data/bwe-api.json 与源码不同步（重跑 node web/tools/gen-vscode-api.mjs）");
      else ok("data/bwe-api.json 与源码同步");
    }
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_FILE, json, "utf8");
    // 附带一份 bwe.d.ts 拷贝：扩展装在仓库外（vsix）时 installTypes 仍可用
    writeFileSync(DTS_OUT, rawDts, "utf8");
    ok(`写入 ${relOut(OUT_FILE)}（${entries.length} 条，${(Buffer.byteLength(json) / 1024).toFixed(1)} KB）`);
    ok(`写入 ${relOut(DTS_OUT)}（bwe.d.ts 副本，供扩展离线安装类型）`);
  }

  // ---- 6) 输出 ----
  console.log(`[gen-vscode-api] apiDocs=${docs.length} 条 / bwe.d.ts 值成员=${dts.members.length} / 接口=${dts.interfaces.size} / 生命周期=${globals.length}`);
  console.log(`[gen-vscode-api] 生成条目=${entries.length}（文档条目 ${payload.meta.docBackedCount}，仅类型 ${payload.meta.typeOnlyCount}），文档页 ${docsIndexInfo.pages.length} 个，命中小节 ${docLinkCount} 条`);
  for (const n of notes) console.log(`  ✓ ${n}`);
  for (const p of problems) console.log(`  ✗ ${p}`);

  if (JSON_OUT) console.log(json);

  if (problems.length) {
    console.error(`\n✗ 自检失败（${problems.length} 项）`);
    process.exit(1);
  }
  console.log(CHECK_ONLY ? "\n✅ 数据表与源码同步" : "\n✅ 数据表已生成并通过自检");
}

function relOut(p) {
  return p.replace(ROOT + "\\", "").replace(ROOT + "/", "").replace(/\\/g, "/");
}

main().catch((e) => {
  console.error(`✗ 生成失败：${e?.stack || e}`);
  try {
    rmSync(TMP_BUNDLE, { force: true });
  } catch {
    /* 清理失败不影响退出码 */
  }
  process.exit(2);
});
