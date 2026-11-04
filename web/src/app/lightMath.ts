/**
 * 2D 光照烘焙数学 —— **纯函数，不碰 DOM / canvas / store**。
 *
 * 权威契约：`docs/_fragments/lighting-contract.md` §2（编辑器烘焙与 Java 运行时
 * 动态光照**共用同一套公式**，两处只要有一处走样，玩家就会看到"编辑器预览一个样、
 * 进游戏另一个样"）。
 *
 * 为什么单独一个文件、且一行 DOM 都不碰：
 *   1. 这段数学必须能被 `web/tools/ui-checks/verify-lighting.ts` 在 node 里直接跑，
 *      对着仲裁 fixture（`test/fixtures/lighting-case.json`）逐点比对；
 *   2. 它同时是 Java 侧 `LightMap.java` 的对照实现 —— 只有纯函数才可能做到逐位可比。
 *
 * 注意「读取场景数据」的两个 collect* 函数放在这里而不是面板里：它们是
 * §3.3 那套 prop/模块优先级的**唯一实现**，面板、烘焙、未来的运行时预演都从这里取。
 * 复制一份到别处，迟早出现"面板显示半径 200、烘焙按 140 算"的分叉。
 */

import type { Project, SceneModel, SceneObject } from "../core/model.ts";
import { sizeOf } from "./painter.ts";

// ============================================================================
// 输入/输出类型（签名固定，契约 §2 与 §5）
// ============================================================================

/**
 * 一盏光源的**烘焙视图**（已经从对象 props / 模块参数里解算出来的纯数值）。
 *
 * 除了 `id` 与位置，其余字段都可省略：省略即取契约缺省值（§2.3）。
 * 之所以把 id 必填：闪烁相位 `phase = hash01(id)` 靠它，没有稳定 id 就没有确定性。
 */
export interface LightSourceSpec {
  id: string;
  x: number;
  y: number;
  /** 照亮半径（世界像素）。缺省 140；<=0 ⇒ 跳过 */
  radius?: number;
  /** 光色 "#rrggbb"。缺省 #FFC978 */
  color?: string;
  /** 强度 0..4。缺省 1；<=0 ⇒ 整盏跳过 */
  intensity?: number;
  /** point | spot。缺省 point */
  type?: "point" | "spot";
  /** 聚光锥总角度（度，仅 spot）。缺省 60 */
  angle?: number;
  /** 聚光方向（度，0=+x，90=+y 即向下，顺时针）。缺省取对象 rotation */
  dir?: number;
  /** 锥边软化角（度）。缺省 10 */
  coneSoft?: number;
  /** 距离衰减指数 1..4。缺省 2 */
  falloff?: number;
  /** 是否被遮挡体挡光。缺省 true */
  shadow?: boolean;
  /** 闪烁幅度 0..1。**烘焙时按 0 计算**（§2.3 第 7 条） */
  flicker?: number;
  /** true = 不进烘焙，由运行时动态算（§2.3 第 7 条） */
  dynamic?: boolean;
}

/** 一个遮挡体的轴对齐包围盒（中心 + 半宽半高，世界像素）。 */
export interface OccluderSpec {
  x: number;
  y: number;
  hw: number;
  hh: number;
}

/** `bakeLightmap` 的全部输入。 */
export interface BakeInput {
  /** 场景宽（世界像素） */
  width: number;
  /** 场景高（世界像素） */
  height: number;
  /** 采样率：1 世界像素 = 几个纹素。缺省 0.25 */
  texelsPerPixel?: number;
  /** 柔化半径（世界像素，0..128）。缺省 16 */
  softness?: number;
  /** 环境光色 "#rrggbb"。缺省 #3A4A6B */
  ambientColor?: string;
  /** 环境光强度 0..1。缺省 0.35 */
  ambientIntensity?: number;
  lights?: LightSourceSpec[];
  occluders?: OccluderSpec[];
}

/** `bakeLightmap` 的产物：**已 clamp 到 0..1** 的 RGB 网格（长度 texW*texH*3，无 alpha）。 */
export interface BakeResult {
  texW: number;
  texH: number;
  /** 实际采样率（可能因 2048 上限被缩小，运行时按它反推纹素中心） */
  sEff: number;
  rgb: Float32Array;
  /** 本次烘焙耗时（毫秒，仅用于面板统计） */
  ms: number;
}

