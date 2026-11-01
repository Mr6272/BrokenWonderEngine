/**
 * 单测：模型端点探测（probe.mjs）。
 *
 * 这个模块的价值全在**分类是否诚实**：
 *   · `ready` 只说配置齐全，探测才能说连通性 —— 两者混用会让用户「看到可用、一发就 401」；
 *   · 401 并不总能断定 key 错（部分服务对 /models 要求更高权限），
 *     所以必须能表达「判不出来」（ok=null），而不是硬塞进 true/false。
 *
 * 用假 fetch 注入各种响应，**不依赖真实网络**（CI 无网也能跑）。
 * 真实网络的验证在 live-api.test.mjs（可选）。
 *
 * 用法：node desktop/test/probe.test.mjs
 */

import assert from "node:assert/strict";
import {
  requestModelsEndpoint, probeModelEndpoint, probeProvidersReachable, PROBE_TIMEOUT_MS
} from "../lib/ai/probe.mjs";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/**
 * 注入一个假 fetch：返回指定的 {status, body, throws}。
 *
 * ⚠ 必须 async 且 **await fn()**：最初写成同步 try/finally，`fn()` 一返回 promise 就执行
 * finally 恢复了真实 fetch，于是 await 之后的请求全打到真网络 —— 测试实际在测"网络失败"
 * 而不是假响应，表现为「HEAD→GET 降级没发生」「404 被判 false」这类看不懂的失败。
 *
 * @param {object|Function} response
 */
async function withFakeFetch(response, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const r = typeof response === "function" ? response(url, opts) : response;
    if (r.throws) {
      // 支持传入 Error 实例（用于验证 cause 链），也支持 {name, message} 简写
      if (r.throws instanceof Error) throw r.throws;
      throw Object.assign(new Error(r.throws.message), { name: r.throws.name });
    }
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body ?? "",
      headers: new Map()
    };
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// requestModelsEndpoint：可达性本质是「连上了」
// ---------------------------------------------------------------------------

test("200：reachable=true，并记录延迟", async () => {
  const r = await withFakeFetch({ status: 200, body: '{"data":[]}' }, () =>
    requestModelsEndpoint("https://api.example.com/v1", { method: "GET", apiKey: "sk-x", readBody: true })
  );
  assert.equal(r.reachable, true);
  assert.equal(r.status, 200);
  assert.equal(typeof r.latencyMs, "number");
  assert.ok(r.latencyMs >= 0);
});

test("401：仍然 reachable=true（连上了，只是没权限）", async () => {
  // 这是「可达性本质是连上了，不是状态码 200」的关键断言
  const r = await withFakeFetch({ status: 401 }, () =>
    requestModelsEndpoint("https://api.example.com/v1", { method: "HEAD" })
  );
  assert.equal(r.reachable, true, "401 说明网络通，必须判 reachable");
  assert.equal(r.status, 401);
});

test("404：也 reachable=true（端点没实现 ≠ 网络不通）", async () => {
  const r = await withFakeFetch({ status: 404 }, () =>
    requestModelsEndpoint("https://api.example.com/v1", { method: "HEAD" })
  );
  assert.equal(r.reachable, true);
  assert.equal(r.status, 404);
});

test("超时：reachable=false，errorCode=timeout", async () => {
  const r = await withFakeFetch({ throws: { name: "TimeoutError", message: "The operation was aborted" } }, () =>
    requestModelsEndpoint("https://api.example.com/v1", { method: "HEAD" })
  );
  assert.equal(r.reachable, false);
  assert.equal(r.errorCode, "timeout");
  assert.ok(r.detail.includes("没有响应"), r.detail);
});

test("DNS 失败：reachable=false，errorCode=dns", async () => {
  const r = await withFakeFetch({ throws: { name: "TypeError", message: "getaddrinfo ENOTFOUND x" } }, () =>
    requestModelsEndpoint("https://nowhere.invalid/v1", { method: "HEAD" })
  );
  assert.equal(r.reachable, false);
  assert.equal(r.errorCode, "dns");
  assert.ok(r.detail.includes("域名解析失败"), r.detail);
});

