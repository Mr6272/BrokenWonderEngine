import { MineBoard, type MineOptions } from "./mine";
import { createSave } from "./save";
import { TextInputManager } from "./textinput";
﻿/**
 * BWE Web 播放器 · API 垫片
 *
 * 设计原则：**宁可大声报错，不要静默失败。**
 *
 * 脚本里的 `bwe.xxx()` 在 Java 运行时里是真的有实现。搬到浏览器后，
 * 没实现的如果我们返回 undefined 或空函数，游戏会"看起来能跑"，
 * 但行为是错的——玩家点了没反应、敌人不动、分数不加。这种 bug 最难查，
 * 因为控制台一片干净。
 *
 * 所以这里把 API 分成三级：
 *   TIER_OK      真实现，语义与 Java 侧一致
 *   TIER_PARTIAL 简化实现，能跑但少了某些分支（会打一次警告说明差异）
 *   TIER_MISSING 没有实现，调用时抛出一次带名字的错误，并计数上报
 *
 * 导出产物里带一个 `/__bwe_report()` 可以随时查看当前缺了什么。
 */

import type { Renderer, SceneObject, BootManifest } from "./renderer";

export type Tier = "ok" | "partial" | "missing";

export interface ApiReport {
  ok: string[];
  partial: string[];
  missingCalls: { name: string; count: number; firstStack: string }[];
}

const report: ApiReport = { ok: [], partial: [], missingCalls: [] };
const partialWarned = new Set<string>();

/** 记录一次缺失调用。同一个名字只保留一条，但计数累加。 */
function miss(name: string): void {
  const existing = report.missingCalls.find((m) => m.name === name);
  if (existing) {
    existing.count++;
    return;
  }
  const stack = new Error().stack ?? "";
  report.missingCalls.push({
    name,
    count: 1,
    firstStack: stack.split("\n").slice(1, 4).join("\n"),
  });
  // 只在第一次报错，避免每帧刷屏把控制台淹掉。
  console.error(
    `[BWE/Web] 未实现的 API: bwe.${name}\n` +
      `  这个调用在 Java 运行时里有效，但 Web 播放器还没有实现。\n` +
      `  游戏不会因此崩溃，但这个功能是哑的。用 __bwe_report() 查看完整清单。`
  );
}

/** 记录一次简化实现，同样每个名字只警告一次。 */
function partial(name: string, note: string): void {
  if (partialWarned.has(name)) return;
  partialWarned.add(name);
  report.partial.push(name);
  console.warn(`[BWE/Web] bwe.${name} 是简化实现：${note}`);
}

/** 造一个两级代理：访问未知成员时记录缺失，调用时记录缺失。 */
function missingNamespace(prefix: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop === "symbol") return undefined;
        const name = `${prefix}.${prop}`;
        if (!report.missingCalls.some((m) => m.name === name)) miss(name);
        return (..._args: unknown[]) => {
          miss(name);
          return undefined;
        };
      },
    }
  );
}

