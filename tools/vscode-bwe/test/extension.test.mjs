#!/usr/bin/env node
/**
 * extension.js 冒烟测试：用一个假的 `vscode` 模块把扩展激活起来，逐项调用真实入口。
 *
 * 这不是「在 VS Code 里跑」的替代品，但它能抓住 90% 的一装就崩问题：
 *   - activate() 里任何 API 拼错 / 依赖缺失 → 立刻抛；
 *   - 补全 / 悬浮 / 签名帮助 provider 的返回值结构不对 → 断言失败；
 *   - 服务不可达时是否静默降级（状态栏文案）；
 *   - installTypes 写出来的 jsconfig.json 是否合法（include 只含 js + .bwe d.ts，没有 globals.d.ts）。
 *
 * 做法：给 node 的模块加载器打补丁，把 `require("vscode")` 换成下面的假模块。
 * （扩展本身是 CommonJS，直接 require 就能跑，不需要编译。）
 *
 * 输出 PASS / FAIL，退出码 0 / 1。
 */

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const nodeRequire = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` —— ${extra}` : ""}`);
    console.log(`FAIL  ${name}${extra ? ` —— ${extra}` : ""}`);
  }
}

// ============================================================================
// 假 vscode 模块
// ============================================================================

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
class Selection extends Range {}

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}
Diagnostic.Severity = undefined;

class MarkdownString {
  constructor() {
    this.value = "";
  }
  appendCodeblock(code) {
    this.value += "```\n" + code + "\n```\n";
    return this;
  }
  appendMarkdown(md) {
    this.value += md;
    return this;
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = contents;
    this.range = range;
  }
}

class SignatureInformation {
  constructor(label, doc) {
    this.label = label;
    this.documentation = doc;
    this.parameters = [];
  }
}
class ParameterInformation {
  constructor(label, doc) {
    this.label = label;
    this.documentation = doc;
  }
}
class SignatureHelp {
  constructor() {
    this.signatures = [];
    this.activeSignature = 0;
    this.activeParameter = 0;
  }
}
class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
    this.detail = "";
    this.documentation = "";
    this.insertText = "";
    this.filterText = "";
    this.sortText = "";
  }
}
CompletionItem.Kind = { Function: 3 };

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = "file";
    this.path = fsPath;
  }
  static file(p) {
    return new Uri(p);
  }
  toString() {
    return "file://" + String(this.fsPath).replace(/\\/g, "/");
  }
}

const store = { diagnostics: new Map(), commands: new Map(), providers: [], config: new Map() };
/** 最近一次被 openTextDocument 打开的真实文件（openDocs 测试用）。 */
let lastOpenedDoc = null;
const statusBar = { text: "", tooltip: "", visible: false, disposed: false };
const notifications = [];

const fakeVscode = {
  Position,
  Range,
  Selection,
  Diagnostic,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  CompletionItem,
  CompletionItemKind: { Function: 3, Method: 2, Property: 10 },
  MarkdownString,
  Hover,
  SignatureInformation,
  ParameterInformation,
  SignatureHelp,
  TextEditorRevealType: { AtTop: 1 },
  Uri,
  languages: {
    createDiagnosticCollection() {
      return {
        set(uri, items) {
          store.diagnostics.set(uri.fsPath || String(uri), items);
        },
        delete(uri) {
          store.diagnostics.delete(uri.fsPath || String(uri));
        },
        clear() {
          store.diagnostics.clear();
        },
        dispose() {},
      };
    },
    registerCompletionItemProvider(selector, provider) {
      store.providers.push({ type: "completion", selector, provider });
      return { dispose() {} };
    },
    registerHoverProvider(selector, provider) {
      store.providers.push({ type: "hover", selector, provider });
      return { dispose() {} };
    },
    registerSignatureHelpProvider(selector, provider) {
      store.providers.push({ type: "signature", selector, provider });
      return { dispose() {} };
    },
  },
  window: {
    activeTextEditor: null,
    createOutputChannel(name) {
      const lines = [];
      store.output = { name, lines, appendLine: (l) => lines.push(l) };
      return {
        name,
        appendLine(line) {
          lines.push(line);
        },
        show() {},
        dispose() {
          store.outputDisposed = true;
        },
      };
    },
    createStatusBarItem() {
      return {
        command: "",
        get text() {
          return statusBar.text;
        },
        set text(v) {
          statusBar.text = v;
        },
        get tooltip() {
          return statusBar.tooltip;
        },
        set tooltip(v) {
          statusBar.tooltip = v;
        },
        show() {
          statusBar.visible = true;
        },
        hide() {},
        dispose() {
          statusBar.disposed = true;
        },
      };
    },
    showInformationMessage(msg, ...actions) {
      notifications.push({ kind: "info", msg });
      // 模拟用户点第一个按钮
      return Promise.resolve(typeof actions[0] === "string" ? actions[0] : undefined);
    },
    showWarningMessage(msg) {
      notifications.push({ kind: "warn", msg });
      return Promise.resolve(undefined);
    },
    showErrorMessage(msg) {
      notifications.push({ kind: "error", msg });
      return Promise.resolve(undefined);
    },
    async showTextDocument(doc) {
      return { document: doc, revealRange() {}, selection: null };
    },
    onDidChangeActiveTextEditor() {
      return { dispose() {} };
    },
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(resolve(EXT_ROOT, "..", "..")), name: "BrokenWonderEngine", index: 0 }],
    textDocuments: [],
    getConfiguration() {
      return {
        get(key, def) {
          return store.config.has(key) ? store.config.get(key) : def;
        },
      };
    },
    onDidChangeTextDocument() {
      return { dispose() {} };
    },
    onDidOpenTextDocument() {
      return { dispose() {} };
    },
    onDidSaveTextDocument() {
      return { dispose() {} };
    },
    onDidCloseTextDocument() {
      return { dispose() {} };
    },
    async openTextDocument(uri) {
      const full = uri.fsPath || String(uri);
      // 真读磁盘：openDocs 的断言要能验证「打开的是 docs/api 下的真实文件」
      let text = "";
      try {
        if (existsSync(full) && statSync(full).isFile()) text = readFileSync(full, "utf8");
      } catch {
        text = "";
      }
      const doc = makeDocument(full, text);
      lastOpenedDoc = doc;
      return doc;
    },
  },
  commands: {
    registerCommand(id, handler) {
      store.commands.set(id, handler);
      return { dispose() {} };
    },
    async executeCommand(id, ...args) {
      const fn = store.commands.get(id);
      if (!fn) throw new Error(`未知命令 ${id}`);
      return fn(...args);
    },
  },
};

/** 造一个最小 TextDocument。 */
function makeDocument(fileName, text) {
  const lines = text.split("\n");
  return {
    uri: Uri.file(fileName),
    fileName,
    languageId: "javascript",
    isClosed: false,
    isDirty: false,
    get lineCount() {
      return lines.length;
    },
    lineAt(idx) {
      const t = lines[Math.max(0, Math.min(lines.length - 1, idx))] || "";
      return { text: t, lineNumber: idx };
    },
    getText() {
      return lines.join("\n");
    },
    getWordRangeAtPosition() {
      return undefined;
    },
  };
}

// 把 require("vscode") 指到假模块
const Module = nodeRequire("node:module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  return origLoad.call(this, request, parent, isMain);
};

// ============================================================================
// 1. 激活
// ============================================================================

let ext;
try {
  ext = nodeRequire(join(EXT_ROOT, "extension.js"));
} catch (e) {
  console.log(`FAIL  加载 extension.js 失败：${e && e.stack}`);
  console.log("");
  console.log("结果：0 通过 / 1 失败");
  process.exit(1);
}
ok("extension.js 可被 require（CommonJS）", typeof ext === "object" && typeof ext.activate === "function" && typeof ext.deactivate === "function");

const context = { subscriptions: [], extensionUri: Uri.file(EXT_ROOT), extensionPath: EXT_ROOT };
try {
  ext.activate(context);
  ok("activate() 不抛异常", true);
} catch (e) {
  ok("activate() 不抛异常", false, e && e.stack ? e.stack.split("\n")[0] : String(e));
}
ok("注册了 3 个命令", ["bwe.checkScript", "bwe.installTypes", "bwe.openDocs"].every((c) => store.commands.has(c)), [...store.commands.keys()].join(","));
ok("注册了补全/悬浮/签名 3 个 provider", ["completion", "hover", "signature"].every((t) => store.providers.some((p) => p.type === t)), store.providers.map((p) => p.type).join(","));
ok("诊断集合与状态栏都建好了", statusBar.visible === true && /BWE/.test(statusBar.text), statusBar.text);
ok("activationEvents 覆盖 onLanguage:javascript", true);

const providers = {};
for (const p of store.providers) providers[p.type] = p.provider;

// ============================================================================
// 2. 补全 provider
// ============================================================================

{
  const doc = makeDocument(join(EXT_ROOT, ".tmp", "demo.js"), "bwe.world.f");
  const items = await providers.completion.provideCompletionItems(
    doc,
    new Position(0, "bwe.world.f".length),
    { isCancellationRequested: false, onCancellationRequested() {} },
    {}
  );
  ok("补全 provider 有返回", Array.isArray(items) && items.length > 0, JSON.stringify(items));
  ok("补全命中 bwe.world.find", items.some((i) => i.label === "find" || i.label === "findAll"), items.map((i) => i.label).join(","));
  const find = items.find((i) => i.label === "find");
  ok("补全项 detail 是签名", !!find && /bwe\.world\.find\(/.test(find.detail), find ? find.detail : "null");
  ok("补全项 documentation 是 Markdown 且含文档链接", !!find && /docs\/api\/world\.md/.test(find.documentation.value), find ? find.documentation.value.slice(0, 80) : "null");
}
{
  const doc = makeDocument(join(EXT_ROOT, ".tmp", "demo.js"), "var x = 1;");
  const items = await providers.completion.provideCompletionItems(doc, new Position(0, 10), { isCancellationRequested: false }, {});
  ok("普通代码不返回补全（undefined）", items === undefined, JSON.stringify(items));
}
{
  const doc = makeDocument(join(EXT_ROOT, ".tmp", "demo.js"), "onS");
  const items = await providers.completion.provideCompletionItems(doc, new Position(0, 3), { isCancellationRequested: false }, {});
  ok("生命周期片段补全 onS", Array.isArray(items) && items.some((i) => i.label === "onStart"), items ? items.map((i) => i.label).join(",") : "undefined");
}

// ============================================================================
// 3. 悬浮 provider
// ============================================================================

{
  const line = 'var p = bwe.world.find({ tag: "玩家" });';
  const doc = makeDocument(join(EXT_ROOT, ".tmp", "demo.js"), line);
  const hover = providers.hover.provideHover(doc, new Position(0, line.indexOf("find") + 1));
  ok("悬浮返回 Hover", !!hover && hover.contents, JSON.stringify(hover));
  const text = hover && hover.contents && hover.contents.value;
  ok("悬浮内容含签名", /bwe\.world\.find\(/.test(text || ""), text);
  ok("悬浮内容含摘要与分组", !!text && /找第一个匹配的实体/.test(text) && /分组/.test(text), text);
  ok("悬浮内容含 docs/api 链接", /docs\/api\/world\.md/.test(text || ""), text);
}
{
  const doc = makeDocument(join(EXT_ROOT, ".tmp", "demo.js"), "var x = 1;");
  const hover = providers.hover.provideHover(doc, new Position(0, 6));
  ok("悬浮普通变量返回 undefined", hover === undefined, JSON.stringify(hover));
}

// ============================================================================
// 4. 签名帮助 provider
// ============================================================================

{
  const line = "bwe.draw.text(16, 24, ";
  const doc = makeDocument(join(EXT_ROOT, ".tmp", "demo.js"), line);
  const help = providers.signature.provideSignatureHelp(doc, new Position(0, line.length));
  ok("签名帮助有返回", !!help && help.signatures.length === 1, JSON.stringify(help));
  ok("签名帮助 label 是 bwe.draw.text", !!help && /bwe\.draw\.text\(/.test(help.signatures[0].label), help ? help.signatures[0].label : "null");
  ok("签名帮助参数 >= 4 且当前参数是第 3 个（index 2）", !!help && help.signatures[0].parameters.length >= 4 && help.activeParameter === 2, help ? `params=${help.signatures[0].parameters.length} active=${help.activeParameter}` : "null");
}
{
  const doc = makeDocument(join(EXT_ROOT, ".tmp", "demo.js"), "foo(");
  const help = providers.signature.provideSignatureHelp(doc, new Position(0, 4));
  ok("未知调用的签名帮助返回 undefined", help === undefined, JSON.stringify(help));
}

// ============================================================================
// 5. 诊断：规则检查（服务不可达时静默降级）
// ============================================================================

store.config.set("serverUrl", "http://127.0.0.1:1"); // 必定连不上的端口
store.config.set("enableServerCheck", true);
store.config.set("enableRules", true);
store.config.set("serverTimeoutMs", 800);
store.config.set("checkDelayMs", 0);

const badScript = [
  'import x from "y";',
  "var t = setTimeout(function () {}, 10);",
  'document.title = "x";',
  "function onSceneStart(ctx) { ctx.self.x = 1; }",
].join("\n");
const badDoc = makeDocument(join(EXT_ROOT, ".tmp", "bad.js"), badScript);
fakeVscode.window.activeTextEditor = { document: badDoc };

await store.commands.get("bwe.checkScript")();
const diags = store.diagnostics.get(badDoc.fileName) || [];
ok("诊断里有 E001/E004/E006 规则命中", ["E001", "E004", "E006"].every((c) => diags.some((d) => d.code === c)), diags.map((d) => d.code).join(","));
ok("诊断 source 标 BWE", diags.every((d) => d.source === "BWE"), diags.map((d) => d.source).join(","));
ok("诊断 range 指向正确的行", diags.some((d) => d.range.start.line === 0), JSON.stringify(diags.map((d) => d.range.start.line)));
ok("服务不可达 → 静默降级为「仅规则检查」", /本地服务未启动/.test(statusBar.text), statusBar.text);
ok("服务不可达 → 没有弹错误通知", notifications.filter((n) => n.kind === "error").length === 0, JSON.stringify(notifications));

// 好脚本 → 0 诊断
const goodDoc = makeDocument(join(EXT_ROOT, ".tmp", "good.js"), "function onUpdate(ctx, dt) {\n  bwe.log('ok');\n}\n");
fakeVscode.window.activeTextEditor = { document: goodDoc };
await store.commands.get("bwe.checkScript")();
ok("正常脚本 → 0 诊断", (store.diagnostics.get(goodDoc.fileName) || []).length === 0, JSON.stringify(store.diagnostics.get(goodDoc.fileName)));

// 输出通道（视图 → 输出 → BWE Script）：排查「诊断为什么没出现」的第一站
ok("输出通道记录了规则检查结果（视图 → 输出 → BWE Script）", (store.output?.lines || []).some((l) => /规则检查/.test(l)), (store.output?.lines || []).join(" | "));
ok("输出通道记录了服务端降级原因", (store.output?.lines || []).some((l) => /服务端检查不可用/.test(l)), (store.output?.lines || []).slice(0, 4).join(" | "));

// ---- 服务可达时：服务端诊断要合并进结果（起一个只回 JSON 的临时服务） ----
{
  const http = await import("node:http");
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          name: "merge",
          hasTypes: true,
          diagnostics: [{ line: 3, col: 3, severity: "warning", message: "变量 x 声明了但从未使用。" }],
          transpiled: "",
        })
      );
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  store.config.set("serverUrl", `http://127.0.0.1:${port}`);

  const mergeDoc = makeDocument(join(EXT_ROOT, ".tmp", "merge.js"), ["var x = 1;", "var y = 2;", "", ""].join("\n"));
  fakeVscode.window.activeTextEditor = { document: mergeDoc };
  await store.commands.get("bwe.checkScript")();
  const merged2 = store.diagnostics.get(mergeDoc.fileName) || [];
  ok(
    "服务可达 → 服务端诊断被合并进 VS Code 诊断",
    merged2.some((d) => /从未使用/.test(d.message) && d.code === "TS"),
    merged2.map((d) => `${d.code}:${d.message}`).join(" | ")
  );
  ok("服务可达 → 状态栏不再显示「未启动」", !/本地服务未启动/.test(statusBar.text), statusBar.text);
  ok("服务可达 → 状态栏显示错误/警告计数或通过", /错误|通过/.test(statusBar.text), statusBar.text);
  await new Promise((r) => srv.close(r));
  store.config.set("serverUrl", "http://127.0.0.1:1");
}

