/**
 * 剧本面板：Yarn Spinner 剧本 + JS 脚本，两种语言共存。
 *
 * 为什么放在同一个面板：它们在用户脑子里都是「剧本」，只是用途不同 ——
 * Yarn 走对话系统（「打开对话框」模块读它），JS 走对象/场景脚本（「对象脚本」模块、onStartScript）。
 * 分成两个页签会让用户找不到「我刚才在 JS 里写的那个东西去哪了」。
 *
 * JS 模式的三件套（对应 docs/scripting-api.md §5）：
 *   源码编辑   —— 行号栏 + 等宽字体 + Tab 缩进 + Ctrl+S
 *   检查       —— 优先 /api/js-check（TypeScript 诊断），服务端没就绪时用 new Function 兜底
 *   API 速查   —— 可搜索，数据来自 web/src/data/apiDocs.ts，点一下插到光标处
 *
 * 编辑即时生效（防抖），不需要"保存"按钮；Ctrl+S 直接保存整个工程。
 */

import { el, input, button, segmented } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { ok, warn } from "../ui/toast.ts";
import { store } from "../core/store.ts";
import {
  defaultScriptFile,
  scriptLang,
  scriptNamesOfLang,
  type ScriptEntry,
  type ScriptLang
} from "../core/model.ts";
import { API_DOCS, apiDocsByGroup, searchApiDocs, type ApiDoc } from "../data/apiDocs.ts";

// ============================================================================
// 「用 VS Code 打开」：脚本存在 .bwproj 里，服务端把它镜像成真实文件再拉起编辑器
// ============================================================================

interface MirrorInfo {
  file: string;
  mtimeMs: number;
  content?: string;
}

/** 每个脚本最近一次的镜像信息，用来判断「VS Code 里改过没有」。 */
const mirrorInfo = new Map<string, MirrorInfo>();
let mirrorPoll: number | null = null;

function stopMirrorPoll(): void {
  if (mirrorPoll !== null) {
    window.clearInterval(mirrorPoll);
    mirrorPoll = null;
  }
}

function projectScope(): string {
  return store.project?.name ?? "";
}

async function postOpenInVscode(name: string, source: string, lang: ScriptLang, line = 1): Promise<void> {
  let payload: { ok?: boolean; file?: string; error?: string; hint?: string };
  try {
    const resp = await fetch("/api/open-in-vscode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, source, lang, line, project: projectScope() })
    });
    payload = (await resp.json()) as typeof payload;
  } catch {
    warn("需要本地服务：先运行 npm run serve，再点「VS Code 打开」");
    return;
  }
  if (payload.ok && payload.file) {
    ok(`已用 VS Code 打开：${payload.file.split(/[\\/]/).slice(-2).join("/")}`);
    // 记录基线 mtime（这次是脚本写进文件的时刻），之后 mtime 变了就说明 VS Code 里改过
    const mirror = await fetchMirror(name, lang);
    if (mirror) mirrorInfo.set(`${lang}:${name}`, mirror);
    return;
  }
  if (payload.file && payload.error) {
    // 找不到 code 命令：文件已经写好了，给出可执行的下一步，而不是只说失败
    warn(`${payload.error}`);
    return;
  }
  warn(payload.error || "打开 VS Code 失败");
}

