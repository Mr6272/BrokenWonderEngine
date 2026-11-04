#!/usr/bin/env node
/**
 * 生成 2D 光照系统的**仲裁 fixture**（`test/fixtures/lighting-case.json`）。
 *
 * 为什么需要它：
 *   光照烘焙在**两处**实现 —— Web 编辑器（`web/src/app/lightMath.ts`）与 Java 运行时
 *   （`src/Studio/runtime/LightMap.java`）。两处只要有一处公式走样，玩家就会看到
 *   「编辑器预览是一个样、进游戏是另一个样」。
 *   所以契约（`docs/_fragments/lighting-contract.md` §2）必须被一个**第三方独立实现**
 *   算成具体像素值，双方都按这些点做逐像素断言。本文件就是这个第三方。
 *
 * 纪律：
 *   - 只实现契约 §2，**不读**任何一方的源码（避免"实现和测试一起错"）；
 *   - 纯 Node 标准库，确定性：同一输入任何时候都产出逐字节相同的 JSON；
 *   - 输出用 4 空格缩进 + 固定键序，方便 diff。
 *
 * 用法：
 *   node web/tools/gen-lighting-fixture.mjs            # 写入默认路径
 *   node web/tools/gen-lighting-fixture.mjs --print     # 只打印到 stdout
 *   node web/tools/gen-lighting-fixture.mjs --out <path>
 *
 * 主 case（`main`）用 `softness: 0`：模糊是**有损**运算，两种实现（box blur 的边界归一
 * 写法、是否先模糊环境光）很容易在细节上分叉，用 0 半径把"衰减/聚光/阴影"这些**核心公式**
 * 钉死，模糊另用性质断言（总能量守恒 ±1%、最大方差下降）验证。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DEFAULT_OUT = join(ROOT, "test", "fixtures", "lighting-case.json");

// ---------------- 契约 §2 的第三方实现 ----------------

/** `#rrggbb` / `#rgb` → [r,g,b] 0..1（非法 → null，由调用方决定兜底）。 */
function parseHexColor(s) {
  const t = String(s ?? "").trim();
  if (!t.startsWith("#")) return null;
  const hex = t.slice(1);
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return [r / 255, g / 255, b / 255];
  }
  if (hex.length !== 6) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return [r / 255, g / 255, b / 255];
}

const DEG = Math.PI / 180;

