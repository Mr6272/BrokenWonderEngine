/**
 * BWE Web 播放器 · 运行时主循环
 *
 * 职责：加载 Build 产物 → 建 bwe 垫片 → 跑固定步长循环 → 调脚本生命周期。
 *
 * 两个从 Java 侧照抄过来、不能自己发挥的约定：
 *   1. 固定步长 1/60。Java 运行时用的是固定步长管线，物理和脚本都按
 *      dt=1/60 推进。Web 端如果直接用 rAF 的真实 delta，同一个工程在
 *      120Hz 屏上会跑得比 60Hz 快一倍——这不是优化问题，是行为不一致。
 *   2. onUpdate(dt) 是**参数传 dt**，不是从 bwe.time 读。
 *      （扫雷脚本里就是 onUpdate(dt) 这个签名。）
 */

import { Renderer, sortForDraw, type AssetDef, type BootManifest, type SceneObject } from "./renderer";
import { dispatchMineClick, findBoardObject, paintMineBoard } from "./minebind";
import {
  createBwe,
  createParamHost,
  getApiReport,
  objectScriptName,
  parseColor,
  type ParamHost,
  type PlayerContext,
  type InputState,
  type CameraState,
  type AudioState,
  type DrawCmd,
} from "./api";

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5; // 卡顿时最多补 5 步，防止死亡螺旋

interface CompiledScript {
  name: string;
  onSceneStart?: (ctx: unknown) => void;
  onUpdate?: (dt: number) => void;
  onSceneEnd?: () => void;
  onDraw?: (ctx: unknown) => void;
  [k: string]: unknown;
}

export class Player {
  private renderer: Renderer;
  private canvas: HTMLCanvasElement;
  private boot: BootManifest;
  private baseUrl: string;
  /** boot.json 里 scene/script 的 file 相对 Build/（Java 侧 new File(buildDir, path)），素材 path 相对产物根。 */
  private buildUrl: string;
  private ctx: PlayerContext;
  private scripts: CompiledScript[] = [];
  /** createBwe 产出的全局 bwe 对象。存成字段是因为扫雷这类"引擎托管模块"要在
   *  指针事件与渲染循环里访问它（脚本只是它的调用方之一）。 */
  private bwe: unknown = null;
  /**
   * 脚本公开字段的宿主（bwe.params / ctx.params）。
   *
   * 为什么播放器要持有它：脚本是共享句柄，参数必须按**调用期的对象**区分。
   * 派发对象脚本前后用它设/清 currentSelf，脚本里 bwe.params() 才拿得到"这一只"的覆盖值。
   */
  private paramHost: ParamHost | null = null;
  private accumulator = 0;
  private lastTs = 0;
  private running = false;
  private rafId = 0;
  private disposed = false;

  /** 面向性能面板的公开读数 */
  readonly stats = {
    fps: 0,
    frameMs: 0,
    updateMs: 0,
    drawMs: 0,
    objects: 0,
    drawCalls: 0,
    textureCount: 0,
    steps: 0,
  };

  private fpsAcc = 0;
  /** bwe.mine 的棋盘承载对象是否已定位（场景加载后惰性绑定） */
  private mineBound = false;
  /** 相机是否已按场景尺寸适配过一次 */
  private cameraFitted = false;
  private fpsFrames = 0;

  constructor(canvas: HTMLCanvasElement, boot: BootManifest, baseUrl: string) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    this.boot = boot;
    this.baseUrl = baseUrl;
    this.buildUrl = new URL("Build/", baseUrl).href;

    const input: InputState = {
      keys: new Set(),
      mouse: { x: 0, y: 0, down: false, button: 0 },
      pressedThisFrame: new Set(),
      releasedThisFrame: new Set(),
      clickedThisFrame: false,
      wheel: 0,
    };
    const camera: CameraState = { x: 0, y: 0, zoom: 1 };
    const audio: AudioState = {
      ctx: null,
      buffers: new Map(),
      live: [],
      nextId: 1,
      musicId: -1,
      master: boot.masterVolume ?? 1,
      music: 1,
      sfx: 1,
      muted: false,
    };

