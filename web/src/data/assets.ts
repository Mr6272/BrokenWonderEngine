/**
 * 素材库（Web 版）。
 *
 * 与桌面版最大的不同：浏览器拿不到本地文件路径，所以用户导入的图片
 * 以二进制形式存放在 IndexedDB 里，工程文件只记住素材 id。
 * 这样工程换台机器打开，只要素材库跟着走（或换用 URL 素材）就还能用。
 *
 * 三种导入方式，覆盖用户真实会遇到的场景：
 *   1. 逐张导入：一次选多张图，一张一条；
 *   2. 序列帧导入：一次选一组图（待机1.png、待机2.png…），自动按名字前缀分组；
 *   3. 图集切片：一张大图按行列切成多帧。
 */

import type { AssetEntry, AssetKind, Project } from "../core/model.ts";
import { totalFrames, uid } from "../core/model.ts";

const DB_NAME = "bwe-studio";
const DB_VERSION = 1;
const STORE_ASSET = "assets";
const STORE_PROJECT = "project";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ASSET)) db.createObjectStore(STORE_ASSET);
      if (!db.objectStoreNames.contains(STORE_PROJECT)) db.createObjectStore(STORE_PROJECT);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("无法打开本地素材库"));
  });
  return dbPromise;
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(store: string, key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbKeys(store: string): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAllKeys();
    req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
    req.onerror = () => reject(req.error);
  });
}

// ---------------- 图片缓存 ----------------

export interface LoadedImage {
  /** canvas 的 drawImage 能直接吃这几种类型；图集切片产出的是 HTMLCanvasElement */
  bitmap: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
  width: number;
  height: number;
}

const imageCache = new Map<string, LoadedImage>();
const missing = new Set<string>();

/** 去重后的图片加载结果缓存 key：素材 id + 帧下标 */
export function frameKey(assetId: string, frame: number): string {
  return `${assetId}#${frame}`;
}

/**
 * 解码位图的缓存上限（按条目数）。
 *
 * 为什么要上限：ImageBitmap 是**显存/系统位图内存**，浏览器不会因为 Map 里删了键就回收，
 * 必须显式 close()。编辑器里「改图集行列数」「换素材」「反复预览序列帧」都会产生新的键，
 * 旧实现只 delete 键、从不 close，于是开久了位图只增不减 —— 这是「越用越卡」的第二个来源。
 * 这里同时做两件事：超过上限按最久未用淘汰，淘汰时一定 close。
 */
const MAX_IMAGE_CACHE = 400;
const MAX_WHOLE_CACHE = 160;

/** LRU：把刚用到的键挪到末尾（Map 保证插入顺序），淘汰时从头部拿。 */
function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

/** 释放一张位图。只有 ImageBitmap 才有 close()，HTMLImageElement/Canvas 靠 GC。 */
function releaseImage(img: LoadedImage | undefined): void {
  if (!img) return;
  const b = img.bitmap as ImageBitmap;
  if (typeof b.close === "function") {
    try {
      b.close();
    } catch {
      /* 已经关过或已被转移控制权；重复关闭不该中断调用方 */
    }
  }
}

/**
 * 从缓存里摘掉某个键并释放它。
 *
 * `keep` 用来避开「同一个位图被两张缓存表共享」的情况：
 * `loadWhole` 的结果会被 `loadRaw` 读去做图集切片，两条缓存可能指着同一个 ImageBitmap。
 * 只 close 一次是安全的，但 close 之后另一张表里就是死引用 ——
 * 所以摘除时一并把引用同一对象的兄弟条目也摘掉。
 */
function dropEntry(map: Map<string, LoadedImage>, key: string): void {
  const hit = map.get(key);
  if (!hit) return;
  map.delete(key);
  for (const [k, v] of Array.from(map.entries())) if (v.bitmap === hit.bitmap) map.delete(k);
  releaseImage(hit);
}