// ============================================================================
// 小工具
// ============================================================================

const DEG = Math.PI / 180;

/** 缺省环境光色（契约 §2.2）。 */
export const DEFAULT_AMBIENT_COLOR = "#3A4A6B";
/** 缺省环境光强度（契约 §2.2）。 */
export const DEFAULT_AMBIENT_INTENSITY = 0.35;
/** 贴图长边上限（契约 §2.1）。 */
export const MAX_TEX = 2048;

/**
 * `#rrggbb` / `#rgb` → [r,g,b]（0..1）。非法输入返回 null，由调用方决定兜底 ——
 * 不在这里静默变黑：一个手抖打错的颜色（`#FFC97`）应该让人看到兜底白光，
 * 而不是整张图突然没光。
 */
export function parseHexColor(s: unknown): [number, number, number] | null {
  const t = String(s ?? "").trim();
  if (!t.startsWith("#")) return null;
  const hex = t.slice(1);
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r / 255, g / 255, b / 255];
  }
  if (hex.length !== 6) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return [r / 255, g / 255, b / 255];
}

/** 颜色 → `#rrggbb`（面板色板回填用；非法输入回退到缺省）。 */
export function normalizeHexColor(s: unknown, fallback = "#FFFFFF"): string {
  const rgb = parseHexColor(s);
  if (!rgb) return fallback;
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `#${to(rgb[0]).toString(16).padStart(2, "0")}${to(rgb[1]).toString(16).padStart(2, "0")}${to(rgb[2]).toString(16).padStart(2, "0")}`.toUpperCase();
}

/**
 * 契约 §2.7 的确定性哈希：对字符串按 UTF-16 码元 `h = h*31 + code`（32 位无符号回绕），
 * 取 `(h % 100000) / 100000`。
 *
 * 用途只有一个：闪烁相位。它必须与 Java 侧算出一模一样的结果，否则同一盏火把
 * 在编辑器预览与游戏里的抖动节奏会错开 —— 所以这里**不许换算法**（连乘法常数都不许）。
 */
export function hash01(id: string): number {
  let h = 0;
  const s = String(id ?? "");
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** 角度归一化到 (-π, π]。 */
function normPi(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v <= -Math.PI) v += Math.PI * 2;
  return v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function num(v: unknown, def: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

// ============================================================================
// 契约 §2.4：线段 × AABB（slab 法）
// ============================================================================

/**
 * 线段 `(ax,ay)→(bx,by)` 是否与中心 `(cx,cy)`、半宽高 `(hw,hh)` 的矩形相交。
 *
 * 纪律（照抄契约，不许"优化成直觉"）：
 *   - 交点参数必须落在 **(0,1) 开区间**：灯贴着墙、或目标点就贴在墙面上时不算遮挡。
 *     否则墙边的灯会整个熄掉、墙里的物件会全黑，玩家看到的是"灯坏了"。
 *   - 零长度的轴（dx≈0）退化成"是否落在 slab 跨度内"，避免除零。
 */
export function segmentHitsBox(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let tmin = 0;
  let tmax = 1;

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

  return tmax > 1e-5 && tmin < 1 - 1e-5;
}

// ============================================================================
// 契约 §2.3：单盏光在某点的贡献
// ============================================================================

const ZERO3: readonly [number, number, number] = [0, 0, 0];

/**
 * 单盏光在世界点 `(px,py)` 的**线性**贡献 `[r,g,b]`（未 clamp、未含环境光）。
 *
 * 与契约 §2.3 逐条对应，顺序也一致（累加顺序影响浮点尾数，契约要求下标顺序，
 * 而"单盏内"的乘法顺序同样会差 1 个 ulp —— 所以这里按契约的文字顺序写，不合并同类项）。
 */
function lightContribution(
  light: LightSourceSpec,
  px: number,
  py: number,
  occluders: readonly OccluderSpec[]
): readonly [number, number, number] {
  const radius = num(light.radius, 140);
  if (!(radius > 0)) return ZERO3;
  const intensity = num(light.intensity, 1);
  if (!(intensity > 0)) return ZERO3; // 整盏跳过，避免 -0 之类的差异

  const lx = num(light.x, 0);
  const ly = num(light.y, 0);
  const color = parseHexColor(light.color) ?? [1, 1, 1];

  const dx = px - lx;
  const dy = py - ly;
  const d = Math.sqrt(dx * dx + dy * dy);
  const t = d / radius;
  if (t >= 1) return ZERO3;

  // 衰减指数夹在 1..4（契约允许 1..4；越界值就近夹，而不是拒绝整盏）
  const falloff = Math.min(4, Math.max(1, num(light.falloff, 2)));
  let atten = Math.pow(1 - t, falloff);

  // 聚光：0 度 = +x，90 度 = 向下（Y 向下，所以顺时针为正）
  if ((light.type ?? "point") === "spot") {
    const angleDeg = num(light.angle, 60);
    const halfRad = (angleDeg / 2) * DEG;
    const dirRad = num(light.dir, 0) * DEG;
    const angRad = Math.atan2(dy, dx);
    const diff = Math.abs(normPi(angRad - dirRad));
    if (diff > halfRad) return ZERO3;
    const softRad = Math.max(0, num(light.coneSoft, 10)) * DEG;
    if (softRad > 0 && diff > halfRad - softRad) {
      atten *= Math.max(0, Math.min(1, (halfRad - diff) / softRad));
    }
  }

  // 阴影（挡光）：线段与任一遮挡体相交即整盏贡献归零
  if (num2bool(light.shadow, true)) {
    for (const oc of occluders) {
      if (segmentHitsBox(lx, ly, px, py, num(oc.x, 0), num(oc.y, 0), num(oc.hw, 0), num(oc.hh, 0))) {
        return ZERO3;
      }
    }
  }

  const scale = intensity * atten;
  return [color[0] * scale, color[1] * scale, color[2] * scale];
}

/** `"0"` / `0` / `false` 视为假；其余（含缺省）按 `def`。 */
function num2bool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === "0" || s === "false" || s === "") return false;
  return true;
}

