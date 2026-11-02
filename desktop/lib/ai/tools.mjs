/**
 * AI 层 · 三个工具（契约 §4.3 第 3 条，只做这三个）。
 *
 *   ReadFile(path, from?, lines?)   读仓库/工程里的文本文件（只读，绝不写）
 *   SceneDigest(options)            读工程结构摘要（不是整份 .bwproj）
 *   SearchApi(query, limit<=5)      按需查 BWE 脚本 API 文档
 *
 * 为什么不给更多工具：工具定义本身也吃 token，而且每加一个，前缀缓存的定义块就变一次。
 * 三个工具覆盖了「看文件 / 看工程 / 查 API」这三件模型真正需要的事。
 *
 * 安全：ReadFile 限定在 workspace 与 repo 两个根下，防 ../ 穿越；不读 node_modules。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";

/** OpenAI 兼容的工具定义（顺序固定 → 前缀稳定；不要为了美观重排）。 */
export function toolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "ReadFile",
        description:
          "读取工程或仓库里的一个文本文件（只读）。用于查看脚本完整源码、配置、文档。"
          + "不要用它读二进制（图片/字体）。一次最多返回 400 行（默认 400），用 from/lines 翻页。"
          + "⚠ 大文件请翻页读：一次读 400 行比反复重读整个文件更省 token，也更可能读到要改的那段。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "仓库或工程内的相对路径，例如 web/examples/city/scripts/player.js" },
            from: { type: "integer", description: "起始行（1 开始），默认 1" },
            lines: { type: "integer", description: "读取行数，默认 400，上限 400" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "ReadToolResult",
        description:
          "读取一次**已剪枝**工具结果里被省略的原文（按 sha1）。"
          + "某个工具结果末尾写着「已剪枝…可用 ReadToolResult 续读」时用本工具取回剩下部分；"
          + "不要用 ReadFile 去读 toolCache 路径，那条路走不通。",
        parameters: {
          type: "object",
          properties: {
            sha1: { type: "string", description: "结果末尾给出的 sha1（40 位十六进制，也接受前 8 位）" },
            from: { type: "integer", description: "起始行（1 开始），默认 1" },
            lines: { type: "integer", description: "读取行数，默认 400，上限 400" }
          },
          required: ["sha1"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "SceneDigest",
        description:
          "读取当前打开工程的压缩摘要：场景数、每个场景的对象分类计数、脚本清单、选中项、脚本错误。"
          + "不含素材二进制与全量 JSON。需要具体对象细节时用 ReadFile 读对应脚本。",
        parameters: {
          type: "object",
          properties: {
            scene: { type: "string", description: "只看某个场景（场景名），省略则全部" },
            maxScenes: { type: "integer", description: "最多列几个场景，默认 4" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "SearchApi",
        description:
          "在 BWE 脚本 API 文档（约 359 条）里搜索，返回最多 5 条 {签名, 说明}。"
          + "不确定某个 API 是否存在、名字怎么拼、参数是什么时，先查再写代码。"
          + "⚠ query 里**每个词都必须命中**（AND 语义），所以别把整句话塞进去："
          + "用 1~2 个短词（\"physics\" / \"collision\" / \"world findAll\"），查不到就换更短的词再查一次。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "关键词，1~2 个短词最佳，如 \"camera shake\" 或 \"world findAll\"" },
            limit: { type: "integer", description: "最多返回几条，默认 5，上限 5" }
          },
          required: ["query"]
        }
      }
    }
  ];
}

/** 工具名白名单：模型给出未定义的名字时直接拒掉，不要瞎执行。 */
export const TOOL_NAMES = ["ReadFile", "ReadToolResult", "SceneDigest", "SearchApi"];

const MAX_READ_LINES = 400;
const DEFAULT_READ_LINES = 400;
/** 不抓取的目录：依赖与构建产物没必要也不安全。 */
const DENY_DIRS = ["node_modules", ".git", "desktop/vendor", "desktop/dist", ".tmp_desk"];

