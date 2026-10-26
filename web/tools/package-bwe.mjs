/**
 * 把 Web 编辑器里的 .bwproj 打包成 Windows 应用目录（内含 .exe）。
 *
 * 这是「打包到 BWE」的后端：
 *   1. 把 Web 工程转换成 Java 运行时认识的 Build/boot.json + Build/scene_*.json；
 *   2. 写入浏览器上传的 PNG 素材；
 *   3. 编译 Studio.runtime，打包 JOGL/Gson 与原生 DLL；
 *   4. 调用 jpackage --type app-image，生成 app/<名称>.exe；
 *   5. 压缩成 zip，供浏览器下载。
 *
 * 这里不依赖任何 npm 依赖，只用 Node 标准库和本机 JDK。
 *
 * 用法：
 *   node web/tools/package-bwe.mjs <工程.bwproj> [--out 目录] [--name 名称] [--version 1.0.0] [--debug]
 *
 * 注意：命令行模式只能打包工程里以 data URL 形式内嵌的 PNG/JPG 素材；
 * 浏览器里导入的 blob 素材需要通过 npm run serve 的 /api/package-bwe 上传。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 只用于把 JS 脚本降级到 ES5（Rhino 1.7.15 只认 ES5.1）。
// typescript 已是本仓库的 devDependency，不新增任何依赖；
// 这里用 require 而不是顶层 import，是为了「只打 Yarn 剧本的工程」不加载 TypeScript、启动更快。
const nodeRequire = createRequire(import.meta.url);
let tsModule = null;

function loadTypeScript() {
  if (tsModule) return tsModule;
  try {
    tsModule = nodeRequire("typescript");
  } catch (e) {
    throw new Error(
      `找不到 TypeScript 编译器，无法把 JS 脚本降级到 ES5。请在项目根目录执行 npm install。（${e?.message || e}）`
    );
  }
  return tsModule;
}

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(webRoot, "..");
const libRoot = join(projectRoot, "lib");
const runtimeSrc = join(projectRoot, "src", "Studio", "runtime");
const packageRoot = join(webRoot, ".build", "packages");

const SAFE_APP_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

function logStep(onLog, message) {
  if (onLog) onLog(message);
  else console.log(message);
}

function safeSegment(value, fallback) {
  const v = String(value ?? "").replace(SAFE_APP_CHARS, "").trim();
  return v || fallback;
}

function safeId(value) {
  return String(value ?? "asset").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function safeVersion(value) {
  const v = String(value ?? "1.0.0").replace(/[^0-9.]/g, "");
  const parts = v.split(".").filter(Boolean);
  while (parts.length < 3) parts.push("0");
  return parts.slice(0, 3).join(".") || "1.0.0";
}

function safeFileName(name, fallback) {
  const base = basename(String(name ?? "")).replace(SAFE_APP_CHARS, "_");
  return base || fallback;
}

function extensionForMime(mime) {
  if (!mime) return ".png";
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("wav")) return ".wav";
  if (mime.includes("mpeg")) return ".mp3";
  if (mime.includes("ogg")) return ".ogg";
  return ".png";
}

function extensionForAsset(asset, fallback = ".png") {
  const p = asset?.path ? extname(String(asset.path)) : "";
  if (p) return p;
  return fallback;
}

// ---------------- JS 脚本：降级到 ES5 ----------------

/**
 * 把编辑器里的现代 JS 降级成 Rhino 1.7.15 能吃下的 ES5。
 *
 * 与 /api/js-check 用的是同一套 TypeScript（这里只做 transpile，诊断由编辑器面板负责）。
 * 返回 { code, diagnostics }：
 *   - code 是最终写进 Build/scripts/*.js 的内容；
 *   - diagnostics 是已经拼好「脚本名 + 行号 + 列号」的告警文本，
 *     transpileModule 在语法错误时也会尽量产出代码，所以「有诊断」不等于「没代码」，
 *     但运行时执行这段脚本必然报错，必须让用户看见。
 */
function transpileJsScript(source, scriptName, fileName) {
  const ts = loadTypeScript();
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      // 脚本共享一个全局作用域（没有 import/export），module 必须是 None。
      module: ts.ModuleKind.None,
      // 不生成 "use strict"：脚本里常见的「给未声明变量赋值」在 ES5 全局作用域下才合法。
      alwaysStrict: false,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed
    },
    // 用 .ts 作为文件名：脚本按 TypeScript 语法解析（允许 `const n: number = 1` 这类标注），
    // 输出仍然是纯 ES5。用 .js 会把 TS 标注直接报成语法错误。
    fileName,
    reportDiagnostics: true
  });
  const diagnostics = (result.diagnostics ?? [])
    // 没有 d.file 的是「选项级」诊断（例如 transpileModule 内部的 isolatedModules 提示），
    // 与用户脚本无关，不能混进「第 N 行」的告警里。
    .filter((d) => d.file)
    .map((d) => {
      let where = "";
      if (d.file && typeof d.start === "number") {
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        where = `第 ${pos.line + 1} 行第 ${pos.character + 1} 列：`;
      }
      const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
      return `脚本「${scriptName}」${where}${message}`;
    });
  return { code: result.outputText ?? "", diagnostics };
}

