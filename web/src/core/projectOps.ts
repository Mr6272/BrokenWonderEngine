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
  GameObjectKind,
  Layer,
  ModuleInstance,
  PrefabDef,
  Project,
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
  | { op: "definePrefabs"; prefabs: NewPrefabSpec[] }
  | { op: "deletePrefabs"; ids: string[] }
  | { op: "attachModules"; sceneId?: string; targetId: string; isPrefab?: boolean; modules: ModuleInstanceSpec[] }
  | { op: "detachModules"; sceneId?: string; targetId: string; isPrefab?: boolean; defIds: string[] }
  | { op: "addLayer"; sceneId?: string; sceneName?: string; name: string }
  | { op: "createScene"; scene: NewSceneSpec }
  | { op: "writeScripts"; scripts: Array<{ path: string; source: string; name?: string }> }
  | { op: "setVariables"; variables: Record<string, string> };

// ---------------------------------------------------------------- 结果类型

export type OpFailureCode =
  | "unknown_scene"
  | "unknown_object"
  | "unknown_prefab"
  | "unknown_module"
  | "unknown_asset"
  | "unknown_layer"
  | "bad_param"
  | "bad_trigger"
  | "bad_kind"
  | "duplicate_id"
  | "empty_name"
  | "bad_coord";

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
    animMode: "static",
    animFps: 0,
    layerId: resolveLayer(scene, spec.layerId),
    tags: spec.tags ?? [],
    props: spec.props ?? {},
    modules: normalizeModules(spec.modules, project),
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
        if (p.prefabId !== undefined) o.prefabId = p.prefabId;
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
        const scene = requireScene(draft, op.sceneId ?? "");
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
        const scene = requireScene(draft, op.sceneId ?? "");
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
        const entry: ScriptEntry = {
          name: s.name ?? path.replace(/^Scripts\//, "").replace(/\.js$/, ""),
          file: path.startsWith("Scripts/") ? path : `Scripts/${path}`,
          source: String(s.source ?? ""),
        };
        draft.scripts[entry.name] = entry;
        summary.push(`写入脚本「${entry.name}」(${entry.source.split("\n").length} 行)`);
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

    default: {
      const never: never = op;
      throw new Rejection("bad_param", `未知操作 ${JSON.stringify(never)}`, "检查 op 字段拼写");
    }
  }
}

// ---------------------------------------------------------------- 描述（只读）

export interface ProjectDigest {
  name: string;
  tileSize: number;
  gridW: number;
  gridH: number;
  scenes: Array<{
    id: string;
    name: string;
    widthTiles: number;
    heightTiles: number;
    ui: boolean;
    designW: number | null;
    designH: number | null;
    objectCount: number;
    layers: Array<{ id: string; name: string }>;
    /** 只列前 40 个，避免把上下文撑爆 */
    sampleObjects: Array<{ id: string; name: string; kind: string; x: number; y: number; modules: string[] }>;
  }>;
  prefabs: Array<{ id: string; name: string; kind: string; tags: string[]; modules: string[] }>;
  assets: Array<{ id: string; name: string; kind: string; width: number; height: number }>;
  variables: Record<string, string>;
  scripts: Array<{ name: string; file: string; lines: number }>;
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
    name: project.name,
    tileSize: project.tileSize,
    gridW: project.gridW,
    gridH: project.gridH,
    scenes: scenes.map((s) => ({
      id: s.id,
      name: s.name,
      widthTiles: s.widthTiles,
      heightTiles: s.heightTiles,
      ui: s.ui ?? false,
      designW: s.designW ?? null,
      designH: s.designH ?? null,
      objectCount: s.objects.length,
      layers: s.layers.map((l) => ({ id: l.id, name: l.name })),
      sampleObjects: s.objects.slice(0, limit).map((o) => ({
        id: o.id,
        name: o.name,
        kind: o.kind,
        x: o.x,
        y: o.y,
        modules: (o.modules ?? []).map((m) => m.defId),
      })),
    })),
    prefabs: project.prefabs.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      tags: p.tags ?? [],
      modules: (p.modules ?? []).map((m) => m.defId),
    })),
    assets: project.assets.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      width: a.width,
      height: a.height,
    })),
    variables: { ...project.variables },
    scripts: Object.values(project.scripts).map((s) => ({
      name: s.name,
      file: s.file,
      lines: s.source.split("\n").length,
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
  L.push(`工程「${d.name}」　格子 ${d.gridW}x${d.gridH}　tileSize ${d.tileSize}`);
  L.push(`脚本 ${d.scripts.length} 个，预制体 ${d.prefabs.length} 个，变量 ${Object.keys(d.variables).length} 个`);

  L.push("");
  L.push("== 场景 ==");
  for (const sc of d.scenes) {
    const head = sc.ui
      ? `[UI] ${sc.name} (id=${sc.id})　设计分辨率 ${sc.designW ?? "?"}x${sc.designH ?? "?"}`
      : `${sc.name} (id=${sc.id})　${sc.widthTiles}x${sc.heightTiles} 格`;
    L.push(head + `　对象 ${sc.objectCount}　图层：${sc.layers.map((l) => l.name).join("/")}`);
    if (sc.objectCount > sc.sampleObjects.length) {
      L.push(`  （只列前 ${sc.sampleObjects.length} 个，共 ${sc.objectCount} 个）`);
    }
    for (const o of sc.sampleObjects) {
      const mod = o.modules.length ? `　[${o.modules.join(",")}]` : "";
      L.push(`  - ${o.name} (id=${o.id}) ${o.kind} @${o.x},${o.y}${mod}`);
    }
  }

  if (d.prefabs.length) {
    L.push("");
    L.push("== 预制体 ==");
    for (const pf of d.prefabs) {
      L.push(`  - ${pf.name} (id=${pf.id}) ${pf.kind}${pf.modules.length ? `　[${pf.modules.join(",")}]` : ""}`);
    }
  }

  if (d.scripts.length) {
    L.push("");
    L.push(`== 脚本 ==
  ${d.scripts.map((s) => `${s.name}(${s.lines}行)`).join("  ")}`);
  }

  if (d.assets.length) {
    L.push("");
    L.push(`== 可用素材 id ==
  ${d.assets.map((a) => `${a.id}(${a.name} ${a.width}x${a.height})`).join("  ")}`);
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
        meta: { tool: name, changed: false },
        project,
      };
    }
    return {
      kind: "applied",
      text: `已应用 ${r.summary.length} 处改动：\n` + r.summary.map((x) => `- ${x}`).join("\n"),
      meta: { tool: name, changed: true, touched: r.touchedIds.length },
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
