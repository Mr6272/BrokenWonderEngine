/**
 * AI 层 · 模型端点探测（`{baseUrl}/models`）。
 *
 * 两处共用同一个实现（**不要再写第二套**）：
 *   · `trae-import.mjs` 的导入后可达性自检（不带 key，只判"网络通不通"）
 *   · `bwe:ai-probe-model` 的「这条模型能不能用」探测（**带该模型自己的 key**）
 *
 * ── 为什么探测 `/models` 而不是 chat completions ──────────────────────────
 * `/models` 便宜（响应小、多数 OpenAI 兼容服务都实现）且快；chat completion 要计费、
 * 还可能触发长时间生成。探测的目的是「判端点 + key 大致对不对」，不是"跑一次推理"。
 *
 * ── 关于 401 的诚实性（重要，别给出确切的错误答案）─────────────────────────
 * 有些服务对 `/models` 要求比 chat 更高的权限（或根本不实现），所以
 * **带 key 访问 /models 得到 401，并不能断定这个 key 对 chat 也不可用**。
 * 因此分类要区分：
 *   · `unauthorized-on-models`：只凭 /models 的 401 判断不出来 —— 可能是 key 无效，
 *     但也可能是该端点权限要求更高。文案必须说清这个不确定性。
 *   · `unauthorized`：响应体里明确指出了 token/key 无效（例如 SiliconFlow 的
 *     `{"code":30014,"message":"Token is invalid."}`）—— 这时可以确信 key 不对。
 * 宁可给出模糊的正确答案，也不要给出确切的错误答案。
 */

/** 探测超时（毫秒）。3 秒：用户点了「测试」不该等太久；也足够覆盖国内到境外的 RTT。 */
export const PROBE_TIMEOUT_MS = 3000;

/**
 * 单次请求 `/models`。
 *
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {"HEAD"|"GET"} [opts.method]
 * @param {string} [opts.apiKey]  带上就加 Authorization: Bearer（用于判 key 是否被接受）
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.readBody] 是否读响应体（用于从 JSON 里区分「key 明确无效」）
 * @returns {Promise<{reachable:boolean,status:number,method:string,latencyMs:number,
 *                    bodyText:string,errorCode:string,detail:string}>}
 *          `reachable` 的语义是**连上了**（拿到任何 HTTP 响应都算通），不是「返回 200」。
 */
export async function requestModelsEndpoint(baseUrl, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || PROBE_TIMEOUT_MS;
  const method = opts.method === "HEAD" ? "HEAD" : "GET";
  const url = `${String(baseUrl ?? "").replace(/\/+$/, "")}/models`;
  const headers = { accept: "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  const startedAt = Date.now();
  try {
    const resp = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Date.now() - startedAt;

    let bodyText = "";
    if (opts.readBody && method !== "HEAD") {
      try {
        // 只读前 2KB：错误信息通常很短；成功时模型清单可能很大，没必要全读。
        const raw = await resp.text();
        bodyText = raw.length > 2048 ? raw.slice(0, 2048) : raw;
      } catch {
        bodyText = "";
      }
    }

    // 从响应体里抽取错误码（OpenAI 兼容服务常给 { error: {code,message} } 或 {code,message}）
    let errorCode = "";
    let errorMessage = "";
    if (bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const e = json?.error ?? json;
        errorCode = String(e?.code ?? e?.type ?? e?.error_code ?? "");
        errorMessage = String(e?.message ?? e?.msg ?? "");
      } catch {
        errorMessage = bodyText.slice(0, 200);
      }
    }

    return {
      reachable: true,
      status: resp.status,
      method,
      latencyMs,
      bodyText,
      errorCode,
      errorMessage,
      detail: describeStatus(resp.status, Boolean(opts.apiKey), errorCode, errorMessage)
    };
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    const name = String(e?.name ?? "");
    const message = String(e?.message ?? e);
    // ⚠ Node 的 fetch 把真正的网络原因包在 `cause` 里，`message` 只有一句 "fetch failed"。
    //   不展开 cause 的话，DNS 失败和连接被拒都会归成 `network` —— 这对排查没帮助。
    const causeMessage = String(e?.cause?.message ?? e?.cause?.code ?? "");
    const causeCode = String(e?.cause?.code ?? "");
    const combined = `${message} ${causeMessage} ${causeCode}`;

    const isTimeout = name === "TimeoutError" || name === "AbortError" || /timeout|aborted/i.test(combined);
    const isDns = /ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(combined);
    return {
      reachable: false,
      status: 0,
      method,
      latencyMs,
      bodyText: "",
      errorCode: isTimeout ? "timeout" : isDns ? "dns" : "network",
      errorMessage: message,
      detail: isTimeout
        ? `${timeoutMs}ms 内没有响应（网络慢、被墙或服务无响应）`
        : isDns
          ? `域名解析失败（${causeCode || "ENOTFOUND"}）：这个地址的域名不存在或 DNS 不可用`
          : `连接失败：${causeMessage || message}`
    };
  }
}

