/**
 * Key 失效的两份统计源交叉校验。
 *
 * 为什么需要：`keyUndecryptableCount`（主进程数好的总数）与
 * 「逐条模型自己的 `keyUndecryptable` 标记」是**两个独立的数据源**。
 * 一旦漂移，用户会看到「说 1 个，点进去却是 2 个」—— 正是我们反复踩的
 * 「同一件事有多个统计源」的病。
 *
 * 处理原则（Lead 定的）：
 *   · **主数据源仍用逐条标记**（逐条渲染需要它）；
 *   · `count` 只用来做一致性校验；
 *   · 不一致时**红条用更精确的数字**（逐条数出来的），并在「输出」面板留一行痕；
 *   · **不为不一致专门设计 UI** —— 用户不该看到内部不一致，那是我们的事。
 */

export interface KeyBrokenEntry {
  scope: "top-level" | "model";
  id?: string;
}

export interface KeyBrokenCheck {
  /** 红条该显示的数字（= 逐条数出来的，比 count 精确） */
  shown: number;
  /** 两份源是否一致 */
  consistent: boolean;
  /** 不一致时给「输出」面板的痕迹（一致时为 null） */
  warning: string | null;
}

/**
 * 交叉校验。
 *
 * @param perEntry  逐条数出来的条数（`countKeyBroken(models)`）
 * @param count     主进程给的 `keyUndecryptableCount`
 * @param entries   主进程给的 `keyUndecryptableEntries`（可能缺省）
 */
export function reconcileKeyBroken(
  perEntry: number,
  count: number | undefined,
  entries: KeyBrokenEntry[] | undefined
): KeyBrokenCheck {
  const entryCount = Math.max(0, Number(perEntry) || 0);
  const countN = Math.max(0, Number(count) || 0);
  const entriesN = Math.max(0, Array.isArray(entries) ? entries.length : 0);

  // 三个源：逐条 > entries > count（精确度从高到低）。
  // 显示用逐条：它来自真实渲染的数据，红条说"几条"必须和列表里能点到的条数一致。
  const shown = entryCount;

  // 一致的条件：先看 count 与 entries 是否对得上（这两份是主进程给的），
  // 再要求它们与逐条结果一致。
  // 若 entries 缺省（老版本主进程），不做它的校验，只用 count。
  const hasEntries = Array.isArray(entries);
  const mainAgrees = hasEntries ? entriesN === countN : true;
  const allAgrees = mainAgrees && entryCount === countN;

  if (allAgrees) return { shown, consistent: true, warning: null };

  // 不一致：给一行痕，但不设计 UI（用户不该看到内部不一致）
  const bits: string[] = [];
  if (hasEntries && entriesN !== countN) {
    bits.push(`count 说 ${countN} 条，但 entries 里有 ${entriesN} 条`);
  }
  if (entryCount !== countN) {
    bits.push(`模型清单里逐条标记了 ${entryCount} 条，但 count 说 ${countN} 条`);
  }
  if (!bits.length) bits.push(`统计源不一致（逐条 ${entryCount} / count ${countN}）`);

  return {
    shown,
    consistent: false,
    warning: `Key 失效统计不一致：${bits.join("；")}。红条按逐条标记显示（更精确）。`
  };
}
