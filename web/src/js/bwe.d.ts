/**
 * BWE 运行时脚本契约（Phase 1）的 TypeScript 声明。
 *
 * 这份文件是 docs/scripting-api.md §2 的「可被机器检查的副本」：
 *   - 编辑器：加进 tsconfig 后，写 JS 脚本时 IDE 能补全 bwe.*；
 *   - /api/js-check：**由服务端把这份文件拼给用户脚本用**（作为独立虚拟文件 bwe.d.ts，
 *     或把下面的内容原样拼在用户脚本前面——本文件刻意只用 `declare namespace bwe {}`，
 *     不声明任何全局函数，因此拼接不会和用户自己写的 function onStart() 冲突）。
 *   - 生命周期（onStart / onUpdate …）的全局声明在 web/src/js/globals.d.ts，
 *     那个文件只在「独立文件」方式下加载，拼接方式下不要带上，否则会和用户脚本重名。
 *
 * 纪律：改契约先改 docs/scripting-api.md，再回来同步这里；两处的名字必须一字不差。
 * 本文件是 **纯声明**（no emit），既可以被 tsc 当普通文件编译，也可以被服务端当文本拼接。
 *
 * Phase 1 = 本轮交付；标了 Phase 2 的条目是契约占位，调用不保证有行为。
 */

declare namespace bwe {
  // ==========================================================================
  // 基础类型
  // ==========================================================================

  /** 二维坐标 / 向量（世界像素，Y 轴向下）。 */
  interface Vec2 {
    x: number;
    y: number;
  }

  /** 宽高。注意与 Vec2 区分，避免 x/y 混用。 */
  interface Size {
    w: number;
    h: number;
  }

  /** 矩形：左上角 + 宽高（像素）。 */
  interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  /** 格子坐标（瓦片地图用，整数）。 */
  interface CellPos {
    cx: number;
    cy: number;
  }

  /** 键名：`"Space"` / `" "` / `"KeyW"` / `"ArrowLeft"` / `"Mouse0"` / 32 都认。 */
  type KeyName = string | number;

  /** 颜色：`"#rrggbb"` / `"#rrggbbaa"` / CSS 颜色名。 */
  type Color = string;

  /** 子精灵句柄（e.attach 返回，e.detach 传回）。 */
  type AttachHandle = number;

  // ==========================================================================
  // 实体 Entity（世界对象）
  // ==========================================================================

  /** 标签集合：既能当数组用，也能 `.has(t)`。 */
  interface Tags extends Array<string> {
    has(tag: string): boolean;
  }

  interface SpriteOpts {
    /** 素材名 */
    asset: string;
    /** 起始帧 */
    frame?: number;
    /** 每秒帧数 */
    fps?: number;
    /** 播放模式，默认 loop */
    mode?: "loop" | "once" | "first";
  }

  interface AttachOpts {
    /** 素材名 */
    asset: string;
    /** 相对实体的像素偏移 */
    dx?: number;
    dy?: number;
    /** 排序层级（与 z 同一套） */
    z?: number;
    /** 角度，顺时针，单位度 */
    rotation?: number;
  }

  /** 模块实例（脚本看到的模块，与编辑器里点是同一份数据）。 */
  interface ModuleInstance {
    /** 模块 id，例如 "move.patrol" */
    id: string;
    /** 模块定义 id（与 id 相同，保留字段） */
    def?: string;
    enabled: boolean;
    /** 读参数；缺省时返回 def */
    get(key: string, def?: unknown): unknown;
    /** 写参数；与编辑器同一条数据，下一帧生效 */
    set(key: string, val: unknown): void;
  }

  /** 实体事件名。 */
  type EntityEvent = "click" | "enter" | "leave" | "damage" | "death";