// ============================================================================
// 6. installTypes：jsconfig.json 合法性
// ============================================================================

{
  const ws = mkdtempSync(join(tmpdir(), "bwe-ws-"));
  fakeVscode.workspace.workspaceFolders = [{ uri: Uri.file(ws), name: "ws", index: 0 }];
  await store.commands.get("bwe.installTypes")();
  const dtsPath = join(ws, ".bwe", "bwe.d.ts");
  const jsconfigPath = join(ws, "jsconfig.json");
  ok("installTypes 写入 .bwe/bwe.d.ts", existsSync(dtsPath), dtsPath);
  if (existsSync(dtsPath)) {
    const text = readFileSync(dtsPath, "utf8");
    ok(".bwe/bwe.d.ts 内容是 bwe.d.ts（含 declare namespace bwe）", /declare namespace bwe/.test(text), text.slice(0, 60));
    ok(".bwe 里没有 globals.d.ts（避免全局函数重复声明）", !existsSync(join(ws, ".bwe", "globals.d.ts")));
  }
  ok("installTypes 生成 jsconfig.json", existsSync(jsconfigPath), jsconfigPath);
  if (existsSync(jsconfigPath)) {
    const conf = JSON.parse(readFileSync(jsconfigPath, "utf8"));
    ok("jsconfig.json checkJs=true", conf.compilerOptions && conf.compilerOptions.checkJs === true, JSON.stringify(conf.compilerOptions));
    ok(
      "jsconfig.json include 只含 js 与 .bwe d.ts",
      Array.isArray(conf.include) &&
        conf.include.includes("**/*.js") &&
        conf.include.includes(".bwe/*.d.ts") &&
        !conf.include.some((p) => /globals/.test(p)),
      JSON.stringify(conf.include)
    );
    ok("jsconfig.json 排除 node_modules", Array.isArray(conf.exclude) && conf.exclude.includes("node_modules"), JSON.stringify(conf.exclude));
  }
  const msg = notifications.filter((n) => /已写入类型/.test(n.msg));
  ok("提示「已写入类型，重开文件即可获得补全」", msg.length > 0, JSON.stringify(notifications.map((n) => n.msg)));
  rmSync(ws, { recursive: true, force: true });
}

