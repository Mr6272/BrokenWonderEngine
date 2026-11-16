/**
 * 编辑器里的查找 / 替换条（Ctrl+F / Ctrl+H）。
 *
 * ── 为什么不用浏览器自带的 Ctrl+F ────────────────────────────────────
 * 浏览器查找只能翻 textarea 的可见文本，既不能替换，也不会和「当前脚本」绑定；
 * 而用户真正要的是「在这段脚本里改掉这 7 个 loadLevel」。
 *
 * ── 三条纪律（都是实测踩出来的）─────────────────────────────────────
 *   1. **输入框里的按键不能再冒泡回编辑器**：findbar 的 input 在 keydown 时必须
 *      `stopPropagation`，否则编辑器自己的 Tab 缩进/Ctrl+S 会在用户打字时抢键。
 *   2. **重新计算与"选中"分离**：`refresh()` 只重算命中并更新计数（每次输入都跑），
 *      `goto()` 才真正移动光标。混在一起会导致"改一个字母就把用户光标抢走"。
 *   3. **计数文案与命中数永远同源**：`无匹配` / `3 处` / `20000+ 处` 全从 findMatches 来，
 *      不要另写一套统计 —— 两套数字不一致时用户会怀疑搜索坏了。
 */

import { el, button } from "../core/dom.ts";
import {
  findMatches,
  formatMatchCount,
  matchIndexAtSelection,
  nextMatchIndex,
  replaceMatches,
  type FindOptions,
  type Match
} from "./jsEditorLogic.ts";

export type FindMode = "find" | "replace";

export interface FindBarHooks {
  /**
   * 把某个命中选中并滚进视野。
   *
   * @param focusEditor 是否把焦点交给编辑器。
   *   ⚠ 查找条自己驱动的跳转**必须传 false**：焦点一旦离开输入框，
   *   用户接着敲的字就进了代码而不是查找框（第一版就是这样：打开 Ctrl+F 后
   *   焦点被 goto 抢回 textarea，等于查找到了、但输不了第二个字符）。
   */
  goto(match: Match, focusEditor: boolean): void;
  /** 文本被替换后：写回源码 + 刷新行号/检查。`label` 进撤销栈（替换必须可 Ctrl+Z 撤销）。 */
  applyReplace(nextText: string, label: string): void;
  /** 「在工程中查找」：把查询词交给左侧搜索面板 */
  searchProject(query: string): void;
  /** 当前编辑器文本 */
  getText(): string;
  /** 当前选区（用于「替换当前」判断该换哪一个） */
  getSelection(): { start: number; end: number };
}

export interface FindBar {
  root: HTMLElement;
  show(mode: FindMode): void;
  hide(): void;
  isOpen(): boolean;
  isReplaceMode(): boolean;
  /** 文本或开关变化后重算命中（不移动光标） */
  refresh(): void;
  /** 命中列表与当前下标（高亮覆盖层用） */
  state(): { matches: Match[]; currentIndex: number; query: string };
  next(forward: boolean): void;
  /** 编辑器文本变了但 findbar 没变（用户在用 Alt+↑ 移行等）时，让选区命中跟随 */
  syncSelection(): void;
  destroy(): void;
}

/**
 * @param host 编辑器容器（`.js-code`）—— findbar 绝对定位在它右上角
 */
