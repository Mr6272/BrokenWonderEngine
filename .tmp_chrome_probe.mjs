import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = ".tmp_chrome_prof";
const PORT = 9333;
await mkdir(PROFILE, { recursive: true });

const args = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${Px(PROFILE)}`,
  "--headless=new",
  "--disable-gpu-sandbox",
  "--no-first-run",
  "--no-default-browser-check",
  "--use-gl=swiftshader",
  "--enable-unsafe-swiftshader",
  "--window-size=1024,768",
  "about:blank",
];
function Px(p) { return process.cwd() + "\\" + p; }

const proc = spawn(CHROME, args, { stdio: "ignore", detached: false });

// 等 devtools 端口
let ws = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (res.ok) { ws = (await res.json()).webSocketDebuggerUrl; break; }
  } catch {}
}
if (!ws) { console.log("FAIL: Chrome 调试端口没起来"); proc.kill(); process.exit(1); }
console.log("Chrome 已就绪");

// 新建一个页面
const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const pageWs = t.webSocketDebuggerUrl;

const WebSocket = (await import("node:worker_threads")) && null;
// node 没有内置 ws，用原生 http upgrade 手搓太重；改用 CDP over HTTP + 简易 ws 实现
console.log("targetId:", t.id);
proc.kill();