  /**
   * 实体：场景里的一个对象。
   * 所有位置坐标都是「世界像素、对象中心点、Y 轴向下」。
   */
  interface Entity {
    /** 唯一 id（只读） */
    readonly id: string;
    name: string;
    /** 对象大类：ACTOR / PROP / TILE / ZONE / SPAWN / PORTAL / LIGHT */
    kind: string;
    x: number;
    y: number;
    /** 排序层级，大的盖住小的 */
    z: number;
    /** 角度，顺时针，单位度 */
    rotation: number;
    scaleX: number;
    scaleY: number;
    visible: boolean;
    /** 是否还活着（被销毁后为 false，只读） */
    readonly alive: boolean;
    tags: Tags;

    /** 位置（世界像素，中心点）：等价于 {x, y} */
    readonly pos: Vec2;
    setPos(x: number, y: number): void;
    /** 可视化尺寸（与编辑器 halfW/halfH 同一套规则） */
    readonly size: Size;
    setSize(w: number, h: number): void;

    /** 换精灵（可带播放参数） */
    sprite(opts: SpriteOpts): void;
    /** 直接换素材（沿用当前播放参数） */
    play(assetName: string): void;
    /** 冻结到第 i 帧（0 起） */
    setFrame(i: number): void;

    /** 读对象属性（与编辑器的 props 打通）；没有则返回 def */
    prop(key: string, def?: unknown): unknown;
    /** 写对象属性（会影响下一帧的绘制尺寸，规则同 sizeOf） */
    setProp(key: string, val: unknown): void;

    hasModule(id: string): boolean;
    /** 取模块实例；没挂返回 null */
    module(id: string): ModuleInstance | null;
    modules(): ModuleInstance[];

    /** 挂一个子精灵（武器 / 影子 / 特效），返回句柄 */
    attach(opts: AttachOpts): AttachHandle;
    detach(handle: AttachHandle): void;

    /** 到另一个实体的距离（像素） */
    distanceTo(other: Entity): number;
    /** 到另一个实体的角度（度，0 = 向右，顺时针） */
    angleTo(other: Entity): number;

    /** 销毁自己（同 bwe.world.destroy(e)） */
    destroy(): void;

    /** 读取 combat.health 模块的值（没有则用内部值） */
    hp: number;
    hpMax: number;
    /** 扣血（走受击流程：闪白 / 无敌帧 / onDamage） */
    damage(n: number): void;
    /** 回血 */
    heal(n: number): void;

    /** 注册实体事件；同名事件重复注册会覆盖。载荷形状由派发方决定，所以是 any。 */
    on(event: EntityEvent, fn: (payload?: any) => void): void;
  }

  // ==========================================================================
  // 世界 bwe.world
  // ==========================================================================

  /** 查找条件：字符串 = 名字或标签；对象 = 按字段匹配。 */
  type EntityQuery = string | { name?: string; tag?: string; kind?: string; id?: string };

  /** 生成实体时的模块初始值。 */
  interface SpawnModuleInit {
    /** 模块定义 id，例如 "move.patrol" */
    def: string;
    /** 初始参数，key 与模块定义一致 */
    params?: Record<string, unknown>;
    /** 触发时机，缺省用模块默认值 */
    when?: string;
  }

  /** bwe.world.spawn 的参数。 */
  interface SpawnOpts {
    /** 世界像素坐标（中心点） */
    x: number;
    y: number;
    /** 素材名 */
    asset?: string;
    name?: string;
    /** 对象大类，默认 ACTOR */
    kind?: string;
    tags?: string[];
    /** 排序层级 */
    z?: number;
    /** 碰撞体半宽半高（0 = 不参与碰撞） */
    halfW?: number;
    halfH?: number;
    /** 挂上的 JS 脚本名 */
    script?: string;
    /** 额外模块 */
    modules?: SpawnModuleInit[];
  }

  /** 场景信息（只读快照）。 */
  interface SceneInfo {
    name: string;
    width: number;
    height: number;
  }

  interface World {
    /** 地图尺寸（像素） */
    mapSize(): Size;
    /** 每格像素 */
    tileSize(): number;
    /** 当前场景信息 */
    readonly scene: SceneInfo;

