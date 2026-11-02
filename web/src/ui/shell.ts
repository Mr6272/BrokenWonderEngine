/**
 * VS Code 结构骨架。
 *
 * 为什么把外壳单拆一层：editor.ts 原本一个类里同时管顶栏、工具栏、三栏、
 * 状态栏、缩放、撤销、示例工程……再往里塞活动栏、多标签、底部面板、命令面板，
 * 一个文件会变成两千行。这里只负责「把骨架搭出来、把宽度折叠状态管住」，
 * 业务命令仍然由 Editor 注册（骨架不知道"保存"该干什么，只负责把按钮画出来）。
 *
 * 布局纪律（沿用原编辑器踩过的坑）：
 *   - 全部用 flex 分配宽度，绝不用"按窗口宽度算固定坐标"；
 *   - 画布所在的中栏必须是 flex:1，且 min-width:0 —— 否则它会被内容顶宽，
 *     把左右两栏挤出可视区，1280x720 下出现横向滚动条；
 *   - 折叠 = 宽度归零 + 不给 border，不用 display:none（display 切换会让
 *     画布在恢复时拿不到正确尺寸，缩放会错一帧）。
 */

import { el, svg } from "../core/dom.ts";
import { I, type IconName } from "./icons.ts";

/** 活动栏条目：一个图标 + 标题 + 点击后要做的事。 */
export interface ActivityItem {
  id: string;
  title: string;
  icon: IconName;
  /** 底部固定区（设置这类）用 bottom: true */
  bottom?: boolean;
  onClick: () => void;
}

export interface ShellCallbacks {
  /** 切到某个活动栏条目（外壳只管高亮，内容由 Editor 决定） */
  onActivity: (id: string) => void;
}

/**
 * 外壳：只管 DOM 与几何，不碰工程数据。
 */
export class Shell {
  readonly root: HTMLDivElement;
  readonly activityBar: HTMLDivElement;
  readonly sidebar: HTMLDivElement;
  readonly sidebarBody: HTMLDivElement;
  readonly editorArea: HTMLDivElement;
  readonly editorTabs: HTMLDivElement;
  readonly editorBody: HTMLDivElement;
  readonly panel: HTMLDivElement;
  readonly panelHead: HTMLDivElement;
  readonly panelBody: HTMLDivElement;
  readonly statusbar: HTMLDivElement;
  /** 顶栏容器：Editor 往里塞菜单与标题 */
  readonly topbar: HTMLDivElement;
  readonly sidebarResizer: HTMLDivElement;
  /** 右侧辅助侧边栏（Inspector / 图层 / 大纲） */
  readonly auxPanel: HTMLDivElement;
  private readonly activityHosts = new Map<string, HTMLButtonElement>();
  /**
   * 折叠状态变化回调。
   *
   * 为什么需要：按钮文案/图标要随状态变（折叠态显示「展开」+ 展开图标），
   * 而状态是 shell 管的、按钮在 editor 里建的。回调比让 editor 每次自己查询更省事，
   * 也避免"点了按钮但文案没变"这类只改了一半的 bug。
   */
  private layoutListeners = new Set<(s: { sidebar: boolean; panel: boolean }) => void>();
  private sbWidth = 264;
  private panelHeight = 220;
  private activeActivity = "explorer";

  constructor() {
    this.root = el("div", { class: "app-root" });

    // ---------- 顶栏（保留原有标题栏，桌面端可拖窗口） ----------
    // 由 Editor 往里填内容，这里只提供容器
    this.topbar = el("div", { class: "topbar" });
    this.root.appendChild(this.topbar);

    // ---------- 主工作区：活动栏 + 侧边栏 + 编辑区 ----------
    const main = el("div", { class: "shell-main" });

    this.activityBar = el("div", { class: "activity-bar" });
    main.appendChild(this.activityBar);

    const sidebarWrap = el("div", { class: "sidebar-wrap" });
    this.sidebar = el("div", { class: "sidebar" });
    this.sidebarBody = el("div", { class: "sidebar-body" });
    this.sidebar.appendChild(this.sidebarBody);
    sidebarWrap.appendChild(this.sidebar);
    // 侧边栏可拖宽：手柄放在 wrap 里，折叠时一起隐藏（留着会有一根能拖的悬空线）
    this.sidebarResizer = el("div", { class: "sidebar-resizer", title: "拖动调整侧边栏宽度，双击恢复默认（Ctrl+B 折叠）" });
    sidebarWrap.appendChild(this.sidebarResizer);
    main.appendChild(sidebarWrap);

    // ---------- 编辑区 ----------
    this.editorArea = el("div", { class: "editor-area" });
    this.editorTabs = el("div", { class: "editor-tabs" });
    this.editorBody = el("div", { class: "editor-body" });
    this.editorArea.appendChild(this.editorTabs);
    this.editorArea.appendChild(this.editorBody);

    // 右栏（Inspector / 图层 / 大纲）：VS Code 里这是"辅助侧边栏"，
    // 结构上属于编辑区，但独立可拖宽，所以放在编辑区右侧
    // 顺序：编辑区在左、辅助侧边栏在右。编辑区 flex:1 吃掉剩余宽度，
    // 辅助栏固定宽度 —— 这样 1280x720 下画布永远不会被挤没。
    this.auxPanel = el("div", { class: "aux-panel" });
    main.appendChild(this.editorArea);
    main.appendChild(this.auxPanel);
    this.root.appendChild(main);

    // ---------- 底部面板 ----------
    this.panel = el("div", { class: "panel" });
    this.panelHead = el("div", { class: "panel-head" });
    this.panelBody = el("div", { class: "panel-body" });
    this.panel.appendChild(this.panelHead);
    this.panel.appendChild(this.panelBody);
    this.root.appendChild(this.panel);

    // ---------- 状态栏 ----------
    this.statusbar = el("div", { class: "statusbar" });
    this.root.appendChild(this.statusbar);

    this.bindResizers();
  }

