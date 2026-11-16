/**
 * projectOps —— AI 唯一的「造世界」写入入口
 *
 * 背景：改造前 AI 只有一条写入通道 `scripts[name].source`，因此它能在运行时
 * spawn 出一个世界，但编辑器画布是空的、策划看不见、Inspector 改不了、AI 自己
 * 也无法校验画面对不对。本模块把 AI 提升为「在结构化工程模型上做原子操作」。
 *
 * 三条纪律（对应仓库既有事故教训）：
 *
 *   1. 一切校验先行。一批操作里任何一项非法，整批拒绝，工程逐字节不变。
 *      不允许「改到第 19 个才发现 assetId 拼错，前 18 个已经落地」。
 *   2. 不可用 != 空结果。引用不存在的场景 / 模块，返回原因码与被拒的具体项，
 *      绝不静默丢弃后返回 success（那会让模型以为它成功了）。
 *   3. 纯函数。接收 project，返回新 project 与结果，不碰任何全局状态。
 *      写入落盘由调用方用一次 commit 完成，天然可撤销。
 */

import type {
  AssetEntry,
  GameObjectKind,
  Layer,
  ModuleInstance,
  PrefabDef,
  Project,
  RulePack,
  SceneModel,
  SceneObject,
  ScriptEntry,
  TriggerId,
} from "./model.ts";
import { UI_DESIGN_H, UI_DESIGN_W, createScene, createUiScene, uid } from "./model.ts";
import { MODULES } from "../data/modules.ts";

// ---------------------------------------------------------------- 操作定义

/** 摆放一个新对象时，AI 只需给意图字段，其余由本模块补全默认值。 */
export interface NewObjectSpec {
  name?: string;
  kind?: GameObjectKind;
  x: number;
  y: number;
  /** 不填则按 kind 推导，见 DEFAULT_HALF */
  halfW?: number;
  halfH?: number;
  assetId?: string;
  layerId?: string;
  tags?: string[];
  z?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  visible?: boolean;
  locked?: boolean;
  props?: Record<string, string>;
  /** 行为模块，装配时逐个过白名单校验 */
  modules?: ModuleInstanceSpec[];
  /** 来自哪个预制体（PrefabDef.id），可选 */
  prefabId?: string | null;
  /**
   * 以下三个是 2026-11-13 补的：原来 NewObjectSpec 里没有它们，
   * 于是「摆一个会动的对象」只能摆完再 updateObjects 一遍 —— 而 updateObjects
   * 当时也改不了这三个字段，等于动画参数与父子关系**AI 根本设不了**。
   */
  animMode?: string;
  animFps?: number;
  parentId?: string | null;
}

export interface ModuleInstanceSpec {
  defId: string;
  label?: string;
  trigger?: TriggerId | null;
  /** 参数键值；键必须在 ModuleDef.params 内，数值在 min..max 内 */
  values?: Record<string, string>;
  enabled?: boolean;
}

export interface NewPrefabSpec {
  name: string;
  kind: GameObjectKind;
  assetId?: string;
  halfW?: number;
  halfH?: number;
  blurb?: string;
  tags?: string[];
  props?: Record<string, string>;
  modules?: ModuleInstanceSpec[];
  /** 对象脚本名；等价于挂一个 script.js 模块并指向该脚本 */
  script?: string;
}

export interface NewSceneSpec {
  name: string;
  /** 普通场景的格子数（对应 SceneModel.widthTiles） */
  widthTiles?: number;
  heightTiles?: number;
  /** UI 场景：单位是设计分辨率像素，走 designW / designH */
  ui?: boolean;
  designW?: number;
  designH?: number;
}

export type ProjectOp =
  // sceneId 与 sceneName 二选一：同一批次里可以先 createScene 再按名字往里放东西
  | { op: "addObjects"; sceneId?: string; sceneName?: string; objects: NewObjectSpec[] }
  | { op: "updateObjects"; sceneId?: string; sceneName?: string; updates: Array<{ id: string; patch: Partial<NewObjectSpec> }> }
  | { op: "deleteObjects"; sceneId?: string; sceneName?: string; ids: string[] }
  | { op: "reorderObjects"; sceneId?: string; sceneName?: string; order: string[] }
  | { op: "definePrefabs"; prefabs: NewPrefabSpec[] }
  | { op: "updatePrefabs"; updates: Array<{ id: string; patch: PrefabPatch }> }
  | { op: "deletePrefabs"; ids: string[] }
  | { op: "attachModules"; sceneId?: string; sceneName?: string; targetId: string; isPrefab?: boolean; modules: ModuleInstanceSpec[] }
  | { op: "detachModules"; sceneId?: string; sceneName?: string; targetId: string; isPrefab?: boolean; defIds: string[] }
  | { op: "patchModules"; sceneId?: string; sceneName?: string; targetId: string; isPrefab?: boolean; patches: ModulePatchSpec[] }
  | { op: "addLayer"; sceneId?: string; sceneName?: string; name: string }
  | { op: "updateLayers"; sceneId?: string; sceneName?: string; updates: Array<{ id: string; patch: LayerPatch }> }
  | { op: "deleteLayers"; sceneId?: string; sceneName?: string; ids: string[] }
  | { op: "createScene"; scene: NewSceneSpec }
  | { op: "updateScene"; sceneId?: string; sceneName?: string; set: ScenePatch }
  | { op: "deleteScene"; sceneId?: string; sceneName?: string }
  | { op: "reorderScenes"; order: string[] }
  | { op: "updateProject"; set: ProjectSettingsPatch }
  | { op: "updateAssets"; updates: Array<{ id: string; patch: AssetPatch }> }
  | { op: "deleteAssets"; ids: string[] }
  | { op: "definePacks"; packs: NewPackSpec[] }
  | { op: "updatePacks"; updates: Array<{ id: string; patch: PackPatch }> }
  | { op: "deletePacks"; ids: string[] }
  | { op: "applyPacks"; sceneId?: string; sceneName?: string; targets: string[]; packIds: string[] }
  | { op: "writeScripts"; scripts: Array<{ path: string; source: string; name?: string; lang?: "js" | "yarn" }> }
  | { op: "deleteScripts"; names: string[] }
  | { op: "setVariables"; variables: Record<string, string> };

/**
 * 全部 op 名（顺序无关，用于 schema 与实现的一致性校验）。
 *
 * 为什么集中在这里而不是从 switch 里推：`ApplyProjectOps` 的 tool schema 里有一份
 * enum 清单，那份和这里的 switch 是**两份数据**。历史上已经断过一次 ——
 * schema 只列了 6 条而实现有 11 条，于是 deletePrefabs / detachModules / addLayer /
 * writeScripts / setVariables 这 5 个能力**模型永远调不到**（用户看到的是"AI 说改不了图层"）。
 * 现在两边都以这份常量为准，`verify-project-ops-ext` 里还有一条断言逐个跑一遍，
 * 确认"列了就必须真能跑"。
 */
export const PROJECT_OP_NAMES = [
  "updateProject",
  "createScene", "updateScene", "deleteScene", "reorderScenes",
  "addLayer", "updateLayers", "deleteLayers",
  "addObjects", "updateObjects", "deleteObjects", "reorderObjects",
  "definePrefabs", "updatePrefabs", "deletePrefabs",
  "attachModules", "detachModules", "patchModules",
  "updateAssets", "deleteAssets",
  "definePacks", "updatePacks", "deletePacks", "applyPacks",
  "writeScripts", "deleteScripts", "setVariables",
] as const;

/** 工程级可改字段。`orientation` 传 `""` 表示清除该字段（回到按宽高比推断）。 */
export interface ProjectSettingsPatch {
  name?: string;
  author?: string;
  tileSize?: number;
  gridW?: number;
  gridH?: number;
  masterVolume?: number;
  orientation?: "portrait" | "landscape" | "";
}

/** 场景可改字段。`""` 一律表示清除。 */
export interface ScenePatch {
  name?: string;
  widthTiles?: number;
  heightTiles?: number;
  originX?: number;
  originY?: number;
  onStartScript?: string;
  bgmAssetId?: string;
  ui?: boolean;
  designW?: number;
  designH?: number;
}

export interface LayerPatch {
  name?: string;
  visible?: boolean;
  locked?: boolean;
  order?: number;
}

/** 预制体可改字段。全字段覆盖 —— 原实现只有 definePrefabs，改不了任何已有的预制体。 */
export interface PrefabPatch {
  name?: string;
  blurb?: string;
  kind?: GameObjectKind;
  assetId?: string;
  z?: number;
  layer?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  halfW?: number;
  halfH?: number;
  animMode?: string;
  animFps?: number;
  tags?: string[];
  props?: Record<string, string>;
  script?: string;
  spawnJitter?: { x: number; y: number };
}

export interface AssetPatch {
  name?: string;
  group?: string;
  note?: string;
  url?: string;
  cols?: number;
  rows?: number;
  cellW?: number;
  cellH?: number;
  frameCount?: number;
  hiddenFrames?: number[];
  frameDurations?: number[];
}

/** 单个模块实例的局部修改：只合并给出的键（这正是 attachModules 干不了的事）。 */
export interface ModulePatchSpec {
  defId: string;
  values?: Record<string, string>;
  trigger?: TriggerId | null;
  enabled?: boolean;
}

export interface NewPackSpec {
  name: string;
  blurb?: string;
  modules: ModuleInstanceSpec[];
  exposed?: Record<string, string>;
  exposedLabel?: Record<string, string>;
}

export interface PackPatch {
  name?: string;
  blurb?: string;
  modules?: ModuleInstanceSpec[];
  exposed?: Record<string, string>;
  exposedLabel?: Record<string, string>;
}

// ---------------------------------------------------------------- 结果类型

export type OpFailureCode =
  | "unknown_scene"
  | "unknown_object"
  | "unknown_prefab"
  | "unknown_module"
  | "unknown_module_instance"
  | "unknown_asset"
  | "unknown_layer"
  | "unknown_script"
  | "unknown_pack"
  | "bad_param"
  | "bad_trigger"
  | "bad_kind"
  | "bad_order"
  | "duplicate_id"
  | "duplicate_name"
  | "empty_name"
  | "bad_coord"
  | "last_scene"
  | "last_layer"
  | "layer_not_empty"
  | "cycle"
  | "asset_in_use"
  | "script_in_use";

export interface OpRejection {
  /** 出问题的操作在批次里的下标，便于模型精确定位 */
  index: number;
  op: string;
  code: OpFailureCode;
  message: string;
  /** 给模型的修复建议，不允许只抛裸错误 */
  hint: string;
}

export interface ProjectOpsResult {
  ok: boolean;
  /** 校验通过并已应用时，返回新工程；否则为 null（原工程未被修改） */
  project: Project | null;
  /** 已应用操作的摘要，例如 "新增 3 个对象到某场景" */
  summary: string[];
  /** 被拒绝的项；ok=false 时必有内容 */
  rejections: OpRejection[];
  /** 受影响的对象 id，便于调用方高亮选中 */
  touchedIds: string[];
}

// ---------------------------------------------------------------- 常量

const DEFAULT_HALF: Record<GameObjectKind, { w: number; h: number }> = {
  ACTOR: { w: 12, h: 16 },
  PROP: { w: 16, h: 16 },
  TILE: { w: 8, h: 8 },
  ZONE: { w: 32, h: 32 },
  SPAWN: { w: 10, h: 10 },
  PORTAL: { w: 14, h: 14 },
  LIGHT: { w: 8, h: 8 },
};

