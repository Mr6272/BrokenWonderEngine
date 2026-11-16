/**
 * AI 助手面板。
 *
 * 纪律（对应 docs/desktop-migration.md §3 / §4）：
 *   1. **只经 core/host.ts 的 AI 门面调用**，从不直接碰 window.bweHost。
 *      网页版 / 无 key / 桌面版三种状态在面板看来是同一件事，只是
 *      aiStatus().mode 不同 —— 面板不需要为"有没有宿主"写分支。
 *   2. **绝不把整个 .bwproj 塞进请求**：上下文只带 sceneDigest（压缩后的几行
 *      文字）+ 诊断摘要 + 当前脚本片段（超过 200 行截断）。
 *   3. **改脚本：AI 有直接写权限，但必须可撤销**。
 *      桌面版里 AI 通过 ListScripts / ReadScript / WriteScript / PatchScript / DeleteScript
 *      直接改**工程内脚本**（不是任意文件），每次改动都走 applyAiScript →
 *      markDirty + commit 快照，用户一条 Ctrl+Z 就能撤回。
 *      面板里的「diff 预览 + 应用」这条旧路径**仍然保留**：模型若在正文里贴代码块，
 *      用户可以只应用其中一段（比让模型直接写更可控）。两条路径并存、互不妨碍。
 *   4. 无 key / mock 模式面板照样能用：顶部一条提示语，mock 流在回答里
 *      明说"这是本地演示"，用户不会误以为调通了模型。
 */

import { el, button, svg } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { store } from "../core/store.ts";
import { isUiScene, scriptLang, scriptNamesOfLang, type Project, type SceneModel } from "../core/model.ts";
import { allProblems } from "../core/diagnostics.ts";
import { appendOutput } from "../core/output.ts";
import { modelStateOf, modelStateSuffix, isNeedsKey, needsReKey, countNeedsKey, countKeyBroken, canUseNow, probeModelOf, type ProbeResult } from "./aiModelState.ts";
import { beginThinking, applyThinkingEvent, endThinking, currentThinking, thinkingText, thinkingNeedsStop, freezeThinkingForDemo } from "./aiThinking.ts";
import {
  aiStatus,
  aiChat,
  aiCancel,
  aiReset,
  aiModels,
  aiSetModel,
  aiAddModel,
  aiRemoveModel,
  aiImportTrae,
  onAiEvent,
  type AiEvent,
  type AiStatus,
  type AiChatRequest,
  type AiModel,
  type AiModelEntry,
  type AiModelInput,
  type AiModelsState,
  type TokenUsage
} from "../core/host.ts";
import { error, info, modal, ok, warn, confirmDialog } from "../ui/toast.ts";
import { renderSessionSwitcher, renderSessionSidebar, type SessionSidebar } from "./aiSessions.ts";
import { presentError, type ErrorPresentation } from "./aiErrorView.ts";
import { answerNotices, type AnswerNotice } from "./aiAnswerNotice.ts";
import { keyBrokenViewOf } from "./keyBrokenView.ts";
import { zoneFor, summarizeAgent, type AiStreamBlock, type AiStreamKind, type AgentSummary } from "./aiZones.ts";

// ============================================================================
// 工程摘要（契约 §4.5）—— 唯一允许进入 prompt 的工程信息
// ============================================================================


const KIND_CN: Record<string, string> = {
  ACTOR: "角色",
  PROP: "物件",
  TILE: "瓦片",
  ZONE: "触发区",
  SPAWN: "出生点",
  PORTAL: "传送门",
  LIGHT: "灯光"
};

/**
 * 生成压缩摘要。
 *
 * 格式照契约 §4.5：工程头 / 每条场景一行 / 选中 / 脚本错误。
 * 为什么压到这种程度：全量 .bwproj 动辄几百 KB（素材内联 base64），每轮都发
 * 等于每轮烧掉整个上下文窗口；而"这个工程长什么样"真正需要的信息只有规模、
 * 构成与错误 —— 这几行足够，且稳定不变的部分还能吃到前缀缓存。
 */
export function buildSceneDigest(): string {
  const p = store.project;
  if (!p) return "工程：未打开";

  const lines: string[] = [];
  lines.push(
    `工程「${p.name || "未命名工程"}」 ${p.scenes.length} 场景 / ${p.assets.length} 素材 / tileSize ${p.tileSize}`
  );

  for (const scene of p.scenes) {
    const counts = countKinds(scene);
    const parts: string[] = [];
    if (counts.tile) parts.push(`瓦片 ${counts.tile}`);
    if (counts.sprite) parts.push(`精灵 ${counts.sprite}`);
    if (counts.zone) parts.push(`触发区 ${counts.zone}`);
    if (counts.other) parts.push(`其他 ${counts.other}`);
    const scripts = scriptsOfScene(p, scene);
    const scriptText = scripts.length ? `，脚本 ${scripts.length}（${scripts.join(", ")}）` : "";
    const kind = isUiScene(scene) ? "UI 场景" : "世界场景";
    lines.push(`- ${kind} ${scene.name}：${scene.objects.length} 对象（${parts.join(" / ") || "空"}）${scriptText}`);
  }

  const sel = store.selection;
  if (sel.length) {
    const kinds = sel.slice(0, 4).map((o) => `${KIND_CN[o.kind] ?? o.kind}「${o.name}」`);
    const more = sel.length > 4 ? ` 等 ${sel.length} 个` : "";
    lines.push(`选中：${sel.length} 个（${kinds.join("、")}${more}）`);
  } else {
    lines.push("选中：无");
  }

  const probs = allProblems().filter((x) => x.severity === "error");
  if (probs.length) {
    const first = probs[0];
    const where = first.scriptName
      ? `${first.scriptName}${first.line ? `:${first.line}` : ""}`
      : first.sourceLabel;
    lines.push(`脚本错误：${probs.length} 条（${where} ${truncate(first.message, 120)}）`);
  } else {
    lines.push("脚本错误：0 条");
  }

  return lines.join("\n");
}

function countKinds(scene: SceneModel): { tile: number; sprite: number; zone: number; other: number } {
  const out = { tile: 0, sprite: 0, zone: 0, other: 0 };
  for (const o of scene.objects) {
    if (o.kind === "TILE") out.tile++;
    else if (o.kind === "ZONE") out.zone++;
    else if (o.kind === "ACTOR" || o.kind === "PROP") out.sprite++;
    else out.other++;
  }
  return out;
}

/** 某个场景用到的脚本名：对象上挂的 + 场景脚本；只保留工程里真实存在的。 */
function scriptsOfScene(p: Project, scene: SceneModel): string[] {
  const names = new Set<string>();
  if (scene.onStartScript) names.add(scene.onStartScript);
  for (const o of scene.objects) {
    for (const m of o.modules) {
      const s = m.values?.["script"] ?? m.values?.["scriptName"];
      if (typeof s === "string" && s.trim()) names.add(s.trim());
    }
  }
  return Array.from(names).filter((n) => !!p.scripts[n]);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ============================================================================
// 当前脚本 / 诊断上下文
// ============================================================================

/** 当前正在编辑的脚本：剧本面板切页时广播 bwe:script-focus。 */
let activeScriptName = "";

try {
  window.addEventListener("bwe:script-focus", (e) => {
    const d = (e as CustomEvent<{ name?: string }>).detail;
    if (d?.name) activeScriptName = d.name;
  });
} catch {
  /* 非浏览器环境（构建期工具）忽略 */
}

/**
 * 取"AI 该看哪段脚本"。
 *
 * 优先用户正在编的那段；没有就取第一段 JS。截断到 200 行：
 * 长脚本整段发出去既贵、也容易被模型忽略中段。
 */
function activeScriptContext(): { name: string; lang: "js" | "yarn"; code: string } | undefined {
  const p = store.project;
  if (!p) return undefined;
  let name = activeScriptName;
  if (!name || !p.scripts[name]) {
    const jsNames = scriptNamesOfLang(p, "js");
    const yarnNames = scriptNamesOfLang(p, "yarn");
    name = jsNames[0] ?? yarnNames[0] ?? "";
    if (!name) return undefined;
  }
  const entry = p.scripts[name];
  if (!entry) return undefined;
  const lang = scriptLang(entry);
  const raw = entry.source ?? "";
  const lines = raw.split("\n");
  const code = lines.length > 200
    ? lines.slice(0, 200).join("\n") + `\n// …（共 ${lines.length} 行，已截断前 200 行）`
    : raw;
  return { name, lang, code };
}

/** 诊断摘要：只给条数与第一条原文（§4.1 context.diagnostics 的形状）。 */
function diagnosticsContext(): { errors: number; firstError?: string } | undefined {
  const probs = allProblems().filter((x) => x.severity === "error");
  if (!probs.length) return undefined;
  const first = probs[0];
  const where = first.scriptName ? `${first.scriptName}${first.line ? `:${first.line}` : ""} ` : "";
  return { errors: probs.length, firstError: `${where}${first.message}` };
}

// ============================================================================
// 面板状态（模块级：切 tab / 重画面板后对话还在）
// ============================================================================

interface ToolCallBlock {
  name: string;
  detail: string;
  /** 主进程给的调用 id：start/end 用它配对，**同名工具连续调用不会串** */
  callId?: string;
  /** 主进程给的耗时（优先）；缺省时 UI 侧按 callId 计时 */
  ms?: number;
  /** 成败：true 成功 / false 失败 / **undefined 未知（老契约，不显示徽标）** */
  ok?: boolean;
  /** 失败时的**完整错误原文**（不截断，用户要拿去搜索/贴给别人） */
  error?: string;
}

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  /** 助手回合的工具调用块（折叠展示） */
  tools: ToolCallBlock[];
  streaming: boolean;
  model?: AiModel;
  reason?: string;
  /** 结构化后的错误（不拼进 text —— 原始 JSON 不该出现在正文里） */
  error?: ErrorPresentation;
  /** 原始错误文本（只在「技术详情」折叠区展示，含 request_id） */
  errorRaw?: string;
  /** 是否可重试（决定要不要给重试按钮） */
  recoverable?: boolean;
  /**
   * 这条回答「为什么可能不完整」的结构化说明（工具预算耗尽 / max_tokens 截断）。
   *
   * 存在这里而不是直接 append 到 DOM：`renderThread()` 是整树重建，
   * 只拼 DOM 的提示会在下一次重绘（切会话、窗口 resize 后重画）时消失 ——
   * 那正是「用户看不到解释」的老问题。
   * 字段缺省/判定不出来时保持 `undefined`，renderThread **完全不渲染**（不出空条）。
   */
  notices?: AnswerNotice[];
  /**
   * 「这一轮为什么什么都没产出」的一句话说明（正文为空且没有任何结构化提示时）。
   *
   * 同样是**数据层**字段而不是 DOM 追加：这条解释的全部价值在于
   * 「用户回头还能看到为什么」，拼进 DOM 的提示会在下一次 renderThread 时消失，
   * 等于只闪了一下就没了。
   */
  note?: string;
}

interface PendingEdit {
  scriptName: string;
  before: string;
  after: string;
}

const HISTORY_MAX = 40;
let turns: ChatTurn[] = [];
let status: AiStatus | null = null;
let statusLoaded = false;
/**
 * 演示模式：注入的 status 不被 `refreshStatus` 的真实拉取覆盖。
 * 为什么需要：demo 注入后 `renderAiPanel` 会重新调 `refreshStatus`，
 * 而它无条件 `status = await aiStatus()` —— 注入值立刻被冲掉。
 */
let statusPinnedForDemo = false;
/** 「统计源不一致」只记一次痕，避免每次重绘都往输出面板刷一行 */
let keyBrokenWarned = false;
let currentRequest = "";
let lastUsage: TokenUsage | null = null;
let lastCacheHit = 0;
let lastSavedUsd = 0;
let lastModel: AiModel | "" = "";
let pendingEdit: PendingEdit | null = null;

let unsubAiEvent: (() => void) | null = null;

/**
 * 面板内部渲染函数槽位。
 *
 * 为什么用槽位而不是把这些函数提到模块层：它们要用面板实例里的 DOM 引用
 * （thread / meter / 按钮），提到模块层就得维护一堆可空变量；而模块层的
 * 流式回调（handleAiEvent）又必须能驱动它们。挂载时把实现填进槽位、
 * 面板关闭后置 null —— 回调总是判空再调，面板没开时只更新数据、不动 DOM。
 */
interface PanelHooks {
  renderThread(): void;
  appendDelta(text: string): void;
  appendToolBlock(tool: ToolCallBlock): void;
  updateMeter(): void;
  /**
   * 一轮结束后刷新会话列表（左栏历史的「N 条 · 刚才」要靠它跟上）。
   *
   * 为什么必须在一轮结束时刷：会话的 `updatedAt/messageCount` 是**这一轮聊完**才变的，
   * 不刷的话左栏会一直写着「还没聊过」—— 用户刚聊完，列表却在否认，看着像没存下来。
   * dock 布局没有常驻列表，所以是可选的（浮层每次打开都会重读）。
   */
  refreshSessions?(): void;
  /** 外壳/命令面板触发一次动作（相当于点了某个按钮） */
  runAction(intent: AiChatRequest["intent"]): void;
  /** 重画「正在思考」提示（phase 变化时调用） */
  renderThinking(): void;
  /** 在对话区插一条系统提示（done 无正文 / error 可重试时用） */
  appendSystemNote(text: string, retryLast?: () => void): void;
  /** 重发上一条用户消息（「重试」按钮） */
  retryLastUserMessage(): void;
  /** 验收出口：灌 n 条假工具调用 + 一问一答（`__BWE__.debugAiStream` 用） */
  injectDemoTools(n: number): void;
}
let hooks: PanelHooks | null = null;

/**
 * 工具调用登记表（**模块级**，因为 `handleAiEvent` 是模块级函数）。
 *
 * 放在模块级还有一个好处：面板重渲染（`host.replaceChildren()`）不会清掉计时状态 ——
 * 工具调用跨重绘仍然能算出耗时。
 *
 * ⚠ **必须用 `callId` 配对，不能用 name**：用户实际遇到「两个同名 SceneDigest
 * 连续调用」—— 按 name 配对会把第一次的 start 配到第二次的 end，
 * 耗时算错、成败甚至会串到另一个块上。
 */
const toolCalls = new Map<string, { t0: number; ms?: number; ok?: boolean; error?: string; detail?: string }>();

function toolKeyOf(ev: { callId?: string; name: string }): string {
  if (ev.callId) return `id:${ev.callId}`;
  // 兼容未升级的主进程：按 name 造键（同 name 多次调用会互相覆盖 ——
  // 明知不完美，但比"完全不显示耗时"好；升级后 callId 会接管）
  return `name:${ev.name}`;
}

/**
 * 处理 `tool` 事件：记录开始/结束，返回本次事件带来的增量信息。
 *
 * 兼容性设计（A 可能分两批落地）：
 *   · `phase` 缺省 → 按 end 处理（老版本不区分 start/end）
 *   · `ms` 缺省 → 用 callId 计时
 *   · `ok` 缺省 → **不显示成败徽标**（不猜 —— 把失败画成绿勾比不显示更糟）
 */
function trackToolEvent(ev: {
  name: string;
  detail: string;
  phase?: "start" | "end";
  callId?: string;
  ok?: boolean;
  error?: string;
  ms?: number;
}): { ms?: number; ok?: boolean; error?: string } {
  const key = toolKeyOf(ev);
  if (ev.phase === "start") {
    toolCalls.set(key, { t0: Date.now(), detail: ev.detail });
    return {};
  }
  const prev = toolCalls.get(key);
  let ms: number | undefined = typeof ev.ms === "number" ? ev.ms : undefined;
  if (ms === undefined && ev.phase === "end" && prev) {
    ms = Date.now() - prev.t0;
  }
  toolCalls.set(key, { t0: prev?.t0 ?? Date.now(), ms, ok: ev.ok, error: ev.error, detail: ev.detail });
  return { ms, ok: ev.ok, error: ev.error };
}


/** 由外壳注入的重画请求（diff 应用后刷新剧本面板） */
let requestRepaint: () => void = () => {};

/** 本面板自己生成的请求 id（uuid）：宿主原样回显，配对靠它，不用自增序号。 */
function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function ensureEventSubscription(): void {
  if (unsubAiEvent) return;
  unsubAiEvent = onAiEvent((ev: AiEvent) => handleAiEvent(ev));
}

/** 最近一轮助手回合（流式写入的目标）。 */
function liveAssistantTurn(): ChatTurn | null {
  const last = turns[turns.length - 1];
  return last && last.role === "assistant" ? last : null;
}

// ============================================================================
// 流式事件 → 数据
// ============================================================================