async function fetchMirror(name: string, lang: ScriptLang): Promise<MirrorInfo | null> {
  try {
    const resp = await fetch(
      `/api/script-file?name=${encodeURIComponent(name)}&lang=${lang}` +
        `&project=${encodeURIComponent(projectScope())}`,
      { cache: "no-store" }
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { file?: string; mtimeMs?: number; content?: string };
    if (!data.file || typeof data.mtimeMs !== "number") return null;
    return { file: data.file, mtimeMs: data.mtimeMs, content: data.content };
  } catch {
    return null;
  }
}


interface YarnNode {
  title: string;
  startLine: number;
  endLine: number;
  choices: string[];
  jumps: string[];
  varsSet: string[];
  speakers: string[];
}

interface YarnCheck {
  line: number;
  message: string;
  error: boolean;
}

/** 一条诊断（服务器与本地兜底共用同一个形状）。 */
interface Diag {
  line: number;
  col?: number;
  severity: "error" | "warn" | "info";
  message: string;
}

/** 当前选中的脚本名与语言（模块级状态：面板切换/重渲染后还停在同一段脚本上）。 */
let currentScript = "";
let currentLang: ScriptLang = "yarn";

/** /api/js-check 可用性。unknown=还没试过；down=不可用（隔一段时间再试，避免每敲一个字都打一次请求）。 */
let serverCheck: "unknown" | "ok" | "down" = "unknown";
let serverRetryAt = 0;
const SERVER_RETRY_MS = 20000;

/** API 速查是否展开。 */
let apiOpen = true;

// ============================================================================
// 面板入口
// ============================================================================

export function renderScriptPanel(host: HTMLElement): void {
  host.replaceChildren();
  // 每次重渲染都重建 VS Code 轮询，避免旧面板的 interval 越积越多
  stopMirrorPoll();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";

  // ---- 头部：标题 + 新建 ----
  const head = el("div", { class: "row" });
  head.appendChild(el("div", { class: "group-label" }, "剧本 Scripts"));
  head.appendChild(el("div", { class: "spacer" }));
  head.appendChild(button("新建", () => newScript(currentLang), { size: "sm", variant: "primary", iconPath: I.plus }));
  wrap.appendChild(head);

  if (!store.project) {
    wrap.appendChild(el("div", { class: "hint" }, "还没有打开工程"));
    host.appendChild(wrap);
    return;
  }

  // ---- 语言切换：JS / Yarn ----
  const langSwitch = segmented<ScriptLang>(
    [
      { value: "js", label: "JS 脚本", hint: "用 bwe API 写逻辑：挂到对象的「对象脚本」模块，或设为场景脚本" },
      { value: "yarn", label: "Yarn 剧本", hint: "Yarn Spinner 对话文本：给「打开对话框」模块用" }
    ],
    currentLang,
    (v) => {
      if (v === currentLang) return;
      currentLang = v;
      currentScript = scriptNamesOfLang(store.project, v)[0] ?? "";
      renderScriptPanel(host);
    }
  );
  wrap.appendChild(langSwitch);

  wrap.appendChild(
    el(
      "div",
      { class: "hint js-lang-hint" },
      currentLang === "js"
        ? "JS 脚本由 bwe API 驱动：挂到对象的「对象脚本」模块上，或设为场景脚本（onSceneStart）运行。"
        : "Yarn 剧本走对话系统：给对象的「打开对话框」模块选择剧本即可，可直接与社区工具互通。"
    )
  );

  // ---- 脚本列表（只列当前语言的）----
  const names = scriptNamesOfLang(store.project, currentLang);
  if (!names.length) {
    const other: ScriptLang = currentLang === "js" ? "yarn" : "js";
    const otherNames = scriptNamesOfLang(store.project, other);
    const empty = el("div", { class: "empty" });
    empty.appendChild(el("div", { class: "t" }, currentLang === "js" ? "还没有 JS 脚本" : "还没有剧本"));
    empty.appendChild(
      el(
        "div",
        { class: "d" },
        currentLang === "js"
          ? "点下面的按钮，会给你一段带注释的 JS 示例：WASD 移动 + 点击反馈，照着改就行。"
          : "点下面的按钮，会给你一段能直接跑的 Yarn 示例剧本，照着改就行。"
      )
    );
    empty.appendChild(
      button(currentLang === "js" ? "新建 JS 脚本" : "新建剧本", () => newScript(currentLang), {
        variant: "primary",
        size: "sm"
      })
    );
    wrap.appendChild(empty);
    if (otherNames.length) {
      wrap.appendChild(
        button(
          `切到${other === "js" ? "JS 脚本" : "Yarn 剧本"}（${otherNames.length} 个）`,
          () => {
            currentLang = other;
            currentScript = otherNames[0];
            renderScriptPanel(host);
          },
          { size: "sm", variant: "ghost" }
        )
      );
    }
    host.appendChild(wrap);
    return;
  }

  if (!names.includes(currentScript)) currentScript = names[0];

  const list = el("div", { class: "item-list" });
  for (const n of names) {
    const s = store.project.scripts[n];
    const item = el("div", { class: "item" + (n === currentScript ? " selected" : "") });
    const dot = el("span", { class: "dot" });
    dot.style.background = n === currentScript ? "var(--accent)" : "var(--line)";
    item.appendChild(dot);
    const grow = el("div", { class: "grow" });
    grow.appendChild(el("div", { class: "name" }, n));
    const src = s?.source ?? "";
    const lines = src ? src.split("\n").length : 0;
    const sub = currentLang === "js"
      ? `${lines} 行 · ${(s?.file ?? "").split("/").pop() || "未命名.js"}`
      : `${(src.match(/^\s*title\s*:/gm) ?? []).length} 个节点 · ${lines} 行`;
    grow.appendChild(el("div", { class: "sub" }, sub));
    item.appendChild(grow);
    item.addEventListener("click", () => {
      currentScript = n;
      renderScriptPanel(host);
    });
    list.appendChild(item);
  }
  wrap.appendChild(list);

  const script = store.project.scripts[currentScript];
  if (!script) {
    host.appendChild(wrap);
    return;
  }

  if (currentLang === "js") renderJsEditor(wrap, script, () => renderScriptPanel(host));
  else renderYarnEditor(wrap, script, () => renderScriptPanel(host));

  host.appendChild(wrap);
}

// ============================================================================
// VS Code 工具条（JS / Yarn 共用）
// ============================================================================

/**
 * 「VS Code 打开」+「载入 VS Code 改动」。
 *
 * 脚本存在 .bwproj 里，所以服务端会把它镜像成 web/.build/scripts/<名字>.js；
 * 这里轮询镜像文件的 mtime，VS Code 里保存后就能一键取回（不自动覆盖，避免吞掉编辑器里正在敲的内容）。
 */
function renderVsCodeBar(
  wrap: HTMLElement,
  name: string,
  lang: ScriptLang,
  currentText: () => string,
  applyIncoming: (text: string) => void
): void {
  const bar = el("div", { class: "row" });
  bar.style.margin = "4px 0 8px";
  bar.appendChild(
    button("VS Code 打开", () => void postOpenInVscode(name, currentText(), lang), {
      size: "sm",
      variant: "outline",
      iconPath: I.open,
      title: "把脚本写到 web/.build/scripts/ 并用本机 VS Code 打开（需要 npm run serve）"
    })
  );

  const status = el("span", { class: "hint" }, "");
  status.style.marginLeft = "10px";
  bar.appendChild(status);

  bar.appendChild(el("div", { class: "spacer" }));

  let pending: string | null = null;
  const pull = button("载入 VS Code 改动", () => {
    const text = pending;
    if (text == null) return;
    pending = null;
    pull.style.display = "none";
    status.textContent = "";
    applyIncoming(text);
    ok("已载入 VS Code 里的改动");
  }, { size: "sm", variant: "primary" });
  pull.style.display = "none";
  bar.appendChild(pull);

  wrap.appendChild(bar);

  const key = `${lang}:${name}`;
  let baseline = mirrorInfo.get(key)?.mtimeMs ?? 0;

  const tick = async (): Promise<void> => {
    const mirror = await fetchMirror(name, lang);
    if (!mirror) return;
    if (baseline === 0) {
      baseline = mirror.mtimeMs;
      return;
    }
    if (mirror.mtimeMs <= baseline) return;
    baseline = mirror.mtimeMs;
    // 文件变了：只有内容和编辑器里不一样才提示，避免自己刚写过就弹「载入」
    if (typeof mirror.content !== "string") return;
    if (mirror.content.replace(/\r\n/g, "\n") === currentText().replace(/\r\n/g, "\n")) {
      status.textContent = "";
      return;
    }
    pending = mirror.content;
    status.textContent = "VS Code 里的文件已更新";
    pull.style.display = "";
  };

  mirrorPoll = window.setInterval(() => void tick(), 2000);
}

// ============================================================================
// JS 模式
// ============================================================================

function renderJsEditor(wrap: HTMLElement, script: ScriptEntry, rerender: () => void): void {
  void rerender; // JS 模式取回改动直接改 textarea，不需要整面板重渲染
  const edHead = el("div", { class: "row" });
  edHead.appendChild(el("div", { class: "group-label" }, "源码 JavaScript"));
  edHead.appendChild(el("div", { class: "spacer" }));
  edHead.appendChild(el("span", { class: "hint" }, "Tab 缩进 · Ctrl+S 保存"));
  wrap.appendChild(edHead);

  const bench = el("div", { class: "js-workbench" });
  const main = el("div", { class: "js-main" });

  // ---- 带行号栏的编辑器 ----
  const codeBox = el("div", { class: "js-code" });
  const gutter = el("div", { class: "js-gutter", title: "行号" });
  const gutterInner = el("div", { class: "js-gutter-inner" }, "1");
  gutter.appendChild(gutterInner);

  const ta = el("textarea", {
    class: "js-source",
    spellcheck: "false",
    wrap: "off",
    autocomplete: "off",
    autocapitalize: "off"
  });
  ta.value = script.source;
  // 未聚焦时不伪造"光标在第 N 行"：textarea 赋 value 后 selectionStart 默认是末尾，
  // 状态栏会显示成最后一行，看着像光标真的跑过去了。置零后重新渲染就是「第 1 行」。
  ta.setSelectionRange(0, 0);
  codeBox.appendChild(gutter);
  codeBox.appendChild(ta);
  main.appendChild(codeBox);

  // 行高：行号栏与正文必须用同一个值，否则行号会逐行偏移（样式表里两者显式写成一样）
  const lineHeight = (): number => {
    const lh = parseFloat(getComputedStyle(ta).lineHeight);
    return Number.isFinite(lh) && lh > 0 ? lh : 20;
  };

  let gutterCount = -1;
  const refreshGutter = (): void => {
    const n = ta.value.split("\n").length;
    if (n === gutterCount) return;
    gutterCount = n;
    gutterInner.textContent = Array.from({ length: n }, (_, i) => String(i + 1)).join("\n");
    gutter.style.minWidth = `${Math.max(2, String(n).length) + 1.4}ch`;
  };
  const syncScroll = (): void => {
    gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
  };

  // 光标位置与规模
  const stats = el("div", { class: "hint js-stats" });
  const updateStats = (): void => {
    const v = ta.value;
    const pos = ta.selectionStart;
    const before = v.slice(0, pos);
    const line = (before.match(/\n/g) ?? []).length + 1;
    const col = pos - before.lastIndexOf("\n");
    stats.textContent = `第 ${line} 行 第 ${col} 列　·　${v.split("\n").length} 行　·　${v.length} 字符`;
  };

  const afterEdit = (): void => {
    script.source = ta.value;
    store.markDirty();
    refreshGutter();
    syncScroll();
    updateStats();
    scheduleCheck();
  };

  ta.addEventListener("input", afterEdit);
  ta.addEventListener("scroll", syncScroll);
  ta.addEventListener("click", updateStats);
  ta.addEventListener("keyup", updateStats);
  ta.addEventListener("select", updateStats);

  // VS Code 工具条：打开镜像文件 / 从镜像文件取回改动
  renderVsCodeBar(
    wrap,
    script.name || currentScript,
    "js",
    () => ta.value,
    (text) => {
      ta.value = text;
      script.source = text;
      store.markDirty();
      refreshGutter();
      syncScroll();
      updateStats();
      scheduleCheck();
    }
  );

  ta.addEventListener("keydown", (e) => {
    // Ctrl/Cmd+S：保存整个工程（全局快捷键对 textarea 是放行的，这里必须自己接住）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("bwe:save"));
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) unindentSelection(ta);
      else indentSelection(ta);
      afterEdit();
      return;
    }
    // 回车自动保持当前行缩进（`{` 结尾再多两格），少按几百次空格
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      const s = ta.selectionStart;
      if (s !== ta.selectionEnd) return;
      const before = ta.value.slice(0, s);
      const lineStart = before.lastIndexOf("\n") + 1;
      const cur = before.slice(lineStart);
      const indent = /^[ \t]*/.exec(cur)?.[0] ?? "";
      const extra = /[{([:]\s*$/.test(cur.trimEnd()) ? "  " : "";
      if (!indent && !extra) return;
      e.preventDefault();
      ta.setRangeText(`\n${indent}${extra}`, s, s, "end");
      afterEdit();
    }
  });

  main.appendChild(stats);

  // ---- 诊断区 ----
  const checkHead = el("div", { class: "row tight js-check-head" });
  checkHead.appendChild(el("div", { class: "group-label" }, "检查 Check"));
  checkHead.appendChild(el("div", { class: "spacer" }));
  const checkState = el("span", { class: "hint js-check-state" }, "待检查");
  checkHead.appendChild(checkState);
  checkHead.appendChild(
    button("重新检查", () => void runCheck(true), {
      size: "sm",
      variant: "ghost",
      title: "重新请求本地服务的 /api/js-check"
    })
  );
  main.appendChild(checkHead);

  const diagBox = el("div", { class: "js-diag-list" });
  main.appendChild(diagBox);

  // ---- 检查：服务器优先 + 本地兜底 ----
  let seq = 0;
  let timer = 0;

  function scheduleCheck(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void runCheck(false), 450);
  }

  async function runCheck(force: boolean): Promise<void> {
    // 面板可能在工程被替换后还持有旧引用，这里再确认一次
    if (!store.project || store.project.scripts[script.name] !== script) return;
    const my = ++seq;
    const src = script.source;
    if (!src.trim()) {
      checkState.textContent = "空脚本，没有可检查的内容";
      diagBox.replaceChildren();
      return;
    }
    checkState.textContent = "检查中…";
    const remote = await requestServerCheck(script.name, src, force);
    if (my !== seq) return; // 又有新的检查发起了，丢掉旧结果
    if (remote) renderDiags(remote, true);
    else renderDiags(localCheck(src), false);
  }

  function renderDiags(diags: Diag[], fromServer: boolean): void {
    diagBox.replaceChildren();
    const errors = diags.filter((d) => d.severity === "error").length;
    const warns = diags.filter((d) => d.severity === "warn").length;
    checkState.textContent = fromServer
      ? `服务器诊断 · ${errors} 错误 ${warns} 警告`
      : `本地语法兜底 · ${errors} 错误（/api/js-check 未就绪）`;
    if (!diags.length) {
      diagBox.appendChild(
        el(
          "div",
          { class: "hint js-diag-ok" },
          fromServer
            ? "没有发现问题，可以保存了。"
            : "语法没问题。类型与 API 用法要等本地服务提供 /api/js-check 才能查（不阻断保存和运行）。"
        )
      );
      return;
    }
    for (const d of diags) {
      const row = el("div", {
        class: `js-diag ${d.severity}`,
        title: d.col ? `第 ${d.line} 行 第 ${d.col} 列 · 点击跳到这一行` : `第 ${d.line} 行 · 点击跳到这一行`
      });
      row.appendChild(el("span", { class: "js-diag-where" }, `第 ${d.line} 行`));
      row.appendChild(el("span", { class: "js-diag-msg" }, d.message));
      row.addEventListener("click", () => jumpToLine(d.line));
      diagBox.appendChild(row);
    }
  }

  function jumpToLine(line: number): void {
    const src = ta.value;
    const lines = src.split("\n");
    const target = Math.max(1, Math.min(lines.length, Math.round(line) || 1));
    const start = lineOffset(src, target);
    ta.focus();
    ta.setSelectionRange(start, start + lines[target - 1].length);
    const lh = lineHeight();
    ta.scrollTop = Math.max(0, (target - 1) * lh - ta.clientHeight / 2 + lh / 2);
    syncScroll();
    updateStats();
  }

  // ---- API 速查侧栏 ----
  bench.appendChild(main);
  bench.appendChild(buildApiPane(ta, afterEdit));
  wrap.appendChild(bench);

  // 首帧：补行号、对齐滚动、跑一次检查
  refreshGutter();
  updateStats();
  window.setTimeout(() => {
    refreshGutter();
    syncScroll();
    void runCheck(false);
  }, 20);
}

