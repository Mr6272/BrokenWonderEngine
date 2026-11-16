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
 *
 * 两套外观，一套语义（v2 起）：
 *   · `renderSessionSidebar()` —— AI 界面 page 布局的**左侧常驻栏**（历史升级为常驻）；
 *   · `renderSessionSwitcher()` —— dock 布局顶部那条上的**浮层**（保留，宽度窄时用）。
 *   两者的排序 / 切换 / 新建 / 删除都走下面同一组 `store*` 函数与 `sessionRow()`，
 *   不复制第二份 —— 两份实现必然在"删除当前会话""aborted 提示"这类分支上漂移。
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
// UI：两套外观共用的状态与动作
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
 * 会话列表的运行时状态。
 *
 * 为什么抽出来：浮层与左栏是**同一份数据、同一套动作**，只是画法不同。
 * 各自持有一份 `sessions/active/busy` 的结果是：删了当前会话后一边重新加载、
 * 另一边还显示旧 id，点下去静默失败（两个入口都开着时必现）。
 */
interface SessionStore {
  sessions: AiSessionEntry[];
  active: string;
  busy: boolean;
}

function newStore(): SessionStore {
  return { sessions: [], active: "", busy: false };
}

/** 拉一次列表（门面永不抛错，所以没有 try/catch）。 */
async function loadInto(st: SessionStore): Promise<void> {
  const r = await aiSessionsList();
  st.sessions = r.sessions;
  st.active = r.active;   // 以返回值为准
  if (r.error) warn(`会话列表读取失败：${r.error}`);
}

/**
 * 切到某个会话。
 * @returns true = 状态已变（或本来就停在那条上，无需动作）；false = 失败/正忙。
 *   调用方据此决定要不要收起浮层、要不要重画 —— 早期版本把重画写在函数内部，
 *   浮层与左栏的收尾动作不一样，硬塞进去就会有一边不刷新。
 */
async function storeSwitch(
  st: SessionStore,
  hooks: SessionPanelHooks,
  id: string
): Promise<boolean> {
  if (st.busy) return false;
  if (id === st.active) return true;
  st.busy = true;
  try {
    const r = await aiSessionSwitch(id);
    if (r.ok === false) {
      warn(`切换会话失败：${r.error || "未知原因"}`);
      return false;
    }
    st.active = r.active || id;         // ⚠ 以返回值为准
    st.sessions = r.sessions;
    // ⚠ messages 已由门面过滤/规范化，直接渲染，不再二次过滤
    hooks.renderMessages(r.messages ?? []);
    const notice = abortedNotice(r.aborted, "switch");
    if (notice) warn(notice);
    hooks.refreshBar();
    return true;
  } finally {
    st.busy = false;
  }
}

/** 新建会话；成功返回 true。当前会话保留（不删）。 */
async function storeNew(st: SessionStore, hooks: SessionPanelHooks): Promise<boolean> {
  if (st.busy) return false;
  st.busy = true;
  try {
    const r = await aiSessionNew();
    if (r.ok === false) {
      warn(`新建会话失败：${r.error || "未知原因"}`);
      return false;
    }
    st.active = r.active || "";
    st.sessions = r.sessions;
    hooks.clearMessages();
    const notice = abortedNotice(r.aborted, "new");
    if (notice) warn(notice);
    hooks.refreshBar();
    return true;
  } finally {
    st.busy = false;
  }
}

/**
 * 删除会话（含二次确认与"删的是当前会话"的善后）。
 *
 * **二次确认必须**：会话不可恢复（本地文件删了就没了），而列表里每项都有
 * 删除按钮、又挨得近，误点代价很大。用原生 confirm：破坏性且低频的操作，
 * "必须打断你"这件事上它比自绘弹窗更有效（自绘容易被手快跳过）。
 *
 * 为什么善后必须在这里做：`aiSessionDelete` 之后后端已经落到另一个 active，
 * 若 UI 还显示已删会话的消息，后续 `aiChat` 会写进不存在的目录。
 */
