/**
 * 开放世界城市 像素画素材生成器（零依赖：自带 PNG 编码 + 固定种子 PRNG，每次运行逐字节一致）。
 * 规格：1 texel = 1 世界 px，1 tile = 32px；俯视略带 3/4 斜角；统一调色板、光源左上、阴影右下。
 * 用法：node web/tools/gen-pixel-art.mjs
 * 输出：Assets/pixel/<name>.png 与 web/examples/city/assets.json（base64 内联）。
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const OUT_DIR = join(ROOT, "Assets", "pixel");
const MANIFEST = join(ROOT, "web", "examples", "city", "assets.json");

// ---------------------------------------------------------------- PNG 编码
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
/** RGBA8（colorType 6），每行 filter 0。 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 确定性随机
/** FNV-1a：素材名 → 种子（新增素材不影响其它素材的随机序列）。 */
function seedOf(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 坐标哈希噪声 [0,1)。 */
function h2(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** 周期值噪声：px/py 必须是 cell 的整数倍；格点按周期取模 → 四方连续。 */
function pnoise(x, y, cell, px, py, s) {
  const nx = Math.max(1, px / cell), ny = Math.max(1, py / cell);
  const gx = x / cell, gy = y / cell;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const mx = (v) => ((v % nx) + nx) % nx, my = (v) => ((v % ny) + ny) % ny;
  const a = h2(mx(x0), my(y0), s), b = h2(mx(x0 + 1), my(y0), s);
  const c = h2(mx(x0), my(y0 + 1), s), d = h2(mx(x0 + 1), my(y0 + 1), s);
  const top = a + (b - a) * sx, bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

// ---------------------------------------------------------------- 调色板（统一）
// 每种材质 4–7 档，从暗到亮；OUT 为全局深色描边。光源左上：亮档给左/上沿，暗档给右/下沿。
const OUT = "#14100c";
const SHADOW = "#14100c58"; // 半透明投影（右下）
const P = {
  asphalt: ["#26292f", "#2f333a", "#383c44", "#41464e", "#4b5058", "#575c64"],
  concrete: ["#5e6168", "#757980", "#8c9096", "#a2a6aa", "#b8bbbe", "#cdcfd0"],
  brick: ["#3e1e1a", "#5a2a22", "#77382a", "#924834", "#ab5c42", "#c27656"],
  mortar: ["#6e665c", "#8a8276", "#a39c90", "#bab4a8"],
  grass: ["#263f22", "#33552b", "#426c33", "#53843c", "#679c48", "#82b45a"],
  dirt: ["#4e3a2a", "#6a4f38", "#866648", "#a07e5a", "#b8966e", "#cdb088"],
  water: ["#16304e", "#1f4268", "#2a5784", "#386f9e", "#5490ba", "#8cbcd8", "#d2ecf6"],
  wood: ["#33200f", "#4e321c", "#6b4628", "#875c36", "#a37446", "#bc8e5a"],
  marble: ["#8e949c", "#a9aeb5", "#c0c4ca", "#d4d7db", "#e5e7e9", "#f4f4f3"],
  plaster: ["#7a6c56", "#988a70", "#b4a688", "#cbbf9f", "#ded3b6", "#eee6cf"],
  sand: ["#7a6648", "#96805c", "#ae9872", "#c2ae88", "#d4c29e", "#e4d6b6"],
  glass: ["#142a3c", "#1f3d55", "#2d5571", "#447492", "#6e9cb8", "#a6cde0", "#e6f6fa"],
  metal: ["#212429", "#353940", "#4b5058", "#646a72", "#82878e", "#a5a9ae", "#cbced1"],
  red: ["#4a1214", "#721c1e", "#9a2826", "#c03630", "#dc4c40", "#f0765e"],
  maroon: ["#3a1418", "#561e24", "#722a30", "#8e3a3e", "#a84e50"],
  blue: ["#111d3e", "#1c2f60", "#28458a", "#365eb4", "#527ed6", "#86a8ec", "#c0d6f8"],
  navy: ["#0c1222", "#141d36", "#1d2a4c", "#283a64", "#36507e"],
  yellow: ["#5e420c", "#8c6a14", "#bc941c", "#e0b82a", "#f2d24a", "#fae88a"],
  green: ["#0e2e1c", "#17482c", "#21633c", "#2e7f4e", "#46a066", "#78c48e"],
  white: ["#5c6066", "#878b91", "#b0b4b8", "#d2d5d8", "#ebedee", "#fafaf8"],
  black: ["#0c0d10", "#16181c", "#202328", "#2c3036", "#3b4048", "#525860"],
  brown: ["#2e1c10", "#462c19", "#603e24", "#7c5232", "#986844", "#b2825a"],
  slate: ["#181f2e", "#232c42", "#30405c", "#405478", "#566c94", "#7088ae"],
  teal: ["#0e2c30", "#164246", "#205a5e", "#2e7478", "#469296", "#74b4b4"],
  mint: ["#6c8a84", "#88a6a0", "#a6c0ba", "#c0d6d0", "#d8e8e4", "#ecf5f3"],
  purple: ["#24163a", "#382256", "#4e3074", "#664292", "#8460b0", "#a888cc"],
  pink: ["#5a2236", "#843450", "#ac4a6a", "#cc6686", "#e488a2", "#f4b2c4"],
  orange: ["#5a2a0c", "#864012", "#b05a1a", "#d27626", "#ec9a3e", "#f8c072"],
  leaf: ["#16301a", "#204424", "#2c5a2e", "#3a723a", "#4c8c46", "#66a854", "#8cc46a"],
  pine: ["#0e2420", "#16342c", "#1f463a", "#2a5a48", "#38705a", "#4c886c"],
  rubber: ["#0e0f12", "#1a1c20", "#292c31", "#3a3e44"],
  paint: { white: "#e6e6e0", whiteDim: "#c4c6c2", yellow: "#e8c23a", yellowDim: "#b8962a" },
};

// ---------------------------------------------------------------- 画布与绘图原语
const COLOR_CACHE = new Map();
function rgb(c) {
  if (typeof c !== "string") return c;
  let v = COLOR_CACHE.get(c);
  if (!v) {
    const h = c.replace("#", "");
    v = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255];
    COLOR_CACHE.set(c, v);
  }
  return v;
}
/** 两色线性混合（t=0 → a，t=1 → b），返回 hex。 */
function mix(a, b, t) {
  const A = rgb(a), B = rgb(b);
  const f = (i) => Math.round(A[i] + (B[i] - A[i]) * t).toString(16).padStart(2, "0");
  return "#" + f(0) + f(1) + f(2);
}
/** 加 alpha：withA("#rrggbb", 0..255)。 */
const withA = (c, a) => c.slice(0, 7) + clamp(Math.round(a), 0, 255).toString(16).padStart(2, "0");
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** 从色阶里取第 i 档（越界截断）。 */
const ramp = (r, i) => r[clamp(Math.round(i), 0, r.length - 1)];

class Canvas {
  /** wrap=true 时坐标按尺寸取模（无缝 tile 用）。 */
  constructor(w, h, wrap = false) { this.w = w; this.h = h; this.wrap = wrap; this.buf = Buffer.alloc(w * h * 4, 0); }
  idx(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (this.wrap) { x = ((x % this.w) + this.w) % this.w; y = ((y % this.h) + this.h) % this.h; }
    else if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return (y * this.w + x) * 4;
  }
  /** 写像素；颜色带 alpha（<255）时与底色做 source-over 混合。 */
  set(x, y, c) {
    const i = this.idx(x, y);
    if (i < 0 || c == null) return;
    const [r, g, b, a] = rgb(c);
    if (a >= 255) { this.buf[i] = r; this.buf[i + 1] = g; this.buf[i + 2] = b; this.buf[i + 3] = 255; return; }
    if (a <= 0) return;
    const da = this.buf[i + 3] / 255, sa = a / 255, oa = sa + da * (1 - sa);
    const s = [r, g, b];
    for (let k = 0; k < 3; k++) this.buf[i + k] = Math.round((s[k] * sa + this.buf[i + k] * da * (1 - sa)) / oa);
    this.buf[i + 3] = Math.round(oa * 255);
  }
  /** 直接覆盖（含 alpha，不混合）。 */
  put(x, y, c) {
    const i = this.idx(x, y);
    if (i < 0) return;
    const [r, g, b, a] = rgb(c);
    this.buf[i] = r; this.buf[i + 1] = g; this.buf[i + 2] = b; this.buf[i + 3] = a;
  }
  get(x, y) { const i = this.idx(x, y); return i < 0 ? [0, 0, 0, 0] : [this.buf[i], this.buf[i + 1], this.buf[i + 2], this.buf[i + 3]]; }
  alpha(x, y) { const i = this.idx(x, y); return i < 0 ? 0 : this.buf[i + 3]; }
  clear(x, y) { const i = this.idx(x, y); if (i >= 0) this.buf.fill(0, i, i + 4); }
  fill(c) { this.rect(0, 0, this.w, this.h, c); }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
  hline(x, y, w, c) { for (let i = 0; i < w; i++) this.set(x + i, y, c); }
  vline(x, y, h, c) { for (let j = 0; j < h; j++) this.set(x, y + j, c); }
  /** Bresenham 直线。 */
  line(x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
  }
  /** 实心椭圆（像素中心判定）；c 可为函数 (x,y,nx,ny) → 颜色，nx/ny 为归一化位置。 */
  ellipse(cx, cy, rx, ry, c) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1) this.set(x, y, typeof c === "function" ? c(x, y, nx, ny) : c);
      }
  }
  disc(cx, cy, r, c) { this.ellipse(cx, cy, r, r, c); }
  /** 圆环（r0 < d ≤ r1）；c 可为函数 (x,y,d)。 */
  ring(cx, cy, r0, r1, c) {
    for (let y = Math.floor(cy - r1); y <= Math.ceil(cy + r1); y++)
      for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= r1 && d > r0) this.set(x, y, typeof c === "function" ? c(x, y, d) : c);
      }
  }
  /** 棋盘格抖动：只在 (x+y)%2==phase 的像素上画。 */
  dither(x, y, w, h, c, phase = 0) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (((x + i + y + j) & 1) === phase) this.set(x + i, y + j, c);
  }
  /** 斜面盒：底色 + 左/上亮边 + 右/下暗边（光源左上）。 */
  bevel(x, y, w, h, base, light, dark) {
    this.rect(x, y, w, h, base);
    if (light) { this.hline(x, y, w - 1, light); this.vline(x, y, h - 1, light); }
    if (dark) { this.hline(x + 1, y + h - 1, w - 1, dark); this.vline(x + w - 1, y + 1, h - 1, dark); }
  }
  /** 对不透明像素调用 fn(x,y,[r,g,b,a]) → 新颜色或 null。 */
  map(fn) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const p = this.get(x, y);
      if (p[3] === 0) continue;
      const c = fn(x, y, p);
      if (c) this.put(x, y, c);
    }
  }
  /** 外描边：与不透明像素四邻接（可选八邻接）的透明像素填深色（需留 1px 透明边距）。 */
  outline(c = OUT, diagonal = false) {
    const s = new Uint8Array(this.w * this.h);
    for (let i = 0; i < s.length; i++) s[i] = this.buf[i * 4 + 3] > 128 ? 1 : 0;
    const at = (x, y) => x >= 0 && y >= 0 && x < this.w && y < this.h && s[y * this.w + x] === 1;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (s[y * this.w + x]) continue;
      let hit = at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1);
      if (!hit && diagonal) hit = at(x - 1, y - 1) || at(x + 1, y - 1) || at(x - 1, y + 1) || at(x + 1, y + 1);
      if (hit) this.put(x, y, c);
    }
  }
  /** 投影：当前不透明轮廓向右下 (dx,dy) 平移后落在透明处的像素填半透明暗色。 */
  dropShadow(dx = 1, dy = 2, c = SHADOW) {
    const src = Buffer.from(this.buf);
    const a = (x, y) => (x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : src[(y * this.w + x) * 4 + 3]);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (a(x, y) > 0) continue;
      for (let k = 1; k <= Math.max(dx, dy); k++) {
        const sx = Math.round((dx * k) / Math.max(dx, dy)), sy = Math.round((dy * k) / Math.max(dx, dy));
        if (a(x - sx, y - sy) > 128) { this.put(x, y, c); break; }
      }
    }
  }
  /** 把另一张画布贴到 (ox,oy)（source-over）。 */
  blit(src, ox, oy) {
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
      const p = src.get(x, y);
      if (p[3] > 0) this.set(ox + x, oy + y, p);
    }
  }
  /** 轮廓内侧明暗：右/下边缘像素压暗，左/上边缘像素提亮。 */
  rim(light, dark) {
    const src = Buffer.from(this.buf);
    const a = (x, y) => (x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : src[(y * this.w + x) * 4 + 3]);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (a(x, y) < 200) continue;
      if (dark && (a(x + 1, y) < 128 || a(x, y + 1) < 128)) this.put(x, y, dark);
      else if (light && (a(x - 1, y) < 128 || a(x, y - 1) < 128)) this.put(x, y, light);
    }
  }
}

// ---------------------------------------------------------------- 素材清单（契约 §2，名字/尺寸固定）
// [name, w, h, kind]；kind: "tile"（坐标取模，四方连续）/"img"/"atlas"
const SPEC = [];
const add = (kind, w, h, names) => { for (const n of names) SPEC.push([n, w, h, kind]); };
add("tile", 32, 32, ["tile-asphalt", "tile-asphalt-alley", "tile-sidewalk", "tile-sidewalk-brick", "tile-grass", "tile-grass-park",
  "tile-dirt-path", "tile-water", "tile-plaza", "tile-marble", "tile-boardwalk", "tile-parking"]);
add("tile", 32, 32, ["tile-floor-wood", "tile-floor-tile", "tile-floor-carpet", "tile-floor-concrete", "tile-floor-hospital"]);
add("tile", 32, 32, ["tile-roof-shingle-red", "tile-roof-shingle-brown", "tile-roof-shingle-blue", "tile-roof-flat-gray",
  "tile-roof-flat-dark", "tile-roof-tower", "tile-roof-hospital", "tile-hospital"]);
