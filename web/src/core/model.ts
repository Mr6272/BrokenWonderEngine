/**
 * 工程数据模型（Web 版）。
 *
 * 与 Java 桌面版共用同一份 .bwproj 格式，字段名逐一对齐：
 * 同一个工程文件在两个端都能打开，这是刻意的设计，避免两套数据各说各话。
 */

/** 工程文件格式版本，用于将来做数据迁移。 */
export const PROJECT_FORMAT = 1;

/** 素材种类。 */
export type AssetKind = "IMAGE" | "SEQUENCE" | "ATLAS" | "AUDIO";

/** 场景对象大类（GameObject 类别）。 */
export type GameObjectKind = "ACTOR" | "PROP" | "TILE" | "ZONE" | "SPAWN" | "PORTAL" | "LIGHT";

/** 参数类型：决定属性面板给什么控件。 */
export type ParamType = "num" | "text" | "bool" | "pick" | "obj" | "asset" | "tag" | "script" | "note";

/** 触发时机。 */
export type TriggerId =
  | "ALWAYS" | "ON_START" | "ON_CLICK" | "ON_TRIGGER_ENTER" | "ON_TRIGGER_EXIT"
  | "ON_DAMAGE" | "ON_DEATH" | "ON_TIMER" | "ON_INTERACT" | "ON_SCENE_START"
  | "ON_VARIABLE" | "ON_CALLED";

export interface ParamDef {
  key: string;
  /** 参数显示名，Unity 风格：Position / Scale / Move Speed */
  label: string;
  type: ParamType;
  def: string;
  /** pick 型的候选项 */
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** 悬浮提示：这一栏到底在问什么 */
  hint?: string;
  required?: boolean;
}

export interface ModuleDef {
  id: string;
  /** 中文可读的模块名，一眼看懂用途 */
  title: string;
  /** Unity 风格英文名，出现在摘要与导出数据里 */
  code: string;
  category: ModuleCategoryId;
  /** 一行说明 */
  blurb: string;
  /** 展开后的详细说明：什么时候该用、和什么冲突 */
  detail: string;
  params: ParamDef[];
  /** 允许的触发时机；空数组表示"不需要触发条件，一直生效" */
  triggers: TriggerId[];
  /** 需求订阅等级 */
  premium?: boolean;
  /** 试验中的模块，界面会标注 */
  experimental?: boolean;
}

export type ModuleCategoryId = "move" | "render" | "detect" | "event" | "combat" | "dialogue" | "fx" | "grid" | "game";

export interface ModuleCategory {
  id: ModuleCategoryId;
  label: string;
  blurb: string;
  color: string;
}

/** 挂在对象上的模块实例。 */
export interface ModuleInstance {
  defId: string;
  label?: string;
  trigger?: TriggerId | null;
  values: Record<string, string>;
  enabled: boolean;
  collapsed: boolean;
}

/** 素材条目。 */
export interface AssetEntry {
  id: string;
  name: string;
  kind: AssetKind;
  /**
   * 素材来源。
   * - blob: 用户在本机导入的图，二进制存在 IndexedDB，靠 id 取
   * - url:  远程地址（CDN / 图床）
   */
  src: "blob" | "url";
  url?: string;
  /** 单图/图集：文件相对路径；序列帧：所在分组名 */
  path: string;
  /** 序列帧专用 */
  headName?: string;
  frameCount?: number;
  /** 图集专用 */
  cols?: number;
  rows?: number;
  cellW?: number;
  cellH?: number;
  width: number;
  height: number;
  group: string;
  /** 序列帧：被用户隐藏掉的帧下标 */
  hiddenFrames?: number[];
  /** 序列帧：各帧自定义时长（毫秒），缺省则用统一 fps */
  frameDurations?: number[];
  note?: string;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  order: number;
}

