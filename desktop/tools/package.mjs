/**
 * 离线打包：把桌面壳做成可双击的 `BWE Studio.exe`。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 产物不进仓库 —— 首次 clone 后怎么走
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `desktop/dist/` 与 `desktop/vendor/` 都在 .gitignore 里（合计约 680MB 二进制）。
 * 别人 clone 完仓库后，按这两步就能重建：
 *
 *   1. node desktop/tools/fetch-electron.mjs
 *      离线从本机 electron 缓存（%LOCALAPPDATA%\electron\Cache\<hash>\electron-v37.10.3-win32-x64.zip）
 *      解压出 desktop/vendor/electron/。**不联网**；缓存也没有时会打印如何手工放入 zip。
 *      本脚本在 vendor 缺失时会自动调用它，所以直接跑第 2 步也行。
 *
 *   2. node desktop/tools/package.mjs --verify
 *      （或 npm run desk:pack / npm run desk:verify）
 *      产出 desktop/dist/win-unpacked/BWE Studio.exe（约 364MB，含 Electron 运行时）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么手写而不用 @electron/packager
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 离线环境装不了包，而这件事本身并不复杂 —— Electron 在 Windows 上的「打包」就是：
 *   1. 复制 vendor/electron 到 dist/win-unpacked（electron.exe + 运行时 DLL/资源）；
 *   2. 把应用目录放进 resources/app（main.mjs / preload.cjs / lib / web 前端）；
 *   3. 复制一份 exe 命名为 BWE Studio.exe（**不修改 vendor 里的原文件**）。
 * 双击 BWE Studio.exe 时 Electron 会找 resources/app，因此不需要 asar、不需要签名。
 *
 * ⚠ 关键取舍：**前端资源要一起复制进 resources/app/web**，而不是让 app 去读仓库路径。
 * 原因是 exe 可能被拷到别的机器上，仓库不在原地。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 目录布局必须复刻仓库（踩过的坑）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * resources/app 里放的是 `desktop/` + `web/` + `lib/` + `src/`，与仓库一模一样。
 * 曾把 main.mjs 直接摊在 app 根，结果 main.mjs 的 `REPO_ROOT = dirname(HERE)/..`
 * 算到 resources/ 上一级 → 找不到 web/index.html → 弹模态框 → 无人点击 → 自检挂死。
 * 复刻布局后主进程不需要任何打包特判（特判越多越容易岔）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 产物
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   desktop/dist/win-unpacked/BWE Studio.exe   ← 双击这个
 *   desktop/dist/BWE Studio.cmd                ← dist 根的便捷入口（不复制第二份 200MB exe）
 *   desktop/tools/run-exe.cmd                  ← 兜底启动脚本（带 --console 便于排查）
 *
 * 用法：
 *   node desktop/tools/package.mjs             # 打包
 *   node desktop/tools/package.mjs --verify    # 打包 + 以 --shot --verify 启动产物做自检
 *   node desktop/tools/package.mjs --clean     # 先清 dist 再打包
 */

import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePng, describePng } from "../lib/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");
const VENDOR = join(DESKTOP, "vendor", "electron");
const DIST = join(DESKTOP, "dist");
const UNPACKED = join(DIST, "win-unpacked");
const APP_DIR = join(UNPACKED, "resources", "app");
const APP_NAME = "BWE Studio";
const VERSION = "0.3.0";

function log(message) {
  console.log(`[package] ${message}`);
}

function fail(message) {
  console.error(`[package] ✗ ${message}`);
  process.exitCode = 1;
}

/** 递归统计目录大小（MB，保留一位小数）。 */
async function dirSize(dir) {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) bytes += (await dirSize(full)) * 1024 * 1024;
    else {
      const info = await stat(full).catch(() => null);
      if (info) bytes += info.size;
    }
  }
  return Math.round(bytes / 1024 / 1024 * 10) / 10;
}

