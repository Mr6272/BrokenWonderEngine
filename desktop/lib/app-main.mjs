/**
 * 桌面壳 · 主进程实现（main.mjs 引导层动态 import 这里）。
 *
 * 只做「组装」：窗口、菜单、IPC 路由、AI 桥、生命周期。具体能力都在 lib/ 下。
 *
 * 命令行（见 main.mjs）：--shot=<png> / --size=WxH / --console / --probe=<json> / --tap=<sel,sel> / --verify
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, safeStorage } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFile as fsReadFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createEmbeddedApi } from "./api.mjs";
import { createAiBridge } from "./ai/bridge.mjs";
import { createApiIndex, defaultApiDocsPath } from "./ai/apiIndex.mjs";
import { createToolCache } from "./ai/prune.mjs";
import { openSession, workspaceHash } from "./ai/session.mjs";
import { createRecentStore } from "./recent.mjs";
import { createSettingsStore } from "./settings.mjs";
import { createWindowState, MIN_BOUNDS } from "./window-state.mjs";
import { analyzePng, assertTheme, describePng } from "./png.mjs";
import { buildAppMenu } from "./menu.mjs";
import { pruneToolResult } from "./ai/prune.mjs";
import { estimateSavings, mergeUsage, emptyUsage } from "./ai/usage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** desktop/ 的上一级 = 仓库根；打包后 app 目录结构与仓库一致（见 tools/package.mjs）。 */
const REPO_ROOT = resolve(HERE, "..", "..");
const WEB_INDEX = join(REPO_ROOT, "web", "index.html");
const PRELOAD = join(REPO_ROOT, "desktop", "preload.cjs");

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { console: false, shot: null, size: null, verify: false, probe: null, tap: null };
  // 命令行可能被 cmd.exe / 脚本包装过，参数里会留下成对的引号（--tap="..."）。
  // 不剥掉的话选择器会带着引号去找元素，永远找不到 —— 这类失败很难看出来。
  const stripQuotes = (s) => {
    const t = String(s ?? "").trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };
  for (const raw of argv.slice(1)) {
    const arg = stripQuotes(raw);
    if (arg === "--console") out.console = true;
    else if (arg === "--verify") out.verify = true;
    else if (arg.startsWith("--shot=")) out.shot = stripQuotes(arg.slice("--shot=".length));
    else if (arg.startsWith("--probe=")) out.probe = stripQuotes(arg.slice("--probe=".length));
    else if (arg.startsWith("--tap=")) out.tap = stripQuotes(arg.slice("--tap=".length));
    else if (arg.startsWith("--size=")) {
      const m = /^(\d+)x(\d+)$/.exec(stripQuotes(arg.slice("--size=".length)));
      if (m) out.size = { width: Number(m[1]), height: Number(m[2]) };
    }
  }
  return out;
}

const ARGS = parseArgs(process.argv);
const SHOT_MODE = Boolean(ARGS.shot);
const DEFAULT_SHOT_SIZE = { width: 1600, height: 1000 };

// ⚠ 截图模式强制 dpr=1：
// 否则在高 DPI 屏（本机 150%）上，窗口内容区只有 1600/1.5≈1067 CSS px，
// capturePage 再把它放大成 1600 设备像素 —— 出来的图看着没问题，但**布局是错的**：
// 探针报的 activityBar/sidebar 宽度都是 1067 宽视口下的值，
// 「1280x720 下是否横向溢出」这种判定就完全不可信。
// 锁死 dpr=1 后，--size=1280x720 就是真正的 1280x720 逻辑视口，截图也是 1:1。
if (SHOT_MODE) {
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.commandLine.appendSwitch("high-dpi-support", "1");
  // 截图只需一次渲染，磁盘缓存对 --shot 毫无价值；而它恰恰是并发截图抢锁的根源
  // （见 USER_DATA_DIR 上的注释）。关掉后即使两个进程共用目录也不会争 cache。
  app.commandLine.appendSwitch("disable-http-cache");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
}

/**
 * 页面就绪状态：**在 loadFile 之前**就挂好监听器。
 * 踩过的坑：loadFile() 的 promise resolve 时 did-finish-load 可能已经派发完了，
 * 之后再 once("did-finish-load") 永远等不到 → 截图模式超时 25s、loaded=false。
 */
const pageState = { finished: false, failures: [] };

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