export async function loadFrame(asset: AssetEntry | undefined, frame: number): Promise<LoadedImage | null> {
  if (!asset) return null;
  const key = frameKey(asset.id, frame);
  const hit = imageCache.get(key);
  if (hit) {
    touch(imageCache, key, hit);
    return hit;
  }
  if (missing.has(key)) return null;

  try {
    const img = await loadRaw(asset, frame);
    if (!img) {
      missing.add(key);
      return null;
    }
    imageCache.set(key, img);
    while (imageCache.size > MAX_IMAGE_CACHE) {
      const oldest = imageCache.keys().next();
      if (oldest.done) break;
      dropEntry(imageCache, oldest.value);
    }
    return img;
  } catch {
    missing.add(key);
    return null;
  }
}

async function loadRaw(asset: AssetEntry, frame: number): Promise<LoadedImage | null> {
  if (asset.kind === "AUDIO") return null;

  // 图集：先取整图，再切出子图（切出来的是 canvas，成本低于反复 drawImage 缩略图）
  if (asset.kind === "ATLAS") {
    const whole = await loadWhole(asset);
    if (!whole) return null;
    const cw = asset.cellW ?? Math.floor(whole.width / Math.max(1, asset.cols ?? 1));
    const ch = asset.cellH ?? Math.floor(whole.height / Math.max(1, asset.rows ?? 1));
    if (cw <= 0 || ch <= 0) return whole;
    const cols = Math.max(1, asset.cols ?? 1);
    const idx = Math.max(0, Math.min(totalFrames(asset) - 1, frame));
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const g = c.getContext("2d");
    if (!g) return whole;
    g.imageSmoothingEnabled = false;
    g.drawImage(whole.bitmap as CanvasImageSource, col * cw, row * ch, cw, ch, 0, 0, cw, ch);
    return { bitmap: c, width: cw, height: ch };
  }

  // 序列帧：每帧一张独立图
  if (asset.kind === "SEQUENCE") {
    return loadWhole(asset, frame);
  }

  return loadWhole(asset, 0);
}

const wholeCache = new Map<string, LoadedImage>();

/** 读取原始二进制。打包音频时用得到；图片解码也会先经过这里。 */
export async function assetRawBlob(asset: AssetEntry, frame = 0): Promise<Blob | null> {
  if (asset.src === "url" && asset.url) {
    const resp = await fetch(asset.url, { mode: "cors" });
    if (!resp.ok) return null;
    return resp.blob();
  }
  const stored = await idbGet<{ frames: Blob[] }>(STORE_ASSET, asset.id);
  if (!stored?.frames?.length) return null;
  const idx = asset.kind === "SEQUENCE" ? Math.min(frame, stored.frames.length - 1) : 0;
  return stored.frames[idx] ?? null;
}

async function loadWhole(asset: AssetEntry, frame = 0): Promise<LoadedImage | null> {
  const key = asset.kind === "SEQUENCE" ? `${asset.id}#raw#${frame}` : `${asset.id}#raw`;
  const hit = wholeCache.get(key);
  if (hit) {
    touch(wholeCache, key, hit);
    return hit;
  }

  const blob = await assetRawBlob(asset, frame);
  if (!blob) return null;
  const img = await decodeBlob(blob);
  if (!img) return null;
  const out: LoadedImage = { bitmap: img.bitmap, width: img.width, height: img.height };
  wholeCache.set(key, out);
  while (wholeCache.size > MAX_WHOLE_CACHE) {
    const oldest = wholeCache.keys().next();
    if (oldest.done) break;
    dropEntry(wholeCache, oldest.value);
  }
  return out;
}

/**
 * 解码图片。
 *
 * 为什么需要兜底：示例工程用内联 SVG 做素材，Chrome 的 createImageBitmap
 * 对部分 SVG Blob 会直接抛错。退回 <img> + canvas 解码，浏览器支持什么就能用什么。
 */
async function decodeBlob(blob: Blob): Promise<LoadedImage | null> {
  try {
    const bmp = await createImageBitmap(blob);
    if (bmp.width > 0 && bmp.height > 0) {
      return { bitmap: bmp, width: bmp.width, height: bmp.height };
    }
  } catch {
    // 继续走 <img> 兜底
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error("图片解码失败"));
      node.src = url;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    if (!g) return null;
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, w, h);
    return { bitmap: c, width: w, height: h };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function invalidateAsset(assetId: string): void {
  // 必须先走 dropEntry（它会 close 位图），只 delete 键等于把位图内存留给浏览器慢慢收 —— 实测收不回来。
  for (const k of Array.from(imageCache.keys())) if (k.startsWith(assetId + "#")) dropEntry(imageCache, k);
  for (const k of Array.from(wholeCache.keys())) if (k.startsWith(assetId + "#")) dropEntry(wholeCache, k);
  for (const k of Array.from(missing)) if (k.startsWith(assetId + "#")) missing.delete(k);
}

