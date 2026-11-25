/**
 * bwe.mine 的 Web 实现：扫雷板规则 + 绘制
 *
 * Java 侧 bwe.mine 由引擎托管（棋盘、规则、绘制都在 Minesweeper.java / GridPainter.java 里），
 * 脚本只读 state() 并下发 set()/reset()。所以 Web 播放器不能只做一个抛错占位，
 * 否则扫雷脚本每帧读 state() 都是 undefined，直接崩。
 *
 * 本文件是 Minesweeper.java 规则部分的行为移植（不是逐行翻译）：
 *   - 首击必安全：firstClickSafe 时布雷避开首点及其 8 邻域
 *   - 自动展开：autoOpenZeros 时 0 格连锁翻开
 *   - 和弦：点已翻开的数字，旗数与数字相等时翻开周围
 *   - 胜负：清空所有安全格 / 全部雷被正确标记（按 winCondition）
 *
 * 绘制诚实边界：Web 端用 2D canvas 画等价简化版（色块 + 数字 + 旗 + 雷），
 * 不复刻 Java 用 hiddenAsset/mineAsset/flagAsset 逐格贴图的观感。规则等价，像素不保证一致。
 */

export interface MineOptions {
  rows?: number | string;
  cols?: number | string;
  mines?: number | string;
  cellSize?: number | string;
  mode?: string;
  winCondition?: string;
  firstClickSafe?: string | boolean;
  rightClickFlag?: string | boolean;
  autoOpenZeros?: string | boolean;
  revealAllOnLose?: string | boolean;
  showTimer?: string | boolean;
  seed?: string | number;
  hiddenAsset?: string;
  mineAsset?: string;
  flagAsset?: string;
}

export interface MineState {
  rows: number;
  cols: number;
  mines: number;
  flags: number;
  /** Java 侧 state() 同时给 mode 字符串和 modeIndex。脚本读的是 mode。 */
  mode: string;
  modeIndex: number;
  over: boolean;
  won: boolean;
  /** 踩雷结束（over 且没赢）。HUD 用它判断失败。 */
  hitMine: boolean;
  started: boolean;
  elapsed: number;
  revealed: number;
  cellSize: number;
}

const on = (v: string | boolean | undefined, dflt = true): boolean => {
  if (typeof v === "boolean") return v;
  if (v === undefined) return dflt;
  const s = String(v).trim().toLowerCase();
  if (["0", "false", "off", "no", ""].includes(s)) return false;
  return true;
};

