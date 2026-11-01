/**
 * BWE Script —— VS Code 扩展入口。
 *
 * 设计约束（改之前先读）：
 *   1. **零 npm 依赖**：只能用 Node 内置模块 + `vscode`，不允许引第三方包（vsix 里没有 node_modules）。
 *   2. **不抛未捕获异常**：所有回调都包 `safe(...)`；服务端检查失败静默降级，只更新状态栏。
 *   3. **API 数据只有一份**：补全 / 悬浮 / 签名帮助全部读 `data/bwe-api.json`
 *      （由 `web/tools/gen-vscode-api.mjs` 生成），extension.js 里不许手抄 API 名字。
 *   4. 只在**看起来像 BWE 脚本**的 JS 文档上激活诊断：文中有 `bwe.` / `function onStart` /
 *      `ctx.self` 任意一个才算，避免在普通 JS 项目里刷一堆诊断。
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");

const apiIndex = require("./lib/apiIndex");
const analyzer = require("./lib/analyzer");
const serverCheck = require("./lib/serverCheck");

/** @type {vscode.DiagnosticCollection|null} */
let diagnosticCollection = null;
/** @type {vscode.StatusBarItem|null} */
let statusItem = null;
/** @type {vscode.OutputChannel|null} */
let outputChannel = null;

/** 每个文档的检查状态：{timer, seq, serverState, lastDiagCount, lastServerReason} */
const docState = new WeakMap();

/** 编辑器服务可用性缓存（down 后隔 SERVER_RETRY_MS 再试，避免每敲一个字都打请求）。 */
const serverStatus = { state: "unknown", retryAt: 0, reason: "" };
const SERVER_RETRY_MS = 20000;

/** 上次 hover 命中的条目，供 `bwe.openDocs` 使用。 */
let lastHoverApi = null;

// ============================================================================
// 激活
// ============================================================================

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection("bwe-script");
  context.subscriptions.push(diagnosticCollection);

  outputChannel = vscode.window.createOutputChannel("BWE Script");
  context.subscriptions.push(outputChannel);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "bwe.checkScript";
  statusItem.text = "BWE 检查：待命";
  statusItem.tooltip = "点击立刻重新检查当前脚本";
  statusItem.show();
  context.subscriptions.push(statusItem);

  const selector = [{ language: "javascript", scheme: "file" }, { language: "javascript", scheme: "untitled" }];

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, completionProvider(), ".", ">"),
    vscode.languages.registerHoverProvider(selector, hoverProvider()),
    vscode.languages.registerSignatureHelpProvider(selector, signatureProvider(), "(", ","),
    vscode.commands.registerCommand("bwe.checkScript", safe("bwe.checkScript", () => commandCheckScript())),
    vscode.commands.registerCommand("bwe.installTypes", safe("bwe.installTypes", () => commandInstallTypes(context))),
    vscode.commands.registerCommand("bwe.openDocs", safe("bwe.openDocs", () => commandOpenDocs()))
  );

  // ---- 文档事件 ----
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => safe("onDidChangeTextDocument", () => scheduleCheck(e.document))()),
    vscode.workspace.onDidOpenTextDocument((doc) => safe("onDidOpenTextDocument", () => scheduleCheck(doc))()),
    vscode.workspace.onDidSaveTextDocument((doc) => safe("onDidSaveTextDocument", () => scheduleCheck(doc, true))()),
    vscode.workspace.onDidCloseTextDocument((doc) => safe("onDidCloseTextDocument", () => clearDiagnostics(doc))()),
    vscode.window.onDidChangeActiveTextEditor((ed) => safe("onDidChangeActiveTextEditor", () => onActiveEditor(ed))())
  );

  // 已打开的文档补一次
  for (const doc of vscode.workspace.textDocuments) {
    safe("initialCheck", () => scheduleCheck(doc))();
  }
  safe("updateStatus", () => renderStatus())();
}

function deactivate() {
  if (diagnosticCollection) {
    diagnosticCollection.clear();
    diagnosticCollection.dispose();
    diagnosticCollection = null;
  }
  if (statusItem) {
    statusItem.dispose();
    statusItem = null;
  }
  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = null;
  }
}

// ============================================================================
// 工具：配置 / 错误兜底 / 状态栏
// ============================================================================

