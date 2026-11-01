/**
 * 开发服务器 + 本地打包/试跑服务。
 *
 * 静态文件仍然是最小实现；/api/package-bwe/* 用来把当前工程交给本机 JDK，
 * 调用 jpackage 生成 Windows 应用；/api/quick-run/* 不打包，直接在本机开 Java 窗口试跑；
 * /api/js-check 用 TypeScript 编译 API 给编辑器里的 JS 脚本出诊断。
 * 这样 Web 编辑器不需要 Electron，也不需要把 Java 运行时塞进浏览器。
 *
 * 用法：node web/tools/serve.mjs [端口]
 */

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, appendFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRuntimeJdk, packageAndroid, packageBwe, writeQuickBuild } from "./package-bwe.mjs";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(webRoot, "..");
const libRoot = join(projectRoot, "lib");
const runtimeSrc = join(projectRoot, "src", "Studio", "runtime");
const quickRunRoot = join(webRoot, ".build", "quickrun");
const quickRunLog = join(quickRunRoot, "run.log");
// 试跑的 class 输出目录：就是仓库根 bin/（已 gitignore），与
// `java -cp "bin;src;lib/*"` 这条命令的约定一致，不额外造一个目录。
const runtimeClasses = join(projectRoot, "bin");
const port = Number(process.argv[2] ?? 5273);
const nodeRequire = createRequire(import.meta.url);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
  ".map": "application/json; charset=utf-8"
};

const jobs = new Map();
const MAX_BODY = 320 * 1024 * 1024;
const MAX_LOG_LINES = 260;

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function nowTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * Windows 上的 javac / jpackage 诊断输出用的是系统代码页（中文 Windows = GBK），
 * 直接按 UTF-8 解会得到一片「����」。这里先试 UTF-8，出现替换字符就按 GB18030 再解一次。
 */
function decodeToolOutput(buffer) {
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gb18030").decode(buffer);
  } catch {
    return utf8;
  }
}