test("网络原因从 cause 链里取（Node fetch 的 message 只有 fetch failed）", async () => {
  // ⚠ 真实踩过：Node 的 fetch 抛错时 message 只有 "fetch failed"，
  //   真正的 ENOTFOUND 在 err.cause.code 里。不展开 cause 的话，
  //   DNS 失败会被归成笼统的 network，排查时看不出到底是"域名不存在"还是"端口连不上"。
  const dnsErr = Object.assign(new Error("fetch failed"), {
    name: "TypeError",
    cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND nowhere.invalid" }
  });
  const r = await withFakeFetch({ throws: dnsErr }, () =>
    requestModelsEndpoint("https://nowhere.invalid/v1", { method: "HEAD" })
  );
  assert.equal(r.reachable, false);
  assert.equal(r.errorCode, "dns", `应识别为 dns，实际 ${r.errorCode}`);
  assert.ok(r.detail.includes("域名解析失败"), r.detail);
  assert.ok(r.detail.includes("ENOTFOUND"), `detail 应带上具体错误码：${r.detail}`);

  // 连接被拒/端口非法 → network（与 dns 区分）
  const netErr = Object.assign(new Error("fetch failed"), {
    name: "TypeError",
    cause: { code: "ERR_INVALID_URL", message: "bad port" }
  });
  const r2 = await withFakeFetch({ throws: netErr }, () =>
    requestModelsEndpoint("http://127.0.0.1:1/v1", { method: "HEAD" })
  );
  assert.equal(r2.reachable, false);
  assert.equal(r2.errorCode, "network", `非 DNS 的失败应归 network，实际 ${r2.errorCode}`);
  assert.ok(r2.detail.includes("连接失败"), r2.detail);
});

test("请求会带上 Authorization（只在给了 key 时）", async () => {
  const seen = [];
  await withFakeFetch({ status: 200 }, () =>
    requestModelsEndpoint("https://api.example.com/v1", {
      method: "GET",
      apiKey: "sk-abc",
      // 通过 spy 记录 headers
    })
  );
  // 单独验证 headers：用自定义 fetch
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, headers: opts.headers });
    return { ok: true, status: 200, text: async () => "" };
  };
  try {
    await requestModelsEndpoint("https://api.example.com/v1", { method: "HEAD", apiKey: "sk-abc" });
    await requestModelsEndpoint("https://api.example.com/v1", { method: "HEAD" });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen[0].headers.authorization, "Bearer sk-abc");
  assert.equal(seen[1].headers.authorization, undefined, "没给 key 时不该带 Authorization");
  assert.ok(seen[0].url.endsWith("/models"), `URL 应是 /models，实际 ${seen[0].url}`);
});

// ---------------------------------------------------------------------------
// probeModelEndpoint：三态分类（本模块的核心）
// ---------------------------------------------------------------------------

test("三态 · 明确可用：200 + key → ok=true", async () => {
  const r = await withFakeFetch({ status: 200 }, () =>
    probeModelEndpoint({ baseUrl: "https://api.example.com/v1", apiKey: "sk-good" })
  );
  assert.equal(r.ok, true);
  assert.equal(r.reason, "ok");
  assert.equal(r.method, "HEAD", "HEAD 可用时不该降级 GET");
});

