/**
 * 宿主抽象：编辑器所有「需要操作系统/后端能力」的动作都从这里出去。
 *
 * 为什么要有这一层：
 *   网页版靠 `npm run serve` 的 /api/* 干活；桌面版（Electron）把同样的能力搬进了
 *   主进程，走 IPC。如果业务代码里到处写 `fetch("/api/...")`，桌面版就必须在本地再起
 *   一个 HTTP 服务 —— 多一个进程、多一处端口冲突、多一条防火墙提示。
 *   所以渲染侧只认这个门面：有 window.bweHost 走它，没有就回退原生 fetch。
 *
 * 纪律：
 *   - 路径、method、body 的语义在两种模式下**完全一致**，业务代码不用区分。
 *   - 返回值统一成 Response 形状（status / ok / json() / text()），调用方不需要分支。
 *   - 桌面模式下不存在跨域/端口，因此也不需要重试与超时兜底。
 *   - AI 能力同样只走这个门面：桌面版走 IPC 流式事件，网页版 / 无 key 时退化成
 *     本地 mock 流（面板必须始终可用，只是回答来自模板而不是模型）。
 */

/** 桌面主进程通过 preload 暴露的对象（结构见 docs/desktop-migration.md §3） */
export interface HostApiResult {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** Token 计量，三种「输入」互不重叠（与 DeepSeek Harness 的 TokenUsage 语义一致） */
export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reason?: string;
}

export type AiModel = "flash" | "pro";

/** 流式事件（契约 §4.2）。面板按 type 分派，未知 type 一律忽略。 */
export type AiEvent =
  | { type: "route"; requestId: string; model: AiModel; reason: string; localOnly: true }
  | {
      /**
       * 「模型在忙」的显式信号。**这是 UI 唯一的思考态来源**，不要靠"多久没收到 delta"去猜。
       *
       * 四个 phase 的语义（不要合并，它们对应四种不同的等待体验）：
       *   connecting —— 请求已发出，但还没有任何返回（首字延迟期，推理模型常 2~5 秒）
       *   reasoning  —— 模型在思考（DeepSeek 的 reasoning_content），还没有可显示的正文
       *   answering  —— 已有正文在流（此时思考提示应撤掉）
       *   slow       —— 兜底：超过 8 秒什么都没收到，提示可能网络慢或模型排队
       *
       * `chars` 是 reasoning 已累计的字符数（可显示「已思考 N 字」）；
       * `delta` 是**最近一小段**思考文本，供「展开看思考过程」，**不是全量**（全量很贵）。
       */
      type: "thinking";
      requestId: string;
      phase: "connecting" | "reasoning" | "answering" | "slow";
      chars?: number;
      delta?: string;
    }
  | { type: "delta"; requestId: string; text: string }
  | {
      /**
       * 一次工具调用。**开始与结束都发这个事件**，用 `callId` 配对（不要按 `name` 或顺序配对：
       * 同名工具可能连调多次，按名字配会把「失败的那次」和「成功的那次」算成同一步）。
       *
       * 字段语义：
       *   phase  —— "start" 已开始调用 / "end" 已得到结果（含失败结果）
       *   ok     —— 仅 end 有：`false` 表示工具执行失败（`error` 带原因）
       *   error  —— 仅失败时有，**完整错误文本**（不是剪枝摘要）
       *   ms     —— 仅 end 有：本次调用耗时（毫秒）
       *
       * ⚠ 这三条是 2026-11-02 补的、因为**原先只有 `detail` 字符串，UI 分不出成败**：
       * 失败和成功都渲染成一样的灰块，用户看到的是「一个空块挂很久」，无法判断是坏了还是在跑。
       * **不要在 UI 侧从 `detail` 文案里猜成败** —— 那是拿文案当协议，改一个字就静默失效。
       */
      type: "tool";
      requestId: string;
      name: string;
      detail: string;
      /** 开始/结束。缺省时按 end 处理（兼容未升级的主进程）。 */
      phase?: "start" | "end";
      /** 标识同一次调用，用于把 start 与 end 配对、并防止同名连调配错。 */
      callId?: string;
      /** 仅 end：是否成功。 */
      ok?: boolean;
      /** 仅失败：完整错误文本（客服/排查需要原文，不要截断成摘要）。 */
      error?: string;
      /** 仅 end：本次调用耗时（毫秒）。 */
      ms?: number;
    }
  | { type: "usage"; requestId: string; usage: TokenUsage }
  | {
      type: "done";
      requestId: string;
      text: string;
      usage: TokenUsage;
      cacheHitRate: number;
      savedUsdApprox: number;
    }
  | { type: "error"; requestId: string; message: string; recoverable: boolean };

