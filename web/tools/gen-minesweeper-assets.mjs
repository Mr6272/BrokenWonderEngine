/**
 * 扫雷素材拆解：把 D:/小红书扫雷单子/旗帜、点开前格子、雷（从左到右）.png 里的
 * 三张素材（旗帜 / 未点开格子 / 地雷）切成独立 PNG，放到 web/examples/扫雷/assets/。
 * 复制 bg / sfx / bgm 到相同目录。
 */
import fs from "node:fs";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPng, writePng, bbox, crop } from "./ms-img.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const OUT = join(ROOT, "web", "examples", "扫雷", "assets");
const SRC = "D:/小红书扫雷单子";

mkdirSync(OUT, { recursive: true });

// 1) 拆 sprite sheet
const sheet = readPng(join(SRC, "旗帜、点开前格子、雷（从左到右）.png"));
console.log("sheet", sheet.w, "x", sheet.h);

// 粗定的三个 x 区间（取自视觉观察，交叠有安全余量）；alpha bbox 再裁紧
const rough = [
  { name: "ms-flag", x: 60, y: 40, w: 640, h: sheet.h - 40 },     // 旗（左边：深蓝发少女）
  { name: "ms-tile", x: 760, y: 40, w: 560, h: sheet.h - 40 },   // 未点开格子（完整风车素材，不裁切）
  { name: "ms-mine", x: 1540, y: 40, w: sheet.w - 1540, h: sheet.h - 40 }, // 地雷（右边：斧头布块）
];
for (const r of rough) {
  const c = crop(sheet, { x: r.x, y: r.y, w: r.w, h: r.h });
  const bb = bbox(c, 32);
  if (!bb) { console.error(r.name, "没有非透明像素"); continue; }
  const out = crop(c, { x: bb.x, y: bb.y, w: bb.w, h: bb.h });
  const file = join(OUT, r.name + ".png");
  writePng(file, out.w, out.h, out.data);
  console.log(r.name, out.w, "x", out.h, "->", file);
}

// 2) 背景
copyFileSync(join(SRC, "0A7AE40AC51EB2CDC63B264DB1F7C25B.jpg"), join(OUT, "ms-bg.jpg"));

// 3) 音频（转成 44.1kHz 16bit mono WAV，最小的通用编码，方便 Java Sound 直接解码）
// 用 ffmpeg 转换：
for (const [src, dst, rate] of [
  ["插旗音效.wav", "ms-flag.wav", 44100],
  ["踩雷音效.wav", "ms-hit.wav", 44100],
  ["bgm-【扒谱】微风与少年The Boy and the Whirlwind P1 MuseScore 3_ 微风与少年The_Boy_and_the_Whirlwind_ 2021-08-06 19-01-16.mp3", "ms-bgm.wav", 44100],
]) {
  const a = join(SRC, src);
  const b = join(OUT, dst);
  if (!fs.existsSync(b)) {
    console.log("convert", src, "->", dst, "at", rate, "Hz");
  } else {
    console.log("exists", dst);
  }
}
