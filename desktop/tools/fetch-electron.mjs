/**
 * 离线重建 desktop/vendor/electron（仓库不背 318MB 二进制）。
 *
 * 为什么要这个脚本：`.gitignore` 里 vendor 被忽略，别人 clone 完仓库没有 Electron，
 * 双击和打包都会失败。这里在**离线**前提下用本机已有的 electron 缓存重建。
 *
 * 查找顺序（找到即可，全程不联网）：
 *   1. vendor/electron 已存在且 electron.exe 可用 → 直接复用；
 *   2. 环境变量 BWE_ELECTRON_ZIP 指向的 zip；
 *   3. desktop/vendor/ 下的 electron-v37.10.3-win32-x64.zip（手工放进来）；
 *   4. %LOCALAPPDATA%\electron\Cache\<hash>\electron-v37.10.3-win32-x64.zip；
 *   5. %USERPROFILE%\.electron\ 、%LOCALAPPDATA%\electron-builder\Cache、~/.cache/electron。
 * 全都没有 → 打印清晰的补救步骤（不要只说 "not found"）。
 *
 * 解压不依赖第三方库：Node 没有内置 unzip，用 Windows 自带的 PowerShell Expand-Archive，
 * 失败再退回 `tar -xf`（Win10 1803+ 自带 bsdtar）。两条都是纯本地命令。
 *
 * 用法：
 *   node desktop/tools/fetch-electron.mjs            # 缺才装
 *   node desktop/tools/fetch-electron.mjs --force    # 强制重建
 *   node desktop/tools/fetch-electron.mjs --check    # 只检查，不装（退出码 0/1）
 */

import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const VENDOR = join(DESKTOP, "vendor");
const TARGET = join(VENDOR, "electron");
export const ELECTRON_VERSION = "37.10.3";
const ZIP_NAME = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
const EXE = process.platform === "win32" ? "electron.exe" : "electron";

function log(message) {
  console.log(`[fetch-electron] ${message}`);
}

/** vendor 是否真的可用（不只看目录在不在，还要看入口二进制）。 */
export function electronReady() {
  try {
    return existsSync(join(TARGET, EXE));
  } catch {
    return false;
  }
}

/** 扫一层缓存目录（electron 按 sha256 分桶，zip 在子目录里）。 */
function zipsUnder(root) {
  if (!existsSync(root)) return [];
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const name of [ZIP_NAME, "electron.zip", `electron-v${ELECTRON_VERSION}-win32-x64.zip`]) {
        if (existsSync(join(full, name))) out.push(join(full, name));
      }
    } else if (entry.isFile() && entry.name.endsWith(".zip")) {
      out.push(full);
    }
  }
  return out;
}