function cfg() {
  const c = vscode.workspace.getConfiguration("bwe");
  return {
    serverUrl: String(c.get("serverUrl", "http://127.0.0.1:5273") || "").trim(),
    enableServerCheck: c.get("enableServerCheck", true) !== false,
    enableRules: c.get("enableRules", true) !== false,
    serverTimeoutMs: Number(c.get("serverTimeoutMs", 2500)) || 2500,
    checkDelayMs: Math.max(0, Number(c.get("checkDelayMs", 500)) || 0),
  };
}

/**
 * 包装成「绝不抛出」的函数：任何异常进日志 + 状态栏，不弹窗打断用户。
 * @param {string} label 出错时用于定位
 * @param {Function} fn
 */
function safe(label, fn) {
  return function () {
    try {
      return fn.apply(null, arguments);
    } catch (e) {
      const msg = e && e.stack ? e.stack : String(e);
      try {
        // 输出通道：扩展宿主里 console 一定存在（这是 VS Code 进程，不是 Rhino）
        console.error(`[bwe-script] ${label} 失败：${msg}`);
      } catch {
        /* 忽略 */
      }
      try {
        if (statusItem) {
          statusItem.text = `BWE 检查：内部错误（${label}）`;
          statusItem.tooltip = msg;
        }
      } catch {
        /* 忽略 */
      }
      return undefined;
    }
  };
}

