/**
 * 编辑器外壳：VS Code 结构（活动栏 / 侧边栏 / 编辑区多标签 / 底部面板 / 状态栏 / 命令面板）。
 *
 * 布局纪律（踩过的坑，别改回去）：
 *   - 多栏一律用 flex 分配宽度，编辑区 flex:1 + min-width:0；
 *     绝不用"按窗口宽度算固定坐标"——不同分辨率与系统缩放下必然有一栏被挤出可视区。
 *   - 侧边栏/底部面板折叠 = 宽度归零，不切 display；否则画布在恢复时拿到旧尺寸，
 *     缩放会错一帧，看起来像"展开后地图位置跳了一下"。
 *   - 命令注册表只有一份（ui/commands.ts），菜单、快捷键、命令面板都从它取，
 *     加命令不用改三处。
 */

import { store, TOOLS, type Tool } from "../core/store.ts";
import type { Project, SceneObject } from "../core/model.ts";
import { createProject, normalizeProject, isUiScene, scenePixelSize, uiSafeArea } from "../core/model.ts";
import { SnapshotPool } from "../core/snapshot.ts";
import { CanvasView, orderObjects } from "./canvas.ts";
import { setPictureReadyHandler, paintObject } from "./painter.ts";
import { el, button, iconButton, svg } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { STATUS_READY } from "../ui/terms.ts";
import { Tabbed } from "../ui/tabbed.ts";
import { info, ok, warn, modal, contextMenu, confirmDialog, error, syncToastPosition } from "../ui/toast.ts";
import { Shell, type ActivityItem } from "../ui/shell.ts";
import { registerCommands, menuItemsFrom, runCommand } from "../ui/commands.ts";
import { openCommandPalette } from "../ui/commandPalette.ts";
import { renderAssetPanel } from "../panels/assetPanel.ts";
import { renderModulePanel } from "../panels/modulePanel.ts";
import { renderScenePanel } from "../panels/scenePanel.ts";
import { renderPrefabPanel } from "../panels/prefabPanel.ts";
import { renderInspector } from "../panels/inspector.ts";
import {
  renderScriptList,
  renderScriptEditor,
  requestOpenScriptPanel
} from "../panels/scriptPanel.ts";
import { renderSettingsPanel } from "../panels/settingsPanel.ts";
import { renderSearchPanel } from "../panels/searchPanel.ts";
import { renderProblemsPanel, renderOutputPanel } from "../panels/bottomPanels.ts";
import { renderAiPanel, setAiScriptApplyHook, aiPanelSummary, resetAiConversation, requestAiAction } from "../panels/aiPanel.ts";
import { openBwePackager } from "./packageBwe.ts";
import { renderOutlinePanel } from "../panels/outlinePanel.ts";
import { openModuleEditor } from "../panels/moduleEditor.ts";
import { saveProjectFile, openProjectFile, downloadProject, createExampleProject } from "./project.ts";
import { buildExample, type ExampleId } from "../data/examples.ts";
import { detectMinigame, renderDressup, renderMinesweeper } from "./minigames.ts";
import { Session } from "../account/session.ts";
import { appendOutput } from "../core/output.ts";
import { problemCounts, onProblems } from "../core/diagnostics.ts";
import { apiFetch, hostMode, onMenuCommand, onOpenProjectRequest } from "../core/host.ts";

/** 编辑区标签的声明。canvas 标签不可关闭；其余可以。 */
interface EditorTab {
  id: string;
  label: string;
  icon: keyof typeof I;
  /** 不可关闭（画布永远在） */
  fixed?: boolean;
  /** 渲染到编辑区主体 */
  render: (host: HTMLElement) => void;
}

export class Editor {
  /**
   * 挂载根节点。
   *
   * 不用 `readonly` 由构造函数赋值：外壳对象在 buildShell 里才创建，
   * 而 root 必须**就是**外壳的根节点（否则 main.ts 挂上去的是一棵空 div，
   * 界面一片空白 —— 这个问题真的发生过，截图自查才抓到）。
   */
  readonly root!: HTMLDivElement;
  private shell!: Shell;
  private canvas!: CanvasView;

  // 侧边栏：原 Tabbed 的左栏内容（资源管理器页）
  private explorerTab!: Tabbed;
  // 右侧辅助栏：Inspector / 图层 / 大纲
  private auxTab!: Tabbed;

  private statusCells: Record<string, HTMLElement> = {};
  private hintEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private aiCell!: HTMLElement;
  private aiUsageCell!: HTMLElement;
  private modeCell!: HTMLElement;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private hintTimer = 0;

  // 底部面板
  private bottomTab: "problems" | "output" | "ai" = "problems";
  private bottomTabButtons = new Map<string, HTMLButtonElement>();
  private problemsBadge: HTMLElement | null = null;

  // 编辑区标签
  private tabs: EditorTab[] = [];
  private activeTabId = "canvas";
  private tabButtons = new Map<string, HTMLElement>();

  // 侧边栏宿主
  private sidebarViewHost!: HTMLElement;
  private sidebarTitle!: HTMLElement;
  private currentSidebarView = "explorer";

  private menuAnchor!: HTMLButtonElement;
  private accountBtn!: HTMLButtonElement;
  private zoomLabel!: HTMLElement;
  private scriptDirtyDot: HTMLElement | null = null;

  constructor() {
    this.buildShell();
    this.buildTop();
    this.buildActivity();
    this.buildSidebar();
    this.buildEditorArea();
    this.buildAux();
    this.buildBottomPanel();
    this.buildStatus();
    this.registerAllCommands();
    this.bindGlobalEvents();
    this.bindDesktopHost();
    this.bindShortcuts();

    setPictureReadyHandler(() => this.canvas?.requestPaint());
    store.onAny(() => this.refreshChrome());
    store.onSelection(() => this.refreshToolbarState());
    // 选择变化 → 右栏 Inspector 立即重建（按帧合并，连点/框选不会重复建树）
    store.onSelection(() => this.scheduleRightPanel());
    // 工程被整体换掉（打开文件 / 载入示例 / 新建）时，撤销历史必须一起作废：
    // 旧快照里的占位对应的是旧工程的素材内容，留着既还原不出正确数据，还白占内存。
    store.onProject(() => this.resetHistoryIfProjectReplaced());
    // 面板重建请求按帧合并：一次数据变化可能同时触发多个 bwe:refresh
    window.addEventListener("bwe:refresh", () => this.schedulePanels());

    // AI 面板的「应用」按钮：真正写回剧本编辑器（面板只负责发起，外壳负责落地）
    setAiScriptApplyHook((name, code) => this.applyAiScript(name, code));

    this.refreshChrome();
    this.setBottomTab("problems");
    this.showTab("canvas");
  }

  mount(host: HTMLElement): void {
    host.replaceChildren(this.root);
  }

  // ==========================================================================
  // 骨架
  // ==========================================================================

  private buildShell(): void {
    const shell = new Shell();
    shell.onGeometryChange(() => this.canvas?.requestPaint());
    // root 与外壳同体：main.ts 只挂一次，不再套多余的 app-root 外壳。
    // （早前写成 this.root.replaceWith(shell.root) —— 此时 this.root 还是游离节点，
    //   没有任何父节点，replaceWith 静默无效，结果页面上只有一棵空 div。）
    (this as { root: HTMLDivElement }).root = shell.root;
    this.shell = shell;
  }

  // ---------------- 顶栏 ----------------

  private buildTop(): void {
    const bar = this.shell.topbar;

    bar.appendChild(el("span", { class: "app-mark" }, "BWE"));
    bar.appendChild(el("span", { class: "app-title" }, "Studio"));
    bar.appendChild(el("div", { class: "sep" }));

    this.titleEl = el("span", { class: "project-name" });
    bar.appendChild(this.titleEl);
    bar.appendChild(el("div", { class: "spacer" }));

    const menu = (ids: string[]): void => {
      const r = this.menuAnchor.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, menuItemsFrom(ids));
    };

    this.menuAnchor = button(
      "文件",
      () =>
        menu([
          "file.new",
          "file.open",
          "-",
          "file.save",
          "file.saveAs",
          "-",
          "edit.prefabs",
          "-",
          "project.newExample",
          "project.example.minesweeper",
          "project.example.dressup",
          "project.example.topdown",
          "project.example.emergence",
          "project.example.vampire",
          "-",
          "project.package",
          "project.settings",
          "project.exportWeb"
        ]),
      { variant: "ghost", size: "sm" }
    );
    bar.appendChild(this.menuAnchor);

    bar.appendChild(
      button("编辑", () => menu(["edit.undo", "edit.redo", "-", "edit.duplicate", "edit.delete"]), {
        variant: "ghost",
        size: "sm"
      })
    );

    bar.appendChild(
      button(
        "查看",
        () =>
          menu([
            "view.fit",
            "view.zoom100",
            "-",
            "view.toggleGrid",
            "view.toggleColliders",
            "view.toggleNames",
            "-",
            "view.sidebar",
            "view.panel",
            "view.commandPalette"
          ]),
        { variant: "ghost", size: "sm" }
      )
    );

    bar.appendChild(
      button(
        "帮助",
        () => menu(["help.quickStart", "help.modules", "help.jsApi", "-", "help.about"]),
        { variant: "ghost", size: "sm" }
      )
    );

    bar.appendChild(el("div", { class: "spacer" }));

    const palBtn = button("搜索命令", () => openCommandPalette(), {
      variant: "ghost",
      size: "sm",
      iconPath: I.search,
      title: "命令面板（Ctrl+Shift+P）"
    });
    // 稳定锚点：验收脚本用 [data-command-palette-trigger] 点击，不依赖按钮文案
    palBtn.dataset.commandPaletteTrigger = "1";
    bar.appendChild(palBtn);

    // 验收用隐形触发器（0 尺寸、不可聚焦）：让 --tap 能在截图前跑一段验收脚本。
    // 产品上完全看不见，也不会被键盘 Tab 到。
    const probeHook = el("button", {
      type: "button",
      "data-demo-interaction-states": "1",
      "aria-hidden": "true",
      tabindex: "-1"
    });
    probeHook.style.cssText = "position:absolute;left:-9999px;width:0;height:0;padding:0;border:0;opacity:0";
    probeHook.addEventListener("click", () => {
      const w = window as unknown as { __BWE__?: { demoInteractionStates?: () => string } };
      w.__BWE__?.demoInteractionStates?.();
    });

    // 验收用：注入演示模型清单（让截图能看到多条模型 + needsKey 标记）
    const modelProbe = el("button", {
      type: "button",
      "data-demo-models": "1",
      "aria-hidden": "true",
      tabindex: "-1"
    });
    modelProbe.style.cssText = "position:absolute;left:-9999px;width:0;height:0;padding:0;border:0;opacity:0";
    modelProbe.addEventListener("click", () => {
      const w = window as unknown as { __BWE__?: { demoModels?: () => void } };
      w.__BWE__?.demoModels?.();
    });
    bar.appendChild(modelProbe);
    bar.appendChild(probeHook);

