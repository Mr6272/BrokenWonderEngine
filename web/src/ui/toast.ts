/**
 * 轻提示与模态框。
 *
 * 弹窗纪律（决定"用起来乱不乱"）：
 * 1. 成功 / 失败 / 被忽略 / 信息 —— 一律走 toast，不打断操作；
 * 2. 状态栏只放"持续可见"的信息（坐标、缩放、选中数）；
 * 3. 只有"会丢数据"的动作才允许弹模态框，且默认焦点落在安全选项上；
 * 4. 模态框一律支持 Esc 取消、点遮罩不关闭（避免误点丢失输入）。
 */

type ToastKind = "ok" | "info" | "warn" | "error";

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (!host || !document.body.contains(host)) {
    host = document.createElement("div");
    host.className = "toast-host";
    document.body.appendChild(host);
    // 每弹出一次都按当前面板高度重算位置：底部面板展开时 toast 要整体上移，
    // 否则会压在 AI 输入框上（用户正在打字的地方）。
    syncToastOffset(host);
  }
  return host;
}

const MAX_LIVE = 3;

/**
 * toast 的垂直位置跟随底部面板高度。
 *
 * CSS 里给了兜底基准（64px），但面板展开时它不够 —— 这里用最朴素的办法：
 * 读一次 panel/statusbar 的 rect 写进 CSS 变量，没有面板结构（旧布局/弹窗场景）
 * 就保持 CSS 兜底值，不会因为找不到元素而报错。
 */
/** 面板几何变化后重算 toast 位置（编辑器切标签/拖高面板时调用）。 */
export function syncToastPosition(): void {
  if (host && document.body.contains(host)) syncToastOffset(host);
}

function syncToastOffset(host: HTMLElement): void {
  try {
    const panel = document.querySelector(".panel") as HTMLElement | null;
    const statusbar = document.querySelector(".statusbar") as HTMLElement | null;
    const panelH = panel && !panel.classList.contains("collapsed") ? panel.getBoundingClientRect().height : 0;
    const statusH = statusbar ? statusbar.getBoundingClientRect().height : 0;
    // 面板展开时还要再让出输入区高度，避免压在输入框上
    host.style.bottom = `${Math.round(statusH + panelH + 12)}px`;
  } catch {
    /* 忽略：CSS 兜底值继续生效 */
  }
}

export function toast(text: string, kind: ToastKind = "info", ms?: number): void {
  if (!text) return;
  const h = ensureHost();
  // 每次弹出都按"当前"面板高度重算：面板可能刚展开/折叠/被拖高过
  syncToastOffset(h);
  while (h.childElementCount >= MAX_LIVE) {
    h.removeChild(h.firstElementChild as Node);
  }
  const box = document.createElement("div");
  box.className = "toast " + kind;
  box.textContent = text;
  h.appendChild(box);
  const life = ms ?? (kind === "error" ? 4200 : kind === "warn" ? 3400 : 2600);
  window.setTimeout(() => {
    box.classList.add("leaving");
    window.setTimeout(() => box.remove(), 200);
  }, life);
}

export const ok = (t: string) => toast(t, "ok");
export const info = (t: string) => toast(t, "info");
export const warn = (t: string) => toast(t, "warn");
export const error = (t: string) => toast(t, "error");

// ---------------- 模态框 ----------------

export interface ModalOpts {
  title: string;
  /** 正文；返回一个元素 */
  body: HTMLElement | ((close: () => void) => HTMLElement);
  /** 底部按钮；第一个是主按钮 */
  actions?: { label: string; variant?: "primary" | "danger" | "ghost" | "outline"; onClick: (close: () => void) => void }[];
  wide?: boolean;
  /** 更宽的工作台弹窗（模块编辑器、试玩） */
  xwide?: boolean;
  /** 点遮罩是否关闭（默认否，防止误点丢失输入） */
  closeOnMask?: boolean;
  onClose?: () => void;
}