add("tile", 32, 32, ["tile-road", "tile-wall", "tile-roof"]); // 旧名别名
add("tile", 32, 32, ["tile-line-dash-h", "tile-line-dash-v", "tile-line-yellow-h", "tile-line-yellow-v", "tile-zebra-h", "tile-zebra-v"]);
for (const m of ["tile-wall-brick", "tile-wall-concrete", "tile-wall-plaster", "tile-wall-glass", "tile-fence", "tile-hedge"]) {
  SPEC.push([m + "-h", 32, 8, "tile"], [m + "-v", 8, 32, "tile"]);
}
SPEC.push(["prop-health", 16, 16, "img"], ["prop-ammo", 16, 16, "img"], ["prop-sculpture", 32, 32, "img"],
  ["prop-trafficlight", 12, 16, "img"], ["prop-door", 32, 8, "img"], ["prop-stairs", 32, 32, "img"]);
add("atlas", 64, 96, ["actor-player", "actor-npc", "actor-npc-b", "actor-npc-c", "actor-npc-d", "actor-npc-e", "actor-npc-f", "actor-police"]);
add("img", 64, 32, ["vehicle-car", "vehicle-car-red", "vehicle-car-white", "vehicle-car-green", "vehicle-taxi", "vehicle-police"]);
SPEC.push(["vehicle-van", 72, 34, "img"]);
SPEC.push(["prop-tree", 32, 32, "img"], ["prop-tree-big", 48, 48, "img"], ["prop-tree-pine", 32, 32, "img"], ["prop-bush", 16, 16, "img"],
  ["prop-flowerbed", 32, 16, "img"], ["prop-planter", 24, 24, "img"], ["prop-streetlamp", 12, 12, "img"], ["prop-bench-h", 32, 12, "img"],
  ["prop-bench-v", 12, 32, "img"], ["prop-hydrant", 8, 10, "img"], ["prop-bin", 12, 12, "img"], ["prop-fountain", 64, 64, "img"],
  ["prop-umbrella", 32, 32, "img"], ["prop-awning-red", 32, 12, "img"], ["prop-awning-blue", 32, 12, "img"],
  ["prop-awning-green", 32, 12, "img"], ["prop-awning-yellow", 32, 12, "img"],
  ["prop-stairs-up", 32, 32, "img"], ["prop-stairs-down", 32, 32, "img"], ["prop-roof-ac", 24, 20, "img"],
  ["prop-roof-vent", 12, 12, "img"], ["prop-helipad", 64, 64, "img"],
  ["prop-counter", 64, 16, "img"], ["prop-shelf", 32, 12, "img"], ["prop-table", 24, 24, "img"], ["prop-chair", 12, 12, "img"],
  ["prop-bed", 24, 40, "img"], ["prop-sofa", 40, 16, "img"], ["prop-plant", 12, 16, "img"], ["prop-rug", 48, 32, "img"],
  ["prop-desk", 32, 16, "img"], ["prop-hospital-bed", 24, 40, "img"], ["prop-rack", 32, 12, "img"], ["prop-cooler", 16, 16, "img"]);

/** name → { draw(c, rnd), note }；未注册的名字输出占位色块（仅过渡期）。 */
const DRAW = new Map();
const def = (name, note, draw) => DRAW.set(name, { note, draw });
/** 别名：与 src 用同一绘制函数和同一种子 → 像素完全一致。 */
const alias = (name, src, note) => DRAW.set(name, { note, draw: DRAW.get(src).draw, seed: src });

// ---------------------------------------------------------------- 共用纹理工具
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x, y) => BAYER4[(((y % 4) + 4) % 4) * 4 + (((x % 4) + 4) % 4)];
/** 浮点色阶值 → 4×4 有序抖动取档（周期 4，可整除所有 tile 尺寸 → 不破坏无缝）。 */
const dpick = (r, v, x, y, k = 0.6) => ramp(r, Math.floor(v + 0.5 + (bayer(x, y) - 0.5) * k));
const seedInt = (rnd) => (rnd() * 0x7fffffff) | 0;
/** 两层周期噪声，约 [-0.75, 0.75]。 */
const fbm = (c, x, y, s, cell = 8) =>
  (pnoise(x, y, cell, c.w, c.h, s) - 0.5) + (pnoise(x, y, Math.max(2, cell / 2), c.w, c.h, s + 31) - 0.5) * 0.5;
/** 浮点场：F[y*w+x]，读写都按画布 wrap 规则取模。 */
class Field {
  constructor(c, fn) {
    this.c = c; this.v = new Float32Array(c.w * c.h);
    if (fn) for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) this.v[y * c.w + x] = fn(x, y);
  }
  i(x, y) { const { w, h } = this.c; return ((((y % h) + h) % h) * w) + (((x % w) + w) % w); }
  get(x, y) { return this.v[this.i(x, y)]; }
  set(x, y, v) { this.v[this.i(x, y)] = v; }
  add(x, y, d) { this.v[this.i(x, y)] += d; }
  paint(r, k = 0.6) { for (let y = 0; y < this.c.h; y++) for (let x = 0; x < this.c.w; x++) this.c.put(x, y, dpick(r, this.get(x, y), x, y, k)); }
}
/** 随机游走（裂缝、纹理脉络）：沿主方向前进，偶尔侧移；fn(x,y,i)。 */
function walk(rnd, x, y, len, fn, horizontal = rnd() < 0.5) {
  const sx = rnd() < 0.5 ? 1 : -1, sy = rnd() < 0.5 ? 1 : -1;
  for (let i = 0; i < len; i++) {
    fn(x, y, i);
    if (horizontal) { x += sx; if (rnd() < 0.35) y += sy * (rnd() < 0.8 ? 1 : -1); }
    else { y += sy; if (rnd() < 0.35) x += sx * (rnd() < 0.8 ? 1 : -1); }
  }
}
/** 地面小石子：左上亮、右下暗，右下 1px 落影。 */
function pebble(c, x, y, w, h, r, base) {
  c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, (px, py, nx, ny) => ramp(r, base + (nx + ny < -0.4 ? 1 : nx + ny > 0.5 ? -1 : 0)));
  c.set(x + w, y + h - 1, "#00000040"); c.set(x + w - 1, y + h, "#00000040");
}
const randXY = (rnd, w = 32, h = 32) => [Math.floor(rnd() * w), Math.floor(rnd() * h)];
/** 抖动网格撒点：每 cell×cell 格以概率 p 放一个，偏移限制在 [m, cell-1-m-span]，分布均匀不扎堆。 */
function scatter(rnd, w, h, cell, p, fn, m = 1, span = 1) {
  for (let gy = 0; gy < h; gy += cell) for (let gx = 0; gx < w; gx += cell) {
    if (rnd() >= p) continue;
    const r = Math.max(1, cell - 2 * m - span + 1);
    fn(gx + m + Math.floor(rnd() * r), gy + m + Math.floor(rnd() * r), rnd);
  }
}

// ================================================================ 绘制函数（按组追加）

// ---------------------------------------------------------------- (a) 地面 tile：四方连续、无描边
const shiftRamp = (r, toward, t) => r.map((c) => mix(c, toward, t));
const ALLEY = shiftRamp(P.asphalt, "#6a5a48", 0.16);
const PARKING = shiftRamp(P.asphalt, "#56627a", 0.18);

/** 底色 + 大块斑驳 + 单像素骨料（light/dark 为亮/暗颗粒占比）。 */
function grainField(c, s, base, patch, light, dark, cell = 16) {
  return new Field(c, (x, y) => {
    let v = base + fbm(c, x, y, s, cell) * patch;
    const r = h2(x, y, s + 7);
    if (r < light) v += 1.3; else if (r > 1 - dark) v -= 1.2;
    return v;
  });
}
/** 裂缝：暗像素随机游走，右下侧 1px 受光边。 */
function crack(F, rnd, x, y, len, depth = 2.2, horizontal) {
  walk(rnd, x, y, len, (px, py) => { F.add(px, py, -depth); F.add(px + 1, py + 1, 0.45); }, horizontal);
}

def("tile-asphalt", "沥青路面：斑驳 + 骨料颗粒 + 细裂缝", (c, rnd) => {
  const s = seedInt(rnd);
  const F = grainField(c, s, 2.45, 0.8, 0.07, 0.05);
  crack(F, rnd, ...randXY(rnd), 8);
  F.paint(P.asphalt, 0.5);
});

def("tile-asphalt-alley", "小巷旧沥青：偏暖、补丁、多裂缝、砂砾", (c, rnd) => {
  const s = seedInt(rnd);
  const F = grainField(c, s, 2.85, 1.1, 0.08, 0.08);
  const [px, py] = randXY(rnd), pw = 9 + Math.floor(rnd() * 5), ph = 6 + Math.floor(rnd() * 4);
  for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) {
    const edge = i === 0 || j === 0 || i === pw - 1 || j === ph - 1;
    F.set(px + i, py + j, (edge ? 1.25 : 1.95) + (h2(i, j, s + 5) - 0.5) * 0.5);
  }
  for (let k = 0; k < 3; k++) crack(F, rnd, ...randXY(rnd), 6 + Math.floor(rnd() * 8), 2.4);
  scatter(rnd, 32, 32, 8, 0.6, (x, y) => { F.add(x, y, 1.6); F.add(x + 1, y + 1, -0.8); });
  F.paint(ALLEY, 0.55);
});

def("tile-sidewalk", "人行道：16×16 水泥板，缝隙 + 板边明暗 + 细裂纹", (c, rnd) => {
  const s = seedInt(rnd);
  const F = new Field(c, (x, y) => {
    const lx = x & 15, ly = y & 15;
    let v = 3.1 + fbm(c, x, y, s, 8) * 0.55 + (h2(x >> 4, y >> 4, s + 3) - 0.5) * 0.5;
    if (h2(x, y, s + 9) < 0.04) v -= 0.9;
    if (lx === 0 || ly === 0) return 1.15;
    if (lx === 1 || ly === 1) v += 0.85;
    else if (lx === 15 || ly === 15) v -= 0.65;
    return v;
  });
  crack(F, rnd, 18 + Math.floor(rnd() * 6), 3 + Math.floor(rnd() * 4), 7, 1.6, false);
  F.paint(P.concrete, 0.4);
});

def("tile-sidewalk-brick", "红砖步道：8×4 错缝砖，逐块色差 + 砖缝 + 上亮下暗", (c, rnd) => {
  const s = seedInt(rnd);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const row = y >> 2, X = x + (row & 1) * 4, bx = (X >> 3) & 3, lx = X & 7, ly = y & 3;
    if (ly === 3 || lx === 7) { c.put(x, y, dpick(P.mortar, 1.2 + fbm(c, x, y, s, 8) * 0.8, x, y)); continue; }
    let v = 3.0 + (h2(bx, row & 7, s) - 0.5) * 1.5 + fbm(c, x, y, s + 1, 8) * 0.4;
    if (ly === 0 || lx === 0) v += 0.75; else if (ly === 2 || lx === 6) v -= 0.55;
    if (h2(x, y, s + 4) < 0.05) v -= 0.8;
    c.put(x, y, dpick(P.brick, v, x, y, 0.4));
  }
});

def("tile-grass", "草地：大块明暗 + 草簇（亮尖暗根）", (c, rnd) => {
  const s = seedInt(rnd);
  const F = new Field(c, (x, y) => 2.55 + fbm(c, x, y, s, 16) * 1.0 + (pnoise(x, y, 4, 32, 32, s + 2) - 0.5) * 0.5);
  scatter(rnd, 32, 32, 8, 0.85, (x, y) => {
    F.add(x, y, 1.8); F.add(x - 1, y + 1, 1.1); F.add(x + 1, y + 1, 1.1); F.add(x, y + 1, -0.9); F.add(x + 1, y + 2, -0.6);
  }, 2, 1);
  scatter(rnd, 32, 32, 16, 0.6, (x, y) => { F.add(x, y, -1.1); F.add(x + 1, y, -1.1); }, 3, 2);
  F.paint(P.grass, 0.6);
});

def("tile-grass-park", "公园草坪：修剪斜纹 + 草簇 + 小白花/黄花", (c, rnd) => {
  const s = seedInt(rnd);
  const F = new Field(c, (x, y) => 3.15 + (((x + y) & 31) < 16 ? 0.3 : -0.3) + fbm(c, x, y, s, 16) * 0.7);
  scatter(rnd, 32, 32, 8, 0.6, (x, y) => {
    F.add(x, y, 1.5); F.add(x - 1, y + 1, 0.9); F.add(x + 1, y + 1, 0.9); F.add(x, y + 1, -0.9);
  }, 2, 1);
  F.paint(P.grass, 0.55);
  // 小白花（十字花瓣 + 黄蕊 + 右下落影）与零星彩点，放在 16×16 格内远离格边
  scatter(rnd, 32, 32, 16, 0.5, (x, y) => {
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) c.put(x + dx, y + dy, "#f2eee0");
    c.put(x, y, P.yellow[4]); c.put(x + 1, y + 1, P.grass[1]); c.put(x + 2, y, P.grass[2]); c.put(x + 1, y + 2, P.grass[2]);
  }, 4, 3);
  let k = 0;
  scatter(rnd, 32, 32, 16, 0.75, (x, y) => { c.put(x, y, k++ & 1 ? P.yellow[5] : P.pink[5]); c.put(x + 1, y + 1, P.grass[1]); }, 3, 2);
});

def("tile-dirt-path", "土路：斑驳 + 鹅卵石 + 小坑", (c, rnd) => {
  const s = seedInt(rnd);
  const F = grainField(c, s, 2.8, 1.0, 0.06, 0.07, 16);
  F.paint(P.dirt, 0.55);
  scatter(rnd, 32, 32, 16, 0.85, (x, y, r) => {
    pebble(c, x, y, 2 + Math.floor(r() * 2), 2, r() < 0.5 ? P.dirt : P.concrete, r() < 0.5 ? 4 : 2);
  }, 2, 4);
  scatter(rnd, 32, 32, 8, 0.3, (x, y) => { c.put(x, y, P.dirt[5]); c.put(x + 1, y + 1, P.dirt[1]); }, 2, 1);
});