    // 账号入口（登录 / 订阅）
    this.accountBtn = button(Session.label(), () => openAccountMenu(this.accountBtn), {
      variant: "ghost",
      size: "sm",
      iconPath: I.account
    });
    bar.appendChild(this.accountBtn);
  }

  // ---------------- 活动栏 ----------------

  private buildActivity(): void {
    const items: ActivityItem[] = [
      { id: "explorer", title: "资源管理器 (Ctrl+Shift+E)", icon: "explorer", onClick: () => {} },
      { id: "search", title: "搜索 (Ctrl+Shift+F)", icon: "search", onClick: () => {} },
      { id: "script", title: "剧本 Scripts", icon: "script", onClick: () => {} },
      { id: "modules", title: "模块与规则", icon: "module", onClick: () => {} },
      { id: "prefabs", title: "预制体 Prefab", icon: "pack", onClick: () => {} },
      { id: "package", title: "打包 BWE", icon: "packageBox", onClick: () => {} },
      { id: "ai", title: "AI 助手", icon: "sparkles", onClick: () => {} },
      { id: "settings", title: "设置", icon: "settings", bottom: true, onClick: () => {} }
    ];
    this.shell.buildActivity(items, (id) => this.onActivity(id));
    this.shell.setActiveActivity("explorer");
  }

  /** 活动栏点击：不同条目切换侧边栏内容 / 打开标签 / 聚焦底部面板。 */
  private onActivity(id: string): void {
    switch (id) {
      case "explorer":
        this.shell.toggleSidebar(false);
        this.showSidebarView("explorer");
        break;
      case "search":
        this.shell.toggleSidebar(false);
        this.showSidebarView("search");
        break;
      case "script":
        this.openTab("script");
        break;
      case "modules":
        this.shell.toggleSidebar(false);
        this.showSidebarView("explorer");
        this.explorerTab.focus("modules");
        break;
      case "prefabs":
        this.shell.toggleSidebar(false);
        this.showSidebarView("explorer");
        this.explorerTab.focus("prefabs");
        break;
      case "package":
        this.openTab("package");
        break;
      case "ai":
        this.setBottomTab("ai");
        this.shell.togglePanel(false);
        break;
      case "settings":
        this.shell.toggleSidebar(false);
        this.showSidebarView("settings");
        break;
    }
  }

  // ---------------- 侧边栏 ----------------

  /**
   * 侧边栏内容宿主。
   *
   * 「资源管理器」是多标签容器（素材/模块/预制体/场景），其余活动栏条目是单页
   * （搜索/设置/剧本列表）。用一个统一宿主切换内容，不做多套嵌套容器 ——
   * 嵌套会让对外暴露的 DOM 层级随着点击变来变去。
   */
  private buildSidebar(): void {
    const body = this.shell.sidebarBody;

    const head = el("div", { class: "sidebar-head" });
    this.sidebarTitle = el("span", null, "资源管理器");
    head.appendChild(this.sidebarTitle);
    head.appendChild(el("div", { class: "spacer" }));
    const collapseBtn = button("折叠", () => this.shell.toggleSidebar(true), {
      size: "sm",
      variant: "ghost",
      iconPath: I.sidebarToggle,
      className: "sidebar-collapse-btn",
      title: "折叠侧边栏（Ctrl+B）"
    });
    // 稳定锚点：验收脚本用 [data-sidebar-collapse] 点击，不依赖按钮文案
    collapseBtn.dataset.sidebarCollapse = "1";
    head.appendChild(collapseBtn);
    body.appendChild(head);

    this.sidebarViewHost = el("div", { class: "sidebar-body-inner" });
    body.appendChild(this.sidebarViewHost);

    // 资源管理器：原有左栏内容原样搬进来
    this.explorerTab = new Tabbed(
      [
        { id: "assets", label: "素材", hint: "图片与音频；拖到画布上使用", render: renderAssetPanel },
        { id: "modules", label: "模块", hint: "可以加到对象身上的行为积木", render: renderModulePanel },
        { id: "prefabs", label: "预制体", hint: "可反复摆放的对象模板", render: renderPrefabPanel },
        { id: "scenes", label: "场景", hint: "地图列表与图层", render: renderScenePanel }
      ],
      "assets"
    );
    this.sidebarViewHost.appendChild(this.explorerTab.root);
    this.sidebarTitle.textContent = "资源管理器";
  }

  /** 切侧边栏视图（资源管理器 / 搜索 / 设置 / 剧本列表）。 */
  private showSidebarView(view: string): void {
    this.currentSidebarView = view;
    this.sidebarViewHost.replaceChildren();
    switch (view) {
      case "search":
        this.sidebarTitle.textContent = "搜索";
        renderSearchPanel(this.sidebarViewHost);
        break;
      case "settings":
        this.sidebarTitle.textContent = "工程设置";
        renderSettingsPanel(this.sidebarViewHost);
        break;
      case "script":
        this.sidebarTitle.textContent = "剧本列表";
        renderScriptList(this.sidebarViewHost);
        break;
      default:
        this.sidebarTitle.textContent = "资源管理器";
        this.sidebarViewHost.appendChild(this.explorerTab.root);
        break;
    }
  }

  // ---------------- 编辑区 ----------------

  private buildEditorArea(): void {
    // 画布：唯一的常驻标签
    this.canvas = new CanvasView({
      onHover: (x, y, hit) => {
        // UI 场景没有「格」，状态栏只报设计像素（报格数会让人误以为还有瓦片对齐）
        this.setCell(
          "pos",
          isUiScene(store.scene)
            ? `px ${Math.round(x)}, ${Math.round(y)}`
            : `格 ${Math.round(x / (store.project?.tileSize ?? 32))}, ${Math.round(y / (store.project?.tileSize ?? 32))}`
        );
        this.setCell("hit", hit ? hit.name : "—");
      },
      onCommit: (label) => this.scheduleSnapshot(label),
      onContextMenu: (obj, sx, sy) => this.objectMenu(obj, sx, sy)
    });

    this.registerTab({
      id: "canvas",
      label: "画布",
      icon: "scene",
      fixed: true,
      render: (host) => this.renderCanvasTab(host)
    });
  }

  /** 画布标签内容：工具条 + 画布。工具条跟着标签走，不在全局占一条横栏。 */
  private renderCanvasTab(host: HTMLElement): void {
    host.replaceChildren();

    const view = el("div", { class: "canvas-view" });

    // ---- 画布工具条（原顶部工具栏的全部能力）----
    const bar = el("div", { class: "canvas-toolbar" });

    const toolGroup = el("div", { class: "group" });
    this.toolButtons.clear();
    for (const t of TOOLS) {
      const b = iconButton(iconForTool(t.id), `${t.cn} ${t.en}（${t.key}）｜${t.hint}`, () => {
        store.setTool(t.id);
        this.hint(`${t.cn}：${t.hint}`);
      });
      this.toolButtons.set(t.id, b);
      toolGroup.appendChild(b);
    }
    bar.appendChild(toolGroup);
    bar.appendChild(el("div", { class: "sep" }));

    const toggles = el("div", { class: "group" });
    toggles.appendChild(toggleIcon(I.grid, "显示网格 Grid", () => store.showGrid, (v) => { store.showGrid = v; this.canvas.requestPaint(); }));
    toggles.appendChild(toggleIcon(I.snap, "吸附到网格 Snap", () => store.snapToGrid, (v) => { store.snapToGrid = v; this.hint(v ? "吸附已开启" : "吸附已关闭，可以自由摆放"); }));
    toggles.appendChild(toggleIcon(I.bounds, "显示碰撞体 Collider", () => store.showColliders, (v) => { store.showColliders = v; this.canvas.requestPaint(); }));
    toggles.appendChild(toggleIcon(I.zone, "显示触发区 Trigger", () => store.showZones, (v) => { store.showZones = v; this.canvas.requestPaint(); }));
    bar.appendChild(toggles);
    bar.appendChild(el("div", { class: "sep" }));

    // 缩放
    const zoomGroup = el("div", { class: "group" });
    zoomGroup.appendChild(iconButton(I.zoomOut, "缩小", () => this.canvas.setZoom(this.canvas.getZoom() / 1.2)));
    this.zoomLabel = el("span", { class: "muted tabular nowrap" }, "100%");
    this.zoomLabel.style.minWidth = "44px";
    this.zoomLabel.style.textAlign = "center";
    this.zoomLabel.style.fontSize = "12px";
    zoomGroup.appendChild(this.zoomLabel);
    zoomGroup.appendChild(iconButton(I.zoomIn, "放大", () => this.canvas.setZoom(this.canvas.getZoom() * 1.2)));
    zoomGroup.appendChild(iconButton(I.fit, "缩放到整张地图（F）", () => this.canvas.zoomToFit()));
    bar.appendChild(zoomGroup);

    bar.appendChild(el("div", { class: "spacer" }));

    // 高频动作留按钮，低频的收进「更多」菜单。
    // 为什么收：1280x720 下工具条是横向滚动的，右端按钮会被辅助栏截掉半截，
    // 用户不知道要横滚。收进菜单后主操作区永远完整可见。
    bar.appendChild(button("保存", () => void saveProjectFile(), { size: "sm", variant: "primary", iconPath: I.save, title: "保存工程（Ctrl+S）" }));
    bar.appendChild(button("预览", () => this.openPreview(), { size: "sm", iconPath: I.play, title: "在编辑器内预览场景" }));
    bar.appendChild(this.moreButton());

    view.appendChild(bar);
    view.appendChild(this.canvas.root);
    host.appendChild(view);
    this.refreshToolbarState();
  }

  /** 画布工具条的「更多」按钮：装低频动作，保证窄窗口下主按钮不被截断。 */
  private moreButton(): HTMLButtonElement {
    const b = button("更多", () => {
      const r = b.getBoundingClientRect();
      contextMenu(r.left - 70, r.bottom + 4, [
        { label: "删除选中对象", key: "Delete", onClick: () => this.canvas.deleteSelection() },
        { label: "复制选中对象", key: "Ctrl+D", onClick: () => this.duplicateSelection() },
        { divider: true },
        { label: "打开模块编辑器", key: "M", onClick: () => this.openModuleEditorForSelection() },
        { divider: true },
        { label: "打包到 BWE", onClick: () => void openBwePackager() },
        { label: "导出 Web 游戏包", disabled: true, hint: "下一步实现", onClick: () => this.exportWeb() }
      ]);
    }, {
      size: "sm",
      iconPath: I.chevronDown,
      title: "删除 / 复制 / 模块 / 打包"
    });
    return b;
  }

  private refreshToolbarState(): void {
    for (const [id, b] of this.toolButtons) {
      b.classList.toggle("active", store.tool === id);
    }
    if (this.zoomLabel) this.zoomLabel.textContent = Math.round((this.canvas?.getZoom() ?? 1) * 100) + "%";
  }

  // ---------------- 标签 ----------------

  private registerTab(tab: EditorTab): void {
    this.tabs.push(tab);
    this.renderTabs();
  }

  /** 打开（或聚焦）一个标签。 */
  openTab(id: string): void {
    if (!this.tabs.some((t) => t.id === id)) {
      if (id === "script") {
        this.registerTab({
          id: "script",
          label: "剧本",
          icon: "script",
          render: (host) => renderScriptEditor(host)
        });
      } else if (id === "package") {
        this.registerTab({
          id: "package",
          label: "打包",
          icon: "packageBox",
          render: (host) => this.renderPackageTab(host)
        });
      }
    }
    this.showTab(id);
  }

  closeTab(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.fixed) return;
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (this.activeTabId === id) {
      this.activeTabId = this.tabs[0]?.id ?? "canvas";
    }
    this.renderTabs();
    this.showTab(this.activeTabId);
  }

  showTab(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.activeTabId = id;
    for (const [key, btn] of this.tabButtons) btn.classList.toggle("active", key === id);
    // 切到剧本标签时，侧边栏应该显示剧本列表 —— 否则用户看不到"有哪些脚本"
    if (id === "script" && this.currentSidebarView !== "script") {
      this.shell.toggleSidebar(false);
      this.showSidebarView("script");
    }
    tab.render(this.shell.editorBody);
  }

  private renderTabs(): void {
    const bar = this.shell.editorTabs;
    bar.replaceChildren();
    this.tabButtons.clear();
    this.scriptDirtyDot = null;

    for (const tab of this.tabs) {
      const btn = el("div", {
        class: "editor-tab" + (tab.id === this.activeTabId ? " active" : ""),
        title: tab.label
      });
      btn.dataset.tab = tab.id;
      btn.setAttribute("draggable", "true");
      btn.appendChild(svg(I[tab.icon] as string, 13));
      btn.appendChild(el("span", { class: "editor-tab-label" }, tab.label));

      // 未保存圆点：脚本标签在工程 dirty 时显示（不精确到单个脚本，但对用户够用）
      if (tab.id === "script") {
        const dot = el("span", { class: "dirty-dot" });
        dot.style.display = store.dirty ? "" : "none";
        btn.appendChild(dot);
        this.scriptDirtyDot = dot;
      }

      if (!tab.fixed) {
        const close = el("span", { class: "tab-close", title: "关闭标签" });
        close.appendChild(svg(I.close, 11));
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeTab(tab.id);
        });
        btn.appendChild(close);
      }

      btn.addEventListener("click", () => this.showTab(tab.id));

      // 拖拽重排：只允许在标签之间交换顺序，画布固定标签不参与移动
      btn.addEventListener("dragstart", (e) => {
        (e as DragEvent).dataTransfer?.setData("text/x-bwe-tab", tab.id);
      });
      btn.addEventListener("dragover", (e) => {
        e.preventDefault();
        btn.classList.add("drag-over");
      });
      btn.addEventListener("dragleave", () => btn.classList.remove("drag-over"));
      btn.addEventListener("drop", (e) => {
        e.preventDefault();
        btn.classList.remove("drag-over");
        const from = (e as DragEvent).dataTransfer?.getData("text/x-bwe-tab");
        if (!from || from === tab.id) return;
        this.reorderTab(from, tab.id);
      });

      this.tabButtons.set(tab.id, btn);
      bar.appendChild(btn);
    }

    const spacer = el("div", { class: "tabs-spacer", title: "双击关闭其他标签" });
    spacer.addEventListener("dblclick", () => this.closeOtherTabs());
    bar.appendChild(spacer);
  }

  /** 拖拽重排：把 from 插到 to 的位置之前/之后，视觉顺序即数据顺序。 */
  private reorderTab(from: string, to: string): void {
    const fromIdx = this.tabs.findIndex((t) => t.id === from);
    const toIdx = this.tabs.findIndex((t) => t.id === to);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = this.tabs.splice(fromIdx, 1);
    // 画布永远是第一个，不能被挪到后面去（否则用户会以为画布"丢了"）
    const insertAt = Math.max(this.tabs[0]?.fixed ? 1 : 0, toIdx);
    this.tabs.splice(insertAt, 0, moved);
    this.renderTabs();
  }

  private closeOtherTabs(): void {
    this.tabs = this.tabs.filter((t) => t.fixed || t.id === this.activeTabId);
    this.renderTabs();
    this.showTab(this.activeTabId);
  }

  /** 打包标签：给个明确的工作台入口，具体打包 UI 在弹窗里（不重复实现）。 */
  private renderPackageTab(host: HTMLElement): void {
    host.replaceChildren();
    const box = el("div", { class: "col" });
    box.style.padding = "16px";
    box.appendChild(el("div", { class: "group-label" }, "打包到 BWE"));
    box.appendChild(
      el(
        "div",
        { class: "hint" },
        "把当前工程打成 Windows EXE / Android APK，或直接在本机起 Java 窗口试跑。\n"
        + "点下面的按钮打开打包工作台：它会在本机调用 JDK 的 jpackage，全程日志同时写进底部「输出」面板。"
      )
    );
    const row = el("div", { class: "row tight" });
    row.appendChild(button("打开打包工作台", () => void openBwePackager(), { variant: "primary", iconPath: I.exportImg }));
    row.appendChild(
      button(
        "查看输出",
        () => {
          this.setBottomTab("output");
          this.shell.togglePanel(false);
        },
        { variant: "outline", iconPath: I.terminal }
      )
    );
    box.appendChild(row);
    host.appendChild(box);
  }

  // ---------------- 右栏（辅助侧边栏） --------------

  private buildAux(): void {
    const aux = this.shell.auxPanel;
    const head = el("div", { class: "aux-head" });
    head.appendChild(el("div", { class: "group-label" }, "检查器"));
    aux.appendChild(head);

    const body = el("div", { class: "aux-body" });
    aux.appendChild(body);

    this.auxTab = new Tabbed(
      [
        { id: "inspector", label: "对象", hint: "选中对象的属性与挂载模块", render: renderInspector },
        { id: "layers", label: "图层", hint: "图层可见性与锁定", render: renderScenePanel },
        { id: "outline", label: "大纲", hint: "场景中所有对象的树状列表", render: renderOutlinePanel }
      ],
      "inspector"
    );
    body.appendChild(this.auxTab.root);
  }

  // ---------------- 底部面板 --------------

  private buildBottomPanel(): void {
    const head = this.shell.panelHead;

    const setTab = (id: "problems" | "output" | "ai", label: string, icon: keyof typeof I): HTMLButtonElement => {
      // data-panel-tab 是给验收脚本/外部自动化用的稳定锚点：
      // --tap 若按 nth-child 定位，标签顺序一变就点错地方。
      const b = el("button", { type: "button", class: "panel-tab", title: label, "data-panel-tab": id });
      b.appendChild(svg(I[icon] as string, 13));
      b.appendChild(el("span", null, label));
      b.addEventListener("click", () => this.setBottomTab(id));
      this.bottomTabButtons.set(id, b);
      head.appendChild(b);
      return b;
    };

    setTab("problems", "问题 Problems", "problems");
    setTab("output", "输出 Output", "terminal");
    setTab("ai", "AI 助手", "sparkles");

    // 问题计数徽标
    this.problemsBadge = el("span", { class: "count-badge" });
    this.problemsBadge.style.display = "none";
    this.bottomTabButtons.get("problems")?.appendChild(this.problemsBadge);

    const actions = el("div", { class: "panel-actions" });
    head.appendChild(actions);
    actions.appendChild(
      button("清空", () => this.clearCurrentBottomPanel(), {
        size: "sm",
        variant: "ghost",
        iconPath: I.trash,
        title: "清空当前面板内容"
      })
    );
    actions.appendChild(
      button("折叠", () => this.shell.togglePanel(true), {
        size: "sm",
        variant: "ghost",
        iconPath: I.panelToggle,
        title: "折叠底部面板（Ctrl+J）"
      })
    );

    // 订阅诊断变化：徽标与"问题"面板跟着刷新（按帧合并）
    onProblems(() => this.scheduleBottomRefresh());

    // 打包/试跑报错时跳到输出面板
    window.addEventListener("bwe:show-output", () => {
      this.setBottomTab("output");
      this.shell.togglePanel(false);
    });

  }

  private clearCurrentBottomPanel(): void {
    if (this.bottomTab === "ai") {
      void resetAiConversation();
      return;
    }
    if (this.bottomTab === "output") {
      void import("../core/output.ts").then((m) => m.clearOutput());
      return;
    }
    void import("../core/diagnostics.ts").then((m) => m.clearAllProblems());
  }

  /** 对外：切换底部面板标签（调试出口与验收脚本用）。 */
  openBottomTab(id: "problems" | "output" | "ai"): void {
    this.setBottomTab(id);
    this.shell.togglePanel(false);
  }

  private setBottomTab(id: "problems" | "output" | "ai"): void {
    this.bottomTab = id;
    for (const [key, b] of this.bottomTabButtons) b.classList.toggle("active", key === id);
    // AI 面板内容多，够高才看得见对话；问题/输出保持默认高度即可
    if (id === "ai") this.shell.ensurePanelHeight(380);
    this.refreshBottomPanel();
    // 面板高度变了，悬浮提示要跟着让位，否则会压在新出现的输入框上
    window.setTimeout(() => syncToastPosition(), 0);
  }

  private refreshBottomPanel(): void {
    const host = this.shell.panelBody;
    host.classList.toggle("flush", this.bottomTab === "ai");
    switch (this.bottomTab) {
      case "problems":
        renderProblemsPanel(host);
        break;
      case "output":
        renderOutputPanel(host);
        break;
      case "ai":
        // AI 面板自己算 sceneDigest、自己订流式事件；外壳只给挂载点与重画回调
        renderAiPanel(host, () => this.refreshBottomPanel());
        break;
    }
    this.updateProblemsBadge();
  }

  private bottomRefreshQueued = false;
  private scheduleBottomRefresh(): void {
    if (this.bottomRefreshQueued) return;
    this.bottomRefreshQueued = true;
    // 按帧合并：脚本每敲一个字都可能重跑检查，逐次重画面板会明显卡
    requestAnimationFrame(() => {
      this.bottomRefreshQueued = false;
      this.updateProblemsBadge();
      if (this.bottomTab === "problems") renderProblemsPanel(this.shell.panelBody);
    });
  }

  private updateProblemsBadge(): void {
    const counts = problemCounts();
    if (!this.problemsBadge) return;
    if (counts.errors || counts.warns) {
      this.problemsBadge.textContent = String(counts.errors || counts.warns);
      this.problemsBadge.style.background = counts.errors ? "" : "var(--warn-soft)";
      this.problemsBadge.style.color = counts.errors ? "" : "var(--warn)";
      this.problemsBadge.style.display = "";
    } else {
      this.problemsBadge.style.display = "none";
    }
    // 活动栏也挂一个：用户收起底部面板时仍然看得到"有错误"
    this.shell.setActivityBadge("explorer", counts.errors);
  }

  // ---------------- 状态栏 ----------------

  private buildStatus(): void {
    const bar = this.shell.statusbar;
    const mk = (key: string, w: number) => {
      const c = el("span", { class: "cell" });
      c.style.minWidth = w + "px";
      this.statusCells[key] = c;
      bar.appendChild(c);
      return c;
    };
    mk("scene", 150);
    mk("sel", 96);
    mk("pos", 120);
    mk("hit", 140);
    mk("assets", 130);

    this.hintEl = el("span", { class: "hint" }, STATUS_READY);
    bar.appendChild(this.hintEl);

    // AI 状态：拆成两个 cell。
    // 为什么拆：单 cell 在 1600 宽时也被省略号吃掉后半截，「命中率 / token」这些
    // 真正想让人看见的数字反而丢了。模型与用量分栏后每栏都短，永远不会互相挤。
    this.aiCell = el("span", { class: "cell ai-model", title: "AI 当前模型" });
    bar.appendChild(this.aiCell);
    this.aiUsageCell = el("span", { class: "cell ai-usage", title: "本轮 token 用量与缓存命中率" });
    bar.appendChild(this.aiUsageCell);

    // 桌面 / 网页模式标识：用户一眼知道自己在哪个壳里跑
    this.modeCell = el("span", { class: "cell mode-chip" });
    this.modeCell.textContent = hostMode() === "desktop" ? "桌面版" : "网页版";
    this.modeCell.title =
      hostMode() === "desktop"
        ? "桌面客户端：/api 全部走主进程 IPC，不需要 npm run serve"
        : "网页版：需要本地服务（npm run serve）才能打包/试运行";
    bar.appendChild(this.modeCell);
    if (hostMode() !== "desktop") this.modeCell.classList.add("web");
  }

  private setCell(key: string, text: string): void {
    const c = this.statusCells[key];
    if (c && c.textContent !== text) c.textContent = text;
  }

  hint(text: string): void {
    if (!this.hintEl) return;
    this.hintEl.textContent = text;
    this.hintEl.classList.add("flash");
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      this.hintEl.classList.remove("flash");
      this.hintEl.textContent = STATUS_READY;
    }, 4200);
  }

  // ==========================================================================
  // 刷新
  // ==========================================================================

  refreshChrome(): void {
    this.titleEl.textContent = store.title();
    const scene = store.scene;
    this.setCell("scene", scene ? `${scene.name}　${scene.objects.length} 对象` : "无场景");
    this.setCell("sel", `选中 ${store.selection.length}`);
    this.setCell("assets", `素材 ${store.assets.length}`);
    if (this.zoomLabel) this.zoomLabel.textContent = Math.round((this.canvas?.getZoom() ?? 1) * 100) + "%";
    this.refreshToolbarState();
    if (this.scriptDirtyDot) this.scriptDirtyDot.style.display = store.dirty ? "" : "none";

    // AI 状态条（同步读取，不触发请求）
    const ai = aiPanelSummary();
    const hit = Math.round(ai.cacheHitRate * 100);
    const tok = ai.usage
      ? `${ai.usage.inputTokens + ai.usage.cacheReadTokens}/${ai.usage.outputTokens}`
      : "—";
    this.aiCell.textContent = `AI ${ai.model || (ai.mock ? "本地演示" : "—")}`;
    this.aiUsageCell.textContent = `命中 ${hit}% · token ${tok}`;
    this.modeCell.textContent = hostMode() === "desktop" ? "桌面版" : "网页版";
  }

  refreshPanels(): void {
    // 只重建当前可见的那一页，不连带重建两侧全部 Tab 树
    if (this.currentSidebarView === "explorer") this.explorerTab.refresh();
    this.auxTab.refresh();
    this.refreshChrome();
    this.canvas.requestPaint();
  }

  /**
   * 按帧合并的面板重建。
   *
   * 为什么需要：`bwe:refresh` 有 20 多处派发点，属性面板每改一个字段就发一次，
   * 而每次刷新要重建 DOM 树。连续输入时一帧里可能触发好几次，
   * 逐次同步重建 = 用户能感觉到的卡顿。合并到下一帧后肉眼无差别、开销降一个量级。
   */
  private panelsDirty = false;

  schedulePanels(): void {
    if (this.panelsDirty) return;
    this.panelsDirty = true;
    requestAnimationFrame(() => {
      this.panelsDirty = false;
      this.refreshPanels();
    });
  }

  /** 只重渲染右栏（对象 Inspector / 图层 / 大纲）。 */
  refreshRightPanel(): void {
    this.auxTab.show(this.auxTab.current());
  }

  /**
   * 选择变化时按帧合并刷新右栏。
   *
   * 之前的问题：canvas 里选中对象后既没有发 bwe:refresh，也没有任何地方监听
   * store.onSelection 去重建右栏，于是 Inspector 要等到下一次别的操作才顺带刷新。
   */
  private rightPanelDirty = false;

  private scheduleRightPanel(): void {
    if (this.rightPanelDirty) return;
    this.rightPanelDirty = true;
    requestAnimationFrame(() => {
      this.rightPanelDirty = false;
      this.refreshRightPanel();
    });
  }

  // ==========================================================================
  // 全局事件
  // ==========================================================================

  private bindGlobalEvents(): void {
    // 从别处触发的重绘请求（画布外的地方改了数据）
    window.addEventListener("bwe:repaint", () => this.refreshAfterExternalChange());
    window.addEventListener("bwe:fit", () => this.fitView());
    window.addEventListener("bwe:undo", () => this.undo());
    window.addEventListener("bwe:redo", () => this.redo());
    window.addEventListener("bwe:open-modules", () => this.focusPanel("modules"));
    window.addEventListener("bwe:open-scripts", () => this.openTab("script"));
    window.addEventListener("bwe:open-script-tab", () => this.openTab("script"));
    window.addEventListener("bwe:open-canvas-tab", () => this.showTab("canvas"));
    window.addEventListener("bwe:open-ai", () => {
      this.setBottomTab("ai");
      this.shell.togglePanel(false);
    });
    // 剧本面板请求重画：侧边栏列表与编辑区编辑器分属两棵 DOM 树，两边都要刷
    window.addEventListener("bwe:refresh-script-ui", () => {
      if (this.currentSidebarView === "script") renderScriptList(this.sidebarViewHost);
      if (this.activeTabId === "script") renderScriptEditor(this.shell.editorBody);
    });
    // 规则包被拖到对象上：整包套用（"模块拼接"的落地点）
    window.addEventListener("bwe:apply-pack", (e) => {
      const d = (e as CustomEvent).detail as { packId: string; objectId: string };
      this.applyPackTo(d.packId, d.objectId);
    });
    // 面板自己接住 Ctrl+S 后广播保存请求（全局快捷键对 textarea 是放行的）
    window.addEventListener("bwe:save", () => void saveProjectFile());
    window.addEventListener("bwe:hint", (e) => this.hint(String((e as CustomEvent).detail ?? "")));
    window.addEventListener("resize", () => this.canvas?.requestPaint());
  }

  // ==========================================================================
  // 命令注册（菜单 / 快捷键 / 命令面板共用这一份）
  // ==========================================================================

  private registerAllCommands(): void {
    registerCommands([
      // ---------------- 文件 ----------------
      { id: "file.new", title: "新建工程", key: "Ctrl+N", group: "文件", icon: "newFile", hint: "从空白工程开始", run: () => this.newProject() },
      { id: "file.open", title: "打开工程…", key: "Ctrl+O", group: "文件", icon: "open", hint: "选一个 .bwproj 文件", run: () => void openProjectFile() },
      { id: "file.save", title: "保存", key: "Ctrl+S", group: "文件", icon: "save", hint: "写回当前工程", run: () => void saveProjectFile() },
      { id: "file.saveAs", title: "另存为（保存副本 .bwproj）", group: "文件", icon: "save", hint: "下载一份当前工程的副本", run: () => downloadProject() },

      // ---------------- 编辑 ----------------
      { id: "edit.undo", title: "撤销", key: "Ctrl+Z", group: "编辑", icon: "undo", run: () => this.undo() },
      { id: "edit.redo", title: "重做", key: "Ctrl+Y", group: "编辑", icon: "redo", run: () => this.redo() },
      { id: "edit.duplicate", title: "复制选中对象", key: "Ctrl+D", group: "编辑", icon: "copy", run: () => this.duplicateSelection() },
      { id: "edit.delete", title: "删除选中对象", key: "Delete", group: "编辑", icon: "trash", run: () => this.canvas.deleteSelection() },
      { id: "edit.moduleEditor", title: "打开模块编辑器", key: "M", group: "编辑", icon: "module", hint: "对单选中的对象打开独立模块编辑器", run: () => this.openModuleEditorForSelection() },

      // ---------------- 视图 ----------------
      { id: "view.fit", title: "缩放到整张地图", key: "F", group: "视图", icon: "fit", run: () => this.canvas.zoomToFit() },
      { id: "view.zoom100", title: "缩放 100%", group: "视图", icon: "zoomIn", run: () => this.canvas.setZoom(1) },
      { id: "view.toggleGrid", title: "切换网格显示", group: "视图", icon: "grid", run: () => { store.showGrid = !store.showGrid; this.canvas.requestPaint(); } },
      { id: "view.toggleColliders", title: "切换碰撞体显示", group: "视图", icon: "bounds", run: () => { store.showColliders = !store.showColliders; this.canvas.requestPaint(); } },
      { id: "view.toggleNames", title: "切换对象名称显示", group: "视图", icon: "eye", run: () => { store.showNames = !store.showNames; this.canvas.requestPaint(); } },
      { id: "view.sidebar", title: "切换侧边栏", key: "Ctrl+B", group: "视图", icon: "sidebarToggle", run: () => this.shell.toggleSidebar() },
      { id: "view.panel", title: "切换底部面板", key: "Ctrl+J", group: "视图", icon: "panelToggle", run: () => this.shell.togglePanel() },
      { id: "view.problems", title: "显示问题面板", key: "Ctrl+Shift+M", group: "视图", icon: "problems", run: () => { this.setBottomTab("problems"); this.shell.togglePanel(false); } },
      { id: "view.output", title: "显示输出面板", group: "视图", icon: "terminal", run: () => { this.setBottomTab("output"); this.shell.togglePanel(false); } },
      { id: "view.commandPalette", title: "命令面板", key: "Ctrl+Shift+P", group: "视图", icon: "search", run: () => openCommandPalette() },

      // ---------------- 工程 ----------------
      { id: "project.settings", title: "工程设置", group: "工程", icon: "settings", run: () => { this.shell.toggleSidebar(false); this.showSidebarView("settings"); } },
      { id: "project.package", title: "打包到 BWE（Windows EXE）…", group: "工程", icon: "packageBox", hint: "需要本地服务（网页版）或桌面客户端", run: () => void openBwePackager() },
      { id: "project.preview", title: "在编辑器内预览场景", group: "工程", icon: "eye", run: () => this.openPreview() },
      { id: "project.exportWeb", title: "导出 Web 游戏包", group: "工程", icon: "exportImg", enabled: () => false, run: () => this.exportWeb() },
      { id: "edit.prefabs", title: "预制体面板…", group: "工程", icon: "pack", run: () => { this.shell.toggleSidebar(false); this.showSidebarView("explorer"); this.explorerTab.focus("prefabs"); } },
      { id: "project.newExample", title: "新建示例工程", group: "工程", icon: "newFile", hint: "内置主角、敌人、箱子、触发区，直接可用", run: () => this.newExampleProject() },
      { id: "project.example.minesweeper", title: "扫雷示例（.bwproj）", group: "工程", icon: "module", run: () => this.newBuiltinExample("minesweeper") },
      { id: "project.example.dressup", title: "换装示例（.bwproj）", group: "工程", icon: "module", run: () => this.newBuiltinExample("dressup") },
      { id: "project.example.topdown", title: "俯视角 JS 示例（.bwproj）", group: "工程", icon: "module", run: () => this.newBuiltinExample("topdown-js") },
      { id: "project.example.emergence", title: "涌现沙盘示例（.bwproj）", group: "工程", icon: "module", run: () => this.newBuiltinExample("emergence") },
      { id: "project.example.vampire", title: "吸血鬼幸存者（.bwproj）", group: "工程", icon: "module", run: () => this.newBuiltinExample("vampire") },

      // ---------------- 剧本 ----------------
      { id: "script.open", title: "打开剧本编辑器", group: "剧本", icon: "script", run: () => this.openTab("script") },
      { id: "script.jsApi", title: "JS 脚本 API 速查", group: "剧本", icon: "help", run: () => requestOpenScriptPanel("js") },
      { id: "script.goToProblems", title: "查看问题列表", group: "剧本", icon: "warn", run: () => { this.setBottomTab("problems"); this.shell.togglePanel(false); } },

      // ---------------- AI ----------------
      { id: "ai.focus", title: "AI：打开助手面板", group: "AI", icon: "sparkles", run: () => { this.setBottomTab("ai"); this.shell.togglePanel(false); } },
      { id: "ai.explainError", title: "AI：解释当前错误", group: "AI", icon: "warn", hint: "带诊断摘要 + 当前脚本", run: () => this.runAiAction("explain-error") },
      { id: "ai.editScript", title: "AI：改这段脚本", group: "AI", icon: "wand", hint: "改动先进 diff 预览，点「应用」才写回", run: () => this.runAiAction("edit-script") },
      { id: "ai.sceneReview", title: "AI：审一遍当前场景", group: "AI", icon: "eye", hint: "发工程摘要，不发原始工程数据", run: () => this.runAiAction("scene-review") },
      { id: "ai.reset", title: "AI：重置对话", group: "AI", icon: "close", run: () => void resetAiConversation() },

      // ---------------- 原生菜单承接（hidden：不进命令面板，只为菜单能点到） ----------------
      { id: "project.quickRunStop", title: "停止试跑", group: "工程", hidden: true, run: () => {
        void apiFetch("/api/quick-run/stop", { method: "POST" })
          .then((r) => r.json())
          .then((d: { stopped?: boolean }) => info((d as { stopped?: boolean })?.stopped ? "已停止试跑" : "当前没有在跑的试跑进程"))
          .catch(() => warn("停止试跑失败，可手动结束 java 进程"));
      } },
      { id: "project.reveal", title: "在文件管理器中显示工程", group: "工程", hidden: true, run: () => {
        const p = store.project;
        if (!p) return;
        warn("网页版无法定位工程文件；桌面版请用「文件 → 打开工程」查看最近列表");
      } },
      { id: "script.openInVscode", title: "用 VS Code 打开当前脚本", group: "剧本", hidden: true, run: () => {
        requestOpenScriptPanel();
        info("已切到剧本面板：点右上「VS Code 打开」把他写进文件");
      } },
      { id: "script.checkAll", title: "检查全部 JS 脚本", group: "剧本", hidden: true, run: () => {
        this.checkAllScripts();
      } },

      // ---------------- 帮助 ----------------
      { id: "help.quickStart", title: "快速上手", key: "F1", group: "帮助", icon: "help", run: () => showQuickStart() },
      { id: "help.modules", title: "模块速查", group: "帮助", icon: "module", run: () => this.focusPanel("modules") },
      { id: "help.jsApi", title: "JS 脚本 API 速查", group: "帮助", icon: "script", hint: "在剧本面板搜 bwe API，点一条插到光标处", run: () => requestOpenScriptPanel("js") },
      { id: "help.about", title: "关于 BWE Studio", group: "帮助", icon: "info", run: () => showAbout() }
    ]);
  }

  /** 命令面板里的 AI 动作：先切到 AI 面板，再由面板发起请求。 */
  private runAiAction(intent: "explain-error" | "edit-script" | "scene-review"): void {
    this.setBottomTab("ai");
    this.shell.togglePanel(false);
    requestAiAction(intent);
  }

  /**
   * 检查全部 JS 脚本（原生菜单 js-check 的落点，也可被命令面板触发）。
   *
   * 为什么单独实现：试跑/打包工作台里那段检查只为"能不能起 Java"，结果只进弹窗；
   * 这里的结果要进底部「问题」面板，所以复用同一个 /api/js-check，但落到诊断中心。
   */
  private checkAllScripts(): void {
    const p = store.project;
    if (!p) {
      info("先打开一个工程");
      return;
    }
    const names = Object.keys(p.scripts).filter((n) => p.scripts[n]?.lang === "js" || (p.scripts[n] && !p.scripts[n].lang));
    if (!names.length) {
      info("工程里没有 JS 脚本");
      return;
    }
    let done = 0;
    const total = names.length;
    appendOutput("脚本检查", `开始检查 ${total} 个 JS 脚本…`);
    for (const name of names) {
      const src = p.scripts[name]?.source ?? "";
      void import("../core/diagnostics.ts").then(async ({ setProblems, clearProblems }) => {
        try {
          const r = await apiFetch("/api/js-check", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ source: src, name })
          });
          if (!r.ok) {
            appendOutput("脚本检查", `「${name}」诊断服务不可用（HTTP ${r.status}）`, "warn");
          } else {
            const data = (await r.json()) as { diagnostics?: { line: number; col: number; severity: string; message: string }[] };
            const diags = data.diagnostics ?? [];
            const list = diags.map((d, i) => ({
              id: `js:${name}#${i}`,
              severity: (d.severity === "warning" ? "warn" : d.severity === "error" ? "error" : "info") as "error" | "warn" | "info",
              source: "js" as const,
              sourceLabel: `剧本 · ${name}`,
              scriptName: name,
              scriptLang: "js" as const,
              line: d.line,
              col: d.col,
              message: d.message
            }));
            if (list.length) setProblems(`js:${name}`, list);
            else clearProblems(`js:${name}`);
            appendOutput("脚本检查", `「${name}」：${diags.filter((d) => d.severity === "error").length} 错误 / ${diags.filter((d) => d.severity !== "error").length} 警告`);
          }
        } catch (e) {
          appendOutput("脚本检查", `「${name}」检查失败：${(e as Error).message}`, "error");
        }
        done++;
        if (done === total) {
          this.setBottomTab("problems");
          this.shell.togglePanel(false);
        }
      });
    }
  }

  /** AI 面板把脚本改动写回工程：这里是唯一的落地实现。 */
  private applyAiScript(name: string, code: string): void {
    const p = store.project;
    if (!p || !p.scripts[name]) return;
    p.scripts[name].source = code;
    store.markDirty();
    window.dispatchEvent(new CustomEvent("bwe:commit", { detail: { label: "AI 改脚本" } }));
    this.scheduleSnapshot("AI 改脚本");
    // 编辑器与侧边栏列表都要重画（用户需要看见改动落进去了）
    if (this.activeTabId === "script") renderScriptEditor(this.shell.editorBody);
    if (this.currentSidebarView === "script") renderScriptList(this.sidebarViewHost);
    this.refreshPanels();
  }

  // ==========================================================================
  // 原生菜单（桌面版）
  // ==========================================================================

  /**
   * 主进程原生菜单发来的命令 → 命令注册表 id。
   *
   * 为什么要有这张表：菜单在 Electron 主进程里定义（A 线），命令在渲染侧注册（我这里），
   * 两边名字不可能自然一致，必须显式对齐。没有这张表，桌面版的菜单点下去是死的。
   */
  private readonly MENU_COMMANDS: Record<string, string> = {
    "new-project": "file.new",
    "open-project": "file.open",
    "save-project": "file.save",
    "save-project-as": "file.saveAs",
    pack: "project.package",
    quickrun: "project.package",
    "quickrun-stop": "project.quickRunStop",
    "command-palette": "view.commandPalette",
    "toggle-sidebar": "view.sidebar",
    "toggle-panel": "view.panel",
    "toggle-ai-panel": "ai.focus",
    "open-settings": "project.settings",
    "open-samples": "project.newExample",
    about: "help.about",
    "help-shortcuts": "help.quickStart",
    "help-api-docs": "help.jsApi",
    "reveal-project": "project.reveal",
    "open-vscode": "script.openInVscode",
    "js-check": "script.checkAll",
    "toggle-activity-bar": "view.sidebar"
  };

  private bindDesktopHost(): void {
    onMenuCommand((raw) => {
      // 最近工程：open-recent:<绝对路径>，内容由主进程读好后另行推送
      if (raw.startsWith("open-recent:")) {
        appendOutput("编辑器", `从最近工程打开：${raw.slice("open-recent:".length)}`);
        return;
      }
      // 直接映射到命令；搜索面板这类没有对应命令名的单独处理
      if (raw === "search-panel") {
        this.shell.toggleSidebar(false);
        this.showSidebarView("search");
        return;
      }
      const id = this.MENU_COMMANDS[raw];
      if (id) {
        runCommand(id);
        return;
      }
      // 没有映射也不静默吞掉：写进输出面板，排查时一眼看到"菜单发了个我没接的命令"
      appendOutput("编辑器", `未接的原生菜单命令：${raw}`, "warn");
    });

    // 原生「打开工程」：主进程读好内容直接送进来，渲染侧不碰磁盘
    onOpenProjectRequest((path, content) => {
      try {
        const parsed = JSON.parse(content) as unknown;
        const name = path.split(/[\/]/).pop() ?? "";
        this.setProject(parsed, name);
        ok(`已打开：${name}`);
      } catch (e) {
        error(`打开工程失败：${(e as Error).message}`);
      }
    });
  }

  // ==========================================================================
  // 快捷键（保留原有全部按键，另加 Ctrl+B / Ctrl+J / Ctrl+Shift+P 等）
  // ==========================================================================

  private bindShortcuts(): void {
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      const inField = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (inField) {
        // 输入框里只放行 Esc（失焦）与命令面板组合键，其余交给输入框自己
        if (e.key === "Escape") (t as HTMLInputElement).blur();
        else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
          e.preventDefault();
          openCommandPalette();
        }
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;

      // ---- 新增的 VS Code 惯用键 ----
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        openCommandPalette();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "b") {
        e.preventDefault();
        this.shell.toggleSidebar();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "j") {
        e.preventDefault();
        this.shell.togglePanel();
        return;
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        this.shell.setActiveActivity("explorer");
        this.onActivity("explorer");
        return;
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        this.shell.setActiveActivity("search");
        this.onActivity("search");
        return;
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        this.setBottomTab("problems");
        this.shell.togglePanel(false);
        return;
      }
      // 标签导航：Ctrl+Tab 在已打开的标签间循环
      if (ctrl && e.key === "Tab") {
        e.preventDefault();
        const i = this.tabs.findIndex((x) => x.id === this.activeTabId);
        const next = this.tabs[(i + 1) % this.tabs.length];
        if (next) this.showTab(next.id);
        return;
      }

      // ---- 原有快捷键（一个都不能丢）----
      if (ctrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveProjectFile();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("bwe:undo"));
        return;
      }
      if (ctrl && e.key.toLowerCase() === "y") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("bwe:redo"));
        return;
      }
      if (ctrl && e.key.toLowerCase() === "d") {
        e.preventDefault();
        this.duplicateSelection();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "n") {
        e.preventDefault();
        this.newProject();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProjectFile();
        return;
      }
      if (e.key === "F1") {
        e.preventDefault();
        showQuickStart();
        return;
      }
      if (e.key === "f" || e.key === "F") {
        this.canvas.zoomToFit();
        return;
      }
      if ((e.key === "m" || e.key === "M") && !ctrl) {
        e.preventDefault();
        this.openModuleEditorForSelection();
        return;
      }
      // 单键切工具（编辑器的肌肉记忆，不能省）
      const map: Record<string, Tool> = { v: "select", b: "brush", e: "erase", z: "zone", h: "pan" };
      const tool = map[e.key.toLowerCase()];
      if (tool && !ctrl) {
        store.setTool(tool);
        const meta = TOOLS.find((x) => x.id === tool);
        if (meta) this.hint(`${meta.cn}：${meta.hint}`);
      }
    });
  }

  // ==========================================================================
  // 对象操作（原逻辑保持不变）
  // ==========================================================================

  private objectMenu(obj: SceneObject, sx: number, sy: number) {
    void sx;
    void sy;
    const scene = store.scene;
    if (!scene) return null;
    return [
      { label: "复制一份", key: "Ctrl+D", onClick: () => this.duplicateSelection() },
      { label: "上移一层", key: "Ctrl+↑", onClick: () => this.nudgeZ(obj, 1) },
      { label: "下移一层", key: "Ctrl+↓", onClick: () => this.nudgeZ(obj, -1) },
      { label: "置顶", onClick: () => this.sendZ(obj, "top") },
      { label: "置底", onClick: () => this.sendZ(obj, "bottom") },
      { divider: true },
      { label: obj.locked ? "解锁" : "锁定（防止误拖）", onClick: () => { obj.locked = !obj.locked; store.markDirty(); this.refreshPanels(); } },
      { label: obj.visible ? "隐藏" : "显示", onClick: () => { obj.visible = !obj.visible; store.markDirty(); this.canvas.requestPaint(); } },
      { divider: true },
      {
        label: "从这里对齐到格中心",
        onClick: () => {
          const t = store.project?.tileSize ?? 32;
          obj.x = Math.floor(obj.x / t) * t + t / 2;
          obj.y = Math.floor(obj.y / t) * t + t / 2;
          store.markDirty();
          this.canvas.requestPaint();
        }
      },
      {
        label: "删除",
        key: "Delete",
        onClick: () => {
          scene.objects = scene.objects.filter((o) => o !== obj);
          store.forget(obj);
          store.markDirty();
          window.dispatchEvent(new CustomEvent("bwe:commit"));
          this.canvas.requestPaint();
        }
      }
    ];
  }

  /**
   * 同图层内把对象上移/下移"一层"。
   *
   * 层级由 z 决定（同 z 再比 y）。直接给 z ±1 可能撞上已经占用的 z，
   * 导致"点了没反应"，所以这里按实际绘制顺序交换名次。
   */
  private nudgeZ(obj: SceneObject, dir: 1 | -1): void {
    const scene = store.scene;
    if (!scene) return;
    const sameLayer = orderObjects(scene).filter((o) => o.layerId === obj.layerId);
    const i = sameLayer.indexOf(obj);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= sameLayer.length) {
      this.hint(dir > 0 ? "已经在最上层了" : "已经在最下层了");
      return;
    }
    const tmp = sameLayer[i];
    sameLayer[i] = sameLayer[j];
    sameLayer[j] = tmp;
    sameLayer.forEach((o, k) => { o.z = k; });
    store.markDirty();
    window.dispatchEvent(new CustomEvent("bwe:commit"));
    this.canvas.requestPaint();
    this.refreshPanels();
  }

  /** 直接送到同图层的最顶或最底。 */
  private sendZ(obj: SceneObject, where: "top" | "bottom"): void {
    const scene = store.scene;
    if (!scene) return;
    const sameLayer = orderObjects(scene).filter((o) => o.layerId === obj.layerId);
    const rest = sameLayer.filter((o) => o !== obj);
    const next = where === "top" ? [...rest, obj] : [obj, ...rest];
    next.forEach((o, k) => { o.z = k; });
    store.markDirty();
    window.dispatchEvent(new CustomEvent("bwe:commit"));
    this.canvas.requestPaint();
    this.refreshPanels();
  }

  private duplicateSelection(): void {
    const scene = store.scene;
    if (!scene || !store.selection.length) {
      this.hint("先选中要复制的对象");
      return;
    }
    const t = store.project?.tileSize ?? 32;
    const copies = store.selection.map((src) => {
      const c: SceneObject = {
        ...src,
        id: crypto.randomUUID(),
        x: src.x + t,
        y: src.y + t,
        modules: src.modules.map((m) => ({ ...m, values: { ...m.values } })),
        props: { ...src.props },
        tags: [...src.tags]
      };
      scene.objects.push(c);
      return c;
    });
    store.selectMany(copies);
    store.markDirty();
    window.dispatchEvent(new CustomEvent("bwe:commit"));
    ok(`已复制 ${copies.length} 个对象`);
    this.canvas.requestPaint();
  }

  // ==========================================================================
  // 工程
  // ==========================================================================

  private newProject(): void {
    const doNew = () => {
      store.setProject(createProject("未命名工程"));
      this.hint("新工程已创建，从左边「素材」导入图片开始");
      this.refreshPanels();
      this.canvas.zoomToFit();
    };
    if (store.dirty) {
      void confirmDialog("当前工程还没保存", "新建会丢掉当前的改动。想留着的话先点「保存」。", "不保存，新建", true).then((y) => {
        if (y) doNew();
      });
      return;
    }
    doNew();
  }

  private newExampleProject(): void {
    this.loadExampleProject(
      () => createExampleProject(),
      "示例工程.bwproj",
      "示例工程已载入：试着选中主角，点工具条「模块」打开独立编辑器；把素材拖到画布上试试。"
    );
  }

  private newBuiltinExample(id: ExampleId): void {
    const built = buildExample(id);
    const tips: Record<ExampleId, string> = {
      minesweeper: "扫雷示例已载入：点「预览」直接试玩；行数、列数、地雷数在「模块」→「扫雷棋盘」里改。",
      dressup: "换装示例已载入：点「预览」试玩；每个部位的造型和素材在「模块」→「换装部件」里改。",
      "topdown-js": "俯视角 JS 示例已载入：脚本在「剧本」标签里切到 JS 看 player/chaser/npc/hud/system；点「试跑」直接开窗口。",
      emergence: "涌现沙盘已载入：脚本在「剧本」标签（world/player/guard/civilian/bottle/hud）。点火看火势蔓延、烧穿木栅开路，守卫会被噪音引来——规则都在 bwe.material / bwe.field / bwe.ai 里组合。",
      vampire: "吸血鬼幸存者已载入：点「预览」直接开打。WASD 走位、武器自动开火、1/2/3 选强化、R 重开；六个脚本（player/enemy/bullet/gem/director/hud）都在「剧本」标签里。"
    };
    this.loadExampleProject(() => built.project, built.fileName, tips[id]);
  }

  private loadExampleProject(build: () => Project, fileName: string, tip: string): void {
    const doNew = () => {
      store.setProject(build(), fileName);
      this.hint(tip);
      this.refreshPanels();
      this.canvas.zoomToFit();
    };
    if (store.dirty) {
      void confirmDialog(
        "当前工程还没保存",
        "载入示例会丢掉当前的改动。想留着的话先点「保存」。",
        "不保存，载入示例",
        true
      ).then((y) => {
        if (y) doNew();
      });
      return;
    }
    doNew();
  }

  private openModuleEditorForSelection(): void {
    const obj = store.single;
    if (!obj) {
      warn(store.selection.length > 1 ? "模块编辑器一次只编辑一个对象，请先单选" : "先在画布上选中一个对象");
      return;
    }
    openModuleEditor(obj);
  }

  private exportWeb(): void {
    info("Web 游戏包导出正在开发中");
  }

  /** 编辑器内静态预览：用 Canvas 把当前场景画出来，支持缩放和平移，不运行模块逻辑。 */
  private openPreview(): void {
    const scene = store.scene;
    const project = store.project;
    if (!scene || !project) {
      info("没有可预览的场景");
      return;
    }

    const ordered = orderObjects(scene);
    const tile = project.tileSize;
    // UI 场景的「地图」是设计分辨率，不是「格 × tileSize」。
    // 预览窗口里也必须用同一套尺寸，否则预览里的界面对不上编辑器里摆的位置。
    const sceneSize = scenePixelSize(scene, tile);
    const mapW = sceneSize.w;
    const mapH = sceneSize.h;
    const uiScene = isUiScene(scene);

    const game = detectMinigame(scene);
    let miniDispose: (() => void) | null = null;

    let camX = mapW / 2;
    let camY = mapH / 2;
    // 初始缩放：UI 场景按设计稿整张铺进来，世界场景保持 1:1
    let zoom = 1;
    if (uiScene) {
      const cw0 = 700;
      const ch0 = 520;
      zoom = Math.max(0.15, Math.min((cw0 - 24) / mapW, (ch0 - 24) / mapH));
    }

    let isPanning = false;
    let lastScreen = { x: 0, y: 0 };
    let previewWrap: HTMLDivElement | null = null;
    let paintPreview: (() => void) | null = null;

    const onMove = (e: MouseEvent) => {
      if (!isPanning) return;
      camX -= (e.clientX - lastScreen.x) / zoom;
      camY -= (e.clientY - lastScreen.y) / zoom;
      lastScreen = { x: e.clientX, y: e.clientY };
      paintPreview?.();
    };
    const onUp = () => {
      isPanning = false;
      if (previewWrap) previewWrap.style.cursor = "default";
    };

    const close = modal({
      title: game ? `试玩 — ${scene.name}` : `预览 — ${scene.name}`,
      xwide: true,
      closeOnMask: false,
      body: (closeFn) => {
        if (game) {
          const host = el("div", { class: "mg-modal-body" });
          const ctx = {
            project,
            scene,
            obj: game.obj,
            mod: game.mod,
            onConfigure: () => {
              closeFn();
              openModuleEditor(game.obj);
            }
          };
          const run = game.type === "minesweeper"
            ? renderMinesweeper(host, ctx)
            : renderDressup(host, ctx);
          miniDispose = run.dispose;
          return host;
        }

        const box = el("div", { class: "col" });
        box.style.gap = "8px";

        const hint = el("div", { class: "hint", style: { fontSize: "11.5px", color: "var(--text-3)" } });
        hint.textContent = "拖动平移 · 滚轮缩放 · 这是静态预览，不运行游戏逻辑";
        box.appendChild(hint);

        const wrap = el("div", { class: "preview-wrap" });
        wrap.style.width = "100%";
        wrap.style.height = "520px";
        wrap.style.background = "var(--canvas-bg)";
        wrap.style.border = "1px solid var(--line)";
        wrap.style.borderRadius = "var(--r-md)";
        wrap.style.overflow = "hidden";
        wrap.style.position = "relative";
        box.appendChild(wrap);

        const canvas = el("canvas");
        canvas.style.position = "absolute";
        canvas.style.top = "0";
        canvas.style.left = "0";
        wrap.appendChild(canvas);

        const ctrl = el("div", { class: "row tight" });
        ctrl.style.marginTop = "6px";
        ctrl.appendChild(button("缩小 −", () => { zoom = Math.max(0.25, zoom - 0.25); paintPreview?.(); }, { size: "sm" }));
        ctrl.appendChild(button("放大 ＋", () => { zoom = Math.min(3, zoom + 0.25); paintPreview?.(); }, { size: "sm" }));
        ctrl.appendChild(button(uiScene ? "整张设计稿" : "整张地图", () => {
          zoom = Math.min((wrap.clientWidth - 24) / mapW, (wrap.clientHeight - 24) / mapH, 2);
          // UI 场景整稿缩放可能小于 0.25（1280 宽塞进 700 窗口 = 0.53，但 1920 会是 0.35），
          // 所以下限也要跟着放宽，否则「点了没反应」。
          zoom = Math.max(uiScene ? 0.1 : 0.25, zoom);
          camX = mapW / 2;
          camY = mapH / 2;
          zoomLabel.textContent = `缩放 ${Math.round(zoom * 100)}%`;
          paintPreview?.();
        }, { size: "sm" }));
        ctrl.appendChild(el("div", { class: "spacer" }));
        const zoomLabel = el("span", { class: "muted tabular" }, `缩放 ${Math.round(zoom * 100)}%`);
        ctrl.appendChild(zoomLabel);
        // 「放大/缩小」按钮也要同步更新百分比，否则用户点了看到的数字永远不变
        const bumpZoom = (next: number) => {
          zoom = Math.min(3, Math.max(uiScene ? 0.1 : 0.25, next));
          zoomLabel.textContent = `缩放 ${Math.round(zoom * 100)}%`;
          paintPreview?.();
        };
        const [minusBtn, plusBtn] = Array.from(ctrl.querySelectorAll("button")) as HTMLButtonElement[];
        minusBtn?.replaceWith(button("缩小 −", () => bumpZoom(zoom - 0.25), { size: "sm" }));
        plusBtn?.replaceWith(button("放大 ＋", () => bumpZoom(zoom + 0.25), { size: "sm" }));
        box.appendChild(ctrl);

        const dpr = window.devicePixelRatio || 1;
        const cw = wrap.clientWidth || 700;
        const ch = wrap.clientHeight || 520;
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        const g = canvas.getContext("2d")!;
        const cssVar = (name: string, fallback: string): string => {
          const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
          return v || fallback;
        };

        const worldToScreen = (wx: number, wy: number) => {
          return { x: (wx - camX) * zoom + cw / 2, y: (wy - camY) * zoom + ch / 2 };
        };

        paintPreview = () => {
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.imageSmoothingEnabled = false;
          // 用主题令牌而不是写死深色：奶油主题下预览也要是奶油底
          g.fillStyle = cssVar("--canvas-bg", "#15171d");
          g.fillRect(0, 0, cw, ch);

          // 画网格：UI 场景按 8px 参考线，世界场景按瓦片
          g.strokeStyle = cssVar("--canvas-grid", "#22252f");
          g.lineWidth = 1;
          const gridStep = uiScene ? 8 * (zoom < 0.5 ? 8 : 2) : tile;
          const startX = Math.floor(camX / gridStep) * gridStep;
          const startY = Math.floor(camY / gridStep) * gridStep;
          for (let x = startX; x < camX + cw / zoom; x += gridStep) {
            const sx = worldToScreen(x, 0).x;
            g.beginPath();
            g.moveTo(sx, 0);
            g.lineTo(sx, ch);
            g.stroke();
          }
          for (let y = startY; y < camY + ch / zoom; y += gridStep) {
            const sy = worldToScreen(0, y).y;
            g.beginPath();
            g.moveTo(0, sy);
            g.lineTo(cw, sy);
            g.stroke();
          }

          // UI 场景：画设计分辨率外框 + 安全区，让预览能看出「窗口裁切边界」
          if (uiScene) {
            const o0 = worldToScreen(0, 0);
            const o1 = worldToScreen(mapW, mapH);
            g.strokeStyle = "rgba(76,141,255,0.85)";
            g.lineWidth = 1.5;
            g.strokeRect(o0.x, o0.y, o1.x - o0.x, o1.y - o0.y);
            const sv = uiSafeArea(scene);
            const sa = worldToScreen(sv.x, sv.y);
            const sb = worldToScreen(sv.x + sv.w, sv.y + sv.h);
            g.strokeStyle = "rgba(46,204,143,0.6)";
            g.setLineDash([5, 4]);
            g.strokeRect(sa.x, sa.y, sb.x - sa.x, sb.y - sa.y);
            g.setLineDash([]);
          }

          // 画对象
          for (const o of ordered) {
            const layer = scene.layers.find((l) => l.id === o.layerId);
            if (layer && !layer.visible) continue;
            if (!o.visible) continue;
            const pctx: any = {
              zoom,
              tileSize: tile,
              showGrid: false,
              showColliders: true,
              showZones: true,
              showNames: true,
              time: performance.now(),
              selectedIds: new Set<string>(),
              overrides: new Map<string, { x: number; y: number }>(),
              project,
              ui: uiScene
            };
            paintObject(g, o, pctx, worldToScreen, zoom);
          }
        };

        wrap.addEventListener("mousedown", (e) => {
          if (e.button === 0 || e.button === 1 || e.button === 2) {
            isPanning = true;
            lastScreen = { x: e.clientX, y: e.clientY };
            wrap.style.cursor = "grabbing";
          }
        });
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        wrap.addEventListener("wheel", (e) => {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          const rect = wrap.getBoundingClientRect();
          const before = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          const beforeWorld = { x: (before.x - cw / 2) / zoom + camX, y: (before.y - ch / 2) / zoom + camY };
          zoom = Math.max(0.25, Math.min(3, zoom * factor));
          const afterWorld = { x: (before.x - cw / 2) / zoom + camX, y: (before.y - ch / 2) / zoom + camY };
          camX += beforeWorld.x - afterWorld.x;
          camY += beforeWorld.y - afterWorld.y;
          paintPreview?.();
        }, { passive: false });

        window.setTimeout(() => paintPreview?.(), 20);
        return box;
      },
      actions: [{ label: "关闭", variant: "primary", onClick: (c) => c() }],
      onClose: () => {
        miniDispose?.();
        miniDispose = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        previewWrap = null;
      }
    });
    void close;
  }

  // ==========================================================================
  // 撤销 / 快照（逻辑不变）
  // ==========================================================================

  /** 上一次看到的工程对象，用于识别「整个工程换了一个」。 */
  private lastProjectRef: Project | null = null;

  /**
   * 工程对象换了（不是字段变化，是整个对象被替换）就重置撤销历史与字符串池。
   * 用对象引用而不是「内容不同」判断：同一次会话里编辑只是改字段，
   * 只有打开/新建/载入示例会 new 一个工程对象。
   */
  private resetHistoryIfProjectReplaced(): void {
    const p = store.project;
    if (p === this.lastProjectRef) return;
    this.lastProjectRef = p;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.snapshotPool.clear();
    this.lastSnapshot = this.snapshot();
  }

  // --------- 对外 ---------

  setProject(p: unknown, fileName = ""): void {
    const normalized = normalizeProject(p);
    this.ensureTemplates(normalized);
    store.setProject(normalized, fileName);
    this.refreshPanels();
    this.canvas.zoomToFit();
    appendOutput("编辑器", `已载入工程「${normalized.name}」：${normalized.scenes.length} 场景 / ${normalized.assets.length} 素材`);
  }

  getProject(): Project | null {
    return store.project;
  }

  /** 空工程补上内置规则包；动态 import 避免与 packs.ts 形成循环依赖。 */
  private ensureTemplates(p: Project): void {
    if (p.packs.length) return;
    void import("../data/packs.ts").then(({ builtinPacks }) => {
      if (p.packs.length) return;
      p.packs.push(...builtinPacks());
      store.emitProject();
      window.dispatchEvent(new CustomEvent("bwe:refresh"));
    });
  }

  /** 把规则包套到指定对象上（画布拖放与面板双击都走这里）。 */
  applyPackTo(packId: string, objectId: string): void {
    const pack = store.project?.packs.find((p) => p.id === packId);
    if (!pack) return;
    void import("../data/packs.ts").then(({ applyPack }) => {
      const r = applyPack(objectId, pack);
      if (!r) return;
      const parts = [`新增 ${r.added} 块`];
      if (r.overwritten) parts.push(`覆盖 ${r.overwritten} 块`);
      ok(`已套用「${pack.name}」：${parts.join("，")}`);
      this.scheduleSnapshot("套用规则包");
      this.refreshPanels();
    });
  }

  setZoom(z: number): void {
    this.canvas.setZoom(z);
  }

  /** 画布外部改了数据（属性面板、模块面板）后请求重绘。 */
  refreshAfterExternalChange(): void {
    this.canvas.requestPaint();
    this.refreshChrome();
  }

  fitView(): void {
    this.canvas.zoomToFit();
    this.refreshChrome();
  }

  /** 切到侧边栏某一页（模块页是高频跳转目标）。 */
  focusPanel(id: string): void {
    this.shell.toggleSidebar(false);
    if (id === "scripts") {
      this.openTab("script");
      return;
    }
    this.showSidebarView("explorer");
    this.explorerTab.focus(id);
  }

  /**
   * 撤销 / 重做。
   * 当前实现为"整工程快照"：结构简单、绝不会出现半撤销状态；
   * 工程规模变大后再换成命令式（每步只记录差异）。
   */
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private suppressSnapshot = false;
  private lastSnapshot = "";
  /** 大字符串池：同一份 base64 素材在 80 份快照里只存一次（见 core/snapshot.ts）。 */
  private readonly snapshotPool = new SnapshotPool();

  private snapshot(): string {
    return this.snapshotPool.stringify(store.project ?? {}, () => {
      // 池满：只能把最老的撤销记录丢掉 —— 它们里面的占位已经没有对应内容了。
      // 保留一半，比一次性清空更不容易让用户觉得「撤销突然变短」。
      const drop = Math.ceil(this.undoStack.length / 2);
      this.undoStack.splice(0, drop);
      this.redoStack.length = 0;
    });
  }

  /** 每次数据落定时调用（拖动结束、增删改、改参数）。 */
  commit(label: string): void {
    if (this.suppressSnapshot || !store.project) return;
    const now = this.snapshot();
    if (now === this.lastSnapshot) return;
    this.undoStack.push(this.lastSnapshot);
    this.lastSnapshot = now;
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
    void label;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) {
      info("没有可以撤销的步骤了");
      return;
    }
    this.redoStack.push(this.snapshot());
    this.applySnapshot(prev);
    info("已撤销");
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) {
      info("没有可以重做的步骤了");
      return;
    }
    this.undoStack.push(this.snapshot());
    this.applySnapshot(next);
    info("已重做");
  }

  private applySnapshot(json: string): void {
    try {
      const parsed = this.snapshotPool.parse(json);
      this.suppressSnapshot = true;
      store.setProject(normalizeProject(parsed), store.fileName);
      this.lastSnapshot = this.snapshot();
      this.refreshPanels();
    } catch (e) {
      error(`撤销失败：${(e as Error).message}`);
    } finally {
      this.suppressSnapshot = false;
    }
  }

  private snapshotTimer = 0;

  /** 数据变化后延时记录快照：连续拖动只在停下时记一笔。 */
  scheduleSnapshot(label: string): void {
    window.clearTimeout(this.snapshotTimer);
    this.snapshotTimer = window.setTimeout(() => this.commit(label), 320);
  }
}

