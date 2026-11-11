/**
 * 孤胆枪手示例 · 环境美术（地面瓦片 / 墙体 / 道具 / 拾取物），全部程序生成、逐字节确定。
 *
 * 视角：静态道具用 3/4 "斜俯视"（顶面 + 下方几像素正面），光从左上来；场景是夜晚，
 * 引擎还会再压暗，所以底色取中暗但仍可辨认的值。
 *
 * 地面瓦片的无缝做法：
 *   - 同一类型的所有变体共用一张"底场"（可平铺的 valueNoise，周期 = 32px），
 *     变体差异只乘一个"内部窗"（离边 ≤2px 时为 0）叠加进去，所以任意两块同类瓦片拼接处像素一致；
 *   - 颜色只取少量色阶，用 BAYER4 有序抖动过渡（不用逐像素随机噪点），PNG 压得小、看起来也"像素画"。
 */
import { rng, BAYER4, valueNoise, col, mix, shade, Canvas, atlasOf } from "./px.mjs";

const OUT = "#0d0f0c";
const T = 32;

// ---------------------------------------------------------------- 小工具

function bay(x, y) {
  return BAYER4[((y % 4) + 4) % 4][((x % 4) + 4) % 4];
}

/**
 * 有序抖动量化：t 为"色阶坐标"（0..n-1 之间的小数），返回色阶下标。
 * soft=1 时整段小数都抖动；soft 越小，只在接近半格处抖动（色块更平、更省字节）。
 */
function q(t, x, y, n, soft = 1) {
  const fl = Math.floor(t);
  const th = 0.5 + (bay(x, y) + 1 / 32 - 0.5) * soft;
  const i = fl + (t - fl > th ? 1 : 0);
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/** 32px 周期的分形值噪声（返回约 0..1，均值 0.5）。 */
function tnoise(seed, periods = [4, 8], weights = [0.65, 0.35], size = T) {
  const fs = periods.map((p, i) => valueNoise(seed * 31 + i * 7919 + 1, p));
  const wsum = weights.reduce((a, b) => a + b, 0);
  return (x, y) => {
    let v = 0;
    for (let i = 0; i < fs.length; i++) v += weights[i] * fs[i]((x * periods[i]) / size, (y * periods[i]) / size);
    return v / wsum;
  };
}

/** 内部窗：离瓦片边 ≤ inner 像素时为 0，往里 ramp 像素内升到 1。 */
function win(x, y, inner = 2, ramp = 6) {
  const d = Math.min(x, T - 1 - x, y, T - 1 - y);
  return Math.max(0, Math.min(1, (d - inner) / ramp));
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 用底场 + 变体场填一块地面瓦片。变体场先减去自己在窗内的加权均值，
 * 这样同类各变体的整体亮度一致，拼起来不会出现棋盘格。
 */
function fillGround(pal, center, spread, base, vn, amp, soft) {
  let m = 0.5;
  if (vn) {
    let s = 0;
    let ws = 0;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const w = win(x, y, 1, 4);
        s += w * vn(x, y);
        ws += w;
      }
    }
    m = s / ws;
  }
  const c = new Canvas(T, T);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      // 底场只给弱起伏（所有变体共享、决定边缘），主要的色斑来自变体场 → 拼图时 32px 周期感更弱
      const n = 0.5 + (base(x, y) - 0.5) * BASE_K + (vn ? win(x, y, 1, 4) * (vn(x, y) - m) * amp : 0);
      c.set(x, y, pal[q(center + (n - 0.5) * spread, x, y, pal.length, soft)]);
    }
  }
  return c;
}

/** 共享底场的相对强度（相对 spread）。 */
const BASE_K = 0.45;

/**
 * 画裂缝：paths = [[[x,y],...], ...]。w=2 时按每段走向加粗（陡段向右、缓段向下）。
 * edge：裂缝左/上侧 1px 的"崩口"亮色（按 Bayer 阈值 edgeChance 取舍，看起来是碎的）。
 */
function paintCrack(c, paths, { w = 1, dark, edge, edgeChance = 1, shadow = null }) {
  const mark = new Uint8Array(c.w * c.h);
  const put = (x, y) => {
    if (x >= 0 && y >= 0 && x < c.w && y < c.h) mark[y * c.w + x] = 1;
  };
  for (const p of paths) {
    for (let i = 0; i + 1 < p.length; i++) {
      const [x0, y0] = p[i];
      const [x1, y1] = p[i + 1];
      const steep = Math.abs(y1 - y0) >= Math.abs(x1 - x0);
      const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) + 1;
      for (let k = 0; k <= n; k++) {
        const x = Math.round(x0 + ((x1 - x0) * k) / n);
        const y = Math.round(y0 + ((y1 - y0) * k) / n);
        put(x, y);
        if (w >= 2) put(steep ? x + 1 : x, steep ? y : y + 1);
      }
    }
  }
  const is = (x, y) => x >= 0 && y >= 0 && x < c.w && y < c.h && mark[y * c.w + x] === 1;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      if (!is(x, y)) continue;
      for (const [nx, ny] of [
        [x - 1, y],
        [x, y - 1]
      ]) {
        if (!is(nx, ny) && nx >= 0 && ny >= 0 && bay(nx, ny) < edgeChance) c.set(nx, ny, edge);
      }
      if (shadow) {
        for (const [nx, ny] of [
          [x + 1, y],
          [x, y + 1]
        ]) {
          // 不碰最外一圈，保证与无裂缝版本的边缘一致（可混排平铺）
          if (!is(nx, ny) && nx < c.w - 1 && ny < c.h - 1 && bay(nx, ny) < 0.5) c.set(nx, ny, shadow);
        }
      }
    }
  }
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) if (is(x, y)) c.set(x, y, dark);
}

/** 小卵石：亮点 + 右下阴影。 */
function pebbles(c, seed, count, lite, dark, lo = 4, hi = 27) {
  const r = rng(seed);
  for (let k = 0; k < count; k++) {
    const x = lo + Math.floor(r() * (hi - lo));
    const y = lo + Math.floor(r() * (hi - lo));
    c.set(x, y, lite);
    c.set(x + 1, y + 1, dark);
    if (r() < 0.4) {
      c.set(x + 1, y, lite);
      c.set(x + 2, y + 1, dark);
    }
  }
}

// ---------------------------------------------------------------- 地面

/** 地面用的低频噪声周期（每块瓦片 2 / 4 个格点）：大块色斑，PNG 更小。 */
const GP = [2, 4];
const CON = ["#2f3235", "#34373a", "#3a3d40", "#44474a"];
const conBase = tnoise(21, [4, 8], [0.6, 0.4]);

function groundGrass() {
  const pal = ["#1e2a19", "#26331f", "#2e3d24", "#3a4a2c"];
  const base = tnoise(11, [4, 8]);
  return [0, 1, 2].map((v) => {
    const c = fillGround(pal, 1.5, 4.2, base, tnoise(40 + v, GP), 1.2, 0.4);
    const r = rng(900 + v);
    const count = 4 + (v % 2);
    for (let k = 0; k < count; k++) {
      const bx = 5 + Math.floor(r() * 22);
      const by = 6 + Math.floor(r() * 20);
      // 小草簇：V 形两片叶尖 + 根部暗点
      c.set(bx, by + 1, "#1e2a19");
      c.set(bx, by, "#435433");
      c.set(bx - 1, by - 1, "#536640");
      if (r() < 0.6) c.set(bx + 1, by - 1, "#4b5c39");
    }
    return c;
  });
}

