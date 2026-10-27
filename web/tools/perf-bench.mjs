#!/usr/bin/env node
/**
 * BWE 运行时性能基准驱动（编译 → 跑 → 存 JSON → 与基线对比）。
 *
 * 它只做三件事：
 *   1. 把 `-cp` 指向某个 classes 目录，跑 `Studio.runtime.ScriptPerfTest`，抓 `PERF` 机读行；
 *   2. 把结果连同环境元数据（commit / java 版本 / classpath / 时间戳）写进
 *      `web/.build/perf/<timestamp>.json`；
 *   3. 给了 `--baseline <json>` 就和基线做对比，输出变化百分比表格。
 *
 * ## 为什么必须支持 `--classpath`
 * before/after 必须跑在**不同**的 classes 目录上：
 *   - before = 冻结的 HEAD 基线编译产物
 *   - after  = 当前工作区的编译产物
 * 如果都编译到同一目录，after 会覆盖 before，基线就没了。所以 `--classpath` 是一等公民。
 *
 * ## 用法
 * ```bash
 * # 1) 编译当前 src 到默认目录并跑（after）
 * node web/tools/perf-bench.mjs
 *
 * # 2) 跑冻结的基线（before）
 * node web/tools/perf-bench.mjs --classpath .tmp_rel8/classes-baseline-perf --label before
 *
 * # 3) 跑 after 并与 before 的 JSON 对比
 * node web/tools/perf-bench.mjs --baseline web/.build/perf/<before>.json --label after
 *
 * # 4) 只跑不编译（classes 已就绪）
 * node web/tools/perf-bench.mjs --no-compile --classpath .tmp_rel8/classes-verify
 *
 * # 5) 带 GL 提交量指标（用纯 Java GL2 计数桩，不需要显卡）
 * node web/tools/perf-bench.mjs --glcount
 * ```
 *
 * ## 退出码
 * `0` = 跑成功；`1` = 编译失败/基准断言失败/解析不到 PERF 行。
 * `--allow-regression` 可让「性能变慢」不影响退出码（默认只报告，不判定）。
 */

import { spawnSync } from "node:child_process";
import os from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

// ---------------- 配置 ----------------

const JDK =
  process.env.BWE_JDK || "C:\\Program Files\\Microsoft\\jdk-25.0.3.9-hotspot";
const JAVA = join(JDK, "bin", "java.exe");
const JAVAC = join(JDK, "bin", "javac.exe");

const DEFAULTS = {
  classpath: ".tmp_rel8/classes-verify",
  srcDir: "src",
  outDir: "web/.build/perf",
  glcount: false,
  noCompile: false,
  label: "current",
  baseline: "",
  allowRegression: false,
  json: false,
  quiet: false,
  /** 变化超过这个百分比才算「显著」，避免噪声被当成回归。 */
  thresholdPct: 10,
};

// ---------------- CLI ----------------

function parseArgs(argv) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--classpath":
        o.classpath = argv[++i];
        break;
      case "--src":
        o.srcDir = argv[++i];
        break;
      case "--out":
        o.outDir = argv[++i];
        break;
      case "--label":
        o.label = argv[++i];
        break;
      case "--baseline":
        o.baseline = argv[++i];
        break;
      case "--threshold":
        o.thresholdPct = Number(argv[++i] || DEFAULTS.thresholdPct);
        break;
      case "--glcount":
        o.glcount = true;
        break;
      case "--no-compile":
        o.noCompile = true;
        break;
      case "--allow-regression":
        o.allowRegression = true;
        break;
      case "--json":
        o.json = true;
        break;
      case "--quiet":
        o.quiet = true;
        break;
      case "--help":
      case "-h":
        o.help = true;
        break;
      default:
        if (a.startsWith("--classpath=")) o.classpath = a.slice(12);
        else if (a.startsWith("--baseline=")) o.baseline = a.slice(11);
        else if (a.startsWith("--label=")) o.label = a.slice(8);
        else if (a.startsWith("--out=")) o.outDir = a.slice(6);
        break;
    }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`BWE 性能基准驱动

  --classpath <dir>      classes 目录（默认 ${DEFAULTS.classpath}）
  --src <dir>            Java 源码目录（默认 ${DEFAULTS.srcDir}）
  --out <dir>            JSON 输出目录（默认 ${DEFAULTS.outDir}）
  --label <name>         本次结果的标签（before / after / custom）
  --baseline <json>      与某次结果对比，输出变化百分比
  --threshold <pct>      「显著变化」阈值，默认 ${DEFAULTS.thresholdPct}%
  --glcount              启用 GL 提交量指标（纯 Java 计数桩，无需显卡）
  --no-compile           跳过编译（classes 已存在时用）
  --allow-regression     性能变慢也不返回非 0
  --json                 只输出 JSON（不打印人类可读表格）
  --quiet                安静模式
`);
  process.exit(0);
}

