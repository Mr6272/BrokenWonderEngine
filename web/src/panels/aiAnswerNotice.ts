/**
 * `done.extra` → 助手消息下方的提示条（**纯函数，无 DOM、无 import**）。
 *
 * 为什么必须抽成纯函数：
 *   用户报的是「AI 跑两下就寄了，没给我交付任何东西」。主进程侧已经把
 *   「工具预算耗尽」「max_tokens 截断」做成了结构化字段，但**渲染侧不显示**
 *   就等于没修 —— 用户看到的仍然是一句半截话 + 沉默。
 *   而这类判定的错误方式很隐蔽：字段名差一个字母、`budgetExhausted`
 *   是字符串 `"true"`、`roundsMax` 缺省时拼出 `用了 3/undefined 轮`，
 *   截图里都「看起来有条提示」，实际是错的内容。只有断言能钉住。
 *
 * 两条硬约束（违反任何一条都不如什么都不显示）：
 *   1. **字段缺省/类型不对 → 返回 `[]`，绝不抛异常**。主进程可能分两批
 *      落地这些字段，老版本宿主根本不发 `extra`；渲染侧不能因此炸掉整个面板。
 *   2. **绝不返回空条**。`title`/`detail` 恒非空 —— 空的提示条就是用户
 *      截图里那几条「极淡的空白横线」，比没有更糟（会让人以为加载失败）。
 *
 * 顺序：`truncated` 在 `budget` 之前。截断是**更根本的原因**（模型根本没
 * 说完），预算耗尽只是「它没继续查」；把预算条放前面会让人误以为「是因为
 * 查得太多才没说」，那是错误归因。
 */

export type AnswerNoticeKind = "budget" | "truncated" | "stalled";

/** 提示条数据（渲染层只负责摆 DOM，不在这里做任何文案判断）。 */
export interface AnswerNotice {
  kind: AnswerNoticeKind;
  /** 目前只有一种视觉：警告（这不是崩溃，不能用错误红叉）。 */
  tone: "warn";
  title: string;
  detail: string;
}

/** 严格的对象判定：数组/函数/null 都不算（`typeof [] === "object"` 是陷阱）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 读一个「次数」字段：只接受有限非负数，其余（undefined/NaN/字符串）→ null。 */
function countOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/**
 * 截断条：必须给出**可操作的下一步**，只报「被截断了」等于把问题丢回给用户。
 *
 * 主进程的语义（2026-11-02 确认）：`truncated === true` 意味着**已自动续写若干次
 * 仍被截断**，不是"只截了一次"；`autoContinued` 是实际续写次数。
 * 所以文案要说清「不是没写完就放弃，是续写也没救回来」——
 * 否则用户会以为重试一次就好，而重试同样会撞上限。
 *
 * 语气：这是**罕见但会发生**的边界情况（主进程默认 maxTokens 已提到 16384），
 * 不能写得像崩溃 —— 用警告色 + 一句可操作建议，不用感叹号堆。
 *
 * @param autoContinued 主进程给的实际续写次数（缺省/类型不对时用泛化说法）
 */
function truncatedNotice(autoContinued: number | null): AnswerNotice {
  const skill = autoContinued !== null && autoContinued > 0
    ? `已自动续写 ${autoContinued} 次仍不完整`
    : "自动续写次数已用完";
  return {
    kind: "truncated",
    tone: "warn",
    title: "回答被 max_tokens 截断",
    detail:
      `回答在长度上限处被截断（${skill}），后半段内容不存在。`
      + "下一步：到「设置 → AI」调大「最大输出 token」，或换输出上限更高的模型，然后重发这一轮。",
  };
}

/**
 * 预算耗尽条。
 *
 * 计数**成对**使用（used + max 都有效才展示那一项）：只有一个数字时
 * 拼 `3/undefined` 比不显示更糟 —— 用户会以为程序坏了。
 * 两边都失效时退回泛化文案，仍然把「已基于已有信息作答」说清楚
 * （这是用户最关心的一句：不是没答，是答案不带更多工具证据）。
 */
function budgetDetail(tb: Record<string, unknown>): string {
  const parts: string[] = [];
  const roundsUsed = countOf(tb["roundsUsed"]);
  const roundsMax = countOf(tb["roundsMax"]);
  if (roundsUsed !== null && roundsMax !== null) parts.push(`用了 ${roundsUsed}/${roundsMax} 轮`);
  const callsUsed = countOf(tb["callsUsed"]);
  const callsMax = countOf(tb["callsMax"]);
  if (callsUsed !== null && callsMax !== null) parts.push(`调用了 ${callsUsed}/${callsMax} 次工具`);

  const usage = parts.length ? `本轮${parts.join("、")}，` : "本轮工具轮次/调用次数已达上限，";
  return `${usage}不能再继续调用工具，已基于已有信息作答。`
    + "要继续往下查，可以把问题拆小一点再问一轮（新一轮有自己的预算）。";
}