export interface InputState {
  keys: Set<string>;
  mouse: { x: number; y: number; down: boolean; button: number };
  pressedThisFrame: Set<string>;
  releasedThisFrame: Set<string>;
  clickedThisFrame: boolean;
  wheel: number;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface LiveSound {
  id: number;
  name: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** 音乐槽：同一时刻只有一首，新的 music() 会停掉旧的。 */
  music: boolean;
}

export interface AudioState {
  ctx?: AudioContext | null;
  /** 预解码的音频数据：bwe.audio.play(id) 从这里取 */
  buffers: Map<string, AudioBuffer>;
  /** 正在播的音源。stop(id) / stop(name) 靠它定位。 */
  live: LiveSound[];
  nextId: number;
  /** 当前 BGM 的 id，没有是 -1。 */
  musicId: number;
  /** 主音量 / 音乐 / 音效，0~1 */
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
}

export interface PlayerContext {
  renderer: Renderer;
  /** 显示画布。textinput 定位与屏幕坐标换算都要它。 */
  canvas: HTMLCanvasElement;
  boot: BootManifest;
  baseUrl: string;
  scene: { objects: SceneObject[]; width: number; height: number };
  input: InputState;
  camera: CameraState;
  audio: AudioState;
  time: { elapsed: number; dt: number; frame: number };
  /** 脚本共享的全局变量表（对应 boot.json 的 variables） */
  vars: Record<string, unknown>;
  /** 绘制队列：脚本在本帧追加的自定义绘制（bwe.draw.*） */
  drawQueue: DrawCmd[];
  /** 脚本通过 bwe.world.spawn 生成的运行期对象 */
  spawned: SceneObject[];
  /** bwe.textinput 的宿主（api.ts 里注入，player.ts 路由点击时用） */
  textInput?: TextInputManager;
}

export type DrawCmd =
  | { kind: "rect"; x: number; y: number; w: number; h: number; color: string; filled: boolean; layer: number }
  | { kind: "text"; text: string; x: number; y: number; size: number; color: string; align: string; layer: number }
  | { kind: "circle"; x: number; y: number; r: number; color: string; filled: boolean; layer: number };

/** 把 #rgb / #rrggbb / #rrggbbaa 解析成 0~1 四通道 */
export function parseColor(css: string): { r: number; g: number; b: number; a: number } {
  if (typeof css !== "string") return { r: 1, g: 1, b: 1, a: 1 };
  const s = css.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16) / 255,
        g: parseInt(h[1] + h[1], 16) / 255,
        b: parseInt(h[2] + h[2], 16) / 255,
        a: 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((v) => parseFloat(v));
    return { r: (p[0] ?? 255) / 255, g: (p[1] ?? 255) / 255, b: (p[2] ?? 255) / 255, a: p[3] ?? 1 };
  }
  return { r: 1, g: 1, b: 1, a: 1 };
}

/**
 * 构造 bwe 对象。这是脚本唯一能看见的宿主接口。
 */
