/**
 * 场景绘制器。
 *
 * 与画布分开的理由：导出缩略图、场景预览、将来小地图都要复用同一套画法，
 * 复制一份必然走样。这里只负责"把数据画出来"，不处理任何输入。
 *
 * 坐标约定：世界坐标 X 向右、Y 向下，1 单位 = 1 像素（与运行时一致）。
 * 尺寸优先级：碰撞体 halfW/halfH > props.w/h > 素材原始尺寸 > 一格。
 */

import type { AssetEntry, Project, SceneObject, SceneModel } from "../core/model.ts";
import { scenePixelSize, totalFrames, uiSafeArea, visibleFrames } from "../core/model.ts";
import { loadFrame } from "../data/assets.ts";

export interface PaintCtx {
  project: Project;
  zoom: number;
  tileSize: number;
  showGrid: boolean;
  showColliders: boolean;
  showZones: boolean;
  showNames: boolean;
  time: number;
  selectedIds: Set<string>;
  overrides: Map<string, { x: number; y: number }>;
  /**
   * true = 当前场景是 UI 场景。
   *
   * 差别只有一处：UI 对象里的「文字（label）」要按字号/对齐真正渲染成文字，
   * 而不是画成灰块占位 —— 否则用户在 UI 场景里摆文字等于盲摆。
   */
  ui?: boolean;
}

/** 文字对象的判定：tags 含 `label`（与运行时 TopDownRuntime.drawActor 同一判据）。 */
export function isLabelObject(o: { tags: string[] }): boolean {
  return Array.isArray(o.tags) && o.tags.indexOf("label") >= 0;
}

function propOf(o: SceneObject, key: string): string {
  const v = o.props?.[key];
  return v == null ? "" : String(v).trim();
}

function numPropOf(o: SceneObject, key: string, def: number): number {
  const v = Number(propOf(o, key));
  return Number.isFinite(v) && v > 0 ? v : def;
}

/**
 * 文字对象在**设计分辨率**里的近似绘制尺寸。
 *
 * 用一块离屏 canvas 实测（委托给浏览器自己的字体度量），而不是按字符数估算 ——
 * 中英文混排、字重都会让估算偏得很远，选择框和行内对齐就会跟着错。
 * 编辑器与运行时各自的度量略有差异是可以接受的：运行时按真实字体渲染，
 * 这里只用于**选中框 / 命中测试 / 框选**，不参与导出数据。
 */
let measureCtx: CanvasRenderingContext2D | null = null;

function labelSize(o: SceneObject): { w: number; h: number } {
  const text = propOf(o, "text") || "文字";
  const size = numPropOf(o, "textSize", 24);
  if (!measureCtx) {
    const c = document.createElement("canvas");
    measureCtx = c.getContext("2d");
  }
  let w = text.length * size * 0.62;
  let h = size * 1.35;
  if (measureCtx) {
    measureCtx.font = `${size}px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`;
    const m = measureCtx.measureText(text);
    w = Math.max(4, m.width);
    h = Math.max(4, size * 1.35);
  }
  return { w, h };
}

export type ToScreen = (x: number, y: number) => { x: number; y: number };

/** 图片就绪后的回调，用于触发一次重绘（首次加载完成时） */
let onPictureReady: (() => void) | null = null;

export function setPictureReadyHandler(fn: () => void): void {
  onPictureReady = fn;
}

interface Picture {
  /** canvas 的 drawImage 接受 ImageBitmap / HTMLImageElement / HTMLCanvasElement 等 */
  image: CanvasImageSource;
  w: number;
  h: number;
}

const pictures = new Map<string, Picture>();
const pending = new Set<string>();

function pictureOf(asset: AssetEntry, frame: number): Picture | null {
  const key = `${asset.id}#${frame}`;
  const hit = pictures.get(key);
  if (hit) return hit;
  if (!pending.has(key)) {
    pending.add(key);
    void loadFrame(asset, frame).then((img) => {
      pending.delete(key);
      if (img) {
        pictures.set(key, { image: img.bitmap, w: img.width, h: img.height });
        trimPictures();
        onPictureReady?.();
      }
    });
  }
  return null;
}

