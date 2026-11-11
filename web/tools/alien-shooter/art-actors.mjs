/**
 * 孤胆枪手示例 · 角色 / 特效 / 小道具像素画（程序化、确定性、零依赖）。
 *
 * buildActorArt() 返回一组条目：
 *   { name, kind: "ATLAS" | "IMAGE", img, cols?, rows?, cellW?, cellH?, note }
 * img 是 px.mjs 的 Canvas。ATLAS 满足 img.w === cols*cellW、img.h === rows*cellH，帧号 = 行*cols + 列。
 *
 * 方向图集（主角 / 蜘蛛）由 px.renderDir 逐方向原生光栅化：方向 d 角度 = d*22.5°，
 * 0 朝屏幕右、4 朝下、8 朝左、12 朝上；局部坐标 +x = 正前方，+y = 右手边；形状数组越靠后越在上层。
 * 所有随机都走 rng(seed)，同一份代码每次输出逐字节一致。
 */
import { rng, valueNoise, col, alpha, Canvas, pointInPoly, segDist, atlasOf, renderDir } from "./px.mjs";

const OUTLINE = "#0d0f0c";
const SHADOW = "#00000058";
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- 通用小工具

/** 把图集拆回独立 cell（行优先）。 */
function cellsOf(atlas) {
  const cells = [];
  for (let r = 0; r < atlas.rows; r++) {
    for (let c = 0; c < atlas.cols; c++) {
      const cell = new Canvas(atlas.cellW, atlas.cellH);
      for (let y = 0; y < atlas.cellH; y++) {
        const so = ((r * atlas.cellH + y) * atlas.img.w + c * atlas.cellW) * 4;
        cell.data.set(atlas.img.data.subarray(so, so + atlas.cellW * 4), y * atlas.cellW * 4);
      }
      cells.push(cell);
    }
  }
  return cells;
}

function atlasEntry(name, atlas, note) {
  return { name, kind: "ATLAS", img: atlas.img, cols: atlas.cols, rows: atlas.rows, cellW: atlas.cellW, cellH: atlas.cellH, note };
}

function imageEntry(name, img, note) {
  return { name, kind: "IMAGE", img, note };
}

/** 单张静态图：用 renderDir 的 dirs=1（角度 0，局部坐标 = 屏幕坐标，原点在画布中心）。 */
function renderStatic(size, shapes, opts = {}) {
  return cellsOf(renderDir({ size, dirs: 1, frames: 1, shapes: () => shapes, ...opts }))[0];
}