/**
 * 前端 bundle 新鲜度：`web/dist/studio.js` 比 `web/src` 里任何源文件旧，就打进一个过期的编辑器。
 *
 * ⚠ 踩过的真实故障：打包出的 exe 截图是一片奶油底色、UI 骨架计数全 0 ——
 * 因为 app/web/dist/studio.js 是几天前的旧包，而 web/src 早被改过。
 * 打包脚本只看「文件在不在」，就会把这种「文件齐全、内容过期」的包判成成功。
 *
 * 处理：本机有 esbuild（仓库 devDependency，离线可用）就直接重建；没有就报错而不是静默打包。
 * 重建命令与 package.json 的 build 脚本保持一致（改这里要同步那边）。
 */
async function ensureFreshBundle() {
  const distFile = join(REPO, "web", "dist", "studio.js");
  const srcDir = join(REPO, "web", "src");
  const distMtime = (await stat(distFile).catch(() => null))?.mtimeMs ?? 0;
  if (!distMtime) throw new Error(`缺少前端 bundle：${distFile}（先跑 npm run build）`);

  // 取 web/src 下最新的文件 mtime（递归，排除 .build 之类产物目录）。
  const newestSrc = await newestMtime(srcDir, (rel) => !/\/\.build\//.test(rel) && !rel.endsWith(".map"));
  if (newestSrc <= distMtime) {
    log(`前端 bundle 是最新的（${new Date(distMtime).toLocaleString("zh-CN")}）`);
    return;
  }

  const esbuild = process.platform === "win32"
    ? join(REPO, "node_modules", "esbuild", "bin", "esbuild") // esbuild 包内的 JS 入口，用 node 跑
    : join(REPO, "node_modules", "esbuild", "bin", "esbuild");
  const pkg = join(REPO, "node_modules", "esbuild", "package.json");
  if (!existsSync(pkg)) {
    throw new Error(
      "前端 bundle 已过期（web/src 比 web/dist/studio.js 新），但本机找不到 esbuild，无法离线重建。\n"
      + "  请先运行 npm run build，然后重跑打包。"
    );
  }
  log(`前端 bundle 已过期（源文件 ${new Date(newestSrc).toLocaleString("zh-CN")} 更新），先用本地 esbuild 重建…`);
  const r = spawnSync(process.execPath, [
    esbuild,
    join(REPO, "web", "src", "main.ts"),
    "--bundle",
    `--outfile=${distFile}`,
    "--format=esm",
    "--loader:.bwproj=json",
    "--log-level=warning"
  ], { cwd: REPO, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`前端重建失败（esbuild 退出码 ${r.status}）：${(r.stderr || r.stdout || "").slice(0, 800)}`);
  }
  if (r.stderr?.trim()) console.log(`  ${r.stderr.trim().split("\n").slice(0, 5).join("\n  ")}`);
  log(`前端 bundle 已重建（${(await stat(distFile).catch(() => ({ size: 0 }))).size} 字节）`);
}

/** 递归找最新文件 mtime（accept 收到相对路径）。 */
async function newestMtime(dir, accept) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await newestMtime(full, (rel) => accept(`${entry.name}/${rel}`));
      if (nested > newest) newest = nested;
      continue;
    }
    const rel = entry.name;
    if (!accept(rel)) continue;
    const info = await stat(full).catch(() => null);
    if (info) newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
}

/** 必备文件清单：少一个就不算打包成功（不要产出「能启动但白屏」的 exe）。 */
function checkPrerequisites() {
  const problems = [];
  const need = [
    [join(VENDOR, "electron.exe"), "Electron 二进制（先跑 node desktop/tools/fetch-electron.mjs）"],
    [join(REPO, "web", "index.html"), "前端入口 web/index.html"],
    [join(REPO, "web", "dist", "studio.js"), "编辑器 bundle web/dist/studio.js（先跑 npm run build）"],
    [join(DESKTOP, "main.mjs"), "主进程 desktop/main.mjs"],
    [join(DESKTOP, "preload.cjs"), "预加载 desktop/preload.cjs"]
  ];
  for (const [path, what] of need) {
    if (!existsSync(path)) problems.push(`缺少 ${what}：${path}`);
  }
  return problems;
}

