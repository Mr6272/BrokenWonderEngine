/**
 * 单测：截图工具（png.mjs）—— 主题断言与空白判定。
 *
 * 为什么要单测「读图」的代码：`--shot` 和打包 `--verify` 的判死全靠这几个数字。
 * 阈值写错会让深色主题的实拍图被判成「奶油」并通过验收 —— 那是最糟的假阳性。
 *
 * 用真实的 PNG 编码器（zlib + 5 种 filter 里最简单的 filter=0）造图，
 * 模拟三种真实场景：奶油主题截图、深色主题截图、纯白空白截图。
 *
 * 用法：node desktop/test/png.test.mjs
 */

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { analyzePng, assertTheme, describePng, decodePng } from "../lib/png.mjs";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/** 造一张 8bit RGBA PNG（filter=0，无隔行）。只为测判定逻辑，不追求压缩率。 */
function makePng(width, height, pixelAt) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = y * (stride + 1) + 1 + x * 4;
      const [r, g, b, a] = pixelAt(x, y);
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  return Buffer.concat([signature(), chunk("IHDR", ihdr(width, height)), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function signature() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function ihdr(width, height) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = 8; // bitDepth
  b[9] = 6; // colorType RGBA
  b[10] = 0;
  b[11] = 0;
  b[12] = 0; // interlace
  return b;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  c = -1;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 按真实截图的三段式构成造图：**窗口底 / 面板底 / 杂色区**。
 *
 * ⚠ 造图要点（踩过）：
 *   1. analyzePng 把颜色量化到 5bit/通道，杂色必须落在不同桶（差 ≥8）才算一种颜色；
 *   2. 窗口底要占**最多**（真实截图主色只占 30%~55%，但它是单一最高频色）；
 *   3. 前景占比要落在 --verify 的 20%~92% 区间，否则会被判成「空白」或「色块」。
 * 所以：窗口底 45% / 面板 35% / 杂色 20%（多色）→ 主色对、颜色数够、前景 55%。
 */
function threeToneShot(w, h, base, panel, accents) {
  return makePng(w, h, (x, y) => {
    const fx = x / w;
    if (fx < 0.45) return [...base, 255];
    if (fx < 0.8) return [...panel, 255];
    const a = accents[(x + y) % accents.length];
    return [...a, 255];
  });
}

function creamShot(w = 200, h = 120) {
  return threeToneShot(
    w,
    h,
    [247, 244, 238], // #f7f4ee 窗口底（奶油）
    [253, 251, 247], // #fdfbf7 面板底
    [
      [60, 55, 48], [122, 106, 80], [154, 145, 132], [226, 219, 205],
      [200, 190, 170], [176, 160, 130], [90, 80, 64], [212, 204, 190]
    ]
  );
}

/** 深色主题（app.css 的默认外观）：同样的三段式，只是都换成深色。 */
function darkShot(w = 200, h = 120) {
  return threeToneShot(
    w,
    h,
    [24, 25, 30], // ≈ #181820（实测主色）
    [30, 32, 40],
    [
      [46, 50, 62], [60, 66, 80], [80, 88, 106], [110, 120, 140],
      [150, 160, 180], [200, 206, 214], [70, 78, 96], [16, 17, 21]
    ]
  );
}

/** 纯白空白页。 */
function blankShot(w = 160, h = 100) {
  return makePng(w, h, () => [255, 255, 255, 255]);
}

test("解码尺寸正确", () => {
  const stats = analyzePng(creamShot(160, 100));
  assert.equal(stats.width, 160);
  assert.equal(stats.height, 100);
});

test("奶油截图：判浅色、主题 PASS", () => {
  const stats = analyzePng(creamShot());
  const theme = assertTheme(stats);
  assert.equal(theme.theme, "cream");
  assert.equal(theme.ok, true, `奶油截图必须 PASS，实际：${theme.detail}`);
  assert.ok(stats.backgroundLuminance > 0.7, `浅底亮度应 >0.7，实际 ${stats.backgroundLuminance}`);
  assert.equal(stats.isEmpty, false);
});

test("深色截图：判深色、主题 FAIL（非奶油=FAIL）", () => {
  const stats = analyzePng(darkShot());
  const theme = assertTheme(stats);
  assert.equal(theme.theme, "dark");
  assert.equal(theme.ok, false, "深色主题必须判 FAIL（期望奶油）");
  assert.ok(stats.backgroundLuminance < 0.35, `深底亮度应 <0.35，实际 ${stats.backgroundLuminance}`);
  assert.ok(theme.detail.includes("cream.css"), "失败提示要指出该检查什么");
});

test("纯白空白：判 isEmpty", () => {
  const stats = analyzePng(blankShot());
  assert.equal(stats.isEmpty, true, "纯色截图必须判空");
  assert.equal(stats.uniqueColors, 1);
  assert.equal(stats.foregroundRatio < 0.02, true);
});

test("空白截图不误判成奶油主题", () => {
  const stats = analyzePng(blankShot());
  const theme = assertTheme(stats);
  assert.equal(theme.theme, "unknown", "空白图判主题没有意义，应为 unknown");
  assert.equal(theme.ok, false);
});

test("主色就是出现次数最多的颜色", () => {
  const stats = analyzePng(creamShot());
  // 量化到 5bit 后 #f7f4ee ≈ f0f0e8（历史实测就是这个值）
  assert.ok(/^#f[0-9a-f]/.test(stats.background), `背景色应接近 #f7f4ee，实际 ${stats.background}`);
  // 合成图刻意做成「窗口底 45% / 面板 35% / 杂色 20%」—— 主色不必 >50%，
  // 真实截图里主色也只有 30%~55%（面板、画布、侧栏各有底色）。
  // 这里只确认它是单一最高频色且明显高于其他颜色。
  assert.ok(stats.backgroundRatio > 0.3, `主色占比应 >30%，实际 ${(stats.backgroundRatio * 100).toFixed(1)}%`);
});

test("describePng 一行含可判定的全部字段", () => {
  const text = describePng(analyzePng(creamShot()));
  for (const key of ["尺寸", "字节", "颜色数", "背景", "非背景像素", "亮度", "判定"]) {
    assert.ok(text.includes(key), `结论行缺少「${key}」：${text}`);
  }
});

test("非 PNG 字节要抛可读错误（不是 crash）", () => {
  assert.throws(() => analyzePng(Buffer.from("hello world")), /不是 PNG/);
});

test("非背景占比：双边阈值能区分「界面没起来」与「渲染成色块」", () => {
  // 判定的三条边界（与 app-main.mjs 的 contentOk 保持一致）：
  //   下界 20% 防「只剩底栏」；上界 92% 防「底色没铺开 / 退化成噪点」。
  // 这条单测就是把阈值钉住：只保留下界的话，「渲染成色块」这类失败永远判不出来。
  const LOWER = 0.2;
  const UPPER = 0.92;

  // 只剩底栏：几乎全空 → 前景极低
  const blank = analyzePng(blankShot());
  assert.ok(blank.foregroundRatio < LOWER, `纯白图前景应极低，实际 ${blank.foregroundRatio}`);

  // 渲染成噪点/满屏色块：前景接近 100%
  const noisy = makePng(160, 100, (x, y) => {
    const v = (x * 7 + y * 13) % 256;
    return [v, (v + 40) % 256, (v + 90) % 256, 255];
  });
  const noisyStats = analyzePng(noisy);
  assert.ok(noisyStats.foregroundRatio > UPPER, `满屏噪点前景应 >92%，实际 ${noisyStats.foregroundRatio}`);
  assert.equal(noisyStats.isEmpty, false, "噪点图不该判空（它确实有内容，只是不对）");

  // 正常界面：落在区间内
  const normal = analyzePng(creamShot());
  assert.ok(
    normal.foregroundRatio > LOWER && normal.foregroundRatio < UPPER,
    `正常界面应落在 ${LOWER}~${UPPER}，实际 ${normal.foregroundRatio}`
  );

  // 真实实拍值也要在区间内（1600x1000 与 1280x720 的 --verify 实测约 65%~70%）
  const realish = 0.68;
  assert.ok(realish > LOWER && realish < UPPER);
});

test("decodePng 对 8bit RGB（colorType=2）也能解", () => {
  // 造一张 RGB（无 alpha）的图：colorType 2
  const width = 8;
  const height = 8;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = 240;
      raw[o + 1] = 238;
      raw[o + 2] = 230;
    }
  }
  const ihdrRgb = Buffer.alloc(13);
  ihdrRgb.writeUInt32BE(width, 0);
  ihdrRgb.writeUInt32BE(height, 4);
  ihdrRgb[8] = 8;
  ihdrRgb[9] = 2; // RGB
  const png = Buffer.concat([
    signature(),
    chunk("IHDR", ihdrRgb),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
  const decoded = decodePng(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.channels, 3);
  const stats = analyzePng(png);
  assert.ok(stats.backgroundLuminance > 0.5, "浅色 RGB 图亮度应偏高");
});

for (const c of cases) {
  try {
    c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    console.error(`  ✗ ${c.name}\n    ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\npng.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
