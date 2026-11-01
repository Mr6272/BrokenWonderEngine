/**
 * AI 层 · provider 抽象（可增删的模型清单 + 内置供应商预设）。
 *
 * 为什么从「两个槽（modelFlash/modelPro）」改成「一份模型清单」：
 *   旧结构只能表达「同一个供应商的便宜模型 / 贵模型」，而真实使用场景是
 *   **多个供应商并存**（DeepSeek 官方 + SiliconFlow + 用户从 Trae 导入的自定义供应商），
 *   并且要能在界面上下拉切换。「两个槽」装不下，硬塞会变成到处特判。
 *   所以主结构是 `models: [{ id, label, provider, baseUrl, model, ... }]`。
 *
 * 向后兼容（不能破坏已有单测与老 settings.json）：
 *   · `modelFlash` / `modelPro` 仍然保留，作为 **autoRoute 时的两个默认候选**；
 *   · `resolveProvider(settings, "flash"|"pro")` 仍然按老语义返回；
 *   · 新的 `resolveProvider(settings, <模型 id>)` 按 id 精确取模型。
 *   两者共存，靠「先按 id 查、查不到再当 flash/pro 槽位」的顺序区分，调用方无需改动。
 *
 * 采样的稳定性（契约 §4.3 第 7 条）：temperature/top_p 按 **provider** 固定，
 * 不随模型变化 —— 变了等于让前缀缓存失去意义，也让回答不可复现。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠ `ready` 的语义边界（**别把它当"能连上"**）
 * ─────────────────────────────────────────────────────────────────────────
 * `ready === true` 的准确含义是 **「配置齐全」**：
 *     · provider 合法、baseUrl 非空、model 非空、needsKey 时 apiKey 已填（或 mock）
 * 它**不代表**：
 *     · 这个 key 一定有效（填了假 key 仍然 ready:true）
 *     · 这个地址一定连得上（网络不通、服务下线都仍然 ready:true）
 *     · 这个 model 名一定存在
 *
 * 为什么不在这里发网络请求：清单里有几十个模型，逐个探测会让「打开设置」卡死几秒到几十秒，
 * 而且大多数时候用户只是想知道"我配好了没"。所以拆成两层：
 *   · `ready`：配置层面能不能用（本文件，纯本地、零网络）
 *   · `bwe:ai-probe-model`：**真实连通性探测**（desktop/lib/ai/probe.mjs，带该模型自己的 key，
 *     3 秒超时、会真正判出 401/200/超时）
 * UI 应当用 `needsKeyMissing`/`ready` 显示"配置状态"，用 `probeModel()` 的返回值显示"连通状态"，
 * 两者混用会让用户看到「可用」然后一发消息 401（这是真实发生过的困惑）。
 */

import { emptyUsage, fromProviderUsage, mergeUsage } from "./usage.mjs";

export const PROVIDERS = ["deepseek", "openai-compatible", "mock", "siliconflow", "trae-imported"];

/**
 * 内置供应商预设。
 *
 * 字段：baseUrl（OpenAI 兼容根，不带 /chat/completions）/ models（建议模型名，用户可改）/
 *      needsKey（是否必须有 key）/ keyHint（给界面的一句话说明）/ docs（去哪拿 key）。
 */
export const PRESETS = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com",
    needsKey: true,
    models: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" },
    keyHint: "在 platform.deepseek.com 创建 API Key",
    docs: "https://platform.deepseek.com/api_keys"
  },
  siliconflow: {
    id: "siliconflow",
    label: "SiliconFlow 硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    needsKey: true,
    models: { flash: "moonshotai/Kimi-K2-Thinking-Turbo", pro: "moonshotai/Kimi-K2-Thinking" },
    keyHint: "在 cloud.siliconflow.cn 创建 API Key（sk- 开头）",
    docs: "https://cloud.siliconflow.cn/account/ak"
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI 兼容接口",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    models: { flash: "gpt-4o-mini", pro: "gpt-4o" },
    keyHint: "任意 OpenAI 兼容服务的 Key",
    docs: ""
  },
  mock: {
    id: "mock",
    label: "本地演示（不联网）",
    baseUrl: "",
    needsKey: false,
    models: { flash: "mock-flash", pro: "mock-pro" },
    keyHint: "无需 Key，用于演示完整流式对话与用量指标",
    docs: ""
  },
  "trae-imported": {
    id: "trae-imported",
    label: "从 Trae 导入",
    baseUrl: "",
    needsKey: true,
    models: { flash: "", pro: "" },
    keyHint: "Trae 的 API Key 是设备绑定的、无法导出，必须手动填写",
    docs: ""
  }
};

