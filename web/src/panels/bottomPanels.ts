/**
 * 问题 / 输出 / AI 三个底部面板。
 *
 * 为什么合在一个文件：
 *   - 三者共享同一条「底部面板」骨架（标签、计数徽标、折叠），拆成三个文件会各写一遍；
 *   - 它们的数据源（core/diagnostics.ts、core/output.ts）是分开的，所以这里只做视图。
 *
 * 纪律：
 *   - 「问题」面板只负责展示与跳转，不负责产生诊断（诊断由剧本面板/打包工作台写入）；
 *   - 跳转到脚本行必须回到「剧本」侧边栏页，否则用户点了一条却看不见对应源码；
 *   - 计数徽标只显示 error（warn 数量在标题里给），避免底部一直挂着红点。
 */

import { el, button } from "../core/dom.ts";
import { I, type IconName } from "../ui/icons.ts";
import { allProblems, clearAllProblems, onProblems, problemCounts, type Problem } from "../core/diagnostics.ts";
import { outputLines, onOutput, clearOutput, type OutputLevel } from "../core/output.ts";
import { requestOpenScriptPanel } from "./scriptPanel.ts";
import { warn } from "../ui/toast.ts";

/** 「问题」标签上的计数徽标（由 Editor 的底部面板共享）。 */
export interface PanelTabSpec {
  id: "problems" | "output" | "ai";
  label: string;
  icon: IconName;
  render: (host: HTMLElement) => void;
  /** 是否有未读新内容（用于画点亮的小圆点） */
  hasActivity?: () => boolean;
}

export function countBadge(errors: number, warns: number): HTMLElement | null {
  if (!errors && !warns) return null;
  const b = el("span", { class: "count-badge" });
  b.textContent = errors ? String(errors) : String(warns);
  if (!errors) {
    // 只有警告时用暖黄色，避免和真正的错误一样刺眼
    b.style.background = "var(--warn-soft)";
    b.style.color = "var(--warn)";
  }
  return b;
}

// ============================================================================
// 问题面板
// ============================================================================

/**
 * 渲染问题列表。
 *
 * 每行结构：`✗ 第 12 行  【world.js】  TypeError: xxx`
 * 点一行 → 打开剧本面板并定位到该脚本的该行。
 */
export function renderProblemsPanel(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "problem-list" });

  const problems = allProblems();
  if (!problems.length) {
    wrap.appendChild(
      el(
        "div",
        { class: "hint" },
        "没有问题。\n"
        + "这里汇总：剧本 JS/Yarn 的静态检查、打包与试跑的错误。\n"
        + "改完脚本会自动刷新 —— 不需要手动点检查。"
      )
    );
    host.appendChild(wrap);
    return;
  }

  const counts = problemCounts();
  const head = el("div", { class: "row tight" });
  head.style.marginBottom = "4px";
  head.appendChild(el("span", { class: "hint" }, `${counts.errors} 错误 · ${counts.warns} 警告`));
  head.appendChild(el("div", { class: "spacer" }));
  head.appendChild(button("全部清空", () => {
    // 只清当前快照：脚本面板每敲一次都会重跑检查，错误会重新出现。
    // 所以这是"眼不见为净"，不是"永久忽略这条错误"。
    clearAllProblems();
  }, { size: "sm", variant: "ghost", iconPath: I.trash }));
  wrap.appendChild(head);

  for (const p of problems) {
    wrap.appendChild(problemRow(p));
  }
  host.appendChild(wrap);
}

