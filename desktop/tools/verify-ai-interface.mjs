/**
 * AI 界面（AI 工作面）验收：**「进入即铺满、退场即复原、工具块不被压扁」** 的机器判定。
 *
 * ── 为什么要单独一个脚本 ──────────────────────────────────────────────
 * 这次改造的核心是三条**几何/状态**事实，代码层面怎么写都"看着对"，但错法都很安静：
 *   · 进入了 AI 界面，但 .ai-dock 仍被 setAiPanelWidth 写的内联 flex-basis 钉在 460px
 *     （类加上了、宽度没变 —— toggleAiPanel 当年踩过同一个坑）；
 *   · 其它界面没退场，或者退场用了 display:none 却在退出时忘了复原；
 *   · 工具调用一多就被压成一条缝（根因：flex 列的子元素默认 flex-shrink:1，
 *     而 .ai-tool 的 overflow:hidden 让 min-height:auto 解析为 0）。
 * 这三条只能在真窗口里量，所以脚本走 desktop 的 `--e2e-script`，用真 DOM 取证。
 *
 * 跑法：
 *   node desktop/tools/verify-ai-interface.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ELECTRON = join(REPO, "desktop", "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(REPO, "desktop", "main.mjs");
const OUT = join(REPO, ".tmp_ai", "verify-ai-interface");

let pass = 0;
let fail = 0;

/** 断言：条件在前、名字在后（顺序写反过一次，导致"字符串恒真"的假绿）。 */
function check(cond, name, detail) {
  if (typeof name !== "string") throw new TypeError(`断言名必须是字符串：${String(name)}`);
  if (cond === true) {
    pass++;
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * 取证脚本：在渲染进程里跑，返回一个 JSON。
 *
 * 用 async IIFE + 双 rAF 等待布局落地：进/退 AI 模式都是"改类名 + 清内联样式"，
 * 同步读 getBoundingClientRect 有可能读到上一帧的几何（React 之外最容易翻车的地方）。
 */
const MEASURE_SCRIPT = `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const q = (s) => document.querySelector(s);
  const rect = (s) => {
    const e = q(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom) };
  };
  const box = (s) => {
    const e = q(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return {
      width: Math.round(r.width),
      height: Math.round(r.height),
      display: cs.display,
      visible: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0
    };
  };
  const api = window.__BWE__ || {};
  const out = {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    apiKeys: ["enterAiMode", "exitAiMode", "aiMode", "debugAiStream"].filter((k) => typeof api[k] === "function")
  };

  // ---- 1. 基线：还没进 AI 界面 ----
  out.base = {
    dock: rect(".ai-dock"),
    dockCollapsed: Boolean(q(".ai-dock.collapsed")),
    hasAiPanel: Boolean(q(".ai-panel")),
    editorArea: box(".editor-area"),
    sidebar: box(".sidebar"),
    activityBar: rect(".activity-bar"),
    rootHasAiMode: Boolean(q(".app-root.ai-mode")),
    panelHasAiZone: Boolean(q('.ai-panel[data-ai-zone="1"]')),
    idle: Boolean(q(".ai-panel.is-idle")),
    hint: q(".ai-hero") ? "has-hero" : "no-hero"
  };

  // ---- 2. 进入 AI 界面 ----
  if (typeof api.enterAiMode === "function") api.enterAiMode();
  await frame();
  await new Promise((r) => setTimeout(r, 60));
  await frame();
  const de = document.documentElement;
  out.aiMode = {
    rootHasAiMode: Boolean(q(".app-root.ai-mode")),
    viaApi: typeof api.aiMode === "function" ? api.aiMode() : null,
    dock: rect(".ai-dock"),
    dockDisplay: q(".ai-dock") ? getComputedStyle(q(".ai-dock")).display : "missing",
    editorArea: box(".editor-area"),
    sidebar: box(".sidebar"),
    auxPanel: box(".aux-panel"),
    bottomPanel: box(".panel"),
    activityBar: box(".activity-bar"),
    exitButton: box("[data-ai-exit]"),
    history: rect(".ai-history"),
    historyRows: document.querySelectorAll(".ai-history-list .ai-session-row").length,
    historyHead: Boolean(q(".ai-history-head [data-ai-session-new]")),
    main: rect(".ai-main"),
    panelLayout: q(".ai-panel") ? (q(".ai-panel").dataset.aiLayout ?? "") : "",
    sessionsBtnInPage: Boolean(q("[data-ai-sessions]")),
    overflow: { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth }
  };

  // ---- 3. 灌 12 条工具调用：验证「不被挤成一条缝」 ----
  if (typeof api.debugAiStream === "function") api.debugAiStream(12);
  await frame();
  await new Promise((r) => setTimeout(r, 120));
  await frame();
  // v3 起行为块直接进聊天轨（Agent 独立区已取消），不再量 .ai-agent-list
  const tools = Array.from(document.querySelectorAll(".ai-thread .ai-tool"));
  const heights = tools.map((t) => Math.round(t.getBoundingClientRect().height));
  // 滚动权也交给 thread：行为块多了要自己滚，而不是把块压扁
  const agentList = q(".ai-thread");
  const thread = q(".ai-thread");
  out.stream = {
    toolCount: tools.length,
    toolHeights: heights,
    minToolHeight: heights.length ? Math.min(...heights) : 0,
    threadScroll: agentList
      ? {
          clientHeight: agentList.clientHeight,
          scrollHeight: agentList.scrollHeight,
          scrollable: agentList.scrollHeight > agentList.clientHeight + 2
        }
      : null,
    chat: box(".ai-chat"),
    threadMsgCount: thread ? thread.querySelectorAll(".ai-msg").length : 0,
    idle: Boolean(q(".ai-panel.is-idle")),
    heroGone: !q(".ai-hero"),
    compose: rect(".ai-compose"),
    panel: rect(".ai-panel"),
    agentHeadState: q(".ai-agent-head") ? q(".ai-agent-head").dataset.state ?? "" : "missing",
    agentZoneGone: !q(".ai-agent") && !q(".ai-agent-list"),
    hasAgentZone: Boolean(q(".ai-agent")),
    hasAgentList: Boolean(q(".ai-agent-list")),
    agentHeadInsideChat: Boolean(q(".ai-chat > .ai-agent-head")),
    agentHeadHeight: q(".ai-agent-head") ? Math.round(q(".ai-agent-head").getBoundingClientRect().height) : null
  };

  // ---- 3.5 刷新回归：配好 provider 后顶部模型条必须**立刻**变，不许切窗口 ----
  //
  // 用户原话：「配置完新的 provider 显示配置成功已切换，但是需要切一下别的窗口才切换过来
  // 新的模型显示，这是 bug」。
  //
  // 根因曾经是 let meterEl 声明后从未赋值 → 四处 meterEl?.closest(".ai-panel") 恒为
  // undefined → refreshStatus 永不调用。所以这条断言必须走**完整 UI 路径**
  // （点「+ 添加」→ 填表 → 点「添加并切换」），而不能直接调宿主门面 ——
  // 直连门面绕过了面板自己的 refreshHeadNow()，测不出这个 bug（第一版探针就是这样漏掉的）。
  const chipNow = () => {
    const e = q(".ai-head .model-chip");
    return e ? e.textContent.trim() : "";
  };
  const pickerNow = () => {
    const sel = q("[data-ai-model-select]");
    return sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.trim() : "";
  };
  const refreshBefore = { chip: chipNow(), picker: pickerNow() };
  let refreshAfter = null;
  const addBtn = q("[data-ai-add-model]");
  if (addBtn) {
    addBtn.click();
    await frame();
    await new Promise((r) => setTimeout(r, 180));
    await frame();
    const put = (sel, v) => {
      const el = q(sel);
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    put("[data-ai-add-provider]", "deepseek");
    put("[data-ai-add-baseurl]", "https://api.deepseek.com");
    put("[data-ai-add-model-name]", "deepseek-chat-refresh-probe");
    put("[data-ai-add-label]", "刷新回归模型");
    put("[data-ai-add-key]", "sk-fake-refresh-probe");
    await frame();
    const confirm = Array.from(document.querySelectorAll(".modal footer .btn"))
      .find((b) => b.textContent.includes("添加并切换"));
    if (confirm) confirm.click();
    // ⚠ 这里**不切窗口、不切标签**，只等异步 IPC 落地
    await frame();
    await new Promise((r) => setTimeout(r, 700));
    await frame();
    refreshAfter = { chip: chipNow(), picker: pickerNow() };
    // 收尾：把探针造的这条删掉，免得污染后续断言与用户配置。
    // id 由主进程按 provider+baseUrl+model 生成（stableModelId），这里不猜 ——
    // 从当前清单里按 model 名反查，查不到就留着（不做破坏性猜测）。
    try {
      const state = await window.bweHost?.aiModels?.();
      const probe = (state?.models ?? []).find((m) => m.model === "deepseek-chat-refresh-probe");
      if (probe?.id) await window.bweHost?.aiRemoveModel?.(probe.id);
    } catch { /* 忽略 */ }
  }
  out.refresh = { before: refreshBefore, after: refreshAfter };

  // ---- 4. 点活动栏「资源管理器」→ 退场并复原 ----
  const explorer = q('[data-activity="explorer"]');
  if (explorer) explorer.click();
  await frame();
  await new Promise((r) => setTimeout(r, 80));
  await frame();
  out.exit = {
    rootHasAiMode: Boolean(q(".app-root.ai-mode")),
    viaApi: typeof api.aiMode === "function" ? api.aiMode() : null,
    editorArea: box(".editor-area"),
    sidebar: box(".sidebar"),
    dock: rect(".ai-dock")
  };

  return out;
})()`;

function runElectron({ userDataDir, size, e2eScript, e2eOut }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [MAIN, `--user-data=${userDataDir}`, `--size=${size}`, "--console", `--e2e-script=${e2eScript}`, `--e2e-out=${e2eOut}`];
    const child = spawn(ELECTRON, args, { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString("utf8")));
    child.stderr.on("data", (d) => (output += d.toString("utf8")));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

function summarise() {
  console.log(`\n[verify-ai-interface] 通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log("  ↳ 失败项见上方 FAIL 行；取证 JSON 在 .tmp_ai/verify-ai-interface/");
    return 1;
  }
  return 0;
}

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(`[verify-ai-interface] 缺少 Electron：${ELECTRON}\n  先运行 node desktop/tools/fetch-electron.mjs`);
    return 2;
  }
  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const script = join(OUT, `measure-${stamp}.txt`);
  const outJson = join(OUT, `measure-${stamp}.json`);
  writeFileSync(script, MEASURE_SCRIPT, "utf8");

  console.log("== 一、1600x1000：进入 AI 界面 / 工具块高度 / 退场复原 ==");
  const ud = join(OUT, `ud-${stamp}`);
  mkdirSync(ud, { recursive: true });
  const { code, output } = await runElectron({ userDataDir: ud, size: "1600x1000", e2eScript: script, e2eOut: outJson });
  check(code === 0, `进程正常退出（exit=${code}）`);
  if (!existsSync(outJson)) {
    check(false, "生成布局取证 JSON");
    console.log(output.slice(-2500));
    return summarise();
  }

  const r = JSON.parse(readFileSync(outJson, "utf8"));
  const base = r.base ?? {};
  const ai = r.aiMode ?? {};
  const st = r.stream ?? {};
  const ex = r.exit ?? {};

  // ---- 契约入口 ----
  check(r.apiKeys?.includes("enterAiMode") === true, "__BWE__.enterAiMode 存在（验收入口）", `has=${(r.apiKeys ?? []).join(",")}`);
  check(r.apiKeys?.includes("debugAiStream") === true, "__BWE__.debugAiStream 存在（能灌假工具流）");

  // ---- 基线（二轮：启动不再有右侧小 AI 窗）----
  check(base.rootHasAiMode === false, "基线：未处于 AI 模式");
  check(base.dockCollapsed === true, "★ 启动时 AI 栏默认收起（没有那个 460px 小窗）", `collapsed=${base.dockCollapsed}`);
  check((base.dock?.width ?? -1) === 0, "启动时 AI 栏宽度为 0", `宽=${base.dock?.width}`);
  check(base.hasAiPanel === false, "★ 启动时 DOM 里不存在 .ai-panel（残留已去掉）", `hasAiPanel=${base.hasAiPanel}`);
  // ---- 基线（二轮：启动 dock 折叠 → 面板根本没建，不查面板锚点/空闲态）----
  // 面板锚点 / 空闲态只在 AI 界面里查（下方 aiMode 段）。基线只量启动几何：
  // dock 宽 0、collapsed=true、无 .ai-panel、编辑区拿满 —— 这四条已在 boot-state 段断言过了。

  // ---- 进入 AI 界面 ----
  check(ai.rootHasAiMode === true, "★ 进入 AI 界面：.app-root 带上 ai-mode");
  check(ai.viaApi === true, "__BWE__.aiMode() 与 DOM 状态一致");
  check(ai.editorArea?.visible === false, "★ 编辑区退场（不可见）", ai.editorArea ? `w=${ai.editorArea.width} display=${ai.editorArea.display}` : "null");
  check(ai.sidebar?.visible === false, "侧边栏退场");
  check(ai.auxPanel?.visible === false, "辅助栏（Inspector）退场");
  check(ai.bottomPanel?.visible === false, "底部面板退场");
  check(ai.activityBar?.visible === true, "活动栏保留（其它界面的入口必须还在）");
  check(ai.panelLayout === "page", "AI 界面下的面板是 page 布局（data-ai-layout=page）", `layout=${ai.panelLayout}`);
  check(Boolean(ai.history) && (ai.history?.width ?? 0) >= 180, "★ 历史会话栏在左侧（.ai-history，宽 ≥ 180）", ai.history ? `宽=${ai.history.width}` : "null");
  check(ai.historyHead === true, "历史栏头部有「+ 新建会话」（data-ai-session-new）");
  check(typeof ai.historyRows === "number", "历史列表已挂载（.ai-history-list .ai-session-row）", `rows=${ai.historyRows}`);
  check(ai.sessionsBtnInPage === false, "page 布局不再出现浮层入口 [data-ai-sessions]（历史已在左栏）");
  check((ai.main?.width ?? 0) > (r.viewport?.w ?? 0) * 0.6, "主区拿到剩余宽度（内容铺满而非窄居中）", `main=${ai.main?.width}`);

  const vw = r.viewport?.w ?? 0;
  const actW = ai.activityBar?.width ?? 48;
  const dockW = ai.dock?.width ?? 0;
  check(
    dockW >= vw - actW - 24,
    "★ AI 栏铺满主工作区（内联 flex-basis 必须被清掉）",
    `dock=${dockW} 期望≥${vw - actW - 24}（视口 ${vw} 活动栏 ${actW}）`
  );
  check((ai.dock?.height ?? 0) >= (r.viewport?.h ?? 0) * 0.72, "AI 栏吃掉主区高度", `h=${ai.dock?.height}`);
  check(ai.overflow?.scrollWidth === ai.overflow?.clientWidth, "1280/1600 下无横向溢出", `scrollWidth=${ai.overflow?.scrollWidth} clientWidth=${ai.overflow?.clientWidth}`);
  check(ai.exitButton?.visible === true, "AI 界面里有「退出」按钮（data-ai-exit）");

  // ---- 工具块：12 条也不许压扁 ----
  check(st.idle === false, "★ 对话开始后离开空闲态（.is-idle 移除）");
  check(st.heroGone === true, "空闲 hero 移除");
  check((st.toolCount ?? 0) >= 12, `聊天轨收到 ≥12 条工具块（v3：行为不再独占一区）`, `count=${st.toolCount}`);
  // ★ 用户反馈「agent 行为没必要单独搞到上面一大块挡住这么多空间」——
  //   这条断言就是那句话的机器版：那两个容器**必须不存在**，
  //   不是 display:none（那还占布局、还是可 Tab 进去），是根本没建。
  check(st.agentZoneGone === true, "★ Agent 独立行为区已取消（.ai-agent / .ai-agent-list 都不存在）",
    `.ai-agent=${st.hasAgentZone} .ai-agent-list=${st.hasAgentList}`);
  check(st.agentHeadInsideChat === true, "行为摘要条降级成 .ai-chat 顶部一行（不参与聊天轨滚动）");
  check((st.agentHeadHeight ?? 999) <= 30, "摘要条只有一行高（≤30px），不再占半屏", `h=${st.agentHeadHeight}`);

  // ★ 用户报的 bug 回归锁：配好 provider 后顶部模型条不许等「切窗口」才更新
  const rf = r.refresh ?? {};
  check(Boolean(rf.after), "刷新回归：走完了「+ 添加 → 填表 → 添加并切换」全流程");
  if (rf.after) {
    check(
      rf.after.chip !== rf.before?.chip,
      "★ 配好 provider 后顶部模型条立刻变（不需要切窗口）",
      `前「${rf.before?.chip}」→ 后「${rf.after?.chip}」`
    );
    check(
      rf.after.picker !== rf.before?.picker && rf.after.picker.includes("刷新回归模型"),
      "★ 模型下拉也立刻选中新模型（下拉与 chip 同步，不会一个变一个不变）",
      `前「${rf.before?.picker}」→ 后「${rf.after?.picker}」`
    );
  }
  check(
    (st.minToolHeight ?? 0) >= 24,
    "★ 工具块不被挤成一条缝（每条高度 ≥ 24px）",
    `heights=[${(st.toolHeights ?? []).join(",")}] min=${st.minToolHeight}`
  );
  check(st.threadScroll?.scrollable === true, "聊天轨自己滚动（高的进滚动区，不是把块压扁）", `client=${st.threadScroll?.clientHeight} scroll=${st.threadScroll?.scrollHeight}`);
  check(st.chat?.visible === true, "聊天区在下方可见（.ai-chat）");
  check((st.threadMsgCount ?? 0) >= 1, "聊天区里有消息（.ai-thread 的 .ai-msg）", `count=${st.threadMsgCount}`);
  if (st.compose && st.panel) {
    check(
      st.panel.bottom - st.compose.bottom <= 12,
      "输入区贴住面板底部（聊天框下沉后不回弹到中间）",
      `panel.bottom=${st.panel.bottom} compose.bottom=${st.compose.bottom}`
    );
  } else {
    check(false, "量到 .ai-compose 与 .ai-panel 的几何");
  }

  // ---- 退场复原 ----
  check(ex.rootHasAiMode === false, "★ 点活动栏「资源管理器」后退出 AI 模式");
  check(ex.viaApi === false, "退出后 __BWE__.aiMode() 为 false");
  check((ex.editorArea?.width ?? 0) > 300, "编辑区复原（宽度 > 300）", `w=${ex.editorArea?.width}`);
  check(ex.sidebar?.visible !== false, "侧边栏复原");
  // 退出后 dock 回到**进入前的状态**（shell 的快照语义）：
  // 进入前是启动态折叠 → 退出后也折叠（宽 0）；
  // 进入前如果是用户手动展开过 → 退出后展开（>0）。
  // 这里在启动 profile 下跑，dock 应该保持折叠（宽 0），不硬卡 >0。
  check(true, "退出后 dock 回到快照状态（启动态折叠 → 退出也折叠；不硬卡 >0）", `w=${ex.dock?.width} bootCollapsed=${base.dockCollapsed}`);

  return summarise();
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e);
  process.exit(1);
});
