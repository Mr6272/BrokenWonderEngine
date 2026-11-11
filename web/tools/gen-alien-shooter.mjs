/**
 * 生成 web/examples/孤胆枪手.bwproj —— Alien Shooter（孤胆枪手，Sigma Team 2003）第一关「潜入」的还原模板。
 *
 *   node web/tools/gen-alien-shooter.mjs        （package.json: npm run gen:alienshooter）
 *
 * 所有像素画、音效都在这里程序化生成（web/tools/alien-shooter/*.mjs），工程是一个自包含的 .bwproj
 * （素材全部 data URL 内嵌），编辑器「新建示例 → 孤胆枪手」直接打开，点「试跑」即可玩。
 *
 * 组成：
 *   - level.mjs     关卡布局（64×48 格，字符画 + 物件表）
 *   - art-env.mjs   地面/墙/道具/拾取物像素画
 *   - art-actors.mjs 主角/外星虫（16 方向 × 4 帧）/尸体/血迹/特效/界面
 *   - sfx.mjs       音效（WAV，程序合成）
 *   - scripts/*.js  游戏逻辑（ES5，引擎的 Rhino 解释执行）
 *
 * 光照：夜间场景。路灯是静态灯，生成时用编辑器同一份 lightMath.ts **预烘焙**成光照贴图
 * （scene.lightmap），运行时动态层只算手电筒/枪口火焰/爆炸这几盏动态光，帧时间才压得住。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import { Canvas, encodePng, rng } from "./alien-shooter/px.mjs";
import { TILE, SOLID, GROUND, OBJECTS, buildMap } from "./alien-shooter/level.mjs";
import { buildEnvArt } from "./alien-shooter/art-env.mjs";
import { buildActorArt } from "./alien-shooter/art-actors.mjs";
import { buildSfx } from "./alien-shooter/sfx.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const OUT = resolve(ROOT, "web/examples/孤胆枪手.bwproj");
const GROUP = "孤胆枪手";

const LAYER_TERRAIN = "layer-terrain";
const LAYER_PROP = "layer-prop";
const LAYER_ACTOR = "layer-actor";

// 夜间光照（参照 2D 光照示例的「深夜」预设，再压暗一点：原作夜关就是黑压压一片，只有灯下和手电筒里看得清）
const LIGHTING = {
  enabled: true,
  mode: "both",
  ambientColor: "#1A2232",
  ambientIntensity: 0.2,
  darkness: 0.5,
  softness: 12,
  texelsPerPixel: 0.25,
  dynamicFps: 20,
  maxDynamicLights: 6
};
const LAMP = { radius: 230, color: "#FFD08A", intensity: 1.15, falloff: 1.6 };

// ============================================================================
// 素材
// ============================================================================

const assets = [];
const assetIdByName = new Map();

function addImage(name, img, note, extra = {}) {
  const id = `as-${assets.length.toString().padStart(2, "0")}`;
  const png = encodePng(img);
  assets.push({
    id,
    name,
    kind: extra.cols ? "ATLAS" : "IMAGE",
    src: "url",
    url: "data:image/png;base64," + png.toString("base64"),
    path: name + ".png",
    width: img.w,
    height: img.h,
    group: extra.group ?? GROUP,
    hiddenFrames: [],
    frameDurations: [],
    note: note ?? "",
    ...(extra.cols
      ? { cols: extra.cols, rows: extra.rows, cellW: extra.cellW, cellH: extra.cellH, frameCount: extra.cols * extra.rows }
      : {})
  });
  assetIdByName.set(name, id);
  return id;
}

function addAudio(name, wav, note) {
  const id = `as-${assets.length.toString().padStart(2, "0")}`;
  assets.push({
    id,
    name,
    kind: "AUDIO",
    src: "url",
    url: "data:audio/wav;base64," + wav.toString("base64"),
    path: name + ".wav",
    group: GROUP,
    note: note ?? ""
  });
  assetIdByName.set(name, id);
  return id;
}

function aid(name) {
  const id = assetIdByName.get(name);
  if (!id) throw new Error(`素材不存在：${name}`);
  return id;
}

// ============================================================================
// 地面：按关卡字符拼一整张底图（一个 PROP 铺满，绘制成本 = 1 个四边形）
// ============================================================================

function composeGround(map, ground) {
  const W = map.W * TILE, H = map.H * TILE;
  const img = new Canvas(W, H);
  const r = rng(20031);
  for (let cy = 0; cy < map.H; cy++) {
    for (let cx = 0; cx < map.W; cx++) {
      const ch = map.grid[cy][cx];
      const type = GROUND[ch];
      if (!type) throw new Error(`未知地面字符 '${ch}' @ ${cx},${cy}`);
      const vars = ground[type];
      if (!vars || !vars.length) throw new Error(`缺地面素材：${type}`);
      const tile = vars[Math.floor(r() * vars.length)];
      // 车道线是横向的整条线：只有 '=' 才用车道线素材，旁边保持水泥
      img.draw(tile, cx * TILE, cy * TILE);
    }
  }
  return img;
}

// ============================================================================
// 对象
// ============================================================================

let seq = 0;
const nid = (p) => `${p}-${(++seq).toString(36)}`;

function object(o) {
  return {
    id: o.id ?? nid("o"),
    name: o.name,
    kind: o.kind,
    x: o.x,
    y: o.y,
    z: o.z ?? 0,
    rotation: o.rotation ?? 0,
    scaleX: 1,
    scaleY: 1,
    halfW: o.halfW ?? 0,
    halfH: o.halfH ?? 0,
    layerId: o.layerId,
    visible: o.visible !== false,
    locked: false,
    assetId: o.assetId ?? "",
    animMode: "默认",
    animFps: 8,
    tags: o.tags ?? [],
    modules: o.modules ?? [],
    props: o.props ?? {},
    parentId: null
  };
}

const scriptModule = (script) => ({
  defId: "script.js",
  label: `脚本 ${script}`,
  trigger: null,
  values: { script },
  enabled: true,
  collapsed: false
});
const lockedModule = () => ({ defId: "move.locked", trigger: null, values: {}, enabled: true, collapsed: false });
const materialModule = (material) => ({ defId: "material", trigger: null, values: { material }, enabled: true, collapsed: false });

const cc = (v) => (v + 0.5) * TILE;   // 格坐标 → 世界坐标（格中心）

/**
 * 把一类实心格合并成尽量大的矩形（贪心：先横向延伸，再向下延伸同宽的行）。
 * 用于遮光体：每个矩形一个对象，而不是每格一个（遮挡体越少，动态光重建越快）。
 */
