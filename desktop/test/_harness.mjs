/**
 * 测试共用的小工具：定位 Electron 二进制、仓库根、APPDATA 路径。
 *
 * 为什么不直接写死 `desktop/vendor/electron/electron.exe`：
 *   - 仓库可能被 clone 到别的盘；
 *   - vendor 缺失时需要给出「先跑 fetch-electron」的明确提示，而不是 ENOENT 栈。
 *
 * 供 desktop/test/*.test.mjs import。纯路径计算，不做任何 IO 副作用。
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** 仓库根：desktop/test/ 往上两级。 */
export const repoRoot = resolve(TEST_DIR, "..", "..");

/** desktop/ 目录。 */
export const desktopDir = resolve(TEST_DIR, "..");

/** Electron 可执行文件（vendor 里那份）。 */
export const electronExe = join(desktopDir, "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");

/** 主进程入口。 */
export const mainScript = join(desktopDir, "main.mjs");

/** APPDATA 根（与 Electron 的 app.getPath("appData") 对齐：Windows 是 %APPDATA%）。 */
export const appDataPath = process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming");

/** 打包产物 exe。 */
export const packagedExe = join(desktopDir, "dist", "win-unpacked", "BWE Studio.exe");

/**
 * 断言 Electron 可用；缺失时抛一句能直接照做的错误。
 */
export function requireElectron() {
  if (!existsSync(electronExe)) {
    throw new Error(
      `找不到 Electron：${electronExe}\n`
      + "  先运行：node desktop/tools/fetch-electron.mjs（离线从本机缓存重建 vendor）"
    );
  }
  return electronExe;
}
