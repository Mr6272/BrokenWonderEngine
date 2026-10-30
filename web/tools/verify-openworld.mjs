#!/usr/bin/env node
/**
 * 开放世界端到端验收（本机真跑，不是断言清单）。
 *
 * 覆盖从「生成器 → .bwproj → boot.json → Java 运行时 → 离屏 GL 真实像素」的完整链路：
 * <ol>
 *   <li>跑城市生成器，产出 `web/examples/开放世界城市.bwproj`</li>
 *   <li>打包到 `Build/boot.json` + `scene_0.json` + `Build/scripts/*.js`</li>
 *   <li>校验导出数据完整性（建筑 / 楼层 / 垂直连接 / 路网 / 脚本）</li>
 *   <li>用 `OffscreenFrameDump` 真实渲染 N 帧 → 断言帧错误 0 + 非背景像素达阈值</li>
 *   <li>读 `Build/bwe.log`，断言 8 个新命名空间都真的注册成功、空间/路网数据被解析</li>
 * </ol>
 *
 * 用法：
 *   node web/tools/verify-openworld.mjs               # 全量
 *   node web/tools/verify-openworld.mjs --frames 120  # 渲染帧数
 *   node web/tools/verify-openworld.mjs --keep        # 保留临时产物
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
const KEEP = args.includes("--keep");
const OUT = resolve(ROOT, ".tmp_rel8", "openworld-e2e");
const BIN = resolve(ROOT, ".tmp_build", "bin");

const JDK = resolveJdk();
let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? "  [" + detail + "]" : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`);
  }
  return ok;
}

/**
 * 本机默认 `java` 是 JDK 26，JOGL 2.1 在 JDK 26 上必崩（java.applet 被删）。
 * 必须显式找一个 17~25 的 JDK —— 与 package-bwe.mjs 的 findRuntimeJdk 同一条纪律。
 */
function resolveJdk() {
  const candidates = [
    "C:\\Program Files\\Microsoft\\jdk-25.0.3.9-hotspot\\bin\\java.exe",
    "C:\\Program Files\\Java\\jdk-25\\bin\\java.exe",
    "C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe",
  ];
  if (process.env.JAVA_HOME) {
    candidates.unshift(join(process.env.JAVA_HOME, "bin", "java.exe"));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), err: r.stderr || "" };
}