/** 输出通道（视图 → 输出 → BWE Script）：用户排查「为什么我的诊断没出现」的第一站。 */
function log(message) {
  try {
    if (outputChannel) outputChannel.appendLine(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`);
  } catch {
    /* 输出失败不影响功能 */
  }
}

function renderStatus(text) {
  if (!statusItem) return;
  if (text) {
    statusItem.text = text;
    return;
  }
  const state = docStateFor(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document);
  statusItem.text = state && state.lastText ? state.lastText : "BWE 检查：待命";
}

// ============================================================================
// 诊断调度
// ============================================================================

function docStateFor(doc) {
  if (!doc) return null;
  let st = docState.get(doc);
  if (!st) {
    st = { timer: null, seq: 0, lastText: "", lastDiagCount: 0, serverReason: "" };
    docState.set(doc, st);
  }
  return st;
}

function isBweScript(doc) {
  if (!doc || doc.languageId !== "javascript") return false;
  const name = String(doc.fileName || "");
  if (/\.bwe-script\.js$/.test(name)) return true;
  const text = doc.getText();
  if (/\.js$|\.jsx$/.test(name) && /\bbwe\.|function\s+on[A-Z]/.test(text)) return true;
  return false;
}

function scheduleCheck(doc, immediate) {
  if (!doc || !isBweScript(doc)) {
    clearDiagnostics(doc);
    return;
  }
  const st = docStateFor(doc);
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
  const conf = cfg();
  const delay = immediate ? 0 : conf.checkDelayMs;
  st.timer = setTimeout(() => {
    st.timer = null;
    runCheck(doc).catch(() => {
      /* runCheck 内部已兜底 */
    });
  }, delay);
  if (typeof st.timer.unref === "function") st.timer.unref();
}

function clearDiagnostics(doc) {
  if (!diagnosticCollection) return;
  if (doc && doc.uri) diagnosticCollection.delete(doc.uri);
}

function onActiveEditor(editor) {
  if (!editor) {
    renderStatus("BWE 检查：待命");
    return;
  }
  if (isBweScript(editor.document)) {
    scheduleCheck(editor.document);
  } else {
    renderStatus("");
  }
}

/**
 * 真正跑一次检查：先规则检查（立刻出结果），再合服务端诊断。
 * @param {vscode.TextDocument} doc
 */
async function runCheck(doc) {
  if (!doc || doc.isClosed) return;
  const conf = cfg();
  const st = docStateFor(doc);
  const seq = ++st.seq;
  const source = doc.getText();
  const scriptName = path.basename(doc.fileName || "script.js").replace(/\.js$/, "");

  // ---- 本地规则检查 ----
  let local = [];
  if (conf.enableRules) {
    const r = analyzer.analyze(source, { index: apiIndex });
    local = r.diagnostics;
  }

  if (seq !== st.seq) return; // 有更新的检查发起，丢弃这次结果

  publish(doc, local);
  st.lastDiagCount = local.length;
  if (local.length) log(`规则检查：${local.length} 项（${local.map((d) => d.rule).join(", ")}）· ${doc.fileName}`);
  else log(`规则检查：通过 · ${doc.fileName}`);

  // ---- 服务端检查 ----
  if (!conf.enableServerCheck) {
    st.lastText = local.length ? `BWE 检查：规则检查 ${local.length} 项` : "BWE 检查：规则检查通过（服务端检查已关闭）";
    renderStatus(st.lastText);
    return;
  }
  const now = Date.now();
  if (serverStatus.state === "down" && now < serverStatus.retryAt) {
    st.lastText = `BWE 检查：本地服务未启动（仅规则检查${local.length ? `，${local.length} 项` : ""}）`;
    renderStatus(st.lastText);
    return;
  }

  let result;
  try {
    result = await serverCheck.requestJsCheck({
      serverUrl: conf.serverUrl,
      source,
      name: scriptName,
      timeoutMs: conf.serverTimeoutMs,
    });
  } catch (e) {
    result = { status: "down", reason: (e && e.message) || String(e) };
  }
  if (seq !== st.seq) return;

  if (result.status !== "ok") {
    serverStatus.state = "down";
    serverStatus.retryAt = Date.now() + SERVER_RETRY_MS;
    serverStatus.reason = result.reason || "";
    st.serverReason = result.reason || "";
    log(`服务端检查不可用（${result.reason || "未知原因"}）→ 降级为仅规则检查；${SERVER_RETRY_MS / 1000}s 后重试`);
    st.lastText = `BWE 检查：本地服务未启动（仅规则检查${local.length ? `，${local.length} 项` : ""}）`;
    renderStatus(st.lastText);
    return;
  }

  serverStatus.state = "ok";
  serverStatus.retryAt = 0;
  serverStatus.reason = "";

  const server = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const merged = mergeDiagnostics(local, server);
  publish(doc, merged);

  const errCount = merged.filter((d) => d.severity === "error").length;
  const warnCount = merged.filter((d) => d.severity === "warning").length;
  st.lastDiagCount = merged.length;
  log(`服务端检查：${server.length} 条诊断（hasTypes=${result.hasTypes}）→ 合并后 ${merged.length} 条`);
  st.lastText =
    merged.length === 0
      ? `BWE 检查：通过（类型检查${result.hasTypes ? "已启用" : "没有类型声明"}）`
      : `BWE 检查：${errCount} 错误 / ${warnCount} 警告`;
  renderStatus(st.lastText);
}

/**
 * 合并本地规则诊断与服务端诊断。
 *
 * 优先级：**本地规则优先**。规则消息带的是「BWE 里该怎么改」（例如
 * 「不能使用 import（Rhino 没有模块系统；跨脚本用 bwe.scripts.call）」），
 * 比 TypeScript 的「Cannot use import statement outside a module」更有用。
 * 同位置同严重度时只留本地那条；其余服务端诊断照常显示，来源标 BWE、code 标 TS。
 */
function mergeDiagnostics(local, server) {
  const out = [];
  for (const d of local) out.push(d);
  for (const d of server) {
    const duplicate = out.some(
      (s) =>
        s.line === d.line &&
        Math.abs((s.col || 1) - (d.col || 1)) <= 2 &&
        (s.severity === d.severity || (s.severity === "error" && d.severity === "error"))
    );
    if (duplicate) continue;
    out.push({
      line: d.line,
      col: d.col,
      severity: d.severity === "warning" ? "warning" : d.severity === "info" ? "info" : "error",
      message: d.message,
      source: "BWE",
      code: "TS",
    });
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}

/** 发布到 VS Code 诊断集合。 */
function publish(doc, diagnostics) {
  if (!diagnosticCollection || !doc || doc.isClosed) return;
  const items = [];
  for (const d of diagnostics) {
    const lineIdx = Math.max(0, (d.line || 1) - 1);
    if (lineIdx >= doc.lineCount) continue;
    const line = doc.lineAt(lineIdx);
    const col = Math.max(0, Math.min(line.text.length, (d.col || 1) - 1));
    const range =
      d.endLine && d.endLine !== d.line
        ? new vscode.Range(
            new vscode.Position(lineIdx, col),
            new vscode.Position(Math.max(0, d.endLine - 1), Math.max(0, (d.endCol || 1) - 1))
          )
        : new vscode.Range(new vscode.Position(lineIdx, col), new vscode.Position(lineIdx, line.text.length));
    const severity =
      d.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : d.severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
    const diag = new vscode.Diagnostic(range, d.message, severity);
    diag.source = d.source || "BWE";
    if (d.code && typeof d.code === "string") diag.code = d.code;
    items.push(diag);
  }
  diagnosticCollection.set(doc.uri, items);
}

// ============================================================================
// 补全
// ============================================================================

function completionProvider() {
  return {
    provideCompletionItems(document, position, token, context) {
      return safe("completion", () => {
        const conf = cfg();
        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const ctx = apiIndex.completionContext(linePrefix);
        if (ctx.kind === "none") return undefined;

        const candidates = apiIndex.completionCandidates(ctx);
        if (!candidates.length) return undefined;

        const items = [];
        for (const cand of candidates) {
          if (token && token.isCancellationRequested) return undefined;
          const item = new vscode.CompletionItem(cand.label, vscode.CompletionItemKind.Function);
          item.detail = cand.signature;
          const md = new vscode.MarkdownString();
          md.isTrusted = true; // 只为了 command: 链接可点（内容全来自本地生成的 bwe-api.json）
          md.appendCodeblock(cand.signature, "javascript");
          if (cand.summary) md.appendMarkdown("\n\n" + cand.summary);
          if (cand.groupLabel) md.appendMarkdown(`\n\n分组：**${cand.groupLabel}**`);
          if (cand.link) md.appendMarkdown(`\n\n${docLinkMarkdown(cand)}`);
          item.documentation = md;
          item.sortText = padSort(cand);
          item.filterText = ctx.kind === "member" ? cand.label : cand.name;
          // `bwe.world.f|` 的已有前缀由 VS Code 自己处理（replace range 默认就是单词）；
          // 但 `bwe.` 之后补全需要把已输入的部分也替换掉（`bwe.wor` → 插入 `bwe.world.find`）
          if (ctx.kind === "member" && ctx.prefix.endsWith(".")) {
            item.insertText = cand.label;
          } else {
            item.insertText = cand.label;
          }
          items.push(item);
        }
        return items;
      })();
    },
  };
}

function padSort(cand) {
  const depth = cand.name.split(".").length;
  return `${depth}${cand.name}`;
}

// ============================================================================
// 悬浮提示
// ============================================================================

function hoverProvider() {
  return {
    provideHover(document, position) {
      return safe("hover", () => {
        const line = document.lineAt(position.line).text;
        const token = apiIndex.memberAtOffset(line, position.character);
        if (!token) return undefined;
        const name = apiIndex.resolveHoverName(token, line, position.character);
        if (!name) return undefined;
        const api = apiIndex.lookup(name);
        if (!api) return undefined;
        lastHoverApi = api;

        const md = new vscode.MarkdownString();
        md.isTrusted = true; // 文档链接用 command: 形式（仓库外的目录也能开）
        md.appendCodeblock(String(api.signature || api.name), "javascript");
        if (api.summary) md.appendMarkdown("\n\n" + api.summary);
        if (api.groupLabel) md.appendMarkdown(`\n\n分组：**${api.groupLabel}**`);
        if (api.typeOnly) {
          md.appendMarkdown(
            "\n\n_该成员只有类型声明（`bwe.d.ts`），`docs/api` 里没有速查条目；行为以 Java 实现为准。_"
          );
        }
        if (api.phase2) md.appendMarkdown("\n\n> ⚠ 契约占位（Phase 2）：调用不保证有行为。");
        if (api.link) md.appendMarkdown(`\n\n${docLinkMarkdown(api)}`);
        md.appendMarkdown(`\n\n<sub>BWE Script · 数据来源 data/bwe-api.json</sub>`);

        const start = Math.max(0, position.character - token.length);
        const range = new vscode.Range(
          new vscode.Position(position.line, start),
          new vscode.Position(position.line, start + token.length)
        );
        return new vscode.Hover(md, range);
      })();
    },
  };
}

function escapeMd(s) {
  return String(s || "").replace(/[\[\]()]/g, (c) => "\\" + c);
}

/**
 * 文档链接（hover / 补全里用）。
 *
 * 用 `command:bwe.openDocs` 而不是 `file://` URI：扩展可能装在仓库外，
 * 但 `bwe.openDocs` 会按当前光标解析，配合条目信息能打开正确的小节。
 * 文件找不到时退回纯文本路径，避免出现点不开的假链接。
 */
function docLinkMarkdown(api) {
  const label = escapeMd(String(api.link || "文档"));
  if (repoRoot()) {
    return `[${label}](command:bwe.openDocs) · <sub>BWE 打开对应小节</sub>`;
  }
  return `<sub>文档：${label}（工作区不在 BWE 仓库内，无法自动打开）</sub>`;
}

/**
 * `docs/api/world.md#anchor` → 文档绝对路径（找不到仓库根时返回 null）。
 * `bwe.openDocs` 与 hover 的「文档在此」都走它。
 */
function docAbsolutePath(link) {
  const rel = String(link || "").replace(/^docs\//, "");
  const root = repoRoot();
  if (!root || !rel) return null;
  const abs = path.join(root, "docs", rel.split("#")[0]);
  try {
    return fs.existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

// ============================================================================
// 签名帮助
// ============================================================================

function signatureProvider() {
  return {
    provideSignatureHelp(document, position) {
      return safe("signature", () => {
        const line = document.lineAt(position.line).text;
        const before = line.slice(0, position.character);
        const call = findOpenCall(before);
        if (!call) return undefined;
        const api = apiIndex.lookup(call.name);
        if (!api) return undefined;
        const sig = apiIndex.signatureForMember(call.name);
        if (!sig) return undefined;
        const activeParam = countCommas(call.paramsText);
        const info = new vscode.SignatureInformation(sig.signature, sig.documentation);
        info.parameters = sig.parameters.map((p) => new vscode.ParameterInformation(p, ""));
        const help = new vscode.SignatureHelp();
        help.signatures = [info];
        help.activeSignature = 0;
        help.activeParameter = Math.min(Math.max(0, activeParam), Math.max(0, sig.parameters.length - 1));
        return help;
      })();
    },
  };
}

/**
 * 从 `bwe.draw.text(16, ` 里取出 {name:"bwe.draw.text", paramsText:"16, "}。
 * 只取最内层未闭合的调用；找不到返回 null。
 */
function findOpenCall(before) {
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      // 找到调用：参数文本从 `(` 之后到光标
      const paramsText = before.slice(i + 1);
      let j = i - 1;
      while (j >= 0 && (before[j] === " " || before[j] === "\t")) j--;
      let end = j + 1;
      while (j >= 0 && /[A-Za-z0-9_$]/.test(before[j])) j--;
      const idEnd = end;
      let start = j + 1;
      // 往左拼接点号链：`bwe.world.find`
      while (j >= 0 && before[j] === ".") {
        j--;
        while (j >= 0 && /[A-Za-z0-9_$]/.test(before[j])) j--;
        start = j + 1;
      }
      const chain = before.slice(start, idEnd).replace(/^\.+/, "");
      if (!chain) return null;
      return { name: chain, paramsText };
    }
  }
  return null;
}

/** 数参数分隔逗号：`paramsText` 是 `(` 之后的部分，初始深度 1（最内层括号还没闭合）。 */
function countCommas(text) {
  let depth = 1;
  let n = 0;
  for (const ch of String(text || "")) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 1) n++;
  }
  return Math.max(0, n);
}

function countCommas(text) {
  // text 从调用参数的 `(` 之后开始：括号深度从 1 起算，只有回到 1 的逗号才是「换参数」
  let depth = 1;
  let n = 0;
  for (const ch of String(text || "")) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 1) n++;
  }
  return n;
}

