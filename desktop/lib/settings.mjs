/**
 * 桌面壳 · 设置读写（含 API Key 的 DPAPI 加密落盘）。
 *
 * 契约 §3 / §4.4：settings.json 里 apiKey 用 `encryptedApiKey` 存，
 * 明文只在内存里出现；Windows 上走 Electron safeStorage（底层 DPAPI，按用户加密）。
 *
 * 两代结构并存（因为必须向后兼容老 settings.json）：
 *   · 旧：`ai.apiKey` + `ai.modelFlash/modelPro`（单个供应商两个槽）
 *   · 新：`ai.models: [{ id, label, provider, baseUrl, model, apiKey, ... }]`
 *        —— 每个模型条目可以有**自己的** key（不同供应商要用不同的 key）
 *
 * 加密粒度也跟着变：旧 key 存顶层 `encryptedApiKey`；新清单里每个条目的 key
 * 存该条目自己的 `encryptedApiKey`，明文 `apiKey` 只在内存。
 *
 * 取不到 safeStorage 时**不报错、不丢功能**：退回明文并标记 `insecure: true`，
 * 让界面能明确提示「这台机器上 key 是明文存的」。静默降级比报错更危险，
 * 所以标记是必填字段，不是可选项。
 *
 * 与 Electron 解耦：加解密函数由调用方注入（主进程传 safeStorage，单测传假实现）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SETTINGS_VERSION = 2;

/** 默认设置（契约 §3 的 Settings 结构 + 新增 models 清单）。 */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    ai: {
      provider: "mock",
      baseUrl: "",
      // apiKey 只存在于内存；落盘时被替换成 encryptedApiKey。
      apiKey: "",
      modelFlash: "",
      modelPro: "",
      autoRoute: true,
      manualModel: "",
      // 当前选中的模型 id（models 清单里的 id）。空 = 用 autoRoute 的两槽逻辑。
      activeModelId: "",
      // 可增删的模型清单。每条可带自己的 apiKey（内存）/ encryptedApiKey（磁盘）。
      models: [],
      contextWindow: 128000,
      /**
       * 输出预算上限。取 16384 而不是原来的 4096：
       * 思考模型的 reasoning_content 与正文**共享**这个预算，4096 常在"想完"后就所剩无几，
       * 正文被截断（用户看到的「答半句就没了」）。见 provider.mjs DEFAULT_MAX_TOKENS 的注释。
       */
      maxTokens: 16384
    },
    editor: { theme: "cream", uiScale: 1, autoSave: true },
    // 记录 key 是否明文存的（见文件头注释）
    insecure: false,
    /**
     * key 密文**解不开**（不是「没填」）。
     *
     * 两种状态必须区分，下一步动作完全不同：
     *   · needsKeyMissing（什么都没填）→ 用户去填
     *   · keyUndecryptable（填过但解不开）→ 用户**重新粘贴一次**
     *
     * 为什么会有后者：Electron safeStorage 在 Windows 上可能
     * 「isEncryptionAvailable()=true 但 decryptString 失败」（DPAPI 密钥上下文
     * 在进程/会话重启后不一致，或 Electron 升级后参数变化）。
     * 此时密文还在磁盘上但解不开 —— 若按「没填」处理，用户明明填过却看到「待填」，
     * 发请求带空 key 必然 401，而用户完全不知道去哪修。
     */
    keyUndecryptable: false,
    /** 哪些条目解不开：{ scope: "top-level"|"model", id }，供 UI 精确提示。 */
    keyUndecryptableEntries: [],
    /** 上次保存时是否因为加密不可用而降级成明文（降级必须告知用户，不能偷偷做）。 */
    keyPlaintextFallback: false
  };
}