    /** 找一个实体，找不到返回 null */
    find(q: EntityQuery): Entity | null;
    /** 找所有匹配的实体（可能为空数组） */
    findAll(q: EntityQuery): Entity[];
    /** 运行时生成一个实体 */
    spawn(opts: SpawnOpts): Entity;
    /** 销毁实体 */
    destroy(e: Entity): void;
    /** 当前所有实体（只读数组，不要原地改） */
    entities(): Entity[];

    /** 暂停整个运行时（true = 停） */
    paused: boolean;
    /** 时间缩放（1 = 正常） */
    timeScale: number;

    /** 全局事件总线：注册。载荷是你 emit 时自己定的对象，所以是 any（不要依赖引擎猜测形状）。 */
    on(name: string, fn: (payload?: any) => void): void;
    /** 全局事件总线：取消 */
    off(name: string, fn?: (payload?: any) => void): void;
    /** 全局事件总线：派发 */
    emit(name: string, payload?: any): void;

    /** 图层信息（Phase 2，Phase 1 返回空数组） */
    layers(): { id: string; name: string; visible: boolean; locked: boolean; order: number }[];
  }

  // ==========================================================================
  // 输入 bwe.input
  // ==========================================================================

  interface MouseState {
    /** 逻辑屏幕坐标（左上原点） */
    x: number;
    y: number;
    /** 已过视口反变换的世界坐标 */
    worldX: number;
    worldY: number;
    left: boolean;
    middle: boolean;
    right: boolean;
    /** 本帧滚轮增量，向上为正 */
    wheel: number;
  }

  interface Input {
    /** 当前按住 */
    down(key: KeyName): boolean;
    /** 本帧刚按下（边沿） */
    pressed(key: KeyName): boolean;
    /** 本帧刚抬起（边沿） */
    released(key: KeyName): boolean;
    /** 方向轴：WASD + 方向键，已归一化，长度 0~1 */
    axis(): Vec2;
    /** 鼠标状态（只读快照） */
    readonly mouse: MouseState;
    /** 显示 / 隐藏鼠标光标 */
    cursor(visible: boolean): void;
  }

  // ==========================================================================
  // 相机 bwe.camera
  // ==========================================================================

  interface CameraFollowOpts {
    /** 平滑系数 0~1，越小越跟手 */
    smooth?: number;
    /** 朝移动方向多带一点像素，让玩家早看到前方 */
    lookAhead?: number;
  }

  interface Camera {
    /** 跟随实体；传 null 取消跟随 */
    follow(e: Entity | null, opts?: CameraFollowOpts): void;
    /** 相机中心（世界坐标） */
    readonly pos: Vec2;
    setPos(x: number, y: number): void;
    /** 缩放，1 = 1:1 像素 */
    readonly zoom: number;
    setZoom(z: number): void;
    /** 屏幕抖动 */
    shake(strength?: number, duration?: number): void;
    /** 限制相机范围；传 null 取消限制 */
    bounds(rect: Rect | null): void;
    worldToScreen(x: number, y: number): Vec2;
    screenToWorld(x: number, y: number): Vec2;
    /** 覆盖默认的画面适配方式（默认 contain） */
    setFit(mode: "contain" | "cover"): void;
  }

  // ==========================================================================
  // 时间 bwe.time + 定时器
  // ==========================================================================

  interface Time {
    /** 已运行秒数 */
    readonly now: number;
    /** 本帧步长（秒） */
    readonly dt: number;
    /** 已运行帧数 */
    readonly frame: number;
  }

  /** Phase 2：补间动画 */
  interface TweenHandle {
    done(fn: () => void): TweenHandle;
    cancel(): void;
  }

  // ==========================================================================
  // 绘制 bwe.draw（立即模式：HUD / 调试 / 世界内特效）
  // ==========================================================================

  interface TextOpts {
    /** 字号，默认 16 */
    size?: number;
    /** 颜色，默认 "#fff" */
    color?: Color;
    /** 对齐方式，默认 left */
    align?: "left" | "center" | "right";
    /** 透明度 0~1，默认 1 */
    alpha?: number;
    /** 文字阴影，默认 true */
    shadow?: boolean;
  }