export const DEFAULT_BASE_URLS = {
  deepseek: PRESETS.deepseek.baseUrl,
  "openai-compatible": PRESETS["openai-compatible"].baseUrl,
  siliconflow: PRESETS.siliconflow.baseUrl,
  mock: "",
  "trae-imported": ""
};

export const DEFAULT_MODELS = {
  deepseek: PRESETS.deepseek.models,
  "openai-compatible": PRESETS["openai-compatible"].models,
  siliconflow: PRESETS.siliconflow.models,
  mock: PRESETS.mock.models,
  "trae-imported": { flash: "", pro: "" }
};

/** 采样参数按 provider 固定，写在这里而不是散落在调用点。 */
export const SAMPLING = {
  deepseek: { temperature: 0.3, topP: 0.95 },
  "openai-compatible": { temperature: 0.3, topP: 0.95 },
  siliconflow: { temperature: 0.3, topP: 0.95 },
  "trae-imported": { temperature: 0.3, topP: 0.95 },
  mock: { temperature: 0, topP: 1 }
};

/** 未知 provider 的采样兜底（宁可给保守值，也不要 undefined 让请求被拒）。 */
const SAMPLING_FALLBACK = { temperature: 0.3, topP: 0.95 };

/** 模型条目缺省值（OpenAI 兼容服务通常不告诉窗口大小，给保守默认）。 */
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * 归一化一条模型条目：缺字段补默认、类型统一。
 *
 * 单独抽出来的理由：settings.json 是用户手改过的文件，条目可能缺字段或类型不对，
 * 每处调用各自 `.trim()` / `?? ""` 迟早会漏掉一处。
 */
export function normalizeModelEntry(raw, index = 0) {
  const m = raw && typeof raw === "object" ? raw : {};
  const provider = PROVIDERS.includes(m.provider) ? m.provider : "openai-compatible";
  const preset = PRESETS[provider] ?? PRESETS["openai-compatible"];
  return {
    id: String(m.id || `model-${index + 1}`),
    label: String(m.label || m.model || `模型 ${index + 1}`),
    provider,
    baseUrl: String(m.baseUrl || preset.baseUrl || "").trim(),
    model: String(m.model || "").trim(),
    // apiKey 只存在于内存；落盘时由 settings.mjs 换成 encryptedApiKey 或删除。
    apiKey: String(m.apiKey || "").trim(),
    apiKeyRef: String(m.apiKeyRef || "").trim(),
    contextWindow: Number(m.contextWindow) > 0 ? Number(m.contextWindow) : DEFAULT_CONTEXT_WINDOW,
    maxTokens: Number(m.maxTokens) > 0 ? Number(m.maxTokens) : DEFAULT_MAX_TOKENS,
    notes: String(m.notes || ""),
    // 来源标记（trae-import 等），便于审计「这个模型是哪来的」。
    source: m.source ? String(m.source) : "",
    needsKey: m.needsKey === undefined ? preset.needsKey : Boolean(m.needsKey)
  };
}

/** 归一化整个模型清单（去重 id、补默认、丢弃不可用条目）。 */
export function normalizeModels(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const entry = normalizeModelEntry(raw, out.length);
    // 重复 id 会让「按 id 取模型」产生歧义，直接丢弃后来的那个。
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    // 没有模型名的条目不可用（mock 除外，它的名字是固定的）。
    if (!entry.model && entry.provider !== "mock") continue;
    out.push(entry);
  }
  return out;
}

/**
 * 由设置解析出「这次该发给谁」。
 *
 * @param {object} settings  Settings.ai
 * @param {"flash"|"pro"|string} [modelOrId]
 *        传 "flash"/"pro"：向后兼容的两槽语义；
 *        传模型 id：从 models 清单里精确取。
 * @returns {{provider, baseUrl, model, modelFlash, modelPro, apiKey, ready, sampling,
 *            reason, id, label, maxTokens, contextWindow, needsKey, source}}
 */