/** 契约 §2.7 的 hash01。 */
function hash01(id) {
  let h = 0;
  const s = String(id ?? "");
  for (let i = 0; i < s.length; i++) {
    h = ((h * 31) + s.charCodeAt(i)) >>> 0;
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** 把角度归一化到 (-π, π]。 */
function normPi(a) {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v <= -Math.PI) v += Math.PI * 2;
  return v;
}

/** 契约 §2.4：线段是否被 AABB 阻挡（slab 法，交点参数在 (0,1) 内才算）。 */
function segmentHitsBox(ax, ay, bx, by, cx, cy, hw, hh) {
  const dx = bx - ax;
  const dy = by - ay;
  let tmin = 0;
  let tmax = 1;
  // X 轴 slab
  if (Math.abs(dx) < 1e-9) {
    if (ax < cx - hw || ax > cx + hw) return false;
  } else {
    let t1 = (cx - hw - ax) / dx;
    let t2 = (cx + hw - ax) / dx;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  // Y 轴 slab
  if (Math.abs(dy) < 1e-9) {
    if (ay < cy - hh || ay > cy + hh) return false;
  } else {
    let t1 = (cy - hh - ay) / dy;
    let t2 = (cy + hh - ay) / dy;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  // 交点必须在 (0,1) 内：端点贴着盒子不算遮挡（否则灯贴在墙上就整个熄掉）
  return tmax > 1e-5 && tmin < 1 - 1e-5;
}

/** 单盏光在某点的贡献（不带 clamp，返回 [r,g,b]）。 */
function lightContribution(light, px, py, occluders) {
  const radius = Number(light.radius ?? 140);
  if (!(radius > 0)) return [0, 0, 0];
  const lx = Number(light.x ?? 0);
  const ly = Number(light.y ?? 0);
  const color = parseHexColor(light.color) ?? [1, 1, 1];
  const intensity = Number(light.intensity ?? 1);
  if (!(intensity > 0)) return [0, 0, 0];
  const falloff = Math.min(4, Math.max(1, Number(light.falloff ?? 2)));

  const dx = px - lx;
  const dy = py - ly;
  const d = Math.sqrt(dx * dx + dy * dy);
  const t = d / radius;
  if (t >= 1) return [0, 0, 0];

  let atten = Math.pow(1 - t, falloff);

  if (String(light.type ?? "point") === "spot") {
    const angleDeg = Number(light.angle ?? 60);
    const halfRad = (angleDeg / 2) * DEG;
    const dirRad = Number(light.dir ?? 0) * DEG;
    const angRad = Math.atan2(dy, dx);
    const diff = Math.abs(normPi(angRad - dirRad));
    if (diff > halfRad) return [0, 0, 0];
    const softRad = Math.max(0, Number(light.coneSoft ?? 10)) * DEG;
    if (softRad > 0 && diff > halfRad - softRad) {
      atten *= Math.max(0, Math.min(1, (halfRad - diff) / softRad));
    }
  }

  if (light.shadow !== false && light.shadow !== 0 && light.shadow !== "0") {
    for (const oc of occluders) {
      if (segmentHitsBox(lx, ly, px, py, Number(oc.x), Number(oc.y), Number(oc.hw ?? 0), Number(oc.hh ?? 0))) {
        return [0, 0, 0];
      }
    }
  }

  // 烘焙模式下 flicker 不参与（契约 §2.3 第 7 条）
  const scale = intensity * atten;
  return [color[0] * scale, color[1] * scale, color[2] * scale];
}

/**
 * 契约 §2 主流程：返回 `{ texW, texH, sEff, rgb: Float32Array }`（长度 texW*texH*3）。
 */
export function bakeCase(c) {
  const W = Number(c.width);
  const H = Number(c.height);
  const s = Number(c.texelsPerPixel ?? 0.25);
  let texW = Math.max(1, Math.round(W * s));
  let texH = Math.max(1, Math.round(H * s));
  let sEff = Math.min(texW / W, texH / H);
  if (texW > 2048 || texH > 2048) {
    const shrink = Math.min(2048 / texW, 2048 / texH);
    texW = Math.max(1, Math.round(texW * shrink));
    texH = Math.max(1, Math.round(texH * shrink));
    sEff = Math.min(texW / W, texH / H);
  }

  const ambientColor = parseHexColor(c.ambient?.color) ?? [0.227, 0.29, 0.42]; // #3A4A6B
  const ambientIntensity = Number(c.ambient?.intensity ?? 0.35);
  const ambient = [
    ambientColor[0] * ambientIntensity,
    ambientColor[1] * ambientIntensity,
    ambientColor[2] * ambientIntensity,
  ];

  const lights = (c.lights ?? []).filter((l) => l && l.dynamic !== true && l.dynamic !== 1 && l.dynamic !== "1");
  const occluders = c.occluders ?? [];

  const rgb = new Float32Array(texW * texH * 3);
  for (let j = 0; j < texH; j++) {
    for (let i = 0; i < texW; i++) {
      const px = (i + 0.5) / sEff;
      const py = (j + 0.5) / sEff;
      let r = ambient[0];
      let g = ambient[1];
      let b = ambient[2];
      for (const light of lights) {
        const contrib = lightContribution(light, px, py, occluders);
        r += contrib[0];
        g += contrib[1];
        b += contrib[2];
      }
      const o = (j * texW + i) * 3;
      rgb[o] = Math.max(0, Math.min(1, r));
      rgb[o + 1] = Math.max(0, Math.min(1, g));
      rgb[o + 2] = Math.max(0, Math.min(1, b));
    }
  }
  return { texW, texH, sEff, rgb };
}

/** 契约 §2.5 柔化：2 遍方框模糊（半径归一）。 */
export function blurRgb(rgb, texW, texH, radius) {
  const r = Math.max(0, Math.round(radius));
  if (r <= 0) return rgb;
  let src = Float32Array.from(rgb);
  let dst = new Float32Array(rgb.length);
  for (let pass = 0; pass < 2; pass++) {
    // 横向
    for (let j = 0; j < texH; j++) {
      for (let i = 0; i < texW; i++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const x = i + k;
          if (x < 0 || x >= texW) continue;
          const o = (j * texW + x) * 3;
          sr += src[o];
          sg += src[o + 1];
          sb += src[o + 2];
          n++;
        }
        const o = (j * texW + i) * 3;
        dst[o] = sr / n;
        dst[o + 1] = sg / n;
        dst[o + 2] = sb / n;
      }
    }
    // 纵向（读 dst 写 src）
    for (let j = 0; j < texH; j++) {
      for (let i = 0; i < texW; i++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const y = j + k;
          if (y < 0 || y >= texH) continue;
          const o = (y * texW + i) * 3;
          sr += dst[o];
          sg += dst[o + 1];
          sb += dst[o + 2];
          n++;
        }
        const o = (j * texW + i) * 3;
        src[o] = sr / n;
        src[o + 1] = sg / n;
        src[o + 2] = sb / n;
      }
    }
    if (pass === 0) {
      // 第二轮要读上一轮结果，交换缓冲
      const tmp = Float32Array.from(src);
      src = tmp;
    }
  }
  return src;
}

/** 浮点 RGB → 0..255 整数（clamp + round）。 */
function toByte(v) {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// ---------------- 用例定义 ----------------

/** 主 case：衰减 + 聚光 + 阴影，softness=0（模糊走性质断言）。 */
function buildMainCase() {
  // 设计（每个采样点只考察一件事，出问题能立刻定位到哪条公式错了）：
  //   L1 = 点光 (64,64) r=100 shadow=true —— 考衰减 + 遮挡
  //   L2 = 聚光 (200,40) r=120 angle=60 dir=135 shadow=false —— 只考锥体按角度
  //   遮挡体 AABB 中心 (96,64) hw=8 hh=32 → x∈[88,104], y∈[32,96]（一堵竖墙）
  return {
    name: "main",
    note: "softness=0：校验衰减/聚光锥/遮挡/采样率。L1 有 shadow，L2 无 shadow（隔离锥体测试）",
    version: 1,
    width: 256,
    height: 192,
    texelsPerPixel: 0.5,
    softness: 0,
    ambient: { color: "#3A4A6B", intensity: 0.35 },
    lights: [
      { id: "L1", x: 64, y: 64, radius: 100, color: "#FFC978", intensity: 1,
        type: "point", falloff: 2, shadow: true },
      { id: "L2", x: 200, y: 40, radius: 120, color: "#80CCFF", intensity: 0.8,
        type: "spot", angle: 60, dir: 135, coneSoft: 10, falloff: 2, shadow: false },
    ],
    occluders: [{ x: 96, y: 64, hw: 8, hh: 32 }],
    sampleWorld: [
      // ① L1 灯心：饱和（重叠光会把通道顶到 255，只断言"接近饱和"用 >200 的柔性判据在测试里做）
      [64, 64],
      // ② L1 半径内、无遮挡：t≈0.20 附近，衰减值精确可比
      [80, 52],
      // ③ L1 半径边缘：距 100 → t=1，贡献必须为 0（只剩环境光）
      [164, 64],
      // ④ 从上绕过墙：射线在 x∈[88,104] 段都在墙顶(y=32)之上 → 照到
      [92, 8],
      // ⑤ 穿过墙：射线在 x∈[88,104] 段落在 y∈[32,96] → 被挡，只剩环境光
      [120, 64],
      // ⑥ 从下方穿墙：同理被挡
      [92, 96],
      // ⑦ L2 锥内（dir=135°，该点在灯右下方约 18°）→ 有蓝光
      [170, 72],
      // ⑧ L2 锥外（灯左上方，diff≈142°）→ 无
      [230, 20],
      // ⑨ 两盏都照不到（右远角）→ 只有环境光
      [250, 180],
      // ⑩ 左下角地板：只有环境光（最容易两处走样的"暗底"值）
      [2, 186],
      // ⑪ L1 半径内、但刚好在墙左边缘外侧（x=86 <88）→ 照到且不被挡
      [86, 70],
      // ⑫ 距 L1 = sqrt(120²+40²)=126 > 100 且在 L2 锥外（diff≈122°）→ 只剩环境光
      [184, 104],
    ],
  };
}

/** 第二个 case：只有环境光（校验"暗底"的精确值，最容易两处走样）。 */
function buildAmbientOnlyCase() {
  return {
    name: "ambientOnly",
    note: "没有光源：整张图 = 环境光，逐点必须完全一致",
    version: 1,
    width: 64,
    height: 64,
    texelsPerPixel: 1,
    softness: 0,
    ambient: { color: "#3A4A6B", intensity: 0.42 },
    lights: [],
    occluders: [],
    sampleWorld: [[2, 2], [32, 32], [61, 61]],
  };
}

/** 第三个 case：采样率缩放（大图 + 小 s，校验 texW/texH 截断与 sEff 反推）。 */
function buildScaleCase() {
  return {
    name: "scale",
    note: "1024x768 @ 0.25 = 256x192；用于校验尺寸截断与 sEff",
    version: 1,
    width: 1024,
    height: 768,
    texelsPerPixel: 0.25,
    softness: 0,
    ambient: { color: "#101820", intensity: 0.5 },
    lights: [
      { id: "S1", x: 512, y: 384, radius: 400, color: "#FFFFFF", intensity: 1, type: "point", falloff: 2, shadow: false },
    ],
    occluders: [],
    sampleWorld: [[512, 384], [2, 2], [1021, 766]],
  };
}

/** 把一个 case 算成带 expect 的完整 fixture 项。 */
function materialize(c) {
  const { texW, texH, sEff, rgb } = bakeCase(c);
  const blurred = blurRgb(rgb, texW, texH, c.softness * sEff);
  const samples = c.sampleWorld.map(([wx, wy]) => {
    // 世界坐标 → 纹素下标（契约 §2.1：纹素中心在世界 (i+0.5)/sEff）
    const i = Math.max(0, Math.min(texW - 1, Math.floor(wx * sEff)));
    const j = Math.max(0, Math.min(texH - 1, Math.floor(wy * sEff)));
    const o = (j * texW + i) * 3;
    // 第 4 位恒 255（不透明），显式写出来免得两边猜
    return {
      i,
      j,
      world: [wx, wy],
      expect: [toByte(blurred[o]), toByte(blurred[o + 1]), toByte(blurred[o + 2]), 255],
    };
  });
  return {
    name: c.name,
    note: c.note,
    version: c.version,
    width: c.width,
    height: c.height,
    texelsPerPixel: c.texelsPerPixel,
    softness: c.softness,
    ambient: c.ambient,
    lights: c.lights,
    occluders: c.occluders,
    expect: { texW, texH, sEff },
    samples,
  };
}

function main() {
  const args = process.argv.slice(2);
  const print = args.includes("--print");
  let out = DEFAULT_OUT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = resolve(args[++i] ?? DEFAULT_OUT);
  }

  const cases = [buildMainCase(), buildAmbientOnlyCase(), buildScaleCase()].map(materialize);

  // 能量统计：模糊后的总能量（供性质断言用：两遍模糊应守恒 ±1%）
  const stats = [];
  for (const c of cases) {
    const { texW, texH, sEff, rgb } = bakeCase(c);
    const blurred = blurRgb(rgb, texW, texH, c.softness * sEff);
    let sumRaw = 0;
    let sumBlur = 0;
    for (let k = 0; k < rgb.length; k++) {
      sumRaw += rgb[k];
      sumBlur += blurred[k];
    }
    stats.push({
      name: c.name,
      texW,
      texH,
      sEff,
      sumRaw: Number(sumRaw.toFixed(4)),
      sumBlurred: Number(sumBlur.toFixed(4)),
    });
  }

  const fixture = {
    $comment:
      "2D 光照烘焙仲裁 fixture。由 web/tools/gen-lighting-fixture.mjs 生成，勿手改。" +
      "expect 的每个分量是 0..255 整数 RGB；alpha 恒 255（不透明）。容差：每通道 <= 2。",
    contract: "docs/_fragments/lighting-contract.md",
    cases,
    stats,
  };

  const text = JSON.stringify(fixture, null, 4) + "\n";
  if (print) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text, "utf8");
  console.log(`已写入 ${out}`);
  for (const c of cases) {
    console.log(`  case ${c.name}: tex ${c.expect.texW}x${c.expect.texH} sEff=${c.expect.sEff} samples=${c.samples.length}`);
    for (const s of c.samples) {
      console.log(`    (${s.i},${s.j}) = ${s.expect.join(",")}`);
    }
  }
}

main();
