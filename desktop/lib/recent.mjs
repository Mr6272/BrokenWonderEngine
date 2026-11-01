/**
 * 桌面壳 · 最近打开的工程（recent.json）。
 *
 * 只是「最近用过的路径」列表，不做真实存在性缓存：每次读取都 stat 一下，
 * 磁盘上已经不存在的条目直接从列表里剔掉 —— 否则菜单里会出现一堆点了没反应的死链。
 */

import { readFile, rename, stat, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

const MAX_RECENT = 12;

async function readJson(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

export function createRecentStore({ file }) {
  let items = null;

  async function ensure() {
    if (!items) items = await readJson(file);
    return items;
  }

  async function persist(list) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ items: list }, null, 2), "utf8");
    await rename(tmp, file);
  }

  return {
    file,

    /** 列表（已剔除磁盘上不存在的路径，按最近使用排序）。 */
    async list({ verify = true } = {}) {
      const raw = await ensure();
      const out = [];
      for (const it of raw) {
        const path = String(it?.path ?? "");
        if (!path) continue;
        if (verify) {
          const ok = await stat(path).then((s) => s.isFile()).catch(() => false);
          if (!ok) continue;
        }
        out.push({ path, name: String(it?.name ?? basename(path)), at: Number(it?.at) || 0 });
      }
      return out.slice(0, MAX_RECENT);
    },

    /** 记一次打开/保存（同一路径只保留最新一条）。 */
    async touch(path, name) {
      const now = Date.now();
      const current = await ensure();
      const next = current.filter((it) => String(it?.path ?? "") !== path);
      next.unshift({ path, name: name || basename(path), at: now });
      items = next.slice(0, MAX_RECENT);
      await persist(items).catch(() => {});
      return items;
    },

    async remove(path) {
      const current = await ensure();
      items = current.filter((it) => String(it?.path ?? "") !== path);
      await persist(items).catch(() => {});
      return items;
    }
  };
}
