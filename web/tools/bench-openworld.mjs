#!/usr/bin/env node
/**
 * 开放世界性能基准（可重复、同机同场景对比）。
 *
 * 任务书 §27 要求记录：对象数 / 精灵数 / 碰撞体数 / NPC 数 / 车辆数 /
 * 每帧渲染提交次数 / 逻辑更新耗时 / 物理模拟耗时 / 导航计算耗时 / 内存 / 场景加载时间。
 *
 * 本脚本做三件事：
 *   1. 用 `OffscreenFrameDump` 渲染真实帧，取「每帧 glBegin / drawCall / 平均显示耗时」；
 *   2. 用 `OpenWorldSoakTest` 的同类路径测「逻辑更新耗时」（含导航 / 物理 / AI）；
 *   3. 输出机读 JSON + 人读表格，便于前后对比。
 *
 * 用法：
 *   node web/tools/bench-openworld.mjs                 # 默认城市 + 90 帧
 *   node web/tools/bench-openworld.mjs --frames 180
 *   node web/tools/bench-openworld.mjs --json out.json
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const args = process.argv.slice(2);
const readArg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const FRAMES = Number(readArg("--frames", "90"));
const JSON_OUT = readArg("--json", "");
const OUT = resolve(ROOT, ".tmp_rel8", "bench-openworld");

function findJdk() {
  const c = [
    "C:\\Program Files\\Microsoft\\jdk-25.0.3.9-hotspot\\bin\\java.exe",
    join(process.env.JAVA_HOME || "", "bin", "java.exe"),
  ];
  for (const p of c) if (p && existsSync(p)) return p;
  return null;
}

const JDK = findJdk();
const BIN = resolve(ROOT, ".tmp_build", "bin");

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, {
    cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function num(re, s, d = 0) {
  const m = s.match(re);
  return m ? Number(m[1]) : d;
}

function main() {
  console.log("========== 开放世界性能基准 ==========");
  if (!JDK) {
    console.error("❌ 找不到 JDK 17~25");
    process.exit(1);
  }
  if (!existsSync(join(BIN, "Studio", "runtime", "OffscreenFrameDump.class"))) {
    console.error(`❌ 未编译：先跑 .\\tools\\bwe.ps1 build`);
    process.exit(1);
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // ---- 1) 生成 + 打包 ----
  for (const [cmd, argv] of [
    [process.execPath, ["node_modules/esbuild/bin/esbuild", "web/tools/gen-city.ts",
      "--bundle", "--platform=node", "--format=esm",
      "--outfile=web/.build/gen-city.mjs", "--log-level=warning"]],
    [process.execPath, ["web/.build/gen-city.mjs"]],
    [process.execPath, ["web/tools/package-bwe.mjs",
      "web/examples/开放世界城市.bwproj", "--build-only", OUT]],
  ]) {
    const r = run(cmd, argv);
    if (r.code !== 0) {
      console.error("❌ 前置步骤失败:", r.out.split("\n").slice(-5).join("\n"));
      process.exit(1);
    }
  }

  // 场景规模（从导出的 JSON 直接读，不用猜）
  const scene = JSON.parse(readFileSync(join(OUT, "Build", "scene_0.json"), "utf8"));
  const objects = scene.objects || [];
  const sprites = objects.filter((o) => o.assetId || o.assetName);
  const colliders = objects.filter((o) => (o.halfW || 0) > 0 && (o.halfH || 0) > 0);
  const npcCount = objects.filter((o) => (o.tags || []).includes("npc") || (o.tags || []).includes("玩家")).length;
  const vehicleCount = objects.filter((o) => (o.tags || []).includes("vehicle")).length;

  // ---- 2) 离屏渲染（真实 GL） ----
  const t0 = Date.now();
  const render = run(JDK, [
    "--enable-native-access=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED",
    "-cp", `${BIN};lib/*`, "-Djava.library.path=lib",
    "Studio.runtime.OffscreenFrameDump",
    join(OUT, "Build", "boot.json"), join(OUT, "bench"),
    String(FRAMES), "960", "540",
  ]);
  const loadMs = Date.now() - t0;
  const perf = (render.out.match(/OFFSCREEN_PERF [^\n]+/) || [""])[0];
  const done = (render.out.match(/OFFSCREEN_DONE [^\n]+/) || [""])[0];

  // ---- 3) 逻辑/物理/导航耗时（复用 soak 测试的量） ----
  const soak = run(JDK, [
    "--enable-native-access=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED",
    "-cp", `${BIN};lib/*`,
    "Studio.runtime.OpenWorldSoakTest",
  ]);

  // 从 ScriptPerfTest 取物理/AI 的既有指标（同一套件，可比）
  const perfTest = run(JDK, [
    "--enable-native-access=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED",
    "-cp", `${BIN};lib/*`,
    "Studio.runtime.ScriptPerfTest",
  ]);
  // 物理 step 平均值来自 ScriptPhysicsTest 的性能摘要行，所以要单独跑它。
  const physTest = run(JDK, [
    "--enable-native-access=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED",
    "-cp", `${BIN};lib/*`,
    "Studio.runtime.ScriptPhysicsTest",
  ]);
  const fieldsLine = (perfTest.out.match(/PERFX scene=B [^\n]+/) || [""])[0];
  const soakPerfLine = (soak.out.match(/SOAK_PERF [^\n]+/) || [""])[0];
  // 物理 step 的平均值来自 ScriptPhysicsTest 的性能摘要行。
  // 该行中文前缀会因控制台代码页变化，所以只锚定「World.step」+ 数字，不锚定汉字。
  const stepMatch = physTest.out.match(/World\.step[^\d]*([\d.]+)\s*ms/);

  const metrics = {
    generatedAt: new Date().toISOString(),
    machine: {
      os: process.platform,
      node: process.version,
      jdk: JDK.split("\\bin\\")[0],
    },
    scene: {
      name: scene.width + "x" + scene.height + " tiles",
      tileSize: scene.tileSize,
      objects: objects.length,
      sprites: sprites.length,
      colliders: colliders.length,
      npcs: npcCount,
      vehicles: vehicleCount,
      buildings: (scene.buildings || []).length,
      floors: (scene.buildings || []).reduce((a, b) => a + (b.floors || []).length, 0),
      zones: (scene.buildings || []).reduce(
        (a, b) => a + (b.floors || []).reduce((c, f) => c + (f.rooms || []).length, 0), 0),
      navLinks: (scene.navLinks || []).length,
      roadNodes: (scene.roadNetwork?.nodes || []).length,
      roadEdges: (scene.roadNetwork?.edges || []).length,
    },
    render: {
      frames: FRAMES,
      resolution: "960x540",
      avgDisplayMs: num(/avgDisplayMs=([\d.]+)/, perf, -1),
      glBeginsPerFrame: num(/glBeginsPerFrame=(\d+)/, perf, -1),
      drawCallsPerFrame: num(/drawCallsPerFrame=(\d+)/, perf, -1),
      textureBindsTotal: num(/textureBindsTotal=(\d+)/, perf, -1),
      nonBgPixels: num(/nonBgPixels=(\d+)/, done, -1),
      frameErrors: num(/frameErrors=(\d+)/, done, -1),
      endToEndMs: loadMs,
    },
    physics: {
      stepAvgMs: stepMatch ? Number(stepMatch[1]) : -1,
    },
    logic: {
      soakPassed: /ALL PASS/.test(soak.out),
      frames: num(/frames=(\d+)/, soakPerfLine, -1),
      avgLogicMs: num(/avgLogicMs=([\d.]+)/, soakPerfLine, -1),
      maxLogicMs: num(/maxLogicMs=([\d.]+)/, soakPerfLine, -1),
      actorsInitial: num(/actorsInitial=(\d+)/, soakPerfLine, -1),
      actorsMax: num(/actorsMax=(\d+)/, soakPerfLine, -1),
      actorsFinal: num(/actorsFinal=(\d+)/, soakPerfLine, -1),
    },
    existingBenchmarks: {
      fieldsTickAvgMs: num(/fieldsMs=([\d.]+)/, fieldsLine, -1),
      physicsTickAvgMs: num(/physicsMs=([\d.]+)/, fieldsLine, -1),
      aiTickAvgMs: num(/aiMs=([\d.]+)/, fieldsLine, -1),
      updateMedMs: num(/updateMedMs=([\d.]+)/, fieldsLine, -1),
    },
  };

  console.log("");
  console.log("---------- 场景规模 ----------");
  console.log(`  地图        : ${metrics.scene.name}  tile=${metrics.scene.tileSize}`);
  console.log(`  对象 / 精灵 / 碰撞体: ${metrics.scene.objects} / ${metrics.scene.sprites} / ${metrics.scene.colliders}`);
  console.log(`  NPC / 车辆   : ${metrics.scene.npcs} / ${metrics.scene.vehicles}`);
  console.log(`  建筑/楼层/区域: ${metrics.scene.buildings} / ${metrics.scene.floors} / ${metrics.scene.zones}`);
  console.log(`  垂直连接 / 路网: ${metrics.scene.navLinks} / ${metrics.scene.roadNodes}节点+${metrics.scene.roadEdges}路段`);
  console.log("");
  console.log("---------- 渲染（960×540，真实 GL，离屏） ----------");
  console.log(`  平均显示耗时 : ${metrics.render.avgDisplayMs} ms`);
  console.log(`  glBegin/帧   : ${metrics.render.glBeginsPerFrame}`);
  console.log(`  drawCall/帧  : ${metrics.render.drawCallsPerFrame}`);
  console.log(`  非背景像素   : ${metrics.render.nonBgPixels} (${((metrics.render.nonBgPixels / (960 * 540)) * 100).toFixed(1)}%)`);
  console.log(`  帧错误       : ${metrics.render.frameErrors}`);
  console.log(`  端到端耗时   : ${metrics.render.endToEndMs} ms（含生成+打包+渲染）`);
  console.log("");
  console.log("---------- 逻辑 / 物理 ----------");
  console.log(`  逻辑平均帧耗时: ${metrics.logic.avgLogicMs} ms` +
    `（soak ${metrics.logic.frames} 帧，${metrics.logic.soakPassed ? "通过" : "失败"}）`);
  console.log(`  逻辑最慢单帧  : ${metrics.logic.maxLogicMs} ms`);
  console.log(`  实体数 初始/峰值/结束: ${metrics.logic.actorsInitial} / ${metrics.logic.actorsMax} / ${metrics.logic.actorsFinal}`);
  console.log(`  物理 step 平均: ${metrics.physics.stepAvgMs} ms（200 动态体，ScriptPhysicsTest 口径）`);
  console.log(`  场/物理/感知  : ${metrics.existingBenchmarks.fieldsTickAvgMs} / ${metrics.existingBenchmarks.physicsTickAvgMs} / ${metrics.existingBenchmarks.aiTickAvgMs} ms`);
  console.log("");

  if (JSON_OUT) {
    writeFileSync(resolve(ROOT, JSON_OUT), JSON.stringify(metrics, null, 2) + "\n", "utf8");
    console.log(`机读结果已写入: ${resolve(ROOT, JSON_OUT)}`);
  }
  // 退出码：只要有帧错误或渲染没出像素就算失败（防止"跑完就算过"）
  const ok = metrics.render.frameErrors === 0 && metrics.render.nonBgPixels > 0 && metrics.logic.soakPassed;
  console.log(ok ? "✅ 基准有效（帧错误 0、画面有像素、soak 通过）" : "❌ 基准无效（见上）");
  process.exit(ok ? 0 : 1);
}

main();
