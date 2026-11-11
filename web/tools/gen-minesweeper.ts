/**
 * 扫雷 Minesweeper · BWE Studio 工程生成器。
 *
 * 素材（全部由 `tools/gen-minesweeper-assets-code.mjs` 用代码合成，无任何外部来源）：
 *   - ms-tile / ms-flag / ms-mine：32×32 像素素材，画在内存里再编码成 PNG
 *   - ms-bg.jpg：竖向渐变背景（内容是 PNG，扩展名沿用工程里的引用）
 *   - ms-flag.wav（插旗，双音上扬）、ms-hit.wav（踩雷，低频冲击）、
 *     ms-bgm.wav（Am-F-C-G 循环，正弦合成）
 *
 * 历史说明：这批素材原先是从仓库外一份委托单子里切出来的（含第三方 BGM），
 * 版权不在本仓库，不能随 MIT 发布。现已全部换成程序生成的版本，
 * 切图脚本 `gen-minesweeper-assets.mjs` 一并删除。
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
  // 地图 64×64 瓦片 = 2048×2048 世界像素：必须容得下最大棋盘（64×64 格 × 32px）。
  // 棋盘比地图大的话，Android 双指平移会被引擎按地图范围钳死，边缘格子永远拖不到。
  const scene = createScene("扫雷 · Minesweeper", 64, 64);
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
  const bgK = Math.max(2048 / BG_SRC_W, 2048 / BG_SRC_H);
  objAt("背景 BG", "PROP", 1024, 1024,
    BG_SRC_W * bgK / 2, BG_SRC_H * bgK / 2, 0, 0, "ms-bg", ["prop", "bg"], bgK, bgK);

  // 棋盘（内置 game.minesweeper 模块）
  // 棋盘放地图正中；世界尺寸由脚本按行列重算（fitBoard 只改 props.w/h 元数据，不动素材）。
  const board = objAt("棋盘 Minesweeper", "PROP", 1024, 1024, 64 * 32 / 2, 64 * 32 / 2, 1, 5, "ms-tile", ["prop", "minesweeper"], 1, 1);
  board.modules = [{
    defId: "game.minesweeper",
    label: "扫雷棋盘",
    trigger: "ALWAYS",
    enabled: true,
    collapsed: false,
    values: {
      rows: "64",
      cols: "64",
      mines: "640",
      cellSize: "32",
      mode: "普通 Normal",
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
    // ---- 标题 / 状态 ----
    bgTitle: "扫雷 · Minesweeper",
    bgTitleComplex: "扫雷 · 复雷加殊 Complexweeper",
    bgTips: "左键翻开 · 右键插旗 · 点笑脸重开",
    labelMines: "剩余雷数",
    labelTime: "用时",
    // ---- 步进器（横屏用「行 Rows」全名，竖屏自动取空格前的短名）----
    labelRows: "行 Rows",
    labelCols: "列 Cols",
    labelMineCount: "雷 Mines",
    // ---- 按钮 ----
    labelNewGame: "新游戏",
    labelRestart: "重开",
    labelModeNormal: "模式：普通",
    labelModeComplex: "模式：复雷",
    labelHelp: "帮助",
    labelClose: "关闭",
    labelResetView: "复位视角",
    // ---- 读数 / 范围提示 ----
    labelRange: "行 5–64 · 列 5–64 · 雷 1–(行×列−9) · 点数值可直接输入 · 大棋盘靠平移浏览",
    labelRangeComplex: "复雷加殊：点数字连锁翻开需①旗数正确 ②虚实比例正确",
    // ---- 顶带状态行 / 胜负横幅（两组键互不覆盖）----
    labelWinStatus: "恭喜！全部安全格已翻开",
    labelLoseStatus: "踩到雷了，按笑脸或「新游戏」重开",
    labelWin: "✓ 通关！",
    labelLose: "✗ 踩雷了",
    labelRestartHint: "点笑脸 / 新游戏 再来一局",
    // ---- 帮助面板 ----
    helpTitle: "扫雷玩法",
    help1: "翻开：点一下未翻开的格子；数字表示周围 8 格里有几颗雷。",
    help2: "插旗：手机上长按格子（电脑右键）标雷，剩余雷数跟着减。",
    help3: "连锁：点已翻开的数字格，旗数与数字对齐时把周围一次翻开。",
    help4: "首击必安全：第一下永远不是雷；翻开全部安全格即通关。",
    help5: "复雷加殊：雷有虚实（+1/−1/+i/−i），数字是周围雷之和的模长，连锁翻开还要求旗的虚实比例也对。",
    help6: "手机：双指缩放画面、双指拖动平移；点数值框可直接键入行列雷数。",
    // ---- 手机安全边距：不在这里写死，脚本按横/竖屏自动取默认值
    //（safeTop：竖屏 8 / 横屏 0；safeBottom：竖屏 14 / 横屏 8）。
    // 需要微调时在编辑器里给「HUD 配置」加 safeTop / safeBottom 两个 prop。
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
  // 打包方向写死：地图改成 64×64 正方形后，靠宽高比推断会把两份工程都判成横屏。
  p.orientation = "landscape";
  p.author = "BWE";
  p.tileSize = 32;
  p.gridW = 64;
  p.gridH = 64;
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
  pp.orientation = "portrait";
  pp.gridW = 64;
  pp.gridH = 64;
  const psc = pp.scenes[0];
  // 竖屏地图同样 64×64 瓦片：棋盘必须整盘都能拖到，地图不能比棋盘小。
  (psc as any).widthTiles = 64;
  (psc as any).heightTiles = 64;
  for (const o of psc.objects) {
    if (o.name === "背景 BG") {
      // 竖屏 540×960 屏：素材原尺寸 1:1 铺满，零缩放
      const k2 = Math.max(540 / 540, 960 / 960);
      o.x = 1024; o.y = 1024;
      o.halfW = 540 * k2 / 2; o.halfH = 960 * k2 / 2;
      o.scaleX = k2; o.scaleY = k2;
      o.props = { ...o.props, w: String(540 * k2), h: String(960 * k2) };
    }
    if (o.name === "棋盘 Minesweeper") {
      o.x = 1024; o.y = 1024;
      // 64 格 × 32px = 2048（脚本 fitBoard 会按实际行列/格子重算这两个元数据）
      o.props = { ...o.props, w: "2048", h: "2048" };
      // 竖屏**不再行列互换**：上线规格就是 64×64。
      // 旧的 16×12 配 640 雷会被引擎钳成「几乎每格都是雷」，直接不可玩。
    }
  }
  const outPortrait = join(dirname(OUT), "扫雷-竖屏.bwproj");
  writeFileSync(outPortrait, JSON.stringify(pp, null, 2) + NL, "utf8");
  console.log("[gen-minesweeper] wrote " + outPortrait + "  (竖屏地图 64×64)");
}

main();
