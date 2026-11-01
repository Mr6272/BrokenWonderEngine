/**
 * 玩法模块的「试玩」渲染器。
 *
 * 编辑器本身只负责摆场景，真正把这些玩法模块跑起来的是这里：
 *   - game.minesweeper：完整扫雷（首击安全、插旗、连锁展开、计时、胜负）
 *   - game.dressup / game.dressPart：把部件对象组织成衣橱并换装
 *
 * 这里刻意不碰工程数据：试玩只改内存里的临时状态，关掉预览即还原。
 */

import type { ModuleInstance, Project, SceneModel, SceneObject } from "../core/model.ts";
import { loadFrame } from "../data/assets.ts";
import { button, el } from "../core/dom.ts";

export type MinigameType = "minesweeper" | "dressup";

export interface MinigameHit {
  type: MinigameType;
  obj: SceneObject;
  mod: ModuleInstance;
}

/** 找到当前场景里第一个可试玩的玩法模块。 */
export function detectMinigame(scene: SceneModel): MinigameHit | null {
  for (const obj of scene.objects) {
    for (const mod of obj.modules) {
      if (!mod.enabled) continue;
      if (mod.defId === "game.minesweeper") return { type: "minesweeper", obj, mod };
    }
  }
  for (const obj of scene.objects) {
    for (const mod of obj.modules) {
      if (!mod.enabled) continue;
      if (mod.defId === "game.dressup") return { type: "dressup", obj, mod };
    }
  }
  return null;
}

export interface MinigameRun {
  dispose: () => void;
}

interface RunCtx {
  project: Project;
  scene: SceneModel;
  obj: SceneObject;
  mod: ModuleInstance;
  onConfigure?: () => void;
}

// ---------------- 通用小工具 ----------------

function textOf(mod: ModuleInstance, key: string, def = ""): string {
  return mod.values[key] ?? def;
}

function numOf(mod: ModuleInstance, key: string, def: number): number {
  const n = Number(mod.values[key]);
  return Number.isFinite(n) ? n : def;
}

function boolOf(mod: ModuleInstance, key: string, def: boolean): boolean {
  const v = (mod.values[key] ?? "").trim().toLowerCase();
  if (!v) return def;
  return v === "开" || v === "true" || v === "1" || v === "yes" || v === "on";
}

function splitList(raw: string): string[] {
  return raw.split(/[,，|、]/).map((s) => s.trim()).filter(Boolean);
}

const urlCache = new Map<string, Promise<string | null>>();

/** 把素材转成可直接放进 <img>/background 的 data URL（只读，不改工程）。 */
function assetDataUrl(project: Project, name: string): Promise<string | null> {
  const key = (name ?? "").trim();
  if (!key) return Promise.resolve(null);
  const asset = project.assets.find((a) => a.name === key || a.id === key);
  if (!asset) return Promise.resolve(null);
  // 缓存按素材 id 而不是名字：不同工程可以有同名素材，内容并不一样。
  const hit = urlCache.get(asset.id);
  if (hit) return hit;
  const job = (async () => {
    const frame = await loadFrame(asset, 0);
    if (!frame) return null;
    const c = document.createElement("canvas");
    c.width = Math.max(1, frame.width);
    c.height = Math.max(1, frame.height);
    const g = c.getContext("2d");
    if (!g) return null;
    g.imageSmoothingEnabled = false;
    g.drawImage(frame.bitmap as CanvasImageSource, 0, 0);
    try {
      return c.toDataURL("image/png");
    } catch {
      return null;
    }
  })();
  urlCache.set(asset.id, job);
  return job;
}

function configureButton(ctx: RunCtx): HTMLElement | null {
  if (!ctx.onConfigure) return null;
  return button("调整参数", () => ctx.onConfigure?.(), { size: "sm", variant: "outline" });
}

// ---------------- 复雷加殊（Complexweeper）规则 ----------------
//
// 唯一事实来源：docs/complexweeper-rules.md。
// 这里的函数刻意**不碰 DOM、不碰 TS 运行时状态**，因为 `web/tools/verify-complexweeper.mjs`
// 会把本模块用 esbuild 打进一个临时 bundle 再直接 import 它们，跟 Java 侧的
// `ComplexMineRulesTest` 读同一份 `test/fixtures/complexweeper.json` 做三方交叉验证。
// 所以规则只能写在这里一份，`renderMinesweeper` 内部必须调用它们，不许另抄一遍。

/** 雷值编码：0 无雷，1 = +1，2 = −1，3 = +i，4 = −i（与 Java 侧 `ComplexRules` 一致）。 */
export function complexKindValue(kind: number): { re: number; im: number } {
  if (kind === 1) return { re: 1, im: 0 };
  if (kind === 2) return { re: -1, im: 0 };
  if (kind === 3) return { re: 0, im: 1 };
  if (kind === 4) return { re: 0, im: -1 };
  return { re: 0, im: 0 };
}

