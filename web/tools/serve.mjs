/**
 * 开发用静态服务器。
 *
 * 为什么不用 esbuild 的 --serve：它在后台运行时会因为 stdin 关闭而自动退出，
 * 没法作为一个长期进程用。这里 30 行原生 http 就够，且没有任何依赖。
 *
 * 用法：node web/tools/serve.mjs [端口]
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.argv[2] ?? 5273);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".map": "application/json; charset=utf-8"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = decodeURIComponent(url.pathname);
    if (path === "/" || path === "") path = "/index.html";

    // 防目录穿越：规范化后必须仍在 web 根目录下
    const target = normalize(join(webRoot, path));
    if (!target.startsWith(webRoot)) {
      res.writeHead(403).end("403");
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || info.isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404 找不到：" + path);
      return;
    }

    const data = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      // 开发期不缓存，改完刷新就能看到
      "cache-control": "no-store"
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("500 " + e.message);
  }
});

server.listen(port, "127.0.0.1", () => {
  // 这行会出现在后台任务日志里，用于确认服务确实起来了
  console.log(`[bwe] 编辑器已就绪: http://127.0.0.1:${port}/`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
