/**
 * 扫雷素材生成器 —— 纯代码画，无任何外部来源。
 *
 * 为什么换掉原来的素材：`web/examples/扫雷/assets/` 里那 7 个文件是从仓库外的
 * 一份委托单子（D:/小红书扫雷单子）切出来的，含一首第三方 BGM《微风与少年》。
 * 那些素材的版权不在本仓库，不能随 MIT 一起发布，所以改为程序生成。
 *
 * 产物（覆盖同名文件）：
 *   ms-tile.png  未翻开的格子（32px 可平铺，带高光与暗边）
 *   ms-flag.png  旗帜（三角旗 + 旗杆）
 *   ms-mine.png  地雷（圆形 + 尖刺 + 高光）
 *   ms-bg.jpg    背景（竖向渐变 + 淡网格，纯色无第三方图案）
 *   ms-flag.wav  插旗音效（短促上扬）
 *   ms-hit.wav   踩雷音效（低频爆炸）
 *   ms-bgm.wav   背景音乐（和弦循环，正弦合成）
 *
 * 全部确定性生成（固定种子），重跑得到同样字节。
 *
 * 用法：node tools/gen-minesweeper-assets-code.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(ROOT, "web", "examples", "扫雷", "assets");
mkdirSync(OUT, { recursive: true });

// ---------------- 确定性伪随机 ----------------
// 固定种子，避免 Math.random 造成每次产物不同（素材要能进版本库并逐字节复现）。
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------- 最小 PNG 编码器 ----------------
// 只用 zlib + 手写 chunk，不引第三方依赖（仓库 devDependencies 里只有 esbuild/typescript）。
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素数组 → PNG Buffer。 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // 每行前加 filter 字节 0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------- 画图基元 ----------------
function newCanvas(w, h, r = 0, g = 0, b = 0, a = 255) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return { w, h, buf };
}

function setPx(c, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  c.buf[i] = r;
  c.buf[i + 1] = g;
  c.buf[i + 2] = b;
  c.buf[i + 3] = a;
}

function blendPx(c, x, y, r, g, b, alpha) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  const src = alpha / 255;
  c.buf[i] = Math.round(c.buf[i] * (1 - src) + r * src);
  c.buf[i + 1] = Math.round(c.buf[i + 1] * (1 - src) + g * src);
  c.buf[i + 2] = Math.round(c.buf[i + 2] * (1 - src) + b * src);
  c.buf[i + 3] = Math.max(c.buf[i + 3], Math.round(alpha));
}

function fillRect(c, x0, y0, w, h, r, g, b, a = 255) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(c, x, y, r, g, b, a);
}

function fillCircle(c, cx, cy, radius, r, g, b, a = 255) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
    for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) blendPx(c, x, y, r, g, b, a);
    }
  }
}

function fillTri(c, p1, p2, p3, r, g, b, a = 255) {
  const minX = Math.min(p1[0], p2[0], p3[0]);
  const maxX = Math.max(p1[0], p2[0], p3[0]);
  const minY = Math.min(p1[1], p2[1], p3[1]);
  const maxY = Math.max(p1[1], p2[1], p3[1]);
  const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  for (let y = Math.floor(minY); y <= maxY; y++) {
    for (let x = Math.floor(minX); x <= maxX; x++) {
      const d1 = sign(x, y, p1[0], p1[1], p2[0], p2[1]);
      const d2 = sign(x, y, p2[0], p2[1], p3[0], p3[1]);
      const d3 = sign(x, y, p3[0], p3[1], p1[0], p1[1]);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) blendPx(c, x, y, r, g, b, a);
    }
  }
}

// ---------------- 素材：未翻开的格子 ----------------
// 32×32，可无缝平铺：浅色面 + 左上高光 + 右下暗边，像一块压下去的按钮。
function makeTile(size = 32) {
  const c = newCanvas(size, size);
  const face = [92, 112, 148];
  const hi = [132, 154, 190];
  const lo = [58, 72, 100];
  fillRect(c, 0, 0, size, size, ...face);
  // 外框暗边
  fillRect(c, 0, 0, size, 1, ...lo);
  fillRect(c, 0, 0, 1, size, ...lo);
  fillRect(c, 0, size - 1, size, 1, ...lo);
  fillRect(c, size - 1, 0, 1, size, ...lo);
  // 内高光（左上两条）
  fillRect(c, 2, 2, size - 4, 2, ...hi);
  fillRect(c, 2, 2, 2, size - 4, ...hi);
  // 内暗边（右下两条）
  fillRect(c, 2, size - 4, size - 4, 2, ...lo);
  fillRect(c, size - 4, 2, 2, size - 4, ...lo);
  // 中央轻微凸起
  const m = size / 2;
  fillRect(c, m - 5, m - 5, 10, 10, 100, 120, 156);
  fillRect(c, m - 5, m - 5, 10, 2, ...hi);
  return c;
}

// ---------------- 素材：旗帜 ----------------
function makeFlag(size = 32) {
  const c = newCanvas(size, size, 0, 0, 0, 0); // 透明底
  const pole = [214, 218, 226];
  const dark = [150, 156, 170];
  // 旗杆：竖线 + 顶部圆点
  fillRect(c, 9, 4, 3, 24, ...pole);
  fillRect(c, 12, 4, 1, 24, ...dark);
  fillCircle(c, 10, 4, 2.2, ...pole);
  // 三角旗
  fillTri(c, [13, 6], [27, 11], [13, 16], 232, 78, 78);
  fillTri(c, [13, 7], [24, 11], [13, 11], 248, 120, 120); // 高光
  // 底座
  fillRect(c, 5, 28, 12, 2, ...dark);
  return c;
}

// ---------------- 素材：地雷 ----------------
function makeMine(size = 32) {
  const c = newCanvas(size, size, 0, 0, 0, 0);
  const cx = size / 2;
  const cy = size / 2;
  const body = [46, 48, 56];
  const edge = [22, 24, 30];
  // 尖刺（八方向）
  for (let i = 0; i < 8; i++) {
    const ang = (Math.PI * 2 * i) / 8;
    const x2 = cx + Math.cos(ang) * (size / 2 - 1);
    const y2 = cy + Math.sin(ang) * (size / 2 - 1);
    for (let t = 0; t < 1; t += 0.02) {
      const x = cx + (x2 - cx) * t;
      const y = cy + (y2 - cy) * t;
      blendPx(c, Math.round(x), Math.round(y), ...edge, 255);
      blendPx(c, Math.round(x) + 1, Math.round(y), ...edge, 255);
    }
  }
  // 弹体
  fillCircle(c, cx, cy, size * 0.34, ...body);
  fillCircle(c, cx, cy, size * 0.34 - 2, 58, 60, 70);
  // 高光
  fillCircle(c, cx - 4, cy - 4, 3.5, 150, 154, 168, 210);
  // 中心小点
  fillCircle(c, cx, cy, 2.5, 200, 205, 218);
  return c;
}

// ---------------- 素材：背景 ----------------
// 竖向渐变 + 极淡网格。纯色，无第三方图案。
function makeBg(w = 540, h = 960) {
  const c = newCanvas(w, h);
  const top = [26, 32, 48];
  const bot = [12, 15, 24];
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const r = Math.round(top[0] * (1 - t) + bot[0] * t);
    const g = Math.round(top[1] * (1 - t) + bot[1] * t);
    const b = Math.round(top[2] * (1 - t) + bot[2] * t);
    fillRect(c, 0, y, w, 1, r, g, b);
  }
  // 淡网格，给画布一点结构感
  for (let y = 0; y < h; y += 64) {
    for (let x = 0; x < w; x++) blendPx(c, x, y, 90, 110, 150, 26);
  }
  for (let x = 0; x < w; x += 64) {
    for (let y = 0; y < h; y++) blendPx(c, x, y, 90, 110, 150, 26);
  }
  return c;
}

// ---------------- 音频 ----------------
// 44.1kHz / 16bit / mono WAV，程序合成。

const RATE = 44100;

function encodeWav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

function env(t, dur, attack = 0.005, release = 0.08) {
  if (t < attack) return t / attack;
  if (t > dur - release) return Math.max(0, (dur - t) / release);
  return 1;
}

/** 插旗：短促上扬的双音，清脆。 */
function sfxFlag() {
  const dur = 0.16;
  const n = Math.floor(RATE * dur);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f = 880 + (t / dur) * 700; // 880 → 1580Hz 上扬
    const s = Math.sin(2 * Math.PI * f * t) * 0.55 + Math.sin(2 * Math.PI * f * 2 * t) * 0.16;
    out[i] = s * env(t, dur, 0.004, 0.09) * 0.7;
  }
  return out;
}