def("tile-water", "水面：深浅流动 + 波峰高光/波谷暗线 + 闪光", (c, rnd) => {
  const s = seedInt(rnd);
  const F = new Field(c, (x, y) => 2.7 + fbm(c, x, y, s, 16) * 0.9);
  F.paint(P.water.slice(0, 6), 0.5);
  // 波纹：每 16×8 格一道（亮波峰 + 下方暗波谷），横向错开
  for (let gy = 0; gy < 32; gy += 8) for (let gx = 0; gx < 32; gx += 16) {
    if (rnd() < 0.15) continue;
    const len = 3 + Math.floor(rnd() * 3), x = gx + 2 + Math.floor(rnd() * (12 - len)), y = gy + 2 + Math.floor(rnd() * 4);
    for (let i = 0; i < len; i++) c.put(x + i, y, P.water[i === 0 || i === len - 1 ? 4 : 5]);
    for (let i = 1; i < len; i++) c.put(x + i, y + 1, P.water[1]);
  }
  scatter(rnd, 32, 32, 16, 0.75, (x, y) => c.put(x, y, P.water[6]), 3, 1);
});

def("tile-plaza", "广场石板：16×8 错缝砂岩，逐块色差 + 斜面明暗", (c, rnd) => {
  const s = seedInt(rnd);
  const F = new Field(c, (x, y) => {
    const row = y >> 3, X = x + (row & 1) * 8, bx = (X >> 4) & 1, lx = X & 15, ly = y & 7;
    if (lx === 0 || ly === 0) return 0.7;
    let v = 3.0 + (h2(bx, row & 3, s) - 0.5) * 1.2 + fbm(c, x, y, s, 8) * 0.45;
    if (h2(x, y, s + 6) < 0.05) v -= 0.8;
    if (lx === 1 || ly === 1) v += 0.75; else if (lx === 15 || ly === 7) v -= 0.6;
    return v;
  });
  F.paint(P.sand, 0.45);
});

def("tile-marble", "抛光大理石：16×16 黑白灰棋盘 + 脉络 + 斜向反光", (c, rnd) => {
  const s = seedInt(rnd);
  const F = new Field(c, (x, y) => {
    const dark = ((x >> 4) + (y >> 4)) & 1, lx = x & 15, ly = y & 15;
    if (lx === 0 || ly === 0) return 0.9;
    let v = (dark ? 2.2 : 4.1) + fbm(c, x, y, s, 8) * 0.45;
    if (lx === 1 || ly === 1) v += 0.6; else if (lx === 15 || ly === 15) v -= 0.5;
    if ((lx + ly === 7 && lx >= 2 && lx <= 5) || (lx + ly === 10 && lx >= 3 && lx <= 5)) v += 1.2;
    return v;
  });
  for (let k = 0; k < 3; k++) walk(rnd, ...randXY(rnd), 14, (x, y) => F.add(x, y, -0.85));
  F.paint(P.marble, 0.45);
});

def("tile-boardwalk", "木栈道：横向木板，缝隙/端缝错开 + 木纹 + 钉子 + 节疤", (c, rnd) => {
  const s = seedInt(rnd);
  const joints = [0, 2, 1, 3].map((k) => k * 8 + 3 + Math.floor(rnd() * 3)); // 端缝错开，且不落在 tile 边缘
  const F = new Field(c, (x, y) => {
    const r = y >> 3, ly = y & 7, jx = joints[r];
    if (ly === 0) return 0.2;
    const dx = (x - jx + 32) & 31;
    if (dx === 0) return 0.4;
    // 每行一块木板（端缝 jx 处断开，跨 tile 边缘连续），逐行色差 + 纵向木纹 + 低频斑驳
    let v = 3.0 + (h2(r, 0, s) - 0.5) * 0.9 + (h2(r * 8 + ly, 0, s + 1) - 0.5) * 0.7 + (pnoise(x, y, 8, 32, 32, s + 2) - 0.5) * 0.8;
    if (ly === 1) v += 0.9; else if (ly === 7) v -= 0.9;
    if (dx === 1) v += 0.6; else if (dx === 31) v -= 0.6;
    return v;
  });
  const kr = Math.floor(rnd() * 4), kx = Math.floor(rnd() * 32);
  F.add(kx, kr * 8 + 4, -1.6); F.add(kx - 1, kr * 8 + 4, -0.8); F.add(kx + 1, kr * 8 + 4, -0.8); F.add(kx, kr * 8 + 3, 0.8);
  F.paint(P.wood, 0.45);
  for (let r = 0; r < 4; r++) for (const nx of [joints[r] - 2, joints[r] + 2]) for (const ny of [r * 8 + 2, r * 8 + 6]) {
    c.put(nx, ny, P.metal[1]); c.put(nx, ny - 1, P.wood[4]);
  }
});

def("tile-parking", "停车场沥青：偏冷、更平整、油渍与轮胎印（无车位线）", (c, rnd) => {
  const s = seedInt(rnd);
  const F = grainField(c, s, 2.9, 0.6, 0.05, 0.04);
  const [ox, oy] = randXY(rnd);
  for (let j = -4; j <= 4; j++) for (let i = -6; i <= 6; i++) {
    const d = (i * i) / 36 + (j * j) / 16 + (pnoise(ox + i, oy + j, 4, 32, 32, s + 3) - 0.5) * 0.9;
    if (d < 1) F.add(ox + i, oy + j, d < 0.45 ? -1.5 : -0.8);
  }
  const ty = Math.floor(rnd() * 32);
  for (let x = 0; x < 32; x++) if (h2(x, 0, s + 8) < 0.7) { F.add(x, ty, -0.6); F.add(x, ty + 5, -0.6); }
  F.paint(PARKING, 0.5);
});

// 道路标线：透明底，位置严格按契约行列
/** 标线：油漆色 + 周期噪声磨损斑（成片、跨边连续）+ 极少量半透明剥落点。 */
function marking(c, rnd, on, col, dim) {
  const s = seedInt(rnd);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    if (!on(x, y)) continue;
    const wear = pnoise(x, y, 4, 32, 32, s);
    c.put(x, y, h2(x, y, s + 1) < 0.02 ? withA(dim, 150) : wear < 0.28 ? dim : col);
  }
}
const W = P.paint;
def("tile-line-dash-h", "白色虚线（横）：第 15–16 行，x 8–23 实线（每 32px 16px）", (c, rnd) =>
  marking(c, rnd, (x, y) => (y === 15 || y === 16) && x >= 8 && x < 24, W.white, W.whiteDim));
def("tile-line-dash-v", "白色虚线（纵）：第 15–16 列，y 8–23 实线（每 32px 16px）", (c, rnd) =>
  marking(c, rnd, (x, y) => (x === 15 || x === 16) && y >= 8 && y < 24, W.white, W.whiteDim));
def("tile-line-yellow-h", "双黄线（横）：第 13–14、17–18 行", (c, rnd) =>
  marking(c, rnd, (x, y) => y === 13 || y === 14 || y === 17 || y === 18, W.yellow, W.yellowDim));
def("tile-line-yellow-v", "双黄线（纵）：第 13–14、17–18 列", (c, rnd) =>
  marking(c, rnd, (x, y) => x === 13 || x === 14 || x === 17 || x === 18, W.yellow, W.yellowDim));
def("tile-zebra-h", "斑马线（横向条纹，用于横向道路）：第 4–11、20–27 行通宽白条", (c, rnd) =>
  marking(c, rnd, (x, y) => (y & 15) >= 4 && (y & 15) < 12, W.white, W.whiteDim));
def("tile-zebra-v", "斑马线（纵向条纹，用于纵向道路）：第 4–11、20–27 列通高白条", (c, rnd) =>
  marking(c, rnd, (x, y) => (x & 15) >= 4 && (x & 15) < 12, W.white, W.whiteDim));
alias("tile-road", "tile-asphalt", "旧名别名 = tile-asphalt");

// ---------------------------------------------------------------- (b) 墙（俯视墙顶，带厚度）、屋顶、地板
// 墙：u 沿墙长度（-h 为 x、-v 为 y，按 32 周期连续）；t 为厚度 0..7（0 = 受光的上/左沿，7 = 背光的下/右沿）。
// 统一结构：t0 深描边、t1 亮沿、t2–5 墙顶材质、t6 暗侧面、t7 深描边。mat 返回 null = 透明（栅栏/树篱的缝隙）。
function wall(c, rnd, mat, vertical) {
  const L = vertical ? c.h : c.w, s = seedInt(rnd);
  for (let u = 0; u < L; u++) for (let t = 0; t < 8; t++) {
    const col = mat(u, t, s, L);
    if (col) vertical ? c.put(t, u, col) : c.put(u, t, col);
  }
}
const WALLS = {
  brick: { note: "砖墙顶：两皮错缝砖 + 灰缝，亮压顶、暗侧面", mat: (u, t, s) => {
    if (t === 0 || t === 7) return OUT;
    if (t === 4) return dpick(P.mortar, 1.6 + (h2(u, 4, s) - 0.5), u, t);
    if (t === 1) return u % 8 === 7 ? P.mortar[3] : dpick(P.brick, 4.6 + (h2(u >> 3, 1, s) - 0.5) * 0.8, u, t);
    const B = t <= 3 ? 0 : 4, X = u + B, lx = X & 7, bi = (X >> 3) & 3;
    if (lx === 7) return t === 6 ? P.mortar[0] : P.mortar[1];
    let v = 3.2 + (h2(bi, t <= 3 ? 2 : 5, s) - 0.5) * 1.3 + (h2(u, t, s + 2) - 0.5) * 0.5;
    if (t === 2 || t === 5) v += 0.55;
    if (lx === 0) v += 0.4; else if (lx === 6) v -= 0.5;
    if (t === 6) v -= 1.6;
    return dpick(P.brick, v, u, t, 0.4);
  } },
  concrete: { note: "混凝土墙顶：浇筑缝每 16px + 斑点，亮沿暗侧", mat: (u, t, s, L) => {
    if (t === 0 || t === 7) return OUT;
    if (t === 1) return P.concrete[5];
    if (t === 6) return u % 16 === 15 ? P.concrete[0] : P.concrete[1];
    if (u % 16 === 15) return P.concrete[1];
    let v = 3.0 + (pnoise(u, t, 4, L, 8, s) - 0.5) * 0.9 - (t - 2) * 0.15;
    if (u % 16 === 0) v += 0.6;
    const r = h2(u, t, s + 1);
    if (r < 0.06) v -= 1; else if (r > 0.95) v += 0.8;
    return dpick(P.concrete, v, u, t, 0.5);
  } },
  plaster: { note: "抹灰墙顶：奶油色压顶线 + 细微斑驳与发丝裂纹", mat: (u, t, s, L) => {
    if (t === 0 || t === 7) return OUT;
    if (t === 1) return P.plaster[5];
    if (t === 2) return P.plaster[2];
    if (t === 6) return P.plaster[1];
    let v = 3.4 + (pnoise(u, t, 4, L, 8, s) - 0.5) * 0.8 - (t - 3) * 0.12;
    if (h2(u, t, s + 3) < 0.05) v -= 0.9;
    const cu = (s >>> 3) % L;
    if ((u === cu && t === 3) || (u === cu + 1 && t === 4) || (u === cu + 1 && t === 5)) v -= 1.3;
    return dpick(P.plaster, v, u, t, 0.5);
  } },
  glass: { note: "玻璃幕墙顶：金属框 + 每 16px 竖梃 + 斜向反光条", mat: (u, t) => {
    if (t === 0 || t === 7) return OUT;
    if (t === 1) return P.metal[5];
    if (t === 6) return P.metal[1];
    const m = u % 16;
    if (m === 15) return P.metal[2];
    if (m === 0) return P.metal[4];
    const d = (u + t) % 16;
    if (d === 3 || d === 4) return P.glass[6];
    if (d === 6) return P.glass[5];
    return P.glass[t === 2 ? 4 : t === 5 ? 2 : 3];
  } },
  fence: { note: "木栅栏：2px 尖桩每 4px + 两道横档 + 每 16px 立柱，缝隙透明带投影", mat: (u, t) => {
    const m = u % 16, k = u % 4;
    if (m >= 12 && m <= 14) { // 立柱
      if (t === 0 || t === 7) return OUT;
      if (m === 12) return t === 1 ? P.wood[4] : P.wood[3];
      if (m === 14) return t === 1 ? P.wood[2] : P.wood[1];
      return t === 1 ? P.wood[5] : t === 6 ? P.wood[1] : P.wood[2];
    }
    if (m === 15) return t >= 3 && t <= 4 ? (t === 3 ? P.wood[3] : P.wood[1]) : t === 2 || t === 5 ? OUT : t >= 6 ? SHADOW : null;
    if (k === 0 || k === 1) {
      if (t === 0 || t === 7) return OUT;
      if (t === 1) return k === 0 ? P.wood[5] : P.wood[4];
      if (t === 6) return P.wood[1];
      return k === 0 ? P.wood[4] : P.wood[2];
    }
    if (t === 2 || t === 5) return OUT;
    if (t === 3) return P.wood[3];
    if (t === 4) return P.wood[1];
    return t >= 6 && k === 2 ? SHADOW : null;
  } },
  hedge: { note: "树篱：不规则叶簇边缘，左上亮右下暗，叶片高光点", mat: (u, t, s, L) => {
    const top = pnoise(u, 0, 4, L, 8, s) < 0.5 ? 0 : 1, bot = pnoise(u, 4, 4, L, 8, s + 9) < 0.45 ? 7 : 6;
    if (t < top || t > bot) return t > bot ? SHADOW : null;
    if (t === top) return P.leaf[1];
    if (t === bot) return OUT;
    let v = 4.4 - (t - top) * 0.45 + (h2(u >> 1, t >> 1, s) - 0.5) * 1.4 + (h2(u, t, s + 1) - 0.5) * 0.6;
    if (h2(u, t, s + 2) < 0.07) v += 1.4;
    return dpick(P.leaf, v, u, t, 0.5);
  } },
};
for (const [k, w] of Object.entries(WALLS)) {
  const base = k === "fence" || k === "hedge" ? `tile-${k}` : `tile-wall-${k}`;
  def(base + "-h", w.note + "（横 32×8，沿 x 连续）", (c, rnd) => wall(c, rnd, w.mat, false));
  def(base + "-v", w.note + "（纵 8×32，沿 y 连续）", (c, rnd) => wall(c, rnd, w.mat, true));
}