function handleAiEvent(ev: AiEvent): void {
  // 未知 type 一律忽略：宿主/A 后续可能加事件，面板不该因此崩
  if (!ev || typeof ev !== "object" || !("type" in ev)) return;
  if (!("requestId" in ev) || ev.requestId !== currentRequest) return;

  /**
   * 知识库沉淀事件：广播给知识库面板（它是同一 AI 栏里的另一个标签页）。
   *
   * 为什么用 window 事件而不是直接调 knowledgePanel：两者是独立渲染树，
   * 直接 import 会形成「AI 面板 ⇄ 知识库面板」的双向耦合（且 AI 面板被
   * 全量重画时对方的 DOM 状态不可控）。广播事件让两边都只依赖一个约定名。
   */
  if ((ev as { type: string }).type === "knowledge") {
    try {
      const k = ev as unknown as { project: string; key?: string; roundCount: number; pointCount: number };
      window.dispatchEvent(new CustomEvent("bwe:knowledge-updated", { detail: k }));
    } catch {
      // 广播失败不该影响对话（这里只是顺带刷新一个旁路面板）
    }
    return; // 知识库事件不影响对话流，交出去就结束
  }

  const live = liveAssistantTurn();

  switch (ev.type) {
    case "route": {
      lastModel = ev.model;
      if (live) {
        live.model = ev.model;
        live.reason = ev.reason;
      }
      hooks?.updateMeter();
      return;
    }
    case "thinking": {
      // 主进程的 thinking 事件是思考态的**唯一权威来源**（契约 §4.2），
      // 本地的 800ms 定时器只做兜底升级，不用于猜状态。
      applyThinkingEvent(ev.phase, ev.chars, ev.delta, () => hooks?.renderThinking?.());
      // 首次正文到达时 also 会走 delta → endThinking（见下）
      return;
    }
    case "delta": {
      // 有正文在流 = 思考结束（answering 阶段也可能没有单独的 thinking 事件）
      endThinking();
      if (live) {
        live.streaming = true;
        live.text += ev.text;
        hooks?.appendDelta(live.text);
      }
      hooks?.renderThinking?.();
      return;
    }
    case "tool": {
      // 主线：耗时 / 成败 / 完整错误。
      // 兼容性（A 可能分两批落地）：
      //   · phase 缺省 → 按 end 处理（老版本不区分 start/end）
      //   · ms 缺省 → UI 侧按 callId 计时
      //   · ok 缺省 → **不显示成败徽标**，不猜（猜错比不显示严重）
      const t = trackToolEvent({
        name: ev.name,
        detail: ev.detail,
        phase: (ev as { phase?: "start" | "end" }).phase,
        callId: (ev as { callId?: string }).callId,
        ok: (ev as { ok?: boolean }).ok,
        error: (ev as { error?: string }).error,
        ms: (ev as { ms?: number }).ms
      });
      const blk: ToolCallBlock = {
        name: ev.name,
        detail: ev.detail,
        callId: (ev as { callId?: string }).callId,
        ms: t.ms,
        ok: t.ok,
        error: t.error
      };
      // **在数据层合并**（不是 DOM 层去重）：
      // renderThread() 会整树重建，DOM 查存必然失效 —— 我写过一版，测出来 4 个块。
      if (live) upsertToolBlock(live.tools, blk);
      hooks?.appendToolBlock(blk);
      return;
    }
    case "usage": {
      lastUsage = ev.usage;
      if (ev.usage?.reason && live) live.reason = ev.usage.reason;
      hooks?.updateMeter();
      return;
    }
    case "done": {
      // **为什么可能没交付**：主进程把「工具预算耗尽」「max_tokens 截断」放进了
      // `done.extra`（可能缺省 —— 老宿主/分两批落地）。判定全部收在纯函数里，
      // 这里只负责把结果挂到**当前这一轮**助手回合上（`live` 就是 `send()` 推入的
      // 那个流式回合）。不能追加到 DOM：renderThread 会整树重建，提示会消失。
      // 也不能挂到 `thread` 末尾 —— done 是流式结束那一刻，末尾可能已经是
      // 用户后来的新消息，挂错对象会让提示看起来属于另一轮。
      const extra = (ev as unknown as { extra?: unknown }).extra;
      const notices = answerNotices(extra);
      // **正文为空 = 这轮什么都没产出**（典型：模型连续调坏工具直到轮次耗尽）。
      // 用户此刻的处境是「AI 说了半句、没了、也没有任何解释」——
      // 沉默的失败比报错更让人困惑，必须明确说明 + 给出口。
      // 已有结构化提示条时不重复说同一件事（提示条已经讲了原因与下一步）。
      const produced = (String(ev.text ?? "") + String(live?.text ?? "")).trim();
      if (live) {
        live.text = ev.text || live.text;
        live.streaming = false;
        live.notices = notices.length ? notices : undefined;
        // 存进回合（不是直接 append 到 DOM）：这条解释必须在下一次重绘后还在。
        if (!produced && !notices.length) {
          live.note = "这轮没有产出答复（可能工具连续失败，或模型轮次耗尽）。可以重试，或换个问法。";
        }
      } else if (produced) {
        // **兜底：没有可写入的流式回合时，不要把 done 的正文丢掉。**
        // `liveAssistantTurn()` 只在「最后一轮是助手」时返回对象；正常路径下 send()
        // 一定先 push 了助手回合，所以这里是纯防御。但真要发生（例如未来宿主允许
        // 在 replaceThread 之后还发 done），静默丢弃的后果就是用户报了的那件事：
        // 模型明明说了话，界面上什么都没有。宁可补一条回合，也不要吞掉正文。
        turns.push({
          role: "assistant",
          text: ev.text,
          tools: [],
          streaming: false,
          notices: notices.length ? notices : undefined
        });
      }
      lastUsage = ev.usage;
      lastCacheHit = ev.cacheHitRate;
      lastSavedUsd = ev.savedUsdApprox;
      currentRequest = "";
      endThinking();
      pendingEdit = extractCodeBlock(ev.text);
      // 一次重绘画完：正文 + 提示条 + 无产出说明都已写进数据层
      hooks?.renderThread();
      hooks?.renderThinking?.();
      hooks?.updateMeter();
      // 这一轮聊完了：左栏的条数/相对时间已经过时（详见 PanelHooks.refreshSessions）
      hooks?.refreshSessions?.();
      return;
    }
    case "error": {
      // **不要把原始错误拼进正文**。
      // 用户截图里那段 400 JSON 就是被拼进气泡的：占一大块、看不懂，
      // 而且它留在 text 里之后，"正文是否为空"的判断也被污染了。
      // 正确做法：正文保持原样（AI 真说了什么就留什么），错误走独立的结构化字段。
      if (live) {
        live.streaming = false;
        live.error = presentError(ev.message);
        live.errorRaw = String(ev.message ?? "");
        live.recoverable = Boolean(ev.recoverable);
      }
      currentRequest = "";
      endThinking();
      hooks?.renderThread();
      // **不再额外追加系统提示条**：
      // 错误气泡本身已经给了「结论 + 建议 + 重试按钮」，
      // 再补一条同样内容的提示条就是**重复说同一件事**（截图里实测到了）。
      // 沉默不好，但啰嗦地重复也不好 —— 一处说清就够。
      hooks?.renderThinking?.();
      hooks?.updateMeter();
      // 失败的一轮同样落了盘（用户消息已在会话里），列表信息要跟上
      hooks?.refreshSessions?.();
      return;
    }
  }
}

// ============================================================================
// 面板入口
// ============================================================================

/**
 * 把工具事件合并进 `tools` 数组（**按 callId，不是按 name/detail**）。
 *
 * 为什么必须在**数据层**合并而不是在 DOM 层去重：
 *   `renderThread()` 会 `thread.replaceChildren()` 整树重建，
 *   任何基于 DOM 查存的去重都会在下次重绘后失效 —— 我写过一版，实测出来 4 个块
 *   （start 一条 + end 一条，× 两次调用）。数据层合并才对：
 *   一次调用在 `tools` 里只占一条，start 建、end 原地更新。
 *
 * 为什么 key 是 `callId`：用户实际遇到「两个同名 SceneDigest 连续调用」，
 * 按 name 合并会把两次调用合成一条（耗时和错误都会串）。
 * 没有 callId 时（老契约）退回 name —— **宁可多显示一条，也不错误合并**。
 */
export function upsertToolBlock(list: ToolCallBlock[], blk: ToolCallBlock): void {
  const keyOf = (b: ToolCallBlock): string => b.callId ?? `nm:${b.name}`;
  const key = keyOf(blk);
  for (let i = list.length - 1; i >= 0; i--) {
    if (keyOf(list[i]) === key) {
      list[i] = { ...list[i], ...blk };
      return;
    }
  }
  list.push(blk);
}

/** 面板布局：`page` = AI 界面（左历史 + 右主区）；`dock` = 右侧窄栏 / 底部面板（旧形态）。 */
export type AiPanelLayout = "page" | "dock";

/**
 * 渲染 AI 面板。
 * @param host 挂载点
 * @param onRepaint 外壳注入的重画请求（diff 应用后刷新剧本面板）
 * @param opts.layout 布局形态，**缺省 "dock"**（旧行为）。page 由 AI 界面入口显式传入。
 */
export function renderAiPanel(
  host: HTMLElement,
  onRepaint?: () => void,
  opts?: { layout?: AiPanelLayout }
): void {
  requestRepaint = onRepaint ?? (() => {});
  // ⚠ 缺省必须等于旧行为。右侧 AI 栏与底部面板的回退分支都**不传**这个参数，
  //   一旦默认值变成 page，它们会在 460px 窄栏里塞一列历史栏（静默走样、不报错）。
  const layout: AiPanelLayout = opts?.layout === "page" ? "page" : "dock";
  ensureEventSubscription();

  host.replaceChildren();
  const wrap = el("div", { class: "ai-panel" });
  // 契约锚点：验收脚本靠它确认「挂的是 AI 面板」而不是别的面板
  wrap.dataset.aiZone = "1";
  // page / dock 都写出来（不只在 page 时写）：样式表靠它分叉，
  // 缺一个值就退回"靠祖先类名猜"，那种选择器一改就全挂。
  wrap.dataset.aiLayout = layout;
  // 面板重挂 = DOM 从零开始，此前的演示注入块已经随旧 DOM 一起没了，
  // 计数必须跟着归零，否则面板会以为"有内容"而不显示欢迎区。
  demoCount = 0;

  // ---- 布局骨架 ----
  //
  // page：`.ai-panel > .ai-page > (.ai-history + .ai-main)`，历史常驻左栏；
  // dock：`.ai-panel > (.ai-head / .ai-streams / .ai-compose)`，历史仍是顶部浮层。
  //
  // 为什么先只定"主区挂哪儿"、而不把下面几百行的构建代码分叉两遍：
  // 两种形态的**内容**完全一样（head / 提示条 / streams / compose），
  // 差别只在父节点。用一个 mainEl 变量承接，两条路径共用同一份构建与同一份
  // 事件绑定 —— 复制一遍等于以后每次改面板都要记得改两处。
  //
  // ⚠ pageEl 上的 mainEl 延迟到内容建完再挂（见文件下方 host.appendChild(wrap) 之前）：
  //   历史栏是先 append 进 pageEl 的，先挂 mainEl 会让历史跑到右边去。
  let pageEl: HTMLElement | null = null;
  let mainEl: HTMLElement = wrap;
  if (layout === "page") {
    pageEl = el("div", { class: "ai-page" });
    mainEl = el("div", { class: "ai-main" });
    wrap.appendChild(pageEl);
  }

  // ---- 顶部状态条：模式徽标 + mock 提示 ----
  const headBar = el("div", { class: "row tight ai-head" });
  headBar.style.padding = "8px 12px 0";
  mainEl.appendChild(headBar);
  // 句柄登记（见模块级注释）：面板每次重挂都会走到这里，
  // 所以「重挂后旧引用失效」这件事由这一行覆盖掉，调用点不用各自去找 DOM。
  headBarEl = headBar;

  const mockHint = el("div", { class: "hint ai-mock-hint" });
  mockHint.style.padding = "6px 12px 0";
  mockHint.style.display = "none";
  mainEl.appendChild(mockHint);
  mockHintEl = mockHint;

  // 明文存储告知条（**只在 insecure:true 时出现，可关闭**）。
  //
  // 为什么放在这里而不是 chip 上：
  //   chip 回答的是「这条模型能不能用」，而明文存储是**安全相关的告知**，
  //   两者语义不同。塞进 chip 会让人以为"明文存储导致模型不可用"（不是）。
  // 为什么可关闭：这是持久状态，每次打开面板都提示是对的，
  //   但用户知道了之后应该能收起，否则会变成长期噪音。
  // 收起后按会话记忆（sessionStorage），下次启动会再提示一次 ——
  //   安全告知不该永久消失。
  const insecureHint = el("div", { class: "ai-insecure-hint" });
  insecureHint.dataset.aiInsecure = "1";
  insecureHint.style.display = "none";
  mainEl.appendChild(insecureHint);

  // Key 失效批量提示条（**阻断级**：key 解不开 = 功能完全不可用）。
  //
  // 为什么是常驻条而不是"点开才看到"：
  //   这是阻断级问题，不能藏在二级菜单里 —— 用户打开 AI 面板第一眼就该看到。
  // 为什么不做成两层导航（顶部条 + 点开列表）：
  //   「1 个 key 失效」是最常见的情况，为一件事造两层导航是过度设计。
  //   所以 count===1 时「去重填」直接定位到唯一那条；
  //   count>=2 时才在条内展开成小列表（每行一个模型 + 各自重填按钮）。
  const keyBrokenHint = el("div", { class: "ai-keybroken-hint" });
  keyBrokenHint.dataset.aiKeybroken = "1";
  keyBrokenHint.style.display = "none";
  mainEl.appendChild(keyBrokenHint);

  // 「测试连接」结果区宿主：常驻但默认空，探测后才有内容。
  // 必须在 thread 之前创建并赋值，否则 renderProbeArea 拿不到它（早前漏了赋值，
  // 结果区一条都不显示 —— 又一次"看起来实现了、实际不工作"）。
  probeHostEl = el("div", { class: "ai-probe-host" });
  mainEl.appendChild(probeHostEl);

  // ---- 左栏：会话历史（page 布局常驻；dock 布局仍是顶部条上的浮层） ----
  //
  // 为什么历史栏由 aiSessions.ts 自己建、而不是这里拼 DOM：
  // 会话行的类名与 data 锚点是对外契约（verify-sessions 按它们定位），
  // 构造点只该有一个。这里只负责"给它一块地"和"告诉它切换后要刷新什么"。
  //
  // ⚠ 位置必须在 mainEl 之前 append 进 pageEl：历史在左、主区在右。
  //   mainEl 的内容建完才挂进 pageEl（见下方），所以这里先挂的是历史。
  //
  // 句柄留着：一轮结束时调它的 `refresh()` 做**局部**重画（只重列列表与计数，
  // 不重挂整个面板 —— 重挂会让输入框内容、滚动位置全丢）。
  let sessionSidebar: SessionSidebar | null = null;
  if (pageEl) {
    sessionSidebar = renderSessionSidebar(pageEl, {
      // ⚠ 主进程返回的 messages 已过滤 system 前缀块 —— 直接渲染，不再二次过滤
      renderMessages: (messages) => replaceThreadFromMessages(messages as ChatTurn[]),
      clearMessages: () => replaceThreadFromMessages([]),
      // 切/新建会话后顶部模型条不必重画内容，但**状态可能变**（新会话的用量/路由都变了）。
      // 走 refreshHeadNow 而不是直接调 refreshStatus：并发两次刷新会画出两份 chip，
      // 而这个会话栏的回调与「切模型」完全可能同时发生。
      refreshBar: () => {
        void refreshHeadNow();
      }
    });
  }

  // ---- 唯一内容宿主：行为与对话**同轨**（v3） ----
  //
  // 为什么取消「上行为区 / 下聊天区」两分布局（用户原话：「agent 行为我觉得没必要
  // 单独搞到上面一个大的 block 挡住这么多空间，直接有什么行为显示到聊天框里就行」）：
  //   两区是**两个抢高度的兄弟**，行为区一封顶（46%）就把对话挤成两行；
  //   而用户要读的是一条时间线：我说了什么 → 它调了哪些工具 → 它怎么回答。
  //   所以工具块 / 思考 / 系统提示 / 错误 / diff 全部回落 `.ai-thread`，按发生顺序穿插。
  //
  // 分区**规则**没丢，只是换了用途：`aiZones.zoneFor()` 仍是「这条属于它做的、
  // 还是我说的」的单点判定，现在拿它给块打标记（`data-ai-kind` + `.ai-act`），
  // 而不是选宿主。规则与呈现分开，`verify-ai-zones` 的 20 项断言因此一行都不用改。
  //
  // ⚠ `.ai-thread` 这个类名**必须保留**：desktop/tools/verify-sessions.mjs 的探针按它取元素，
  //   改名不会报错，只会让那条验收从此量到 0 个消息（静默失效）。
  const streams = el("div", { class: "ai-streams" });
  streams.dataset.aiStreams = "1";

  /**
   * 空闲态的欢迎区：只在 `turns` 为空时挂进 DOM（由 `syncPanelState` 同步）。
   *
   * 为什么元素在挂载时建好、之后只做插入/移除：建议行要绑点击（把句子填进输入框），
   * 每次进空闲态重建一遍等于每次重绑一遍监听 —— 建一次更省事，也不会漏解绑。
   */
  let heroEl: HTMLElement | null = null;

  const chat = el("div", { class: "ai-chat" });
  chat.dataset.aiChat = "1";

  // 行为摘要小条（一行高，**不是一个区**）。
  //
  // 为什么保留它：它是用户判断「它到底动没动」的唯一常驻信号（N 步 / 失败 N / 状态点），
  //   工具块滚出视野后仍要能一眼看到。但它只占一行，不参与分高。
  // 为什么沿用 `.ai-agent-head` 这个类名：cream.css 里那套状态点配色
  //   （idle/running/done/failed 四色 + data-busy 呼吸）已经按它写好；
  //   换个名字等于让那些样式静默失效（不报错、只是不生效）。
  const agentHead = el("div", { class: "ai-agent-head" });
  agentHead.dataset.state = "idle";
  // 类名沿用样式表里的 `.ai-agent-count`（数字列用 tabular-nums 对齐，跳动时不抖）
  const agentSteps = el("span", { class: "hint ai-agent-count" }, "等待指令");
  const agentBadge = el("span", { class: "ai-agent-badge" });
  agentHead.appendChild(svg(I.puzzle, 13));
  agentHead.appendChild(el("span", { class: "ai-agent-title" }, "行为"));
  agentHead.appendChild(el("div", { class: "spacer" }));
  agentHead.appendChild(agentSteps);
  agentHead.appendChild(agentBadge);

  // 用户 / 助手消息 + 工具块 / 思考 / 提示 / 错误 / diff 的唯一宿主。
  // 自己滚动（`flex:1 1 auto` + `overflow-y:auto` 见样式表），块多了整体滚，
  // 每块靠 `.ai-thread > * { flex: 0 0 auto }` 保住可读高度（「被挤成一条缝」的根因修复）。
  const thread = el("div", { class: "ai-thread" });
  thread.dataset.aiThread = "1";

  chat.appendChild(agentHead);
  chat.appendChild(thread);
  streams.appendChild(chat);
  mainEl.appendChild(streams);

  // ---- 输入区 ----
  const compose = el("div", { class: "ai-compose" });

  // 4 个固定动作：AI 面板「有用」的地方不是聊天框，而是这四条直达路径
  const quick = el("div", { class: "ai-quick" });
  const qExplain = button("解释当前脚本错误", () => void send("explain-error"), {
      size: "sm",
      variant: "ghost",
      iconPath: I.warn,
      title: "把「问题」面板里的错误摘要 + 当前脚本一起发给 AI"
    });
  qExplain.dataset.aiQuick = "explain-error";
  quick.appendChild(qExplain);
  const qEdit = button("改这段脚本", () => void send("edit-script"), {
      size: "sm",
      variant: "ghost",
      iconPath: I.wand,
      title: "让 AI 直接改当前脚本（改完可 Ctrl+Z 撤销；若它只在正文里贴代码，也会给出 diff 供你确认）"
    });
  qEdit.dataset.aiQuick = "edit-script";
  quick.appendChild(qEdit);
  const qReview = button("审一遍当前场景", () => void send("scene-review"), {
      size: "sm",
      variant: "ghost",
      iconPath: I.eye,
      title: "带工程摘要让 AI 找结构性问题（不发原始工程数据）"
    });
  qReview.dataset.aiQuick = "scene-review";
  quick.appendChild(qReview);
  const qChat = button("继续对话", () => void send("chat"), {
      size: "sm",
      variant: "ghost",
      iconPath: I.chevronRight,
      title: "把输入框里的内容作为下一轮发出去"
    });
  qChat.dataset.aiQuick = "chat";
  quick.appendChild(qChat);
  compose.appendChild(quick);

  const inputRow = el("div", { class: "ai-input-row" });
  const ta = el("textarea", {
    class: "ai-input",
    placeholder: "描述问题，或点下面的快捷动作…（Ctrl+Enter 发送）"
  });
  inputRow.appendChild(ta);

  // 发送按钮在思考中会变成「停止」：忙碌时点它就是取消，不是再发一条
  const sendBtn = button("发送", () => {
    if (currentRequest) {
      cancelThinking();
      return;
    }
    void send("chat");
  }, { variant: "primary", size: "sm", iconPath: I.sparkles });
  inputRow.appendChild(sendBtn);
  const stopBtn = button("停止", () => cancelRunning(), { size: "sm", variant: "outline", iconPath: I.stop });
  stopBtn.style.display = "none";
  inputRow.appendChild(stopBtn);
  compose.appendChild(inputRow);

  // 用量条：模型 / 路由理由 / 缓存命中 / 三类 token —— "省 token"必须看得见
  const meter = el("div", { class: "ai-meter" });
  compose.appendChild(meter);

  mainEl.appendChild(compose);

  // page：主区内容建完才挂进两列容器 —— 历史栏已经在 pageEl 里了，
  // 这时候 append 才能保证"左历史、右主区"的先后（DOM 顺序即视觉顺序）。
  if (pageEl) pageEl.appendChild(mainEl);

  host.appendChild(wrap);

  // 欢迎区在这里建（不是在上面建）：建议行点击要往输入框里填字，`ta` 必须已经存在。
  // 建好后交给 syncPanelState 决定挂不挂（空闲才挂）。
  heroEl = heroView();

  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void send("chat");
    }
  });

  // ---------------- 发送 / 停止 ----------------

  /**
   * 发一轮。
   *
   * @param intent 动作类型
   * @param retryText 重试用：直接发这段文本（不走输入框）。
   *   「重试」按钮要能重发**上一条用户消息**，而那时输入框已经被清空了 ——
   *   所以必须有这个入口，否则"重试"点下去只会发出内置提示语，不是原来那句。
   */
  async function send(intent: AiChatRequest["intent"], retryText?: string): Promise<void> {
    if (currentRequest) {
      info("上一轮还在生成，等它结束或点「停止」");
      return;
    }
    if (!store.project) {
      info("先打开一个工程");
      return;
    }

    const typed = retryText ?? ta.value.trim();
    const preset = actionPrompt(intent);
    // 「继续对话」必须用输入框内容；其余动作输入框为空时用内置提示语，
    // 免得用户点了按钮却发出一条空消息。
    const text = typed || preset;
    if (!text) {
      ta.focus();
      return;
    }

    turns.push({ role: "user", text, tools: [], streaming: false });
    turns.push({ role: "assistant", text: "", tools: [], streaming: true });
    if (!retryText) ta.value = "";   // 重试不动输入框（那句话本来就不在里面）
    trimHistory();

    const requestId = newRequestId();
    currentRequest = requestId;
    pendingEdit = null;
    renderThread();
    updateMeter();

    const req: AiChatRequest = {
      requestId,
      messages: compactMessages(intent, text),
      context: buildContext(intent),
      intent
    };
    // **在调用 aiChat 之前**就进入思考态：若等第一个事件，推理模型首字要 2~5 秒，
    // 用户面对的是 5 秒空白，会以为卡死了（这是用户报「思考时要显示」的核心痛点）。
    beginThinking(requestId, () => renderThinking());
    renderThinking();
    updateMeter();
    try {
      await aiChat(req);
    } catch (e) {
      // 门面本身不抛；这里兜住后续宿主改动的风险，别让面板停在"永远转圈"
      currentRequest = "";
      const last = liveAssistantTurn();
      if (last) {
        last.streaming = false;
        last.text = `（发送失败：${(e as Error).message}）`;
      }
      renderThread();
      updateMeter();
    }
  }

  function cancelRunning(): void {
    if (!currentRequest) return;
    const id = currentRequest;
    currentRequest = "";
    void aiCancel(id);
    const last = liveAssistantTurn();
    if (last && last.streaming) {
      last.streaming = false;
      last.text += "\n\n（已停止）";
    }
    renderThread();
    updateMeter();
    // 被中断的这轮也已经写进会话文件，左栏的「N 条」要跟上
    hooks?.refreshSessions?.();
  }

