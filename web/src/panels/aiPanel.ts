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
import {
  aiStatus,
  aiChat,
  aiCancel,
  aiReset,
  onAiEvent,
  type AiEvent,
  type AiStatus,
  type AiChatRequest,
  type AiModel,
  type TokenUsage
} from "../core/host.ts";
import { info, ok } from "../ui/toast.ts";

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
}
let hooks: PanelHooks | null = null;

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
    case "delta": {
      if (live) {
        live.streaming = true;
        live.text += ev.text;
        hooks?.appendDelta(live.text);
      }
      return;
    }
    case "tool": {
      if (live) live.tools.push({ name: ev.name, detail: ev.detail });
      hooks?.appendToolBlock({ name: ev.name, detail: ev.detail });
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
      pendingEdit = extractCodeBlock(ev.text);
      hooks?.renderThread();
      hooks?.updateMeter();
      return;
    }
    case "error": {
      if (live) {
        live.streaming = false;
        live.text = live.text ? `${live.text}\n\n（中断：${ev.message}）` : `（失败：${ev.message}）`;
      }
      currentRequest = "";
      hooks?.renderThread();
      hooks?.updateMeter();
      return;
    }
  }
}

// ============================================================================
// 面板入口
// ============================================================================

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

  const thread = el("div", { class: "ai-thread" });
  wrap.appendChild(thread);

  // ---- 输入区 ----
  const compose = el("div", { class: "ai-compose" });

  // 4 个固定动作：AI 面板「有用」的地方不是聊天框，而是这四条直达路径
  const quick = el("div", { class: "ai-quick" });
  quick.appendChild(
    button("解释当前脚本错误", () => void send("explain-error"), {
      size: "sm",
      variant: "ghost",
      iconPath: I.warn,
      title: "把「问题」面板里的错误摘要 + 当前脚本一起发给 AI"
    })
  );
  quick.appendChild(
    button("改这段脚本", () => void send("edit-script"), {
      size: "sm",
      variant: "ghost",
      iconPath: I.wand,
      title: "AI 返回的代码只做 diff 预览，点「应用」才写回编辑器"
    })
  );
  quick.appendChild(
    button("审一遍当前场景", () => void send("scene-review"), {
      size: "sm",
      variant: "ghost",
      iconPath: I.eye,
      title: "带工程摘要让 AI 找结构性问题（不发原始工程数据）"
    })
  );
  quick.appendChild(
    button("继续对话", () => void send("chat"), {
      size: "sm",
      variant: "ghost",
      iconPath: I.chevronRight,
      title: "把输入框里的内容作为下一轮发出去"
    })
  );
  compose.appendChild(quick);

  const inputRow = el("div", { class: "ai-input-row" });
  const ta = el("textarea", {
    class: "ai-input",
    placeholder: "描述问题，或点下面的快捷动作…（Ctrl+Enter 发送）"
  });
  inputRow.appendChild(ta);

  const sendBtn = button("发送", () => void send("chat"), { variant: "primary", size: "sm", iconPath: I.sparkles });
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

  async function send(intent: AiChatRequest["intent"]): Promise<void> {
    if (currentRequest) {
      info("上一轮还在生成，等它结束或点「停止」");
      return;
    }
    if (!store.project) {
      info("先打开一个工程");
      return;
    }

    const typed = ta.value.trim();
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
    ta.value = "";
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
    bar.appendChild(
      el("span", { class: "model-chip " + (mock ? "flash" : "pro") }, mock ? "本地演示" : `${status.provider} · 已连接`)
    );
    bar.appendChild(el("div", { class: "spacer" }));
    bar.appendChild(el("span", { class: "hint" }, `flash ${status.models.flash} · pro ${status.models.pro}`));

    if (mock) {
      hintBox.textContent = status.message || "没有可用的 AI 宿主，当前是本地演示模式。";
      hintBox.style.display = "";
    } else {
      hintBox.style.display = "none";
    }
    updateMeter();
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

  function appendToolBlock(tool: ToolCallBlock): void {
    thread.appendChild(toolBlock(tool));
    thread.scrollTop = thread.scrollHeight;
  }

  function toolBlock(tool: ToolCallBlock): HTMLElement {
    const box = el("div", { class: "ai-tool" });
    const head = el("header");
    head.appendChild(svg(I.puzzle, 13));
    head.appendChild(el("span", { class: "ai-tool-name" }, tool.name));
    head.appendChild(el("div", { class: "spacer" }));
    head.appendChild(el("span", { class: "hint" }, "工具调用"));
    const body = el("div", { class: "body" }, tool.detail);
    body.style.display = "none";
    let open = false;
    head.addEventListener("click", () => {
      open = !open;
      body.style.display = open ? "" : "none";
    });
    box.appendChild(head);
    box.appendChild(body);
    return box;
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

    const modelLabel = lastModel === "pro" ? "pro" : lastModel === "flash" ? "flash" : status?.mode === "mock" || status === null ? "本地演示" : "未开始";
    meter.appendChild(el("span", { class: "model-chip " + (lastModel || "flash") }, modelLabel));
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
    sendBtn.disabled = busy;
    stopBtn.style.display = busy ? "" : "none";
  }

  function routeReasonText(): string {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant" && t.reason) return `路由：${t.reason}`;
    }
    if (!statusLoaded) return "路由：—";
    return status?.mode === "mock" ? "路由：本地演示（零 token）" : "路由：—";
  }

  // 把实现填进槽位：模块层的流式回调据此驱动本面板的 DOM
  hooks = { renderThread, appendDelta, appendToolBlock, updateMeter, runAction: (intent) => void send(intent) };

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
export function aiPanelSummary(): { model: AiModel | ""; cacheHitRate: number; usage: TokenUsage | null; mock: boolean } {
  return {
    model: lastModel,
    cacheHitRate: lastCacheHit,
    usage: lastUsage,
    mock: status ? status.mode === "mock" || !status.ready : true
  };
}
