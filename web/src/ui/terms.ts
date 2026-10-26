/**
 * 术语表 —— 全编辑器唯一的命名来源。
 *
 * 命名规范（Unity 术语 + 中文直译，两者并列）：
 *   1. 属性名一律「中文名 EnglishName」，例如「移动速度 Move Speed」；
 *   2. 单位用 Unity 口径：像素 → px（1 单位 = 1 px，与画布一致）、秒 → s；
 *   3. 对象类型用 Unity 的 GameObject 体系中文名：Actor / GameObject / Trigger / Spawn Point；
 *   4. 不出现「实体、预置体、回调、监听器」这类需要背景知识才能懂的词。
 *
 * 为什么集中在一张表里：术语一旦散落在各面板，改一处漏一处，
 * 最后同一个东西在左栏叫「序列帧」、右栏叫「动画」，用户会以为是两个功能。
 */

import type { TriggerId, ModuleCategoryId, GameObjectKind, AssetKind, ParamType } from "../core/model.ts";

/** 触发时机（事件）名称。 */
export const TRIGGERS: Record<TriggerId, { cn: string; hint: string }> = {
  ALWAYS: { cn: "持续生效 On Update", hint: "每帧都在起作用，适合移动、跟随这类持续行为" },
  ON_START: { cn: "启动时 On Start", hint: "游戏开始那一刻执行一次" },
  ON_CLICK: { cn: "点击时 On Pointer Click", hint: "鼠标点中它时执行" },
  ON_TRIGGER_ENTER: { cn: "进入触发区 On Trigger Enter", hint: "有对象进入它的触发区时执行一次" },
  ON_TRIGGER_EXIT: { cn: "离开触发区 On Trigger Exit", hint: "有对象离开触发区时执行一次" },
  ON_DAMAGE: { cn: "受到伤害 On Take Damage", hint: "自己掉血时执行" },
  ON_DEATH: { cn: "生命值归零 On Death", hint: "生命值降到 0 时执行" },
  ON_TIMER: { cn: "计时到达 On Timer", hint: "过一段时间后执行；可设为反复触发" },
  ON_INTERACT: { cn: "交互键 On Interact", hint: "玩家走近并按下交互键时执行" },
  ON_SCENE_START: { cn: "场景加载 On Scene Load", hint: "进入这张地图时执行一次" },
  ON_VARIABLE: { cn: "变量条件 On Variable", hint: "存档变量满足条件时执行" },
  ON_CALLED: { cn: "被调用 On Invoke", hint: "被其他模块按名字调用时执行" }
};

/** 模块类别。 */
export const CATEGORIES: Record<ModuleCategoryId, { label: string; en: string; blurb: string; color: string }> = {
  move: { label: "移动", en: "Movement", blurb: "位移、寻路、巡逻、推挤", color: "var(--cat-move)" },
  render: { label: "渲染", en: "Rendering", blurb: "精灵动画、排序、阴影、光照", color: "var(--cat-render)" },
  detect: { label: "检测", en: "Detection", blurb: "距离、视野、范围、地形判定", color: "var(--cat-detect)" },
  event: { label: "事件", en: "Events", blurb: "点击、触发、计时、条件、调用", color: "var(--cat-event)" },
  combat: { label: "战斗", en: "Combat", blurb: "生命值、攻击、伤害、死亡", color: "var(--cat-combat)" },
  dialogue: { label: "对话", en: "Dialogue", blurb: "气泡台词、对话框、分支选项", color: "var(--cat-dialogue)" },
  fx: { label: "表现", en: "Feedback", blurb: "音效、音乐、特效、震屏、转场", color: "var(--cat-fx)" },
  game: { label: "玩法", en: "Gameplay", blurb: "棋盘、换装、小游戏规则", color: "var(--cat-game)" }
};

