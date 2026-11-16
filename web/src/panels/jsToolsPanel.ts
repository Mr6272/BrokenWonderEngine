/**
 * 编辑器的下部「工具栏」：检查 / 大纲 / 引用 / 编译 / API 速查（可切换的页签）。
 *
 * ── 为什么改成页签 ──────────────────────────────────────────────────
 * 原来这块是**竖着堆**的：检查结果 + 统计 + API 速查。加了引用、定义、大纲、编译产物之后
 * 竖着堆会让每一块都只剩两三行高 —— 而这几块恰恰是"要连着看很多条"的列表。
 * 页签让每一块都能独占这块高度，同时保留原来的折叠 / 拖分割（复用 buildAuxSection）。
 *
 * ── 两条纪律 ────────────────────────────────────────────────────────
 *   1. **页签切换不能重建内容**：每个 pane 只创建一次，切换只改 class。否则用户
 *      每点一次页签，引用列表就被清空重刷一次（看起来像"搜索又跑了一遍"）。
 *   2. **计数徽标只在有内容时出现**：`0` 也是个信息（"查过了，没有"），但空态已经
 *      用文字说了，再挂一个 `0` 只会让标题栏闪。
 */

import { el, clear, button } from "../core/dom.ts";
import type { Diagnostic, ReferenceHit } from "./jsCodeIntel.ts";
import type { OutlineItem } from "./jsEditorLogic.ts";

export type ToolsTabId = "check" | "outline" | "refs" | "build" | "api";

export interface JsToolsHooks {
  /** 点一条引用/定义/大纲：跳到对应脚本的对应行 */
  jumpTo(scriptName: string, line: number, col: number): void;
  /** 「重新检查」按钮 */
  recheck(): void;
  /** 「编译」按钮（在 build 页签里也放一个，用户不必回到顶部工具栏） */
  compile(): void;
}

export interface JsToolsPanel {
  root: HTMLElement;
  showTab(id: ToolsTabId): void;
  activeTab(): ToolsTabId;
  /** 检查结果（来自 js-check 或本地语法兜底） */
  setCheck(diags: Diagnostic[], fromServer: boolean): void;
  setOutline(items: OutlineItem[]): void;
  /** 引用 / 定义结果；`hint` 是空态文案（两者语义不同，必须分开） */
  setRefs(title: string, refs: ReferenceHit[], hint: string): void;
  /** 编译结果（已降级的 ES5 + 诊断） */
  setCompile(result: { ok: boolean; hasTypes: boolean; diagnostics: Diagnostic[]; transpiled: string } | null): void;
  /** 外部（API 速查面板）塞进来的元素，挂在最后一个页签 */
  mountApiPane(node: HTMLElement): void;
}

const TABS: { id: ToolsTabId; label: string }[] = [
  { id: "check", label: "检查 Check" },
  { id: "outline", label: "大纲 Outline" },
  { id: "refs", label: "引用 References" },
  { id: "build", label: "编译 Build" },
  { id: "api", label: "API 速查" }
];

