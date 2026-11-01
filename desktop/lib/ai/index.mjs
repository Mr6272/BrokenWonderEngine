/**
 * AI 层 · 统一入口（给主进程用一行 import）。
 *
 * 各子模块保持正交，这里只做聚合，方便 main.mjs 与测试按需导入。
 */

export { createAiBridge } from "./bridge.mjs";
export { routeModel, KEYWORDS, ROUTER_VERSION } from "./router.mjs";
export { buildSystemPrompt, PROMPT_VERSION, systemBlock } from "./prefix.mjs";
export { openSession, workspaceHash, HISTORY_VERSION } from "./session.mjs";
export { compactSession, shouldCompact, estimateTokens, structuredTrim } from "./compact.mjs";
export { fromProviderUsage, cacheHitRate, estimateSavings, mergeUsage, describeUsage, emptyUsage } from "./usage.mjs";
export { streamChat, completeChat } from "./stream.mjs";
export { resolveProvider, PROVIDERS, DEFAULT_MODELS, mockAnswer } from "./provider.mjs";
export { createToolCache, pruneToolResult, PRUNE_LIMIT, describeToolResult } from "./prune.mjs";
export { toolDefinitions, TOOL_NAMES } from "./tools.mjs";
export { createApiIndex, defaultApiDocsPath, parseApiDocs } from "./apiIndex.mjs";