function groundGrassDark() {
  const pal = ["#151d12", "#1a2416", "#1e2a19", "#26331f"];
  const base = tnoise(12, [4, 8], [0.55, 0.45]);
  return [0, 1].map((v) => {
    const c = fillGround(pal, 1.4, 4.6, base, tnoise(50 + v, GP), 1.3, 0.45);
    const r = rng(950 + v);
    for (let k = 0; k < 7; k++) {
      const bx = 5 + Math.floor(r() * 22);
      const by = 6 + Math.floor(r() * 20);
      if (k % 3 === 0) {
        // 少量偏亮的叶片
        c.set(bx, by, "#2e3d24");
        c.set(bx + 1, by - 1, "#34442a");
      } else {
        // 深色乱草簇
        c.set(bx, by, "#10170e");
        c.set(bx - 1, by - 1, "#10170e");
        c.set(bx + 1, by - 1, "#141c11");
        c.set(bx, by - 2, "#26331f");
      }
    }
    return c;
  });
}

function groundConcrete() {
  return [0, 1, 2].map((v) => {
    const c = fillGround(CON, 1.7, 3.6, conBase, tnoise(60 + v, GP), 1.0, 0.35);
    pebbles(c, 300 + v, v === 0 ? 7 : 5, "#4e5154", "#2a2d30");
    if (v === 1) {
      paintCrack(
        c,
        [
          [
            [5, 9],
            [9, 11],
            [12, 10],
            [15, 14],
            [19, 15],
            [22, 19],
            [26, 21]
          ],
          [
            [15, 14],
            [14, 18],
            [16, 22]
          ]
        ],
        { w: 1, dark: "#232528", edge: "#4a4d50", edgeChance: 0.5 }
      );
    }
    if (v === 2) {
      // 油渍：噪声扰动边界的暗斑 + 少量偏紫的油光
      const on = valueNoise(77, 8);
      for (let y = 6; y < 26; y++) {
        for (let x = 6; x < 26; x++) {
          const dx = (x + 0.5 - 16.5) / 7.5;
          const dy = (y + 0.5 - 16) / 5.5;
          const d = dx * dx + dy * dy;
          const thr = 1 + (on(x / 3, y / 3) - 0.5) * 0.9;
          if (d < thr * 0.5) c.set(x, y, "#232529");
          else if (d < thr && bay(x, y) < 0.75) c.set(x, y, "#2a2c30");
        }
      }
      for (const [x, y] of [
        [14, 14],
        [15, 14],
        [18, 17],
        [13, 16]
      ])
        c.set(x, y, "#34354a");
    }
    return c;
  });
}

function groundMetal() {
  const plate = ["#464b51", "#4a4f55", "#4e5359"];
  const base = tnoise(31, GP, [0.6, 0.4]);
  return [0, 1].map((v) => {
    const c = fillGround(plate, 1.0, 2.2, base, v === 1 ? tnoise(70, GP) : null, 1.4, 0.3);
    // 菱形防滑纹：8px 周期，两种朝向交错的小凸起（亮 2px + 右下 1px 影）
    for (let y = 3; y < 29; y++) {
      for (let x = 3; x < 29; x++) {
        const mx = x % 8;
        const my = y % 8;
        if ((mx === 1 && my === 1) || (mx === 2 && my === 2)) c.set(x, y, "#565c63");
        else if (mx === 3 && my === 2) c.set(x, y, "#40454b");
        else if ((mx === 6 && my === 5) || (mx === 5 && my === 6)) c.set(x, y, "#565c63");
        else if (mx === 6 && my === 6) c.set(x, y, "#40454b");
      }
    }
    if (v === 1) {
      // 磨损：一块偏亮的蹭痕 + 一处油污
      const wn = tnoise(71, GP, [0.5, 0.5]);
      for (let y = 4; y < 28; y++) {
        for (let x = 4; x < 28; x++) {
          const ww = win(x, y, 3, 4);
          if (ww <= 0) continue;
          // 实心色块 + 只在边界 0.04 宽的带里做抖动过渡（大面积 50% 棋盘格太"噪"）
          const w = wn(x, y) + (bay(x, y) - 0.5) * 0.08;
          if (w > 0.64 && ww > 0.5) c.set(x, y, "#52575d");
          else if (w < 0.3 && ww > 0.5) c.set(x, y, "#43474d");
        }
      }
    }
    // 板缝：左/上 1px 深缝，紧挨着 1px 高光；右/下 1px 背光 —— 拼起来是凹进去的槽
    for (let i = 0; i < T; i++) {
      c.set(i, 31, "#3d4247");
      c.set(31, i, "#3d4247");
    }
    for (let i = 1; i < T; i++) {
      c.set(i, 1, "#5a6067");
      c.set(1, i, "#5a6067");
    }
    for (let i = 0; i < T; i++) {
      c.set(i, 0, "#2a2e33");
      c.set(0, i, "#2a2e33");
    }
    // 四角铆钉
    for (const [rx, ry] of [
      [3, 3],
      [27, 3],
      [3, 27],
      [27, 27]
    ]) {
      if (v === 1 && rx === 27 && ry === 3) {
        // 掉了一颗：只剩孔
        c.set(rx, ry, "#2e3237");
        c.set(rx + 1, ry, "#3d4247");
        continue;
      }
      c.set(rx, ry, "#7d838a");
      c.set(rx + 1, ry, "#62686f");
      c.set(rx, ry + 1, "#62686f");
      c.set(rx + 1, ry + 1, "#2e3237");
      c.set(rx + 2, ry + 1, "#3d4247");
      c.set(rx + 1, ry + 2, "#3d4247");
    }
    return c;
  });
}

function groundDirt() {
  const pal = ["#362b20", "#3e3226", "#4a3c2c", "#56463a"];
  const base = tnoise(41, [4, 8], [0.6, 0.4]);
  return [0, 1].map((v) => {
    const c = fillGround(pal, 1.9, 4.0, base, tnoise(80 + v, GP), 1.2, 0.4);
    pebbles(c, 400 + v, v === 0 ? 5 : 7, "#6a5a48", "#2e251b");
    if (v === 1) {
      // 两个模糊的靴印
      for (const [fx, fy] of [
        [11, 12],
        [18, 19]
      ]) {
        c.ellipse(fx, fy, 1.6, 2.4, "#362b20");
        c.set(Math.floor(fx) - 1, fy - 3, "#3e3226");
      }
    }
    return c;
  });
}