// ============================================================================
// 命令：检查 / 安装类型 / 打开文档
// ============================================================================

async function commandCheckScript() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("BWE：先打开一个脚本文件。");
    return;
  }
  if (!isBweScript(editor.document)) {
    vscode.window.showInformationMessage("BWE：当前文件看起来不是 BWE 脚本（没有 bwe. / onStart 之类的特征）。");
  }
  // 强制重试服务端（清掉 down 缓存）
  serverStatus.state = "unknown";
  serverStatus.retryAt = 0;
  await runCheck(editor.document);
  const st = docStateFor(editor.document);
  if (statusItem) {
    statusItem.tooltip = st && st.serverReason ? `服务端不可用：${st.serverReason}` : "点击立刻重新检查当前脚本";
  }
  vscode.window.showInformationMessage(st ? st.lastText || "BWE 检查完成" : "BWE 检查完成");
}

/**
 * `bwe.installTypes`：
 *   1. 找仓库里的 `web/src/js/bwe.d.ts`（优先用扩展自带的 `data/bwe.d.ts` 副本，离线也能装）
 *   2. 复制到工作区 `.bwe/bwe.d.ts`
 *   3. 生成 / 合并 `jsconfig.json`（include 只含工作区的 js 文件与 `.bwe` 下的 d.ts，checkJs: true）
 *   4. 提示「已写入类型，重开文件即可获得补全」
 *
 * 为什么要自己复制而不是让用户手动改 tsconfig：
 *   `bwe.d.ts` 用 `declare namespace bwe`，把它 include 进来后 VS Code 的 tsserver 就能给
 *   普通 JS 文件提供 bwe.* 补全 —— 这是「不装扩展也能补全」的那条路，和本扩展的补全互不影响。
 * **不要复制 globals.d.ts**：它声明的是全局 `function onStart()`，会在用户写同名函数时
 * 报「Overload signatures must all be ambient」，反而制造错误。
 */
