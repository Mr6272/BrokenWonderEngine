/**
 * AI 层 · provider 抽象（deepseek / openai-compatible / mock）。
 *
 * 为什么 mock 必须是一等公民而不是「出错时的兜底」：
 *   离线环境没有 key、验收时也不该花真钱。但「流式对话 + 用量 + 缓存指标」这套界面
 *   必须能演示、能截图、能回归。所以 mock 是一条正常路径：本地模板回答、逐块吐字、
 *   给出**自洽的** usage（含命中/未命中的拆分），不发任何网络请求。
 *
 * 采样的稳定性（契约 §4.3 第 7 条）：temperature/top_p 按 provider 固定，
 * 不随轮次或意图变化 —— 变了等于让前缀缓存失去意义，也让回答不可复现。
 */

import { emptyUsage, fromProviderUsage, mergeUsage } from "./usage.mjs";

export const PROVIDERS = ["deepseek", "openai-compatible", "mock"];

export const DEFAULT_BASE_URLS = {
  deepseek: "https://api.deepseek.com",
  "openai-compatible": "https://api.openai.com/v1",
  mock: ""
};

export const DEFAULT_MODELS = {
  deepseek: { flash: "deepseek-chat", pro: "deepseek-reasoner" },
  "openai-compatible": { flash: "gpt-4o-mini", pro: "gpt-4o" },
  mock: { flash: "mock-flash", pro: "mock-pro" }
};

/** 采样参数按 provider 固定，写在这里而不是散落在调用点。 */
export const SAMPLING = {
  deepseek: { temperature: 0.3, topP: 0.95 },
  "openai-compatible": { temperature: 0.3, topP: 0.95 },
  mock: { temperature: 0, topP: 1 }
};

/**
 * 由设置解析出「这次该发给谁」。
 *
 * @param {object} settings  Settings.ai
 * @returns {{provider, baseUrl, model, modelFlash, modelPro, apiKey, ready, sampling, reason}}
 */
export function resolveProvider(settings = {}, model = "flash") {
  const provider = PROVIDERS.includes(settings.provider) ? settings.provider : "mock";
  const baseUrl = String(settings.baseUrl || DEFAULT_BASE_URLS[provider] || "").trim();
  const models = DEFAULT_MODELS[provider];
  const modelFlash = String(settings.modelFlash || "").trim() || models.flash;
  const modelPro = String(settings.modelPro || "").trim() || models.pro;
  const chosen = model === "pro" ? modelPro : modelFlash;
  const apiKey = String(settings.apiKey || "").trim();

  if (provider === "mock") {
    return {
      provider,
      baseUrl: "",
      model: chosen,
      modelFlash,
      modelPro,
      apiKey: "",
      ready: true,
      sampling: SAMPLING.mock,
      reason: "mock：本地模板回答，不发网络请求"
    };
  }
  if (!apiKey) {
    return {
      provider,
      baseUrl,
      model: chosen,
      modelFlash,
      modelPro,
      apiKey: "",
      ready: false,
      sampling: SAMPLING[provider],
      reason: `没有配置 ${provider} 的 API Key，自动降级为 mock 演示模式`
    };
  }
  if (!baseUrl) {
    return { provider, baseUrl, model: chosen, modelFlash, modelPro, apiKey, ready: false, sampling: SAMPLING[provider], reason: "baseUrl 为空" };
  }
  return { provider, baseUrl, model: chosen, modelFlash, modelPro, apiKey, ready: true, sampling: SAMPLING[provider], reason: "" };
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
    lines.push("· 用量条显示的是**模拟值**：命中/未命中输入被刻意拆开，用来验证 TokenUsage 的 disjoint 记账；");
    lines.push("· 在「设置 → AI」里把 provider 换成 deepseek 并填 API Key，就会换成真模型，界面不用改。");
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
  const userTokens = Math.max(40, Math.ceil(String(request?.messages?.map((m) => m.text).join("") ?? "").length / 4));
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
              { prompt_cache_hit_tokens: systemTokens, prompt_cache_miss_tokens: userTokens, completion_tokens: Math.ceil(emitted / 4.5) },
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
          { prompt_cache_hit_tokens: systemTokens, prompt_cache_miss_tokens: userTokens, completion_tokens: outputTokens },
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
