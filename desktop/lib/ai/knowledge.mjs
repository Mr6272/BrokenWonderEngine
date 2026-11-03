/**
 * AI 层 · **项目知识库**（每轮 AI 执行完自动沉淀，按工程彼此隔离）。
 *
 * ── 要解决的问题 ────────────────────────────────────────────────────────
 * 用户的原话：「每一次 AI 执行完，都会把当前项目沉淀到知识库内，每个项目独立。」
 *
 * 没有它的时候，AI 每一轮都是**失忆的**：同一个工程里昨天刚踩过的坑
 *（某个 API 不存在、某个脚本必须保持行尾、某段逻辑不能动），今天重开一轮又踩一遍。
 * 会话历史只能解决「同一段对话内」的连续，解决不了「跨对话、跨重启」的工程记忆。
 *
 * ── 三个不可妥协的设计点 ────────────────────────────────────────────────
 *
 * 1. **按工程隔离用「名字 + 路径 hash」两段键，不是只用名字。**
 *    只用名字：用户有两个都叫「示例工程」的 .bwproj（一个在 D:\，一个在 E:\），
 *    记忆会串在一起 —— AI 拿 A 工程的经验去改 B 工程，这是**错误的自信**，比没有记忆更糟。
 *    只用路径：用户把工程换个文件夹（或从另一台机器同步过来），记忆就全丢了。
 *    两段键（name + 路径 hash）兼顾两者；示例/内置工程没有真实路径时退化为「只有名字」的键，
 *    并在摘要里明确标注「这个项目没有磁盘路径」。
 *
 * 2. **沉淀的是「结构化要点」，不是对话原文。**
 *    存全文会：① 体积随对话线性膨胀；② 把用户随口说的隐私内容（密钥、无关闲聊）永久留在盘上；
 *    ③ 让"检索"退化成"全文搜索噪声"。
 *    所以只记**有复用价值**的东西：改过哪些脚本、为什么改、什么失败了、什么被拒绝。
 *    每一条都能在 1~3 行内说清，且必须能被机器算出（不调模型、不花 token）。
 *
 * 3. **写知识库失败绝不影响对话。**
 *    知识库是「锦上添花」的旁路。任何异常（磁盘满、目录权限、JSON 坏）只能记日志，
 *    不能让用户刚拿到的回答丢掉 —— 那是最不可接受的失败形态。
 *
 * ── 存储布局（与 sessions/ 同级，不混在一起）────────────────────────────
 *   knowledge/<projectKey>/
 *   ├── index.json        项目的元信息（名字、路径、首次/最近时间、条目总数）
 *   ├── rounds.jsonl      每轮一条（追加写，天然抗"半截 JSON"：坏行只损失一行）
 *   └── digest.md         人可读的浓缩版（最新 N 条要点，方便用户/模型直接读）
 *
 * 为什么 rounds 用 JSONL 而不是 JSON 数组：追加写最省事，且**单行损坏不会毁掉整个文件**
 * （JSON 数组少一个 ] 就整份读不出来）。读取时逐行 try/parse，跳过坏行。
 *
 * 纯 Node 标准库（只有 fs + path + crypto），可单测。
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 单条要点的最大字符数（超出截断，防止一条 4000 字的模型输出把知识库撑爆）。 */
export const POINT_MAX_CHARS = 220;
/** 每轮最多记几条要点（多了没用：知识库的价值在"能被读完"，不是"记得全"）。 */
export const POINTS_PER_ROUND_MAX = 12;
/** digest.md 里保留的最近轮数。 */
export const DIGEST_ROUNDS = 20;

// ============================================================================
// 项目身份
// ============================================================================

