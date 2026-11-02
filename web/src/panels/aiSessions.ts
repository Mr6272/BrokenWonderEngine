/**
 * AI 会话切换器（多会话 UI）。
 *
 * 数据来自 `host.ts` 的正式门面（A 已补齐）：
 *   aiSessionsList / aiSessionNew / aiSessionSwitch / aiSessionDelete / sessionsAvailable
 *
 * 三条**必须**遵守的语义（违反会产生"回答莫名其妙消失"）：
 *   1. `aiSessionSwitch` 返回的 `messages` **已过滤 system 前缀块** ——
 *      直接渲染，**不要自己再过滤**（会误删正常消息）。
 *   2. `aborted > 0` → 必须提示「已中断 N 个正在生成的回答」。
 *   3. **`active` 一律以返回值为准**。删除当前会话后后端会落到另一个 id。
 *
 * 门面替我们做掉的四件事（所以本文件没有 try/catch 兜底、没有字段归一）：
 *   · 永不抛错（异常/无宿主都返回空状态）
 *   · `title` 空→「未命名会话」、时间与条数强制转数字
 *   · `messages` 已规范化（只留 user/assistant、text 转字符串、streaming 一律 false）
 *   · `sessionsAvailable()` 直接判断入口显隐
 *
 * ⚠ 一个容易误解的点：`createdAt/updatedAt` 是**毫秒时间戳（number）**，
 *   不是 ISO 字符串。门面里是 `Number(s.createdAt)` —— 若哪天主进程改成 ISO，
 *   这里会静默变成 NaN（时间显示成空）。所以 `relativeTime` 对 NaN 有兜底。
 */

import { el, clear, button } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { warn } from "../ui/toast.ts";
import {
  aiSessionsList,
  aiSessionNew,
  aiSessionSwitch,
  aiSessionDelete,
  sessionsAvailable,
  type AiSessionEntry,
  type AiSessionMessage
} from "../core/host.ts";

// ============================================================================
// 纯函数（可单测）
// ============================================================================

/**
 * 相对时间：列表里"3 分钟前"比一个裸时间戳好读得多。
 * 超过 7 天退回日期（"30 天前"在历史列表里意义不大）。
 *
 * 输入是**毫秒时间戳**（与 AiSessionEntry.updatedAt 一致）。
 * 对 0 / NaN / 未来时间都返回空串或"刚刚"，不产出怪文案 ——
 * 这一点很重要：门面用 `Number()` 转时间，一旦上游换成 ISO 字符串就会得到 NaN，
 * 那时宁可显示空、也不要显示 "NaN 分钟前"。
 */
