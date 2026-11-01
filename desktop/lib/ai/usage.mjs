/**
 * AI 层 · TokenUsage 记账。
 *
 * 语义与 DeepSeek Harness 的 TokenUsage 一致：**各计数互不重叠**。
 *   inputTokens       = 未命中缓存的输入
 *   cacheReadTokens   = 命中前缀缓存的输入
 *   cacheWriteTokens  = 写入缓存
 *   outputTokens      = 输出
 *   计费输入 = inputTokens + cacheReadTokens + cacheWriteTokens
 *
 * 陷阱（实测踩过）：DeepSeek 的 usage 里把缓存命中**折进 prompt_tokens**：
 *   { prompt_tokens: 41591, prompt_cache_hit_tokens: 41472, prompt_cache_miss_tokens: 119 }
 * 如果直接把 prompt_tokens 当 inputTokens，会既重复计费又算不出真实命中率。
 * 这里优先用官方给出的 hit/miss 拆分；拿不到时用 prompt_tokens 减去命中数。
 *
 * OpenAI 风格则是 prompt_tokens / prompt_tokens_details.cached_tokens；
 * Anthropic 风格的 cache_read_input_tokens / cache_creation_input_tokens 也一并吃进来，
 * 让「同一套 usage 计算」能对接三种 provider。
 */

/** 每百万 token 的美元价（DeepSeek 官方价，2025 档；仅用于「省了多少钱」的粗估）。 */
export const PRICES = {
  deepseek: { inputMiss: 0.00000028, cacheRead: 0.000000028, cacheWrite: 0.00000028, output: 0.00000028 },
  // DeepSeek 实际计价（元/百万 → 美元按 7.1 折算）：输入未命中 ¥4/百万、命中 ¥0.4/百万、输出 ¥8/百万。
  deepseekRealistic: {
    inputMiss: 4 / 7.1 / 1_000_000,
    cacheRead: 0.4 / 7.1 / 1_000_000,
    output: 8 / 7.1 / 1_000_000
  },
  openai: { inputMiss: 0.000003, cacheRead: 0.0000015, cacheWrite: 0.000003, output: 0.000015 }
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 从 provider 的原始 usage 对象算出 disjoint TokenUsage。
 *
 * @param {object} raw  provider 返回的 usage（可能为 undefined，比如中途取消）
 * @param {object} [meta]
 * @param {string} [meta.provider]  deepseek | openai-compatible | mock
 * @param {string} [meta.model]
 * @param {string} [meta.reason]    记账原因（如 "aborted" / "mock"）
 * @returns {{inputTokens:number,cacheReadTokens:number,cacheWriteTokens:number,outputTokens:number,reason?:string,totalInput:number,reasoningTokens?:number}}
 */
export function fromProviderUsage(raw, meta = {}) {
  const u = raw ?? {};
  const reason = meta.reason;

  // ---- 输出 ----
  const outputTokens = num(u.completion_tokens ?? u.output_tokens);
  const reasoningTokens = num(u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens) || undefined;

  // ---- 缓存命中（三种 provider 的字段名）----
  const cacheRead =
    num(u.prompt_cache_hit_tokens) ||
    num(u.prompt_tokens_details?.cached_tokens) ||
    num(u.cache_read_input_tokens);
  // ---- 缓存写入（目前只有 Anthropic 风格显式给出；DeepSeek 视为 0）----
  const cacheWrite = num(u.cache_creation_input_tokens) || num(u.cacheWriteTokens);

  // ---- 未命中输入 ----
  let miss;
  if (num(u.prompt_cache_miss_tokens) > 0) {
    miss = num(u.prompt_cache_miss_tokens);
  } else if (num(u.prompt_tokens) > 0) {
    // ⚠ DeepSeek / OpenAI 把命中折进了 prompt_tokens，必须减回来才是「未命中输入」。
    miss = Math.max(0, num(u.prompt_tokens) - cacheRead);
  } else if (num(u.input_tokens) > 0) {
    // Anthropic 风格：input_tokens 本身就是未命中部分（与 cache_read 已经 disjoint），
    // 再减一次会把合法输入削成 0。
    miss = num(u.input_tokens);
  } else {
    miss = 0;
  }

  const usage = {
    inputTokens: Math.round(miss),
    cacheReadTokens: Math.round(cacheRead),
    cacheWriteTokens: Math.round(cacheWrite),
    outputTokens: Math.round(outputTokens)
  };
  if (reasoningTokens) usage.reasoningTokens = Math.round(reasoningTokens);
  if (reason) usage.reason = reason;
  usage.totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return usage;
}

/** 空 usage（mock 之外、或调用在拿到 usage 前就失败时用）。 */
export function emptyUsage(reason = "") {
  const u = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalInput: 0 };
  if (reason) u.reason = reason;
  return u;
}

