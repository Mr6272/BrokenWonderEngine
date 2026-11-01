/**
 * 本地服务 `/api/js-check` 客户端（纯 Node，不依赖 `vscode`）。
 *
 * 事实来源：`web/tools/serve.mjs` 里的 `checkJsSource()`（约 212~300 行）与路由（约 682 行）。
 *
 * 请求：POST <serverUrl>/api/js-check
 *   body  {source: string, name: string}
 * 响应 200：
 *   {
 *     ok: boolean,
 *     name: string,
 *     hasTypes: boolean,
 *     diagnostics: [{line:number, col:number, severity:"error"|"warning", message:string}],
 *     transpiled: string
 *   }
 * 失败（400 / 500）：{ok:false, error:string}
 *
 * 任何网络 / 解析异常都**不抛**，统一返回 {status:"down", reason}：
 * 用户可能只是没开 `npm run serve`，扩展不该弹错误。
 */

"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

/**
 * POST 一段脚本到 js-check。
 *
 * @param {object} opts
 * @param {string} opts.serverUrl 例如 "http://127.0.0.1:5273"
 * @param {string} opts.source    脚本源码
 * @param {string} opts.name      脚本名（服务端只用于展示 / transpile 文件名）
 * @param {number} [opts.timeoutMs=2500]
 * @returns {Promise<{status:"ok"|"down", diagnostics?:object[], hasTypes?:boolean, error?:string, reason?:string}>}
 */
function requestJsCheck(opts) {
  const options = opts || {};
  const serverUrl = String(options.serverUrl || "http://127.0.0.1:5273").trim();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 2500;
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(joinPath(serverUrl, "/api/js-check"));
    } catch (e) {
      resolve({ status: "down", reason: `serverUrl 不是合法 URL：${serverUrl}` });
      return;
    }
    const payload = JSON.stringify({
      source: String(options.source || ""),
      name: String(options.name || "script"),
    });
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(payload),
          accept: "application/json",
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            resolve({ status: "down", reason: `响应不是 JSON（HTTP ${res.statusCode}）` });
            return;
          }
          if (res.statusCode !== 200) {
            resolve({
              status: "down",
              reason: `HTTP ${res.statusCode}：${(data && data.error) || "（没有说明）"}`,
            });
            return;
          }
          if (!data || !Array.isArray(data.diagnostics)) {
            resolve({ status: "down", reason: "响应里没有 diagnostics 数组（服务端版本不匹配？）" });
            return;
          }
          resolve({
            status: "ok",
            ok: !!data.ok,
            hasTypes: !!data.hasTypes,
            name: typeof data.name === "string" ? data.name : String(options.name || ""),
            diagnostics: normalizeDiagnostics(data.diagnostics),
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: "down", reason: `请求超时（${timeoutMs}ms）` });
    });
    req.on("error", (e) => {
      resolve({ status: "down", reason: shortErr(e) });
    });
    try {
      req.write(payload);
      req.end();
    } catch (e) {
      resolve({ status: "down", reason: shortErr(e) });
    }
  });
}

/** 把服务端诊断归一成扩展内部结构（字段名与 serve.mjs 完全一致，只做校验与裁剪）。 */
function normalizeDiagnostics(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== "object") continue;
    const line = Number(raw.line);
    const col = Number(raw.col);
    const severityRaw = String(raw.severity || "error").toLowerCase();
    const severity =
      severityRaw === "warning" || severityRaw === "warn"
        ? "warning"
        : severityRaw === "info" || severityRaw === "suggestion" || severityRaw === "hint"
          ? "info"
          : "error";
    const message = String(raw.message || "").trim();
    if (!message) continue;
    out.push({
      line: Number.isFinite(line) && line > 0 ? Math.round(line) : 1,
      col: Number.isFinite(col) && col > 0 ? Math.round(col) : 1,
      severity,
      message,
      source: "BWE(server)",
    });
  }
  return out;
}

/** 简单的 URL 拼接：避免 `http://x/` + `/api/…` 拼出双斜杠之外的问题。 */
function joinPath(base, suffix) {
  const b = String(base || "").replace(/\/+$/, "");
  const s = String(suffix || "").replace(/^\/+/, "");
  return `${b}/${s}`;
}

function shortErr(e) {
  const code = e && (e.code || e.errno);
  if (code) return String(code);
  return e && e.message ? e.message : String(e);
}

module.exports = {
  requestJsCheck,
  normalizeDiagnostics,
  joinPath,
};
