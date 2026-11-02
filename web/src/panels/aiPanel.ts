/**
 * AI 助手面板。
 *
 * 纪律（对应 docs/desktop-migration.md §3 / §4）：
 *   1. **只经 core/host.ts 的 AI 门面调用**，从不直接碰 window.bweHost。
 *      网页版 / 无 key / 桌面版三种状态在面板看来是同一件事，只是
 *      aiStatus().mode 不同 —— 面板不需要为"有没有宿主"写分支。
 *   2. **绝不把整个 .bwproj 塞进请求**：上下文只带 sceneDigest（压缩后的几行
 *      文字）+ 诊断摘要 + 当前脚本片段（超过 200 行截断）。
 *   3. **改脚本必须用户确认**：AI 返回的代码只进 diff 预览，点「应用」才写回。
 *      自动写回等于把用户源码交给一个撤销不到的黑箱。
 *   4. 无 key / mock 模式面板照样能用：顶部一条提示语，mock 流在回答里
 *      明说"这是本地演示"，用户不会误以为调通了模型。
 */

import { el, button, svg } from "../core/dom.ts";
import { I } from "../ui/icons.ts";
import { store } from "../core/store.ts";
import { isUiScene, scriptLang, scriptNamesOfLang, type Project, type SceneModel } from "../core/model.ts";
import { allProblems } from "../core/diagnostics.ts";
import { appendOutput } from "../core/output.ts";
import { modelStateOf, modelStateSuffix, isNeedsKey, countNeedsKey, canUseNow, probeModelOf, type ProbeResult } from "./aiModelState.ts";
import { beginThinking, applyThinkingEvent, endThinking, currentThinking, thinkingText, thinkingNeedsStop, freezeThinkingForDemo } from "./aiThinking.ts";
import {
  aiStatus,
  aiChat,
  aiCancel,
  aiReset,
  aiModels,
  aiSetModel,
  aiAddModel,
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
import { error, info, modal, ok, warn } from "../ui/toast.ts";
import { renderSessionSwitcher } from "./aiSessions.ts";

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
  /** 外壳/命令面板触发一次动作（相当于点了某个按钮） */
  runAction(intent: AiChatRequest["intent"]): void;
  /** 重画「正在思考」提示（phase 变化时调用） */
  renderThinking(): void;
  /** 在对话区插一条系统提示（done 无正文 / error 可重试时用） */
  appendSystemNote(text: string, retryLast?: () => void): void;
  /** 重发上一条用户消息（「重试」按钮） */
  retryLastUserMessage(): void;
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
      if (live) {
        live.text = ev.text || live.text;
        live.streaming = false;
      }
      lastUsage = ev.usage;
      lastCacheHit = ev.cacheHitRate;
      lastSavedUsd = ev.savedUsdApprox;
      currentRequest = "";
      endThinking();
      pendingEdit = extractCodeBlock(ev.text);
      hooks?.renderThread();
      // **正文为空 = 这轮什么都没产出**（典型：模型连续调坏工具直到轮次耗尽）。
      // 用户此刻的处境是「AI 说了半句、没了、也没有任何解释」——
      // 沉默的失败比报错更让人困惑，必须明确说明 + 给出口（重试）。
      const produced = (String(ev.text ?? "") + String(live?.text ?? "")).trim();
      if (!produced) {
        hooks?.appendSystemNote(
          "这轮没有产出答复（可能工具连续失败，或模型轮次耗尽）。可以重试，或换个问法。",
          () => hooks?.retryLastUserMessage()
        );
      }
      hooks?.renderThinking?.();
      hooks?.updateMeter();
      return;
    }
    case "error": {
      if (live) {
        live.streaming = false;
        live.text = live.text ? `${live.text}\n\n（中断：${ev.message}）` : `（失败：${ev.message}）`;
      }
      currentRequest = "";
      endThinking();
      hooks?.renderThread();
      // recoverable=true 表示"再试一次可能成功"（网络抖动 / 限流等）。
      // 给明确的重试入口，而不是让用户自己琢磨要不要再点一次。
      if (ev.recoverable) {
        hooks?.appendSystemNote(`这次调用失败：${ev.message}。这个问题可能可以重试解决。`, () =>
          hooks?.retryLastUserMessage()
        );
      }
      hooks?.renderThinking?.();
      hooks?.updateMeter();
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

/**
 * 渲染 AI 面板。
 * @param host 挂载点
 * @param onRepaint 外壳注入的重画请求（diff 应用后刷新剧本面板）
 */
export function renderAiPanel(host: HTMLElement, onRepaint?: () => void): void {
  requestRepaint = onRepaint ?? (() => {});
  ensureEventSubscription();

  host.replaceChildren();
  const wrap = el("div", { class: "ai-panel" });

  // ---- 顶部状态条：模式徽标 + mock 提示 ----
  const headBar = el("div", { class: "row tight ai-head" });
  headBar.style.padding = "8px 12px 0";
  wrap.appendChild(headBar);

  const mockHint = el("div", { class: "hint ai-mock-hint" });
  mockHint.style.padding = "6px 12px 0";
  mockHint.style.display = "none";
  wrap.appendChild(mockHint);

  // 「测试连接」结果区宿主：常驻但默认空，探测后才有内容。
  // 必须在 thread 之前创建并赋值，否则 renderProbeArea 拿不到它（早前漏了赋值，
  // 结果区一条都不显示 —— 又一次"看起来实现了、实际不工作"）。
  probeHostEl = el("div", { class: "ai-probe-host" });
  wrap.appendChild(probeHostEl);

  const thread = el("div", { class: "ai-thread" });
  wrap.appendChild(thread);

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
      title: "AI 返回的代码只做 diff 预览，点「应用」才写回编辑器"
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

  wrap.appendChild(compose);
  host.appendChild(wrap);

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

  async function refreshStatus(bar: HTMLElement, hintBox: HTMLElement): Promise<void> {
    bar.replaceChildren();
    try {
      status = await aiStatus();
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

    const mock = status.mode === "mock" || !status.ready;

    // 模型清单必须先加载：下面要根据当前条目的 ready/needsKeyMissing 决定 chip 文案。
    // （早前是先画 chip 后 loadModels，导致 activeEntry() 恒为 null，chip 永远显示默认"已连接"）
    await loadModels();

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
    bar.appendChild(stateChip);
    bar.appendChild(el("div", { class: "spacer" }));

    if (mock) {
      hintBox.textContent = status.message || "没有可用的 AI 宿主，当前是本地演示模式。";
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

    updateMeter();
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
    const head = meterEl?.closest(".ai-panel")?.querySelector(".ai-head");
    if (head && mockHintEl) void refreshStatus(head as HTMLElement, mockHintEl);
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
    const host = probeHostEl;
    if (!host) return;
    const st = currentThinking();
    // 先把旧的思考提示摘掉，再决定要不要画新的（避免重复堆叠）
    const old = host.querySelector(".ai-thinking");
    old?.remove();
    if (!st) return;

    const box = el("div", { class: "ai-thinking" });
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

    host.appendChild(box);
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

    // 模型计数：原生 select 折叠时只显示当前项，用户看不到"还有几个可选"。
    // 这行小字同时解决了产品上的信息缺失与验收截图的自证需求。
    const needsKey = countNeedsKey(models);
    const countText = models.length
      ? `共 ${models.length} 个模型${needsKey ? `（${needsKey} 个待填 key）` : ""}`
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
    updateMeter();
    // 顶部条重画（下拉里的选中项、needsKey 标记都可能变）
    const head = meterEl?.closest(".ai-panel")?.querySelector(".ai-head");
    if (head && mockHintEl) void refreshStatus(head as HTMLElement, mockHintEl);
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
            + "它还没有 API Key，所以现在发不出请求。填好保存后即可使用。\n"
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
              const head = meterEl?.closest(".ai-panel")?.querySelector(".ai-head");
              if (head && mockHintEl) void refreshStatus(head as HTMLElement, mockHintEl);
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


  // ---------------- 手动添加模型（用户明确要求「自己填 key」的完整入口） ----------------

  /**
   * 打开「添加模型」对话框。
   *
   * 为什么需要它（而不是只靠下拉里选 needsKey 项弹 key 输入框）：
   *   下拉那条路径只能给**已有的**条目补 key。用户要的第二种情况是
   *   「Trae 里根本没有的模型」—— 比如 DeepSeek 官方、自己的反代、本地 Ollama。
   *   这些必须能手动录入 provider / baseUrl / model / key。
   *
   * 判重由主进程负责（同 provider+baseUrl+model = 同一条，就地更新并保留原 id），
   * 所以这里不需要在前端做去重判断 —— 重复提交会变成"更新"，不会产生第二条。
   */
  function openAddModelDialog(): void {
    // provider 预设：常见几家的 baseUrl 自动填，减少用户手打出错
    const PRESET_URL: Record<string, string> = {
      deepseek: "https://api.deepseek.com",
      siliconflow: "https://api.siliconflow.cn/v1",
      "openai-compatible": "http://127.0.0.1:11434/v1"
    };

    modal({
      title: "添加模型",
      wide: true,
      body: () => {
        const col = el("div", { class: "col" });

        col.appendChild(
          el(
            "div",
            { class: "hint" },
            "填一个 Trae 里没有的模型（DeepSeek 官方 / 自建反代 / 本地 Ollama 等）。\n"
            + "同一个「供应商 + 地址 + 模型名」会被视为同一条：重复提交是更新，不会多出一条。"
          )
        );

        const form = el("div", { class: "ai-add-form" });

        // 供应商
        form.appendChild(el("div", { class: "group-label" }, "供应商 Provider"));
        const provSel = el("select", { class: "select", "data-ai-add-provider": "1" });
        for (const p of ["deepseek", "siliconflow", "openai-compatible", "mock"]) {
          provSel.appendChild(el("option", { value: p }, p));
        }
        form.appendChild(provSel);

        // 服务地址
        form.appendChild(el("div", { class: "group-label" }, "服务地址 Base URL"));
        const urlInput = el("input", {
          class: "input",
          type: "text",
          placeholder: "https://api.deepseek.com",
          "data-ai-add-baseurl": "1"
        });
        urlInput.value = PRESET_URL["deepseek"] ?? "";
        form.appendChild(urlInput);

        // 模型名（必填）
        form.appendChild(el("div", { class: "group-label" }, "模型名 Model（必填）"));
        const modelInput = el("input", {
          class: "input",
          type: "text",
          placeholder: "例如 deepseek-chat / moonshotai/Kimi-K2-Thinking",
          "data-ai-add-model-name": "1"
        });
        form.appendChild(modelInput);

        // 显示名
        form.appendChild(el("div", { class: "group-label" }, "显示名 Label（选填，留空用模型名）"));
        const labelInput = el("input", {
          class: "input",
          type: "text",
          placeholder: "例如 DeepSeek 聊天",
          "data-ai-add-label": "1"
        });
        form.appendChild(labelInput);

        // Key
        form.appendChild(el("div", { class: "group-label" }, "API Key（可留空，之后再填）"));
        const keyInput = el("input", {
          class: "input",
          type: "password",
          placeholder: "粘贴 API Key（不会明文显示；留空表示稍后填写）",
          autocomplete: "off",
          spellcheck: "false",
          "data-ai-add-key": "1"
        });
        form.appendChild(keyInput);
        form.appendChild(
          el("div", { class: "hint" }, "留空也能先创建，之后在下拉里选中它会提示「需要填 API Key」。")
        );

        // 上下文窗口（选填）
        form.appendChild(el("div", { class: "group-label" }, "上下文窗口 tokens（选填）"));
        const ctxInput = el("input", {
          class: "input",
          type: "number",
          placeholder: "例如 65536",
          "data-ai-add-context": "1"
        });
        form.appendChild(ctxInput);

        col.appendChild(form);

        // 切供应商时自动填地址（用户改过就不再覆盖）
        let urlTouched = false;
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
          label: "添加并切换",
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
            void addModelViaHost({
              provider,
              baseUrl,
              model,
              label,
              apiKey,
              contextWindow: ctxRaw ? Number(ctxRaw) : undefined
            });
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
   */
  async function addModelViaHost(input: AiModelInput): Promise<void> {
    try {
      const r = await aiAddModel(input);
      modelsState = r;
      const refreshed = await loadModels();
      const head = meterEl?.closest(".ai-panel")?.querySelector(".ai-head");
      if (head && mockHintEl) void refreshStatus(head as HTMLElement, mockHintEl);
      const entry = refreshed ? refreshed.models.find((m) => m.id === refreshed.active) : null;
      currentModelLabel = entry?.label ?? input.label ?? input.model;

      const scoped = r as AiModelsState & { created?: boolean; updated?: boolean; warning?: string };
      if (scoped.created === false && scoped.updated === true) {
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
      appendOutput("AI", `手动添加模型：${input.provider} / ${input.model}`);
      renderThread();
      updateMeter();
    } catch (e) {
      warn(`添加模型失败：${(e as Error).message}`);
    }
  }

  // ---------------- 内部渲染 ----------------


  function renderThread(): void {
    thread.replaceChildren();

    if (!turns.length) {
      thread.appendChild(
        el(
          "div",
          { class: "ai-msg system" },
          "AI 助手：读工程摘要、读脚本诊断、给修复建议。\n"
          + "下面 4 个按钮不会自动改动你的工程 —— 改脚本也要你点「应用」才写回。"
        )
      );
    }

    for (const t of turns) {
      if (t.role === "user") {
        thread.appendChild(el("div", { class: "ai-msg user" }, t.text));
        continue;
      }
      const bubble = el("div", { class: "ai-msg assistant" });
      bubble.appendChild(el("span", { class: "ai-text" }, t.text));
      if (t.streaming) bubble.appendChild(el("span", { class: "ai-cursor" }));
      thread.appendChild(bubble);
      for (const tool of t.tools) thread.appendChild(toolBlock(tool));
    }

    // diff 预览追加在对话之后，跟随最新一次编辑
    if (pendingEdit) thread.appendChild(diffCard(pendingEdit));

    const last = liveAssistantTurn();
    if (last && last.streaming) thread.scrollTop = thread.scrollHeight;
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
    const existing = thread.querySelector(`[data-ai-tool-key="${CSS.escape(key)}"]`) as HTMLElement | null;
    if (existing) {
      // 原地替换成最新状态（保留展开状态由新块自己决定：失败默认展开）
      const wasOpen = (existing.querySelector(".body") as HTMLElement | null)?.style.display !== "none";
      const fresh = toolBlock(tool);
      fresh.dataset.aiToolKey = key;
      if (wasOpen) (fresh.querySelector(".body") as HTMLElement | null)!.style.display = "";
      existing.replaceWith(fresh);
    } else {
      const blk = toolBlock(tool);
      blk.dataset.aiToolKey = key;
      thread.appendChild(blk);
    }
    thread.scrollTop = thread.scrollHeight;
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
   * 在对话区插一条系统提示。
   *
   * 用途：`done` 但正文为空 / 出错可重试 —— 这两种都是**"AI 什么都没说就停了"**
   * 的场景。沉默的失败比报错更让人困惑，所以必须明确告诉用户发生了什么、能做什么。
   *
   * @param retryLast 给了就渲染「重试」按钮（重发上一条用户消息）
   */
  function appendSystemNote(text: string, retryLast?: () => void): void {
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
    // 插到最后一个助手回合之后（没有助手回合就追加到末尾）
    thread.appendChild(box);
    thread.scrollTop = thread.scrollHeight;
  }

  /** 重发上一条用户消息（用于「重试」按钮）。 */
  function retryLastUserMessage(): void {
    if (currentRequest) return;   // 正在跑就别重复发
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "user") {
        void send("chat", t.text);
        return;
      }
    }
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
    runAction: (intent) => void send(intent)
  };

  void refreshStatus(headBar, mockHint);
  renderThread();
  updateMeter();

  // 首次挂载且还没有任何对话时，主动播一条系统提示：
  // 用户（和验收截图）需要立刻看到"这个面板在工作、当前是哪种模式"，
  // 而不是一个空白区等别人输字。
  if (turns.length === 0 && !greeterShown) {
    greeterShown = true;
    thread.appendChild(
      el(
        "div",
        { class: "ai-msg system" },
        "本地演示模式：没有检测到桌面端 AI 宿主或 API Key。\n"
        + "回答来自内置模板，能演示完整交互；接上桌面客户端并在「设置 → AI」填 DeepSeek API Key 后，"
        + "这里会变成真流式对话，底部条会显示真实缓存命中率与 token。"
      )
    );
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
/** 当前模型的显示名（用量条用 label 而不是 id） */
let currentModelLabel = "";
/** 顶部 mock 提示元素引用（模型切换后重画状态条要用） */
let mockHintEl: HTMLElement | null = null;
/** 用量条 DOM（模块层回调要用） */
let meterEl: HTMLElement | null = null;
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
