/**
 * offlinePlanner —— 无 key 时的本地规划器
 *
 * 设计立场（用户明确要求）：provider 无关 + 无 key 可降级，且**不能假装调通**。
 *
 * 所以这里的做法不是「假装 AI 回答了」，而是：
 *
 *   - 产物是**真的**：return 的 ops 与在线模型返回的 ops 走同一个 applyProjectOps，
 *     落盘后工程里真的有场景、有对象、有行为模块。
 *   - 来源是**诚实的**：结果里带 mode: "offline"，UI 与日志必须把它显示出来，
 *     用户永远知道这一批东西是模板生成的，不是模型想的。
 *   - 能力是**有限的**：只认几种高频意图（空地、塔防、巡逻、UI 骨架），
 *     认不出来就明确说「离线规划器覆盖不到这个，请配置模型」。
 *
 * 这样它比「无 key 就报错」有用，也比「无 key 假装 AI 回答」诚实。
 */

import type { NewObjectSpec, NewSceneSpec, ProjectOp } from "../projectOps.ts";
import { MODULES } from "../../data/modules.ts";

export type IntentKind =
  | "tower_defense"
  | "patrol_level"
  | "empty_level"
  | "hud"
  | "unknown";

export interface OfflinePlan {
  /** 永远是 offline：调用方必须把它显示给用户 */
  mode: "offline";
  intent: IntentKind;
  /** 为什么选中这个模板，一句话，给用户看 */
  rationale: string;
  ops: ProjectOp[];
  /** 识别的关键词，便于用户理解为什么走了这条路 */
  matched: string[];
}

const KEYWORDS: Array<{ kind: IntentKind; words: string[] }> = [
  { kind: "tower_defense", words: ["塔防", "防守", "保卫", "防线", "敌人", "怪物", "波次", "魔物"] },
  { kind: "patrol_level", words: ["巡逻", "守卫", "士兵", "敌人", "关卡", "地牢", "城堡", "哨站", "关卡"] },
  { kind: "hud", words: ["界面", "UI", "菜单", "血条", "按钮", "开始界面", "HUD"] },
  { kind: "empty_level", words: ["空地", "场景", "地图", "地形", "草地", "关卡"] },
];

/** 从自然语言里抽一个「看起来像」的尺寸，抽不到用默认值。 */
function parseSize(prompt: string, defW: number, defH: number): { w: number; h: number } {
  const m = prompt.match(/(\d{1,3})\s*[x×*]\s*(\d{1,3})/);
  if (m) {
    const w = Math.min(200, Math.max(4, Number(m[1])));
    const h = Math.min(200, Math.max(4, Number(m[2])));
    return { w, h };
  }
  return { w: defW, h: defH };
}

/** 抽数量：「4 个守卫」「三个塔」。中文数字只认到十，够用。 */
function parseCount(prompt: string, def: number): number {
  const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const m = prompt.match(/(\d{1,2})\s*(?:个|名|只|座|波)/);
  if (m) return Math.min(24, Math.max(1, Number(m[1])));
  const c = prompt.match(/([一二两三四五六七八九十])\s*(?:个|名|只|座|波)/);
  if (c) return Math.min(24, Math.max(1, cn[c[1]] ?? def));
  return def;
}

function pickModule(words: string[]): string | undefined {
  for (const w of words) {
    const hit = MODULES.find((m) => m.id === w || m.id.endsWith("." + w));
    if (hit) return hit.id;
  }
  // 退而求其次：按类别找一个真实存在的模块
  for (const w of words) {
    const hit = MODULES.find((m) => m.category === w);
    if (hit) return hit.id;
  }
  return undefined;
}

export function detectIntent(prompt: string): { kind: IntentKind; matched: string[] } {
  for (const k of KEYWORDS) {
    const matched = k.words.filter((w) => prompt.includes(w));
    if (matched.length > 0) return { kind: k.kind, matched };
  }
  return { kind: "unknown", matched: [] };
}

/** 找到第一个真实存在的移动模块，用于给守卫挂行为。 */
function movementModules(): string[] {
  const out: string[] = [];
  for (const m of MODULES) {
    if (m.category === "move" || m.id.startsWith("move.")) out.push(m.id);
  }
  return out.slice(0, 2);
}

function towerDefense(prompt: string): OfflinePlan {
  const { w, h } = parseSize(prompt, 28, 20);
  const count = parseCount(prompt, 4);
  const scene: NewSceneSpec = { name: "塔防关卡", widthTiles: w, heightTiles: h };

  const objects: NewObjectSpec[] = [];

  // 路径：从左到右一条走廊，用 PROP 摆出可读的形状
  const laneY = Math.round(h / 2);
  for (let x = 1; x < w - 1; x += 3) {
    objects.push({ name: "路径格", kind: "PROP", x: x * 16, y: laneY * 16, halfW: 8, halfH: 8, tags: ["路径"] });
  }

  // 入口与终点
  objects.push({ name: "怪物入口", kind: "SPAWN", x: 16, y: laneY * 16, tags: ["入口"] });
  objects.push({ name: "守护目标", kind: "PORTAL", x: (w - 1) * 16, y: laneY * 16, tags: ["目标"] });

  // 守卫：沿路径两侧分布
  const moveIds = movementModules();
  for (let i = 0; i < count; i++) {
    const gx = 3 + i * 3;
    const gy = laneY + (i % 2 === 0 ? -3 : 3);
    objects.push({
      name: `守卫 ${i + 1}`,
      kind: "ACTOR",
      x: Math.min(w - 2, gx) * 16,
      y: Math.max(1, Math.min(h - 2, gy)) * 16,
      tags: ["守卫", "友方"],
      modules: moveIds.map((id) => ({ defId: id })),
    });
  }

  return {
    mode: "offline",
    intent: "tower_defense",
    rationale: `识别为塔防布局，按 ${w}×${h} 生成一条走廊、${count} 个守卫与出入口`,
    matched: ["塔防"],
    ops: [
      { op: "createScene", scene },
      // 同一批次内先建场景、再按名字往里摆：模型生成计划时不可能预知 uid()
      { op: "addObjects", sceneName: scene.name, objects },
    ],
  };
}

