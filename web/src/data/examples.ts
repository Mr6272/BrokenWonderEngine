/**
 * 内置示例工程（.bwproj 里的场景数据）。
 *
 * 为什么示例也走模块：
 *   示例如果只是几张摆好的图，用户学不到"引擎怎么用"。
 *   这里的扫雷和换装都由普通对象 + 玩法模块组成，
 *   行数、列数、地雷数、每个部位的造型都跟正式工程一样在模块参数里改。
 *
 * 素材用内联 SVG（data URL），保证 .bwproj 单文件就能带着图走；
 * 用户随时可以在素材面板里换成自己的 PNG。
 */

import type { AssetEntry, Project } from "../core/model.ts";
import { createProject, createScene, createObject, uid } from "../core/model.ts";
import { makeInstance, moduleDef } from "./modules.ts";
// 两个脚本向示例体量大（100KB+），直接引用 web/examples 下的 .bwproj 本体（esbuild 用 json loader 打进包），
// 保证「菜单里点开的就是磁盘上那份文件」，不会出现代码生成版与 .bwproj 两套数据。
import topDownJsProject from "../../examples/俯视角JS示例.bwproj";
import emergenceProject from "../../examples/涌现沙盘.bwproj";
import vampireProject from "../../examples/吸血鬼幸存者.bwproj";
import lightingProject from "../../examples/2D光照示例.bwproj";
import alienShooterProject from "../../examples/孤胆枪手.bwproj";

// ---------------- 内联素材 ----------------

function svgAsset(name: string, width: number, height: number, body: string, group: string): AssetEntry {
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  return {
    id: uid(),
    name,
    kind: "IMAGE",
    src: "url",
    url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(doc),
    path: name,
    width,
    height,
    group,
    hiddenFrames: [],
    frameDurations: []
  };
}

function assetByName(p: Project, name: string): AssetEntry | undefined {
  return p.assets.find((a) => a.name === name);
}

function withModule(defId: string, values: Record<string, string>): import("../core/model.ts").ModuleInstance {
  const def = moduleDef(defId);
  const inst = def
    ? makeInstance(def)
    : { defId, trigger: null, values: {} as Record<string, string>, enabled: true, collapsed: false };
  Object.assign(inst.values, values);
  inst.collapsed = false;
  return inst;
}

// ---------------- 扫雷 ----------------

function minesweeperAssets(): AssetEntry[] {
  const g = "扫雷示例";
  return [
    svgAsset("扫雷面板", 640, 440, `
      <defs>
        <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#25304a"/><stop offset="1" stop-color="#141a28"/>
        </linearGradient>
        <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#7f93b8"/><stop offset="0.5" stop-color="#5f7299"/><stop offset="1" stop-color="#46567a"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="640" height="440" rx="18" fill="url(#panel)"/>
      <rect x="18" y="18" width="604" height="404" rx="12" fill="#101623" stroke="#34415e" stroke-width="2"/>
      <g opacity="0.16" stroke="#8fa8d8" stroke-width="1">
        ${Array.from({ length: 9 }, (_, i) => `<line x1="${82 + i * 53}" y1="18" x2="${82 + i * 53}" y2="422"/>`).join("")}
      </g>
      <text x="320" y="64" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei" font-size="26" font-weight="700" fill="#dbe7ff">扫 雷</text>
      <text x="320" y="410" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei" font-size="13" fill="#7d90b5">BWE Studio · 模块示例</text>
    `, g),
    svgAsset("地砖-未翻开", 48, 48, `
      <defs>
        <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#8ea4cc"/><stop offset="0.45" stop-color="#677ca6"/><stop offset="1" stop-color="#46587c"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="8" fill="url(#tile)"/>
      <rect x="5" y="5" width="38" height="35" rx="6" fill="none" stroke="#b8c9e8" stroke-opacity="0.45" stroke-width="2"/>
      <rect x="8" y="36" width="32" height="5" rx="2.5" fill="#2e3b58" opacity="0.45"/>
    `, g),
    svgAsset("地雷", 48, 48, `
      <g fill="#141821">
        <circle cx="24" cy="24" r="12"/>
        <rect x="21" y="4" width="6" height="40" rx="3"/>
        <rect x="4" y="21" width="40" height="6" rx="3"/>
        <rect x="9" y="9" width="30" height="30" rx="7" transform="rotate(45 24 24)"/>
      </g>
      <circle cx="24" cy="24" r="9" fill="#2b3244"/>
      <circle cx="20.5" cy="20.5" r="3.2" fill="#aab6d0" opacity="0.7"/>
    `, g),
    svgAsset("旗帜", 48, 48, `
      <rect x="13" y="6" width="3.5" height="36" rx="1.7" fill="#d8def0"/>
      <path d="M16.5 8 L38 14 L16.5 22 Z" fill="#f0525f"/>
      <path d="M16.5 8 L28 11.4 L16.5 14.8 Z" fill="#ff8a92" opacity="0.8"/>
      <rect x="9" y="39" width="20" height="4" rx="2" fill="#6f7d9c"/>
    `, g)
  ];
}

