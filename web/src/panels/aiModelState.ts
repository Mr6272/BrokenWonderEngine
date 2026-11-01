/**
 * 模型状态语义 + 连通性探测（AI 面板的单一事实来源）。
 *
 * 为什么单独一层：这套语义在面板里有三处消费（顶部常驻 chip、用量条 chip、
 * 下拉项后缀）。上一轮就踩过一次"三处各写一份判断、其中一处路径根本不走"的坑
 * ——`entryHint` 判断了 `listModels()` 根本不产出的 `reachable` 字段，
 * 代码看着实现了，实际永不触发，且不报错。抽成单点后再加消费方就不会走偏。
 *
 * ⚠ 核心语义（这条必须记住，否则所有文案都会写错）：
 *   `ready` 只代表「**配置齐了**」（有 key、有 baseUrl、有模型名），
 *   **不代表「连得上」** —— 主进程的 `fromEntry()` 从不发网络请求。
 *   所以 UI 文案绝不能写「可用」：那是在替引擎保证它自己保证不了的事。
 *   真正的连通性只能靠用户主动点「测试连接」验（probeModel）。
 */

import { probeModel as hostProbeModel } from "../core/host.ts";
import type { AiModelEntry } from "../core/host.ts";

/**
 * 模型状态的三种（加 mock 一种）语义。
 *
 * | kind        | 含义                    | 用户下一步      |
 * |-------------|-------------------------|-----------------|
 * | configured  | 配置齐了，没测过连通性  | 点「测试连接」  |
 * | needs-key   | 这条还缺 API Key        | 填 key          |
 * | incomplete  | 配置不全（缺 url/模型名）| 补配置          |
 * | mock        | 本地演示，不发网络请求  | 无需处理        |
 */
export type ModelStateKind = "configured" | "needs-key" | "incomplete" | "mock";

export interface ModelState {
  kind: ModelStateKind;
  /** 给 chip 用的短标签（不能写「可用」，见文件头） */
  short: string;
  /** 为什么不可用 / 为什么还不能确认可用（给 tooltip） */
  why: string;
  /** chip 的样式类（pro = 正常，warn = 需要处理，flash = 演示） */
  cls: string;
}

/** 由一条模型条目（+ 当前是否 mock 模式）算出展示语义。 */
export function modelStateOf(entry: AiModelEntry | null, mock: boolean): ModelState {
  if (mock || !entry) {
    return {
      kind: "mock",
      short: "本地演示",
      why: "本地模板回答，不发网络请求",
      cls: "flash"
    };
  }
  if (entry.needsKeyMissing) {
    return {
      kind: "needs-key",
      short: "待填 key",
      why: "这条模型还没有 API Key，现在发不出请求",
      cls: "warn"
    };
  }
  if (!entry.ready) {
    return {
      kind: "incomplete",
      short: "配置不全",
      why: entry.reason || "配置不完整（检查服务地址与模型名）",
      cls: "warn"
    };
  }
  // 关键：这里是「已配置」不是「可用」——配置齐 ≠ 连得上
  return {
    kind: "configured",
    short: "已配置",
    why:
      entry.hasApiKey
        ? "配置齐全，且已有 API Key；但还没测过连通性 —— 点「测试连接」可验证"
        : "配置齐全（未检测到 API Key）；点「测试连接」可验证是否真的能连",
    cls: "pro"
  };
}

/** 下拉项后缀：只说"缺什么"，不说"能不能用"。 */
export function modelStateSuffix(entry: AiModelEntry): string {
  if (entry.needsKeyMissing) return "需要填 API Key";
  if (!entry.ready) return entry.reason ? `配置不全：${truncate(entry.reason, 32)}` : "配置不全";
  return "";
}

/**
 * 「这条是否真的缺 key」的唯一判断入口。
 *
 * 面板侧不许再直接读 `entry.needsKeyMissing` —— 那会重新变成"两端各自判断"
 * （`needsKey`（供应商类型需要 key）与 `needsKeyMissing`（这一条缺 key）混淆过一次，
 *   把已填 key 的 DeepSeek 误标成"需要填 key"）。所有判断都从这里走。
 */
