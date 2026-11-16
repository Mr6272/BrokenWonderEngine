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
import { apiFetch } from "../core/host.ts";
import { setProblems, clearProblems, type Problem } from "../core/diagnostics.ts";
import {
  defaultScriptFile,
  scriptLang,
  scriptNamesOfLang,
  type ScriptEntry,
  type ScriptLang
} from "../core/model.ts";
import { API_DOCS, apiDocsByGroup, searchApiDocs, type ApiDoc } from "../data/apiDocs.ts";
import { attachScriptComplete } from "./scriptComplete.ts";
import {
  bracketPairAt,
  extractOutline,
  findMatches,
  moveLine,
  offsetOfLine,
  pointToOffset,
  wordAt,
  type Match
} from "./jsEditorLogic.ts";
import { createHighlightOverlay, measureCharWidth } from "./jsOverlay.ts";
import { createFindBar } from "./jsFindBar.ts";
import { createJsTools } from "./jsToolsPanel.ts";
import { requestCompile, requestDefinition, requestQuickInfo, requestReferences } from "./jsCodeIntel.ts";

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
    const resp = await apiFetch("/api/open-in-vscode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, source, lang, line, project: projectScope() })
    });
    payload = (await resp.json()) as typeof payload;
  } catch {
    warn("这个能力需要本地服务（网页版 npm run serve / 桌面版主进程 IPC）");
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
    const resp = await apiFetch(
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

/**
 * 当前面板里「跳到第 N 行」的实现。
 *
 * 为什么不直接在面板之间传 textarea：底部「问题」面板与剧本面板是两个独立树，
 * 互相持有引用的代价（生命周期、重渲染后失效）比一个回调大得多。
 * 面板渲染时把自己跳行的能力登记进来，卸载/重渲染时替换；问题面板只发事件。
 */
let jumpToLineHook: ((line: number) => void) | null = null;

window.addEventListener("bwe:script-goto-line", (e) => {
  const line = Number((e as CustomEvent<{ line?: number }>).detail?.line);
  if (!Number.isFinite(line)) return;
  jumpToLineHook?.(line);
});

// ============================================================================
// 面板入口
// ============================================================================

/**
 * 剧本面板拆成两半，因为 VS Code 结构里"列表在侧边栏、编辑器在编辑区"：
 *   - renderScriptList：语言切换 + 脚本列表（侧边栏）
 *   - renderScriptEditor：源码编辑器 + 检查结果（编辑区标签）
 *   - renderScriptPanel：两者合一（保留给"只放一个面板"的旧布局/弹窗场景）
 *
 * 拆开的好处：切脚本不再重建整棵编辑器树，点一下列表只重建编辑区，
 * 反过来在编辑器里敲字也不会重画列表（原来的合并版每敲一个字都可能整面板重画）。
 */
export function renderScriptList(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";
  renderScriptListBody(wrap, host);
  host.appendChild(wrap);
}

export function renderScriptEditor(host: HTMLElement): void {
  host.replaceChildren();
  // 每次重渲染都重建 VS Code 轮询，避免旧面板的 interval 越积越多
  stopMirrorPoll();
  // 用 .script-editor-wrap 而不是通用 .col：
  // 编辑区宿主（editorBody）是 flex 容器，wrap 必须 flex:1 + min-height:0 才能把高度
  // 传给里面的 .js-code —— 否则代码框只能拿到内容高度（原来写死 320px 就掩盖了这个问题）。
  const wrap = el("div", { class: "col script-editor-wrap" });
  wrap.style.padding = "10px 12px 8px";
  renderScriptEditorBody(wrap, host);
  host.appendChild(wrap);
}

export function renderScriptPanel(host: HTMLElement): void {
  host.replaceChildren();
  stopMirrorPoll();
  const wrap = el("div", { class: "col" });
  wrap.style.padding = "10px";
  renderScriptListBody(wrap, host);
  wrap.appendChild(el("div", { class: "divider" }));
  renderScriptEditorBody(wrap, host);
  host.appendChild(wrap);
}

/**
 * 重渲染入口：拆开之后要按需重画 —— 侧边栏只画列表、编辑区只画编辑器。
 * 原来两个函数各自调用 renderScriptPanel(host)，在这套结构下会把另一半也重建，
 * 于是"点脚本 → 整棵树重画"，白白多出一倍 DOM 开销。
 */
function refreshScriptUi(): void {
  window.dispatchEvent(new CustomEvent("bwe:refresh-script-ui"));
}

// ---------------- 列表（侧边栏） ----------------

function renderScriptListBody(wrap: HTMLElement, host: HTMLElement): void {
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
      refreshScriptUi();
    }
  );
  // 语言切换按钮的验收锚点（--tap-seq 用）
  Array.from(langSwitch.querySelectorAll("button")).forEach((b, i) => {
    (b as HTMLElement).dataset.scriptLang = i === 0 ? "js" : "yarn";
  });
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
    const newBtn = button(
      currentLang === "js" ? "新建 JS 脚本" : "新建剧本",
      () => newScript(currentLang),
      { variant: "primary", size: "sm" }
    );
    newBtn.dataset.newScript = "1";
    empty.appendChild(newBtn);
    wrap.appendChild(empty);
    if (otherNames.length) {
      wrap.appendChild(
        button(
          `切到${other === "js" ? "JS 脚本" : "Yarn 剧本"}（${otherNames.length} 个）`,
          () => {
            currentLang = other;
            currentScript = otherNames[0];
            refreshScriptUi();
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
      refreshScriptUi();
    });
    list.appendChild(item);
  }
  wrap.appendChild(list);

  // ---- 下面是编辑区那一半 ----
}

// ---------------- 编辑器（编辑区） ----------------

function renderScriptEditorBody(wrap: HTMLElement, host: HTMLElement): void {
  void host;
  const p = store.project;
  if (!p) {
    wrap.appendChild(el("div", { class: "hint" }, "还没有打开工程"));
    return;
  }
  if (!scriptNamesOfLang(p, currentLang).length) {
    wrap.appendChild(el("div", { class: "hint" }, currentLang === "js" ? "这个工程还没有 JS 脚本。" : "这个工程还没有 Yarn 剧本。"));
    return;
  }
  if (!currentScript || !p.scripts[currentScript]) {
    currentScript = scriptNamesOfLang(p, currentLang)[0] ?? "";
  }
  const script = p.scripts[currentScript];
  if (!script) {
    wrap.appendChild(el("div", { class: "hint" }, "选一段脚本开始编辑"));
    return;
  }

  // 告诉外壳「现在在编哪段脚本」：AI 面板据此挑上下文，
  // 不清空 hook —— 剧本面板重渲染时下面会重新登记，旧闭包指向已经丢弃的 textarea 也无害。
  window.dispatchEvent(new CustomEvent("bwe:script-focus", { detail: { name: currentScript, lang: currentLang } }));

  if (currentLang === "js") renderJsEditor(wrap, script, refreshScriptUi);
  else renderYarnEditor(wrap, script, refreshScriptUi);

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
      title: "把脚本写到 web/.build/scripts/ 并用本机 VS Code 打开（网页版需要 npm run serve）"
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
  // 标题行与 VS Code 工具条合并成**一行**：它们原来各占一行（共约 79px），
  // 而用户报的正是「看代码的窗口太小」—— 每省一行都是给代码区的高度。
  const edHead = el("div", { class: "row script-ed-head" });
  edHead.appendChild(el("div", { class: "group-label" }, "源码 JavaScript"));
  edHead.appendChild(el("div", { class: "spacer" }));
  edHead.appendChild(
    el("span", { class: "hint" }, "Ctrl+F 查找 · Ctrl+B 编译 · F12 定义 · Shift+F12 引用 · Ctrl+Space 补全")
  );
  // 语法着色开关：放在标题行右侧（不占额外高度）。为什么不放辅助区页签里：
  // 它是"看代码"时的即时偏好，不是"查资料"时的功能，放远了每次都要两层点击。
  const syntaxBtn = button("", () => {}, {
    size: "sm",
    variant: "ghost",
    title: "语法着色开关（记住状态）：关掉后所有文字同色，便于专注读结构"
  });
  syntaxBtn.dataset.jsSyntax = "1";
  edHead.appendChild(syntaxBtn);
  wrap.appendChild(edHead);

  const bench = el("div", { class: "js-workbench" });
  const main = el("div", { class: "js-main" });

  // ---- 带行号栏的编辑器 ----
  //
  // 结构（见 jsOverlay.ts 顶部注释）：行号栏是 .js-code 的直接子项，
  // 而 textarea 与覆盖层共享一个 .js-edit 容器 —— 只有这样才能保证两者**同原点**。
  // 上一版把覆盖层直接挂 .js-code、与 textarea 跨行号栏做兄弟，实测偏 40px。
  const codeBox = el("div", { class: "js-code" });
  const gutter = el("div", { class: "js-gutter", title: "行号" });
  const gutterInner = el("div", { class: "js-gutter-inner" }, "1");
  gutter.appendChild(gutterInner);

  const editBox = el("div", { class: "js-edit" });
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
  editBox.appendChild(ta);
  codeBox.appendChild(gutter);
  codeBox.appendChild(editBox);
  main.appendChild(codeBox);

  // 覆盖层：现在由它显示**所有文字**（彩色），textarea 的文字是透明的。
  const overlay = createHighlightOverlay(editBox);

  // 语法着色开关（默认开，状态记在 localStorage）
  const SYNTAX_KEY = "bwe.script.syntax";
  let syntaxOn = (() => {
    try {
      const v = localStorage.getItem(SYNTAX_KEY);
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  })();

  // 行高：行号栏与正文必须用同一个值，否则行号会逐行偏移（样式表里两者显式写成一样）
  const lineHeight = (): number => {
    const lh = parseFloat(getComputedStyle(ta).lineHeight);
    return Number.isFinite(lh) && lh > 0 ? lh : 19;
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
    overlay.syncScroll(ta.scrollTop, ta.scrollLeft);
  };

  // 光标位置与规模
  const stats = el("div", { class: "hint js-stats" });
  const updateStats = (): void => {
    const v = ta.value;
    const pos = ta.selectionStart;
    const before = v.slice(0, pos);
    const line = (before.match(/\n/g) ?? []).length + 1;
    const col = pos - before.lastIndexOf("\n");
    const sel = ta.selectionEnd - ta.selectionStart;
    stats.textContent =
      `第 ${line} 行 第 ${col} 列　·　${v.split("\n").length} 行　·　${v.length} 字符`
      + (sel > 0 ? `　·　选中 ${sel}` : "");
  };

  // ==========================================================================
  // 编辑器动作：跳行 / 整段替换 / 编译 / 引用 / 定义
  // ==========================================================================

  /** 跳到一个行列（1 起）。col 省略时选中整行（与「问题」面板的语义一致）。 */
  function jumpToLine(line: number, col?: number): void {
    const src = ta.value;
    const lines = src.split("\n");
    const target = Math.max(1, Math.min(lines.length, Math.round(line) || 1));
    const start = offsetOfLine(src, target);
    ta.focus();
    if (col && col > 0) {
      const pos = Math.min(src.length, start + Math.round(col) - 1);
      ta.setSelectionRange(pos, pos);
    } else {
      ta.setSelectionRange(start, start + (lines[target - 1]?.length ?? 0));
    }
    const lh = lineHeight();
    ta.scrollTop = Math.max(0, (target - 1) * lh - ta.clientHeight / 2 + lh / 2);
    syncScroll();
    updateStats();
  }

  jumpToLineHook = (line: number) => jumpToLine(line);

  /**
   * 整段替换。查找替换、移行、VS Code 回写都走这一条路 —— 「改源码」只允许有一个入口。
   *
   * @param label 撤销栈里的动作名。**离散动作（替换/移行/回写）必须传**，
   *              它们要能被 Ctrl+Z 一次撤销；`label` 为空表示这是连续输入的一部分，
   *              交给浏览器原生的 textarea 撤销即可（每一击键压一条应用级快照会
   *              把 80 步撤销额度几秒钟就吃光，那比"不能撤销"更让人困惑）。
   */
  function applySource(next: string, label = ""): void {
    if (next === ta.value) return;
    ta.value = next;
    afterEdit();
    // immediate：离散动作要当场进撤销栈（见 editor.ts 里 bwe:commit 的注释）
    if (label) window.dispatchEvent(new CustomEvent("bwe:commit", { detail: { label, immediate: true } }));
  }

  /** 全工程的 JS 脚本快照：跨脚本的引用/定义必须以整份工程为上下文。 */
  function jsScriptFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    const p = store.project;
    if (!p) return out;
    const self = script.name || currentScript;
    for (const [name, entry] of Object.entries(p.scripts ?? {})) {
      if (!entry) continue;
      if (scriptLang(entry) !== "js") continue;
      // 当前脚本用编辑器里的**最新**文本：script.source 是同步更新的，但 users 可能刚敲完还没防抖检查
      out[name] = name === self ? ta.value : entry.source ?? "";
    }
    return out;
  }

  // ---- 悬浮提示 ----
  const hoverEl = el("div", { class: "js-hover" });
  hoverEl.style.display = "none";
  codeBox.appendChild(hoverEl);
  let hoverTimer = 0;
  /** 每次发起悬停请求时自增：光盘异步返回时用它判断"用户已经移开了" */
  let hoverSeq = 0;

  const hideHover = (): void => {
    window.clearTimeout(hoverTimer);
    hoverSeq++;
    hoverEl.style.display = "none";
  };

  /** 悬浮提示：鼠标在一个标识符上停 300ms 才问语言服务（逐像素问会把主线程打满）。 */
  function scheduleHover(e: MouseEvent): void {
    window.clearTimeout(hoverTimer);
    const rect = ta.getBoundingClientRect();
    const cs = getComputedStyle(ta);
    // 传**相对 textarea 边框盒**的坐标 + 真实的 padding：换算函数自己扣 padding，
    // 调用方少做一次减法就少一处符号写反的机会（这类错只表现为"提示总是慢半行"）。
    const offset = pointToOffset(ta.value, e.clientX - rect.left, e.clientY - rect.top, {
      lineHeight: lineHeight(),
      charWidth: measureCharWidth(ta),
      padTop: parseFloat(cs.paddingTop) || 0,
      padLeft: parseFloat(cs.paddingLeft) || 0,
      scrollTop: ta.scrollTop,
      scrollLeft: ta.scrollLeft
    });
    const w = wordAt(ta.value, offset);
    if (!w) {
      hideHover();
      return;
    }
    const my = ++hoverSeq;
    hoverTimer = window.setTimeout(async () => {
      const info = await requestQuickInfo(ta.value, w.start + 1);
      // 用户已经移开/继续打字了：丢掉这次结果，否则提示框会闪回上一个词的类型
      if (my !== hoverSeq) return;
      if (!info || !info.display) return;
      hoverEl.replaceChildren();
      hoverEl.appendChild(el("div", { class: "js-hover-code" }, info.display));
      if (info.docs) hoverEl.appendChild(el("div", { class: "js-hover-doc" }, info.docs));
      const boxRect = codeBox.getBoundingClientRect();
      const left = Math.max(4, Math.min(e.clientX - boxRect.left + 14, Math.max(4, codeBox.clientWidth - 330)));
      const top = Math.max(4, Math.min(e.clientY - boxRect.top + 20, Math.max(4, codeBox.clientHeight - 60)));
      hoverEl.style.left = `${Math.round(left)}px`;
      hoverEl.style.top = `${Math.round(top)}px`;
      hoverEl.style.display = "";
    }, 300);
  }

  /** 跳到**另一个**脚本的某一行：先切脚本，再等面板重建后发跳行事件。 */
  function jumpToOtherScript(name: string, line: number): void {
    if (!store.project?.scripts[name]) return;
    requestOpenScriptPanel("js", name);
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("bwe:script-goto-line", { detail: { line } }));
    }, 90);
  }

  /** 查找引用。语言服务不可用时降级为「本文件内文本搜索」，并在标题里说明降级来源。 */
  async function findReferencesAt(offset: number): Promise<void> {
    const active = script.name || currentScript;
    const w = wordAt(ta.value, offset);
    tools.showTab("refs");
    expandAux();
    if (!w) {
      tools.setRefs("查找引用", [], "把光标放在一个函数名或变量名上再按 Shift+F12。");
      return;
    }
    tools.setRefs(`正在查找「${w.word}」的引用…`, [], "");
    const res = await requestReferences(jsScriptFiles(), active, w.start + 1);
    if (!res.ok) {
      const lines = ta.value.split("\n");
      const inside = findMatches(ta.value, w.word, { wholeWord: true }).map((m) => {
        const line = ta.value.slice(0, m.start).split("\n").length;
        return {
          name: active,
          line,
          col: m.start - offsetOfLine(ta.value, line) + 1,
          text: (lines[line - 1] ?? "").trim().slice(0, 120),
          isDefinition: false
        };
      });
      tools.setRefs(
        `「${w.word}」· 本地文本搜索（语言服务不可用）`,
        inside,
        "语言服务不可用，只在这个脚本里按文本找了一遍。跑 npm run serve（或桌面版主进程）后可以跨脚本查引用。"
      );
      return;
    }
    /**
     * 空结果有两种完全不同的含义，必须分开说 —— 混在一起会让人以为搜索坏了：
     *   ① 工程里真的没有别处引用它（用户自己写的函数）；
     *   ② 它是**标准库成员**（`Math.max` / `arr.push`）：后端按「不是用户代码」
     *      把 lib.es*.d.ts 的命中滤掉了，所以结果必然是空的。
     * 判据不看结果（结果就是空），而是把这个词在**全工程源码**里的出现次数
     * 与结果条数对比：出现次数 > 0 而结果为空，就说明命中的全是库声明。
     */
    let hint = `工程里没有别处引用「${w.word}」。`;
    if (!res.refs.length) {
      const files = jsScriptFiles();
      let occurrences = 0;
      for (const src of Object.values(files)) {
        occurrences += findMatches(src, w.word, { wholeWord: true }).length;
      }
      if (occurrences > 0) {
        hint =
          `「${w.word}」在脚本里出现 ${occurrences} 次，但没有跨脚本引用 —— `
          + "如果它是 Math / Array 这类标准库成员，后端会过滤掉库内部的命中，这是正常的。";
      }
    }
    // 同名生命周期（每个脚本都有自己的 onStart）会被 TS 合并成一组，
    // 两条都标「定义」。这不是 bug，但需要在标题里说清，否则用户会以为列表搞错了。
    const defCount = res.refs.filter((r) => r.isDefinition).length;
    const title =
      defCount > 1
        ? `「${w.word}」的引用（${defCount} 处定义：每个脚本都可以有自己的「${w.word}」）`
        : `「${w.word}」的引用`;
    tools.setRefs(title, res.refs, hint);
  }

  /** 跳转定义（F12）。工程内定义直接跳；内置 API 只展示 bwe.d.ts 里的声明。 */
  async function gotoDefinitionAt(offset: number): Promise<void> {
    const active = script.name || currentScript;
    const w = wordAt(ta.value, offset);
    if (!w) return;
    const res = await requestDefinition(jsScriptFiles(), active, w.start + 1);
    tools.showTab("refs");
    expandAux();
    const first = res.defs.find((d) => d.name !== "__bwe_dts__");
    tools.setRefs(`「${w.word}」的定义`, res.defs, res.ok
      ? "这个词没有工程内的定义（可能是内置 API 或运行时变量）。内置 API 的完整签名见「API 速查」页签。"
      : "语言服务不可用，查不了定义。跑 npm run serve（或桌面版主进程）后可以按 F12 跳转。");
    if (!first) return;
    if (first.name === active) jumpToLine(first.line, first.col);
    else jumpToOtherScript(first.name, first.line);
  }

  // ---- 编译（语法检查 + 降级 ES5）----
  let compiling = false;
  async function compile(): Promise<void> {
    if (compiling) return;
    compiling = true;
    tools.showTab("build");
    expandAux();
    try {
      const res = await requestCompile(ta.value, script.name || currentScript);
      if (!res) {
        tools.setCompile(null);
        warn("编译需要本地服务（网页版 npm run serve / 桌面版主进程），现在不可用");
        return;
      }
      tools.setCompile(res);
      publishScriptProblems("js", script.name || currentScript, res.diagnostics);
      const errors = res.diagnostics.filter((d) => d.severity === "error").length;
      if (errors) warn(`编译有 ${errors} 个错误（在「编译」页签里点一条能跳到那一行）`);
      else ok("编译通过，产物已降级为 ES5");
    } finally {
      compiling = false;
    }
  }

  // ==========================================================================
  // 工具面板（检查 / 大纲 / 引用 / 编译 / API 速查）
  // ==========================================================================
  /**
   * 辅助区的「展开」入口。辅助区在 tools 之后才创建（它要把 tools.root 塞进去），
   * 但引用/编译这两个动作在 tools 之前就定义好了 —— 用一个可变持有者接起来，
   * 避免为了顺序把函数定义搬到后面（那会让「动作 → 面板」的阅读顺序变反）。
   */
  let expandAux: () => void = () => {};

  const tools = createJsTools({
    jumpTo: (name, line, col) => {
      if (!name || name === (script.name || currentScript)) jumpToLine(line, col);
      else jumpToOtherScript(name, line);
    },
    recheck: () => void runCheck(true),
    compile: () => void compile()
  });
  tools.setOutline(extractOutline(ta.value));

  // ---- 查找 / 替换 ----
  const findbar = createFindBar(codeBox, {
    getText: () => ta.value,
    getSelection: () => ({ start: ta.selectionStart, end: ta.selectionEnd }),
    goto: (m, focusEditor) => {
      if (focusEditor) ta.focus();
      ta.setSelectionRange(m.start, m.end);
      const lh = lineHeight();
      const line = ta.value.slice(0, m.start).split("\n").length;
      ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2 + lh / 2);
      syncScroll();
      updateStats();
      refreshHighlights();
    },
    applyReplace: (next, label) => applySource(next, label),
    searchProject: (q) => {
      window.dispatchEvent(new CustomEvent("bwe:search-project", { detail: { query: q } }));
    }
  });

  /** 当前光标处的括号配对（覆盖层用）。 */
  const bracketOf = (offset: number): Match[] => {
    const pair = bracketPairAt(ta.value, offset);
    return pair ? [pair.open, pair.close] : [];
  };

  /** 光标所在行（0 起）。「当前行底色」与状态栏「第 N 行」共用同一个换算。 */
  function caretLine(): number {
    const before = ta.value.slice(0, ta.selectionStart);
    return before.split("\n").length - 1;
  }

  /** 同步开关按钮的外观（折叠/展开状态与 aria）。 */
  function paintSyntaxBtn(): void {
    syntaxBtn.textContent = syntaxOn ? "着色 开" : "着色 关";
    syntaxBtn.classList.toggle("on", syntaxOn);
    syntaxBtn.setAttribute("aria-pressed", String(syntaxOn));
  }
  syntaxBtn.addEventListener("click", () => {
    syntaxOn = !syntaxOn;
    try {
      localStorage.setItem(SYNTAX_KEY, syntaxOn ? "1" : "0");
    } catch {
      /* 隐私模式忽略：只在本次会话生效 */
    }
    paintSyntaxBtn();
    // 关掉着色后覆盖层仍然要显示文字（否则整篇看不见）—— overlay 内部把整段当 plain 处理
    overlay.update({
      text: ta.value,
      matches: findbar.isOpen() ? findbar.state().matches : [],
      currentIndex: findbar.isOpen() ? findbar.state().currentIndex : -1,
      bracket: bracketOf(ta.selectionStart),
      activeLine: -1,
      syntax: syntaxOn
    });
    refreshHighlights();
  });

  /** 把「语法着色 + 搜索命中 + 括号配对 + 当前行」推给覆盖层。 */
  function refreshHighlights(): void {
    const state = findbar.isOpen()
      ? findbar.state()
      : { matches: [] as Match[], currentIndex: -1 };
    overlay.update({
      text: ta.value,
      matches: state.matches,
      currentIndex: state.currentIndex,
      bracket: bracketOf(ta.selectionStart),
      activeLine: ta === document.activeElement ? caretLine() : -1,
      syntax: syntaxOn
    });
  }

  function afterEdit(): void {
    script.source = ta.value;
    store.markDirty();
    refreshGutter();
    syncScroll();
    updateStats();
    scheduleCheck();
    tools.setOutline(extractOutline(ta.value));
    if (findbar.isOpen()) findbar.refresh();
    refreshHighlights();
  }

  ta.addEventListener("input", afterEdit);
  ta.addEventListener("scroll", () => {
    syncScroll();
    hideHover();
  });

  /**
   * 输入法组字期间必须切回「textarea 显示文字」。
   *
   * 为什么：文字由覆盖层显示、textarea 的字是透明的。而中文输入法打拼音时，
   * **组字串在 textarea 里**（不是 input 事件，覆盖层还没更新）——
   * 此时若 textarea 的字是透明的，用户就看不见自己正在打什么。
   * 所以 compositionstart 时给 `.js-edit` 加 `composing` 类：
   * 该类的样式让 textarea 显示文字、同时把覆盖层 `visibility:hidden`（避免重影）。
   * compositionend 时去掉，覆盖层接管。这是"textarea + overlay 着色"方案的必备补丁。
   */
  ta.addEventListener("compositionstart", () => editBox.classList.add("composing"));
  ta.addEventListener("compositionend", () => {
    editBox.classList.remove("composing");
    // 组字结束后一次 input 事件会到，但顺序不保证（Chromium 是先 compositionend 再 input，
    // 部分输入法相反）。这里主动刷一次，保证覆盖层立刻显示最终文本。
    refreshHighlights();
  });

  // 失焦时撤掉「当前行」底色（它只在编辑时有意义，失焦后留着像一条选中条）
  ta.addEventListener("blur", () => {
    editBox.classList.remove("composing");
    refreshHighlights();
  });
  const onCursor = (): void => {
    updateStats();
    findbar.syncSelection();
    refreshHighlights();
    hideHover();
  };
  ta.addEventListener("click", onCursor);
  ta.addEventListener("keyup", onCursor);
  ta.addEventListener("select", onCursor);

  // 悬浮提示：只认鼠标，不打断键盘
  ta.addEventListener("mousemove", (e) => scheduleHover(e as MouseEvent));
  ta.addEventListener("mouseleave", hideHover);

  // 按需补全（挂在 codeBox 上，弹层相对它定位）。
  // 失败静默降级：只在「输出」面板留首次一次痕，绝不打断打字。
  attachScriptComplete(ta, codeBox, afterEdit);

  // VS Code 工具条：合并进标题行（原来单独占一行 ~44px）
  renderVsCodeBar(
    edHead,
    script.name || currentScript,
    "js",
    () => ta.value,
    (text) => {
      applySource(text, "载入 VS Code 改动");
    }
  );

  // ---- 键盘 ----
  //
  // 顺序纪律：**先处理我们自己定义的组合键，再放行给浏览器与补全弹层**。
  // attachScriptComplete 的监听器注册在捕获阶段，所以补全弹层开着时
  // 它的 Enter/Esc/↑↓ 会先拿到事件；这里只处理它不管的键，两者不抢键。
  ta.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    // Ctrl/Cmd+S：保存整个工程（全局快捷键对 textarea 是放行的，这里必须自己接住）
    if (ctrl && e.key.toLowerCase() === "s") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("bwe:save"));
      return;
    }
    if (ctrl && e.key.toLowerCase() === "f") {
      e.preventDefault();
      findbar.show("find");
      refreshHighlights();
      return;
    }
    if (ctrl && e.key.toLowerCase() === "h") {
      e.preventDefault();
      findbar.show("replace");
      refreshHighlights();
      return;
    }
    if (ctrl && e.key.toLowerCase() === "b") {
      e.preventDefault();
      void compile();
      return;
    }
    // F12 / Shift+F12：定义与引用（VS Code 同款）
    if (e.key === "F12") {
      e.preventDefault();
      hideHover();
      if (e.shiftKey) void findReferencesAt(ta.selectionStart);
      else void gotoDefinitionAt(ta.selectionStart);
      return;
    }
    if (e.key === "F3") {
      e.preventDefault();
      if (!findbar.isOpen()) findbar.show("find");
      else findbar.next(!e.shiftKey);
      return;
    }
    if (e.key === "Escape") {
      if (findbar.isOpen()) {
        e.preventDefault();
        findbar.hide();
        refreshHighlights();
      }
      hideHover();
      return;
    }
    // Alt+↑/↓：整行上移/下移（调整脚本顺序时比剪切粘贴稳，且不破坏缩进）
    if (e.altKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const moved = moveLine(ta.value, ta.selectionStart, e.key === "ArrowUp" ? -1 : 1);
      if (moved) {
        applySource(moved.text, "移动行");
        ta.setSelectionRange(moved.caret, moved.caret);
        updateStats();
      }
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

  // ---- 诊断（检查）----
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
    const name = script.name || currentScript;
    if (!src.trim()) {
      tools.setCheck([], false);
      clearProblems(`js:${name}`);
      dispatchDiagCount(0, 0);
      return;
    }
    const remote = await requestServerCheck(name, src, force);
    if (my !== seq) return; // 又有新的检查发起了，丢掉旧结果
    const diags = remote ?? localCheck(src);
    tools.setCheck(diags, remote !== null);
    // 同步进「问题」面板：底部面板统一展示所有来源，用户不用为每条诊断
    // 在左栏和底部之间来回找。key 用 语言:脚本名 固定，重复检查不会堆叠。
    publishScriptProblems("js", name, diags);
    dispatchDiagCount(
      diags.filter((d) => d.severity === "error").length,
      diags.filter((d) => d.severity === "warn").length
    );
  }

  // ---- 布局：代码区吃满高度，辅助区可折叠 + 可拖分割 ----
  //
  // 用户原话「脚本编辑器看代码的窗口太小了」。根因是两处叠加的死高度：
  //   1. .js-code 写死 height:320px —— 1400+ 高的编辑区里代码只占三分之一；
  //   2. API 速查栏横向并排（flex: 0 1 190px），把代码又挤窄一半（实测仅 283px 宽）。
  // 改法：两者都不再并排。代码吃满整行宽度与剩余高度；
  // 辅助区（页签：检查 / 大纲 / 引用 / 编译 / API 速查）收进下部面板，可折叠、可拖分割。
  const apiPane = buildApiPane(ta, afterEdit);
  tools.mountApiPane(apiPane);
  const aux = buildAuxSection(main, el("div"), stats, el("div"), tools.root);
  // buildAuxSection 会把 body 拼成「checkHead + diagBox + stats + apiPane」，
  // 这里只有两块内容（统计 + 工具面板），所以清掉占位、直接铺进去。
  const auxBody = aux.box.querySelector(".js-aux-body");
  if (auxBody) auxBody.replaceChildren(stats, tools.root);
  const auxTitle = aux.box.querySelector(".js-aux-title");
  if (auxTitle) auxTitle.textContent = "辅助：检查 / 大纲 / 引用 / 编译 / API 速查";
  bench.appendChild(main);
  bench.appendChild(aux.resizer);
  bench.appendChild(aux.box);
  wrap.appendChild(bench);
  aux.restore();
  expandAux = () => aux.expand();
  tools.showTab("check");

  // 首帧：补行号、对齐滚动、着色、跑一次检查
  paintSyntaxBtn();
  refreshGutter();
  updateStats();
  refreshHighlights();
  window.setTimeout(() => {
    refreshGutter();
    syncScroll();
    // 字体/布局在这一帧才真正落定，覆盖层的字符宽度测量依赖它们 —— 再刷一次
    refreshHighlights();
    void runCheck(false);
  }, 20);
}