export function createBwe(ctx: PlayerContext): Record<string, unknown> {
  const { renderer, input, camera, time, vars, drawQueue, scene } = ctx;

  const bwe: Record<string, unknown> = {};

  // ---------- bwe.time ----------
  bwe.time = {
    get now() { return time.elapsed; },
    get delta() { return time.dt; },
    get dt() { return time.dt; },
    get frame() { return time.frame; },
  };
  report.ok.push("time.now/delta/frame");

  // ---------- bwe.input ----------
  // 键名与 ScriptEngine.keyCode 同一张表：大小写不敏感，"W"/"KeyW"/"keyw" 都是 W。
  const held = (key: unknown): boolean => input.keys.has(canonKey(key));
  bwe.input = {
    down(key: string): boolean {
      return held(key);
    },
    pressed(key: string): boolean {
      return input.pressedThisFrame.has(canonKey(key));
    },
    released(key: string): boolean {
      return input.releasedThisFrame.has(canonKey(key));
    },
    /** WASD / 方向键合成的单位向量，Y 向下为正，和 Java 侧一致。 */
    axis(): { x: number; y: number } {
      const x = (held("D") || held("ArrowRight") ? 1 : 0) - (held("A") || held("ArrowLeft") ? 1 : 0);
      const y = (held("S") || held("ArrowDown") ? 1 : 0) - (held("W") || held("ArrowUp") ? 1 : 0);
      const len = Math.hypot(x, y);
      return len > 1 ? { x: x / len, y: y / len } : { x, y };
    },
    get mouse() {
      return {
        x: input.mouse.x,
        y: input.mouse.y,
        down: input.mouse.down,
        button: input.mouse.button,
        clicked: input.clickedThisFrame,
      };
    },
    get wheel() { return input.wheel; },
    /** 触屏摇杆。Web 端第一版不提供虚拟摇杆 UI。 */
    get stick() { return missingNamespace("input.stick"); },
  };
  report.ok.push("input.down/pressed/released/axis/mouse/wheel");
  report.missingCalls.push({
    name: "input.stick",
    count: 0,
    firstStack: "Web 播放器未实现虚拟摇杆",
  });

  // ---------- bwe.camera ----------
  bwe.camera = {
    get x() { return camera.x; },
    set x(v: number) { camera.x = v; },
    get y() { return camera.y; },
    set y(v: number) { camera.y = v; },
    get zoom() { return camera.zoom; },
    set zoom(v: number) { camera.zoom = v; },
    /** 视口尺寸（CSS 像素） */
    get size() {
      const c = renderer.gl.canvas as HTMLCanvasElement;
      return { w: c.clientWidth, h: c.clientHeight };
    },
    worldToScreen(x: number, y: number) {
      const c = renderer.gl.canvas as HTMLCanvasElement;
      return {
        x: (x - camera.x) * camera.zoom + c.clientWidth / 2,
        y: (y - camera.y) * camera.zoom + c.clientHeight / 2,
      };
    },
    screenToWorld(x: number, y: number) {
      const c = renderer.gl.canvas as HTMLCanvasElement;
      return {
        x: (x - c.clientWidth / 2) / camera.zoom + camera.x,
        y: (y - c.clientHeight / 2) / camera.zoom + camera.y,
      };
    },
  };
  report.ok.push("camera.x/y/zoom/size/worldToScreen/screenToWorld");

  // ---------- bwe.draw：脚本主动绘制 ----------
  // Java 侧是立即绘制；这里入队，由主循环在本帧统一按 layer 排序后画。
  bwe.draw = {
    rect(x: number, y: number, w: number, h: number, color: string, opts?: { filled?: boolean; layer?: number }) {
      drawQueue.push({
        kind: "rect",
        x, y, w, h,
        color: typeof color === "string" ? color : "#fff",
        filled: opts?.filled !== false,
        layer: opts?.layer ?? 0,
      });
    },
    circle(x: number, y: number, r: number, color: string, opts?: { filled?: boolean; layer?: number }) {
      drawQueue.push({
        kind: "circle",
        x, y, r,
        color: typeof color === "string" ? color : "#fff",
        filled: opts?.filled !== false,
        layer: opts?.layer ?? 0,
      });
    },
    text(text: unknown, x: number, y: number, opts?: { size?: number; color?: string; align?: string; layer?: number }) {
      drawQueue.push({
        kind: "text",
        text: String(text ?? ""),
        x, y,
        size: opts?.size ?? 16,
        color: opts?.color ?? "#fff",
        align: opts?.align ?? "left",
        layer: opts?.layer ?? 0,
      });
    },
    measureText(text: unknown, opts?: { size?: number }) {
      // 与 Canvas2D 的测量保持一致，避免对齐位置在两端不同。
      const c = document.createElement("canvas");
      const g = c.getContext("2d");
      const size = opts?.size ?? 16;
      if (!g) return { w: String(text ?? "").length * size * 0.5, h: size };
      g.font = `${size}px monospace`;
      const m = g.measureText(String(text ?? ""));
      return { w: m.width, h: size };
    },
  };
  report.ok.push("draw.rect/circle/text/measureText");

  // ---------- bwe.world ----------
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const allObjects = (): SceneObject[] => [...scene.objects, ...ctx.spawned];
  const findByName = (name: string): SceneObject | null =>
    allObjects().find((o) => o.name === name) ?? null;

  bwe.world = {
    find(name: string) {
      const o = findByName(String(name));
      return o ? wrapEntity(o, ctx) : null;
    },
    findAll(filter?: string | { name?: string; tag?: string; kind?: string }) {
      let list = allObjects();
      if (typeof filter === "string") {
        list = list.filter((o) => o.name === filter || o.kind === filter);
      } else if (filter && typeof filter === "object") {
        if (filter.name) list = list.filter((o) => o.name!.startsWith(filter.name!));
        if (filter.kind) list = list.filter((o) => o.kind === filter.kind);
      }
      return list.map((o) => wrapEntity(o, ctx));
    },
    get count() { return allObjects().length; },
    spawn(def: Record<string, unknown>) {
      // 运行期生成：直接进场景表，由渲染循环接管。
      const o: SceneObject = {
        id: `spawn_${Math.random().toString(36).slice(2, 9)}`,
        name: String(def.name ?? "spawned"),
        kind: String(def.kind ?? "ACTOR"),
        x: Number(def.x ?? 0),
        y: Number(def.y ?? 0),
        layer: Number(def.layer ?? 0),
        z: Number(def.z ?? 0),
        rotation: Number(def.rotation ?? 0),
        scaleX: Number(def.scaleX ?? 1),
        scaleY: Number(def.scaleY ?? 1),
        halfW: Number(def.halfW ?? 16),
        halfH: Number(def.halfH ?? 16),
        assetId: String(def.assetId ?? def.asset ?? ""),
        animMode: String(def.animMode ?? "默认"),
        animFps: Number(def.animFps ?? 8),
        visible: def.visible !== false,
        modules: [],
      };
      ctx.spawned.push(o);
      return wrapEntity(o, ctx);
    },
    emit(name: string, ...args: unknown[]) {
      const handlers = listeners.get(String(name));
      if (!handlers) return;
      for (const h of handlers) {
        try {
          h(...args);
        } catch (e) {
          console.error(`[BWE/Web] 事件 ${name} 的处理器抛错:`, e);
        }
      }
    },
    on(name: string, handler: (...a: unknown[]) => void) {
      const k = String(name);
      if (!listeners.has(k)) listeners.set(k, []);
      listeners.get(k)!.push(handler);
    },
    off(name: string, handler?: (...a: unknown[]) => void) {
      const k = String(name);
      if (!handler) {
        listeners.delete(k);
        return;
      }
      const arr = listeners.get(k);
      if (!arr) return;
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    },
    get variables() { return vars; },
  };
  report.ok.push("world.find/findAll/spawn/emit/on/off/variables");

  // ---------- bwe.params / ctx.params：脚本「公开字段」 ----------
  //
  // 与 Java 侧（src/Studio/runtime/ScriptParams.java）**同一套语义**，别在这里另发明一套：
  //   1. 脚本顶层调 bwe.params({...}) ⇒ 登记这个脚本的默认值表，返回一份拷贝；
  //   2. 回调里调 bwe.params() ⇒ 返回「默认值 ∪ 当前对象的覆盖值」（新对象，改它不串味）；
  //   3. ctx.params ⇒ 同上，但由宿主在每次回调里给出（见 player.ts 的 objectCtx）。
  //
  // 覆盖值从哪来：boot.json 里该对象 script.js 模块 params 的 **params** 键（JSON 文本，
  // 只含用户改过的项），由 package-bwe.mjs 从工程里原样搬过来。
  const paramHost = createParamHost(ctx);
  bwe.params = (defs?: Record<string, unknown>) => paramHost.params(defs);
  report.ok.push("params(defs)");

  // ---------- bwe.audio ----------
  bwe.audio = {
    play(name: string, opts?: { volume?: number; loop?: boolean; pitch?: number }): number {
      return playSound(ctx, String(name), opts?.volume ?? 1, opts?.loop ?? false, opts?.pitch ?? 1, false);
    },
    /** 传 id 停一个，传名字停掉所有同名实例。和 Java 侧 stop / stopByName 一致。 */
    stop(idOrName?: number | string): void {
      stopSound(ctx, idOrName);
    },
    music(name: string, opts?: { volume?: number; loop?: boolean }): number {
      return playSound(ctx, String(name), opts?.volume ?? 1, opts?.loop !== false, 1, true);
    },
    volume(v: number): void {
      ctx.audio.master = Math.max(0, Math.min(1, Number(v) || 0));
      for (const s of ctx.audio.live) s.gain.gain.value = ctx.audio.master;
    },
  };
  report.ok.push("audio.play/stop/music/volume");

  // ---------- bwe.textinput：真的浮一个 <input> 在画布上 ----------
  // Java 侧桌面读物理键盘、Android 弹软键盘；浏览器里最接近的等价物是真实 input 元素。
  const ti = new TextInputManager(ctx.canvas);
  ctx.textInput = ti;
  const textinputNs = {
    define(id: unknown, value: unknown, min: unknown, max: unknown, numeric?: unknown): void {
      ti.define(String(id ?? ""), String(value ?? ""), Number(min) || 0, Number(max) || 0, numeric === undefined ? true : !!numeric);
    },
    rect(id: unknown, nx: unknown, ny: unknown, nw: unknown, nh: unknown): void {
      ti.rect(String(id ?? ""), Number(nx) || 0, Number(ny) || 0, Number(nw) || 0, Number(nh) || 0);
    },
    value(id: unknown): string { return ti.value(String(id ?? "")); },
    number(id: unknown, dflt?: unknown): number { return ti.number(String(id ?? ""), Number(dflt) || 0); },
    setValue(id: unknown, text: unknown): void { ti.setValue(String(id ?? ""), String(text ?? "")); },
    active(): string { return ti.active(); },
    cancel(): void { ti.cancel(); },
    hint(id: unknown): string { return ti.hint(String(id ?? "")); },
    refreshHints(): void { ti.refreshHints(); },
    onSubmit(fn: unknown): void {
      if (typeof fn !== "function") return;
      ti.onSubmit(fn as (id: string, text: string) => void);
    },
    get editing(): string { return ti.editing; },
  };
  (bwe as Record<string, unknown>).textinput = textinputNs;
  report.ok.push("textinput.define/rect/value/number/setValue/active/cancel/hint/onSubmit");

  // ---------- bwe.mine：引擎侧托管的扫雷板 ----------
  // Java 侧棋盘、规则、绘制全在引擎里（Minesweeper.java / GridPainter.java），
  // 脚本只读 state() 并下发 set()/reset()。Web 端用 mine.ts 的行为移植顶上。
  let mineBoard: MineBoard | null = null;
  const mineNs = {
    state(): ReturnType<MineBoard["state"]> {
      if (!mineBoard) mineBoard = new MineBoard();
      return mineBoard.state();
    },
    set(opts: MineOptions): ReturnType<MineBoard["state"]> {
      if (!mineBoard) mineBoard = new MineBoard(opts || {});
      else mineBoard.configure(opts || {});      return mineBoard.state();
    },
    reset(): ReturnType<MineBoard["state"]> {
      if (!mineBoard) mineBoard = new MineBoard();
      mineBoard.reset();
      return mineBoard.state();
    },
    /** 内部：拿到底层棋盘（给 player 的点击路由与绘制用） */
    __board(): MineBoard | null { return mineBoard; },
  };
  (bwe as Record<string, unknown>).mine = mineNs;
  report.ok.push("mine.state/set/reset");

  // ---------- bwe.save：本地 JSON 存档 ----------
  // 浏览器写不了 <Build 父目录>/saves，落在 localStorage，键按工程名隔离。
  bwe.save = createSave({
    project: String(ctx.boot.project ?? "game"),
    warn: (name, note) => partial(name, note),
  });
  report.ok.push("save.set/get/has/remove/clear/flush/write/read/exists/delete");

  // ---------- bwe.grid：格子换算 ----------
  // 和 ScriptWorld 一样：cell = floor(像素 / tileSize)，中心 = (cell + 0.5) * tileSize。
  const tile = Math.max(1, Number(ctx.boot.tileSize) || 32);
  bwe.grid = {
    get cellSize() { return tile; },
    toCell(x: number, y: number) {
      return { cx: Math.floor(Number(x) / tile), cy: Math.floor(Number(y) / tile) };
    },
    toWorld(cx: number, cy: number) {
      return { x: (Math.floor(Number(cx)) + 0.5) * tile, y: (Math.floor(Number(cy)) + 0.5) * tile };
    },
    snap(x: number, y: number) {
      return {
        x: (Math.floor(Number(x) / tile) + 0.5) * tile,
        y: (Math.floor(Number(y) / tile) + 0.5) * tile,
      };
    },
  };
  report.ok.push("grid.cellSize/toCell/toWorld/snap");

  // ---------- bwe.log / bwe.error ----------
  // Java 侧带 [脚本] 前缀写到宿主日志。浏览器没有那条通道，写到控制台。
  const joinArgs = (args: unknown[]): string => args.map((a) => String(a ?? "")).join(" ");
  bwe.log = (...args: unknown[]) => { console.log("[脚本] " + joinArgs(args)); };
  bwe.error = (...args: unknown[]) => { console.error("[脚本] [错误] " + joinArgs(args)); };
  report.ok.push("log/error");

  // ---------- 未实现的高级命名空间 ----------
  // 这些在 Java 侧有完整实现，Web 端第一版没有。列出来是为了让用户在
  // __bwe_report() 里一眼看到"我的游戏用到哪些还没搬过来的东西"。
  const UNIMPLEMENTED = [
    "road", "vehicle", "combat", "material", "field", "sense", "faction",
    "light", "postfx", "particle", "tilemap", "nav", "physics", "joint",
    "prefab", "pool", "ui", "stick", "spatial",
    "collision", "anim", "scene", "dialog", "quest", "ai",
  ];
  for (const ns of UNIMPLEMENTED) {
    if (!(ns in bwe)) {
      bwe[ns] = missingNamespace(ns);
    }
  }

  // 已经真实现的命名空间不算缺失
  report.missingCalls = report.missingCalls.filter((m) => m.count > 0);

  return bwe;
}