async function commandInstallTypes(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) {
    vscode.window.showWarningMessage("BWE：请先打开一个文件夹（工作区），再写入类型声明。");
    return;
  }
  const root = folder.uri.fsPath;
  const source = findDtsSource(context);
  if (!source) {
    vscode.window.showErrorMessage(
      "BWE：找不到 bwe.d.ts。确认这个工作区是 BrokenWonderEngine 仓库，或在扩展目录里跑一次 node web/tools/gen-vscode-api.mjs。"
    );
    return;
  }
  const targetDir = path.join(root, ".bwe");
  const target = path.join(targetDir, "bwe.d.ts");
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(source.path, "utf8"), "utf8");
  } catch (e) {
    vscode.window.showErrorMessage(`BWE：写入 ${target} 失败：${(e && e.message) || e}`);
    return;
  }

  const jsconfigPath = path.join(root, "jsconfig.json");
  try {
    writeJsconfig(jsconfigPath);
  } catch (e) {
    vscode.window.showWarningMessage(`BWE：类型已写入，但 jsconfig.json 更新失败：${(e && e.message) || e}`);
    return;
  }

  vscode.window.showInformationMessage("已写入类型，重开文件即可获得补全（.bwe/bwe.d.ts + jsconfig.json）。");
  const openIt = "打开 jsconfig.json";
  const picked = await vscode.window.showInformationMessage(
    `BWE：类型声明已写入 ${path.relative(root, target)}（来源：${source.label}）`,
    openIt
  );
  if (picked === openIt) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(jsconfigPath));
    await vscode.window.showTextDocument(doc);
  }
}