export interface AiStatus {
  provider: "deepseek" | "openai-compatible" | "mock";
  ready: boolean;
  /** desktop = 真的有宿主并且配了 key；mock = 无宿主 / 无 key 的演示模式 */
  mode: "desktop" | "mock";
  message?: string;
  models: { flash: string; pro: string };
  usage?: {
    cacheHitRate: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
  };
}

export interface AiChatRequest {
  requestId: string;
  messages: { role: "user" | "assistant"; text: string }[];
  context?: {
    sceneDigest?: string;
    diagnostics?: { errors: number; firstError?: string };
    activeScript?: { name: string; lang: "js" | "yarn"; code: string };
    selection?: { count: number; kinds: string[] };
  };
  intent: "chat" | "explain-error" | "edit-script" | "scene-review";
}

/**
 * 一个可切换的模型。
 *
 * `needsKey` 与 `needsKeyMissing` 是**两个不同的东西**，混用是最容易犯的错：
 *   needsKey        = 这个**供应商类型**是否需要 key（mock 不需要、deepseek 需要）；
 *   needsKeyMissing = **这一条**是否真的还没填 key。
 * 一条已经填好 key 的 DeepSeek 模型仍然 `needsKey: true`，但 `needsKeyMissing: false`。
 * 面板要给用户看的提示必须用 `needsKeyMissing` —— 用 `needsKey` 会让用户以为自己的 key 没生效
 * （这是真实发生过的 UI bug，由 `desktop/tools/verify-models.mjs` 抓出来的）。
 *
 * `ready` 又是第三件事：现在能不能真的发请求（有 key + baseUrl 非空 + 可达性探测没失败）。
 */
export interface AiModelEntry {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  ready: boolean;
  /** 供应商类型是否需要 key（不是"这条缺不缺 key"） */
  needsKey: boolean;
  /** 这条是否真的缺 key。UI 的「需要填 API Key」提示必须用这个字段。 */
  needsKeyMissing?: boolean;
  /** 这条是否已经有 key（可以据此在 UI 上显示「已配置」而不是「需要填」）。 */
  hasApiKey?: boolean;
  /** 为什么不可用（UI 唯一的提示来源）。 */
  reason?: string;
  /** 导入来源（trae-import / manual / preset），便于以后审计这条配置是谁加的 */
  source?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** 最近一次 baseUrl 可达性探测结果；没探测过是 undefined（不是 false）。 */
  reachable?: boolean;
}

export interface AiModelsState {
  models: AiModelEntry[];
  active: string;
  /** 主进程给的一句话说明（当前能/不能用的原因）。切换/添加后由主进程回填。 */
  message?: string;
  /** 切换/添加后当前模型是否真的可用。UI 必须用它决定「切换成功」还是「切换了但用不了」。 */
  ready?: boolean;
}

// ==========================================================================
// 多会话
// --------------------------------------------------------------------------
// 会话存的是「完整对话历史」，切会话就是换一整份 history。字段语义：
//   · updatedAt 是**相对时间显示**的来源（UI 按它降序排，"刚才那个对话"在最上面）
//   · messageCount 由主进程在**落盘后**更新（不是发送时），所以发送后立刻刷列表
//     会短暂看到旧条数 —— 这是正常时序，不是 bug
//   · switch 返回的 messages **已过滤 system 前缀块**，UI 不要二次过滤
//   · aborted > 0 表示本次操作中断了 N 个在途请求，**必须提示用户**
//     （否则用户会以为正在生成的回答莫名消失）
// ==========================================================================