function hit(s, x, y) {
  switch (s.t) {
    case "circle":
      return (x - s.x) ** 2 + (y - s.y) ** 2 <= s.r * s.r;
    case "ellipse":
      return ((x - s.x) / s.rx) ** 2 + ((y - s.y) / s.ry) ** 2 <= 1;
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

/**
 * 屏幕坐标形状光栅化（武器图标这种侧视图用）：bevel 光照 —— 形状上沿一行用 hi，下沿一行用 lo，
 * 中间用 c，金属件的"倒角"感比按中心算的球面光照更干净。
 */
function paintBevel(cv, shapes) {
  for (let py = 0; py < cv.h; py++) {
    for (let px = 0; px < cv.w; px++) {
      const x = px + 0.5;
      const y = py + 0.5;
      for (let k = shapes.length - 1; k >= 0; k--) {
        const s = shapes[k];
        if (!hit(s, x, y)) continue;
        let c = s.c;
        if (s.hi && !hit(s, x, y - 1)) c = s.hi;
        else if (s.lo && !hit(s, x, y + 1)) c = s.lo;
        cv.set(px, py, c);
        break;
      }
    }
  }
  return cv;
}

/** 局部旋转矩形（木板）→ poly 点列，可带一个参差的断口。 */
function plankPts(cx, cy, len, wid, ang, broken, r) {
  const hl = len / 2;
  const hw = wid / 2;
  const local = [[-hl, -hw]];
  if (broken) {
    local.push([hl - 1.5 * r(), -hw], [hl + 0.6, -hw / 3], [hl - 1.8 * r(), hw / 3], [hl - 0.4, hw]);
  } else {
    local.push([hl, -hw], [hl, hw]);
  }
  local.push([-hl, hw]);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return local.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

// ---------------------------------------------------------------- 1. 主角

// 调色板（含描边、阴影共 12 色）：头盔最暗、肩甲是偏亮的橄榄褐，两者必须拉开明度，否则俯视时头和肩糊成一团；
// 背包与背带复用头盔三色（同一套装备），靠中间一条肩甲色隔开头盔。
const PL = {
  helmet: { c: "#3c4a28", hi: "#5c6e3a", lo: "#26301a" },
  armor: { c: "#6a7442", hi: "#8c9858", lo: "#4c5430" },
  skin: "#c8946a",
  gun: { c: "#2a2e33", hi: "#6a717a" },
  boot: "#1d1f1a"
};

function playerShapes(f) {
  // [左脚 x, 右脚 x]：0 站立，1 左脚前，2 并拢，3 右脚前
  const [lx, rx] = [[0, 0], [5, -4], [0, 0], [-4, 5]][f];
  const arm = (side) => ({ t: "seg", x0: 0.4, y0: 6.3 * side, x1: 8.2, y1: 4.2 * side, w: 3, c: PL.armor.c, lo: PL.armor.lo, loAt: -0.3 });
  const gun = (side) => ({ t: "seg", x0: 8.2, y0: 4 * side, x1: 14, y1: 4 * side, w: 2.2, ...PL.gun, hiAt: 0.15 });
  const hand = (side) => ({ t: "circle", x: 8.8, y: 4.1 * side, r: 1.45, c: PL.skin });
  const strap = (side) => ({ t: "seg", x0: -4.6, y0: 2.6 * side, x1: 1.2, y1: 6.7 * side, w: 1.1, c: PL.helmet.c });
  return [
    // 脚最先画（最底层），迈步时才从身体前后露出来
    { t: "ellipse", x: lx, y: -3.5, rx: 3, ry: 2, c: PL.boot },
    { t: "ellipse", x: rx, y: 3.5, rx: 3, ry: 2, c: PL.boot },
    // 躯干 / 肩甲
    { t: "ellipse", x: 0, y: 0, rx: 5, ry: 8.5, ...PL.armor },
    // 背包背带（从背包斜跨到肩前）
    strap(-1),
    strap(1),
    // 背包（身后，伸出躯干后沿）
    { t: "rect", x0: -7.4, y0: -3, x1: -4.3, y1: 3, ...PL.helmet },
    // 双臂前伸
    arm(-1),
    arm(1),
    // 双枪（枪口是最前端的不透明像素）
    gun(-1),
    gun(1),
    hand(-1),
    hand(1),
    // 头盔：最上层，略靠前（后沿与背包之间留 ≥1px 肩甲色）
    { t: "circle", x: 2, y: 0, r: 4.9, ...PL.helmet }
  ];
}

function buildPlayer() {
  return renderDir({
    size: 40,
    dirs: 16,
    frames: 4,
    shapes: playerShapes,
    outline: OUTLINE,
    shadow: { rx: 9, ry: 8.5, dx: 1, dy: 2, c: SHADOW }
  });
}

// ---------------------------------------------------------------- 2/3. 蜘蛛

const GREEN_SPIDER = {
  shift: -1,
  ab: { x: -4, rx: 6.5, ry: 5 },
  ceph: { x: 4, rx: 4, ry: 3.5 },
  head: { x: 7.1, r: 2.2 },
  body: { c: "#4f9a2a", hi: "#7fd04a", lo: "#2f6418" },
  head3: { c: "#2f6418", hi: "#4f9a2a" },
  stripe: "#24401a",
  stripes: [
    { dx: 1.4, rx: 0.9, ry: 4.4 },
    { dx: -2.2, rx: 0.9, ry: 3.9 }
  ],
  mand: { c: "#c9d36a", x0: 8.2, y0: 1.6, x1: 10.6, y1: 0.9, w: 1.3 },
  eye: { c: "#ffe14a", x: 6.1, y: 1.2 },
  leg: { c: "#24401a", w: 1.6 },
  hips: [[6.2, 2.4], [4.8, 2.9], [3.4, 3.0], [2.0, 2.7]],
  au: [55, 92, 110, 125],
  lu: [4.4, 4.6, 4.8, 5.2],
  al: [-10, 40, 150, 150],
  ll: [4.4, 4.4, 4.8, 5.2],
  tibK: 0.6,
  spikes: null
};

const YELLOW_SPIDER = {
  shift: -1.2,
  ab: { x: -4.5, rx: 7.4, ry: 5.7 },
  ceph: { x: 4.5, rx: 4.5, ry: 4 },
  head: { x: 8, r: 2.4 },
  body: { c: "#c98a1e", hi: "#f0bb44", lo: "#7a4a10" },
  head3: { c: "#7a4a10", hi: "#c98a1e" },
  stripe: "#5a3410",
  stripes: [
    { dx: 1.8, rx: 1, ry: 5 },
    { dx: -2.4, rx: 1, ry: 4.5 }
  ],
  mand: { c: "#e6d49a", x0: 9.2, y0: 1.8, x1: 11.6, y1: 1, w: 1.4 },
  eye: { c: "#ff4a26", x: 6.9, y: 1.3 },
  leg: { c: "#4a2a0c", w: 1.7 },
  hips: [[6.9, 2.7], [5.4, 3.3], [3.8, 3.4], [2.2, 3.0]],
  au: [55, 92, 105, 125],
  lu: [4.2, 4.6, 4.8, 5.2],
  al: [-10, 40, 140, 150],
  ll: [4.0, 4.2, 4.6, 5.0],
  tibK: 0.6,
  // 背刺：沿背中线指向后方的小三角（骨色），外加两侧各一根外翻侧刺
  spikes: { c: "#e6d49a", dorsal: [3.2, -0.4, -4.0], lateral: [-0.4] }
};

/** 32px cell：中心 16，像素中心最多离中心 13.5（再外是描边和边距），减去腿半宽 ≈0.8。 */
const LEG_REACH = 12.6;

/** 腿：每条两段（髋→膝→足），角度从 +x 往身体外侧量；swing>0 = 往前摆。 */
function spiderLegs(P, swing, opts = {}) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      if (opts.skip && opts.skip(i, side)) continue;
      // 交替组：L1 R2 L3 R4 vs R1 L2 R3 L4
      const setA = (i % 2 === 0) === (side < 0);
      const s = (setA ? swing : -swing) * DEG;
      const hx = P.hips[i][0] + P.shift;
      const hy = P.hips[i][1] * side;
      const au = (opts.au ? opts.au(i, side) : P.au[i]) * DEG - s;
      const lu = P.lu[i] * (opts.lenK ?? 1);
      const kx = hx + Math.cos(au) * lu;
      const ky = hy + Math.sin(au) * lu * side;
      // 小腿只跟随 tibK 倍的摆角：足尖位移小一些，交替组相邻腿在摆幅顶点不至于并成一团
      const al = (opts.al ? opts.al(i, side) : P.al[i]) * DEG - s * (P.tibK ?? 1);
      const ll = P.ll[i] * (opts.lenK ?? 1);
      let fx = kx + Math.cos(al) * ll;
      let fy = ky + Math.sin(al) * ll * side;
      // 足尖离 cell 中心不超过 LEG_REACH：任何方向旋转后都留得下 1px 描边 + 1px 透明边距
      const rf = Math.hypot(fx, fy);
      if (rf > LEG_REACH) {
        fx *= LEG_REACH / rf;
        fy *= LEG_REACH / rf;
      }
      out.push({ t: "seg", x0: hx, y0: hy, x1: kx, y1: ky, w: P.leg.w, c: opts.legC ?? P.leg.c });
      out.push({ t: "seg", x0: kx, y0: ky, x1: fx, y1: fy, w: P.leg.w * 0.9, c: opts.legC ?? P.leg.c });
    }
  }
  return out;
}