function main() {
  console.log("========== 开放世界 E2E 验收 ==========");
  console.log(`仓库: ${ROOT}`);
  console.log(`JDK : ${JDK || "(未找到 17~25)"}`);
  console.log("");

  // ---------- 0) 前置 ----------
  if (!JDK) {
    console.error("❌ 找不到 JDK 17~25（JDK 26 上 JOGL 2.1 必崩）。请设置 JAVA_HOME 或安装 JDK 25。");
    process.exit(1);
  }
  if (!existsSync(join(BIN, "Studio", "runtime", "OffscreenFrameDump.class"))) {
    console.error(`❌ 缺少编译产物 ${BIN}。先跑: .\\tools\\bwe.ps1 build`);
    process.exit(1);
  }

  if (!KEEP) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // ---------- 1) 生成器 ----------
  console.log("[1/5] 运行城市生成器");
  const gen = run(process.execPath, [
    "node_modules/esbuild/bin/esbuild",
    "web/tools/gen-city.ts",
    "--bundle", "--platform=node", "--format=esm",
    "--outfile=web/.build/gen-city.mjs", "--log-level=warning",
  ]);
  check("esbuild 编译生成器", gen.code === 0, `exit=${gen.code}`);

  const genRun = run(process.execPath, ["web/.build/gen-city.mjs"]);
  check("生成器执行成功", genRun.code === 0, `exit=${genRun.code}`);
  const bwproj = join(ROOT, "web", "examples", "开放世界城市.bwproj");
  check("产出 .bwproj", existsSync(bwproj), bwproj);

  // ---------- 2) 打包 ----------
  console.log("[2/5] 打包为运行时格式");
  // ⚠ --build-only 的参数是「输出根目录」，Build/ 由它自己在里面建
  // （传 OUT/Build 会变成 OUT/Build/Build/boot.json —— 这是第一版这里报错的真实原因）。
  const pack = run(process.execPath, [
    "web/tools/package-bwe.mjs",
    bwproj,
    "--build-only", OUT,
  ]);
  check("package-bwe 成功", pack.code === 0, `exit=${pack.code} ` +
    (pack.code !== 0 ? pack.out.split("\n").slice(-3).join(" | ") : ""));
  const bootFile = join(OUT, "Build", "boot.json");
  const sceneFile = join(OUT, "Build", "scene_0.json");
  check("boot.json 已生成", existsSync(bootFile), "");
  check("scene_0.json 已生成", existsSync(sceneFile), "");

  // ---------- 3) 数据完整性 ----------
  console.log("[3/5] 校验导出数据完整性");
  let scene = null;
  let boot = null;
  try {
    scene = JSON.parse(readFileSync(sceneFile, "utf8"));
    boot = JSON.parse(readFileSync(bootFile, "utf8"));
  } catch (e) {
    check("导出 JSON 可解析", false, String(e));
  }
  if (scene && boot) {
    check("导出 JSON 可解析", true, "");

    // 对象与地块
    const objs = scene.objects || [];
    check("场景对象 >= 200", objs.length >= 200, `objects=${objs.length}`);
    const kinds = {};
    for (const o of objs) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
    check("含 TILE 地块", (kinds.TILE || 0) > 0, `TILE=${kinds.TILE || 0}`);
    check("含 PROP 物件", (kinds.PROP || 0) > 0, `PROP=${kinds.PROP || 0}`);
    check("含 ZONE 区域标记", (kinds.ZONE || 0) > 0, `ZONE=${kinds.ZONE || 0}`);
    check("含玩家 ACTOR", (kinds.ACTOR || 0) === 1, `ACTOR=${kinds.ACTOR || 0}`);

    // 城市要素齐全（任务书 §15 要求的要素）
    const tagsOf = (needle) => objs.filter((o) => (o.tags || []).includes(needle)).length;
    check("有道路", tagsOf("road") > 0, `road=${tagsOf("road")}`);
    check("有草地", tagsOf("grass") > 0, `grass=${tagsOf("grass")}`);
    check("有广场", tagsOf("plaza") > 0, `plaza=${tagsOf("plaza")}`);
    check("有水体", tagsOf("water") > 0, `water=${tagsOf("water")}`);
    check("有大理石地面", tagsOf("marble") > 0, `marble=${tagsOf("marble")}`);
    check("有雕塑", tagsOf("sculpture") > 0, `sculpture=${tagsOf("sculpture")}`);
    check("有医院", tagsOf("hospital") > 0, `hospital=${tagsOf("hospital")}`);
    check("有建筑外墙", tagsOf("wall") > 0, `wall=${tagsOf("wall")}`);
    check("有屋顶", tagsOf("roof") > 0, `roof=${tagsOf("roof")}`);
    check("有楼梯（垂直连接可视化）", tagsOf("stairs") > 0, `stairs=${tagsOf("stairs")}`);

    // 多层空间数据
    const buildings = scene.buildings || [];
    check("建筑 >= 20", buildings.length >= 20, `buildings=${buildings.length}`);
    let floorsTotal = 0;
    let roomsTotal = 0;
    let roofs = 0;
    let indoorRooms = 0;
    for (const b of buildings) {
      floorsTotal += (b.floors || []).length;
      for (const f of b.floors || []) {
        roomsTotal += (f.rooms || []).length;
        for (const r of f.rooms || []) {
          if ((r.tags || []).includes("roof")) roofs++;
          if ((r.tags || []).includes("indoor")) indoorRooms++;
        }
      }
    }
    check("楼层总数 >= 40", floorsTotal >= 40, `floors=${floorsTotal}`);
    check("房间/区域 >= 60", roomsTotal >= 60, `rooms=${roomsTotal}`);
    check("每个建筑都有屋顶 zone", roofs === buildings.length, `roofs=${roofs}/${buildings.length}`);
    check("有室内区域", indoorRooms >= buildings.length, `indoor=${indoorRooms}`);

    // 垂直连接（楼层隔离的关键）
    const navLinks = scene.navLinks || [];
    check("垂直连接 >= 20", navLinks.length >= 20, `navLinks=${navLinks.length}`);
    const distinctEndpoints = navLinks.filter(
      (l) => Math.abs(l.ax - l.bx) > 0.5 || Math.abs(l.ay - l.by) > 0.5,
    ).length;
    check(
      "每条连接两端点坐标不同（否则上下楼看不出位移）",
      distinctEndpoints === navLinks.length,
      `${distinctEndpoints}/${navLinks.length}`,
    );
    const crossLevel = navLinks.filter((l) => l.aLevel !== l.bLevel).length;
    check("连接跨不同楼层", crossLevel === navLinks.length, `cross=${crossLevel}/${navLinks.length}`);

    // 路网
    const road = scene.roadNetwork || { nodes: [], edges: [] };
    check("路网节点 >= 20", (road.nodes || []).length >= 20, `nodes=${(road.nodes || []).length}`);
    check("路段 >= 40", (road.edges || []).length >= 40, `edges=${(road.edges || []).length}`);
    const intersections = (road.nodes || []).filter((n) => n.kind === "intersection").length;
    check("有路口节点（不只是直线路段）", intersections > 0, `intersections=${intersections}`);

    // 脚本
    const scripts = boot.scripts || [];
    check("导出 2 段 JS 脚本", scripts.length === 2, `scripts=${scripts.length}`);
    check(
      "脚本文件已落盘",
      scripts.every((s) => existsSync(join(OUT, "Build", s.file))),
      scripts.map((s) => s.file).join(","),
    );
    check("场景脚本已指定", String(scene.onStartScript || "").length > 0, scene.onStartScript);
  }

  // 场景里实际用到的不同素材数。
  // 合批只能合并同一张纹理的相邻精灵，所以 glBegin/帧 的下限就是纹理种类数。
  const textureCount = scene
    ? new Set((scene.objects || []).map((o) => o.assetName).filter(Boolean)).size
    : 0;
  console.log("      场景使用贴图种类: " + textureCount);

  // ---------- 4) 真实渲染 ----------
  console.log(`[4/5] 离屏渲染 ${FRAMES} 帧（真实 GL，读 framebuffer）`);
  const rendered = run(JDK, [
    "--enable-native-access=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED",
    "-cp", `${BIN};lib/*`,
    "-Djava.library.path=lib",
    "Studio.runtime.OffscreenFrameDump",
    bootFile,
    join(OUT, "city"),
    String(FRAMES), "960", "540",
  ]);
  const perfLine = (rendered.out.match(/OFFSCREEN_PERF [^\n]+/) || ["(没有 OFFSCREEN_PERF)"])[0];
  const doneLine = (rendered.out.match(/OFFSCREEN_DONE [^\n]+/) || ["(没有 OFFSCREEN_DONE)"])[0];
  check("离屏渲染进程成功", rendered.code === 0, `exit=${rendered.code} ${perfLine}`);

  const frameErrors = Number((doneLine.match(/frameErrors=(\d+)/) || [0, "999"])[1]);
  const nonBg = Number((doneLine.match(/nonBgPixels=(\d+)/) || [0, "0"])[1]);
  const avgMs = Number((perfLine.match(/avgDisplayMs=([\d.]+)/) || [0, "0"])[1]);
  const glBegins = Number((perfLine.match(/glBeginsPerFrame=(\d+)/) || [0, "0"])[1]);
  const drawCalls = Number((perfLine.match(/drawCallsPerFrame=(\d+)/) || [0, "0"])[1]);

  check("渲染帧错误 = 0", frameErrors === 0, `frameErrors=${frameErrors}`);
  // 960x540 = 518400 像素。城市铺满视野时应有大量非背景像素。
  // 阈值取 20%（103680）：留出"相机跟随玩家、视野内主要是地块"的合理余量。
  check("画面非背景像素 >= 20%（真的画出城市了）", nonBg >= 518400 * 0.2, `nonBgPixels=${nonBg}`);
  check("PNG 截图已产出", existsSync(join(OUT, "city.png")), join(OUT, "city.png"));
  check("每帧显示耗时 < 8ms", avgMs > 0 && avgMs < 8, `avgDisplayMs=${avgMs}`);
  // 合批阈值：必须区分「纯色块场景」与「贴图场景」，并承认贴图场景的下限结构。
  //
  // 实测（960×540、272 对象、16 种贴图）：
  //   - 纯色块（无贴图，旧版）：glBegin/帧 = 2，    avgDisplayMs = 1.49
  //   - 像素画贴图（本版）：    glBegin/帧 = 26~27，avgDisplayMs = 1.87~2.17
  //
  // 为什么不是 2~8：合批只能合并**同一张纹理的相邻精灵**；而本场景的地面是
  // 「一个大对象代表一整条路/一整片草地」，靠 UV 平铺（GL_REPEAT）画出砖纹 ——
  // 同类纹理的相邻小块根本不存在，没有可合并对象。26 次 ≈ 16 纹理 + 少量穿插，
  // 是这批数据能做到的下限；相比「每对象一次 glBegin」（272 次）仍是 10 倍减少。
  //
  // 所以主判据是**体感**（avgDisplayMs，上面已断言 < 8ms）；这条只做
  // 「没有退化回逐对象提交」的哨兵：上限 = 纹理数 + 12。
  const maxBegins = Math.max(8, textureCount + 12);
  check(
    `合批未退化（glBegin/帧 <= ${maxBegins}；逐对象提交会是 ${(scene?.objects || []).length}）`,
    glBegins > 0 && glBegins <= maxBegins,
    `glBeginsPerFrame=${glBegins} textures=${textureCount}`,
  );
  // ---------- 5) 运行时日志 ----------
  console.log("[5/5] 校验运行时真的跑起来了");
  const logFile = join(OUT, "Build", "bwe.log");
  let log = "";
  try {
    log = readFileSync(logFile, "utf8");
  } catch {
    check("bwe.log 存在", false, logFile);
  }
  if (log) {
    check("bwe.log 存在", true, "");
    check("脚本引擎启动", /\[脚本\] 已启动/.test(log), "");
    check("场景脚本 onSceneStart 执行", /自由城启动/.test(log), "");
    check("空间索引已建（建筑/区域/连接）", /\[空间\] 已建索引/.test(log), "");
    check("路网已建图", /\[路网\] 已建图/.test(log), "");
    check("初始人口已生成", /初始人口/.test(log), "");
    // 8 个新命名空间的注册不能报错
    const regFail = log.match(/\[脚本\] (scene|spatial|collision|actions|road|vehicle|combat|debug) 注册失败/g);
    check("8 个新命名空间无注册失败", !regFail, regFail ? regFail.join(",") : "");
    // 脚本不能有运行时错误
    const scriptErr = log.match(/\[脚本错误\][^\n]+/g) || [];
    check("无脚本运行时错误", scriptErr.length === 0, scriptErr.slice(0, 2).join(" | "));
    check("无外观/绘制异常", !/draw 异常|update 异常|渲染失败/.test(log), "");
  }

  // ---------- 汇总 ----------
  console.log("");
  console.log("---------- 关键数字 ----------");
  console.log(`  对象数      : ${scene ? (scene.objects || []).length : "?"}`);
  console.log(`  建筑/楼层/区域: ${scene ? (scene.buildings || []).length : "?"} / ${
    scene ? (scene.buildings || []).reduce((a, b) => a + (b.floors || []).length, 0) : "?"
  } / ${scene ? (scene.buildings || []).reduce(
    (a, b) => a + (b.floors || []).reduce((c, f) => c + (f.rooms || []).length, 0), 0) : "?"}`);
  console.log(`  垂直连接    : ${scene ? (scene.navLinks || []).length : "?"}`);
  console.log(`  路网节点/路段: ${scene ? (scene.roadNetwork?.nodes || []).length : "?"} / ${
    scene ? (scene.roadNetwork?.edges || []).length : "?"}`);
  console.log(`  非背景像素  : ${nonBg} / ${960 * 540} (${((nonBg / (960 * 540)) * 100).toFixed(1)}%)`);
  console.log(`  平均显示耗时: ${avgMs} ms   glBegin/帧: ${glBegins}   drawCalls/帧: ${drawCalls}`);
  console.log("");
  console.log("------------------------------------");
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail} → ${fail === 0 ? "ALL PASS" : "FAILED"}`);
  if (fail === 0) {
    console.log(`截图: ${join(OUT, "city.png")}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