/**
 * 找 bwe.d.ts：优先扩展自带的 `data/bwe.d.ts`（vsix 安装时也有），
 * 其次仓库 `web/src/js/bwe.d.ts`（工作区就是仓库时）。
 */
function findDtsSource(context) {
  const candidates = [];
  const dataCopy = path.join(__dirname, "data", "bwe.d.ts");
  candidates.push({ path: dataCopy, label: "扩展内置 data/bwe.d.ts" });
  const root = repoRoot() || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath) || "";
  if (root) candidates.push({ path: path.join(root, "web", "src", "js", "bwe.d.ts"), label: "web/src/js/bwe.d.ts" });
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.path)) return c;
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/** 生成 / 合并 jsconfig.json。已有文件保留其它字段，只覆盖 include / compilerOptions.checkJs。 */
function writeJsconfig(jsconfigPath) {
  let existing = {};
  if (fs.existsSync(jsconfigPath)) {
    try {
      const text = fs.readFileSync(jsconfigPath, "utf8");
      // jsconfig.json 允许 JSONC（注释），这里做一次保守的「去行注释 + 去尾逗号」再 parse
      existing = JSON.parse(stripJsonc(text)) || {};
    } catch {
      existing = {};
    }
  }
  const next = Object.assign({}, existing);
  const compilerOptions = Object.assign({}, next.compilerOptions || {});
  compilerOptions.checkJs = true;
  compilerOptions.allowJs = true;
  compilerOptions.noEmit = true;
  compilerOptions.target = compilerOptions.target || "ES5";
  next.compilerOptions = compilerOptions;
  next.include = ["**/*.js", ".bwe/*.d.ts"];
  next.exclude = Array.isArray(next.exclude) && next.exclude.length ? next.exclude : ["node_modules", "**/node_modules/**"];
  fs.writeFileSync(jsconfigPath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      out += " ";
    } else if (c === '"' || c === "'") {
      const q = c;
      out += c;
      i++;
      while (i < text.length && text[i] !== q) {
        out += text[i] === "\\" ? text[i] + text[i + 1] : text[i];
        if (text[i] === "\\") i++;
        i++;
      }
      out += text[i] || "";
    } else {
      out += c;
    }
  }
  return out.replace(/,(?=\s*[}\]])/g, "");
}