/** 尝试加载每个素材的首帧，返回 { ok: AssetEntry[], missing: AssetEntry[] }。 */
export async function checkAssetHealth(assets: AssetEntry[]): Promise<{ ok: AssetEntry[]; missing: AssetEntry[] }> {
  const ok: AssetEntry[] = [];
    const missing: AssetEntry[] = [];
  for (const a of assets) {
    if (a.kind === "AUDIO") { ok.push(a); continue; }
    try {
      const frame = await loadFrame(a, 0);
      if (frame) ok.push(a);
      else missing.push(a);
    } catch {
      missing.push(a);
    }
  }
  return { ok, missing };
}

// ---------------- 导入 ----------------

export interface ImportResult {
  added: number;
  skipped: number;
  message?: string;
}

/**
 * 「正在导入中」的键表（跨调用共享）。
 *
 * 判重语句与真正写入之间有一串 await（IndexedDB 写入 + createImageBitmap），
 * 而 `project.assets.push` 在这串 await 的最后。两次**并发**的导入于是都会
 * 在看到 push 之前通过判重，各写一条同名素材 —— 这就是用户看到的
 * 「拖一次变三份、越拖越多」。这张表把那段窗口占住：先登记，结束（成功/失败）再释放。
 *
 * 用模块级 Set 而不是 project 上的字段：它是**运行期状态**，不该被序列化进 .bwproj；
 * 而且导入是编辑器的动作，与「哪个工程」无关（同名文件在不同工程里各自独立，
 * 但并发窗口只可能发生在同一次交互里）。
 */
const inFlightImport = new Set<string>();

/** 逐张导入：每张图一条素材。音频也能进。 */
export async function importFiles(project: Project, files: File[], group = "未分组"): Promise<ImportResult> {
  const res: ImportResult = { added: 0, skipped: 0 };
  for (const f of files) {
    const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);
    const isAudio = /\.(wav|ogg|mp3|m4a|aac)$/i.test(f.name);
    if (!isImage && !isAudio) {
      res.skipped++;
      continue;
    }
    /**
     * ⚠ 判重必须在**第一个 await 之前**做，并且同时占位。
     *
     * 这里是「同一个文件被导入 N 次」的真正机制：判重之后紧接着 `await idbPut(...)`，
     * 而 `project.assets.push` 在整个 await 链的最后。若两次导入**并发**执行
     * （一次 drop 被多个监听器/多条路径各处理一次，就是这种情况），
     * 它们都会在 push 发生之前通过判重 → 各写一条 → 库里出现 N 份同名素材。
     * 追加得越晚、并发越多，看起来就越像"指数级复制"。
     * 用一张「正在导入」的键表把这段窗口堵死：先占位、结束（无论成功失败）再释放。
     */
    const key = `${isAudio ? "AUDIO" : "IMAGE"}\u0000${f.name}`;
    if (project.assets.some((a) => a.path === f.name && a.kind === (isAudio ? "AUDIO" : "IMAGE")) || inFlightImport.has(key)) {
      res.skipped++;
      continue;
    }
    inFlightImport.add(key);
    try {
      const id = uid();
      await idbPut(STORE_ASSET, id, { frames: [f], name: f.name });
      let w = 0;
      let h = 0;
      if (isImage) {
        try {
          const bmp = await createImageBitmap(f);
          w = bmp.width;
          h = bmp.height;
        } catch {
          w = 0;
          h = 0;
        }
      }
      const entry: AssetEntry = {
        id,
        name: stripExt(f.name),
        kind: isAudio ? "AUDIO" : "IMAGE",
        src: "blob",
        path: f.name,
        width: w,
        height: h,
        group: group === "未分组" && (f as File & { webkitRelativePath?: string }).webkitRelativePath
          ? firstDir((f as File & { webkitRelativePath?: string }).webkitRelativePath as string) || "未分组"
          : group,
        hiddenFrames: [],
        frameDurations: []
      };
      project.assets.push(entry);
      res.added++;
    } finally {
      inFlightImport.delete(key);
    }
  }
  if (res.added === 0 && res.skipped > 0) res.message = "选中的文件已经在素材库里了";
  else if (res.added === 0) res.message = "这些文件里没有可用的图片或音频";
  return res;
}