function spiderBody(P, sway, pal = {}) {
  const sh = P.shift;
  const body = pal.body ?? P.body;
  const stripe = pal.stripe ?? P.stripe;
  const abRy = P.ab.ry * (pal.flat ?? 1);
  const shapes = [];
  if (P.spikes) {
    for (const dx of P.spikes.lateral) {
      for (const side of [-1, 1]) {
        const bx = P.ab.x + dx + sh;
        shapes.push({
          t: "poly",
          c: P.spikes.c,
          pts: [
            [bx + 1.8, side * (abRy - 1.4) + sway],
            [bx - 3.6, side * (abRy + 2.2) + sway],
            [bx - 1.6, side * (abRy - 1.8) + sway]
          ]
        });
      }
    }
  }
  shapes.push({ t: "ellipse", x: P.ab.x + sh, y: sway, rx: P.ab.rx, ry: abRy, ...body });
  for (const st of P.stripes) {
    shapes.push({ t: "ellipse", x: P.ab.x + st.dx + sh, y: sway, rx: st.rx, ry: st.ry * (pal.flat ?? 1), c: stripe });
  }
  if (P.spikes) {
    for (const dx of P.spikes.dorsal) {
      const bx = P.ab.x + dx + sh;
      shapes.push({ t: "poly", c: P.spikes.c, pts: [[bx + 0.8, -1.5 + sway], [bx - 2.8, sway], [bx + 0.8, 1.5 + sway]] });
    }
  }
  shapes.push({ t: "ellipse", x: P.ceph.x + sh, y: 0, rx: P.ceph.rx, ry: P.ceph.ry, ...body });
  shapes.push({ t: "circle", x: P.head.x + sh, y: 0, r: P.head.r, ...(pal.head3 ?? P.head3) });
  const m = P.mand;
  for (const side of [-1, 1]) {
    if (pal.brokenMand === side) continue;
    shapes.push({ t: "seg", x0: m.x0 + sh, y0: m.y0 * side, x1: m.x1 + sh, y1: m.y1 * side, w: m.w, c: pal.mandC ?? m.c });
  }
  if (!pal.noEyes) {
    for (const side of [-1, 1]) shapes.push({ t: "circle", x: P.eye.x + sh, y: P.eye.y * side, r: 0.75, c: P.eye.c });
  }
  return shapes;
}

function spiderShapes(P) {
  return (f) => {
    const swing = [25, 0, -25, 0][f];
    const sway = [0, 0.5, 0, -0.5][f];
    return [...spiderLegs(P, swing), ...spiderBody(P, sway)];
  };
}

function buildSpider(P) {
  return renderDir({
    size: 32,
    dirs: 16,
    frames: 4,
    shapes: spiderShapes(P),
    outline: OUTLINE,
    shadow: { rx: 8.5, ry: 7.5, dx: 1, dy: 2, c: SHADOW }
  });
}

// ---------------------------------------------------------------- 4. 尸体 / 残骸

const GOO = [alpha("#3fbf2a", 200), alpha("#2a8a1c", 220)];

function deadSpider(P, pal, seed, dir) {
  const r = rng(seed);
  const missing = new Set();
  missing.add(Math.floor(r() * 8));
  if (r() < 0.6) missing.add(Math.floor(r() * 8));
  const jitter = Array.from({ length: 8 }, () => (r() - 0.5) * 24);
  const legs = spiderLegs(P, 0, {
    skip: (i, side) => missing.has(i * 2 + (side > 0 ? 1 : 0)),
    // 腿往里蜷：大腿照常外伸，小腿折回身体方向
    au: (i, side) => P.au[i] + jitter[i * 2 + (side > 0 ? 1 : 0)],
    al: (i, side) => P.au[i] + jitter[i * 2 + (side > 0 ? 1 : 0)] + 125,
    lenK: 0.85,
    legC: pal.leg
  });
  const body = spiderBody(P, 0, { ...pal, flat: 1.12, brokenMand: r() < 0.5 ? -1 : 1, noEyes: true });
  const atlas = renderDir({ size: 32, dirs: 16, frames: 1, shapes: () => [...legs, ...body], outline: OUTLINE });
  const cell = cellsOf(atlas)[dir];
  // 绿色体液：几滩垫在尸体底下 + 外溅的小点
  const ang0 = (dir * 22.5 + 180) * DEG;
  for (let k = 0; k < 5; k++) {
    const a = ang0 + (r() - 0.5) * 2.2;
    const d = 5 + r() * 6;
    const cx = 16 + Math.cos(a) * d;
    const cy = 16 + Math.sin(a) * d;
    cell.ellipse(cx, cy, 1.4 + r() * 1.6, 1 + r() * 1.3, GOO[k % 2], "under");
  }
  for (let k = 0; k < 6; k++) {
    const a = r() * Math.PI * 2;
    const d = 9 + r() * 4;
    cell.under(Math.round(16 + Math.cos(a) * d), Math.round(16 + Math.sin(a) * d), GOO[0]);
  }
  return cell;
}

function crateDebris(seed) {
  const r = rng(seed);
  const wood = { c: "#6b4a2a", hi: "#8c6a3e", lo: "#3e2a16" };
  const shapes = [];
  const n = 5;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + r() * 0.9;
    const d = 2 + r() * 5;
    const cx = Math.cos(a) * d;
    const cy = Math.sin(a) * d;
    const len = 7 + r() * 5;
    const wid = 2.6 + r() * 1.2;
    const ang = r() * Math.PI;
    const pts = plankPts(cx, cy, len, wid, ang, r() < 0.7, r);
    shapes.push({ t: "poly", pts, ...wood });
    if (len > 9) {
      // 木纹：沿板中线一条深色线
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      shapes.push({ t: "seg", x0: cx - c * len * 0.35, y0: cy - s * len * 0.35, x1: cx + c * len * 0.3, y1: cy + s * len * 0.3, w: 0.9, c: wood.lo });
    }
  }
  // 木刺
  for (let k = 0; k < 5; k++) {
    const a = r() * Math.PI * 2;
    const d = 7 + r() * 3.5;
    const cx = Math.cos(a) * d;
    const cy = Math.sin(a) * d;
    const ang = r() * Math.PI;
    const l = 1.5 + r() * 1.5;
    shapes.push({ t: "seg", x0: cx - Math.cos(ang) * l, y0: cy - Math.sin(ang) * l, x1: cx + Math.cos(ang) * l, y1: cy + Math.sin(ang) * l, w: 1.1, c: wood.hi });
  }
  // 整体限制在 ±12 内（留描边和 1px 边距）
  return renderStatic(32, shapes, { outline: OUTLINE });
}

