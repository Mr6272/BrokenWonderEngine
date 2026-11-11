/**
 * 内置模块库 —— 完全俯视角 RPG 专用。
 *
 * 两条命名纪律：
 *   1. 模块名 = 中文动作 + Unity 英文名，例：「朝玩家移动 Follow Target」
 *      中文保证一眼看懂，英文保证与 Unity 术语对得上；
 *   2. 参数名 = 中文名 + 英文名 + 单位，例：「移动速度 Move Speed (px/s)」
 *      参数面板只显示中文主名，英文与单位放在括号里，鼠标悬停给完整解释。
 *
 * 每个模块都必须给全默认值：拖进场景立刻能跑，用户再按需微调。
 */

import type { ModuleDef, ModuleCategory, ModuleCategoryId } from "../core/model.ts";

export const MODULE_CATEGORIES: ModuleCategory[] = [
  { id: "move", label: "移动 Movement", blurb: "位移、寻路、巡逻、推挤", color: "var(--cat-move)" },
  { id: "render", label: "渲染 Rendering", blurb: "精灵动画、排序、阴影、光照", color: "var(--cat-render)" },
  { id: "detect", label: "检测 Detection", blurb: "距离、视野、范围、地形判定", color: "var(--cat-detect)" },
  { id: "event", label: "事件 Events", blurb: "点击、触发、计时、条件、调用", color: "var(--cat-event)" },
  { id: "combat", label: "战斗 Combat", blurb: "生命值、攻击、伤害、死亡", color: "var(--cat-combat)" },
  { id: "dialogue", label: "对话 Dialogue", blurb: "气泡台词、对话框、分支选项", color: "var(--cat-dialogue)" },
  { id: "fx", label: "表现 Feedback", blurb: "音效、音乐、特效、震屏、转场", color: "var(--cat-fx)" },
  { id: "grid", label: "网格 Grid", blurb: "格子棋盘、格子渲染、翻开与标记规则", color: "var(--cat-grid)" },
  { id: "game", label: "玩法 Gameplay", blurb: "完整小游戏组合、换装", color: "var(--cat-game)" }
];

export function categoryOf(id: ModuleCategoryId): ModuleCategory {
  return MODULE_CATEGORIES.find((c) => c.id === id) ?? MODULE_CATEGORIES[0];
}

// ---------------- 定义辅助 ----------------

type P = import("../core/model.ts").ParamDef;

function num(key: string, label: string, def: number, min: number, max: number, unit: string, hint: string, step?: number): P {
  return { key, label, type: "num", def: String(def), min, max, unit, hint, step: step ?? ((max - min) <= 20 ? 0.1 : 1) };
}

function txt(key: string, label: string, def: string, hint: string): P {
  return { key, label, type: "text", def, hint };
}

function bool(key: string, label: string, def: boolean, hint: string): P {
  return { key, label, type: "bool", def: def ? "开" : "关", hint };
}

function pick(key: string, label: string, def: string, options: string[], hint: string): P {
  return { key, label, type: "pick", def, options, hint };
}

function ref(key: string, label: string, type: "obj" | "asset" | "tag" | "script", hint: string): P {
  return { key, label, type, def: "", hint };
}

// ---------------- 模块定义 ----------------

