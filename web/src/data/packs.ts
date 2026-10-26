/**
 * 规则包 —— 模块"拼接/组合"的落地形式（用户明确需求）。
 *
 * 用法：把一组已经调好的积木（例如「巡逻 + 发现玩家 + 追击 + 进范围说话」）存成一个包，
 * 之后拖到任何对象上整包生效，不必重复拼装。
 *
 * 包是自包含的：模块实例内嵌在包里，不引用外部对象。
 * 这样整包可以跨场景、跨工程搬运，也方便将来做"分享一个敌人配置"这类功能。
 */

import type { ModuleInstance, RulePack } from "../core/model.ts";
import { uid } from "../core/model.ts";
import { store } from "../core/store.ts";
import { moduleDef } from "../data/modules.ts";

/** 把一个对象上的模块打成包。 */
export function packFromModules(name: string, blurb: string, modules: ModuleInstance[]): RulePack {
  return {
    id: uid(),
    name,
    blurb,
    // 深拷贝，避免之后改包影响已放置的对象
    modules: modules.map((m) => ({
      defId: m.defId,
      label: m.label,
      trigger: m.trigger,
      values: { ...m.values },
      enabled: m.enabled,
      collapsed: true
    })),
    exposed: {},
    exposedLabel: {}
  };
}

/** 生成一个可以挂到对象上的副本。 */
export function instantiatePack(pack: RulePack): ModuleInstance[] {
  return pack.modules.map((m) => ({
    defId: m.defId,
    label: m.label,
    trigger: m.trigger,
    values: { ...m.values },
    enabled: m.enabled,
    collapsed: true
  }));
}

/**
 * 把包应用到对象上。
 *
 * 拼接语义按用户直觉处理，而不是做集合运算：
 *   同名模块（defId 相同且「调用名」相同）视为重复 → 覆盖参数
 *   其余模块直接追加
 * 这样"先放一个敌人，再叠一个精英包"会得到预期的结果，而不是一堆重复积木。
 */
export interface ApplyResult {
  added: number;
  overwritten: number;
}

export function applyPack(objectId: string, pack: RulePack): ApplyResult | null {
  const scene = store.scene;
  if (!scene) return null;
  const obj = scene.objects.find((o) => o.id === objectId);
  if (!obj) return null;

  const incoming = instantiatePack(pack);
  let added = 0;
  let overwritten = 0;

  for (const inst of incoming) {
    const key = identityKey(inst);
    const existing = obj.modules.find((m) => identityKey(m) === key);
    if (existing) {
      existing.values = { ...inst.values };
      existing.trigger = inst.trigger;
      existing.enabled = inst.enabled;
      overwritten++;
    } else {
      obj.modules.push(inst);
      added++;
    }
  }
  store.markDirty();
  return { added, overwritten };
}

/** 模块身份：定义 id + 调用名。调用名是用户给一段逻辑起的名字，是拼接的锚点。 */
function identityKey(m: ModuleInstance): string {
  const callName = m.values.callName ?? "";
  return `${m.defId}::${callName}`;
}

/** 包的一行摘要，用于列表显示。 */
export function packSummary(pack: RulePack): string {
  const names = pack.modules
    .map((m) => moduleDef(m.defId)?.title ?? m.defId)
    .slice(0, 4);
  const more = pack.modules.length > 4 ? ` 等 ${pack.modules.length} 块` : "";
  return names.join(" + ") + more;
}

/** 检查包里是否有引用了已不存在模块的条目（工程跨版本打开时会出现）。 */
export function packIssues(pack: RulePack): string[] {
  const issues: string[] = [];
  for (const m of pack.modules) {
    if (!moduleDef(m.defId)) issues.push(`包里包含未知模块：${m.defId}`);
  }
  return issues;
}

/** 内置开局模板：让新工程"开箱就有一个能跑的敌人"，而不是空白堆砌。 */
export function builtinPacks(): RulePack[] {
  const mk = (
    name: string,
    blurb: string,
    mods: { defId: string; values?: Record<string, string> }[]
  ): RulePack => {
    const modules: ModuleInstance[] = mods.map((m) => {
      const def = moduleDef(m.defId);
      const values: Record<string, string> = {};
      if (def) for (const p of def.params) if (p.type !== "note") values[p.key] = p.def;
      Object.assign(values, m.values ?? {});
      return {
        defId: m.defId,
        trigger: def?.triggers.length ? def.triggers[0] : null,
        values,
        enabled: true,
        collapsed: true
      };
    });
    return { id: uid(), name, blurb, modules, exposed: {}, exposedLabel: {} };
  };

  return [
    mk("近战追击敌人", "会追人、到近了就砍、挨打会闪、死掉给经验", [
      { defId: "move.follow", values: { speed: "70", detectionRange: "260" } },
      { defId: "render.sortByY" },
      { defId: "render.shadow" },
      { defId: "combat.health", values: { maxHealth: "80" } },
      { defId: "combat.melee", values: { damage: "12", cooldown: "1.4" } },
      { defId: "combat.onDamage" },
      { defId: "combat.onDeath", values: { experience: "10" } },
      { defId: "combat.invulnerable" }
    ]),
    mk("可交互的箱子", "点一下打开、播音效、给提示", [
      { defId: "detect.collider" },
      { defId: "render.shadow" },
      { defId: "event.click", values: { thenCall: "打开箱子" } },
      { defId: "event.invoke", values: { callName: "打开箱子" } },
      { defId: "fx.sfx" }
    ]),
    mk("会说话的村民", "走近按交互键就说话，头顶带提示", [
      { defId: "detect.collider", values: { shape: "按精灵轮廓 Sprite Bounds" } },
      { defId: "render.sortByY" },
      { defId: "render.shadow" },
      { defId: "dialogue.interact", values: { thenCall: "闲聊" } },
      { defId: "dialogue.bubble", values: { text: "今天天气不错。", duration: "2.5" } }
    ]),
    mk("伏击触发区", "玩家踏进来就关门、刷怪、震屏", [
      { defId: "event.triggerEnter", values: { once: "开", thenCall: "发动伏击" } },
      { defId: "event.invoke", values: { callName: "发动伏击" } },
      { defId: "fx.shake" },
      { defId: "fx.sfx" }
    ]),
    mk("会逃跑的小动物", "玩家靠近就跑，拉开距离后停下", [
      { defId: "move.flee" },
      { defId: "render.shadow" },
      { defId: "render.sortByY" },
      { defId: "render.blink", values: { period: "2.4", minAlpha: "0.8" } }
    ])
  ];
}