function scorch(seed) {
  const cv = new Canvas(32, 32);
  const n = valueNoise(seed, 8);
  const n2 = valueNoise(seed + 1, 16);
  const r = rng(seed + 2);
  const R = 10.5;
  const ox = r() * 8;
  const oy = r() * 8;
  for (let y = 1; y < 31; y++) {
    for (let x = 1; x < 31; x++) {
      const dx = x + 0.5 - 16;
      const dy = y + 0.5 - 16;
      const d = Math.hypot(dx, dy);
      const e = d / (R * (0.72 + 0.56 * n(ox + x * 0.32, oy + y * 0.32)));
      const t = e + (n2(x * 0.6, y * 0.6) - 0.5) * 0.25 + (BAYER(x, y) - 0.5) * 0.12;
      if (e >= 1 || t >= 1) continue;
      if (t < 0.45) cv.set(x, y, alpha("#0e0b08", 200));
      else if (t < 0.75) cv.set(x, y, alpha("#1e140c", 165));
      else cv.set(x, y, alpha("#3a2616", 120));
    }
  }
  // 少量灰白灰烬点
  for (let k = 0; k < 7; k++) {
    const a = r() * Math.PI * 2;
    const d = r() * 7;
    const x = Math.round(16 + Math.cos(a) * d);
    const y = Math.round(16 + Math.sin(a) * d);
    if (cv.alphaAt(x, y) > 0) cv.set(x, y, alpha("#5a4a3a", 150));
  }
  return cv;
}

const BAYER4_FLAT = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function BAYER(x, y) {
  return BAYER4_FLAT[(y & 3) * 4 + (x & 3)] / 16;
}

function buildCorpses() {
  const GREEN_DEAD = { body: { c: "#3a7420", hi: "#4f9a2a", lo: "#22441a" }, head3: { c: "#22441a", hi: "#3a7420" }, stripe: "#1a3012", leg: "#1a3012", mandC: "#9aa04e" };
  const YELLOW_DEAD = { body: { c: "#9a6414", hi: "#c98a1e", lo: "#5a3410" }, head3: { c: "#5a3410", hi: "#9a6414" }, stripe: "#3e2408", leg: "#3e2408", mandC: "#b8a678" };
  const cells = [
    deadSpider(GREEN_SPIDER, GREEN_DEAD, 701, 3),
    deadSpider(GREEN_SPIDER, GREEN_DEAD, 702, 10),
    deadSpider(YELLOW_SPIDER, YELLOW_DEAD, 703, 6),
    deadSpider(YELLOW_SPIDER, YELLOW_DEAD, 704, 13),
    crateDebris(711),
    crateDebris(712),
    scorch(721),
    scorch(722)
  ];
  return atlasOf(cells, 4, 32, 32);
}

// ---------------------------------------------------------------- 5. 血迹

function bloodSplat(seed, pal) {
  const r = rng(seed);
  const n = valueNoise(seed + 50, 16);
  const blobs = [];
  const mx = (r() - 0.5) * 3;
  const my = (r() - 0.5) * 3;
  blobs.push({ x: 16 + mx, y: 16 + my, r: 5 + r() * 2, main: true });
  const subs = 3 + Math.floor(r() * 3);
  for (let k = 0; k < subs; k++) {
    const a = r() * Math.PI * 2;
    const d = 3 + r() * 4;
    blobs.push({ x: 16 + mx + Math.cos(a) * d, y: 16 + my + Math.sin(a) * d, r: 2 + r() * 2.2, main: false });
  }
  // 流痕：从中心往外一串半径递减的圆
  const streaks = 2 + Math.floor(r() * 2);
  for (let k = 0; k < streaks; k++) {
    const a = r() * Math.PI * 2;
    const len = 9 + r() * 3.5;
    for (let t = 4; t <= len; t += 0.8) {
      blobs.push({ x: 16 + mx + Math.cos(a) * t, y: 16 + my + Math.sin(a) * t, r: Math.max(0.65, 1.8 - (t / len) * 1.2), streak: true });
    }
  }
  // 卫星小滴
  const drops = 4 + Math.floor(r() * 4);
  for (let k = 0; k < drops; k++) {
    const a = r() * Math.PI * 2;
    const d = 9 + r() * 4;
    blobs.push({ x: 16 + Math.cos(a) * d, y: 16 + Math.sin(a) * d, r: 0.75 + r() * 0.7, streak: true });
  }
  const field = (x, y) => {
    let best = -1;
    let who = null;
    for (const b of blobs) {
      const v = 1 - Math.hypot(x - b.x, y - b.y) / b.r;
      if (v > best) {
        best = v;
        who = b;
      }
    }
    if (who && !who.streak) best += (n(x * 0.45, y * 0.45) - 0.5) * 0.45;
    return [best, who];
  };
  const cv = new Canvas(32, 32);
  const mask = new Uint8Array(32 * 32);
  const F = new Float32Array(32 * 32);
  const W = new Array(32 * 32);
  for (let y = 1; y < 31; y++) {
    for (let x = 1; x < 31; x++) {
      const [v, b] = field(x + 0.5, y + 0.5);
      if (v > 0) {
        mask[y * 32 + x] = 1;
        F[y * 32 + x] = v;
        W[y * 32 + x] = b;
      }
    }
  }
  const m = (x, y) => (x >= 0 && y >= 0 && x < 32 && y < 32 ? mask[y * 32 + x] : 0);
  for (let y = 1; y < 31; y++) {
    for (let x = 1; x < 31; x++) {
      if (!m(x, y)) continue;
      const v = F[y * 32 + x];
      const b = W[y * 32 + x];
      const edge = !m(x - 1, y) || !m(x + 1, y) || !m(x, y - 1) || !m(x, y + 1);
      if (edge || v < 0.18) {
        cv.set(x, y, alpha(pal.rim, 150));
        continue;
      }
      // 高光：大块血泊的左上部
      const dx = x + 0.5 - b.x;
      const dy = y + 0.5 - b.y;
      if (!b.streak && b.r >= 3 && dx + dy < -0.55 * b.r && v > 0.32 && Math.hypot(dx + 0.45 * b.r, dy + 0.45 * b.r) < 0.45 * b.r) {
        cv.set(x, y, alpha(pal.hl, 230));
      } else {
        cv.set(x, y, alpha(pal.core, 215));
      }
    }
  }
  return cv;
}

