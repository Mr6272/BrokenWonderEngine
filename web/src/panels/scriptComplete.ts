/**
 * 脚本按需补全弹层 + 悬浮提示（剧本面板的 JS 编辑器用）。
 *
 * 纪律（每条都对应一个具体失败模式）：
 *   1. **键盘分派放在 textarea 的 keydown 最前面**（`if (open) { ...; return; }`），
 *      不是末尾追加 —— 否则 Enter 会「插入补全 + 换行」，用户得到半截代码 + 空行。
 *      分派规则本身在 scriptCompleteLogic.ts（纯函数，已单测）。
 *   2. **自动触发只在 bwe 成员链上**（`bwe.` / `bwe.world.` 之后），
 *      全文都弹会很吵；Ctrl+Space 手动兜底。
 *   3. **按命名空间分组**：271 条平铺没法选。
 *   4. **失败静默降级**：补全请求失败就当作"这次没有补全"，
 *      绝不弹红条打断打字；只在「输出」面板留**首次**一次痕（不刷屏）。
 *   5. `offset` 一律用 `ta.selectionStart`（UTF-16 code unit），
 *      与 TypeScript 的约定一致 —— 绝不自己按字符数算（中英混排/emoji 会错位）。
 */

import { el, clear } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { apiFetch } from "../core/host.ts";
import { appendOutput } from "../core/output.ts";
import { API_DOCS } from "../data/apiDocs.ts";
import {
  caretToPx,
  resolveKey,
  shouldAutoTrigger,
  completionPrefix,
  type CaretMetrics
} from "./scriptCompleteLogic.ts";

interface Entry {
  name: string;
  kind?: string;
  detail?: string;
  docs?: string;
  insertText?: string;
}

/** apiDocs 按名字索引：补全的 docs 用它的中文 desc（匹配不到就留空，不编造）。 */
const DOC_BY_NAME = new Map<string, { desc: string; signature: string }>();
for (const d of API_DOCS) DOC_BY_NAME.set(d.name, { desc: d.desc, signature: d.signature });

interface Ctx {
  /** 补全请求当前是否失败过（只记一次痕） */
  failedOnce: boolean;
  /** 最近一次请求的序号：丢弃过期响应（快速打字时会有多个在途请求） */
  seq: number;
}

/**
 * 把补全能力挂到一个 JS 编辑器上。
 *
 * @param ta      源码 textarea
 * @param codeBox 编辑器容器（弹层挂这里，定位用它的坐标）
 * @param onInsert 插入后需要做的收尾（刷新行号/统计/检查）
 */