function groundLane() {
  const c = fillGround(CON, 1.7, 3.6, conBase, tnoise(65, GP), 1.0, 0.35);
  pebbles(c, 333, 3, "#4e5154", "#2a2d30", 4, 11);
  const wn = tnoise(66, [8, 16], [0.6, 0.4]);
  for (let x = 0; x < T; x++) {
    for (let y = 15; y <= 17; y++) {
      const edgeWear = y === 16 ? 0 : 0.08;
      // 磨损只出现在瓦片内部（离左右边 ≥3px），边上的漆总是完整的 → 线条跨瓦片连续
      const inner = Math.max(0, Math.min(1, (Math.min(x, T - 1 - x) - 2) / 3));
      const w = 1 - inner + inner * (wn(x, y) + (bay(x, y) - 0.5) * 0.3 - edgeWear);
      if (w < 0.3) continue; // 漆掉了，露出沥青
      c.set(x, y, w < 0.42 ? "#8a7428" : "#b89a2a");
    }
  }
  return [c];
}

// ---------------------------------------------------------------- 墙 / 地块类 IMAGE（需平铺，无描边）

function wallPerimeter() {
  const c = new Canvas(T, T);
  const n = tnoise(301, [4, 8], [0.6, 0.4]);
  const top = ["#5f6265", "#6a6d70", "#74777a"];
  const front = ["#383b3e", "#3e4144", "#44474a"];
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      let cc;
      if (y <= 1) cc = "#85888b";
      else if (y <= 22) cc = top[q(1 + (n(x, y) - 0.5) * 3, x, y, 3, 0.6)];
      else if (y === 23) cc = "#7a7d80";
      else if (y <= 30) cc = front[q(1 + (n(x, y) - 0.5) * 3, x, y, 3, 0.6)];
      else cc = "#1f2123";
      c.set(x, y, cc);
    }
  }
  // 板缝：x=0 一列略暗（顶面 / 高光 / 正面各自压暗）
  for (let y = 0; y < 31; y++) {
    const cc = y <= 1 ? "#6e7174" : y <= 22 ? "#585b5e" : y === 23 ? "#66696c" : "#2e3134";
    c.set(0, y, cc);
  }
  // 顶面上零星的气孔
  const r = rng(302);
  for (let k = 0; k < 6; k++) c.set(3 + Math.floor(r() * 26), 4 + Math.floor(r() * 17), "#55585b");
  return c;
}

function fenceChain() {
  const c = new Canvas(T, T);
  const mesh = col("#8a9096");
  for (let y = 5; y <= 26; y++) {
    for (let x = 0; x < T; x++) {
      if ((x + y) % 8 === 0 || (((x - y) % 8) + 8) % 8 === 0) c.set(x, y, [mesh[0], mesh[1], mesh[2], 200]);
    }
  }
  // 上/下拉线
  for (let x = 0; x < T; x++) {
    c.set(x, 4, "#9aa0a6e6");
    c.set(x, 27, "#7a8086dc");
  }
  // 立柱 x=0..2（左暗边、中亮、右背光），x=3 描边，顶/底各一行描边
  for (let y = 2; y <= 29; y++) {
    c.set(0, y, "#3e4246");
    c.set(1, y, "#747a80");
    c.set(2, y, "#5a5f64");
    c.set(3, y, OUT);
  }
  for (let x = 0; x <= 3; x++) {
    c.set(x, 1, OUT);
    c.set(x, 30, OUT);
  }
  c.set(1, 2, "#8e949a");
  // 立柱在地上的一小块影子
  c.set(4, 30, "#00000050");
  c.set(4, 29, "#00000040");
  return c;
}

function brickWall(cracked) {
  const c = new Canvas(T, T);
  const n = tnoise(311, [4, 8], [0.5, 0.5]);
  const bricks = ["#4a3a32", "#5a4a40", "#524138"];
  const hiOf = { "#4a3a32": "#57463c", "#5a4a40": "#67564a", "#524138": "#5f4d42" };
  const r = rng(312);
  const pick = [];
  for (let i = 0; i < 64; i++) pick.push(bricks[Math.floor(r() * 3)]);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      let cc;
      if (y === 0) cc = "#86817a";
      else if (y === 1) cc = "#726d66";
      else if (y === 2) cc = "#4e4943";
      else {
        const yy = y - 3;
        const course = Math.floor(yy / 4);
        const within = yy % 4;
        const off = course % 2 === 0 ? 0 : 4;
        const bx = (((x - off) % T) + T) % T;
        if (within === 0 || bx % 8 === 0) cc = "#3a2c26";
        else {
          const id = course * 4 + Math.floor(bx / 8);
          const bc = pick[id];
          cc = within === 1 ? hiOf[bc] : bc;
          // 风化：低频噪声 + Bayer → 局部压暗
          if (n(x, y) + (bay(x, y) - 0.5) * 0.25 < 0.36) cc = "#3f312a";
          if (within === 3 && bay(x, y) < 0.3) cc = "#3f312a";
        }
      }
      c.set(x, y, cc);
    }
  }
  // 压顶上的气孔
  for (const [x, y] of [
    [6, 1],
    [19, 1],
    [27, 0]
  ])
    c.set(x, y, "#615c56");
  if (cracked) {
    // 大"人"字形裂缝：顶点在压顶下方中间，两腿叉到底边
    paintCrack(
      c,
      [
        [
          [16, 3],
          [14, 8],
          [15, 11],
          [11, 16],
          [10, 21],
          [6, 25],
          [3, 30]
        ],
        [
          [14, 9],
          [18, 13],
          [17, 17],
          [21, 21],
          [24, 25],
          [27, 30]
        ],
        [
          [11, 16],
          [7, 15]
        ],
        [
          [21, 21],
          [25, 20]
        ],
        [
          [10, 21],
          [12, 24]
        ]
      ],
      { w: 2, dark: "#120c0a", edge: "#7d6858", edgeChance: 0.8, shadow: "#2a1e1a" }
    );
    // 压顶上的崩口
    c.set(15, 2, "#120c0a");
    c.set(16, 2, "#120c0a");
    c.set(14, 2, "#9a948c");
    c.set(17, 1, "#9a948c");
    // 裂缝旁掉落的碎屑
    for (const [x, y] of [
      [5, 28],
      [8, 27],
      [26, 28],
      [23, 29]
    ])
      c.set(x, y, "#7d6858");
  }
  return c;
}

function roofTar() {
  const c = new Canvas(T, T);
  const n = tnoise(321, [4, 8], [0.6, 0.4]);
  const pal = ["#2a2c2f", "#2e3033", "#35383b"];
  const r = rng(322);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      let cc = pal[q(1.1 + (n(x, y) - 0.5) * 3, x, y, 3, 0.7)];
      const s = r();
      if (s < 0.045) cc = "#45484b";
      else if (s < 0.07) cc = "#232528";
      c.set(x, y, cc);
    }
  }
  for (let x = 0; x < T; x++) {
    c.set(x, 15, "#27292c");
    if (bay(x, 16) < 0.75) c.set(x, 16, "#383b3e");
  }
  return c;
}

