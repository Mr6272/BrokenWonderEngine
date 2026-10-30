/**
 * 扫雷 Minesweeper · BWE Studio 工程生成器。
 *
 * 素材（源自 D:/小红书扫雷单子，由 gen-minesweeper-assets.mjs 切好放本地）：
 *   - ms-tile / ms-flag / ms-mine：像素素材（分割自「旗帜/点开前格子/雷」整图）
 *   - ms-bg.jpg：背景图
 *   - ms-flag.wav（插旗）、ms-hit.wav（踩雷）、ms-bgm.wav（BGM 微风与少年）
 *
 * 文字**不**嵌进像素图：HUD / 计时 / 剩余雷数 / 按钮提示走 `bwe.draw.text`
 * 独立图层；行列在游戏内可调 —— 脚本通过 `bwe.mine.set({rows, cols, mines})`
 * 重建棋盘（Java 侧 ScriptApi.buildMine 新开的命名空间）。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, createScene, createObject, uid } from "../src/core/model.ts";
import type { Project, SceneModel, SceneObject } from "../src/core/model.ts";

const NL = String.fromCharCode(10);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const ASSET_DIR = join(ROOT, "web", "examples", "扫雷", "assets");
const SCRIPT_DIR = join(ROOT, "web", "examples", "扫雷", "scripts");
const OUT = join(ROOT, "web", "examples", "扫雷.bwproj");

// ---------------------------------------------------------------------------
//   素材列表
// ---------------------------------------------------------------------------

function pngDataUrl(path: string): string {
  const b = readFileSync(path);
  return "data:image/png;base64," + b.toString("base64");
}
function jpgDataUrl(path: string): string {
  const b = readFileSync(path);
  return "data:image/jpeg;base64," + b.toString("base64");
}
function wavDataUrl(path: string): string {
  const b = readFileSync(path);
  return "data:audio/wav;base64," + b.toString("base64");
}

function assetEntry(
  name: string, kind: "IMAGE" | "ATLAS" | "AUDIO",
  build: () => string, path: string, note: string
) {
  return {
    id: "as-ms-" + name,
    name,
    kind,
    src: "url" as const,
    url: build(),
    path,
    group: "扫雷",
    note,
  };
}

function buildAssets(): any[] {
  const out: any[] = [];
  const MUST: Array<[string, string, () => string, string]> = [
    ["ms-tile", "IMAGE", () => pngDataUrl(join(ASSET_DIR, "ms-tile.png")), "扫雷/assets/ms-tile.png"],
    ["ms-flag", "IMAGE", () => pngDataUrl(join(ASSET_DIR, "ms-flag.png")), "扫雷/assets/ms-flag.png"],
    ["ms-mine", "IMAGE", () => pngDataUrl(join(ASSET_DIR, "ms-mine.png")), "扫雷/assets/ms-mine.png"],
    ["ms-bg", "IMAGE", () => jpgDataUrl(join(ASSET_DIR, "ms-bg.jpg")), "扫雷/assets/ms-bg.jpg"],
    ["ms-sfx-flag", "AUDIO", () => wavDataUrl(join(ASSET_DIR, "ms-flag.wav")), "扫雷/assets/ms-flag.wav"],
    ["ms-sfx-hit", "AUDIO", () => wavDataUrl(join(ASSET_DIR, "ms-hit.wav")), "扫雷/assets/ms-hit.wav"],
    ["ms-bgm", "AUDIO", () => wavDataUrl(join(ASSET_DIR, "ms-bgm.wav")), "扫雷/assets/ms-bgm.wav"],
  ];
  for (const [name, kind, build, path] of MUST) {
    if (!existsSync(path === "扫雷/assets/ms-bgm.wav" ? join(ASSET_DIR, "ms-bgm.wav") : path.split("/").pop() ? join(ASSET_DIR, path.split("/").pop() as string) : "")) {
      console.error("[gen-minesweeper] 缺素材" + path);
      process.exit(1);
    }
    out.push(assetEntry(name, kind as any, build, path, name));
  }
  return out;
}

// ---------------------------------------------------------------------------
//   场景构建
// ---------------------------------------------------------------------------

function buildScene(assets: any[]): SceneModel {
  const layerNames = ["背景 BG", "棋盘 Board", "HUD HUD", "角色 Actors"];
  const layerIds = layerNames.map(() => uid());
  const layers = layerNames.map((name, i) => ({ id: layerIds[i], name, visible: true, locked: false, order: i }));
  const scene = createScene("扫雷 · Minesweeper", 64, 36);
  scene.layers = layers as any;
  scene.bgmAssetId = "ms-bgm";
  scene.onStartScript = "minesweeper";

  const objAt = (
    name: string, kind: "PROP" | "ZONE", cx: number, cy: number, halfW: number, halfH: number,
    layerIdx: number, z: number, assetName: string, tags: string[], scaleW: number, scaleH: number
  ): SceneObject => {
    const o = createObject(kind, cx, cy);
    o.name = name;
    o.layerId = layerIds[layerIdx];
    o.z = z;
    o.halfW = halfW;
    o.halfH = halfH;
    o.assetName = assetName;
    const asset = assets.find((a) => a.name === assetName);
    if (asset) o.assetId = asset.id;
    o.tags = tags;
    o.scaleX = scaleW;
    o.scaleY = scaleH;
    o.props = { color: "#909090", solid: "0", w: String(halfW * 2), h: String(halfH * 2) };
    scene.objects.push(o);
    return o;
  };

  // 背景
  // 背景：素材真身 540×960（竖构图）。整张地图 2048×1152 是横的，
  // 只能用「统一倍率 cover」铺满（多余部分裁掉），绝不改长宽比。
  //   k = max(2048/540, 1152/960) = 3.793 → 2048 × 3641，上下各裁掉约 1245px。
  const BG_SRC_W = 540, BG_SRC_H = 960;
  const bgK = Math.max(2048 / BG_SRC_W, 1152 / BG_SRC_H);
  objAt("背景 BG", "PROP", 1024, 576,
    BG_SRC_W * bgK / 2, BG_SRC_H * bgK / 2, 0, 0, "ms-bg", ["prop", "bg"], bgK, bgK);

  // 棋盘（内置 game.minesweeper 模块）
  const board = objAt("棋盘 Minesweeper", "PROP", 1024, 600, 28 * 32 / 2, 20 * 32 / 2, 1, 5, "ms-tile", ["prop", "minesweeper"], 1, 1);
  board.modules = [{
    defId: "game.minesweeper",
    label: "扫雷棋盘",
    trigger: "ALWAYS",
    enabled: true,
    collapsed: false,
    values: {
      rows: "12",
      cols: "16",
      mines: "40",
      cellSize: "32",
      winCondition: "清空所有安全格 Clear Safe Cells",
      firstClickSafe: "开",
      rightClickFlag: "开",
      autoOpenZeros: "开",
      revealAllOnLose: "开",
      showTimer: "开",
      seed: "0",
      hiddenAsset: "ms-tile",
      mineAsset: "ms-mine",
      flagAsset: "ms-flag",
    },
  }];


  // ---- HUD 配置对象：所有界面文案与配色都在 props 里，编辑器可改 ----
  // （HUD 走屏幕坐标绘制，所以文字本身不能做成世界坐标对象的 label；
  //   文案/字号/配色集中在这一个对象的 props 里，脚本按它渲染。）
  const hudCfg = createObject("PROP", 0, 0);
  hudCfg.name = "HUD 配置";
  hudCfg.layerId = layerIds[2];
  hudCfg.z = 200;
  hudCfg.tags = ["hud", "hudcfg"];
  hudCfg.props = {
    color: "#00000000", solid: "0",
    bgTitle: "扫雷 · Minesweeper",
    bgTips: "左键翻开 · 右键插旗 · 点笑脸重开",
    labelMines: "剩余雷数",
    labelTime: "用时",
    labelRows: "行 Rows",
    labelCols: "列 Cols",
    labelMineCount: "雷 Mines",
    labelNewGame: "新游戏",
    labelRestart: "重开",
    labelWin: "通关！点笑脸再来一局",
    labelLose: "踩雷了，点笑脸重开",
    labelRange: "行 5–30 · 列 5–30 · 雷 1–(行×列−9)",
    silver: "#c0c0c0",
    silverLight: "#ffffff",
    silverDark: "#808080",
    titleBlue1: "#0a246a",
    titleBlue2: "#2a4b9b",
    ledRed: "#ff0000",
    ledBg: "#1a0000",
    textDark: "#101010",
    fontSize: "15",
  };
  (scene.objects as any).push(hudCfg);
  return scene;
}

// ---------------------------------------------------------------------------
//   main
// ---------------------------------------------------------------------------

function main(): void {
  const p: Project = createProject("BWE 扫雷 · 秋天的旗");
  p.author = "BWE";
  p.tileSize = 32;
  p.gridW = 64;
  p.gridH = 36;
  const assets = buildAssets();
  console.log("[gen-minesweeper] assets " + assets.length +
    " · png " + assets.filter((a) => a.kind === "IMAGE").length +
    " · wav " + assets.filter((a) => a.kind === "AUDIO").length);
  const scene = buildScene(assets);
  p.scenes = [scene];
  p.assets = assets;

  // 脚本
  mkdirSync(SCRIPT_DIR, { recursive: true });
  const srcMs = readFileSync(join(SCRIPT_DIR, "minesweeper.js"), "utf8");
  p.scripts = {
    minesweeper: { name: "minesweeper", file: "scripts/minesweeper.js", source: srcMs, lang: "js" },
  };

  const outDir = dirname(OUT);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(OUT, JSON.stringify(p, null, 2) + "\n", "utf8");
  console.log("[gen-minesweeper] wrote " + OUT);
  console.log("  scene=" + scene.name + " objects=" + scene.objects.length);

  // ---- 竖屏版：同一套素材/脚本，画布 36×64 竖长，HUD 走竖屏分支 ----
  const pp = JSON.parse(JSON.stringify(p)) as Project;
  pp.name = "BWE 扫雷 · 秋天的旗（竖屏）";
  pp.gridW = 36;
  pp.gridH = 64;
  const psc = pp.scenes[0];
  (psc as any).widthTiles = 36;
  (psc as any).heightTiles = 64;
  for (const o of psc.objects) {
    if (o.name === "背景 BG") {
      // 竖屏 540×960 屏：素材原尺寸 1:1 铺满，零缩放
      const k2 = Math.max(540 / 540, 960 / 960);
      o.x = 576; o.y = 1024;
      o.halfW = 540 * k2 / 2; o.halfH = 960 * k2 / 2;
      o.scaleX = k2; o.scaleY = k2;
      o.props = { ...o.props, w: String(540 * k2), h: String(960 * k2) };
    }
    if (o.name === "棋盘 Minesweeper") {
      o.x = 576; o.y = 1024;
      o.props = { ...o.props, w: "896", h: "640" };
    }
  }
  const outPortrait = join(dirname(OUT), "扫雷-竖屏.bwproj");
  writeFileSync(outPortrait, JSON.stringify(pp, null, 2) + NL, "utf8");
  console.log("[gen-minesweeper] wrote " + outPortrait + "  (竖屏 36×64)");
}

main();
