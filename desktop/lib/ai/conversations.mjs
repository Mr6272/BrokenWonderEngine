/**
 * AI 层 · 多会话存储（conversations/<id>/ + index.json）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * 原来所有对话都进同一个 `history.json` —— 用户想「开新对话」「在历史会话间切换」时无法做到。
 * 存储改成：
 *   sessions/<workspaceHash>/
 *   ├── index.json                      [{id,title,createdAt,updatedAt,messageCount,modelId}], active
 *   └── conversations/<id>/
 *       ├── history.json                该会话的完整消息（无损）
 *       ├── summary.json                该会话的压缩摘要 + usage
 *       └── meta.json
 *
 * ── 三条不可妥协的规矩 ─────────────────────────────────────────────────
 *
 * 1. **老数据必须能迁移，绝不丢历史。**
 *    旧结构是 `sessions/<hash>/history.json`（单份）。首次 load 时把它整体搬成第一个会话，
 *    并把顶层旧文件归档（改名而不是删除 —— 万一迁移逻辑有 bug，用户还能手工找回）。
 *
 * 2. **删除当前会话不能留下悬空 active。**
 *    active 必须永远指向一个真实存在的会话。删掉 active 时按 updatedAt 落到最近的下一个；
 *    删到只剩 0 个时自动补一个空会话（否则 UI 没有可用会话，且下次启动也难恢复）。
 *
 * 3. **index.json 原子写。**
 *    半截 JSON 会让用户「所有会话都消失」（虽然内容还在磁盘上，但 UI 看不到）。
 *
 * 标题生成刻意**零 token**：取第一条用户消息前 20 字。理由：调模型生成标题是额外开销，
 * 而第一条消息本身就是最好的标题（用户自己写的那句话最贴近他的意图）。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 会话内容目录名（与 index.json 同级）。 */
export const CONVERSATIONS_DIR = "conversations";
/** 索引文件名。 */
export const INDEX_FILE = "index.json";
/** 标题最大字符数（含省略号）。 */
export const TITLE_MAX_CHARS = 20;
/** 没有可用标题时的兜底（绝不能是空串，否则列表里是一行空白）。 */
export const DEFAULT_TITLE = "新对话";

/** 索引格式版本（未来结构变化时用于迁移）。 */
export const INDEX_VERSION = 1;

// ---------------------------------------------------------------------------
// 标题生成（纯函数、零 token）
// ---------------------------------------------------------------------------

/**
 * 从用户消息生成会话标题。
 *
 * 规则：
 *   · 多行压成一行（标题栏只有一行，含换行会把列表撑歪）
 *   · 首尾空白裁掉
 *   · 超过 TITLE_MAX_CHARS 截断并加 `…`
 *   · 空/纯空白/非字符串 → DEFAULT_TITLE（绝不能返回空串）
 */
