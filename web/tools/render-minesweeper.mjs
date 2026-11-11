#!/usr/bin/env node
/**
 * 用真实引擎（OffscreenFrameDump 离屏 GL）渲染扫雷横/竖屏，产出 PNG 供肉眼核对。
 *
 * 为什么还要它：verify-minesweeper-ui.mjs 证明的是「脚本逻辑与布局」，
 * 看不到 GL 真正画出来的像素。这里跑真的 TopDownRuntime，按手机逻辑视口出图。
 *
 * 用法：node web/tools/render-minesweeper.mjs [输出目录]
 *   需要 .tmp_build/bin 已编译（tools/bwe.ps1 build），且用 JDK 17~25（JOGL 2.1 跑不了 JDK 26）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { writeQuickBuild, findRuntimeJdk } from "./package-bwe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const BIN = join(ROOT, ".tmp_build", "bin");
/**
 * JDK 选择：本机默认 java 是 JDK 26，而 JOGL 2.1 在 JDK 26 上直接崩
 * （java.applet 已被移除）。用仓里现成的 findRuntimeJdk 挑 17~25，
 * 不写死某个人的安装路径；BWE_JAVA 可显式覆盖。
 */
async function pickJava() {
  if (process.env.BWE_JAVA) return process.env.BWE_JAVA;
  const { chosen, all } = await findRuntimeJdk();
  if (!chosen) {
    console.error("[render] 没找到 JDK 17~25（探测到 major: " +
      all.map((j) => j.major || "??").join(",") + "）。JOGL 跑不了 JDK 26+。");
    process.exit(2);
  }
  return chosen.javaExe;
}

const JAVA = await pickJava();
const OUT = process.argv[2] || join(ROOT, ".tmp_ms_ui");

if (!existsSync(join(BIN, "Studio", "runtime", "OffscreenFrameDump.class"))) {
  console.error("[render] 缺 OffscreenFrameDump.class，先跑 tools/bwe.ps1 build");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const jobs = [
  { file: "扫雷.bwproj", tag: "landscape", w: 1280, h: 720 },
  { file: "扫雷-竖屏.bwproj", tag: "portrait-1080x2400", w: 720, h: 1600 },
  { file: "扫雷-竖屏.bwproj", tag: "portrait-750x1624", w: 720, h: 1559 },
];

for (const j of jobs) {
  const dir = join(OUT, j.tag);
  mkdirSync(dir, { recursive: true });
  const project = JSON.parse(readFileSync(join(ROOT, "web", "examples", j.file), "utf8"));
  const r = await writeQuickBuild(project, null, dir, () => { });
  if (r.warnings?.length) console.log(`[${j.tag}] warn:`, r.warnings.slice(0, 3));
  const boot = join(dir, "Build", "boot.json");
  if (!existsSync(boot)) { console.error(`[${j.tag}] boot.json 没生成`); process.exit(2); }
  execFileSync(JAVA, [
    "--enable-native-access=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED",
    "-cp", `${BIN};${join(ROOT, "lib", "*")}`,
    "-Djava.library.path=" + join(ROOT, "lib"),
    "Studio.runtime.OffscreenFrameDump",
    boot, join(dir, "shot"), "45", String(j.w), String(j.h),
  ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const png = join(dir, "shot.png");
  const hash = join(dir, "shot.hash.txt");
  console.log(`[${j.tag}] ${j.w}x${j.h} → ${existsSync(png) ? png : "无 PNG"}`);
  if (existsSync(hash)) console.log("  " + readFileSync(hash, "utf8").trim().replace(/\n/g, " | "));
}
console.log("OUT=" + OUT);
