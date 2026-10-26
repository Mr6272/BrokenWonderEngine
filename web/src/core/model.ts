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

export type ModuleCategoryId = "move" | "render" | "detect" | "event" | "combat" | "dialogue" | "fx" | "game";

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
    parentId: null
  };
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
        parentId: o.parentId ?? null
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