async function storeDelete(
  st: SessionStore,
  hooks: SessionPanelHooks,
  s: AiSessionEntry
): Promise<void> {
  if (st.busy) return;
  const name = s.title || "未命名会话";
  const okDel = window.confirm(
    `删除会话「${name}」？\n\n这会永久删除这条对话的历史（${s.messageCount} 条消息），无法恢复。`
  );
  if (!okDel) return;
  st.busy = true;
  try {
    const r = await aiSessionDelete(s.id);
    if (r.ok === false) {
      warn(`删除会话失败：${r.error || "未知原因"}`);
      return;
    }
    // ⚠ active 以返回值为准：删的可能是当前会话，后端已落到另一个
    const wasActive = s.id === st.active;
    st.active = r.active;
    st.sessions = r.sessions;
    const notice = abortedNotice(r.aborted, "delete");
    if (notice) warn(notice);
    if (wasActive) {
      // 删掉了当前会话：对话区必须换成新 active 的内容
      const sw = await aiSessionSwitch(st.active);
      if (sw.ok !== false) {
        if (sw.sessions.length) st.sessions = sw.sessions;
        hooks.renderMessages(sw.messages ?? []);
      } else {
        hooks.clearMessages();
      }
    }
    hooks.refreshBar();
  } finally {
    st.busy = false;
  }
}

/** 一行会话说要的点击行为（浮层与左栏各自的收尾动作从这里注入）。 */
interface SessionRowHandlers {
  active: string;
  onPick(id: string): void;
  onDelete(entry: AiSessionEntry): void;
}

/**
 * 会话行（**唯一构造点**，浮层与左栏共用）。
 *
 * ⚠ 类名与 data 锚点是对外契约：`desktop/tools/verify-sessions.mjs`、
 *   `web/tools/ui-checks/README.md`、Lead 的验收命令都按它们定位。
 *   改名/改层级不会报错，只会让那些验收从此量到 0 个元素（静默失效）。
 */
function sessionRow(s: AiSessionEntry, h: SessionRowHandlers): HTMLElement {
  const row = el("div", { class: "ai-session-row" + (s.id === h.active ? " active" : "") });
  row.dataset.aiSessionItem = "1";
  row.dataset.sessionId = s.id;

  const main = el("button", { type: "button", class: "ai-session-main" });
  // 稳定锚点：验收脚本按 id 精确点某一条。
  // **绝不能用 nth-of-type** —— 列表按 updatedAt 动态排序，位置会变。
  main.dataset.aiSessionPick = s.id;
  main.appendChild(el("span", { class: "ai-session-title" }, s.title || "未命名会话"));
  main.appendChild(el("span", { class: "ai-session-sub" }, sessionSubtitle(s, Date.now())));
  if (s.id === h.active) main.appendChild(el("span", { class: "ai-session-now" }, "当前"));
  main.addEventListener("click", () => h.onPick(s.id));
  row.appendChild(main);

  // 删除按钮：默认隐藏，悬停/聚焦时出现（避免列表里一片红色叉号）
  const del = button("×", () => h.onDelete(s), {
    size: "sm",
    variant: "ghost",
    title: `删除「${s.title || "未命名会话"}」`
  });
  del.dataset.aiSessionDelete = "1";
  del.dataset.sessionId = s.id;
  del.classList.add("ai-session-del");
  row.appendChild(del);
  return row;
}

/** 左栏历史栏的返回句柄（不需要的话可以直接忽略返回值）。 */
export interface SessionSidebar {
  /** 历史栏根节点 `.ai-history[data-ai-history]` */
  root: HTMLElement;
  /** 重新拉一次列表并局部重画（外部改动过会话时用） */
  refresh(): Promise<void>;
}

// ============================================================================
// UI：左栏常驻历史（page 布局）
// ============================================================================

/**
 * 渲染**常驻左栏**的会话历史。
 *
 * 与浮层版的差别只有"画法"，语义完全一致（同一组 `store*` 函数）。
 * 之所以要常驻：历史是 AI 界面里最常回访的东西（"刚才那个对话"），
 * 藏在浮层里意味着每次都要先点一次按钮 —— 参考布局里它是整列常驻的。
 *
 * 刷新策略：**进入即加载一次**（不等用户点开），之后切换/新建/删除只重画
 * `.ai-history-list` 与底部计数，不整块重建 —— 整块重建会让滚动位置归零、
 * 行高闪一下，看着像列表"跳了"。
 *
 * 网页版没有会话能力时返回 null，调用方据此跳过（左栏整个消失，主区照常）。
 */