function buildBlood() {
  const G = { core: "#3fbf2a", hl: "#7cff5a", rim: "#1f6a14" };
  const R = { core: "#8a0f0f", hl: "#c01818", rim: "#4a0606" };
  const cells = [];
  for (let k = 0; k < 4; k++) cells.push(bloodSplat(801 + k * 17, G));
  for (let k = 0; k < 4; k++) cells.push(bloodSplat(901 + k * 23, R));
  return atlasOf(cells, 4, 32, 32);
}

// ---------------------------------------------------------------- 6. 巢穴

function nestShapes(f) {
  const r = rng(601);
  const g = f === 1 ? 1 : 0;
  const flesh = { c: "#5a2f4a", hi: "#7a4466", lo: "#38182c" };
  const vein = "#93507a";
  const outer = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + (r() - 0.5) * 0.35;
    const d = 13 + r() * 2.5;
    const rad = Math.min(8.5 + r() * 3, 26.5 - d);
    outer.push({ t: "circle", x: Math.cos(a) * d, y: Math.sin(a) * d * 0.92, r: rad + g, ...flesh });
  }
  // 画家顺序：屏幕偏上的肉瘤先画，下面的压在上面（略带"隆起"的体积感）
  outer.sort((p, q) => p.y - q.y);
  const shapes = [...outer, { t: "circle", x: 0, y: -0.5, r: 14 + g, ...flesh }];
  for (let k = 0; k < 3; k++) {
    const a = r() * Math.PI * 2;
    const d = 4 + r() * 4;
    shapes.push({ t: "circle", x: Math.cos(a) * d, y: Math.sin(a) * d, r: 5 + r() * 1.5 + g * 0.5, ...flesh });
  }
  // 血管：从中心往外的折线
  for (let k = 0; k < 6; k++) {
    let a = (k / 6) * Math.PI * 2 + 0.3 + (r() - 0.5) * 0.4;
    let x = Math.cos(a) * 3;
    let y = Math.sin(a) * 3;
    for (let s = 0; s < 3; s++) {
      a += (r() - 0.5) * 0.9;
      const l = 4.5 + r() * 2;
      const nx = x + Math.cos(a) * l;
      const ny = y + Math.sin(a) * l;
      shapes.push({ t: "seg", x0: x, y0: y, x1: nx, y1: ny, w: 1.2, c: vein });
      x = nx;
      y = ny;
    }
  }
  // 发光孔 / 卵
  const holes = [
    [-12, -9],
    [11, -11],
    [15, 6],
    [-14, 9],
    [2, 14],
    [1, -2]
  ];
  for (const [hx, hy] of holes) {
    shapes.push({ t: "circle", x: hx, y: hy, r: 2.9 + g * 0.3, c: "#2f8a20" });
    shapes.push({ t: "circle", x: hx - 0.2, y: hy - 0.2, r: 1.7 + g * 0.3, c: f === 1 ? "#c8ff9a" : "#7cff5a" });
  }
  return shapes;
}

function buildNest() {
  const atlas = renderDir({
    size: 64,
    dirs: 1,
    frames: 2,
    shapes: nestShapes,
    outline: OUTLINE,
    shadow: { rx: 27, ry: 23, dx: 2, dy: 3, c: SHADOW }
  });
  return atlasOf(cellsOf(atlas), 2, 64, 64);
}

// ---------------------------------------------------------------- 7. 枪口火焰

function buildMuzzle() {
  const WH = "#fffef0";
  const YE = alpha("#ffe066", 235);
  const OR = alpha("#ff9a2a", 170);
  const ox = 2;
  const oy = 12;
  const defs = [
    { spikes: [[0, 16, 2.6], [-32, 10, 1.8], [32, 10, 1.8]], core: [3.4, 2.4] },
    { spikes: [[0, 19, 2.8], [-18, 13, 2], [18, 13, 2], [-46, 10, 1.6], [46, 10, 1.6]], core: [4, 2.8] },
    { spikes: [[-10, 15, 2.4], [10, 15, 2.4], [-38, 10, 1.8], [38, 10, 1.8]], core: [3.5, 2.6] },
    { spikes: [[0, 18, 2.2], [-24, 11, 3.4], [24, 11, 3.4], [-8, 14, 1.6], [8, 14, 1.6]], core: [4.5, 3] }
  ];
  const tri = (cv, a, L, w, c) => {
    const ca = Math.cos(a * DEG);
    const sa = Math.sin(a * DEG);
    cv.poly([[ox - sa * w, oy + ca * w], [ox + ca * L, oy + sa * L], [ox + sa * w, oy - ca * w]], c);
  };
  const cells = defs.map((d) => {
    const cv = new Canvas(24, 24);
    const [rx, ry] = d.core;
    const layers = [
      [OR, 1, 1, 1.2],
      [YE, 0.68, 0.75, 1],
      [WH, 0.4, 0.5, 0.62]
    ];
    for (const [c, kl, kw, kc] of layers) {
      for (const [a, L, w] of d.spikes) tri(cv, a, L * kl, w * kw, c);
      cv.ellipse(ox + rx, oy, rx * kc, ry * kc, c);
    }
    return cv;
  });
  return atlasOf(cells, 4, 24, 24);
}

// ---------------------------------------------------------------- 8. 爆炸