/** 场景中的一个实例。行为全部来自挂载的模块。 */
export interface SceneObject {
  id: string;
  name: string;
  kind: GameObjectKind;
  x: number;
  y: number;
  z: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** 碰撞体半宽半高（像素）；0 表示不参与碰撞 */
  halfW: number;
  halfH: number;
  layerId: string;
  visible: boolean;
  locked: boolean;
  assetId: string;
  animMode: string;
  animFps: number;
  modules: ModuleInstance[];
  props: Record<string, string>;
  tags: string[];
  /** 父对象 id：用于把地面块挂到关卡根节点下。null 表示挂在场景根下 */
  parentId?: string | null;
  /**
   * 这个对象是从哪个预制体放出来的（PrefabDef.id）。
   *
   * v1 只用于两件事：画布/Inspector 上的「来自某某预制体」标记，
   * 以及「还原为预制体默认值」「断开预制体链接」两个手动操作。
   * **不做自动同步**：改了预制体不会改已放置的对象，反之亦然（Unity 的 override 语义太复杂，v1 明确不做）。
   */
  prefabId?: string | null;
}

export interface SceneModel {
  id: string;
  name: string;
  originX: number;
  originY: number;
  widthTiles: number;
  heightTiles: number;
  layers: Layer[];
  objects: SceneObject[];
  onStartScript: string;
  bgmAssetId: string;
  /**
   * ★ UI 场景标记（optional，缺省 = 普通世界场景）。
   *
   * 「UI 场景」是一张**屏幕空间**画布：尺寸单位是设计分辨率像素，不是「格 × tileSize」。
   * 因此 UI 对象（文字 / 图片 / 面板）不会被混进地图的地形/角色图层里，
   * 摆位也不受 tileSize 影响 —— 这正是「UI 不该和场景物体混在一起编辑」的落地方式。
   *
   * 导出时 UI 场景进 boot.json 的 `uiScenes[]`（世界场景仍进 `scenes[]`），
   * 运行时在世界绘制之后覆盖绘制，并以「等比 contain 居中」变换把设计分辨率映射到真实视口，
   * 所以 1280×720 的设计稿在任何窗口尺寸下都完整可见、位置比例一致。
   */
  ui?: boolean;
  /** UI 场景设计分辨率宽（像素）。ui=true 时有效，缺省 1280。 */
  designW?: number;
  /** UI 场景设计分辨率高（像素）。ui=true 时有效，缺省 720。 */
  designH?: number;
  /**
   * ★ 开放世界扩展段（全部 optional，旧工程没有 → 运行时按"单层平地"处理）。
   *
   * 类型用 `unknown[]` / `unknown` 而不是完整详尽的 interface，是刻意的：
   * 这些结构由地图生成器写出、由 Java 运行时读取，编辑器目前只做**透传保存**
   * （不解析、不校验、不重建）。若在这里定义一套 TS 类型，就变成"编辑器第二份真相"，
   * 一旦与 `GameData.java` 的解析字段漂移，就会出现"编辑器能存、运行时读不出"的经典坑。
   * 结构定义以 `src/Studio/runtime/GameData.java` 的 Rt* 类为准（见 docs/api/spatial.md）。
   */
  buildings?: unknown[];
  navLinks?: unknown[];
  roadNetwork?: { nodes?: unknown[]; edges?: unknown[] };
}

/**
 * 脚本语言。
 * - yarn：Yarn Spinner 剧情文本，给「打开对话框」模块用；
 * - js：  JS 脚本（bwe API），给「对象脚本 script.js」与场景 onStartScript 用。
 *
 * 缺省值按 yarn 处理：旧工程里没有 lang 字段，打开后仍是能跑的剧本。
 */
export type ScriptLang = "js" | "yarn";

/** 工程里的一段脚本。js 与 yarn 共用同一条记录，靠 lang 区分。 */
export interface ScriptEntry {
  name: string;
  /** 导出时的相对路径，例如 Scripts/player.js */
  file: string;
  source: string;
  /** 缺省（undefined）等价于 "yarn"，向后兼容旧工程 */
  lang?: ScriptLang;
}

/** 旧名字：历史上脚本只有 Yarn 一种。保留导出，避免外部引用失效。 */
export type YarnScript = ScriptEntry;

