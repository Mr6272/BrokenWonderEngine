/**
 * IPC 契约的唯一声明（机器可校验）。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────────
 * 真实的跨线断裂：`web/src/panels/aiModelState.ts` 按 `aiProbeModel(id)` 期望
 * `{kind, httpStatus, ms}`，而主进程实际提供的是 `probeModel(id)` 返回
 * `{reason, status, latencyMs}` —— **方法名与三个字段名全不同**。
 * 结果：B 的四类映射全靠 kind/httpStatus/ms，全 undefined → 全部 fallback 到 error，
 * **而且不报错**。这类断裂不会让任何测试变红，只有人肉对比才会发现。
 *
 * 根因不是谁粗心，而是**契约只存在于对话与记忆里，没有落在可校验的代码/类型里**。
 * `docs/desktop-migration.md` §3 是三方唯一契约文件，但它靠人读人改；
 * 这个文件把同一份契约变成**数据**，让 `desktop/test/ipc-contract.test.mjs` 能机器校验：
 *   · preload 暴露的方法 → 主进程是否真的注册了对应的 ipcMain 通道
 *   · 每个通道的返回字段是否与声明一致（span 检查 handler 返回的键集合）
 *   · 命名是否统一（新增通道必须 `bwe:` 前缀、必须登记在这里）
 *
 * ── 纪律 ───────────────────────────────────────────────────────────────
 * 1. **新增/修改任何 IPC 通道，必须同时改这里**（否则契约测试会红）。
 * 2. 每个通道写清：调用方（preload 方法名）、通道名、入参、返回字段**及每个字段语义**。
 * 3. 通道名与 preload 方法名**不要各自发明**：一个通道一个方法，名字对应关系写死在这里。
 * 4. 返回字段的**语义**比类型更重要 —— 上面那个断裂里，字段名不同只是表症，
 *    真正会伤人的是「open 是三态还是布尔」「ready 是否包含连通性」这类语义没写清。
 */

/**
 * `ai:event` 的 notes：thinking 的四个 phase 语义 + 三条硬约束。
 *
 * 单独抽成常量而不是内联长字符串：这段文字会被 UI 侧反复查阅（B 要按 phase 做文案），
 * 内联在对象字面量里既难读也容易被后续编辑弄坏转义。
 */
