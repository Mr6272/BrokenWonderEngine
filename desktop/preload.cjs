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

  // ---------- 模型切换 / Trae 导入 ----------
  /** 从本机 Trae 配置导入自定义供应商（导入的条目 key 恒为空，需手动填）。 */
  aiImportTrae() {
    return invoke("bwe:ai-import-trae");
  },
  /** 模型清单 + 当前选中 id（界面下拉框用）。 */
  aiModels() {
    return invoke("bwe:ai-models");
  },
  /** 切换当前模型（可顺带补填该模型的 API Key；空串不清 key，要清用 aiClearModelKey）。 */
  aiSetModel(id, apiKey) {
    const payload = { id: String(id ?? "") };
    // 只有明确传了「非空」apiKey 才带上：空串在 UI 上等于「没填」，
    // 绝不能因此把用户已存的 key 清掉（主进程侧同样按此语义，双保险）。
    if (typeof apiKey === "string" && apiKey.trim().length > 0) payload.apiKey = apiKey;
    return invoke("bwe:ai-set-model", payload);
  },
  /** 手动添加/覆盖一条模型（同 provider+baseUrl+model 就地更新，不新增第二条）。 */
  aiAddModel(input) {
    const src = input && typeof input === "object" ? input : {};
    const payload = {
      label: src.label !== undefined ? String(src.label) : "",
      provider: String(src.provider ?? ""),
      baseUrl: src.baseUrl !== undefined ? String(src.baseUrl) : "",
      model: String(src.model ?? "")
    };
    // 同样：只有非空 apiKey 才带，避免「添加时输入框为空」把 key 清掉
    if (typeof src.apiKey === "string" && src.apiKey.trim().length > 0) payload.apiKey = src.apiKey;
    if (src.contextWindow !== undefined) payload.contextWindow = Number(src.contextWindow);
    if (src.maxTokens !== undefined) payload.maxTokens = Number(src.maxTokens);
    if (src.notes !== undefined) payload.notes = String(src.notes);
    return invoke("bwe:ai-add-model", payload);
  },
  /** 显式清除某条模型已保存的 API Key（唯一能删 key 的入口）。 */
  aiClearModelKey(id) {
    return invoke("bwe:ai-set-model", { id: String(id ?? ""), clearApiKey: true });
  },
  /**
   * 真实探测某条模型的连通性（用户点「测试」时调）。
   *
   * 与 `aiModels()` 里的 `ready` 是两件事：`ready` 只说「配置齐全」，不代表能连上；
   * 这个能真正判出 200 / 401 / 超时。返回里 `ok` 是**三态**：
   *   true 明确可用 · false 明确不可用 · null 判不出来（见 detail 的说明）。
   */
  probeModel(id) {
    return invoke("bwe:ai-probe-model", { id: String(id ?? "") });
  },

  // ---------- 多会话 / 历史 ----------
  /** 会话列表 + 当前 active（每项含 id/title/createdAt/updatedAt/messageCount）。 */
  aiSessionsList() {
    return invoke("bwe:ai-sessions-list");
  },
  /** 开新会话（**当前会话保留**；会先中止在途请求，返回 aborted 数）。 */
  aiSessionNew(title) {
    return invoke("bwe:ai-session-new", title === undefined ? {} : { title: String(title) });
  },
  /** 切换会话，返回目标会话的完整 messages（UI 直接替换对话区）。 */
  aiSessionSwitch(id) {
    return invoke("bwe:ai-session-switch", { id: String(id ?? "") });
  },
  /** 删除会话（删到当前会话时会落到另一个会话，active 不会悬空）。 */
  aiSessionDelete(id) {
    return invoke("bwe:ai-session-delete", { id: String(id ?? "") });
  },

  // ---------- 脚本语言服务（补全 / 悬浮提示） ----------
  /**
   * 补全。`offset` 必须是 **UTF-16 code unit 偏移** ——
   * 直接传 `textarea.selectionStart` 即可，两边口径天然一致，不要自己按字符数算
   * （中英混排时会错位，这是这类功能最容易埋的雷）。
   */
  scriptComplete(source, offset) {
    return invoke("bwe:script-complete", { source: String(source ?? ""), offset: Number(offset ?? 0) });
  },
  /**
   * 悬浮提示。返回 `{ ok, info }`，其中 `info` 可能是 **null**（光标处没有符号，
   * 例如在括号/空白处）—— 那是正常结果，隐藏提示框即可，不要当错误处理。
   */
  scriptQuickInfo(source, offset) {
    return invoke("bwe:script-quickinfo", { source: String(source ?? ""), offset: Number(offset ?? 0) });
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