/**
 * 查询用的键名归一。存储端存的是 ScriptEngine.keyName 的规范名
 * （KeyW / Digit1 / Space / ArrowLeft），脚本侧 "W"、"w"、"KeyW" 都要命中。
 */
export function canonKey(key: unknown): string {
  const raw = String(key ?? "");
  if (raw === " ") return "Space";
  const s = raw.trim();
  if (!s) return "";
  // 存储端用的就是这套规范名，先原样认，避免 "Space" 被小写表误伤。
  const CANON = ["Space", "Enter", "Escape", "Tab", "Backspace", "Shift", "Control", "Alt",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Minus", "Equal", "Comma", "Period",
    "Slash", "Semicolon", "Quote", "BracketLeft", "BracketRight", "Backslash", "Backquote"];
  if (CANON.includes(s)) return s;
  const table: Record<string, string> = {
    " ": "Space", space: "Space",
    enter: "Enter", return: "Enter",
    escape: "Escape", esc: "Escape",
    tab: "Tab", backspace: "Backspace",
    shift: "Shift", shiftleft: "Shift", shiftright: "Shift",
    control: "Control", ctrl: "Control", controlleft: "Control",
    alt: "Alt", altleft: "Alt",
    arrowleft: "ArrowLeft", left: "ArrowLeft",
    arrowright: "ArrowRight", right: "ArrowRight",
    arrowup: "ArrowUp", up: "ArrowUp",
    arrowdown: "ArrowDown", down: "ArrowDown",
  };
  const hit = table[s.toLowerCase()];
  if (hit) return hit;
  if (/^key[a-z]$/i.test(s)) return "Key" + s.slice(3).toUpperCase();
  if (/^digit\d$/i.test(s)) return "Digit" + s.slice(5);
  if (/^[a-z]$/i.test(s)) return "Key" + s.toUpperCase();
  if (/^[0-9]$/.test(s)) return "Digit" + s;
  if (/^f([1-9]|1[0-2])$/i.test(s)) return "F" + s.slice(1);
  return s;
}

