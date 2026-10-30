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

  /**
   * 子精灵句柄：`e.attach()` 返回的**对象**（不是数字）。
   *
   * ```js
   * var h = e.attach({ asset: "sword.png", dx: 16 });
   * h.id;        // number
   * h.remove();  // 立刻摘掉（等价 e.detach(h)）
   * ```
   */
  interface AttachHandle {
    /** 句柄 id（可用于 `e.detach(id)`） */
    readonly id: number;
    /** 立刻摘掉这个子精灵 */
    remove(): void;
  }

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
    /** 不透明度 0~1，缺省 1 */
    alpha?: number;
    /** 宽度（0 或省略 = 用素材原始宽度） */
    w?: number;
    /** 高度（0 或省略 = 用素材原始高度） */
    h?: number;
  }

  /**
   * 预制体定义（`bwe.prefab.define` 的 spec，也等于 boot.json 里 `prefabs[]` 的一条）。
   *
   * 全部字段可缺省，缺省值：kind="PROP" / z=0 / layer=0 / halfW=halfH=0 / scaleX=scaleY=1 /
   * rotation=0 / visible=true / animMode="默认" / animFps=8 / x=y=0。
   */
  interface PrefabSpec {
    /** 预制体名（`define` 的第一个参数；boot.json 里是 `name`） */
    name?: string;
    /** 对象大类，默认 PROP */
    kind?: string;
    /** 素材名（与 boot.assets[].name、场景 objects[].asset 同一套） */
    asset?: string;
    /** 排序层级，缺省 0 */
    z?: number;
    /** 图层下标（绘制顺序 layer → z → y），缺省 0 */
    layer?: number;
    /** 碰撞体半宽半高；0 = 不参与碰撞（绘制尺寸走 sizeOf 兜底） */
    halfW?: number;
    halfH?: number;
    /** 便捷写法：等价于 halfW = w/2, halfH = h/2（只读回时总以 halfW/halfH 为准） */
    size?: Size;
    scaleX?: number;
    scaleY?: number;
    /** 角度，顺时针，单位度 */
    rotation?: number;
    visible?: boolean;
    /** 动画模式："默认" | "只显示首帧" | "单次播放"（也认 "loop"/"first"/"once"） */
    animMode?: string;
    animFps?: number;
    /** 挂上的 JS 脚本名（boot.scripts[].name，不是文件路径） */
    script?: string;
    /** 初始标签 */
    tags?: string[];
    /** 初始模块 */
    modules?: SpawnModuleInit[];
    /** 初始对象属性（数值/布尔会归一成编辑器同构文本） */
    props?: Record<string, unknown>;
    /**
     * 随机抖动幅度（各加 `[-x,+x]` / `[-y,+y]`），**只在 spawn 没给 x/y 时生效**。
     *
     * 给了 `x`/`y` 就精确落位（不抖）——这是 v1.1 修正后的语义：
     * 显式指定位置却不精确，会让确定性对拍失效。要抖就传 `{ jitter: true }`。
     */
    jitter?: Vec2;
    /** 生成时附带的基础位置（`spawn` 未给 x/y 时用） */
    x?: number;
    y?: number;
    /** 子精灵列表（用引擎既有的 e.attach 实现，不是嵌套实体） */
    children?: PrefabChildSpec[];
  }

  /** 预制体里的子精灵定义（等价于对实例调一次 `e.attach()`）。 */
  interface PrefabChildSpec {
    asset: string;
    /** 像素偏移（`offsetX/offsetY` 是 `dx/dy` 的别名） */
    dx?: number;
    dy?: number;
    offsetX?: number;
    offsetY?: number;
    z?: number;
    rotation?: number;
    alpha?: number;
    w?: number;
    h?: number;
  }

  /** `bwe.prefab.spawn(name, opts)` 的覆盖参数：只覆盖你给的字段。 */
  interface PrefabSpawnOpts {
    x?: number;
    y?: number;
    z?: number;
    layer?: number;
    rotation?: number;
    scaleX?: number;
    scaleY?: number;
    halfW?: number;
    halfH?: number;
    visible?: boolean;
    animMode?: string;
    animFps?: number;
    asset?: string;
    /** 传空字符串 = 不挂脚本 */
    script?: string;
    /** 实例名；缺省用预制体名 */
    name?: string;
    /** 父实体（null 或省略 = 无父级） */
    parent?: Entity | null;
    /** 追加到模板 tags 之后（去重） */
    tags?: string[];
    /** 同 def 替换该模块，新 def 追加 */
    modules?: SpawnModuleInit[];
    /** 与模板 props 合并，同名以这里为准 */
    props?: Record<string, unknown>;
    /**
     * 抖动开关：
     * - `true`  → **强制抖**（即使给了 x/y 也抖）
     * - `false` → 不抖
     * - 省略    → 给了 x/y 就不抖（精确落位）；没给 x/y 才用模板 jitter 抖
     */
    jitter?: boolean;
  }

  /** 对象池统计。 */
  interface PoolStats {
    /** 空闲（已归还，可复用） */
    idle: number;
    /** 使用中 */
    active: number;
    /** 池里现有实例总数（idle + active） */
    total: number;
    /** create 时给的上限 */
    capacity: number;
  }

  /**
   * 预制体：运行期模板注册表。
   *
   * **v1 不做热更新**：`define` 之后已经生成的实例保持原样，之后 `spawn` 才用新定义。
   */
  interface Prefab {
    /** 注册 / 覆盖一个模板；返回是否成功（spec 不是对象时 false） */
    define(name: string, spec: PrefabSpec): boolean;
    /** 读模板的深拷贝快照（改它不影响注册表）；不存在返回 null */
    get(name: string): PrefabSpec | null;
    /** 所有模板名（顺序 = define 顺序） */
    list(): string[];
    has(name: string): boolean;
    /** 移除模板（已生成的实例不受影响） */
    remove(name: string): boolean;
    /** 实例化；opts 在模板之上覆盖 → Entity（模板不存在返回 null） */
    spawn(name: string, opts?: PrefabSpawnOpts): Entity | null;
    /** 批量实例化（每个元素是一份覆盖） */
    spawnMany(name: string, opts?: PrefabSpawnOpts[]): Entity[];
    /** 当前存活的该预制体实例数（对象池/上限用） */
    count(name: string): number;
    /** 把场上实体抓成模板并注册；返回模板名（失败返回 null） */
    fromEntity(e: Entity, name?: string): string | null;
  }

  /** 对象池：复用预制体实例，避免频繁 spawn/destroy。 */
  interface Pool {
    /**
     * 建池；`opts.prewarm = true` 会立刻预生成 capacity 个隐藏实例。
     * 预制体不存在返回 -1。
     */
    create(prefabName: string, capacity?: number, opts?: { prewarm?: boolean }): number;
    /** 取一个实例（优先复用空闲的），落到 (x, y)；池满返回 null */
    acquire(handle: number, x: number, y: number): Entity | null;
    /** 归还；实体不属于该池 / 已销毁 → false */
    release(handle: number, e: Entity): boolean;
    /** 统计；handle 无效返回 null */
    stats(handle: number): PoolStats | null;
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
    /** 可视化尺寸（与编辑器 halfW/halfH 同一套规则）。写 `e.size = {w, h}` 等价 setSize。 */
    size: Size;
    setSize(w: number, h: number): void;

    /** 图层下标（绘制顺序 layer → z → y）。编辑器锁定状态在运行时无意义，但保留读写以保持接口一致。 */
    layer: number;
    /** 锁定标记（只记忆，不影响运行时行为） */
    locked: boolean;
    /** 动画模式（"默认" / "只显示首帧" / "单次播放"；写时 "loop"/"first"/"once" 也认） */
    animMode: string;
    /** 每秒帧数（写会顺带解除 setFrame 的帧锁定） */
    animFps: number;
    /** 当前素材名（读）；写入等价换图但**不改播放参数** */
    asset: string;

    /** 染色（0~1，读写；写等同 setColor 的四个通道，null 清除用 clearColor） */
    readonly color: { r: number; g: number; b: number; a: number };
    /**
     * 染色 + 透明度。每个通道接受 0~1；**任一通道 > 1 时整组按 0~255 解释**。
     * 渲染侧用 GL 调制实现（乘法），与 blink 模块的 alpha 相乘。
     */
    setColor(r: number, g: number, b: number, a?: number): void;
    /** 只改透明度（0~1，>1 视作 0~255） */
    setAlpha(a: number): void;
    /** 清除染色，恢复原样 */
    clearColor(): void;

    /** 标签操作 */
    addTag(tag: string): boolean;
    removeTag(tag: string): boolean;
    hasTag(tag: string): boolean;
    /** 整体替换标签集合 */
    setTags(tags: string[]): void;

    /** 全部对象属性（快照） */
    props(): Record<string, string>;
    /** 批量写属性（值会归一成编辑器同构文本） */
    setProps(obj: Record<string, unknown>): void;

    /**
     * 追加模块；同 def 已存在时**合并参数**而不是新建。
     * 加 `combat.health` 会**立刻重算** `hpMax`/`hp`（与场景对象同一份语义）。
     */
    addModule(def: string, params?: Record<string, unknown>, when?: string): boolean;
    /**
     * 移除模块；不存在返回 false。
     *
     * 移除 `combat.health` 只是「不再跟模块参数联动」，**不会重置当前 `hp`/`hpMax`**。
     * 想让实体回到默认血量，请显式设 `e.hp` / `e.hpMax`。
     */
    removeModule(def: string): boolean;

    /** 父实体（读写；null = 无父级） */
    parent: Entity | null;
    /** 直接子级（只读快照） */
    children(): Entity[];

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
    /** 摘掉子精灵：传 `attach()` 的返回值，或直接传它的 `id` */
    detach(handle: AttachHandle | number): void;

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

    /**
     * 注册实体事件。
     *
     * <p><b>载荷是「位置参数」而不是单个对象</b>（引擎派发时就是这么传的），
     * 各事件的实参个数也不同，所以这里按事件分别声明 —— 写成一个
     * `fn(payload)` 会让「二参回调」被判类型错误（实测踩过）：
     * <table>
     *   <tr><th>事件</th><th>回调签名</th><th>派发点</th></tr>
     *   <tr><td>damage</td><td>(amount, from)</td><td>e.damage / bwe.combat.hit</td></tr>
     *   <tr><td>death</td><td>(by)</td><td>同上（血量归零时）</td></tr>
     *   <tr><td>enter / leave</td><td>(other)</td><td>ZONE 触发区</td></tr>
     *   <tr><td>interact</td><td>(player)</td><td>bwe.interact 触发</td></tr>
     *   <tr><td>click / destroy</td><td>()</td><td>点击 / 销毁前</td></tr>
     * </table>
     * 同名事件重复注册会覆盖。用 `function (a, b)` 或少参数的写法都可以
     * （少参数回调在 JS 里是合法的，TS 也允许）。
     */
    on(event: "damage", fn: (amount: number, from: Entity | null) => void): void;
    on(event: "death", fn: (by: Entity | null) => void): void;
    on(event: "enter" | "leave" | "interact", fn: (other: Entity | null) => void): void;
    on(event: "click" | "destroy", fn: () => void): void;
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
    /** 图层下标，缺省 0 */
    layer?: number;
    /** 碰撞体半宽半高（0 = 不参与碰撞） */
    halfW?: number;
    halfH?: number;
    /** 缩放 */
    scaleX?: number;
    scaleY?: number;
    /** 角度，顺时针，单位度 */
    rotation?: number;
    /** 是否可见，缺省 true */
    visible?: boolean;
    /** 动画模式（"默认" / "只显示首帧" / "单次播放"；也认 "loop"/"first"/"once"） */
    animMode?: string;
    /** 每秒帧数，缺省 8 */
    animFps?: number;
    /** 挂上的 JS 脚本名 */
    script?: string;
    /** 额外模块 */
    modules?: SpawnModuleInit[];
    /** 初始对象属性 */
    props?: Record<string, unknown>;
    /** 父实体 */
    parent?: Entity | null;
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
    /** 批量生成（每个元素一份 opts） */
    spawnMany(list: SpawnOpts[]): Entity[];
    /** 便捷式：spawn(opts) 并强制覆盖 x/y */
    spawnAt(opts: Omit<SpawnOpts, "x" | "y"> & { x?: number; y?: number }, x: number, y: number): Entity;
    /** 复制一个实体（tags/模块/props/子精灵一并带上）；opts 覆盖副本字段 */
    clone(e: Entity, opts?: Partial<SpawnOpts> & { name?: string }): Entity | null;
    /** 销毁实体 */
    destroy(e: Entity): void;
    /** 销毁所有实体（包含场景原生对象） */
    clear(): void;
    /** 只销毁带该标签的实体 */
    clearTag(tag: string): void;
    /** 批量销毁；filter 省略 = 全部。返回实际销毁数量 */
    destroyAll(filter?: EntityQuery): number;
    /** 数量：无参 = 存活实体总数，有参 = 匹配数 */
    count(q?: EntityQuery): number;
    /** 遍历（内部先拍快照，回调里 spawn/destroy 安全） */
    each(q: EntityQuery | null | undefined, fn: (e: Entity) => void): void;
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
    /** 当前视口（屏幕）尺寸，供 HUD 布局使用 */
    readonly size: { w: number; h: number };
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
   *
   * ⚠ `self` 的两种语义：
   * - **对象脚本**（挂了 `script.js` 的实体）：`self` 就是这个实体，可放心 `ctx.self.x`。
   * - **场景脚本**（`scene.onStartScript` / `boot.json` 的 `jsMain`）：**`self` 是 `null`**。
   *   场景没有「自己的实体」，硬要用会运行期 `TypeError`。用 `bwe.world.find(名字)` 取对象。
   */
  interface Ctx {
    /** 挂脚本的实体；<b>场景脚本里是 null</b>（见上面说明） */
    self: Entity | null;
    world: World;
    scene: SceneInfo;
    time: Time;
    camera: Camera;
    input: Input;
    save: Save;
    /** 本帧步长（秒），onUpdate(ctx, dt) 的第二个参数也是它 */
    dt: number;
    /** 整个 `bwe` 命名空间（等价于脚本里的全局 `bwe`） */
    game: typeof bwe;
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

  // ==========================================================================
  // 扫雷 bwe.mine —— 内置 game.minesweeper 模块的运行时设置 / 状态
  // ==========================================================================

  interface MineConfig {
    rows?: number;
    cols?: number;
    mines?: number;
    /** 格子像素尺寸 16~64；改它会重建棋盘 */
    cellSize?: number;
    /** 0-999999；0 = 每局随机 */
    seed?: number;
  }

  interface MineState {
    rows: number;
    cols: number;
    mines: number;
    flags: number;
    /** 玩家至少点开过一格 */
    started: boolean;
    /** 是否结束（胜或负） */
    over: boolean;
    /** 是否赢（over 且 win） */
    won: boolean;
    /** over 且未赢 = 踩了雷 */
    hitMine: boolean;
    elapsed: number;
  }

  interface Mine {
    /** 在游戏内改棋盘：rows/cols/mines/seed 任一个都会触发重建 */
    set(cfg: MineConfig): void;
    /** 不改参数，重新洗盘 */
    reset(): void;
    /** 读当前状态（rows/cols 统计、flags、over/won、elapsed） */
    state(): MineState;
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
  /** 扫雷内置模块的运行时设置 */
  const mine: Mine;
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
  /** 预制体：运行期模板注册与实例化 */
  const prefab: Prefab;
  /** 对象池：复用预制体实例 */
  const pool: Pool;

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
    /** 注册事件；返回取消订阅函数（<b>一定要接住并调用</b>，否则回调会一直累积）。 */
    on(ev: "ignite" | "extinguish" | "burned", fn: (info: FieldEvent) => void): () => void;
    /**
     * 取消订阅。两种用法：
     * - `off(ev, fn)`：摘掉指定回调；
     * - `off(ev)`：清空该事件的全部回调。
     */
    off(ev: "ignite" | "extinguish" | "burned", fn?: (info: FieldEvent) => void): void;
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

  // ==========================================================================
  // 开放世界：场景 / 空间 / 碰撞 / 输入动作 / 路网 / 车辆 / 战斗 / 调试
  // ==========================================================================

  // ---- 场景 scene ---------------------------------------------------------

  /** `bwe.scene.list()` 的一项。 */
  interface SceneListItem {
    name: string;
    /** 场景文件名（含路径后缀）。 */
    file: string;
    /** 在场景列表里的序号。 */
    index: number;
    width: number;
    height: number;
    /** 是否当前场景。 */
    current: boolean;
  }

  /** `bwe.scene.current()` 的返回。 */
  interface SceneCurrent {
    name: string;
    file: string;
    index: number;
    /** 场景代数：每次真正切换 +1。 */
    epoch: number;
    width: number;
    height: number;
    tileSize: number;
  }

  /** 切换回调的入参。 */
  interface SceneChangedInfo {
    /** 切换后的场景名。 */
    name: string;
    epoch: number;
  }

  const scene: {
    /** 工程里的全部场景。 */
    list(): SceneListItem[];
    /** 当前场景（无场景返回 null）。 */
    current(): SceneCurrent | null;
    /** 场景总数。 */
    count(): number;
    /** 是否存在该场景（按名字，或按文件名/去扩展名的 basename 都认）。 */
    has(name: string): boolean;
    /** 请求切换场景：**只登记，帧末生效**，返回是否登记成功。 */
    switchTo(name: string): boolean;
    /** `switchTo` 的别名（语义：加载并切过去）。 */
    load(name: string): boolean;
    /** 待切换的场景名（没有则 null）。 */
    pending(): string | null;
    /** 场景代数：每次真正切换 +1（可用来判断"我拿到的是不是旧数据"）。 */
    epoch(): number;
    /** 注册切换回调。事件名：`"willChange"`（切换前）/ `"changed"`（切换后）。返回该函数本身，未知事件返回 null。 */
    on(ev: "willChange" | "changed", fn: (info: SceneChangedInfo) => void): ((info: SceneChangedInfo) => void) | null;
    /** 按函数引用摘掉回调（willChange 与 changed 都会找）。 */
    off(fn: (info: SceneChangedInfo) => void): boolean;
  };

  // ---- 空间 spatial -------------------------------------------------------

  /** 楼层内的一个空间区域（房间 / 走廊）。 */
  interface SpatialZone {
    id: string;
    name: string;
    buildingId: string;
    /** 楼层键：`建筑id/楼层id`。 */
    floorKey: string;
    level: number;
    x: number;
    y: number;
    halfW: number;
    halfH: number;
    /** 数据里声明的静态属性。 */
    collides: boolean;
    navigable: boolean;
    /** 本帧解析出的三个运行时状态。 */
    renderVisible: boolean;
    collisionEnabled: boolean;
    navPassable: boolean;
    /** 进入该区域所需的 link id（空 = 无需过渡）。 */
    viaLink: string;
    tags: string[];
  }

  /** 垂直连接（楼梯 / 电梯）。 */
  interface SpatialLink {
    id: string;
    kind: string;
    aLevel: number;
    bLevel: number;
    ax: number;
    ay: number;
    bx: number;
    by: number;
    bidirectional: boolean;
    travelTime: number;
    requiresInteract: boolean;
  }

  /** 玩家当前所处空间。 */
  interface CurrentSpace {
    zoneId: string;
    buildingId: string;
    /** 楼层 id（不是序号）。 */
    floorId: string;
    level: number;
    indoor: boolean;
  }

  /** 某个区域的三个运行时状态。 */
  interface ZoneVisibility {
    renderVisible: boolean;
    collisionEnabled: boolean;
    navPassable: boolean;
  }

  const spatial: {
    /** 当前场景是否有楼层/区域数据（旧工程 = false，此时所有查询都不阻挡）。 */
    hasData(): boolean;
    /** 建筑数量。 */
    buildingCount(): number;
    /** 区域数量。 */
    zoneCount(): number;
    /** 垂直连接数量。 */
    linkCount(): number;
    /** 全部区域（只读快照）。 */
    all(): SpatialZone[];
    /** 按区域 id 取。 */
    byId(id: string): SpatialZone | null;
    /** 取坐标所在区域。 */
    at(x: number, y: number): SpatialZone | null;
    /** 玩家当前空间（无数据 / 不在任何区域 = null）。 */
    current(): CurrentSpace | null;
    /** 玩家楼层序号（无数据 = 0）。 */
    level(): number;
    /** 某实体所在楼层序号（跨层判断的关键）。 */
    levelOf(e: Entity): number;
    /** 某实体所在区域。 */
    zoneOf(e: Entity): SpatialZone | null;
    /** 区域三状态（可传区域对象或 id）。 */
    visibility(zone: SpatialZone | string): ZoneVisibility | null;
    /** 全部垂直连接。 */
    links(): SpatialLink[];
    /** 按 id 取连接。 */
    link(id: string): SpatialLink | null;
    /** 两楼层之间是否有连接（"楼梯存在吗"）。 */
    linkBetween(aLevel: number, bLevel: number): SpatialLink | null;
    /** 靠 link 能否从一层到另一层。 */
    canReachLevel(from: number, to: number): boolean;
    /** 把实体沿连接传送到另一端（电梯 / 楼梯搬家）；成功返回 true。 */
    useLink(id: string, e: Entity): boolean;
    /**
     * 让实体**从门口走进**某个区域（设置其楼层归属为区域所在层）。
     *
     * 与 `useLink` 的区别：`useLink` 走的是两层之间的垂直连接（楼梯/电梯）；
     * `enter` 用于"从室外走进一层"这种**非垂直**的进入。
     * 传 zone id 或 SpatialZone；省略 `e` = 作用于玩家。
     */
    enter(zone: string | SpatialZone, e?: Entity): boolean;
    /** 让实体走出建筑，楼层归属退回地面层（0）。省略 `e` = 作用于玩家。 */
    leave(e?: Entity): boolean;
    /** 自定义楼层可见性规则；`"default"` 或省略 = 恢复默认。当前 v1 只接受 default，其它值返回 false。 */
    setVisibilityRule(rule?: "default" | null): boolean;
    /** 清空索引（场景卸载时引擎自己会清，一般不用手调）。 */
    clear(): boolean;
  };

  // ---- 碰撞 collision -----------------------------------------------------

  /** 碰撞回调的事件对象。 */
  interface CollisionEvent {
    event: "enter" | "stay" | "exit" | "triggerEnter" | "triggerStay" | "triggerExit";
    /** 注册回调时指定的那个实体（`on(ev, fn, e)` 的第 3 个参数）。 */
    self: Entity | null;
    /** 对方的相对视角。 */
    other: Entity | null;
    a: Entity | null;
    b: Entity | null;
    /** 是否传感器（触发区）。 */
    sensor: boolean;
  }

  /** 几何射线命中结果。 */
  interface CollisionRayHit {
    hit: boolean;
    /** 命中点（未命中 = 终点）。 */
    x: number;
    y: number;
    entity: Entity | null;
    /** 命中距离（未命中 = 线段全长）。 */
    distance: number;
  }

  const collision: {
    /**
     * 订阅碰撞事件。事件名：`"enter"` / `"stay"` / `"exit"`（含 `"triggerEnter"` 等传感器变体）。
     * 第 3 个参数传实体 = 只收该实体的事件；不传 = 收全局。
     * 返回回调函数本身，便于 `off(fn)`。
     */
    on(ev: "enter" | "stay" | "exit" | "triggerEnter" | "triggerStay" | "triggerExit", fn: (info: CollisionEvent) => void, e?: Entity): ((info: CollisionEvent) => void) | null;
    /** 摘掉回调（全局与按实体的都会找）。 */
    off(fn: (info: CollisionEvent) => void): boolean;
    /** 矩形查询：命中所有可见实体。 */
    query(rect: Rect): Entity[];
    /** 圆形查询（圆 vs AABB，最贴近的点比较）。 */
    overlapCircle(x: number, y: number, r: number): Entity[];
    /** 线段射线检测（纯几何，不含瓦片）。 */
    raycast(x1: number, y1: number, x2: number, y2: number): CollisionRayHit;
    /** 把实体的碰撞体标为传感器（触发区）。 */
    setTrigger(e: Entity, on?: boolean): boolean;
    /** 是否传感器。 */
    isTrigger(e: Entity): boolean;
    /** 当前与该实体接触的实体（几何重叠）。 */
    contacts(e: Entity): Entity[];
    /** 当前接触对数（诊断 / 断言用）。 */
    count(): number;
  };

  // ---- 输入动作 actions ---------------------------------------------------

  const actions: {
    /**
     * 批量写入动作映射（**合并**，不动未提到的动作）。
     * 值可以是键名字符串、键名数组，或逗号分隔字符串。
     */
    bind(map: { [action: string]: string | string[] }): boolean;
    /** 解绑单个动作。 */
    unbind(action: string): boolean;
    /** 恢复默认映射。 */
    reset(): boolean;
    /** 全部动作名。 */
    actions(): string[];
    /** 某动作绑定的键（返回键名/键码字符串）。 */
    keys(action: string): string[];
    /** 持续按住（且当前上下文放行）。 */
    down(action: string): boolean;
    /** 本帧刚按下。 */
    pressed(action: string): boolean;
    /** 本帧刚松开。 */
    released(action: string): boolean;
    /** `{x, y}` 方向轴，用 `move_*` 动作算，已归一化（Y 向下）。 */
    axis(): Vec2;
    /** 当前上下文名（栈空 = `"game"`）。 */
    context(): string;
    /** 压入上下文（如 `"ui"`）。 */
    pushContext(name: string): boolean;
    /** 弹出上下文，返回被弹出的名字（空栈 = null）。 */
    popContext(): string | null;
    /** 直接设为单一上下文（传空串 = 清空栈）。 */
    setContext(name: string): boolean;
    /** 声明某上下文只放行哪些动作；不调用 = 全部放行。 */
    allow(context: string, actions: string[]): boolean;
    /** 订阅动作触发（按下时派发）。返回该函数本身。 */
    on(action: string, fn: (info?: unknown) => void): ((info?: unknown) => void) | null;
    /** 摘掉回调；也支持 `off(action, fn)` 形式。 */
    off(fn: (info?: unknown) => void): boolean;
    /** 窗口当前是否有焦点（失焦时所有动作立即为 false）。 */
    focused(): boolean;
  };

  // ---- 路网 road ----------------------------------------------------------

  /** 路网节点（路口 / 站点）。 */
  interface RoadNode {
    id: string;
    x: number;
    y: number;
    kind: string;
  }

  /** `nearest()` 的结果：节点 + 距离。 */
  interface RoadNearest extends RoadNode {
    dist: number;
  }

  /** 路网边（路段）。 */
  interface RoadEdge {
    from: string;
    to: string;
    width: number;
    speedLimit: number;
    oneway: boolean;
    length: number;
  }

  const road: {
    /** 当前场景是否有路网数据。 */
    hasData(): boolean;
    nodeCount(): number;
    edgeCount(): number;
    /** 全部节点。 */
    nodes(): RoadNode[];
    /** 全部路段。 */
    edges(): RoadEdge[];
    /** 按 id 取节点。 */
    node(id: string): RoadNode | null;
    /** 最近的节点（带 `dist`）。 */
    nearest(x: number, y: number): RoadNearest | null;
    /**
     * 最短**时间**路径（权重 = 长度 / 限速，不是最短距离）。
     * `from` / `to` 可传节点 id、`{id}` 或 `{x, y}`（取最近节点）。
     * 不可达返回空数组。
     */
    route(from: string | RoadNode | Vec2, to: string | RoadNode | Vec2): RoadNode[];
    /** 两点是否连通。 */
    canReach(from: string | RoadNode | Vec2, to: string | RoadNode | Vec2): boolean;
    /** 途经点的两段路径（出租车"先接客再送客"），任一段不可达 = 空。 */
    routeThrough(from: string | RoadNode | Vec2, via: string | RoadNode | Vec2, to: string | RoadNode | Vec2): RoadNode[];
    /** 当前缓存的路径条数（诊断用）。 */
    cachedRoutes(): number;
    /** 清空路径缓存。 */
    clear(): boolean;
  };

  // ---- 车辆 vehicle -------------------------------------------------------

  /** `bwe.vehicle.of(e)` 的返回。 */
  interface VehicleInfo {
    id: number;
    kind: string;
    /** 当前速度 px/s。 */
    speed: number;
    speedLimit: number;
    /** 朝向角度（0 = 朝右，顺时针为正）。 */
    heading: number;
    /** 损伤 0..1。 */
    damage: number;
    driver: Entity | null;
    autoDrive: boolean;
    /** 路线进度（路点下标 / 路点总数，路点含车道点与路口弧线采样点，只表示进度）。 */
    routeIndex: number;
    routeLength: number;
    /** 自动驾驶时下一个尚未通过的路网节点 id；无路线为 `""`。 */
    nextNode: string;
    /** 最近通过（或出发）的路网节点 id；无则 `""`。 */
    prevNode: string;
    /** 车到 nextNode 中心的直线距离 px；无路线为 `-1`。 */
    nextNodeDist: number;
    /** 已越过 nextNode 的停止线（在路口内）——红灯时不要再刹车。 */
    inJunction: boolean;
    /** 驻车中（下车 / stop / 到站后）：目标速度 0，不倒车；throttle / steer / followRoad / enter 解除。 */
    parked: boolean;
    /** 当前制动 / 油门输入 0..1。 */
    brake: number;
    throttle: number;
  }

  /**
   * 车辆事件载荷（`bwe.vehicle.on(...)` 的入参）。
   *
   * <p>引擎派发的是一个<b>对象</b>（不是位置参数），字段如下：
   * `{event, vehicle, actor, kind}`。
   */
  interface VehicleEvent {
    event: "crash" | "hijack" | "enter" | "exit" | "arrive";
    /** 事件相关的那辆车。 */
    vehicle: Entity;
    /** 相关的实体：hijack 的原司机 / enter·exit 的上下车人 / 其它事件为 null。 */
    actor: Entity | null;
    /** 车辆类型（car / taxi / police 等，由 spawn 时的 kind 决定）。 */
    kind: string;
  }

  const vehicle: {
    /** 生成一辆车（`opts` 与 `bwe.world.spawn` 同构，另认 `kind`）。 */
    spawn(opts: { kind?: string; x?: number; y?: number } & { [k: string]: unknown }): Entity | null;
    /** 车辆的完整状态。 */
    of(e: Entity): VehicleInfo | null;
    isVehicle(e: Entity): boolean;
    /** 该车的驾驶员。 */
    driver(e: Entity): Entity | null;
    /** 该实体正在驾驶的车。 */
    vehicleOf(e: Entity): Entity | null;
    /** 上车（不改变自动驾驶 / 路线 / 可见性；NPC 上车后可继续沿路开）。 */
    enter(driver: Entity, vehicle: Entity): boolean;
    /** 下车（车留下并驻车）；人放在车左侧，垂直于车头、距离 halfH+12。 */
    exit(driver: Entity): boolean;
    /** 劫车：原驾驶员被拽到车左侧并派发 hijack，取消自动驾驶与路线、油门归零，再由 hijacker 上车。 */
    hijack(hijacker: Entity, vehicle: Entity): boolean;
    /** 油门 0..1（自动驾驶时忽略）。 */
    throttle(e: Entity, v?: number): boolean;
    /**
     * 制动 0..1，持续生效直到再次设置。
     * 自动驾驶时：目标速度 × (1 − brake)，≥ 0.99 刹停但保留路线（红灯用 brake(car,1) / brake(car,0)）。
     * 手动且有驾驶员：前进时刹车，速度 ≤ 0 后倒车（最高 30% 限速）；无驾驶员只刹停。
     */
    brake(e: Entity, v?: number): boolean;
    /** 转向 -1..1（右 = 顺时针）；转向速率随速度增大，0 速不转，倒车时反向。 */
    steer(e: Entity, v?: number): boolean;
    /**
     * 本帧把速度直接设为 `v`（px/s，负数 = 倒车），这一帧不经过加减速；下一帧恢复正常物理。
     * 例：`setSpeed(car, 0)` 瞬停；出场给初速度。不是车辆返回 false。
     */
    setSpeed(e: Entity, v: number): boolean;
    /** 当前速度 px/s。 */
    speed(e: Entity): number;
    /** 朝向角度。 */
    heading(e: Entity): number;
    /** 读损伤（不传 n）或累加损伤（传 n），返回累加后的值 0..1。 */
    damage(e: Entity, n?: number): number;
    /**
     * 沿路网自动驾驶到某节点：靠右车道（偏移 = 路宽/4），路口走平滑弧线，弯前减速，停在目标节点的停止线上。
     * 车在路段中间时从车头方向的端点出发（不掉头）。重置 throttle / brake 为 0；`opts.onArrive` 到达时回调一次。
     */
    followRoad(e: Entity, target: string | RoadNode | Vec2, opts?: { onArrive?: (info?: unknown) => void }): boolean;
    /** 停车：取消自动驾驶与路线、油门 / 制动归零并驻车（平滑减速到 0，不倒车）。 */
    stop(e: Entity): boolean;
    /** 当前车辆总数。 */
    count(): number;
    /** 订阅事件：`"crash"` / `"hijack"` / `"enter"` / `"exit"` / `"arrive"`。 */
    on(ev: "crash" | "hijack" | "enter" | "exit" | "arrive", fn: (info: VehicleEvent) => void): ((info: VehicleEvent) => void) | null;
    off(fn: (info: VehicleEvent) => void): boolean;
  };

  // ---- 战斗 combat --------------------------------------------------------

  /** 武器参数表项。 */
  interface WeaponParams {
    name: string;
    damage: number;
    /** 有效距离（格）。 */
    range: number;
    /** 冷却秒。 */
    cooldown: number;
    ammoMax: number;
    melee: boolean;
  }

  /** `bwe.combat.hit(opts)` 的结果。 */
  interface HitResult {
    hit: boolean;
    target: Entity | null;
    amount: number;
    blocked: boolean;
    killed: boolean;
  }

  /** 战斗事件（`on("kill"|"damage", fn)` 的入参）。 */
  interface CombatEvent {
    event: "kill" | "damage";
    from: Entity | null;
    to: Entity;
    amount: number;
    killed: boolean;
  }

  const combat: {
    /** 查武器参数（数据驱动）。未知武器 = null。 */
    params(kind: string): WeaponParams | null;
    /** 全部武器名。 */
    weapons(): string[];
    /**
     * 发起一次攻击（`opts` 认 `from` / `to` / `weapon` 等）。
     * 返回 `{hit, target, amount, blocked, killed}`。
     */
    hit(opts: { from?: Entity; to?: Entity; weapon?: string } & { [k: string]: unknown }): HitResult;
    /** 开/关格挡。 */
    defend(e: Entity, on?: boolean): boolean;
    /** 是否在格挡。 */
    defending(e: Entity): boolean;
    /** 格挡减伤系数 0..1。 */
    setDefense(e: Entity, v?: number): boolean;
    /** 读武器（不传 name）或换武器（传 name，未知武器返回 false）。 */
    weapon(e: Entity, name?: string): string | boolean;
    /** 该实体当前武器名。 */
    weaponOf(e: Entity): string;
    /** 循环切到下一把武器，返回新武器名。 */
    switchWeapon(e: Entity): string | boolean;
    /** 当前弹药。 */
    ammo(e: Entity): number;
    /** 设置弹药。 */
    setAmmo(e: Entity, n: number): boolean;
    /** 订阅事件：`"kill"` / `"damage"`。 */
    on(ev: "kill" | "damage", fn: (info: CombatEvent) => void): ((info: CombatEvent) => void) | null;
    off(fn: (info: CombatEvent) => void): boolean;
    /** 两点距离是否在射程内。 */
    inRange(a: Entity, b: Entity, range?: number): boolean;
  };

  // ---- 调试 debug ---------------------------------------------------------

  /** `bwe.debug.stats()` 的返回。 */
  interface DebugStats {
    actors: number;
    pendingDestroy: number;
    sceneEpoch: number;
    colliders: number;
    vehicles: number;
    spatialZones: number;
    drawCommands: number;
    enabled: boolean;
  }

  const debug: {
    /** 总开关（打开后才允许逐项绘制）。 */
    on(): boolean;
    /** 关闭并复位所有逐项开关。 */
    off(): boolean;
    enabled(): boolean;
    /** 画所有有碰撞盒的实体（`on` 省略 = true）。 */
    colliders(on?: boolean): boolean;
    /** 画沿路径跟随的实体的路径。 */
    paths(on?: boolean): boolean;
    /** 画空间区域边界。 */
    zones(on?: boolean): boolean;
    /** 画瓦片阻挡图（小地图开销大，慎用）。 */
    nav(on?: boolean): boolean;
    /** 单次画矩形。 */
    box(x: number, y: number, w: number, h: number, color?: string): void;
    /** 单次画圆。 */
    circle(x: number, y: number, r: number, color?: string): void;
    /** 单次画线。 */
    line(x1: number, y1: number, x2: number, y2: number, color?: string): void;
    /** 画某实体的碰撞框。 */
    actor(e: Entity, color?: string): void;
    /** 运行时统计（性能水位观察）。 */
    stats(): DebugStats;
  };
}