export function createJsTools(hooks: JsToolsHooks): JsToolsPanel {
  const root = el("div", { class: "js-tools" });
  root.dataset.jsTools = "1";

  const tabsBar = el("div", { class: "js-tabs" });
  tabsBar.setAttribute("role", "tablist");
  const tabButtons = new Map<ToolsTabId, HTMLButtonElement>();
  const badges = new Map<ToolsTabId, HTMLElement>();

  for (const t of TABS) {
    const b = el("button", { type: "button", class: "js-tab", title: `切到「${t.label}」` }, t.label);
    b.dataset.jsToolsTab = t.id;
    b.setAttribute("role", "tab");
    const badge = el("span", { class: "js-tab-badge" });
    badge.style.display = "none";
    b.appendChild(badge);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      showTab(t.id);
    });
    tabsBar.appendChild(b);
    tabButtons.set(t.id, b);
    badges.set(t.id, badge);
  }
  const spacer = el("div", { class: "spacer" });
  tabsBar.appendChild(spacer);
  tabsBar.appendChild(button("重新检查", () => hooks.recheck(), { size: "sm", variant: "ghost", title: "重新请求 /api/js-check" }));
  root.appendChild(tabsBar);

  // ---- 五个 pane（只创建一次，切换只改 class）----
  const pane = (id: ToolsTabId): HTMLElement => {
    const p = el("div", { class: "js-tabpane" });
    p.dataset.jsToolsPane = id;
    p.setAttribute("role", "tabpanel");
    return p;
  };

  // 检查
  const checkPane = pane("check");
  const checkState = el("div", { class: "hint js-check-state" }, "待检查");
  const diagBox = el("div", { class: "js-diag-list" });
  checkPane.appendChild(checkState);
  checkPane.appendChild(diagBox);

  // 大纲
  const outlinePane = pane("outline");
  const outlineBox = el("div");
  outlinePane.appendChild(outlineBox);

  // 引用
  const refsPane = pane("refs");
  const refsTitle = el("div", { class: "hint" }, "把光标放在一个函数名/变量名上，按 Shift+F12");
  const refsBox = el("div");
  refsPane.appendChild(refsTitle);
  refsPane.appendChild(refsBox);

  // 编译
  const buildPane = pane("build");
  const buildHead = el("div", { class: "row tight" });
  const buildState = el("span", { class: "hint" }, "点「编译」看这一版脚本能不能跑");
  buildHead.appendChild(buildState);
  buildHead.appendChild(el("div", { class: "spacer" }));
  buildHead.appendChild(button("编译", () => hooks.compile(), { size: "sm", variant: "primary", title: "语法检查 + 降级到 ES5（Ctrl+B）" }));
  const buildMeta = el("div", { class: "js-compile-meta" }, "");
  const buildOut = el("div", { class: "js-compile-out" }, "");
  buildOut.style.display = "none";
  buildPane.appendChild(buildHead);
  buildPane.appendChild(buildMeta);
  buildPane.appendChild(buildOut);

  // API 速查（内容由外部挂载）
  const apiPane = pane("api");

  const panes = new Map<ToolsTabId, HTMLElement>([
    ["check", checkPane],
    ["outline", outlinePane],
    ["refs", refsPane],
    ["build", buildPane],
    ["api", apiPane]
  ]);
  for (const p of panes.values()) root.appendChild(p);

  let active: ToolsTabId = "check";

  function showTab(id: ToolsTabId): void {
    active = id;
    for (const [key, el2] of panes) el2.classList.toggle("on", key === id);
    for (const [key, btn] of tabButtons) {
      btn.classList.toggle("on", key === id);
      btn.setAttribute("aria-selected", String(key === id));
    }
  }

  function setBadge(id: ToolsTabId, text: string): void {
    const b = badges.get(id);
    if (!b) return;
    if (!text) {
      b.style.display = "none";
      b.textContent = "";
      return;
    }
    b.style.display = "";
    b.textContent = text;
  }

  /** 一行可点击的结果（引用/大纲共用观感）。 */
  const resultRow = (opts: {
    where: string;
    text: string;
    badge?: string;
    kindLabel?: string;
    title?: string;
    onClick: () => void;
  }): HTMLElement => {
    const row = el("div", { class: "js-ref-row", title: opts.title });
    if (opts.kindLabel) row.appendChild(el("span", { class: "js-outline-kind" }, opts.kindLabel));
    row.appendChild(el("span", { class: "js-ref-where" }, opts.where));
    if (opts.badge) row.appendChild(el("span", { class: "js-ref-badge" }, opts.badge));
    row.appendChild(el("span", { class: "js-ref-text" }, opts.text));
    row.addEventListener("click", opts.onClick);
    return row;
  };

  // ---- 内置"当前脚本名"，用于在引用列表里区分本文件/其它文件 ----
  let activeScript = "";
  const setActiveScript = (name: string): void => {
    activeScript = name;
  };
  void setActiveScript;

  return {
    root,
    showTab,
    activeTab: () => active,

    setCheck(diags: Diagnostic[], fromServer: boolean): void {
      const errors = diags.filter((d) => d.severity === "error").length;
      const warns = diags.filter((d) => d.severity === "warn").length;
      checkState.textContent = fromServer
        ? `服务器诊断 · ${errors} 错误 ${warns} 警告`
        : `本地语法兜底 · ${errors} 错误（/api/js-check 未就绪）`;
      setBadge("check", errors ? String(errors) : warns ? `${warns}!` : "");
      clear(diagBox);
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
      diags.forEach((d, i) => {
        const row = el("div", {
          class: `js-diag ${d.severity}`,
          title: d.col ? `第 ${d.line} 行 第 ${d.col} 列 · 点击跳到这一行` : `第 ${d.line} 行 · 点击跳到这一行`
        });
        row.dataset.jsDiag = String(i);
        row.appendChild(el("span", { class: "js-diag-where" }, `第 ${d.line} 行`));
        row.appendChild(el("span", { class: "js-diag-msg" }, d.message));
        row.addEventListener("click", () => hooks.jumpTo(activeScript, d.line, d.col ?? 1));
        diagBox.appendChild(row);
      });
    },

    setOutline(items: OutlineItem[]): void {
      clear(outlineBox);
      setBadge("outline", items.length ? String(items.length) : "");
      if (!items.length) {
        outlineBox.appendChild(el("div", { class: "hint" }, "这段脚本里没有可列出的大纲（函数 / 类 / 顶层变量 / 分节注释）。"));
        return;
      }
      const KIND_LABEL: Record<string, string> = {
        lifecycle: "钩子",
        function: "函数",
        class: "类",
        variable: "变量",
        section: "分节"
      };
      for (const it of items) {
        const row = resultRow({
          kindLabel: KIND_LABEL[it.kind] ?? "",
          where: `第 ${it.line} 行`,
          text: it.label,
          title: `${KIND_LABEL[it.kind] ?? ""} · 第 ${it.line} 行`,
          onClick: () => hooks.jumpTo(activeScript, it.line, it.col)
        });
        // 缩进用文字前缀而不是 margin：列表要能被 .js-ref-text 的省略号规则一起处理
        (row.querySelector(".js-ref-text") as HTMLElement | null)?.style.setProperty(
          "padding-left",
          `${Math.min(3, it.depth) * 10}px`
        );
        outlineBox.appendChild(row);
      }
    },

    setRefs(title: string, refs: ReferenceHit[], hint: string): void {
      refsTitle.textContent = title;
      setBadge("refs", refs.length ? String(refs.length) : "");
      clear(refsBox);
      if (!refs.length) {
        refsBox.appendChild(el("div", { class: "hint" }, hint));
        return;
      }
      for (const r of refs) {
        const isDts = r.name === "__bwe_dts__";
        const row = resultRow({
          where: isDts ? "bwe API" : `${r.name}:${r.line}`,
          text: r.text,
          badge: r.isDefinition ? "定义" : isDts ? "内置" : "",
          title: isDts
            ? `内置 API 声明：${r.text}`
            : `${r.name} 第 ${r.line} 行 第 ${r.col} 列${r.isDefinition ? "（定义）" : ""}`,
          onClick: () => {
            if (isDts) return; // d.ts 是编辑器内的只读声明，点了没有可跳的位置
            hooks.jumpTo(r.name, r.line, r.col);
          }
        });
        if (r.isDefinition) (row.querySelector(".js-ref-badge") as HTMLElement | null)?.classList.add("def");
        refsBox.appendChild(row);
      }
    },

    setCompile(result): void {
      clear(buildOut);
      if (!result) {
        buildState.textContent = "点「编译」看这一版脚本能不能跑";
        buildMeta.textContent = "";
        buildOut.style.display = "none";
        setBadge("build", "");
        return;
      }
      const errors = result.diagnostics.filter((d) => d.severity === "error").length;
      const warns = result.diagnostics.filter((d) => d.severity === "warn").length;
      buildState.textContent = errors
        ? `✗ ${errors} 个错误，修好才能打包`
        : `✓ 通过${warns ? `（${warns} 个警告）` : ""}`;
      setBadge("build", errors ? String(errors) : "");
      const lines = result.transpiled ? result.transpiled.split("\n").length : 0;
      buildMeta.textContent = `ES5 产物 ${lines} 行 · ${result.transpiled.length} 字符 · ${result.hasTypes ? "bwe.d.ts 已加载" : "只做了语法检查（bwe.d.ts 不可用）"}`;
      if (!result.transpiled) {
        buildOut.style.display = "none";
        return;
      }
      buildOut.textContent = result.transpiled;
      buildOut.style.display = "";
    },

    mountApiPane(node: HTMLElement): void {
      clear(apiPane);
      node.classList.add("js-api");
      apiPane.appendChild(node);
    }
  };
}
