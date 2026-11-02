/**
 * Key 失效批量提示条的**决策逻辑**（纯函数，不碰 DOM，可直接单测）。
 *
 * 为什么单独抽出来：`renderKeyBrokenHint` 原来自己读全局 `modelsState`，
 * 于是「还没 `await loadModels` 就被调用」这种顺序错误只能在运行时发现，
 * 而且表现形式是「静默渲染成空」。参数化 + 抽纯函数之后：
 *   · 调用点传 `null` → **编译期报错**（类型不允许）；
 *   · 传 `[]` → 由 `requireModels` 兜底（这是类型系统挡不住的漏网）；
 *   · 决策逻辑本身 → **可以喂数组直接断言**，不用起 Electron。
 */

import type { AiModelEntry, AiStatus } from "../core/host.ts";
import { countKeyBroken } from "./aiModelState.ts";
import { reconcileKeyBroken } from "./keyBrokenReconcile.ts";

export interface KeyBrokenView {
  /** 要显示的条数（0 = 不显示整条） */
  count: number;
  /** 标题文案 */
  title: string;
  /** 按钮文案：1 个时「去重填」，多个时「查看并重填」 */
  buttonLabel: string;
  /** 是否需要展开内嵌小列表（count >= 2 才展开） */
  showList: boolean;
  /** 列表里要列出的条目 */
  brokenEntries: AiModelEntry[];
  /** 统计源不一致时给「输出」面板的痕（一致为 null） */
  warning: string | null;
}

/**
 * 由模型清单 + 状态算出提示条该怎么显示。
 *
 * @param models 调用方**必须**先 `await loadModels()` 再传（类型非 null，
 *               但空数组仍可能传进来 —— 那由 `requireModels` 在调用点兜底）
 */
export function keyBrokenViewOf(models: AiModelEntry[], st: AiStatus | null): KeyBrokenView {
  const perEntry = countKeyBroken(models);
  const check = reconcileKeyBroken(perEntry, st?.keyUndecryptableCount, st?.keyUndecryptableEntries);
  const count = check.shown;
  return {
    count,
    title: `${count} 个模型的 API Key 需要重新粘贴`,
    buttonLabel: count === 1 ? "去重填" : "查看并重填",
    // 1 个时「去重填」直接定位，不需要列表（避免为最常见情况造两层导航）
    showList: count >= 2,
    brokenEntries: models.filter((m) => m.keyUndecryptable),
    warning: check.warning
  };
}