/** 一组雷值之和（8 邻域的累加规则，规则文档第 2 节）。 */
export function complexSum(kinds: readonly number[]): { re: number; im: number } {
  let re = 0;
  let im = 0;
  for (const kind of kinds) {
    const v = complexKindValue(kind);
    re += v.re;
    im += v.im;
  }
  return { re, im };
}

/**
 * 棋盘几何：第 i 格的 8 邻格下标（越界即跳过，不 wrap）。
 * 浏览器试玩的 `neighbors()` 与 `complexBoardSums()` 都走这一份，避免两套几何。
 */
export function complexNeighborIndices(i: number, cols: number, rows: number): number[] {
  const r = Math.floor(i / cols);
  const c = i % cols;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      out.push(rr * cols + cc);
    }
  }
  return out;
}

/**
 * 全盘邻域统计（规则文档第 2 节）：counts = 邻雷数，sumRe/sumIm = 邻雷值之和。
 * 普通模式下 kinds 全是 1 或 0，因此 sumRe 恒等于 counts、sumIm 恒为 0 —— 数字与今天完全一致。
 * 这是浏览器渲染数字与自动展开的唯一数据来源，Node 验证脚本会直接调用它。
 */
export function complexBoardSums(
  cols: number,
  rows: number,
  kinds: readonly number[]
): { counts: number[]; sumRe: number[]; sumIm: number[] } {
  const total = cols * rows;
  const counts = new Array<number>(total).fill(0);
  const sumRe = new Array<number>(total).fill(0);
  const sumIm = new Array<number>(total).fill(0);
  for (let i = 0; i < total; i++) {
    if (!kinds[i]) continue;
    const v = complexKindValue(kinds[i]);
    for (const n of complexNeighborIndices(i, cols, rows)) {
      counts[n]++;
      sumRe[n] += v.re;
      sumIm[n] += v.im;
    }
  }
  return { counts, sumRe, sumIm };
}

/** 模长显示：n = re²+im² 是完全平方数 → 十进制整数；否则 `√n`。 */
export function complexLabel(re: number, im: number): string {
  const n = re * re + im * im;
  // 整数判定：由 Math.round 得到 r 后自乘回比，避免 Number.isInteger(Math.sqrt(n)) 的浮点误差。
  const r = Math.round(Math.sqrt(n));
  if (r * r === n) return String(r);
  return "\u221a" + n;
}

/** chord 的「虚实比例」判定（规则文档第 4 节 ②）：交叉相乘，任一成立即可，不做除法。 */
export function complexRatioOk(fR: number, fI: number, aR: number, aI: number): boolean {
  return fR * aI === fI * aR || fR * aR === fI * aI;
}

/** 复雷模式的自动展开：只有周围真实雷为 0（sumRe 与 sumIm 都为 0）才展开，规则文档第 5 节。 */
export function complexAutoOpen(sumRe: number, sumIm: number): boolean {
  return sumRe === 0 && sumIm === 0;
}

/** 一个邻格在 chord 时的状态：雷值种类 + 是否已插旗。 */
export interface ComplexNeighbor {
  kind: number;
  flagged: boolean;
}

export interface ComplexChordVerdict {
  ok: boolean;
  flagged: number;
  fR: number;
  fI: number;
  aR: number;
  aI: number;
}

/** chord 判定（规则文档第 4 节 ①②）：旗数必须等于真实雷数，且虚实比例必须对上。 */
export function complexChordOk(neighbors: readonly ComplexNeighbor[]): ComplexChordVerdict {
  let flagged = 0;
  let fR = 0;
  let fI = 0;
  let aR = 0;
  let aI = 0;
  for (const n of neighbors) {
    const isReal = n.kind === 1 || n.kind === 2;
    const isImag = n.kind === 3 || n.kind === 4;
    if (isReal) aR++;
    else if (isImag) aI++;
    if (n.flagged) {
      flagged++;
      if (isReal) fR++;
      else if (isImag) fI++;
    }
  }
  return {
    ok: flagged === aR + aI && complexRatioOk(fR, fI, aR, aI),
    flagged,
    fR,
    fI,
    aR,
    aI
  };
}

/** 雷种类小标注的文案（规则文档第 1 节 + 第 9 节）。 */
export function complexKindName(kind: number): string {
  if (kind === 1) return "+1";
  if (kind === 2) return "−1";
  if (kind === 3) return "+i";
  if (kind === 4) return "−i";
  return "";
}

/** 雷种类小标注的颜色：实雷红/蓝，虚雷紫/青（与视频配色一致）。 */
export function complexKindColor(kind: number): string {
  if (kind === 1) return "#e5484d";
  if (kind === 2) return "#2f64d8";
  if (kind === 3) return "#8a4fa8";
  if (kind === 4) return "#2aa198";
  return "#5a6478";
}