/**
 * 绘制用的位图引用表。
 *
 * 这里**只持引用、不持所有权**：真正的 ImageBitmap 由 data/assets.ts 的 loadFrame 缓存负责，
 * 也由它负责 close。所以这里淘汰时只能删键，绝不能 close —— 关掉别人还在用的位图，
 * 画布就会在 drawImage 上抛 InvalidStateError。
 * 加容量上限只是防止「滑过很多素材的很多帧」时这张表无限涨（每个键很小，但条目多了也占内存）。
 */
const MAX_PICTURES = 600;

export function forgetPicture(assetId: string): void {
  for (const k of Array.from(pictures.keys())) if (k.startsWith(assetId + "#")) pictures.delete(k);
}

/** 超上限按最久未用淘汰（Map 插入顺序即访问顺序）。 */
function trimPictures(): void {
  while (pictures.size > MAX_PICTURES) {
    const oldest = pictures.keys().next();
    if (oldest.done) break;
    pictures.delete(oldest.value);
  }
}

/** 素材的像素尺寸；没有图片信息时返回 null，由调用方决定兜底值。 */
export function assetPixelSize(asset: AssetEntry | undefined): { w: number; h: number } | null {
  if (!asset) return null;
  if (asset.kind === "ATLAS" && asset.cellW && asset.cellH) {
    return { w: asset.cellW, h: asset.cellH };
  }
  if (asset.width > 0 && asset.height > 0) {
    return { w: asset.width, h: asset.height };
  }
  const cached = pictures.get(`${asset.id}#0`);
  if (cached) return { w: cached.w, h: cached.h };
  return null;
}

/** 对象在世界坐标中的绘制尺寸。 */
export function sizeOf(o: SceneObject, project: Project): { w: number; h: number } {
  // ★ 文字对象优先按真实字形度量：它没有素材、通常也不设 halfW，
  //   落到兜底分支会变成「一格大小」的方块，用户摆好的文字一选中框就对不上。
  if (isLabelObject(o)) {
    const s = labelSize(o);
    return { w: s.w * o.scaleX, h: s.h * o.scaleY };
  }
  if (o.halfW > 0 || o.halfH > 0) {
    const w = o.halfW > 0 ? o.halfW * 2 : 16;
    const h = o.halfH > 0 ? o.halfH * 2 : 16;
    return { w: Math.max(4, w), h: Math.max(4, h) };
  }
  const propW = Number(o.props.w);
  const propH = Number(o.props.h);
  if (Number.isFinite(propW) && propW > 0 && Number.isFinite(propH) && propH > 0) {
    return { w: propW * o.scaleX, h: propH * o.scaleY };
  }
  const asset = project.assets.find((a) => a.id === o.assetId);
  const px = assetPixelSize(asset);
  if (px) return { w: px.w * o.scaleX, h: px.h * o.scaleY };
  const t = project.tileSize;
  return { w: t * o.scaleX, h: t * o.scaleY };
}

export function boundsOf(o: SceneObject, project: Project): { x: number; y: number; w: number; h: number } {
  const s = sizeOf(o, project);
  return { x: o.x - s.w / 2, y: o.y - s.h / 2, w: s.w, h: s.h };
}

// ---------------- 网格 ----------------

/**
 * UI 场景底板：设备画框 + 安全区 + 可选 8px 参考网格。
 *
 * 为什么不复用 paintGrid：UI 的坐标系不是「格 × tileSize」，
 * 它的「地图」就是设计分辨率本身（1280×720 这种）。用瓦片网格画 UI
 * 会让用户以为「一格 32 像素」仍然生效，摆位时按格吸附就会和运行时的
 * 等比 contain 变换对不上。这里改成：外框 = 设计分辨率的 100%，
 * 内框 = 5% 安全区，网格线斜率不变但间距按 8 像素（对齐常用倍数）。
 */