/** 踩雷：低频爆炸 + 噪声。 */
function sfxHit() {
  const dur = 0.55;
  const n = Math.floor(RATE * dur);
  const out = new Float32Array(n);
  const rng = makeRng(0x51f3a7);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f = 150 * Math.exp(-t * 7) + 38; // 快速下滑的低频
    const tone = Math.sin(2 * Math.PI * f * t);
    // 噪声经简单低通，模拟冲击
    const noise = (rng() * 2 - 1) * Math.exp(-t * 12);
    lp = lp * 0.72 + noise * 0.28;
    out[i] = (tone * 0.7 + lp * 0.55) * Math.exp(-t * 5) * 0.85;
  }
  return out;
}

/**
 * BGM：Am-F-C-G 循环，正弦合成，带轻微颤音与缓入。
 * 纯程序合成，不基于任何现有作品。
 */
function bgm() {
  const bpm = 84;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const bars = 8; // 8 小节循环
  const dur = bar * bars;
  const n = Math.floor(RATE * dur);
  const out = new Float32Array(n);
  // 每个和弦四个音（根音 + 三音 + 五音 + 八度）
  const chords = [
    [220.0, 261.63, 329.63, 440.0], // Am
    [174.61, 220.0, 261.63, 349.23], // F
    [261.63, 329.63, 392.0, 523.25], // C
    [196.0, 246.94, 293.66, 392.0], // G
  ];
  for (let barIdx = 0; barIdx < bars; barIdx++) {
    const chord = chords[barIdx % 4];
    const start = Math.floor(barIdx * bar * RATE);
    const len = Math.floor(bar * RATE);
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= n) break;
      const t = i / RATE;
      const barT = t / bar;
      // 缓入缓出，避免爆音
      const fade = Math.min(1, barT / 0.12) * Math.min(1, (1 - barT) / 0.18);
      let s = 0;
      for (let k = 0; k < chord.length; k++) {
        const f = chord[k];
        const detune = 1 + 0.0016 * Math.sin(2 * Math.PI * 0.23 * t + k); // 轻微颤音
        s += Math.sin(2 * Math.PI * f * detune * t) * (0.34 / (k + 1));
      }
      // 柔和低音
      s += Math.sin(2 * Math.PI * (chord[0] / 2) * t) * 0.16;
      out[idx] += s * fade * 0.6;
    }
  }
  // 首尾交叉淡化，让循环接缝听不出来
  const xf = Math.floor(0.25 * RATE);
  for (let i = 0; i < xf; i++) {
    const a = i / xf;
    out[i] *= a;
    out[n - 1 - i] *= a;
  }
  return out;
}

// ---------------- 落盘 ----------------
function writeCanvas(name, c) {
  if (!c) return;
  const file = join(OUT, name);
  writeFileSync(file, encodePng(c.w, c.h, c.buf));
  console.log(`  ${name.padEnd(14)} ${c.w}x${c.h}`);
}

console.log("生成扫雷素材（纯代码，无外部来源）→", OUT);

writeCanvas("ms-tile.png", makeTile(32));
writeCanvas("ms-flag.png", makeFlag(32));
writeCanvas("ms-mine.png", makeMine(32));
writeCanvas("ms-bg.jpg", makeBg(540, 960)); // 内容是 PNG，扩展名沿用工程里的引用

writeFileSync(join(OUT, "ms-flag.wav"), encodeWav(sfxFlag()));
console.log("  ms-flag.wav    插旗音效");
writeFileSync(join(OUT, "ms-hit.wav"), encodeWav(sfxHit()));
console.log("  ms-hit.wav     踩雷音效");
writeFileSync(join(OUT, "ms-bgm.wav"), encodeWav(bgm()));
console.log("  ms-bgm.wav     背景音乐（Am-F-C-G 循环）");

console.log("完成。全部图层/音频由本脚本合成，可安全随 MIT 发布。");