function gateSteel() {
  const c = new Canvas(T, T);
  const n = tnoise(331, [4, 8], [0.6, 0.4]);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const m = x % 8;
      let cc = m === 2 ? "#6e747b" : m === 3 ? "#62686e" : m === 4 ? "#3e4247" : "#555a60";
      if (y === 0) cc = "#7a8087";
      else if (y === 1) cc = "#454a50";
      else if (y === 11 || y === 20) cc = "#2a2d31";
      else if (y >= 12 && y <= 19) {
        const yellow = ((x + y) & 7) < 4;
        cc = yellow ? "#c9a21e" : "#1a1a1a";
        if (yellow && n(x, y) + (bay(x, y) - 0.5) * 0.3 < 0.34) cc = "#8f7418";
      } else if (y >= 28 && y <= 30) cc = m === 4 ? "#2e3236" : "#3a3e43";
      else if (y === 31) cc = "#1e2023";
      c.set(x, y, cc);
    }
  }
  return c;
}

// ---------------------------------------------------------------- 道具（有描边）

function crate() {
  const c = new Canvas(28, 28);
  const L = "#bf9658";
  const A = "#a7814c";
  const B = "#8c6a3e";
  const D = "#6b4a2a";
  const K = "#3e2a16";
  const n = valueNoise(341, 8);
  // 顶面内区：横向木板
  for (let y = 4; y <= 16; y++) {
    for (let x = 4; x <= 23; x++) {
      let cc = y === 8 || y === 12 ? D : B;
      if (cc === B && n(x / 2.5, y * 1.5) + (bay(x, y) - 0.5) * 0.3 < 0.3) cc = "#7d5d35";
      if (x === 4 || y === 4) cc = D; // 外框压出来的阴影
      c.set(x, y, cc);
    }
  }
  // X 斜撑（"\" 压在 "/" 上面）
  const brace = (x0, y0, x1, y1) => {
    const vx = x1 - x0;
    const vy = y1 - y0;
    const len = Math.hypot(vx, vy);
    for (let y = 4; y <= 16; y++) {
      for (let x = 4; x <= 23; x++) {
        const px = x + 0.5 - x0;
        const py = y + 0.5 - y0;
        const d = (px * vy - py * vx) / len; // 有符号距离（>0 在线的下方/左侧取决于方向）
        const t = (px * vx + py * vy) / (len * len);
        if (t < -0.02 || t > 1.02) continue;
        const ad = Math.abs(d);
        // 朝左上（光源）一侧的棱是亮边，另一侧是投影
        const lit = d * (vx - vy) > 0;
        if (ad <= 1.0) c.set(x, y, A);
        else if (ad <= 1.8) c.set(x, y, lit ? L : "#5a3c20");
      }
    }
  };
  brace(23.9, 4, 4.1, 17);
  brace(4.1, 4, 23.9, 17);
  // 外框：上/左亮，下/右暗
  for (let y = 1; y <= 19; y++) {
    for (let x = 1; x <= 26; x++) {
      if (x >= 4 && x <= 23 && y >= 4 && y <= 16) continue;
      let cc = A;
      if (y === 1 || x === 1) cc = L;
      else if (y >= 17 || x >= 24) cc = y === 19 || x === 26 ? D : "#987443";
      c.set(x, y, cc);
    }
  }
  // 框角钉子
  for (const [x, y] of [
    [2, 2],
    [25, 2],
    [2, 18],
    [25, 18],
    [13, 2],
    [13, 18]
  ])
    c.set(x, y, K);
  // 正面（7 行）：两侧立柱 + 两块横板（中间一道深缝、木纹两三处）
  for (let y = 20; y <= 26; y++) {
    for (let x = 1; x <= 26; x++) {
      let cc = D;
      if (x <= 3 || x >= 24) cc = x === 1 ? A : x >= 25 ? D : B;
      else if (y === 23) cc = K;
      else if (y === 20) cc = "#7a5632";
      else if ((y === 22 && (x === 8 || x === 17)) || (y === 25 && x === 12)) cc = "#5a3c20";
      if (y === 26) cc = K;
      c.set(x, y, cc);
    }
  }
  // 顶面木板的端缝（错开）
  for (const [x, y0] of [
    [10, 5],
    [18, 9],
    [8, 13]
  ]) {
    for (let y = y0; y < y0 + 3; y++) if (c.get(x, y)[0] === 0x8c || c.get(x, y)[0] === 0x7d) c.set(x, y, D);
  }
  c.set(2, 21, K);
  c.set(25, 21, K);
  c.set(2, 25, K);
  c.set(25, 25, K);
  c.outline(OUT);
  return c;
}

function barrel() {
  const c = new Canvas(20, 24);
  const cx = 10;
  const rx = 8.5;
  const ry = 3.5;
  const lidY = 5.5;
  const botY = 19;
  // 桶身
  for (let y = 5; y <= 23; y++) {
    for (let x = 0; x < 20; x++) {
      const u = (x + 0.5 - cx) / rx;
      if (Math.abs(u) > 1) continue;
      const cv = Math.sqrt(1 - u * u);
      const bottom = botY + ry * cv;
      if (y + 0.5 > bottom) continue;
      let cc = u < -0.62 ? "#c23a28" : u < -0.3 ? "#d84a32" : u < 0.42 ? "#b0281e" : u < 0.74 ? "#8a1c14" : "#6a120c";
      if (u > -0.6 && u <= -0.46) cc = "#ee7a5c"; // 竖向高光
      const yy = Math.floor(y + 0.5 - ry * cv); // 拉直正面弧度后的"高度"
      for (const rib of [7, 16]) {
        if (yy === rib) cc = u < -0.3 ? "#ee7a5c" : u < 0.42 ? "#d84a32" : "#a0261c";
        if (yy === rib + 1) cc = "#6a120c";
      }
      if (y + 1.5 > bottom) cc = "#4e0c08";
      c.set(x, y, cc);
    }
  }
  // 危险品菱形标签：白边、黄底、暗红火苗
  const lx = 10;
  const ly = 15;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const m = Math.abs(dx) + Math.abs(dy);
      if (m > 3) continue;
      c.set(lx + dx - 1, ly + dy, m === 3 ? "#f0ece0" : "#e8b830");
    }
  }
  for (const [dx, dy] of [
    [0, -2],
    [1, -1],
    [0, -1],
    [-1, 0],
    [0, 0],
    [1, 0],
    [0, 1]
  ])
    c.set(lx + dx - 1, ly + dy, "#5a0c08");
  // 桶盖：外圈 rim + 凹进去的盖面
  for (let y = 0; y <= 11; y++) {
    for (let x = 0; x < 20; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - lidY) / ry;
      if (dx * dx + dy * dy > 1) continue;
      const ix = (x + 0.5 - cx) / 6.6;
      const iy = (y + 0.5 - lidY) / 2.5;
      const inner = ix * ix + iy * iy <= 1;
      let cc;
      if (inner) {
        const sx = (x + 0.5 - cx - 1) / 6.6;
        const sy = (y + 0.5 - lidY - 0.8) / 2.5;
        cc = sx * sx + sy * sy > 1 ? "#5a0e08" : "#8a1c14";
      } else {
        cc = dx + dy * 0.8 < -0.35 ? "#ee7a5c" : dx + dy < 0.6 ? "#c43a28" : "#8a1c14";
      }
      c.set(x, y, cc);
    }
  }
  // 加注口 + 小气孔
  c.set(13, 5, "#3e0806");
  c.set(14, 5, "#3e0806");
  c.set(13, 4, "#d84a32");
  c.set(14, 4, "#a0261c");
  c.set(6, 5, "#3e0806");
  c.outline(OUT);
  return c;
}

