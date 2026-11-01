/**
 * AI 层 · Trae 配置导入器。
 *
 * 目标：把用户机器上 Trae（一个 Electron 版的 AI IDE）里**已经配好**的自定义供应商
 * 读出来，变成 BWE Studio 里可选的模型条目，省掉用户手工抄 base_url 和模型名的麻烦。
 *
 * 数据来源（本机实测确认）：
 *   %APPDATA%\Trae CN\User\globalStorage\state.vscdb   （SQLite）
 *   键 4337993333357580_AI.agent.model.model_list_map  （明文 JSON，64KB 左右）
 *   结构 { solo_coder: [...], builder: [...], ... }，同一个模型会在多个分组里重复出现。
 *
 * ⚠ 两条硬约束（写死了，不要改）：
 *
 * 1. **不解密 Trae 的 API Key，也不写解密代码。**
 *    实测它的 `ak` 是 79 字节 = 12B nonce + 51B 密文 + 16B tag（AES-256-GCM），
 *    密钥由 Trae 服务端按设备下发，DPAPI / os_crypt 主密钥 / sha256(deviceId) 等
 *    常见派生全部 GCM 认证失败。既解不开，也不该去破解别人的凭据存储。
 *    所以导入结果里 `apiKey` 恒为空、`needsKey: true`，界面显示「需要手动填 key」。
 *
 * 2. **绝不把空 key 当成可用。**
 *    导入条目带 `source: "trae-import"`，`resolveProvider()` 见到 needsKey 且无 key
 *    就明确 ready:false 并给出人话原因 —— 否则界面显示「已就绪」，用户一提问就 401。
 *
 * 读不到 sqlite / 没有 Trae / 结构变了，一律降级成「带人话原因的失败」，不抛异常。
 * 纯 Node 标准库 + node:sqlite（Node 22+ 自带），不装任何包。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeProvidersReachable } from "./probe.mjs";

/** Trae 存储里模型清单的键（前缀是该 Trae 实例的 workspace 标识，实测固定）。 */
export const TRAE_MODEL_KEY = "4337993333357580_AI.agent.model.model_list_map";

/** 候选的 Trae 安装/配置目录名（CN 版与海外版都覆盖）。 */
const TRAE_DIR_NAMES = ["Trae CN", "Trae", "Trae CN Insiders", "Trae Insiders"];

// 探测超时统一由 probe.mjs 提供（PROBE_TIMEOUT_MS），避免两处写不同的值。

/**
 * 找到本机 Trae 的 state.vscdb 路径。
 *
 * @returns {{path: string|null, tried: string[]}}
 */
export function findTraeDb() {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const tried = [];
  for (const name of TRAE_DIR_NAMES) {
    for (const rel of ["User/globalStorage/state.vscdb", "User/workspaceStorage"]) {
      const full = join(appData, name, rel);
      tried.push(full);
      if (rel.endsWith("state.vscdb") && existsSync(full)) return { path: full, tried };
    }
  }
  return { path: null, tried };
}

/**
 * 从 model_list_map 的原始 JSON 抽出候选供应商。
 *
 * 这一步刻意做成**纯函数**（不碰 fs / sqlite），因为它是整个导入器里唯一有解析风险的地方，
 * 必须能单独用样本数据测：Trae 哪天改字段名，改这里 + 改单测即可，不影响读取逻辑。
 *
 * @param {object|string} rawMap      解析后的对象，或原始 JSON 字符串
 * @returns {{providers: Array, warnings: string[], totalEntries: number, uniqueModels: number}}
 */