function buildExplosion() {
  const S = 64;
  const C = 32;
  const n1 = valueNoise(1001, 16);
  const n2 = valueNoise(1002, 16);
  const n3 = valueNoise(1003, 16);
  const P = {
    white: col("#fffef0"),
    pale: col("#fff3a0"),
    yellow: col("#ffd23a"),
    orange: col("#ff8a1e"),
    red: col("#d8401a"),
    dred: col("#8a1e0e"),
    smokeL: col("#4a4440"),
    smoke: col("#3a3632"),
    smokeD: col("#2a2724"),
    ember: col("#ffb030")
  };
  const LIM = 29.5;
  const each = (fn) => {
    const cv = new Canvas(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x + 0.5 - C;
        const dy = y + 0.5 - C;
        const d = Math.hypot(dx, dy);
        if (d > LIM) continue;
        const c = fn(x, y, dx, dy, d);
        if (c) cv.set(x, y, c);
      }
    }
    return cv;
  };
  const frames = [];
  // 0：小闪光
  frames.push(
    (() => {
      const cv = each((x, y, dx, dy, d) => {
        const e = d / (10 * (0.85 + 0.3 * n1(x * 0.3, y * 0.3)));
        if (e < 0.45) return P.white;
        if (e < 0.75) return P.pale;
        if (e < 1) return alpha(P.yellow, 220);
        return null;
      });
      for (const a of [20, 110, 200, 290]) {
        const ca = Math.cos(a * DEG);
        const sa = Math.sin(a * DEG);
        for (let t = 8; t <= 14; t += 0.5) {
          const x = Math.floor(C + ca * t);
          const y = Math.floor(C + sa * t);
          if (cv.alphaAt(x, y) === 0) cv.set(x, y, alpha(P.pale, t < 12 ? 210 : 150));
        }
      }
      return cv;
    })()
  );
  // 1：大火球
  frames.push(
    each((x, y, dx, dy, d) => {
      const e = d / (22 * (0.9 + 0.2 * n1(x * 0.25 + 3, y * 0.25)));
      if (e < 0.35) return P.white;
      if (e < 0.6) return P.pale;
      if (e < 0.82) return P.yellow;
      if (e < 1) return P.orange;
      return null;
    })
  );
  // 2：火球 r≈28，橙红 + 噪声边
  frames.push(
    each((x, y, dx, dy, d) => {
      const e = d / (27 * (0.86 + 0.22 * n1(x * 0.22 + 7, y * 0.22 + 2)));
      if (e >= 1) return null;
      const t = e + (n2(x * 0.35, y * 0.35) - 0.5) * 0.28;
      if (t < 0.22) return P.pale;
      if (t < 0.45) return P.yellow;
      if (t < 0.68) return P.orange;
      if (t < 0.87) return P.red;
      return alpha(P.dred, 230);
    })
  );
  // 3：火焰碎成团 + 烟出现
  {
    const r = rng(1010);
    const blobs = [{ x: 0, y: 0, r: 7 }];
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + r() * 0.6;
      const dd = 10 + r() * 7;
      blobs.push({ x: Math.cos(a) * dd, y: Math.sin(a) * dd, r: 4.5 + r() * 3.5 });
    }
    frames.push(
      each((x, y, dx, dy, d) => {
        let fv = -1;
        for (const b of blobs) fv = Math.max(fv, 1 - Math.hypot(dx - b.x, dy - b.y) / b.r);
        fv += (n2(x * 0.4 + 5, y * 0.4) - 0.5) * 0.45;
        if (fv > 0.55) return P.yellow;
        if (fv > 0.3) return P.orange;
        if (fv > 0.08) return P.red;
        const sv = 1 - Math.abs(d - 18) / 9 + (n3(x * 0.3, y * 0.3) - 0.5) * 0.8;
        if (sv > 0.25) return alpha(dx + dy < -6 ? P.smokeL : sv > 0.6 ? P.smoke : P.smokeD, 175);
        return null;
      })
    );
  }
  // 4-7：烟环扩散、淡出，带几颗余烬
  const ring = [
    { R: 16, W: 10, a: 200, embers: 10 },
    { R: 19, W: 9, a: 150, embers: 7 },
    { R: 22, W: 8, a: 95, embers: 4 },
    { R: 24, W: 7, a: 40, embers: 2 }
  ];
  ring.forEach((g, i) => {
    const cv = each((x, y, dx, dy, d) => {
      const s = 1 - Math.abs(d - g.R) / (g.W / 2) + (n3(x * 0.28 + i * 4, y * 0.28 + i * 3) - 0.5) * 0.9;
      if (s > 0.15) {
        const lit = dx + dy < -g.R * 0.6;
        const c = s < 0.45 ? P.smokeD : lit ? P.smokeL : P.smoke;
        return alpha(c, s < 0.45 ? Math.round(g.a * 0.75) : g.a);
      }
      // 第 4 帧中心还残留一点暗红火光
      if (i === 0 && d < 9) {
        const v = 1 - d / 9 + (n2(x * 0.45 + 9, y * 0.45) - 0.5) * 0.9;
        if (v > 0.45) return alpha(P.dred, 190);
      }
      return null;
    });
    const r = rng(1020 + i);
    for (let k = 0; k < g.embers; k++) {
      const a = r() * Math.PI * 2;
      const dd = g.R - g.W / 2 + r() * (g.W + 2);
      const x = Math.floor(C + Math.cos(a) * Math.min(dd, LIM - 1));
      const y = Math.floor(C + Math.sin(a) * Math.min(dd, LIM - 1));
      cv.set(x, y, k % 3 === 0 ? P.yellow : P.ember);
    }
    frames.push(cv);
  });
  return atlasOf(frames, 8, 64, 64);
}

// ---------------------------------------------------------------- 9. 火花