// ============================================================================
// 契约 §2.5：柔化（2 遍方框模糊，边界按有效像素归一）
// ============================================================================

/**
 * 对 RGB 网格做 2 遍方框模糊（每遍：横向 + 纵向；边界按窗口内**有效**像素数归一，
 * 不外推）。半径 `radiusTexels` 先 `round` —— 契约里算半径用的是
 * `max(0, round(softness * sEff))`，这里保持同一步。
 *
 * 能量：因为每个源像素被归一化权重分到它参与的每个输出窗口，**整幅能量守恒**
 * （边界窗口的有效像素少、分母同步变小）。自检里断言 ±1%。
 *
 * 返回值是新数组（不改入参）：烘焙时"光源累加"和"柔化后"两份都要，原地改会互相污染。
 */
export function blurRgb(rgb: Float32Array, texW: number, texH: number, radiusTexels: number): Float32Array {
  const r = Math.max(0, Math.round(num(radiusTexels, 0)));
  if (r <= 0 || texW <= 0 || texH <= 0) return rgb;

  let src = Float32Array.from(rgb);
  let dst = new Float32Array(rgb.length);
  const rw = r * 2 + 1;

  for (let pass = 0; pass < 2; pass++) {
    // ---- 横向：src → dst ----
    for (let j = 0; j < texH; j++) {
      const row = j * texW;
      // 滑窗和：先算 i=0 的窗口，之后每步加右端、减左端。
      // 逐点内层循环在 2048×2048、r=32 时是几十亿次加法 —— 编辑器会在点「烘焙」时僵住。
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        if (k < 0) continue;
        if (k >= texW) break;
        const o = (row + k) * 3;
        sr += src[o];
        sg += src[o + 1];
        sb += src[o + 2];
        n++;
      }
      for (let i = 0; i < texW; i++) {
        const o = (row + i) * 3;
        dst[o] = sr / n;
        dst[o + 1] = sg / n;
        dst[o + 2] = sb / n;
        // 右移一格：把 i+r+1 加进来、把 i-r 移出去
        const addI = i + r + 1;
        if (addI < texW) {
          const ao = (row + addI) * 3;
          sr += src[ao];
          sg += src[ao + 1];
          sb += src[ao + 2];
          n++;
        }
        const subI = i - r;
        if (subI >= 0) {
          const so = (row + subI) * 3;
          sr -= src[so];
          sg -= src[so + 1];
          sb -= src[so + 2];
          n--;
        }
      }
    }

    // ---- 纵向：dst → src ----
    for (let i = 0; i < texW; i++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let k = 0; k <= r; k++) {
        if (k >= texH) break;
        const o = (k * texW + i) * 3;
        sr += dst[o];
        sg += dst[o + 1];
        sb += dst[o + 2];
        n++;
      }
      for (let j = 0; j < texH; j++) {
        const o = (j * texW + i) * 3;
        src[o] = sr / n;
        src[o + 1] = sg / n;
        src[o + 2] = sb / n;
        const addJ = j + r + 1;
        if (addJ < texH) {
          const ao = (addJ * texW + i) * 3;
          sr += dst[ao];
          sg += dst[ao + 1];
          sb += dst[ao + 2];
          n++;
        }
        const subJ = j - r;
        if (subJ >= 0) {
          const so = (subJ * texW + i) * 3;
          sr -= dst[so];
          sg -= dst[so + 1];
          sb -= dst[so + 2];
          n--;
        }
      }
    }

    if (pass === 0) {
      // 第二遍要读上一遍结果：把 src 里刚写好的纵向量拷进 dst 作输入
      dst = Float32Array.from(src);
    }
  }
  void rw;
  return src;
}

