/**
 * AI 层 · OpenAI 兼容的流式调用（/chat/completions + SSE）。
 *
 * 为什么自己写 SSE 解析而不引 SDK：离线环境装不了包；而且我们要的东西很少 ——
 * delta 文本、tool_calls 增量、最终 usage。手写解析还能保证「一个字都没收到时
 * 不抛异常而是返回可恢复错误」，界面才不会卡在「正在生成…」。
 *
 * 三个要点：
 *   1. `stream_options: { include_usage: true }` 必须在请求里显式打开，
 *      否则 OpenAI/DeepSeek 的 SSE 流里根本没有 usage（最后一个 chunk 是空的）；
 *   2. tool_calls 是**增量**的：index → { id, name, arguments 片段 }，要自己拼；
 *   3. 取消用 AbortController。取消后 usage 是残缺的，要标记 reason:"aborted"。
 *
 * 只依赖全局 fetch（Node 18+ / Electron 都有），不引任何包。
 */

import { emptyUsage, fromProviderUsage } from "./usage.mjs";

/**
 * 发一次流式请求。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl             例如 https://api.deepseek.com
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {{role:string,content:any}[]} opts.messages
 * @param {object[]} [opts.tools]           OpenAI 工具定义（只保留 3 个，见 tools.mjs）
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]       按 provider 固定，不随轮次抖动
 * @param {number} [opts.topP]
 * @param {AbortSignal} [opts.signal]
 * @param {(ev: object) => void} [opts.onEvent]  收到 delta / tool-call / usage 时回调
 * @param {object} [opts.headers]           额外请求头
 * @returns {Promise<{text:string, reasoning:string, toolCalls:object[], usage:object, finishReason:string|null, status:number, error?:string}>}
 */
export async function streamChat(opts) {
  const url = `${trimSlash(opts.baseUrl)}/chat/completions`;
  const body = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    // ⚠ 不打开这个开关，流里不会有 usage —— 界面上「缓存命中率」就永远是 0。
    stream_options: { include_usage: true },
    // 采样参数按 provider 固定（契约 §4.3 第 7 条：不许随轮次抖动，
    // 否则同一前缀的缓存即使命中，输出也每轮不同，用户会觉得"AI 不稳定"）。
    temperature: opts.temperature ?? 0.3,
    top_p: opts.topP ?? 0.95
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${opts.apiKey}`,
        ...(opts.headers ?? {})
      },
      body: JSON.stringify(body),
      signal: opts.signal
    });
  } catch (e) {
    const aborted = e?.name === "AbortError" || opts.signal?.aborted;
    return {
      text: "",
      reasoning: "",
      toolCalls: [],
      usage: emptyUsage(aborted ? "aborted" : "network-error"),
      finishReason: null,
      status: 0,
      error: aborted ? "已取消" : `网络请求失败：${e?.message || e}`
    };
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 600);
    } catch {
      // 读不到错误体就算了，状态码已经足够定位。
    }
    return {
      text: "",
      reasoning: "",
      toolCalls: [],
      usage: emptyUsage("http-error"),
      finishReason: null,
      status: response.status,
      error: `模型接口返回 ${response.status}：${detail || response.statusText}`
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let text = "";
  let reasoning = "";
  let finishReason = null;
  let usageRaw = null;
  const toolCalls = []; // { index, id, name, argsText }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件以空行分隔；\r\n 与 \n 都要认（有的网关会把换行改成 CRLF）。
      let sep;
      while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n)+/, "");
        handleEvent(chunk);
      }
    }
    // 流结束时可能还剩最后一个事件没被空行收尾。
    if (buffer.trim()) handleEvent(buffer);
  } catch (e) {
    const aborted = e?.name === "AbortError" || opts.signal?.aborted;
    return {
      text,
      reasoning,
      toolCalls: finalizeToolCalls(toolCalls),
      usage: fromProviderUsage(usageRaw, { reason: aborted ? "aborted" : "stream-error" }),
      finishReason,
      status: response.status,
      error: aborted ? "已取消" : `读取流失败：${e?.message || e}`
    };
  }

  function handleEvent(rawChunk) {
    const lines = rawChunk.split(/\r?\n/);
    let data = "";
    for (const line of lines) {
      if (line.startsWith("data:")) data += line.slice(5).trimStart();
      // 以 ":" 开头的注释行（心跳）直接忽略。
    }
    if (!data) return;
    if (data === "[DONE]") {
      opts.onEvent?.({ type: "stream-end" });
      return;
    }
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return; // 半截 JSON / 网关噪声：丢掉这一条，不要炸掉整个流。
    }

    if (json.usage) {
      usageRaw = json.usage;
      const usage = fromProviderUsage(json.usage);
      opts.onEvent?.({ type: "usage", usage });
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};

    // reasoning_content 是 DeepSeek 的思维链字段；蒸馏模型可能没有。
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      opts.onEvent?.({ type: "reasoning", text: delta.reasoning_content });
    }
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      opts.onEvent?.({ type: "delta", text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number(tc.index ?? 0);
        const slot = (toolCalls[idx] ??= { index: idx, id: "", name: "", argsText: "" });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.argsText += tc.function.arguments;
      }
    }
  }

  return {
    text,
    reasoning,
    toolCalls: finalizeToolCalls(toolCalls),
    usage: usageRaw ? fromProviderUsage(usageRaw) : emptyUsage("no-usage"),
    finishReason,
    status: response.status
  };
}

function finalizeToolCalls(slots) {
  return slots
    .filter(Boolean)
    .map((s) => {
      let args = {};
      try {
        args = s.argsText ? JSON.parse(s.argsText) : {};
      } catch {
        args = { __raw: s.argsText };
      }
      return { id: s.id || `call_${s.index}`, name: s.name, arguments: args, raw: s.argsText };
    });
}

function trimSlash(url) {
  return String(url ?? "").replace(/\/+$/, "");
}

/**
 * 一次**非流式**的小调用（只给压缩摘要用）。
 * 摘要不需要流式（用户看不到），非流式更省事、也能拿到完整 usage。
 */
export async function completeChat(opts) {
  const url = `${trimSlash(opts.baseUrl)}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
        ...(opts.headers ?? {})
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 800,
        temperature: opts.temperature ?? 0.2,
        top_p: opts.topP ?? 0.95,
        stream: false
      }),
      signal: opts.signal
    });
    if (!response.ok) return { text: "", usage: emptyUsage("http-error"), status: response.status };
    const data = await response.json();
    return {
      text: String(data?.choices?.[0]?.message?.content ?? ""),
      usage: fromProviderUsage(data?.usage),
      status: response.status
    };
  } catch (e) {
    return { text: "", usage: emptyUsage("network-error"), status: 0, error: e?.message || String(e) };
  }
}