// ============================================================================
// 辅助函数（与原编辑器保持一致）
// ============================================================================

function iconForTool(t: Tool): string {
  switch (t) {
    case "select": return I.cursor;
    case "brush": return I.brush;
    case "erase": return I.eraser;
    case "zone": return I.zone;
    case "pan": return I.hand;
    default: return I.cursor;
  }
}

function toggleIcon(
  path: string,
  title: string,
  get: () => boolean,
  set: (v: boolean) => void
): HTMLButtonElement {
  const b = iconButton(path, title, () => {
    set(!get());
    b.classList.toggle("active", get());
  });
  b.classList.toggle("active", get());
  return b;
}

function openAccountMenu(anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const s = Session;
  const items = s.loggedIn()
    ? [
      { label: `已登录：${s.currentUser()?.displayName ?? ""}`, disabled: true },
      { label: `订阅计划：${s.plan().cn}`, disabled: true },
      { divider: true },
      { label: "查看订阅计划", onClick: () => s.openPlansDialog() },
      { label: "退出登录", onClick: () => { s.logout(); ok("已退出登录"); window.dispatchEvent(new CustomEvent("bwe:refresh")); } }
    ]
    : [
      { label: "登录 / 注册", onClick: () => s.openLoginDialog() },
      { label: "查看订阅计划", onClick: () => s.openPlansDialog() },
      { divider: true },
      { label: "（不登录也能完整使用编辑器）", disabled: true }
    ];
  contextMenu(r.left - 120, r.bottom + 4, items);
}

