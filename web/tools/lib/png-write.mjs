/**
 * 示例素材生成：把每种素材画成真正的 PNG（data URL 内联进 .bwproj）。
 *
 * 为什么不用 SVG：本仓有**两条**打包入口 ——
 *   ① 浏览器打包（`npm run serve` 的 `/api/package-bwe`）能把 SVG 栅格化成 PNG；
 *   ② 命令行打包（`node web/tools/package-bwe.mjs --build-only`）**不能**，
 *      只会告警"命令行模式不能栅格化 SVG"，运行时就只剩色块。
 * 示例工程必须**两条都能跑**（否则用户用命令行试跑时会以为光照没做出来，实际是素材丢了）。
 * 所以这里用最小的 PNG 编码器（zlib，零依赖）直接画位图，与其它示例的内联位图约定一致。
 */

import zlib from "node:zlib";

/** CRC32（PNG 每个 chunk 都要）。 */
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

/**
 * 编码 8bit RGBA、非隔行 PNG。
 *
 * @param {number} w
 * @param {number} h
 * @param {(x:number,y:number)=>[number,number,number,number?]} shade
 * @returns {Buffer}
 */
export function encodePng(w, h, shade) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = shade(x, y) || [0, 0, 0, 0];
      const o = (y * w + x) * 4;
      px[o] = c[0] ?? 0;
      px[o + 1] = c[1] ?? 0;
      px[o + 2] = c[2] ?? 0;
      px[o + 3] = c[3] === undefined ? 255 : c[3];
    }
  }
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: None
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data]), 0), 0);
    return Buffer.concat([len, t, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** 便捷：编码成 `data:image/png;base64,...`。 */
export function dataUrl(w, h, shade) {
  return "data:image/png;base64," + encodePng(w, h, shade).toString("base64");
}