function pushLog(job, message) {
  const line = `[${nowTime()}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > MAX_LOG_LINES) {
    job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  }
  console.log(`[bwe:${job.id}] ${message}`);
}

async function which(name) {
  return new Promise((resolvePromise) => {
    const p = spawn("where", [name], { windowsHide: true });
    p.on("error", () => resolvePromise(false));
    p.on("close", (code) => resolvePromise(code === 0));
    p.stdout?.resume();
    p.stderr?.resume();
  });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw new Error("工程或素材太大（超过 320MB），请先压缩素材");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new Error("请求体为空");
  return JSON.parse(text);
}

// ---------------- 「用 VS Code 打开脚本」 ----------------
//
// 脚本存在 .bwproj 的 JSON 里，不是磁盘上的 .js 文件，所以这里把它**镜像**成真实文件：
//   web/.build/scripts/<脚本名>.js|.yarn
// 这样 VS Code 能正常编辑、看 diff、用 ESLint；编辑器再通过 /api/script-file 把它取回来。
// 镜像是「单向写入 + 按需读回」，不做文件监听（跨平台可靠、也不会和编辑器里的输入打架）。

const scriptMirrorDir = join(webRoot, ".build", "scripts");
const SAFE_SCRIPT_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

function scriptMirrorPath(name, lang, project) {
  const base = String(name ?? "").replace(SAFE_SCRIPT_NAME, "_").trim() || "script";
  const ext = lang === "yarn" ? ".yarn" : ".js";
  const file = base.endsWith(ext) ? base : base + ext;
  // 按工程分目录：两个工程都有「player」时不会互相覆盖
  const scope = String(project ?? "").replace(SAFE_SCRIPT_NAME, "_").trim();
  return scope ? join(scriptMirrorDir, scope, file) : join(scriptMirrorDir, file);
}

/** 找 VS Code 的命令：优先 code.cmd（PATH 上的），再试 code-insiders / cursor。 */
async function findEditorCommand() {
  for (const candidate of ["code", "code-insiders", "cursor"]) {
    if (await which(candidate)) return candidate;
  }
  return null;
}

/** 后台拉起 VS Code（detached：服务退出也不带走编辑器窗口）。 */
function launchEditor(command, filePath, line) {
  const target = line > 0 ? `${filePath}:${line}` : filePath;
  const isWin = process.platform === "win32";
  const args = ["-g", target];
  const child = isWin
    ? spawn("cmd.exe", ["/c", command, ...args], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function jobPublic(job) {
  return {
    id: job.id,
    status: job.status,
    logs: job.logs,
    error: job.error,
    result: job.result,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

function stripForDownload(name) {
  return String(name || "BWE-Game-win64.zip").replace(/["\\\r\n]/g, "_");
}

function openExplorer(path) {
  try {
    const p = spawn("explorer.exe", [path], { detached: true, stdio: "ignore", windowsHide: true });
    p.unref();
  } catch {
    // 打不开目录不影响打包结果，前端仍会显示路径。
  }
}

// ---------------- /api/js-check：JS 脚本诊断 ----------------

let tsModule = null;

function loadTypeScript() {
  if (tsModule) return tsModule;
  try {
    tsModule = nodeRequire("typescript");
  } catch (e) {
    throw new Error(
      `找不到 TypeScript（node_modules/typescript）。请在项目根目录执行 npm install 后重启服务。（${e?.message || e}）`
    );
  }
  return tsModule;
}

function pathKey(p) {
  return normalize(String(p)).replace(/\\/g, "/").toLowerCase();
}

/**
 * 用 TypeScript 编译 API 给用户脚本出诊断。
 *
 * 关键点：bwe.d.ts / globals.d.ts 是「虚拟全局声明」，文件名在虚拟目录里，
 * 只把用户脚本自己的诊断返回出去，所以行号天然是用户脚本的行号，
 * 不会被执行声明文件的行号污染。
 *
 * 声明文件不存在时（编辑器还没写 bwe.d.ts）退化成「语法检查」：
 * 否则满屏 "找不到名称 bwe" 全是噪音，比不检查更烦人。
 */
async function checkJsSource(body) {
  const source = String(body?.source ?? "");
  const name = String(body?.name ?? "script");
  const ts = loadTypeScript();
  const virtualRoot = join(projectRoot, "__bwe_jscheck__");
  // 与打包器一致：按 TypeScript 语法解析（允许类型标注），输出 ES5。
  const userFile = join(virtualRoot, "user-script.ts");
  const files = new Map();
  files.set(pathKey(userFile), source);

  const declarationFiles = [];
  for (const rel of ["bwe.d.ts", "globals.d.ts"]) {
    try {
      const text = await readFile(join(webRoot, "src", "js", rel), "utf8");
      const virtual = join(virtualRoot, rel);
      files.set(pathKey(virtual), text);
      declarationFiles.push(virtual);
    } catch {
      // 文件不存在属于正常情况（JS 面板还没落地），继续。
    }
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
    // 标准库用 ES2020：内嵌 Rhino 1.7.15 实测支持 Array.includes / Object.entries /
    // String.padStart / String.replaceAll / Array.flat / globalThis 等（见 docs/scripting-api.md §0）。
    // 之前只给 lib.es5，会把 `.includes()` 这类完全能跑的写法报成错误，误导用户。
    // 仍然不给 DOM/Node 的 lib：window / document / require 在运行时并不存在，让它们通过反而更糟。
    lib: ["lib.es2020.d.ts"]
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
    getEnvironmentVariable: () => ""
  };

  const program = ts.createProgram({
    rootNames: [userFile, ...declarationFiles],
    options,
    host
  });
  const userSource = program.getSourceFile(userFile);
  const syntactic = userSource ? program.getSyntacticDiagnostics(userSource) : [];
  // 没有 bwe.d.ts 时只报语法错：否则 "找不到名称 bwe / ctx" 会刷满屏，把真错误埋掉。
  const semantic = userSource && declarationFiles.length > 0 ? program.getSemanticDiagnostics(userSource) : [];
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
      message: ts.flattenDiagnosticMessageText(d.messageText, " ")
    };
  });
  // 语法诊断与语义诊断可能重复同一条；按「行:列:消息」去重后按位置排序，面板直接渲染。
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
      newLine: ts.NewLineKind.LineFeed
    },
    fileName: `${name || "script"}.ts`,
    reportDiagnostics: false
  });

  return {
    ok: !unique.some((d) => d.severity === "error"),
    name,
    hasTypes: declarationFiles.length > 0,
    diagnostics: unique,
    // 给编辑器做「降级后长什么样」预览，也让前端能确认 transpile 成功。
    transpiled: transpiled.outputText ?? ""
  };
}

// ---------------- /api/quick-run：本机直接试跑 ----------------
//
// 不调用 jpackage：writeBuild 出 .build/quickrun/Build，
// javac 增量编译 src/Studio/runtime → bin/，
// 然后 `java -cp "bin;src;lib/*" -Djava.library.path=lib Studio.runtime.TopDownRuntime <boot.json>`。
// 全程用数组形式 spawn（不拼 shell 字符串），所以中文/空格路径不会出事。

const quickRun = {
  proc: null,
  pid: 0,
  startedAt: null,
  project: "",
  lastError: null
};

function quickRunRunning() {
  const proc = quickRun.proc;
  return Boolean(proc && proc.exitCode == null && proc.signalCode == null);
}

function appendRunLog(message) {
  const line = `[${nowTime()}] ${message}`;
  try {
    appendFileSync(quickRunLog, line + "\n", "utf8");
  } catch {
    // 日志写不进去也不能影响试跑本身。
  }
  console.log(`[bwe:quickrun] ${message}`);
}

async function readLogTail(maxLines = 120) {
  try {
    const raw = await readFile(quickRunLog);
    // 逐行解码：服务端自己追加的日志是 UTF-8，而 java 子进程的 System.out 在
    // Windows 上走系统代码页（GBK），同一个文件里会混两种编码。
    // 先按字节切行，再每行「UTF-8 有替换字符就按 GB18030 解」，两边都能读。
    const lines = [];
    let start = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === 0x0a) {
        lines.push(decodeToolOutput(raw.subarray(start, i)).replace(/\r$/, ""));
        start = i + 1;
      }
    }
    if (start < raw.length) lines.push(decodeToolOutput(raw.subarray(start)).replace(/\r$/, ""));
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

/**
 * 试跑用的 JDK：必须 major ≤ 25（JOGL 2.1 在 JDK 26 上 WGL 崩溃），
 * 优先 JAVA_HOME / where java / 常见安装目录里 major 最高的 17~25 版本。
 */
async function pickQuickRunJdk(log) {
  const jdk = await findRuntimeJdk();
  if (!jdk.chosen) {
    const found = jdk.all
      .filter((j) => j.major != null)
      .map((j) => `${j.major}（${j.javaExe}）`)
      .join("、");
    throw new Error(
      `quick-run 需要 JDK ${jdk.minMajor}~${jdk.maxMajor}：JOGL 2.1 在 JDK 26 上 WGL 初始化失败`
        + `（窗口能开但 GL/脚本不启动），JDK 26 还删除了 java.applet。`
        + `本机找到的 JDK：${found || "无"}。`
        + `请安装 JDK 25 或更低版本，或把 JAVA_HOME 指向可用 JDK 后重启服务。`
    );
  }
  const chosen = jdk.chosen;
  log(`JDK：${chosen.javaExe}（major ${chosen.major}，版本 ${chosen.version || "未知"}，来源 ${chosen.source}）`);
  // 编译也用同一个 JDK 的 javac，避免「javac 26 + java 25」这种混搭。
  const home = dirname(dirname(chosen.javaExe));
  const javacExe = join(home, "bin", process.platform === "win32" ? "javac.exe" : "javac");
  return { ...chosen, javacExe: existsSync(javacExe) ? javacExe : "javac" };
}

async function newestMtimeMs(dir, accept) {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtimeMs(full, accept));
      continue;
    }
    if (!accept(entry.name)) continue;
    const info = await stat(full).catch(() => null);
    if (info) newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
}

/**
 * 源码目录最新 mtime vs bin/Studio/runtime/*.class 最新 mtime：只有源码更新才 javac。
 *
 * <p>⚠ <b>必须排除 `*Test.java`</b>（踩过的真实故障）：
 * 项目把测试类放在 `src/Studio/runtime/` 下（`tools/bwe.ps1 test-all` 靠"类名以 Test 结尾"
 * 自动发现），而这些测试类会 `import Core.*` / `import Framework.*`（测旧核心的加固）。
 * 试跑只编译 `runtimeSrc` 这一个目录时，`Core` / `Framework` 不在编译输入里 →
 * <pre>
 *   javac 退出码 1：CollisionEventTest.java:3: 错误: 程序包 Core 不存在
 * </pre>
 * 于是「脚本 0 错误却试跑不起来」。
 *
 * <p>两条一起修：① 过滤掉 `*Test.java`（它们是测试，不是运行时）；
 * ② 再补 `-sourcepath src` 兜底，让运行时源码万一引用了同仓其它包也能解析。
 * 只过滤测试类还不够稳：未来运行时真的引用 `Core.` 时仍会挂。
 */
async function compileRuntimeIfNeeded(log, javacExe = "javac") {
  const files = await readdir(runtimeSrc);
  const sources = files
    .filter((f) => f.endsWith(".java"))
    .filter((f) => f !== "GameLauncher.java")
    // 测试类不是运行时的一部分：它们 import Core/Framework，绝不能进试跑编译集
    .filter((f) => !f.endsWith("Test.java"))
    .map((f) => join(runtimeSrc, f));
  if (sources.length === 0) throw new Error(`找不到 Java 运行时源码：${runtimeSrc}`);
  let newestSource = 0;
  for (const f of sources) {
    const info = await stat(f).catch(() => null);
    if (info) newestSource = Math.max(newestSource, info.mtimeMs);
  }
  const newestClass = await newestMtimeMs(join(runtimeClasses, "Studio", "runtime"), (n) => n.endsWith(".class"));
  if (newestClass > 0 && newestClass >= newestSource) {
    log("Java 运行时已是最新（bin/ 的 class 比源码新），跳过编译");
    return { compiled: false };
  }
  await mkdir(runtimeClasses, { recursive: true });
  log(`编译 Java 运行时（${sources.length} 个源文件，${javacExe}）→ bin/ …`);
  const started = Date.now();
  try {
    await new Promise((resolvePromise, reject) => {
      const p = spawn(
        javacExe,
        [
          "--release", "8",
          "-encoding", "UTF-8",
          "-Xlint:-options",
          "-cp", join(libRoot, "*"),
          "-d", runtimeClasses,
          // 兜底：运行时若引用同仓其它包（Core/Framework 等），javac 能沿 sourcepath 找到。
          // 真正的隔离靠上面排除 *Test.java —— 这条只是避免"将来又忘"。
          "-sourcepath", join(projectRoot, "src"),
          ...sources
        ],
        { cwd: projectRoot, windowsHide: true, shell: false }
      );
      let chunks = [];
      // javac 的诊断走系统代码页（中文 Windows 是 GBK），按 UTF-8 解会变成「����」，
      // 所以先收 Buffer，结束后再用 decodeToolOutput 判断真实编码。
      p.stdout?.on("data", (d) => chunks.push(d));
      p.stderr?.on("data", (d) => chunks.push(d));
      p.on("error", (e) => reject(new Error(`启动 javac 失败：${e.message}`)));
      p.on("close", (code) => {
        const text = decodeToolOutput(Buffer.concat(chunks)).trim();
        chunks = [];
        if (text) {
          for (const line of text.split(/\r?\n/)) log(`javac: ${line}`);
        }
        if (code === 0) resolvePromise();
        else reject(new Error(`javac 退出码 ${code}${text ? `：${text.split(/\r?\n/).slice(0, 6).join(" / ")}` : ""}`));
      });
    });
  } catch (e) {
    // javac 半途失败可能留下部分 .class（mtime 比源码新），
    // 不清掉的话下一次会被「class 比源码新」误判成已编译，然后带着残缺类去启动。
    await rm(join(runtimeClasses, "Studio", "runtime"), { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  log(`Java 运行时编译完成（${Date.now() - started} ms）`);
  return { compiled: true };
}

async function stopQuickRun() {
  const proc = quickRun.proc;
  if (!proc || proc.exitCode != null) {
    quickRun.proc = null;
    return { ok: true, stopped: false, pid: null };
  }
  const pid = proc.pid;
  appendRunLog(`停止试跑进程 PID ${pid} …`);
  await new Promise((resolvePromise) => {
    if (process.platform === "win32") {
      // Windows：java 可能再拉起 JVM 子进程，必须 /T 杀整棵进程树。
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, shell: false });
      killer.on("error", () => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        resolvePromise();
      });
      killer.on("close", () => resolvePromise());
    } else {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolvePromise();
    }
  });
  appendRunLog(`已结束试跑进程 PID ${pid}`);
  quickRun.proc = null;
  return { ok: true, stopped: true, pid };
}

/** 服务退出时兜底杀子进程，避免留下无主的 Java 窗口。 */
function killQuickRunSync() {
  const proc = quickRun.proc;
  if (!proc || proc.exitCode != null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    // ignore
  }
}

async function startQuickRun(body, log) {
  await mkdir(quickRunRoot, { recursive: true });
  // 每次试跑重新生成 Build：否则上一次的旧场景/旧素材会残留下来，看到的不是当前工程。
  await rm(join(quickRunRoot, "Build"), { recursive: true, force: true });
  await rm(quickRunLog, { force: true });
  quickRun.startedAt = new Date().toISOString();
  quickRun.project = String(body?.project?.name ?? "");
  quickRun.lastError = null;

  log(`收到试跑请求：「${quickRun.project || "未命名工程"}」`);
  const build = await writeQuickBuild(body.project, body.assets ?? null, quickRunRoot, log);
  for (const w of build?.warnings ?? []) log(`⚠ ${w}`);
  const bootFile = join(quickRunRoot, "Build", "boot.json");
  if (!existsSync(bootFile)) throw new Error(`没有生成 boot.json：${bootFile}`);
  log(`Build 已生成：${bootFile}`);

  // 选 JDK：必须 17~25 且带 jpackage 的那三个 flag，否则 JOGL 2.1 只会起一个空窗口。
  const jdk = await pickQuickRunJdk(log);
  await compileRuntimeIfNeeded(log, jdk.javacExe);

  const separator = process.platform === "win32" ? ";" : ":";
  // 与 docs/scripting-api.md §8 / 打包命令保持同一套 classpath。
  const classpath = [runtimeClasses, join(projectRoot, "src"), join(libRoot, "*")].join(separator);
  const javaExe = jdk.javaExe;
  const args = [
    "-cp", classpath,
    `-Djava.library.path=${libRoot}`,
    // 与 jpackage 的 --java-options 完全一致：JOGL 2.1 缺少这几个 flag 时
    // WGL 配置枚举报 ArrayIndexOutOfBoundsException → 窗口能开但 GL/脚本永不启动。
    "--enable-native-access=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED",
    // 与 jpackage 的 --java-options 对齐，保证中文日志/窗口标题不乱码。
    "-Dfile.encoding=UTF-8",
    "Studio.runtime.TopDownRuntime",
    bootFile
  ];
  log(`启动：${javaExe} ${args.join(" ")}`);

  // 把子进程的 stdout/stderr 直接接到 run.log，前端轮询 status 读日志尾部。
  const fd = openSync(quickRunLog, "a");
  let proc;
  try {
    proc = spawn(javaExe, args, {
      cwd: projectRoot,
      stdio: ["ignore", fd, fd],
      windowsHide: false,
      shell: false
    });
  } finally {
    closeSync(fd);
  }

  quickRun.proc = proc;
  quickRun.pid = proc.pid ?? 0;

  proc.on("error", (e) => {
    quickRun.lastError = e?.message || String(e);
    appendRunLog(`Java 进程启动失败：${quickRun.lastError}`);
  });
  proc.on("exit", (code, signal) => {
    appendRunLog(
      `试跑进程结束（PID ${proc.pid}，退出码 ${code == null ? "null" : code}${signal ? `，信号 ${signal}` : ""}）`
    );
    if (quickRun.proc === proc) {
      quickRun.proc = null;
      quickRun.pid = 0;
    }
  });

  // java 不在 PATH / 路径不对时只有异步 'error'，exitCode 会一直是 null，
  // 所以先等 spawn 真的成功（或失败），别把「没起来」当成「在跑」返回。
  const spawnError = await new Promise((resolvePromise) => {
    if (proc.pid) {
      resolvePromise(null);
      return;
    }
    proc.once("spawn", () => resolvePromise(null));
    proc.once("error", (e) => resolvePromise(e));
  });
  if (spawnError) {
    quickRun.proc = null;
    quickRun.pid = 0;
    appendRunLog(`启动 java 失败：${spawnError.message}`);
    return {
      ok: false,
      pid: null,
      error: `启动 java 失败：${spawnError.message}`,
      logFile: quickRunLog,
      logTail: await readLogTail(),
      warnings: build?.warnings ?? []
    };
  }

  // 等一小会儿再看一眼：如果 JVM 立刻因为缺 jar / 缺 DLL 退出，直接把这句错误返回给前端，
  // 比「返回 ok 然后前端轮询半天 running=false」清楚得多。
  await new Promise((r) => setTimeout(r, 800));
  if (proc.exitCode != null && proc.exitCode !== 0) {
    const tail = await readLogTail();
    return {
      ok: false,
      pid: proc.pid,
      error: `Java 进程启动后立即退出（退出码 ${proc.exitCode}），详见日志`,
      logFile: quickRunLog,
      logTail: tail,
      warnings: build?.warnings ?? []
    };
  }

  log(`Java 试跑进程已启动：PID ${proc.pid}`);
  return {
    ok: true,
    pid: proc.pid,
    bootFile,
    logFile: quickRunLog,
    // 把实际选中的 JDK 一并返回，前端/排查时不用再翻日志。
    jdk: { javaExe: jdk.javaExe, major: jdk.major, version: jdk.version },
    warnings: build?.warnings ?? [],
    logTail: await readLogTail()
  };
}

async function handleApi(req, res, url) {
  const path = url.pathname;

  // ---------- /api/js-check：给编辑器 JS 脚本面板出诊断 ----------
  if (path === "/api/js-check" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
      return true;
    }
    if (typeof body?.source !== "string") {
      json(res, 400, { ok: false, error: "缺少 source（脚本源码）" });
      return true;
    }
    try {
      json(res, 200, await checkJsSource(body));
    } catch (e) {
      json(res, 500, { ok: false, error: e?.message || String(e) });
    }
    return true;
  }

  // ---------- /api/quick-run：本机 Java 窗口试跑 ----------
  if (path === "/api/quick-run" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
      return true;
    }
    if (!body?.project || !Array.isArray(body.project.scenes) || body.project.scenes.length === 0) {
      json(res, 400, { ok: false, error: "缺少 project 或工程没有场景" });
      return true;
    }
    // 已经有一个试跑在跑：先停掉旧的，避免两个 Java 窗口互相抢焦点。
    if (quickRunRunning()) await stopQuickRun();
    try {
      const result = await startQuickRun(body, (message) => appendRunLog(message));
      json(res, result.ok ? 200 : 500, result);
    } catch (e) {
      const message = e?.message || String(e);
      appendRunLog(`试跑失败：${message}`);
      json(res, 500, { ok: false, error: message, logFile: quickRunLog, logTail: await readLogTail() });
    }
    return true;
  }

  if (path === "/api/quick-run/status") {
    json(res, 200, {
      ok: true,
      running: quickRunRunning(),
      pid: quickRun.pid || null,
      project: quickRun.project,
      startedAt: quickRun.startedAt,
      logFile: quickRunLog,
      logTail: await readLogTail()
    });
    return true;
  }

  if (path === "/api/quick-run/stop" && req.method === "POST") {
    const result = await stopQuickRun();
    json(res, 200, { ...result, running: quickRunRunning(), logTail: await readLogTail() });
    return true;
  }

  // ---------- /api/open-in-vscode：把脚本落到磁盘文件并用本机编辑器打开 ----------
  if (path === "/api/open-in-vscode" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
      return true;
    }
    if (typeof body?.name !== "string" || !body.name.trim()) {
      json(res, 400, { ok: false, error: "缺少 name（脚本名）" });
      return true;
    }
    const lang = body.lang === "yarn" ? "yarn" : "js";
    const file = scriptMirrorPath(body.name, lang, body.project);
    try {
      await mkdir(dirname(file), { recursive: true });
      if (typeof body.source === "string") {
        await writeFile(file, body.source, "utf8");
      } else if (!existsSync(file)) {
        json(res, 400, { ok: false, error: "脚本没有源码，且镜像文件不存在" });
        return true;
      }
      const command = await findEditorCommand();
      if (!command) {
        json(res, 200, {
          ok: false,
          file,
          error:
            "本机没找到 VS Code 命令（code）。装了 VS Code 但命令不可用时，" +
            "在 VS Code 里执行「Shell Command: Install 'code' command in PATH」，或手动打开下面这个文件。",
          hint: "文件已写到磁盘，可以直接用任意编辑器打开"
        });
        return true;
      }
      launchEditor(command, file, Number(body.line) || 1);
      json(res, 200, { ok: true, file, command, lang });
    } catch (e) {
      json(res, 500, { ok: false, error: e?.message || String(e), file });
    }
    return true;
  }

  // ---------- /api/script-file：读回镜像文件（VS Code 里改完，编辑器用它同步） ----------
  if (path === "/api/script-file" && req.method === "GET") {
    const name = url.searchParams.get("name") ?? "";
    const lang = url.searchParams.get("lang") === "yarn" ? "yarn" : "js";
    if (!name.trim()) {
      json(res, 400, { ok: false, error: "缺少 name" });
      return true;
    }
    const file = scriptMirrorPath(name, lang, url.searchParams.get("project") ?? "");
    try {
      const info = await stat(file);
      const content = await readFile(file, "utf8");
      json(res, 200, { ok: true, file, content, mtimeMs: info.mtimeMs });
    } catch {
      json(res, 404, { ok: false, file, error: "镜像文件不存在（先点「VS Code 打开」）" });
    }
    return true;
  }

  if (path === "/api/package-bwe/status" || (path === "/api/package-bwe" && req.method === "GET")) {
    const [javac, jpackage, candle, light, gradlewExists] = await Promise.all([
      which("javac"),
      which("jpackage"),
      which("candle.exe"),
      which("light.exe"),
      Promise.resolve(
        existsSync(join(projectRoot, "android", "gradlew")) || existsSync(join(projectRoot, "android", "gradlew.bat"))
      )
    ]);
    const androidGradlew = gradlewExists;
    json(res, 200, {
      ok: javac && jpackage,
      node: process.version,
      javac,
      jpackage,
      wix: candle && light,
      // app-image + zip 不需要 WiX；安装器方案才会用到。
      appImage: javac && jpackage,
      android: {
        ok: Boolean(androidGradlew),
        gradlew: androidGradlew ? "gradlew" : null,
        projectDir: join(projectRoot, "android")
      },
      port,
      outRoot: join(webRoot, ".build", "packages")
    });
    return true;
  }

  if (path === "/api/package-bwe" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
      return true;
    }
    if (!body?.project || !Array.isArray(body.project.scenes)) {
      json(res, 400, { ok: false, error: "缺少 project 或工程没有场景" });
      return true;
    }
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id,
      status: "running",
      logs: [],
      error: null,
      result: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      platform: String(body.platform ?? "windows")
    };
    jobs.set(id, job);
    pushLog(job, `收到打包任务：${body.project.name ?? "未命名工程"}（平台：${job.platform}）`);
    json(res, 202, { ok: true, jobId: id });
    void runJob(job, body);
    return true;
  }

  const jobMatch = /^\/api\/package-bwe\/jobs\/([^/]+)$/.exec(path);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      json(res, 404, { ok: false, error: "任务不存在" });
      return true;
    }
    json(res, 200, { ok: true, job: jobPublic(job) });
    return true;
  }

  const downloadMatch = /^\/api\/package-bwe\/download\/([^/]+)$/.exec(path);
  if (downloadMatch) {
    const job = jobs.get(downloadMatch[1]);
    if (!job?.result?.zipPath) {
      json(res, 404, { ok: false, error: "安装包还没生成" });
      return true;
    }
    try {
      const data = await readFile(job.result.zipPath);
      const name = stripForDownload(job.result.zipName);
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": data.length,
        "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`
      });
      res.end(data);
    } catch (e) {
      json(res, 500, { ok: false, error: `读取安装包失败：${e.message}` });
    }
    return true;
  }

  const downloadApkMatch = /^\/api\/package-bwe\/download-apk\/([^/]+)$/.exec(path);
  if (downloadApkMatch) {
    const job = jobs.get(downloadApkMatch[1]);
    const apkPath = job?.result?.apkPath;
    if (!apkPath) {
      json(res, 404, { ok: false, error: "任务还没有产出 APK" });
      return true;
    }
    try {
      const data = await readFile(apkPath);
      const name = stripForDownload(`${job.result?.appName ?? "BWE-Android"}-debug.apk`);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": data.length,
        "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`
      });
      res.end(data);
    } catch (e) {
      json(res, 500, { ok: false, error: `读取 APK 失败：${e.message}` });
    }
    return true;
  }

  const openMatch = /^\/api\/package-bwe\/open\/([^/]+)$/.exec(path);
  if (openMatch) {
    const job = jobs.get(openMatch[1]);
    if (!job?.result?.appDir) {
      json(res, 404, { ok: false, error: "输出目录还没生成" });
      return true;
    }
    openExplorer(job.result.appDir);
    json(res, 200, { ok: true, path: job.result.appDir });
    return true;
  }

  return false;
}