export function showQuickStart(): void {
  showQuickStartStep(0);
}

/**
 * 首启引导条（非模态）。
 *
 * 为什么不再直接弹模态：模态会盖住整个编辑器 —— 第一次打开的人看到的是一堵墙，
 * 而不是"哦这里是个编辑器"。验收截图也会被它挡住，看不出界面长什么样。
 * 改成右下角一条安静的提示：点「看引导」才展开完整步骤，点 × 就永久消失。
 */
export function showQuickStartBanner(): void {
  if (document.querySelector("[data-quickstart-banner]")) return;
  const bar = el("div", { class: "quickstart-banner", "data-quickstart-banner": "1" });
  bar.appendChild(el("span", { class: "qs-ico" }, "💡"));
  bar.appendChild(el("span", { class: "qs-text" }, "第一次用？三步就能上手：导入素材 → 拖到画布 → 加模块"));
  const go = button("看引导", () => { bar.remove(); showQuickStart(); }, { size: "sm", variant: "primary" });
  go.dataset.quickstartOpen = "1";
  bar.appendChild(go);
  const close = button("×", () => bar.remove(), { size: "sm", variant: "ghost", title: "不再提示" });
  close.style.padding = "0 8px";
  close.dataset.quickstartClose = "1";
  bar.appendChild(close);
  document.body.appendChild(bar);
}