export function paintUiFrame(
  g: CanvasRenderingContext2D,
  scene: SceneModel,
  pctx: PaintCtx,
  toScreen: ToScreen
): void {
  const size = scenePixelSize(scene, pctx.tileSize);
  const a = toScreen(0, 0);
  const b = toScreen(size.w, size.h);
  const zoom = pctx.zoom;

  g.save();
  // 设计分辨率底板：比编辑器背景亮一点，明确「这是画面区域」
  g.fillStyle = "#11131a";
  g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);

  if (pctx.showGrid && zoom > 0.15) {
    // 8px 参考网格：UI 里 8 的倍数是通用节奏（间距 8/16/24），比 32 更有用。
    const step = 8;
    g.lineWidth = 1;
    g.strokeStyle = "rgba(255,255,255,0.05)";
    g.beginPath();
    for (let x = 0; x <= size.w; x += step * (zoom < 0.5 ? 8 : 2)) {
      const p0 = toScreen(x, 0);
      const p1 = toScreen(x, size.h);
      g.moveTo(Math.round(p0.x) + 0.5, p0.y);
      g.lineTo(Math.round(p1.x) + 0.5, p1.y);
    }
    for (let y = 0; y <= size.h; y += step * (zoom < 0.5 ? 8 : 2)) {
      const p0 = toScreen(0, y);
      const p1 = toScreen(size.w, y);
      g.moveTo(p0.x, Math.round(p0.y) + 0.5);
      g.lineTo(p1.x, Math.round(p1.y) + 0.5);
    }
    g.stroke();
  }

  // 安全区（四周 5%）：手机刘海 / 圆角 / 系统手势区常在这里，摆关键 UI 别越线
  const safe = uiSafeArea(scene);
  const sa = toScreen(safe.x, safe.y);
  const sb = toScreen(safe.x + safe.w, safe.y + safe.h);
  g.strokeStyle = "rgba(46,204,143,0.55)";
  g.lineWidth = 1.2;
  g.setLineDash([5, 4]);
  g.strokeRect(sa.x, sa.y, sb.x - sa.x, sb.y - sa.y);
  g.setLineDash([]);
  g.fillStyle = "rgba(46,204,143,0.85)";
  g.font = '11px "Microsoft YaHei UI", sans-serif';
  g.fillText("安全区 Safe Area", sa.x + 4, sa.y + 13);

  // 设计分辨率外框：这是运行时等比 contain 的真实边界，越界的内容会被裁掉
  g.strokeStyle = "rgba(76,141,255,0.8)";
  g.lineWidth = 1.5;
  g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  g.fillStyle = "rgba(76,141,255,0.9)";
  g.font = '11px "Microsoft YaHei UI", sans-serif';
  g.fillText(`${size.w} × ${size.h}（设计分辨率）`, a.x + 4, a.y - 5);
  g.restore();
}

export function paintGrid(
  g: CanvasRenderingContext2D,
  _ctx: CanvasRenderingContext2D | undefined,
  scene: SceneModel,
  pctx: PaintCtx,
  toScreen: ToScreen
): void {
  const t = pctx.tileSize;
  const w = scene.widthTiles * t;
  const h = scene.heightTiles * t;
  const a = toScreen(0, 0);
  const b = toScreen(w, h);
  const zoom = pctx.zoom;

  // 地图底板：与画布背景区分开，让"地图之外"一眼可辨
  g.save();
  g.fillStyle = "#191c23";
  g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  g.restore();

  if (pctx.showGrid && zoom > 0.3) {
    const step = zoom < 0.5 ? 4 : 1;
    g.save();
    g.lineWidth = 1;
    // 细网格
    g.strokeStyle = "#22252f";
    g.beginPath();
    for (let x = 0; x <= scene.widthTiles; x += step) {
      const p0 = toScreen(x * t, 0);
      const p1 = toScreen(x * t, h);
      g.moveTo(Math.round(p0.x) + 0.5, p0.y);
      g.lineTo(Math.round(p1.x) + 0.5, p1.y);
    }
    for (let y = 0; y <= scene.heightTiles; y += step) {
      const p0 = toScreen(0, y * t);
      const p1 = toScreen(w, y * t);
      g.moveTo(p0.x, Math.round(p0.y) + 0.5);
      g.lineTo(p1.x, Math.round(p1.y) + 0.5);
    }
    g.stroke();
    // 每 8 格一根主线，便于目测距离
    g.strokeStyle = "#2c303d";
    g.beginPath();
    for (let x = 0; x <= scene.widthTiles; x += 8) {
      const p0 = toScreen(x * t, 0);
      const p1 = toScreen(x * t, h);
      g.moveTo(Math.round(p0.x) + 0.5, p0.y);
      g.lineTo(Math.round(p1.x) + 0.5, p1.y);
    }
    for (let y = 0; y <= scene.heightTiles; y += 8) {
      const p0 = toScreen(0, y * t);
      const p1 = toScreen(w, y * t);
      g.moveTo(p0.x, Math.round(p0.y) + 0.5);
      g.lineTo(p1.x, Math.round(p1.y) + 0.5);
    }
    g.stroke();
    g.restore();
  }

  // 地图边界：淡蓝描边，明确"可放置区域"
  g.save();
  g.strokeStyle = "rgba(76,141,255,0.55)";
  g.lineWidth = 1.5;
  g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  g.restore();
}

