// Web 播放器真跑验证（带看门狗）：静态服务器 + headless Chrome + CDP
// 设计要点：任何一步卡住都必须输出已拿到的部分结果，绝不静默挂死。
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.argv[2];
const REPORT = process.argv[3] || join(process.cwd(), ".tmp_webverify.json");
const PORT = 8921;
const CDP_PORT = 9341;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".wav": "audio/wav" };

const report = { steps: {}, hits: [], console: [], exceptions: [], note: [] };
const emit = (k, v) => { report.steps[k] = v; console.log(k + ": " + JSON.stringify(v)); };
const finish = async (code, why) => {
  if (why) report.note.push(why);
  try { await writeFile(REPORT, JSON.stringify(report, null, 2), "utf8"); console.log("report -> " + REPORT); } catch {}
  try { server.close(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  process.exit(code);
};
// 看门狗：45 秒还没结束就带着已有结果退出
const watchdog = setTimeout(() => { console.log("!! WATCHDOG fired — 页面可能卡在同步死循环"); finish(2, "watchdog"); }, 45000);
watchdog.unref?.();

const hits = [];
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = join(ROOT, normalize(p).replace(/^([/\\])+/, ""));
  if (!existsSync(file)) { hits.push({ s: 404, p }); res.writeHead(404); res.end("nf"); return; }
  const body = await readFile(file);
  hits.push({ s: 200, p, n: body.length });
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "content-length": body.length });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log("[server] " + ROOT);

const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`,
  "--user-data-dir=" + join(process.env.TEMP, "bwe-wv-" + Date.now()),
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
if (!wsUrl) await finish(1, "chrome devtools unreachable");

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") report.console.push({ t: m.params.type, s: (m.params.args||[]).map(a=>a.value ?? a.description ?? a.type).join(" ").slice(0,300) });
  if (m.method === "Runtime.exceptionThrown") report.exceptions.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).slice(0,500));
  if (m.method === "Log.entryAdded") report.console.push({ t: m.params.entry.level, s: (m.params.entry.text + " @ " + (m.params.entry.url||"")).slice(0,300) });
});
const send = (method, params={}) => Promise.race([
  new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); }),
  sleep(8000).then(() => ({ __timeout: true, method })),
]);
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.__timeout) return { err: "eval timeout (JS thread blocked?)" };
  if (r.result?.exceptionDetails) return { err: r.result.exceptionDetails.exception?.description || "eval error" };
  return { v: r.result?.result?.value };
};

await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });

// 1. 页面是否进入 complete 且无 fatal overlay
let ok = false;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const r = await ev("!!window.__bwe_player");
  if (r.v) { ok = true; break; }
}
emit("pageReady", ok);

// 2. 页面正文（失败时这里就是错误信息）
const body = await ev("document.body.innerText.slice(0,600)");
emit("bodyText", body.v ?? body.err);

// 3. 全局诊断对象
const globals = await ev("JSON.stringify({player: typeof window.__bwe_player, stats: typeof window.__bwe_stats, report: typeof window.__bwe_report})");
emit("globals", globals.v ?? globals.err);

// 4. 场景 / 脚本 / 纹理
const scene = await ev(`(() => {
  const p = window.__bwe_player; if (!p) return null;
  const c = p.ctx;
  return JSON.stringify({
    objects: c.scene.objects.length,
    sceneSize: [c.scene.width, c.scene.height],
    camera: c.camera,
    elapsed: +c.time.elapsed.toFixed(3),
    frames: c.time.frame,
    textures: p.renderer.textureCount(),
    drawCalls: p.renderer.drawCalls ?? null,
    scripts: (p.scripts||[]).map(s => (s.name||"?") + ":" + ["onSceneStart","onUpdate","onDraw"].filter(h => typeof s[h] === "function").join("+")),
    assets: (p.assets||[]).length
  });
})()`);
emit("scene", scene.v ?? scene.err);

// 5. WebGL 状态
const gl = await ev(`(() => {
  const p = window.__bwe_player; if (!p) return null;
  const g = p.renderer.gl; if (!g) return "no gl";
  return JSON.stringify({ lost: g.isContextLost(), version: g.getParameter(g.VERSION), renderer: g.getParameter(g.RENDERER), err: g.getError(), size: [g.drawingBufferWidth, g.drawingBufferHeight] });
})()`);
emit("webgl", gl.v ?? gl.err);

// 6. 像素采样：证明真的画了东西
const px = await ev(`(() => {
  const p = window.__bwe_player; if (!p) return null;
  const g = p.renderer.gl, w = g.drawingBufferWidth, h = g.drawingBufferHeight;
  const buf = new Uint8Array(w*h*4);
  g.readPixels(0,0,w,h,g.RGBA,g.UNSIGNED_BYTE,buf);
  let nonBlack = 0; const buckets = new Map();
  for (let i = 0; i < buf.length; i += 4) {
    const k = (buf[i]>>4)+","+(buf[i+1]>>4)+","+(buf[i+2]>>4);
    buckets.set(k,(buckets.get(k)||0)+1);
    if (buf[i]+buf[i+1]+buf[i+2] > 24) nonBlack++;
  }
  return JSON.stringify({ size:[w,h], nonBlackRatio: +(nonBlack/(w*h)).toFixed(4), buckets: buckets.size, top: [...buckets].sort((a,b)=>b[1]-a[1]).slice(0,5) });
})()`);
emit("pixels", px.v ?? px.err);

// 7. 输入：键盘 + 鼠标坐标是否进了 shim
const input = await ev(`(() => {
  const p = window.__bwe_player; if (!p) return null;
  const k = p.ctx.input.keys, before = k.size;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft" }));
  const down = k.size;
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", code: "ArrowLeft" }));
  const up = k.size;
  const cv = document.getElementById("bwe-canvas"), r = cv.getBoundingClientRect();
  cv.dispatchEvent(new MouseEvent("mousemove", { clientX: r.left + r.width/2, clientY: r.top + r.height/2, bubbles: true }));
  return JSON.stringify({ keysBefore: before, keysDown: down, keysUp: up, mouse: p.ctx.input.mouse });
})()`);
emit("input", input.v ?? input.err);

// 8. 时间推进：等一秒看帧数涨
const f0 = await ev("window.__bwe_player ? window.__bwe_player.ctx.time.frame : null");
await sleep(1000);
const f1 = await ev("window.__bwe_player ? window.__bwe_player.ctx.time.frame : null");
emit("framesPerSecond", (typeof f0.v === "number" && typeof f1.v === "number") ? f1.v - f0.v : (f0.err || f1.err));

// 9. API 分级报告
const rep = await ev("typeof window.__bwe_report === 'function' ? JSON.stringify(window.__bwe_report()) : 'no report fn'");
emit("apiReport", rep.v ?? rep.err);

report.hits = hits;
report.console = report.console.slice(0, 40);
report.exceptions = report.exceptions.slice(0, 10);
await finish(0);
