/**
 * AI 流分区与 Agent 行为摘要（纯函数：无 DOM、无状态、无 import）。
 *
 * 为什么单独成模块、而不是写在面板里：
 *   1. 「这条内容落在 Agent 行为区还是聊天区」是一条**规则**，不是一次渲染。
 *      规则一旦写在渲染代码里，就必然出现第二份（流式增量一份、整树重建一份），
 *      两份必然漂移 —— 表现是「刚发生的工具调用在上面，重绘一次跑到下面」。
 *      这类错位在截图上看不出来（东西都在，只是放错了楼层），所以收在纯函数里可单测。
 *   2. 面板头部那句「N 步 / 失败 N / 执行中」只能由数据决定。
 *      失败数算成 0 的后果最重：用户以为这一轮干净跑完了，于是不去看那条红色工具块。
 *
 * 契约见 docs/ai-interface.md §2 / §3。
 */

export type AiStreamKind =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "thinking"
  | "notice"
  | "note"
  | "error"
  | "diff";

/** 两个宿主：`thread` = 聊天区，`agent` = Agent 行为区。 */
export type AiZone = "thread" | "agent";

/**
 * 摘要的输入块。
 *
 * `ok` 与面板里的 `ToolCallBlock.ok` 同义：true 成功 / false 失败 /
 * **undefined 未知**（老契约没有回执）—— 未知不能被当成成功，也不能被当成失败。
 */
export interface AiStreamBlock {
  kind: AiStreamKind;
  ok?: boolean;
}

export interface AgentSummary {
  steps: number;
  failed: number;
  state: "idle" | "running" | "done" | "failed";
}

/**
 * 唯一分区规则：我和它的对话进聊天区，它干了什么进行为区。
 *
 * 别在调用点写 `kind === "tool" ? ... : ...` —— 那就是第二份规则。
 */
export function zoneFor(kind: AiStreamKind): AiZone {
  return kind === "user" || kind === "assistant" ? "thread" : "agent";
}

/**
 * Agent 头部摘要。
 *
 * 判定顺序即优先级（顺序改了行为就变）：
 *   空 → idle；有失败 → failed；busy → running；有未回执的工具块或思考块 → running；否则 done。
 *
 * 为什么「失败」压过「忙碌」：忙碌时也可能已经有一条工具失败了，
 * 这时候说「执行中」等于把失败藏起来；用户只在这一瞬间会看头部。
 * 为什么「未回执」也算 running：老契约的工具事件不带 ok，
 * 把它算成完成是**猜**，猜错的代价比多显示一个呼吸点大。
 */
export function summarizeAgent(blocks: AiStreamBlock[], opts: { busy?: boolean } = {}): AgentSummary {
  let steps = 0;
  let failed = 0;
  let pending = false;

  for (const b of blocks) {
    if (b.kind === "tool") {
      steps++;
      if (b.ok === false) failed++;
      if (b.ok === undefined) pending = true;
    } else if (b.kind === "thinking") {
      // 思考块不占工具步数，但它证明「它还在动」—— 头部必须跟着呼吸
      pending = true;
    }
  }

  let state: AgentSummary["state"];
  if (!blocks.length) state = "idle";
  else if (failed > 0) state = "failed";
  else if (opts.busy) state = "running";
  else if (pending) state = "running";
  else state = "done";

  return { steps, failed, state };
}
