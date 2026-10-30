/**
 * 极简 PNG 读取器：色彩型 6（RGBA）位深 8、无隔行。
 * 输出 {w, h, data: Uint8Array(w*h*4)}，alpha 0=全透。
 */
import fs from "node:fs";
import zlib from "node:zlib";

export function readPng(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32BE(12) !== 0x49484452) throw new Error("bad png");
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8 || interlace !== 0) throw new Error("unsupported png depth=" + bitDepth + " interlace=" + interlace);
  if (colorType !== 6 && colorType !== 2) { void colorType; }
  // 走 IHDR 之后的所有 IDAT
  let pos = 33;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.readUInt32BE(pos + 4);
    if (type === 0x49444154) idat.push(buf.subarray(pos + 8, pos + 8 + len));
    else if (type === 0x49454E44) break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  let op = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[op++];
    const cur = raw.subarray(op, op + stride);
    op += stride;
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const ci = a + b - c;
      const pa = Math.abs(ci - a), pb = Math.abs(ci - b), pc = Math.abs(ci - c);
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2)
        : (pa <= pb && pa <= pc) ? a : (pb <= pc) ? b : c;
      row[x] = (cur[x] + pred) & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const src = x * bpp;
      const dst = (y * w + x) * 4;
      out[dst] = row[src];
      out[dst + 1] = row[src + 1];
      out[dst + 2] = row[src + 2];
      out[dst + 3] = colorType === 6 ? row[src + 3] : 255;
    }
    prev = row;
  }
  return { w, h, data: out };
}

/** 常规 PNG 写出（RGBA）。 */
export function writePng(path, w, h, data) {
  const crc32 = buildCrc();
  const chunks = [];
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4);
    const crc = Buffer.alloc(4);
    const crcBuf = Buffer.alloc(body.length + 4);
    crcBuf.write(type, 0, "binary");
    body.copy(crcBuf, 4);
    crc.writeUInt32BE(crc32(crcBuf) >>> 0, 0);
    chunks.push(head, body, crc);
  };
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  chunk("IHDR", ihdr);
  // IDAT
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter 0
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  chunk("IDAT", idat);
  chunk("IEND", Buffer.alloc(0));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path, Buffer.concat([sig, ...chunks]));
}

let CRC_TABLE = null;
function buildCrc() {
  if (CRC_TABLE !== null) return crc32;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return crc32;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** crops = [{x,y,w,h,name}] —— 返回各自 RGBA 数据。 */
export function crop(img, r) {
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const sx = r.x + x, sy = r.y + y;
    if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue;
    const src = (sy * img.w + sx) * 4;
    const dst = (y * r.w + x) * 4;
    out[dst] = img.data[src];
    out[dst + 1] = img.data[src + 1];
    out[dst + 2] = img.data[src + 2];
    out[dst + 3] = img.data[src + 3];
  }
  return { w: r.w, h: r.h, data: out };
}

/** 找到 alpha>thresh 的最紧 bounding box，返回 {x, y, w, h}。 */
export function bbox(img, thresh = 32) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (img.data[(y * img.w + x) * 4 + 3] > thresh) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