function mergeRects(map, chars) {
  const used = new Set();
  const out = [];
  const isC = (x, y) => x >= 0 && y >= 0 && x < map.W && y < map.H && chars.includes(map.grid[y][x]) && !used.has(y * map.W + x);
  for (let y = 0; y < map.H; y++) {
    for (let x = 0; x < map.W; x++) {
      if (!isC(x, y)) continue;
      const ch = map.grid[y][x];
      let w = 1;
      while (isC(x + w, y) && map.grid[y][x + w] === ch) w++;
      let h = 1;
      outer: for (;;) {
        for (let i = 0; i < w; i++) if (!isC(x + i, y + h) || map.grid[y + h][x + i] !== ch) break outer;
        h++;
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) used.add((y + j) * map.W + x + i);
      out.push({ x, y, w, h, ch });
    }
  }
  return out;
}

function buildObjects(map) {
  const objects = [];
  const lampSpecs = [];
  const occluders = [];

  // ---- 地面 ----
  objects.push(object({
    id: "ground", name: "地面", kind: "PROP",
    x: (map.W * TILE) / 2, y: (map.H * TILE) / 2, z: -100,
    halfW: (map.W * TILE) / 2, halfH: (map.H * TILE) / 2,
    layerId: LAYER_TERRAIN, assetId: aid("地面"), tags: ["地面"]
  }));

  // ---- 实心格：每格一个 TILE（进 tilemap 做碰撞 + 画墙面） ----
  for (let cy = 0; cy < map.H; cy++) {
    for (let cx = 0; cx < map.W; cx++) {
      const ch = map.grid[cy][cx];
      const name = SOLID[ch];
      if (!name) continue;
      const tags = ["墙"];
      if (ch === "X") tags.push("裂墙");
      objects.push(object({
        name: `${name} ${cx},${cy}`, kind: "TILE",
        x: cc(cx), y: cc(cy), z: ch === "R" ? 4 : 0,
        halfW: 16, halfH: 16, layerId: LAYER_TERRAIN,
        assetId: aid(name), tags,
        modules: [materialModule(ch === "F" ? "metal" : "stone")]
      }));
    }
  }

  // ---- 遮光体：合并矩形（铁丝网透光，不进来；裂墙单独一组，炸开后删掉） ----
  for (const r of mergeRects(map, ["W", "B", "R", "G", "X"])) {
    const x = (r.x + r.w / 2) * TILE, y = (r.y + r.h / 2) * TILE;
    const hw = (r.w * TILE) / 2, hh = (r.h * TILE) / 2;
    occluders.push({ x, y, hw, hh, cracked: r.ch === "X" });
    objects.push(object({
      name: r.ch === "X" ? "裂墙遮光" : "遮光", kind: "PROP",
      x, y, z: -99, halfW: hw, halfH: hh, layerId: LAYER_TERRAIN,
      assetId: aid("空白"), visible: false,
      tags: r.ch === "X" ? ["裂墙遮挡"] : [],
      props: { lightBlock: "1" }
    }));
  }

  // ---- 物件 ----
  for (const o of OBJECTS) {
    const x = cc(o.x), y = cc(o.y);
    switch (o.kind) {
      case "player":
        objects.push(object({
          id: "player", name: "玩家", kind: "ACTOR", x, y, z: 10,
          halfW: 20, halfH: 20, layerId: LAYER_ACTOR, assetId: aid("主角"),
          tags: ["玩家"], modules: [lockedModule(), scriptModule("player")]
        }));
        break;
      case "arrow":
        objects.push(object({
          name: "箭头", kind: "PROP", x, y, z: -90, rotation: o.rot ?? 0,
          halfW: 32, halfH: 16, layerId: LAYER_TERRAIN, assetId: aid("箭头")
        }));
        break;
      case "crate":
        objects.push(object({
          name: "木箱", kind: "PROP", x, y, z: 1, halfW: 14, halfH: 14,
          layerId: LAYER_PROP, assetId: aid("木箱"), tags: ["可击中", "障碍"],
          props: { kind: "crate", life: "14", hitR: "14", bw: "13", bh: "13", drop: o.drop ?? "" }
        }));
        break;
      case "barrel":
        objects.push(object({
          name: "油桶", kind: "PROP", x, y, z: 1, halfW: 10, halfH: 12,
          layerId: LAYER_PROP, assetId: aid("油桶"), tags: ["可击中", "障碍"],
          props: { kind: "barrel", life: "18", hitR: "11", bw: "9", bh: "10" }
        }));
        break;
      case "gas":
        objects.push(object({
          name: "气瓶", kind: "PROP", x, y, z: 1, halfW: 12, halfH: 14,
          layerId: LAYER_PROP, assetId: aid("气瓶"), tags: ["可击中", "障碍"],
          props: { kind: "gas", life: "12", hitR: "12", bw: "10", bh: "12" }
        }));
        break;
      case "money":
        objects.push(object({
          name: `钱 $${o.amount}`, kind: "PROP", x, y, z: 2, halfW: 10, halfH: 8,
          layerId: LAYER_PROP, assetId: aid("钱"), tags: ["拾取"],
          props: { item: "money", val: String(o.amount), frame: o.amount >= 150 ? "2" : o.amount >= 100 ? "1" : "0" }
        }));
        break;
      case "nest":
        objects.push(object({
          name: "巢穴", kind: "PROP", x, y, z: -20, halfW: 32, halfH: 32,
          layerId: LAYER_PROP, assetId: aid("巢穴"), tags: ["巢穴", "可击中"],
          props: { kind: "nest", life: "320", hitR: "26" }
        }));
        break;
      case "spawn":
        objects.push(object({
          name: o.type === "yellow" ? "黄蜘蛛" : "绿蜘蛛", kind: "ACTOR", x, y, z: 5,
          halfW: 16, halfH: 16, layerId: LAYER_ACTOR, assetId: aid(o.type === "yellow" ? "黄蜘蛛" : "绿蜘蛛"),
          tags: ["外星虫", "可击中"], modules: [lockedModule(), scriptModule("enemy")],
          props: { kind: "alien", color: o.type, hitR: o.type === "yellow" ? "14" : "12" }
        }));
        break;
      case "lamp":
        objects.push(object({
          name: "路灯", kind: "PROP", x, y, z: 3, halfW: 8, halfH: 8,
          layerId: LAYER_PROP, assetId: aid("路灯"),
          props: {
            lightRadius: String(LAMP.radius), lightColor: LAMP.color,
            lightIntensity: String(LAMP.intensity), lightType: "point",
            lightFalloff: String(LAMP.falloff), lightShadow: "1"
          }
        }));
        lampSpecs.push({ x, y });
        break;
      case "truck":
        objects.push(object({
          name: "卡车", kind: "PROP", x, y, z: 2, halfW: 32, halfH: 48,
          layerId: LAYER_PROP, assetId: aid("卡车"), tags: ["障碍"],
          props: { bw: "28", bh: "44" }
        }));
        break;
      case "sandbag":
        objects.push(object({
          name: "沙袋", kind: "PROP", x, y, z: 1, halfW: 16, halfH: 8,
          layerId: LAYER_PROP, assetId: aid("沙袋"), tags: ["障碍"],
          props: { bw: "15", bh: "7" }
        }));
        break;
      case "exit":
        objects.push(object({
          name: "入口", kind: "PROP", x, y, z: -80, halfW: 32, halfH: 32,
          layerId: LAYER_TERRAIN, assetId: aid("入口"), visible: false
        }));
        break;
      default:
        throw new Error(`未知物件类型 ${o.kind}`);
    }
  }

  // ---- 不可见控制器（脚本挂在这里） ----
  objects.push(object({
    id: "hud", name: "HUD", kind: "PROP", x: 8, y: 8, z: 0, halfW: 8, halfH: 8,
    layerId: LAYER_PROP, assetId: aid("空白"), visible: false, modules: [scriptModule("hud")]
  }));

  return { objects, lampSpecs, occluders };
}

