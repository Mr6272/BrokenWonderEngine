import { readFileSync, writeFileSync } from "node:fs";

// ---------- api.ts: textinput 命名空间 ----------
{
  const p = "web/src/webplayer/api.ts";
  let s = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const before = s;
  if (s.includes("textinputNs")) { console.log("already"); }
  else {
    // import
    if (!s.includes('from "./textinput"')) {
      s = s.replace(
        'import { MineBoard, type MineOptions } from "./mine";',
        'import { MineBoard, type MineOptions } from "./mine";\nimport { TextInputManager } from "./textinput";',
      );
    }
    // 从 UNIMPLEMENTED 名单里去掉 textinput
    s = s.replace('"stick", "textinput", "spatial",', '"stick", "spatial",');

    const anchor = "  // ---------- bwe.mine：引擎侧托管的扫雷板 ----------";
    if (!s.includes(anchor)) { console.error("anchor miss"); process.exit(1); }
    const block = `  // ---------- bwe.textinput：真的浮一个 <input> 在画布上 ----------
  // Java 侧桌面读物理键盘、Android 弹软键盘；浏览器里最接近的等价物是真实 input 元素。
  const ti = new TextInputManager(ctx.canvas);
  ctx.textInput = ti;
  const textinputNs = {
    define(id: unknown, value: unknown, min: unknown, max: unknown, numeric?: unknown): void {
      ti.define(String(id ?? ""), String(value ?? ""), Number(min) || 0, Number(max) || 0, numeric === undefined ? true : !!numeric);
    },
    rect(id: unknown, nx: unknown, ny: unknown, nw: unknown, nh: unknown): void {
      ti.rect(String(id ?? ""), Number(nx) || 0, Number(ny) || 0, Number(nw) || 0, Number(nh) || 0);
    },
    value(id: unknown): string { return ti.value(String(id ?? "")); },
    number(id: unknown, dflt?: unknown): number { return ti.number(String(id ?? ""), Number(dflt) || 0); },
    setValue(id: unknown, text: unknown): void { ti.setValue(String(id ?? ""), String(text ?? "")); },
    active(): string { return ti.active(); },
    cancel(): void { ti.cancel(); },
    hint(id: unknown): string { return ti.hint(String(id ?? "")); },
    refreshHints(): void { ti.refreshHints(); },
    onSubmit(fn: unknown): void {
      if (typeof fn !== "function") return;
      ti.onSubmit(fn as (id: string, text: string) => void);
    },
    get editing(): string { return ti.editing; },
  };
  (bwe as Record<string, unknown>).textinput = textinputNs;
  report.ok.push("textinput.define/rect/value/number/setValue/active/cancel/hint/onSubmit");

`;
    s = s.replace(anchor, block + anchor);
  }
  if (s === before) { console.error("api no change"); process.exit(1); }
  writeFileSync(p, s, "utf8");
  console.log("textinput shim:", s.includes("textinputNs"));
}