// ============================================================================
// 契约 §2 主流程
// ============================================================================

/**
 * 烘焙一张光照贴图。**纯函数**：同一输入必得逐像素相同输出（§2.7 确定性）。
 *
 * 顺序严格照契约 §2：
 *   1. 尺寸：`texW = clamp(round(W*s), 1, 2048)`，超过 2048 时整图等比缩小，
 *      `sEff = min(texW/W, texH/H)` 写进结果（运行时按它反推，不重算）；
 *   2. 每纹素世界中心 `((i+0.5)/sEff, (j+0.5)/sEff)`；
 *   3. `acc = ambient`，然后**按 lights 数组下标顺序**逐盏累加；
 *   4. 柔化只作用于"光源累加部分"，环境光不参与（§2.5）；
 *   5. 最后逐通道 `clamp(0,1)`。
 *
 * `lightDynamic="1"` 的光源完全不进烘焙（连环境光叠加都不做）—— 这里过滤，
 * 而不是让调用方事先筛掉：过滤规则属于数学契约的一部分，放在两处一定会分叉。
 */
export function bakeLightmap(input: BakeInput): BakeResult {
  const started = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

  const W = Math.max(1, num(input.width, 1));
  const H = Math.max(1, num(input.height, 1));
  const s = num(input.texelsPerPixel, 0.25);
  const s0 = s > 0 ? s : 0.25;

  let texW = Math.max(1, Math.round(W * s0));
  let texH = Math.max(1, Math.round(H * s0));
  let sEff = Math.min(texW / W, texH / H);
  // 2048 上限：整张图按**同一比例**缩小（保持长边 ≤ 2048），否则宽高比会变，
  // 运行时按 sEff 反推出的世界坐标就会错位（光斑挪位比变糊更难接受）。
  if (texW > MAX_TEX || texH > MAX_TEX) {
    const shrink = Math.min(MAX_TEX / texW, MAX_TEX / texH);
    texW = Math.max(1, Math.round(texW * shrink));
    texH = Math.max(1, Math.round(texH * shrink));
    sEff = Math.min(texW / W, texH / H);
  }

  const ambientColor = parseHexColor(input.ambientColor) ?? parseHexColor(DEFAULT_AMBIENT_COLOR)!;
  const ambientIntensity = num(input.ambientIntensity, DEFAULT_AMBIENT_INTENSITY);
  const ar = ambientColor[0] * ambientIntensity;
  const ag = ambientColor[1] * ambientIntensity;
  const ab = ambientColor[2] * ambientIntensity;

  const occluders = input.occluders ?? [];
  // 动态光不进烘焙（§2.3 第 7 条）。flicker 光源照常进烘焙，但按 flicker=0 计算
  //   —— 烘焙图是静态底图，抖动交给运行时动态层；这里不改 light 的参数，
  //   因为 lightContribution 本来就不用 flicker（静态烘焙的唯一正确做法）。
  const lights = (input.lights ?? []).filter((l) => l && !num2bool(l.dynamic, false));

  // 只累加"光源部分"，环境光留到最后加（契约 §2.5：柔化不影响环境光基底）
  //
  // 性能：逐「光源」遍历它自己覆盖的纹素矩形，而不是逐纹素遍历全部光源。
  // 这是契约 §2.3 明确允许的裁剪（"允许按逐光源遍历纹素实现（性能），
  // 只要对每个纹素而言累加顺序仍是那个下标顺序"），而且**不改变结果**：
  // 半径外的纹素贡献恒为 0，跳过它等价于加 0（但省掉了 sqrt/atan2/遮挡判定）。
  //
  // ⚠ 累加顺序必须仍按下标顺序：外层循环是 light 下标，所以纹素 (i,j) 收到的
  //   仍是 light[0]、light[1]…… 的顺序（同一盏灯的 r/g/b 三通道独立累加）。
  const rgb = new Float32Array(texW * texH * 3);

  // 先把每盏灯的"纹素包围盒"算好：世界圆心 ± 半径 → 纹素下标范围（含边界像素中心）。
  // 半径 <= 0 或强度 <= 0 的灯直接剔除（贡献恒 0），不占循环。
  interface Box { light: LightSourceSpec; i0: number; i1: number; j0: number; j1: number }
  const boxes: Box[] = [];
  for (const light of lights) {
    const radius = num(light.radius, 140);
    const intensity = num(light.intensity, 1);
    if (!(radius > 0) || !(intensity > 0)) continue; // 与 lightContribution 的早退条件一致
    const lx = num(light.x, 0);
    const ly = num(light.y, 0);
    // 纹素中心 (i+0.5)/sEff 落在 [lx-radius, lx+radius] 内 ⇒
    //   i ∈ [ (lx-radius)*sEff - 0.5, (lx+radius)*sEff - 0.5 ]
    // 往外各扩 1 个纹素做安全边（浮点边界上少算一格就会在光斑边缘留一道直边）。
    const i0 = Math.max(0, Math.ceil((lx - radius) * sEff - 0.5) - 1);
    const i1 = Math.min(texW - 1, Math.floor((lx + radius) * sEff - 0.5) + 1);
    const j0 = Math.max(0, Math.ceil((ly - radius) * sEff - 0.5) - 1);
    const j1 = Math.min(texH - 1, Math.floor((ly + radius) * sEff - 0.5) + 1);
    if (i0 > i1 || j0 > j1) continue; // 整盏灯落在贴图外
    boxes.push({ light, i0, i1, j0, j1 });
  }

  // ★ 顺序纪律：boxes 是按下标顺序 push 的，逐灯写回 ⇒ 每个纹素的累加顺序仍是原下标顺序。
  //   这里**不能**按包围盒大小重排（看起来更省，但会改浮点尾数，与 Java 端不再逐位一致）。
  for (const box of boxes) {
    const { light, i0, i1, j0, j1 } = box;
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) / sEff;
      const row = j * texW;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) / sEff;
        const c = lightContribution(light, px, py, occluders);
        if (c === ZERO3) continue; // 半径外/锥外/被挡：加 0 就是什么都不做
        const o = (row + i) * 3;
        rgb[o] += c[0];
        rgb[o + 1] += c[1];
        rgb[o + 2] += c[2];
      }
    }
  }

  const softness = Math.max(0, Math.min(128, num(input.softness, 16)));
  let out: Float32Array = rgb;
  const radiusTexels = Math.max(0, Math.round(softness * sEff));
  if (radiusTexels > 0) out = blurRgb(rgb, texW, texH, radiusTexels);

  for (let o = 0; o < out.length; o += 3) {
    out[o] = clamp01(out[o] + ar);
    out[o + 1] = clamp01(out[o + 1] + ag);
    out[o + 2] = clamp01(out[o + 2] + ab);
  }

  const ended = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  return { texW, texH, sEff, rgb: out, ms: Math.max(0, ended - started) };
}