// ---------------- 对象 ----------------

export function paintObject(
  g: CanvasRenderingContext2D,
  o: SceneObject,
  pctx: PaintCtx,
  toScreen: ToScreen,
  zoom: number
): void {
  const ov = pctx.overrides.get(o.id);
  const ox = ov ? ov.x : o.x;
  const oy = ov ? ov.y : o.y;
  const centered = toScreen(ox, oy);
  const s = sizeOf(o, pctx.project);
  const w = s.w * zoom;
  const h = s.h * zoom;
  const left = centered.x - w / 2;
  const top = centered.y - h / 2;

  const selected = pctx.selectedIds.has(o.id);
  const isZone = o.kind === "ZONE";
  const asset = pctx.project.assets.find((a) => a.id === o.assetId);

  g.save();

  // ★ 文字对象（tags 含 label）：按 props 真正渲染成文字。
  //
  // 与运行时 TopDownRuntime.drawLabel 保持同一套字段与对齐语义：
  //   props.text / textSize / textColor / textAlign（left | center | right）
  // 位置 (x, y) 是**文字块的垂直中心**，这样在编辑器里拖起来最直观。
  // 唯一的差异：这里按屏幕缩放（zoom）换算字号，运行时按设计分辨率换算。
  if (isLabelObject(o)) {
    const text = propOf(o, "text") || "（空文字）";
    const sizePx = numPropOf(o, "textSize", 24);
    const color = propOf(o, "textColor") || "#e6edf7";
    const align = (propOf(o, "textAlign") || "left").toLowerCase();
    const fontPx = Math.max(4, sizePx * zoom * o.scaleX);
    g.font = `${fontPx}px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`;
    g.textBaseline = "middle";
    g.textAlign = align === "center" || align === "middle" ? "center" : align === "right" || align === "end" ? "right" : "left";
    const anchorX = align === "center" || align === "middle"
      ? centered.x
      : align === "right" || align === "end"
        ? centered.x + w / 2
        : centered.x - w / 2;
    g.fillStyle = color;
    g.fillText(text, Math.round(anchorX), Math.round(centered.y));
    g.textAlign = "left";
    g.textBaseline = "alphabetic";

    // 选中：只在四角画 6px 的小标记，不画整框 —— 文字框会遮住字，反而看不清
    if (selected) {
      g.strokeStyle = "#4c8dff";
      g.lineWidth = 1.5;
      g.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(w), Math.round(h));
      g.fillStyle = "rgba(76,141,255,0.10)";
      g.fillRect(left, top, w, h);
    }
    g.restore();
    return;
  }

  // 触发区 / 碰撞体：半透明底 + 虚线框
  if (isZone || (o.halfW > 0 && o.halfH > 0 && pctx.showZones)) {
    const color = isZone ? "#2ecc8f" : "#f0a92b";
    g.fillStyle = hexA(color, 0.16);
    g.fillRect(left, top, w, h);
    g.strokeStyle = hexA(color, 0.75);
    g.lineWidth = 1.2;
    g.setLineDash([4, 3]);
    g.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(w), Math.round(h));
    g.setLineDash([]);
  }

  // 精灵本体
  const frame = pickFrame(o, asset, pctx.time);
  const pic = asset ? pictureOf(asset, frame) : null;
  if (pic && !isZone) {
    g.imageSmoothingEnabled = false;
    if (o.rotation) {
      g.translate(centered.x, centered.y);
      g.rotate((o.rotation * Math.PI) / 180);
      g.drawImage(pic.image as CanvasImageSource, -w / 2, -h / 2, w, h);
      g.setTransform(g.getTransform());
    } else {
      g.drawImage(pic.image as CanvasImageSource, Math.round(left), Math.round(top), Math.round(w), Math.round(h));
    }
  } else if (!isZone) {
    paintPlaceholder(g, o, left, top, w, h, zoom);
  }

  // 出生点 / 传送口 / 光源：用固定符号标出，避免与普通物件混淆
  if (o.kind === "SPAWN" || o.kind === "PORTAL" || o.kind === "LIGHT") {
    paintMarker(g, o.kind, centered.x, centered.y, Math.max(w, h));
  }

  // 选中框与缩放控制点
  if (selected) {
    g.strokeStyle = "#4c8dff";
    g.lineWidth = 1.5;
    g.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(w), Math.round(h));
    g.fillStyle = "rgba(76,141,255,0.10)";
    g.fillRect(left, top, w, h);
    if (pctx.showColliders && o.halfW > 0 && o.halfH > 0) {
      const cs = toScreen(o.halfW, o.halfH);
      const csx = toScreen(-o.halfW, -o.halfH);
      g.strokeStyle = "rgba(240,169,43,0.9)";
      g.setLineDash([3, 3]);
      g.strokeRect(Math.round(csx.x) + 0.5, Math.round(csx.y) + 0.5, cs.x - csx.x, cs.y - csx.y);
      g.setLineDash([]);
    }
  }

  // 名称与模块数量角标
  if (pctx.showNames && zoom > 0.42) {
    const label = o.name || "(未命名)";
    g.font = '11px "Microsoft YaHei UI", sans-serif';
    const tw = g.measureText(label).width;
    const lx = centered.x - tw / 2;
    const ly = top + h + 13;
    g.fillStyle = "rgba(8,10,14,0.72)";
    roundRect(g, lx - 4, ly - 11, tw + 8, 15, 4);
    g.fill();
    g.fillStyle = "#c4cddb";
    g.fillText(label, lx, ly);
  }
  const badge = o.modules.filter((m) => m.enabled).length;
  if (badge > 0 && zoom > 0.5) {
    const bx = left + w - 16;
    const by = top - 3;
    g.fillStyle = "#4c8dff";
    roundRect(g, bx, by, 17, 14, 7);
    g.fill();
    g.fillStyle = "#fff";
    g.font = '700 10px "Microsoft YaHei UI", sans-serif';
    const t = String(badge);
    g.fillText(t, bx + 8.5 - g.measureText(t).width / 2, by + 10.5);
  }

  g.restore();
}

