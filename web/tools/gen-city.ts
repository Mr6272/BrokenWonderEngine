/**
 * 开放世界城市生成器 v2（BWE Studio 工程的「数据源」）。
 * 确定性：固定种子 ⇒ 同城市，可回归测试。
 * 产物：scenes[0].objects[] / buildings[] / navLinks[] / roadNetwork{}，scripts{player,world}
 * 两段脚本最前面都会前置 `var CITY = {...};`（仓库里的 .js 文件本身不动）。
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, createScene, createObject, uid } from "../src/core/model.ts";
import type { Project, SceneModel, SceneObject } from "../src/core/model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TILE = 32;
const GRID_W = 128;
const GRID_H = 96;
const MAP_W = GRID_W * TILE;
const MAP_H = GRID_H * TILE;
const WALL = 8;

type RoadClass = "avenue" | "street" | "alley";
const ROAD_W: Record<RoadClass, number> = { avenue: 6 * TILE, street: 3 * TILE, alley: 2 * TILE };
const WALK_W: Record<RoadClass, number> = { avenue: 2 * TILE, street: 1 * TILE, alley: 0 };
const ROAD_LIMIT: Record<RoadClass, number> = { avenue: 240, street: 180, alley: 100 };
const L_GROUND = 0, L_BUILD = 1, L_PROPS = 2, L_ACTOR = 3;

type Rect = [number, number, number, number];
type AssetTable = Record<string, any>;

function overlap(a: Rect, b: Rect, pad = 0): boolean {
  return a[0] < b[0] + b[2] + pad && b[0] < a[0] + a[2] + pad && a[1] < b[1] + b[3] + pad && b[1] < a[1] + a[3] + pad;
}
function inside(r: Rect, x: number, y: number, pad = 0): boolean {
  return x >= r[0] + pad && x <= r[0] + r[2] - pad && y >= r[1] + pad && y <= r[1] + r[3] - pad;
}
function ptInRect(x: number, y: number, r: Rect, pad = 0): boolean {
  return x >= r[0] + pad && x < r[0] + r[2] - pad && y >= r[1] + pad && y < r[1] + r[3] - pad;
}
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rint = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

function loadAssets(): AssetTable {
  const file = resolve(HERE, "..", "examples", "city", "assets.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as any[];
  const table: AssetTable = {};
  for (const a of raw) table[a.name] = a;
  return table;
}

/**
 * 「人可以穿过去」的标签白名单 —— 这些 PROP 即使在地面层也不登记为阻挡。
 *
 * <p>地毯/贴花/标线/斑马线/路缘/地面/门洞都是纯装饰或地面提示，挡人会让
 * 人行横道和店门口变得卡顿；拾取物要能走上去捡。
 */
const SOLID_EXCLUDE = ["rug", "decal", "mark", "zebra", "curb", "ground", "door", "pickup", "link", "stairs", "floor", "roof", "furniture", "interior"];

/**
 * 剔除「压住行人路网节点」的阻挡矩形。
 *
 * <p>为什么必须剔：行人路径是预计算的图（节点 + 边），节点位置算好之后才生成道具。
 * 道具一旦登记为阻挡又正好盖住节点，行人就会走到那里永久卡死 —— 实测加 solids
 * 前 crossings=14、加完掉到 0。
 *
 * <p>只影响「挡不挡人」，不影响绘制：道具照常画，只是不参与碰撞。
 */
function filterWalkBlocking(
  solids: number[][],
  nodes: { x: number; y: number }[],
  edges: { a: number; b: number }[],
): number[][] {
  if (!nodes || !nodes.length) return solids;
  const pad = 6;
  const out: number[][] = [];
  for (const s of solids) {
    let blocked = false;
    // 1) 节点本身
    for (const n of nodes) {
      if (n.x >= s[0] - pad && n.x <= s[0] + s[2] + pad && n.y >= s[1] - pad && n.y <= s[1] + s[3] + pad) {
        blocked = true;
        break;
      }
    }
    // 2) 边的中段（按 8px 采样）：道具挡在路中间同样会让行人卡死
    if (!blocked && edges && edges.length) {
      for (const e of edges) {
        const a = nodes[e.a], b2 = nodes[e.b];
        if (!a || !b2) continue;
        // 边长超过 2*tile 的粗筛：只看包围盒可能相交的边
        const bx0 = Math.min(a.x, b2.x) - pad, bx1 = Math.max(a.x, b2.x) + pad;
        const by0 = Math.min(a.y, b2.y) - pad, by1 = Math.max(a.y, b2.y) + pad;
        if (s[0] > bx1 || s[0] + s[2] < bx0 || s[1] > by1 || s[1] + s[3] < by0) continue;
        const d = Math.hypot(b2.x - a.x, b2.y - a.y);
        const n = Math.max(1, Math.ceil(d / 8));
        for (let t = 0; t <= n; t++) {
          const x = a.x + (b2.x - a.x) * t / n;
          const y = a.y + (b2.y - a.y) * t / n;
          if (x >= s[0] - pad && x <= s[0] + s[2] + pad && y >= s[1] - pad && y <= s[1] + s[3] + pad) {
            blocked = true;
            break;
          }
        }
        if (blocked) break;
      }
    }
    if (!blocked) out.push(s);
  }
  return out;
}

class Builder {
  objects: SceneObject[] = [];
  layerIds: string[];
  assets: AssetTable;
  missing = new Set<string>();
  /**
   * 阻挡矩形表：[x, y, w, h]（左上角 + 尺寸），只在<b>地面层</b>生效。
   *
   * <p>为什么要单独一张表：场景物件（树/路灯/长椅/消防栓/雕塑/喷泉…）原本
   * `props.solid = "0"` 且**整个引擎没有任何代码读它** —— 于是玩家可以直接穿过
   * 树干、穿过停在路边的车。这里把这些「看起来是实体」的物件按包围盒收进
   * `CITY.solids`，由 player.js 的碰撞查询统一消费。
   */
  solids: number[][] = [];
  constructor(assets: AssetTable, layerIds: string[]) { this.assets = assets; this.layerIds = layerIds; }

  /**
   * 行人路网节点（由 buildCity 在路网建好后注入）。
   *
   * <p>用途：登记阻挡时跳过「压住步行节点」的道具。行人路径是一张预计算的图，
   * 节点先算好，被道具盖住就必然卡死 —— 实测加 solids 前 crossings=14、
   * 加完掉到 0，就是 34 个节点被交通灯压住造成的。
   *
   * <p>只跳过<b>登记</b>，道具本身照常绘制 —— 视觉不变，只是"这里不挡人"。
   */
  walkNodes: { x: number; y: number }[] = [];

  setWalkNodes(nodes: { x: number; y: number }[]): void {
    this.walkNodes = nodes || [];
  }

  /** 该矩形是否压住了行人路网节点（pad 给行人留一点身位）。 */
  private blocksWalkNode(x: number, y: number, w: number, h: number): boolean {
    const pad = 6;
    for (const n of this.walkNodes) {
      if (n.x >= x - pad && n.x <= x + w + pad && n.y >= y - pad && n.y <= y + h + pad) {
        return true;
      }
    }
    return false;
  }

  /** 登记一个阻挡矩形（世界坐标，左上角 + 尺寸）。 */
  solid(x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    if (this.blocksWalkNode(x, y, w, h)) return;
    this.solids.push([Math.round(x), Math.round(y), Math.round(w), Math.round(h)]);
  }
  add(
    key: string, name: string, kind: "TILE" | "PROP" | "ZONE" | "ACTOR",
    cx: number, cy: number, w: number, h: number,
    layer: number, z: number, tags: string[],
    opts: { color?: string; visible?: boolean; props?: Record<string, string> } = {}
  ): SceneObject {
    const o = createObject(kind, Math.round(cx * 2) / 2, Math.round(cy * 2) / 2);
    o.name = name; o.z = z; o.rotation = 0;
    o.layerId = this.layerIds[layer];
    o.tags = tags.slice();
    o.halfW = w / 2; o.halfH = h / 2;
    o.props = { color: opts.color || "#808080", solid: "0", ...(opts.props || {}) };
    if (opts.visible === false) o.visible = false;
    const a = key ? this.assets[key] : null;
    if (a) {
      o.assetId = a.id; o.assetName = a.name;
      o.scaleX = w / (a.cellW || a.width); o.scaleY = h / (a.cellH || a.height);
      if (a.name.indexOf("tile-") === 0 && o.tags.indexOf("tile") < 0) o.tags.push("tile");
    } else if (key) this.missing.add(key);
    // ★ 实体物件自动登记为阻挡：只有「地面层的道具」才算，楼板/家具/屋顶/贴花不算。
    //
    // 判据是标签 + 层号，不是 asset 名（asset 名会变，标签是稳定的语义）：
    //   - 必须是 PROP（地块 TILE / 区域 ZONE 不挡路）
    //   - 必须在地面层（L_PROPS）；建筑内部（L_BUILD）由 CITY.walls 负责，不重复登记
    //   - 排除「人可以踩上去/穿过去」的东西：地毯、贴花、标线、斑马线、路缘、地面、门
    const isProp = kind === "PROP";
    const onGroundLayer = layer === L_PROPS;
    const passable = tags.some((t) => SOLID_EXCLUDE.indexOf(t) >= 0);
    if (isProp && onGroundLayer && !passable) {
      this.solid(cx - w / 2, cy - h / 2, w, h);
    }
    this.objects.push(o);
    return o;
  }
  rect(key: string, name: string, kind: "TILE" | "PROP" | "ZONE", r: Rect, layer: number, z: number, tags: string[],
    opts: { color?: string; visible?: boolean; props?: Record<string, string> } = {}): SceneObject {
    return this.add(key, name, kind, r[0] + r[2] / 2, r[1] + r[3] / 2, r[2], r[3], layer, z, tags, opts);
  }
}

// =========================================================================
// 路网定义（tile 坐标；车道宽 192/96/64）
// =========================================================================