/**
 * 由「工程名 + 工程路径」算出项目键。
 *
 * 规则（与用户的口径一致：按工程名 + 路径 hash）：
 *   · 有路径：`<安全化的名字>-<路径hash8>` —— 两个同名工程不会串
 *   · 无路径（示例工程 / 从未保存的新工程）：`<安全化的名字>-local`
 *     ⚠ 必须在键里显式写出 `local`，而不是用"省略"表示：
 *     否则"没有路径"与"路径恰好算出一个空 hash"会撞在同一个键上。
 *
 * 名字只做安全化（去掉路径分隔符与 Windows 非法字符、压掉多余空白），
 * **不截断成拼音或 hash 唯一**：用户要在文件系统里认出这个目录是哪个工程。
 * 长度上限 40，超出用 hash 后缀补足 —— 太长的目录名在 Windows 上会出问题（260 路径限制）。
 *
 * @param {object} input
 * @param {string} [input.name] 工程名（Project.name，不是文件名）
 * @param {string} [input.file] 工程文件名或绝对路径（可为空）
 * @returns {{ key: string, safeName: string, pathHash: string|null, hasPath: boolean }}
 */
export function projectKeyOf({ name, file } = {}) {
  const rawName = String(name ?? "").trim() || "未命名工程";
  const rawFile = String(file ?? "").trim();

  // 名字安全化：保留中文与常见字符（用户要能认出来），只去掉会破坏路径的部分。
  let safeName = rawName
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
  if (!safeName) safeName = "未命名工程";

  // 路径归一：Windows 大小写不敏感 + 分隔符统一，同一条路径的不同写法必须算出同一个键。
  const normFile = rawFile
    ? rawFile.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    : "";
  const pathHash = normFile ? createHash("sha1").update(normFile).digest("hex").slice(0, 8) : null;

  if (safeName.length > 40) {
    // 太长：截断 + 名字自身的 hash 尾巴，保证「同名截断后的不同工程」也不会撞。
    const tail = createHash("sha1").update(rawName.toLowerCase()).digest("hex").slice(0, 6);
    safeName = `${safeName.slice(0, 33)}-${tail}`;
  }

  const key = pathHash ? `${safeName}-${pathHash}` : `${safeName}-local`;
  return { key, safeName, pathHash, hasPath: Boolean(pathHash) };
}

// ============================================================================
// 要点提取（纯函数、零 token）
// ============================================================================