/** 带根号数字的配色：√2 青、√5 深绿、√8 蓝、√10 紫、其它灰蓝（规则文档第 9 节）。 */
export function complexRootColor(n: number): string {
  if (n === 2) return "#2aa198";
  if (n === 5) return "#1f8a4c";
  if (n === 8) return "#2f64d8";
  if (n === 10) return "#8a4fa8";
  return "#5a6478";
}

// ---------------- 扫雷 ----------------

interface MineCell {
  root: HTMLDivElement;
  ico: HTMLSpanElement;
  /** 复雷模式下判负/通关亮雷时的种类小标注（+1/−1/+i/−i）；普通模式永不创建。 */
  kind: HTMLSpanElement | null;
}

export function renderMinesweeper(host: HTMLElement, ctx: RunCtx): MinigameRun {
  const mod = ctx.mod;
  const rows = Math.max(3, Math.min(40, Math.round(numOf(mod, "rows", 10))));
  const cols = Math.max(3, Math.min(40, Math.round(numOf(mod, "cols", 10))));
  const wantMines = Math.max(1, Math.round(numOf(mod, "mines", 10)));
  const cellSize = Math.max(16, Math.min(64, Math.round(numOf(mod, "cellSize", 32))));
  const firstClickSafe = boolOf(mod, "firstClickSafe", true);
  const rightClickFlag = boolOf(mod, "rightClickFlag", true);
  const autoOpenZeros = boolOf(mod, "autoOpenZeros", true);
  const revealAllOnLose = boolOf(mod, "revealAllOnLose", true);
  const showTimer = boolOf(mod, "showTimer", true);
  const flagWin = /插对|flag/i.test(textOf(mod, "winCondition", ""));
  const seed = Math.round(numOf(mod, "seed", 0));
  const total = rows * cols;
  const mineCap = Math.max(1, total - 1);

  // 玩法模式：模块参数可能还没声明（`textOf` 会退到 ""），按「字段不存在 = 普通模式」处理。
  // 解析口径与 docs/complexweeper-rules.md 第 8 节、Java 侧 `m.str("mode", ...)` 完全一致。
  let complex = /复雷|complex/i.test(textOf(mod, "mode", ""));

  let mines: boolean[] = new Array(total).fill(false);
  let counts: number[] = new Array(total).fill(0);
  // 复雷模式的附加模型（普通模式：mineKind 恒 0/1，sumRe 恒等于 counts，sumIm 恒 0）。
  let mineKind: number[] = new Array(total).fill(0);
  let sumRe: number[] = new Array(total).fill(0);
  let sumIm: number[] = new Array(total).fill(0);
  let revealed: boolean[] = new Array(total).fill(false);
  let flagged: boolean[] = new Array(total).fill(false);
  let mineCount = Math.min(wantMines, mineCap);
  let flags = 0;
  let started = false;
  let over = false;
  let won = false;
  let flagMode = false;
  let elapsed = 0;
  let timerId: number | null = null;
  let assetUrls = { tile: "", mine: "", flag: "" };

  const wrap = el("div", { class: "mg-shell mg-minesweeper" });
  const head = el("div", { class: "mg-head" });
  const titleBox = el("div", { class: "mg-titlebox" });
  titleBox.appendChild(el("div", { class: "mg-title" }, "扫雷 · Minesweeper"));
  const subLine = el("div", { class: "mg-sub" }, "");
  titleBox.appendChild(subLine);
  head.appendChild(titleBox);
  head.appendChild(el("div", { class: "spacer" }));

  const mineLeft = el("span", { class: "mg-chip" });
  const timeChip = el("span", { class: "mg-chip" });
  head.appendChild(mineLeft);
  head.appendChild(timeChip);

  const flagBtn = button("🚩 标记模式：关", () => {
    flagMode = !flagMode;
    flagBtn.textContent = `🚩 标记模式：${flagMode ? "开" : "关"}`;
    flagBtn.classList.toggle("primary", flagMode);
  }, { size: "sm", variant: "outline" });
  // 模式按钮：只在浏览器试玩里切换玩法，不改工程数据（关掉预览即还原）。
  const modeBtn = button("", () => {
    complex = !complex;
    reset();
  }, { size: "sm", variant: "outline" });
  const restartBtn = button("重新开始", () => reset(), { size: "sm", variant: "primary" });
  head.appendChild(modeBtn);
  head.appendChild(flagBtn);
  head.appendChild(restartBtn);
  const cfg = configureButton(ctx);
  if (cfg) head.appendChild(cfg);
  wrap.appendChild(head);

  const status = el("div", { class: "mg-status" });
  wrap.appendChild(status);

  const boardWrap = el("div", { class: "mg-board-wrap" });
  const board = el("div", { class: "mg-board" });
  board.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
  board.style.setProperty("--mg-cell", `${cellSize}px`);
  board.style.fontSize = `${Math.max(11, Math.round(cellSize * 0.46))}px`;
  const cells: MineCell[] = [];
  for (let i = 0; i < total; i++) {
    const root = el("div", { class: "mg-cell", role: "button", tabindex: "0" });
    root.dataset.index = String(i);
    const ico = el("span", { class: "mg-ico" });
    root.appendChild(ico);
    // 复雷模式的雷种类标注：默认不建、不占位，只有真的需要时才 createElement，
    // 这样普通模式的 DOM 结构与今天逐节点一致（零回归）。
    const activate = (wantFlag: boolean) => {
      if (over) return;
      if (wantFlag) toggleFlag(i);
      else if (complex && revealed[i]) chord(i);
      else reveal(i);
    };
    root.addEventListener("click", () => activate(flagMode));
    root.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (rightClickFlag) activate(true);
    });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate(flagMode);
      }
    });
    board.appendChild(root);
    cells.push({ root, ico, kind: null });
  }
  boardWrap.appendChild(board);
  wrap.appendChild(boardWrap);

  const foot = el("div", { class: "mg-foot" });
  const footHint = el("span", { class: "hint" }, "");
  foot.appendChild(footHint);
  wrap.appendChild(foot);
  host.appendChild(wrap);

  function rngFactory(): () => number {
    if (!seed) return Math.random;
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 复雷模式的雷种类小标注：按需创建，普通模式永不创建。 */
  function ensureKindTag(cell: MineCell): HTMLSpanElement {
    if (!cell.kind) {
      const tag = el("span", { class: "mg-kind" });
      // 行内定位：样式表里没有 .mg-kind（本任务允许改的只有本文件），
      // 所以小标注的定位/字号全部走行内，避免依赖尚不存在的 CSS 规则。
      tag.style.position = "absolute";
      tag.style.right = "2px";
      tag.style.bottom = "0";
      tag.style.fontSize = `${Math.max(9, Math.round(cellSize * 0.3))}px`;
      tag.style.fontWeight = "800";
      tag.style.lineHeight = "1";
      tag.style.pointerEvents = "none";
      cell.root.appendChild(tag);
      cell.kind = tag;
    }
    cell.kind.style.display = "";
    return cell.kind;
  }

  function hideKindTag(cell: MineCell): void {
    if (cell.kind) {
      cell.kind.style.display = "none";
      cell.kind.textContent = "";
    }
  }

  function neighbors(i: number): number[] {
    return complexNeighborIndices(i, cols, rows);
  }

  function placeMines(safeIndex: number): void {
    const blocked = new Set<number>();
    if (firstClickSafe) {
      blocked.add(safeIndex);
      for (const n of neighbors(safeIndex)) blocked.add(n);
    }
    let candidates: number[] = [];
    for (let i = 0; i < total; i++) if (!blocked.has(i)) candidates.push(i);
    if (candidates.length < mineCount) {
      // 首击保护把可埋雷区压得太小：退回到全盘（除了点击格）。
      candidates = [];
      for (let i = 0; i < total; i++) if (i !== safeIndex) candidates.push(i);
    }
    const rand = rngFactory();
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    mineCount = Math.min(mineCount, candidates.length);
    mines = new Array(total).fill(false);
    mineKind = new Array(total).fill(0);
    for (let k = 0; k < mineCount; k++) {
      const idx = candidates[k];
      mines[idx] = true;
      // 普通模式雷值恒为 +1；复雷模式每颗雷独立取 4 种之一（同一个 rand，seed 一致时同盘可复现）。
      mineKind[idx] = complex ? 1 + Math.floor(rand() * 4) : 1;
    }
    counts = new Array(total).fill(0);
    sumRe = new Array(total).fill(0);
    sumIm = new Array(total).fill(0);
    const sums = complexBoardSums(cols, rows, mineKind);
    counts = sums.counts;
    sumRe = sums.sumRe;
    sumIm = sums.sumIm;
  }

  function startTimer(): void {
    if (!showTimer || timerId !== null) return;
    timerId = window.setInterval(() => {
      elapsed++;
      updateStatus();
    }, 1000);
  }

  function stopTimer(): void {
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
  }

  function updateStatus(): void {
    subLine.textContent = `${cols} 列 × ${rows} 行 · ${mineCount} 颗地雷${complex ? " · 复雷加殊" : ""}`;
    modeBtn.textContent = `模式：${complex ? "复雷加殊" : "普通"}`;
    modeBtn.classList.toggle("primary", complex);
    modeBtn.title = complex ? "当前：复雷加殊（点击切回普通）" : "当前：普通（点击切到复雷加殊）";
    wrap.classList.toggle("mg-complex", complex);
    footHint.textContent = complex
      ? "左键翻开 · 点数字连锁翻开 · 右键插旗（旗不带属性）"
      : "左键翻开 · 右键插旗 · 触屏可开「标记模式」";
    mineLeft.textContent = `💣 ${Math.max(0, mineCount - flags)}`;
    timeChip.textContent = showTimer ? `⏱ ${elapsed}s` : "⏱ —";
    mineLeft.title = "剩余地雷 = 总雷数 - 已插旗";
    timeChip.title = showTimer ? "从第一次翻开开始计时" : "计时器已关闭";
    if (won) status.textContent = `🎉 通关！用时 ${elapsed} 秒`;
    else if (over) status.textContent = "💥 踩到地雷了，点「重新开始」再来一局";
    else if (!started) {
      status.textContent = complex
        ? "雷有 +1/−1/+i/−i 四种；数字 = 周围雷之和的模长。点任意格子开始"
        : firstClickSafe
          ? "点任意格子开始；第一次点开的区域一定安全"
          : "点任意格子开始；首击保护已关闭，第一下也可能踩雷";
    } else {
      status.textContent = complex
        ? "点数字可连锁翻开（需旗数与真实雷数相同、且虚实比例对上）"
        : flagMode ? "标记模式：点击格子插旗 / 取消旗" : "继续翻开安全格";
    }
    status.className = "mg-status" + (won ? " win" : over ? " lose" : "");
  }

  function draw(): void {
    for (let i = 0; i < total; i++) {
      const { root, ico } = cells[i];
      root.className = "mg-cell";
      ico.className = "mg-ico";
      ico.textContent = "";
      ico.style.backgroundImage = "";
      ico.style.color = "";
      ico.style.fontSize = "";
      root.style.backgroundImage = "";
      root.dataset.n = "";
      root.removeAttribute("aria-label");
      hideKindTag(cells[i]);
      if (over && revealAllOnLose && mines[i]) {
        revealed[i] = true;
      }
      if (!revealed[i]) {
        root.classList.add("hidden");
        if (assetUrls.tile) root.style.backgroundImage = `url("${assetUrls.tile}")`;
        if (flagged[i]) {
          root.classList.add("flagged");
          if (assetUrls.flag) ico.style.backgroundImage = `url("${assetUrls.flag}")`;
          else ico.textContent = "🚩";
          root.setAttribute("aria-label", `第 ${i + 1} 格，已插旗`);
        } else {
          root.setAttribute("aria-label", `第 ${i + 1} 格，未翻开`);
        }
      } else if (mines[i]) {
        root.classList.add("open", "mine");
        if (assetUrls.mine) ico.style.backgroundImage = `url("${assetUrls.mine}")`;
        else ico.textContent = "💣";
        if (complex) {
          // 复雷模式额外标出这颗雷的种类；普通模式不建这个节点，DOM 与今天一致。
          const tag = ensureKindTag(cells[i]);
          tag.textContent = complexKindName(mineKind[i]);
          tag.style.color = complexKindColor(mineKind[i]);
          root.setAttribute("aria-label", `第 ${i + 1} 格，地雷 ${complexKindName(mineKind[i])}`);
        } else {
          root.setAttribute("aria-label", `第 ${i + 1} 格，地雷`);
        }
      } else {
        root.classList.add("open");
        if (complex) {
          const re = sumRe[i];
          const im = sumIm[i];
          const label = complexLabel(re, im);
          const n = re * re + im * im;
          const isInt = label.charCodeAt(0) !== 0x221a;
          if (isInt) {
            // 整数沿用现有 data-n 配色（与普通模式同一条 CSS 通道）。
            root.dataset.n = label;
            ico.textContent = label;
          } else {
            // 带根号：data-n 清空，改走行内 color（CSS 里没有 √k 的配色）。
            ico.textContent = label;
            ico.style.color = complexRootColor(n);
            ico.style.fontSize = `${Math.max(9, Math.round(cellSize * 0.32))}px`;
          }
          root.setAttribute("aria-label", `第 ${i + 1} 格，周围雷之和 ${label}`);
        } else if (counts[i] > 0) {
          root.dataset.n = String(counts[i]);
          ico.textContent = String(counts[i]);
          root.setAttribute("aria-label", `第 ${i + 1} 格，周围 ${counts[i]} 颗雷`);
        } else {
          root.setAttribute("aria-label", `第 ${i + 1} 格，安全`);
        }
      }
    }
    updateStatus();
  }

  /** 自动展开判定：普通模式看 counts，复雷模式只有在周围真实雷为 0 时才展开。 */
  function isEmptyCell(i: number): boolean {
    return complex ? complexAutoOpen(sumRe[i], sumIm[i]) : counts[i] === 0;
  }

  function reveal(start: number): void {
    if (over || revealed[start] || flagged[start]) return;
    if (!started) {
      started = true;
      placeMines(start);
      startTimer();
    }
    const stack = [start];
    while (stack.length) {
      const i = stack.pop() as number;
      if (revealed[i] || flagged[i]) continue;
      revealed[i] = true;
      if (mines[i]) {
        lose();
        return;
      }
      if (isEmptyCell(i) && autoOpenZeros) {
        for (const n of neighbors(i)) {
          if (!revealed[n] && !flagged[n]) stack.push(n);
        }
      }
    }
    draw();
    checkWin();
  }

  /**
   * 复雷模式的 chord（规则文档第 4 节）：点已翻开的数字格，若旗数与真实雷数相同、
   * 且虚实比例对上，就把它周围所有未插旗未翻开的格子挨个走同一条 reveal 路径。
   * 判定不通过时什么都不做 —— 绝不为了「帮玩家」而提前踩雷判负。
   */
  function chord(idx: number): void {
    if (!complex || over || !revealed[idx]) return;
    const around = neighbors(idx);
    const verdict = complexChordOk(around.map((n) => ({ kind: mineKind[n], flagged: flagged[n] })));
    if (!verdict.ok) return;
    for (const n of around) {
      if (flagged[n] || revealed[n]) continue;
      reveal(n);
    }
    draw();
    checkWin();
  }

  function toggleFlag(i: number): void {
    if (over || revealed[i]) return;
    if (!started) {
      // 插旗不算开始，避免玩家用插旗探雷。
    }
    flagged[i] = !flagged[i];
    flags += flagged[i] ? 1 : -1;
    draw();
    checkWin();
  }

  function lose(): void {
    over = true;
    won = false;
    stopTimer();
    draw();
  }

  function checkWin(): void {
    if (over || !started) return;
    let ok = false;
    if (flagWin) {
      ok = flags === mineCount && mines.every((m, i) => !m || flagged[i]);
    } else {
      ok = mines.every((m, i) => m || revealed[i]);
    }
    if (!ok) return;
    over = true;
    won = true;
    stopTimer();
    if (!flagWin && over) {
      for (let i = 0; i < total; i++) if (mines[i]) flagged[i] = true;
      flags = mineCount;
    }
    draw();
  }

  function reset(): void {
    stopTimer();
    mines = new Array(total).fill(false);
    counts = new Array(total).fill(0);
    mineKind = new Array(total).fill(0);
    sumRe = new Array(total).fill(0);
    sumIm = new Array(total).fill(0);
    revealed = new Array(total).fill(false);
    flagged = new Array(total).fill(false);
    flags = 0;
    started = false;
    over = false;
    won = false;
    elapsed = 0;
    mineCount = Math.min(wantMines, mineCap);
    draw();
  }

  // 贴图是异步加载的，加载完成后重绘一次即可。
  void assetDataUrl(ctx.project, textOf(mod, "hiddenAsset")).then((u) => {
    assetUrls.tile = u ?? "";
    draw();
  });
  void assetDataUrl(ctx.project, textOf(mod, "mineAsset")).then((u) => {
    assetUrls.mine = u ?? "";
    draw();
  });
  void assetDataUrl(ctx.project, textOf(mod, "flagAsset")).then((u) => {
    assetUrls.flag = u ?? "";
    draw();
  });

  reset();

  return {
    dispose: () => {
      stopTimer();
      wrap.remove();
    }
  };
}

