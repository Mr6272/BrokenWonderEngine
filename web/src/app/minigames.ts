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

// ---------------- 扫雷 ----------------

interface MineCell {
  root: HTMLDivElement;
  ico: HTMLSpanElement;
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

  let mines: boolean[] = new Array(total).fill(false);
  let counts: number[] = new Array(total).fill(0);
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
  titleBox.appendChild(el("div", { class: "mg-sub" }, `${cols} 列 × ${rows} 行 · ${mineCount} 颗地雷`));
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
  const restartBtn = button("重新开始", () => reset(), { size: "sm", variant: "primary" });
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
    const activate = (wantFlag: boolean) => {
      if (over) return;
      if (wantFlag) toggleFlag(i);
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
    cells.push({ root, ico });
  }
  boardWrap.appendChild(board);
  wrap.appendChild(boardWrap);

  const foot = el("div", { class: "mg-foot" });
  foot.appendChild(el("span", { class: "hint" }, "左键翻开 · 右键插旗 · 触屏可开「标记模式」"));
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

  function neighbors(i: number): number[] {
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
    for (let k = 0; k < mineCount; k++) mines[candidates[k]] = true;
    counts = new Array(total).fill(0);
    for (let i = 0; i < total; i++) {
      if (!mines[i]) continue;
      for (const n of neighbors(i)) counts[n]++;
    }
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
    mineLeft.textContent = `💣 ${Math.max(0, mineCount - flags)}`;
    timeChip.textContent = showTimer ? `⏱ ${elapsed}s` : "⏱ —";
    mineLeft.title = "剩余地雷 = 总雷数 - 已插旗";
    timeChip.title = showTimer ? "从第一次翻开开始计时" : "计时器已关闭";
    if (won) status.textContent = `🎉 通关！用时 ${elapsed} 秒`;
    else if (over) status.textContent = "💥 踩到地雷了，点「重新开始」再来一局";
    else if (!started) status.textContent = firstClickSafe
      ? "点任意格子开始；第一次点开的区域一定安全"
      : "点任意格子开始；首击保护已关闭，第一下也可能踩雷";
    else status.textContent = flagMode ? "标记模式：点击格子插旗 / 取消旗" : "继续翻开安全格";
    status.className = "mg-status" + (won ? " win" : over ? " lose" : "");
  }

  function draw(): void {
    for (let i = 0; i < total; i++) {
      const { root, ico } = cells[i];
      const isHidden = !revealed[i];
      root.className = "mg-cell";
      ico.className = "mg-ico";
      ico.textContent = "";
      ico.style.backgroundImage = "";
      root.style.backgroundImage = "";
      root.dataset.n = "";
      root.removeAttribute("aria-label");
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
        root.setAttribute("aria-label", `第 ${i + 1} 格，地雷`);
      } else {
        root.classList.add("open");
        if (counts[i] > 0) {
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
      if (counts[i] === 0 && autoOpenZeros) {
        for (const n of neighbors(i)) {
          if (!revealed[n] && !flagged[n]) stack.push(n);
        }
      }
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