export function renderSessionSidebar(
  host: HTMLElement,
  hooks: SessionPanelHooks
): SessionSidebar | null {
  if (!sessionsAvailable()) return null;

  const st = newStore();
  let loaded = false;

  const root = el("div", { class: "ai-history" });
  root.dataset.aiHistory = "1";

  const head = el("div", { class: "ai-history-head" });
  head.appendChild(el("span", { class: "ai-history-title" }, "历史"));

  // 折叠**不在这里做按钮**：样式表把 `[data-collapsed="1"]` 处理成 display:none，
  // 按钮本身在栏内 —— 点下去整栏（含按钮）一起消失，用户就再也点不回来了。
  // 手动折叠要等一个**栏外**的展开入口（活动栏 / 主区头部），本轮不做。
  // 属性本身仍然被支持：外壳按窗口宽度直接写 `data-collapsed` 即可。
  const newBtn = button("+ 新建", () => void createNew(), {
    size: "sm",
    variant: "ghost",
    iconPath: I.plus,
    title: "开一个新对话（当前会话会保留）"
  });
  newBtn.dataset.aiSessionNew = "1";
  head.appendChild(newBtn);

  const list = el("div", { class: "ai-history-list" });
  list.dataset.aiHistoryList = "1";

  const foot = el("div", { class: "ai-history-foot" });

  root.appendChild(head);
  root.appendChild(list);
  root.appendChild(foot);
  host.appendChild(root);

  function renderRows(): void {
    clear(list);
    const sorted = sortSessions(st.sessions);
    foot.textContent = sorted.length ? `共 ${sorted.length} 个会话` : "";
    // 首次加载完成前什么都不画：先画「还没有会话记录」再被真实列表替换掉，
    // 等于每次进入 AI 界面都闪一下"你没有历史"。
    if (!loaded) return;
    if (!sorted.length) {
      list.appendChild(el("div", { class: "hint ai-sessions-empty" }, "还没有会话记录"));
      return;
    }
    for (const s of sorted) {
      list.appendChild(
        sessionRow(s, {
          active: st.active,
          onPick: (id) => void switchTo(id),
          onDelete: (entry) => void confirmDelete(entry)
        })
      );
    }
  }

  async function refresh(): Promise<void> {
    await loadInto(st);
    loaded = true;
    renderRows();
  }

  async function switchTo(id: string): Promise<void> {
    await storeSwitch(st, hooks, id);
    renderRows();
  }

  async function createNew(): Promise<void> {
    await storeNew(st, hooks);
    renderRows();
  }

  async function confirmDelete(s: AiSessionEntry): Promise<void> {
    await storeDelete(st, hooks, s);
    renderRows();
  }

  // 进入 AI 界面即加载：用户下一眼就要看到历史，不该等一次点击。
  void refresh();

  return { root, refresh };
}

// ============================================================================
// UI：顶部条浮层（dock 布局）
// ============================================================================

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

  const st = newStore();
  let open = false;

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
    if (st.busy) return;
    open = !open;
    pop.style.display = open ? "" : "none";
    if (open) {
      await loadInto(st);
      renderList();
      placePop();
    }
  }

  function renderList(): void {
    clear(pop);
    const sorted = sortSessions(st.sessions);
    if (!sorted.length) {
      pop.appendChild(el("div", { class: "hint ai-sessions-empty" }, "还没有会话记录"));
    }
    for (const s of sorted) {
      pop.appendChild(
        sessionRow(s, {
          active: st.active,
          onPick: (id) => void switchTo(id),
          onDelete: (entry) => void confirmDelete(entry)
        })
      );
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
    if (st.busy) return;
    const ok = await storeSwitch(st, hooks, id);
    renderList();
    // 失败时浮层保持打开：用户要能立刻换一条重试，而不是先重新点开
    if (ok) closePop();
  }

  async function createNew(): Promise<void> {
    if (st.busy) return;
    const ok = await storeNew(st, hooks);
    renderList();
    if (ok) closePop();
  }

  async function confirmDelete(s: AiSessionEntry): Promise<void> {
    if (st.busy) return;
    await storeDelete(st, hooks, s);
    renderList();
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