export function createMinesweeperProject(): Project {
  const p = createProject("扫雷示例");
  p.author = "BWE Studio";
  p.tileSize = 32;
  p.gridW = 30;
  p.gridH = 20;
  p.scenes = [createScene("扫雷", 30, 20)];
  p.assets = minesweeperAssets();
  const scene = p.scenes[0];

  const panel = assetByName(p, "扫雷面板");
  const board = createObject("PROP", 480, 320);
  board.name = "扫雷棋盘";
  board.assetId = panel?.id ?? "";
  board.halfW = 300;
  board.halfH = 200;
  board.z = 1;
  board.layerId = scene.layers[1].id;
  board.tags = ["小游戏", "扫雷"];
  board.modules.push(withModule("game.minesweeper", {
    rows: "10",
    cols: "10",
    mines: "10",
    cellSize: "32",
    winCondition: "清空所有安全格 Clear Safe Cells",
    firstClickSafe: "开",
    rightClickFlag: "开",
    autoOpenZeros: "开",
    revealAllOnLose: "开",
    showTimer: "开",
    seed: "0",
    hiddenAsset: "地砖-未翻开",
    mineAsset: "地雷",
    flagAsset: "旗帜"
  }));
  scene.objects.push(board);

  // 把可调项同步到工程变量，脚本和后续运行时也能直接读。
  p.variables = {
    "扫雷.行数": "10",
    "扫雷.列数": "10",
    "扫雷.地雷数": "10",
    "扫雷.格子尺寸": "32"
  };

  return p;
}

// ---------------- 换装 ----------------

