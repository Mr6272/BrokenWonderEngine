/**
 * 画布：俯视角地图的编辑与预览表面。
 *
 * 交互约定（按用户真实习惯设计，不用"编辑器黑话"）：
 *   左键          选择 / 拖动对象 / 框选
 *   右键拖动      平移画布（用户明确要求；不弹菜单，避免误触打断）
 *   右键单击      对象上下文菜单（拖动超过阈值就不算单击）
 *   中键拖动      平移画布（与多数 3D 软件一致）
 *   空格 + 拖动   平移画布（左手快捷键，配合右手鼠标）
 *   滚轮          以光标为锚点缩放，光标指的地方不动
 *   方向键        微调选中对象 1px；Shift + 方向键走一格
 *   Esc           取消当前拖动 / 清空选择
 *   Delete        删除选中对象
 *
 * 容错：拖动中按 Esc 会还原到按下时的位置；位移小于阈值算点击，不改数据。
 */

import type { SceneObject } from "../core/model.ts";
import { isUiScene, objectFromPrefab, scenePixelSize } from "../core/model.ts";
import { store } from "../core/store.ts";
import { canvasPalette, invalidateCanvasPalette } from "../ui/palette.ts";
import { contextMenu, type MenuItem } from "../ui/toast.ts";
import { clamp } from "../core/dom.ts";
import { loadFrame } from "../data/assets.ts";
import { sizeOf, boundsOf, paintObject, paintGrid, paintUiFrame, paintLightingPreview, type PaintCtx } from "./painter.ts";
import { collectSceneLighting } from "./lightMath.ts";

type Mode = "none" | "move" | "marquee" | "pan" | "zone" | "scale" | "brush" | "erase";

/**
 * 预制体拖放的 MIME。
 *
 * 放这里而不是 core/dom.ts：core 里那几个 DND_* 是「素材 / 模块 / 规则包」，
 * 预制体只有画布与预制体面板两边用，跟着画布走更不容易被误改。
 */
export const DND_PREFAB = "application/x-bwe-prefab";

interface Point2 {
  x: number;
  y: number;
}

export interface CanvasCallbacks {
  /** 鼠标世界坐标变化（状态栏用） */
  onHover?: (x: number, y: number, hit: SceneObject | null) => void;
  /** 拖动结束、数据已落定（用于压入撤销栈） */
  onCommit?: (label: string) => void;
  /** 右键单击对象（返回自定义菜单项，null 表示不弹） */
  onContextMenu?: (obj: SceneObject, sx: number, sy: number) => MenuItem[] | null;
  /** 画布为空时的提示是否显示 */
  emptyHint?: () => boolean;
}

export class CanvasView {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly hudL: HTMLDivElement;
  private readonly hudR: HTMLDivElement;
  private readonly cb: CanvasCallbacks;

  private zoom = 1;
  private camX = 0;
  private camY = 0;
  private dpr = 1;

  private mode: Mode = "none";
  private pressScreen: Point2 = { x: 0, y: 0 };
  private pressWorld: Point2 = { x: 0, y: 0 };
  /** 按下那一刻的世界坐标，拖动位移以它为基准（拖动中相机不动，直接用差值即可） */
  private pressStartWorld: Point2 = { x: 0, y: 0 };
  private lastScreen: Point2 = { x: 0, y: 0 };
  private moved = false;
  /** 本轮拖动画笔是否实际写入过（决定松手时要不要记一条撤销） */
  private brushPainted = false;
  /** 笔刷上一格（格坐标）。快速拖动时用它做格间插值，避免漏格画出虚线 */
  private brushLastCell: { gx: number; gy: number } | null = null;
  private spaceDown = false;
  private scaleHandle = -1;
  private pressSize = { w: 0, h: 0 };
  /** 按下那一刻的宽高比，用于默认按比例缩放 */
  private pressAspect = 1;

  /** 拖动期间的临时位置覆盖（不动模型，松手才提交） */
  private overrides = new Map<string, Point2>();
  private pressPositions = new Map<string, Point2>();
  private marquee: { x: number; y: number; w: number; h: number } | null = null;
  private zoneRect: { x: number; y: number; w: number; h: number } | null = null;

  /**
   * 点击 / 拖动 的区分。
   *
   * moved 只在位移超过阈值时才会变 true，但"按下即进入 move 模式"本身没有错——
   * 错的是松手时不管有没有真的移动都去提交位移，于是"点一下"也会被当成拖动。
   * 这里额外记一个 pressedObject：松手时若 moved 仍为 false，就按"点击"处理，
   * 走选择（含同位置轮换选择）而不是落位。
   */
  private pressedObject: SceneObject | null = null;
  /** 上次"干净点击"的位置键与时间，用于同位置重复点击时轮换对象 */
  private lastClickKey = "";
  private lastClickAt = 0;
  private static readonly CLICK_REPEAT_MS = 450;

  private hoverName = "";
  /** 光标当前所在的世界坐标（HUD 与状态栏用） */
  private hoverWorld: Point2 = { x: 0, y: 0 };
  /** 当前吸附对齐线，用于绘制辅助参考线 */
  private alignmentLines: { x: number; y: number; w: number; h: number; kind: "v" | "h" }[] = [];
  /** 吸附状态提示文本 */
  private snapHint = "";
  private animTimer = 0;
  private rafId = 0;
  private needsPaint = true;

  constructor(cb: CanvasCallbacks = {}) {
    this.cb = cb;
    this.root = document.createElement("div");
    this.root.className = "canvas-wrap";
    this.canvas = document.createElement("canvas");
    // tabindex 让画布能接收键盘；outline 用 CSS 关掉，避免点击后出现焦点框
    this.canvas.tabIndex = 0;
    this.canvas.style.outline = "none";
    this.root.appendChild(this.canvas);

    const g = this.canvas.getContext("2d");
    if (!g) throw new Error("浏览器不支持 Canvas 2D，无法运行编辑器");
    this.ctx2d = g;

    this.hudL = document.createElement("div");
    this.hudL.className = "canvas-hud tl";
    this.hudR = document.createElement("div");
    this.hudR.className = "canvas-hud tr";
    this.root.appendChild(this.hudL);
    this.root.appendChild(this.hudR);

    this.bindEvents();
    this.observeSize();
    store.onScene(() => this.requestPaint());
    store.onSelection(() => this.requestPaint());

    this.loop();
  }

  // ---------------- 视图 ----------------

  getZoom(): number {
    return this.zoom;
  }

  setZoom(z: number, anchorScreen?: Point2): void {
    const next = clamp(z, 0.15, 5);
    if (next === this.zoom) return;
    const anchor = anchorScreen ?? { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 };
    const before = this.screenToWorld(anchor);
    this.zoom = next;
    const after = this.screenToWorld(anchor);
    this.camX += before.x - after.x;
    this.camY += before.y - after.y;
    this.requestPaint();
  }

  zoomToFit(): void {
    const scene = store.scene;
    if (!scene) return;
    const size = this.sceneSize();
    const w = size.w;
    const h = size.h;
    const cw = this.canvas.clientWidth || 800;
    const ch = this.canvas.clientHeight || 600;
    this.zoom = clamp(Math.min((cw - 48) / w, (ch - 48) / h), 0.15, 2);
    this.camX = w / 2;
    this.camY = h / 2;
    this.requestPaint();
  }

  /**
   * F 键 / 工具条「缩放到整张地图」的落点。
   *
   * 语义分两档（这是修「点击物体不能切换到聚焦」的关键）：
   *   - 有选中对象 → 聚焦到它（框住 + 合适缩放），用户按 F 想看的是"这个东西"；
   *   - 没有选中     → 缩放到整张地图，保留原来的行为，不破坏肌肉记忆。
   * 想无条件看全图仍有「缩放到整张地图」按钮/命令（走 zoomToFit 本体）。
   */
  fitOrFocus(): void {
    this.focusSelection();
  }

  /**
   * 当前场景的像素尺寸。
   *
   * 世界场景 = 格数 × tileSize；UI 场景 = 设计分辨率（1280×720 之类）。
   * 画布内所有「地图有多大」的判断都必须走这里，否则 UI 场景会被当成
   * 60×40 格 × 32px = 1920×1280 的地图，缩放和居中全部对不上。
   */
  private sceneSize(): { w: number; h: number } {
    const scene = store.scene;
    if (!scene) return { w: 32, h: 32 };
    return scenePixelSize(scene, store.project?.tileSize ?? 32);
  }