export interface AiSessionEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface AiSessionMessage {
  role: "user" | "assistant";
  text: string;
  /** 该条带上工具调用记录时才存在（UI 用来还原工具块） */
  tools?: { name: string; detail: string }[];
  /** 该条还在流式生成中（切换/新建后不应有 true） */
  streaming?: boolean;
}

export interface AiSessionsState {
  ok?: boolean;
  sessions: AiSessionEntry[];
  active: string;
  /** 本次操作中断了几个在途请求。>0 必须提示用户。 */
  aborted?: number;
  error?: string;
}

/**
 * 手动添加模型时的输入。
 * 规则（判重 / provider 降级 / 缺字段）都在主进程的 `modelCatalog.mjs`，
 * 渲染侧只拦「明显填错」（缺 model / 缺 baseUrl），不要把业务规则复制一份。
 */
export interface AiModelInput {
  label?: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * 一次连通性探测的结果。
 *
 * `ok` 是**三态**而不是布尔，这个设计是刻意的：
 *   true  明确可用（HTTP 2xx，key 被接受）
 *   false 明确不可用（401 且服务端明确说凭据无效 / DNS 失败 / 超时）
 *   null  判不出来（比如 `/models` 端点要求更高权限，不代表对话接口一定失败）
 * 把 null 当成 false 会误伤一个其实能用的服务；当成 true 又会在用户发消息时才失败。
 * UI 必须把三态分开显示，并给出对应的「下一步」。
 */
export interface AiProbeResult {
  /** 三态：true 可用 / false 不可用 / null 判不出来 */
  ok: boolean | null;
  id?: string;
  /** HTTP 状态码；没拿到响应（DNS/超时/连不上）时为 0 */
  status?: number;
  reachable?: boolean;
  method?: string;
  /** 给人看的结论（含「为什么判不出来」的解释） */
  detail?: string;
  /** 机器可读的分类：ok / auth / dns / timeout / network / unsupported / error */
  reason?: string;
  errorCode?: string;
  latencyMs?: number;
}

export interface BweHost {
  mode: "desktop";
  version: string;
  paths: { userData: string; workspace: string; repo: string; settings: string };
  api(
    path: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> }
  ): Promise<HostApiResult>;
  openProject(): Promise<{ ok: boolean; path?: string; content?: string; error?: string }>;
  saveProject(p: unknown, suggestedName?: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  saveProjectAs(p: unknown, suggestedName?: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  recentProjects(): Promise<{ path: string; name: string; at: number }[]>;
  revealInExplorer(path: string): Promise<void>;
  /** 原生「保存文件」对话框（桌面版把 /api 的下载路由解析成本地文件后再问你存哪）。
   *  cancelled=true 表示用户主动取消，调用方不该当失败弹红条；网页版没有这个能力。 */
  downloadFile?(path: string, suggestedName?: string): Promise<{ ok: boolean; path?: string; sizeBytes?: number; error?: string; cancelled?: boolean }>;
  getSettings?(): Promise<unknown>;
  setSettings?(patch: unknown): Promise<unknown>;
  onMenuCommand?(cb: (command: string) => void): () => void;
  /** 桌面版 AI：全部能力由主进程提供（契约 §3） */
  aiStatus?(): Promise<AiStatus>;
  aiChat?(req: AiChatRequest): Promise<{ requestId: string }>;
  aiCancel?(requestId: string): Promise<void>;
  aiReset?(): Promise<void>;
  onAiEvent?(cb: (ev: AiEvent) => void): () => void;
  /** 模型管理：列出可切换的模型、切换当前模型、从其它编辑器导入供应商配置。 */
  aiModels?(): Promise<AiModelsState>;
  aiSetModel?(id: string, apiKey?: string): Promise<AiModelsState>;
  aiImportTrae?(): Promise<{ ok: boolean; providers: AiModelEntry[]; warnings: string[] }>;
  /** 手动添加 / 覆盖一条模型（Trae 里没有的模型，比如官方 API 或自建反代）。 */
  aiAddModel?(input: AiModelInput): Promise<AiModelsState>;
  /**
   * 真实探测一条模型的连通性（用户点「测试连接」时才调）。
   * `ok` 是**三态**：true 明确可用 / false 明确不可用 / null 判不出来（看 detail）。
   */
  probeModel?(id: string): Promise<AiProbeResult>;
  /** 多会话：列表 / 新建 / 切换 / 删除。返回形状见下方 `AiSessionEntry`。 */
  aiSessionsList?(): Promise<AiSessionsState>;
  aiSessionNew?(title?: string): Promise<AiSessionsState & { id?: string }>;
  aiSessionSwitch?(id: string): Promise<AiSessionsState & { messages?: AiSessionMessage[] }>;
  aiSessionDelete?(id: string): Promise<AiSessionsState>;
}

declare global {
  interface Window {
    bweHost?: BweHost;
  }
}

const host = (): BweHost | null => {
  try {
    return (window as Window & { bweHost?: BweHost }).bweHost ?? null;
  } catch {
    return null;
  }
};

/** 桌面模式判定：只在窗口生命周期里定一次，之后不会变。 */
export function isDesktop(): boolean {
  return !!host();
}

export function hostMode(): "desktop" | "web" {
  return host() ? "desktop" : "web";
}

/** 桌面版才有的能力（打开/保存原生文件对话框）。网页版返回 null，调用方自己兜底。 */
export function nativeHost(): BweHost | null {
  return host();
}

/**
 * 把 callable 包成「看得懂」的 BodyInit。
 * 调用方可能传 string、FormData、Blob；桌面 IPC 只能带字符串，所以：
 *   - string / URLSearchParams 原样传；
 *   - FormData / Blob / ArrayBuffer 这里不做转换（桌面版没有任何接口需要它们，
 *     打包上传走的是 JSON body），直接报错，避免静默丢数据。
 */
function serializeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error(
    "桌面模式下 /api 只能传字符串 body。若这里是从 FormData 调进来的，说明该接口需要改成 JSON body（见 docs/desktop-migration.md §3）。"
  );
}

/** 让 IPC 结果长得像 Response，业务代码（含 `await resp.json()`）无需改动。 */
function toResponse(r: HostApiResult): Response {
  const payload = r.text !== undefined ? r.text : JSON.stringify(r.json ?? null);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", ...(r.headers ?? {}) });
  // 用 Response 的真实构造器（Electron 渲染进程有）而不是手搓对象，
  // 这样 resp.json()/resp.text()/resp.clone() 的行为与网页版一致。
  // Response 的 ok 是只读派生值（status 200~299 才算 ok），不能由构造参数指定。
  // 宿主可能给出 ok:false + status:200 这种组合，这里统一以 status 为准，
  // 避免上层看到 resp.ok === true 但 json 里写着失败。
  const status = r.status && r.status >= 100 ? r.status : r.ok ? 200 : 500;
  return new Response(payload, { status, headers });
}

/**
 * 唯一的请求出口。
 *
 * @param path 以 /api/ 开头的路径（与网页版 serve.mjs 的路由一致）
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const h = host();
  if (!h) return fetch(path, init);
  try {
    const r = await h.api(path, {
      method: init?.method,
      body: serializeBody(init?.body),
      headers: (init?.headers as Record<string, string> | undefined) ?? undefined
    });
    return toResponse(r);
  } catch (e) {
    // 宿主崩了也要给业务代码一个 Response，而不是抛异常炸掉整个面板：
    // 让上层统一的 `if (!resp.ok)` 分支处理，界面上是「接口不可用」而不是白屏。
    return new Response(JSON.stringify({ ok: false, error: (e as Error)?.message || String(e) }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
}

/** 桌面版可用的原生文件对话框；网页版返回 null 让调用方走浏览器兜底。 */
export function hostPaths(): BweHost["paths"] | null {
  return host()?.paths ?? null;
}

// ==========================================================================
// AI 门面
// --------------------------------------------------------------------------
// 面板只调这里的函数，不直接碰 window.bweHost。三种模式：
//   1. desktop + 有宿主 AI 实现 → 转发给主进程（真模型、真流式、真用量）
//   2. desktop 但宿主没实现 AI → mock
//   3. web（没有宿主）→ mock
//
// mock 不是"假成功"：它显式告诉调用方 mode:"mock"、ready:false，
// 并推一段带标记的本地流。这样界面在没有 API key 时依然可点、可演示、
// 可以截图验收，而不会假装自己调通了模型。
// ==========================================================================

/** mock 模式下的模型名：让用户一眼看出"这是演示"，不是一个真实模型 */
const MOCK_MODELS = { flash: "mock-flash", pro: "mock-pro" };

/**
 * 网页版 / 无 key 时的本地回答。
 * 内容刻意写成「能指导人继续干活」的模板，而不是空话：
 * 用户点「解释当前脚本错误」时，至少能得到"去哪看、下一句该问什么"。
 */
function mockAnswer(req: AiChatRequest): string {
  const ctx = req.context ?? {};
  const lines: string[] = [];
  if (ctx.diagnostics && ctx.diagnostics.errors > 0) {
    lines.push(`检测到 ${ctx.diagnostics.errors} 条脚本错误。第一条：`);
    lines.push(`  ${ctx.diagnostics.firstError ?? "（没有可读的错误文本，去「问题」面板看原文）"}`);
    lines.push("");
    lines.push("建议顺序：先修语法/字段名这类立刻能改的，再看运行时 null 与类型不匹配。");
  } else if (req.intent === "edit-script") {
    lines.push("当前没有脚本错误可以拿来对照。要改脚本，请先把光标所在函数贴进输入框，");
    lines.push("并说明期望行为（「移动更快」「撞墙停住」），我会给你一段可直接替换的代码。");
  } else if (req.intent === "scene-review") {
    lines.push("已收到工程摘要（脱敏后的对象数量与脚本清单，不含素材二进制）。");
    lines.push("审场景时我会优先看三件事：碰撞体是否覆盖可达区域、图层排序是否被 y 覆盖、");
    lines.push("脚本里是否存在每帧 new 对象或全量遍历。");
  } else {
    lines.push("我现在处于**本地演示模式**（没有检测到桌面端 AI 宿主或 API Key），回答来自内置模板。");
    lines.push("接上桌面客户端并在「设置 → AI」里填 DeepSeek API Key 后，这里会变成真流式对话，");
    lines.push("并且会在下方用量条里实时显示缓存命中率与本次消耗的 token。");
  }
  lines.push("");
  lines.push(`工程摘要：${(ctx.sceneDigest ?? "未提供").split("\n")[0]}`);
  return lines.join("\n");
}

/** mock 流：逐块吐字，速度按 18 字符/40ms 模拟真实流式，便于观察面板行为 */
function mockStream(cb: (ev: AiEvent) => void, req: AiChatRequest): () => void {
  const model: AiModel = req.intent === "scene-review" || req.intent === "edit-script" ? "pro" : "flash";
  const text = mockAnswer(req);
  const usage: TokenUsage = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reason: "mock：本地模板，不产生任何计费"
  };
  let i = 0;
  let cancelled = false;
  cb({ type: "route", requestId: req.requestId, model, reason: "本地演示模式（无宿主/无 key）", localOnly: true });
  const timer = window.setInterval(() => {
    if (cancelled) return;
    const next = text.slice(i, i + 18);
    i += 18;
    if (next) {
      usage.outputTokens += 4; // 粗略：18 字符 ≈ 4 token，只为让用量条有数可动
      cb({ type: "delta", requestId: req.requestId, text: next });
      return;
    }
    window.clearInterval(timer);
    cb({
      type: "done",
      requestId: req.requestId,
      text,
      usage: { ...usage, outputTokens: Math.ceil(text.length / 4.5) },
      cacheHitRate: 0,
      savedUsdApprox: 0
    });
  }, 40);
  return () => {
    cancelled = true;
    window.clearInterval(timer);
  };
}