def("tile-wall", "旧名别名：砖墙立面 32×32，8×4 顺砌错缝 + 灰缝明暗", (c, rnd) => {
  const s = seedInt(rnd);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const row = y >> 2, X = x + (row & 1) * 4, lx = X & 7, ly = y & 3, bi = (X >> 3) & 3;
    if (ly === 3) { c.put(x, y, lx === 7 ? P.mortar[0] : P.mortar[1]); continue; }
    if (lx === 7) { c.put(x, y, ly === 0 ? P.mortar[2] : P.mortar[1]); continue; }
    let v = 2.9 + (h2(bi, row & 7, s) - 0.5) * 1.4 + (pnoise(x, y, 8, 32, 32, s + 1) - 0.5) * 0.6 + (h2(x, y, s + 2) - 0.5) * 0.4;
    if (ly === 0) v += 0.8; else if (ly === 2) v -= 0.6;
    if (lx === 0) v += 0.3; else if (lx === 6) v -= 0.4;
    c.put(x, y, dpick(P.brick, v, x, y, 0.4));
  }
});

// 屋顶
function shingles(c, rnd, R) {
  const s = seedInt(rnd);
  new Field(c, (x, y) => {
    const row = y >> 3, ly = y & 7, X = x + (row & 1) * 4, lx = X & 7, tab = (X >> 3) & 3;
    if (ly === 7) return 0;
    if (lx === 7) return ly === 0 ? 1.2 : 0.4;
    if (ly === 6 && (lx === 0 || lx === 6)) return 0.6;
    let v = 3.4 + (h2(tab, row & 3, s) - 0.5) * 1.1 + (pnoise(x, y, 8, 32, 32, s + 1) - 0.5) * 0.7 - ly * 0.22;
    if (ly === 0) v += 1.0;
    if (lx === 0) v += 0.35; else if (lx === 6) v -= 0.4;
    if (h2(x, y, s + 2) < 0.05) v -= 0.9;
    return v;
  }).paint(R, 0.45);
}
const SHINGLE_BROWN = shiftRamp(P.brown, "#8a6a4a", 0.12);
def("tile-roof-shingle-red", "红瓦屋顶：错缝瓦片排，搭接阴影 + 瓦缝 + 逐片色差", (c, rnd) => shingles(c, rnd, P.red));
def("tile-roof-shingle-brown", "棕色沥青瓦屋顶：错缝瓦片排 + 搭接阴影", (c, rnd) => shingles(c, rnd, SHINGLE_BROWN));
def("tile-roof-shingle-blue", "蓝灰石板瓦屋顶：错缝瓦片排 + 搭接阴影", (c, rnd) => shingles(c, rnd, P.slate));

/** 平屋顶卷材：底色 + 砾石颗粒 + 每 16px 一道搭接缝（暗缝 + 下方亮棱）。 */
function flatRoof(c, rnd, R, base, seamEvery, grit) {
  const s = seedInt(rnd);
  const F = new Field(c, (x, y) => {
    const ly = y % seamEvery;
    if (ly === seamEvery - 1) return base - 1.5;
    let v = base + fbm(c, x, y, s, 16) * 0.8;
    if (ly === 0) v += 0.9;
    const r = h2(x, y, s + 1);
    if (r < grit) v += 1.2; else if (r > 1 - grit) v -= 1.1;
    return v;
  });
  return F;
}
def("tile-roof-flat-gray", "灰色平屋顶：卷材 + 砾石颗粒 + 搭接缝 + 补丁", (c, rnd) => {
  const F = flatRoof(c, rnd, P.concrete, 2.6, 16, 0.08);
  const [px, py] = randXY(rnd);
  for (let j = 0; j < 5; j++) for (let i = 0; i < 7; i++) F.add(px + i, py + 2 + j, i === 0 || j === 0 ? 0.6 : -0.45);
  F.paint(P.concrete, 0.5);
});
def("tile-roof-flat-dark", "深色沥青平屋顶：每 8px 卷材搭接 + 鼓包 + 积水暗斑", (c, rnd) => {
  const s = seedInt(rnd) + 77;
  const F = flatRoof(c, rnd, P.black, 3.0, 8, 0.06);
  scatter(rnd, 32, 32, 16, 0.7, (x, y) => { F.add(x, y, 1.3); F.add(x + 1, y, 0.8); F.add(x, y + 1, -0.9); F.add(x + 1, y + 1, -1.1); }, 3, 2);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (pnoise(x, y, 8, 32, 32, s) > 0.78) F.add(x, y, -0.7);
  F.paint(P.black, 0.5);
});
def("tile-roof-tower", "高层金属屋面：每 8px 立边咬合肋（亮棱 + 暗影）+ 横向板缝 + 螺栓", (c, rnd) => {
  const s = seedInt(rnd);
  new Field(c, (x, y) => {
    const lx = x & 7;
    if (lx === 0) return 4.6;
    if (lx === 1) return 1.0;
    if (y === 16) return lx === 2 ? 1.0 : 1.6;
    if (y === 17) return 3.6;
    let v = 3.0 - (lx - 2) * 0.12 + (pnoise(x, y, 8, 32, 32, s) - 0.5) * 0.6;
    if ((y === 4 || y === 28) && lx === 4) v = 4.8;
    if ((y === 5 || y === 29) && lx === 5) v = 1.2;
    return v;
  }).paint(P.slate, 0.4);
});
def("tile-roof-hospital", "医院屋面：浅薄荷白卷材，16px 面板浅缝 + 细砂颗粒", (c, rnd) => {
  const s = seedInt(rnd);
  new Field(c, (x, y) => {
    const lx = x & 15, ly = y & 15;
    if (lx === 15 || ly === 15) return 1.8;
    let v = 3.9 + (pnoise(x, y, 8, 32, 32, s) - 0.5) * 0.7 + (h2(x >> 4, y >> 4, s + 1) - 0.5) * 0.4;
    if (lx === 0 || ly === 0) v += 0.8;
    const r = h2(x, y, s + 2);
    if (r < 0.05) v -= 1; else if (r > 0.96) v += 0.8;
    return v;
  }).paint(P.mint, 0.45);
});
def("tile-hospital", "医院标识：白底薄荷边框 + 居中红十字（亮左上、暗右下），四方连续", (c, rnd) => {
  const s = seedInt(rnd);
  new Field(c, (x, y) => {
    if (x === 0 || y === 0) return 2.0;
    if (x === 1 || y === 1) return 5.4;
    let v = 4.6 + (pnoise(x, y, 8, 32, 32, s) - 0.5) * 0.4;
    if (x === 31 || y === 31) v -= 1.0;
    return v;
  }).paint(P.mint, 0.4);
  const inCross = (x, y) => (x >= 12 && x <= 19 && y >= 6 && y <= 25) || (x >= 6 && x <= 25 && y >= 12 && y <= 19);
  for (let y = 4; y < 28; y++) for (let x = 4; x < 28; x++) {
    if (inCross(x, y)) {
      let v = 3.2;
      if (!inCross(x - 1, y) || !inCross(x, y - 1)) v = 4.4;
      else if (!inCross(x + 1, y) || !inCross(x, y + 1)) v = 1.6;
      c.put(x, y, dpick(P.red, v, x, y, 0.3));
    } else if (inCross(x - 1, y - 1) || inCross(x - 1, y) || inCross(x, y - 1)) c.put(x, y, P.mint[2]);
  }
});
alias("tile-roof", "tile-roof-flat-gray", "旧名别名 = tile-roof-flat-gray");

// 室内地板
def("tile-floor-wood", "木地板：4px 窄条，端缝逐行错开 + 木纹条带 + 节疤 + 上亮下暗", (c, rnd) => {
  const s = seedInt(rnd);
  const joints = [0, 5, 2, 7, 4, 1, 6, 3].map((k) => 3 + k * 3 + Math.floor(rnd() * 2));
  const F = new Field(c, (x, y) => {
    const r = y >> 2, ly = y & 3, jx = joints[r];
    if (ly === 3) return 0.6;
    if (x === jx) return 0.9;
    let v = 3.3 + (h2(r, x < jx ? 0 : 1, s) - 0.5) * 1.0 + (h2(y, (x + r * 7) >> 3, s + 1) - 0.5) * 0.5 + (pnoise(x, y, 8, 32, 32, s + 2) - 0.5) * 0.5;
    if (ly === 0) v += 0.7;
    if (x === jx + 1) v += 0.4;
    return v;
  });
  scatter(rnd, 32, 32, 16, 0.6, (x, y) => { const yy = (y & ~3) + 1; F.add(x, yy, -1.4); F.add(x + 1, yy, -0.7); F.add(x - 1, yy, -0.5); }, 3, 2);
  F.paint(P.wood, 0.45);
});
def("tile-floor-tile", "瓷砖地面：8px 方砖，两色微棋盘 + 灰缝 + 砖面斜面明暗", (c, rnd) => {
  const s = seedInt(rnd);
  new Field(c, (x, y) => {
    const lx = x & 7, ly = y & 7;
    if (lx === 7 || ly === 7) return 1.2;
    let v = ((x >> 3) + (y >> 3)) & 1 ? 3.4 : 4.0;
    v += (h2(x >> 3, y >> 3, s) - 0.5) * 0.4 + (h2(x, y, s + 1) - 0.5) * 0.3;
    if (lx === 0 || ly === 0) v += 0.7; else if (lx === 6 || ly === 6) v -= 0.5;
    if (lx + ly === 3 && lx >= 1 && lx <= 2) v += 0.9;
    return v;
  }).paint(P.plaster, 0.4);
});
def("tile-floor-carpet", "地毯：酒红编织纹（交错抖动）+ 16px 菱形暗花", (c, rnd) => {
  const s = seedInt(rnd);
  new Field(c, (x, y) => {
    const lx = x & 15, ly = y & 15, d = Math.abs(lx - 8) + Math.abs(ly - 8);
    let v = 2.4 + ((x + (y >> 1)) & 1 ? 0.35 : -0.35) + (pnoise(x, y, 8, 32, 32, s) - 0.5) * 0.6;
    if (d === 6) v += 1.4;
    if (d === 7) v -= 0.6;
    if (d === 0) v += 1.8;
    if (d === 2 && (lx === 8 || ly === 8)) v += 1.0;
    return v;
  }).paint(P.maroon, 0.4);
});
def("tile-floor-concrete", "水泥地面：磨光斑驳 + 每 32px 切缝 + 油渍与碎屑", (c, rnd) => {
  const s = seedInt(rnd);
  const F = new Field(c, (x, y) => {
    if (x === 16 || y === 16) return 1.0;
    let v = 2.7 + fbm(c, x, y, s, 16) * 0.9;
    if (x === 17 || y === 17) v += 0.6;
    const r = h2(x, y, s + 1);
    if (r < 0.04) v -= 0.9; else if (r > 0.97) v += 0.9;
    return v;
  });
  const [ox, oy] = randXY(rnd);
  for (let j = -3; j <= 3; j++) for (let i = -4; i <= 4; i++) if ((i * i) / 16 + (j * j) / 9 + (h2(i, j, s + 3) - 0.5) * 0.5 < 1) F.add(ox + i, oy + j, -0.7);
  F.paint(P.concrete, 0.5);
});
def("tile-floor-hospital", "医院地胶：浅薄荷色，16px 浅缝 + 水磨石碎点", (c, rnd) => {
  const s = seedInt(rnd);
  new Field(c, (x, y) => {
    const lx = x & 15, ly = y & 15;
    if (lx === 15 || ly === 15) return 2.2;
    let v = 3.7 + (pnoise(x, y, 8, 32, 32, s) - 0.5) * 0.5;
    if (lx === 0 || ly === 0) v += 0.6;
    const r = h2(x, y, s + 1);
    if (r < 0.07) v -= 1.4; else if (r > 0.95) v += 1.3;
    return v;
  }).paint(P.mint, 0.4);
});