export function createFindBar(host: HTMLElement, hooks: FindBarHooks): FindBar {
  const root = el("div", { class: "js-findbar" });
  root.style.display = "none";
  root.dataset.jsFindbar = "1";

  const findInput = el("input", { type: "text", placeholder: "查找", spellcheck: "false" });
  findInput.dataset.jsFindInput = "1";
  const replaceInput = el("input", { type: "text", placeholder: "替换为", spellcheck: "false" });
  replaceInput.dataset.jsReplaceInput = "1";
  // ⚠ 替换框的显隐**只由整行控制**（replaceRow.style.display）。
  //   第一版还给 input 自己也设了 display:none，结果整行显示出来了、输入框却仍是 0×0 ——
  //   表现为「Ctrl+H 没反应」，而实际上只是输入框自己被藏了。
  //   一个元素只允许有一个显隐开关，否则两者迟早不一致。

  const countEl = el("span", { class: "js-find-count" }, "");
  countEl.dataset.jsFindCount = "1";

  const opts: Required<FindOptions> = { caseSensitive: false, wholeWord: false, regex: false };

  const toggle = (label: string, title: string, key: keyof FindOptions): HTMLButtonElement => {
    const b = el("button", { type: "button", class: "js-find-toggle", title }, label);
    b.dataset.jsFindToggle = key;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", (e) => {
      e.preventDefault();
      (opts as unknown as Record<string, boolean>)[key] = !(opts as unknown as Record<string, boolean>)[key];
      b.classList.toggle("on", (opts as unknown as Record<string, boolean>)[key]);
      b.setAttribute("aria-pressed", String((opts as unknown as Record<string, boolean>)[key]));
      refresh(true);
      findInput.focus();
    });
    return b;
  };

  const caseBtn = toggle("Aa", "区分大小写", "caseSensitive");
  const wordBtn = toggle("W", "全词匹配（cat 不命中 concat）", "wholeWord");
  const regexBtn = toggle(".*", "按正则表达式匹配", "regex");

  const prevBtn = button("↑", () => step(false), { size: "sm", variant: "ghost", title: "上一个（Shift+Enter）" });
  const nextBtn = button("↓", () => step(true), { size: "sm", variant: "ghost", title: "下一个（Enter）" });
  const replaceOneBtn = button("替换", () => replaceCurrent(), { size: "sm", variant: "ghost", title: "替换当前这一处" });
  const replaceAllBtn = button("全部替换", () => replaceAll(), { size: "sm", variant: "ghost", title: "替换全部命中" });
  const projectBtn = button("工程内", () => hooks.searchProject(findInput.value), {
    size: "sm",
    variant: "ghost",
    title: "在所有脚本里搜同一个词（左栏「搜索」）"
  });
  const closeBtn = el("button", { type: "button", class: "js-find-close", title: "关闭（Esc）" }, "×");

  const replaceRow = el("div", { class: "js-findbar-row" });
  replaceRow.style.display = "none";
  replaceRow.appendChild(replaceInput);
  replaceRow.appendChild(replaceOneBtn);
  replaceRow.appendChild(replaceAllBtn);

  const mainRow = el("div", { class: "js-findbar-row" });
  for (const n of [findInput, countEl, caseBtn, wordBtn, regexBtn, prevBtn, nextBtn, projectBtn, closeBtn]) mainRow.appendChild(n);

  root.appendChild(mainRow);
  root.appendChild(replaceRow);
  host.appendChild(root);

  let matches: Match[] = [];
  let currentIndex = -1;
  let open = false;
  let mode: FindMode = "find";

  const matchesNow = (): Match[] => findMatches(hooks.getText(), findInput.value, opts);

  const paintCount = (): void => {
    if (!findInput.value) {
      countEl.textContent = "";
      return;
    }
    countEl.textContent =
      matches.length === 0 ? formatMatchCount(matches) : `${currentIndex >= 0 ? currentIndex + 1 : "–"}/${formatMatchCount(matches)}`;
  };

  /** 重算命中。`keepCursor` 为 true 时按当前选区重新定位"当前命中"，不主动跳转。 */
  function refresh(keepCursor = false): void {
    const before = matches;
    matches = matchesNow();
    if (!matches.length) {
      currentIndex = -1;
      paintCount();
      return;
    }
    if (keepCursor || currentIndex < 0) {
      const sel = hooks.getSelection();
      const atSel = matchIndexAtSelection(matches, sel.start, sel.end);
      currentIndex = atSel >= 0 ? atSel : Math.min(currentIndex < 0 ? 0 : currentIndex, matches.length - 1);
    } else {
      // 文本变了：尽量停在"原来那个位置附近"，避免每敲一个字选区就跳回开头
      const prevStart = before[Math.max(0, currentIndex)]?.start ?? 0;
      currentIndex = Math.min(matches.findIndex((m) => m.start >= prevStart), matches.length - 1);
      if (currentIndex < 0) currentIndex = 0;
    }
    paintCount();
  }

  function step(forward: boolean): void {
    if (!matches.length) return;
    const sel = hooks.getSelection();
    // 光标正好落在当前命中里时，从"这个命中之后/之前"开始找，否则会卡在原地不动
    const anchor = forward ? sel.end : sel.start;
    const idx = nextMatchIndex(matches, anchor, forward);
    if (idx < 0) return;
    currentIndex = idx;
    paintCount();
    hooks.goto(matches[idx], false);
  }

  function gotoFirst(): void {
    if (!matches.length) return;
    currentIndex = 0;
    paintCount();
    hooks.goto(matches[0], false);
  }

  function replaceCurrent(): void {
    if (!matches.length) return;
    const sel = hooks.getSelection();
    let idx = matchIndexAtSelection(matches, sel.start, sel.end);
    if (idx < 0) idx = currentIndex >= 0 ? currentIndex : 0;
    const m = matches[idx];
    if (!m) return;
    const text = hooks.getText();
    const next = text.slice(0, m.start) + replaceInput.value + text.slice(m.end);
    hooks.applyReplace(next, "查找替换");
    refresh(false);
    // 替换后选中下一个命中，用户连按「替换」就能一个个过（这是所有编辑器的通例）
    const after = matches[Math.min(idx, matches.length - 1)];
    if (after) {
      currentIndex = Math.min(idx, matches.length - 1);
      paintCount();
      hooks.goto(after, false);
    }
  }

  function replaceAll(): void {
    if (!matches.length) return;
    const res = replaceMatches(hooks.getText(), matches, replaceInput.value);
    if (!res.count) {
      refresh(true);
      return;
    }
    hooks.applyReplace(res.text, "全部替换");
    refresh(true);
  }

  function show(nextMode: FindMode): void {
    open = true;
    mode = nextMode;
    root.style.display = "";
    const isRepl = mode === "replace";
    replaceRow.style.display = isRepl ? "" : "none";
    replaceAllBtn.style.display = isRepl ? "" : "none";
    // 带选区打开时把选区当成默认查询词（VS Code 行为）
    const sel = hooks.getSelection();
    if (!findInput.value && sel.end > sel.start) {
      const picked = hooks.getText().slice(sel.start, sel.end);
      if (picked && !picked.includes("\n")) findInput.value = picked;
    }
    findInput.focus();
    findInput.select();
    refresh(true);
    if (findInput.value) gotoFirst();
  }

  function hide(): void {
    if (!open) return;
    open = false;
    root.style.display = "none";
    // 关掉查找后把焦点还给编辑器 —— 否则用户按完 Esc 继续打字，字打到了不可见的输入框里
    const ta = host.querySelector("textarea.js-source") as HTMLTextAreaElement | null;
    ta?.focus();
  }

  findInput.addEventListener("input", () => {
    refresh(false);
    if (matches.length) gotoFirst();
  });
  // 替换框里按 Enter = 替换当前；Ctrl+Alt+Enter = 全部替换（避免误触）
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.altKey) replaceAll();
      else replaceCurrent();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  });
  findInput.addEventListener("keydown", (e) => {
    // 必须 stopPropagation：否则编辑器的 Tab 缩进、Ctrl+S 会在 findbar 里抢键
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      step(!e.shiftKey);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hide();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
      e.preventDefault();
      e.stopPropagation();
      show(mode === "replace" ? "find" : "replace");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      findInput.select();
      return;
    }
    e.stopPropagation();
  });
  closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    hide();
  });

  return {
    root,
    show,
    hide,
    isOpen: () => open,
    isReplaceMode: () => mode === "replace",
    refresh: () => refresh(false),
    state: () => ({ matches, currentIndex, query: findInput.value }),
    next: (forward) => step(forward),
    syncSelection: () => {
      if (!open || !matches.length) return;
      const sel = hooks.getSelection();
      const at = matchIndexAtSelection(matches, sel.start, sel.end);
      if (at >= 0 && at !== currentIndex) {
        currentIndex = at;
        paintCount();
      }
    },
    destroy: () => root.remove()
  };
}