const QUICK_START_STEPS: { title: string; body: string; action: string }[] = [
  {
    title: "第一步：导入素材",
    body: "左栏「素材」页，点「导入精灵」选几张图，或直接把文件拖进素材库。示例工程已内置几张彩色贴图，你也可以导入自己的。",
    action: "左栏「素材」→ 导入精灵"
  },
  {
    title: "第二步：放到地图上",
    body: "把素材从素材库拖到中间画布，就会在场景里创建一个对象。或选「画笔」工具（B 键）连续铺地块。",
    action: "拖素材到画布，或按 B 键"
  },
  {
    title: "第三步：加模块让它动起来",
    body: "选中画布上的对象，点画布工具条「模块」（或按 M）打开独立模块编辑器。左列是模块栈，右列是参数；模块是行为积木，不写代码也能做游戏逻辑。",
    action: "选对象 → 工具条「模块」→ 添加模块"
  },
  {
    title: "第四步：做剧情触发",
    body: "用「触发区」工具（Z 键）在画布拖出一块区域，给它加「进入触发区时」模块，再选一个对话剧本。玩家走进去就会触发剧情。",
    action: "按 Z 键 → 画布拖区域 → 加模块"
  },
  {
    title: "第五步：保存工程",
    body:
      "Ctrl+S 保存。工程是 .bwproj 文件，可以拷给同事继续做，也可以用桌面版打开。\n"
      + "界面快捷键：Ctrl+B 折叠侧边栏 · Ctrl+J 折叠底部面板 · Ctrl+Shift+P 命令面板 · Ctrl+Shift+M 问题面板。",
    action: "Ctrl+S 保存"
  }
];