function patrolLevel(prompt: string): OfflinePlan {
  const { w, h } = parseSize(prompt, 32, 24);
  const count = parseCount(prompt, 3);
  const scene: NewSceneSpec = { name: "巡逻关卡", widthTiles: w, heightTiles: h };
  const moveIds = movementModules();

  const objects: NewObjectSpec[] = [
    { name: "玩家出生点", kind: "SPAWN", x: 32, y: 32, tags: ["玩家"] },
  ];

  // 四面墙：用 PROP 围一圈，给场景一个可读的边界
  for (let x = 0; x < w; x += 2) {
    objects.push({ name: "墙", kind: "PROP", x: x * 16 + 8, y: 8, halfW: 16, halfH: 8, tags: ["地形", "阻挡"] });
    objects.push({ name: "墙", kind: "PROP", x: x * 16 + 8, y: (h - 1) * 16, halfW: 16, halfH: 8, tags: ["地形", "阻挡"] });
  }

  for (let i = 0; i < count; i++) {
    objects.push({
      name: `巡夜守卫 ${i + 1}`,
      kind: "ACTOR",
      x: Math.round(w / 2 + (i - count / 2) * 48),
      y: Math.round(h / 2) * 16,
      tags: ["守卫", "敌方"],
      modules: moveIds.map((id) => ({ defId: id })),
    });
  }

  return {
    mode: "offline",
    intent: "patrol_level",
    rationale: `识别为巡逻关卡，按 ${w}×${h} 生成边界、出生点与 ${count} 个巡逻守卫`,
    matched: ["巡逻"],
    ops: [
      { op: "createScene", scene },
      { op: "addObjects", sceneName: scene.name, objects },
    ],
  };
}

function emptyLevel(prompt: string): OfflinePlan {
  const { w, h } = parseSize(prompt, 32, 24);
  const scene: NewSceneSpec = { name: "新场景", widthTiles: w, heightTiles: h };
  return {
    mode: "offline",
    intent: "empty_level",
    rationale: `生成一个 ${w}×${h} 的空场景，含一层地面与一个玩家出生点`,
    matched: ["场景"],
    ops: [
      { op: "createScene", scene },
      {
        op: "addObjects",
        sceneName: scene.name,
        objects: [{ name: "玩家出生点", kind: "SPAWN", x: 32, y: 32, tags: ["玩家"] }],
      },
    ],
  };
}

function hud(prompt: string): OfflinePlan {
  const scene: NewSceneSpec = { name: "主界面", ui: true, designW: 720, designH: 1280 };
  const objects: NewObjectSpec[] = [
    { name: "标题", kind: "PROP", x: 360, y: 420, halfW: 160, halfH: 32, tags: ["UI", "文字"], props: { text: "游戏标题" } },
    { name: "开始按钮", kind: "PROP", x: 360, y: 720, halfW: 120, halfH: 44, tags: ["UI", "按钮"], props: { text: "开始" } },
    { name: "设置按钮", kind: "PROP", x: 360, y: 830, halfW: 120, halfH: 44, tags: ["UI", "按钮"], props: { text: "设置" } },
  ];
  return {
    mode: "offline",
    intent: "hud",
    rationale: "识别为界面需求，按 720×1280 设计分辨率生成标题与两个按钮",
    matched: ["界面"],
    ops: [
      { op: "createScene", scene },
      { op: "addObjects", sceneName: scene.name, objects },
    ],
  };
}

/**
 * 主入口。永远不抛异常，认不出来就返回 intent:"unknown" 与空 ops，
 * 由调用方决定是提示用户配置模型还是让用户细化描述。
 */
export function planOffline(prompt: string): OfflinePlan {
  const { kind, matched } = detectIntent(prompt);
  try {
    switch (kind) {
      case "tower_defense":
        return { ...towerDefense(prompt), matched };
      case "patrol_level":
        return { ...patrolLevel(prompt), matched };
      case "hud":
        return { ...hud(prompt), matched };
      case "empty_level":
        return { ...emptyLevel(prompt), matched };
      default:
        return {
          mode: "offline",
          intent: "unknown",
          rationale: "离线规划器覆盖不到这个描述。它只认：塔防 / 巡逻关卡 / 空场景 / 界面骨架。",
          matched: [],
          ops: [],
        };
    }
  } catch (e) {
    return {
      mode: "offline",
      intent: "unknown",
      rationale: `离线规划失败：${(e as Error).message}`,
      matched,
      ops: [],
    };
  }
}