/** 取脚本的语言，缺省按 yarn（旧工程没有 lang 字段）。 */
export function scriptLang(s: ScriptEntry | undefined): ScriptLang {
  return s?.lang === "js" ? "js" : "yarn";
}

/** 工程里某一种语言的脚本名（保持插入顺序）。 */
export function scriptNamesOfLang(p: Project | null | undefined, lang: ScriptLang): string[] {
  const scripts = p?.scripts ?? {};
  return Object.keys(scripts).filter((k) => scriptLang(scripts[k]) === lang);
}

/** 默认文件路径：让 js / yarn 各有正确的后缀。 */
export function defaultScriptFile(name: string, lang: ScriptLang): string {
  return `Scripts/${name}.${lang === "js" ? "js" : "yarn"}`;
}

/**
 * 预制体（Prefab）—— 可以反复往场景里摆放的「对象模板」。
 *
 * 与 SceneObject 的核心差异只有三点：
 *   1. 没有 x / y：位置是放置那一刻由用户或随机散布决定的偏移（见 spawnJitter）；
 *   2. 没有 id / layerId / visible / locked / parentId：这些是「放进场景之后」才有意义的东西；
 *   3. 多一个 name（也就是运行期 `bwe.prefab.spawn("小怪")` 用的 key）和一行说明。
 *
 * 其余字段与 SceneObject 同名同义，导出时直接改写成 boot.json 的 `prefabs[]`。
 */
export interface PrefabDef {
  id: string;
  /** 唯一名，运行期 bwe.prefab.define / spawn 用的 key */
  name: string;
  /** 一行说明：这个模板是干什么用的 */
  blurb?: string;
  /** 模板本体：对象类型 */
  kind: GameObjectKind;
  assetId: string;
  /** 排序层级（与 SceneObject.z 同义） */
  z: number;
  /** 缺省图层在场景里的序号，运行时按它排队；0 表示默认 */
  layer?: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** 碰撞体半宽半高；0 = 不参与碰撞，绘制尺寸走素材尺寸 */
  halfW: number;
  halfH: number;
  animMode: string;
  animFps: number;
  tags: string[];
  modules: ModuleInstance[];
  props: Record<string, string>;
  /** 对象脚本名（script.js 模块 params.script 的值，运行期按名字查 scripts[]） */
  script: string;
  /** 放置时的随机位置散布：x/y 各自在 ±该值内偏移。全 0 表示固定落点 */
  spawnJitter?: { x: number; y: number };
}

/** 规则包（模块组合的封装）。 */
export interface RulePack {
  id: string;
  name: string;
  blurb: string;
  modules: ModuleInstance[];
  exposed: Record<string, string>;
  exposedLabel: Record<string, string>;
}

export interface Project {
  format: number;
  name: string;
  author: string;
  /** 一格多少像素（俯视角常用 16 / 32 / 48） */
  tileSize: number;
  gridW: number;
  gridH: number;
  scenes: SceneModel[];
  assets: AssetEntry[];
  /** 预制体模板。旧工程没有这个字段，normalizeProject 会补成空数组 */
  prefabs: PrefabDef[];
  packs: RulePack[];
  scripts: Record<string, ScriptEntry>;
  variables: Record<string, string>;
  masterVolume: number;
}

// ---------------- id 生成 ----------------