/**
 * 序列帧导入。
 *
 * 核心逻辑：按「去掉结尾数字后的名字」分组，例如
 *   待机1.png 待机2.png 待机3.png → 一组「待机」，3 帧
 *   跑步1.png 跑步2.png           → 另一组「跑步」，2 帧
 * 一个文件夹里同时有多组是常态，必须分组而不是硬塞成一条。
 */
export async function importSequenceSet(project: Project, files: File[]): Promise<ImportResult> {
  const res: ImportResult = { added: 0, skipped: 0 };
  const groups = new Map<string, File[]>();
  for (const f of files) {
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(f.name)) {
      res.skipped++;
      continue;
    }
    const prefix = stripTrailingDigits(stripExt(f.name));
    const arr = groups.get(prefix) ?? [];
    arr.push(f);
    groups.set(prefix, arr);
  }
  if (!groups.size) {
    res.message = "这些文件里没有图片";
    return res;
  }

  for (const [prefix, arr] of groups) {
    arr.sort((a, b) => natCompare(a.name, b.name));
    const head = prefix || stripExt(arr[0].name);
    const folder = folderOf(arr[0]);
    /**
     * 判重要按「名字前缀 + 目录」而不是按 kind。
     *
     * 原来只查 `kind === "SEQUENCE"`，而下面 push 的是
     * `arr.length > 1 ? "SEQUENCE" : "IMAGE"` —— 于是**只拖一张图**时
     * 存进去的是 IMAGE，判重却只认 SEQUENCE，同一张图会被无限重复导入。
     * 现在两种 kind 都认，且单独拖图与成组拖图互不重复。
     *
     * ⚠ 同样要在 await 之前占位：并发处理同一次 drop 时会双双通过判重
     * （详见 importFiles 里的解释）。`inFlightImport` 用前缀 key 一起堵住。
     */
    const folderKey = folder || "序列帧";
    const key = `SEQ\u0000${head}\u0000${folderKey}`;
    const dup = project.assets.some(
      (a) =>
        (a.kind === "SEQUENCE" || a.kind === "IMAGE") &&
        a.headName === head &&
        a.path === folderKey
    );
    if (dup || inFlightImport.has(key)) {
      res.skipped++;
      continue;
    }
    inFlightImport.add(key);
    try {
      const id = uid();
      await idbPut(STORE_ASSET, id, { frames: arr, name: head });
      let w = 0;
      let h = 0;
      try {
        const bmp = await createImageBitmap(arr[0]);
        w = bmp.width;
        h = bmp.height;
      } catch {
        w = 0;
        h = 0;
      }
      project.assets.push({
        id,
        name: arr.length > 1 ? `${head}（${arr.length} 帧）` : head,
        kind: arr.length > 1 ? "SEQUENCE" : "IMAGE",
        src: "blob",
        path: folderKey,
        headName: head,
        frameCount: arr.length,
        width: w,
        height: h,
        group: folderKey,
        hiddenFrames: [],
        frameDurations: []
      });
      res.added++;
    } finally {
      inFlightImport.delete(key);
    }
  }
  return res;
}

/** 图集切片：一张大图按 cols × rows 切。 */
export async function importAtlas(
  project: Project,
  file: File,
  cols: number,
  rows: number,
  cellW: number,
  cellH: number
): Promise<ImportResult> {
  const res: ImportResult = { added: 0, skipped: 0 };
  const id = uid();
  await idbPut(STORE_ASSET, id, { frames: [file], name: file.name });
  let w = 0;
  let h = 0;
  try {
    const bmp = await createImageBitmap(file);
    w = bmp.width;
    h = bmp.height;
  } catch {
    w = 0;
    h = 0;
  }
  if (!cellW) cellW = Math.floor(w / Math.max(1, cols));
  if (!cellH) cellH = Math.floor(h / Math.max(1, rows));
  project.assets.push({
    id,
    name: stripExt(file.name),
    kind: "ATLAS",
    src: "blob",
    path: file.name,
    cols,
    rows,
    cellW,
    cellH,
    width: w,
    height: h,
    group: "图集",
    hiddenFrames: [],
    frameDurations: []
  });
  res.added = 1;
  return res;
}