const mockCancels = new Map<string, () => void>();
const mockListeners = new Set<(ev: AiEvent) => void>();

export async function aiStatus(): Promise<AiStatus> {
  const h = host();
  if (h?.aiStatus) {
    try {
      return await h.aiStatus();
    } catch {
      /* 宿主实现抛错 → 退化成 mock 状态，不让面板空白 */
    }
  }
  return {
    provider: "mock",
    ready: false,
    mode: "mock",
    message: h
      ? "桌面端已连接，但主进程没有提供 AI 能力（检查 desktop/lib/ai 是否加载成功）。"
      : "网页版没有 AI 宿主。用桌面客户端（BWE Studio.exe）才能连真模型；这里先按本地演示模式工作。",
    models: MOCK_MODELS
  };
}

export async function aiChat(req: AiChatRequest): Promise<{ requestId: string }> {
  const h = host();
  if (h?.aiChat) {
    try {
      const r = await h.aiChat(req);
      return { requestId: r?.requestId ?? req.requestId };
    } catch {
      /* 落到 mock */
    }
  }
  mockCancels.get(req.requestId)?.();
  mockCancels.set(req.requestId, mockStream((ev) => mockListeners.forEach((l) => l(ev)), req));
  return { requestId: req.requestId };
}

export async function aiCancel(requestId: string): Promise<void> {
  const h = host();
  if (h?.aiCancel) {
    try {
      await h.aiCancel(requestId);
      return;
    } catch {
      /* 忽略 */
    }
  }
  mockCancels.get(requestId)?.();
  mockCancels.delete(requestId);
}

