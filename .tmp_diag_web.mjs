// 诊断版：捕获网络失败 + 页面可见文本 + 是否有 overlay 报错
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.argv[2];
const PORT = 8914;
const CDP_PORT = 9334;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".wav": "audio/wav" };
const hits = [];
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = join(ROOT, normalize(p).replace(/^([/\\])+/, ""));
  if (!existsSync(file)) { hits.push(["404", p]); res.writeHead(404); res.end("nf"); return; }
  const body = await readFile(file);
  hits.push(["200", p, body.length]);
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "content-length": body.length });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`,
  "--user-data-dir=" + join(process.env.TEMP, "bwe-diag-" + Date.now()),
  "--no-first-run", "--no-default-browser-check",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox",
  "--no-sandbox", "--hide-scrollbars", "--mute-audio", "--window-size=900,700", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const pg = list.find((t) => t.type === "page"); if (pg) { wsUrl = pg.webSocketDebuggerUrl; break; } } catch {}
  await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") logs.push("[console." + m.params.type + "] " + (m.params.args||[]).map(a=>a.value ?? a.description ?? a.type).join(" "));
  if (m.method === "Runtime.exceptionThrown") logs.push("[exception] " + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  if (m.method === "Log.entryAdded") logs.push("[log." + m.params.entry.level + "] " + m.params.entry.text + " @ " + (m.params.entry.url || ""));
});
const send = (method, params={}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? { err: r.result.exceptionDetails.exception?.description } : r.result?.result?.value; };

await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(6000);

console.log("=== BODY TEXT ===");
console.log(await ev("document.body.innerText"));
console.log("\n=== GLOBALS ===");
console.log(JSON.stringify({ player: await ev("typeof window.__bwe_player"), stats: await ev("typeof window.__bwe_stats"), report: await ev("typeof window.__bwe_report"), readyState: await ev("document.readyState") }));
console.log("\n=== SCRIPTS LOADED ===");
console.log(JSON.stringify(await ev("[...document.scripts].map(s=>s.src)"), null, 1));
console.log("\n=== SERVER HITS ===");
for (const h of hits) console.log("  " + h.join("  "));
console.log("\n=== LOGS ===");
for (const l of logs) console.log("  " + String(l).slice(0, 500));

server.close(); chrome.kill(); await sleep(200); process.exit(0);