export function isNeedsKey(entry: AiModelEntry | null): boolean {
  return modelStateOf(entry, false).kind === "needs-key";
}

/** 清单里"待填 key"的条数（计数文案用，同样不许面板自己 filter 原始字段）。 */
export function countNeedsKey(entries: AiModelEntry[]): number {
  return entries.filter((m) => modelStateOf(m, false).kind === "needs-key").length;
}

/** 「这条现在能不能直接发请求」的唯一判断入口（不要用 entry.ready 直接判）。 */
export function canUseNow(entry: AiModelEntry | null): boolean {
  return modelStateOf(entry, false).kind === "configured";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ============================================================================
// ============================================================================
// 连通性探测（用户主动触发）
// ============================================================================

/**
 * 探测结果分类。
 *
 * 为什么必须分档而不是一个「连接失败」——每一档的排查方向完全不同：
 *   ok        → 真的能连，可以直接用
 *   auth      → key 不对 / 已失效        → 重新填 key
 *   dns       → 域名解析不了             → 检查 baseUrl 拼写 / 网络
 *   timeout   → 连上了但没回应           → 检查代理 / 目标服务是否在跑
 *   network   → 连接被拒 / 端口不对      → 检查地址与端口
 *   http      → 拿到了响应但状态码异常   → 看状态码与服务端日志
 *   unknown   → **判不出来**（既不是成功也不是失败）
 *   unsupported → 当前环境没有探测通道   → 用桌面客户端
 *   error     → 探测过程本身出错
 *
 * `unknown` 单独成一档是主进程刻意的设计（`ok === null`）：
 * 例如探测打的是 `/models` 端点，该端点权限要求比对话接口更高，
 * 401 并不代表对话不可用 —— 这时既不能说"能连"，也不该说"key 错了"。
 * **把 null 压成布尔是最容易犯的错**，那样会把"判不出来"误报成"不可用"。
 */
export type ProbeKind =
  | "ok"
  | "auth"
  | "dns"
  | "timeout"
  | "network"
  | "http"
  | "unknown"
  | "unsupported"
  | "error";

export interface ProbeResult {
  kind: ProbeKind;
  /** 一句话结论（结果区主文案） */
  headline: string;
  /** 下一步该做什么（结果区副文案） */
  next: string;
  /** 原始细节：HTTP 状态码 / 错误码 / 主进程给的 detail */
  detail: string;
  /** 耗时（毫秒）：能区分"慢"还是"断" */
  latencyMs?: number;
  /** HTTP 状态码（没拿到响应时为 0） */
  status?: number;
  /** 探测方式（GET 哪个端点等），便于排查 */
  method?: string;
}

/**
 * 各档文案（单点定义，避免各处漂移）。
 * 文案刻意写"下一步动作"，而不是只写"失败了" —— 用户要的是接下来干什么。
 */
const PROBE_COPY: Record<ProbeKind, { headline: string; next: string }> = {
  ok: {
    headline: "连接正常",
    next: "这条模型可以使用，直接发消息即可"
  },
  auth: {
    headline: "API Key 被拒绝",
    next: "点下拉重新选中它，在弹出的输入框里重新填 Key"
  },
  dns: {
    headline: "域名解析失败",
    next: "检查「服务地址」是否写错（漏了 https:// 或域名拼错）"
  },
  timeout: {
    headline: "请求超时",
    next: "检查本机网络 / 代理设置，或确认目标服务正在运行"
  },
  network: {
    headline: "连不上服务",
    next: "地址或端口可能不对；确认服务已启动、端口没有写错"
  },
  http: {
    headline: "服务返回异常状态",
    next: "看下面的状态码与服务端日志；地址通常是对的，问题在服务侧"
  },
  unknown: {
    headline: "无法确定可用性",
    next:
      "探测端点与对话接口权限不同，这次结果既不能证明能用、也不能证明不能用。"
      + "建议直接发一条短消息验证"
  },
  unsupported: {
    headline: "当前环境无法测试",
    next: "网页版没有本地网络权限；用桌面客户端才能测真实连通性"
  },
  error: {
    headline: "探测过程出错",
    next: "看下面的细节；必要时把服务地址贴出来排查"
  }
};

/**
 * 主进程 `reason` + 三态 `ok` → UI 分档。
 *
 * ⚠ **判定顺序至关重要**：三态 `ok` 是权威信号，必须先看它，reason 只用来细分。
 * 曾经写成"先查 reason 表" → 404 那种 `ok:null` + `reason:"http-error"` 被映射成
 * `http`（"服务返回异常"），把"判不出来"误报成了"确定有问题" —— 方向性的错。
 *
 * 规则：
 *   ok === null            → unknown（除了 unsupported，那是环境问题不是模型问题）
 *   ok === true            → ok
 *   ok === false + reason  → 用 reason 细分（auth/dns/timeout/network/http/error）
 */
function classifyProbe(reason: string, ok: boolean | null, status: number): ProbeKind {
  const r = reason.trim().toLowerCase();

  // ---- 1. 环境问题优先（与模型本身无关）----
  if (r === "unsupported") return "unsupported";

  // ---- 2. 三态优先：null 就是判不出来，不管 reason 写了什么 ----
  if (ok === null) return "unknown";

  // ---- 3. 明确成功 ----
  if (ok === true) return "ok";

  // ---- 4. 明确失败：用 reason 细分下一步动作 ----
  if (r === "auth" || r === "unauthorized" || r === "unauthorized-on-models") return "auth";
  if (r === "dns") return "dns";
  if (r === "timeout") return "timeout";
  if (r === "network") return "network";
  if (r === "http-error" || r === "http") return "http";
  if (r === "error") return "error";

  // reason 不认识但 ok 明确失败：按状态码兜底
  if (status === 401 || status === 403) return "auth";
  if (status === 0) return "network";
  return "http";
}

/** @deprecated 见 classifyProbe（保留名字避免遗漏调用点，内部直接转发） */
function kindFromReason(reason: string, ok: boolean | null, status: number): ProbeKind {
  return classifyProbe(reason, ok, status);
}

/**
 * 探测一条模型能否真的连上。
 *
 * 只在用户点「测试连接」时调用 —— **绝不放进清单加载路径**：
 * 清单里有 N 条模型，逐个探活会把面板打开拖成几秒，还会在用户没要求时打 N 个网络请求。
 *
 * 归一化交给 `host.ts` 的 probeModel 门面（主进程的 status/latencyMs/reason
 * 与 UI 想要的字段不同，两处各自映射必然漂移 —— 这一轮就是这么断的）。
 */
export async function probeModelOf(entry: AiModelEntry): Promise<ProbeResult> {
  // mock 不发网络请求：直接说清楚「本地演示，未验证网络」，不要假装测过
  if (entry.provider === "mock") {
    return {
      kind: "ok",
      headline: "本地演示模型",
      next: "它不发网络请求，无需测试；接入真实模型后才需要验证连通性",
      detail: "provider=mock",
      status: 0
    };
  }

  let r;
  try {
    r = await hostProbeModel(entry.id);
  } catch (e) {
    return {
      kind: "error",
      headline: PROBE_COPY.error.headline,
      next: PROBE_COPY.error.next,
      detail: (e as Error)?.message || String(e)
    };
  }

  const status = Number(r.status ?? 0);
  // 三态 ok 是权威信号：ok===null 时无论 reason 是什么都应判 unknown
  const kind = classifyProbe(String(r.reason ?? ""), r.ok ?? null, status);
  const copy = PROBE_COPY[kind];

  // detail：主进程的 detail 已经是人话（含错误码），直接展示；
  // 再补上状态码，方便对日志。
  const bits: string[] = [];
  if (r.detail) bits.push(r.detail);
  if (status) bits.push(`HTTP ${status}`);
  if (r.errorCode) bits.push(String(r.errorCode));
  const detail = bits.length ? bits.join(" · ") : "（主进程没有返回更多细节）";

  return {
    kind,
    headline: copy.headline,
    next: copy.next,
    detail,
    latencyMs: typeof r.latencyMs === "number" ? r.latencyMs : undefined,
    status,
    method: r.method
  };
}