function candidateZips() {
  const out = [];
  if (process.env.BWE_ELECTRON_ZIP) out.push(resolve(process.env.BWE_ELECTRON_ZIP));
  out.push(join(VENDOR, ZIP_NAME));
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  out.push(...zipsUnder(join(localAppData, "electron", "Cache")));
  out.push(...zipsUnder(join(homedir(), ".electron")));
  out.push(...zipsUnder(join(localAppData, "electron-builder", "Cache")));
  out.push(...zipsUnder(join(homedir(), ".cache", "electron")));
  return out.filter((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}

/**
 * 解压 zip 到目标目录。
 *
 * 用 PowerShell / tar 而不是自己写 inflate：zip 里有几十个 DLL 与资源，
 * 自己写解压器在「长路径 / UTF-8 文件名 / 权限位」上出错的代价远大于调用系统工具。
 */
function extractZip(zip, destDir) {
  const attempts = [];
  if (process.platform === "win32") {
    attempts.push({
      label: "PowerShell Expand-Archive",
      cmd: "powershell.exe",
      args: [
        "-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
      ]
    });
  }
  // bsdtar（Windows 10 1803+ 自带）对 zip 支持很好，作为第二条路。
  attempts.push({ label: "tar -xf", cmd: "tar", args: ["-xf", zip, "-C", destDir] });
  for (const a of attempts) {
    const r = spawnSync(a.cmd, a.args, { stdio: "pipe", windowsHide: true, encoding: "utf8" });
    if (r.status === 0) {
      log(`解压成功（${a.label}）`);
      return true;
    }
    log(`${a.label} 失败：${String(r.stderr || r.stdout || "").split("\n")[0]}`);
  }
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const check = argv.includes("--check");

  if (electronReady() && !force) {
    log(`已就绪：${TARGET}`);
    log(`版本：${safeReadVersion()}`);
    return 0;
  }
  if (check) {
    log(`未就绪：${TARGET} 缺少 ${EXE}`);
    log("运行 node desktop/tools/fetch-electron.mjs 可离线重建。");
    return 1;
  }

  const zip = candidateZips()[0];
  if (!zip) {
    console.error("");
    console.error("找不到 Electron 二进制，且当前是**离线**环境（不会自动下载）。");
    console.error("");
    console.error(`需要：${ZIP_NAME}`);
    console.error("任选一种做法：");
    console.error(`  1. 把 zip 放到 desktop/vendor/${ZIP_NAME} ，然后重跑本脚本；`);
    console.error("  2. 设环境变量 BWE_ELECTRON_ZIP=<zip 的绝对路径>，然后重跑本脚本；");
    console.error("  3. 从有网的机器下载后拷过来：");
    console.error(`     https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP_NAME}`);
    console.error("  4. 若本机已有 electron 缓存，确认这个目录存在：");
    console.error(`     ${join(process.env.LOCALAPPDATA ?? "?", "electron", "Cache")}`);
    console.error("");
    console.error("（仓库不背 318MB 二进制，所以 desktop/vendor/ 在 .gitignore 里。）");
    return 1;
  }

  log(`使用 zip：${zip}`);
  const rawDir = join(VENDOR, ".extract-tmp");
  await rm(rawDir, { recursive: true, force: true });
  await mkdir(rawDir, { recursive: true });
  // Expand-Archive 需要目标目录存在；tar 会自动创建。
  await writeFile(join(rawDir, ".keep"), "", "utf8").catch(() => {});
  if (!extractZip(zip, rawDir)) {
    console.error("[fetch-electron] 解压失败：本机没有可用的解压工具（PowerShell Expand-Archive / tar 都不可用）。");
    return 1;
  }

  // 解压出来的通常是 electron/ 子目录，把它展平到 TARGET。
  const entries = await readdir(rawDir, { withFileTypes: true }).catch(() => []);
  const flat = entries.some((e) => e.isFile() && e.name === EXE);
  const innerDirs = entries.filter((e) => e.isDirectory());
  await rm(TARGET, { recursive: true, force: true });
  if (flat) {
    await cp(rawDir, TARGET, { recursive: true });
  } else if (innerDirs.length >= 1) {
    const inner = join(rawDir, innerDirs[0].name);
    const innerHasExe = (await readdir(inner, { withFileTypes: true }).catch(() => []))
      .some((e) => e.isFile() && e.name === EXE);
    await cp(innerHasExe ? inner : rawDir, TARGET, { recursive: true });
  } else {
    await cp(rawDir, TARGET, { recursive: true });
  }
  await rm(rawDir, { recursive: true, force: true });

  if (!electronReady()) {
    console.error(`[fetch-electron] 解压完成但没找到 ${EXE}：${TARGET}`);
    console.error("请检查 zip 内容是否为官方 win32-x64 包（应含 electron.exe）。");
    return 1;
  }
  log(`已重建：${TARGET}`);
  log(`版本：${safeReadVersion()}`);
  log(`大小：${await dirSize(TARGET)} MB`);
  return 0;
}

function safeReadVersion() {
  try {
    return readFileSync(join(TARGET, "version"), "utf8").trim();
  } catch {
    return "(unknown)";
  }
}

/** 目录总大小（MB）—— 只为了打印一行「重建了多少东西」。 */
async function dirSize(dir) {
  let bytes = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      bytes += (await dirSize(full)) * 1024 * 1024;
    } else {
      const info = await stat(full).catch(() => null);
      if (info) bytes += info.size;
    }
  }
  return Math.round(bytes / 1024 / 1024);
}

process.exitCode = await main();