/**
 * 脚本「公开字段」的 Web 侧实现（与 Java 的 {@code ScriptParams} 一一对应）。
 *
 * ## 为什么需要「当前对象」这个概念
 * 脚本在 Web 播放器里是**一个句柄**（{@link PlayerContext} 里没有 scope 之分），
 * 同一个 enemy.js 被十只小怪共用 —— 参数必须按**调用期**的对象区分，
 * 所以：{@link setCurrentSelf} 由播放器在派发对象回调前后调用，
 * {@link params} 读到的就是「这一只」的覆盖值。用完立刻恢复上一层的 self，
 * 嵌套调用（A 的回调里调 B 的方法）也不会串。
 */
export interface ParamHost {
  /** `bwe.params(defs?)` */
  params(defs?: Record<string, unknown>): Record<string, unknown>;
  /** `ctx.params`：当前对象的有效参数（没有对象时是空对象） */
  current(): Record<string, unknown>;
  /** 播放器在派发对象回调前后调用；传 null 表示恢复成"没有对象" */
  setCurrentSelf(o: SceneObject | null): void;
  /** 当前对象（诊断用） */
  currentSelf(): SceneObject | null;
}

/**
 * 对象上存的覆盖值：`script.js` 模块 `params.params` 的 JSON 文本。
 *
 * 解析失败 = 没有覆盖（与 Java 侧一致）：手改坏的 Build 不该让游戏起不来。
 */