export const MODULES: ModuleDef[] = [
  // ===== 移动 Movement =====
  {
    id: "move.follow",
    title: "朝玩家移动",
    code: "Follow Target",
    category: "move",
    blurb: "发现玩家后朝它走，走到指定距离停下",
    detail: "适合敌人、跟随型同伴。会自动绕开带碰撞体的物件（前提是场景里有「碰撞体 · 阻挡」）。"
      + "和「巡逻」同时挂会互相抢控制权，二者通常只留一个。",
    triggers: ["ALWAYS"],
    params: [
      num("speed", "移动速度", 60, 5, 400, "px/s", "每秒走多少像素；角色通常 60–140"),
      num("stopDistance", "停止距离", 24, 0, 300, "px", "贴到这个距离就不再往前挤，可避免原地抖动"),
      num("detectionRange", "检测范围", 200, 20, 1200, "px", "超出这个距离就不再追"),
      bool("ignoreCollider", "忽略碰撞体", false, "打开后可以穿墙直冲，一般只在剧情演出时用")
    ]
  },
  {
    id: "move.patrol",
    title: "来回巡逻",
    code: "Patrol",
    category: "move",
    blurb: "在起点两侧来回走，到头稍作停顿再折返",
    detail: "适合守卫、巡逻机器人。比瞬间掉头自然，观感更接近真实 NPC。",
    triggers: ["ALWAYS"],
    params: [
      num("speed", "移动速度", 40, 5, 300, "px/s", ""),
      num("range", "巡逻范围", 96, 8, 2000, "px", "以放置点为中心，单侧最远走这么远"),
      pick("axis", "巡逻轴向", "水平 Horizontal", ["水平 Horizontal", "垂直 Vertical"], "俯视角地图里水平巡逻最常用"),
      num("waitTime", "折返停顿", 0.6, 0, 10, "s", "0 表示不停顿立刻回头")
    ]
  },
  {
    id: "move.wander",
    title: "随机游走",
    code: "Wander",
    category: "move",
    blurb: "在指定范围内随意走走停停",
    detail: "适合村民、野生动物。不追人，只在范围内随机选点，让场景看起来是活的。",
    triggers: ["ALWAYS"],
    params: [
      num("speed", "移动速度", 30, 5, 200, "px/s", ""),
      num("area", "活动半径", 120, 16, 2000, "px", "以放置点为圆心"),
      num("pauseMin", "最短停留", 0.8, 0, 20, "s", ""),
      num("pauseMax", "最长停留", 2.5, 0, 30, "s", "必须大于等于最短停留，否则取最短值")
    ]
  },
  {
    id: "move.path",
    title: "沿指定路径移动",
    code: "Follow Path",
    category: "move",
    blurb: "按你标好的路径点一段段走",
    detail: "适合剧情运镜与固定路线巡逻。用「触发区」或「物件」摆出路径点，打上同一个标签，这里填那个标签即可。",
    triggers: ["ALWAYS"],
    params: [
      num("speed", "移动速度", 50, 5, 300, "px/s", ""),
      ref("routeTag", "路径标签", "tag", "给路径点对象打上同一个标签，例如「巡逻路线A」"),
      bool("loop", "循环 Loop", true, "关掉则走到终点就停下"),
      ref("onArrive", "到达时调用", "tag", "可选：填另一个模块的「调用名」，走到终点后触发它")
    ]
  },
  {
    id: "move.pushable",
    title: "可被推动",
    code: "Pushable",
    category: "move",
    blurb: "玩家顶上去能把它推开",
    detail: "适合箱子、木桶、石块。打开后参与物理推挤，质量越大越难推。",
    triggers: [],
    params: [
      num("mass", "质量 Mass", 1, 0.1, 50, "kg", "越大越推不动"),
      bool("fallOffEdge", "可掉下边缘", false, "关掉则永远浮在原地")
    ]
  },
  {
    id: "move.locked",
    title: "固定不动",
    code: "Static",
    category: "move",
    blurb: "任何力量都推不动它",
    detail: "适合墙壁、山体、大树这类地形物件。它自己不移动，也不会被别的模块挪走。",
    triggers: [],
    params: []
  },
  {
    id: "move.flee",
    title: "远离玩家移动",
    code: "Flee",
    category: "move",
    blurb: "玩家靠近就往反方向跑",
    detail: "适合胆小的小动物、怕光的怪物。逃离时会优先选没有碰撞体的方向。",
    triggers: ["ALWAYS"],
    params: [
      num("speed", "移动速度", 70, 5, 400, "px/s", ""),
      num("fearRange", "恐惧范围", 140, 20, 800, "px", "玩家进入这个距离就开始逃"),
      bool("giveUp", "拉开距离后停止", true, "关掉会一直逃到地图边界")
    ]
  },
  {
    id: "move.gridSnap",
    title: "对齐到网格",
    code: "Snap To Grid",
    category: "move",
    blurb: "移动结束后自动吸附到格子中心",
    detail: "适合推箱子、战棋式走位。让所有物件永远落在整齐的格子上，画面不歪。",
    triggers: ["ALWAYS"],
    params: [bool("onlyAfterMove", "仅在移动后吸附", true, "关掉则每帧都强行对齐，拖动时会很黏")]
  },

  // ===== 渲染 Rendering =====
  {
    id: "render.directional",
    title: "四方向行走动画",
    code: "Directional Animation",
    category: "render",
    blurb: "按移动方向自动切换四组或八组行走序列帧",
    detail: "俯视角 RPG 的标准配置。只要素材按 下/左/右/上 分组命名好，这里不需要填任何东西。",
    triggers: [],
    params: [
      pick("directions", "方向数 Directions", "四方向 4-Way", ["四方向 4-Way", "八方向 8-Way", "不转向"], "四方向素材量少一半，八方向过渡更顺"),
      num("frameRate", "帧率 Frame Rate", 8, 1, 30, "fps", "走路动画每秒播几帧"),
      txt("idleName", "待机序列名", "待机", "找不到时退回播放首帧")
    ]
  },
  {
    id: "render.playOnce",
    title: "播放一次后停住",
    code: "Play Once",
    category: "render",
    blurb: "某个动作只播一遍，播完停在最后一帧",
    detail: "适合开门、爆炸、挥刀。和循环播放互斥，不要同时挂。",
    triggers: ["ON_CALLED", "ON_CLICK", "ON_START"],
    params: [
      ref("asset", "序列帧素材", "asset", "从素材库选一条序列帧或图集"),
      num("frameRate", "帧率 Frame Rate", 12, 1, 60, "fps", ""),
      pick("onFinish", "播完后 Hide / Keep", "保持最后一帧 Keep", ["保持最后一帧 Keep", "隐藏 Hide", "恢复默认 Restore"], "决定动作结束后停在哪一帧"),
      ref("thenCall", "播完后调用", "tag", "可选：填另一个模块的「调用名」")
    ]
  },
  {
    id: "render.blink",
    title: "闪烁",
    code: "Blink",
    category: "render",
    blurb: "明暗或可见度周期性变化",
    detail: "适合发光水晶、警示灯、任务提示点。比加粒子特效便宜得多，观感也不差。",
    triggers: ["ALWAYS"],
    params: [
      num("period", "周期 Period", 1.2, 0.1, 20, "s", "一次完整亮灭循环的时长"),
      num("minAlpha", "最低透明度 Min Alpha", 0.35, 0, 1, "×", "1 表示不闪"),
      bool("pulseScale", "同时缩放脉动", false, "像在呼吸")
    ]
  },
  {
    id: "render.shadow",
    title: "投射阴影",
    code: "Drop Shadow",
    category: "render",
    blurb: "在脚下画一圈椭圆阴影",
    detail: "俯视角「贴地感」最有效的来源。人物、箱子、树都建议加上。",
    triggers: [],
    params: [
      num("width", "阴影宽 Width", 28, 4, 400, "px", ""),
      num("height", "阴影高 Height", 12, 2, 400, "px", "俯视角一般取宽的一半"),
      num("alpha", "透明度 Alpha", 0.35, 0, 1, "×", "")
    ]
  },
  {
    id: "render.sortByY",
    title: "按 Y 轴排序遮挡",
    code: "Sort By Y Position",
    category: "render",
    blurb: "位置更靠下的对象盖住靠上的",
    detail: "俯视角 2D 必须开启，否则人物会穿过桌子、树冠会盖住头顶。",
    triggers: [],
    params: []
  },
  {
    id: "render.light",
    title: "点光源",
    code: "Point Light",
    category: "render",
    blurb: "在周围照亮一圈",
    detail: "适合火把、路灯、魔法阵。夜间场景的氛围主力。",
    triggers: [],
    params: [
      num("radius", "光照半径 Radius", 140, 16, 1200, "px", ""),
      txt("color", "颜色 Color", "#FFC978", "十六进制色值，如 #80CCFF"),
      num("intensity", "强度 Intensity", 0.8, 0, 2, "×", ""),
      bool("flicker", "火焰抖动", false, "像火苗一样轻微变化")
    ]
  },

  // ===== 检测 Detection =====
  {
    id: "detect.collider",
    title: "碰撞体 · 阻挡",
    code: "Collider 2D · Block",
    category: "detect",
    blurb: "别人走不过去（墙、家具、水）",
    detail: "俯视角地图的墙模块。它不主动做任何事，只负责挡住别的物体。"
      + "水的处理通常不是阻挡，而是用「踏上地块时」配减速或掉血。",
    triggers: [],
    params: [
      pick("shape", "碰撞范围 Shape", "整块 Full Tile", ["整块 Full Tile", "按精灵轮廓 Sprite Bounds"], "贴图不规则时用精灵轮廓更自然"),
      bool("transparentToSight", "不阻挡视线", false, "打开后敌人能隔着它看见你"),
      bool("blockFlying", "也阻挡飞行", false, "关掉则带飞行标记的对象可以越过")
    ]
  },
  {
    id: "detect.range",
    title: "检测范围内对象",
    code: "Range Check",
    category: "detect",
    blurb: "检查以自己为圆心的一圈里有什么",
    detail: "所有范围检查的总开关。它只做判断，不产生反应 —— 反应交给「事件」类模块。"
      + "需要持续判定的场合，配「变量条件」或「进入/离开触发区」使用。",
    triggers: ["ALWAYS", "ON_TIMER", "ON_VARIABLE"],
    params: [
      num("radius", "检测半径 Radius", 96, 4, 2000, "px", ""),
      pick("targetType", "检测目标 Target", "玩家 Player", ["玩家 Player", "所有角色 All Actors", "指定标签 By Tag", "任意对象 Any"], ""),
      ref("tag", "指定标签 Tag", "tag", "上一步选「指定标签」时使用"),
      bool("requireLineOfSight", "需要视线", false, "打开后被墙挡住就不算在范围内"),
      txt("resultVariable", "结果存入变量", "范围内有目标", "其他模块可按这个变量名读取 true / false")
    ]
  },
  {
    id: "detect.distance",
    title: "计算到玩家的距离",
    code: "Distance To Player",
    category: "detect",
    blurb: "把距离写进变量，供其他模块判断",
    detail: "用于「太远就不追」「近到一定程度才开口」这类逻辑。数值存进变量后，其他模块按名字读取。",
    triggers: ["ALWAYS"],
    params: [
      txt("variable", "变量名 Variable", "距离", "起个好记的名字，其他模块按它读取"),
      bool("roundToTile", "取整到格", true, "关掉则保留精确像素值")
    ]
  },
  {
    id: "detect.lineOfSight",
    title: "视线检测",
    code: "Line Of Sight",
    category: "detect",
    blurb: "直线中间没有阻挡就算看得见",
    detail: "潜行玩法的基础：躲在箱子后面就看不见了。也会受「不阻挡视线」标记影响。",
    triggers: ["ALWAYS", "ON_TIMER"],
    params: [
      num("range", "视野距离 Range", 260, 8, 1600, "px", ""),
      num("fieldOfView", "视野角度 FOV", 120, 10, 360, "°", "360 表示不需要转头就能看到"),
      bool("instant", "立即发现 Instant", true, "关掉则需要持续注视一段时间才被发现"),
      num("detectTime", "发现所需时间", 0.8, 0.1, 10, "s", "仅在关闭「立即发现」时有效")
    ]
  },
  {
    id: "detect.onTile",
    title: "踏上地块时",
    code: "On Tile Enter",
    category: "detect",
    blurb: "判断脚下是什么地块并触发反应",
    detail: "用于「走在草丛里敌人看不见」「踩到岩浆掉血」「走进传送阵」。",
    triggers: ["ON_TRIGGER_ENTER"],
    params: [
      ref("tileTag", "地块标签 Tile Tag", "tag", "先给地块对象打标签，再在这里选择"),
      ref("thenCall", "踩上后调用", "tag", "填另一个模块的「调用名」")
    ]
  },
  {
    id: "detect.overlap",
    title: "重叠检测",
    code: "Overlap Check",
    category: "detect",
    blurb: "精确判断两个对象是否压在一起",
    detail: "比范围检测更准，但更耗性能。适合数量不多的关键物件，例如钥匙与锁孔。",
    triggers: ["ALWAYS", "ON_TIMER"],
    params: [
      ref("targetTag", "目标标签 Target Tag", "tag", ""),
      num("tolerance", "容差 Tolerance", 2, 0, 40, "px", "允许轻微的边缘重叠也算数"),
      ref("thenCall", "重叠时调用", "tag", "")
    ]
  },

  // ===== 事件 Events =====
  {
    id: "event.click",
    title: "点击时",
    code: "On Pointer Click",
    category: "event",
    blurb: "鼠标点中它时执行",
    detail: "点击模块的起点。可以限制点击距离，避免隔着半张地图点开宝箱。",
    triggers: ["ON_CLICK"],
    params: [
      ref("thenCall", "调用模块", "tag", "填另一个模块的「调用名」，例如「打开对话」"),
      num("maxClickDistance", "最大点击距离", 64, 0, 2000, "px", "0 表示不限距离"),
      bool("onlyOnce", "仅响应一次", false, "适合一次性机关")
    ]
  },
  {
    id: "event.triggerEnter",
    title: "进入触发区时",
    code: "On Trigger Enter",
    category: "event",
    blurb: "有对象进入触发区的那一刻执行一次",
    detail: "做伏击、开门、播剧情最常用的模块。注意：只触发进入那一次，停在范围里不会反复触发。",
    triggers: ["ON_TRIGGER_ENTER"],
    params: [
      num("radius", "触发半径 Radius", 120, 4, 2000, "px", "触发区对象可忽略此项，直接用它自身的尺寸"),
      pick("who", "触发对象 Who", "玩家 Player", ["玩家 Player", "所有角色 All Actors", "任意对象 Any"], ""),
      ref("thenCall", "进入后调用", "tag", ""),
      bool("once", "仅触发一次", false, "适合一次性剧情")
    ]
  },
  {
    id: "event.triggerExit",
    title: "离开触发区时",
    code: "On Trigger Exit",
    category: "event",
    blurb: "有对象离开触发区时执行一次",
    detail: "与「进入触发区时」成对使用，例如进房间开灯、出房间关灯。",
    triggers: ["ON_TRIGGER_EXIT"],
    params: [
      num("radius", "触发半径 Radius", 120, 4, 2000, "px", ""),
      ref("thenCall", "离开后调用", "tag", "")
    ]
  },
  {
    id: "event.timer",
    title: "计时器",
    code: "Timer",
    category: "event",
    blurb: "过一段时间后执行，可设为反复触发",
    detail: "适合刷怪、定时机关、限时任务。反复触发时，每次间隔从上次执行完开始算。",
    triggers: ["ON_TIMER"],
    params: [
      num("interval", "间隔时间 Interval", 3, 0.1, 600, "s", ""),
      bool("repeat", "反复触发 Repeat", false, "打开后每隔这么久执行一次"),
      bool("startOnLoad", "场景加载后立即开始", true, "关掉则要等第一次被调用才计时"),
      ref("thenCall", "到点时调用", "tag", "")
    ]
  },
  {
    id: "event.variable",
    title: "变量条件",
    code: "Variable Condition",
    category: "event",
    blurb: "存档变量满足条件时执行",
    detail: "任务链的基础：集齐 3 把钥匙、好感度到 50、击败数到 10。变量在剧本里用 $名字 记录。",
    triggers: ["ON_VARIABLE"],
    params: [
      txt("variable", "变量名 Variable", "", "剧本里 <<set $钥匙数 = 3>> 记录的那个名字"),
      pick("compare", "比较方式 Compare", "大于等于 >=", ["大于等于 >=", "小于等于 <=", "等于 ==", "不等于 !="], ""),
      txt("value", "比较值 Value", "1", ""),
      ref("thenCall", "满足时调用", "tag", ""),
      bool("once", "仅触发一次", true, "")
    ]
  },
  {
    id: "event.invoke",
    title: "可被调用",
    code: "Invokable",
    category: "event",
    blurb: "只有当别的模块按名字叫它时才执行",
    detail: "把一段逻辑打包成可复用动作：给这块积木起个「调用名」，其他积木在「调用模块」里填这个名字。"
      + "这是模块拼接复用的关键，也是规则包的基础。",
    triggers: ["ON_CALLED"],
    params: [
      txt("callName", "调用名 Invoke Name", "开场白", "别的模块会按这个名字调用它，建议取有意义的名字")
    ]
  },
  {
    id: "event.condition",
    title: "条件开关",
    code: "Condition Gate",
    category: "event",
    blurb: "给同一对象上的其他模块加一道生效条件",
    detail: "用于「白天不出现」「拿到钥匙后才会说话」。条件不满足时，同一对象上被它管的模块不工作；"
      + "打开「不满足时隐藏」还会把对象本身藏起来。",
    triggers: ["ALWAYS"],
    params: [
      txt("expression", "条件表达式", "", "例如：$钥匙数 >= 1　或　$见过老人 == true"),
      bool("hideWhenFalse", "不满足时隐藏自己", false, "")
    ]
  },

  // ===== 战斗 Combat =====
  {
    id: "combat.health",
    title: "生命值",
    code: "Health",
    category: "combat",
    blurb: "给它一条生命值，可被消耗到 0",
    detail: "所有能被打的对象都需要这块。归零时走「生命值归零」的积木。",
    triggers: [],
    params: [
      num("maxHealth", "生命值上限 Max Health", 100, 1, 100000, "HP", ""),
      num("defense", "防御 Defense", 0, 0, 1000, "点", "每次受到的伤害减去这个值"),
      bool("showBar", "显示血条 Health Bar", true, "只在受伤或靠近时显示更干净"),
      bool("invincible", "无敌 Invincible", false, "调试或剧情保护用")
    ]
  },
  {
    id: "combat.melee",
    title: "近战攻击",
    code: "Melee Attack",
    category: "combat",
    blurb: "目标进入攻击距离就出手一次",
    detail: "近战怪的基础模块。抬手时间给玩家反应机会，是手感的来源，不建议设成 0。",
    triggers: ["ALWAYS"],
    params: [
      num("attackRange", "攻击距离 Attack Range", 40, 8, 400, "px", ""),
      num("damage", "伤害 Damage", 10, 0, 100000, "点", ""),
      num("cooldown", "攻击间隔 Cooldown", 1.2, 0.1, 30, "s", ""),
      num("windUp", "抬手时间 Wind Up", 0.25, 0, 3, "s", "出手前的预警时间，0 会让攻击无法躲避"),
      ref("attackAnim", "攻击动画", "asset", "留空则只结算数值伤害")
    ]
  },
  {
    id: "combat.projectile",
    title: "发射投射物",
    code: "Projectile",
    category: "combat",
    blurb: "朝目标方向发射会飞的东西",
    detail: "适合法师、炮台、激光。撞到带碰撞体的物件会消失，除非打开穿透。",
    triggers: ["ALWAYS", "ON_TIMER"],
    params: [
      num("speed", "飞行速度 Speed", 200, 20, 1500, "px/s", ""),
      num("damage", "伤害 Damage", 12, 0, 100000, "点", ""),
      num("cooldown", "发射间隔 Cooldown", 1.6, 0.1, 60, "s", ""),
      ref("projectileSprite", "投射物精灵", "asset", ""),
      num("lifetime", "存在时间 Lifetime", 3, 0.2, 60, "s", "防止子弹永远飞下去"),
      bool("pierce", "穿透 Pierce", false, "命中后继续飞")
    ]
  },
  {
    id: "combat.onDamage",
    title: "受到伤害时",
    code: "On Take Damage",
    category: "combat",
    blurb: "被打中时执行的动作",
    detail: "配「生命值」使用。常见组合：闪白 + 后退 + 受伤音效 + 血条变化。"
      + "闪白是最便宜的命中反馈，务必保留。",
    triggers: ["ON_DAMAGE"],
    params: [
      bool("flash", "闪白 Flash", true, ""),
      bool("knockback", "击退 Knockback", true, ""),
      num("knockbackDistance", "击退距离", 12, 0, 300, "px", ""),
      ref("hurtSfx", "受伤音效", "asset", ""),
      ref("thenCall", "随后调用", "tag", "")
    ]
  },
  {
    id: "combat.onDeath",
    title: "生命值归零时",
    code: "On Death",
    category: "combat",
    blurb: "死亡后执行的动作",
    detail: "可以做掉落、播放死亡动画、留下尸体或直接消失。「留下尸体」适合做可搜刮的体验。",
    triggers: ["ON_DEATH"],
    params: [
      pick("disappear", "消失方式 Despawn", "淡出后消失 Fade Out", ["立即消失 Instant", "淡出后消失 Fade Out", "留下尸体 Leave Corpse"], ""),
      ref("dropSprite", "掉落物", "asset", "留空表示不掉落"),
      num("experience", "经验值 Experience", 0, 0, 1000000, "点", ""),
      ref("thenCall", "随后调用", "tag", ""),
      bool("respawn", "可重生 Respawn", false, "刷怪点用；重生位置取出生点")
    ]
  },
  {
    id: "combat.invulnerable",
    title: "受伤后短暂无敌",
    code: "Invulnerability Window",
    category: "combat",
    blurb: "挨打后有一小段时间不再掉血",
    detail: "防止一段受击动画里被连续打十几下。主角必加。",
    triggers: [],
    params: [
      num("duration", "无敌时长 Duration", 0.8, 0.05, 10, "s", ""),
      bool("blink", "无敌期间闪烁", true, "给玩家明确的视觉反馈")
    ]
  },

  // ===== 对话 Dialogue =====
  {
    id: "dialogue.bubble",
    title: "头顶气泡台词",
    code: "Speech Bubble",
    category: "dialogue",
    blurb: "在角色头顶弹一句会飘走的话",
    detail: "适合路人闲聊、怪物喊话。不打断操作，观感轻，适合高频使用。",
    triggers: ["ON_CALLED", "ON_CLICK", "ON_START"],
    params: [
      txt("text", "台词 Text", "……", "支持 $变量名 引用存档里的值"),
      num("duration", "持续时间 Duration", 2.5, 0.5, 30, "s", ""),
      num("riseDistance", "上浮距离", 12, 0, 200, "px", "")
    ]
  },
  {
    id: "dialogue.conversation",
    title: "打开对话框",
    code: "Start Dialogue",
    category: "dialogue",
    blurb: "打开对话框并运行一段 Yarn 剧本",
    detail: "剧情的入口。剧本在左栏「剧本」页用 Yarn Spinner 语法编写，可直接用社区工具互通。",
    triggers: ["ON_CALLED", "ON_INTERACT", "ON_CLICK", "ON_TRIGGER_ENTER"],
    params: [
      ref("script", "剧本 Script", "script", "从左侧剧本列表选择"),
      txt("startNode", "起始节点 Node", "", "留空则从剧本第一个节点开始"),
      bool("lockMovement", "对话时锁定移动", true, "重要剧情建议开启"),
      ref("portrait", "头像 Portrait", "asset", "留空则不显示头像")
    ]
  },
  {
    id: "dialogue.choice",
    title: "分支选项",
    code: "Choice Options",
    category: "dialogue",
    blurb: "弹出几个选项让玩家挑一个",
    detail: "也可以在剧本里用 -> 写分支；这里适合临时的小选择（要不要花 50 块钱买药）。",
    triggers: ["ON_CALLED", "ON_CLICK"],
    params: [
      txt("question", "问题 Prompt", "要买吗？", ""),
      txt("options", "选项 Options", "买|不买", "用竖线分隔，最多四个"),
      txt("results", "各自跳转", "", "与选项顺序一一对应，填剧本节点名"),
      bool("cancellable", "允许取消", true, "关掉则必须选一个才能继续")
    ]
  },
  {
    id: "dialogue.interact",
    title: "交互键互动",
    code: "Player Interact",
    category: "dialogue",
    blurb: "玩家走近并按下交互键时触发",
    detail: "RPG 中和 NPC 说话的标准做法。会自动在头顶显示一个小小的提示图标。",
    triggers: ["ON_INTERACT"],
    params: [
      num("interactRange", "交互距离 Range", 48, 8, 300, "px", ""),
      ref("thenCall", "交互后调用", "tag", "通常填「打开对话框」的调用名"),
      ref("promptIcon", "提示图标", "asset", "留空使用默认的对话图标")
    ]
  },

  // ===== 表现 Feedback =====
  {
    id: "fx.sfx",
    title: "播放音效",
    code: "Play Sound",
    category: "fx",
    blurb: "播放一个短音效",
    detail: "走路、开箱、命中、拾取都用它。同屏大量播放会自动限流，不会爆音。",
    triggers: ["ON_CALLED", "ON_CLICK", "ON_TRIGGER_ENTER", "ON_START", "ON_DAMAGE"],
    params: [
      ref("asset", "音频素材", "asset", "从素材库选一条音频"),
      num("volume", "音量 Volume", 1, 0, 1, "×", ""),
      bool("positional", "按距离衰减", true, "俯视角建议开启，空间感强很多")
    ]
  },
  {
    id: "fx.bgm",
    title: "切换背景音乐",
    code: "Play Music",
    category: "fx",
    blurb: "换掉正在播的音乐，可淡入淡出",
    detail: "同一时刻只会有一首 BGM。重复调用同一首不会重头再播。",
    triggers: ["ON_START", "ON_SCENE_START", "ON_TRIGGER_ENTER", "ON_CALLED"],
    params: [
      ref("asset", "音乐素材", "asset", ""),
      num("fadeIn", "淡入时长", 1.5, 0, 30, "s", ""),
      bool("loop", "循环 Loop", true, "")
    ]
  },
  {
    id: "fx.effect",
    title: "播放特效",
    code: "Spawn VFX",
    category: "fx",
    blurb: "在某处播放一段序列帧特效",
    detail: "受击火花、升级光芒、传送漩涡。播完自动回收，不需要手动清理。",
    triggers: ["ON_CALLED", "ON_CLICK", "ON_DAMAGE", "ON_DEATH", "ON_TRIGGER_ENTER"],
    params: [
      ref("asset", "特效序列帧", "asset", ""),
      num("scale", "缩放 Scale", 1, 0.1, 10, "×", ""),
      num("lifetime", "持续时间", 1, 0.05, 60, "s", ""),
      bool("followTarget", "跟随对象", true, "关掉则留在原地")
    ]
  },
  {
    id: "fx.shake",
    title: "镜头震动",
    code: "Camera Shake",
    category: "fx",
    blurb: "让镜头抖一下",
    detail: "打击感的关键。轻击用小数值短时长，重击用大数值稍长。别滥用，抖多了会腻。",
    triggers: ["ON_CALLED", "ON_DAMAGE", "ON_DEATH", "ON_CLICK"],
    params: [
      num("amplitude", "幅度 Amplitude", 6, 0, 200, "px", ""),
      num("duration", "时长 Duration", 0.22, 0.05, 5, "s", ""),
      ref("sfx", "同时播放音效", "asset", "留空则不播")
    ]
  },
  {
    id: "fx.loadScene",
    title: "加载另一张地图",
    code: "Load Scene",
    category: "fx",
    blurb: "切换场景并把玩家放到指定出生点",
    detail: "配「传送口」使用。切换时自动淡出淡入，不会突兀。",
    triggers: ["ON_TRIGGER_ENTER", "ON_CALLED", "ON_CLICK"],
    params: [
      txt("sceneName", "目标场景", "", "填左侧场景列表里的名字"),
      ref("spawnPoint", "目标出生点", "obj", "留空则落到该场景的第一个出生点"),
      num("fadeTime", "黑屏过渡", 0.35, 0, 5, "s", ""),
      bool("keepMusic", "音乐不断", true, "")
    ]
  },
  {
    id: "fx.cameraFollow",
    title: "镜头跟随",
    code: "Camera Follow",
    category: "fx",
    blurb: "把镜头挂到它身上",
    detail: "主角必加。可以限制镜头范围，避免拍到地图外的空白。",
    triggers: ["ALWAYS"],
    params: [
      num("smoothing", "跟随平滑 Smoothing", 0.15, 0, 1, "×", "越小越跟手，越大越慵懒"),
      num("lookAhead", "前视距离 Look Ahead", 24, 0, 300, "px", "朝移动方向多带一点，让玩家早看到前方"),
      bool("clampToMap", "限制在地图内", true, "打开后镜头不会拍到地图外")
    ]
  },

  // ===== 玩法 Gameplay =====
  {
    id: "script.js",
    title: "对象脚本",
    code: "Script (JS)",
    category: "game",
    blurb: "给这个对象挂一段 JS 脚本，按事件调用同名函数",
    detail: "脚本在左栏「剧本」页用 JS 语言新建，函数名就是触发时机：onStart / onUpdate / onClick / onInteract / onDamage / onDeath 等，"
      + "没写的函数直接跳过。「有模块负责默认行为，脚本再加一层逻辑」，两者共存不打架。"
      + "脚本里的 ctx.self 就是挂脚本的这个对象，可用 bwe.* 访问世界、输入、相机、绘制、存档等能力（见「剧本」页的 API 速查）。",
    triggers: ["ALWAYS"],
    params: [ref("script", "脚本 Script", "script", "在左栏「剧本」页切到 JS 语言，新建一个脚本再回到这里选择")]
  },
  // ---------------- 通用网格模块（可组合，任何格子类玩法复用） ----------------
  //
  // 设计意图：扫雷原本是「一整个游戏 = 一个模块」（game.minesweeper），
  // 别的玩法想复用棋盘/渲染/翻开规则只能复制那 600 行。
  // 这里拆成 4 个正交能力，按需组合；game.minesweeper 仍然保留为「全开」组合体，
  // 所以老工程零迁移、行为不变。
  {
    id: "grid.board",
    title: "网格棋盘",
    code: "Grid Board",
    category: "grid",
    blurb: "一块可交互的行列格子，带翻开/标记状态与邻域计算",
    detail: "只提供「格子」这一层：行数、列数、格子尺寸，每格的翻开/标记状态，"
      + "以及邻域遍历与泛洪展开 —— 不含任何具体玩法规则。"
      + "适合数织、围线、战棋、消除、推箱子这类「网格 + 每格状态」的玩法："
      + "挂上它就能在脚本里读写格子状态、做连通判定，规则完全由你的脚本决定。"
      + "要开箱即用的扫雷，直接用「扫雷棋盘」模块。",
    triggers: ["ON_START", "ALWAYS"],
    params: [
      num("rows", "行数 Rows", 10, 1, 64, "行", "棋盘纵向格数"),
      num("cols", "列数 Cols", 10, 1, 64, "列", "棋盘横向格数"),
      num("cellSize", "格子尺寸 Cell Size", 32, 8, 96, "px", "每一格的世界尺寸，也决定棋盘整体大小")
    ]
  },
  {
    id: "grid.tile",
    title: "格子渲染",
    code: "Grid Tile Render",
    category: "grid",
    blurb: "把网格画成 Win9x 立体地砖 / 平铺 / 自定义贴图",
    detail: "只负责「怎么把格子画出来」：未翻开画凸起 3D 地砖（亮边+暗边+银灰底），"
      + "已翻开画平铺底+格线，可选叠加素材图。数字按大小自动配色（1 蓝、2 绿、3 红…）。"
      + "搭配「网格棋盘」使用；想换外观就换这里的贴图参数，不用改玩法逻辑。",
    triggers: ["ALWAYS"],
    params: [
      ref("hiddenAsset", "未翻开贴图", "asset", "留空使用内置凸起地砖"),
      ref("mineAsset", "地雷贴图", "asset", "留空使用内置黑色地雷"),
      ref("flagAsset", "旗帜贴图", "asset", "留空使用内置红旗")
    ]
  },
  {
    id: "grid.reveal",
    title: "翻开规则",
    code: "Grid Reveal Rules",
    category: "grid",
    blurb: "点开格子的行为：首击安全、空白自动展开、失败全亮、点数字自动标记/翻开",
    detail: "提供「点开」这套通用行为：首次点击保证安全（自身与周围不埋雷）、"
      + "点到空白格时自动展开相连区域、踩中即判负并可亮出全部雷。"
      + "「点数字自动操作」开启后，点一个已翻开的数字格会按周围旗数自动推断："
      + "旗数够了就把剩余格翻开，剩余格数正好等于数字就把它们全部插旗（两者都做 = 智能模式）。"
      + "推断只用「数字 + 你自己插的旗」，不读隐藏雷位，所以不会替你作弊；条件不满足时什么都不做。",
    triggers: ["ALWAYS"],
    params: [
      bool("firstClickSafe", "首击必安全", true, "第一次点开的格子以及周围八格不埋雷"),
      bool("autoOpenZeros", "自动展开空白区", true, "点开空白格时自动翻开相连的一圈"),
      bool("revealAllOnLose", "失败时显示全部", true, "踩中后把全部目标格亮出来，方便复盘"),
      pick("autoAction", "点数字自动操作", "关闭 Off", ["关闭 Off", "自动翻开 Auto Reveal", "自动插旗 Auto Flag", "智能 Smart（先插旗再翻开）"], "点已翻开的数字格时按旗数自动推断：旗数==数字→翻开其余安全格；未翻开数==数字→把它们全插旗。只用可见信息推断，绝不作弊")
    ]
  },
  {
    id: "grid.flag",
    title: "标记规则",
    code: "Grid Flag Rules",
    category: "grid",
    blurb: "插旗/取消插旗、计数与胜利条件",
    detail: "提供「标记 + 达成条件」这套通用行为：右键（手机上长按）切换插旗状态、"
      + "维护旗帜计数、按选定条件判定胜利（清空所有安全格 / 标记全部目标），"
      + "并可选显示计时器。和「网格棋盘」「翻开规则」组合即可拼出完整玩法。",
    triggers: ["ALWAYS"],
    params: [
      bool("rightClickFlag", "右键插旗", true, "关掉后可改用脚本函数切换标记"),
      pick("winCondition", "胜利条件 Win", "清空所有安全格 Clear Safe Cells", ["清空所有安全格 Clear Safe Cells", "插对所有地雷 Flag All Mines"], "前者是传统玩法；后者只看标记是否全对"),
      bool("showTimer", "显示计时器", true, "从第一次操作开始计时")
    ]
  },
  {
    id: "game.minesweeper",
    title: "扫雷棋盘",
    code: "Minesweeper Board",
    category: "game",
    blurb: "一整块可自定义行、列、地雷数的扫雷棋盘",
    detail: "把这块积木挂到一个对象上，预览时就会生成完整棋盘：左键翻开、右键插旗、空白区自动展开、首击必安全。"
      + "行数、列数、地雷数都在参数里改，改完点「重新开始」立刻生效。"
      + "贴图参数留空时使用内置样式；填入素材名即可替换成自己的地砖、地雷和旗帜。"
      + "「玩法模式」选「复雷加殊（Complexweeper）」时，雷分成 +1/−1/+i/−i 四种复数，"
      + "格子上的数字显示周围雷之和的模长；点已翻开的数字格可连锁翻开（需旗数与虚实比例都对，不需标出每颗雷的属性）。",
    triggers: ["ON_START", "ALWAYS"],
    params: [
      num("rows", "行数 Rows", 10, 3, 64, "行", "棋盘纵向格数。上限 64：64×64 格 × 32px = 2048px 正好等于地图边长，再大棋盘就超出地图，手机上双指平移会被地图范围钳死、边缘格子拖不到"),
      num("cols", "列数 Cols", 10, 3, 64, "列", "棋盘横向格数。上限 64 同行数（棋盘不能超过地图 2048px）"),
      num("mines", "地雷数 Mines", 10, 1, 2000, "颗", "不能超过总格数减 9，否则首击保护没有安全区；64×64 = 4096 格"),
      num("cellSize", "格子尺寸 Cell Size", 32, 16, 64, "px", "预览里每一格显示多大"),
      pick("mode", "玩法模式 Mode", "普通 Normal", ["普通 Normal", "复雷加殊 Complexweeper"], "普通 = 经典扫雷；复雷加殊 = 雷分 +1/−1/+i/−i 四种复数，数字显示周围雷之和的模长"),
      pick("winCondition", "胜利条件 Win", "清空所有安全格 Clear Safe Cells", ["清空所有安全格 Clear Safe Cells", "插对所有地雷 Flag All Mines"], "前者是传统扫雷；后者只看旗帜是否全对"),
      bool("firstClickSafe", "首击必安全", true, "第一次点开的格子以及周围八格不埋雷"),
      bool("rightClickFlag", "右键插旗", true, "关掉后仍可用预览里的「标记模式」按钮插旗"),
      bool("autoOpenZeros", "自动展开空白区", true, "点开数字 0 的格子时，自动翻开周围一圈"),
      bool("revealAllOnLose", "失败时显示全部地雷", true, "踩雷后把所有地雷亮出来，方便复盘"),
      pick("autoAction", "点数字自动操作", "关闭 Off", ["关闭 Off", "自动翻开 Auto Reveal", "自动插旗 Auto Flag", "智能 Smart（先插旗再翻开）"], "点已翻开的数字格时按旗数自动推断：旗数==数字→翻开其余安全格；未翻开数==数字→把它们全插旗。只用可见信息推断，绝不作弊"),
      bool("showTimer", "显示计时器", true, "从第一次翻开开始计时"),
      num("seed", "随机种子 Seed", 0, 0, 999999, "", "0 表示每局随机；填固定数字可以复现同一局"),
      ref("hiddenAsset", "未翻开贴图", "asset", "留空使用内置的凸起地砖"),
      ref("mineAsset", "地雷贴图", "asset", "留空使用内置的黑色地雷"),
      ref("flagAsset", "旗帜贴图", "asset", "留空使用内置的红旗")
    ]
  },
  {
    id: "game.dressPart",
    title: "换装部件",
    code: "Dress-up Part",
    category: "game",
    blurb: "一个可以切换多套造型的角色部件",
    detail: "把角色拆成头发、上装、下装、鞋子、配饰等若干对象，每个对象挂一块「换装部件」。"
      + "「造型列表」填显示名，「素材列表」按同样顺序填素材库里的素材名；运行时点选标签页就能换。"
      + "缺图时会用「缺图时颜色」画一个占位块，不会让部件凭空消失。",
    triggers: [],
    params: [
      pick("slot", "部位 Slot", "发型 Hair", ["身体 Body", "发型 Hair", "上装 Top", "下装 Bottom", "鞋子 Shoes", "配饰 Accessory", "脸部 Face", "其他 Other"], "决定衣橱里标签页的名字与顺序"),
      txt("options", "造型列表 Options", "造型 A,造型 B", "用逗号或竖线分隔，例如：短发,长发,马尾"),
      txt("optionAssets", "素材列表 Assets", "", "与造型列表一一对应，填素材库里的素材名；留空则显示色块"),
      num("defaultIndex", "默认造型 Index", 0, 0, 99, "", "从 0 开始；超出范围会自动夹到最后一个"),
      num("offsetX", "水平偏移 Offset X", 0, -400, 400, "px", "相对对象位置的左右微调"),
      num("offsetY", "垂直偏移 Offset Y", 0, -400, 400, "px", "相对对象位置的上下微调"),
      num("partScale", "部件缩放 Scale", 1, 0.1, 4, "×", "只缩放这一层，不影响其他部件"),
      txt("fallbackColor", "缺图时颜色", "#4c8dff", "支持 #RRGGBB 或 CSS 颜色名"),
      bool("followBody", "跟随身体", true, "身体移动时这一层跟着移动")
    ]
  },
  {
    id: "game.dressup",
    title: "换装衣橱",
    code: "Dress-up Wardrobe",
    category: "game",
    blurb: "把场景里的「换装部件」组织成可点选的衣橱",
    detail: "场景里放一个控制器对象挂这块积木，再给每个部件对象挂「换装部件」。"
      + "预览时自动按部位生成标签页，点造型即可换装。控制器只负责界面和规则，不直接画角色。",
    triggers: ["ON_START"],
    params: [
      txt("title", "标题 Title", "换装间", "显示在预览窗口顶部"),
      ref("backgroundAsset", "背景素材", "asset", "留空使用内置的浅色背景"),
      txt("partTag", "部件标签", "换装部件", "只收集带这个标签的对象；留空表示收集全部「换装部件」"),
      bool("showTabs", "显示部位标签", true, "关掉后只显示舞台，适合做成品展示"),
      bool("allowReset", "允许重置", true, "显示「穿回默认」按钮"),
      bool("persist", "记住玩家选择", false, "保存在浏览器本地，下次打开预览还是这套搭配"),
      num("stageWidth", "舞台宽 Width", 640, 200, 2000, "px", "预览窗口的最大舞台宽度"),
      num("stageHeight", "舞台高 Height", 480, 150, 2000, "px", "舞台按这个宽高比缩放"),
      pick("fit", "舞台适配 Fit", "等比缩放 Contain", ["等比缩放 Contain", "铺满 Cover"], "背景图比舞台宽高比更宽时，Contain 会留边，Cover 会裁切")
    ]
  }
];

