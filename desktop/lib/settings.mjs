/**
 * 桌面壳 · 设置读写（含 API Key 的 DPAPI 加密落盘）。
 *
 * 契约 §3 / §4.4：settings.json 里 apiKey 用 `encryptedApiKey` 存，
 * 明文只在内存里出现；Windows 上走 Electron safeStorage（底层 DPAPI，按用户加密）。
 *
 * 取不到 safeStorage 时**不报错、不丢功能**：退回明文并标记 `insecure: true`，
 * 让界面能明确提示「这台机器上 key 是明文存的」。静默降级比报错更危险，
 * 所以标记是必填字段，不是可选项。
 *
 * 与 Electron 解耦：加解密函数由调用方注入（主进程传 safeStorage，单测传假实现）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SETTINGS_VERSION = 1;

/** 默认设置（契约 §3 的 Settings 结构，字段一个不少）。 */
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
      contextWindow: 128000,
      maxTokens: 4096
    },
    editor: { theme: "cream", uiScale: 1, autoSave: true },
    // 记录 key 是否明文存的（见文件头注释）
    insecure: false
  };
}

/** 深合并：settings.json 是用户手改过的，缺字段要补默认值，多字段要保留。 */
export function mergeSettings(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object") {
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
 * @param {string} opts.file                                   settings.json 绝对路径
 * @param {{available:boolean, encryptString?:(s:string)=>string, decryptString?:(s:string)=>string}} opts.crypto
 */
export function createSettingsStore({ file, crypto }) {
  const encryptAvailable = Boolean(crypto?.available && crypto.encryptString && crypto.decryptString);
  let cache = null;

  return {
    get file() {
      return file;
    },

    async load() {
      if (cache) return cache;
      const raw = (await readJson(file, null)) ?? {};
      const defaults = defaultSettings();
      const merged = mergeSettings(defaults, raw);
      // 解密：优先 encryptedApiKey；解不了就用内存里遗留的明文（首次迁移场景）。
      const enc = raw.encryptedApiKey;
      if (typeof enc === "string" && enc && encryptAvailable) {
        try {
          merged.ai.apiKey = crypto.decryptString(enc);
        } catch {
          // DPAPI 密文换机器/换用户就解不开；这时当作没有 key，而不是崩掉。
          merged.ai.apiKey = "";
          merged.insecure = true;
        }
      }
      merged.insecure = Boolean(raw.insecure) || (!encryptAvailable && Boolean(merged.ai.apiKey));
      cache = merged;
      return cache;
    },

    /** 保存：写盘前把 apiKey 换成 encryptedApiKey（或标记明文）。 */
    async save(patch) {
      const current = await this.load();
      const merged = mergeSettings(current, patch ?? {});
      merged.version = SETTINGS_VERSION;
      const plain = String(merged.ai?.apiKey ?? "");
      merged.encryptedApiKey = "";
      merged.ai.apiKey = "";
      let insecure = false;
      if (plain) {
        if (encryptAvailable) {
          merged.encryptedApiKey = crypto.encryptString(plain);
        } else {
          // 没有 safeStorage：只能明文存，但必须标记出来。
          merged.ai.apiKey = plain;
          insecure = true;
        }
      } else {
        // 清空 key：连旧密文一起删掉，否则「清空」下次启动又冒出来。
        merged.encryptedApiKey = "";
      }
      merged.insecure = insecure;
      // 原子写：先 .tmp 再 rename，避免半截 settings.json 让下次启动读不出来。
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
      await rename(tmp, file);
      cache = { ...merged, ai: { ...merged.ai, apiKey: plain } };
      return cache;
    },

    /** 给渲染侧的视图：不包含明文 key（只告诉有没有配）。 */
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
          contextWindow: s.ai.contextWindow,
          maxTokens: s.ai.maxTokens
        },
        editor: s.editor,
        insecure: Boolean(s.insecure),
        version: s.version
      };
    }
  };
}

/** 便捷默认路径。 */
export function settingsPathFor(userData) {
  return join(userData, "settings.json");
}
