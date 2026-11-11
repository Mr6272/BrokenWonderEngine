/**
 * 孤胆枪手示例 · 像素画核心（零依赖）。
 *
 * 提供：
 *   - Canvas：RGBA 位图 + 硬像素绘制原语（不做抗锯齿，像素画要的就是"硬"）；
 *   - outline：1px 描边（只描透明像素里贴着不透明像素的那一圈）；
 *   - renderDir：**按方向逐帧光栅化**的俯视角色渲染器 —— 角色在局部坐标里用几何形状描述，
 *     每个方向把输出像素反旋转回局部坐标再判定，所以 16 个方向都是"原生画出来的"，
 *     而不是把一张图转 22.5° 再采样（那样边缘全是锯齿和缺口）；
 *   - encodePng / pngDataUrl：带逐行自适应滤波的 PNG 编码（大地面图能小一半以上）；
 *   - rng：确定性 PRNG（mulberry32），生成结果每次逐字节一致。
 *
 * 坐标约定（与 BWE 引擎一致）：屏幕 y 向下；方向 i 的角度 = i * (360/dirs) 度，
 * 0 = 朝屏幕右（+x），角度增大 = 屏幕上**顺时针**（i=4 朝下，i=8 朝左，i=12 朝上）。
 * 局部坐标：+x = 角色正前方，+y = 角色右手边。
 */
import zlib from "node:zlib";

// ---------------------------------------------------------------- 随机数

/** mulberry32：返回 () => [0,1) 的确定性随机函数。 */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 4x4 Bayer 有序抖动阈值（0..1），做"有结构的噪点"，比纯随机噪点更像像素画、PNG 也压得更小。 */
export const BAYER4 = [
  [0 / 16, 8 / 16, 2 / 16, 10 / 16],
  [12 / 16, 4 / 16, 14 / 16, 6 / 16],
  [3 / 16, 11 / 16, 1 / 16, 9 / 16],
  [15 / 16, 7 / 16, 13 / 16, 5 / 16]
];

/** 整数格点上的平滑值噪声（可平铺：period 为周期，单位=格点）。返回 0..1。 */
export function valueNoise(seed, period) {
  const r = rng(seed);
  const n = period * period;
  const grid = new Float32Array(n);
  for (let i = 0; i < n; i++) grid[i] = r();
  const at = (ix, iy) => grid[(((iy % period) + period) % period) * period + (((ix % period) + period) % period)];
  return function sample(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return a + (b - a) * sy;
  };
}

// ---------------------------------------------------------------- 颜色

/** "#rgb" / "#rrggbb" / "#rrggbbaa" / [r,g,b,a?] → [r,g,b,a]（0..255）。 */
export function col(c) {
  if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0, c[3] === undefined ? 255 : c[3] | 0];
  let s = String(c).replace("#", "");
  if (s.length === 3 || s.length === 4) s = s.split("").map((ch) => ch + ch).join("");
  const n = parseInt(s.slice(0, 6), 16);
  const a = s.length >= 8 ? parseInt(s.slice(6, 8), 16) : 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

/** 线性混合两种颜色（t=0 → a，t=1 → b）。 */
export function mix(a, b, t) {
  const A = col(a);
  const B = col(b);
  return [0, 1, 2, 3].map((i) => Math.round(A[i] + (B[i] - A[i]) * t));
}

/** 亮度缩放（k>1 提亮，k<1 压暗），alpha 不变。 */
export function shade(c, k) {
  const C = col(c);
  return [Math.min(255, Math.round(C[0] * k)), Math.min(255, Math.round(C[1] * k)), Math.min(255, Math.round(C[2] * k)), C[3]];
}

/** 改 alpha（0..255）。 */
export function alpha(c, a) {
  const C = col(c);
  return [C[0], C[1], C[2], Math.max(0, Math.min(255, Math.round(a)))];
}

// ---------------------------------------------------------------- 位图