function dressupAssets(): AssetEntry[] {
  const g = "换装示例";
  return [
    svgAsset("换装背景", 640, 480, `
      <defs>
        <linearGradient id="room" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#3b3350"/><stop offset="0.55" stop-color="#2b2740"/><stop offset="1" stop-color="#1b1929"/>
        </linearGradient>
        <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#544a70"/><stop offset="1" stop-color="#2a243c"/>
        </linearGradient>
        <radialGradient id="glow" cx="0.5" cy="0.35" r="0.6">
          <stop offset="0" stop-color="#ffe3b8" stop-opacity="0.22"/><stop offset="1" stop-color="#ffe3b8" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="640" height="480" fill="url(#room)"/>
      <rect y="352" width="640" height="128" fill="url(#floor)"/>
      <g stroke="#7f6fa8" stroke-opacity="0.25" stroke-width="1">
        <line x1="0" y1="352" x2="640" y2="352"/>
        <line x1="0" y1="392" x2="640" y2="392"/>
        <line x1="0" y1="436" x2="640" y2="436"/>
      </g>
      <rect x="0" y="0" width="640" height="480" fill="url(#glow)"/>
      <g opacity="0.4">
        <rect x="52" y="72" width="92" height="128" rx="6" fill="#1e1a2c" stroke="#6f5f93" stroke-width="3"/>
        <rect x="496" y="72" width="92" height="128" rx="6" fill="#1e1a2c" stroke="#6f5f93" stroke-width="3"/>
        <path d="M98 200 V264 M542 200 V264" stroke="#6f5f93" stroke-width="4"/>
      </g>
      <ellipse cx="320" cy="438" rx="150" ry="18" fill="#0d0b16" opacity="0.55"/>
      <text x="320" y="46" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei" font-size="20" font-weight="700" fill="#cdbff5" opacity="0.75">试 衣 间</text>
    `, g),
    svgAsset("身体-基础", 120, 220, `
      <ellipse cx="60" cy="40" rx="30" ry="34" fill="#f2c9a0"/>
      <rect x="50" y="66" width="20" height="22" fill="#e7b88a"/>
      <path d="M28 88 Q60 74 92 88 L100 160 Q60 184 20 160 Z" fill="#f2c9a0"/>
      <rect x="35" y="158" width="20" height="56" rx="10" fill="#f2c9a0"/>
      <rect x="65" y="158" width="20" height="56" rx="10" fill="#f2c9a0"/>
      <ellipse cx="46" cy="214" rx="13" ry="6" fill="#e3b184"/>
      <ellipse cx="74" cy="214" rx="13" ry="6" fill="#e3b184"/>
      <circle cx="49" cy="38" r="3" fill="#3a2b25"/>
      <circle cx="71" cy="38" r="3" fill="#3a2b25"/>
      <path d="M53 52 Q60 57 67 52" stroke="#b06a58" stroke-width="3" fill="none" stroke-linecap="round"/>
    `, g),
    svgAsset("身体-小麦", 120, 220, `
      <ellipse cx="60" cy="40" rx="30" ry="34" fill="#c98d5a"/>
      <rect x="50" y="66" width="20" height="22" fill="#b77a47"/>
      <path d="M28 88 Q60 74 92 88 L100 160 Q60 184 20 160 Z" fill="#c98d5a"/>
      <rect x="35" y="158" width="20" height="56" rx="10" fill="#c98d5a"/>
      <rect x="65" y="158" width="20" height="56" rx="10" fill="#c98d5a"/>
      <ellipse cx="46" cy="214" rx="13" ry="6" fill="#a86f3f"/>
      <ellipse cx="74" cy="214" rx="13" ry="6" fill="#a86f3f"/>
      <circle cx="49" cy="38" r="3" fill="#2c1d16"/>
      <circle cx="71" cy="38" r="3" fill="#2c1d16"/>
      <path d="M53 52 Q60 57 67 52" stroke="#8c4a36" stroke-width="3" fill="none" stroke-linecap="round"/>
    `, g),
    svgAsset("发型-短发棕", 140, 120, `
      <path d="M26 82 Q24 16 70 14 Q116 16 114 82 Q104 46 70 44 Q36 46 26 82 Z" fill="#6b4a2f"/>
      <path d="M28 78 Q34 56 54 50 Q44 70 46 88 Q34 92 28 78 Z" fill="#573a24"/>
      <path d="M112 78 Q106 56 86 50 Q96 70 94 88 Q106 92 112 78 Z" fill="#573a24"/>
      <path d="M54 18 Q70 10 88 16" stroke="#8d6542" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.7"/>
    `, g),
    svgAsset("发型-长发明", 140, 160, `
      <path d="M22 150 Q16 70 26 46 Q36 12 70 12 Q104 12 114 46 Q124 70 118 150 Q104 142 100 78 Q92 48 70 46 Q48 48 40 78 Q36 142 22 150 Z" fill="#c9a15a"/>
      <path d="M28 138 Q26 76 38 50 Q48 72 46 132 Q38 138 28 138 Z" fill="#ad8545"/>
      <path d="M112 138 Q114 76 102 50 Q92 72 94 132 Q102 138 112 138 Z" fill="#ad8545"/>
      <path d="M52 18 Q70 10 88 17" stroke="#e2c07c" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.7"/>
    `, g),
    svgAsset("发型-马尾橙", 150, 140, `
      <path d="M28 84 Q26 18 72 16 Q118 18 116 84 Q104 48 72 46 Q40 48 28 84 Z" fill="#c2662f"/>
      <path d="M110 56 Q146 66 142 104 Q138 132 118 138 Q132 108 108 84 Z" fill="#a94f21"/>
      <path d="M32 80 Q40 54 60 48 Q50 72 50 90 Q38 94 32 80 Z" fill="#a94f21"/>
      <path d="M56 20 Q72 12 90 18" stroke="#e28a4c" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.7"/>
    `, g),
    svgAsset("上装-白衬衫", 140, 120, `
      <path d="M42 18 L58 30 L70 38 L82 30 L98 18 L118 38 L108 62 L100 56 L104 112 Q70 120 36 112 L40 56 L32 62 L22 38 Z" fill="#f4f6fb" stroke="#cdd5e6" stroke-width="2"/>
      <path d="M58 30 L70 46 L82 30 L78 92 L70 100 L62 92 Z" fill="#e2e8f4"/>
      <circle cx="70" cy="60" r="3" fill="#aeb9ce"/>
      <circle cx="70" cy="78" r="3" fill="#aeb9ce"/>
      <path d="M100 56 L96 102" stroke="#d5dcec" stroke-width="2"/>
    `, g),
    svgAsset("上装-蓝裙", 150, 150, `
      <path d="M46 16 L62 28 L75 36 L88 28 L104 16 L122 40 L112 62 L108 54 L118 138 Q75 152 32 138 L42 54 L38 62 L28 40 Z" fill="#4c8dff" stroke="#3569c9" stroke-width="2"/>
      <path d="M62 28 L75 44 L88 28 L84 58 L66 58 Z" fill="#3b74d8"/>
      <path d="M44 108 Q75 120 106 108 L110 134 Q75 146 40 134 Z" fill="#3b74d8" opacity="0.55"/>
      <circle cx="75" cy="72" r="3.4" fill="#bcd6ff"/>
      <circle cx="75" cy="92" r="3.4" fill="#bcd6ff"/>
    `, g),
    svgAsset("上装-红外套", 150, 130, `
      <path d="M40 18 L60 30 L75 38 L90 30 L110 18 L128 44 L116 70 L108 62 L112 122 Q75 132 38 122 L42 62 L34 70 L22 44 Z" fill="#e0525f" stroke="#b53a47" stroke-width="2"/>
      <path d="M60 30 L75 52 L90 30 L86 118 L64 118 Z" fill="#c84451"/>
      <path d="M75 38 V122" stroke="#9e2e3a" stroke-width="2" opacity="0.6"/>
      <rect x="46" y="84" width="14" height="8" rx="3" fill="#ffd0d4" opacity="0.75"/>
      <rect x="90" y="84" width="14" height="8" rx="3" fill="#ffd0d4" opacity="0.75"/>
    `, g),
    svgAsset("下装-牛仔裤", 120, 100, `
      <path d="M24 4 H96 L102 40 L88 96 H64 L60 48 L56 96 H32 L18 40 Z" fill="#3f6fb5" stroke="#2e5590" stroke-width="2"/>
      <rect x="24" y="4" width="72" height="14" fill="#2e5590" opacity="0.55"/>
      <path d="M60 20 V48" stroke="#7fa8e0" stroke-width="2" opacity="0.6"/>
      <circle cx="42" cy="40" r="2.6" fill="#d7e5ff"/>
      <circle cx="78" cy="40" r="2.6" fill="#d7e5ff"/>
    `, g),
    svgAsset("下装-粉短裙", 130, 100, `
      <path d="M30 8 H100 L122 88 Q65 104 8 88 Z" fill="#f27fae" stroke="#cf5c8c" stroke-width="2"/>
      <path d="M30 8 H100 L104 24 H26 Z" fill="#d9659a"/>
      <g stroke="#ffb6d3" stroke-width="2" opacity="0.8">
        <path d="M44 24 L34 88"/><path d="M65 24 L65 94"/><path d="M86 24 L96 88"/>
      </g>
    `, g),
    svgAsset("下装-运动裤", 120, 100, `
      <path d="M24 4 H96 L102 42 L90 96 H64 L60 50 L56 96 H30 L18 42 Z" fill="#3a4256" stroke="#252b3a" stroke-width="2"/>
      <rect x="24" y="4" width="72" height="12" fill="#252b3a"/>
      <path d="M26 44 H44 L40 88 H26 Z" fill="#2ecc8f" opacity="0.7"/>
      <path d="M94 44 H76 L80 88 H94 Z" fill="#2ecc8f" opacity="0.7"/>
      <path d="M60 20 V50" stroke="#59627a" stroke-width="2"/>
    `, g),
    svgAsset("鞋子-运动鞋", 110, 40, `
      <path d="M8 28 Q8 14 26 14 L48 14 L58 24 L88 24 Q104 24 104 32 Q104 36 96 36 H18 Q8 36 8 28 Z" fill="#f4f6fb" stroke="#c3ccdd" stroke-width="2"/>
      <path d="M8 30 H104" stroke="#aeb9ce" stroke-width="3"/>
      <path d="M48 16 L58 24 L46 24 Z" fill="#4c8dff"/>
      <path d="M68 18 L76 24 L64 24 Z" fill="#4c8dff" opacity="0.7"/>
    `, g),
    svgAsset("鞋子-皮鞋", 110, 40, `
      <path d="M8 28 Q8 12 26 12 L46 12 L58 26 L88 26 Q104 26 104 33 Q104 36 96 36 H18 Q8 36 8 28 Z" fill="#2a2d36" stroke="#14161c" stroke-width="2"/>
      <path d="M8 31 H104" stroke="#0f1115" stroke-width="3"/>
      <path d="M56 16 Q70 18 82 26" stroke="#5a6070" stroke-width="2" fill="none"/>
    `, g),
    svgAsset("鞋子-靴子", 110, 60, `
      <path d="M22 4 H48 L52 34 L88 34 Q104 34 104 44 Q104 52 94 52 H18 Q8 52 8 42 V20 Q8 4 22 4 Z" fill="#b53a47" stroke="#8e2732" stroke-width="2"/>
      <path d="M8 40 H104" stroke="#6f1d26" stroke-width="3"/>
      <rect x="22" y="8" width="26" height="5" rx="2.5" fill="#e87982" opacity="0.7"/>
    `, g),
    svgAsset("配饰-无", 100, 60, `<rect width="100" height="60" fill="none"/>`, g),
    svgAsset("配饰-蝴蝶结", 100, 60, `
      <path d="M50 30 L22 12 Q10 20 14 32 Q18 44 32 42 Z" fill="#f27fae" stroke="#cf5c8c" stroke-width="2"/>
      <path d="M50 30 L78 12 Q90 20 86 32 Q82 44 68 42 Z" fill="#f27fae" stroke="#cf5c8c" stroke-width="2"/>
      <circle cx="50" cy="30" r="8" fill="#e05f97"/>
      <circle cx="47" cy="27" r="2.4" fill="#ffc2d9"/>
    `, g),
    svgAsset("配饰-猫耳", 100, 60, `
      <path d="M18 44 L26 8 L48 30 Z" fill="#3a4256" stroke="#252b3a" stroke-width="2"/>
      <path d="M82 44 L74 8 L52 30 Z" fill="#3a4256" stroke="#252b3a" stroke-width="2"/>
      <path d="M26 30 L30 15 L40 28 Z" fill="#f27fae" opacity="0.8"/>
      <path d="M74 30 L70 15 L60 28 Z" fill="#f27fae" opacity="0.8"/>
      <path d="M34 46 Q50 54 66 46" stroke="#3a4256" stroke-width="6" fill="none" stroke-linecap="round"/>
    `, g),
    svgAsset("衣橱图标", 64, 64, `
      <rect x="6" y="10" width="52" height="46" rx="7" fill="#4a3d68" stroke="#8b78b8" stroke-width="2"/>
      <rect x="12" y="16" width="40" height="34" rx="4" fill="#2a2340"/>
      <path d="M32 16 V50" stroke="#8b78b8" stroke-width="2"/>
      <circle cx="27" cy="33" r="2.4" fill="#d8c8ff"/>
      <circle cx="37" cy="33" r="2.4" fill="#d8c8ff"/>
      <path d="M22 6 L32 13 L42 6" stroke="#8b78b8" stroke-width="3" fill="none" stroke-linecap="round"/>
    `, g)
  ];
}