const AI_EVENT_NOTES = [
  "主进程 → 渲染侧单向推送；preload 的 onAiEvent 返回取消订阅函数。",
  "",
  "thinking 事件的四个 phase 语义（**不可合并** —— 它们对应四种不同的等待体验，UI 文案与「下一步」都不同）：",
  "  · connecting = 已经开始请求，但还没有任何返回（网络握手/排队中）。UI 显示「正在连接…」。",
  "  · reasoning  = 模型在思考，但还没有可显示正文。带 chars（已累计思考字符数）与 delta（最近一小段思考文本，不是全量）。UI 显示「正在思考（已思考 N 字）」。",
  "  · answering  = 已有正文在流。**只发一次**（不是每个 delta 都发，否则 UI 每帧都要判断状态）。",
  "  · slow       = 发起请求后 8 秒内没有任何 reasoning/delta 的兜底提示（网络慢或模型排队）。这是**正式 phase**，UI 应把文案升级并提供取消出口。",
  "",
  "硬约束：",
  "  1. mock 分支也必须发 connecting（人为 400~600ms 延迟），否则无 key 时思考态无法演示/截图；**真模型分支不许加任何人为延迟**。",
  "  2. reasoning 的 delta 只带最近一小段，**不是全量** —— 全量会让事件通道变成第二个正文流（既与正文混淆，也推高成本）。",
  "  3. 事件里只放契约声明的字段（phase / chars / delta）；不要把文案塞进事件，文案由 UI 按 phase 决定。",
  "",
  "tool 事件（开始/结束各一次，**必须用 callId 配对**）：",
  "  { type: \"tool\", requestId, callId, name, phase: \"start\"|\"end\", detail, ok?, error?, ms? }",
  "  · phase=start：工具开始执行。detail = 「调用 X(参数)」。此时无 ok/error/ms。",
  "  · phase=end  ：工具执行结束。detail = 结果摘要；ok = 是否成功；",
  "                error = **完整错误原文**（不经过剪枝 —— 错误通常很短，剪枝反而削掉根因）；ms = 本次耗时。",
  "",
  "⚠ **为什么 callId 是必须的而非可选**：一次对话里可能出现**两次同名工具**（真实发生过：SceneDigest ×2）。",
  "  按 name 配对会让第一次的 start 配到第二次的 end —— 耗时算错、成败也可能串。",
  "  这不是理论风险，是用户实际遇到的场景。callId 取模型返回的 tool_call.id（天然唯一），没有则现生成。",
  "",
  "⚠ **工具连续失败会被止损**：同一工具**连续**失败 2 次后，主进程不再真的执行它，",
  "  而是直接返回「该工具当前不可用，请基于已有信息作答」并 `ok:false` 的 end 事件。",
  "  理由：模型不会自己意识到「这个工具坏了」，它会一直重试同一条路径，最终耗尽轮次、一句正文都没产出。",
  "  成功一次即清零（偶发失败重试一次是合理的）。",
  "  ⚠ **止损键是「工具名 + 参数」，不是工具名**：按 name 计数会把「换个路径再试」也判成工具坏了，",
  "  实测造成 ReadFile 被误禁 → 模型再也读不到任何文件 → 整轮对话什么都没交付。",
  "",
  "done 事件必须如实给出下面这些字段（`extra` 下；缺省 = 无提示，UI 不许猜）：",
  "",
  "⚠ **工具没有次数上限**（2026-11-02 用户明确要求「工具不该有次数限制」）。",
  "  历史上是 3 轮 → 12 轮/24 次 → 现在**无上限**。所以：",
  "  · `extra.toolBudget = { roundsUsed, callsUsed, elapsedMs, stopReason, stallStreak, budgetExhausted }`",
  "      `roundsUsed`/`callsUsed` 只是**记账**（给界面显示「跑了多少」），不是额度。",
  "      不再有 `roundsMax`/`callsMax` —— 它们代表的限制已经不存在，界面别再拼「X/Y 轮」。",
  "  · `stopReason` 才是**为什么停下来**：",
  "        null        = 模型自己收尾（正常结束，最常见）",
  "        \"stalled\"   = 连续多轮做**完全相同**的调用、且拿到的结果**没有变化** → 真死循环",
  "        \"timeout\"   = 看门狗（本轮耗时超过 45 分钟，只拦真正的挂死）",
  "        \"aborted\"   = 用户取消",
  "      界面按 stopReason 出提示：stalled 要说清「这是绕圈、不是次数限制，正常探索不会触发」；",
  "      timeout 要换算成分钟并建议拆小任务。**静默停止最糟**：用户只看到答案很短，不知道发生了什么。",
  "  · `stallStreak` = 无进展轮数峰值（排查死循环用；正常任务恒 0）。",
  "  · `budgetExhausted` = **已废弃，恒为 false**，仅向后兼容保留。",
  "      旧主进程仍可能发 true（那时上限还在），所以渲染侧判断顺序是：",
  "      先看 stopReason（stalled/timeout），都没有时才回退看 budgetExhausted。",
  "  · `extra.truncated: boolean` = 模型输出因 max_tokens 被截断且自动续写次数已用尽。",
  "      语义要点：截断过一次但续写救回来 → `truncated=false`（不要报假警）。",
  "      `extra.autoContinued` 给出实际续写次数（排查「为什么这轮发了多次请求」）。",
  "  所有提示都是**警告**而不是错误：这不是崩溃，UI 不要画红叉；truncated 也不要给「重试」按钮",
  "  （重试同样会撞 max_tokens，正确动作是调大它）。",
  "",
  "⚠ **ReadFile 的自动翻页**（2026-11-02 修的真实故障）：同一文件再次调用且**不带 from** 时，",
  "  会自动从上次读到的行继续（结果首行明确写「第 X-Y 行 / 共 N 行」）。",
  "  这解释了为什么模型说「翻页参数被忽略」却一直看到前 400 行 —— 它自己没传 from，而工具当时每次都从头读。",
  "  界面无需感知此行为，但排查「AI 反复读同一个文件」时要先看它有没有真的传 from。",
].join("\n");