function buildSparks() {
  const W = "#fffef0";
  const Y = "#ffe066";
  const O = "#ff9a2a";
  const D = alpha("#ff9a2a", 150);
  // 每帧：[x, y, 颜色]，8×8，中心 (4,4)，全部落在 1..6 内
  const frames = [
    [[3, 3, W], [4, 3, W], [3, 4, W], [4, 4, W], [2, 3, Y], [5, 4, Y], [4, 2, Y], [3, 5, Y], [5, 2, Y], [6, 1, O], [2, 5, Y], [1, 6, O], [6, 5, D]],
    [[4, 3, W], [3, 4, Y], [4, 4, Y], [5, 3, Y], [3, 2, Y], [6, 2, O], [2, 6, O], [1, 3, D], [5, 5, O]],
    [[4, 4, Y], [3, 3, Y], [5, 2, O], [2, 5, O], [6, 4, D]],
    [[4, 3, O], [2, 4, D], [5, 5, D]]
  ];
  const cells = frames.map((list) => {
    const cv = new Canvas(8, 8);
    for (const [x, y, c] of list) cv.set(x, y, c);
    return cv;
  });
  return atlasOf(cells, 4, 8, 8);
}

// ---------------------------------------------------------------- 10-12. 小图

function buildShell() {
  const cv = new Canvas(4, 2);
  const A = "#d8a84a";
  const B = "#8a6420";
  [A, A, A, B].forEach((c, x) => cv.set(x, 0, c));
  [B, B, B, B].forEach((c, x) => cv.set(x, 1, c));
  return cv;
}

function buildCrosshair() {
  const cv = new Canvas(24, 24);
  const c = "#e8ffe8";
  cv.rect(11, 11, 2, 2, c); // 中心点
  cv.rect(16, 11, 5, 2, c); // 右
  cv.rect(3, 11, 5, 2, c); // 左
  cv.rect(11, 16, 2, 5, c); // 下
  cv.rect(11, 3, 2, 5, c); // 上
  cv.outline("#000000", true);
  return cv;
}

function buildGrenade() {
  return renderStatic(
    8,
    [
      { t: "ellipse", x: 0.4, y: 0, rx: 1.75, ry: 1.95, c: "#56663a", hi: "#7d8f45", lo: "#3c4a28" },
      { t: "rect", x0: -1.95, y0: -1.2, x1: -1.0, y1: 1.2, c: "#d8a84a", lo: "#8a6420", loAt: -0.2 }
    ],
    { outline: OUTLINE }
  );
}

// ---------------------------------------------------------------- 13. 武器图标

const GREY = { c: "#c8ccd0", hi: "#f0f2f4", lo: "#7a8088" };
const GREY_BACK = { c: "#7a8088", hi: "#c8ccd0", lo: "#4a5058" };
const DARK = "#4a5058";

function pistolShapes(ox, oy, pal) {
  return [
    // 握把（向后下斜）
    { t: "poly", pts: [[ox + 1, oy + 4], [ox + 8, oy + 4], [ox + 6.5, oy + 12.5], [ox - 0.5, oy + 11.5]], ...pal },
    // 扳机护圈
    { t: "seg", x0: ox + 8, y0: oy + 8, x1: ox + 12, y1: oy + 8, w: 1.2, c: pal.lo },
    { t: "seg", x0: ox + 12, y0: oy + 8, x1: ox + 12.5, y1: oy + 5, w: 1.2, c: pal.lo },
    // 枪身（下半）
    { t: "rect", x0: ox + 1, y0: oy + 3, x1: ox + 19, y1: oy + 5.5, ...pal },
    // 套筒
    { t: "rect", x0: ox, y0: oy, x1: ox + 20, y1: oy + 3.5, ...pal },
    // 击锤 / 准星
    { t: "rect", x0: ox - 1.5, y0: oy + 0.5, x1: ox + 0.5, y1: oy + 2.5, c: pal.lo },
    { t: "rect", x0: ox + 17.5, y0: oy - 1, x1: ox + 19, y1: oy, c: pal.c }
  ];
}

function iconTwinPistols() {
  const back = paintBevel(new Canvas(48, 24), pistolShapes(10.5, 3.5, GREY_BACK)).outline(OUTLINE);
  const front = paintBevel(new Canvas(48, 24), pistolShapes(19.5, 8.5, GREY)).outline(OUTLINE);
  back.draw(front, 0, 0);
  return back;
}

function iconShotgun() {
  const s = [
    // 枪托
    { t: "poly", pts: [[3.5, 9.5], [15, 8], [15, 12.5], [4.5, 16.5]], ...GREY },
    { t: "rect", x0: 3, y0: 9.5, x1: 4.4, y1: 16, c: DARK },
    // 机匣
    { t: "rect", x0: 14, y0: 7, x1: 25, y1: 12.5, ...GREY },
    // 握把 + 扳机护圈
    { t: "poly", pts: [[15, 12], [19, 12], [17.5, 16], [14, 15]], ...GREY },
    { t: "seg", x0: 19, y0: 14.5, x1: 22, y1: 14.5, w: 1.1, c: GREY.lo },
    // 枪管 + 管状弹仓
    { t: "rect", x0: 24, y0: 7.5, x1: 46, y1: 10, ...GREY },
    { t: "rect", x0: 24, y0: 10.5, x1: 41, y1: 12.5, ...GREY },
    // 泵动护木（带纹）
    { t: "rect", x0: 28, y0: 10, x1: 37, y1: 14.5, ...GREY },
    { t: "rect", x0: 30, y0: 11, x1: 30.9, y1: 13.8, c: DARK },
    { t: "rect", x0: 32.5, y0: 11, x1: 33.4, y1: 13.8, c: DARK },
    { t: "rect", x0: 35, y0: 11, x1: 35.9, y1: 13.8, c: DARK },
    // 准星
    { t: "rect", x0: 44, y0: 6.3, x1: 45.4, y1: 7.5, c: GREY.c }
  ];
  return paintBevel(new Canvas(48, 24), s).outline(OUTLINE);
}

