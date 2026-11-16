/**
 * 脚本语言服务：诊断 / 补全 / 悬浮提示（唯一实现）。
 *
 * ── 为什么不引入 monaco / codemirror ────────────────────────────────────
 * 仓库里已经有 `web/src/js/bwe.d.ts`（271 条完整类型声明），`/api/js-check` 已经在用它做诊断。
 * **同一个 TypeScript LanguageService 直接就能提供补全与悬浮提示** —— 引入第二个编辑器框架
 * 等于把「类型声明 → 补全/诊断」这条链复制成两份，迟早不一致，还要多背一个几百 KB 的依赖。
 *
 * ── 三个必须做对的点（都是实测/踩过才知道的）──────────────────────────
 *
 * 1. **单实例 + 版本号增量更新**。
 *    每次按键都 `createLanguageService` 会重建 program（271 条声明 + lib）→ 卡几百毫秒。
 *    正确做法：一个 service 常驻，每次只 `updateScriptSnapshot(source)` 并把 `version` 加一。
 *    实测（20 次取中位数，见 README）远低于 30ms。
 *
 * 2. **offset 是 UTF-16 code unit**（TypeScript 的约定）。
 *    渲染侧 `textarea.selectionStart` / `selectionEnd` 也是 UTF-16 → **两边天然一致**。
 *    ⚠ 千万不要「按字符数算」：中英混排时 JS 的 `[...str]` 逐码点遍历与 UTF-16 索引会错位，
 *    这是这类功能最容易埋的雷（表现为「中文注释后面的补全全错位」）。
 *    本模块所有 offset 原样透传给 TS，不做任何换算。
 *
 * 3. **`insertText` 只给名字、不带括号**。
 *    带不带括号是 UI 的决策（用户可能想先看签名再决定要不要调用），后端替 UI 决定等于越权。
 *
 * ── 诊断复用 ────────────────────────────────────────────────────────────
 * `diagnostics()` 与既有 `/api/js-check` 的判定规则**必须一致**（同一套 tsOptions、同一套虚拟文件、
 * 同一套「没有 bwe.d.ts 时只报语法错」的降级）。所以这里直接由本模块提供，api-core 改为调用它，
 * 不再单独维护第二份装配逻辑。
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/** TypeScript 的 ScriptElementKind → UI 能用的粗分类。 */
const KIND_MAP = {
  function: "function",
  method: "function",
  localfunction: "function",
  construct: "function",
  property: "property",
  getter: "property",
  setter: "property",
  membervariableelement: "property",
  variable: "property",
  membervariable: "property",
  localvar: "property",
  parameter: "property",
  namespace: "namespace",
  module: "namespace",
  keyword: "keyword",
  primitive: "keyword",
  const: "constant",
  "enum member": "constant",
  enummember: "constant",
  enum: "constant",
  class: "property",
  interface: "property",
  type: "property",
  alias: "property",
  label: "property",
  "script element": "property",
  directory: "namespace",
  externalmodule: "namespace"
};

/**
 * @param {object} opts
 * @param {string} opts.bweDts        bwe.d.ts 全文
 * @param {string} opts.globalsDts    globals.d.ts 全文（可为空串）
 * @param {string} [opts.virtualRoot] 虚拟目录名前缀（默认 repoRoot/__bwe_lang__）
 * @param {string} [opts.repoRoot]
 */
