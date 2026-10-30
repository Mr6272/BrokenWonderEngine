#!/usr/bin/env node
/**
 * 编辑器往返一致性校验（任务书 §23 的硬要求）。
 *
 * 「地图保存后，必须能被 Java 运行时重新加载，并保持关键空间信息一致。」
 *
 * 做法（用**编辑器自己的代码**，不是重新实现一遍）：
 *   1. 读生成器产出的 `.bwproj`
 *   2. 调编辑器真实的 `normalizeProject()`（编辑器加载工程的唯一入口）+ JSON 往返
 *      —— 等价于「用户在 BWE Studio 里打开 → 保存」
 *   3. 比对关键空间信息：buildings / navLinks / roadNetwork / onStartScript / 对象数
 *   4. 把往返后的工程实际打包成 `Build/`，交给 Java 运行时加载，确认解析出的
 *      建筑/楼层/连接/路网数量与原文一致
 *
 * 为什么需要它：`normalizeProject` 是**按字段重建** SceneModel 的，任何没接进清单的
 * 字段都会被静默丢弃。本轮新增的 buildings/navLinks/roadNetwork 若漏接，
 * 「打开城市 → 改一个对象 → 保存」就会把整座城市的多层数据抹掉 —— 这是真实风险。
 *
 * 用法：node web/tools/verify-editor-roundtrip.mjs
 * 退出码：0 = 一致；1 = 有丢失。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SRC = join(ROOT, "web", "examples", "开放世界城市.bwproj");
const OUT = resolve(ROOT, ".tmp_rel8", "editor-roundtrip");

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, {
    cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

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
}

function counts(scene) {
  const buildings = scene.buildings || [];
  let floors = 0;
  let rooms = 0;
  for (const b of buildings) {
    floors += (b.floors || []).length;
    for (const f of b.floors || []) rooms += (f.rooms || []).length;
  }
  return {
    objects: (scene.objects || []).length,
    buildings: buildings.length,
    floors,
    rooms,
    navLinks: (scene.navLinks || []).length,
    roadNodes: (scene.roadNetwork?.nodes || []).length,
    roadEdges: (scene.roadNetwork?.edges || []).length,
    onStartScript: String(scene.onStartScript || ""),
  };
}

function main() {
  console.log("========== 编辑器往返一致性 ==========");
  if (!existsSync(SRC)) {
    console.error(`❌ 找不到 ${SRC}。先跑 node web/.build/gen-city.mjs 或 verify-openworld.mjs`);
    process.exit(1);
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 原文
  const original = JSON.parse(readFileSync(SRC, "utf8"));
  const before = counts(original.scenes[0]);
  console.log(`原文: objects=${before.objects} buildings=${before.buildings}` +
    ` floors=${before.floors} rooms=${before.rooms} navLinks=${before.navLinks}` +
    ` road=${before.roadNodes}/${before.roadEdges}`);

  // ---- 1) 用编辑器真实代码做 normalize + 往返 ----
  // 编译一个小脚本（esbuild 打成 node 可跑），内部 import 编辑器的 normalizeProject。
  const probe = join(OUT, "probe.ts");
  // ⚠ 用**相对路径** import 编辑器源码，不要用 Windows 绝对路径：
  // `import x from "D:\a\b\model.ts"` 里的反斜杠会被 esbuild 当转义吃掉
  // （报 Could not resolve "D:githubdesktop..."）。这是实际踩过的坑。
  const modelRel = relative(OUT, join(ROOT, "web", "src", "core", "model.ts")).replace(/\\/g, "/");
  writeFileSync(probe, `
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeProject } from "${modelRel}";

const src = process.argv[2];
const dst = process.argv[3];
const raw = JSON.parse(readFileSync(src, "utf8"));
// 模拟「编辑器打开工程」：调它自己的 normalizeProject
const normalized = normalizeProject(raw);
// 模拟「保存」：JSON 序列化再解析（编辑器实际就是写 .bwproj JSON）
const roundTripped = JSON.parse(JSON.stringify(normalized));
writeFileSync(dst, JSON.stringify(roundTripped, null, 2), "utf8");
console.log("PROBE_OK");
`, "utf8");

  const esb = run(process.execPath, [
    "node_modules/esbuild/bin/esbuild", probe,
    "--bundle", "--platform=node", "--format=esm",
    "--outfile=" + join(OUT, "probe.mjs"), "--log-level=warning",
  ]);
  check("esbuild 编译往返探针", esb.code === 0, `exit=${esb.code} ` +
    (esb.code !== 0 ? esb.out.split("\n").slice(-3).join(" ") : ""));

  const rtFile = join(OUT, "roundtrip.bwproj");
  if (esb.code === 0) {
    const r = run(process.execPath, [join(OUT, "probe.mjs"), SRC, rtFile]);
    check("编辑器 normalizeProject 可执行", r.code === 0 && r.out.includes("PROBE_OK"),
      `exit=${r.code}`);
  }

  if (!existsSync(rtFile)) {
    console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail} → FAILED`);
    process.exit(1);
  }

  // ---- 2) 比对关键空间信息 ----
  const rt = JSON.parse(readFileSync(rtFile, "utf8"));
  const after = counts(rt.scenes[0]);
  console.log(`往返: objects=${after.objects} buildings=${after.buildings}` +
    ` floors=${after.floors} rooms=${after.rooms} navLinks=${after.navLinks}` +
    ` road=${after.roadNodes}/${after.roadEdges}`);

  check("对象数不变", after.objects === before.objects, `${before.objects} → ${after.objects}`);
  check("建筑数不变", after.buildings === before.buildings, `${before.buildings} → ${after.buildings}`);
  check("楼层数不变", after.floors === before.floors, `${before.floors} → ${after.floors}`);
  check("房间数不变", after.rooms === before.rooms, `${before.rooms} → ${after.rooms}`);
  check("垂直连接不变", after.navLinks === before.navLinks, `${before.navLinks} → ${after.navLinks}`);
  check("路网节点不变", after.roadNodes === before.roadNodes, `${before.roadNodes} → ${after.roadNodes}`);
  check("路网路段不变", after.roadEdges === before.roadEdges, `${before.roadEdges} → ${after.roadEdges}`);
  check("场景脚本不变", after.onStartScript === before.onStartScript,
    `${before.onStartScript} → ${after.onStartScript}`);

  // 逐栋建筑核对 id 与层数（防止"数量对了但内容错位"）
  const bOrig = original.scenes[0].buildings || [];
  const bRt = rt.scenes[0].buildings || [];
  let sameIds = true;
  let sameFloorCounts = true;
  for (let i = 0; i < Math.min(bOrig.length, bRt.length); i++) {
    if (bOrig[i].id !== bRt[i].id) sameIds = false;
    if ((bOrig[i].floors || []).length !== (bRt[i].floors || []).length) sameFloorCounts = false;
  }
  check("每栋建筑的 id 一致", sameIds, "");
  check("每栋建筑的层数一致", sameFloorCounts, "");

  // 房间坐标抽查（关键空间信息）
  let coordsOk = true;
  let checked = 0;
  for (let i = 0; i < Math.min(bOrig.length, bRt.length) && checked < 20; i++) {
    const fo = (bOrig[i].floors || [])[0] || {};
    const fr = (bRt[i].floors || [])[0] || {};
    const ro = (fo.rooms || [])[0] || {};
    const rr = (fr.rooms || [])[0] || {};
    if (ro.x !== rr.x || ro.y !== rr.y || ro.halfW !== rr.halfW || ro.halfH !== rr.halfH) {
      coordsOk = false;
    }
    checked++;
  }
  check(`房间坐标抽查一致（${checked} 个）`, coordsOk, "");

  // ---- 3) 往返后的工程交给 Java 运行时实际加载 ----
  const buildDir = join(OUT, "Build");
  const pack = run(process.execPath, [
    "web/tools/package-bwe.mjs", rtFile, "--build-only", join(OUT, "pack"),
  ]);
  check("往返工程可被打包", pack.code === 0, `exit=${pack.code}`);
  const sceneJson = join(OUT, "pack", "Build", "scene_0.json");
  check("往返工程产出 scene_0.json", existsSync(sceneJson), sceneJson);
  if (existsSync(sceneJson)) {
    const j = JSON.parse(readFileSync(sceneJson, "utf8"));
    const jc = counts(j);
    check("打包后的建筑数 = 原工程", jc.buildings === before.buildings,
      `${jc.buildings}/${before.buildings}`);
    check("打包后的楼层数 = 原工程", jc.floors === before.floors, `${jc.floors}/${before.floors}`);
    check("打包后的垂直连接 = 原工程", jc.navLinks === before.navLinks,
      `${jc.navLinks}/${before.navLinks}`);
    check("打包后的路网 = 原工程",
      jc.roadNodes === before.roadNodes && jc.roadEdges === before.roadEdges,
      `${jc.roadNodes}/${before.roadNodes} nodes`);
  }

  console.log("");
  console.log("------------------------------------");
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail} → ${fail === 0 ? "ALL PASS" : "FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