function iconGrenadeLauncher() {
  const s = [
    // 枪托
    { t: "poly", pts: [[3.5, 9], [12, 8.5], [12, 13], [4.5, 15.5]], ...GREY },
    { t: "rect", x0: 3, y0: 9, x1: 4.4, y1: 15, c: DARK },
    // 机框 + 握把
    { t: "rect", x0: 11, y0: 8, x1: 17, y1: 13, ...GREY },
    { t: "poly", pts: [[12, 12.5], [16, 12.5], [14.5, 18], [11, 17]], ...GREY },
    // 粗管
    { t: "rect", x0: 29, y0: 7, x1: 45, y1: 13.5, ...GREY },
    { t: "rect", x0: 43, y0: 6, x1: 45.5, y1: 14.5, ...GREY },
    // 前握把
    { t: "poly", pts: [[33, 13], [37, 13], [36.5, 18], [33.5, 18]], ...GREY },
    // 转轮弹鼓（胖）
    { t: "rect", x0: 16.5, y0: 6, x1: 30, y1: 18, ...GREY },
    { t: "rect", x0: 19.5, y0: 7, x1: 20.4, y1: 17, c: DARK },
    { t: "rect", x0: 23, y0: 7, x1: 23.9, y1: 17, c: DARK },
    { t: "rect", x0: 26.5, y0: 7, x1: 27.4, y1: 17, c: DARK }
  ];
  return paintBevel(new Canvas(48, 24), s).outline(OUTLINE);
}

function iconMachineGun() {
  const s = [
    // 两脚架（暗示）
    { t: "seg", x0: 37, y0: 12, x1: 34, y1: 20.5, w: 1.2, c: DARK },
    { t: "seg", x0: 37, y0: 12, x1: 40.5, y1: 20.5, w: 1.2, c: DARK },
    // 枪托
    { t: "poly", pts: [[3.5, 8.5], [12, 8], [12, 13.5], [4, 14.5]], ...GREY },
    { t: "rect", x0: 3, y0: 8.5, x1: 4.4, y1: 14.5, c: DARK },
    // 机匣 + 握把
    { t: "rect", x0: 11, y0: 7, x1: 31, y1: 12.5, ...GREY },
    { t: "poly", pts: [[13, 12], [17, 12], [15.5, 17], [12, 16]], ...GREY },
    // 提把
    { t: "rect", x0: 16, y0: 4, x1: 26, y1: 5.6, ...GREY },
    { t: "rect", x0: 16, y0: 4, x1: 17.6, y1: 7.5, ...GREY },
    { t: "rect", x0: 24.4, y0: 4, x1: 26, y1: 7.5, ...GREY },
    // 枪管散热套（带孔）+ 枪管 + 消焰器
    { t: "rect", x0: 30, y0: 9, x1: 43, y1: 11, ...GREY },
    { t: "rect", x0: 30, y0: 8, x1: 38, y1: 12, ...GREY },
    { t: "rect", x0: 32, y0: 9.2, x1: 32.9, y1: 10.8, c: DARK },
    { t: "rect", x0: 34.5, y0: 9.2, x1: 35.4, y1: 10.8, c: DARK },
    { t: "rect", x0: 42, y0: 8, x1: 46, y1: 12, ...GREY },
    // 盒式弹匣
    { t: "poly", pts: [[19, 12], [27, 12], [27.5, 20], [19.5, 20]], ...GREY },
    { t: "rect", x0: 20, y0: 16, x1: 27, y1: 16.8, c: DARK }
  ];
  return paintBevel(new Canvas(48, 24), s).outline(OUTLINE);
}

function buildWeaponIcons() {
  return atlasOf([iconTwinPistols(), iconShotgun(), iconGrenadeLauncher(), iconMachineGun()], 4, 48, 24);
}

// ---------------------------------------------------------------- 导出

export function buildActorArt() {
  return [
    atlasEntry("主角", buildPlayer(), "主角：16 方向 × 4 帧，40×40，帧号 = 行*16 + 方向（方向 d 角度 d*22.5°：0 朝右、4 朝下、8 朝左、12 朝上）；行0 站立，行1 左脚前，行2 并拢，行3 右脚前"),
    atlasEntry("绿蜘蛛", buildSpider(GREEN_SPIDER), "绿蜘蛛（基础虫群）：16 方向 × 4 帧走路循环，32×32，帧号 = 行*16 + 方向；两组腿交替 ±25° 摆动"),
    atlasEntry("黄蜘蛛", buildSpider(YELLOW_SPIDER), "黄蜘蛛（加强型，带背刺）：16 方向 × 4 帧走路循环，32×32，帧号 = 行*16 + 方向"),
    atlasEntry("尸体", buildCorpses(), "尸体/残骸：4×2，32×32，0-1 绿蜘蛛尸体，2-3 黄蜘蛛尸体，4-5 木箱碎片，6-7 焦痕（半透明 alpha 120-200）"),
    atlasEntry("血迹", buildBlood(), "血迹：4×2，32×32，0-3 绿色异形血，4-7 暗红血；半透明（核心 215，边缘 150）"),
    atlasEntry("巢穴", buildNest(), "巢穴（刷怪点）：2×1，64×64，0 常态，1 脉动（肉瘤大一圈、孔洞更亮），两帧交替播放"),
    atlasEntry("枪口火焰", buildMuzzle(), "枪口火焰：4×1，24×24，4 种随机变体，指向右，发射点在 (2,12)，无描边、外圈半透明"),
    atlasEntry("爆炸", buildExplosion(), "爆炸：8×1，64×64，中心 (32,32)；0 闪光，1-2 火球，3 火球碎裂+起烟，4-7 烟环扩散淡出（带余烬）"),
    atlasEntry("火花", buildSparks(), "火花（子弹击中）：4×1，8×8，中心 (4,4)，逐帧缩小"),
    imageEntry("弹壳", buildShell(), "弹壳：4×2 黄铜，右端为底缘"),
    imageEntry("准星", buildCrosshair(), "准星：24×24，中心在 (12,12)，四短线 + 中心点，黑色描边"),
    imageEntry("榴弹", buildGrenade(), "榴弹：8×8，橄榄色弹体 + 黄铜弹带（尾部朝左，头朝右）"),
    atlasEntry("武器图标", buildWeaponIcons(), "武器图标（HUD）：4×1，48×24，侧视朝右；0 双枪，1 泵动霰弹枪，2 榴弹发射器，3 机枪")
  ];
}