async function runJob(job, body) {
  try {
    const platform = String(job.platform ?? body.platform ?? "windows").toLowerCase();
    if (platform === "android") {
      const result = await packageAndroid(
        body.project,
        body.assets ?? [],
        {
          jobId: job.id,
          name: body.name || body.project.name,
          version: body.version || "1.0.0",
          // 默认 release（正式包）；前端显式选「测试包」时传 variant: "debug"。
          variant: body.variant === "debug" ? "debug" : "release"
        },
        (message) => pushLog(job, message)
      );
      job.result = {
        platform: "android",
        variant: result.variant,
        releaseSigned: result.releaseSigned,
        isTestPackage: result.isTestPackage,
        appName: result.appName,
        version: result.version,
        outDir: result.outDir,
        buildDir: result.buildDir,
        apkName: result.apkName,
        apkPath: result.apkPath,
        sizeBytes: result.sizeBytes,
        warnings: result.warnings
      };
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      pushLog(job, `Android 打包完成（${result.variant}${result.isTestPackage ? " · 测试包" : ""}），文件：${result.apkPath}`);
    } else {
      const result = await packageBwe(
        body.project,
        body.assets ?? [],
        {
          jobId: job.id,
          name: body.name || body.project.name,
          version: body.version || "1.0.0",
          console: Boolean(body.console)
        },
        (message) => pushLog(job, message)
      );
      job.result = result;
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      pushLog(job, `打包完成，文件：${result.zipPath}`);
    }
  } catch (e) {
    job.status = "error";
    job.error = e?.message || String(e);
    job.finishedAt = new Date().toISOString();
    pushLog(job, `打包失败：${job.error}`);
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    // 所有 /api/* 都交给 handleApi：打包、JS 诊断、试跑共用同一套错误格式。
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (handled) return;
      json(res, 404, { ok: false, error: "接口不存在" });
      return;
    }

    let path = decodeURIComponent(url.pathname);
    if (path === "/" || path === "") path = "/index.html";

    // 防目录穿越：规范化后必须仍在 web 根目录下
    const target = normalize(join(webRoot, path));
    if (!target.startsWith(webRoot)) {
      res.writeHead(403).end("403");
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || info.isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404 找不到：" + path);
      return;
    }

    const data = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      // 开发期不缓存，改完刷新就能看到
      "cache-control": "no-store"
    });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("500 " + e.message);
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[bwe] 端口 ${port} 已被占用。换一个端口：node web/tools/serve.mjs 5274`);
  } else {
    console.error("[bwe] 服务启动失败:", e);
  }
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  // 这行会出现在后台任务日志里，用于确认服务确实起来了
  console.log(`[bwe] 编辑器已就绪: http://127.0.0.1:${port}/`);
  console.log(`[bwe] 打包 API: http://127.0.0.1:${port}/api/package-bwe/status`);
  console.log(`[bwe] 脚本诊断: POST http://127.0.0.1:${port}/api/js-check`);
  console.log(`[bwe] 试跑 API: POST http://127.0.0.1:${port}/api/quick-run`);
});

// 服务被关掉时顺手结束试跑进程，不把 Java 窗口留在桌面上。
process.on("exit", killQuickRunSync);
process.on("SIGTERM", () => {
  killQuickRunSync();
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  killQuickRunSync();
  server.close(() => process.exit(0));
});