// ---------------------------------------------------------------- (c) 街道道具、建筑物件、室内家具
// 物件约定：留 1px 透明边距；先画体积（左上亮右下暗），再 outline() 描边，最后 dropShadow() 投右下影。
const finish = (c, sx = 1, sy = 1) => { c.outline(); if (sx || sy) c.dropShadow(sx, sy); };
/** 球面明暗：法线朝左上越亮。r 为色阶，base 中心档，k 明暗幅度。 */
const sphere = (r, base, k = 1.6) => (x, y, nx, ny) => dpick(r, base - (nx + ny) * k * 0.5 - (nx * nx + ny * ny) * 0.6, x, y, 0.5);
/** 树冠：多个叶团叠加，每团独立球面明暗，团间留暗缝。 */
function canopy(c, rnd, cx, cy, R, lobes, ramp_) {
  c.ellipse(cx + 1.5, cy + 2, R, R * 0.92, ramp_[0]);
  const pts = [];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rnd() * 0.6, d = R * (0.45 + rnd() * 0.12);
    pts.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.92, R * (0.46 + rnd() * 0.1)]);
  }
  pts.sort((a, b) => a[0] + a[1] - (b[0] + b[1])).reverse(); // 右下的先画，左上的盖在上面
  for (const [x, y, r] of pts) c.ellipse(x, y, r, r, sphere(ramp_, 3.2, 2.4));
  c.ellipse(cx - R * 0.12, cy - R * 0.12, R * 0.5, R * 0.48, sphere(ramp_, 4.0, 2.2));
  // 叶片高光点 + 暗点
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    if (c.alpha(x, y) < 255) continue;
    const r = h2(x, y, 911), dd = (x - cx) + (y - cy);
    if (r < 0.08 && dd < 0) c.put(x, y, ramp_[Math.min(ramp_.length - 1, 5)]);
    else if (r > 0.93) c.put(x, y, ramp_[1]);
  }
}
def("prop-tree", "行道树：俯视圆形树冠（多叶团体积 + 高光）+ 右下投影", (c, rnd) => {
  canopy(c, rnd, 15, 15, 12.5, 6, P.leaf);
  c.outline(); c.dropShadow(2, 3);
});
def("prop-tree-big", "大树：更大的多叶团树冠 + 投影", (c, rnd) => {
  canopy(c, rnd, 22.5, 22.5, 19.5, 8, P.leaf);
  c.outline(); c.dropShadow(3, 4);
});
def("prop-tree-pine", "松树：星形针叶层（三层由大到小），顶端亮尖 + 投影", (c, rnd) => {
  const cx = 15.5, cy = 15.5;
  for (const [R, base] of [[13, 2.2], [9.5, 3.1], [5.5, 4.0]]) {
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, a = Math.atan2(dy, dx), d = Math.hypot(dx, dy);
      const edge = R * (0.78 + 0.22 * Math.abs(Math.cos(a * 4 + R)));
      if (d <= edge) c.put(x, y, dpick(P.pine, base - (dx + dy) / (R * 1.6) + (d / edge > 0.8 ? -0.6 : 0), x, y, 0.5));
    }
  }
  c.put(15, 15, P.pine[5]); c.put(16, 15, P.leaf[5]); c.put(15, 16, P.pine[5]);
  c.outline(); c.dropShadow(2, 3);
});
def("prop-bush", "灌木：小叶团 + 高光 + 投影", (c, rnd) => {
  canopy(c, rnd, 7.5, 7.5, 6, 4, P.leaf);
  finish(c, 1, 2);
});
def("prop-flowerbed", "花坛：砖石围边 + 深色土 + 红黄粉白花簇", (c, rnd) => {
  c.bevel(1, 1, 30, 13, P.concrete[3], P.concrete[5], P.concrete[1]);
  for (let x = 2; x < 30; x += 4) c.vline(x + 3, 1, 1, P.concrete[2]);
  new Field(c);
  for (let y = 3; y < 12; y++) for (let x = 3; x < 29; x++) c.put(x, y, dpick(P.dirt, 1.0 + (h2(x, y, 5) - 0.5) * 1.2, x, y));
  for (let y = 3; y < 12; y++) c.put(3, y, P.dirt[0]);
  c.hline(3, 3, 26, P.dirt[0]);
  const cols = [P.red, P.yellow, P.pink, P.white];
  let k = 0;
  for (let y = 4; y < 11; y += 3) for (let x = 4 + ((y >> 1) & 1) * 2; x < 28; x += 4) {
    const col = cols[(k++ + Math.floor(rnd() * 2)) % 4];
    c.put(x + 1, y + 1, P.leaf[2]); c.put(x - 1, y + 1, P.leaf[3]);
    c.put(x, y, col[4]); c.put(x + 1, y, col[3]); c.put(x, y + 1, col[2]); c.put(x - 1, y, col[3]); c.put(x, y - 1, col[5]);
  }
  finish(c, 1, 1);
});
def("prop-planter", "方形花槽：石质槽沿（亮左上暗右下）+ 土 + 小灌木", (c, rnd) => {
  c.bevel(1, 1, 21, 21, P.concrete[3], P.concrete[5], P.concrete[1]);
  c.bevel(3, 3, 17, 17, P.dirt[1], P.dirt[0], P.dirt[2]);
  const sub = new Canvas(24, 24);
  canopy(sub, rnd, 11.5, 11.5, 7, 5, P.leaf);
  sub.outline();
  c.blit(sub, 0, 0);
  finish(c, 1, 1);
});
def("prop-streetlamp", "路灯（俯视）：灯头圆罩 + 暖色发光芯 + 光晕", (c) => {
  c.disc(5.5, 5.5, 5, withA("#ffe8a0", 60));
  c.disc(5.5, 5.5, 3.6, (x, y, nx, ny) => ramp(P.metal, 4 - (nx + ny) * 1.6));
  c.disc(5.5, 5.5, 1.8, (x, y, nx, ny) => (nx + ny < 0 ? "#fff8d8" : "#ffe08a"));
  c.ring(5.5, 5.5, 3.6, 4.4, OUT);
});
function bench(c, vertical) {
  const L = 30, put = (u, t, col) => (vertical ? c.put(t, u, col) : c.put(u, t, col));
  for (let u = 1; u < 1 + L; u++) {
    for (let t = 1; t <= 9; t++) {
      const slat = t <= 2 ? 0 : t <= 5 ? 1 : 2; // 靠背 / 座板两条
      const lt = t === 1 || t === 3 || t === 7;
      const dk = t === 2 || t === 5 || t === 9;
      let col = dk ? P.wood[2] : lt ? P.wood[5] : P.wood[4];
      if (t === 6) col = P.wood[0];
      if (slat === 0) col = t === 1 ? P.metal[4] : P.metal[2];
      if ((u === 3 || u === L - 2) && t >= 3) col = t === 3 ? P.metal[5] : P.metal[2];
      put(u, t, col);
    }
  }
  if (vertical) { c.outline(); c.dropShadow(1, 1); } else { c.outline(); c.dropShadow(1, 1); }
}
def("prop-bench-h", "长椅（横）：金属靠背 + 两条木座板 + 铁扶手 + 投影", (c) => bench(c, false));
def("prop-bench-v", "长椅（纵）：金属靠背 + 两条木座板 + 铁扶手 + 投影", (c) => bench(c, true));
def("prop-hydrant", "消防栓：红色圆顶 + 侧接口 + 高光", (c) => {
  c.rect(1, 3, 6, 3, P.red[2]); c.put(1, 4, P.red[3]); c.put(6, 4, P.red[1]); // 侧接口
  c.ellipse(3.5, 4.5, 2.6, 3, sphere(P.red, 3.2, 2.2));
  c.disc(3.5, 4, 1.2, P.yellow[3]); c.put(3, 3, P.yellow[5]);
  c.outline(); c.dropShadow(1, 1);
});
def("prop-bin", "垃圾桶：深绿桶身 + 桶沿亮环 + 桶内深色 + 投影", (c) => {
  c.disc(5.5, 5.5, 4.5, (x, y, nx, ny) => ramp(P.green, 3 - (nx + ny) * 1.4));
  c.disc(5.5, 5.5, 3.2, P.black[2]);
  c.disc(5.0, 5.0, 2.0, P.black[1]);
  c.put(6, 6, P.white[2]); c.put(4, 6, P.orange[3]);
  c.outline(); c.dropShadow(1, 1);
});
def("prop-fountain", "喷泉：圆形石质池沿（亮左上暗右下）+ 水面波纹 + 中央喷泉台 + 水花", (c, rnd) => {
  const cx = 31.5, cy = 31.5;
  c.disc(cx, cy, 30, (x, y) => { // 池沿
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, a = Math.atan2(dy, dx);
    return dpick(P.marble, 2.8 - Math.cos(a + Math.PI * 0.75) * 1.4 + (h2(x, y, 3) - 0.5) * 0.6, x, y);
  });
  c.ring(cx, cy, 24.5, 26, (x, y) => (x + y < 63 ? P.marble[1] : P.marble[5]));
  c.disc(cx, cy, 24.5, (x, y) => { // 水
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    let v = 2.4 + (pnoise(x, y, 8, 64, 64, 4) - 0.5) * 1.2 + (x + y < 63 ? -0.4 : 0.3);
    if (Math.abs((d % 6) - 3) < 0.5 && d > 9) v += 1.4;
    return dpick(P.water, v, x, y);
  });
  c.disc(cx + 1, cy + 1.5, 9, withA(P.water[0], 160));
  c.disc(cx, cy, 8, (x, y, nx, ny) => dpick(P.marble, 3.2 - (nx + ny) * 1.4, x, y)); // 喷泉台
  c.disc(cx, cy, 5.5, (x, y, nx, ny) => dpick(P.water, 4.4 - (nx + ny), x, y));
  c.disc(cx - 0.5, cy - 0.5, 2.2, P.water[6]);
  for (let i = 0; i < 12; i++) { // 水花
    const a = (i / 12) * Math.PI * 2, d = 11 + rnd() * 6;
    c.put(cx + Math.cos(a) * d, cy + Math.sin(a) * d, P.water[6]);
    c.put(cx + Math.cos(a) * (d - 1.5), cy + Math.sin(a) * (d - 1.5), P.water[5]);
  }
  c.ring(cx, cy, 30, 31, OUT);
  c.ring(cx, cy, 24, 24.6, OUT);
});
def("prop-umbrella", "遮阳伞：8 片红白相间伞面，伞骨暗线，左上受光 + 投影", (c) => {
  const cx = 15.5, cy = 15.5, R = 13.5;
  c.disc(cx, cy, R, (x, y) => {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, a = Math.atan2(dy, dx), d = Math.hypot(dx, dy);
    const seg = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 8 + 0.5) % 8;
    const frac = (((a + Math.PI) / (Math.PI * 2)) * 8 + 0.5) % 1;
    const light = -(dx + dy) / (R * 1.4);
    const R_ = seg & 1 ? P.white : P.red;
    if (frac < 0.07 || frac > 0.93) return R_[1];
    return dpick(R_, 3.2 + light * 1.6 - (d / R) * 0.6, x, y);
  });
  c.disc(cx, cy, 1.6, P.wood[3]); c.put(15, 15, P.wood[5]);
  c.outline(); c.dropShadow(2, 2);
});
function awning(c, R) {
  // 俯视条纹雨棚：4px 竖条纹，靠墙（上）亮、外缘（下）渐暗，下缘荷叶边
  for (let x = 0; x < 32; x++) {
    const stripe = (x >> 2) & 1, S = stripe ? P.white : R, lx = x & 3;
    const scal = 9 + (lx === 0 || lx === 3 ? 0 : 1);
    for (let y = 0; y <= scal; y++) {
      let v = 4.0 - y * 0.24;
      if (y === 0) v = 5;
      if (lx === 3) v -= 0.5;
      if (y === scal) v = 1.4;
      c.put(x, y, dpick(S, v, x, y, 0.4));
    }
    c.put(x, 0, P.metal[stripe ? 4 : 3]);
  }
  for (let x = 0; x < 32; x++) for (let y = 1; y < 12; y++) if (c.alpha(x, y) === 0 && c.alpha(x, y - 1) > 200 && c.get(x, y - 1)[0] !== 0x14) c.put(x, y, OUT);
  for (let x = 1; x < 32; x++) for (let y = 1; y < 12; y++) if (c.alpha(x, y) === 0 && c.alpha(x - 1, y - 1) > 200) c.put(x, y, SHADOW);
}
def("prop-awning-red", "红白条纹雨棚（俯视，靠墙在上，下缘荷叶边）", (c) => awning(c, P.red));
def("prop-awning-blue", "蓝白条纹雨棚（俯视，靠墙在上，下缘荷叶边）", (c) => awning(c, P.blue));
def("prop-awning-green", "绿白条纹雨棚（俯视，靠墙在上，下缘荷叶边）", (c) => awning(c, P.green));
def("prop-awning-yellow", "黄白条纹雨棚（俯视，靠墙在上，下缘荷叶边）", (c) => awning(c, P.yellow));

// 楼梯：up = 台阶自下向上逐级变亮（越高越近光源）+ 亮色上箭头；down = 逐级变暗 + 暗色下箭头
function stairs(c, up) {
  const R = up ? P.concrete : P.metal;
  c.bevel(1, 1, 30, 30, R[2], R[4], R[0]);
  for (let i = 0; i < 7; i++) {
    const y = 3 + i * 4, lv = up ? 5 - i * 0.55 : 1.5 + (6 - i) * 0.1 - i * 0.12;
    for (let x = 3; x < 29; x++) {
      c.put(x, y, ramp(R, lv + 0.8));
      c.put(x, y + 1, ramp(R, lv));
      c.put(x, y + 2, ramp(R, lv - 0.2));
      c.put(x, y + 3, up ? ramp(R, lv - 1.6) : OUT);
    }
  }
  c.vline(2, 2, 28, R[1]); c.vline(29, 2, 28, R[0]);
  // 箭头单独画在子画布上，描深色边后贴回 → 在任何台阶明度上都清晰
  const ac = up ? P.yellow : P.orange, ax = 15, A = new Canvas(32, 32);
  if (up) { // 上箭头 ▲
    for (let j = 0; j < 6; j++) A.hline(ax - j, 8 + j, 2 * j + 2, j === 0 ? ac[5] : ac[4]);
    A.rect(ax - 1, 14, 4, 9, ac[3]); A.vline(ax - 1, 14, 9, ac[5]); A.vline(ax + 2, 14, 9, ac[2]);
  } else { // 下箭头 ▼
    A.rect(ax - 1, 8, 4, 9, ac[3]); A.vline(ax - 1, 8, 9, ac[4]); A.vline(ax + 2, 8, 9, ac[1]);
    for (let j = 0; j < 6; j++) A.hline(ax - 5 + j, 17 + j, 12 - 2 * j, j === 5 ? ac[2] : ac[3]);
  }
  A.outline(); A.dropShadow(1, 1);
  c.blit(A, 0, 0);
  c.outline();
}
def("prop-stairs-up", "上楼梯：浅色台阶由下往上逐级变亮 + 黄色上箭头", (c) => stairs(c, true));
def("prop-stairs-down", "下楼梯：深色台阶逐级没入阴影（踏步边深色）+ 橙色下箭头", (c) => stairs(c, false));
def("prop-stairs", "旧名兼容 = 上楼梯", (c) => stairs(c, true));
def("prop-roof-ac", "屋顶空调外机：金属箱体 + 圆形风扇格栅 + 散热片 + 投影", (c) => {
  c.bevel(1, 1, 21, 17, P.metal[4], P.metal[6], P.metal[2]);
  for (let y = 3; y < 16; y += 2) c.hline(15, y, 5, P.metal[3]);
  c.disc(8.5, 9.5, 6, P.metal[1]);
  c.ring(8.5, 9.5, 4.8, 6, (x, y) => (x + y < 18 ? P.metal[2] : P.metal[5]));
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; c.line(8.5, 9.5, 8.5 + Math.cos(a) * 4, 9.5 + Math.sin(a) * 4, P.metal[3]); }
  c.disc(8.5, 9.5, 1.2, P.metal[5]);
  finish(c, 1, 1);
});
def("prop-roof-vent", "屋顶排风帽：圆形金属顶 + 百叶缝 + 投影", (c) => {
  c.disc(5.5, 5.5, 4.5, (x, y, nx, ny) => ramp(P.metal, 4 - (nx + ny) * 1.4));
  for (const y of [4, 6, 8]) c.hline(3, y, 5, P.metal[1]);
  c.put(4, 3, P.metal[6]);
  c.outline(); c.dropShadow(1, 1);
});
def("prop-helipad", "直升机停机坪：深色圆台 + 黄色外圈 + 白色 H + 边灯", (c) => {
  const cx = 31.5, cy = 31.5;
  c.disc(cx, cy, 30.5, (x, y) => dpick(P.asphalt, 3.2 + (pnoise(x, y, 8, 64, 64, 9) - 0.5) * 0.8 - (x + y - 63) / 60, x, y));
  c.ring(cx, cy, 25, 27, (x, y) => (h2(x, y, 4) < 0.1 ? P.paint.yellowDim : P.paint.yellow));
  const H = (x, y) => (x >= 22 && x <= 27 && y >= 18 && y <= 45) || (x >= 36 && x <= 41 && y >= 18 && y <= 45) || (x >= 22 && x <= 41 && y >= 29 && y <= 34);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (H(x, y)) c.put(x, y, !H(x + 1, y) || !H(x, y + 1) ? P.white[3] : P.paint.white);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; const x = cx + Math.cos(a) * 29, y = cy + Math.sin(a) * 29; c.put(x, y, "#9cf0a0"); c.put(x + 1, y, "#4ab060"); }
  c.ring(cx, cy, 30.5, 31.5, OUT);
});