function gasCylinders() {
  const W = 24;
  const H = 28;
  const part = (cx, top, bottom) => {
    const c = new Canvas(W, H);
    const rx = 4;
    for (let y = top; y <= bottom + 2; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5 - cx) / rx;
        if (Math.abs(u) > 1) continue;
        const cv = Math.sqrt(1 - u * u);
        const domeTop = top + 3 - 3 * cv;
        const bot = bottom + 1.5 * cv;
        if (y + 0.5 < domeTop || y + 0.5 > bot) continue;
        let cc;
        if (y < top + 5) {
          // 红色瓶肩
          cc = u < -0.35 ? "#e04a38" : u < 0.45 ? "#c02018" : "#801008";
          if (y + 0.5 - domeTop < 1 && u < 0.2) cc = "#f0705a";
        } else {
          cc = u < -0.62 ? "#e2dcbc" : u < -0.25 ? "#f0ead0" : u < 0.45 ? "#d8d2b0" : u < 0.8 ? "#a8a284" : "#7e7962";
          if (y === top + 5) cc = "#8a8466"; // 瓶肩下的环线
          if (y + 1.5 > bot) cc = "#6e6a55";
        }
        c.set(x, y, cc);
      }
    }
    // 阀门
    c.set(Math.floor(cx) - 1, top - 1, "#8a8a8a");
    c.set(Math.floor(cx), top - 1, "#4a4a4a");
    c.set(Math.floor(cx) - 1, top, "#5a5a5a");
    c.set(Math.floor(cx), top, "#3a3a3a");
    c.set(Math.floor(cx) + 1, top, "#3a3a3a");
    c.outline(OUT);
    return c;
  };
  const c = new Canvas(W, H);
  c.draw(part(5, 3, 21), 0, 0);
  c.draw(part(19, 3, 21), 0, 0);
  c.draw(part(12, 7, 25), 0, 0);
  // 捆瓶的铁链：一条下垂的链子，深/中灰交替表示链节
  for (let x = 1; x <= 22; x++) {
    const y = 14 + Math.round(1.6 * Math.sin((Math.PI * (x - 1)) / 21));
    if (c.alphaAt(x, y) < 128) continue;
    c.set(x, y, x % 2 === 0 ? "#1c1c1c" : "#5a5a5a");
    if (x % 2 === 1 && c.alphaAt(x, y + 1) >= 128) c.set(x, y + 1, "#2a2a2a");
  }
  return c;
}

function streetLamp() {
  const c = new Canvas(16, 16);
  c.circle(5.5, 10.5, 3.3, "#2a2c2e");
  c.set(4, 9, "#45484b");
  c.set(3, 10, "#3a3c3f");
  c.set(5, 9, "#3a3c3f");
  c.set(5, 10, "#3e4144");
  c.line(6, 9, 9, 6, "#3e4144");
  c.line(6, 10, 10, 6, "#2a2c2e");
  c.ellipse(10.5, 5.5, 3.3, 2.5, "#2a2c2e");
  c.set(9, 4, "#45484b");
  c.set(8, 5, "#3a3c3f");
  c.set(10, 5, "#ffe7a0");
  c.set(11, 5, "#ffe7a0");
  c.set(10, 6, "#e8c878");
  c.set(11, 6, "#ffe7a0");
  c.set(10, 5, "#fff8dc");
  c.outline(OUT);
  return c;
}

function arrowDecal() {
  const c = new Canvas(64, 32);
  const head = [
    [34, 1.5],
    [61.5, 16],
    [34, 30.5]
  ];
  const n1 = valueNoise(351, 16);
  const n2 = valueNoise(352, 16);
  const g = col("#4cd13a");
  const inShape = (x, y) => (x >= 3 && x <= 36 && y >= 11 && y <= 20) || pointIn(x + 0.5, y + 0.5, head);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 64; x++) {
      if (!inShape(x, y)) continue;
      const b = bay(x, y);
      // 少量成块剥落（低频噪声谷底）+ 谷底周围一圈抖动过渡
      const wv = n1(x / 5 + 2.3, y / 5 + 0.7);
      if (wv + (b - 0.5) * 0.1 < 0.11) continue;
      // 边缘毛糙
      const edge = !inShape(x - 1, y) || !inShape(x + 1, y) || !inShape(x, y - 1) || !inShape(x, y + 1);
      if (edge && b < 0.25 && n2(x / 3, y / 3) < 0.5) continue;
      // 漆层厚薄：150 / 190 / 230 三档，Bayer 抖动
      const t = clamp01((n2(x / 7, y / 7) - 0.25) / 0.55) * 2;
      const a = [150, 190, 230][q(t, x, y, 3, 1)];
      c.set(x, y, [g[0], g[1], g[2], a]);
    }
  }
  return c;
}