const KINDS: GameObjectKind[] = ["ACTOR", "PROP", "TILE", "ZONE", "SPAWN", "PORTAL", "LIGHT"];

const TRIGGERS: TriggerId[] = [
  "ALWAYS", "ON_START", "ON_CLICK", "ON_TRIGGER_ENTER", "ON_TRIGGER_EXIT",
  "ON_DAMAGE", "ON_DEATH", "ON_TIMER", "ON_INTERACT", "ON_SCENE_START",
  "ON_VARIABLE", "ON_CALLED",
];

// ---------------------------------------------------------------- 校验工具

/** 数值字段的上限。给上限不是为了"防呆"，而是因为超过它的值在引擎里必然出错
 *  （tileSize 上万 = 一格一屏；animFps 240 以上浏览器根本不渲染）。 */
const LIMITS = {
  tileSize: [1, 512],
  grid: [1, 512],
  sceneTiles: [1, 1024],
  design: [16, 8192],
  volume: [0, 1],
  animFps: [0, 240],
  frameCount: [1, 240],
  frameDuration: [10, 5000],
  jitter: [0, 1024],
  order: [-1_000_000, 1_000_000],
} as const;

/** 取一个必填数值并夹在范围内；非法就抛（带可读范围提示）。 */
function num(value: unknown, field: string, range: readonly [number, number], fallbackHint = ""): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Rejection("bad_param", `${field} 必须是数字，收到 ${JSON.stringify(value)}`, fallbackHint || `例：${field}: ${range[0]}`);
  }
  if (n < range[0] || n > range[1]) {
    throw new Rejection(
      "bad_param",
      `${field} 的值 ${n} 超出范围 ${range[0]}..${range[1]}`,
      fallbackHint || `请给 ${range[0]}..${range[1]} 之间的值`,
    );
  }
  return n;
}

/** 取一个必填字符串（去首尾空格）；空则抛。 */
function nonEmpty(value: unknown, field: string, hint: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new Rejection("empty_name", `${field} 不能为空`, hint);
  return s;
}

/**
 * 校验「完整列表」类参数（reorder 用的 order）。
 *
 * 为什么要求完整而不是「把 X 移到第 N 位」：后者在多次操作叠加时极易错位，
 * 而且重放同一条指令结果会变（不幂等）。完整列表重放结果恒定。
 */
function requireFullOrder(order: unknown, expectedIds: string[], what: string): string[] {
  if (!Array.isArray(order)) {
    throw new Rejection("bad_order", `${what} 的 order 必须是字符串数组`, `把全部 ${expectedIds.length} 个 id 按新顺序列一遍`);
  }
  const list = order.map((x) => String(x));
  if (list.length !== expectedIds.length) {
    throw new Rejection(
      "bad_order",
      `${what} 的 order 有 ${list.length} 项，但实际有 ${expectedIds.length} 个`,
      `order 必须是**完整列表**（不能只给要移动的那几个）。现有：${expectedIds.join("、")}`,
    );
  }
  const seen = new Set<string>();
  for (const id of list) {
    if (seen.has(id)) {
      throw new Rejection("bad_order", `${what} 的 order 里有重复项「${id}」`, "每个 id 只能出现一次");
    }
    seen.add(id);
    if (!expectedIds.includes(id)) {
      throw new Rejection(
        "bad_order",
        `${what} 的 order 里有未知项「${id}」`,
        `可用：${expectedIds.join("、")}`,
      );
    }
  }
  return list;
}

/**
 * 沿 parentId 链走一遍，判断「把 childId 的父设成 parentId」会不会成环。
 *
 * @param scene    当前场景（只查同场景内的父子关系 —— 跨场景挂父没有意义）
 * @param childId  被改父的那个对象
 * @param parentId 新的父（null/"" = 挂回根，直接通过）
 */
function assertNoCycle(scene: SceneModel, childId: string, parentId: string | null | undefined): void {
  if (!parentId) return;
  if (parentId === childId) {
    throw new Rejection("cycle", `对象不能把自己设成自己的父`, `换成另一个对象，或传 parentId: null 挂回场景根`);
  }
  let cur: string | null | undefined = parentId;
  let depth = 0;
  while (cur && depth < 64) {
    const node: SceneObject | undefined = scene.objects.find((o) => o.id === cur);
    if (!node) {
      // 链上断了一截：父存在性由调用方单独校验，这里只负责环
      return;
    }
    if (node.id === childId) {
      throw new Rejection(
        "cycle",
        `设成父子会成环：${childId} → … → ${parentId} → ${childId}`,
        `换一个父对象，或先用 parentId: null 解开原来的父子关系`,
      );
    }
    cur = node.parentId ?? null;
    depth++;
  }
  if (depth >= 64) {
    throw new Rejection("cycle", `父子链超过 64 层或已损坏`, `检查现有的 parentId 结构，先解开一部分再挂`);
  }
}

