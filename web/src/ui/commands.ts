/**
 * 命令注册表。
 *
 * 为什么要集中一处：同一个动作现在有三个入口 —— 顶栏菜单、快捷键、命令面板。
 * 如果三处各写一份，加一个命令就要改三个文件，而且很容易出现"菜单里有、
 * 快捷键没有"或者"快捷键和对菜单的文案不一致"。
 *
 * 这里只描述「有哪些命令、叫什么、快捷键是什么、跑起来做什么」；
 * 具体实现由 Editor 在构造时注册（命令要访问 canvas / 面板 / 工程，注册表本身不持有这些）。
 *
 * 纪律：
 *   1. id 用 kebab-case 且全应用唯一（命令面板、测试、未来的宏都靠它定位）；
   2. when 判断"现在能不能用"：不可用的命令在命令面板里灰显而不是消失
 *      —— 用户需要知道"这个东西存在，只是现在条件不满足"；
 *   3. 菜单分组与命令面板共用同一份描述，不重复写文案。
 */

import type { IconName } from "./icons.ts";

export interface Command {
  /** 唯一 id，kebab-case */
  id: string;
  /** 中文标题（命令面板与菜单共用） */
  title: string;
  /** 右侧显示的快捷键文本，例如 "Ctrl+S"；没有绑定就留空 */
  key?: string;
  /** 命令面板里的分组标题（文件 / 编辑 / 视图 / 工程 / AI…） */
  group: string;
  /** 给用户看的补充说明（命令面板里作为副标题，菜单里作为 hint） */
  hint?: string;
  icon?: IconName;
  /** 不可见命令（例如内部刷新）不进命令面板 */
  hidden?: boolean;
  /** 返回 false 表示当前不可用（命令面板灰显） */
  enabled?: () => boolean;
  run: () => void;
}

const registry = new Map<string, Command>();

export function registerCommands(list: Command[]): void {
  for (const c of list) registry.set(c.id, c);
}

export function allCommands(): Command[] {
  return Array.from(registry.values()).filter((c) => !c.hidden);
}

export function commandById(id: string): Command | undefined {
  return registry.get(id);
}

/** 按 id 执行；返回 false 表示命令不存在或当前不可用（调用方可以据此提示）。 */
export function runCommand(id: string): boolean {
  const c = registry.get(id);
  if (!c) return false;
  if (c.enabled && !c.enabled()) return false;
  try {
    c.run();
    return true;
  } catch (e) {
    // 命令里抛错不能带走整个编辑器：转到控制台，界面照常可用
    console.error(`[command:${id}]`, e);
    return false;
  }
}

/** 命令面板用的分组顺序（没列出的分组排在最后）。 */
const GROUP_ORDER = ["文件", "编辑", "视图", "工程", "剧本", "AI", "帮助"];

export function commandsByGroup(): { group: string; commands: Command[] }[] {
  const map = new Map<string, Command[]>();
  for (const c of allCommands()) {
    const arr = map.get(c.group);
    if (arr) arr.push(c);
    else map.set(c.group, [c]);
  }
  const out: { group: string; commands: Command[] }[] = [];
  for (const g of GROUP_ORDER) {
    const arr = map.get(g);
    if (arr) {
      out.push({ group: g, commands: arr });
      map.delete(g);
    }
  }
  for (const [g, arr] of map) out.push({ group: g, commands: arr });
  return out;
}

/**
 * 命令面板的模糊过滤。
 *
 * 打分规则（简单到可预期，不引入模糊匹配库）：
 *   完全匹配标题 > 标题前缀 > 标题包含 > id 包含 > hint 包含。
 * 空格分隔的多关键词全部命中才算匹配（"保存 工程"能筛出「保存工程」）。
 */
export function filterCommands(query: string): Command[] {
  const q = query.trim().toLowerCase();
  const all = allCommands();
  if (!q) return all;

  const terms = q.split(/\s+/).filter(Boolean);
  const scored: { c: Command; score: number }[] = [];

  for (const c of all) {
    const title = c.title.toLowerCase();
    const id = c.id.toLowerCase();
    const hint = (c.hint ?? "").toLowerCase();
    const key = (c.key ?? "").toLowerCase();
    const haystack = `${title} ${id} ${hint} ${key} ${c.group.toLowerCase()}`;

    // 多关键词：每个词都要在 haystack 里出现
    if (!terms.every((t) => haystack.includes(t))) continue;

    let score = 0;
    const first = terms[0];
    if (title === first) score = 100;
    else if (title.startsWith(first)) score = 80;
    else if (title.includes(first)) score = 60;
    else if (id.includes(first)) score = 40;
    else if (key.includes(first)) score = 30;
    else score = 20;
    // 短标题优先：同样命中时，用户更可能在找"保存"而不是"另存为并下载"
    score -= Math.min(8, Math.max(0, title.length - 4));
    scored.push({ c, score });
  }

  scored.sort((a, b) => b.score - a.score || a.c.title.localeCompare(b.c.title));
  return scored.map((s) => s.c);
}

/**
 * 菜单项构造：从命令 id 列表生成 contextMenu 能吃的条目。
 * 菜单与命令面板共用同一份 title / key / hint，文案不会分叉。
 */
export function menuItemsFrom(ids: string[], opts: { withDividers?: boolean } = {}): {
  label?: string;
  key?: string;
  hint?: string;
  disabled?: boolean;
  divider?: boolean;
  onClick?: () => void;
}[] {
  const out: { label?: string; key?: string; hint?: string; disabled?: boolean; divider?: boolean; onClick?: () => void }[] = [];
  for (const id of ids) {
    if (id === "-") {
      if (opts.withDividers !== false) out.push({ divider: true });
      continue;
    }
    const c = registry.get(id);
    if (!c) continue;
    const usable = !(c.enabled && !c.enabled());
    out.push({
      label: c.title,
      key: c.key,
      hint: c.hint,
      disabled: !usable,
      onClick: () => runCommand(id)
    });
  }
  return out;
}
