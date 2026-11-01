/**
 * 编辑器外壳：顶栏、工具栏、三栏工作区、状态栏。
 *
 * 布局纪律（踩过的坑）：三栏用 flex 分配，中间栏 flex:1。
 * 绝不用"按窗口宽度算固定坐标"的做法 —— 不同分辨率与系统缩放下必然有一栏被挤出可视区。
 */

import { store, TOOLS, type Tool } from "../core/store.ts";
import type { Project } from "../core/model.ts";
import { createProject, normalizeProject, isUiScene, scenePixelSize, uiSafeArea } from "../core/model.ts";
import { SnapshotPool } from "../core/snapshot.ts";
import { CanvasView } from "./canvas.ts";
import { setPictureReadyHandler, paintObject, sizeOf } from "./painter.ts";
import { orderObjects } from "./canvas.ts";
import { el, button, iconButton, select } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { STATUS_READY } from "../ui/terms.ts";
import { Tabbed } from "../ui/tabbed.ts";
import { info, ok, warn, modal, contextMenu, confirmDialog, error } from "../ui/toast.ts";
import { renderAssetPanel } from "../panels/assetPanel.ts";
import { renderModulePanel } from "../panels/modulePanel.ts";
import { renderScenePanel } from "../panels/scenePanel.ts";
import { renderPrefabPanel } from "../panels/prefabPanel.ts";
import { renderInspector } from "../panels/inspector.ts";
import { renderScriptPanel, requestOpenScriptPanel } from "../panels/scriptPanel.ts";
import { renderSettingsPanel } from "../panels/settingsPanel.ts";
import { openBwePackager } from "./packageBwe.ts";
import { renderOutlinePanel } from "../panels/outlinePanel.ts";
import { openModuleEditor } from "../panels/moduleEditor.ts";
import { saveProjectFile, openProjectFile, downloadProject, createExampleProject } from "./project.ts";
import { buildExample, type ExampleId } from "../data/examples.ts";
import { detectMinigame, renderDressup, renderMinesweeper } from "./minigames.ts";
import { Session } from "../account/session.ts";

export class Editor {
  readonly root: HTMLDivElement;
  private canvas!: CanvasView;
  private leftTab!: Tabbed;
  private rightTab!: Tabbed;
  private statusCells: Record<string, HTMLElement> = {};
  private hintEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private hintTimer = 0;

  constructor() {
    this.root = el("div", { class: "app-root" });
    this.buildTop();
    this.buildToolbar();
    this.buildWorkspace();
    this.buildStatus();

    setPictureReadyHandler(() => this.canvas?.requestPaint());
    store.onAny(() => this.refreshChrome());
    store.onSelection(() => this.refreshToolbarState());
    // 选择变化 → 右栏 Inspector 立即重建（按帧合并，连点/框选不会重复建树）
    store.onSelection(() => this.scheduleRightPanel());
    // 工程被整体换掉（打开文件 / 载入示例 / 新建）时，撤销历史必须一起作废：
    // 旧快照里的占位对应的是旧工程的素材内容，留着既还原不出正确数据，还白占内存。
    // 挂在 store 上而不是散落在每个入口，是因为有几个入口（project.ts 打开文件）
    // 直接调 store.setProject，绕过编辑器自己的 setProject。
    store.onProject(() => this.resetHistoryIfProjectReplaced());
    // 面板重建请求按帧合并：一次数据变化可能同时触发多个 bwe:refresh，
    // 合并后同一帧只重建一次（见 schedulePanels 的注释）。
    window.addEventListener("bwe:refresh", () => this.schedulePanels());
    window.addEventListener("bwe:hint", (e) => this.hint(String((e as CustomEvent).detail ?? "")));
    // 其它面板（Inspector 的「脚本」卡片、帮助菜单）请求跳到「剧本」页
    window.addEventListener("bwe:open-scripts", () => this.leftTab.focus("scripts"));
    // 「预制体」面板要「放到场景视图正中」：面板不持有画布实例，这里把中心点回填给它。
    // detail 上的 has 标记必须有 —— 否则 (0,0) 与「没人监听」分不清，放置会落到地上角。
    window.addEventListener("bwe:prefab-view-center", (e) => {
      const detail = (e as CustomEvent<{ x: number; y: number; has?: boolean }>).detail;
      if (!detail || !this.canvas) return;
      const c = this.canvas.viewCenterWorld();
      detail.x = c.x;
      detail.y = c.y;
      detail.has = true;
    });
    // 面板自己接住 Ctrl+S 后广播保存请求（全局快捷键对 textarea 是放行的）
    window.addEventListener("bwe:save", () => void saveProjectFile());
    window.addEventListener("resize", () => this.canvas?.requestPaint());

    this.bindShortcuts();
    this.refreshChrome();
  }