function pickFrame(o: SceneObject, asset: AssetEntry | undefined, time: number): number {
  if (!asset) return 0;
  const total = totalFrames(asset);
  if (total <= 1 || o.animMode === "只显示首帧") return 0;
  const frames = asset.kind === "SEQUENCE" ? visibleFrames(asset) : Array.from({ length: total }, (_, i) => i);
  if (!frames.length) return 0;
  const fps = o.animFps > 0 ? o.animFps : 8;
  const idx = Math.floor((time / 1000) * fps) % frames.length;
  return frames[idx];
}

function paintPlaceholder(
  g: CanvasRenderingContext2D,
  o: SceneObject,
  left: number,
  top: number,
  w: number,
  h: number,
  zoom: number
): void {
  // props.color 优先：UI 面板 / 色块对象靠它表达视觉语义（与运行时 drawFallback 同一条规则）。
  // 没有这个键时仍按 kind 取色，世界场景的表现完全不变。
  const custom = propOf(o, "color");
  const color = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(custom) ? custom.slice(0, 7) : kindColor(o.kind);
  g.fillStyle = hexA(color, 0.88);
  roundRect(g, left, top, w, h, Math.min(8, Math.min(w, h) * 0.22));
  g.fill();
  g.strokeStyle = "rgba(0,0,0,0.35)";
  g.lineWidth = 1.2;
  g.stroke();
  if (zoom > 0.5) {
    g.fillStyle = "rgba(255,255,255,0.92)";
    g.font = '11px "Microsoft YaHei UI", sans-serif';
    const t = kindShort(o.kind);
    g.fillText(t, left + w / 2 - g.measureText(t).width / 2, top + h / 2 + 4);
  }
}

