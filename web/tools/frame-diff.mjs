// 逐像素对比两张 PNG，输出差异统计。用于证明「渲染优化后像素等价」。
// 用法: node web/tools/frame-diff.mjs <a.png> <b.png> [--tolerance 0] [--out diff.png]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** 最小 PNG 解码器（只支持本仓库会用到的 8bit RGB/RGBA，非隔行）。 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let pos = 8;
  let width = 0, height = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("不支持隔行 PNG");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error("只支持 8bit，实际 " + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (channels < 0) throw new Error("不支持的 colorType " + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      }
      cur[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      if (channels >= 3) {
        out[di] = cur[si];
        out[di + 1] = cur[si + 1];
        out[di + 2] = cur[si + 2];
        out[di + 3] = channels === 4 ? cur[si + 3] : 255;
      } else {
        out[di] = out[di + 1] = out[di + 2] = cur[si];
        out[di + 3] = 255;
      }
    }
    cur.copy(prev);
  }
  return { width, height, data: out };
}

/** 极简 PNG 编码（RGBA），用于输出差异图。 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunks = [];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  chunks.push(chunk("IHDR", ihdr));
  chunks.push(chunk("IDAT", zlib.deflateSync(raw, { level: 6 })));
  chunks.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat([sig, ...chunks]);
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------- main ----------------
const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("用法: node web/tools/frame-diff.mjs <a.png> <b.png> [--tolerance N] [--out diff.png]");
  process.exit(2);
}
let tolerance = 0;
let outPath = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--tolerance") tolerance = Number(argv[++i]);
  else if (a === "--out") outPath = argv[++i];
  else files.push(a);
}
const A = decodePng(fs.readFileSync(files[0]));
const B = decodePng(fs.readFileSync(files[1]));
if (A.width !== B.width || A.height !== B.height) {
  console.error(`尺寸不同: ${A.width}x${A.height} vs ${B.width}x${B.height}`);
  process.exit(3);
}
let diffPixels = 0, maxDelta = 0, sumDelta = 0;
let minX = A.width, minY = A.height, maxX = -1, maxY = -1;
const hist = new Map();
let diffImg = null;
if (outPath) {
  const d = Buffer.alloc(A.width * A.height * 4);
  for (let i = 0; i < A.width * A.height * 4; i += 4) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 255; }
  diffImg = d;
}
for (let y = 0; y < A.height; y++) {
  for (let x = 0; x < A.width; x++) {
    const i = (y * A.width + x) * 4;
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const delta = Math.abs(A.data[i + k] - B.data[i + k]);
      if (delta > d) d = delta;
      sumDelta += delta;
    }
    if (d > tolerance) {
      diffPixels++;
      if (d > maxDelta) maxDelta = d;
      const bucket = d === 0 ? 0 : d <= 2 ? 2 : d <= 8 ? 8 : d <= 32 ? 32 : d <= 64 ? 64 : 255;
      hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (diffImg) {
        diffImg[i] = 0; diffImg[i + 1] = 0; diffImg[i + 2] = 0; diffImg[i + 3] = 255;
      }
    }
  }
}
if (outPath && diffImg) fs.writeFileSync(outPath, encodePng(A.width, A.height, diffImg));
const total = A.width * A.height;
const result = {
  a: files[0], b: files[1],
  width: A.width, height: A.height,
  totalPixels: total,
  diffPixels,
  diffPct: +((diffPixels / total) * 100).toFixed(4),
  maxDelta,
  meanDelta: +(sumDelta / (total * 3)).toFixed(4),
  bbox: diffPixels ? { minX, minY, maxX, maxY } : null,
  histogram: Object.fromEntries([...hist.entries()].sort((x, y) => x[0] - y[0])),
  equivalent: diffPixels === 0
};
console.log("FRAME_DIFF " + JSON.stringify(result));
process.exit(result.equivalent ? 0 : 1);