export function createScriptLanguage(opts) {
  const bweDts = String(opts?.bweDts ?? "");
  const globalsDts = String(opts?.globalsDts ?? "");
  const hasTypes = bweDts.length > 0;
  const virtualRoot = String(opts?.virtualRoot ?? "/__bwe_lang__");
  const userFile = `${virtualRoot}/user-script.ts`;
  const bweFile = `${virtualRoot}/bwe.d.ts`;
  const globalsFile = `${virtualRoot}/globals.d.ts`;

  const ts = loadTypeScript();

  /** 声明文件内容（只读，不随每次按键变化）。 */
  const declFiles = new Map();
  if (hasTypes) {
    declFiles.set(bweFile, bweDts);
    if (globalsDts) declFiles.set(globalsFile, globalsDts);
  }

  // ---- 用户脚本快照：版本号驱动增量更新 ----
  let source = "";
  let version = 0;
  let snapshot = ts.ScriptSnapshot.fromString(source);

  const tsOptions = {
    target: ts.ScriptTarget.ES5,
    module: ts.ModuleKind.None,
    allowJs: true,
    checkJs: hasTypes,
    noEmit: true,
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
    types: [],
    // 与 api-core 的 js-check 保持完全一致：ES2020 标准库（Rhino 实测支持），
    // 但不给 DOM/Node lib（运行时不存在 window/document/require）。
    lib: ["lib.es2020.d.ts"]
  };

  const host = {
    getScriptFileNames: () => [userFile, ...declFiles.keys()],
    getScriptVersion: (fileName) => (isUserFile(fileName) ? String(version) : "0"),
    getScriptSnapshot: (fileName) => {
      if (isUserFile(fileName)) return snapshot;
      const decl = declFiles.get(normalizeFile(fileName));
      if (decl !== undefined) return ts.ScriptSnapshot.fromString(decl);
      const disk = ts.sys.readFile(fileName);
      return disk === undefined ? undefined : ts.ScriptSnapshot.fromString(disk);
    },
    getCurrentDirectory: () => virtualRoot,
    getCompilationSettings: () => tsOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (f) => isUserFile(f) || declFiles.has(normalizeFile(f)) || ts.sys.fileExists(f),
    readFile: (f) => (isUserFile(f) ? source : declFiles.get(normalizeFile(f)) ?? ts.sys.readFile(f)),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => false,
    getNewLine: () => "\n"
  };

  /** 单例：整个进程只创建一个 service（这是性能的关键，见文件头 1）。 */
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  // ---------------- 跨脚本：查找引用 / 跳转定义 ----------------
  //
  // 上面那个 service 的 program 里只有 user-script.ts 一个用户文件，
  // 「A 脚本定义、B 脚本调用」这种查询它天然查不到。所以另开一套「项目级」service：
  // 把这次请求里的**全部脚本**各挂成一份虚拟文件，塞进同一个 program。
  //
  // 为什么要按内容 hash 缓存（不是每次新建）：
  //   新建 service → 首次 findReferences 实测 ~150ms（TS 要建 program + 解析 271 条声明与 lib）；
  //   program 建好之后再查只要 1~5ms。编辑器每次点击/按 F12 都要查一次，
  //   每次新建就是每次 150ms+，用户会觉得「点了没反应」。
  //
  // 为什么缓存上限是 2 条而不是 1 条：
  //   只留 1 条时，「在两个文件集合之间来回切」（比如并排看两个工程）会互相把对方踢掉，
  //   于是每次切换都重建 program；留 2 条正好覆盖这种来回切，又不会无限涨内存。
  const projectCache = new Map(); // 内容 sha1 → entry（Map 的插入顺序就是 LRU 顺序）
  // 多个 entry 共用一个 DocumentRegistry：lib.*.d.ts 与 bwe.d.ts 只会被解析一次。
  // 安全性依赖「同一个 (路径, 版本号) 一定是同一份内容」—— 脚本的版本号取自下面这个
  // 全局单调计数器（只有内容真的变了才 +1），声明文件的版本号恒为 "0" 且本实例内不变，
  // 所以不存在「两个 entry 用同一 key 却内容不同」的情况。
  const projectRegistry = ts.createDocumentRegistry();
  let projectVersionSeq = 0;
  const nextProjectVersion = () => (projectVersionSeq += 1);

  /** 把一次请求的 files 落到缓存中的 service 上；参数不合法时返回 { error }（不抛）。 */
  function projectEntryFor(files) {
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      return { error: "files 必须是「脚本名 → 源码」的对象" };
    }
    const names = Object.keys(files).sort();
    if (names.length === 0) return { error: "files 不能为空" };

    const key = hashProjectFiles(names, files);
    const hit = projectCache.get(key);
    if (hit) {
      // 命中：内容一模一样，理论上一行都不用改。仍然走一次 apply()（逐文件对比、没变就不动
      // 版本号）—— 让「缓存里存的就是这份内容」成为不变量，而不是靠 key 永远算对。
      projectCache.delete(key);
      projectCache.set(key, hit); // 重新插到队尾 = 标记为最近使用
      hit.apply(files, names);
      return { entry: hit };
    }

    // 未命中：优先复用最久没用的那条 entry 做**增量**（只更新变了的文件）。
    // 换工程时整体 apply 会把旧脚本删掉；改了一行时则只碰那一个文件。
    let entry = null;
    if (projectCache.size >= PROJECT_CACHE_LIMIT) {
      const oldestKey = projectCache.keys().next().value;
      entry = projectCache.get(oldestKey);
      projectCache.delete(oldestKey);
    }
    if (!entry) {
      entry = createProjectEntry({
        ts,
        declFiles,
        virtualRoot,
        compilerOptions: tsOptions,
        registry: projectRegistry,
        nextVersion: nextProjectVersion
      });
    }
    entry.apply(files, names);
    projectCache.set(key, entry);
    return { entry };
  }

  /**
   * 跨脚本查找引用。
   *
   * @param {Record<string,string>} files  脚本名 → 源码
   * @param {string} active                当前脚本名（必须出现在 files 里）
   * @param {number} offset                光标位置，**UTF-16 code unit**（与补全同一口径）
   * @returns {{ok:boolean, refs:Array<{name:string,line:number,col:number,text:string,isDefinition:boolean}>, error?:string}}
   */
  function references(files, active, offset) {
    const checked = checkProjectArgs(files, active, offset);
    if (checked.error) return { ok: false, refs: [], error: checked.error };
    const picked = projectEntryFor(files);
    if (picked.error) return { ok: false, refs: [], error: picked.error };
    return picked.entry.references(checked.active, checked.offset);
  }

  /**
   * 跳转定义。
   *
   * @returns {{ok:boolean, defs:Array<{name:string,line:number,col:number,text:string}>, error?:string}}
   */
  function definition(files, active, offset) {
    const checked = checkProjectArgs(files, active, offset);
    if (checked.error) return { ok: false, defs: [], error: checked.error };
    const picked = projectEntryFor(files);
    if (picked.error) return { ok: false, defs: [], error: picked.error };
    return picked.entry.definition(checked.active, checked.offset);
  }

  /** files/active/offset 的公共校验。放在建 service 之前：非法请求不该污染缓存。 */
  function checkProjectArgs(files, active, offset) {
    const activeName = String(active ?? "");
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      return { error: "files 必须是「脚本名 → 源码」的对象" };
    }
    if (!Object.prototype.hasOwnProperty.call(files, activeName)) {
      return { error: `active「${activeName}」不在 files 里` };
    }
    const offsetNum = Number(offset);
    if (!Number.isFinite(offsetNum) || offsetNum < 0) {
      return { error: "offset 必须是非负数" };
    }
    return { active: activeName, offset: offsetNum };
  }

  function isUserFile(f) {
    return normalizeFile(f) === normalizeFile(userFile);
  }
  function normalizeFile(f) {
    return String(f).replace(/\\/g, "/").toLowerCase();
  }

  /** 更新用户脚本内容；返回是否真的变了（没变就不动版本号，避免无谓的 program 失效）。 */
  function setSource(next) {
    const text = String(next ?? "");
    if (text === source) return false;
    source = text;
    version += 1;
    // ⚠ 必须同步更新 snapshot：host.getScriptSnapshot 取的是这个闭包变量，
    //   只更新 source 而忘了 snapshot，TS 会一直看到旧内容（表现为「补全像是落后一次按键」）。
    snapshot = ts.ScriptSnapshot.fromString(source);
    return true;
  }

  /** 把 source 设成给定内容并返回 service 可用的对象（供一次性调用：先 set 再查）。 */
  function withSource(text, fn) {
    setSource(text);
    return fn();
  }

  // ---------------- 诊断（与 /api/js-check 完全同一套规则）----------------

  function diagnostics(text) {
    return withSource(text, () => {
      const program = service.getProgram();
      if (!program) return { ok: false, hasTypes, diagnostics: [], transpiled: "" };

      const userSource = program.getSourceFile(userFile);
      const syntactic = userSource ? program.getSyntacticDiagnostics(userSource) : [];
      // 没有 bwe.d.ts 时只报语法错：否则「找不到名称 bwe / ctx」会刷满屏，把真错误埋掉。
      const semantic = userSource && hasTypes ? program.getSemanticDiagnostics(userSource) : [];
      const raw = [...syntactic, ...semantic].filter((d) => d.file);

      const mapped = raw.map((d) => {
        let line = 1;
        let col = 1;
        if (d.file && typeof d.start === "number") {
          const pos = d.file.getLineAndCharacterOfPosition(d.start);
          line = pos.line + 1;
          col = pos.character + 1;
        }
        return {
          line,
          col,
          severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
          message: ts.flattenDiagnosticMessageText(d.messageText, " ")
        };
      });
      // 语法与语义诊断可能重复同一条；按「行:列:消息」去重后按位置排序。
      const seen = new Set();
      const unique = mapped.filter((d) => {
        const k = `${d.line}:${d.col}:${d.message}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      unique.sort((a, b) => a.line - b.line || a.col - b.col);

      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES5,
          module: ts.ModuleKind.None,
          alwaysStrict: false,
          newLine: ts.NewLineKind.LineFeed
        },
        fileName: "script.ts",
        reportDiagnostics: false
      });

      return {
        ok: !unique.some((d) => d.severity === "error"),
        hasTypes,
        diagnostics: unique,
        transpiled: transpiled.outputText ?? ""
      };
    });
  }

  // ---------------- 补全 ----------------

  /**
   * 光标处补全。
   *
   * @param {string} text
   * @param {number} offset  **UTF-16 code unit 偏移**（与 textarea.selectionStart 同一口径）
   * @returns {{entries: Array<{name,kind,detail,docs,insertText}>, isMemberAccess: boolean}}
   */
  function complete(text, offset) {
    return withSource(text, () => {
      const pos = clampOffset(source, offset);
      const completions = service.getCompletionsAtPosition(userFile, pos, {
        // 中文输入法/IDE 习惯：不自动插入括号 —— insertText 由我们统一给「名字」。
        includeCompletionsForModuleExports: false,
        includeCompletionsWithInsertText: true
      });
      if (!completions) return { entries: [], isMemberAccess: false };

      const seen = new Set();
      const entries = [];
      for (const entry of completions.entries ?? []) {
        // 同名只留一条（TS 有时对同一属性给多条，来源不同）
        const name = entry.name;
        if (!name || seen.has(name)) continue;
        seen.add(name);

        let detail = entry.kind ? String(entry.kind) : "";
        let docs = "";
        // 取签名与注释：补全项本身只有名字。
        //
        // ⚠ 这里**不能**用 getQuickInfoAtPosition —— 它要的是「源码里该符号的位置」，
        //   而补全候选项（如 clear）在源码里根本还没写出来，位置无从谈起
        //   （我第一版就是这么写的，detail 全是 "any"、docs 全空）。
        //   正确做法是 getCompletionEntryDetails：它按 (文件, 位置, 补全项名字) 查，
        //   位置用光标处即可，TS 自己知道当前上下文在哪个成员链上。
        try {
          const entryName = entry.name;
          const details = service.getCompletionEntryDetails(
            userFile,
            pos,
            entryName,
            { includeCompletionsForModuleExports: false },
            entry.source,
            entry.data
          );
          if (details) {
            const parts = [
              ...(details.displayParts ?? []),
              ...(details.kindModifiers ? [] : [])
            ];
            const signature = ts.displayPartsToString(parts);
            if (signature) detail = signature;
            docs = ts.displayPartsToString(details.documentation ?? "");
          }
        } catch {
          // 详情失败不影响补全结果（名字与 kind 仍然可用）
        }

        entries.push({
          name,
          kind: mapKind(ts, entry.kind),
          detail,
          docs,
          // ⚠ 只给名字、不带括号：带不带括号是 UI 的决策（见文件头 3）。
          insertText: name
        });
      }
      return { entries, isMemberAccess: Boolean(completions.isMemberCompletion) };
    });
  }

  /**
   * 悬浮提示（光标处类型/签名/注释）。
   *
   * @returns {{display:string, docs:string, kind:string}|null}
   */
  function quickInfo(text, offset) {
    return withSource(text, () => {
      const pos = clampOffset(source, offset);
      const info = service.getQuickInfoAtPosition(userFile, pos);
      if (!info) return null;
      return {
        display: ts.displayPartsToString(info.displayParts ?? ""),
        docs: ts.displayPartsToString(info.documentation ?? ""),
        kind: mapKind(ts, info.kind)
      };
    });
  }

  function clampOffset(src, offset) {
    const n = Number(offset);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.floor(n), src.length);
  }

  return {
    diagnostics,
    complete,
    quickInfo,
    references,
    definition,
    // 供测试/排查：当前版本号（验证「增量更新」确实生效）
    get version() {
      return version;
    },
    get hasTypes() {
      return hasTypes;
    },
    /** 显式设置脚本内容（可选；complete/quickInfo 内部会自动 set）。 */
    setSource
  };
}

/** `ts.ScriptElementKind` → UI 粗分类。 */
function mapKind(ts, kind) {
  const raw = String(kind ?? "").toLowerCase().replace(/\s+/g, " ");
  return KIND_MAP[raw] ?? KIND_MAP[raw.replace(/ /g, "")] ?? "property";
}

// ---------------- 项目级 service（跨脚本 references / definition）----------------

/**
 * 缓存上限。为什么是 2：见 createScriptLanguage 里 projectCache 的说明 ——
 * 1 条会让「两个文件集合来回切」每次重建 program（~150ms），再多就是白占内存。
 */
const PROJECT_CACHE_LIMIT = 2;

/** 命中 bwe.d.ts / globals.d.ts 时回给前端的脚本名（前端按这个名字标注「来自声明」）。 */
const DECL_SCRIPT_NAME = "__bwe_dts__";

/** 结果里每行 text 的最大长度（UI 是一行省略号列表，再长也没用）。 */
const TEXT_MAX = 120;

/**
 * 把脚本名安全化成虚拟文件名（不含路径分隔符，保留可读性）。
 *
 * 脚本名是用户起的，可能带中文、空格、`/`、`..`。虚拟文件名同时用于：
 *   1. TS 内部按路径识别文件 —— 带 `/` 会被当成子目录，`..` 会指到虚拟根之外；
 *   2. 反向映射回脚本名 —— 所以必须**单射**（不同脚本名不能撞成同名文件），
 *      否则两个脚本的内容会互相覆盖，查出来的引用会张冠李戴。
 * 做法：只替换会破坏路径语义的字符，其余（中文/空格/点）原样保留；
 * 真撞名时（例如 `a/b` 与 `a_b` 都变成 `a_b`）再加序号后缀。
 */
function safeFileStem(name, used) {
  const raw = String(name ?? "");
  let stem = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.+$/, "").trim();
  if (!stem) stem = "script";
  // 纯 `.` / `..` 也会被 TS 当成目录跳转
  if (/^\.*$/.test(stem)) stem = "script";
  let candidate = stem;
  let n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${stem}~${n++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * 内容 → 缓存 key。**必须包含脚本名**而不只是内容：两个文件内容一样但名字不同，
 * 查出来的 name 字段是不一样的，不能共用 entry 的映射表。
 * 用 sha1 是为了不把整份源码留在 key 里（Map 的 key 会被长期持有）。
 */
function hashProjectFiles(names, files) {
  const h = createHash("sha1");
  for (const name of names) {
    h.update(name);
    h.update("\u0000");
    h.update(String(files[name] ?? ""));
    h.update("\u0000");
  }
  return h.digest("hex");
}

/**
 * 建一条「项目级」entry：一个常驻 LanguageService + 脚本名 ↔ 虚拟文件名的双向映射。
 *
 * entry 是**可复用**的：apply() 会把文件集合改成新的一份（增/删/改都支持），
 * 只有内容真的变了的文件才 +1 版本号 —— TS 靠版本号决定要不要重新解析那个文件。
 */
function createProjectEntry({ ts, declFiles, virtualRoot, compilerOptions, registry, nextVersion }) {
  /** 虚拟文件名 → 源码 */
  const contents = new Map();
  /** 虚拟文件名 → 版本号（TS 用它判断缓存是否还有效） */
  const versions = new Map();
  /** 脚本名 → 虚拟文件名 */
  const toVirtual = new Map();
  /** 虚拟文件名 → 脚本名 */
  const toScript = new Map();
  /** 虚拟文件名 → ScriptSnapshot（避免每次 getScriptSnapshot 都重新构造） */
  const snapshots = new Map();
  /** 虚拟文件名 → 行首偏移表（惰性计算，内容一变就丢） */
  const lineStarts = new Map();

  // 声明文件在 entry 生命周期内不变，版本号恒为 "0"。
  const declSnapshots = new Map();
  for (const [file, text] of declFiles) declSnapshots.set(file, ts.ScriptSnapshot.fromString(text));

  const host = {
    getScriptFileNames: () => [...contents.keys(), ...declFiles.keys()],
    getScriptVersion: (file) => versions.get(file) ?? "0",
    getScriptSnapshot: (file) => {
      if (contents.has(file)) return snapshots.get(file);
      const decl = declSnapshots.get(file);
      if (decl !== undefined) return decl;
      // lib.*.d.ts 走磁盘（与单文件 service 同一套规则：TS 自己要它们）
      const disk = ts.sys.readFile(file);
      return disk === undefined ? undefined : ts.ScriptSnapshot.fromString(disk);
    },
    getCurrentDirectory: () => virtualRoot,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (file) => contents.has(file) || declSnapshots.has(file) || ts.sys.fileExists(file),
    readFile: (file) => contents.get(file) ?? declFiles.get(file) ?? ts.sys.readFile(file),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => false,
    getNewLine: () => "\n"
  };

  const service = ts.createLanguageService(host, registry);

  /** 把 files 应用到这个 entry：删掉不在集合里的、更新变了的、加新的。 */
  function apply(files, sortedNames) {
    // ⚠ 顺序很重要：先删掉这一轮不存在的脚本，再给新脚本分配虚拟文件名。
    //   反过来的话，换工程时旧脚本的名字会继续「占着」文件名主干，
    //   新脚本只能拿到 `game.js~2` 这种后缀（结果正确但映射永远在漂）。
    const wantedNames = new Set(sortedNames);
    for (const [virtual, name] of [...toScript]) {
      if (wantedNames.has(name)) continue;
      // 旧脚本必须真的从 program 里消失，否则它里面的同名函数会继续参与引用匹配
      contents.delete(virtual);
      versions.delete(virtual);
      snapshots.delete(virtual);
      lineStarts.delete(virtual);
      toScript.delete(virtual);
      toVirtual.delete(name);
    }

    const usedStems = new Set([...toScript.keys()].map(stemOf));
    for (const name of sortedNames) {
      // 映射要稳定：同一个脚本名在 entry 复用期间一直用同一个虚拟文件名，
      // 否则「删掉一个文件再加回来」会让 TS 认为是另一个文件（增量缓存全部失效）。
      let virtual = toVirtual.get(name);
      if (!virtual) {
        let stem = safeFileStem(name, usedStems);
        virtual = `${virtualRoot}/${stem}.ts`;
        // 与声明文件撞名（脚本恰好叫 "bwe.d" / "globals.d"）：同名会把声明文件顶掉，
        // bwe.* 的定义就全查不到了。
        while (declFiles.has(virtual)) {
          stem = safeFileStem(`${name}~${usedStems.size}`, usedStems);
          virtual = `${virtualRoot}/${stem}.ts`;
        }
        toVirtual.set(name, virtual);
        toScript.set(virtual, name);
      }

      const text = String(files[name] ?? "");
      if (contents.get(virtual) !== text) {
        contents.set(virtual, text);
        versions.set(virtual, String(nextVersion()));
        snapshots.set(virtual, ts.ScriptSnapshot.fromString(text));
        lineStarts.delete(virtual);
      }
    }
  }

  /** 虚拟文件名 → 名字主干（用于撞名判定） */
  function stemOf(virtual) {
    return virtual.slice(virtualRoot.length + 1, -3).toLowerCase();
  }

  function fileFor(name) {
    return toVirtual.get(name) ?? "";
  }

  /**
   * 把 TS 的 (文件, textSpan) 变成前端要的一行。
   * 解析不到时返回 null —— 包括命中落在 lib.es*.d.ts 里的情况（`[].push`、`Math.max`）：
   * 那不是用户的代码，列出来只会把真正的跨脚本调用淹掉。
   */
  function toRow(fileName, start, isDefinition) {
    const scriptName = toScript.get(fileName);
    if (scriptName === undefined) return null;
    const { line, col, text } = sliceAt(fileName, start);
    return { name: scriptName, line, col, text, isDefinition };
  }

  /**
   * 声明文件（bwe.d.ts / globals.d.ts）里的命中：统一标注成 __bwe_dts__，
   * 行号仍是声明文件自己的行号，text 给那一行的内容 —— 前端据此显示「来自 bwe.d.ts」。
   */
  function toDeclRow(fileName, start) {
    if (!declFiles.has(fileName)) return null;
    const { line, col, text } = sliceAt(fileName, start);
    return { name: DECL_SCRIPT_NAME, line, col, text };
  }

  /** 只算一次的行首表（一次查询几十条命中，逐条从头扫行会把 O(行数×命中数) 变成热点）。 */
  function lineStartsFor(fileName) {
    let starts = lineStarts.get(fileName);
    if (starts) return starts;
    const text = contents.get(fileName) ?? declFiles.get(fileName) ?? "";
    starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    lineStarts.set(fileName, starts);
    return starts;
  }

  /** (文件, offset) → { line, col, text }，line/col 从 1 开始，text 是该行 trim 后前 120 字。 */
  function sliceAt(fileName, offset) {
    const text = contents.get(fileName) ?? declFiles.get(fileName) ?? "";
    const starts = lineStartsFor(fileName);
    const pos = clampToSource(text, offset);
    // 二分找「最后一个 starts[i] <= pos」
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = starts[lo];
    let end = lineStart;
    // 行尾的 \r 不能算进 text（Windows 换行会把多余字符带进 UI）
    while (end < text.length && text.charCodeAt(end) !== 10 && text.charCodeAt(end) !== 13) end += 1;
    return { line: lo + 1, col: pos - lineStart + 1, text: text.slice(lineStart, end).trim().slice(0, TEXT_MAX) };
  }

  function references(active, offset) {
    const file = fileFor(active);
    if (!file || !contents.has(file)) return { ok: false, refs: [], error: `active「${active}」不在本次文件集合里` };
    const source = contents.get(file) ?? "";
    // 越界不是错误：编辑器在「文件刚被替换、光标还停在旧位置」时就会这样，
    // 夹到末尾查即可（查不到自然返回空数组）。
    const pos = clampToSource(source, offset);

    let groups;
    try {
      groups = service.findReferences(file, pos) ?? [];
    } catch (e) {
      return { ok: false, refs: [], error: e?.message || String(e) };
    }

    const refs = [];
    for (const group of groups) {
      for (const item of group.references ?? []) {
        // isDefinition 以 TS 的为准，但「定义组本身」也要算定义：
        // 实测函数声明那条是 isWriteAccess:true 而**没有** isDefinition，
        // 光看 isDefinition 会把唯一的定义行标成普通引用。
        const isDef =
          item.isDefinition === true ||
          (group.definition &&
            item.fileName === group.definition.fileName &&
            item.textSpan.start === group.definition.textSpan.start);
        const row = toRow(item.fileName, item.textSpan.start, isDef);
        if (row) refs.push(row);
      }
      // 定义落在声明文件里（bwe.log 之类）：补一条 __bwe_dts__ 行，
      // 否则用户会看到「一堆引用但没有定义」，反而更迷惑。
      const defRow = group.definition ? toDeclRow(group.definition.fileName, group.definition.textSpan.start) : null;
      if (defRow) refs.push({ ...defRow, isDefinition: true });
    }

    // 同一个位置可能被两组同时报出来（TS 对重载/合并符号会这样），按位置去重。
    const seen = new Set();
    const unique = refs.filter((r) => {
      const k = `${r.name}:${r.line}:${r.col}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // 排序口径按契约：先脚本名、再行号（前端按这个顺序渲染列表，不自己再排）
    unique.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN") || a.line - b.line || a.col - b.col);
    return { ok: true, refs: unique };
  }

  function definition(active, offset) {
    const file = fileFor(active);
    if (!file || !contents.has(file)) return { ok: false, defs: [], error: `active「${active}」不在本次文件集合里` };
    const source = contents.get(file) ?? "";
    const pos = clampToSource(source, offset);

    let list;
    try {
      list = service.getDefinitionAtPosition(file, pos) ?? [];
    } catch (e) {
      return { ok: false, defs: [], error: e?.message || String(e) };
    }

    const defs = [];
    for (const d of list) {
      const row = toRow(d.fileName, d.textSpan.start, undefined) ?? toDeclRow(d.fileName, d.textSpan.start);
      if (!row) continue;
      defs.push({ name: row.name, line: row.line, col: row.col, text: row.text });
    }
    const seen = new Set();
    return {
      ok: true,
      defs: defs.filter((d) => {
        const k = `${d.name}:${d.line}:${d.col}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
    };
  }

  return { apply, references, definition };
}

function clampToSource(text, offset) {
  const n = Number(offset);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), text.length);
}

/** TypeScript 是仓库 devDependency，离线可用；找不到时给可读错误。 */
let tsModule = null;
export function loadTypeScript() {
  if (tsModule) return tsModule;
  try {
    tsModule = nodeRequire("typescript");
  } catch (e) {
    throw new Error(
      `找不到 TypeScript（node_modules/typescript）。请在项目根目录执行 npm install。（${e?.message || e}）`
    );
  }
  return tsModule;
}

/**
 * 从磁盘装配一个语言服务实例（api-core / 桌面主进程用）。
 *
 * @param {object} opts
 * @param {string} opts.webRoot   web 目录（bwe.d.ts / globals.d.ts 在其 src/js 下）
 */
export async function createScriptLanguageFromDisk({ webRoot }) {
  let bweDts = "";
  let globalsDts = "";
  try {
    bweDts = await readFile(join(webRoot, "src", "js", "bwe.d.ts"), "utf8");
  } catch {
    // 声明文件不存在时退化成「只做语法检查」，与既有 js-check 的降级一致。
  }
  try {
    globalsDts = await readFile(join(webRoot, "src", "js", "globals.d.ts"), "utf8");
  } catch {
    globalsDts = "";
  }
  return createScriptLanguage({ bweDts, globalsDts });
}
