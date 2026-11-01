/**
 * 单测：模型清单写操作（modelCatalog.mjs）。
 *
 * 这个模块的四条规则，每一条都对应一个真实会出错的地方：
 *   1. 重复添加同一模型 → 必须在原条目上更新，不能凭空多出一条
 *      （否则用户点两次「添加」就有两条一样的，各自一份 key，切来切去很迷惑）；
 *   2. **空串 apiKey 不清 key** → UI 的输入框没填时天然是空串，若当清空处理，
 *      等于「切一次模型就丢一次 key」；
 *   3. id 稳定可预测 → 用户凭 id 填的 key 不会因为再点一次添加就"丢"；
 *   4. 未知 provider 不静默吞掉 → 回退行为 + warning。
 *
 * 用法：node desktop/test/modelCatalog.test.mjs
 */

import assert from "node:assert/strict";
import { addModel, setActiveModel, removeModel, stableModelId, slugify } from "../lib/ai/modelCatalog.mjs";
import { normalizeModels, resolveProvider, listModels, PRESETS } from "../lib/ai/provider.mjs";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const base = () => [
  { id: "a", label: "A", provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-a", source: "manual" }
];

// ---------------------------------------------------------------------------
// id 稳定性
// ---------------------------------------------------------------------------

test("slugify：模型名里的 / 与冒号变成安全的 -", () => {
  assert.equal(slugify("moonshotai/Kimi-K2-Thinking"), "moonshotai-kimi-k2-thinking");
  assert.equal(slugify("deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(slugify("  a::b  "), "a-b");
  assert.equal(slugify(""), "");
});

test("stableModelId：同 provider + 同 model 稳定不变", () => {
  const a = stableModelId("siliconflow", "moonshotai/Kimi-K2-Thinking");
  const b = stableModelId("siliconflow", "moonshotai/Kimi-K2-Thinking");
  assert.equal(a, b);
  assert.ok(a.startsWith("manual:siliconflow:"));
  // 大小写与前缀差异都归一
  assert.equal(stableModelId("SiliconFlow", " MoonshotAI/Kimi-K2-Thinking "), b);
});

// ---------------------------------------------------------------------------
// 判重与覆盖
// ---------------------------------------------------------------------------

test("重复添加：同 provider+baseUrl+model 就地更新，只留一条", () => {
  let models = [];
  const first = addModel(models, {
    label: "Kimi", provider: "siliconflow",
    baseUrl: "https://api.siliconflow.cn/v1", model: "moonshotai/Kimi-K2-Thinking",
    apiKey: "sk-1"
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.models.length, 1);
  models = first.models;

  // 第二次：同一条（label 变了也算同一条）
  const second = addModel(models, {
    label: "Kimi（改名）", provider: "siliconflow",
    baseUrl: "https://api.siliconflow.cn/v1", model: "moonshotai/Kimi-K2-Thinking"
  });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.updated, true);
  assert.equal(second.models.length, 1, `不能变两条，实际 ${second.models.length}`);
  assert.equal(second.id, first.id, "id 必须保持稳定");
  assert.equal(second.models[0].label, "Kimi（改名）", "label 应更新");
  assert.equal(second.models[0].apiKey, "sk-1", "没传 apiKey 时必须保留原 key");
});

test("重复添加时 baseUrl 不同 = 不是同一条（允许多个反代地址）", () => {
  const models = [{
    id: "x", provider: "openai-compatible", baseUrl: "https://a.example/v1",
    model: "gpt-4o", apiKey: "sk-1", source: "manual"
  }];
  const r = addModel(models, {
    provider: "openai-compatible", baseUrl: "https://b.example/v1", model: "gpt-4o"
  });
  assert.equal(r.created, true);
  assert.equal(r.models.length, 2, "不同 baseUrl 应是两条（同一模型走不同反代）");
});

test("从 Trae 导入的条目被手填 key 时：原地更新，不新增第二条", () => {
  // 模拟 Trae 导入后的清单（id 形如 trae:...）
  const models = [{
    id: "trae:siliconflow-moonshotai-kimi-k2-thinking",
    label: "moonshotai/Kimi-K2-Thinking",
    provider: "siliconflow",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "moonshotai/Kimi-K2-Thinking",
    apiKey: "",
    needsKey: true,
    source: "trae-import"
  }];
  const r = addModel(models, {
    provider: "siliconflow", baseUrl: "https://api.siliconflow.cn/v1",
    model: "moonshotai/Kimi-K2-Thinking", apiKey: "sk-user"
  });
  assert.equal(r.created, false, "同一模型不能再新增一条");
  assert.equal(r.models.length, 1);
  assert.equal(r.id, "trae:siliconflow-moonshotai-kimi-k2-thinking", "必须保留 Trae 导入的 id");
  assert.equal(r.models[0].source, "trae-import", "来源标记应保留（便于审计）");
  assert.equal(r.models[0].apiKey, "sk-user", "用户填的 key 必须落到这条上");
});

// ---------------------------------------------------------------------------
// apiKey 三态（本轮最关键的一条）
// ---------------------------------------------------------------------------

test("setActiveModel：不传 apiKey → key 不动", () => {
  const r = setActiveModel(base(), "a");
  assert.equal(r.ok, true);
  assert.equal(r.models[0].apiKey, "sk-a");
});

test("setActiveModel：传空串 → key 也不动（UI 没填输入框时就是这样）", () => {
  const r = setActiveModel(base(), "a", { apiKey: "" });
  assert.equal(r.ok, true);
  assert.equal(r.models[0].apiKey, "sk-a", "空串绝不能清 key");
  // 只传空白的空格也一样
  const r2 = setActiveModel(base(), "a", { apiKey: "   " });
  assert.equal(r2.models[0].apiKey, "sk-a", "纯空白也不清 key");
});

test("setActiveModel：传新 key → 覆盖", () => {
  const r = setActiveModel(base(), "a", { apiKey: "sk-new" });
  assert.equal(r.models[0].apiKey, "sk-new");
});

test("setActiveModel：clearApiKey:true → 显式清除（唯一途径）", () => {
  const r = setActiveModel(base(), "a", { clearApiKey: true });
  assert.equal(r.models[0].apiKey, "", "clearApiKey 应当清掉");
});

test("addModel：空串 apiKey 不覆盖已有 key", () => {
  const models = [{
    id: "manual:deepseek:deepseek-v4-flash", provider: "deepseek", baseUrl: PRESETS.deepseek.baseUrl,
    model: "deepseek-v4-flash", apiKey: "sk-existing", source: "manual"
  }];
  const r = addModel(models, {
    provider: "deepseek", baseUrl: PRESETS.deepseek.baseUrl, model: "deepseek-v4-flash", apiKey: ""
  });
  assert.equal(r.models[0].apiKey, "sk-existing", "空串不能覆盖已有 key");
});

// ---------------------------------------------------------------------------
// 校验与降级
// ---------------------------------------------------------------------------

test("缺模型名 / 缺 provider 时明确失败并解释", () => {
  const noModel = addModel([], { provider: "deepseek", baseUrl: "https://api.deepseek.com" });
  assert.equal(noModel.ok, false);
  assert.ok(noModel.error.includes("模型名"), noModel.error);

  const noProvider = addModel([], { model: "m1" });
  assert.equal(noProvider.ok, false);
  assert.ok(noProvider.error.includes("供应商"), noProvider.error);
});

test("需要 baseUrl 但预设也没有时失败；有预设时自动补全", () => {
  // `trae-imported` 的预设里 baseUrl 是空的（它是给「从 Trae 导入」用的占位），
  // 所以手动选它又不给地址时必须明确失败 —— 否则会生成一条永远发不出请求的条目。
  const noPreset = addModel([], { provider: "trae-imported", model: "some-model", baseUrl: "" });
  assert.equal(noPreset.ok, false, "预设无 baseUrl 且用户没给时应失败");
  assert.ok(noPreset.error.includes("baseUrl"), noPreset.error);

  // deepseek 有预设 → 不失败，自动补全（这是用户少填一个字段的正常场景）
  const withPreset = addModel([], { provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "" });
  assert.equal(withPreset.ok, true, "有预设 baseUrl 时应自动补全而不是报错");
  assert.equal(withPreset.models[0].baseUrl, PRESETS.deepseek.baseUrl);

  // mock 不需要 baseUrl，不应失败
  const mock = addModel([], { provider: "mock", model: "mock-flash" });
  assert.equal(mock.ok, true);
  assert.equal(mock.models[0].baseUrl, "", "mock 不应被塞入 baseUrl");
});

test("未知 provider：接受但带 warning，不静默吞掉", () => {
  const r = addModel([], {
    provider: "my-custom-gateway", baseUrl: "https://my.example/v1", model: "some-model"
  });
  assert.equal(r.ok, true);
  assert.ok(r.warning?.includes("未知供应商"), `应给 warning，实际 ${JSON.stringify(r.warning)}`);
  // 回落到 openai-compatible 行为，但条目没丢
  assert.equal(r.models.length, 1);
  assert.equal(r.models[0].provider, "openai-compatible");
});

test("缺失 baseUrl 时用 provider 预设补全", () => {
  const r = addModel([], { provider: "deepseek", model: "deepseek-v4-flash" });
  assert.equal(r.ok, true);
  assert.equal(r.models[0].baseUrl, PRESETS.deepseek.baseUrl, "应补预设 baseUrl");
  assert.equal(r.models[0].contextWindow > 0, true, "应补默认 contextWindow");
});

// ---------------------------------------------------------------------------
// 与其他模块的联动
// ---------------------------------------------------------------------------

test("添加后立刻能按 id 解析、且填了 key 就 ready", () => {
  const add = addModel([], {
    label: "Kimi", provider: "siliconflow",
    baseUrl: "https://api.siliconflow.cn/v1", model: "moonshotai/Kimi-K2-Thinking",
    apiKey: "sk-user"
  });
  const ai = { provider: "mock", models: add.models, activeModelId: add.id };
  const resolved = resolveProvider(ai, add.id);
  assert.equal(resolved.ready, true);
  assert.equal(resolved.provider, "siliconflow");
  assert.equal(resolved.model, "moonshotai/Kimi-K2-Thinking");

  // 没填 key 时不可用，且 reason 说清楚
  const noKey = addModel([], { provider: "siliconflow", model: "moonshotai/Kimi-K2-Thinking" });
  const r2 = resolveProvider({ provider: "mock", models: noKey.models }, noKey.id);
  assert.equal(r2.ready, false);
  assert.ok(r2.reason.length > 0);
});

test("listModels 每条都带 reason（UI 唯一的提示来源）", () => {
  const add = addModel([], { provider: "siliconflow", model: "moonshotai/Kimi-K2-Thinking" });
  const listed = listModels({ provider: "mock", models: add.models }, add.id);
  assert.equal(listed.models.length, 1);
  const entry = listed.models[0];
  assert.equal(typeof entry.reason, "string");
  assert.ok(entry.reason.length > 0, "不可用条目必须给出 reason");
  assert.equal(entry.ready, false);
  assert.equal(entry.needsKey, true);
});

test("removeModel：删掉指定 id，不存在时明确失败", () => {
  const models = [{ id: "a", provider: "deepseek", model: "m1" }, { id: "b", provider: "deepseek", model: "m2" }];
  const r = removeModel(models, "a");
  assert.equal(r.ok, true);
  assert.equal(r.models.length, 1);
  assert.equal(r.models[0].id, "b");

  const miss = removeModel(r.models, "ghost");
  assert.equal(miss.ok, false);
  assert.ok(miss.error.includes("不在清单里"));
});

test("setActiveModel：不存在的 id 明确失败（不静默切到别的）", () => {
  const r = setActiveModel(base(), "ghost");
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("ghost"), r.error);
  // 清单不能被改动
  assert.equal(normalizeModels(r.models).length, 1);
});

for (const c of cases) {
  try {
    c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    console.error(`  ✗ ${c.name}\n    ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

console.log(`\nmodelCatalog.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
