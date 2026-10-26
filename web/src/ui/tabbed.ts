/**
 * 标签页容器。
 * 同一时刻只展开一个，避免多面板堆叠把画布挤没。
 */

export interface TabItem {
  id: string;
  label: string;
  hint?: string;
  render: (host: HTMLElement) => void;
  /** 切换到该页时回调（用于刷新数据） */
  onShow?: () => void;
}

export class Tabbed {
  readonly root: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly host: HTMLDivElement;
  private readonly items: TabItem[];
  private active: string;

  constructor(items: TabItem[], initial?: string) {
    this.items = items;
    this.active = initial ?? items[0]?.id ?? "";

    this.root = document.createElement("div");
    this.root.className = "col";
    this.root.style.gap = "0";
    this.root.style.height = "100%";

    this.bar = document.createElement("div");
    this.bar.className = "tabs";

    this.host = document.createElement("div");
    this.host.style.flex = "1";
    this.host.style.minHeight = "0";
    this.host.style.overflow = "auto";

    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label;
      if (it.hint) b.title = it.hint;
      b.dataset.tab = it.id;
      b.addEventListener("click", () => this.show(it.id));
      this.bar.appendChild(b);
    }

    this.root.appendChild(this.bar);
    this.root.appendChild(this.host);
    this.show(this.active);
  }

  show(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    this.active = id;
    for (const b of Array.from(this.bar.children) as HTMLButtonElement[]) {
      b.classList.toggle("active", b.dataset.tab === id);
    }
    this.host.replaceChildren();
    // 每次切换都重新渲染：面板状态来自 store，重渲染成本远低于同步两份状态
    item.render(this.host);
    item.onShow?.();
  }

  current(): string {
    return this.active;
  }

  /** 供外部（快捷键、帮助）跳转到某一页 */
  focus(id: string): void {
    this.show(id);
  }
}