// ============================================================================
// 会话切换：把主进程返回的 messages 换成对话区内容
// ============================================================================

/**
 * 用主进程返回的 messages 替换整条对话线程。
 *
 * ⚠ 两条纪律：
 *   1. `messages` **已过滤 system 前缀块**（那是内部缓存实现），直接映射即可。
 *      **不要自己再过滤一遍** —— 那会把正常消息误删（比如首条用户消息恰好以某个
 *      内部标记开头时）。A 特意强调过。
 *   2. 切换后必须清掉 `currentRequest` / 思考态：旧会话的在途请求已被后端中止
 *      （返回 `aborted` 数），UI 不能还挂着"正在思考"。
 */
function replaceThreadFromMessages(messages: ChatTurn[]): void {
  // 结构防御：主进程给的是 {role, text}，这里补上 UI 需要的字段（tools/streaming）
  turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      role: m.role,
      text: String(m.text ?? ""),
      tools: Array.isArray(m.tools) ? m.tools : [],
      streaming: false,
      model: m.model,
      reason: m.reason
    }));
  // 切会话后旧请求已不存在，UI 不能残留"正在思考"
  currentRequest = "";
  endThinking();
  lastProbe = null;
  probeHostEl?.replaceChildren();
  renderThread();
  renderThinking();
  updateMeter();
}

  // ---------------- 顶部状态 ----------------

  /**
   * 明文存储告知条。
   *
   * `insecure` 是**持久状态**（系统加密存储不可用 → key 落成明文），
   * 属于安全告知，必须让用户知道；但它**不代表模型不可用**（能用，只是不安全）。
   * 所以：
   *   · 不进 chip（chip 只回答"能不能用"）
   *   · 一行小字 + 带 ×，可收起（持久提示不该变成长期噪音）
   *   · 收起记在 sessionStorage —— 下次启动会再提示一次（安全告知不该永久消失）
   */
  /**
   * Key 失效批量提示条。
   *
   * 数量来自 `aiStatus().keyUndecryptableCount`（主进程算好的，UI 不自己数）。
   *
   * 两级形态（**按数量自动选，不是两级导航**）：
   *   · count === 1 → 一条提示 + 「去重填」，点了直接弹那一条的填 key 框
   *   · count >= 2 → 同一条提示 + 「去重填」展开成小列表，每行一个模型 + 各自按钮
   *   · count === 0 → 完全不出现
   */
  /**
   * 渲染 Key 失效批量提示条。
   *
   * ⚠ **`models` 必须是参数，不能自己去读全局 `modelsState`** ——
   *   这是 A 提的改造建议，比运行时守卫更根本：
   *   接收 `AiModelEntry[]` 后，调用点若还没 `await loadModels()` 就只能传 `[]`，
   *   而 `[]` 会让计数为 0 —— 但那**正是原来的 bug**，不是一种"合法的降级"。
   *   传 `null` 更不可能：类型直接不允许。约束前移到类型系统，比运行时抛错更早。
   *   （曾经三次同类事故都是"渲染依赖某状态但没确认它已就绪"。）
   */
  function renderKeyBrokenHint(models: AiModelEntry[], st: AiStatus | null): void {
    const host = document.querySelector("[data-ai-keybroken]") as HTMLElement | null;
    if (!host) return;

    // ---- 两份统计源交叉校验 ----
    // `count`（主进程算的总数）与「逐条模型自己的 keyUndecryptable」是两个独立源。
    // 显示用**逐条数出来的**（红条说几条，列表里就得能点到几条）；
    // 不一致只在「输出」面板留痕，**不为它设计 UI**（用户不该看到我们的内部不一致）。
    //
    // 清单未加载时**抛错**（由下方 try/catch 兜底并记输出面板）：
    // 曾因为这里读到 null 清单 → countKeyBroken([]) 恒为 0 → 提示条永远隐藏。
    // 决策交给纯函数（可单测），这里只负责渲染
    const view = keyBrokenViewOf(models, st);
    if (view.warning && !keyBrokenWarned) {
      keyBrokenWarned = true;   // 只记一次，不刷屏
      appendOutput("AI", view.warning, "warn");
    }

    const count = view.count;
    if (!count) {
      host.style.display = "none";
      return;
    }
    host.replaceChildren();
    host.style.display = "";

    const head = el("div", { class: "ai-keybroken-head" });
    head.appendChild(svg(I.warn, 13));
    head.appendChild(
      el("span", { class: "ai-keybroken-text" }, view.title)
    );
    head.appendChild(el("div", { class: "spacer" }));
    const goBtn = button(view.buttonLabel, () => void rekeyAll(count), {
      size: "sm",
      variant: "primary",
      iconPath: I.lock,
      title: count === 1 ? "切到该模型并粘贴 Key" : "逐个重新粘贴"
    });
    goBtn.dataset.aiRekeyAll = "1";
    head.appendChild(goBtn);
    host.appendChild(head);

    // count >= 2 才展开列表（1 个时直接由「去重填」处理，不占高度）
    if (view.showList) {
      const list = el("div", { class: "ai-keybroken-list" });
      const brokenEntries = view.brokenEntries;
      for (const m of brokenEntries) {
        const row = el("div", { class: "ai-keybroken-row" });
        row.dataset.aiKeybrokenItem = m.id;
        row.appendChild(el("span", { class: "ai-keybroken-name" }, m.label || m.id));
        const rb = button("重填", () => {
          keyDialogFor = m;
          renderKeyDialog();
        }, { size: "sm", variant: "ghost", iconPath: I.lock, title: `重新粘贴「${m.label || m.id}」的 Key` });
        rb.dataset.aiRekey = "1";
        row.appendChild(rb);
        list.appendChild(row);
      }
      // 若主进程只给了 count 但清单里没标 keyUndecryptable（字段未同步），
      // 就退化成"逐个尝试"—— 不假装知道是哪几条。
      if (!brokenEntries.length) {
        list.appendChild(
          el("div", { class: "hint ai-keybroken-empty" }, "逐条检查模型可找到需要重填的那几条。")
        );
      }
      host.appendChild(list);
    }
  }

  /**
   * 「去重填」：count===1 时直接定位唯一那条；>=2 时展开/收起列表。
   * 为什么不让用户自己去下拉里找：key 解不开是阻断级问题，替他多走一步。
   */
  async function rekeyAll(count: number): Promise<void> {
    if (!modelsState) await loadModels();
    const broken = (modelsState?.models ?? []).filter((m) => m.keyUndecryptable);
    if (broken.length === 1) {
      keyDialogFor = broken[0];
      renderKeyDialog();
      return;
    }
    if (broken.length >= 2) {
      // 展开/收起列表（不二次跳转）
      const list = document.querySelector(".ai-keybroken-list") as HTMLElement | null;
      if (list) {
        list.style.display = list.style.display === "none" ? "" : "none";
      } else {
        renderKeyBrokenHint(requireModels("rekeyAll").models, status);   // 首次点：按 >=2 的形态渲染出列表
        document.querySelector(".ai-keybroken-list")!.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    // 清单里没有标记（字段未同步）：退到下拉，让用户自己选
    info("请在下拉里选择要重填 Key 的模型");
  }

  function renderInsecureHint(st: AiStatus | null): void {
    const host = document.querySelector("[data-ai-insecure]") as HTMLElement | null;
    if (!host) return;
    const insecure = Boolean(st?.insecure);
    const dismissed = sessionStorage.getItem("bwe.ai.insecureDismissed") === "1";
    if (!insecure || dismissed) {
      host.style.display = "none";
      return;
    }
    host.replaceChildren();
    host.style.display = "";
    host.appendChild(svg(I.lock, 12));
    // 两种来源，两种措辞 —— 用户的判断和后续动作不同：
    //   · insecure（这台机器加密不可用）→ "我这台机器是不是有问题"
    //   · keyPlaintextFallback（key 曾经加密过、因解不开才降级）
    //     → "我的 key 出事过，但现在已经能用（明文）"
    // 两个都为 true 时用降级版（信息更全，含"曾经加密"这层）。
    // **不新增第二条提示条** —— 一句话说清就够（沉默不好，啰嗦也不好）。
    const fallback = Boolean(st?.keyPlaintextFallback);
    host.appendChild(
      el(
        "span",
        { class: "ai-insecure-text" },
        fallback
          ? "你之前保存的 API Key 无法解密，已以明文保存（系统加密存储不可用）。仅建议在单人使用的机器上这样配置。"
          : "当前 API Key 以明文保存（系统加密存储不可用）。仅建议在单人使用的机器上这样配置。"
      )
    );
    const closeBtn = button("×", () => {
      sessionStorage.setItem("bwe.ai.insecureDismissed", "1");
      host.style.display = "none";
    }, { size: "sm", variant: "ghost", title: "知道了，本次运行不再提示" });
    closeBtn.dataset.aiInsecureClose = "1";
    host.appendChild(closeBtn);
  }

  async function refreshStatus(bar: HTMLElement, hintBox: HTMLElement): Promise<void> {
    bar.replaceChildren();
    try {
      // 演示模式下保留注入的 status（否则注入值立刻被真实值覆盖）
      if (!statusPinnedForDemo) status = await aiStatus();
      statusLoaded = true;
    } catch {
      status = null;
    }
    if (!status) {
      bar.appendChild(el("span", { class: "model-chip flash" }, "AI 不可用"));
      hintBox.textContent = "AI 门面没有返回状态，面板仍可用（点按钮走本地演示）。";
      hintBox.style.display = "";
      return;
    }

    // ⚠ 「宿主整体是否就绪」≠「这条模型没问题」。
    // 用户实际踩坑：key 解密失败时 status.ready 可能是 false，于是整条 chip
    // 被显示成「本地演示」—— 用户明明配了 kimi/flash，界面却说本地演示，
    // 完全看不出真正的原因（Key 解不开）。
    //
    // 所以：`status.ready === false` 时**仍然要看条目自身状态**。
    // 只有真正没有宿主/没有模型（mode === "mock" 或清单为空）才算"本地演示"。
    const hostMockOnly = status.mode === "mock";
    const mock = hostMockOnly;

    // ========================================================================
    // ⚠ 渲染顺序约定（**违反过一次，真机才抓到**）
    //
    //   凡是读取 `modelsState` / `activeEntry()` / `countXxx(modelsState)` 的渲染，
    //   必须在 `await loadModels()` **之后**。
    //
    //   历史三次同类事故：
    //     1. chip 在 loadModels 前构建 → `activeEntry()` 恒为 null → chip 永远显示默认态
    //     2. `entryHint` 判 `reachable`（该字段从不产出）→ 死分支
    //     3. `renderKeyBrokenHint` 在 loadModels 前调 → `modelsState` 是 null
    //        → `countKeyBroken([])` 恒为 0 → 批量提示条**永远 display:none**
    //        （真机 probe 出 rect 0x0 / visible:false / text 空）
    //
    //   前两次的教训是"看起来实现了、实际恒为空"，第三次又栽在同一个坑上。
    //   所以这里把顺序写在代码里，并且让 `requireModels()` 在未加载时**抛错** ——
    //   开发期立刻炸，而不是静默渲染成空（静默降级才是这类 bug 反复出现的直接原因）。
    // ========================================================================
    await loadModels();

    // 清单就绪后才渲染"依赖逐条数据"的提示。
    // `requireModels()` 只在这里用一次：拿到**真的数组**再传给纯函数
    // —— 函数本身不读全局，所以可以直接单测（喂数组、断言输出）。
    const modelsReady = requireModels("refreshStatus/renderKeyBrokenHint").models;
    renderInsecureHint(status);
    renderKeyBrokenHint(modelsReady, status);

    // 常驻状态标识：不只弹一次性 toast。
    // 为什么必须常驻：用户可能过一会儿才发下一条消息，那时才会失败；
    // 一次性提示早消失了，用户会以为是"偶发网络问题"而不是"这条模型根本不能用"。
    //
    // 文案由 aiModelState.ts 单点决定 —— ready:true 只能说「已配置」，
    // **不能说「可用」**（ready 只检查配置齐不齐，从不发网络探测）。
    const entryForState = activeEntry();
    // mock 模式下整条 chip 就是"本地演示"，不需要"测试连接"（它不发网络请求）
    const st = modelStateOf(entryForState, mock || !entryForState || entryForState.provider === "mock");
    const chipLabel = entryForState && !mock ? `${entryForState.label} · ${st.short}` : st.short;
    const stateChip = el("span", { class: "model-chip " + st.cls }, chipLabel);
    stateChip.title = mock
      ? st.why
      : `${entryForState?.label ?? ""}：${st.why}`;
    // 已配置时给个「测试连接」入口：这是唯一能确认"真的连得上"的办法
    if (st.kind === "configured" && entryForState) {
      const probeBtn = button("测试连接", () => void runProbe(entryForState), {
        size: "sm",
        variant: "ghost",
        iconPath: I.wand,
        title: "发一个最小请求验证这条模型能否真的连通"
      });
      probeBtn.dataset.aiProbeModel = "1";
      stateChip.style.display = "inline-flex";
      stateChip.style.alignItems = "center";
      stateChip.style.gap = "6px";
      stateChip.appendChild(probeBtn);
    }
    // ⚠ Key 失效（填过但解不开）：**必须给一键重填入口**，
    // 不许让用户去别处找。这条是用户实际踩坑点 ——
    // 他填过 key，重启后解不开，如果 UI 只显示「待填 key」，
    // 他会以为是自己忘了填，反复去设置页折腾。
    if (st.kind === "key-broken" && entryForState) {
      const rekeyBtn = button("重新粘贴 Key", () => {
        keyDialogFor = entryForState;
        renderKeyDialog();
      }, {
        size: "sm",
        variant: "primary",
        iconPath: I.lock,
        title: st.why
      });
      rekeyBtn.dataset.aiRekey = "1";
      stateChip.style.display = "inline-flex";
      stateChip.style.alignItems = "center";
      stateChip.style.gap = "6px";
      stateChip.appendChild(rekeyBtn);
    }
    bar.appendChild(stateChip);
    bar.appendChild(el("div", { class: "spacer" }));

    // mock 提示条：只在**真的没有宿主**（mode === "mock"）时才显示。
    // ⚠ 不能用 `mock`（那个是"chip 该不该说本地演示"）——
    //   否则 key 解密失败时（status.ready=false 但 mode 仍是 desktop）
    //   会挂出"没有可用的 AI 宿主，当前是本地演示模式"，
    //   把"Key 解不开"误导成"你没配 AI"，正好掩盖真正的根因。
    if (hostMockOnly) {
      hintBox.textContent = status.message || "没有可用的 AI 宿主，当前是本地演示模式。";
      hintBox.style.display = "";
    } else if (!status.ready) {
      // 宿主在、但整体没就绪：说清楚是模型配置问题，不是"本地演示"
      hintBox.textContent = "有桌面宿主，但当前模型的配置还不完整（详见下方模型状态）。";
      hintBox.style.display = "";
    } else {
      hintBox.style.display = "none";
    }

    // 模型下拉：「flash/pro 两行字」换成真正可选的下拉。
    // 这是用户明确要的功能 —— 能在编辑器里换模型，而不是去改配置文件。
    renderModelPicker(bar);

    // 会话切换器（用户明确要的「新会话和会话历史」）。
    // 挂在模型下拉同一排：两者都是"当前对话的上下文"类切换，放一起符合直觉。
    // 网页版没有会话能力时 renderSessionSwitcher 返回 null，入口自动消失。
    //
    // ⚠ page 布局下**不渲染**（契约 §9）：历史已经是左栏常驻列表，
    //   再挂一个「历史」浮层按钮等于同一件事两个入口 —— 用户在左栏点了会话，
    //   又从顶部弹一层列表，会以为这是两份不同的历史。
    if (layout === "dock") {
      renderSessionSwitcher(
        bar,
        {
          renderMessages: (messages) => {
            // ⚠ 主进程返回的 messages 已过滤 system 前缀块 —— 直接渲染，不再二次过滤
            replaceThreadFromMessages(messages as ChatTurn[]);
          },
          clearMessages: () => {
            replaceThreadFromMessages([]);
          },
          refreshBar: () => {
            void refreshStatus(bar, hintBox);
          }
        },
        () => {
          /* 浮层已自行收起 */
        }
      );
    }

    updateMeter();
  }

  /** 顶部状态条刷新是否在飞（见 `refreshHeadNow` 的串行化理由） */
  let headRefreshBusy = false;
  /** 刷新期间又来了请求 → 结束后补跑一次（丢事件会让 chip 停在旧模型上） */
  let headRefreshAgain = false;

  /**
   * 立刻重画顶部状态条（模型 chip / 下拉 / 计数 / 提示条）。
   *
   * 为什么要有这个函数（而不是在四处各写一遍）：v3 之前有 **4 个调用点**各自写着
   * `meterEl?.closest(".ai-panel")?.querySelector(".ai-head")`，而 `meterEl` 从未被赋值
   * —— 四处一起静默失效，「保存 key / 切模型 / 添加模型 / 探测完成」之后顶部都不刷新，
   * 必须切窗口或切标签（重挂面板）才更新。重复的同一段查找就是这次 bug 的成因，
   * 收成一处之后，下次新增「改完模型的入口」只要调它。
   *
   * 三个约束：
   *   1. **句柄失效就什么都不做**：面板可能已经重挂/收起，往离树的 DOM 里写等于白写。
   *   2. **串行化**：`refreshStatus` 内部有 `await aiStatus()` / `await loadModels()`，
   *      两次并发会在 `replaceChildren` 之后交错插入，画出两份 chip。
   *      在飞时只置脏标记，落地后补跑一次（合并语义：期间的所有变更一次刷完）。
   *   3. 调用点 `void` 掉即可；需要「调完即可见」时（截图/排查）可以 await 它。
   */
  async function refreshHeadNow(): Promise<void> {
    const bar = headBarEl;
    const hint = mockHintEl;
    if (!bar || !hint || !bar.isConnected) return;
    if (headRefreshBusy) {
      headRefreshAgain = true;
      return;
    }
    headRefreshBusy = true;
    try {
      await refreshStatus(bar, hint);
    } finally {
      headRefreshBusy = false;
    }
    if (headRefreshAgain) {
      headRefreshAgain = false;
      await refreshHeadNow();
    }
  }


  // ---------------- 测试连接（用户主动触发的连通性探测） ----------------

  /**
   * 探测当前/指定模型能否真的连通，并把结果画进结果区。
   *
   * 三个设计点：
   *   1. **只在用户点击时跑**，绝不放进清单加载路径（N 条模型逐个探活会把面板打开拖成几秒）；
   *   2. **loading 态必须有**：探测可能要等几秒（超时类），没有 loading 用户会重复点；
   *   3. **四类结果分开显示**（200 / 401 / DNS / 超时），下一步动作完全不同 —— 见 aiModelState.ts。
   */
  async function runProbe(entry: AiModelEntry): Promise<void> {
    if (probeBusy) return;
    probeBusy = true;
    lastProbe = { entryId: entry.id, label: entry.label, state: "loading" };
    renderProbeArea(entry);

    try {
      const r = await probeModelOf(entry);
      lastProbe = { entryId: entry.id, label: entry.label, state: "done", result: r };
      appendOutput(
        "AI",
        `测试连接 ${entry.label}：${r.headline}${r.latencyMs !== undefined ? `（${r.latencyMs}ms）` : ""}${r.detail ? ` — ${r.detail}` : ""}`,
        r.kind === "ok" ? "ok" : "warn"
      );
    } catch (e) {
      lastProbe = {
        entryId: entry.id,
        label: entry.label,
        state: "done",
        result: {
          kind: "error",
          headline: "连接异常",
          next: "看下面的细节",
          detail: (e as Error)?.message || String(e)
        }
      };
    } finally {
      probeBusy = false;
    }
    renderProbeArea(entry);
    // 顶部 chip 也要跟着刷新（探测结果可能让"已配置"变成"连不上"的提示）
    void refreshHeadNow();
  }

  /** 结果区：loading / 四类结果，画在面板顶部临时区域。 */
  function renderProbeArea(entry: AiModelEntry): void {
    // 结果区挂在 mock 提示下面，避免挤占对话区
    const host = probeHostEl;
    if (!host) return;
    host.replaceChildren();

    if (!lastProbe || lastProbe.entryId !== entry.id) return;

    const box = el("div", { class: "ai-probe" });
    box.dataset.aiProbeResult = "1";

    if (lastProbe.state === "loading") {
      box.appendChild(el("span", { class: "ai-probe-spinner" }));
      box.appendChild(el("span", { class: "ai-probe-headline" }, `正在测试「${entry.label}」…`));
      host.appendChild(box);
      return;
    }

    const r = lastProbe.result;
    if (!r) return;
    // 三档视觉，不是两档：
    //   ok → 绿（确认能连）
    //   unknown → 中性（**判不出来**，既不能画绿也不能画红，否则等于替引擎下结论）
    //   其余 → 黄（明确需要处理）
    const tone = r.kind === "ok" ? "ok" : r.kind === "unknown" ? "unknown" : "warn";
    box.classList.add(tone);

    const head = el("div", { class: "ai-probe-head" });
    head.appendChild(
      el("span", { class: "ai-probe-mark" }, r.kind === "ok" ? "✓" : r.kind === "unknown" ? "?" : "⚠")
    );
    head.appendChild(el("span", { class: "ai-probe-headline" }, r.headline));
    head.appendChild(el("div", { class: "spacer" }));
    if (r.latencyMs !== undefined) head.appendChild(el("span", { class: "hint" }, `${r.latencyMs}ms`));
    const close = button("×", () => {
      lastProbe = null;
      host.replaceChildren();
    }, { size: "sm", variant: "ghost", title: "收起" });
    head.appendChild(close);
    box.appendChild(head);

    box.appendChild(el("div", { class: "ai-probe-next" }, `下一步：${r.next}`));
    if (r.detail) box.appendChild(el("div", { class: "ai-probe-detail mono" }, r.detail));
    // 探测方式单独一行：排查时"打的是哪个端点"往往比结论更关键
    if (r.method) {
      box.appendChild(el("div", { class: "ai-probe-detail mono" }, `探测方式：${r.method}`));
    }

    host.appendChild(box);
  }


  // ---------------- 「正在思考」提示 ----------------

  /**
   * 渲染思考提示（三个呼吸点，不是转圈）。
   *
   * 为什么不用 spinner：面板面积大，转圈在大面积区域很吵；
   * 三个缓慢呼吸的点安静得多，且能表达"在等外部响应"而不是"程序在忙"。
   */
  function renderThinking(): void {
    // 思考提示是**一条时间线事件**（v3）：它说明"它正在干活"，所以进 `.ai-thread`
    // 排在当前消息之后、回答之前 —— 而不是像 v2 那样挂在上面一个独立区里
    // （那个区一封顶就把对话挤成两行，正是用户抱怨的"大 block 挡空间"）。
    const host = thread;
    const st = currentThinking();
    // 先把旧的思考提示摘掉，再决定要不要画新的（避免重复堆叠）
    const old = host.querySelector(".ai-thinking");
    old?.remove();
    if (!st) {
      // 思考结束 = 轨道里少了一个块，摘要条状态要跟着回落（否则一直停在「执行中」）
      refreshAgentHead();
      return;
    }

    const box = el("div", { class: "ai-thinking" });
    markBlock("thinking", box);
    // 锚点保留（验收/排查按它找思考块；v3 换了宿主，锚点不变最省事）
    box.dataset.aiThinking = "1";
    box.dataset.phase = st.phase;

    // 三个呼吸点（@keyframes 见 CSS；prefers-reduced-motion 下静止）
    const dots = el("span", { class: "ai-thinking-dots" });
    for (let i = 0; i < 3; i++) dots.appendChild(el("i"));
    box.appendChild(dots);

    box.appendChild(el("span", { class: "ai-thinking-text" }, thinkingText(st)));

    // slow 阶段必须给「停止」——那是用户唯一出口（不能指望他记得去点别处）
    if (thinkingNeedsStop(st)) {
      const stopBtn = button("停止", () => {
        const w = window as unknown as { __BWE__?: unknown };
        void w;
        cancelThinking();
      }, { size: "sm", variant: "danger", iconPath: I.stop, title: "结束这轮请求" });
      stopBtn.dataset.aiThinkingStop = "1";
      box.appendChild(stopBtn);
    }

    // reasoning 阶段的思考原文：默认折叠（否则刷屏，而且思考内容通常很碎）
    if (st.phase === "reasoning" && st.detail) {
      const details = el("details", { class: "ai-thinking-detail" });
      details.appendChild(el("summary", null, `看思考过程（${st.chars} 字）`));
      details.appendChild(el("pre", { class: "ai-thinking-pre" }, st.detail));
      box.appendChild(details);
    }

    // 插到「还没说完的回答」之前（见 appendActNode）：思考是回答的前置，
    // 排在它下面会读成「答完又来一句我在想」。
    appendActNode(box);
    // 有了思考块，头部立刻进「执行中」—— 这一瞬间用户就是在问"它到底动没动"
    refreshAgentHead();
  }

  /** 取消当前请求（思考中「发送」变「停止」时点它）。 */
  function cancelThinking(): void {
    if (!currentRequest) return;
    const id = currentRequest;
    currentRequest = "";
    void aiCancel(id);
    endThinking();
    const last = liveAssistantTurn();
    if (last && (last.streaming || last.text === "")) {
      last.streaming = false;
      last.text = last.text ? `${last.text}\n\n（已取消）` : "（已取消）";
    }
    renderThread();
    renderThinking();
    updateMeter();
  }

  // ---------------- 模型切换（用户要求：编辑器内可切换模型） ----------------

  /**
   * 拉取模型清单（结果缓存到模块级）。
   *
   * 门面永不抛错：网页版会给 mock 两条，所以 UI 任何情况下都有内容，
   * 不需要在这里写"没宿主"的降级分支。
   */
  async function loadModels(): Promise<AiModelsState | null> {
    if (modelsState) return modelsState;

    try {
      modelsState = await aiModels();
      return modelsState;
    } catch {
      modelsState = null;
      return null;
    }
  }

  /**
   * 取清单，**未加载就抛错**。
   *
   * 为什么抛错而不是返回空：这类 bug 的形态是「看起来实现了、实际恒为空」
   * —— 静默降级成空值，UI 只是少显示一块，没人会发现。
   * 前面已经因此栽过三次（chip 恒 null / reachable 死分支 / 批量条恒隐藏）。
   *
   * 抛错能让开发期**立刻炸**（控制台一片红），而不是静默渲染成空。
   * 生产环境由调用方 try/catch 兜底（渲染不该因为一个提示条把整个面板打死）。
   */
  function requireModels(where: string): AiModelsState {
    if (!modelsState) {
      throw new Error(`[AI 面板] ${where} 在 modelsState 未加载时被调用 —— `
        + `凡是读取清单/activeEntry/countXxx 的渲染必须在 await loadModels() 之后。`);
    }
    return modelsState;
  }

  /** 当前模型条目。 */
  function activeEntry(): AiModelEntry | null {
    if (!modelsState) return null;
    return modelsState.models.find((m) => m.id === modelsState!.active) ?? modelsState.models[0] ?? null;
  }

  /**
   * 一个条目「下一步该做什么」。
   *
   * 为什么单独抽：needsKey 与 ready 是两件事（host.ts 的类型注释写明了）------
   *   needsKey=true                -> 缺 key，下一步是「填 key」
   *   needsKey=false, ready=false  -> 填了但连不上，下一步是「检查 baseUrl / 网络」
   * 合并成一句"不可用"，用户就不知道该干嘛了。
   */
  /** 顶部右侧的模型下拉 + 导入按钮。 */
  function renderModelPicker(bar: HTMLElement): void {
    const box = el("div", { class: "ai-model-picker" });

    const activeForTip = activeEntry();
    const sel = el("select", {
      class: "select ai-model-select",
      title: activeForTip
        ? `当前：${activeForTip.label} · ${modelStateOf(activeForTip, false).short}（切换后下一轮对话生效）`
        : "切换模型（下一轮对话生效）"
    });
    sel.dataset.aiModelSelect = "1";
    const models = modelsState?.models ?? [];
    const active = activeEntry();
    for (const m of models) {
      // 下拉项后缀由 aiModelState.ts 单点决定，只说"缺什么"，不说"能不能用"
      // （ready 只代表配置齐了，不代表连得上）。
      const hint = modelStateSuffix(m);
      const opt = el("option", { value: m.id }, hint ? `${m.label}（${hint}）` : m.label);
      if (active && m.id === active.id) opt.selected = true;
      sel.appendChild(opt);
    }
    if (!models.length) {
      sel.appendChild(el("option", { value: "" }, "没有可用模型"));
    }
    sel.addEventListener("change", () => {
      const picked = models.find((m) => m.id === sel.value);
      if (!picked) return;
      // 只有"真的缺 key"才弹输入框（判断走单点，不许面板直读字段）。
      if (isNeedsKey(picked)) {
        sel.value = active?.id ?? "";
        keyDialogFor = picked;
        renderKeyDialog();
        return;
      }
      // Key 失效（填过但这次启动解不开）也**直接弹重填框**：
      // 这是用户唯一的自救路径，不能让他先切过去再失败一次才看到提示。
      if (needsReKey(picked)) {
        sel.value = active?.id ?? "";
        keyDialogFor = picked;
        renderKeyDialog();
        return;
      }
      void applyModel(picked.id);
    });
    box.appendChild(sel);

    const importBtn = button("从 Trae 导入", () => void doImportTrae(), {
      size: "sm",
      variant: "ghost",
      iconPath: I.import,
      title: "从本机 Trae 编辑器的配置里导入模型（API Key 是设备绑定的，无法导出，导入后要手填）"
    });
    importBtn.dataset.aiImportTrae = "1";
    box.appendChild(importBtn);

    // 「+ 添加模型」：Trae 里没有的模型（DeepSeek 官方 / 自建反代 / 本地 Ollama）
    // 必须能手动录入 —— 只靠"下拉里选 needsKey 项弹 key 框"只能给已有条目补 key，
    // 满足不了"新增一个不在导入清单里的模型"。
    const addBtn = button("+ 添加", () => openAddModelDialog(), {
      size: "sm",
      variant: "ghost",
      iconPath: I.plus,
      title: "手动添加模型（供应商 / 服务地址 / 模型名 / API Key）"
    });
    addBtn.dataset.aiAddModel = "1";
    box.appendChild(addBtn);

    // ---- 编辑 / 删除当前模型（v3） ----
    //
    // 为什么挂在「当前项」上而不是下拉里每条 hover：
    //   原生 `<select>` 的 option 不能放按钮（浏览器不渲染 option 内的元素），
    //   要做「每条 hover 出按钮」就得把 select 换成自绘列表 —— 那会一并推翻
    //   `[data-ai-model-select]` 这个验收锚点与键盘可达性。
    //   改完之后用户要处理的一定是**当前这条**（配错的 baseUrl、想换的 key），
    //   所以「下拉选到它 → 点编辑」两跳即可到达，且完全不动现有下拉。
    //
    // 措辞纪律：按钮 disabled 时 **必须说明为什么**（title + 文案里带「先选」），
    //   否则用户点不动只会以为界面坏了 —— 没有模型时它俩就是不可用的。
    const editable = active;
    const editBtn = button("编辑", () => {
      const cur = activeEntry();
      if (cur) openAddModelDialog(cur);
    }, {
      size: "sm",
      variant: "ghost",
      iconPath: I.wand,
      title: editable
        ? `修改「${editable.label}」的供应商 / 地址 / 模型名 / key（Key 留空表示不改）`
        : "先添加或选一个模型，才有可编辑的条目"
    });
    editBtn.dataset.aiEditModel = "1";
    editBtn.disabled = !editable;
    box.appendChild(editBtn);

    const delBtn = button("删除", () => {
      const cur = activeEntry();
      if (cur) void removeModelViaHost(cur);
    }, {
      size: "sm",
      variant: "ghost",
      iconPath: I.trash,
      title: editable
        ? `从清单里删掉「${editable.label}」（会先确认；至少保留一条模型）`
        : "先添加或选一个模型，才有可删除的条目"
    });
    delBtn.dataset.aiDelModel = "1";
    delBtn.disabled = !editable;
    box.appendChild(delBtn);

    // 模型计数：原生 select 折叠时只显示当前项，用户看不到"还有几个可选"。
    // 这行小字同时解决了产品上的信息缺失与验收截图的自证需求。
    const needsKey = countNeedsKey(models);
    const broken = countKeyBroken(models);
    // 「待填 key」和「Key 失效」必须分开写：前者用户没填过，后者填过但解不开，
    // 合并成一个数字会让人以为"所有都要重填"，也看不出是客户端故障。
    const bits: string[] = [];
    if (needsKey) bits.push(`${needsKey} 个待填 key`);
    if (broken) bits.push(`${broken} 个 Key 失效`);
    const countText = models.length
      ? `共 ${models.length} 个模型${bits.length ? `（${bits.join("、")}）` : ""}`
      : "没有可用模型（桌面版可导入）";
    const countHint = el("span", { class: "hint ai-model-count" }, countText);
    countHint.dataset.aiModelCount = "1";
    box.appendChild(countHint);

    bar.appendChild(box);
  }

  /** 真正切模型：成功后刷新清单，并提示"下一轮生效"。 */
  async function applyModel(id: string, apiKey?: string): Promise<void> {
    try {
      // AiModelsState 现在正式带 message / ready（host.ts 已补齐），直接用类型。
      const next = await aiSetModel(id, apiKey);
      modelsState = next;
      const entry = next.models.find((m) => m.id === next.active) ?? null;
      if (entry) {
        currentModelLabel = entry.label;
        appendOutput("AI", `模型已切换到 ${entry.label}（${entry.provider} / ${entry.model}）`);

        // 切换「成功」≠「能用」。ready===false 时必须用 warn 级提示，
        // 并把主进程给的 message 原样带出来（它就是 reason）。
        // 用 ok() 会让用户以为已经可以对话了 —— 这是实测发现的缺口。
        // ready 的判定也走单点（canUseNow），避免面板自己读原始字段
        if (!canUseNow(entry)) {
          warn(next.message || `已切换到「${entry.label}」，但当前模型不可用`);
        } else if (isNeedsKey(entry)) {
          warn(`已切换到「${entry.label}」，它还没有 API Key（点下拉重新选它可填写）`);
        } else {
          ok(`已切换到「${entry.label}」，下一轮对话生效`);
        }
        // 常驻状态标识由 refreshStatus 重画（见顶部 chip），这里只保证它被刷新
      } else {
        warn("切换后没有找到对应模型，请检查清单");
      }
    } catch (e) {
      error(`切换模型失败：${(e as Error).message}`);
    }
    renderThread();
    // renderThread 会整树重建，DOM-only 的思考块会被一起清掉；
    // 若此刻正在跑一轮（用户是在流式过程中换的模型），必须把它补回来，
    // 否则界面会突然"没有反应"，而请求其实还在跑。
    renderThinking();
    updateMeter();
    // 顶部条重画（下拉里的选中项、needsKey 标记都可能变）——
    // 这句以前是死代码（`meterEl` 恒 null），用户看到的就是「切完模型顶部不变」。
    await refreshHeadNow();
  }

  /** needsKey 条目的填 key 小输入框。 */
  function renderKeyDialog(): void {
    if (!keyDialogFor) return;
    const m = keyDialogFor;
    modal({
      title: `填写 API Key — ${m.label}`,
      body: () => {
        const col = el("div", { class: "col" });
        col.appendChild(
          el(
            "div",
            { class: "hint" },
            `这个模型来自 ${m.provider}（${m.baseUrl || "未提供地址"}）。\n`
            // ⚠ 文案必须区分两种原因 —— 说错会让用户白折腾：
            //   · key-broken：用户填过，但本次启动 Electron 安全存储解不开
            //   · needs-key：用户从来没填过
            + (needsReKey(m)
              ? "你的 Key 已经加密保存过，但本次启动解不开（Electron 安全存储失效）。\n"
                + "重新粘贴一次就能恢复 —— 填完立即生效，不需要重启。\n"
              : "它还没有 API Key，所以现在发不出请求。填好保存后即可使用。\n")
            + "提示：从其他编辑器（如 Trae）导入的 Key 通常是设备绑定的、无法导出，需要在这里手动填。"
          )
        );
        col.appendChild(el("div", { class: "group-label" }, "API Key"));
        const inp = el("input", {
          class: "input",
          type: "password",
          placeholder: "粘贴 API Key（不会明文显示）",
          autocomplete: "off",
          spellcheck: "false"
        });
        inp.dataset.aiKeyInput = "1";
        col.appendChild(inp);
        return col;
      },
      actions: [
        {
          label: "保存并切换",
          variant: "primary",
          onClick: (close) => {
            const key = (document.querySelector("[data-ai-key-input]") as HTMLInputElement | null)?.value.trim() ?? "";
            if (!key) {
              warn("Key 不能为空");
              return;
            }
            close();
            keyDialogFor = null;
            void applyModel(m.id, key);
          }
        },
        {
          label: "取消",
          variant: "ghost",
          onClick: (close) => {
            keyDialogFor = null;
            close();
          }
        }
      ],
      onClose: () => {
        keyDialogFor = null;
      }
    });
  }

  /**
   * 从 Trae 导入。
   *
   * warnings 是**一等内容**：Trae 的 Key 是设备绑定的、无法导出，
   * 不把这句话显示出来，用户点完导入会以为已经能用了。
   */
  async function doImportTrae(): Promise<void> {
    importPreview = null;
    try {
      importPreview = await aiImportTrae();
    } catch (e) {
      importPreview = { ok: false, providers: [], warnings: [`导入失败：${(e as Error).message}`] };
    }
    modelDialogOpen = true;
    renderImportModal();
  }

  function renderImportModal(): void {
    const r = importPreview;
    if (!r) return;
    const providers = r.providers ?? [];
    const needsKeyCount = countNeedsKey(providers);

    modal({
      title: r.ok ? `从 Trae 导入模型（找到 ${providers.length} 个）` : "从 Trae 导入模型",
      wide: true,
      body: () => {
        const col = el("div", { class: "col" });

        if (providers.length) {
          col.appendChild(
            el(
              "div",
              { class: "hint" },
              `找到 ${providers.length} 个可用模型配置，其中 ${needsKeyCount} 个需要手动填写 API Key。`
            )
          );
          const list = el("div", { class: "ai-import-list" });
          for (const p of providers) {
            const row = el("div", { class: "ai-import-row" });
            const cb = el("input", { type: "checkbox", class: "ai-import-check" }) as HTMLInputElement;
            cb.checked = true;
            cb.dataset.aiImportCheck = "1";
            row.appendChild(cb);
            const info2 = el("div", { class: "grow" });
            info2.appendChild(el("div", { class: "name" }, p.label));
            info2.appendChild(
              el(
                "div",
                { class: "sub" },
                `${p.provider} · ${p.model}${p.baseUrl ? " · " + p.baseUrl : ""}`
                + (isNeedsKey(p) ? " · 需要填 key" : "")
              )
            );
            row.appendChild(info2);
            list.appendChild(row);
          }
          col.appendChild(list);
        } else {
          col.appendChild(el("div", { class: "hint" }, "没有从 Trae 配置里读到一个可用模型。"));
        }

        // warnings 逐条显示，不折叠 —— 看完才知道下一步该干嘛
        if (r.warnings?.length) {
          col.appendChild(el("div", { class: "group-label" }, "注意"));
          for (const w of r.warnings) {
            col.appendChild(el("div", { class: "hint ai-import-warning" }, `⚠ ${w}`));
          }
        }
        return col;
      },
      actions: [
        {
          label: `导入选中的${providers.length ? `（${providers.length}）` : ""}`,
          variant: "primary",
          onClick: (close) => {
            close();
            modelDialogOpen = false;
            // 导入 = 把清单刷新一遍（主进程已经把 provider 写进 settings）
            modelsState = null;
            void (async () => {
              await loadModels();
              // 导入完顶部状态条要立刻跟上（导入前这里是死代码，用户必须切标签才看到）
              void refreshHeadNow();
              ok(`已导入 ${providers.length} 个模型，其中 ${needsKeyCount} 个需要手动填写 API Key`);
              warn("Trae 的 API Key 是设备绑定的、无法导出，导入的模型需要你手动填 key 才能用");
            })();
          }
        },
        {
          label: "关闭",
          variant: "ghost",
          onClick: (close) => {
            modelDialogOpen = false;
            close();
          }
        }
      ],
      onClose: () => {
        modelDialogOpen = false;
      }
    });
  }


  // ---------------- 手动添加 / 编辑模型（用户明确要求「自己填 key」的完整入口） ----------------

  /**
   * 打开「添加模型」/「编辑模型」对话框。
   *
   * 为什么需要它（而不是只靠下拉里选 needsKey 项弹 key 输入框）：
   *   下拉那条路径只能给**已有的**条目补 key。用户要的第二种情况是
   *   「Trae 里根本没有的模型」—— 比如 DeepSeek 官方、自己的反代、本地 Ollama。
   *   这些必须能手动录入 provider / baseUrl / model / key。
   *
   * v3 起同一个表单兼职「编辑」：传 `editing` 就预填现有值。
   * 为什么不另做一个编辑表单：两边字段完全一样，复制一份之后必然出现
   *   「添加支持 contextWindow、编辑忘了带」这类不对称 —— 而编辑预填的正是
   *   用户配错后要改的那几个字段（provider / baseUrl / model / label / contextWindow）。
   *
   * **API Key 不预填**（也读不到：主进程从不回传明文），留空 = 不改。
   * 这与主进程 `addModel` 的三态语义一致（空串不清 key），所以「改地址但不换 key」
   * 提交后 key 仍在 —— 这一点必须让用户看到，否则他会以为要重填一次。
   *
   * 判重由主进程负责（同 provider+baseUrl+model = 同一条，就地更新并保留原 id），
   * 所以这里不需要在前端做去重判断 —— 重复提交会变成"更新"，不会产生第二条。
   */
  function openAddModelDialog(editing?: AiModelEntry): void {
    // provider 预设：常见几家的 baseUrl 自动填，减少用户手打出错
    const PRESET_URL: Record<string, string> = {
      deepseek: "https://api.deepseek.com",
      siliconflow: "https://api.siliconflow.cn/v1",
      "openai-compatible": "http://127.0.0.1:11434/v1"
    };
    // 编辑时用现有值打底；新增时用 deepseek 预设打底（最常见的一条路）
    const isEdit = Boolean(editing);
    const prefillUrl = editing?.baseUrl || PRESET_URL["deepseek"] || "";

    modal({
      title: isEdit ? `编辑模型 — ${editing!.label}` : "添加模型",
      wide: true,
      body: () => {
        const col = el("div", { class: "col" });

        col.appendChild(
          el(
            "div",
            { class: "hint" },
            isEdit
              ? "改动会写回这条模型（判重键是「供应商 + 地址 + 模型名」：命中同一条就地更新，不会多出一条）。\n"
                + "API Key 不预填也读不出来：**留空表示保持原来的 key 不变**，只有填了新值才覆盖。"
              : "填一个 Trae 里没有的模型（DeepSeek 官方 / 自建反代 / 本地 Ollama 等）。\n"
                + "同一个「供应商 + 地址 + 模型名」会被视为同一条：重复提交是更新，不会多出一条。"
          )
        );

        const form = el("div", { class: "ai-add-form" });

        // 供应商
        form.appendChild(el("div", { class: "group-label" }, "供应商 Provider"));
        // 编辑态可能是一条**不在预设列表里**的 provider（Trae 导入的自定义项）：
        // 硬塞进固定四项会让它显示成第一项，用户一保存就被改写成别的供应商。
        // 所以当前值若不在列表里，先补进选项，其余保持原顺序。
        const provSel = el("select", { class: "select", "data-ai-add-provider": "1" });
        const provChoices = ["deepseek", "siliconflow", "openai-compatible", "mock"];
        if (editing?.provider && !provChoices.includes(editing.provider)) {
          provChoices.unshift(editing.provider);
        }
        for (const p of provChoices) provSel.appendChild(el("option", { value: p }, p));
        if (editing?.provider) provSel.value = editing.provider;
        form.appendChild(provSel);

        // 服务地址
        form.appendChild(el("div", { class: "group-label" }, "服务地址 Base URL"));
        const urlInput = el("input", {
          class: "input",
          type: "text",
          placeholder: "https://api.deepseek.com",
          "data-ai-add-baseurl": "1"
        });
        urlInput.value = prefillUrl;
        form.appendChild(urlInput);

        // 模型名（必填）
        form.appendChild(el("div", { class: "group-label" }, "模型名 Model（必填）"));
        const modelInput = el("input", {
          class: "input",
          type: "text",
          placeholder: "例如 deepseek-chat / moonshotai/Kimi-K2-Thinking",
          "data-ai-add-model-name": "1"
        });
        modelInput.value = editing?.model ?? "";
        form.appendChild(modelInput);

        // 显示名
        form.appendChild(el("div", { class: "group-label" }, "显示名 Label（选填，留空用模型名）"));
        const labelInput = el("input", {
          class: "input",
          type: "text",
          placeholder: "例如 DeepSeek 聊天",
          "data-ai-add-label": "1"
        });
        labelInput.value = editing?.label ?? "";
        form.appendChild(labelInput);

        // Key
        form.appendChild(
          el("div", { class: "group-label" }, isEdit ? "API Key（留空 = 不改）" : "API Key（可留空，之后再填）")
        );
        const keyInput = el("input", {
          class: "input",
          type: "password",
          placeholder: isEdit
            ? "留空表示保持现有 key 不变；粘贴新值才覆盖"
            : "粘贴 API Key（不会明文显示；留空表示稍后填写）",
          autocomplete: "off",
          spellcheck: "false",
          "data-ai-add-key": "1"
        });
        form.appendChild(keyInput);
        form.appendChild(
          el(
            "div",
            { class: "hint" },
            isEdit
              ? "看不清现有 key 是**故意的**：它只以密文存在于设置里，界面从不回显明文。"
              : "留空也能先创建，之后在下拉里选中它会提示「需要填 API Key」。"
          )
        );

        // 上下文窗口（选填）
        form.appendChild(el("div", { class: "group-label" }, "上下文窗口 tokens（选填）"));
        const ctxInput = el("input", {
          class: "input",
          type: "number",
          placeholder: "例如 65536",
          "data-ai-add-context": "1"
        });
        if (editing?.contextWindow) ctxInput.value = String(editing.contextWindow);
        form.appendChild(ctxInput);

        col.appendChild(form);

        // 切供应商时自动填地址（用户改过就不再覆盖）。
        // ⚠ 编辑态**一开始就算「改过」**：预填的是这条自己保存的地址，
        //   切一下供应商就把它冲掉，等于「我只是想看看」就把配置丢了。
        let urlTouched = isEdit;
        urlInput.addEventListener("input", () => {
          urlTouched = true;
        });
        provSel.addEventListener("change", () => {
          if (urlTouched) return;
          const preset = PRESET_URL[provSel.value];
          if (preset) urlInput.value = preset;
        });

        return col;
      },
      actions: [
        {
          label: isEdit ? "保存修改" : "添加并切换",
          variant: "primary",
          onClick: (close) => {
            const read = (sel: string): string =>
              (document.querySelector(sel) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? "";

            const provider = read("[data-ai-add-provider]");
            const model = read("[data-ai-add-model-name]");
            const baseUrl = read("[data-ai-add-baseurl]");
            const label = read("[data-ai-add-label]");
            const apiKey = read("[data-ai-add-key]");
            const ctxRaw = read("[data-ai-add-context]");

            // 前端只做"明显填错"的拦截；业务规则（缺 model / 缺 baseUrl / 判重）
            // 一律交给主进程，避免两边规则漂移。
            if (!model) {
              warn("模型名必填（例如 deepseek-chat）");
              return;
            }
            if (provider !== "mock" && !baseUrl) {
              warn("服务地址必填（例如 https://api.deepseek.com）");
              return;
            }

            close();
            void addModelViaHost(
              {
                provider,
                baseUrl,
                model,
                label,
                apiKey,
                contextWindow: ctxRaw ? Number(ctxRaw) : undefined
              },
              // 编辑态要把**原条目 id** 交代清楚，理由见 addModelViaHost 的注释：
              // 改了 provider/地址/模型名就等于换了判重键，主进程会建一条新 id，
              // 旧 id 会留在清单里变成第二条 —— 那正是用户说的「配错了想改」的场景。
              editing ? { replaceId: editing.id } : undefined
            );
          }
        },
        { label: "取消", variant: "ghost", onClick: (close) => close() }
      ]
    });
  }

  /**
   * 调主进程 add-model 通道。
   *
   * 判重 / provider 降级 / 缺字段校验全在主进程（modelCatalog.mjs，有单测），
   * 渲染侧不复制任何业务规则 —— 两边各写一套一定会漂移。
   *
   * @param opts.replaceId 编辑模式：用户改的是**哪一条**。
   *
   *   ⚠ 为什么必须带：主进程的判重键是 `provider+baseUrl+model`，而「编辑」
   *   改的恰恰往往是这三者之一 —— 改完就是一条**新的 id**，旧条目会原样留着。
   *   用户看到的是「我改了一条，怎么多出来一条」，而他本意是修好那条。
   *   所以这里在「新增成功 + 判重没命中（created）」时把旧 id 删掉。
   *
   *   为什么放在渲染侧而不是主进程：主进程 `add-model` 的语义是"加入/更新一条"，
   *   给它加一个"顺便删掉另一条"的入参会污染一个已经被单测锁住的契约
   *   （跨进程契约本轮不由我改）。删除走的是**已有的** `bwe:ai-remove-model`，
   *   没有新造通道；两步操作的最大风险是「第一步成功、第二步失败」——
   *   那时清单里确实会多一条旧条目，但它是完整可用的一条，不是数据损坏，
   *   而且会被下面的 warn 明确说出来，用户可以再点一次删除。
   */
  async function addModelViaHost(input: AiModelInput, opts?: { replaceId?: string }): Promise<void> {
    try {
      const r = await aiAddModel(input);
      // 直接用返回体做新清单：网页版（mock）没有持久层，`aiModels()` 每次都从
      // 内置模板重新造清单 —— 先清空再重拉会把刚添加的那条**冲掉**（下拉里看不到）。
      modelsState = r;
      const refreshed = await loadModels();
      const entry = refreshed ? refreshed.models.find((m) => m.id === refreshed.active) : null;
      currentModelLabel = entry?.label ?? input.label ?? input.model;

      const scoped = r as AiModelsState & { created?: boolean; updated?: boolean; warning?: string };
      const reused = scoped.created === false && scoped.updated === true;

      // 编辑 + 判重没命中 = 真的换了身份 → 收敛掉旧条目。
      // 判重命中（reused）说明主进程就地更新了同一条，旧 id 根本不存在了。
      let removedOld = false;
      if (opts?.replaceId && !reused && refreshed && refreshed.models.some((m) => m.id === opts.replaceId)) {
        try {
          const after = await aiRemoveModel(opts.replaceId);
          if (Array.isArray(after.models)) {
            modelsState = after;
            removedOld = after.models.length < refreshed.models.length;
          }
        } catch {
          /* 删不掉就留着，下面会明确告知（数据没坏，只是多一条） */
        }
      }

      if (opts?.replaceId) {
        ok(
          removedOld
            ? `已保存修改（原条目已合并为「${currentModelLabel}」）`
            : reused
              ? `已更新模型「${currentModelLabel}」`
              : `已保存为「${currentModelLabel}」，旧条目仍在清单里（可手动删除）`
        );
      } else if (reused) {
        ok(`已更新已有模型「${currentModelLabel}」`);
      } else {
        ok(`已添加并切换到「${currentModelLabel}」`);
      }
      // 主进程的 warning 是一等提示（例如"未知 provider 已按 openai-compatible 处理"），
      // 不当成功吞掉。
      if (scoped.warning) warn(scoped.warning);
      // 加完就不可用的情况（例如没填 key 就添加）也要立刻说清楚。
      // 判定走单点：直接读 r.ready 会让面板又维护一份"什么算可用"的定义。
      if (entry && !canUseNow(entry)) warn(r.message || "模型已添加，但当前还不能发请求");
      appendOutput("AI", `${opts?.replaceId ? "编辑模型" : "手动添加模型"}：${input.provider} / ${input.model}`);
      renderThread();
      updateMeter();
      // 顶部条刷新必须落在最后：chip 上的模型名/状态、下拉选中项、计数全靠它重画。
      // 早先这里是死代码（句柄从未赋值），用户必须切窗口才看到新模型 —— 见 refreshHeadNow。
      await refreshHeadNow();
    } catch (e) {
      warn(`添加模型失败：${(e as Error).message}`);
    }
  }

  /**
   * 删掉一条模型（走**现有**的 `bwe:ai-remove-model`，不新造通道）。
   *
   * 为什么不做成「只在前端隐藏」：主进程已经有这条通道、有单测，也保证了两条硬约束
   * （不许删到清单为空 / 删当前项时 active 自动落到剩下的第一条）。前端另做一套
   * "只隐藏"等于让界面和 settings 说的不是同一件事 —— 用户下次启动又看到它回来了。
   *
   * 二次确认是必须的：这是**破坏性**操作，而它就在模型下拉旁边，
   * 误点一次就等于把一条配好的模型（含 key 引用）删掉。
   */
  async function removeModelViaHost(entry: AiModelEntry): Promise<void> {
    const yes = await confirmDialog(
      `删除模型「${entry.label}」？`,
      `这条会从模型清单里移除（含它的地址与已保存的 key 引用）。\n`
      + `如果它是当前使用的模型，会自动切到剩下第一条；最后一条不允许删除。`,
      "删除",
      true
    );
    if (!yes) return;
    try {
      const next = await aiRemoveModel(entry.id);
      modelsState = next;
      // 删除后的清单与 active 一律以返回值为准（主进程保证 active 落在存在的 id 上）
      const left = next.models.find((m) => m.id === next.active) ?? null;
      currentModelLabel = left?.label ?? "";
      const gone = !next.models.some((m) => m.id === entry.id);
      if (gone) ok(`已删除「${entry.label}」`);
      else warn(next.message || `没有删掉「${entry.label}」（至少保留一条模型）`);
      if (left && !canUseNow(left)) warn(next.message || `已切到「${left.label}」，但它当前不可用`);
      appendOutput("AI", `删除模型：${entry.provider} / ${entry.model}`);
      renderThread();
      updateMeter();
      await refreshHeadNow();
    } catch (e) {
      error(`删除模型失败：${(e as Error).message}`);
    }
  }

  // ---------------- 单轨宿主 / 空闲态 / 行为摘要条（契约 §2 §3，v3 修订） ----------------

  /**
   * 把「这条内容属于哪一类」写到节点上（`data-ai-kind` + `.ai-act` 标记）。
   *
   * 为什么还走 `zoneFor()`：它问的是同一个问题（「这是它做的，还是我说的」），
   * 单点判定必须只有一份 —— 调用点各自写 `kind === "tool" ? ...` 就是第二份规则。
   * v3 起它不再**选宿主**（只有一个宿主），而是决定**视觉分档**：
   *   · user / assistant → 不加标记（.ai-msg 自带气泡样式）
   *   · 其余（它做的事）→ `.ai-act` + `data-ai-kind`，样式表据此画成
   *     「日志行」而不是「气泡」，一条时间线里两种密度才分得清。
   * `agent` 这一档正好就是「它做的」，所以判断仍由 `zoneFor()` 给出，别在这里重写。
   */
  function markBlock(kind: AiStreamKind, node: HTMLElement): void {
    node.dataset.aiKind = kind;
    if (zoneFor(kind) === "thread") return;
    node.classList.add("ai-act");
  }

  /**
   * 正在流式输出的助手气泡（末尾那个带 `.ai-cursor` 的 `.ai-msg.assistant`）。
   *
   * 为什么需要它：单轨之后**顺序就是语义**。流式期间助手气泡在 `send()` 里就建好了
   * （那时正文还是空的），而工具块/思考块是在那之后才逐个到达的 —— 直接 append 会把
   * 「它正在做的事」排到自己那句还没说完的话**下面**，读起来像是回答之后又干活。
   * 所以行为类节点一律插到它前面，气泡永远留在末尾（直到回答说完）。
   */
  function liveBubble(): HTMLElement | null {
    const last = thread.lastElementChild as HTMLElement | null;
    if (!last) return null;
    return last.classList.contains("ai-msg") && last.classList.contains("assistant") && last.querySelector(".ai-cursor")
      ? last
      : null;
  }

  /**
   * 把「它做的事」放到轨道上正确的先后位置。
   *
   * 规则：有在流的助手气泡就插到它前面，否则追加到末尾。
   * 这条规则只有一份，思考块与工具块都走它 —— 两处各写一遍就会出现
   * 「思考在气泡下面、工具在气泡上面」这种自相矛盾的顺序。
   */
  function appendActNode(node: HTMLElement): void {
    const bubble = liveBubble();
    if (bubble) thread.insertBefore(node, bubble);
    else thread.appendChild(node);
  }

  /** 所有内容**只有一个宿主**（`.ai-thread`）：行为与对话同轨，按发生顺序追加。 */
  function appendBlock(kind: AiStreamKind, node: HTMLElement): void {
    markBlock(kind, node);
    // ⚠ 这里一律追加到末尾，**不做插队**：整树重建时顺序由 `renderThread` 自己排
    //   （它把工具块排在助手气泡之前），插队反而会打乱重建出来的先后。
    //   需要「插到尚未说完的回答之前」的只有流式追加路径 —— 见 appendActNode。
    thread.appendChild(node);
  }

  /**
   * 整条轨道里「它做的事」→ 摘要输入。
   *
   * 为什么从 DOM 读、而不是从 `turns` 拼：轨道里有**不属于任何回合**的内容 ——
   * 进行中的思考块、diff 预览、一次性系统提示。只从数据层拼必然漏掉它们，
   * 漏掉的直接后果是摘要条写着「完成」，而下面明明还红着一条失败的工具块。
   * 判据与契约 §3 一致：`.ai-tool.failed` = 失败，`.ai-tool.ok` = 成功，两者都没有 = 未回执。
   *
   * ⚠ 从 v3 起工具块与消息**同处 thread**，所以这里必须按 `data-ai-kind` 过滤，
   *   不能像以前那样「扫宿主子节点全是行为块」。`user/assistant` 是「我说的话」，
   *   不计步数（计入就会把「三步工具」说成「五步」）。
   */
  function agentBlocksFromDom(): AiStreamBlock[] {
    const out: AiStreamBlock[] = [];
    for (const node of Array.from(thread.children)) {
      const e = node as HTMLElement;
      const marked = e.dataset.aiKind as AiStreamKind | undefined;
      if (marked === "user" || marked === "assistant") continue;
      if (e.classList.contains("ai-tool")) {
        const ok = e.classList.contains("failed") ? false : e.classList.contains("ok") ? true : undefined;
        out.push({ kind: "tool", ok });
      } else if (e.classList.contains("ai-thinking")) out.push({ kind: "thinking" });
      else if (e.classList.contains("ai-msg")) out.push({ kind: "system" });
      else if (e.classList.contains("ai-notice")) out.push({ kind: "notice" });
      else if (e.classList.contains("ai-note")) out.push({ kind: "note" });
      else if (e.classList.contains("ai-error")) out.push({ kind: "error" });
      else if (e.classList.contains("ai-diff")) out.push({ kind: "diff" });
    }
    return out;
  }

  const AGENT_STATE_CN: Record<AgentSummary["state"], string> = {
    idle: "等待指令",
    running: "执行中",
    done: "完成",
    failed: "有失败"
  };

  /** 重画 Agent 头（步数 / 失败数 / 状态徽标）。新块出现与每回合结束都要刷。 */
  function refreshAgentHead(): void {
    // 没有对话时喂空列表：此时 DOM 里只可能躺着「首屏说明」这类 system 块，
    // 按块算会得出「完成 / 无工具调用」—— 而用户看到的是一片空白 + 欢迎区，
    // 头部说"完成"是自相矛盾的。空闲与否由 turns/demoCount 判定（与 .is-idle 同源）。
    const idlePanel = turns.length === 0 && demoCount === 0;
    const summary = summarizeAgent(idlePanel ? [] : agentBlocksFromDom(), { busy: !!currentRequest });
    agentHead.dataset.state = summary.state;
    // 空闲态只说「等待指令」：这时候「0 步 / 完成」都是废话，还会让人以为它跑过了
    if (summary.state === "idle") {
      agentSteps.textContent = "等待指令";
      agentBadge.hidden = true;
      agentBadge.textContent = "";
      return;
    }
    const stepText = summary.steps ? `${summary.steps} 步` : "无工具调用";
    agentSteps.textContent = summary.failed ? `${stepText} · 失败 ${summary.failed}` : stepText;
    agentBadge.textContent = AGENT_STATE_CN[summary.state];
    agentBadge.hidden = false;
  }

  /**
   * 面板状态同步：`.is-idle` / `.ai-hero` / `[data-busy]` / Agent 头。
   *
   * 为什么收在一个函数里：这些状态由**同一批事实**（turns / currentRequest / 轨道内容）
   * 决定，分散到每个事件分支里各改一处，必然出现「流式结束忘了摘 data-busy」这种漏改。
   */
  function syncPanelState(): void {
    // 空闲 ⇔ 还没有任何对话；演示注入的块也算内容，否则下一次同步就把 hero 塞回来了
    const idle = turns.length === 0 && demoCount === 0;
    wrap.classList.toggle("is-idle", idle);
    if (currentRequest) wrap.dataset.busy = "1";
    else delete wrap.dataset.busy;

    if (idle) {
      if (heroEl && !heroEl.isConnected) streams.insertBefore(heroEl, streams.firstChild);
    } else if (heroEl?.isConnected) {
      heroEl.remove();
    }
    refreshAgentHead();
  }

  /** 空闲态的欢迎区：标题 + 一句说明 + 三条建议。 */
  function heroView(): HTMLElement {
    const box = el("div", { class: "ai-hero" });
    box.dataset.aiHero = "1";
    box.appendChild(el("div", { class: "ai-hero-title" }, "BWE AI"));
    box.appendChild(
      el(
        "div",
        { class: "ai-hero-sub" },
        "读工程摘要与脚本诊断，**直接改工程内脚本**（改完可 Ctrl+Z 撤销）。"
        + "引擎源码与工程文件本体它不碰。"
      )
    );
    const rows = el("div", { class: "ai-hero-suggests" });
    // 建议行点了只**填进输入框**，不直接发：用户通常要先补两个字（哪个对象、哪个脚本），
    // 直接发出去等于替他决定了问题，还得再撤一遍。
    const suggestions = [
      "解释当前脚本错误，给出最小修法",
      "审一遍当前场景，指出最值得改的 3 处",
      "帮我加一个跟随玩家的相机脚本"
    ];
    for (const s of suggestions) {
      // 用裸 button 而不是 button() 助手：`.btn` 那套高度/内边距会把建议行的胶囊样式压成
      // 24px 的小按钮（样式表是按 `.ai-hero-suggest` 独立定义的，不带 .btn）。
      const b = el("button", { type: "button", class: "ai-hero-suggest", title: "填进输入框（不直接发送）" }, s);
      b.dataset.aiHeroSuggestion = "1";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        ta.value = s;
        ta.focus();
      });
      rows.appendChild(b);
    }
    box.appendChild(rows);
    return box;
  }

  // ---------------- 内部渲染 ----------------

  /**
   * 整树重建**唯一**宿主的注释见 `renderThread` 定义处；这里只说明 v3 的变化：
   * 行为块与消息同处 `.ai-thread`，因此重建一次就够 —— 不再有第二个容器要清空，
   * 也就不会出现「一处清了、另一处忘了清」导致的重影。
   *
   * 为什么仍然整树重建（而不是增量）：切会话 / 重试 / 错误回填都是"数据整体变了"，
   * 增量要维护一堆对应关系，而这里只有几十个节点，重建代价可以忽略。
   * 流式增量走 appendDelta（只改最后一个气泡的文字），不经过这里。
   */
  function renderThread(): void {
    thread.replaceChildren();

    if (!turns.length) {
      appendBlock(
        "system",
        el(
          "div",
          { class: "ai-msg system" },
          "AI 助手：读工程摘要、读脚本诊断、**直接改工程脚本**（改完可 Ctrl+Z 撤销）。\n"
          + "它能改的只有工程内脚本，不碰引擎源码与工程文件本体；删除仍被引用的脚本会被拒绝。"
        )
      );
    }

    for (const t of turns) {
      if (t.role === "user") {
        // 用户消息为空就不渲染（防御：上游 trim 过就不该出现空节点）
        if (!String(t.text ?? "").trim()) continue;
        appendBlock("user", el("div", { class: "ai-msg user" }, t.text));
        continue;
      }

      // **空助手消息完全不渲染**。
      // 用户截图里那几条"极淡的空白横线"就是它：一个只有边框/背景、
      // 没有文字的气泡。空消息没有任何信息量，留着只会让人以为加载失败。
      const hasText = String(t.text ?? "").trim().length > 0;
      const hasTools = Array.isArray(t.tools) && t.tools.length > 0;
      const hasError = Boolean(t.error);
      // 提示条也是内容：正文为空但这轮有「为什么没交付」的说明时，
      // 整条回合必须留下（否则最该看到的那句话会被这个跳过条件吃掉）。
      const hasNotices = Array.isArray(t.notices) && t.notices.length > 0;
      const hasNote = Boolean(t.note);
      if (!hasText && !hasTools && !hasError && !hasNotices && !hasNote && !t.streaming) continue;

      // 顺序 = 时间线（v3 单轨之后这一条才有意义）：
      //   工具调用 → 回答正文 → 「为什么没交付」的提示 → 无产出说明 → 错误。
      // 为什么工具块在气泡**之前**：它发生在回答之前，是回答的依据。
      // v2 两宿主时这段顺序看不出对错（分在两个容器里），照抄旧顺序会得到
      // 「先看到结论、才看到它查了什么」，用户会以为是两轮。
      for (const tool of t.tools) {
        const blk = toolBlock(tool);
        // 重建时也写 key：start 与 end 之间若发生过一次重绘，appendToolBlock 才认得出旧块，
        // 不会在轨道里多挂一条同名块（原来只在流式追加路径写 key）。
        blk.dataset.aiToolKey = toolKeyOf({ callId: tool.callId, name: tool.name });
        appendBlock("tool", blk);
      }
      if (hasText || t.streaming) {
        const bubble = el("div", { class: "ai-msg assistant" });
        bubble.appendChild(el("span", { class: "ai-text" }, t.text));
        if (t.streaming) bubble.appendChild(el("span", { class: "ai-cursor" }));
        appendBlock("assistant", bubble);
      }
      // **「为什么可能没交付」的提示条放在助手内容下方**（不是上方）：
      // 用户先读回答本身，再读「这段回答为什么不完整」的解释，
      // 顺序反过来会让人以为整轮都失败了。
      if (hasNotices) for (const n of t.notices!) appendBlock("notice", answerNoticeBlock(n));
      // 一条泛化的系统说明（正文为空且没有结构化提示时才产生，见 done 分支）。
      // 带「重试」：这时用户的唯一出口就是重发上一句（正文为空，没有可读的东西）。
      if (hasNote) appendBlock("note", noteBlock(t.note!, () => retryLastUserMessage()));
      // 错误用**独立的结构化气泡**（人话在上、技术详情折叠、request_id 可复制）
      if (t.error) appendBlock("error", errorBubble(t.error, t.errorRaw, t.recoverable));
    }

    // diff 预览追加在轨道末尾（跟随最新一次编辑；它不归属于任何回合）
    if (pendingEdit) appendBlock("diff", diffCard(pendingEdit));

    const last = liveAssistantTurn();
    if (last && last.streaming) {
      // 单轨只有一个滚动容器：滚到底就同时让最新消息与最新工具块可见
      thread.scrollTop = thread.scrollHeight;
    }
    syncPanelState();
  }

  /** 流式增量：只改最后一个气泡的文字，不整树重建（否则每 40ms 闪一次）。 */
  function appendDelta(fullText: string): void {
    const bubbles = thread.querySelectorAll(".ai-msg.assistant");
    const bubble = bubbles[bubbles.length - 1];
    if (!bubble) {
      renderThread();
      return;
    }
    const textBox = bubble.querySelector(".ai-text");
    if (textBox) {
      textBox.textContent = fullText;
    } else {
      renderThread();
      return;
    }
    thread.scrollTop = thread.scrollHeight;
  }


  // ---------------- 工具调用块（耗时 / 成败 / 完整错误） ----------------

  /**
   * 当前轮的 tool 调用登记表。
   *
   * ⚠ **必须用 `callId` 配对，不能用 name**：
   * 用户实际遇到过「两个同名 SceneDigest 连续调用」—— 按 name 配对会把
   * 第一次的 start 配到第二次的 end，耗时算错、成败甚至会串到另一个块上。
   * 只在主进程没给 callId 时才退回 name+序号（并接受这种退化的风险）。
   */
  /**
   * 处理 `tool` 事件：记录开始/结束，并返回该事件带来的增量信息。
   *
   * 兼容性设计（A 可能分两批落地）：
   *   · `phase` 缺省 → 按 end 处理（老版本只有一条"调用X"和一条"结果"两条消息，
   *     分不清谁是谁，那就当它是一条完整的事件，不显示耗时）；
   *   · `ms` 缺省 → 用 callId 计时（再退回 name+序号）；
   *   · `ok` 缺省 → **不显示成败徽标**（不猜成成功也不猜成失败 ——
   *     猜错的后果比不显示严重：把失败画成绿勾会让用户以为工具成功了）。
   */
  function appendToolBlock(tool: ToolCallBlock): void {
    // 同一个调用只产生**一个**块：start 建块，end 原地更新。
    //
    // ⚠ key 必须用 `callId`，不能用 `name::detail`：
    //   start 的 detail 是「调用 X(arg)」、end 的 detail 是「X 32 行 / 1.2K 字符」——
    //   两者**永远不同**，按 detail 做 key 会让每次调用变成两个块。
    //   这正是用户截图里"两个 SceneDigest 空块"的成因之一（另一个是 start 块本身没内容）。
    //   没有 callId 时（老契约）退回 name+序号，至少不会重复建块。
    const key = tool.callId ? `id:${tool.callId}` : `nm:${tool.name}`;
    // ⚠ 查存范围是整条轨道（v3 起工具块与消息同处 `.ai-thread`）：
    //   查 `thread` 而不是某个"行为区"，是因为**只有一个宿主**了 ——
    //   若还按老代码查一个不存在的容器，会退化成"每次事件都新建一条"。
    const existing = thread.querySelector(`[data-ai-tool-key="${CSS.escape(key)}"]`) as HTMLElement | null;
    if (existing) {
      // 原地替换成最新状态（保留展开状态由新块自己决定：失败默认展开）
      const wasOpen = (existing.querySelector(".body") as HTMLElement | null)?.style.display !== "none";
      const fresh = toolBlock(tool);
      fresh.dataset.aiToolKey = key;
      markBlock("tool", fresh);
      if (wasOpen) (fresh.querySelector(".body") as HTMLElement | null)!.style.display = "";
      existing.replaceWith(fresh);
    } else {
      const blk = toolBlock(tool);
      blk.dataset.aiToolKey = key;
      // 走 appendActNode（不是直接 append）：流式期间末尾是那句还没说完的回答，
      // 工具块必须排在它上面，否则「先看到结论、再看到它查了什么」。
      markBlock("tool", blk);
      appendActNode(blk);
    }
    thread.scrollTop = thread.scrollHeight;
    // 新块出现 = 摘要条那句「N 步 / 失败 N」可能变了（契约 §3：新块出现后刷新）
    refreshAgentHead();
  }

  /**
   * 工具块。
   *
   * 三种视觉（**这是用户报「AI 中断自己」的直接观感来源**）：
   *   · 失败：左侧红条 + `⚠ 失败` 徽标 + 展开显示**完整错误原文**（不截断）
   *   · 成功：左侧绿条（`ok === true` 才有；未知就不画，不猜）
   *   · 未知（老契约）：保持中性，只显示耗时
   * 为什么失败要红色且常驻展开：用户看到两个一模一样的块，根本不知道哪个失败了。
   */
  function toolBlock(tool: ToolCallBlock): HTMLElement {
    const box = el("div", { class: "ai-tool" });
    const failed = tool.ok === false;
    const okTrue = tool.ok === true;
    if (failed) box.classList.add("failed");
    else if (okTrue) box.classList.add("ok");

    const head = el("header");
    head.appendChild(svg(failed ? I.warn : I.puzzle, 13));
    head.appendChild(el("span", { class: "ai-tool-name" }, tool.name));
    // 成败徽标：只有明确知道才显示（ok 缺省 = 老契约 = 不猜）
    if (failed) head.appendChild(el("span", { class: "ai-tool-badge failed" }, "⚠ 失败"));
    else if (okTrue) head.appendChild(el("span", { class: "ai-tool-badge ok" }, "完成"));
    head.appendChild(el("div", { class: "spacer" }));
    // 耗时：用户判断"是不是卡死"的主要依据 —— 空块挂很久最吓人
    if (typeof tool.ms === "number") {
      head.appendChild(el("span", { class: "hint ai-tool-ms" }, `${Math.round(tool.ms)}ms`));
    }
    head.appendChild(el("span", { class: "hint" }, "工具调用"));

    // 失败时 body 默认**展开**：错误原文是用户拿去搜索/贴给别人看的，
    // 藏在折叠里等于没给。成功则默认折叠（内容通常很长，刷屏）。
    const body = el("div", { class: "body" });
    if (failed && tool.error) {
      // 完整错误原文，不截断（用户明确要求）
      body.appendChild(el("div", { class: "ai-tool-error mono" }, tool.error));
      if (tool.detail) body.appendChild(el("div", { class: "ai-tool-detail" }, tool.detail));
    } else {
      body.textContent = tool.detail;
    }
    let open = failed;
    body.style.display = open ? "" : "none";

    head.addEventListener("click", () => {
      open = !open;
      body.style.display = open ? "" : "none";
    });
    box.appendChild(head);
    box.appendChild(body);
    return box;
  }

  /**
   * 「回答为什么不完整」的提示条（工具预算用完 / max_tokens 截断）。
   *
   * 视觉必须是**警告**而不是**错误**：
   *   · 这两种情况都不是崩溃 —— 回答确实产出了，只是证据不足/被切断；
   *   · 画成红叉会让人以为整轮失败，于是去点「重试」（重试也解决不了
   *     「预算用完了」这件事，只有拆小问题才有用）。
   * 所以复用系统提示条的 warn 系配色（`--warn` / `--warn-soft`），
   * 并且**正文一起显示**（标题只说结论，用户需要的是「用了多少」和「下一步做什么」）。
   */
  function answerNoticeBlock(n: AnswerNotice): HTMLElement {
    const box = el("div", { class: "ai-notice" });
    box.dataset.aiNotice = n.kind;
    const head = el("header");
    head.appendChild(svg(I.warn, 13));
    head.appendChild(el("span", { class: "ai-notice-title" }, n.title));
    box.appendChild(head);
    box.appendChild(el("div", { class: "ai-notice-detail" }, n.detail));
    return box;
  }

  /**
   * 错误气泡（结构化）。
   *
   * 起因：用户截图里 400 的原始 JSON 原样挂在对话区，占一大块且完全看不懂，
   * 而真正有用的 `request_id` 反而藏在里面。
   *
   * 结构（三层，按"用户需要多少"排序）：
   *   1. **标题行**：人话结论 + 谁的问题（`⚠ 请求被服务端拒绝` / `API Key 无效`…）
   *   2. **建议行**：现在该做什么
   *   3. **技术详情**：默认折叠，展开后是原始错误 + 单独的 request_id（等宽、可复制）
   */
  function errorBubble(err: ErrorPresentation, raw: string | undefined, recoverable?: boolean): HTMLElement {
    const box = el("div", { class: "ai-error" });
    box.dataset.aiError = err.kind;

    const head = el("header");
    head.appendChild(svg(I.warn, 13));
    head.appendChild(el("span", { class: "ai-error-title" }, err.title));
    box.appendChild(head);

    if (err.hint) box.appendChild(el("div", { class: "ai-error-hint" }, err.hint));

    // 服务端给的原始消息（已从 JSON 抽出，不是整坨 JSON）—— 放正文位置，
    // 因为它通常就是一句人话（如 "The reasoning_content … must be passed back"）
    if (err.rawMessage) {
      box.appendChild(el("div", { class: "ai-error-msg" }, err.rawMessage));
    }

    // 技术详情：默认折叠（用户不查就不该看到 JSON）
    const details = el("details", { class: "ai-error-detail" });
    details.appendChild(el("summary", null, "技术详情"));
    const pre = el("pre", { class: "ai-error-pre mono" }, String(raw ?? err.rawMessage ?? ""));
    details.appendChild(pre);

    // request_id 单独一行、等宽、可复制 —— 贴给服务商排查时必须要有它，
    // 但不能让它占主体。
    if (err.requestId) {
      const ridRow = el("div", { class: "ai-error-rid" });
      ridRow.appendChild(el("span", { class: "ai-error-rid-label" }, "request_id"));
      const rid = el("code", { class: "ai-error-rid-value mono" }, err.requestId);
      rid.title = "点击复制";
      rid.style.cursor = "pointer";
      rid.addEventListener("click", () => {
        void navigator.clipboard?.writeText(err.requestId).then(
          () => info("request_id 已复制"),
          () => info(`复制失败，请手动选中：${err.requestId}`)
        );
      });
      ridRow.appendChild(rid);
      details.appendChild(ridRow);
    }
    box.appendChild(details);

    // 可重试才给按钮（客户端缺陷/Key 无效这类重试也没用）
    if (recoverable !== false && err.retryable) {
      const retryBtn = button("重试", () => retryLastUserMessage(), {
        size: "sm",
        variant: "ghost",
        iconPath: I.redo,
        title: "重发上一条消息"
      });
      retryBtn.dataset.aiRetry = "1";
      box.appendChild(retryBtn);
    }
    return box;
  }

  /**
   * 系统提示条（纯构造，不做 DOM 追加）。
   *
   * 用途：`done` 但正文为空 —— 「AI 什么都没说就停了」。沉默的失败比报错更让人困惑，
   * 所以必须明确告诉用户发生了什么、能做什么。
   *
   * @param retryLast 给了就渲染「重试」按钮（重发上一条用户消息）
   */
  function noteBlock(text: string, retryLast?: () => void): HTMLElement {
    const box = el("div", { class: "ai-note" });
    box.dataset.aiNote = "1";
    box.appendChild(svg(I.info, 13));
    box.appendChild(el("span", { class: "ai-note-text" }, text));
    if (retryLast) {
      box.appendChild(el("div", { class: "spacer" }));
      const btn = button("重试", retryLast, {
        size: "sm",
        variant: "ghost",
        iconPath: I.redo,
        title: "重发上一条消息"
      });
      btn.dataset.aiRetry = "1";
      box.appendChild(btn);
    }
    return box;
  }

  /** 把系统提示条追加到轨道末尾（一次性用途；要跨重绘留存请写 `turn.note`）。 */
  function appendSystemNote(text: string, retryLast?: () => void): void {
    const box = noteBlock(text, retryLast);
    // 走 markBlock + appendActNode：它属于「它做的事」那一档，
    // 且流式期间要排在还没说完的回答**之前**（见 appendActNode 的理由）。
    markBlock("note", box);
    appendActNode(box);
    thread.scrollTop = thread.scrollHeight;
    refreshAgentHead();
  }

  /**
   * 验收出口（`__BWE__.debugAiStream` 的面板侧实现）：灌 n 条假工具调用 + 一问一答。
   *
   * 为什么只拼 DOM 不发请求：这条出口唯一的用途是量「工具块一多会不会被压成一条缝」，
   * 而这个形状只由「块的数量 + 布局」决定。走真模型既要 key、又得等半分钟，
   * 还会污染真实对话，反而证明不了布局。
   *
   * ⚠ 面板已卸载（切到别的标签、AI 栏收起）时必须直接返回：
   *   往一个已经离树的 DOM 里灌 12 个块，然后验收量到 0 —— 是最难查的一类假失败。
   */
  function injectDemoTools(n: number): void {
    if (!wrap.isConnected) return;
    const count = Math.max(0, Math.min(200, Math.floor(n)));
    // 第一件事就登记「这一幕里有内容」：否则紧随其后的 syncPanelState 会按
    // turns 还是空把 is-idle 加回去、把 hero 塞回来，工具块被 CSS 一起隐藏。
    demoCount = Math.max(demoCount, 1);
    // ⚠ 顺序在 v3 里**变成有意义的**了：行为和消息同处一条轨道，
    //   所以必须照真实回合的先后铺 —— 先我问、再它调工具、最后它回答。
    //   （v2 两宿主时谁先谁后看不出来，照抄旧顺序会得到「工具在提问上方」的错序。）
    appendBlock("user", el("div", { class: "ai-msg user" }, "（演示）审一遍当前场景"));
    for (let i = 1; i <= count; i++) {
      appendToolBlock({
        name: "SceneDigest",
        detail: `演示调用 #${i}：32 行 / 1.2K 字符`,
        callId: `demo-${i}`,
        ms: 12,
        ok: true
      });
    }
    appendBlock(
      "assistant",
      el(
        "div",
        { class: "ai-msg assistant" },
        el("span", { class: "ai-text" }, `（演示）已跑完 ${count} 个工具调用，每块都该保持可读高度。`)
      )
    );
    // 单轨只有一个滚动容器：滚到底，验收要量的是「块都在、且都看得见」，
    // 卷在顶部会量到 0 高度（这是最早那轮假失败的直接原因）。
    thread.scrollTop = thread.scrollHeight;
    syncPanelState();
  }

  /** 重发上一条用户消息（用于「重试」按钮）。 */
  /**
   * 重发上一条用户消息。
   *
   * ⚠ **不能直接 `send()`**：`send()` 会 `turns.push(user)`，于是同一句用户消息
   * 在对话区出现**两次**（一次来自历史、一次来自重试）—— 用户截图里就是这个现象。
   *
   * 正确做法：**删掉失败的那一轮**（末尾的空/失败助手回合），
   * 然后重发 —— 复用已有的那条用户消息，不新增。
   * 判据：重试 N 次之后，同一条用户消息只出现 1 次。
   */
  function retryLastUserMessage(): void {
    if (currentRequest) return;   // 正在跑就别重复发

    // 从末尾往回吃掉"没有正文的助手回合"（失败/空的那些），保留用户消息
    while (turns.length > 0) {
      const last = turns[turns.length - 1];
      if (last.role !== "assistant") break;
      const hasText = String(last.text ?? "").trim().length > 0;
      // 有正文的助手回合不该被重试吞掉（那是有效回答）
      if (hasText) break;
      turns.pop();
    }
    if (!turns.length || turns[turns.length - 1].role !== "user") return;

    const text = turns[turns.length - 1].text;
    // 复用已有的那条 user：**先 pop 再从 send 里 push 回来**，
    // 这样 turns 里始终只有一份，不会累积重复。
    turns.pop();
    void send("chat", text);
  }

  /**
   * diff 预览卡。
   *
   * 行级逐行对比而不是 LCS diff：脚本改动通常集中在少数几行，行级对比已足够
   * 判断，而且实现简单到不会引入新 bug。
   * 关键：**这里只预览，不写回**；写回动作在「应用」按钮里。
   */
  function diffCard(edit: PendingEdit): HTMLElement {
    const card = el("div", { class: "card ai-diff" });
    const head = el("header");
    head.appendChild(el("span", null, `脚本改动预览 · ${edit.scriptName}`));
    head.appendChild(el("div", { class: "spacer" }));
    head.appendChild(button("应用", () => applyPendingEdit(), { size: "sm", variant: "primary", iconPath: I.check }));
    head.appendChild(
      button(
        "放弃",
        () => {
          pendingEdit = null;
          renderThread();
        },
        { size: "sm", variant: "ghost", iconPath: I.close }
      )
    );
    card.appendChild(head);

    const body = el("div", { class: "body" });
    const stats = diffStats(edit.before, edit.after);
    body.appendChild(el("div", { class: "hint" }, `+${stats.added} 行 / -${stats.removed} 行 · 应用后可 Ctrl+Z 撤销`));
    const pre = el("pre", { class: "ai-diff-pre" });
    pre.textContent = renderDiffText(edit.before, edit.after, 400);
    body.appendChild(pre);
    card.appendChild(body);
    return card;
  }

  // ---------------- 用量条 ----------------

  function updateMeter(): void {
    meter.replaceChildren();

    // 优先显示当前选中的模型 label（用户看的是名字，不是内部 id）
    const entry = modelsState ? modelsState.models.find((m) => m.id === modelsState!.active) : null;
    const modelLabel =
      currentModelLabel
      || (entry ? entry.label : "")
      || (lastModel === "pro" ? "pro" : lastModel === "flash" ? "flash" : status?.mode === "mock" || status === null ? "本地演示" : "未开始");
    // 用量条上的模型 chip 也常驻显示可用性：
    // 用户可能过一会儿才发下一条消息，那时才会真的失败；
    // 只在切换瞬间弹一次 toast，用户早就看不到原因了。
    // 用量条的模型 chip 走同一个语义单点（不许自己写一套判断 —— 上一轮三处各写
    // 一份，其中一处路径根本不走，"安静地不工作"最难发现）
    const cur = activeEntry();
    const curSt = modelStateOf(cur, cur === null);
    // 类型是 string（可能是 "warn" 这种非 AiModel 的修饰态）
    let meterCls: string = lastModel || curSt.cls;
    let meterText = modelLabel;
    if (cur && curSt.kind !== "configured") {
      meterCls = curSt.cls;
      meterText = `${modelLabel}（${curSt.short}）`;
    }
    const meterChip = el("span", { class: "model-chip " + meterCls }, meterText);
    if (cur) meterChip.title = `${cur.label}：${curSt.why}`;
    meter.appendChild(meterChip);
    meter.appendChild(el("span", { class: "k" }, routeReasonText()));

    // 还没有一轮对话时显示 "—"：写 0% 会让人以为"缓存完全没命中"，那是误导
    const hasRun = !!lastUsage;
    const hitPct = Math.round(lastCacheHit * 100);
    const cls = !hasRun ? "low" : hitPct >= 80 ? "high" : hitPct >= 40 ? "mid" : "low";
    meter.appendChild(el("span", { class: "cache-hit " + cls }, hasRun ? `缓存命中 ${hitPct}%` : "缓存命中 —"));

    // 三组 token 永远显示（哪怕是 0）：验收要看"省 token 可视"，
    // 一条会消失的用量条等于没有 —— 用户不知道该看哪里。
    const u = lastUsage;
    meter.appendChild(
      el(
        "span",
        {},
        `输入 ${u?.inputTokens ?? 0} · 命中 ${u?.cacheReadTokens ?? 0} · 输出 ${u?.outputTokens ?? 0}`
      )
    );
    if (lastSavedUsd > 0) {
      meter.appendChild(el("span", {}, `约省 $${lastSavedUsd.toFixed(4)}`));
    }

    const busy = !!currentRequest;
    // 思考中「发送」直接变成「停止」——而不是只把一个独立停止按钮显示出来。
    // 理由：用户此刻唯一想做的事就是停下，让主按钮变成那个动作最省心；
    // 原来的"发送禁用 + 旁边冒出个停止"要让眼睛先找一下。
    if (busy) {
      sendBtn.textContent = "停止";
      sendBtn.title = "结束这轮请求";
      sendBtn.disabled = false;
    } else {
      sendBtn.textContent = "发送";
      sendBtn.title = "";
      sendBtn.disabled = false;
    }
    stopBtn.style.display = "none";
    // 忙碌态 / 头部状态也一并同步：`currentRequest` 的每次变化都会走到用量条重画，
    // 把「谁决定面板状态」收在这条必经路径上，少一个分支就少一次漏改。
    syncPanelState();
  }

  /**
   * `usage.reason` → 人话。
   *
   * 为什么必须映射：`reason` 是主进程的机器可读标记（`no-usage` / `cache-hit` …），
   * 直接贴到界面上用户看不懂 —— 截图里就出现过「路由: no-usage」，
   * 用户的理解可能是"没用量？是不是没扣钱？还是统计坏了？"，三种都猜不出。
   *
   * 尤其 `no-usage` 必须解释清楚：它表示**这次调用没拿到 usage 数据**
   * （供应商/模型没返回用量字段），**不代表没有消耗 token**。
   * 不写这句，用户会以为"没花钱"或"统计坏了"。
   */
  const USAGE_REASON_CN: Record<string, string> = {
    "no-usage": "用量未统计（本次响应没有返回 usage 数据，不代表没有消耗）",
    "local-mock": "本地演示（零 token）",
    mock: "本地演示（零 token）",
    "cache-hit": "前缀缓存命中",
    cached: "前缀缓存命中"
  };

  function routeReasonText(): string {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant" && t.reason) {
        // 认识的标记翻成人话；不认识的原样显示（至少让用户知道这是个代号，
        // 而不是一句英文故障信息）
        const cn = USAGE_REASON_CN[t.reason];
        return cn ? `用量：${cn}` : `用量：${t.reason}`;
      }
    }
    if (!statusLoaded) return "用量：—";
    return status?.mode === "mock" ? "用量：本地演示（零 token）" : "用量：—";
  }

  // 把实现填进槽位：模块层的流式回调据此驱动本面板的 DOM
  hooks = {
    renderThread,
    appendDelta,
    appendToolBlock,
    updateMeter,
    renderThinking,
    appendSystemNote,
    retryLastUserMessage,
    injectDemoTools,
    runAction: (intent) => void send(intent),
    // page 布局才有的常驻历史：一轮结束按需局部刷新（dock 下 sessionSidebar 恒为 null）
    refreshSessions: () => {
      void sessionSidebar?.refresh();
    }
  };

  void refreshStatus(headBar, mockHint);
  renderThread();
  updateMeter();

  // 首次挂载且还没有任何对话时，主动播一条系统提示：
  // 用户（和验收截图）需要立刻看到"这个面板在工作、当前是哪种模式"，
  // 而不是一个空白区等别人输字。
  // 它是 system 类内容，按唯一规则进 `.ai-thread`（带 `.ai-act` 标记，画成日志行；
  // 不画成用户气泡 —— 那不是"我说的话"）。
  if (turns.length === 0 && !greeterShown) {
    greeterShown = true;
    appendBlock(
      "system",
      el(
        "div",
        { class: "ai-msg system" },
        "本地演示模式：没有检测到桌面端 AI 宿主或 API Key。\n"
        + "回答来自内置模板，能演示完整交互；接上桌面客户端并在「设置 → AI」填 DeepSeek API Key 后，"
        + "这里会变成真流式对话，底部条会显示真实缓存命中率与 token。"
      )
    );
    refreshAgentHead();
  }

  // 命令面板可能在面板还没打开时点了「AI：解释当前错误」，这里补发
  if (pendingAction) {
    const intent = pendingAction;
    pendingAction = null;
    window.setTimeout(() => void send(intent), 30);
  }
}