export class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
  }

  clone() {
    const c = new Canvas(this.w, this.h);
    c.data.set(this.data);
    return c;
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  get(x, y) {
    if (!this.inside(x, y)) return [0, 0, 0, 0];
    const o = (y * this.w + x) * 4;
    const d = this.data;
    return [d[o], d[o + 1], d[o + 2], d[o + 3]];
  }

  alphaAt(x, y) {
    if (!this.inside(x, y)) return 0;
    return this.data[(y * this.w + x) * 4 + 3];
  }

  /** 覆盖写一个像素。 */
  set(x, y, c) {
    x |= 0;
    y |= 0;
    if (!this.inside(x, y)) return;
    const C = col(c);
    const o = (y * this.w + x) * 4;
    this.data[o] = C[0];
    this.data[o + 1] = C[1];
    this.data[o + 2] = C[2];
    this.data[o + 3] = C[3];
  }

  /** src-over 混合一个像素（半透明血迹/阴影/火焰用）。 */
  blend(x, y, c) {
    x |= 0;
    y |= 0;
    if (!this.inside(x, y)) return;
    const C = col(c);
    const sa = C[3] / 255;
    if (sa <= 0) return;
    const o = (y * this.w + x) * 4;
    const d = this.data;
    const da = d[o + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    for (let i = 0; i < 3; i++) {
      d[o + i] = Math.round((C[i] * sa + d[o + i] * da * (1 - sa)) / oa);
    }
    d[o + 3] = Math.round(oa * 255);
  }

  /** 只在目标透明处画（"画到底下"：阴影垫在角色下面）。 */
  under(x, y, c) {
    if (this.alphaAt(x | 0, y | 0) === 0) this.set(x, y, c);
  }

  plot(x, y, c, mode) {
    if (mode === "blend") this.blend(x, y, c);
    else if (mode === "under") this.under(x, y, c);
    else this.set(x, y, c);
  }

  rect(x, y, w, h, c, mode) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.plot(i, j, c, mode);
  }

  /** 实心圆（按像素中心判定，半径可为小数）。 */
  circle(cx, cy, r, c, mode) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.plot(x, y, c, mode);
      }
    }
  }

  ellipse(cx, cy, rx, ry, c, mode) {
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.plot(x, y, c, mode);
      }
    }
  }

  /** 1px Bresenham 直线（端点取整）。 */
  line(x0, y0, x1, y1, c, mode) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.plot(x0, y0, c, mode);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /** 实心多边形（像素中心 even-odd 判定）。pts = [[x,y], ...]。 */
  poly(pts, c, mode) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
        if (pointInPoly(x + 0.5, y + 0.5, pts)) this.plot(x, y, c, mode);
      }
    }
  }

  /** 把另一张位图 src-over 贴到 (dx,dy)。 */
  draw(src, dx, dy) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const o = (y * src.w + x) * 4;
        const a = src.data[o + 3];
        if (a === 0) continue;
        if (a === 255) this.set(dx + x, dy + y, [src.data[o], src.data[o + 1], src.data[o + 2], 255]);
        else this.blend(dx + x, dy + y, [src.data[o], src.data[o + 1], src.data[o + 2], a]);
      }
    }
  }

  /**
   * 1px 描边：透明像素（alpha < 40）只要上下左右有一个"实"像素（alpha >= 128）就涂成描边色。
   * diag=true 时连对角也算（更粗、更"卡通"）。
   */
  outline(c = "#0d0f0c", diag = false) {
    const src = this.clone();
    const C = col(c);
    const solid = (x, y) => src.alphaAt(x, y) >= 128;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (src.alphaAt(x, y) >= 40) continue;
        let hit = solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1);
        if (!hit && diag) hit = solid(x - 1, y - 1) || solid(x + 1, y - 1) || solid(x - 1, y + 1) || solid(x + 1, y + 1);
        if (hit) this.set(x, y, C);
      }
    }
    return this;
  }

  /** 逐像素改写：fn(x, y, [r,g,b,a]) → 新颜色或 null（不改）。 */
  map(fn) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const v = fn(x, y, this.get(x, y));
        if (v) this.set(x, y, v);
      }
    }
    return this;
  }
}

export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 点到线段距离。 */
export function segDist(px, py, x0, y0, x1, y1) {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - x0) * vx + (py - y0) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = x0 + vx * t - px;
  const qy = y0 + vy * t - py;
  return Math.sqrt(qx * qx + qy * qy);
}

/**
 * 把若干等大 cell 拼成图集（行优先：第 i 个 cell 在 col = i % cols、row = floor(i / cols)）。
 * 返回 { img, cols, rows, cellW, cellH }。
 */
export function atlasOf(cells, cols, cellW, cellH) {
  const rows = Math.ceil(cells.length / cols);
  const img = new Canvas(cols * cellW, rows * cellH);
  cells.forEach((c, i) => img.draw(c, (i % cols) * cellW, Math.floor(i / cols) * cellH));
  return { img, cols, rows, cellW, cellH };
}

// ---------------------------------------------------------------- 方向渲染器

/**
 * 形状（局部坐标，+x = 前方，+y = 右手边）：
 *   { t:"circle", x, y, r }
 *   { t:"ellipse", x, y, rx, ry }        // 轴对齐于局部坐标
 *   { t:"rect", x0, y0, x1, y1 }         // 局部坐标里的矩形
 *   { t:"poly", pts:[[x,y],...] }
 *   { t:"seg", x0, y0, x1, y1, w }       // 粗线段（腿、枪管）
 * 公共字段：c = 基色；hi / lo = 可选的受光 / 背光色。
 *
 * 光照在**屏幕空间**算（光从左上来）：先把形状中心旋转到屏幕，再看像素相对中心的偏移方向。
 * 这样角色转身时高光始终在左上，而不是跟着身体转 —— 俯视角像素画的标准做法。
 */