/** 脚本名 → Build/scripts 下唯一的文件名（不含 .js），中文保留，非法字符去掉。 */
function uniqueScriptBase(name, fallback, usedLower) {
  const base = safeSegment(name, fallback || "script").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim()
    || "script";
  let candidate = base;
  for (let n = 2; usedLower.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}`;
  usedLower.add(candidate.toLowerCase());
  return candidate;
}

// ---------------- 导出格式的小工具 ----------------
//
// 导出格式是「编辑器 ↔ 运行时」唯一的契约。运行时（GameData.java）用 int 读
// width / height / tileSize / z，用 float 读坐标；编辑器里这些字段允许出现小数。
// 不在这里显式取整 + 告警，Gson 会静默截断，最后表现成「位置整体偏一点」这种
// 最难查的错位，所以每个字段都走同一套容错函数。

/** 同一条告警只保留一次，避免逐对象刷屏。 */
function warnOnce(warnings, message) {
  if (!warnings) return;
  if (!warnings.includes(message)) warnings.push(message);
}

/** 读一个数字：空值用默认值，非数字退回默认值并告警。 */
function finiteNumber(value, fallback, label, warnings) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    if (label) warnOnce(warnings, `${label} 不是数字（${JSON.stringify(value)}），已按 ${fallback} 导出`);
    return fallback;
  }
  return n;
}

/** 运行时用 int 读的正数字段（widthTiles / heightTiles / tileSize）。 */
function positiveIntField(value, fallback, label, warnings) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  const rounded = Math.round(raw);
  if (rounded !== raw) {
    warnOnce(warnings, `${label} 是小数 ${raw}，运行时按整数读取，已取整为 ${rounded}`);
  }
  return Math.max(1, rounded);
}

/** 运行时用 int 读的 z：显式截断并告警，避免排序顺序悄悄变。 */
function truncIntField(value, fallback, label, warnings) {
  const raw = finiteNumber(value, fallback, label, warnings);
  const truncated = Math.trunc(raw);
  if (truncated !== raw) {
    warnOnce(warnings, `${label} 是小数 ${raw}，运行时按整数读取，已截断为 ${truncated}`);
  }
  return truncated;
}

/**
 * 模块参数里「填素材名」的键（编辑器 moduleEditor 存的是素材名，不是 id）。
 * 运行时按名字找图（GameData.assetByName），名字对不上就静默退回色块，
 * 所以导出时逐项校验，缺素材必须显式告警。
 */
const ASSET_REF_PARAM_KEYS = new Set([
  "asset",
  "hiddenAsset",
  "mineAsset",
  "flagAsset",
  "backgroundAsset",
  "attackAnim",
  "projectileSprite",
  "hurtSfx",
  "dropSprite",
  "portrait",
  "promptIcon",
  "sfx"
]);
/** 逗号/中文逗号/顿号/竖线分隔的素材名列表（换装部件的造型列表）。 */
const ASSET_LIST_PARAM_KEYS = new Set(["optionAssets"]);

/** 序列帧在编辑器里「能被看到」的帧数（排除被用户隐藏的帧）。 */
function visibleFrameCount(asset) {
  const total = Math.max(1, Math.trunc(finiteNumber(asset?.frameCount, 1)));
  const hidden = new Set((asset?.hiddenFrames ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n)));
  let visible = 0;
  for (let i = 0; i < total; i++) {
    if (!hidden.has(i)) visible++;
  }
  return Math.max(1, visible);
}

/** 素材没打包进 Build 时，给用户一句能行动的原因。 */
function missingAssetReason(asset, problem) {
  if (problem) return String(problem);
  const url = typeof asset?.url === "string" ? asset.url : "";
  if (asset?.src === "url" && url.startsWith("data:")) {
    if (/^data:image\/svg\+xml/i.test(url)) return "命令行模式不能栅格化 SVG，请用 npm run serve 的浏览器打包入口";
    return "data URL 解码失败";
  }
  if (asset?.src === "url" && url) return "命令行模式不会下载远程 URL";
  if (asset?.src === "blob") return "素材二进制在浏览器 IndexedDB 里，浏览器打包时需要重新读取";
  return "";
}

/** 浏览器上传的素材：{ id, files: [{ name, data(base64) }], error? } */
function normalizeUploadedAssets(payload) {
  const files = new Map();
  const problems = new Map();
  for (const item of payload ?? []) {
    if (!item || !item.id) continue;
    const list = Array.isArray(item.files) ? item.files : [];
    files.set(item.id, list.map((f) => ({
      name: safeFileName(f.name, "file.png"),
      data: Buffer.from(String(f.data ?? ""), "base64")
    })));
    if (list.length === 0) {
      problems.set(item.id, item.error ? String(item.error) : "浏览器没拿到素材文件");
    }
  }
  return { files, problems };
}

/**
 * 命令行模式：把 data URL 素材落成文件。
 *
 * 命令行拿不到 IndexedDB 里的 blob，也不会去下载远程 URL；这些素材会在
 * writeBuild 里按「没有文件」显式告警，而不是安静地变成空图。
 * 返回 problems 让 writeBuild 能给出一句具体原因。
 */
async function collectDataUrlAssets(project, onLog) {
  const files = new Map();
  const problems = new Map();
  for (const asset of project.assets ?? []) {
    const label = `素材「${asset?.name || asset?.id || "未命名"}」`;
    if (asset?.src !== "url" || typeof asset.url !== "string" || !asset.url.startsWith("data:")) {
      continue;
    }
    // data URL 允许带任意参数（例如 data:image/svg+xml;charset=utf-8,...），
    // 旧实现用 (;base64)? 硬匹配参数，带 charset 的 URL 会整条解析失败、素材被静默丢掉。
    const m = /^data:([^,]*),(.*)$/s.exec(asset.url);
    if (!m) {
      problems.set(asset.id, "data URL 解析失败");
      continue;
    }
    const meta = m[1].split(";").map((s) => s.trim());
    const mime = (meta.shift() || "application/octet-stream").toLowerCase();
    const isBase64 = meta.some((p) => p.toLowerCase() === "base64");
    const kind = String(asset.kind ?? "IMAGE").toUpperCase();
    if (mime.includes("svg")) {
      problems.set(asset.id, "命令行模式不能栅格化 SVG，请用 npm run serve 的浏览器打包入口");
      logStep(onLog, `跳过 SVG 素材「${asset.name}」：命令行模式不能栅格化，请用 Web 打包入口。`);
      continue;
    }
    if (kind !== "AUDIO" && !mime.startsWith("image/")) {
      problems.set(asset.id, `data URL 的类型是 ${mime}，不是图片`);
      continue;
    }
    let data;
    try {
      data = isBase64 ? Buffer.from(m[2], "base64") : Buffer.from(decodeURIComponent(m[2]), "utf8");
    } catch {
      problems.set(asset.id, "data URL 解码失败");
      continue;
    }
    const ext = extensionForMime(mime);
    if (kind === "SEQUENCE") {
      // 命令行里没有序列帧的逐帧 data URL，只能作为单帧使用。
      files.set(asset.id, [{ name: "frame1" + ext, data }]);
    } else {
      files.set(asset.id, [{ name: "main" + ext, data }]);
    }
  }
  return { files, problems };
}

/**
 * 素材在 boot.assets 里的运行时描述（对应 GameData.RtAsset）。
 *
 * 路径统一写成 `Build/assets/<素材 id>/<文件>`；运行时 assetRoot 是 Build 的父目录
 * （GameData.resolveRoot），拼出来正好指向同一个文件。命令行与浏览器共用本函数，
 * 所以两边的 assetRoot / path 约定始终一致。
 */
function runtimeAsset(asset, files, relativeDir) {
  const kind = String(asset.kind ?? "IMAGE").toUpperCase();
  const cols = Math.max(1, Math.trunc(finiteNumber(asset.cols, 1)));
  const rows = Math.max(1, Math.trunc(finiteNumber(asset.rows, 1)));
  const runtime = {
    id: asset.id,
    name: asset.name ?? "",
    kind,
    path: "",
    head: "",
    // 序列帧 + 图集都可能有动画：图集帧数来自 cols×rows（与编辑器 totalFrames 一致）。
    frames: kind === "ATLAS" ? cols * rows : 1,
    cols,
    rows,
    cellW: Math.max(0, Math.trunc(finiteNumber(asset.cellW, 0))),
    cellH: Math.max(0, Math.trunc(finiteNumber(asset.cellH, 0))),
    // Web 编辑器没有 zeroBased 字段：序列帧一律从 frame1.png 开始，命令行也写 frame1，
    // 所以固定 false，和 TopDownRuntime.loadActorFrames 的读取方式一致。
    zeroBased: false
  };
  if (!files || files.length === 0) return runtime;

  const dirId = safeId(asset.id);
  if (kind === "SEQUENCE") {
    runtime.path = `${relativeDir}/${dirId}`;
    // 前端和 CLI 都把序列帧写成 frame1.png / frame2.png...，这里保持同一个契约。
    runtime.head = "frame";
    runtime.frames = files.length;
  } else {
    runtime.path = `${relativeDir}/${dirId}/${files[0].name}`;
  }
  return runtime;
}

const IMAGEIO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp"]);

/** Java ImageIO 只认这几种格式；其他格式一律显式告警，别等玩家看到空白。 */
function warnIfUndecodable(fileName, label, warnings) {
  const ext = extname(String(fileName ?? "")).toLowerCase();
  if (!ext) return;
  if (ext === ".webp") {
    warnOnce(warnings, `${label}：WebP 图片 Java ImageIO 读不了，运行时看不到这张图（浏览器打包会自动转 PNG）`);
  } else if (ext === ".svg") {
    warnOnce(warnings, `${label}：SVG 不能直接给 Java 运行时用，会读不出图（浏览器打包会自动栅格化成 PNG）`);
  } else if (!IMAGEIO_EXTENSIONS.has(ext)) {
    warnOnce(warnings, `${label}：文件扩展名 ${ext} 不在 Java ImageIO 支持范围，运行时可能读不出图`);
  }
}

async function writeAssetFiles(inputDir, project, asset, files, onLog, warnings) {
  if (!files || files.length === 0) return;
  const label = `素材「${asset?.name || asset?.id || "未命名"}」`;
  const isAudio = String(asset?.kind ?? "").toUpperCase() === "AUDIO";
  const dir = join(inputDir, "Build", "assets", safeId(asset.id));
  await mkdir(dir, { recursive: true });
  if (asset.kind === "SEQUENCE") {
    for (let i = 0; i < files.length; i++) {
      const target = join(dir, `frame${i + 1}.png`);
      // 序列帧统一按 PNG 输出；浏览器端已负责转 PNG，命令行可能给 jpg，ImageIO 按内容解码。
      if (!isAudio) warnIfUndecodable(files[i].name, label, warnings);
      await writeFile(target, files[i].data);
    }
    onLog?.(`素材「${asset.name}」：${files.length} 帧`);
  } else {
    const name = safeFileName(files[0].name, "main.png");
    if (!isAudio) warnIfUndecodable(name, label, warnings);
    await writeFile(join(dir, name), files[0].data);
    onLog?.(`素材「${asset.name}」：${name}`);
  }
}

/** 校验模块参数里引用的素材名是否真的存在于素材库。 */
function checkAssetRefs(def, owner, params, assetNames, warnings) {
  for (const [key, value] of Object.entries(params)) {
    let names = [];
    if (ASSET_LIST_PARAM_KEYS.has(key)) {
      names = String(value).split(/[,，、|]/).map((s) => s.trim()).filter(Boolean);
    } else if (ASSET_REF_PARAM_KEYS.has(key)) {
      const single = String(value).trim();
      if (single) names = [single];
    } else {
      continue;
    }
    for (const name of names) {
      if (name === "无" || name.toLowerCase() === "transparent") continue;
      if (!assetNames.has(name)) {
        warnOnce(
          warnings,
          `对象「${owner}」的模块「${def}」参数 ${key} 引用了素材名「${name}」，素材库里没有这个名字；运行时会用占位色块`
        );
      }
    }
  }
}

function moduleJson(m, owner, assetNames, warnings) {
  if (!m || m.enabled === false) return null;
  const def = String(m.defId ?? "").trim();
  const params = {};
  for (const [key, value] of Object.entries(m.values ?? {})) {
    if (value == null) {
      // 空值原样保留成空串：运行时的 str()/num() 用它判断「没填，用默认值」。
      params[key] = "";
    } else if (typeof value === "string") {
      // 模型里 values 全部是字符串：布尔是「开/关」、枚举是中文标签、素材引用是素材名，
      // 这里绝不能 Number()/Boolean() 化，否则编码会被改写。
      params[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      params[key] = String(value);
    } else {
      // 出现对象/数组说明工程被手改过；保留 JSON 文本，并告警而不是静默变成 [object Object]。
      params[key] = JSON.stringify(value);
      warnOnce(warnings, `对象「${owner}」的模块「${def}」参数 ${key} 不是字符串，已按 JSON 文本导出`);
    }
  }
  checkAssetRefs(def, owner, params, assetNames, warnings);
  return {
    def,
    // trigger 为 null 时编辑器会取模块定义的首选时机；运行时当前不按 when 门控，
    // 导出成 ALWAYS 与「一直生效」的模块语义一致（见报告「已知差异」）。
    when: m.trigger == null || m.trigger === "" ? "ALWAYS" : String(m.trigger),
    label: m.label == null ? "" : String(m.label),
    params
  };
}

const KNOWN_ANIM_MODES = new Set(["默认", "只显示首帧", "单次播放", "PLAY_ONCE"]);

function objectJson(o, layerIndex, layerVisible, runtimeAssets, assetEntry, assetNames, warnings) {
  const owner = String(o?.name || o?.id || "未命名对象");
  const modules = (o?.modules ?? []).map((m) => moduleJson(m, owner, assetNames, warnings)).filter(Boolean);
  const rtAsset = runtimeAssets.get(o.assetId) ?? null;
  if (o.assetId && !assetEntry) {
    warnOnce(warnings, `对象「${owner}」引用了不存在的素材 id「${o.assetId}」，运行时会画成色块`);
  }
  const selfVisible = o.visible !== false;
  const scaleX = finiteNumber(o.scaleX, 1, `对象「${owner}」的 scaleX`, warnings);
  const scaleY = finiteNumber(o.scaleY, 1, `对象「${owner}」的 scaleY`, warnings);
  if (scaleX === 0 || scaleY === 0) {
    warnOnce(warnings, `对象「${owner}」的 scale 为 0：编辑器里尺寸为 0（看不见），运行时同样按 0 处理，不会画出来`);
  }
  const animMode = o.animMode == null || o.animMode === "" ? "默认" : String(o.animMode);
  if (!KNOWN_ANIM_MODES.has(animMode)) {
    warnOnce(warnings, `对象「${owner}」的 animMode「${animMode}」运行时不认识，会按「默认」循环播放`);
  }
  const animFpsRaw = finiteNumber(o.animFps, 8, `对象「${owner}」的 animFps`, warnings);
  return {
    id: o.id,
    kind: o.kind,
    name: o.name ?? "",
    x: finiteNumber(o.x, 0, `对象「${owner}」的 x`, warnings),
    y: finiteNumber(o.y, 0, `对象「${owner}」的 y`, warnings),
    z: truncIntField(o.z, 0, `对象「${owner}」的 z`, warnings),
    rotation: finiteNumber(o.rotation, 0, `对象「${owner}」的 rotation`, warnings),
    scaleX,
    scaleY,
    halfW: finiteNumber(o.halfW, 0, `对象「${owner}」的 halfW`, warnings),
    halfH: finiteNumber(o.halfH, 0, `对象「${owner}」的 halfH`, warnings),
    // 合成规则（与编辑器 canvas.paint 一致）：图层隐藏 → 对象不画；图层可见 → 看对象自己的 visible。
    // 运行时只读 visible，所以必须导出合成结果，否则隐藏图层在游戏里会重新出现。
    visible: selfVisible && layerVisible !== false,
    // 编辑器原始字段，运行时当前不读；保留是为了不让「对象自身隐藏 / 图层隐藏」这两个信息在导出时合并丢失。
    visibleSelf: selfVisible,
    // 编辑器绘制顺序真值是 layer（图层数组下标）→ z → y（web/src/app/canvas.ts orderObjects）。
    // 运行时按 layer → z → y 排序，缺了这个字段跨图层遮挡关系就会错。
    layer: layerIndex,
    layerId: o.layerId ?? "",
    parentId: o.parentId ?? null,
    assetId: o.assetId ?? "",
    assetName: assetEntry?.name ?? "",
    asset: rtAsset,
    animMode,
    // 编辑器 pickFrame：animFps > 0 ? animFps : 8；照抄，避免 0/负数两边表现不同。
    animFps: animFpsRaw > 0 ? animFpsRaw : 8,
    tags: Array.isArray(o.tags) ? o.tags : [],
    modules,
    // props 必须原样透传：painter.sizeOf 的第二优先级是 props.w / props.h（还要乘 scale），
    // 运行时（TopDownRuntime.sizeOf）也读这两个键。这里不做 Number()/过滤，空串也保留。
    props: o.props && typeof o.props === "object" ? o.props : {}
  };
}

async function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      env: process.env
    });
    let out = "";
    let err = "";
    p.stdout?.on("data", (d) => {
      out += d.toString();
      options.onStdout?.(d.toString());
    });
    p.stderr?.on("data", (d) => {
      err += d.toString();
      options.onStderr?.(d.toString());
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolvePromise({ out, err });
      else reject(new Error(`${command} 退出码 ${code}\n${out}\n${err}`.trim()));
    });
  });
}

async function commandExists(name) {
  try {
    await run("where", [name]);
    return true;
  } catch {
    return false;
  }
}

async function runtimeSources() {
  const files = await readdir(runtimeSrc);
  return files
    .filter((f) => f.endsWith(".java") && f !== "GameLauncher.java")
    .map((f) => join(runtimeSrc, f));
}

async function extractNatives(inputDir) {
  const nativesDir = join(inputDir, "natives");
  await mkdir(nativesDir, { recursive: true });
  const libs = await readdir(libRoot);
  const jars = libs.filter((f) => /natives-windows-amd64\.jar$/i.test(f));
  if (jars.length === 0) {
    throw new Error("lib/ 下找不到 JOGL 原生库 jar");
  }
  for (const jar of jars) {
    try {
      await run("jar", ["xf", join(libRoot, jar)], { cwd: nativesDir });
    } catch (e) {
      // 少数环境没有 jar 命令时退回 tar（Windows 10+ 自带）。
      await run("tar", ["-xf", join(libRoot, jar), "-C", nativesDir]);
    }
  }
  await rm(join(nativesDir, "META-INF"), { recursive: true, force: true });
}

async function copyRuntimeLibraries(inputDir) {
  const libs = await readdir(libRoot);
  // rhino 是 JS 脚本运行时（ScriptEngine 内嵌 Rhino 1.7.15 执行 ES5 脚本）；
  // 少了它，打包出来的游戏一碰脚本就会 NoClassDefFoundError。
  const wanted = libs.filter((f) => /^(gson|jogl-all|gluegen-rt|rhino)-.*\.jar$/i.test(f));
  if (wanted.length === 0) throw new Error("lib/ 下找不到运行时依赖 jar");
  if (!wanted.some((f) => /^rhino-/i.test(f))) {
    throw new Error("lib/ 下找不到 rhino-*.jar：JS 脚本运行不了，请确认 lib/rhino-1.7.15.jar 存在");
  }
  for (const f of wanted) {
    await copyFile(join(libRoot, f), join(inputDir, f));
  }
}

// ---------------- JDK 探测（试跑与打包共用） ----------------
//
// 现实教训（四组对照实测）：
//   Oracle 26 / Microsoft 25 裸跑 → JOGL 2.1 的 WGL 配置枚举报
//     ArrayIndexOutOfBoundsException: Index -1 out of bounds for length 1
//   窗口能开、bwe.log 写「窗口已打开」，但 reshape/display 永不执行 → 脚本不启动、画面空白。
//   JDK 26 还删了 java.applet，jpackage 产物会 NoClassDefFoundError: java/applet/Applet。
//   Microsoft 25 + 三个 jpackage flag → 全屏、GL、脚本都正常。
// 所以：试跑必须挑 major 在 17~25 的 JDK，并且带那三个 flag；
// 打包前也要检查 jpackage 所属 JDK，> 25 时给出醒目告警。

export const RUNTIME_JDK_MIN = 17;
export const RUNTIME_JDK_MAX = 25;

const jdkProbeCache = new Map();

function parseJavaMajor(text) {
  const text2 = String(text ?? "");
  const m = /version\s+"([^"]+)"/i.exec(text2) || /^\s*(\d+(?:[._]\d+)*)\s*$/m.exec(text2);
  if (!m) return null;
  const parts = String(m[1]).split(/[._+-]/);
  let major = Number(parts[0]);
  if (!Number.isFinite(major)) return null;
  // 旧格式 1.8.0_451 → 8
  if (major === 1 && parts.length > 1) major = Number(parts[1]);
  return Number.isFinite(major) ? major : null;
}

/** 跑 `java -version` 拿 major，结果按路径缓存（同一进程内 JDK 不会变）。 */
async function probeJavaVersion(javaExe) {
  const key = resolve(javaExe).toLowerCase();
  if (jdkProbeCache.has(key)) return jdkProbeCache.get(key);
  const info = { javaExe, major: null, version: "", error: "" };
  try {
    const { out, err } = await run(javaExe, ["-version"]);
    const text = `${err}\n${out}`;
    const vm = /version\s+"([^"]+)"/i.exec(text);
    info.version = vm ? vm[1] : "";
    info.major = parseJavaMajor(text);
  } catch (e) {
    info.error = String(e?.message ?? e).split("\n")[0];
  }
  jdkProbeCache.set(key, info);
  return info;
}

/** 常见 JDK 安装目录（只做一层 readdir，不会全盘扫）。 */
function commonJdkRoots() {
  const roots = [];
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    const localAppData = process.env.LOCALAPPDATA;
    for (const base of [programFiles, programFilesX86].filter(Boolean)) {
      for (const dir of [
        "Java",
        "Microsoft",
        "Eclipse Adoptium",
        "Eclipse Foundation",
        "Amazon Corretto",
        "Zulu",
        "BellSoft",
        "Semeru",
        "RedHat",
        "ojdkbuild"
      ]) {
        roots.push(join(base, dir));
      }
    }
    if (localAppData) {
      roots.push(join(localAppData, "Programs", "Eclipse Adoptium"));
      roots.push(join(localAppData, "Programs", "Microsoft"));
    }
  } else {
    roots.push("/usr/lib/jvm", "/opt/java", "/opt/jdk");
  }
  return roots;
}

async function collectJavaCandidates() {
  const found = new Map();
  const add = (exe, source) => {
    if (!exe) return;
    const abs = resolve(exe);
    if (!existsSync(abs)) return;
    const key = abs.toLowerCase();
    if (!found.has(key)) found.set(key, { javaExe: abs, source });
  };

  for (const envName of ["JAVA_HOME", "JDK_HOME"]) {
    const home = process.env[envName];
    if (home) add(join(home, "bin", process.platform === "win32" ? "java.exe" : "java"), envName);
  }

  try {
    const { out } = await run("where", ["java"]);
    for (const line of out.split(/\r?\n/)) add(line.trim(), "PATH");
  } catch {
    // 非 Windows 或没有 where：自己扫 PATH。
    const sep = process.platform === "win32" ? ";" : ":";
    for (const dir of String(process.env.PATH ?? "").split(sep)) {
      add(join(dir, process.platform === "win32" ? "java.exe" : "java"), "PATH");
    }
  }

  for (const root of commonJdkRoots()) {
    let entries = [];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      add(join(root, name, "bin", process.platform === "win32" ? "java.exe" : "java"), join(root, name));
    }
  }

  return Array.from(found.values());
}

/**
 * 选一个能跑 JOGL 的 JDK：major 在 [minMajor, maxMajor] 内取最高版本。
 *
 * 不用 PATH 上的第一个 java（这台机是 Oracle 26，正是坏的那个）。找不到时
 * 返回 `chosen: null`，由调用方给出「需要 JDK 17~25」的明确错误，而不是起个空窗口。
 */
export async function findRuntimeJdk(maxMajor = RUNTIME_JDK_MAX, minMajor = RUNTIME_JDK_MIN) {
  const candidates = await collectJavaCandidates();
  const all = [];
  for (const c of candidates) {
    const info = await probeJavaVersion(c.javaExe);
    all.push({ ...c, major: info.major, version: info.version, error: info.error });
  }
  const usable = all
    .filter((j) => j.major != null && j.major >= minMajor && j.major <= maxMajor)
    .sort((a, b) => b.major - a.major || a.javaExe.localeCompare(b.javaExe));
  return { chosen: usable[0] ?? null, all, minMajor, maxMajor };
}

/** 某个工具（jpackage/javac…）所属 JDK 的 major；探测失败返回 null。 */
export async function detectToolMajor(tool) {
  let exe = tool;
  try {
    const { out } = await run("where", [tool]);
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) exe = first;
  } catch {
    // 非 Windows：用 PATH 上的名字。
  }
  try {
    const { out, err } = await run(exe, ["--version"]);
    const text = `${out}\n${err}`;
    // jpackage --version 输出形如 "26.0.2.1"（没有 version 字样）。
    const byParse = parseJavaMajor(text);
    if (byParse != null) return byParse;
    const digits = /^(\d+)/m.exec(text.trim());
    return digits ? Number(digits[1]) : null;
  } catch {
    return null;
  }
}

/**
 * .bwproj → Build/*.json 的唯一转换入口（浏览器 /api/package-bwe 与命令行共用）。
 *
 * 契约：字段名与语义对齐 src/Studio/runtime/GameData.java 的读取；
 * 编辑器的绘制真值以 web/src/app/painter.ts / canvas.ts 为准。
 * warnings 里只放「导出格式表达不了 / 两边会不一致」的显式告警，不静默丢数据。
 */
async function writeBuild(project, inputDir, uploadedAssets, onLog, warnings, assetProblems) {
  const buildDir = join(inputDir, "Build");
  await mkdir(buildDir, { recursive: true });

  const runtimeAssets = new Map();
  const assetEntries = new Map();
  const assetNames = new Set();
  const idOwners = new Map();
  const nameOwners = new Map();
  const problems = assetProblems instanceof Map ? assetProblems : new Map();

  // ---------- 素材表：先查数据完整性，再逐个落盘 ----------
  for (const asset of project.assets ?? []) {
    const id = asset?.id == null ? "" : String(asset.id);
    const name = asset?.name == null ? "" : String(asset.name);
    const label = `素材「${name || id || "未命名"}」`;
    if (!id) warnOnce(warnings, `${label}：没有 id，运行时不认这条素材`);
    if (!name) warnOnce(warnings, `${label}：没有名字，扫雷/换装这类按素材名找图的模块会找不到它`);
    if (id) {
      if (assetEntries.has(id)) warnOnce(warnings, `${label}：素材 id 重复，运行时只用最后一条`);
      assetEntries.set(id, asset);
    }
    if (name) {
      const prevOwner = nameOwners.get(name);
      if (prevOwner !== undefined && prevOwner !== id) {
        warnOnce(warnings, `${label}：素材名重复，运行时按名字查找只会命中一条`);
      }
      nameOwners.set(name, id);
      assetNames.add(name);
    }
    const dirId = safeId(id);
    const dirOwner = idOwners.get(dirId);
    if (dirOwner !== undefined && dirOwner !== id) {
      warnOnce(warnings, `${label}：id 归一到目录名「${dirId}」后与「${dirOwner}」冲突，素材文件会互相覆盖`);
    }
    idOwners.set(dirId, id);
  }

  // ---------- 逐个素材：写文件 + 生成运行时描述 + 偏差告警 ----------
  let audioWarned = false;
  for (const asset of project.assets ?? []) {
    const id = String(asset.id ?? "");
    const label = `素材「${asset?.name || id || "未命名"}」`;
    const kind = String(asset.kind ?? "IMAGE").toUpperCase();
    const files = (uploadedAssets.get(asset.id) ?? []).slice();
    await writeAssetFiles(inputDir, project, asset, files, onLog, warnings);
    runtimeAssets.set(asset.id, runtimeAsset(asset, files, "Build/assets"));

    if (kind === "AUDIO" && !audioWarned) {
      // 运行时不会自动播放 AUDIO 素材；但 ScriptEngine 提供了 bwe.audio（Phase 1 仅 WAV），
      // 所以这里只是「需要自己用脚本播」，不是「完全不支持」。
      warnOnce(
        warnings,
        "AUDIO 素材不会自动播放：可在 JS 脚本里用 bwe.audio.play()/music() 播放（Phase 1 仅 WAV）"
      );
      audioWarned = true;
    }
    if (files.length === 0) {
      const reason = missingAssetReason(asset, problems.get(id));
      warnOnce(warnings, `${label}：没有打包到文件${reason ? `（${reason}）` : ""}，运行时会用色块或占位`);
    }
    if (kind === "SEQUENCE") {
      const declared = Math.max(1, Math.trunc(finiteNumber(asset.frameCount, 1)));
      if (files.length === 1 && declared > 1) {
        warnOnce(warnings, `${label}：只导出 1/${declared} 帧（命令行模式只能取到单帧），完整动画请用浏览器打包入口`);
      } else if (files.length && files.length !== declared) {
        warnOnce(warnings, `${label}：工程声明 ${declared} 帧，只打包了 ${files.length} 帧，动画会缺帧`);
      }
      if ((asset.hiddenFrames ?? []).length) {
        warnOnce(
          warnings,
          `${label}：有 ${asset.hiddenFrames.length} 个隐藏帧，导出格式没有「隐藏」字段，运行时会照常播放`
        );
      }
      if ((asset.frameDurations ?? []).length) {
        warnOnce(warnings, `${label}：有逐帧自定义时长，运行时不支持，统一按 animFps 播放`);
      }
      void visibleFrameCount(asset);
    }
    if (kind === "ATLAS") {
      const cols = Math.max(1, Math.trunc(finiteNumber(asset.cols, 1)));
      const rows = Math.max(1, Math.trunc(finiteNumber(asset.rows, 1)));
      const cellW = Math.trunc(finiteNumber(asset.cellW, 0));
      const cellH = Math.trunc(finiteNumber(asset.cellH, 0));
      const imageW = finiteNumber(asset.width, 0);
      const imageH = finiteNumber(asset.height, 0);
      if (cellW <= 0 || cellH <= 0) {
        // painter.sizeOf 只有 cellW 和 cellH 都 > 0 才按单元格算；运行时是逐方向回退，
        // 缺一个就会让「编辑器用整图尺寸、运行时用单元格尺寸」，尺寸对不上。
        warnOnce(warnings, `${label}：图集缺少 cellW/cellH，编辑器与运行时对尺寸的回退规则不同，建议重新导入图集`);
      } else {
        // 编辑器按 cellW/cellH 切片；运行时按 cols/rows 均分整图取 UV。
        // 两者只有在 cellW×cols == 图片宽（cellH×rows == 图片高）时才完全一致。
        if (imageW > 0 && Math.round(cellW * cols) !== Math.round(imageW)) {
          warnOnce(
            warnings,
            `${label}：cellW×cols = ${Math.round(cellW * cols)}，图片宽 ${Math.round(imageW)}；运行时会按 ${cols} 等分整图切片，与编辑器的 cellW 切片错位`
          );
        }
        if (imageH > 0 && Math.round(cellH * rows) !== Math.round(imageH)) {
          warnOnce(
            warnings,
            `${label}：cellH×rows = ${Math.round(cellH * rows)}，图片高 ${Math.round(imageH)}；运行时会按 ${rows} 等分整图切片，与编辑器的 cellH 切片错位`
          );
        }
      }
    }
  }

  // ---------- 脚本索引：编辑器 key → 运行时 name / 语言 ----------
  //
  // 编辑器里「场景 onStartScript」和「对象 script.js 模块的 params.script」存的都是剧本的
  // **key**（见 inspector.ts：options 来自 Object.keys(project.scripts)）；
  // 运行时 ScriptEngine 按 boot.json 里的 **name** 查找。两者通常相等，但改名后可能不一致，
  // 所以导出时统一换算一次，别让「编辑器里看着挂了脚本、运行时却跳过」这种问题出现。
  const scriptNameByKey = new Map();
  const scriptLangByKey = new Map();
  for (const [key, script] of Object.entries(project.scripts ?? {})) {
    scriptNameByKey.set(String(key), String(script?.name ?? key ?? ""));
    scriptLangByKey.set(String(key), String(script?.lang ?? "yarn").toLowerCase() === "js" ? "js" : "yarn");
  }

  // ---------- 场景 ----------
  const tileSize = positiveIntField(project.tileSize, 32, "工程 tileSize", warnings);
  const gridW = positiveIntField(project.gridW, 60, "工程 gridW", warnings);
  const gridH = positiveIntField(project.gridH, 40, "工程 gridH", warnings);
  const scenes = [];
  const sceneCount = (project.scenes ?? []).length;
  for (let i = 0; i < sceneCount; i++) {
    const scene = project.scenes[i];
    const sceneLabel = `场景「${scene?.name ?? i + 1}」`;
    const file = `scene_${i}.json`;

    const layerList = Array.isArray(scene?.layers) ? scene.layers : [];
    const layerIndexById = new Map();
    const layerVisibleById = new Map();
    layerList.forEach((layer, idx) => {
      const id = String(layer?.id ?? "");
      layerIndexById.set(id, idx);
      layerVisibleById.set(id, layer?.visible !== false);
      // 注意：编辑器 orderObjects 用的是图层数组下标，不是 layer.order 字段
      // （order 字段在 Web 编辑器里从未被维护，示例工程里都是 0）。
      // 所以导出对象上的 layer 字段必须取下标，order 只作为数据原样保留。
    });

    const objectIds = new Set((scene?.objects ?? []).map((o) => String(o?.id ?? "")));
    const objects = (scene?.objects ?? []).map((o) => {
      const owner = String(o?.name || o?.id || "未命名对象");
      let layerIndex = layerIndexById.get(o?.layerId);
      if (layerIndex == null) {
        // 编辑器 orderObjects 对找不到的图层用 layers.length（排最上层）。
        if (o?.layerId) {
          warnOnce(warnings, `对象「${owner}」的 layerId 不在 ${sceneLabel} 的图层表里，按编辑器规则排到最上层`);
        }
        layerIndex = layerList.length;
      }
      if (o?.parentId && !objectIds.has(String(o.parentId))) {
        warnOnce(warnings, `对象「${owner}」的 parentId「${o.parentId}」找不到父对象`);
      }
      return objectJson(
        o,
        layerIndex,
        layerVisibleById.get(o?.layerId) ?? true,
        runtimeAssets,
        assetEntries.get(o?.assetId),
        assetNames,
        warnings
      );
    });

    // 对象脚本（script.js）：把 params.script 从 key 换成 name；
    // 并按语言判断——JS 会被运行时执行，Yarn / 不存在的脚本要显式告警。
    for (const obj of objects) {
      const owner = String(obj?.name || obj?.id || "未命名对象");
      for (const m of obj?.modules ?? []) {
        if (String(m?.def ?? "") !== "script.js") continue;
        const raw = m?.params?.script;
        if (typeof raw !== "string" || !raw.trim()) {
          warnOnce(warnings, `对象「${owner}」的 script.js 模块没有选择脚本，运行时不会执行`);
          continue;
        }
        const key = raw.trim();
        const scriptName = scriptNameByKey.get(key);
        if (scriptName === undefined) {
          warnOnce(warnings, `对象「${owner}」的 script.js 模块引用的脚本「${key}」不存在，运行时不会执行`);
          continue;
        }
        if (scriptLangByKey.get(key) !== "js") {
          warnOnce(
            warnings,
            `对象「${owner}」的 script.js 模块引用的是 Yarn 剧本「${key}」，运行时不会执行；请换成 JS 脚本`
          );
          continue;
        }
        m.params.script = scriptName;
      }
    }

    const width = positiveIntField(scene?.widthTiles, gridW, `${sceneLabel} widthTiles`, warnings);
    const height = positiveIntField(scene?.heightTiles, gridH, `${sceneLabel} heightTiles`, warnings);
    // onStartScript：编辑器存 key，运行时按 name 查（ScriptEngine 读 scene_*.json 的该字段）。
    const startScriptKey = String(scene?.onStartScript ?? "");
    const startScriptName = startScriptKey ? (scriptNameByKey.get(startScriptKey) ?? startScriptKey) : "";
    const sceneJson = {
      width,
      height,
      tileSize,
      // origin 是 .bwproj 里的场景原点；编辑器/运行时当前都没有使用，但原样导出避免丢数据。
      originX: finiteNumber(scene?.originX, 0),
      originY: finiteNumber(scene?.originY, 0),
      bgmAssetId: String(scene?.bgmAssetId ?? ""),
      onStartScript: startScriptName,
      // 图层表：可见性靠对象 visible 已经合成；order 是编辑器数据，运行时读对象上的 layer。
      layers: layerList.map((layer) => ({
        id: String(layer?.id ?? ""),
        name: String(layer?.name ?? ""),
        visible: layer?.visible !== false,
        order: finiteNumber(layer?.order, 0)
      })),
      objects
    };
    if (sceneJson.bgmAssetId) {
      warnOnce(
        warnings,
        `${sceneLabel}：设置了 BGM 素材，但运行时不会自动播放 BGM（可在 JS 脚本里用 bwe.audio 手动播，Phase 1 仅 WAV）`
      );
    }
    // 场景脚本按语言判断：运行时（ScriptEngine）会执行 JS 场景脚本的 onSceneStart；
    // Yarn 剧本 / 找不到的脚本才需要告警。
    if (startScriptKey) {
      const startLang = scriptLangByKey.get(startScriptKey);
      if (startLang === undefined) {
        warnOnce(warnings, `${sceneLabel}：onStartScript 指向的脚本「${startScriptKey}」不存在，运行时会跳过场景脚本`);
      } else if (startLang !== "js") {
        warnOnce(
          warnings,
          `${sceneLabel}：onStartScript「${startScriptKey}」是 Yarn 剧本，运行时不会执行；请换成 JS 脚本（写 onSceneStart(ctx)）`
        );
      }
      // startLang === "js"：运行时会执行，不告警。
    }
    await writeFile(join(buildDir, file), JSON.stringify(sceneJson, null, 2), "utf8");
    scenes.push({
      name: scene?.name ?? `场景 ${i + 1}`,
      file,
      width,
      height
    });
  }
  if (sceneCount > 1) {
    warnOnce(warnings, `工程有 ${sceneCount} 个场景，运行时只加载第一张「${scenes[0]?.name ?? ""}」，其余场景不会生效`);
  }

  // ---------- 剧本 / 变量 ----------
  // ---------- 剧本 / 变量 ----------
  //
  // 契约见 docs/scripting-api.md §6：
  //   lang = "js"   → Build/scripts/<安全名>.js（已是 ES5）+ boot.scripts[]={name,file,lang}
  //   lang = "yarn" → 保持 {name,source}（lang 缺省即 yarn，旧工程不用改）
  const scripts = [];
  const usedScriptBase = new Set();
  const scriptsDir = join(buildDir, "scripts");
  let scriptsDirReady = false;
  let jsCount = 0;
  let yarnCount = 0;
  for (const [key, script] of Object.entries(project.scripts ?? {})) {
    const name = String(script?.name ?? key ?? "");
    const label = name || key || "未命名脚本";
    // lang 缺省 = yarn：旧的 Yarn 剧本没有这个字段。
    const lang = String(script?.lang ?? "yarn").toLowerCase() === "js" ? "js" : "yarn";
    const source = String(script?.source ?? "");
    if (lang !== "js") {
      yarnCount++;
      scripts.push({ name, source, lang: "yarn" });
      continue;
    }
    const base = uniqueScriptBase(name || key, "script", usedScriptBase);
    const relFile = `scripts/${base}.js`;
    try {
      const { code, diagnostics } = transpileJsScript(source, label, `${base}.ts`);
      if (!scriptsDirReady) {
        await mkdir(scriptsDir, { recursive: true });
        scriptsDirReady = true;
      }
      await writeFile(join(buildDir, "scripts", `${base}.js`), code, "utf8");
      // 语法错误不能静默：transpileModule 仍会产出代码，运行时会在那一行炸，
      // 所以把 TS 诊断按「脚本名 + 行:列」写进 warnings，前端打包面板原样展示。
      for (const d of diagnostics) warnOnce(warnings, d);
      jsCount++;
      scripts.push({ name, file: relFile, lang: "js" });
      logStep(onLog, `JS 脚本「${label}」已降级为 ES5：Build/${relFile}`);
    } catch (e) {
      // TypeScript 缺失等硬失败：保留 source，让构建不中断，但明确告警。
      warnOnce(warnings, `脚本「${label}」降级 ES5 失败（运行时会跳过它）：${e?.message || e}`);
      scripts.push({ name, source, lang: "js" });
    }
  }
  if (jsCount) {
    logStep(onLog, `已把 ${jsCount} 段 JS 脚本降级为 ES5 写进 Build/scripts/`);
  }
  if (yarnCount) {
    warnOnce(warnings, `工程里有 ${yarnCount} 段 Yarn 剧本：运行时只执行 JS 脚本，Yarn 剧本与对话模块都不会播放`);
  }

  const variables = {};
  for (const [key, value] of Object.entries(project.variables ?? {})) {
    if (value == null) {
      variables[key] = "";
      continue;
    }
    variables[key] = String(value);
    if (typeof value !== "string") {
      // GameData 直接 getAsString；对象/数组会让整个 boot.json 读取抛异常。
      warnOnce(warnings, `变量「${key}」不是字符串，已按文本导出（运行时只读文本）`);
    }
  }

  const boot = {
    project: String(project.name ?? "未命名工程"),
    tileSize,
    masterVolume: finiteNumber(project.masterVolume, 0.8),
    scenes,
    variables,
    scripts,
    // 玩法模块按素材名找图；这张表必须有。
    assets: Array.from(runtimeAssets.values())
  };
  // 可选：全局入口脚本名（有就跑 onSceneStart 前先执行）。编辑器还没提供这个字段时就不写。
  const jsMain = String(project.jsMain ?? "").trim();
  if (jsMain) boot.jsMain = jsMain;
  await writeFile(join(buildDir, "boot.json"), JSON.stringify(boot, null, 2), "utf8");
  if (runtimeAssets.size === 0) warnOnce(warnings, "工程没有任何素材：运行时会只画色块");
  return { boot, scenes, runtimeAssets };
}

/**
 * 「试跑」（/api/quick-run）复用的导出入口。
 *
 * 和 /api/package-bwe 走同一个 writeBuild，不复制第二份转换逻辑：
 * 素材归一化（浏览器上传 → files Map，命令行 → data URL）也留在这里，
 * 保证「试跑看到的」和「打包出来的」永远是同一份 Build。
 *
 * @param {object} project .bwproj JSON
 * @param {Array|null} uploadedAssets 浏览器上传的素材；null 表示从工程 data URL 收集
 * @param {string} inputDir 输出目录（Build 会建在它下面）
 * @param {(s:string)=>void} [onLog]
 */
export async function writeQuickBuild(project, uploadedAssets, inputDir, onLog) {
  const warnings = [];
  const uploaded = uploadedAssets
    ? normalizeUploadedAssets(uploadedAssets)
    : await collectDataUrlAssets(project, onLog);
  const build = await writeBuild(project, inputDir, uploaded.files, onLog, warnings, uploaded.problems);
  return { ...build, warnings };
}

async function zipApp(outDir, appName, onLog) {
  const zipPath = join(outDir, `${appName}-win64.zip`);
  await rm(zipPath, { force: true });
  try {
    await run("tar", ["-a", "-c", "-f", zipPath, "-C", outDir, appName]);
    return zipPath;
  } catch (e) {
    onLog?.(`tar 压缩失败，改用 PowerShell：${String(e.message).split("\n")[0]}`);
    const script = `Compress-Archive -LiteralPath '${join(outDir, appName).replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    await run("powershell", ["-NoProfile", "-Command", script]);
    return zipPath;
  }
}