/** 所有 IPC 通道的契约。键 = ipcMain 通道名。 */
export const IPC_CONTRACT = {
  // ---------------- 内嵌 API（原 /api/* 的能力） -------------
  "bwe:api": {
    preload: "api",
    kind: "invoke",
    params: "path: string, init?: { method?, body?, headers? }",
    returns: ["ok", "status", "json", "text", "headers"],
    notes: "返回形状必须与 web/tools/serve.mjs 的 HTTP 响应语义一致；ok 由 status 派生。"
  },

  // ---------------- 文件 -------------
  "bwe:host-info": {
    preload: null,
    kind: "sendSync",
    params: "无",
    returns: ["version", "paths", "shotMode"],
    notes: "preload 用 sendSync 拿版本与路径；shotMode=true 时 preload 会预置 localStorage 抑制首次引导弹窗。"
  },
  "bwe:open-project": {
    preload: "openProject",
    kind: "invoke",
    params: "无",
    returns: ["ok", "path", "content", "name", "error", "cancelled"],
    notes: "cancelled:true 表示用户主动取消，不是失败（UI 不该弹红条）。"
  },
  "bwe:save-project": {
    preload: "saveProject / saveProjectAs",
    kind: "invoke",
    params: "{ project, suggestedName?, forceDialog? }",
    returns: ["ok", "path", "name", "error", "cancelled"],
    notes: "saveProject 传 forceDialog:false（沿用上次路径），saveProjectAs 传 true。"
  },
  "bwe:recent-projects": {
    preload: "recentProjects",
    kind: "invoke",
    params: "无",
    returns: ["数组：{ path, name, at }"],
    notes: "已剔除磁盘上不存在的路径；按最近使用倒序。"
  },
  "bwe:reveal-in-explorer": {
    preload: "revealInExplorer",
    kind: "invoke",
    params: "path: string",
    returns: ["ok", "error"],
    notes: "只是打开资源管理器，失败不影响业务（UI 应静默处理，不弹红条）。"
  },
  "bwe:download-file": {
    preload: "downloadFile",
    kind: "invoke",
    params: "{ path, suggestedName }",
    returns: ["ok", "path", "sizeBytes", "error", "cancelled"],
    notes: "桌面版 file:// 下 window.location 下载不可用，必须走这里。cancelled 不是失败。"
  },

  // ---------------- 设置 -------------
  "bwe:get-settings": {
    preload: "getSettings",
    kind: "invoke",
    params: "无",
    returns: ["ai", "editor", "insecure", "cryptoAvailable", "version"],
    notes: "**绝不返回任何明文 apiKey**；每条模型只给 hasApiKey 布尔。"
  },
  "bwe:set-settings": {
    preload: "setSettings",
    kind: "invoke",
    params: "Partial<Settings>",
    returns: ["同 bwe:get-settings"],
    notes: "models 数组整体替换（不是逐项合并），否则「删掉一个模型」会失效。"
  },

  // ---------------- AI -------------
  "bwe:ai-status": {
    preload: "aiStatus",
    kind: "invoke",
    params: "无",
    returns: [
      "provider", "intendedProvider", "ready", "mode", "message", "models", "activeModelId",
      "activeModel", "modelList", "usage", "storage", "activeSession", "sessionCount", "insecure",
      "keyUndecryptable", "keyUndecryptableCount", "keyUndecryptableEntries", "keyPlaintextFallback"
    ],
    notes:
      "`ready` 只表示**配置齐全**，不含连通性（探 use bwe:ai-probe-model）。"
      + " 缺 key 时 provider=mock 但 intendedProvider 保留意图（UI 据此提示「想用 X 但缺 key」）。"
      + "\\n\\n**`keyUndecryptable` 与 `needsKeyMissing` 是两种不同状态，UI 必须分开处理：**"
      + "\\n  · needsKeyMissing = 用户**真没填** → 下一步「去填 API Key」"
      + "\\n  · keyUndecryptable = **填过但本次启动解不开** → 下一步「**重新粘贴一次**」（可用一条就生效）"
      + "\\n成因：Electron safeStorage 在 Windows 上可能「isEncryptionAvailable()=true 但 decryptString 失败」"
      + "（DPAPI 上下文在进程/会话重启后不一致，或 Electron 升级后参数变化）。"
      + "此时磁盘密文还在，但内存里 apiKey 为空 —— 若按「没填」提示，用户明明填过却看到「待填」，"
      + "发请求带空 key 必然 401，而用户完全不知道去哪修。"
      + "\\n`keyUndecryptableEntries` 指出具体哪些条目：`[{scope:\"top-level\"|\"model\", id}]`。"
      + "\\n`keyPlaintextFallback=true` 表示上次保存因加密不可用而**降级成明文** —— UI 可据此提示「当前 key 未加密存储」。"
      + "\\n\\n**三源恒等式（必须始终成立）**："
      + "\\n  `keyUndecryptableCount === keyUndecryptableEntries.length === ai-models 里 keyUndecryptable:true 的条数`"
      + "\\n  这是**刻意的冗余统计**，用来互相校验 —— 一旦漂移，用户会看到「红条说 1 个，点进去却是 2 个」。"
      + "\\n  主进程 --ipc-probe 有自检通道 `bwe:key-state-consistency` 断言这条恒等式；"
      + "\\n  另有一条语义约束：`keyUndecryptable` 与 `needsKeyMissing` **不可同时为 true**（解不开不算没填）。"
  },
  "bwe:ai-chat": {
    preload: "aiChat",
    kind: "invoke",
    params: "AiChatRequest（见契约 §4.1）",
    returns: ["requestId"],
    notes: "**立刻返回**，流式内容走 ai:event；事件顺序 route → delta* → (tool) → usage* → done。"
  },
  "bwe:ai-cancel": {
    preload: "aiCancel",
    kind: "invoke",
    params: "requestId: string",
    returns: ["ok", "cancelled"],
    notes: "取消后 done.usage.reason === 'aborted'，token 是真实已消耗量，别显示 0。"
  },
  "bwe:ai-reset": {
    preload: "aiReset",
    kind: "invoke",
    params: "无",
    returns: ["ok"],
    notes: "清空对话历史但**保留 system 前缀块与摘要**（重排历史会让前缀缓存全部失效）。"
  },

  // ---------------- 模型切换 / Trae 导入 -------------
  "bwe:ai-import-trae": {
    preload: "aiImportTrae",
    kind: "invoke",
    params: "无",
    returns: [
      "ok", "providers", "warnings", "dbPath", "totalEntries", "uniqueModels", "importedEntries"
    ],
    notes:
      "导入条目的 apiKey 恒为空、needsKey:true、source:'trae-import'（Trae 的 key 设备绑定、解不开也不该解）。"
      + " 同 id 条目会保留用户已填的 key（不覆盖）。"
  },
  "bwe:ai-models": {
    preload: "aiModels",
    kind: "invoke",
    params: "无",
    returns: ["ok", "models", "active"],
    returnsOnError: ["ok", "error", "models", "active"],
    notes:
      "models 每条含 id/label/provider/baseUrl/model/ready/needsKey/needsKeyMissing/hasApiKey/"
      + "source/contextWindow/maxTokens/reason。"
      + " **`needsKeyMissing` 才是「这条要不要去填 key」**（= needsKey && !hasApiKey）；"
      + " `needsKey` 只是「该供应商类型是否需要 key」。**`ready` 只表示配置齐全，不含连通性。**"
  },
  "bwe:ai-set-model": {
    preload: "aiSetModel（清除 key 用 aiClearModelKey）",
    kind: "invoke",
    params: "{ id, apiKey?, clearApiKey? }",
    returns: ["ok", "models", "active", "message", "ready"],
    returnsOnError: ["ok", "error", "models", "active"],
    notes:
      "成功路径带 message/ready（UI 直接显示）；失败路径只带 ok/error/models/active。"
      + " apiKey 三态：**不传 / 空串 / 纯空白 → 一律不动**（UI 切模型时输入框天然是空值，"
      + " 若当清除等于「切一次模型丢一次 key」）；非空串 → 覆盖；clearApiKey:true → 显式清除。"
      + " id 不存在时 ok:false，**绝不静默改成别的模型**。"
  },
  "bwe:ai-add-model": {
    preload: "aiAddModel",
    kind: "invoke",
    params: "{ label, provider, baseUrl, model, apiKey?, contextWindow?, maxTokens? }",
    returns: ["ok", "models", "active", "ready", "message", "id", "created", "updated", "warning"],
    returnsOnError: ["ok", "error", "models", "active"],
    notes:
      "判重键是 **provider+baseUrl+model**（不是 id）：同一条模型可能来自 Trae 导入（id=trae:...）"
      + " 或被用户手填（本会生成 manual:...），按 id 判重会变成两条。命中时就地更新并保留原 id/source。"
      + " 未知 provider 会回落 openai-compatible 并在 warning 里说明。"
  },
  "bwe:ai-remove-model": {
    preload: "aiRemoveModel",
    kind: "invoke",
    params: "{ id }",
    returns: ["ok", "models", "active", "ready", "message", "removed"],
    returnsOnError: ["ok", "error", "models", "active"],
    notes:
      "删一条模型（用户配错了 / 想清掉用不上的供应商）。两条硬约束："
      + " ① **不许删到清单为空** —— 空了 AI 面板会变成「没有可用模型」的死状态，"
      + " 用户本想清一条却再也发不出请求；宁可 ok:false 并说明。"
      + " ② 删的若是当前 active，**active 必须落到剩下的第一条**，"
      + " 否则 settings.activeModelId 指向不存在的 id，下一轮对话直接失败"
      + " （provider.mjs 会报「模型不在清单里」）—— 与删当前会话是同一类坑。"
  },
  "bwe:ai-probe-model": {
    preload: "probeModel",
    kind: "invoke",
    params: "{ id }",
    returns: [
      "ok", "id", "status", "reachable", "method", "detail", "reason", "latencyMs", "errorCode", "evidence"
    ],
    notes:
      "⚠ **`ok` 是三态，不是布尔**：true 明确可用 / false 明确不可用 / **null 判不出来**。"
      + " reason 取值：ok | unauthorized | unauthorized-on-models | dns | timeout | network | http-error | no-base-url | not-found | mock。"
      + " `unauthorized-on-models` 表示「/models 端点拒绝了这个 key，但可能是该端点权限更高，"
      + " **不代表对话接口失败**」——UI 必须显示「无法确定」而不是失败，否则一个其实能用的服务会被判死。"
      + " `reachable` 的语义是**连上了**（拿到任何 HTTP 响应即 true），不是「返回 200」。"
  },

  // ---------------- 多会话 / 历史 -------------

  "bwe:ai-sessions-list": {
    preload: "aiSessionsList",
    kind: "invoke",
    params: "无",
    returns: ["ok", "sessions", "active"],
    returnsOnError: ["ok", "sessions", "active", "error"],
    notes:
      "sessions 每项 { id, title, createdAt, updatedAt, messageCount }。"
      + "title 由**第一条用户消息前 20 字**生成（零 token，不调模型 —— 第一条消息本身就是最好的标题）。"
      + "index.json 丢失时会自愈：磁盘上 conversations/<id>/ 还在的历史会补回列表。"
  },
  "bwe:ai-session-new": {
    preload: "aiSessionNew",
    kind: "invoke",
    params: "{ title?: string }",
    returns: ["ok", "id", "sessions", "active", "aborted"],
    returnsOnError: ["ok", "id", "sessions", "active", "error"],
    notes:
      "开新会话时**当前会话保留**（新会话是追加，不是覆盖）。"
      + "会先中止在途请求并返回 aborted 数（新对话不该继承上一个对话正在生成的回答）。"
  },
  "bwe:ai-session-switch": {
    preload: "aiSessionSwitch",
    kind: "invoke",
    params: "{ id: string }",
    returns: ["ok", "sessions", "active", "messages", "aborted"],
    returnsOnError: ["ok", "sessions", "active", "messages", "error"],
    notes:
      "返回目标会话的完整 messages（**不含 system 前缀块**，那是内部实现不该显示给用户）。"
      + "切换前**先 abort 在途请求再换绑会话**（顺序不能反：否则旧请求收尾时会把消息写进新会话的 history）。"
      + "id 不存在时明确失败，**不静默切到别的会话**（静默切换会让 UI 显示 A、实际读写 B）。"
  },
  "bwe:ai-session-delete": {
    preload: "aiSessionDelete",
    kind: "invoke",
    params: "{ id: string }",
    returns: ["ok", "sessions", "active"],
    returnsOnError: ["ok", "sessions", "active", "error"],
    notes:
      "删 active 会话时自动落到最近的其它会话（active 永不悬空）；"
      + "删到只剩 0 个时自动补一个空会话（否则 UI 没有可用会话、下次启动也难恢复）。"
      + "删除后**换绑桥的 session 对象** —— 否则桥还指着已删除目录，后续写入会产生孤儿文件。"
  },

  // ---------------- 脚本语言服务（补全 / 悬浮提示） -------------

  "bwe:script-complete": {
    preload: "scriptComplete",
    kind: "invoke",
    params: "{ source: string, offset: number }",
    returns: ["ok", "entries", "isMemberAccess"],
    returnsOnError: ["ok", "entries", "isMemberAccess", "error"],
    notes:
      "补全。entries 每项 { name, kind, detail, docs, insertText }；"
      + "kind 是粗分类 function|property|namespace|keyword|constant。"
      + "**insertText 只给名字、不带括号**（带不带括号是 UI 的决策，后端不替 UI 决定）。"
      + "offset 是 **UTF-16 code unit 偏移**（与 textarea.selectionStart 同一口径，两边天然一致，不要做字符数换算）。"
      + "与网页版 POST /api/script-complete 共用同一套语言服务。"
  },
  "bwe:script-quickinfo": {
    preload: "scriptQuickInfo",
    kind: "invoke",
    params: "{ source: string, offset: number }",
    returns: ["ok", "info"],
    returnsOnError: ["ok", "info", "error"],
    notes:
      "悬浮提示。info = { display, docs, kind } 或 **null**。"
      + "**info 为 null 是正常结果**（光标在括号/空白处没有符号），UI 隐藏提示框即可，不是失败。"
      + "与网页版 POST /api/script-quickinfo 共用同一套语言服务。"
  },

  // ---------------- 项目知识库 -------------

  "bwe:knowledge-list": {
    preload: "knowledgeList",
    kind: "invoke",
    params: "无",
    returns: ["ok", "root", "projects"],
    returnsOnError: ["ok", "error", "projects"],
    notes:
      "列出知识库里的**所有工程**（每个工程一份独立记忆，按「工程名 + 路径 hash」分片）。"
      + "projects 每项 { key, name, file, createdAt, updatedAt, roundCount, pointCount, lastSummary }。"
      + "⚠ 实现是**直接扫目录**，不依赖任何总索引：目录是唯一真相。"
      + "（历史教训：会话 index.json 损坏时 UI 显示「全没了」，而内容其实都在盘上。）"
      + "root 给出来是为了让用户能「在资源管理器里打开知识库」，不至于找不到文件在哪。"
  },
  "bwe:knowledge-project": {
    preload: "knowledgeProject",
    kind: "invoke",
    params: "{ key: string, limit?: number }",
    returns: ["ok", "key", "index", "rounds"],
    returnsOnError: ["ok", "key", "error", "rounds"],
    notes:
      "读某个工程的最近若干轮沉淀（rounds 每项 = rounds.jsonl 的一行，新的在前）。"
      + "key 必须是 knowledgeList 返回的**目录名** —— 不要拿工程名去猜："
      + "工程名与目录名不是一回事（目录名经过安全化、并带路径 hash 后缀）。"
      + "坏行会被跳过（JSONL 的意义），所以「读到的条数少于 index.roundCount」是正常现象，不是错误。"
  },

  // ---------------- 日志 -------------
  "bwe:log-tail": {
    preload: "（未暴露，调试用）",
    kind: "invoke",
    params: "无",
    returns: ["string[]（最近 200 行）"],
    notes: "主进程日志环形缓冲的尾部，用于排查「窗口起来了但界面报错」这类问题（--console 之外第二观察点）。"
  },

  // ---------------- 主进程 → 渲染侧（单向推送） -------------
  "ai:event": {
    preload: "onAiEvent",
    kind: "send",
    params: "AiEvent（见契约 §4.2）",
    returns: [],
    // 事件类型清单必须完整：漏一种，UI 就静默丢弃它（而"丢掉一个事件"不会报错）。
    eventTypes: ["route", "thinking", "delta", "tool", "usage", "knowledge", "done", "error"],
    notes: AI_EVENT_NOTES
  },
  "menu:command": {
    preload: "onMenuCommand",
    kind: "send",
    params: "command: string",
    returns: [],
    notes: "原生菜单命令名与渲染侧命令 id 需对齐（见 lib/menu.mjs）。"
  },
  "project:opened": {
    preload: "onOpenProjectRequest",
    kind: "send",
    params: "{ path, content }",
    returns: [],
    notes: "原生「打开工程」对话框拿到 .bwproj 后直接推给渲染侧，渲染侧不用自己读盘。"
  }
};