export async function aiReset(): Promise<void> {
  for (const c of mockCancels.values()) c();
  mockCancels.clear();
  const h = host();
  if (h?.aiReset) {
    try {
      await h.aiReset();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 订阅流式事件。
 * 桌面宿主与 mock 两路合并到同一个回调，面板不需要知道当前是哪一路。
 */
export function onAiEvent(cb: (ev: AiEvent) => void): () => void {
  mockListeners.add(cb);
  const offHost = host()?.onAiEvent?.(cb);
  return () => {
    mockListeners.delete(cb);
    try {
      offHost?.();
    } catch {
      /* 忽略 */
    }
  };
}

/** 原生菜单命令（新建/打开/保存/打包…）。网页版没有菜单，返回空取消函数。 */
export function onMenuCommand(cb: (c: string) => void): () => void {
  return host()?.onMenuCommand?.(cb) ?? (() => void 0);
}

// ==========================================================================
// 模型管理门面
// --------------------------------------------------------------------------
// 「切换模型」在桌面版是主进程的职责（它持有设置、能读 Trae 配置、能探测 baseUrl）。
// 渲染侧只调这三个函数，全部**永不抛错**：网页版返回「只有 mock 两条」的清单，
// 让面板的下拉框永远有内容可选，而不是空白。
// ==========================================================================

/** 网页版 / 无宿主时的清单：只有 mock 两条，明确告诉用户这不是真的模型。 */
function mockModels(): AiModelsState {
  return {
    active: "mock-flash",
    models: [
      {
        id: "mock-flash",
        label: "本地演示 flash",
        provider: "mock",
        baseUrl: "",
        model: "mock-flash",
        ready: true,
        needsKey: false,
        source: "preset"
      },
      {
        id: "mock-pro",
        label: "本地演示 pro",
        provider: "mock",
        baseUrl: "",
        model: "mock-pro",
        ready: true,
        needsKey: false,
        source: "preset"
      }
    ]
  };
}

export async function aiModels(): Promise<AiModelsState> {
  const h = host();
  if (h?.aiModels) {
    try {
      const r = await h.aiModels();
      if (r && Array.isArray(r.models) && r.models.length) return r;
    } catch {
      /* 落到 mock 清单 */
    }
  }
  return mockModels();
}

export async function aiSetModel(id: string, apiKey?: string): Promise<AiModelsState> {
  const h = host();
  if (h?.aiSetModel) {
    try {
      const r = await h.aiSetModel(String(id ?? ""), apiKey);
      if (r && Array.isArray(r.models)) return r;
    } catch {
      /* 落到 mock 清单 */
    }
  }
  return mockModels();
}

/**
 * 手动添加 / 覆盖一条模型。
 *
 * 判重规则在主进程（`modelCatalog.mjs`，有单测）：同 provider + 同 baseUrl + 同 model
 * 算同一条，**就地更新并保留原 id** —— 所以「给 Trae 导入的条目手填 key」不会变成第三条。
 * 渲染侧不要自己再写一套判重，两边规则漂移是最难查的那类不一致。
 */
export async function aiAddModel(input: AiModelInput): Promise<AiModelsState> {
  const h = host();
  if (h?.aiAddModel) {
    try {
      const r = await h.aiAddModel(input);
      if (r && Array.isArray(r.models)) return r;
    } catch {
      /* 落到 mock 清单 */
    }
  }
  // 网页版没有模型管理：把用户刚填的这条**本地可见地加进 mock 清单**，
  // 让面板的下拉框能显示「你填了但这里用不了」，而不是点了没反应。
  const base = mockModels();
  const model = String(input?.model ?? "").trim();
  if (!model) return base;
  const id = `mock:${model}`;
  return {
    active: base.active,
    models: [
      ...base.models,
      {
        id,
        label: input?.label?.trim() || model,
        provider: String(input?.provider ?? "mock"),
        baseUrl: String(input?.baseUrl ?? ""),
        model,
        ready: false,
        needsKey: !String(input?.apiKey ?? "").trim(),
        source: "manual",
        contextWindow: input?.contextWindow
      }
    ]
  };
}

/**
 * 从本机 Trae 的配置里导入供应商/模型。
 *
 * 注意返回值里 `warnings` 是**一等内容**而不是装饰：Trae 的 API Key 是设备绑定的、
 * 无法导出，所以导入来的条目几乎一定 `needsKey: true`，界面必须把这句话显示出来，
 * 而不是让用户点了「导入」之后以为已经能用了。
 */
export async function aiImportTrae(): Promise<{ ok: boolean; providers: AiModelEntry[]; warnings: string[] }> {
  const h = host();
  if (h?.aiImportTrae) {
    try {
      const r = await h.aiImportTrae();
      if (r && Array.isArray(r.providers)) return r;
    } catch (e) {
      return { ok: false, providers: [], warnings: [`读取 Trae 配置失败：${(e as Error)?.message || e}`] };
    }
  }
  return {
    ok: false,
    providers: [],
    warnings: [
      "网页版读不到本机 Trae 配置。用桌面客户端（BWE Studio.exe）才能导入；导入后仍需手动填写 API Key。"
    ]
  };
}

/**
 * 真实探测一条模型的连通性。
 *
 * 只在用户点「测试连接」时调 —— **绝不放进清单加载路径**：清单里有 N 条模型，
 * 逐个探活会把面板打开拖成几秒，还会在用户没要求时打 N 个网络请求。
 *
 * 归一化职责在这里做，不在面板里做：主进程的叫法（`status` / `latencyMs` / `reason`）
 * 与 UI 想要的分类（`httpStatus` / `ms` / `kind`）不同，两处各自映射一次必然漂移。
 * 所以这里统一转成 `AiProbeResult` 的字段，并把 `reason` 归一成 UI 那七类。
 */
export async function probeModel(id: string): Promise<AiProbeResult> {
  const h = host();
  if (!h?.probeModel) {
    return {
      ok: null,
      reason: "unsupported",
      detail: "当前宿主没有探测通道：网页版没有本地网络权限，用桌面客户端才能测真实连通性"
    };
  }
  try {
    const r = await h.probeModel(String(id ?? ""));
    const status = Number(r?.status ?? 0);
    // 主进程的 reason 已是机器可读分类（ok/auth/dns/timeout/network/...），
    // 这里只做一件事：当它缺失时按 HTTP 状态码补一个，避免 UI 拿到空字符串。
    const reason =
      String(r?.reason ?? "").trim() ||
      (status >= 200 && status < 300
        ? "ok"
        : status === 401 || status === 403
          ? "auth"
          : status === 0
            ? "network"
            : "http-error");
    return {
      ok: r?.ok === undefined ? null : r.ok,
      id,
      status,
      reachable: r?.reachable,
      method: r?.method,
      detail: r?.detail,
      reason,
      errorCode: r?.errorCode,
      latencyMs: r?.latencyMs
    };
  } catch (e) {
    return {
      ok: false,
      id,
      status: 0,
      reason: "error",
      detail: `探测时出错：${(e as Error)?.message || e}`
    };
  }
}

/** 原生「打开工程」被触发时，主进程把内容直接送进来（网页版打开走自己的对话框）。 */
export function onOpenProjectRequest(cb: (path: string, content: string) => void): () => void {
  const h = host() as BweHost & {
    onOpenProjectRequest?: (cb: (path: string, content: string) => void) => () => void;
  };
  return h?.onOpenProjectRequest?.(cb) ?? (() => void 0);
}

// ==========================================================================
// 多会话门面
// --------------------------------------------------------------------------
// 四个函数全部**永不抛错**：无宿主时返回空状态（UI 据此隐藏整个入口），
// 而不是白屏或红条。桌面版把具体行为交给主进程（那里有存储、迁移、竞态处理）。
//
// 归一化职责在这里：主进程的字段（`updatedAt` / `messageCount` / `aborted`）
// 与 UI 想要的形状一旦分叉，就会出现「两端各自映射」那类静默失效，
// 所以下面每个返回值都强制补上默认值，UI 不需要再做 `??` 兜底。
// ==========================================================================

/** 网页版 / 无宿主时的空状态：`sessions: []` 让 UI 自然隐藏会话入口。 */
function emptySessions(): AiSessionsState {
  return { ok: true, sessions: [], active: "", aborted: 0 };
}

/** 把主进程返回的对象归一成完整形状（缺字段补默认，UI 不用兜底）。 */
function normalizeSessions(raw: unknown): AiSessionsState {
  const r = (raw ?? {}) as Partial<AiSessionsState>;
  return {
    ok: r.ok !== false,
    sessions: Array.isArray(r.sessions)
      ? r.sessions.map((s) => ({
          id: String(s?.id ?? ""),
          title: String(s?.title ?? "") || "未命名会话",
          createdAt: Number(s?.createdAt ?? 0),
          updatedAt: Number(s?.updatedAt ?? 0),
          messageCount: Number(s?.messageCount ?? 0)
        }))
      : [],
    active: String(r.active ?? ""),
    aborted: Number(r.aborted ?? 0),
    error: r.error
  };
}

export async function aiSessionsList(): Promise<AiSessionsState> {
  const h = host();
  if (!h?.aiSessionsList) return emptySessions();
  try {
    return normalizeSessions(await h.aiSessionsList());
  } catch {
    return emptySessions();
  }
}

export async function aiSessionNew(title?: string): Promise<AiSessionsState & { id?: string }> {
  const h = host();
  if (!h?.aiSessionNew) return emptySessions();
  try {
    const raw = (await h.aiSessionNew(title)) as AiSessionsState & { id?: string };
    return { ...normalizeSessions(raw), id: raw?.id };
  } catch {
    return emptySessions();
  }
}

/**
 * 切换会话。
 *
 * 返回的 `messages` **已由主进程过滤掉 system 前缀块** —— UI 直接渲染，
 * 不要自己再过滤一遍（会误删正常消息）。这里只保证数组存在且字段齐。
 */
export async function aiSessionSwitch(id: string): Promise<AiSessionsState & { messages?: AiSessionMessage[] }> {
  const h = host();
  if (!h?.aiSessionSwitch) return emptySessions();
  try {
    const raw = (await h.aiSessionSwitch(String(id ?? ""))) as AiSessionsState & { messages?: unknown };
    const list = Array.isArray(raw?.messages) ? (raw.messages as AiSessionMessage[]) : [];
    return {
      ...normalizeSessions(raw),
      messages: list
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({
          role: m.role,
          text: String(m.text ?? ""),
          tools: Array.isArray(m.tools) ? m.tools : undefined,
          streaming: false // 切过来的历史消息一定不在流式生成中
        }))
    };
  } catch {
    return emptySessions();
  }
}

export async function aiSessionDelete(id: string): Promise<AiSessionsState> {
  const h = host();
  if (!h?.aiSessionDelete) return emptySessions();
  try {
    return normalizeSessions(await h.aiSessionDelete(String(id ?? "")));
  } catch {
    return emptySessions();
  }
}

/** 会话能力是否可用（网页版没有存储，入口应整个隐藏而不是显示成空列表）。 */
export function sessionsAvailable(): boolean {
  return Boolean(host()?.aiSessionsList);
}
