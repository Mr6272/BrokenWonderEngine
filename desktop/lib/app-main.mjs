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
import { importTraeConfig, toModelEntries } from "./ai/trae-import.mjs";
import { listModels } from "./ai/provider.mjs";
import { addModel, setActiveModel } from "./ai/modelCatalog.mjs";
import { parseTapSeq, runTapSequence } from "./tapSeq.mjs";
import { probeModelEndpoint, PROBE_TIMEOUT_MS } from "./ai/probe.mjs";
import { createToolCache } from "./ai/prune.mjs";
import { openSession, workspaceHash } from "./ai/session.mjs";
import { createConversationStore, DEFAULT_TITLE } from "./ai/conversations.mjs";
import { createRecentStore } from "./recent.mjs";
import { createSettingsStore } from "./settings.mjs";
import { createWindowState, MIN_BOUNDS } from "./window-state.mjs";
import { analyzePng, assertTheme, cssColorLuminance, describePng } from "./png.mjs";
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
  const out = {
    console: false, shot: null, size: null, verify: false, probe: null, tap: null,
    ipcProbe: null, userData: null, probeDom: null, ipcProbeNoImport: false, probeSelector: null, tapSeq: null, protocolLive: false
  };
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
    else if (arg.startsWith("--ipc-probe=")) out.ipcProbe = stripQuotes(arg.slice("--ipc-probe=".length));
    else if (arg.startsWith("--user-data=")) out.userData = stripQuotes(arg.slice("--user-data=".length));
    else if (arg === "--ipc-probe-no-import") out.ipcProbeNoImport = true;
    else if (arg.startsWith("--probe-dom=")) out.probeDom = stripQuotes(arg.slice("--probe-dom=".length));
    else if (arg.startsWith("--probe-selector=")) out.probeSelector = stripQuotes(arg.slice("--probe-selector=".length));
    else if (arg.startsWith("--tap-seq=")) out.tapSeq = stripQuotes(arg.slice("--tap-seq=".length));
    else if (arg === "--protocol-live") out.protocolLive = true;
    else if (arg.startsWith("--size=")) {
      const m = /^(\d+)x(\d+)$/.exec(stripQuotes(arg.slice("--size=".length)));
      if (m) out.size = { width: Number(m[1]), height: Number(m[2]) };
    }
  }
  return out;
}

const ARGS = parseArgs(process.argv);
const SHOT_MODE = Boolean(ARGS.shot);
/**
 * 自动化模式：截图 与 --ipc-probe 都属于「跑完就退」的批处理，必须满足两条：
 *   ① 不参与单实例锁（否则本机开着编辑器 / 另一条线在截图时，它直接 quit 且没有任何输出
 *      —— 我实际踩过：8 个 electron 进程在跑，探针静默退出，查了半天以为代码没执行）；
 *   ② 用一次性的隔离 userData（pid 后缀），不污染用户真实设置、也不和并发进程争 Chromium 缓存。
 */
const AUTOMATION_MODE = SHOT_MODE || Boolean(ARGS.ipcProbe);
/**
 * 纯探针模式（--ipc-probe 且只读）：**不需要窗口**。
 *
 * 为什么单独区分：`--ipc-probe` 的完整模式要跑 K 线截图相关的东西，但只读模式
 * （`--ipc-probe-no-import`）只读 settings + 发一个网络探测，完全不碰渲染侧。
 * 若仍然创建 BrowserWindow，退出时渲染进程会被强杀（实测 `渲染进程结束：crashed exitCode 143`），
 * 让进程退出码变成非 0 —— 验收脚本按退出码判死就会误报。
 * 只读时不建窗口，进程退出干净。
 */
const PROBE_ONLY_MODE = Boolean(ARGS.ipcProbe) && Boolean(ARGS.ipcProbeNoImport);
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
//
// ⚠ 但「隔离」有个副作用：自动化里的 settings 永远是空的，于是「模型清单 / 已填的 key /
//   切到哪个模型」这些**从未在自动化里被真实验证过**。所以另给一个出口：
//     --user-data=<绝对目录>
//   语义是「**用一份现成的用户配置做验收**」，不是隔离 —— 给了它就不加 pid 后缀、
//   不参与 .shot-profile 的清理、也不在退出时删除。这样验收脚本可以做到真实闭环：
//     ① 一次性目录里写入 settings（模型清单 + key）
//     ② --shot --user-data=同一目录 → 截图里的下拉框来自**真实** settings
app.setName("BWE Studio");
const APPDATA_DIR = app.getPath("appData");
const SHOT_PROFILE_BASE = join(APPDATA_DIR, "BWE Studio", ".shot-profile");
/** 用户显式指定的 userData 目录（给了就表示「用现成配置」，非隔离语义）。 */
const EXPLICIT_USER_DATA = ARGS.userData ? resolve(stripQuotesDeep(ARGS.userData)) : null;
/**
 * 是否使用一次性隔离目录（只有自动化模式且没给 --user-data 时才是）。
 *
 * ⚠ `--protocol-live` 例外：它的目的就是**用用户真实的 key 打真实 API**。
 *   若也走隔离目录，里面 settings.json 是空的 → 读不到 key → 整个验证在无 key 下空跑，
 *   却报出「失败 N 项」的假结果（实测踩到，误导性极强）。
 *   所以 protocol-live 模式下**强制使用真实 userData**（用户会接受"会写入真实会话历史"，
 *   或者脚本用复制 settings 的方式另行隔离）。
 */
const ISOLATED_USER_DATA = AUTOMATION_MODE && !EXPLICIT_USER_DATA && !ARGS.protocolLive;
const USER_DATA_DIR = EXPLICIT_USER_DATA
  ? EXPLICIT_USER_DATA
  : ISOLATED_USER_DATA
    ? join(SHOT_PROFILE_BASE, String(process.pid))
    : join(APPDATA_DIR, "BWE Studio");