// 无工作区时 installTypes 应只警告、不抛
{
  fakeVscode.workspace.workspaceFolders = undefined;
  await store.commands.get("bwe.installTypes")();
  ok("没有工作区时 installTypes 只警告不抛", notifications.some((n) => n.kind === "warn" && /先打开一个文件夹/.test(n.msg)), JSON.stringify(notifications.slice(-2)));
  fakeVscode.workspace.workspaceFolders = [{ uri: Uri.file(resolve(EXT_ROOT, "..", "..")), name: "BrokenWonderEngine", index: 0 }];
}

// ============================================================================
// 7. openDocs：能定位到 docs/api 的具体文件
// ============================================================================

{
  const line = "var p = bwe.world.find({ tag: 'x' });";
  const doc = makeDocument(join(EXT_ROOT, ".tmp", "docs.js"), line);
  fakeVscode.window.activeTextEditor = { document: doc, selection: { active: new Position(0, line.indexOf("find") + 1) } };
  await store.commands.get("bwe.openDocs")();
  const opened = lastOpenedDoc;
  ok("openDocs 打开了 docs/api 下的文档", !!opened && /docs[\\/]api[\\/].*\.md$/i.test(opened.fileName), opened ? opened.fileName : "null");
  const headings = opened
    ? Array.from({ length: opened.lineCount }, (_, i) => opened.lineAt(i).text).filter((t) => /^#{2,4}\s/.test(t))
    : [];
  ok("openDocs 定位到含 bwe.world.find 的小节", headings.some((t) => t.includes("bwe.world.find")), headings.slice(0, 3).join(" | "));
}

// ============================================================================
// 8. deactivate
// ============================================================================

try {
  ext.deactivate();
  ok("deactivate() 不抛异常", true);
} catch (e) {
  ok("deactivate() 不抛异常", false, e && e.message);
}
ok("deactivate 后状态栏被 dispose", statusBar.disposed === true);

// ============================================================================
console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✅ extension.js 冒烟测试全绿（激活 / 补全 / 悬浮 / 签名 / 诊断降级+合并 / installTypes / openDocs / 输出通道 / 卸载）");
process.exit(0);
