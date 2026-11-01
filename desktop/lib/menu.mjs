/**
 * 桌面壳 · 原生菜单（中文）。
 *
 * 菜单项不直接操作渲染侧状态，而是发一条命令字符串（`menu:command`）：
 * 渲染侧本来就有一份「命令 → 动作」表（命令面板用的也是它），
 * 复用同一张表才能保证「菜单点了」和「命令面板搜出来」行为一致。
 *
 * 单独的菜单项（打包 / 试跑 / 打开 VS Code）走同一条通道，命令名与
 * 编辑器内部的动作名对齐：pack / quickrun / open-vscode。
 *
 * 这里不 import electron：模板是纯数据，主进程用 Menu.buildFromTemplate 消费。
 */

/** @typedef {{label:string, command?:string, accelerator?:string, role?:string, type?:string, submenu?:MenuItem[]} } MenuItem */

/**
 * @param {object} opts
 * @param {string[]} [opts.recent]  最近工程路径（会被塞进「文件 → 最近打开」）
 * @param {boolean} [opts.isMac]   macOS 上需要把「退出」放进应用菜单
 * @returns {MenuItem[]}
 */
export function buildAppMenu({ recent = [], isMac = false } = {}) {
  const recentItems = recent.length
    ? recent.slice(0, 10).map((path) => ({ label: path, command: `open-recent:${path}` }))
    : [{ label: "（暂无最近工程）", command: "menu-noop", enabled: false }];

  const fileMenu = {
    label: "文件",
    submenu: [
      { label: "新建工程", accelerator: "CmdOrCtrl+N", command: "new-project" },
      { label: "打开工程…", accelerator: "CmdOrCtrl+O", command: "open-project" },
      { label: "打开示例…", command: "open-samples" },
      { type: "separator" },
      { label: "保存", accelerator: "CmdOrCtrl+S", command: "save-project" },
      { label: "另存为…", accelerator: "CmdOrCtrl+Shift+S", command: "save-project-as" },
      {
        label: "最近打开",
        submenu: recentItems
      },
      { type: "separator" },
      { label: "打包到 BWE…", accelerator: "CmdOrCtrl+B", command: "pack" },
      { label: "试跑当前工程", accelerator: "F6", command: "quickrun" },
      { type: "separator" },
      { label: "在资源管理器中显示工程", command: "reveal-project" },
      { type: "separator" },
      { label: "退出", role: "quit" }
    ]
  };

  const editMenu = {
    label: "编辑",
    submenu: [
      { label: "撤销", role: "undo" },
      { label: "重做", role: "redo" },
      { type: "separator" },
      { label: "剪切", role: "cut" },
      { label: "复制", role: "copy" },
      { label: "粘贴", role: "paste" },
      { label: "全选", role: "selectAll" },
      { type: "separator" },
      { label: "命令面板…", accelerator: "CmdOrCtrl+Shift+P", command: "command-palette" },
      { label: "查找 / 搜索…", accelerator: "CmdOrCtrl+Shift+F", command: "search-panel" }
    ]
  };

  const viewMenu = {
    label: "查看",
    submenu: [
      { label: "活动栏", accelerator: "CmdOrCtrl+Shift+B", command: "toggle-activity-bar" },
      { label: "侧边栏", accelerator: "CmdOrCtrl+B", command: "toggle-sidebar" },
      { label: "底部面板", accelerator: "CmdOrCtrl+J", command: "toggle-panel" },
      { label: "AI 助手", accelerator: "CmdOrCtrl+Shift+A", command: "toggle-ai-panel" },
      { type: "separator" },
      { label: "实际大小", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
      { label: "放大", accelerator: "CmdOrCtrl+Plus", role: "zoomIn" },
      { label: "缩小", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
      { type: "separator" },
      { label: "重新加载", accelerator: "CmdOrCtrl+R", role: "reload" },
      { label: "切换全屏", accelerator: "F11", role: "togglefullscreen" },
      { label: "开发者工具", accelerator: "CmdOrCtrl+Shift+I", role: "toggleDevTools" }
    ]
  };

  const toolMenu = {
    label: "工具",
    submenu: [
      { label: "打包到 BWE…", command: "pack", accelerator: "CmdOrCtrl+Alt+B" },
      { label: "试跑（本机 Java 窗口）", command: "quickrun", accelerator: "F7" },
      { label: "停止试跑", command: "quickrun-stop" },
      { type: "separator" },
      { label: "在 VS Code 中打开当前脚本", command: "open-vscode", accelerator: "F8" },
      { label: "脚本诊断（js-check）", command: "js-check" },
      { type: "separator" },
      { label: "打开设置", command: "open-settings", accelerator: "CmdOrCtrl+," }
    ]
  };

  const helpMenu = {
    label: "帮助",
    submenu: [
      { label: "编辑器快捷键", command: "help-shortcuts" },
      { label: "脚本 API 文档", command: "help-api-docs" },
      { label: "关于 BWE Studio", command: "about" }
    ]
  };

  const template = [];
  if (isMac) {
    template.push({
      label: "BWE Studio",
      submenu: [
        { label: "关于 BWE Studio", command: "about" },
        { type: "separator" },
        { label: "退出", role: "quit" }
      ]
    });
  }
  template.push(fileMenu, editMenu, viewMenu, toolMenu, helpMenu);
  return template;
}