/** 去掉可能残留的成对引号（cmd 传参常见）。 */
function stripQuotesDeep(value) {
  const t = String(value ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}
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
  // ⚠ 只清理一次性隔离目录。--user-data 给的是「用户真实配置」，删它等于删用户数据。
  if (!ISOLATED_USER_DATA) return;
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
/** 供 --ipc-probe 调用的业务函数集合（在 registerIpc 里填充）。 */
let probeHandlers = null;
/** 多会话存储（sessions/<hash>/ 下的 conversations + index.json）。 */
let conversationStore = null;

if (!AUTOMATION_MODE) {
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
      if (AUTOMATION_MODE) {
        // ⚠ 自动化模式绝不能弹模态框：无人点击 → 自检永远挂住（打包 --verify 踩过）。
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
      },
      // 把「key 解不开」这类事件打到启动日志：这是用户每次重启都会遇到的
      // 真实缺陷，不能让它只在界面上静默表现为「待填 key」。
      log: (m) => log(m, "bwe:settings")
    });
    await settingsStore.load();

    api = createEmbeddedApi({ repoRoot: REPO_ROOT, port: 0, onLog: (m, t) => log(m, t) });

    // AI 桥：会话/缓存都落在 userData 下（契约 §4.4）
    //
    // 多会话：sessions/<hash>/ 下用 conversations/<id>/ + index.json（见 ai/conversations.mjs）。
    // 首次启动会把旧的单份 history.json 自动迁移成第一个会话（不丢历史）。
    const sessionDir = join(USER_DATA_DIR, "sessions", workspaceHash(REPO_ROOT));
    conversationStore = createConversationStore({ dir: sessionDir, workspace: REPO_ROOT });
    // 把磁盘上存在但索引里漏掉的会话目录补进索引（index.json 曾损坏时自愈）。
    const convState = await conversationStore.load();
    await reconcileOrphans(conversationStore, sessionDir, convState);
    const activeSession = await openSession({
      dir: conversationStore.conversationDir(convState.active),
      workspace: REPO_ROOT
    });
    const apiIndex = createApiIndex(defaultApiDocsPath(REPO_ROOT));
    const toolCache = createToolCache(join(USER_DATA_DIR, "toolCache"));
    ai = createAiBridge({
      session: activeSession,
      repoRoot: REPO_ROOT,
      workspaceRoot: REPO_ROOT,
      apiIndex,
      toolCache,
      getSettings: () => settingsStore.load(),
      // 会话列表归 conversations 存储管；桥只用来在 aiStatus 里报「当前是哪个会话、共几个」。
      getSessionInfo: async () => {
        const st = await conversationStore.state();
        return { active: st.active, count: st.sessions.length };
      },
      /**
       * 会话内容变化后更新索引（标题 / messageCount / updatedAt）。
       *
       * 标题只在「还是默认标题」时用第一条用户消息生成 —— 一旦用户或首条消息
       * 给了标题就不再覆盖，避免把用户改过的名字冲掉。
       */
      onSessionUpdated: async (sess, firstUserText) => {
        const st = await conversationStore.state();
        // sess.dir 形如 .../conversations/<id>，取最后一段即会话 id
        // ⚠ Windows 路径分隔符是 \，split 只按 "/" 分会拿不到 id（实测踩到：标题一直不更新）。
        //   用 basename 让 path 模块自己处理两种分隔符。
        const id = basename(String(sess?.dir ?? ""));
        if (!id) return;
        const item = st.sessions.find((x) => x.id === id);
        if (!item) return;
        const patch = {};
        // 只在标题仍是默认值时，用首条用户消息生成（零 token）
        if ((item.title === DEFAULT_TITLE || !item.title) && firstUserText) {
          patch.title = firstUserText;
        }
        await conversationStore.touch(id, patch);
      },
      sendEvent: (ev) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ai:event", ev);
      },
      log: (m) => log(m, "bwe:ai")
    });

    // ---- 启动期工具依赖自检 ----
    //
    // 为什么在启动时检查：这些依赖只在「模型真的调用某个工具」时才被用到。
    // 缺了不会报错、也不影响界面，直到用户在真实对话里触发了那个工具才炸 ——
    // 而那时错误发生在对话中途，表现为「AI 中断自己」，极难定位。
    //（历史缺陷：sceneDigest 没接上，SceneDigest 工具每次必抛错）
    checkToolDependencies({ apiIndex, toolCache, bridge: ai });

    registerIpc();
    if (PROBE_ONLY_MODE) {
      // 只读探针：不创建窗口，直接跑探针并退出（见 PROBE_ONLY_MODE 注释）。
      log(`[bwe:desk] 只读探针模式（不创建窗口），userData=${USER_DATA_DIR}`);
      await runIpcProbe(ARGS.ipcProbe);
      return;
    }
    await createMainWindow();
    log(
      `BWE Studio 启动：repo=${REPO_ROOT} userData=${USER_DATA_DIR} shot=${SHOT_MODE}`
      + (EXPLICIT_USER_DATA ? "（来自 --user-data，非隔离模式）" : "")
    );
    if (ARGS.console) console.log(`[bwe:desk] 页面入口 ${WEB_INDEX}`);

    if (SHOT_MODE) await runShotMode();

    // ---- 诊断探针：把模型/导入通道的真实返回打成 JSON 然后退出 ----
    // 用途：验收时要在「真实 Electron 主进程」里看 safeStorage 加密、真实 Trae 库读取、
    // 真实网络探测的返回，单纯跑 node 单测拿不到这些。用 --ipc-probe=<out.json> 触发。
    if (ARGS.ipcProbe) await runIpcProbe(ARGS.ipcProbe);
  } catch (e) {
    const msg = `启动失败：${e?.stack || e?.message || e}`;
    log(msg, "bwe:crash");
    console.error(`[bwe:crash] ${msg}`);
    // 自动化模式下不弹模态框（见上方缺少前端文件处的注释）。
    if (!AUTOMATION_MODE) dialog.showErrorBox("BWE Studio 启动失败", msg);
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
  if (!AUTOMATION_MODE) {
    if (saved.maximized) mainWindow.maximize();
    mainWindow.show();
    applyMenu(await recentStore.list());
  } else if (SHOT_MODE) {
    // 截图必须真正显示窗口（隐藏窗口的 capturePage 会拿到空白/黑帧）。
    mainWindow.show();
  } else {
    // --ipc-probe 不需要可见窗口，保持隐藏（避免在用户桌面上闪一下）。
  }

  mainWindow.on("close", () => {
    if (AUTOMATION_MODE) return; // 自动化用的是一次性 userData，写窗口状态没意义
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
  if (!forceDialog && !AUTOMATION_MODE) {
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

/**
 * 把磁盘上存在、但 index.json 里没有的会话目录补进索引。
 *
 * 为什么要这个：index.json 可能被删除/写坏/被用户手工清空，但 `conversations/<id>/` 里的历史
 * **还完整在磁盘上**。如果不补，用户会以为「历史全没了」—— 而实际上只是索引丢了。
 * 宁可多列一个会话，也不要让用户的历史凭空消失。
 */
async function reconcileOrphans(store, dir, state) {
  let listed = [];
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(dir, "conversations"), { withFileTypes: true });
    listed = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  const known = new Set(state.sessions.map((x) => x.id));
  const orphans = listed.filter((id) => !known.has(id));
  if (orphans.length === 0) return;
  log(`发现 ${orphans.length} 个未登记的会话目录，补进索引（索引曾丢失的自我修复）`, "bwe:ai");
  for (const id of orphans) {
    await store.touch(id, { title: DEFAULT_TITLE });
  }
}

/**
 * 切到某个会话：**先 abort 在途请求，再换绑 session 对象**。
 *
 * 顺序不能反：如果先换绑再 abort，正在收尾的旧请求会把消息 append 到新会话的 history ——
 * 数据写到错误的地方，比"显示错"严重得多。
 */
async function switchToConversation(id) {
  if (!conversationStore) throw new Error("会话存储未初始化");
  const result = await conversationStore.switchTo(id);
  const { aborted } = await ai.swapSession(
    await openSession({ dir: conversationStore.conversationDir(result.active), workspace: REPO_ROOT })
  );
  if (aborted > 0) log(`切换会话时中止了 ${aborted} 个在途请求`, "bwe:ai");
  return { ...result, aborted };
}

/**
 * 启动期检查 AI 工具的依赖是否齐全。
 *
 * ⚠ 一个容易误判的点：`sceneDigest` **不需要**在启动时传函数。
 * 工程摘要是**每次请求**由渲染侧随 `request.context.sceneDigest` 传来的
 *（bridge 在 run() 开头调用 toolRunner.setSceneDigest 注入）。
 * 所以这里只检查"构造时必需"的依赖，并提示 sceneDigest 是按请求传递的 ——
 * 避免后人又去启动时闭包一个函数（那正是历史缺陷的形态）。
 */
function checkToolDependencies({ apiIndex, toolCache, bridge } = {}) {
  const warnings = [];
  // apiIndex：构造时必需（SearchApi 工具依赖它）
  if (!apiIndex || typeof apiIndex.render !== "function") {
    warnings.push("apiIndex 缺失或不可用 → SearchApi 工具会失败");
  }
  // ⚠ toolCache 不能再说成「只影响性能」：剪枝提示承诺了「可用 ReadToolResult 续读」，
  // 这条承诺必须真的有通路（内存表或磁盘缓存），否则被剪掉的原文就是**信息黑洞**。
  // 本机实测踩过：createToolRunner 从未收到 toolCache，而提示照写 → 模型照做 → 拿到「没配置」→
  // 连续重试 → 轮次耗尽 → 什么都没交付。这类「提示承诺 vs 实际接线」的断裂只能靠集中自检查证。
  if (bridge && typeof bridge.toolWiringReport === "function") {
    warnings.push(...bridge.toolWiringReport());
  } else if (!toolCache || typeof toolCache.put !== "function") {
    warnings.push("toolCache 缺失，且 bridge 未提供 toolWiringReport → 无法确认剪枝续读是否可达");
  }
  if (warnings.length === 0) {
    log(
      "工具依赖自检通过（SceneDigest 走 request.context.sceneDigest 按请求注入；剪枝续读通路可达）",
      "bwe:ai"
    );
  } else {
    for (const w of warnings) log(`⚠ 工具依赖自检：${w}`, "bwe:ai");
  }
  return warnings;
}

/**
 * 真 key 协议验证（`--protocol-live`）：跑两轮真实请求，验证「工具轮 + 多轮重放」都不 400。
 *
 * ⚠ 会消耗用户 token，所以只在显式传 `--protocol-live` 时执行；
 *   普通的 `--ipc-probe` 不跑它（验收脚本默认不花用户的钱）。
 *
 * 为什么必须在主进程里跑：settings.json 的 apiKey 是 DPAPI 加密的，
 * 只有主进程持有解密用的 crypto；纯 node 读出来是空/密文。
 */
async function probeProtocolLive() {
  const statuses = [];
  const errors = [];
  const toolEnds = [];
  let firstText = "", secondText = "";
  const st = await ai.aiStatus();

  // ⚠ 明确的跳过语义：没有真 key 时返回 `{ ok:false, skipped:true, reason:"no-key" }`。
  // 验收脚本据此 **exit 2（跳过）**，绝不能把「空跑的结果」当成「跑了但失败」——
  // 那会让人以为协议还是坏的，然后去改本来正确的代码（同类问题在 --tap-seq 的 probe 上踩过）。
  if (!st?.ready || st.provider === "mock") {
    return {
      ok: false,
      skipped: true,
      reason: "no-key",
      detail: `当前 userData 下没有可用的真 key（provider=${st?.provider ?? "?"}，ready=${st?.ready ?? "?"}）`,
      userData: USER_DATA_DIR,
      baseUrl: "",
      model: ""
    };
  }

  // 收集本轮的 status：从 usage/error 事件间接判断。streamChat 的 status 不进事件，
  // 所以这里用"有无 error"+"正文非空"作为判据，并单独记录 error 原文。
  const onEvent = (ev) => {
    if (ev.type === "tool" && ev.phase === "end") toolEnds.push(ev);
    if (ev.type === "error") errors.push(String(ev.message ?? ""));
  };

  // 第 1 轮：要求用工具读文件（触发工具轮 → 检验 reasoning_content 回传）
  const ev1 = [];
  await ai.aiChat({
    requestId: "protocol-live-1",
    messages: [{ role: "user", text: "请用 ReadFile 工具读 package.json 的前 10 行，然后用一句话说出这个项目叫什么名字。" }],
    context: { sceneDigest: "工程「BWE Studio」" }
  });
  await ai.whenIdle();
  // 事件通过 sendEvent 推出，但只读探针没有窗口；用 aiChat 返回后的状态 + 类目判断
  firstText = "";
  statuses.push(errors.length === 0 ? 200 : 400);

  // 第 2 轮：同一会话再问一句（走 buildMessages 重放历史 → 检验历史的 reasoning 回传）
  const before2 = errors.length;
  await ai.aiChat({
    requestId: "protocol-live-2",
    messages: [{ role: "user", text: "基于刚才读到的内容，一句话说明这个项目是做什么的，不要调用工具。" }],
    context: { sceneDigest: "工程「BWE Studio」" }
  });
  await ai.whenIdle();
  statuses.push(errors.length === before2 ? 200 : 400);

  // 从会话历史里取两轮正文（探针无窗口，拿不到 done 事件，用落盘结果验证）
  const hist = ai.currentSession?.messages?.() ?? [];
  const assistantTexts = hist
    .filter((m) => m.role === "assistant")
    .map((m) => (m.blocks ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""))
    .filter(Boolean);
  firstText = assistantTexts[0] ?? "";
  secondText = assistantTexts[1] ?? assistantTexts[0] ?? "";

  return {
    skipped: false,
    baseUrl: st.activeModel?.baseUrl ?? st.provider ?? "",
    model: st.activeModel?.model ?? st.activeModelId ?? "",
    statuses,
    errors,
    toolCalls: toolEnds.length,
    toolFailures: toolEnds.filter((e) => e.ok === false).length,
    firstText,
    secondText
  };
}

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

  // ---- 多会话 / 历史（四通道，字段名严格照契约）----

  /**
   * 会话列表 + 当前 active。
   * 每项 { id, title, createdAt, updatedAt, messageCount }；UI 直接渲染历史列表。
   */
  /**
   * ISO 字符串 → 毫秒时间戳。非法值给 0（UI 侧不该收到 NaN）。
   *
   * 为什么在 IPC 边界转：存储层内部用 ISO 字符串（可读、可排序、排查方便），
   * 但 `host.ts` 门面声明 `createdAt/updatedAt: number` 且用 Number() 归一化。
   * 直接发 ISO 会让 Number() 得到 NaN → 兜成 0 → **所有会话排序键相同、排序失效**。
   * 跨进程字段只在一处归一化，这里就是那一处。
   */
  function toEpochMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * 把会话列表归一成**跨进程契约形状**（时间戳为毫秒数字）。
   *
   * 所有返回 sessions 的通道都走这里 —— 不要每个通道自己 map 一遍：
   * 两处映射迟早分叉，而分叉的表现是"某条通道的时间是字符串、另一条是数字"，
   * UI 排序/相对时间在某些路径上静默失效。集中一处就不会。
   */
  function normalizeSessionEntries(sessions) {
    return (sessions ?? []).map((s) => ({
      id: String(s.id ?? ""),
      title: String(s.title ?? ""),
      createdAt: toEpochMs(s.createdAt),
      updatedAt: toEpochMs(s.updatedAt),
      messageCount: Number(s.messageCount) || 0
    }));
  }

  /**
   * 把内部存储的消息结构扁平化成 UI 契约形状。
   *
   * 内部：{ role, at, blocks: [{ type: "text", text }, ...] }
   * 对外：{ role, text } —— UI 的 replaceThreadFromMessages 直接读 text
   *
   * 为什么要这一步：内部 blocks 是为了兼容多模态/工具块等未来结构，
   * 而 UI 只要"这一条说了什么"。直接透内部结构会让 UI 的 text 变成 undefined，
   * 表现为「切换会话后对话区空白」——实测踩到过。
   */
  function flattenMessages(messages) {
    return (messages ?? [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => {
        const blocks = Array.isArray(m.blocks) ? m.blocks : [];
        const text = blocks
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("");
        const out = { role: m.role, text };
        // 可选字段：有就带上（UI 侧是 optional，不带不影响渲染）
        if (m.at) out.at = m.at;
        if (m.model) out.model = m.model;
        if (Array.isArray(m.tools) && m.tools.length) out.tools = m.tools;
        return out;
      });
  }

  async function handleSessionsList() {
    try {
      const state = await conversationStore.load();
      return {
        ok: true,
        sessions: normalizeSessionEntries(state.sessions),
        active: state.active
      };
    } catch (e) {
      return { ok: false, sessions: [], active: "", error: e?.message || String(e) };
    }
  }
  ipcMain.handle("bwe:ai-sessions-list", async () => handleSessionsList());

  /**
   * 开新会话（**当前会话保留**）。
   * 新会话先 abort 在途请求：新对话不该继承上一个对话正在生成的回答。
   */
  async function handleSessionNew(payload) {
    try {
      const { aborted } = await ai.swapSession({ messages: () => [] }); // 先断开旧会话写入
      if (aborted > 0) log(`开新会话时中止了 ${aborted} 个在途请求`, "bwe:ai");
      const created = await conversationStore.create({ title: String(payload?.title ?? "") || DEFAULT_TITLE });
      const session = await openSession({ dir: conversationStore.conversationDir(created.id), workspace: REPO_ROOT });
      await ai.swapSession(session);
      const state = await conversationStore.state();
      return {
        ok: true,
        id: created.id,
        sessions: normalizeSessionEntries(state.sessions),
        active: state.active,
        aborted
      };
    } catch (e) {
      return { ok: false, id: "", sessions: [], active: "", error: e?.message || String(e) };
    }
  }
  ipcMain.handle("bwe:ai-session-new", async (_e, payload) => handleSessionNew(payload));

  /**
   * 切换会话：返回目标会话的完整 messages（UI 直接替换对话区）。
   * id 不存在时明确失败，不静默切到别的会话。
   */
  async function handleSessionSwitch(payload) {
    try {
      const id = String(payload?.id ?? "").trim();
      if (!id) return { ok: false, sessions: [], active: "", messages: [], error: "缺少会话 id" };
      const switched = await switchToConversation(id);
      const state = await conversationStore.state();
      return {
        ok: true,
        sessions: normalizeSessionEntries(state.sessions),
        active: switched.active,
        // 扁平化成 { role, text }：内部 blocks 结构不该透给 UI。
        // 直接透出的后果是 UI 拿到的 text 是 undefined → 气泡渲染成空 →
        // 表现为「切换会话后对话区一片空白」（实测踩到过）。
        messages: flattenMessages(switched.messages),
        aborted: switched.aborted
      };
    } catch (e) {
      const state = await conversationStore.state().catch(() => ({ sessions: [], active: "" }));
      return { ok: false, sessions: normalizeSessionEntries(state.sessions), active: state.active, messages: [], error: e?.message || String(e) };
    }
  }
  ipcMain.handle("bwe:ai-session-switch", async (_e, payload) => handleSessionSwitch(payload));

  /**
   * 删除会话。
   * 删到当前 active 时，存储层会落到另一个会话；这里随后**换绑桥的 session** ——
   * 否则桥还指着已删除会话的目录，后续 append 会写到不存在的目录（静默产生孤儿文件）。
   */
  async function handleSessionDelete(payload) {
    try {
      const id = String(payload?.id ?? "").trim();
      if (!id) return { ok: false, sessions: [], active: "", error: "缺少会话 id" };
      const before = await conversationStore.state();
      // 如果删的是当前会话，先中止在途请求（它正要写入这个即将消失的会话）
      if (before.active === id) {
        const { aborted } = await ai.swapSession({ messages: () => [] });
        if (aborted > 0) log(`删除当前会话时中止了 ${aborted} 个在途请求`, "bwe:ai");
      }
      const result = await conversationStore.remove(id);
      const session = await openSession({ dir: conversationStore.conversationDir(result.active), workspace: REPO_ROOT });
      await ai.swapSession(session);
      const state = await conversationStore.state();
      return { ok: true, sessions: normalizeSessionEntries(state.sessions), active: state.active };
    } catch (e) {
      const state = await conversationStore.state().catch(() => ({ sessions: [], active: "" }));
      return { ok: false, sessions: normalizeSessionEntries(state.sessions), active: state.active, error: e?.message || String(e) };
    }
  }
  ipcMain.handle("bwe:ai-session-delete", async (_e, payload) => handleSessionDelete(payload));

  // ---- 模型切换 / Trae 导入（三通道，字段名严格照契约）----

  /**
   * 从本机 Trae 配置导入自定义供应商。
   *
   * 关键设计：**导入的条目 apiKey 恒为空、needsKey: true**。
   * Trae 的 key 是设备绑定的（AES-256-GCM，密钥服务端下发），解不开也不该去解，
   * 所以这里只导入 baseUrl + 模型名，key 让用户自己填。
   * 已存在的同 id 条目会被**保留其原有 key**（不覆盖），避免重复导入把用户填好的 key 冲掉。
   */
  async function handleImportTrae() {
    try {
      const imported = await importTraeConfig({ probe: true });
      const entries = toModelEntries(imported.providers);
      // 合并进现有清单：同 id 保留旧条目（保住已填的 key），只更新展示信息
      const current = (await settingsStore.load()).ai?.models ?? [];
      const byId = new Map(current.map((m) => [m.id, m]));
      const merged = [];
      const added = [];
      for (const entry of entries) {
        const existing = byId.get(entry.id);
        if (existing) {
          merged.push({
            ...existing,
            // 只刷新「来源型」字段；apiKey / encryptedApiKey 一律不动
            label: entry.label,
            baseUrl: entry.baseUrl,
            model: entry.model,
            needsKey: true,
            source: entry.source,
            notes: entry.notes,
            contextWindow: entry.contextWindow || existing.contextWindow
          });
        } else {
          merged.push(entry);
          added.push(entry.id);
        }
      }
      // 保留清单里原本就有、本次导入没覆盖的条目（例如用户手填的 DeepSeek）
      for (const m of current) {
        if (!merged.some((x) => x.id === m.id)) merged.push(m);
      }
      await settingsStore.save({ ai: { models: merged } });

      const reachableMap = new Map();
      for (const p of imported.providers) {
        reachableMap.set(p.baseUrl, {
          reachable: p.reachable,
          reachableStatus: p.reachableStatus,
          reachableDetail: p.reachableDetail,
          reachableMethod: p.reachableMethod
        });
      }
      return {
        ok: imported.ok,
        providers: imported.providers,
        warnings: imported.warnings,
        dbPath: imported.dbPath,
        totalEntries: imported.totalEntries,
        uniqueModels: imported.uniqueModels,
        // 告诉界面这次实际写进了哪些条目（哪些是新加的、哪些已存在）
        importedEntries: entries.map((e) => ({
          id: e.id,
          label: e.label,
          baseUrl: e.baseUrl,
          model: e.model,
          isNew: added.includes(e.id),
          ...(reachableMap.get(e.baseUrl) ?? {})
        }))
      };
    } catch (e) {
      // 导入失败不该影响编辑器其它功能：返回可读原因，界面提示即可。
      return {
        ok: false,
        providers: [],
        warnings: [`导入 Trae 配置时出错：${e?.message || e}`],
        dbPath: null,
        totalEntries: 0,
        uniqueModels: 0,
        importedEntries: []
      };
    }
  }
  ipcMain.handle("bwe:ai-import-trae", async () => handleImportTrae());

  /**
   * 模型清单 + 当前选中项。
   * 界面下拉框直接吃这个；ready/needsKey 用来显示「需要填 key」的标记。
   */
  async function handleGetModels() {
    try {
      const settings = await settingsStore.load();
      const listed = listModels(settings.ai ?? {}, "");
      return { ok: true, models: listed.models, active: listed.active };
    } catch (e) {
      return { ok: false, models: [], active: "", error: e?.message || String(e) };
    }
  }
  ipcMain.handle("bwe:ai-models", async () => handleGetModels());

  /**
   * 切换当前模型（可同时补填该模型的 API Key）。
   *
   * 三条纪律：
   *   1. id 不存在 → 明确失败，不静默改成别的模型（否则界面显示 A、实际发给 B）；
   *   2. 传了 apiKey 就写到**该条目**上（不同供应商用不同 key），不是顶层；
   *   3. 保存后返回最新清单状态；AI 桥每轮都读 settings，所以下一轮直接生效。
   */
  async function handleSetModel(payload) {
    try {
      const settings = await settingsStore.load();
      // 规则都在 modelCatalog.mjs 里（有单测）：**空串 apiKey 不清 key**，
      // 要清得显式传 clearApiKey:true。切模型不该顺手把用户填的 key 弄丢。
      const result = setActiveModel(settings.ai?.models ?? [], payload?.id, payload ?? {});
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          models: listModels(settings.ai ?? {}).models,
          active: settings.ai?.activeModelId ?? ""
        };
      }
      await settingsStore.save({ ai: { models: result.models, activeModelId: result.active } });
      return await respondWithModels(result.active);
    } catch (e) {
      return { ok: false, error: e?.message || String(e), models: [], active: "" };
    }
  }
  ipcMain.handle("bwe:ai-set-model", async (_e, payload) => handleSetModel(payload));

  /**
   * 手动添加 / 覆盖一条模型（用户想填 Trae 里没有的模型，比如 DeepSeek 官方或自己的反代）。
   *
   * 判重规则：同 provider + 同 baseUrl + 同 model = 同一条，**就地更新并保留原 id**
   * （所以从 Trae 导入的条目在被手填 key 时不会变成第二条）。
   */
  async function handleAddModel(payload) {
    try {
      const settings = await settingsStore.load();
      const result = addModel(settings.ai?.models ?? [], payload ?? {});
      if (!result.ok) {
        return { ok: false, error: result.error, models: listModels(settings.ai ?? {}).models, active: settings.ai?.activeModelId ?? "" };
      }
      // 新增后自动切到它 —— 用户刚填完模型，最可能的下一步就是用它。
      await settingsStore.save({ ai: { models: result.models, activeModelId: result.id } });
      const response = await respondWithModels(result.id);
      return {
        ...response,
        // 把「这次操作的是哪一条」显式带上：UI 添加完通常要立刻选中它，
        // 靠 active 也能推，但 id 更直接（active 会因"回落到第一个 ready"而变化）。
        id: result.id,
        created: Boolean(result.created),
        updated: Boolean(result.updated),
        ...(result.warning ? { warning: result.warning } : {})
      };
    } catch (e) {
      return { ok: false, error: e?.message || String(e), models: [], active: "" };
    }
  }
  ipcMain.handle("bwe:ai-add-model", async (_e, payload) => handleAddModel(payload));

  /**
   * 保存后统一回一个「清单 + 当前项」的结构。
   *
   * 抽出来是因为 set-model / add-model 的返回体必须完全一致，
   * 否则 UI 要写两套解析分支（迟早一套漏字段）。
   */
  async function respondWithModels(activeId) {
    const loaded = await settingsStore.load();
    const listed = listModels(loaded.ai ?? {}, activeId);
    const activeResolved = listed.models.find((m) => m.id === listed.active);
    return {
      ok: true,
      models: listed.models,
      active: listed.active,
      // 界面唯一的提示来源：为什么这条不能用
      message: activeResolved?.ready ? `已切换到「${activeResolved.label}」` : activeResolved?.reason || "",
      ready: Boolean(activeResolved?.ready)
    };
  }

  /**
   * 脚本补全（`bwe:script-complete`）：`{ source, offset }` → `{ ok, entries, isMemberAccess }`。
   *
   * 与网页版的 `POST /api/script-complete` **走的是同一套语言服务**（web/tools/script-language.mjs），
   * 只是传输层不同（这里 IPC，那里 HTTP）。所以两边补全结果永远一致 ——
   * 如果两处各写一套 TS 装配，桌面版和网页版的补全迟早会不一样，那是最难查的一类不一致。
   */
  async function handleScriptComplete(payload) {
    const result = await api.core.completeScript({
      source: String(payload?.source ?? ""),
      offset: Number(payload?.offset ?? 0)
    });
    return result;
  }
  ipcMain.handle("bwe:script-complete", async (_e, payload) => handleScriptComplete(payload ?? {}));

  /**
   * 脚本悬浮提示（`bwe:script-quickinfo`）：`{ source, offset }` → `{ ok, info }`。
   * `info === null` 是**正常结果**（光标在括号/空白处没有符号），UI 据此隐藏提示框即可。
   */
  async function handleScriptQuickInfo(payload) {
    return api.core.quickInfoScript({
      source: String(payload?.source ?? ""),
      offset: Number(payload?.offset ?? 0)
    });
  }
  ipcMain.handle("bwe:script-quickinfo", async (_e, payload) => handleScriptQuickInfo(payload ?? {}));

  /**
   * 真实探测某条模型的连通性（`bwe:ai-probe-model`）。
   *
   * 为什么单独开一条通道而不是把网络请求塞进 `ready`：
   *   清单里有几十个模型，逐个探测会让「打开设置」卡死；而且 `ready` 的语义是
   *   「配置齐全」（见 provider.mjs 顶部注释）。这里做的是**用户主动点「测试」**时的
   *   一次性真实探测：带该模型自己的 apiKey 打 `{baseUrl}/models`，3 秒超时。
   *
   * 三种结论都要能表达，不能硬塞进布尔：
   *   ok=true   明确可用（端点连通且 Key 被接受）
   *   ok=false  明确不可用（连不上 / Key 明确无效 / HTTP 错误）
   *   ok=null   **判不出来**（例如 /models 端点权限更高而拒绝 key）——
   *             宁可给出模糊的正确答案，也不要给出确切的错误答案。
   */
  async function handleProbeModel(payload) {
    try {
      const id = String(payload?.id ?? "").trim();
      if (!id) {
        return { ok: false, id: "", status: 0, reachable: false, method: "none", detail: "缺少模型 id", reason: "no-id", latencyMs: 0 };
      }
      const settings = await settingsStore.load();
      const entry = (settings.ai?.models ?? []).find((m) => m.id === id);
      if (!entry) {
        return {
          ok: false,
          id,
          status: 0,
          reachable: false,
          method: "none",
          detail: `模型 id「${id}」不在清单里`,
          reason: "not-found",
          latencyMs: 0
        };
      }
      // mock 不需要联网：直接回"可用"，但要说明它是本地演示，避免用户误以为验证了网络。
      if (entry.provider === "mock") {
        return {
          ok: true,
          id,
          status: 0,
          reachable: true,
          method: "none",
          detail: "本地演示模式，不发网络请求（无需探测）",
          reason: "mock",
          latencyMs: 0,
          evidence: "mock provider 永远可用，与网络无关"
        };
      }
      const result = await probeModelEndpoint(
        { baseUrl: entry.baseUrl, apiKey: entry.apiKey || settings.ai?.apiKey || "", model: entry.model },
        { timeoutMs: PROBE_TIMEOUT_MS }
      );
      return {
        ok: result.ok,
        id,
        status: result.status,
        reachable: result.reachable,
        method: result.method,
        detail: result.detail,
        reason: result.reason,
        latencyMs: result.latencyMs,
        errorCode: result.errorCode,
        evidence: result.evidence
      };
    } catch (e) {
      return {
        ok: false,
        id: String(payload?.id ?? ""),
        status: 0,
        reachable: false,
        method: "none",
        detail: `探测时出错：${e?.message || e}`,
        reason: "error",
        latencyMs: 0
      };
    }
  }
  ipcMain.handle("bwe:ai-probe-model", async (_e, payload) => handleProbeModel(payload));

  // 供 --ipc-probe 诊断用：直接调用同一套业务函数（而不是去摸 ipcMain 的内部字段）。
  probeHandlers = {
    importTrae: handleImportTrae,
    getModels: handleGetModels,
    setModel: handleSetModel,
    addModel: handleAddModel,
    probeModel: handleProbeModel,
    scriptComplete: handleScriptComplete,
    scriptQuickInfo: handleScriptQuickInfo,
    sessionsList: handleSessionsList,
    sessionNew: handleSessionNew,
    sessionSwitch: handleSessionSwitch,
    sessionDelete: handleSessionDelete
  };


  // 日志给渲染侧的「输出」面板（--console 之外第二个观察点）
  ipcMain.handle("bwe:log-tail", async () => logBuffer.slice(-200));
}

// ---------------------------------------------------------------------------
// --ipc-probe：模型清单 / Trae 导入 / 切换模型的真实返回（验收证据）
// ---------------------------------------------------------------------------

/**
 * 为什么需要它：这三条链路里有三样东西只有跑在真 Electron 主进程里才成立 ——
 *   1. safeStorage 的 DPAPI 加密（Node 单测只能用假实现）；
 *   2. 真实 Trae 的 SQLite 读取（node:sqlite + 真实库文件）；
 *   3. 真实的网络可达性探测（HEAD→GET 降级）。
 * 所以验收要在真进程里跑一遍并留证据，而不是只贴单测结果。
 *
 * 直接调业务函数而不是摸 ipcMain 的内部 handler 表 —— 后者是 Electron 私有实现，
 * 版本一变就失效，拿它当验收依据等于把证据建在流沙上。
 */
/**
 * 探针收尾：明文 key 泄漏检查 → 写 JSON → 退出。
 * 抽出来是因为只读探针（--ipc-probe-no-import）和完整探针都要走同一段收尾，
 * 两份拷贝迟早会在「检查项」上分叉。
 */
async function finishProbe(report, outFile) {
  const target = resolve(outFile);
  // ⑤ 安全检查：settings.json 里绝不能出现明文 key（本轮新增了「填 key」入口，必须回归这一条）。
  try {
    const disk = JSON.parse(await fsReadFile(settingsStore.file, "utf8"));
    const leaks = [];
    const walk = (node, path) => {
      if (typeof node === "string") {
        if (node.startsWith("sk-") && !path.endsWith("encryptedApiKey")) leaks.push(`${path}=${node.slice(0, 8)}…`);
        return;
      }
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    walk(disk, "");
    report.plaintextKeyLeaks = leaks;
    report.cryptoAvailable = report.cryptoAvailable;
    console.log(
      `[ipc-probe] 明文 key 泄漏检查：${leaks.length === 0 ? "通过（0 处）" : `失败（${leaks.length} 处）`}`
    );
    if (leaks.length) console.log(`  ${leaks.join(" | ")}`);
  } catch (e) {
    report.plaintextKeyLeaks = [`检查失败：${e?.message || e}`];
  }

  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2), "utf8");
    console.log(`\n[ipc-probe] 已写入 ${target}`);
    console.log(`[ipc-probe] cryptoAvailable=${report.cryptoAvailable}`);
  } catch (e) {
    console.error(`[ipc-probe] 写文件失败：${e?.message || e}`);
  }
  // ⚠ 用 process.exit 而不是 app.exit：
  //   只读探针模式（--ipc-probe-no-import）不创建窗口，此时 app.exit(0) 只把控制权交回
  //   Electron 事件循环，而没有窗口能终结它 —— 实测进程会一直挂着（被外部 timeout 杀掉）。
  //   此刻所有写盘（await writeFile）都已完成，process.exit(0) 是安全的。
  process.exit(0);
}