function pointIn(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function labEntrance() {
  const c = new Canvas(64, 64);
  // 金属外沿 1..3
  for (let y = 1; y <= 62; y++) {
    for (let x = 1; x <= 62; x++) {
      const d = Math.min(x - 1, y - 1, 62 - x, 62 - y);
      if (d > 2) continue;
      const topLeft = x - 1 === d || y - 1 === d;
      let cc = topLeft ? (d === 0 ? "#8a9097" : "#6a7077") : d === 0 ? "#2e3236" : "#3e4247";
      if (d === 1) cc = topLeft ? "#6a7077" : "#4a4e53";
      c.set(x, y, cc);
    }
  }
  // 警示条纹框 4..9
  for (let y = 4; y <= 59; y++) {
    for (let x = 4; x <= 59; x++) {
      const d = Math.min(x - 4, y - 4, 59 - x, 59 - y);
      if (d > 5) continue;
      c.set(x, y, ((x + y) >> 2) & 1 ? "#c9a21e" : "#1a1a1a");
    }
  }
  // 内沿
  for (let i = 10; i <= 53; i++) {
    c.set(i, 10, "#202326");
    c.set(10, i, "#202326");
    c.set(i, 53, "#4a4e53");
    c.set(53, i, "#4a4e53");
  }
  // 洞口 11..52：往下的台阶，越深越黑
  const steps = ["#5a5f64", "#4a4f54", "#3d4145", "#313438", "#26282b", "#1c1d1f", "#131415", "#0b0b0c"];
  for (let y = 11; y <= 52; y++) {
    for (let x = 11; x <= 52; x++) {
      const k = Math.floor((y - 11) / 5);
      const r = (y - 11) % 5;
      let cc;
      if (k >= steps.length) cc = "#050506";
      else if (r === 4) cc = shade(steps[k], 0.55);
      else if (r === 0) cc = shade(steps[k], 1.18);
      else cc = steps[k];
      // 侧墙
      if (x <= 13) cc = shade(k < steps.length ? steps[k] : "#050506", 0.72);
      if (x >= 50) cc = shade(k < steps.length ? steps[k] : "#050506", 0.5);
      // 扶手
      if ((x === 15 || x === 48) && k < 6 && r !== 4) cc = mix("#7a8087", "#0b0b0c", k / 6);
      c.set(x, y, cc);
    }
  }
  // 顶边投下来的阴影（洞口上缘两行）
  for (let x = 11; x <= 52; x++) {
    c.set(x, 11, "#1a1c1e");
    if (bay(x, 12) < 0.5) c.set(x, 12, "#2a2c2f");
  }
  // 四角螺栓
  for (const [x, y] of [
    [2, 2],
    [60, 2],
    [2, 60],
    [60, 60]
  ]) {
    c.set(x, y, "#a0a6ad");
    c.set(x + 1, y + 1, "#26292c");
  }
  c.outline(OUT);
  for (let i = 0; i < 64; i++) {
    c.set(i, 0, OUT);
    c.set(i, 63, OUT);
    c.set(0, i, OUT);
    c.set(63, i, OUT);
  }
  return c;
}

function truck() {
  const c = new Canvas(64, 96);
  const OL = "#4a5a2a";
  const OLH = "#5c6e34";
  const OLD = "#3a4720";
  // 轮胎（先画，车身压在上面，只露出两侧 3px）
  for (const [y0, y1] of [
    [14, 28],
    [58, 72],
    [74, 88]
  ]) {
    for (let y = y0; y <= y1; y++) {
      for (const x0 of [4, 54]) {
        for (let x = x0; x < x0 + 6; x++) c.set(x, y, (y - y0) % 3 === 0 ? "#2e2f30" : "#18191a");
      }
    }
  }
  // 前保险杠 + 车灯
  c.rect(9, 2, 46, 4, "#2a2e22");
  c.rect(9, 2, 46, 1, "#3e4434");
  c.rect(11, 3, 3, 2, "#d8d4a0");
  c.rect(50, 3, 3, 2, "#d8d4a0");
  c.set(11, 3, "#fff8d0");
  c.set(50, 3, "#fff8d0");
  // 前翼子板（盖住前轮）
  c.rect(7, 11, 4, 18, OLD);
  c.rect(53, 11, 4, 18, OLD);
  c.rect(7, 11, 1, 18, OL);
  // 发动机盖
  for (let y = 6; y <= 19; y++) {
    for (let x = 10; x <= 53; x++) {
      let cc = x <= 13 ? OLH : x >= 50 ? OLD : OL;
      if (y === 6) cc = OLH;
      if ((y === 9 || y === 11 || y === 13) && x >= 24 && x <= 39) cc = "#323d1c";
      if (x === 31 || x === 32) cc = y === 6 ? OLH : "#56682f";
      c.set(x, y, cc);
    }
  }
  // 后视镜
  c.rect(5, 21, 4, 3, "#2a2e22");
  c.rect(55, 21, 4, 3, "#2a2e22");
  c.set(6, 22, "#4a5e6a");
  c.set(57, 22, "#3a4a55");
  // 挡风玻璃（斜面，能看到）
  for (let y = 20; y <= 26; y++) {
    for (let x = 11; x <= 52; x++) {
      let cc = "#1f2a33";
      if (x === 31 || x === 32 || x === 11 || x === 52) cc = "#2e3a1a";
      c.set(x, y, cc);
    }
  }
  c.line(15, 25, 19, 21, "#4a6272");
  c.line(17, 25, 20, 22, "#33454f");
  c.line(36, 25, 40, 21, "#4a6272");
  // 驾驶室顶
  for (let y = 27; y <= 40; y++) {
    for (let x = 11; x <= 52; x++) {
      let cc = x <= 13 || y === 27 ? OLH : x >= 50 ? OLD : "#4e5f2c";
      if (y === 40) cc = OLD;
      c.set(x, y, cc);
    }
  }
  // 顶部舱盖
  c.rect(26, 30, 12, 8, OLD);
  c.rect(27, 31, 10, 6, "#56682f");
  c.rect(27, 31, 10, 1, "#66793a");
  // 驾驶室后壁（朝南的立面，较暗）
  c.rect(13, 41, 38, 3, "#26301a");
  // 货厢帆布篷
  for (let y = 44; y <= 88; y++) {
    for (let x = 7; x <= 56; x++) {
      const u = (x + 0.5 - 32) / 25;
      let cc = u < -0.7 ? "#66773f" : u < -0.4 ? "#6a7c46" : u < 0.5 ? "#5a6a3a" : u < 0.82 ? "#46522c" : "#3a4524";
      const ry = (y - 44) % 8;
      if (ry === 4) cc = "#3e4826";
      else if (ry === 5) cc = shade(cc, 1.1);
      else if (ry === 3 && bay(x, y) < 0.5) cc = shade(cc, 0.9);
      if (x === 7 || x === 56) cc = "#3a4524";
      if (y === 44) cc = "#6a7c46";
      c.set(x, y, cc);
    }
  }
  // 两侧绑绳
  for (let y = 46; y <= 86; y += 4) {
    c.set(8, y, "#2e3618");
    c.set(55, y, "#2e3618");
  }
  // 后挡板（朝南的立面）
  for (let y = 89; y <= 93; y++) {
    for (let x = 7; x <= 56; x++) c.set(x, y, y === 89 ? "#4a5a2a" : y === 93 ? "#262e14" : "#3a4620");
  }
  c.rect(9, 90, 3, 2, "#a0261c");
  c.rect(52, 90, 3, 2, "#a0261c");
  c.set(9, 90, "#d84a32");
  c.set(52, 90, "#d84a32");
  c.rect(30, 93, 4, 2, "#222");
  c.outline(OUT);
  return c;
}

function sandbags() {
  const c = new Canvas(32, 16);
  const bag = (x0, y0, w, h) => {
    const cx = x0 + w / 2;
    const cy = y0 + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const u = (x + 0.5 - cx) / rx;
        const v = (y + 0.5 - cy) / ry;
        const s = u ** 4 + v ** 4;
        if (s > 1) continue;
        let cc = "#8a7a56";
        const L = -(u * 0.45 + v);
        if (L > 0.5) cc = "#a8966a";
        else if (L < -0.55 || s > 0.62) cc = "#5e5238";
        if (s > 0.62 && L > 0.5) cc = "#9a8a60";
        c.set(x, y, cc);
      }
    }
    // 两端扎口
    c.set(x0, Math.floor(cy), "#5e5238");
    c.set(x0 + w - 1, Math.floor(cy), "#4a4030");
    // 中间一道褶
    for (let x = x0 + 3; x < x0 + w - 3; x += 2) c.set(x, Math.floor(cy), "#7a6c4c");
  };
  bag(3, 1, 13, 8);
  bag(16, 1, 13, 8);
  bag(1, 6, 10, 9);
  bag(11, 6, 10, 9);
  bag(21, 6, 10, 9);
  c.outline(OUT);
  return c;
}

// ---------------------------------------------------------------- 拾取物

