#!/usr/bin/env node
/**
 * 2D 光照系统的**端到端**验收（本机真跑，不是断言清单）。
 *
 * 覆盖整条链路（与用户点「预览/打包」完全同一条路径）：
 *   手工构造带光照的 .bwproj → `package-bwe --build-only` 导出 Build/ → Java 运行时
 *   → `OffscreenFrameDump` 离屏 GL 真画 → 读 framebuffer 像素 → 断言"灯下更亮、远角更暗、墙后不透光"
 *
 * 为什么必须有这一层：
 *   光照最容易出的问题是「数学对、但画不出来」或「画出来把其它东西全压黑」。
 *   这类问题只有真的走完"编辑器数据 → 导出 JSON → 运行时 → 真实像素"才抓得住。
 *   历史事故（`docs/open-world-engine-audit.md`）：`props.color` 没被读 ⇒ 整城画成灰板，
 *   而所有"对象还在、不崩、drawCall 正常"的断言全绿。
 *
 * 用法：
 *   node web/tools/verify-lighting-e2e.mjs              # 全量
 *   node web/tools/verify-lighting-e2e.mjs --keep       # 保留中间产物
 *   node web/tools/verify-lighting-e2e.mjs --frames 40
 *
 * 退出码：0 = 全部通过；1 = 有失败项；2 = 环境不具备（缺 JDK 17~25 / 缺渲染能力），打印 SKIP。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "../../desktop/lib/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const args = process.argv.slice(2);
const readArg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const FRAMES = Number(readArg("--frames", "40"));
const KEEP = args.includes("--keep");
const OUT = resolve(ROOT, ".tmp_light_e2e");
const CLS = resolve(OUT, "classes");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? "  [" + detail + "]" : ""}`);
  } else {
    fail++;
    failures.push(name + (detail ? `  [${detail}]` : ""));
    console.log(`  FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`);
  }
  return ok;
}

/** JDK 17~25（JDK 26 删了 java.applet，JOGL 2.1 必崩）。与 package-bwe.mjs 同一纪律。 */
function resolveJdk() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, "bin", "java.exe"));
  for (const base of [
    "C:\\Program Files\\Microsoft",
    "C:\\Program Files\\Java",
    "C:\\Program Files\\Eclipse Adoptium",
  ]) {
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base)) candidates.push(join(base, dir, "bin", "java.exe"));
  }
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const r = spawnSync(c, ["-version"], { encoding: "utf8", windowsHide: true });
    const m = /version "(\d+)/.exec(String(r.stderr || "") + String(r.stdout || ""));
    if (m && Number(m[1]) >= 17 && Number(m[1]) <= 25) return c;
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
  return { code: r.status ?? -1, out: String(r.stdout ?? ""), err: String(r.stderr ?? "") };
}

/** 编译全仓运行时到本工具自己的目录（**不复用** .tmp_build/bin 的旧 class）。 */
function compileRuntime(jdk) {
  const javac = join(dirname(jdk), "javac.exe");
  if (!existsSync(javac)) return { code: -1, out: "", err: "找不到 javac（应与 java 同目录）" };
  mkdirSync(CLS, { recursive: true });
  const srcs = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".java")) srcs.push(p);
    }
  };
  walk(resolve(ROOT, "src"));
  return run(javac, ["-d", CLS, "-encoding", "utf-8", "-cp", "lib/*", ...srcs]);
}

let seq = 0;
function uid(prefix) {
  seq++;
  return `${prefix}_${seq}`;
}

/** 造对象的统一工厂：字段必须与 `SceneObject` 完全一致，否则导出 JSON 会缺键。 */
function obj(kind, x, y, extra) {
  return {
    id: uid(kind.toLowerCase()),
    name: "",
    kind,
    x,
    y,
    z: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    halfW: 0,
    halfH: 0,
    layerId: "ground",
    visible: true,
    locked: false,
    assetId: "",
    animMode: "默认",
    animFps: 8,
    modules: [],
    props: {},
    tags: [],
    parentId: null,
    ...(extra || {}),
  };
}

/**
 * 「夜巷」验收工程（20×15 tile = 640×480 世界像素，与视口 1:1，像素断言最好算）。
 *
 * 布局（世界像素）：
 *   ┌──────────────────────────────┐  y=0
 *   │  ●L1(96,96)      墙x=320  ●L2(544,96) │
 *   │        ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓      │  墙：x∈[312,328]，y∈[96,384]
 *   │                              │
 *   │  ▲远角(32,32)        ▲(560,440) │
 *   └──────────────────────────────┘  y=480
 */
