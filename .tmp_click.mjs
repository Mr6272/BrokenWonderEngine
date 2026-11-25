// 交互验证：真的在画布上点几下，看扫雷板状态有没有变、画面有没有变。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.argv[2];
const PORT = 8941, CDP_PORT = 9361;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".wav": "audio/wav" };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const f = join(ROOT, normalize(p).replace(/^([/\\])+/, ""));
  if (!existsSync(f)) { res.writeHead(404); res.end("nf"); return; }
  const body = await readFile(f);
  res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`,
  "--user-data-dir=" + join(process.env.TEMP, "bwe-click-" + Date.now()),
  "--no-first-run", "--no-default-browser-check", "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader", "--disable-gpu-sandbox", "--no-sandbox",
  "--hide-scrollbars", "--mute-audio", "--window-size=900,700", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const pg = l.find((t) => t.type === "page");
    if (pg) { wsUrl = pg.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pend = new Map(); const errs = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") errs.push(String(m.params.exceptionDetails?.exception?.description || "").slice(0, 300));
});
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pend.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "ERR " + (r.result.exceptionDetails.exception?.description || "").slice(0, 300);
  return r.result?.result?.value;
};
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
for (let i = 0; i < 80; i++) { await sleep(250); if (await ev("!!window.__bwe_player")) break; }
await sleep(800);

console.log("[A] 启动:", await ev("document.querySelector('#bwe-status') ? document.querySelector('#bwe-status').textContent : document.body.innerText.slice(0,120)"));

// 棋盘画布中心 -> 画布坐标
const geom = await ev(`(() => {
  const p = window.__bwe_player, cam = p.ctx.camera, gl = p.renderer.gl;
  const board = p.bwe.mine.__board();
  const obj = p.ctx.scene.objects.find(o => o.assetId === "__mine_board") || p.ctx.scene.objects[0];
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  // 世界 -> 屏幕：renderer.beginFrame(cam.x, cam.y, zoom) 的约定
  const sx = (obj.x - cam.x) * cam.zoom + W / 2;
  const sy = (obj.y - cam.y) * cam.zoom + H / 2;
  const rect = p.canvas.getBoundingClientRect();
  const dpr = W / rect.width;
  return JSON.stringify({ cx: sx / dpr, cy: sy / dpr, rectW: rect.width, rectH: rect.height, obj: { x: obj.x, y: obj.y }, cam, st: board.state() });
})()`);
console.log("[B] 几何:", geom);

const g = JSON.parse(geom);

async function click(cx, cy, button) {
  return ev(`(() => {
    const p = window.__bwe_player;
    const rect = p.canvas.getBoundingClientRect();
    const opts = { clientX: rect.left + ${cx}, clientY: rect.top + ${cy}, button: ${button}, bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true };
    p.canvas.dispatchEvent(new PointerEvent("pointerdown", opts));
    p.canvas.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    window.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    return p.bwe.mine.__board().state();
  })()`);
}

console.log("[C] 点击中心前:", await ev("JSON.stringify(window.__bwe_player.bwe.mine.__board().state())"));
const after1 = await click(g.cx, g.cy, 0);
console.log("[D] 点中心后:", JSON.stringify(after1));

await sleep(400);
const after2 = await click(g.cx + 60, g.cy + 30, 0);
console.log("[E] 再点一格:", JSON.stringify(after2));

const after3 = await click(g.cx - 40, g.cy - 40, 2);
console.log("[F] 右键插旗:", JSON.stringify(after3));

// 像素多样性：真的画出东西才会颜色多
console.log("[G] 像素:", await ev(`(() => {
  const gl = window.__bwe_player.renderer.gl;
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const m = new Map();
  for (let i = 0; i < buf.length; i += 4) {
    const k = (buf[i] >> 3) + "," + (buf[i+1] >> 3) + "," + (buf[i+2] >> 3);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return JSON.stringify({ buckets: m.size, top: [...m].sort((a,b)=>b[1]-a[1]).slice(0,5) });
})()`));

console.log("[H] 异常:", errs.length ? errs.join(" | ") : "无");
server.close(); chrome.kill(); await sleep(200); process.exit(0);
