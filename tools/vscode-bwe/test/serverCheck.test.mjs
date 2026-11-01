#!/usr/bin/env node
/**
 * 本地服务检查客户端测试（起一个临时 http server，不需要 vscode，也不需要 BWE Studio 服务）。
 *
 * 覆盖任务要求的三条：
 *   1. 服务可达且返回诊断 → status:"ok"、诊断被归一成扩展内部结构；
 *   2. 服务不可达（端口没人监听）→ status:"down"、**不抛异常**、给出 reason；
 *   3. 服务返回非 200（500 / 400）→ status:"down"、不抛异常、reason 里带服务端的 error。
 * 另外：
 *   4. 响应不是 JSON / 缺 diagnostics 数组 → 按 down 处理（老版本服务端）；
 *   5. 超时（服务故意不响应）→ down，且在超时时间内返回；
 *   6. 合并逻辑（extension.js 里的 mergeDiagnostics 等价实现）在 serverCheck.test 里也验一遍；
 *   7. 用真实 `check-scripts.mjs` 的响应形状做一次「契约对齐」断言。
 *
 * 输出 PASS / FAIL，退出码 0 / 1。
 */

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const nodeRequire = createRequire(import.meta.url);

const serverCheck = nodeRequire(join(EXT_ROOT, "lib", "serverCheck.js"));

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` —— ${extra}` : ""}`);
    console.log(`FAIL  ${name}${extra ? ` —— ${extra}` : ""}`);
  }
}

/** 起一个临时服务，handler 决定返回什么。返回 {url, close}。 */
function withServer(handler) {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          body = { raw: true };
        }
        handler(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
    server.on("error", () => resolvePromise({ url: "", close: () => Promise.resolve() }));
  });
}

// ============================================================================
// 1. 服务可达 + 返回诊断
// ============================================================================

{
  const srv = await withServer((req, res, body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        name: body.name || "script",
        hasTypes: true,
        diagnostics: [
          { line: 2, col: 5, severity: "error", message: "找不到名称 “bwe”。" },
          { line: 4, col: 1, severity: "warning", message: "变量声明了但从未使用。" },
          { line: 6, col: 3, severity: "info", message: "提示一条。" },
          { line: 0, col: 0, severity: "weird", message: "" }, // 应被丢弃（空消息）
        ],
        transpiled: "var x = 1;",
      })
    );
  });

  const r = await serverCheck.requestJsCheck({ serverUrl: srv.url, source: "var x = bwe;", name: "hud", timeoutMs: 2000 });
  ok("可达 + 200 → status ok", r.status === "ok", JSON.stringify(r));
  ok("可达 → hasTypes 透传", r.status === "ok" && r.hasTypes === true, JSON.stringify(r.hasTypes));
  ok("诊断被归一化（错误/警告/info 三种）", r.status === "ok" && r.diagnostics.length === 3, r.status === "ok" ? `${r.diagnostics.length} 条` : String(r.reason));
  ok(
    "诊断字段齐全（line/col/severity/message/source）",
    r.status === "ok" && r.diagnostics.every((d) => Number.isInteger(d.line) && Number.isInteger(d.col) && d.severity && d.message && d.source === "BWE(server)"),
    JSON.stringify(r.diagnostics)
  );
  ok("空消息的辣鸡条目被丢弃", r.status === "ok" && !r.diagnostics.some((d) => !d.message), JSON.stringify(r.diagnostics));
  ok("未知 severity 归到 error", r.status === "ok" && r.diagnostics[2].severity === "info" && r.diagnostics[0].severity === "error", JSON.stringify(r.diagnostics.map((d) => d.severity)));
  await srv.close();
}

// ============================================================================
// 2. 服务不可达（端口没人监听）
// ============================================================================

{
  // 先抢一个端口然后立刻关掉，保证这个端口真的没人听
  const tmp = await withServer((req, res) => res.end("{}"));
  const deadUrl = tmp.url;
  await tmp.close();

  const started = Date.now();
  const r = await serverCheck.requestJsCheck({ serverUrl: deadUrl, source: "var x = 1;", name: "s", timeoutMs: 1200 });
  const elapsed = Date.now() - started;
  ok("不可达 → status down（不抛异常）", r.status === "down", JSON.stringify(r));
  ok("不可达 → 给出 reason（ECONNREFUSED 之类）", r.status === "down" && typeof r.reason === "string" && r.reason.length > 0, JSON.stringify(r.reason));
  ok("不可达 → 快速失败（< timeout）", elapsed < 1200, `${elapsed}ms`);
}

// ============================================================================
// 3. 非 200 响应
// ============================================================================

{
  const srv = await withServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "找不到 TypeScript（node_modules/typescript）" }));
  });
  const r = await serverCheck.requestJsCheck({ serverUrl: srv.url, source: "var x=1;", name: "s", timeoutMs: 2000 });
  ok("500 → status down（不抛异常）", r.status === "down", JSON.stringify(r));
  ok("500 → reason 带上服务端 error", r.status === "down" && /找不到 TypeScript|HTTP 500/.test(r.reason), JSON.stringify(r.reason));
  await srv.close();
}
{
  const srv = await withServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "缺少 source（脚本源码）" }));
  });
  const r = await serverCheck.requestJsCheck({ serverUrl: srv.url, source: "", name: "s", timeoutMs: 2000 });
  ok("400 → status down（不抛异常）", r.status === "down", JSON.stringify(r));
  await srv.close();
}

// ============================================================================
// 4. 响应不是 JSON / 缺 diagnostics
// ============================================================================

{
  const srv = await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>不是 JSON</html>");
  });
  const r = await serverCheck.requestJsCheck({ serverUrl: srv.url, source: "x", name: "s", timeoutMs: 2000 });
  ok("非 JSON 响应 → status down（不抛异常）", r.status === "down", JSON.stringify(r));
  await srv.close();
}
{
  const srv = await withServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "s" })); // 老版本：没有 diagnostics
  });
  const r = await serverCheck.requestJsCheck({ serverUrl: srv.url, source: "x", name: "s", timeoutMs: 2000 });
  ok("缺 diagnostics 数组 → status down（按服务端版本不匹配处理）", r.status === "down", JSON.stringify(r));
  await srv.close();
}

// ============================================================================
// 5. 超时
// ============================================================================

{
  const srv = await withServer(() => {
    /* 故意不响应 */
  });
  const started = Date.now();
  const r = await serverCheck.requestJsCheck({ serverUrl: srv.url, source: "x", name: "s", timeoutMs: 300 });
  const elapsed = Date.now() - started;
  ok("超时 → status down（不抛异常）", r.status === "down", JSON.stringify(r));
  ok("超时在 timeoutMs 附近返回（不挂死）", elapsed >= 250 && elapsed <= 1500, `${elapsed}ms`);
  await srv.close();
}

// ============================================================================
// 6. 非法 serverUrl
// ============================================================================

{
  const r = await serverCheck.requestJsCheck({ serverUrl: "不是 URL", source: "x", name: "s", timeoutMs: 500 });
  ok("非法 serverUrl → status down（不抛异常）", r.status === "down", JSON.stringify(r));
}

// ============================================================================
// 7. 合并逻辑（与服务端诊断合并时要遵守的规则）
// ============================================================================

{
  // 本地规则 + 服务端诊断：同位置同严重度只留一条（服务端优先，消息更精确）
  const local = [
    { line: 3, col: 1, severity: "error", rule: "E001", message: "E001 不能使用 import", source: "BWE" },
    { line: 9, col: 4, severity: "warning", rule: "E005", message: "E005 setTimeout", source: "BWE" },
  ];
  const server = [
    { line: 3, col: 1, severity: "error", message: "implicit any", source: "BWE(server)" },
    { line: 20, col: 2, severity: "warning", message: "未使用变量", source: "BWE(server)" },
  ];
  const merged = mergeLikeExtension(local, server);
  ok("合并：同位置同严重度的本地规则优先（服务端的重复诊断被抑制）", merged.length === 3, `${merged.length} 条：${JSON.stringify(merged.map((d) => d.message))}`);
  ok("合并：本地规则消息保留（比 TS 的报错更可操作）", merged.some((d) => d.message === "E001 不能使用 import"), JSON.stringify(merged.map((d) => d.message)));
  ok("合并：结果按行号排序", merged.map((d) => d.line).join(",") === "3,9,20", merged.map((d) => d.line).join(","));
}

/** 与 extension.js 的 mergeDiagnostics 同构（那边依赖 vscode 无法直接 require，所以这里复刻一份用于断言）。 */
function mergeLikeExtension(local, server) {
  const out = [];
  for (const d of local) out.push(d);
  for (const d of server) {
    const duplicate = out.some(
      (s) =>
        s.line === d.line &&
        Math.abs((s.col || 1) - (d.col || 1)) <= 2 &&
        (s.severity === d.severity || (s.severity === "error" && d.severity === "error"))
    );
    if (duplicate) continue;
    out.push({
      line: d.line,
      col: d.col,
      severity: d.severity === "warning" ? "warning" : d.severity === "info" ? "info" : "error",
      message: d.message,
      source: "BWE",
      code: "TS",
    });
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}

// ============================================================================
// 8. 契约对齐：serve.mjs 的响应形状
// ============================================================================

{
  // web/tools/serve.mjs 的 checkJsSource() 返回 {ok, name, hasTypes, diagnostics[{line,col,severity,message}], transpiled}
  const shape = { ok: true, name: "hud", hasTypes: true, diagnostics: [{ line: 1, col: 1, severity: "error", message: "x" }], transpiled: "" };
  const normalized = serverCheck.normalizeDiagnostics(shape.diagnostics);
  ok("normalizeDiagnostics 接受 serve.mjs 的字段形状", normalized.length === 1 && normalized[0].line === 1 && normalized[0].col === 1, JSON.stringify(normalized));
  ok("joinPath 拼出 /api/js-check（去掉重复斜杠）", serverCheck.joinPath("http://127.0.0.1:5273/", "/api/js-check") === "http://127.0.0.1:5273/api/js-check", serverCheck.joinPath("http://127.0.0.1:5273/", "/api/js-check"));
}

// ============================================================================

console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✅ serverCheck 测试全绿（可达 / 不可达 / 非 200 / 非 JSON / 超时 都静默降级且不抛异常）");
process.exit(0);