/** 单条问题（错误/警告共用；图标与颜色由 severity 决定）。 */
function problemRow(p: Problem): HTMLElement {
  const row = el("div", {
    class: `problem-row ${p.severity}`,
    title: p.line
      ? `${p.sourceLabel} · 第 ${p.line} 行${p.col ? ` 第 ${p.col} 列` : ""} · 点击跳到源码`
      : `${p.sourceLabel} · 点击查看`
  });
  const sev = el("span", { class: "sev" }, p.severity === "error" ? "✗" : p.severity === "warn" ? "⚠" : "ⓘ");
  row.appendChild(sev);
  // 位置：优先显示"脚本名:行号"，这是用户真正要的定位信息
  const where = p.line ? `${p.scriptName ?? p.sourceLabel}:${p.line}` : p.sourceLabel;
  row.appendChild(el("span", { class: "where" }, where));
  row.appendChild(el("span", { class: "msg" }, p.message));

  row.addEventListener("click", () => {
    if (p.source === "js" || p.source === "yarn") {
      if (p.scriptName) {
        requestOpenScriptPanel(p.scriptLang ?? (p.source === "js" ? "js" : "yarn"), p.scriptName);
      } else {
        requestOpenScriptPanel(p.source === "js" ? "js" : "yarn");
      }
      // 剧本面板会在下一拍重渲染；行定位通过广播交给它（它自己知道当前 textarea）
      if (p.line) {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("bwe:script-goto-line", { detail: { line: p.line } }));
        }, 60);
      }
      return;
    }
    // 打包 / 试跑的错误没有源码位置，就带用户去「输出」看完整日志
    window.dispatchEvent(new CustomEvent("bwe:show-output"));
    warn("这条错误没有对应的源码位置，完整上下文在「输出」面板");
  });
  return row;
}


// ============================================================================
// 输出面板
// ============================================================================

const LEVEL_MARK: Record<OutputLevel, string> = {
  info: " ",
  ok: "✓",
  warn: "⚠",
  error: "✗"
};

export function renderOutputPanel(host: HTMLElement): void {
  host.replaceChildren();
  const wrap = el("div", { class: "output-list" });

  const head = el("div", { class: "row tight" });
  head.style.marginBottom = "4px";
  head.appendChild(el("span", { class: "hint" }, `${outputLines().length} 行（最多保留 2000 行）`));
  head.appendChild(el("div", { class: "spacer" }));
  head.appendChild(button("清空", () => {
    clearOutput();
  }, { size: "sm", variant: "ghost", iconPath: I.trash }));
  wrap.appendChild(head);

  const lines = outputLines();
  if (!lines.length) {
    wrap.appendChild(
      el("div", { class: "hint" }, "还没有输出。\n打包、试跑、脚本检查的过程日志都会出现在这里（关掉弹窗也不会丢）。")
    );
    host.appendChild(wrap);
    return;
  }

  // 只渲染最近 400 行：更早的行用户几乎不会看，全量渲染会拖慢滚动
  const shown = lines.slice(-400);
  const list = el("div", { class: "output-lines" });
  for (const l of shown) {
    const row = el("div", { class: `output-line ${l.level}` });
    row.appendChild(el("span", { class: "out-mark" }, LEVEL_MARK[l.level]));
    row.appendChild(el("span", { class: "out-channel" }, l.channel));
    row.appendChild(el("span", { class: "out-text" }, l.text));
    list.appendChild(row);
  }
  wrap.appendChild(list);
  host.appendChild(wrap);

  // 打开时滚到底：用户关心的是"刚刚发生了什么"
  host.scrollTop = host.scrollHeight;
}

// ============================================================================
// 面板规格：Editor 的底部面板直接用这三个
// ============================================================================

/** 问题面板：订阅诊断变化后重画（Editor 会把重画接成按帧合并）。 */
export function problemsTab(onDirty: () => void): PanelTabSpec {
  onProblems(onDirty);
  return {
    id: "problems",
    label: "问题 Problems",
    icon: "problems",
    render: renderProblemsPanel,
    hasActivity: () => problemCounts().errors > 0
  };
}

export function outputTab(onDirty: () => void): PanelTabSpec {
  onOutput(onDirty);
  return {
    id: "output",
    label: "输出 Output",
    icon: "terminal",
    render: renderOutputPanel
  };
}