export function renderDir({ size, dirs = 16, frames = 1, shapes, outline = "#0d0f0c", shadow = null }) {
  const cells = [];
  const cx = size / 2;
  const cy = size / 2;
  for (let f = 0; f < frames; f++) {
    const list = shapes(f);
    for (let d = 0; d < dirs; d++) {
      const ang = (d * 2 * Math.PI) / dirs;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      const cell = new Canvas(size, size);
      // 预计算每个形状的屏幕中心与"半径"，给光照用
      const meta = list.map((s) => {
        let lx = 0;
        let ly = 0;
        let r = 1;
        if (s.t === "circle") {
          lx = s.x;
          ly = s.y;
          r = s.r;
        } else if (s.t === "ellipse") {
          lx = s.x;
          ly = s.y;
          r = Math.max(s.rx, s.ry);
        } else if (s.t === "rect") {
          lx = (s.x0 + s.x1) / 2;
          ly = (s.y0 + s.y1) / 2;
          r = Math.max(Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0)) / 2;
        } else if (s.t === "poly") {
          for (const p of s.pts) {
            lx += p[0];
            ly += p[1];
          }
          lx /= s.pts.length;
          ly /= s.pts.length;
          for (const p of s.pts) r = Math.max(r, Math.hypot(p[0] - lx, p[1] - ly));
        } else if (s.t === "seg") {
          lx = (s.x0 + s.x1) / 2;
          ly = (s.y0 + s.y1) / 2;
          r = Math.max(1, Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / 2);
        }
        return { sx: lx * cos - ly * sin, sy: lx * sin + ly * cos, r: Math.max(0.5, r) };
      });
      for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
          const dx = px + 0.5 - cx;
          const dy = py + 0.5 - cy;
          const lx = dx * cos + dy * sin;
          const ly = -dx * sin + dy * cos;
          for (let k = list.length - 1; k >= 0; k--) {
            const s = list[k];
            if (!hitShape(s, lx, ly)) continue;
            let c = s.c;
            if (s.hi || s.lo) {
              const m = meta[k];
              const L = -((dx - m.sx) + (dy - m.sy)) / (Math.SQRT2 * m.r);
              if (s.hi && L > (s.hiAt ?? 0.38)) c = s.hi;
              else if (s.lo && L < (s.loAt ?? -0.38)) c = s.lo;
            }
            cell.set(px, py, c);
            break;
          }
        }
      }
      if (outline) cell.outline(outline);
      if (shadow) {
        const sh = col(shadow.c ?? "#00000060");
        cell.ellipse(cx + (shadow.dx ?? 1), cy + (shadow.dy ?? 2), shadow.rx, shadow.ry, sh, "under");
      }
      cells.push(cell);
    }
  }
  return atlasOf(cells, dirs, size, size);
}

function hitShape(s, x, y) {
  switch (s.t) {
    case "circle": {
      const dx = x - s.x;
      const dy = y - s.y;
      return dx * dx + dy * dy <= s.r * s.r;
    }
    case "ellipse": {
      const dx = (x - s.x) / s.rx;
      const dy = (y - s.y) / s.ry;
      return dx * dx + dy * dy <= 1;
    }
    case "rect":
      return x >= Math.min(s.x0, s.x1) && x <= Math.max(s.x0, s.x1) && y >= Math.min(s.y0, s.y1) && y <= Math.max(s.y0, s.y1);
    case "poly":
      return pointInPoly(x, y, s.pts);
    case "seg":
      return segDist(x, y, s.x0, s.y0, s.x1, s.y1) <= s.w / 2;
    default:
      return false;
  }
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** RGBA PNG 编码（每行在 None/Sub/Up/Paeth 里挑绝对值和最小的滤波器）。img = Canvas 或 {w,h,data}。 */
export function encodePng(img) {
  const { w, h, data } = img;
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const prev = y > 0 ? row - stride : -1;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 4; f++) {
      const out = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = data[row + i];
        const a = i >= 4 ? data[row + i - 4] : 0;
        const b = prev >= 0 ? data[prev + i] : 0;
        const c = prev >= 0 && i >= 4 ? data[prev + i - 4] : 0;
        let v;
        if (f === 0) v = x;
        else if (f === 1) v = x - a;
        else if (f === 2) v = x - b;
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        v &= 255;
        out[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    const filterId = [0, 1, 2, 4][best];
    raw[y * (stride + 1)] = filterId;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export function pngDataUrl(img) {
  return "data:image/png;base64," + encodePng(img).toString("base64");
}

/** 最近邻放大（预览用）。 */
export function scaleUp(img, k) {
  const out = new Canvas(img.w * k, img.h * k);
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      const si = (Math.floor(y / k) * img.w + Math.floor(x / k)) * 4;
      const di = (y * out.w + x) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

// ---------------------------------------------------------------- WAV

/**
 * Float32 单声道 → 16bit PCM WAV（RIFF）。samples 取值 -1..1。
 * 会先去直流、再按 peak 归一化到 `peak`（默认 0.8），首尾各做 3ms 淡入淡出防爆音。
 */
export function encodeWav(samples, rate = 22050, peak = 0.8) {
  const n = samples.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= Math.max(1, n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    samples[i] -= mean;
    max = Math.max(max, Math.abs(samples[i]));
  }
  const g = max > 0 ? peak / max : 0;
  const fade = Math.min(Math.floor(rate * 0.003), Math.floor(n / 2));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let v = samples[i] * g;
    if (i < fade) v *= i / fade;
    if (i >= n - fade) v *= (n - 1 - i) / fade;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}