const log = (...a) => {
  if (!args.quiet) console.log(...a);
};

// ---------------- 工具 ----------------

function walkJava(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkJava(p, out);
    else if (name.endsWith(".java")) out.push(p);
  }
  return out;
}

/** 用 `git rev-parse` 拿 commit；拿不到就返回 "unknown"（不因为 git 失败而中断）。 */
function gitCommit() {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return (r.stdout || "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** 工作区是否有未提交改动（只读，绝不改 git 状态）。 */
function gitDirty() {
  try {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
    return (r.stdout || "").trim().length > 0;
  } catch {
    return null;
  }
}

function javaVersion() {
  try {
    const r = spawnSync(JAVA, ["-version"], { encoding: "utf8" });
    return ((r.stderr || "") + (r.stdout || "")).split("\n")[0].trim();
  } catch {
    return "unknown";
  }
}

/**
 * 编译 src → classpath 目录。
 * 注意：**不加 --release 8**（代码里有 pattern matching / var / switch 表达式）。
 */
function compile(classDir) {
  const files = walkJava(join(ROOT, args.srcDir));
  if (!files.length) {
    throw new Error(`源码目录里没有 .java：${join(ROOT, args.srcDir)}`);
  }
  mkdirSync(classDir, { recursive: true });
  log(`编译 ${files.length} 个 .java → ${classDir} ...`);
  const r = spawnSync(
    JAVAC,
    ["-d", classDir, "-encoding", "utf8", "-cp", "lib/*", ...files],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8" },
    },
  );
  if (r.status !== 0) {
    const msg = ((r.stdout || "") + (r.stderr || "")).slice(-4000);
    throw new Error(`编译失败（exit ${r.status}）:\n${msg}`);
  }
  log("编译成功。");
}

/**
 * 生成并编译 GL 计数桩（纯 Java `GL2` 实现，所有方法只累加计数）。
 * 只在 `--glcount` 时做。
 */
function buildGlStub(outDir) {
  const genSrc = join(ROOT, ".tmp_rel8", "vprobe", "Studio", "runtime", "GenerateGlStub.java");
  if (!existsSync(genSrc)) {
    log("⚠ 找不到 GenerateGlStub.java，跳过 GL 计数（无桩）");
    return false;
  }
  const genClasses = join(ROOT, ".tmp_rel8", "vprobe-classes");
  mkdirSync(genClasses, { recursive: true });
  const r1 = spawnSync(
    JAVAC,
    ["-d", genClasses, "-encoding", "utf8", "-cp", "lib/*", genSrc],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8" },
    },
  );
  if (r1.status !== 0) {
    log("⚠ GenerateGlStub 编译失败，跳过 GL 计数");
    return false;
  }
  const stubSrc = join(ROOT, ".tmp_rel8", "glstub", "Studio", "runtime", "GLCounterStub.java");
  const r2 = spawnSync(JAVA, ["-cp", `${genClasses};lib/*`, "Studio.runtime.GenerateGlStub", stubSrc], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8" },
  });
  if (r2.status !== 0) {
    log("⚠ GL 桩源码生成失败，跳过 GL 计数");
    return false;
  }
  const stubClasses = join(ROOT, ".tmp_rel8", "glstub-classes");
  const r3 = spawnSync(
    JAVAC,
    ["-d", stubClasses, "-encoding", "utf8", "-cp", `lib/*;${outDir}`, stubSrc],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8" },
    },
  );
  if (r3.status !== 0) {
    log("⚠ GL 桩编译失败，跳过 GL 计数");
    return false;
  }
  return stubClasses;
}

/**
 * 跑 ScriptPerfTest，返回 { exitCode, perf[], perfx[], assertionLines, rawTail }。
 * PERF 行格式（固定，解析器不得依赖顺序之外的任何东西）：
 *   PERF scene=A fps=xx.x updateMs=xx.xxx drawMs=xx.xxx allocBytesPerFrame=xx textures=xx
 */
