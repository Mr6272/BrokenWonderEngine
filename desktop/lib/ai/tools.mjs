/**
 * AI 层 · 工具集。
 *
 * 只读类（看文件 / 看工程 / 查 API）：
 *   ReadFile(path, from?, lines?)   读仓库/工程里的文本文件（只读，绝不写）
 *   ReadToolResult(sha1, from?, lines?)  续读被剪枝的结果
 *   SceneDigest(options)            读工程结构摘要（不是整份 .bwproj）
 *   SearchApi(query, limit<=5)      按需查 BWE 脚本 API 文档
 *
 * 脚本写类（**工程内脚本**的完整读写权限，见文件末尾的边界说明）：
 *   ListScripts()                   列出工程里的脚本（名字/语言/行数）
 *   ReadScript(name)                读一个脚本的完整源码
 *   WriteScript(name, source, ...)  整篇写入（新建或覆盖）
 *   PatchScript(name, find, replace) 精确替换一处片段（改几行时用它）
 *   DeleteScript(name, force?)      删除脚本（有引用时默认拒绝）
 *
 * 为什么不给更多工具：工具定义本身也吃 token，而且每加一个，前缀缓存的定义块就变一次。
 * 「看文件 / 看工程 / 查 API / 读写脚本」覆盖了模型真正需要的事。
 *
 * 安全边界（写类工具，三条，全部有单测）：
 *   1. **只碰工程脚本**：写目标是 `Project.scripts` 的 key，不接受文件路径。
 *      AI 不能写 .java / .ts / .bwproj / 任意磁盘文件 —— 那会绕过编辑器直接改坏引擎或数据。
 *   2. **写回走渲染侧权威副本**：工程的真身在渲染进程内存里，主进程只转发。
 *      直接改磁盘会让编辑器内存与文件分叉（AI 说改好了、界面没变、下次保存又覆盖回去）。
 *   3. **可撤销**：渲染侧落到 `applyAiScript`，它自带 markDirty + commit 快照，
 *      用户一条 Ctrl+Z 就能撤回 AI 的改动。
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
    },
    // ------------------------------------------------------------------
    // 脚本写类：工程内脚本的完整读写权限（边界见文件顶部注释）
    // ------------------------------------------------------------------
    {
      type: "function",
      function: {
        name: "ListScripts",
        description:
          "列出当前工程里的所有脚本（名字 / 语言 js|yarn / 行数 / 导出路径）。"
          + "改脚本前先看这个，确认脚本叫什么名字、有没有你要改的那个。",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: "ReadScript",
        description:
          "读一个工程脚本的**完整源码**（不是切片）。知道脚本名后用它看真实内容再决定怎么改。"
          + "⚠ 改之前**一定先读**：缩进、行尾、注释都可能是你记忆里没有的样子，照抄一段原文再改。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "脚本名（ListScripts 里的名字），例如 \"player\" 或 \"扫雷\"" }
          },
          required: ["name"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "WriteScript",
        description:
          "**整篇**写入一个工程脚本（新建或覆盖）。会立刻落到编辑器里，用户 Ctrl+Z 可撤销。"
          + "⚠ 改已有脚本的几行时优先用 PatchScript，不要整篇重写 —— 整篇重写容易漏掉原有逻辑。"
          + "create=true 只允许新建（已存在则报错）；create=false 只允许覆盖；不带则两者皆可。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "脚本名（可含中文；不能有 / 或 \\）" },
            source: { type: "string", description: "完整源码（整篇，不是片段）" },
            lang: { type: "string", description: "新建时的语言：js（默认）或 yarn" },
            create: { type: "boolean", description: "true=只新建；false=只覆盖；省略=两者皆可" }
          },
          required: ["name", "source"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "PatchScript",
        description:
          "在工程脚本里**精确替换一处**片段（find → replace）。改一两行时用它，比整篇重写安全得多。"
          + "find 必须在文件里**只出现一次**：命中多处会直接报错，请连带上下文（上一行缩进/函数名）再试。"
          + "命中 0 处也会报错（不会猜）—— 这时先用 ReadScript 看真实内容。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "脚本名" },
            find: { type: "string", description: "要被替换的**原文片段**（含足够上下文，确保只命中一处）" },
            replace: { type: "string", description: "替换成的新片段" }
          },
          required: ["name", "find", "replace"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "DeleteScript",
        description:
          "删除一个工程脚本。**被场景或对象引用时会拒绝**（删掉会让运行期找不到脚本，而且编辑器里看不出来）。"
          + "遇到 in-use 时，先把引用清空/改指向，或者先向用户确认再带 force=true。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "脚本名" },
            force: { type: "boolean", description: "true=即使仍被引用也删（必须先向用户确认）" }
          },
          required: ["name"]
        }
      }
    },
    // ------------------------------------------------------------------
    // 知识库（只读**当前工程**的历史经验，不跨项目）
    // ------------------------------------------------------------------
    {
      type: "function",
      function: {
        name: "SearchKnowledge",
        description:
          "在当前工程的**历史经验**里检索（每次 AI 执行完都会自动沉淀，只属于这个工程）。"
          + "遇到「这个项目以前踩过什么坑」「上次改这里时注意过什么」「同样的错误是不是又犯了一次」时先查它。"
          + "返回若干条要点（含日期与那一轮的概括）。查不到就说明这个项目还没沉淀过相关内容，不要编。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "关键词，1~3 个短词最佳，如 \"碰撞 节点\" 或 \"速度 脚本\"" },
            limit: { type: "integer", description: "最多返回几条，默认 6，上限 12" }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "ReadKnowledge",
        description:
          "读当前工程最近的历史经验（不需要关键词，按时间倒序）。"
          + "接手一个不熟悉的工程、或想知道「之前这个 AI 在这里做过什么改动」时用它。",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", description: "最多返回几轮，默认 8，上限 20" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "ProjectDigest",
        description:
          "读取当前工程的**可操作**结构摘要：每个场景（含 UI 场景）的尺寸与对象清单"
          + "（对象名、kind、坐标、挂的模块），以及已有的预制体、脚本名、变量名、可用素材 id。"
          + "改工程之前必须先读它：里面的 id 和名字就是 ApplyProjectOps 唯一认的坐标。"
          + "SceneDigest 只给计数，要动关卡请用这个。",
        parameters: {
          type: "object",
          properties: {
            scene: { type: "string", description: "只看某个场景（场景名或 id），省略则全部" },
            maxObjects: { type: "integer", description: "每个场景最多列几个对象，默认 40" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "ApplyProjectOps",
        description:
          "用一批**结构化操作**整块改造工程：建场景、加/改/删对象、挂模块、定义预制体、写 UI。"
          + "这是唯一能真的改动关卡与 UI 的工具 —— 只写脚本不建世界是不够的。"
          + "整批事务：任何一条非法（未知 kind、未知模块 defId、参数越界、引用不存在）都会"
          + "导致**整批被拒且原工程不变**，并返回逐条拒绝原因。所以宁可分小批，不要赌。"
          + "可用 kind：ACTOR / PROP / TILE / ZONE / SPAWN / PORTAL / LIGHT。"
          + "UI 不是独立树：它就是一个 ui:true 的场景，里面放普通对象。",
        parameters: {
          type: "object",
          properties: {
            ops: {
              type: "array",
              description: "操作数组，按顺序在同一份工程副本上生效。",
              items: {
                type: "object",
                properties: {
                  op: {
                    type: "string",
                    enum: [
                      "createScene",
                      "addObjects",
                      "updateObjects",
                      "deleteObjects",
                      "attachModules",
                      "definePrefabs"
                    ],
                    description: "操作类型"
                  },
                  scene: {
                    type: "object",
                    description: "createScene 用：{ name, ui?, widthTiles?, heightTiles?, designW?, designH? }"
                  },
                  sceneId: { type: "string", description: "目标场景 id（与 sceneName 二选一）" },
                  sceneName: { type: "string", description: "目标场景名（与 sceneId 二选一；同批次新建的场景可直接用名字）" },
                  objects: {
                    type: "array",
                    description:
                      "addObjects/updateObjects/deleteObjects 用。新增对象："
                      + "{ name, kind, x, y, z?, halfW?, halfH?, rotation?, scaleX?, scaleY?, visible?, assetId?, modules? }；"
                      + "修改对象：{ id 或 name，其余字段同上，只覆盖给出的字段 }；"
                      + "删除对象：{ id 或 name }。"
                  },
                  prefabs: {
                    type: "array",
                    description: "definePrefabs 用：[{ name, kind, halfW?, halfH?, assetId?, modules? }]"
                  }
                },
                required: ["op"]
              }
            },
            dryRun: {
              type: "boolean",
              description: "true 时只校验不落盘，用来试探一批操作是否合法。默认 false。"
            }
          },
          required: ["ops"]
        }
      }
    }
  ];
}

/** 工具名白名单：模型给出未定义的名字时直接拒掉，不要瞎执行。 */
export const TOOL_NAMES = [
  "ReadFile",
  "ReadToolResult",
  "SceneDigest",
  "SearchApi",
  "ListScripts",
  "ReadScript",
  "WriteScript",
  "PatchScript",
  "DeleteScript",
  "SearchKnowledge",
  "ReadKnowledge",
  "ProjectDigest",
  "ApplyProjectOps"
];

