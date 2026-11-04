/**
 * 生成「2D 光照示例」工程（`web/examples/2D光照示例.bwproj`）。
 *
 * 为什么要有这个示例：
 *   光照系统最难的不是计算，而是**用户不知道该怎么配**：环境光多暗、压暗多少、
 *   哪盏灯该进烘焙、哪盏必须动态、遮挡体怎么标。文档讲得再细也不如一个能打开就能跑、
 *   每盏灯都写着"我是干什么的"的工程。
 *
 * 设计原则（与 `docs/_fragments/lighting-contract.md` 对齐）：
 *   1. **打开就能点「预览」**：场景脚本自己做昼夜循环 + 玩家提灯，不依赖用户操作；
 *   2. **每种能力各有一盏"样板灯"**，并在对象名里写清用途，用户在画布上一眼能对上；
 *   3. **刻意留一个"对照区"**：左边有墙、右边没墙，同一盏灯两侧亮度差就是遮挡生效的证明；
 *   4. **不写烘焙贴图**（`lightmap` 留空）：示例要能在没有 GPU 烘焙的环境里也跑得起来，
 *      用户点「一键烘焙」后才有 —— 这也正是他第一次使用该功能的正确路径。
 *
 * 素材一律用内联 SVG（data URL），保证 `.bwproj` 单文件能带着图走（与其它示例同一约定）。
 *
 * 用法：
 *   node web/tools/gen-lighting-example.mjs            # 写入默认路径
 *   node web/tools/gen-lighting-example.mjs --out <path>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataUrl } from "./lib/png-write.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DEFAULT_OUT = resolve(ROOT, "web", "examples", "2D光照示例.bwproj");

/**
 * 内联 **PNG** 素材（`src: "url"` + data URL）。
 *
 * 为什么是 PNG 而不是 SVG：SVG 只有浏览器打包入口能栅格化，
 * 命令行 `package-bwe.mjs --build-only` 会直接告警并丢掉素材 ——
 * 示例工程必须两条入口都能跑，否则用户用命令行试跑会以为"光照没做出来"。
 */
function pngAsset(id, name, w, h, shade, group = "光照示例") {
  return {
    id,
    name,
    kind: "IMAGE",
    src: "url",
    url: dataUrl(w, h, shade),
    path: name,
    width: w,
    height: h,
    group,
    hiddenFrames: [],
    frameDurations: []
  };
}

// ---------------- 素材 ----------------
//
// 全部用程序化 PNG：深色底 + 高光，保证在「深夜档位」下也能看清形状。
// 尺寸按引擎约定（1 单位 = 1 世界像素），地面/墙 32，角色 16x24。

function assets() {
  return [
    // 石板地面：深蓝灰 + 砖缝。本身很暗，才能看出压暗/加光的效果差别
    pngAsset("light-asset-floor", "石板地面", 32, 32, (x, y) => {
      const seam = x % 16 === 0 || y % 16 === 0;
      if (seam) return [38, 43, 56, 255];
      const noise = ((x * 7 + y * 13) % 5) * 3;
      return [43 + noise, 48 + noise, 64 + noise, 255];
    }),

    // 草地：偏暗绿，用来对比「有草的地方不该被灯照到」
    pngAsset("light-asset-grass", "草地", 32, 32, (x, y) => {
      const blade = (x % 6 === 2 && y > 10) || (x % 6 === 5 && y > 6);
      return blade ? [58, 112, 78, 255] : [30, 58, 42, 255];
    }),

    // 砖墙：亮灰（画得比地面亮 → "墙后变暗"对比更明显）
    pngAsset("light-asset-wall", "砖墙", 32, 32, (x, y) => {
      const row = Math.floor(y / 16);
      const offset = row % 2 === 0 ? 0 : 8;
      const brickSeam = (x + offset) % 16 === 0 || y % 16 === 0;
      if (brickSeam) return [111, 116, 127, 255];
      return [148, 154, 168, 255];
    }),

    // 玩家：亮黄小人（提灯主角，必须一眼能认出来）
    pngAsset("light-asset-player", "玩家", 16, 24, (x, y) => {
      const inBody = x >= 2 && x <= 13 && y >= 2 && y <= 21;
      if (!inBody) return [0, 0, 0, 0];
      const eye = (x === 5 || x === 9) && (y === 7 || y === 8);
      if (eye) return [27, 32, 48, 255];
      return [255, 209, 102, 255];
    }),

    // 灯柱：细杆 + 灯头
    pngAsset("light-asset-lamp", "灯柱", 12, 32, (x, y) => {
      const pole = x >= 4 && x <= 7 && y >= 6;
      const head = (x - 6) * (x - 6) + (y - 5) * (y - 5) <= 16;
      if (head) return [255, 233, 168, 255];
      if (pole) return [58, 65, 82, 255];
      return [0, 0, 0, 0];
    }),

    // 火把：暖橙火苗
    pngAsset("light-asset-torch", "火把", 16, 16, (x, y) => {
      const stick = x >= 6 && x <= 9 && y >= 6;
      const flame = (x - 8) * (x - 8) + (y - 4) * (y - 4) <= 9;
      const core = (x - 8) * (x - 8) + (y - 3) * (y - 3) <= 2;
      if (core) return [255, 240, 150, 255];
      if (flame) return [255, 154, 60, 255];
      if (stick) return [90, 58, 34, 255];
      return [0, 0, 0, 0];
    })
  ];
}