function budgetNotice(tb: Record<string, unknown>): AnswerNotice {
  return {
    kind: "budget",
    tone: "warn",
    title: "本轮工具预算用完",
    detail: budgetDetail(tb)
  };
}

/**
 * 绕圈中止条（`toolBudget.stopReason === "stalled"`）。
 *
 * 2026-11-02 起**工具不再有次数上限**（用户明确要求），唯一剩下的中止条件是
 * 「连续多轮做完全相同的调用、且拿到的结果没有变化」—— 那是真死循环，不是"跑太多"。
 * 文案必须把这个区别说清：用户最怕的是「它又半路停了」，所以要让用户知道
 * **正常使用永远不会触发**，且已基于已有信息作答。
 */
function stalledNotice(tb: Record<string, unknown>): AnswerNotice {
  const rounds = countOf(tb["roundsUsed"]);
  const calls = countOf(tb["callsUsed"]);
  const usage = rounds !== null || calls !== null
    ? `本轮跑了 ${rounds ?? "?"} 轮、${calls ?? "?"} 次工具调用，`
    : "";
  return {
    kind: "stalled",
    tone: "warn",
    title: "检测到工具调用在原地绕圈，已中止",
    detail:
      `${usage}其中连续多轮做的是**完全相同**的调用、拿到的结果也没有变化，`
      + "因此判定为绕圈并直接作答（工具本身没有次数上限，正常探索不会触发这个）。"
      + "下一步：把问题描述得更具体（例如指出文件名与行号），或让我换一个角度重新查。"
  };
}

/**
 * 超时看门狗条（`toolBudget.stopReason === "timeout"`）。
 * 45 分钟的看门狗，只拦真正的挂死；文案不要写成"额度用完"（没有额度）。
 */
function timeoutNotice(tb: Record<string, unknown>): AnswerNotice {
  const minutes = countOf(tb["elapsedMs"]) !== null
    ? Math.round(Number(tb["elapsedMs"]) / 60000)
    : null;
  return {
    kind: "stalled",
    tone: "warn",
    title: "本轮耗时过长，已停止工具循环",
    detail:
      `${minutes !== null ? `本轮已跑 ${minutes} 分钟，` : ""}达到超时看门狗后停止继续查证并直接作答。`
      + "下一步：把任务拆小一点再问一轮（新一轮重新计时），或告诉我具体文件/函数名以缩小范围。"
  };
}

/**
 * 从 `done.extra` 推出该显示哪些提示条。
 *
 * 入参刻意是 `unknown`：主进程字段可能缺省、可能是老版本、可能被序列化成
 * 别的形状。调用侧不需要（也不应该）先断言类型 —— 判定全部收在这里。
 *
 * @returns 需要渲染的提示条；不需要渲染时返回空数组（调用方据此**完全不渲染**）。
 */
export function answerNotices(extra: unknown): AnswerNotice[] {
  const out: AnswerNotice[] = [];
  if (!isRecord(extra)) return out;

  // 严格 `=== true`：`"true"` 是字符串时视为「字段类型不对」，不渲染（硬约束）。
  if (extra["truncated"] === true) out.push(truncatedNotice(countOf(extra["autoContinued"])));

  const tb = extra["toolBudget"];
  if (isRecord(tb)) {
    /**
     * ⚠ 自 2026-11-02 起工具**没有次数上限**：`budgetExhausted` 已恒为 false，
     * 只作为向后兼容字段保留（老宿主/旧主进程仍可能发 true）。
     * 所以这里要**同时**支持两种语义：
     *   · 新：看 `stopReason`（stalled / timeout）
     *   · 旧：仍然看 `budgetExhausted`（老主进程发 true 时，那条预算提示依然该显示）
     * 顺带把「跑了几轮」统一用 `roundsUsed`——新版没有 `roundsMax`，别再拼 `3/undefined`。
     */
    const stopReason = tb["stopReason"];
    if (stopReason === "stalled") out.push(stalledNotice(tb));
    else if (stopReason === "timeout") out.push(timeoutNotice(tb));
    else if (tb["budgetExhausted"] === true) out.push(budgetNotice(tb));
  }

  return out;
}
