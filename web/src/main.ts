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

import { Editor, showQuickStart, showQuickStartBanner } from "./app/editor.ts";
import { bootstrapProject, startAutoSave, armStartupGuard } from "./app/project.ts";
import { createProject } from "./core/model.ts";
import { store } from "./core/store.ts";
import { error, info } from "./ui/toast.ts";
import { allCommands } from "./ui/commands.ts";

function applySavedThemeAndScale(): void {
  try {
    const theme = localStorage.getItem("bwe.theme");
    if (theme === "high-contrast") {
      document.documentElement.classList.add("theme-high-contrast");
    } else if (theme === "midnight") {
      document.documentElement.classList.add("theme-midnight");
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
  // 调试/验收出口：出问题时可以在控制台直接看状态，也能让截图脚本注入诊断数据
  (window as unknown as Record<string, unknown>).__BWE__ = {
    store,
    editor,
    /**
     * AI 写类工具的落地入口（桌面版主进程经 executeJavaScript 调用）。
     *
     * ⚠ 这条通道是**唯一**允许 AI 改工程的入口，因此它：
     *   1. **不做工具名白名单**。白名单只有一份 —— `desktop/lib/ai/tools.mjs` 的
     *      `TOOL_NAMES`。这里再拦一遍就会变成两套清单，加一个工具要改两处，
     *      漏改的表现是「schema 里有、模型照调、这里静默拒绝」。
     *      （原来这段注释写着"只接受 5 个工具名"—— 那是加工程类工具之前的事实，
     *      注释过期比没有注释更坏，它会让人以为能力故意被限住了。）
     *   2. 真正的规则判定全在 `core/scriptOps.ts` 与 `core/projectOps.ts`（纯函数、有单测），
     *      这里不做第二套判断 —— 两套规则必然分叉，表现为「工具说成功、编辑器里却是另一种结果」；
     *   3. 落地一律走 `editor.applyAiScript` / `editor.applyAiProject`
     *      （markDirty + commit 快照 → AI 的每次改动都可 Ctrl+Z 撤销）。
     * 参数是主进程 JSON 序列化后传进来的，**必须容错**：坏参数要返回错误而不是抛，
     * 否则 executeJavaScript 以 Promise reject 结束，主进程只能看到一个没有上下文的异常。
     */
    runScriptTool: (name: unknown, args: unknown) => {
      try {
        const tool = String(name ?? "");
        const safeArgs =
          args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
        return editor.runScriptTool(tool, safeArgs);
      } catch (e) {
        return {
          error: (e as Error)?.message || String(e),
          text: `脚本工具执行失败：${(e as Error)?.message || String(e)}`
        };
      }
    },
    /** 注入一组诊断（验收/排查用，正常使用时没人调） */
    injectProblems: (list: unknown[]) => {
      void import("./core/diagnostics.ts").then((m) => {
        m.setProblems("demo", list as never);
      });
    },
    /**
     * 量取编辑器几何（验收用）。
     * 为什么需要：`--probe-dom` 现在是硬编码探针，读不到任意选择器的高度；
     * 这里用一次 executeJavaScript 把关键区域的实际像素报出来，比截图目测可靠。
     */
    measureEditor: (sels: string[] = [".js-code", ".js-source", ".editor-body", ".js-main", ".js-workbench"]) => {
      const out: Record<string, unknown> = {};
      for (const sel of sels) {
        const e = document.querySelector(sel) as HTMLElement | null;
        const r = e?.getBoundingClientRect();
        out[sel] = r
          ? { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }
          : null;
      }
      console.log("[measure] " + JSON.stringify(out));
      return out;
    },
    /** 注入演示模型清单（验收截图用，只影响内存） */
    demoModels: () => {
      void import("./panels/aiPanel.ts").then((m) => {
        m.injectModelsForDemo(m.demoModelsState());
        console.log("[AI] 已注入演示模型清单");
      });
    },
    /** 模型清单诊断（验收/排查用） */
    debugAiModels: () => {
      void import("./panels/aiPanel.ts").then((m) => {
        const d = m.aiPanelDebugModels();
        console.log("[AI 模型诊断]", JSON.stringify(d, null, 2));
      });
    },
    /** 打开某个底部面板标签（problems / output / ai） */
    showPanelTab: (id: "problems" | "output" | "ai") => editor.openBottomTab(id),
    /**
     * 命令注册表快照（id / 标题 / 分组），验收脚本用来断言"某个命令在不在"。
     *
     * 为什么必须导出这个：有些功能的下线只能靠命令 id 断言 ——
     * 例如「预览」被废掉后，如果它只是从工具栏消失、命令还注册着，
     * 命令面板里一搜就能调出那个已经不该存在的静态画布弹窗。
     * 只查按钮文字查不出这种"残留在命令表里"的情况。
     */
    commands: () => allCommands().map((c) => ({ id: c.id, title: c.title, group: c.group })),
    /**
     * AI 界面（AI 工作面）的三个状态出口。
     *
     * 名字是契约（docs/ai-interface.md §3）：`desktop/tools/verify-ai-interface.mjs`
     * 直接按这三个名字取函数，改名等于让整条验收静默失效（脚本只会拿到 undefined）。
     */
    enterAiMode: () => editor.enterAiMode(),
    exitAiMode: () => editor.exitAiMode(),
    aiMode: () => editor.aiModeActive(),
    /**
     * 往当前 AI 面板灌 n 条**假的**工具调用（+1 条用户消息 +1 条助手消息），只改内存 DOM。
     *
     * 用途：验证「工具块一多就被压成一条缝」这条几何契约 —— 真跑 12 次工具调用太慢。
     * 为什么动态 import 且宽类型取函数：面板层（panels/aiPanel.ts）与外壳并行开发，
     * 静态 import 会让「面板还没落地」变成构建失败；契约钉的是函数名，不是模块类型。
     */
    debugAiStream: (n: number = 12) => {
      void import("./panels/aiPanel.ts").then((m) => {
        /**
         * 面板层与外壳是并行开发的，契约只钉了「灌 n 条假工具调用」这个**行为**，
         * 没钉函数名。这里按优先级找可实现者，而不是把某一时刻的函数名焊死：
         * 找不到就打一条 warn（验收脚本会因为工具块数量为 0 而红，不会静默通过）。
         */
        const mod = m as unknown as Record<string, unknown>;
        const candidates = ["injectDemoToolCalls", "injectDemoTools", "debugAiStream"];
        for (const key of candidates) {
          const fn = mod[key];
          if (typeof fn === "function") {
            (fn as (count: number) => void).call(m, n);
            console.log(`[AI] 已注入 ${n} 条演示工具调用（${key}）`);
            return;
          }
        }
        console.warn(`[AI] 面板层未提供演示流入口（候选：${candidates.join(" / ")}），本次跳过注入`);
      });
    },
    /**
     * 交互态对照（仅用于验收截图）：把画布工具条的按钮分别套上
     * 常态 / hover / active 三档，让一张截图里能同时看到三档底色与文字可读性。
     * 不自动执行 —— 产品界面里不该常驻一排"演示按钮"。
     */
    demoInteractionStates: () => {
      const host = document.querySelector(".canvas-toolbar");
      if (!host) return "no toolbar";
      const mk = (cls: string, text: string) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn sm " + cls;
        b.textContent = text;
        return b;
      };
      const wrap = document.createElement("div");
      wrap.className = "row tight demo-states";
      wrap.style.marginLeft = "8px";
      wrap.appendChild(mk("", "常态 Normal"));
      wrap.appendChild(mk("hover-demo", "hover"));
      wrap.appendChild(mk("active-demo", "active"));
      host.appendChild(wrap);
      return "ok";
    },
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
    // 首次打开**不再弹模态框**：模态会盖住整个编辑器（验收截图被挡、老用户也得先关一次）。
    // 改成右下角一条可关闭的引导条，点它才展开完整引导。
    if (!localStorage.getItem("bwe.seenQuickStart")) {
      window.setTimeout(() => {
        showQuickStartBanner();
        localStorage.setItem("bwe.seenQuickStart", "1");
      }, 600);
    }
  } catch {
    /* 隐私模式下写不了 localStorage，跳过引导即可 */
  }

  // 验收用：URL 带 #measure 时自动把关键区域几何打进控制台（--console 可抓）。
  // 这样不需要额外探针进程，也不用改 A 的 --probe-dom。
  if (location.hash === "#measure") {
    window.setTimeout(() => {
      const w = window as unknown as { __BWE__?: { measureEditor?: (s?: string[]) => unknown } };
      w.__BWE__?.measureEditor?.();
    }, 2500);
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