function overridesOf(o: SceneObject | null): Record<string, unknown> {
  if (!o || !Array.isArray(o.modules)) return {};
  for (const raw of o.modules) {
    const m = raw as { def?: unknown; id?: unknown; params?: Record<string, unknown> } | null;
    if (!m) continue;
    const def = String(m.def ?? m.id ?? "");
    if (def !== "script.js" && def !== "script") continue;
    const text = m.params?.["params"];
    if (typeof text !== "string" || !text.trim()) return {};
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) return {};
      return data as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

/** 该对象挂的脚本名（script.js 模块的 params.script）。 */
function scriptNameOf(o: SceneObject | null): string {
  if (!o || !Array.isArray(o.modules)) return "";
  for (const raw of o.modules) {
    const m = raw as { def?: unknown; id?: unknown; params?: Record<string, unknown> } | null;
    if (!m) continue;
    const def = String(m.def ?? m.id ?? "");
    if (def !== "script.js" && def !== "script") continue;
    const v = m.params?.["script"];
    return typeof v === "string" ? v : "";
  }
  return "";
}

/** 对象上挂的脚本名（供 player 派发对象脚本）：没有就返回空串。 */
export function objectScriptName(o: SceneObject): string {
  return scriptNameOf(o);
}

/** 建一个参数宿主（每个播放器实例一个，默认值表按脚本名缓存）。 */
export function createParamHost(ctx: PlayerContext): ParamHost {
  /** 脚本名 → 顶层声明的默认值 */
  const declared = new Map<string, Record<string, unknown>>();
  let self: SceneObject | null = null;

  const effective = (defaults: Record<string, unknown> | undefined, o: SceneObject | null): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...(defaults ?? {}) };
    const ov = overridesOf(o);
    for (const [k, v] of Object.entries(ov)) {
      // 只认「默认值表里存在的键」：脚本删掉字段后，工程里的残留覆盖不该变成新参数
      if (defaults && !(k in defaults)) continue;
      out[k] = coerceLike(defaults?.[k], v);
      if (out[k] === undefined) delete out[k];
    }
    return out;
  };

  return {
    params(defs) {
      if (!defs || typeof defs !== "object") {
        // bwe.params() 不带参数 = 「我要当前对象的有效参数」，与 ctx.params 等价
        const name = scriptNameOf(self);
        return effective(name ? declared.get(name) : undefined, self);
      }
      // 顶层声明：登记默认值（拷贝一份，脚本后面改自己的字面量不会影响缓存）
      const name = scriptNameOf(self);
      if (name) declared.set(name, { ...defs });
      if (!self) return { ...defs };
      return effective(defs, self);
    },
    current() {
      const name = scriptNameOf(self);
      return effective(name ? declared.get(name) : undefined, self);
    },
    setCurrentSelf(o) {
      self = o;
    },
    currentSelf() {
      return self;
    },
  };
}

