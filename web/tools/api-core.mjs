/**
 * BWE 本地能力的纯逻辑层（不 bind 端口、不碰 req/res）。
 *
 * 为什么要把 serve.mjs 拆成 api-core：
 *   网页版要一个 HTTP 服务，桌面版（Electron）要的是「主进程里直接调用」。
 *   两边的业务逻辑必须**只有一份**，否则 `/api/js-check` 的 TypeScript 诊断、
 *   jpackage 打包参数、试跑进程管理迟早会分叉。所以这里只做「输入 → 结果」：
 *
 *   const core = createApiCore();
 *   const r = await core.handle({ path: "/api/js-check", method: "POST", body: "{...}" });
 *   // r = { status: 200, json: {...} } 或 { status: 200, binary: {...} }
 *
 *   serve.mjs 负责把 HTTP 请求读成「path + method + query + body」，再把结果写回 res；
 *   desktop/lib/api.mjs 负责把 IPC 参数读成同样的形状。两者都不重复业务代码。
 *
 * 依赖仍然只有 Node 标准库与本机 JDK（打包） / 仓库里的 TypeScript（JS 诊断）。
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, appendFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRuntimeJdk, packageAndroid, packageBwe, writeQuickBuild } from "./package-bwe.mjs";
import { createScriptLanguageFromDisk } from "./script-language.mjs";

const defaultWebRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nodeRequire = createRequire(import.meta.url);
const MAX_BODY = 320 * 1024 * 1024;
const MAX_LOG_LINES = 260;
const SAFE_SCRIPT_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

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

function stripForDownload(name) {
  return String(name || "BWE-Game-win64.zip").replace(/["\\\r\n]/g, "_");
}

/**
 * 创建一份 API 实例。
 *
 * 每个实例有自己的 jobs / 试跑进程状态 —— 桌面版一个实例，网页版一个实例，
 * 互不干扰；测试也可以拿到干净实例。
 *
 * @param {object} [options]
 * @param {string} [options.webRoot]      web 目录（默认本文件所在目录的上一级）
 * @param {string} [options.projectRoot]  仓库根 / 打包后的 app 根
 * @param {number} [options.port]         仅用于 status 接口回显（桌面版是 0）
 * @param {(msg: string, tag?: string) => void} [options.onLog] 统一日志出口
 */