/** 深合并：settings.json 是用户手改过的，缺字段要补默认值，多字段要保留。 */
export function mergeSettings(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    // 数组一律整体替换（尤其是 models：逐项合并会让「删掉一个模型」失效）
    if (Array.isArray(v)) {
      out[k] = v;
    } else if (v && typeof v === "object" && base?.[k] && typeof base[k] === "object") {
      out[k] = mergeSettings(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.file   settings.json 绝对路径
 * @param {{available:boolean, encryptString?:(s:string)=>string, decryptString?:(s:string)=>string}} opts.crypto
 */
export function createSettingsStore({ file, crypto, log }) {
  const encryptAvailable = Boolean(crypto?.available && crypto.encryptString && crypto.decryptString);
  let cache = null;

  /**
   * 解密一段密文；失败返回 null（换机器/换用户解不开是正常情况，不该崩）。
   *
   * ⚠ 失败时**必须留日志**：这是"用户明明填过 key 却用不了"的直接证据。
   * 静默 return null 会让排查者以为「根本没填」，与真实原因（填了但解不开）相反 ——
   * 我们刚在这条上踩过一次（探针读文件失败被 catch 吞成 null → 表现成"没有 key"）。
   */
  function tryDecrypt(enc, context = "") {
    if (!encryptAvailable || typeof enc !== "string" || !enc) return null;
    try {
      return crypto.decryptString(enc);
    } catch (e) {
      log?.(`key 解密失败${context ? `（${context}）` : ""}：${e?.message || e}`);
      return null;
    }
  }

  /** 加密一段明文 → base64；不可用返回 null（**调用方必须据此降级并标记 insecure**）。 */
  function tryEncrypt(plain, context = "") {
    if (!encryptAvailable || !plain) return null;
    try {
      return crypto.encryptString(plain);
    } catch (e) {
      log?.(`key 加密失败${context ? `（${context}）` : ""}：${e?.message || e}（将降级为明文存储）`);
      return null;
    }
  }

  return {
    get file() {
      return file;
    },

    async load() {
      if (cache) return cache;
      const raw = (await readJson(file, null)) ?? {};
      const defaults = defaultSettings();
      const merged = mergeSettings(defaults, raw);
      let sawUndecryptable = false;
      /** 哪些条目的密文解不开：{scope:'top-level'|'model', id}。供 UI 精确提示。 */
      const undecryptableEntries = [];

      // ---- 旧结构：顶层 encryptedApiKey ----
      const enc = raw.encryptedApiKey;
      if (typeof enc === "string" && enc) {
        const plain = tryDecrypt(enc, "顶层 key");
        if (plain !== null) merged.ai.apiKey = plain;
        else {
          merged.ai.apiKey = "";
          // ⚠ 同时清掉内存里的密文：否则 hasApiKey 会按「有密文」算成 true，
          // 界面显示「已配置 Key」，实际请求必然 401 —— 这是最容易误导用户的状态。
          // 磁盘上的密文不动（换回原机器还能用），只是本次会话不认为它有 key。
          merged.encryptedApiKey = "";
          sawUndecryptable = true;
          undecryptableEntries.push({ scope: "top-level", id: "" });
        }
      }

      // ---- 新结构：每个模型条目自己的 encryptedApiKey ----
      //
      // ⚠ 这里有一个**产品级缺陷**必须显式处理（用户实际踩到）：
      //   Electron safeStorage 在 Windows 上可能「isEncryptionAvailable()=true 但 decryptString 失败」
      //   （DPAPI 密钥上下文在进程/会话重启后不一致，或 Electron 升级后参数变化）。
      //   此时条目的密文还在，但解不开 —— 用户明明填过 key，界面却按「没填」处理，
      //   发请求带空 key → 400/401 → 用户以为 AI 坏了。
      //   两种状态必须区分：needsKeyMissing（真没填）vs keyUndecryptable（填了但解不开）。
      //   前者「去填」，后者「重新粘贴一次」——下一步动作完全不同。
      const rawModels = Array.isArray(raw.ai?.models) ? raw.ai.models : [];
      merged.ai.models = rawModels.map((m) => {
        const entry = { ...(m && typeof m === "object" ? m : {}) };
        const entryEnc = entry.encryptedApiKey;
        if (typeof entryEnc === "string" && entryEnc) {
          const plain = tryDecrypt(entryEnc, `模型 ${entry.id ?? "?"}`);
          entry.apiKey = plain ?? "";
          if (plain === null) {
            // 同上：解不开就清掉内存密文，别让界面误报「已配置」
            // ⚠ 但磁盘密文必须**归档保留**：不能因为这次解不开就把用户的 key 删了。
            //   万一以后环境恢复（换回原机器/修好 safeStorage）还能解回来。
            entry.encryptedApiKeyBak = entryEnc;
            entry.encryptedApiKey = "";
            sawUndecryptable = true;
            entry.keyUndecryptable = true;
            undecryptableEntries.push({ scope: "model", id: String(entry.id ?? "") });
          }
        } else {
          // 磁盘上没有密文，也不需要 apiKey 字段占位（明文只属于内存）
          entry.apiKey = typeof entry.apiKey === "string" ? entry.apiKey : "";
        }
        return entry;
      });

      // 顶层也有一个显式状态：让 UI 能直接判断「这次启动 key 解不开」，
      // 而不用自己去遍历 entries（遍历很容易漏，且语义易被误用）。
      merged.keyUndecryptable = sawUndecryptable;
      merged.keyUndecryptableEntries = undecryptableEntries;
      // 磁盘上确实存过密文、但这次解不开 —— 这是「坏」而不是「没填」。
      if (sawUndecryptable) {
        log?.(`检测到 ${undecryptableEntries.length} 个 API Key 密文无法解密（Electron 安全存储失效）`);
      }

      merged.insecure =
        Boolean(raw.insecure) ||
        (!encryptAvailable && (Boolean(merged.ai.apiKey) || merged.ai.models.some((m) => m.apiKey)));
      // 版本号统一升级到当前版本：老文件读进来就算「已迁移」，
      // 否则下次 save 之前的 view() 会一直报旧版本号，排查时容易误判。
      merged.version = SETTINGS_VERSION;
      cache = merged;
      return cache;
    },

    /** 保存：写盘前把所有 apiKey 换成 encryptedApiKey（或标记明文）。 */
    async save(patch) {
      const current = await this.load();
      const merged = mergeSettings(current, patch ?? {});
      merged.version = SETTINGS_VERSION;
      let insecure = false;
      // 是否因为加密不可用而降级成明文（降级必须告知用户）
      let plaintextFallback = false;

      // ---- 旧结构：顶层 key ----
      const plain = String(merged.ai?.apiKey ?? "");
      merged.encryptedApiKey = "";
      merged.ai.apiKey = "";
      if (plain) {
        const encrypted = tryEncrypt(plain, "顶层 key");
        if (encrypted) {
          merged.encryptedApiKey = encrypted;
        } else {
          // 没有 safeStorage：只能明文存，但必须标记出来。
          merged.ai.apiKey = plain;
          insecure = true;
        }
      }

      // ---- 新结构：每条模型自己的 key ----
      const models = Array.isArray(merged.ai.models) ? merged.ai.models : [];
      merged.ai.models = models.map((m) => {
        const entry = { ...m };
        const entryPlain = String(entry.apiKey ?? "");
        const priorCipher = String(entry.encryptedApiKey ?? "");
        const archivedCipher = String(entry.encryptedApiKeyBak ?? "");
        entry.encryptedApiKey = "";
        entry.apiKey = "";

        if (entryPlain) {
          // 用户（重新）填了明文：尝试加密；加密不可用就**降级明文**并标记。
          //
          // ⚠ 这里就是缺陷 ② 的修法：解不开时（safeStorage 坏了）如果只当"没 key"，
          //   用户每次重启都要重填一次 —— 那是最糟的形态。
          //   宁可明文存（本地单用户桌面应用，风险可控），但**必须明确告知**（insecure + keyPlaintextFallback）：
          //   用户有权知道自己的 key 现在是不加密的。
          const encrypted = tryEncrypt(entryPlain, `模型 ${entry.id ?? "?"}`);
          if (encrypted) {
            entry.encryptedApiKey = encrypted;
            delete entry.encryptedApiKeyBak;
            delete entry.keyUndecryptable;
          } else {
            entry.apiKey = entryPlain;
            insecure = true;
            plaintextFallback = true;
            delete entry.keyUndecryptable;
          }
        } else if (priorCipher) {
          // 本次会话解不开、用户也没重填：**原样保留密文**，绝不能因为"读不懂"就删掉。
          entry.encryptedApiKey = priorCipher;
        } else if (archivedCipher) {
          // 读的时候归档过：保持归档，等环境恢复或用户重填
          entry.encryptedApiKeyBak = archivedCipher;
        }
        return entry;
      });

      merged.insecure = insecure;
      merged.keyPlaintextFallback = plaintextFallback;
      // 保存后 key 已重新加密/明文落盘 → 本次不再有「解不开」状态
      merged.keyUndecryptable = false;
      merged.keyUndecryptableEntries = [];
      // 原子写：先 .tmp 再 rename，避免半截 settings.json 让下次启动读不出来。
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
      await rename(tmp, file);
      // 内存缓存保留明文 key（界面下一次还要用）
      cache = {
        ...merged,
        ai: {
          ...merged.ai,
          apiKey: plain,
          models: (merged.ai.models ?? []).map((m, i) => ({ ...m, apiKey: String(models[i]?.apiKey ?? "") }))
        }
      };
      return cache;
    },

    /** 给渲染侧的视图：**不包含任何明文 key**（只告诉每项有没有配）。 */
    view() {
      const s = cache ?? defaultSettings();
      return {
        ai: {
          provider: s.ai.provider,
          baseUrl: s.ai.baseUrl,
          hasApiKey: Boolean(s.ai.apiKey || s.encryptedApiKey),
          modelFlash: s.ai.modelFlash,
          modelPro: s.ai.modelPro,
          autoRoute: s.ai.autoRoute,
          manualModel: s.ai.manualModel,
          activeModelId: s.ai.activeModelId,
          contextWindow: s.ai.contextWindow,
          maxTokens: s.ai.maxTokens,
          // 清单去掉明文 key，换成 hasApiKey 布尔
          models: (Array.isArray(s.ai.models) ? s.ai.models : []).map((m) => ({
            id: m.id,
            label: m.label,
            provider: m.provider,
            baseUrl: m.baseUrl,
            model: m.model,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            needsKey: Boolean(m.needsKey),
            source: m.source || "",
            notes: m.notes || "",
            hasApiKey: Boolean(m.apiKey || m.encryptedApiKey)
          }))
        },
        editor: s.editor,
        insecure: Boolean(s.insecure),
        cryptoAvailable: encryptAvailable,
        version: s.version
      };
    }
  };
}

/** 便捷默认路径。 */
export function settingsPathFor(userData) {
  return join(userData, "settings.json");
}
