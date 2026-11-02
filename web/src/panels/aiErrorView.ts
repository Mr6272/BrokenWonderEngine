/**
 * AI 错误的**结构化展示**（把 400/401/429 的原始 JSON 变成人话）。
 *
 * 起因：用户截图里，kimi 返回的 400 JSON 原样挂在对话区：
 *   400 {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back
 *   to the API.","type":"invalid_request_error","code":"invalid_request_error"}}
 * 占了一大块，用户完全看不懂；`request_id` 更没意义但却是排查的关键。
 *
 * 原则：
 *   · **人话在上，技术详情折叠在下** —— 用户不需要默认看到 JSON；
 *   · **常见错误必须映射成"这是谁的问题 + 现在该做什么"**；
 *   · **`request_id` 单独一行、等宽、可复制**（贴给服务商排查时必须有它，
 *     但不该占主体）；
 *   · 映射不到的**不猜**，退回"请求被服务端拒绝：<原文第一行>"。
 *
 * 措辞与主进程侧保持一致（Lead 要求两边同一套说法）。
 */

export type ErrorKind =
  | "reasoning-content"
  | "tool-format"
  | "auth"
  | "rate-limit"
  | "server"
  | "bad-request"
  | "network"
  | "unknown";

export interface ErrorPresentation {
  kind: ErrorKind;
  /** 标题行：谁的问题 + 一句话结论（人话，不含 JSON） */
  title: string;
  /** 补充说明：现在该做什么 / 是谁的责任 */
  hint: string;
  /** 服务端给的原始消息（已从 JSON 里抽出来，不是整坨 JSON） */
  rawMessage: string;
  /** request_id（若有）：排查用，单独一行展示 */
  requestId: string;
  /** 是否值得重试（决定要不要给「重试」按钮） */
  retryable: boolean;
}

/** 从一段可能是 JSON 的文本里抽 `error.message` / `message`。 */
function extractMessage(text: string): string {
  const t = String(text ?? "");
  const braceAt = t.indexOf("{");
  if (braceAt >= 0) {
    try {
      const obj = JSON.parse(t.slice(braceAt)) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const m = obj?.error?.message ?? obj?.message;
      if (typeof m === "string" && m.trim()) return m.trim();
    } catch {
      /* 不是合法 JSON：下面按纯文本处理 */
    }
  }
  return t.trim();
}

/** 抽 request_id / requestId（各家写法不同，都兜一下）。 */
function extractRequestId(text: string): string {
  const t = String(text ?? "");
  const m =
    /"request_id"\s*:\s*"([^"]+)"/i.exec(t)
    ?? /"requestId"\s*:\s*"([^"]+)"/i.exec(t)
    ?? /\brequest[_ ]?id["\s:=]+([A-Za-z0-9_-]{6,})/i.exec(t);
  return m ? m[1] : "";
}

/** 抽 HTTP 状态码（"400 ..." / "HTTP 401" / "status 429"）。 */
function extractStatus(text: string): number {
  const t = String(text ?? "");
  const m = /\b(?:HTTP\s*|status\s*)?([45]\d\d)\b/i.exec(t);
  return m ? Number(m[1]) : 0;
}

/**
 * 把一条原始错误文本转成结构化展示。
 *
 * @param raw 原始错误文本（可能是 "400 {json}"，也可能只是 message）
 */
export function presentError(raw: string): ErrorPresentation {
  const text = String(raw ?? "");
  const lower = text.toLowerCase();
  const message = extractMessage(text);
  const requestId = extractRequestId(text);
  const status = extractStatus(text);

  // ---- 1. 思考模式推理内容未回传（我们自己的缺陷） ----
  // 这条对用户来说是"别人的问题"，必须说清楚，否则他会以为是自己的模型/账号坏了。
  if (lower.includes("reasoning_content")) {
    return {
      kind: "reasoning-content",
      title: "思考模式需要回传推理内容",
      hint: "这是我们客户端的问题（已记录），不是你或模型的配置错误。升级客户端后即可恢复。",
      rawMessage: message,
      requestId,
      retryable: false   // 重试也没用，客户端缺陷
    };
  }

  // ---- 2. 工具调用格式不兼容 ----
  if (lower.includes("tool_calls") || lower.includes("tool_choice") || lower.includes("tool_call")) {
    return {
      kind: "tool-format",
      title: "工具调用格式与模型服务不兼容",
      hint: "该模型对工具调用的格式有额外要求，可以换个模型或换个问法。",
      rawMessage: message,
      requestId,
      retryable: true
    };
  }

  // ---- 3. 认证 ----
  if (status === 401 || lower.includes("invalid api key") || lower.includes("unauthorized")
      || lower.includes("authentication")) {
    return {
      kind: "auth",
      title: "API Key 无效",
      hint: "去「设置 → AI」重新填这一条的 Key，或点模型下拉重新选它。",
      rawMessage: message,
      requestId,
      retryable: false
    };
  }

  // ---- 4. 限流 ----
  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")
      || lower.includes("quota")) {
    return {
      kind: "rate-limit",
      title: "请求太频繁",
      hint: "稍等一会儿再试；如果是免费额度用完了，需要等服务商恢复或换一条模型。",
      rawMessage: message,
      requestId,
      retryable: true
    };
  }

  // ---- 5. 服务端故障（与你无关） ----
  if (status >= 500) {
    return {
      kind: "server",
      title: "模型服务端故障",
      hint: "和你无关，是服务商那边出了问题。稍后重试即可。",
      rawMessage: message,
      requestId,
      retryable: true
    };
  }

  // ---- 6. 连不上（网络/DNS/超时） ----
  if (lower.includes("timeout") || lower.includes("enotfound") || lower.includes("econnrefused")
      || lower.includes("network")) {
    return {
      kind: "network",
      title: "连不上模型服务",
      hint: "检查本机网络/代理，或确认「服务地址」写对了。",
      rawMessage: message,
      requestId,
      retryable: true
    };
  }

  // ---- 7. 其它 400 ----
  if (status === 400) {
    const firstLine = message.split("\n")[0].slice(0, 120);
    return {
      kind: "bad-request",
      title: "请求被服务端拒绝",
      hint: "服务端认为这次请求不合法。下面是被拒绝的原文，可展开查看技术详情。",
      rawMessage: firstLine,
      requestId,
      retryable: true
    };
  }

  // ---- 8. 认不出来：不猜，如实呈现 ----
  const firstLine = (message || text).split("\n")[0].slice(0, 160);
  return {
    kind: "unknown",
    title: status ? `请求失败（HTTP ${status}）` : "调用失败",
    hint: "具体原因见下面的技术详情。",
    rawMessage: firstLine,
    requestId,
    retryable: true
  };
}