// ---------------- 缩进 ----------------

/** Tab：无选区插两个空格；有跨行选区则整块右缩进。 */
function indentSelection(ta: HTMLTextAreaElement): void {
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const v = ta.value;
  const selected = v.slice(s, e);

  if (!selected.includes("\n")) {
    ta.setRangeText("  ", s, e, "end");
    return;
  }

  const lineStart = v.lastIndexOf("\n", s - 1) + 1;
  const nl = v.indexOf("\n", e);
  const end = nl === -1 ? v.length : nl;
  const block = v.slice(lineStart, end);
  const shifted = block
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
  ta.setRangeText(shifted, lineStart, end, "preserve");
  ta.setSelectionRange(lineStart, lineStart + shifted.length);
}

/** Shift+Tab：选区每一行去掉最多两个前导空格。 */
function unindentSelection(ta: HTMLTextAreaElement): void {
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const v = ta.value;
  const lineStart = v.lastIndexOf("\n", s - 1) + 1;
  const nl = v.indexOf("\n", e);
  const end = nl === -1 ? v.length : nl;
  const lines = v.slice(lineStart, end).split("\n");
  let removedFirst = 0;
  let removedTotal = 0;
  const shifted = lines
    .map((l, i) => {
      const m = /^ {1,2}/.exec(l);
      const cut = m ? m[0].length : 0;
      if (i === 0) removedFirst = cut;
      removedTotal += cut;
      return l.slice(cut);
    })
    .join("\n");
  if (!removedTotal) return;
  ta.setRangeText(shifted, lineStart, end, "preserve");
  const newStart = Math.max(lineStart, s - removedFirst);
  const newEnd = Math.max(newStart, e - removedTotal);
  ta.setSelectionRange(newStart, newEnd);
}