/**
 * 复制内嵌 API 的依赖：`desktop/lib/api.mjs` 里 `import "../../web/tools/api-core.mjs"`。
 *
 * ⚠ 踩过的真实故障：漏了这两个文件时，主进程在模块加载期就抛
 * ERR_MODULE_NOT_FOUND（app/web/tools/api-core.mjs），Electron 表现为
 * 「窗口不出现、进程挂着不动」——不打印栈、不退出，最难查的一类。
 * 所以打包脚本必须把它们当**一等产物**，并在验收清单里显式检查。
 *
 * 只复制运行时要用的两个：api-core（纯逻辑）与 package-bwe（打包/试跑依赖）。
 * 不复制 serve.mjs / verify-*.mjs 那些开发脚本（桌面版不跑 HTTP 服务）。
 */
async function copyApiCore() {
  const srcDir = join(REPO, "web", "tools");
  const dstDir = join(APP_DIR, "web", "tools");
  await mkdir(dstDir, { recursive: true });
  const files = ["api-core.mjs", "package-bwe.mjs"];
  for (const name of files) {
    const src = join(srcDir, name);
    if (!existsSync(src)) {
      throw new Error(`内嵌 API 依赖缺失：${src}（桌面版无法启动，请先修仓库）`);
    }
    await copyFile(src, join(dstDir, name));
  }
  log(`内嵌 API 已复制 → web/tools/{${files.join(", ")}}`);
}

/** 复制前端资源：只挑运行时真正需要的，不把 web/.build、node_modules 拖进来。 */
async function copyWebAssets() {
  const webSrc = join(REPO, "web");
  const webDst = join(APP_DIR, "web");
  await mkdir(webDst, { recursive: true });

  // 入口与样式
  await copyFile(join(webSrc, "index.html"), join(webDst, "index.html"));
  await cp(join(webSrc, "styles"), join(webDst, "styles"), { recursive: true });
  // bundle 与它引用的资源（esbuild 拆出来的 chunk/图片都在 dist 下）
  await cp(join(webSrc, "dist"), join(webDst, "dist"), { recursive: true });
  // 示例工程（「打开示例」菜单要用；不含 .build）
  if (existsSync(join(webSrc, "examples"))) {
    await cp(join(webSrc, "examples"), join(webDst, "examples"), { recursive: true });
  }
  // /api/js-check 需要 bwe.d.ts / globals.d.ts，否则只剩语法检查（行为会静默降级）
  if (existsSync(join(webSrc, "src", "js"))) {
    await cp(join(webSrc, "src", "js"), join(webDst, "src", "js"), { recursive: true });
  }
  // SearchApi 工具直接解析 apiDocs.ts（见 lib/ai/apiIndex.mjs），必须带上
  if (existsSync(join(webSrc, "src", "data", "apiDocs.ts"))) {
    await cp(join(webSrc, "src", "data"), join(webDst, "src", "data"), { recursive: true });
  }
  log(`前端资源已复制 → ${relative(UNPACKED, webDst)}`);
}

