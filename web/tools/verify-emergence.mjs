#!/usr/bin/env node
/**
 * verify-emergence.mjs —— 涌现式沙盘（材质 / 场 / 噪音 / 感知 AI / 阵营 / 物理 / 拾取器）的端到端验收。
 *
 * 一条命令跑完 docs/emergence-demo.md 的 E1~E11：
 *   1. 工程与脚本：`web/examples/涌现沙盘.bwproj` 结构 + 6 段 js 脚本能降级到 ES5
 *   2. 编译：javac 运行时（--release 8）+ 编译无窗口驱动器 EmergeRun
 *   3. 导出：writeQuickBuild（不 jpackage）→ boot.json / scripts / 场景
 *   4. 真实运行（headless，真 TopDownRuntime + 真脚本）：跑两遍同种子工程，逐帧采集
 *   5. 断言 E1~E11
 *
 * 为什么走 headless：示例要验证的是**模拟**（材质场/物理/AI），不需要画面；
 * 而且 PATH 上的 JDK 26 跑 JOGL 会 GL 初始化失败（窗口能开、display 一帧不跑）。
 * 驱动器在 .tmp_rel8/emerge/driver/EmergeRun.java（同包，反射调 private update(dt)）。
 *
 * 用法：
 *   node web/tools/verify-emergence.mjs                 # 全跑（默认工程 + 20 秒模拟 × 2 遍）
 *   node web/tools/verify-emergence.mjs --seconds 20 --report .tmp_rel8/report-emergence.md
 *   node web/tools/verify-emergence.mjs --skip-run       # 只跑 1~3 段（快速冒烟）
 *   node web/tools/verify-emergence.mjs --only e4        # 只跑某个断言（调试用）
 *
 * 退出码：0 = 全 PASS（WARN 不算失败）；1 = 有 FAIL；2 = 前置依赖没就绪（编译/导出失败）
 *
 * 写盘范围：.tmp_rel8/emerge/**、.tmp_rel8/report-emergence.md。不改任何源码。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------- 常量 ----------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP_DIR = path.join(REPO_ROOT, ".tmp_rel8", "emerge");
const CLASSES_DIR = path.join(TMP_DIR, "classes");
const DRIVER_SRC = path.join(TMP_DIR, "driver", "EmergeRun.java");
const BUILD_ROOT = path.join(TMP_DIR, "build");
const BUILD_DIR = path.join(BUILD_ROOT, "Build");
const LOG_PATH = path.join(BUILD_DIR, "bwe.log");
const REPORT_PATH_DEFAULT = path.join(REPO_ROOT, ".tmp_rel8", "report-emergence.md");
const PROJECT_PATH_DEFAULT = path.join(REPO_ROOT, "web", "examples", "涌现沙盘.bwproj");
const RUNTIME_SRC_DIR = path.join(REPO_ROOT, "src", "Studio", "runtime");
const LIB_DIR = path.join(REPO_ROOT, "lib");

/** 与生成器一致的关键几何（只用于断言，不参与游戏逻辑）。 */
const GEO = {
  ignite: [12, 22],
  gate: [[14, 19], [15, 19]],
  oilCenter: [6.5, 23.5],
  channelX: 22 * 32 + 32,
  noise: { x: 26 * 32 + 16, y: 15 * 32 + 16 },
  e2: [[4, 16], [6, 16], [5, 17]],
  stone: [[10, 19], [12, 19], [16, 19], [20, 19]]
};

