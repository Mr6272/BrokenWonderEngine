/**
 * 单测：TokenUsage 记账（usage.mjs）+ 工具结果剪枝（prune.mjs）。
 *
 * 契约 §4.2：三者互不重叠（disjoint）。这条最容易写错的地方是 DeepSeek 的
 * usage 把缓存命中**折进 prompt_tokens** —— 不减回来就会：
 *   ① 把命中的 token 按未命中价重复计费；
 *   ② 算出 >100% 的命中率。
 *
 * 所以这里用真实的 DeepSeek usage 形状做断言：
 *   { prompt_tokens: 41591, prompt_cache_hit_tokens: 41472, prompt_cache_miss_tokens: 119 }
 * 期望：inputTokens=119, cacheReadTokens=41472, 命中率 ≈ 99.7%。
 *
 * 用法：node desktop/test/usage.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fromProviderUsage, cacheHitRate, billedInputTokens, estimateSavings, mergeUsage, describeUsage, emptyUsage, PRICES
} from "../lib/ai/usage.mjs";
import { pruneToolResult, createToolCache, sha1, PRUNE_LIMIT, describeToolResult } from "../lib/ai/prune.mjs";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("DeepSeek：命中折进 prompt_tokens，必须减回来", () => {
  const usage = fromProviderUsage({
    prompt_tokens: 41591,
    prompt_cache_hit_tokens: 41472,
    prompt_cache_miss_tokens: 119,
    completion_tokens: 320
  });
  assert.equal(usage.inputTokens, 119, "未命中输入应为 119（不是 41591）");
  assert.equal(usage.cacheReadTokens, 41472);
  assert.equal(usage.outputTokens, 320);
  assert.equal(billedInputTokens(usage), 119 + 41472, "计费输入 = 三者之和");
});

test("DeepSeek：只给 prompt_tokens + hit 时也能算对", () => {
  const usage = fromProviderUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900, completion_tokens: 50 });
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.cacheReadTokens, 900);
  assert.equal(billedInputTokens(usage), 1000, "总输入仍是 1000（不重复计费）");
});

test("命中率 ≈ 99.7%（不是 >100%）", () => {
  const usage = fromProviderUsage({
    prompt_tokens: 41591, prompt_cache_hit_tokens: 41472, prompt_cache_miss_tokens: 119, completion_tokens: 320
  });
  const rate = cacheHitRate(usage);
  assert.ok(rate > 0.99 && rate <= 1, `命中率应在 99%~100% 之间，实际 ${rate}`);
  assert.ok(!Number.isNaN(rate));
});

test("零输入不产生 NaN", () => {
  assert.equal(cacheHitRate(emptyUsage()), 0);
  assert.equal(cacheHitRate(undefined), 0);
  assert.equal(billedInputTokens(undefined), 0);
});

test("OpenAI 风格：prompt_tokens_details.cached_tokens", () => {
  const usage = fromProviderUsage({
    prompt_tokens: 2000,
    prompt_tokens_details: { cached_tokens: 1500 },
    completion_tokens: 200
  });
  assert.equal(usage.cacheReadTokens, 1500);
  assert.equal(usage.inputTokens, 500);
});

test("Anthropic 风格：cache_read / cache_creation 分开", () => {
  const usage = fromProviderUsage({
    input_tokens: 40,
    output_tokens: 120,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 60
  });
  assert.equal(usage.inputTokens, 40);
  assert.equal(usage.cacheReadTokens, 900);
  assert.equal(usage.cacheWriteTokens, 60, "cacheWrite 必须单独记，不能并进 input");
  assert.equal(usage.outputTokens, 120);
  assert.equal(billedInputTokens(usage), 1000);
});

test("完全无缓存：命中率 0，计费输入=输入", () => {
  const usage = fromProviderUsage({ prompt_tokens: 800, completion_tokens: 100 });
  assert.equal(usage.inputTokens, 800);
  assert.equal(usage.cacheReadTokens, 0);
  assert.equal(cacheHitRate(usage), 0);
});

test("省钱估算：命中越多省越多（且不为负）", () => {
  const noCache = fromProviderUsage({ prompt_tokens: 40000, completion_tokens: 500 });
  const fullCache = fromProviderUsage({
    prompt_tokens: 40000, prompt_cache_hit_tokens: 40000, prompt_cache_miss_tokens: 0, completion_tokens: 500
  });
  const a = estimateSavings(noCache, "deepseek");
  const b = estimateSavings(fullCache, "deepseek");
  assert.equal(a.savedUsdApprox, 0, "完全没命中缓存时不该有「省了钱」");
  assert.ok(b.savedUsdApprox > 0, "全部命中时必须算出正的省额");
  assert.ok(b.cacheHitRate > a.cacheHitRate);
  assert.ok(b.savedUsdApprox < b.baselineUsdApprox, "省额不能超过基线成本");
});

test("mergeUsage 累加且保留 totalInput", () => {
  const a = fromProviderUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 80, completion_tokens: 10 });
  const b = fromProviderUsage({ prompt_tokens: 200, prompt_cache_hit_tokens: 50, completion_tokens: 20 });
  const m = mergeUsage(a, b);
  assert.equal(m.inputTokens, a.inputTokens + b.inputTokens);
  assert.equal(m.cacheReadTokens, 80 + 50);
  assert.equal(m.outputTokens, 30);
  assert.equal(m.totalInput, m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens);
});

test("describeUsage 给人看的字符串带命中率与省额", () => {
  const usage = fromProviderUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900, completion_tokens: 100 });
  const text = describeUsage(usage, "deepseek");
  assert.ok(text.includes("命中"), text);
  assert.ok(text.includes("%"), text);
  assert.ok(text.includes("$"), text);
  assert.ok(text.includes("900"), text);
});

test("unknown provider 走 DeepSeek 兜底价（不抛错）", () => {
  const usage = fromProviderUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900 });
  const r = estimateSavings(usage, "some-unknown");
  assert.ok(r.savedUsdApprox >= 0);
  assert.ok(Object.keys(PRICES).length >= 2);
});

// ---------------- 剪枝 + toolCache ----------------

test("≤600 字符不剪枝，原样返回", () => {
  const text = "短内容".repeat(50);
  const p = pruneToolResult(text);
  assert.equal(p.pruned, false, `${text.length} 字符不该剪`);
  assert.equal(p.text, text);
  assert.ok(p.fullSha1.length === 40, "sha1 长度应为 40");
});

test(">600 字符剪成「头部 + 统计」，且带 toolCache 键", () => {
  const text = Array.from({ length: 200 }, (_, i) => `第 ${i} 行：这是一段会撑爆上下文的长文本`).join("\n");
  assert.ok(text.length > PRUNE_LIMIT);
  const p = pruneToolResult(text);
  assert.equal(p.pruned, true);
  assert.ok(p.text.length < text.length / 2, `剪枝后应显著变短：${p.text.length} vs ${text.length}`);
  assert.ok(p.text.includes("已剪枝"), p.text);
  assert.ok(p.text.includes(p.fullSha1), "剪枝文本里必须带 sha1，方便回头取原文");
  assert.ok(p.text.includes(String(text.length)), "必须写原文长度");
  assert.ok(p.text.startsWith(text.slice(0, 40)), "必须保留头部（模型主要看开头）");
});

test("剪枝不切断半行", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line-${i}-${"x".repeat(60)}`).join("\n");
  const p = pruneToolResult(text);
  const headPart = p.text.split("…（已剪枝")[0];
  // 头部最后一行要么完整，要么干脆没有这一行；不能出现「半个 line-NN」。
  const lastLine = headPart.split("\n").pop();
  assert.ok(lastLine.length > 0, "头部不应为空");
  assert.ok(/x{10,}$|line-\d+/.test(lastLine) || lastLine === "", `不应切断半行：${lastLine.slice(-20)}`);
});

test("meta 统计写进剪枝摘要", () => {
  const text = "x".repeat(1000);
  const p = pruneToolResult(text, { meta: { matches: 3, tool: "SearchApi" } });
  assert.ok(p.text.includes("matches=3"), p.text.slice(-200));
  assert.ok(p.text.includes("tool=SearchApi"));
});

test("toolCache：同一内容只落一份，可按 sha1 取回", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bwe-toolcache-"));
  try {
    const cache = createToolCache(dir);
    const text = "工具原始结果".repeat(200);
    const sha1a = await cache.put(text, { tool: "ReadFile" });
    const sha1b = await cache.put(text);
    assert.equal(sha1a, sha1b, "同一内容两次 put 必须返回同一 sha1（内容寻址）");
    const got = await cache.get(sha1a);
    assert.equal(got, text, "取回必须与原文完全一致");
    const file = await readFile(join(dir, `${sha1a}.txt`), "utf8");
    assert.equal(file, text);
    // 只应有一份 .txt（第二次 put 复用已有文件）
    assert.equal(sha1(text), sha1a, "sha1 必须与独立计算一致");
    assert.equal(await cache.has(sha1a), true);
    assert.equal(await cache.get("ffffffff"), null, "不存在时返回 null 而不是抛错");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("describeToolResult：一句话说清「读了多少、剪没剪」", () => {
  const text = "x".repeat(5000);
  const p = pruneToolResult(text);
  const line = describeToolResult("ReadFile", "world.js", p, false);
  assert.ok(line.includes("ReadFile"));
  assert.ok(line.includes("world.js"));
  assert.ok(line.includes("已剪枝"), line);
  assert.ok(line.includes("行"), line);
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
console.log(`\nusage.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