/**
 * 知识库类工具：**只读、且只读当前工程**。
 *
 * 由 bridge 通过 `opts.knowledgeRunner` 执行（它知道这一轮属于哪个工程）。
 * 之所以不给 WriteKnowledge：沉淀是**自动**的（每轮结束由系统写入，零模型介入）。
 * 让模型自己决定"要不要记"会带来两个问题：① 它会漏记；② 它会记入"自认为重要"的内容，
 * 而真正有用的失败原因反而被忽略。自动沉淀 + 模型只读，职责才清楚。
 */
export const KNOWLEDGE_TOOLS = ["SearchKnowledge", "ReadKnowledge"];

/**
 * 必须在**渲染侧**（工程权威副本）执行的工具。
 *
 * 主进程读不到渲染进程内存里的 `store.project`，所以这些工具由 bridge 通过
 * `opts.scriptRunner` 转发到渲染侧执行（见 bridge.runTools 的 SCRIPT_TOOLS 分支）。
 * 单独导出这份清单，是为了让「工具定义里有它」与「真的执行得了」能用**同一份数据**校验 ——
 * 历史缺陷的形态正是「工具描述承诺了某个能力，而某条配置下根本没有接线」。
 */
export const SCRIPT_TOOLS = ["ListScripts", "ReadScript", "WriteScript", "PatchScript", "DeleteScript"];