/** 按默认值的类型归一覆盖值（与 Java 的 ScriptParams.coerce 同一套规则）。 */
function coerceLike(base: unknown, raw: unknown): unknown {
  if (base === undefined) return raw;
  if (typeof base === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "boolean") return raw ? 1 : 0;
    if (typeof raw === "string" && raw.trim()) {
      const n = Number(raw.trim());
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }
  if (typeof base === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw !== 0;
    if (typeof raw === "string") {
      const s = raw.trim();
      if (/^(true|1|开|是)$/i.test(s)) return true;
      if (/^(false|0|关|否)$/i.test(s)) return false;
    }
    return undefined;
  }
  if (typeof base === "string") {
    if (raw === null || raw === undefined) return "";
    return String(raw);
  }
  // 默认值是 null 的字段：原样保留
  return raw;
}

/**
 * 把场景对象包成 bwe.d.ts 里那个 Entity 接口。
 * 只包真正支持的字段；不支持的属性访问会走到 missing 记录。
 */
function wrapEntity(o: SceneObject, ctx: PlayerContext): Record<string, unknown> {
  const SUPPORTED = new Set([
    "id", "name", "kind", "x", "y", "z", "rotation", "scaleX", "scaleY",
    "visible", "alive", "pos", "setPos", "size", "setSize", "layer",
    "asset", "animMode", "animFps", "props", "prop", "setProp",
  ]);
  return new Proxy(o as unknown as Record<string, unknown>, {
    get(target, prop: string | symbol) {
      if (typeof prop === "symbol") return target[prop as never];
      if (prop === "pos") return { x: target.x, y: target.y };
      if (prop === "setPos") {
        return (x: number, y: number) => { target.x = x; target.y = y; };
      }
      if (prop === "size") return { w: Number(target.halfW) * 2, h: Number(target.halfH) * 2 };
      if (prop === "setSize") {
        return (w: number, h: number) => { target.halfW = w / 2; target.halfH = h / 2; };
      }
      if (prop === "alive") return true;
      if (prop === "asset") return target.assetId;
      // props 是脚本挂在对象上的自定义键值袋（Java 侧 Entity 就有）。没有就建一个空的。
      if (prop === "props") {
        const t = target as unknown as { props?: Record<string, unknown> };
        if (!t.props || typeof t.props !== "object") t.props = {};
        return t.props;
      }
      if (prop === "prop") {
        return (k: string, dflt?: unknown) => {
          const t = target as unknown as { props?: Record<string, unknown> };
          const v = t.props ? t.props[String(k)] : undefined;
          return v === undefined ? dflt : v;
        };
      }
      if (prop === "setProp") {
        return (k: string, v: unknown) => {
          const t = target as unknown as { props?: Record<string, unknown> };
          if (!t.props || typeof t.props !== "object") t.props = {};
          t.props[String(k)] = v;
        };
      }
      if (SUPPORTED.has(prop)) return target[prop];
      if (!report.missingCalls.some((m) => m.name === `Entity.${prop}`)) {
        miss(`Entity.${prop}`);
      }
      return undefined;
    },
    set(target, prop: string | symbol, value) {
      if (typeof prop === "symbol") { target[prop as never] = value; return true; }
      if (prop === "asset") { target.assetId = String(value); return true; }
      if (SUPPORTED.has(prop)) { target[prop] = value; return true; }
      miss(`Entity.${prop}(set)`);
      return true;
    },
  });
}

