/**
 * AI 层 · 工具结果剪枝 + 本地缓存。
 *
 * 契约 §4.3 第 4 条：**超大**工具结果入库前要被压成「头部 + 统计」；
 * 原文按 sha1 落到 `toolCache/<sha1>.txt`，模型可用 `ReadToolResult` 工具按需续读。
 *
 * ⚠ 历史缺陷（用户实测「Kimi 跑两下就寄 / 什么都没交付」的成因之一）：
 * 上限原来是 **600 字符、头部只留 480**，而 `ReadFile` 默认一次返回 **200 行**。
 * 于是「读 200 行代码」在模型眼里只剩头 ~15 行 —— 它永远看不到要改的那段，
 * 只能反复读同一个文件、耗尽工具轮次、最后一句正文都没产出。
 *
 * 另一个隐蔽缺陷：统计行写的是「全文在 toolCache/<sha>.txt」——
 * 那是**主进程本地路径**，模型既没有工具能读它，也没有权限感知；
 * 实测模型真的去 `ReadFile("toolCache/xxx.txt")`、连续失败、被止损判成「工具不可用」。
 * 提示里给一个不存在的取用方式，比不给提示更糟。
 *
 * 纯 Node 标准库，无 Electron 依赖，可单测。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 超过这个字符数的工具结果入对话前要剪枝。
 *
 * 取值依据必须算上「**一次 ReadFile 的输出上限**」：默认一次读 400 行，
 * 密集代码（每行 ~35 字符）就是 14K 字符。**上限必须大于它**，否则
 * 「读一次文件」这个最基本的动作都会被削 —— 模型永远看不到要改的那段代码。
 *
 * 24000 字符 ≈ 7K token ≈ 600~800 行普通代码。这个量对一次"读脚本"的调用是合理的，
 * 且仍能挡住「把整份 JSON / 整个目录 dump 进上下文」这类真正该拦的结果。
 */
export const PRUNE_LIMIT = 24000;
/** 剪枝后保留的头部字符数（在 24K 内留出统计行余量）。 */
const HEAD_CHARS = 23700;

export function sha1(text) {
  return createHash("sha1").update(String(text), "utf8").digest("hex");
}

/**
 * 把工具结果的「原始文本」剪成「头部 + 统计」。
 *
 * 统计要能回答「是不是被截断了、截了多少、**怎么继续读**」，
 * 所以必须带上总字符数、行数与 toolCache 键。
 *
 * @param {string} text
 * @param {object} [options]
 * @param {object} [options.meta]  额外统计（例如 {matches: 3}），会被写进摘要
 * @returns {{text:string, pruned:boolean, fullSha1:string, originalChars:number, originalLines:number}}
 */
export function pruneToolResult(text, options = {}) {
  const raw = String(text ?? "");
  const sha = sha1(raw);
  const lines = raw.split(/\r?\n/).length;
  const meta = options.meta ?? {};
  if (raw.length <= PRUNE_LIMIT) {
    return { text: raw, pruned: false, fullSha1: sha, originalChars: raw.length, originalLines: lines, meta };
  }

  const head = raw.slice(0, HEAD_CHARS).replace(/\r\n/g, "\n");
  // 头部最后一行的完整性：避免把一行代码切成一半，读起来像语法错误。
  const cut = head.lastIndexOf("\n");
  const safeHead = cut > HEAD_CHARS * 0.6 ? head.slice(0, cut) : head;
  const restLines = lines - safeHead.split("\n").length;
  const stats = [
    `\n…（已剪枝：原文 ${raw.length} 字符 / ${lines} 行，`,
    `此处省略约 ${Math.max(0, raw.length - safeHead.length)} 字符 / ${Math.max(0, restLines)} 行。`,
    `要看被省略的部分，调用 ReadToolResult(sha1="${sha}", from=<行号>, lines=<行数>)；`,
    `或直接对原文件用 ReadFile(from/lines) 翻页。不要用 ReadFile 读 toolCache 路径，那条路走不通。）\n`
  ].join("");
  const metaLine = Object.keys(meta).length
    ? `\n[统计] ${Object.entries(meta)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(" · ")}`
    : "";
  return {
    text: `${safeHead}${stats}${metaLine}`,
    pruned: true,
    fullSha1: sha,
    originalChars: raw.length,
    originalLines: lines,
    meta
  };
}

/**
 * 工具结果缓存：内容寻址（sha1 → 文件），同一结果只落盘一次。
 *
 * 目录由调用方给（桌面版是 %APPDATA%\BWE Studio\toolCache）。
 * 读失败一律返回 null，不抛异常：缓存是优化，不能变成故障源。
 */
export function createToolCache(dir) {
  const root = dir;
  return {
    root,
    /** 存原始结果，返回 sha1（内容相同则复用已有文件）。 */
    async put(text, meta = null) {
      const raw = String(text ?? "");
      const sha = sha1(raw);
      await mkdir(root, { recursive: true });
      const file = join(root, `${sha}.txt`);
      if (!existsSync(file)) {
        await writeFile(file, raw, "utf8");
      }
      if (meta) {
        // meta 另存一份，便于排查「这条缓存是哪次调用产生的」。
        const metaFile = join(root, `${sha}.json`);
        if (!existsSync(metaFile)) await writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8");
      }
      return sha;
    },
    /** 按 sha1 取原文；不存在返回 null。 */
    async get(sha) {
      try {
        const name = String(sha ?? "");
        // 允许只传短路 sha（界面上常只显示 8 位），但要能命中完整文件。
        if (/\.txt$/.test(name)) return await readFile(join(root, name), "utf8");
        return await readFile(join(root, `${name}.txt`), "utf8");
      } catch {
        return null;
      }
    },
    async has(sha) {
      const name = String(sha ?? "");
      return existsSync(join(root, /\.txt$/.test(name) ? name : `${name}.txt`));
    },
    /**
     * 列出已缓存结果的 sha1（不含 .json 元数据文件）。
     *
     * 用途：`ReadToolResult` 允许给 8 位前缀，需要在前缀唯一时补全成完整 sha1。
     * 目录不存在时返回空数组（缓存是优化，不能变成故障源）。
     */
    async list() {
      try {
        const entries = await readdir(root);
        return entries.filter((n) => n.endsWith(".txt")).map((n) => n.slice(0, -4));
      } catch {
        return [];
      }
    },
    path(sha) {
      const name = String(sha ?? "");
      return join(root, /\.txt$/.test(name) ? name : `${name}.txt`);
    }
  };
}

/**
 * 生成工具结果的可读摘要（给 SSE 的 `tool` 事件里的 detail 用）。
 * 例如 ReadFile("world.js") → "ReadFile world.js · 312 行 / 9.8K 字符（已剪枝）"
 */
export function describeToolResult(name, arg, prune, cached = false) {
  const sizeLabel = prune.originalChars > 1024
    ? `${(prune.originalChars / 1024).toFixed(1)}K 字符`
    : `${prune.originalChars} 字符`;
  const bits = [`${name} ${arg ? String(arg).slice(0, 80) : ""}`.trim(), `${prune.originalLines} 行 / ${sizeLabel}`];
  if (prune.pruned) bits.push(`已剪枝（可用 ReadToolResult 续读 sha1 ${prune.fullSha1.slice(0, 8)}…）`);
  if (cached) bits.push("命中本地缓存（零成本复用）");
  return bits.join(" · ");
}
