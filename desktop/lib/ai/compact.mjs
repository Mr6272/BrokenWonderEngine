/**
 * AI 层 · 分层压缩。
 *
 * 契约 §4.3 第 5 条：上下文 > 窗口 70% 时触发；尾部保留 ~20K token 原文，
 * 旧内容 LLM 摘要并与已有摘要合并；摘要持久化，重启后不重复消耗 token。
 *
 * 关键取舍：**没有 API key 时必须降级**而不是报错。
 * 降级方案是「结构化裁剪」：不调用 LLM，按消息形状做确定性压缩 ——
 *   保留：每条消息的首行/要点行、工具调用名与一句结果、用户原话的头尾；
 *   丢弃：代码块正文、重复的日志行、工具原始输出（它们都能从 toolCache 或工程里重新取）。
 * 这样即使离线/无 key，长会话也不会把上下文撑爆。
 *
 * 纯 Node 标准库，可单测。
 */

import { messageText } from "./session.mjs";

/** 上下文窗口 70% 是触发线（留 30% 给本轮输出 + 工具结果）。 */
export const COMPACT_TRIGGER = 0.7;
/** 压缩后尾部保留的原文 token 数。 */
export const TAIL_TOKENS = 20_000;

/**
 * 粗略 token 估算（不依赖 tokenizer，误差 ±20%，对「是否该压缩」足够）。
 * 经验：ASCII 约 4 字符/token；CJK 约 1.5 字符/token；换行/空白几乎不计。
 */
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
    else if (code >= 0xf900 && code <= 0xfaff) cjk += 1;
    else if (code >= 0xff00 && code <= 0xffef) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** 一条消息的 token 估算（含工具块）。 */
export function messageTokens(msg) {
  const text = messageText(msg);
  let extra = 0;
  for (const b of msg?.blocks ?? []) {
    if (b?.type === "tool-call") extra += estimateTokens(JSON.stringify(b.arguments ?? {})) + 8;
    if (b?.type === "tool-result") extra += estimateTokens(b.preview ?? b.text ?? "");
  }
  return estimateTokens(text) + extra + 6;
}

export function totalTokens(messages, summaryText = "") {
  let n = estimateTokens(summaryText);
  for (const m of messages) n += messageTokens(m);
  return n;
}

/**
 * 是否该压缩。
 *
 * @returns {{should:boolean, tokens:number, limit:number, ratio:number}}
 */
export function shouldCompact({ messages, summaryText = "", contextWindow = 128_000 }) {
  const tokens = totalTokens(messages, summaryText);
  const limit = Math.floor(contextWindow * COMPACT_TRIGGER);
  return { should: tokens > limit, tokens, limit, ratio: limit > 0 ? tokens / contextWindow : 0 };
}

/**
 * 结构化裁剪：不调 LLM 的降级摘要。
 * 目标是把「旧消息」压成能读懂、能续接的骨架，而不是丢掉整段对话。
 */
export function structuredTrim(messages, { maxCharsPerMessage = 220 } = {}) {
  const lines = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "助手" : m.role === "system" ? "系统" : "用户";
    const text = messageText(m).replace(/\r/g, "");
    const toolCalls = (m.blocks ?? []).filter((b) => b?.type === "tool-call");
    const toolResults = (m.blocks ?? []).filter((b) => b?.type === "tool-result");
    if (text) lines.push(`- ${role}：${skeleton(text, maxCharsPerMessage)}`);
    for (const c of toolCalls) {
      lines.push(`  · 调用 ${c.name}(${JSON.stringify(c.arguments ?? {}).slice(0, 120)})`);
    }
    for (const r of toolResults) {
      lines.push(`  · 结果 ${r.name ?? ""}：${oneLine(r.preview ?? r.text ?? "", 100)}`);
    }
    if (m.usage?.reason === "aborted") lines.push("  · （本轮被取消）");
  }
  return lines.join("\n");
}

/** 取一段文本的骨架：保留首行、末行与要点行，丢掉代码块正文。 */
function skeleton(text, maxChars) {
  const noFence = text.replace(/```[^\n]*\n[\s\S]*?```/g, "```…（代码块已折叠）```");
  const rows = noFence.split("\n").map((r) => r.trimEnd()).filter(Boolean);
  const picked = new Set();
  for (let i = 0; i < Math.min(3, rows.length); i++) picked.add(i);
  for (let i = Math.max(0, rows.length - 2); i < rows.length; i++) picked.add(i);
  // 「要点行」：带结论词/错误词的行优先保留。
  const mark = /(结论|因此|所以|原因|错误|修复|改成|注意|结论是|TODO|ERROR|FIX)/;
  rows.forEach((r, i) => {
    if (mark.test(r)) picked.add(i);
  });
  const body = [...picked]
    .sort((a, b) => a - b)
    .map((i) => rows[i])
    .join(" ⏎ ");
  return oneLine(body, maxChars);
}