/** URL 素材：直接引用网络图片，不进本地库。 */
export function importUrl(project: Project, url: string, name: string, group = "远程素材"): AssetEntry {
  const e: AssetEntry = {
    id: uid(),
    name: name || "远程素材",
    kind: "IMAGE",
    src: "url",
    url,
    path: url,
    width: 0,
    height: 0,
    group,
    hiddenFrames: [],
    frameDurations: []
  };
  project.assets.push(e);
  return e;
}

/**
 * 把一张**程序生成**的位图注册成普通 IMAGE 素材（光照贴图 / 缩略图 / 未来其它烘焙产物）。
 *
 * 为什么不复用一个 `importFiles(project, [new File([blob], ...)])`：
 *   那条路径按"文件名去重 + 按扩展名判定类型 + 从文件读尺寸"，烘焙产物没有文件名、
 *   同名重复烘焙会被它判成"已存在"直接跳过（于是第二次烘焙拿不到新素材 id，
 *   工程里却回写了一个指向旧图的 lightmap —— 用户看到的是"点了没反应"）。
 *
 * 存储格式与 `importFiles` **逐字一致**：`idbPut(STORE_ASSET, id, { frames: [blob], name })`
 * + `src:"blob"`。这是打包链路（`assetFilesForPack` → Build/assets）零改动就能
 * 把这张 PNG 拷进游戏的唯一前提；换成别的存法，导出的游戏里就没有光照贴图。
 *
 * @returns 新注册的素材条目（已 push 进 `project.assets`）。
 */
export async function addRasterAsset(
  project: Project,
  opts: { name: string; blob: Blob; width: number; height: number; group?: string }
): Promise<AssetEntry> {
  const id = uid();
  const name = String(opts.name || "图片").trim() || "图片";
  const w = Math.max(0, Math.round(Number(opts.width) || 0));
  const h = Math.max(0, Math.round(Number(opts.height) || 0));
  // 尺寸拿不到时退回浏览器实测：亮度贴图的 texW/texH 是运行时定位的关键值，
  // 这里少写一个 0 会让 lightmap 引用变成"宽高为 0 的贴图"，画面上完全看不到光。
  let width = w;
  let height = h;
  if ((!width || !height) && typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(opts.blob);
      width = bmp.width;
      height = bmp.height;
    } catch {
      /* 解不出来就让调用方给的值继续生效 */
    }
  }

  const entry: AssetEntry = {
    id,
    name,
    kind: "IMAGE",
    src: "blob",
    path: name,
    width,
    height,
    group: opts.group || "未分组",
    hiddenFrames: [],
    frameDurations: []
  };
  await idbPut(STORE_ASSET, id, { frames: [opts.blob], name });
  project.assets.push(entry);
  return entry;
}

// ---------------- 工程持久化 ----------------

export async function saveProjectBlob(project: Project): Promise<void> {
  await idbPut(STORE_PROJECT, "current", JSON.parse(JSON.stringify(project)));
}

/**
 * 读取上次的工程。
 *
 * 带超时：IndexedDB 在"上一个页面还开着""首次打开较慢"等情况下会长时间不回调，
 * 而启动流程在等它 —— 结果就是编辑器界面出来了、却什么都不能用。
 * 宁可先让用户看到一个空工程，也不能让启动卡在半路。
 */
export async function loadProjectBlob(timeoutMs = 4000): Promise<Project | null> {
  const read = idbGet<Project>(STORE_PROJECT, "current");
  const timeout = new Promise<undefined>((resolve) => window.setTimeout(() => resolve(undefined), timeoutMs));
  const p = await Promise.race([read, timeout]);
  return (p as Project | undefined) ?? null;
}

/** 清理不再被任何工程引用的素材二进制，避免本地库无限膨胀。 */
export async function gcAssets(project: Project): Promise<number> {
  const keep = new Set(project.assets.filter((a) => a.src === "blob").map((a) => a.id));
  const keys = await idbKeys(STORE_ASSET);
  let removed = 0;
  for (const k of keys) {
    if (!keep.has(k)) {
      await idbDel(STORE_ASSET, k);
      removed++;
    }
  }
  return removed;
}