// ---------------- 检查：服务器 / 本地 ----------------

/**
 * 请求 /api/js-check。
 * 返回 null 表示"服务端这条线不可用，请用本地兜底"——这不算错误：
 * 用户可能只是没运行 npm run serve，编辑器不能因此罢工。
 */
async function requestServerCheck(name: string, source: string, force: boolean): Promise<Diag[] | null> {
  const now = Date.now();
  if (!force && serverCheck === "down" && now < serverRetryAt) return null;
  const ctrl = new AbortController();
  const timeout = window.setTimeout(() => ctrl.abort(), 2500);
  try {
    const resp = await fetch("/api/js-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, name }),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      markServerDown();
      return null;
    }
    const data = (await resp.json()) as { ok?: boolean; diagnostics?: unknown };
    if (!data || !Array.isArray(data.diagnostics)) {
      markServerDown();
      return null;
    }
    serverCheck = "ok";
    const out: Diag[] = [];
    for (const raw of data.diagnostics) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as { line?: unknown; col?: unknown; severity?: unknown; message?: unknown };
      const line = Number(r.line);
      const col = Number(r.col);
      const sev = String(r.severity ?? "error").toLowerCase();
      out.push({
        line: Number.isFinite(line) && line > 0 ? Math.round(line) : 1,
        col: Number.isFinite(col) && col > 0 ? Math.round(col) : undefined,
        severity: sev === "warn" || sev === "warning" ? "warn" : sev === "info" || sev === "suggestion" ? "info" : "error",
        message: String(r.message ?? "（没有说明）")
      });
    }
    return out;
  } catch {
    markServerDown();
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function markServerDown(): void {
  serverCheck = "down";
  serverRetryAt = Date.now() + SERVER_RETRY_MS;
}

/**
 * 本地语法兜底：new Function 只做一次解析，能抓住绝大多数手滑（漏括号 / 漏引号 / 乱字符）。
 * 精确的行号由括号与字符串扫描推断；推断不出来就报第 1 行，至少不丢错误。
 */
function localCheck(source: string): Diag[] {
  try {
    // 只解析、不执行；作用域是空的，所以脚本里访问 bwe 之类完全没关系
    new Function(source);
    return [];
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const message = raw.replace(/^SyntaxError:\s*/i, "").trim() || "语法错误";
    const line = guessErrorLine(source) ?? lineFromMessage(raw) ?? 1;
    return [{ line, severity: "error", message }];
  }
}

function lineFromMessage(message: string): number | null {
  const m = /line\s+(\d+)/i.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 猜出错行：扫一遍括号与字符串的配对，第一个对不上的地方通常就是出问题的地方。
 * 这是个启发式（正则字面量里的引号会干扰），只用于离线兜底；服务器诊断可用时不走这里。
 */
function guessErrorLine(source: string): number | null {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: { ch: string; line: number }[] = [];
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    // 注释
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const chunk = end === -1 ? source.slice(i) : source.slice(i, end + 2);
      line += (chunk.match(/\n/g) ?? []).length;
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    // 字符串 / 模板字符串
    if (c === "'" || c === '"' || c === "`") {
      const startLine = line;
      const quote = c;
      i++;
      let closed = false;
      while (i < source.length) {
        const d = source[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "\n") {
          if (quote !== "`") return startLine; // 普通字符串不能跨行
          line++;
          i++;
          continue;
        }
        if (d === quote) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return startLine;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push({ ch: c, line });
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top || top.ch !== pairs[c]) return line;
      i++;
      continue;
    }
    i++;
  }
  if (stack.length) return stack[stack.length - 1].line;
  return null;
}

// ---------------- API 速查 ----------------

function buildApiPane(ta: HTMLTextAreaElement, afterEdit: () => void): HTMLElement {
  const pane = el("div", { class: "js-api" + (apiOpen ? "" : " collapsed") });

  const search = input("", {
    placeholder: "搜索，例如 camera / 寻路 / 存档",
    hint: "多个关键词用空格分开；点一条就插到光标处",
    onChange: (v) => renderList(v)
  });
  search.classList.add("js-api-search");

  const toggle = button(apiOpen ? "收起" : "展开", () => {
    apiOpen = !apiOpen;
    pane.classList.toggle("collapsed", !apiOpen);
    toggle.textContent = apiOpen ? "收起" : "展开";
    if (apiOpen) search.focus();
  }, { size: "sm", variant: "ghost" });

  const head = el("div", { class: "row tight js-api-head" });
  head.appendChild(el("div", { class: "group-label" }, "API 速查"));
  head.appendChild(el("span", { class: "hint" }, `${API_DOCS.length} 条`));
  head.appendChild(el("div", { class: "spacer" }));
  head.appendChild(toggle);
  pane.appendChild(head);

  const body = el("div", { class: "js-api-body" });
  body.appendChild(search);

  const listBox = el("div", { class: "js-api-list" });
  body.appendChild(listBox);

  const rowFor = (item: ApiDoc): HTMLElement => {
    const row = el("div", { class: "js-api-row", title: `${item.signature}\n${item.desc}` });
    const top = el("div", { class: "js-api-name" });
    top.appendChild(el("span", null, item.name));
    if (item.phase2) top.appendChild(el("span", { class: "js-api-tag" }, "Phase 2"));
    row.appendChild(top);
    row.appendChild(el("div", { class: "js-api-desc" }, item.desc));
    row.addEventListener("click", () => insertApi(item, ta, afterEdit));
    return row;
  };

  function renderList(query: string): void {
    listBox.replaceChildren();
    const items = searchApiDocs(query);
    if (!items.length) {
      listBox.appendChild(el("div", { class: "hint js-api-empty" }, "没有匹配的 API，换个词试试（比如 audio / 相机 / 生成器）。"));
      return;
    }
    if (query.trim()) {
      for (const item of items) listBox.appendChild(rowFor(item));
      return;
    }
    for (const group of apiDocsByGroup()) {
      listBox.appendChild(el("div", { class: "js-api-group" }, `${group.group.label} · ${group.items.length}`));
      for (const item of group.items) listBox.appendChild(rowFor(item));
    }
  }

  renderList("");
  pane.appendChild(body);
  return pane;
}

/** 把一条 API 插到光标处：函数带上括号并把光标放进括号里；生命周期给一段函数骨架。 */
function insertApi(item: ApiDoc, ta: HTMLTextAreaElement, afterEdit: () => void): void {
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const before = ta.value.slice(0, s);
  const lineStart = before.lastIndexOf("\n") + 1;
  const beforeLine = before.slice(lineStart);

  let { text, caret } = buildInsert(item);
  // 多行骨架插在行中间会破坏结构 → 先换行再插
  if (text.includes("\n") && beforeLine.trim()) {
    text = "\n" + text;
    caret += 1;
  }
  ta.focus();
  ta.setRangeText(text, s, e, "end");
  const pos = s + caret;
  ta.setSelectionRange(pos, pos);
  afterEdit();
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, ta.scrollTop - ta.clientHeight / 2 + lh);
}