export function resolveProvider(settings = {}, modelOrId = "flash") {
  const models = normalizeModels(settings.models);
  const legacyProvider = PROVIDERS.includes(settings.provider) ? settings.provider : "mock";
  const preset = PRESETS[legacyProvider] ?? PRESETS.mock;

  // ---- 1. 按 id 精确取（新语义）----
  if (typeof modelOrId === "string" && modelOrId && modelOrId !== "flash" && modelOrId !== "pro") {
    const hit = models.find((m) => m.id === modelOrId);
    if (hit) return fromEntry(hit, models, settings);
    // id 不在清单里：退化成 mock，并说明原因。
    // 为什么不静默用清单第一个：那会让「下拉框显示 A、实际发给 B」，
    // 是比报错更难查的一类问题。
    const fallback = normalizeModelEntry({
      id: modelOrId,
      label: modelOrId,
      provider: "mock",
      model: DEFAULT_MODELS.mock.flash,
      baseUrl: "",
      needsKey: false
    });
    return {
      ...fromEntry(fallback, models, settings),
      reason: `模型 id「${modelOrId}」不在模型清单里，已退回本地演示模式（检查设置里的模型列表）`
    };
  }

  // ---- 2. 两槽语义（向后兼容，已有单测依赖）----
  const slot = modelOrId === "pro" ? "pro" : "flash";
  const modelFlash =
    String(settings.modelFlash || "").trim() || preset.models.flash || DEFAULT_MODELS[legacyProvider]?.flash || "";
  const modelPro =
    String(settings.modelPro || "").trim() || preset.models.pro || DEFAULT_MODELS[legacyProvider]?.pro || "";
  const chosen = slot === "pro" ? modelPro : modelFlash;
  const baseUrl = String(settings.baseUrl || preset.baseUrl || "").trim();
  const apiKey = String(settings.apiKey || "").trim();
  const sampling = SAMPLING[legacyProvider] ?? SAMPLING_FALLBACK;

  const base = {
    provider: legacyProvider,
    baseUrl: legacyProvider === "mock" ? "" : baseUrl,
    model: chosen,
    modelFlash,
    modelPro,
    apiKey,
    sampling,
    id: "",
    label: slot === "pro" ? "Pro（旧配置）" : "Flash（旧配置）",
    contextWindow: Number(settings.contextWindow) > 0 ? Number(settings.contextWindow) : DEFAULT_CONTEXT_WINDOW,
    maxTokens: Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : DEFAULT_MAX_TOKENS,
    needsKey: preset.needsKey,
    source: ""
  };

  if (legacyProvider === "mock") {
    return { ...base, ready: true, reason: "mock：本地模板回答，不发网络请求" };
  }
  if (!apiKey) {
    return { ...base, ready: false, reason: `没有配置 ${legacyProvider} 的 API Key，自动降级为 mock 演示模式` };
  }
  if (!baseUrl) return { ...base, ready: false, reason: "baseUrl 为空" };
  if (!chosen) return { ...base, ready: false, reason: "没有配置模型名（modelFlash/modelPro 都为空）" };
  return { ...base, ready: true, reason: "" };
}

/**
 * 从一条模型清单条目构造解析结果。
 *
 * 抽出来是因为「按 id 取」与「退化成 mock」两条路径要共用同一套 ready 判定，
 * 否则两处规则会慢慢分叉（典型的「改了 A 忘了 B」）。
 */
function fromEntry(entry, models, settings) {
  const provider = entry.provider;
  const sampling = SAMPLING[provider] ?? SAMPLING_FALLBACK;
  const apiKey = entry.apiKey || String(settings.apiKey || "").trim();
  const base = {
    provider,
    baseUrl: provider === "mock" ? "" : entry.baseUrl,
    model: entry.model,
    // 两槽字段：autoRoute 靠它们回落，取值 = 清单里同 provider 的前两个模型。
    modelFlash: pickSlot(models, provider, "flash"),
    modelPro: pickSlot(models, provider, "pro"),
    apiKey,
    sampling,
    id: entry.id,
    label: entry.label,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    needsKey: entry.needsKey,
    source: entry.source
  };

  if (provider === "mock") {
    return { ...base, ready: true, reason: "mock：本地模板回答，不发网络请求" };
  }
  if (entry.needsKey && !apiKey) {
    // 关键设计：**绝不把空 key 当成可用**。从 Trae 导入的条目天然没 key，
    // 这里必须明确 ready:false + 人话原因，否则界面会显示「已就绪」然后每次请求都 401。
    return {
      ...base,
      ready: false,
      reason:
        entry.source === "trae-import"
          ? "这个模型来自 Trae 导入，但 Trae 的 API Key 是设备绑定的、无法导出，请手动填 Key"
          : `模型「${entry.label}」没有配置 API Key`
    };
  }
  if (!base.baseUrl) return { ...base, ready: false, reason: "baseUrl 为空" };
  if (!entry.model) return { ...base, ready: false, reason: "没有配置模型名" };
  return { ...base, ready: true, reason: "" };
}