// ============================================================================
// 动作提示语与请求装配
// ============================================================================

/** 4 个按钮各自的默认提示语（输入框为空时用）。 */
function actionPrompt(intent: AiChatRequest["intent"]): string {
  switch (intent) {
    case "explain-error":
      return "解释当前脚本错误：这条错误是什么意思、为什么会发生、最小改动怎么修。请给出可直接替换的代码片段。";
    case "edit-script":
      return "改这段脚本：保持现有行为不变，只把明显的问题修好；输出完整的新版本，用 ```js 代码块包起来。";
    case "scene-review":
      return "审一遍当前场景：从碰撞、图层排序、脚本性能三个角度指出最值得改的 3 处，按影响排序。";
    default:
      return "";
  }
}

/**
 * 组装 messages。
 *
 * 只带最近几轮，且把旧回合压成一条摘要 —— 逐轮回放整段历史会让前缀长度
 * 随对话线性增长（token 成本跟着线性涨），压缩到一条既省钱又保持前缀稳定。
 */
function compactMessages(intent: AiChatRequest["intent"], text: string): AiChatRequest["messages"] {
  const out: AiChatRequest["messages"] = [];
  const recent = turns.slice(0, Math.max(0, turns.length - 2)).slice(-4);
  if (recent.length) {
    const digestText = recent
      .map((t) => `${t.role === "user" ? "用户" : "助手"}：${truncate(t.text, 240)}`)
      .join("\n");
    out.push({ role: "user", text: `上一轮对话摘要：\n${digestText}` });
  }
  out.push({ role: "user", text: intent === "chat" ? text : `${promptLabel(intent)}｜${text}` });
  return out;
}