/** 复制 Java 运行时相关资源（桌面版仍然可以「试跑」和「打包到 BWE」）。 */
async function copyRuntimeAssets() {
  const targets = [
    ["lib", join(REPO, "lib")],
    ["src", join(REPO, "src")],
    ["android", join(REPO, "android")],
    ["tools", join(REPO, "tools")]
  ];
  for (const [rel, src] of targets) {
    if (!existsSync(src)) continue;
    // android 有 61MB 且只在打包 APK 时用；不装 Android 也行，但带上更省事 —— 这里跳过，
    // 用运行时才知道的「仓库路径」兜底（exe 拷到别处时该能力降级，界面会提示）。
    if (rel === "android" || rel === "tools") continue;
    await cp(src, join(APP_DIR, rel), { recursive: true });
  }
  // node_modules/typescript：/api/js-check 与 JS 脚本降级都要它。
  // 整个 node_modules 太大（只挑 typescript 一个包，约 23MB）。
  const ts = join(REPO, "node_modules", "typescript");
  if (existsSync(ts)) {
    await cp(ts, join(APP_DIR, "node_modules", "typescript"), { recursive: true });
    log("TypeScript 已随包带上（/api/js-check 需要）");
  } else {
    log("⚠ 没找到 node_modules/typescript：/api/js-check 会降级成「服务不可用」提示");
  }
}

/** 写 app 自己的 package.json（main 指向 main.mjs；Electron 读它找入口）。 */
async function writeAppManifest() {
  await writeFile(
    join(APP_DIR, "package.json"),
    JSON.stringify(
      {
        name: "bwe-studio-desktop",
        productName: APP_NAME,
        version: VERSION,
        private: true,
        type: "module",
        // Electron 的入口必须在 app 根找：指向复刻出来的 desktop/main.mjs。
        main: "desktop/main.mjs",
        description: "BWE Studio 桌面版"
      },
      null,
      2
    ),
    "utf8"
  );
}

/**
 * 复制 desktop 代码到 resources/app（**复刻仓库的目录布局**）。
 *
 * ⚠ 踩过的真实故障：最初把 app 目录做成「main.mjs 直接躺在 app 根」，
 * 于是 main.mjs 里 `REPO_ROOT = dirname(HERE)/..` 算到了 resources/ 的上一级，
 * 找不到 web/index.html → 弹出「缺少前端文件」模态框 → 无人点击 → 打包自检超时挂死。
 *
 * 现在统一布局：app/desktop/... + app/web/... ，与仓库一模一样，
 * 主进程的相对路径逻辑**不需要任何打包特判**（这点很关键：特判越多越容易岔）。
 * 但 Electron 要求 resources/app/package.json 的 main 指向真实入口，所以写 desktop/main.mjs。
 */
async function copyDesktopCode() {
  const appDesktop = join(APP_DIR, "desktop");
  await mkdir(appDesktop, { recursive: true });
  await copyFile(join(DESKTOP, "main.mjs"), join(appDesktop, "main.mjs"));
  await copyFile(join(DESKTOP, "preload.cjs"), join(appDesktop, "preload.cjs"));
  await cp(join(DESKTOP, "lib"), join(appDesktop, "lib"), { recursive: true });
  await cp(join(DESKTOP, "test"), join(appDesktop, "test"), { recursive: true }).catch(() => {});
  await writeFile(
    join(APP_DIR, "README-app.txt"),
    [
      "BWE Studio 桌面版应用目录。",
      "",
      "⚠ 这里刻意复刻仓库的目录布局，而不是把 main.mjs 摊在 app 根：",
      "  app/desktop/main.mjs      ← desktop/main.mjs（它内部的 ../ 路径因此无需特判）",
      "  app/desktop/preload.cjs   ← desktop/preload.cjs",
      "  app/desktop/lib/**        ← desktop/lib/**",
      "  app/web/**                ← web/index.html + web/dist + web/styles + web/examples",
      "  app/lib，app/src          ← Java 运行时依赖（试跑/打包时用）",
      "  app/node_modules/typescript ← /api/js-check 需要",
      "",
      "Electron 通过 app/package.json 的 main 字段找到入口（desktop/main.mjs）。",
      "",
      "双击上级目录的「BWE Studio.exe」启动。",
      "排查启动问题：在 cmd 里运行",
      '  "BWE Studio.exe" --console',
      "截图验收：",
      '  "BWE Studio.exe" --shot=D:/tmp/shot.png --size=1600x1000 --console',
      "",
      "离线说明：本目录不包含任何下载脚本；Electron 二进制来自 desktop/vendor/electron。"
    ].join("\n"),
    "utf8"
  );
}