/** 取某个 provider 的第 1/2 个模型，供旧的两槽字段回落。 */
function pickSlot(models, provider, slot) {
  const sameProvider = models.filter((m) => m.provider === provider && m.model);
  if (sameProvider.length === 0) {
    const preset = PRESETS[provider];
    return (slot === "pro" ? preset?.models?.pro : preset?.models?.flash) ?? "";
  }
  if (sameProvider.length === 1) return sameProvider[0].model;
  return (slot === "pro" ? sameProvider[1] : sameProvider[0]).model;
}

/**
 * 供界面用的模型清单快照：每条带 ready / needsKey，界面据此渲染下拉框与「未就绪」标记。
 *
 * @param {object} settingsAi Settings.ai
 * @param {string} [activeId]  当前选中的模型 id（省略则用 settingsAi.activeModelId）
 * @returns {{models: Array, active: string}}
 */
export function listModels(settingsAi = {}, activeId = "") {
  const models = normalizeModels(settingsAi.models);
  const active = String(activeId || settingsAi.activeModelId || "").trim();
  const out = models.map((m) => {
    const resolved = resolveProvider(settingsAi, m.id);
    return {
      id: m.id,
      label: m.label,
      provider: m.provider,
      baseUrl: m.baseUrl,
      model: m.model,
      // ⚠ ready = **配置齐全**（provider/baseUrl/model/apiKey 都到位），**不是"能连上"**。
      // 填了假 key、或地址根本不通，这里仍然是 true。要判真实连通性请走 `probeModel()`
      // （bwe:ai-probe-model，带该模型自己的 key 真发一次 /models 探测）。
      // 详见本文件顶部「ready 的语义边界」。
      ready: resolved.ready,
      // `needsKey` 的语义是「这个供应商**类型**是否需要 key」（mock 不需要），
      // 与「**这条**有没有填 key」是两件事。UI 拿它当"要不要提示填 key"会误报：
      // 一条已经填了 key 的 deepseek 模型仍是 needsKey:true，于是显示成「需要填 key」。
      // 所以另外给两个语义明确的字段，UI 用它们决定文案：
      needsKey: Boolean(m.needsKey),
      /** 这条是否真的没有 key（= 需要用户去填）。已是布尔，不再让 UI 自己推断。 */
      needsKeyMissing: Boolean(m.needsKey) && !Boolean(m.apiKey || m.encryptedApiKey),
      /** 这条是否已有 key（不关心有没有填，只管有没有）。 */
      hasApiKey: Boolean(m.apiKey || m.encryptedApiKey),
      source: m.source || "",
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reason: resolved.reason || ""
    };
  });
  // active 没指定 / 指向不存在的 id 时，取第一个 ready 的（界面默认选中它）。
  const activeEffective =
    active && out.some((m) => m.id === active) ? active : (out.find((m) => m.ready)?.id ?? (out[0]?.id ?? ""));
  return { models: out, active: activeEffective };
}

// ---------------------------------------------------------------------------
// mock：本地模板回答
// ---------------------------------------------------------------------------

/**
 * 按意图生成一段「能指导人继续干活」的模板回答（而不是空话）。
 * 这段文本会像真模型一样逐块吐出去，事件形状完全一致。
 */