const DOLLAR3 = ["###", "#..", "###", "..#", "###"];
const DOLLAR5 = ["..#..", ".####", "#.#..", ".###.", "..#.#", "####.", "..#.."];

function glyph(c, x0, y0, rows, color) {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) if (row[i] === "#") c.set(x0 + i, y0 + j, color);
  });
}

function banknote(c, x0, y0, w = 14, h = 8, dollar = true) {
  c.rect(x0, y0, w, h, "#5aa04a");
  for (let x = x0; x < x0 + w; x++) {
    c.set(x, y0, "#3a7a32");
    c.set(x, y0 + h - 1, "#2e6228");
  }
  for (let y = y0; y < y0 + h; y++) {
    c.set(x0, y, "#3a7a32");
    c.set(x0 + w - 1, y, "#2e6228");
  }
  c.ellipse(x0 + w / 2, y0 + h / 2, 3, 2.4, "#8ad070");
  if (dollar) glyph(c, x0 + Math.floor(w / 2) - 1, y0 + Math.floor(h / 2) - 2, DOLLAR3, "#2e5a26");
}

function money() {
  const cells = [];
  // 0 单张
  let c = new Canvas(20, 16);
  banknote(c, 3, 4);
  c.outline(OUT);
  cells.push(c);
  // 1 一沓（3 张错开 + 纸腰封）
  c = new Canvas(20, 16);
  banknote(c, 4, 6, 14, 8, false);
  banknote(c, 3, 4, 14, 8, false);
  banknote(c, 2, 2, 14, 8);
  c.rect(12, 2, 2, 8, "#e8dca0");
  c.rect(13, 2, 1, 8, "#b8a870");
  c.outline(OUT);
  cells.push(c);
  // 2 大捆 + 金色 $
  c = new Canvas(20, 16);
  for (let y = 10; y <= 13; y++) {
    for (let x = 2; x <= 17; x++) c.set(x, y, y % 2 === 0 ? "#8ad070" : "#3e7e34");
  }
  for (let y = 10; y <= 13; y++) c.set(17, y, "#2e6228");
  banknote(c, 2, 2, 16, 8, false);
  // 金色 $：先在字形 8 邻域铺一圈深色"压印"描边，再画金色笔画 + 两个高光点
  const gx = 7;
  const gy = 2;
  DOLLAR5.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      if (row[i] !== "#") continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) c.set(gx + i + dx, gy + j + dy, "#4a3606");
    }
  });
  glyph(c, gx, gy, DOLLAR5, "#ffd34a");
  c.set(gx + 1, gy + 1, "#fff2b0");
  c.set(gx + 2, gy, "#fff2b0");
  c.set(gx + 3, gy + 5, "#c8961e");
  c.set(gx + 2, gy + 6, "#c8961e");
  c.outline(OUT);
  cells.push(c);
  return atlasOf(cells, 3, 20, 16);
}

function medkit() {
  const c = new Canvas(18, 16);
  // 提手
  c.rect(6, 1, 6, 1, "#5a5a5a");
  c.rect(6, 2, 1, 2, "#4a4a4a");
  c.rect(11, 2, 1, 2, "#4a4a4a");
  c.set(7, 1, "#8a8a8a");
  // 顶面 + 正面
  c.rect(1, 4, 16, 8, "#e8e8e0");
  c.rect(1, 4, 16, 1, "#ffffff");
  c.rect(1, 4, 1, 8, "#f6f6f0");
  c.rect(16, 4, 1, 8, "#c8c8c0");
  c.rect(1, 12, 16, 3, "#b8b8b0");
  c.rect(1, 14, 16, 1, "#8e8e88");
  // 红十字
  c.rect(8, 5, 2, 6, "#d01818");
  c.rect(6, 7, 6, 2, "#d01818");
  c.set(8, 5, "#f04040");
  c.set(6, 7, "#f04040");
  // 正面红条
  c.rect(6, 12, 6, 2, "#a01010");
  c.outline(OUT);
  return c;
}

function ammo() {
  const cells = [];
  // 0 红色霰弹盒（开口，露出黄铜弹底）
  let c = new Canvas(20, 16);
  c.rect(2, 3, 16, 7, "#a8261c");
  c.rect(2, 3, 16, 1, "#c84030");
  c.rect(2, 3, 1, 7, "#c84030");
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 4; i++) {
      const sx = 4 + i * 3;
      const sy = 4 + j * 3;
      c.set(sx, sy, "#f0d080");
      c.set(sx + 1, sy, "#d8a84a");
      c.set(sx + 2, sy, "#d8a84a");
      c.set(sx, sy + 1, "#d8a84a");
      c.set(sx + 1, sy + 1, "#7a5a20");
      c.set(sx + 2, sy + 1, "#9a7030");
      c.set(sx, sy + 2, "#d8a84a");
      c.set(sx + 1, sy + 2, "#9a7030");
      c.set(sx + 2, sy + 2, "#9a7030");
    }
  }
  c.rect(2, 10, 16, 4, "#7a1a12");
  c.rect(2, 13, 16, 1, "#5a120c");
  c.rect(5, 11, 10, 2, "#e0d8c0");
  for (let x = 6; x <= 13; x += 2) c.set(x, 11, "#7a1a12");
  c.outline(OUT);
  cells.push(c);
  // 1 橄榄色手雷箱（黄色喷字）
  c = new Canvas(20, 16);
  c.rect(1, 2, 18, 8, "#55602e");
  c.rect(1, 2, 18, 1, "#6a7838");
  c.rect(1, 2, 1, 8, "#6a7838");
  c.rect(18, 2, 1, 8, "#3e4720");
  c.rect(1, 6, 18, 1, "#3e4720");
  for (const x of [4, 5, 6, 8, 9, 11, 12, 13, 14]) c.set(x, 4, "#d8c040");
  for (const x of [4, 5, 6, 7, 10, 11]) c.set(x, 8, "#d8c040");
  c.set(15, 8, "#d8c040");
  c.set(16, 8, "#d8c040");
  c.rect(1, 10, 18, 4, "#3e4720");
  c.rect(1, 13, 18, 1, "#2a3014");
  c.rect(3, 11, 2, 1, "#22280f");
  c.rect(15, 11, 2, 1, "#22280f");
  c.rect(9, 10, 2, 2, "#2a2a2a");
  c.set(9, 10, "#6a6a6a");
  c.outline(OUT);
  cells.push(c);
  // 2 弹药罐 + 挂出来的黄铜弹链
  c = new Canvas(20, 16);
  c.rect(2, 3, 12, 6, "#6a6a40");
  c.rect(2, 3, 12, 1, "#828250");
  c.rect(2, 3, 1, 6, "#7a7a4a");
  c.rect(5, 5, 6, 1, "#3e3e24");
  c.rect(5, 4, 6, 1, "#8a8a58");
  c.rect(2, 9, 12, 5, "#555530");
  c.rect(2, 13, 12, 1, "#3a3a20");
  c.rect(7, 9, 2, 2, "#2e2e1c");
  const belt = [
    [12, 5],
    [14.5, 6],
    [16, 8.5],
    [16, 11.5],
    [17.5, 13.5]
  ];
  let step = 0;
  for (let i = 0; i + 1 < belt.length; i++) {
    const [x0, y0] = belt[i];
    const [x1, y1] = belt[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const nx = -(y1 - y0) / len;
    const ny = (x1 - x0) / len;
    for (let t = 0; t < len; t += 0.5) {
      const px = x0 + ((x1 - x0) * t) / len;
      const py = y0 + ((y1 - y0) * t) / len;
      const odd = Math.floor(step / 2) % 2 === 1;
      c.set(Math.round(px - nx), Math.round(py - ny), "#3a3a2a");
      c.set(Math.round(px), Math.round(py), odd ? "#a87830" : "#d8a84a");
      c.set(Math.round(px + nx), Math.round(py + ny), odd ? "#d8a84a" : "#e8c070");
      step++;
    }
  }
  c.outline(OUT);
  cells.push(c);
  return atlasOf(cells, 3, 20, 16);
}