  /** 当前场景是不是 UI 场景（UI 场景不画瓦片网格，改画设备画框 + 安全区）。 */
  private isUi(): boolean {
    return isUiScene(store.scene);
  }

  centerOn(x: number, y: number): void {
    this.camX = x;
    this.camY = y;
    this.requestPaint();
  }

  /**
   * 把一块世界矩形「框进视野」—— 焦点对齐（Unity/Godot 的 F 键行为）。
   *
   * 与 `centerOn` 的区别：那个只挪相机不动缩放，所以在地图 1% 缩放时
   * 「定位」一个 32px 的小物件，用户看到的还是一个点和一片空白。
   * 这里同时按矩形算出合适的 zoom，让目标真的占满视野（留 20% 边距，
   * 免得选中框和缩放控制点贴到画布边缘去）。
   *
   * 上限 1.0：物件本来比画布还大时不要放大到 4 倍 —— 那会变成"看一个局部像素"。
   * 下限沿用画布的 0.15。
   */
  focusRect(x: number, y: number, w: number, h: number): void {
    const cw = this.canvas.clientWidth || 800;
    const ch = this.canvas.clientHeight || 600;
    const pad = 0.8;
    const ww = Math.max(8, w);
    const hh = Math.max(8, h);
    this.zoom = clamp(Math.min((cw * pad) / ww, (ch * pad) / hh), 0.15, 1);
    this.camX = x + ww / 2;
    this.camY = y + hh / 2;
    this.requestPaint();
  }

  /**
   * 聚焦：有选中就框住选中对象（多个取并集），没有选中就缩放到整张地图。
   *
   * 这是 F 键与「双击画布上的对象」的共同实现 —— 两处行为必须一致，
   * 否则用户按 F 和双击会看到两种不同的"聚焦"。
   */
  /**
   * 聚焦单个对象（列表里点「定位」、双击画布对象、F 键共用同一套）。
   *
   * 用 `focusRect` 而不是 `centerOn`：只居中不缩放的话，在地图缩到 46% 时
   * 「定位」一个 64px 的小物件，用户看到的仍然是一个点和一大片空白 ——
   * 那不叫聚焦。这里按对象矩形算合适的 zoom，让它真的占满视野。
   */
  focusObject(o: SceneObject): void {
    const project = store.project;
    if (!project) return;
    const b = boundsOf(o, project);
    this.focusRect(b.x, b.y, b.w, b.h);
  }

  focusSelection(): boolean {
    const sel = store.selection.filter((o) => o.visible);
    if (!sel.length) {
      this.zoomToFit();
      return false;
    }
    const project = store.project;
    if (!project) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const o of sel) {
      const b = boundsOf(o, project);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    this.focusRect(minX, minY, maxX - minX, maxY - minY);
    return true;
  }

  /**
   * 当前视图正中的世界坐标。
   *
   * 「放置预制体」要用它：用户点的是「放到场景里」，期望落在眼前看得见的中间，
   * 而不是地图原点（0,0）那种拖半天也找不到的地方。
   */
  viewCenterWorld(): Point2 {
    return this.screenToWorld({ x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 });
  }

  screenToWorld(p: Point2): Point2 {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    return {
      x: (p.x - cw / 2) / this.zoom + this.camX,
      y: (p.y - ch / 2) / this.zoom + this.camY
    };
  }

  worldToScreen(x: number, y: number): Point2 {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    return { x: (x - this.camX) * this.zoom + cw / 2, y: (y - this.camY) * this.zoom + ch / 2 };
  }

  private tileSize(): number {
    // UI 场景没有「格」：吸附单位改成 4px。用 tileSize(32) 会把界面元素
    // 永远摆在 32 的倍数上，做不出「离右边 16 像素」这类排版。
    if (this.isUi()) return 4;
    return Math.max(4, store.project?.tileSize ?? 32);
  }

  private snap(v: number): number {
    if (!store.snapToGrid) return Math.round(v);
    const t = this.tileSize();
    return Math.round(v / t) * t;
  }

  // ---------------- 尺寸 ----------------

  private observeSize(): void {
    const ro = new ResizeObserver(() => this.requestPaint());
    ro.observe(this.root);
  }