// ---------------- 工程结构 ----------------

let seq = 0;
function uid(prefix) {
  seq++;
  return `${prefix}-${String(seq).padStart(3, "0")}`;
}

function obj(kind, x, y, extra) {
  return Object.assign(
    {
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
      layerId: "layer-ground",
      visible: true,
      locked: false,
      assetId: "",
      animMode: "默认",
      animFps: 8,
      modules: [],
      props: {},
      tags: [],
      parentId: null
    },
    extra || {}
  );
}

function lightingModule(values) {
  return {
    defId: "render.light",
    label: "",
    trigger: null,
    values,
    enabled: true,
    collapsed: false
  };
}

const W = 40; // tiles
const H = 30;
const T = 32;
const PX_W = W * T;
const PX_H = H * T;

function buildScene() {
  seq = 0;
  const objects = [];

  // ---- 1) 地面：整块铺满（用一个大的 TILE，props.w/h 指定尺寸，与运行时 drawFallback 一致） ----
  objects.push(
    obj("TILE", PX_W / 2, PX_H / 2, {
      name: "地面（深色石板）",
      layerId: "layer-ground",
      assetId: "light-asset-floor",
      props: { w: String(PX_W), h: String(PX_H) },
      z: 0
    })
  );

  // ---- 2) 遮挡墙：两段，中间留门洞。用来演示"墙后不被穿透照亮" ----
  // 竖墙 x=800（世界像素），y 从 96 到 704，中间 y≈352~416 留门洞
  for (const [y, h] of [
    [96 + 128, 256],   // 上段：中心 y=224，高 256 → 96..352
    [416 + 128, 256]   // 下段：中心 y=544，高 256 → 416..672
  ]) {
    objects.push(
      obj("PROP", 800, y, {
        name: `遮挡墙（竖，y=${y}）`,
        layerId: "layer-wall",
        assetId: "light-asset-wall",
        halfW: 16,
        halfH: h / 2,
        tags: ["wall", "occluder"],
        props: { w: "32", h: String(h), lightBlock: "1" },
        z: 20
      })
    );
  }

  // 横墙 y=800，右半边（x 从 800 到 1280）—— 让"墙后阴影"在右下角也看得到
  objects.push(
    obj("PROP", 800 + 240, 800, {
      name: "遮挡墙（横，右下）",
      layerId: "layer-wall",
      assetId: "light-asset-wall",
      halfW: 240,
      halfH: 16,
      tags: ["wall", "occluder"],
      props: { w: "480", h: "32", lightBlock: "1" },
      z: 20
    })
  );

  // ---- 3) 草地：一块"不该被照亮的暗区"，用来对比 ----
  objects.push(
    obj("TILE", 200, 780, {
      name: "草地（照明对比用）",
      layerId: "layer-ground",
      assetId: "light-asset-grass",
      props: { w: "320", h: "160" },
      z: 1
    })
  );

  // ---- 4) 样板光源：每种能力各一盏，名字即用途 ----
  // ① 暖色点光（最基础）
  objects.push(
    obj("LIGHT", 256, 256, {
      name: "① 点光·暖黄（最基础的点光源）",
      layerId: "layer-light",
      assetId: "light-asset-lamp",
      props: {
        lightRadius: "240",
        lightColor: "#FFC978",
        lightIntensity: "1.2",
        lightType: "point",
        lightFalloff: "2",
        lightShadow: "1",
        lightDynamic: "0"
      },
      z: 25
    })
  );

  // ② 聚光（锥形，朝右下）—— 演示角度/方向/锥边软化
  objects.push(
    obj("LIGHT", 480, 160, {
      name: "② 聚光·青蓝（锥角 60°、朝右下）",
      layerId: "layer-light",
      props: {
        lightRadius: "320",
        lightColor: "#80CCFF",
        lightIntensity: "1.4",
        lightType: "spot",
        lightAngle: "60",
        lightDir: "45",
        lightConeSoft: "14",
        lightFalloff: "2",
        lightShadow: "1",
        lightDynamic: "0"
      },
      z: 25
    })
  );

  // ③ 火把：闪烁 + 必须动态（不进烘焙）—— 演示"闪烁光不能烘焙"
  objects.push(
    obj("PROP", 256, 640, {
      name: "③ 火把（闪烁·动态光，不进烘焙）",
      layerId: "layer-light",
      assetId: "light-asset-torch",
      halfW: 8,
      halfH: 8,
      props: {
        lightRadius: "200",
        lightColor: "#FF9A3C",
        lightIntensity: "1.1",
        lightType: "point",
        lightFlicker: "0.35",
        lightDynamic: "1",
        lightShadow: "1",
        color: "#ff9a3c",
        w: "16",
        h: "16"
      },
      z: 24
    })
  );

  // ④ 模块形式的光（render.light 模块）—— 演示编辑器积木方式
  objects.push(
    obj("PROP", 1180, 260, {
      name: "④ 模块光（挂 render.light 积木，紫）",
      layerId: "layer-light",
      assetId: "light-asset-lamp",
      halfW: 6,
      halfH: 16,
      modules: [
        lightingModule({
          radius: "220",
          color: "#C89BFF",
          strength: "1.2",
          flicker: "false",
          intensity: ""
        })
      ],
      z: 25
    })
  );

  // ⑤ 墙后的一盏灯：演示"遮挡阴影"—— 它在墙左侧，右侧本该被墙挡住
  objects.push(
    obj("LIGHT", 640, 384, {
      name: "⑤ 墙前灯（演示遮挡：右侧应为阴影）",
      layerId: "layer-light",
      props: {
        lightRadius: "300",
        lightColor: "#FF6B8A",
        lightIntensity: "1.3",
        lightType: "point",
        lightShadow: "1",
        lightDynamic: "0"
      },
      z: 25
    })
  );

  // ---- 5) 玩家（提灯的主角，场景脚本会给他挂一盏跟随光）----
  objects.push(
    obj("ACTOR", 480, 640, {
      name: "玩家",
      layerId: "layer-actor",
      assetId: "light-asset-player",
      halfW: 8,
      halfH: 12,
      animMode: "只显示首帧",
      tags: ["player"],
      z: 30
    })
  );

  return objects;
}