function promptLabel(intent: AiChatRequest["intent"]): string {
  switch (intent) {
    case "explain-error": return "解释错误";
    case "edit-script": return "改脚本";
    case "scene-review": return "审场景";
    default: return "对话";
  }
}

/** 按 intent 裁剪上下文：只发与本次动作相关的部分，直接决定贵不贵。 */
function buildContext(intent: AiChatRequest["intent"]): AiChatRequest["context"] {
  const ctx: AiChatRequest["context"] = {};
  /**
   * 工程身份：**每一轮都带**，不受 intent 限制。
   *
   * 为什么必须每轮都带而不是只在某些意图下带：知识库在**每轮结束后**都要落盘，
   * 而落盘要按项目分片。少带一次 → 这一轮的沉淀不知道属于哪个工程
   * （只能落到"未知工程"里，等于这条记忆以后检索不到）。
   * 这是一个「漏一个分支就静默丢数据」的字段，所以放在最外层统一给。
   */
  const identity = store.projectIdentity();
  if (identity?.name) ctx.project = identity;
  if (intent === "scene-review" || intent === "chat" || intent === "edit-script") {
    ctx.sceneDigest = buildSceneDigest();
  }
  if (intent === "explain-error" || intent === "edit-script" || intent === "chat") {
    const d = diagnosticsContext();
    if (d) ctx.diagnostics = d;
    const s = activeScriptContext();
    if (s) ctx.activeScript = s;
  }
  if (intent === "scene-review") {
    ctx.selection = {
      count: store.selection.length,
      kinds: Array.from(new Set(store.selection.map((o) => o.kind)))
    };
  }
  return ctx;
}