export class Rejection extends Error {
  code: OpFailureCode;
  hint: string;
  constructor(code: OpFailureCode, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function findModule(defId: string) {
  return MODULES.find((m) => m.id === defId);
}

/**
 * 按 ModuleDef 的 ParamDef 把 AI 给的字符串参数夹紧 / 补默认值。
 *
 * `project` 用于校验 ref 类型参数：脚本、剧本、素材必须是工程里真实存在的，
 * 否则运行时那个模块会静默空转——这正是本模块存在的原因，不能放过。
 */
export function normalizeModuleValues(
  defId: string,
  values: Record<string, string> = {},
  project?: Project,
): Record<string, string> {
  const def = findModule(defId);
  if (!def) {
    throw new Rejection(
      "unknown_module",
      `模块 "${defId}" 不存在`,
      `可用模块 id 共 ${MODULES.length} 个，例如 ${MODULES.slice(0, 6).map((m) => m.id).join("、")}；` +
        `不要凭记忆编造 defId，先用 Project_Describe 读取完整目录`,
    );
  }
  const out: Record<string, string> = {};
  // 先铺默认值：拖进场景立刻能跑
  for (const p of def.params) out[p.key] = p.def;

  for (const [k, raw] of Object.entries(values)) {
    const p = def.params.find((x) => x.key === k);
    if (!p) {
      throw new Rejection(
        "bad_param",
        `模块 "${defId}" 没有参数 "${k}"`,
        `该模块的参数是：${def.params.map((x) => x.key).join("、")}`,
      );
    }
    const v = String(raw);
    if (p.type === "num") {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        throw new Rejection("bad_param", `参数 "${k}" 需要数字，收到 "${v}"`, `例：{"${k}": ${p.def}}`);
      }
      const min = p.min ?? -Infinity;
      const max = p.max ?? Infinity;
      if (n < min || n > max) {
        throw new Rejection(
          "bad_param",
          `参数 "${k}" 的值 ${n} 超出范围 ${min}..${max}`,
          `请给 ${min}..${max} 之间的值，默认 ${p.def}${p.unit ? " " + p.unit : ""}`,
        );
      }
      out[k] = String(n);
    } else if (p.type === "pick") {
      if (p.options && p.options.length > 0 && !p.options.includes(v)) {
        throw new Rejection("bad_param", `参数 "${k}" 的值 "${v}" 不是合法选项`, `可选：${p.options.join("、")}`);
      }
      out[k] = v;
    } else if (p.type === "bool") {
      if (["开", "true", "1", "on"].includes(v)) out[k] = "开";
      else if (["关", "false", "0", "off"].includes(v)) out[k] = "关";
      else out[k] = p.def;
    } else if ((p.type === "script" || p.type === "asset") && project) {
      // ParamType 直接就是引用种类：script / asset / tag / obj / text / note
      out[k] = checkRef(project, k, v, p.type);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 校验引用型参数。空串合法（表示"不选"），非空必须是工程里真实存在的对象。 */
function checkRef(project: Project, key: string, value: string, refKind: string): string {
  const v = String(value ?? "");
  if (!v) return v;

  if (refKind.includes("script")) {
    // 脚本以 name 为键（ScriptEntry.name），也允许传 file 路径
    const hit = project.scripts[v] ?? Object.values(project.scripts).find((s) => s.file === v || s.file === `Scripts/${v}`);
    if (!hit) {
      throw new Rejection(
        "bad_param",
        `参数 "${key}" 引用的脚本 "${v}" 不存在`,
        `现有脚本：${Object.keys(project.scripts).join("、") || "无"}；` +
          `需要新脚本就在同一批次里先用 writeScripts 写入，再接这里`,
      );
    }
    return hit.name;
  }

  if (refKind.includes("asset")) {
    if (!project.assets.some((a) => a.id === v)) {
      throw new Rejection(
        "bad_param",
        `参数 "${key}" 引用的素材 "${v}" 不存在`,
        `共 ${project.assets.length} 个素材；先用 Project_Describe 读取素材 id`,
      );
    }
    return v;
  }

  // 剧本 / 其它：工程里没有剧本注册表时放行，只做非空校验
  return v;
}

export function normalizeModules(specs: ModuleInstanceSpec[] = [], project?: Project): ModuleInstance[] {
  return specs.map((s) => {
    const def = findModule(s.defId);
    if (!def) normalizeModuleValues(s.defId, s.values, project); // 必抛 Rejection
    const trigger = s.trigger ?? null;
    if (trigger && !TRIGGERS.includes(trigger)) {
      throw new Rejection("bad_trigger", `触发时机 "${trigger}" 不存在`, `可选：${TRIGGERS.join("、")}`);
    }
    if (trigger && def && def.triggers.length > 0 && !def.triggers.includes(trigger)) {
      throw new Rejection(
        "bad_trigger",
        `模块 "${s.defId}" 不支持触发时机 "${trigger}"`,
        `该模块支持的触发时机：${def.triggers.join("、")}`,
      );
    }
    return {
      defId: s.defId,
      label: s.label,
      trigger,
      values: normalizeModuleValues(s.defId, s.values, project),
      enabled: s.enabled ?? true,
      collapsed: true,
    } satisfies ModuleInstance;
  });
}

function requireScene(project: Project, sceneId: string): SceneModel {
  const sc = project.scenes.find((s) => s.id === sceneId);
  if (!sc) {
    throw new Rejection(
      "unknown_scene",
      `场景 "${sceneId}" 不存在`,
      `现有场景：${project.scenes.map((s) => `${s.id}(${s.name})`).join("、") || "无"}；` +
        `需要新场景就先用 createScene`,
    );
  }
  return sc;
}

/**
 * 按 id 或名字定位场景。名字通道是为了让「同一批里先建场景、再往里摆东西」
 * 成为可能——模型在生成计划时无法预知 uid()。
 */
function resolveScene(project: Project, sceneId?: string, sceneName?: string): SceneModel {
  if (sceneId) return requireScene(project, sceneId);
  if (sceneName) {
    const sc = project.scenes.find((s) => s.name === sceneName);
    if (!sc) {
      throw new Rejection(
        "unknown_scene",
        `场景名 "${sceneName}" 不存在`,
        `现有场景：${project.scenes.map((s) => s.name).join("、") || "无"}；先 createScene 再按名字引用`,
      );
    }
    return sc;
  }
  throw new Rejection("unknown_scene", "该操作没有指定场景", "给 sceneId，或给 sceneName");
}

function requireObject(scene: SceneModel, id: string): SceneObject {
  const o = scene.objects.find((x) => x.id === id);
  if (!o) {
    throw new Rejection(
      "unknown_object",
      `「${scene.name}」里没有对象 "${id}"`,
      `该场景现有 ${scene.objects.length} 个对象；先用 Project_Describe 读取对象 id 再引用`,
    );
  }
  return o;
}

function resolveLayer(scene: SceneModel, layerId: string | undefined): string {
  if (!layerId) return scene.layers[0]?.id ?? "";
  if (!scene.layers.some((l) => l.id === layerId)) {
    throw new Rejection(
      "unknown_layer",
      `图层 "${layerId}" 不存在于「${scene.name}」`,
      `现有图层：${scene.layers.map((l) => `${l.id}(${l.name})`).join("、")}`,
    );
  }
  return layerId;
}

function resolveAsset(project: Project, assetId: string | undefined): string {
  if (!assetId) return "";
  if (!project.assets.some((a) => a.id === assetId)) {
    throw new Rejection(
      "unknown_asset",
      `素材 "${assetId}" 不存在`,
      `共 ${project.assets.length} 个素材；先用 Project_Describe 读取素材 id，不要编造`,
    );
  }
  return assetId;
}

/** 校验脚本名存在（空串合法 = 不引用）。 */
function resolveScript(project: Project, name: string | undefined): string {
  const v = String(name ?? "").trim();
  if (!v) return "";
  if (!project.scripts[v]) {
    throw new Rejection(
      "unknown_script",
      `脚本「${v}」不存在`,
      `现有脚本：${Object.keys(project.scripts).join("、") || "无"}；` +
        `需要新脚本就在同一批次里先用 writeScripts 写入，再接这里`,
    );
  }
  return v;
}

/**
 * 找出某个素材被谁引用。
 *
 * 为什么要扫全工程而不是只看某处：用户和模型都不知道「这个图还被谁用着」，
 * 而删掉被引用的素材会让对象变成空白 —— 那种坏法在编辑器里**看不出来**
 * （对象框还在，只是画不出图），要等试跑才发现。
 */
function assetUsages(project: Project, assetId: string): string[] {
  const out: string[] = [];
  for (const sc of project.scenes) {
    if (sc.bgmAssetId === assetId) out.push(`场景「${sc.name}」的背景音乐`);
    for (const o of sc.objects) {
      if (o.assetId === assetId) out.push(`场景「${sc.name}」的对象「${o.name}」`);
    }
  }
  for (const pf of project.prefabs) {
    if (pf.assetId === assetId) out.push(`预制体「${pf.name}」`);
  }
  return out;
}

/** 找出某个脚本被谁引用（场景入口 / 对象的 script.js 模块 / 预制体的 script 字段）。 */
function scriptUsages(project: Project, scriptName: string): string[] {
  const out: string[] = [];
  for (const sc of project.scenes) {
    if (sc.onStartScript === scriptName) out.push(`场景「${sc.name}」的场景脚本`);
    for (const o of sc.objects) {
      for (const m of o.modules ?? []) {
        if (m.defId === "script.js" && m.values?.script === scriptName) {
          out.push(`场景「${sc.name}」的对象「${o.name}」的脚本模块`);
        }
      }
    }
  }
  for (const pf of project.prefabs) {
    if (pf.script === scriptName) out.push(`预制体「${pf.name}」`);
    for (const m of pf.modules ?? []) {
      if (m.defId === "script.js" && m.values?.script === scriptName) {
        out.push(`预制体「${pf.name}」的脚本模块`);
      }
    }
  }
  return out;
}

/**
 * 把一条 `ModuleInstanceSpec` 应用到已有模块实例上（覆盖并集）。
 *
 * 与 `normalizeModules` 的差别：后者从零构造（未给的参数补默认值），
 * 这里是在**已有实例**上打补丁（未给的参数保持原值）。attachModules 用前者，
 * patchModules 用后者 —— 混用会让「只改一个参数」变成「其余参数被重置」。
 */
function mergeModulePatch(
  inst: ModuleInstance,
  patch: ModulePatchSpec,
  project: Project,
): ModuleInstance {
  const def = findModule(inst.defId);
  if (!def) {
    throw new Rejection("unknown_module", `模块「${inst.defId}」不存在`, "先用 Project_Describe 读取模块目录");
  }
  const next: ModuleInstance = {
    defId: inst.defId,
    label: inst.label,
    trigger: inst.trigger ?? null,
    values: { ...inst.values },
    enabled: inst.enabled,
    collapsed: inst.collapsed,
  };

  if (patch.values !== undefined) {
    for (const [k, raw] of Object.entries(patch.values)) {
      const p = def.params.find((x) => x.key === k);
      if (!p) {
        throw new Rejection(
          "bad_param",
          `模块「${inst.defId}」没有参数「${k}」`,
          `该模块的参数是：${def.params.map((x) => x.key).join("、") || "无"}`,
        );
      }
      const v = String(raw);
      if (p.type === "num") {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          throw new Rejection("bad_param", `参数「${k}」需要数字，收到「${v}」`, `例：{"${k}": ${p.def}}`);
        }
        const min = p.min ?? -Infinity;
        const max = p.max ?? Infinity;
        if (n < min || n > max) {
          throw new Rejection("bad_param", `参数「${k}」的值 ${n} 超出范围 ${min}..${max}`, `请给 ${min}..${max} 之间的值，默认 ${p.def}`);
        }
        next.values[k] = String(n);
      } else if (p.type === "pick") {
        if (p.options && p.options.length > 0 && !p.options.includes(v)) {
          throw new Rejection("bad_param", `参数「${k}」的值「${v}」不是合法选项`, `可选：${p.options.join("、")}`);
        }
        next.values[k] = v;
      } else if (p.type === "bool") {
        if (["开", "true", "1", "on"].includes(v)) next.values[k] = "开";
        else if (["关", "false", "0", "off"].includes(v)) next.values[k] = "关";
        else next.values[k] = p.def;
      } else if (p.type === "script") {
        next.values[k] = resolveScript(project, v);
      } else if (p.type === "asset") {
        next.values[k] = resolveAsset(project, v);
      } else {
        next.values[k] = v;
      }
    }
  }

  if (patch.trigger !== undefined) {
    const t = patch.trigger;
    if (t === null) {
      next.trigger = null;
    } else if (!TRIGGERS.includes(t)) {
      throw new Rejection("bad_trigger", `触发时机「${String(t)}」不存在`, `可选：${TRIGGERS.join("、")}`);
    } else if (def.triggers.length > 0 && !def.triggers.includes(t)) {
      throw new Rejection(
        "bad_trigger",
        `模块「${inst.defId}」不支持触发时机「${t}」`,
        `该模块支持的触发时机：${def.triggers.join("、")}`,
      );
    } else {
      next.trigger = t;
    }
  }

  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  return next;
}

/** 解析「对象或预制体」二选一的目标，返回它的模块数组（供 patchModules / attach 复用）。 */
function targetModules(
  project: Project,
  op: { sceneId?: string; sceneName?: string; targetId: string; isPrefab?: boolean },
): { list: ModuleInstance[]; label: string; id: string } {
  if (op.isPrefab) {
    const pf = project.prefabs.find((p) => p.id === op.targetId);
    if (!pf) {
      throw new Rejection(
        "unknown_prefab",
        `预制体 "${op.targetId}" 不存在`,
        `现有预制体：${project.prefabs.map((p) => `${p.id}(${p.name})`).join("、") || "无"}`,
      );
    }
    return { list: pf.modules ?? [], label: `预制体「${pf.name}」`, id: pf.id };
  }
  const scene = resolveScene(project, op.sceneId, op.sceneName);
  const o = requireObject(scene, op.targetId);
  return { list: o.modules ?? [], label: `「${o.name}」`, id: o.id };
}

function checkKind(kind: unknown): GameObjectKind {
  if (typeof kind !== "string" || !KINDS.includes(kind as GameObjectKind)) {
    throw new Rejection("bad_kind", `对象类型 "${String(kind)}" 不存在`, `可选：${KINDS.join("、")}`);
  }
  return kind as GameObjectKind;
}

// ---------------------------------------------------------------- 对象构造

function makeObject(project: Project, scene: SceneModel, spec: NewObjectSpec): SceneObject {
  const kind = checkKind(spec.kind ?? "PROP");
  if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y)) {
    throw new Rejection("bad_coord", `坐标必须是数字，收到 (${spec.x}, ${spec.y})`, `例：{"x": 64, "y": 96}`);
  }
  const half = DEFAULT_HALF[kind];
  const name = (spec.name ?? "").trim();
  if (!name) {
    throw new Rejection("empty_name", "对象缺少 name", `给一个中文可读名字，例："巡夜守卫"`);
  }
  return {
    id: uid(),
    name,
    kind,
    x: spec.x,
    y: spec.y,
    z: spec.z ?? 0,
    halfW: spec.halfW ?? half.w,
    halfH: spec.halfH ?? half.h,
    rotation: spec.rotation ?? 0,
    scaleX: spec.scaleX ?? 1,
    scaleY: spec.scaleY ?? 1,
    visible: spec.visible ?? true,
    locked: spec.locked ?? false,
    assetId: resolveAsset(project, spec.assetId),
    animMode: spec.animMode !== undefined ? nonEmpty(spec.animMode, "animMode", `例：static / loop`) : "static",
    animFps: spec.animFps !== undefined ? num(spec.animFps, "animFps", LIMITS.animFps) : 0,
    layerId: resolveLayer(scene, spec.layerId),
    tags: spec.tags ?? [],
    props: spec.props ?? {},
    modules: normalizeModules(spec.modules, project),
    prefabId: spec.prefabId ?? null,
    parentId: spec.parentId ?? null,
  } satisfies SceneObject;
}

// ---------------------------------------------------------------- 主流程

/**
 * 校验并应用一批操作。
 *
 * 实现上是「先在深拷贝上跑完整批，全绿才返回」。这样调用方拿到 project 时，
 * 要么是一批全部生效的世界，要么是原封不动的世界，没有中间态。
 */
export function applyProjectOps(project: Project, ops: ProjectOp[]): ProjectOpsResult {
  const rejections: OpRejection[] = [];
  const summary: string[] = [];
  const touchedIds: string[] = [];

  // 空批次是「无事可做」，不是「做错了」。
  // 这条区别很实在：离线规划器识不出意图时会返回空 ops，若这里判成失败，
  // 「AI 没听懂」就会被渲染成「执行出错」，用户会去查一个不存在的 bug。
  // 所以空批次成功返回原工程（同一个引用，零拷贝、零副作用）。
  if (!Array.isArray(ops)) {
    return {
      ok: false,
      project: null,
      summary: [],
      rejections: [{ index: -1, op: "-", code: "bad_param", message: "ops 不是数组", hint: "ops 必须是 ProjectOp[]" }],
      touchedIds: [],
    };
  }
  if (ops.length === 0) {
    return { ok: true, project, summary: [], rejections: [], touchedIds: [] };
  }

  // 深拷贝：校验与试应用都在副本上进行，原工程不可能被污染
  const draft: Project = JSON.parse(JSON.stringify(project));

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      applyOne(draft, op, summary, touchedIds);
    } catch (e) {
      if (e instanceof Rejection) {
        rejections.push({ index: i, op: (op as { op?: string }).op ?? "?", code: e.code, message: e.message, hint: e.hint });
      } else {
        rejections.push({
          index: i,
          op: (op as { op?: string }).op ?? "?",
          code: "bad_param",
          message: (e as Error)?.message ?? String(e),
          hint: "检查该操作的字段名与类型是否与工具 schema 一致",
        });
      }
    }
  }

  if (rejections.length > 0) {
    // 整批拒绝：不返回任何半成品
    return { ok: false, project: null, summary: [], rejections, touchedIds: [] };
  }

  return { ok: true, project: draft, summary, rejections: [], touchedIds };
}