  interface RectDrawOpts {
    /** 填充色；不填则不填充 */
    fill?: Color;
    /** 描边色；不填则不描边 */
    stroke?: Color;
    /** 描边宽度 */
    width?: number;
    alpha?: number;
    /** 圆角半径 */
    radius?: number;
  }

  interface LineDrawOpts {
    color?: Color;
    width?: number;
    alpha?: number;
  }

  interface CircleDrawOpts {
    fill?: Color;
    stroke?: Color;
    width?: number;
    alpha?: number;
  }

  interface SpriteDrawOpts {
    w?: number;
    h?: number;
    alpha?: number;
    /** 染色（与素材相乘） */
    tint?: Color;
    /** 旋转角度，顺时针，单位度 */
    rotation?: number;
    /** 帧下标（0 起） */
    frame?: number;
  }

  interface BarDrawOpts {
    /** 底槽颜色 */
    bg?: Color;
    /** 前景填充色 */
    fg?: Color;
    /** 边框颜色 */
    border?: Color;
  }

  interface Draw {
    text(x: number, y: number, text: string, opts?: TextOpts): void;
    rect(x: number, y: number, w: number, h: number, opts?: RectDrawOpts): void;
    line(x1: number, y1: number, x2: number, y2: number, opts?: LineDrawOpts): void;
    circle(x: number, y: number, r: number, opts?: CircleDrawOpts): void;
    sprite(assetName: string, x: number, y: number, opts?: SpriteDrawOpts): void;
    /** 进度条（血条 / 蓝条 / 经验） */
    bar(x: number, y: number, w: number, h: number, pct: number, opts?: BarDrawOpts): void;
    /** 量文字尺寸（用于居中 / 排版） */
    measureText(text: string, size?: number): Size;
    /** 该回调内的绘制改用世界坐标（画在世界里而不是屏幕上） */
    world(fn: () => void): void;
  }

  // ==========================================================================
  // 音频 bwe.audio
  // ==========================================================================

  interface PlayAudioOpts {
    volume?: number;
    loop?: boolean;
    /** 音高倍数，1 = 原调 */
    pitch?: number;
  }

  interface MusicOpts {
    volume?: number;
    /** 默认 true */
    loop?: boolean;
  }

  interface Audio {
    /** 播放音效，返回 id（可用于 stop） */
    play(name: string, opts?: PlayAudioOpts): number;
    /** 停止：传 id 或素材名 */
    stop(idOrName: number | string): void;
    /** 播放背景音乐（同一时刻只有一首） */
    music(name: string, opts?: MusicOpts): void;
    /** 全局音量 0~1 */
    volume(v: number): void;
  }

  // ==========================================================================
  // 存档 bwe.save（本地 JSON）
  // ==========================================================================

  interface Save {
    set(k: string, v: unknown): void;
    /** 读；不存在时返回 def */
    get<T = unknown>(k: string, def?: T): T;
    has(k: string): boolean;
    remove(k: string): void;
    clear(): void;
    /** 立即落盘（不调用也会在合适时机自动落盘） */
    flush(): void;
    /** 写到槽位文件，默认 "auto" */
    write(slot?: string): boolean;
    /** 从槽位读回，默认 "auto" */
    read(slot?: string): boolean;
    exists(slot?: string): boolean;
    delete(slot?: string): void;
  }

  // ==========================================================================
  // 俯视角专长：grid / tilemap / nav / interact / spawner
  // ==========================================================================

  interface Grid {
    /** = tileSize */
    readonly cellSize: number;
    /** 世界像素 → 格子（floor） */
    toCell(x: number, y: number): CellPos;
    /** 格子 → 格子中心的世界像素 */
    toWorld(cx: number, cy: number): Vec2;
    /** 对齐到格子中心 */
    snap(x: number, y: number): Vec2;
  }

  interface RayHit {
    hit: boolean;
    x: number;
    y: number;
    cx: number;
    cy: number;
  }