  // ---------------- 活动栏 ----------------

  /**
   * 建立活动栏条目。
   * 图标用 ui/icons.ts 的同族描边路径；条目自带 title（工具提示就是唯一的说明，
   * 不再额外加文字标签 —— 48px 宽放不下，VS Code 也是这么做的）。
   */
  buildActivity(items: ActivityItem[], onActivity: (id: string) => void): void {
    this.activityBar.replaceChildren();
    this.activityHosts.clear();

    const topHost = el("div", { class: "activity-group" });
    const bottomHost = el("div", { class: "activity-group bottom" });
    this.activityBar.appendChild(topHost);
    this.activityBar.appendChild(bottomHost);

    for (const it of items) {
      const btn = el("button", {
        type: "button",
        class: "activity-item",
        title: it.title,
        "aria-label": it.title
      });
      btn.appendChild(svg(I[it.icon], 22));
      btn.dataset.activity = it.id;
      // 剧本入口的专用锚点（Lead 的验收命令按这个找）：与 data-activity 并存，
      // 前者是通用命名，这个是稳定契约名，改名会静默破坏别人的截图。
      if (it.id === "script") btn.dataset.sidebarScript = "1";
      btn.addEventListener("click", () => {
        this.setActiveActivity(it.id);
        onActivity(it.id);
      });
      this.activityHosts.set(it.id, btn);
      (it.bottom ? bottomHost : topHost).appendChild(btn);
    }
  }

  setActiveActivity(id: string): void {
    this.activeActivity = id;
    for (const [key, btn] of this.activityHosts) {
      btn.classList.toggle("active", key === id);
    }
  }

  currentActivity(): string {
    return this.activeActivity;
  }

  /** 活动栏条目上的未读数徽标（问题数之类）。传 0 即移除。 */
  setActivityBadge(id: string, count: number): void {
    const btn = this.activityHosts.get(id);
    if (!btn) return;
    const old = btn.querySelector(".badge");
    old?.remove();
    if (count > 0) {
      const b = el("span", { class: "badge" });
      b.textContent = count > 99 ? "99+" : String(count);
      btn.appendChild(b);
    }
  }

  // ---------------- 侧边栏 ----------------

  /**
   * 侧边栏折叠（Ctrl+B）。
   * 宽度归零而不是 display:none —— 折叠/展开动画期间画布能持续拿到真实尺寸，
   * 不会出现"展开后画面缩放错一帧"。
   */
  toggleSidebar(force?: boolean): boolean {
    const collapsed = force ?? !this.sidebar.classList.contains("collapsed");
    this.sidebar.classList.toggle("collapsed", collapsed);
    this.sidebarResizer.style.display = collapsed ? "none" : "";
    // 折叠后活动栏靠左，编辑区应该拿到空出来的宽度
    this.requestRepaint();
    this.emitLayout();
    return collapsed;
  }

  /** 订阅折叠状态变化（按钮文案/图标据此同步）。 */
  onLayoutChange(fn: (s: { sidebar: boolean; panel: boolean }) => void): () => void {
    this.layoutListeners.add(fn);
    // 立刻回放一次当前状态，订阅方不用先自己查一遍
    fn({ sidebar: this.sidebarCollapsed(), panel: this.panelCollapsed() });
    return () => this.layoutListeners.delete(fn);
  }

  private emitLayout(): void {
    const s = { sidebar: this.sidebarCollapsed(), panel: this.panelCollapsed() };
    for (const fn of Array.from(this.layoutListeners)) fn(s);
  }

  sidebarCollapsed(): boolean {
    return this.sidebar.classList.contains("collapsed");
  }

  setSidebarWidth(w: number): void {
    this.sbWidth = Math.max(200, Math.min(420, w));
    this.sidebar.style.flex = `0 0 ${this.sbWidth}px`;
    this.sidebar.style.width = `${this.sbWidth}px`;
    this.requestRepaint();
  }

  // ---------------- 底部面板 ----------------