/** 播放一段音效，返回 id（失败返回 -1）。pitch 用 playbackRate 实现：音高和时长一起变。 */
function playSound(ctx: PlayerContext, name: string, volume: number, loop: boolean, pitch: number, music: boolean): number {
  const ac = ctx.audio.ctx;
  if (!ac) {
    partial("audio.play", "浏览器要求先有用户交互才能播放音频（自动播放策略）。");
    return -1;
  }
  const buf = ctx.audio.buffers.get(name);
  if (!buf) {
    partial(`audio.play(${name})`, "Web 产物里没有这个音频，或还没加载完。");
    return -1;
  }
  if (music && ctx.audio.musicId >= 0) stopSound(ctx, ctx.audio.musicId);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.loop = loop;
  const rate = Number.isFinite(pitch) && pitch > 0 ? Math.max(0.05, Math.min(16, pitch)) : 1;
  src.playbackRate.value = rate;
  const gain = ac.createGain();
  gain.gain.value = Math.max(0, volume) * ctx.audio.master;
  src.connect(gain).connect(ac.destination);
  const id = ctx.audio.nextId++;
  const live = { id, name, src, gain, music };
  ctx.audio.live.push(live);
  if (music) ctx.audio.musicId = id;
  src.onended = () => {
    const i = ctx.audio.live.indexOf(live);
    if (i >= 0) ctx.audio.live.splice(i, 1);
    if (ctx.audio.musicId === id) ctx.audio.musicId = -1;
  };
  try {
    src.start();
  } catch (e) {
    partial("audio.play", "AudioContext 还没被用户手势解锁：" + String(e));
    return -1;
  }
  return id;
}

/** 停一个音源。数字按 id，字符串按素材名停掉全部同名实例。 */
function stopSound(ctx: PlayerContext, idOrName: number | string | undefined): void {
  const match = typeof idOrName === "number"
    ? (s: { id: number }) => s.id === idOrName
    : (s: { name: string }) => idOrName !== undefined && s.name === String(idOrName);
  for (const s of ctx.audio.live.slice()) {
    if (!match(s)) continue;
    try { s.src.stop(); } catch { /* 已经停了 */ }
    const i = ctx.audio.live.indexOf(s);
    if (i >= 0) ctx.audio.live.splice(i, 1);
    if (ctx.audio.musicId === s.id) ctx.audio.musicId = -1;
  }
}

export function getApiReport(): ApiReport {
  return report;
}
