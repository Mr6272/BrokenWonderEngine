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
  /**
   * 右侧 **AI 栏**（与场景编辑器对等的全高栏，可拖宽、可折叠）。
   *
   * 为什么不再挂在底部面板：底部面板默认 220px、上限被钳到窗口 45%，
   * 里面塞「对话区 + 快捷动作 + 输入框 + 用量条」后对话区只剩一条缝 ——
   * AI 是**主力工作面**（读工程、改脚本、看错误），缩在底部与它的使用权重不对等。
   * 放到右侧后它能拿到整个主工作区的高度，和画布/剧本编辑器平齐。
   */
  readonly aiPanel: HTMLDivElement;
  readonly aiPanelHead: HTMLDivElement;
  readonly aiPanelBody: HTMLDivElement;
  /** AI 栏左边缘的拖宽手柄（右侧栏的手柄在手柄条自己身上） */
  readonly aiResizer: HTMLDivElement;
  private readonly activityHosts = new Map<string, HTMLButtonElement>();
  /**
   * 折叠状态变化回调。
   *
   * 为什么需要：按钮文案/图标要随状态变（折叠态显示「展开」+ 展开图标），
   * 而状态是 shell 管的、按钮在 editor 里建的。回调比让 editor 每次自己查询更省事，
   * 也避免"点了按钮但文案没变"这类只改了一半的 bug。
   */
  private layoutListeners = new Set<(s: { sidebar: boolean; panel: boolean; ai: boolean }) => void>();
  private sbWidth = 264;
  private panelHeight = 220;
  private activeActivity = "explorer";
  /** 上一个活动栏条目（点「AI 助手」后要靠它把高亮还回去） */
  private prevActivity = "explorer";
  /**
   * 进入 AI 界面前的工作区快照（三处折叠态 + AI 栏宽度）。
   *
   * 为什么必须记而不是"退出时一律展开"：用户进 AI 界面前可能本来就折着侧边栏、
   * 折着底部面板、AI 栏拖到了 380 —— 这三个值都是他显式表达过的意图。
   * 一律展开等于替他改了工作区，退出后还得手动调回来。
   */
  private aiModeSnapshot: { sidebar: boolean; panel: boolean; ai: boolean; aiWidth: number } | null = null;

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

    // ---------- 右侧 AI 栏（与场景编辑器对等的全高栏） ----------
    //
    // 为什么放在 auxPanel **右边**而不是塞进底部面板：AI 是主力工作面，
    // 底部面板的高度（220px、上限窗口 45%）会把对话区压成一条缝。
    // 顺序上 AI 在最右：它是「常驻工作区」，辅助栏（对象属性）是「随选中变化的细节」，
    // 用户视线从画布往右扫时先看到属性、再看到助手，符合两级信息的递进关系。
    //
    // 为什么用 resizer + 固定 flex-basis（而不是 width:40%）：小窗口纪律（1280x720
    // 是验收下限）要求「任何一栏都能被压下去、编辑区不能消失」。固定 basis + min-width:0
    // 让编辑区永远 flex:1 吃掉剩余空间，AI 栏自己也受 max-width 约束不会把画布挤没。
    this.aiResizer = el("div", {
      class: "ai-resizer",
      title: "拖动调整 AI 栏宽度，双击恢复默认（Ctrl+Shift+A 折叠/展开）"
    });
    main.appendChild(this.aiResizer);
    this.aiPanel = el("div", { class: "ai-dock" });
    this.aiPanelHead = el("div", { class: "ai-dock-head" });
    this.aiPanelBody = el("div", { class: "ai-dock-body" });
    this.aiPanel.appendChild(this.aiPanelHead);
    this.aiPanel.appendChild(this.aiPanelBody);
    main.appendChild(this.aiPanel);
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
    // 记上一个条目：点「AI 助手」时点击本身已经把高亮改成 ai 了，
    // 等 onActivity 被调用时已经问不出"用户原来在看什么" —— 只能在这里留痕。
    // 退出 AI 界面要把高亮还回去，否则用户退出后停在一个没有高亮的空壳上。
    if (this.activeActivity && this.activeActivity !== id) this.prevActivity = this.activeActivity;
    this.activeActivity = id;
    for (const [key, btn] of this.activityHosts) {
      btn.classList.toggle("active", key === id);
    }
  }

  /** 上一个活动栏条目（进入 AI 界面前用户所在的视图）。 */
  previousActivity(): string {
    return this.prevActivity || "explorer";
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
  onLayoutChange(fn: (s: { sidebar: boolean; panel: boolean; ai: boolean }) => void): () => void {
    this.layoutListeners.add(fn);
    // 立刻回放一次当前状态，订阅方不用先自己查一遍
    fn({ sidebar: this.sidebarCollapsed(), panel: this.panelCollapsed(), ai: this.aiPanelCollapsed() });
    return () => this.layoutListeners.delete(fn);
  }

  private emitLayout(): void {
    const s = { sidebar: this.sidebarCollapsed(), panel: this.panelCollapsed(), ai: this.aiPanelCollapsed() };
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

  // ---------------- 右侧 AI 栏 ----------------

  /**
   * AI 栏的默认宽度。
   *
   * 460px 的依据：AI 面板里最宽的内容是工具块与代码块（行号 + 约 60 字符代码），
   * 低于 420 就开始出现难看的折行；而 1280 宽窗口下 460 仍给编辑区留下
   * 1280 - 48(活动栏) - 264(侧边栏) - 300(辅助栏) - 460 - 4(手柄) ≈ 204px，
   * 画布不至于消失（且小窗口媒体查询里会再收窄）。
   *
   * ⚠ 但**默认值必须随窗口宽度响应**：JS 设置的是内联 flex-basis，它会覆盖
   * CSS 媒体查询里的 `--ai-w` 变量。如果这里写死 460，1280x720 下 AI 栏
   * 永远占 460，CSS 里精心收窄的 380 根本不生效 —— 这是「两套宽度规则打架」
   * 的典型形态（改了一处、另一处静默压过去）。所以默认值按窗口宽度的 32% 取，
   * 上限 460、下限 320。
   */
  static readonly AI_WIDTH_DEFAULT = 460;
  static defaultAiWidth(): number {
    const byWindow = Math.round(window.innerWidth * 0.32);
    return Math.max(320, Math.min(Shell.AI_WIDTH_DEFAULT, byWindow));
  }
  private aiWidth = Shell.defaultAiWidth();

  /** AI 栏折叠/展开（与侧边栏同一套语义：宽度归零，不切 display）。 */
  toggleAiPanel(force?: boolean): boolean {
    const collapsed = force ?? !this.aiPanel.classList.contains("collapsed");
    this.aiPanel.classList.toggle("collapsed", collapsed);
    /**
     * ⚠ 必须**清掉内联 flex-basis**，不能只靠 CSS 的 `.ai-dock.collapsed { flex: 0 0 0 }`。
     *
     * 原因：`setAiPanelWidth` 设的是内联 `style.flex`，而内联样式**优先级高于样式表**——
     * 类名加上了、CSS 规则的 `flex: 0 0 0` 却被内联的 `0 0 460px` 压过去，
     * 于是「折叠后宽度仍是 460」。实测就是这样（折叠类的断言全过、宽度断言失败）。
     * 这类 bug 特别隐蔽：状态看起来对（类在了），几何却完全没变。
     * 折叠时显式清空内联宽度（展开时 setAiPanelWidth 会重新写上）。
     */
    if (collapsed) {
      this.aiPanel.style.flex = "";
      this.aiPanel.style.width = "";
    } else {
      this.setAiPanelWidth(this.aiWidth);
    }
    // 手柄在 AI 栏左侧：折叠后必须一起隐藏，否则留一根能拖的悬空竖线
    this.aiResizer.style.display = collapsed ? "none" : "";
    this.requestRepaint();
    this.emitLayout();
    return collapsed;
  }

  aiPanelCollapsed(): boolean {
    return this.aiPanel.classList.contains("collapsed");
  }

  /**
   * 设置 AI 栏宽度。
   *
   * 上限按**窗口宽度的 46%** 动态收：固定 620px 在 1280 窗口里会占掉近一半，
   * 加上侧边栏/辅助栏后画布只剩一条缝。下限 320 是「输入框 + 工具块还能看」的底线。
   */
  setAiPanelWidth(w: number): void {
    const cap = Math.round(window.innerWidth * 0.46);
    this.aiWidth = Math.max(320, Math.min(Math.max(320, cap), w));
    this.aiPanel.style.flex = `0 0 ${this.aiWidth}px`;
    this.aiPanel.style.width = `${this.aiWidth}px`;
    this.requestRepaint();
  }

  getAiPanelWidth(): number {
    return this.aiWidth;
  }

  // ---------------- AI 界面（AI 工作面） ----------------

  /** 当前是否处于 AI 界面。状态只认 .app-root 上的类，不另存一份布尔值。 */
  aiModeOn(): boolean {
    return this.root.classList.contains("ai-mode");
  }

  /**
   * 进入 / 退出 AI 界面。
   *
   * 进入 = 切 `.ai-mode` 类（其余界面由样式表退场）+ 把三处折叠态摆成"AI 独占"：
   * 侧边栏折、底部面板折、AI 栏展开、AI 手柄隐藏。
   * 退出 = 逐项还原进入前的快照（不是一律展开，见 aiModeSnapshot 的注释）。
   */
  setAiMode(on: boolean): void {
    if (on === this.aiModeOn()) return;
    if (on) {
      this.aiModeSnapshot = {
        sidebar: this.sidebarCollapsed(),
        panel: this.panelCollapsed(),
        ai: this.aiPanelCollapsed(),
        aiWidth: this.getAiPanelWidth()
      };
      // 先加类再改折叠态：折叠那几步会 emitLayout → Editor 的
      // syncLayoutAffordances 会读 aiModeOn()，类后加会让它看到"还没进 AI 界面"。
      this.root.classList.add("ai-mode");
      this.toggleSidebar(true);
      this.togglePanel(true);
      this.toggleAiPanel(false);
      /**
       * ⚠ 必须在 toggleAiPanel(false) **之后**清内联 flex / width。
       *
       * 顺序写反等于没写：展开那一步会调 setAiPanelWidth，把内联
       * `flex: 0 0 460px` 重新写回去；内联样式优先级高于样式表，于是契约里
       * `.app-root.ai-mode .ai-dock { flex: 1 1 auto; width: auto }` 被压过去 ——
       * 类在了、状态看着对，宽度却还是 460（toggleAiPanel 折叠时踩的是同一个坑）。
       */
      this.aiPanel.style.flex = "";
      this.aiPanel.style.width = "";
      // AI 手柄在 AI 界面里没有意义（宽度由 CSS 定），留着还会浮一条可拖的假手柄
      this.aiResizer.style.display = "none";
    } else {
      const s = this.aiModeSnapshot;
      this.root.classList.remove("ai-mode");
      if (s) {
        this.toggleSidebar(s.sidebar);
        this.togglePanel(s.panel);
        if (s.ai) {
          // 原来就是折的：折叠时 toggleAiPanel 会把内联宽度与手柄一起收掉
          this.toggleAiPanel(true);
        } else {
          this.toggleAiPanel(false);
          // 展开后又补一次宽度：折叠/展开过程中窗口可能被缩窄，
          // setAiPanelWidth 会按当前窗口重新钳上限，这里以快照值为准。
          this.setAiPanelWidth(s.aiWidth);
          this.aiResizer.style.display = "";
        }
      } else {
        // 没有快照（例如外部直接操作了类名）：退回到"展开右侧栏"这个合理默认
        this.toggleAiPanel(false);
      }
      this.aiModeSnapshot = null;
    }
    // 两种切换都要重画：画布在 AI 界面里被隐藏，但退出时它要按新尺寸重算缩放
    this.requestRepaint();
    this.emitLayout();
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

    // ---- AI 栏宽度 ----
    //
    // ⚠ 手柄在 AI 栏**左侧**，所以拖动方向是反的：
    //   鼠标往左移（clientX 变小）→ AI 栏变宽。写成 `startW - delta` 而不是 `+`，
    //   写反的症状是「拖右边反而变窄」，用户会以为手感坏了。
    let aStartX = 0;
    let aStartW = 0;
    let aDragging = false;
    const onAMove = (e: MouseEvent): void => {
      if (!aDragging) return;
      this.setAiPanelWidth(aStartW - (e.clientX - aStartX));
    };
    const onAUp = (): void => {
      if (!aDragging) return;
      aDragging = false;
      window.removeEventListener("mousemove", onAMove);
      window.removeEventListener("mouseup", onAUp);
      document.body.style.cursor = "";
    };
    this.aiResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      aDragging = true;
      aStartX = e.clientX;
      aStartW = this.aiPanel.getBoundingClientRect().width || this.aiWidth;
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", onAMove);
      window.addEventListener("mouseup", onAUp);
    });
    this.aiResizer.addEventListener("dblclick", () => {
      this.setAiPanelWidth(Shell.defaultAiWidth());
    });

    // 初始宽度要显式设一次：CSS 里的 flex-basis 只是兜底，
    // 用户拖过之后宽度由这里接管（双击手柄可恢复默认）。
    this.setAiPanelWidth(this.aiWidth);

    /**
     * 启动即收起 AI 栏（二轮改动：用户反馈「刚启动还有个小的 AI 窗口，很不对劲」）。
     *
     * 为什么：AI 已经是**独立工作面**（活动栏「AI 助手」= 进入 AI 界面，占满主区），
     * 右侧再常驻一条 460px 窄栏就是两个入口、两套形态 —— 启动第一眼看到的是那个窄栏，
     * 用户会以为「AI 界面」没生效。所以默认宽度 0：`editor.renderAiDock()` 在折叠态早退，
     * DOM 里连 `.ai-panel` 都不建（不是 display:none，是根本没有）。
     *
     * 为什么保留窄栏能力而不是拆掉整段：`desktop/tools/verify-ai-dock-layout.mjs`
     * 仍在量「展开后与辅助栏同高 / 折叠后宽度归零 / 拖宽上限跟窗口走」这些几何回归，
     * `aiWidth` 也仍是退出 AI 界面时要还原的快照值。收起 ≠ 拆掉。
     */
    this.toggleAiPanel(true);

    // ResizeObserver 兜住所有几何变化（含窗口缩放与折叠），比逐处手动 requestRepaint 可靠
    try {
      const ro = new ResizeObserver(() => this.requestRepaint());
      ro.observe(this.editorArea);
      ro.observe(this.sidebar);
      ro.observe(this.panel);
      ro.observe(this.aiPanel);
    } catch {
      /* 老浏览器没有 ResizeObserver：靠窗口 resize 兜底 */
    }
    window.addEventListener("resize", () => this.requestRepaint());
  }
}
