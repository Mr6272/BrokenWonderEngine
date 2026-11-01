/**
 * AI 层 · 模型清单的写操作（纯逻辑，可单测）。
 *
 * 为什么单独抽出来：这些规则（稳定 id、覆盖语义、apiKey 的三种状态、active 校验）
 * 是这部分需求里最容易出错、也最值得单测的部分。写在 app-main.mjs 里就只能靠真 Electron
 * 跑才能验证 —— 那是「测得慢、还测不到边界」的典型。
 *
 * 四条规则（都踩过或预见过）：
 *
 * 1. **同一条模型只能有一条**：按 `provider + baseUrl + model` 判重（不是按 id）。
 *    因为同一条模型可能来自 Trae 导入（id=`trae:...`），也可能被用户手填（id 原本会是
 *    `manual:...`）；按 id 判重会变成两条一样的。命中已有条目时就地更新、**保留原 id**
 *    —— 这样用户在 Trae 导入的条目上填 key，不会冒出第二条。
 *
 * 2. **id 必须稳定可预测**：新建时用 `manual:<provider>:<slug>`；同组合重复添加命中上面
 *    的判重，所以 id 不会漂移。Trae 导入沿用 `trae:<provider>-<slug>`（已有用户数据在用）。
 *
 * 3. **apiKey 三态语义**（Lead 明确要求「空串不会误清 key」）：
 *    · 不传 apiKey        → 不动（切换模型、改 label 时的正常路径）
 *    · apiKey = ""（空串）→ **也不动**（UI 输入框没填时天然是空串，不能当清空）
 *    · apiKey = "sk-xxx"  → 覆盖
 *    · clearApiKey = true → 显式清除（唯一能删 key 的方式）
 *    把空串当「清除」在 UI 上等价于「切一次模型就丢一次 key」，必须避免。
 *
 * 4. **未知 provider 不静默吞掉**：回落 openai-compatible 行为，但在返回值里带 warning，
 *    免得用户以为自己的 provider 生效了。
 */

import {
  normalizeModels, normalizeModelEntry, PROVIDERS, PRESETS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS
} from "./provider.mjs";

/** 把任意字符串变成可读的 id 片段（模型名里常有 `/`、`:`、空格）。 */
export function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/** 生成手动条目的稳定 id。 */
export function stableModelId(provider, model) {
  const p = slugify(provider) || "custom";
  const m = slugify(model) || "model";
  return `manual:${p}:${m}`;
}

/** 判重键：同一供应商 + 同一地址 + 同一模型名 = 同一条模型。 */
function identityKey(entry) {
  return [
    String(entry.provider ?? "").toLowerCase(),
    String(entry.baseUrl ?? "").replace(/\/+$/, "").toLowerCase(),
    String(entry.model ?? "").trim()
  ].join("|");
}

/**
 * 添加（或覆盖）一条手动模型。
 *
 * @param {Array} models  现有清单
 * @param {object} patch   { label, provider, baseUrl, model, apiKey?, contextWindow?, maxTokens?, notes? }
 * @returns {{ok:boolean, models:Array, id?:string, created?:boolean, updated?:boolean,
 *            error?:string, warning?:string}}
 */