export async function deleteAsset(project: Project, id: string): Promise<void> {
  const i = project.assets.findIndex((a) => a.id === id);
  if (i >= 0) project.assets.splice(i, 1);
  invalidateAsset(id);
  await idbDel(STORE_ASSET, id);
}

// ---------------- 小工具 ----------------

export function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

export function stripTrailingDigits(s: string): string {
  return s.replace(/[0-9]+$/, "");
}

function folderOf(f: File): string {
  const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (rel && rel.includes("/")) {
    const parts = rel.split("/");
    return parts.length >= 2 ? parts[parts.length - 2] : "";
  }
  return "";
}

function firstDir(rel: string): string {
  const parts = rel.split("/");
  return parts.length > 1 ? parts[0] : "";
}

/** 自然序比较：图2 排在 图10 前面。 */
export function natCompare(a: string, b: string): number {
  const ra = a.match(/(\d+|\D+)/g) ?? [];
  const rb = b.match(/(\d+|\D+)/g) ?? [];
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const x = ra[i] ?? "";
    const y = rb[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 素材类型的中文短标签（列表里用）。 */
export function assetKindShort(kind: AssetKind): string {
  switch (kind) {
    case "IMAGE": return "精灵";
    case "SEQUENCE": return "序列帧";
    case "ATLAS": return "图集";
    case "AUDIO": return "音频";
    default: return "素材";
  }
}

// ---------------- 打包用素材导出 ----------------

export interface PackAssetFile {
  name: string;
  blob: Blob;
}

export interface PackAssetResult {
  files: PackAssetFile[];
  error?: string;
}

async function imageToPng(img: LoadedImage): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, img.width);
  canvas.height = Math.max(1, img.height);
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.imageSmoothingEnabled = false;
  g.drawImage(img.bitmap as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });
}

function audioExtension(asset: AssetEntry, blob: Blob): string {
  const fromPath = asset.path && /\.[a-z0-9]+$/i.exec(asset.path)?.[0];
  if (fromPath) return fromPath.toLowerCase();
  const type = (blob.type || "").toLowerCase();
  if (type.includes("mpeg")) return ".mp3";
  if (type.includes("ogg")) return ".ogg";
  if (type.includes("wav")) return ".wav";
  return ".wav";
}

/**
 * 把一条素材转成 Java 运行时能直接读的文件。
 *
 * 关键点：SVG / WebP / GIF 都先画到 canvas 再导出 PNG。
 * 浏览器里看起来正常的图，不等于 Java ImageIO 能读；打包前统一栅格化最稳。
 */
export async function assetFilesForPack(asset: AssetEntry): Promise<PackAssetResult> {
  try {
    if (asset.kind === "AUDIO") {
      const blob = await assetRawBlob(asset, 0);
      if (!blob) return { files: [], error: "音频二进制读不到" };
      return { files: [{ name: "audio" + audioExtension(asset, blob), blob }] };
    }

    if (asset.kind === "ATLAS") {
      const whole = await loadWhole(asset, 0);
      if (!whole) return { files: [], error: "图集原图读不到" };
      const blob = await imageToPng(whole);
      return blob ? { files: [{ name: "main.png", blob }] } : { files: [], error: "图集转 PNG 失败" };
    }

    if (asset.kind === "SEQUENCE") {
      const count = totalFrames(asset);
      const files: PackAssetFile[] = [];
      for (let i = 0; i < count; i++) {
        const img = await loadFrame(asset, i);
        if (!img) continue;
        const blob = await imageToPng(img);
        if (blob) files.push({ name: `frame${i + 1}.png`, blob });
      }
      return files.length > 0
        ? { files }
        : { files: [], error: "序列帧一张都没读到" };
    }

    const img = await loadFrame(asset, 0);
    if (!img) return { files: [], error: "图片读不到（文件可能已丢失）" };
    const blob = await imageToPng(img);
    return blob ? { files: [{ name: "main.png", blob }] } : { files: [], error: "转 PNG 失败" };
  } catch (e) {
    return { files: [], error: e instanceof Error ? e.message : String(e) };
  }
}