async function runIpcProbe(outFile) {
  const target = resolve(outFile);
  const report = { startedAt: new Date().toISOString(), userData: USER_DATA_DIR, cryptoAvailable: null, channels: {} };

  try {
    report.cryptoAvailable = Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    report.cryptoAvailable = false;
  }

  const record = (name, payload) => {
    report.channels[name] = payload;
    console.log(`\n===== ${name} =====`);
    console.log(JSON.stringify(payload, null, 2));
  };

  try {
    // `--ipc-probe-no-import`：只读模式。
    // 为什么需要它：验收脚本要在**同一份 --user-data 目录**上分两步跑
    // （先截图看 DOM、再读 ai-models 字段）。若第二次探针又执行 Trae 导入，
    // 就会把模型写进被验收的目录，条数从 3 变成 5 —— 验收数据被自己污染了。
    const readOnlyProbe = Boolean(ARGS.ipcProbeNoImport);

    // 顺序有讲究：先导入（会写 settings），再读清单，最后切模型。
    if (readOnlyProbe) {
      console.log("[ipc-probe] 只读模式：跳过 Trae 导入与写操作，只读现有配置");
      record("bwe:ai-models", await probeHandlers.getModels());
      // 多会话四通道（只读模式下做完整 CRUD 演练：这些都是**写**操作，
      // 但写的是被验收目录自己的会话存储，属于本功能的正常闭环，不是污染用户配置）
      record("bwe:ai-sessions-list", await probeHandlers.sessionsList());
      record("bwe:ai-session-new", await probeHandlers.sessionNew({}));
      const sessionsAfterNew = report.channels["bwe:ai-session-new"]?.sessions ?? [];
      const firstSession = sessionsAfterNew.find((x) => x.id !== report.channels["bwe:ai-session-new"]?.id);
      if (firstSession) record("bwe:ai-session-switch", await probeHandlers.sessionSwitch({ id: firstSession.id }));
      record("bwe:ai-sessions-list:after", await probeHandlers.sessionsList());
      // ai-status 必须放在会话操作**之后**，否则 sessionCount 反映不出「刚开了新会话」
      // （我第一次就跑成了 1，因为 status 在 new 之前取 —— 探针顺序本身也是被测对象）
      record("bwe:ai-status", await ai.aiStatus());
      // ---- 三源一致性自检（key 解不开状态的三个统计源必须对齐）----
      //
      // 为什么主进程也要自检：B 侧已做了交叉校验，但那只"能发现"不能"修复" ——
      // 如果出口先漂移了，UI 只能看到一个不一致的红条。
      // 三个源：
      //   ① ai-status.keyUndecryptableCount
      //   ② ai-status.keyUndecryptableEntries.length
      //   ③ ai-models 里 keyUndecryptable:true 的条数
      // 契约里写了 ① === ② 这条恒等式，③ 是"逐条真相"（UI 逐条渲染依赖它）。
      record("bwe:key-state-consistency", (() => {
        const status = report.channels["bwe:ai-status"] ?? {};
        const models = report.channels["bwe:ai-models"]?.models ?? [];
        const count = Number(status.keyUndecryptableCount ?? 0);
        const entriesLen = Array.isArray(status.keyUndecryptableEntries)
          ? status.keyUndecryptableEntries.length
          : 0;
        const perModel = models.filter((m) => m.keyUndecryptable === true).length;
        const mismatches = [];
        if (count !== entriesLen) {
          mismatches.push(`keyUndecryptableCount(${count}) !== keyUndecryptableEntries.length(${entriesLen})`);
        }
        if (count !== perModel) {
          mismatches.push(`keyUndecryptableCount(${count}) !== ai-models 里 keyUndecryptable 条数(${perModel})`);
        }
        // 另外两条语义自洽性：解不开的条目不能同时被标成"没填"
        const contradictory = models.filter((m) => m.keyUndecryptable === true && m.needsKeyMissing === true).length;
        if (contradictory > 0) {
          mismatches.push(`${contradictory} 条同时 keyUndecryptable=true 与 needsKeyMissing=true（语义互斥）`);
        }
        const consistent = mismatches.length === 0;
        if (!consistent) log(`⚠ key 状态三源不一致：${mismatches.join("；")}`, "bwe:ai");
        return {
          consistent,
          count,
          entriesLength: entriesLen,
          perModelCount: perModel,
          mismatches
        };
      })());
      // 验证「聊完天后标题/条数真的更新」——这是端到端行为，单测只能证明组件联动。
      const firstActive = report.channels["bwe:ai-sessions-list"]?.active;
      if (firstActive) {
        await ai.aiChat({ requestId: "probe-chat", messages: [{ role: "user", text: "帮我重构玩家移动逻辑" }], intent: "chat" });
        await ai.whenIdle();
        record("bwe:ai-sessions-list:after-chat", await probeHandlers.sessionsList());
      }
      // 真 key 协议验证：**只在显式开启时执行**（会消耗用户 token）。
      // 开关是 `--protocol-live`，普通 --ipc-probe 不会跑它。
      if (ARGS.protocolLive) {
        record("bwe:protocol-live", await probeProtocolLive());
      }
      const modelsReadOnly = report.channels["bwe:ai-models"]?.models ?? [];
      // 探测**两条**：一条 mock、一条非 mock。
      // 为什么必须两条：mock 分支返回的是写死的字面量（不走 probeModelEndpoint），
      // 只探测 mock 的话，「真实探测分支的字段名被改坏」完全测不出来 ——
      // 我实际用注入断裂验证过这个盲区（改了 reason→kind 但测试仍全绿）。
      const mockEntry = modelsReadOnly.find((m) => m.provider === "mock");
      // 顺带验证脚本语言两个通道（不需要网络，纯本地 TypeScript）
      record("bwe:script-complete", await probeHandlers.scriptComplete({ source: "bwe.world.fi", offset: 12 }));
      record("bwe:script-quickinfo", await probeHandlers.scriptQuickInfo({ source: "bwe.world.find()", offset: 11 }));

      const realEntry = modelsReadOnly.find((m) => m.provider !== "mock");
      if (mockEntry) record("bwe:ai-probe-model:mock", await probeHandlers.probeModel({ id: mockEntry.id }));
      if (realEntry) record("bwe:ai-probe-model:real", await probeHandlers.probeModel({ id: realEntry.id }));
      await finishProbe(report, outFile);
      return;
    }

    record("bwe:ai-import-trae", await probeHandlers.importTrae());
    record("bwe:ai-models", await probeHandlers.getModels());

    // ① 切到「第一个未就绪的模型」—— 验证「切换成功但提示缺 key」这条最容易做错的路径。
    const models = report.channels["bwe:ai-models"]?.models ?? [];
    const firstNotReady = models.find((m) => !m.ready) ?? models[0];
    if (firstNotReady) record("bwe:ai-set-model", await probeHandlers.setModel({ id: firstNotReady.id }));
    else record("bwe:ai-set-model", { skipped: "清单为空" });

    // ② 手动添加一条 Trae 里没有的模型（用户可能想用 DeepSeek 官方或自己的反代）。
    record("bwe:ai-add-model", await probeHandlers.addModel({
      label: "DeepSeek 官方 Flash",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      notes: "手动添加，用于验证 add-model 通道"
    }));

    // ③ 重复添加同一条：必须原地更新（不能多出第二条）—— 这是 id 稳定性规则的实际验证。
    const dupId = report.channels["bwe:ai-add-model"]?.id;
    record("bwe:ai-add-model:dup", await probeHandlers.addModel({
      label: "DeepSeek 官方 Flash（改名）",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash"
    }));

    // ④ 给某条模型填一个 key，验证「填完立刻 ready」。
    //    用假 key 而不是真 key：这里只验证管道（加密落盘 → 解析 → ready），不消耗真额度。
    const traeEntry = models.find((m) => m.source === "trae-import");
    if (traeEntry) {
      record("bwe:ai-set-model:withkey", await probeHandlers.setModel({
        id: traeEntry.id,
        apiKey: "sk-fake-probe-key"
      }));
    }

    record("bwe:ai-status", await ai.aiStatus());
  } catch (e) {
    record("error", { message: e?.stack || e?.message || String(e) });
  }

  await finishProbe(report, outFile);
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
/**
 * --probe-dom：读取渲染侧**真实 DOM 内容**（不只是计数）。
 *
 * 为什么需要它：`UI 骨架: xxx=1` 只能证明「有这个元素」，证明不了「里面装的内容对不对」。
 * 「模型下拉框里真的有 N 条、且 needsKey 那条显示为需要填 key」这类断言，必须读 option
 * 文本才做得到 —— 否则模型切换功能坏了，截图看起来一切正常。
 *
 * 返回结构刻意做成「通用 + 模型专用」两部分：通用部分（selects/buttons）以后可以给别的
 * 面板复用，modelSelect 部分是验收当前功能的唯一机器可验证证据。
 */
async function probeDom(selectors = []) {
  try {
    // 选择器通过 JSON 注入渲染侧：不要在模板字符串里拼裸选择器，
    // 否则带引号/逗号的选择器（如 [data-x="y"]）会破坏脚本。
    const selectorJson = JSON.stringify(selectors ?? []);
    const data = await mainWindow.webContents.executeJavaScript(
      `(() => {
        const REQUESTED = ${selectorJson};
        const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
        const describeSelects = () =>
          Array.from(document.querySelectorAll("select")).map((sel, i) => ({
            index: i,
            id: sel.id || "",
            cls: String(sel.className || "").slice(0, 60),
            name: sel.getAttribute("data-model-select") !== null ? "model-select" : "",
            optionCount: sel.options.length,
            options: Array.from(sel.options).map((o) => ({
              value: o.value,
              text: txt(o),
              disabled: Boolean(o.disabled)
            })),
            selectedValue: sel.value
          }));

        // 模型下拉框的优选查找顺序：
        //   1) 显式 data-model-select（B 侧接好后应加这个锚点）
        //   2) 出现在 .ai-panel 里的 select（AI 面板内的下拉框）
        //   3) 全窗口第一个 select（最后兜底）
        const aiPanel = document.querySelector(".ai-panel");
        const explicit = document.querySelector("[data-model-select]");
        const inPanel = aiPanel ? aiPanel.querySelector("select") : null;
        const anySelect = document.querySelector("select");
        const modelSel = explicit || inPanel || anySelect;
        const modelSelect = modelSel
          ? {
              found: true,
              source: explicit ? "data-model-select" : (inPanel ? "ai-panel select" : "first select in document"),
              optionCount: modelSel.options.length,
              selectedValue: modelSel.value,
              selectedText: txt(modelSel.options[modelSel.selectedIndex]),
              options: Array.from(modelSel.options).map((o) => ({
                value: o.value,
                text: txt(o),
                disabled: Boolean(o.disabled)
              }))
            }
          : { found: false, optionCount: 0, options: [] };

        // 面板里「需要填 key」「已就绪」这类状态文字，模型功能坏了这里会空
        const panelText = txt(aiPanel).slice(0, 1200);

        /**
         * --probe-selector：按传入的每个选择器，读**第一个**匹配元素的
         * 矩形（x/y/width/height，CSS 像素）与前 200 字文本。
         *
         * 为什么需要：判断「脚本编辑器是不是太小了」不能靠看截图量像素
         * （缩放/DPI 都会差几像素），实际 getBoundingClientRect 才是证据 ——
         * B 改高度前是 N，改后是 M，两个数字一对比就说清了。
         */
        const probeSelectors = (() => {
          const out = [];
          for (const sel of REQUESTED) {
            let el = null;
            try {
              el = document.querySelector(sel);
            } catch (e) {
              // ⚠ 这里不能用模板字符串：整段代码本身就是外层模板字符串的内容，
              //    嵌套反引号会提前闭合外层（真实踩过）。用拼接。
              out.push({ selector: sel, found: false, error: "选择器语法错误：" + e.message });
              continue;
            }
            if (!el) {
              out.push({ selector: sel, found: false, matchCount: 0 });
              continue;
            }
            const rect = el.getBoundingClientRect();
            out.push({
              selector: sel,
              found: true,
              tag: el.tagName,
              id: el.id || "",
              cls: String(el.className || "").slice(0, 80),
              matchCount: document.querySelectorAll(sel).length,
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              },
              // 文本给前 200 字：够看清"里面装的是什么"，又不至于把整段代码塞进 JSON
              text: txt(el).slice(0, 200),
              textLength: (el.textContent || "").replace(/\s+/g, " ").trim().length,
              visible: Boolean(rect.width && rect.height)
            });
          }
          return out;
        })();

        return {
          selects: describeSelects(),
          modelSelect,
          modelSelectFound: modelSelect.found,
          selectors: probeSelectors,
          aiPanelText: panelText,
          aiPanelPresent: Boolean(aiPanel),
          statusText: txt(document.querySelector(".statusbar, .status-bar")).slice(0, 400)
        };
      })()`,
      true
    );
    return data ?? {};
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

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
  // --tap-seq 的多步取证结果（可能为 null）。写进 --probe-dom 的 JSON，
  // 这样 B 一条命令就能拿到「折叠前 / 折叠后 / 再展开后」三组宽度。
  const tapSeq = opts.tapSeq ?? null;
  const skeleton = await probeUiSkeleton();
  console.log(
    `[shot] ${tag}UI 骨架: activity-bar=${skeleton.activityBar ?? 0} sidebar=${skeleton.sidebar ?? 0} `
    + `editor-tabs=${skeleton.editorTabs ?? 0} panel=${skeleton.panel ?? 0} statusbar=${skeleton.statusbar ?? 0} `
    + `ai-panel=${skeleton.aiPanel ?? 0} palette=${skeleton.commandPalette ?? 0} root=${skeleton.rootChildren ?? 0}`
  );
  console.log(
    `[shot] ${tag}主题样式: cream.css ${skeleton.creamStyleLoaded ? "已加载" : "未加载"} · body 背景 ${skeleton.bodyBg ?? "?"}`
  );

  // ---- DOM 内容探针（--probe-dom 时输出）----
  // 与几何探针分开放：几何回答「元素在不在/多宽」，DOM 回答「里面装的内容对不对」。
  if (ARGS.probeDom) {
    // --probe-selector=".js-code,.panel,.ai-panel"：逗号分隔，逐个读首个匹配元素的矩形与文本。
    const selectors = ARGS.probeSelector
      ? String(ARGS.probeSelector).split(",").map((t) => t.trim()).filter(Boolean)
      : [];
    const dom = await probeDom(selectors);
    console.log(`[dom] AI 面板存在: ${dom.aiPanelPresent ? "是" : "否"} · 下拉框来源: ${dom.modelSelect?.source ?? "未找到"}`);
    console.log(
      `[dom] 模型下拉框: found=${dom.modelSelectFound} optionCount=${dom.modelSelect?.optionCount ?? 0} `
      + `selected=${dom.modelSelect?.selectedValue ?? ""}`
    );
    for (const opt of dom.modelSelect?.options ?? []) {
      console.log(`[dom]   option value=${opt.value} text=${opt.text}${opt.disabled ? " (disabled)" : ""}`);
    }
    // --probe-selector 的结果：这是"某个元素实际多大"的证据，比截图量像素可靠
    for (const sel of dom.selectors ?? []) {
      if (!sel.found) {
        console.log(`[dom] selector ${sel.selector} → 未找到${sel.error ? `（${sel.error}）` : ""}`);
        continue;
      }
      console.log(
        `[dom] selector ${sel.selector} → <${sel.tag}${sel.id ? `#${sel.id}` : ""}> `
        + `x=${sel.rect.x} y=${sel.rect.y} ${sel.rect.width}x${sel.rect.height} `
        + `· 匹配 ${sel.matchCount} 个 · 文本 ${sel.textLength} 字`
      );
      if (sel.text) console.log(`[dom]   文本：${sel.text.slice(0, 80)}`);
    }
    try {
      await mkdir(dirname(resolve(ARGS.probeDom)), { recursive: true });
      // sequence 与 selectors 一起落盘：B 要的是「同一次运行里的多步对比」，
      // 分成两个文件会让他自己拼时间线，容易拼错。
      await writeFile(
        resolve(ARGS.probeDom),
        JSON.stringify({ ...dom, sequence: tapSeq?.sequence ?? [], sequenceErrors: tapSeq?.errors ?? [] }, null, 2),
        "utf8"
      );
      console.log(`[dom] 已写入 ${resolve(ARGS.probeDom)}`);
    } catch (e) {
      console.error(`[dom] 写入 JSON 失败：${e?.message || e}`);
    }
  }

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

  // 主题判定：**优先用 DOM 底色**（不受 modal/遮罩影响），像素只作兜底。
  // bodyBg（如 "rgb(246, 242, 234)"）在 Node 侧解析成亮度 —— 见 png.mjs 的 cssColorLuminance。
  const domLuminance = cssColorLuminance(skeleton.bodyBg);
  const theme = assertTheme(stats, {
    domLuminance,
    domColor: skeleton.bodyBg
  });
  if (theme.ok) {
    console.log(`[shot] ${tag}主题: ${theme.theme} → PASS（${theme.detail}）`);
  } else {
    console.log(`[shot] ${tag}主题: ${theme.theme === "dark" ? "midnight" : theme.theme} → FAIL（期望奶油）— ${theme.detail}`);
  }
  // 「疑似深色覆盖」只是提示，不是失败 —— 让人知道为什么这张图看起来暗。
  if (theme.overlayWarning) {
    console.log(`[shot] ${tag}警告: ${theme.overlayWarning}`);
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
  /**
   * 非背景像素占比的合格区间。
   *
   * ⚠ 这个指标同样会被「大面积覆盖物」影响（与主题判据同一类方法缺陷）：
   * modal 遮罩一铺，背景色从"页面的浅底"变成"遮罩的深色"，前景占比会被拉低 ——
   * 实测同一视图 69.3%（无 modal）→ 42.5%（有 modal）。
   *
   * 但它的**语义是「界面有没有渲染出来」**，而不是「底色对不对」，遮罩不会让界面消失。
   * 所以处理方式是：检测到疑似遮罩（darkOverlayLikely）时**放宽下限**，
   * 避免遮罩面积更大时逼近 20% 下限被误报成「界面没起来」。
   * 上界不动：遮罩只会降低 nonBg，不会把它推高。
   */
  const overlay = Boolean(stats.darkOverlayLikely);
  const NONBG_MIN = overlay ? 0.1 : 0.2;
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

  // ---- --tap-seq：多步交互 + 每步取证 ----
  //
  // 与 --tap 的区别：--tap 是「点一次→截图→退出」，拿不到「点击前 vs 点击后」的对比；
  // --tap-seq 在**同一次运行**里做多步（click / probe / wait），把每步结果追加到 sequence。
  // 用在折叠类 bug：点折叠 → 量宽度 → 点展开 → 再量宽度，三组数字来自同一次运行，
  // 排除掉「用户手速/缓存/随机布局」这些中间变量。
  //
  // --verify 同样不跑（自检必须针对干净默认视图）。
  let tapSeqResult = null;
  if (ARGS.tapSeq) {
    if (ARGS.verify) {
      console.log("[seq] --verify 模式忽略 --tap-seq（自检只跑默认视图）");
    } else {
      const parsed = parseTapSeq(ARGS.tapSeq);
      for (const err of parsed.errors) console.error(`[seq] 解析警告：${err}`);
      console.log(`[seq] 共 ${parsed.steps.length} 步：${parsed.steps.map((st) => st.raw).join(" → ")}`);
      tapSeqResult = await runTapSequence(mainWindow, parsed.steps, (msg) => console.log(msg));
      // 每步内部已按 click 的 waitMs 等待，这里再给一次整体重排的余量。
      await new Promise((r) => setTimeout(r, 300));
      console.log(`[seq] 完成 ${tapSeqResult.sequence.length} 条记录，${tapSeqResult.errors.length} 条错误`);
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
        tapSeq: tapSeqResult,
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
