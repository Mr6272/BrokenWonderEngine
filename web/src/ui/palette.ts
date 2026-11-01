/**
 * 画布绘制用的主题色板。
 *
 * 为什么需要这一层：Canvas 2D **不吃 CSS 变量**（`ctx.fillStyle = "var(--x)"` 无效），
 * 而画布区域又必须跟着主题变（奶油底要浅、深夜主题要深）。早先这些颜色是写死的
 * 深色常量，结果切到奶油主题后画布成了整个界面里的"一块黑洞"。
 *
 * 为什么用常量表而不是每帧 getComputedStyle：
 *   - 一次 paint 要读十几处颜色，每帧都读会触发样式重算（编辑器常开时是可观的浪费）；
 *   - 读自定义属性在某些环境返回未解析字符串，会让 fillStyle 静默失效成黑色，
 *     这类"静默失效"最难查 —— 常量表从根上避开这个风险。
 *   值必须与 `web/styles/app.css`（深色/高对比）和 `web/styles/cream.css`（奶油）里的
 *   令牌**保持一致**：改令牌时这里要同步，否则画布和面板会有色差。
 *
 * 切换主题时调 `invalidateCanvasPalette()`（settingsPanel 已经在切主题时调了），
 * 下一次绘制自动换色板。
 */

export interface CanvasPalette {
  /** 画布空白处的底色 */
  bg: string;
  /** 世界场景地图底板（与画布底色区分，让「地图之外」一眼可辨） */
  plate: string;
  /** UI 场景设计稿底板（比底色再"陷"一点） */
  uiPlate: string;
  /** 细网格线 */
  grid: string;
  /** 主网格线（每 8 格） */
  gridMajor: string;
  /** 中轴 / 辅助线 */
  axis: string;
  /** UI 场景的 8px 参考网格（半透明叠加） */
  uiGrid: string;
  /** 选中色 */
  select: string;
  /** 悬停描边色 */
  hover: string;
  /** 正文（画布上的标签文字） */
  text: string;
  /** 次文字（空状态副标题 / HUD） */
  text2: string;
  /** 弱文字（提示性文字） */
  text3: string;
  /** 对象名小底板 */
  labelPlate: string;
  /** 对象名文字 */
  labelText: string;
  /** 属性角标（模块数量）底色 */
  badgeBg: string;
  /** 属性角标文字 */
  badgeText: string;
  /** 对象占位块的描边（当前是深色描边，浅底上要换成浅一点的） */
  placeholderStroke: string;
  /** 占位块上的类型文字 */
  placeholderText: string;
}

/** 深夜靛蓝（原默认深色主题，= app.css 顶部令牌） */
const MIDNIGHT: CanvasPalette = {
  bg: "#15171d",
  plate: "#191c23",
  uiPlate: "#11131a",
  grid: "#22252f",
  gridMajor: "#2c303d",
  axis: "#3a4050",
  uiGrid: "rgba(255,255,255,0.05)",
  select: "#4c8dff",
  hover: "#f0a92b",
  text: "#e6eaf2",
  text2: "#98a2b6",
  text3: "#646d82",
  labelPlate: "rgba(8,10,14,0.72)",
  labelText: "#c4cddb",
  badgeBg: "#4c8dff",
  badgeText: "#ffffff",
  placeholderStroke: "rgba(0,0,0,0.35)",
  placeholderText: "rgba(255,255,255,0.92)"
};

/** 奶油软科技（= cream.css 顶部令牌，浅底主题） */
const CREAM: CanvasPalette = {
  bg: "#f1ece1",
  plate: "#f7f3ea",
  uiPlate: "#efe9dd",
  grid: "#e4ddce",
  gridMajor: "#d7cebb",
  axis: "#c5b9a3",
  // 浅底上的网格不能靠"加白"（等于看不见），改成暖棕极低透明
  uiGrid: "rgba(120,100,70,0.10)",
  select: "#8a6c48",
  hover: "#b07d22",
  text: "#3a352d",
  text2: "#6d6557",
  text3: "#9b9285",
  labelPlate: "rgba(253,251,246,0.86)",
  labelText: "#3a352d",
  badgeBg: "#8a6c48",
  badgeText: "#fbf8f2",
  placeholderStroke: "rgba(90,74,52,0.35)",
  placeholderText: "rgba(58,53,45,0.92)"
};

/** 高对比度（= app.css 的 html.theme-high-contrast 令牌；黑底白线） */
const HIGH_CONTRAST: CanvasPalette = {
  bg: "#000000",
  plate: "#0d0d0d",
  uiPlate: "#050505",
  grid: "#333333",
  gridMajor: "#666666",
  axis: "#999999",
  uiGrid: "rgba(255,255,255,0.10)",
  select: "#00ff00",
  hover: "#ffff00",
  text: "#ffffff",
  text2: "#cccccc",
  text3: "#999999",
  labelPlate: "rgba(0,0,0,0.85)",
  labelText: "#ffffff",
  badgeBg: "#00ff00",
  badgeText: "#000000",
  placeholderStroke: "rgba(255,255,255,0.45)",
  placeholderText: "#ffffff"
};

let cached: CanvasPalette | null = null;
let cachedKey = "";

/**
 * 判定当前主题。
 *
 * 用 documentElement 的 class 而不是读 CSS 变量：类名是切换主题时**主动**写下的标记
 * （settingsPanel / main.ts），拿它最直接，也不需要任何样式解析。
 * 没有 class = 奶油（index.html 上默认写了 theme-cream）。
 */
function themeKey(): string {
  try {
    const cl = document.documentElement.classList;
    if (cl.contains("theme-high-contrast")) return "high-contrast";
    if (cl.contains("theme-midnight")) return "midnight";
    return "cream";
  } catch {
    return "cream";
  }
}

/** 当前主题的画布色板（按主题缓存，切主题后失效）。 */
export function canvasPalette(): CanvasPalette {
  const key = themeKey();
  if (cached && cachedKey === key) return cached;
  cachedKey = key;
  cached = key === "high-contrast" ? HIGH_CONTRAST : key === "midnight" ? MIDNIGHT : CREAM;
  return cached;
}

/** 主题切换后调用（settingsPanel 切主题时会调，缓存随之失效）。 */
export function invalidateCanvasPalette(): void {
  cached = null;
  cachedKey = "";
}