export function uid(): string {
  // crypto.randomUUID 在 localhost 与 https 下都可用；退化分支只在极旧浏览器走到
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------- 工厂 ----------------

export function createLayer(name: string): Layer {
  return { id: uid(), name, visible: true, locked: false, order: 0 };
}

export function createScene(name: string, widthTiles = 60, heightTiles = 40): SceneModel {
  return {
    id: uid(),
    name,
    originX: 0,
    originY: 0,
    widthTiles,
    heightTiles,
    layers: [createLayer("地形"), createLayer("物件"), createLayer("角色")],
    objects: [],
    onStartScript: "",
    bgmAssetId: ""
  };
}

/** UI 场景的默认设计分辨率。1280×720 是 16:9，主流手机横屏与桌面窗口都能等比容纳。 */
export const UI_DESIGN_W = 1280;
export const UI_DESIGN_H = 720;

/**
 * 新建一张 UI 场景。
 *
 * 与 createScene 的差别只在三个字段：ui=true 与设计分辨率。
 * 仍然保留 layers / widthTiles / heightTiles —— 后者是「兜底几何」：
 * 设计分辨率换算成格数（按 32px 一格）存进去，让不知道 UI 概念的老代码
 * （例如导出器的通用地图尺寸校验）拿到一个合法值而不是 0。
 */
export function createUiScene(
  name: string,
  designW = UI_DESIGN_W,
  designH = UI_DESIGN_H,
  tileSize = 32
): SceneModel {
  const w = Math.max(64, Math.round(designW));
  const h = Math.max(64, Math.round(designH));
  const ts = Math.max(4, tileSize);
  return {
    id: uid(),
    name,
    originX: 0,
    originY: 0,
    // 只是一份「看起来合理」的兜底格数；真正参与布局的是 designW/designH。
    widthTiles: Math.max(1, Math.round(w / ts)),
    heightTiles: Math.max(1, Math.round(h / ts)),
    layers: [createLayer("背景"), createLayer("界面"), createLayer("浮层")],
    objects: [],
    onStartScript: "",
    bgmAssetId: "",
    ui: true,
    designW: w,
    designH: h
  };
}

/** 这张场景是不是 UI 场景（旧工程没有 ui 字段 → false）。 */
export function isUiScene(s: SceneModel | null | undefined): boolean {
  return !!s && s.ui === true;
}

/**
 * 场景在**当前语境**下的像素宽高。
 *
 * 世界场景 = 格数 × tileSize；UI 场景 = 设计分辨率。
 * 画布、缩放、导出、离屏渲染都必须走这一个函数，否则「UI 场景里画布按格子算尺寸」
 * 就会出现整体缩放对不上的经典错位。
 */
export function scenePixelSize(
  s: SceneModel,
  tileSize: number
): { w: number; h: number } {
  if (isUiScene(s)) {
    return {
      w: Math.max(64, Math.round(s.designW ?? UI_DESIGN_W)),
      h: Math.max(64, Math.round(s.designH ?? UI_DESIGN_H))
    };
  }
  const ts = Math.max(4, tileSize || 32);
  return {
    w: Math.max(1, Math.round(s.widthTiles * ts)),
    h: Math.max(1, Math.round(s.heightTiles * ts))
  };
}

/** UI 场景在设计分辨率内的一条「安全区」（四周各留 5%，避开刘海/圆角/系统手势区）。 */
export function uiSafeArea(
  s: SceneModel
): { x: number; y: number; w: number; h: number } {
  const size = scenePixelSize(s, 32);
  const mx = size.w * 0.05;
  const my = size.h * 0.05;
  return { x: mx, y: my, w: size.w - mx * 2, h: size.h - my * 2 };
}

export function createProject(name = "未命名工程"): Project {
  return {
    format: PROJECT_FORMAT,
    name,
    author: "",
    tileSize: 32,
    gridW: 60,
    gridH: 40,
    scenes: [createScene("场景 1")],
    assets: [],
    prefabs: [],
    packs: [],
    scripts: {},
    variables: {},
    masterVolume: 0.8
  };
}

export function createObject(kind: GameObjectKind, x: number, y: number): SceneObject {
  return {
    id: uid(),
    name: "",
    kind,
    x,
    y,
    z: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    halfW: 0,
    halfH: 0,
    layerId: "",
    visible: true,
    locked: false,
    assetId: "",
    animMode: "默认",
    animFps: 8,
    modules: [],
    props: {},
    tags: [],
    parentId: null,
    prefabId: null
  };
}

/** 空预制体。名字留空，由调用方填一个场景内唯一的名字。 */
export function createPrefab(name = "新预制体"): PrefabDef {
  return {
    id: uid(),
    name,
    blurb: "",
    kind: "PROP",
    assetId: "",
    z: 0,
    layer: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    halfW: 0,
    halfH: 0,
    animMode: "默认",
    animFps: 8,
    tags: [],
    modules: [],
    props: {},
    script: "",
    spawnJitter: { x: 0, y: 0 }
  };
}

/** 深拷贝一份模块实例列表（预制体和场景对象之间互不共享引用）。 */
export function cloneModules(list: ModuleInstance[]): ModuleInstance[] {
  return list.map((m) => ({
    defId: m.defId,
    label: m.label,
    trigger: m.trigger ?? null,
    values: { ...m.values },
    enabled: m.enabled,
    collapsed: m.collapsed
  }));
}

/**
 * 从场景对象抓一个预制体（坐标归零）。
 *
 * 抓的是「模板」不是「这一份」：x / y / layerId / visible / locked / parentId
 * 这些只在具体场景里才有意义的东西一律丢掉，剩下的才是可复用的部分。
 */
export function prefabFromObject(obj: SceneObject, name: string): PrefabDef {
  return {
    id: uid(),
    name,
    blurb: "",
    kind: obj.kind,
    assetId: obj.assetId,
    z: obj.z,
    layer: 0,
    rotation: obj.rotation,
    scaleX: obj.scaleX,
    scaleY: obj.scaleY,
    halfW: obj.halfW,
    halfH: obj.halfH,
    animMode: obj.animMode,
    animFps: obj.animFps,
    tags: [...obj.tags],
    modules: cloneModules(obj.modules),
    props: { ...obj.props },
    // 对象脚本：scene 里它挂在 script.js 模块的 values.script 上，模板里单独存一份，
    // 方便面板显示与运行期 define 时不必再翻模块参数。
    script: obj.modules.find((m) => m.defId === "script.js")?.values["script"] ?? "",
    spawnJitter: { x: 0, y: 0 }
  };
}

/**
 * 用预制体在场景里放一个对象。
 *
 * 位置由调用方给（通常是视图中心或鼠标落点）；模块/属性/标签全部深拷贝，
 * 之后场景对象和预制体各自独立 —— 改预制体不会回头影响已经放下去的对象（v1 无自动同步）。
 */
export function objectFromPrefab(
  prefab: PrefabDef,
  x: number,
  y: number,
  layerId: string
): SceneObject {
  const obj = createObject(prefab.kind, x, y);
  obj.name = prefab.name;
  obj.z = prefab.z;
  obj.rotation = prefab.rotation;
  obj.scaleX = prefab.scaleX;
  obj.scaleY = prefab.scaleY;
  obj.halfW = prefab.halfW;
  obj.halfH = prefab.halfH;
  obj.assetId = prefab.assetId;
  obj.animMode = prefab.animMode;
  obj.animFps = prefab.animFps;
  obj.tags = [...prefab.tags];
  obj.modules = cloneModules(prefab.modules);
  obj.props = { ...prefab.props };
  obj.layerId = layerId;
  obj.prefabId = prefab.id;
  return obj;
}

/**
 * 把场景对象还原成预制体默认值。
 *
 * 保留对象自己的身份与位置（id / name / x / y / layerId / parentId），
 * 其余（素材、模块、标签、属性、动画、缩放、碰撞体）全部按预制体重置。
 * 名字只在对象还没起名时才跟随，避免把用户起的名字冲掉。
 */
export function resetObjectToPrefab(obj: SceneObject, prefab: PrefabDef): void {
  obj.kind = prefab.kind;
  obj.z = prefab.z;
  obj.rotation = prefab.rotation;
  obj.scaleX = prefab.scaleX;
  obj.scaleY = prefab.scaleY;
  obj.halfW = prefab.halfW;
  obj.halfH = prefab.halfH;
  obj.assetId = prefab.assetId;
  obj.animMode = prefab.animMode;
  obj.animFps = prefab.animFps;
  obj.tags = [...prefab.tags];
  obj.modules = cloneModules(prefab.modules);
  obj.props = { ...prefab.props };
  if (!obj.name) obj.name = prefab.name;
}

/** 找到对象所属的预制体（断链的、被删掉的返回 undefined）。 */
export function findPrefabOf(p: Project | null | undefined, obj: SceneObject): PrefabDef | undefined {
  const id = obj.prefabId;
  if (!id) return undefined;
  return (p?.prefabs ?? []).find((x) => x.id === id);
}

/** 所有预制体名字（「从场景对象创建」时要避开重名）。 */
export function prefabNames(p: Project | null | undefined): string[] {
  return (p?.prefabs ?? []).map((x) => x.name);
}

/** 生成一个不与现有预制体重名的新名字：小怪 → 小怪 2 → 小怪 3 */
export function uniquePrefabName(p: Project | null | undefined, base: string): string {
  const taken = new Set(prefabNames(p));
  const stem = (base || "新预制体").trim() || "新预制体";
  if (!taken.has(stem)) return stem;
  for (let i = 2; i < 1000; i++) {
    const next = `${stem} ${i}`;
    if (!taken.has(next)) return next;
  }
  return `${stem} ${uid().slice(0, 4)}`;
}

// ---------------- 查询与校验 ----------------

export function findScene(p: Project, id: string): SceneModel | undefined {
  return p.scenes.find((s) => s.id === id);
}

export function findAsset(p: Project, id: string): AssetEntry | undefined {
  if (!id) return undefined;
  return p.assets.find((a) => a.id === id);
}

export function totalFrames(a: AssetEntry | undefined): number {
  if (!a) return 1;
  if (a.kind === "SEQUENCE") return Math.max(1, a.frameCount ?? 1);
  if (a.kind === "ATLAS") return Math.max(1, (a.cols ?? 1) * (a.rows ?? 1));
  return 1;
}

/**
 * 补齐脚本条目的缺失字段。
 * 旧工程的脚本没有 lang（那时只有 Yarn），这里统一补成 "yarn"，
 * 保证「保存 / 打开」一个来回之后字段是齐的，也让面板不必到处判空。
 */
function normalizeScripts(raw: unknown): Record<string, ScriptEntry> {
  const out: Record<string, ScriptEntry> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const s = value as Partial<ScriptEntry>;
    const name = typeof s.name === "string" && s.name ? s.name : key;
    const lang: ScriptLang = s.lang === "js" ? "js" : "yarn";
    out[key] = {
      name,
      file: typeof s.file === "string" && s.file ? s.file : defaultScriptFile(name, lang),
      source: typeof s.source === "string" ? s.source : "",
      lang
    };
  }
  return out;
}

