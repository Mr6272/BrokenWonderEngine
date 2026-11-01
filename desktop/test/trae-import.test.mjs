/**
 * 单测：Trae 配置导入器（trae-import.mjs）。
 *
 * 这个模块的价值全在**边界处理**上，所以测试也针对边界：
 *   1. 解析：46 条 → 2 条唯一自定义模型（多分组重复要去重）；
 *   2. 模型名：必须取 `name` 里 `//` 之后的部分，**不能**用 custom_model_id
 *      （那是 Trae 内部数字 ID，发给供应商会报「模型不存在」—— 我实际踩过）；
 *   3. 安全：导入条目 apiKey 恒为空、needsKey: true、source: "trae-import"；
 *   4. 只读：绝不解密 Trae 的 ak，绝不写 Trae 的库；
 *   5. 降级：没有 Trae / 没有 sqlite / 结构不对 → 可读原因，不崩。
 *
 * 用 localStorage 样本夹具（真实 Trae 结构），**不依赖本机装没装 Trae**。
 *
 * 用法：node desktop/test/trae-import.test.mjs
 */

import assert from "node:assert/strict";
import { parseTraeModelMap, toModelEntries, findTraeDb, probeReachable, TRAE_MODEL_KEY } from "../lib/ai/trae-import.mjs";
import { resolveProvider, normalizeModels } from "../lib/ai/provider.mjs";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/**
 * 真实 Trae 结构的精简样本（本机抓的原始数据摘出来的）。
 * 刻意保留：多分组重复、自定义 provider 有 base_url、内置模型没有 base_url、
 * context_window_size 两种形状。
 */
const SAMPLE = JSON.stringify({
  solo_coder: [
    { name: "Doubao-Seed-2.0-Code", display_name: "Doubao-Seed-2.0-Code", model_type: "reasoning_model", context_window_size: { max: [184000], default: 184000 } },
    {
      name: "siliconflow//moonshotai/Kimi-K2-Thinking",
      display_name: "moonshotai/Kimi-K2-Thinking",
      base_url: "https://api.siliconflow.cn/v1",
      provider: "siliconflow",
      custom_model_id: "7443714",
      model_type: "chat_model",
      context_window_size: { max: null, default: null }
    },
    {
      name: "siliconflow//moonshotai/Kimi-K2-Thinking-Turbo",
      display_name: "moonshotai/Kimi-K2-Thinking-Turbo",
      base_url: "https://api.siliconflow.cn/v1",
      provider: "siliconflow",
      custom_model_id: "6307074",
      model_type: "chat_model",
      context_window_size: { max: null, default: null }
    }
  ],
  // 同一个模型在不同分组里重复出现 —— 去重的目标
  solo_builder: [
    {
      name: "siliconflow//moonshotai/Kimi-K2-Thinking",
      display_name: "moonshotai/Kimi-K2-Thinking",
      base_url: "https://api.siliconflow.cn/v1",
      provider: "siliconflow",
      custom_model_id: "7443714"
    }
  ],
  builder: [
    {
      name: "siliconflow//moonshotai/Kimi-K2-Thinking",
      base_url: "https://api.siliconflow.cn/v1",
      provider: "siliconflow",
      custom_model_id: "7443714"
    },
    { name: "Gpt-4o", model_type: "chat_model", context_window_size: 128000 }
  ],
  code_reviewer: []
});