interface PartSpec {
  name: string;
  asset: string;
  x: number;
  y: number;
  hw: number;
  hh: number;
  z: number;
  slot: string;
  options: string[];
  assets: string[];
  fallback: string;
  defaultIndex?: number;
  scale?: number;
}

export function createDressupProject(): Project {
  const p = createProject("换装示例");
  p.author = "BWE Studio";
  p.tileSize = 32;
  p.gridW = 20;
  p.gridH = 15;
  p.scenes = [createScene("试衣间", 20, 15)];
  p.assets = dressupAssets();
  const scene = p.scenes[0];
  const layerGround = scene.layers[0].id;
  const layerProps = scene.layers[1].id;
  const layerActor = scene.layers[2].id;

  const bg = assetByName(p, "换装背景");
  const background = createObject("PROP", 320, 240);
  background.name = "换装背景";
  background.assetId = bg?.id ?? "";
  background.halfW = 320;
  background.halfH = 240;
  background.z = -10;
  background.locked = true;
  background.layerId = layerGround;
  background.tags = ["背景"];
  scene.objects.push(background);

  const specs: PartSpec[] = [
    {
      name: "身体", asset: "身体-基础", x: 320, y: 300, hw: 60, hh: 110, z: 0,
      slot: "身体 Body", options: ["基础体 A", "基础体 B"],
      assets: ["身体-基础", "身体-小麦"], fallback: "#f2c9a0"
    },
    {
      name: "下装", asset: "下装-牛仔裤", x: 320, y: 380, hw: 60, hh: 50, z: 1,
      slot: "下装 Bottom", options: ["牛仔裤", "粉短裙", "运动裤"],
      assets: ["下装-牛仔裤", "下装-粉短裙", "下装-运动裤"], fallback: "#3f6fb5"
    },
    {
      name: "上装", asset: "上装-白衬衫", x: 320, y: 315, hw: 70, hh: 60, z: 2,
      slot: "上装 Top", options: ["白衬衫", "蓝连衣裙", "红外套"],
      assets: ["上装-白衬衫", "上装-蓝裙", "上装-红外套"], fallback: "#f4f6fb"
    },
    {
      name: "鞋子", asset: "鞋子-运动鞋", x: 320, y: 415, hw: 55, hh: 20, z: 3,
      slot: "鞋子 Shoes", options: ["运动鞋", "皮鞋", "靴子"],
      assets: ["鞋子-运动鞋", "鞋子-皮鞋", "鞋子-靴子"], fallback: "#f4f6fb"
    },
    {
      name: "头发", asset: "发型-短发棕", x: 320, y: 225, hw: 70, hh: 60, z: 4,
      slot: "发型 Hair", options: ["短发", "长发", "马尾"],
      assets: ["发型-短发棕", "发型-长发明", "发型-马尾橙"], fallback: "#6b4a2f"
    },
    {
      name: "配饰", asset: "配饰-无", x: 320, y: 235, hw: 50, hh: 30, z: 5,
      slot: "配饰 Accessory", options: ["无", "蝴蝶结", "猫耳"],
      assets: ["配饰-无", "配饰-蝴蝶结", "配饰-猫耳"], fallback: "transparent", defaultIndex: 1
    }
  ];

  for (const spec of specs) {
    const asset = assetByName(p, spec.asset);
    const o = createObject("ACTOR", spec.x, spec.y);
    o.name = spec.name;
    o.assetId = asset?.id ?? "";
    o.halfW = spec.hw;
    o.halfH = spec.hh;
    o.z = spec.z;
    o.layerId = layerActor;
    o.tags = ["换装部件"];
    o.modules.push(withModule("game.dressPart", {
      slot: spec.slot,
      options: spec.options.join(","),
      optionAssets: spec.assets.join(","),
      defaultIndex: String(spec.defaultIndex ?? 0),
      offsetX: "0",
      offsetY: "0",
      partScale: String(spec.scale ?? 1),
      fallbackColor: spec.fallback,
      followBody: "开"
    }));
    scene.objects.push(o);
  }

  const icon = assetByName(p, "衣橱图标");
  const wardrobe = createObject("PROP", 560, 84);
  wardrobe.name = "衣橱控制器";
  wardrobe.assetId = icon?.id ?? "";
  wardrobe.halfW = 32;
  wardrobe.halfH = 32;
  wardrobe.z = 9;
  wardrobe.layerId = layerProps;
  wardrobe.tags = ["换装控制器"];
  wardrobe.modules.push(withModule("game.dressup", {
    title: "换 装 间",
    backgroundAsset: "换装背景",
    partTag: "换装部件",
    showTabs: "开",
    allowReset: "开",
    persist: "关",
    stageWidth: "640",
    stageHeight: "480",
    fit: "等比缩放 Contain"
  }));
  scene.objects.push(wardrobe);

  p.variables = {
    "换装.当前组合": "",
    "换装.已解锁套数": "1"
  };

  return p;
}

