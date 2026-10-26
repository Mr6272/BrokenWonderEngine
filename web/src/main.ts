/**
 * BWE Studio 入口。
 *
 * 启动顺序有讲究：
 *   1. 先建编辑器外壳（DOM 结构一次成型，避免后续插入导致布局抖动）；
 *   2. 再恢复上次的工程（异步读 IndexedDB），读到再挂数据；
 *   3. 最后开自动保存。
 *
 * 任何一步失败都不能留下白屏：出错时给出可点的提示，并退回空工程继续可用。
 */

import { Editor, showQuickStart } from "./app/editor.ts";
import { bootstrapProject, startAutoSave, armStartupGuard } from "./app/project.ts";
import { createProject } from "./core/model.ts";
import { store } from "./core/store.ts";
import { error, info } from "./ui/toast.ts";

function applySavedThemeAndScale(): void {
  try {
    const theme = localStorage.getItem("bwe.theme");
    if (theme === "high-contrast") {
      document.documentElement.classList.add("theme-high-contrast");
    }
    const scale = localStorage.getItem("bwe.uiScale");
    if (scale) document.body.style.zoom = `${Number(scale) / 100}`;
  } catch { /* ignore */ }
}

function boot(): void {
  applySavedThemeAndScale();
  const host = document.getElementById("root");
  if (!host) {
    document.body.textContent = "页面结构损坏：找不到 #root 节点";
    return;
  }

  let editor: Editor;
  try {
    editor = new Editor();
  } catch (e) {
    host.replaceChildren();
    const box = document.createElement("div");
    box.className = "boot-screen";
    box.innerHTML =
      '<div class="boot-logo">BWE</div>' +
      '<div class="boot-title">编辑器启动失败</div>' +
      `<div class="boot-error">${escapeText((e as Error).message)}</div>`;
    host.appendChild(box);
    return;
  }

  host.replaceChildren(editor.root);

  // 从别处触发的重绘请求（画布外的地方改了数据）
  window.addEventListener("bwe:repaint", () => editor.refreshAfterExternalChange());
  window.addEventListener("bwe:fit", () => editor.fitView());
  window.addEventListener("bwe:undo", () => editor.undo());
  window.addEventListener("bwe:redo", () => editor.redo());
  window.addEventListener("bwe:open-modules", () => editor.focusPanel("modules"));
  // 规则包被拖到对象上：整包套用（"模块拼接"的落地点）
  window.addEventListener("bwe:apply-pack", (e) => {
    const d = (e as CustomEvent).detail as { packId: string; objectId: string };
    editor.applyPackTo(d.packId, d.objectId);
  });

  void bootstrapProject((p, name) => {
    if (p) {
      editor.setProject(p as never, name);
    } else {
      editor.setProject(createProject("未命名工程"));
      info("新建了一个空工程，从左边「素材」导入图片开始");
    }
  }).catch((e) => {
    error(`恢复上次的工程失败：${(e as Error).message}。已为你新建一个空工程。`);
    editor.setProject(createProject("未命名工程"));
  });

  // 兜底线：装载迟迟没结果时，也要让编辑器进入可用状态
  armStartupGuard(
    () => !!store.project,
    () => editor.setProject(createProject("未命名工程"))
  );

  startAutoSave();

  // 启动自检：把真实状态写进 localStorage。
  // 原因：编辑器出状态不一致时，光看界面猜不出是哪一层丢了数据，这里留一条可外部读取的凭证。
  window.setTimeout(() => {
    try {
      const d = {
        hasProject: !!store.project,
        projectName: store.project?.name ?? null,
        scenes: store.project?.scenes.length ?? -1,
        hasScene: !!store.scene,
        sceneName: store.scene?.name ?? null,
        objects: store.scene?.objects.length ?? -1,
        assets: store.assets.length,
        packs: store.project?.packs.length ?? -1
      };
      localStorage.setItem("bwe.diag", JSON.stringify(d));
    } catch {
      /* 隐私模式忽略 */
    }
  }, 2500);

  // 调试出口：出问题时用户可以在控制台直接看状态，也方便我远程定位
  (window as unknown as Record<string, unknown>).__BWE__ = {
    store,
    editor,
    dump: () => ({
      hasProject: !!store.project,
      projectName: store.project?.name,
      scenes: store.project?.scenes.length ?? -1,
      hasScene: !!store.scene,
      sceneName: store.scene?.name,
      objects: store.scene?.objects.length ?? -1,
      assets: store.assets.length,
      packs: store.project?.packs.length ?? -1,
      selection: store.selection.length,
      dirty: store.dirty
    })
  };

  // 第一次打开的人给一张引导卡，但只弹一次，之后不再打扰
  try {
    if (!localStorage.getItem("bwe.seenQuickStart")) {
      window.setTimeout(() => {
        showQuickStart();
        localStorage.setItem("bwe.seenQuickStart", "1");
      }, 600);
    }
  } catch {
    /* 隐私模式下写不了 localStorage，跳过引导即可 */
  }

  // 关页面前提醒未保存
  window.addEventListener("beforeunload", (e) => {
    if (store.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
