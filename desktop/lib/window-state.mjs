/**
 * 桌面壳 · 窗口状态（尺寸/位置）记忆。
 *
 * 契约要求记住到 `%APPDATA%\BWE Studio\window.json`。
 * 三个细节决定「记住尺寸」是否真的不烦人：
 *   1. 只在窗口既非最大化也非全屏时记 bounds —— 否则下次启动永远开在最大化，
 *      用户调小窗口的努力白费；
 *   2. 还原前做可见性校验：外接屏拔掉后，旧坐标可能落在不存在的显示器上，
 *      直接套用会得到一个「窗口在屏幕外」的幽灵应用；
 *   3. 写盘失败不能让启动失败（只读 APPDATA / 磁盘满都属于这类）。
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_BOUNDS = { width: 1480, height: 960 };
export const MIN_BOUNDS = { width: 1100, height: 700 };

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** 判断 saved bounds 是否至少与某块屏幕有可见交集（避免窗口跑到不存在的显示器上）。 */
export function isVisibleOn(screen, bounds) {
  if (!bounds || typeof bounds.x !== "number" || typeof bounds.y !== "number") return true; // 只有尺寸，交给系统摆放
  const displays = screen.getAllDisplays();
  const MIN_VISIBLE = 120;
  return displays.some((d) => {
    const wa = d.workArea;
    const overlapX = Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x);
    const overlapY = Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
}

/**
 * @param {object} opts
 * @param {string} opts.file               window.json 路径
 */
export function createWindowState({ file }) {
  return {
    file,

    async load(screen) {
      const saved = await readJson(file);
      const width = Math.max(MIN_BOUNDS.width, Number(saved?.width) || DEFAULT_BOUNDS.width);
      const height = Math.max(MIN_BOUNDS.height, Number(saved?.height) || DEFAULT_BOUNDS.height);
      const out = { width, height, maximized: Boolean(saved?.maximized) };
      if (typeof saved?.x === "number" && typeof saved?.y === "number") {
        const candidate = { x: saved.x, y: saved.y, width, height };
        if (isVisibleOn(screen, candidate)) {
          out.x = saved.x;
          out.y = saved.y;
        }
      }
      return out;
    },

    /** 保存当前窗口状态：最大化时保留旧的 bounds（见文件头注释）。 */
    async save(window, boundsOverride) {
      try {
        const maximized = window.isMaximized() || window.isFullScreen();
        const bounds = boundsOverride ?? (maximized ? null : window.getBounds());
        const prev = (await readJson(file)) ?? {};
        const next = {
          ...prev,
          ...(bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : {}),
          maximized,
          updatedAt: new Date().toISOString()
        };
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
        await rename(tmp, file);
        return true;
      } catch {
        // 记不住尺寸不该影响使用。
        return false;
      }
    }
  };
}