const ES5_FORBIDDEN = [
  { name: "箭头函数 =>", re: /=>/ },
  { name: "class 声明", re: /\bclass\s+[A-Za-z_$]/ },
  { name: "let 声明", re: /\blet\s+[A-Za-z_$]/ },
  { name: "const 声明", re: /\bconst\s+[A-Za-z_$]/ },
  { name: "模板字符串 `", re: /`/ }
];

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
  return !buf ? "" : Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
}
function firstLine(s) {
  return String(s || "").split(/\r?\n/).find((l) => l.trim()) || "";
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "buffer",
    windowsHide: true,
    timeout: opts.timeout ?? 600_000,
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
function num(v, def = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function round(v, d = 2) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}
function mdEscape(s) {
  return String(s ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

// ---------------- 结果收集 ----------------

const rows = [];
let setupError = null;

function add(step, title, ok, detail = "", onFail = "FAIL") {
  rows.push({ step, title, status: ok ? "PASS" : onFail, detail: String(detail ?? "") });
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
  const fail = list.filter((r) => r.status === "FAIL").length;
  return {
    step,
    total: list.length,
    pass: list.filter((r) => r.status === "PASS").length,
    fail,
    warn: list.filter((r) => r.status === "WARN").length,
    skip: list.filter((r) => r.status === "SKIP").length,
    status: list.length === 0 ? "SKIP" : fail > 0 ? "FAIL" : "PASS"
  };
}

// ---------------- 参数 ----------------

function parseArgs(argv) {
  const out = {
    projectPath: PROJECT_PATH_DEFAULT,
    reportPath: REPORT_PATH_DEFAULT,
    seconds: 20,
    dt: 0.05,
    skipRun: false,
    shot: false,
    only: "",
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--skip-run") out.skipRun = true;
    else if (a === "--shot") out.shot = true;
    else if (a === "--project") out.projectPath = path.resolve(argv[++i]);
    else if (a === "--report") out.reportPath = path.resolve(argv[++i]);
    else if (a === "--seconds") out.seconds = Math.max(1, num(argv[++i], 20));
    else if (a === "--dt") out.dt = Math.max(0.01, num(argv[++i], 0.05));
    else if (a === "--only") out.only = String(argv[++i] ?? "").toLowerCase();
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

function usage() {
  log(`涌现式沙盘验收（docs/emergence-demo.md 的 E1~E11）

用法: node web/tools/verify-emergence.mjs [选项]
  --project <路径>   .bwproj，默认 web/examples/涌现沙盘.bwproj
  --report <路径>    报告，默认 .tmp_rel8/report-emergence.md
  --seconds N        headless 模拟时长（秒），默认 20
  --dt N             固定步长（秒），默认 0.05
  --skip-run         只跑「工程/编译/导出」，不跑模拟与断言
  --only e4          只跑某条断言（调试用，e1..e11）
  -h, --help         帮助

退出码: 0 全 PASS（WARN 不算失败）/ 1 有 FAIL / 2 前置依赖没就绪`);
}

// ---------------- 1) 工程与脚本 ----------------

function loadTypeScript() {
  const require = createRequire(path.join(REPO_ROOT, "package.json"));
  try {
    return require("typescript");
  } catch {
    return null;
  }
}

function transpileToEs5(ts, source, name) {
  const result = ts.transpileModule(source, {
    fileName: name.endsWith(".js") ? name : name + ".js",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.None,
      alwaysStrict: false,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed
    }
  });
  const diags = (result.diagnostics ?? [])
    .filter((d) => d.file && d.category === ts.DiagnosticCategory.Error)
    .map((d) => {
      const pos = d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      return `${pos ? pos.line + 1 + ":" + (pos.character + 1) : "?"} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
  return { ok: diags.length === 0, diags, output: result.outputText ?? "" };
}

function checkEs5(out) {
  const hits = ES5_FORBIDDEN.filter((r) => r.re.test(out)).map((r) => r.name);
  return { ok: hits.length === 0 && /\bvar\s/.test(out), hits };
}

function stepProject(opts) {
  const step = "project";
  if (!fs.existsSync(opts.projectPath)) {
    fatal(step, "示例工程存在", `找不到 ${rel(opts.projectPath)}`);
    return null;
  }
  let project;
  try {
    project = readJson(opts.projectPath);
  } catch (e) {
    fatal(step, "示例工程是合法 JSON", String(e.message));
    return null;
  }
  add(step, "示例工程是合法 JSON", true, rel(opts.projectPath));
  const scene = project.scenes?.[0];
  const objects = scene?.objects ?? [];
  add(step, "地图 40x30 格 @32px（与 specs 一致）",
    scene?.widthTiles === 40 && scene?.heightTiles === 30 && project.tileSize === 32,
    `grid=${scene?.widthTiles}x${scene?.heightTiles} tileSize=${project.tileSize}`);
  const byKind = {};
  const byMat = {};
  for (const o of objects) {
    byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
    const m = o.props?.material;
    if (m) byMat[m] = (byMat[m] ?? 0) + 1;
  }
  add(step, "材质 TILE 齐全：stone / wood / oil",
    (byMat.stone ?? 0) > 0 && (byMat.wood ?? 0) > 0 && (byMat.oil ?? 0) > 0,
    Object.entries(byMat).map(([k, v]) => `${k}×${v}`).join(" "));
  add(step, "实体齐全：玩家 / 守卫×2 / 平民 / 油瓶",
    objects.filter((o) => (o.tags ?? []).includes("玩家")).length === 1 &&
      objects.filter((o) => (o.tags ?? []).includes("守卫")).length === 2 &&
      objects.filter((o) => (o.tags ?? []).includes("平民")).length === 1 &&
      objects.filter((o) => (o.tags ?? []).includes("油瓶")).length >= 1,
    `玩家=${objects.filter((o) => (o.tags ?? []).includes("玩家")).length} 守卫=${objects.filter((o) => (o.tags ?? []).includes("守卫")).length} 平民=${objects.filter((o) => (o.tags ?? []).includes("平民")).length} 油瓶=${objects.filter((o) => (o.tags ?? []).includes("油瓶")).length}`);
  add(step, "场景脚本 onStartScript = world（建材质/开物理/定种子）", scene?.onStartScript === "world",
    `onStartScript=${scene?.onStartScript}`);

  const scripts = Object.entries(project.scripts ?? {}).map(([k, s]) => ({
    key: k,
    name: String(s?.name ?? k),
    lang: String(s?.lang ?? "yarn"),
    source: String(s?.source ?? "")
  }));
  add(step, "6 段脚本且全部 lang=\"js\"", scripts.length === 6 && scripts.every((s) => s.lang === "js"),
    scripts.map((s) => `${s.name}(${s.source.length}B)`).join(" "));
  const refs = [];
  for (const o of objects) for (const m of o.modules ?? []) if (m.defId === "script.js") refs.push(m.values?.script);
  add(step, "对象上的 script.js 都指向存在的脚本",
    refs.length >= 6 && refs.every((r) => (project.scripts ?? {})[r]),
    refs.join(","));

  // 涌现基底的 API 用到了哪些（静态检查，防止示例退化成"只画图"）
  const all = scripts.map((s) => s.source).join("\n");
  const apis = ["bwe.material.", "bwe.field.", "bwe.noise.", "bwe.sense.", "bwe.ai.", "bwe.faction.", "bwe.physics.", "bwe.seed."];
  const missing = apis.filter((a) => !all.includes(a));
  add(step, "四层基底 API 都被示例用到（material/field/noise/sense/ai/faction/physics/seed）",
    missing.length === 0, missing.length ? `缺：${missing.join(" ")}` : `${apis.length} 个子系统`);

  const ts = loadTypeScript();
  if (!ts) {
    fatal(step, "仓库里有 typescript", "node_modules/typescript 不存在");
    return project;
  }
  let bad = 0;
  for (const s of scripts) {
    const t = transpileToEs5(ts, s.source, s.name);
    const e = checkEs5(t.output);
    if (!(t.ok && e.ok)) bad += 1;
    add(step, `transpile ${s.name}.js → ES5`, t.ok && e.ok,
      !t.ok ? t.diags.slice(0, 2).join(" | ") : !e.ok ? `ES6 残留：${e.hits.join(",")}` : `${t.output.length}B`);
  }
  add(step, "全部 js 脚本可降级到 ES5", bad === 0, `${scripts.length - bad}/${scripts.length}`);
  return project;
}

// ---------------- 2) 编译 ----------------

function compileRuntime() {
  const files = fs
    .readdirSync(RUNTIME_SRC_DIR)
    .filter((f) => f.endsWith(".java") && f !== "GameLauncher.java")
    .sort();
  rmrf(CLASSES_DIR);
  ensureDir(CLASSES_DIR);
  const base = [
    "-encoding", "UTF-8", "-Xlint:-options",
    "-cp", path.join(LIB_DIR, "*"),
    "-d", CLASSES_DIR,
    ...files.map((f) => path.join(RUNTIME_SRC_DIR, f))
  ];
  let r = run("javac", ["--release", "8", ...base]);
  let release = "8";
  if (r.status !== 0) {
    r = run("javac", base);
    release = "default";
  }
  if (r.status !== 0) throw new Error(`javac 失败 (exit ${r.status})\n${(r.stdout + r.stderr).slice(0, 2000)}`);
  return { files, release };
}

function compileDriver() {
  if (!fs.existsSync(DRIVER_SRC)) throw new Error(`找不到驱动器源码 ${rel(DRIVER_SRC)}`);
  const args = ["-encoding", "UTF-8", "-Xlint:-options", "-cp", `${CLASSES_DIR}${path.delimiter}${path.join(LIB_DIR, "*")}`, "-d", CLASSES_DIR, DRIVER_SRC];
  let r = run("javac", ["--release", "8", ...args]);
  if (r.status !== 0) r = run("javac", args);
  if (r.status !== 0) throw new Error(`驱动器编译失败 (exit ${r.status})\n${(r.stdout + r.stderr).slice(0, 2000)}`);
  return true;
}

function stepCompile() {
  const step = "compile";
  const engine = path.join(RUNTIME_SRC_DIR, "ScriptFields.java");
  if (!add(step, "Phase 2 子系统源码已落地（ScriptFields/ScriptAi/ScriptPhysics）",
    ["ScriptFields.java", "ScriptAi.java", "ScriptPhysics.java"].every((f) => fs.existsSync(path.join(RUNTIME_SRC_DIR, f))),
    "缺文件")) {
    fatal(step, "Phase 2 源码就绪", "等 script-runtime 落地");
    return false;
  }
  let compiled;
  try {
    compiled = compileRuntime();
  } catch (e) {
    fatal(step, "javac 编译运行时（排除 GameLauncher）", String(e.message).split("\n").slice(0, 4).join(" / "));
    return false;
  }
  add(step, "javac 编译运行时（排除 GameLauncher）", true,
    `${compiled.files.length} 个 java → ${rel(CLASSES_DIR)}（--release ${compiled.release}）`);
  try {
    compileDriver();
  } catch (e) {
    fatal(step, "编译无窗口驱动器 EmergeRun", String(e.message).split("\n").slice(0, 4).join(" / "));
    return false;
  }
  add(step, "编译无窗口驱动器 EmergeRun", true, rel(DRIVER_SRC));
  return true;
}

// ---------------- 3) 导出 Build ----------------

async function exportBuild(project, opts) {
  rmrf(BUILD_ROOT);
  ensureDir(BUILD_ROOT);
  const pkg = path.join(REPO_ROOT, "web", "tools", "package-bwe.mjs");
  try {
    const mod = await import(pathToFileURL(pkg).href);
    if (typeof mod.writeQuickBuild === "function") {
      const res = await mod.writeQuickBuild(project, null, BUILD_ROOT, () => {});
      return { ok: true, via: "writeQuickBuild", warnings: res?.warnings ?? [] };
    }
  } catch (e) {
    if (!/writeQuickBuild/.test(String(e))) {
      return { ok: false, error: String(e.message) };
    }
  }
  const r = run("node", ["web/tools/package-bwe.mjs", opts.projectPath, "--build-only", BUILD_ROOT]);
  if (r.status !== 0) return { ok: false, error: `CLI --build-only 失败：${firstLine(r.stderr)}` };
  return { ok: true, via: "cli --build-only", warnings: [] };
}

async function stepExport(project, opts) {
  const step = "export";
  const ex = await exportBuild(project, opts);
  if (!add(step, "导出 Build（不 jpackage）", ex.ok, ex.ok ? `via ${ex.via}` : ex.error)) return false;
  for (const w of ex.warnings ?? []) log(`      ⚠ 导出告警：${w}`);
  const bootFile = path.join(BUILD_DIR, "boot.json");
  if (!add(step, "Build/boot.json 存在", fs.existsSync(bootFile), rel(bootFile))) return false;
  const boot = readJson(bootFile);
  const scripts = boot.scripts ?? [];
  add(step, "boot.json scripts[] 带 lang=js / file", scripts.length === 6 && scripts.every((s) => s.lang === "js" && /^scripts\/.+\.js$/.test(s.file)),
    scripts.map((s) => `${s.name}:${s.file}`).join(" "));
  const missing = scripts.filter((s) => !fs.existsSync(path.join(BUILD_DIR, s.file)));
  add(step, "Build/scripts/*.js 都在", scripts.length > 0 && missing.length === 0, missing.map((s) => s.file).join(",") || `${scripts.length} 个`);
  const es5bad = [];
  for (const s of scripts) {
    const f = path.join(BUILD_DIR, s.file);
    if (!fs.existsSync(f)) continue;
    const e = checkEs5(fs.readFileSync(f, "utf8"));
    if (!e.ok) es5bad.push(`${s.name}(${e.hits.join(",")})`);
  }
  add(step, "导出后的脚本是 ES5", es5bad.length === 0, es5bad.join(" ") || "全部 ES5");
  const sceneFile = path.join(BUILD_DIR, boot.scenes?.[0]?.file ?? "scene_0.json");
  const scene = fs.existsSync(sceneFile) ? readJson(sceneFile) : null;
  add(step, "场景 onStartScript=world 透传", scene?.onStartScript === "world", `onStartScript=${scene?.onStartScript}`);
  add(step, "场景对象数与工程一致", (scene?.objects?.length ?? -1) === (project.scenes?.[0]?.objects?.length ?? -2),
    `Build=${scene?.objects?.length} project=${project.scenes?.[0]?.objects?.length}`);
  return true;
}

// ---------------- 4) 运行（headless，跑两遍） ----------------

function runOnce(seconds, dt, tag) {
  rmrf(LOG_PATH);
  const r = run("java", [
    "-Dstdout.encoding=UTF-8",
    "-Dstderr.encoding=UTF-8",
    "-cp", `${CLASSES_DIR}${path.delimiter}${path.join(LIB_DIR, "*")}`,
    "Studio.runtime.EmergeRun",
    path.join(BUILD_DIR, "boot.json"),
    String(seconds),
    String(dt)
  ], { timeout: 900_000 });
  const outFile = path.join(TMP_DIR, `run-${tag}.txt`);
  fs.writeFileSync(outFile, r.stdout + "\n--- stderr ---\n" + r.stderr, "utf8");
  if (fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(path.join(TMP_DIR, `log-${tag}.txt`), fs.readFileSync(LOG_PATH, "utf8").replace(/^\uFEFF/, ""), "utf8");
  }
  return { ok: r.status === 0, status: r.status, stdout: r.stdout, stderr: r.stderr, outFile };
}

// ---------------- 输出解析 ----------------

function kv(line) {
  const out = {};
  for (const part of line.split(/\s+/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function parseRun(stdout, logText) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const state = [];
  const mats = [];
  const ai = [];
  const body = [];
  let agg = {};
  let perf = {};
  let counts = {};
  let done = false;
  for (const line of lines) {
    if (line.startsWith("STATE ")) {
      const o = kv(line);
      state.push({ t: num(o.t), burn: num(o.burn), burned: num(o.burned), igniteFire: num(o.igniteFire), oilMax: num(o.oilMax), oilNear: num(o.oilNear), oilWide: num(o.oilWide), pondFire: num(o.pondFire), pondNbFire: num(o.pondNbFire), channelFire: num(o.channelFire), gateFire: num(o.gateFire) });
    } else if (line.startsWith("MAT ")) {
      const o = kv(line);
      mats.push({ t: num(o.t), gate: o.gate, gateSolid: num(o.gateSolid), gate2: o.gate2, gate2Solid: num(o.gate2Solid), pondWet: num(o.pondWet), channel: o.channel, e2_0: o.e2_0, e2_1: o.e2_1, e2_2: o.e2_2, stone_0: o.stone_0, stone_1: o.stone_1, stone_2: o.stone_2, stone_3: o.stone_3 });
    } else if (line.startsWith("AI ")) {
      const o = kv(line);
      const ents = {};
      for (const [k, v] of Object.entries(o)) {
        if (k === "t" || !v.includes("@")) continue;
        const [st, pos] = v.split("@");
        const [x, y] = pos.split(",").map(Number);
        ents[k] = { state: st, x, y };
      }
      ai.push({ t: num(o.t), ents });
    } else if (line.startsWith("BODY ")) {
      const o = kv(line);
      const ents = {};
      for (const [k, v] of Object.entries(o)) {
        if (k === "t" || k === "actorCount" || !v.includes("@")) continue;
        const [x, y] = v.split("@").map((s) => s.split(",").map(Number)).flat();
        ents[k] = { x, y };
      }
      body.push({ t: num(o.t), ents, actorCount: num(o.actorCount) });
    } else if (line.startsWith("AGG ")) agg = kv(line);
    else if (line.startsWith("PERF ")) perf = kv(line);
    else if (line.startsWith("COUNTS ")) counts = kv(line);
    else if (line.startsWith("EMERGE_DONE")) done = true;
  }
  const logLines = String(logText ?? "").split(/\r?\n/).filter(Boolean);
  return { state, mats, ai, body, agg, perf, counts, done, logLines };
}

function atTime(list, t, tol = 0.06) {
  let best = null;
  for (const item of list) {
    if (best == null || Math.abs(item.t - t) < Math.abs(best.t - t)) best = item;
  }
  return best && Math.abs(best.t - t) <= tol ? best : null;
}

function findLog(runData, needle) {
  return runData.logLines.filter((l) => l.includes(needle));
}

// ---------------- 5) E1~E11 ----------------

function stepAssertions(runA, runB, opts) {
  const step = "accept";
  const want = (id) => !opts.only || opts.only === id;
  const S = runA.state;
  const agg = {};
  for (const [k, v] of Object.entries(runA.agg)) agg[k] = num(v, v);

  // 引擎真的启动 & 打了 [涌现] 打点
  add(step, "引擎启动、脚本执行（日志出现 [涌现] 打点）", findLog(runA, "[涌现]").length > 0,
    `${findLog(runA, "[涌现]").length} 行 [涌现] 日志`);
  add(step, "按规格打了关键打点行（材质就绪/点火/木墙烧穿/油桶起火/平民 flee）",
    ["[涌现] 材质就绪", "[涌现] 点火 (12,22)", "[涌现] 木墙", "[涌现] 油桶起火", "[涌现] 平民 状态 → flee"]
      .every((k) => findLog(runA, k).length > 0),
    ["[涌现] 材质就绪", "[涌现] 点火 (12,22)", "[涌现] 木墙", "[涌现] 油桶起火", "[涌现] 平民 状态 → flee"]
      .map((k) => `${k.replace("[涌现] ", "")}:${findLog(runA, k).length}`).join(" "));

  // ---- E1：点燃草地后 4 秒，燃烧 ≥20 且烧毁 ≥8 ----
  if (want("e1")) {
    const ign = S.find((s) => s.igniteFire > 0);
    if (!ign) {
      add(step, "E1 起始点火发生（(12,22) 场强度>0）", false, "没采到 igniteFire>0 的帧");
    } else {
      const t4 = atTime(S, ign.t + 4);
      add(step, "E1 起火点已点燃（(12,22) fire>0）", true, `t=${ign.t}s 强度=${ign.igniteFire}`);
      add(step, "E1 点火后 4 秒：燃烧格 ≥ 20", Boolean(t4) && t4.burn >= 20,
        t4 ? `t=${t4.t}s burn=${t4.burn}` : "没采到 +4s 的帧");
      add(step, "E1 点火后 4 秒：烧毁格 ≥ 8", Boolean(t4) && t4.burned >= 8,
        t4 ? `t=${t4.t}s burned=${t4.burned}` : "没采到 +4s 的帧");
    }
  }

  // ---- E2：石墙外草地保持未燃烧（花圃被石墙围死，全程不变） ----
  if (want("e2")) {
    const badFrames = runA.mats.filter((m) => m.e2_0 !== "grass" || m.e2_1 !== "grass" || m.e2_2 !== "grass");
    add(step, "E2 石墙围死的花圃内草地全程未燃烧（3 个采样格始终 grass）", badFrames.length === 0,
      badFrames.length ? `第一帧异常 t=${badFrames[0].t}s e2=${badFrames[0].e2_0}/${badFrames[0].e2_1}/${badFrames[0].e2_2}` :
        `${runA.mats.length} 个采样帧全部 grass`);
    const last = runA.mats[runA.mats.length - 1];
    const stoneOk = last && ["stone_0", "stone_1", "stone_2", "stone_3"].every((k) => last[k] === "stones");
    add(step, "E2 石墙本身没被烧（4 个石墙格仍是 stone 且继续阻挡）", Boolean(stoneOk),
      last ? ["stone_0", "stone_1", "stone_2", "stone_3"].map((k) => last[k]).join(" ") : "无采样");
  }

  // ---- E3：木墙烧穿 → material.of == null 且 tilemap.solid == false ----
  if (want("e3")) {
    const burned = runA.mats.find((m) => m.gate === "null" && m.gateSolid === 0 && m.gate2 === "null" && m.gate2Solid === 0);
    add(step, "E3 木栅栏两格都烧穿：material=null 且 tilemap.solid=false", Boolean(burned),
      burned ? `t=${burned.t}s` : "全程没烧穿");
    add(step, "E3 烧穿耗时 ≤ 8 秒（从首次点火算起）", num(agg.gateBurnedAt, -1) >= 0 && num(agg.gateBurnedAt) <= 8,
      `gateBurnedAt=${agg.gateBurnedAt}s（点火 t≈0.8s）`);
    add(step, "E3 日志记录了「木墙 (…) 烧穿，格子已可通行」", findLog(runA, "木墙").some((l) => l.includes("已可通行")),
      findLog(runA, "木墙")[0] ?? "无");
  }

  // ---- E4：油桶被点燃后 2 秒内邻域燃烧格增长 ≥ 3（火势加速） ----
  if (want("e4")) {
    const toil = num(agg.oilFirstAt, -1);
    const a0 = toil >= 0 ? atTime(S, toil, 0.12) : null;
    const a2 = toil >= 0 ? atTime(S, toil + 2) : null;
    const g1 = a0 && a2 ? a2.oilNear - a0.oilNear : NaN;
    const g2 = a0 && a2 ? a2.oilWide - a0.oilWide : NaN;
    add(step, "E4 油桶被点着（oil 格出现明火，强度 ≥0.5）", num(agg.oilFirstAt, -1) >= 0 && num(agg.oilMaxEver) >= 0.5,
      `oilFirstAt=${agg.oilFirstAt}s oilMaxEver=${agg.oilMaxEver}`);
    add(step, "E4 着火后 2 秒内：紧凑邻域(5x5)燃烧格增长 ≥ 3", g1 >= 3, `Δ=${g1}（${a0 ? a0.oilNear : "?"} → ${a2 ? a2.oilNear : "?"}）`);
    add(step, "E4 着火后 2 秒内：油桶区(13x9)燃烧格增长 ≥ 3（火势向外扩张）", g2 >= 3, `Δ=${g2}（${a0 ? a0.oilWide : "?"} → ${a2 ? a2.oilWide : "?"}）`);
    add(step, "E4 日志记录了油桶爆燃（冲击波 + 大范围噪音）",
      findLog(runA, "油桶爆燃").length > 0, findLog(runA, "油桶爆燃")[0] ?? "无");
  }

  // ---- E5：水渠格 fire==0，相邻草地 wet==true ----
  if (want("e5")) {
    const waterOk = runA.mats.every((m) => m.channel === "water");
    add(step, "E5 水渠格材质始终是 water（不可燃，永久压火）", waterOk,
      waterOk ? `${runA.mats.length} 帧` : "水渠材质被改过");
    add(step, "E5 水渠格从未着火（channelFire 全程为 0）", num(agg.channelFireMax) === 0,
      `channelFireMax=${agg.channelFireMax}`);
    add(step, "E5 相邻草地被标记 wet（wet ≥ 0.5）", num(agg.pondWetMax) >= 0.5,
      `pondWetMax=${agg.pondWetMax}`);
  }

  // ---- E6：噪音后 2 秒内 ≥1 守卫 investigate，且与声源距离减小 ----
  if (want("e6")) {
    const tInv = num(agg.investigateAt, -1);
    add(step, "E6 守卫生成 investigate 状态", tInv >= 0, `investigateAt=${agg.investigateAt}s`);
    add(step, "E6 噪音（点火 t≈6.0s）后 2 秒内 investigate", tInv >= 0 && tInv <= 8.2,
      `t=${agg.investigateAt}s（噪音在 6.0s）`);
    const frames = runA.ai.filter((a) => a.t >= Math.max(0, tInv - 0.1) && a.t <= tInv + 2.2);
    let bestDecrease = null;
    for (const name of Object.keys(frames[0]?.ents ?? {})) {
      if (!name.includes("守卫")) continue;
      const p0 = frames[0]?.ents[name];
      const p1 = frames[frames.length - 1]?.ents[name];
      if (!p0 || !p1) continue;
      const d0 = Math.hypot(p0.x - GEO.noise.x, p0.y - GEO.noise.y);
      const d1 = Math.hypot(p1.x - GEO.noise.x, p1.y - GEO.noise.y);
      if (bestDecrease == null || d1 - d0 < bestDecrease.delta) bestDecrease = { name, d0, d1, delta: d1 - d0 };
    }
    add(step, "E6 investigate 开始 2 秒内与声源距离减小", Boolean(bestDecrease) && bestDecrease.delta < 0,
      bestDecrease ? `${bestDecrease.name}: ${round(bestDecrease.d0, 1)} → ${round(bestDecrease.d1, 1)}px（Δ=${round(bestDecrease.delta, 1)}）` : "无守卫位置数据");
  }

  // ---- E7：隔墙时 canSee=false，但仍听到噪音来查 ----
  if (want("e7")) {
    const inv = findLog(runA, "状态 → investigate");
    const seeFalse = inv.filter((l) => l.includes("canSee=false"));
    add(step, "E7 守卫 investigate 时 canSee=false（隔石墙看不见玩家）", seeFalse.length > 0,
      seeFalse.length ? seeFalse[0] : inv[0] ?? "没有 investigate 日志");
    const noiseLines = findLog(runA, "秒统计").filter((l) => /噪音 [1-9]/.test(l));
    add(step, "E7 同期确实存在噪音事件（noise.events 非空）", noiseLines.length > 0,
      noiseLines[0] ?? "没有含噪音>0 的统计行");
  }

  // ---- E8：applyImpulse 位移 ≥20px 且至少 1 次 collision 回调 ----
  if (want("e8")) {
    const disp = num(agg.bottleDisp, 0);
    add(step, "E8 applyImpulse 让油瓶位移 ≥ 20px", disp >= 20, `bottleDisp=${disp}px（${agg.bottleFrom} → ${agg.bottleTo}）`);
    const collisions = findLog(runA, "碰撞 #");
    add(step, "E8 触发 ≥1 次 physics collision 回调", collisions.length >= 1,
      collisions.length ? collisions[0] : "没有碰撞日志");
    add(step, "E8 日志记录了「推 油瓶1 冲量 …」", findLog(runA, "推 油瓶1").length > 0,
      findLog(runA, "推 油瓶1")[0] ?? "无");
  }

  // ---- E9：平民看见火 → flee，且朝水渠方向跑 ----
  if (want("e9")) {
    const tFlee = num(agg.fleeAt, -1);
    add(step, "E9 平民状态变为 flee", tFlee >= 0 && findLog(runA, "平民 状态 → flee").length > 0,
      `fleeAt=${agg.fleeAt}s`);
    // AI 快照是每 0.5 秒一行，所以取「≥ t 的最近一帧」而不是精确命中
    const frameAtOrAfter = (t) => {
      let best = null;
      for (const f of runA.ai) {
        if (f.t + 1e-6 >= t && (best == null || f.t < best.t)) best = f;
      }
      return best;
    };
    const civOf = (frame) => frame?.ents?.["平民·阿禾"] ?? null;
    const f0 = tFlee >= 0 ? frameAtOrAfter(tFlee) : null;
    const f2 = tFlee >= 0 ? frameAtOrAfter(tFlee + 1.9) : null;
    const c0 = civOf(f0);
    const c2 = civOf(f2);
    const d0 = c0 ? Math.abs(c0.x - GEO.channelX) : NaN;
    const d2 = c2 ? Math.abs(c2.x - GEO.channelX) : NaN;
    add(step, "E9 逃跑方向朝水渠（|Δx| 到水渠中线减小）", Number.isFinite(d0) && Number.isFinite(d2) && d2 < d0,
      Number.isFinite(d0) ? `距水渠 ${round(d0, 1)} → ${round(d2, 1)}px（x ${c0.x} → ${c2?.x}）` : `没有平民 AI 快照（fleeAt=${agg.fleeAt}s，AI 帧 ${runA.ai.length} 行）`);
  }

  // ---- E10：确定性（同种子跑两遍完全一致） ----
  if (want("e10")) {
    add(step, "E10 第二次运行成功完成", runB.done, runB.done ? "EMERGE_DONE" : "没跑完");
    const curveA = runA.state.map((s) => `${s.t}:${s.burn}:${s.burned}`).join("|");
    const curveB = runB.state.map((s) => `${s.t}:${s.burn}:${s.burned}`).join("|");
    add(step, "E10 燃烧/烧毁曲线两次完全一致", curveA === curveB && curveA.length > 0,
      curveA === curveB ? `${runA.state.length} 个采样点逐点相同` : `首次分叉在 ${firstDiff(curveA, curveB)}`);
    const aiA = runA.ai.map((a) => `${a.t}:` + Object.entries(a.ents).map(([k, v]) => `${k}=${v.state}`).join(",")).join("|");
    const aiB = runB.ai.map((a) => `${a.t}:` + Object.entries(a.ents).map(([k, v]) => `${k}=${v.state}`).join(",")).join("|");
    add(step, "E10 AI 状态序列两次完全一致", aiA === aiB && aiA.length > 0,
      aiA === aiB ? `${runA.ai.length} 个采样点` : `首次分叉在 ${firstDiff(aiA, aiB)}`);
    const matA = runA.mats.map((m) => `${m.t}:${m.gate}:${m.gateSolid}:${m.e2_0}:${m.e2_1}:${m.e2_2}`).join("|");
    const matB = runB.mats.map((m) => `${m.t}:${m.gate}:${m.gateSolid}:${m.e2_0}:${m.e2_1}:${m.e2_2}`).join("|");
    add(step, "E10 材质快照两次完全一致", matA === matB && matA.length > 0,
      matA === matB ? `${runA.mats.length} 个采样点` : `首次分叉在 ${firstDiff(matA, matB)}`);
  }

  // ---- E11：无 [脚本错误]，单帧模拟耗时 < 4ms ----
  if (want("e11")) {
    const errs = findLog(runA, "[脚本错误]").concat(findLog(runB, "[脚本错误]"));
    add(step, "E11 两次运行都没有 [脚本错误]", errs.length === 0, errs.length ? errs.slice(0, 3).join(" ⏎ ") : "0 条");
    const p95 = num(runA.perf.p95, NaN);
    const avg = num(runA.perf.avgMs, NaN);
    add(step, "E11 稳态单帧模拟耗时 p95 < 4ms", Number.isFinite(p95) && p95 < 4,
      `p95=${runA.perf.p95}ms avg=${runA.perf.avgMs}ms p50=${runA.perf.p50}ms（${runA.perf.steadyFrames} 帧，${runA.counts.actors ?? "?"} 实体）`);
    add(step, "E11 稳态平均耗时 < 2ms", Number.isFinite(avg) && avg < 2, `avg=${runA.perf.avgMs}ms`);
    add(step, "E11 帧错误为 0（EMERGE frameErrors）", num(runA.perf.frameErrors, -1) === 0,
      `frameErrors=${runA.perf.frameErrors}`);
    add(step, "E11 尾帧尖峰（max）只作参考，不影响判定", true,
      `max=${runA.perf.max}ms warmupMax=${runA.perf.warmupMaxMs}ms`, "WARN");
  }
}

function firstDiff(a, b) {
  const A = a.split("|");
  const B = b.split("|");
  for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) return `#${i}：A=${A[i]} B=${B[i]}`;
  return A.length === B.length ? "长度相同但内容不同(?)" : `长度不同 A=${A.length} B=${B.length}`;
}

// ---------------- 6) 真窗口取证（--shot） ----------------

/**
 * 可选段落：用 JDK 25 开一次真 GL 窗口，点火 + 走两步，然后截图存证。
 * 头号用途是「画面真的画出来了」的硬证据（日志只能证明模拟在跑）。
 * 注意：PATH 上的 JDK 26 跑 JOGL 会 GL 初始化失败，所以这里显式找 25。
 */
const SHOT_PS_SRC = String.raw`param([string]$Out = "shot.png", [int]$TargetPid = 0)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BweShot2 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindByPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
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

$hwnd = if ($TargetPid -gt 0) { [BweShot2]::FindByPid([uint32]$TargetPid) } else { [BweShot2]::FindByTitle("BWE") }
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW"; exit 3 }
$r = New-Object BweShot2+RECT
[void][BweShot2]::GetWindowRect($hwnd, [ref]$r)
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

const KEYS_PS_SRC = String.raw`param([int]$TargetPid = 0)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class BweKeys2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  public static IntPtr FindByPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Down(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void Up(byte vk) { keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
"@ -Language CSharp
$hwnd = [BweKeys2]::FindByPid([uint32]$TargetPid)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW"; exit 3 }
[void][BweKeys2]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 200
# 空格点火（玩家起步朝南，面前 (12,22) 是草地）
[BweKeys2]::Down(0x20); Start-Sleep -Milliseconds 90; [BweKeys2]::Up(0x20)
Start-Sleep -Milliseconds 1200
# W 往北挪一步（离开火线）
[BweKeys2]::Down(0x57); Start-Sleep -Milliseconds 450; [BweKeys2]::Up(0x57)
Start-Sleep -Milliseconds 1500
Write-Output "KEYS_SENT"
`;

function findGlJava() {
  const roots = ["C:\\Program Files\\Microsoft", "C:\\Program Files\\Eclipse Adoptium", "C:\\Program Files\\Java"];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!/^jdk-?(25|24)/i.test(d)) continue;
      const exe = path.join(root, d, "bin", "java.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return "java";
}

async function stepShot(opts) {
  const step = "shot";
  const javaExe = findGlJava();
  add(step, "找到能跑 JOGL 的 JDK（25/24）", javaExe !== "java", javaExe);
  if (javaExe === "java") {
    skip(step, "真窗口截图取证", "只有 PATH 上的 java（JDK 26 跑不了 JOGL GL）");
    return;
  }
  ensureDir(TMP_DIR);
  const keysPs = path.join(TMP_DIR, "shot-keys.ps1");
  const shotPs = path.join(TMP_DIR, "shot-capture.ps1");
  fs.writeFileSync(keysPs, KEYS_PS_SRC, "utf8");
  fs.writeFileSync(shotPs, SHOT_PS_SRC, "utf8");
  const shotPath = path.join(TMP_DIR, "screenshot.png");
  rmrf(shotPath);
  rmrf(LOG_PATH);

  const { spawn } = await import("node:child_process");
  const child = spawn(javaExe, [
    "--enable-native-access=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED",
    "-cp", `${CLASSES_DIR}${path.delimiter}${path.join(LIB_DIR, "*")}`,
    "-Djava.library.path=" + LIB_DIR,
    "-Dfile.encoding=UTF-8",
    "Studio.runtime.TopDownRuntime",
    path.join(BUILD_DIR, "boot.json")
  ], { cwd: REPO_ROOT, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => (out += d.toString()));
  child.stderr?.on("data", (d) => (err += d.toString()));
  let exited = false;
  child.on("exit", () => (exited = true));
  const kill = () => {
    try {
      run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      /* ignore */
    }
  };
  try {
    const t0 = Date.now();
    let opened = false;
    while (Date.now() - t0 < 25_000) {
      if (exited) break;
      if (fs.existsSync(LOG_PATH) && fs.readFileSync(LOG_PATH, "utf8").includes("窗口已打开")) {
        opened = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    add(step, "真窗口打开（JDK 25）", opened, opened ? `${Date.now() - t0}ms` : `没等到窗口；stdout：${firstLine(out)}`);
    if (opened) {
      const k = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", keysPs, "-TargetPid", String(pid)], { timeout: 60_000 });
      add(step, "注入按键（空格点火 + W 移动）", /KEYS_SENT/.test(k.stdout), firstLine(k.stdout) || firstLine(k.stderr), "WARN");
      const s = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", shotPs, "-Out", shotPath, "-TargetPid", String(pid)], { timeout: 60_000 });
      const saved = /SHOT_SAVED/.test(s.stdout) && fs.existsSync(shotPath);
      const size = saved ? fs.statSync(shotPath).size : 0;
      add(step, "截图取证（真窗口画面）", saved && size > 5_000,
        saved ? `${rel(shotPath)}（${(size / 1024).toFixed(0)}KB，${firstLine(s.stdout)}）` : `没截到：${firstLine(s.stdout) || firstLine(s.stderr)}`, "WARN");
      if (saved) opts.shotPath = shotPath;
      // 窗口里的日志也留一份，便于人工核对（脚本在真 GL 窗口里同样跑起来了）
      await new Promise((r) => setTimeout(r, 600));
      if (fs.existsSync(LOG_PATH)) {
        const lines = fs.readFileSync(LOG_PATH, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
        fs.writeFileSync(path.join(TMP_DIR, "log-windowed.txt"), lines.join("\n"), "utf8");
        add(step, "真窗口里脚本也执行了（日志有 [涌现] 打点）",
          lines.some((l) => l.includes("[涌现]")) && lines.some((l) => l.includes("视口映射")),
          `${lines.length} 行日志`);
      }
    }
  } finally {
    kill();
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------- 报告 ----------------

const STEP_ORDER = ["project", "compile", "export", "run", "accept", "shot"];
function stepTitle(id) {
  return (
    {
      project: "1. 工程与脚本（结构 + ES5）",
      compile: "2. 编译运行时 + 驱动器",
      export: "3. 导出 Build",
      run: "4. headless 真实运行 ×2",
      accept: "5. 验收断言 E1~E11",
      shot: "6. 真窗口截图取证（--shot）"
    }[id] ?? id
  );
}

function renderReport(ctx) {
  const { opts, env, startedAt, finishedAt, exitCode, runA } = ctx;
  const groups = STEP_ORDER.map(group);
  const totals = {
    pass: rows.filter((r) => r.status === "PASS").length,
    fail: rows.filter((r) => r.status === "FAIL").length,
    warn: rows.filter((r) => r.status === "WARN").length,
    skip: rows.filter((r) => r.status === "SKIP").length
  };
  const out = [];
  out.push("# 涌现式沙盘 · 端到端验收报告（E1~E11）");
  out.push("");
  out.push(`- 生成时间：${startedAt.toISOString()} → ${finishedAt.toISOString()}（${((finishedAt - startedAt) / 1000).toFixed(1)}s）`);
  out.push(`- 命令：\`node web/tools/verify-emergence.mjs${opts.only ? " --only " + opts.only : ""}\``);
  out.push(`- 工程：\`${rel(opts.projectPath)}\`　模拟：${opts.seconds}s ×2 遍（dt=${opts.dt}s）`);
  out.push(`- 结论：**${exitCode === 0 ? "全部通过" : exitCode === 1 ? "有失败项" : "前置依赖未就绪"}**（PASS ${totals.pass} / FAIL ${totals.fail} / WARN ${totals.warn} / SKIP ${totals.skip}）`);
  out.push("");
  out.push("## 环境");
  out.push("");
  out.push("| 项 | 值 |");
  out.push("|---|---|");
  out.push(`| node | \`${env.node}\` |`);
  out.push(`| java | \`${env.java}\` |`);
  out.push(`| javac | \`${env.javac}\` |`);
  out.push(`| typescript | \`${env.typescript}\` |`);
  out.push(`| 平台 | \`${env.platform}\` |`);
  out.push(`| 运行方式 | headless（真 TopDownRuntime，反射调 update；不开 GL 窗口） |`);
  out.push("");
  out.push("## 汇总");
  out.push("");
  out.push("| 段 | 检查项 | PASS | FAIL | WARN | SKIP | 结果 |");
  out.push("|---|---|---|---|---|---|---|");
  for (const g of groups) out.push(`| ${stepTitle(g.step)} | ${g.total} | ${g.pass} | ${g.fail} | ${g.warn} | ${g.skip} | **${g.status}** |`);
  out.push("");
  for (const g of groups) {
    const list = rows.filter((r) => r.step === g.step);
    if (!list.length) continue;
    out.push(`## ${stepTitle(g.step)}`);
    out.push("");
    out.push("| # | 检查 | 结果 | 说明 |");
    out.push("|---|---|---|---|");
    list.forEach((r, i) => out.push(`| ${i + 1} | ${mdEscape(r.title)} | ${r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "**FAIL**" : r.status} | ${mdEscape(r.detail)} |`));
    out.push("");
  }
  if (runA) {
    out.push("## 现场数据（第一遍运行）");
    out.push("");
    out.push("```");
    out.push(`AGG  ${Object.entries(runA.agg).map(([k, v]) => k + "=" + v).join(" ")}`);
    out.push(`PERF ${Object.entries(runA.perf).map(([k, v]) => k + "=" + v).join(" ")}`);
    out.push(`COUNTS ${Object.entries(runA.counts).map(([k, v]) => k + "=" + v).join(" ")}`);
    const every2 = runA.state.filter((s) => Math.abs(s.t - Math.round(s.t)) < 0.01 && Math.round(s.t) % 2 === 0);
    for (const s of every2) out.push(`t=${s.t}s 燃烧=${s.burn} 烧毁=${s.burned} 油区=${s.oilWide} 水渠火=${s.channelFire}`);
    out.push("```");
    out.push("");
  }
  const fails = rows.filter((r) => r.status === "FAIL");
  out.push("## 失败项与最小复现");
  out.push("");
  if (!fails.length) out.push("无失败项。");
  else {
    out.push("| 失败项 | 现场 | 最小复现 |");
    out.push("|---|---|---|");
    for (const f of fails) out.push(`| ${mdEscape(f.title)} | ${mdEscape(f.detail)} | \`node web/tools/verify-emergence.mjs --only ${guessE(f.title)}\` |`);
  }
  out.push("");
  out.push("## 说明");
  out.push("");
  out.push("- 运行方式：headless 用真 `TopDownRuntime` + 真 `Build/scripts/*.js`，按固定 0.05s 步长反射调 private `update(dt)`；不需要 GL，所以不受「PATH 上 JDK 26 跑不了 JOGL」影响。");
  out.push("- 驱动器 `EmergeRun.java` 按固定时间表模拟玩家输入（WASD / 空格点火 / F 推 / 左键丢瓶），等价于一个照剧本玩的玩家；示例脚本里没有写死任何剧情坐标。");
  out.push("- E10 确定性：工程里 `bwe.seed.set(20261026)` 同时重置材质场/物理/AI 三个随机源，两遍跑的逐帧曲线、AI 状态序列、材质快照做全量比对。");
  out.push("- 性能预算（§4）：材质场/物理/AI 一起计入整帧 `engine.update` 耗时，断言 p95 < 4ms；平均 < 2ms。");
  out.push("- 写盘范围：`.tmp_rel8/emerge/**`、`.tmp_rel8/report-emergence.md`；不改任何源码。");
  out.push("");
  return out.join("\n") + "\n";
}

function guessE(title) {
  const m = /^(E\d+)/i.exec(title.replace(/\*/g, ""));
  return (m ? m[1] : "e?").toLowerCase();
}

function printTable() {
  log("");
  log("=== PASS/FAIL ===");
  for (const g of STEP_ORDER.map(group)) {
    const list = rows.filter((r) => r.step === g.step);
    if (!list.length) continue;
    log(`\n[${stepTitle(g.step)}]  ${g.status}  (${g.pass}/${g.total} PASS, ${g.fail} FAIL, ${g.warn} WARN, ${g.skip} SKIP)`);
    for (const r of list) {
      const mark = r.status === "PASS" ? "✓" : r.status === "WARN" ? "!" : r.status === "SKIP" ? "-" : "✗";
      log(`  ${mark} ${r.title}${r.status === "PASS" ? "" : " —— " + r.detail}`);
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

  const env = {
    node: process.version,
    java: firstLine(run("java", ["-version"]).stderr),
    javac: firstLine(run("javac", ["-version"]).stdout),
    typescript: (() => {
      const ts = loadTypeScript();
      return ts ? ts.version : "(缺失)";
    })(),
    platform: `${process.platform} ${process.arch}`
  };

  log("涌现式沙盘 · 端到端验收（E1~E11）");
  log(`  仓库: ${REPO_ROOT}`);
  log(`  工程: ${rel(opts.projectPath)}`);
  log(`  node ${env.node} / ${env.javac}`);
  log("");

  log("[1/5] 工程结构 + 脚本 transpile…");
  const project = stepProject(opts);
  log(`      ${group("project").status}（${group("project").pass}/${group("project").total}）`);

  log("[2/5] 编译运行时 + 驱动器…");
  const compiled = stepCompile();
  log(`      ${group("compile").status}（${group("compile").pass}/${group("compile").total}）`);

  let exported = false;
  if (project) {
    log("[3/5] 导出 Build…");
    exported = await stepExport(project, opts);
    log(`      ${group("export").status}（${group("export").pass}/${group("export").total}）`);
  } else {
    skip("export", "导出 Build", "工程没读成功");
  }

  let runA = null;
  let runB = null;
  if (!opts.skipRun && exported && compiled) {
    log(`[4/5] headless 真实运行 ${opts.seconds}s ×2（同种子）…`);
    const a = runOnce(opts.seconds, opts.dt, "a");
    add("run", "第一遍运行完成（EMERGE_DONE）", a.ok, a.ok ? rel(a.outFile) : `exit ${a.status}：${firstLine(a.stderr)}`);
    if (a.ok) runA = parseRun(a.stdout, fs.existsSync(path.join(TMP_DIR, "log-a.txt")) ? fs.readFileSync(path.join(TMP_DIR, "log-a.txt"), "utf8") : "");
    const b = runOnce(opts.seconds, opts.dt, "b");
    add("run", "第二遍运行完成（确定性对拍用）", b.ok, b.ok ? rel(b.outFile) : `exit ${b.status}：${firstLine(b.stderr)}`);
    if (b.ok) runB = parseRun(b.stdout, fs.existsSync(path.join(TMP_DIR, "log-b.txt")) ? fs.readFileSync(path.join(TMP_DIR, "log-b.txt"), "utf8") : "");
    if (runA) {
      add("run", "逐帧采集到状态曲线", runA.state.length > 10, `${runA.state.length} 个 STATE 采样点`);
      add("run", "全程无帧异常", num(runA.perf.frameErrors, -1) === 0, `frameErrors=${runA.perf.frameErrors}`);
    }
    log(`      ${group("run").status}（${group("run").pass}/${group("run").total}）`);

    if (runA && runB) {
      log("[5/5] 验收断言 E1~E11…");
      stepAssertions(runA, runB, opts);
      log(`      ${group("accept").status}（${group("accept").pass}/${group("accept").total}）`);
    } else {
      skip("accept", "验收断言 E1~E11", "运行没成功");
    }
    // 可选：真窗口截图取证（--shot），证明画面也真的画出来了
    if (opts.shot && exported && compiled) {
      log("[+ ] 真窗口截图取证…");
      await stepShot(opts);
      log(`      ${group("shot").status}（${group("shot").pass}/${group("shot").total}）`);
    }
  } else if (opts.skipRun) {
    skip("run", "headless 真实运行", "--skip-run 指定跳过");
    skip("accept", "验收断言 E1~E11", "--skip-run 指定跳过");
  } else {
    skip("run", "headless 真实运行", "前置步骤失败");
    skip("accept", "验收断言 E1~E11", "前置步骤失败");
  }

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
  fs.writeFileSync(opts.reportPath, renderReport({ opts, env, startedAt, finishedAt, exitCode, runA }), "utf8");

  printTable();
  log("");
  if (setupError) log(`前置依赖没就绪：${setupError}`);
  log(`报告: ${rel(opts.reportPath)}`);
  log(`退出码: ${exitCode}（0=全 PASS / 1=有 FAIL / 2=前置依赖未就绪）`);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e?.stack || e);
  try {
    ensureDir(path.dirname(REPORT_PATH_DEFAULT));
    fs.writeFileSync(REPORT_PATH_DEFAULT, `# 涌现式沙盘验收报告\n\n校验脚本崩了：\n\n\`\`\`\n${e?.stack || e}\n\`\`\`\n`, "utf8");
  } catch {
    /* ignore */
  }
  process.exit(2);
});