/** 把状态码翻成人话（区分「明确 key 无效」与「/models 端点判不出来」）。 */
function describeStatus(status, withKey, errorCode, errorMessage) {
  if (status >= 200 && status < 300) {
    return withKey ? `连通正常（HTTP ${status}），Key 被接受` : `连通正常（HTTP ${status}）`;
  }
  if (status === 401 || status === 403) {
    if (!withKey) return `需要 API Key（HTTP ${status}）`;
    // 有 key 仍被拒：先看响应体是否明确点名 token/key 无效
    const looksLikeBadKey =
      /30014|invalid.*(token|key|auth)|(token|key|auth).*invalid|incorrect.*(token|key)|unauthorized/i.test(
        `${errorCode} ${errorMessage}`
      );
    if (looksLikeBadKey) {
      return `Key 被拒绝（HTTP ${status}${errorCode ? ` · code ${errorCode}` : ""}）`
        + `${errorMessage ? `：${errorMessage.slice(0, 80)}` : ""}`
        + ` —— 服务端明确表示凭据无效`;
    }
    // 没有明确信息：可能是 key 错，也可能只是这个端点权限要求更高
    return `HTTP ${status}：无法据此断定 Key 对错 —— 部分服务对 /models 端点要求更高权限，不代表对话接口一定失败`;
  }
  if (status === 404) {
    return `HTTP 404：该服务可能未实现 /models 端点（不代表对话接口不可用）`;
  }
  return `HTTP ${status}${errorMessage ? `：${errorMessage.slice(0, 80)}` : ""}`;
}

/**
 * 探测一条模型：先 HEAD（便宜），必要时降级 GET 并读 body。
 *
 * 降级规则（复用同一套，不另写）：
 *   · 404/405 → 方法不支持或被墙在端点实现上，换 GET 复核
 *   · 401/403 且带 key → 换 GET 读 body，用于区分「key 明确无效」与「端点权限问题」
 *
 * @param {{baseUrl:string, apiKey?:string, model?:string}} entry
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, status:number, reachable:boolean, method:string,
 *                    detail:string, reason:string, latencyMs:number, errorCode:string}>}
 */
export async function probeModelEndpoint(entry, opts = {}) {
  const baseUrl = String(entry?.baseUrl ?? "").trim();
  const apiKey = String(entry?.apiKey ?? "").trim();
  const timeoutMs = Number(opts.timeoutMs) || PROBE_TIMEOUT_MS;

  if (!baseUrl) {
    return {
      ok: false,
      status: 0,
      reachable: false,
      method: "none",
      detail: "没有配置 baseUrl，无法探测",
      reason: "no-base-url",
      latencyMs: 0,
      errorCode: "no-base-url"
    };
  }

  let attempt = await requestModelsEndpoint(baseUrl, { method: "HEAD", apiKey, timeoutMs });
  // HEAD 不支持 → 换 GET（并读 body）
  if (attempt.status === 404 || attempt.status === 405) {
    attempt = await requestModelsEndpoint(baseUrl, { method: "GET", apiKey, timeoutMs, readBody: true });
  } else if ((attempt.status === 401 || attempt.status === 403) && apiKey) {
    // 带 key 被拒：读 body 才能知道是「key 明确无效」还是「端点权限问题」
    attempt = await requestModelsEndpoint(baseUrl, { method: "GET", apiKey, timeoutMs, readBody: true });
  }

  const classification = classify(attempt, Boolean(apiKey));
  const startedMs = attempt.latencyMs;

  // `ok` 只表示「端点连上了且这次探测没有明确的失败信号」。
  // 注意：`unauthorized-on-models` 不算 ok=false 的"确定失败"，但也不能算 ok=true ——
  // 它的语义就是"判不出来"，所以给 ok:null（三态），让 UI 能区分「明确成功/明确失败/不确定」。
  return {
    ok: classification.ok,
    status: attempt.status,
    reachable: attempt.reachable,
    method: attempt.method,
    detail: attempt.detail,
    reason: classification.reason,
    latencyMs: startedMs,
    errorCode: attempt.errorCode || "",
    // 明确说明「这次探测到底证明了什么」，避免 UI 拿 status 过度解读
    evidence: classification.evidence
  };
}

