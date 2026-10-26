/**
 * DOM 构建工具。
 *
 * 为什么不用前端框架：编辑器需要 60fps 的画布重绘与大量高频 DOM 更新，
 * 引入框架要额外处理它的重渲染时机，反而更难控制。
 * 这里用最朴素的 createElement + 显式更新，行为完全可预期。
 *
 * 全部 API 都返回真实元素，不做虚拟 DOM，不藏状态。
 */

type Attrs = Record<string, unknown>;
type Child = Node | string | number | null | undefined | false;

/** 创建元素：el("div", { class: "card" }, "文字", 子元素) */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

export function applyAttrs(node: HTMLElement, attrs?: Attrs | null): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class" || k === "className") {
      node.className = String(v);
    } else if (k === "style" && typeof v === "object") {
      Object.assign(node.style, v as Partial<CSSStyleDeclaration>);
    } else if (k === "dataset" && typeof v === "object") {
      Object.assign(node.dataset, v as Record<string, string>);
    } else if (k === "text") {
      node.textContent = String(v);
    } else if (k === "html") {
      node.innerHTML = String(v);
    } else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "value" && node instanceof HTMLInputElement) {
      node.value = String(v);
    } else if (v === true) {
      node.setAttribute(k, "");
    } else {
      node.setAttribute(k, String(v));
    }
  }
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === "object" ? (c as Node) : document.createTextNode(String(c)));
  }
}

/** 清空子节点（比 innerHTML="" 更快，且不会丢事件监听器引用） */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 创建一个 SVG 图标。路径数据集中在 icons.ts。 */
export function svg(pathD: string, size = 15, cls = "glyph"): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.8");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("class", cls);
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", pathD);
  s.appendChild(p);
  return s;
}

// ---------------- 常用控件 ----------------

export interface BtnOpts {
  variant?: "default" | "primary" | "ghost" | "outline" | "danger";
  size?: "md" | "sm";
  iconPath?: string;
  title?: string;
  className?: string;
  disabled?: boolean;
}

export function button(label: string, onClick: () => void, opts: BtnOpts = {}): HTMLButtonElement {
  const cls = [
    "btn",
    opts.variant && opts.variant !== "default" ? opts.variant : "",
    opts.size === "sm" ? "sm" : "",
    opts.className ?? ""
  ].filter(Boolean).join(" ");
  const b = el("button", { class: cls, type: "button", title: opts.title });
  if (opts.iconPath) append(b, [svg(opts.iconPath)]);
  if (label) append(b, [label]);
  if (opts.disabled) b.disabled = true;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** 纯图标按钮（工具栏用），激活态由调用方设置 class="active" */
export function iconButton(iconPath: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { class: "btn icon", type: "button", title });
  b.appendChild(svg(iconPath));
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

export interface FieldOpts {
  placeholder?: string;
  numeric?: boolean;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  onChange?: (value: string, valid: boolean) => void;
  /** 失焦或回车时才提交；输入过程中只做轻校验 */
  commitOnBlur?: boolean;
  width?: string;
}

/**
 * 输入框。
 *
 * 容错纪律（对应"用户乱操作也不炸"）：
 * - 数值框在输入过程中不改数据、不弹窗；"-" / "." / 空 都视为"还在打字"；
 * - 只有失焦或回车才提交；非法值回退到上一次合法值并短暂标红；
 * - 永远不因为输入非法而丢掉用户原本的数据。
 */
export function input(initial: string, opts: FieldOpts = {}): HTMLInputElement {
  const i = el("input", {
    class: "input",
    type: "text",
    value: initial,
    placeholder: opts.placeholder ?? "",
    title: opts.hint ?? ""
  });
  if (opts.width) i.style.width = opts.width;
  if (opts.numeric) i.dataset.numeric = "1";

  let last = initial;
  const invalid = () => {
    i.classList.add("invalid");
    window.setTimeout(() => i.classList.remove("invalid"), 620);
  };

  const parseOk = (v: string): boolean => {
    if (!opts.numeric) return true;
    const t = v.trim();
    if (t === "" || t === "-" || t === "." || t === "-.") return false;
    const n = Number(t);
    return Number.isFinite(n);
  };

  const commit = () => {
    const v = i.value;
    if (!parseOk(v)) {
      if (v.trim() !== "" && v.trim() !== "-") invalid();
      i.value = last;
      opts.onChange?.(last, true);
      return;
    }
    last = v;
    opts.onChange?.(v, true);
  };

  if (opts.numeric) {
    i.addEventListener("input", () => {
      // 打字过程中只标记非法，不改值、不打断
      if (i.value.trim() !== "" && !parseOk(i.value)) invalid();
    });
  } else if (!opts.commitOnBlur) {
    i.addEventListener("input", () => opts.onChange?.(i.value, true));
  }

  i.addEventListener("blur", commit);
  i.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      (e as KeyboardEvent).preventDefault();
      commit();
      i.blur();
    }
  });
  return i;
}