  /**
   * 给某个面板内容预留最小高度。
   *
   * 为什么需要：底部面板默认 220px，"问题/输出"够用，但 AI 面板要放
   * 对话区 + 4 个快捷按钮 + 输入框 + 用量条，220px 会把对话区压成一条缝。
   * 这里只在当前高度不足时**抬高**，从不主动降低 —— 用户拖过的高度要尊重。
   */
  ensurePanelHeight(minH: number): void {
    if (this.panelCollapsed()) return;
    const cur = this.panel.getBoundingClientRect().height || this.panelHeight;
    if (cur >= minH) return;
    // 上限取窗口高度的 45%：1280x720 下 380px 会把画布压成一条缝，
    // 而 AI 面板在窄窗口里"够用"比"宽敞"更重要。
    const cap = Math.round(window.innerHeight * 0.45);
    this.setPanelHeight(Math.min(minH, Math.max(220, cap)));
  }

  /**
   * Toast 的垂直基准。
   *
   * 为什么不用 `position: fixed; bottom: 54px`：底部面板展开后会很高，
   * 固定值会正好压在输入框上（用户正在打字的位置）。这里按面板真实高度算，
   * 面板折叠时 toast 自然落到底部。
   */
  toastBottomOffset(): number {
    const statusH = this.statusbar.getBoundingClientRect().height || 26;
    const panelH = this.panel.getBoundingClientRect().height || 0;
    return Math.round(statusH + panelH + 12);
  }

  /** 底部面板折叠（Ctrl+J）。 */
  togglePanel(force?: boolean): boolean {
    const collapsed = force ?? !this.panel.classList.contains("collapsed");
    this.panel.classList.toggle("collapsed", collapsed);
    this.requestRepaint();
    this.emitLayout();
    return collapsed;
  }

  panelCollapsed(): boolean {
    return this.panel.classList.contains("collapsed");
  }

  setPanelHeight(h: number): void {
    this.panelHeight = Math.max(140, Math.min(520, h));
    if (!this.panelCollapsed()) this.panel.style.flex = `0 0 ${this.panelHeight}px`;
    this.requestRepaint();
  }

  // ---------------- 重绘钩子 ----------------

  /**
   * 尺寸变化后要通知画布重画。
   * 用 ResizeObserver 而不是 window resize：折叠侧边栏/拖分隔条都不触发 window resize，
   * 但画布的 clientWidth 变了 —— 不重画就会留一片旧画面。
   */
  private repaintHandlers = new Set<() => void>();

  onGeometryChange(fn: () => void): void {
    this.repaintHandlers.add(fn);
  }

  private requestRepaint(): void {
    // 合并到下一帧：拖动分隔条时 mousemove 频率远高于帧率
    if (this.repaintQueued) return;
    this.repaintQueued = true;
    requestAnimationFrame(() => {
      this.repaintQueued = false;
      for (const fn of Array.from(this.repaintHandlers)) fn();
    });
  }
  private repaintQueued = false;

  private bindResizers(): void {
    // 侧边栏宽度
    let startX = 0;
    let startW = 0;
    let dragging = false;
    const onMove = (e: MouseEvent): void => {
      if (!dragging) return;
      this.setSidebarWidth(startW + (e.clientX - startX));
    };
    const onUp = (): void => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    this.sidebarResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = this.sidebar.getBoundingClientRect().width || this.sbWidth;
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
    this.sidebarResizer.addEventListener("dblclick", () => {
      this.setSidebarWidth(264);
    });

    // 底部面板高度
    const panelResizer = el("div", { class: "panel-resizer", title: "拖动调整底部面板高度" });
    this.root.insertBefore(panelResizer, this.panel);
    let pStartY = 0;
    let pStartH = 0;
    let pDragging = false;
    const onPMove = (e: MouseEvent): void => {
      if (!pDragging) return;
      this.setPanelHeight(pStartH - (e.clientY - pStartY));
    };
    const onPUp = (): void => {
      if (!pDragging) return;
      pDragging = false;
      window.removeEventListener("mousemove", onPMove);
      window.removeEventListener("mouseup", onPUp);
      document.body.style.cursor = "";
    };
    panelResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pDragging = true;
      pStartY = e.clientY;
      pStartH = this.panel.getBoundingClientRect().height;
      document.body.style.cursor = "row-resize";
      window.addEventListener("mousemove", onPMove);
      window.addEventListener("mouseup", onPUp);
    });

    // ResizeObserver 兜住所有几何变化（含窗口缩放与折叠），比逐处手动 requestRepaint 可靠
    try {
      const ro = new ResizeObserver(() => this.requestRepaint());
      ro.observe(this.editorArea);
      ro.observe(this.sidebar);
      ro.observe(this.panel);
    } catch {
      /* 老浏览器没有 ResizeObserver：靠窗口 resize 兜底 */
    }
    window.addEventListener("resize", () => this.requestRepaint());
  }
}
