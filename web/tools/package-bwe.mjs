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
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

// ---- 2D 光照导出用的容错助手（契约 docs/_fragments/lighting-contract.md §3）----

/** 合法的光照模式。非法值退回 both（而不是抛错）：导出器绝不能因为一个脏字段就整包失败。 */
const LIGHTING_MODES = new Set(["baked", "dynamic", "both"]);

/** 夹到 [min,max] 的有限数：非数字 ⇒ 用 fallback（不做告警，光照参数脏了不该刷屏）。 */
function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** `#rrggbb` 校验：非法/缺失 ⇒ fallback。运行时 `parseHexColor` 只认 7 位字符串。 */
function hexColorOr(value, fallback) {
  const s = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
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

/**
 * 去掉 JS 注释（行注释 + 块注释），保留字符串内容。
 *
 * 只给 {@link scriptParamKeys} 用：注释里的 `bwe.params({...})` 是**举例**，不是声明，
 * 不去掉就会把示例字段当成真实字段，于是给用户报一条假警告。
 */
function stripJsComments(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      for (i++; i < src.length; i++) {
        out += src[i];
        if (src[i] === "\\") {
          i++;
          if (i < src.length) out += src[i];
          continue;
        }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      if (i < src.length) out += "\n";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 从脚本源码里取出 `bwe.params({...})` 声明的**键名集合**（导出期的轻量体检用）。
 *
 * 为什么这里不引 `web/src/core/scriptParams.ts`：本文件是 node 侧 ESM，直接 import .ts 需要
 * 额外走一遍 esbuild，而导出链路已经够长。这里的任务是**只为告警提供参照**，所以故意写得保守：
 * 认不出（没有声明 / 括号不配平 / 有嵌套）就返回 null，调用方跳过检查 ——
 * 宁可少说一句，也不能因为一个宽松正则给用户报假警告。
 * 真正的解析权威仍然是 `web/src/core/scriptParams.ts`（编辑器面板用它渲染控件）。
 */
function scriptParamKeys(source) {
  const src = stripJsComments(typeof source === "string" ? source : "");
  if (!src) return null;
  const at = src.search(/\bbwe\s*\.\s*params\s*\(\s*\{/);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  let depth = 0;
  let end = -1;
  // 花括号配平（跳过字符串，避免 `}` 出现在默认值文本里被当成闭合）
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === quote) break;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const body = src.slice(open + 1, end);
  // 值里出现花括号/方括号 = 有嵌套对象或数组 —— 不在本检查的覆盖面内，保守放弃。
  // 顶层对象字面量里出现 `{`/`[` 只可能是嵌套值（键与字符串已在上面被跳过），
  // 所以直接判存在即可，不用再猜"它是不是值的一部分"。
  if (/[{}[\]]/.test(body.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'))) {
    return null;
  }
  const keys = new Set();
  const re = /(?:^|,)\s*(?:([A-Za-z_$][\w$]*)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*:/g;
  let m;
  while ((m = re.exec(body))) {
    keys.add(m[1] ?? m[2] ?? m[3]);
  }
  return keys.size ? keys : null;
}

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
      env: options.env || process.env
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
    .filter((f) => f.endsWith(".java") && f !== "GameLauncher.java" && !f.endsWith("Test.java"))
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
  // jbox2d 是 2D 物理（bwe.physics）。漏掉它 → 运行时 NoClassDefFoundError:
  // org/jbox2d/callbacks/ContactListener，脚本物理模块初始化失败。
  // 这是真实发生过的打包事故：Android 侧补了 jbox2d，PC 侧的白名单没跟着更新。
  const wanted = libs.filter((f) => /^(gson|jogl-all|gluegen-rt|rhino|jbox2d)-.*\.jar$/i.test(f));
  if (wanted.length === 0) throw new Error("lib/ 下找不到运行时依赖 jar");
  if (!wanted.some((f) => /^rhino-/i.test(f))) {
    throw new Error("lib/ 下找不到 rhino-*.jar：JS 脚本运行不了，请确认 lib/rhino-1.7.15.jar 存在");
  }
  if (!wanted.some((f) => /^jbox2d-/i.test(f))) {
    throw new Error("lib/ 下找不到 jbox2d-*.jar：bwe.physics 会 NoClassDefFoundError，请确认 lib/jbox2d-library-2.1.2.jar 存在");
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
    // 工程自带的 JDK 安装点（不装在 Program Files 的也要能找到）：
    // Android SDK 的 OpenJDK 和 android-studio 的 jbr 都在这里。
    for (const extra of [
      "D:\\UnityAndroid\\OpenJDK",
      "D:\\UnityAndroid\\SDK",
      "C:\\Program Files\\Android\\Android Studio\\jbr"
    ]) {
      roots.push(extra);
    }
    // 想用别的 JDK？用 BWE_JDK_ROOTS（分号分隔）显式指定，优先于上面所有默认值。
    const envRoots = process.env.BWE_JDK_ROOTS;
    if (envRoots) {
      for (const r of envRoots.split(";").map((x) => x.trim()).filter(Boolean)) {
        roots.unshift(r);
      }
    }
  } else {
    roots.push("/usr/lib/jvm", "/opt/java", "/opt/jdk");
  }
  return roots;
}

/**
 * java.exe 所在目录是否像真正的 JDK 根目录。
 *
 * Windows 上 Oracle 的 javapath / java8path 是「转发器」目录：里面只有 java.exe，
 * 没有 javac.exe、也没有 jmods。它们能跑 `java -version`，但**不能**当 JAVA_HOME 用
 * ——gradlew 会报 "JAVA_HOME is set to an invalid directory"。
 */
function looksLikeJdkHome(javaExe) {
  const binDir = dirname(javaExe);
  if (basename(binDir).toLowerCase() !== "bin") return false;
  const home = dirname(binDir);
  const javac = join(binDir, process.platform === "win32" ? "javac.exe" : "javac");
  // 只要同一 bin 目录里没有 javac，就不是 JDK（是 JRE 或转发器）。
  return existsSync(javac) && existsSync(home);
}

async function collectJavaCandidates() {
  const found = new Map();
  const add = (exe, source) => {
    if (!exe) return;
    const abs = resolve(exe);
    if (!existsSync(abs)) return;
    // 转发器目录（javapath/java8path）不能作 JAVA_HOME，直接排除，避免选到假 JDK。
    if (!looksLikeJdkHome(abs)) return;
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

  const javaName = process.platform === "win32" ? "java.exe" : "java";
  for (const root of commonJdkRoots()) {
    // 情况 A：root 本身就是 JDK 根（例如 D:/UnityAndroid/OpenJDK）——
    // 直接试 root/bin/java。早期版本只当成容器，所以这类 JDK 永远扫描不到。
    add(join(root, "bin", javaName), root);
    // 情况 B：root 是容器（Program Files/Java 下挂多个 JDK）——扫下一层目录。
    let entries = [];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      add(join(root, name, "bin", javaName), join(root, name));
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
 * 编辑器里的预制体（PrefabDef）→ boot.json 顶层 `prefabs[]` 的运行期定义。
 *
 * 字段契约（与 ScriptPrefab 侧逐字对齐，改动必须两边一起改）：
 *   name / kind / asset / z / layer / halfW / halfH / tags / modules[{def,when,params}]
 *   / props / script / animMode / animFps / scaleX / scaleY / rotation / jitter{x,y}
 *
 * 两个最容易搞错的地方：
 *   1. `asset` 写的是**素材名**（不是 assetId）。运行期按名字找图（assetByName），
 *      给 id 会静默退回色块 —— 所以这里查一次素材表，查不到就显式告警。
 *   2. `script` 写的是**脚本名**（scripts[].name，不是文件路径）。运行期拿它去
 *      ScriptEngine 的 scripts 表里查；写文件路径就永远查不到，预制体放出来的实例
 *      不会跑脚本。编辑器里存的是剧本 key，这里必须换算成 name。
 *
 * 编辑器专用、运行期不认的字段一律**不导出**：
 *   id（编辑器内部链接用）、blurb（说明文字）、assetId（已换算成 asset）、
 *   spawnJitter（换算成 jitter）。
 *
 * 预制体里的模块也走一遍 moduleJson，于是 `params` 的编码规则（全部转成字符串、
 * 素材引用校验）与场景对象完全一致，不会出现「同样的模块在场景里能用、在预制体里不能」。
 *
 * @param {object} project .bwproj JSON
 * @param {Set<string>} assetNames 工程里所有素材名
 * @param {Map<string,string>} scriptNameByKey 编辑器剧本 key → 运行期脚本名
 * @param {Map<string,string>} scriptLangByKey 编辑器剧本 key → "js" | "yarn"
 * @param {string[]} warnings 告警收集器（软告警，不阻断导出）
 */
function prefabBootList(project, assetNames, scriptNameByKey, scriptLangByKey, warnings) {
  const list = [];
  const usedNames = new Set();
  for (const pf of project.prefabs ?? []) {
    if (!pf || typeof pf !== "object") continue;
    // 名字是运行期 define/spawn 的 key：空名和重名都会让「第二个预制体覆盖第一个」，
    // 这里跳过并告警，而不是导出一个永远拿不到的模板。
    const name = String(pf.name ?? "").trim();
    if (!name) {
      warnOnce(warnings, "有预制体没有名字，运行期无法按名字生成，已跳过");
      continue;
    }
    if (usedNames.has(name)) {
      warnOnce(warnings, `预制体「${name}」有重名，运行期后一个会覆盖前一个，只导出第一条`);
      continue;
    }
    usedNames.add(name);

    const label = `预制体「${name}」`;
    const assetEntry = (project.assets ?? []).find((a) => a && a.id === pf.assetId);
    const assetName = assetEntry?.name == null ? "" : String(assetEntry.name);
    if (pf.assetId && !assetEntry) {
      warnOnce(warnings, `${label} 引用了不存在的素材 id「${pf.assetId}」，运行时会画成色块`);
    } else if (assetName && !assetNames.has(assetName)) {
      warnOnce(warnings, `${label} 的素材「${assetName}」不在导出素材表里，运行时会画成色块`);
    }

    // 对象脚本：编辑器存 key，运行期按 name 查。与 scene_*.json 的 script.js 换算完全同一套规则。
    let script = "";
    const rawScript = String(pf.script ?? "").trim();
    if (rawScript) {
      const resolved = scriptNameByKey.get(rawScript);
      if (resolved === undefined) {
        warnOnce(warnings, `${label} 的脚本「${rawScript}」不存在，运行期不会执行脚本`);
      } else if (scriptLangByKey.get(rawScript) !== "js") {
        warnOnce(warnings, `${label} 的脚本「${rawScript}」是 Yarn 剧本，运行期不会执行；请换成 JS 脚本`);
      } else {
        script = resolved;
      }
    }

    const modules = (Array.isArray(pf.modules) ? pf.modules : [])
      .map((m) => moduleJson(m, label, assetNames, warnings))
      .filter(Boolean);

    const jitterX = finiteNumber(pf.spawnJitter?.x, 0, `${label} 的 spawnJitter.x`, warnings);
    const jitterY = finiteNumber(pf.spawnJitter?.y, 0, `${label} 的 spawnJitter.y`, warnings);

    list.push({
      name,
      kind: String(pf.kind || "PROP"),
      asset: assetName,
      z: truncIntField(pf.z, 0, `${label} 的 z`, warnings),
      layer: truncIntField(pf.layer, 0, `${label} 的 layer`, warnings),
      halfW: finiteNumber(pf.halfW, 0, `${label} 的 halfW`, warnings),
      halfH: finiteNumber(pf.halfH, 0, `${label} 的 halfH`, warnings),
      tags: Array.isArray(pf.tags) ? pf.tags.map((t) => String(t)) : [],
      modules,
      props: pf.props && typeof pf.props === "object" ? pf.props : {},
      script,
      animMode: pf.animMode == null || pf.animMode === "" ? "默认" : String(pf.animMode),
      animFps: finiteNumber(pf.animFps, 8, `${label} 的 animFps`, warnings),
      scaleX: finiteNumber(pf.scaleX, 1, `${label} 的 scaleX`, warnings),
      scaleY: finiteNumber(pf.scaleY, 1, `${label} 的 scaleY`, warnings),
      rotation: finiteNumber(pf.rotation, 0, `${label} 的 rotation`, warnings),
      // 缺省输出 {x:0,y:0} 而不是 null：运行期直接读 .x/.y，不用再多一层判空。
      jitter: { x: jitterX, y: jitterY }
    });
  }
  return list;
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

  // ---------- 脚本公开字段：覆盖值体检 ----------
  //
  // 编辑器把「用户改过的脚本字段」存在对象 script.js 模块的 `values.params`（JSON 文本，
  // 只含改过的项）里，moduleJson 会把它原样搬进 boot.json 的 `params.params`，
  // 运行时（ScriptParams）按这个键读覆盖值。原样搬的风险是：
  //   - 手改过的工程文件里 JSON 坏了 / 不是对象 → 运行时**静默**退回默认值；
  //   - 脚本后来删掉了某个字段，工程里还留着那条覆盖 → 运行时忽略，但作者以为还在生效。
  // 两种都在这里说一句。只告警不阻断：参数坏了不该让整个包打不出来。
  for (const scene of project.scenes ?? []) {
    for (const obj of scene.objects ?? []) {
      const owner = `场景「${scene?.name ?? ""}」里的对象「${obj?.name || obj?.id || "未命名"}」`;
      for (const m of obj?.modules ?? []) {
        if (String(m?.defId ?? "") !== "script.js") continue;
        const overrideText = m?.values?.params;
        if (typeof overrideText !== "string" || !overrideText.trim()) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(overrideText);
        } catch {
          warnOnce(warnings, `${owner} 的脚本公开字段覆盖值不是合法 JSON，运行时会把它们全部当成未设置`);
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          warnOnce(warnings, `${owner} 的脚本公开字段覆盖值不是对象，运行时会把它们全部当成未设置`);
          continue;
        }
        const scriptKey = String(m?.values?.script ?? "");
        const declared = scriptParamKeys(project.scripts?.[scriptKey]?.source);
        if (!declared) continue; // 认不出声明就闭嘴，不报假警告
        for (const k of Object.keys(parsed)) {
          if (!declared.has(k)) {
            warnOnce(
              warnings,
              `${owner} 的脚本公开字段覆盖值里有「${k}」，但脚本「${scriptKey}」没有声明它，运行时忽略`
            );
          }
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

  /**
   * UI 场景：与世界场景走**同一套对象导出逻辑**，但：
   *   - 分成单独的 `uiScenes[]` 列表，不进 `scenes[]`（运行时数据模型里两者不同类型）；
   *   - scene json 顶层写 ui/designW/designH，宽高按设计分辨率换算成「tileSize=1」的像素数，
   *     这样 GameData 的 `width × tileSize` 老公式得到的仍然是设计分辨率；
   *   - 不导出 buildings/navLinks/roadNetwork（UI 场景没有空间结构）。
   * 旧工程（没有任何 ui 场景）导出的 boot.json 与改动前逐字节一致：uiScenes 只有非空时才写。
   */
  const scenes = [];
  const uiScenes = [];
  const sceneCount = (project.scenes ?? []).length;
  for (let i = 0; i < sceneCount; i++) {
    const scene = project.scenes[i];
    const isUi = scene?.ui === true;
    const sceneLabel = `${isUi ? "UI 场景" : "场景"}「${scene?.name ?? i + 1}」`;
    // 世界场景沿用 scene_<下标>.json（旧 Build 的路径不能变）；UI 场景用 ui_<下标>.json，
    // 让人一眼能从文件名分出「这是地图」还是「这是界面」。
    const file = isUi ? `ui_${i}.json` : `scene_${i}.json`;

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

    const width = isUi
      ? positiveIntField(scene?.designW, 1280, `${sceneLabel} designW`, warnings)
      : positiveIntField(scene?.widthTiles, gridW, `${sceneLabel} widthTiles`, warnings);
    const height = isUi
      ? positiveIntField(scene?.designH, 720, `${sceneLabel} designH`, warnings)
      : positiveIntField(scene?.heightTiles, gridH, `${sceneLabel} heightTiles`, warnings);
    // onStartScript：编辑器存 key，运行时按 name 查（ScriptEngine 读 scene_*.json 的该字段）。
    const startScriptKey = String(scene?.onStartScript ?? "");
    const startScriptName = startScriptKey ? (scriptNameByKey.get(startScriptKey) ?? startScriptKey) : "";
    //
    // UI 场景的几何：运行时统一用 `width × tileSize` 求地图像素尺寸（mapWidth/mapHeight），
    // 为了不改这条老公式，UI 场景把 tileSize 写成 1、width 写设计宽 —— 结果正好是设计分辨率像素。
    // 代价是 scene.tileSize=1，但 UI 场景里本来就不存在「格」这个概念，脚本读 scene.tileSize
    // 也只会拿到 1（不是误导值：UI 里 1 单位 = 1 设计像素，这正是事实）。
    const sceneJson = {
      width,
      height,
      tileSize: isUi ? 1 : tileSize,
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
    if (isUi) {
      sceneJson.ui = true;
      sceneJson.designW = width;
      sceneJson.designH = height;
    }
    // ---- 开放世界新增段（全部可选；UI 场景没有空间结构，不写）----
    // 只有工程里真的带了这些字段才写出，旧 .bwproj 导出的 scene_*.json 与今天逐字节一致。
    // 运行时（GameData.loadScene）对缺失字段一律走安全缺省 = 单层平地，行为不变。
    if (!isUi) {
      if (Array.isArray(scene?.buildings) && scene.buildings.length) {
        sceneJson.buildings = scene.buildings;
      }
      if (Array.isArray(scene?.navLinks) && scene.navLinks.length) {
        sceneJson.navLinks = scene.navLinks;
      }
      if (scene?.roadNetwork && typeof scene.roadNetwork === "object") {
        const rn = scene.roadNetwork;
        const nodes = Array.isArray(rn.nodes) ? rn.nodes : [];
        const edges = Array.isArray(rn.edges) ? rn.edges : [];
        if (nodes.length || edges.length) {
          sceneJson.roadNetwork = { nodes, edges };
        }
      }
    }
    // ---- 2D 光照（可选段；契约 docs/_fragments/lighting-contract.md §3）----
    //
    // 与 buildings/navLinks 同一条纪律：**只有工程里真的有才写**。
    // 旧 .bwproj 没有 scene.lighting ⇒ 这里一个键都不加 ⇒ scene_*.json 与改动前逐字节一致，
    // 运行时 GameData.RtLighting 保持 null ⇒ 光照层完全不启用（零回归）。
    //
    // 为什么必须在这里显式透传而不是靠"对象 props 已经带过去了"：
    //   `lighting` 是**场景级**配置（ambient/darkness/softness/采样率），它不在任何一个对象上；
    //   `lightmap` 是烘焙产物的**引用**（assetId + 覆盖矩形 + 纹素尺寸）。
    //   少了这两段，运行时会以为"这个工程没开光照"，编辑器里烘焙得再漂亮进游戏也是白天 ——
    //   这正是端到端验收第一次跑出来的真实断点（数学全对、像素完全没变化）。
    if (!isUi) {
      const lighting = scene?.lighting;
      if (lighting && typeof lighting === "object") {
        // 逐字段取值 + 类型兜底：运行时按名字读，任何 NaN/字符串都会让衰减公式炸成 0 或 NaN。
        // enabled 必须是真布尔：字符串 "false" 在 Gson 里 getAsBoolean() 会得到 false，
        // 但 `=== true` 这类判断在 JS 侧会误判 —— 统一用 Boolean(...) 归一。
        sceneJson.lighting = {
          enabled: lighting.enabled === true,
          mode: LIGHTING_MODES.has(String(lighting.mode ?? "")) ? String(lighting.mode) : "both",
          ambientColor: hexColorOr(lighting.ambientColor, "#3A4A6B"),
          ambientIntensity: clampNum(lighting.ambientIntensity, 0, 1, 0.35),
          darkness: clampNum(lighting.darkness, 0, 1, 0.35),
          softness: clampNum(lighting.softness, 0, 128, 16),
          texelsPerPixel: clampNum(lighting.texelsPerPixel, 0.02, 2, 0.25),
          dynamicFps: clampNum(lighting.dynamicFps, 1, 60, 15),
          maxDynamicLights: Math.max(0, Math.trunc(finiteNumber(lighting.maxDynamicLights, 8)))
        };
        if (!sceneJson.lighting.enabled) {
          warnOnce(
            warnings,
            `${sceneLabel}：有光照设置但总开关是关的（enabled=false），游戏里按白天渲染；要看到光照请在光照面板打开总开关`
          );
        }
        if (sceneJson.lighting.mode === "baked" && !scene?.lightmap) {
          warnOnce(
            warnings,
            `${sceneLabel}：光照模式是「只用烘焙图」，但这个场景还没有烘焙过 —— 游戏里只会看到环境光。请先点「一键烘焙」`
          );
        }
      }
      const lm = scene?.lightmap;
      if (lm && typeof lm === "object" && String(lm.assetId ?? "").trim()) {
        const lmAssetId = String(lm.assetId).trim();
        if (!runtimeAssets.has(lmAssetId)) {
          warnOnce(
            warnings,
            `${sceneLabel}：烘焙贴图引用的素材「${lmAssetId}」不在工程素材库里（可能被删了），光照只剩动态层。请重新烘焙`
          );
        } else {
          sceneJson.lightmap = {
            assetId: lmAssetId,
            x: finiteNumber(lm.x, 0),
            y: finiteNumber(lm.y, 0),
            w: Math.max(0, finiteNumber(lm.w, 0)),
            h: Math.max(0, finiteNumber(lm.h, 0)),
            texW: Math.max(0, Math.trunc(finiteNumber(lm.texW, 0))),
            texH: Math.max(0, Math.trunc(finiteNumber(lm.texH, 0))),
            texelsPerPixel: Math.max(0, finiteNumber(lm.texelsPerPixel, 0)),
            lights: Math.max(0, Math.trunc(finiteNumber(lm.lights, 0))),
            version: Math.max(0, Math.trunc(finiteNumber(lm.version, 0)))
          };
          if (sceneJson.lightmap.w <= 0 || sceneJson.lightmap.h <= 0) {
            warnOnce(
              warnings,
              `${sceneLabel}：烘焙贴图的覆盖矩形宽高是 0，运行时会退回「覆盖整张场景」——如果场景尺寸改过，请重新烘焙`
            );
          }
        }
      }
    }
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
    if (isUi) {
      uiScenes.push({
        name: scene?.name ?? `UI ${i + 1}`,
        file,
        designW: width,
        designH: height,
        // 图层数量给运行时一个「按层画」的上限参考；实际排序仍用对象上的 layer
        layers: sceneJson.layers.length
      });
    } else {
      scenes.push({
        name: scene?.name ?? `场景 ${i + 1}`,
        file,
        width,
        height
      });
    }
  }
  if (scenes.length > 1) {
    warnOnce(
      warnings,
      `工程有 ${scenes.length} 个世界场景，运行时只加载第一张「${scenes[0]?.name ?? ""}」，其余场景不会生效`
    );
  }
  if (uiScenes.length) {
    logStep(onLog, `已导出 ${uiScenes.length} 张 UI 场景（设计分辨率绘制，覆盖在世界画面之上）`);
  }
  if (!scenes.length) {
    // UI 场景不进 scenes[]，但如果工程只有 UI 场景，运行时就没有世界场景可加载 → 会直接报错退出。
    warnOnce(warnings, "工程没有任何世界场景，只有 UI 场景：运行时会以一张「空地图」兜底加载");
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

  // 预制体：运行期启动时把这份表逐个 bwe.prefab.define 一遍，之后 spawn 就是实例化。
  // 老工程没有这个字段时输出空数组（不是省略）：Java 侧 arr() 两种都认，显式空表更好排查。
  const prefabs = prefabBootList(project, assetNames, scriptNameByKey, scriptLangByKey, warnings);
  if (prefabs.length) logStep(onLog, `已导出 ${prefabs.length} 个预制体到 boot.json`);

  const boot = {
    project: String(project.name ?? "未命名工程"),
    tileSize,
    masterVolume: finiteNumber(project.masterVolume, 0.8),
    scenes,
    variables,
    scripts,
    // 玩法模块按素材名找图；这张表必须有。
    assets: Array.from(runtimeAssets.values()),
    // 预制体模板：编辑器「左栏 → 预制体」页维护，运行期用 bwe.prefab.spawn(name) 生成。
    prefabs
  };
  // UI 场景：单独一段。**只有真的有 UI 场景时才写**，所以旧工程导出的 boot.json 逐字节不变
  // （运行时 GameData 对缺失的 uiScenes 走空表 = 没有界面层，行为与今天一致）。
  if (uiScenes.length) {
    boot.uiScenes = uiScenes;
  }
  // 可选：全局入口脚本名（有就跑 onSceneStart 前先执行）。编辑器还没提供这个字段时就不写。
  const jsMain = String(project.jsMain ?? "").trim();
  if (jsMain) boot.jsMain = jsMain;
  await writeFile(join(buildDir, "boot.json"), JSON.stringify(boot, null, 2), "utf8");
  if (runtimeAssets.size === 0) warnOnce(warnings, "工程没有任何素材：运行时会只画色块");
  return { boot, scenes, uiScenes, runtimeAssets };
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

// ---------------- Android 打包（Gradle assembleDebug → APK） ----------------
//
// BWE Android 移植的打包路径：和 Windows exe 共用 writeBuild 的导出契约（Build/boot.json +
// Build/scene_0.json + Build/scripts/*.js + Build/assets/**），只是产物从 jpackage 换成
// `./gradlew assembleDebug` 出的 APK。APK 拷到 android/app/src/main/assets/BWE/...，
// 由 BweAndroidGameView / BweAndroidGame（Studio.android）消费。
//
// 资产布局约定（与桌面端「assetRoot 是 Build 的父目录」一致）：
//   - boot：android/app/src/main/assets/BWE/boot.json
//   - 素材：android/app/src/main/assets/BWE/Build/assets/<assetId>/<file>
//          （boot.assets[].path 形如 "Build/assets/<id>/<file>"）

const ANDROID_ROOT = resolve(projectRoot, "android");
const ANDROID_GRADLE = process.platform === "win32" ? join(ANDROID_ROOT, "gradlew.bat") : join(ANDROID_ROOT, "gradlew");
/** 变体名 → Gradle 任务名 / APK 相对路径。默认 release（正式包）。 */
const ANDROID_VARIANTS = {
  release: { task: "assembleRelease", apkRel: join("app", "build", "outputs", "apk", "release", "app-release.apk") },
  debug: { task: "assembleDebug", apkRel: join("app", "build", "outputs", "apk", "debug", "app-debug.apk") }
};

/** APK 的资产落点：android/app/src/main/assets/BWE（运行时按 "BWE/boot.json" 打开）。 */
const ANDROID_ASSETS = join(ANDROID_ROOT, "app", "src", "main", "assets", "BWE");

async function stageAndroidAssets(buildDir) {
  // 先清掉上一次暂存的资产，避免删掉的素材还留在 APK 里。
  await rm(ANDROID_ASSETS, { recursive: true, force: true });
  await mkdir(ANDROID_ASSETS, { recursive: true });
  // 关键：保持和桌面端一样的目录契约 —— boot.json 在 Build/ 里，
  // 并且 boot.assets[].path 形如 "Build/assets/<id>/<file>"（相对 Build 的父目录）。
  // 所以这里把整个 Build/ 原样搬到 assets/BWE/Build/，运行时以 "BWE/" 为 assetRoot，
  // 拼出来的 "BWE/Build/assets/..." 正好命中 APK 条目。
  await copyDir(join(buildDir, "Build"), join(ANDROID_ASSETS, "Build"));
  return join(ANDROID_ASSETS, "Build", "boot.json");
}

/** 递归复制目录（node 标准库无 cp，自己写，保持打包链路零依赖）。 */
async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await copyFile(s, d);
    }
  }
}

async function runGradleVariant(variant, onLog, onStdout, onStderr) {
  // 没有 wrapper 就直接报清楚，不要让 cmd 吐出「'gradlew.bat' 不是内部或外部命令」。
  if (!existsSync(ANDROID_GRADLE)) {
    throw new Error(
      `Android 工程缺少 Gradle wrapper：${ANDROID_GRADLE} 不存在。`
        + `请先在 android/ 目录执行一次 \`gradle wrapper\` 生成 gradlew/gradlew.bat，`
        + `或把已生成的 wrapper 文件签入仓库。`
    );
  }
  // Gradle 构建 Android 时的 JDK 区间是 [11, 19]：
  //   - 上界：Gradle 7.5.1 自带 Groovy 3.0.10 读不了 JDK 20+ 的 class 文件
  //     （Unsupported class file major version 69）；
  //   - 下界：AGP 7.4.2 声明自身 API 兼容 Java 11，用 JDK 8 会报
  //     "No matching variant of com.android.tools.build:gradle:7.4.2"。
  // 这台机 PATH 上的 java 是 JDK 26，直接用会把「源码问题」误报成 Gradle 启动失败。
  const gradleJdk = await findRuntimeJdk(19, 11);
  const env = { ...process.env };
  if (gradleJdk.chosen) {
    env.JAVA_HOME = dirname(dirname(gradleJdk.chosen.javaExe));
    logStep(onLog, `Gradle 使用 JDK ${gradleJdk.chosen.major}：${env.JAVA_HOME}`);
  } else {
    logStep(onLog, "⚠ 没找到 JDK 8~25，Gradle 将回落到 PATH 上的 java，可能因版本过高而失败");
  }
  // gradlew 是 shell 脚本：Windows 走 cmd /c gradlew.bat，其它走 sh gradlew。
  const command = process.platform === "win32" ? "cmd.exe" : "sh";
  const task = ANDROID_VARIANTS[variant].task;
  const args = process.platform === "win32" ? ["/c", "gradlew.bat", task] : ["gradlew", task];
  return run(command, args, { cwd: ANDROID_ROOT, env, onStdout, onStderr });
}

/**
 * 打包当前工程为 Android APK（debug）。复用 writeBuild，产物交给 android/ Gradle 工程。
 *
 * @param {object} project .bwproj JSON
 * @param {Array} uploadedAssets 浏览器上传的素材
 * @param {object} options { name, version, jobId }
 */
/** 正式签名 keystore 是否就位（打包脚本与 Gradle 用的是同一套环境变量约定）。 */
function hasReleaseKeystore() {
  const declared = process.env.BWE_KEYSTORE;
  if (declared && existsSync(declared)) return true;
  return existsSync(join(ANDROID_ROOT, "bwe-release.jks"));
}

/**
 * 打包当前工程为 Android APK。复用 writeBuild，产物交给 android/ Gradle 工程。
 *
 * 默认产 release（正式包，debuggable=false）。options.variant="debug" 才打测试包。
 * 没有正式 keystore 时会退回 debug 签名 —— 那种产物本质仍是测试包，
 * 所以结果里的 isTestPackage / releaseSigned 会如实标出来。
 *
 * @param {object} project .bwproj JSON
 * @param {Array} uploadedAssets 浏览器上传的素材
 * @param {object} options { name, version, jobId, variant, outDir }
 */
/** 包名合法性：Android applicationId 要求每段以字母开头、只含字母数字下划线。 */
function normalizeAppId(raw, fallbackName) {
  const src = String(raw || "").trim();
  if (src) {
    const cleaned = src.replace(/[^A-Za-z0-9._]/g, "");
    if (/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(cleaned)) {
      return cleaned;
    }
  }
  // 没给或非法：用工程名做一段，套默认前缀（保证可安装且不与他人撞车）。
  const seg = String(fallbackName || "game")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^[^a-z]+/, "");
  const tail = seg || "game";
  return `studio.bwe.${tail}`;
}

/** 版本号 → versionName + versionCode（Android 要求 code 是单调递增整数）。 */
function androidVersion(version) {
  const parts = String(version || "1.0").split(".").map((x) => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.push(0);
  const [maj, min, pat] = parts;
  const code = Math.max(1, maj * 10000 + min * 100 + pat);
  return { versionName: `${maj}.${min}.${pat}`, versionCode: code };
}

/**
 * 准备图标：把工程里的 icon（PNG）转成各密度 mipmap。
 *
 * 原图交给 Android 自己缩放并不可靠（BitmapFactory 只能解码，不能按密度切图），
 * 所以直接按 5 个密度生成同一张图（尺寸不同即可，视觉上够用）。
 * 没有 icon 或解码失败 → 保留内置默认图标（res 下的 mipmap-* 目录）。
 */
async function stageAndroidIcon(jobDir, iconDataUrl, onLog) {
  const iconDir = join(ANDROID_ROOT, "app", "src", "bweIcon", "res");
  // 每次先清掉上一次工程的图标，避免「换了工程还是旧图标」。
  await rm(join(ANDROID_ROOT, "app", "src", "bweIcon"), { recursive: true, force: true });
  if (!iconDataUrl) {
    return { staged: false, reason: "工程没有设置 icon" };
  }
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(String(iconDataUrl).trim());
  if (!m) {
    return { staged: false, reason: "icon 不是 data URL（PNG/JPEG）" };
  }
  const buf = Buffer.from(m[2], "base64");
  if (buf.length === 0) {
    return { staged: false, reason: "icon 解码为空" };
  }
  // 校验真的是完整 PNG：aapt2 遇到坏图会整个资源编译失败（Duplicate resources 之后
  // 的下一个坑就是它）。只检查签名 + IEND，够了——不引入图像库依赖。
  const pngOk = buf.length > 1000
    && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && buf.includes(Buffer.from("IEND"));
  if (!pngOk) {
    return { staged: false, reason: "icon 不是完整 PNG（aapt2 会编译失败）" };
  }
  const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, size] of Object.entries(densities)) {
    const dir = join(iconDir, `mipmap-${d}`);
    await mkdir(dir, { recursive: true });
    // Android 会把任意分辨率的图按 density 缩放，所以这里直接写原图，
    // 由 aapt 归到各 density 桶里即可（不引入图像库依赖）。
    // 用独立资源名 app_icon：内置默认图标叫 ic_launcher，
    // 两者同名会在 mergeReleaseResources 阶段报 Duplicate resources。
    await writeFile(join(dir, "app_icon.png"), buf);
  }
  onLog?.(`图标已就绪（${densities.xhdpi}px 基准，5 个密度）`);
  return { staged: true, bytes: buf.length };
}

/**
 * 决定屏幕方向。
 *
 * <p>优先级：显式参数 > 工程字段 > 按场景宽高比推断。
 * 工程里目前没有 orientation 字段（扫雷工程的 HUD 是脚本按 isPortrait 自适应的），
 * 所以默认用场景比例判断：宽 > 高 = 横屏，否则竖屏。
 */
function decideOrientation(project, explicit) {
  const raw = String(explicit || project.orientation || project.screenOrientation || "").trim().toLowerCase();
  if (raw === "portrait" || raw === "竖屏") return "portrait";
  if (raw === "landscape" || raw === "横屏") return "landscape";
  // 用第一个场景的格数比例推断。
  // ⚠ .bwproj 里场景尺寸的实际字段是 widthTiles / heightTiles（不是 width/height），
  // 早期只读 width/height 会永远拿不到值 → 所有工程都被判成横屏，
  // 「扫雷-竖屏」打出来也是横的。这里两种字段都认，并按 gridW/gridH 兜底。
  const sc = (project.scenes || [])[0] || {};
  const sw = Number(sc.widthTiles ?? sc.width ?? project.gridW ?? 0);
  const sh = Number(sc.heightTiles ?? sc.height ?? project.gridH ?? 0);
  if (sw > 0 && sh > 0) {
    return sw >= sh ? "landscape" : "portrait";
  }
  return "landscape";
}

/** 把应用元数据写进 android/app/bwe-meta.properties（Gradle 从这读，避免命令行中文编码问题）。 */
async function writeAndroidMeta(meta) {
  const lines = [
    `applicationId=${meta.applicationId}`,
    `label=${meta.label}`,
    `versionName=${meta.versionName}`,
    `versionCode=${meta.versionCode}`,
    `orientation=${meta.orientation || "landscape"}`,
    `splashColor=${meta.splashColor || "#0A0B10"}`
  ];
  await writeFile(join(ANDROID_ROOT, "app", "bwe-meta.properties"), lines.join("\n") + "\n", "utf8");
}

/**
 * 打包当前工程为 Android APK。复用 writeBuild，产物交给 android/ Gradle 工程。
 *
 * 默认产 release（正式包，debuggable=false）。options.variant="debug" 才打测试包。
 * 没有正式 keystore 时退回 debug 签名 —— 那种产物本质仍是测试包，
 * 所以结果里的 isTestPackage / releaseSigned 会如实标出来。
 *
 * @param {object} project .bwproj JSON
 * @param {Array} uploadedAssets 浏览器上传的素材
 * @param {object} options { name, version, jobId, variant, outDir, applicationId, icon, splashColor }
 */
export async function packageAndroid(project, uploadedAssets, options = {}, onLog = console.log) {
  if (!project || !Array.isArray(project.scenes)) {
    throw new Error("工程数据不完整：缺少 scenes");
  }
  const variant = options.variant === "debug" ? "debug" : "release";
  const jobId = safeId(options.jobId || `build_android_${Date.now()}`);
  const outRoot = resolve(options.outDir || join(packageRoot, jobId));
  const buildDir = join(outRoot, "work");
  const outDir = join(outRoot, "out");
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const appName = safeSegment(options.name || project.name || "BWE-Android", "BWE-Android");
  const rawVersion = safeVersion(options.version || project.version);
  const { versionName, versionCode } = androidVersion(rawVersion);
  const warnings = [];

  // ---------- 包名 / 显示名 / 图标（正式包必需） ----------
  const applicationId = normalizeAppId(
    options.applicationId || project.applicationId || project.packageName,
    appName
  );
  const label = String(options.label || appName);
  const iconResult = await stageAndroidIcon(jobId, options.icon || project.icon, onLog);
  if (!iconResult.staged && iconResult.reason) {
    logStep(onLog, `图标未使用工程 icon（${iconResult.reason}），沿用内置默认图标`);
  }
  const orientation = decideOrientation(project, options.orientation || options.screenOrientation);
  await writeAndroidMeta({
    applicationId,
    label,
    versionName,
    versionCode,
    orientation,
    splashColor: options.splashColor || project.splashColor
  });
  logStep(onLog, `包名 ${applicationId} · 显示名「${label}」· 版本 ${versionName}(${versionCode}) · ${orientation}`);

  // 正式包的前提是有正式签名密钥。没有就必须说明这是一次「测试包」的构建，
  // 而不是悄悄产出一个 debuggable 的包还叫它正式版。
  const releaseSigned = variant === "release" && hasReleaseKeystore();
  const isTestPackage = variant === "debug" || (variant === "release" && !releaseSigned);
  if (variant === "release" && !releaseSigned) {
    warnOnce(
      warnings,
      "未找到正式签名 keystore（android/bwe-release.jks 或环境变量 BWE_KEYSTORE），"
        + "release 变体会退回 debug 签名：这个包是测试包，debuggable=true，不能上架。"
        + "要出正式包：设置 BWE_KEYSTORE / BWE_KEYSTORE_PASS / BWE_KEY_ALIAS / BWE_KEY_PASS 后重新打包。"
    );
  }

  logStep(onLog, `开始打包 Android「${appName}」v${versionName}（${variant} 变体）`);
  logStep(onLog, "1/2 转换工程数据与素材…");
  const uploaded = uploadedAssets ? normalizeUploadedAssets(uploadedAssets) : await collectDataUrlAssets(project, onLog);
  const build = await writeBuild(project, buildDir, uploaded.files, onLog, warnings, uploaded.problems);
  for (const w of warnings) logStep(onLog, `⚠ ${w}`);

  logStep(onLog, `2/2 运行 Gradle ${ANDROID_VARIANTS[variant].task}…`);
  await stageAndroidAssets(buildDir);
  const gradle = await runGradleVariant(variant,
    (s) => s.trim() && logStep(onLog, s.trim()),
    (s) => s.trim() && logStep(onLog, s.trim()),
    (s) => s.trim() && logStep(onLog, s.trim())
  );
  const apkSrc = join(ANDROID_ROOT, ANDROID_VARIANTS[variant].apkRel);
  if (!existsSync(apkSrc)) {
    throw new Error(`Gradle 已结束但没有产出 APK：${apkSrc} 不存在。gradle 输出：${(gradle.out || "").slice(-800)}`);
  }
  // 把 APK 复制到本次任务自己的 out 目录：android/app/build 会被下次构建覆盖，
  // 而下载接口拿的是 job.result.apkPath，必须指向本任务独占的文件。
  // 文件名如实反映包的性质：只有真正正式签名的才叫 -release，否则一律带 -debug 后缀。
  const suffix = isTestPackage ? "debug" : "release";
  const apkPath = join(outDir, `${appName}-${suffix}.apk`);
  await copyFile(apkSrc, apkPath);
  const s = await stat(apkPath);
  if (isTestPackage) {
    logStep(onLog, `⚠ 产物是测试包（${variant}${releaseSigned ? "" : " / 无正式签名"}）：可安装调试，不能上架`);
  }
  return {
    platform: "android",
    variant,
    releaseSigned,
    isTestPackage,
    applicationId,
    label,
    versionName,
    versionCode,
    orientation,
    iconStaged: iconResult.staged,
    appName,
    version: versionName,
    outDir,
    buildDir,
    apkPath,
    apkName: basename(apkPath),
    sizeBytes: s.size,
    warnings,
    boot: build.boot
  };
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

﻿
/**
 * 导出 Web 游戏包。
 *
 * 与 Windows / Android 的目标不同点：Web 产物不是一个可执行容器，而是一个
 * 目录——把 Build 产物 + 播放器（player.js）+ index.html 摆在一起，扔到任何
 * 静态服务器上就能玩。
 *
 * 关键约束：浏览器里没有 JOGL（它是本地库），所以 Web 端不能用 Java 渲染。
 * 这里的做法是「同一份 Build 产物，换一个渲染实现」：web/src/webplayer 是
 * 一个消费 boot.json / scene_0.json / assets 的 WebGL2 播放器。数据格式完全相同，
 * 脚本源码（ES5）直接复用。
 *
 * 诚实说明：播放器目前实现的 API 是渲染/输入/时间/相机/基础音频与基础绘制
 * （见 web/src/webplayer/api.ts 里的三级清单）。用到 bwe.road / bwe.combat
 * 这类高级命名空间的项目，在 Web 端会缺少对应行为，但**不会静默失败**——
 * 会在控制台按名字报出来，可用 __bwe_report() 一次看全。
 */
export async function packageWeb(project, uploadedAssets, options = {}, onLog = console.log) {
  if (!project || !Array.isArray(project.scenes)) {
    throw new Error("工程数据不完整：缺少 scenes");
  }
  const jobId = safeId(options.jobId || `build_web_${Date.now()}`);
  const outRoot = resolve(options.outDir || join(packageRoot, jobId));
  const buildDir = join(outRoot, "work");
  const outDir = join(outRoot, "out");
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const appName = safeSegment(options.name || project.name || "BWE-Web", "BWE-Web");
  const version = safeVersion(options.version || project.version);
  const warnings = [];

  logStep(onLog, `开始导出 Web 包「${appName}」v${version}`);

  // 1/3 工程数据 -> Build 产物（与 Windows/Android 完全同一条路径）
  logStep(onLog, "1/3 转换工程数据与素材…");
  const uploaded = uploadedAssets
    ? normalizeUploadedAssets(uploadedAssets)
    : await collectDataUrlAssets(project, onLog);
  const build = await writeBuild(project, buildDir, uploaded.files, onLog, warnings, uploaded.problems);
  for (const w of warnings) logStep(onLog, `⚠ ${w}`);

  // 2/3 把 Build 产物挪到产物根目录下
  logStep(onLog, "2/3 拷贝 Build 产物…");
  // writeBuild 把产物写进 <buildDir>/Build，所以源目录要再下一层，
  // 否则会得到 Build/Build/boot.json，播放器按 Build/boot.json 找就会 404。
  const buildSrc = join(buildDir, "Build");
  const buildOut = join(outDir, "Build");
  if (!existsSync(buildSrc)) {
    throw new Error(`writeBuild 没有产出 Build 目录: ${buildSrc}`);
  }
  await cp(buildSrc, buildOut, { recursive: true });

  // 3/3 打包播放器：esbuild 把 web/src/webplayer 打成一个 player.js
  logStep(onLog, "3/3 打包 Web 播放器…");
  const playerSrc = join(webRoot, "src", "webplayer", "main.ts");
  if (!existsSync(playerSrc)) {
    throw new Error(`找不到播放器源码: ${playerSrc}`);
  }
  const playerOut = join(outDir, "player.js");
  const esbuildBin = join(projectRoot, "node_modules", "esbuild", "bin", "esbuild");
  const esbuildArgs = [
    playerSrc,
    "--bundle",
    "--format=iife",
    "--platform=browser",
    "--target=es2020",
    "--minify",
    `--outfile=${playerOut}`,
  ];
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [esbuildBin, ...esbuildArgs], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`播放器打包失败 (exit ${code}):\n${err}`));
    });
  });

  // index.html：标题替换成工程名
  const htmlSrc = join(webRoot, "src", "webplayer", "index.html");
  let html = await readFile(htmlSrc, "utf8");
  html = html.replace(/__BWE_GAME_TITLE__/g, escapeHtml(appName));
  await writeFile(join(outDir, "index.html"), html, "utf8");

  // 一份 README，说明怎么把它跑起来 / 怎么部署
  const readme = [
    `# ${appName} (Web 导出)`,
    "",
    `由 BrokenWonderEngine 导出于 ${new Date().toISOString()}`,
    "",
    "## 怎么跑起来",
    "",
    "浏览器不允许直接从 file:// 读 JSON（fetch 被拦），所以要起一个静态服务器：",
    "",
    "```bash",
    "npx serve .",
    "# 或",
    "python -m http.server 8000",
    "```",
    "",
    "然后打开提示的地址。",
    "",
    "## 怎么部署",
    "",
    "把整个目录原样上传到任意静态托管（itch.io、GitHub Pages、Netlify、Nginx）即可。",
    "没有后端依赖，没有特殊响应头要求。",
    "",
    "## 出问题时",
    "",
    "打开浏览器控制台：",
    "",
    "- `__bwe_stats` — 帧率、帧耗时、对象数、draw call",
    "- `__bwe_report()` — 哪些 API 在 Web 端还没实现（这是导出产物，不是 bug）",
    "",
    "### 已知限制",
    "",
    "Web 播放器复用同一份 Build 数据，但渲染是由 WebGL2 重新实现的，",
    "而不是运行 Java 运行时。以下能力在 Web 端是简化或缺失的：",
    "",
    "- 高级玩法命名空间（road / vehicle / combat / material / field / sense /",
    "  faction / nav / physics / quest / dialog 等）尚未移植",
    "- 光照与后处理未实现",
    "- 虚拟摇杆、输入框等移动端 UI 控件未实现",
    "",
    "用到这些的项目，Web 端会在控制台按名字报出缺失调用，不会静默失效。",
    "",
    `工程名: ${appName}`,
    `版本: ${version}`,
    `素材: ${(build.assets ?? []).length ?? "?"}`,
    "",
  ].join("\n");
  await writeFile(join(outDir, "README-WEB.md"), readme, "utf8");

  const zipPath = await zipWeb(outDir, appName, onLog);
  const zipStats = await stat(zipPath);
  const stats = {
    platform: "web",
    appName,
    version,
    outDir,
    zipPath,
    zipName: basename(zipPath),
    sizeBytes: zipStats.size,
    playerBytes: (await stat(playerOut)).size,
    buildFiles: await countFiles(buildOut),
    warnings,
    limitations: [
      "高级玩法命名空间未移植（road/vehicle/combat/material/field/sense/faction/nav/physics/quest/dialog）",
      "光照与后处理未实现",
      "移动端虚拟摇杆与输入控件未实现",
    ],
  };
  logStep(onLog, `完成：${outDir}`);
  logStep(onLog, `player.js ${(stats.playerBytes / 1024).toFixed(1)} KB · Build 内 ${stats.buildFiles} 个文件`);
  logStep(onLog, "提示：Web 端复用同一份 Build 数据，但渲染是 WebGL2 重写的，不是 Java 运行时。");
  return stats;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function zipWeb(outDir, appName, onLog) {
  const zipPath = join(dirname(outDir), `${appName}-web.zip`);
  await rm(zipPath, { force: true });
  logStep(onLog, `压缩 Web 包：${zipPath}`);
  if (process.platform === "win32") {
    const script = `Compress-Archive -Path '${join(outDir, "*").replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: dirname(outDir) });
  } else {
    await run("tar", ["-a", "-c", "-f", zipPath, "-C", outDir, "."], { cwd: dirname(outDir) });
  }
  return zipPath;
}

async function countFiles(dir) {
  let n = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else n++;
    }
  };
  await walk(dir);
  return n;
}

// scriptParamKeys 只给校验脚本用（verify-script-params 断言「残留键会告警」直接调它）；
// 它不是导出契约的一部分，改签名不影响 boot.json。
export { safeSegment, safeVersion, extensionForAsset, writeBuild, decideOrientation, scriptParamKeys };