/**
 * 创建工具执行器。
 *
 * @param {object} opts
 * @param {string} opts.repoRoot        仓库根
 * @param {string} [opts.workspaceRoot] 当前工作区（.bwproj 所在目录或工程文件路径）
 * @param {(options?:object)=>Promise<string>} [opts.sceneDigest]  由渲染侧提供的工程摘要生成器（主进程自己没有工程）
 * @param {{search:(q:string,n:number)=>Promise<any[]>, render:(q:string,n:number)=>Promise<string>}} opts.apiIndex
 * @param {{get:(s:string)=>Promise<string|null>, list?:()=>Promise<string[]>}} [opts.toolCache]
 *        剪枝原文的磁盘缓存（可选）。
 * @param {(sha:string)=>Promise<string|null>} [opts.resolvePruned]
 *        剪枝原文的**内存**来源（优先于 toolCache；保证 ReadToolResult 在不配缓存时也可用）。
 * @param {(sha:string, raw:string)=>void} [opts.onPruned]
 *        每次剪枝时把原文登记进内存（bridge 注入，用于实现 resolvePruned）。
 */
export function createToolRunner(opts) {
  /**
   * 本次请求可用的工程摘要（字符串，或生成器函数）。
   *
   * 由 bridge 在每次 run() 开头通过 setSceneDigest 注入。
   * 为什么不用构造时的 opts.sceneDigest：bridge 只创建一次 toolRunner，
   * 构造时闭包的值在"工程切换/每次请求摘要不同"的场景下就是错的
   *（历史缺陷：app-main 从未传该选项，SceneDigest 每次必抛错，
   *  模型连续重试耗尽轮次，最终静默结束 —— 用户看到"AI 说半句就消失"）。
   */
  let currentSceneDigest = null;
  const repoRoot = resolve(opts.repoRoot);
  const workspaceRoot = opts.workspaceRoot ? resolve(opts.workspaceRoot) : null;

  /**
   * 本进程内的 ReadFile 阅读游标：文件绝对路径 → 已经读过的最远行号。
   *
   * 为什么需要（实测 20:04 那轮对话）：模型连续发出 **6 次** `ReadFile({"path": ".../world.js"})`，
   * args 里**根本没有 from**；它嘴上说「翻页参数被忽略了，一直返回前 400 行」，
   * 实际是它自己没传 —— 工具每次都老实从头读，于是永远看到同一段。
   * 这是纯粹的浪费：6 次调用、每次 400 行，全是同一批字节。
   *
   * 修法不是"限制它少调用"（用户明确说不要限制），而是让工具**默认接着往下读**：
   *   · 没给 `from` 且这个文件已经读过 → 从上次结束处继续；
   *   · 结果里明确告诉它「本次读的是第 X-Y 行，剩下还有 Z 行」。
   * 这样即使模型忘了 from，"读文件"这个动作也不会原地打转。
   * 给了 `from` 时完全尊重参数（不猜、不擅自改变语义）。
   */
  const readCursor = new Map();

  function insideRoot(candidate) {
    const roots = [repoRoot, workspaceRoot].filter(Boolean);
    return roots.some((root) => {
      const rel = relative(root, candidate);
      return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
    });
  }

  async function readFileTool(args) {
    const rel = String(args?.path ?? "").trim();
    if (!rel) throw new Error("ReadFile 缺少 path");
    if (DENY_DIRS.some((d) => rel.replace(/\\/g, "/").startsWith(d))) {
      throw new Error(`ReadFile 不允许读取 ${rel}（依赖/构建/vendor 目录不在可读范围）`);
    }
    // 先按「仓库相对路径」找，再按「工作区相对路径」找。
    const candidates = [resolve(repoRoot, rel)];
    if (workspaceRoot) candidates.push(resolve(workspaceRoot, rel));
    const target = candidates.find((p) => insideRoot(p)) ?? candidates[0];
    if (!insideRoot(target)) throw new Error(`ReadFile 路径越界：${rel}`);

    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw new Error(`ReadFile 找不到文件：${rel}`);
    const ext = extname(target).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".ttf", ".otf", ".woff", ".woff2", ".zip", ".jar"].includes(ext)) {
      throw new Error(`ReadFile 只读文本文件，${rel} 是二进制（${ext}）。看图片请让用户自己打开。`);
    }
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Number(args?.lines) || DEFAULT_READ_LINES));
    /**
     * 是否**显式**给了 from。
     * ⚠ 判 "undefined/null/空串" 都算没给 —— 模型经常传 from: null 或 from: ""。
     */
    const wantsFrom =
      args?.from !== undefined && args?.from !== null && String(args.from).trim() !== "";

    // ---- 没给 from 时接着上次读到的地方继续（见 readCursor 注释）----
    // 只对「同一文件 + 之前读过」生效；给了 from 一律以参数为准，不擅自改语义。
    const prevCursor = readCursor.get(target) ?? null;
    let from = 1;
    let autoContinued = false;
    if (wantsFrom) {
      from = Math.max(1, Math.floor(Number(args.from)) || 1);
    } else if (prevCursor && Number.isFinite(prevCursor.next) && prevCursor.next > 1) {
      from = prevCursor.next;
      autoContinued = true;
    }

    const text = await readFile(target, "utf8");
    const all = text.split(/\r?\n/);

    // from 超过末尾：说明已经读完了，别返回空片段让模型以为"文件没了/读取坏了"。
    if (from > all.length) {
      readCursor.set(target, { next: 1, total: all.length });
      return {
        text:
          `ReadFile(${rel}) 已经读完了：全文共 ${all.length} 行，你请求的 from=${from} 超出末尾。\n`
          + `（已重置：下次不带 from 读本文件会从头开始；要读中间某段请显式给 from。）`,
        meta: { file: rel, from: 1, lines: 0, totalLines: all.length, eof: true }
      };
    }

    const endLine = Math.min(all.length, from - 1 + limit);
    const slice = all.slice(from - 1, endLine).join("\n");
    readCursor.set(target, { next: endLine + 1, total: all.length });

    const header = `ReadFile(${rel}) 第 ${from}-${endLine} 行 / 共 ${all.length} 行`;
    const autoNote = autoContinued
      ? `\n（本次没给 from，已自动从第 ${from} 行继续读；接着往下读本文件不必再传参数）`
      : "";
    const tail = endLine < all.length
      ? `\n…（还有 ${all.length - endLine} 行。**下次不带 from 会自动从这里接着读**，也可显式给 from=${endLine + 1}）`
      : "\n（已读到文件末尾）";
    return {
      text: `${header}${autoNote}\n${slice}${tail}`,
      meta: { file: rel, from, lines: endLine - from + 1, totalLines: all.length, autoContinued }
    };
  }

  async function sceneDigestTool(args) {
    // ⚠ 数据源是"**本次请求**携带的工程摘要"，不是构造时的闭包。
    // 渲染侧每次都把当前工程摘要放在 request.context.sceneDigest 里，
    // 工具要读的必须是同一份数据 —— 否则模型在 prompt 里"看得到"工程，工具却读不到
    //（历史缺陷：app-main 没传 opts.sceneDigest，工具每次必抛错）。
    const digest = currentSceneDigest ?? opts.sceneDigest;
    if (typeof digest === "function") {
      const text = await digest({ scene: args?.scene, maxScenes: args?.maxScenes });
      return { text: String(text ?? ""), meta: { kind: "scene-digest" } };
    }
    if (typeof digest === "string" && digest.trim()) {
      return { text: digest, meta: { kind: "scene-digest", source: "context" } };
    }
    throw new Error(
      "没有可用的工程摘要：本次请求既没带 context.sceneDigest，也没有可调用的摘要生成器。"
      + "请在编辑器里打开工程后重试。"
    );
  }

  async function searchApiTool(args) {
    const query = String(args?.query ?? "").trim();
    if (!query) throw new Error("SearchApi 缺少 query");
    const limit = Math.min(5, Math.max(1, Number(args?.limit) || 5));
    const text = await opts.apiIndex.render(query, limit);
    return { text, meta: { query, limit } };
  }

  /**
   * 续读一次被剪枝的工具结果。
   *
   * 为什么必须有：剪枝把大结果压成「头部 + 统计」，但模型**没有别的办法**拿到被省略的部分 ——
   * 统计行原来写的是主进程本地路径，模型只能去 `ReadFile` 那条路径然后失败。
   * 实测后果：连续两次失败后被止损逻辑判成「工具不可用」，整轮对话就此结束，一句正文都没有。
   *
   * 数据源是 toolCache（内容寻址），所以不需要保存「这次请求的上下文」——sha1 就是句柄。
   */
  async function readToolResultTool(args) {
    const sha = String(args?.sha1 ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{8,40}$/.test(sha)) {
      throw new Error("ReadToolResult 需要 sha1（结果末尾给出的 40 位十六进制，可只给前 8 位）");
    }
    // ---- 取原文：内存优先 → toolCache ----
    //
    // ⚠ 两条通路都要支持**前缀**（工具定义承诺「也接受前 8 位」，剪枝摘要里也只显示 8 位）。
    //   实测踩过两次：① bridge 从没把 toolCache 传给工具 → 工具答「没配置」；
    //   ② 内存通路修好后只支持完整 40 位 → 给 8 位就查不到。两次都是"承诺了某种能力、
    //   某条配置下不支持"，而模型正是照着剪枝摘要的 8 位 sha 来调用的。
    let raw = null;
    if (typeof opts.resolvePruned === "function") {
      raw = await Promise.resolve(opts.resolvePruned(sha)).catch(() => null);
    }
    if (raw === null || raw === undefined) {
      // toolCache 分支自带前缀补全（list + startsWith）；内存通路的补全由注入方实现。
      if (opts.toolCache && typeof opts.toolCache.get === "function") {
        raw = await opts.toolCache.get(sha);
        if ((raw === null || raw === undefined) && sha.length < 40 && typeof opts.toolCache.list === "function") {
          const matches = (await opts.toolCache.list()).filter((n) => n.startsWith(sha));
          if (matches.length === 1) raw = await opts.toolCache.get(matches[0]);
          else if (matches.length > 1) throw new Error(`sha1 前缀「${sha}」命中 ${matches.length} 条，请给完整 sha1`);
        }
      }
    }
    if (raw === null || raw === undefined) {
      throw new Error(
        `ReadToolResult 找不到 sha1「${sha}」对应的结果（缓存可能已过期）。`
        + "改用原文件 ReadFile(from/lines) 翻页读取，不要反复重试本工具。"
      );
    }
    const lines = String(raw).split(/\r?\n/);
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Number(args?.lines) || DEFAULT_READ_LINES));
    const from = Math.max(1, Number(args?.from) || 1);
    const slice = lines.slice(from - 1, from - 1 + limit).join("\n");
    const end = Math.min(lines.length, from - 1 + limit);
    const footer = end >= lines.length ? "" : `\n…（还有 ${lines.length - end} 行，用 from=${from + limit} 继续）`;
    return {
      text: `ReadToolResult(${sha.slice(0, 8)}…) 第 ${from}-${end} 行 / 共 ${lines.length} 行\n${slice}${footer}`,
      meta: { sha1: sha, from, lines: limit, totalLines: lines.length }
    };
  }

  return {
    definitions: toolDefinitions(),
    /**
     * 注入本次请求的工程摘要（bridge 在 run() 开头调用）。
     * 传 null 表示"本次请求没有工程摘要"。
     */
    setSceneDigest(value) {
      currentSceneDigest = value ?? null;
    },
    /** 执行一个工具调用；名字不认识或参数坏掉都返回可读错误而不是抛给上层。 */
    async run(call) {
      const name = String(call?.name ?? "");
      const args = call?.arguments ?? {};
      try {
        if (name === "ReadFile") return await readFileTool(args);
        if (name === "ReadToolResult") return await readToolResultTool(args);
        if (name === "SceneDigest") return await sceneDigestTool(args);
        if (name === "SearchApi") return await searchApiTool(args);
        throw new Error(`未知工具「${name}」（可用：${TOOL_NAMES.join(" / ")}）`);
      } catch (e) {
        return { error: e?.message || String(e), text: `工具 ${name} 执行失败：${e?.message || e}`, meta: { tool: name } };
      }
    },
    /** 供 tool 事件里显示的简短参数。 */
    describeArg(call) {
      const args = call?.arguments ?? {};
      if (call?.name === "ReadFile") return String(args.path ?? "");
      if (call?.name === "ReadToolResult") return `sha1=${String(args.sha1 ?? "").slice(0, 8)}… from=${args.from ?? 1}`;
      if (call?.name === "SearchApi") return String(args.query ?? "");
      if (call?.name === "SceneDigest") return String(args.scene ?? "全部场景");
      return "";
    }
  };
}

/** 目录列举（给工具之外的内部用途，如「最近工程」校验路径是否还存在）。 */
export async function listDirFiles(dir, filter = () => true) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && filter(e.name)).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** 归一化路径用于比较（Windows 大小写不敏感）。 */
export function normalizePathForCompare(p) {
  return normalize(String(p)).replace(/\\/g, "/").toLowerCase();
}