/** 复制 Electron 运行时到 win-unpacked（不含 resources/default_app.asar，我们自带 app）。 */
async function copyElectronRuntime() {
  await cp(VENDOR, UNPACKED, {
    recursive: true,
    filter: (src) => {
      const rel = relative(VENDOR, src).replace(/\\/g, "/");
      // default_app.asar 是「没有 app 时」的兜底界面，留着会让人误以为我们的入口没生效。
      if (rel === "resources/default_app.asar") return false;
      return true;
    }
  });
}

/**
 * 改名复制一份 exe（**不修改 vendor 里的原文件**，开发模式仍可复用）。
 *
 * 体积取舍：electron.exe 本身 ~200MB，如果「保留原名 + 再复制一份 + dist 根再来一份」，
 * 就会白白多出 400MB。所以这里：
 *   1. 先复制成 `BWE Studio.exe`；
 *   2. 删掉 win-unpacked 里的 electron.exe（vendor 里的原件一个字节没动）；
 *   3. dist 根不再放第二份二进制，只放 run-exe.cmd 指过去。
 */
async function renameExe() {
  const src = join(UNPACKED, "electron.exe");
  const dst = join(UNPACKED, `${APP_NAME}.exe`);
  await copyFile(src, dst);
  await rm(src, { force: true });

  // dist 根放一个「双击就能起」的入口：一个 1KB 的 cmd，而不是再复制 200MB。
  await writeFile(
    join(DIST, `${APP_NAME}.cmd`),
    [
      "@echo off",
      "rem 直接从 dist 根启动打包产物（不复制第二份 200MB 的 exe）。",
      `set ELECTRON_RUN_AS_NODE=`,
      `"%~dp0win-unpacked\\${APP_NAME}.exe" --console %*`,
      "exit /b %ERRORLEVEL%"
    ].join("\r\n"),
    "utf8"
  );
  log(`已生成可执行文件：dist/win-unpacked/${APP_NAME}.exe（原 electron.exe 已移除，vendor 原件未改）`);
}

/** 兜底启动脚本：--console 打开，出问题能看到渲染侧日志。 */
async function writeRunnerCmd() {
  // ⚠ 两个踩过的坑，都写在这里防止再犯：
  //
  // 1. **必须用 %~dp0 而不是相对路径**：脚本被别人从仓库根、从 dist 目录、
  //    甚至拖到桌面双击时，`..\dist\...` 全都会失效（实测「找不到 BWE Studio.exe」）。
  //    %~dp0 是「本脚本所在目录」，永远正确。
  //
  // 2. **文件里只许有 ASCII**（注释也用英文）：cmd.exe 对 UTF-8 处理很差 ——
  //    加 BOM 会让 `@echo off` 失效（整个脚本回显成乱码 + 命令被执行），
  //    不加 BOM 中文注释又会变问号。所以这个 .cmd 刻意保持纯 ASCII，
  //    说明文字放在 desktop/README.md 里（那边可以随便用中文）。
  const cmd = [
    "@echo off",
    "rem Launcher for the packaged build. Always passes --console so startup errors are visible.",
    "rem Usage (from any directory): desktop\\tools\\run-exe.cmd [extra args]",
    "rem   run-exe.cmd --shot=D:/tmp/shot.png --size=1600x1000",
    "rem   run-exe.cmd --shot=D:/tmp/ai.png --tap=\"[data-panel-tab=ai]\"",
    `set "EXE=%~dp0..\\dist\\win-unpacked\\${APP_NAME}.exe"`,
    "if not exist \"%EXE%\" goto missing",
    "rem Some environments set ELECTRON_RUN_AS_NODE=1, which makes Electron run as plain Node.",
    "rem main.mjs fixes this itself; clearing it here is a second safety net.",
    "set ELECTRON_RUN_AS_NODE=",
    "\"%EXE%\" --console %*",
    "set CODE=%ERRORLEVEL%",
    "echo [run-exe] exit code %CODE%",
    "exit /b %CODE%",
    ":missing",
    "echo [run-exe] BWE Studio.exe not found. Run: node desktop/tools/package.mjs",
    "exit /b 1"
  ].join("\r\n");
  await writeFile(join(DESKTOP, "tools", "run-exe.cmd"), `${cmd}\r\n`, "latin1");
  log("已生成 desktop/tools/run-exe.cmd（纯 ASCII，避免 cmd.exe 编码问题）");
}

