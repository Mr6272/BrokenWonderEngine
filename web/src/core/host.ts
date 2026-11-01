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
  | { type: "delta"; requestId: string; text: string }
  | { type: "tool"; requestId: string; name: string; detail: string }
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

/** 原生「打开工程」被触发时，主进程把内容直接送进来（网页版打开走自己的对话框）。 */
export function onOpenProjectRequest(cb: (path: string, content: string) => void): () => void {
  const h = host() as BweHost & {
    onOpenProjectRequest?: (cb: (path: string, content: string) => void) => () => void;
  };
  return h?.onOpenProjectRequest?.(cb) ?? (() => void 0);
}