/**
 * 浮点 RGB → 不透明 RGBA 字节（`A` 恒 255）。
 *
 * 为什么 alpha 恒 255 而不是"按亮度给 alpha"：运行时"加光"用的是
 * `glBlendFunc(GL_SRC_ALPHA, GL_ONE)`（Android 的 GL2Compat 只认三种混合因子，见契约 §0.2），
 * `A=255` ⇒ 直接加 RGB；没有光的纹素 RGB=(0,0,0) ⇒ 加 0，完全无副作用。
 */
export function toRgbaBytes(rgb: Float32Array): Uint8ClampedArray {
  const n = Math.floor(rgb.length / 3);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const d = i * 4;
    out[d] = Math.round(clamp01(rgb[o]) * 255);
    out[d + 1] = Math.round(clamp01(rgb[o + 1]) * 255);
    out[d + 2] = Math.round(clamp01(rgb[o + 2]) * 255);
    out[d + 3] = 255;
  }
  return out;
}

// ============================================================================
// 契约 §3.3：从场景读出光源与遮挡体
// ============================================================================

/** `look.light`（桌面旧 id）与 `render.light`（Web 编辑器 id）都认。 */
const LIGHT_MODULE_IDS = ["render.light", "look.light"];

/** 判定一个对象是不是光源：LIGHT 类型 / 带 light 模块 / `props.lightRadius > 0`。 */
export function isLightObject(o: SceneObject): boolean {
  if (o.kind === "LIGHT") return true;
  if (Array.isArray(o.modules) && o.modules.some((m) => m.enabled !== false && LIGHT_MODULE_IDS.indexOf(m.defId) >= 0)) {
    return true;
  }
  return numProp(o, "lightRadius", 0) > 0;
}