/**
 * 把探测结果分成 6 类。
 *
 * @returns {{ok:boolean|null, reason:string, evidence:string}}
 *          ok 三态：true 明确可用 / false 明确不可用 / null 判不出来
 */
function classify(attempt, withKey) {
  if (!attempt.reachable) {
    const reason = attempt.errorCode === "timeout" ? "timeout" : attempt.errorCode === "dns" ? "dns" : "network";
    return {
      ok: false,
      reason,
      evidence: `没有拿到任何 HTTP 响应（${reason}）—— 这个地址连不上`
    };
  }
  const status = attempt.status;
  if (status >= 200 && status < 300) {
    return {
      ok: true,
      reason: "ok",
      evidence: withKey ? "端点连通且 Key 被接受" : "端点连通（未带 Key，无法确认 Key）"
    };
  }
  if (status === 401 || status === 403) {
    if (!withKey) {
      return { ok: false, reason: "unauthorized", evidence: "端点要求认证，但这只模型没有配置 Key" };
    }
    const looksLikeBadKey = /30014|invalid.*(token|key|auth)|(token|key|auth).*invalid|incorrect.*(token|key)/i.test(
      `${attempt.errorCode} ${attempt.errorMessage}`
    );
    if (looksLikeBadKey) {
      return {
        ok: false,
        reason: "unauthorized",
        evidence: `服务端明确表示凭据无效（${attempt.errorMessage.slice(0, 100) || attempt.errorCode}）`
      };
    }
    return {
      ok: null,
      reason: "unauthorized-on-models",
      evidence: "/models 端点拒绝了这个 Key，但这可能是该端点权限要求更高，"
        + "不能据此断定对话接口一定失败 —— 建议直接发一条短消息验证"
    };
  }
  if (status === 404) {
    return {
      ok: null,
      reason: "http-error",
      evidence: "该服务未实现 /models 端点（多数对话接口仍可用），无法用这个端点判断可用性"
    };
  }
  return {
    ok: false,
    reason: "http-error",
    evidence: `端点返回 HTTP ${status}`
  };
}

/**
 * 批量探测（给 Trae 导入后的供应商级可达性自检用，**不带 key**）。
 *
 * @param {Array<{provider:string, baseUrl:string}>} providers
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<Array>} 每个 provider 补上 reachable/reachableStatus/reachableMethod/reachableDetail
 */
export async function probeProvidersReachable(providers, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || PROBE_TIMEOUT_MS;
  return Promise.all(
    (providers ?? []).map(async (p) => {
      const attempt = await requestModelsEndpoint(p.baseUrl, { method: "HEAD", timeoutMs });
      let finalAttempt = attempt;
      if (attempt.status === 404 || attempt.status === 405) {
        finalAttempt = await requestModelsEndpoint(p.baseUrl, { method: "GET", timeoutMs, readBody: true });
      }
      return {
        ...p,
        reachable: finalAttempt.reachable,
        reachableStatus: finalAttempt.status,
        reachableMethod: finalAttempt.method,
        reachableDetail: finalAttempt.detail
      };
    })
  );
}