interface RoadDef { id: string; cls: RoadClass; dir: "h" | "v"; at: number; from: number; to: number; name: string }
const ROADS: RoadDef[] = [
  { id: "V1", cls: "street", dir: "v", at: 8, from: 8, to: 88, name: "枫树街" },
  { id: "V2", cls: "avenue", dir: "v", at: 34, from: 8, to: 88, name: "自由大道" },
  { id: "V3", cls: "street", dir: "v", at: 62, from: 8, to: 61, name: "画廊街" },
  { id: "V4", cls: "street", dir: "v", at: 84, from: 8, to: 88, name: "港口街" },
  { id: "V5", cls: "street", dir: "v", at: 112, from: 30, to: 88, name: "东岸街" },
  { id: "H1", cls: "street", dir: "h", at: 8, from: 8, to: 115, name: "北环路" },
  { id: "H2", cls: "avenue", dir: "h", at: 30, from: 8, to: 115, name: "中央大道" },
  { id: "H3", cls: "street", dir: "h", at: 58, from: 8, to: 115, name: "市场街" },
  { id: "H4", cls: "street", dir: "h", at: 78, from: 34, to: 115, name: "码头路" },
  { id: "A1", cls: "alley", dir: "v", at: 48, from: 30, to: 61, name: "咖啡巷" },
  { id: "A2", cls: "alley", dir: "h", at: 71, from: 84, to: 115, name: "仓库巷" },
];
function roadW(r: RoadDef) { return ROAD_W[r.cls]; }
function carriageOf(r: RoadDef): Rect {
  const w = roadW(r);
  return r.dir === "v"
    ? [r.at * TILE, r.from * TILE, w, (r.to - r.from) * TILE]
    : [r.from * TILE, r.at * TILE, (r.to - r.from) * TILE, w];
}
function roadCenter(r: RoadDef): number { return r.at * TILE + roadW(r) / 2; }
function degOf(v: RoadDef, h: RoadDef): number {
  const vThrough = v.from < h.at && v.to > h.at;
  const hThrough = h.from < v.at && h.to > v.at;
  return vThrough && hThrough ? 4 : 3;
}
interface VHCross { v: RoadDef; h: RoadDef; box: Rect }
interface Junction { key: string; box: Rect; x: number; y: number; roads: RoadDef[]; deg: number }

// =========================================================================
// 地面 tile 分类（tile 网格 → 矩形条 → 少量大 PROP）
// =========================================================================

const GX = GRID_W, GY = GRID_H;
let CELLS = new Uint8Array(GX * GY);
const cellAt = (x: number, y: number) => (x < 0 || y < 0 || x >= GX || y >= GY) ? 0 : CELLS[y * GX + x];
const setCell = (x: number, y: number, v: number) => {
  if (x >= 0 && y >= 0 && x < GX && y < GY) {
    if (process.env.DBG_SET === "1" && x === 5 && y === 20) {
      const sp = new Error().stack || "";
      console.log("DBG set(5,20)=" + v + " stack=" + sp.split(NL).slice(1, 5).join(" | "));
    }
    CELLS[y * GX + x] = v;
  }
};
const isAsphalt = (v: number) => v === 11 || v === 12;
function paintCells(x0: number, y0: number, x1: number, y1: number, v: number) {
  for (let y = Math.max(0, y0); y < Math.min(GY, y1); y++) for (let x = Math.max(0, x0); x < Math.min(GX, x1); x++) setCell(x, y, v);
}

const GROUND: Record<number, { key: string; tags: string[]; color: string; tile?: boolean }> = {
  1: { key: "tile-grass", tags: ["grass", "ground"], color: "#4b7a3a" },
  2: { key: "tile-grass-park", tags: ["grass", "park", "ground"], color: "#57894a" },
  3: { key: "tile-plaza", tags: ["plaza", "ground"], color: "#9c9384" },
  4: { key: "tile-marble", tags: ["marble", "plaza", "ground"], color: "#d9d9d9" },
  5: { key: "tile-dirt-path", tags: ["path", "ground"], color: "#8f7c55" },
  6: { key: "tile-parking", tags: ["parking", "ground"], color: "#71736e" },
  7: { key: "tile-water", tags: ["water", "ground"], color: "#2f5f8a", tile: true },
  8: { key: "tile-boardwalk", tags: ["boardwalk", "ground"], color: "#a07a4a" },
  9: { key: "tile-sidewalk", tags: ["sidewalk", "ground"], color: "#b9b7ae" },
  10: { key: "tile-sidewalk-brick", tags: ["sidewalk", "ground"], color: "#a4736a" },
  11: { key: "tile-asphalt", tags: ["road", "asphalt", "ground"], color: "#46484c" },
  12: { key: "tile-asphalt-alley", tags: ["road", "alley", "asphalt", "ground"], color: "#50535a" },
};

// =========================================================================
// 行人路网
// =========================================================================
interface WalkNode { x: number; y: number; kind: number }
interface WalkEdge { a: number; b: number; kind: number }
class WalkGraph {
  nodes: WalkNode[] = []; edges: WalkEdge[] = []; map = new Map<number, number>();
  keyOf(x: number, y: number) { return Math.round(x / 2) * 100003 + Math.round(y / 2); }
  add(x: number, y: number, kind: number): number {
    const k = this.keyOf(x, y);
    let i = this.map.get(k);
    if (i === undefined) { i = this.nodes.length; this.nodes.push({ x: Math.round(x), y: Math.round(y), kind }); this.map.set(k, i); }
    this.nodes[i].kind = Math.max(this.nodes[i].kind, kind);
    return i;
  }
  nodeAt(x: number, y: number): number { const i = this.map.get(this.keyOf(x, y)); return i === undefined ? -1 : i; }
  link(a: number, b: number, kind: number) { if (a >= 0 && b >= 0 && a !== b) this.edges.push({ a, b, kind }); }
}

interface BuildResult {
  scene: SceneModel; buildings: any[]; navLinks: any[]; roadNodes: any[]; roadEdges: any[]; walls: number[][];
  CITY: any; objects: SceneObject[];
  roadJunctions: Junction[]; cells: Uint8Array; walk: WalkGraph; routeStops: number[][];
}

// =========================================================================
// 建筑定义表（tile 坐标）
// =========================================================================

type BKind = "shop" | "cafe" | "house" | "apartment" | "tower" | "hospital" | "warehouse";
interface BDef {
  name: string; kind: BKind; district: string;
  tx: number; ty: number; tw: number; th: number; floors: number;
  door: "N" | "S" | "E" | "W"; roof?: "red" | "blue" | "brown" | "flatdark" | "tower" | "hospital";
  hedges?: boolean;
}

const BDEFS: BDef[] = [
  { name: "圣玛利亚医院", kind: "hospital", district: "civic", tx: 18, ty: 38, tw: 14, th: 10, floors: 2, door: "E" },
  { name: "24 小时便利店", kind: "shop", district: "civic", tx: 17, ty: 51, tw: 5, th: 5, floors: 1, door: "E" },
  { name: "枫叶巷 8 号", kind: "house", district: "residential", tx: 12, ty: 13, tw: 9, th: 6, floors: 2, door: "N", roof: "red", hedges: true },
  { name: "枫叶巷 9 号", kind: "house", district: "residential", tx: 23, ty: 13, tw: 9, th: 6, floors: 1, door: "N", roof: "blue", hedges: true },
  { name: "枫叶巷 3 号", kind: "house", district: "residential", tx: 12, ty: 21, tw: 10, th: 6, floors: 2, door: "S", roof: "brown", hedges: true },
  { name: "枫叶巷 4 号", kind: "house", district: "residential", tx: 22, ty: 21, tw: 10, th: 6, floors: 1, door: "S", roof: "red", hedges: true },
  { name: "自由大厦", kind: "tower", district: "downtown", tx: 44, ty: 13, tw: 11, th: 13, floors: 5, door: "S", roof: "tower" },
  { name: "港湾金融中心", kind: "tower", district: "downtown", tx: 56, ty: 13, tw: 5, th: 9, floors: 4, door: "E", roof: "tower" },
  { name: "港景公寓 A", kind: "apartment", district: "residential", tx: 90, ty: 13, tw: 10, th: 9, floors: 3, door: "S", roof: "flatdark" },
  { name: "港景公寓 B", kind: "apartment", district: "residential", tx: 117, ty: 13, tw: 10, th: 9, floors: 3, door: "S", roof: "flatdark" },
  { name: "东湾路 1 号", kind: "house", district: "residential", tx: 89, ty: 23, tw: 7, th: 4, floors: 1, door: "W", roof: "red" },
  { name: "东湾路 2 号", kind: "house", district: "residential", tx: 118, ty: 23, tw: 6, th: 4, floors: 1, door: "S", roof: "blue" },
  { name: "正好商品杂货", kind: "shop", district: "shopping", tx: 42, ty: 38, tw: 6, th: 8, floors: 1, door: "N" },
  { name: "星光唱片", kind: "cafe", district: "shopping", tx: 50, ty: 38, tw: 5, th: 7, floors: 2, door: "N" },
  { name: "李记精品", kind: "shop", district: "shopping", tx: 55, ty: 38, tw: 6, th: 8, floors: 2, door: "N" },
  { name: "巷口咖啡", kind: "cafe", district: "shopping", tx: 42, ty: 49, tw: 6, th: 8, floors: 1, door: "S" },
  { name: "巷角书店", kind: "shop", district: "shopping", tx: 50, ty: 50, tw: 5, th: 7, floors: 1, door: "S" },
  { name: "画廊咖啡", kind: "cafe", district: "shopping", tx: 56, ty: 50, tw: 5, th: 7, floors: 1, door: "E" },
  { name: "码头塔写字楼", kind: "tower", district: "downtown", tx: 66, ty: 38, tw: 10, th: 10, floors: 4, door: "N", roof: "tower" },
  { name: "创意园写字楼", kind: "tower", district: "downtown", tx: 71, ty: 49, tw: 6, th: 8, floors: 3, door: "E", roof: "tower" },
  { name: "港货物站", kind: "shop", district: "shopping", tx: 88, ty: 38, tw: 7, th: 8, floors: 1, door: "N" },
  { name: "服装屋", kind: "shop", district: "shopping", tx: 95, ty: 38, tw: 5, th: 7, floors: 1, door: "N" },
  { name: "海浪咖啡", kind: "cafe", district: "shopping", tx: 101, ty: 38, tw: 6, th: 7, floors: 1, door: "N" },
  { name: "五金店", kind: "shop", district: "shopping", tx: 88, ty: 49, tw: 7, th: 8, floors: 1, door: "W" },
  { name: "面包烘焙", kind: "cafe", district: "shopping", tx: 95, ty: 49, tw: 6, th: 7, floors: 1, door: "S" },
  { name: "东岸街 1 号", kind: "house", district: "residential", tx: 117, ty: 40, tw: 8, th: 6, floors: 2, door: "W", hedges: true },
  { name: "东岸街 2 号", kind: "house", district: "residential", tx: 117, ty: 49, tw: 7, th: 5, floors: 1, door: "W", hedges: true },
  { name: "市场街 1 号", kind: "house", district: "residential", tx: 12, ty: 63, tw: 9, th: 6, floors: 1, door: "N", hedges: true },
  { name: "市场街 2 号", kind: "house", district: "residential", tx: 12, ty: 74, tw: 8, th: 6, floors: 2, door: "S", hedges: true },
  { name: "市场街 3 号", kind: "house", district: "residential", tx: 23, ty: 64, tw: 8, th: 7, floors: 1, door: "N", hedges: true },
  { name: "市场街 4 号", kind: "apartment", district: "residential", tx: 102, ty: 82, tw: 8, th: 6, floors: 1, door: "N", hedges: true },
  { name: "忠犬咖啡", kind: "cafe", district: "shopping", tx: 42, ty: 62, tw: 7, th: 8, floors: 1, door: "S" },
  { name: "书报亭", kind: "shop", district: "shopping", tx: 50, ty: 62, tw: 6, th: 7, floors: 1, door: "S" },
  { name: "花艺馆", kind: "shop", district: "shopping", tx: 57, ty: 62, tw: 6, th: 8, floors: 2, door: "S" },
  { name: "喜乐面包", kind: "cafe", district: "shopping", tx: 67, ty: 62, tw: 7, th: 7, floors: 1, door: "S" },
  { name: "湖畔小馆", kind: "cafe", district: "shopping", tx: 75, ty: 62, tw: 8, th: 6, floors: 1, door: "S" },
  { name: "冷库一号", kind: "warehouse", district: "industrial", tx: 89, ty: 62, tw: 6, th: 7, floors: 1, door: "N" },
  { name: "冷库二号", kind: "warehouse", district: "industrial", tx: 100, ty: 62, tw: 11, th: 9, floors: 1, door: "W" },
  { name: "物流仓", kind: "warehouse", district: "industrial", tx: 97, ty: 73, tw: 11, th: 4, floors: 1, door: "S" },
];

