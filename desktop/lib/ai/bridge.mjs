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
import { createMockStream, listModels, resolveProvider } from "./provider.mjs";
import { describeToolResult, pruneToolResult } from "./prune.mjs";
import { emptyUsage, estimateSavings, mergeUsage } from "./usage.mjs";
import { makeMessage, messageText } from "./session.mjs";
import { createToolRunner } from "./tools.mjs";

/** 工具轮数上限：防止模型自问自答把一轮对话刷成十几次调用。 */
const MAX_TOOL_ROUNDS = 3;

/**
 * 把模型服务的原始错误报文映射成用户能看懂的话。
 *
 * 为什么需要：服务端 400 返回的是一整段 JSON（用户截图里就是），
 * 直接显示在对话区毫无帮助 —— 用户只会以为软件坏了，而实际上多半是
 * 「该模型服务对消息格式有额外要求」这类可解释的问题。
 *
 * ⚠ 这只是**展示层兜底**。根因（协议违规）必须在代码里真修好，
 *   否则用户每轮都会看到这条提示 —— 提示本身不能替代修复。
 *
 * @param {string} raw   服务端原始错误文本
 * @param {number} status HTTP 状态码（可能为 0，表示网络错误）
 */
function humanizeApiError(raw, status) {
  const text = String(raw ?? "");
  const code = Number(status) || 0;

  // 思考模式的 reasoning_content 必须回传（DeepSeek / Kimi 等）
  if (/reasoning_content/i.test(text)) {
    return "该模型是「思考模式」，要求把上一轮的推理内容原样回传。"
      + "这通常是软件侧的历史拼装问题（已尝试修复）；若仍出现，请把这条对话新建后重试。\n"
      + `（服务端原文：${text.slice(0, 300)}）`;
  }

  // 工具调用格式不兼容
  if (/tool_calls|tool_call_id|tool role|function_call/i.test(text)) {
    return "工具调用格式与该模型服务不兼容（assistant 的 tool_calls 与 tool 响应必须成对）。"
      + "可先关闭工具/改用不带工具的问答，或换一个模型。\n"
      + `（服务端原文：${text.slice(0, 300)}）`;
  }

  // 其他 400：把服务端 message 抠出来，别让用户读整段 JSON
  if (code === 400 || code === 422) {
    let serverMsg = "";
    try {
      const parsed = JSON.parse(text.replace(/^模型接口返回 \d+：/, ""));
      serverMsg = String(parsed?.error?.message ?? parsed?.message ?? "");
    } catch {
      serverMsg = "";
    }
    return `请求被服务端拒绝（${code}）：${serverMsg || text.slice(0, 300)}`;
  }

  if (code === 401 || code === 403) {
    return `API Key 无效或没有权限（${code}）。请到「设置 → AI」检查 key，或换一个模型。\n`
      + `（服务端原文：${text.slice(0, 200)}）`;
  }
  if (code === 429) {
    return "请求太频繁或额度用尽（429）。稍等一会儿再试，或检查账户额度。";
  }
  if (code >= 500) {
    return `模型服务端出错（${code}）。这不是你的问题，稍后重试即可。\n（服务端原文：${text.slice(0, 200)}）`;
  }

  return text;
}

/**
 * 同一工具**连续**失败多少次后停止重试。
 *
 * 为什么必须有上限：模型不会自己意识到「这个工具坏了」，它会一直重试同一条路径，
 * 最终耗尽工具轮次、一句正文都没产出 —— 用户看到的就是「AI 说半句就消失」。
 * 取 2：偶发失败重试一次是合理的；连续两次失败基本可以判定这条路径有问题。
 */
const TOOL_FAILURE_LIMIT = 2;

/**
 * 首字超时兜底（毫秒）：超过这个时间既没 reasoning 也没正文，就提示「可能网络慢/排队中」。
 * 8 秒的依据：推理模型首字常在 2~5 秒；8 秒还没动静基本可以确认「慢得值得提示」，
 * 但又不会短到把正常的慢模型误报成问题。
 */
const SLOW_FIRST_TOKEN_MS = 8000;

/**
 * mock 分支的「思考」停顿（毫秒）。
 * 为什么**只给 mock**：真模型的首字延迟是真实存在的，人为再加延迟只会让体验变差；
 * 而 mock 是本地即时生成，加这段是为了让 UI 的思考提示在无 key 环境下也能演示、能截图。
 */
