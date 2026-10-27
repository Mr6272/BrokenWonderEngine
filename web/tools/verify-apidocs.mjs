#!/usr/bin/env node
/**
 * BWE API 四方一致性扫描器（本轮「文档必须与实现一致」的核心验收工具）。
 *
 * 唯一事实来源是 **Java 实现**。另外三方是「声称的契约」：
 *   1. `web/src/js/bwe.d.ts`     —— 编辑器里给脚本用的 TS 类型（用户写代码时的补全）
 *   2. `web/src/data/apiDocs.ts` —— 编辑器右侧 API 速查表（用户照着抄的代码）
 *   3. `docs/api/*.md`           —— Unity 风格文档（对外交付的说明）
 *
 * 本工具把 Java 里**真实注册**的成员抽出来，与三方做集合比对，输出：
 *   - Java 有、某方没有        → **缺文档**（功能能用但没写/没类型 = 用户发现不了）
 *   - 某方有、Java 没有        → **编造或未实现**（用户照着抄会跑不通，最严重）
 *
 * 用法：
 *   node web/tools/verify-apidocs.mjs                 # 全量报告（人读）
 *   node web/tools/verify-apidocs.mjs --json          # 机读 JSON
 *   node web/tools/verify-apidocs.mjs --strict        # 有「编造」即退出码 1（CI 用）
 *   node web/tools/verify-apidocs.mjs --only bwe.world.find   # 只查某个成员
 *   node web/tools/verify-apidocs.mjs --docs-dir docs/api
 *
 * 退出码：0 = 无「编造」级问题（缺文档只警告）；1 = 有编造/未实现，或 --strict 下有缺失。
 *
 * ⚠ 设计要点（改之前先读）：
 *  - Java 侧的命名空间不是显式声明的，而是 `api.attach("name", obj)` 或
 *    `bwe.values.put("name", obj)`，方法用 `method(obj, "name", ...)` /
 *    `api.addMethod(obj, "name", ...)` 挂上去。所以必须做「变量 → 命名空间名」的映射，
 *    不能只按方法名做全局集合，否则会把 `x/y/w/h` 这种到处都有的 getter 张冠李戴。
 *  - getter/setter 统一展开成 `.name` 成员（JS 里读 `bwe.camera.zoom` 就是这个）。
 *  - 不解析 JS/TS AST：正则足够（这三份文件都是极度规整的声明式数据），
 *    解析器反而更脆。每处正则都写明了它假设的源码形状。
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

// ---------------- CLI ----------------

function parseArgs(argv) {
  const out = {
    json: false,
    strict: false,
    only: "",
    docsDir: "docs/api",
    verbose: false,
    maxList: 40,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--strict") out.strict = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--only") out.only = argv[++i] || "";
    else if (a === "--docs-dir") out.docsDir = argv[++i] || "docs/api";
    else if (a === "--max-list") out.maxList = Number(argv[++i] || 40);
    else if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a.startsWith("--only=")) out.only = a.slice(7);
    else if (a.startsWith("--docs-dir=")) out.docsDir = a.slice(11);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法: node web/tools/verify-apidocs.mjs [--json] [--strict] [--only <member>]
                                   [--docs-dir <dir>] [--verbose] [--max-list <n>]`);
  process.exit(0);
}

// ---------------- 通用工具 ----------------

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", ".build", "bin", "Assets", "Data", "Art",
  ".tmp_rel8", ".tmp_docsrc", ".tmp_editorjs", ".tmp",
]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".java")) out.push(p);
  }
  return out;
}

function read(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** 去掉 Java 的行注释和块注释，避免把注释里的假成员算进来。保留字符串字面量。 */
function stripJavaComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let inLine = false;
  let inBlock = false;
  let inStr = false;
  let inChar = false;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && d === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += d || "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (inChar) {
      out += c;
      if (c === "\\") {
        out += d || "";
        i += 2;
        continue;
      }
      if (c === "'") inChar = false;
      i++;
      continue;
    }
    if (c === "/" && d === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && d === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "'") {
      inChar = true;
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 把 "a\n b" / "a + \n b" 这类折行的调用压平成一行，便于正则。 */
function flattenCalls(src) {
  // 只在括号内压平行（不动字符串内容外的换行）
  let out = "";
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] || "";
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") depth = Math.max(0, depth - 1);
    if (c === "\n" && depth > 0) {
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}

// ---------------- Java 侧抽取 ----------------

/**
 * 抽取 Java 真实注册的 API 成员。
 *
 * 形状假设（都来自当前源码实际写法）：
 *   - 命名空间声明： `api.attach("sense", sense);` /  `bwe.values.put("prefab", prefabObj);`
 *   - 建对象：      `ScriptJs.Flex mat = obj();` / `Scriptable x = api.newObj();` / `Flex f = api.newFlex();`
 *   - 方法注册：    `method(obj, "name", ...)` / `api.addMethod(obj, "name", ...)`
 *   - 属性注册：    `obj.getters.put("name", ...)` / `obj.setters.put("name", ...)`
 *   - 值注册：      `obj.values.put("name", ...)`
 *
 * 返回 Map<namespace, Set<member>>，namespace 用 "bwe.xxx"，顶层 `bwe` 自己的成员记为 "bwe"。
 */
function extractJava(javaFiles) {
  /** @type {Map<string, Set<string>>} */
  const api = new Map();
  /** 变量名 → 命名空间名（同一个变量可能在不同方法里复用，最后以 attach 为准） */
  const varToNs = new Map();
  /** 顶层 bwe 的对象变量名 */
  const bweVars = new Set(["bwe"]);

  const add = (ns, member) => {
    if (!ns || !member) return;
    if (!api.has(ns)) api.set(ns, new Set());
    api.get(ns).add(member);
  };

  const contents = new Map();
  for (const f of javaFiles) {
    contents.set(f, flattenCalls(stripJavaComments(read(f))));
  }

  // 1) 先扫命名空间声明，建立 变量 → bwe.xxx 映射
  //    源码里有三套等价写法（都是把对象挂到 bwe 命名空间上）：
  //      a) `api.attach("sense", sense)`               —— 子系统自己挂
  //      b) `ScriptJs.put(bwe, "world", worldObj)`     —— ScriptApi 自己挂
  //      c) `bwe.values.put("prefab", prefabObj)`      —— 少数直接写 values
  //    第二个参数可能是**限定名**（`p.ns`），所以收 `[A-Za-z0-9_.]+` 而不是简单标识符。
  const namespaceDecls = [];
  const VAR = "([A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*)";
  const reAttach = new RegExp(
    "\\b(?:api\\.)?attach\\s*\\(\\s*\"([A-Za-z0-9_.]+)\"\\s*,\\s*" + VAR + "\\s*\\)",
    "g",
  );
  const reJsPut = new RegExp(
    "\\bScriptJs\\s*\\.\\s*put\\s*\\(\\s*bwe\\s*,\\s*\"([A-Za-z0-9_.]+)\"\\s*,\\s*" + VAR + "\\s*\\)",
    "g",
  );
  const reValuesPutNs = new RegExp(
    "\\bbwe\\s*\\.\\s*values\\s*\\.\\s*put\\s*\\(\\s*\"([A-Za-z0-9_.]+)\"\\s*,\\s*" + VAR + "\\s*\\)",
    "g",
  );
  for (const [, src] of contents) {
    let m;
    while ((m = reAttach.exec(src))) {
      namespaceDecls.push({ ns: m[1], variable: m[2] });
    }
    while ((m = reJsPut.exec(src))) {
      namespaceDecls.push({ ns: m[1], variable: m[2] });
    }
    while ((m = reValuesPutNs.exec(src))) {
      namespaceDecls.push({ ns: m[1], variable: m[2] });
    }
  }
  for (const d of namespaceDecls) {
    varToNs.set(d.variable, `bwe.${d.ns}`);
    // 限定名的**最后一段**也要映射：源码里 `api.attach("physics", p.ns)` 之后，
    // 方法是在字段 `ns` 上注册的（`api.addMethod(ns, "enable", ...)`），不是 `p.ns`。
    const dot = d.variable.lastIndexOf(".");
    if (dot > 0) {
      const leaf = d.variable.slice(dot + 1);
      // 只在没有更强证据时补（避免覆盖直接的 attach 映射）
      if (!varToNs.has(leaf)) {
        varToNs.set(leaf, `bwe.${d.ns}`);
      }
    }
  }

  // 1b) 命名空间「返回器 + 赋值链」：
  //     ScriptApi 里是三步跳：
  //       `prefabObj = prefabs.prefabNamespace();`        ← 变量拿到返回器结果
  //       `bwe.values.put("prefab", prefabObj);`          ← 挂到 bwe.prefab
  //       `addMethod(prefabNs, "define", ...)`            ← 方法注册在返回器的**字段**上
  //       `ScriptJs.Flex prefabNamespace() { return prefabNs; }`
  //     所以要先把「变量 → 返回器方法」，再把「返回器方法 → 字段」，最后映射字段。
  // 返回器方法定义：`ScriptJs.Flex prefabNamespace() { return prefabNs; }`（可能有换行）
  const reNsGetter =
    /(?:ScriptJs\.Flex|Scriptable)\s+(\w+)\s*\(\s*\)\s*\{\s*return\s+([A-Za-z0-9_.]+)\s*;/g;
  /** 返回器方法名 → 返回的字段名 */
  const getterToField = new Map();
  /** 变量名 → 返回器方法名（`prefabObj = prefabs.prefabNamespace()`） */
  const varToGetter = new Map();
  const reAssignGetter = /\b([A-Za-z0-9_]+)\s*=\s*\w+\s*\.\s*([A-Za-z0-9_]+)\s*\(\s*\)\s*;/g;
  for (const [, src] of contents) {
    let m;
    while ((m = reNsGetter.exec(src))) {
      getterToField.set(m[1], m[2]);
    }
    while ((m = reAssignGetter.exec(src))) {
      varToGetter.set(m[1], m[2]);
    }
  }
  // 遍历「变量 → 命名空间」映射，若该变量的值来自返回器，则把返回器的字段也映射到同一 ns
  for (const [nsVar, ns] of [...varToNs.entries()]) {
    const getter = varToGetter.get(nsVar);
    if (!getter) continue;
    const field = getterToField.get(getter);
    if (field && !varToNs.has(field)) {
      varToNs.set(field, ns);
    }
  }

  // 2) 再扫每个文件里的成员注册
  //    注意：ScriptApi 里的 obj() 只用于「临时返回对象」（如 {x,y}），不是命名空间；
  //    所以只对「已知命名空间变量」+ bwe 自身收集成员。
  const bweNamespaces = new Set(["bwe"]);
  for (const ns of varToNs.values()) bweNamespaces.add(ns);

  // 顶层 bwe 自己的方法：method(bwe, "log", ...)
  // 第一个参数也可能是限定名（`p.ns`），统一用宽松标识符匹配。
  const OBJ = "([A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*)";
  const reMethod = new RegExp(
    "\\b(?:api\\s*\\.\\s*)?(?:addMethod|method)\\s*\\(\\s*" + OBJ + "\\s*,\\s*\"([A-Za-z0-9_$]+)\"\\s*,",
    "g",
  );
  const reGetter = new RegExp(
    OBJ + "\\s*\\.\\s*getters\\s*\\.\\s*put\\s*\\(\\s*\"([A-Za-z0-9_$]+)\"\\s*,",
    "g",
  );
  const reSetter = new RegExp(
    OBJ + "\\s*\\.\\s*setters\\s*\\.\\s*put\\s*\\(\\s*\"([A-Za-z0-9_$]+)\"\\s*,",
    "g",
  );
  const reField = new RegExp(
    OBJ + "\\s*\\.\\s*values\\s*\\.\\s*put\\s*\\(\\s*\"([A-Za-z0-9_$]+)\"\\s*,",
    "g",
  );

  for (const [file, src] of contents) {
    const fileBase = basename(file);
    let m;

    // method(...) / addMethod(...)
    reMethod.lastIndex = 0;
    while ((m = reMethod.exec(src))) {
      const varName = m[1];
      const member = m[2];
      if (varName === "bwe") {
        add("bwe", member);
        continue;
      }
      const ns = varToNs.get(varName);
      if (ns) add(ns, member);
    }

    // getters/setters/values → 都算「属性成员 .name」
    for (const re of [reGetter, reSetter, reField]) {
      re.lastIndex = 0;
      while ((m = re.exec(src))) {
        const varName = m[1];
        const member = m[2];
        // ⚠ `bwe.values.put("prefab", prefabObj)` 是**命名空间声明**（上面 reValuesPutNs
        // 已经登记成 `bwe.prefab` 命名空间），不能再算成 `bwe` 的一个名为 `.prefab` 的
        // 属性成员 —— 否则 Java 侧会凭空多出 `bwe.pool [属性]` / `bwe.prefab [属性]`
        // 两条，而任何一侧都不可能「有」这种成员，永远对不上。
        if (varName === "bwe" && re === reField) {
          continue;
        }
        // 只收「命名空间对象」上的属性；临时对象（{x,y,w,h}）上的不收
        const ns = varToNs.get(varName);
        if (ns) {
          add(ns, `.${member}`);
        } else if (varName === "bwe") {
          add("bwe", `.${member}`);
        }
      }
    }

    // 实体对象（Entity）的成员：它是「每个对象的 API」，不是命名空间。
    // 用 `final ScriptJs.Flex e = obj();` + e.getters/e.setters/method(e,...) 定义。
    if (fileBase === "ScriptApi.java") {
      // 已在上面按变量名收了；Entity 变量名是 e / o 等临时名，无法稳定归类 → 单独处理（见下）
    }
  }

  // 3) Entity 成员：单独抽（bwe.d.ts 里有 interface Entity）
  //    形状：`final ScriptJs.Flex e = obj();` 之后对 e 调 method / getters.put / setters.put
  //
  // ⚠ 必须**只认 Entity 自己的变量 `e`**（原来是 `[A-Za-z0-9_]+` 通配）：
  // `e.module(def)` 返回的子对象 `m` 上还有 get/set/has/remove/enabled/dt，
  // 通配会把它们全算成 Entity 成员（实测多出 9 个：dt/enabled/get/has/includes/
  // remove/set/…），于是 docs/api 和 d.ts 永远对不上。这里把变量名钉成 `e`。
  const entity = new Set();
  const srcApi = contents.get(
    javaFiles.find((f) => basename(f) === "ScriptApi.java") || "",
  ) || "";
  if (srcApi) {
    const startIdx = srcApi.indexOf("Scriptable entity(");
    if (startIdx >= 0) {
      const slice = srcApi.slice(startIdx, startIdx + 60000);
      const reEntMethod = /\b(?:api\s*\.\s*)?(?:addMethod|method)\s*\(\s*e\s*,\s*"([A-Za-z0-9_$]+)"\s*,/g;
      const reEntGet = /\be\s*\.\s*getters\s*\.\s*put\s*\(\s*"([A-Za-z0-9_$]+)"\s*,/g;
      const reEntSet = /\be\s*\.\s*setters\s*\.\s*put\s*\(\s*"([A-Za-z0-9_$]+)"\s*,/g;
      let mm;
      while ((mm = reEntMethod.exec(slice))) entity.add(mm[1]);
      while ((mm = reEntGet.exec(slice))) entity.add(`.${mm[1]}`);
      while ((mm = reEntSet.exec(slice))) entity.add(`.${mm[1]}`);
    }
  }
  if (entity.size) api.set("Entity", entity);

  // 4) 生命周期函数（ScriptEngine / ScriptApi / ScriptFields 用字符串名调用的脚本函数）
  //    形状：dispatchObject(a, def, "onUpdate", ...)
  //          engine.dispatchObject(a, engine.boundScript(a), "onDamage", ...)
  //    跨文件扫，因为 onDamage/onDeath 是 ScriptApi/ScriptFields 派发的。
  const lifecycle = new Set();
  const reLife = /\bdispatch[A-Za-z]*\s*\([^;{}]*?"(on[A-Za-z]+)"/g;
  for (const [, src] of contents) {
    let lm;
    while ((lm = reLife.exec(src))) {
      lifecycle.add(lm[1]);
    }
  }
  if (lifecycle.size) api.set("lifecycle", lifecycle);

  return { api, entityCount: entity.size };
}

// ---------------- globals.d.ts 抽取 ----------------

/**
 * 生命周期回调的全局声明在 {@code web/src/js/globals.d.ts}，不在 bwe.d.ts。
 *
 * <p>形状：
 * <pre>
 *   declare function onUpdate(ctx: bwe.Ctx, dt: number): void;
 *   declare function onSceneStart(ctx: bwe.Ctx): void;
 * </pre>
 *
 * <p>只读 bwe.d.ts 会把 12 个 lifecycle 成员**全部**判成「d.ts 缺失」（实测 12/12）。
 * 这里单独抽出来，合并进「d.ts 一侧」。
 */
function extractGlobals(file) {
  const api = new Map();
  if (!existsSync(file)) return api;
  const src = read(file);
  if (!src) return api;
  const members = new Set();
  const re = /\bdeclare\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/g;
  let m;
  while ((m = re.exec(src))) {
    const n = m[1];
    // 只收生命周期回调（on 前缀），别把普通工具函数算进来
    if (/^on[A-Z]/.test(n)) members.add(n);
  }
  if (members.size) api.set("lifecycle", members);
  return api;
}

// ---------------- d.ts 抽取 ----------------

/**
 * 从 bwe.d.ts 抽成员。d.ts 的形状是：
 *   declare namespace bwe {
 *     interface World { find(q: EntityQuery): Entity | null; ... }
 *     interface Entity { x: number; ... }
 *     const world: World;              // ← 命名空间绑定：bwe.world 的成员 = World 的成员
 *     function on(name, fn): void;     // ← bwe 顶层成员
 *   }
 *
 * 所以**不能**按 interface 名猜命名空间（AiOpts / SpawnOpts 这些是参数对象，不是命名空间）。
 * 正确做法：先收所有 interface 的成员表，再用 `const <name>: <Iface>` 把 iface 绑到 `bwe.<name>`。
 * Entity 是特例（没有 const 绑定，但它是实体接口）。
 */
function extractDts(file) {
  const src = read(file);
  /** @type {Map<string, Set<string>>} */
  const api = new Map();
  const interfaces = new Map();
  if (!src) return { api, interfaces };

  const add = (k, v) => {
    if (!api.has(k)) api.set(k, new Set());
    api.get(k).add(v);
  };

  // 1) 收 interface 成员
  //
  // ⚠ 不能用「缩进匹配到 `}`」的写法（`interface X {([\s\S]*?)\n\s{0,4}\}`）：
  // 成员里嵌了对象字面量类型时（例如 `module(): { get(): string }`），
  // 第一个内层 `}` 会被当成 interface 结尾，于是只抽到前几个成员。
  // 实测后果：physics/field/ai/material/sense/faction/noise/seed/target 这些
  // 用内联对象类型声明的命名空间**整块被判「d.ts 缺失」**，报告里 172 条假缺失。
  // 改成花括号配平计数，从 interface 的 `{` 开始数到配平为止。
  const ifaceRe = /interface\s+([A-Za-z0-9_]+)\s*(?:extends\s+[^{]+)?\s*\{/g;
  let m;
  while ((m = ifaceRe.exec(src))) {
    const name = m[1];
    let depth = 1;
    let i = ifaceRe.lastIndex;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth !== 0) break;
    const body = src.slice(ifaceRe.lastIndex, i - 1);
    const members = new Set();
    // 成员行：`    find(q): Entity;` / `    x: number;` / `    readonly y?: number;`
    const memberRe = /^\s{2,}(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*[?:(<:]/gm;
    let mm;
    while ((mm = memberRe.exec(body))) {
      members.add(mm[1]);
    }
    interfaces.set(name, members);
  }

  // 2) const 绑定：const world: World; → bwe.world
  const constRe = /^\s{2}const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([A-Za-z0-9_$]+)\s*;/gm;
  let cm;
  const bound = new Set();
  while ((cm = constRe.exec(src))) {
    const nsName = cm[1];
    const ifaceName = cm[2];
    const members = interfaces.get(ifaceName);
    if (!members) continue;
    bound.add(ifaceName);
    for (const v of members) add(`bwe.${nsName}`, v);
  }

  // 2b) 内联对象类型的 const 绑定：`const physics: { enable(): void; ... };`
  //
  // bwe.physics / field / ai / material / sense / faction / noise / seed / target
  // 都用这种写法（不抽独立 interface）。原来只认 `const x: Ident;`，
  // 于是这 9 个命名空间全被判「缺失」。这里同样用花括号配平把对象体取出来。
  const inlineConstRe = /^\s{2}const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\{/gm;
  let im;
  while ((im = inlineConstRe.exec(src))) {
    const nsName = im[1];
    let depth = 1;
    let i = inlineConstRe.lastIndex;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth !== 0) break;
    const body = src.slice(inlineConstRe.lastIndex, i - 1);
    // 内联对象里的成员缩进比 interface 深，但同一套正则能吃到（要求 2 空格以上缩进）
    const memberRe = /^\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[?:(<]/gm;
    let mm;
    while ((mm = memberRe.exec(body))) {
      add(`bwe.${nsName}`, mm[1]);
    }
  }

  // 3) Entity 特例（实体接口，无 const 绑定）
  const ent = interfaces.get("Entity");
  if (ent) {
    for (const v of ent) add("Entity", v);
  }

  // 4) 顶层 function / const 里**非接口**的（如 function on(...)）→ bwe 成员
  const topFnRe = /^\s{2}function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/gm;
  let tm;
  while ((tm = topFnRe.exec(src))) {
    add("bwe", tm[1]);
  }

  return { api, interfaces };
}

// ---------------- apiDocs.ts 抽取 ----------------

/**
 * 形状：`d("bwe.world.find", "bwe.world.find(q) → Entity | null", "...", "world")`
 * 也允许实体成员写成不带 `bwe.` 前缀的形式：`d("e.id", "e.id", "...", "entity")`
 *   —— 这是本仓库 apiDocs.ts 的实际写法（实体成员用 `e.` 前缀），必须映射到 Entity。
 * 生命周期函数写成裸名（`d("onSceneEnd", "function onSceneEnd(ctx)", ..., "life")`），
 *   归到 lifecycle 而不是 bwe。
 */
function extractApiDocs(file) {
  const src = read(file);
  const api = new Map();
  if (!src) return api;
  const add = (ns, member) => {
    if (!api.has(ns)) api.set(ns, new Set());
    api.get(ns).add(member);
  };
  const re = /\bd\s*\(\s*"([^"]+)"\s*,/g;
  let m;
  while ((m = re.exec(src))) {
    // ⚠ 一条记录可能合并了多个成员：`d("e.x", "e.x / e.y", ...)` /
    // `d("bwe.save.get / bwe.save.set", ...)`。原来只登记第一个名字，
    // 于是第二个成员永远被判「apiDocs 缺失」（实测 hpMax/scaleY/y 就是这么丢的）。
    // 这里按「名称字段」里的 / 、 拆分，逐个登记。
    const rawName = m[1].trim();
    const names = rawName
      .split(/\s*[\/、,]\s*/)
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*$/.test(s));
    for (const name of names) {
      if (name.startsWith("e.")) {
        // `e.actor` 是说明「e 就是 Entity」的类型标注，不是成员 → 跳过
        if (name === "e.actor") continue;
        add("Entity", name.slice(2));
        continue;
      }
      if (name.startsWith("on") && !name.includes(".")) {
        // 裸的生命周期函数名（onStart / onUpdate / onSceneEnd ...）
        add("lifecycle", name);
        continue;
      }
      const parts = name.split(".");
      if (parts[0] !== "bwe") {
        add("bwe", name);
        continue;
      }
      if (parts.length === 2) {
        add("bwe", parts[1]);
      } else if (parts.length >= 3) {
        add(`bwe.${parts[1]}`, parts.slice(2).join("."));
      }
    }
  }
  return api;
}

// ---------------- docs/api/*.md 抽取 ----------------

/**
 * 形状：`### bwe.world.find(q) → Entity | null` 或 `### Entity.xxx`
 * 标题里的 `bwe.xxx.yyy` 或 `Entity.yyy`。
 */
function extractDocs(dir) {
  const api = new Map();
  const files = [];
  if (!existsSync(dir)) return { api, files };
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const p = join(dir, name);
    files.push(p);
    const src = read(p);
    // 文档侧标题有多种合法写法，都要认：
    //   `### bwe.world.find(q) → Entity | null`   （全限定，最规范）
    //   `### Entity.setPos(x, y) → void`
    //   `### e.setPos(x, y) → void`               （Entity 页用 e. 前缀，更贴近脚本写法）
    //   `### e.x / e.y → number`                  （多个相关成员合并一节）
    //   `### bwe.pool.acquire(handle, x, y)`      （命名空间本身也是成员时）
    //   `### onSceneStart(ctx) → void`            （lifecycle 页用裸函数名）
    //
    // ⚠ 两条纪律：
    //   1) 只认「成员名字形态」的开头（bwe./Entity./e./裸标识符），
    //      否则 `### 一、世界 bwe.world` 这类章节标题也会被当成成员（会制造大量假「编造」）。
    //   2) 一节里可用 ` / ` 或 `、` 合并多个成员，逐个登记。
    const re = /^#{2,4}\s+(?:`)?((?:bwe|Entity|e)\.[A-Za-z0-9_$.]+|[A-Za-z_$][A-Za-z0-9_$]*)(?:\s*[\/、]\s*(?:bwe|Entity|e)?\.?[A-Za-z0-9_$.]+)*/gm;
    let m;
    while ((m = re.exec(src))) {
      const head = m[0].replace(/^#{2,4}\s+/, "").replace(/`/g, "").trim();
      const pieces = head
        .split(/\s*[\/、]\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const piece of pieces) {
        const nameOnly = piece.replace(/\(.*$/, "").trim();
        if (!nameOnly) continue;
        const parts = nameOnly.split(".");
        const add = (ns, member) => {
          if (!api.has(ns)) api.set(ns, new Set());
          api.get(ns).add(member);
        };
        if (parts[0] === "bwe") {
          if (parts.length === 2) add("bwe", parts[1]);
          else if (parts.length === 3) add(`bwe.${parts[1]}`, parts[2]);
          else if (parts.length > 3) add(`bwe.${parts[1]}`, parts.slice(2).join("."));
        } else if (parts[0] === "Entity" || parts[0] === "e") {
          if (parts.length > 1) add("Entity", parts.slice(1).join("."));
        } else if (/lifecycle/i.test(name)) {
          add("lifecycle", nameOnly);
        }
      }
    }
  }
  return { api, files };
}

// ---------------- 合并 / 比对 ----------------

/** d.ts 的 interface 名 → 命名空间名（World → bwe.world / Entity → Entity / Input → bwe.input） */
function dtsInterfaceToNamespace(ifaceName) {
  const lower = ifaceName.toLowerCase();
  if (lower === "entity") return "Entity";
  return `bwe.${lower}`;
}

/** 把 d.ts 的 iface:xxx 归一化成命名空间键。 */
function normalizeDts(api) {
  const out = new Map();
  const add = (k, v) => {
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(v);
  };
  for (const [k, members] of api) {
    if (k.startsWith("iface:")) {
      const ns = dtsInterfaceToNamespace(k.slice(6));
      for (const v of members) add(ns, v);
    } else {
      for (const v of members) add(k, v);
    }
  }
  return out;
}

function membersOf(api, ns) {
  return api.get(ns) || new Set();
}

/** 归一化成员名：去掉前导点（属性），统一成可读形式。 */
function norm(m) {
  return m.startsWith(".") ? m.slice(1) + " [属性]" : m;
}

function compare(javaApi, sideApi, sideName) {
  const report = { side: sideName, missingInSide: [], fabricated: [] };
  // 生命周期函数（onStart/onUpdate/...）是**脚本 scope 里的全局函数**，不是 bwe.* 成员。
  // 某些契约文件会把它们写成 `bwe.onUpdate`（归类错误）—— 这不算「编造」，
  // 单独归到 lifecycle 那一类比，避免误报。
  const lifecycleJava = membersOf(javaApi, "lifecycle");
  const allNs = new Set([...javaApi.keys(), ...sideApi.keys()]);
  allNs.add("lifecycle");

  for (const ns of [...allNs].sort()) {
    let j = membersOf(javaApi, ns);
    let s = membersOf(sideApi, ns);
    if (ns === "bwe") {
      // 把「文档里写成 bwe.onXxx、而 Java 里是生命周期函数」的条目挪到 lifecycle 比
      const moved = new Set();
      for (const m of s) {
        const bare = m.startsWith(".") ? m.slice(1) : m;
        if (lifecycleJava.has(bare)) {
          moved.add(bare);
        }
      }
      if (moved.size) {
        s = new Set([...s].filter((m) => !moved.has(m.startsWith(".") ? m.slice(1) : m)));
        if (!sideApi.has("lifecycle")) sideApi.set("lifecycle", new Set());
        for (const m of moved) sideApi.get("lifecycle").add(m);
      }
    }
    for (const m of j) {
      if (!s.has(m)) {
        const bare = m.startsWith(".") ? m.slice(1) : m;
        if (!s.has(bare) && !s.has(`.${bare}`)) {
          report.missingInSide.push(`${ns}.${norm(m)}`);
        }
      }
    }
    for (const m of s) {
      if (!j.has(m)) {
        const bare = m.startsWith(".") ? m.slice(1) : m;
        if (!j.has(bare) && !j.has(`.${bare}`)) {
          report.fabricated.push(`${ns}.${norm(m)}`);
        }
      }
    }
  }
  report.missingInSide.sort();
  report.fabricated.sort();
  return report;
}

// ---------------- 主流程 ----------------

function main() {
  const javaFiles = walk(join(ROOT, "src"));
  if (!javaFiles.length) {
    console.error(`找不到 Java 源码：${join(ROOT, "src")}`);
    process.exit(2);
  }
  const { api: javaApi, entityCount } = extractJava(javaFiles);

  const dtsPath = join(ROOT, "web", "src", "js", "bwe.d.ts");
  const globalsPath = join(ROOT, "web", "src", "js", "globals.d.ts");
  const apiDocsPath = join(ROOT, "web", "src", "data", "apiDocs.ts");
  const docsDir = join(ROOT, args.docsDir);

  const dtsApi = extractDts(dtsPath).api;
  // ⚠ 生命周期回调（onStart/onUpdate/…）的全局声明在 globals.d.ts，不在 bwe.d.ts。
  // 只读 bwe.d.ts 会把 12 个 lifecycle 成员全判「d.ts 缺失」（实测 12/12 假缺失）。
  // 两个文件合并成「d.ts 一侧」再比对。
  const globalsApi = extractGlobals(globalsPath);
  for (const [ns, members] of globalsApi) {
    if (!dtsApi.has(ns)) dtsApi.set(ns, new Set());
    for (const v of members) dtsApi.get(ns).add(v);
  }
  const apiDocsApi = extractApiDocs(apiDocsPath);
  const docs = extractDocs(docsDir);

  const sides = [
    compare(javaApi, dtsApi, "bwe.d.ts"),
    compare(javaApi, apiDocsApi, "apiDocs.ts"),
    compare(javaApi, docs.api, `${args.docsDir}/*.md`),
  ];

  // --only 过滤
  if (args.only) {
    const q = args.only.trim();
    for (const r of sides) {
      r.missingInSide = r.missingInSide.filter((x) => x.includes(q));
      r.fabricated = r.fabricated.filter((x) => x.includes(q));
    }
  }

  const javaCount = [...javaApi.values()].reduce((a, s) => a + s.size, 0);
  const out = {
    generatedAt: new Date().toISOString(),
    javaFiles: javaFiles.length,
    javaNamespaces: javaApi.size,
    javaMembers: javaCount,
    entityMembers: entityCount,
    sides,
    summary: {
      missingTotal: sides.reduce((a, r) => a + r.missingInSide.length, 0),
      fabricatedTotal: sides.reduce((a, r) => a + r.fabricated.length, 0),
    },
    namespaceCoverage: [...javaApi.keys()].sort().map((ns) => ({
      namespace: ns,
      java: membersOf(javaApi, ns).size,
      dts: membersOf(dtsApi, ns).size,
      apiDocs: membersOf(apiDocsApi, ns).size,
      docs: membersOf(docs.api, ns).size,
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    printHuman(out, sides, javaApi);
  }

  // 退出码：有「编造/未实现」= 1；--strict 时缺失也算失败
  if (out.summary.fabricatedTotal > 0) process.exit(1);
  if (args.strict && out.summary.missingTotal > 0) process.exit(1);
  process.exit(0);
}

function printHuman(out, sides, javaApi) {
  const line = (s = "") => console.log(s);
  line("========== BWE API 四方一致性扫描 ==========");
  line(`Java 源文件: ${out.javaFiles} 个 | 命名空间: ${out.javaNamespaces} | 成员: ${out.javaMembers} | Entity 成员: ${out.entityMembers}`);
  line(`文档目录: ${args.docsDir}`);
  line("");

  line("---------- 命名空间覆盖 ----------");
  line(pad("命名空间", 26) + pad("Java", 6, true) + pad("d.ts", 6, true) + pad("apiDocs", 9, true) + pad(docsLabel(), 8, true));
  for (const row of out.namespaceCoverage) {
    line(
      pad(row.namespace, 26) +
        pad(String(row.java), 6, true) +
        pad(String(row.dts), 6, true) +
        pad(String(row.apiDocs), 9, true) +
        pad(String(row.docs), 8, true),
    );
  }
  line("");

  for (const r of sides) {
    line(`---------- ${r.side} ----------`);
    line(`  缺失（Java 有，这里没有）: ${r.missingInSide.length}`);
    printList(r.missingInSide, args.maxList, "    ");
    line(`  编造/未实现（这里有，Java 没有）: ${r.fabricated.length}`);
    printList(r.fabricated, args.maxList, "    ");
    line("");
  }

  line("---------- 结论 ----------");
  if (out.summary.fabricatedTotal > 0) {
    line(`❌ 有 ${out.summary.fabricatedTotal} 处「编造/未实现」——用户照抄会跑不通，必须修`);
  } else {
    line("✅ 无「编造/未实现」：文档侧没有凭空出现的成员");
  }
  if (out.summary.missingTotal > 0) {
    line(`⚠ 有 ${out.summary.missingTotal} 处「缺文档/缺类型」——功能可用但用户发现不了`);
  } else {
    line("✅ 三份契约都覆盖了 Java 实现的全部成员");
  }
  line("");
  line("提示：--json 机读；--strict 让「缺文档」也返回 1（CI 用）；--only <成员> 只看一个。");
}

function docsLabel() {
  const b = basename(args.docsDir);
  return b.endsWith(".md") ? "docs" : b.slice(0, 6);
}

function printList(arr, max, indent) {
  if (!arr.length) return;
  for (const x of arr.slice(0, max)) console.log(indent + "- " + x);
  if (arr.length > max) console.log(indent + `... 还有 ${arr.length - max} 条（--max-list 调大或 --json）`);
}

function pad(s, n, right = false) {
  s = String(s);
  // 粗略显示宽度：CJK 算 2
  const width = [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const fill = " ".repeat(Math.max(1, n - width));
  return right ? fill + s : s + fill;
}

main();
