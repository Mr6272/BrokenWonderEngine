/**
 * AI 层 · 会话落盘（无损历史 + 摘要/用量快照）。
 *
 * 契约 §4.3 第 6 条「无损续接」与 §4.4 存储位置：
 *   sessions/<workspaceHash>/history.json   完整消息（含 tool calls / tool results），无损
 *   sessions/<workspaceHash>/summary.json   压缩摘要 + token 用量快照
 *
 * 三条硬约束：
 *   1. history 全保真：重启后接着聊，工具调用/结果、思考、错误一个都不丢；
 *   2. system prompt 版本升级时**原地替换**那个块，其余消息与顺序不动 ——
 *      前缀缓存的收益来自「开头字节稳定」，重排历史等于把缓存全部作废；
 *   3. 原子写：先写 .tmp 再 rename。半截 JSON 会让下一次启动直接丢掉整个会话。
 *
 * 纯 Node 标准库，可单测（单测用临时目录）。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildSystemPrompt, PROMPT_VERSION } from "./prefix.mjs";

export const HISTORY_VERSION = 1;

/** workspaceHash：工作区路径 → 稳定短 hash，不同工程的会话互不覆盖。 */
export function workspaceHash(workspace) {
  return createHash("sha1").update(String(workspace || "").toLowerCase()).digest("hex").slice(0, 12);
}

/** 原子写：同目录 .tmp → rename。Windows 上 rename 覆盖已存在文件是原子的。 */
export async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 一条消息的形状（history.json 里的单位）。 */
export function makeMessage(role, text, extra = {}) {
  return {
    id: extra.id ?? makeId(),
    role,
    at: extra.at ?? new Date().toISOString(),
    blocks: extra.blocks ?? [{ type: "text", text: String(text ?? "") }],
    ...("reasoning" in extra ? { reasoning: extra.reasoning } : {}),
    ...("model" in extra ? { model: extra.model } : {}),
    ...("usage" in extra ? { usage: extra.usage } : {})
  };
}

let idCounter = 0;
export function makeId(prefix = "m") {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/** 消息里的纯文本（system 块与压缩统计都要用）。 */
export function messageText(msg) {
  return (msg?.blocks ?? [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * 打开（或新建）一个会话。
 *
 * @param {object} opts
 * @param {string} opts.dir            会话目录（%APPDATA%\BWE Studio\sessions\<hash>）
 * @param {string} [opts.workspace]    工作区路径（写进 meta 便于排查）
 * @returns {Promise<Session>}
 */
export async function openSession({ dir, workspace = "" }) {
  const historyFile = join(dir, "history.json");
  const summaryFile = join(dir, "summary.json");
  const metaFile = join(dir, "meta.json");

  const loaded = await readJson(historyFile, null);
  const summary = await readJson(summaryFile, null);
  const meta = await readJson(metaFile, null);

  const history = normalizeHistory(loaded);
  // 版本升级：原地替换 system 块（不重排、不删除），其余历史原样保留。
  const systemIndex = history.messages.findIndex((m) => m.role === "system" && m.block === "system");
  const stale = history.promptVersion !== PROMPT_VERSION;
  let replaced = false;
  if (systemIndex >= 0 && stale) {
    const fresh = buildSystemPrompt();
    if (messageText(history.messages[systemIndex]) !== fresh) {
      history.messages[systemIndex].blocks = [{ type: "text", text: fresh }];
      replaced = true;
    }
    history.messages[systemIndex].promptVersion = PROMPT_VERSION;
  }
  history.promptVersion = PROMPT_VERSION;
  if (stale || !loaded) {
    await writeJsonAtomic(historyFile, history);
  }

  const session = {
    dir,
    historyFile,
    summaryFile,
    metaFile,
    workspace,
    history,
    summary: summary ?? { text: "", coveredMessages: 0, usage: null, updatedAt: null },
    meta: meta ?? { createdAt: new Date().toISOString(), workspace },
    systemReplaced: replaced,

    /** 公开的消息（不含 system 块，渲染侧只关心对话）。 */
    messages() {
      return history.messages.filter((m) => !(m.role === "system" && m.block === "system"));
    },

    /** 当前 system prompt 文本（发请求时作为 messages[0]）。 */
    systemText() {
      const m = history.messages.find((x) => x.role === "system" && x.block === "system");
      return messageText(m) || buildSystemPrompt();
    },

    async append(message) {
      history.messages.push(message);
      await this.persist();
      return message;
    },

    async appendMany(messages) {
      history.messages.push(...messages);
      await this.persist();
    },

    async setSummary(patch) {
      session.summary = { ...session.summary, ...patch, updatedAt: new Date().toISOString() };
      await writeJsonAtomic(summaryFile, session.summary);
      return session.summary;
    },

    /** 压缩后替换「被摘要覆盖的那段」，头部 system 块保持原位。 */
    async replaceTail(newMessages, summaryPatch) {
      const sys = history.messages.filter((m) => m.role === "system" && m.block === "system");
      history.messages = [...sys, ...newMessages];
      await writeJsonAtomic(historyFile, history);
      if (summaryPatch) await session.setSummary(summaryPatch);
    },

    async persist() {
      await writeJsonAtomic(historyFile, history);
      await writeJsonAtomic(metaFile, {
        ...session.meta,
        workspace,
        messageCount: history.messages.length,
        promptVersion: PROMPT_VERSION,
        updatedAt: new Date().toISOString()
      });
    },

    /** 清空对话（保留 system 块与摘要），供 `aiReset` 用。 */
    async reset() {
      const sys = history.messages.filter((m) => m.role === "system" && m.block === "system");
      history.messages = sys.length
        ? sys
        : [{ role: "system", block: "system", promptVersion: PROMPT_VERSION, blocks: [{ type: "text", text: buildSystemPrompt() }] }];
      session.summary = { text: "", coveredMessages: 0, usage: null, updatedAt: new Date().toISOString() };
      await writeJsonAtomic(historyFile, history);
      await writeJsonAtomic(summaryFile, session.summary);
      return session;
    }
  };

  // 新会话 / 旧文件缺少 system 块时补一个（放在最前，保证前缀稳定）。
  if (systemIndex < 0) {
    history.messages.unshift({
      role: "system",
      block: "system",
      promptVersion: PROMPT_VERSION,
      blocks: [{ type: "text", text: buildSystemPrompt() }]
    });
    await writeJsonAtomic(historyFile, history);
  }
  // 三件套必须齐全（契约 §4.4）：summary.json 即使为空也要预先写出来，
  // 否则「会话目录结构」在第一次压缩之前是不完整的，排查时容易误判成文件丢失。
  if (!summary) {
    session.summary = { text: "", coveredMessages: 0, usage: null, updatedAt: null };
    await writeJsonAtomic(summaryFile, session.summary);
  }
  await session.persist();
  return session;
}

function normalizeHistory(loaded) {
  if (!loaded || typeof loaded !== "object" || !Array.isArray(loaded.messages)) {
    return { version: HISTORY_VERSION, promptVersion: PROMPT_VERSION, messages: [] };
  }
  // 老版本文件：字段缺失就补，绝不丢消息。
  return {
    version: loaded.version ?? HISTORY_VERSION,
    promptVersion: loaded.promptVersion ?? "",
    createdAt: loaded.createdAt ?? new Date().toISOString(),
    messages: loaded.messages.filter((m) => m && typeof m === "object")
  };
}