export function addModel(models, patch) {
  const input = patch && typeof patch === "object" ? patch : {};
  const model = String(input.model ?? "").trim();
  if (!model) {
    return {
      ok: false,
      models: normalizeModels(models),
      error: "缺少模型名（例如 moonshotai/Kimi-K2-Thinking 或 deepseek-v4-flash）"
    };
  }
  const providerRaw = String(input.provider ?? "").trim();
  if (!providerRaw) {
    return { ok: false, models: normalizeModels(models), error: "缺少供应商（provider）" };
  }

  // 未知 provider 也接受（用户可能填反代 / 自建服务），按 openai-compatible 行为处理，
  // 但要在返回里说明，免得他以为 provider 生效了。
  const providerKnown = PROVIDERS.includes(providerRaw);
  const provider = providerKnown ? providerRaw : "openai-compatible";
  const preset = PRESETS[provider] ?? PRESETS["openai-compatible"];
  const baseUrl = String(input.baseUrl ?? "").trim() || preset.baseUrl;
  if (!baseUrl && provider !== "mock") {
    return {
      ok: false,
      models: normalizeModels(models),
      error: `供应商「${provider}」需要 baseUrl（例如 https://api.deepseek.com）`
    };
  }

  const current = normalizeModels(models);
  // 按 provider+baseUrl+model 判重（见文件头规则 1），不是按 id。
  const probeKey = identityKey({ provider, baseUrl, model });
  const existingIndex = current.findIndex((m) => identityKey(m) === probeKey);

  const entry = normalizeModelEntry({
    id: existingIndex >= 0 ? current[existingIndex].id : stableModelId(providerRaw, model),
    label: String(input.label ?? "").trim() || model,
    provider,
    baseUrl,
    model,
    apiKey: "",
    contextWindow: input.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    needsKey: provider !== "mock",
    source: "manual",
    notes: String(input.notes ?? "")
  });

  // apiKey 三态：只有非空字符串才算「要写入」。
  const apiKeyRaw = input.apiKey;
  const hasApiKeyValue = typeof apiKeyRaw === "string" && apiKeyRaw.trim().length > 0;

  const warning = providerKnown ? undefined : `未知供应商「${providerRaw}」，已按「${provider}」处理`;

  if (existingIndex >= 0) {
    const prev = current[existingIndex];
    // 覆盖时不覆盖用户已填的 key（除非这次显式给了新 key / 显式清除）。
    entry.apiKey = hasApiKeyValue
      ? String(apiKeyRaw).trim()
      : input.clearApiKey === true
        ? ""
        : (prev.apiKey || "");
    // 保留原来源标记：从 Trae 导入的条目被手填 key 之后，仍然是 trae-import 来源
    if (prev.source && !entry.source.startsWith("trae")) entry.source = prev.source;
    current[existingIndex] = entry;
    return { ok: true, models: current, id: entry.id, created: false, updated: true, warning };
  }

  entry.apiKey = hasApiKeyValue ? String(apiKeyRaw).trim() : "";
  current.push(entry);
  return { ok: true, models: current, id: entry.id, created: true, updated: false, warning };
}

/**
 * 切换当前模型（可顺带填 / 清 key）。
 *
 * apiKey 语义与 addModel 一致：**空串不清 key**。要清就传 clearApiKey: true。
 *
 * @returns {{ok:boolean, models:Array, active?:string, error?:string}}
 */
export function setActiveModel(models, activeId, patch = {}) {
  const current = normalizeModels(models);
  const id = String(activeId ?? "").trim();
  if (!id) return { ok: false, models: current, error: "缺少模型 id" };
  const index = current.findIndex((m) => m.id === id);
  if (index < 0) {
    return {
      ok: false,
      models: current,
      error: `模型 id「${id}」不在清单里（可能已被删除），请先导入或添加模型`
    };
  }
  const entry = { ...current[index] };
  const apiKeyRaw = patch?.apiKey;
  if (typeof apiKeyRaw === "string" && apiKeyRaw.trim().length > 0) {
    entry.apiKey = apiKeyRaw.trim();
  } else if (patch?.clearApiKey === true) {
    // 显式清除：唯一能删 key 的途径
    entry.apiKey = "";
  }
  // 空串 / 不传 → 什么都不做（切模型不该顺手把 key 弄丢）
  current[index] = entry;
  return { ok: true, models: current, active: id };
}

/** 删除一条模型（UI 的「移除」按钮用）。 */
export function removeModel(models, id) {
  const current = normalizeModels(models);
  const target = String(id ?? "").trim();
  const next = current.filter((m) => m.id !== target);
  if (next.length === current.length) {
    return { ok: false, models: current, error: `模型 id「${target}」不在清单里` };
  }
  return { ok: true, models: next, removed: target };
}