// ============================================================================
// 光照预烘焙（同编辑器「一键烘焙」用的 lightMath.ts，结果一致）
// ============================================================================

async function loadLightMath() {
  const outfile = resolve(ROOT, "web/.build/lightMath.node.mjs");
  await build({
    entryPoints: [resolve(ROOT, "web/src/app/lightMath.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "warning"
  });
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}

async function bake(map, lampSpecs, occluders) {
  const { bakeLightmap, toRgbaBytes } = await loadLightMath();
  const W = map.W * TILE, H = map.H * TILE;
  const res = bakeLightmap({
    width: W, height: H,
    texelsPerPixel: LIGHTING.texelsPerPixel,
    softness: LIGHTING.softness,
    ambientColor: LIGHTING.ambientColor,
    ambientIntensity: LIGHTING.ambientIntensity,
    lights: lampSpecs.map((l, i) => ({
      id: `lamp-${i}`, x: l.x, y: l.y, radius: LAMP.radius, color: LAMP.color,
      intensity: LAMP.intensity, type: "point", angle: 60, dir: 0, coneSoft: 10,
      falloff: LAMP.falloff, shadow: true, flicker: 0, dynamic: false
    })),
    occluders: occluders.map((o) => ({ x: o.x, y: o.y, hw: o.hw, hh: o.hh }))
  });
  const rgba = toRgbaBytes(res.rgb);
  const img = new Canvas(res.texW, res.texH);
  img.data.set(rgba);
  return { img, res, count: lampSpecs.length };
}

// ============================================================================
// 组装
// ============================================================================

function readScript(name) {
  return readFileSync(resolve(HERE, "alien-shooter/scripts", name + ".js"), "utf8");
}

async function main() {
  const t0 = Date.now();
  const map = buildMap();
  const env = buildEnvArt();
  const actors = buildActorArt();
  const sfx = buildSfx();

  // ---- 素材 ----
  addImage("地面", composeGround(map, env.ground), "整张关卡地面（64×48 格，按字符画拼接）");
  const blank = new Canvas(4, 4);
  addImage("空白", blank, "不可见控制器 / 遮光体占位");
  for (const a of env.images) {
    addImage(a.name, a.img, a.note, a.cols ? { cols: a.cols, rows: a.rows, cellW: a.cellW, cellH: a.cellH } : {});
  }
  for (const a of actors) {
    addImage(a.name, a.img, a.note, a.cols ? { cols: a.cols, rows: a.rows, cellW: a.cellW, cellH: a.cellH } : {});
  }
  for (const s of sfx) addAudio(s.name, s.wav, `程序合成 ${s.seconds}s`);

  // ---- 对象 ----
  const { objects, lampSpecs, occluders } = buildObjects(map);

  // ---- 光照贴图 ----
  const baked = await bake(map, lampSpecs, occluders);
  const lmId = addImage("光照贴图", baked.img, `预烘焙：${baked.count} 盏路灯 + 环境光`, { group: "光照" });

  // 场景对象没有「初始帧」字段：地上的钱把帧号写在 props.frame，director 首帧 setFrame。

  const scripts = {};
  for (const n of ["player", "enemy", "combat", "fx", "director", "pickup", "grenade", "hud"]) {
    scripts[n] = { name: n, file: n + ".js", source: readScript(n), lang: "js" };
  }

  const project = {
    format: 1,
    name: "孤胆枪手",
    author: "BWE Studio",
    tileSize: TILE,
    gridW: map.W,
    gridH: map.H,
    scenes: [
      {
        id: "scene-level1",
        name: "第一关 潜入",
        originX: 0,
        originY: 0,
        widthTiles: map.W,
        heightTiles: map.H,
        layers: [
          { id: LAYER_TERRAIN, name: "地形", visible: true, locked: false, order: 0 },
          { id: LAYER_PROP, name: "物件", visible: true, locked: false, order: 0 },
          { id: LAYER_ACTOR, name: "角色", visible: true, locked: false, order: 0 }
        ],
        objects,
        onStartScript: "director",
        bgmAssetId: "",
        lighting: { ...LIGHTING },
        lightmap: {
          assetId: lmId,
          x: 0, y: 0, w: map.W * TILE, h: map.H * TILE,
          texW: baked.res.texW, texH: baked.res.texH,
          texelsPerPixel: baked.res.sEff,
          lights: baked.count,
          bakedAt: "generated",
          version: 1
        }
      }
    ],
    assets,
    packs: [],
    scripts,
    variables: {},
    masterVolume: 0.8
  };

  mkdirSync(dirname(OUT), { recursive: true });
  const json = JSON.stringify(project);
  writeFileSync(OUT, json);
  const kinds = {};
  for (const o of objects) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
  console.log(
    `[gen-alien-shooter] ${OUT}\n` +
    `  ${(json.length / 1024).toFixed(0)} KB，素材 ${assets.length}，对象 ${objects.length} ${JSON.stringify(kinds)}，` +
    `遮光体 ${occluders.length}，路灯 ${lampSpecs.length}，光照贴图 ${baked.res.texW}×${baked.res.texH}（${baked.res.ms.toFixed(0)}ms），` +
    `用时 ${Date.now() - t0}ms`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
