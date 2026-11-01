/**
 * 命令面板（Ctrl+Shift+P）。
 *
 * 交互约定（照 VS Code 的肌肉记忆，但只保留用得上的部分）：
 *   - 打开即聚焦输入框，输入即过滤；
 *   - ↑/↓ 移动选中项，Enter 执行，Esc 关闭（不执行）；
 *   - 点击条目同样执行；鼠标悬停同步选中态（键盘与鼠标不会各选各的）；
 *   - 不可用的命令灰显但仍然列出 —— 用户需要知道"它存在，只是现在条件不满足"。
 *
 * 为什么不做成下拉窗：命令面板要能横跨几十条命令，并且在 1280×720 下仍然
 * 放得下；居中浮层 + 滚动列表是唯一能同时满足这两点的形态。
 */

import { el, clear } from "../core/dom.ts";
import { svg } from "../core/dom.ts";
import { I } from "./icons.ts";
import { filterCommands, runCommand, type Command } from "./commands.ts";

let mask: HTMLElement | null = null;

/** 打开命令面板（重复调用只把焦点拉回输入框）。 */
export function openCommandPalette(): void {
  if (mask) {
    const input = mask.querySelector(".cp-input") as HTMLInputElement | null;
    input?.focus();
    return;
  }
  mask = el("div", { class: "command-palette-mask" });
  // data 锚点：验收脚本据此确认"浮层真的弹出来了"
  const box = el("div", { class: "command-palette", "data-command-palette": "1" });

  const input = el("input", {
    "data-cp-input": "1",
    class: "cp-input",
    type: "text",
    placeholder: "输入命令名…（例如 保存 / 打包 / AI:解释）"
  });
  const list = el("div", { class: "cp-list" });
  box.appendChild(input);
  box.appendChild(list);
  mask.appendChild(box);

  let items: Command[] = filterCommands("");
  let active = 0;

  const render = (): void => {
    clear(list);
    if (!items.length) {
      list.appendChild(el("div", { class: "cp-empty" }, "没有匹配的命令。试试更短的关键词，比如「保存」「打包」「缩放」。"));
      return;
    }
    // 只渲染前 60 条：命令再多也不该让一次渲染卡住
    const shown = items.slice(0, 60);
    shown.forEach((c, i) => {
      const usable = !(c.enabled && !c.enabled());
      const row = el("button", {
        type: "button",
        class: "cp-item" + (i === active ? " active" : ""),
        title: c.hint ?? ""
      });
      row.appendChild(svg(c.icon ? I[c.icon] : I.chevronRight, 14));
      row.appendChild(el("span", { class: "cp-title" }, c.title));
      if (c.group) row.appendChild(el("span", { class: "cp-group hint" }, c.group));
      if (c.key) row.appendChild(el("span", { class: "cp-key" }, c.key));
      if (!usable) {
        row.style.opacity = ".45";
        row.style.cursor = "not-allowed";
      }
      row.addEventListener("click", () => {
        if (!usable) return;
        close();
        runCommand(c.id);
      });
      row.addEventListener("mousemove", () => {
        if (active === i) return;
        active = i;
        highlight();
      });
      list.appendChild(row);
    });
    // 选中项滚进视野（键盘翻到列表下方时否则会看不见）
    const activeRow = list.children[active] as HTMLElement | undefined;
    activeRow?.scrollIntoView({ block: "nearest" });
  };

  const highlight = (): void => {
    Array.from(list.children).forEach((c, i) => {
      c.classList.toggle("active", i === active);
    });
    const row = list.children[active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  };

  const close = (): void => {
    mask?.remove();
    mask = null;
    document.removeEventListener("keydown", onKey, true);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(items.length - 1, active + 1);
      highlight();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, active - 1);
      highlight();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const c = items[active];
      if (!c) return;
      if (c.enabled && !c.enabled()) return;
      close();
      runCommand(c.id);
    }
  };

  input.addEventListener("input", () => {
    items = filterCommands(input.value);
    active = 0;
    render();
  });

  // 点遮罩关闭（命令面板不是"会丢数据"的弹窗，点了外面就该关）
  mask.addEventListener("mousedown", (e) => {
    if (e.target === mask) close();
  });

  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(mask);
  render();
  input.focus();
}

export function isCommandPaletteOpen(): boolean {
  return !!mask;
}

export function closeCommandPalette(): void {
  mask?.remove();
  mask = null;
}