function buildCity(seed: number): BuildResult {
  const rand = rng(seed);
  const assets = loadAssets();
  const layerNames = ["地面 Ground", "建筑 Buildings", "物件 Props", "角色 Actors"];
  const layerIds = layerNames.map(() => uid());
  const layers = layerNames.map((name, i) => ({ id: layerIds[i], name, visible: true, locked: false, order: i }));
  const scene = createScene("自由城 Liberty Heights", GRID_W, GRID_H);
  scene.layers = layers as any;
  const b = new Builder(assets, layerIds);
  const walk = new WalkGraph();
  const walls: number[][] = [];
  const buildings: any[] = [];
  const navLinks: any[] = [];
  const roadNodes: any[] = [];
  const roadEdges: any[] = [];
  const parkNodes: number[] = [];
  const bridgeStops: number[] = [];

  // ---- 地面底色 ----
  paintCells(0, 0, GX, GY, 1);           // 草地底板
  paintCells(0, 0, GX, 8, 1);            // 北缘绿化带
  paintCells(0, 30, 8, 88, 1);           // 西缘绿化带
  paintCells(65, 12, 84, 30, 2);         // 公园草地
  paintCells(0, 82, GX, 86, 2);          // 水岸带（草地）
  paintCells(41, 12, 62, 30, 3);         // 市中心北（塔楼/广场底板）
  paintCells(11, 38, 33, 58, 3);         // 医院广场
  paintCells(65, 38, 84, 58, 3);         // 市中心南（写字楼）
  paintCells(88, 38, 113, 58, 3);        // 东岸街（店铺/庭院）
  paintCells(41, 63, 84, 70, 3);         // 市场街店铺
  paintCells(41, 76, 84, 78, 6);         // 码头路停车场
  paintCells(88, 62, 113, 70, 6);        // 工业 yard 北
  paintCells(88, 72, 113, 78, 6);        // 工业 yard 南
  paintCells(2, 12, 33, 30, 1);          // 西北住宅（带院子）
  paintCells(2, 63, 33, 82, 1);          // 市场街住宅
  paintCells(88, 12, 128, 28, 1);        // 东北住宅
  paintCells(115, 30, 128, 62, 1);       // 东岸街住宅
  paintCells(115, 62, 128, 78, 1);       // 东岸街住宅
  paintCells(0, 63, 8, 82, 1);           // 西南住宅
  paintCells(42, 49, 62, 57, 6);         // 东南小市场 停车场底板
  paintCells(18, 51, 24, 57, 4);         // 医院广场 大理石中心
  paintCells(51, 26, 56, 29, 4);         // 市中心塔楼 大理石
  paintCells(9, 86, 115, 88, 8);         // 木栈道
  paintCells(0, 88, GX, GY, 7);          // 水体

  // ---- 人行道（扩展 span 内）+ 车行道 ----
  function brickZone(x: number, y: number): boolean {
    return (x >= 31 && x <= 90 && y >= 28 && y <= 64);
  }
  for (const r of ROADS) {
    const w = WALK_W[r.cls];
    if (w > 0) {
      const c = carriageOf(r);
      if (process.env.DBG_SET === "1") console.log("DBG road", r.id, "c=", c, "w=", w);
      const rects: Rect[] = r.dir === "v"
        ? [[c[0] - w, c[1], w, c[3]], [c[0] + c[2], c[1], w, c[3]]]
        : [[c[0], c[1] - w, c[2], w], [c[0], c[1] + c[3], c[2], w]];
      for (const wr of rects) {
        const x0 = Math.floor(wr[0] / TILE), x1 = Math.ceil((wr[0] + wr[2]) / TILE);
        const y0 = Math.floor(wr[1] / TILE), y1 = Math.ceil((wr[1] + wr[3]) / TILE);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          void x0; void y0; void x1; void y1;
          setCell(x, y, brickZone(x, y) ? 10 : 9);
        }
      }
    }
  }
  for (const r of ROADS) {
    const code = r.cls === "alley" ? 12 : 11;
    const c = carriageOf(r);
    const x0 = Math.floor(c[0] / TILE), x1 = Math.ceil((c[0] + c[2]) / TILE);
    const y0 = Math.floor(c[1] / TILE), y1 = Math.ceil((c[1] + c[3]) / TILE);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setCell(x, y, code);
  }

  // ---- 住宅门前小路 + 院子（tile-dirt-path 走道）----
  for (const def of BDEFS) {
    if (def.kind !== "house" && def.kind !== "apartment") continue;
    // 楼门有 N/S/E/W 方向,从门中心往外推 2~3 tiles 的小路
    const ox = def.tx * TILE, oy = def.ty * TILE, w = def.tw * TILE, h = def.th * TILE;
    const cx = ox + w / 2, cy = oy + h / 2;
    if (def.door === "N" || def.door === "S") {
      const gx = ox + Math.floor((w - 32) / 2 / 32) * 32;
      const baseY = def.door === "N" ? oy : oy + h;
      const dir = def.door === "N" ? -1 : 1;
      for (let t = 1; t <= 3; t++) {
        const y = baseY + dir * t * TILE - (dir === -1 ? TILE : 0);
        setCell(Math.floor((gx + TILE / 2) / TILE) + t - 1, Math.floor(y / TILE), 5);
        setCell(Math.floor((gx + TILE / 2) / TILE) + t - 1, Math.floor(y / TILE) + (dir === -1 ? 1 : 0), 5);
      }
    } else {
      const gy2 = oy + Math.floor((h - 32) / 2 / 32) * 32;
      const baseX = def.door === "W" ? ox : ox + w;
      const dir = def.door === "W" ? -1 : 1;
      for (let t = 1; t <= 3; t++) {
        const x = baseX + dir * t * TILE - (dir === -1 ? TILE : 0);
        setCell(Math.floor(x / TILE) + (dir === -1 ? 1 : 0), Math.floor((gy2 + TILE / 2) / TILE) + t - 1, 5);
        setCell(Math.floor(x / TILE) + (dir === -1 ? 1 : 0), Math.floor((gy2 + TILE / 2) / TILE) + t, 5);
      }
    }
    void cx; void cy;
  }

  // ---- 地面合并矩形并输出 ----
  {
    interface P { v: number; x0: number; x2: number; y0: number; y1: number }
    const pending: P[] = [];
    const done: P[] = [];
    for (let y = 0; y < GY; y++) {
      let x = 0;
      while (x < GX) {
        const v = cellAt(x, y);
        if (v === 0) { x++; continue; }
        let x2 = x + 1;
        while (x2 < GX && cellAt(x2, y) === v) x2++;
        let merged = false;
        for (let i = pending.length - 1; i >= 0; i--) {
          const p = pending[i];
          if (p.v === v && p.x0 === x && p.x2 === x2 && p.y1 === y) { p.y1 = y + 1; merged = true; break; }
        }
        if (!merged) pending.push({ v, x0: x, x2, y0: y, y1: y + 1 });
        x = x2;
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].y1 === y) { done.push(pending[i]); pending.splice(i, 1); }
      }
    }
    for (const p of pending) done.push(p);
    for (const p of done) {
      const def = GROUND[p.v] || GROUND[1];
      const r: Rect = [p.x0 * TILE, p.y0 * TILE, (p.x2 - p.x0) * TILE, (p.y1 - p.y0) * TILE];
      b.rect(def.key, `地面 ${def.key} ${Math.round(r[0] / TILE)}_${Math.round(r[1] / TILE)}`,
        def.tile ? "TILE" : "PROP", r, L_GROUND, 0, ["tile", ...def.tags], { color: def.color });
    }
  }

  // =========================================================================
  // 标线 / 斑马线 / 路缘 / 路网 / 红绿灯
  // =========================================================================
  const VS = ROADS.filter((r) => r.dir === "v");
  const HS = ROADS.filter((r) => r.dir === "h");
  const junctions: Junction[] = [];
  for (const v of VS) for (const h of HS) {
    const cv = carriageOf(v), ch = carriageOf(h);
    const bx0 = Math.max(cv[0], ch[0]);
    const bx1 = Math.min(cv[0] + cv[2], ch[0] + ch[2]);
    const by0 = Math.max(cv[1], ch[1]);
    const by1 = Math.min(cv[1] + cv[3], ch[1] + ch[3]);
    if (bx0 >= bx1 || by0 >= by1) continue;
    const box: Rect = [bx0, by0, bx1 - bx0, by1 - by0];
    junctions.push({ key: v.id + "@" + h.id, box, x: box[0] + box[2] / 2, y: box[1] + box[3] / 2, roads: [v, h], deg: degOf(v, h) });
  }
  const alleyJunctions = junctions.filter((j) => j.roads.some((r) => r.cls === "alley"));
  const mainJunctions = junctions.filter((j) => !j.roads.some((r) => r.cls === "alley"));

  // 斑马线：每个主路口的每条手臂，贴路口外沿（手臂方向由所穿过的对方路决定）
  for (const j of mainJunctions) {
    const v = j.roads[0], h = j.roads[1];
    const vc = carriageOf(v), hc = carriageOf(h);
    const bandW = WALK_W[h.cls];   // 竖路手臂 zebra 厚度
    const bandH = WALK_W[v.cls];   // 横路手臂 zebra 厚度
    if (v.from * TILE < j.box[1]) b.add("tile-zebra-h", v.id + "-斑马线N", "PROP", vc[0] + vc[2] / 2, j.box[1] - bandH / 2, vc[2], bandH, L_GROUND, 1, ["tile", "zebra", "mark"], {});
    if (v.to * TILE > j.box[1] + j.box[3]) b.add("tile-zebra-h", v.id + "-斑马线S", "PROP", vc[0] + vc[2] / 2, j.box[1] + j.box[3] + bandH / 2, vc[2], bandH, L_GROUND, 1, ["tile", "zebra", "mark"], {});
    if (h.from * TILE < j.box[0]) b.add("tile-zebra-h", h.id + "-斑马线W", "PROP", j.box[0] - bandW / 2, hc[1] + hc[3] / 2, bandW, hc[3], L_GROUND, 1, ["tile", "zebra", "mark"], {});
    if (h.to * TILE > j.box[0] + j.box[2]) b.add("tile-zebra-h", h.id + "-斑马线E", "PROP", j.box[0] + j.box[2] + bandW / 2, hc[1] + hc[3] / 2, bandW, hc[3], L_GROUND, 1, ["tile", "zebra", "mark"], {});
  }

  // 标线：street 中心白虚线；avenue 中心双黄线 + 两侧白虚线
  function junctionBreaks(r: RoadDef): [number, number][] {
    const out: [number, number][] = [];
    const pad = 64;
    for (const j of mainJunctions) {
      if (j.roads[0] !== r && j.roads[1] !== r) continue;
      const a = r.dir === "v" ? j.box[1] - pad : j.box[0] - pad;
      const e = r.dir === "v" ? j.box[1] + j.box[3] + pad : j.box[0] + j.box[2] + pad;
      out.push([a, e]);
    }
    return out;
  }
  function placeStrip(r: RoadDef, from: number, to: number, key: string, name: string, w: number, h: number, tags: string[], offA: number, offB: number) {
    if (to - from < 32) return;
    if (r.dir === "v") {
      const y0 = Math.ceil(from / 32) * 32, y1 = Math.floor(to / 32) * 32;
      if (y1 - y0 < 32) return;
      b.add(key, name + "-v", "PROP", roadCenter(r) + offA, y0 + (y1 - y0) / 2, w, y1 - y0, L_GROUND, 1, ["tile", ...tags], {});
    } else {
      const x0 = Math.ceil(from / 32) * 32, x1 = Math.floor(to / 32) * 32;
      if (x1 - x0 < 32) return;
      b.add(key, name + "-h", "PROP", x0 + (x1 - x0) / 2, roadCenter(r) + offB, x1 - x0, h, L_GROUND, 1, ["tile", ...tags], {});
    }
  }
  for (const r of ROADS) {
    if (r.cls === "alley") continue;
    const breaks = junctionBreaks(r).sort((p, q) => p[0] - q[0]);
    let a = r.dir === "v" ? r.from * TILE : r.from * TILE;
    const lim = r.dir === "v" ? r.to * TILE : r.to * TILE;
    const segs: [number, number][] = [];
    for (const bk of breaks) { if (bk[0] > a + 32) segs.push([a, Math.min(bk[0], lim)]); a = Math.max(a, bk[1]); }
    if (a + 32 < lim) segs.push([a, lim]);
    const dashKey = r.dir === "v" ? "tile-line-dash-v" : "tile-line-dash-h";
    const yellowKey = r.dir === "v" ? "tile-line-yellow-v" : "tile-line-yellow-h";
    if (r.cls === "street") {
      for (const [s, e] of segs) placeStrip(r, s, e, dashKey, r.id + " 虚线中线", 6, 32, ["mark", "line"], 0, 0);
    } else {
      for (const [s, e] of segs) {
        placeStrip(r, s, e, yellowKey, r.id + " 双黄线", 8, 32, ["mark", "line"], 0, 0);
        placeStrip(r, s, e, dashKey, r.id + " 车道虚线", 4, 32, ["mark", "line"], -48, 0);
        placeStrip(r, s, e, dashKey, r.id + " 车道虚线", 4, 32, ["mark", "line"], 48, 0);
      }
    }
  }

  // 路缘：主路两侧 1 条长条，路口处让开（由 junctionBreaks 给出中断区间）
  for (const r of ROADS) {
    if (r.cls === "alley") continue;
    const bw = WALK_W[r.cls];
    if (bw <= 0) continue;
    const breaks = junctionBreaks(r).sort((p3, q3) => p3[0] - q3[0]);
    const segs: [number, number][] = [];
    let a = 0;
    const lim = r.to * TILE;
    for (const bk of breaks) { if (bk[0] > a + 32) segs.push([a, Math.min(bk[0], lim)]); a = Math.max(a, bk[1]); }
    if (a + 32 < lim) segs.push([a, lim]);
    for (const [s0, e0] of segs) {
      if (r.dir === "v") {
        const c = carriageOf(r);
        for (const side of [-1, 1]) {
          const x = c[0] + (side < 0 ? -4 : c[2]);
          b.rect("", "路缘", "PROP", [x, s0, 4, e0 - s0], L_GROUND, 2, ["tile", "curb"], { color: "#3a3d44" });
        }
      } else {
        const c = carriageOf(r);
        for (const side of [-1, 1]) {
          const y = c[1] + (side < 0 ? -4 : c[3]);
          b.rect("", "路缘", "PROP", [s0, y, e0 - s0, 4], L_GROUND, 2, ["tile", "curb"], { color: "#3a3d44" });
        }
      }
    }
  }

  // =========================================================================
  // 路网节点 / 边 / 红绿灯
  // =========================================================================
  const nodeMap = new Map<string, number>();
  function roadNode(x: number, y: number, kind: "intersection" | "waypoint"): number {
    const k = Math.round(x) + "_" + Math.round(y);
    const i = nodeMap.get(k);
    if (i !== undefined) return i;
    const id = "n_" + roadNodes.length;
    roadNodes.push({ id, x, y, kind });
    nodeMap.set(k, roadNodes.length - 1);
    return roadNodes.length - 1;
  }
  for (const r of ROADS) {
    const pts: [number, number][] = [];
    if (r.dir === "v") {
      const cx = roadCenter(r);
      const js = junctions.filter((j) => j.roads.some((q) => q === r)).map((j) => j.y).sort((p, q) => p - q);
      const allY = Array.from(new Set(js)).filter((y) => y > r.from * TILE + 8 && y < r.to * TILE - 8).sort((p, q) => p - q);
      const final: number[] = [];
      for (let i = 0; i < allY.length; i++) {
        final.push(allY[i]);
        if (i + 1 < allY.length && allY[i + 1] - allY[i] > 640) final.push(Math.round((allY[i] + allY[i + 1]) / 2));
      }
      for (const y of final) pts.push([cx, y]);
    } else {
      const cy = roadCenter(r);
      const js = junctions.filter((j) => j.roads.some((q) => q === r)).map((j) => j.x).sort((p, q) => p - q);
      const allX = Array.from(new Set(js)).filter((x) => x > r.from * TILE + 8 && x < r.to * TILE - 8).sort((p, q) => p - q);
      const final: number[] = [];
      for (let i = 0; i < allX.length; i++) {
        final.push(allX[i]);
        if (i + 1 < allX.length && allX[i + 1] - allX[i] > 640) final.push(Math.round((allX[i] + allX[i + 1]) / 2));
      }
      for (const x of final) pts.push([x, cy]);
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const ai = roadNode(pts[i][0], pts[i][1], "waypoint");
      const bi2 = roadNode(pts[i + 1][0], pts[i + 1][1], "waypoint");
      roadEdges.push({ from: roadNodes[ai].id, to: roadNodes[bi2].id, width: roadW(r), speedLimit: ROAD_LIMIT[r.cls], oneway: false });
    }
  }
  // 路口 kind/度数：每节点按边数校准 kind
  {
    const degc = new Map<string, number>();
    for (const e of roadEdges) {
      degc.set(e.from, (degc.get(e.from) || 0) + 1);
      degc.set(e.to, (degc.get(e.to) || 0) + 1);
    }
    for (const n of roadNodes) {
      const d = degc.get(n.id) || 0;
      n.kind = d >= 3 ? "intersection" : "waypoint";
      void d;
    }
  }

  // 交通灯：avenue 与主路相接（度 >= 3）才布灯，4 个角各 1 个
  const lights: { node: string; x: number; y: number }[] = [];
  for (const j of mainJunctions) {
    if (!j.roads.some((r) => r.cls === "avenue")) continue;
    if (j.deg < 3) continue;
    const node = roadNodes.find((n) => Math.round(n.x) === Math.round(j.x) && Math.round(n.y) === Math.round(j.y));
    if (!node) continue;
    lights.push({ node: node.id, x: Math.round(j.x), y: Math.round(j.y) });
    const box = j.box;
    for (const [axis, cx, cy] of [
      ["v", box[0] - 20, box[1] - 20], ["h", box[0] + box[2] + 20, box[1] - 20],
      ["h", box[0] - 20, box[1] + box[3] + 20], ["v", box[0] + box[2] + 20, box[1] + box[3] + 20],
    ] as [string, number, number][]) {
      b.add("prop-trafficlight", `交通灯${axis}_${Math.round(cx)}_${Math.round(cy)}`, "PROP", cx, cy, 12, 16, L_PROPS, 12, ["tile", "prop", "trafficlight"], { props: { axis, phase: "0", node: node.id } });
    }
  }

  // =========================================================================
  // 建筑（每楼：墙段、门洞、门补墙、楼板、楼梯、家具、屋顶）
  // =========================================================================
  function wallMats(kind: BKind): { main: string; front: string } {
    switch (kind) {
      case "house": return { main: "brick", front: "brick" };
      case "apartment": return { main: "brick", front: "brick" };
      case "shop": case "cafe": return { main: "brick", front: "glass" };
      case "tower": return { main: "brick", front: "glass" };
      case "hospital": return { main: "brick", front: "brick" };
      case "warehouse": return { main: "brick", front: "brick" };
    }
  }
  function floorKind(_kind: BKind): string {
    return "wood";
  }
  function roofKey(def: BDef): string {
    if (def.roof === "red" || def.roof === "blue" || def.roof === "brown") return "tile-roof-shingle-" + def.roof;
    if (def.roof === "flatdark") return "tile-roof-flat-dark";
    if (def.roof === "tower") return "tile-roof-tower";
    if (def.roof === "hospital") return "tile-roof-hospital";
    switch (def.kind) {
      case "shop": case "cafe": case "warehouse": return "tile-roof-flat-gray";
      case "apartment": return "tile-roof-flat-dark";
      case "tower": return "tile-roof-tower";
      case "hospital": return "tile-roof-hospital";
    }
    return "tile-roof";
  }
  const FURN: Record<BKind, { key: string; w: number; h: number; rug?: boolean }[][]> = {
    shop: [
      [{ key: "prop-counter", w: 96, h: 16 }, { key: "prop-shelf", w: 32, h: 12 }, { key: "prop-rack", w: 32, h: 12 }, { key: "prop-cooler", w: 16, h: 16 }],
      [{ key: "prop-desk", w: 32, h: 16 }, { key: "prop-shelf", w: 32, h: 12 }, { key: "prop-table", w: 24, h: 24 }],
    ],
    cafe: [
      [{ key: "prop-table", w: 24, h: 24 }, { key: "prop-chair", w: 12, h: 12 }, { key: "prop-counter", w: 96, h: 16 }],
      [{ key: "prop-table", w: 24, h: 24 }, { key: "prop-chair", w: 12, h: 12 }, { key: "prop-rug", w: 48, h: 32, rug: true }],
    ],
    house: [
      [{ key: "prop-sofa", w: 40, h: 16 }, { key: "prop-table", w: 24, h: 24 }, { key: "prop-desk", w: 32, h: 16 }],
      [{ key: "prop-bed", w: 24, h: 40 }, { key: "prop-rug", w: 48, h: 32, rug: true }],
    ],
    apartment: [
      [{ key: "prop-desk", w: 32, h: 16 }, { key: "prop-counter", w: 96, h: 16 }],
      [{ key: "prop-bed", w: 24, h: 40 }, { key: "prop-sofa", w: 40, h: 16 }, { key: "prop-table", w: 24, h: 24 }],
    ],
    tower: [
      [{ key: "prop-desk", w: 32, h: 16 }, { key: "prop-desk", w: 32, h: 16 }, { key: "prop-desk", w: 32, h: 16 }],
      [{ key: "prop-desk", w: 32, h: 16 }, { key: "prop-desk", w: 32, h: 16 }],
    ],
    hospital: [
      [{ key: "prop-counter", w: 96, h: 16 }, { key: "prop-chair", w: 12, h: 12 }, { key: "prop-chair", w: 12, h: 12 }],
      [{ key: "prop-hospital-bed", w: 24, h: 40 }, { key: "prop-hospital-bed", w: 24, h: 40 }],
    ],
    warehouse: [
      [{ key: "prop-rack", w: 32, h: 12 }, { key: "prop-shelf", w: 32, h: 12 }],
      [],
    ],
  };

  function placeBuilding(def: BDef) {
    const bi = buildings.length;
    const ox = def.tx * TILE, oy = def.ty * TILE, w = def.tw * TILE, h = def.th * TILE;
    const outer: Rect = [ox, oy, w, h];
    const inner: Rect = [ox + WALL, oy + WALL, w - 2 * WALL, h - 2 * WALL];
    const bid = "b_" + String(bi + 1).padStart(2, "0");
    const mats = wallMats(def.kind);
    const floorsArr: any[] = [];
    const doors: any[] = [];
    const stairs: any[] = [];
    const entrances: any[] = [];
    const dw = def.kind === "house" || def.kind === "shop" || def.kind === "cafe" ? 32 : 48;

    let doorRect: Rect;
    let doorCx: number, doorCy: number;
    if (def.door === "N" || def.door === "S") {
      const gx = ox + Math.floor((w - dw) / 2 / 32) * 32;
      const gy = def.door === "N" ? oy : oy + h - WALL;
      doorRect = [gx, gy, dw, WALL];
      doorCx = gx + dw / 2; doorCy = doorRect[1] + WALL / 2;
    } else {
      const gy = oy + Math.floor((h - dw) / 2 / 32) * 32;
      const gx = def.door === "W" ? ox : ox + w - WALL;
      doorRect = [gx, gy, WALL, dw];
      doorCx = doorRect[0] + WALL / 2; doorCy = gy + dw / 2;
    }
    const dirSign: Record<string, [number, number]> = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
    const [dxn, dyn] = dirSign[def.door];
    const outside = { x: Math.round(doorCx + dxn * 24), y: Math.round(doorCy + dyn * 24) };
    const inside = { x: Math.round(doorCx - dxn * 40), y: Math.round(doorCy - dyn * 40) };

    function addWallSeg(r: Rect, side: "N" | "S" | "E" | "W") {
      const horizontal = side === "N" || side === "S";
      const incoming = side === def.door && (def.kind === "shop" || def.kind === "cafe" || def.kind === "tower");
      const mat = incoming ? mats.front : mats.main;
      const texKey = (horizontal ? "tile-wall-" + mat + "-h" : "tile-wall-" + mat + "-v");
      const tags = ["wall", "building", bid];
      if (def.kind === "hospital") tags.push("hospital");
      b.rect(texKey, `${def.name} 墙${side}`, "PROP", r, L_BUILD, 20, tags, {});
      walls.push([Math.round(r[0]), Math.round(r[1]), Math.round(r[2]), Math.round(r[3]), -1, bi]);
    }
    // 北/南墙分拼
    for (const side of ["N", "S"] as const) {
      const wy = side === "N" ? oy : oy + h - WALL;
      const hasDoor = def.door === side;
      if (hasDoor) {
        const g0 = doorRect[0], g1 = doorRect[0] + doorRect[2];
        if (g0 > ox) addWallSeg([ox, wy, g0 - ox, WALL], side);
        if (ox + w > g1) addWallSeg([g1, wy, ox + w - g1, WALL], side);
      } else addWallSeg([ox, wy, w, WALL], side);
    }
    // 西/东墙
    for (const side of ["W", "E"] as const) {
      const wx = side === "W" ? ox : ox + w - WALL;
      const hasDoor = def.door === side;
      if (hasDoor) {
        const g0 = doorRect[1], g1 = doorRect[1] + doorRect[3];
        if (g0 > oy) addWallSeg([wx, oy, WALL, g0 - oy], side);
        if (oy + h > g1) addWallSeg([wx, g1, WALL, oy + h - g1], side);
      } else addWallSeg([wx, oy, WALL, h], side);
    }
    // 门洞 ZONE
    b.rect("prop-door", def.name + " 门", "ZONE", doorRect, L_BUILD, 19, ["door", "entrance", bid], {});
    entrances.push({ id: bid + "_door", x: outside.x, y: outside.y, radius: 80, level: 0 });

    // 楼板 + 上层门补墙
    for (let L = 0; L < def.floors; L++) {
      const fk = floorKind(def.kind);
      const tags = ["floor", "interior", bid, "lv" + L];
      if (def.kind === "hospital") tags.push("hospital");
      b.rect("tile-floor-" + fk, `${def.name} 楼板 L${L}`, "PROP", inner, L_BUILD, 5, tags, { color: "#d9cfc0", visible: L === 0 });
      if (L > 0) {
        const horizontal = def.door === "N" || def.door === "S";
        const incoming = def.kind === "shop" || def.kind === "cafe" || def.kind === "tower";
        const mat = incoming ? mats.front : mats.main;
        const texKey = horizontal ? "tile-wall-" + mat + "-h" : "tile-wall-" + mat + "-v";
        b.rect(texKey, def.name + " 门补墙 L" + L, "PROP", doorRect, L_BUILD, 20, ["wall", "interior", bid, "lv" + L], { visible: false });
        walls.push([Math.round(doorRect[0]), Math.round(doorRect[1]), Math.round(doorRect[2]), Math.round(doorRect[3]), L, bi]);
      }
    }

    // 楼梯 + navLink
  
    const upX = def.door === "W" || def.door === "N" ? inner[0] + inner[2] - 44 : inner[0] + 28;
    const upY = def.door === "N" || def.door === "W" ? inner[1] + 28 : inner[1] + inner[3] - 60;
    const dnX = def.door === "W" || def.door === "N" ? upX - 44 : upX + 44;
    const dnY = upY;
    if (def.floors >= 2) {
      for (let L = 0; L < def.floors; L++) {
        const tagsStairs = ["stairs", "link", "interior", bid, "lv" + L];
        if (def.kind === "hospital") tagsStairs.push("hospital");
        if (L + 1 < def.floors) {
          b.add("prop-stairs-up", def.name + " 上楼梯 L" + L, "PROP", upX, upY, 32, 32, L_BUILD, 11, tagsStairs.slice(), { visible: L === 0 });
          stairs.push({ level: L, kind: "up", x: Math.round(upX), y: Math.round(upY), link: bid + "_stairs" + (L + 1), to: L + 1 });
        }
        if (L >= 1) {
          b.add("prop-stairs-down", def.name + " 下楼梯 L" + L, "PROP", dnX, dnY, 32, 32, L_BUILD, 11, tagsStairs.slice(), { visible: false });
          stairs.push({ level: L, kind: "down", x: Math.round(dnX), y: Math.round(dnY), link: bid + "_stairs" + L, to: L - 1 });
        }
      }
      for (let L = 0; L + 1 < def.floors; L++) {
        navLinks.push({
          id: bid + "_stairs" + (L + 1), kind: "stairs",
          ax: upX, ay: upY + 20, bx: dnX, by: dnY + 20,
          aLevel: L, bLevel: L + 1, bidirectional: true, travelTime: 0.4, requiresInteract: true,
        });
      }
    }
    // 家具
    for (let L = 0; L < def.floors; L++) {
      const list = FURN[def.kind][Math.min(L, 1)] || FURN[def.kind][0];
      if (!list || list.length === 0) continue;
      const placed: Rect[] = [];
      const count = clamp(1 + Math.floor(rand() * 4), 2, 5);
      for (let t = 0; t < count; t++) {
        const pick = list[Math.floor(rand() * list.length)];
        let ok = false;
        for (let tries = 0; tries < 40 && !ok; tries++) {
          const x0 = inner[0] + 8 + Math.floor(rand() * Math.max(1, inner[2] - 16 - pick.w));
          const y0 = inner[1] + 8 + Math.floor(rand() * Math.max(1, inner[3] - 16 - pick.h));
          const r: Rect = [x0, y0, pick.w, pick.h];
          if (placed.some((q) => overlap(r, q, 6))) continue;
          const cx0 = r[0] + r[2] / 2, cy0 = r[1] + r[3] / 2;
          if (dist(cx0, cy0, inside.x, inside.y) < 60) continue;
          if (stairs.some((s) => dist(cx0, cy0, s.x, s.y) < 44)) continue;
          placed.push(r);
          const tagsF = ["furniture", "interior", bid, "lv" + L];
          if (def.kind === "hospital") tagsF.push("hospital");
          b.rect(pick.key, def.name + " 家具 " + (L + 1) + "." + (t + 1), "PROP", r, L_BUILD, pick.rug ? 6 : 10, tagsF, { visible: L === 0 });
          ok = true;
        }
      }
    }
    // 屋顶 + 屋顶物件
    const roofTags = ["roof", "building", bid];
    if (def.kind === "hospital") roofTags.push("hospital");
    b.rect(roofKey(def), def.name + " 屋顶", "PROP", outer, L_BUILD, 30, roofTags, {});
    if (def.kind === "tower") {
      b.add("prop-helipad", def.name + " 停机坪", "PROP", ox + w / 2, oy + h / 2 - 16, 64, 64, L_BUILD, 31, ["roof", "building", bid], {});
      b.add("prop-roof-ac", def.name + " 空调外机", "PROP", ox + 48, oy + 48, 24, 20, L_BUILD, 31, ["roof", "building", bid], {});
    } else if (def.kind === "shop" || def.kind === "cafe" || def.kind === "warehouse" || def.kind === "apartment" || def.kind === "hospital") {
      b.add("prop-roof-ac", def.name + " 空调外机", "PROP", ox + 48, oy + 48, 24, 20, L_BUILD, 31, ["roof", "building", bid], {});
    }
    // 数据
    for (let L = 0; L < def.floors; L++) {
      floorsArr.push({
        id: "f" + L, name: L === 0 ? "大堂 Lobby" : "楼层 " + (L + 1), level: L,
        rooms: [{
          id: bid + "_r" + L, name: def.name + " 楼层 " + (L + 1),
          x: inner[0] + inner[2] / 2, y: inner[1] + inner[3] / 2,
          halfW: inner[2] / 2, halfH: inner[3] / 2,
          tags: L === 0 ? ["indoor", "室内", "lobby"] : ["indoor", "室内"],
          collides: false, navigable: true, viaLink: L === 0 ? "" : bid + "_stairs" + L,
        }],
      });
    }
    floorsArr.push({
      id: "roof", name: "屋顶 Roof", level: def.floors,
      rooms: [{
        id: bid + "_roof", name: def.name + " 屋顶",
        x: outer[0] + outer[2] / 2, y: outer[1] + outer[3] / 2,
        halfW: outer[2] / 2, halfH: outer[3] / 2,
        tags: ["roof", "outdoor"], collides: false, navigable: false,
      }],
    });
    buildings.push({
      id: bid, name: def.name, kind: def.kind, district: def.district,
      roof: "auto",
      outer: outer as unknown as number[], inner: inner as unknown as number[],
      floors: floorsArr,
      doors: [{ x: doorRect[0], y: doorRect[1], w: doorRect[2], h: doorRect[3], side: def.door, outside, inside }],
      stairs, entrances,
    });
  }
  for (const def of BDEFS) placeBuilding(def);

  // =========================================================================
  // 住宅栅栏 / 边界墙 / 水岸栏杆
  // =========================================================================
  function pushWall(r: Rect, level: number, bi: number) {
    walls.push([Math.round(r[0]), Math.round(r[1]), Math.round(r[2]), Math.round(r[3]), level, bi]);
  }
  // 绿篱 / 栅栏只是视觉装饰（不进 CITY.walls 的 level=-1 列表）：
  // 行人路网的直线边会跨过院子边线，若把绿篱当墙,行人会被卡住。
  // 对玩家的实际阻挡由 player.js 的「室内门 + 建筑外墙」承担；
  // 院子的栅栏只用于美观，玩家可以跳过去。
  function pushHedge(r: Rect, _level: number, _bi: number) {
    const horizontal = r[2] > r[3];
    void _level; void _bi;
    b.rect(horizontal ? "tile-hedge-h" : "tile-hedge-v", `绿篱_${Math.round(r[0])}_${Math.round(r[1])}`, "PROP", r, L_BUILD, 20, ["fence", "hedge", "tile"], {});
  }
  function pushFence(r: Rect, _level: number, _bi: number) {
    const horizontal = r[2] > r[3];
    void _level; void _bi;
    b.rect(horizontal ? "tile-fence-h" : "tile-fence-v", `栅栏_${Math.round(r[0])}_${Math.round(r[1])}`, "PROP", r, L_BUILD, 20, ["fence", "tile"], {});
  }

  // 住宅庭院栅栏 + 门外留缺口（以门为中心）
  for (const def of BDEFS) {
    if (!def.hedges) continue;
    const bi = buildings.findIndex((q) => q.name === def.name);
    if (bi < 0) continue;
    const ox = def.tx * TILE, oy = def.ty * TILE, w = def.tw * TILE, h = def.th * TILE;
    // 院子 = 楼四边外扩 2 tile 再切掉人行道部分
    const yard: Rect = [ox - 2 * TILE, oy - 2 * TILE, w + 4 * TILE, h + 4 * TILE];
    const gx = ox + Math.floor((w - 32) / 2 / 32) * 32;
    const gy = oy + Math.floor((h - 32) / 2 / 32) * 32;
    // 北侧栅栏（门 N 时留 48 缺口）
    const northSegs: Array<[number, number]> = [[yard[0], gx], [gx + 32, yard[0] + yard[2]]];
    for (const seg of northSegs) {
      if (seg[1] - seg[0] > 8) pushFence([seg[0], yard[1], seg[1] - seg[0], WALL], -1, bi);
    }
    const southSegs: Array<[number, number]> = [[yard[0], gx], [gx + 32, yard[0] + yard[2]]];
    const southY = yard[1] + yard[3] - WALL;
    if (def.door === "S") {
      pushFence([yard[0], southY, gx - yard[0], WALL], -1, bi);
      pushFence([gx + 32, southY, yard[0] + yard[2] - gx - 32, WALL], -1, bi);
    } else {
      pushFence([yard[0], southY, yard[2], WALL], -1, bi);
    }
    // 西/东栅栏
    const westSegYs: Array<[number, number]> = [[yard[1], gy], [gy + 32, yard[1] + yard[3]]];
    if (def.door === "W") {
      for (const seg of westSegYs) {
        if (seg[1] - seg[0] > 8) pushFence([yard[0], seg[0], WALL, seg[1] - seg[0]], -1, bi);
      }
    } else {
      pushFence([yard[0], yard[1], WALL, yard[3]], -1, bi);
    }
    if (def.door === "E") {
      const ex = yard[0] + yard[2] - WALL;
      pushFence([ex, yard[1], WALL, gy - yard[1]], -1, bi);
      pushFence([ex, gy + 32, WALL, yard[1] + yard[3] - gy - 32], -1, bi);
    } else {
      pushFence([yard[0] + yard[2] - WALL, yard[1], WALL, yard[3]], -1, bi);
    }
    void northSegs; void southSegs; void westSegYs;
  }

  // 地图四周边界墙（把整张图封闭起来）
  pushWall([0, 0, MAP_W, WALL], -1, -1);
  pushWall([0, MAP_H - WALL, MAP_W, WALL], -1, -1);
  pushWall([0, 0, WALL, MAP_H], -1, -1);
  pushWall([MAP_W - WALL, 0, WALL, MAP_H], -1, -1);
  // 水岸 fences（栈道一到水边界）
  pushWall([0, 88 * TILE, MAP_W, WALL], -1, -1);
  pushWall([0, 88 * TILE - WALL, MAP_W, WALL], -1, -1);
  pushWall([0, 88 * TILE, WALL, 8 * TILE], -1, -1);
  pushWall([MAP_W - WALL, 88 * TILE, WALL, 8 * TILE], -1, -1);
  pushWall([0, 88 * TILE, MAP_W, TILE], -1, -1);
  function roadSidewalk(r: RoadDef, side: -1 | 1) {
    const bw = WALK_W[r.cls];
    if (bw <= 0) return;
    const c = roadCenter(r) + side * (roadW(r) / 2 + bw / 2);
    const cutsA: number[] = [];
    const cutsB: number[] = [];
    for (const j of junctions) {
      if (!j.roads.some((q) => q === r)) continue;
      const a = r.dir === "v" ? j.box[1] : j.box[0];
      const full = r.dir === "v" ? j.box[3] : j.box[2];
      cutsA.push(a - bw / 2);
      cutsB.push(a + full + bw / 2);
    }
    cutsA.sort((p, q) => p - q);
    cutsB.sort((p, q) => p - q);
    const e0 = r.from * TILE, e1 = r.to * TILE;
    const merged = Array.from(new Set([...cutsA, ...cutsB])).sort((p, q) => p - q);
    const seq = [e0 - bw / 2, ...merged, e1 + bw / 2];
    const idxs = seq.map((v) => walk.add(r.dir === "v" ? c : v, r.dir === "v" ? v : c, 0));
    walk.link(idxs[0], idxs[1], 0);
    for (let i = 1; i + 1 < idxs.length; i++) walk.link(idxs[i], idxs[i + 1], 1);
    walk.link(idxs[idxs.length - 2], idxs[idxs.length - 1], 0);
    void cutsB;
  }
  // 主路人行道
  for (const r of ROADS) {
    if (r.cls === "alley") continue;
    roadSidewalk(r, -1);
    roadSidewalk(r, 1);
  }

  // 公园 / 广场 / 栈道 行人路
  function walkLine(dir: "h" | "v", c: number, from: number, to: number, kindOverride: number) {
    const pts: number[] = [from];
    for (let v = from + 96; v < to; v += 96) pts.push(v);
    pts.push(to);
    const idxs = pts.map((v) => walk.add(dir === "h" ? v : c, dir === "h" ? c : v, kindOverride));
    for (let i = 0; i + 1 < idxs.length; i++) walk.link(idxs[i], idxs[i + 1], 0);
    return idxs;
  }
  // 中央大道南小市场 / 公园
  walkLine("h", 20 * TILE, 66 * TILE, 84 * TILE, 0);
  walkLine("v", 74 * TILE, 14 * TILE, 29 * TILE, 0);
  walkLine("h", 50 * TILE, 14 * TILE, 30 * TILE, 0);   // 医院广场
  walkLine("v", 21 * TILE, 40 * TILE, 56 * TILE, 0);
  walkLine("h", 66 * TILE, 87 * TILE, 111 * TILE, 0);  // 东岸楼门前
  walkLine("h", 65 * TILE, 43 * TILE, 81 * TILE, 0);   // 市场街带
  walkLine("h", 75 * TILE, 43 * TILE, 81 * TILE, 0);   // 市场街带 南
  walkLine("h", 6 * TILE, 8 * TILE, 32 * TILE, 0);     // 西北住宅-yard
  walkLine("h", 75 * TILE, 8 * TILE, 32 * TILE, 0);    // 东北住宅
  walkLine("h", 68 * TILE, 117 * TILE, 127 * TILE, 0); // 东岸街住宅
  // 板栈道
  walkLine("h", 71 * TILE, 0, MAP_W, 0);
  // 市中心塔楼 / 写字楼区
  walkLine("v", 49 * TILE, 12 * TILE, 28 * TILE, 0);

  // 街面 Props：路灯 / 行道树 / 消防栓 / 长椅
  //
  // ★ 先把已建好的步行节点交给 Builder：之后登记阻挡时会跳过压住节点的道具，
  // 否则行人走到交通灯/路灯跟前就永久卡死（斑马线再也过不去）。
  b.setWalkNodes(walk.nodes);
  const usedProps: Rect[] = [];
  function propFree(r: Rect): boolean {
    for (const def of BDEFS) {
      const outer: Rect = [def.tx * TILE, def.ty * TILE, def.tw * TILE, def.th * TILE];
      if (overlap(r, outer, 8)) return false;
    }
    for (const q of usedProps) if (overlap(r, q, 6)) return false;
    const tx0 = Math.floor(r[0] / TILE), tx1 = Math.floor((r[0] + r[2] - 1) / TILE);
    const ty0 = Math.floor(r[1] / TILE), ty1 = Math.floor((r[1] + r[3] - 1) / TILE);
    for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) {
      const c = cellAt(x, y);
      if (c !== 1 && c !== 2 && c !== 3 && c !== 4 && c !== 9 && c !== 10) return false;
    }
    return true;
  }
  function tryProp(key: string, cx: number, cy: number, w: number, h: number, tags: string[], z = 0): boolean {
    const r: Rect = [cx - w / 2, cy - h / 2, w, h];
    if (!propFree(r)) return false;
    b.rect(key, key.replace("prop-", "") + "_" + Math.round(cx), "PROP", r, L_PROPS, z, tags, {});
    usedProps.push(r);
    return true;
  }
  for (const r of ROADS) {
    if (r.cls === "alley") continue;
    const baseIdx = junctions.filter((j) => j.roads.some((q) => q === r)).map((j) => (r.dir === "v" ? j.box[1] : j.box[0])).sort((p, q) => p - q);
    let from = r.dir === "v" ? r.from * TILE + 64 : r.from * TILE + 64;
    const to = r.dir === "v" ? r.to * TILE - 64 : r.to * TILE - 64;
    let k = 0;
    for (const line of [-1, 1]) {
      for (let v = from; v < to; v += 320) {
        const isNearJunction = baseIdx.some((jy) => Math.abs(jy - v) < 160);
        if (isNearJunction) continue;
        const bw = WALK_W[r.cls];
        const cInner = roadCenter(r) + line * (roadW(r) / 2 + bw * 0.28);
        const cMid = roadCenter(r) + line * (roadW(r) / 2 + bw * 0.5);
        const cx = r.dir === "v" ? cInner : v;
        const cy = r.dir === "v" ? v : cInner;
        if (k % 3 === 0) tryProp("prop-streetlamp", cx, cy, 12, 12, ["prop", "tile"]);
        else if (k % 3 === 1 && k % 6 < 4) tryProp(r.cls === "avenue" ? "prop-planter" : "prop-tree", cx, cy, r.cls === "avenue" ? 24 : 32, r.cls === "avenue" ? 24 : 32, ["prop", "tile", "tree"]);
        else tryProp(r.cls === "avenue" ? "prop-bush" : "prop-flowerbed", cx, cy, r.cls === "avenue" ? 16 : 32, r.cls === "avenue" ? 16 : 16, ["prop", "tile"]);
        k++;
      }
      // 消防栓
      for (let v = from + 448; v < to; v += 1152) {
        const cMid = roadCenter(r) + line * (roadW(r) / 2 + WALK_W[r.cls] * 0.5);
        const cx = r.dir === "v" ? cMid : v;
        const cy = r.dir === "v" ? v : cMid;
        /* 消防栓太密了，去掉 */
      }
      // 长椅（不密集）
      for (let v = from + 900; v < to; v += 2400) {
        const cMid = roadCenter(r) + line * (roadW(r) / 2 + WALK_W[r.cls] * 0.5);
        const cx = r.dir === "v" ? cMid : v;
        const cy = r.dir === "v" ? v : cMid;
        const benchKey = r.dir === "v" ? "prop-bench-v" : "prop-bench-h";
        tryProp(benchKey, cx, cy, r.dir === "v" ? 12 : 32, r.dir === "v" ? 32 : 12, ["prop", "tile", "bench"]);
      }
    }
  }

  // 公园中心 喷泉 + 长椅 + 花坛
  {
    const fx = 74 * TILE, fy = 20 * TILE;
    b.add("prop-fountain", "公园喷泉", "PROP", fx, fy, 64, 64, L_PROPS, 0, ["prop", "tile", "fountain"], {});
    for (const [key, cx, cy, w, h, tg] of [
      ["prop-bench-h", fx - 112, fy + 40, 32, 12, ["prop", "tile", "bench"]],
      ["prop-bench-h", fx + 112, fy - 40, 32, 12, ["prop", "tile", "bench"]],
      ["prop-bench-v", fx - 40, fy + 112, 12, 32, ["prop", "tile", "bench"]],
      ["prop-bench-v", fx + 40, fy - 112, 12, 32, ["prop", "tile", "bench"]],
      ["prop-flowerbed", fx - 160, fy + 6, 32, 16, ["prop", "tile"]],
      ["prop-flowerbed", fx + 160, fy - 6, 32, 16, ["prop", "tile"]],
      ["prop-tree-big", fx - 192, fy - 96, 48, 48, ["prop", "tile", "tree"]],
      ["prop-tree-big", fx + 192, fy + 96, 48, 48, ["prop", "tile", "tree"]],
    ] as [string, number, number, number, number, string[]][]) {
      tryProp(key, cx, cy, w, h, tg);
    }
  }
  // 医院广场 雕塑 + 长椅
  const marbleSq: Rect = [14 * TILE, 49 * TILE, 6 * TILE, 6 * TILE];
  {
    b.add("prop-sculpture", "广场雕塑", "PROP", marbleSq[0] + marbleSq[2] / 2, marbleSq[1] + marbleSq[3] / 2, 32, 32, L_PROPS, 0, ["prop", "tile", "sculpture"], {});
    for (const [cx, cy, key, w, h] of [
      [marbleSq[0] - 48, marbleSq[1] + marbleSq[3] / 2, "prop-bench-v", 12, 32],
      [marbleSq[0] + marbleSq[2] + 48, marbleSq[1] + marbleSq[3] / 2, "prop-bench-v", 12, 32],
      [marbleSq[0] + marbleSq[2] / 2 - 24, marbleSq[1] - 48, "prop-bench-h", 32, 12],
      [marbleSq[0] + marbleSq[2] / 2 + 24, marbleSq[1] + marbleSq[3] + 48, "prop-bench-h", 32, 12],
    ] as [number, number, string, number, number][]) {
      tryProp(key, cx, cy, w, h, ["prop", "tile", "bench"]);
    }
  }
  // 木栈道 长椅
  for (const v of [96, 160,  96, 320, 384, 480, 576, 672, 768, 864, 960, 1056, 1152, 1248, 1344, 1440, 1536, 1632, 1728, 1824, 1920, 2016, 2112, 2208, 2304, 2400, 2496, 2592, 2688, 2784, 2880, 2976, 3072, 3168, 3264, 3360, 3456, 3552, 3648, 3744]) {
    void tryProp("prop-bench-h", v, 71 * TILE + 16, 32, 12, ["prop", "tile", "bench"]);
  }
  // 道边的树补满（草坪/广场空白格）
  for (let i = 0; i < 55; i++) {
    for (let tries = 0; tries < 24; tries++) {
      const cx = 32 + rint(rand, 0, MAP_W - 64), cy = 32 + rint(rand, 0, MAP_H - 64);
      const key = rint(rand, 0, 2) === 0 ? "prop-tree-big" : rint(rand, 0, 2) === 1 ? "prop-tree" : "prop-tree-pine";
      const s = key === "prop-tree-big" ? 48 : 32;
      if (tryProp(key, cx, cy, s, s, ["prop", "tile", "tree"])) break;
    }
  }
  // 拾取道具
  const pickupsList = [
    ["prop-health", 21 * TILE, 39 * TILE], ["prop-health", 40 * TILE, 66 * TILE],
    ["prop-health", 22 * TILE, 66 * TILE], ["prop-health", 44 * TILE, 81 * TILE],
    ["prop-ammo", 30 * TILE, 72 * TILE], ["prop-ammo", 76 * TILE, 66 * TILE],
    ["prop-ammo", 106 * TILE, 72 * TILE], ["prop-ammo", 106 * TILE, 65 * TILE],
  ];
  for (const [key, cx, cy] of pickupsList as [string, number, number][]) {
    b.add(key, key.replace("prop-", ""), "PROP", cx, cy, 16, 16, L_PROPS, key === "prop-health" ? 5 : 6, ["pickup", "prop"], { props: { heal: key === "prop-health" ? "40" : "0", ammo: key === "prop-ammo" ? "12" : "0" } });
  }

  const carSpawns: { x: number; y: number; heading: number }[] = [];
  const parking: { x: number; y: number; heading: number }[] = [];
  for (const r of ROADS) {
    if (r.cls === "alley") continue;
    const laneOff = roadW(r) * 0.25;
    const cuts: number[] = [];
    for (const j of junctions) if (j.roads.some((q) => q === r)) {
      const a = r.dir === "v" ? j.box[1] : j.box[0];
      cuts.push(a - 128, a + (r.dir === "v" ? j.box[3] : j.box[2]) + 128);
    }
    cuts.sort((p2, q2) => p2 - q2);
    const from = r.dir === "v" ? r.from * TILE : r.from * TILE;
    const to = r.dir === "v" ? r.to * TILE : r.to * TILE;
    let a = from; let idx = 0;
    const segs: [number, number][] = [];
    for (const cut of cuts) { if (cut > a + 64) segs.push([a, cut]); a = Math.max(a, cut); }
    if (a + 64 < to) segs.push([a, to]);
    for (const [s0, e0] of segs) {
      for (let v = s0 + 96; v < e0 - 96; v += 288) {
        if (r.dir === "v") {
          const heading = idx % 2 ? 270 : 90;
          const x = roadCenter(r) - (heading === 90 ? laneOff : -laneOff);
          carSpawns.push({ x: Math.round(x), y: Math.round(v), heading });
        } else {
          const heading = idx % 2 ? 180 : 0;
          const y = roadCenter(r) + (heading === 0 ? laneOff : -laneOff);
          carSpawns.push({ x: Math.round(v), y: Math.round(y), heading });
        }
        idx++;
      }
    }
  }
  for (const [px, py, hh] of [
    [roadCenter(ROADS[1]) + roadW(ROADS[1]) / 2 + 8, 11 * TILE, 270],
    [roadCenter(ROADS[1]) - roadW(ROADS[1]) / 2 - 8, 55 * TILE, 90],
    [roadCenter(ROADS[1]) - roadW(ROADS[1]) / 2 - 8, 60 * TILE, 90],
    [roadCenter(ROADS[1]) + roadW(ROADS[1]) / 2 + 8, 20 * TILE, 270],
    [roadCenter(ROADS[1]) + roadW(ROADS[1]) / 2 + 8, 70 * TILE, 270],
    [roadCenter(ROADS[1]) - roadW(ROADS[1]) / 2 - 8, 41 * TILE, 90],
  ] as [number, number, number][]) parking.push({ x: Math.round(px), y: Math.round(py), heading: hh });
  for (let i = 0; i < 8; i++) parking.push({ x: 90 * TILE + i * 48, y: 74 * TILE, heading: 90 });

  const playerSpawnCity = { x: 36 * TILE, y: 52 * TILE };
  {
    const spawn = createObject("ACTOR", playerSpawnCity.x, playerSpawnCity.y);
    spawn.name = "玩家";
    spawn.tags = ["玩家", "player"];
    spawn.layerId = layerIds[L_ACTOR];
    spawn.z = 18;
    spawn.halfW = 8; spawn.halfH = 12;
    spawn.scaleX = 1; spawn.scaleY = 1;
    spawn.assetName = "actor-player";
    const pla = assets["actor-player"];
    if (pla) spawn.assetId = pla.id;
    spawn.animMode = "只显示首帧";
    spawn.modules = [
      { defId: "fx.cameraFollow", label: "相机跟随", trigger: null, values: { smoothing: "8" }, enabled: true, collapsed: true },
      { defId: "script.js", label: "玩家脚本", trigger: null, values: { script: "player" }, enabled: true, collapsed: true },
    ];
    spawn.props = { color: "#9ec3ff", solid: "0" };
    b.objects.push(spawn);
  }

  // =========================================================================
  // 行人路网：楼门 / 窗 / POI
  // =========================================================================
  function nearNode(x: number, y: number, maxDist: number): number {
    let best = -1, bd = maxDist * maxDist;
    for (let i = 0; i < walk.nodes.length; i++) {
      const n = walk.nodes[i];
      const d2 = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
      if (d2 < bd) { bd = d2; best = i; }
    }
    return best;
  }
  function clearWalkTo(x0: number, y0: number, x1: number, y1: number): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(d / 8));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      for (const w of walls) {
        if (w[4] !== -1 && w[4] !== 0) continue;
        if (ptInRect(x, y, [w[0], w[1], w[2], w[3]])) return false;
      }
    }
    return true;
  }
  const walkPOIs: any[] = [];
  for (const def of BDEFS) {
    if (def.kind !== "shop" && def.kind !== "cafe" && def.kind !== "hospital") continue;
    const bi = buildings.findIndex((q) => q.name === def.name);
    if (bi < 0) continue;
    const B0 = buildings[bi];
    const dOut = B0.doors[0].outside;
    const dIn = B0.doors[0].inside;
    const outNode = walk.add(dOut.x, dOut.y, 2);
    const inNode = walk.add(dIn.x, dIn.y, 3);
    walk.link(outNode, inNode, 2);
    // 近端 sidewalk 节点连接
    for (const cand of [nearNode(dOut.x, dOut.y, 240)]) {
      if (cand >= 0 && clearWalkTo(dOut.x, dOut.y, walk.nodes[cand].x, walk.nodes[cand].y)) { walk.link(outNode, cand, 0); break; }
    }
    // 店内中枢节点
    const ox = Math.round(def.tx * TILE), oy = Math.round(def.ty * TILE);
    const ow = def.tw * TILE, oh = def.th * TILE;
    const cNode = walk.add(ox + ow / 2, oy + oh / 2, 3);
    walk.link(inNode, cNode, 0);
    walkPOIs.push({ x: dIn.x, y: dIn.y, kind: "shop", node: inNode, building: B0.id, face: def.door });
    // 玻璃窗 POI：橱窗铺排在门两侧
    const winDX = def.door === "N" || def.door === "S" ? 40 : 0;
    const winDY = def.door === "N" || def.door === "S" ? 0 : 40;
    const winFace = def.door === "N" ? "S" : def.door === "S" ? "N" : def.door === "W" ? "E" : "W";
    for (const side of [-1, 1]) {
      const wx = dOut.x + winDX * side;
      const wy = dOut.y + winDY * side;
      if (wx < ox || wx > ox + ow || wy < oy || wy > oy + oh) continue;
      const node = nearNode(wx, wy, 140);
      if (node >= 0) walkPOIs.push({ x: Math.round(wx), y: Math.round(wy), kind: "window", node, face: winFace });
    }
  }
  // 公园 / 广场 / 栈道 / 长椅 POI
  for (const fx of parkNodes) void fx;
  walkPOIs.push({ x: 74 * TILE, y: 20 * TILE - 44, kind: "fountain", node: nearNode(74 * TILE, 20 * TILE - 44, 260) });
  walkPOIs.push({ x: 74 * TILE, y: 20 * TILE + 44, kind: "park", node: nearNode(74 * TILE, 20 * TILE + 44, 260) });
  walkPOIs.push({ x: 74 * TILE - 32, y: 20 * TILE, kind: "park", node: nearNode(74 * TILE - 32, 20 * TILE, 260) });
  walkPOIs.push({ x: 16 * TILE, y: 51 * TILE, kind: "plaza", node: nearNode(16 * TILE, 51 * TILE, 260) });
  walkPOIs.push({ x: 21 * TILE, y: 51 * TILE, kind: "plaza", node: nearNode(21 * TILE, 51 * TILE, 260) });
  walkPOIs.push({ x: 50 * TILE, y: 27 * TILE, kind: "plaza", node: nearNode(50 * TILE, 27 * TILE, 260) });
  walkPOIs.push({ x: 21 * TILE, y: 47 * TILE, kind: "park", node: nearNode(21 * TILE, 47 * TILE, 260) });
  walkPOIs.push({ x: 16 * TILE, y: 43 * TILE, kind: "park", node: nearNode(16 * TILE, 43 * TILE, 260) });
  walkLine("h", 43 * TILE + 40, 8 * TILE, 32 * TILE, 0);
  walkLine("h", 66 * TILE + 40, 8 * TILE, 32 * TILE, 0);
  walkLine("h", 66 * TILE + 40, 33 * TILE, 57 * TILE, 0);
  walkLine("h", 16 * TILE + 40, 63 * TILE, 81 * TILE, 0);
  walkLine("h", 68 * TILE + 40, 63 * TILE, 81 * TILE, 0);
  for (let v = 96; v < MAP_W; v += 320) {
    walkPOIs.push({ x: v, y: 71 * TILE + 20, kind: "view", node: nearNode(v, 71 * TILE + 20, 260), face: "S" });
  }

  // =========================================================================
  // CITY 数据 & 脚本注入
  // =========================================================================
  const CITY = {
    version: 2, tile: TILE, width: MAP_W, height: MAP_H,
    playerSpawn: playerSpawnCity,
    walls: walls.map((w) => [Math.round(w[0]), Math.round(w[1]), Math.round(w[2]), Math.round(w[3]), w[4], w[5]]),
    buildings,
    walk: {
      nodes: walk.nodes.map((n) => [Math.round(n.x), Math.round(n.y), n.kind]),
      edges: walk.edges.map((e) => [e.a, e.b, e.kind]),
    },
    pois: walkPOIs,
    carSpawns, parking, lights,
    // 阻挡矩形表（树/路灯/长椅/消防栓/雕塑/喷泉…）：player.js 与 world.js 的
    // 碰撞查询消费它。没有这一项的老 CITY 数据 → 退化成"只有墙有碰撞"。
    // ★ 统一过滤一次：把压住行人路网节点的阻挡剔除。
    //
    // 交通灯/路灯在第 618 行就创建了（那时步行节点还没建好），所以不能只靠
    // Builder.solid 里的即时判断 —— 必须在全部道具与全部节点都就绪之后再过一遍。
    // 不剔的后果是行人走到那里永久卡死、斑马线统计 crossings 直接归零。
    solids: filterWalkBlocking(b.solids, walk.nodes),
  };
  CITY.roads = junctions.map((j) => ({ key: j.key, x: Math.round(j.x), y: Math.round(j.y) }));

  scene.objects = b.objects;
  (scene as any).buildings = buildings;
  (scene as any).navLinks = navLinks;
  (scene as any).roadNetwork = { nodes: roadNodes, edges: roadEdges };

  // ==== 自检 ====
  const errs: string[] = [];
  for (const b2 of buildings) {
    for (const b3 of buildings) {
      if (b2 === b3) continue;
      // pad=0：只拦"真的互相压进去"。相邻楼贴边（gap=0）是合法布局，
      // 原来的 pad=4 会把一长排沿街店铺全判成重叠 —— 那批 8 条报错就是这么来的。
      if (overlap(b2.outer as unknown as Rect, b3.outer as unknown as Rect, 0)) errs.push("建筑重叠:" + b2.id + "/" + b3.id);
    }
  }
  // ★ 建筑不许压到马路（含人行道）。
  //
  // 为什么必须在生成器里硬拦：建筑的 tx/ty 是手写的常量，改一个数字就可能把楼
  // 摆到车道或人行道上 —— 表现为「房子盖在马路上」。
  // 只靠肉眼看 .bwproj 是看不出来的（楼和路都是同色块），所以这里把判定前移，
  // 让下一次 `npm run gen:city` / `verify:openworld` 就直接失败。
  for (const b2 of buildings) {
    const o = b2.outer as unknown as Rect;
    for (const r of ROADS) {
      const carriage = carriageOf(r);
      if (overlap(o, carriage, 0)) {
        errs.push("建筑压车道:" + b2.id + "(" + b2.name + ")/" + r.id + " " + r.name);
      }
      const bw = WALK_W[r.cls];
      if (bw > 0) {
        const walks: Rect[] = r.dir === "v"
          ? [[carriage[0] - bw, carriage[1], bw, carriage[3]], [carriage[0] + carriage[2], carriage[1], bw, carriage[3]]]
          : [[carriage[0], carriage[1] - bw, carriage[2], bw], [carriage[0], carriage[1] + carriage[3], carriage[2], bw]];
        for (const wr of walks) {
          if (overlap(o, wr, 0)) {
            errs.push("建筑压人行道:" + b2.id + "(" + b2.name + ")/" + r.id + " " + r.name);
          }
        }
      }
    }
  }
  for (const p2 of walkPOIs) {
    if (p2.node === -1 || p2.node >= walk.nodes.length) errs.push("POI 无节点 " + p2.kind);
    else {
      const n2 = walk.nodes[p2.node];
      if (!n2) errs.push("POI 节点无效");
    }
  }
  if (errs.length) {
    console.error("[gen-city] 自检失败：");
    for (const e of errs.slice(0, 10)) console.error("  - " + e);
    process.exit(1);
  }
  console.log("城市构建完成 objects=" + b.objects.length + " buildings=" + buildings.length);
  return { scene, buildings, navLinks, roadNodes, roadEdges, walls: CITY.walls, CITY, objects: b.objects, roadJunctions: junctions, cells: CELLS, walk };
}