// ---------------- 换装 ----------------

interface DressPart {
  obj: SceneObject;
  mod: ModuleInstance;
  slot: string;
  options: string[];
  assets: string[];
  defaults: string;
  fallbackColor: string;
  offsetX: number;
  offsetY: number;
  scale: number;
}

function readPart(obj: SceneObject, mod: ModuleInstance): DressPart {
  const options = splitList(textOf(mod, "options", "造型 A,造型 B"));
  const assets = splitList(textOf(mod, "optionAssets"));
  const def = Math.max(0, Math.min(options.length - 1, Math.round(numOf(mod, "defaultIndex", 0))));
  return {
    obj,
    mod,
    slot: textOf(mod, "slot", "其他 Other"),
    options: options.length ? options : ["造型 A"],
    assets,
    defaults: String(def),
    fallbackColor: textOf(mod, "fallbackColor", "#4c8dff"),
    offsetX: numOf(mod, "offsetX", 0),
    offsetY: numOf(mod, "offsetY", 0),
    scale: Math.max(0.1, Math.min(4, numOf(mod, "partScale", 1)))
  };
}

function slotShape(slot: string): string {
  if (/发型|hair/i.test(slot)) return "shape-hair";
  if (/上装|top|dress/i.test(slot)) return "shape-top";
  if (/下装|bottom|pants|skirt/i.test(slot)) return "shape-bottom";
  if (/鞋|shoe|boot/i.test(slot)) return "shape-shoes";
  if (/配饰|access/i.test(slot)) return "shape-acc";
  if (/身体|body/i.test(slot)) return "shape-body";
  if (/脸|face/i.test(slot)) return "shape-face";
  return "shape-box";
}

