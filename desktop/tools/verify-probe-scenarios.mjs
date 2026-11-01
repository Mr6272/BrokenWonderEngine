/**
 * `bwe:ai-probe-model` 的真实场景可复跑验证（不是「我手工跑过」）。
 *
 * 为什么要有这个脚本：探测的三态分类（明确可用 / 明确不可用 / 判不出来）是本功能
 * 最容易做错也最容易退化的部分，而单元测试用假 fetch 只能证明"分类逻辑对"，
 * 证明不了"真打网络时也能正确分类"。所以这里用真实地址跑 5 个场景。
 *
 * 5 个场景（每个都有明确的期望 reason）：
 *   ① SiliconFlow · 假 key   → unauthorized（响应体点名 Token is invalid）
 *   ② SiliconFlow · 无 key   → unauthorized（根本没配 key）
 *   ③ DeepSeek    · 假 key   → unauthorized（响应体点名 api key invalid）
 *   ④ 不存在的域名            → dns
 *   ⑤ 连不上的地址            → network（端口不通，不是 DNS）
 *
 * 这些场景**不需要真 key**（假 key 恰恰是判据：401 + 点名无效 = 地址与模型名都对）。
 * 需要外网。CI 无网时会全部失败 —— 所以它**不在 desk:test 必跑链里**，
 * 属于可选的人工/发布前验证（与 live-api.test.mjs 同一档）。
 *
 * 用法：
 *   node desktop/tools/verify-probe-scenarios.mjs
 *   node desktop/tools/verify-probe-scenarios.mjs --allow-offline   # 无网时只跳过不判死
 *
 * 退出码：0 全部符合期望；1 有场景不符；2 前置条件不满足（无 Electron / 无网且未 allow-offline）。
 */

import { probeModelEndpoint } from "../lib/ai/probe.mjs";

const ALLOW_OFFLINE = process.argv.includes("--allow-offline");

/** 场景定义：每个都写清「为什么期望这个 reason」。 */
const SCENARIOS = [
  {
    name: "SiliconFlow · 假 key",
    entry: { baseUrl: "https://api.siliconflow.cn/v1", apiKey: "sk-fake-for-scenario-test", model: "moonshotai/Kimi-K2-Thinking" },
    expect: {
      // 401 + 响应体点名 "Token is invalid" → 可确信 key 不对。
      // 关键：不是 404「模型不存在」，所以 baseUrl 与模型名两条都对。
      reason: "unauthorized",
      ok: false
    },
    why: "响应体点名凭据无效（code 30014 / Token is invalid），可确信 key 不对；非 404 说明地址与模型名都对"
  },
  {
    name: "SiliconFlow · 无 key",
    entry: { baseUrl: "https://api.siliconflow.cn/v1", apiKey: "", model: "moonshotai/Kimi-K2-Thinking" },
    expect: { reason: "unauthorized", ok: false },
    why: "没配 key 时 401 是明确的「缺配置」，不是不确定"
  },
  {
    name: "DeepSeek · 假 key",
    entry: { baseUrl: "https://api.deepseek.com", apiKey: "sk-fake-for-scenario-test", model: "deepseek-v4-flash" },
    expect: { reason: "unauthorized", ok: false },
    why: "DeepSeek 的 401 响应体含 'api key ... is invalid'，属于明确无效"
  },
  {
    name: "不存在的域名",
    entry: { baseUrl: "https://nonexistent-bwe-probe.invalid/v1", apiKey: "sk-x", model: "x" },
    expect: { reason: "dns", ok: false },
    why: "DNS 解析失败必须在 cause 链里识别（Node fetch 的 message 只有 fetch failed）"
  },
  {
    name: "连不上的地址（端口不通）",
    entry: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x", model: "x" },
    expect: { reason: "network", ok: false },
    why: "连接被拒/端口非法要归 network，与 dns 区分开（否则排查时分不清是域名还是端口）"
  }
];

const TIMEOUT_MS = 6000;
let failed = 0;
const rows = [];

console.log(`[probe-scenarios] 跑 ${SCENARIOS.length} 个真实场景（超时 ${TIMEOUT_MS}ms）\n`);

for (const s of SCENARIOS) {
  const t0 = Date.now();
  let r;
  try {
    r = await probeModelEndpoint(s.entry, { timeoutMs: TIMEOUT_MS });
  } catch (e) {
    r = { ok: false, reason: "throw", status: 0, latencyMs: Date.now() - t0, detail: e?.message || String(e) };
  }
  const ms = Date.now() - t0;
  const okMatch = r.ok === s.expect.ok;
  const reasonMatch = r.reason === s.expect.reason;
  const pass = okMatch && reasonMatch;

  rows.push({
    name: s.name,
    expect: `${s.expect.reason} / ok=${s.expect.ok}`,
    actual: `${r.reason} / ok=${JSON.stringify(r.ok)}`,
    status: r.status,
    ms,
    pass
  });

  const mark = pass ? "✓" : "✗";
  console.log(`${mark} ${s.name}`);
  console.log(`    期望 ${s.expect.reason} / ok=${s.expect.ok}  · 实际 ${r.reason} / ok=${JSON.stringify(r.ok)} · status=${r.status} · ${ms}ms`);
  console.log(`    ${s.why}`);
  if (!pass) {
    console.log(`    detail: ${r.detail}`);
    console.log(`    evidence: ${r.evidence}`);
    failed += 1;
  }
}

// ---- 汇总表（贴进报告用）----
console.log("\n场景                        期望            实际            状态码  耗时    结果");
console.log("─".repeat(92));
for (const row of rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `${pad(row.name, 28)} ${pad(row.expect, 16)} ${pad(row.actual, 16)} ${pad(row.status, 8)} ${pad(`${row.ms}ms`, 8)} ${row.pass ? "PASS" : "FAIL"}`
  );
}

// ---- 判断是否属于「全场景都连不上」——那通常是没网，而不是实现错 ----
const allUnreachable = rows.every((r) => r.status === 0);
if (failed > 0 && allUnreachable) {
  console.error(`\n[probe-scenarios] 全部场景都没拿到 HTTP 响应 —— 大概率是**本机没网**，不是探测实现的问题。`);
  if (ALLOW_OFFLINE) {
    console.log("[probe-scenarios] --allow-offline：按跳过处理，退出码 0");
    process.exit(0);
  }
  console.error("  无网环境请加 --allow-offline（CI 应走单元测试 probe.test.mjs，它用假 fetch 不依赖网络）");
  process.exit(2);
}

console.log(`\n[probe-scenarios] ${failed === 0 ? `全部 ${rows.length} 个场景符合期望` : `${failed} 个场景不符`}`);
process.exit(failed === 0 ? 0 : 1);
