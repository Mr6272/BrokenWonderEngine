/**
 * 可选集成测试：**真发一次请求**，确认「填了 key 之后链路真的通」。
 *
 * 为什么默认跳过：CI 常常没有外网，必跑会让流水线随机红。
 * 只有设置了环境变量 `BWE_LIVE_API_KEY` 才跑（见文件末尾的 gate）。
 *
 * 三种模式（由 BWE_LIVE_API_KEY 的形态决定）：
 *   · `sk-fake...`（假 key）→ 期望 **401**。
 *     这一步的价值不在"成功"，而在**反证**：401 说明请求真的发到了正确的 baseUrl
 *     与正确的 model（若模型名错，供应商会返 404 / "model not found" 而不是 401）。
 *   · 真 key（sk- 开头且不是 fake）→ 期望 200 + 有 delta 输出。
 *   · 另可用 `BWE_LIVE_BASE_URL` / `BWE_LIVE_MODEL` 覆盖默认值。
 *
 * 为什么值得存在：这条链路最坏的情况是「配置看起来全对，但请求根本没发到正确地址」。
 * 单元测试无法发现它（mock 不发网络），只有真发一次才证得了。
 *
 * 用法：
 *   node desktop/test/live-api.test.mjs                          # 跳过（无环境变量）
 *   BWE_LIVE_API_KEY=sk-fake node desktop/test/live-api.test.mjs # 跑 401 反证
 *   BWE_LIVE_API_KEY=sk-真key node desktop/test/live-api.test.mjs # 跑真实对话
 */

import assert from "node:assert/strict";
import { streamChat } from "../lib/ai/stream.mjs";
import { normalizeModels, resolveProvider } from "../lib/ai/provider.mjs";

const LIVE_KEY = process.env.BWE_LIVE_API_KEY ?? "";
const BASE_URL = process.env.BWE_LIVE_BASE_URL ?? "https://api.siliconflow.cn/v1";
const MODEL = process.env.BWE_LIVE_MODEL ?? "moonshotai/Kimi-K2-Thinking";

// ---------------------------------------------------------------------------
// 无 key：整组跳过（CI 默认走这条）
// ---------------------------------------------------------------------------

if (!LIVE_KEY) {
  console.log("live-api.test: 跳过（未设置 BWE_LIVE_API_KEY）");
  console.log("  说明：这是可选集成测试，需要真实网络。CI 不设该变量即跳过。");
  console.log("  跑反证：BWE_LIVE_API_KEY=sk-fake node desktop/test/live-api.test.mjs");
  process.exit(0);
}

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const isFakeKey = /fake|invalid|test-only|dummy/i.test(LIVE_KEY);

/** 用「手动添加模型」的同一套数据结构，验证 resolveProvider 能正确解析。 */
function buildSettings() {
  // 直接构造真实结构的样本（不走 parseTraeModelMap，避免把解析逻辑耦合进这个测试；
  // 解析正确性由 trae-import.test.mjs 负责）。
  const entries = normalizeModels([
    {
      id: "manual:siliconflow:moonshotai-kimi-k2-thinking",
      label: "moonshotai/Kimi-K2-Thinking",
      provider: "siliconflow",
      baseUrl: BASE_URL,
      model: MODEL,
      apiKey: LIVE_KEY,
      needsKey: true,
      source: "manual"
    }
  ]);
  return { provider: "mock", models: entries, activeModelId: entries[0].id };
}

test("resolveProvider 把填了 key 的条目解析成可请求的参数", () => {
  const ai = buildSettings();
  const resolved = resolveProvider(ai, ai.activeModelId);
  assert.equal(resolved.ready, true, "填了 key 应 ready");
  assert.equal(resolved.baseUrl.replace(/\/+$/, ""), BASE_URL.replace(/\/+$/, ""));
  assert.equal(resolved.model, "moonshotai/Kimi-K2-Thinking");
  assert.equal(resolved.apiKey, LIVE_KEY);
});

test(isFakeKey ? "假 key：期望 401（证明请求发到了正确端点与正确模型）" : "真 key：期望 200 且有输出", async () => {
  const ai = buildSettings();
  const resolved = resolveProvider(ai, ai.activeModelId);
  const events = [];
  const result = await streamChat({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.model,
    messages: [{ role: "user", content: "ping，只回一个字" }],
    maxTokens: 16,
    temperature: resolved.sampling.temperature,
    topP: resolved.sampling.topP,
    signal: AbortSignal.timeout(20000),
    onEvent: (ev) => events.push(ev)
  });

  if (isFakeKey) {
    // 401 是「key 不对」；404 / model not found 才是「地址或模型名不对」。
    // 所以断言 401 同时证明了 baseUrl 与 model 两条都对 —— 这是本测试的核心价值。
    assert.equal(result.status, 401, `假 key 应得到 401（地址/模型名正确），实际 ${result.status}：${result.error}`);
    assert.ok(
      result.error.includes("401") || result.error.includes("invalid") || result.error.includes("Token"),
      `错误信息应指向 key 问题，实际：${result.error}`
    );
    assert.ok(
      !/model.*not.*(exist|found)|404/i.test(result.error || ""),
      `401 而非"模型不存在"，才是地址与模型名正确的证据；实际：${result.error}`
    );
  } else {
    assert.equal(result.status, 200, `真 key 应 200，实际 ${result.status}：${result.error}`);
    assert.ok(result.text.length > 0, "应拿到模型输出");
    assert.ok(result.usage.outputTokens > 0, `应记到输出 token，实际 ${JSON.stringify(result.usage)}`);
    assert.ok(events.some((e) => e.type === "delta"), "应有流式 delta 事件");
  }
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

console.log(
  `\nlive-api.test: ${pass}/${cases.length} 通过`
  + `（模式：${isFakeKey ? "假 key 401 反证" : "真 key 实跑"} · baseUrl=${BASE_URL} · model=${MODEL}）`
);
if (pass !== cases.length) process.exit(1);