function runBench(classDir, extraCp, glEnabled) {
  const cp = [classDir, extraCp, "lib/*"].filter(Boolean).join(";");
  const javaArgs = ["-Djava.awt.headless=true"];
  if (glEnabled) javaArgs.push("-Dbwe.perf.glcount=1");
  javaArgs.push("-cp", cp, "Studio.runtime.ScriptPerfTest");

  const r = spawnSync(JAVA, javaArgs, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8" },
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;

  const perf = [];
  const perfx = [];
  const assertionLines = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("PERF ")) {
      const rec = parsePerf(t);
      if (rec) perf.push(rec);
    } else if (t.startsWith("PERFX ")) {
      perfx.push(t.slice(6).trim());
    } else if (/^(PASS|FAIL)\s{2}/.test(t) || t.startsWith("共 ") || t.includes("ALL PASS")) {
      assertionLines.push(t);
    }
  }
  return { exitCode: r.status, perf, perfx, assertionLines, rawTail: out.slice(-3000) };
}

/** 解析一行固定格式的 PERF。格式不符返回 null（不猜、不填默认值）。 */
function parsePerf(line) {
  const m =
    /^PERF scene=(\w+) fps=([-\d.]+) updateMs=([-\d.]+) drawMs=([-\d.]+) allocBytesPerFrame=(-?\d+) textures=(-?\d+)/.exec(
      line,
    );
  if (!m) return null;
  return {
    scene: m[1],
    fps: Number(m[2]),
    updateMs: Number(m[3]),
    drawMs: Number(m[4]),
    allocBytesPerFrame: Number(m[5]),
    textures: Number(m[6]),
  };
}

/** 解析 PERFX 补充行：`PERFX scene=A ... k=v ...` → { scene, kv } */
function parsePerfX(perfxLines) {
  const out = [];
  for (const line of perfxLines) {
    const m = /^scene=(\w+)\s*(.*)$/.exec(line);
    if (!m) {
      out.push({ scene: null, kv: parseKv(line) });
      continue;
    }
    out.push({ scene: m[1], kv: parseKv(m[2]) });
  }
  return out;
}

function parseKv(s) {
  const kv = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)=(-?\d+(?:\.\d+)?|-?\d+)/g;
  let m;
  while ((m = re.exec(s))) {
    kv[m[1]] = Number(m[2]);
  }
  // 非数字值（如 note=... / N/A）单独留一个原文，便于报告引用
  const noteM = /note=([^\n]*)/.exec(s);
  if (noteM) kv.__note = noteM[1].trim();
  return kv;
}

// ---------------- 对比 ----------------

/** 每场景每指标算变化百分比；正数=变大，负数=变小。 */
function compareWithBaseline(cur, base) {
  const rows = [];
  const METRICS = ["updateMs", "drawMs", "allocBytesPerFrame", "textures", "fps"];
  const baseByScene = new Map(base.scenes.map((s) => [s.scene, s]));
  for (const s of cur.scenes) {
    const b = baseByScene.get(s.scene);
    if (!b) {
      rows.push({ scene: s.scene, metric: "(缺失)", before: null, after: null, deltaPct: null });
      continue;
    }
    for (const k of METRICS) {
      const bv = b[k];
      const cv = s[k];
      if (typeof bv !== "number" || typeof cv !== "number") continue;
      // N/A 哨兵（-1）不参与对比
      if (bv < 0 || cv < 0) {
        rows.push({ scene: s.scene, metric: k, before: bv, after: cv, deltaPct: null });
        continue;
      }
      const deltaPct = bv === 0 ? (cv === 0 ? 0 : null) : ((cv - bv) / bv) * 100;
      rows.push({ scene: s.scene, metric: k, before: bv, after: cv, deltaPct });
    }
  }
  return rows;
}