function trimHistory(): void {
  if (turns.length <= HISTORY_MAX) return;
  turns = turns.slice(turns.length - HISTORY_MAX);
}

// ============================================================================
// 「改脚本」的落地：抽代码块 → diff → 用户点应用才写回
// ============================================================================

/**
 * 从助手回答里抽 ```js 代码块。
 *
 * 只取第一块：模型通常先解释再给代码，第一块往往就是完整新版本。
 * 没有代码块就不造 pendingEdit —— 面板不会凭空给一个 diff。
 * Yarn 剧本不自动改写：模型给的代码块多半是 JS，硬套到 Yarn 会把台词写坏。
 */
function extractCodeBlock(text: string): PendingEdit | null {
  if (!text) return null;
  const m = /```(?:js|javascript|ts|typescript|jsx)\s*\n([\s\S]*?)```/i.exec(text);
  if (!m) return null;
  const script = activeScriptContext();
  if (!script || script.lang !== "js") return null;
  const after = m[1].replace(/\s+$/g, "") + "\n";
  if (after.replace(/\r\n/g, "\n").trim() === script.code.replace(/\r\n/g, "\n").trim()) return null;
  return { scriptName: script.name, before: script.code, after };
}

/**
 * 外壳注入的「把源码写回剧本编辑器」能力。
 *
 * 为什么不让面板直接 import scriptPanel 的写函数：两者会形成双向依赖，
 * 且写回之后剧本面板要重画、工程要 markDirty、撤销要记一笔 —— 都是外壳职责。
 * 面板只负责告诉外壳：这段脚本该变成这样。
 */