/** 告诉辅助区标题条「现在还剩下几个错」（折叠状态下也要能看见）。 */
function dispatchDiagCount(errors: number, warns: number): void {
  window.dispatchEvent(new CustomEvent("bwe:script-diag-count", { detail: { errors, warns } }));
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
    const resp = await apiFetch("/api/js-check", {
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


/**
 * 剧本编辑器的「下部辅助区」：检查结果 / 统计 / API 速查。
 *
 * 为什么收成一个可折叠 + 可拖分割的容器，而不是原来那样和代码并排：
 *   并排时它们抢的是**宽度**，而代码恰恰最缺宽度（实测 1400 宽的编辑区里，
 *   API 速查固定占 190px，代码只剩 283px ≈ 每行 30 个字符）。
 *   改成上下结构后：宽度全给代码，高度按需在「代码 ↔ 辅助」之间分配。
 *
 * 折叠状态持久化到 localStorage（key 见 AUX_COLLAPSE_KEY），下次打开还是上次的样子。
 * 高度也持久化（AUX_HEIGHT_KEY），双击分隔条复位到默认。
 */

/** 辅助区默认高度（px）；折叠时只剩标题条 */
const AUX_DEFAULT_H = 190;
/** 折叠后仅标题条的高度 */
const AUX_HEAD_H = 30;
const AUX_HEIGHT_KEY = "bwe.script.auxHeight";
const AUX_COLLAPSE_KEY = "bwe.script.auxCollapsed";

function readAuxHeight(): number {
  try {
    const v = Number(localStorage.getItem(AUX_HEIGHT_KEY));
    return Number.isFinite(v) && v >= AUX_HEAD_H ? v : AUX_DEFAULT_H;
  } catch {
    return AUX_DEFAULT_H;
  }
}

/**
 * 辅助区是否折叠。
 *
 * **默认折叠**：「用户报窗口太小」的修复核心就是把高度先给代码区。
 * 如果辅助区默认展开，纵向布局又会被它吃掉一块高度 —— 等于没修。
 * 用户一旦手动展开/折叠，状态就记下来（下次按他的意愿来）。
 */
function readAuxCollapsed(): boolean {
  try {
    const v = localStorage.getItem(AUX_COLLAPSE_KEY);
    if (v === null) return true; // 没有记录 = 首次 = 折叠
    return v === "1";
  } catch {
    return true;
  }
}

/**
 * 组装辅助区。返回 { box, resizer, expand, restore }。
 *
 * @param main     代码列容器（辅助区从它手里"拿走"高度）
 * @param diagBox 检查结果
 * @param stats   光标/规模统计
 * @param checkHead 检查标题行
 * @param apiPane API 速查面板（原来并排在右边，现已改为竖向叠放）
 */
function buildAuxSection(
  main: HTMLElement,
  diagBox: HTMLElement,
  stats: HTMLElement,
  checkHead: HTMLElement,
  apiPane: HTMLElement,
  /** 存储命名空间：JS 与 Yarn 的辅助内容不同，共用 key 会互相影响折叠状态 */
  ns = ""
): { box: HTMLElement; resizer: HTMLElement; expand: () => void; restore: () => void } {
  const heightKey = AUX_HEIGHT_KEY + (ns ? "." + ns : "");
  const collapseKey = AUX_COLLAPSE_KEY + (ns ? "." + ns : "");
  const readCollapsed = (): boolean => {
    try {
      const v = localStorage.getItem(collapseKey);
      if (v === null) return true; // 默认折叠（把高度先给代码）
      return v === "1";
    } catch {
      return true;
    }
  };
  const readHeight = (): number => {
    try {
      const v = Number(localStorage.getItem(heightKey));
      return Number.isFinite(v) && v >= AUX_HEAD_H ? v : AUX_DEFAULT_H;
    } catch {
      return AUX_DEFAULT_H;
    }
  };
  let collapsed = readCollapsed();
  let height = readHeight();

  const box = el("div", { class: "js-aux-section" });
  const head = el("div", { class: "js-aux-head" });
  const caret = el("span", { class: "js-aux-caret" }, collapsed ? "▸" : "▾");
  head.appendChild(caret);
  head.appendChild(el("span", { class: "js-aux-title" }, "辅助：检查 / 统计 / API 速查"));
  head.appendChild(el("div", { class: "spacer" }));
  // 折叠后仍要能看到"有没有错误"，所以把计数放在标题条上
  const statusHint = el("span", { class: "hint js-aux-status" }, "");
  head.appendChild(statusHint);
  const toggleBtn = button("折叠", () => setCollapsed(!collapsed), {
    size: "sm",
    variant: "ghost",
    title: "折叠 / 展开辅助区（记住状态）"
  });
  toggleBtn.dataset.scriptAuxToggle = "1";
  head.appendChild(toggleBtn);
  box.appendChild(head);

  const body = el("div", { class: "js-aux-body" });
  // 检查区在前（用户最关心"有没有错"），统计其次，API 速查最后（查资料用）
  body.appendChild(checkHead);
  body.appendChild(diagBox);
  body.appendChild(stats);
  body.appendChild(apiPane);
  box.appendChild(body);

  // ---- 分隔条：拖动改变辅助区高度，双击复位 ----
  const resizer = el("div", { class: "js-aux-resizer", title: "拖动调整高度，双击复位" });
  let dragging = false;
  let startY = 0;
  let startH = 0;
  const onMove = (e: MouseEvent): void => {
    if (!dragging) return;
    // 往上拖 = 辅助区变高
    setHeight(startH - (e.clientY - startY));
  };
  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
  };
  resizer.addEventListener("mousedown", (e) => {
    if (collapsed) return; // 折叠时不能拖（高度归零，拖了会跳）
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = box.getBoundingClientRect().height || height;
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  resizer.addEventListener("dblclick", () => {
    collapseState(false);
    setHeight(AUX_DEFAULT_H);
  });
  // 键盘可达：拖拽不该是唯一途径
  resizer.setAttribute("tabindex", "0");
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-label", "调整辅助区高度（方向键微调，回车复位）");
  resizer.addEventListener("keydown", (e) => {
    if (collapsed) return;
    const k = (e as KeyboardEvent).key;
    if (k === "ArrowUp") {
      e.preventDefault();
      setHeight(height + 16);
    } else if (k === "ArrowDown") {
      e.preventDefault();
      setHeight(height - 16);
    } else if (k === "Enter") {
      e.preventDefault();
      setHeight(AUX_DEFAULT_H);
    }
  });

  function setHeight(h: number): void {
    // 下限：折叠条高度；上限：不把代码区压到 160px 以下（那还不如关掉辅助区）
    const cap = Math.max(AUX_HEAD_H, main.getBoundingClientRect().height - 160);
    height = Math.max(AUX_HEAD_H, Math.min(cap, Math.round(h)));
    collapseState(false);
    box.style.flex = `0 0 ${height}px`;
    try {
      localStorage.setItem(heightKey, String(height));
    } catch {
      /* 隐私模式忽略 */
    }
  }

  function collapseState(next: boolean): void {
    collapsed = next;
    box.classList.toggle("collapsed", collapsed);
    caret.textContent = collapsed ? "▸" : "▾";
    toggleBtn.textContent = collapsed ? "展开" : "折叠";
    box.style.flex = collapsed ? `0 0 ${AUX_HEAD_H}px` : `0 0 ${height}px`;
    resizer.style.display = collapsed ? "none" : "";
    try {
      localStorage.setItem(collapseKey, collapsed ? "1" : "0");
    } catch {
      /* 隐私模式忽略 */
    }
  }

  function setCollapsed(next: boolean): void {
    collapseState(next);
  }

  /** 折叠状态下也要能报错数：脚本检查会把结果写到这里 */
  window.addEventListener("bwe:script-diag-count", (e) => {
    const d = (e as CustomEvent<{ errors: number; warns: number }>).detail;
    if (!d) return;
    statusHint.textContent = d.errors ? `${d.errors} 错误` : d.warns ? `${d.warns} 警告` : "无问题";
    statusHint.style.color = d.errors ? "var(--danger)" : d.warns ? "var(--warn)" : "var(--text-3)";
  });

  return {
    box,
    resizer,
    /**
     * 强制展开（折叠 -> 展开）。
     *
     * 为什么需要：辅助区**默认折叠**（把高度先给代码）。但「查找引用 / 编译」
     * 这类**用户主动按快捷键触发**的动作，结果是唯一的反馈 —— 折叠着就等于
     * 「按了 F12 什么也没发生」。所以结果到达时自动展开一次；
     * 用户再手动折叠，状态照旧被他自己的选择覆盖（不在这里强制改写 localStorage）。
     */
    expand: () => {
      if (!collapsed) return;
      collapseState(false);
    },
    restore: () => {
      // 首次挂载：按持久化状态铺好
      box.style.flex = collapsed ? `0 0 ${AUX_HEAD_H}px` : `0 0 ${height}px`;
      box.classList.toggle("collapsed", collapsed);
      resizer.style.display = collapsed ? "none" : "";
    }
  };
}

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
  // 与 JS 侧完全同一套排版：标题行 + VS Code 按钮合并成一行（24px）。
  // 为什么必须合并：JS 已合并、Yarn 没合并 → 同一份 UI 在两处不一致，
  // 用户打开 Yarn 会发现它比 JS 矮一截，然后回来报第二次。
  const edHead = el("div", { class: "row script-ed-head" });
  edHead.appendChild(el("div", { class: "group-label" }, "源码 Yarn"));
  edHead.appendChild(el("div", { class: "spacer" }));
  edHead.appendChild(el("span", { class: "hint" }, "改完即时生效 · Ctrl+S 保存"));
  wrap.appendChild(edHead);

  const ta = el("textarea", { class: "textarea script-yarn-source" });
  ta.value = script.source;
  // 与 JS 编辑器一致：撑满剩余高度而不是写死 minHeight:220px。
  // 用户报「窗口太小」在 Yarn 侧同样成立 —— 只改 JS 不改 Yarn，下次一定被投诉。
  ta.style.flex = "1 1 auto";
  ta.style.minHeight = "160px";
  ta.style.fontFamily = "var(--mono)";
  ta.style.fontSize = "12.5px";
  ta.addEventListener("input", () => {
    script.source = ta.value;
    store.markDirty();
    scheduleCheck();
  });

  // VS Code 工具条（Yarn 剧本也能拿 VS Code 编辑，扩展名 .yarn）
  // 合并进标题行：原来单独占一行，白扔 ~44px 高度
  renderVsCodeBar(
    edHead,
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

  // 检查结果 / 节点 / 变量：与 JS 侧同样收进可折叠的辅助区。
  // 为什么必须一起改：用户报「窗口太小」在 Yarn 侧同样成立；
  // 只修 JS 不修 Yarn，下次一定被投诉「Yarn 也一样小」。
  const yarnAuxHost = el("div", { class: "js-aux-body col" });
  const resultHead = el("div", { class: "group-label" }, "检查 Check");
  yarnAuxHost.appendChild(resultHead);
  const resultBox = el("div", { class: "col" });
  yarnAuxHost.appendChild(resultBox);

  const nodeBox = el("div", { class: "col" });
  const nodeHead = el("div", { class: "group-label" }, "节点 Nodes");
  nodeHead.style.marginTop = "8px";
  yarnAuxHost.appendChild(nodeHead);
  yarnAuxHost.appendChild(nodeBox);

  const varBox = el("div", { class: "col" });
  const varHead = el("div", { class: "group-label" }, "变量 Variables");
  varHead.style.marginTop = "8px";
  yarnAuxHost.appendChild(varHead);
  yarnAuxHost.appendChild(varBox);

  // 复用 JS 侧那套「可折叠 + 可拖分割 + 记住状态」的容器（同一份实现，避免两套交互漂移）
  const yarnAux = buildAuxSection(
    wrap,
    yarnAuxHost,
    el("span", { class: "hint" }),
    el("div"),
    el("div"),
    "yarn"
  );
  // buildAuxSection 会把 body 拼成「checkHead + diagBox + stats + apiPane」，
  // Yarn 侧只有一块内容，所以清掉占位、直接把 yarnAuxHost 放进去。
  const yarnBody = yarnAux.box.querySelector(".js-aux-body");
  if (yarnBody) {
    yarnBody.replaceChildren(yarnAuxHost);
    yarnAuxHost.style.padding = "0";
  }
  const yarnHeadTitle = yarnAux.box.querySelector(".js-aux-title");
  if (yarnHeadTitle) yarnHeadTitle.textContent = "辅助：检查 / 节点 / 变量";
  // 折叠状态与 JS 侧**分开存**：两边的辅助内容不同，共用一个 key 会让"我折叠 Yarn 结果把 JS 也折叠了"
  yarnAux.box.dataset.scriptAux = "yarn";
  wrap.appendChild(yarnAux.resizer);
  wrap.appendChild(yarnAux.box);
  yarnAux.restore();

  jumpToLineHook = (line: number) => {
    const pos = lineOffset(script.source, Math.max(1, Math.round(line)));
    ta.focus();
    ta.setSelectionRange(pos, Math.min(pos + 60, script.source.length));
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2 + lh / 2);
  };

  let timer = 0;
  function scheduleCheck(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(runCheck, 400);
  }

  function runCheck(): void {
    // 面板可能在工程被替换后还持有旧引用，这里再确认一次
    if (!script) return;
    const r = analyzeYarn(script.source);
    // 同样同步进「问题」面板：Yarn 的检查是本地静态规则，不需要服务端
    publishScriptProblems(
      "yarn",
      script.name || currentScript,
      r.checks.map((c) => ({
        line: c.line,
        severity: c.error ? "error" : "warn",
        message: c.message
      }))
    );
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
/**
 * 把一份诊断写进「问题」中心。
 *
 * 两个语言的检查器都走这里：key 固定为 `语言:脚本名`，所以同一份脚本
 * 反复检查只覆盖、不堆叠；没有错误时把这一组清掉，徽标才会真的归零。
 */
function publishScriptProblems(
  lang: ScriptLang,
  name: string,
  diags: { line: number; col?: number; severity: "error" | "warn" | "info"; message: string }[]
): void {
  const key = `${lang}:${name}`;
  if (!diags.length) {
    clearProblems(key);
    return;
  }
  const list: Problem[] = diags.map((d, i) => ({
    id: `${key}#${i}`,
    severity: d.severity,
    source: lang === "js" ? "js" : "yarn",
    sourceLabel: `剧本 · ${name}`,
    scriptName: name,
    scriptLang: lang,
    line: d.line,
    col: d.col,
    message: d.message
  }));
  setProblems(key, list);
}

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
  // 必须广播「剧本 UI 刷新」而不是笼统的 bwe:refresh：
  // 编辑区监听的是 bwe:refresh-script-ui（列表与编辑器分属两棵树），
  // 只发 bwe:refresh 会让"新建成功但编辑区仍显示空态"——这是实测发现的真 bug。
  refreshScriptUi();
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