/** 命中率：命中缓存的部分 / 全部计费输入。0 输入时返回 0（不要 NaN）。 */
export function cacheHitRate(usage) {
  const total = num(usage?.inputTokens) + num(usage?.cacheReadTokens) + num(usage?.cacheWriteTokens);
  if (total <= 0) return 0;
  return num(usage?.cacheReadTokens) / total;
}

/** 计费输入（三者之和）。 */
export function billedInputTokens(usage) {
  return num(usage?.inputTokens) + num(usage?.cacheReadTokens) + num(usage?.cacheWriteTokens);
}

/**
 * 粗略省钱估算：对比「完全没命中缓存」时的价格。
 * 只用于界面上「省了多少钱」的直观显示，不是财务级数字。
 */
export function estimateSavings(usage, provider = "deepseek") {
  const price = PRICES[provider === "openai-compatible" ? "openai" : provider] ?? PRICES.deepseekRealistic;
  const hits = num(usage?.cacheReadTokens);
  const miss = num(usage?.inputTokens);
  // 命中的部分按 cacheRead 价，未命中按 inputMiss 价；
  // 「不省」的成本 = 全部按 inputMiss 价。
  const actual = hits * price.cacheRead + miss * price.inputMiss + num(usage?.outputTokens) * price.output;
  const baseline = (hits + miss) * price.inputMiss + num(usage?.outputTokens) * price.output;
  const savedUsdApprox = Math.max(0, baseline - actual);
  return { cacheHitRate: cacheHitRate(usage), savedUsdApprox, baselineUsdApprox: baseline, actualUsdApprox: actual };
}

/** 把多次 usage 累加（会话级别的「这一晚上省了多少」）。 */
export function mergeUsage(a, b) {
  const out = {
    inputTokens: num(a?.inputTokens) + num(b?.inputTokens),
    cacheReadTokens: num(a?.cacheReadTokens) + num(b?.cacheReadTokens),
    cacheWriteTokens: num(a?.cacheWriteTokens) + num(b?.cacheWriteTokens),
    outputTokens: num(a?.outputTokens) + num(b?.outputTokens),
    calls: num(a?.calls) + num(b?.calls)
  };
  if (a?.reason && !b?.reason) out.reason = a.reason;
  else if (b?.reason) out.reason = b.reason;
  out.totalInput = out.inputTokens + out.cacheReadTokens + out.cacheWriteTokens;
  return out;
}

/** 给界面的紧凑一行（中文，带命中率和省钱）。 */
export function describeUsage(usage, provider = "deepseek") {
  const { cacheHitRate: rate, savedUsdApprox } = estimateSavings(usage, provider);
  const pct = (rate * 100).toFixed(0);
  const saved = savedUsdApprox >= 0.01 ? savedUsdApprox.toFixed(2) : savedUsdApprox.toFixed(4);
  return (
    `输入 ${billedInputTokens(usage)} token（命中 ${num(usage?.cacheReadTokens)} · 未命中 ${num(usage?.inputTokens)}）`
    + ` · 输出 ${num(usage?.outputTokens)} token · 缓存命中率 ${pct}% · 约省 $${saved}`
  );
}