/** 场景脚本：昼夜循环 + 玩家提灯 + 键盘微调。ES5，Rhino 直接可跑。 */
function sceneScript() {
  return `// ---------------------------------------------------------------------------
// 2D 光照示例 · 场景脚本
// ---------------------------------------------------------------------------
// 这个示例要让你"打开就能看到光照在动"，所以脚本做三件事：
//   1. 玩家身上挂一盏提灯（bwe.light.attach）—— 光跟着人走；
//   2. 按 R 键在几档"夜色"之间切换（环境光/压暗/模式），观察四者的关系；
//   3. 每 2 秒打一行 bwe.light.stats()，让你在日志里看到动态贴图的重建节奏。
//
// 注意：脚本只能用 ES5（var / function），Rhino 1.7.15 不认 let/const/箭头函数。
// ---------------------------------------------------------------------------

var DEMO = {
  preset: 1,
  presets: [
    { name: "白天", enabled: false, mode: "both", ambientColor: "#8FA6C8", ambientIntensity: 0.75, darkness: 0.0 },
    { name: "黄昏", enabled: true, mode: "both", ambientColor: "#4A4468", ambientIntensity: 0.45, darkness: 0.22 },
    { name: "深夜", enabled: true, mode: "both", ambientColor: "#202A3C", ambientIntensity: 0.22, darkness: 0.40 },
    { name: "极暗", enabled: true, mode: "both", ambientColor: "#10141E", ambientIntensity: 0.10, darkness: 0.62 }
  ],
  ticks: 0,
  player: null,
  lampId: 0
};

function onSceneStart(ctx) {
  bwe.log("[光照示例] 场景启动");

  DEMO.player = bwe.world.find({ tag: "player" });
  if (DEMO.player) {
    // ★ 提灯：attach 会自动把 dynamic 设成 true（跟随实体的光不能进静态烘焙图）
    var ok = bwe.light.attach(DEMO.player, {
      radius: 200,
      color: "#FFE0A8",
      intensity: 1.15,
      flicker: 0.08
    });
    bwe.log("[光照示例] 玩家提灯 attach = " + ok);
  } else {
    bwe.log("[光照示例] 没找到 tag=player 的对象，提灯跳过");
  }

  applyPreset(2);   // 默认从「深夜」开始，一进来就看得到光
  bwe.log("[光照示例] 按 R 切换夜色档位（白天/黄昏/深夜/极暗）");

  // 每 2 秒报一次统计：注意 rebuilds 会随动态光/参数变化增长
  bwe.every(2, function () {
    DEMO.ticks += 1;
    var s = bwe.light.stats();
    bwe.log("[光照示例] stats enabled=" + s.enabled
      + " mode=" + s.mode
      + " lights=" + s.lights
      + " 动态=" + s.dynamic
      + " rebuilds=" + s.rebuilds
      + " lastMs=" + s.lastMs
      + " tex=" + s.texW + "x" + s.texH);
  });
}

function applyPreset(i) {
  var p = DEMO.presets[i % DEMO.presets.length];
  DEMO.preset = i % DEMO.presets.length;
  bwe.light.enabled(p.enabled);
  bwe.light.mode(p.mode);
  bwe.light.ambient(p.ambientColor, p.ambientIntensity);
  bwe.light.darkness(p.darkness);
  bwe.log("[光照示例] 档位 → " + p.name
    + "（ambient " + p.ambientColor + " × " + p.ambientIntensity
    + "，darkness " + p.darkness + "）");
}

function onUpdate(ctx, dt) {
  // 按 R 切档
  if (bwe.input.pressed("KeyR")) {
    applyPreset(DEMO.preset + 1);
  }
  // 按 B 立刻触发一次动态贴图重建（观察 rebuilds 跳变）
  if (bwe.input.pressed("KeyB")) {
    bwe.light.rebuild();
    bwe.log("[光照示例] 手动 rebuild() 已受理");
  }
}

function onSceneEnd(ctx) {
  // 场景卸载时把提灯拆掉（detach 会精确还原 attach 前的 props）
  if (DEMO.player) {
    bwe.light.detach(DEMO.player);
  }
  bwe.log("[光照示例] 场景结束");
}
`;
}