/**
 * 主入口。
 * @param {object} project .bwproj JSON
 * @param {Array} uploadedAssets 浏览器上传的素材
 * @param {object} options { name, version, console, icon, jobId }
 */
export async function packageBwe(project, uploadedAssets, options = {}, onLog = console.log) {
  if (!project || !Array.isArray(project.scenes)) {
    throw new Error("工程数据不完整：缺少 scenes");
  }
  if (!(await commandExists("javac"))) throw new Error("找不到 javac，请安装 JDK 17+ 并加入 PATH");
  if (!(await commandExists("jpackage"))) throw new Error("找不到 jpackage，请安装 JDK 17+ 并加入 PATH");

  const jobId = safeId(options.jobId || `build_${Date.now()}`);
  const outRoot = resolve(options.outDir || join(packageRoot, jobId));
  const buildDir = join(outRoot, "work");
  const outDir = join(outRoot, "out");
  const classesDir = join(buildDir, "classes");
  const inputDir = join(buildDir, "input");
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(classesDir, { recursive: true });
  await mkdir(inputDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const appName = safeSegment(options.name || project.name || "BWE-Game", "BWE-Game");
  const version = safeVersion(options.version);
  const warnings = [];

  logStep(onLog, `开始打包「${appName}」 v${version}`);

  // jpackage 所属 JDK 太新会打出「跑不起来」的包：JDK 26 删了 java.applet，
  // JOGL 2.1 在 26 上 WGL 崩溃（窗口开、GL/脚本不启动）。这里提前显式告警，
  // 而不是让用户拿到一个双击后空白的 exe 再回来查。
  const jpackageMajor = await detectToolMajor("jpackage");
  if (jpackageMajor != null && jpackageMajor > RUNTIME_JDK_MAX) {
    warnOnce(
      warnings,
      `jpackage 所在 JDK 是 ${jpackageMajor}（> ${RUNTIME_JDK_MAX}）：JDK 26 删除了 java.applet，`
        + `且 JOGL 2.1 在 JDK 26 上无法初始化 GL（窗口能开但画面空白、脚本不启动），打出来的包可能不可运行。`
        + `请改用 JDK ${RUNTIME_JDK_MIN}~${RUNTIME_JDK_MAX} 打包（把 JAVA_HOME 指向例如 `
        + `C:\\Program Files\\Microsoft\\jdk-25*）。`
    );
    logStep(onLog, `⚠ 检测到 jpackage 使用 JDK ${jpackageMajor}（> ${RUNTIME_JDK_MAX}），打包产物可能跑不起来`);
  } else if (jpackageMajor != null) {
    logStep(onLog, `jpackage 使用 JDK ${jpackageMajor}（可用范围 ${RUNTIME_JDK_MIN}~${RUNTIME_JDK_MAX}）`);
  }

  logStep(onLog, "1/5 转换工程数据与素材…");
  const uploaded = uploadedAssets ? normalizeUploadedAssets(uploadedAssets) : await collectDataUrlAssets(project, onLog);
  const build = await writeBuild(
    project,
    inputDir,
    uploaded.files,
    onLog,
    warnings,
    uploaded.problems
  );
  // 每一条告警都写进日志和 result.warnings，浏览器与命令行都能看见。
  for (const warning of warnings) {
    logStep(onLog, `⚠ ${warning}`);
  }

  logStep(onLog, "2/5 编译 Java 运行时…");
  const sources = await runtimeSources();
  const classpath = join(libRoot, "*");
  await run("javac", [
    "--release", "8",
    "-encoding", "UTF-8",
    "-Xlint:-options",
    "-cp", classpath,
    "-d", classesDir,
    ...sources
  ], {
    onStdout: (s) => s.trim() && logStep(onLog, s.trim()),
    onStderr: (s) => s.trim() && logStep(onLog, s.trim())
  });
  await run("jar", ["--create", "--file", join(inputDir, "bwe-runtime.jar"), "-C", classesDir, "."]);

  logStep(onLog, "3/5 收集 JOGL / Gson 与本机原生库…");
  await copyRuntimeLibraries(inputDir);
  await extractNatives(inputDir);

  logStep(onLog, "4/5 调用 jpackage 生成 Windows 应用…");
  const jpackageArgs = [
    "--type", "app-image",
    "--name", appName,
    "--app-version", version,
    "--dest", outDir,
    "--input", inputDir,
    "--main-jar", "bwe-runtime.jar",
    "--main-class", "Studio.runtime.BweLauncher",
    "--vendor", "BrokenWonderEngine",
    "--description", `${build.boot.project} — BWE 游戏`,
    "--java-options", "-Dfile.encoding=UTF-8",
    "--java-options", "-Djava.awt.headless=false",
    "--java-options", "-Dsun.java2d.noddraw=true",
    "--java-options", "--enable-native-access=ALL-UNNAMED",
    "--java-options", "--add-opens=java.desktop/sun.awt=ALL-UNNAMED",
    "--java-options", "--add-opens=java.desktop/sun.java2d=ALL-UNNAMED"
  ];
  if (options.console) jpackageArgs.push("--win-console");
  if (options.icon && existsSync(String(options.icon))) {
    jpackageArgs.push("--icon", resolve(String(options.icon)));
  }
  try {
    await run("jpackage", jpackageArgs, {
      onStdout: (s) => s.trim() && logStep(onLog, s.trim()),
      onStderr: (s) => s.trim() && logStep(onLog, s.trim())
    });
  } catch (e) {
    // 某些 Windows 环境不允许 jpackage 带中文应用名。自动退一步，不让用户卡死。
    if (/name|名称|invalid/i.test(String(e.message))) {
      logStep(onLog, "应用名被 jpackage 拒绝，改用 BWE-Game 重试…");
      warnings.push(`应用名「${appName}」不被 jpackage 接受，已改用 BWE-Game。`);
      const e2 = String(e.message);
      await run("jpackage", jpackageArgs.map((a) => a === appName ? "BWE-Game" : a), {
        onStderr: (s) => s.trim() && logStep(onLog, s.trim())
      });
      // 用实际输出目录名继续。
      const fallbackDir = join(outDir, "BWE-Game");
      if (!existsSync(fallbackDir)) throw new Error(e2);
      return finish(fallbackDir, "BWE-Game");
    }
    throw e;
  }

  return finish(join(outDir, appName), appName);

  async function finish(appDir, actualName) {
    const exeName = `${actualName}.exe`;
    const exePath = join(appDir, exeName);
    if (!existsSync(exePath)) {
      const files = await readdir(appDir).catch(() => []);
      const exe = files.find((f) => f.toLowerCase().endsWith(".exe"));
      if (!exe) throw new Error(`jpackage 完成但找不到 exe：${appDir}`);
      return finalize(appDir, exe, actualName);
    }
    return finalize(appDir, exeName, actualName);
  }

  async function finalize(appDir, exeName, actualName) {
    const note = [
      `${build.boot.project}`,
      "",
      "这是由 BWE Studio 打包的 Windows 游戏包。",
      "双击目录里的 " + exeName + " 启动。",
      "",
      "如果启动失败，请把 Build/bwe.log 发给开发者；",
      "端口 / 依赖 / Java 崩溃信息都会写进这个文件。",
      "",
      "运行环境：Windows 10/11 64 位，已自带 Java 运行时。",
      "操作：WASD 移动；扫雷左键翻开、右键插旗；换装点击部件。",
      ""
    ].join("\r\n");
    await writeFile(join(appDir, "启动说明.txt"), note, "utf8");

    logStep(onLog, "5/5 压缩 Windows 应用包…");
    const zipPath = await zipApp(outDir, basename(appDir), onLog);
    const s = await stat(zipPath);
    const result = {
      appName: actualName,
      version,
      outDir,
      appDir,
      exeName,
      exePath: join(appDir, exeName),
      zipPath,
      zipName: basename(zipPath),
      sizeBytes: s.size,
      warnings
    };
    logStep(onLog, `完成：${zipPath}`);
    return result;
  }
}

// ---------------- CLI ----------------

async function cli() {
  const args = process.argv.slice(2);
  const projectPath = args.find((a) => !a.startsWith("--"));
  if (!projectPath) {
    console.error(
      "用法：node web/tools/package-bwe.mjs <工程.bwproj> [--out 目录] [--name 名称] [--version 1.0.0] [--debug] [--build-only [目录]]"
    );
    process.exitCode = 2;
    return;
  }
  const readArg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const project = JSON.parse(await readFile(resolve(projectPath), "utf8"));

  // --build-only：只跑 writeBuild（Build/boot.json + Build/scripts/*.js + 素材），
  // 不编译 Java、不 jpackage。给校验脚本 / 「试跑」这类只想要 Build 的场景用。
  if (args.includes("--build-only")) {
    const value = readArg("--build-only");
    const target = resolve(
      value && !value.startsWith("--") ? value : readArg("--out") || join(webRoot, ".build", "buildonly")
    );
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    const build = await writeQuickBuild(project, null, target, (s) => console.log(s));
    for (const w of build.warnings) console.log(`⚠ ${w}`);
    const summary = {
      ok: true,
      outDir: target,
      buildDir: join(target, "Build"),
      bootFile: join(target, "Build", "boot.json"),
      scripts: build.boot.scripts ?? [],
      warnings: build.warnings
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const result = await packageBwe(project, null, {
    outDir: readArg("--out"),
    name: readArg("--name") || project.name,
    version: readArg("--version") || "1.0.0",
    console: args.includes("--debug")
  }, (s) => console.log(s));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch((e) => {
    console.error(e?.stack || e);
    process.exitCode = 1;
  });
}

export { safeSegment, safeVersion, extensionForAsset, writeBuild };
