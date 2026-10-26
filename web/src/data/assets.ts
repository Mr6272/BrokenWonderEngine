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

export async function loadFrame(asset: AssetEntry | undefined, frame: number): Promise<LoadedImage | null> {
  if (!asset) return null;
  const key = frameKey(asset.id, frame);
  const hit = imageCache.get(key);
  if (hit) return hit;
  if (missing.has(key)) return null;

  try {
    const img = await loadRaw(asset, frame);
    if (!img) {
      missing.add(key);
      return null;
    }
    imageCache.set(key, img);
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
  if (hit) return hit;

  const blob = await assetRawBlob(asset, frame);
  if (!blob) return null;
  const img = await decodeBlob(blob);
  if (!img) return null;
  const out: LoadedImage = { bitmap: img.bitmap, width: img.width, height: img.height };
  wholeCache.set(key, out);
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
  for (const k of Array.from(imageCache.keys())) if (k.startsWith(assetId + "#")) imageCache.delete(k);
  for (const k of Array.from(wholeCache.keys())) if (k.startsWith(assetId + "#")) wholeCache.delete(k);
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
    const dup = project.assets.find((a) => a.path === f.name && a.kind === (isAudio ? "AUDIO" : "IMAGE"));
    if (dup) {
      res.skipped++;
      continue;
    }
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
    const dup = project.assets.find((a) => a.kind === "SEQUENCE" && a.headName === head && a.path === folder);
    if (dup) {
      res.skipped++;
      continue;
    }
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
      path: folder || "序列帧",
      headName: head,
      frameCount: arr.length,
      width: w,
      height: h,
      group: folder || "序列帧",
      hiddenFrames: [],
      frameDurations: []
    });
    res.added++;
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
