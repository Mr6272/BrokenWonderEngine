/**
 * 开发服务器（HTTP 薄壳）。
 *
 * 业务逻辑已经全部搬进 `api-core.mjs`：桌面版（Electron）在主进程里直接调它，
 * 这里只负责「HTTP ↔ api-core」的搬运：读 body / 写 res / 静态文件。
 * 这样网页版和桌面版不会分叉成两套后端。
 *
 * 用法：node web/tools/serve.mjs [端口]
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiCore } from "./api-core.mjs";

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
  ".zip": "application/zip",
  ".map": "application/json; charset=utf-8"
};

const api = createApiCore({ webRoot, port });

/** 读请求体：api-core 只认字符串（它自己 JSON.parse），这里不做业务校验。 */
async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // 与 api-core 的 MAX_BODY 同一个量级；超了就让 JSON.parse 之后的校验报错。
    if (size > 340 * 1024 * 1024) throw new Error("工程或素材太大（超过 320MB），请先压缩素材");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendBinary(res, result) {
  const { data, contentType, filename } = result.binary;
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": data.length,
    "content-disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    // 所有 /api/* 都交给 api-core：打包、JS 诊断、试跑共用同一套错误格式。
    if (url.pathname.startsWith("/api/")) {
      let raw;
      try {
        raw = req.method === "GET" ? null : await readRawBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
        return;
      }
      const result = await api.handle({
        path: url.pathname,
        method: req.method,
        query: Object.fromEntries(url.searchParams.entries()),
        body: raw
      });
      if (result?.binary) {
        sendBinary(res, result);
        return;
      }
      if (result?.handled === false) {
        sendJson(res, 404, { ok: false, error: "接口不存在" });
        return;
      }
      sendJson(res, result.status ?? 200, result.json ?? { ok: false, error: "空响应" });
      return;
    }

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
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("500 " + e.message);
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[bwe] 端口 ${port} 已被占用。换一个端口：node web/tools/serve.mjs 5274`);
  } else {
    console.error("[bwe] 服务启动失败:", e);
  }
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  // 这行会出现在后台任务日志里，用于确认服务确实起来了
  console.log(`[bwe] 编辑器已就绪: http://127.0.0.1:${port}/`);
  console.log(`[bwe] 打包 API: http://127.0.0.1:${port}/api/package-bwe/status`);
  console.log(`[bwe] 脚本诊断: POST http://127.0.0.1:${port}/api/js-check`);
  console.log(`[bwe] 试跑 API: POST http://127.0.0.1:${port}/api/quick-run`);
});

// 服务被关掉时顺手结束试跑进程，不把 Java 窗口留在桌面上。
process.on("exit", () => api.killQuickRunSync());
process.on("SIGTERM", () => {
  api.killQuickRunSync();
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  api.killQuickRunSync();
  server.close(() => process.exit(0));
});