function makeProject(lightingEnabled) {
  seq = 0;
  const project = {
    format: 1,
    name: "光照验收 · 夜巷",
    author: "BWE",
    tileSize: 32,
    gridW: 20,
    gridH: 15,
    scenes: [],
    assets: [],
    prefabs: [],
    packs: [],
    scripts: {},
    variables: {},
    masterVolume: 0.8,
  };
  const scene = {
    id: "scene_light",
    name: "夜巷 Night Alley",
    originX: 0,
    originY: 0,
    widthTiles: 20,
    heightTiles: 15,
    layers: [
      { id: "ground", name: "地面", visible: true, locked: false, order: 0 },
      { id: "wall", name: "墙", visible: true, locked: false, order: 1 },
      { id: "light", name: "光", visible: true, locked: false, order: 2 },
    ],
    objects: [],
    onStartScript: "",
    bgmAssetId: "",
  };
  const W = 640;
  const H = 480;

  // 地面：一整块中性灰（props.color → 运行时 drawFallback 读它）。灰度是关键：
  // 后面用像素亮度比较，颜色越中性越好判。用 #808080 会因 0x80=128 → 亮度 128，好算。
  scene.objects.push(
    obj("TILE", W / 2, H / 2, {
      name: "地面",
      layerId: "ground",
      props: { w: String(W), h: String(H), color: "#808080" },
    }),
  );

  // 遮挡墙（竖的，穿过整个画面中部）
  scene.objects.push(
    obj("PROP", 320, 240, {
      name: "竖墙",
      layerId: "wall",
      props: { w: "16", h: "288", color: "#c8c8c8" },
      tags: ["wall", "occluder"],
      z: 20,
    }),
  );

  // 两盏灯
  scene.objects.push(
    obj("LIGHT", 96, 96, {
      name: "路灯左",
      layerId: "light",
      props: {
        lightRadius: "200",
        lightColor: "#FFC978",
        lightIntensity: "1.4",
        lightType: "point",
        lightShadow: "1",
      },
      z: 25,
    }),
  );
  scene.objects.push(
    obj("LIGHT", 544, 96, {
      name: "路灯右",
      layerId: "light",
      props: {
        lightRadius: "200",
        lightColor: "#80CCFF",
        lightIntensity: "1.4",
        lightType: "point",
        lightShadow: "1",
      },
      z: 25,
    }),
  );

  // 模块形式的光（验 `render.light` 模块参数回退路径；它放在左下、远离两盏灯）
  scene.objects.push(
    obj("PROP", 96, 400, {
      name: "火把",
      layerId: "light",
      props: { color: "#ff8844", w: "16", h: "16" },
      modules: [
        {
          defId: "render.light",
          label: "",
          trigger: null,
          values: { radius: "150", color: "#FF8844", strength: "1", flicker: "true" },
          enabled: true,
          collapsed: false,
        },
      ],
      z: 22,
    }),
  );

  scene.lighting = {
    enabled: lightingEnabled,
    mode: "both",
    ambientColor: "#202A3C",
    ambientIntensity: 0.22,
    darkness: 0.35,
    softness: 16,
    texelsPerPixel: 0.25,
    dynamicFps: 15,
    maxDynamicLights: 8,
  };
  project.scenes = [scene];
  return project;
}

function writeProject(name, project) {
  const p = join(OUT, name);
  writeFileSync(p, JSON.stringify(project, null, 2) + "\n", "utf8");
  return p;
}

/** 与用户点「预览」走同一条导出链路（命令行模式）。 */
function exportBuild(bwproj, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const r = run(process.execPath, ["web/tools/package-bwe.mjs", bwproj, "--build-only", outDir]);
  return r;
}

/** 跑离屏渲染（`--fit` = 整图 contain，640×480 世界 → 640×480 视口，1:1 最省事）。 */
function offscreen(jdk, bootFile, prefix, w, h) {
  return run(jdk, [
    "-cp",
    `${CLS};lib/*`,
    "-Djava.library.path=lib",
    "--enable-native-access=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
    "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED",
    "Studio.runtime.OffscreenFrameDump",
    bootFile,
    prefix,
    String(FRAMES),
    String(w),
    String(h),
    "--fit",
  ]);
}

function px(img, x, y) {
  const o = (y * img.width + x) * img.channels;
  return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]];
}

function luma(c) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function countNonBg(img) {
  const bg = px(img, 0, 0);
  let n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = px(img, x, y);
      if (Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 6) n++;
    }
  }
  return n;
}