export function createApiCore(options = {}) {
  const webRoot = options.webRoot ? resolve(options.webRoot) : defaultWebRoot;
  // 打包后的 app 目录与仓库结构一致（web/ + lib/ + src/），所以「web 的上一级」仍然有效。
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : resolve(webRoot, "..");
  const libRoot = join(projectRoot, "lib");
  const runtimeSrc = join(projectRoot, "src", "Studio", "runtime");
  const quickRunRoot = join(webRoot, ".build", "quickrun");
  const quickRunLog = join(quickRunRoot, "run.log");
  // 试跑的 class 输出目录：就是仓库根 bin/（已 gitignore），与
  // `java -cp "bin;src;lib/*"` 这条命令的约定一致，不额外造一个目录。
  const runtimeClasses = join(projectRoot, "bin");
  const scriptMirrorDir = join(webRoot, ".build", "scripts");
  const port = Number(options.port ?? 0);

  const emit = (message, tag = "bwe") => {
    if (options.onLog) options.onLog(message, tag);
    else console.log(`[${tag}] ${message}`);
  };

  const jobs = new Map();
  const quickRun = { proc: null, pid: 0, startedAt: null, project: "", lastError: null };

  // ---------------- 通用 ----------------

  function json(status, data) {
    return { status, json: data };
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

  function pushLog(job, message) {
    const line = `[${nowTime()}] ${message}`;
    job.logs.push(line);
    if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    emit(message, `bwe:${job.id}`);
  }

  function scriptMirrorPath(name, lang, project) {
    const base = String(name ?? "").replace(SAFE_SCRIPT_NAME, "_").trim() || "script";
    const ext = lang === "yarn" ? ".yarn" : ".js";
    const file = base.endsWith(ext) ? base : base + ext;
    // 按工程分目录：两个工程都有「player」时不会互相覆盖
    const scope = String(project ?? "").replace(SAFE_SCRIPT_NAME, "_").trim();
    return scope ? join(scriptMirrorDir, scope, file) : join(scriptMirrorDir, file);
  }

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

  function openExplorer(path) {
    try {
      const p = spawn("explorer.exe", [path], { detached: true, stdio: "ignore", windowsHide: true });
      p.unref();
    } catch {
      // 打不开目录不影响打包结果，前端仍会显示路径。
    }
  }

  // ---------------- 脚本语言服务（诊断 / 补全 / 悬浮提示）----------------
  //
  // 三个能力共用**同一个** LanguageService 实例（见 web/tools/script-language.mjs 文件头）：
  // 每次按键重建 program 会卡几百毫秒，而单实例 + 版本号增量更新后补全只要几毫秒。
  // 懒初始化：没用到补全的编辑器（或只做打包的场景）不必付这份代价。
  let scriptLanguagePromise = null;
  function scriptLanguage() {
    if (!scriptLanguagePromise) {
      scriptLanguagePromise = createScriptLanguageFromDisk({ webRoot }).catch((e) => {
        // 初始化失败时清掉 promise，让下一次调用能重试（而不是永久缓存一个 rejected promise）
        scriptLanguagePromise = null;
        throw e;
      });
    }
    return scriptLanguagePromise;
  }

  /**
   * 诊断（原 /api/js-check 的能力）。
   * 装配与判定规则全部在 script-language.mjs，这里只做「参数校验 + 组织返回」。
   */
  async function checkJsSource(body) {
    const source = String(body?.source ?? "");
    const name = String(body?.name ?? "script");
    const lang = await scriptLanguage();
    const result = lang.diagnostics(source);
    return { ...result, name };
  }

  /**
   * 补全：`{ source, offset }` → `{ ok, entries, isMemberAccess }`。
   *
   * ⚠ offset 是 **UTF-16 code unit 偏移**（TypeScript 约定）。渲染侧
   * `textarea.selectionStart` 同样是 UTF-16，两边天然一致 —— 不要做任何字符数换算，
   * 中英混排时按码点算会错位（这是这类功能最容易埋的雷）。
   */
  async function completeScript(body) {
    const source = String(body?.source ?? "");
    const offset = Number(body?.offset ?? 0);
    if (!Number.isFinite(offset) || offset < 0) {
      return { ok: false, entries: [], isMemberAccess: false, error: "offset 必须是非负数" };
    }
    const lang = await scriptLanguage();
    const result = lang.complete(source, offset);
    return { ok: true, entries: result.entries, isMemberAccess: result.isMemberAccess };
  }

  /**
   * 悬浮提示：`{ source, offset }` → `{ ok, info }`（info 为 null 表示该位置没有符号）。
   *
   * `info` 为 null 是**正常结果**（例如光标在括号/空白处），不是失败 ——
   * 调用方据此隐藏提示框即可，不该弹错误。
   */
  async function quickInfoScript(body) {
    const source = String(body?.source ?? "");
    const offset = Number(body?.offset ?? 0);
    if (!Number.isFinite(offset) || offset < 0) {
      return { ok: false, info: null, error: "offset 必须是非负数" };
    }
    const lang = await scriptLanguage();
    return { ok: true, info: lang.quickInfo(source, offset) };
  }

  /**
   * 跨脚本参数校验（references / definition 共用）。
   *
   * 这里只做「形状」校验，真正的符号解析在 script-language.mjs 里。分开的原因：
   * 校验失败的请求不该去建/污染语言服务的缓存（那是最贵的一步）。
   *
   * @returns {{ok:true, files, active, offset}|{ok:false, error:string}}
   */
  function parseScriptProjectArgs(body) {
    const files = body?.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      return { ok: false, error: "files 必须是「脚本名 → 源码」的对象" };
    }
    const names = Object.keys(files);
    if (names.length === 0) return { ok: false, error: "files 不能为空" };
    for (const name of names) {
      // 源码不是字符串就等于没给（否则 String() 会把对象变成 "[object Object]" 塞进解析器）
      if (typeof files[name] !== "string") return { ok: false, error: `files["${name}"] 必须是字符串` };
    }
    const active = String(body?.active ?? "");
    if (!Object.prototype.hasOwnProperty.call(files, active)) {
      return { ok: false, error: `active「${active}」不在 files 里` };
    }
    const offset = Number(body?.offset ?? 0);
    if (!Number.isFinite(offset) || offset < 0) {
      return { ok: false, error: "offset 必须是非负数" };
    }
    return { ok: true, files, active, offset };
  }

  /**
   * 跨脚本查找引用：`{ files, active, offset }` → `{ ok, refs }`。
   *
   * refs 里每条的 line/col 从 1 开始；name 是脚本名（命中声明文件时是 "__bwe_dts__"）。
   * 空数组是正常结果（光标不在任何符号上），不是失败。
   */
  async function scriptReferences(body) {
    const args = parseScriptProjectArgs(body);
    if (!args.ok) return { ok: false, refs: [], error: args.error };
    const lang = await scriptLanguage();
    return lang.references(args.files, args.active, args.offset);
  }

  /**
   * 跳转定义：`{ files, active, offset }` → `{ ok, defs }`。
   *
   * 与 scriptReferences 共用同一个语言服务实例（同一个项目级 program），
   * 所以「查完引用马上按 F12」不需要再付一次建 program 的代价。
   */
  async function scriptDefinition(body) {
    const args = parseScriptProjectArgs(body);
    if (!args.ok) return { ok: false, defs: [], error: args.error };
    const lang = await scriptLanguage();
    return lang.definition(args.files, args.active, args.offset);
  }

  // ---------------- /api/quick-run ----------------


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
    emit(message, "bwe:quickrun");
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
          { cwd: projectRoot, windowsHide: true, shell: false, env: { ...process.env } }
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

  /** 进程退出时兜底杀子进程，避免留下无主的 Java 窗口。 */
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

  // ---------------- 打包任务 ----------------

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

  // ---------------- 路由 ----------------

  /**
   * 处理一个 /api/* 请求（纯逻辑，不碰网络）。
   *
   * @param {object} req
   * @param {string} req.path            例如 "/api/js-check"
   * @param {string} [req.method]        GET/POST…
   * @param {Record<string,string>|URLSearchParams} [req.query]   query 参数（GET 用）
   * @param {string|unknown} [req.body]  POST 的 body。字符串按 JSON 解析；已解析对象直接用（IPC 走这条）
   * @returns {Promise<{status:number, json?:unknown, binary?:{data:Buffer, contentType:string, filename:string}}>}
   */
  async function handle(req) {
    const path = String(req?.path ?? "");
    const method = String(req?.method ?? "GET").toUpperCase();
    const query = toQuery(req?.query);
    const body = await readBody(req?.body);

    // ---------- /api/js-check ----------
    if (path === "/api/js-check" && method === "POST") {
      if (typeof body?.source !== "string") return json(400, { ok: false, error: "缺少 source（脚本源码）" });
      try {
        return json(200, await checkJsSource(body));
      } catch (e) {
        return json(500, { ok: false, error: e?.message || String(e) });
      }
    }

    // ---------- /api/script-complete：补全 ----------
    if (path === "/api/script-complete" && method === "POST") {
      try {
        return json(200, await completeScript(body));
      } catch (e) {
        return json(500, { ok: false, entries: [], isMemberAccess: false, error: e?.message || String(e) });
      }
    }

    // ---------- /api/script-quickinfo：悬浮提示 ----------
    if (path === "/api/script-quickinfo" && method === "POST") {
      try {
        return json(200, await quickInfoScript(body));
      } catch (e) {
        return json(500, { ok: false, info: null, error: e?.message || String(e) });
      }
    }

    // ---------- /api/script-references：跨脚本查找引用 ----------
    if (path === "/api/script-references" && method === "POST") {
      // 参数校验放在这里先做一次，好让 400 与 200 在 HTTP 层就能区分开
      // （业务函数内部也会再判一次 —— 它同时被桌面版 IPC 直接调用）。
      const args = parseScriptProjectArgs(body);
      if (!args.ok) return json(400, { ok: false, refs: [], error: args.error });
      try {
        return json(200, await scriptReferences(body));
      } catch (e) {
        return json(500, { ok: false, refs: [], error: e?.message || String(e) });
      }
    }

    // ---------- /api/script-definition：跳转定义 ----------
    if (path === "/api/script-definition" && method === "POST") {
      const args = parseScriptProjectArgs(body);
      if (!args.ok) return json(400, { ok: false, defs: [], error: args.error });
      try {
        return json(200, await scriptDefinition(body));
      } catch (e) {
        return json(500, { ok: false, defs: [], error: e?.message || String(e) });
      }
    }

    // ---------- /api/quick-run ----------
    if (path === "/api/quick-run" && method === "POST") {
      if (!body?.project || !Array.isArray(body.project.scenes) || body.project.scenes.length === 0) {
        return json(400, { ok: false, error: "缺少 project 或工程没有场景" });
      }
      // 已经有一个试跑在跑：先停掉旧的，避免两个 Java 窗口互相抢焦点。
      if (quickRunRunning()) await stopQuickRun();
      try {
        const result = await startQuickRun(body, (message) => appendRunLog(message));
        return json(result.ok ? 200 : 500, result);
      } catch (e) {
        const message = e?.message || String(e);
        appendRunLog(`试跑失败：${message}`);
        return json(500, { ok: false, error: message, logFile: quickRunLog, logTail: await readLogTail() });
      }
    }

    if (path === "/api/quick-run/status") {
      return json(200, {
        ok: true,
        running: quickRunRunning(),
        pid: quickRun.pid || null,
        project: quickRun.project,
        startedAt: quickRun.startedAt,
        logFile: quickRunLog,
        logTail: await readLogTail()
      });
    }

    if (path === "/api/quick-run/stop" && method === "POST") {
      const result = await stopQuickRun();
      return json(200, { ...result, running: quickRunRunning(), logTail: await readLogTail() });
    }

    // ---------- /api/open-in-vscode ----------
    if (path === "/api/open-in-vscode" && method === "POST") {
      if (typeof body?.name !== "string" || !body.name.trim()) {
        return json(400, { ok: false, error: "缺少 name（脚本名）" });
      }
      const lang = body.lang === "yarn" ? "yarn" : "js";
      const file = scriptMirrorPath(body.name, lang, body.project);
      try {
        await mkdir(dirname(file), { recursive: true });
        if (typeof body.source === "string") {
          await writeFile(file, body.source, "utf8");
        } else if (!existsSync(file)) {
          return json(400, { ok: false, error: "脚本没有源码，且镜像文件不存在" });
        }
        const command = await findEditorCommand();
        if (!command) {
          return json(200, {
            ok: false,
            file,
            error:
              "本机没找到 VS Code 命令（code）。装了 VS Code 但命令不可用时，" +
              "在 VS Code 里执行「Shell Command: Install 'code' command in PATH」，或手动打开下面这个文件。",
            hint: "文件已写到磁盘，可以直接用任意编辑器打开"
          });
        }
        launchEditor(command, file, Number(body.line) || 1);
        return json(200, { ok: true, file, command, lang });
      } catch (e) {
        return json(500, { ok: false, error: e?.message || String(e), file });
      }
    }

    // ---------- /api/script-file ----------
    if (path === "/api/script-file" && method === "GET") {
      const name = query.get("name") ?? "";
      const lang = query.get("lang") === "yarn" ? "yarn" : "js";
      if (!name.trim()) return json(400, { ok: false, error: "缺少 name" });
      const file = scriptMirrorPath(name, lang, query.get("project") ?? "");
      try {
        const info = await stat(file);
        const content = await readFile(file, "utf8");
        return json(200, { ok: true, file, content, mtimeMs: info.mtimeMs });
      } catch {
        return json(404, { ok: false, file, error: "镜像文件不存在（先点「VS Code 打开」）" });
      }
    }

    // ---------- /api/package-bwe/status ----------
    if (path === "/api/package-bwe/status" || (path === "/api/package-bwe" && method === "GET")) {
      const [javac, jpackage, candle, light, gradlewExists] = await Promise.all([
        which("javac"),
        which("jpackage"),
        which("candle.exe"),
        which("light.exe"),
        Promise.resolve(
          existsSync(join(projectRoot, "android", "gradlew")) || existsSync(join(projectRoot, "android", "gradlew.bat"))
        )
      ]);
      return json(200, {
        ok: javac && jpackage,
        node: process.version,
        javac,
        jpackage,
        wix: candle && light,
        // app-image + zip 不需要 WiX；安装器方案才会用到。
        appImage: javac && jpackage,
        android: {
          ok: Boolean(gradlewExists),
          gradlew: gradlewExists ? "gradlew" : null,
          projectDir: join(projectRoot, "android")
        },
        port,
        outRoot: join(webRoot, ".build", "packages"),
        // 桌面版（port=0）没有本地服务，前端据此隐藏「请先 npm run serve」的提示。
        host: port > 0 ? "web" : "desktop"
      });
    }

    if (path === "/api/package-bwe" && method === "POST") {
      if (!body?.project || !Array.isArray(body.project.scenes)) {
        return json(400, { ok: false, error: "缺少 project 或工程没有场景" });
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
      // 任务在后台跑，HTTP 版靠轮询 jobs/:id 拿进度；这里不能 await。
      void runJob(job, body);
      return json(202, { ok: true, jobId: id });
    }

    const jobMatch = /^\/api\/package-bwe\/jobs\/([^/]+)$/.exec(path);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(404, { ok: false, error: "任务不存在" });
      return json(200, { ok: true, job: jobPublic(job) });
    }

    const downloadMatch = /^\/api\/package-bwe\/download\/([^/]+)$/.exec(path);
    if (downloadMatch) {
      const job = jobs.get(downloadMatch[1]);
      if (!job?.result?.zipPath) return json(404, { ok: false, error: "安装包还没生成" });
      try {
        const data = await readFile(job.result.zipPath);
        return { status: 200, binary: { data, contentType: "application/zip", filename: stripForDownload(job.result.zipName) } };
      } catch (e) {
        return json(500, { ok: false, error: `读取安装包失败：${e.message}` });
      }
    }

    const downloadApkMatch = /^\/api\/package-bwe\/download-apk\/([^/]+)$/.exec(path);
    if (downloadApkMatch) {
      const job = jobs.get(downloadApkMatch[1]);
      const apkPath = job?.result?.apkPath;
      if (!apkPath) return json(404, { ok: false, error: "任务还没有产出 APK" });
      try {
        const data = await readFile(apkPath);
        return {
          status: 200,
          binary: {
            data,
            contentType: "application/octet-stream",
            filename: stripForDownload(`${job.result?.appName ?? "BWE-Android"}-debug.apk`)
          }
        };
      } catch (e) {
        return json(500, { ok: false, error: `读取 APK 失败：${e.message}` });
      }
    }

    const openMatch = /^\/api\/package-bwe\/open\/([^/]+)$/.exec(path);
    if (openMatch) {
      const job = jobs.get(openMatch[1]);
      if (!job?.result?.appDir) return json(404, { ok: false, error: "输出目录还没生成" });
      openExplorer(job.result.appDir);
      return json(200, { ok: true, path: job.result.appDir });
    }

    return { handled: false, ...json(404, { ok: false, error: "接口不存在" }) };
  }

  // ---------------- body 归一化 --------------

  function toQuery(q) {
    if (!q) return new URLSearchParams();
    if (q instanceof URLSearchParams) return q;
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === null) continue;
      out.set(k, String(v));
    }
    return out;
  }

  async function readBody(raw) {
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string") return raw;
    if (!raw.trim()) return null;
    if (raw.length > MAX_BODY) throw new Error("工程或素材太大（超过 320MB），请先压缩素材");
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`请求体不是合法 JSON：${e.message}`);
    }
  }

  return {
    handle,
    stopQuickRun,
    killQuickRunSync,
    // 桌面版直接调这几个（不经 HTTP，但**与 /api/script-complete、/api/script-quickinfo
    // 共用同一套语言服务**，保证两边结果一致）。
    completeScript,
    quickInfoScript,
    checkJsSource,
    scriptReferences,
    scriptDefinition,
    paths: { webRoot, projectRoot, quickRunRoot, quickRunLog, scriptMirrorDir },
    get port() {
      return port;
    }
  };
}