// 室内家具（俯视）
const woodTop = (c, x, y, w, h, R = P.wood, base = 3.4) => {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let v = base + (h2(0, (y + j) * 3 + ((x + i) >> 4), 21) - 0.5) * 0.6 + (h2(x + i, y + j, 22) < 0.04 ? -0.8 : 0);
    if (j === 0 || i === 0) v += 1.2; else if (j === h - 1 || i === w - 1) v -= 1.4;
    c.put(x + i, y + j, dpick(R, v, x + i, y + j, 0.4));
  }
};
def("prop-counter", "柜台：木质台面 + 前侧面板（暗）+ 收银机 + 小物件", (c) => {
  woodTop(c, 1, 1, 62, 9);
  c.rect(1, 10, 62, 4, P.wood[1]); c.hline(1, 10, 62, P.wood[2]);
  for (let x = 8; x < 62; x += 12) c.vline(x, 11, 3, P.wood[0]);
  c.bevel(42, 2, 10, 7, P.metal[3], P.metal[5], P.metal[1]); c.rect(44, 3, 5, 2, "#5ac8a0"); c.hline(44, 6, 6, P.metal[2]);
  c.bevel(8, 3, 6, 4, P.white[4], P.white[5], P.white[2]);
  c.disc(25, 5, 2, sphere(P.orange, 3, 1.6)); c.disc(29, 5.5, 1.6, sphere(P.red, 3, 1.6));
  finish(c, 1, 1);
});
const shelfItems = [P.red, P.blue, P.yellow, P.green, P.orange, P.pink, P.teal, P.purple];
function shelf(c, rnd, metal) {
  c.bevel(1, 1, 30, 9, metal ? P.metal[3] : P.wood[3], metal ? P.metal[5] : P.wood[5], metal ? P.metal[1] : P.wood[1]);
  c.hline(2, 5, 28, metal ? P.metal[2] : P.wood[2]);
  for (const y of [2, 6]) for (let x = 3; x < 29;) {
    const w = 2 + Math.floor(rnd() * 2), R = shelfItems[Math.floor(rnd() * shelfItems.length)];
    c.rect(x, y, w, 3, R[3]); c.hline(x, y, w, R[5]); c.vline(x + w - 1, y + 1, 2, R[1]);
    x += w + (rnd() < 0.3 ? 1 : 0);
  }
  if (metal) for (const x of [1, 15, 30]) c.vline(x, 1, 9, P.metal[1]);
  finish(c, 1, 1);
}
def("prop-shelf", "货架（木）：两层隔板 + 彩色商品（亮顶暗侧）", (c, rnd) => shelf(c, rnd, false));
def("prop-rack", "金属货架：立柱 + 两层隔板 + 箱装商品", (c, rnd) => shelf(c, rnd, true));
def("prop-table", "餐桌：木纹桌面 + 桌布中线 + 杯盘", (c) => {
  woodTop(c, 2, 2, 19, 19);
  c.disc(8, 8, 2.5, P.white[4]); c.disc(8, 8, 1.2, P.white[2]);
  c.disc(15, 14, 2.5, P.white[4]); c.disc(15, 14, 1.2, P.orange[3]);
  c.disc(15, 7.5, 1.3, P.blue[4]);
  finish(c, 1, 1);
});
def("prop-chair", "椅子：木座面 + 上侧靠背 + 投影", (c) => {
  woodTop(c, 2, 4, 7, 6, P.wood, 3.6);
  c.rect(2, 1, 7, 3, P.wood[2]); c.hline(2, 1, 7, P.wood[4]); c.hline(2, 3, 7, P.wood[1]);
  finish(c, 1, 1);
});
function bed(c, R, hospital) {
  c.bevel(1, 1, 22, 37, hospital ? P.metal[4] : P.wood[2], hospital ? P.metal[6] : P.wood[4], hospital ? P.metal[2] : P.wood[0]); // 床架
  c.bevel(2, 3, 20, 34, P.white[4], P.white[5], P.white[2]); // 床垫
  c.bevel(4, 4, 16, 6, P.white[5], "#ffffff", P.white[3]); // 枕头
  c.hline(5, 6, 14, P.white[3]);
  for (let y = 12; y < 37; y++) for (let x = 2; x < 22; x++) { // 被子
    let v = 3.4 - (x - 2) / 20 + (y === 12 ? 1.4 : y === 13 ? 0.6 : 0) + (((x + y) % 7 === 0) ? -0.5 : 0);
    if (x === 2) v += 1; if (x === 21 || y === 36) v -= 1.2;
    c.put(x, y, dpick(R, v, x, y, 0.4));
  }
  if (hospital) {
    for (const y of [16, 30]) c.hline(1, y, 22, P.metal[2]);
    c.vline(0, 12, 22, P.metal[5]); c.vline(23, 12, 22, P.metal[2]);
    c.bevel(10, 22, 4, 4, P.red[3], P.red[5], P.red[1]);
  }
  c.outline(); c.dropShadow(1, 1);
}
def("prop-bed", "床：木床架 + 白枕头 + 蓝色被子（褶皱）", (c) => bed(c, P.blue, false));
def("prop-hospital-bed", "病床：金属床架 + 两侧护栏 + 薄荷色被单 + 红十字", (c) => bed(c, P.teal, true));
def("prop-sofa", "沙发：靠背 + 两侧扶手 + 三个坐垫（亮顶暗缝）", (c) => {
  const R = P.purple;
  c.bevel(1, 1, 38, 13, R[2], R[4], R[0]);
  c.rect(1, 1, 38, 4, R[2]); c.hline(1, 1, 38, R[4]); c.hline(1, 4, 38, R[1]);
  c.bevel(1, 4, 4, 10, R[3], R[4], R[1]); c.bevel(35, 4, 4, 10, R[3], R[4], R[1]);
  for (let i = 0; i < 3; i++) c.bevel(5 + i * 10, 5, 10, 8, R[3], R[5], R[1]);
  finish(c, 1, 1);
});
def("prop-plant", "盆栽：陶盆 + 叶团（俯视略带斜角）", (c, rnd) => {
  c.disc(5.5, 11, 4, (x, y, nx, ny) => ramp(P.orange, 3 - (nx + ny) * 1.2));
  c.disc(5.5, 10.5, 2.8, P.dirt[1]);
  const sub = new Canvas(12, 16);
  canopy(sub, rnd, 5.5, 6, 4.5, 4, P.leaf);
  c.blit(sub, 0, 0);
  c.outline(); c.dropShadow(1, 1);
});
def("prop-rug", "地毯：边框 + 流苏 + 中央菱形图案（编织抖动）", (c) => {
  for (let y = 2; y < 30; y++) for (let x = 3; x < 45; x++) {
    const bx = Math.min(x - 3, 44 - x), by = Math.min(y - 2, 29 - y), b = Math.min(bx, by);
    const d = Math.abs(x - 23.5) / 18 + Math.abs(y - 15.5) / 11;
    let v = 2.6, R = P.red;
    if (b <= 1) { R = P.yellow; v = b === 0 ? 2.2 : 3.4; }
    else if (b === 3) { R = P.navy; v = 2.6; }
    else if (d < 0.32) { R = P.yellow; v = 3.2; }
    else if (Math.abs(d - 0.62) < 0.08) { R = P.navy; v = 3.0; }
    v += ((x + y) & 1 ? 0.25 : -0.25) - (x - 3 + y - 2) / 80;
    c.put(x, y, dpick(R, v, x, y, 0.4));
  }
  for (let y = 3; y < 29; y += 2) { c.put(2, y, P.sand[4]); c.put(45, y, P.sand[2]); }
  c.outline();
});
def("prop-desk", "办公桌：木台面 + 显示器 + 键盘 + 文件", (c) => {
  woodTop(c, 1, 1, 30, 13, P.brown);
  c.bevel(11, 2, 11, 4, P.black[3], P.black[5], P.black[1]); c.rect(12, 3, 9, 2, "#4a8ac8"); c.hline(12, 3, 9, "#86c0ec");
  c.bevel(11, 8, 10, 3, P.white[3], P.white[5], P.white[1]);
  for (let x = 12; x < 20; x += 2) c.put(x, 9, P.white[2]);
  c.bevel(3, 4, 6, 7, P.white[5], "#ffffff", P.white[3]); c.hline(4, 6, 4, P.white[2]); c.hline(4, 8, 3, P.white[2]);
  c.disc(25.5, 8.5, 1.6, P.red[3]);
  finish(c, 1, 1);
});
def("prop-cooler", "冷柜：白色箱体 + 玻璃门（饮料可见）+ 把手", (c) => {
  c.bevel(1, 1, 14, 14, P.white[4], P.white[5], P.white[2]);
  c.rect(3, 3, 10, 9, P.glass[2]);
  for (let x = 4; x < 12; x += 2) for (let y = 4; y < 11; y += 3) { const R = shelfItems[(x + y) % 8]; c.put(x, y, R[4]); c.put(x, y + 1, R[2]); }
  c.line(3, 11, 9, 3, withA(P.glass[6], 140));
  c.hline(3, 13, 10, P.metal[4]);
  finish(c, 1, 1);
});

// 旧名兼容物件
def("prop-health", "医疗包：白盒 + 红十字 + 斜面明暗", (c) => {
  c.bevel(1, 2, 14, 12, P.white[4], P.white[5], P.white[2]);
  c.rect(6, 4, 4, 8, P.red[3]); c.rect(4, 6, 8, 4, P.red[3]);
  c.hline(6, 4, 4, P.red[5]); c.hline(4, 6, 2, P.red[5]); c.vline(9, 10, 2, P.red[1]); c.hline(10, 9, 2, P.red[1]);
  c.hline(6, 1, 4, P.metal[3]);
  finish(c, 1, 1);
});
def("prop-ammo", "弹药箱：军绿铁盒 + 黄色标识 + 搭扣", (c) => {
  c.bevel(1, 2, 14, 12, P.green[2], P.green[4], P.green[0]);
  c.hline(1, 6, 14, P.green[1]);
  c.rect(4, 8, 8, 3, P.yellow[3]); c.hline(4, 8, 8, P.yellow[5]);
  c.rect(7, 4, 2, 3, P.metal[4]);
  finish(c, 1, 1);
});
def("prop-sculpture", "雕塑：圆形石基座 + 抽象人形雕像（大理石）+ 投影", (c) => {
  c.disc(15.5, 15.5, 13.5, (x, y, nx, ny) => dpick(P.concrete, 3 - (nx + ny) * 1.2, x, y));
  c.ring(15.5, 15.5, 10, 11, (x, y) => (x + y < 31 ? P.concrete[1] : P.concrete[5]));
  c.disc(15.5, 15.5, 10, (x, y, nx, ny) => dpick(P.concrete, 2.4 - (nx + ny) * 0.8, x, y));
  c.ellipse(15.5, 17.5, 4.5, 6, sphere(P.marble, 3.2, 2));
  c.disc(15.5, 9.5, 3, sphere(P.marble, 3.6, 2));
  c.ellipse(10.5, 16, 2, 4, sphere(P.marble, 3, 2)); c.ellipse(20.5, 14, 2, 4, sphere(P.marble, 3, 2));
  c.outline(); c.dropShadow(2, 2);
});
def("prop-trafficlight", "交通灯（俯视）：黑色灯箱 + 红/黄/绿三灯（灯罩高光）", (c) => {
  c.bevel(2, 1, 8, 14, P.black[3], P.black[5], P.black[1]);
  const lamps = [[4, P.red], [8, P.yellow], [12, P.green]];
  for (const [y, R] of lamps) { c.disc(6, y, 1.9, R[3]); c.put(5, y - 1, R[5]); c.put(6, y, R[4]); c.hline(4, y + 1, 4, R[1]); }
  c.outline();
});
def("prop-door", "门垫/门槛：棕色刷毛门垫 + 金属门槛条", (c) => {
  c.rect(0, 0, 32, 2, P.metal[4]); c.hline(0, 0, 32, P.metal[6]); c.hline(0, 1, 32, P.metal[2]);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 30; x++) {
    let v = 2.8 + ((x + y) & 1 ? 0.4 : -0.4);
    if (y === 2) v += 0.8; if (y === 7 || x === 29) v -= 1.2;
    c.put(x, y, dpick(P.brown, v, x, y, 0.3));
  }
  for (let x = 6; x < 26; x += 2) c.put(x, 4, P.brown[5]);
  // 门垫铺满门洞宽度（被拉伸到 doorW×wallT*2），无透明边距 → 手工画门垫左右与下沿深色描边
  c.vline(1, 2, 6, OUT); c.vline(30, 2, 6, OUT); c.hline(1, 7, 30, OUT);
});