/**
 * --verify：用产物的 --shot 模式真正启动一次，检查 PNG 存在且非空白。
 *
 * 为什么必须做：打包最容易「看起来成功」—— 文件都在，但 exe 双击白屏。
 * 唯一可信的验收是「真的启动、真的截到有内容的图」。
 */
async function verifyProduct() {
  const exePath = join(UNPACKED, `${APP_NAME}.exe`);
  if (!existsSync(exePath)) {
    fail(`找不到产物 ${exePath}`);
    return false;
  }
  const outDir = join(REPO, ".tmp_desk");
  await mkdir(outDir, { recursive: true });
  const shotPath = join(outDir, "pack-verify.png");
  await rm(shotPath, { force: true });

  log(`启动产物做截图自检：${exePath}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 见 main.mjs 的说明
  const r = spawnSync(exePath, [`--shot=${shotPath}`, "--size=1600x1000", "--verify", "--console"], {
    cwd: UNPACKED,
    env,
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  for (const line of output.split(/\r?\n/)) {
    if (line.trim()) console.log(`  ${line}`);
  }
  if (!existsSync(shotPath)) {
    fail(`自检失败：没有生成截图（exe 退出码 ${r.status}）`);
    // 打包后页面加载失败是最容易坏的地方：可能是 app/web 下相对路径失效。
    // 把 did-fail-load 的 code / URL 与渲染侧日志一起打出来，避免只丢一句「没截图」。
    const failed = output.split(/\r?\n/).filter((l) => /did-fail-load|bwe:page|bwe:crash|缺少前端|ERR_/.test(l));
    if (failed.length) {
      console.error("[package] 启动失败的原始线索：");
      for (const line of failed.slice(0, 20)) console.error(`  ${line}`);
    } else if (r.error) {
      console.error(`[package] 进程错误：${r.error.message}`);
    } else {
      console.error(
        "[package] 既没有截图也没有加载失败日志 —— 进程可能挂住了。\n"
        + "  常见原因：主进程在模块加载期就抛错（例如漏了 web/tools/api-core.mjs），\n"
        + "  或弹出了模态框在等人点击（截图模式应当避免）。"
      );
    }
    return false;
  }
  const png = readFileSync(shotPath);
  let stats;
  try {
    stats = analyzePng(png);
  } catch (e) {
    fail(`自检失败：截图不是合法 PNG（${e.message}）`);
    return false;
  }
  console.log(`  截图自检：${describePng(stats)}`);
  // 双尺寸验收：exe 自己会跑 1600x1000 + 1280x720 并各自断言，这里的 ok 只需要
  // 「进程 exit 0 + 第一张图非空白 + 非背景占比合理」；具体尺寸判定看上面 [verify] 行。
  const verifyLine = output.split(/\r?\n/).find((l) => l.includes("[verify] 结论"));
  if (verifyLine) console.log(`  ${verifyLine.replace(/^\[package\]\s*/,"")}`);
  const ok = r.status === 0 && !stats.isEmpty && stats.foregroundRatio > 0.05;
  if (ok) {
    log(
      `自检通过：尺寸 ${stats.width}x${stats.height}，非背景像素 ${(stats.foregroundRatio * 100).toFixed(1)}%`
      + (verifyLine ? `（${verifyLine.split("：").pop()}）` : "")
    );
    return true;
  }
  fail(
    `自检未通过：退出码 ${r.status}，空白=${stats.isEmpty}，非背景像素 ${(stats.foregroundRatio * 100).toFixed(1)}%。`
    + `\n  典型原因：web/dist/studio.js 没构建（跑 npm run build）、页面脚本报错（看上面渲染侧日志）。`
  );
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const doVerify = argv.includes("--verify");
  const doClean = argv.includes("--clean");

  log(`离线打包 ${APP_NAME} v${VERSION}`);
  let problems = checkPrerequisites();
  if (problems.length) {
    // vendor 缺失时先尝试本机缓存重建（fetch-electron 里有完整提示）。
    if (problems.some((p) => p.includes("Electron"))) {
      log("vendor 缺失，尝试从本机 electron 缓存离线重建…");
      spawnSync(process.execPath, [join(HERE, "fetch-electron.mjs")], { stdio: "inherit", windowsHide: true });
      problems = checkPrerequisites();
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`[package] ✗ ${p}`);
    process.exitCode = 1;
    return;
  }

  // 前端 bundle 过期 = 打进去一个和当前源码不符的编辑器；必须重建再用。
  await ensureFreshBundle();

  if (doClean) {
    await rm(DIST, { recursive: true, force: true });
    log("已清空 dist/");
  }
  await rm(UNPACKED, { recursive: true, force: true });
  await mkdir(APP_DIR, { recursive: true });

  const t0 = Date.now();
  await copyElectronRuntime();
  log("Electron 运行时已复制");
  await copyDesktopCode();
  await writeAppManifest();
  await copyWebAssets();
  await copyApiCore();
  await copyRuntimeAssets();
  await renameExe();
  await writeRunnerCmd();

  const sizeMb = await dirSize(UNPACKED);
  log(`打包完成：${UNPACKED}（${sizeMb} MB，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  // 验收清单
  const checks = [
    [join(APP_DIR, "desktop", "main.mjs"), "desktop/main.mjs"],
    [join(APP_DIR, "desktop", "preload.cjs"), "desktop/preload.cjs"],
    [join(APP_DIR, "package.json"), "app/package.json"],
    [join(APP_DIR, "web", "index.html"), "web/index.html"],
    [join(APP_DIR, "web", "dist", "studio.js"), "web/dist/studio.js"],
    [join(APP_DIR, "web", "src", "js", "bwe.d.ts"), "web/src/js/bwe.d.ts（js-check 用）"],
    [join(APP_DIR, "web", "src", "data", "apiDocs.ts"), "web/src/data/apiDocs.ts（SearchApi 用）"],
    [join(APP_DIR, "web", "tools", "api-core.mjs"), "web/tools/api-core.mjs（内嵌 API，缺了主进程起不来）"],
    [join(APP_DIR, "web", "tools", "package-bwe.mjs"), "web/tools/package-bwe.mjs（试跑/打包用）"],
    [join(UNPACKED, `${APP_NAME}.exe`), `${APP_NAME}.exe`]
  ];
  let allOk = true;
  for (const [path, label] of checks) {
    if (existsSync(path)) log(`  ✓ ${label}`);
    else {
      allOk = false;
      console.error(`[package] ✗ 缺少 ${label}`);
    }
  }
  if (!allOk) {
    process.exitCode = 1;
    return;
  }
  log(`双击启动：${join(UNPACKED, `${APP_NAME}.exe`)}`);

  if (doVerify) {
    const ok = await verifyProduct();
    if (!ok) process.exitCode = 1;
  } else {
    log("（加 --verify 会以 --shot 模式真实启动产物并检查截图非空白）");
  }
}

main().catch((e) => {
  console.error(`[package] 打包失败：${e?.stack || e?.message || e}`);
  process.exitCode = 1;
});