  interface Tilemap {
    /** 0 = 空 */
    get(cx: number, cy: number): number;
    set(cx: number, cy: number, tileId: number): void;
    /** 该格是否阻挡 */
    solid(cx: number, cy: number): boolean;
    setSolid(tileId: number, solid: boolean): void;
    /** 矩形是否撞墙（AABB，像素） */
    blocked(x: number, y: number, w: number, h: number): boolean;
    raycast(x1: number, y1: number, x2: number, y2: number): RayHit;
  }

  interface NavOpts {
    /** 允许斜向，默认 true */
    diagonal?: boolean;
    /** 最多展开节点数，默认 2000 */
    maxNodes?: number;
    /** 路径平滑，默认 true */
    smooth?: boolean;
  }

  interface NavFollowOpts {
    /** 移动速度 px/s，默认 100 */
    speed?: number;
    /** 到达判定距离 px，默认 2 */
    arrive?: number;
    /** 走完调用 */
    onArrive?: () => void;
  }

  /** 路径点：世界像素 */
  interface Nav {
    find(from: Vec2 | Entity, to: Vec2 | Entity, opts?: NavOpts): Vec2[];
    lineOfSight(a: Vec2 | Entity, b: Vec2 | Entity): boolean;
    follow(e: Entity, path: Vec2[], opts?: NavFollowOpts): void;
    stop(e: Entity): void;
  }

  interface NearestOpts {
    /** 搜索半径，默认 48 */
    radius?: number;
    /** 只看带这个标签的对象 */
    tag?: string;
    /** 自定义过滤 */
    filter?: (e: Entity) => boolean;
  }

  interface Interact {
    nearest(actor: Entity, opts?: NearestOpts): Entity | null;
    /** 在最近交互物头顶画提示；null 清除 */
    prompt(text: string | null): void;
    /** 设置触发键，默认 "KeyE" */
    setKey(key: KeyName): void;
    /** 玩家按触发键时回调 */
    onTrigger(fn: (target: Entity, actor: Entity) => void): void;
  }

  type SpawnerHandle = number;

  interface SpawnerOpts {
    /** 素材名（与 script 二选一） */
    asset?: string;
    /** 直接生成挂了该脚本的实体 */
    script?: string;
    /** 每次生成几个，默认 1 */
    count?: number;
    /** 生成间隔秒数，默认 2 */
    interval?: number;
    /** 场上上限，默认 10 */
    max?: number;
    /** 生成区域（像素） */
    area?: Rect;
    /** 每次生成后回调 */
    onSpawn?: (e: Entity) => void;
  }

  interface Spawner {
    create(opts: SpawnerOpts): SpawnerHandle;
    stop(sp: SpawnerHandle): void;
  }

  // ==========================================================================
  // 生命周期上下文
  // ==========================================================================

  /**
   * 脚本里生命周期的第一个参数。
   * 对象脚本：self 是挂脚本的对象；场景脚本：self 是场景根（可能为空实体）。
   */
  interface Ctx {
    /** 挂脚本的实体（场景脚本里是场景根） */
    self: Entity;
    world: World;
    scene: SceneInfo;
    time: Time;
    camera: Camera;
    input: Input;
    save: Save;
    /** 本帧步长（秒），onUpdate(ctx, dt) 的第二个参数也是它 */
    dt: number;
  }

  /** 生命周期函数签名集合（供 IDE 提示 / 文档引用）。 */
  interface Lifecycle {
    onStart?(ctx: Ctx): void;
    onUpdate?(ctx: Ctx, dt: number): void;
    onClick?(ctx: Ctx): void;
    onEnter?(ctx: Ctx, other: Entity): void;
    onLeave?(ctx: Ctx, other: Entity): void;
    onInteract?(ctx: Ctx, actor: Entity): void;
    onDamage?(ctx: Ctx, amount: number, from: Entity): void;
    onDeath?(ctx: Ctx, by: Entity): void;
    onDestroy?(ctx: Ctx): void;
    onKey?(ctx: Ctx, key: string | number): void;
    onSceneStart?(ctx: Ctx): void;
    onSceneEnd?(ctx: Ctx): void;
  }