// ---------------------------------------------------------------- (d) 角色图集 64×96：4 列 × 4 行，cell 16×24，帧 = dir*4 + step
// dir 0 下(S) 1 左(W) 2 右(E) 3 上(N)；step 0 站 1 迈步A 2 站 3 迈步B。
// 先画「材质图」（每像素一个部位编号），再在屏幕空间统一着色：右/下外沿与同组部件交界压暗、上方部件投影压暗、
// 左/上外沿提亮 → 光源恒在左上（右向帧由左向几何镜像，但明暗不镜像）。最后 1px 深色外描边 + 脚下半透明投影。
const A_ = { HAIR: 1, SKIN: 2, EYE: 3, TOP: 4, SLEEVE: 5, INNER: 6, PL: 7, PR: 8, SL: 9, SR: 10, HAND: 11, BAG: 12, STRAP: 13,
  BADGE: 14, BRIM: 15, SKIRT: 16, LEGL: 17, LEGR: 18, BELT: 19, CAP: 20, SLEEVE2: 21, HAND2: 22 };
const A_GROUP = { 1: "hair", 2: "skin", 4: "top", 5: "top", 6: "inner", 7: "pants", 8: "pants", 9: "shoe", 10: "shoe", 11: "skin", 12: "bag",
  13: "strap", 16: "skirt", 17: "skin", 18: "skin", 20: "cap", 21: "top", 22: "skin" };
const A_CAST = new Set([A_.HAIR, A_.CAP, A_.BRIM, A_.TOP, A_.SLEEVE, A_.SKIRT]); // 会在下方部件上投影
const A_FAR = new Set([A_.SLEEVE2, A_.HAND2]); // 远侧手臂：恒用暗档
const A_FLAT = { [A_.EYE]: "#1a1216", [A_.BADGE]: "#f2d24a", [A_.BRIM]: "#0c0d10", [A_.BELT]: "#1a1c20" };
function actorRamp(L, m) {
  switch (A_GROUP[m]) {
    case "hair": return L.hair;
    case "skin": return L.skin;
    case "top": return L.top;
    case "inner": return L.inner || L.top;
    case "pants": return L.pants;
    case "shoe": return L.shoes;
    case "bag": return L.bag;
    case "strap": return [L.bag[0], L.bag[0], L.bag[1]];
    case "skirt": return L.skirt || L.top;
    case "cap": return L.cap;
  }
  return ["#ff00ff", "#ff00ff", "#ff00ff"];
}
function actorMap(L, dir, step) {
  const M = new Uint8Array(16 * 24), mir = dir === 2;
  const m = (x, y, v) => { if (mir) x = 15 - x; if (x >= 0 && x < 16 && y >= 0 && y < 24) M[y * 16 + x] = v; };
  const r = (x, y, w, h, v) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) m(x + i, y + j, v); };
  const sw = step === 1 ? 1 : step === 3 ? -1 : 0;
  const { HAIR: H, SKIN: S, TOP: T, SLEEVE: SV, INNER: IN, PL, PR, SL, SR, HAND: HD, BAG: BG, STRAP: ST } = A_;
  const sleeveOrHand = (y) => (L.shortSleeve && y >= 11 ? HD : SV);

  if (dir === 0 || dir === 3) {
    const back = dir === 3;
    const legL = sw === 0 ? 0 : sw === 1 ? 1 : -1, legR = -legL; // +1 迈向镜头（更长）
    const armL = -legL, armR = -legR; // 手臂与同侧腿反向摆
    // 腿 / 裙
    if (L.dress) {
      r(5, 15, 6, 1, A_.SKIRT); r(4, 16, 8, 3, A_.SKIRT);
      for (const [x, d, LG, SH] of [[5, legL, A_.LEGL, SL], [9, legR, A_.LEGR, SR]]) {
        if (d >= 0) r(x, 19, 2, 1 + d, LG);
        r(x, 20 + d, 2, 2, SH);
      }
    } else {
      for (const [x, d, PP, SH] of [[5, legL, PL, SL], [8, legR, PR, SR]]) { r(x, 15, 3, 5 + d, PP); r(x, 20 + d, 3, 2, SH); }
    }
    // 躯干
    r(5, 9, 6, 6, T);
    if (!back) {
      if (L.jacket) { m(7, 9, S); m(8, 9, S); r(7, 10, 2, 4, IN); }
      else if (L.police) { m(7, 9, IN); m(8, 9, IN); m(9, 10, A_.BADGE); }
      else { m(7, 9, S); m(8, 9, S); }
      if (L.backpack) { r(5, 9, 1, 4, ST); r(10, 9, 1, 4, ST); }
    } else if (L.backpack) { r(5, 9, 6, 6, BG); r(6, 12, 4, 2, ST); }
    if (L.police) { r(5, 14, 6, 1, A_.BELT); if (!back) m(7, 14, A_.BADGE); }
    // 双臂
    for (const [x, a] of [[3, armL], [11, armR]]) {
      for (let y = 9; y <= 13 + a; y++) r(x, y, 2, 1, sleeveOrHand(y));
      r(x, 14 + a, 2, 1, HD);
    }
    // 购物袋（拎在角色左手：正面在画面右侧，背面在画面左侧）
    if (L.shopping) {
      const [bx, a] = back ? [2, armL] : [11, armR], hy = 14 + a;
      r(bx, hy + 1, 3, 4, BG); m(bx + 1, hy + 1, ST); m(bx + 1, hy + 3, ST);
    }
    // 头
    if (!back) {
      r(5, 5, 6, 3, S); r(6, 8, 4, 1, S);
      if (L.hairStyle === "buzz") { r(5, 1, 6, 1, H); r(4, 2, 8, 2, H); r(5, 4, 6, 1, S); m(4, 4, H); m(11, 4, H); m(4, 6, S); m(11, 6, S); }
      else if (L.hairStyle === "cap") {
        r(5, 1, 6, 1, A_.CAP); r(4, 2, 8, 2, A_.CAP); m(7, 2, A_.BADGE); m(8, 2, A_.BADGE); r(4, 4, 8, 1, A_.BRIM);
        m(4, 5, H); m(11, 5, H);
      } else {
        r(5, 1, 6, 1, H); r(4, 2, 8, 3, H);
        if (L.hairStyle === "long") { r(4, 5, 1, 6, H); r(11, 5, 1, 6, H); m(5, 5, H); m(6, 5, H); m(9, 5, H); m(10, 5, H); }
        else if (L.hairStyle === "bob") { r(4, 5, 1, 4, H); r(11, 5, 1, 4, H); r(5, 5, 6, 1, H); m(8, 5, S); }
        else { m(4, 5, H); m(11, 5, H); m(4, 6, H); m(11, 6, H); m(5, 5, H); m(6, 5, H); m(10, 5, H); }
      }
      m(6, 6, A_.EYE); m(9, 6, A_.EYE);
    } else {
      if (L.hairStyle === "cap") { r(5, 1, 6, 1, A_.CAP); r(4, 2, 8, 3, A_.CAP); r(4, 5, 8, 3, H); r(5, 8, 6, 1, H); }
      else {
        r(5, 1, 6, 1, H); r(4, 2, 8, 6, H);
        if (L.hairStyle === "buzz") r(6, 8, 4, 1, S); else r(5, 8, 6, 1, H);
        if (L.hairStyle === "long") { r(4, 8, 8, 3, H); r(5, 11, 6, 1, H); }
        if (L.hairStyle === "bob") r(4, 8, 8, 1, H);
        if (L.hairStyle === "ponytail") { r(7, 9, 2, 4, H); m(7, 8, ST); m(8, 8, ST); }
      }
    }
    return M;
  }

  // 侧面（几何按朝左画，dir 2 镜像）
  const bagBehind = L.shopping && mir; // 朝右时左手在远侧 → 袋子在身后
  const hand = sw === 0 ? 7 : sw === 1 ? 5 : 9; // 近侧手 x
  const drawBag = () => { r(hand - 1, 15, 4, 4, BG); m(hand, 15, ST); m(hand + 1, 15, ST); m(hand, 17, ST); };
  if (bagBehind) drawBag();
  if (sw === 1) { r(11, 11, 1, 2, A_.SLEEVE2); r(11, 13, 2, 1, A_.HAND2); }
  if (sw === -1) { r(4, 11, 1, 2, A_.SLEEVE2); r(3, 13, 2, 1, A_.HAND2); }
  // 腿 / 裙（远侧腿先画）
  if (L.dress) {
    r(5, 15, 6, 1, A_.SKIRT); r(4, 16, 8, 3, A_.SKIRT);
    if (sw === 0) { r(8, 19, 2, 1, A_.LEGR); r(8, 20, 2, 2, SR); r(6, 19, 2, 1, A_.LEGL); r(4, 20, 4, 2, SL); }
    if (sw === 1) { r(10, 19, 2, 1, A_.LEGR); r(10, 20, 3, 1, SR); r(4, 19, 2, 1, A_.LEGL); r(2, 20, 4, 2, SL); }
    if (sw === -1) { r(5, 19, 2, 1, A_.LEGR); r(3, 20, 4, 2, SR); r(9, 19, 2, 1, A_.LEGL); r(9, 20, 3, 1, SL); }
  } else if (sw === 0) {
    r(9, 15, 2, 1, PR); r(8, 16, 2, 4, PR); r(8, 20, 2, 2, SR);
    r(5, 15, 4, 1, PL); r(6, 16, 2, 4, PL); r(4, 20, 4, 2, SL);
  } else if (sw === 1) {
    r(8, 15, 3, 1, PR); r(9, 16, 2, 2, PR); r(10, 18, 2, 2, PR); r(10, 20, 3, 1, SR);
    r(5, 15, 4, 1, PL); r(5, 16, 2, 2, PL); r(4, 18, 2, 2, PL); r(2, 20, 4, 2, SL);
  } else {
    r(7, 15, 3, 1, PR); r(6, 16, 2, 2, PR); r(5, 18, 2, 2, PR); r(3, 20, 4, 2, SR);
    r(5, 15, 4, 1, PL); r(8, 16, 2, 2, PL); r(9, 18, 2, 2, PL); r(9, 20, 3, 1, SL);
  }
  // 躯干 + 细节
  r(5, 9, 6, 6, T);
  if (L.jacket) r(5, 9, 1, 5, IN);
  if (L.police) { m(5, 9, IN); m(6, 9, IN); m(6, 11, A_.BADGE); r(5, 14, 6, 1, A_.BELT); }
  if (L.backpack) { r(10, 9, 3, 6, BG); r(11, 11, 2, 2, ST); m(6, 9, ST); }
  // 近侧手臂
  r(7, 9, 2, 3, SV);
  if (L.shortSleeve) r(7, 11, 2, 1, HD);
  if (sw === 0) { r(7, 12, 2, 2, sleeveOrHand(12)); r(7, 14, 2, 1, HD); }
  if (sw === 1) { r(6, 12, 2, 2, sleeveOrHand(12)); r(5, 14, 2, 1, HD); }
  if (sw === -1) { r(8, 12, 2, 2, sleeveOrHand(12)); r(9, 14, 2, 1, HD); }
  if (L.shopping && !bagBehind) drawBag();
  // 头（侧脸：鼻尖凸出 1px，单眼，后脑头发）
  if (L.hairStyle === "buzz") {
    r(5, 1, 6, 1, H); r(4, 2, 8, 2, H); r(4, 4, 6, 4, S); r(10, 4, 2, 3, H); m(10, 7, H); r(5, 8, 5, 1, S);
  } else if (L.hairStyle === "cap") {
    r(4, 5, 5, 3, S); r(5, 8, 4, 1, S);
    r(5, 1, 6, 1, A_.CAP); r(4, 2, 8, 2, A_.CAP); m(5, 2, A_.BADGE); r(2, 4, 7, 1, A_.BRIM); r(9, 4, 3, 4, H); r(9, 8, 2, 1, H);
  } else {
    r(5, 1, 6, 1, H); r(4, 2, 8, 3, H); r(4, 5, 5, 3, S); r(5, 8, 4, 1, S);
    m(4, 5, H); m(5, 5, H);
    if (L.hairStyle === "long") { r(9, 5, 3, 6, H); r(10, 11, 2, 1, H); }
    else if (L.hairStyle === "bob") { r(9, 5, 3, 4, H); m(6, 5, H); }
    else { r(9, 5, 3, 3, H); r(9, 8, 2, 1, H); }
    if (L.hairStyle === "ponytail") { m(12, 4, H); r(12, 5, 2, 3, H); m(12, 8, H); m(11, 4, ST); }
  }
  m(3, 6, S); m(5, 6, A_.EYE);
  return M;
}
function renderActor(L, M) {
  const c = new Canvas(16, 24);
  c.ellipse(8.5, 22, 5, 1.6, SHADOW);
  const g = (x, y) => (x < 0 || y < 0 || x >= 16 || y >= 24 ? 0 : M[y * 16 + x]);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 16; x++) {
    const m = M[y * 16 + x];
    if (!m) continue;
    if (A_FLAT[m]) { c.put(x, y, A_FLAT[m]); continue; }
    const R = actorRamp(L, m), grp = A_GROUP[m];
    const Lm = g(x - 1, y), Rm = g(x + 1, y), Tm = g(x, y - 1), Bm = g(x, y + 1);
    let sh = 1;
    if (A_FAR.has(m)) sh = 0;
    else if (Rm === 0 || Bm === 0 || (Rm !== m && A_GROUP[Rm] === grp) || (Tm !== 0 && Tm !== m && A_CAST.has(Tm) && A_GROUP[Tm] !== grp)) sh = 0;
    else if (Lm === 0 || Tm === 0) sh = 2;
    c.put(x, y, R[sh]);
  }
  c.outline();
  return c;
}
const SK = { light: ["#c8906a", "#ebb990", "#f8d4b2"], mid: ["#a87250", "#d09a70", "#eab88e"], tan: ["#8e5e3a", "#b88052", "#d6a070"], dark: ["#4e2e1e", "#704430", "#925c40"] };
const HR = { black: ["#121014", "#2a2630", "#46404c"], brown: ["#3a2214", "#5e3a22", "#84583a"], blond: ["#8e6a26", "#c49e40", "#e6c86a"],
  red: ["#6a2412", "#a03c1c", "#cc6030"], gray: ["#6a6a72", "#9c9ca4", "#cacace"] };
