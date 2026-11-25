/**
 * bwe.textinput 的 Web 实现：真的弹一个 <input> 浮在画布上。
 *
 * Java 侧（ScriptTextInput）桌面端读物理键盘、Android 弹系统软键盘；浏览器里
 * 最接近的等价物就是一个绝对定位的真实 input：能唤起移动端软键盘、能选中复制，
 * 也能走 IME。不做自绘假输入框（那在中文输入法下会坏）。
 *
 * 坐标约定：脚本传的是**归一化坐标**（x / baseW, y / viewH, ...），相对画布。
 */

export interface Field {
  id: string;
  text: string;
  min: number;
  max: number;
  numeric: boolean;
  /** 归一化矩形；未调用 rect() 前为 null，此时不显示 */
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  placed: boolean;
}

type SubmitFn = (id: string, text: string) => void;

export class TextInputManager {
  private fields = new Map<string, Field>();
  private el: HTMLInputElement | null = null;
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement;
  private submitFn: SubmitFn | null = null;
  private activeId: string | null = null;
  /** 提示文案（例如「1-999」），脚本用 hint(id) 取回去自绘在框里 */
  private hints = new Map<string, string>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.host = canvas.parentElement;
  }

  get editing(): string {
    return this.activeId ?? "";
  }

  define(id: string, value: string, min: number, max: number, numeric: boolean): void {
    const f = this.fields.get(id) ?? {
      id, text: "", min: 0, max: 0, numeric: true, nx: 0, ny: 0, nw: 0, nh: 0, placed: false,
    };
    f.text = String(value ?? "");
    f.min = min;
    f.max = max;
    f.numeric = numeric;
    this.fields.set(id, f);
    this.refreshHints();
    if (this.activeId === id && this.el) this.el.value = f.text;
  }

  rect(id: string, nx: number, ny: number, nw: number, nh: number): void {
    const f = this.fields.get(id);
    if (!f) return;
    f.nx = nx; f.ny = ny; f.nw = nw; f.nh = nh;
    f.placed = true;
    if (this.activeId === id) this.positionInput();
  }

  value(id: string): string {
    const f = this.fields.get(id);
    if (!f) return "";
    if (this.activeId === id && this.el) return this.el.value;
    return f.text;
  }

  number(id: string, dflt = 0): number {
    const raw = this.value(id);
    const n = parseInt(String(raw).replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : dflt;
  }

  setValue(id: string, text: string): void {
    const f = this.fields.get(id);
    if (!f) return;
    f.text = String(text ?? "");
    if (this.activeId === id && this.el) this.el.value = f.text;
    this.refreshHints();
  }

  hint(id: string): string {
    return this.hints.get(id) ?? "";
  }

  active(): string {
    return this.activeId ?? "";
  }

  onSubmit(fn: SubmitFn): void {
    this.submitFn = fn;
  }

  cancel(): void {
    if (!this.activeId) return;
    this.commitAndClose(false);
  }

  /** 脚本在 draw 里调用，用来把「范围提示」等信息同步给宿主 */
  refreshHints(): void {
    for (const [id, f] of this.fields) {
      if (f.min > 0 || f.max > 0) {
        this.hints.set(id, `${f.min}-${f.max}`);
      } else if (f.numeric) {
        this.hints.set(id, "数字");
      } else {
        this.hints.set(id, "");
      }
    }
  }

  /** 画布尺寸变了要重排当前输入框 */
  relayout(): void {
    if (this.activeId) this.positionInput();
  }

  /**
   * 点击落到某个已定义的输入框上就激活它。
   * 返回 true 表示这次点击被输入框消费。
   */
  tryActivate(worldToCanvasX: number, worldToCanvasY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const u = worldToCanvasX - rect.left;
    const v = worldToCanvasY - rect.top;
    const W = rect.width;
    const H = rect.height;
    for (const f of this.fields.values()) {
      if (!f.placed) continue;
      const x = f.nx * W;
      const y = f.ny * H;
      const w = f.nw * W;
      const h = f.nh * H;
      if (u >= x && u <= x + w && v >= y && v <= y + h) {
        this.activate(f.id);
        return true;
      }
    }
    // 点到别处：提交并关掉当前输入
    if (this.activeId) this.commitAndClose(true);
    return false;
  }

  private activate(id: string): void {
    const f = this.fields.get(id);
    if (!f) return;
    if (this.activeId && this.activeId !== id) this.commitAndClose(true);
    this.activeId = id;
    if (!this.el || !this.el.isConnected) {
      const el = document.createElement("input");
      el.type = f.numeric ? "tel" : "text";
      if (f.numeric) el.inputMode = "numeric";
      el.autocomplete = "off";
      el.spellcheck = false;
      el.style.position = "absolute";
      el.style.zIndex = "10";
      el.style.boxSizing = "border-box";
      el.style.margin = "0";
      el.style.padding = "0 4px";
      el.style.border = "2px solid #3b9eff";
      el.style.borderRadius = "3px";
      el.style.background = "#fff";
      el.style.color = "#111";
      el.style.font = "600 14px/1.2 monospace";
      el.style.outline = "none";
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.commitAndClose(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.commitAndClose(false);
        }
        // 别让键盘事件冒到画布去（移动/开火之类的绑定会误触）
        e.stopPropagation();
      });
      el.addEventListener("input", () => {
        if (!f.numeric) return;
        const cleaned = el.value.replace(/[^\d-]/g, "");
        if (cleaned !== el.value) el.value = cleaned;
      });
      (this.host ?? document.body).style.position ||= "relative";
      (this.host ?? document.body).appendChild(el);
      this.el = el;
    }
    this.el.type = f.numeric ? "tel" : "text";
    this.el.inputMode = f.numeric ? "numeric" : "text";
    this.el.value = f.text;
    this.positionInput();
    this.el.focus();
    this.el.select();
  }

  private positionInput(): void {
    if (!this.el || !this.activeId) return;
    const f = this.fields.get(this.activeId);
    if (!f || !f.placed) return;
    const rect = this.canvas.getBoundingClientRect();
    const hostRect = (this.host ?? document.body).getBoundingClientRect();
    this.el.style.left = `${f.nx * rect.width + (rect.left - hostRect.left)}px`;
    this.el.style.top = `${f.ny * rect.height + (rect.top - hostRect.top)}px`;
    this.el.style.width = `${Math.max(24, f.nw * rect.width)}px`;
    this.el.style.height = `${Math.max(16, f.nh * rect.height)}px`;
    this.el.style.display = "block";
  }

  private commitAndClose(submit: boolean): void {
    const id = this.activeId;
    if (!id) return;
    const f = this.fields.get(id);
    if (f) {
      let text = this.el ? this.el.value : f.text;
      if (f.numeric) {
        text = text.replace(/[^\d-]/g, "");
        if (f.max > 0) {
          const n = parseInt(text, 10);
          if (Number.isFinite(n) && n > f.max) text = String(f.max);
        }
        if (f.min > 0) {
          const n = parseInt(text, 10);
          if (Number.isFinite(n) && n < f.min) text = String(f.min);
        }
      }
      f.text = text;
    }
    if (this.el) {
      this.el.blur();
      this.el.style.display = "none";
    }
    this.activeId = null;
    if (submit && f && this.submitFn) {
      try {
        this.submitFn(f.id, f.text);
      } catch (e) {
        console.error("[BWE/Web] textinput.onSubmit 回调抛错:", e);
      }
    }
  }
}