function buildProject() {
  const p = {
    format: 1,
    name: "2D 光照示例",
    author: "BWE",
    tileSize: T,
    gridW: W,
    gridH: H,
    scenes: [],
    assets: assets(),
    prefabs: [],
    packs: [],
    scripts: {},
    variables: {},
    masterVolume: 0.8
  };

  const scene = {
    id: "scene-light-demo",
    name: "光照演示 · 灯与影",
    originX: 0,
    originY: 0,
    widthTiles: W,
    heightTiles: H,
    layers: [
      { id: "layer-ground", name: "地面", visible: true, locked: false, order: 0 },
      { id: "layer-wall", name: "墙（遮挡体）", visible: true, locked: false, order: 1 },
      { id: "layer-light", name: "光源", visible: true, locked: false, order: 2 },
      { id: "layer-actor", name: "角色", visible: true, locked: false, order: 3 }
    ],
    objects: buildScene(),
    onStartScript: "lightDemo",
    bgmAssetId: "",
    lighting: {
      enabled: true,
      mode: "both",
      ambientColor: "#202A3C",
      ambientIntensity: 0.22,
      darkness: 0.4,
      softness: 16,
      texelsPerPixel: 0.25,
      dynamicFps: 15,
      maxDynamicLights: 8
    }
    // 刻意**不写 lightmap**：示例要能在用户还没点「一键烘焙」时也跑起来。
    // 这也正是他第一次用这个功能的正确路径：打开 → 预览（看到动态光）→ 点一键烘焙 → 再看。
  };

  p.scenes = [scene];
  p.scripts = {
    lightDemo: {
      name: "lightDemo",
      file: "scripts/lightDemo.js",
      source: sceneScript(),
      lang: "js"
    }
  };
  return p;
}

// ---------------- main ----------------

function main() {
  const args = process.argv.slice(2);
  let out = DEFAULT_OUT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = resolve(args[++i] ?? DEFAULT_OUT);
  }
  const p = buildProject();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(p, null, 2) + "\n", "utf8");
  const kinds = {};
  for (const o of p.scenes[0].objects) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
  console.log(`已写入 ${out}`);
  console.log(`  场景 ${p.scenes[0].widthTiles}x${p.scenes[0].heightTiles} 格（${PX_W}x${PX_H} 世界像素）`);
  console.log(`  对象 ${p.scenes[0].objects.length} 个：${JSON.stringify(kinds)}`);
  console.log(`  光源 ${p.scenes[0].objects.filter((o) => o.kind === "LIGHT" || (o.modules || []).some((m) => m.defId === "render.light") || Number(o.props.lightRadius) > 0).length} 盏`);
  console.log(`  素材 ${p.assets.length} 条（内联 PNG，单文件可携带）`);
  console.log(`  脚本 ${Object.keys(p.scripts).length} 段`);
}

main();