function showQuickStartStep(index: number): void {
  const total = QUICK_START_STEPS.length;
  const cur = QUICK_START_STEPS[index];
  const last = index === total - 1;

  modal({
    title: `快速上手（${index + 1}/${total}）`,
    wide: true,
    closeOnMask: false,
    body: () => {
      const box = el("div", { class: "col" });
      box.style.gap = "12px";

      const progress = el("div", { style: { height: "6px", background: "var(--surface-3)", borderRadius: "3px", overflow: "hidden" } });
      const fill = el("div", { style: { height: "100%", background: "var(--accent)", width: `${((index + 1) / total) * 100}%` } });
      progress.appendChild(fill);
      box.appendChild(progress);

      box.appendChild(el("div", { class: "t", style: { fontSize: "15px", fontWeight: "700", marginBottom: "4px" } }, cur.title));
      box.appendChild(
        el(
          "div",
          { class: "hint", style: { fontSize: "13px", lineHeight: "1.8", marginBottom: "8px", whiteSpace: "pre-wrap" } },
          cur.body
        )
      );

      const actionCard = el("div", { class: "card" });
      actionCard.appendChild(el("header", null, "这次试着做"));
      const actionBody = el("div", { class: "body" });
      actionBody.appendChild(el("div", { class: "hint", style: { fontSize: "12.5px" } }, cur.action));
      actionCard.appendChild(actionBody);
      box.appendChild(actionCard);

      if (index === 0) {
        const keys = el("div", { class: "hint", style: { fontSize: "11.5px", color: "var(--text-3)", marginTop: "8px" } });
        keys.textContent =
          "快捷键：V 选择 · B 画笔 · E 橡皮 · Z 触发区 · H 抓手 · M 模块编辑器 · F 缩放到地图 · "
          + "Ctrl+S 保存 · Ctrl+B 侧边栏 · Ctrl+J 底部面板 · Ctrl+Shift+P 命令面板 · F1 再次打开本引导";
        box.appendChild(keys);
      }

      return box;
    },
    actions: [
      {
        label: last ? "完成引导" : "下一步",
        variant: "primary",
        onClick: (c) => {
          c();
          if (!last) showQuickStartStep(index + 1);
        }
      },
      { label: "跳过引导", variant: "ghost", onClick: (c) => c() }
    ],
    onClose: () => {
      try { localStorage.setItem("bwe.seenQuickStart", "1"); } catch { /* ignore */ }
    }
  });
}

