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
import { objectFromPrefab } from "../core/model.ts";
import { store } from "../core/store.ts";
import { contextMenu, type MenuItem } from "../ui/toast.ts";
import { clamp } from "../core/dom.ts";
import { loadFrame } from "../data/assets.ts";
import { sizeOf, boundsOf, paintObject, paintGrid, type PaintCtx } from "./painter.ts";

type Mode = "none" | "move" | "marquee" | "pan" | "zone" | "scale";

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
    const tile = store.project?.tileSize ?? 32;
    const w = scene.widthTiles * tile;
    const h = scene.heightTiles * tile;
    const cw = this.canvas.clientWidth || 800;
    const ch = this.canvas.clientHeight || 600;
    this.zoom = clamp(Math.min((cw - 48) / w, (ch - 48) / h), 0.15, 2);
    this.camX = w / 2;
    this.camY = h / 2;
    this.requestPaint();
  }

  centerOn(x: number, y: number): void {
    this.camX = x;
    this.camY = y;
    this.requestPaint();
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
    // 序列帧预览需要持续重绘；只在动画存在或需要时重绘，避免空转吃电
    const now = performance.now();
    const hasAnim = this.sceneHasAnimation();
    if (!this.needsPaint && (!hasAnim || now - this.animTimer < 33)) return;
    this.animTimer = now;
    this.needsPaint = false;
    this.paint();
  };

  private sceneHasAnimation(): boolean {
    const scene = store.scene;
    if (!scene) return false;
    for (const o of scene.objects) {
      const a = store.findAsset(o.assetId);
      if (!a) continue;
      const frames = a.kind === "SEQUENCE" ? a.frameCount ?? 1 : a.kind === "ATLAS" ? (a.cols ?? 1) * (a.rows ?? 1) : 1;
      if (frames > 1 && o.animMode !== "只显示首帧") return true;
    }
    return false;
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
    // 直接写死颜色：getComputedStyle 读自定义属性在部分浏览器返回未解析的字符串，
    // 会让 fillStyle 失效变成黑色，这类"静默失效"最难查，索性不依赖它。
    g.fillStyle = "#15171d";
    g.fillRect(0, 0, cw, ch);

    const scene = store.scene;
    const project = store.project;
    if (!scene || !project) {
      this.hudL.textContent = "";
      this.drawCenterText(g, "没有打开的场景", "用「文件 → 新建工程」开始，或打开一个 .bwproj");
      return;
    }

    const pctx: PaintCtx = {
      zoom: this.zoom,
      tileSize: project.tileSize,
      showGrid: store.showGrid,
      showColliders: store.showColliders,
      showZones: store.showZones,
      showNames: store.showNames,
      time: performance.now(),
      selectedIds: new Set(store.selection.map((o) => o.id)),
      overrides: this.overrides,
      project
    };

    paintGrid(g, undefined, scene, pctx, this.worldToScreen.bind(this));

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
      g.fillStyle = "#f0a92b";
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
    g.fillStyle = linked ? "#8b7cf6" : "rgba(140,150,170,0.55)";
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
        g.save();
        g.fillStyle = "#ffffff";
        g.strokeStyle = "#4c8dff";
        g.lineWidth = 1.2;
        g.fillRect(s.x - hs / 2, s.y - hs / 2, hs, hs);
        g.strokeRect(s.x - hs / 2, s.y - hs / 2, hs, hs);
        g.restore();
      }
    }
    void b;
  }

  private hudText(): string {
    const t = this.tileSize();
    const w = this.hoverWorld;
    return `格 ${Math.round(w.x / t)}, ${Math.round(w.y / t)}　|　px ${Math.round(w.x)}, ${Math.round(w.y)}`;
  }

  private drawCenterText(g: CanvasRenderingContext2D, title: string, sub: string): void {
    const cw = this.canvas.clientWidth;
    const chh = this.canvas.clientHeight;
    g.save();
    g.textAlign = "center";
    g.fillStyle = "#8a94a6";
    g.font = '600 15px "Microsoft YaHei UI", sans-serif';
    g.fillText(title, cw / 2, chh / 2 - 6);
    g.fillStyle = "#5f6879";
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
      const hit = this.pick(this.pressWorld);
      if (hit) {
        scene.objects = scene.objects.filter((o) => o !== hit);
        store.forget(hit);
        store.markDirty();
        this.cb.onCommit?.("删除对象");
        this.requestPaint();
      }
      this.mode = "none";
      return;
    }

    if (store.tool === "zone") {
      this.mode = "zone";
      this.zoneRect = { x: this.pressWorld.x, y: this.pressWorld.y, w: 0, h: 0 };
      return;
    }

    if (store.tool === "brush") {
      this.placeAt(this.pressWorld, e.shiftKey);
      this.mode = "none";
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

          // 对每个参照对象，检查边缘/中心对齐
          for (const r of refs) {
            const rs = sizeOf(r, project);
            // 垂直对齐线（x 方向）：左-左、右-右、中心-中心
            const rx = r.x;
            const rRight = r.x + rs.w;
            const rCx = r.x + rs.w / 2;
            const oLeft = cx - size.w / 2;
            const oRight = cx + size.w / 2;
            const oCx = cx + size.w / 2;

            const checkV = (lineX: number, label: string) => {
              if (Math.abs(oLeft - lineX) <= ALIGN_TOL) { cx = lineX + size.w / 2; addV(lineX); aligned = true; this.snapHint = label; return true; }
              if (Math.abs(oRight - lineX) <= ALIGN_TOL) { cx = lineX - size.w / 2; addV(lineX); aligned = true; this.snapHint = label; return true; }
              if (Math.abs(oCx - lineX) <= ALIGN_TOL) { cx = lineX; addV(lineX); aligned = true; this.snapHint = label; return true; }
              return false;
            };

            // 水平对齐线（y 方向）：上-上、下-下、中心-中心
            const ry = r.y;
            const rBottom = r.y + rs.h;
            const rCy = r.y + rs.h / 2;
            const oTop = cy - size.h / 2;
            const oBottom = cy + size.h / 2;
            const oCy = cy + size.h / 2;

            const checkH = (lineY: number, label: string) => {
              if (Math.abs(oTop - lineY) <= ALIGN_TOL) { cy = lineY + size.h / 2; addH(lineY); aligned = true; this.snapHint = label; return true; }
              if (Math.abs(oBottom - lineY) <= ALIGN_TOL) { cy = lineY - size.h / 2; addH(lineY); aligned = true; this.snapHint = label; return true; }
              if (Math.abs(oCy - lineY) <= ALIGN_TOL) { cy = lineY; addH(lineY); aligned = true; this.snapHint = label; return true; }
              return false;
            };

            const addV = (x: number) => this.alignmentLines.push({ x, y: -9999, w: 1, h: 9999, kind: "v" });
            const addH = (y: number) => this.alignmentLines.push({ x: -9999, y, w: 9999, h: 1, kind: "h" });

            // 尝试对齐（优先对齐最近的一个）
            if (!aligned) {
              checkV(rx, `对齐「${r.name}」左边`);
              checkV(rRight, `对齐「${r.name}」右边`);
              checkV(rCx, `对齐「${r.name}」中心`);
            }
            if (!aligned) {
              checkH(ry, `对齐「${r.name}」上边`);
              checkH(rBottom, `对齐「${r.name}」下边`);
              checkH(rCy, `对齐「${r.name}」中心`);
            }
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
          const t = this.tileSize();
          const outside = store.selection.some(
            (o) => o.x < 0 || o.y < 0 || o.x > scene.widthTiles * t || o.y > scene.heightTiles * t
          );
          if (outside) this.flashHud("有对象拖出了地图范围，运行时不显示它");
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

  private placeAt(world: Point2, keepTool: boolean): void {
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
    this.cb.onCommit?.("铺设地块");
    if (!keepTool) this.requestPaint();
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