// =========================================================================
// 入口
// =========================================================================
function main(): void {
  const args = process.argv.slice(2);
  const seedArg = args.indexOf("--seed");
  const seed = seedArg >= 0 ? Number(args[seedArg + 1]) : 20261029;
  const p: Project = createProject("BWE 开放世界原型 · 自由城");
  p.author = "BWE";
  p.tileSize = TILE;
  p.gridW = GRID_W;
  p.gridH = GRID_H;
  const built = buildCity(seed);
  const scene = built.scene;
  p.scenes = [scene];
  p.assets = Object.values(loadAssets());
  // 脚本
  const scriptDir = resolve(HERE, "..", "examples", "city", "scripts");
  const cityJson = JSON.stringify(built.CITY);
  const scriptFiles: Record<string, string> = { player: "player.js", world: "world.js" };
  p.scripts = {};
  for (const [name, file] of Object.entries(scriptFiles)) {
    const src = readFileSync(resolve(scriptDir, file), "utf8");
    p.scripts[name] = { name, file: "scripts/" + name + ".js", source: "var CITY = " + cityJson + ";" + NL + src, lang: "js" };
  }
  scene.onStartScript = "world";
  const outDir = resolve(ROOT, "web", "examples");
  mkdirSync(outDir, { recursive: true });
  const target = resolve(outDir, "开放世界城市.bwproj");
  writeFileSync(target, JSON.stringify(p, null, 2) + NL, "utf8");
  console.log("wrote " + target);
  console.log("  scene=" + scene.name + " grid=" + GRID_W + "x" + GRID_H + " tile=" + TILE);
  console.log("  objects=" + scene.objects.length + " buildings=" + built.buildings.length
    + " navLinks=" + built.navLinks.length
    + " roadNodes=" + built.roadNodes.length + " roadEdges=" + built.roadEdges.length
    + " walls=" + built.walls.length);
}

const NL = "\n" ;const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
export { buildCity, rng };
if (isMain) main();