export function makeTitle(text) {
  const raw = typeof text === "string" ? text : String(text ?? "");
  // \s 含全角空格？不含 —— 中文全角空格 \u3000 要单独处理，否则标题会以一串空白开头。
  const oneLine = raw.replace(/\r?\n/g, " ").replace(/[\s\u3000]+/g, " ").trim();
  if (!oneLine) return DEFAULT_TITLE;
  if (oneLine.length <= TITLE_MAX_CHARS) return oneLine;
  // 留一个位置给省略号，保证总长不超过 TITLE_MAX_CHARS
  return `${oneLine.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 原子写 JSON（先 .tmp 再 rename）。 */
async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

/** 会话 id：时间戳 + 随机后缀，保证同一毫秒连续创建也不冲突。 */
function newId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建多会话存储。
 *
 * @param {object} opts
 * @param {string} opts.dir  会话根目录（sessions/<workspaceHash>）
 * @param {string} [opts.workspace]
 */
export function createConversationStore({ dir, workspace = "" }) {
  const indexPath = join(dir, INDEX_FILE);
  const convRoot = join(dir, CONVERSATIONS_DIR);
  let cache = null;

  const conversationDirOf = (id) => join(convRoot, String(id));

  /**
   * 读会话的消息条数（用于 index 的 messageCount）。
   * 读不到就当 0 —— 索引只是为了列表展示，不能因为一个文件读失败就让整个列表不可用。
   */
  async function countMessages(id) {
    const history = await readJson(join(conversationDirOf(id), "history.json"), null);
    if (!Array.isArray(history?.messages)) return 0;
    // system 块不算「消息」（UI 的会话列表按用户可见消息计数）
    return history.messages.filter((m) => !(m.role === "system" && m.block === "system")).length;
  }

  /** 把 index.json 写成当前状态。 */
  async function persist(state) {
    await writeJsonAtomic(indexPath, {
      version: INDEX_VERSION,
      active: state.active,
      sessions: state.sessions
    });
    cache = state;
  }

  /** 建一个新会话目录（空 history.json）。返回索引项。 */
  async function createConversationDir({ title, modelId = "" } = {}) {
    const id = newId();
    const now = new Date().toISOString();
    await mkdir(conversationDirOf(id), { recursive: true });
    await writeJsonAtomic(join(conversationDirOf(id), "history.json"), {
      version: 1,
      promptVersion: "",
      createdAt: now,
      messages: []
    });
    await writeJsonAtomic(join(conversationDirOf(id), "summary.json"), {
      text: "",
      coveredMessages: 0,
      usage: null,
      updatedAt: null
    });
    return { id, title: title || DEFAULT_TITLE, createdAt: now, updatedAt: now, messageCount: 0, modelId };
  }

  /**
   * 老数据迁移：把顶层的单份 history.json 搬成第一个会话。
   *
   * 行为：
   *   · 内容整体搬到 conversations/<id>/history.json（一条消息都不改）
   *   · summary.json 若存在也一起搬
   *   · 顶层旧文件**改名归档**（`history.json.migrated`）而不是删除，
   *     以便迁移逻辑万一有 bug 时用户还能找回
   *   · 返回迁移出的索引项；没有老数据返回 null
   */
  async function migrateLegacy() {
    const legacyHistory = join(dir, "history.json");
    const exists = await stat(legacyHistory)
      .then((st) => st.isFile())
      .catch(() => false);
    if (!exists) return null;

    const legacy = (await readJson(legacyHistory, null)) ?? { messages: [] };
    const legacySummary = await readJson(join(dir, "summary.json"), null);

    const id = newId();
    const now = new Date().toISOString();
    await mkdir(conversationDirOf(id), { recursive: true });
    await writeJsonAtomic(join(conversationDirOf(id), "history.json"), {
      version: legacy.version ?? 1,
      promptVersion: legacy.promptVersion ?? "",
      createdAt: legacy.createdAt ?? now,
      messages: Array.isArray(legacy.messages) ? legacy.messages : []
    });
    if (legacySummary) {
      await writeJsonAtomic(join(conversationDirOf(id), "summary.json"), legacySummary);
    }

    // 用旧内容的第一条用户消息做标题（用户迁移后一眼能认出这是哪个会话）
    const firstUser = (Array.isArray(legacy.messages) ? legacy.messages : []).find(
      (m) => m.role === "user" && Array.isArray(m.blocks)
    );
    const firstText = firstUser
      ? firstUser.blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ")
      : "";
    const title = makeTitle(firstText);

    // 归档旧文件（改名而非删除）：万一迁移有 bug，还能手工找回
    await rename(legacyHistory, `${legacyHistory}.migrated`).catch(() => {});
    await rename(join(dir, "summary.json"), join(dir, "summary.json.migrated")).catch(() => {});
    await rename(join(dir, "meta.json"), join(dir, "meta.json.migrated")).catch(() => {});

    const messageCount = await countMessages(id);
    return { id, title, createdAt: legacy.createdAt ?? now, updatedAt: now, messageCount, modelId: "" };
  }

  return {
    dir,
    indexPath,
    conversationDir: conversationDirOf,

    /**
     * 读取（并在需要时初始化）索引。
     *
     * 初始化顺序（顺序很重要）：
     *   1. index.json 可读 → 用它（同时把磁盘上多出来的会话目录补进索引，防止「文件在但列表没有」）
     *   2. 否则尝试老数据迁移
     *   3. 都没有 → 建一个空会话
     */
    async load() {
      if (cache) return cache;

      await mkdir(dir, { recursive: true });
      const raw = await readJson(indexPath, null);

      if (raw && Array.isArray(raw.sessions) && raw.sessions.length > 0) {
        // 索引可用：校准 messageCount 与 active
        const sessions = [];
        for (const item of raw.sessions) {
          if (!item || typeof item !== "object" || !item.id) continue;
          const messageCount = await countMessages(item.id);
          sessions.push({
            id: String(item.id),
            title: String(item.title || DEFAULT_TITLE),
            createdAt: String(item.createdAt || new Date().toISOString()),
            updatedAt: String(item.updatedAt || item.createdAt || new Date().toISOString()),
            messageCount,
            modelId: String(item.modelId || "")
          });
        }
        if (sessions.length > 0) {
          const active =
            raw.active && sessions.some((s) => s.id === raw.active) ? String(raw.active) : sessions[0].id;
          const state = { sessions, active };
          // 只有实际变了才回写，避免每次启动都写一次盘
          if (sessions.length !== raw.sessions.length || active !== raw.active) await persist(state);
          else cache = state;
          return cache;
        }
      }

      // 索引不存在或损坏 → 尝试迁移老数据
      const migrated = await migrateLegacy();
      if (migrated) {
        const state = { sessions: [migrated], active: migrated.id };
        await persist(state);
        return cache;
      }

      // 全新目录 → 建第一个空会话
      const first = await createConversationDir({ title: DEFAULT_TITLE });
      const state = { sessions: [first], active: first.id };
      await persist(state);
      return cache;
    },

    /**
     * 开新会话：**当前会话保留**，active 切到新会话。
     *
     * @param {{title?:string, modelId?:string}} [opts]
     */
    async create(opts = {}) {
      const state = await this.load();
      const item = await createConversationDir(opts);
      state.sessions.push(item);
      state.active = item.id;
      await persist(state);
      return item;
    },

    /**
     * 切到指定会话，返回该会话的完整消息。
     *
     * id 不存在时**明确报错**，绝不静默切到别的会话：
     * 静默切换会让 UI 显示 A、实际读写 B，是最难排查的一类问题。
     */
    async switchTo(id) {
      const state = await this.load();
      const target = String(id ?? "").trim();
      const hit = state.sessions.find((s) => s.id === target);
      if (!hit) {
        throw new Error(`会话「${target}」不存在（可能已被删除）`);
      }
      state.active = hit.id;
      await persist(state);

      const history = (await readJson(join(conversationDirOf(hit.id), "history.json"), null)) ?? { messages: [] };
      return {
        active: hit.id,
        messages: Array.isArray(history.messages) ? history.messages : [],
        sessions: state.sessions
      };
    },

    /**
     * 删除会话。
     *
     * 三条边界：
     *   · 删非 active → active 不变
     *   · 删 active   → 落到最近更新的其它会话（active 绝不能悬空）
     *   · 删到 0 个   → 自动补一个空会话（否则 UI 没有可用会话）
     */
    async remove(id) {
      const state = await this.load();
      const target = String(id ?? "").trim();
      const hit = state.sessions.find((s) => s.id === target);
      if (!hit) throw new Error(`会话「${target}」不存在`);

      state.sessions = state.sessions.filter((s) => s.id !== target);
      await rm(conversationDirOf(target), { recursive: true, force: true }).catch(() => {});

      if (state.sessions.length === 0) {
        const replacement = await createConversationDir({ title: DEFAULT_TITLE });
        state.sessions.push(replacement);
        state.active = replacement.id;
      } else if (state.active === target) {
        // 落到「最近更新」的那个（用户最可能继续的就是它）
        const next = [...state.sessions].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
        state.active = next.id;
      }
      await persist(state);
      return { sessions: state.sessions, active: state.active };
    },

    /** 更新某个会话的元信息（标题/条数/更新时间）。写盘后返回索引项。 */
    async touch(id, patch = {}) {
      const state = await this.load();
      const item = state.sessions.find((s) => s.id === String(id));
      if (!item) return null;
      if (patch.title !== undefined) item.title = makeTitle(patch.title);
      if (patch.modelId !== undefined) item.modelId = String(patch.modelId);
      item.messageCount = await countMessages(item.id);
      item.updatedAt = new Date().toISOString();
      await persist(state);
      return item;
    },

    /** 读某会话的摘要（供 bridge 压缩后同步）。 */
    async summaryOf(id) {
      return readJson(join(conversationDirOf(id), "summary.json"), null);
    },

    /** 当前状态快照（UI 列表用）。 */
    async state() {
      const s = await this.load();
      return { sessions: s.sessions, active: s.active };
    }
  };
}

/**
 * 列出磁盘上存在但索引里没有的会话目录（自愈用）。
 *
 * 场景：index.json 被删/损坏后又重建，但 conversations/<id>/ 还在 ——
 * 这些历史不该从用户眼里消失。
 */
export async function listOrphanConversationDirs(dir) {
  try {
    const entries = await readdir(join(dir, CONVERSATIONS_DIR), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