export function attachScriptComplete(
  ta: HTMLTextAreaElement,
  codeBox: HTMLElement,
  onInsert: () => void
): () => void {
  const ctx: Ctx = { failedOnce: false, seq: 0 };

  // ---- 弹层 DOM（懒创建，首次打开才建） ----
  let pop: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;
  let entries: Entry[] = [];
  let selected = 0;
  let open = false;
  /** 当前补全触发时的替换起点（前缀开始处） */
  let replaceStart = 0;
  let debounceTimer = 0;

  const ensurePop = (): HTMLElement => {
    if (pop) return pop;
    pop = el("div", { class: "sc-pop" });
    pop.dataset.scriptComplete = "1";
    listEl = el("div", { class: "sc-pop-list" });
    pop.appendChild(listEl);
    codeBox.appendChild(pop);
    // 弹层自己不吃鼠标事件（点击选择交给 mousedown，位置由键盘/点击控制）
    pop.addEventListener("mousedown", (e) => e.preventDefault());
    return pop;
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    entries = [];
    selected = 0;
    if (pop) pop.style.display = "none";
    ta.focus();
  };

  const isOpen = (): boolean => open;

  // ---- 渲染 ----
  const renderList = (): void => {
    const host = listEl;
    if (!host) return;
    clear(host);
    if (!entries.length) {
      host.appendChild(el("div", { class: "hint sc-pop-empty" }, "没有匹配项"));
      return;
    }
    // **按命名空间分组**：271 条平铺没法选。
    // 分组键取 `kind`（TS 的 class/namespace/function…）不够直观，
    // 所以按"成员所属的父级"分组 —— 从当前前缀推断不出父级，
    // 就退化为按 kind 分组（至少比一整条平铺好）。
    const groups = new Map<string, { idx: number; e: Entry }[]>();
    entries.forEach((e, idx) => {
      const g = groupOf(e);
      const arr = groups.get(g);
      if (arr) arr.push({ idx, e });
      else groups.set(g, [{ idx, e }]);
    });
    let flatIndex = 0;
    for (const [g, arr] of groups) {
      host.appendChild(el("div", { class: "sc-pop-group" }, `${g} · ${arr.length}`));
      for (const it of arr) {
        const row = el("button", { type: "button", class: "sc-pop-row" });
        row.dataset.scIndex = String(it.idx);
        row.appendChild(el("span", { class: "sc-pop-name" }, it.e.name));
        const detail = it.e.detail ? cleanDetail(it.e.detail) : "";
        if (detail) row.appendChild(el("span", { class: "sc-pop-detail" }, detail));
        if (it.idx === selected) row.classList.add("active");
        row.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          selected = it.idx;
          accept();
        });
        host.appendChild(row);
        flatIndex++;
      }
    }
    void flatIndex;
    // 选中项滚进视野
    const activeRow = host.querySelector(".sc-pop-row.active") as HTMLElement | null;
    activeRow?.scrollIntoView({ block: "nearest" });
  };

  /**
   * 分组名。
   *
   * 用户要的是「按命名空间分组」（world / graphics / audio …），
   * 但 `bwe.` 根对象的候选本身**就是命名空间**（`bwe.world` / `bwe.draw` …），
   * 而命名空间成员的候选（`bwe.world.` 之后）才需要按**父命名空间**分组。
   *
   * 所以分组键 =
   *   · 若当前在根上（候选是命名空间本身）→ 按成员类型分（命名空间 / 常量 / 函数）；
   *   · 若在某命名空间下 → 全归该命名空间（一个组，标题用命名空间名）。
   * 第一版直接用 detail 里的 `bwe.World.` 去猜，结果根对象的 54 条全是
   *   "members"，等于没分组 —— 那样的话"按命名空间分组"这条要求就没做到。
   */
  const groupOf = (e: Entry): string => {
    const d = String(e.detail || "");
    const nsInDetail = /bwe\.([A-Za-z]+)\./.exec(d);
    if (nsInDetail) return nsInDetail[1].toLowerCase();
    // 根对象上的成员：按类型分。
    // ⚠ kind 的实际取值是 `constant` / `function`（不是 TS 内部的 `const`），
    //   第一版写成 `const` → 37 条全落进"其它"，分组标题显示成「其它 · 37」。
    //   这类"猜枚举值"的错只能靠实际跑一次看出来。
    const k = String(e.kind || "other");
    if (k === "namespace" || k === "constant" || k === "const" || k === "let" || k === "var") {
      return "命名空间与常量";
    }
    if (k === "function" || k === "method") return "函数";
    if (k === "property") return "属性";
    return "其它";
  };

  /** TS 的 detail 形如 `(method) bwe.World.clear(): void`，去掉前缀只留签名。 */
  const cleanDetail = (d: string): string =>
    String(d).replace(/^(\([^)]*\)\s*)?(function\s+)?bwe\.(?:[A-Z][\w$]*\.)?/, "").slice(0, 80);

  // ---- 定位 ----
  const metrics = (): CaretMetrics => {
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 19;
    // 等宽字体：用 0 的宽度当作字符宽度（比平均值准，且不会因内容变化而抖动）
    const chW = measureCharWidth(ta, cs);
    return {
      contentWidth: ta.clientWidth - padX(cs),
      contentHeight: Math.max(
        0,
        ta.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0)
      ),
      scrollTop: ta.scrollTop,
      scrollLeft: ta.scrollLeft,
      lineHeight: lh,
      charWidth: chW,
      tabSize: Number(cs.tabSize) || 2
    };
  };

  const place = (): void => {
    if (!pop) return;
    const pos = caretToPx(ta.value, ta.selectionStart, metrics());
    const cs = getComputedStyle(ta);
    const boxRect = codeBox.getBoundingClientRect();
    const taRect = ta.getBoundingClientRect();
    // caretToPx 给的是**内容区**坐标（第 0 行顶部 = 内容原点）。
    // 内容的视觉原点 = textarea 左上 + paddingTop/paddingLeft，所以要**精确**加 padding
    // （第一版加了 padding/2 的估算值，会让弹层纵向偏 3~4px）。
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const baseX = taRect.left - boxRect.left + padLeft;
    const baseY = taRect.top - boxRect.top + padTop;
    let left = baseX + pos.x;
    let top = baseY + pos.y + pos.lineHeight + 2;   // 光标行**下方**
    const popW = pop.offsetWidth || 340;
    const popH = pop.offsetHeight || 200;
    left = Math.max(4, Math.min(left, Math.max(4, codeBox.clientWidth - popW - 4)));
    if (top + popH > codeBox.clientHeight) {
      // 下方放不下 → 翻到光标行上方（vs code 同款行为）
      top = Math.max(4, baseY + pos.y - popH - 2);
    }
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
  };

  // ---- 请求 ----
  const request = async (): Promise<void> => {
    const source = ta.value;
    const offset = ta.selectionStart;   // UTF-16，与 TS 约定一致
    const mine = ++ctx.seq;
    let entriesRaw: Entry[] = [];
    try {
      const resp = await apiFetch("/api/script-complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, offset })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as { ok?: boolean; entries?: Entry[]; error?: string };
      if (data?.ok === false) throw new Error(data.error || "补全服务返回失败");
      entriesRaw = Array.isArray(data?.entries) ? data.entries : [];
    } catch (e) {
      // **静默降级**：补全失败就当"这次没有补全"，绝不弹红条打断打字。
      // 只在「输出」面板留**首次**一次痕（不刷屏）。
      if (!ctx.failedOnce) {
        ctx.failedOnce = true;
        appendOutput("脚本补全", `补全不可用，已静默降级：${(e as Error)?.message || e}`, "warn");
      }
      return;
    }
    if (mine !== ctx.seq) return;   // 有更新的请求了，丢掉旧结果

    // 本地按前缀过滤（服务端也给过滤后的，这里再filter一次保证 Ctrl+Space 空前缀时全量）
    const { prefix } = completionPrefix(ta.value, offset);
    const filtered = prefix
      ? entriesRaw.filter((e) => e.name.toLowerCase().startsWith(prefix.toLowerCase()))
      : entriesRaw;
    if (!filtered.length) {
      close();
      return;
    }
    replaceStart = offset - prefix.length;
    entries = filtered;
    selected = 0;
    open = true;
    ensurePop();
    renderList();
    place();
    pop!.style.display = "";
  };

  // ---- 接受补全 ----
  const accept = (): void => {
    const e = entries[selected];
    if (!e) return;
    const insert = e.insertText || e.name;
    const start = replaceStart;
    const end = ta.selectionStart;
    ta.setRangeText(insert, start, end, "end");
    close();
    onInsert();
  };

  // ---- 键盘：必须在最前面拦（见文件头纪律 1） ----
  const onKeyDown = (ev: KeyboardEvent): void => {
    const d = resolveKey(ev.key, open, entries.length);
    if (d.preventDefault) ev.preventDefault();
    if (d.stopPropagation) ev.stopPropagation();
    if (d.action === "ignore") return;
    if (d.action === "close") {
      close();
      return;
    }
    if (d.action === "insert") {
      accept();
      return;
    }
    if (d.action === "move-up") {
      selected = (selected - 1 + entries.length) % entries.length;
      renderList();
      return;
    }
    if (d.action === "move-down") {
      selected = (selected + 1) % entries.length;
      renderList();
      return;
    }
  };
  // 捕获阶段：比 textarea 自己的其它监听器更早拿到事件
  ta.addEventListener("keydown", onKeyDown, true);

  // ---- 输入：自动触发（debounce 120ms） + 手动 Ctrl+Space ----
  const onInput = (): void => {
    if (open) {
      // 弹层开着时继续输入 → 重新请求（debounce）
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => void request(), 120);
      return;
    }
    if (!shouldAutoTrigger(ta.value, ta.selectionStart)) return;
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => void request(), 120);
  };
  ta.addEventListener("input", onInput);

  const onManual = (ev: KeyboardEvent): void => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.code !== "Space") return;
    ev.preventDefault();
    ev.stopPropagation();
    void request();
  };
  ta.addEventListener("keydown", onManual, true);

  // ---- 失焦 / 滚动 / 尺寸变化时收起 ----
  const onBlur = (): void => {
    window.setTimeout(() => close(), 120);
  };
  const onScroll = (): void => {
    if (open) close();
  };
  ta.addEventListener("blur", onBlur);
  ta.addEventListener("scroll", onScroll);

  // 返回清理函数（面板重建时调用，避免监听器越积越多）
  return () => {
    window.clearTimeout(debounceTimer);
    ta.removeEventListener("keydown", onKeyDown, true);
    ta.removeEventListener("keydown", onManual, true);
    ta.removeEventListener("input", onInput);
    ta.removeEventListener("blur", onBlur);
    ta.removeEventListener("scroll", onScroll);
    pop?.remove();
    pop = null;
    listEl = null;
  };
}

// ---------------- 小工具 ----------------

function padX(cs: CSSStyleDeclaration): number {
  return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
}

/** 量一个字符的宽度：用一个隐藏 span 里的 "0"，与 textarea 同字体。 */
function measureCharWidth(ta: HTMLTextAreaElement, cs: CSSStyleDeclaration): number {
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(10);
  probe.style.cssText =
    "position:absolute;left:-9999px;top:0;white-space:pre;"
    + `font-family:${cs.fontFamily};font-size:${cs.fontSize};letter-spacing:${cs.letterSpacing};`;
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return Number.isFinite(w) && w > 0 ? w : 8;
  void ta;
}

void clear;
void I;