const tri = (r, a, b, c) => [r[a], r[b], r[c]];
const LOOKS = {
  "actor-player": { note: "玩家：红夹克敞怀露白 T、深蓝牛仔裤、白球鞋、黑短发", skin: SK.mid, hair: HR.black, hairStyle: "short",
    top: tri(P.red, 1, 3, 5), inner: tri(P.white, 2, 4, 5), jacket: true, pants: tri(P.blue, 1, 2, 3), shoes: tri(P.white, 1, 3, 5) },
  "actor-npc": { note: "路人 A：米色毛衣、棕裤、棕短发、浅肤色", skin: SK.light, hair: HR.brown, hairStyle: "short",
    top: tri(P.sand, 1, 3, 5), pants: tri(P.brown, 1, 3, 4), shoes: tri(P.brown, 0, 1, 2) },
  "actor-npc-b": { note: "路人 B：绿卫衣、灰裤、金色寸头、小麦肤色", skin: SK.tan, hair: HR.blond, hairStyle: "buzz",
    top: tri(P.green, 1, 3, 4), pants: tri(P.concrete, 0, 1, 2), shoes: tri(P.black, 1, 3, 4) },
  "actor-npc-c": { note: "路人 C：紫色连衣裙、红色长发、浅肤色、酒红鞋", skin: SK.light, hair: HR.red, hairStyle: "long",
    top: tri(P.purple, 2, 4, 5), dress: true, pants: tri(P.purple, 1, 2, 3), shoes: tri(P.maroon, 0, 2, 4) },
  "actor-npc-d": { note: "路人 D：橙色短袖 T、卡其裤、青色双肩包、黑短发、深肤色", skin: SK.dark, hair: HR.black, hairStyle: "short",
    top: tri(P.orange, 2, 4, 5), shortSleeve: true, pants: tri(P.sand, 0, 1, 2), shoes: tri(P.white, 1, 3, 4), backpack: true, bag: tri(P.teal, 1, 3, 4) },
  "actor-npc-e": { note: "路人 E：青蓝衬衫、石板灰裤、灰色波波头、拎粉色购物袋", skin: SK.tan, hair: HR.gray, hairStyle: "bob",
    top: tri(P.teal, 2, 3, 5), pants: tri(P.slate, 1, 2, 3), shoes: tri(P.brown, 0, 2, 3), shopping: true, bag: tri(P.pink, 2, 4, 5) },
  "actor-npc-f": { note: "路人 F：粉色短袖上衣、浅蓝牛仔裤、棕色马尾、白鞋", skin: SK.mid, hair: HR.brown, hairStyle: "ponytail",
    top: tri(P.pink, 2, 3, 5), shortSleeve: true, pants: tri(P.blue, 2, 3, 4), shoes: tri(P.white, 2, 4, 5), bag: tri(P.pink, 1, 2, 3) },
  "actor-police": { note: "警察：深蓝制服 + 警帽（黑帽檐、金徽）、浅蓝衬衫领、黑腰带金扣、黑皮鞋", skin: SK.mid, hair: HR.black, hairStyle: "cap", police: true,
    top: tri(P.navy, 1, 3, 4), inner: ["#6a8ab0", "#9ab8d8", "#c8dcf0"], cap: tri(P.navy, 1, 3, 4), pants: tri(P.navy, 0, 1, 2), shoes: tri(P.black, 0, 2, 4) },
};
for (const [name, L] of Object.entries(LOOKS)) {
  def(name, L.note, (c) => {
    for (let f = 0; f < 16; f++) c.blit(renderActor(L, actorMap(L, f >> 2, f & 3)), (f & 3) * 16, (f >> 2) * 24);
  });
}

// ---------------------------------------------------------------- (e) 车辆：朝东（车头在 +x），俯视
// 车身圆角矩形；沿 x 分区：后保险杠/尾灯 → 后备箱 → 后窗 → 车顶 → 前挡风 → 引擎盖 → 前保险杠/大灯。
// 车顶两侧为侧窗（B 柱断开）。明暗：北侧（上）受光、南侧（下）背光，上沿亮线、下沿暗线；
// 轮胎在车身上下各露出 1px 胎面；后视镜外凸；描边后右下投影。
function vehicle(c, o) {
  const { x0, x1, y0, y1, ri } = o, cy = (y0 + y1) / 2, half = (y1 - y0) / 2;
  const inBody = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const r = x > (x0 + x1) / 2 ? o.rf : o.rr;
    const ex = Math.max(0, x0 + r - (x + 0.5), x + 0.5 - (x1 + 1 - r)), ey = Math.max(0, y0 + r - (y + 0.5), y + 0.5 - (y1 + 1 - r));
    return ex * ex + ey * ey <= r * r;
  };
  const inR = (x, r) => r && x >= r[0] && x <= r[1];
  const ry0 = y0 + ri, ry1 = y1 - ri, lampTop = (y) => y >= y0 + 2 && y <= y0 + 4, lampBot = (y) => y >= y1 - 4 && y <= y1 - 2;
  for (const wx of o.wheels) for (let i = 0; i < 8; i++) for (const y of [y0 - 1, y1 + 1])
    c.put(wx + i, y, i === 0 || i === 7 ? P.rubber[0] : (wx + i) & 1 ? P.rubber[1] : P.rubber[2]);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!inBody(x, y)) continue;
    const t = (y - cy) / half, R = o.bodyAt ? o.bodyAt(x, y) : o.body;
    let v = 3.0 - t * 0.9, glass = null;
    if (inR(x, o.roof) && y >= ry0 && y <= ry1) {
      v = 3.7 - t * 0.5 + (y === ry0 ? 1.0 : y === ry1 ? -1.1 : 0) + (x === o.roof[0] ? 0.5 : x === o.roof[1] ? -0.5 : 0);
      if (o.ribs) { const k = (x - o.roof[0]) % 6; if (k === 3) v += 0.8; else if (k === 4) v -= 0.8; }
    } else if (inR(x, o.wind)) {
      const k = Math.round(((x - o.wind[0]) / (o.wind[1] - o.wind[0])) * o.windTaper);
      if (y >= ry0 + k && y <= ry1 - k) glass = "front"; else v -= 0.3;
    } else if (inR(x, o.rear)) {
      const k = Math.round((o.rear[1] - x) / (o.rear[1] - o.rear[0]));
      if (y >= ry0 + k && y <= ry1 - k) glass = "rear";
    }
    if (!glass && inR(x, o.side) && !o.pillars.includes(x) && ((y >= y0 + 2 && y < ry0) || (y <= y1 - 2 && y > ry1))) glass = "side";
    let col;
    if (glass === "front" || glass === "rear") {
      const refl = (x * 2 + y) % 11 < 2;
      col = refl ? P.glass[glass === "front" ? 5 : 4] : dpick(P.glass, (glass === "front" ? 2.7 : 2.1) - t * 0.8 + (y === ry0 ? 0.8 : 0), x, y, 0.4);
    } else if (glass === "side") col = (x + (t < 0 ? 0 : 3)) % 9 === 0 ? P.glass[5] : t < 0 ? P.glass[3] : P.glass[1];
    else if (x >= x1 - 1 && (lampTop(y) || lampBot(y))) col = x === x1 ? (t < 0 ? "#fffbe6" : "#e8e2c0") : t < 0 ? "#f2eccc" : "#cfc8a4";
    else if (x <= x0 + 1 && (lampTop(y) || lampBot(y))) col = x === x0 ? (t < 0 ? "#ff5a46" : "#d42a24") : t < 0 ? "#c42420" : "#901818";
    else if (x === x1 && y > y0 + 4 && y < y1 - 4) col = (y & 1) ? P.metal[1] : P.metal[2];
    else {
      if (x > (o.wind ? o.wind[1] : x1) || x < (o.rear ? o.rear[0] : o.roof[0])) { if (y === ry0 - 1) v += 0.5; else if (y === ry1 + 1) v -= 0.5; }
      if (x <= x0 + 1 || x >= x1 - 1) v -= 0.6;
      if (!inBody(x, y - 1)) v += 1.2;
      if (!inBody(x, y + 1)) v -= 1.3;
      if (!inBody(x - 1, y)) v += 0.4;
      if (!inBody(x + 1, y)) v -= 0.5;
      col = dpick(R, v, x, y, 0.4);
    }
    c.put(x, y, col);
  }
  for (const [y, k] of [[y0 - 1, 4], [y1 + 1, 1]]) { const R = o.bodyAt ? o.bodyAt(o.mirror, y0) : o.body; c.put(o.mirror, y, R[k]); c.put(o.mirror + 1, y, R[k - 1]); }
  if (o.extra) o.extra(c, cy);
  c.outline(); c.dropShadow(2, 2);
}
const CAR = { x0: 2, x1: 60, y0: 4, y1: 27, ri: 4, rr: 3, rf: 5, wheels: [10, 46], mirror: 40, rear: [14, 18], roof: [19, 36], wind: [37, 43], windTaper: 1, side: [17, 38], pillars: [27, 28] };
const VEH = {
  "vehicle-car": { note: "轿车（蓝）", body: P.blue },
  "vehicle-car-red": { note: "轿车（红）", body: P.red },
  "vehicle-car-white": { note: "轿车（白）", body: P.white },
  "vehicle-car-green": { note: "轿车（绿）", body: P.green },
  "vehicle-taxi": { note: "出租车：黄色车身 + 车顶灯牌 + 两侧黑白格带", body: P.yellow, extra: (c) => {
    for (const y of [CAR.y0 + 1, CAR.y1 - 1]) for (let x = 17; x <= 38; x++) c.put(x, y, ((x >> 1) + (y >> 1)) & 1 ? P.black[1] : P.white[4]);
    c.rect(25, 11, 6, 10, OUT); c.bevel(26, 12, 4, 8, "#f6e8a8", "#fffbe8", P.yellow[2]); c.put(27, 13, P.orange[4]);
  } },
  "vehicle-police": { note: "警车：黑色车头车尾 + 白色车门与车顶 + 红蓝警灯排", bodyAt: (x) => (x >= 15 && x <= 43 ? P.white : P.black), extra: (c) => {
    c.rect(26, 8, 5, 16, OUT);
    c.bevel(27, 9, 3, 6, P.red[4], P.red[5], P.red[2]); c.bevel(27, 17, 3, 6, P.blue[4], P.blue[6], P.blue[2]);
    c.rect(27, 15, 3, 2, P.metal[2]);
    for (const y of [CAR.y0 + 1, CAR.y1 - 1]) c.hline(30, y, 6, P.blue[3]);
  } },
};
for (const [name, v] of Object.entries(VEH)) def(name, v.note + "：车身渐变、前挡/后窗/侧窗反光、白色大灯、红色尾灯、胎面、后视镜、投影；朝东", (c) => vehicle(c, { ...CAR, ...v }));
def("vehicle-van", "厢式货车：白色长车厢（顶部加强筋）+ 橙色腰线 + 驾驶室侧窗 + 前挡、灯、胎面、投影；朝东", (c) =>
  vehicle(c, { x0: 2, x1: 68, y0: 4, y1: 29, ri: 3, rr: 2, rf: 5, wheels: [10, 55], mirror: 51, rear: null, roof: [3, 50], ribs: true, wind: [51, 57], windTaper: 1,
    side: [46, 50], pillars: [], body: P.white, bodyAt: (x, y) => ((y === 5 || y === 28) && x >= 4 && x <= 45 ? P.orange : P.white),
    extra: (c) => { for (const x of [2, 3]) c.put(x, 16, OUT), c.put(x, 17, OUT); } }));

// ---------------------------------------------------------------- 输出
function placeholder(c) {
  if (c.wrap) { c.fill("#808080"); return; }
  c.rect(1, 1, c.w - 2, c.h - 2, "#9a9a9a"); c.outline();
}
function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = [];
  let bytes = 0, todo = 0;
  for (const [name, w, h, kind] of SPEC) {
    const d = DRAW.get(name);
    const c = new Canvas(w, h, kind === "tile");
    if (d) d.draw(c, mulberry32(seedOf(d.seed || name)));
    else { placeholder(c); todo++; }
    if (c.w !== w || c.h !== h) throw new Error(`${name}: 尺寸被改动 ${c.w}x${c.h}`);
    const png = encodePng(w, h, c.buf);
    bytes += png.length;
    writeFileSync(join(OUT_DIR, name + ".png"), png);
    const e = { id: "pixel-" + name, name, kind: kind === "atlas" ? "ATLAS" : "IMAGE", src: "url",
      url: "data:image/png;base64," + png.toString("base64"), path: "pixel/" + name + ".png", width: w, height: h };
    if (kind === "atlas") Object.assign(e, { cols: 4, rows: 4, cellW: 16, cellH: 24, frameCount: 16 });
    e.group = "pixel";
    e.note = (d ? d.note : "占位") + ` ${w}x${h}` + (kind === "atlas" ? "，帧=dir*4+step（dir 0下 1左 2右 3上；step 0站 1迈A 2站 3迈B）" : "");
    manifest.push(e);
  }
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const total = manifest.reduce((a, m) => a + m.url.length, 0);
  console.log(`产出 ${manifest.length} 张 → ${OUT_DIR}；PNG ${bytes} B；base64 总量 ${(total / 1024).toFixed(1)} KB；占位剩余 ${todo}`);
}
main();
