/**
 * AI 层 · 编排器（把 session / router / prefix / stream / tools / usage / compact 串起来）。
 *
 * 一次 aiChat 的完整流程：
 *   1. 本地零 token 路由选 flash/pro（不联网）；
 *   2. 检查上下文是否超 70% 窗口 → 需要就压缩（有 key 走 LLM 摘要，没 key 走结构化裁剪）；
 *   3. 拼请求：**稳定前缀**（system 常量块）+ 已有摘要 + 历史 + 最后一条带易变上下文的用户消息；
 *   4. 流式调用，delta / tool / usage 通过回调推给渲染进程；
 *   5. 模型要工具就执行（结果 > 600 字符剪枝 + toolCache 复用），把结果喂回去再流一轮（最多 3 轮）；
 *   6. 落盘（无损）+ 汇总 usage + 发 done（带 cacheHitRate / savedUsdApprox）。
 *
 * 这里不 import electron：事件通过注入的 sendEvent 发送，单测里可以注入假发送器。
 */

import { completeChat, streamChat } from "./stream.mjs";
import { compactSession, shouldCompact, summaryInstructions } from "./compact.mjs";
import { buildSystemPrompt, PROMPT_VERSION } from "./prefix.mjs";
import { routeModel } from "./router.mjs";
import { createMockStream, resolveProvider } from "./provider.mjs";
import { describeToolResult, pruneToolResult } from "./prune.mjs";
import { emptyUsage, estimateSavings, mergeUsage } from "./usage.mjs";
import { makeMessage, messageText } from "./session.mjs";
import { createToolRunner } from "./tools.mjs";

/** 工具轮数上限：防止模型自问自答把一轮对话刷成十几次调用。 */
const MAX_TOOL_ROUNDS = 3;

/**
 * @param {object} opts
 * @param {import("./session.mjs").Session} opts.session       当前会话（openSession 的产物）
 * @param {(ev:object)=>void} opts.sendEvent                  推给渲染进程（ai:event）
 * @param {()=>Promise<object>} opts.getSettings              读设置（含 apiKey）
 * @param {(settings:object)=>Promise<object>} [opts.accessToken] 高级用法：注入 Authorization 头
 * @param {string} opts.repoRoot
 * @param {string} [opts.workspaceRoot]
 * @param {(o?:object)=>Promise<string>} [opts.sceneDigest]    渲染侧提供的工程摘要
 * @param {import("./apiIndex.mjs").createApiIndex} opts.apiIndex
 * @param {{put:(t:string,m?:object)=>Promise<string>, get:(s:string)=>Promise<string|null>}} [opts.toolCache]
 * @param {(msg:string)=>void} [opts.log]
 */