function printComparison(rows, thresholdPct) {
  console.log("");
  console.log("---------- before / after 对比 ----------");
  console.log(pad("场景", 6) + pad("指标", 20, false) + pad("before", 12, true) + pad("after", 12, true) + pad("变化", 10, true) + "  判定");
  for (const r of rows) {
    let verdict = "";
    if (r.deltaPct === null) verdict = r.before < 0 || r.after < 0 ? "N/A" : "—";
    else if (Math.abs(r.deltaPct) < thresholdPct) verdict = "≈（噪声内）";
    else if (r.deltaPct > 0) verdict = "变慢/变多 ↑";
    else verdict = "变快/变少 ↓";
    console.log(
      pad(r.scene, 6) +
        pad(r.metric, 20) +
        pad(fmtNum(r.before), 12, true) +
        pad(fmtNum(r.after), 12, true) +
        pad(r.deltaPct === null ? "N/A" : (r.deltaPct >= 0 ? "+" : "") + r.deltaPct.toFixed(1) + "%", 10, true) +
        "  " +
        verdict,
    );
  }
  console.log("");
  console.log(`（阈值 ${thresholdPct}%：小于它视为噪声。基准本身有 ±10~20% 抖动，别把小差异当结论。）`);
}

function fmtNum(v) {
  if (typeof v !== "number") return "N/A";
  if (v < 0) return "N/A";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3);
}

