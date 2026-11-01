/**
 * 桌面壳 · Electron 主进程入口（引导层）。
 *
 * 为什么入口这么薄：启动前有两件环境问题必须先处理，而它们只能在模块求值之前决定。
 *
 * ① 以纯 Node 运行（`node desktop/main.mjs`）：
 *    Node 里 `import "electron"` 找不到包 → ERR_MODULE_NOT_FOUND，用户看到一大段栈。
 *    契约/Lead 要求 `npm run desk`、`node desktop/main.mjs --shot=...` 永远能用，
 *    所以这里检测到「不在 Electron 运行时」就**自动用 vendor 里的 electron.exe 重启自己**
 *    （argv 原样转发）。用 `--relaunched` 标记 + 环境变量双保险防无限重启。
 *
 * ② `ELECTRON_RUN_AS_NODE=1`：
 *    Electron 判断的是变量**是否存在**（空字符串也算设置），此时 electron.exe 会退化成
 *    纯 Node，`import "electron"` 拿不到 app/BrowserWindow —— 表现是「双击没窗口、静默退出」。
 *    所以重启时用 `delete env.ELECTRON_RUN_AS_NODE`，不是置空。
 *
 * 处理完环境才动态 import 真正的实现（lib/app-main.mjs）。
 * Windows 绝对路径（D:\...）必须走 pathToFileURL，否则 import 会当成 d: 协议。
 *
 * 命令行（转发给实现层）：--shot=<png> / --size=WxH / --console / --probe=<json> / --tap=<sel,sel> / --verify
 * 详见 desktop/lib/app-main.mjs 的 runShotMode 注释。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 本文件真实位置：仓库里是 desktop/，打包后在 resources/app/desktop/。 */
const VENDOR_EXE = join(HERE, "vendor", "electron", "electron.exe");

/** 当前是否真的运行在 Electron 主进程里（process.versions.electron 只在运行时存在）。 */
function inElectronRuntime() {
  return Boolean(process.versions?.electron) && !process.env.ELECTRON_RUN_AS_NODE;
}

/** 从环境里删掉 ELECTRON_RUN_AS_NODE（不是置空，见文件头 ②）。 */
function envWithoutRunAsNode(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** 用 vendor 的 electron.exe 重启自己；argv 原样转发（去掉标记后重新加上）。 */
function relaunchWithElectron(argv) {
  const args = [];
  for (const a of argv) {
    if (a === "--relaunched") continue;
    args.push(a);
  }
  args.push("--relaunched");
  const child = spawn(VENDOR_EXE, [HERE, ...args], {
    env: envWithoutRunAsNode(),
    stdio: "inherit",
    windowsHide: false
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (e) => {
    console.error(
      `[bwe] 无法用 Electron 启动（${e.message}）。\n`
      + `  请确认 ${VENDOR_EXE} 存在；缺失时先运行：node desktop/tools/fetch-electron.mjs`
    );
    process.exit(1);
  });
}

// ---------------------------------------------------------------- 启动判定

if (!inElectronRuntime()) {
  // 已经重启过一次还不在 Electron 里 → 不要再套娃，直接说清楚问题。
  const alreadyRelaunched = process.argv.includes("--relaunched");
  if (alreadyRelaunched) {
    console.error(
      "[bwe] 已经用 Electron 重启过一次，但仍然不在 Electron 运行时里。\n"
      + "  可能原因：ELECTRON_RUN_AS_NODE 被父进程强行设置，或 vendor 里的 exe 不是官方 Electron。\n"
      + `  手动排查：set ELECTRON_RUN_AS_NODE= 然后运行 "${VENDOR_EXE}" "${HERE}" --console`
    );
    process.exit(1);
  }
  if (!existsSync(VENDOR_EXE)) {
    console.error(
      "[bwe] 当前不是 Electron 运行时，且找不到 vendor 里的 Electron 二进制。\n"
      + `  缺少：${VENDOR_EXE}\n`
      + "  离线重建：node desktop/tools/fetch-electron.mjs\n"
      + "  （该脚本会从本机 electron 缓存解压，不联网）"
    );
    process.exit(1);
  }
  // 人话提示：用户直接 `node desktop/main.mjs` 时不该看到栈。
  console.log(`[bwe] 检测到当前不是 Electron 运行时，自动用 ${VENDOR_EXE} 重新启动…`);
  relaunchWithElectron(process.argv.slice(1));
} else {
  // ELECTRON_RUN_AS_NODE 存在但 process.versions.electron 也在：说明是「Electron 身份被禁用」，
  // 同样要重启（这条罕见，但留着能省一次难查的排查）。
  if (process.env.ELECTRON_RUN_AS_NODE) {
    relaunchWithElectron(process.argv.slice(1));
  } else {
    // ⚠ 必须用 pathToFileURL：Windows 绝对路径直接喂 import 会被当成 d: 协议。
    await import(pathToFileURL(resolve(HERE, "lib", "app-main.mjs")).href);
  }
}