function applyOne(draft: Project, op: ProjectOp, summary: string[], touchedIds: string[]): void {
  switch (op.op) {
    case "addObjects": {
      const scene = resolveScene(draft, op.sceneId, op.sceneName);
      const made: SceneObject[] = [];
      for (const spec of op.objects) made.push(makeObject(draft, scene, spec));
      scene.objects.push(...made);
      touchedIds.push(...made.map((o) => o.id));
      summary.push(`在「${scene.name}」新增 ${made.length} 个对象：${made.map((o) => o.name).join("、")}`);
      return;
    }

    case "updateObjects": {
      const scene = resolveScene(draft, op.sceneId, op.sceneName);
      for (const u of op.updates) {
        const o = requireObject(scene, u.id);
        const p = u.patch;
        if (p.name !== undefined) {
          const n = String(p.name).trim();
          if (!n) throw new Rejection("empty_name", `对象 ${u.id} 的 name 不能为空`, "给回原来的名字或一个新的中文名");
          o.name = n;
        }
        if (p.x !== undefined) {
          if (!Number.isFinite(p.x)) throw new Rejection("bad_coord", "x 必须是数字", `例：x: 64`);
          o.x = p.x;
        }
        if (p.y !== undefined) {
          if (!Number.isFinite(p.y)) throw new Rejection("bad_coord", "y 必须是数字", `例：y: 96`);
          o.y = p.y;
        }
        if (p.halfW !== undefined) o.halfW = p.halfW;
        if (p.halfH !== undefined) o.halfH = p.halfH;
        if (p.z !== undefined) o.z = p.z;
        if (p.rotation !== undefined) o.rotation = p.rotation;
        if (p.scaleX !== undefined) o.scaleX = p.scaleX;
        if (p.scaleY !== undefined) o.scaleY = p.scaleY;
        if (p.visible !== undefined) o.visible = p.visible;
        if (p.locked !== undefined) o.locked = p.locked;
        if (p.assetId !== undefined) o.assetId = resolveAsset(draft, p.assetId);
        if (p.layerId !== undefined) o.layerId = resolveLayer(scene, p.layerId);
        if (p.tags !== undefined) o.tags = p.tags;
        if (p.props !== undefined) o.props = { ...o.props, ...p.props };
        if (p.prefabId !== undefined) {
          if (p.prefabId) {
            if (!draft.prefabs.some((x) => x.id === p.prefabId)) {
              throw new Rejection(
                "unknown_prefab",
                `预制体「${p.prefabId}」不存在`,
                `现有预制体：${draft.prefabs.map((x) => `${x.id}(${x.name})`).join("、") || "无"}`,
              );
            }
            o.prefabId = p.prefabId;
          } else {
            o.prefabId = null; // 空串/null = 断开预制体链接
          }
        }
        // ---- 2026-11-13 补：动画与父子关系（原来这三个字段完全改不了）----
        if (p.animMode !== undefined) o.animMode = nonEmpty(p.animMode, "animMode", `例：static / loop`);
        if (p.animFps !== undefined) o.animFps = num(p.animFps, "animFps", LIMITS.animFps);
        if (p.parentId !== undefined) {
          const raw = p.parentId;
          if (raw === null || raw === "") {
            o.parentId = null; // 挂回场景根
          } else {
            const pid = String(raw);
            if (!scene.objects.some((x) => x.id === pid)) {
              throw new Rejection(
                "unknown_object",
                `父对象「${pid}」不存在于「${scene.name}」`,
                `父必须在同一个场景内；现有对象：${scene.objects.slice(0, 10).map((x) => x.id).join("、")}…`,
              );
            }
            // 成环检查必须在赋值**之前**：赋值后再查会把自己也算进链里
            assertNoCycle(scene, o.id, pid);
            o.parentId = pid;
          }
        }
        touchedIds.push(o.id);
      }
      summary.push(`更新「${scene.name}」${op.updates.length} 个对象`);
      return;
    }

    case "deleteObjects": {
      const scene = resolveScene(draft, op.sceneId, op.sceneName);
      // 先全部确认存在，再统一删，避免删了两个发现第三个不存在
      for (const id of op.ids) requireObject(scene, id);
      const before = scene.objects.length;
      scene.objects = scene.objects.filter((o) => !op.ids.includes(o.id));
      summary.push(`从「${scene.name}」删除 ${before - scene.objects.length} 个对象`);
      return;
    }

    case "definePrefabs": {
      const made: PrefabDef[] = [];
      for (const spec of op.prefabs) {
        const name = (spec.name ?? "").trim();
        if (!name) throw new Rejection("empty_name", "预制体缺少 name", `给一个中文可读名字，例："箭塔"`);
        const kind = checkKind(spec.kind);
        const half = DEFAULT_HALF[kind];
        made.push({
          id: `pf_${uid()}`,
          name,
          blurb: spec.blurb ?? "",
          kind,
          assetId: resolveAsset(draft, spec.assetId),
          z: 0,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          halfW: spec.halfW ?? half.w,
          halfH: spec.halfH ?? half.h,
          animMode: "static",
          animFps: 0,
          tags: spec.tags ?? [],
          modules: normalizeModules(spec.modules, draft),
          props: spec.props ?? {},
          script: spec.script ?? "",
          spawnJitter: { x: 0, y: 0 },
        } satisfies PrefabDef);
      }
      draft.prefabs.push(...made);
      touchedIds.push(...made.map((p) => p.id));
      summary.push(`定义 ${made.length} 个预制体：${made.map((p) => p.name).join("、")}`);
      return;
    }

    case "deletePrefabs": {
      for (const id of op.ids) {
        if (!draft.prefabs.some((p) => p.id === id)) {
          throw new Rejection(
            "unknown_prefab",
            `预制体 "${id}" 不存在`,
            `现有预制体：${draft.prefabs.map((p) => `${p.id}(${p.name})`).join("、") || "无"}`,
          );
        }
      }
      const before = draft.prefabs.length;
      draft.prefabs = draft.prefabs.filter((p) => !op.ids.includes(p.id));
      summary.push(`删除 ${before - draft.prefabs.length} 个预制体`);
      return;
    }

    case "attachModules": {
      const mods = normalizeModules(op.modules, draft);
      if (op.isPrefab) {
        const pf = draft.prefabs.find((p) => p.id === op.targetId);
        if (!pf) throw new Rejection("unknown_prefab", `预制体 "${op.targetId}" 不存在`, "先用 Project_Describe 读取预制体 id");
        for (const m of mods) {
          // 同 defId 的模块重复挂会互相抢控制权，覆盖而不是叠加
          const at = pf.modules.findIndex((x) => x.defId === m.defId);
          if (at >= 0) pf.modules[at] = m;
          else pf.modules.push(m);
        }
        touchedIds.push(pf.id);
        summary.push(`给预制体「${pf.name}」装配 ${mods.length} 个模块：${mods.map((m) => m.defId).join("、")}`);
      } else {
        // 用 resolveScene（id 或名字二选一），与其它 op 保持一致。
        // 原来这里只认 sceneId：ai 按场景名传时 op.sceneId 是 undefined，
        // 拼成 "" 直接报「场景 "" 不存在」—— 而 schema 里明明写着 sceneName 可用。
        const scene = resolveScene(draft, op.sceneId, op.sceneName);
        const o = requireObject(scene, op.targetId);
        for (const m of mods) {
          const at = o.modules.findIndex((x) => x.defId === m.defId);
          if (at >= 0) o.modules[at] = m;
          else o.modules.push(m);
        }
        touchedIds.push(o.id);
        summary.push(`给「${o.name}」装配 ${mods.length} 个模块：${mods.map((m) => m.defId).join("、")}`);
      }
      return;
    }

    case "detachModules": {
      const strip = (list: ModuleInstance[]) => list.filter((m) => !op.defIds.includes(m.defId));
      if (op.isPrefab) {
        const pf = draft.prefabs.find((p) => p.id === op.targetId);
        if (!pf) throw new Rejection("unknown_prefab", `预制体 "${op.targetId}" 不存在`, "先用 Project_Describe 读取预制体 id");
        pf.modules = strip(pf.modules);
        touchedIds.push(pf.id);
        summary.push(`从预制体「${pf.name}」移除 ${op.defIds.length} 个模块`);
      } else {
        // 用 resolveScene（id 或名字二选一），与其它 op 保持一致。
        // 原来这里只认 sceneId：ai 按场景名传时 op.sceneId 是 undefined，
        // 拼成 "" 直接报「场景 "" 不存在」—— 而 schema 里明明写着 sceneName 可用。
        const scene = resolveScene(draft, op.sceneId, op.sceneName);
        const o = requireObject(scene, op.targetId);
        o.modules = strip(o.modules);
        touchedIds.push(o.id);
        summary.push(`从「${o.name}」移除 ${op.defIds.length} 个模块`);
      }
      return;
    }

    case "addLayer": {
      const scene = resolveScene(draft, op.sceneId, op.sceneName);
      const name = (op.name ?? "").trim();
      if (!name) throw new Rejection("empty_name", "图层缺少 name", `例："装饰层"`);
      const layer = {
        id: `l_${uid()}`,
        name,
        visible: true,
        locked: false,
        order: scene.layers.length,
      } satisfies Layer;
      scene.layers.push(layer);
      summary.push(`在「${scene.name}」新增图层「${name}」`);
      return;
    }

    case "createScene": {
      const spec = op.scene;
      const name = (spec.name ?? "").trim();
      if (!name) throw new Rejection("empty_name", "场景缺少 name", `给一个中文可读名字，例："第二关 · 哨站"`);
      if (draft.scenes.some((s) => s.name === name)) {
        throw new Rejection("duplicate_id", `场景名「${name}」已存在`, `现有场景：${draft.scenes.map((s) => s.name).join("、")}；换一个名字`);
      }
      // 必须走引擎自己的工厂，而不是手拼字段：图层结构、兜底格数换算
      // （设计分辨率 / 32）都写在工厂里，手拼迟早跟手动新建的不一致。
      // UI 场景还有自己的工厂 createUiScene —— 它给的图层是
      // 背景/界面/浮层，跟世界场景的地形/物件/角色不是一回事。
      const scene =
        spec.ui === true
          ? createUiScene(name, spec.designW ?? UI_DESIGN_W, spec.designH ?? UI_DESIGN_H)
          : createScene(name, spec.widthTiles ?? 32, spec.heightTiles ?? 24);
      draft.scenes.push(scene);
      touchedIds.push(scene.id);
      summary.push(
        spec.ui === true
          ? `新建 UI 场景「${name}」(${scene.designW}×${scene.designH} 设计分辨率)`
          : `新建场景「${name}」(${scene.widthTiles}×${scene.heightTiles} 格)`,
      );
      return;
    }

    case "writeScripts": {
      for (const s of op.scripts) {
        const path = String(s.path ?? "").trim();
        if (!path) throw new Rejection("empty_name", "脚本缺少 path", `例："Scripts/guard.js"`);
        const file = path.startsWith("Scripts/") ? path : `Scripts/${path}`;
        /**
         * `lang` 的推断规则必须与 model.ts 的 `scriptLang` 一致（缺省 = yarn）：
         * 这里漏写 lang，写出来的 JS 脚本会被当成 Yarn 剧本，
         * 表现在「脚本能保存但运行期一行都不执行」——原来就是这个 bug。
         */
        const inferred: "js" | "yarn" =
          s.lang === "js" || s.lang === "yarn"
            ? s.lang
            : /\.jsx?$/i.test(file)
              ? "js"
              : "yarn";
        const entry: ScriptEntry = {
          name: s.name ?? file.replace(/^Scripts\//, "").replace(/\.(js|yarn)$/i, ""),
          file,
          source: String(s.source ?? ""),
          lang: inferred,
        };
        draft.scripts[entry.name] = entry;
        summary.push(`写入脚本「${entry.name}」(${inferred} · ${entry.source.split("\n").length} 行)`);
      }
      return;
    }

    case "setVariables": {
      for (const [k, v] of Object.entries(op.variables)) {
        if (!k.trim()) throw new Rejection("empty_name", "变量名不能为空", `例：{"gold": "0"}`);
        draft.variables[k] = String(v);
      }
      summary.push(`设置 ${Object.keys(op.variables).length} 个工程变量`);
      return;
    }

    // ======================================================================
    // 以下为「Agent 能改工程里任意东西」的扩展（2026-11-13）
    //
    // 设计原则：每一条都回答「原来改不了什么」，而不是「再加个字段」。
    // 凡是 delete*，都必须先算清「删了之后会坏掉什么引用」——
    // 静默删掉被引用的素材/脚本，后果比操作失败严重得多（编辑器里还看不出来）。
    // ======================================================================

    case "updateProject": {
      const set = op.set ?? {};
      if (set.name !== undefined) draft.name = nonEmpty(set.name, "工程名", `例：{"name": "我的游戏"}`);
      if (set.author !== undefined) draft.author = String(set.author);
      if (set.tileSize !== undefined) draft.tileSize = num(set.tileSize, "tileSize", LIMITS.tileSize, "俯视角常用 16 / 32 / 48");
      if (set.gridW !== undefined) draft.gridW = num(set.gridW, "gridW", LIMITS.grid, "例：60");
      if (set.gridH !== undefined) draft.gridH = num(set.gridH, "gridH", LIMITS.grid, "例：40");
      if (set.masterVolume !== undefined) draft.masterVolume = num(set.masterVolume, "masterVolume", LIMITS.volume, "0 = 静音，1 = 满音量");
      if (set.orientation !== undefined) {
        const o = String(set.orientation);
        if (o === "") delete draft.orientation; // 空串 = 清除（回到按宽高比推断）
        else if (o === "portrait" || o === "landscape") draft.orientation = o;
        else throw new Rejection("bad_param", `orientation 只能是 portrait / landscape / ""（清除）`, `收到「${o}」`);
      }
      // ⚠ 必须说清 gridW/gridH 不会动已有场景：模型很容易以为"改了 gridW 关卡就变大了"，
      //   而实际关卡尺寸是 SceneModel.widthTiles —— 那是 updateScene 的事。
      summary.push(
        `改工程设置：${Object.keys(set).join("、")}` +
          (set.gridW !== undefined || set.gridH !== undefined
            ? "（注意 gridW/gridH 只是工程默认值，不改变已有场景尺寸；改场景用 updateScene）"
            : ""),
      );
      return;
    }

    case "updateScene": {
      const scene = resolveScene(draft, op.sceneId, op.sceneName);
      const set = op.set ?? {};
      if (set.name !== undefined) {
        const n = nonEmpty(set.name, "场景名", `例：{"name": "第二关"}`);
        if (draft.scenes.some((s) => s !== scene && s.name === n)) {
          throw new Rejection(
            "duplicate_name",
            `场景名「${n}」已被占用`,
            `现有场景：${draft.scenes.map((s) => s.name).join("、")}`,
          );
        }
        scene.name = n;
      }
      if (set.widthTiles !== undefined) scene.widthTiles = num(set.widthTiles, "widthTiles", LIMITS.sceneTiles);
      if (set.heightTiles !== undefined) scene.heightTiles = num(set.heightTiles, "heightTiles", LIMITS.sceneTiles);
      if (set.originX !== undefined) scene.originX = num(set.originX, "originX", [-1e6, 1e6]);
      if (set.originY !== undefined) scene.originY = num(set.originY, "originY", [-1e6, 1e6]);
      if (set.onStartScript !== undefined) scene.onStartScript = resolveScript(draft, set.onStartScript);
      if (set.bgmAssetId !== undefined) {
        const id = String(set.bgmAssetId ?? "");
        if (!id) scene.bgmAssetId = "";
        else {
          const asset = draft.assets.find((a) => a.id === id);
          if (!asset) {
            throw new Rejection("unknown_asset", `素材「${id}」不存在`, `共 ${draft.assets.length} 个素材；先用 Project_Describe 读 id`);
          }
          if (asset.kind !== "AUDIO") {
            throw new Rejection(
              "bad_param",
              `场景 bgm 必须是音频素材，而「${asset.name}」是 ${asset.kind}`,
              `选 kind=AUDIO 的素材；现有音频：${draft.assets.filter((a) => a.kind === "AUDIO").map((a) => `${a.id}(${a.name})`).join("、") || "无"}`,
            );
          }
          scene.bgmAssetId = id;
        }
      }
      if (set.ui !== undefined) {
        if (set.ui === true) {
          scene.ui = true;
          // 转 UI 场景必须补设计分辨率，否则运行时拿不到映射基准
          if (scene.designW === undefined) scene.designW = UI_DESIGN_W;
          if (scene.designH === undefined) scene.designH = UI_DESIGN_H;
        } else {
          delete scene.ui;
          delete scene.designW;
          delete scene.designH;
        }
      }
      if (set.designW !== undefined) scene.designW = num(set.designW, "designW", LIMITS.design);
      if (set.designH !== undefined) scene.designH = num(set.designH, "designH", LIMITS.design);
      touchedIds.push(scene.id);
      summary.push(`改场景「${scene.name}」：${Object.keys(set).join("、")}`);
      return;
    }

    case "deleteScene": {
      if (draft.scenes.length <= 1) {
        throw new Rejection(
          "last_scene",
          "不能删除最后一个场景（工程至少要有一个场景）",
          `需要换关卡就先 createScene 建好新的，再删旧的`,
        );
      }
      const scene = resolveScene(draft, op.sceneId, op.sceneName);
      draft.scenes = draft.scenes.filter((s) => s !== scene);
      summary.push(`删除场景「${scene.name}」`);
      return;
    }

    case "reorderScenes": {
      const ids = draft.scenes.map((s) => s.id);
      const names = draft.scenes.map((s) => s.name);
      // order 允许写 id 或名字（模型手上可能只有名字）
      const resolved = (op.order ?? []).map((x) => {
        const key = String(x);
        const byId = draft.scenes.find((s) => s.id === key);
        if (byId) return byId.id;
        const byName = draft.scenes.find((s) => s.name === key);
        if (byName) return byName.id;
        return key; // 未知项留给 requireFullOrder 报错
      });
      const ordered = requireFullOrder(resolved, ids, "场景");
      const map = new Map(draft.scenes.map((s) => [s.id, s]));
      draft.scenes = ordered.map((id) => map.get(id)!);
      void names;
      summary.push(`重排 ${ordered.length} 个场景，新顺序：${draft.scenes.map((s) => s.name).join(" → ")}`);
      return;
    }

    case "updateLayers": {
      const scene = resolveScene(draft, op.sceneId, op.sceneName);
      for (const u of op.updates ?? []) {
        const layer = scene.layers.find((l) => l.id === u.id);
        if (!layer) {
          throw new Rejection(
            "unknown_layer",
            `「${scene.name}」里没有图层「${u.id}」`,
            `现有图层：${scene.layers.map((l) => `${l.id}(${l.name})`).join("、")}`,
          );
        }
        const p = u.patch ?? {};
        if (p.name !== undefined) layer.name = nonEmpty(p.name, "图层名", `例：{"name": "装饰层"}`);
        if (p.visible !== undefined) layer.visible = p.visible === true;
        if (p.locked !== undefined) layer.locked = p.locked === true;
        if (p.order !== undefined) layer.order = num(p.order, "order", LIMITS.order);
      }
      summary.push(`改「${scene.name}」的 ${(op.updates ?? []).length} 个图层`);
      return;
    }

    case "deleteLayers": {
      const scene = resolveScene(draft, op.sceneId, op.sceneName);
      const ids = op.ids ?? [];
      if (!ids.length) throw new Rejection("bad_param", "ids 不能为空", `要删的图层 id 列表`);
      if (scene.layers.length - ids.length < 1) {
        throw new Rejection(
          "last_layer",
          `「${scene.name}」只有 ${scene.layers.length} 个图层，删 ${ids.length} 个会一个不剩`,
          `至少要留一个图层 —— 对象必须有地方安放`,
        );
      }
      for (const id of ids) {
        const layer = scene.layers.find((l) => l.id === id);
        if (!layer) {
          throw new Rejection("unknown_layer", `「${scene.name}」里没有图层「${id}」`, `现有：${scene.layers.map((l) => `${l.id}(${l.name})`).join("、")}`);
        }
        // 先查「层上还有对象」，这比「删空」更常见的误操作
        const onLayer = scene.objects.filter((o) => o.layerId === id);
        if (onLayer.length) {
          throw new Rejection(
            "layer_not_empty",
            `图层「${layer.name}」上还有 ${onLayer.length} 个对象：${onLayer.slice(0, 5).map((o) => o.name).join("、")}${onLayer.length > 5 ? "…" : ""}`,
            `先用 updateObjects 把这些对象的 layerId 改到别的层，或 deleteObjects 删掉它们`,
          );
        }
      }
      scene.layers = scene.layers.filter((l) => !ids.includes(l.id));
      summary.push(`从「${scene.name}」删除 ${ids.length} 个图层`);
      return;
    }

    case "reorderObjects": {
      const scene = resolveScene(draft, op.sceneId, op.sceneName);
      const ids = scene.objects.map((o) => o.id);
      const resolved = (op.order ?? []).map((x) => {
        const key = String(x);
        if (scene.objects.some((o) => o.id === key)) return key;
        const byName = scene.objects.filter((o) => o.name === key);
        // 同名对象不唯一时不能猜 —— 猜错的后果是画错层级，用户看不出来原因
        if (byName.length === 1) return byName[0].id;
        return key;
      });
      const ordered = requireFullOrder(resolved, ids, "对象");
      const map = new Map(scene.objects.map((o) => [o.id, o]));
      scene.objects = ordered.map((id) => map.get(id)!);
      // 顺序即绘制顺序：写回 z，否则画布仍按旧的 z 排序
      scene.objects.forEach((o, i) => { o.z = i; });
      summary.push(`重排「${scene.name}」的 ${ordered.length} 个对象（绘制顺序已写回 z）`);
      return;
    }

    case "updatePrefabs": {
      for (const u of op.updates ?? []) {
        const pf = draft.prefabs.find((p) => p.id === u.id);
        if (!pf) {
          throw new Rejection(
            "unknown_prefab",
            `预制体「${u.id}」不存在`,
            `现有预制体：${draft.prefabs.map((p) => `${p.id}(${p.name})`).join("、") || "无"}`,
          );
        }
        const p = u.patch ?? {};
        if (p.name !== undefined) {
          const n = nonEmpty(p.name, "预制体名", `例：{"name": "箭塔"}`);
          // 运行期 bwe.prefab.spawn 按名字查，重名等于两个模板抢一个 key
          if (draft.prefabs.some((x) => x !== pf && x.name === n)) {
            throw new Rejection("duplicate_name", `预制体名「${n}」已被占用`, `现有：${draft.prefabs.map((x) => x.name).join("、")}`);
          }
          pf.name = n;
        }
        if (p.blurb !== undefined) pf.blurb = String(p.blurb);
        if (p.kind !== undefined) pf.kind = checkKind(p.kind);
        if (p.assetId !== undefined) pf.assetId = resolveAsset(draft, p.assetId);
        if (p.z !== undefined) pf.z = num(p.z, "z", LIMITS.order);
        if (p.layer !== undefined) pf.layer = num(p.layer, "layer", [0, 64]);
        if (p.rotation !== undefined) pf.rotation = num(p.rotation, "rotation", [-36000, 36000]);
        if (p.scaleX !== undefined) pf.scaleX = num(p.scaleX, "scaleX", [-100, 100]);
        if (p.scaleY !== undefined) pf.scaleY = num(p.scaleY, "scaleY", [-100, 100]);
        if (p.halfW !== undefined) pf.halfW = num(p.halfW, "halfW", [0, 4096]);
        if (p.halfH !== undefined) pf.halfH = num(p.halfH, "halfH", [0, 4096]);
        if (p.animMode !== undefined) pf.animMode = nonEmpty(p.animMode, "animMode", `例：static / loop`);
        if (p.animFps !== undefined) pf.animFps = num(p.animFps, "animFps", LIMITS.animFps);
        if (p.tags !== undefined) pf.tags = (p.tags ?? []).map((t) => String(t));
        if (p.props !== undefined) pf.props = { ...pf.props, ...p.props };
        if (p.script !== undefined) pf.script = resolveScript(draft, p.script);
        if (p.spawnJitter !== undefined) {
          pf.spawnJitter = {
            x: num(p.spawnJitter.x, "spawnJitter.x", LIMITS.jitter),
            y: num(p.spawnJitter.y, "spawnJitter.y", LIMITS.jitter),
          };
        }
        touchedIds.push(pf.id);
      }
      summary.push(`改 ${(op.updates ?? []).length} 个预制体`);
      return;
    }

    case "patchModules": {
      const target = targetModules(draft, op);
      for (const patch of op.patches ?? []) {
        const at = target.list.findIndex((m) => m.defId === patch.defId);
        if (at < 0) {
          throw new Rejection(
            "unknown_module_instance",
            `${target.label} 上没有挂模块「${patch.defId}」`,
            at === -1
              ? `${target.label} 现有模块：${target.list.map((m) => m.defId).join("、") || "无"}；` +
                `要新挂一个请用 attachModules（patchModules 只能改已挂上的）`
              : "",
          );
        }
        target.list[at] = mergeModulePatch(target.list[at], patch, draft);
      }
      touchedIds.push(target.id);
      summary.push(`改 ${target.label} 的 ${(op.patches ?? []).length} 个模块参数`);
      return;
    }

    case "updateAssets": {
      for (const u of op.updates ?? []) {
        const a = draft.assets.find((x) => x.id === u.id);
        if (!a) {
          throw new Rejection("unknown_asset", `素材「${u.id}」不存在`, `共 ${draft.assets.length} 个素材；先用 Project_Describe 读 id`);
        }
        if (a.src !== "url" && u.patch.url !== undefined) {
          throw new Rejection("bad_param", `素材「${a.name}」是本机导入的（src=blob），不能改 url`, `url 只对 src="url" 的素材有意义`);
        }
        if (a.kind === "AUDIO" && (u.patch.cols !== undefined || u.patch.frameCount !== undefined)) {
          throw new Rejection("bad_param", `音频素材「${a.name}」没有图集/序列帧参数`, ``);
        }
        if (u.patch.hiddenFrames !== undefined && a.kind !== "SEQUENCE") {
          throw new Rejection("bad_param", `hiddenFrames 只对序列帧有意义，而「${a.name}」是 ${a.kind}`, ``);
        }
        if (u.patch.frameDurations !== undefined && a.kind !== "SEQUENCE") {
          throw new Rejection("bad_param", `frameDurations 只对序列帧有意义，而「${a.name}」是 ${a.kind}`, ``);
        }
        touchedIds.push(a.id);
      }

      for (const u of op.updates ?? []) {
        const a = draft.assets.find((x) => x.id === u.id)!;
        const p = u.patch ?? {};
        if (p.name !== undefined) a.name = nonEmpty(p.name, "素材名", `例：{"name": "勇者"}`);
        if (p.group !== undefined) a.group = String(p.group);
        if (p.note !== undefined) a.note = String(p.note);
        if (p.url !== undefined) a.url = String(p.url);
        if (p.cols !== undefined) a.cols = num(p.cols, "cols", [1, 512]);
        if (p.rows !== undefined) a.rows = num(p.rows, "rows", [1, 512]);
        if (p.cellW !== undefined) a.cellW = num(p.cellW, "cellW", [1, 8192]);
        if (p.cellH !== undefined) a.cellH = num(p.cellH, "cellH", [1, 8192]);
        if (p.frameCount !== undefined) a.frameCount = num(p.frameCount, "frameCount", LIMITS.frameCount);

        /**
         * frameDurations / hiddenFrames 必须与 frameCount 对齐校验。
         * 不校验的后果是运行时按帧号取时长时越界 —— 表现为"动画播到第 3 帧就卡住"，
         * 而编辑器里看不出任何异常。
         */
        const count = a.frameCount ?? 0;
        if (p.frameDurations !== undefined) {
          const list = (p.frameDurations ?? []).map((v, i) => num(v, `frameDurations[${i}]`, LIMITS.frameDuration));
          if (list.length !== count) {
            throw new Rejection(
              "bad_param",
              `frameDurations 有 ${list.length} 项，但 frameCount 是 ${count}`,
              `长度必须与 frameCount 一致（先改 frameCount，再给同样长度的时长表）`,
            );
          }
          a.frameDurations = list;
        }
        if (p.hiddenFrames !== undefined) {
          const list = (p.hiddenFrames ?? []).map((v, i) => {
            const n = num(v, `hiddenFrames[${i}]`, [0, Math.max(0, count - 1)]);
            return Math.round(n);
          });
          a.hiddenFrames = list;
        }
      }
      summary.push(`改 ${(op.updates ?? []).length} 个素材`);
      return;
    }

    case "deleteAssets": {
      const ids = op.ids ?? [];
      if (!ids.length) throw new Rejection("bad_param", "ids 不能为空", `要删的素材 id 列表`);
      for (const id of ids) {
        const a = draft.assets.find((x) => x.id === id);
        if (!a) throw new Rejection("unknown_asset", `素材「${id}」不存在`, `共 ${draft.assets.length} 个素材`);
        const used = assetUsages(draft, id);
        if (used.length) {
          // 引用方**同时**写进 message 和 hint：message 给"为什么不能删"，
          // hint 给"具体去找谁" —— 模型下一步动作依赖后者，
          // 只说"被引用了"等于让它自己重新扫一遍全工程。
          throw new Rejection(
            "asset_in_use",
            `素材「${a.name}」还被引用：${used.slice(0, 6).join("、")}${used.length > 6 ? "…" : ""}`,
            `先把这些地方的 assetId 换成别的再删：${used.slice(0, 6).join("、")}`
              + `${used.length > 6 ? "…" : ""}（用 updateObjects / updatePrefabs / updateScene）`,
          );
        }
      }
      draft.assets = draft.assets.filter((a) => !ids.includes(a.id));
      summary.push(`删除 ${ids.length} 个素材`);
      return;
    }

    case "definePacks": {
      const made: RulePack[] = [];
      for (const spec of op.packs ?? []) {
        const name = nonEmpty(spec.name, "规则包名", `例：{"name": "巡逻包"}`);
        if (draft.packs.some((p) => p.name === name)) {
          throw new Rejection("duplicate_name", `规则包名「${name}」已存在`, `现有：${draft.packs.map((p) => p.name).join("、")}`);
        }
        made.push({
          id: `pk_${uid()}`,
          name,
          blurb: spec.blurb ?? "",
          modules: normalizeModules(spec.modules ?? [], draft),
          exposed: spec.exposed ?? {},
          exposedLabel: spec.exposedLabel ?? {},
        });
      }
      draft.packs.push(...made);
      summary.push(`定义 ${made.length} 个规则包：${made.map((p) => p.name).join("、")}`);
      return;
    }

    case "updatePacks": {
      for (const u of op.updates ?? []) {
        const pk = draft.packs.find((p) => p.id === u.id);
        if (!pk) {
          throw new Rejection("unknown_pack", `规则包「${u.id}」不存在`, `现有：${draft.packs.map((p) => `${p.id}(${p.name})`).join("、") || "无"}`);
        }
        const p = u.patch ?? {};
        if (p.name !== undefined) {
          const n = nonEmpty(p.name, "规则包名", `例：{"name": "守卫包"}`);
          if (draft.packs.some((x) => x !== pk && x.name === n)) {
            throw new Rejection("duplicate_name", `规则包名「${n}」已被占用`, `现有：${draft.packs.map((x) => x.name).join("、")}`);
          }
          pk.name = n;
        }
        if (p.blurb !== undefined) pk.blurb = String(p.blurb);
        if (p.modules !== undefined) pk.modules = normalizeModules(p.modules, draft);
        if (p.exposed !== undefined) pk.exposed = { ...p.exposed };
        if (p.exposedLabel !== undefined) pk.exposedLabel = { ...p.exposedLabel };
      }
      summary.push(`改 ${(op.updates ?? []).length} 个规则包`);
      return;
    }

    case "deletePacks": {
      const ids = op.ids ?? [];
      if (!ids.length) throw new Rejection("bad_param", "ids 不能为空", `要删的规则包 id 列表`);
      for (const id of ids) {
        if (!draft.packs.some((p) => p.id === id)) {
          throw new Rejection("unknown_pack", `规则包「${id}」不存在`, `现有：${draft.packs.map((p) => `${p.id}(${p.name})`).join("、") || "无"}`);
        }
      }
      draft.packs = draft.packs.filter((p) => !ids.includes(p.id));
      summary.push(`删除 ${ids.length} 个规则包`);
      return;
    }

    case "applyPacks": {
      const scene = resolveScene(draft, op.sceneId, op.sceneName);
      const packIds = op.packIds ?? [];
      if (!packIds.length) throw new Rejection("bad_param", "packIds 不能为空", `要套的规则包 id 列表`);
      const packs = packIds.map((id) => {
        const pk = draft.packs.find((p) => p.id === id);
        if (!pk) throw new Rejection("unknown_pack", `规则包「${id}」不存在`, `现有：${draft.packs.map((p) => `${p.id}(${p.name})`).join("、") || "无"}`);
        return pk;
      });
      const targets = op.targets ?? [];
      if (!targets.length) throw new Rejection("bad_param", "targets 不能为空", `要套规则包的对象 id 列表`);

      for (const targetId of targets) {
        const obj = requireObject(scene, targetId);
        obj.modules = obj.modules ?? [];
        for (const pk of packs) {
          for (const incoming of pk.modules ?? []) {
            /**
             * 拼接语义与 data/packs.ts 的 applyPack **完全一致**：
             * (defId + values.callName) 相同 → 覆盖参数；否则追加。
             *
             * ⚠ 这里是第二份实现（packs.ts 那份直接操作 store，不纯），
             * 所以 verify-project-ops-ext 里有一条断言用同一份数据比对两边结果 ——
             * "两份实现必须等价"这件事不能只写在注释里。
             */
            const key = `${incoming.defId}::${incoming.values?.callName ?? ""}`;
            const at = obj.modules.findIndex((m) => `${m.defId}::${m.values?.callName ?? ""}` === key);
            const inst: ModuleInstance = {
              defId: incoming.defId,
              label: incoming.label,
              trigger: incoming.trigger ?? null,
              values: { ...incoming.values },
              enabled: incoming.enabled ?? true,
              collapsed: true,
            };
            if (at >= 0) obj.modules[at] = inst;
            else obj.modules.push(inst);
          }
        }
        touchedIds.push(obj.id);
      }
      summary.push(`把 ${packs.length} 个规则包套到「${scene.name}」的 ${targets.length} 个对象上`);
      return;
    }

    case "deleteScripts": {
      const names = op.names ?? [];
      if (!names.length) throw new Rejection("bad_param", "names 不能为空", `要删的脚本名列表`);
      for (const name of names) {
        if (!draft.scripts[name]) {
          throw new Rejection("unknown_script", `脚本「${name}」不存在`, `现有脚本：${Object.keys(draft.scripts).join("、") || "无"}`);
        }
        const used = scriptUsages(draft, name);
        if (used.length) {
          // 刻意不提供 force：AI 应该先解引用，而不是强删。
          // 强删会留下"对象挂着脚本模块但脚本没了"的悬空引用，运行期静默空转 ——
          // 而这种坏法在编辑器里看不出来，要等试跑发现"某个对象的脚本不执行了"。
          throw new Rejection(
            "script_in_use",
            `脚本「${name}」还被引用：${used.slice(0, 6).join("、")}${used.length > 6 ? "…" : ""}`,
            `先解开这些引用再删：${used.slice(0, 6).join("、")}${used.length > 6 ? "…" : ""}`
              + `（场景脚本用 updateScene 的 onStartScript，对象/预制体用 detachModules 或改模块的 script 参数）`,
          );
        }
      }
      for (const name of names) delete draft.scripts[name];
      summary.push(`删除 ${names.length} 个脚本：${names.join("、")}`);
      return;
    }

    default: {
      const never: never = op;
      throw new Rejection("bad_param", `未知操作 ${JSON.stringify(never)}`, "检查 op 字段拼写");
    }
  }
}

// ---------------------------------------------------------------- 描述（只读）

/**
 * 给模型看的工程摘要。
 *
 * ⚠ 2026-11-13 全量扩展。判据只有一条：**改不了看不见的东西**。
 *   扩展前这里只有「对象名/kind/坐标/模块 defId」，于是 rotation、scale、visible、
 *   tags、props、parentId、animMode、场景的 onStartScript/bgm、图层的 visible/locked、
 *   预制体的全部外观字段、素材的 group、工程级字段、规则包 —— AI 一样都改不动，
 *   因为它根本不知道这些东西存在。
 *
 * 同时必须**限流**：对象只列前 maxObjects 个（默认 40）。全列会把上下文撑爆，
 * 而上下文爆掉的后果是模型开始遗忘指令 —— 表现为"改着改着跑偏了"。
 */
export interface ProjectDigest {
  // ---- 工程级 ----
  name: string;
  author: string;
  tileSize: number;
  gridW: number;
  gridH: number;
  masterVolume: number;
  /** 缺省（undefined）= 按场景宽高比推断 */
  orientation: "portrait" | "landscape" | null;
  scenes: Array<{
    id: string;
    name: string;
    widthTiles: number;
    heightTiles: number;
    originX: number;
    originY: number;
    ui: boolean;
    designW: number | null;
    designH: number | null;
    onStartScript: string;
    bgmAssetId: string;
    objectCount: number;
    layers: Array<{ id: string; name: string; visible: boolean; locked: boolean; order: number }>;
    /** 只列前 40 个，避免把上下文撑爆 */
    sampleObjects: Array<{
      id: string;
      name: string;
      kind: string;
      x: number;
      y: number;
      z: number;
      rotation: number;
      scaleX: number;
      scaleY: number;
      halfW: number;
      halfH: number;
      visible: boolean;
      locked: boolean;
      assetId: string;
      layerId: string;
      tags: string[];
      props: Record<string, string>;
      parentId: string | null;
      prefabId: string | null;
      animMode: string;
      animFps: number;
      modules: string[];
    }>;
  }>;
  prefabs: Array<{
    id: string;
    name: string;
    blurb: string;
    kind: string;
    assetId: string;
    z: number;
    layer: number | null;
    rotation: number;
    scaleX: number;
    scaleY: number;
    halfW: number;
    halfH: number;
    animMode: string;
    animFps: number;
    tags: string[];
    props: Record<string, string>;
    script: string;
    spawnJitter: { x: number; y: number };
    modules: string[];
  }>;
  assets: Array<{
    id: string;
    name: string;
    kind: string;
    src: string;
    url: string;
    path: string;
    group: string;
    note: string;
    width: number;
    height: number;
    cols: number | null;
    rows: number | null;
    cellW: number | null;
    cellH: number | null;
    frameCount: number | null;
    headName: string;
    hiddenFrames: number[];
    frameDurations: number[];
  }>;
  variables: Record<string, string>;
  scripts: Array<{ name: string; file: string; lines: number; lang: string }>;
  packs: Array<{ id: string; name: string; blurb: string; modules: string[]; exposed: Record<string, string> }>;
  /** 可用模块目录，带参数范围；这是模型能装配行为的唯一合法词汇表 */
  modules: Array<{ id: string; title: string; category: string; blurb: string; params: string[]; triggers: string[] }>;
}

const SAMPLE_LIMIT = 40;

export interface DigestOptions {
  /** 只看某个场景（名字或 id，精确匹配）；省略则全部 */
  scene?: string;
  /** 每个场景最多列几个对象，默认 40；大关卡全列会把上下文撑爆 */
  maxObjects?: number;
}

export function digestProject(project: Project, opts: DigestOptions = {}): ProjectDigest {
  const limit = Math.max(1, Math.min(opts.maxObjects ?? SAMPLE_LIMIT, 400));
  const filter = (opts.scene ?? "").trim();
  const scenes = filter
    ? project.scenes.filter((s) => s.id === filter || s.name === filter)
    : project.scenes;
  return {
    // ---- 工程级 ----
    name: project.name,
    author: project.author ?? "",
    tileSize: project.tileSize,
    gridW: project.gridW,
    gridH: project.gridH,
    masterVolume: project.masterVolume,
    orientation: project.orientation ?? null,
    scenes: scenes.map((s) => ({
      id: s.id,
      name: s.name,
      widthTiles: s.widthTiles,
      heightTiles: s.heightTiles,
      originX: s.originX ?? 0,
      originY: s.originY ?? 0,
      ui: s.ui ?? false,
      designW: s.designW ?? null,
      designH: s.designH ?? null,
      onStartScript: s.onStartScript ?? "",
      bgmAssetId: s.bgmAssetId ?? "",
      objectCount: s.objects.length,
      layers: s.layers.map((l) => ({
        id: l.id,
        name: l.name,
        visible: l.visible !== false,
        locked: l.locked === true,
        order: l.order ?? 0,
      })),
      sampleObjects: s.objects.slice(0, limit).map((o) => ({
        id: o.id,
        name: o.name,
        kind: o.kind,
        x: o.x,
        y: o.y,
        z: o.z ?? 0,
        rotation: o.rotation ?? 0,
        scaleX: o.scaleX ?? 1,
        scaleY: o.scaleY ?? 1,
        halfW: o.halfW ?? 0,
        halfH: o.halfH ?? 0,
        visible: o.visible !== false,
        locked: o.locked === true,
        assetId: o.assetId ?? "",
        layerId: o.layerId ?? "",
        tags: o.tags ?? [],
        props: o.props ?? {},
        parentId: o.parentId ?? null,
        prefabId: o.prefabId ?? null,
        animMode: o.animMode ?? "static",
        animFps: o.animFps ?? 0,
        modules: (o.modules ?? []).map((m) => m.defId),
      })),
    })),
    prefabs: project.prefabs.map((p) => ({
      id: p.id,
      name: p.name,
      blurb: p.blurb ?? "",
      kind: p.kind,
      assetId: p.assetId ?? "",
      z: p.z ?? 0,
      layer: p.layer ?? null,
      rotation: p.rotation ?? 0,
      scaleX: p.scaleX ?? 1,
      scaleY: p.scaleY ?? 1,
      halfW: p.halfW ?? 0,
      halfH: p.halfH ?? 0,
      animMode: p.animMode ?? "static",
      animFps: p.animFps ?? 0,
      tags: p.tags ?? [],
      props: p.props ?? {},
      script: p.script ?? "",
      spawnJitter: p.spawnJitter ?? { x: 0, y: 0 },
      modules: (p.modules ?? []).map((m) => m.defId),
    })),
    assets: project.assets.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      src: a.src,
      url: a.url ?? "",
      path: a.path ?? "",
      group: a.group ?? "",
      note: a.note ?? "",
      width: a.width,
      height: a.height,
      cols: a.cols ?? null,
      rows: a.rows ?? null,
      cellW: a.cellW ?? null,
      cellH: a.cellH ?? null,
      frameCount: a.frameCount ?? null,
      headName: a.headName ?? "",
      hiddenFrames: a.hiddenFrames ?? [],
      frameDurations: a.frameDurations ?? [],
    })),
    variables: { ...project.variables },
    scripts: Object.values(project.scripts).map((s) => ({
      name: s.name,
      file: s.file,
      lines: s.source.split("\n").length,
      lang: s.lang === "js" ? "js" : "yarn",
    })),
    packs: (project.packs ?? []).map((pk) => ({
      id: pk.id,
      name: pk.name,
      blurb: pk.blurb ?? "",
      modules: (pk.modules ?? []).map((m) => m.defId),
      exposed: pk.exposed ?? {},
    })),
    modules: MODULES.map((m) => ({
      id: m.id,
      title: m.title,
      category: m.category,
      blurb: m.blurb,
      params: m.params.map((p) => (p.type === "num" ? `${p.key}:${p.min}..${p.max}` : p.key)),
      triggers: m.triggers,
    })),
  };
}