  // ==========================================================================
  // 全局钩子 + 定时器 + 辅助函数
  // ==========================================================================

  interface EveryOpts {
    /** 最多执行几次；缺省不限 */
    times?: number;
  }

  interface Scripts {
    /** 跨脚本调用：bwe.call 的等价写法 */
    call(scriptName: string, handlerName: string, ...args: unknown[]): unknown;
    has(scriptName: string): boolean;
  }

  // ---- 命名空间里的值（相对 bwe 直接用） ----

  /** 世界：查找 / 生成 / 销毁 / 全局事件 */
  const world: World;
  /** 输入：按键、鼠标、方向轴 */
  const input: Input;
  /** 相机：跟随、缩放、抖动、坐标换算 */
  const camera: Camera;
  /** 时间：now / dt / frame */
  const time: Time;
  /** 绘制：立即模式 HUD 与特效 */
  const draw: Draw;
  /** 音频：音效与音乐 */
  const audio: Audio;
  /** 存档：本地 JSON */
  const save: Save;
  /** 网格：像素 ⇄ 格子 */
  const grid: Grid;
  /** 瓦片地图 */
  const tilemap: Tilemap;
  /** 寻路 */
  const nav: Nav;
  /** 交互 */
  const interact: Interact;
  /** 生成器 */
  const spawner: Spawner;

  /** 跨脚本调用入口（与 bwe.call 等价） */
  const scripts: Scripts;

  /** 注册全局钩子：`"update" | "draw" | "keydown" | "click"`，也可以是自定义事件名（载荷 any） */
  function on(name: string, fn: (payload?: any) => void): void;
  /** 取消全局钩子 */
  function off(name: string, fn?: (payload?: any) => void): void;

  /** 延时执行一次，返回可取消的 id */
  function after(sec: number, fn: () => void): number;
  /** 每 sec 秒执行一次，返回可取消的 id */
  function every(sec: number, fn: () => void, opts?: EveryOpts): number;
  /** 取消 after / every 返回的 id */
  function cancel(id: number): void;

  /** Phase 2：补间动画 */
  function tween(
    target: unknown,
    props: Record<string, number>,
    dur: number,
    opts?: Record<string, unknown>
  ): TweenHandle;

  /** 随机小数 [min, max) */
  function random(min?: number, max?: number): number;
  /** 随机整数 [min, max] */
  function randomInt(min: number, max: number): number;
  /** 概率命中 */
  function chance(p: number): boolean;
  /** 从数组里随机取一个 */
  function pick<T>(arr: T[]): T;
  /** 夹取 */
  function clamp(v: number, a: number, b: number): number;
  /** 线性插值 */
  function lerp(a: number, b: number, t: number): number;
  /** 两点距离 */
  function dist(x1: number, y1: number, x2: number, y2: number): number;

  /** 写一条日志到 Build/bwe.log（带脚本名） */
  function log(...args: unknown[]): void;
  /** 写一条错误日志 */
  function error(...args: unknown[]): void;

  /** 调用另一个脚本里的具名函数 */
  function call(scriptName: string, handlerName: string, ...args: unknown[]): unknown;
  /** 该脚本是否存在 */
  function has(scriptName: string): boolean;

  // ==========================================================================
  // Phase 2 · 涌现式模拟基底（docs/scripting-api.md §2.11）
  // 设计原则：引擎只提供「材质 → 场 → 感知 → 物理」的可组合基底，
  // 玩法由脚本组合，不写死关卡。
  // ==========================================================================

  // ---- §2.11.1 材质 -------------------------------------------------------

  /** 材质属性：一切熔/燃/湿/导电都由这些数字推导，不写死具体地块。 */
  interface MaterialProps {
    /** 易燃度 0..1（0 = 不可燃）。 */
    flammable?: number;
    /** 烧尽需要多少秒。 */
    burnTime?: number;
    /** 是否导电（电通道用）。 */
    conductive?: boolean;
    /** 初始是否湿（湿了易燃度减半）。 */
    wet?: boolean;
    /** 破坏所需伤害。 */
    hardness?: number;
    /** 物理密度倍数。 */
    density?: number;
    /** 语义标签，脚本可查询（如 ["plant"]）。 */
    tags?: string[];
  }

