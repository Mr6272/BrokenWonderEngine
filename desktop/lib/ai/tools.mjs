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

/** OpenAI 兼容的工具定义（只有这三个，顺序固定 → 前缀稳定）。 */
export function toolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "ReadFile",
        description:
          "读取工程或仓库里的一个文本文件（只读）。用于查看脚本完整源码、配置、文档。"
          + "不要用它读二进制（图片/字体）。一次最多返回 200 行，可用 from/lines 翻页。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "仓库或工程内的相对路径，例如 web/examples/city/scripts/player.js" },
            from: { type: "integer", description: "起始行（1 开始），默认 1" },
            lines: { type: "integer", description: "读取行数，默认 200，上限 400" }
          },
          required: ["path"]
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
          "在 BWE 脚本 API 文档（约 271 条）里按关键词搜索，返回最多 5 条 {签名, 说明}。"
          + "不确定某个 API 是否存在、名字怎么拼、参数是什么时，先查再写代码。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "关键词，可用空格分隔多个词，如 \"camera shake\" 或 \"world find\"" },
            limit: { type: "integer", description: "最多返回几条，默认 5，上限 5" }
          },
          required: ["query"]
        }
      }
    }
  ];
}

/** 工具名白名单：模型给出未定义的名字时直接拒掉，不要瞎执行。 */
export const TOOL_NAMES = ["ReadFile", "SceneDigest", "SearchApi"];

const MAX_READ_LINES = 400;
const DEFAULT_READ_LINES = 200;
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
    const from = Math.max(1, Number(args?.from) || 1);
    const text = await readFile(target, "utf8");
    const all = text.split(/\r?\n/);
    const slice = all.slice(from - 1, from - 1 + limit).join("\n");
    const header = `ReadFile(${rel}) 第 ${from}-${Math.min(all.length, from - 1 + limit)} 行 / 共 ${all.length} 行`;
    const footer = from - 1 + limit >= all.length ? "" : `\n…（还有 ${all.length - (from - 1 + limit)} 行，用 from=${from + limit} 继续）`;
    return { text: `${header}\n${slice}${footer}`, meta: { file: rel, from, lines: limit, totalLines: all.length } };
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
