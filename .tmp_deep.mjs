import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.argv[2];
const PORT = 8931, CDP_PORT = 9351;
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
  "--user-data-dir=" + join(process.env.TEMP, "bwe-deep-" + Date.now()),
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
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pend.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "ERR " + (r.result.exceptionDetails.exception?.description || "");
  return r.result?.result?.value;
};
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
for (let i = 0; i < 60; i++) { await sleep(250); if (await ev("!!window.__bwe_player")) break; }
await sleep(1200);

console.log("=== 对象与纹理对照 ===");
console.log(await ev(`(() => {
  const p = window.__bwe_player, r = p.renderer;
  const out = [];
  for (const o of p.ctx.scene.objects) {
    const e = r.texs.get(o.assetId);
    out.push({
      assetId: o.assetId,
      x: o.x, y: o.y, halfW: o.halfW, halfH: o.halfH,
      scaleX: o.scaleX, scaleY: o.scaleY,
      hasTex: !!e, texW: e ? e.w : null, texH: e ? e.h : null
    });
  }
  return JSON.stringify(out, null, 1);
})()`));

console.log("\n=== 棋盘画布是否有内容 ===");
console.log(await ev(`(() => {
  const p = window.__bwe_player;
  const board = p.bwe && p.bwe.mine && p.bwe.mine.__board ? p.bwe.mine.__board() : null;
  if (!board) return "no board";
  const cv = board.paint();
  const g = cv.getContext("2d");
  const d = g.getImageData(0, 0, Math.min(64, cv.width), Math.min(64, cv.height)).data;
  let nonGray = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i+1] + d[i+2]; if (d[i] !== d[i+1] || d[i+1] !== d[i+2]) nonGray++; }
  return JSON.stringify({ w: cv.width, h: cv.height, avg: +(sum/(d.length/4*3)).toFixed(1), nonGrayPx: nonGray, state: board.state() });
})()`));

console.log("\n=== 屏幕中心像素扫描（横向 20 点） ===");
console.log(await ev(`(() => {
  const gl = window.__bwe_player.renderer.gl;
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const px = new Uint8Array(W * 4);
  const y = Math.floor(H / 2);
  gl.readPixels(0, y, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = [];
  for (let i = 0; i < 20; i++) {
    const x = Math.floor((i / 19) * (W - 1)) * 4;
    out.push(px[x] + "," + px[x+1] + "," + px[x+2]);
  }
  return out.join("  ");
})()`));

console.log("\n=== 相机与投影 ===");
console.log(await ev(`JSON.stringify({ camera: window.__bwe_player.ctx.camera, scene: { w: window.__bwe_player.ctx.scene.width, h: window.__bwe_player.ctx.scene.height } })`));

server.close(); chrome.kill(); await sleep(200); process.exit(0);