/** 游戏对象类型。 */
export const KINDS: Record<GameObjectKind, { cn: string; en: string; hint: string; icon: string }> = {
  ACTOR: { cn: "角色", en: "Actor", hint: "会移动的对象：主角、NPC、敌人", icon: "actor" },
  PROP: { cn: "物件", en: "Prop", hint: "静态景物：箱子、树、家具、建筑", icon: "prop" },
  TILE: { cn: "地块", en: "Tile", hint: "拼地图用的单块贴图，按网格对齐", icon: "tile" },
  ZONE: { cn: "触发区", en: "Trigger Area", hint: "不可见的区域，进入或点击时触发逻辑", icon: "zone" },
  SPAWN: { cn: "出生点", en: "Spawn Point", hint: "玩家或敌人的初始位置", icon: "spawn" },
  PORTAL: { cn: "传送口", en: "Portal", hint: "走到这里切换到另一张地图", icon: "portal" },
  LIGHT: { cn: "光源", en: "Light", hint: "照亮周围，用于夜间与室内氛围", icon: "light" }
};

/** 素材类型。 */
export const ASSET_KINDS: Record<AssetKind, { cn: string; en: string; hint: string }> = {
  IMAGE: { cn: "精灵", en: "Sprite", hint: "单张图片，一个物件或一块地块" },
  SEQUENCE: { cn: "序列帧", en: "Sprite Sheet", hint: "多张图片按顺序播放成动画" },
  ATLAS: { cn: "图集", en: "Sprite Atlas", hint: "一张大图切成多帧，按行列取用" },
  AUDIO: { cn: "音频", en: "Audio Clip", hint: "音效或背景音乐" }
};

/** 参数类型的界面提示。 */
export const PARAM_TYPES: Record<ParamType, { pick?: string }> = {
  num: {},
  text: {},
  bool: {},
  pick: {},
  obj: { pick: "选择场景对象" },
  asset: { pick: "从素材库选择" },
  tag: { pick: "选择标签" },
  script: { pick: "选择剧本" },
  note: {}
};

/** 属性名的统一写法：中文 + 英文，Unity 口径。 */
export const TERM = {
  position: { cn: "位置", en: "Position", unit: "px" },
  rotation: { cn: "旋转", en: "Rotation", unit: "°" },
  scale: { cn: "缩放", en: "Scale", unit: "×" },
  size: { cn: "尺寸", en: "Size", unit: "px" },
  collider: { cn: "碰撞体", en: "Collider 2D" },
  sortOrder: { cn: "排序层级", en: "Sort Order" },
  layer: { cn: "图层", en: "Layer" },
  tag: { cn: "标签", en: "Tag" },
  name: { cn: "名称", en: "Name" },
  sprite: { cn: "精灵", en: "Sprite" },
  animation: { cn: "动画", en: "Animation" },
  frameRate: { cn: "帧率", en: "Frame Rate", unit: "fps" },
  visible: { cn: "显示", en: "Visible" },
  locked: { cn: "锁定", en: "Locked" },
  moveSpeed: { cn: "移动速度", en: "Move Speed", unit: "px/s" },
  detectionRange: { cn: "检测范围", en: "Detection Range", unit: "px" },
  stopDistance: { cn: "停止距离", en: "Stop Distance", unit: "px" },
  cooldown: { cn: "冷却时间", en: "Cooldown", unit: "s" },
  duration: { cn: "持续时间", en: "Duration", unit: "s" },
  maxHealth: { cn: "生命值上限", en: "Max Health" },
  damage: { cn: "伤害", en: "Damage" },
  radius: { cn: "半径", en: "Radius", unit: "px" },
  tileSize: { cn: "格子尺寸", en: "Tile Size", unit: "px" },
  mapSize: { cn: "地图尺寸", en: "Map Size", unit: "格" }
} as const;

export type TermKey = keyof typeof TERM;

export function term(k: TermKey): string {
  const t = TERM[k];
  return t.cn;
}

export function termWithEn(k: TermKey): string {
  const t = TERM[k];
  return `${t.cn} ${t.en}`;
}

/** 触发时机下拉项。 */
export function triggerOptions(ids: TriggerId[]): { value: string; label: string }[] {
  return ids.map((id) => ({ value: id, label: TRIGGERS[id].cn }));
}

export function triggerLabel(id: TriggerId | null | undefined, fallback: TriggerId): string {
  return TRIGGERS[id ?? fallback]?.cn ?? TRIGGERS[fallback].cn;
}

/** Unity 风的状态栏提示词。 */
export const STATUS_READY = "就绪 · 空格 + 拖动平移视图 · 滚轮缩放 · 右键拖动画布 · F1 快速上手";