/**
 * 补齐缺失字段。
 * 从磁盘读进来的 JSON 可能缺字段（旧版本工程、手工改过的文件），
 * 不在入口一次性补齐，undefined 会散落到全场每个面板。
 */
export function normalizeProject(raw: unknown): Project {
  const p = (raw ?? {}) as Partial<Project>;
  const base = createProject(p.name || "未命名工程");

  const out: Project = {
    format: p.format ?? PROJECT_FORMAT,
    name: p.name ?? base.name,
    author: p.author ?? "",
    tileSize: p.tileSize && p.tileSize > 0 ? p.tileSize : 32,
    gridW: p.gridW ?? 60,
    gridH: p.gridH ?? 40,
    scenes: [],
    assets: [],
    prefabs: [],
    packs: Array.isArray(p.packs) ? p.packs : [],
    scripts: normalizeScripts(p.scripts),
    variables: p.variables ?? {},
    masterVolume: typeof p.masterVolume === "number" ? p.masterVolume : 0.8
  };

  const scenes = Array.isArray(p.scenes) && p.scenes.length ? p.scenes : [createScene("场景 1")];
  for (const s of scenes) {
    const sc: SceneModel = {
      id: s.id || uid(),
      name: s.name || "场景",
      originX: s.originX ?? 0,
      originY: s.originY ?? 0,
      widthTiles: s.widthTiles && s.widthTiles > 0 ? s.widthTiles : out.gridW,
      heightTiles: s.heightTiles && s.heightTiles > 0 ? s.heightTiles : out.gridH,
      layers: Array.isArray(s.layers) && s.layers.length ? s.layers : [createLayer("默认")],
      objects: [],
      onStartScript: s.onStartScript ?? "",
      bgmAssetId: s.bgmAssetId ?? ""
    };
    // ★ 开放世界扩展段：**原样透传**，不丢数据。
    //
    // 为什么必须在这里接一手：normalizeProject 是「编辑器加载 .bwproj」的唯一入口，
    // 而它是按字段逐个重建 SceneModel 的 —— 任何没在这张清单里的字段都会被静默丢掉。
    // 生成器产出的 buildings / navLinks / roadNetwork 若被编辑器丢掉，
    // 用户「打开城市 → 随手改一个对象 → 保存」就会把整座城市的多层数据抹掉。
    // 这是真实的「编辑器会吃掉数据」风险，不是理论问题。
    //
    // 这些字段在 SceneModel 上是 optional（见接口定义），旧工程没有 → 不写、不报错。
    const ext = s as unknown as Record<string, unknown>;
    if (ext.buildings !== undefined) (sc as unknown as Record<string, unknown>).buildings = ext.buildings;
    if (ext.navLinks !== undefined) (sc as unknown as Record<string, unknown>).navLinks = ext.navLinks;
    if (ext.roadNetwork !== undefined) (sc as unknown as Record<string, unknown>).roadNetwork = ext.roadNetwork;
    // ★ UI 场景三件套同样必须显式透传：normalizeProject 是「打开 .bwproj」的唯一入口，
    //   漏了这三行 = 用户打开 UI 场景 → 随手改一个字 → 保存，UI 场景就退化成世界场景。
    if (ext.ui === true) (sc as unknown as Record<string, unknown>).ui = true;
    if (typeof ext.designW === "number" && ext.designW > 0) {
      (sc as unknown as Record<string, unknown>).designW = Math.round(ext.designW);
    }
    if (typeof ext.designH === "number" && ext.designH > 0) {
      (sc as unknown as Record<string, unknown>).designH = Math.round(ext.designH);
    }
    const objs = Array.isArray(s.objects) ? s.objects : [];
    for (const o of objs) {
      sc.objects.push({
        id: o.id || uid(),
        name: o.name || "",
        kind: o.kind || "PROP",
        x: o.x ?? 0,
        y: o.y ?? 0,
        z: o.z ?? 0,
        rotation: o.rotation ?? 0,
        scaleX: typeof o.scaleX === "number" ? o.scaleX : 1,
        scaleY: typeof o.scaleY === "number" ? o.scaleY : 1,
        halfW: o.halfW ?? 0,
        halfH: o.halfH ?? 0,
        layerId: o.layerId || sc.layers[sc.layers.length - 1].id,
        visible: o.visible !== false,
        locked: o.locked === true,
        assetId: o.assetId ?? "",
        animMode: o.animMode ?? "默认",
        animFps: o.animFps ?? 8,
        modules: Array.isArray(o.modules)
          ? o.modules.map((m) => ({
            defId: m.defId,
            label: m.label,
            trigger: m.trigger ?? null,
            values: m.values ?? {},
            enabled: m.enabled !== false,
            collapsed: m.collapsed !== false
          }))
          : [],
        props: o.props ?? {},
        tags: Array.isArray(o.tags) ? o.tags : [],
        parentId: o.parentId ?? null,
        // 旧工程没有这个字段 → null（不来自任何预制体）。有但指向已删预制体也保留，
        // 由面板显示成「链接已失效」，不在这里静默清掉（用户可能只是想先删模板再补回来）。
        prefabId: typeof o.prefabId === "string" && o.prefabId ? o.prefabId : null
      });
    }
    out.scenes.push(sc);
  }

  const assets = Array.isArray(p.assets) ? p.assets : [];
  const seen = new Set<string>();
  for (const a of assets) {
    if (!a || !a.id || seen.has(a.id)) continue;
    seen.add(a.id);
    out.assets.push({
      id: a.id,
      name: a.name || "素材",
      kind: a.kind || "IMAGE",
      src: a.src === "url" ? "url" : "blob",
      url: a.url,
      path: a.path ?? "",
      headName: a.headName,
      frameCount: a.frameCount,
      cols: a.cols,
      rows: a.rows,
      cellW: a.cellW,
      cellH: a.cellH,
      width: a.width ?? 0,
      height: a.height ?? 0,
      group: a.group || "未分组",
      hiddenFrames: Array.isArray(a.hiddenFrames) ? a.hiddenFrames : [],
      frameDurations: Array.isArray(a.frameDurations) ? a.frameDurations : [],
      note: a.note
    });
  }

  // ---------- 预制体 ----------
  // 旧工程没有 prefabs 字段：补成空数组，打开不报错、保存后字段自动齐全。
  // 逐字段兜底照 scenes / assets 的写法来，宁可给默认值也不让 undefined 漏到面板里。
  const prefabSeen = new Set<string>();
  const prefabNameSeen = new Set<string>();
  for (const raw of Array.isArray(p.prefabs) ? p.prefabs : []) {
    if (!raw || typeof raw !== "object") continue;
    const pf = raw as Partial<PrefabDef>;
    let id = typeof pf.id === "string" && pf.id ? pf.id : uid();
    if (prefabSeen.has(id)) id = uid();
    prefabSeen.add(id);
    // 名字是运行期 spawn 的 key，必须非空且不重名；重名的后来者加序号而不是丢弃。
    let name = typeof pf.name === "string" && pf.name.trim() ? pf.name.trim() : "预制体";
    if (prefabNameSeen.has(name)) {
      let i = 2;
      while (prefabNameSeen.has(`${name} ${i}`)) i++;
      name = `${name} ${i}`;
    }
    prefabNameSeen.add(name);
    out.prefabs.push({
      id,
      name,
      blurb: typeof pf.blurb === "string" ? pf.blurb : "",
      kind: pf.kind || "PROP",
      assetId: typeof pf.assetId === "string" ? pf.assetId : "",
      z: typeof pf.z === "number" ? pf.z : 0,
      layer: typeof pf.layer === "number" ? Math.round(pf.layer) : 0,
      rotation: typeof pf.rotation === "number" ? pf.rotation : 0,
      scaleX: typeof pf.scaleX === "number" ? pf.scaleX : 1,
      scaleY: typeof pf.scaleY === "number" ? pf.scaleY : 1,
      halfW: typeof pf.halfW === "number" ? pf.halfW : 0,
      halfH: typeof pf.halfH === "number" ? pf.halfH : 0,
      animMode: typeof pf.animMode === "string" && pf.animMode ? pf.animMode : "默认",
      animFps: typeof pf.animFps === "number" ? pf.animFps : 8,
      tags: Array.isArray(pf.tags) ? pf.tags.filter((t): t is string => typeof t === "string") : [],
      modules: Array.isArray(pf.modules)
        ? pf.modules
          .filter((m) => m && typeof m === "object")
          .map((m) => ({
            defId: m.defId,
            label: m.label,
            trigger: m.trigger ?? null,
            values: m.values ?? {},
            enabled: m.enabled !== false,
            collapsed: m.collapsed !== false
          }))
        : [],
      props: pf.props && typeof pf.props === "object" ? pf.props : {},
      script: typeof pf.script === "string" ? pf.script : "",
      spawnJitter: {
        x: typeof pf.spawnJitter?.x === "number" ? pf.spawnJitter.x : 0,
        y: typeof pf.spawnJitter?.y === "number" ? pf.spawnJitter.y : 0
      }
    });
  }

  return out;
}

/** 序列帧的有效帧（排除被隐藏的）。 */
export function visibleFrames(a: AssetEntry): number[] {
  const total = totalFrames(a);
  const hidden = new Set(a.hiddenFrames ?? []);
  const out: number[] = [];
  for (let i = 0; i < total; i++) if (!hidden.has(i)) out.push(i);
  return out.length ? out : [0];
}
