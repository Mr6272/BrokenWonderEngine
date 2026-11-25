/**
 * 无头验证 Web 导出产物。
 *
 * 为什么要同一进程里起 server：这台机器的工具沙箱会在命令结束时杀掉子进程，
 * 所以不能"先起 server 再跑 chrome"。这里把静态服务、Chrome 启动、截图、
 * 控制台收集全放在一个 node 进程里跑完再退出。
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const ROOT = "web/.build/packages/web_test_1/out";
const PORT = 8901;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".md": "text/markdown; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = normalize(url === "/" ? "/index.html" : url).replace(/^[\\/]+/, "");
    const p = join(ROOT, rel);
    const s = await stat(p);
    if (!s.isFile()) throw new Error("not a file");
    const body = await readFile(p);
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`静态服务已起: http://127.0.0.1:${PORT}`);

// 先自检：产物文件都能通过 HTTP 拿到
const probe = async (p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/${p}`);
  return { p, status: r.status, len: (await r.arrayBuffer()).byteLength };
};
const bootJson = await probe("Build/boot.json");
console.log(`自检 boot.json: HTTP ${bootJson.status}, ${bootJson.len} 字节`);
const boot = JSON.parse(await readFile(`${ROOT}/Build/boot.json`, "utf8"));
const asset0 = await probe(boot.assets[0].path);
console.log(`自检 素材: HTTP ${asset0.status}, ${asset0.len} 字节`);
const script0 = await probe("Build/" + boot.scripts[0].file);
console.log(`自检 脚本: HTTP ${script0.status}, ${script0.len} 字节`);

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const shot = process.cwd() + "\\.tmp_shot.png";
if (existsSync(shot)) await import("node:fs/promises").then((m) => m.rm(shot));

const args = [
  "--headless=new",
  "--user-data-dir=" + process.cwd() + "\\.tmp_cprof3",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu-sandbox",
  "--use-gl=swiftshader",
  "--enable-unsafe-swiftshader",
  "--window-size=1024,768",
  "--virtual-time-budget=12000",
  "--screenshot=" + shot,
  "--enable-logging=stderr",
  "--v=0",
  `http://127.0.0.1:${PORT}/index.html`,
];

const chrome = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (d) => { stderr += String(d); });

await new Promise((resolve) => {
  const timer = setTimeout(() => { chrome.kill(); resolve(); }, 40000);
  chrome.on("close", () => { clearTimeout(timer); resolve(); });
});

server.close();

// 只挑出与页面逻辑相关的行（Chrome 自身噪声很多）
const noise = /GPU|Dawn|Vulkan|dbus|Fontconfig|persistent_cache|SharedImage|Skia|angle|gl_display/i;
const relevant = stderr
  .split("\n")
  .filter((l) => l.trim())
  .filter((l) => !noise.test(l))
  .filter((l) => /CONSOLE|ERROR|WebGL|BWE|Uncaught|shader/i.test(l))
  .slice(0, 25);

console.log("\n=== 页面相关控制台输出 ===");
console.log(relevant.length ? relevant.join("\n") : "（无）");

if (existsSync(shot)) {
  const { size } = await stat(shot);
  console.log(`\n截图: ${shot} (${(size / 1024).toFixed(1)} KB)`);
} else {
  console.log("\n截图: 未生成");
}