let applyHook: ((name: string, code: string) => void) | null = null;

export function setAiScriptApplyHook(fn: (name: string, code: string) => void): void {
  applyHook = fn;
}

function applyPendingEdit(): void {
  const edit = pendingEdit;
  if (!edit) return;
  if (!applyHook) {
    info("当前环境没有接线，无法写回剧本面板");
    return;
  }
  applyHook(edit.scriptName, edit.after);
  pendingEdit = null;
  ok(`已应用 AI 改动到「${edit.scriptName}」（可 Ctrl+Z 撤销）`);
  requestRepaint();
}

// ============================================================================
// 简易行级 diff
// ============================================================================

function diffStats(before: string, after: string): { added: number; removed: number } {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  const max = Math.max(a.length, b.length);
  let added = 0;
  let removed = 0;
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (i < a.length && i < b.length) {
      removed++;
      added++;
    } else if (i < a.length) removed++;
    else added++;
  }
  return { added, removed };
}

/**
 * 渲染 diff 文本。
 *
 * 逐行对齐在插入/删除时会整体标红（不如下沉式 diff 精确），但面板只需要
 * 让人判断"改动是否合理"，+/- 前缀已经足够；好处是 O(n)、长脚本不卡。
 */
function renderDiffText(before: string, after: string, maxLines: number): string {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const la = a[i];
    const lb = b[i];
    if (la === lb) {
      out.push("  " + (la ?? ""));
    } else {
      if (la !== undefined) out.push("- " + la);
      if (lb !== undefined) out.push("+ " + lb);
    }
  }
  if (out.length > maxLines) {
    const rest = out.length - maxLines;
    return out.slice(0, maxLines).join("\n") + `\n…（还有 ${rest} 行改动未显示）`;
  }
  return out.join("\n");
}

// ============================================================================
// 外壳可调用的接口
// ============================================================================

/**
 * 从外壳触发一次 AI 动作（命令面板 / 活动栏按钮）。
 * 面板必须在挂载时才响应：没挂载时模块层也能发请求，但用户看不到结果，
 * 所以这里在没挂载时先记下"待发送"，挂载后立刻发一次。
 */
let pendingAction: AiChatRequest["intent"] | null = null;

/** 首屏那条"本地演示模式"提示只播一次（面板反复重渲染不该反复刷屏）。 */
let greeterShown = false;

/**
 * 验收演示灌进去的假块计数。
 *
 * 唯一作用是让面板知道「这一幕已经有内容了」：空闲态由 `turns.length` 决定，
 * 而 `debugAiStream` 按契约只改内存 DOM、不写 turns —— 不记这个计数，
 * 下一次状态同步就会按"还没有对话"把 `.is-idle` 加回去，把整条轨道连同刚灌进去的
 * 工具块一起隐藏（表现为「debugAiStream 之后量到 0 条」）。
 */
