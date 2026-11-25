/**
 * bwe.save — 本地 JSON 存档。
 *
 * 语义对齐 ScriptSave.java / docs/api/draw-audio-save.md：
 *   - 内存是一棵 JSON 值树，set 不立刻落盘；
 *   - 只接受 JSON 值，函数忽略并只告警一次；
 *   - write/read 按槽位整体替换（read 失败时内存保持原样）；
 *   - flush() 就是 write("auto")，空槽位名也按 "auto"；
 *   - 槽位名里的 \ / : * ? " < > | 和空白替换成 _，自动补 .json。
 *
 * 落盘：浏览器写不了 <Build 父目录>/saves，所以用 localStorage，
 * 键名 bwe-save:<工程名>:<槽位>.json。没有 localStorage（node 单测、
 * 隐私模式）时退回进程内的槽位表，行为不变，只是关页面就没了。
 */

export interface SaveHost {
  /** 工程名，用来隔离不同游戏的槽位。 */
  project: string;
  warn(name: string, note: string): void;
}

const BAD = /[\\/:*?"<>|\s]/g;

export function slotFile(slot: unknown): string {
  const raw = slot === undefined || slot === null || String(slot).trim() === "" ? "auto" : String(slot);
  let name = raw.replace(BAD, "_");
  if (!name.toLowerCase().endsWith(".json")) name += ".json";
  return name;
}

/** 深拷贝成纯 JSON。函数、undefined、循环引用都拒绝（返回 undefined 表示拒绝）。 */
export function toJson(value: unknown, seen?: Set<object>): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") return Number.isFinite(value as number) ? value : null;
  if (t === "function" || t === "undefined" || t === "symbol" || t === "bigint") return undefined;
  if (t !== "object") return undefined;
  const bag = seen ?? new Set<object>();
  if (bag.has(value as object)) return undefined;
  bag.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => {
      const x = toJson(v, bag);
      return x === undefined ? null : x;
    });
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) {
    const x = toJson((value as Record<string, unknown>)[k], bag);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export interface SaveApi {
  set(k: unknown, v: unknown): void;
  get(k: unknown, def?: unknown): unknown;
  has(k: unknown): boolean;
  remove(k: unknown): void;
  clear(): void;
  flush(): boolean;
  write(slot?: unknown): boolean;
  read(slot?: unknown): boolean;
  exists(slot?: unknown): boolean;
  delete(slot?: unknown): void;
}

export function createSave(host: SaveHost, storage?: Storage | null): SaveApi {
  let tree: Record<string, unknown> = {};
  let warnedFn = false;

  const store = storage === undefined ? safeLocalStorage() : storage;
  const prefix = "bwe-save:" + slotFile(host.project || "game").replace(/\.json$/i, "") + ":";

  function keyOf(slot: unknown): string {
    return prefix + slotFile(slot);
  }

  function readRaw(slot: unknown): string | null {
    const k = keyOf(slot);
    if (store) {
      try { return store.getItem(k); } catch { return null; }
    }
    return memorySlots.get(k) ?? null;
  }

  function writeRaw(slot: unknown, text: string): boolean {
    const k = keyOf(slot);
    if (store) {
      try { store.setItem(k, text); return true; } catch { return false; }
    }
    memorySlots.set(k, text);
    return true;
  }

  return {
    set(k, v) {
      const key = String(k ?? "");
      if (!key) return;
      const json = toJson(v);
      if (json === undefined) {
        if (!warnedFn) {
          warnedFn = true;
          host.warn("save.set", "函数、undefined 和循环引用存不进去，只接受 JSON 值。");
        }
        return;
      }
      tree[key] = json;
    },
    get(k, def) {
      const key = String(k ?? "");
      if (!Object.prototype.hasOwnProperty.call(tree, key)) return def;
      return clone(tree[key]);
    },
    has(k) {
      return Object.prototype.hasOwnProperty.call(tree, String(k ?? ""));
    },
    remove(k) {
      delete tree[String(k ?? "")];
    },
    clear() {
      tree = {};
    },
    flush() {
      return this.write("auto");
    },
    write(slot) {
      try {
        return writeRaw(slot, JSON.stringify(tree, null, 2));
      } catch {
        return false;
      }
    },
    read(slot) {
      const text = readRaw(slot);
      if (text === null) return false;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return false; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      tree = clone(parsed as Record<string, unknown>);
      return true;
    },
    exists(slot) {
      return readRaw(slot) !== null;
    },
    delete(slot) {
      const k = keyOf(slot);
      if (store) {
        try { store.removeItem(k); } catch { /* 隐私模式写失败就当没有 */ }
      } else {
        memorySlots.delete(k);
      }
    },
  };
}

/** node 单测和没有 window 的环境共用一张表，浏览器里不会走到这里。 */
const memorySlots = new Map<string, string>();

function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__bwe_save_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}
