/**
 * 单测：模型清单（provider.mjs 的 list 模式）+ settings 的每模型独立 key。
 *
 * 核心要证明的三件事：
 *   1. **向后兼容**：老 settings（只有 provider/modelFlash/modelPro）行为完全不变
 *      —— 这是硬约束，旧单测与用户已有配置都依赖它；
 *   2. 按 id 精确取模型：选中哪个就发哪个，绝不静默换成别的；
 *   3. 空 key 永不 ready；每个模型条目有自己的 key（不同供应商用不同 key）。
 *
 * 用法：node desktop/test/models.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRESETS, PROVIDERS, normalizeModels, resolveProvider, listModels,
  DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, SAMPLING
} from "../lib/ai/provider.mjs";
import { createSettingsStore, defaultSettings, mergeSettings } from "../lib/settings.mjs";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const dirs = [];
async function tmpDir() {
  const d = await mkdtemp(join(tmpdir(), "bwe-models-"));
  dirs.push(d);
  return d;
}

const fakeCrypto = {
  available: true,
  encryptString: (s) => `ENC:${Buffer.from(s).toString("base64")}`,
  decryptString: (s) => Buffer.from(String(s).slice(4), "base64").toString()
};

// ---------------------------------------------------------------------------
// 1. 向后兼容（最重要，不能破坏）
// ---------------------------------------------------------------------------

test("向后兼容：老两槽配置解析结果与改造前一致", () => {
  const legacy = { provider: "deepseek", baseUrl: "", apiKey: "sk-x", modelFlash: "", modelPro: "" };
  const flash = resolveProvider(legacy, "flash");
  const pro = resolveProvider(legacy, "pro");
  // 空 modelFlash/modelPro 时应回落到 PRESETS 的建议模型
  assert.equal(flash.model, PRESETS.deepseek.models.flash, `flash 应回落预设，实际 ${flash.model}`);
  assert.equal(pro.model, PRESETS.deepseek.models.pro);
  assert.equal(flash.provider, "deepseek");
  assert.equal(flash.baseUrl, PRESETS.deepseek.baseUrl);
  assert.equal(flash.ready, true, "有 key 时应 ready");
  // 旧字段 modelFlash/modelPro 必须仍然存在（面板可能还在读）
  assert.equal(typeof flash.modelFlash, "string");
  assert.equal(typeof flash.modelPro, "string");
});

test("向后兼容：mock 老配置仍然 ready 且不发网络", () => {
  const r = resolveProvider({ provider: "mock" }, "flash");
  assert.equal(r.ready, true);
  assert.equal(r.baseUrl, "", "mock 的 baseUrl 必须为空");
  assert.equal(r.model, PRESETS.mock.models.flash);
  assert.ok(r.reason.includes("mock"));
});

test("向后兼容：老配置缺 key 时 ready=false 并降级说明", () => {
  const r = resolveProvider({ provider: "deepseek", apiKey: "" }, "flash");
  assert.equal(r.ready, false);
  assert.ok(r.reason.includes("API Key"), r.reason);
});

test("向后兼容：老配置里的 modelFlash 覆盖预设", () => {
  const r = resolveProvider({ provider: "deepseek", apiKey: "k", modelFlash: "my-custom-flash" }, "flash");
  assert.equal(r.model, "my-custom-flash", "用户显式填的 modelFlash 优先于预设");
});

// ---------------------------------------------------------------------------
// 2. 按 id 精确取
// ---------------------------------------------------------------------------

function sampleModels() {
  return [
    { id: "ds", label: "DeepSeek Flash", provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-ds" },
    { id: "sf", label: "Kimi K2", provider: "siliconflow", baseUrl: "https://api.siliconflow.cn/v1", model: "moonshotai/Kimi-K2-Thinking", apiKey: "sk-sf" },
    { id: "sf-nokey", label: "Kimi 未配 key", provider: "siliconflow", model: "moonshotai/Kimi-K2-Thinking-Turbo" },
    { id: "m", label: "本地演示", provider: "mock", model: "mock-flash" }
  ];
}

test("按 id：取到哪个就是哪个（provider/baseUrl/model 全对）", () => {
  const ai = { provider: "mock", models: sampleModels() };
  const sf = resolveProvider(ai, "sf");
  assert.equal(sf.provider, "siliconflow");
  assert.equal(sf.baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(sf.model, "moonshotai/Kimi-K2-Thinking");
  assert.equal(sf.ready, true);
  assert.equal(sf.id, "sf");
  assert.equal(sf.label, "Kimi K2");

  const ds = resolveProvider(ai, "ds");
  assert.equal(ds.provider, "deepseek");
  assert.equal(ds.model, "deepseek-v4-flash");
});

test("按 id：不同供应商用各自的 key（不串用）", () => {
  const ai = { provider: "mock", apiKey: "sk-global", models: sampleModels() };
  assert.equal(resolveProvider(ai, "sf").apiKey, "sk-sf", "条目自己的 key 优先");
  // 条目没 key 时回落全局 key（老用户的兼容路径）
  assert.equal(resolveProvider(ai, "sf-nokey").apiKey, "sk-global");
  assert.equal(resolveProvider(ai, "sf-nokey").ready, true, "回落到全局 key 后可用");
});

test("按 id：entry 没 key 且无全局 key → ready=false，绝不静默可用", () => {
  const ai = { provider: "mock", models: sampleModels() };
  const r = resolveProvider(ai, "sf-nokey");
  assert.equal(r.ready, false);
  assert.ok(r.reason.length > 0);
});

test("按 id：不存在的 id 明确退回 mock 并说明原因（不静默换成别的）", () => {
  const ai = { provider: "mock", models: sampleModels() };
  const r = resolveProvider(ai, "does-not-exist");
  assert.equal(r.provider, "mock", "不存在的 id 必须退回 mock");
  // 关键：绝不能返回清单里第一个真实模型 —— 那会导致「界面显示 A、实际发给 B」
  assert.equal(r.model, PRESETS.mock.models.flash);
  assert.ok(r.reason.includes("不在模型清单里"), r.reason);
  assert.ok(r.reason.includes("does-not-exist"), r.reason);
});

test("采样参数按 provider 固定，不随模型变化（缓存前缀前提）", () => {
  const ai = { provider: "mock", models: sampleModels() };
  const a = resolveProvider(ai, "ds");
  const b = resolveProvider(ai, "sf");
  assert.deepEqual(a.sampling, SAMPLING.deepseek);
  assert.deepEqual(b.sampling, SAMPLING.siliconflow);
  // 同一个 provider 的两个不同模型，采样参数必须一致
  const c1 = resolveProvider(ai, "sf");
  const c2 = resolveProvider(ai, "sf-nokey");
  assert.deepEqual(c1.sampling, c2.sampling, "同 provider 不同模型的 sampling 必须一致");
});

// ---------------------------------------------------------------------------
// 3. listModels（界面下拉框的数据源）
// ---------------------------------------------------------------------------

test("listModels：每项带 ready/needsKey，active 指向可用项", () => {
  const ai = { provider: "mock", models: sampleModels() };
  const l = listModels(ai);
  assert.equal(l.models.length, 4);
  const byId = new Map(l.models.map((m) => [m.id, m]));
  assert.equal(byId.get("ds").ready, true);
  assert.equal(byId.get("sf-nokey").ready, false);
  assert.equal(byId.get("sf-nokey").needsKey, true);
  // active 默认取第一个 ready 的
  assert.equal(l.active, "ds", `active 应回落到第一个 ready 项，实际 ${l.active}`);
});

test("listModels：指定 active 后原样保留（即使它未就绪，也要能选中并提示）", () => {
  const ai = { provider: "mock", models: sampleModels() };
  const l = listModels(ai, "sf-nokey");
  assert.equal(l.active, "sf-nokey", "指定的 active 必须保留（用户要能看到它的未就绪原因）");
  const entry = l.models.find((m) => m.id === "sf-nokey");
  assert.equal(entry.ready, false);
});

test("listModels：active 指向已不存在的 id → 回落，不留悬空", () => {
  const ai = { provider: "mock", models: sampleModels(), activeModelId: "ghost" };
  const l = listModels(ai);
  assert.ok(l.models.some((m) => m.id === l.active), `active(${l.active}) 必须是清单里存在的项`);
});

test("normalizeModels：去重 id、丢弃无模型名的条目、补默认值", () => {
  const out = normalizeModels([
    { id: "a", provider: "deepseek", model: "m1" },
    { id: "a", provider: "deepseek", model: "m2" }, // 重复 id → 丢弃
    { id: "b", provider: "deepseek", model: "" }, // 无模型名 → 丢弃
    { id: "c", provider: "siliconflow", model: "m3" }, // 补 baseUrl 与默认窗口
    { id: "d", provider: "mock" } // mock 允许无模型名
  ]);
  const ids = out.map((x) => x.id);
  assert.deepEqual(ids.sort(), ["a", "c", "d"], `实际：${ids}`);
  const c = out.find((x) => x.id === "c");
  assert.equal(c.baseUrl, PRESETS.siliconflow.baseUrl, "缺 baseUrl 时补预设值");
  assert.equal(c.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(c.maxTokens, DEFAULT_MAX_TOKENS);
});

test("normalizeModels：非法 provider 回落 openai-compatible（不丢条目）", () => {
  const out = normalizeModels([{ id: "x", provider: "whatever", model: "m", baseUrl: "https://h/v1" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].provider, "openai-compatible");
  assert.ok(PROVIDERS.includes(out[0].provider));
});

// ---------------------------------------------------------------------------
// 4. settings：每模型独立 key 的加解密
// ---------------------------------------------------------------------------

test("settings：每个模型的 key 各自加密落盘，明文不落盘", async () => {
  const dir = await tmpDir();
  const store = createSettingsStore({ file: join(dir, "settings.json"), crypto: fakeCrypto });
  await store.load();
  await store.save({
    ai: {
      models: [
        { id: "a", label: "A", provider: "deepseek", model: "m1", apiKey: "sk-aaa" },
        { id: "b", label: "B", provider: "siliconflow", model: "m2", apiKey: "sk-bbb" },
        { id: "c", label: "C", provider: "siliconflow", model: "m3", apiKey: "" }
      ],
      activeModelId: "a"
    }
  });
  const disk = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  // 明文 key 绝不能出现在磁盘上
  const diskText = JSON.stringify(disk);
  assert.ok(!diskText.includes("sk-aaa"), "明文 key 泄漏到磁盘！");
  assert.ok(!diskText.includes("sk-bbb"), "明文 key 泄漏到磁盘！");
  // 每条有 key 的条目都应带自己的密文
  assert.equal(Boolean(disk.ai.models.find((m) => m.id === "a").encryptedApiKey), true);
  assert.equal(Boolean(disk.ai.models.find((m) => m.id === "b").encryptedApiKey), true);
  assert.equal(Boolean(disk.ai.models.find((m) => m.id === "c").encryptedApiKey), false);

  // 视图（给渲染侧）也不能带明文，只给 hasApiKey
  const view = store.view();
  assert.equal(JSON.stringify(view).includes("sk-aaa"), false, "view 泄漏明文 key");
  assert.equal(view.ai.models.find((m) => m.id === "a").hasApiKey, true);
  assert.equal(view.ai.models.find((m) => m.id === "c").hasApiKey, false);
});

test("settings：重启后密文能解回内存（不同模型的 key 不串）", async () => {
  const dir = await tmpDir();
  const file = join(dir, "settings.json");
  const s1 = createSettingsStore({ file, crypto: fakeCrypto });
  await s1.load();
  await s1.save({ ai: { models: [
    { id: "a", provider: "deepseek", model: "m1", apiKey: "sk-aaa" },
    { id: "b", provider: "siliconflow", model: "m2", apiKey: "sk-bbb" }
  ] } });
  const s2 = createSettingsStore({ file, crypto: fakeCrypto });
  await s2.load();
  const models = s2.view().ai.models;
  assert.equal(models.find((m) => m.id === "a").hasApiKey, true);
  assert.equal(models.find((m) => m.id === "b").hasApiKey, true);
  // 真正校验解回的值是否正确（用内部 load 拿明文）
  const loaded = await s2.load();
  assert.equal(loaded.ai.models.find((m) => m.id === "a").apiKey, "sk-aaa");
  assert.equal(loaded.ai.models.find((m) => m.id === "b").apiKey, "sk-bbb");
});

test("settings：无 safeStorage 时明文存但标 insecure:true", async () => {
  const dir = await tmpDir();
  const store = createSettingsStore({
    file: join(dir, "settings.json"),
    crypto: { available: false, encryptString: null, decryptString: null }
  });
  await store.load();
  await store.save({ ai: { models: [{ id: "a", provider: "deepseek", model: "m1", apiKey: "sk-plain" }] } });
  const view = store.view();
  assert.equal(view.insecure, true, "无加密能力时必须标记 insecure");
  assert.equal(view.cryptoAvailable, false);
});

test("settings：models 数组整体替换（删掉一个模型要真的删掉）", () => {
  const base = defaultSettings();
  const patched = mergeSettings(base, {
    ai: { models: [{ id: "a", provider: "deepseek", model: "m1" }] }
  });
  // 深合并若把数组也逐项合并，会造成「删不掉」；这里断言是整体替换
  assert.equal(patched.ai.models.length, 1);
  const patched2 = mergeSettings(patched, { ai: { models: [] } });
  assert.equal(patched2.ai.models.length, 0, "空数组必须能清空清单");
});

test("settings：老文件迁移后仍可用（顶层 encryptedApiKey 解回）", async () => {
  const dir = await tmpDir();
  const file = join(dir, "settings.json");
  // 手工造一份「老版本」settings：**顶层** encryptedApiKey，没有 models。
  // 注意位置：原实现的 save() 把密文写在顶层（不在 ai 里），这里必须照原样构造，
  // 否则测的是一个不存在的旧格式。
  const enc = fakeCrypto.encryptString("sk-legacy");
  await (await import("node:fs/promises")).writeFile(
    file,
    JSON.stringify({ version: 1, encryptedApiKey: enc, ai: { provider: "deepseek" }, insecure: false }),
    "utf8"
  );
  const store = createSettingsStore({ file, crypto: fakeCrypto });
  const loaded = await store.load();
  assert.equal(loaded.ai.apiKey, "sk-legacy", "老配置的 key 必须能解回");
  assert.equal(store.view().ai.hasApiKey, true);
  // 老配置升级到新版本号
  assert.equal(loaded.version, 2, `版本号应升级到 2，实际 ${loaded.version}`);
  // 老配置里没有 models 时，清单应为空数组而不是 undefined（否则界面渲染会崩）
  assert.deepEqual(store.view().ai.models, [], "老配置读进来后 models 必须是空数组");
});

test("settings：解不开的密文不崩，当作没有 key", async () => {
  const dir = await tmpDir();
  const file = join(dir, "settings.json");
  // 换机器/换用户的典型场景：密文还在，但 DPAPI 解不开
  await (await import("node:fs/promises")).writeFile(
    file,
    JSON.stringify({ version: 2, encryptedApiKey: "GARBAGE_NOT_DECRYPTABLE", ai: { provider: "deepseek" } }),
    "utf8"
  );
  const store = createSettingsStore({
    file,
    crypto: {
      available: true,
      encryptString: (s) => s,
      // 故意抛错，模拟解不开
      decryptString: () => {
        throw new Error("DPAPI decrypt failed");
      }
    }
  });
  const loaded = await store.load();
  assert.equal(loaded.ai.apiKey, "", "解不开应当当作没有 key");
  assert.equal(store.view().ai.hasApiKey, false);
});

for (const c of cases) {
  try {
    await c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    console.error(`  ✗ ${c.name}\n    ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});

console.log(`\nmodels.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