export function modal(opts: ModalOpts): () => void {
  const close = () => {
    if (!mask.isConnected) return;
    mask.remove();
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };

  const mask = document.createElement("div");
  mask.className = "modal-mask";
  const box = document.createElement("div");
  box.className = "modal" + (opts.xwide ? " xwide" : opts.wide ? " wide" : "");

  const head = document.createElement("header");
  head.appendChild(document.createTextNode(opts.title));
  head.appendChild(makeSpacer());

  const content = document.createElement("div");
  content.className = "content";
  content.appendChild(typeof opts.body === "function" ? opts.body(close) : opts.body);

  box.appendChild(head);
  box.appendChild(content);

  if (opts.actions?.length) {
    const foot = document.createElement("footer");
    foot.appendChild(makeSpacer());
    for (const a of opts.actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn " + (a.variant ?? "outline");
      b.textContent = a.label;
      b.addEventListener("click", () => a.onClick(close));
      foot.appendChild(b);
    }
    box.appendChild(foot);
    // 主按钮聚焦，回车即可确认
    const first = foot.querySelector(".btn.primary") as HTMLButtonElement | null;
    window.setTimeout(() => first?.focus(), 30);
  } else {
    window.setTimeout(() => box.querySelector("button")?.focus(), 30);
  }

  mask.appendChild(box);
  mask.addEventListener("mousedown", (e) => {
    if (e.target === mask && opts.closeOnMask) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(mask);

  // 暴露关闭按钮到标题栏（右上角的 × 由调用方按需加 actions）
  return close;
}

function makeSpacer(): HTMLElement {
  const s = document.createElement("div");
  s.className = "spacer";
  return s;
}

/** 通用确认框：只有有破坏性后果时才用它 */
export function confirmDialog(title: string, detail: string, confirmLabel = "确定", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    modal({
      title,
      body: (() => {
        const p = document.createElement("div");
        p.className = "hint";
        p.style.fontSize = "12.5px";
        p.style.lineHeight = "1.75";
        p.textContent = detail;
        return p;
      })(),
      actions: [
        {
          label: confirmLabel,
          variant: danger ? "danger" : "primary",
          onClick: (close) => {
            decided = true;
            close();
            resolve(true);
          }
        },
        { label: "取消", variant: "ghost", onClick: (close) => close() }
      ],
      onClose: () => {
        if (!decided) resolve(false);
      }
    });
  });
}

// ---------------- 右键菜单 ----------------

export interface MenuItem {
  label?: string;
  hint?: string;
  key?: string;
  disabled?: boolean;
  divider?: boolean;
  onClick?: () => void;
}

let openMenu: HTMLElement | null = null;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

export function contextMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  for (const it of items) {
    if (it.divider) {
      menu.appendChild(document.createElement("hr"));
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    if (it.disabled) b.disabled = true;
    b.appendChild(document.createTextNode(it.label ?? ""));
    if (it.key) {
      const k = document.createElement("span");
      k.className = "key";
      k.textContent = it.key;
      b.appendChild(k);
    }
    if (it.hint) b.title = it.hint;
    b.addEventListener("click", () => {
      closeMenu();
      it.onClick?.();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  // 贴边修正：菜单超出视口时向内收
  const r = menu.getBoundingClientRect();
  const mx = Math.min(x, window.innerWidth - r.width - 6);
  const my = Math.min(y, window.innerHeight - r.height - 6);
  menu.style.left = Math.max(4, mx) + "px";
  menu.style.top = Math.max(4, my) + "px";
  openMenu = menu;

  const onDown = (e: MouseEvent) => {
    if (openMenu && !openMenu.contains(e.target as Node)) {
      closeMenu();
      document.removeEventListener("mousedown", onDown, true);
    }
  };
  window.setTimeout(() => document.addEventListener("mousedown", onDown, true), 0);
}