const MOCK_THINKING_MS = 500;

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
  const { sendEvent } = opts;
  /**
   * 当前会话对象（**可变引用**）。
   *
   * 为什么不用 `const { session } = opts`：多会话功能要求「切会话后桥继续用新会话写历史」。
   * 如果是闭包常量，切会话就必须销毁整个 bridge 并重建（会丢掉 running 表、累计用量、
   * 工具缓存等状态，且正在进行的请求无人管）；改成可变引用后只需换一个指针。
   *
   * ⚠ 但**切换前必须先 abort 所有在跑的请求**（见 abortAll）：否则旧请求的 deltas
   * 会被写进新会话的 history —— 那是数据损坏，不是显示问题。
   */
  let session = opts.session;
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

  /**
   * 中止所有正在跑的请求。
   *
   * 用途：切会话 / 删会话前必须先调用 —— 否则在途请求收尾时会把消息 append 到
   * **新会话**的 history（数据写错地方比显示错更严重）。
   * 返回被中止的数量。
   */
  function abortAll() {
    const ids = [...running.keys()];
    for (const [id, entry] of running) {
      entry.cancelled = true;
      try {
        entry.abort.abort();
      } catch {
        // 已结束的 controller abort 会抛，忽略
      }
      // ⚠ 这里**不删 running**：删了 settled promise 就丢了，
      // swapSession 无法等待「旧请求真的结束」。让 run() 的 finally 自己删（那才是权威时刻）。
    }
    return ids.length;
  }

  /**
   * 等待所有在途请求真正结束（落盘 / emit 都已完成）。
   *
   * 与 abortAll 的区别：abortAll 只是「发出取消信号」，本函数才保证「已经停下来」。
   * 切/删会话必须在 abortAll 之后 await 它 —— 否则旧请求的收尾写盘可能发生在换绑之后。
   *
   * @returns {Promise<{waited:number}>}
   */
  async function whenIdle() {
    const pending = [...running.values()].map((e) => e.settled).filter(Boolean);
    if (pending.length === 0) return { waited: 0 };
    await Promise.allSettled(pending);
    return { waited: pending.length };
  }

  /**
   * 换绑会话（切/新建/删除后用）。
   *
   * @param {object} nextSession  openSession 的产物
   * @returns {{aborted:number}}  被中止的在途请求数（供 UI 提示「上一个回答已中断」）
   */
  async function swapSession(nextSession) {
    const aborted = abortAll();
    // 等旧请求**真正结束**再换绑（确定性语义，见 whenIdle 注释）。
    // 只 abort 不等待的话，旧请求的收尾落盘可能发生在换绑之后 ——
    // 这正是「切到 B 会话，A 的回复写进 B 的 history」的成因。
    const { waited } = await whenIdle();
    session = nextSession;
    // 累计用量跟随会话切换：先归零，下一轮从新会话重新统计
    // （否则「本会话省了多少」会把上一个会话的量也算进来）
    sessionUsage = emptyUsage("session-total");
    return { aborted, waited };
  }

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

  /** 当前状态：provider / 是否 ready / 模型清单 / 当前活动模型 / 累计用量。 */
  async function aiStatus() {
    const settings = await readSettings();
    // 会话信息由外部注入（conversations 存储拥有会话列表，桥只认当前会话对象）
    let sessionInfo = null;
    try {
      sessionInfo = (await opts.getSessionInfo?.()) ?? null;
    } catch {
      sessionInfo = null; // 取不到会话信息不该让整个状态接口失败
    }
    const ai = settings.ai ?? {};
    const listed = listModels(ai, "");
    const activeEntry = listed.models.find((m) => m.id === listed.active) ?? null;
    // 解析「真正会发给谁」：有 activeModelId 就按 id 解析，否则回落两槽语义（向后兼容）。
    const resolved = listed.active ? resolveProvider(ai, listed.active) : resolveProvider(ai, "flash");
    const ready = Boolean(resolved.ready);
    // 未就绪时 provider 显示 mock（实际会走 mock 分支），但把期望的 provider 也带出来，
    // 界面才能显示「想用 siliconflow，但缺 key」这类可操作的信息。
    const activeProvider = ready ? resolved.provider : "mock";
    return {
      provider: activeProvider,
      // 期望用但还没就绪的供应商（界面据此提示「去填 key」）；已就绪时与 provider 相同。
      intendedProvider: resolved.provider,
      ready,
      mode: "desktop",
      message: ready
        ? `${resolved.label || activeProvider}（${resolved.provider}）已就绪`
          + ` · 模型 ${resolved.model}`
        : `${resolved.reason}。填了 Key 之后这里会切到真模型，界面不用改。`,
      // 旧的两槽字段保留（面板可能还在读 flash/pro）
      models: { flash: resolved.modelFlash, pro: resolved.modelPro },
      // 新：当前活动模型 id + 完整清单，面板据此渲染下拉框
      activeModelId: listed.active,
      activeModel: activeEntry
        ? {
            id: activeEntry.id,
            label: activeEntry.label,
            provider: activeEntry.provider,
            model: activeEntry.model,
            ready: activeEntry.ready,
            needsKey: activeEntry.needsKey
          }
        : null,
      modelList: listed.models,
      usage: {
        cacheHitRate: estimateSavings(sessionUsage, activeProvider).cacheHitRate,
        inputTokens: sessionUsage.inputTokens,
        cacheReadTokens: sessionUsage.cacheReadTokens,
        outputTokens: sessionUsage.outputTokens
      },
      storage: { dir: session.dir, promptVersion: PROMPT_VERSION, messages: session.messages().length },
      // 多会话信息：activeSession 是当前会话 id，sessionCount 是会话总数。
      // 由注入的 getSessionInfo 提供 —— 会话列表归 conversations 存储管，
      // 桥只持有「当前会话对象」，不该自己去读索引（职责单一，也避免桥依赖存储实现）。
      activeSession: String(sessionInfo?.active ?? ""),
      sessionCount: Number(sessionInfo?.count ?? 0),
      insecure: Boolean(settings.insecure),
      /**
       * key 密文解不开（不是「没填」）。UI 必须能区分这两种状态：
       *   needsKeyMissing  → 「需要填 API Key」
       *   keyUndecryptable → 「Key 已失效，请重新粘贴」（并提供一键跳转填 key 的入口）
       * 若按「没填」处理，用户明明填过却看到「待填」，完全不知道该做什么。
       */
      keyUndecryptable: Boolean(settings.keyUndecryptable),
      keyUndecryptableEntries: Array.isArray(settings.keyUndecryptableEntries)
        ? settings.keyUndecryptableEntries
        : [],
      /**
       * 解不开的 key 条目**数量**（供 UI 批量提示条用）。
       *
       * ⚠ 它与 `keyUndecryptableEntries.length` 是**两个统计源**，必须恒等 ——
       * 这是刻意的冗余，用来互相校验（契约里写了这条恒等式）。
       * 一旦漂移，用户会看到「红条说 1 个，点进去却是 2 个」。
       * 所以这里**由 entries 派生**，不是另算一遍（另算就迟早漂）。
       */
      keyUndecryptableCount: Array.isArray(settings.keyUndecryptableEntries)
        ? settings.keyUndecryptableEntries.length
        : 0,
      /** 上次保存因加密不可用而降级成明文：UI 应明确告知「当前 key 未加密存储」。 */
      keyPlaintextFallback: Boolean(settings.keyPlaintextFallback)
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
    //
    // ⚠ 重放历史时有**协议约束**，写错会让下一轮对话直接 400：
    //   历史里带 `tool-result` 块的 assistant 轮，必须还原成
    //   「一条 assistant（带 tool_calls + reasoning_content）+ N 条 tool 消息」，
    //   不能压成一条纯文本 assistant —— 那样协议里出现了「无主的 tool 响应」，
    //   服务端会认为 tool_calls 与 tool 响应对不上（DeepSeek 直接 400）。
    //   同时 reasoning_content 也必须带回：思考模式下缺它同样 400。
    const history = session.messages();
    const recent = history.slice(-20);
    for (const m of recent) {
      // 每条消息的纯文本都在这里取一次。
      // ⚠ 我第一版重构时把它挪进了 assistant 分支，导致第 277 行 user 分支引用未定义变量
      //   （报 "text is not defined"）—— 而这条路径只在"历史里有 assistant 轮"时触发，
      //   也就是**多轮对话的第二轮**。单轮测试全绿，多轮直接炸。教训：重构时先搜变量引用范围。
      const text = messageText(m);
      if (m.role === "assistant") {
        const toolBlocks = (m.blocks ?? []).filter((b) => b?.type === "tool-result");
        if (toolBlocks.length > 0) {
          // 还原成：assistant(tool_calls) + 每条 tool 结果
          const callIds = toolBlocks.map((b, i) => `hist_${m.id}_${i}`);
          const assistantTurn = {
            role: "assistant",
            content: text || null,
            tool_calls: toolBlocks.map((b, i) => ({
              id: callIds[i],
              type: "function",
              function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.arguments ?? {}) }
            }))
          };
          // 只在非空时加（空字符串会被某些实现当作"传了空 reasoning"）
          if (m.reasoning && String(m.reasoning).length > 0) {
            assistantTurn.reasoning_content = String(m.reasoning);
          }
          out.push(assistantTurn);
          for (const [i, b] of toolBlocks.entries()) {
            out.push({
              role: "tool",
              tool_call_id: callIds[i],
              content: b.error ? `工具失败：${b.error}` : String(b.preview ?? "")
            });
          }
          continue;
        }
        const assistantTurn = { role: "assistant", content: text || "（无文本输出）" };
        // 历史里的普通 assistant 轮也可能带 reasoning（思考模式要求回传）
        if (m.reasoning && String(m.reasoning).length > 0) {
          assistantTurn.reasoning_content = String(m.reasoning);
        }
        out.push(assistantTurn);
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

  /**
   * **轮次耗尽兜底**：工具轮用完、模型还没产出正文时，逼它基于已有信息作答。
   *
   * 为什么必须有：模型可能连续 N 轮都在调工具（尤其是工具一直失败时）。
   * 如果循环耗尽后直接 done，finalText 是空字符串 ——
   * 用户看到的是「AI 说半句就消失」，这是本次线上问题的直接成因。
   *
   * 做法：**不带 tools** 再请求一次（模型没有工具可调，只能输出文字），
   * 并明确要求它基于已有结果作答；若确实缺信息就说明缺什么。
   */
  async function finalAnswerFallback({ resolved, settings, messages, requestId, controller, ai }) {
    const nudge = {
      role: "user",
      content: "工具调用次数已到上限，**请不要再请求工具**。"
        + "请基于上面已经拿到的信息直接给出结论或下一步具体动作；"
        + "如果信息确实不足，请明确说明缺什么、以及用户可以怎么做。"
    };
    const outMessages = [...messages, nudge];
    let text = "";
    let usageOut = null;
    try {
      const result = await streamChat({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        model: resolved.model,
        messages: outMessages,
        // ⚠ 关键：不传 tools。模型没有工具可调，只能产出正文。
        tools: undefined,
        maxTokens: Number(ai.maxTokens) || undefined,
        temperature: resolved.sampling.temperature,
        topP: resolved.sampling.topP,
        signal: controller.signal,
        headers: opts.extraHeaders?.(settings) ?? {},
        onEvent: (ev) => {
          if (ev.type === "delta") {
            text += ev.text;
            emit({ type: "delta", requestId, text: ev.text });
          } else if (ev.type === "usage") {
            usageOut = ev.usage;
            emit({ type: "usage", requestId, usage: ev.usage });
          }
        }
      });
      if (result?.error) log(`兜底作答失败（不再重试）：${result.error}`);
      if (result?.usage) usageOut = result.usage;
    } catch (e) {
      log(`兜底作答异常（不再重试）：${e?.message || e}`);
    }
    return { text, usage: usageOut };
  }

  /**
   * 执行工具调用：剪枝 + 缓存 + 回填。
   *
   * @param {(name:string)=>number} failureStreakOf  取某工具当前连续失败次数
   * @param {(name:string,success:boolean)=>void} noteToolResult 记录本次成败（成功清零）
   */
  async function runTools(requestId, calls, failureStreakOf, noteToolResult) {
    const results = [];

    /**
     * 为一次工具调用生成稳定的 callId。
     *
     * 为什么必须按 id 配对而不是按 name：用户实际遇到过一次对话里**两次同名工具**（SceneDigest）。
     * 按 name 配对会让第一次的 start 配到第二次的 end —— 耗时算错、成败也可能串。
     * 模型返回的 tool_call id 天然唯一；没有就现生成一个。
     */
    const callIdOf = (call, index) => String(call?.id ?? call?.tool_call_id ?? "") || `c_${requestId}_${index}_${Date.now().toString(36)}`;

    let index = 0;
    for (const call of calls) {
      const arg = toolRunner.describeArg(call);
      const callId = callIdOf(call, index);
      index += 1;

      // 若该工具已连续失败到上限，**不再真的执行**：直接把「不可用」告知模型。
      // 为什么由我们判断：模型不会自己意识到"这个工具坏了"，它会一直重试同一条路径，
      // 最终耗尽轮次、一句正文都没产出（用户看到的就是"AI 说半句就消失"）。
      const streak = failureStreakOf(call.name);
      if (streak >= TOOL_FAILURE_LIMIT) {
        const stopText = `工具 ${call.name} 已连续失败 ${streak} 次，判定为当前不可用。`
          + "请**不要再调用它**，基于已有信息直接作答；如果确实缺少信息，请说明缺什么。";
        emit({ type: "tool", requestId, callId, name: call.name, phase: "end", detail: stopText, ok: false, error: stopText, ms: 0 });
        results.push({
          call,
          prune: { text: stopText, pruned: false, meta: { skipped: true } },
          out: { error: stopText, text: stopText, meta: { tool: call.name, skipped: true } }
        });
        continue;
      }

      emit({ type: "tool", requestId, callId, name: call.name, phase: "start", detail: `调用 ${call.name}(${arg})` });

      const t0 = Date.now();
      const out = await toolRunner.run(call);
      const ms = Date.now() - t0;
      const ok = !out?.error;
      noteToolResult(call.name, ok);

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
        callId,
        name: call.name,
        phase: "end",
        detail: describeToolResult(call.name, arg, prune, false),
        ok,
        // ⚠ 完整错误原文，**不经过剪枝**：错误信息通常很短，剪枝反而把根因削掉。
        error: ok ? "" : String(out.error ?? ""),
        ms
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

    // 每个请求持一个 **settled promise**，在 run() 最外层 finally 里 resolve。
    //
    // 为什么需要它：AbortController.abort() 只是「发出信号」—— 被 abort 的 Promise 在
    // 下一个微任务才 reject，而 run() 的收尾（落盘 / emit done / running.delete）更晚。
    // 所以「发出 abort」与「旧请求真的不会再写盘」之间有一个窗口，
    // 任何基于 sleep 的等待都只能降低概率、不能消除。持有这个 promise 才能做到确定性。
    let markSettled = () => {};
    const settled = new Promise((r) => {
      markSettled = r;
    });
    running.set(requestId, { abort: controller, cancelled: false, settled });

    // 不 await：立即返回，让渲染侧尽早订阅事件。
    void run(requestId, request, controller)
      .catch((e) => {
        emit({ type: "error", requestId, message: e?.message || String(e), recoverable: true });
      })
      .finally(() => {
        running.delete(requestId);
        markSettled();
      });
    return { requestId };
  }

  async function run(requestId, request, controller) {
    /**
     * ⚠ **绑定发起时的会话**（本功能最重要的一行）。
     *
     * 为什么：落盘（第 5 步）写的是模块级可变 `session`。如果在请求进行中切换会话，
     * 这个变量已经指向**新会话** —— 旧请求收尾时会把 A 的内容写进 B 的 history。
     * 那是数据错乱（且不报错），比显示错严重得多。
     * 修法：请求一开始就捕获当时的会话对象，落盘只写它，与后续切换无关。
     *
     * 顺带的好处：「取消也要记账」这条语义也保住了 —— 被取消的请求仍把已产生的
     * token 记回它自己的会话，而不是丢进当前会话。
     */
    const targetSession = session;
    const settings = await readSettings();
    const ai = settings.ai ?? {};
    // ---- 1. 本地路由（零 token、零网络）----
    const route = routeModel(request, { autoRoute: ai.autoRoute !== false, manualModel: ai.manualModel || "" });

    // 用户在下拉框里显式选了一个模型（activeModelId）→ 就用它，不再走 flash/pro 两槽。
    // autoRoute 的语义是「没有手动指定时按复杂度选」，所以手动指定必须优先，
    // 否则用户选了 Kimi 却在回答里看到 DeepSeek 的输出，会以为切换功能没生效。
    const activeId = String(ai.activeModelId || "").trim();
    const useActive = activeId && listModels(ai, activeId).models.some((m) => m.id === activeId);
    const resolved = useActive ? resolveProvider(ai, activeId) : resolveProvider(ai, route.model);
    emit({
      type: "route",
      requestId,
      model: route.model,
      reason: useActive
        ? `已指定模型「${resolved.label || activeId}」(${resolved.provider})`
        : route.reason,
      localOnly: true
    });

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

    // ---- 工具数据源注入（每次请求）----
    //
    // 历史缺陷：toolRunner 在 createAiBridge 时创建一次，闭包了构造时的 opts.sceneDigest；
    // 而 app-main 从未传该选项 → SceneDigest 每次必抛错 → 模型反复重试同一条坏路径 →
    // 轮次耗尽 → 静默结束（用户看到「AI 说半句就消失」）。
    //
    // 正确数据源是 **request.context.sceneDigest**（渲染侧每次都传当前工程摘要）。
    // 每次 run() 注入一次，工程切换/多会话下都不会用到过期数据。
    toolRunner.setSceneDigest?.(request?.context?.sceneDigest ?? null);

    /**
     * 同一工具**连续**失败次数（成功一次即清零）。
     * 达到 TOOL_FAILURE_LIMIT 后停止重试，并在工具结果里明确告知模型「该工具不可用」。
     * 为什么必须由我们判断：模型不会自己意识到"这个工具坏了"，它会一直重试同一条路径。
     */
    const toolFailureStreak = new Map();

    // ---- 3.5 「思考中」状态机 ----
    //
    // 为什么需要它：推理模型（DeepSeek reasoner 等）首字延迟常 2~5 秒，
    // 这期间原来只发一个空 delta 做心跳 —— UI 收到空文本什么也显示不出来，用户以为卡死。
    // 现在改成一个**有语义的阶段事件流**：
    //   connecting  已经开始请求，但还没有任何返回（网络/排队中）
    //   reasoning   模型在思考，还没有可显示正文（带累计字符数，UI 可显示「已思考 N 字」）
    //   answering   已有正文在流（只发一次，而不是每个 delta 都发）
    //   slow        8 秒内没有任何返回的兜底提示（网络慢或模型排队）
    //
    // ⚠ 三个实现要点（都容易做错）：
    //   1. `answering` 只发一次 —— 每个 delta 都发会让 UI 每秒刷新几十次；
    //   2. reasoning 只带**增量**（delta）与累计 chars，绝不把全量 reasoning 塞进事件流
    //      （那会和正文混在一起，且 token 成本高；「展开看思考过程」应由 UI 自己累积 delta）；
    //   3. 8 秒兜底只在**首个** reasoning/delta 之前触发一次，且要能取消
    //      （否则慢请求会一直往 UI 推 slow）。
    let thinkingPhase = "connecting";
    let reasoningChars = 0;
    let sawAnyOutput = false;
    let slowTimer = null;

    /**
     * 发 thinking 事件。
     *
     * ⚠ 只允许契约声明的四个 phase 与两个可选字段（chars / delta）：
     *   connecting | reasoning | answering | slow
     * 多加字段（例如 mock:true、message:"…"）会让契约失真 ——
     * 调用方看到契约里没有的字段，要么忽略（白做），要么当私有约定用（下次就漂）。
     * 需要给用户看的文案由 UI 按 phase 决定，主进程不塞文案。
     */
    const emitThinking = (phase, extra = {}) => {
      const event = { type: "thinking", requestId, phase };
      // 只挑契约内的可选字段，其余一律丢弃（防止无意中扩宽契约）
      if (Number.isFinite(extra.chars)) event.chars = extra.chars;
      if (typeof extra.delta === "string") event.delta = extra.delta;
      emit(event);
    };

    /** 收到首个输出（reasoning 或 content）就清掉兜底定时器。 */
    const markOutputStarted = () => {
      sawAnyOutput = true;
      if (slowTimer) {
        clearTimeout(slowTimer);
        slowTimer = null;
      }
    };

    /**
     * 启动 8 秒兜底：期间没有任何 reasoning/delta 就发一次 thinking/slow。
     * 只在真模型分支启动 —— mock 是本地即时生成，加这个毫无意义。
     */
    const startSlowTimer = () => {
      if (slowTimer) return;
      slowTimer = setTimeout(() => {
        slowTimer = null;
        if (sawAnyOutput || controller.signal.aborted) return;
        // slow 是**正式 phase**（不是兜底附属）：UI 据此把文案升级为
        // 「还在等响应，可能网络慢或模型排队」并给出「取消」出口。
        // 文案由 UI 决定，主进程只报事实（已经 8 秒没有任何输出）。
        emitThinking("slow");
      }, SLOW_FIRST_TOKEN_MS);
    };

    const stopSlowTimer = () => {
      if (slowTimer) {
        clearTimeout(slowTimer);
        slowTimer = null;
      }
    };

    // ---- 4. 轮次循环（工具调用）----
    while (rounds <= MAX_TOOL_ROUNDS) {
      rounds += 1;
      if (controller.signal.aborted) {
        stopSlowTimer();
        emit({ type: "error", requestId, message: "已取消", recoverable: true });
        return;
      }

      let result;
      if (!resolved.ready || resolved.provider === "mock") {
        // ---- mock 分支：本地模板流，事件形状与真模型完全一致 ----
        // mock 没有真实"思考"阶段，但 UI 的思考提示要能在无 key 时演示/截图，
        // 所以**仅 mock** 加一段 500ms 的 connecting 停顿（真模型绝不加人为延迟）。
        emitThinking("connecting");
        await new Promise((r) => setTimeout(r, MOCK_THINKING_MS));
        if (controller.signal.aborted) {
          emit({ type: "error", requestId, message: "已取消", recoverable: true });
          return;
        }
        const mock = createMockStream(request);
        // mock 也没有 reasoning 阶段，直接进入 answering（保证事件序列与真模型同形）
        emitThinking("answering");
        thinkingPhase = "answering";
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
        // 发起网络之前先告诉 UI「已在连接」—— 这正是首字延迟期间 UI 需要的信号。
        if (thinkingPhase === "connecting") emitThinking("connecting");
        startSlowTimer();
        try {
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
                markOutputStarted();
                // 首个正文 delta 之前发一次 answering（**只发一次**）。
                if (thinkingPhase !== "answering") {
                  thinkingPhase = "answering";
                  emitThinking("answering");
                }
                finalText += ev.text;
                emit({ type: "delta", requestId, text: ev.text });
              } else if (ev.type === "reasoning") {
                markOutputStarted();
                reasoningChars += String(ev.text ?? "").length;
                thinkingPhase = "reasoning";
                // 只带**增量**文本与累计字符数；全量 reasoning 不进事件流（见上面注释 2）。
                emitThinking("reasoning", { chars: reasoningChars, delta: String(ev.text ?? "") });
              } else if (ev.type === "usage") {
                emit({ type: "usage", requestId, usage: ev.usage });
              }
            }
          });
        } finally {
          // 兜底清理：即使是 streamChat 抛异常/取消，也不能让 slow 定时器在进程里残留。
          stopSlowTimer();
        }
      }

      usage = mergeUsage(usage, result?.usage ?? emptyUsage("missing-usage"));
      if (result?.error) {
        const recoverable = !controller.signal.aborted;
        emit({
          type: "error",
          requestId,
          // 把服务端的原始 JSON 映射成人话（原始报文仍写在日志里，便于排查）。
          // 用户截图里那一整段 {"error":{"message":"The `reasoning_content` ..."}}
          // 直接显示在界面上毫无帮助 —— 用户只会以为软件坏了。
          message: humanizeApiError(result.error, result.status),
          recoverable
        });
        if (!recoverable) return;
        // 网络/HTTP 错误：不再重试工具循环，直接结束（把错误亮给用户）。
        break;
      }

      // ---- 工具调用 ----
      if (result.toolCalls?.length) {
        emit({ type: "usage", requestId, usage });
        const executed = await runTools(
          requestId,
          result.toolCalls,
          (name) => toolFailureStreak.get(name) ?? 0,
          (name, ok) => {
            // 成功一次即清零：只有**连续**失败才止损（偶发失败重试一次是合理的）
            if (ok) toolFailureStreak.delete(name);
            else toolFailureStreak.set(name, (toolFailureStreak.get(name) ?? 0) + 1);
          }
        );
        // ---- 回填工具结果 ----
        //
        // ⚠ 这里有两个**协议合规**要点，写错会让服务端直接 400（用户实测「跑两下就寄了」）：
        //
        // ① **一条 assistant 消息必须带该轮全部 tool_calls**。
        //    原来是把每个 call 各写成一条 assistant（N 个 call = N 条 assistant），
        //    OpenAI 兼容协议要求「一条 assistant 带 N 个 tool_calls，紧跟 N 条 tool 消息」；
        //    拆开会让服务端认为 tool_calls 与 tool 响应对不上，某些实现(含 DeepSeek)直接 400。
        //
        // ② **reasoning_content 必须原样回传**。
        //    DeepSeek/Kimi 的思考模式要求：模型这一轮产出了 reasoning_content，下一轮请求必须带回，
        //    否则第二轮必然 400（报错原文："The `reasoning_content` in the thinking mode must be passed back to the API"）。
        //    ⚠ 只在**非空**时添加：空字符串会被某些实现当作「传了空 reasoning」而不是「没有思考」。
        const assistantTurn = {
          role: "assistant",
          // 模型可能同时有正文和 tool_calls —— 别把正文丢了
          content: result.text || null,
          tool_calls: result.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
          }))
        };
        if (result.reasoning) assistantTurn.reasoning_content = result.reasoning;
        messages.push(assistantTurn);

        for (const { call, prune, out } of executed) {
          toolTrace.push({ name: call.name, arg: toolRunner.describeArg(call), pruned: prune.pruned });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: out.error ? `工具失败：${out.error}` : prune.text
          });
        }
        // 工具结果落到会话历史（无损：原文在 toolCache，预览在 blocks）
        //
        // ⚠ reasoning 也要存：下一轮对话（用户再问一句）时 buildMessages 重放历史，
        //   如果这条 assistant 轮有 tool_calls 却没带 reasoning_content，**同样会 400**。
        //   这就是「同一轮工具循环内」与「多轮对话的第二轮」两种 400 的成因，必须一起修。
        await session.append(
          makeMessage("assistant", result.text || "", {
            reasoning: result.reasoning || "",
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

    // ---- 5. 轮次耗尽兜底 ----
    //
    // 走到这里如果 finalText 还是空，说明模型把全部轮次都花在调工具上了
    //（典型场景：某个工具一直失败，模型反复重试同一条路径）。
    // 原来这里直接落盘 + done → 用户看到「AI 说半句就消失」。
    // 现在**强制再问一次**（不带 tools），保证用户一定能拿到答复。
    if (!finalText.trim() && !controller.signal.aborted) {
      log(`工具轮次耗尽（${rounds} 轮）且无正文产出，触发兜底作答`);
      const fb = await finalAnswerFallback({ resolved, settings, messages, requestId, controller, ai });
      if (fb.text.trim()) {
        finalText = fb.text;
        // 兜底这轮也计入工具轨迹（便于排查"为什么多了一次请求"）
        toolTrace.push({ name: "(final-answer-fallback)", arg: `rounds=${rounds}`, pruned: false });
      }
      if (fb.usage) usage = mergeUsage(usage, fb.usage);
    }

    // ---- 6. 落盘（无损）----
    // 只写 **targetSession**（发起时绑定的那个会话），绝不写当前的 `session` ——
    // 见 run() 开头 targetSession 的注释：否则切会话后旧请求会污染新会话的历史。
    const incoming = (request?.messages ?? []).filter((m) => m?.role === "user");
    for (const m of incoming) {
      await targetSession.append(makeMessage("user", m.text));
    }
    if (finalText) {
      await targetSession.append(
        makeMessage("assistant", finalText, { model: resolved.model, usage: usage })
      );
    }
    lastUsage = usage;
    // 累计用量只在「当前会话 == 发起会话」时累加：切会话后不该把旧会话的用量算进新会话。
    if (session === targetSession) {
      sessionUsage = mergeUsage(sessionUsage, usage);
      await targetSession.setSummary({ usage: sessionUsage });
    } else {
      await targetSession.setSummary({ usage: usage }).catch(() => {});
    }

    // 通知外部「这个会话的内容变了」——会话存储据此更新标题、messageCount、updatedAt。
    //
    // ⚠ 没有这一步的话：会话列表里所有会话都叫「新对话」、messageCount 永远是 0
    // （标题只会在迁移时生成一次，之后再也不更新）。这是实测发现的行为缺口 ——
    // 通道都通了、数据也对，但"列表看起来是空的"，用户会以为历史没保存。
    //
    // 用 targetSession（不是 session）：切了会话之后，这条消息属于**原来的**会话。
    // 失败不能影响对话本身（存储写盘失败只是列表显示旧数据，不该让回答丢掉）。
    try {
      await opts.onSessionUpdated?.(targetSession, incoming[0]?.text ?? "");
    } catch (e) {
      log(`会话索引更新失败（不影响对话）：${e?.message || e}`);
    }

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
    abortAll,
    whenIdle,
    swapSession,
    /** 当前会话对象（只读观察用，例如取 session.dir）。 */
    get currentSession() {
      return session;
    },
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