function oneLine(text, max) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 一次压缩。
 *
 * @param {object} opts
 * @param {import("./session.mjs").Session} opts.session
 * @param {number} [opts.contextWindow]
 * @param {number} [opts.tailTokens]            尾部保留的原文 token 数（默认 20K）
 * @param {string} [opts.existingSummary]       已有摘要（会与本次摘要合并）
 * @param {(oldText: string, prevSummary: string) => Promise<string|null>} [opts.summarize]
 *        有 API key 时传入的 LLM 摘要函数；返回 null / 抛错时自动降级。
 * @returns {Promise<{compacted:boolean, mode:"llm"|"structured"|"none", before:number, after:number, summary:string}>}
 */
export async function compactSession(opts) {
  const session = opts.session;
  const contextWindow = Number(opts.contextWindow ?? 128_000);
  const tailTokens = Number(opts.tailTokens ?? TAIL_TOKENS);
  const existingSummary = opts.existingSummary ?? session?.summary?.text ?? "";
  const all = session.messages();
  const check = shouldCompact({ messages: all, summaryText: existingSummary, contextWindow });
  if (!check.should) {
    return { compacted: false, mode: "none", before: check.tokens, after: check.tokens, summary: existingSummary };
  }

  // 从尾部往前攒，攒够 tailTokens 就停；前面那些就是「旧内容」。
  let tailStart = all.length;
  let tailSum = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const t = messageTokens(all[i]);
    if (tailSum + t > tailTokens && all.length - i > 2) {
      tailStart = i + 1;
      break;
    }
    tailSum += t;
    tailStart = i;
  }
  // 至少压掉一条，否则「压缩成功但没变化」会死循环。
  if (tailStart === 0 && all.length > 1) tailStart = 1;
  const oldMessages = all.slice(0, tailStart);
  const tailMessages = all.slice(tailStart);
  if (oldMessages.length === 0) {
    return { compacted: false, mode: "none", before: check.tokens, after: check.tokens, summary: existingSummary };
  }

  let summary = "";
  let mode = "structured";
  if (typeof opts.summarize === "function") {
    try {
      const llm = await opts.summarize(renderForSummary(oldMessages), existingSummary);
      if (typeof llm === "string" && llm.trim()) {
        summary = llm.trim();
        mode = "llm";
      }
    } catch {
      // 无 key / 网络失败 → 降级，不让压缩把会话搞崩。
      mode = "structured";
    }
  }
  if (!summary) summary = structuredTrim(oldMessages);

  // 与已有摘要合并：旧摘要作「更早的背景」，新摘要在后（时间顺序）。
  const merged = existingSummary
    ? `${existingSummary}\n\n【续】${summary}`
    : summary;

  await session.replaceTail(tailMessages, {
    text: merged,
    coveredMessages: (session.summary?.coveredMessages ?? 0) + oldMessages.length,
    compactedAt: new Date().toISOString(),
    mode
  });

  const after = totalTokens(session.messages(), merged);
  return {
    compacted: true,
    mode,
    before: check.tokens,
    after,
    removedMessages: oldMessages.length,
    keptMessages: tailMessages.length,
    summary: merged
  };
}

/** 给 LLM 摘要函数的输入：旧消息的可读拼接（工具结果只要剪枝后的预览）。 */
function renderForSummary(messages) {
  const parts = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "助手" : "用户";
    const text = messageText(m);
    if (text) parts.push(`【${role}】\n${text}`);
    for (const b of m.blocks ?? []) {
      if (b?.type === "tool-call") parts.push(`【工具调用】${b.name}(${JSON.stringify(b.arguments ?? {})})`);
      if (b?.type === "tool-result") parts.push(`【工具结果】${oneLine(b.preview ?? b.text ?? "", 400)}`);
    }
  }
  // 上限：摘要输入也不该无边界，~8000 字符足够写出连贯摘要。
  const joined = parts.join("\n\n");
  return joined.length > 8000 ? `${joined.slice(0, 8000)}\n…（已截断）` : joined;
}

/**
 * LLM 摘要用的提示词（常量，不随时间/会话变化 —— 它自己也是一次带缓存的调用）。
 */
export function summaryInstructions() {
  return [
    "把下面这段早期对话压缩成一份连贯的中文摘要，供后续续接对话使用。",
    "要求：",
    "1. 保留：用户的目标与约束、已经做过的决定、改过哪些文件/脚本、遇到并解决过的错误、尚未解决的问题。",
    "2. 丢弃：中间过程的工具原始输出、重复的日志、已经被推翻的方案。",
    "3. 结构：先一段「已确定的事实」，再一段「未完成事项」，各不超过 8 行。",
    "4. 只输出摘要正文，不要复述这段话，不要输出代码块围栏。"
  ].join("\n");
}