export function mockAnswer(request) {
  const ctx = request?.context ?? {};
  const intent = request?.intent ?? "chat";
  const lines = [];
  if (intent === "explain-error" || Number(ctx.diagnostics?.errors ?? 0) > 0) {
    const n = Number(ctx.diagnostics?.errors ?? 0) || 1;
    lines.push(`检测到 ${n} 条脚本错误。`);
    if (ctx.diagnostics?.firstError) lines.push(`第一条：${ctx.diagnostics.firstError}`);
    lines.push("");
    lines.push("按这个顺序修最快：");
    lines.push("1. 先解决语法错误（括号、逗号、引号），后面所有诊断都可能被它带偏；");
    lines.push("2. 再看「字段不存在」类错误 —— 多半是 API 名字写错，用 SearchApi 查准确名字；");
    lines.push("3. 最后才查运行时错误（空引用、越界），这类需要看触发它的那一帧在做什么。");
    if (ctx.activeScript?.name) {
      lines.push("");
      lines.push(`当前脚本「${ctx.activeScript.name}」共 ${String(ctx.activeScript.code ?? "").split("\n").length} 行，改完点「试跑」看输出面板。`);
    }
  } else if (intent === "edit-script") {
    lines.push("可以改，但先确认两件事，我才能给一段可直接替换的代码：");
    lines.push("1. 期望行为是什么（「走得更快」还是「撞墙停住」）；");
    lines.push("2. 这段逻辑现在挂在哪个回调上（onStart / onUpdate / onClick）。");
    lines.push("");
    lines.push(`当前脚本：${ctx.activeScript?.name ?? "（未提供）"}。`);
    lines.push("把要改的那个函数整段贴进来，我会只动必要的那几行。");
  } else if (intent === "scene-review") {
    lines.push("已收到工程摘要（对象数量与脚本清单，不含素材二进制）。审场景我会先看这三类问题：");
    lines.push("1. 碰撞覆盖：可走区域边界上是否有碰撞体，触发区和实体是否重叠；");
    lines.push("2. 图层与 y 排序：后画的精灵是否盖住交互物件；");
    lines.push("3. 脚本开销：onUpdate 里有没有每帧 new 对象、全量遍历场景、字符串拼接动画。");
    lines.push("");
    lines.push(`摘要首行：${String(ctx.sceneDigest ?? "（未提供）").split("\n")[0]}`);
  } else {
    lines.push("我现在处于**本地演示模式**（mock provider）：回答来自内置模板，不发任何网络请求，也不产生费用。");
    lines.push("");
    lines.push("如果你看到这段文字，说明整条链路是通的：");
    lines.push("· 主进程 → IPC 流式事件 → 渲染侧面板；");
    lines.push("· 用量条显示的是**模拟值**：命中 / 未命中输入被刻意拆开，用来验证 TokenUsage 的 disjoint 记账；");
    lines.push("· 在「设置 → AI」里切到配置好 Key 的模型，就会换成真模型，界面不用改。");
    if (ctx.sceneDigest) {
      lines.push("");
      lines.push(`已收到工程摘要：${ctx.sceneDigest.split("\n")[0]}`);
    }
  }
  return lines.join("\n");
}

/**
 * mock 的本地流：按 18 字符切片吐字，给出自洽 usage。
 *
 * 模拟的 usage 刻意做成「前缀命中」的形状：
 *   system prompt 与工具定义（约 1.6K token）假设命中缓存，用户消息未命中 ——
 * 这样界面上 cacheHitRate 是个有意义的数（不是 0 也不是 100）。
 */
export function createMockStream(request, { cancelled } = {}) {
  const text = mockAnswer(request);
  const systemTokens = 1650; // prefix.mjs 的四个常量块 + 3 个工具定义
  const userTokens = Math.max(
    40,
    Math.ceil(String(request?.messages?.map((m) => m.text).join("") ?? "").length / 4)
  );
  const outputTokens = Math.ceil(text.length / 4.5);
  let emitted = 0;
  let aborted = false;

  return {
    cancel() {
      aborted = true;
      cancelled?.();
    },
    /** 逐步产出事件：调用方每次 next() 拿一个事件，直到 done。 */
    async *iterate() {
      const usage = {
        inputTokens: userTokens,
        cacheReadTokens: systemTokens,
        cacheWriteTokens: 0,
        outputTokens: 0
      };
      let index = 0;
      while (index < text.length) {
        if (aborted) {
          yield {
            type: "end",
            text: text.slice(0, emitted),
            usage: fromProviderUsage(
              {
                prompt_cache_hit_tokens: systemTokens,
                prompt_cache_miss_tokens: userTokens,
                completion_tokens: Math.ceil(emitted / 4.5)
              },
              { reason: "aborted" }
            ),
            error: "已取消"
          };
          return;
        }
        const next = text.slice(index, index + 18);
        index += 18;
        emitted += next.length;
        yield { type: "delta", text: next };
        // 让出事件循环，模拟真实流式的节奏；也让取消能在下一个切片生效。
        await new Promise((r) => setTimeout(r, 40));
      }
      usage.outputTokens = outputTokens;
      yield {
        type: "end",
        text,
        usage: fromProviderUsage(
          {
            prompt_cache_hit_tokens: systemTokens,
            prompt_cache_miss_tokens: userTokens,
            completion_tokens: outputTokens
          },
          { reason: "mock" }
        ),
        status: 200
      };
    }
  };
}

/** mock 的「会话累计用量」：把每次 mock usage 加起来，界面上的夜间省额也有数。 */
export function accumulateMockUsage(prev, usage) {
  return mergeUsage(prev ?? emptyUsage(), usage);
}