  /** 材质对象（= MaterialProps + name）。 */
  interface Material extends MaterialProps {
    name: string;
  }

  const material: {
    /** 定义/覆盖材质。 */
    define(name: string, props: MaterialProps): Material;
    /** 读材质（副本），不存在返回 null。 */
    get(name: string): Material | null;
    /** 材质的语义标签。 */
    tags(name: string): string[];
    /** 该格子的材质名（null = 空）。 */
    of(cx: number, cy: number): string | null;
    /** 改格子材质（null = 清空）。注意：水系材质会立刻变成永久水源。 */
    setTile(cx: number, cy: number, name: string | null): void;
    /** 实体材质名。 */
    ofEntity(e: Entity): string | null;
    /** 改实体材质。 */
    setEntity(e: Entity, name: string | null): void;
  };

  // ---- §2.11.2 格子场（火 / 水 / 烟 / 自定义） ----------------------------

  interface FieldEvent {
    cx: number;
    cy: number;
    material?: string | null;
    entity?: Entity | null;
  }

  interface BurningCell {
    cx: number;
    cy: number;
    intensity: number;
    material: string | null;
  }

  const field: {
    /** 点火 / 灌水（强度 0..1）。 */
    emit(channel: string, cx: number, cy: number, intensity?: number): void;
    /** 读通道强度 0..1。 */
    sample(channel: string, cx: number, cy: number): number;
    /** 清空通道。 */
    clear(channel: string): void;
    /** 设置/读取模拟步长（秒，默认 0.1，与帧率解耦）。 */
    tickRate(sec?: number): number;
    /** 取/建一个自定义通道（max 控制上限）。 */
    channel(name: string): { max(v: number): void };
    /** 风向（影响烟雾与火势偏向）。 */
    wind(dx: number, dy: number): Vec2;
    /** 注册事件；返回取消订阅函数。 */
    on(ev: "ignite" | "extinguish" | "burned", fn: (info: FieldEvent) => void): () => void;
    /** 当前正在燃烧的格子（调试/UI 用）。 */
    burning(): BurningCell[];
  };

  // ---- §2.11.3 声音 -------------------------------------------------------

  interface NoiseEvent extends Vec2 {
    radius: number;
    intensity: number;
    tag: string;
    /** 距今多少秒。 */
    age: number;
  }

  const noise: {
    /** 制造噪音（会按距离/隔墙衰减后派发给挂了 ai.attach 的实体）。 */
    emit(x: number, y: number, opts?: { radius?: number; intensity?: number; tag?: string }): void;
    /** 最近的噪音事件（保留约 2 秒）。 */
    events(): NoiseEvent[];
  };

  // ---- §2.11.4 感知 / 阵营 / 状态机 --------------------------------------

  interface LastKnown extends Vec2 {
    age: number;
    from: "sight" | "noise" | "alert";
  }

  const sense: {
    /** 是否看得见（半径 + FOV + 瓦片遮挡 + 烟雾）。 */
    canSee(a: Entity, b: Entity): boolean;
    /** 只判距离。 */
    inSightRange(a: Entity, b: Entity): boolean;
    /** 能否听到最近噪音。 */
    audible(e: Entity): boolean;
    /** 记忆中的目标位置（超时返回 null）。 */
    lastKnown(e: Entity): LastKnown | null;
  };

  const faction: {
    /** 设置阵营（null 清除）。 */
    set(e: Entity, name: string | null): void;
    /** 设置/读取关系：-1 敌 / 0 中立 / 1 友。 */
    relation(a: Entity | string, b: Entity | string, v?: number): number;
    /** 是否敌对。 */
    hostile(a: Entity | string, b: Entity | string): boolean;
    /** 该阵营的所有成员。 */
    members(name: string): Entity[];
  };