const logBuffer = [];
function log(message, tag = "bwe:desk") {
  const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`;
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.splice(0, logBuffer.length - 500);
  if (ARGS.console) console.log(`[${tag}] ${message}`);
}

// 兜底：任何未捕获异常都要留下痕迹，否则「双击没反应」无法排查。
process.on("uncaughtException", (e) => {
  const msg = `未捕获异常：${e?.stack || e?.message || e}`;
  log(msg, "bwe:crash");
  console.error(`[bwe:crash] ${msg}`);
});
process.on("unhandledRejection", (e) => {
  const msg = `未处理的 Promise 拒绝：${e?.stack || e?.message || e}`;
  log(msg, "bwe:crash");
  console.error(`[bwe:crash] ${msg}`);
});

// ⚠ 截图模式必须**每次进程独立 userData**，否则并发截图会互相踩（踩过的真实故障）：
//   两个 `BWE Studio.exe --shot` 同时跑时，共用同一个 userData 目录，
//   Chromium 的 disk cache / GPU shader cache 争锁失败 →
//     · 要么 CSS 没加载：截图主色变成窗口默认底色 #686860，被判「深色主题 FAIL」；
//     · 要么 JS 没跑起来：截图 99.8% 纯奶油、非背景 0.2%，被判「空白截图 FAIL」。
//   症状是**随机的红**，看起来像逻辑错，实际是环境竞争 —— 这类假红必须治根。
// 用 pid 后缀天然隔离；进程退出时删掉自己那一份（异常退出留下的由下次启动清理）。
app.setName("BWE Studio");
const APPDATA_DIR = app.getPath("appData");
const SHOT_PROFILE_BASE = join(APPDATA_DIR, "BWE Studio", ".shot-profile");
// 截图模式用独立的 userData：不与正在跑的实例抢单实例锁、也不污染用户的会话/设置。
const USER_DATA_DIR = SHOT_MODE ? join(SHOT_PROFILE_BASE, String(process.pid)) : join(APPDATA_DIR, "BWE Studio");
app.setPath("userData", USER_DATA_DIR);

/**
 * 清理旧的截图 profile —— **只保留最近的若干个**（契约要求的宽松版，也是唯一并发安全的做法）。
 *
 * ⚠ 两种做法都不能用：
 *   · 「退出时删自己那份」：`app.exit()` 直接终止进程，**不触发 before-quit**，
 *     而且此时 Chromium 子进程还攥着文件句柄，Windows 上删不掉（实测留下空壳目录）；
 *   · 「启动时删掉所有别的 pid 目录」：并发时会**删掉另一个进程正在用的 profile**，
 *     那个进程的 Chromium 缓存瞬间失效 → 反而制造出要修的那个 bug。
 *
 * 所以按 mtime 保留最新 KEEP 个（自己那份永远跳过），其余删除。
 * 并发时两个进程都是「最近的」，不会被删；长时间反复跑也不会堆积（每次启动压缩到 KEEP 个）。
 */
const SHOT_PROFILE_KEEP = 6;

async function cleanupOldShotProfiles() {
  if (!SHOT_MODE) return;
  try {
    const entries = await readdir(SHOT_PROFILE_BASE, { withFileTypes: true }).catch(() => []);
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(SHOT_PROFILE_BASE, entry.name);
      if (full === USER_DATA_DIR) continue; // 自己这份必须留
      const info = await stat(full).catch(() => null);
      dirs.push({ full, mtime: info?.mtimeMs ?? 0 });
    }
    dirs.sort((a, b) => b.mtime - a.mtime);
    // 保留最新 KEEP 个（含自己，所以别的目录最多留 KEEP-1 个）
    for (const entry of dirs.slice(SHOT_PROFILE_KEEP - 1)) {
      await rm(entry.full, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
  } catch {
    // 目录不存在 / 被占用：不影响截图，忽略。
  }
}

// ---------------------------------------------------------------------------
// 单实例锁（截图模式不参与：验收时可能同时开着编辑器）
// ---------------------------------------------------------------------------

let mainWindow = null;
let windowState = null;
let api = null;
let ai = null;
let settingsStore = null;
let recentStore = null;

if (!SHOT_MODE) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // 已有实例：把命令行里的「打开某个文件」转给它，然后自己退出。
    app.quit();
  } else {
    app.on("second-instance", (_e, argv) => {
      const file = fileArgOf(argv);
      if (file) void openProjectFromDisk(file);
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
}

/** 从 argv 里挑一个像 .bwproj 的参数（双击文件打开、拖到任务栏都靠它）。 */
function fileArgOf(argv) {
  for (const a of argv.slice(1)) {
    if (a.startsWith("--")) continue;
    if (a.toLowerCase().endsWith(".bwproj")) return a;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    if (!existsSync(WEB_INDEX)) {
      // 打包不完整时给出可执行的提示，而不是一个白窗口。
      const detail = `找不到 ${WEB_INDEX}。\n请在仓库根执行 npm run build 生成 web/dist/studio.js，或重新运行 node desktop/tools/package.mjs 打包。`;
      if (SHOT_MODE) {
        // ⚠ 截图模式绝不能弹模态框：无人点击 → 自检永远挂住（打包 --verify 踩过）。
        console.error(`[shot] 缺少前端文件：${detail.replace(/\n/g, " ")}`);
        app.exit(2);
        return;
      }
      dialog.showErrorBox("BWE Studio 缺少前端文件", detail);
      app.exit(1);
      return;
    }

    windowState = createWindowState({ file: join(USER_DATA_DIR, "window.json") });
    recentStore = createRecentStore({ file: join(USER_DATA_DIR, "recent.json") });
    // 截图模式：先清掉历史 profile（只留自己这一个，见 cleanupOldShotProfiles 注释）。
    await cleanupOldShotProfiles();
    settingsStore = createSettingsStore({
      file: join(USER_DATA_DIR, "settings.json"),
      crypto: {
        available: Boolean(safeStorage?.isEncryptionAvailable?.()),
        encryptString: (s) => safeStorage.encryptString(s).toString("base64"),
        decryptString: (s) => safeStorage.decryptString(Buffer.from(s, "base64"))
      }
    });
    await settingsStore.load();

    api = createEmbeddedApi({ repoRoot: REPO_ROOT, port: 0, onLog: (m, t) => log(m, t) });

    // AI 桥：会话/缓存都落在 userData 下（契约 §4.4）
    const sessionDir = join(USER_DATA_DIR, "sessions", workspaceHash(REPO_ROOT));
    const session = await openSession({ dir: sessionDir, workspace: REPO_ROOT });
    const apiIndex = createApiIndex(defaultApiDocsPath(REPO_ROOT));
    const toolCache = createToolCache(join(USER_DATA_DIR, "toolCache"));
    ai = createAiBridge({
      session,
      repoRoot: REPO_ROOT,
      workspaceRoot: REPO_ROOT,
      apiIndex,
      toolCache,
      getSettings: () => settingsStore.load(),
      sendEvent: (ev) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ai:event", ev);
      },
      log: (m) => log(m, "bwe:ai")
    });

    registerIpc();
    await createMainWindow();
    log(`BWE Studio 启动：repo=${REPO_ROOT} userData=${USER_DATA_DIR} shot=${SHOT_MODE}`);
    if (ARGS.console) console.log(`[bwe:desk] 页面入口 ${WEB_INDEX}`);

    if (SHOT_MODE) await runShotMode();
  } catch (e) {
    const msg = `启动失败：${e?.stack || e?.message || e}`;
    log(msg, "bwe:crash");
    console.error(`[bwe:crash] ${msg}`);
    // 截图模式下不弹模态框（见上方缺少前端文件处的注释）。
    if (!SHOT_MODE) dialog.showErrorBox("BWE Studio 启动失败", msg);
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  try {
    api?.killQuickRunSync();
  } catch {
    // 退出时杀子进程失败不该阻断退出。
  }
});

// 截图模式的 profile 清理放在**启动时**做（保留最近 SHOT_PROFILE_KEEP 个），
// 不在退出时删自己那份：app.exit() 不触发 before-quit，且此刻 Chromium 还攥着句柄删不掉。
// 详见 cleanupOldShotProfiles 的注释。

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

async function createMainWindow() {
  const saved = await windowState.load(screen);
  const shotSize = ARGS.size ?? DEFAULT_SHOT_SIZE;
  // 截图模式已锁 dpr=1（见文件上方），所以窗口尺寸就是目标像素，不用再按 scaleFactor 反算。
  const scale = SHOT_MODE ? 1 : (screen.getPrimaryDisplay().scaleFactor || 1);

  const bounds = SHOT_MODE
    ? {
        // 截图要的是**精确像素**：capturePage 按设备像素返回，所以要按 scaleFactor 反算窗口尺寸。
        width: Math.round(shotSize.width / scale),
        height: Math.round(shotSize.height / scale)
      }
    : {
        width: Math.max(MIN_BOUNDS.width, saved.width),
        height: Math.max(MIN_BOUNDS.height, saved.height),
        ...(saved.x !== undefined ? { x: saved.x, y: saved.y } : {})
      };

  mainWindow = new BrowserWindow({
    ...bounds,
    useContentSize: SHOT_MODE, // 普通模式记的是外框尺寸；截图模式要内容区正好是目标像素
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    title: "BWE Studio",
    backgroundColor: "#f7f4ee",
    show: false,
    // 默认标题栏（契约要求 titleBarStyle 默认值）
    autoHideMenuBar: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 桌面版页面是 file://，不加载远程资源；开启 webSecurity 保持默认隔离。
      webSecurity: true
    }
  });

  // 渲染进程控制台 + 加载失败原因：没有这两个钩子，出问题是「白窗口 + 静默 exit 0」。
  mainWindow.webContents.on("console-message", (...cbArgs) => {
    // Electron 37 起首参是事件对象；旧签名 (event, level, message, line, sourceId) 仍兼容。
    const ev = cbArgs[0];
    const message = typeof ev?.message === "string" ? ev.message : cbArgs[2];
    const level = typeof ev?.level === "string" ? ev.level : cbArgs[1];
    const source = ev?.sourceId ?? cbArgs[4];
    if (ARGS.console) {
      const text = String(message ?? "");
      // 过滤 Electron 自带的 CSP 安全警告：它只在开发期出现，会淹没真错误。
      if (!/Electron Security Warning/.test(text)) console.log(`[renderer:${level ?? "log"}] ${text}${source ? ` (${basename(String(source))})` : ""}`);
    }
    logBuffer.push(`[renderer:${level ?? "log"}] ${String(message ?? "").slice(0, 400)}`);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    const msg = `页面加载失败（main=${isMainFrame}）：${code} ${desc} ${url}`;
    pageState.failures.push({ code, desc, url, isMainFrame });
    log(msg, "bwe:page");
    if (ARGS.console) console.error(`[bwe:page] ${msg}`);
  });
  // did-finish-load 必须**在 loadFile 之前**挂好（见 pageState 注释）。
  mainWindow.webContents.once("did-finish-load", () => {
    pageState.finished = true;
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    log(`渲染进程结束：${details?.reason} (exitCode ${details?.exitCode})`, "bwe:page");
  });

  await mainWindow.loadFile(WEB_INDEX);
  if (!SHOT_MODE) {
    if (saved.maximized) mainWindow.maximize();
    mainWindow.show();
    applyMenu(await recentStore.list());
  } else {
    mainWindow.show();
  }

  mainWindow.on("close", () => {
    if (SHOT_MODE) return;
    void windowState.save(mainWindow);
  });
  return mainWindow;
}

async function applyMenu(recentList) {
  const template = buildAppMenu({
    recent: recentList.map((r) => r.path),
    isMac: process.platform === "darwin"
  });
  // 把纯数据的菜单模板翻译成真正的 Menu：command 项点击后发命令给渲染侧。
  const build = (items) =>
    items.map((item) => {
      if (item.submenu) return { ...item, submenu: build(item.submenu) };
      if (item.command) {
        return {
          ...item,
          click: () => {
            void dispatchMenuCommand(item.command);
          }
        };
      }
      return item;
    });
  Menu.setApplicationMenu(Menu.buildFromTemplate(build(template)));
}

/** 菜单项点击：主进程能自己做的（打开/保存对话框）自己做，其余发命令给渲染侧。 */
async function dispatchMenuCommand(command) {
  try {
    if (command === "open-project") {
      const result = await handleOpenProject();
      if (result?.ok) {
        mainWindow?.webContents.send("project:opened", { path: result.path, content: result.content });
      }
      return;
    }
    if (command.startsWith("open-recent:")) {
      const file = command.slice("open-recent:".length);
      const result = await openProjectFromDisk(file);
      if (result?.ok) mainWindow?.webContents.send("project:opened", { path: result.path, content: result.content });
      return;
    }
    mainWindow?.webContents.send("menu:command", command);
  } catch (e) {
    log(`菜单命令 ${command} 执行失败：${e?.message || e}`, "bwe:menu");
  }
}

// ---------------------------------------------------------------------------
// 工程文件（.bwproj = JSON）
// ---------------------------------------------------------------------------

async function handleOpenProject() {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: "打开 BWE 工程",
    filters: [
      { name: "BWE 工程", extensions: ["bwproj"] },
      { name: "JSON", extensions: ["json"] }
    ],
    properties: ["openFile"]
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  return readProjectFile(result.filePaths[0]);
}

async function readProjectFile(path) {
  try {
    const content = await fsReadFile(path, "utf8");
    // 先校验是 JSON：坏文件宁可在这里报错，也不要送进渲染侧炸掉整个编辑器。
    JSON.parse(content);
    await recentStore.touch(path, basename(path));
    await applyMenu(await recentStore.list());
    return { ok: true, path, content, name: basename(path) };
  } catch (e) {
    return { ok: false, error: `读取工程失败：${e?.message || e}` };
  }
}

async function openProjectFromDisk(path) {
  const abs = resolve(path);
  return readProjectFile(abs);
}

async function handleSaveProject({ project, suggestedName, forceDialog } = {}) {
  if (!project || typeof project !== "object") return { ok: false, error: "没有工程内容可保存" };
  const fileName = `${String(suggestedName || project.name || "未命名工程").replace(/[\\/:*?"<>|]/g, "_")}.bwproj`;
  let target = null;

  // 覆盖保存：上一次保存过的路径直接写（除非是「另存为」）。
  if (!forceDialog && !SHOT_MODE) {
    const prev = await recentStore.list({ verify: true });
    const sameName = prev.find((r) => r.name === fileName);
    if (sameName) target = sameName.path;
  }

  if (!target) {
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: forceDialog ? "工程另存为" : "保存工程",
      defaultPath: join(USER_DATA_DIR, "projects", fileName),
      filters: [{ name: "BWE 工程", extensions: ["bwproj"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    target = result.filePath;
  }

  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(project, null, 2), "utf8");
    const name = basename(target);
    await recentStore.touch(target, name);
    await applyMenu(await recentStore.list());
    log(`工程已保存：${target}`);
    return { ok: true, path: target, name };
  } catch (e) {
    return { ok: false, error: `保存工程失败：${e?.message || e}` };
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  // preload 里的同步注入：版本 + 路径（同步只为这一个只读小对象）
  ipcMain.on("bwe:host-info", (event) => {
    event.returnValue = {
      version: app.getVersion(),
      paths: {
        userData: USER_DATA_DIR,
        workspace: REPO_ROOT,
        repo: REPO_ROOT,
        settings: settingsStore.file
      },
      // 截图模式的「首次引导」开关：
      // 每次截图用全新 userData → localStorage 是空的 → main.ts 的首次引导会弹「快速上手」，
      // 它的半透明遮罩把奶油底压成 #686860，主题断言直接误判成深色 FAIL。
      // 所以截图模式告诉 preload「这是自动截图，别弹引导」，由 preload 在页面脚本之前
      // 预置 localStorage 标记（见 preload.cjs）。
      shotMode: SHOT_MODE
    };
  });

  ipcMain.handle("bwe:api", async (_e, { path, init }) => api.handleApi(path, init));

  ipcMain.handle("bwe:open-project", async () => handleOpenProject());
  ipcMain.handle("bwe:save-project", async (_e, payload) => handleSaveProject(payload ?? {}));
  ipcMain.handle("bwe:recent-projects", async () => recentStore.list());
  ipcMain.handle("bwe:reveal-in-explorer", async (_e, path) => {
    try {
      const target = String(path || REPO_ROOT);
      shell.showItemInFolder(target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("bwe:download-file", async (_e, { path, suggestedName }) => {
    try {
      // path 是 /api/... 的下载路由：桌面版把它解析成文件内容后弹原生保存框。
      const binary = await api.rawBinary(path);
      if (!binary) return { ok: false, error: "这个接口没有可下载的文件（可能还没打包完成）" };
      const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
        title: "保存打包产物",
        defaultPath: join(USER_DATA_DIR, "downloads", suggestedName || binary.filename || "BWE-build.zip")
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      await mkdir(dirname(result.filePath), { recursive: true });
      await writeFile(result.filePath, binary.data);
      return { ok: true, path: result.filePath, sizeBytes: binary.data.length };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("bwe:get-settings", async () => settingsStore.view());
  ipcMain.handle("bwe:set-settings", async (_e, patch) => {
    await settingsStore.save(patch ?? {});
    return settingsStore.view();
  });

  ipcMain.handle("bwe:ai-status", async () => ai.aiStatus());
  ipcMain.handle("bwe:ai-chat", async (_e, request) => ai.aiChat(request ?? {}));
  ipcMain.handle("bwe:ai-cancel", async (_e, requestId) => ai.aiCancel(requestId));
  ipcMain.handle("bwe:ai-reset", async () => ai.aiReset());

  // 日志给渲染侧的「输出」面板（--console 之外第二个观察点）
  ipcMain.handle("bwe:log-tail", async () => logBuffer.slice(-200));
}

// ---------------------------------------------------------------------------
// 截图模式（验收）
// ---------------------------------------------------------------------------

/**
 * 读 UI 骨架计数 + 几何数据（验证「结构真的建起来了」而不只是「有像素」）。
 *
 * 几何数据为什么必要：截图只能看出「有块黑的」，看不出「auxPanel 占了 300px
 * 把画布工具条挤到截断」。有了 x/width 与 scrollWidth，就能直接判定
 * 「1280x720 下是否横向溢出」，而不是靠人数像素。
 *
 * 用 executeJavaScript 读渲染进程里的真实 DOM：比截图更早发现问题
 * （例如主题加载了但编辑器 mount 失败时，背景色是对的、内容是空的）。
 */
async function probeUiSkeleton() {
  try {
    const data = await mainWindow.webContents.executeJavaScript(
      `(() => {
        const count = (sel) => document.querySelectorAll(sel).length;
        const q = (sel) => document.querySelector(sel);
        const rect = (sel) => {
          const el = q(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        };
        const token = (name) => {
          const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
          return v || null;
        };
        const de = document.documentElement;
        return {
          // ---- 计数：UI 骨架是否真的建起来 ----
          activityBar: count(".activity-bar, .activitybar"),
          activityItems: count(".activity-bar .activity-item, .activity-item"),
          sidebar: count(".sidebar"),
          editorTabs: count(".editor-tab, .tab, [data-tab]"),
          editorTabCount: count(".editor-tabs .tab, .editor-tab"),
          panel: count(".panel, .bottom-panel"),
          panelTabs: count(".panel .panel-tab, .panel-tab"),
          statusbar: count(".statusbar, .status-bar"),
          aiPanel: count(".ai-panel"),
          commandPalette: count(".command-palette"),
          problemRows: count(".problem-row, .problems .row"),
          rootChildren: q("#root") ? q("#root").children.length : 0,

          // ---- 几何：区域宽度与位置（判定挤压/溢出）----
          rects: {
            activityBar: rect(".activity-bar, .activitybar"),
            sidebar: rect(".sidebar"),
            editorArea: rect(".editor-area, .editor"),
            auxPanel: rect(".aux-panel, .inspector, .inspector-panel"),
            canvasWrap: rect(".canvas-wrap, .canvas-host, .canvas")
          },

          // ---- 溢出：横向是否真的滚动了 ----
          overflow: {
            scrollWidth: de.scrollWidth,
            clientWidth: de.clientWidth,
            scrollHeight: de.scrollHeight,
            clientHeight: de.clientHeight,
            horizontal: de.scrollWidth > de.clientWidth,
            vertical: de.scrollHeight > de.clientHeight,
            excessX: Math.max(0, de.scrollWidth - de.clientWidth),
            bodyScrollWidth: document.body ? document.body.scrollWidth : 0
          },

          // ---- 主题令牌：直接读 CSS 变量的解析值 ----
          themeTokens: {
            canvasBg: token("--canvas-bg"),
            bg: token("--bg"),
            surface: token("--surface")
          },

          creamStyleLoaded: Array.from(document.styleSheets || []).some((s) => String(s.href || "").includes("cream.css")),
          bodyBg: getComputedStyle(document.body).backgroundColor,
          title: document.title,
          devicePixelRatio: window.devicePixelRatio,
          windowSize: { width: window.innerWidth, height: window.innerHeight }
        };
      })()`,
      true
    );
    return data ?? {};
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/**
 * 依次点击若干选择器（--tap）。
 *
 * 为什么需要：`--shot` 默认只能看到初始视图（底部面板停在「问题」，AI 面板是关的）。
 * 而 AI 助手是本任务的核心交付物，验收必须能截到「它真的在工作」。
 *
 * 三条实现约定：
 *   1. 每次点击后等 250ms：面板重建/首帧布局不在 click 返回时完成，立刻截图会截到半成品；
 *   2. 找不到元素**不判死**（截图照出）：`--tap` 是给验收看内容的，不是断言；
 *      真正的断言留给 `--verify`（且 `--verify` 不跑 tap，见 runShotMode 里的注释）；
 *   3. 用 `el.click()` 而不是模拟鼠标坐标：后者依赖 dpr/缩放，容易点偏。
 *
 * @param {string[]} selectors
 * @returns {Promise<{ok:string[], missing:string[], error?:string}>}
 */
async function tapSelectors(selectors) {
  const ok = [];
  const missing = [];
  for (const selector of selectors) {
    try {
      const result = await mainWindow.webContents.executeJavaScript(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { found: false };
          // 有些自定义控件不在视口里也要能点：先滚到可见，再点。
          try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch {}
          el.click();
          const r = el.getBoundingClientRect();
          return { found: true, tag: el.tagName, cls: String(el.className || "").slice(0, 80),
                   x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        })()`,
        true
      );
      if (result?.found) {
        ok.push(selector);
        console.log(`[tap] 已点击 ${selector} → ${result.tag}.${result.cls} @ ${result.x},${result.y} ${result.w}x${result.h}`);
      } else {
        missing.push(selector);
        console.log(`[tap] 未找到 ${selector}（截图仍会输出）`);
      }
    } catch (e) {
      missing.push(selector);
      console.log(`[tap] 点击 ${selector} 失败：${e?.message || e}（截图仍会输出）`);
    }
    // 等面板重建 + 首帧布局稳定（见上面约定 1）。
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok, missing };
}
function printProbe(skeleton) {
  const r = skeleton.rects ?? {};
  const nameOf = { activityBar: "activityBar", sidebar: "sidebar", editorArea: "editorArea", auxPanel: "auxPanel", canvasWrap: "canvasWrap" };
  for (const [key, label] of Object.entries(nameOf)) {
    const rect = r[key];
    console.log(
      `[probe] 宽度 ${label}: ${rect ? `x=${rect.x} width=${rect.width} height=${rect.height}` : "（未找到该元素）"}`
    );
  }
  const o = skeleton.overflow ?? {};
  console.log(
    `[probe] 溢出: 横向 ${o.horizontal ? `是（超出 ${o.excessX}px）` : "否"} `
    + `· scrollWidth=${o.scrollWidth} clientWidth=${o.clientWidth} `
    + `· 纵向 ${o.vertical ? "是" : "否"}（scrollHeight=${o.scrollHeight} clientHeight=${o.clientHeight}）`
  );
  console.log(
    `[probe] 计数: activity-item=${skeleton.activityItems ?? 0} editor-tab=${skeleton.editorTabCount ?? 0} `
    + `panel-tab=${skeleton.panelTabs ?? 0} ai-panel=${skeleton.aiPanel ?? 0} problem-row=${skeleton.problemRows ?? 0}`
  );
  const t = skeleton.themeTokens ?? {};
  console.log(`[probe] 主题令牌: --canvas-bg=${t.canvasBg ?? "?"} --bg=${t.bg ?? "?"} --surface=${t.surface ?? "?"}`);
  console.log(`[probe] 视口: ${skeleton.windowSize?.width ?? "?"}x${skeleton.windowSize?.height ?? "?"} @ dpr ${skeleton.devicePixelRatio ?? "?"}`);
}

/**
 * 对**当前窗口**做一次「探针 → 截图 → 判定」，返回结构化结论。
 *
 * 抽成函数是为了 --verify 的双尺寸：同一套判定逻辑跑两次（1600x1000 / 1280x720），
 * 而不是复制一份代码 —— 复制出来的第二份一定会和第一份慢慢分叉。
 *
 * @param {object} opts
 * @param {string} opts.target        PNG 路径
 * @param {{width:number,height:number}} opts.want  期望尺寸
 * @param {boolean} [opts.strict]    严格断言（--verify）
 * @param {boolean} [opts.writeProbe] 是否把探针 JSON 落盘
 * @param {string} [opts.tag]        日志前缀（多尺寸时用来区分）
 * @param {string[]} [opts.errors]   页面加载错误
 * @returns {Promise<{ok:boolean, themeOk:boolean, overflowOk:boolean, nonBg:number, stats:object, skeleton:object}>}
 */
async function captureAndJudge(opts) {
  const tag = opts.tag ? `${opts.tag} ` : "";
  const skeleton = await probeUiSkeleton();
  console.log(
    `[shot] ${tag}UI 骨架: activity-bar=${skeleton.activityBar ?? 0} sidebar=${skeleton.sidebar ?? 0} `
    + `editor-tabs=${skeleton.editorTabs ?? 0} panel=${skeleton.panel ?? 0} statusbar=${skeleton.statusbar ?? 0} `
    + `ai-panel=${skeleton.aiPanel ?? 0} palette=${skeleton.commandPalette ?? 0} root=${skeleton.rootChildren ?? 0}`
  );
  console.log(
    `[shot] ${tag}主题样式: cream.css ${skeleton.creamStyleLoaded ? "已加载" : "未加载"} · body 背景 ${skeleton.bodyBg ?? "?"}`
  );

  // ---- 几何探针（--probe 或 --verify 时输出）----
  if (ARGS.probe || ARGS.verify) {
    printProbe(skeleton);
    if (opts.writeProbe && ARGS.probe) {
      try {
        await mkdir(dirname(resolve(ARGS.probe)), { recursive: true });
        await writeFile(resolve(ARGS.probe), JSON.stringify(skeleton, null, 2), "utf8");
        console.log(`[probe] 已写入 ${resolve(ARGS.probe)}`);
      } catch (e) {
        console.error(`[probe] 写入 JSON 失败：${e?.message || e}`);
      }
    }
  }

  const target = resolve(opts.target);
  const want = opts.want;
  await mkdir(dirname(target), { recursive: true });
  let image = await mainWindow.webContents.capturePage();
  // capturePage 按**设备像素**返回，useContentSize 下的取整会让它比要求多 1~2 像素；
  // 验收要的是可复现的固定尺寸，所以只要不精确相等就缩到目标尺寸。
  const size = image.getSize();
  if (size.width !== want.width || size.height !== want.height) {
    image = image.resize({ width: want.width, height: want.height, quality: "best" });
  }
  const png = image.toPNG();
  await writeFile(target, png);
  const stats = analyzePng(png);
  // 结论行：验收脚本可以直接 grep 这一行。
  console.log(`[shot] ${tag}${target}`);
  console.log(`[shot] ${tag}${describePng(stats)}`);

  const theme = assertTheme(stats);
  if (theme.ok) {
    console.log(`[shot] ${tag}主题: ${theme.theme} → PASS（${theme.detail}）`);
  } else {
    console.log(`[shot] ${tag}主题: ${theme.theme === "dark" ? "midnight" : theme.theme} → FAIL（期望奶油）— ${theme.detail}`);
  }

  // ---- 溢出断言（--verify 时横向溢出 = FAIL）----
  // 为什么横向优先级最高：横向溢出意味着有区域被挤出视口且无法滚动看到，
  // 用户视角就是「工具条/按钮不见了」，比纵向溢出严重得多。
  const overflow = skeleton.overflow ?? {};
  const overflowOk = !overflow.horizontal;
  if (ARGS.verify || opts.strict) {
    console.log(
      `[shot] ${tag}布局溢出: 横向 ${overflow.horizontal ? `FAIL（超出 ${overflow.excessX}px）` : "PASS（无横向溢出）"} `
      + `· 纵向 ${overflow.vertical ? `有（${overflow.scrollHeight - overflow.clientHeight}px，可滚动）` : "无"}`
    );
  } else if (overflow.horizontal) {
    console.log(`[shot] ${tag}布局溢出: 横向溢出 ${overflow.excessX}px（--verify 时判 FAIL）`);
  }

  if (opts.errors?.length) {
    console.log(`[shot] ${tag}页面加载有问题：\n  ${opts.errors.join("\n  ")}`);
    console.log(`[shot] ${tag}渲染侧最后几条日志：\n  ${logBuffer.slice(-12).join("\n  ")}`);
  }

  // 判定：页面真的加载成功 + 不是空白 +（严格模式）主题是奶油 + 无横向溢出 + 非背景像素在合理区间。
  //
  // 为什么非背景占比要**双边**断言（踩过的推理）：
  //   单边下界只能防「界面没起来」（只剩底栏 → 前景几个百分点），
  //   防不了「渲染退化成噪点/纯色块」（前景接近 100%，看起来"内容很多"其实什么都没画对）。
  //   双边后两类失败都能拦住：
  //     下界 20%  —— 低于这个说明编辑器主体没渲染出来；
  //     上界 92%  —— 高于这个说明底色被填满（正常界面总有大量统一的面板底色）。
  //   实测两个验收尺寸都落在 65%~70%，留足余量，不会因主题微调而误报。
  const strict = Boolean(opts.strict);
  const loaded = pageState.finished && opts.errors?.length === 0;
  const NONBG_MIN = 0.2;
  const NONBG_MAX = 0.92;
  const contentOk = stats.foregroundRatio > NONBG_MIN && stats.foregroundRatio < NONBG_MAX;
  // 失败时明确指出撞了哪一边：撞下限=界面没起来，撞上限=渲染成色块，两者修法完全不同。
  const contentHint = contentOk
    ? ""
    : stats.foregroundRatio <= NONBG_MIN
      ? `撞下限(<${NONBG_MIN * 100}%：编辑器主体没渲染出来)`
      : `撞上限(>${NONBG_MAX * 100}%：底色没铺开/渲染成色块)`;
  const ok =
    loaded
    && !stats.isEmpty
    && (!strict || theme.ok)
    && (!strict || overflowOk)
    && (!strict || contentOk);
  console.log(
    `[shot] ${tag}result=${ok ? "OK" : "FAIL"} loaded=${loaded} empty=${stats.isEmpty} errors=${opts.errors?.length ?? 0} `
    + `nonbg=${(stats.foregroundRatio * 100).toFixed(1)}% theme=${theme.theme}`
    + (strict
      ? `（严格断言：主题 ${theme.ok ? "PASS" : "FAIL"} · 横向溢出 ${overflowOk ? "PASS" : "FAIL"} · `
        + `非背景 ${contentOk ? "PASS" : `FAIL ${contentHint}`}（区间 ${NONBG_MIN * 100}~${NONBG_MAX * 100}%））`
      : "（截图模式；--verify 会额外断言主题、横向溢出与非背景占比）")
  );
  return {
    ok,
    themeOk: theme.ok,
    overflowOk,
    enoughContent: contentOk,
    contentHint,
    nonBg: stats.foregroundRatio,
    // 失败是否为「疑似首帧未渲染」这类可重试的偶发问题：
    //   空白截图（页面 JS 没跑起来 → 只剩底色）或主题撞深色（CSS 没加载 → 窗口默认底色），
    //   两者都是"页面没渲染好"，不是"界面真的长这样"，重试一次通常就正常。
    // 注意：重试只治症状，治根靠独立 userData + 禁用磁盘缓存（见 USER_DATA_DIR 注释）。
    retryable: stats.isEmpty || !theme.ok,
    stats,
    skeleton
  };
}
/**
 * --shot：等页面 ready（did-finish-load + 2s 让首屏动画/布局稳定）→ capturePage → 存 PNG。
 *
 * 五条「必须可靠」的实现细节：
 *   1. 页面加载失败时打印 did-fail-load 原因与渲染侧 console，**并且仍然出图**（把失败现场留下）
 *      —— 但不许 exit 0，否则验收只看退出码会以为一切正常；
 *   2. capturePage 按设备像素返回，所以截图模式强制 dpr=1，窗口内容区就是目标像素；
 *   3. 出图后打印「尺寸 + 颜色数 + 非背景像素占比 + 主色亮度」，这是可判定的数字；
 *   4. **主题断言**：主色亮度 < 0.35 判深色 → 严格模式直接 FAIL。
 *      人眼「看着不太对」不可靠，一个阈值才拦得住以后主题被改坏；
 *   5. **--verify 跑双尺寸**（1600x1000 + 1280x720）：
 *      1280x720 是本次交付明写的最低验收尺寸，而**溢出类缺陷只在窄屏暴露**。
 *      只截 1600x1000 会让窄屏回归漏过去，所以两个尺寸都要断言。
 */
async function runShotMode() {
  let waited = 0;
  while (!pageState.finished && waited < 25000) {
    await new Promise((r) => setTimeout(r, 250));
    waited += 250;
  }
  const errors = pageState.failures.filter((f) => f.isMainFrame).map((f) => `did-fail-load ${f.code} ${f.desc} ${f.url}`);

  // 等 2s：页面首屏的布局/字体/示例工程加载都不一定在 did-finish-load 时结束。
  await new Promise((r) => setTimeout(r, 2000));

  // ---- --tap：截图前依次点击（用来打开非默认标签，例如「AI 助手」）----
  // ⚠ --verify 不跑 tap：打包自检要判「干净默认视图」的健康状况，
  // 如果 tap 把界面切到别的标签，主题/溢出的判定对象就变了，失败原因也会被误读。
  const taps = ARGS.tap ? String(ARGS.tap).split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (taps.length) {
    if (ARGS.verify) {
      console.log("[tap] --verify 模式忽略 --tap（自检只跑默认视图）");
    } else {
      await tapSelectors(taps);
      // tap 之后再等一小会儿，让点击触发的异步渲染（面板内容、首屏动画）落定。
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  try {
    if (!ARGS.verify) {
      // 单尺寸截图（开发/验收看图用）
      const result = await captureAndJudge({
        target: ARGS.shot,
        want: ARGS.size ?? DEFAULT_SHOT_SIZE,
        strict: false,
        writeProbe: true,
        errors
      });
      app.exit(result.ok ? 0 : 3);
      return;
    }

    // ---- --verify：两个尺寸都断言，任一失败即整体失败 ----
    const SIZES = [
      { width: 1600, height: 1000, label: "1600x1000" },
      { width: 1280, height: 720, label: "1280x720" }
    ];
    const results = [];
    for (const [index, size] of SIZES.entries()) {
      if (index > 0) {
        // 换尺寸：改内容区尺寸后必须等一次重排（媒体查询 + 面板自适应都在这一帧发生）。
        // 600ms 比 250ms 稳：窄屏下侧栏折叠/工具条换行是两段动画。
        mainWindow.setContentSize(size.width, size.height);
        await new Promise((r) => setTimeout(r, 600));
      }
      // 第一个尺寸是窗口初始尺寸；后续尺寸已通过 setContentSize 改过。
      const target = size.label === (ARGS.size ? `${ARGS.size.width}x${ARGS.size.height}` : "1600x1000")
        ? ARGS.shot
        : `${ARGS.shot.replace(/\.png$/i, "")}-${size.label}.png`;
      let verdict = await captureAndJudge({
        target,
        want: { width: size.width, height: size.height },
        strict: true,
        writeProbe: index === 0,
        tag: `[${size.label}]`,
        errors
      });

      // ---- 偶发首帧未渲染 → 重排 + 等更久 + 再截一次 ----
      // 只针对「疑似渲染没完成」（空白 / 主题撞深色），且只重试一次：
      // 这是兜底，不是掩盖问题 —— 若重试仍然失败，会照常判死并在日志里留下两次的值。
      if (!verdict.ok && verdict.retryable) {
        const firstNonBg = (verdict.nonBg * 100).toFixed(1);
        console.log(
          `[verify] ${size.label} 首次${verdict.stats.isEmpty ? "空白" : "疑似未渲染"}（nonbg=${firstNonBg}%）`
          + ` → 重排后重试一次`
        );
        mainWindow.setContentSize(size.width, size.height);
        await new Promise((r) => setTimeout(r, 800));
        const retried = await captureAndJudge({
          target,
          want: { width: size.width, height: size.height },
          strict: true,
          writeProbe: false,
          tag: `[${size.label}:retry]`,
          errors
        });
        if (retried.ok) {
          console.log(`[verify] ${size.label} 重试 → nonbg=${(retried.nonBg * 100).toFixed(1)}% → PASS`);
        } else {
          console.log(
            `[verify] ${size.label} 重试仍失败（nonbg=${(retried.nonBg * 100).toFixed(1)}%，`
            + `首次 ${firstNonBg}%）—— 判定为真实失败，不是偶发`
          );
        }
        verdict = retried;
      }

      results.push({ size, ...verdict });
      console.log(
        `[verify] ${size.label} → theme=${verdict.themeOk ? "PASS" : "FAIL"} `
        + `overflow=${verdict.overflowOk ? "PASS" : "FAIL"} `
        + `nonbg=${(verdict.nonBg * 100).toFixed(1)}%（区间 20~92 → ${verdict.enoughContent ? "PASS" : `FAIL ${verdict.contentHint}`}） `
        + `→ ${verdict.ok ? "PASS" : "FAIL"}`
      );
    }

    const passed = results.filter((r) => r.ok).length;
    const allOk = passed === results.length;
    const failed = results.filter((r) => !r.ok).map((r) => r.size.label);
    console.log(
      `[verify] 结论：${allOk ? "PASS" : "FAIL"}（${passed}/${results.length} 尺寸）`
      + (failed.length ? ` · 未通过：${failed.join(", ")}` : "")
    );
    app.exit(allOk ? 0 : 3);
  } catch (e) {
    console.error(`[shot] 截图失败：${e?.stack || e?.message || e}`);
    app.exit(4);
  }
}
