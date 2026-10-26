#!/usr/bin/env node
/**
 * verify-scripting.mjs —— JS 脚本系统的「一条命令」端到端校验。
 *
 * 覆盖（五段，每段若干断言，全部汇总成一张 PASS/FAIL 表）：
 *   1. 示例工程结构 + 每段 js 脚本能被 TypeScript 降级到 ES5（无语法错误、产物里没有 ES6 语法）
 *   2. javac 编译 src/Studio/runtime/*.java（排除依赖 Swing 编辑器的 GameLauncher）
 *      → 跑 Studio.runtime.ScriptSelfTest（无窗口，纯 API 断言）
 *   3. 用 web/tools/package-bwe.mjs 的 writeQuickBuild 导出 Build（不 jpackage）
 *      → 检查 boot.json scripts[] 带 lang/file、Build/scripts/*.js 是 ES5、场景 onStartScript 透传
 *   4. LayoutDump（与渲染共用同一套 Viewport/sizeOf）验场景几何：地图/缩放/相机/对象世界与屏幕矩形
 *   5. 真起一次 TopDownRuntime（真实 GL 窗口），用 Win32 keybd_event 模拟 WASD/空格/E 约 4 秒，
 *      然后 taskkill；断言 Build/bwe.log 里没有 `[脚本错误]`、出现脚本自报的打点行
 *
 * 用法：
 *   node web/tools/verify-scripting.mjs                      # 全链路（会弹一次游戏窗口）
 *   node web/tools/verify-scripting.mjs --skip-run           # 跳过第 5 段（无窗口环境/CI）
 *   node web/tools/verify-scripting.mjs --project <路径>      # 换一个 .bwproj
 *   node web/tools/verify-scripting.mjs --seconds 5          # 真实运行时长
 *   node web/tools/verify-scripting.mjs --only export        # 只跑名字含 export 的段
 *   node web/tools/verify-scripting.mjs --report <路径>       # 默认 .tmp_rel8/report-scripting.md
 *   node web/tools/verify-scripting.mjs -h | --help
 *
 * 退出码：0 = 全 PASS（WARN 不算失败）；1 = 存在 FAIL；2 = 环境/前置依赖没就绪，链路没跑起来
 *        （例如 script-runtime 的 ScriptEngine.java 还没落地、找不到 javac/typescript）。
 *
 * 写盘范围：.tmp_rel8/verify-script/**、.tmp_rel8/report-scripting.md。
 * 不改任何源码；发现别人写域里的缺陷只报告 + 给最小复现命令。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------- 常量 ----------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP_DIR = path.join(REPO_ROOT, ".tmp_rel8", "verify-script");
const CLASSES_DIR = path.join(TMP_DIR, "classes");
const BUILD_ROOT = path.join(TMP_DIR, "build"); // writeQuickBuild 的 inputDir → build/Build/...
const BUILD_DIR = path.join(BUILD_ROOT, "Build");
const LOG_PATH = path.join(BUILD_DIR, "bwe.log");
const REPORT_PATH_DEFAULT = path.join(REPO_ROOT, ".tmp_rel8", "report-scripting.md");
const PROJECT_PATH_DEFAULT = path.join(REPO_ROOT, "web", "examples", "俯视角JS示例.bwproj");
const RUNTIME_SRC_DIR = path.join(REPO_ROOT, "src", "Studio", "runtime");
const LIB_DIR = path.join(REPO_ROOT, "lib");
const KEYS_PS1 = path.join(TMP_DIR, "send-keys.ps1");
const SHOT_PS1 = path.join(TMP_DIR, "capture-window.ps1");

/** 脚本里必须出现的打点（bwe.log 的行首前缀见 docs/scripting-api.md §4）。 */
const REQUIRED_LOGS = [
  { key: "[脚本] 已启动", why: "ScriptEngine 初始化成功并拉起全部 JS 脚本" },
  { key: "[脚本] system ready", why: "场景脚本 onStartScript 被执行（scene_0.json 的 onStartScript=system）" },
  { key: "[脚本] player ready", why: "对象脚本 script.js→player 的 onStart 被派发" },
  { key: "[脚本] chaser ready", why: "对象脚本 script.js→chaser 的 onStart 被派发" },
  { key: "[脚本] npc ready", why: "对象脚本 script.js→npc 的 onStart 被派发" },
  { key: "[脚本] hud ready", why: "对象脚本 script.js→hud 的 onStart 被派发" },
  { key: "[脚本] zone ready", why: "对象脚本 script.js→zone 的 onStart 被派发" },
  { key: "[脚本] tilemap 建好", why: "bwe.tilemap.set/setSolid + grid.toCell 生效" },
  { key: "[脚本] system spawner 已启动", why: "bwe.spawner.create 生效" },
  { key: "[脚本] hud ticked", why: "每帧 onUpdate 真的在跑（HUD 绘制路径）" },
  { key: "[脚本] system ticked", why: "bwe.every 定时器与 bwe.save.set 生效" }
];

/** 只有真窗口模式才可能出现的日志（headless 模式用别的等价断言）。 */
const WINDOWED_ONLY_LOGS = [
  { key: "窗口已打开", why: "运行时真的建了 GL 窗口" },
  { key: "视口映射:", why: "reshape/display 真的跑过（GL context 拿到）" }
];

/** 依赖交互/合成才出现的日志：缺失只 WARN，不判 FAIL（无键盘注入环境也能跑）。 */
const OPTIONAL_LOGS = [
  { key: "[脚本] player 开始移动", why: "WASD 注入被窗口接收 → bwe.input.axis() 有效" },
  { key: "[脚本] 拾取金币", why: "world.findAll + world.destroy + 事件总线" },
  { key: "[脚本] 玩家挥剑", why: "bwe.input.pressed(\"Space\") + entity.damage" },
  { key: "[脚本] npc 对话", why: "bwe.interact.prompt/onTrigger" },
  { key: "[脚本] 追击怪咬到玩家", why: "nav.find + entity.damage 打到玩家" },
  { key: "[脚本] 击杀计数", why: "world.emit(\"kill\") 事件总线闭环" },
  { key: "在治疗泉里回血", why: "触发区/距离判定生效" },
  { key: "刷出追击怪", why: "spawner 真的刷出了实体" }
];