/** 按 id 取模块定义。 */
export function moduleDef(id: string): ModuleDef | undefined {
  return MODULES.find((m) => m.id === id);
}

export function modulesOfCategory(id: ModuleCategoryId): ModuleDef[] {
  return MODULES.filter((m) => m.category === id);
}

/** 模糊搜索：模块名、英文名、说明、参数名都参与匹配。 */
export function searchModules(q: string): ModuleDef[] {
  const k = q.trim().toLowerCase();
  if (!k) return MODULES;
  return MODULES.filter((m) => {
    if (m.title.toLowerCase().includes(k)) return true;
    if (m.code.toLowerCase().includes(k)) return true;
    if (m.blurb.toLowerCase().includes(k)) return true;
    if (m.detail.toLowerCase().includes(k)) return true;
    if (categoryOf(m.category).label.toLowerCase().includes(k)) return true;
    return m.params.some((p) => p.label.toLowerCase().includes(k) || p.key.toLowerCase().includes(k));
  });
}

/** 模块摘要：折叠状态下显示一行，例如「移动速度 60 · 检测范围 200」 */
export function moduleSummary(def: ModuleDef | undefined, inst: import("../core/model.ts").ModuleInstance): string {
  if (!def) return inst.defId;
  if (!def.params.length) return def.blurb;
  const parts: string[] = [];
  for (const p of def.params) {
    if (p.type === "note") continue;
    const v = inst.values[p.key] ?? p.def;
    if (!v) continue;
    const short = p.type === "obj" || p.type === "asset" || p.type === "tag" || p.type === "script"
      ? "…" + v.slice(0, 6)
      : v + (p.unit ? p.unit : "");
    parts.push(short);
    if (parts.join(" · ").length > 30) break;
  }
  return parts.length ? parts.join(" · ") : def.blurb;
}

/** 生成一个模块实例（带全部默认值）。 */
export function makeInstance(def: ModuleDef): import("../core/model.ts").ModuleInstance {
  const values: Record<string, string> = {};
  for (const p of def.params) {
    if (p.type !== "note") values[p.key] = p.def;
  }
  return {
    defId: def.id,
    trigger: def.triggers.length ? def.triggers[0] : null,
    values,
    enabled: true,
    collapsed: true
  };
}
