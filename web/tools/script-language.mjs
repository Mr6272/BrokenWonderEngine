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