function buildInsert(item: ApiDoc): { text: string; caret: number } {
  if (item.group === "life" && /^on[A-Z]/.test(item.name)) {
    const params =
      item.name === "onUpdate" ? "ctx, dt"
        : item.name === "onEnter" || item.name === "onLeave" ? "ctx, other"
          : item.name === "onInteract" ? "ctx, actor"
            : item.name === "onDamage" ? "ctx, amount, from"
              : item.name === "onDeath" ? "ctx, by"
                : item.name === "onKey" ? "ctx, key"
                  : "ctx";
    const text = `function ${item.name}(${params}) {\n  \n}`;
    return { text, caret: text.indexOf("\n  ") + 3 };
  }
  if (item.signature.includes("(")) {
    const text = `${item.name}()`;
    return { text, caret: text.length - 1 };
  }
  return { text: item.name, caret: item.name.length };
}

// ============================================================================
// Yarn 模式（原有能力，保持不变）
// ============================================================================

function renderYarnEditor(wrap: HTMLElement, script: ScriptEntry, rerender: () => void): void {
  const edHead = el("div", { class: "row" });
  edHead.style.marginTop = "8px";
  edHead.appendChild(el("div", { class: "group-label" }, "源码 Yarn"));
  edHead.appendChild(el("div", { class: "spacer" }));
  edHead.appendChild(el("span", { class: "hint" }, "改完即时生效"));
  wrap.appendChild(edHead);

  const ta = el("textarea", { class: "textarea" });
  ta.value = script.source;
  ta.style.minHeight = "220px";
  ta.style.fontFamily = "var(--mono)";
  ta.style.fontSize = "12.5px";
  ta.addEventListener("input", () => {
    script.source = ta.value;
    store.markDirty();
    scheduleCheck();
  });

  // VS Code 工具条（Yarn 剧本也能拿 VS Code 编辑，扩展名 .yarn）
  renderVsCodeBar(
    wrap,
    script.name || currentScript,
    "yarn",
    () => ta.value,
    (text) => {
      script.source = text;
      store.markDirty();
      rerender();
    }
  );

  wrap.appendChild(ta);

  // 检查结果
  const resultHead = el("div", { class: "group-label" }, "检查 Check");
  resultHead.style.marginTop = "10px";
  wrap.appendChild(resultHead);
  const resultBox = el("div", { class: "col" });
  wrap.appendChild(resultBox);

  const nodeBox = el("div", { class: "col" });
  const nodeHead = el("div", { class: "group-label" }, "节点 Nodes");
  nodeHead.style.marginTop = "10px";
  wrap.appendChild(nodeHead);
  wrap.appendChild(nodeBox);

  // 变量
  const varBox = el("div", { class: "col" });
  const varHead = el("div", { class: "group-label" }, "变量 Variables");
  varHead.style.marginTop = "10px";
  wrap.appendChild(varHead);
  wrap.appendChild(varBox);

  let timer = 0;
  function scheduleCheck(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(runCheck, 400);
  }

  function runCheck(): void {
    // 面板可能在工程被替换后还持有旧引用，这里再确认一次
    if (!script) return;
    const r = analyzeYarn(script.source);
    resultBox.replaceChildren();
    if (!r.checks.length) {
      resultBox.appendChild(el("div", { class: "hint", style: { color: "var(--ok)" } }, "没有问题，这段剧本可以直接跑。"));
    } else {
      for (const c of r.checks) {
        const line = el("div", { class: "hint" });
        line.style.color = c.error ? "var(--danger)" : "var(--warn)";
        line.textContent = `${c.error ? "要改" : "建议"}　第 ${c.line} 行　${c.message}`;
        line.style.cursor = "pointer";
        line.addEventListener("click", () => {
          const pos = lineOffset(script.source, c.line);
          ta.focus();
          ta.setSelectionRange(pos, Math.min(pos + 60, script.source.length));
        });
        resultBox.appendChild(line);
      }
    }

    nodeBox.replaceChildren();
    if (!r.nodes.length) {
      nodeBox.appendChild(el("div", { class: "hint" }, "没有解析到节点。一个节点从 title: 名字 开始，用 --- 进入正文，用 === 结束。"));
    } else {
      for (const n of r.nodes) {
        const card = el("div", { class: "card" });
        const h = el("header");
        h.appendChild(el("span", null, n.title));
        h.appendChild(el("div", { class: "spacer" }));
        h.appendChild(el("span", { class: "hint" }, `第 ${n.startLine}–${n.endLine} 行`));
        card.appendChild(h);
        const body = el("div", { class: "body" });
        const bits: string[] = [];
        if (n.choices.length) bits.push(`${n.choices.length} 个选项`);
        if (n.jumps.length) bits.push(`跳往 ${n.jumps.join("、")}`);
        if (n.speakers.length) bits.push(`说话人 ${n.speakers.join("、")}`);
        if (n.varsSet.length) bits.push(`记下 $${n.varsSet.join("、$")}`);
        body.appendChild(el("div", { class: "hint" }, bits.join("　·　") || "纯叙述节点"));
        if (n.choices.length) {
          const ul = el("ul");
          ul.style.margin = "4px 0 0";
          ul.style.paddingLeft = "16px";
          for (const c of n.choices) ul.appendChild(el("li", { class: "hint" }, c));
          body.appendChild(ul);
        }
        card.appendChild(body);
        card.style.marginBottom = "6px";
        card.style.cursor = "pointer";
        card.addEventListener("click", () => {
          const pos = lineOffset(script.source, n.startLine);
          ta.focus();
          ta.setSelectionRange(pos, Math.min(pos + 40, script.source.length));
        });
        nodeBox.appendChild(card);
      }
    }

    varBox.replaceChildren();
    if (!r.variables.length) {
      varBox.appendChild(
        el("div", { class: "hint" }, "还没有用到变量。写 <<set $见过老人 = true>> 就能记一件事，模块里的「变量条件」可以读它。")
      );
    } else {
      for (const v of r.variables) {
        varBox.appendChild(el("div", { class: "hint mono" }, `$${v}`));
      }
    }
  }

  window.setTimeout(runCheck, 20);
}