    this.ctx = {
      renderer: this.renderer,
      boot,
      baseUrl,
      scene: { objects: [], width: 0, height: 0 },
      canvas: this.canvas,
      input,
      camera,
      audio,
      time: { elapsed: 0, dt: FIXED_DT, frame: 0 },
      vars: { ...(boot.variables ?? {}) },
      drawQueue: [],
      spawned: [],
    };
  }

  /** 加载场景、素材、脚本。素材并行加载，单张失败不阻塞整体。 */
  async load(): Promise<void> {
    const sceneMeta = this.boot.scenes[0];
    if (!sceneMeta) throw new Error("boot.json 里没有场景");

    const sceneUrl = new URL(sceneMeta.file, this.buildUrl).href;
    const res = await fetch(sceneUrl);
    if (!res.ok) throw new Error("场景加载失败: " + sceneUrl);
    const sceneJson = (await res.json()) as {
      objects?: SceneObject[];
      width?: number;
      height?: number;
    };
    this.ctx.scene.objects = sceneJson.objects ?? [];
    this.ctx.scene.width = sceneJson.width ?? sceneMeta.width;
    this.ctx.scene.height = sceneJson.height ?? sceneMeta.height;

    // 素材：并行但有上限，避免一次性开 101 个请求把浏览器打爆。
    const assets = this.boot.assets ?? [];
    const CONCURRENCY = 8;
    let cursor = 0;
    const workers = new Array(Math.min(CONCURRENCY, assets.length)).fill(0).map(async () => {
      for (;;) {
        const i = cursor++;
        if (i >= assets.length) return;
        const def = assets[i];
        try {
          // 按素材类型分流：音频进 AudioContext 的 buffer 池，其余才当贴图。
          // 早先所有素材都走 loadTexture，WAV 被当成图片解码，必然失败并刷一屏警告。
          if (this.isAudioAsset(def)) await this.loadAudioAsset(def);
          else await this.renderer.loadTexture(this.baseUrl, def);
        } catch (e) {
          console.warn(`[BWE/Web] 素材加载失败 ${def.id}:`, e);
        }
      }
    });
    await Promise.all(workers);
    this.stats.textureCount = this.renderer.textureCount();

    // 相机初始对准场景中心
    this.ctx.camera.x = this.ctx.scene.width / 2;
    this.ctx.camera.y = this.ctx.scene.height / 2;

    // 脚本：Build 里是 ES5 源码文件，直接 eval 到全局。
    // Java 侧用 Rhino，这里用浏览器 JS 引擎；两边都是 ES5，源码可以直接跑。
    const bwe = createBwe(this.ctx);
    this.bwe = bwe;
    this.paramHost = createParamHost(this.ctx);
    (window as unknown as Record<string, unknown>).bwe = bwe;
    (window as unknown as Record<string, unknown>).__bwe_report = getApiReport;

    for (const s of this.boot.scripts ?? []) {
      if (s.lang && s.lang !== "js") continue;
      if (!s.file) continue;
      const url = new URL(s.file, this.buildUrl).href;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const code = await r.text();
        const compiled = this.compileScript(s.name, code);
        if (compiled) this.scripts.push(compiled);
      } catch (e) {
        console.error(`[BWE/Web] 脚本 ${s.name} 加载失败:`, e);
      }
    }
  }

  /** 素材是不是音频。boot.json 里 path 就是真实文件名，按扩展名判断最稳。 */
  private isAudioAsset(def: AssetDef): boolean {
    const p = String(def.path ?? "").toLowerCase();
    if (/\.(wav|mp3|ogg|m4a|aac|flac)$/.test(p)) return true;
    const t = String((def as unknown as { type?: string }).type ?? "").toLowerCase();
    return t === "audio" || t === "sound" || t === "music";
  }

  /** 音频素材：fetch + decodeAudioData，塞进 ctx.audio.buffers 供 bwe.audio 取用。 */
  private async loadAudioAsset(def: AssetDef): Promise<void> {
    const url = new URL(def.path, this.baseUrl).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`音频加载失败: HTTP ${res.status} ${url}`);
    const bytes = await res.arrayBuffer();
    // AudioContext 必须在用户交互后才能创建/恢复，但 decode 可以先做：
    // 没有 ctx 时就建一个 suspended 的，播放时再 resume。
    let ac = this.ctx.audio.ctx;
    if (!ac) {
      const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!Ctor) throw new Error("浏览器不支持 WebAudio");
      ac = new Ctor();
      this.ctx.audio.ctx = ac;
    }
    // decodeAudioData 在某些环境（headless / 无音频设备 / 移动端未解锁）会**永不 resolve**，
    // 而它在 load() 的 Promise.all 里，一旦挂住整个启动就卡死。加超时兜底：
    // 解不出来就退化成"已登记但不可播放"，让游戏先跑起来。
    const decode = ac.decodeAudioData(bytes.slice(0));
    const buf = await Promise.race([
      decode,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    if (buf) {
      this.ctx.audio.buffers.set(def.id, buf);
    } else {
      console.warn(`[BWE/Web] 音频解码超时，已跳过（不阻塞启动）: ${def.id}`);
    }
  }

  /**
   * 把 ES5 脚本源码求值成一个可调用的模块。
   * 用 new Function 而不是 eval：作用域更干净，且能拿到返回的句柄对象。
   * 脚本里的顶层 function 声明会成为返回对象的属性，生命周期就是按名字找。
   */
  private compileScript(name: string, code: string): CompiledScript | null {
    try {
      const factory = new Function(
        "bwe",
        `"use strict";
         var window = undefined, document = undefined;
         ${code}
         return {
           onSceneStart: typeof onSceneStart === "function" ? onSceneStart : undefined,
           onUpdate: typeof onUpdate === "function" ? onUpdate : undefined,
           onSceneEnd: typeof onSceneEnd === "function" ? onSceneEnd : undefined,
           onDraw: typeof onDraw === "function" ? onDraw : undefined
         };`
      );
      const handle = factory((window as unknown as Record<string, unknown>).bwe) as CompiledScript;
      handle.name = name;
      return handle;
    } catch (e) {
      console.error(`[BWE/Web] 脚本 ${name} 编译失败（语法错误？）:`, e);
      return null;
    }
  }

  /** 调用生命周期。单个脚本抛错不能拖垮其它脚本，也不能停掉整个游戏。 */
  private callScripts(hook: "onSceneStart" | "onUpdate" | "onSceneEnd" | "onDraw", arg?: unknown): void {
    for (const s of this.scripts) {
      const fn = s[hook] as ((a?: unknown) => void) | undefined;
      if (typeof fn !== "function") continue;
      try {
        fn.call(s, arg);
      } catch (e) {
        console.error(`[BWE/Web] 脚本 ${s.name} 的 ${hook} 抛错:`, e);
      }
    }
  }

  /**
   * 对象脚本派发（`script.js` 模块 → 对象的 onStart / onUpdate）。
   *
   * 三件与 Java 侧必须一致的事：
   *   1. ctx 里 `self` 是**这一个对象**，`params` 是它的有效参数（默认值 ∪ 覆盖值）；
   *   2. 派发前把 paramHost 的 currentSelf 指到它，脚本里 `bwe.params()` 才按对象作用域取值；
   *   3. 单个对象抛错不影响其它对象 —— 一只怪的脚本炸了不该停掉整局。
   */
  private dispatchObjectScripts(hook: "onStart" | "onUpdate", dt: number): void {
    const host = this.paramHost;
    for (const o of [...this.ctx.scene.objects, ...this.ctx.spawned]) {
      const name = objectScriptName(o);
      if (!name) continue;
      const s = this.scripts.find((x) => x.name === name);
      const fn = s?.[hook] as ((ctx: unknown, dt?: number) => void) | undefined;
      if (!s || typeof fn !== "function") continue;
      if (host) host.setCurrentSelf(o);
      try {
        const ctx = this.objectCtx(o);
        if (hook === "onUpdate") fn.call(s, ctx, dt);
        else fn.call(s, ctx);
      } catch (e) {
        console.error(`[BWE/Web] 对象「${o.name}」的脚本 ${name}.${hook} 抛错:`, e);
      } finally {
        if (host) host.setCurrentSelf(null);
      }
    }
  }

  /** 对象回调的 ctx：在场景 ctx 的基础上把 self / params 换成这个对象的。 */
  private objectCtx(o: SceneObject): Record<string, unknown> {
    const base = this.ctx as unknown as Record<string, unknown>;
    return {
      ...base,
      self: o,
      params: this.paramHost ? this.paramHost.current() : {},
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.bindInput();

    // 浏览器自动播放策略：音频上下文必须在用户手势之后创建。
    const onFirstGesture = () => {
      if (!this.ctx.audio.ctx) {
        try {
          const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (AC) this.ctx.audio.ctx = new AC();
        } catch {
          /* 没有音频也能玩 */
        }
      }
      window.removeEventListener("pointerdown", onFirstGesture);
      window.removeEventListener("keydown", onFirstGesture);
    };
    window.addEventListener("pointerdown", onFirstGesture, { once: false });
    window.addEventListener("keydown", onFirstGesture, { once: false });

    this.callScripts("onSceneStart", this.ctx);
    // 对象脚本的 onStart：场景脚本跑完之后，与 Java 侧 start() 的顺序一致
    // （bindSceneObjects → onStart，再 jsMain/场景脚本 —— 顺序不同会改变"谁的初始化先跑"）。
    this.dispatchObjectScripts("onStart", FIXED_DT);

    this.lastTs = performance.now();
    const loop = (ts: number) => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(loop);
      this.tick(ts);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.callScripts("onSceneEnd");
  }

  private tick(ts: number): void {
    const frameStart = performance.now();
    const raw = (ts - this.lastTs) / 1000;
    this.lastTs = ts;
    // 切后台回来时 raw 可能是几十秒，必须夹住，否则一次补上千步。
    const delta = Math.min(Math.max(raw, 0), 0.25);

    this.accumulator += delta;
    let steps = 0;
    const updStart = performance.now();
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.ctx.time.dt = FIXED_DT;
      this.ctx.time.elapsed += FIXED_DT;
      this.ctx.time.frame++;
      this.callScripts("onUpdate", FIXED_DT);
      this.dispatchObjectScripts("onUpdate", FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
      // 输入事件是"本帧"语义，跑完一步就清。
      this.ctx.input.pressedThisFrame.clear();
      this.ctx.input.releasedThisFrame.clear();
      this.ctx.input.clickedThisFrame = false;
      this.ctx.input.wheel = 0;
    }
    if (steps >= MAX_STEPS_PER_FRAME) this.accumulator = 0; // 丢帧，不追
    this.stats.steps = steps;
    this.stats.updateMs = performance.now() - updStart;

    const drawStart = performance.now();
    this.render();
    this.stats.drawMs = performance.now() - drawStart;

    this.stats.objects = this.ctx.scene.objects.length + this.ctx.spawned.length;
    this.stats.drawCalls = this.renderer.drawCalls;
    this.stats.frameMs = performance.now() - frameStart;

    this.fpsAcc += delta;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.stats.fps = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  }

  /** 取 bwe.mine 的底层棋盘；没启用扫雷模块时返回 null。 */
  private mineBoard(): unknown {
    const api = this.bwe as { mine?: { __board?: () => unknown } } | null;
    return api?.mine?.__board?.() ?? null;
  }

  /** bwe.mine 的棋盘对象来自场景；场景加载完才能定位，所以这里惰性绑定一次。 */
  private mineObject(): SceneObject | null {
    if (!this.mineBound) return null;
    return findBoardObject([...this.ctx.scene.objects, ...this.ctx.spawned]);
  }

  /** 棋盘被 bwe.mine.set() 真正用起来之后才接管绘制与点击，否则不动场景。 */
  private mineActive(): boolean {
    const board = this.mineBoard();
    return !!board;
  }

  private routeMineClick(hit: { x: number; y: number; button: number }): void {
    const board = this.mineBoard();
    if (!board) return;
    this.mineBound = true;
    dispatchMineClick(board as never, this.mineObject(), hit);
  }

  private paintMineIfActive(): void {
    const board = this.mineBoard();
    if (!board) return;
    this.mineBound = true;
    paintMineBoard(this.renderer, board as never, this.mineObject());
  }

  /**
   * 首帧把相机对到场景上。
   * 场景单位就是世界单位，和视口像素不是一回事：一个 64x64 的场景放到 878x546 的
   * 视口里，zoom=1 只会画出中间一小块，其余全黑。这里按「铺满且留一点边」求 zoom。
   * 脚本显式设过 camera.zoom 的话就不动它。
   */
  private fitCameraToScene(): void {
    if (this.cameraFitted) return;
    const sc = this.ctx.scene;
    const objs = [...sc.objects, ...this.ctx.spawned].filter(
      (o) => Math.abs(o.halfW ?? 0) > 0 && Math.abs(o.halfH ?? 0) > 0,
    );
    const W = this.renderer.gl.drawingBufferWidth;
    const H = this.renderer.gl.drawingBufferHeight;
    if (!W || !H || objs.length === 0) return;
    this.cameraFitted = true;
    const cam = this.ctx.camera;
    if (cam.zoom !== 1) return; // 脚本自己调过就不覆盖

    // 关键：内容的真实包围盒来自对象的 x/y + 半宽高，**不是** scene.width/height。
    // 这两个值在真实工程里经常对不上（扫雷工程声明 64x64，对象却铺在 2048x2048 的
    // 坐标空间里）。按 scene.width 求中心和 zoom，相机会落在内容的角落里，画面全黑。
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of objs) {
      const hw = Math.abs(o.halfW ?? 0);
      const hh = Math.abs(o.halfH ?? 0);
      const x0 = (o.x ?? 0) - hw;
      const x1 = (o.x ?? 0) + hw;
      const y0 = (o.y ?? 0) - hh;
      const y1 = (o.y ?? 0) + hh;
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
    }
    const cw = maxX - minX;
    const ch = maxY - minY;
    if (!(cw > 0 && ch > 0)) return;
    const z = Math.min(W / cw, H / ch) * 0.98;
    if (Number.isFinite(z) && z > 0) cam.zoom = z;
    cam.x = (minX + maxX) / 2;
    cam.y = (minY + maxY) / 2;
  }


  private render(): void {
    const canvas = this.renderer.gl.canvas as HTMLCanvasElement;
    this.renderer.resize(canvas.clientWidth, canvas.clientHeight);
    this.fitCameraToScene();
    const cam = this.ctx.camera;
    this.renderer.beginFrame(cam.x, cam.y, cam.zoom);

    this.callScripts("onDraw", this.ctx);

    // 棋盘必须在画对象之前刷纹理：paintMineBoard 会改 obj.assetId，
    // 放在循环后面等于永远晚一帧，首帧还会因为纹理不存在直接不画。
    this.paintMineIfActive();

    const objs = sortForDraw([...this.ctx.scene.objects, ...this.ctx.spawned]);
    for (const o of objs) {
      if (o.visible === false) continue;
      const frame = this.animFrame(o);
      this.renderer.drawObject(o, frame);
    }

    // 脚本主动绘制（bwe.draw.*）的队列，按 layer 排在场景之上。
    const q = [...this.ctx.drawQueue].sort((a, b) => a.layer - b.layer);
    this.ctx.drawQueue.length = 0;
    if (q.length > 0) this.flushDrawQueue(q);
  }

  /** 序列帧序号：按 animFps 与已过时间推进。 */
  private animFrame(o: SceneObject): number {
    if (!o.animMode || o.animMode === "默认" || !o.animFps) return 0;
    const total = this.boot.assets.find((a) => a.id === o.assetId)?.frames ?? 1;
    if (total <= 1) return 0;
    return Math.floor(this.ctx.time.elapsed * o.animFps) % total;
  }

  /**
   * 把 bwe.draw 队列转成实际绘制。
   *
   * 矩形/圆用 Canvas2D 覆盖层会比在 WebGL 里造一套 UI 着色器简单得多，
   * 但这里必须画在同一个 canvas 上，否则缩放和相机就对不齐了。
   * 方案：用一个 2D canvas 叠在 WebGL canvas 上，共享同一次相机变换。
   */
  private flushDrawQueue(q: DrawCmd[]): void {
    const overlay = this.overlay2d();
    if (!overlay) return;
    const g = overlay.getContext("2d");
    if (!g) return;
    const canvas = this.renderer.gl.canvas as HTMLCanvasElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, overlay.width, overlay.height);
    g.scale(dpr, dpr);

    const cam = this.ctx.camera;
    const cx = canvas.clientWidth / 2;
    const cy = canvas.clientHeight / 2;
    const toScreen = (x: number, y: number) => ({
      x: (x - cam.x) * cam.zoom + cx,
      y: (y - cam.y) * cam.zoom + cy,
    });

    for (const cmd of q) {
      g.fillStyle = cmd.color;
      g.strokeStyle = cmd.color;
      if (cmd.kind === "rect") {
        const p = toScreen(cmd.x, cmd.y);
        const w = cmd.w * cam.zoom;
        const h = cmd.h * cam.zoom;
        if (cmd.filled) g.fillRect(p.x, p.y, w, h);
        else g.strokeRect(p.x, p.y, w, h);
      } else if (cmd.kind === "circle") {
        const p = toScreen(cmd.x, cmd.y);
        g.beginPath();
        g.arc(p.x, p.y, cmd.r * cam.zoom, 0, Math.PI * 2);
        if (cmd.filled) g.fill();
        else g.stroke();
      } else if (cmd.kind === "text") {
        const p = toScreen(cmd.x, cmd.y);
        g.font = `${Math.round(cmd.size * cam.zoom)}px monospace`;
        g.textAlign = (cmd.align as CanvasTextAlign) ?? "left";
        g.textBaseline = "top";
        g.fillText(cmd.text, p.x, p.y);
      }
    }
  }

  private overlayEl: HTMLCanvasElement | null = null;
  private overlay2d(): HTMLCanvasElement | null {
    if (this.overlayEl) return this.overlayEl;
    const main = this.renderer.gl.canvas as HTMLCanvasElement;
    const parent = main.parentElement;
    if (!parent) return null;
    const c = document.createElement("canvas");
    c.style.position = "absolute";
    c.style.left = "0";
    c.style.top = "0";
    c.style.width = "100%";
    c.style.height = "100%";
    c.style.pointerEvents = "none";
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(c);
    this.overlayEl = c;
    return c;
  }

  private bindInput(): void {
    const canvas = this.renderer.gl.canvas as HTMLCanvasElement;

    const keyName = (e: KeyboardEvent): string => {
      // 与 ScriptEngine.keyName 同一套名字：KeyW / Digit1 / Space / ArrowLeft。
      // 查询端大小写不敏感（"W" 和 "KeyW" 都认），这里存规范名。
      if (e.code === "Space") return "Space";
      if (e.code.startsWith("Key") || e.code.startsWith("Digit") || e.code.startsWith("Arrow")) return e.code;
      const named: Record<string, string> = {
        Enter: "Enter", Escape: "Escape", Tab: "Tab", Backspace: "Backspace",
        ShiftLeft: "Shift", ShiftRight: "Shift",
        ControlLeft: "Control", ControlRight: "Control",
        AltLeft: "Alt", AltRight: "Alt",
        Minus: "Minus", Equal: "Equal", Comma: "Comma", Period: "Period",
        Slash: "Slash", Semicolon: "Semicolon", Quote: "Quote",
        BracketLeft: "BracketLeft", BracketRight: "BracketRight",
        Backslash: "Backslash", Backquote: "Backquote",
      };
      if (named[e.code]) return named[e.code];
      if (/^F([1-9]|1[0-2])$/.test(e.code)) return e.code;
      return e.key.length === 1 ? e.key.toUpperCase() : e.key;
    };

    window.addEventListener("keydown", (e) => {
      const k = keyName(e);
      if (!this.ctx.input.keys.has(k)) this.ctx.input.pressedThisFrame.add(k);
      this.ctx.input.keys.add(k);
      // 方向键/空格会滚动页面，游戏里必须拦掉
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(k)) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      const k = keyName(e);
      if (this.ctx.input.keys.has(k)) this.ctx.input.releasedThisFrame.add(k);
      this.ctx.input.keys.delete(k);
    });
    window.addEventListener("blur", () => {
      // 切走窗口时清空按键，否则回来会"卡住一直往右走"
      this.ctx.input.keys.clear();
    });

    const toWorld = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect();
      const cam = this.ctx.camera;
      return {
        x: (clientX - r.left - r.width / 2) / cam.zoom + cam.x,
        y: (clientY - r.top - r.height / 2) / cam.zoom + cam.y,
      };
    };

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      const w = toWorld(e.clientX, e.clientY);
      this.ctx.input.mouse.x = w.x;
      this.ctx.input.mouse.y = w.y;
      this.ctx.input.mouse.down = true;
      this.ctx.input.mouse.button = e.button;
      this.ctx.input.clickedThisFrame = true;
      // 顺序不能反：输入框在最上层，点它不该同时点到棋盘/场景。
      // bwe.textinput 消费了这次点击就直接 return。
      if (this.ctx.textInput && this.ctx.textInput.tryActivate(e.clientX, e.clientY)) return;
      // bwe.mine：棋盘优先消费左键/右键（Java 侧棋盘是引擎托管的，点击不经过脚本）
      this.routeMineClick({ x: w.x, y: w.y, button: e.button });
    });
    canvas.addEventListener("pointermove", (e) => {
      const w = toWorld(e.clientX, e.clientY);
      this.ctx.input.mouse.x = w.x;
      this.ctx.input.mouse.y = w.y;
    });
    const up = (e: PointerEvent) => {
      this.ctx.input.mouse.down = false;
      this.ctx.input.mouse.button = e.button;
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", (e) => {
      this.ctx.input.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}