/** 通道名前缀纪律。 */
export const CHANNEL_PREFIX = "bwe:";

/**
 * 语义上必须被测试守住的字段（防止未来有人"为了让界面看起来正常"而改坏）。
 * 这些不是类型约束，是**语义约束**，写在这里让契约测试与 UI 侧都能看到。
 */
export const SEMANTIC_INVARIANTS = [
  {
    where: "bwe:ai-models → models[]",
    rule: "needsKeyMissing === (needsKey && !hasApiKey)",
    why: "needsKey 是供应商类型属性，needsKeyMissing 才是「这条要不要填 key」；两者接反会让已填 key 的条目显示「需要填 key」。"
  },
  {
    where: "bwe:ai-models → models[]",
    rule: "!hasApiKey && needsKey → ready === false",
    why: "防止有人把 ready 恒置 true 来「修好」UI 提示——那会让用户填完假 key 看到可用，一发消息 401。"
  },
  {
    where: "bwe:ai-probe-model",
    rule: "ok 必须是三态 true | false | null，不许压成布尔",
    why: "「/models 401」不代表对话接口不可用；压成 false 会误判一个可用的服务为不可用。"
  },
  {
    where: "bwe:ai-set-model",
    rule: "apiKey 为空串/纯空白时不得清除已有 key",
    why: "UI 切模型时输入框天然是空值，当清除处理等价于「切一次模型丢一次 key」。"
  },
  {
    where: "bwe:get-settings / bwe:set-settings",
    rule: "任何返回中都不得出现明文 apiKey",
    why: "明文 key 一旦进入渲染进程就可能被日志/截图带出去；模型条目只给 hasApiKey 布尔。"
  }
];

/** 供测试与文档生成用：列出所有通道名。 */
export function channelNames() {
  return Object.keys(IPC_CONTRACT);
}

/** 供测试用：某通道声明的返回字段。 */
export function returnFieldsOf(channel) {
  return IPC_CONTRACT[channel]?.returns ?? [];
}