/** 确定性随机（mulberry32）。seed = 0 表示每局真随机。 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MineBoard {
  rows = 16;
  cols = 16;
  mineCount = 40;
  cellSize = 32;
  modeIndex = 0;
  winByFlags = false;

  firstClickSafe = true;
  rightClickFlag = true;
  autoOpenZeros = true;
  revealAllOnLose = true;
  showTimer = true;
  seed = 0;

  private mine: Uint8Array = new Uint8Array(0);
  private open: Uint8Array = new Uint8Array(0);
  private flag: Uint8Array = new Uint8Array(0);
  private count: Uint8Array = new Uint8Array(0);

  private started = false;
  private over = false;
  private won = false;
  private startedAt = 0;
  private elapsedMs = 0;

  private rng: () => number = Math.random;
  private canvas: HTMLCanvasElement | null = null;
  private dirty = true;
  private seeded = false;

  constructor(opts: MineOptions = {}) {
    this.configure(opts);
    this.reset();
  }

  configure(opts: MineOptions): void {
    let changed = false;
    const int = (v: string | number | undefined, d: number) => {
      const n = typeof v === "number" ? v : parseInt(String(v === undefined ? "" : v), 10);
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    if (opts.rows !== undefined) {
      const v = Math.max(2, Math.min(512, int(opts.rows, this.rows)));
      if (v !== this.rows) { this.rows = v; changed = true; }
    }
    if (opts.cols !== undefined) {
      const v = Math.max(2, Math.min(512, int(opts.cols, this.cols)));
      if (v !== this.cols) { this.cols = v; changed = true; }
    }
    if (opts.mines !== undefined) {
      const max = Math.max(1, this.rows * this.cols - 9);
      const v = Math.max(1, Math.min(max, int(opts.mines, this.mineCount)));
      if (v !== this.mineCount) { this.mineCount = v; changed = true; }
    }
    if (opts.cellSize !== undefined) {
      const v = Math.max(4, Math.min(128, int(opts.cellSize, this.cellSize)));
      if (v !== this.cellSize) { this.cellSize = v; changed = true; }
    }
    if (opts.winCondition !== undefined) {
      const s = String(opts.winCondition);
      const f = /flag|标记|旗/i.test(s) && /all|全部/i.test(s);
      if (f !== this.winByFlags) { this.winByFlags = f; changed = true; }
    }
    if (opts.mode !== undefined) {
      const idx = /complex|复/i.test(String(opts.mode)) ? 1 : 0;
      if (idx !== this.modeIndex) { this.modeIndex = idx; changed = true; }
    }
    if (opts.firstClickSafe !== undefined) this.firstClickSafe = on(opts.firstClickSafe, true);
    if (opts.rightClickFlag !== undefined) this.rightClickFlag = on(opts.rightClickFlag, true);
    if (opts.autoOpenZeros !== undefined) this.autoOpenZeros = on(opts.autoOpenZeros, true);
    if (opts.revealAllOnLose !== undefined) this.revealAllOnLose = on(opts.revealAllOnLose, true);
    if (opts.showTimer !== undefined) this.showTimer = on(opts.showTimer, true);
    if (opts.seed !== undefined) {
      const n = typeof opts.seed === "number" ? opts.seed : parseInt(String(opts.seed), 10);
      if (Number.isFinite(n) && n !== this.seed) { this.seed = n; this.seeded = n !== 0; }
    }
    if (changed) {
      this.clear();
      this.resetTimer();
      this.dirty = true;
    }
  }

  private idx(r: number, c: number): number {
    return r * this.cols + c;
  }

  private inBounds(r: number, c: number): boolean {
    return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
  }

  private clear(): void {
    const n = this.rows * this.cols;
    this.mine = new Uint8Array(n);
    this.open = new Uint8Array(n);
    this.flag = new Uint8Array(n);
    this.count = new Uint8Array(n);
    this.started = false;
    this.over = false;
    this.won = false;
    this.dirty = true;
  }

  private resetTimer(): void {
    this.startedAt = 0;
    this.elapsedMs = 0;
  }

  reset(): void {
    this.clear();
    this.resetTimer();
    this.rng = this.seeded ? makeRng(this.seed) : Math.random;
    const max = Math.max(1, this.rows * this.cols - 9);
    if (this.mineCount > max) this.mineCount = max;
  }

  get isOver(): boolean {
    return this.over;
  }

  get isWon(): boolean {
    return this.won;
  }

  state(): MineState {
    let flags = 0;
    let revealed = 0;
    for (let i = 0; i < this.flag.length; i++) {
      if (this.flag[i]) flags++;
      if (this.open[i]) revealed++;
    }
    if (this.started && !this.over && !this.won && this.startedAt) {
      this.elapsedMs = Date.now() - this.startedAt;
    }
    return {
      rows: this.rows,
      cols: this.cols,
      mines: this.mineCount,
      flags,
      mode: this.modeIndex === 1 ? "complex" : "normal",
      modeIndex: this.modeIndex,
      over: this.over,
      won: this.won,
      hitMine: this.over && !this.won,
      started: this.started,
      elapsed: +(this.elapsedMs / 1000).toFixed(1),
      revealed,
      cellSize: this.cellSize,
    };
  }

  private placeMines(safeIdx: number): void {
    const n = this.rows * this.cols;
    const forbidden = new Set<number>();
    if (this.firstClickSafe && safeIdx >= 0) {
      const sr = Math.floor(safeIdx / this.cols);
      const sc = safeIdx % this.cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (this.inBounds(sr + dr, sc + dc)) forbidden.add(this.idx(sr + dr, sc + dc));
        }
      }
    }
    const pool: number[] = [];
    for (let i = 0; i < n; i++) if (!forbidden.has(i)) pool.push(i);
    // 候选不够时逐格放宽（保证雷数）
    if (pool.length < this.mineCount) {
      const inPool = new Set(pool);
      for (let i = 0; i < n; i++) if (!inPool.has(i)) pool.push(i);
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      const t = pool[i];
      pool[i] = pool[j];
      pool[j] = t;
    }
    for (let i = 0; i < Math.min(this.mineCount, pool.length); i++) this.mine[pool[i]] = 1;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        let k = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const rr = r + dr;
            const cc = c + dc;
            if (this.inBounds(rr, cc) && this.mine[this.idx(rr, cc)]) k++;
          }
        }
        this.count[this.idx(r, c)] = k;
      }
    }
  }

  private startAt(safeIdx: number): void {
    this.placeMines(safeIdx);
    this.started = true;
    this.startedAt = Date.now();
    this.elapsedMs = 0;
  }

  private openCell(r: number, c: number): boolean {
    if (!this.inBounds(r, c)) return false;
    const i = this.idx(r, c);
    if (this.open[i] || this.flag[i]) return false;
    if (this.mine[i]) {
      this.open[i] = 1;
      this.over = true;
      this.dirty = true;
      return true;
    }
    // 显式栈，避免大棋盘递归爆栈
    const stack: number[] = [i];
    while (stack.length) {
      const k = stack.pop() as number;
      if (this.open[k] || this.flag[k] || this.mine[k]) continue;
      this.open[k] = 1;
      if (this.count[k] !== 0 || !this.autoOpenZeros) continue;
      const kr = Math.floor(k / this.cols);
      const kc = k % this.cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = kr + dr;
          const cc = kc + dc;
          if (!this.inBounds(rr, cc)) continue;
          const ni = this.idx(rr, cc);
          if (!this.open[ni] && !this.flag[ni] && !this.mine[ni]) stack.push(ni);
        }
      }
    }
    this.dirty = true;
    return true;
  }

  private checkWin(): void {
    if (this.over) return;
    if (this.winByFlags) {
      for (let i = 0; i < this.mine.length; i++) {
        if (this.mine[i] && !this.flag[i]) return;
        if (!this.mine[i] && this.flag[i]) return;
      }
      this.won = true;
    } else {
      for (let i = 0; i < this.mine.length; i++) {
        if (!this.mine[i] && !this.open[i]) return;
      }
      this.won = true;
    }
    this.startedAt = 0;
  }

  reveal(r: number, c: number): void {
    if (this.over || this.won) return;
    if (!this.inBounds(r, c)) return;
    const i = this.idx(r, c);
    if (this.flag[i]) return;
    if (!this.started) this.startAt(i);
    if (this.open[i]) {
      // 和弦：旗数 == 数字 时翻开周围
      if (this.count[i] === 0) return;
      let f = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (this.inBounds(rr, cc) && this.flag[this.idx(rr, cc)]) f++;
        }
      }
      if (f !== this.count[i]) return;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          this.openCell(r + dr, c + dc);
        }
      }
    } else {
      this.openCell(r, c);
    }
    if (this.over && this.revealAllOnLose) {
      for (let k = 0; k < this.mine.length; k++) if (this.mine[k]) this.open[k] = 1;
      this.dirty = true;
    }
    this.checkWin();
  }

  toggleFlag(r: number, c: number): void {
    if (this.over || this.won) return;
    if (!this.inBounds(r, c)) return;
    const i = this.idx(r, c);
    if (this.open[i]) return;
    if (!this.started) this.startAt(i);
    this.flag[i] = this.flag[i] ? 0 : 1;
    this.dirty = true;
    this.checkWin();
  }

  /** 世界坐标 -> 格子。cx/cy/halfW/halfH 是棋盘对象在场景里的矩形 */
  cellAt(
    worldX: number,
    worldY: number,
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
  ): { r: number; c: number } | null {
    const x0 = cx - halfW;
    const y0 = cy - halfH;
    const bw = halfW * 2;
    const bh = halfH * 2;
    if (bw <= 0 || bh <= 0) return null;
    const u = (worldX - x0) / bw;
    const v = (worldY - y0) / bh;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    return { r: Math.floor(v * this.rows), c: Math.floor(u * this.cols) };
  }

  /** 画到离屏 canvas（cols*cellSize x rows*cellSize） */
  paint(): HTMLCanvasElement {
    const w = this.cols * this.cellSize;
    const h = this.rows * this.cellSize;
    if (!this.canvas) this.canvas = document.createElement("canvas");
    const cv = this.canvas;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
      this.dirty = true;
    }
    if (!this.dirty) return cv;
    const g = cv.getContext("2d");
    if (!g) return cv;
    const cs = this.cellSize;
    g.fillStyle = "#c0c0c0";
    g.fillRect(0, 0, w, h);

    const DIGIT = ["", "#0000ff", "#008000", "#ff0000", "#000080", "#800000", "#008080", "#000000", "#808080"];

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = this.idx(r, c);
        const x = c * cs;
        const y = r * cs;
        if (this.open[i]) {
          g.fillStyle = this.mine[i] ? "#e8b0b0" : "#d8d8d8";
          g.fillRect(x, y, cs, cs);
          g.strokeStyle = "#a8a8a8";
          g.lineWidth = Math.max(1, cs / 32);
          g.strokeRect(x + 0.5, y + 0.5, cs - 1, cs - 1);
          if (this.mine[i]) {
            g.fillStyle = "#111";
            g.beginPath();
            g.arc(x + cs / 2, y + cs / 2, cs * 0.28, 0, Math.PI * 2);
            g.fill();
          } else if (this.count[i] > 0) {
            g.fillStyle = DIGIT[this.count[i]] || "#000";
            g.font = "bold " + Math.floor(cs * 0.62) + "px monospace";
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(String(this.count[i]), x + cs / 2, y + cs / 2 + cs * 0.04);
          }
        } else {
          g.fillStyle = "#bdbdbd";
          g.fillRect(x, y, cs, cs);
          const b = Math.max(1, cs / 16);
          g.fillStyle = "#e8e8e8";
          g.fillRect(x, y, cs, b);
          g.fillRect(x, y, b, cs);
          g.fillStyle = "#8a8a8a";
          g.fillRect(x, y + cs - b, cs, b);
          g.fillRect(x + cs - b, y, b, cs);
          if (this.flag[i]) {
            g.strokeStyle = "#333";
            g.lineWidth = Math.max(1, cs / 20);
            g.beginPath();
            g.moveTo(x + cs * 0.5, y + cs * 0.2);
            g.lineTo(x + cs * 0.5, y + cs * 0.8);
            g.stroke();
            g.fillStyle = "#d40000";
            g.beginPath();
            g.moveTo(x + cs * 0.5, y + cs * 0.2);
            g.lineTo(x + cs * 0.82, y + cs * 0.35);
            g.lineTo(x + cs * 0.5, y + cs * 0.5);
            g.closePath();
            g.fill();
          }
        }
      }
    }
    this.dirty = false;
    return cv;
  }

  pixelWidth(): number {
    return this.cols * this.cellSize;
  }

  pixelHeight(): number {
    return this.rows * this.cellSize;
  }
}