async function main() {
  console.log("========== BWE 2D 光照 · 端到端验收 ==========");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const jdk = resolveJdk();
  if (!jdk) {
    console.log("SKIP  找不到 JDK 17~25（JDK 26 上 JOGL 2.1 必崩），无法跑像素验收");
    console.log("      先跑: .\\tools\\bwe.ps1 build");
    process.exit(2);
  }
  console.log(`  JDK: ${jdk}`);

  // ⚠ 这里**自己编译**到自己的目录，不复用 `.tmp_build/bin`。
  //
  // 这条纪律是踩出来的：第一版复用了 `.tmp_build/bin`，那是几天前别人跑过 build 留下的
  // 旧 class —— 里面根本没有 **Lighting**，于是「导出数据全对、像素一模一样」，
  // 看起来像"光照没生效"，实际是被测对象压根不是新代码。
  // 验证工具必须自己产出被测物：否则它验的是历史遗留物，不是本次改动。
  const c = compileRuntime(jdk);
  check(
    "运行时编译通过（含新增光照类）",
    c.code === 0,
    c.code !== 0 ? (c.err || c.out).split("\n").slice(0, 6).join(" | ") : "",
  );
  if (c.code !== 0) return finish();

  // ---------- 1) 两个工程（开灯 / 关灯） ----------
  const onProj = makeProject(true);
  const offProj = makeProject(false);
  const onBwproj = writeProject("night-on.bwproj", onProj);
  const offBwproj = writeProject("night-off.bwproj", offProj);

  const buildOn = join(OUT, "build-on");
  const buildOff = join(OUT, "build-off");
  const gOn = exportBuild(onBwproj, buildOn);
  check("导出开灯工程", gOn.code === 0, gOn.code === 0 ? "" : (gOn.out + gOn.err).split("\n").slice(-4).join(" | "));
  const gOff = exportBuild(offBwproj, buildOff);
  check("导出关灯工程", gOff.code === 0, gOff.code === 0 ? "" : (gOff.out + gOff.err).split("\n").slice(-4).join(" | "));

  const bootOn = join(buildOn, "Build", "boot.json");
  const bootOff = join(buildOff, "Build", "boot.json");
  if (!existsSync(bootOn) || !existsSync(bootOff)) {
    check("两个 boot.json 都在", false);
    return finish();
  }

  // ---------- 2) 导出数据完整性 ----------
  const sceneOn = JSON.parse(readFileSync(join(buildOn, "Build", "scene_0.json"), "utf8"));
  const sceneOff = JSON.parse(readFileSync(join(buildOff, "Build", "scene_0.json"), "utf8"));
  check("scene_0.json 带 lighting 段", !!sceneOn.lighting, JSON.stringify(sceneOn.lighting ?? null).slice(0, 60));
  check("lighting.enabled 导出为 true", sceneOn.lighting?.enabled === true);
  check("关灯工程的 enabled 导出为 false", sceneOff.lighting?.enabled === false);
  check(
    "lighting 全套字段都在（mode/ambientColor/ambientIntensity/darkness/softness/texelsPerPixel/dynamicFps/maxDynamicLights）",
    ["mode", "ambientColor", "ambientIntensity", "darkness", "softness", "texelsPerPixel", "dynamicFps", "maxDynamicLights"].every(
      (k) => sceneOn.lighting?.[k] !== undefined,
    ),
    Object.keys(sceneOn.lighting ?? {}).join(","),
  );
  const lightObjs = (sceneOn.objects ?? []).filter((o) => o.kind === "LIGHT");
  check("导出保留 2 个 LIGHT 对象", lightObjs.length === 2, `n=${lightObjs.length}`);
  check(
    "LIGHT 的 props 原样透传（lightRadius/lightColor/lightIntensity/lightType/lightShadow）",
    lightObjs.every((o) => o.props && o.props.lightRadius && o.props.lightColor && o.props.lightIntensity),
    lightObjs.map((o) => o.props?.lightRadius).join("/"),
  );
  const wallObj = (sceneOn.objects ?? []).find((o) => o.name === "竖墙");
  check("遮挡体 tags 保留", !!wallObj && wallObj.tags.includes("wall"));
  const torchObj = (sceneOn.objects ?? []).find((o) => o.name === "火把");
  check("render.light 模块保留（含参数）", !!torchObj && (torchObj.modules ?? []).some((m) => m.def === "render.light" && m.params?.radius));

  // ---------- 3) 离屏渲染 ----------
  const onPrefix = join(OUT, "frame-on");
  const offPrefix = join(OUT, "frame-off");
  const rOn = offscreen(jdk, bootOn, onPrefix, 640, 480);
  check("离屏渲染（开灯）无帧错误", /frameErrors=0/.test(rOn.out), (rOn.out.match(/frameErrors=\d+/) ?? [""])[0] || rOn.err.slice(0, 80));
  const rOff = offscreen(jdk, bootOff, offPrefix, 640, 480);
  check("离屏渲染（关灯）无帧错误", /frameErrors=0/.test(rOff.out), (rOff.out.match(/frameErrors=\d+/) ?? [""])[0] || rOff.err.slice(0, 80));

  const onPng = onPrefix + ".png";
  const offPng = offPrefix + ".png";
  if (!existsSync(onPng) || !existsSync(offPng)) {
    check("两次渲染都产出了 PNG", false, `${existsSync(onPng)}/${existsSync(offPng)}`);
    return finish();
  }
  const imgOn = decodePng(readFileSync(onPng));
  const imgOff = decodePng(readFileSync(offPng));
  check("两张截图尺寸一致且为 640×480", imgOn.width === 640 && imgOff.width === 640 && imgOn.height === 480, `${imgOn.width}x${imgOn.height}`);
  check("开灯截图有内容（非全黑）", countNonBg(imgOn) > 0.5 * 640 * 480, `${countNonBg(imgOn)} px`);

  // ---------- 4) 像素断言 ----------
  // 世界 = 视口 1:1（--fit 下 640×480 地图铺满 640×480 视口，zoom=1，cam 居中）
  // 屏幕坐标 = 世界坐标（PNG 解码器输出的 rgba 已是「从上到下」行序，y 直接可用）
  const nearL = [96, 140];    // 左灯正下方（灯在 (96,96)，避开灯本身的贴图/色块）
  const nearR = [544, 140];   // 右灯正下方
  // 「最暗角落」= 右下角 (600,440)：三盏灯都够不到 —— 左灯 (96,96) r=200 距它 500+、
  // 右灯 (544,96) r=200 距它 ~350、火把 (96,400) r=150 距它 500+。
  // ⚠ 不要用左下角 (24,460)：火把在 (96,400)，距它只有 96px ⇒ 那其实**是被照亮的区域**，
  //    第一版就是这么写的，于是"远角应该更暗"永远失败（实测 on=112.4 off=128.0 是火把的功劳）。
  const corner = [600, 440];
  const wallBack = [420, 140]; // 墙右侧、且位于左灯方向上的延长线上（左灯的光应被墙截断）

  const a1 = luma(px(imgOn, nearL[0], nearL[1]));
  const b1 = luma(px(imgOff, nearL[0], nearL[1]));
  check("左灯附近：开灯明显更亮", a1 > b1 + 20, `on=${a1.toFixed(1)} off=${b1.toFixed(1)}`);

  const a2 = luma(px(imgOn, nearR[0], nearR[1]));
  const b2 = luma(px(imgOff, nearR[0], nearR[1]));
  check("右灯附近：开灯明显更亮", a2 > b2 + 20, `on=${a2.toFixed(1)} off=${b2.toFixed(1)}`);

  const c1 = luma(px(imgOn, corner[0], corner[1]));
  const c2 = luma(px(imgOff, corner[0], corner[1]));
  check("远角：开灯后被压暗（环境光很暗）", c1 < c2 - 20, `on=${c1.toFixed(1)} off=${c2.toFixed(1)}`);

  const d1 = luma(px(imgOn, wallBack[0], wallBack[1]));
  check("墙后没有被左灯穿透照亮（远低于灯下亮度、且接近环境光）", d1 < a1 - 30, `wallBack=${d1.toFixed(1)} nearL=${a1.toFixed(1)}`);

  check("同一张开灯图：灯下比远角亮得多", Math.min(a1, a2) > c1 + 40, `min(near)=${Math.min(a1, a2).toFixed(1)} far=${c1.toFixed(1)}`);

  // 灰度地板（#808080）在关灯时亮度应接近 128；开灯后灯下应被加光顶亮
  check("关灯时地板是中性灰（≈128）", Math.abs(luma(px(imgOff, 300, 300)) - 128) < 40, `${luma(px(imgOff, 300, 300)).toFixed(1)}`);

  // ---------- 5) 日志 ----------
  const logOn = join(buildOn, "Build", "bwe.log");
  if (existsSync(logOn)) {
    const log = readFileSync(logOn, "utf8");
    check("运行日志无异常（无 Exception/NullPointer/异常）", !/Exception|NullPointer|渲染失败|脚本异常/.test(log), "");
  }

  // 保留两张截图给人看
  const shotDir = join(OUT, "shots");
  mkdirSync(shotDir, { recursive: true });
  writeFileSync(join(shotDir, "README.txt"), `光照验收截图：\nframe-on.png  开灯（lighting.enabled=true）\nframe-off.png 关灯对照\n`, "utf8");

  return finish();
}

function finish() {
  console.log("---------------------------------------");
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail} → ${fail === 0 ? "ALL PASS" : "FAILED"}`);
  if (fail) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  console.log(`中间产物: ${OUT}${KEEP ? "（保留）" : ""}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E 崩溃：", e);
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail + 1} → FAILED`);
  process.exit(1);
});