/** 把可能很长的文本压成一行、截断到 POINT_MAX_CHARS。 */
export function oneLine(text, max = POINT_MAX_CHARS) {
  const s = String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 从**本轮运行数据**里提取结构化要点。
 *
 * ⚠ 全部来自 bridge 已有的运行结果（工具轨迹、改动结果、stopReason、用户提问），
 * **不调模型、不花 token** —— 这是"零成本沉淀"的前提。
 * 用模型总结一轮要再付一次输入费用，而每轮都付等于把省 token 的收益吃回去。
 *
 * @param {object} round
 * @param {string} [round.intent]        本轮意图（chat / edit-script / explain-error / scene-review）
 * @param {string} [round.userText]      用户这一轮说的话（截断后入知识库）
 * @param {string} [round.answerText]    模型最终正文（只取"结论性"的短片段）
 * @param {Array}  [round.toolCalls]     工具轨迹 [{name, arg, ok?, changed?, ...}]
 * @param {Array}  [round.scriptOps]     脚本写操作结果 [{tool, name, ok, message, reason}]（可选，更精确）
 * @param {string} [round.stopReason]    null / "stalled" / "timeout" / "aborted"
 * @param {object} [round.usage]         token 用量
 * @param {number} [round.elapsedMs]     本轮耗时
 * @param {number} [round.rounds]        工具往返轮数
 * @param {string} [round.model]         实际模型
 * @returns {{ summary: string, points: string[], tags: string[] }}
 */
export function extractRoundKnowledge(round = {}) {
  const points = [];
  const tags = new Set();
  const push = (text, tag) => {
    const s = oneLine(text);
    if (!s) return;
    if (points.length >= POINTS_PER_ROUND_MAX) return;
    points.push(s);
    if (tag) tags.add(tag);
  };

  const intent = String(round.intent ?? "").trim();
  // ---- 1. 这一轮想做什么（最有价值的一条：以后 AI 检索时靠它判断相关性）----
  const userText = oneLine(round.userText, 120);
  if (userText) push(`诉求：${userText}`, "诉求");
  if (intent) tags.add(`intent:${intent}`);

  // ---- 2. 脚本实际改动（按"改了哪个脚本"聚合，不是按调用次数罗列）----
  //
  // 为什么聚合：一轮里模型可能对同一个脚本连发 3 次 PatchScript，
  // 逐条记下来是噪声；记成"修改了 player（3 次补丁）"才有检索价值。
  const scriptOps = Array.isArray(round.scriptOps) ? round.scriptOps : [];
  const touched = new Map(); // scriptName → { writes, patches, deletes, failures:[] }
  for (const op of scriptOps) {
    const name = String(op?.name ?? "").trim();
    if (!name) continue;
    const tool = String(op?.tool ?? "");
    const cur = touched.get(name) ?? { writes: 0, patches: 0, deletes: 0, failures: [] };
    if (!op.ok) {
      cur.failures.push(String(op.reason ?? op.message ?? "失败"));
    } else if (tool === "WriteScript") cur.writes += 1;
    else if (tool === "PatchScript") cur.patches += 1;
    else if (tool === "DeleteScript") cur.deletes += 1;
    touched.set(name, cur);
  }
  for (const [name, info] of touched) {
    const parts = [];
    if (info.writes) parts.push(`整篇写入 ${info.writes} 次`);
    if (info.patches) parts.push(`补丁 ${info.patches} 次`);
    if (info.deletes) parts.push(`删除 ${info.deletes} 次`);
    if (parts.length) {
      push(`改动脚本「${name}」：${parts.join("、")}`, "改脚本");
    }
    if (info.failures.length) {
      // 失败原因**必须保留原话**：这正是"以后不要再这样写"的线索。
      push(`脚本「${name}」有操作被拒绝：${info.failures.slice(0, 2).join("；")}`, "被拒绝");
    }
  }

  // ---- 3. 读过的脚本 / 用过的工具（轻量，但能提示"这个项目有哪些文件被研究过"）----
  const toolCalls = Array.isArray(round.toolCalls) ? round.toolCalls : [];
  const readFiles = new Set();
  for (const c of toolCalls) {
    const name = String(c?.name ?? "");
    const arg = String(c?.arg ?? "");
    if (name === "ReadFile" && arg) readFiles.add(arg);
    if (name === "ReadScript" && arg) readFiles.add(`脚本:${arg}`);
  }
  if (readFiles.size) {
    push(`查阅过：${Array.from(readFiles).slice(0, 6).join("、")}`, "查阅");
  }

  // ---- 4. 结论（只取首句，且只在"看起来是结论"时记）----
  //
  // 为什么不整段存：模型正文动辄 2000 字，全存进知识库等于把知识库变成第二份聊天记录。
  // 为什么只取首句：首句通常是结论（"问题是……所以改成……"），后面的都是展开说明。
  const answer = oneLine(round.answerText, 4000);
  if (answer) {
    const firstSentence = answer.split(/(?<=[。！？.!?])\s*/)[0] ?? answer;
    if (firstSentence.trim().length >= 8) push(`结论：${firstSentence}`, "结论");
  }

  // ---- 5. 异常收尾（这是"下次别再用同样方式"的最强线索）----
  const stop = round.stopReason;
  if (stop === "stalled") push("本轮被判为绕圈（反复同样的调用且结果无变化），没有正常收尾", "绕圈");
  else if (stop === "timeout") push("本轮超时中止（看门狗 45 分钟），任务需要拆小", "超时");
  else if (stop === "aborted") push("本轮被用户取消", "取消");

  // ---- 6. 一轮的元信息（可追溯，但不是"要点"，单独放一行汇总）----
  const meta = [];
  if (round.model) meta.push(`模型 ${round.model}`);
  if (round.rounds) meta.push(`${round.rounds} 轮工具`);
  if (toolCalls.length) meta.push(`${toolCalls.length} 次调用`);
  if (round.elapsedMs) meta.push(`${Math.round(round.elapsedMs / 1000)}s`);
  const usage = round.usage ?? {};
  const tokens = (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.outputTokens) || 0);
  if (tokens) meta.push(`${tokens} tokens`);

  // 摘要：一句话说清这轮干了什么（用于列表页/检索命中展示）
  const changedScripts = Array.from(touched.keys());
  const summary = changedScripts.length
    ? `改了 ${changedScripts.length} 个脚本（${changedScripts.slice(0, 3).join("、")}${changedScripts.length > 3 ? " 等" : ""}）`
    : intent === "explain-error"
      ? "定位脚本错误"
      : intent === "scene-review"
        ? "审场景结构"
        : "对话/答疑";

  return { summary, points, tags: Array.from(tags) };
}