  mount(host: HTMLElement): void {
    host.replaceChildren(this.root);
  }

  // ---------------- 顶栏 ----------------

  private buildTop(): void {
    const bar = el("div", { class: "topbar" });
    bar.appendChild(el("span", { class: "app-mark" }, "BWE"));
    bar.appendChild(el("span", { class: "app-title" }, "Studio"));
    bar.appendChild(el("div", { class: "sep" }));

    this.titleEl = el("span", { class: "project-name" });
    bar.appendChild(this.titleEl);
    bar.appendChild(el("div", { class: "spacer" }));

    const fileMenu = () => {
      const r = this.menuAnchor.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        { label: "新建工程", key: "Ctrl+N", onClick: () => this.newProject() },
        { label: "打开工程…", key: "Ctrl+O", onClick: () => void openProjectFile() },
        { divider: true },
        { label: "保存", key: "Ctrl+S", onClick: () => void saveProjectFile() },
        { label: "另存为（下载 .bwproj）", onClick: () => downloadProject() },
        { divider: true },
        { label: "预制体面板…", onClick: () => this.leftTab.focus("prefabs"), hint: "把调好的对象存成模板，之后 Drag 到画布就能反复用" },
        { divider: true },
        { label: "新建示例工程", onClick: () => this.newExampleProject(), hint: "内置主角、敌人、箱子、触发区，直接可用" },
        { label: "扫雷示例（.bwproj）", onClick: () => this.newBuiltinExample("minesweeper"), hint: "引擎内可试玩；行数、列数、地雷数都在模块参数里改" },
        { label: "换装示例（.bwproj）", onClick: () => this.newBuiltinExample("dressup"), hint: "角色拆成若干部件，点标签页即可换装" },
        { label: "俯视角 JS 示例（.bwproj）", onClick: () => this.newBuiltinExample("topdown-js"), hint: "WASD 移动 / 相机跟随 / A* 追击 / 交互对话 / HUD，全部由 JS 脚本驱动" },
        { label: "涌现沙盘示例（.bwproj）", onClick: () => this.newBuiltinExample("emergence"), hint: "材质→火/水/烟→感知AI→物理：亲手点火，看火烧穿木栅、引爆油桶、引来守卫" },
        { label: "吸血鬼幸存者（.bwproj）", onClick: () => this.newBuiltinExample("vampire"), hint: "WASD 走位 + 自动开火 + 升级三选一：活过一波又一波，直到被围死" },
        { divider: true },
        { label: "打包到 BWE（Windows EXE）…", onClick: () => void openBwePackager(), hint: "需要本地 npm run serve；输出含 exe 的 zip" },
        { label: "工程设置", onClick: () => this.leftTab.focus("settings") },
        { label: "导出 Web 游戏包", onClick: () => this.exportWeb(), disabled: true, hint: "下一步实现" }
      ]);
    };
    this.menuAnchor = button("文件", fileMenu, { variant: "ghost", size: "sm" });
    bar.appendChild(this.menuAnchor);

    bar.appendChild(
      button("编辑", () => {
        const r = this.menuAnchor.getBoundingClientRect();
        contextMenu(r.left + 50, r.bottom + 4, [
          { label: "撤销", key: "Ctrl+Z", onClick: () => window.dispatchEvent(new CustomEvent("bwe:undo")) },
          { label: "重做", key: "Ctrl+Y", onClick: () => window.dispatchEvent(new CustomEvent("bwe:redo")) }
        ]);
      }, { variant: "ghost", size: "sm" })
    );

    bar.appendChild(
      button("查看", () => {
        const r = this.menuAnchor.getBoundingClientRect();
        contextMenu(r.left + 100, r.bottom + 4, [
          { label: "缩放到整张地图", key: "F", onClick: () => this.canvas.zoomToFit() },
          { label: "100%", onClick: () => this.canvas.setZoom(1) },
          { divider: true },
          { label: "显示网格", onClick: () => { store.showGrid = !store.showGrid; this.canvas.requestPaint(); } },
          { label: "显示碰撞体", onClick: () => { store.showColliders = !store.showColliders; this.canvas.requestPaint(); } },
          { label: "显示名称", onClick: () => { store.showNames = !store.showNames; this.canvas.requestPaint(); } }
        ]);
      }, { variant: "ghost", size: "sm" })
    );

    bar.appendChild(
      button("帮助", () => {
        const r = this.menuAnchor.getBoundingClientRect();
        contextMenu(r.left + 150, r.bottom + 4, [
          { label: "快速上手", key: "F1", onClick: () => showQuickStart() },
          { label: "模块速查", onClick: () => this.leftTab.focus("modules") },
          { label: "JS 脚本 API 速查", onClick: () => requestOpenScriptPanel("js"), hint: "在左栏「剧本」页搜 bwe API，点一条插到光标处" },
          { divider: true },
          { label: "关于 BWE Studio", onClick: () => showAbout() }
        ]);
      }, { variant: "ghost", size: "sm" })
    );

    bar.appendChild(el("div", { class: "spacer" }));

    // 账号入口（登录 / 订阅）
    this.accountBtn = button(Session.label(), () => openAccountMenu(this.accountBtn), {
      variant: "ghost",
      size: "sm",
      iconPath: I.account
    });
    bar.appendChild(this.accountBtn);

    this.root.appendChild(bar);
  }

  private menuAnchor!: HTMLButtonElement;
  private accountBtn!: HTMLButtonElement;

  // ---------------- 工具栏 ----------------

  private buildToolbar(): void {
    const bar = el("div", { class: "toolbar" });

    const toolGroup = el("div", { class: "group" });
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
    toggles.appendChild(
      toggleIcon(I.grid, "显示网格 Grid", () => store.showGrid, (v) => { store.showGrid = v; this.canvas.requestPaint(); })
    );
    toggles.appendChild(
      toggleIcon(I.snap, "吸附到网格 Snap", () => store.snapToGrid, (v) => { store.snapToGrid = v; this.hint(v ? "吸附已开启" : "吸附已关闭，可以自由摆放"); })
    );
    toggles.appendChild(
      toggleIcon(I.bounds, "显示碰撞体 Collider", () => store.showColliders, (v) => { store.showColliders = v; this.canvas.requestPaint(); })
    );
    toggles.appendChild(
      toggleIcon(I.zone, "显示触发区 Trigger", () => store.showZones, (v) => { store.showZones = v; this.canvas.requestPaint(); })
    );
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

    bar.appendChild(
      button("删除", () => this.canvas.deleteSelection(), { size: "sm", iconPath: I.trash, title: "删除选中对象（Delete）" })
    );
    bar.appendChild(
      button("复制", () => this.duplicateSelection(), { size: "sm", iconPath: I.copy, title: "原地复制选中对象（Ctrl+D）" })
    );
    bar.appendChild(
      button("保存", () => void saveProjectFile(), { size: "sm", variant: "primary", iconPath: I.save, title: "保存工程（Ctrl+S）" })
    );
    bar.appendChild(
      button("模块", () => this.openModuleEditorForSelection(), {
        size: "sm",
        iconPath: I.module,
        title: "打开独立模块编辑器（M）"
      })
    );
    bar.appendChild(
      button("预览", () => this.openPreview(), { size: "sm", iconPath: I.play, title: "在编辑器内预览场景；挂玩法模块时可直接试玩" })
    );
    bar.appendChild(
      button("打包", () => void openBwePackager(), {
        size: "sm",
        iconPath: I.exportImg,
        title: "打包到 BWE，生成 Windows EXE（需要本地 npm run serve）"
      })
    );

    this.root.appendChild(bar);
  }

  private zoomLabel!: HTMLElement;

  private refreshToolbarState(): void {
    for (const [id, b] of this.toolButtons) {
      b.classList.toggle("active", store.tool === id);
    }
    this.zoomLabel.textContent = Math.round(this.canvas?.getZoom() * 100) + "%";
  }

  // ---------------- 工作区 ----------------

  private buildWorkspace(): void {
    const ws = el("div", { class: "workspace" });

    // 左栏
    const leftPane = el("div", { class: "pane left" });
    const leftBody = el("div", { class: "grow" });
    leftBody.style.minHeight = "0";
    leftBody.style.overflow = "hidden";
    leftPane.appendChild(leftBody);
    this.leftTab = new Tabbed(
      [
        { id: "assets", label: "素材 Assets", hint: "图片与音频；拖到画布上使用", render: renderAssetPanel },
        { id: "modules", label: "模块 Modules", hint: "可以加到对象身上的行为积木", render: renderModulePanel },
        { id: "prefabs", label: "预制体 Prefab", hint: "可反复摆放的对象模板；做好一个敌人，拖几次就有几个", render: renderPrefabPanel },
        { id: "scenes", label: "场景 Scenes", hint: "地图列表与图层", render: renderScenePanel },
        { id: "scripts", label: "剧本 Script", hint: "Yarn 剧情对话 / JS 脚本（bwe API）", render: renderScriptPanel },
        { id: "settings", label: "工程 Project", hint: "工程设置与账号", render: renderSettingsPanel }
      ],
      "assets"
    );
    leftBody.appendChild(this.leftTab.root);
    ws.appendChild(leftPane);

    ws.appendChild(this.makeResizer(leftPane, "left"));

    // 中栏
    const centerPane = el("div", { class: "pane center" });
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
    centerPane.appendChild(this.canvas.root);
    ws.appendChild(centerPane);

    // 右栏：先建好元素再挂分隔条，避免把"占位节点"当分隔条传进去
    const rightPane = el("div", { class: "pane right" });
    const rightBody = el("div", { class: "grow" });
    rightBody.style.minHeight = "0";
    rightBody.style.overflow = "auto";
    rightPane.appendChild(rightBody);
    this.rightTab = new Tabbed(
      [
        { id: "inspector", label: "对象 Inspector", hint: "选中对象的属性与挂载模块", render: renderInspector },
        { id: "layers", label: "图层 Layers", hint: "图层可见性与锁定", render: renderScenePanel },
        { id: "outline", label: "对象大纲", hint: "场景中所有对象的树状列表", render: renderOutlinePanel }
      ],
      "inspector"
    );
    rightBody.appendChild(this.rightTab.root);

    ws.appendChild(this.makeResizer(rightPane, "right"));
    ws.appendChild(rightPane);
    this.rightPaneRef = rightPane;

    this.root.appendChild(ws);
  }

  private rightPaneRef!: HTMLElement;

  /** 左右栏宽度拖拽条：双击恢复默认宽度。 */
  private makeResizer(pane: HTMLElement, side: "left" | "right"): HTMLElement {
    const r = el("div", { class: "pane-resizer", title: "拖动调整宽度，双击恢复默认" });
    let startX = 0;
    let startW = 0;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startX;
      const w = side === "left" ? startW + dx : startW - dx;
      pane.style.flex = `0 0 ${Math.max(220, Math.min(520, w))}px`;
      this.canvas?.requestPaint();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    r.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = pane.getBoundingClientRect().width;
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
    r.addEventListener("dblclick", () => {
      pane.style.flex = "";
      this.canvas?.requestPaint();
    });
    return r;
  }

  // ---------------- 状态栏 ----------------

  private buildStatus(): void {
    const bar = el("div", { class: "statusbar" });
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
    this.root.appendChild(bar);
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

  // ---------------- 刷新 ----------------

  refreshChrome(): void {
    this.titleEl.textContent = store.title();
    const scene = store.scene;
    this.setCell("scene", scene ? `${scene.name}　${scene.objects.length} 对象` : "无场景");
    this.setCell("sel", `选中 ${store.selection.length}`);
    this.setCell("assets", `素材 ${store.assets.length}`);
    this.zoomLabel.textContent = Math.round(this.canvas.getZoom() * 100) + "%";
    this.refreshToolbarState();
  }

  refreshPanels(): void {
    // 只重建当前可见的那一页。之前无条件 show(current) 会连带重建左右两侧全部 Tab 树，
    // 一次点击就要重新生成上百个 DOM 节点，是"点了要卡一下"的另一半原因。
    this.leftTab.refresh();
    this.rightTab.refresh();
    this.refreshChrome();
    this.canvas.requestPaint();
  }

  /**
   * 按帧合并的面板重建。
   *
   * 为什么需要：`bwe:refresh` 有 20 多处派发点，属性面板每改一个字段就发一次，
   * 而每次刷新要重建左右两棵 DOM 树。连续输入（比如拖数值框、连点按钮）时
   * 一帧里可能触发好几次，每次都同步重建 = 用户能感觉到的卡顿。
   * 合并到下一帧后，同一帧内的多次请求只重建一次，肉眼无差别、开销降一个量级。
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
    this.rightTab.show(this.rightTab.current());
  }

  /**
   * 选择变化时按帧合并刷新右栏。
   *
   * 之前的问题：canvas 里选中对象后既没有发 bwe:refresh，也没有任何地方监听
   * store.onSelection 去重建右栏，于是 Inspector 要等到下一次别的操作
   * （改属性、发事件）才顺带刷新一次——用户感知就是"点完要等一下才变"。
   *
   * 这里直接订阅选择变化并重建右栏；用 requestAnimationFrame 合并，
   * 是因为框选/连点会在一帧内改很多次选择，逐次重建整棵面板树没必要。
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

  // ---------------- 命令 ----------------

  private objectMenu(obj: import("../core/model.ts").SceneObject, sx: number, sy: number) {
    const scene = store.scene;
    if (!scene) return null;
    return [
      { label: "复制一份", key: "Ctrl+D", onClick: () => this.duplicateSelection() },
      {
        label: "上移一层",
        key: "Ctrl+↑",
        onClick: () => this.nudgeZ(obj, 1)
      },
      {
        label: "下移一层",
        key: "Ctrl+↓",
        onClick: () => this.nudgeZ(obj, -1)
      },
      { label: "置顶", onClick: () => this.sendZ(obj, "top") },
      { label: "置底", onClick: () => this.sendZ(obj, "bottom") },
      { divider: true },
      { label: obj.locked ? "解锁" : "锁定（防止误拖）", onClick: () => { obj.locked = !obj.locked; store.markDirty(); this.refreshPanels(); } },
      { label: obj.visible ? "隐藏" : "显示", onClick: () => { obj.visible = !obj.visible; store.markDirty(); this.canvas.requestPaint(); } },
      { divider: true },
      { label: "从这里对齐到格中心", onClick: () => { const t = store.project?.tileSize ?? 32; obj.x = Math.floor(obj.x / t) * t + t / 2; obj.y = Math.floor(obj.y / t) * t + t / 2; store.markDirty(); this.canvas.requestPaint(); } },
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
   * 导致"点了没反应"，所以这里按实际绘制顺序交换名次：
   * 把该对象与相邻对象的名次互换，再重新分配 z，保证视觉上确实进退了一层。
   */
  private nudgeZ(obj: import("../core/model.ts").SceneObject, dir: 1 | -1): void {
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
  private sendZ(obj: import("../core/model.ts").SceneObject, where: "top" | "bottom"): void {
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
      const c: import("../core/model.ts").SceneObject = {
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
      "示例工程已载入：试着选中主角，点工具栏「模块」打开独立编辑器；把素材拖到画布上试试。"
    );
  }

  private newBuiltinExample(id: ExampleId): void {
    const built = buildExample(id);
    const tips: Record<ExampleId, string> = {
      minesweeper: "扫雷示例已载入：点「预览」直接试玩；行数、列数、地雷数在工具栏「模块」→「扫雷棋盘」里改。",
      dressup: "换装示例已载入：点「预览」试玩；每个部位的造型和素材在「模块」→「换装部件」里改。",
      "topdown-js": "俯视角 JS 示例已载入：脚本在「剧本」面板切到 JS 看 player/chaser/npc/hud/system；点「试跑」直接开窗口。",
      emergence: "涌现沙盘已载入：脚本在「剧本」面板（world/player/guard/civilian/bottle/hud）。点火看火势蔓延、烧穿木栅开路，守卫会被噪音引来——规则都在 bwe.material / bwe.field / bwe.ai 里组合。",
      vampire: "吸血鬼幸存者已载入：点「预览」直接开打。WASD 走位、武器自动开火、1/2/3 选强化、R 重开；六个脚本（player/enemy/bullet/gem/director/hud）都在「剧本」面板里。"
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
    // 初始缩放：UI 场景按设计稿整张铺进来（否则 1280×720 的稿子在 700px 宽的
    // 预览窗口里只能看到左上角，用户会以为「界面没画出来」）；世界场景保持 1:1。
    let zoom = 1;
    if (uiScene) {
      const cw0 = 700;
      const ch0 = 520;
      zoom = Math.max(0.15, Math.min((cw0 - 24) / mapW, (ch0 - 24) / mapH));
    }

    // 交互状态（在 onClose 作用域中可见）
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
        wrap.style.background = "#15171d";
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
        // 把上面两个按钮重绑到 bumpZoom（它们原先直接改 zoom 且不更新标签）
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

        const worldToScreen = (wx: number, wy: number) => {
          return { x: (wx - camX) * zoom + cw / 2, y: (wy - camY) * zoom + ch / 2 };
        };

        paintPreview = () => {
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.imageSmoothingEnabled = false;
          g.fillStyle = "#15171d";
          g.fillRect(0, 0, cw, ch);

          // 画网格：UI 场景按 8px 参考线，世界场景按瓦片
          g.strokeStyle = "#22252f";
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

  // ---------------- 快捷键 ----------------

  private bindShortcuts(): void {
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        if (e.key === "Escape") (t as HTMLInputElement).blur();
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
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

  /** 上一次看到的工程对象，用于识别「整个工程换了一个」。 */
  private lastProjectRef: Project | null = null;

  /**
   * 工程对象换了（不是字段变化，是整个对象被替换）就重置撤销历史与字符串池。
   *
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

  // ---------------- 对外 ----------------

  setProject(p: unknown, fileName = ""): void {
    const normalized = normalizeProject(p);
    this.ensureTemplates(normalized);
    store.setProject(normalized, fileName);
    this.refreshPanels();
    this.canvas.zoomToFit();
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

  /** 切到左栏某一页（模块页是高频跳转目标）。 */
  focusPanel(id: string): void {
    this.leftTab.focus(id);
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
    body: "选中画布上的对象，点工具栏「模块」（或按 M）打开独立模块编辑器。左列是模块栈，右列是参数；模块是行为积木，不写代码也能做游戏逻辑。",
    action: "选对象 → 工具栏「模块」→ 添加模块"
  },
  {
    title: "第四步：做剧情触发",
    body: "用「触发区」工具（Z 键）在画布拖出一块区域，给它加「进入触发区时」模块，再选一个对话剧本。玩家走进去就会触发剧情。",
    action: "按 Z 键 → 画布拖区域 → 加模块"
  },
  {
    title: "第五步：保存工程",
    body: "Ctrl+S 保存。工程是 .bwproj 文件，可以拷给同事继续做，也可以用桌面版打开。",
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
      box.appendChild(el("div", { class: "hint", style: { fontSize: "13px", lineHeight: "1.8", marginBottom: "8px" } }, cur.body));

      const actionCard = el("div", { class: "card" });
      actionCard.appendChild(el("header", null, "这次试着做"));
      const actionBody = el("div", { class: "body" });
      actionBody.appendChild(el("div", { class: "hint", style: { fontSize: "12.5px" } }, cur.action));
      actionCard.appendChild(actionBody);
      box.appendChild(actionCard);

      if (index === 0) {
        const keys = el("div", { class: "hint", style: { fontSize: "11.5px", color: "var(--text-3)", marginTop: "8px" } });
        keys.textContent = "快捷键：V 选择 · B 画笔 · E 橡皮 · Z 触发区 · H 抓手 · M 模块编辑器 · F 缩放到地图 · Ctrl+S 保存 · F1 再次打开本引导";
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
          "素材与工程数据全部保存在你这台机器的浏览器本地（IndexedDB），不会上传到任何服务器。账号与订阅为可选功能。"
        )
      );
      return box;
    },
    actions: [{ label: "关闭", variant: "primary", onClick: (c) => c() }]
  });
}

void warn;

void select;
