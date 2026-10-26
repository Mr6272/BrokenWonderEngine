/**
 * 编辑器状态中心。
 *
 * 单一事实来源：所有面板从这里读"现在选中了什么、在什么模式"，
 * 通过订阅拿到变化通知，绝不互相直接持有引用 —— 否则面板一多就成蜘蛛网。
 *
 * 变更通知分粒度：selection / scene / project 三类。
 * 画布只关心 selection 与 scene，属性面板全关心，
 * 如果只有一个"全都变了"的通知，每次鼠标移动都会重刷整棵面板树。
 */

import type { Project, SceneModel, SceneObject, AssetEntry } from "./model.ts";

export type Tool = "select" | "brush" | "erase" | "zone" | "pan";

export interface ToolMeta {
  id: Tool;
  cn: string;
  en: string;
  hint: string;
  key: string;
}

export const TOOLS: ToolMeta[] = [
  { id: "select", cn: "选择", en: "Select", hint: "点选 / 拖动对象，框选多个", key: "V" },
  { id: "brush", cn: "画笔", en: "Tile Paint", hint: "连续放置地块，按住拖动画一条", key: "B" },
  { id: "erase", cn: "橡皮", en: "Erase", hint: "点掉对象", key: "E" },
  { id: "zone", cn: "触发区", en: "Trigger Area", hint: "拖出一块触发范围", key: "Z" },
  { id: "pan", cn: "抓手", en: "Pan", hint: "拖动视图；也可按住空格或鼠标右键临时切换", key: "H" }
];

type Listener = () => void;

export class Store {
  project: Project | null = null;
  /** 工程文件句柄（File System Access API 可用时才有）与文件名 */
  fileName = "";
  dirty = false;

  private _scene: SceneModel | null = null;
  selection: SceneObject[] = [];
  clipboard: SceneObject | null = null;

  tool: Tool = "select";

  // 视图
  zoom = 1;
  camX = 0;
  camY = 0;
  snapToGrid = true;
  showGrid = true;
  showColliders = true;
  showZones = true;
  showNames = true;

  /** 当前在画的素材（画笔工具） */
  paintAssetId = "";

  private selListeners = new Set<Listener>();
  private sceneListeners = new Set<Listener>();
  private projectListeners = new Set<Listener>();

  // ---------------- 工程 ----------------

  setProject(p: Project, fileName = ""): void {
    this.project = p;
    this.fileName = fileName;
    this.dirty = false;
    this.selection = [];
    this._scene = p.scenes[0] ?? null;
    this.emitScene();
    this.emitSelection();
    this.emitProject();
  }

  /**
   * 当前场景。
   * 取值时兜底：只要工程还在、场景却丢了，就回填第一个场景。
   * 这样任何一处理错都不会让编辑器停在"工程开着但画布空"的死状态。
   */
  get scene(): SceneModel | null {
    if (!this._scene && this.project?.scenes.length) {
      this._scene = this.project.scenes[0];
    }
    return this._scene;
  }

  set scene(v: SceneModel | null) {
    this._scene = v;
  }

  get assets(): AssetEntry[] {
    return this.project?.assets ?? [];
  }

  findAsset(id: string): AssetEntry | undefined {
    return this.project?.assets.find((a) => a.id === id);
  }

  markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.emitProject();
    }
  }

  markSaved(): void {
    if (this.dirty) {
      this.dirty = false;
      this.emitProject();
    }
  }

  /** 标题栏文案：未保存时前端加 ●，用户一眼知道有没有存过 */
  title(): string {
    const n = this.project?.name || "未命名工程";
    return (this.dirty ? "● " : "") + n;
  }

  // ---------------- 场景 ----------------

  setScene(s: SceneModel): void {
    if (!s || s === this._scene) return;
    this._scene = s;
    this.selection = [];
    this.emitScene();
    this.emitSelection();
  }

  // ---------------- 选择 ----------------

  get single(): SceneObject | null {
    return this.selection.length === 1 ? this.selection[0] : null;
  }

  isSelected(o: SceneObject): boolean {
    return this.selection.includes(o);
  }

  select(o: SceneObject | null, additive = false): void {
    if (!o) {
      if (this.selection.length) {
        this.selection = [];
        this.emitSelection();
      }
      return;
    }
    if (additive) {
      const i = this.selection.indexOf(o);
      if (i >= 0) this.selection.splice(i, 1);
      else this.selection.push(o);
    } else {
      if (this.selection.length === 1 && this.selection[0] === o) return;
      this.selection = [o];
    }
    this.emitSelection();
  }

  selectMany(list: SceneObject[], additive = false): void {
    if (additive) {
      for (const o of list) if (!this.selection.includes(o)) this.selection.push(o);
    } else {
      this.selection = list.slice();
    }
    this.emitSelection();
  }

  clearSelection(): void {
    if (this.selection.length) {
      this.selection = [];
      this.emitSelection();
    }
  }

  forget(o: SceneObject): void {
    const i = this.selection.indexOf(o);
    if (i >= 0) {
      this.selection.splice(i, 1);
      this.emitSelection();
    }
  }

  setTool(t: Tool): void {
    if (this.tool === t) return;
    this.tool = t;
    this.emitSelection();
  }

  // ---------------- 订阅 ----------------

  onSelection(fn: Listener): () => void {
    this.selListeners.add(fn);
    return () => this.selListeners.delete(fn);
  }

  onScene(fn: Listener): () => void {
    this.sceneListeners.add(fn);
    return () => this.sceneListeners.delete(fn);
  }

  onProject(fn: Listener): () => void {
    this.projectListeners.add(fn);
    return () => this.projectListeners.delete(fn);
  }

  /** 同时订阅三类变化（多数面板都需要，省得写三行） */
  onAny(fn: Listener): () => void {
    const a = this.onSelection(fn);
    const b = this.onScene(fn);
    const c = this.onProject(fn);
    return () => {
      a();
      b();
      c();
    };
  }

  emitSelection(): void {
    for (const fn of Array.from(this.selListeners)) fn();
  }

  emitScene(): void {
    for (const fn of Array.from(this.sceneListeners)) fn();
  }

  emitProject(): void {
    for (const fn of Array.from(this.projectListeners)) fn();
  }
}

/** 全局唯一实例。编辑器是单窗口应用，不需要多实例带来的复杂度。 */
export const store = new Store();