/**
 * 把 digest 渲染成**给模型读的**紧凑文本。
 *
 * 为什么不直接 JSON.stringify：模型要为一次改造读几十个对象，
 * 带引号和缩进的 JSON 会把同样的信息多花一倍 token，而 token 就是钱和注意力。
 * 但要小心另一头 —— 不能为了省字把 id 省掉。这里的 id 是 ApplyProjectOps 唯一认的坐标，
 * 省了就变成「AI 知道有这个东西，但改不了它」。
 *
 * 还有一条：素材与模块目录必须带上。模型不是猜的，它得看到「这台引擎里到底有什么词汇」，
 * 否则它只能瞎编 defId，然后被静默丢掉，最后表现为「AI 说加了行为但没反应」。
 */
export function describeDigest(d: ProjectDigest): string {
  const L: string[] = [];
  L.push(`工程「${d.name}」　作者 ${d.author || "—"}　格子 ${d.gridW}x${d.gridH}　tileSize ${d.tileSize}　音量 ${d.masterVolume}　方向 ${d.orientation ?? "自动"}`);
  L.push(`脚本 ${d.scripts.length} 个，预制体 ${d.prefabs.length} 个，规则包 ${d.packs.length} 个，素材 ${d.assets.length} 个，变量 ${Object.keys(d.variables).length} 个`);

  L.push("");
  L.push("== 场景 ==");
  for (const sc of d.scenes) {
    const head = sc.ui
      ? `[UI] ${sc.name} (id=${sc.id})　设计分辨率 ${sc.designW ?? "?"}x${sc.designH ?? "?"}`
      : `${sc.name} (id=${sc.id})　${sc.widthTiles}x${sc.heightTiles} 格`;
    // origin / 场景脚本 / bgm 全列：这些字段 AI 之前根本看不见，也就永远改不动
    const extra = [
      sc.originX || sc.originY ? `origin ${sc.originX},${sc.originY}` : "",
      sc.onStartScript ? `场景脚本 ${sc.onStartScript}` : "无场景脚本",
      sc.bgmAssetId ? `bgm ${sc.bgmAssetId}` : "无 bgm",
    ].filter(Boolean).join("　");
    L.push(head + `　对象 ${sc.objectCount}`);
    L.push(`  ${extra}`);
    L.push(
      "  图层：" +
        sc.layers
          .map((l) => `${l.name}(id=${l.id}${l.visible ? "" : " 隐藏"}${l.locked ? " 锁定" : ""})`)
          .join("　"),
    );
    if (sc.objectCount > sc.sampleObjects.length) {
      L.push(`  （只列前 ${sc.sampleObjects.length} 个，共 ${sc.objectCount} 个；用 maxObjects 调大或按 scene 过滤）`);
    }
    for (const o of sc.sampleObjects) {
      const bits: string[] = [`${o.kind} @${o.x},${o.y}`];
      if (o.z) bits.push(`z${o.z}`);
      if (o.rotation) bits.push(`旋转${o.rotation}`);
      if (o.scaleX !== 1 || o.scaleY !== 1) bits.push(`缩放${o.scaleX}x${o.scaleY}`);
      if (o.halfW || o.halfH) bits.push(`碰撞${o.halfW}x${o.halfH}`);
      if (!o.visible) bits.push("隐藏");
      if (o.locked) bits.push("锁定");
      if (o.assetId) bits.push(`素材${o.assetId}`);
      if (o.layerId) bits.push(`层${o.layerId}`);
      if (o.tags.length) bits.push(`标签[${o.tags.join(",")}]`);
      if (o.parentId) bits.push(`父${o.parentId}`);
      if (o.prefabId) bits.push(`来自${o.prefabId}`);
      if (o.animMode !== "static" || o.animFps) bits.push(`动画${o.animMode}@${o.animFps}fps`);
      const props = Object.entries(o.props);
      if (props.length) bits.push(`props{${props.map(([k, v]) => `${k}=${v}`).join(",")}}`);
      const mod = o.modules.length ? `　[${o.modules.join(",")}]` : "";
      L.push(`  - ${o.name} (id=${o.id}) ${bits.join(" ")}${mod}`);
    }
  }

  if (d.prefabs.length) {
    L.push("");
    L.push("== 预制体 ==");
    for (const pf of d.prefabs) {
      const bits = [`${pf.kind}`];
      if (pf.blurb) bits.push(`「${pf.blurb}」`);
      if (pf.assetId) bits.push(`素材${pf.assetId}`);
      if (pf.z) bits.push(`z${pf.z}`);
      if (pf.layer !== null) bits.push(`层序号${pf.layer}`);
      if (pf.rotation) bits.push(`旋转${pf.rotation}`);
      if (pf.scaleX !== 1 || pf.scaleY !== 1) bits.push(`缩放${pf.scaleX}x${pf.scaleY}`);
      if (pf.halfW || pf.halfH) bits.push(`碰撞${pf.halfW}x${pf.halfH}`);
      if (pf.animMode !== "static" || pf.animFps) bits.push(`动画${pf.animMode}@${pf.animFps}fps`);
      if (pf.script) bits.push(`脚本${pf.script}`);
      if (pf.spawnJitter.x || pf.spawnJitter.y) bits.push(`散布±${pf.spawnJitter.x},${pf.spawnJitter.y}`);
      if (pf.tags.length) bits.push(`标签[${pf.tags.join(",")}]`);
      const props = Object.entries(pf.props);
      if (props.length) bits.push(`props{${props.map(([k, v]) => `${k}=${v}`).join(",")}}`);
      L.push(`  - ${pf.name} (id=${pf.id}) ${bits.join(" ")}${pf.modules.length ? `　[${pf.modules.join(",")}]` : ""}`);
    }
  }

  if (d.scripts.length) {
    L.push("");
    L.push("== 脚本 ==");
    L.push(`  ${d.scripts.map((s) => `${s.name}(${s.lang},${s.lines}行)`).join("  ")}`);
  }

  if (d.assets.length) {
    L.push("");
    L.push("== 素材 id ==");
    for (const a of d.assets) {
      const bits = [`${a.kind}`, `${a.width}x${a.height}`, a.src === "url" ? `url ${a.url}` : `本机 ${a.path}`];
      if (a.group) bits.push(`组${a.group}`);
      if (a.frameCount !== null) bits.push(`帧数${a.frameCount}`);
      if (a.cols !== null) bits.push(`图集${a.cols}x${a.rows ?? "?"} 格${a.cellW ?? "?"}x${a.cellH ?? "?"}`);
      if (a.hiddenFrames.length) bits.push(`隐藏帧[${a.hiddenFrames.join(",")}]`);
      if (a.note) bits.push(`备注:${a.note}`);
      L.push(`  - ${a.id}(${a.name}) ${bits.join(" ")}`);
    }
  }

  if (d.packs.length) {
    L.push("");
    L.push("== 规则包 ==");
    for (const pk of d.packs) {
      const ex = Object.keys(pk.exposed);
      L.push(
        `  - ${pk.name} (id=${pk.id})${pk.blurb ? `「${pk.blurb}」` : ""}`
        + `${pk.modules.length ? `　[${pk.modules.join(",")}]` : "　(空)"}`
        + `${ex.length ? `　可调:${ex.join(",")}` : ""}`,
      );
    }
  }

  if (Object.keys(d.variables).length) {
    L.push("");
    L.push(`== 变量 ==
  ${Object.entries(d.variables).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }

  L.push("");
  L.push("== 可用模块（挂行为只能用这里的 defId） ==");
  for (const m of d.modules) {
    const ps = m.params.length ? `　参数：${m.params.join(",")}` : "";
    const ts = m.triggers.length ? `　触发：${m.triggers.join(",")}` : "";
    L.push(`  - ${m.id}「${m.title}」[${m.category}] ${m.blurb}${ps}${ts}`);
  }
  return L.join("\n");
}

/**
 * 渲染侧执行器的**纯逻辑**：工具名 + 参数 + 工程 → 回给模型的结果。
 *
 * 为什么把它从 editor.ts 里抽出来：这段逻辑决定「模型到底看到什么」，
 * 是这条链路里最容易悄悄说错话的地方（说改好了其实没改、被拒了却不给原因）。
 * 留在 editor.ts 里就只能靠类型检查，永远跑不到；抽出来才能被测试真的执行。
 * editor 那边只负责把它返回的工程落到 store 上（那部分必须碰真实 UI 状态）。
 */
export type ProjectToolOutcome =
  | { kind: "digest"; text: string; meta: Record<string, unknown> }
  | { kind: "applied"; text: string; meta: Record<string, unknown>; project: Project }
  | { kind: "rejected"; text: string; meta: Record<string, unknown>; error: string };

export function runProjectTool(
  name: string,
  args: Record<string, unknown>,
  project: Project | null,
): ProjectToolOutcome {
  if (!project) {
    return {
      kind: "rejected",
      error: "no_project",
      text: "没有打开的工程。请先打开或新建一个工程，再让我改。",
      meta: { tool: name },
    };
  }

  if (name === "ProjectDigest") {
    const d = digestProject(project, {
      scene: typeof args.scene === "string" ? args.scene : undefined,
      maxObjects: typeof args.maxObjects === "number" ? args.maxObjects : undefined,
    });
    return {
      kind: "digest",
      text: describeDigest(d),
      meta: { tool: name, scenes: d.scenes.length },
    };
  }

  if (name === "ApplyProjectOps") {
    if (!Array.isArray(args.ops)) {
      return {
        kind: "rejected",
        error: "bad_param",
        text: "ops 必须是数组。一次改造 = 一个操作数组。",
        meta: { tool: name },
      };
    }
    const dryRun = args.dryRun === true;
    const r = applyProjectOps(project, args.ops as ProjectOp[]);
    if (!r.ok) {
      // 整批被拒：原工程一个字节都没变。逐条原因原样交回，让模型能自己纠正，
      // 而不是拿到一个错误码去瞎重试。这里绝不能"部分成功"——
      // 否则用户看到的世界和模型以为的世界就不一致了。
      const detail = r.rejections
        .map((x) => `- 第 ${x.index + 1} 条（${x.op}）：${x.message}${x.hint ? `　提示：${x.hint}` : ""}`)
        .join("\n");
      return {
        kind: "rejected",
        error: r.rejections[0]?.code || "rejected",
        text: `整批被拒，工程未改动。\n${detail}`,
        meta: { tool: name, rejections: r.rejections.length },
      };
    }
    if (r.summary.length === 0) {
      return {
        kind: "applied",
        text: "这批操作没有产生任何改动（空批次）。",
        meta: { tool: name, changed: false, dryRun },
        project,
      };
    }
    if (dryRun) {
      /**
       * `dryRun` = 只校验不落地。
       *
       * ⚠ 这个参数在 tool schema 里声明了很久，但**整条链路没有一处读过它** ——
       * 模型照着 schema 传 dryRun:true 想先探一批操作合不合法，结果改动**真的落地了**。
       * 这种断裂最坏的地方是它静默成功：模型以为自己只是在试探，用户看到关卡被改。
       * 既然声明了就必须实现，否则应该从 schema 里删掉。
       *
       * changed:false 是关键 —— 调用方（editor.applyAiProject）据此不动 store、
       * 不产生撤销点，工程逐字节不变。
       */
      return {
        kind: "applied",
        text:
          `试运行通过（工程未改动）：这批操作会做 ${r.summary.length} 处改动：\n`
          + r.summary.map((x) => `- ${x}`).join("\n")
          + "\n确认无误后去掉 dryRun 再调一次即可真正生效。",
        meta: { tool: name, changed: false, dryRun: true, wouldChange: r.summary.length },
        project,
      };
    }
    return {
      kind: "applied",
      text: `已应用 ${r.summary.length} 处改动：\n` + r.summary.map((x) => `- ${x}`).join("\n"),
      meta: { tool: name, changed: true, touched: r.touchedIds.length, dryRun: false },
      project: r.project!,
    };
  }

  return {
    kind: "rejected",
    error: "unknown_tool",
    text: `未知的工程工具：${name}`,
    meta: { tool: name },
  };
}