// ============================================================================
// 新建 / 公共小工具
// ============================================================================

/**
 * 供其它面板调用：切到「剧本」页，并按需定位到某段脚本 / 某种语言。
 * 这里只改「应该显示什么」并广播事件；真正切页由编辑器外壳负责，
 * 面板之间不必互相持有引用。
 */
export function requestOpenScriptPanel(lang?: ScriptLang, name?: string): void {
  if (name && store.project?.scripts[name]) {
    currentScript = name;
    currentLang = scriptLang(store.project.scripts[name]);
  } else if (lang) {
    currentLang = lang;
    const names = scriptNamesOfLang(store.project, lang);
    if (!names.includes(currentScript)) currentScript = names[0] ?? currentScript;
  }
  window.dispatchEvent(new CustomEvent("bwe:open-scripts"));
}

function newScript(lang: ScriptLang): void {
  const p = store.project;
  if (!p) return;
  const base = lang === "js" ? "脚本" : "剧本";
  let i = 1;
  let name = `${base} 1`;
  while (p.scripts[name]) name = `${base} ${++i}`;
  p.scripts[name] = {
    name,
    file: defaultScriptFile(name, lang),
    source: lang === "js" ? JS_STARTER : YARN_STARTER,
    lang
  };
  currentScript = name;
  currentLang = lang;
  store.markDirty();
  ok(lang === "js" ? `已新建 JS 脚本「${name}」，里面注明了可用的生命周期函数` : `已新建「${name}」，里面是一段可以直接跑的示例`);
  window.dispatchEvent(new CustomEvent("bwe:refresh"));
}