let demoCount = 0;

/**
 * 模型清单（来自 host 门面，网页版退化成 mock 两条）。
 *
 * 为什么缓存在模块级而不是每次渲染都拉：面板会因为数据变化反复重渲染，
 * 每渲染一次就打一次 IPC 既慢又没必要。切模型成功后再刷新这份缓存。
 */
let modelsState: AiModelsState | null = null;
/** 模型切换对话框是否打开（needsKey 的条目要填 key） */
let keyDialogFor: AiModelEntry | null = null;
/** Trae 导入结果预览（加载中 / 结果面板） */
let importPreview: { ok: boolean; providers: AiModelEntry[]; warnings: string[] } | null = null;
/** 导入弹窗是否打开 */
let modelDialogOpen = false;
/** 当前模型标签 */
let currentModelLabel = "";
/**
 * 顶部状态条的两个 DOM 句柄（**必须由 `renderAiPanel` 在挂载时赋值**）。
 *
 * 这里曾经只有一个 `mockHintEl` 且**从未被赋值**，于是「保存 key / 切模型 / 添加模型 /
 * 探测完成」四处刷新全成了死代码 —— 用户看到的现象是「配好 provider 后顶部模型条不变，
 * 必须切窗口或切标签才更新」（切标签会重挂面板，重挂才会重新拉状态）。
 * 所以句柄在这里集中声明、在挂载处集中赋值，刷新走 `refreshHeadNow()` 一处分发：
 * 四处相同的查找代码正是这个 bug 的成因，收敛成一个函数才不会再有第五处漏掉。
 *
 * 为什么不复用「`meterEl.closest(".ai-panel")` 现查」的写法：面板重挂后旧句柄会失效，
 * 而现查写法要求调用点自己记得先找到面板 —— 四个调用点、四份查找，漏一个就静默失效。
 * 现在挂载时赋值、重挂时覆盖，`refreshHeadNow()` 只在句柄还在文档里时才动手。
 */
let mockHintEl: HTMLElement | null = null;
/** 顶部状态条（`.ai-head`）自家句柄：模型 chip / 下拉 / 计数都画在它里面 */
let headBarEl: HTMLElement | null = null;
/** 「测试连接」结果区宿主（挂载时赋值） */
let probeHostEl: HTMLElement | null = null;

/** 探测进行中（防重复点击：超时类探测可能等几秒，用户会重复点） */
let probeBusy = false;

/** 最近一次探测状态：挂在模块级，面板重渲染后结果仍在 */
let lastProbe:
  | { entryId: string; label: string; state: "loading"; result?: undefined }
  | { entryId: string; label: string; state: "done"; result: ProbeResult }
  | null = null;

export function requestAiAction(intent: AiChatRequest["intent"]): void {
  if (hooks) {
    hooks.runAction(intent);
    return;
  }
  pendingAction = intent;
}

/** 命令面板「AI: 重置对话」。 */
export async function resetAiConversation(): Promise<void> {
  turns = [];
  pendingEdit = null;
  currentRequest = "";
  lastUsage = null;
  lastCacheHit = 0;
  lastSavedUsd = 0;
  lastModel = "";
  // 演示注入的假块也要一起清：重置对话之后回到空闲态才说得过去
  demoCount = 0;
  await aiReset();
  hooks?.renderThread();
  hooks?.updateMeter();
}

/** 状态栏要显示的 AI 摘要（模型 / 命中率 / token / 是否 mock）。 */
/**
 * 验收出口：把一份模型清单注入面板（只影响本次会话的内存，不写 settings）。
 *
 * 为什么需要：`--shot` 用隔离的临时 profile（正确设计 —— 验收不该污染用户真实配置），
 * 所以截图永远看不到"用户导入过模型之后"的界面。为了让 UI 的多模型渲染
 * （下拉选项、needsKey 标记、计数）能被截图自证，这里提供注入入口。
 * 注入的清单与门面返回的形状完全一致，渲染路径不变。
 */
export function injectModelsForDemo(state: AiModelsState): void {
  modelsState = state;
  currentModelLabel =
    state.models.find((m) => m.id === state.active)?.label || state.models[0]?.label || "";
  hooks?.updateMeter();
}

/** 造一份演示清单（含 ready / needsKey / 导入来源三种状态，覆盖所有渲染分支）。 */
export function demoModelsState(): AiModelsState {
  return {
    active: "preset:deepseek-chat",
    models: [
      {
        id: "preset:deepseek-chat",
        label: "DeepSeek 聊天",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        ready: true,
        needsKey: false,
        source: "preset",
        contextWindow: 65536
      },
      {
        id: "trae:siliconflow-moonshotai-kimi-k2-thinking",
        label: "moonshotai/Kimi-K2-Thinking",
        provider: "siliconflow",
        baseUrl: "https://api.siliconflow.cn/v1",
        model: "moonshotai/Kimi-K2-Thinking",
        ready: false,
        needsKey: true,
        source: "trae-import",
        contextWindow: 128000
      },
      {
        id: "trae:siliconflow-moonshotai-kimi-k2-thinking-turbo",
        label: "moonshotai/Kimi-K2-Thinking-Turbo",
        provider: "siliconflow",
        baseUrl: "https://api.siliconflow.cn/v1",
        model: "moonshotai/Kimi-K2-Thinking-Turbo",
        ready: false,
        needsKey: true,
        source: "trae-import",
        contextWindow: 128000
      },
      {
        id: "manual:local-ollama",
        label: "本地 Ollama（自定义）",
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen2.5",
        ready: false,
        needsKey: false,
        source: "manual"
      }
    ]
  };
}

/**
 * 验收/排查出口：面板当前持有的模型清单与门面原始返回。
 * 为什么需要：截图只能看到下拉里被选中的那一项，看不到"清单其实有几条"；
 * 排查"为什么 UI 是 mock 而主进程说有 5 条"时必须能一次看到两侧的原始数据。
 */
/**
 * 验收出口：冻结思考态到某个 phase 并重画（仅用于截图，不发请求）。
 * phase 支持 connecting / reasoning / answering / slow。
 */
export function demoThinking(phase: "connecting" | "reasoning" | "answering" | "slow", chars = 0): void {
  freezeThinkingForDemo(phase, chars);
  hooks?.renderThinking?.();
}

/**
 * 验收出口：往当前面板灌 n 条假工具调用 + 一问一答（`__BWE__.debugAiStream(n)` 的落点）。
 *
 * 为什么走面板内部实现（`hooks.injectDemoTools`）而不是在这里自己拼 DOM：
 * 工具块的外观只有 `toolBlock()` 一份实现，而验收要量的正是**那份实现**在块多时的几何。
 * 另拼一套看着像、但高度/内边距不同的块，测出来的结论对真实界面无效 —— 那是拿替身做验收。
 *
 * 面板没挂载（AI 栏收起 / 切到知识库标签）时安全返回：不抛错、不往离树的 DOM 里写。
 */
export function injectDemoToolCalls(n: number): void {
  hooks?.injectDemoTools?.(n);
}

/**
 * 验收出口：构造「工具失败 + 空答复」的一轮（仅截图用，**不发真实请求**）。
 *
 * 为什么必须走事件路径而不是直接拼 DOM：
 *   直接拼 DOM 只能证明"样式能画出来"，走 `handleAiEvent` 才能证明
 *   "UI 收到 tool(failed) / done(空文本) 事件后确实这样显示"。
 * 为什么需要它：mock 流不产生 tool 事件，真模型需要 key，
 *   而"失败工具块"和"空答复提示"这两个视觉必须有图自证。
 */
export function demoToolFailure(): void {
  const rid = "__demo_tool_fail__";
  const liveTurnExists = turns.length > 0 && turns[turns.length - 1].role === "assistant";
  if (!liveTurnExists) {
    turns.push({ role: "user", text: "审一遍当前场景", tools: [], streaming: false });
    turns.push({ role: "assistant", text: "", tools: [], streaming: true });
  }
  currentRequest = rid;

  // 两次同名工具调用（正是用户遇到的场景：两个 SceneDigest）
  const calls = [
    { callId: "demo-call-1", ms: 812, error: "工具 SceneDigest 执行失败：主进程未注入工程摘要（sceneDigest 不在工具上下文里）" },
    { callId: "demo-call-2", ms: 1234, error: "工具 SceneDigest 执行失败：同上，重试路径仍然拿不到 context.sceneDigest" }
  ];
  for (const c of calls) {
    handleAiEvent({
      type: "tool",
      requestId: rid,
      name: "SceneDigest",
      detail: "调用 SceneDigest(mapSize=64x64)",
      phase: "start",
      callId: c.callId
    } as AiEvent);
    handleAiEvent({
      type: "tool",
      requestId: rid,
      name: "SceneDigest",
      detail: "SceneDigest 32 行 / 1.2K 字符 · 已剪枝 → toolCache/9f3a1b2c…",
      phase: "end",
      callId: c.callId,
      ok: false,
      error: c.error,
      ms: c.ms
    } as AiEvent);
  }
  // 模型说了半句就没了 + done 无正文 → 系统提示
  handleAiEvent({ type: "delta", requestId: rid, text: "工具调用失败了，我换个路径再试一次…" } as AiEvent);
  handleAiEvent({
    type: "usage",
    requestId: rid,
    usage: {
      inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
      reason: "no-usage"
    }
  } as AiEvent);
  handleAiEvent({
    type: "done",
    requestId: rid,
    text: "",
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reason: "no-usage" },
    cacheHitRate: 0,
    savedUsdApprox: 0
  } as AiEvent);
}

/**
 * 验收出口：构造一条 400 错误（用户实际遇到的 kimi `reasoning_content` 那条）。
 *
 * 走 `handleAiEvent` 的真实渲染路径，证明"UI 收到 error 事件后会这样显示"，
 * 而不是"样式能画出来"。
 */
export function demoServerError(raw?: string): void {
  const rid = "__demo_error__";
  const text = raw
    ?? '400 {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API.","type":"invalid_request_error","code":"invalid_request_error"},"request_id":"req_9f2c7a1b4e6d8850"}';
  turns.push({ role: "user", text: "把这个场景的性能问题找出来", tools: [], streaming: false });
  turns.push({ role: "assistant", text: "", tools: [], streaming: true });
  currentRequest = rid;
  handleAiEvent({ type: "error", requestId: rid, message: text, recoverable: true } as AiEvent);
}

/**
 * 验收出口：构造「Key 填过但本次启动解不开」的模型状态。
 *
 * 为什么需要：这是用户实际踩的坑 ——
 * 他真填了 key（`encryptedApiKey` 有内容），但重启后 Electron 安全存储解不开，
 * 请求带空 key → 400/401 → 「跑了两下就寄」。
 * UI 若显示成「待填 key」，用户会以为是自己忘了填，反复折腾。
 *
 * 这里通过 `__BWE__.demoKeyBroken()` 注入一条带 `keyUndecryptable` 的模型，
 * 走**真实的状态判定 + chip 渲染**（不是直接拼 DOM），证明"UI 会这样显示"。
 */
/**
 * 验收出口：构造「key 以明文保存」（insecure:true）的状态。
 *
 * 为什么需要：`insecure` 只在系统加密存储不可用时出现，
 * 普通环境复现不了；而这是**安全告知**，必须有图自证它会显示、且可关闭。
 */
/**
 * 重挂当前面板，**沿用当前布局**。
 *
 * 为什么 demo 出口不能直接 `renderAiPanel(host, ...)`：缺省布局是 dock，
 * 于是在 AI 界面（page）里点一个 demo 触发器，历史栏会静默消失、面板变回单列 ——
 * 演示脚本看到的几何就不再是用户看到的那一份。
 */
function rerenderPanelKeepLayout(): void {
  const cur = document.querySelector(".ai-panel") as HTMLElement | null;
  const host = cur?.parentElement as HTMLElement | null;
  if (!host) return;
  const layout: AiPanelLayout = cur?.dataset.aiLayout === "page" ? "page" : "dock";
  renderAiPanel(host, requestRepaint, { layout });
}

/**
 * 验收出口：「明文降级」文案（key 曾经加密、因解不开才降级成明文）。
 *
 * 与 `demoInsecure` 的差别只在**措辞**：
 *   · insecure → 「当前 API Key 以明文保存」
 *   · + keyPlaintextFallback → 「你之前保存的 API Key 无法解密，已以明文保存」
 * 为什么必须区分：前者让用户想「我这台机器是不是有问题」，
 * 后者让他知道「我的 key 出事过，但现在已经能用」。判断和后续动作不同。
 */
export function demoPlaintextFallback(): void {
  status = {
    provider: "openai-compatible",
    ready: true,
    mode: "desktop",
    models: { flash: "deepseek-flash", pro: "deepseek-flash" },
    insecure: true,
    keyPlaintextFallback: true
  } as AiStatus;
  statusLoaded = true;
  statusPinnedForDemo = true;
  sessionStorage.removeItem("bwe.ai.insecureDismissed");
  rerenderPanelKeepLayout();
  console.log("[demo] 已注入明文降级状态");
}

export function demoInsecure(): void {
  status = {
    provider: "openai-compatible",
    ready: true,
    mode: "desktop",
    models: { flash: "deepseek-flash", pro: "deepseek-flash" },
    // ★ 关键：明文存储标记（AiStatus.insecure 尚未并入 host.ts 类型）
    insecure: true
  } as unknown as AiStatus;
  statusLoaded = true;
  statusPinnedForDemo = true;
  // 清掉"已关闭"标记，保证截图时能看到提示条
  sessionStorage.removeItem("bwe.ai.insecureDismissed");
  rerenderPanelKeepLayout();
  console.log("[demo] 已注入明文存储状态");
}

export function demoKeyBroken(): void {
  // 直接走现成的 `injectModelsForDemo`（模块内函数），而不是 `__BWE__.demoModels`
  // —— 后者是无参的、固定那份演示清单，传不进去自定义状态。
  // 必须同时把 status 伪造成「desktop 宿主在、但整体未就绪」——
  // 否则真实 mock 状态下 chip 会走「本地演示」分支，看不到 key-broken。
  // 这正是用户真实处境的形状：宿主在、模型配了、但 key 解不开。
  status = {
    provider: "openai-compatible",
    ready: false,
    mode: "desktop",
    message: "当前模型不可用（详见面板状态）",
    models: { flash: "kimi-k3", pro: "deepseek-flash" },
    // 批量提示条用（主进程算好的数量，UI 不自己数）
    keyUndecryptableCount: 1
  } as unknown as AiStatus;
  statusLoaded = true;
  statusPinnedForDemo = true;

  injectModelsForDemo({
    models: [
      {
        id: "kimi-k3",
        label: "kimi-k3",
        provider: "openai-compatible",
        baseUrl: "https://api.moonshot.cn/v1",
        model: "kimi-k3",
        ready: false,
        // ★ 关键：填过（有加密内容）但本次启动解不开
        keyUndecryptable: true,
        hasApiKey: false,
        needsKey: true,
        needsKeyMissing: true,
        reason: "API Key 无法解密（本次启动安全存储不可用）",
        source: "manual"
      } as unknown as AiModelEntry,
      {
        id: "deepseek-flash",
        label: "deepseek-flash",
        provider: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        ready: true,
        hasApiKey: true,
        needsKey: false,
        needsKeyMissing: false,
        source: "manual"
      } as unknown as AiModelEntry
    ],
    active: "kimi-k3"
  } as unknown as AiModelsState);
  // 顶部条要重画才能反映新状态（demo 是在面板已渲染后点触发的）。
  // 用已有的重画出口：`refreshStatus` 是闭包内的，靠 hooks 通知不到，
  // 所以直接重建整个面板（demo 场景下代价可以忽略）。
  rerenderPanelKeepLayout();
  console.log("[demo] 已注入 Key 失效模型");
}

/** 验收出口：连点两次「重试」，验证同一条用户消息仍只出现一次。 */
export function demoRetryTwice(raw?: string): void {
  const rid = "__demo_retry__";
  const text = raw
    ?? '400 {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API.","type":"invalid_request_error"}}';
  turns.length = 0;   // 从干净状态开始，证据才清楚
  turns.push({ role: "user", text: "把这个场景的性能问题找出来", tools: [], streaming: false });
  turns.push({ role: "assistant", text: "", tools: [], streaming: true });
  currentRequest = rid;
  handleAiEvent({ type: "error", requestId: rid, message: text, recoverable: true } as AiEvent);
  // 模拟用户点两次「重试」（每次都是失败），断言用户消息不累积
  for (let i = 0; i < 2; i++) {
    currentRequest = "";
    hooks?.retryLastUserMessage();
    currentRequest = `${rid}_${i}`;
    handleAiEvent({ type: "error", requestId: currentRequest, message: text, recoverable: true } as AiEvent);
  }
  currentRequest = "";
  console.log("[demo] retry 后 turns 里的 user 条数:", turns.filter((t) => t.role === "user").length);
}

/** 验收出口：只截「done 但正文为空」的系统提示（不含工具块）。 */
export function demoEmptyDone(): void {
  const rid = "__demo_empty_done__";
  turns.push({ role: "user", text: "把这个场景的性能问题找出来", tools: [], streaming: false });
  turns.push({ role: "assistant", text: "", tools: [], streaming: true });
  currentRequest = rid;
  handleAiEvent({
    type: "done",
    requestId: rid,
    text: "",
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reason: "no-usage" },
    cacheHitRate: 0,
    savedUsdApprox: 0
  } as AiEvent);
}

/**
 * 验收出口：构造「回答不完整」的一轮 —— 工具预算耗尽 / max_tokens 截断。
 *
 * 为什么必须走 `handleAiEvent` 而不是直接拼 DOM：
 *   直接拼 DOM 只能证明"样式画得出来"；走真实事件路径才能证明
 *   「主进程发来 `done.extra` 后，UI 确实把这条解释挂在**这一轮**助手消息下方」。
 *   用户报的「跑两下就寄了、没交付任何东西」看的正是这个位置。
 *
 * @param kind budget = 只预算耗尽；truncated = 只截断；both = 两者（顺序必须是截断在前）
 * @param withText 附带一段正文，证明提示条在正文**下方**而不是替换正文
 */
export function demoAnswerNotices(kind: "budget" | "truncated" | "both" = "both", withText = true): void {
  const rid = `__demo_notice_${kind}__`;
  turns.length = 0;   // 从干净状态开始，证据才清楚
  turns.push({ role: "user", text: "审一遍当前场景，把能修的都修掉", tools: [], streaming: false });
  turns.push({ role: "assistant", text: "", tools: [], streaming: true });
  currentRequest = rid;
  const body = withText
    ? "场景里有两处图层排序问题，我先把结论列出来：1) HUD 图的 z 值低于背景，会被盖住；2) 碰撞体比可见图片大一圈。"
    : "";
  if (body) handleAiEvent({ type: "delta", requestId: rid, text: body } as AiEvent);
  const extra: Record<string, unknown> = {};
  if (kind === "budget" || kind === "both") {
    extra.toolBudget = {
      roundsUsed: 8,
      roundsMax: 8,
      callsUsed: 12,
      callsMax: 12,
      budgetExhausted: true,
      elapsedMs: 41500
    };
  }
  if (kind === "truncated" || kind === "both") {
    extra.truncated = true;
    extra.autoContinued = 2;   // 与主进程真实语义一致：续写 2 次仍被截断
  }
  handleAiEvent({
    type: "done",
    requestId: rid,
    text: body,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reason: "no-usage" },
    cacheHitRate: 0,
    savedUsdApprox: 0,
    extra
  } as unknown as AiEvent);
}


export function aiPanelDebugModels(): { state: AiModelsState | null; hostMode: string; hasHost: boolean } {
  const w = window as unknown as { bweHost?: { mode?: string } };
  return {
    state: modelsState,
    hostMode: w.bweHost?.mode ?? "(无 bweHost)",
    hasHost: !!w.bweHost
  };
}

export function aiPanelSummary(): { model: AiModel | ""; cacheHitRate: number; usage: TokenUsage | null; mock: boolean } {
  return {
    model: lastModel,
    cacheHitRate: lastCacheHit,
    usage: lastUsage,
    mock: status ? status.mode === "mock" || !status.ready : true
  };
}