export function relativeTime(ts: number, now = Date.now()): string {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "";
  const diff = now - t;
  if (diff < 0) return "刚刚";                    // 时钟漂移，别显示"负 X 分钟前"
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 列表排序：**最近更新的在前**。
 *
 * 为什么不用后端顺序：那是实现细节（可能按创建时间、可能按文件读取顺序），
 * 用户打开历史想找的是"刚才那个对话"。同时间戳用 id 兜底，保证排序稳定
 * （否则每次重渲染顺序可能变，看着像列表在跳）。
 */
export function sortSessions(list: AiSessionEntry[]): AiSessionEntry[] {
  return [...list].sort((a, b) => {
    const ta = Number(a.updatedAt) || 0;
    const tb = Number(b.updatedAt) || 0;
    if (tb !== ta) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 列表项副标题：「2 条 · 3 分钟前」。条数为 0 时明确说"还没聊过"。 */
export function sessionSubtitle(e: AiSessionEntry, now = Date.now()): string {
  const when = relativeTime(e.updatedAt, now);
  const count = e.messageCount > 0 ? `${e.messageCount} 条` : "还没聊过";
  return when ? `${count} · ${when}` : count;
}

/**
 * `aborted > 0` 时的提示文案。
 *
 * 为什么必须提示：用户在生成中点切换/新建/删除，后端会中止在途请求，
 * 那个回答就"消失"了。**没有解释的消失，用户会当 bug 报。**
 */
export function abortedNotice(
  aborted: number | undefined,
  action: "new" | "switch" | "delete"
): string | null {
  const n = Number(aborted);
  if (!Number.isFinite(n) || n <= 0) return null;
  const what = action === "new" ? "新建会话" : action === "switch" ? "切换会话" : "删除会话";
  return `${what}时已中断 ${n} 个正在生成的回答`;
}

// ============================================================================
// UI
// ============================================================================

export interface SessionPanelHooks {
  /** 用主进程返回的 messages 替换对话区（已规范化，直接映射） */
  renderMessages(messages: AiSessionMessage[]): void;
  /** 清空对话区（新建会话后） */
  clearMessages(): void;
  /** 重画顶部状态（activeSession / sessionCount 会变） */
  refreshBar(): void;
}

/**
 * 渲染会话切换器（挂在 AI 面板顶部条里）。
 * 网页版没有会话能力时返回 null，调用方据此跳过（入口整个消失）。
 */
export function renderSessionSwitcher(
  bar: HTMLElement,
  hooks: SessionPanelHooks,
  onClose?: () => void
): HTMLElement | null {
  if (!sessionsAvailable()) return null;

  let sessions: AiSessionEntry[] = [];
  let active = "";
  let open = false;
  let busy = false;

  const btn = button("历史", () => void toggle(), {
    size: "sm",
    variant: "ghost",
    iconPath: I.sheet,
    title: "会话历史：切换 / 新建 / 删除对话"
  });
  btn.dataset.aiSessions = "1";

  const pop = el("div", { class: "ai-sessions-pop" });
  pop.dataset.aiSessionsPop = "1";
  pop.style.display = "none";

  async function load(): Promise<void> {
    // 门面永不抛错，所以这里不需要 try/catch
    const r = await aiSessionsList();
    sessions = r.sessions;
    active = r.active;   // 以返回值为准
    if (r.error) warn(`会话列表读取失败：${r.error}`);
  }

  /** 把浮层放到按钮下方（按钮位置随窗口宽度变，每次打开都重算） */
  function placePop(): void {
    const host = pop.parentElement;
    if (!host) return;
    const hr = host.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const left = Math.max(8, br.left - hr.left);
    const top = br.bottom - hr.top + 4;
    const maxLeft = Math.max(8, host.clientWidth - pop.offsetWidth - 8);
    pop.style.left = Math.round(Math.min(left, maxLeft)) + "px";
    pop.style.top = Math.round(top) + "px";
  }

  async function toggle(): Promise<void> {
    if (busy) return;
    open = !open;
    pop.style.display = open ? "" : "none";
    if (open) {
      await load();
      renderList();
      placePop();
    }
  }

  function renderList(): void {
    clear(pop);
    const sorted = sortSessions(sessions);
    if (!sorted.length) {
      pop.appendChild(el("div", { class: "hint ai-sessions-empty" }, "还没有会话记录"));
    }
    for (const s of sorted) {
      const row = el("div", { class: "ai-session-row" + (s.id === active ? " active" : "") });
      row.dataset.aiSessionItem = "1";
      row.dataset.sessionId = s.id;

      const main = el("button", { type: "button", class: "ai-session-main" });
      // 稳定锚点：验收脚本按 id 精确点某一条。
      // **绝不能用 nth-of-type** —— 列表按 updatedAt 动态排序，位置会变。
      main.dataset.aiSessionPick = s.id;
      main.appendChild(el("span", { class: "ai-session-title" }, s.title || "未命名会话"));
      main.appendChild(el("span", { class: "ai-session-sub" }, sessionSubtitle(s, Date.now())));
      if (s.id === active) main.appendChild(el("span", { class: "ai-session-now" }, "当前"));
      main.addEventListener("click", () => void switchTo(s.id));
      row.appendChild(main);

      // 删除按钮：默认隐藏，悬停/聚焦时出现（避免列表里一片红色叉号）
      const del = button("×", () => void confirmDelete(s), {
        size: "sm",
        variant: "ghost",
        title: `删除「${s.title || "未命名会话"}」`
      });
      del.dataset.aiSessionDelete = "1";
      del.dataset.sessionId = s.id;
      del.classList.add("ai-session-del");
      row.appendChild(del);
      pop.appendChild(row);
    }

    const newRow = el("div", { class: "ai-sessions-foot" });
    const newBtn = button("+ 新建会话", () => void createNew(), {
      size: "sm",
      variant: "ghost",
      iconPath: I.plus,
      title: "开一个新对话（当前会话会保留）"
    });
    newBtn.dataset.aiSessionNew = "1";
    newRow.appendChild(newBtn);
    pop.appendChild(newRow);
  }

  function closePop(): void {
    open = false;
    pop.style.display = "none";
    onClose?.();
  }

  async function switchTo(id: string): Promise<void> {
    if (busy || id === active) {
      closePop();
      return;
    }
    busy = true;
    try {
      const r = await aiSessionSwitch(id);
      if (r.ok === false) {
        warn(`切换会话失败：${r.error || "未知原因"}`);
        return;
      }
      active = r.active || id;         // ⚠ 以返回值为准
      sessions = r.sessions;
      // ⚠ messages 已由门面过滤/规范化，直接渲染，不再二次过滤
      hooks.renderMessages(r.messages ?? []);
      const notice = abortedNotice(r.aborted, "switch");
      if (notice) warn(notice);
      hooks.refreshBar();
      closePop();
    } finally {
      busy = false;
      renderList();
    }
  }

  async function createNew(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const r = await aiSessionNew();
      if (r.ok === false) {
        warn(`新建会话失败：${r.error || "未知原因"}`);
        return;
      }
      active = r.active || "";
      sessions = r.sessions;
      hooks.clearMessages();
      const notice = abortedNotice(r.aborted, "new");
      if (notice) warn(notice);
      hooks.refreshBar();
      closePop();
    } finally {
      busy = false;
      renderList();
    }
  }

  /**
   * 删除会话。
   *
   * **二次确认必须**：会话不可恢复（本地文件删了就没了），而列表里每项都有
   * 删除按钮、又挨得近，误点代价很大。用原生 confirm：破坏性且低频的操作，
   * "必须打断你"这件事上它比自绘弹窗更有效（自绘容易被手快跳过）。
   */
  async function confirmDelete(s: AiSessionEntry): Promise<void> {
    if (busy) return;
    const name = s.title || "未命名会话";
    const okDel = window.confirm(
      `删除会话「${name}」？\n\n这会永久删除这条对话的历史（${s.messageCount} 条消息），无法恢复。`
    );
    if (!okDel) return;
    busy = true;
    try {
      const r = await aiSessionDelete(s.id);
      if (r.ok === false) {
        warn(`删除会话失败：${r.error || "未知原因"}`);
        return;
      }
      // ⚠ active 以返回值为准：删的可能是当前会话，后端已落到另一个
      const wasActive = s.id === active;
      active = r.active;
      sessions = r.sessions;
      const notice = abortedNotice(r.aborted, "delete");
      if (notice) warn(notice);
      if (wasActive) {
        // 删掉了当前会话：对话区必须换成新 active 的内容，
        // 否则 UI 还显示已删会话的消息（后续 aiChat 也会写到不存在的目录）
        const sw = await aiSessionSwitch(active);
        if (sw.ok !== false) {
          if (sw.sessions.length) sessions = sw.sessions;
          hooks.renderMessages(sw.messages ?? []);
        } else {
          hooks.clearMessages();
        }
      }
      hooks.refreshBar();
      renderList();
    } finally {
      busy = false;
    }
  }

  // 点外面收起（浮层不该挡住整个面板）
  const onDocDown = (ev: MouseEvent): void => {
    if (!open) return;
    const t = ev.target as Node | null;
    if (t && (pop.contains(t) || btn.contains(t))) return;
    open = false;
    pop.style.display = "none";
  };
  document.addEventListener("mousedown", onDocDown);

  bar.appendChild(btn);
  // 浮层挂在顶部条的父级（面板根），绝对定位，避免被 flex 布局挤变形
  const host = bar.parentElement ?? bar;
  host.appendChild(pop);

  return pop;
}