export function createAiBridge(opts) {
  const { session, sendEvent } = opts;
  const log = opts.log ?? (() => {});
  const toolRunner = createToolRunner({
    repoRoot: opts.repoRoot,
    workspaceRoot: opts.workspaceRoot,
    sceneDigest: opts.sceneDigest,
    apiIndex: opts.apiIndex
  });
  const running = new Map(); // requestId → { abort: AbortController, cancelled:boolean }
  let lastUsage = emptyUsage();
  let sessionUsage = emptyUsage("session-total");

  function emit(ev) {
    try {
      sendEvent(ev);
    } catch (e) {
      log(`推送 AI 事件失败：${e?.message || e}`);
    }
  }

  async function readSettings() {
    const s = await opts.getSettings();
    return s ?? {};
  }

  /** 当前状态：provider / 是否 ready / 模型名 / 累计用量。 */
  async function aiStatus() {
    const settings = await readSettings();
    const ai = settings.ai ?? {};
    const resolved = resolveProvider(ai, "flash");
    const ready = Boolean(resolved.ready);
    const activeProvider = ready ? resolved.provider : "mock";
    return {
      provider: activeProvider,
      ready,
      mode: "desktop",
      message: ready
        ? `${activeProvider} 已就绪 · flash=${resolved.modelFlash} / pro=${resolved.modelPro}`
        : `${resolved.reason}。填了 Key 之后这里会切到真模型，界面不用改。`,
      models: { flash: resolved.modelFlash, pro: resolved.modelPro },
      usage: {
        cacheHitRate: estimateSavings(sessionUsage, activeProvider).cacheHitRate,
        inputTokens: sessionUsage.inputTokens,
        cacheReadTokens: sessionUsage.cacheReadTokens,
        outputTokens: sessionUsage.outputTokens
      },
      storage: { dir: session.dir, promptVersion: PROMPT_VERSION, messages: session.messages().length },
      insecure: Boolean(settings.insecure)
    };
  }

  /**
   * 拼出这次要发给模型的 messages。
   *
   * 顺序严格固定（前缀缓存全靠它）：
   *   [0] system 常量块
   *   [1] 已有摘要（如果有，作为 system 之后的 user 块）
   *   [2..] 历史（无损历史里除 system 之外的全部）
   *   [末] 本轮用户消息 + 易变上下文（工程摘要 / 诊断 / 当前脚本）
   */
  function buildMessages(request) {
    const out = [{ role: "system", content: session.systemText() || buildSystemPrompt() }];
    const summary = String(session.summary?.text ?? "").trim();
    if (summary) {
      out.push({ role: "user", content: `【此前对话摘要（本轮之前已压缩）】\n${summary}` });
      out.push({ role: "assistant", content: "（已读取摘要，继续。）" });
    }

    // 历史：只取最近若干条，再往前的已进摘要（避免摘要 + 全文重复计入）。
    const history = session.messages();
    const recent = history.slice(-20);
    for (const m of recent) {
      const text = messageText(m);
      if (m.role === "assistant") {
        out.push({ role: "assistant", content: text || "（无文本输出）" });
        continue;
      }
      out.push({ role: "user", content: text });
    }

    // 本轮新增的用户消息（渲染侧发来的）+ 易变上下文，合并成**最后一条** user 消息。
    const incoming = (request?.messages ?? []).filter((m) => m?.role === "user");
    const currentText = incoming.length ? incoming.map((m) => String(m.text ?? "")).join("\n") : "";
    const ctxBlock = renderContext(request?.context);
    const lastUser = [ctxBlock, currentText].filter(Boolean).join("\n\n");
    if (lastUser.trim()) out.push({ role: "user", content: lastUser });
    return out;
  }

  /** 易变上下文放在最后一条 user 消息里 —— 不能进 system 块，否则前缀每轮都不同。 */
  function renderContext(ctx) {
    if (!ctx) return "";
    const parts = [];
    if (ctx.sceneDigest) parts.push(`【当前工程摘要】\n${ctx.sceneDigest}`);
    if (ctx.diagnostics && Number(ctx.diagnostics.errors ?? 0) > 0) {
      parts.push(
        `【脚本错误】${ctx.diagnostics.errors} 条`
          + (ctx.diagnostics.firstError ? `\n第一条：${ctx.diagnostics.firstError}` : "")
      );
    }
    if (ctx.activeScript?.name) {
      const code = String(ctx.activeScript.code ?? "");
      parts.push(
        `【当前脚本 ${ctx.activeScript.name}（${ctx.activeScript.lang === "yarn" ? "Yarn" : "JS"}）】\n`
          + "```\n" + code + "\n```"
      );
    }
    if (ctx.selection?.count) {
      parts.push(`【选中】${ctx.selection.count} 个（${(ctx.selection.kinds ?? []).join("、")}）`);
    }
    return parts.join("\n\n");
  }

  /** 压缩（有 key 用 LLM 摘要，没 key 用结构化裁剪）。 */
  async function maybeCompact(resolved, settings) {
    const ai = settings.ai ?? {};
    const contextWindow = Number(ai.contextWindow) || 128000;
    const all = session.messages();
    const check = shouldCompact({ messages: all, summaryText: session.summary?.text ?? "", contextWindow });
    if (!check.should) return null;
    const summarize = resolved.ready && resolved.provider !== "mock"
      ? async (oldText, prevSummary) => {
          const r = await completeChat({
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
            model: resolved.modelFlash,
            messages: [
              { role: "system", content: summaryInstructions() },
              {
                role: "user",
                content:
                  (prevSummary ? `【已有摘要】\n${prevSummary}\n\n【更早的对话】\n` : "")
                  + oldText
              }
            ],
            maxTokens: 900
          });
          return r.text || null;
        }
      : null;
    const result = await compactSession({
      session,
      contextWindow,
      summarize,
      existingSummary: session.summary?.text ?? ""
    });
    log(
      `上下文压缩（${result.mode}）：${result.before} → ${result.after} token，保留 ${result.keptMessages} 条，移走 ${result.removedMessages} 条`
    );
    if (result.usage) sessionUsage = mergeUsage(sessionUsage, result.usage);
    return result;
  }

  /** 执行工具调用：剪枝 + 缓存 + 回填。 */
  async function runTools(requestId, calls) {
    const results = [];
    for (const call of calls) {
      const arg = toolRunner.describeArg(call);
      emit({ type: "tool", requestId, name: call.name, detail: `调用 ${call.name}(${arg})` });
      const out = await toolRunner.run(call);
      const raw = String(out.text ?? out.error ?? "");
      const prune = pruneToolResult(raw, { meta: out.meta ?? {} });
      if (opts.toolCache) {
        try {
          await opts.toolCache.put(raw, { tool: call.name, arg, at: new Date().toISOString() });
        } catch (e) {
          log(`toolCache 写失败（不影响对话）：${e?.message || e}`);
        }
      }
      emit({
        type: "tool",
        requestId,
        name: call.name,
        detail: describeToolResult(call.name, arg, prune, false)
      });
      results.push({ call, prune, out });
    }
    return results;
  }

  /**
   * 主入口：立刻返回 requestId，流在后台跑。
   * @param {object} request AiChatRequest（契约 §4.1）
   */
  async function aiChat(request) {
    const requestId = String(request?.requestId ?? `req_${Date.now().toString(36)}`);
    const controller = new AbortController();
    running.set(requestId, { abort: controller, cancelled: false });

    // 不 await：立即返回，让渲染侧尽早订阅事件。
    void run(requestId, request, controller).catch((e) => {
      emit({ type: "error", requestId, message: e?.message || String(e), recoverable: true });
    }).finally(() => {
      running.delete(requestId);
    });
    return { requestId };
  }

  async function run(requestId, request, controller) {
    const settings = await readSettings();
    const ai = settings.ai ?? {};
    // ---- 1. 本地路由（零 token、零网络）----
    const route = routeModel(request, { autoRoute: ai.autoRoute !== false, manualModel: ai.manualModel || "" });
    emit({ type: "route", requestId, model: route.model, reason: route.reason, localOnly: true });

    const resolved = resolveProvider(ai, route.model);

    // ---- 2. 压缩（如需要）----
    await maybeCompact(resolved, settings);

    // ---- 3. 拼 messages ----
    const messages = buildMessages(request);
    const intentSystem = intentHint(request?.intent);
    if (intentSystem) messages[0] = { role: "system", content: `${messages[0].content}\n\n${intentSystem}` };
    // 注意：intentHint 是常量映射（没有易变内容），加在 system 尾部仍然跨轮一致。

    let finalText = "";
    let usage = emptyUsage("no-usage");
    let rounds = 0;
    const toolTrace = [];

    // ---- 4. 轮次循环（工具调用）----
    while (rounds <= MAX_TOOL_ROUNDS) {
      rounds += 1;
      if (controller.signal.aborted) {
        emit({ type: "error", requestId, message: "已取消", recoverable: true });
        return;
      }

      let result;
      if (!resolved.ready || resolved.provider === "mock") {
        // ---- mock 分支：本地模板流，事件形状与真模型完全一致 ----
        const mock = createMockStream(request);
        const onCancel = () => mock.cancel();
        controller.signal.addEventListener("abort", onCancel, { once: true });
        try {
          for await (const ev of mock.iterate()) {
            if (ev.type === "delta") {
              finalText += ev.text;
              emit({ type: "delta", requestId, text: ev.text });
              continue;
            }
            result = { text: ev.text, usage: ev.usage, toolCalls: [], status: ev.status ?? 200, error: ev.error };
          }
        } finally {
          controller.signal.removeEventListener("abort", onCancel);
        }
      } else {
        result = await streamChat({
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          model: resolved.model,
          messages,
          tools: toolRunner.definitions,
          maxTokens: Number(ai.maxTokens) || undefined,
          temperature: resolved.sampling.temperature,
          topP: resolved.sampling.topP,
          signal: controller.signal,
          headers: opts.extraHeaders?.(settings) ?? {},
          onEvent: (ev) => {
            if (ev.type === "delta") {
              finalText += ev.text;
              emit({ type: "delta", requestId, text: ev.text });
            } else if (ev.type === "reasoning") {
              emit({ type: "delta", requestId, text: "" }); // 思考过程不显示，只保持心跳
            } else if (ev.type === "usage") {
              emit({ type: "usage", requestId, usage: ev.usage });
            }
          }
        });
      }

      usage = mergeUsage(usage, result?.usage ?? emptyUsage("missing-usage"));
      if (result?.error) {
        const recoverable = !controller.signal.aborted;
        emit({
          type: "error",
          requestId,
          message: result.error,
          recoverable
        });
        if (!recoverable) return;
        // 网络/HTTP 错误：不再重试工具循环，直接结束（把错误亮给用户）。
        break;
      }

      // ---- 工具调用 ----
      if (result.toolCalls?.length) {
        emit({ type: "usage", requestId, usage });
        const executed = await runTools(requestId, result.toolCalls);
        for (const { call, prune, out } of executed) {
          toolTrace.push({ name: call.name, arg: toolRunner.describeArg(call), pruned: prune.pruned });
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
              }
            ]
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: out.error ? `工具失败：${out.error}` : prune.text
          });
        }
        // 工具结果落到会话历史（无损：原文在 toolCache，预览在 blocks）
        await session.append(
          makeMessage("assistant", "", {
            blocks: executed.map(({ call, prune, out }) => ({
              type: "tool-result",
              name: call.name,
              arguments: call.arguments,
              preview: prune.text,
              fullSha1: prune.fullSha1,
              pruned: prune.pruned,
              error: out.error ?? null
            }))
          })
        );
        continue; // 再流一轮，让模型基于工具结果作答
      }
      break;
    }

    if (controller.signal.aborted) {
      // 取消也要记账：已产生的 token 是真花钱的，不能装作 0。
      usage = { ...usage, reason: "aborted" };
    }

    // ---- 5. 落盘（无损）----
    const incoming = (request?.messages ?? []).filter((m) => m?.role === "user");
    for (const m of incoming) {
      await session.append(makeMessage("user", m.text));
    }
    if (finalText) {
      await session.append(
        makeMessage("assistant", finalText, { model: resolved.model, usage: usage })
      );
    }
    lastUsage = usage;
    sessionUsage = mergeUsage(sessionUsage, usage);
    await session.setSummary({ usage: sessionUsage });

    // ---- 6. done ----
    const savings = estimateSavings(usage, resolved.provider === "mock" ? "deepseek" : resolved.provider);
    emit({
      type: "done",
      requestId,
      text: finalText,
      usage: {
        inputTokens: usage.inputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
        ...(usage.reason ? { reason: usage.reason } : {})
      },
      cacheHitRate: savings.cacheHitRate,
      savedUsdApprox: savings.savedUsdApprox,
      extra: {
        provider: resolved.ready ? resolved.provider : "mock",
        model: resolved.model,
        routeReason: route.reason,
        rounds,
        toolCalls: toolTrace,
        promptVersion: PROMPT_VERSION
      }
    });
  }

  function aiCancel(requestId) {
    const entry = running.get(String(requestId));
    if (!entry) return { ok: true, cancelled: false };
    entry.cancelled = true;
    try {
      entry.abort.abort();
    } catch {
      // ignore
    }
    return { ok: true, cancelled: true };
  }

  async function aiReset() {
    for (const [id, entry] of running) {
      entry.abort.abort();
      running.delete(id);
    }
    await session.reset();
    sessionUsage = emptyUsage("session-total");
    return { ok: true };
  }

  return {
    aiStatus,
    aiChat,
    aiCancel,
    aiReset,
    buildMessages, // 单测/调试用
    get sessionUsage() {
      return sessionUsage;
    },
    get lastUsage() {
      return lastUsage;
    }
  };
}

/** 意图 → 一段固定的补充指令（常量，不含易变内容）。 */
function intentHint(intent) {
  if (intent === "explain-error") {
    return "【本轮意图：解释错误】先定位是哪一行、为什么错，再给最小修改；不要重写整段脚本。";
  }
  if (intent === "edit-script") {
    return "【本轮意图：改脚本】只输出需要替换的那几行（带行号），说明改完的预期效果。";
  }
  if (intent === "scene-review") {
    return "【本轮意图：审场景】按「碰撞覆盖 / 图层排序 / 每帧开销」三条检查，给出可执行的修改建议。";
  }
  return "";
}
