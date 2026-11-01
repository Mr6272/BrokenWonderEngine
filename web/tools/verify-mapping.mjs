/**
 * 编辑器 ↔ 引擎 几何映射自动校验。
 *
 * 背景：打包链路把 .bwproj 导成 Build/boot.json + scene_0.json，再交给
 * Studio.runtime.TopDownRuntime 绘制。曾经多次出现「编辑器里好好的、打包出来
 * 整体偏移 / 只看到一角 / 不居中 / 大小不对」——根因都是这条几何链路的某一环
 * 和编辑器的绘制真值（web/src/app/painter.ts 的 sizeOf/boundsOf）不一致。
 *
 * 本脚本把整条链路自动对拍一遍：
 *
 *   1. 用 esbuild 把 painter.ts 的 sizeOf/boundsOf 打成临时 ESM，对 .bwproj 的
 *      每个对象算出编辑器的期望世界矩形（真代码，不复制公式）；
 *   2. 用 javac 编译 src/Studio/runtime/*.java（排除依赖 Swing 编辑器包的
 *      GameLauncher.java），用 LayoutDump 在不建窗口的情况下导出引擎侧布局 JSON；
 *   3. 逐对象比对 world{x,y,w,h,left,top}（容差 0.01）；
 *   4. 校验视口不变量（按 fit 策略分流；运行时默认 contain，按 F 切 cover，脚本默认两种各跑一遍）：
 *      contain → zoom = clamp(min(vw/mapW, vh/mapH), 0.15, 4)，地图不裁切、地图内对象都在视口内；
 *      cover   → zoom = clamp(max(vw/mapW, vh/mapH), 0.15, 4)，地图铺满视口（允许裁边，对象可能出视口）；
 *      两种模式都校验 screen = (world-cam)*zoom + view/2 与整图居中；
 *      另有一条「不传 --fit 时 LayoutDump 默认必须是 contain」的回归断言（防止显式传参掩盖默认值回归）；
 *   5. 校验旋转：rotation 角度原样一致，且「右边缘中点」旋转后的屏幕坐标符合
 *      screen=(x+cosθ·w/2, y+sinθ·w/2) 再走视图变换（θ=90° 应在中心正下方）——
 *      专防 glRotatef 的正负号写反；
 *   6. 校验图层：对象 layer 下标、绘制顺序（layer → z → y，与编辑器 orderObjects 一致）、
 *      可见性（对象 visible ∧ 图层 visible）——防「地形盖住角色」「隐藏图层在游戏里又出现」；
 *   7. 旁证导出器：tileSize / 地图格数 / 素材像素（PNG 实际尺寸 vs 工程声明）
 *      是否一致——这几项一旦错，画面一定错位或缩放不对。
 *
 * 全部几何断言只用「逻辑视口 + LayoutDump 输出」，不读取 framebuffer 物理像素，
 * 因此与 Windows 显示缩放（150%/200%）无关；物理/逻辑尺寸混用的问题在运行时侧修。
 *
 * 用例来源：
 *   - web/examples/*.bwproj × web/.build 里最新的 Build（按 mtime 自动发现）；
 *   - `.tmp_rel8/e2e-XXX/out/<包名>/app/Build` 端到端包（新导出器+新运行时，自动发现，
 *     按 boot.json 的 project 名配对示例工程）——覆盖 layer/visibleSelf/layers[]/originX 新字段；
 *   - 内置合成用例：覆盖 props.w/h、素材像素、tileSize 兜底、单边 half、小数坐标/缩放、
 *     scale=0、rotation=90/30.5° 等示例没覆盖到的分支。
 *
 * 用法（在仓库根执行）：
 *   node web/tools/verify-mapping.mjs
 *   node web/tools/verify-mapping.mjs --view 1920x1080
 *   node web/tools/verify-mapping.mjs --only 换装 --verbose
 *   node web/tools/verify-mapping.mjs --build 换装示例=D:\path\to\Build
 *   node web/tools/verify-mapping.mjs --no-synth          # 跳过合成用例
 *   node web/tools/verify-mapping.mjs --no-e2e            # 跳过 .tmp_rel8/e2e-* 端到端包
 *   node web/tools/verify-mapping.mjs --keep              # 保留中间产物（默认也保留）
 *
 * 退出码：0 = 全部通过（允许 warning）；1 = 有硬失败；2 = 环境/参数错误。
 *
 * 写盘范围：.tmp_rel8/verify/** 与 .tmp_rel8/report-verify.md（不改任何源码）。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------- 常量 ----------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP_DIR = path.join(REPO_ROOT, ".tmp_rel8", "verify");
const CLASSES_DIR = path.join(TMP_DIR, "classes");
const REPORT_PATH_DEFAULT = path.join(REPO_ROOT, ".tmp_rel8", "report-verify.md");
const RUNTIME_SRC_DIR = path.join(REPO_ROOT, "src", "Studio", "runtime");
const PAINTER_TS = path.join(REPO_ROOT, "web", "src", "app", "painter.ts");

/** 世界矩形比对容差（任务书规定 0.01） */
const TOL_WORLD = 0.01;
/** 屏幕坐标比对容差：LayoutDump 把 world / screen 都四舍五入到 2 位小数，
 *  乘上 zoom(≤2) 后误差最大约 0.015，故放宽到 0.02。 */
const TOL_SCREEN = 0.02;
/** 视口标量（zoom）容差 */
const TOL_ZOOM = 0.01;
/**
 * LayoutDump 只把 zoom 打印到 4 位小数（r3），大视口下 1e-4 的相对误差会被
 * 「world 尺寸 × zoom」放大到约 0.1px。屏幕/留白断言因此要带上这个精度预算，
 * 否则会把「打印精度」误判成「映射错误」。
 */
const ZOOM_PRINT_UNCERTAINTY = 0.00005;

const DEFAULT_VIEW = { w: 1280, h: 720 };

const DEFAULT_CASES = [
  { name: "换装示例", project: path.join(REPO_ROOT, "web", "examples", "换装示例.bwproj") },
  { name: "扫雷示例", project: path.join(REPO_ROOT, "web", "examples", "扫雷示例.bwproj") }
];

// ---------------- 小工具 ----------------