// ============================================================================
// 存储
// ============================================================================

/** 一次沉淀写入的记录（rounds.jsonl 的一行）。 */
export function makeRoundRecord(round = {}, extra = {}) {
  const { summary, points, tags } = extractRoundKnowledge(round);
  return {
    at: extra.at ?? new Date().toISOString(),
    requestId: String(extra.requestId ?? ""),
    // 身份三段（跨轮/跨重启排查用；也是"同一工程不同会话"的关联键）
    project: extra.project ?? null,
    sessionId: String(extra.sessionId ?? ""),
    intent: String(round.intent ?? ""),
    model: String(round.model ?? ""),
    summary,
    points,
    tags: tags.length ? tags : undefined,
    stopReason: round.stopReason ?? null,
    /**
     * 有没有实质内容。
     * false = 只在知识库里记一条"这轮没什么可沉淀的"（例如纯闲聊）。
     * 有了它，列表页可以过滤掉噪声，而**不必**丢弃这条记录
     *（丢掉就永远不知道"用户问过但没结果"）。
     */
    meaningful: points.length > 0
  };
}

function readJsonSafe(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 原子写 JSON。 */
async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

/**
 * 打开（或新建）一个项目知识库。
 *
 * @param {object} opts
 * @param {string} opts.root       知识库根目录（%APPDATA%\BWE Studio\knowledge）
 * @param {{name?:string, file?:string}} opts.project 工程身份
 * @returns {Promise<{ key, dir, index, rounds, ... }>}
 */
export async function openKnowledge({ root, project } = {}) {
  const identity = projectKeyOf(project ?? {});
  const dir = join(String(root ?? ""), identity.key);
  const indexPath = join(dir, "index.json");
  const roundsPath = join(dir, "rounds.jsonl");
  const digestPath = join(dir, "digest.md");

  await mkdir(dir, { recursive: true });

  // index 读失败 = 空索引（不能因为索引坏了就让整库不可用；rounds 才是正文）
  let indexText = "";
  try {
    indexText = await readFile(indexPath, "utf8");
  } catch {
    indexText = "";
  }
  const now = new Date().toISOString();
  let index = readJsonSafe(indexText, null);
  if (!index || typeof index !== "object") {
    index = {
      version: 1,
      key: identity.key,
      name: String(project?.name ?? "未命名工程"),
      file: String(project?.file ?? ""),
      createdAt: now,
      updatedAt: now,
      roundCount: 0,
      pointCount: 0
    };
    await writeJsonAtomic(indexPath, index);
  }

  /**
   * 读最近若干轮（新的在前）。
   *
   * ⚠ 抽成**闭包函数**而不是只写成对象方法：`stats()` / `search()` / `appendRound()` 都要读它，
   * 而对象方法里裸调用 `readRounds(...)` 会 ReferenceError（第一次就是这么炸的）。
   * 写成 `this.readRounds()` 又会被"方法被解构后 this 丢失"坑到。
   * 闭包是这里最稳的形态，对外再暴露一个同名方法即可。
   */
  const readRounds = async ({ limit = 50 } = {}) => {
    let text = "";
    try {
      text = await readFile(roundsPath, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const rec = readJsonSafe(t, null);
      // JSONL 的价值就在这里：坏行跳过，不影响其它行（一条写坏的记录不该毁掉整库）。
      if (rec && typeof rec === "object") out.push(rec);
    }
    out.reverse(); // 新的在前：检索/展示都是"最近的最有用"
    return limit > 0 ? out.slice(0, limit) : out;
  };

  return {
    ...identity,
    dir,
    indexPath,
    roundsPath,
    digestPath,
    /** 元信息（每次写盘后会被刷新）。 */
    get index() {
      return index;
    },

    /**
     * 追加一轮沉淀。
     *
     * @param {object} round  见 extractRoundKnowledge
     * @param {object} [extra] { requestId, sessionId }
     * @returns {Promise<{ record, index }>}
     */
    async appendRound(round = {}, extra = {}) {
      const record = makeRoundRecord(round, {
        ...extra,
        project: { key: identity.key, name: String(project?.name ?? ""), file: String(project?.file ?? "") }
      });
      // JSONL 追加：一行一条。即使进程在这一行中途崩溃，最多损失这一行。
      await appendFile(roundsPath, `${JSON.stringify(record)}\n`, "utf8");

      // index 是**派生统计**：每轮更新计数与时间。它坏了不影响数据（rounds 才是本体）。
      index = {
        ...index,
        updatedAt: record.at,
        roundCount: (Number(index.roundCount) || 0) + 1,
        pointCount: (Number(index.pointCount) || 0) + record.points.length,
        lastSummary: record.summary
      };
      await writeJsonAtomic(indexPath, index);

      // digest.md：人可读的浓缩版（最近 DIGEST_ROUNDS 条要点）。
      // 为什么要有它：用户/模型想"直接读一眼这个项目的经验"时，读 md 比解析 jsonl 快得多。
      try {
        const rounds = await readRounds({ limit: DIGEST_ROUNDS });
        await writeFile(digestPath, renderDigest(identity, index, rounds), "utf8");
      } catch {
        // digest 只是方便人看，写失败不该影响沉淀本身
      }
      return { record, index };
    },

    /** 读最近若干轮（新的在前）。委托给闭包 readRounds（见其注释）。 */
    async readRounds(opts = {}) {
      return readRounds(opts);
    },

    /** 项目摘要（给面板列表与 SearchKnowledge 用）。 */
    async stats() {
      const rounds = await readRounds({ limit: 0 });
      const points = rounds.flatMap((r) => r.points ?? []);
      return {
        key: identity.key,
        name: index.name,
        file: index.file,
        hasPath: identity.hasPath,
        createdAt: index.createdAt,
        updatedAt: index.updatedAt,
        roundCount: rounds.length,
        pointCount: points.length,
        meaningfulRounds: rounds.filter((r) => r.meaningful !== false).length
      };
    },

    /**
     * 在这个项目的知识库里做**关键词检索**（不跨项目）。
     *
     * 为什么不做向量检索：知识库是"每轮几条短要点"，总量在几百条量级，
     * 关键词匹配（多词 OR + 命中数排序）足够，且**零成本、零依赖**。
     * 引入 embedding 会带来：模型调用费用、离线不可用、索引与原文不一致。
     * 等条目数真的上千再考虑向量（那时先加"按脚本名/标签过滤"更划算）。
     *
     * @param {string} query
     * @param {{limit?:number}} [opts]
     */
    async search(query, { limit = 8 } = {}) {
      const q = String(query ?? "").trim().toLowerCase();
      if (!q) return [];
      const words = q.split(/[\s\u3000]+/).filter((w) => w.length > 0);
      const rounds = await readRounds({ limit: 0 });
      const hits = [];
      for (const r of rounds) {
        for (const p of r.points ?? []) {
          const low = String(p).toLowerCase();
          // 命中词数优先（多词查询最怕"一个词都不中却排在前"），其次单条命中次数。
          let matched = 0;
          let occurrences = 0;
          for (const w of words) {
            if (low.includes(w)) {
              matched += 1;
              occurrences += low.split(w).length - 1;
            }
          }
          if (matched === 0) continue;
          hits.push({
            point: p,
            summary: String(r.summary ?? ""),
            at: r.at,
            intent: r.intent,
            score: matched * 10 + Math.min(occurrences, 5)
          });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, Math.max(1, limit));
    }
  };
}

/**
 * 按**目录**直接读最近若干轮（面板用）。
 *
 * 为什么绕过 openKnowledge：面板拿到的只有目录名（即 key），而 openKnowledge 需要的是
 * 工程身份（name + file）。拿目录名当身份会算出**另一个** key（目录名里已经带 hash 后缀），
 * 于是"读 A 项目"变成"打开 A-<新hash>" —— 目录被新建出来、内容是空的。
 * 面板是只读展示，直接按目录读最直接，也不可能误解。
 */
export async function readKnowledgeRoundsForDir(dir, limit = 80) {
  let text = "";
  try {
    text = await readFile(join(String(dir ?? ""), "rounds.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const rec = readJsonSafe(t, null);
    if (rec && typeof rec === "object") out.push(rec);
  }
  out.reverse();
  return limit > 0 ? out.slice(0, limit) : out;
}

/** 读某个目录的 index.json（面板展示项目元信息用；读不到返回 null）。 */
export async function readKnowledgeIndexForDir(dir) {
  try {
    return JSON.parse(await readFile(join(String(dir ?? ""), "index.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 渲染 digest.md：人可读的"这个项目的经验浓缩版"。
 *
 * 为什么单独做一个 md：用户会想直接打开看，模型也可能被要求"读一下这个项目的经验"。
 * 直接给纯 Markdown 比让调用方解析 jsonl 省事，也不容易看错。
 */
export function renderDigest(identity, index, rounds) {
  const lines = [];
  lines.push(`# ${index?.name ?? "未命名工程"} · 项目知识库`);
  lines.push("");
  lines.push(`- 项目键：\`${identity?.key ?? ""}\``);
  if (identity?.hasPath ?? index?.file) lines.push(`- 工程文件：\`${index?.file ?? ""}\``);
  else lines.push("- 工程文件：**无磁盘路径**（示例/未保存工程，记忆只按工程名归档）");
  lines.push(`- 首次沉淀：${index?.createdAt ?? ""}`);
  lines.push(`- 最近更新：${index?.updatedAt ?? ""}`);
  lines.push(`- 累计 ${index?.roundCount ?? 0} 轮 / ${index?.pointCount ?? 0} 条要点`);
  lines.push("");
  if (!rounds.length) {
    lines.push("（还没有沉淀任何内容）");
    return lines.join("\n");
  }
  lines.push(`## 最近 ${rounds.length} 轮`);
  for (const r of rounds) {
    lines.push("");
    lines.push(`### ${r.at ?? ""} · ${r.summary ?? ""}`);
    for (const p of r.points ?? []) lines.push(`- ${p}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ============================================================================
// 知识库根：列出所有项目（面板用）
// ============================================================================

/**
 * 列出知识库里的所有项目。
 *
 * ⚠ 这里**必须直接读磁盘目录**，不能只信某个总索引：
 * 目录清单是唯一真相。多一个总索引文件 = 又多一处会与目录不一致的派生数据
 *（历史教训：会话 index.json 损坏时 UI 显示"全没了"，而内容其实都在盘上）。
 */
export async function listProjects(root) {
  const dir = String(root ?? "");
  let entries = [];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const indexPath = join(dir, e.name, "index.json");
    let index = null;
    try {
      index = JSON.parse(await readFile(indexPath, "utf8"));
    } catch {
      continue; // 没有 index 的目录不是有效项目（可能是一次失败写入的残留）
    }
    out.push({
      key: e.name,
      name: String(index?.name ?? e.name),
      file: String(index?.file ?? ""),
      createdAt: index?.createdAt ?? "",
      updatedAt: index?.updatedAt ?? "",
      roundCount: Number(index?.roundCount) || 0,
      pointCount: Number(index?.pointCount) || 0,
      lastSummary: String(index?.lastSummary ?? "")
    });
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}