export interface SelectOpts {
  hint?: string;
  width?: string;
  onChange?: (value: string) => void;
}

export function select(
  options: { value: string; label: string }[],
  current: string,
  opts: SelectOpts = {}
): HTMLSelectElement {
  const s = el("select", { class: "select", title: opts.hint ?? "" });
  if (opts.width) s.style.width = opts.width;
  for (const o of options) {
    const opt = el("option", { value: o.value }, o.label);
    if (o.value === current) opt.selected = true;
    s.appendChild(opt);
  }
  s.addEventListener("change", () => opts.onChange?.(s.value));
  return s;
}

export function switchToggle(on: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
  const t = el("div", { class: "switch" + (on ? " on" : ""), title: hint ?? "", role: "switch", tabindex: "0" });
  t.setAttribute("aria-checked", on ? "true" : "false");
  const flip = () => {
    const next = !t.classList.contains("on");
    t.classList.toggle("on", next);
    t.setAttribute("aria-checked", next ? "true" : "false");
    onChange(next);
  };
  t.addEventListener("click", (e) => {
    e.stopPropagation();
    flip();
  });
  t.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === " " || k === "Enter") {
      e.preventDefault();
      flip();
    }
  });
  return t;
}

export function segmented<T extends string>(
  items: { value: T; label: string; hint?: string }[],
  current: T,
  onChange: (v: T) => void
): HTMLElement {
  const box = el("div", { class: "segmented" });
  for (const it of items) {
    const b = el("button", {
      class: it.value === current ? "active" : "",
      type: "button",
      title: it.hint ?? ""
    }, it.label);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      Array.from(box.children).forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      onChange(it.value);
    });
    box.appendChild(b);
  }
  return box;
}

/** 属性行：左标签 + 右控件（Unity Inspector 的标准排布） */
export function fieldRow(label: string, control: Node, hint?: string): HTMLElement {
  const lab = el("label", { title: hint ?? "" }, label);
  return el("div", { class: "field-row" }, lab, control);
}

export function card(title: string, body: Node, tools?: Node[]): HTMLElement {
  const head = el("header");
  head.appendChild(el("span", null, title));
  head.appendChild(el("div", { class: "spacer" }));
  if (tools) for (const t of tools) head.appendChild(t);
  return el("div", { class: "card" }, head, el("div", { class: "body" }, body));
}

/** 数字步进器：输入框 + +/- 微调，适合频繁微调的数值参数。 */
export interface StepperOpts {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  width?: string;
  hint?: string;
}

export function stepper(opts: StepperOpts): HTMLElement {
  const wrap = el("div", { class: "stepper" });
  const i = el("input", {
    class: "input stepper-input",
    type: "text",
    value: String(opts.value),
    title: opts.hint ?? ""
  });
  if (opts.width) i.style.width = opts.width;

  const step = opts.step ?? 1;
  let last = opts.value;
  const clamp = (v: number) => {
    if (opts.min !== undefined && v < opts.min) v = opts.min;
    if (opts.max !== undefined && v > opts.max) v = opts.max;
    return v;
  };

  const commit = () => {
    const t = i.value.trim();
    const n = t === "" || t === "-" || t === "." || t === "-." ? last : Number(t);
    if (!Number.isFinite(n)) {
      i.value = String(last);
      return;
    }
    const next = clamp(Math.round(n / step) * step);
    if (next !== last) {
      last = next;
      i.value = numText(next);
      opts.onChange(next);
    } else {
      i.value = numText(last);
    }
  };

  const delta = (d: number) => {
    const next = clamp(Math.round((last + d * step) / step) * step);
    if (next !== last) {
      last = next;
      i.value = numText(next);
      opts.onChange(next);
    }
  };

  i.addEventListener("blur", commit);
  i.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { commit(); i.blur(); }
    if (e.key === "ArrowUp") { e.preventDefault(); delta(+1); }
    if (e.key === "ArrowDown") { e.preventDefault(); delta(-1); }
  });

  const minus = button("−", () => delta(-1), { size: "sm", variant: "ghost", title: "减小" });
  const plus = button("＋", () => delta(+1), { size: "sm", variant: "ghost", title: "增大" });

  wrap.appendChild(minus);
  wrap.appendChild(i);
  wrap.appendChild(plus);
  return wrap;
}

