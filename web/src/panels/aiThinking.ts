
// ============================================================================
// 「正在思考」状态机
// ----------------------------------------------------------------------------
// 用户原话：「模型思考的时候要显示正在思考中」。
//
// 设计要点（每一条都有具体的失败模式）：
//   1. **aiChat 返回后立刻显示**「正在连接…」——若等第一个事件，推理模型首字
//      延迟 2~5 秒，用户面对的是 5 秒空白，会以为卡死了。
//   2. 主进程的 `thinking` 事件是**唯一权威来源**（contract §4.2）；
//      本地的 800ms 定时器**只用于兜底升级**，不用于"猜"状态 ——
//      靠"多久没收到 delta"猜状态会误判（慢网络 vs 真思考分不清）。
//   3. `answering` 一到就撤提示：已经有正文在流了，再挂个"思考中"是自相矛盾。
//   4. `slow` 必须同时给「停止」按钮 —— 那是用户唯一的出口。
// ============================================================================

export type ThinkingPhase = "connecting" | "reasoning" | "answering" | "slow";

/** 本地兜底升级阈值：超过这么久还没有任何事件，就把「正在连接」升级成「还在等」。 */
const LOCAL_SLOW_MS = 800;

export interface ThinkingState {
  phase: ThinkingPhase;
  /** reasoning 阶段已累计的字符数（显示「已思考 N 字」） */
  chars: number;
  /** 攒起来的思考片段（供「展开看思考过程」，默认折叠） */
  detail: string;
}

const THINKING_COPY: Record<ThinkingPhase, (s: ThinkingState) => string> = {
  connecting: () => "正在连接…",
  reasoning: (s) => (s.chars > 0 ? `正在思考（已思考 ${s.chars} 字）` : "正在思考…"),
  answering: () => "正在回复…",
  slow: () => "还在等响应，可能网络慢或模型排队"
};

/** 当前请求的思考态；null = 没在思考（提示应完全消失）。 */
let thinking: ThinkingState | null = null;
/** 本地兜底定时器 */
let slowTimer = 0;
/** 当前请求 id（用于确认定时器属于哪一轮） */
let thinkingForRequest = "";

export function currentThinking(): ThinkingState | null {
  return thinking;
}

/** 思考态的文案（UI 直接显示）。 */
export function thinkingText(s: ThinkingState): string {
  return THINKING_COPY[s.phase](s);
}

/** slow 阶段必须给出「停止」按钮（唯一出口）。 */
export function thinkingNeedsStop(s: ThinkingState): boolean {
  return s.phase === "slow";
}

/**
 * 一轮对话开始：立刻进入 `connecting`，并起一个 800ms 兜底定时器。
 *
 * @param requestId 本轮 id（定时器回调里比对，避免上一轮的定时器污染下一轮）
 * @param onTick    定时器触发时的通知（面板据此重画提示）
 */
export function beginThinking(requestId: string, onTick: () => void): void {
  clearThinkingTimer();
  thinkingForRequest = requestId;
  thinking = { phase: "connecting", chars: 0, detail: "" };
  slowTimer = window.setTimeout(() => {
    // 只在本轮仍是当前轮、且还没有任何事件时才升级
    if (thinkingForRequest !== requestId) return;
    if (!thinking) return;
    if (thinking.phase !== "connecting") return; // 已经收到事件了，不需要兜底
    thinking = { ...thinking, phase: "slow" };
    onTick();
  }, LOCAL_SLOW_MS);
}

/**
 * 收到主进程 `thinking` 事件：以它为准更新状态。
 *
 * 主进程的 phase 比本地猜测权威，所以这里**直接覆盖**本地兜底的结果
 * （例如本地已升级成 slow，但主进程说 reasoning，就应该显示"正在思考"）。
 */
export function applyThinkingEvent(
  phase: ThinkingPhase,
  chars: number | undefined,
  delta: string | undefined,
  onTick: () => void
): void {
  if (phase === "answering") {
    // 已有正文在流：撤掉思考提示，别自相矛盾
    endThinking();
    onTick();
    return;
  }
  const prev = thinking ?? { phase: "connecting", chars: 0, detail: "" };
  thinking = {
    phase,
    chars: typeof chars === "number" && chars >= 0 ? chars : prev.chars,
    // delta 是增量片段，攒起来；上限 4000 字防止长思考把内存顶爆
    detail:
      delta && delta.length > 0
        ? (prev.detail + delta).slice(-4000)
        : prev.detail
  };
  clearThinkingTimer();
  onTick();
}

/** 收到 `delta`（真正的正文）：思考必然结束。 */
export function endThinking(): void {
  clearThinkingTimer();
  thinking = null;
  thinkingForRequest = "";
}

function clearThinkingTimer(): void {
  if (slowTimer) {
    window.clearTimeout(slowTimer);
    slowTimer = 0;
  }
}

/**
 * 演示用：把思考态**冻结**在指定 phase（截图用）。
 *
 * 为什么需要：思考态是瞬时状态（mock 流的 connecting 只有 ~500ms），
 * 截图命令是「前置 tap → 最后截图」，等截图落下时早就进入 answering 了。
 * 这个函数让验收能在真正的 UI 上冻结某个 phase 并截图 ——
 * **注意它只改用于展示的状态，不发任何请求**，所以不模拟"假回答"。
 */
export function freezeThinkingForDemo(phase: ThinkingPhase, chars = 0): void {
  clearThinkingTimer();
  thinkingForRequest = "";
  thinking = {
    phase,
    chars,
    detail: phase === "reasoning" ? "（演示用的思考片段，仅用于展示折叠块的样子）" : ""
  };
}

/** 退出演示冻结（恢复真实状态机）。 */
export function unfreezeThinkingForDemo(): void {
  clearThinkingTimer();
  thinking = null;
  thinkingForRequest = "";
}