  private syncCanvasSize(): void {
    const cw = this.canvas.clientWidth || this.root.clientWidth;
    const ch = this.canvas.clientHeight || this.root.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cw * this.dpr));
    const h = Math.max(1, Math.round(ch * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  requestPaint(): void {
    this.needsPaint = true;
  }

  private loop = (): void => {
    this.rafId = window.requestAnimationFrame(this.loop);
    // 序列帧预览需要持续重绘；只在动画存在或需要时重绘，避免空转吃电。
    //
    // 关键：`hasAnimation` 的**重算**放在 paint() 里，不放在这里。
    // 原来是每帧都调 sceneHasAnimation()，它逐对象查素材 = O(对象数 × 素材数)：
    // 一个 1300 对象、上百素材的工程，闲置时每秒几十万次比较 —— 这就是
    // 「编辑器开着不动也在慢慢变卡」的一大来源。
    //
    // 现在空闲帧只做字段读取和一次时间比较；只要有数据变化，一定先经过 paint()
    // （需要重绘 → 重算 → 下次空闲帧用新值），所以缓存不会过期。
    const now = performance.now();
    if (!this.needsPaint && (!this.hasAnimation || now - this.animTimer < 33)) return;
    this.animTimer = now;
    this.needsPaint = false;
    this.paint();
  };

  /**
   * 场景里是否有需要持续动画的对象。
   *
   * 只在 paint() 里重算：真实绘制时本来就要遍历全场景，顺手更新这个标记几乎免费，
   * 而空闲帧完全不需要知道它 —— 没有数据变化时根本不会进入 paint()。
   * 这样闲置状态的每帧成本是 O(1)，不再是 O(对象数 × 素材数)。
   */
  private hasAnimation = false;

  private refreshAnimationFlag(scene: import("../core/model.ts").SceneModel, project: import("../core/model.ts").Project): void {
    // 素材索引一次建好，避免每个对象都做一次线性 find（这是原来的 N×M 主项）。
    const assetIndex = new Map<string, import("../core/model.ts").AssetEntry>();
    for (const a of project.assets) assetIndex.set(a.id, a);

    for (const o of scene.objects) {
      const a = assetIndex.get(o.assetId);
      if (!a) continue;
      const frames = a.kind === "SEQUENCE" ? a.frameCount ?? 1 : a.kind === "ATLAS" ? (a.cols ?? 1) * (a.rows ?? 1) : 1;
      if (frames > 1 && o.animMode !== "只显示首帧") {
        this.hasAnimation = true;
        return;
      }
    }
    this.hasAnimation = false;
  }

  destroy(): void {
    window.cancelAnimationFrame(this.rafId);
  }

  // ---------------- 绘制 ----------------

  private paint(): void {
    this.syncCanvasSize();
    const g = this.ctx2d;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.imageSmoothingEnabled = false;

    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    // 画布底色来自主题令牌（浅/深两套主题都要能画），由 ui/palette.ts 统一解析 + 缓存
    // —— 每个绘制函数各自 getComputedStyle 会让每帧多出十几次样式重算。
    const pal = canvasPalette();
    g.fillStyle = pal.bg;
    g.fillRect(0, 0, cw, ch);

    const scene = store.scene;
    const project = store.project;
    if (!scene || !project) {
      this.hudL.textContent = "";
      this.drawCenterText(g, "没有打开的场景", "用「文件 → 新建工程」开始，或打开一个 .bwproj");
      return;
    }

    // 绘制时顺手更新「有没有动画」标记：这时本来就要遍历全场景，几乎免费。
    // 空闲帧则完全不做这件事（见 loop 的注释），这是把空转开销压到 O(1) 的关键。
    this.refreshAnimationFlag(scene, project);

    const pctx: PaintCtx = {
      zoom: this.zoom,
      tileSize: project.tileSize,
      showGrid: store.showGrid,
      showColliders: store.showColliders,
      showZones: store.showZones,
      showNames: store.showNames,
      showViewport: store.showViewport,
      time: performance.now(),
      selectedIds: new Set(store.selection.map((o) => o.id)),
      overrides: this.overrides,
      project,
      ui: isUiScene(scene),
      // 光照预览开关：默认开，但只有"场景真的有 enabled 的 lighting"才会画出一笔
      //（paintLightingPreview 里再判一次 —— 那里才是"缺字段 ⇒ 一行不画"的兜底）
      showLighting: store.showLighting
    };

    // UI 场景画「设计分辨率画框 + 安全区」，世界场景画瓦片网格。
    // 两者坐标系不同（前者单位是设计像素，后者是 tile × tileSize），
    // 混用会让 UI 对象的摆位看起来对、导出后整体偏移。
    if (isUiScene(scene)) {
      paintUiFrame(g, scene, pctx, this.worldToScreen.bind(this));
    } else {
      paintGrid(g, undefined, scene, pctx, this.worldToScreen.bind(this));
    }

    // 按图层顺序 + z 排序：先画的在下
    const ordered = orderObjects(scene);
    for (const o of ordered) {
      const layer = scene.layers.find((l) => l.id === o.layerId);
      if (layer && !layer.visible) continue;
      if (!o.visible) continue;
      paintObject(g, o, pctx, this.worldToScreen.bind(this), this.zoom);
      // 预制体链接角标：画在对象外面（painter 不认 prefabId，这是画布层的叠加信息）。
      // 不做自动同步，所以它只是「告诉你这个对象是从模板放出来的」。
      if (o.prefabId && this.zoom > 0.5) this.drawPrefabBadge(g, o);
    }

    // ---- 光照近似预览 ----
    // 画在对象之后：光照层在运行时也是盖在 drawMap/drawActors 之上（契约 §6）。
    // 只在世界场景画：UI 场景是屏幕空间设计稿，压暗整屏没有意义也没有对应实现。
    // 两个开关都满足才画（showLighting 是工具条开关；scene.lighting.enabled 是工程数据）
    // —— 任一不满足就一行都不画，无光照工程的画面保持逐像素不变。
    if (!isUiScene(scene) && pctx.showLighting && scene.lighting?.enabled === true) {
      paintLightingPreview(
        g,
        scene,
        pctx,
        this.worldToScreen.bind(this),
        cw,
        collectSceneLighting(scene, project)
      );
    }

    // 智能对齐参考线
    for (const line of this.alignmentLines) {
      if (line.kind === "v") {
        const s = this.worldToScreen(line.x, 0);
        g.save();
        g.strokeStyle = "#f0a92b";
        g.lineWidth = 1;
        g.setLineDash([6, 4]);
        g.beginPath();
        g.moveTo(s.x, 0);
        g.lineTo(s.x, ch);
        g.stroke();
        g.setLineDash([]);
        g.restore();
      } else {
        const s = this.worldToScreen(0, line.y);
        g.save();
        g.strokeStyle = "#f0a92b";
        g.lineWidth = 1;
        g.setLineDash([6, 4]);
        g.beginPath();
        g.moveTo(0, s.y);
        g.lineTo(cw, s.y);
        g.stroke();
        g.setLineDash([]);
        g.restore();
      }
    }

    // 框选 / 触发区预览
    if (this.marquee) {
      const a = this.worldToScreen(this.marquee.x, this.marquee.y);
      g.save();
      g.fillStyle = "rgba(76,141,255,0.14)";
      g.strokeStyle = "#4c8dff";
      g.lineWidth = 1;
      g.setLineDash([5, 4]);
      g.fillRect(a.x, a.y, this.marquee.w * this.zoom, this.marquee.h * this.zoom);
      g.strokeRect(a.x, a.y, this.marquee.w * this.zoom, this.marquee.h * this.zoom);
      g.restore();
    }
    if (this.zoneRect) {
      const a = this.worldToScreen(this.zoneRect.x, this.zoneRect.y);
      g.save();
      g.fillStyle = "rgba(46,204,143,0.14)";
      g.strokeStyle = "#2ecc8f";
      g.lineWidth = 1.4;
      g.setLineDash([6, 4]);
      const w = this.zoneRect.w * this.zoom;
      const h = this.zoneRect.h * this.zoom;
      g.fillRect(a.x, a.y, w, h);
      g.strokeRect(a.x, a.y, w, h);
      g.setLineDash([]);
      g.fillStyle = "#2ecc8f";
      g.font = '11px "Microsoft YaHei UI", sans-serif';
      const t = `触发区 ${Math.round(this.zoneRect.w / this.tileSize())} × ${Math.round(this.zoneRect.h / this.tileSize())} 格`;
      g.fillText(t, a.x, a.y - 5);
      g.restore();
    }

    // 缩放控制点
    this.drawScaleHandles(g);

    if (scene.objects.length === 0 && this.cb.emptyHint?.() !== false) {
      this.drawCenterText(
        g,
        "这张地图还是空的",
        "从左边「素材」把图拖进来，或选择「画笔」工具连续铺地块"
      );
    }

    // 传送口目标标签：在 Portal 对象上方显示"传送口 → 目标场景"
    const portals = scene.objects.filter((o) => o.kind === "PORTAL" && o.visible);
    for (const portal of portals) {
      const targetScene = findLoadSceneTarget(portal);
      if (!targetScene) continue;
      const s = this.worldToScreen(portal.x, portal.y - (sizeOf(portal, store.project!).h / 2) - 6);
      g.save();
      g.fillStyle = canvasPalette().hover;
      g.font = '11px "Microsoft YaHei UI", sans-serif';
      g.textAlign = "center";
      g.fillText(`→ ${targetScene}`, s.x, s.y);
      g.restore();
    }

    this.hudL.textContent = this.hudText();
    this.hudR.textContent = this.snapHint || this.hoverName;
  }

  /**
   * 预制体链接角标：对象右上角一个小方块。
   *
   * 放在画布而不是 painter.ts：painter 只认同 SceneObject 的绘制字段（且有自己的导出/缩略图
   * 复用需求），「来自哪个预制体」是编辑器层的元信息，随画布出现即可。
   * 紫色 = 链接完好；灰色 = 模板已删（对象本身仍然能用）。
   */
  private drawPrefabBadge(g: CanvasRenderingContext2D, o: SceneObject): void {
    const box = boundsOf(o, store.project!);
    const size = sizeOf(o, store.project!);
    const topRight = this.worldToScreen(box.x + size.w, box.y);
    const linked = store.project?.prefabs.some((p) => p.id === o.prefabId) === true;
    const s = Math.max(7, Math.min(11, 9 * this.zoom));
    const x = topRight.x - s;
    const y = topRight.y - s - 1;
    g.save();
    // 预制体链接角标：紫色=已链接、灰色=模板已删；浅底主题下紫色要深一点才看得清
    g.fillStyle = linked
      ? (document.documentElement.classList.contains("theme-midnight") || document.documentElement.classList.contains("theme-high-contrast")
          ? "#8b7cf6"
          : "#7a5fbf")
      : canvasPalette().text3;
    g.strokeStyle = "rgba(8,10,14,0.8)";
    g.lineWidth = 1;
    g.fillRect(x, y, s, s);
    g.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    g.restore();
  }

  private drawScaleHandles(g: CanvasRenderingContext2D): void {
    if (this.mode === "pan") return;
    const one = store.single;
    if (!one || one.locked) return;
    const b = boundsOf(one, store.project!);
    const size = sizeOf(one, store.project!);
    const cx = one.x;
    const cy = one.y;
    const hs = 6;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const wx = cx + (dx * size.w) / 2;
        const wy = cy + (dy * size.h) / 2;
        const s = this.worldToScreen(wx, wy);
        // 控制点要小一号、贴到选中框（painter 里选中框已外扩 1px）上再往外 1px，
        // 免得把手柄盖住对象边缘的碰撞体虚线。视觉上"扣在角上"，语义不变。
        const off = dx * 2;
        const offY = dy * 2;
        g.save();
        g.fillStyle = "#ffffff";
        g.strokeStyle = "#4c8dff";
        g.lineWidth = 1.2;
        g.fillRect(s.x + off - hs / 2, s.y + offY - hs / 2, hs, hs);
        g.strokeRect(s.x + off - hs / 2, s.y + offY - hs / 2, hs, hs);
        g.restore();
      }
    }
    void b;
  }

  private hudText(): string {
    const w = this.hoverWorld;
    // UI 场景里「第几格」没有意义（没有瓦片），只报设计像素坐标。
    if (this.isUi()) {
      return `px ${Math.round(w.x)}, ${Math.round(w.y)}（设计分辨率）`;
    }
    const t = this.tileSize();
    return `格 ${Math.round(w.x / t)}, ${Math.round(w.y / t)}　|　px ${Math.round(w.x)}, ${Math.round(w.y)}`;
  }

  private drawCenterText(g: CanvasRenderingContext2D, title: string, sub: string): void {
    const cw = this.canvas.clientWidth;
    const chh = this.canvas.clientHeight;
    g.save();
    g.textAlign = "center";
    // 空状态文字也必须跟着主题：深色主题用浅灰，奶油主题用暖灰，
    // 写死颜色会在某一套主题下变成"看不见的字"。
    const pal = canvasPalette();
    g.fillStyle = pal.text2;
    g.font = '600 15px "Microsoft YaHei UI", sans-serif';
    g.fillText(title, cw / 2, chh / 2 - 6);
    g.fillStyle = pal.text3;
    g.font = '12px "Microsoft YaHei UI", sans-serif';
    g.fillText(sub, cw / 2, chh / 2 + 18);
    g.restore();
  }

  // ---------------- 事件 ----------------

  private bindEvents(): void {
    const c = this.canvas;

    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("mousedown", (e) => this.onDown(e));
    window.addEventListener("mousemove", this.onMove);
    window.addEventListener("mouseup", this.onUp);
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    c.addEventListener("mouseleave", () => {
      this.hoverName = "";
      this.requestPaint();
    });

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", () => {
      this.spaceDown = false;
      this.updateCursorClass();
    });

    // 拖入素材：在落点创建对象
    c.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    c.addEventListener("drop", (e) => this.onDrop(e));
    // 双击对象 = 聚焦它（Unity 里双击 Hierarchy 项、Godot 里 F 键的同一语义）。
    // 用户的原话是「点击物体不能切换到聚焦，太难受了」：在此之前双击没有任何反应，
    // 想看清一个小物件只能滚轮慢慢放大再拖回来。
    c.addEventListener("dblclick", (e) => {
      const local = { x: e.clientX - this.rectLeft(), y: e.clientY - this.rectTop() };
      const world = this.screenToWorld(local);
      const hit = this.pick(world);
      if (!hit) {
        // 空白处双击 = 缩放到整张地图（和以前 F 键的行为一致，保留肌肉记忆）
        this.zoomToFit();
        return;
      }
      store.select(hit);
      this.focusSelection();
      this.flashHud(`已聚焦「${hit.name || hit.kind}」　按 F 也可聚焦选中对象`);
    });
  }

  private updateCursorClass(): void {
    const wrap = this.root;
    wrap.classList.toggle("tool-pan", store.tool === "pan");
    wrap.classList.toggle("tool-brush", store.tool === "brush");
    wrap.classList.toggle("tool-erase", store.tool === "erase");
    wrap.classList.toggle("panning", this.mode === "pan");
  }

  private onDown(e: MouseEvent): void {
    this.canvas.focus();
    this.moved = false;
    this.pressScreen = { x: e.clientX, y: e.clientY };
    this.lastScreen = { ...this.pressScreen };
    const local = { x: e.clientX - this.rectLeft(), y: e.clientY - this.rectTop() };
    this.pressWorld = this.screenToWorld(local);
    this.pressStartWorld = { ...this.pressWorld };

    const scene = store.scene;
    if (!scene) return;

    // 右键 / 中键 / 空格 / 抓手工具 → 平移
    if (e.button === 2 || e.button === 1 || this.spaceDown || store.tool === "pan") {
      this.mode = "pan";
      this.updateCursorClass();
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    if (store.tool === "erase") {
      // 拖动连续擦除：按下擦一个，进入 erase 模式后移动继续擦，松手记一条撤销。
      const hit = this.pick(this.pressWorld);
      if (hit) {
        scene.objects = scene.objects.filter((o) => o !== hit);
        store.forget(hit);
        store.markDirty();
        this.brushPainted = true;
        this.requestPaint();
      }
      this.brushLastCell = null;
      this.mode = "erase";
      return;
    }

    if (store.tool === "zone") {
      this.mode = "zone";
      this.zoneRect = { x: this.pressWorld.x, y: this.pressWorld.y, w: 0, h: 0 };
      return;
    }

    if (store.tool === "brush") {
      // 按下即铺设第一块，然后进入 brush 模式让拖动继续铺。
      // silent=true：拖动过程里不逐块记撤销，松手时统一记一条。
      this.brushLastCell = null;
      this.paintStrokeTo(this.pressWorld);
      this.mode = "brush";
      this.brushPainted = true;
      this.requestPaint();
      return;
    }

    // 缩放控制点优先于对象命中
    const handle = this.hitHandle(this.pressWorld);
    const one = store.single;
    if (handle >= 0 && one) {
      this.mode = "scale";
      this.scaleHandle = handle;
      const s = sizeOf(one, store.project!);
      this.pressSize = { w: s.w, h: s.h };
      this.pressAspect = s.w / s.h;
      return;
    }

    const hit = this.pick(this.pressWorld, e.altKey);
    if (hit) {
      // 选中立即生效：否则"按住一个没选中的对象直接拖走"会拖不动。
      // 但这次按下到底是"点击"还是"拖动"，要等松手才知道（见 onUp）。
      if (e.shiftKey) store.select(hit, true);
      else if (!store.isSelected(hit)) store.select(hit);

      this.pressedObject = hit;
      if (hit.locked) {
        // Alt 点中锁定对象时给明确提示，否则用户会以为"点不动是坏了"
        this.flashHud(`「${hit.name || hit.kind}」是锁定的　右侧属性面板可取消锁定`);
      }
      this.mode = "move";
      this.pressPositions.clear();
      for (const o of store.selection) {
        if (!o.locked) this.pressPositions.set(o.id, { x: o.x, y: o.y });
      }
      return;
    }

    this.pressedObject = null;
    if (!e.shiftKey) store.clearSelection();
    this.mode = "marquee";
    this.marquee = { x: this.pressWorld.x, y: this.pressWorld.y, w: 0, h: 0 };
  }

  /**
   * 一次"干净点击"（按下与松开之间没有实质位移）的处理。
   *
   * 同一位置连续点击时轮换选择：每次往下剥一层，从最上面那个开始，
   * 到底之后再回到最上面。这样叠在一起的对象不用挪开也能逐个选中。
   */
  private handleClick(hit: SceneObject): void {
    const now = performance.now();
    const key = `${Math.round(this.pressWorld.x / 6)}:${Math.round(this.pressWorld.y / 6)}`;
    const repeat = key === this.lastClickKey && now - this.lastClickAt < CanvasView.CLICK_REPEAT_MS;

    if (repeat) {
      const stack = this.pickStack(this.pressWorld);
      const cur = store.selection[0];
      const i = cur ? stack.indexOf(cur) : -1;
      const next = stack[i < 0 ? 0 : (i + 1) % stack.length];
      if (next) {
        store.select(next);
        if (stack.length > 1) {
          this.flashHud(`「${next.name || next.kind}」　同位置 ${stack.length} 个，再点换下一个`);
        }
      }
    }

    this.lastClickKey = key;
    this.lastClickAt = now;
    void hit;
  }

  /** 该位置所有可点对象，从最上层到最下层。 */
  private pickStack(world: Point2, includeLocked = false): SceneObject[] {
    const scene = store.scene;
    const project = store.project;
    if (!scene || !project) return [];
    const ordered = orderObjects(scene);
    const out: SceneObject[] = [];
    for (let i = ordered.length - 1; i >= 0; i--) {
      const o = ordered[i];
      if (!o.visible) continue;
      if (!includeLocked && o.locked) continue;
      const layer = scene.layers.find((l) => l.id === o.layerId);
      if (layer && !layer.visible) continue;
      if (layer && !includeLocked && layer.locked) continue;
      const b = boundsOf(o, project);
      if (world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y && world.y <= b.y + b.h) out.push(o);
    }
    return out;
  }

  private onMove = (e: MouseEvent): void => {
    const local = { x: e.clientX - this.rectLeft(), y: e.clientY - this.rectTop() };
    const world = this.screenToWorld(local);
    this.hoverWorld = world;

    if (Math.abs(e.clientX - this.pressScreen.x) > 3 || Math.abs(e.clientY - this.pressScreen.y) > 3) {
      this.moved = true;
    }

    // 拖动画笔：移动经过的每一格都落一块，持久化由松手时统一提交。
    if (this.mode === "brush") {
      this.paintStrokeTo(world);
      this.brushPainted = true;
      this.requestPaint();
      return;
    }

    // 拖动擦除：移动经过的每一格都擦掉。
    if (this.mode === "erase") {
      const hit = this.pick(world);
      // 与单击擦除保持完全一致的行为（不额外加 locked 限制），
      // 拖动擦除就是"等于连续点击"，不该偷偷改变语义。
      if (hit) {
        const sc = store.scene;
        if (sc) {
          sc.objects = sc.objects.filter((o) => o !== hit);
          store.forget(hit);
          store.markDirty();
          this.brushPainted = true;
          this.requestPaint();
        }
      }
      return;
    }

    switch (this.mode) {
      case "pan": {
        this.camX -= (e.clientX - this.lastScreen.x) / this.zoom;
        this.camY -= (e.clientY - this.lastScreen.y) / this.zoom;
        this.lastScreen = { x: e.clientX, y: e.clientY };
        this.requestPaint();
        return;
      }
      case "move": {
        // 位移以按下点为基准：拖动期间相机不动，直接取世界坐标差值
        const dx = world.x - this.pressStartWorld.x;
        const dy = world.y - this.pressStartWorld.y;
        this.overrides.clear();
        this.alignmentLines = [];
        this.snapHint = "";

        const scene = store.scene!;
        const project = store.project!;
        const tile = project.tileSize;
        const ALIGN_TOL = 8 / this.zoom; // 对齐吸附阈值（像素，随缩放调整）

        // 先算出每个选中对象按网格吸附后的基础位置
        const bases = new Map<string, { x: number; y: number }>();
        for (const o of store.selection) {
          const p0 = this.pressPositions.get(o.id);
          if (!p0) continue;
          bases.set(o.id, { x: this.snap(p0.x + dx), y: this.snap(p0.y + dy) });
        }

        // 收集所有非选中、可见、未锁定的对象作为对齐参照
        const refs = scene.objects.filter((o) => !store.isSelected(o) && o.visible && !o.locked);

        for (const o of store.selection) {
          const p0 = this.pressPositions.get(o.id);
          if (!p0) continue;
          const base = bases.get(o.id)!;
          const size = sizeOf(o, project);
          let cx = base.x;
          let cy = base.y;
          let aligned = false;

          /**
           * 智能对齐。
           *
           * ⚠ 这里的几何必须按「对象坐标 = 中心」来算（`boundsOf` 就是这么定义的：
           * x/y 是中心，left = x - w/2）。历史上这段把 `r.x` 直接当左边、把
           * `r.x + rs.w` 当右边、把 `cx + size.w/2` 当对象中心 —— 三处都错半个身位。
           * 表现是：拖动时吸附得莫名其妙，而更显眼的是那几条**黄色虚线参考线**
           * 画到了对象右边半个身位之外，看起来就是「虚线位置不对」。
           *
           * 现在统一：左 = 中心 - w/2，右 = 中心 + w/2，中心 = 中心。
           */
          const oLeft = cx - size.w / 2;
          const oRight = cx + size.w / 2;
          const oTop = cy - size.h / 2;
          const oBottom = cy + size.h / 2;
          void oLeft; void oRight; void oTop; void oBottom;

          const addV = (x: number) => this.alignmentLines.push({ x, y: -9999, w: 1, h: 9999, kind: "v" });
          const addH = (y: number) => this.alignmentLines.push({ x: -9999, y, w: 9999, h: 1, kind: "h" });

          for (const r of refs) {
            const rs = sizeOf(r, project);
            const rLeft = r.x - rs.w / 2;
            const rRight = r.x + rs.w / 2;
            const rTop = r.y - rs.h / 2;
            const rBottom = r.y + rs.h / 2;

            // 竖直参考线（x 对齐）：固定一个世界 x，把对象挪到让某条边/中心落在它上面
            const alignV = (lineX: number, label: string): boolean => {
              const curLeft = cx - size.w / 2;
              const curRight = cx + size.w / 2;
              if (Math.abs(curLeft - lineX) <= ALIGN_TOL) { cx = lineX + size.w / 2; }
              else if (Math.abs(curRight - lineX) <= ALIGN_TOL) { cx = lineX - size.w / 2; }
              else if (Math.abs(cx - lineX) <= ALIGN_TOL) { cx = lineX; }
              else return false;
              addV(lineX);
              this.snapHint = label;
              return true;
            };

            // 水平参考线（y 对齐）
            const alignH = (lineY: number, label: string): boolean => {
              const curTop = cy - size.h / 2;
              const curBottom = cy + size.h / 2;
              if (Math.abs(curTop - lineY) <= ALIGN_TOL) { cy = lineY + size.h / 2; }
              else if (Math.abs(curBottom - lineY) <= ALIGN_TOL) { cy = lineY - size.h / 2; }
              else if (Math.abs(cy - lineY) <= ALIGN_TOL) { cy = lineY; }
              else return false;
              addH(lineY);
              this.snapHint = label;
              return true;
            };

            if (!aligned) {
              aligned =
                alignV(rLeft, `对齐「${r.name}」左边`) ||
                alignV(rRight, `对齐「${r.name}」右边`) ||
                alignV(r.x, `对齐「${r.name}」中心`);
            }
            if (!aligned) {
              aligned =
                alignH(rTop, `对齐「${r.name}」上边`) ||
                alignH(rBottom, `对齐「${r.name}」下边`) ||
                alignH(r.y, `对齐「${r.name}」中心`);
            }
            if (aligned) break;
          }

          // 如果未对齐到任何对象，保留网格吸附位置
          this.overrides.set(o.id, { x: Math.round(cx), y: Math.round(cy) });
        }
        this.requestPaint();
        return;
      }
      case "marquee": {
        this.marquee = rectFrom(this.pressStartWorld, world);
        this.requestPaint();
        return;
      }
      case "zone": {
        this.zoneRect = rectFrom(this.pressStartWorld, world);
        this.requestPaint();
        return;
      }
      case "scale": {
        const one = store.single;
        if (!one) return;
        const dx = world.x - this.pressStartWorld.x;
        const dy = world.y - this.pressStartWorld.y;
        const signX = this.isRightHandle() ? 1 : this.isLeftHandle() ? -1 : 0;
        const signY = this.isBottomHandle() ? 1 : this.isTopHandle() ? -1 : 0;
        let nw = Math.max(4, this.pressSize.w + dx * 2 * signX);
        let nh = Math.max(4, this.pressSize.h + dy * 2 * signY);

        if (!e.shiftKey) {
          // 默认按比例缩放：锁定宽高比，取变化幅度更大的方向作为主导
          const sx = nw / this.pressSize.w;
          const sy = nh / this.pressSize.h;
          let scale = 1;
          if (signX !== 0 && signY !== 0) {
            // 角控制点：两个方向都在变，取变化幅度大的那个决定比例
            scale = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
          } else if (signX !== 0) {
            scale = sx;
          } else if (signY !== 0) {
            scale = sy;
          }
          nw = Math.max(4, Math.round(this.pressSize.w * scale));
          nh = Math.max(4, Math.round(this.pressSize.h * scale));
        }
        // 按住 Shift：自由缩放，nw/nh 保持独立计算，不锁定比例

        one.halfW = Math.round(nw / 2);
        one.halfH = Math.round(nh / 2);
        store.markDirty();
        this.requestPaint();
        return;
      }
      default: {
        const hit = this.pick(world);
        const sz = hit ? sizeOf(hit, store.project!) : null;
        this.hoverName = hit && sz ? `${hit.name}　·　${sz.w}×${sz.h}px` : "";
        this.cb.onHover?.(world.x, world.y, hit);
        this.requestPaint();
      }
    }
  };

  private isLeftHandle(): boolean {
    return this.scaleHandle % 3 === 0;
  }

  private isRightHandle(): boolean {
    return this.scaleHandle % 3 === 2;
  }

  private isTopHandle(): boolean {
    return this.scaleHandle < 3;
  }

  private isBottomHandle(): boolean {
    return this.scaleHandle >= 6;
  }


  private onUp = (e: MouseEvent): void => {
    const wasMode = this.mode;
    const local = { x: e.clientX - this.rectLeft(), y: e.clientY - this.rectTop() };
    const world = this.screenToWorld(local);

    switch (wasMode) {
      case "brush":
      case "erase": {
        // 拖动期间用 silent 落子，松手时统一记一条撤销，避免整条笔画刷出几十条历史。
        if (this.brushPainted) {
          store.markDirty();
          this.cb.onCommit?.(wasMode === "brush" ? "铺设地块" : "擦除地块");
        }
        this.brushPainted = false;
        this.brushLastCell = null;
        this.mode = "none";
        break;
      }

      case "move": {
        // 没有真正移动 → 这是一次点击，不是拖动。
        // 关键：不能把 overrides 里的 0 位移提交上去，否则"点一下"也会写脏数据 + 记一次撤销。
        if (!this.moved) {
          if (this.pressedObject) this.handleClick(this.pressedObject);
          this.overrides.clear();
          break;
        }
        if (this.overrides.size) {
          const scene = store.scene;
          if (scene) {
            for (const o of scene.objects) {
              const p = this.overrides.get(o.id);
              if (p) {
                o.x = p.x;
                o.y = p.y;
              }
            }
            store.markDirty();
            this.cb.onCommit?.("移动对象");
          }
        }
        this.overrides.clear();
        // 拖出地图范围只做提示，不阻止、不弹窗
        const scene = store.scene;
        if (scene) {
          const size = this.sceneSize();
          const outside = store.selection.some(
            (o) => o.x < 0 || o.y < 0 || o.x > size.w || o.y > size.h
          );
          if (outside) {
            this.flashHud(
              this.isUi()
                ? "有 UI 对象超出了设计分辨率，运行时会画在画面外（看不见）"
                : "有对象拖出了地图范围，运行时不显示它"
            );
          }
        }
        break;
      }
      case "marquee": {
        if (this.marquee && store.scene) {
          const hitList = store.scene.objects.filter((o) => {
            if (o.locked) return false;
            const b = boundsOf(o, store.project!);
            return overlap(b, this.marquee!);
          });
          if (hitList.length) store.selectMany(hitList, e.shiftKey);
        }
        this.marquee = null;
        break;
      }
      case "zone": {
        if (this.zoneRect && this.zoneRect.w > 6 && this.zoneRect.h > 6 && store.scene) {
          const t = this.tileSize();
          const obj: SceneObject = {
            id: cryptoId(),
            name: "触发区",
            kind: "ZONE",
            x: this.zoneRect.x + this.zoneRect.w / 2,
            y: this.zoneRect.y + this.zoneRect.h / 2,
            z: store.scene.objects.length,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            halfW: Math.round(this.zoneRect.w / 2),
            halfH: Math.round(this.zoneRect.h / 2),
            layerId: store.scene.layers[Math.max(0, store.scene.layers.length - 1)].id,
            visible: true,
            locked: false,
            assetId: "",
            animMode: "默认",
            animFps: 8,
            modules: [],
            props: {},
            tags: ["触发区"],
            parentId: null
          };
          store.scene.objects.push(obj);
          store.select(obj);
          store.setTool("select");
          store.markDirty();
          this.cb.onCommit?.("创建触发区");
          void t;
        }
        this.zoneRect = null;
        break;
      }
      case "scale": {
        if (this.moved) this.cb.onCommit?.("调整尺寸");
        this.scaleHandle = -1;
        break;
      }
      case "pan": {
        // 右键没有拖动 = 上下文菜单（对象菜单由外部提供）
        if (e.button === 2 && !this.moved) {
          const hit = this.pick(world);
          if (hit) {
            if (!store.isSelected(hit)) store.select(hit);
            const items = this.cb.onContextMenu?.(hit, e.clientX, e.clientY);
            if (items?.length) contextMenu(e.clientX, e.clientY, items);
          } else {
            contextMenu(e.clientX, e.clientY, this.blankMenu(world));
          }
        }
        break;
      }
      default:
        break;
    }

    this.mode = "none";
    this.moved = false;
    this.alignmentLines = [];
    this.snapHint = "";
    this.updateCursorClass();
    this.requestPaint();
  };

  private blankMenu(world: Point2): MenuItem[] {
    const lockedCount = store.scene?.objects.filter((o) => o.locked).length ?? 0;

    // UI 场景：右键菜单只给「界面元素」，不给角色/出生点/触发区。
    // 这是「UI 不该和场景物体混在一起」最直接的落实 —— 用户在 UI 场景里
    // 根本看不到「放一个角色」这种选项，也就不会把角色摆进界面上。
    if (this.isUi()) {
      return [
        { label: "放一段文字 Text", onClick: () => this.createUiAt("TEXT", world) },
        { label: "放一张图 Image", onClick: () => this.createUiAt("IMAGE", world) },
        { label: "放一个面板 Panel", onClick: () => this.createUiAt("PANEL", world) },
        { divider: true },
        { label: "放一个按钮 Button", onClick: () => this.createUiAt("BUTTON", world) },
        ...(lockedCount
          ? [{
              label: `解锁全部对象（${lockedCount}）`,
              onClick: () => {
                const scene = store.scene;
                if (!scene) return;
                for (const o of scene.objects) o.locked = false;
                store.markDirty();
                this.cb.onCommit?.("解锁全部对象");
                window.dispatchEvent(new CustomEvent("bwe:refresh"));
                this.requestPaint();
              }
            }]
          : []),
        { label: "缩放到整张设计稿", key: "F", onClick: () => this.zoomToFit() }
      ];
    }

    return [
      {
        label: "在这里放一个物件",
        onClick: () => this.createAt("PROP", world)
      },
      {
        label: "在这里放一个角色",
        onClick: () => this.createAt("ACTOR", world)
      },
      {
        label: "在这里放出生点",
        onClick: () => this.createAt("SPAWN", world)
      },
      {
        // 光源不要求先开「2D 光照」总开关：用户右键放灯，多半正想开始做夜景。
        // 真正没开时由面板/烘焙给出明确提示（这里只放对象，不改工程级设置）。
        label: "在这里放一个光源",
        onClick: () => this.createLightAt(world)
      },
      { divider: true },
      // 锁定对象的回头路：锁定后在画布上点不到它，必须留一个不用先选中它的解锁入口。
      // 更精细的方式：按住 Alt 在画布上点锁定对象，然后在右栏取消锁定。
      ...(lockedCount
        ? [{
            label: `解锁全部对象（${lockedCount}）`,
            onClick: () => {
              const scene = store.scene;
              if (!scene) return;
              for (const o of scene.objects) o.locked = false;
              store.markDirty();
              this.cb.onCommit?.("解锁全部对象");
              window.dispatchEvent(new CustomEvent("bwe:refresh"));
              this.requestPaint();
            }
          }]
        : []),
      { label: "缩放到整张地图", key: "F", onClick: () => this.zoomToFit() }
    ];
  }

  /**
   * 在 UI 场景里放一个界面元素。
   *
   * 落点不吸附瓦片网格：UI 的坐标是设计像素，32 格吸附会把按钮永远摆在
   * 32 的倍数上，做不出「离右边 16 像素」这种构图。改为吸附到 4px
   * （够稳，又不会限制排版）。
   *
   * 四种元素的默认参数都写在这里而不是散在面板里，是为了保证
   * 「随手放一个」立刻就有正确语义：
   *   TEXT   —— tags=["label"] + props.text/textSize/textColor/textAlign（运行时 drawLabel 认这套）
   *   IMAGE  —— 空素材占位，用户再从「素材」面板选图
   *   PANEL  —— props.color 半透明底 + halfW/halfH
   *   BUTTON —— 面板 + 居中文字（文字是它的子对象）
   */
  private createUiAt(kind: "TEXT" | "IMAGE" | "PANEL" | "BUTTON", world: Point2): void {
    const scene = store.scene;
    if (!scene) return;
    const snap4 = (v: number) => Math.round(v / 4) * 4;
    const layer = scene.layers[Math.max(0, scene.layers.length - 1)];
    const base: SceneObject = {
      id: cryptoId(),
      name: "",
      kind: kind === "TEXT" ? "PROP" : "PROP",
      x: snap4(world.x),
      y: snap4(world.y),
      z: scene.objects.length,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      halfW: 0,
      halfH: 0,
      layerId: layer?.id ?? "",
      visible: true,
      locked: false,
      assetId: "",
      animMode: "默认",
      animFps: 8,
      modules: [],
      props: {},
      tags: [],
      parentId: null
    };

    if (kind === "TEXT") {
      base.name = "文字";
      base.tags = ["label", "ui"];
      base.props = { text: "文字", textSize: "24", textColor: "#e6edf7", textAlign: "left" };
    } else if (kind === "IMAGE") {
      base.name = "图片";
      base.tags = ["ui"];
      // 没有素材时给一块 128×128 的占位框，避免落下去是个「一格大小」的小方块
      base.halfW = 64;
      base.halfH = 64;
    } else if (kind === "PANEL") {
      base.name = "面板";
      base.tags = ["ui"];
      base.halfW = 200;
      base.halfH = 120;
      base.props = { color: "#1b2030" };
    } else {
      base.name = "按钮";
      base.tags = ["ui"];
      base.halfW = 90;
      base.halfH = 26;
      base.props = { color: "#2f6dd6" };
      // 按钮文字作为子对象：这样移动按钮时文字跟着走（parentId 的既有语义）
      const label: SceneObject = {
        ...base,
        id: cryptoId(),
        name: "按钮文字",
        x: base.x,
        y: base.y,
        z: base.z + 1,
        halfW: 0,
        halfH: 0,
        tags: ["label", "ui"],
        props: { text: "按钮", textSize: "20", textColor: "#ffffff", textAlign: "center" },
        parentId: base.id
      };
      scene.objects.push(base);
      scene.objects.push(label);
      store.select(label);
      store.markDirty();
      this.cb.onCommit?.("创建 UI 按钮");
      this.requestPaint();
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
      return;
    }

    scene.objects.push(base);
    store.select(base);
    store.markDirty();
    this.cb.onCommit?.(`创建 UI ${base.name}`);
    this.requestPaint();
  }

  /**
   * 在空白处放一个光源。
   *
   * 为什么和 `createAt` 分开：光源的缺省 props 是**契约 §3.3 写死的一组键**，
   * 散落在通用 createAt 里会变成"每次加一种对象就多一堆 if；某天有人只改了 props 忘了改
   * 缺省半径，画布上就出现一盏半径 0、看不见的灯"。集中在一个方法里，改一处就全对。
   *
   * 缺省值（逐字照 §3.3 表格 + 编辑器常用手感）：
   *   lightRadius 140 / lightColor #FFC978 / lightIntensity 1 /
   *   lightType point / lightShadow 1（默认会被墙挡）
   * 另外顺手把半径画成一个可碰撞的圆？不：`halfW/halfH` 是**碰撞体**语义，
   * 拿它表达"照亮范围"会让物理/网格判定凭空多出一块实心方块。光照范围只写在 props。
   */
  private createLightAt(world: Point2): void {
    const scene = store.scene;
    if (!scene) return;
    const layer = scene.layers[Math.max(0, scene.layers.length - 1)];
    let i = 1;
    const base = "光源";
    while (scene.objects.some((o) => o.name === `${base} ${i}`)) i++;
    const obj: SceneObject = {
      id: cryptoId(),
      name: `${base} ${i}`,
      kind: "LIGHT",
      x: this.snap(world.x),
      y: this.snap(world.y),
      z: scene.objects.length,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      halfW: 0,
      halfH: 0,
      layerId: layer?.id ?? "",
      visible: true,
      locked: false,
      assetId: "",
      animMode: "默认",
      animFps: 8,
      modules: [],
      props: {
        lightRadius: "140",
        lightColor: "#FFC978",
        lightIntensity: "1",
        lightType: "point",
        lightShadow: "1"
      },
      tags: [],
      parentId: null
    };
    scene.objects.push(obj);
    store.select(obj);
    store.markDirty();
    this.cb.onCommit?.("创建光源");
    this.requestPaint();
  }

  /**
   * 对外的「在指定世界坐标放一盏灯」（命令面板 / 触摸板用户用）。
   * 内部实现与右键菜单完全同一条路径 —— 缺省 props 只有一份。
   */
  addLightAt(x: number, y: number): void {
    this.createLightAt({ x, y });
  }

  private createAt(kind: SceneObject["kind"], world: Point2): void {
    if (!store.scene) return;
    const t = this.tileSize();
    const layer = store.scene.layers[Math.max(0, store.scene.layers.length - 1)];
    const obj: SceneObject = {
      id: cryptoId(),
      name: kindName(kind),
      kind,
      x: this.snap(world.x),
      y: this.snap(world.y),
      z: store.scene.objects.length,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      halfW: kind === "ZONE" ? t : 0,
      halfH: kind === "ZONE" ? t : 0,
      layerId: layer?.id ?? "",
      visible: true,
      locked: false,
      assetId: "",
      animMode: "默认",
      animFps: 8,
      modules: [],
      props: {},
      tags: [],
      parentId: null
    };
    store.scene.objects.push(obj);
    store.select(obj);
    store.markDirty();
    this.cb.onCommit?.("创建对象");
    this.requestPaint();
  }

  private placeAt(world: Point2, keepTool: boolean, silent = false): void {
    if (!store.scene) return;
    const asset = store.findAsset(store.paintAssetId);
    if (!asset) {
      this.flashHud("先在左栏「素材」里选一个精灵，再用地块画笔");
      return;
    }
    const t = this.tileSize();
    const gx = Math.floor(world.x / t);
    const gy = Math.floor(world.y / t);
    const px = gx * t + t / 2;
    const py = gy * t + t / 2;
    // 同一格已有同素材就跳过，避免刷出重叠对象
    const exist = store.scene.objects.find(
      (o) => o.assetId === asset.id && Math.abs(o.x - px) < 1 && Math.abs(o.y - py) < 1
    );
    if (exist) return;
    const layer = store.scene.layers[0] ?? store.scene.layers[store.scene.layers.length - 1];
    store.scene.objects.push({
      id: cryptoId(),
      name: asset.name,
      kind: "TILE",
      x: px,
      y: py,
      z: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      halfW: 0,
      halfH: 0,
      layerId: layer?.id ?? "",
      visible: true,
      locked: false,
      assetId: asset.id,
      animMode: "默认",
      animFps: 8,
      modules: [],
      props: {},
      tags: [],
      parentId: null
    });
    store.markDirty();
    if (!silent) this.cb.onCommit?.("铺设地块");
    if (!keepTool) this.requestPaint();
  }

  /**
   * 沿上一点到当前点的整条格子路径落笔。
   *
   * 为什么不能只 paintAt(当前点)：mousemove 的采样频率跟不上手的移动速度，
   * 快速拖一笔时相邻两次事件可能隔了好几格，只按采样点落子会画成一串虚线。
   * 这里用 Bresenham 补齐格间路径，让"拖动画一条"在物理上真的是一条。
   */
  private paintStrokeTo(world: Point2): void {
    const t = this.tileSize();
    const gx = Math.floor(world.x / t);
    const gy = Math.floor(world.y / t);
    const from = this.brushLastCell;
    if (!from) {
      this.placeAt(world, false, true);
      this.brushLastCell = { gx, gy };
      return;
    }
    if (from.gx === gx && from.gy === gy) return;

    // Bresenham 走格
    let x0 = from.gx;
    let y0 = from.gy;
    const dx = Math.abs(gx - x0);
    const dy = Math.abs(gy - y0);
    const sx = x0 < gx ? 1 : -1;
    const sy = y0 < gy ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.placeAt({ x: x0 * t + t / 2, y: y0 * t + t / 2 }, false, true);
      if (x0 === gx && y0 === gy) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
    }
    this.brushLastCell = { gx, gy };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const local = { x: e.clientX - this.rectLeft(), y: e.clientY - this.rectTop() };
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.setZoom(this.zoom * factor, local);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

    if (e.code === "Space") {
      this.spaceDown = true;
      this.updateCursorClass();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      if (this.mode === "move" || this.mode === "scale") {
        this.overrides.clear();
        if (this.mode === "move") {
          for (const o of store.selection) {
            const p0 = this.pressPositions.get(o.id);
            if (p0) {
              o.x = p0.x;
              o.y = p0.y;
            }
          }
        }
        this.flashHud("已取消这次拖动");
      }
      this.mode = "none";
      this.marquee = null;
      this.zoneRect = null;
      this.alignmentLines = [];
      this.snapHint = "";
      this.updateCursorClass();
      this.requestPaint();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && store.selection.length) {
      e.preventDefault();
      this.deleteSelection();
      return;
    }
    // 方向键微调
    if (e.key.startsWith("Arrow") && store.selection.length) {
      e.preventDefault();
      const step = e.shiftKey ? this.tileSize() : 1;
      for (const o of store.selection) {
        if (o.locked) continue;
        if (e.key === "ArrowLeft") o.x -= step;
        if (e.key === "ArrowRight") o.x += step;
        if (e.key === "ArrowUp") o.y -= step;
        if (e.key === "ArrowDown") o.y += step;
      }
      store.markDirty();
      this.requestPaint();
      this.cb.onCommit?.("微调位置");
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space") {
      this.spaceDown = false;
      this.updateCursorClass();
    }
  };

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    /**
     * 同一次拖放只处理一次。
     *
     * 拖放事件在真实浏览器里可能被多个祖先各收一次（冒泡），而且画布实例在
     * 「切标签 → 重新挂载」时也不会重建监听器；历史上曾经因为面板重复挂监听
     * 出现过「拖一次变三份、越拖越多」的复制膨胀（见 assetPanel 的注释）。
     * 在事件对象上打一个标记，把「一次拖放 = 一次创建」变成结构上的保证，
     * 而不是靠"监听器只挂一个"这种容易被后续改动破坏的约定。
     */
    const mark = e as DragEvent & { __bweDropDone?: boolean };
    if (mark.__bweDropDone) return;
    mark.__bweDropDone = true;

    const dt = e.dataTransfer;
    if (!dt || !store.scene) return;
    const local = { x: e.clientX - this.rectLeft(), y: e.clientY - this.rectTop() };
    const world = this.screenToWorld(local);

    const assetId = dt.getData("application/x-bwe-asset") || dt.getData("text/plain");
    const moduleId = dt.getData("application/x-bwe-module");
    const packId = dt.getData("application/x-bwe-pack");
    // 预制体：从「预制体」面板拖进画布，在落点放一个实例。
    // mime 用本文件导出的 DND_PREFAB，别处不要再写一遍字面量。
    const prefabId = dt.getData(DND_PREFAB);

    if (prefabId) {
      const prefab = (store.project?.prefabs ?? []).find((p) => p.id === prefabId);
      if (!prefab) {
        this.flashHud("这个预制体已经不在了（可能刚被删掉）");
        return;
      }
      const layer = store.scene.layers[Math.max(0, store.scene.layers.length - 1)];
      const obj = objectFromPrefab(prefab, this.snap(world.x), this.snap(world.y), layer?.id ?? "");
      store.scene.objects.push(obj);
      store.select(obj);
      store.markDirty();
      this.cb.onCommit?.("放置预制体");
      this.requestPaint();
      return;
    }
    // 规则包：整包套到落点对象上（这就是"模块拼接"的落地方式）
    if (packId) {
      const hit = this.pick(world);
      if (!hit) {
        this.flashHud("把规则包拖到某个对象身上，整包才会生效");
        return;
      }
      store.select(hit);
      window.dispatchEvent(new CustomEvent("bwe:apply-pack", { detail: { packId, objectId: hit.id } }));
      return;
    }

    if (moduleId) {
      const hit = this.pick(world);
      if (!hit) {
        this.flashHud("把模块拖到某个对象身上才会生效");
        return;
      }
      store.select(hit);
      window.dispatchEvent(new CustomEvent("bwe:attach-module", { detail: { moduleId, objectId: hit.id } }));
      return;
    }

    if (!assetId) return;
    const asset = store.findAsset(assetId);
    if (!asset) return;
    const t = this.tileSize();
    const isTile = asset.kind === "IMAGE" || asset.kind === "ATLAS";
    const layer = isTile
      ? store.scene.layers[0]
      : store.scene.layers[Math.max(0, store.scene.layers.length - 1)];
    const obj: SceneObject = {
      id: cryptoId(),
      name: asset.name,
      kind: asset.kind === "AUDIO" ? "ZONE" : isTile && e.shiftKey ? "TILE" : "PROP",
      x: isTile && e.shiftKey ? Math.floor(world.x / t) * t + t / 2 : this.snap(world.x),
      y: isTile && e.shiftKey ? Math.floor(world.y / t) * t + t / 2 : this.snap(world.y),
      z: store.scene.objects.length,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      halfW: 0,
      halfH: 0,
      layerId: layer?.id ?? "",
      visible: true,
      locked: false,
      assetId: asset.id,
      animMode: "默认",
      animFps: 8,
      modules: [],
      props: {},
      tags: [],
      parentId: null
    };
    store.scene.objects.push(obj);
    store.select(obj);
    store.markDirty();
    this.cb.onCommit?.("放置素材");
    this.requestPaint();
  }

  deleteSelection(): void {
    const scene = store.scene;
    if (!scene) return;
    const kill = new Set(store.selection.filter((o) => !o.locked));
    if (!kill.size) return;
    scene.objects = scene.objects.filter((o) => !kill.has(o));
    store.clearSelection();
    store.markDirty();
    this.cb.onCommit?.("删除对象");
    this.requestPaint();
  }

  private flashHud(text: string): void {
    this.hudR.textContent = text;
    window.setTimeout(() => {
      this.hudR.textContent = this.hoverName;
    }, 1800);
  }

  // ---------------- 命中 ----------------

  /**
   * 命中测试：后画的在上，所以倒序查找。
   *
   * includeLocked 为 true 时连锁定对象一起纳入候选。
   * 锁定对象在画布上点不到是刻意的（防误拖），但必须留一条回来的路：
   * 否则一旦锁定，就再也选不中它、属性面板里的解锁开关也永远看不见。
   */
  pick(world: Point2, includeLocked = false): SceneObject | null {
    const scene = store.scene;
    const project = store.project;
    if (!scene || !project) return null;
    const ordered = orderObjects(scene);
    for (let i = ordered.length - 1; i >= 0; i--) {
      const o = ordered[i];
      if (!o.visible) continue;
      if (!includeLocked && o.locked) continue;
      const layer = scene.layers.find((l) => l.id === o.layerId);
      if (layer && !layer.visible) continue;
      if (layer && !includeLocked && layer.locked) continue;
      const b = boundsOf(o, project);
      if (world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y && world.y <= b.y + b.h) return o;
    }
    return null;
  }

  private hitHandle(world: Point2): number {
    const one = store.single;
    if (!one || one.locked || store.selection.length !== 1) return -1;
    const size = sizeOf(one, store.project!);
    const tol = 6 / this.zoom;
    let idx = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) {
          idx++;
          continue;
        }
        const hx = one.x + (dx * size.w) / 2;
        const hy = one.y + (dy * size.h) / 2;
        if (Math.abs(world.x - hx) <= tol && Math.abs(world.y - hy) <= tol) return idx;
        idx++;
      }
    }
    return -1;
  }

  /** 首帧渲染用的图片预热：避免大图第一次出现时闪一下。 */
  async preloadAssets(ids: string[]): Promise<void> {
    for (const id of ids) {
      const a = store.findAsset(id);
      if (a && a.kind !== "AUDIO") await loadFrame(a, 0);
    }
    this.requestPaint();
  }

  private rectLeft(): number {
    return this.canvas.getBoundingClientRect().left;
  }

  private rectTop(): number {
    return this.canvas.getBoundingClientRect().top;
  }
}

// ---------------- 辅助 ----------------

export function orderObjects(scene: { layers: { id: string }[]; objects: SceneObject[] }): SceneObject[] {
  const layerIndex = new Map<string, number>();
  scene.layers.forEach((l, i) => layerIndex.set(l.id, i));
  return scene.objects.slice().sort((a, b) => {
    const la = layerIndex.get(a.layerId) ?? scene.layers.length;
    const lb = layerIndex.get(b.layerId) ?? scene.layers.length;
    if (la !== lb) return la - lb;
    if (a.z !== b.z) return a.z - b.z;
    return a.y - b.y;
  });
}

function rectFrom(a: Point2, b: Point2): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function overlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

function cryptoId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "obj-" + Math.random().toString(36).slice(2);
}

/** 从 Portal 对象的模块里读取“加载另一张地图”模块的目标场景名。 */
function findLoadSceneTarget(portal: { modules: { defId: string; values: Record<string, string> }[] }): string | null {
  const loadMod = portal.modules.find((m) => m.defId === "fx.loadScene");
  if (!loadMod) return null;
  return loadMod.values.sceneName || null;
}

function kindName(kind: SceneObject["kind"]): string {
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