function paintMarker(g: CanvasRenderingContext2D, kind: SceneObject["kind"], cx: number, cy: number, size: number): void {
  const r = Math.max(5, size / 2 + 3);
  const color = kindColor(kind);
  g.save();
  g.strokeStyle = color;
  g.lineWidth = 2;
  if (kind === "SPAWN") {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(cx, cy - r - 5);
    g.lineTo(cx, cy - r + 2);
    g.moveTo(cx - 3, cy - r - 1);
    g.lineTo(cx, cy - r + 2);
    g.lineTo(cx + 3, cy - r - 1);
    g.stroke();
  } else if (kind === "PORTAL") {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    g.stroke();
  } else {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.setLineDash([3, 3]);
    g.stroke();
    g.setLineDash([]);
  }
  g.restore();
}

function kindColor(kind: SceneObject["kind"]): string {
  switch (kind) {
    case "ACTOR": return "#4c8dff";
    case "PROP": return "#66708a";
    case "TILE": return "#4a5a72";
    case "ZONE": return "#2ecc8f";
    case "SPAWN": return "#2ecc8f";
    case "PORTAL": return "#a274ff";
    case "LIGHT": return "#f0a92b";
    default: return "#66708a";
  }
}

function kindShort(kind: SceneObject["kind"]): string {
  switch (kind) {
    case "ACTOR": return "角色";
    case "PROP": return "物件";
    case "TILE": return "地块";
    case "ZONE": return "触发区";
    case "SPAWN": return "出生点";
    case "PORTAL": return "传送口";
    case "LIGHT": return "光源";
    default: return "对象";
  }
}

// ---------------- 绘图小工具 ----------------

export function hexA(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const r = (n >> 16) & 255;
  const gg = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${gg},${b},${alpha})`;
}

export function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** 画一个素材缩略图到指定 canvas 上（素材列表、序列帧编辑器共用）。 */
export async function drawThumb(
  canvas: HTMLCanvasElement,
  asset: AssetEntry,
  frame: number,
  maxSize: number
): Promise<void> {
  const img = await loadFrame(asset, frame);
  const g = canvas.getContext("2d");
  if (!g) return;
  const dpr = window.devicePixelRatio || 1;
  const boxW = maxSize;
  const boxH = maxSize;
  if (!img) {
    canvas.width = boxW * dpr;
    canvas.height = boxH * dpr;
    canvas.style.width = boxW + "px";
    canvas.style.height = boxH + "px";
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, boxW, boxH);
    g.fillStyle = "#f0a92b";
    g.font = '11px "Microsoft YaHei UI", sans-serif';
    g.fillText("读不到", boxW / 2 - 18, boxH / 2);
    return;
  }
  const scale = Math.min(boxW / img.width, boxH / img.height, 1) * (img.width < boxW ? 2 : 1);
  const w = Math.max(1, Math.round(img.width * Math.min(scale, boxW / img.width)));
  const h = Math.max(1, Math.round(img.height * Math.min(scale, boxH / img.height)));
  canvas.width = boxW * dpr;
  canvas.height = boxH * dpr;
  canvas.style.width = boxW + "px";
  canvas.style.height = boxH + "px";
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, boxW, boxH);
  g.drawImage(img.bitmap as CanvasImageSource, (boxW - w) / 2, (boxH - h) / 2, w, h);
}
