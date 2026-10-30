#!/usr/bin/env node
/**
 * 脚本类型诊断（与 BWE Studio 编辑器的 `/api/js-check` **完全同一套逻辑**）。
 *
 * 编辑器的诊断在 `web/tools/serve.mjs` 的 `checkJsSource()` 里，它：
 *   1. 把用户脚本当一个 `user-script.ts`，用 TypeScript 编译；
 *   2. 把 `web/src/js/bwe.d.ts` + `globals.d.ts` 作为**虚拟全局声明**挂上去；
 *   3. 只回用户脚本自己的诊断（行号就是用户脚本的行号）。
 *
 * 本脚本把那段逻辑独立出来，方便在命令行/CI 里先验证脚本，而不是非得开编辑器点"预览"。
 * **参数与判定口径与编辑器一致**（target ES5 / module None / checkJs / lib es2020 / strict false）。
 *
 * 用法：
 *   node web/tools/check-scripts.mjs                       # 检查 .bwproj 里的全部 JS 脚本
 *   node web/tools/check-scripts.mjs web/examples/开放世界城市.bwproj
 *   node web/tools/check-scripts.mjs --file path/to/x.js   # 检查单个 .js 文件
 *   node web/tools/check-scripts.mjs --json
 *
 * 退出码：0 = 全部脚本无 error；1 = 有 error。
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const PROJECT_ROOT = resolve(WEB_ROOT, "..");
const nodeRequire = createRequire(import.meta.url);

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const fileIdx = args.indexOf("--file");
const singleFile = fileIdx >= 0 ? args[fileIdx + 1] : "";
const projectArg = args.find((a) => !a.startsWith("--") && a !== singleFile);

function loadTypeScript() {
  try {
    return nodeRequire("typescript");
  } catch {
    console.error("❌ 找不到 typescript。先 npm install。");
    process.exit(2);
  }
}

const ts = loadTypeScript();

const DECL_FILES = ["bwe.d.ts", "globals.d.ts"]
  .map((f) => join(WEB_ROOT, "src", "js", f))
  .filter((f) => existsSync(f));

/**
 * 与 serve.mjs 的 checkJsSource() 同构：用 TypeScript 对一段脚本源码出诊断。
 *
 * @param {string} source 脚本源码
 * @param {string} name   脚本名（仅用于展示/文件名）
 * @returns {{ok:boolean, diagnostics:{line:number,col:number,severity:string,message:string}[], transpiled:string}}
 */
function checkSource(source, name) {
  const virtualRoot = join(PROJECT_ROOT, "__bwe_jscheck__");
  const pathKey = (p) => resolve(p).replace(/\\/g, "/").toLowerCase();

  const userFile = join(virtualRoot, "user-script.ts");
  const files = new Map();
  files.set(pathKey(userFile), source);
  const declarationFiles = [];
  for (const f of DECL_FILES) {
    const virtual = join(virtualRoot, basename(f));
    files.set(pathKey(virtual), readFileSync(f, "utf8"));
    declarationFiles.push(virtual);
  }

  const options = {
    target: ts.ScriptTarget.ES5,
    module: ts.ModuleKind.None,
    allowJs: true,
    checkJs: declarationFiles.length > 0,
    noEmit: true,
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2020.d.ts"],
  };

  const host = {
    getSourceFile(fileName, languageVersion) {
      const text = files.get(pathKey(fileName));
      if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
      const disk = ts.sys.readFile(fileName);
      return disk === undefined ? undefined : ts.createSourceFile(fileName, disk, languageVersion, true);
    },
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    writeFile() {},
    getCurrentDirectory: () => virtualRoot,
    getDirectories: (dir) => ts.sys.getDirectories(dir),
    fileExists: (f) => files.has(pathKey(f)) || ts.sys.fileExists(f),
    readFile: (f) => files.get(pathKey(f)) ?? ts.sys.readFile(f),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => false,
    getNewLine: () => "\n",
    getEnvironmentVariable: () => "",
  };

  const program = ts.createProgram({
    rootNames: [userFile, ...declarationFiles],
    options,
    host,
  });
  const userSource = program.getSourceFile(userFile);
  const syntactic = userSource ? program.getSyntacticDiagnostics(userSource) : [];
  const semantic =
    userSource && declarationFiles.length > 0 ? program.getSemanticDiagnostics(userSource) : [];
  const raw = [...syntactic, ...semantic].filter((d) => d.file);

  const diagnostics = raw.map((d) => {
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
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    };
  });

  const seen = new Set();
  const unique = diagnostics.filter((d) => {
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
      newLine: ts.NewLineKind.LineFeed,
    },
    fileName: `${name || "script"}.ts`,
    reportDiagnostics: false,
  });

  return {
    ok: !unique.some((d) => d.severity === "error"),
    diagnostics: unique,
    transpiled: transpiled.outputText ?? "",
  };
}

function main() {
  /** @type {{name:string, source:string}[]} */
  const jobs = [];

  if (singleFile) {
    const p = resolve(singleFile);
    if (!existsSync(p)) {
      console.error(`❌ 找不到文件 ${p}`);
      process.exit(2);
    }
    jobs.push({ name: basename(p).replace(/\.js$/, ""), source: readFileSync(p, "utf8") });
  } else {
    const projPath = resolve(projectArg || join(WEB_ROOT, "examples", "开放世界城市.bwproj"));
    if (!existsSync(projPath)) {
      console.error(`❌ 找不到工程 ${projPath}`);
      process.exit(2);
    }
    const project = JSON.parse(readFileSync(projPath, "utf8"));
    for (const [name, entry] of Object.entries(project.scripts ?? {})) {
      if ((entry.lang ?? "yarn") !== "js") continue;
      jobs.push({ name, source: String(entry.source ?? "") });
    }
    if (jobs.length === 0) {
      console.error("❌ 工程里没有 lang=js 的脚本");
      process.exit(2);
    }
  }

  const results = [];
  let totalErrors = 0;
  for (const job of jobs) {
    const r = checkSource(job.source, job.name);
    const errors = r.diagnostics.filter((d) => d.severity === "error");
    const warnings = r.diagnostics.filter((d) => d.severity === "warning");
    totalErrors += errors.length;
    results.push({ name: job.name, ok: r.ok, errors, warnings, transpiledLen: r.transpiled.length });

    if (!JSON_OUT) {
      console.log(`脚本「${job.name}」：${errors.length} 个错误 / ${warnings.length} 个警告`);
      for (const d of errors) {
        console.log(`  ✗ 第 ${d.line} 行第 ${d.col} 列：${d.message}`);
      }
      for (const d of warnings) {
        console.log(`  ⚠ 第 ${d.line} 行第 ${d.col} 列：${d.message}`);
      }
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: totalErrors === 0, scripts: results }, null, 2));
  } else {
    console.log(
      totalErrors === 0
        ? "✅ 全部脚本无类型错误"
        : `✗ 有 ${totalErrors} 个脚本错误，先修好再试跑`,
    );
  }
  process.exit(totalErrors === 0 ? 0 : 1);
}

main();