  interface AiOpts {
    sight?: number;
    fov?: number;
    hearing?: number;
    memory?: number;
    speed?: number;
  }

  const ai: {
    /** 给实体挂感知/记忆/状态（引擎只存状态，**决策写在脚本里**）。 */
    attach(e: Entity, opts?: AiOpts): void;
    detach(e: Entity): void;
    /** 当前状态字符串（引擎不定义含义；未 attach 返回 null）。 */
    state(e: Entity): string | null;
    setState(e: Entity, s: string): void;
    /** 引擎自动锁定的最近可见敌对目标（死亡/超记忆自动清）。 */
    target(e: Entity): Entity | null;
    /** 同阵营警报（一跳延迟传播）。 */
    alert(e: Entity, pos: Vec2 | Entity): void;
    onAlert(fn: (info: { entity: Entity; position: Vec2; from: Entity }) => void): () => void;
    onSpot(fn: (info: { entity: Entity; target: Entity }) => void): () => void;
  };

  // ---- §2.11.6 拾取器（鼠标 = 逻辑屏幕坐标 → 世界） ----------------------

  interface TargetCell extends CellPos {
    x: number;
    y: number;
    material: string | null;
  }

  const target: {
    /** 鼠标所在格子。 */
    cell(): TargetCell | null;
    /** 鼠标下最上层可见实体。 */
    entity(): Entity | null;
    /** 实体面前 range（默认 1 格）内的实体或格子。 */
    inFront(e: Entity, range?: number): Entity | TargetCell | null;
  };

  // ---- §2.11.5 物理（jbox2d） --------------------------------------------

  interface BodyOpts {
    type?: "dynamic" | "kinematic" | "static";
    shape?: "box" | "circle";
    radius?: number;
    halfW?: number;
    halfH?: number;
    density?: number;
    friction?: number;
    restitution?: number;
    sensor?: boolean;
    damping?: number;
    fixedRotation?: boolean;
    bullet?: boolean;
  }

  interface RayHit {
    hit: boolean;
    x: number;
    y: number;
    entity: Entity | null;
    nx: number;
    ny: number;
    fraction: number;
    sensor: boolean;
  }

  interface CollisionInfo {
    a: Entity;
    b: Entity;
    impulse: number;
    sensor: boolean;
  }

  const physics: {
    /** 打开物理子步（默认关；不开时 body() 返回 null）。 */
    enable(): void;
    enabled(): boolean;
    /** 重力 px/s²（俯视角默认 0）。 */
    gravity(gy?: number): number;
    /** 碰撞体线框开关。 */
    debug(on?: boolean): boolean;
    /** 给实体建刚体；tilemap 阻挡格自动成为静态墙。 */
    body(e: Entity, opts: BodyOpts): unknown;
    remove(e: Entity): void;
    /** 施加冲量（px·kg/s；400 ≈ 400px/s 的箱子）。 */
    applyImpulse(e: Entity, ix: number, iy: number): boolean;
    velocity(e: Entity): { vx: number; vy: number };
    setVelocity(e: Entity, vx: number, vy: number): void;
    /** 朝目标抛出（无重力=直线；默认按距离自适应力度）。 */
    throwAt(e: Entity, tx: number, ty: number, speed?: number): void;
    raycast(x1: number, y1: number, x2: number, y2: number): RayHit;
    queryPoint(x: number, y: number): Entity[];
    /** x,y 为左上角，w,h 为尺寸（像素）。 */
    queryAABB(x: number, y: number, w: number, h: number): Entity[];
    on(ev: "collision", fn: (info: CollisionInfo) => void): () => void;
    bodyCount(): number;
    tileBodyCount(): number;
  };

  // ---- 确定性随机（涌现对拍用） ------------------------------------------

  const seed: {
    /** 设种子（同种子 + 同输入 ⇒ 同结果）。 */
    set(n: number): void;
    get(): number;
    /** 恢复默认种子。 */
    reset(): void;
    defaultSeed(): number;
  };
}