export function parseTraeModelMap(rawMap) {
  const warnings = [];
  let data = rawMap;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e) {
      return { providers: [], warnings: [`Trae 的模型清单不是合法 JSON：${e.message}`], totalEntries: 0, uniqueModels: 0 };
    }
  }
  if (!data || typeof data !== "object") {
    return { providers: [], warnings: ["Trae 的模型清单结构不是对象，无法解析"], totalEntries: 0, uniqueModels: 0 };
  }

  // 同一个模型会在 solo_coder / builder / code_reviewer 等多个分组重复出现，
  // 用 provider+baseUrl+模型名 去重（实测 46 条 → 2 条唯一自定义模型）。
  const seen = new Map();
  let totalEntries = 0;
  for (const [bucket, list] of Object.entries(data)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      totalEntries += 1;
      // 只取「自定义供应商」条目：Trae 内置模型没有 base_url（走它自己的网关）。
      if (!item.base_url) continue;
      const baseUrl = String(item.base_url).trim();
      if (!baseUrl) continue;
      const provider = String(item.provider || "custom").trim();
      const rawName = String(item.name || "");

      // ⚠ 模型名的坑（实测踩过一次，会导致请求必然失败）：
      // Trae 的 `custom_model_id` 是**它内部的数字 ID**（例如 "7443714"），
      // 不是 OpenAI 兼容接口的模型名。真正要发给供应商的是 `name` 里
      // `provider//` 之后的部分 —— 实测 "siliconflow//moonshotai/Kimi-K2-Thinking"
      // 对应的模型名是 "moonshotai/Kimi-K2-Thinking"。
      // 如果拿 custom_model_id 当 model 发出去，供应商会报「模型不存在」。
      const stripped = rawName.includes("//") ? rawName.split("//").slice(1).join("//") : rawName;
      const apiModel = String(stripped || "").trim();
      if (!apiModel) continue; // 连模型名都没有，没法用
      const key = `${provider}|${baseUrl}|${apiModel}`;
      if (seen.has(key)) continue;

      // 展示名优先 display_name（人类可读），否则用剥掉前缀的模型名。
      const label = String(item.display_name || apiModel).trim();
      // Trae 的数字 ID 只留作参考（排查「这个模型在 Trae 里是哪条」时有用）。
      const traeModelId = String(item.custom_model_id || "").trim();

      // context_window_size 可能是 { max:[n], default:n } 或直接数字；都兼容。
      const cw = item.context_window_size;
      const contextWindow =
        typeof cw === "number" ? cw : Number(cw?.default ?? cw?.max?.[0]) > 0 ? Number(cw.default ?? cw.max[0]) : 0;

      seen.set(key, {
        provider,
        baseUrl,
        model: apiModel,
        label,
        contextWindow: contextWindow || 0,
        traeModelId,
        modelType: String(item.model_type || ""),
        buckets: [bucket]
      });
    }
  }

  // 按 baseUrl 归组（一个供应商常常挂多个模型）。
  const byBase = new Map();
  for (const entry of seen.values()) {
    if (!byBase.has(entry.baseUrl)) {
      byBase.set(entry.baseUrl, { provider: entry.provider, baseUrl: entry.baseUrl, models: [], origins: [] });
    }
    const group = byBase.get(entry.baseUrl);
    group.models.push({
      id: `${entry.provider}::${entry.model}`,
      label: entry.label,
      // 发给供应商的模型名（见上方「模型名的坑」）
      model: entry.model,
      contextWindow: entry.contextWindow,
      modelType: entry.modelType,
      traeModelId: entry.traeModelId
    });
    group.origins.push(entry.buckets[0]);
  }

  const providers = [...byBase.values()].map((g) => ({
    provider: g.provider,
    baseUrl: g.baseUrl,
    models: g.models,
    // 关键：导入的条目没有 key。写死 false 而不是"留空"，让界面能直接判断。
    hasKey: false,
    needsKey: true,
    // 网络可达性由 probeReachable 异步补上；这里是结构默认值。
    reachable: null,
    note: "Trae 的 API Key 是设备绑定的，无法导出；请手动填写"
  }));

  if (providers.length === 0) {
    warnings.push(
      "Trae 里有模型配置，但都是它内置的模型（没有自定义 base_url），没有可导入的自定义供应商。"
    );
  }

  return { providers, warnings, totalEntries, uniqueModels: seen.size };
}

/**
 * 导入后的供应商级可达性自检（**不带 key**，只判"网络通不通"）。
 *
 * 实现已抽到 `probe.mjs`（`probeProvidersReachable`）—— 那条链还有第二个使用者
 * （`bwe:ai-probe-model`，带 key 的真实探测）。**同一个 `/models` 探测逻辑只能有一份**，
 * 否则 HEAD→GET 降级规则、401 语义、超时处理会在两处慢慢分叉。
 *
 * @param {Array} providers  parseTraeModelMap 的产物
 * @returns {Promise<Array>} 补了 reachable / reachableStatus / reachableMethod / reachableDetail
 */
export const probeReachable = probeProvidersReachable;

/**
 * 打开 state.vscdb 并读出模型清单原始 JSON。
 *
 * 用 `node:sqlite` 的 DatabaseSync 以 **readOnly** 打开：我们只读、绝不写 Trae 的库。
 * 取不到 node:sqlite（Node 版本太低）或库被占用时，返回可读的错误而不是崩。
 *
 * @returns {Promise<{raw: string|null, dbPath: string|null, warnings: string[], error?: string}>}
 */