export type ExampleId = "minesweeper" | "dressup" | "topdown-js" | "emergence" | "vampire" | "lighting" | "alien-shooter";

/** 深拷贝：示例工程每次载入都要是一份新对象，避免用户在编辑器里的改动污染模块缓存。 */
function cloneProject(p: unknown): Project {
  return JSON.parse(JSON.stringify(p)) as Project;
}

export function buildExample(id: ExampleId): { project: Project; fileName: string } {
  if (id === "dressup") return { project: createDressupProject(), fileName: "换装示例.bwproj" };
  if (id === "topdown-js") {
    return { project: cloneProject(topDownJsProject), fileName: "俯视角JS示例.bwproj" };
  }
  if (id === "emergence") {
    return { project: cloneProject(emergenceProject), fileName: "涌现沙盘.bwproj" };
  }
  if (id === "vampire") {
    return { project: cloneProject(vampireProject), fileName: "吸血鬼幸存者.bwproj" };
  }
  if (id === "lighting") {
    return { project: cloneProject(lightingProject), fileName: "2D光照示例.bwproj" };
  }
  if (id === "alien-shooter") {
    return { project: cloneProject(alienShooterProject), fileName: "孤胆枪手.bwproj" };
  }
  return { project: createMinesweeperProject(), fileName: "扫雷示例.bwproj" };
}