function pad(s, n, right = false) {
  s = String(s);
  const w = [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const fill = " ".repeat(Math.max(1, n - w));
  return right ? fill + s : s + fill;
}

// ---------------- 主流程 ----------------

function main() {
  if (!existsSync(JAVA)) {
    console.error(`找不到 java：${JAVA}\n可用 BWE_JDK 环境变量指向别的 JDK。`);
    process.exit(1);
  }
  const classDir = resolve(ROOT, args.classpath);
  mkdirSync(join(ROOT, args.outDir), { recursive: true });

  let glClasses = null;
  try {
    if (!args.noCompile) {
      compile(classDir);
      if (args.glcount) {
        glClasses = buildGlStub(classDir);
        if (!glClasses) log("⚠ GL 计数不可用，本次不输出 gl* 指标");
      }
    } else if (!existsSync(classDir)) {
      throw new Error(`--no-compile 但 classes 目录不存在：${classDir}`);
    }

    log(`跑基准（classpath=${args.classpath}${args.glcount && glClasses ? " +GL桩" : ""}）...`);
    const run = runBench(classDir, glClasses, Boolean(glClasses));

    if (!run.perf.length) {
      console.error("❌ 没解析到任何 PERF 行。原始输出尾部：");
      console.error(run.rawTail);
      process.exit(1);
    }

    const scenes = run.perf.map((p) => ({ ...p }));
    const record = {
      label: args.label,
      timestamp: new Date().toISOString(),
      commit: gitCommit(),
      gitDirty: gitDirty(),
      javaVersion: javaVersion(),
      jdk: JDK,
      classpath: args.classpath,
      classpathAbs: classDir,
      glCount: Boolean(glClasses),
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpus: (osCpus() || []).length,
        cpuModel: (osCpus() || [])[0]?.model || "unknown",
        totalMemGB: Math.round((totalMem() || 0) / 1024 ** 3),
      },
      /** 这次跑的命令行，保证可复现。 */
      command: `java ${glClasses ? "-Dbwe.perf.glcount=1 " : ""}-Djava.awt.headless=true -cp "${args.classpath};lib/*" Studio.runtime.ScriptPerfTest`,
      scenes: scenes.map((s) => ({
        scene: s.scene,
        fps: s.fps,
        updateMs: s.updateMs,
        drawMs: s.drawMs,
        allocBytesPerFrame: s.allocBytesPerFrame,
        textures: s.textures,
      })),
      extra: parsePerfX(run.perfx),
      assertions: run.assertionLines,
      exitCode: run.exitCode,
    };

    const stamp = record.timestamp.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const outFile = join(ROOT, args.outDir, `${stamp}${args.label ? "-" + args.label : ""}.json`);
    writeFileSync(outFile, JSON.stringify(record, null, 2), "utf8");

    // ---- 输出 ----
    if (args.json) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      console.log("");
      console.log("========== BWE 性能基准 ==========");
      console.log(`label      : ${record.label}`);
      console.log(`commit     : ${record.commit}${record.gitDirty ? " (工作区有未提交改动)" : ""}`);
      console.log(`java       : ${record.javaVersion}`);
      console.log(`classpath  : ${record.classpath}`);
      console.log(`GL 计数    : ${record.glCount ? "是（纯 Java 计数桩）" : "否"}`);
      console.log("");
      console.log(pad("场景", 6) + pad("updateMs", 12, true) + pad("drawMs", 12, true) + pad("allocB/f", 14, true) + pad("textures", 10, true) + pad("fps", 10, true));
      for (const s of record.scenes) {
        console.log(
          pad(s.scene, 6) +
            pad(fmtNum(s.updateMs), 12, true) +
            pad(fmtNum(s.drawMs), 12, true) +
            pad(fmtNum(s.allocBytesPerFrame), 14, true) +
            pad(fmtNum(s.textures), 10, true) +
            pad(s.fps.toFixed(1), 10, true),
        );
      }
      // 补充指标（每场景一行）
      const extras = record.extra.filter((e) => e.scene);
      if (extras.length) {
        console.log("");
        console.log("---------- 补充指标 ----------");
        for (const e of extras) {
          const parts = Object.entries(e.kv)
            .filter(([k]) => !k.startsWith("__"))
            .map(([k, v]) => `${k}=${v}`);
          if (e.kv.__note) parts.push(`note="${e.kv.__note}"`);
          console.log(`  scene=${e.scene}  ${parts.join(" ")}`);
        }
      }
      // GL 提交量
      const glRow = record.extra.find((e) => e.scene === "A" && e.kv.glTotal !== undefined);
      if (glRow && glRow.kv.glTotal > 0) {
        console.log("");
        console.log(
          `GL 提交量(场景A/帧): total=${glRow.kv.glTotal} glBegin=${glRow.kv.glBegin} ` +
            `glVertex2f=${glRow.kv.glVertex2f} glColor4f=${glRow.kv.glColor4f} ` +
            `glEnable=${glRow.kv.glEnable} glDisable=${glRow.kv.glDisable} ` +
            `glPushMatrix=${glRow.kv.glPushMatrix} glBindTexture=${glRow.kv.glBindTexture}`,
        );
      }
      console.log("");
      console.log(`断言: ${record.assertions.filter((l) => l.startsWith("FAIL")).length} FAIL / ${record.assertions.length} 行`);
      console.log(`结果已存: ${outFile}`);
    }

    // ---- 基线对比 ----
    let comparison = null;
    if (args.baseline) {
      const basePath = resolve(ROOT, args.baseline);
      if (!existsSync(basePath)) {
        console.error(`⚠ 基线不存在：${basePath}`);
      } else {
        const base = JSON.parse(readFileSync(basePath, "utf8"));
        comparison = compareWithBaseline(record, base);
        if (!args.json) {
          console.log(`\n基线: ${args.baseline} (label=${base.label || "?"}, ${base.timestamp || "?"})`);
          printComparison(comparison, args.thresholdPct);
        }
        // 把对比也写进本次 JSON，便于事后追溯
        record.baselinePath = args.baseline;
        record.comparison = comparison;
        writeFileSync(outFile, JSON.stringify(record, null, 2), "utf8");
      }
    }

    // ---- 退出码 ----
    if (run.exitCode !== 0) {
      console.error(`\n❌ ScriptPerfTest 有断言失败（exit ${run.exitCode}）`);
      for (const l of run.assertionLines.filter((x) => x.startsWith("FAIL"))) console.error("  " + l);
      process.exit(1);
    }
    // 性能回归不自动判失败（噪声大），除非显式要求
    if (comparison && !args.allowRegression) {
      const regressions = comparison.filter(
        (r) =>
          r.deltaPct !== null &&
          r.deltaPct > args.thresholdPct &&
          // 「变大就更好」的指标不参与回归判定
          !(r.metric === "fps"),
      );
      if (regressions.length) {
        console.error(`\n⚠ 有 ${regressions.length} 项指标比基线慢了 > ${args.thresholdPct}%：`);
        for (const r of regressions) {
          console.error(`  scene=${r.scene} ${r.metric}: ${fmtNum(r.before)} → ${fmtNum(r.after)} (+${r.deltaPct.toFixed(1)}%)`);
        }
        console.error("（这是提示，不是失败。要按失败退出用 --strict-perf，或加 --allow-regression 消音。）");
      }
    }
    process.exit(0);
  } catch (e) {
    console.error("❌ " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

// 尽量不引 os 之外的东西；这两个小包装让 --json 里的机器信息带兜底
function osCpus() {
  try {
    return os.cpus();
  } catch {
    return [];
  }
}
function totalMem() {
  try {
    return os.totalmem();
  } catch {
    return 0;
  }
}

main();