function lineOffset(src: string, line: number): number {
  const lines = src.split("\n");
  let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
  return off;
}

// ============================================================================
// 解析（Yarn）
// ============================================================================

function analyzeYarn(source: string): { nodes: YarnNode[]; checks: YarnCheck[]; variables: string[] } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: YarnNode[] = [];
  const checks: YarnCheck[] = [];
  const variables = new Set<string>();
  let cur: YarnNode | null = null;
  let inBody = false;
  const titles = new Set<string>();

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) return;

    const tm = /^title\s*:\s*(.+)$/.exec(line);
    if (tm) {
      if (cur) checks.push({ line: lineNo, message: `上一个节点「${cur.title}」没有用 === 收尾`, error: true });
      const title = tm[1].trim();
      if (!title) checks.push({ line: lineNo, message: "节点没有名字", error: true });
      else if (titles.has(title)) checks.push({ line: lineNo, message: `节点名「${title}」重复了，运行时只有一个能用`, error: true });
      titles.add(title);
      cur = { title, startLine: lineNo, endLine: lineNo, choices: [], jumps: [], varsSet: [], speakers: [] };
      nodes.push(cur);
      inBody = false;
      return;
    }
    if (line === "---") {
      inBody = true;
      return;
    }
    if (line === "===") {
      if (cur) cur.endLine = lineNo;
      cur = null;
      inBody = false;
      return;
    }
    if (!cur || !inBody) return;

    // 选项
    const cm = /^->\s*(.*)$/.exec(line);
    if (cm) {
      const text = cm[1].replace(/<<\s*if\s+.+?>>/, "").trim();
      cur.choices.push(text || "(空选项)");
      if (!text) checks.push({ line: lineNo, message: "选项没有文字，玩家会看到一行空白", error: false });
    }
    // 跳转
    const jm = /<<\s*jump\s+([^>]+?)\s*>>/g;
    let m: RegExpExecArray | null;
    while ((m = jm.exec(line))) cur.jumps.push(m[1].trim());
    if (/<<\s*stop\s*>>/.test(line)) cur.jumps.push("（结束）");
    // 变量
    const vm = /\$([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/g;
    while ((m = vm.exec(line))) variables.add(m[1]);
    const sm = /<<\s*set\s+\$([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/.exec(line);
    if (sm) cur.varsSet.push(sm[1]);
    // 说话人
    const spm = /^([^:\-<>#\s][^:]{0,17})\s*:\s*\S/.exec(line);
    if (spm && !line.startsWith("<<")) cur.speakers.push(spm[1].trim());
    // 括号闭合
    if (line.includes("<<") && !line.includes(">>")) {
      checks.push({ line: lineNo, message: "这一行的命令少了 >> 收尾", error: true });
    }
  });

  if (!nodes.length) {
    checks.push({ line: 1, message: "没有找到任何节点。一个节点长这样：title: 开场 / --- / 旁白: 你好 / ===", error: true });
  }

  // 跳转目标校验
  for (const n of nodes) {
    for (const j of n.jumps) {
      if (j === "（结束）") continue;
      if (!titles.has(j)) {
        checks.push({ line: n.startLine, message: `节点「${n.title}」跳到了不存在的「${j}」`, error: true });
      }
    }
  }
  // 孤立节点提示
  if (nodes.length > 1) {
    nodes.slice(1).forEach((n) => {
      const referenced = nodes.some((o) => o !== n && o.jumps.includes(n.title));
      if (!referenced) checks.push({ line: n.startLine, message: `节点「${n.title}」没有任何地方跳进来，玩家看不到它`, error: false });
    });
  }

  return { nodes, checks, variables: Array.from(variables) };
}

// ============================================================================
// 新建时的示例源码
// ============================================================================

const JS_STARTER = `// 挂到对象的「对象脚本」模块上之后，运行时按事件调用下面的同名函数。
// 没写的函数直接跳过；可用能力见右侧「API 速查」，改完按 Ctrl+S 保存工程。
// ctx = { self, world, scene, time, camera, input, save, dt }

function onStart(ctx) {
  // 只在对象生成时跑一次
  bwe.log("脚本启动：", ctx.self.name);
}

function onUpdate(ctx, dt) {
  // 每帧跑：WASD / 方向键移动，120 像素每秒
  const e = ctx.self;
  const axis = ctx.input.axis();
  if (axis.x || axis.y) {
    e.setPos(e.x + axis.x * 120 * dt, e.y + axis.y * 120 * dt);
  }
}

function onClick(ctx) {
  bwe.log("点到了", ctx.self.name);
  bwe.camera.shake(4, 0.2);
  bwe.audio.play("点击音效");
}
`;

const YARN_STARTER = `title: 序章
---
旁白: 夜色压下来，风把火把吹得东倒西歪。
旅人: 这地方……三年前就该没人了。
-> 推门进去
    旁白: 门轴发出一声长叹。
    <<jump 门内>>
-> 转身离开
    旁白: 你决定不惹麻烦。
    <<stop>>
===

title: 门内
---
旁白: 屋里点着一盏灯。
<<if $问过路了>>
    老人: 你回来了。
<<else>>
    老人: 谁在外面？
    <<set $问过路了 = true>>
<<endif>>
===
`;
