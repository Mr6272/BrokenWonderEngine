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
import { renderLightingPanel } from "../panels/lightingPanel.ts";
import { bakeSceneLighting } from "./lightBake.ts";
import {
  renderScriptList,
  renderScriptEditor,
  requestOpenScriptPanel
} from "../panels/scriptPanel.ts";
import { renderSettingsPanel } from "../panels/settingsPanel.ts";
import { renderSearchPanel, setSearchQuery } from "../panels/searchPanel.ts";
import { renderProblemsPanel, renderOutputPanel } from "../panels/bottomPanels.ts";
import { renderAiPanel, setAiScriptApplyHook, aiPanelSummary, resetAiConversation, requestAiAction } from "../panels/aiPanel.ts";
import { renderKnowledgePanel } from "../panels/knowledgePanel.ts";
import { openBwePackager } from "./packageBwe.ts";
import { renderOutlinePanel } from "../panels/outlinePanel.ts";
import { openModuleEditor } from "../panels/moduleEditor.ts";
import { saveProjectFile, openProjectFile, downloadProject, createExampleProject } from "./project.ts";
import { buildExample, type ExampleId } from "../data/examples.ts";
import { Session } from "../account/session.ts";
import { appendOutput } from "../core/output.ts";
import { problemCounts, onProblems } from "../core/diagnostics.ts";
import { apiFetch, hostMode, onMenuCommand, onOpenProjectRequest } from "../core/host.ts";
import {
  describeScriptList,
  deleteScript,
  listScripts,
  patchScript,
  readScript,
  writeScript,
  type ScriptOpResult
} from "../core/scriptOps.ts";
import { runProjectTool } from "../core/projectOps.ts";

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
  /** 侧边栏折叠/展开按钮（文案与 aria 随状态同步） */
  private sidebarToggleBtn: HTMLButtonElement | null = null;
  /** 底部面板折叠/展开按钮 */
  private panelToggleBtn: HTMLButtonElement | null = null;
  /** 折叠态下侧边栏边缘的常驻「展开」窄条（侧边栏折了之后按钮在里面就点不到了） */
  private sidebarRailBtn: HTMLButtonElement | null = null;
  /** AI 栏的收起按钮（文案/提示随折叠态同步） */
  private aiToggleBtn: HTMLButtonElement | null = null;
  /** AI 界面里的「退出 AI 界面」按钮（data-ai-exit；非 AI 模式隐藏） */
  private aiExitBtn: HTMLButtonElement | null = null;
  /**
   * 进入 AI 界面前在看的活动栏条目。
   *
   * AI 界面里活动栏只有「AI 助手」是亮的；退出时如果不还回去，用户会停在
   * 一个没有高亮的空壳上（侧边栏内容还在，但看不出自己在哪个视图）。
   */
  private aiModePrevActivity = "explorer";
  /** AI 栏当前标签：AI 助手 / 项目知识库 */
  private aiDockTab: "ai" | "kb" = "ai";
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
    // 折叠状态 → 按钮文案/图标/aria 同步 + 常驻「展开」窄条显隐
    this.shell.onLayoutChange((st) => this.syncLayoutAffordances(st));
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
    // 面板要求「把这个对象挪到视野中央」（光源清单点行、Inspector 的定位按钮）。
    // 为什么走事件而不是让面板持有 canvas：面板不该知道画布存在（它们分属两侧 UI）；
    // 事件让"谁想定位"与"怎么定位"解耦，画布也能换成另一个实现。
    window.addEventListener("bwe:focus-object", (e) => {
      const d = (e as CustomEvent).detail as { id?: string; x?: number; y?: number; zoom?: boolean } | undefined;
      if (!d) return;
      const obj = store.scene?.objects.find((o) => o.id === d.id);
      if (obj) store.select(obj);
      /**
       * 带 zoom=true 时按对象矩形聚焦（框住 + 合适缩放），否则只居中。
       *
       * 两种语义都要保留：光源清单那种「列表里点一行」只需要把视野挪过去
       * （用户自己在看大图，不希望缩放被改）；而「定位这个对象」按钮/双击
       * 是真的要看清楚它，必须连缩放一起调。
       */
      if (obj && d.zoom === true) {
        this.canvas.focusObject(obj);
        this.canvas.requestPaint();
        return;
      }
      const x = typeof d.x === "number" ? d.x : obj?.x;
      const y = typeof d.y === "number" ? d.y : obj?.y;
      if (typeof x === "number" && typeof y === "number") this.canvas.centerOn(x, y);
      this.canvas.requestPaint();
    });

    // AI 面板的「应用」按钮：真正写回剧本编辑器（面板只负责发起，外壳负责落地）
    setAiScriptApplyHook((name, code) => this.applyAiScript(name, code));

    this.refreshChrome();
    this.setBottomTab("problems");
    // AI 栏首屏就渲染一次：它是常驻工作面，不该等到用户点某个入口才出现。
    // 渲染在 setBottomTab 之后（那时底部面板已有内容，布局尺寸已定）。
    this.renderAiDock();
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
    this.buildAiDockHead();
  }

  /**
   * 右侧 AI 栏的头部：标题 + 折叠按钮。
   *
   * 为什么头部由 Editor 建而不是 Shell：折叠按钮的文案/图标要随状态同步，
   * 而状态订阅（onLayoutChange）在 Editor 里 —— 让 Shell 建按钮等于把
   * 「按钮在 A、状态在 B」的耦合又造一次（这正是侧边栏按钮当年踩过的坑）。
   */
  private buildAiDockHead(): void {
    const head = this.shell.aiPanelHead;
    const title = el("div", { class: "group-label" }, "AI 助手");
    head.appendChild(title);
    head.appendChild(el("div", { class: "spacer" }));

    // 折叠按钮：让用户能腾出宽度给画布（AI 栏占用的是横向空间，不是高度）
    const collapse = button("收起", () => this.toggleAiPanel(), {
      size: "sm",
      variant: "ghost",
      title: "收起 AI 栏（Ctrl+Shift+A 进入 AI 界面）"
    });
    collapse.dataset.aiCollapse = "1";
    this.aiToggleBtn = collapse;
    head.appendChild(collapse);

    // AI 界面里的「退出」。两个按钮都**预先建好、只切显隐**：
    // 按模式重建头部会让标题条每次进出闪一下，也会让验收脚本抓不稳锚点
    // （data-ai-exit 必须是常驻元素）。AI 界面里「收起」没有意义 —— 收起就没有界面了，
    // 所以两者互斥显示。
    const exit = button("退出 AI 界面", () => this.exitAiMode(), {
      size: "sm",
      variant: "ghost",
      title: "退出 AI 界面（Esc）"
    });
    exit.dataset.aiExit = "1";
    // ⚠ 用 hidden 而不是 style.display：显隐由样式表按 .app-root.ai-mode 决定
    // （styles/app.css 里 `[data-ai-exit]{display:none}` + ai-mode 下 `inline-flex`）。
    // 写行内 display 会**压过那两条规则**，结果是"类加了、按钮还是不出现"——
    // 和 setAiPanelWidth 的内联 flex 压过 CSS 是同一类坑。hidden 是 UA 级
    // display:none，作者样式能覆盖它，正好当"样式表没到位时的兜底"。
    exit.hidden = true;
    this.aiExitBtn = exit;
    head.appendChild(exit);
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
          "project.example.lighting",
          "project.example.alienShooter",
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

    // 验收用：载入内置 JS 示例工程（截图脚本面板需要真实 JS 脚本才渲染出编辑器）。
    const loadDemoProbe = el("button", {
      type: "button",
      "data-load-js-demo": "1",
      "aria-hidden": "true",
      tabindex: "-1"
    });
    loadDemoProbe.style.cssText = "position:absolute;left:-9999px;width:0;height:0;padding:0;border:0;opacity:0";
    loadDemoProbe.addEventListener("click", () => {
      // 直接走内置示例（与「文件 → 俯视角 JS 示例」同一个入口）
      this.loadExampleProject(
        () => buildExample("topdown-js").project,
        buildExample("topdown-js").fileName,
        ""
      );
      // 示例里 JS 脚本才是有编辑器的那个；Yarn 页只有空态，量不到 .js-code
      window.setTimeout(() => requestOpenScriptPanel("js"), 400);
    });
    bar.appendChild(loadDemoProbe);

    // 验收用：冻结 AI 面板的「正在思考」态以便截图（思考是瞬时状态，截图抓不到）
    const thinkPhase = (phase: "connecting" | "reasoning" | "answering" | "slow", chars = 0) => {
      void import("../panels/aiPanel.ts").then((m) => {
        m.demoThinking(phase, chars);
        console.log(`[demo] 思考态冻结为 ${phase}`);
      });
    };
    const mkThink = (id: string, phase: "connecting" | "reasoning" | "answering" | "slow", chars = 0) => {
      const b = el("button", { type: "button", [id]: "1", "aria-hidden": "true", tabindex: "-1" });
      (b as HTMLElement).style.cssText = "position:absolute;left:-9999px;width:0;height:0;padding:0;border:0;opacity:0";
      b.addEventListener("click", () => thinkPhase(phase, chars));
      bar.appendChild(b);
    };
    mkThink("data-demo-thinking", "connecting");
    mkThink("data-demo-thinking-reasoning", "reasoning", 128);
    mkThink("data-demo-thinking-slow", "slow");

    // 验收用：构造「工具失败 + 空答复」的对话（截图用）。
    // 为什么需要：mock 流不产生 tool 事件，真模型又需要 key，
    // 而这两个视觉（红条失败块、系统提示条）必须有图自证。
    // 注入的是**事件**（走 handleAiEvent 同一条渲染路径），不是直接拼 DOM，
    // 所以证明的是"UI 收到这些事件后会这样显示"。
    const mkDemoBtn = (attr: string, onClick: () => void) => {
      const b = el("button", { type: "button", [attr]: "1", "aria-hidden": "true", tabindex: "-1" });
      (b as HTMLElement).style.cssText =
        "position:absolute;left:-9999px;width:0;height:0;padding:0;border:0;opacity:0";
      b.addEventListener("click", onClick);
      bar.appendChild(b);
    };
    mkDemoBtn("data-demo-tool-fail", () => {
      void import("../panels/aiPanel.ts").then((m) => m.demoToolFailure());
    });
    mkDemoBtn("data-demo-empty-done", () => {
      void import("../panels/aiPanel.ts").then((m) => m.demoEmptyDone());
    });
    mkDemoBtn("data-demo-server-error", () => {
      void import("../panels/aiPanel.ts").then((m) => m.demoServerError());
    });
    mkDemoBtn("data-demo-retry-twice", () => {
      void import("../panels/aiPanel.ts").then((m) => m.demoRetryTwice());
    });
    // 验收用：「Key 失效」演示（key 填过但本次启动解不开）
    mkDemoBtn("data-demo-key-broken", () => {
      void import("../panels/aiPanel.ts").then((m) => m.demoKeyBroken());
    });
    // 验收用：明文存储告知条（insecure:true）
    mkDemoBtn("data-demo-insecure", () => {
      void import("../panels/aiPanel.ts").then((m) => m.demoInsecure());
    });
    // 验收用：明文「降级」文案（key 曾加密、因解不开才降级）
    mkDemoBtn("data-demo-plaintext-fallback", () => {
      void import("../panels/aiPanel.ts").then((m) => m.demoPlaintextFallback());
    });
    // 验收用：给「AI 界面」的双区截图灌一批工具调用（聊天框下沉后，上方是 Agent 行为）。
    // 走 `__BWE__.debugAiStream` 同一条出口：截图里看到的块，就是几何验收量的那一份实现。
    mkDemoBtn("data-demo-ai-stream", () => {
      const w = window as unknown as { __BWE__?: { debugAiStream?: (n?: number) => void } };
      w.__BWE__?.debugAiStream?.(8);
    });

    // 验收用：量取编辑器几何（点一下就把 .js-code 等实际像素打进控制台，
    // 配合 --console 就能拿到数字，不必改 A 的 --probe-dom）。
    const measureProbe = el("button", {
      type: "button",
      "data-measure-editor": "1",
      "aria-hidden": "true",
      tabindex: "-1"
    });
    measureProbe.style.cssText = "position:absolute;left:-9999px;width:0;height:0;padding:0;border:0;opacity:0";
    measureProbe.addEventListener("click", () => {
      const w = window as unknown as { __BWE__?: { measureEditor?: (s?: string[]) => unknown } };
      w.__BWE__?.measureEditor?.();
    });
    bar.appendChild(measureProbe);

    // 验收用：在脚本编辑器里模拟输入 `bwe.` 触发补全弹层（截图用）。
    // 为什么需要触发器：`--tap-seq` 只能 click，无法逐字符打字；
    // 而补全依赖 input 事件 + 光标位置，只能这样构造真实路径。
    const completeProbe = el("button", {
      type: "button",
      "data-demo-complete": "1",
      "aria-hidden": "true",
      tabindex: "-1"
    });
    completeProbe.style.cssText =
      "position:absolute;left:-9999px;width:0;height:0;padding:0;border:0;opacity:0";
    completeProbe.addEventListener("click", () => {
      const ta = document.querySelector(".js-source") as HTMLTextAreaElement | null;
      if (!ta) {
        console.log("[demo] 找不到 .js-source（需先打开剧本 JS 视图）");
        return;
      }
      const pos = ta.selectionStart;
      ta.focus();
      ta.setRangeText("bwe.", pos, pos, "end");
      // 走与用户打字完全相同的路径（不是直接调内部函数）
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      console.log("[demo] 已插入 bwe.，补全应弹出");
    });
    bar.appendChild(completeProbe);


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
    /**
     * 点任何**非 ai** 条目 = 退出 AI 界面。
     *
     * 顺序不能反：AI 界面靠 `.ai-mode` 让编辑区/侧边栏 display:none，
     * 不退场就执行原分支等于"点了、状态也改了，但屏幕上什么都没有"。
     * 传 restoreActivity:false 是因为这一下点的就是目标视图，高亮由点击本身决定。
     */
    if (id !== "ai" && this.aiModeActive()) this.exitAiMode({ restoreActivity: false });
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
        this.enterAiMode();
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
    // 二态按钮：折叠 ↔ 展开。
    // 修复的 bug：原来写死 toggleSidebar(true)，点多少次都是折叠，
    // 用户看到的是「折叠按钮不能展开东西」。
    const collapseBtn = button("折叠", () => this.shell.toggleSidebar(), {
      size: "sm",
      variant: "ghost",
      iconPath: I.sidebarToggle,
      className: "sidebar-collapse-btn",
      title: "折叠 / 展开侧边栏（Ctrl+B）"
    });
    // 稳定锚点：验收脚本用 [data-sidebar-collapse] 点击，不依赖按钮文案
    collapseBtn.dataset.sidebarCollapse = "1";
    this.sidebarToggleBtn = collapseBtn;
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

  /**
   * 带查询词打开左栏搜索（JS 编辑器的「工程内」按钮走这里）。
   *
   * 顺序纪律：先写入查询词、再切页 —— 反过来的话面板会先按旧词渲染一次，
   * 用户会看到列表闪一下旧结果再变成新的。
   */
  private openSearchWithQuery(q: string): void {
    setSearchQuery(q);
    this.shell.toggleSidebar(false);
    this.showSidebarView("search");
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
    // 运行时视口取景框：用户在一张大图上摆东西时，唯一的「画面边界」参照。
    toggles.appendChild(toggleIcon(I.scene, "显示运行时视口（1280×720 窗口范围）", () => store.showViewport, (v) => { store.showViewport = v; this.canvas.requestPaint(); }));
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
    zoomGroup.appendChild(iconButton(I.fit, "聚焦选中对象 / 缩放到整张地图（F）", () => this.canvas.fitOrFocus()));
    zoomGroup.appendChild(iconButton(I.target, "缩放到整张地图", () => this.canvas.zoomToFit()));
    bar.appendChild(zoomGroup);

    bar.appendChild(el("div", { class: "spacer" }));

    // 高频动作留按钮，低频的收进「更多」菜单。
    // 为什么收：1280x720 下工具条是横向滚动的，右端按钮会被辅助栏截掉半截，
    // 用户不知道要横滚。收进菜单后主操作区永远完整可见。
    bar.appendChild(button("保存", () => void saveProjectFile(), { size: "sm", variant: "primary", iconPath: I.save, title: "保存工程（Ctrl+S）" }));
    // v4：「预览」（编辑器内静态画布）已废弃，这里换成「试跑」——
    // 真的起 Java 窗口跑工程自己的脚本，才是用户想看的"效果"。
    // 静态画布能看的其实编辑器主视图已经给了（同一套 painter、同一个场景），
    // 再弹一个只读副本既不多信息，又比真跑更容易让人误以为"游戏就是这样"。
    bar.appendChild(button("试跑", () => void this.openPlaytest(), { size: "sm", iconPath: I.play, title: "在本机启动 Java 窗口真跑这个工程（F6）" }));
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
        { label: "导出 Web 游戏包", onClick: () => this.exportWeb() }
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
        { id: "outline", label: "大纲", hint: "场景中所有对象的树状列表", render: renderOutlinePanel },
        // 光照面板：总开关 / 烘焙 / 光源清单。放右栏而不是左栏资源管理器：
        // 它改的是「这张地图现在什么天气」，与对象属性是同一级别的东西，
        // 且烘焙按钮点完要立刻在画布上看到效果 —— 右栏离画布最近。
        { id: "lighting", label: "光照", hint: "2D 光照：总开关、烘焙、光源清单", render: renderLightingPanel }
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
    // ⚠ 这个标签现在的作用是「展开右侧 AI 栏」，不是「切底部面板」。
    //    保留 `data-panel-tab="ai"` 锚点是为了不破坏已有验收脚本与用户习惯；
    //    但点击行为必须走 focusAiPanel（否则会切到一个空的底部面板）。
    const aiTab = setTab("ai", "AI 助手", "sparkles");
    aiTab.addEventListener("click", (e) => {
      e.stopPropagation();
      this.focusAiPanel();
    });

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
    // 同样是二态（原来写死 true → 只能折不能展）
    const panelToggleBtn = button("折叠", () => this.shell.togglePanel(), {
      size: "sm",
      variant: "ghost",
      iconPath: I.panelToggle,
      title: "折叠 / 展开底部面板（Ctrl+J）"
    });
    panelToggleBtn.dataset.panelToggle = "1";
    this.panelToggleBtn = panelToggleBtn;
    actions.appendChild(panelToggleBtn);

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

  /**
   * 对外：切换底部面板标签（调试出口与验收脚本用）。
   *
   * `ai` 现在在**右侧 AI 栏**里（不再是底部面板的一个标签）。为了不破坏
   * 已有的验收脚本（`--tap=[data-panel-tab=ai]` 这类）与用户肌肉记忆，
   * 这里保留入口：传 "ai" 就展开右侧 AI 栏，而不是在底部渲染它。
   */
  openBottomTab(id: "problems" | "output" | "ai"): void {
    if (id === "ai") {
      this.focusAiPanel();
      return;
    }
    this.setBottomTab(id);
    this.shell.togglePanel(false);
  }

  /**
   * 展开右侧 AI 栏 / 进入 AI 界面（命令、活动栏、快捷键、旧调用点共用的入口）。
   *
   * 名字保留：命令 `ai.focus`、`openBottomTab("ai")`、`__BWE__.showPanelTab("ai")`、
   * `bwe:open-ai` 事件、底部面板的「AI 助手」标签都按这个名字调用，改名会静默断掉这些入口。
   * 但语义已经变成「进入 AI 界面」——AI 从右侧栏升级成独立工作面后，
   * 「展开一个占满主区的界面」和「展开一条侧栏」不是一回事（契约 docs/ai-interface.md §4）。
   */
  focusAiPanel(): void {
    this.enterAiMode();
  }

  /** 是否处于 AI 界面（唯一事实来源是 .app-root 上的 ai-mode 类）。 */
  aiModeActive(): boolean {
    return this.shell.aiModeOn();
  }

  /**
   * 进入 AI 界面：侧边栏 / 编辑区 / 辅助栏 / 底部面板退场，AI 栏独占主工作区。
   *
   * 快照（三处折叠态 + AI 栏宽度）由 Shell 记，这里只管"记住我在哪个视图"和重渲染。
   */
  enterAiMode(): void {
    if (this.aiModeActive()) {
      // 已经在里面了：只保证内容在，别覆盖 Shell 的快照（覆盖了退出就还原错状态）
      this.renderAiDock();
      return;
    }
    // 从活动栏点进来时，点击本身已经把高亮改成 "ai" 了 —— 那时"上一个条目"才是用户
    // 真正在看的视图；从命令/快捷键进来时当前条目还没变，直接用当前条目。
    const cur = this.shell.currentActivity();
    const prev = cur === "ai" ? this.shell.previousActivity() : cur;
    // 兜底：万一两个值都是 ai（脚本直接改高亮），退出时不能还回 ai ——
    // 那等于退出后指着不存在的视图。
    this.aiModePrevActivity = prev === "ai" ? "explorer" : prev;
    this.shell.setAiMode(true);
    this.shell.setActiveActivity("ai");
    // 面板在 AI 界面里拿到整个主区高度，必须重渲染一次：
    // 之前在窄栏里算好的滚动位置/宽度假设都不成立了。
    this.renderAiDock();
    this.syncAiModeAffordances();
  }

  /**
   * 退出 AI 界面，逐项还原进入前的折叠态、AI 栏宽度与活动栏高亮。
   *
   * `restoreActivity=false` 用于"用户点活动栏其它条目"这条路径：那一下点的就是目标视图，
   * 不能再把高亮还回进入前的条目（否则高亮搜索、内容资源管理器，看着像坏了）。
   */
  exitAiMode(opts?: { restoreActivity?: boolean }): void {
    if (!this.aiModeActive()) return;
    this.shell.setAiMode(false);
    if (opts?.restoreActivity !== false) {
      this.shell.setActiveActivity(this.aiModePrevActivity);
      // 只还原高亮不重跑 onActivity：侧边栏内容在 AI 界面里没被换掉（只是宽度归零），
      // 重跑 onActivity 会额外触发 openTab 之类的副作用。
    }
    this.syncAiModeAffordances();
  }

  /** 进入 / 退出 AI 界面（Ctrl+Shift+A、命令面板共用）。返回切换后是否在 AI 界面里。 */
  toggleAiMode(): boolean {
    if (this.aiModeActive()) {
      this.exitAiMode();
      return false;
    }
    this.enterAiMode();
    return true;
  }

  /**
   * AI 界面专属的两个头部按钮互斥显隐。
   *
   * 用 `hidden`（UA 级 display:none，作者样式可覆盖）而不是行内 display：
   * 真正的显隐规则写在 styles/app.css 的 `.app-root.ai-mode` 段里，
   * 行内样式会把它压过去 —— 这正是「类加了、元素还藏着」那类静默失效。
   * 这里只做"样式表没到位时也不会把两个按钮同时亮出来"的兜底。
   *
   * 单独一个方法而不是塞进 syncLayoutAffordances：后者是**折叠态**的同步器，
   * 把"模式"也混进去会让一个函数管两个状态源（正是「点了按钮文案没变」这类
   * 半更新 bug 的温床）。
   */
  private syncAiModeAffordances(): void {
    const on = this.aiModeActive();
    if (this.aiToggleBtn) this.aiToggleBtn.hidden = on;
    if (this.aiExitBtn) this.aiExitBtn.hidden = !on;
  }

  /** 折叠/展开右侧 AI 栏（「收起」按钮；Ctrl+Shift+A 现在走 toggleAiMode）。 */
  toggleAiPanel(): boolean {
    const collapsed = this.shell.toggleAiPanel();
    if (!collapsed) this.renderAiDock();
    this.syncLayoutAffordances({
      sidebar: this.shell.sidebarCollapsed(),
      panel: this.shell.panelCollapsed(),
      ai: collapsed
    });
    return collapsed;
  }

  /**
   * 把 AI 面板渲染进右侧栏。
   *
   * 为什么单独一个方法而不是塞进 refreshBottomPanel：AI 栏与底部面板是**两条生命周期**
   * （底部面板切标签会重建，AI 栏常驻）。放一起会让「切到问题面板」把 AI 对话区重建一次，
   * 用户正在看的对话会闪一下。
   */
  /**
   * 把 AI 栏的内容渲染出来（两个标签：AI 助手 / 项目知识库）。
   *
   * 为什么用标签页而不是两个独立面板：AI 与知识库在**同一个工作面上**使用 ——
   * 用户问 AI 时想知道"它记了什么"，看知识库时想接着问。分成两个入口会让人来回找。
   * 标签条很矮（28px），不会吃掉对话区的高度。
   */
  private renderAiDock(): void {
    if (this.shell.aiPanelCollapsed()) return;
    const body = this.shell.aiPanelBody;
    body.replaceChildren();

    // 标签条
    const bar = el("div", { class: "ai-dock-tabs" });
    const tabs: Array<{ id: "ai" | "kb"; label: string; icon: keyof typeof I }> = [
      { id: "ai", label: "AI 助手", icon: "sparkles" },
      { id: "kb", label: "项目知识库", icon: "explorer" }
    ];
    for (const t of tabs) {
      const b = el("button", {
        type: "button",
        class: "ai-dock-tab" + (this.aiDockTab === t.id ? " active" : ""),
        title: t.id === "kb" ? "每轮 AI 执行完自动沉淀的本工程经验" : "与 AI 对话 / 改脚本",
        "data-ai-dock-tab": t.id
      });
      b.appendChild(svg(I[t.icon] as string, 13));
      b.appendChild(el("span", null, t.label));
      b.addEventListener("click", () => {
        if (this.aiDockTab === t.id) return;
        this.aiDockTab = t.id;
        this.renderAiDock();
      });
      bar.appendChild(b);
    }
    body.appendChild(bar);

    const host = el("div", { class: "ai-dock-content" });
    body.appendChild(host);

    if (this.aiDockTab === "kb") {
      renderKnowledgePanel(host, () => this.renderAiDock());
      return;
    }
    // AI 面板自己算 sceneDigest、自己订流式事件；外壳只给挂载点与重画回调。
    // layout 决定「左侧历史栏 + 主区铺满」的双列（page）还是右侧窄栏的单列（dock）：
    // AI 界面里必须是 page —— 不传的话面板会按 dock 渲染，历史栏整块不出现，
    // 表现为「AI 界面里找不到历史」（不是报错，是静默少一块）。
    renderAiPanel(host, () => this.renderAiDock(), { layout: this.aiModeActive() ? "page" : "dock" });
  }

  private setBottomTab(id: "problems" | "output" | "ai"): void {
    // "ai" 不在底部面板里了：转去右侧栏，避免出现「底部空面板 + 右侧 AI 栏」的重复
    if (id === "ai") {
      this.focusAiPanel();
      return;
    }
    this.bottomTab = id;
    for (const [key, b] of this.bottomTabButtons) b.classList.toggle("active", key === id);
    this.refreshBottomPanel();
    // 面板高度变了，悬浮提示要跟着让位，否则会压在新出现的输入框上
    window.setTimeout(() => syncToastPosition(), 0);
  }

  private refreshBottomPanel(): void {
    const host = this.shell.panelBody;
    host.classList.remove("flush");
    switch (this.bottomTab) {
      case "problems":
        renderProblemsPanel(host);
        break;
      case "output":
        renderOutputPanel(host);
        break;
      case "ai":
        // 只有从旧路径进来才可能到这（setBottomTab 已把它转走）。
        // 保留分支是为了「老宿主/老入口调进来」时不至于什么都不画。
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

  // ==========================================================================
  // 光照（编辑入口）
  // ==========================================================================

  /**
   * 命令面板 / 菜单里的「一键烘焙」落点。
   *
   * 为什么要绕到面板而不是直接调 `bakeSceneLighting`：
   *   烘焙结果必须写在**面板上**（统计 + 警告列表），否则用户在命令面板点一下，
   *   只看到一个 toast，想知道"为什么只烘了 0 盏灯 / 警告了什么"就无从查起。
   *   所以这里先切到光照页（让结果可见），再执行烘焙。
   */
  private async bakeLightingNow(): Promise<void> {
    this.auxTab.focus("lighting");
    // 让面板先渲染出来再烘焙：烘焙完会发 bwe:refresh，面板正是靠它重画统计的
    await new Promise<void>((r) => window.setTimeout(r, 0));
    const out = await bakeSceneLighting(store.scene, store.project);
    if (!out.ok) {
      warn(`烘焙没做成：${out.error}`);
      return;
    }
    ok(`光照已烘焙：${out.texW}×${out.texH} · ${out.lights} 盏灯 · ${Math.round(out.ms)} ms`);
    for (const w of out.warnings) warn(w);
  }

  /** 「在视图中央放一个光源」：不动鼠标也能加灯（键盘流用户/触摸板用户）。 */
  private addLightAtViewCenter(): void {
    const scene = store.scene;
    if (!scene) {
      warn("先打开一张场景");
      return;
    }
    const c = this.canvas.viewCenterWorld();
    this.canvas.addLightAt(c.x, c.y);
    // 光照总开关没开时，提醒一句（不擅自改工程级设置：用户可能只是想先摆灯）
    if (!scene.lighting?.enabled) {
      this.hint("已放好光源。光照总开关还关着：到右栏「光照」页打开才能看到夜色");
    }
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
  // 折叠状态的可见入口（修复「折叠按钮不能展开东西」）
  // ==========================================================================

  /**
   * 折叠态必须有**鼠标可达**的展开入口。
   *
   * 为什么：侧边栏折叠 = 宽度归零（`flex: 0 0 0 !important`），
   * 而「折叠/展开」按钮**就在侧边栏里面** → 折了就再也点不到它。
   * 这就是用户报「折叠按钮不能展开东西」的真实原因（不是样式问题，是入口消失了）。
   *
   * 修法：折叠时在编辑区左边缘显示一条 24px 宽的竖条（像 VS Code 折叠后的那条边），
   * 点它就展开；展开时隐藏。底部面板同理（它的标题条还在，所以按钮保留即可）。
   */
  private ensureSidebarRail(): HTMLButtonElement {
    if (this.sidebarRailBtn) return this.sidebarRailBtn;
    const rail = el("button", {
      type: "button",
      class: "sidebar-rail",
      title: "展开侧边栏（Ctrl+B）",
      "aria-label": "展开侧边栏",
      "aria-expanded": "false"
    });
    rail.dataset.sidebarToggle = "1";
    rail.appendChild(svg(I.sidebarToggle, 14));
    rail.addEventListener("click", () => this.shell.toggleSidebar(false));
    // 挂在主区（活动栏之后、编辑区之前），这样它永远在可见区里，不受侧边栏折叠影响
    this.shell.root.querySelector(".shell-main")?.insertBefore(rail, this.shell.editorArea);
    this.sidebarRailBtn = rail;
    return rail;
  }

  /**
   * 状态同步：文案、图标、aria、常驻入口显隐。
   *
   * 单独一个方法而不是散在各处，是因为折叠状态有 4 个入口会改它
   * （按钮、活动栏、命令面板 Ctrl+B、窄条），散着写必然漏掉某一处。
   */
  private syncLayoutAffordances(st: { sidebar: boolean; panel: boolean; ai?: boolean }): void {
    const sb = this.sidebarToggleBtn;
    if (sb) {
      sb.textContent = st.sidebar ? "展开" : "折叠";
      sb.title = st.sidebar ? "展开侧边栏（Ctrl+B）" : "折叠侧边栏（Ctrl+B）";
      sb.setAttribute("aria-expanded", st.sidebar ? "false" : "true");
      // 图标方向也要跟着翻转（同一份描边路径，靠 CSS rotate）
      sb.classList.toggle("is-collapsed", st.sidebar);
      const g = sb.querySelector(".glyph");
      if (g) (g as SVGElement).style.transform = st.sidebar ? "rotate(180deg)" : "";
    }

    const pb = this.panelToggleBtn;
    if (pb) {
      pb.textContent = st.panel ? "展开" : "折叠";
      pb.title = st.panel ? "展开底部面板（Ctrl+J）" : "折叠底部面板（Ctrl+J）";
      pb.setAttribute("aria-expanded", st.panel ? "false" : "true");
      pb.classList.toggle("is-collapsed", st.panel);
    }

    // AI 栏的折叠态也要反映到「AI 助手」标签上：
    // 标签是展开入口，栏已经展开时它该显示为「当前生效」，否则用户会以为没生效。
    const aiTab = this.bottomTabButtons.get("ai");
    if (aiTab && typeof st.ai === "boolean") {
      aiTab.classList.toggle("active", !st.ai);
      aiTab.title = st.ai ? "展开右侧 AI 栏" : "AI 栏已展开（点击聚焦）";
    }

    const ab = this.aiToggleBtn;
    if (ab && typeof st.ai === "boolean") {
      ab.textContent = st.ai ? "展开" : "收起";
      // 提示里不再写「Ctrl+Shift+A 收起」：那个键现在是"进出 AI 界面"，
      // 写成收起会让用户按下去后看到界面铺满，以为是 bug。
      ab.title = st.ai ? "展开 AI 栏（收起态点这里恢复右侧栏）" : "收起 AI 栏（想整块屏给 AI 用请按 Ctrl+Shift+A）";
      ab.setAttribute("aria-expanded", st.ai ? "false" : "true");
    }

    // 常驻窄条：只在侧边栏折叠时出现。
    // AI 界面里侧边栏也是"折叠"的，但那条窄条没有意义（点它只会展开一条被
    // ai-mode 的 display:none 压住的侧边栏），所以一并隐藏。
    const rail = this.ensureSidebarRail();
    rail.style.display = st.sidebar && !this.aiModeActive() ? "" : "none";
    rail.setAttribute("aria-expanded", st.sidebar ? "false" : "true");
    // 折叠后焦点如果还留在已消失的按钮上，键盘用户会"迷路"
    // （AI 界面里窄条是隐藏的，把焦点甩过去等于甩进虚空，所以跳过）
    if (st.sidebar && !this.aiModeActive() && document.activeElement === sb) rail.focus();
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
    /**
     * 「这次数据变化要进撤销栈」的统一信号。
     *
     * ⚠ 这个监听器以前**不存在**：全仓库有 7 处（prefab / inspector / module / lighting /
     * AI 改脚本 / 对象删除 / 复制对象）都在 `dispatchEvent("bwe:commit")`，
     * 但没有任何地方接住它 —— 于是"删对象、改模块参数、改光源、AI 改脚本"
     * 全都**不可撤销**，而界面上看起来一切正常（没有任何报错，撤销按钮只是"没反应"）。
     * 这是端到端验收（desktop/tools/verify-js-editor-ui.mjs）里被抓住的：
     * 「全部替换」改完文本后按 Ctrl+Z 什么也没发生。
     *
     * 为什么在这里接而不是每个面板自己调 editor.commit：
     *   面板之间互相持有引用是这套架构一直在避免的事（见 scriptPanel 里
     *   jumpToLineHook 的注释）。事件是单向的、无生命周期负担，面板只要广播即可。
     */
    window.addEventListener("bwe:commit", (e) => {
      const d = (e as CustomEvent<{ label?: string; immediate?: boolean }>).detail;
      const label = String(d?.label ?? "");
      /**
       * `immediate` 是给**离散动作**用的：查找替换、整行移动、AI 改写这类
       * "一次操作就是一步"的改动，必须当场入栈 —— 否则用户改完立刻按 Ctrl+Z，
       * 防抖还没到点，撤销栈里没有这一步，界面表现为"撤销什么都没发生"。
       * 反之连续拖动/连续调参用默认的 320ms 合并，避免几秒钟吃掉 80 步额度。
       */
      if (d?.immediate) this.commit(label);
      else this.scheduleSnapshot(label);
    });
    // JS 编辑器里「工程内查找」：把查询词带进左栏的搜索面板。
    // 为什么走事件而不是直接 import searchPanel：搜索面板的当前词是模块级状态，
    // 而它渲染时自己会 focus 输入框 —— 直接调函数会让用户的光标被抢走两次
    // （先跳到搜索框，再被面板重建打断）。事件这条路上，外壳先切页、再灌词，顺序可控。
    window.addEventListener("bwe:search-project", (e) => {
      const q = String((e as CustomEvent<{ query?: string }>).detail?.query ?? "");
      this.openSearchWithQuery(q);
    });
    window.addEventListener("bwe:open-ai", () => {
      this.focusAiPanel();
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
      // F：有选中 → 聚焦选中对象；没选中 → 缩放到整张地图（见 CanvasView.fitOrFocus）
      { id: "view.fit", title: "聚焦选中对象 / 缩放到整张地图", key: "F", group: "视图", icon: "fit", hint: "有选中时框住它；没选中时看全图", run: () => this.canvas.fitOrFocus() },
      { id: "view.fitAll", title: "缩放到整张地图（忽略选中）", group: "视图", icon: "target", run: () => this.canvas.zoomToFit() },
      { id: "view.toggleViewport", title: "切换运行时视口框显示", group: "视图", icon: "scene", hint: "画出打包后 1280×720 窗口看到的那块范围", run: () => { store.showViewport = !store.showViewport; this.canvas.requestPaint(); } },
      { id: "view.zoom100", title: "缩放 100%", group: "视图", icon: "zoomIn", run: () => this.canvas.setZoom(1) },
      { id: "view.toggleGrid", title: "切换网格显示", group: "视图", icon: "grid", run: () => { store.showGrid = !store.showGrid; this.canvas.requestPaint(); } },
      { id: "view.toggleColliders", title: "切换碰撞体显示", group: "视图", icon: "bounds", run: () => { store.showColliders = !store.showColliders; this.canvas.requestPaint(); } },
      { id: "view.toggleNames", title: "切换对象名称显示", group: "视图", icon: "eye", run: () => { store.showNames = !store.showNames; this.canvas.requestPaint(); } },
      { id: "view.sidebar", title: "切换侧边栏", key: "Ctrl+B", group: "视图", icon: "sidebarToggle", run: () => this.shell.toggleSidebar() },
      { id: "view.panel", title: "切换底部面板", key: "Ctrl+J", group: "视图", icon: "panelToggle", run: () => this.shell.togglePanel() },
      { id: "view.problems", title: "显示问题面板", key: "Ctrl+Shift+M", group: "视图", icon: "problems", run: () => { this.setBottomTab("problems"); this.shell.togglePanel(false); } },
      { id: "view.output", title: "显示输出面板", group: "视图", icon: "terminal", run: () => { this.setBottomTab("output"); this.shell.togglePanel(false); } },
      { id: "view.commandPalette", title: "命令面板", key: "Ctrl+Shift+P", group: "视图", icon: "search", run: () => openCommandPalette() },
      { id: "view.toggleLighting", title: "切换光照预览显示", group: "视图", icon: "light", hint: "只影响编辑器的近似预览，不改工程数据、不影响导出/运行", run: () => {
        store.showLighting = !store.showLighting;
        this.hint(store.showLighting ? "光照预览已开启（近似效果，完整效果请烘焙）" : "光照预览已关闭（看清素材本色）");
        this.canvas.requestPaint();
      } },

      // ---------------- 光照 ----------------
      { id: "light.panel", title: "光照面板", group: "光照", icon: "light", hint: "2D 光照总开关、烘焙参数与光源清单", run: () => {
        this.auxTab.focus("lighting");
      } },
      { id: "light.bake", title: "一键烘焙光照", group: "光照", icon: "light", hint: "把这张场景的光照算成贴图存进工程（导出/运行直接用它）", run: () => void this.bakeLightingNow() },
      { id: "light.add", title: "在视图中央放一个光源", group: "光照", icon: "light", hint: "放一盏半径 140 的暖黄点光，随后可在右栏调参数", run: () => this.addLightAtViewCenter() },

      // ---------------- 工程 ----------------
      { id: "project.settings", title: "工程设置", group: "工程", icon: "settings", run: () => { this.shell.toggleSidebar(false); this.showSidebarView("settings"); } },
      { id: "project.package", title: "打包到 BWE（Windows EXE）…", group: "工程", icon: "packageBox", hint: "需要本地服务（网页版）或桌面客户端", run: () => void openBwePackager() },
      { id: "project.playtest", title: "试跑当前工程", group: "工程", icon: "play", key: "F6", hint: "在本机起 Java 窗口真跑：先做 JS 诊断，通过才启动", run: () => void this.openPlaytest() },
      { id: "project.exportWeb", title: "导出 Web 游戏包", group: "工程", icon: "exportImg", enabled: () => Boolean(store.project), run: () => this.exportWeb() },
      { id: "edit.prefabs", title: "预制体面板…", group: "工程", icon: "pack", run: () => { this.shell.toggleSidebar(false); this.showSidebarView("explorer"); this.explorerTab.focus("prefabs"); } },
      { id: "project.newExample", title: "新建示例工程", group: "工程", icon: "newFile", hint: "内置主角、敌人、箱子、触发区，直接可用", run: () => this.newExampleProject() },
      { id: "project.example.minesweeper", title: "扫雷示例（.bwproj）", group: "工程", icon: "module", run: () => this.newBuiltinExample("minesweeper") },
      { id: "project.example.dressup", title: "换装示例（.bwproj）", group: "工程", icon: "module", run: () => this.newBuiltinExample("dressup") },
      { id: "project.example.topdown", title: "俯视角 JS 示例（.bwproj）", group: "工程", icon: "module", run: () => this.newBuiltinExample("topdown-js") },
      { id: "project.example.emergence", title: "涌现沙盘示例（.bwproj）", group: "工程", icon: "module", run: () => this.newBuiltinExample("emergence") },
      { id: "project.example.vampire", title: "吸血鬼幸存者（.bwproj）", group: "工程", icon: "module", run: () => this.newBuiltinExample("vampire") },
      { id: "project.example.lighting", title: "2D 光照示例（.bwproj）", group: "工程", icon: "module", hint: "点光/聚光/遮挡/一键烘焙，点「试跑」看效果", run: () => this.newBuiltinExample("lighting") },
      { id: "project.example.alienShooter", title: "孤胆枪手（.bwproj）", group: "工程", icon: "module", hint: "还原 Alien Shooter 第一关「潜入」：WASD + 鼠标瞄准、按住左键连射、打爆油桶炸开裂墙", run: () => this.newBuiltinExample("alien-shooter") },

      // ---------------- 剧本 ----------------
      { id: "script.open", title: "打开剧本编辑器", group: "剧本", icon: "script", run: () => this.openTab("script") },
      { id: "script.jsApi", title: "JS 脚本 API 速查", group: "剧本", icon: "help", run: () => requestOpenScriptPanel("js") },
      { id: "script.goToProblems", title: "查看问题列表", group: "剧本", icon: "warn", run: () => { this.setBottomTab("problems"); this.shell.togglePanel(false); } },

      // ---------------- AI ----------------
      // id 与快捷键不变（原生菜单 toggle-ai-panel 也映射到这个 id），只把语义从
      // 「展开右侧栏」升级成「进入 / 退出 AI 界面」——两边必须同一个行为，
      // 否则键盘和菜单会各自表现不同。
      { id: "ai.focus", title: "AI：进入 / 退出 AI 界面", key: "Ctrl+Shift+A", group: "AI", icon: "sparkles", hint: "AI 界面铺满主工作区；退出时还原原来的折叠态", run: () => this.toggleAiMode() },
      { id: "ai.explainError", title: "AI：解释当前错误", group: "AI", icon: "warn", hint: "带诊断摘要 + 当前脚本", run: () => this.runAiAction("explain-error") },
      { id: "ai.editScript", title: "AI：改这段脚本", group: "AI", icon: "wand", hint: "AI 直接改脚本，改完可 Ctrl+Z 撤销；正文里的代码块仍会给 diff 供你确认", run: () => this.runAiAction("edit-script") },
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

  /** 命令面板里的 AI 动作：先展开 AI 栏，再由面板发起请求。 */
  private runAiAction(intent: "explain-error" | "edit-script" | "scene-review"): void {
    this.focusAiPanel();
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
    /**
     * ⚠ 这里必须**同步提交快照**，不能用 scheduleSnapshot 的 320ms 防抖。
     *
     * 防抖是为「连续拖动/连续打字」设计的：那些操作要合并成一步撤销。
     * 而 AI 改脚本是**一次完成的离散动作**，没有任何后续输入需要合并 ——
     * 用防抖的真实后果（实测踩到）：
     *   用户看到 AI 改好了，立刻按 Ctrl+Z → 快照还没入栈 → **撤销什么都没发生**，
     *   或者更糟：弹出的栈是**更早的**状态，界面跳回与预期完全不符。
     * 端到端验收（verify-script-write）就是靠这条断言抓到的。
     */
    this.commit("AI 改脚本");
    // 编辑器与侧边栏列表都要重画（用户需要看见改动落进去了）
    if (this.activeTabId === "script") renderScriptEditor(this.shell.editorBody);
    if (this.currentSidebarView === "script") renderScriptList(this.sidebarViewHost);
    this.refreshPanels();
  }

/**
   * AI 整批改造工程后的落地。与 applyAiScript 同构，差别只有一处：
   * projectOps 返回的是**新工程副本**（事务性要求），所以要走 replaceProjectData
   * 换引用并重绑场景与选中项，而不是原地改字段。
   */
  private applyAiProject(next: Project): void {
    /**
     * 先立标志再换引用：`replaceProjectData` 会触发 `store.onProject`，
     * 而那个监听器会调 `resetHistoryIfProjectReplaced()` —— 不走这个标志，
     * 刚压进撤销栈的这一步会被立刻清空（详见该函数的注释）。
     */
    this.suppressHistoryReset = true;
    try {
      store.replaceProjectData(next);
    } finally {
      this.suppressHistoryReset = false;
    }
    // 和 applyAiScript 一样必须**同步** commit：AI 改工程是一次离散动作，
    // 用 320ms 防抖会让用户看到结果后立刻 Ctrl+Z 时撤销到更早的状态。
    this.commit("AI 改工程");
    this.refreshPanels();
    // 场景结构变了，侧边栏若正停在世界视图上必须重建（否则列表里还是旧关卡）
    if (this.currentSidebarView === "explorer") this.explorerTab.refresh();
  }

  /**
   * 一次性标志：编辑器**自己**换了工程引用（AI 改工程 / 撤销还原），
   * 此时不能让 `resetHistoryIfProjectReplaced` 清空撤销历史。
   */
  private suppressHistoryReset = false;

  /**
   * AI 的脚本写类工具在**渲染侧的落地入口**（桌面版主进程经 IPC 转发到这里）。
   *
   * ── 为什么必须在这里执行 ──────────────────────────────────────────────
   * 工程的真身是渲染进程内存里的 `store.project`；磁盘上的 `.bwproj` 只是导出物。
   * 主进程改文件会让「编辑器内存 / 磁盘 / AI 的说法」三方分叉，表现为
   * 「AI 说改好了，界面没变，下次保存又把改动覆盖回去」。
   *
   * ── 与 applyAiScript 的关系 ────────────────────────────────────────────
   * 所有真正落地的写操作都走 `applyAiScript`（它负责 markDirty + commit 快照 + 重画），
   * 所以 AI 的每一次改动**天然可 Ctrl+Z 撤销**。本函数只做「规则判定 + 选对动作」，
   * 判定逻辑在 `core/scriptOps.ts`（纯函数、可单测）。
   *
   * @returns 给模型看的文本结果；`ok:false` 是业务拒绝（名字非法/有引用/补丁找不到），
   *          不是异常 —— 模型会读到原因并自己纠正。
   */
  runScriptTool(name: string, args: Record<string, unknown> = {}): {
    text: string;
    meta?: Record<string, unknown>;
    error?: string;
  } {
    const project = store.project;

    // ---- 只读类 ----
    if (name === "ListScripts") {
      return { text: describeScriptList(project), meta: { kind: "script-list", count: listScripts(project).length } };
    }
    if (name === "ReadScript") {
      const s = readScript(project, args.name);
      if (!s) {
        return {
          error: `脚本「${String(args.name ?? "")}」不存在`,
          text:
            `脚本「${String(args.name ?? "")}」不存在。`
            + "先用 ListScripts 看现有脚本清单（名字必须完全一致，含中文空格）。"
        };
      }
      return {
        text:
          `ReadScript(${s.name}) ${s.lang} · ${s.lines} 行 · 导出路径 ${s.file}\n`
          + "```" + (s.lang === "js" ? "js" : "yarn") + "\n" + s.source + "\n```",
        meta: { kind: "script-read", name: s.name, lines: s.lines }
      };
    }

    // ---- 工程级（关卡/UI/预制体）：AI 唯一能真的造世界的通道 ----
    // 判定逻辑全在 projectOps.runProjectTool 里（纯函数、被测试真的执行）；
    // 这里只负责把"已应用"的那个新工程落到编辑器的真实状态上。
    if (name === "ProjectDigest" || name === "ApplyProjectOps") {
      const out = runProjectTool(name, args as Record<string, unknown>, project);
      if (out.kind === "digest") return { text: out.text, meta: out.meta };
      if (out.kind === "rejected") return { error: out.error, text: out.text, meta: out.meta };
      // 换了引用但没换内容（空批次）就不要动 store，免得白白标脏、弹一次撤销点
      if (out.meta.changed !== false) this.applyAiProject(out.project);
      return { text: out.text, meta: out.meta };
    }

    // ---- 写类：全部经 scriptOps 判定，命中改动才落地 ----
    if (!project) {
      return { error: "没有打开的工程", text: "没有打开的工程，无法读写脚本。请先在编辑器里打开一个工程。" };
    }

    let result: ScriptOpResult;
    if (name === "WriteScript") {
      result = writeScript(project, args.name, args.source, {
        lang: args.lang,
        create: typeof args.create === "boolean" ? args.create : undefined
      });
    } else if (name === "PatchScript") {
      result = patchScript(project, args.name, args.find, args.replace);
    } else if (name === "DeleteScript") {
      result = deleteScript(project, args.name, { force: args.force === true });
    } else {
      return { error: `未知脚本工具「${name}」`, text: `未知脚本工具「${name}」` };
    }

    const text = result.message;
    if (!result.ok) {
      return {
        error: result.reason || "failed",
        text,
        // `tool` 与 `ok` 显式带上：知识库按「工具类型」聚合（WriteScript/PatchScript/DeleteScript
        // 的语义完全不同，只靠 name 分不出来）；`ok:false` 是业务拒绝，要原样记进知识库
        // ——「为什么被拒绝」正是以后"别再这么写"的线索。
        meta: { kind: "script-op", tool: name, ok: false, name: String(args.name ?? ""), reason: result.reason }
      };
    }

    // 只有**真的改了内容**才写回（幂等无变化时不产生一次无意义的撤销步骤）
    if (result.changed && result.after !== undefined) {
      this.applyAiScript(String(result.name ?? ""), result.after);
    }
    return {
      text,
      meta: {
        kind: "script-op",
        tool: name,
        ok: true,
        name: result.name,
        changed: Boolean(result.changed),
        // 行数变化给工具块显示，便于用户一眼看出「改了多大一片」
        beforeLines: typeof result.before === "string" ? result.before.split("\n").length : 0,
        afterLines: typeof result.after === "string" ? result.after.split("\n").length : 0,
        refs: result.refs?.length ?? 0
      }
    };
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
    // 菜单里「试跑当前工程」/「试跑（本机 Java 窗口）」都落到同一个动作上。
    // v4 起这不是"打开打包面板"了：试跑是独立入口（命令 project.playtest），
    // 主进程菜单只管发 quickrun，具体开哪个面板由这里决定。
    quickrun: "project.playtest",
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
        // 输入框里只放行 Esc（失焦）、命令面板与「进出 AI 界面」两组组合键，其余交给输入框自己。
        // Ctrl+Shift+A 要放行的原因：用户最常见的退出场景就是"正在 AI 输入框里打字"，
        // 这时按 Esc 只会失焦，得按两次；组合键必须一次到位。
        if (e.key === "Escape") (t as HTMLInputElement).blur();
        else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
          e.preventDefault();
          openCommandPalette();
        } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "a") {
          e.preventDefault();
          this.toggleAiMode();
        }
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;

      // ---- AI 界面 ----
      // Ctrl+Shift+A：进入 / 退出 AI 界面。旧行为只是「折叠/展开右侧栏」，
      // 但 AI 现在是独立工作面 —— 折叠一个占满主区的界面没有意义。
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        this.toggleAiMode();
        return;
      }
      // AI 界面里 Esc 退场。焦点在输入框里的情况已被上面的 inField 分支吃掉（那里 Esc = 失焦），
      // 所以这里只会命中"用户没在打字"的场景，不会把他的输入框一闪弹出去。
      if (e.key === "Escape" && this.aiModeActive()) {
        e.preventDefault();
        this.exitAiMode();
        return;
      }

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
      // F = 聚焦：有选中就框住选中对象，没选中才缩放到整张地图。
      // 用户原话「点击物体不能切换到聚焦，太难受了」——原来的 F 永远跳回全图，
      // 选中的小物件反而"越按越看不见"。
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        this.canvas.fitOrFocus();
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
      minesweeper: "扫雷示例已载入：点「试跑」开窗口真玩（左键翻开、右键插旗、空白自动展开、首击必安全）；行数、列数、地雷数在「模块」→「扫雷棋盘」里改。",
      dressup: "换装示例已载入：点「试跑」开窗口试玩（点击部件换装）；每个部位的造型和素材在「模块」→「换装部件」里改。",
      "topdown-js": "俯视角 JS 示例已载入：脚本在「剧本」标签里切到 JS 看 player/chaser/npc/hud/system；点「试跑」直接开窗口。",
      emergence: "涌现沙盘已载入：脚本在「剧本」标签（world/player/guard/civilian/bottle/hud）。点火看火势蔓延、烧穿木栅开路，守卫会被噪音引来——规则都在 bwe.material / bwe.field / bwe.ai 里组合。",
      vampire: "吸血鬼幸存者已载入：点「试跑」开窗口真打。WASD 走位、武器自动开火、1/2/3 选强化、R 重开；六个脚本（player/enemy/bullet/gem/director/hud）都在「剧本」标签里。",
      lighting: "2D 光照示例已载入：点「试跑」看夜晚的灯与影。按 R 切夜色档位（白天/黄昏/深夜/极暗）、按 B 手动重建动态贴图。画布上 5 盏灯各有用途——① 点光、② 聚光、③ 闪烁火把（不进烘焙）、④ 积木模块光、⑤ 墙前灯（演示遮挡阴影）。想试「一键烘焙」：右栏「光照」页 → 点烘焙按钮 → 再试跑对比。",
      "alien-shooter": "孤胆枪手已载入：点「试跑」开窗口玩（鼠标按住开火）。WASD 按屏幕方向走、鼠标瞄准、按住左键连射、右键朝光标走；1~4 / Q E 切枪，R 重开。目标：清掉巢穴，打爆仓库西墙边的气瓶把裂墙炸开，钻进地下入口。8 个脚本（player/enemy/combat/fx/director/pickup/grenade/hud）都在「剧本」标签里；像素画与音效由 web/tools/gen-alien-shooter.mjs 程序生成。"
    };
    this.loadExampleProject(() => built.project, built.fileName, tips[id]);
  }

  private loadExampleProject(build: () => Project, fileName: string, tip: string): void {
    const doNew = () => {
      // ⚠ 必须走 normalizeProject，不能直接把 build() 递给 store.setProject。
      // store.setProject 是纯 setter，不做字段兜底；缺字段的示例工程（web/examples 下
      // 10 个里有 6 个缺 prefabs）会让面板读 undefined.length 直接抛 TypeError。
      // 这条路径以前绕过了 this.setProject() 里的归一化，是个真实的崩溃入口。
      const normalized = normalizeProject(build());
      this.ensureTemplates(normalized);
      store.setProject(normalized, fileName);
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
    void openBwePackager("web");
  }

  /**
   * 试跑当前工程（取代原来的「预览」）。
   *
   * 为什么废掉「预览」：它只是把当前场景用同一套 painter 再画一遍到弹窗里，
   * 不跑任何脚本 —— 编辑器主视图本来就是同一份画面，弹窗既不多给信息，
   * 又容易让人把「静态摆位」当成「游戏跑起来的样子」。
   * 用户要看的是**真的动起来**，那是试跑（本机 Java 窗口跑工程自己的 JS）。
   *
   * 复用打包工作台的整套试跑逻辑（JS 诊断 → 收集素材 → 起 Java → 轮询日志），
   * 而不是在这里再写一份启动流程：两边各写一套，「诊断规则」和「素材收集」
   * 迟早会不一致，而这两件事恰好是最容易出错的地方。
   */
  private async openPlaytest(): Promise<void> {
    if (!store.project) {
      warn("先打开一个工程");
      return;
    }
    await openBwePackager();
  }

  // ==========================================================================
  // 撤销 / 快照（逻辑不变）
  // ==========================================================================

  /** 上一次看到的工程对象，用于识别「整个工程换了一个」。 */
  private lastProjectRef: Project | null = null;

  /**
   * 工程对象换了（不是字段变化，是整个对象被替换）就重置撤销历史与字符串池。
   *
   * ⚠ 判据从「引用变了」收紧为「引用变了**且不是编辑器自己换的**」。
   *
   * 原来只看引用：而 `applyAiProject`（AI 改工程）走的正是 `replaceProjectData`
   * ——它按事务性要求返回**新工程副本**，于是每次 AI 改完工程，这里都会把
   * 刚压进栈的那一步**立刻清掉**。表现是「AI 说改好了，按 Ctrl+Z 什么也没发生」，
   * 而且不报错、`undoStack` 看上去也正常（只是空的）。
   *
   * 用 `suppressHistoryReset` 这个一次性标志区分「谁换的引用」：
   * 打开/新建/载入示例 = 用户主动换工程，历史该作废；
   * AI 改工程 = 一次可撤销的编辑，历史必须保留。
   */
  private resetHistoryIfProjectReplaced(): void {
    const p = store.project;
    if (p === this.lastProjectRef) return;
    this.lastProjectRef = p;
    if (this.suppressHistoryReset) {
      // 编辑器自己换的引用（AI 改工程）：只更新基线引用，历史原样保留。
      return;
    }
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.snapshotPool.clear();
    this.lastSnapshot = this.snapshot();
  }

  // --------- 对外 ---------

  /**
   * 换工程。
   *
   * @param fileName    显示用文件名（标题栏/另存为默认名）
   * @param projectPath **磁盘绝对路径**（知识库分片用）。桌面版打开 .bwproj 时由主进程给；
   *                    示例工程/新建工程没有 → 传空，知识库按"只有名字"归档。
   */
  setProject(p: unknown, fileName = "", projectPath = ""): void {
    const normalized = normalizeProject(p);
    this.ensureTemplates(normalized);
    store.setProject(normalized, fileName, projectPath);
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
      /**
       * 撤销 / 重做本身也是「换一份工程引用」，必须挡住历史重置 ——
       * 否则撤销一步之后，`resetHistoryIfProjectReplaced` 会把剩下所有步骤清空，
       * 用户按第二次 Ctrl+Z 就没得撤了（表现为"只能撤销一步"）。
       */
      this.suppressHistoryReset = true;
      store.setProject(normalizeProject(parsed), store.fileName);
      this.suppressHistoryReset = false;
      this.lastSnapshot = this.snapshot();
      this.refreshPanels();
      /**
       * 剧本编辑器必须跟着重建。
       *
       * 为什么：快照还原走的是 `store.setProject(新对象)` —— 整个工程的
       * `scripts[name]` 都是**新引用**。而剧本编辑器持有的是旧 `script` 对象，
       * 它自己的 textarea 里也还是撤销前的文本。不重建的后果很具体：
       * Ctrl+Z 之后数据回退了、面板却还显示改后的内容，用户再敲一个字就把它写回去了。
       * （端到端验收里抓到过：替换后按 Ctrl+Z，textarea 仍是替换后的样子。）
       */
      window.dispatchEvent(new CustomEvent("bwe:refresh-script-ui"));
    } catch (e) {
      error(`撤销失败：${(e as Error).message}`);
    } finally {
      this.suppressSnapshot = false;
      this.suppressHistoryReset = false;
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
