/**
 * 桌面壳 · 预加载脚本（暴露 window.bweHost）。
 *
 * 这是渲染进程唯一能看到主进程的地方。结构以 docs/desktop-migration.md §3 为准，
 * 字段名一个都不能改：渲染侧 web/src/core/host.ts 的 BweHost 接口与之逐字对应。
 *
 * 两条纪律：
 *   1. contextIsolation=true / nodeIntegration=false：这里不许碰任何 Node API，
 *      只做 ipcRenderer 的转发与事件订阅的包装（泄漏 ipcRenderer 给页面等于关掉隔离）；
 *   2. 所有 invoke 都要有失败兜底：主进程 handler 抛错时渲染侧收到的是 reject，
 *      如果直接把 reject 抛给业务代码，面板会炸在 try/catch 之外的地方。
 *      这里统一包一层，转成契约里的 {ok:false, error} 形状。
 *
 * CJS（.cjs）：preload 在主进程的 ESM 之外加载，Electron 对 preload 支持 CJS 最稳。
 */

const { contextBridge, ipcRenderer } = require("electron");

/** 把一次 invoke 包成「永不抛错」：失败时返回契约里的失败形状。 */
async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (e) {
    const message = e?.message || String(e);
    return { ok: false, error: message };
  }
}

/** 订阅类接口：返回取消订阅函数（契约 §3 明确要求）。 */
function subscribe(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch {
      // 渲染侧回调自己抛错不该把 IPC 通道带崩。
    }
  };
  ipcRenderer.on(channel, listener);
  return () => {
    try {
      ipcRenderer.removeListener(channel, listener);
    } catch {
      // ignore
    }
  };
}

const host = {
  mode: "desktop",

  // 版本与路径在 preload 阶段由主进程通过同步 IPC 注入（invoke 是异步的，
  // 而渲染侧可能同步读 version）。用 sendSync 只为这一个只读小对象，代价可忽略。
  ...(() => {
    try {
      const info = ipcRenderer.sendSync("bwe:host-info");
      // 截图模式：在页面脚本执行前预置 localStorage，抑制「首次引导」弹窗。
      // 为什么必须在 preload 做：main.ts 是在启动 600ms 后读 localStorage 决定要不要弹窗，
      // 而每次截图用全新 userData（隔离并发缓存）→ 标记天然不存在 → 必弹，
      // 弹窗的半透明遮罩会把奶油底压成深色，主题断言直接误判成 FAIL。
      // 这里写入即等于「用户已经看过引导」，截图拿到的就是干净的默认视图。
      if (info?.shotMode) {
        try {
          localStorage.setItem("bwe.seenQuickStart", "1");
          localStorage.setItem("bwe.autoShot", "1");
        } catch {
          // localStorage 不可用（隐私模式）时不阻断截图。
        }
      }
      return info ?? {};
    } catch {
      return { version: "0.0.0", paths: { userData: "", workspace: "", repo: "", settings: "" } };
    }
  })(),

  // ---------- 内嵌 API（原 /api/* 的全部能力）----------
  api(path, init) {
    return invoke("bwe:api", { path: String(path ?? ""), init: init ?? {} });
  },

  // ---------- 文件 ----------
  openProject() {
    return invoke("bwe:open-project");
  },
  saveProject(project, suggestedName) {
    return invoke("bwe:save-project", { project, suggestedName, forceDialog: false });
  },
  saveProjectAs(project, suggestedName) {
    return invoke("bwe:save-project", { project, suggestedName, forceDialog: true });
  },
  recentProjects() {
    return invoke("bwe:recent-projects");
  },
  revealInExplorer(path) {
    return invoke("bwe:reveal-in-explorer", String(path ?? ""));
  },

  /** 保存打包产物（ZIP/APK）：桌面版无法用 window.location 下载，改走原生保存对话框。 */
  downloadFile(path, suggestedName) {
    return invoke("bwe:download-file", { path: String(path ?? ""), suggestedName: suggestedName ?? "" });
  },

  // ---------- 设置 ----------
  getSettings() {
    return invoke("bwe:get-settings");
  },
  setSettings(patch) {
    return invoke("bwe:set-settings", patch ?? {});
  },

  // ---------- AI ----------
  aiStatus() {
    return invoke("bwe:ai-status");
  },
  aiChat(req) {
    return invoke("bwe:ai-chat", req ?? {});
  },
  aiCancel(requestId) {
    return invoke("bwe:ai-cancel", String(requestId ?? ""));
  },
  aiReset() {
    return invoke("bwe:ai-reset");
  },
  onAiEvent(cb) {
    return subscribe("ai:event", cb);
  },

  // ---------- 原生菜单 → 渲染侧 ----------
  onMenuCommand(cb) {
    return subscribe("menu:command", cb);
  },

  /** 原生「打开工程」把内容直接送到渲染侧（渲染侧不用再自己读盘）。 */
  onOpenProjectRequest(cb) {
    return subscribe("project:opened", (payload) => cb(payload?.path ?? "", payload?.content ?? ""));
  }
};

contextBridge.exposeInMainWorld("bweHost", host);