test("解析：多个分组的重复模型去重成唯一清单", () => {
  const r = parseTraeModelMap(SAMPLE);
  assert.equal(r.totalEntries, 6, `样本共 6 条原始条目，实际 ${r.totalEntries}`);
  assert.equal(r.uniqueModels, 2, `唯一自定义模型应为 2 条，实际 ${r.uniqueModels}`);
  assert.equal(r.providers.length, 1, "两个模型同一个 base_url，应归成 1 个供应商");
  assert.equal(r.providers[0].baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(r.providers[0].provider, "siliconflow");
  assert.equal(r.providers[0].models.length, 2);
});

test("模型名取 `//` 之后的部分，不是 custom_model_id", () => {
  const r = parseTraeModelMap(SAMPLE);
  const names = r.providers[0].models.map((m) => m.model);
  assert.deepEqual(names.sort(), ["moonshotai/Kimi-K2-Thinking", "moonshotai/Kimi-K2-Thinking-Turbo"]);
  // 关键回归：数字 ID 绝不能出现在 model 字段里
  for (const m of r.providers[0].models) {
    assert.ok(!/^\d+$/.test(m.model), `model 不能是 Trae 的数字 ID，实际 ${m.model}`);
  }
  // 数字 ID 保留在 traeModelId 里（排查用），但不参与请求
  assert.equal(r.providers[0].models[0].traeModelId.length > 0, true);
});

test("没有 base_url 的内置模型被忽略", () => {
  const r = parseTraeModelMap(SAMPLE);
  const all = r.providers.flatMap((p) => p.models.map((m) => m.model));
  assert.ok(!all.includes("Doubao-Seed-2.0-Code"), "内置模型（无 base_url）不应出现");
  assert.ok(!all.includes("Gpt-4o"), "内置模型（无 base_url）不应出现");
});

test("安全：导入条目不携带 key、标记 needsKey 与来源", () => {
  const r = parseTraeModelMap(SAMPLE);
  for (const p of r.providers) {
    assert.equal(p.hasKey, false, "供应商级别必须标记 hasKey:false");
    assert.equal(p.needsKey, true);
    assert.equal(p.reachable, null, "网络探测前 reachable 应为 null（未探测不等于不可达）");
    assert.ok(p.note.includes("无法导出"), p.note);
  }

  const entries = toModelEntries(r.providers);
  assert.equal(entries.length, 2);
  for (const e of entries) {
    assert.equal(e.apiKey, "", `导入条目绝不能带 key，实际 ${JSON.stringify(e.apiKey)}`);
    assert.equal(e.needsKey, true);
    assert.equal(e.source, "trae-import", "必须打来源标记，便于审计");
    assert.ok(e.id.startsWith("trae:"), `id 应有 trae: 前缀，实际 ${e.id}`);
  }
});

test("导入条目的 id 稳定（重复导入不会丢用户填的 key）", () => {
  const r1 = toModelEntries(parseTraeModelMap(SAMPLE).providers);
  const r2 = toModelEntries(parseTraeModelMap(SAMPLE).providers);
  assert.deepEqual(r1.map((x) => x.id), r2.map((x) => x.id), "同一份样本两次导入的 id 必须一致");
});

test("空 key 不被当成可用（ready=false + 人话原因）", () => {
  const entries = toModelEntries(parseTraeModelMap(SAMPLE).providers);
  const models = normalizeModels(entries);
  const resolved = resolveProvider({ provider: "mock", models }, models[0].id);
  assert.equal(resolved.ready, false, "没有 key 的导入模型绝不能 ready");
  assert.ok(resolved.reason.includes("Trae"), `原因应说明是 Trae 导入的 key 问题，实际：${resolved.reason}`);
  assert.ok(resolved.reason.includes("手动"), `原因应给出可操作提示，实际：${resolved.reason}`);
});

test("用户填了 key 之后同一个条目变成可用", () => {
  const entries = toModelEntries(parseTraeModelMap(SAMPLE).providers);
  entries[0].apiKey = "sk-user-filled";
  const resolved = resolveProvider({ provider: "mock", models: entries }, entries[0].id);
  assert.equal(resolved.ready, true, "填了 key 就应该 ready");
  assert.equal(resolved.provider, "siliconflow");
  assert.equal(resolved.baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(resolved.model, "moonshotai/Kimi-K2-Thinking");
});

test("context_window_size 两种形状都兼容", () => {
  // 形状 A：{ max:[n], default:n }
  const a = parseTraeModelMap(JSON.stringify({
    bucket: [{ name: "p//m1", base_url: "https://x/v1", provider: "p", custom_model_id: "1", context_window_size: { max: [64000], default: 64000 } }]
  }));
  assert.equal(a.providers[0].models[0].contextWindow, 64000);
  // 形状 B：直接数字
  const b = parseTraeModelMap(JSON.stringify({
    bucket: [{ name: "p//m2", base_url: "https://x/v1", provider: "p", custom_model_id: "2", context_window_size: 32000 }]
  }));
  assert.equal(b.providers[0].models[0].contextWindow, 32000);
  // 形状 C：null（Trae 不知道）→ 0，交给上层用默认值
  const c = parseTraeModelMap(JSON.stringify({
    bucket: [{ name: "p//m3", base_url: "https://x/v1", provider: "p", custom_model_id: "3", context_window_size: { max: null, default: null } }]
  }));
  assert.equal(c.providers[0].models[0].contextWindow, 0);
});

test("坏输入降级：非法 JSON / 非对象 / 全内置模型", () => {
  const bad = parseTraeModelMap("{not json");
  assert.deepEqual(bad.providers, []);
  assert.ok(bad.warnings[0].includes("不是合法 JSON"), bad.warnings[0]);

  const notObj = parseTraeModelMap(JSON.stringify("hello"));
  assert.deepEqual(notObj.providers, []);
  assert.ok(notObj.warnings.length > 0);

  // 全是内置模型（没有 base_url）：合法但无可导入，必须给出人话原因
  const builtinOnly = parseTraeModelMap(JSON.stringify({
    solo_coder: [{ name: "Doubao", display_name: "Doubao" }]
  }));
  assert.deepEqual(builtinOnly.providers, []);
  assert.ok(
    builtinOnly.warnings.some((w) => w.includes("没有可导入的自定义供应商")),
    `应提示没有可导入的自定义供应商，实际：${JSON.stringify(builtinOnly.warnings)}`
  );
});

test("findTraeDb 在找不到时返回 tried 列表（便于排查）", () => {
  const r = findTraeDb();
  assert.ok(Array.isArray(r.tried) && r.tried.length > 0, "必须给出尝试过的路径");
  // 本机装了 Trae 的情况下 path 应该非空；没装则 null —— 两种都算正常。
  assert.ok(r.path === null || r.path.endsWith("state.vscdb"));
});

test("probeReachable：连不上时 reachable=false 但不抛错", async () => {
  const providers = [
    { provider: "p", baseUrl: "http://127.0.0.1:1", models: [] },
    { provider: "q", baseUrl: "http://nonexistent-host-xyz-bwe.invalid", models: [] }
  ];
  const out = await probeReachable(providers, { timeoutMs: 1500 });
  assert.equal(out.length, 2);
  for (const p of out) {
    assert.equal(p.reachable, false, `${p.baseUrl} 应该判不可达`);
    assert.ok(typeof p.reachableDetail === "string" && p.reachableDetail.length > 0);
  }
});

test("常量：TRAE_MODEL_KEY 与实测一致", () => {
  // 这个键名是实测得来（本机 Trae CN 的库），写死在这里防止手误改错。
  assert.equal(TRAE_MODEL_KEY, "4337993333357580_AI.agent.model.model_list_map");
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

console.log(`\ntrae-import.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