/**
 * 工程级改动工具：改的是关卡/UI/预制体本身，不是脚本正文。
 *
 * 同样必须在渲染侧执行，理由和 SCRIPT_TOOLS 一模一样：工程的真身在
 * `store.project`。但它比脚本写更值得小心 —— 脚本写坏顶多不跑，
 * 工程写坏是把用户的关卡改花。所以它不接收自由文本，只接收**结构化 ops**，
 * 并且整批事务：一条非法，全批回滚，原工程逐字节不变。
 */
export const PROJECT_TOOLS = ["ProjectDigest", "ApplyProjectOps"];

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
 * @param {(name:string, args:object)=>Promise<{text:string, meta?:object, error?:string}>} [opts.scriptRunner]
 *        脚本写类工具的执行器（**由 bridge 注入，主进程转发到渲染侧**）。
 *        主进程没有工程数据：工程的真身在渲染进程内存里（store.project），
 *        所以这五个工具必须回到渲染侧执行。没注入时它们会明确答「未接线」，
 *        而不是假装成功（假装成功 = 模型以为改好了，用户什么也没看到）。
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

  /**
   * 脚本写类工具：转发到**渲染侧**执行。
   *
   * 为什么必须转发而不是在这里直接改文件：工程的真身是渲染进程内存里的
   * `store.project`（脚本源码存在 `scripts[name].source`），磁盘上的 `.bwproj`
   * 只是导出物、`web/examples/<工程>/scripts/*.js` 只是给 VS Code 的镜像。
   * 主进程直接改文件会让三方分叉：AI 说改好了 → 编辑器界面没变 → 用户下次保存
   * 再把 AI 的改动覆盖回去。只有回到渲染侧改权威副本，改动才「真的生效且可撤销」。
   */
  async function scriptTool(name, args) {
    if (typeof opts.scriptRunner !== "function") {
      throw new Error(
        `工具 ${name} 未接线：本轮没有可用的渲染侧执行器（scriptRunner）。`
        + "这不是参数问题 —— 说明宿主没把脚本编辑通道接上，请直接在回答里给出改动内容，"
        + "让用户自己在「剧本」面板粘贴，不要声称已经改好。"
      );
    }
    const out = await opts.scriptRunner(name, args);
    const text = String(out?.text ?? "");
    if (out?.error) {
      // 错误时**不能**把 out.text 丢掉。工程改造被拒时，那段正文里装的是逐条拒绝原因
      // （第几条、哪条 op、为什么、该怎么改）。只回一个错误码，模型就只能瞎猜着重试。
      const detail = text && text !== String(out.error) ? `\n${text}` : "";
      return { error: String(out.error), text: `工具 ${name} 失败：${out.error}${detail}`, meta: { tool: name } };
    }
    return { text, meta: { tool: name, ...(out?.meta ?? {}) } };
  }

  /**
   * 知识库类工具：**只读当前工程的历史经验**。
   *
   * 执行器由 bridge 注入（`opts.knowledgeRunner`）—— 它才知道"这一轮属于哪个工程"。
   * 没接线时明确答"不可用"，而不是返回空结果：
   * 空结果会让模型以为"这个项目没有历史经验"，于是放弃检索、重复踩坑。
   * 说清"检索能力当前不可用"它才会改用别的依据。
   */
  async function knowledgeTool(name, args) {
    if (typeof opts.knowledgeRunner !== "function") {
      throw new Error(
        `工具 ${name} 未接线：本轮没有可用的知识库执行器。`
        + "请直接基于工程摘要与代码作答，不要假设「查过、没有相关经验」。"
      );
    }
    const out = await opts.knowledgeRunner(name, args);
    const text = String(out?.text ?? "");
    if (out?.error) return { error: String(out.error), text: `工具 ${name} 失败：${out.error}`, meta: { tool: name } };
    return { text, meta: { tool: name, ...(out?.meta ?? {}) } };
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
        if (SCRIPT_TOOLS.includes(name)) return await scriptTool(name, args);
        if (PROJECT_TOOLS.includes(name)) return await scriptTool(name, args);
        if (KNOWLEDGE_TOOLS.includes(name)) return await knowledgeTool(name, args);
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
      // 脚本类：把「脚本名 + 这次想做什么」压成一行，用户在工具块里能直接看懂
      if (call?.name === "ListScripts") return "全部脚本";
      if (call?.name === "ReadScript") return String(args.name ?? "");
      if (call?.name === "WriteScript") {
        const n = String(args.name ?? "");
        const lines = String(args.source ?? "").split("\n").length;
        return `${n} · 整篇写入 ${lines} 行`;
      }
      if (call?.name === "PatchScript") {
        const n = String(args.name ?? "");
        const dl = String(args.replace ?? "").split("\n").length;
        return `${n} · 替换 1 处 → ${dl} 行`;
      }
      if (call?.name === "DeleteScript") return `${String(args.name ?? "")}${args.force ? " · force" : ""}`;
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