function weapons() {
  const GM = "#3a3e44";
  const GH = "#6a717a";
  const GMd = "#4a4f56";
  const W1 = "#6a4426";
  const W2 = "#8a5a32";
  const cells = [];
  // 0 泵动霰弹枪
  let c = new Canvas(32, 16);
  c.poly(
    [
      [2, 7],
      [10, 6],
      [10, 9.5],
      [3, 11]
    ],
    W1
  );
  c.line(3, 7, 9, 6, W2);
  c.rect(2, 7, 1, 4, "#2a2018");
  c.rect(10, 6, 6, 4, GM);
  c.rect(10, 6, 6, 1, GH);
  c.set(12, 10, "#2a2d31");
  c.set(13, 10, "#2a2d31");
  c.rect(16, 6, 13, 1, GH);
  c.rect(16, 7, 13, 1, GM);
  c.rect(16, 8, 10, 1, GMd);
  c.rect(18, 8, 6, 2, W2);
  for (let x = 19; x < 24; x += 2) c.set(x, 9, W1);
  c.rect(29, 6, 1, 2, "#24272b");
  c.outline(OUT);
  c.outline("#ffe06a78");
  cells.push(c);
  // 1 榴弹发射器（粗管）
  c = new Canvas(32, 16);
  c.poly(
    [
      [2, 7],
      [9, 7],
      [9, 10],
      [3, 11]
    ],
    W1
  );
  c.line(3, 7, 8, 7, W2);
  c.rect(9, 6, 5, 5, GM);
  c.rect(9, 6, 5, 1, GH);
  c.rect(10, 11, 2, 2, "#2a2d31");
  c.rect(14, 5, 15, 1, GH);
  c.rect(14, 6, 15, 1, "#565c64");
  c.rect(14, 7, 15, 2, GMd);
  c.rect(14, 9, 15, 2, GM);
  c.rect(27, 5, 2, 6, "#2a2d31");
  c.rect(28, 7, 1, 2, "#121416");
  c.rect(19, 11, 3, 2, "#2a2d31");
  c.rect(20, 4, 3, 1, "#2a2d31");
  c.outline(OUT);
  c.outline("#ffe06a78");
  cells.push(c);
  // 2 机枪
  c = new Canvas(32, 16);
  c.poly(
    [
      [2, 6],
      [8, 6],
      [9, 9],
      [3, 10]
    ],
    W1
  );
  c.line(3, 6, 7, 6, W2);
  c.rect(8, 5, 10, 5, GM);
  c.rect(8, 5, 10, 1, GH);
  c.rect(11, 4, 5, 1, "#2a2d31");
  c.rect(17, 6, 9, 3, GM);
  c.rect(17, 6, 9, 1, GH);
  for (let x = 18; x < 26; x += 2) c.set(x, 7, "#16181a");
  c.rect(26, 7, 3, 1, "#565c64");
  c.set(29, 7, "#2a2d31");
  c.rect(11, 10, 5, 3, GMd);
  c.rect(11, 10, 1, 3, GH);
  c.rect(9, 10, 2, 2, "#2a2d31");
  c.line(23, 9, 27, 10, "#2a2d31");
  c.outline(OUT);
  c.outline("#ffe06a78");
  cells.push(c);
  return atlasOf(cells, 3, 32, 16);
}

// ---------------------------------------------------------------- 导出

export function buildEnvArt() {
  const images = [];
  const img = (name, canvas, note) => images.push({ name, kind: "IMAGE", img: canvas, note });
  const atl = (name, a, note) =>
    images.push({ name, kind: "ATLAS", img: a.img, cols: a.cols, rows: a.rows, cellW: a.cellW, cellH: a.cellH, note });

  img("围墙", wallPerimeter(), "水泥围墙俯视：灰色墙顶 + 下方 8px 暗正面，x=0 处有板缝，可横竖平铺");
  img("铁丝网", fenceChain(), "铁丝网：透明底 + 菱形网格 + 左侧立柱，可横向平铺");
  img("建筑墙", brickWall(false), "建筑外墙：暗色砖墙，4px 一层错缝，顶部 3px 水泥压顶，可平铺");
  img("裂墙", brickWall(true), "带人字形大裂缝的建筑墙（原作中可被炸开），与建筑墙边缘一致");
  img("屋顶", roofTar(), "平屋顶：沥青油毡 + 碎石点 + 一道接缝，可平铺");
  img("大门", gateSteel(), "关闭的推拉铁门：竖肋钢板 + 黄黑斜纹警示带，可横向平铺");
  img("木箱", crate(), "木质补给箱（3/4 视角，顶面 X 斜撑 + 暗正面），可打碎");
  img("油桶", barrel(), "红色油桶（3/4 视角，桶盖 + 两道箍 + 危险品火焰标），可爆炸");
  img("气瓶", gasCylinders(), "三只捆在一起的高压气瓶（红瓶肩、白瓶身、铁链）");
  img("路灯", streetLamp(), "路灯俯视：深色底座 + 灯头暖黄玻璃");
  img("箭头", arrowDecal(), "地面绿色喷漆箭头（指向右，斑驳剥落，半透明），无描边");
  img("入口", labEntrance(), "地下实验室入口：警示条纹框 + 往下的台阶（渐黑）");
  img("卡车", truck(), "停着的军用卡车（车头朝上）：橄榄色驾驶室 + 帆布篷货厢");
  img("沙袋", sandbags(), "沙袋掩体一段（两层错缝堆叠）");
  atl("钱", money(), "钱：0 单张钞票 / 1 一沓 / 2 一大捆带金色 $");
  img("医疗包", medkit(), "医疗包：白盒红十字 + 提手");
  atl("弹药箱", ammo(), "弹药：0 红色霰弹盒 / 1 橄榄色手雷箱 / 2 弹药罐 + 黄铜弹链");
  atl("武器箱", weapons(), "地上的武器（朝右，带黄色光边）：0 泵动霰弹枪 / 1 榴弹发射器 / 2 机枪");

  const ground = {
    草地: groundGrass(),
    草地暗: groundGrassDark(),
    水泥: groundConcrete(),
    金属地板: groundMetal(),
    土路: groundDirt(),
    车道线: groundLane()
  };
  return { images, ground };
}