export function renderDressup(host: HTMLElement, ctx: RunCtx): MinigameRun {
  const ctrl = ctx.mod;
  const tag = textOf(ctrl, "partTag", "").trim();
  const persist = boolOf(ctrl, "persist", false);
  const allowReset = boolOf(ctrl, "allowReset", true);
  const showTabs = boolOf(ctrl, "showTabs", true);
  const stageWidth = Math.max(200, Math.min(2000, Math.round(numOf(ctrl, "stageWidth", 640))));
  const stageHeight = Math.max(150, Math.min(2000, Math.round(numOf(ctrl, "stageHeight", 480))));
  const fit = /cover|铺满/i.test(textOf(ctrl, "fit", "")) ? "cover" : "contain";
  const storeKey = `bwe.preview.dressup.${ctx.project.name}.${ctx.scene.name}`;

  const parts = ctx.scene.objects
    .filter((o) => o.visible && o.modules.some((m) => m.enabled && m.defId === "game.dressPart"))
    .filter((o) => !tag || o.tags.includes(tag))
    .map((o) => readPart(o, o.modules.find((m) => m.enabled && m.defId === "game.dressPart") as ModuleInstance))
    .sort((a, b) => (a.obj.z - b.obj.z) || (ctx.scene.objects.indexOf(a.obj) - ctx.scene.objects.indexOf(b.obj)));

  const wrap = el("div", { class: "mg-shell mg-dressup" });
  const head = el("div", { class: "mg-head" });
  const titleBox = el("div", { class: "mg-titlebox" });
  titleBox.appendChild(el("div", { class: "mg-title" }, textOf(ctrl, "title", "换装间")));
  titleBox.appendChild(el("div", { class: "mg-sub" }, `${parts.length} 个可换部位 · 点标签页切换`));
  head.appendChild(titleBox);
  head.appendChild(el("div", { class: "spacer" }));
  const resetBtn = allowReset
    ? button("穿回默认", () => {
      for (const p of parts) selected.set(p.obj.id, Number(p.defaults));
      persistNow();
      applyAll();
      renderOptions();
    }, { size: "sm", variant: "outline" })
    : null;
  if (resetBtn) head.appendChild(resetBtn);
  const cfg = configureButton(ctx);
  if (cfg) head.appendChild(cfg);
  wrap.appendChild(head);

  if (!parts.length) {
    wrap.appendChild(el("div", { class: "mg-empty" }, "场景里还没有「换装部件」。给角色各部位挂上 game.dressPart 模块后再试。"));
    host.appendChild(wrap);
    return { dispose: () => wrap.remove() };
  }

  const content = el("div", { class: "mg-dress-body" });
  const stage = el("div", { class: "mg-stage" });
  stage.style.width = `min(100%, ${stageWidth}px)`;
  stage.style.aspectRatio = `${stageWidth} / ${stageHeight}`;
  content.appendChild(stage);

  // 舞台背景
  const bgUrl = textOf(ctrl, "backgroundAsset");
  void assetDataUrl(ctx.project, bgUrl).then((url) => {
    if (!url) return;
    stage.style.backgroundImage = `url("${url}")`;
    stage.style.backgroundSize = fit;
  });

  const mapW = Math.max(1, ctx.scene.widthTiles * ctx.project.tileSize);
  const mapH = Math.max(1, ctx.scene.heightTiles * ctx.project.tileSize);
  const layerEls: Array<{
    part: DressPart;
    box: HTMLDivElement;
    img: HTMLImageElement;
    fallback: HTMLDivElement;
    token: number;
  }> = [];

  for (const part of parts) {
    const box = el("div", { class: "mg-part " + slotShape(part.slot), title: part.obj.name || part.slot });
    const px = part.obj.x + part.offsetX;
    const py = part.obj.y + part.offsetY;
    const pw = part.obj.halfW > 0 ? part.obj.halfW * 2 : 80;
    const ph = part.obj.halfH > 0 ? part.obj.halfH * 2 : 80;
    box.style.left = `${(px / mapW) * 100}%`;
    box.style.top = `${(py / mapH) * 100}%`;
    box.style.width = `${(pw / mapW) * 100}%`;
    box.style.height = `${(ph / mapH) * 100}%`;
    box.style.transform = `translate(-50%, -50%) scale(${part.scale})`;
    box.style.zIndex = String(10 + part.obj.z);
    const img = el("img", { class: "mg-part-img", alt: "", draggable: "false" });
    const fallback = el("div", { class: "mg-part-fallback" });
    fallback.style.background = part.fallbackColor || "#4c8dff";
    box.appendChild(fallback);
    box.appendChild(img);
    stage.appendChild(box);
    layerEls.push({ part, box, img, fallback, token: 0 });
  }

  const tabsHost = el("div", { class: "mg-tabs" });
  const optionsHost = el("div", { class: "mg-options" });
  const side = el("div", { class: "mg-wardrobe" });
  if (showTabs) side.appendChild(tabsHost);
  side.appendChild(optionsHost);
  content.appendChild(side);
  wrap.appendChild(content);

  const foot = el("div", { class: "mg-foot" });
  foot.appendChild(el("span", { class: "hint" }, "切换标签页 → 点造型。素材名在「模块编辑器 → 换装部件」里改。"));
  wrap.appendChild(foot);
  host.appendChild(wrap);

  const selected = new Map<string, number>();
  for (const p of parts) {
    let pick = Number(p.defaults);
    if (persist) {
      try {
        const raw = localStorage.getItem(storeKey);
        if (raw) {
          const saved = JSON.parse(raw) as Record<string, number>;
          if (typeof saved[p.obj.id] === "number") pick = saved[p.obj.id];
        }
      } catch { /* 本地存储不可用时忽略 */ }
    }
    selected.set(p.obj.id, Math.max(0, Math.min(p.options.length - 1, pick)));
  }
  let active = 0;

  function currentAsset(p: DressPart): string {
    const idx = selected.get(p.obj.id) ?? 0;
    return p.assets[idx] ?? "";
  }

  function applyLayer(entry: (typeof layerEls)[number]): void {
    const idx = selected.get(entry.part.obj.id) ?? 0;
    const assetName = entry.part.assets[idx] ?? "";
    const token = ++entry.token;
    if (!assetName) {
      entry.img.style.display = "none";
      entry.fallback.style.display = "block";
      entry.fallback.style.background = entry.part.fallbackColor || "#4c8dff";
      entry.fallback.textContent = idx < entry.part.options.length ? "" : "";
      return;
    }
    void assetDataUrl(ctx.project, assetName).then((url) => {
      if (token !== entry.token) return;
      if (!url) {
        entry.img.style.display = "none";
        entry.fallback.style.display = "block";
        entry.fallback.style.background = entry.part.fallbackColor || "#4c8dff";
        return;
      }
      entry.img.src = url;
      entry.img.style.display = "block";
      entry.fallback.style.display = "none";
    });
  }

  function applyAll(): void {
    for (const entry of layerEls) applyLayer(entry);
    persistNow();
  }

  function persistNow(): void {
    if (!persist) return;
    try {
      const data: Record<string, number> = {};
      for (const [k, v] of selected) data[k] = v;
      localStorage.setItem(storeKey, JSON.stringify(data));
    } catch { /* 忽略隐私模式等写入失败 */ }
  }

  function renderTabs(): void {
    tabsHost.replaceChildren();
    parts.forEach((p, i) => {
      const b = el("button", { class: "mg-tab" + (i === active ? " active" : ""), type: "button" }, p.slot);
      b.addEventListener("click", () => {
        active = i;
        renderTabs();
        renderOptions();
      });
      tabsHost.appendChild(b);
    });
  }

  function renderOptions(): void {
    optionsHost.replaceChildren();
    const part = parts[active];
    if (!part) return;
    const headRow = el("div", { class: "mg-options-head" });
    headRow.appendChild(el("div", { class: "group-label" }, part.slot));
    headRow.appendChild(el("div", { class: "spacer" }));
    headRow.appendChild(el("span", { class: "hint" }, `${part.options.length} 套`));
    optionsHost.appendChild(headRow);
    const grid = el("div", { class: "mg-option-grid" });
    const chosen = selected.get(part.obj.id) ?? 0;
    part.options.forEach((name, idx) => {
      const assetName = part.assets[idx] ?? "";
      const b = el("button", { class: "mg-option" + (idx === chosen ? " active" : ""), type: "button" });
      const thumb = el("div", { class: "mg-opt-thumb " + slotShape(part.slot) });
      thumb.style.background = part.fallbackColor || "#4c8dff";
      if (assetName) {
        void assetDataUrl(ctx.project, assetName).then((url) => {
          if (url) {
            thumb.style.background = `#141824 url("${url}") center / contain no-repeat`;
          }
        });
      }
      b.appendChild(thumb);
      b.appendChild(el("span", { class: "mg-opt-name" }, name));
      b.addEventListener("click", () => {
        selected.set(part.obj.id, idx);
        applyAll();
        renderOptions();
      });
      grid.appendChild(b);
    });
    optionsHost.appendChild(grid);
  }

  renderTabs();
  renderOptions();
  applyAll();

  return { dispose: () => wrap.remove() };
}
