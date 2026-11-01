#!/usr/bin/env node
/**
 * 与**真实 BWE Studio 服务**的集成测试（可选，用 `--with-server` 才跑）。
 *
 * 平时（不传参）跳过：CI 里不一定有 JDK / TypeScript 依赖。
 * 传 `--with-server` 时：
 *   1. 用 `node web/tools/serve.mjs <端口>` 起一个临时实例；
 *   2. 等它打印就绪行；
 *   3. 把真实示例脚本（web/examples/俯视角JS示例.bwproj 的 hud / player）源码 POST 过去；
 *   4. 断言返回结构与 serve.mjs 的 checkJsSource() 完全一致、且正常脚本 0 错误；
 *   5. 关闭服务。
 *
 * 输出 PASS / FAIL，退出码 0 / 1（跳过时 0）。
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(EXT_ROOT, "..", "..");
const nodeRequire = createRequire(import.meta.url);
const serverCheck = nodeRequire(join(EXT_ROOT, "lib", "serverCheck.js"));

const WITH_SERVER = process.argv.includes("--with-server");

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

if (!WITH_SERVER) {
  console.log("SKIP  服务集成测试（需要起真实 serve.mjs；加 --with-server 才跑）");
  console.log("");
  console.log(`结果：0 通过 / 0 失败（已跳过）`);
  process.exit(0);
}

// ============================================================================

const PORT = 5400 + Math.floor(Math.random() * 80);
const worklog = join(EXT_ROOT, ".tmp", `serve-${PORT}.log`);

async function startServer() {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(EXT_ROOT, ".tmp"), { recursive: true });
  const log = [];
  const proc = spawn(process.execPath, [join(REPO_ROOT, "web", "tools", "serve.mjs"), String(PORT)], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  proc.stdout.on("data", (b) => log.push(b.toString("utf8")));
  proc.stderr.on("data", (b) => log.push(b.toString("utf8")));
  // 等就绪（serve.mjs 会打印 `[bwe] 脚本诊断: POST http://127.0.0.1:<port>/api/js-check`）
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    if (log.join("").includes("脚本诊断")) {
      ready = true;
      break;
    }
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { proc, ready, log: log.join("") };
}

async function stopServer(proc) {
  return new Promise((resolvePromise) => {
    if (!proc || proc.exitCode !== null) return resolvePromise();
    proc.on("close", () => resolvePromise());
    try {
      proc.kill("SIGTERM");
    } catch {
      /* 忽略 */
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 忽略 */
      }
      resolvePromise();
    }, 3000);
  });
}

const srv = await startServer();
ok("serve.mjs 起来了并打印脚本诊断端点", srv.ready, srv.log.slice(-400));

if (!srv.ready) {
  await stopServer(srv.proc);
  console.log("");
  console.log(`结果：${passed} 通过 / ${failed + 1} 失败`);
  console.log("  ✗ 服务没起来，跳过后续断言（本机可能需要 npm install / JDK）");
  process.exit(1);
}

const serverUrl = `http://127.0.0.1:${PORT}`;

// ---- 真实示例脚本 ----
const projPath = join(REPO_ROOT, "web", "examples", "俯视角JS示例.bwproj");
let scripts = [];
if (existsSync(projPath)) {
  const proj = JSON.parse(readFileSync(projPath, "utf8"));
  for (const name of ["hud", "player"]) {
    const entry = proj.scripts && proj.scripts[name];
    if (entry && (entry.lang || "yarn") === "js") scripts.push({ name, source: String(entry.source || "") });
  }
}
ok("读到 俯视角JS示例 的 hud/player 源码", scripts.length === 2, `${scripts.length} 个`);

// ---- 1. 正常脚本 → 0 错误 ----
for (const s of scripts) {
  const r = await serverCheck.requestJsCheck({ serverUrl, source: s.source, name: s.name, timeoutMs: 15000 });
  ok(`真实服务可达并返回 {ok, diagnostics, hasTypes}（${s.name}）`, r.status === "ok" && typeof r.hasTypes === "boolean" && Array.isArray(r.diagnostics), JSON.stringify(r).slice(0, 200));
  const errors = r.status === "ok" ? r.diagnostics.filter((d) => d.severity === "error") : [];
  ok(`正常示例脚本 ${s.name} 无类型错误`, r.status === "ok" && errors.length === 0, errors.map((d) => `L${d.line}: ${d.message}`).join(" | "));
}

// ---- 2. 故意写坏 → 有诊断 ----
const badSource = [
    'import x from "y";',
    "var t = setTimeout(function () {}, 10);",
    'document.title = "x";',
    "function onSceneStart(ctx) { ctx.self.x = 1; }",
  ].join("\n");
const bad = await serverCheck.requestJsCheck({ serverUrl, source: badSource, name: "bad", timeoutMs: 15000 });
ok("坏脚本能拿到服务端诊断（ok:false）", bad.status === "ok" && bad.ok === false && bad.diagnostics.length > 0, JSON.stringify(bad).slice(0, 300));
ok("服务端确实认出 document / import 是错误", bad.status === "ok" && bad.diagnostics.some((d) => /document|import|module/.test(d.message)), bad.status === "ok" ? bad.diagnostics.map((d) => d.message).join(" | ") : String(bad.reason));

// ---- 3. 不可达的端口 → down ----
// 用刚才的服务地址换一个死端口来验证降级路径（服务已经在跑，这里只验客户端行为）
const dead = await serverCheck.requestJsCheck({ serverUrl: `http://127.0.0.1:${PORT + 900}`, source: "var x=1;", name: "s", timeoutMs: 1500 });
ok("同机另一个死端口 → down（不抛异常）", dead.status === "down", JSON.stringify(dead));

// ---- 4. 真实响应的形状与代码里读的字段一一对应 ----
// 这段直接打原始 HTTP，不复用客户端，避免「客户端和断言一起错」
{
  const http = await import("node:http");
  const body = JSON.stringify({ source: 'var x = 1;\nfunction onUpdate(ctx, dt) { bwe.log("ok"); }\n', name: "shape" });
  const raw = await new Promise((resolvePromise) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path: "/api/js-check", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolvePromise({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", () => resolvePromise({ status: 0, text: "" }));
    req.end(body);
  });
  let data = null;
  try {
    data = JSON.parse(raw.text);
  } catch {
    data = null;
  }
  const keys = data ? Object.keys(data) : [];
  ok("原始响应 HTTP 200", raw.status === 200, String(raw.status));
  ok("响应字段就是 {ok,name,hasTypes,diagnostics,transpiled}", ["ok", "name", "hasTypes", "diagnostics", "transpiled"].every((k) => keys.includes(k)), keys.join(","));
  ok("diagnostics 每条是 {line,col,severity,message}（可能为空数组）", Array.isArray(data?.diagnostics) && data.diagnostics.every((d) => "line" in d && "col" in d && "severity" in d && "message" in d), JSON.stringify(data?.diagnostics));
  ok("hasTypes=true（声明文件被服务端加载）", data?.hasTypes === true, JSON.stringify(data?.hasTypes));
  ok("transpiled 非空（TS 降级成功）", typeof data?.transpiled === "string" && data.transpiled.length > 0, JSON.stringify(data?.transpiled?.slice(0, 60)));
}

await stopServer(srv.proc);
ok("服务已关闭（不留后台进程）", srv.proc.exitCode !== null || srv.proc.killed === true, String(srv.proc.exitCode));

// ============================================================================

console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✅ 真实服务集成测试全绿（端点契约 / 正常脚本无错 / 坏脚本有诊断 / 不可达降级）");
process.exit(0);