/** 滑块 + 数值框组合：双向绑定，适合有明确 min/max 的参数。 */
export interface SliderOpts {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  width?: string;
  hint?: string;
}

export function sliderWithInput(opts: SliderOpts): HTMLElement {
  const wrap = el("div", { class: "slider-row" });
  const step = opts.step ?? 1;
  const inputEl = el("input", {
    class: "input slider-input",
    type: "text",
    value: numText(opts.value),
    title: opts.hint ?? ""
  });
  if (opts.width) inputEl.style.width = opts.width;

  const range = el("input", {
    class: "slider",
    type: "range",
    min: String(opts.min),
    max: String(opts.max),
    step: String(step),
    value: String(opts.value)
  });

  let last = opts.value;
  const commit = () => {
    const t = inputEl.value.trim();
    const n = t === "" ? last : Number(t);
    if (!Number.isFinite(n)) { inputEl.value = String(last); return; }
    const next = Math.max(opts.min, Math.min(opts.max, n));
    if (next !== last) {
      last = next;
      inputEl.value = numText(next);
      range.value = String(next);
      opts.onChange(next);
    } else {
      inputEl.value = numText(last);
    }
  };

  inputEl.addEventListener("blur", commit);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { commit(); inputEl.blur(); }
  });
  range.addEventListener("input", () => {
    const v = Number(range.value);
    if (Number.isFinite(v) && v !== last) {
      last = v;
      inputEl.value = numText(v);
      opts.onChange(v);
    }
  });

  wrap.appendChild(range);
  wrap.appendChild(inputEl);
  return wrap;
}

/** 参数重置按钮：小图标，点击恢复默认值。 */
export function paramResetButton(onReset: () => void, title = "重置为默认值"): HTMLElement {
  const b = el("button", {
    type: "button",
    class: "btn icon sm",
    title
  });
  b.appendChild(svg("M12 5v14m0 0l-6-6m6 6 6-6", 12));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onReset();
  });
  return b;
}

/** 空状态：一句话说明 + 一个立刻可点的动作，绝不留白屏 */
export function emptyState(iconPath: string, title: string, desc: string, action?: HTMLElement): HTMLElement {
  const box = el("div", { class: "empty" });
  const svgEl = svg(iconPath, 30, "icon");
  box.appendChild(svgEl);
  box.appendChild(el("div", { class: "t" }, title));
  box.appendChild(el("div", { class: "d" }, desc));
  if (action) box.appendChild(action);
  return box;
}

export interface TextareaOpts {
  placeholder?: string;
  hint?: string;
  rows?: number;
  onChange?: (value: string) => void;
}

export function textarea(initial: string, opts: TextareaOpts = {}): HTMLTextAreaElement {
  const t = el("textarea", {
    class: "textarea",
    placeholder: opts.placeholder ?? "",
    title: opts.hint ?? ""
  });
  t.value = initial;
  if (opts.rows) t.rows = opts.rows;
  t.addEventListener("input", () => opts.onChange?.(t.value));
  return t;
}

// ---------------- 拖拽 ----------------

export const DND_ASSET = "application/x-bwe-asset";
export const DND_MODULE = "application/x-bwe-module";
export const DND_OBJECT = "application/x-bwe-object";

export function makeDraggable(node: HTMLElement, mime: string, getPayload: () => string): void {
  node.draggable = true;
  node.addEventListener("dragstart", (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (!dt) return;
    const payload = getPayload();
    dt.setData(mime, payload);
    dt.setData("text/plain", payload);
    dt.effectAllowed = "copy";
  });
}

// ---------------- 其他 ----------------

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 数字格式化：整数不带小数点 */
export function numText(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let t = 0;
  return (...args: Parameters<T>) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