function propOf(o: SceneObject, key: string): string {
  const v = o.props?.[key];
  return v == null ? "" : String(v).trim();
}

function numProp(o: SceneObject, key: string, def: number): number {
  const raw = propOf(o, key);
  if (raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

/** 找对象上第一盏启用的 light 模块（`render.light` 优先于 `look.light`）。 */
function lightModuleOf(o: SceneObject): { values: Record<string, string> } | null {
  if (!Array.isArray(o.modules)) return null;
  for (const id of LIGHT_MODULE_IDS) {
    const m = o.modules.find((x) => x.defId === id && x.enabled !== false);
    if (m) return m;
  }
  return null;
}

/**
 * 契约 §3.3：把场景里的光源解算成烘焙视图。
 *
 * 读取规则（**逐字**按契约，不许"改进"）：
 *   - 光源判据：`kind==="LIGHT"`，或任意带 `look.light`/`render.light` 模块的对象，
 *     或 `props.lightRadius > 0`；
 *   - 模块存在时**优先于 props**：`radius→lightRadius`、`color→lightColor`、
 *     `strength`/`intensity`→`lightIntensity`、`flicker`（bool）→`lightFlicker=0.25`；
 *   - `lightColor` 缺省回退 `props.color`，再回退 `#FFC978`；
 *   - `lightDir` 缺省取对象 `rotation`（聚光方向跟着对象朝向走，这是编辑器里最直观的设定）。
 */
export function collectSceneLighting(scene: SceneModel | null | undefined, project: Project | null | undefined): LightSourceSpec[] {
  if (!scene || !Array.isArray(scene.objects)) return [];
  const out: LightSourceSpec[] = [];
  void project; // 光源不需要素材尺寸；留着参数是为了与 collectSceneOccluders 同型（调用处统一写）

  for (const o of scene.objects) {
    if (!o || o.visible === false) continue;
    if (!isLightObject(o)) continue;

    const mod = lightModuleOf(o);
    const v = mod?.values ?? {};

    // 半径：模块 radius 优先于 props.lightRadius，再缺省 140
    let radius = numProp(o, "lightRadius", 140);
    if (mod && String(v.radius ?? "").trim() !== "") {
      const n = Number(v.radius);
      if (Number.isFinite(n) && n > 0) radius = n;
    }

    // 颜色：模块 color > props.lightColor > props.color > 缺省
    let color = propOf(o, "lightColor") || propOf(o, "color") || "#FFC978";
    if (mod && String(v.color ?? "").trim() !== "" && parseHexColor(v.color)) color = String(v.color).trim();

    // 强度：模块 strength/intensity > props.lightIntensity > 1
    let intensity = numProp(o, "lightIntensity", 1);
    if (mod) {
      const raw = String(v.strength ?? v.intensity ?? "").trim();
      if (raw !== "") {
        const n = Number(raw);
        if (Number.isFinite(n)) intensity = n;
      }
    }

    const type = propOf(o, "lightType").toLowerCase() === "spot" ? "spot" : "point";
    const angle = numProp(o, "lightAngle", 60);
    const dir = numProp(o, "lightDir", num(o.rotation, 0));
    const coneSoft = numProp(o, "lightConeSoft", 10);
    const falloff = numProp(o, "lightFalloff", 2);
    const shadow = num2bool(propOf(o, "lightShadow") || undefined, true);
    let flicker = numProp(o, "lightFlicker", 0);
    // 模块的 flicker 是 bool：true ⇒ 0.25（契约 §3.3 模块映射表）
    if (mod && (v.flicker === "true" || v.flicker === "1" || v.flicker === true as unknown as string)) {
      flicker = 0.25;
    }
    const dynamic = num2bool(propOf(o, "lightDynamic") || undefined, false);

    out.push({
      id: o.id,
      x: num(o.x, 0),
      y: num(o.y, 0),
      radius,
      color,
      intensity,
      type,
      angle,
      dir,
      coneSoft,
      falloff,
      shadow,
      flicker,
      dynamic
    });
  }
  return out;
}

/** 契约 §2.4 的遮挡体判据（显式 `lightBlock` 优先于 tags）。 */
export function isOccluderObject(o: SceneObject): boolean {
  const block = propOf(o, "lightBlock");
  if (block === "0") return false; // 显式关闭优先
  if (block === "1") return true;
  const tags = Array.isArray(o.tags) ? o.tags : [];
  return tags.indexOf("wall") >= 0 || tags.indexOf("occluder") >= 0 || tags.indexOf("lightblock") >= 0;
}

/**
 * 契约 §2.4：把场景里的遮挡体解算成 AABB。
 *
 * 尺寸**必须复用 `painter.sizeOf`** —— 它就是"编辑器眼里这个对象有多大"的唯一真相
 * （碰撞体 / props.w-h / 素材像素 / 图集 cellW-cellH / 一格兜底，含 scaleX/scaleY）。
 * 在这里再算第二遍，结果一定是"画布上框这么大、阴影却按另一个尺寸挡"，
 * 用户永远查不出来。
 *
 * 半宽半高取 `sizeOf(...)/2`：契约的优先级链（halfW > props.w/h > 素材像素 > tileSize）
 * 与 sizeOf 完全一致；差别只在一处 —— 契约说"再乘 scaleX/scaleY"，而 sizeOf 对
 * halfW 分支不乘缩放（编辑器画布同样不乘，见 painter 的选中框绘制）。
 * 这里跟 sizeOf 走，保证"画布上看到的碰撞框 = 实际挡光的框"。
 */
export function collectSceneOccluders(scene: SceneModel | null | undefined, project: Project | null | undefined): OccluderSpec[] {
  if (!scene || !Array.isArray(scene.objects) || !project) return [];
  const out: OccluderSpec[] = [];
  for (const o of scene.objects) {
    if (!o || o.visible === false) continue;
    if (!isOccluderObject(o)) continue;
    const size = sizeOf(o, project);
    out.push({
      x: num(o.x, 0),
      y: num(o.y, 0),
      hw: Math.max(1, size.w / 2),
      hh: Math.max(1, size.h / 2)
    });
  }
  return out;
}

/**
 * 把 `scene.lighting` + 场景内容拼成一份 `BakeInput`。
 *
 * 单独抽出来而不是塞进 lightBake：自检（`verify-lighting.ts`）要能对着**构造的**
 * 场景跑一遍"读取规则 → 数学"，两段分开就没法在一个断言里覆盖。
 */
export function bakeInputFromScene(
  scene: SceneModel,
  project: Project,
  tileSize: number
): { ok: true; input: BakeInput } | { ok: false; error: string } {
  const lighting = scene.lighting;
  if (!lighting || lighting.enabled !== true) {
    return { ok: false, error: "这张场景的光照总开关没打开（先在上面把「启用 2D 光照」打开）" };
  }
  const width = Math.max(1, Math.round(scene.widthTiles * Math.max(4, tileSize || 32)));
  const height = Math.max(1, Math.round(scene.heightTiles * Math.max(4, tileSize || 32)));
  const lights = collectSceneLighting(scene, project);
  return {
    ok: true,
    input: {
      width,
      height,
      texelsPerPixel: lighting.texelsPerPixel,
      softness: lighting.softness,
      ambientColor: lighting.ambientColor,
      ambientIntensity: lighting.ambientIntensity,
      lights,
      occluders: collectSceneOccluders(scene, project)
    }
  };
}