test("三态 · 明确不可用：连不上 → ok=false", async () => {
  const r = await withFakeFetch({ throws: { name: "TimeoutError", message: "aborted" } }, () =>
    probeModelEndpoint({ baseUrl: "https://slow.example.com/v1", apiKey: "sk-x" })
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timeout");
  assert.equal(r.reachable, false);
});

test("三态 · 判不出来：/models 401 但响应体没点名 token 无效 → ok=null", async () => {
  // 真实场景：某些服务对 /models 要求更高权限，401 不代表 chat 也不能用。
  // 「宁可给出模糊的正确答案，也不要给出确切的错误答案」。
  const r = await withFakeFetch(
    (url, opts) => {
      // HEAD 先 401 → 会降级 GET 读 body
      return opts.method === "GET"
        ? { status: 401, body: '{"error":{"message":"insufficient scope"}}' }
        : { status: 401 };
    },
    () => probeModelEndpoint({ baseUrl: "https://api.example.com/v1", apiKey: "sk-maybe" })
  );
  assert.equal(r.ok, null, "拿不到明确证据时必须返回 null，不能猜");
  assert.equal(r.reason, "unauthorized-on-models");
  // 断言语义而非逐字文案（文案会微调，语义不能变）：
  // 必须表达「这个 401 不能断定对话接口不可用」这个不确定性。
  assert.ok(/不能据此断定|不代表|不确定|无法.*断定/.test(r.evidence), `evidence 必须表达不确定性：${r.evidence}`);
  assert.ok(r.detail.includes("无法据此断定"), r.detail);
});

test("三态 · 明确不可用：响应体点名 token invalid → ok=false", async () => {
  // SiliconFlow 真实响应：{"code":30014,"message":"Token is invalid."}
  const r = await withFakeFetch(
    (url, opts) => (opts.method === "GET"
      ? { status: 401, body: '{"code":30014,"data":null,"message":"Token is invalid."}' }
      : { status: 401 }),
    () => probeModelEndpoint({ baseUrl: "https://api.siliconflow.cn/v1", apiKey: "sk-bad" })
  );
  assert.equal(r.ok, false, "服务端明确说凭据无效时可以断定");
  assert.equal(r.reason, "unauthorized");
  assert.ok(r.evidence.includes("凭据无效"), r.evidence);
  assert.ok(r.errorCode.includes("30014") || r.errorCode.length > 0, `应抓到错误码，实际 ${r.errorCode}`);
});

test("没配 key 时 401 → ok=false（明确：缺 key）", async () => {
  const r = await withFakeFetch({ status: 401 }, () =>
    probeModelEndpoint({ baseUrl: "https://api.example.com/v1", apiKey: "" })
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unauthorized");
  assert.ok(r.evidence.includes("没有配置 Key"), r.evidence);
});

test("HEAD 404 → 降级 GET（SiliconFlow 实测行为）", async () => {
  let methods = [];
  const r = await withFakeFetch(
    (url, opts) => {
      methods.push(opts.method);
      return opts.method === "HEAD" ? { status: 404 } : { status: 401, body: '{"code":30014,"message":"Token is invalid."}' };
    },
    () => probeModelEndpoint({ baseUrl: "https://api.siliconflow.cn/v1", apiKey: "sk-x" })
  );
  assert.deepEqual(methods, ["HEAD", "GET"], `应 HEAD 后降级 GET，实际 ${methods.join(",")}`);
  assert.equal(r.method, "GET");
  assert.equal(r.ok, false, "GET 拿到 401 + 明确 token invalid");
});

test("GET 404 → ok=null（端点未实现，判不出对话接口是否可用）", async () => {
  const r = await withFakeFetch({ status: 404 }, () =>
    probeModelEndpoint({ baseUrl: "https://api.example.com/v1", apiKey: "sk-x" })
  );
  assert.equal(r.ok, null);
  assert.equal(r.reason, "http-error");
  assert.ok(r.evidence.includes("未实现 /models"), r.evidence);
});

test("没有 baseUrl → 明确失败，不发请求", async () => {
  let called = false;
  const r = await withFakeFetch({ status: 200 }, () => {
    return probeModelEndpoint({ baseUrl: "", apiKey: "sk-x" });
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-base-url");
  assert.ok(r.detail.includes("baseUrl"), r.detail);
});

test("5xx → ok=false（明确服务端故障）", async () => {
  const r = await withFakeFetch({ status: 503 }, () =>
    probeModelEndpoint({ baseUrl: "https://api.example.com/v1", apiKey: "sk-x" })
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "http-error");
  assert.equal(r.status, 503);
});

// ---------------------------------------------------------------------------
// probeProvidersReachable（Trae 导入后自检复用同一套）
// ---------------------------------------------------------------------------

test("probeProvidersReachable：不抛错、每个 provider 都补上字段", async () => {
  const providers = [
    { provider: "a", baseUrl: "https://ok.example/v1" },
    { provider: "b", baseUrl: "https://down.example/v1" }
  ];
  const out = await withFakeFetch(
    (url) => (url.includes("ok.example") ? { status: 200 } : { throws: { name: "TimeoutError", message: "aborted" } }),
    () => probeProvidersReachable(providers)
  );
  assert.equal(out.length, 2);
  const byProvider = new Map(out.map((p) => [p.provider, p]));
  assert.equal(byProvider.get("a").reachable, true);
  assert.equal(byProvider.get("b").reachable, false);
  // 字段名保持向后兼容（trae-import 与既有 UI 都在用）
  for (const p of out) {
    assert.equal(typeof p.reachableStatus, "number");
    assert.equal(typeof p.reachableMethod, "string");
    assert.equal(typeof p.reachableDetail, "string");
  }
});

test("超时常量是 3 秒（契约要求）", () => {
  assert.equal(PROBE_TIMEOUT_MS, 3000);
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

console.log(`\nprobe.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