/**
 * `bwe.openDocs`：打开当前 API 的文档。
 *   1. 若有 hover 命中的条目 → 用它；
 *   2. 否则取光标所在成员；
 *   3. 打开 docs/api/<page>.md，跳到具体小节。
 */
async function commandOpenDocs() {
  const editor = vscode.window.activeTextEditor;
  let api = lastHoverApi;
  if (editor) {
    const pos = editor.selection.active;
    const line = editor.document.lineAt(pos.line).text;
    const token = apiIndex.memberAtOffset(line, pos.character);
    if (token) {
      const name = apiIndex.resolveHoverName(token, line, pos.character);
      if (name) api = apiIndex.lookup(name) || api;
    }
  }
  if (!api) {
    vscode.window.showInformationMessage("BWE：光标不在一个 BWE API 成员上（先把光标放到 bwe.xxx 里）。");
    return;
  }
  const root = repoRoot();
  if (!root) {
    vscode.window.showWarningMessage("BWE：当前工作区不是 BrokenWonderEngine 仓库，找不到 docs/api。");
    return;
  }
  if (!api.link) {
    vscode.window.showInformationMessage(`BWE：${api.name} 没有对应文档条目（只有类型声明）。`);
    return;
  }
  const abs = docAbsolutePath(api.link);
  if (!abs) {
    vscode.window.showWarningMessage(`BWE：文档文件不存在（${api.link}）。先确认工作区是仓库根。`);
    return;
  }
  const rel = String(api.link).replace(/^docs\//, "");
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
  const shown = await vscode.window.showTextDocument(doc, { preview: true });
  // 定位到小节：文档标题 -> 行号
  const anchor = rel.includes("#") ? rel.split("#")[1] : "";
  if (anchor) {
    const lineIdx = findHeadingLine(doc, api);
    if (lineIdx >= 0) {
      const range = new vscode.Range(new vscode.Position(lineIdx, 0), new vscode.Position(lineIdx, 0));
      shown.revealRange(range, vscode.TextEditorRevealType.AtTop);
      shown.selection = new vscode.Selection(range.start, range.end);
    }
  }
}

/** 在文档里找 api 的标题行（按名字前缀匹配 `### bwe.world.find(` 这类标题）。 */
function findHeadingLine(doc, api) {
  const name = String(api.name || "");
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (!/^#{2,4}\s/.test(text)) continue;
    if (text.includes(name) || text.includes(name.replace(/^bwe\./, "bwe."))) return i;
  }
  // 退一步：按最后一段匹配（`### bwe.world.find` 与 `### find`）
  const tail = name.split(".").pop();
  if (!tail) return -1;
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (/^#{2,4}\s/.test(text) && text.includes(tail)) return i;
  }
  return -1;
}

// ============================================================================
// 仓库根探测（installTypes / openDocs / docs 链接共用）
// ============================================================================

let cachedRepoRoot = null;
let cachedRepoRootAt = 0;

/** 从当前工作区往上找 `web/src/js/bwe.d.ts` 或 `package.json` + `web/` 的目录。 */
function repoRoot() {
  const now = Date.now();
  if (cachedRepoRoot && now - cachedRepoRootAt < 5000) return cachedRepoRoot;
  cachedRepoRootAt = now;
  cachedRepoRoot = null;
  try {
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      const found = findRepoRootUpwards(folder.uri.fsPath);
      if (found) {
        cachedRepoRoot = found;
        return found;
      }
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

function findRepoRootUpwards(startPath) {
  let dir = startPath;
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(path.join(dir, "web", "src", "js", "bwe.d.ts"))) return dir;
    } catch {
      /* 忽略 */
    }
    const parent = path.dirname(dir);
    if (parent === dir || !parent) break;
    dir = parent;
  }
  return null;
}

// ============================================================================

module.exports = { activate, deactivate };