export async function readTraeModelList() {
  const { path: dbPath, tried } = findTraeDb();
  if (!dbPath) {
    return {
      raw: null,
      dbPath: null,
      warnings: [
        "没有在本机找到 Trae 的配置文件（state.vscdb）。",
        `已尝试：${tried.slice(0, 3).join(" / ")} …`,
        "如果你没装 Trae，可以跳过导入，直接在设置里手动添加模型。"
      ]
    };
  }

  let DatabaseSync;
  try {
    // 动态 import：Node 22 以下没有 node:sqlite，静态 import 会让整个模块加载失败。
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (e) {
    return {
      raw: null,
      dbPath,
      warnings: [
        `当前 Node 不支持 node:sqlite（${e?.message || e}）。`,
        "导入 Trae 配置需要 Node 22+（本编辑器随包的 Electron 已满足）。",
        "可以改为在设置里手动添加模型。"
      ]
    };
  }

  let db = null;
  try {
    // ⚠ readOnly：绝不写 Trae 的数据库。
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(TRAE_MODEL_KEY);
    if (!row) {
      return {
        raw: null,
        dbPath,
        warnings: [
          "Trae 的配置里没有模型清单（可能还没登录过 Trae，或版本改了键名）。",
          `期望的键：${TRAE_MODEL_KEY}`
        ]
      };
    }
    // value 可能是 TEXT 也可能是 BLOB，两种都兼容。
    const raw = typeof row.value === "string" ? row.value : row.value?.toString("utf8") ?? "";
    return { raw, dbPath, warnings: [] };
  } catch (e) {
    // 常见：Trae 正在运行，SQLite 加了锁。
    return {
      raw: null,
      dbPath,
      warnings: [`读取 Trae 配置失败：${e?.message || e}`, "如果 Trae 正在运行，先关掉它再试一次。"]
    };
  } finally {
    try {
      db?.close();
    } catch {
      // 关闭失败不影响结果。
    }
  }
}

/**
 * 完整导入流程：读库 → 解析 → 网络自检。
 *
 * @param {object} [options]
 * @param {boolean} [options.probe=true]  是否做网络可达性自检（单测里关掉，避免真联网）
 * @param {object} [options.overrideRaw]  直接给 JSON 字符串（单测用，绕过真实 Trae）
 * @returns {Promise<{ok: boolean, providers: Array, warnings: string[], dbPath: string|null,
 *                    totalEntries: number, uniqueModels: number}>}
 */
export async function importTraeConfig(options = {}) {
  const { probe = true, overrideRaw = null } = options;

  if (overrideRaw !== null) {
    const parsed = parseTraeModelMap(overrideRaw);
    const providers = probe ? await probeReachable(parsed.providers) : parsed.providers;
    return { ok: providers.length > 0, providers, warnings: parsed.warnings, dbPath: null, ...parsed, providers };
  }

  const read = await readTraeModelList();
  if (!read.raw) {
    return {
      ok: false,
      providers: [],
      warnings: read.warnings,
      dbPath: read.dbPath,
      totalEntries: 0,
      uniqueModels: 0
    };
  }

  const parsed = parseTraeModelMap(read.raw);
  const providers = probe ? await probeReachable(parsed.providers) : parsed.providers;
  return {
    ok: providers.length > 0,
    providers,
    warnings: [...read.warnings, ...parsed.warnings],
    dbPath: read.dbPath,
    totalEntries: parsed.totalEntries,
    uniqueModels: parsed.uniqueModels
  };
}

/**
 * 把导入结果转成 settings 里的模型条目（供 `bwe:ai-import-trae` 直接落盘用）。
 *
 * 关键：`apiKey` 恒为空、`needsKey: true`、`source: "trae-import"`。
 * 这些标记是「以后审计这个模型哪来的」的唯一线索，不能省。
 *
 * @param {Array} providers  probeReachable 之后的产物
 * @param {{prefix?: string, defaultMaxTokens?: number}} [opts]
 */
export function toModelEntries(providers, opts = {}) {
  const prefix = opts.prefix ?? "trae";
  const defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  const entries = [];
  for (const p of providers) {
    for (const m of p.models) {
      // id 要稳定：同一个供应商同一个模型重复导入必须得到同一个 id，
      // 否则用户填好的 key 会在第二次导入时"丢"（id 变了，key 对不上）。
      const slug = `${p.provider}-${m.model}`.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").toLowerCase();
      entries.push({
        id: `${prefix}:${slug}`,
        label: m.label || m.model,
        provider: p.provider,
        baseUrl: p.baseUrl,
        model: m.model,
        apiKey: "",
        contextWindow: m.contextWindow || 0,
        maxTokens: defaultMaxTokens,
        needsKey: true,
        source: "trae-import",
        notes: `从 Trae 导入${p.reachable === false ? "（该地址当前不可达）" : ""}；API Key 需手动填写`
      });
    }
  }
  return entries;
}