function log(msg) {
  process.stdout.write(msg + "\n");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function rel(p) {
  return path.relative(REPO_ROOT, p).replaceAll("\\", "/");
}

function round(n, digits = 4) {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : Number(v);
}

/** 缺省字段当 0 用（.bwproj 里 halfW/scaleX 等可能缺省） */
function n0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dec(buf) {
  if (!buf) return "";
  return Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "buffer",
    windowsHide: true,
    timeout: opts.timeout ?? 180_000
  });
  return {
    status: r.status,
    error: r.error,
    stdout: dec(r.stdout),
    stderr: dec(r.stderr),
    cmdline: [cmd, ...args].join(" ")
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** PNG 头里读实际像素尺寸（IHDR 宽高）。 */
function pngSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/** 生成一张纯色 PNG（合成用例需要已知像素尺寸的素材，避免依赖现成 Build）。 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c ^= buf[n];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(w, h, rgb = [86, 132, 196]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0];
      raw[off + 2 + x * 3] = rgb[1];
      raw[off + 3 + x * 3] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------------- 参数 ----------------

function parseArgs(argv) {
  const out = {
    view: { ...DEFAULT_VIEW },
    fit: "both",
    only: null,
    synth: true,
    e2e: true,
    verbose: false,
    report: REPORT_PATH_DEFAULT,
    buildOverrides: new Map(),
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--no-synth") out.synth = false;
    else if (a === "--no-e2e") out.e2e = false;
    else if (a === "--only" && i + 1 < argv.length) out.only = argv[++i];
    else if (a === "--view" && i + 1 < argv.length) {
      const m = /^(\d+)x(\d+)$/i.exec(argv[++i]);
      if (!m) throw new Error("--view 需要形如 1280x720");
      out.view = { w: Number(m[1]), h: Number(m[2]) };
    } else if (a === "--fit" && i + 1 < argv.length) out.fit = argv[++i].toLowerCase();
    else if (a.startsWith("--fit=")) out.fit = a.slice("--fit=".length).toLowerCase();
    else if (a === "--report" && i + 1 < argv.length) out.report = path.resolve(REPO_ROOT, argv[++i]);
    else if (a === "--build" && i + 1 < argv.length) {
      const raw = argv[++i];
      const eq = raw.indexOf("=");
      if (eq <= 0) throw new Error("--build 需要形如 名称=Build目录");
      out.buildOverrides.set(raw.slice(0, eq), path.resolve(REPO_ROOT, raw.slice(eq + 1)));
    } else if (a === "--keep") {
      // 默认就保留中间产物；兼容旧习惯，忽略
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }
  if (!["both", "cover", "contain"].includes(out.fit)) throw new Error("--fit 只支持 both / cover / contain");
  return out;
}

function usage() {
  log(`编辑器 ↔ 引擎几何映射校验

用法: node web/tools/verify-mapping.mjs [选项]
  --view WxH           引擎逻辑视口尺寸，默认 1280x720
  --fit cover|contain|both
                       适配策略，默认 both（每个用例各跑 cover 和 contain；
                       运行时默认 contain，F 键切 cover）
  --only <关键字>      只跑名字含该关键字的用例
  --build 名称=目录    覆盖某个用例的 Build 目录（目录内需有 boot.json）
  --no-synth           跳过内置合成用例（只跑 web/examples 里的示例）
  --no-e2e             跳过自动发现的 .tmp_rel8/e2e-* 端到端包
  --report <路径>      报告输出路径，默认 .tmp_rel8/report-verify.md
  --verbose            打印每个用例的检查明细
  -h, --help           显示帮助

说明：几何断言只用「逻辑视口 + LayoutDump 输出」，不读取 framebuffer 物理像素，
因此不受 Windows 显示缩放（150%/200%）影响。`);
}

// ---------------- 编译引擎侧 ----------------

function compileRuntime() {
  const files = fs
    .readdirSync(RUNTIME_SRC_DIR)
    // ⚠ 必须排除 `*Test.java`（踩过的真实故障，与 serve.mjs 里同一条）：
    // 这些测试会 import Core.* / Framework.*，而本工具只编译 runtime 目录 →
    // 「程序包 Core 不存在」→ 整条几何校验跑不起来（报错看着像引擎坏了）。
    .filter((f) => f.endsWith(".java") && f !== "GameLauncher.java" && !f.endsWith("Test.java"))
    .sort();
  if (!files.length) throw new Error(`找不到运行时源码: ${RUNTIME_SRC_DIR}`);

  rmrf(CLASSES_DIR);
  ensureDir(CLASSES_DIR);

  const libCp = path.join(REPO_ROOT, "lib", "*");
  const baseArgs = [
    "-J-Duser.language=en",
    "-J-Duser.country=US",
    "-encoding",
    "UTF-8",
    "-cp",
    libCp,
    // 兜底：运行时源码万一引用了同仓其它包（Core / Framework），也能解析。
    "-sourcepath",
    path.join(REPO_ROOT, "src"),
    "-d",
    CLASSES_DIR,
    ...files.map((f) => path.join(RUNTIME_SRC_DIR, f))
  ];

  // 任务书要求 --release 8；若本机 JDK 已移除 8 的支持则自动降级（不改变语义）。
  let r = run("javac", ["--release", "8", ...baseArgs]);
  let usedRelease = "8";
  if (r.status !== 0) {
    r = run("javac", baseArgs);
    usedRelease = "default";
  }
  if (r.status !== 0) {
    throw new Error(`javac 编译失败 (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
  }
  return { files, usedRelease, stderr: r.stderr };
}

function javaClasspath() {
  return [CLASSES_DIR, path.join(REPO_ROOT, "lib", "*")].join(path.delimiter);
}

function runLayoutDump(bootFile, view, outFile, fitMode) {
  const r = run("java", [
    "-cp",
    javaClasspath(),
    "Studio.runtime.LayoutDump",
    "--boot",
    bootFile,
    "--view",
    `${view.w}x${view.h}`,
    // fitMode 省略 = 不传 --fit，用来验证「运行时默认 fit」
    ...(fitMode ? ["--fit", fitMode] : []),
    "--out",
    outFile
  ]);
  if (r.status !== 0) {
    throw new Error(`LayoutDump 失败 (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
  }
  const json = JSON.parse(fs.readFileSync(outFile, "utf8").replace(/^\uFEFF/, ""));
  return json;
}

// ---------------- 编辑器真值（esbuild 打真代码） ----------------

function bundlePainter() {
  const require = createRequire(path.join(REPO_ROOT, "package.json"));
  let esbuild;
  try {
    esbuild = require("esbuild");
  } catch (e) {
    throw new Error(`找不到 esbuild（应在仓库根 node_modules 里）：${e.message}`);
  }

  ensureDir(TMP_DIR);
  const entry = path.join(TMP_DIR, "painter-entry.mjs");
  const bundle = path.join(TMP_DIR, "painter-bundle.mjs");
  const painterSpec = PAINTER_TS.replaceAll("\\", "/");
  fs.writeFileSync(
    entry,
    `// 由 verify-mapping.mjs 自动生成：把编辑器的绘制真值原样导出给 Node 用。
export { sizeOf, boundsOf, assetPixelSize } from ${JSON.stringify(painterSpec)};
`,
    "utf8"
  );

  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    outfile: bundle,
    platform: "neutral",
    logLevel: "silent",
    absWorkingDir: REPO_ROOT
  });

  return { bundle, esbuildVersion: esbuild.version };
}

async function loadPainterTruth(bundlePath) {
  const mod = await import(pathToFileURL(bundlePath).href + `?t=${Date.now()}`);
  for (const fn of ["sizeOf", "boundsOf", "assetPixelSize"]) {
    if (typeof mod[fn] !== "function") throw new Error(`painter bundle 缺少导出 ${fn}`);
  }
  return mod;
}

// ---------------- Build 发现 ----------------

/** 在 web/.build/packages/<job>/out/<工程名>/app/Build 里找最新一份 boot.json。 */
function discoverBuild(projectName) {
  const packagesDir = path.join(REPO_ROOT, "web", ".build", "packages");
  if (!fs.existsSync(packagesDir)) return null;
  const candidates = [];
  for (const job of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!job.isDirectory()) continue;
    const outDir = path.join(packagesDir, job.name, "out");
    if (!fs.existsSync(outDir)) continue;
    for (const proj of fs.readdirSync(outDir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      if (projectName && proj.name !== projectName) continue;
      const buildDir = path.join(outDir, proj.name, "app", "Build");
      const boot = path.join(buildDir, "boot.json");
      if (fs.existsSync(boot)) {
        candidates.push({ buildDir, boot, mtime: fs.statSync(boot).mtimeMs });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].buildDir;
}

/** 扫描 `.tmp_rel8/e2e-*` 下的端到端打包产物（Lead 的 e2e 包），按 boot.json 里的
 *  project 名配对 web/examples 里的示例工程。
 *  兼容两种布局：`e2e-xxx/Build`（直接交付）与 `e2e-xxx/out/<包名>/app/Build`（打包管线），
 *  同一份工程取 boot.json 最新的一份；work/runtime/natives 等中间目录跳过。 */
function discoverE2ECases() {
  const tmpRoot = path.join(REPO_ROOT, ".tmp_rel8");
  if (!fs.existsSync(tmpRoot)) return [];
  const skipDirs = new Set(["work", "runtime", "natives", "node_modules", ".git", "assets"]);
  const builds = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || skipDirs.has(e.name)) continue;
      const sub = path.join(dir, e.name);
      if (e.name === "Build" && fs.existsSync(path.join(sub, "boot.json"))) {
        builds.push({ rootDir: dir, buildDir: sub });
        continue;
      }
      walk(sub, depth + 1);
    }
  };
  for (const d of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^e2e-/i.test(d.name)) continue;
    walk(path.join(tmpRoot, d.name), 0);
  }

  const found = new Map();
  for (const b of builds) {
    const bootFile = path.join(b.buildDir, "boot.json");
    let boot;
    try {
      boot = JSON.parse(fs.readFileSync(bootFile, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    const matched = DEFAULT_CASES.find((c) => projectNameOf(c.project) === boot.project);
    if (!matched) continue; // 没有对应的 .bwproj 真值，无法对拍
    const name = e2eLabelOf(b);
    const mtime = fs.statSync(bootFile).mtimeMs;
    const prev = found.get(name);
    if (!prev || mtime > prev.mtime) {
      found.set(name, { name, projectPath: matched.project, buildDir: b.buildDir, mtime });
    }
  }
  return [...found.values()].map(({ mtime, ...rest }) => rest);
}

/** e2e 包的展示名：out/<包名>/app/Build 用包名；e2e-dressup/Build 用 e2e-dressup → E2E-Dressup。 */
function e2eLabelOf({ rootDir, buildDir }) {
  const relPath = path.relative(path.join(REPO_ROOT, ".tmp_rel8"), buildDir).replaceAll("\\", "/");
  const m = /^(e2e-[^/]+)\/out\/([^/]+)\/app\/Build$/.exec(relPath);
  if (m) return m[2];
  const rootName = path.basename(rootDir);
  const part = rootName
    .replace(/^e2e-/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("-");
  return `E2E-${part || "Package"}`;
}

const projectNameCache = new Map();
/** 读 .bwproj 的 name（用于把 E2E 包配对到示例工程）。 */
function projectNameOf(projectFile) {
  if (!projectNameCache.has(projectFile)) {
    let name = "";
    try {
      name = JSON.parse(fs.readFileSync(projectFile, "utf8").replace(/^\uFEFF/, "")).name ?? "";
    } catch {
      name = "";
    }
    projectNameCache.set(projectFile, name);
  }
  return projectNameCache.get(projectFile);
}

// ---------------- 检查收集 ----------------

function makeCheckSink() {
  const checks = [];
  return {
    checks,
    add(group, id, title, ok, detail = {}) {
      checks.push({ group, id, title, ok: Boolean(ok), severity: detail.severity ?? "fail", ...detail });
      return Boolean(ok);
    },
    warn(group, id, title, ok, detail = {}) {
      return this.add(group, id, title, ok, { ...detail, severity: "warn" });
    },
    info(group, id, title, detail = {}) {
      return this.add(group, id, title, true, { ...detail, severity: "info" });
    }
  };
}

function close(a, b, tol) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
}

// ---------------- 单个用例 ----------------

function loadProjectFile(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function findEditorScene(project, sceneName) {
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  const byName = scenes.find((s) => s.name === sceneName);
  return byName ?? scenes[0] ?? null;
}

function matchEngineObjects(editorObjects, engineObjects) {
  const used = new Set();
  const pairs = [];
  const unmatchedEditor = [];

  // 第一轮：按对象 id 精确匹配（最新导出器会保留 id）。
  for (const eo of editorObjects) {
    const idx = engineObjects.findIndex((a, i) => !used.has(i) && a.id === eo.id);
    if (idx >= 0) {
      used.add(idx);
      pairs.push({ editor: eo, engine: engineObjects[idx], matchedBy: "id" });
    }
  }
  // 第二轮：按名字（旧 Build 会重新生成 id，只能靠名字对拍）。
  // 同名对象可能有很多（例如一格一个「地砖」），所以同名的候选里取坐标最近的一个，
  // 避免重名对象乱配导致误报。
  const pending = editorObjects.filter((eo) => !pairs.some((p) => p.editor === eo));
  const byName = new Map();
  engineObjects.forEach((a, i) => {
    if (used.has(i)) return;
    const key = a.name ?? "";
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(i);
  });
  for (const eo of pending) {
    const candidates = byName.get(eo.name ?? "") ?? [];
    if (!candidates.length) {
      unmatchedEditor.push(eo);
      continue;
    }
    let bestPos = 0;
    let bestDistance = Infinity;
    candidates.forEach((idx, pos) => {
      const a = engineObjects[idx];
      const d = Math.abs(n0(a.world?.x) - n0(eo.x)) + Math.abs(n0(a.world?.y) - n0(eo.y));
      if (d < bestDistance) {
        bestDistance = d;
        bestPos = pos;
      }
    });
    const idx = candidates.splice(bestPos, 1)[0];
    used.add(idx);
    pairs.push({ editor: eo, engine: engineObjects[idx], matchedBy: "name" });
  }
  const unmatchedEngine = engineObjects.filter((_, i) => !used.has(i));
  // 保持编辑器顺序，报告更好读
  pairs.sort((a, b) => editorObjects.indexOf(a.editor) - editorObjects.indexOf(b.editor));
  return { pairs, unmatchedEditor, unmatchedEngine };
}

/** 编辑器期望矩形 = painter 真代码 boundsOf()。 */
function editorBoundsOf(painter, project, obj) {
  const view = { tileSize: num(project.tileSize), assets: project.assets ?? [] };
  const b = painter.boundsOf(obj, view);
  return {
    x: num(obj.x),
    y: num(obj.y),
    w: num(b.w),
    h: num(b.h),
    left: num(b.x),
    top: num(b.y)
  };
}

function engineRect(layoutObj) {
  const w = layoutObj.world ?? {};
  return { x: num(w.x), y: num(w.y), w: num(w.w), h: num(w.h), left: num(w.left), top: num(w.top) };
}

function compareRect(editor, engine) {
  const keys = ["x", "y", "w", "h", "left", "top"];
  const diffs = {};
  let maxAbs = 0;
  for (const k of keys) {
    const d = num(engine[k]) - num(editor[k]);
    diffs[k] = round(d, 4);
    maxAbs = Math.max(maxAbs, Math.abs(d));
  }
  return { diffs, maxAbs: round(maxAbs, 4), ok: maxAbs <= TOL_WORLD };
}

/** 判断对象尺寸来自哪一级优先级（仅用于报告标注，尺寸本身仍由 painter 真代码给出）。 */
function sizeBranch(painter, project, obj) {
  if (num(obj.halfW) > 0 || num(obj.halfH) > 0) return "half";
  const propW = Number(obj.props?.w);
  const propH = Number(obj.props?.h);
  if (Number.isFinite(propW) && propW > 0 && Number.isFinite(propH) && propH > 0) return "props";
  const asset = (project.assets ?? []).find((a) => a.id === obj.assetId);
  if (painter.assetPixelSize(asset)) return "asset";
  return "tile";
}

function compareCase({ name, baseName, fitMode, projectPath, buildDir, view, painter }) {
  const sink = makeCheckSink();
  const result = {
    name,
    baseName,
    fitMode,
    projectPath,
    buildDir,
    view,
    checks: sink.checks,
    objectRows: [],
    failures: [],
    warnings: [],
    viewport: null,
    ok: false,
    error: null
  };

  try {
    ensureDir(TMP_DIR);
    const project = loadProjectFile(projectPath);
    const bootFile = path.join(buildDir, "boot.json");
    if (!fs.existsSync(bootFile)) throw new Error(`Build 里没有 boot.json: ${buildDir}`);
    const boot = JSON.parse(fs.readFileSync(bootFile, "utf8").replace(/^\uFEFF/, ""));
    result.buildMtime = fs.statSync(bootFile).mtime.toISOString();

    const sceneRef = (boot.scenes ?? [])[0];
    if (!sceneRef) throw new Error("boot.json 里没有 scenes");
    const sceneFile = path.join(buildDir, sceneRef.file ?? "scene_0.json");
    if (!fs.existsSync(sceneFile)) throw new Error(`找不到场景文件: ${sceneFile}`);
    const scene = JSON.parse(fs.readFileSync(sceneFile, "utf8").replace(/^\uFEFF/, ""));

    const editorScene = findEditorScene(project, sceneRef.name);
    if (!editorScene) throw new Error(".bwproj 里没有场景");

    // ---- 导出数据一致性（地图几何的源头）----
    const projTile = num(project.tileSize);
    const bootTile = num(boot.tileSize);
    sink.add("export", "boot.project", "boot.json 工程名与 .bwproj 一致", boot.project === project.name, {
      expected: project.name,
      actual: boot.project
    });
    // Build 是否比工程文件旧：旧 Build 的数字不代表最新工程，先提醒重打包。
    const projMtime = fs.statSync(projectPath).mtimeMs;
    sink.warn("export", "build.fresh", "Build 不早于 .bwproj（否则结果可能过时）", result.buildMtime ? fs.statSync(bootFile).mtimeMs >= projMtime - 1000 : true, {
      expected: ".bwproj 修改后重新打包",
      actual: `工程 ${new Date(projMtime).toISOString()} / Build ${result.buildMtime ?? "-"}`
    });
    sink.add("export", "tileSize", "boot.json tileSize 与 .bwproj 一致", close(bootTile, projTile, 1e-9), {
      expected: projTile,
      actual: bootTile
    });
    sink.add("export", "scene.tileSize", "scene_0.json tileSize 与 .bwproj 一致", close(num(scene.tileSize), projTile, 1e-9), {
      expected: projTile,
      actual: num(scene.tileSize)
    });
    sink.add("export", "scene.tiles", "场景格数与 .bwproj 一致", num(scene.width) === num(editorScene.widthTiles) && num(scene.height) === num(editorScene.heightTiles), {
      expected: `${num(editorScene.widthTiles)}x${num(editorScene.heightTiles)}`,
      actual: `${num(scene.width)}x${num(scene.height)}`
    });
    sink.add("export", "scene.objects", "scene_0.json 对象数与 .bwproj 场景一致", (scene.objects ?? []).length === (editorScene.objects ?? []).length, {
      expected: (editorScene.objects ?? []).length,
      actual: (scene.objects ?? []).length,
      severity: "warn"
    });

    // ---- 引擎侧布局 ----
    // 注意：--view 传的是「逻辑视口尺寸」（Windows 150% 缩放下全屏可能是 1707x1067），
    // LayoutDump 的几何完全不读 framebuffer 物理像素，所以下面的断言与 DPI 无关。
    const layoutPath = path.join(TMP_DIR, `layout-${safeSlug(name)}.json`);
    const layout = runLayoutDump(bootFile, view, layoutPath, fitMode);
    const mapW = num(editorScene.widthTiles) * projTile;
    const mapH = num(editorScene.heightTiles) * projTile;
    const vw = num(layout.viewport?.width);
    const vh = num(layout.viewport?.height);
    const zoom = num(layout.zoom);
    const camX = num(layout.camera?.x);
    const camY = num(layout.camera?.y);
    const cameraFollow = Boolean(layout.cameraFollow);

    sink.add("viewport", "viewport.size", "LayoutDump 视口尺寸与请求的逻辑视口一致", vw === view.w && vh === view.h, {
      expected: `${view.w}x${view.h}`,
      actual: `${vw}x${vh}`
    });
    sink.add("viewport", "fitMode", `LayoutDump 回显 fitMode=${fitMode}`, (layout.fitMode ?? "(missing)") === fitMode, {
      expected: fitMode,
      actual: layout.fitMode ?? "(missing)"
    });
    sink.add("viewport", "map.size", "引擎地图尺寸 = 格数 × tileSize（以 .bwproj 为真值）",
      close(num(layout.map?.width), mapW, TOL_WORLD) && close(num(layout.map?.height), mapH, TOL_WORLD), {
        expected: `${round(mapW)}x${round(mapH)}`,
        actual: `${num(layout.map?.width)}x${num(layout.map?.height)}`
      });

    // zoom = clamp(contain 取 min / cover 取 max)，上限已从 2 放宽到 4。
    const expectedZoom = fitMode === "cover"
      ? clamp(Math.max(vw / mapW, vh / mapH), 0.15, 4)
      : clamp(Math.min(vw / mapW, vh / mapH), 0.15, 4);
    const fitFormula = fitMode === "cover" ? "max(vw/mapW, vh/mapH)" : "min(vw/mapW, vh/mapH)";
    sink.add("viewport", "zoom", `zoom = clamp(${fitFormula}, 0.15, 4)（${fitMode}）`, close(zoom, expectedZoom, TOL_ZOOM), {
      expected: round(expectedZoom, 4),
      actual: round(zoom, 4)
    });

    // 地图在屏幕上的矩形（只由逻辑视口 + cam + zoom 决定）
    const mapScreen = {
      left: (0 - camX) * zoom + vw / 2,
      top: (0 - camY) * zoom + vh / 2
    };
    mapScreen.right = mapScreen.left + mapW * zoom;
    mapScreen.bottom = mapScreen.top + mapH * zoom;
    const margins = {
      left: mapScreen.left,
      right: vw - mapScreen.right,
      top: mapScreen.top,
      bottom: vh - mapScreen.bottom
    };
    const marginsText = `left=${round(margins.left)}, right=${round(margins.right)}, top=${round(margins.top)}, bottom=${round(margins.bottom)}`;
    // zoom 打印精度预算：屏幕/留白容差要随「视口或地图屏幕尺寸」放大（见 ZOOM_PRINT_UNCERTAINTY）。
    const extent = Math.max(vw, vh, mapW * zoom, mapH * zoom, 1);
    const screenTol = TOL_SCREEN + ZOOM_PRINT_UNCERTAINTY * extent;
    const marginTol = TOL_WORLD + ZOOM_PRINT_UNCERTAINTY * extent;
    const centered = close(margins.left, margins.right, TOL_WORLD) && close(margins.top, margins.bottom, TOL_WORLD);
    if (cameraFollow) {
      sink.info("viewport", "center", "相机跟随模式：跳过整图居中/适配检查", { cameraFollow, margins: roundMap(margins) });
    } else {
      sink.add("viewport", "center", `${fitMode} 模式下地图在屏幕居中（左右/上下留白差 <= 0.01）`, centered, {
        expected: "left=right, top=bottom",
        actual: marginsText
      });
      if (fitMode === "contain") {
        sink.add("viewport", "contain", "contain：地图完整落在视口内（不裁切）",
          margins.left >= -marginTol && margins.top >= -marginTol && margins.right >= -marginTol && margins.bottom >= -marginTol, {
            expected: `四边留白 >= 0（精度容差 ${round(marginTol, 3)}px）`,
            actual: marginsText
          });
      } else {
        sink.add("viewport", "cover", "cover：地图铺满视口（允许裁掉超出部分，四边留白 <= 0）",
          margins.left <= marginTol && margins.top <= marginTol && margins.right <= marginTol && margins.bottom <= marginTol, {
            expected: `四边留白 <= 0（精度容差 ${round(marginTol, 3)}px）`,
            actual: marginsText
          });
        sink.warn("viewport", "cover.touch", "cover：至少一个方向刚好铺满（不残留黑边）",
          [margins.left, margins.top, margins.right, margins.bottom].some((m) => Math.abs(m) <= 0.5), {
            expected: "min(|left|,|right|,|top|,|bottom|) <= 0.5",
            actual: marginsText
          });
      }
      // 相机中心 = 地图中心，否则居中不成立（更直接的诊断）
      sink.add("viewport", "camera", "fit 模式相机中心 = 地图中心", close(camX, mapW / 2, TOL_WORLD) && close(camY, mapH / 2, TOL_WORLD), {
        expected: `(${round(mapW / 2)}, ${round(mapH / 2)})`,
        actual: `(${round(camX)}, ${round(camY)})`
      });
    }
    // 相机跟随只在地图大于视口时才有意义
    if (cameraFollow && mapW <= vw && mapH <= vh) {
      sink.add("viewport", "follow", "地图小于视口时不应进入相机跟随", false, {
        expected: "cameraFollow=false",
        actual: "cameraFollow=true"
      });
    }

    // ---- 逐对象 ----
    const editorObjects = editorScene.objects ?? [];
    const engineObjects = (layout.objects ?? []).slice();
    const { pairs, unmatchedEditor, unmatchedEngine } = matchEngineObjects(editorObjects, engineObjects);
    const matchedById = pairs.filter((p) => p.matchedBy === "id").length;
    if (matchedById < pairs.length) {
      sink.warn("export", "id.match", "Build 对象 id 与 .bwproj 不完全一致（已按名字对拍，疑为旧导出）",
        false, { expected: "全部按 id 匹配", actual: `按 id ${matchedById} / 按名字 ${pairs.length - matchedById}` });
    }
    sink.add("objects", "match.editor", "每个编辑器对象都能在引擎侧找到", unmatchedEditor.length === 0, {
      expected: editorObjects.length,
      actual: pairs.length,
      detail: unmatchedEditor.map((o) => `${o.name || o.id}`).join(", ")
    });
    sink.add("objects", "match.engine", "引擎侧没有多余对象", unmatchedEngine.length === 0, {
      expected: 0,
      actual: unmatchedEngine.length,
      detail: unmatchedEngine.map((o) => `${o.name || o.id}`).join(", ")
    });

    // ---- 图层 / 可见性 / 绘制顺序 ----
    // 编辑器真值：canvas.ts paint 先按 orderObjects 排序（layer 数组下标 → z → y），
    // 并跳过「图层隐藏」与「对象自身隐藏」；导出器必须把可见性合成进 visible。
    const editorLayers = Array.isArray(editorScene.layers) ? editorScene.layers : [];
    const layerIndexById = new Map(editorLayers.map((l, i) => [String(l?.id ?? ""), i]));
    const layerVisibleById = new Map(editorLayers.map((l) => [String(l?.id ?? ""), l?.visible !== false]));
    const expectedVisibleOf = (eo) => Boolean(eo.visible) && (layerVisibleById.get(String(eo.layerId ?? "")) ?? true);
    const expectedLayerOf = (eo) => {
      const idx = layerIndexById.get(String(eo.layerId ?? ""));
      return idx == null ? editorLayers.length : idx; // 编辑器 orderObjects 对未知图层排最上层
    };
    const buildObjectsRaw = scene.objects ?? [];
    // 旧导出器不写对象级 layer 字段（引擎会全部按 0 处理）；新导出器才带图层信息。
    const buildHasLayer = buildObjectsRaw.length > 0 && buildObjectsRaw.every((o) => o && Object.prototype.hasOwnProperty.call(o, "layer"));
    const expectedOrdered = editorObjects.slice().sort((a, b) => {
      const la = expectedLayerOf(a);
      const lb = expectedLayerOf(b);
      if (la !== lb) return la - lb;
      const za = n0(a.z);
      const zb = n0(b.z);
      if (za !== zb) return za - zb;
      return n0(a.y) - n0(b.y);
    });
    const expectedSeq = expectedOrdered.map((o) => o.name || o.id);
    const engineSeq = engineObjects.map((o) => o.name || o.id);
    const seqFmt = (arr) => arr.join(" → ");

    const visibleFails = [];
    for (const { editor, engine } of pairs) {
      const want = expectedVisibleOf(editor);
      if (Boolean(engine.visible) !== want) {
        visibleFails.push(`${editor.name || editor.id}: 期望 ${want}，实际 ${Boolean(engine.visible)}`);
      }
    }
    sink.add("layer", "visible", "对象可见性与编辑器一致（对象 visible ∧ 图层 visible）", visibleFails.length === 0, {
      expected: "visible = editor.visible && layer.visible",
      actual: visibleFails.length ? visibleFails.slice(0, 8).join("；") : "全部一致",
      detail: visibleFails.length > 8 ? `另有 ${visibleFails.length - 8} 个` : ""
    });

    if (buildHasLayer) {
      const layerFails = [];
      for (const { editor, engine } of pairs) {
        const want = expectedLayerOf(editor);
        if (num(engine.layer) !== want) layerFails.push(`${editor.name || editor.id}: 期望 L${want}，实际 L${num(engine.layer)}`);
      }
      sink.add("layer", "layer.index", "对象 layer 下标与编辑器一致（场景图层数组顺序）", layerFails.length === 0, {
        expected: editorLayers.map((l, i) => `L${i}:${l?.name ?? ""}`).join(", ") || "无图层",
        actual: layerFails.length ? layerFails.slice(0, 8).join("；") : "全部一致"
      });

      const orderOk = expectedSeq.length === engineSeq.length && expectedSeq.every((n, i) => n === engineSeq[i]);
      let firstDiff = "";
      if (!orderOk) {
        const n = Math.max(expectedSeq.length, engineSeq.length);
        for (let i = 0; i < n; i++) {
          if (expectedSeq[i] !== engineSeq[i]) {
            firstDiff = `第 ${i + 1} 个：期望 ${expectedSeq[i] ?? "-"}，实际 ${engineSeq[i] ?? "-"}`;
            break;
          }
        }
      }
      sink.add("layer", "draw.order", "引擎绘制顺序 = 编辑器 orderObjects（layer → z → y）", orderOk, {
        expected: seqFmt(expectedSeq),
        actual: orderOk ? seqFmt(engineSeq) : `${firstDiff}；实际顺序 ${seqFmt(engineSeq)}`
      });
    } else {
      sink.warn("layer", "layer.unsupported", "旧 Build 缺少 layer 字段，跳过图层/绘制顺序断言（请用最新导出器重新打包）", false, {
        expected: seqFmt(expectedSeq),
        actual: `${rel(buildDir)} 的对象没有 layer 字段；引擎只能按 layer=0 → z → y 排序`
      });
    }

    let worstObject = null;
    for (const { editor, engine, matchedBy } of pairs) {
      const expected = editorBoundsOf(painter, project, editor);
      const actual = engineRect(engine);
      const cmp = compareRect(expected, actual);
      const branch = sizeBranch(painter, project, editor);
      // 记录源数据里的非整数几何字段：引擎若把这些字段截断，这是最直接的线索。
      const floatFields = ["x", "y", "rotation", "scaleX", "scaleY", "halfW", "halfH"]
        .filter((k) => Number.isFinite(Number(editor[k])) && !Number.isInteger(Number(editor[k])));
      const row = {
        name: editor.name ?? "",
        id: editor.id ?? "",
        matchedBy,
        branch,
        floatFields,
        source: roundMap({
          x: n0(editor.x),
          y: n0(editor.y),
          rotation: n0(editor.rotation),
          scaleX: n0(editor.scaleX),
          scaleY: n0(editor.scaleY),
          halfW: n0(editor.halfW),
          halfH: n0(editor.halfH)
        }),
        editor: roundMap(expected),
        engine: roundMap(actual),
        screen: roundMap({
          left: num(engine.screen?.left),
          top: num(engine.screen?.top),
          w: num(engine.screen?.w),
          h: num(engine.screen?.h),
          cx: num(engine.screen?.cx),
          cy: num(engine.screen?.cy)
        }),
        layer: {
          editor: expectedLayerOf(editor),
          engine: num(engine.layer),
          ok: !buildHasLayer || num(engine.layer) === expectedLayerOf(editor)
        },
        diffs: cmp.diffs,
        maxAbs: cmp.maxAbs,
        ok: cmp.ok,
        severity: cmp.ok ? "ok" : "fail"
      };
      result.objectRows.push(row);
      if (!cmp.ok) {
        const msg = `${row.name || row.id}: 期望 w=${round(expected.w)} h=${round(expected.h)} left=${round(expected.left)} top=${round(expected.top)}，` +
          `实际 w=${round(actual.w)} h=${round(actual.h)} left=${round(actual.left)} top=${round(actual.top)}（Δmax=${row.maxAbs}）`;
        result.failures.push({ group: "objects", title: "对象世界矩形不一致", detail: msg });
      }
      if (!worstObject || cmp.maxAbs > worstObject.maxAbs) worstObject = row;

      // screen = (world - cam) * zoom + view/2 复算（用引擎自己的 world）
      const screen = engine.screen ?? {};
      const wantLeft = (num(actual.left) - camX) * zoom + vw / 2;
      const wantTop = (num(actual.top) - camY) * zoom + vh / 2;
      const wantW = num(actual.w) * zoom;
      const wantH = num(actual.h) * zoom;
      const wantCx = (num(actual.x) - camX) * zoom + vw / 2;
      const wantCy = (num(actual.y) - camY) * zoom + vh / 2;
      const screenDiffs = {
        left: num(screen.left) - wantLeft,
        top: num(screen.top) - wantTop,
        w: num(screen.w) - wantW,
        h: num(screen.h) - wantH,
        cx: num(screen.cx) - wantCx,
        cy: num(screen.cy) - wantCy
      };
      const screenOk = Object.values(screenDiffs).every((d) => Math.abs(d) <= screenTol);
      if (!screenOk) {
        result.failures.push({
          group: "viewport",
          title: "screen 复算不一致",
          detail: `${row.name || row.id}: Δleft=${round(screenDiffs.left)} Δtop=${round(screenDiffs.top)} Δw=${round(screenDiffs.w)} Δh=${round(screenDiffs.h)} Δcx=${round(screenDiffs.cx)} Δcy=${round(screenDiffs.cy)}`
        });
      }
      // contain 模式下可见对象应全部在视口内；cover 模式允许裁边，只保留「对象在地图外」的提示。
      if (fitMode === "contain" && !cameraFollow && engine.visible !== false) {
        const insideMap =
          num(expected.left) >= -TOL_WORLD &&
          num(expected.top) >= -TOL_WORLD &&
          num(expected.left) + num(expected.w) <= mapW + TOL_WORLD &&
          num(expected.top) + num(expected.h) <= mapH + TOL_WORLD;
        const insideView =
          num(screen.left) >= -screenTol &&
          num(screen.top) >= -screenTol &&
          num(screen.left) + num(screen.w) <= vw + screenTol &&
          num(screen.top) + num(screen.h) <= vh + screenTol;
        if (insideMap && !insideView) {
          result.failures.push({
            group: "viewport",
            title: "contain 模式下地图内对象被裁到视口外",
            detail: `${row.name || row.id}: screen=(${round(num(screen.left))},${round(num(screen.top))},${round(num(screen.w))}x${round(num(screen.h))}) view=${vw}x${vh}`
          });
        } else if (!insideMap) {
          result.warnings.push({
            group: "viewport",
            title: "对象超出地图范围（contain 视口外属预期）",
            detail: `${row.name || row.id}: world=(${round(num(actual.left))},${round(num(actual.top))},${round(num(actual.w))}x${round(num(actual.h))})`
          });
        }
      }

      // ---- 旋转 ----
      // rotation：LayoutDump 直接输出解析后的角度（度），先断言角度本身没被截断/翻转符号。
      const editorRot = n0(editor.rotation);
      const engineRot = num(engine.rotation);
      const rotOk = close(engineRot, editorRot, 0.01);
      row.rotation = { editor: round(editorRot, 4), engine: round(engineRot, 4), ok: rotOk };
      if (!rotOk) {
        result.failures.push({
          group: "rotation",
          title: "rotation 角度不一致",
          detail: `${row.name || row.id}: 编辑器 ${round(editorRot, 4)}° / 引擎 ${round(engineRot, 4)}°`
        });
      }
      // edgeScreen：对象「右边缘中点」旋转后的屏幕坐标。编辑器公式（canvas rotate 顺时针、y 向下）：
      //   世界 (x + cosθ·w/2, y + sinθ·w/2) → 再走 screen=(world-cam)*zoom+view/2。
      // θ=90° 时 edge 应落在中心正下方；旋转方向被写反（glRotatef 忘改符号）会直接在这里暴露。
      const rad = (editorRot * Math.PI) / 180;
      const edgeWorld = {
        x: num(expected.x) + (Math.cos(rad) * num(expected.w)) / 2,
        y: num(expected.y) + (Math.sin(rad) * num(expected.w)) / 2
      };
      const edgeWant = {
        x: (edgeWorld.x - camX) * zoom + vw / 2,
        y: (edgeWorld.y - camY) * zoom + vh / 2
      };
      const edgeGot = { x: num(engine.edgeScreen?.x), y: num(engine.edgeScreen?.y) };
      const edgeOk = close(edgeGot.x, edgeWant.x, screenTol) && close(edgeGot.y, edgeWant.y, screenTol);
      row.edge = { expected: roundMap(edgeWant), engine: roundMap(edgeGot), ok: edgeOk };
      // 世界矩形已经不一致时，edge 的偏差多半是尺寸问题的连带结果，避免重复报错。
      if (!edgeOk && cmp.ok) {
        result.failures.push({
          group: "rotation",
          title: "右边缘中点旋转后屏幕坐标不一致",
          detail: `${row.name || row.id}: θ=${round(editorRot, 4)}° 期望 edge=(${round(edgeWant.x)}, ${round(edgeWant.y)})，实际 edge=(${round(edgeGot.x)}, ${round(edgeGot.y)})`
        });
      }
    }

    sink.add("objects", "world.rect", "逐对象世界矩形与编辑器真值一致（容差 0.01）", result.objectRows.every((r) => r.severity !== "fail"), {
      expected: `${pairs.length} 个对象全部一致`,
      actual: worstObject ? `最大偏差 ${worstObject.maxAbs}（${worstObject.name}）` : "无对象"
    });

    // ---- 验收数字（Lead 给定，换装示例 @1707x1067 全屏逻辑视口，与 DPI 无关）----
    // contain：zoom 2.2229，背景 1422.67x1067 @(142.17, 0)
    // cover  ：zoom 2.6672，背景 1707x1280.25 @(0, -106.62)
    if (baseName === "换装示例" && vw === 1707 && vh === 1067 && !cameraFollow) {
      const expected = fitMode === "cover"
        ? { zoom: 2.6672, left: 0, top: -106.62, w: 1707, h: 1280.25 }
        : { zoom: 2.2229, left: 142.17, top: 0, w: 1422.67, h: 1067 };
      sink.add("acceptance", "dressup.zoom", `验收：换装示例 @1707x1067 ${fitMode} zoom = ${expected.zoom}`,
        close(zoom, expected.zoom, 0.01), { expected: expected.zoom, actual: round(zoom, 4) });
      const bg = result.objectRows.find((r) => r.name === "换装背景");
      if (bg) {
        const ok = close(bg.screen.left, expected.left, TOL_SCREEN) &&
          close(bg.screen.top, expected.top, TOL_SCREEN) &&
          close(bg.screen.w, expected.w, TOL_SCREEN) &&
          close(bg.screen.h, expected.h, TOL_SCREEN);
        sink.add("acceptance", "dressup.bg",
          `验收：换装背景屏幕矩形 ${expected.w}x${expected.h} @(${expected.left}, ${expected.top}) ${fitMode}`,
          ok, {
            expected: `${expected.w}x${expected.h} @(${expected.left}, ${expected.top})`,
            actual: `${bg.screen.w}x${bg.screen.h} @(${bg.screen.left}, ${bg.screen.top})`
          });
      }
    }

    // ---- 运行时默认 fit = contain（用户拍板：默认整图可见，按 F 才切 cover）----
    // 只在 contain 的换装示例里跑一次，专门防「脚本显式传 --fit 掩盖默认值回归」。
    if (fitMode === "contain" && baseName === "换装示例") {
      const defLayout = runLayoutDump(bootFile, view, path.join(TMP_DIR, "layout-default-fit.json"), null);
      const defFit = defLayout.fitMode ?? "(missing)";
      sink.add("default", "default.fitMode", "LayoutDump 不传 --fit 时默认 fitMode = contain", defFit === "contain", {
        expected: "contain",
        actual: defFit
      });
      const dVw = num(defLayout.viewport?.width);
      const dVh = num(defLayout.viewport?.height);
      const dZoom = num(defLayout.zoom);
      const dExpectedZoom = clamp(Math.min(dVw / mapW, dVh / mapH), 0.15, 4);
      sink.add("default", "default.zoom", "默认 fit 的 zoom = clamp(min(vw/mapW, vh/mapH), 0.15, 4)",
        close(dZoom, dExpectedZoom, TOL_ZOOM), { expected: round(dExpectedZoom, 4), actual: round(dZoom, 4) });
      sink.add("default", "default.same", "默认 fit 与显式 --fit contain 结果完全一致",
        defFit === "contain" && close(dZoom, zoom, 1e-9) &&
          close(num(defLayout.camera?.x), camX, 1e-9) && close(num(defLayout.camera?.y), camY, 1e-9), {
          expected: "fitMode/zoom/camera 与 --fit contain 相同",
          actual: `fitMode=${defFit}, zoom=${dZoom}, cam=(${num(defLayout.camera?.x)}, ${num(defLayout.camera?.y)})`
        });
      const dCamX = num(defLayout.camera?.x);
      const defMapLeft = (0 - dCamX) * dZoom + dVw / 2;
      const defMapRight = dVw - (defMapLeft + mapW * dZoom);
      sink.add("default", "default.margins", "默认 contain 地图居中（左右留边对称）",
        close(defMapLeft, defMapRight, TOL_WORLD), {
          expected: "left == right",
          actual: `left=${round(defMapLeft, 2)}, right=${round(defMapRight, 2)}`
        });
      if (dVw === 1707 && dVh === 1067) {
        const dbg = (defLayout.objects ?? []).find((o) => o.name === "换装背景");
        const ds = dbg?.screen ?? {};
        sink.add("default", "default.dressup", "默认 contain @1707x1067：换装背景 1422.67x1067 @(142.17, 0)",
          close(num(ds.left), 142.17, TOL_SCREEN) && close(num(ds.top), 0, TOL_SCREEN) &&
            close(num(ds.w), 1422.67, TOL_SCREEN) && close(num(ds.h), 1067, TOL_SCREEN), {
            expected: "1422.67x1067 @(142.17, 0)",
            actual: `${num(ds.w)}x${num(ds.h)} @(${num(ds.left)}, ${num(ds.top)})`
          });
        sink.add("default", "default.margins.1707", "默认 contain @1707x1067：左右留边各 142.17 且对称",
          close(defMapLeft, 142.17, TOL_SCREEN) && close(defMapRight, 142.17, TOL_SCREEN), {
            expected: "left=right=142.17",
            actual: `left=${round(defMapLeft, 2)}, right=${round(defMapRight, 2)}`
          });
      }
    }

    // ---- 旋转 / 边缘点（防 glRotatef 方向写反）----
    const rotRows = result.objectRows.filter((r) => r.rotation && Math.abs(r.rotation.editor) > 1e-9);
    sink.add("rotation", "rotation.value", `rotation 角度与编辑器一致（${rotRows.length} 个对象 θ≠0）`,
      result.objectRows.every((r) => r.rotation?.ok), {
        expected: "全部一致（容差 0.01°）",
        actual: rotRows.length ? rotRows.map((r) => `${r.name}=${r.rotation.engine}°`).join(", ") : "全部为 0°"
      });
    const edgeRows = result.objectRows.filter((r) => r.severity === "ok");
    sink.add("rotation", "edge.screen", "右边缘中点旋转后的屏幕坐标与编辑器公式一致（顺时针为正）",
      edgeRows.every((r) => r.edge?.ok), {
        expected: "screen=(x+cosθ·w/2, y+sinθ·w/2) 再走视图变换",
        actual: rotRows.length
          ? rotRows.map((r) => `${r.name}: edge=(${r.edge?.engine?.x}, ${r.edge?.engine?.y})`).join(", ")
          : "无旋转对象"
      });

    // 归纳失败对象的可疑根因，报告里直接给「可能是哪个环节算错」的线索。
    result.suspects = [];
    for (const row of result.objectRows) {
      if (row.severity === "ok") continue;
      const ev = `编辑器 world=(${row.editor.left},${row.editor.top},${row.editor.w}x${row.editor.h})，` +
        `引擎 world=(${row.engine.left},${row.engine.top},${row.engine.w}x${row.engine.h})，` +
        `源字段=${JSON.stringify(row.source)}`;
      if (row.floatFields.length) {
        result.suspects.push({
          kind: "float-truncation",
          object: row.name,
          fields: row.floatFields,
          evidence: ev,
          hint: "源数据含非整数几何值；检查 GameData.loadScene 的 x/y/rotation/scaleX/scaleY/halfW/halfH/animFps 是否误用了 num(JsonObject,String,int) 重载（getAsInt 会截断小数）。"
        });
      } else if ((row.editor.w === 0 || row.editor.h === 0) && (row.engine.w > 0 || row.engine.h > 0)) {
        result.suspects.push({
          kind: "scale-zero",
          object: row.name,
          fields: ["scaleX", "scaleY"],
          evidence: ev,
          hint: "编辑器按 scale=0 算出 0×0，引擎若把 0 当成 1 就会仍按原尺寸绘制（检查 TopDownRuntime.nz()）。"
        });
      } else {
        result.suspects.push({
          kind: "unknown",
          object: row.name,
          fields: [],
          evidence: ev,
          hint: "字段都是整数，说明并非浮点截断；需检查该对象的尺寸分支（half/props/素材像素/tileSize）或导出器的数据映射。"
        });
      }
    }

    // ---- 素材像素旁证 ----
    // 编辑器 sizeOf 的「素材像素」一级用的是 .bwproj 里记的 width/height；
    // 引擎用的是 Build/assets 里 PNG 的真实像素。两边不一致 = 打包后大小必错。
    const bootAssets = (boot.assets ?? []).slice();
    const appRoot = path.dirname(buildDir); // Build 的父目录 = 引擎的 assetRoot
    const checkedPng = new Set();
    for (const { editor, engine } of pairs) {
      const editorAsset = (project.assets ?? []).find((a) => a.id === editor.assetId);
      if (!editorAsset) continue;
      const engineAsset = bootAssets.find((a) => a.id === editor.assetId) ??
        bootAssets.find((a) => a.name === editorAsset.name);
      if (!engineAsset || !engineAsset.path) {
        sink.warn("asset", `asset.present:${editor.name}`, `素材在 Build 中缺失：${editorAsset.name}`, false, {
          expected: editorAsset.name,
          actual: "未导出"
        });
        continue;
      }
      const pngFile = path.resolve(appRoot, engineAsset.path);
      const px = pngSize(pngFile);
      if (!px) {
        sink.warn("asset", `asset.png:${editor.name}`, `素材文件无法读取：${rel(pngFile)}`, false, {
          expected: "可读 PNG",
          actual: "缺失/非 PNG"
        });
        continue;
      }
      const declaredW = editorAsset.kind === "ATLAS" && editorAsset.cellW ? editorAsset.cellW : num(editorAsset.width);
      const declaredH = editorAsset.kind === "ATLAS" && editorAsset.cellH ? editorAsset.cellH : num(editorAsset.height);
      const cellOk =
        editorAsset.kind === "ATLAS"
          ? px.w === num(editorAsset.cellW) * num(editorAsset.cols) && px.h === num(editorAsset.cellH) * num(editorAsset.rows)
          : true;
      const key = `${engineAsset.path}`;
      if (!checkedPng.has(key)) {
        checkedPng.add(key);
        const declaredFullW = num(editorAsset.width);
        const declaredFullH = num(editorAsset.height);
        const pngMatchesDeclared = editorAsset.kind === "ATLAS"
          ? cellOk && px.w === declaredFullW && px.h === declaredFullH
          : px.w === declaredFullW && px.h === declaredFullH;
        sink.add("asset", `asset.px:${editorAsset.name}`, `PNG 实际像素与工程声明一致：${editorAsset.name} ${declaredFullW}x${declaredFullH}`, pngMatchesDeclared, {
          expected: `${declaredFullW}x${declaredFullH}`,
          actual: `${px.w}x${px.h}`,
          severity: "warn"
        });
      }
      if (!engineAsset.cellW && editorAsset.kind === "ATLAS") {
        sink.warn("asset", `asset.atlas:${editor.name}`, `图集缺少 cellW/cellH：${editorAsset.name}`, false, {
          expected: `${declaredW}x${declaredH}`,
          actual: `cellW=${engineAsset.cellW} cellH=${engineAsset.cellH}`
        });
      }
    }

    // ---- 全量素材旁证（不只对象用到的那些）----
    // 端到端包应该把工程里每张图都导成真实 PNG；像素尺寸必须等于 .bwproj 里记的 width/height。
    const allAssets = project.assets ?? [];
    const assetMissing = [];
    const assetMismatch = [];
    for (const a of allAssets) {
      const ea = bootAssets.find((b) => b.id === a.id) ?? bootAssets.find((b) => b.name === a.name);
      if (!ea || !ea.path) {
        assetMissing.push(`${a.name}: Build 未导出`);
        continue;
      }
      const px = pngSize(path.resolve(appRoot, ea.path));
      if (!px) {
        assetMissing.push(`${a.name}: PNG 读取失败`);
        continue;
      }
      if (px.w !== num(a.width) || px.h !== num(a.height)) {
        assetMismatch.push(`${a.name}: 声明 ${num(a.width)}x${num(a.height)} / PNG ${px.w}x${px.h}`);
      }
    }
    sink.warn("asset", "asset.all.present", `全部工程素材都随包导出（${allAssets.length - assetMissing.length}/${allAssets.length}）`, assetMissing.length === 0, {
      expected: `${allAssets.length} 个素材全部在 Build 中`,
      actual: assetMissing.length ? assetMissing.slice(0, 6).join("；") : "全部导出"
    });
    sink.add("asset", "asset.all.px", `全部素材 PNG 像素与工程声明一致（${allAssets.length - assetMismatch.length}/${allAssets.length}）`, assetMismatch.length === 0, {
      expected: `${allAssets.length} 个素材像素全部一致`,
      actual: assetMismatch.length ? assetMismatch.slice(0, 6).join("；") : "全部一致"
    });

    result.viewport = {
      fitMode,
      mapW,
      mapH,
      viewW: vw,
      viewH: vh,
      zoom: round(zoom, 4),
      expectedZoom: round(expectedZoom, 4),
      camX: round(camX, 4),
      camY: round(camY, 4),
      cameraFollow,
      margins: roundMap(margins),
      tolerances: { world: TOL_WORLD, screen: round(screenTol, 3), margin: round(marginTol, 3) },
      // 仅诊断用：编辑器 F 键（缩放整图）会留 48px 边距，引擎 fit 不留边距（只对 contain 有意义）
      editorFitZoom: round(clamp(Math.min((vw - 48) / mapW, (vh - 48) / mapH), 0.15, 2), 4)
    };
    result.buildBoot = bootFile;
    result.buildHasLayer = buildHasLayer;
    result.layoutPath = layoutPath;
    result.sceneFile = sceneFile;
  } catch (e) {
    result.error = e && e.message ? e.message : String(e);
    result.failures.push({ group: "case", title: "用例执行失败", detail: result.error });
  }

  // 汇总（checks 里 severity=warn/info 不算失败）
  result.checks = sink.checks;
  for (const c of sink.checks) {
    if (!c.ok && c.severity === "fail") {
      result.failures.push({ group: c.group, title: c.title, detail: `期望 ${fmt(c.expected)} / 实际 ${fmt(c.actual)}${c.detail ? " · " + fmt(c.detail) : ""}` });
    } else if (!c.ok && c.severity === "warn") {
      result.warnings.push({ group: c.group, title: c.title, detail: `期望 ${fmt(c.expected)} / 实际 ${fmt(c.actual)}${c.detail ? " · " + fmt(c.detail) : ""}` });
    }
  }
  result.failures = dedupe(result.failures);
  result.warnings = dedupe(result.warnings);
  result.stats = {
    checks: sink.checks.length,
    failChecks: sink.checks.filter((c) => !c.ok && c.severity === "fail").length,
    warnChecks: sink.checks.filter((c) => !c.ok && c.severity === "warn").length,
    objects: editorSceneCount(result),
    matched: result.objectRows.length,
    byId: result.objectRows.filter((r) => r.matchedBy === "id").length,
    byName: result.objectRows.filter((r) => r.matchedBy === "name").length,
    objectFails: result.objectRows.filter((r) => r.severity === "fail").length,
    objectWarns: result.objectRows.filter((r) => r.severity === "warn").length,
    objectOks: result.objectRows.filter((r) => r.severity === "ok").length,
    rotated: result.objectRows.filter((r) => r.rotation && Math.abs(r.rotation.editor) > 1e-9).length,
    rotationFails: result.objectRows.filter((r) => r.rotation && !r.rotation.ok).length,
    edgeFails: result.objectRows.filter((r) => r.severity === "ok" && r.edge && !r.edge.ok).length,
    layerFails: result.objectRows.filter((r) => r.layer && !r.layer.ok).length,
    layerChecked: Boolean(result.buildHasLayer)
  };
  result.ok = result.failures.length === 0 && !result.error;
  return result;
}

function editorSceneCount(result) {
  return result.objectRows.length;
}

function roundMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === "number" ? round(v, 2) : v;
  return out;
}

function fmt(v) {
  if (v === undefined) return "-";
  if (v === null) return "null";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => {
    const k = x.group + "|" + x.title + "|" + x.detail;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function safeSlug(s) {
  return s.replace(/[\\/:*?"<>|\s]+/g, "_");
}

// ---------------- 合成用例：覆盖 sizeOf 四级优先级 ----------------

function synthCase() {
  const dir = path.join(TMP_DIR, "synth");
  const buildDir = path.join(dir, "Build");
  ensureDir(buildDir);
  ensureDir(path.join(buildDir, "assets", "synth-big"));
  ensureDir(path.join(buildDir, "assets", "synth-atlas"));

  // 640x480 大图（IMAGE）与 640x480 图集（10x6 → 单元格 64x80）
  const bigPng = makePng(640, 480, [70, 110, 170]);
  fs.writeFileSync(path.join(buildDir, "assets", "synth-big", "main.png"), bigPng);
  fs.writeFileSync(path.join(buildDir, "assets", "synth-atlas", "main.png"), bigPng);

  const assets = [
    { id: "synth-big", name: "合成大图", kind: "IMAGE", path: "Build/assets/synth-big/main.png", head: "", frames: 1, cols: 1, rows: 1, cellW: 0, cellH: 0, zeroBased: false },
    { id: "synth-atlas", name: "合成图集", kind: "ATLAS", path: "Build/assets/synth-atlas/main.png", head: "", frames: 1, cols: 10, rows: 6, cellW: 64, cellH: 80, zeroBased: false }
  ];
  // .bwproj 的素材条目（编辑器 AssetEntry 字段）
  const editorAssets = [
    { id: "synth-big", name: "合成大图", kind: "IMAGE", src: "url", path: "合成大图", width: 640, height: 480, group: "合成用例", hiddenFrames: [], frameDurations: [] },
    { id: "synth-atlas", name: "合成图集", kind: "ATLAS", src: "url", path: "合成图集", width: 640, height: 480, cols: 10, rows: 6, cellW: 64, cellH: 80, group: "合成用例", hiddenFrames: [], frameDurations: [] }
  ];

  // 图层表：下标即编辑器 orderObjects 的排序键（order 字段编辑器从不维护，全是 0）。
  const synthLayers = [
    { id: "synth-layer-bg", name: "底层", visible: true, order: 0 },
    { id: "synth-layer-fg", name: "上层", visible: true, order: 0 },
    { id: "synth-layer-hidden", name: "隐藏层", visible: false, order: 0 }
  ];
  const synthLayerIndex = new Map(synthLayers.map((l, i) => [l.id, i]));
  const synthLayerVisible = new Map(synthLayers.map((l) => [l.id, l.visible !== false]));

  const base = { kind: "PROP", rotation: 0, scaleX: 1, scaleY: 1, z: 0, layerId: "synth-layer-fg", visible: true, locked: false, animMode: "默认", animFps: 8, modules: [], props: {}, tags: [], parentId: null };
  const editorObjects = [
    // 1) halfW/halfH 都有：80x60（scale=2 必须被忽略，与 editor 一致）
    { ...base, id: "synth-half", name: "半宽优先", x: 160, y: 120, halfW: 40, halfH: 30, scaleX: 2, scaleY: 2, assetId: "" },
    // 2) 只给 halfH：宽兜底 16、高 60
    { ...base, id: "synth-half-missing", name: "半边缺失", x: 320, y: 120, halfW: 0, halfH: 30, assetId: "" },
    // 3) 极小 half：最小 4（放到底层，验证跨图层排序）
    { ...base, id: "synth-half-min", name: "最小尺寸", x: 420, y: 120, halfW: 1, halfH: 2, layerId: "synth-layer-bg", assetId: "" },
    // 4) props + 非均匀 scale：100x20
    { ...base, id: "synth-props", name: "props缩放", x: 560, y: 120, props: { w: "50", h: "40" }, scaleX: 2, scaleY: 0.5, assetId: "" },
    // 5) props 只有一边 → 整条 props 规则不成立，落到 tileSize 兜底：32x32
    { ...base, id: "synth-props-partial", name: "props缺一半", x: 720, y: 120, props: { w: "50" }, assetId: "" },
    // 6) 素材像素 + scale：640x480 * 1.5 = 960x720
    { ...base, id: "synth-asset", name: "素材像素", x: 640, y: 480, scaleX: 1.5, scaleY: 1.5, assetId: "synth-big", assetName: "合成大图", tags: ["a"] },
    // 7) 图集单元格：64x80
    { ...base, id: "synth-atlas", name: "图集单元格", x: 160, y: 800, assetId: "synth-atlas", assetName: "合成图集" },
    // 8) 无素材、无 props、无 half → tileSize 32x32（放到底层）
    { ...base, id: "synth-tile", name: "格子兜底", x: 1000, y: 120, layerId: "synth-layer-bg", assetId: "" },
    // 9) 小数坐标：编辑器允许任意小数（缩放/拖动/属性面板），引擎若截断 int 就会偏。
    { ...base, id: "synth-frac-xy", name: "小数坐标", x: 123.5, y: 45.25, halfW: 10, halfH: 10, assetId: "" },
    // 10) 小数半宽半高：25x15，截断后会变成 24x14（x/y 也会截断）
    { ...base, id: "synth-frac-half", name: "小数半宽", x: 400.5, y: 845.5, halfW: 12.5, halfH: 7.5, assetId: "" },
    // 11) scale=0：编辑器算出 0x0（引擎现在也必须按 0 画，不允许把 0 当 1）
    { ...base, id: "synth-scale", name: "零缩放", x: 1100, y: 800, props: { w: "50", h: "40" }, scaleX: 0, scaleY: 0, assetId: "" },
    // 12) rotation=90：顺时针为正，右边缘中点应落在中心正下方（防 glRotatef 符号写反）
    { ...base, id: "synth-rot90", name: "旋转90度", x: 900, y: 400, halfW: 60, halfH: 20, rotation: 90, assetId: "" },
    // 13) rotation=30.5（小数）：同时验证 rotation 字段没有被 int 截断
    { ...base, id: "synth-rot-frac", name: "旋转30.5度", x: 900, y: 700, props: { w: "100", h: "40" }, rotation: 30.5, assetId: "" },
    // 14) 对象自身隐藏：编辑器不画，导出器的 visible 必须是 false
    { ...base, id: "synth-self-hidden", name: "自身隐藏", x: 200, y: 700, halfW: 20, halfH: 20, visible: false, assetId: "" },
    // 15) 所在图层隐藏：对象自身 visible=true，但合成后 visible 必须为 false
    { ...base, id: "synth-layer-hidden", name: "图层隐藏", x: 1180, y: 880, halfW: 20, halfH: 20, layerId: "synth-layer-hidden", assetId: "" }
  ];

  const editorScene = {
    id: "synth-scene",
    name: "合成场景",
    originX: 0,
    originY: 0,
    widthTiles: 40,
    heightTiles: 30,
    layers: synthLayers,
    objects: editorObjects,
    onStartScript: "",
    bgmAssetId: ""
  };
  const editorProject = {
    format: 1,
    name: "合成用例",
    author: "verify-mapping",
    tileSize: 32,
    gridW: 40,
    gridH: 30,
    scenes: [editorScene],
    assets: editorAssets,
    packs: [],
    scripts: [],
    variables: {},
    masterVolume: 0.8
  };
  const projectFile = path.join(dir, "合成用例.bwproj");
  fs.writeFileSync(projectFile, JSON.stringify(editorProject, null, 2), "utf8");

  // Build 侧：boot.json + scene_0.json（贴近最新导出器格式：带 layer / visibleSelf / layers[]）
  const buildObjects = editorObjects.map((o) => {
    const asset = assets.find((a) => a.id === o.assetId) ?? null;
    const selfVisible = o.visible !== false;
    const layerVisible = synthLayerVisible.get(o.layerId) ?? true;
    const out = {
      id: o.id,
      kind: o.kind,
      name: o.name,
      x: o.x,
      y: o.y,
      z: o.z,
      rotation: o.rotation,
      scaleX: o.scaleX,
      scaleY: o.scaleY,
      halfW: o.halfW ?? 0,
      halfH: o.halfH ?? 0,
      // 与 web/tools/package-bwe.mjs 相同的合成规则：运行时只读 visible。
      visible: selfVisible && layerVisible,
      visibleSelf: selfVisible,
      layer: synthLayerIndex.get(o.layerId) ?? synthLayers.length,
      layerId: o.layerId ?? "",
      parentId: o.parentId ?? null,
      assetId: o.assetId ?? "",
      assetName: o.assetName ?? "",
      animMode: o.animMode,
      animFps: o.animFps,
      tags: o.tags ?? [],
      modules: [],
      props: o.props ?? {}
    };
    if (asset) out.asset = asset;
    return out;
  });
  fs.writeFileSync(
    path.join(buildDir, "boot.json"),
    JSON.stringify({
      project: "合成用例",
      tileSize: 32,
      masterVolume: 0.8,
      scenes: [{ name: "合成场景", file: "scene_0.json", width: 40, height: 30 }],
      variables: {},
      scripts: [],
      assets
    }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(buildDir, "scene_0.json"),
    JSON.stringify({
      width: 40,
      height: 30,
      tileSize: 32,
      originX: 0,
      originY: 0,
      bgmAssetId: "",
      onStartScript: "",
      layers: synthLayers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, order: l.order })),
      objects: buildObjects
    }, null, 2),
    "utf8"
  );

  return { name: "合成用例（尺寸优先级）", projectPath: projectFile, buildDir };
}

// ---------------- 运行器 ----------------

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

  // 环境记录
  const env = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    released: typeof process.release === "string" ? process.release : process.release?.name,
    java: firstLine(run("java", ["-version"]).stderr) || "unknown",
    javac: firstLine(run("javac", ["-version"]).stdout) || "unknown",
    git: run("git", ["rev-parse", "--short", "HEAD"]).stdout.trim() || "n/a",
    view: `${opts.view.w}x${opts.view.h}`,
    cwd: REPO_ROOT.replaceAll("\\", "/")
  };

  log("编辑器 ↔ 引擎几何映射校验");
  log(`  仓库: ${REPO_ROOT}`);
  log(`  视口: ${env.view}    node: ${env.node}`);
  log(`  java: ${env.java}`);
  log("");

  // 1) 编译引擎侧
  log("[1/5] 编译 src/Studio/runtime/*.java（排除 GameLauncher.java）…");
  let compiled;
  try {
    compiled = compileRuntime();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  log(`      OK：${compiled.files.length} 个 java 文件 → ${rel(CLASSES_DIR)}（--release ${compiled.usedRelease}）`);

  // 2) 打编辑器真值
  log("[2/5] esbuild 打包 painter.ts（sizeOf/boundsOf）…");
  let painterInfo;
  let painter;
  try {
    painterInfo = bundlePainter();
    painter = await loadPainterTruth(painterInfo.bundle);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  log(`      OK：esbuild ${painterInfo.esbuildVersion} → ${rel(painterInfo.bundle)}`);

  // 3) 组装用例：先收集 base 用例，再按 fit 策略展开（默认 both → 每个用例各跑 cover / contain）
  const baseCases = [];
  for (const c of DEFAULT_CASES) {
    if (opts.only && !c.name.includes(opts.only)) continue;
    const override = opts.buildOverrides.get(c.name);
    const buildDir = override ?? discoverBuild(c.name);
    baseCases.push({ name: c.name, baseName: c.name, projectPath: c.project, buildDir: buildDir ?? null });
  }
  // E2E 包（.tmp_rel8/e2e-XXX/out/<包名>/app/Build 或 e2e-XXX/Build）：新导出器 + 新运行时的端到端产物，
  // 带 layer/visibleSelf/layers[]/originX 等新字段，正好覆盖图层顺序与可见性。
  const e2eCases = opts.e2e ? discoverE2ECases() : [];
  for (const c of e2eCases) {
    if (opts.only && !c.name.includes(opts.only)) continue;
    const override = opts.buildOverrides.get(c.name);
    baseCases.push({ name: c.name, baseName: c.name, projectPath: c.projectPath, buildDir: override ?? c.buildDir });
  }
  if (opts.synth && (!opts.only || "合成用例（尺寸优先级）".includes(opts.only))) {
    const synth = synthCase(); // 只生成一次，两种 fit 共用
    baseCases.push({ ...synth, baseName: synth.name });
  }
  const fitModes = opts.fit === "both" ? ["cover", "contain"] : [opts.fit];
  const cases = [];
  for (const b of baseCases) {
    for (const fitMode of fitModes) {
      const override = opts.buildOverrides.get(`${b.baseName}[${fitMode}]`);
      cases.push({ ...b, name: `${b.baseName} · ${fitMode}`, fitMode, buildDir: override ?? b.buildDir });
    }
  }
  if (!cases.length) {
    console.error("没有匹配的用例");
    process.exit(2);
  }

  // 4) 跑用例
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    log(`[3/5] 用例 ${i + 1}/${cases.length}：${c.name}`);
    if (!c.buildDir) {
      const r = {
        name: c.name,
        baseName: c.baseName,
        fitMode: c.fitMode,
        projectPath: c.projectPath,
        buildDir: null,
        view: opts.view,
        checks: [],
        objectRows: [],
        failures: [{ group: "case", title: "找不到已打包的 Build", detail: "请先打包，或用 --build 名称=目录 指定" }],
        warnings: [],
        viewport: null,
        ok: false,
        error: "找不到已打包的 Build",
        stats: {
          checks: 0, failChecks: 1, warnChecks: 0, objects: 0, matched: 0, byId: 0, byName: 0,
          objectFails: 0, objectWarns: 0, objectOks: 0, rotated: 0, rotationFails: 0, edgeFails: 0,
          layerFails: 0, layerChecked: false
        }
      };
      results.push(r);
      log("      跳过：找不到 Build");
      continue;
    }
    log(`      Build: ${rel(c.buildDir)}`);
    const r = compareCase({ ...c, view: opts.view, painter });
    results.push(r);
    if (r.error) {
      log(`      ✗ 执行失败：${r.error.split("\n")[0]}`);
    } else {
      const s = r.stats;
      const layerBad = r.checks.filter((x) => x.group === "layer" && !x.ok);
      const layerStatus = layerBad.length === 0 ? "PASS" : layerBad.some((x) => x.severity === "warn") ? "warn" : "FAIL";
      log(`      对象 ${s.matched}/${s.objects} 匹配（id ${s.byId} / name ${s.byName}）；世界矩形 ${s.objectOks}/${s.matched} 通过；` +
        `旋转 ${s.rotated ?? 0} 个 θ≠0（失败 ${s.rotationFails ?? 0}）；图层/顺序 ${layerStatus}；` +
        `检查 ${s.checks - s.failChecks - s.warnChecks}/${s.checks} 通过；失败 ${r.failures.length} / 警告 ${r.warnings.length} → ${r.ok ? "PASS" : "FAIL"}`);
      if (opts.verbose) {
        for (const ck of r.checks) log(`        [${ck.ok ? (ck.severity === "warn" ? "warn" : "ok") : ck.severity}] ${ck.group}/${ck.id}: ${ck.title} → ${fmt(ck.actual)}`);
      }
    }
  }

  // 5) 写报告 + 汇总
  const summary = {
    generatedAt: startedAt.toISOString(),
    env,
    options: { view: opts.view, fit: opts.fit, only: opts.only, synth: opts.synth, e2e: opts.e2e },
    cases: results.map((r) => ({
      name: r.name,
      baseName: r.baseName,
      fitMode: r.fitMode,
      ok: r.ok,
      error: r.error,
      buildDir: r.buildDir ? rel(r.buildDir) : null,
      buildMtime: r.buildMtime ?? null,
      projectPath: rel(r.projectPath),
      viewport: r.viewport,
      stats: r.stats,
      failures: r.failures,
      warnings: r.warnings,
      suspects: r.suspects ?? [],
      objectRows: r.objectRows,
      checks: r.checks
    })),
    totals: {
      cases: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      failures: results.reduce((n, r) => n + r.failures.length, 0),
      warnings: results.reduce((n, r) => n + r.warnings.length, 0)
    }
  };
  fs.writeFileSync(path.join(TMP_DIR, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  // 人工附录（本轮发现/修复记录等）放在单独文件里，重跑时自动拼到报告末尾，不会被覆盖掉。
  let reportBody = renderReport(summary, painterInfo);
  const appendixPath = path.join(TMP_DIR, "report-appendix.md");
  if (fs.existsSync(appendixPath)) {
    reportBody += "\n" + fs.readFileSync(appendixPath, "utf8").replace(/^\uFEFF/, "");
  }
  fs.writeFileSync(opts.report, reportBody, "utf8");

  log("");
  log("汇总");
  log("  " + "用例".padEnd(32) + "对象".padStart(4) + "  世界矩形  失败  警告  结果");
  for (const r of results) {
    const s = r.stats;
    log("  " + r.name.padEnd(32) + `${s.matched}/${s.objects}`.padStart(6) +
      `  ${s.objectOks}/${s.matched}`.padEnd(9) +
      String(r.failures.length).padStart(4) + String(r.warnings.length).padStart(6) +
      "   " + (r.ok ? "PASS" : "FAIL"));
    for (const f of r.failures.slice(0, 6)) log(`      FAIL ${f.title}: ${f.detail}`);
    if (r.failures.length > 6) log(`      ... 另有 ${r.failures.length - 6} 项失败，见报告`);
    for (const w of r.warnings.slice(0, 3)) log(`      warn ${w.title}: ${w.detail}`);
  }
  log("");
  log(`  通过 ${summary.totals.passed}/${summary.totals.cases} 个用例，失败 ${summary.totals.failures} 项，警告 ${summary.totals.warnings} 项`);
  log(`  报告: ${rel(opts.report)}`);
  log(`  机器可读: ${rel(path.join(TMP_DIR, "summary.json"))}`);
  process.exit(summary.totals.failed > 0 ? 1 : 0);
}

function firstLine(s) {
  return (s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] ?? "";
}

// ---------------- 报告 ----------------

function mdEscape(s) {
  return String(s ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderReport(summary, painterInfo) {
  const lines = [];
  lines.push("# 编辑器 ↔ 引擎几何映射校验报告");
  lines.push("");
  lines.push("> 由 `web/tools/verify-mapping.mjs` 自动生成。编辑器真值取自 `web/src/app/painter.ts` 的");
  lines.push("> `sizeOf()/boundsOf()`（esbuild 打包后直接调用，未复制公式）；引擎侧取自");
  lines.push("> `Studio.runtime.LayoutDump`（与 `TopDownRuntime` 渲染共用同一套 `Viewport`/`sizeOf`）。");
  lines.push("");
  lines.push("## 运行");
  lines.push("");
  lines.push("```");
  const viewArg = summary.options.view.w !== 1280 || summary.options.view.h !== 720 ? ` --view ${summary.options.view.w}x${summary.options.view.h}` : "";
  const fitArg = summary.options.fit !== "both" ? ` --fit ${summary.options.fit}` : "";
  lines.push(`node web/tools/verify-mapping.mjs${viewArg}${fitArg}`);
  lines.push("```");
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("| --- | --- |");
  lines.push(`| 时间 | ${summary.generatedAt} |`);
  lines.push(`| 仓库 | \`${summary.env.cwd}\` |`);
  lines.push(`| git HEAD | \`${summary.env.git}\` |`);
  lines.push(`| node | \`${summary.env.node}\` (${summary.env.platform}) |`);
  lines.push(`| java | \`${summary.env.java}\` |`);
  lines.push(`| javac | \`${summary.env.javac}\` |`);
  lines.push(`| esbuild | \`${painterInfo.esbuildVersion}\` |`);
  lines.push(`| 引擎视口 | ${summary.env.view}（逻辑尺寸） |`);
  lines.push(`| fit 策略 | ${summary.options.fit === "both" ? "cover + contain 各跑一遍（运行时默认 contain，F 键切 cover）" : summary.options.fit} |`);
  lines.push(`| DPI | 断言只用逻辑视口 + LayoutDump 输出，不读取 framebuffer 物理像素（Windows 150%/200% 缩放不影响结果） |`);
  lines.push(`| 引擎编译 | \`.tmp_rel8/verify/classes\`（排除 GameLauncher.java） |`);
  lines.push("");
  lines.push("## 判定汇总");
  lines.push("");
  lines.push("| 用例 | fit | Build | 对象匹配 | 世界矩形 | 视口不变量 | 图层/顺序 | 旋转 θ≠0 / 失败 | 失败 | 警告 | 结论 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of summary.cases) {
    const s = c.stats;
    const vpChecks = (c.checks ?? []).filter((x) => x.group === "viewport");
    const vpOk = vpChecks.filter((x) => x.ok).length;
    const vpTotal = vpChecks.length;
    const layerChecks = (c.checks ?? []).filter((x) => x.group === "layer");
    const layerBad = layerChecks.filter((x) => !x.ok);
    const layerMark = layerBad.length === 0 ? "PASS" : layerBad.some((x) => x.severity === "warn") ? "warn" : "**FAIL**";
    lines.push(
      `| ${mdEscape(c.baseName ?? c.name)} | ${c.fitMode ?? "-"} | \`${c.buildDir ?? "-"}\` | ${s.matched}/${s.objects} | ${s.objectOks}/${s.matched} | ${vpOk}/${vpTotal} | ${layerMark} | ${s.rotated ?? 0} / ${s.rotationFails ?? 0} | ${c.failures.length} | ${c.warnings.length} | ${c.ok ? "**PASS**" : "**FAIL**"} |`
    );
  }
  lines.push("");
  lines.push(`合计：通过 **${summary.totals.passed}/${summary.totals.cases}** 个用例，失败 **${summary.totals.failures}** 项，警告 **${summary.totals.warnings}** 项。`);
  lines.push("");

  for (const c of summary.cases) {
    lines.push(`## 用例：${mdEscape(c.name)}`);
    lines.push("");
    if (c.error) {
      lines.push(`❌ 执行失败：${c.error}`);
      lines.push("");
      continue;
    }
    lines.push(`- 工程：\`${c.projectPath}\``);
    lines.push(`- Build：\`${c.buildDir}\`${c.buildMtime ? `（boot.json 导出时间 ${c.buildMtime}）` : ""}`);
    const vp = c.viewport;
    const fitFormula = vp.fitMode === "cover" ? "max(vw/mapW, vh/mapH)" : "min(vw/mapW, vh/mapH)";
    lines.push(`- 地图：${round(vp.mapW)} x ${round(vp.mapH)}（世界单位），逻辑视口 ${vp.viewW}x${vp.viewH}，fit=**${vp.fitMode}**`);
    lines.push(`- zoom：实际 **${vp.zoom}** / 期望 **${vp.expectedZoom}** = clamp(${fitFormula}, 0.15, 4)；相机 (${vp.camX}, ${vp.camY})；cameraFollow=${vp.cameraFollow}`);
    lines.push(`- 地图屏幕留白：left=${vp.margins.left} right=${vp.margins.right} top=${vp.margins.top} bottom=${vp.margins.bottom}` +
      (vp.fitMode === "cover" ? "（cover 允许负留白 = 裁掉超出部分）" : "（contain 四边留白应 >= 0）"));
    if (vp.tolerances) {
      lines.push(`- 精度容差：world ${vp.tolerances.world}px；screen ±${vp.tolerances.screen}px；留白 ±${vp.tolerances.margin}px（由 LayoutDump 的 zoom 只打印 4 位小数换算而来，不是映射误差）`);
    }
    if (!vp.cameraFollow) {
      if (vp.fitMode === "contain") {
        lines.push(`- contain 是打包游戏的**默认**适配（整图可见、可能留边；按 F 切 cover）；参考编辑器 F 键（带 48px 边距）zoom=${vp.editorFitZoom}，引擎 contain 不留边距，这是刻意的显示差异（不是错位）。`);
      } else {
        lines.push(`- cover 是**按 F 切换**的铺满模式（全屏无黑边）；对象可能被裁到视口外属于有意行为，因此只校验几何与屏幕公式。`);
      }
    }
    const defFitCheck = c.checks.find((x) => x.group === "default" && x.id === "default.fitMode");
    if (defFitCheck) {
      lines.push(`- 运行时默认 fit（**LayoutDump 不传 --fit**）：${defFitCheck.ok ? "**PASS**" : "**FAIL**"}，回显 fitMode=**${mdEscape(fmt(defFitCheck.actual))}**；` +
        `zoom 与显式 contain 一致、地图居中（详见 default 组检查）。`);
    }
    const orderCheck = c.checks.find((x) => x.group === "layer" && x.id === "draw.order");
    if (orderCheck) {
      lines.push(`- 绘制顺序（layer→z→y）：${orderCheck.ok ? "**PASS**" : "**FAIL**"}；期望 ${mdEscape(fmt(orderCheck.expected))}；实际 ${mdEscape(fmt(orderCheck.actual))}`);
    }
    const layerUnsupported = c.checks.find((x) => x.group === "layer" && x.id === "layer.unsupported");
    if (layerUnsupported) {
      lines.push(`- 绘制顺序：**未校验**（${mdEscape(fmt(layerUnsupported.actual))}；期望 ${mdEscape(fmt(layerUnsupported.expected))}）`);
    }
    lines.push("");
    lines.push("| 对象 | 尺寸来源 | L(期望/实际) | rot° | 编辑器 w×h | 编辑器 left,top | 引擎 w×h | 引擎 left,top | Δmax | 结果 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    const layerUnchecked = Boolean(c.checks.find((x) => x.group === "layer" && x.id === "layer.unsupported"));
    for (const r of c.objectRows) {
      const e = r.editor;
      const a = r.engine;
      const mark = r.severity === "ok" ? "PASS" : "**FAIL**";
      const rot = r.rotation ? `${r.rotation.editor}${r.rotation.ok ? "" : " ⚠"}` : "-";
      const layer = r.layer
        ? layerUnchecked
          ? `${r.layer.editor}/—（未校验）`
          : `${r.layer.editor}/${r.layer.engine}${r.layer.ok ? "" : " ⚠"}`
        : "-";
      lines.push(
        `| ${mdEscape(r.name)} | ${r.branch} | ${layer} | ${rot} | ${e.w}×${e.h} | ${e.left}, ${e.top} | ${a.w}×${a.h} | ${a.left}, ${a.top} | ${r.maxAbs} | ${mark} |`
      );
    }
    lines.push("");
    const rotatedRows = c.objectRows.filter((r) => r.rotation && Math.abs(r.rotation.editor) > 1e-9);
    if (rotatedRows.length) {
      lines.push(`#### 旋转 / 右边缘中点校验（θ≠0 的对象）`);
      lines.push("");
      lines.push("编辑器公式：edge_world=(x+cosθ·w/2, y+sinθ·w/2)，再走 `screen=(world-cam)*zoom+view/2`；θ=90° 时 edge 应在中心正下方（顺时针为正）。");
      lines.push("");
      lines.push("| 对象 | θ 编辑器 / 引擎 | 期望 edge（屏幕） | 引擎 edge（屏幕） | 结果 |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const r of rotatedRows) {
        const want = r.edge?.expected ?? {};
        const got = r.edge?.engine ?? {};
        const mark = r.edge?.ok ? "PASS" : "**FAIL**";
        lines.push(`| ${mdEscape(r.name)} | ${r.rotation.editor}° / ${r.rotation.engine}° | (${want.x}, ${want.y}) | (${got.x}, ${got.y}) | ${mark} |`);
      }
      lines.push("");
    }
    const fracRows = c.objectRows.filter((r) => r.floatFields?.length);
    if (fracRows.length) {
      lines.push(
        "源数据含非整数几何字段的对象：" +
          fracRows.map((r) => `${r.name}（${r.floatFields.join("/")}）`).join("；") +
          "。若这些对象失败，优先怀疑引擎侧浮点字段被 int 截断。"
      );
      lines.push("");
    }
    if (c.failures.length) {
      lines.push("### 失败项");
      lines.push("");
      for (const f of c.failures) lines.push(`- **[${f.group}] ${mdEscape(f.title)}**：${mdEscape(f.detail)}`);
      lines.push("");
    }
    if (c.warnings.length) {
      lines.push("### 警告项");
      lines.push("");
      for (const w of c.warnings) lines.push(`- [${w.group}] ${mdEscape(w.title)}：${mdEscape(w.detail)}`);
      lines.push("");
    }
    const infra = c.checks.filter((x) => x.severity !== "info");
    const nPass = infra.filter((x) => x.ok).length;
    const nWarn = infra.filter((x) => !x.ok && x.severity === "warn").length;
    const nFail = infra.filter((x) => !x.ok && x.severity === "fail").length;
    lines.push(`### 检查明细（PASS ${nPass} · warn ${nWarn} · FAIL ${nFail}）`);
    lines.push("");
    lines.push("| 组 | 检查 | 结论 | 期望 | 实际 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const ck of c.checks) {
      const mark = ck.severity === "info" ? "info" : ck.ok ? "PASS" : ck.severity === "warn" ? "warn" : "**FAIL**";
      lines.push(`| ${ck.group} | ${mdEscape(ck.title)} | ${mark} | ${mdEscape(fmt(ck.expected))} | ${mdEscape(fmt(ck.actual))} |`);
    }
    lines.push("");
  }

  // 自动结论
  lines.push("## 自动结论");
  lines.push("");
  const failGroups = new Map();
  for (const c of summary.cases) {
    for (const f of c.failures) {
      const key = f.group;
      if (!failGroups.has(key)) failGroups.set(key, []);
      failGroups.get(key).push(`${c.name}：${f.title} — ${f.detail}`);
    }
  }
  if (!failGroups.size) {
    lines.push("所有硬性检查通过：编辑器真值与引擎实际计算的逐对象世界矩形、屏幕矩形、视口缩放/居中/contain 关系一致。");
    lines.push("");
  } else {
    lines.push("以下项未通过，说明「编辑器 → 引擎」映射仍有真实偏差（按组归类）：");
    lines.push("");
    for (const [group, items] of failGroups) {
      const why = {
        export: "导出器把地图/场景元数据写错，引擎据此算出的地图尺寸、格数或 tileSize 与工程不一致。",
        objects: "对象世界矩形不一致 → 画面中该对象的位置或大小与编辑器不同（用户看到的「错位 / 大小不对」）。",
        viewport: "视口缩放/居中/坐标变换不一致 → 用户看到的「整体偏移 / 只看到一角 / 不居中」。",
        layer: "图层下标/绘制顺序/可见性不一致 → 跨图层的遮挡关系错（例如地形盖住角色），或隐藏图层的对象在游戏里重新出现。",
        rotation: "旋转角度或旋转方向不一致 → 画面上对象/角色的朝向反了（glRotatef 正负号是最常见来源）。",
        acceptance: "验收数字（Lead 给定的 @1707x1067 全屏逻辑视口）不一致 → 说明 fit/视口公式或尺寸链路仍与约定不符。",
        default: "运行时默认 fit 不是 contain（用户拍板：默认整图可见、可留边，按 F 才切 cover）→ 检查 Viewport.fitMode 默认值与 LayoutDump 不传 --fit 的路径。",
        asset: "素材像素尺寸与工程声明不一致 → 走「素材像素」尺寸的物体会被画错大小。",
        case: "用例本身无法执行，先解决环境/路径问题。"
      }[group] ?? "";
      lines.push(`### ${group}`);
      lines.push("");
      if (why) lines.push(`影响：${why}`);
      lines.push("");
      for (const it of items) lines.push(`- ${mdEscape(it)}`);
      lines.push("");
    }
  }
  // 疑似引擎侧缺陷：把失败对象按源数据特征归类，直接给出「可能错在哪」。
  const suspects = summary.cases.flatMap((c) => (c.suspects ?? []).map((s) => ({ ...s, caseName: c.name })));
  if (suspects.length) {
    lines.push("## 疑似引擎侧缺陷（根因线索）");
    lines.push("");
    lines.push("以下对象在引擎侧算出的世界矩形与编辑器真值不同。**本脚本只报告，不修改 Java 源码。**");
    lines.push("");
    const kindTitle = {
      "float-truncation": "非整数几何字段被截断",
      "scale-zero": "scale = 0 语义不一致",
      unknown: "其他几何偏差"
    };
    const byKind = new Map();
    for (const s of suspects) {
      if (!byKind.has(s.kind)) byKind.set(s.kind, []);
      byKind.get(s.kind).push(s);
    }
    for (const [kind, items] of byKind) {
      lines.push(`### ${kindTitle[kind] ?? kind}`);
      lines.push("");
      lines.push(`- 疑似位置/原因：${items[0].hint}`);
      for (const it of items) {
        lines.push(`- ${mdEscape(it.caseName)} / ${mdEscape(it.object)}（源字段：${it.fields.join(", ") || "-"}）：${mdEscape(it.evidence)}`);
      }
      lines.push("");
    }
  }

  const warnItems = summary.cases.flatMap((c) => c.warnings.map((w) => `${c.name}：[${w.group}] ${w.title} — ${w.detail}`));
  if (warnItems.length) {
    lines.push("### 观察项 / 警告（不阻断通过）");
    lines.push("");
    for (const it of warnItems) lines.push(`- ${mdEscape(it)}`);
    lines.push("");
  }

  lines.push("## 覆盖范围与已知局限");
  lines.push("");
  lines.push("- 已覆盖：对象世界矩形（x/y/w/h/left/top）、尺寸四级优先级（halfW/halfH → props.w/h → 素材像素 → tileSize，含 scale=0 与小数缩放）、图集单元格、`screen=(world-cam)*zoom+view/2`、素材 PNG 实际像素与工程声明一致性。");
  lines.push("- 已覆盖 fit 两种策略（默认 each 跑一遍；**运行时默认 contain**，用户按 F 才切 cover）：`contain` → `clamp(min(vw/mapW, vh/mapH), 0.15, 4)` 且要求地图不裁切、地图内对象都在视口内；`cover` → `clamp(max(vw/mapW, vh/mapH), 0.15, 4)` 且要求铺满视口、允许裁边（不再要求对象都在视口内）。");
  lines.push("- 已覆盖默认值回归：对换装示例额外跑一次「LayoutDump 不传 `--fit`」，断言回显 `fitMode=contain`、zoom/camera 与显式 contain 完全一致、地图左右留边对称；@1707x1067 时背景 1422.67x1067 @(142.17, 0)、左右各留 142.17。");
  lines.push("- 已覆盖旋转：`rotation` 角度（含小数）原样一致 + 右边缘中点旋转后的屏幕坐标（θ=90° 落在中心正下方，顺时针为正）——用于防 `glRotatef` 正负号写反。");
  lines.push("- 已覆盖图层：对象 `layer` 下标（图层数组顺序）、绘制顺序（layer → z → y，与编辑器 `orderObjects()` 一致）、可见性（对象 visible ∧ 图层 visible 的合成结果）。");
  lines.push("- 已覆盖验收数字：换装示例 @1707x1067 逻辑视口，contain/cover 的 zoom 与背景屏幕矩形（Lead 给定值）作为独立断言。");
  lines.push("- 用例来源：`web/examples/*.bwproj` × 最新 Build；`.tmp_rel8/e2e-XXX/out/<包名>/app/Build` 端到端包（自动发现，按 boot.json 的 project 名配对工程）；以及脚本内置的合成用例；每个用例各跑 cover/contain。");
  lines.push("- 未覆盖：旋转后包围盒的贴图 UV/翻转、动画帧选择、z 排序与半透明混合——这些需要真实 GL 渲染，`LayoutDump` 只输出几何。");
  lines.push("- 多场景工程只校验 `boot.scenes[0]`（运行时默认打开第一个场景），其余场景需扩展脚本。");
  lines.push("- CI 接入：直接执行 `node web/tools/verify-mapping.mjs`，退出码 0=通过、1=有硬失败；脚本会自建 `.tmp_rel8/verify/` 工作目录，不写任何源码。");
  lines.push("- DPI：所有几何断言只用「逻辑视口 + LayoutDump 输出」，不读 framebuffer 物理像素，因此 Windows 150%/200% 显示缩放不影响判定；物理/逻辑尺寸混用导致的「画面没占满 + 点击偏移」在运行时侧修复（glViewport 用物理、投影/鼠标/fit 用逻辑）。");
  lines.push("- 编辑器 F 键（`zoomToFit`）带 48px 边距，而引擎 contain 不带边距，因此两边「缩放到整图」的 zoom 略有差异（引擎显示得略大），但都严格居中、不裁切，不属于错位缺陷。");
  lines.push("- `originX/originY` 在编辑器里没有任何消费方（`web/src` 里只出现在模型定义和默认值），引擎忽略它们是正确的。");
  lines.push("");
  return lines.join("\n");
}

main().catch((e) => {
  console.error("校验脚本异常:", e);
  process.exit(2);
});