function showAbout(): void {
  modal({
    title: "关于 BWE Studio",
    body: () => {
      const box = el("div", { class: "col" });
      box.appendChild(
        el(
          "div",
          { class: "hint", style: { fontSize: "12.5px", lineHeight: "1.9" } },
          "BWE Studio 是 BrokenWonderEngine 的可视化编辑前端，面向完全俯视角的奇幻 / 科幻 RPG。"
        )
      );
      box.appendChild(
        el(
          "div",
          { class: "hint", style: { fontSize: "12.5px", lineHeight: "1.9" } },
          "逻辑被拆成看得懂的积木模块：不写代码也能把一局游戏搭出来。剧本使用 Yarn Spinner 语法，可直接与社区工具互通。"
        )
      );
      box.appendChild(el("div", { class: "group-label" }, "数据与隐私"));
      box.appendChild(
        el(
          "div",
          { class: "hint", style: { fontSize: "12.5px", lineHeight: "1.9" } },
          "素材与工程数据全部保存在你这台机器的本地（浏览器 IndexedDB / 桌面版本地目录），不会上传到任何服务器。账号与订阅为可选功能。"
        )
      );
      box.appendChild(el("div", { class: "group-label" }, "开发者命令"));
      box.appendChild(
        el(
          "div",
          { class: "hint mono", style: { fontSize: "11.5px", lineHeight: "1.8", whiteSpace: "pre-wrap" } },
          "npm run typecheck   # 类型检查\nnpm run build       # 打包编辑器\nnpm run dev         # 本地服务 + 打开编辑器"
        )
      );
      return box;
    },
    actions: [{ label: "关闭", variant: "primary", onClick: (c) => c() }]
  });
}