const ES5_FORBIDDEN = [
  { name: "箭头函数 =>", re: /=>/ },
  { name: "class 声明", re: /\bclass\s+[A-Za-z_$]/ },
  { name: "let 声明", re: /\blet\s+[A-Za-z_$]/ },
  { name: "const 声明", re: /\bconst\s+[A-Za-z_$]/ },
  { name: "模板字符串 `", re: /`/ },
  { name: "for...of", re: /\bfor\s*\(\s*(?:var|let|const)\s+[A-Za-z_$][\w$]*\s+of\b/ }
];

/**
 * 开 GL 窗口要用哪个 java？
 *
 * 这台机器 PATH 上的 `java` 是 Oracle JDK 26，JOGL 2.1.2 在它上面初始化 GL 会失败
 * （窗口能建出来，但 reshape/display 一帧不跑 → 脚本永远不 tick）。Lead 实测
 * Microsoft OpenJDK 25 能正常出画面，所以这里优先找 25/24 的安装目录，
 * 找不到才退回 PATH（退回时第 5 段会走 headless 兜底，并把这个原因写进报告）。
 * 也可以用 `--java <路径>` 或环境变量 `BWE_JAVA` 显式指定。
 */
function findGlJava(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.BWE_JAVA) candidates.push(process.env.BWE_JAVA);
  for (const root of [
    "C:\\Program Files\\Microsoft",
    "C:\\Program Files\\Eclipse Adoptium",
    "C:\\Program Files\\Java",
    "C:\\Program Files\\Amazon Corretto"
  ]) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const d of dirs.sort().reverse()) {
      if (!/^jdk-?(25|24)/i.test(d)) continue;
      candidates.push(path.join(root, d, "bin", "java.exe"));
    }
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return "java";
}

/** JDK 9+ 才认这几个参数；JOGL 需要 native access，AWT/swing 需要 opens。 */
const JAVA_MODULE_FLAGS = [
  "--enable-native-access=ALL-UNNAMED",
  "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
  "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED"
];

/** main() 里按 --java / BWE_JAVA / 已知 JDK 25 安装目录定下来（headless/窗口都共用）。 */
let JAVA_GAME = "java";
let JAVA_GAME_VERSION = "unknown";

/**
 * headless 模式默认模拟多少秒。比窗口模式的 4 秒长：headless 是「离线快进」，
 * 不占真实时间，长一点才能把「走到 NPC 说话」「走进治疗泉」这些需要位移的交互跑出来。
 */
const HEADLESS_SIM_SECONDS = 14;

// ---------------- 小工具 ----------------

function log(msg = "") {
  process.stdout.write(msg + "\n");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function rel(p) {
  return path.relative(REPO_ROOT, p).replaceAll("\\", "/");
}

function dec(buf) {
  if (!buf) return "";
  return Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
}

function firstLine(s) {
  return String(s || "").split(/\r?\n/).find((l) => l.trim()) || "";
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "buffer",
    windowsHide: true,
    timeout: opts.timeout ?? 300_000,
    env: { ...process.env, ...(opts.env ?? {}) }
  });
  return {
    status: r.status,
    error: r.error,
    stdout: dec(r.stdout),
    stderr: dec(r.stderr),
    cmdline: [cmd, ...args].join(" ")
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function round(v, d = 2) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

function pct(a, b) {
  return `${a}/${b}`;
}

// ---------------- 结果收集 ----------------

const rows = [];
let setupError = null;

/**
 * @param {string} step  段落 id
 * @param {string} title 断言标题
 * @param {boolean} ok
 * @param {string} detail 期望/实际
 * @param {"FAIL"|"WARN"} [onFail] 失败时的级别，默认 FAIL
 */
function add(step, title, ok, detail = "", onFail = "FAIL") {
  const status = ok ? "PASS" : onFail;
  rows.push({ step, title, status, detail: String(detail ?? "") });
  return ok;
}

function skip(step, title, detail) {
  rows.push({ step, title, status: "SKIP", detail: String(detail ?? "") });
  return false;
}

function fatal(step, title, detail) {
  rows.push({ step, title, status: "FAIL", detail: String(detail ?? "") });
  setupError = setupError || `${title}${detail ? "：" + detail : ""}`;
  return false;
}

function group(step) {
  const list = rows.filter((r) => r.step === step);
  const bad = list.filter((r) => r.status === "FAIL").length;
  const warn = list.filter((r) => r.status === "WARN").length;
  return {
    step,
    total: list.length,
    pass: list.filter((r) => r.status === "PASS").length,
    fail: bad,
    warn,
    skip: list.filter((r) => r.status === "SKIP").length,
    status: list.length === 0 ? "SKIP" : bad > 0 ? "FAIL" : "PASS"
  };
}

// ---------------- 参数 ----------------

function parseArgs(argv) {
  const out = {
    projectPath: PROJECT_PATH_DEFAULT,
    reportPath: REPORT_PATH_DEFAULT,
    skipRun: false,
    headless: false,
    windowed: false,
    noShot: false,
    seconds: 4,
    only: "",
    verbose: false,
    help: false,
    javaPath: ""
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--skip-run") out.skipRun = true;
    else if (a === "--headless") out.headless = true;
    else if (a === "--windowed") out.windowed = true;
    else if (a === "--no-shot") out.noShot = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--project") out.projectPath = path.resolve(argv[++i]);
    else if (a === "--report") out.reportPath = path.resolve(argv[++i]);
    else if (a === "--java") out.javaPath = String(argv[++i] ?? "");
    else if (a === "--seconds") out.seconds = Math.max(1, Number(argv[++i]) || 4);
    else if (a === "--only") out.only = String(argv[++i] ?? "");
    else if (a.startsWith("--project=")) out.projectPath = path.resolve(a.slice(10));
    else if (a.startsWith("--report=")) out.reportPath = path.resolve(a.slice(9));
    else if (a.startsWith("--java=")) out.javaPath = a.slice(7);
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

function usage() {
  log(`JS 脚本系统端到端校验

用法: node web/tools/verify-scripting.mjs [选项]
  --project <路径>   .bwproj 路径，默认 web/examples/俯视角JS示例.bwproj
  --report <路径>    报告输出，默认 .tmp_rel8/report-scripting.md
  --java <路径>      开 GL 窗口用的 java，默认自动找 Microsoft JDK 25（PATH 上的 JDK 26 跑不了 JOGL）
  --skip-run         跳过「真实运行 + 日志断言」这一段（无窗口/CI 环境）
  --headless         强制用无窗口驱动（同一份 Build，手动推进 N 帧；不弹窗）
  --windowed         强制用真窗口模式（即使本机检测到没有显示设备）
  --no-shot          真窗口跑完后不截图（默认会存 .tmp_rel8/verify-script/screenshot.png）
  --seconds N        真实运行时长（秒），默认 4（headless 模式最少模拟 8 秒）
  --only <关键字>    只跑名字含该关键字的段（project/java/export/layout/run）
  --verbose          打印每条断言的明细
  -h, --help         显示帮助

退出码: 0 全 PASS（WARN 不算失败）/ 1 有 FAIL / 2 前置依赖没就绪，链路没跑起来`);
}

// ---------------- 1) 工程结构 + 脚本 transpile ----------------

function loadTypeScript() {
  const require = createRequire(path.join(REPO_ROOT, "package.json"));
  try {
    return require("typescript");
  } catch {
    return null;
  }
}

/**
 * TypeScript 降级到 ES5，返回 { ok, diagnostics, output }。
 *
 * 与 web/tools/package-bwe.mjs#transpileJsScript 用同一套选项（target ES5 / module None），
 * 差别只在这里把**选项级**诊断（没有 d.file，例如 transpileModule 内部固定的
 * isolatedModules 提示）过滤掉——它跟用户脚本无关，不能算语法错误。
 */
function transpileToEs5(ts, source, fileName) {
  const result = ts.transpileModule(source, {
    fileName: fileName.endsWith(".js") ? fileName : fileName + ".js",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.None,
      // 不生成 "use strict"：脚本共享一个全局作用域，ES5 下给未声明变量赋值才合法。
      alwaysStrict: false,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed
    }
  });
  const diagnostics = (result.diagnostics ?? [])
    .filter((d) => d.file && d.category === ts.DiagnosticCategory.Error)
    .map((d) => {
      const pos = d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      const where = pos ? `${pos.line + 1}:${pos.character + 1}` : "?";
      return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
  return { ok: diagnostics.length === 0, diagnostics, output: result.outputText ?? "" };
}

function checkEs5(output) {
  const hits = ES5_FORBIDDEN.filter((rule) => rule.re.test(output)).map((r) => r.name);
  return { ok: hits.length === 0 && /\bvar\s/.test(output), hits };
}

function normalizeScriptEntries(project) {
  const entries = Object.entries(project.scripts ?? {}).map(([key, s]) => ({
    key,
    name: String(s?.name ?? key ?? ""),
    file: String(s?.file ?? ""),
    lang: String(s?.lang ?? "yarn"),
    source: String(s?.source ?? "")
  }));
  return entries;
}

function stepProject(opts) {
  const step = "project";
  if (!fs.existsSync(opts.projectPath)) {
    fatal(step, "示例工程存在", `找不到 ${rel(opts.projectPath)}`);
    return;
  }
  let project;
  try {
    project = readJson(opts.projectPath);
  } catch (e) {
    fatal(step, "示例工程是合法 JSON", String(e.message));
    return;
  }
  add(step, "示例工程是合法 JSON", true, rel(opts.projectPath));

  // ---- 地图 / 场景结构（对齐 web/src/core/model.ts 与 mapping-contract） ----
  const scene = project.scenes?.[0];
  add(step, "工程有且只有一张场景（运行时只加载 scenes[0]）", Array.isArray(project.scenes) && project.scenes.length >= 1, `scenes=${project.scenes?.length ?? 0}`);
  add(step, "地图 40x30 格 @32px", scene?.widthTiles === 40 && scene?.heightTiles === 30 && project.tileSize === 32,
    `grid=${scene?.widthTiles}x${scene?.heightTiles} tileSize=${project.tileSize}`);
  add(step, "场景有 3 个图层且对象都挂在图层上", (scene?.layers?.length ?? 0) === 3 && (scene?.objects ?? []).every((o) => (scene.layers ?? []).some((l) => l.id === o.layerId)),
    `layers=${scene?.layers?.length ?? 0}`);

  const objects = scene?.objects ?? [];
  const byKind = {};
  for (const o of objects) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
  add(step, "对象种类齐全（ACTOR/PROP/TILE/ZONE）",
    ["ACTOR", "PROP", "TILE", "ZONE"].every((k) => (byKind[k] ?? 0) > 0),
    Object.entries(byKind).map(([k, v]) => `${k}×${v}`).join(" "));

  const named = (n) => objects.find((o) => o.name === n);
  add(step, "玩家对象：ACTOR + tag 玩家", named("玩家")?.kind === "ACTOR" && (named("玩家")?.tags ?? []).includes("玩家"),
    `kind=${named("玩家")?.kind} tags=${JSON.stringify(named("玩家")?.tags)}`);
  add(step, "追击怪 ×2（tag 敌人）", objects.filter((o) => (o.tags ?? []).includes("敌人")).length === 2,
    `敌人=${objects.filter((o) => (o.tags ?? []).includes("敌人")).length}`);
  add(step, "NPC / 触发区 ZONE / 金币 / HUD 控制器都存在",
    Boolean(named("阿岚")) && Boolean(named("治疗泉")) && objects.some((o) => (o.tags ?? []).includes("金币")) && Boolean(named("HUD 控制器")),
    `阿岚=${Boolean(named("阿岚"))} 治疗泉=${Boolean(named("治疗泉"))} 金币=${objects.filter((o) => (o.tags ?? []).includes("金币")).length}`);
  add(step, "墙体格子用 halfW/halfH=16 正好一格（mapping-contract §2 优先级 1）",
    objects.filter((o) => o.kind === "TILE").every((o) => o.halfW === 16 && o.halfH === 16),
    `TILE=${byKind.TILE ?? 0}`);
  add(step, "地面用 props.w/h 铺满整张地图（优先级 2）",
    named("地面")?.props?.w === "1280" && named("地面")?.props?.h === "960",
    `props=${JSON.stringify(named("地面")?.props)}`);

  // ---- 脚本表 ----
  const scripts = normalizeScriptEntries(project);
  const jsScripts = scripts.filter((s) => s.lang === "js");
  add(step, "scripts 表非空且全部 lang=\"js\"", scripts.length > 0 && jsScripts.length === scripts.length,
    `总数=${scripts.length} js=${jsScripts.length} 非js=${scripts.filter((s) => s.lang !== "js").map((s) => s.key).join(",") || "无"}`);
  add(step, "每段 js 脚本都有 name/file/source", jsScripts.every((s) => s.name && s.file && s.source.length > 20),
    jsScripts.map((s) => `${s.name}(${s.source.length}B)`).join(" "));

  const scriptNames = new Set(scripts.map((s) => s.name));
  add(step, "五个玩法脚本 + 触发区脚本都在（player/chaser/npc/hud/zone/system）",
    ["player", "chaser", "npc", "hud", "zone", "system"].every((n) => scriptNames.has(n)),
    [...scriptNames].join(","));

  // 对象上的 script.js 模块必须指向存在的脚本
  const refs = [];
  for (const o of objects) {
    for (const m of o.modules ?? []) {
      if (m.defId === "script.js") refs.push({ owner: o.name, script: String(m.values?.script ?? "") });
    }
  }
  add(step, "对象上的 script.js 模块都指向存在的脚本",
    refs.length >= 6 && refs.every((r) => scriptNames.has(r.script)),
    refs.map((r) => `${r.owner}→${r.script || "(空)"}`).join(" "));
  add(step, "场景 onStartScript 指向存在的脚本",
    Boolean(scene?.onStartScript) && scriptNames.has(scene.onStartScript),
    `onStartScript=${scene?.onStartScript}`);

  // ---- 打点行（校验第 5 段要断言这些） ----
  const markerMissing = [];
  for (const need of ["[脚本] player ready", "[脚本] hud ready", "[脚本] system ready"]) {
    if (!jsScripts.some((s) => s.source.includes(need))) markerMissing.push(need);
  }
  add(step, "脚本源码里有 bwe.log 打点（filed 会被第 5 段断言）", markerMissing.length === 0,
    markerMissing.length ? `缺：${markerMissing.join(", ")}` : `${jsScripts.reduce((n, s) => n + (s.source.match(/bwe\.log\(/g) ?? []).length, 0)} 处 bwe.log`);

  // ---- TypeScript 降级 ES5 ----
  const ts = loadTypeScript();
  if (!ts) {
    fatal(step, "仓库里有 typescript", "仓库根 node_modules/typescript 不存在");
    return;
  }
  add(step, "仓库里有 typescript（不需要新增依赖）", true, `typescript ${ts.version}`);

  let es5Failures = 0;
  for (const s of jsScripts) {
    const t = transpileToEs5(ts, s.source, s.name + ".js");
    const e = checkEs5(t.output);
    const ok = t.ok && e.ok;
    if (!ok) es5Failures += 1;
    const detail = !t.ok
      ? `语法错误：${t.diagnostics.slice(0, 3).join(" | ")}`
      : !e.ok
        ? `产物不是 ES5：${e.hits.join(", ") || "缺少 var"}（${t.output.length}B）`
        : `${t.output.length}B → ES5`;
    add(step, `transpile ${s.name}.js → ES5（无语法错误、无 ES6 语法）`, ok, detail);
    // 顺带把产物留档，便于人工核对
    ensureDir(path.join(TMP_DIR, "es5"));
    fs.writeFileSync(path.join(TMP_DIR, "es5", `${s.name}.js`), t.output, "utf8");
  }
  add(step, "所有 js 脚本都能降级到 ES5", es5Failures === 0, `${pct(jsScripts.length - es5Failures, jsScripts.length)} 通过`);

  // ---- 模块目录（editor-js 的写域：只读检查） ----
  const modulesTs = path.join(REPO_ROOT, "web", "src", "data", "modules.ts");
  const modulesSrc = fs.existsSync(modulesTs) ? fs.readFileSync(modulesTs, "utf8") : "";
  add(step, "web/src/data/modules.ts 里有 script.js 模块（编辑器才能挂脚本）",
    /id:\s*"script\.js"/.test(modulesSrc),
    fs.existsSync(modulesTs) ? (modulesSrc.includes("script.js") ? "已定义" : "未定义 script.js") : "modules.ts 不存在");
  const dts = path.join(REPO_ROOT, "web", "src", "js", "bwe.d.ts");
  add(step, "web/src/js/bwe.d.ts 存在（/api/js-check 的类型真值）", fs.existsSync(dts),
    fs.existsSync(dts) ? `${fs.statSync(dts).size}B` : "不存在", "WARN");
}

// ---------------- 2) 编译 Java + ScriptSelfTest ----------------

function compileRuntime() {
  const files = fs
    .readdirSync(RUNTIME_SRC_DIR)
    .filter((f) => f.endsWith(".java") && f !== "GameLauncher.java")
    .sort();
  if (!files.length) throw new Error(`找不到运行时源码：${RUNTIME_SRC_DIR}`);

  rmrf(CLASSES_DIR);
  ensureDir(CLASSES_DIR);
  const baseArgs = [
    "-J-Duser.language=en",
    "-J-Duser.country=US",
    "-encoding",
    "UTF-8",
    "-cp",
    path.join(LIB_DIR, "*"),
    "-d",
    CLASSES_DIR,
    ...files.map((f) => path.join(RUNTIME_SRC_DIR, f))
  ];
  let r = run("javac", ["--release", "8", ...baseArgs]);
  let usedRelease = "8";
  if (r.status !== 0) {
    // 本机 JDK 可能已经移除对 8 的支持（例如 JDK 21+ 的后续版本），退回默认 release，语义不变。
    r = run("javac", baseArgs);
    usedRelease = "default";
  }
  if (r.status !== 0) {
    throw new Error(`javac 编译失败 (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
  }
  return { files, usedRelease, stdout: r.stdout, stderr: r.stderr };
}

function javaClasspath() {
  return [CLASSES_DIR, path.join(LIB_DIR, "*")].join(path.delimiter);
}

/** 运行时源码里最新的 mtime（用来判断 .tmp 里的 class 是不是过期了）。 */
function latestRuntimeSourceMtime() {
  let newest = 0;
  try {
    for (const f of fs.readdirSync(RUNTIME_SRC_DIR)) {
      if (!f.endsWith(".java")) continue;
      newest = Math.max(newest, fs.statSync(path.join(RUNTIME_SRC_DIR, f)).mtimeMs);
    }
  } catch {
    /* ignore */
  }
  return newest;
}

/**
 * `--only run` / `--only layout` 会跳过第 2 段，但队友可能刚改过 Java 源码：
 * class 过期会让「脚本不跑」看起来像脚本系统的 bug（实测踩过：cell 上有莫名的 tile）。
 * 所以这两段在使用编译产物前先确认一手。
 */
function ensureFreshClasses(step) {
  const marker = path.join(CLASSES_DIR, "Studio", "runtime", "TopDownRuntime.class");
  if (!fs.existsSync(marker)) {
    add(step, "编译产物已就绪", false, `缺 ${rel(marker)}（先跑一次完整校验，或去掉 --only）`);
    return false;
  }
  const stale = fs.statSync(marker).mtimeMs < latestRuntimeSourceMtime();
  if (!stale) {
    add(step, "编译产物比 Java 源码新", true, "class 未过期");
    return true;
  }
  try {
    compileRuntime();
    add(step, "编译产物比 Java 源码新", true, "源码更新过 → 已自动重新编译");
    return true;
  } catch (e) {
    add(step, "编译产物比 Java 源码新", false, `源码更新过，自动重编译失败：${String(e.message).split("\n").slice(0, 4).join(" / ")}`);
    return false;
  }
}

function stepJava() {
  const step = "java";
  const engineFile = path.join(RUNTIME_SRC_DIR, "ScriptEngine.java");
  const selfTestFile = path.join(RUNTIME_SRC_DIR, "ScriptSelfTest.java");

  if (!add(step, "script-runtime 的 ScriptEngine.java 已落地", fs.existsSync(engineFile),
    fs.existsSync(engineFile) ? `${fs.statSync(engineFile).size}B` : "src/Studio/runtime/ScriptEngine.java 不存在")) {
    skip(step, "javac 编译运行时", "缺 ScriptEngine.java，编译必失败");
    skip(step, "ScriptSelfTest 全绿", "缺 ScriptSelfTest.java / 无法编译");
    fatal(step, "ScriptEngine.java 就绪", "等队友 script-runtime 落地");
    return;
  }
  if (!add(step, "script-runtime 的 ScriptSelfTest.java 已落地", fs.existsSync(selfTestFile),
    fs.existsSync(selfTestFile) ? `${fs.statSync(selfTestFile).size}B` : "src/Studio/runtime/ScriptSelfTest.java 不存在")) {
    skip(step, "ScriptSelfTest 全绿", "缺 ScriptSelfTest.java");
    fatal(step, "ScriptSelfTest.java 就绪", "等队友 script-runtime 落地");
    return;
  }
  add(step, "lib/ 里有 rhino-1.7.15.jar（运行时唯一新增依赖）",
    fs.existsSync(path.join(LIB_DIR, "rhino-1.7.15.jar")),
    fs.existsSync(path.join(LIB_DIR, "rhino-1.7.15.jar")) ? "存在" : "缺失");

  let compiled;
  try {
    compiled = compileRuntime();
  } catch (e) {
    fatal(step, "javac 编译运行时（排除 GameLauncher）", String(e.message).split("\n").slice(0, 6).join(" / "));
    skip(step, "ScriptSelfTest 全绿", "编译失败");
    return;
  }
  add(step, "javac 编译运行时（排除 GameLauncher）", true,
    `${compiled.files.length} 个 java → ${rel(CLASSES_DIR)}（--release ${compiled.usedRelease}）`);

  // -Dstdout.encoding：Windows 中文控制台默认 GBK，Java 侧把中文写成 GBK 字节，
  // 我们用 UTF-8 解码就会变乱码（写进报告很难看），所以显式要求 UTF-8 输出。
  const r = run(JAVA_GAME, [...JAVA_MODULE_FLAGS, "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-cp", javaClasspath(), "Studio.runtime.ScriptSelfTest"], {
    timeout: 180_000
  });
  const tail = (r.stdout + r.stderr).trim().split(/\r?\n/).slice(-6).join(" | ");
  add(step, "ScriptSelfTest 全绿（无窗口断言 Phase 1 API）", r.status === 0,
    r.status === 0 ? firstLine(r.stdout) : `exit ${r.status}：${tail}`);
  fs.writeFileSync(path.join(TMP_DIR, "selftest.log"), r.stdout + "\n--- stderr ---\n" + r.stderr, "utf8");
}

// ---------------- 3) 导出 Build（不 jpackage） ----------------

async function exportBuild(project, opts) {
  rmrf(BUILD_ROOT);
  ensureDir(BUILD_ROOT);

  const pkgPath = path.join(REPO_ROOT, "web", "tools", "package-bwe.mjs");
  if (!fs.existsSync(pkgPath)) return { ok: false, error: "web/tools/package-bwe.mjs 不存在" };

  let mod = null;
  try {
    mod = await import(pathToFileURL(pkgPath).href);
  } catch (e) {
    return { ok: false, error: `动态 import 失败：${e.message}` };
  }
  if (typeof mod.writeQuickBuild !== "function") {
    // 退回 CLI 的 --build-only（packaging-quickrun 承诺两种入口等价）
    const r = run("node", ["web/tools/package-bwe.mjs", opts.projectPath, "--build-only", BUILD_ROOT], { timeout: 180_000 });
    if (r.status !== 0) return { ok: false, error: `writeQuickBuild 未导出，CLI --build-only 也失败（exit ${r.status}）：${firstLine(r.stderr)}` };
    return { ok: true, via: "cli --build-only", warnings: [], log: r.stdout };
  }
  try {
    const res = await mod.writeQuickBuild(project, null, BUILD_ROOT, () => {});
    return { ok: true, via: "writeQuickBuild", warnings: res?.warnings ?? [], res };
  } catch (e) {
    return { ok: false, error: `writeQuickBuild 抛错：${e.message}` };
  }
}

async function stepExport(project, opts) {
  const step = "export";
  const ex = await exportBuild(project, opts);
  if (!add(step, "导出 Build（package-bwe.mjs，不 jpackage）", ex.ok, ex.ok ? `via ${ex.via}` : ex.error)) {
    skip(step, "boot.json scripts[] 带 lang/file", "没有 Build");
    skip(step, "Build/scripts/*.js 是 ES5", "没有 Build");
    return;
  }
  for (const w of ex.warnings ?? []) log(`      ⚠ 导出告警：${w}`);

  const bootFile = path.join(BUILD_DIR, "boot.json");
  if (!add(step, "Build/boot.json 存在", fs.existsSync(bootFile), rel(bootFile))) return;
  const boot = readJson(bootFile);

  // ---- boot.json 的脚本条目 ----
  const bootScripts = Array.isArray(boot.scripts) ? boot.scripts : [];
  const projectScripts = normalizeScriptEntries(project);
  const jsProjectScripts = projectScripts.filter((s) => s.lang === "js");

  add(step, "boot.json scripts[] 条数 = 工程里的 js 脚本数", bootScripts.length === jsProjectScripts.length,
    `boot=${bootScripts.length} project=${jsProjectScripts.length}`);

  const badEntries = bootScripts.filter(
    (s) => !s || !s.name || s.lang !== "js" || typeof s.file !== "string" || !/^scripts\/[\w.\-\u4e00-\u9fa5]+\.js$/.test(s.file)
  );
  add(step, "boot.json 每条 script 都带 lang=\"js\" 与 scripts/<名>.js 的 file", bootScripts.length > 0 && badEntries.length === 0,
    badEntries.length ? JSON.stringify(badEntries.slice(0, 2)) : bootScripts.map((s) => `${s.name}:${s.file}`).join(" "));

  const fileMissing = bootScripts.filter((s) => !fs.existsSync(path.join(BUILD_DIR, s.file)));
  add(step, "boot.json 引用的 Build/scripts/*.js 都真的存在", bootScripts.length > 0 && fileMissing.length === 0,
    fileMissing.length ? fileMissing.map((s) => s.file).join(",") : `${bootScripts.length} 个文件`);

  // ---- 脚本文件内容必须是 ES5 ----
  const es5Bad = [];
  const es5Sizes = [];
  for (const s of bootScripts) {
    const abs = path.join(BUILD_DIR, s.file);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, "utf8");
    const e = checkEs5(src);
    es5Sizes.push(`${s.name} ${src.length}B`);
    if (!e.ok) es5Bad.push(`${s.name}(${e.hits.join(",") || "无 var"})`);
  }
  add(step, "Build/scripts/*.js 是 ES5（有 var，无 =>/class/let/const/模板串/for-of）", es5Bad.length === 0 && es5Sizes.length > 0,
    es5Bad.length ? es5Bad.join(" ") : es5Sizes.join(" "));

  // 产物里必须保留打点字面量（Rhino 跑起来才有对应日志）
  const playerJs = bootScripts.find((s) => s.name === "player");
  const playerSrc = playerJs ? fs.readFileSync(path.join(BUILD_DIR, playerJs.file), "utf8") : "";
  add(step, "导出后的 player.js 仍含中文打点 [脚本] player ready", playerSrc.includes("[脚本] player ready"),
    playerSrc.includes("[脚本] player ready") ? "ok" : "被打点丢失/编码损坏");

  // ---- 场景 JSON ----
  const sceneFile = path.join(BUILD_DIR, boot.scenes?.[0]?.file ?? "scene_0.json");
  if (!add(step, "Build/scene_0.json 存在", fs.existsSync(sceneFile), rel(sceneFile))) return;
  const sceneJson = readJson(sceneFile);
  add(step, "scene.onStartScript 透传为 system", sceneJson.onStartScript === "system", `onStartScript=${sceneJson.onStartScript}`);
  add(step, "scene 尺寸与 tileSize 正确", sceneJson.width === 40 && sceneJson.height === 30 && sceneJson.tileSize === 32,
    `${sceneJson.width}x${sceneJson.height} @${sceneJson.tileSize}`);

  const objs = sceneJson.objects ?? [];
  add(step, "场景对象数与 .bwproj 一致", objs.length === (project.scenes?.[0]?.objects?.length ?? -1),
    `Build=${objs.length} project=${project.scenes?.[0]?.objects?.length ?? "?"}`);

  const scriptMods = [];
  for (const o of objs) for (const m of o.modules ?? []) if (m.def === "script.js") scriptMods.push({ owner: o.name, script: m.params?.script });
  add(step, "Build 里对象模块是 {def:\"script.js\", params:{script:\"...\"}}",
    scriptMods.length >= 6 && scriptMods.every((m) => typeof m.script === "string" && m.script.length > 0),
    scriptMods.map((m) => `${m.owner}→${m.script}`).join(" "));

  const tagsKept = objs.filter((o) => o.name === "玩家").every((o) => (o.tags ?? []).includes("玩家"));
  add(step, "tags 原样导出（脚本按 tag 找实体）", tagsKept, `玩家 tags=${JSON.stringify(objs.find((o) => o.name === "玩家")?.tags)}`);

  const invisible = objs.filter((o) => o.name === "治疗泉" || o.name === "HUD 控制器");
  add(step, "不可见对象（治疗泉 / HUD 控制器）导出 visible=false", invisible.length === 2 && invisible.every((o) => o.visible === false),
    invisible.map((o) => `${o.name}:${o.visible}`).join(" "));

  const assets = Array.isArray(boot.assets) ? boot.assets : [];
  const assetFilesMissing = assets.filter((a) => !a.path || !fs.existsSync(path.join(BUILD_DIR, "..", a.path.replace(/^Build\//, "Build/"))));
  add(step, "6 个素材都落盘成 PNG（Java ImageIO 能读）", assets.length === 6 && assetFilesMissing.length === 0,
    assets.length === 6 && assetFilesMissing.length === 0 ? assets.map((a) => a.name).join(",") : `缺文件：${assetFilesMissing.map((a) => a.name).join(",") || "素材数=" + assets.length}`);

  return { boot, sceneJson };
}

// ---------------- 4) LayoutDump 几何 ----------------

function runLayoutDump(bootFile, view, outFile, fitMode) {
  const r = run(JAVA_GAME, [
    ...JAVA_MODULE_FLAGS,
    "-Dstdout.encoding=UTF-8",
    "-Dstderr.encoding=UTF-8",
    "-cp", javaClasspath(),
    "Studio.runtime.LayoutDump",
    "--boot", bootFile,
    "--view", `${view.w}x${view.h}`,
    ...(fitMode ? ["--fit", fitMode] : []),
    "--out", outFile
  ]);
  if (r.status !== 0) throw new Error(`LayoutDump 失败 (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
  return readJson(outFile);
}

function stepLayout(build) {
  const step = "layout";
  const bootFile = path.join(BUILD_DIR, "boot.json");
  if (!fs.existsSync(bootFile) || !build?.boot) {
    skip(step, "LayoutDump 几何自检", "没有 Build/boot.json（第 3 段没跑通）");
    return;
  }
  if (!fs.existsSync(path.join(CLASSES_DIR, "Studio", "runtime", "LayoutDump.class"))) {
    skip(step, "LayoutDump 几何自检", "没有编译产物（第 2 段没跑通），LayoutDump 起不来");
    return;
  }
  if (!ensureFreshClasses(step)) {
    skip(step, "LayoutDump 几何自检", "编译产物不可用");
    return;
  }
  const view = { w: 1280, h: 720 };
  let layout;
  try {
    layout = runLayoutDump(bootFile, view, path.join(TMP_DIR, "layout-contain.json"), "contain");
  } catch (e) {
    add(step, "LayoutDump 能跑通（不建窗口输出几何）", false, String(e.message).split("\n").slice(0, 4).join(" / "));
    return;
  }
  add(step, "LayoutDump 能跑通（不建窗口输出几何）", true, rel(path.join(TMP_DIR, "layout-contain.json")));

  add(step, "地图与 tileSize 正确", layout.tileSize === 32 && layout.map?.width === 1280 && layout.map?.height === 960,
    `tileSize=${layout.tileSize} map=${layout.map?.width}x${layout.map?.height}`);
  add(step, "视口正确", layout.viewport?.width === view.w && layout.viewport?.height === view.h,
    `${layout.viewport?.width}x${layout.viewport?.height}`);

  // contain: zoom = clamp(min(vw/mapW, vh/mapH), 0.15, 4)
  const expectZoom = Math.min(view.w / 1280, view.h / 960);
  add(step, "zoom = clamp(min(vw/mapW, vh/mapH), 0.15, 4) = 0.75",
    Math.abs((layout.zoom ?? 0) - expectZoom) <= 0.01, `实际 ${layout.zoom}，期望 ${round(expectZoom, 4)}`);
  add(step, "相机对准地图中心（contain 整图留边）",
    Math.abs((layout.camera?.x ?? -1) - 640) <= 0.5 && Math.abs((layout.camera?.y ?? -1) - 480) <= 0.5,
    `camera=(${layout.camera?.x},${layout.camera?.y}) 期望 (640,480)`);
  add(step, "fitMode 回显 contain", layout.fitMode === "contain", `fitMode=${layout.fitMode}`);

  const objs = layout.objects ?? [];
  add(step, "LayoutDump 对象数与场景对象数一致", objs.length === (build.sceneJson?.objects?.length ?? -1),
    `dump=${objs.length}`);

  const byName = (n) => objs.find((o) => o.name === n);
  const player = byName("玩家");
  add(step, "玩家世界矩形 24x24（halfW/halfH=12，不乘 scale）",
    Boolean(player) && Math.abs(player.world.w - 24) < 0.01 && Math.abs(player.world.h - 24) < 0.01,
    player ? `world=${player.world.w}x${player.world.h} @(${player.world.x},${player.world.y})` : "找不到玩家");
  add(step, "玩家位置 = 格(3,3) 中心 (112,112)",
    Boolean(player) && Math.abs(player.world.x - 112) < 0.01 && Math.abs(player.world.y - 112) < 0.01,
    player ? `(${player.world.x},${player.world.y})` : "找不到玩家");

  const ground = byName("地面");
  add(step, "地面世界矩形 1280x960（props.w/h 优先级）",
    Boolean(ground) && Math.abs(ground.world.w - 1280) < 0.01 && Math.abs(ground.world.h - 960) < 0.01,
    ground ? `${ground.world.w}x${ground.world.h}` : "找不到地面");

  const wall = objs.find((o) => o.kind === "TILE");
  add(step, "墙体世界矩形 32x32（halfW/halfH=16 优先级最高）",
    Boolean(wall) && Math.abs(wall.world.w - 32) < 0.01 && Math.abs(wall.world.h - 32) < 0.01,
    wall ? `${wall.world.w}x${wall.world.h}` : "找不到墙体");

  // screen = (world - cam) * zoom + view/2
  if (player) {
    const sx = (player.world.x - layout.camera.x) * layout.zoom + view.w / 2;
    const sy = (player.world.y - layout.camera.y) * layout.zoom + view.h / 2;
    add(step, "屏幕坐标复算一致：screen = (world-cam)*zoom + view/2",
      Math.abs(player.screen.cx - sx) <= 0.05 && Math.abs(player.screen.cy - sy) <= 0.05,
      `dump=(${player.screen.cx},${player.screen.cy}) 复算=(${round(sx, 2)},${round(sy, 2)})`);
  }

  const visible = objs.filter((o) => o.visible !== false);
  const outside = visible.filter(
    (o) => o.screen.left < -0.5 || o.screen.top < -0.5 || o.screen.left + o.screen.w > view.w + 0.5 || o.screen.top + o.screen.h > view.h + 0.5
  );
  add(step, "所有可见对象都落在视口内（contain 不裁切）", outside.length === 0,
    outside.length ? outside.slice(0, 3).map((o) => `${o.name}@(${o.screen.left},${o.screen.top},${o.screen.w}x${o.screen.h})`).join(" ") : `${visible.length} 个可见对象`);

  const wrongLayer = objs.filter((o) => o.visible !== false && !Number.isInteger(o.layer));
  add(step, "每个对象都带整数 layer（绘制顺序 layer→z→y）", wrongLayer.length === 0, wrongLayer.length ? `${wrongLayer.length} 个缺 layer` : "ok");

  const invisibleInDump = objs.filter((o) => o.visible === false).length;
  add(step, "不可见对象在 dump 里 visible=false", invisibleInDump >= 2, `不可见=${invisibleInDump}`);
}

// ---------------- 5) 真起一次运行时 + 日志断言 ----------------

/**
 * 无窗口驱动（headless 兜底）。
 *
 * 为什么需要它：真实运行那一段要开 GL 窗口，但**没有显示设备的会话**（远程/服务会话、
 * CI、`GraphicsEnvironment.getScreenDevices()` 为空的 Windows session）里 JOGL 拿不到
 * GL context，`display()` 一帧都不会跑，于是 `TopDownRuntime.update()` 也不会被调用，
 * 脚本自然一条日志都没有——那是环境限制，不是脚本系统坏了。
 *
 * 这个 driver 用**同一份 Build**（真 boot.json + 真 scene_0.json + 真 scripts/*.js）
 * 构造真 `TopDownRuntime`（因此是真 ScriptEngine、真 spawn、真模块），然后手动推进 N 帧：
 *   - 优先反射调 `TopDownRuntime.update(dt)`，等价于 GL 线程每帧做的事（模块/相机/脚本都跑）；
 *   - 反射失败则退回 `rt.scripts.update(dt)`（只跑脚本引擎，与 ScriptSelfTest 同一条路）。
 * 键盘直接写宿主 `rt.keys[]`（和 AWT KeyListener 写的是同一个数组），比 keybd_event 更稳。
 *
 * 它**不改任何运行时行为**，只是在同包里调用 package-private/private 入口。
 */
const HEADLESS_JAVA_SRC = String.raw`package Studio.runtime;

import java.awt.GraphicsEnvironment;
import java.awt.event.KeyEvent;
import java.io.File;
import java.lang.reflect.Method;

/**
 * 由 web/tools/verify-scripting.mjs 生成的无窗口驱动器（校验用，不是运行时代码）。
 *
 * 用法：
 *   java -cp "<classes>;lib/*" Studio.runtime.HeadlessRun probe
 *   java -cp "<classes>;lib/*" Studio.runtime.HeadlessRun run <Build/boot.json> <模拟秒数> [fps]
 *
 * probe 打印 DISPLAY_COUNT=<n>，用来判断本机能不能开真窗口。
 */
public final class HeadlessRun {

    public static void main(String[] args) throws Exception {
        String cmd = args.length > 0 ? args[0] : "probe";
        if ("probe".equals(cmd)) {
            probe();
            return;
        }
        if (!"run".equals(cmd)) {
            System.err.println("用法: HeadlessRun probe | HeadlessRun run <boot.json> <秒> [fps]");
            System.exit(2);
            return;
        }
        if (args.length < 2) {
            System.err.println("缺 boot.json 路径");
            System.exit(2);
            return;
        }
        run(args);
    }

    private static void probe() {
        int count = 0;
        try {
            count = GraphicsEnvironment.getLocalGraphicsEnvironment().getScreenDevices().length;
        } catch (Throwable t) {
            System.out.println("PROBE_ERROR=" + t);
        }
        System.out.println("HEADLESS:true");
        System.out.println("DISPLAY_COUNT=" + count);
    }

    private static void run(String[] args) throws Exception {
        File boot = new File(args[1]).getAbsoluteFile();
        float seconds = args.length > 2 ? Float.parseFloat(args[2]) : 8f;
        int fps = args.length > 3 ? Integer.parseInt(args[3]) : 60;
        if (fps <= 0) {
            fps = 60;
        }
        int frames = Math.max(1, Math.round(seconds * fps));
        float dt = 1f / fps;

        System.out.println("HEADLESS_START boot=" + boot.getAbsolutePath()
                + " frames=" + frames + " fps=" + fps + " dt=" + dt);
        long t0 = System.nanoTime();

        // 构造真实运行时：读 boot.json/scene_0.json、建 Actor、建 ScriptEngine 并 sceneStart。
        TopDownRuntime rt = new TopDownRuntime(boot);
        if (rt.scripts == null) {
            System.out.println("HEADLESS_FAIL 脚本引擎没建起来（看 Build/bwe.log）");
            System.exit(3);
            return;
        }

        Method update = null;
        try {
            update = TopDownRuntime.class.getDeclaredMethod("update", float.class);
            update.setAccessible(true);
        } catch (Throwable t) {
            update = null;
        }
        System.out.println("HEADLESS_UPDATE_MODE=" + (update != null ? "TopDownRuntime.update" : "ScriptEngine.update"));

        int errors = 0;
        for (int i = 0; i < frames; i++) {
            float t = i * dt;
            applyInput(rt, t);
            try {
                if (update != null) {
                    update.invoke(rt, Float.valueOf(dt));
                } else {
                    rt.scripts.update(dt);
                }
                // 真实运行时在 display() 末尾调 scripts.draw(gl)；这里没有 GL，走 null 分支（安全跳过）。
                if (i % 6 == 0) {
                    rt.scripts.draw(null);
                }
            } catch (Throwable e) {
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                errors++;
                if (errors <= 5) {
                    System.out.println("HEADLESS_FRAME_ERROR frame=" + i + " " + cause);
                }
            }
            if (i % fps == 0) {
                status(rt, t);
            }
        }

        long ms = (System.nanoTime() - t0) / 1_000_000L;
        System.out.println("HEADLESS_DONE frames=" + frames + " simulatedSeconds=" + seconds
                + " wallMs=" + ms + " frameErrors=" + errors);

        // 反射调用里 update 是 private，异常会被包一层；frameErrors>0 让 node 侧报 FAIL。
        System.exit(errors == 0 ? 0 : 4);
    }

    /**
     * 每秒打一行世界状态（stdout，不写 bwe.log）：出问题时能直接在报告里看到
     * 「玩家走到哪了 / 血多少 / 场上还有几个实体」，不用靠猜。
     */
    private static void status(TopDownRuntime rt, float t) {
        TopDownRuntime.Actor p = null;
        int total = 0;
        int enemies = 0;
        int coins = 0;
        int npcs = 0;
        for (TopDownRuntime.Actor a : rt.actors) {
            if (a.dead) {
                continue;
            }
            total++;
            if (a.o.tags.contains("敌人")) {
                enemies++;
            }
            if (a.o.tags.contains("金币")) {
                coins++;
            }
            if (a.o.tags.contains("NPC")) {
                npcs++;
            }
            if (p == null && a.o.tags.contains("玩家")) {
                p = a;
            }
        }
        String pos = p == null ? "(none)" : "(" + Math.round(p.x) + "," + Math.round(p.y) + ")";
        String hp = p == null ? "?" : Math.round(p.hp) + "/" + Math.round(p.hpMax);
        String block = "";
        if (p != null && rt.scripts != null && rt.scripts.world != null) {
            int cx = rt.scripts.world.toCellX(p.x);
            int cy = rt.scripts.world.toCellY(p.y);
            block = " cell=(" + cx + "," + cy + ") tile=" + rt.scripts.world.get(cx, cy)
                    + " blockedHere=" + rt.scripts.world.blocked(p.x - 10f, p.y - 10f, 20f, 20f)
                    + " blockedRight=" + rt.scripts.world.blocked(p.x + 10f, p.y - 10f, 20f, 20f)
                    + " blockedDown=" + rt.scripts.world.blocked(p.x - 10f, p.y + 10f, 20f, 20f);
        }
        System.out.println("HEADLESS_T" + Math.round(t) + " player=" + pos + " hp=" + hp + block
                + " entities=" + total + " enemies=" + enemies + " coins=" + coins + " npcs=" + npcs);
    }

    /**
     * 输入脚本（按模拟时间切分，够跑出「移动/拾金币/挥剑/对话/被咬/击杀/回血」这些交互日志）：
     *   0.05–0.45s  W：吃掉出生点上方的金币，并记一次「开始移动」
     *   0.60–3.85s  S：向南走到阿岚所在街区
     *   3.90–4.75s  D：横向对齐阿岚（终点离 NPC 十几像素，进 48px 交互半径）
     *   5.00–5.15s  E：与阿岚对话（npc.js 的 onTrigger）
     *   5.20–7.40s  站桩：等追击怪追上来，靠每 0.6 秒一次的挥剑把它砍死 → 掉金币 + 记击杀
     *   7.45–9.85s  D：继续向东绕开横向矮墙
     *   9.90–12.55s W：北上走进治疗泉（zone.js 回血）
     * 直接写 rt.keys[]，和 AWT KeyListener 写的是同一个数组。
     */
    private static void applyInput(TopDownRuntime rt, float t) {
        rt.keys[KeyEvent.VK_W] = (t >= 0.05f && t <= 0.45f) || (t >= 9.90f && t <= 12.55f);
        rt.keys[KeyEvent.VK_S] = t >= 0.60f && t <= 3.85f;
        rt.keys[KeyEvent.VK_D] = (t >= 3.90f && t <= 4.75f) || (t >= 7.45f && t <= 9.85f);
        rt.keys[KeyEvent.VK_A] = false;
        // 按下 1~3 帧 = 一次键盘边沿；引擎用 held/prevHeld 算 pressed。
        rt.keys[KeyEvent.VK_SPACE] = (t % 0.6f) < 0.05f;
        rt.keys[KeyEvent.VK_E] = t >= 5.00f && t <= 5.15f;
    }

    private HeadlessRun() {
    }
}
`;

const KEYS_PS1_SRC = String.raw`# 由 verify-scripting.mjs 生成：把游戏窗口提到前台，再用 Win32 keybd_event 按住 WASD/空格/E。
# 参数：-TargetPid <java 进程 pid> -Seconds <总时长>
param([int]$TargetPid, [int]$Seconds = 5)
$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BweKeys {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  public static IntPtr FindByPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == target) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Down(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void Up(byte vk) { keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
"@ -Language CSharp

$hwnd = [BweKeys]::FindByPid([uint32]$TargetPid)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "FOCUS_NO_WINDOW"; exit 3 }
[void][BweKeys]::ShowWindow($hwnd, 9)
$shell = New-Object -ComObject WScript.Shell
try { [void]$shell.AppActivate($TargetPid) } catch { }
Start-Sleep -Milliseconds 250
[void][BweKeys]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 250
$fg = [BweKeys]::GetForegroundWindow()
if ($fg -eq $hwnd) { Write-Output "FOCUS_OK" } else { Write-Output ("FOCUS_WARN hwnd=" + $hwnd + " fg=" + $fg) }

# 按住的时长按总秒数切分：W 走一段、D 走一段、各按一次空格和 E
$hold = [Math]::Max(250, [int](($Seconds * 1000) / 6))
[byte[]]$moveKeys = @(0x57, 0x44, 0x41, 0x53)   # W D A S
foreach ($vk in $moveKeys) {
  [BweKeys]::Down($vk)
  Start-Sleep -Milliseconds $hold
  [BweKeys]::Up($vk)
  Start-Sleep -Milliseconds 80
  [BweKeys]::Down(0x20)     # Space 挥剑
  Start-Sleep -Milliseconds 70
  [BweKeys]::Up(0x20)
  Start-Sleep -Milliseconds 60
  [BweKeys]::Down(0x45)     # E 交互
  Start-Sleep -Milliseconds 70
  [BweKeys]::Up(0x45)
  Start-Sleep -Milliseconds 60
}
Write-Output "KEYS_SENT"
`;

function writeKeysScript() {
  ensureDir(TMP_DIR);
  fs.writeFileSync(KEYS_PS1, KEYS_PS1_SRC, "utf8");
  return KEYS_PS1;
}

/**
 * 截图取证：按窗口标题「BWE」找窗口 → GetWindowRect → CopyFromScreen 存 PNG。
 * 这是「画面真的画出来了」的唯一硬证据（日志只能证明脚本在跑）。
 * 全 ASCII：Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解释，中文会变乱码。
 */
const SHOT_PS1_SRC = String.raw`param([string]$Out = "shot.png")
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BweShot {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindByTitle(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().Contains(needle)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@ -Language CSharp

$hwnd = [BweShot]::FindByTitle("BWE")
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW"; exit 3 }
$r = New-Object BweShot+RECT
[void][BweShot]::GetWindowRect($hwnd, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Output "BAD_RECT"; exit 4 }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("SHOT_SAVED " + $Out + " " + $w + "x" + $h)
`;

function writeShotScript() {
  ensureDir(TMP_DIR);
  fs.writeFileSync(SHOT_PS1, SHOT_PS1_SRC, "utf8");
  return SHOT_PS1;
}

/** 把 headless 驱动器源码落盘并编译进同一个 classes 目录（同包，才能调 package-private 入口）。 */
function buildHeadlessDriver() {
  const dir = path.join(TMP_DIR, "driver");
  ensureDir(dir);
  const javaFile = path.join(dir, "HeadlessRun.java");
  fs.writeFileSync(javaFile, HEADLESS_JAVA_SRC, "utf8");
  // 必须 --release 8：PATH 上的 javac 是 JDK 26，但开 GL 窗口用的是 JDK 25，
  // 不指定 release 会编出 class file version 70 的字节码，JDK 25 直接 UnsupportedClassVersionError。
  const args = ["-encoding", "UTF-8", "-cp", javaClasspath(), "-d", CLASSES_DIR];
  let r = run("javac", ["--release", "8", ...args, javaFile]);
  if (r.status !== 0) {
    r = run("javac", args.concat(javaFile));
  }
  if (r.status !== 0) {
    return { ok: false, error: (r.stdout + r.stderr).trim().split(/\r?\n/).slice(0, 6).join(" / ") };
  }
  return { ok: true, file: javaFile };
}

function probeDisplays() {
  const r = run(JAVA_GAME, [...JAVA_MODULE_FLAGS, "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-cp", javaClasspath(), "Studio.runtime.HeadlessRun", "probe"]);
  const m = /DISPLAY_COUNT=(-?\d+)/.exec(r.stdout);
  return { ok: Boolean(m), count: m ? Number(m[1]) : -1, out: (r.stdout + r.stderr).trim() };
}

function readLogLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 窗口模式：真开 TopDownRuntime 的 GL 窗口 + keybd_event 注入按键，N 秒后 taskkill。 */
async function runWindowed(step, bootFile, opts) {
  // 每次运行前清空 bwe.log：BweLauncher.log 是「open-append-close」逐行追加，
  // 两个 JVM 同时写同一个文件会在 Windows 上互相覆盖（实测能把日志头部冲掉），
  // 所以窗口跑与 headless 跑必须各自从干净的日志开始。
  rmrf(LOG_PATH);
  const child = spawn(
    JAVA_GAME,
    [
      ...JAVA_MODULE_FLAGS,
      "-cp", javaClasspath(),
      "-Djava.library.path=" + LIB_DIR,
      "-Dfile.encoding=UTF-8",
      "-Dstdout.encoding=UTF-8",
      "-Dstderr.encoding=UTF-8",
      "Studio.runtime.TopDownRuntime",
      bootFile
    ],
    { cwd: REPO_ROOT, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] }
  );
  const pid = child.pid;
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => (out += d.toString()));
  child.stderr?.on("data", (d) => (err += d.toString()));

  let exited = false;
  child.on("exit", () => (exited = true));

  /** 收尸：taskkill /T /F 保证 JOGL 窗口和 native 资源都清干净（异常路径也必须走到）。 */
  const killChild = () => {
    try {
      const kill = run("taskkill", ["/PID", String(pid), "/T", "/F"]);
      return { ...kill, ok: /SUCCESS|成功|已终止|not found|没有运行/i.test(kill.stdout + kill.stderr) };
    } catch (e) {
      return { ok: false, stdout: "", stderr: String(e.message), status: -1 };
    }
  };

  add(step, "java 进程起来了", Boolean(pid), `pid=${pid}`);
  let opened = false;
  let glFrames = false;

  try {
    // 等窗口打开（BweLauncher/TopDownRuntime 会先写「窗口已打开」）
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      if (exited) break;
      const lines = readLogLines(LOG_PATH);
      if (lines.some((l) => l.includes("窗口已打开"))) {
        opened = true;
        break;
      }
      await sleep(150);
    }
    const startupMs = Date.now() - t0;
    add(step, "游戏窗口在 20 秒内打开", opened,
      opened ? `${startupMs}ms` : `没等到「窗口已打开」；stdout 尾：${out.trim().split(/\r?\n/).slice(-3).join(" | ")}`);

    if (opened) {
      // 注入按键（失败不影响硬断言，只让「移动/攻击」这类日志变成 WARN）
      const ps1 = writeKeysScript();
      const k = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-TargetPid", String(pid), "-Seconds", String(opts.seconds)], {
        timeout: 60_000
      });
      const focusOk = /FOCUS_OK/.test(k.stdout);
      add(step, "模拟按键（Win32 keybd_event：WASD/空格/E）", /KEYS_SENT/.test(k.stdout),
        firstLine(k.stdout) + (focusOk ? "" : " / 窗口未拿到前台焦点（WARN 级别）"), "WARN");

      // 截图取证（--no-shot 可关）：日志只能证明脚本在跑，画面是否真的画出来要看这张图
      if (!opts.noShot) {
        const shotPath = path.join(TMP_DIR, "screenshot.png");
        const shot = writeShotScript();
        const s = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", shot, "-Out", shotPath], { timeout: 60_000 });
        const saved = /SHOT_SAVED/.test(s.stdout) && fs.existsSync(shotPath);
        const size = saved ? fs.statSync(shotPath).size : 0;
        add(step, "截图取证（真窗口画面）", saved && size > 5_000,
          saved ? `${rel(shotPath)}（${(size / 1024).toFixed(0)}KB，${firstLine(s.stdout)}）` : `没截到：${firstLine(s.stdout) || firstLine(s.stderr)}`, "WARN");
        if (saved) opts.screenshotPath = shotPath;
      }
    }

    // 总运行时长至少 opts.seconds 秒（从启动算）
    const elapsed = Date.now() - t0;
    const remain = Math.max(0, opts.seconds * 1000 - elapsed);
    if (remain > 0) await sleep(remain);
    glFrames = readLogLines(LOG_PATH).some((l) => l.includes("视口映射:"));
  } finally {
    // 先记下「杀之前它是不是还活着」：taskkill 之后 exit 事件一定会来，
    // 直接看 exited 会把「我们自己杀掉的」误判成「进程自己崩了」。
    const wasAliveBeforeKill = !exited;
    const kill = killChild();
    // 等进程真的退出，再让下一步去写同一个 bwe.log（否则两进程会互相覆盖日志）
    for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    add(step, `运行约 ${opts.seconds} 秒后关闭进程`, kill.ok || exited,
      `taskkill=${firstLine(kill.stdout) || firstLine(kill.stderr) || "exit " + kill.status}${exited ? "" : "；进程 5 秒内没退出"}`);
    if (!wasAliveBeforeKill) {
      const tailText = (out + "\n" + err).trim().split(/\r?\n/).slice(-8).join(" | ");
      add(step, "真窗口进程没有提前退出", false, `进程在 taskkill 之前就退出了；输出尾部：${tailText}`, "WARN");
    } else {
      add(step, "真窗口进程没有提前退出", true, "taskkill 之前进程仍在运行");
    }
  }

  fs.writeFileSync(path.join(TMP_DIR, "run-stdout.txt"), out + "\n--- stderr ---\n" + err, "utf8");
  return { glFrames };
}

/** headless 模式：同一份 Build 构造真 TopDownRuntime，手动推进 N 帧（不需要显示设备）。 */
function runHeadless(step, bootFile, simSeconds) {
  rmrf(LOG_PATH); // 单独一份干净日志，避免和窗口模式的写入混在一起
  const r = run(
    JAVA_GAME,
    [
      ...JAVA_MODULE_FLAGS,
      "-Dstdout.encoding=UTF-8",
      "-Dstderr.encoding=UTF-8",
      "-cp", javaClasspath(),
      "-Djava.library.path=" + LIB_DIR,
      "Studio.runtime.HeadlessRun",
      "run",
      bootFile,
      String(simSeconds),
      "60"
    ],
    { timeout: 600_000 }
  );
  fs.writeFileSync(path.join(TMP_DIR, "headless-stdout.txt"), r.stdout + "\n--- stderr ---\n" + r.stderr, "utf8");
  const done = /HEADLESS_DONE/.exec(r.stdout);
  // Rhino/反射里的异常不一定让进程非 0 退出，所以额外看 frameErrors=0
  const frameErr = /frameErrors=(\d+)/.exec(r.stdout);
  const ok = r.status === 0 && Boolean(done) && (!frameErr || Number(frameErr[1]) === 0);
  add(step, `headless 驱动真实运行时：模拟 ${simSeconds} 秒 / ${simSeconds * 60} 帧`, ok,
    ok
      ? (done[0] || "") + " " + (r.stdout.match(/HEADLESS_UPDATE_MODE=\S+/) || [""])[0]
      : `exit ${r.status}；stdout 尾：${r.stdout.trim().split(/\r?\n/).slice(-4).join(" | ")}`);
  return { ok };
}

async function stepRun(opts) {
  const step = "run";
  const bootFile = path.join(BUILD_DIR, "boot.json");
  if (opts.skipRun) {
    skip(step, "真实运行 + 日志断言", "--skip-run 指定跳过");
    return;
  }
  if (!fs.existsSync(bootFile)) {
    skip(step, "真实运行 + 日志断言", "没有 Build/boot.json（第 3 段没跑通）");
    return;
  }
  if (!fs.existsSync(CLASSES_DIR)) {
    skip(step, "真实运行 + 日志断言", "没有编译产物（第 2 段没跑通）");
    return;
  }
  if (!ensureFreshClasses(step)) {
    skip(step, "真实运行 + 日志断言", "编译产物不可用");
    return;
  }

  // 清掉旧日志，避免上一次运行的残留把断言骗过去
  rmrf(LOG_PATH);

  const driver = buildHeadlessDriver();
  add(step, "无窗口驱动器（HeadlessRun）编译通过", driver.ok, driver.ok ? rel(driver.file) : driver.error);

  // 先看本机有没有显示设备：没有就开不了 GL 窗口（display() 一帧都不跑 → 脚本不会 tick）
  let displayCount = -1;
  if (driver.ok) {
    const probe = probeDisplays();
    displayCount = probe.count;
    add(step, "本机有显示设备（GraphicsEnvironment.getScreenDevices()）", probe.ok && displayCount > 0,
      probe.ok ? `DISPLAY_COUNT=${displayCount}` : probe.out, "WARN");
  }

  // 两段跑法各有各的用途，能跑就两段都跑：
  //   ① 真窗口 N 秒：证明「真 GL + 真键盘输入 + 真脚本」这条链路通（只有窗口模式能证明）；
  //   ② headless 快进 14 秒：不占真实时间，把「走到 NPC 说话 / 站桩砍死追击怪 / 走进治疗泉」
  //      这些需要位移的交互跑出来（键盘注入 4 秒内走不完这么远）。
  // bwe.log 是逐行 append 的，所以两段之间必须清空，避免互相覆盖（Windows 上实测会冲掉日志头）。
  const wantWindowed = !opts.headless && displayCount > 0;
  const simSeconds = Math.max(opts.seconds, HEADLESS_SIM_SECONDS);
  let windowedLines = [];
  let headlessLines = [];
  const modes = [];

  if (wantWindowed) {
    const res = await runWindowed(step, bootFile, opts);
    windowedLines = readLogLines(LOG_PATH);
    fs.writeFileSync(path.join(TMP_DIR, "run-windowed.log"), windowedLines.join("\n"), "utf8");
    if (res.glFrames) {
      modes.push(`真窗口 ${opts.seconds}s`);
    } else if (!opts.windowed) {
      // 窗口开了但 GL 一帧没跑：典型是「窗口能建、GL context 建不起来」的会话/JDK。
      add(step, "窗口真的跑了 GL 帧（bwe.log 有「视口映射:」）", false,
        "窗口建出来了但 reshape/display 没跑，脚本不可能 tick；深度交互改由 headless 覆盖", "WARN");
    }
  } else if (opts.headless) {
    add(step, "运行模式：headless（--headless 指定）", true, "跳过真窗口，只做 headless 快进");
  } else {
    add(step, "运行模式：headless", true,
      `DISPLAY_COUNT=${displayCount} → 真窗口拿不到 GL context，只能 headless（环境限制，不是脚本问题）`);
  }

  if (driver.ok) {
    runHeadless(step, bootFile, simSeconds);
    headlessLines = readLogLines(LOG_PATH);
    fs.writeFileSync(path.join(TMP_DIR, "run-headless.log"), headlessLines.join("\n"), "utf8");
    modes.push(`headless 快进 ${simSeconds}s`);
  }

  // ---- 日志断言（窗口 + headless 合并；窗口独有的打点单独看窗口那份） ----
  const lines = [...windowedLines, ...headlessLines];
  add(step, "Build/bwe.log 有内容", lines.length > 0,
    `窗口 ${windowedLines.length} 行 + headless ${headlessLines.length} 行（${rel(LOG_PATH)}；模式 ${modes.join(" + ") || "无"}）`);

  for (const need of WINDOWED_ONLY_LOGS) {
    if (!windowedLines.length) {
      skip(step, `窗口模式打点：${need.key}`, `本次没跑真窗口（${need.why}）`);
      continue;
    }
    const hit = windowedLines.some((l) => l.includes(need.key));
    add(step, `窗口模式打点：${need.key}`, hit, hit ? need.why : `期望日志里有「${need.key}」（${need.why}）`);
  }

  const errors = lines.filter((l) => l.includes("[脚本错误]"));
  add(step, "日志里没有 [脚本错误]", errors.length === 0,
    errors.length === 0 ? "0 条" : errors.slice(0, 3).join(" ⏎ "));

  const engineErr = lines.filter((l) => /\[脚本\] (引擎初始化失败|update 异常|draw 异常)/.test(l));
  add(step, "脚本引擎没有初始化/update/draw 异常", engineErr.length === 0,
    engineErr.length === 0 ? "0 条" : engineErr.slice(0, 3).join(" ⏎ "));

  for (const need of REQUIRED_LOGS) {
    const hit = lines.some((l) => l.includes(need.key));
    add(step, `打点出现：${need.key}`, hit, hit ? need.why : `期望日志里有「${need.key}」（${need.why}）`);
  }

  for (const opt of OPTIONAL_LOGS) {
    const hit = lines.some((l) => l.includes(opt.key));
    add(step, `交互打点：${opt.key}`, hit, hit ? opt.why : `没出现（${opt.why}）；无输入环境下属正常`, "WARN");
  }

  // 每脚本至少一行日志（证明 6 个脚本都被执行到）
  for (const name of ["player", "chaser", "npc", "hud", "zone", "system"]) {
    const hit = lines.some((l) => l.includes(`[脚本] ${name} `));
    add(step, `脚本 ${name} 被执行过`, hit, hit ? "有日志" : `没有 [脚本] ${name} … 行`);
  }
}

// ---------------- 报告 ----------------

function stepTitle(id) {
  return (
    {
      project: "1. 示例工程 + 脚本 transpile",
      java: "2. 编译运行时 + ScriptSelfTest",
      export: "3. 导出 Build（boot.json / scripts ES5）",
      layout: "4. LayoutDump 场景几何",
      run: "5. 真实运行 + 日志断言"
    }[id] ?? id
  );
}

const STEP_ORDER = ["project", "java", "export", "layout", "run"];

function mdEscape(s) {
  return String(s ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderReport(ctx) {
  const { opts, env, startedAt, finishedAt, exitCode } = ctx;
  const groups = STEP_ORDER.map(group);
  const totals = {
    pass: rows.filter((r) => r.status === "PASS").length,
    fail: rows.filter((r) => r.status === "FAIL").length,
    warn: rows.filter((r) => r.status === "WARN").length,
    skip: rows.filter((r) => r.status === "SKIP").length
  };
  const lines = [];
  lines.push("# JS 脚本系统端到端校验报告");
  lines.push("");
  lines.push(`- 生成时间：${startedAt.toISOString()} → ${finishedAt.toISOString()}（耗时 ${((finishedAt - startedAt) / 1000).toFixed(1)}s）`);
  lines.push(`- 命令：\`node web/tools/verify-scripting.mjs${opts.skipRun ? " --skip-run" : ""}${opts.only ? " --only " + opts.only : ""}\``);
  lines.push(`- 工程：\`${rel(opts.projectPath)}\``);
  lines.push(`- 结论：**${exitCode === 0 ? "全部通过" : exitCode === 1 ? "有失败项" : "前置依赖未就绪，链路没跑起来"}**（PASS ${totals.pass} / FAIL ${totals.fail} / WARN ${totals.warn} / SKIP ${totals.skip}）`);
  lines.push("");
  lines.push("## 环境");
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("|---|---|");
  lines.push(`| node | \`${env.node}\` |`);
  lines.push(`| java（PATH，仅用于版本记录） | \`${env.java}\` |`);
  lines.push(`| javac（编译运行时，--release 8） | \`${env.javac}\` |`);
  lines.push(`| **开窗口的 java** | \`${env.glJava}\` |`);
  lines.push(`| typescript | \`${env.typescript}\` |`);
  lines.push(`| 平台 | \`${env.platform}\` |`);
  lines.push(`| git | \`${env.git}\` |`);
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push("| 段 | 检查项 | PASS | FAIL | WARN | SKIP | 结果 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const g of groups) {
    lines.push(`| ${stepTitle(g.step)} | ${g.total} | ${g.pass} | ${g.fail} | ${g.warn} | ${g.skip} | **${g.status}** |`);
  }
  lines.push("");

  for (const g of groups) {
    const list = rows.filter((r) => r.step === g.step);
    if (!list.length) continue;
    lines.push(`## ${stepTitle(g.step)}`);
    lines.push("");
    lines.push("| # | 检查 | 结果 | 说明 |");
    lines.push("|---|---|---|---|");
    list.forEach((r, i) => {
      const icon = r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "**FAIL**" : r.status;
      lines.push(`| ${i + 1} | ${mdEscape(r.title)} | ${icon} | ${mdEscape(r.detail)} |`);
    });
    lines.push("");
  }

  // 失败项 + 最小复现
  const fails = rows.filter((r) => r.status === "FAIL");
  lines.push("## 失败项与最小复现");
  lines.push("");
  if (!fails.length) {
    lines.push("无失败项。");
  } else {
    lines.push("| 段 | 失败项 | 现场 | 最小复现 |");
    lines.push("|---|---|---|---|");
    for (const f of fails) {
      let repro = "";
      if (f.step === "project") repro = "`node .tmp_rel8/gen-js-demo.mjs` 后重新检查 .bwproj；脚本语法问题看 `node -e \"require('typescript')\"` 的 diagnostics";
      else if (f.step === "java") repro = "`javac --release 8 -encoding UTF-8 -cp \"lib/*\" -d .tmp_rel8/verify-script/classes src/Studio/runtime/*.java`（排除 GameLauncher）→ `java -cp \".tmp_rel8/verify-script/classes;lib/*\" Studio.runtime.ScriptSelfTest`";
      else if (f.step === "export") repro = "`node web/tools/package-bwe.mjs web/examples/俯视角JS示例.bwproj --build-only .tmp_rel8/verify-script/build`";
      else if (f.step === "layout") repro = "`java -cp \".tmp_rel8/verify-script/classes;lib/*\" Studio.runtime.LayoutDump --boot .tmp_rel8/verify-script/build/Build/boot.json --view 1280x720 --fit contain --out .tmp_rel8/verify-script/layout-contain.json`";
      else if (f.step === "run") repro = "`java -cp \".tmp_rel8/verify-script/classes;lib/*\" -Djava.library.path=lib Studio.runtime.TopDownRuntime .tmp_rel8/verify-script/build/Build/boot.json`";
      lines.push(`| ${mdEscape(stepTitle(f.step))} | ${mdEscape(f.title)} | ${mdEscape(f.detail)} | ${repro} |`);
    }
  }
  lines.push("");

  lines.push("## 示例工程怎么玩（web/examples/俯视角JS示例.bwproj）");
  lines.push("");
  lines.push("- 地图 40x30 格 @32px（1280x960），四周石墙 + 两段矮墙 + 一段横墙围出可走区域。");
  lines.push("- **玩家**（蓝甲小骑士，`script.js→player`）：`WASD`/方向键移动，撞墙与地图边界钳制，相机 1:1 跟随；`空格`挥剑对 76px 内敌人造成 12 伤害；踩到金币自动拾取并计数。");
  lines.push("- **追击怪 ×2**（`script.js→chaser`）：`bwe.nav.find` 每 0.4 秒重算 A* 路径，`bwe.nav.follow` 推进，贴身每 1.1 秒咬玩家 6 点血；被打死后 `bwe.world.spawn` 掉 1 枚金币。");
  lines.push("- **阿岚（NPC）**（`script.js→npc`）：玩家靠近 78px 显示 `bwe.interact.prompt` 提示，按 `E` 用 `bwe.draw.text` 在屏幕底部弹对话框（3.2 秒后自动收起）。");
  lines.push("- **治疗泉（ZONE 触发区）**（`script.js→zone`）：走进 92px 内每秒回 4 点血，进出都有日志（`onEnter`/`onLeave` + 每帧距离兜底）。");
  lines.push("- **HUD**（不可见对象 `script.js→hud`）：左上角背板 + 血条（`bwe.draw.bar`）+ 金币 / 击杀计数 + 操作提示 + FPS。");
  lines.push("- **场景脚本 system**（`scene.onStartScript`）：用墙体对象建 tilemap、`bwe.save` 读档、`bwe.every(1)` 心跳、`bwe.spawner.create` 每 6 秒在右上角补怪（最多 4 只）、事件总线统计击杀。");
  lines.push("");
  lines.push("## 产物");
  lines.push("");
  lines.push(`- 示例工程：\`${rel(opts.projectPath)}\`（由 \`.tmp_rel8/gen-js-demo.mjs\` 生成，重复运行逐字节一致）`);
  lines.push(`- 编译产物：\`${rel(CLASSES_DIR)}\``);
  lines.push(`- 导出 Build：\`${rel(BUILD_DIR)}\`（运行时原始日志在同目录 \`bwe.log\`）`);
  lines.push(`- ES5 产物留档：\`${rel(path.join(TMP_DIR, "es5"))}\``);
  lines.push(`- 运行日志：窗口 \`${rel(path.join(TMP_DIR, "run-windowed.log"))}\` / headless \`${rel(path.join(TMP_DIR, "run-headless.log"))}\``);
  lines.push(`- 截图取证：\`${rel(path.join(TMP_DIR, "screenshot.png"))}\``);
  lines.push(`- LayoutDump：\`${rel(path.join(TMP_DIR, "layout-contain.json"))}\``);
  lines.push("");
  lines.push("## 边界说明");
  lines.push("");
  lines.push("- **Java 版本**：PATH 上的 Oracle JDK 26 跑 JOGL 2.1.2 会 GL 初始化失败（窗口能建、`display()` 一帧不跑 → 脚本永远不 tick）。本脚本自动改用本机 Microsoft OpenJDK 25 开窗口（`--java <路径>` 可覆盖），但**编译仍用 PATH 上的 javac + `--release 8`**，所以 class 文件是 major 52，两个 JDK 都能加载。");
  lines.push("- **两段跑法**：① 真窗口 N 秒，证明「真 GL + 真键盘输入 + 真脚本」这条链路通；② headless 快进 14 秒（同一份 Build、真 TopDownRuntime），把需要位移才触发的交互（走到 NPC 说话、站桩砍死追击怪、走进治疗泉）跑出来。两段各自使用干净的 `bwe.log`（该日志是逐行 append，两个 JVM 同写会互相覆盖）。");
  lines.push("- 第 5 段会**弹出一个真实的 GL 窗口**，不是无头测试；无桌面环境请加 `--headless` 或 `--skip-run`。");
  lines.push("- 键盘注入依赖窗口拿到前台焦点（脚本会打印 `FOCUS_OK`/`FOCUS_WARN`）；拿不到焦点时「移动/挥剑/对话/拾取」这类日志降级为 WARN，不算失败。");
  lines.push("- LayoutDump 只验几何（世界/屏幕矩形、zoom、相机），不验贴图采样与混合；像素级验证需要读 framebuffer（见 mapping-contract §8.1 的 `BWE_FBPROBE`）。");
  lines.push("- 本脚本只读别人的写域（Java / web/src / package-bwe.mjs / serve.mjs）；发现缺陷只记录在报告里，不就地修改。");
  lines.push("");
  return lines.join("\n") + "\n";
}

function printTable() {
  const groups = STEP_ORDER.map(group);
  log("");
  log("=== PASS/FAIL ===");
  for (const g of groups) {
    const list = rows.filter((r) => r.step === g.step);
    if (!list.length) continue;
    log(`\n[${stepTitle(g.step)}]  ${g.status}  (${g.pass}/${g.total} PASS, ${g.fail} FAIL, ${g.warn} WARN, ${g.skip} SKIP)`);
    for (const r of list) {
      if (r.status === "PASS") {
        log(`  ✓ ${r.title}`);
      } else if (r.status === "WARN") {
        log(`  ! ${r.title} —— ${r.detail}`);
      } else if (r.status === "SKIP") {
        log(`  - ${r.title} —— ${r.detail}`);
      } else {
        log(`  ✗ ${r.title} —— ${r.detail}`);
      }
    }
  }
  const totals = {
    pass: rows.filter((r) => r.status === "PASS").length,
    fail: rows.filter((r) => r.status === "FAIL").length,
    warn: rows.filter((r) => r.status === "WARN").length,
    skip: rows.filter((r) => r.status === "SKIP").length
  };
  log("");
  log(`合计: PASS ${totals.pass} / FAIL ${totals.fail} / WARN ${totals.warn} / SKIP ${totals.skip}`);
}

// ---------------- main ----------------

async function main() {
  const startedAt = new Date();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    usage();
    process.exit(2);
  }
  if (opts.help) {
    usage();
    process.exit(0);
  }

  ensureDir(TMP_DIR);

  // 开 GL 窗口的 java：PATH 上的 JDK 26 跑不动 JOGL 2.1.2，优先用本机 JDK 25（见 findGlJava）。
  JAVA_GAME = findGlJava(opts.javaPath);
  JAVA_GAME_VERSION = firstLine(run(JAVA_GAME, ["-version"]).stderr) || JAVA_GAME;

  const env = {
    node: process.version,
    java: firstLine(run("java", ["-version"]).stderr),
    javac: firstLine(run("javac", ["-version"]).stdout),
    glJava: `${JAVA_GAME}（${JAVA_GAME_VERSION}）`,
    typescript: (() => {
      const ts = loadTypeScript();
      return ts ? ts.version : "(缺失)";
    })(),
    platform: `${process.platform} ${process.arch}`,
    git: run("git", ["rev-parse", "--short", "HEAD"]).stdout.trim() || "n/a"
  };

  log("JS 脚本系统端到端校验");
  log(`  仓库: ${REPO_ROOT}`);
  log(`  工程: ${rel(opts.projectPath)}`);
  log(`  node ${env.node} / javac: ${env.javac}`);
  log(`  开窗口的 java: ${env.glJava}`);
  log("");

  const wanted = (id) => !opts.only || id.includes(opts.only) || stepTitle(id).includes(opts.only);

  // 1) 工程 + transpile
  if (wanted("project")) {
    log("[1/5] 示例工程结构 + 脚本 transpile 到 ES5…");
    stepProject(opts);
    const g = group("project");
    log(`      ${g.status}（${g.pass}/${g.total}）`);
  }

  // 2) Java + ScriptSelfTest
  if (wanted("java")) {
    log("[2/5] 编译运行时 + ScriptSelfTest…");
    stepJava(opts);
    const g = group("java");
    log(`      ${g.status}（${g.pass}/${g.total}）`);
  }

  // 3) 导出 Build
  let project = null;
  let build = null;
  if (fs.existsSync(opts.projectPath)) project = readJson(opts.projectPath);
  if (wanted("export") && project) {
    log("[3/5] 导出 Build（writeQuickBuild，不 jpackage）…");
    build = await stepExport(project, opts);
    const g = group("export");
    log(`      ${g.status}（${g.pass}/${g.total}）`);
  }

  // 4) LayoutDump
  if (wanted("layout")) {
    log("[4/5] LayoutDump 场景几何…");
    stepLayout(build);
    const g = group("layout");
    log(`      ${g.status}（${g.pass}/${g.total}）`);
  }

  // 5) 真实运行
  if (wanted("run")) {
    log(`[5/5] 真实运行 ${opts.seconds} 秒 + 日志断言…`);
    try {
      await stepRun(opts);
    } catch (e) {
      add("run", "真实运行流程没抛异常", false, String(e?.stack || e).split("\n").slice(0, 4).join(" / "));
    }
    const g = group("run");
    log(`      ${g.status}（${g.pass}/${g.total}）`);
  }

  // ---- 汇总 / 报告 / 退出码 ----
  const totals = {
    pass: rows.filter((r) => r.status === "PASS").length,
    fail: rows.filter((r) => r.status === "FAIL").length,
    warn: rows.filter((r) => r.status === "WARN").length,
    skip: rows.filter((r) => r.status === "SKIP").length
  };
  let exitCode = 0;
  if (setupError) exitCode = 2;
  else if (totals.fail > 0) exitCode = 1;

  const finishedAt = new Date();
  ensureDir(path.dirname(opts.reportPath));
  fs.writeFileSync(opts.reportPath, renderReport({ opts, env, startedAt, finishedAt, exitCode }), "utf8");

  printTable();
  log("");
  if (setupError) {
    log(`前置依赖没就绪，链路没跑起来：${setupError}`);
    log("  补齐后重跑一条命令：node web/tools/verify-scripting.mjs");
  }
  log(`报告: ${rel(opts.reportPath)}`);
  log(`退出码: ${exitCode}（0=全 PASS / 1=有 FAIL / 2=前置依赖未就绪）`);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e?.stack || e);
  // 兜底也写一份报告，避免 CI 只有 stderr
  try {
    ensureDir(path.dirname(REPORT_PATH_DEFAULT));
    fs.writeFileSync(
      REPORT_PATH_DEFAULT,
      `# JS 脚本系统端到端校验报告\n\n校验脚本自身崩了：\n\n\`\`\`\n${e?.stack || e}\n\`\`\`\n`,
      "utf8"
    );
  } catch {
    /* ignore */
  }
  process.exit(2);
});
