/**
 * 桌面壳 · 内嵌 API 适配层。
 *
 * `web/tools/api-core.mjs` 是**纯逻辑**（输入 path/method/query/body → 输出 status/json/binary）。
 * 这里只做两件事：
 *   1. 把 IPC 传来的 `path` 拆成 pathname + query（渲染侧习惯写 "/api/script-file?name=x"）；
 *   2. 把结果包成契约 §3 的形状 `{ok, status, json|text, headers}`。
 *
 * 桌面版没有任何接口需要 multipart：打包/试跑的 body 本来就是 JSON（见 web/src/app/packageBwe.ts），
 * 所以 IPC 直接把 JSON 字符串交给 api-core，不必在 Node 里解析 multipart。
 * HTTP 版（serve.mjs）保留自己的读 body 逻辑，两边共用同一份业务代码。
 *
 * 二进制下载（package-bwe/download、download-apk）不适合走 IPC 的 JSON 返回，
 * 由 main.mjs 单独开一条 `download-bwe` IPC：主进程弹原生保存对话框写盘。
 */

import { createApiCore } from "../../web/tools/api-core.mjs";

/**
 * @param {object} opts
 * @param {string} opts.repoRoot      仓库根（也是打包后 app 的根：web/ lib/ src/ 都在它下面）
 * @param {number} [opts.port]        0 = 桌面（无端口）
 * @param {(msg:string, tag?:string)=>void} [opts.onLog]
 */
export function createEmbeddedApi({ repoRoot, port = 0, onLog }) {
  const core = createApiCore({
    webRoot: `${repoRoot}/web`,
    projectRoot: repoRoot,
    port,
    // 桌面版没有控制台，日志交给主进程统一处理（--console 时再打到 stdout）。
    onLog: onLog ?? (() => {})
  });

  /** "/api/x?y=1" → { pathname:"/api/x", query:{y:"1"} } */
  function splitPath(rawPath) {
    const raw = String(rawPath ?? "");
    const qIndex = raw.indexOf("?");
    if (qIndex < 0) return { pathname: raw, query: {} };
    const search = new URLSearchParams(raw.slice(qIndex + 1));
    return { pathname: raw.slice(0, qIndex), query: Object.fromEntries(search.entries()) };
  }

  /**
   * 处理一个 IPC 请求。
   * @param {string} path   例如 "/api/quick-run/status"
   * @param {{method?:string, body?:string|object, headers?:Record<string,string>}} [init]
   */
  async function handleApi(path, init = {}) {
    const { pathname, query } = splitPath(path);
    if (!pathname.startsWith("/api/")) {
      return { ok: false, status: 400, json: { ok: false, error: `不是 /api 路径：${path}` } };
    }
    try {
      const result = await core.handle({
        path: pathname,
        method: init?.method ?? "GET",
        query,
        body: init?.body ?? null
      });
      if (result?.binary) {
        // 二进制没有结构化返回：告诉渲染侧该走 download 通道，并把元信息带上。
        return {
          ok: true,
          status: 200,
          json: {
            ok: true,
            binary: true,
            contentType: result.binary.contentType,
            filename: result.binary.filename,
            sizeBytes: result.binary.data?.length ?? 0,
            hint: "桌面版请用 window.bweHost.downloadFile(path, filename) 保存（会弹原生保存对话框）"
          }
        };
      }
      if (result?.handled === false) {
        return { ok: false, status: 404, json: { ok: false, error: "接口不存在" } };
      }
      const status = Number(result?.status ?? 200);
      const payload = result?.json ?? null;
      // 契约要求 ok 与 status 同时给出；ok 由 status 派生，避免出现 ok:true + status:500 的自相矛盾。
      return { ok: status >= 200 && status < 300, status, json: payload };
    } catch (e) {
      const message = e?.message || String(e);
      onLog?.(`API 调用失败：${path} → ${message}`, "bwe:api");
      return { ok: false, status: 500, json: { ok: false, error: message } };
    }
  }

  /** 供下载通道使用：返回 {status, binary} 或 null。 */
  async function rawBinary(path) {
    const { pathname, query } = splitPath(path);
    const result = await core.handle({ path: pathname, method: "GET", query, body: null });
    return result?.binary ?? null;
  }

  return {
    handleApi,
    rawBinary,
    core,
    stopQuickRun: () => core.stopQuickRun(),
    killQuickRunSync: () => core.killQuickRunSync()
  };
}
