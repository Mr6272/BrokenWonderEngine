#!/usr/bin/env node
/**
 * 扫雷 UI 功能与手机适配自检（纯脚本层，不开窗口、不跑 Java）。
 *
 * <p>为什么需要它：竖屏工程与横屏工程**共用同一份脚本**，历史上竖屏的 HUD 分支
 * 是另写一套，于是横屏有的（状态行、雷/旗读数、模式说明、范围提示、帮助）竖屏没有，
 * 这类回归靠肉眼看一张截图很容易漏。本工具把脚本放进一个 bwe.* 的 mock 引擎里跑，
 * 用**行为**而不是像素来断言：
 *
 *   1. 功能对等：横屏 / 竖屏都必须存在同一组控件（LED×2、笑脸、三个输入框、
 *      六个步进箭头、新游戏、模式、帮助、状态行、读数、范围提示），
 *      并且逐个点击后**真的改变引擎状态**（rows/cols/mines/mode/help/reset）。
 *   2. 手机可用：所有可点区域 ≥ 34×30 逻辑像素；格子的**屏幕**边长 ≥ 28px。
 *   3. 不互相遮挡：HUD 银灰带不侵入棋盘屏幕矩形；可点区域两两不重叠；绘制落在视口内。
 *   4. 多分辨率：竖屏按 Android 桥接的「短边折成 720 逻辑像素」规则换算
 *      （AndroidRuntimeBridge.resize），覆盖 1080×2400 / 1236×2750 / 1242×2688 /
 *      828×1792 / 750×1624 / 1170×2532；横屏覆盖 1280×720 / 1920×1080 /
 *      2598×1236 / 1024×768 / 2280×1080。
 *
 * 可点区域直接读脚本自己登记的 BTN 表（pushBtn），不靠栈推断 —— 断言的是脚本
 * 真正用来判命中的那批矩形，工具与游戏用的是同一份数据。
 *
 * 用法：
 *   node web/tools/verify-minesweeper-ui.mjs
 *   node web/tools/verify-minesweeper-ui.mjs --json
 *   node web/tools/verify-minesweeper-ui.mjs --only-portrait | --only-landscape
 *
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { decideOrientation } from "./package-bwe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const EX = join(ROOT, "web", "examples");
const JSON_OUT = process.argv.includes("--json");
const ONLY_PORTRAIT = process.argv.includes("--only-portrait");
const ONLY_LAND = process.argv.includes("--only-landscape");

/** 触摸目标下限（逻辑像素）：手机上低于这个值就点不准。 */
const MIN_TOUCH_W = 34, MIN_TOUCH_H = 30;
/**
 * 格子屏幕边长下限：与脚本的 CELL_READABLE 对齐。
 * 64×64 不再追求「整盘可见」——4096 格 ÷ 720px = 每格 11px，看不清也点不准，
 * 所以改成「格子保持可读 + 平移浏览」，装不下是设计而非缺陷。
 */
const MIN_CELL_PX = 28;
/** 工程地图边长（64 瓦片 × tileSize 32 = 2048）：棋盘不得超过它，否则边缘拖不到。 */
const MAP_PX = 64 * 32;

/** 键名归一：脚本可能写 "ArrowRight" / "KeyD" / "d"，测试传哪个都该命中。 */
function normKey(k) {
  const t = String(k);
  if (/^Key[A-Z]$/.test(t)) return t.slice(3).toLowerCase();
  return t.toLowerCase();
}

/** Android 桥接的视口换算：短边固定折成 720 逻辑像素，长边按比例。 */
function androidLogical(physW, physH) {
  const scale = Math.min(physW, physH) / 720;
  const w = Math.round(physW / scale);
  const h = Math.round(w * (physH / physW));
  return { w, h };
}

// ---------------------------------------------------------------------------
//  mock 引擎：只实现脚本用到的部分，语义按 Java 侧对齐
// ---------------------------------------------------------------------------

function makeHarness(project) {
  const scene = project.scenes[0];
  // BWE_MS_MUTANT 是给 verify-minesweeper-layout-checks.mjs（变异测试）用的钩子：
  // 用改坏的脚本文本替换工程里的源码，验证这些布局不变量**真的会红**，
  // 而不是写成永远为真。正常运行不设这个变量。
  const src = process.env.BWE_MS_MUTANT || project.scripts.minesweeper.source;

  const boardObj = scene.objects.find((o) => /棋盘/.test(o.name || ""));
  const mod = boardObj && boardObj.modules && boardObj.modules[0];
  const v = mod?.values || {};
  const st = {
    rows: Number(v.rows || 10), cols: Number(v.cols || 10),
    mines: Number(v.mines || 10), cell: Math.max(16, Math.min(64, Number(v.cellSize || 32))),
    complex: /复雷|complex/i.test(String(v.mode || "")),
    flags: 0, started: false, over: false, won: false, hitMine: false, elapsed: 0,
    resets: 0,
  };

  const view = { zoom: 1, camX: 0, camY: 0, W: 1280, H: 720 };
  const mouse = { x: -1, y: -1 };
  let mousePressedFrame = false;
  let editingId = "";

  const draws = [];
  const heldKeys = new Set();    // frame({keys:["ArrowRight"]}) 按住的键
  const badSetPos = [];          // 记录 bwe.camera.setPos 收到非数字参数的调用
  let setPosCalls = 0;
  const hudBlocks = new Map();   // 脚本用 bwe.input.block 登记的「界面区」
  const fields = new Map();
  const defined = new Map();
  const logs = [];

  function doReset() {
    st.resets++;
    st.flags = 0; st.started = false; st.over = false; st.won = false;
    st.hitMine = false; st.elapsed = 0;
  }
  function hintFor(id) {
    if (!id) return "";
    const d = defined.get(id);
    if (!d) return "";
    const n = Number(d.value);
    if (!isFinite(n) || d.value === "") return "只能填数字";
    if (n < d.min || n > d.max) return "范围 " + d.min + "–" + d.max;
    return "";
  }

  function wrapEntity(o) {
    o.props = o.props || {};
    return {
      get name() { return o.name; },
      get x() { return o.x; },
      get y() { return o.y; },
      prop: (k) => o.props[k],
      setProp: (k, val) => { o.props[k] = String(val); },
      props: () => o.props,
      setPos: (x, y) => { o.x = x; o.y = y; },
    };
  }

  let updateFn = null;
  const bwe = {
    log: (s) => logs.push(String(s)),
    audio: { music: () => 1, play: () => 1, stop: () => null, volume: () => null },
    time: { now: 0, dt: 1 / 60, frame: 0 },
    camera: {
      get size() { return { w: view.W, h: view.H }; },
      get zoom() { return view.zoom; },
      setZoom(z) { view.zoom = Math.max(0.15, Math.min(4, z)); },
      setPos(x, y) {
        // Rhino 侧 setPos 是两个 number 参数；脚本误传数组会取不到数字而退回默认值，
        // 表现为「纵向拖不动」这种最难查的静默失效。这里把它抓出来。
        if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y)) {
          badSetPos.push([x, y]);
          return;
        }
        view.camX = x; view.camY = y; setPosCalls++;
      },
      worldToScreen: (x, y) => ({
        x: view.W / 2 + (x - view.camX) * view.zoom,
        y: view.H / 2 + (y - view.camY) * view.zoom,
      }),
      screenToWorld: (x, y) => ({
        x: view.camX + (x - view.W / 2) / view.zoom,
        y: view.camY + (y - view.H / 2) / view.zoom,
      }),
      setFit() { }, follow() { }, bounds() { }, shake() { },
      get pos() { return { x: view.camX, y: view.camY }; },
    },
    input: {
      get mouse() { return { x: mouse.x, y: mouse.y, worldX: 0, worldY: 0, left: mousePressedFrame }; },
      down(k) {
        const key = String(k).toLowerCase();
        if (key.indexOf("mouse") >= 0) return mousePressedFrame;
        return heldKeys.has(normKey(k));
      },
      pressed(k) {
        const key = String(k).toLowerCase();
        if (key.indexOf("mouse") >= 0) return mousePressedFrame;
        return heldKeys.has(normKey(k));
      },
      released() { return false; },
      axis: () => ({ x: 0, y: 0 }),
      cursor() { },
      block(id, x, y, w, h) {
        if (!id) return false;
        if (!(w > 0) || !(h > 0)) { hudBlocks.delete(id); return false; }
        hudBlocks.set(id, { id, x, y, w, h });
        return true;
      },
      unblock(id) { return hudBlocks.delete(id); },
    },
    world: {
      find(name) {
        const o = scene.objects.find((x) => x.name === name);
        return o ? wrapEntity(o) : null;
      },
      findAll(q) {
        const tag = q && q.tag;
        return scene.objects.filter((o) => !tag || (o.tags || []).indexOf(tag) >= 0).map(wrapEntity);
      },
      emit() { }, on() { }, off() { },
    },
    draw: {
      rect(x, y, w, h, opts) { draws.push({ kind: "rect", x, y, w, h, fill: opts && opts.fill }); },
      text(x, y, s, opts) {
        draws.push({ kind: "text", x, y, s: String(s), size: (opts && opts.size) || 16,
          align: opts && opts.align, color: opts && opts.color });
      },
      measureText(s, size) {
        let em = 0;
        for (const ch of String(s)) em += ch.charCodeAt(0) > 0x2000 ? 1 : 0.55;
        return { w: em * size, h: size * 1.3 };
      },
      circle() { }, line() { }, bar() { }, sprite() { },
    },
    textinput: {
      onSubmit(fn) { bwe.__onSubmit = fn; },
      define(id, value, min, max) { defined.set(id, { value: String(value), min, max }); },
      rect(id, nx, ny, nw, nh) { fields.set(id, { nx, ny, nw, nh }); },
      value(id) { return (defined.get(id) || { value: "" }).value; },
      number(id, fb) { const n = Number(this.value(id)); return isFinite(n) ? n : fb; },
      setValue(id, val) { const d = defined.get(id); if (d) d.value = String(val); },
      active() { return editingId; },
      cancel() { editingId = ""; },
      validate(id) { return hintFor(id); },
      refreshHints() { for (const id of defined.keys()) if (hintFor(id)) return true; return false; },
      hint(id) { return hintFor(id || editingId); },
      get editing() { return editingId || false; },
    },
    mine: {
      set(cfg) {
        if (!cfg) return;
        const before = st.rows + "," + st.cols + "," + st.cell + "," + st.complex;
        if (cfg.rows > 0) st.rows = Math.max(3, Math.min(64, cfg.rows));
        if (cfg.cols > 0) st.cols = Math.max(3, Math.min(64, cfg.cols));
        if (cfg.cellSize > 0) st.cell = Math.max(16, Math.min(64, cfg.cellSize));
        if (cfg.mines > 0) st.mines = cfg.mines;
        if (cfg.mode !== undefined) st.complex = cfg.mode === "complex";
        if (before !== st.rows + "," + st.cols + "," + st.cell + "," + st.complex) doReset();
      },
      reset() { doReset(); },
      state() {
        return {
          rows: st.rows, cols: st.cols, mines: st.mines, flags: st.flags,
          mode: st.complex ? "complex" : "normal", modeIndex: st.complex ? 1 : 0,
          started: st.started, over: st.over, won: st.won, hitMine: st.hitMine,
          elapsed: st.elapsed,
        };
      },
    },
    scene: { switchTo() { }, current: () => scene.name },
    save: { get: () => null, set: () => null },
    on(ev, fn) { if (ev === "update") updateFn = fn; },
    off() { },
  };

  const sandbox = { bwe, Math, Number, String, isFinite, Object, Array, console, JSON };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: "minesweeper.js" });
  const entry = vm.runInContext(
    "typeof onSceneStart === 'function' ? onSceneStart : (typeof onStart === 'function' ? onStart : null)", ctx);
  if (!entry) throw new Error("脚本里没有 onSceneStart / onStart 入口");
  entry.call(undefined, { self: null });
  if (!updateFn) throw new Error("脚本没有通过 bwe.on('update', …) 注册每帧回调");

  /** 跑一帧，返回该帧的绘制 + 脚本登记的 BTN 表。 */
  function frame(opts = {}) {
    draws.length = 0;
    fields.clear();
    mouse.x = opts.mx == null ? -1 : opts.mx;
    mouse.y = opts.my == null ? -1 : opts.my;
    mousePressedFrame = !!opts.tap;
    heldKeys.clear();
    for (const k of (opts.keys || [])) heldKeys.add(normKey(k));
    updateFn(1 / 60);
    const btns = (sandbox.BTN || []).map((b) => ({ ...b }));
    mousePressedFrame = false;
    return { draws: draws.slice(), btns };
  }

  /** 棋盘世界矩形（Java 侧以对象中心绘制棋盘）。相机坐标就在这个空间里。 */
  function boardWorld() {
    return {
      cx: boardObj.x, cy: boardObj.y,
      w: st.cols * st.cell, h: st.rows * st.cell,
    };
  }

  /** 棋盘在屏幕上的矩形（Java 侧以对象中心绘制棋盘）。 */
  function boardScreen() {
    const w = st.cols * st.cell * view.zoom, h = st.rows * st.cell * view.zoom;
    const p = bwe.camera.worldToScreen(boardObj.x - st.cols * st.cell / 2, boardObj.y - st.rows * st.cell / 2);
    return { x: p.x, y: p.y, w, h };
  }

  return {
    bwe, st, view, logs, fields, defined, hudBlocks, badSetPos, setPosCalls: () => setPosCalls,
    frame, boardScreen, boardWorld, sandbox,
    setViewport(w, h) { view.W = w; view.H = h; },
    submit(id, text) {
      const d = defined.get(id);
      if (d) d.value = String(text);
      editingId = id;
      bwe.__onSubmit(id, String(text));
      editingId = "";
    },
  };
}

// ---------------------------------------------------------------------------
//  断言
// ---------------------------------------------------------------------------

const fails = [];
let checks = 0;
function ok(cond, label, detail) {
  checks++;
  if (!cond) fails.push({ label, detail: detail || "" });
  return !!cond;
}
const inRect = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 一个视口尺寸下的全套检查。 */
function audit(h, label) {
  const { W: w, H: hgt } = h.view;
  const { draws, btns } = h.frame();
  const bs = h.boardScreen();
  const texts = draws.filter((d) => d.kind === "text");
  const has = (sub) => texts.some((t) => t.s.indexOf(sub) >= 0);

  // 1. 绘制不越界
  const off = draws.filter((d) => d.kind === "rect" &&
    (d.x < -1 || d.y < -1 || d.x + d.w > w + 2 || d.y + d.h > hgt + 2));
  ok(off.length === 0, label + " · 绘制越界",
    off.slice(0, 3).map((d) => `${d.x.toFixed(0)},${d.y.toFixed(0)} ${d.w}x${d.h}`).join(" | "));

  // 2. HUD 与棋盘重叠时，必须由脚本登记「界面区」吃掉点击。
  //
  // <p>旧契约：棋盘完全落在两条带之间，两者不相交，怎么点都安全。
  // <p>新契约（64×64）：4096 格不可能整盘可见又可读，格子保持可读、棋盘允许伸出 HUD。
  // 于是 HUD 底下必然压着格子，而引擎点击派发是「脚本 → 棋盘」且脚本无法拦截 ——
  // 点「新游戏」会顺带把底下的格子翻开（很可能直接踩雷）。
  // 所以真正要守的不变量是：**每个与棋盘重叠的 HUD 带，都必须被 block 区域覆盖**。
  const bands = draws.filter((d) => d.kind === "rect" && d.fill === "#c0c0c0" && d.w >= w * 0.9);
  const hudB = [...h.hudBlocks.values()];
  const overlapping = bands.filter((b) => inRect(b, bs));
  for (const b of overlapping) {
    const covered = hudB.some((r) =>
      r.x <= b.x + 1 && r.y <= b.y + 1 &&
      r.x + r.w >= b.x + b.w - 1 && r.y + r.h >= b.y + b.h - 1);
    ok(covered, label + " · HUD 压住格子但没登记界面区（点按钮会误翻格子）",
      `带 y ${b.y.toFixed(0)}..${(b.y + b.h).toFixed(0)} 与棋盘重叠，bwe.input.block 未覆盖`);
  }

  // 3. 格子屏幕尺寸
  const cellPx = h.st.cell * h.view.zoom;
  ok(cellPx >= MIN_CELL_PX, label + " · 格子太小",
    `cell=${h.st.cell} zoom=${h.view.zoom.toFixed(3)} → ${cellPx.toFixed(1)}px`);
  // 3b. 不许靠**放大**凑可读性。
  //     棋盘纹理是按 cell 画的像素图，GL 用 GL_NEAREST 采样，zoom > 1 就是糊的大色块。
  //     少了这条，「cell 压到 8px + zoom 3.5」也能让上面的 cellPx 达标 —— 数字看着大，
  //     实际是一团马赛克。可读性必须来自「格子本身画得够大」，不是放大。
  ok(h.view.zoom <= 1 + 1e-6, label + " · 靠放大凑可读（像素画会糊）",
    `zoom=${h.view.zoom.toFixed(3)} cell=${h.st.cell}`);

  // 4. 棋盘完整落在两条带之间
  const tops = bands.filter((b) => b.y < hgt / 2).map((b) => b.y + b.h);
  const bots = bands.filter((b) => b.y > hgt / 2).map((b) => b.y);
  const topBandOf = (tops.length ? Math.max(...tops) : 0);
  const botBand = (bots.length ? Math.min(...bots) : hgt);
  const topBand = topBandOf;
  // 棋盘世界尺寸必须 ≤ 地图：Android 双指平移被引擎按**地图**范围钳制，
  // 棋盘比地图大的话，超出部分的格子永远拖不到 = 无法通关。
  ok(h.st.cols * h.st.cell <= MAP_PX + 1 && h.st.rows * h.st.cell <= MAP_PX + 1,
    label + " · 棋盘大于地图（边缘格子拖不到）",
    `board ${h.st.cols * h.st.cell}x${h.st.rows * h.st.cell} vs map ${MAP_PX}`);
  // 带之间必须真的露出可见棋盘（否则整盘被 HUD 盖住，玩家什么都点不到）
  ok(Math.min(bs.y + bs.h, botBand) - Math.max(bs.y, topBand) >= MIN_CELL_PX,
    label + " · 可见棋盘区太小",
    `可见 ${bs.y.toFixed(0)}..${(bs.y + bs.h).toFixed(0)} 带 ${topBand.toFixed(0)}..${botBand.toFixed(0)}`);

  // 5. 控件清单（BTN 是脚本自己判命中用的表）
  const byId = (re) => btns.filter((b) => re.test(String(b.id)));
  const inv = {
    face: byId(/^face$/).length,
    arrows: byId(/^[a-z]+[+-]$/).length,
    newGame: byId(/newGame/).length,
    mode: byId(/^mode$/).length,
    help: byId(/^help$/).length,
    // 只数 LED 红字：64×64 时数值框里的「640」也是 3 位数字，按内容会误判
    counters: draws.filter((d) => d.kind === "text" && d.color === "#ff0000"
      && /^\d{3}$/.test(d.s)).length,
    fields: [...h.fields.keys()].join(","),
    status: has("插旗") || has("首击") || has("踩到雷") || has("恭喜"),
    readout: texts.some((t) => /雷\s*\d+.*旗\s*\d+.*\d+×\d+/.test(t.s)),
    // 上限文案必须真的写 64：HUD 配置会覆盖脚本 fallback，
    // 以前只判 has("行 5")，配置里留着旧的「5–30」也照样算过。
    range: has("行 5–64") || has("复雷加殊："),
    labels: has("剩余雷数") && has("用时"),
  };
  ok(inv.face === 1, label + " · 笑脸按钮数量", String(inv.face));
  ok(inv.arrows === 6, label + " · 步进箭头数量", String(inv.arrows));
  ok(inv.newGame === 1, label + " · 缺「新游戏」");
  ok(inv.mode === 1, label + " · 缺「模式切换」");
  ok(inv.help === 1, label + " · 缺「帮助」");
  ok(inv.counters === 2, label + " · LED 计数器数量", String(inv.counters));
  ok(inv.fields === "cols,mines,rows" || inv.fields === "rows,cols,mines",
    label + " · 输入框不全", inv.fields);
  ok(inv.status, label + " · 缺状态行");
  ok(inv.readout, label + " · 缺雷/旗/规格读数");
  ok(inv.range, label + " · 缺范围或规则提示");
  ok(inv.labels, label + " · 缺计数器说明文字");

  // 5a. HUD 文字一律不许画进棋盘矩形。
  //     顶带/底带的文字（状态行、读数、提示）压到格子上，玩家就会「字盖住雷」，
  //     而且点那块区域时引擎会把它当棋盘点击 —— 属于最刺眼的一类回归。
  const inBoard = texts.filter((t) => {
    const gh = (t.size || 16) * 1.32;
    const gw = (t.s || "").length * (t.size || 16) * 0.62;
    // 只比对玩家**看得见**的那块棋盘（两条带之间）。伸出 HUD 的部分被银灰带盖住，
    // HUD 文字落在那上面不算问题（引擎那边已由 block 保证不会误翻格子）。
    const vy0 = Math.max(bs.y, topBand), vy1 = Math.min(bs.y + bs.h, botBand);
    if (vy1 <= vy0) return false;
    return t.x < bs.x + bs.w && t.x + gw > bs.x && t.y < vy1 && t.y + gh > vy0;
  });
  ok(inBoard.length === 0, label + " · HUD 文字压住棋盘",
    inBoard.slice(0, 3).map((t) => `${t.s.slice(0, 12)}@${t.y.toFixed(0)} 带底${topBandOf.toFixed(0)}`).join(" | "));

  // 5b. 文字不被控件切断：左对齐文字（标签/读数）的右边缘不能伸进任何可点区域。
  //     这是「横屏『行 Rows』被 − 按钮切掉一半」那类缺陷的通用不变量 ——
  //     按钮自己的文字是居中的，不在检查范围内。
  const clipped = [];
  for (const t of texts) {
    if (t.align && t.align !== "left") continue;
    const est = t.x + (t.s || "").length * (t.size || 16) * 0.62;
    for (const b of btns) {
      // 文字起点本身在按钮里（按钮内左对齐内容）不算被切
      if (t.x >= b.x && t.x <= b.x + b.w) continue;
      // 引擎语义：脚本的 text() 已把 y 换算成「字形顶边」再调 bwe.draw.text，
      // 所以这里的 d.y 是顶边，字形盒 = [y, y + size*1.32]。
      const gh = (t.size || 16) * 1.32;
      if (est > b.x + 1 && t.x < b.x + b.w &&
        t.y < b.y + b.h && t.y + gh > b.y) {
        clipped.push(`${t.s.slice(0, 10)}@y${t.y.toFixed(0)} x${t.x.toFixed(0)}→${est.toFixed(0)} 撞 ${b.id}@${b.x.toFixed(0)},${b.y.toFixed(0)}+${b.h}`);
        break;
      }
    }
  }
  ok(clipped.length === 0, label + " · 文字被控件切断", clipped.slice(0, 3).join(" | "));

  // 5c. 说明文字不能压住 LED 数字（黑底面板）。d.y 是字形顶边，见 5b 的说明。
  const panels = draws.filter((d) => d.kind === "rect" && d.fill === "#1a0000");
  const overText = [];
  for (const t of texts) {
    if (t.align && t.align !== "left") continue;
    for (const pn of panels) {
      if (t.y < pn.y + pn.h && t.y + (t.size || 16) * 1.32 > pn.y &&
        t.x < pn.x + pn.w && t.x + (t.s || "").length * (t.size || 16) * 0.62 > pn.x) {
        overText.push(`${t.s.slice(0, 8)}@${t.y.toFixed(0)}+${((t.size || 16) * 1.32).toFixed(0)} vs ${pn.y.toFixed(0)}..${(pn.y + pn.h).toFixed(0)}`);
      }
    }
  }
  ok(overText.length === 0, label + " · 说明文字压住计数器", overText.slice(0, 2).join(" | "));

  // 6. 触摸目标尺寸
  const small = btns.filter((b) => b.w < MIN_TOUCH_W || b.h < MIN_TOUCH_H);
  ok(small.length === 0, label + " · 触摸目标过小",
    small.map((s) => `${s.id} ${s.w.toFixed(0)}x${s.h.toFixed(0)}`).join(" | "));

  // 7. 可点区域互不重叠（BTN 之间 + BTN 与输入框之间）
  const rects = btns.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }));
  for (const [id, f] of h.fields) {
    rects.push({ id: "field:" + id, x: f.nx * w, y: f.ny * hgt, w: f.nw * w, h: f.nh * hgt });
  }
  const hits = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (inRect(rects[i], rects[j])) hits.push(rects[i].id + "×" + rects[j].id);
    }
  }
  ok(hits.length === 0, label + " · 控件重叠", [...new Set(hits)].join(" | "));

  // 8. 输入框在手机上够大（能点中才能弹软键盘）
  for (const [id, f] of h.fields) {
    ok(f.nw * w >= 60 && f.nh * hgt >= 22, label + ` · 输入框 ${id} 太小`,
      `${(f.nw * w).toFixed(0)}x${(f.nh * hgt).toFixed(0)}px`);
  }

  // 9. 一屏装不下整盘时，必须真的能平移。
  //    64×64 在手机上大约只露出 46 行，剩下 18 行点不到 = 游戏无法通关。
  //    所以「平移可用」不是体验优化，是能不能玩的前提。
  const bandH = botBand - topBand;
  if (bs.h > bandH + 2 || bs.w > w + 2) {
    const before = { x: h.view.camX, y: h.view.camY };
    // 按住约 2 秒：真实玩家会一路拖到边缘，位移必须撞上钳制边界。
    // 只跑两帧的话位移 ~14px，远小于棋盘半宽，钳制有没有生效根本测不出来。
    for (let i = 0; i < 120; i++) h.frame({ keys: ["ArrowRight", "ArrowDown"] });
    const moved = h.view.camX !== before.x || h.view.camY !== before.y;
    ok(moved, label + " · 装不下整盘却平移不了（边缘格子永远点不到）",
      `board ${bs.w.toFixed(0)}x${bs.h.toFixed(0)} 可用带高 ${bandH.toFixed(0)}`);
    // 平移不能把视野甩出棋盘（否则一片地图底色，看着像坏了）
    // 全程用世界坐标比（camX/camY 也是世界坐标）
    const bw = h.boardWorld();
    const overX = Math.abs(h.view.camX - bw.cx) - bw.w / 2;
    const overY = Math.abs(h.view.camY - bw.cy) - bw.h / 2;
    ok(overX <= 1 && overY <= 1, label + " · 平移后视野跑出棋盘",
      `超出 ${overX.toFixed(0)},${overY.toFixed(0)}（>1 就是拖到棋盘外一片底色）`);
    // 而且必须真的能拖到最右下角（钳制不能把玩家锁死在中间，否则边缘格子点不到）
    const halfW = h.view.W / (2 * h.view.zoom), halfH = h.view.H / (2 * h.view.zoom);
    const reachX = bw.cx + bw.w / 2 - halfW, reachY = bw.cy + bw.h / 2 - halfH;
    // 按住右下两秒后必须**正好贴在右下角**：
    // 差得远 = 钳制把玩家锁死、边缘格子点不到；越过去 = 钳制失效、拖进一片底色。
    ok(Math.abs(h.view.camX - reachX) <= 2 && Math.abs(h.view.camY - reachY) <= 2,
      label + " · 平移没能停在棋盘右下角",
      `cam ${h.view.camX.toFixed(0)},${h.view.camY.toFixed(0)} 应停在 ${reachX.toFixed(0)},${reachY.toFixed(0)}`);
    ok(h.badSetPos.length === 0, label + " · camera.setPos 收到非数字参数",
      h.badSetPos.slice(0, 1).map((a) => JSON.stringify(a)).join(""));
  } else {
    ok(h.badSetPos.length === 0, label + " · camera.setPos 收到非数字参数",
      h.badSetPos.slice(0, 1).map((a) => JSON.stringify(a)).join(""));
  }

  return { draws, btns, inv, bs };
}

/** 点击一个 BTN 区域中心，跑两帧（按下帧 + 抬起帧）。 */
function tap(h, btn) {
  h.frame({ mx: btn.x + btn.w / 2, my: btn.y + btn.h / 2, tap: true });
  return h.frame();
}

/** 行为测试：点了真的生效吗。 */
function behavior(h, label, snap) {
  const { W: w, H: hgt } = h.view;
  const find = (re) => snap.btns.find((b) => re.test(String(b.id)));

  // 步进箭头：行 +1 / -1
  const rowsPlus = snap.btns.find((b) => String(b.id) === "rows+");
  const rowsMinus = snap.btns.find((b) => String(b.id) === "rows-");
  ok(!!rowsPlus && !!rowsMinus, label + " · 找不到行的加减键");
  if (rowsPlus && rowsMinus) {
    // 出厂规格就是 64×64（上限），按 + 当然不动 —— 那不能证明步进键坏了。
    // 所以先按 − 退一格，再按 + 加回来，两个方向都验。
    const before = h.st.rows;
    tap(h, rowsMinus);
    ok(h.st.rows === before - 1, label + " · − 减行没生效", `${before} → ${h.st.rows}`);
    tap(h, rowsPlus);
    ok(h.st.rows === before, label + " · + 加行没生效", String(h.st.rows));
  }

  // 模式切换
  const modeBtn = find(/^mode$/);
  if (ok(modeBtn, label + " · 找不到模式按钮")) {
    const before = h.st.complex;
    tap(h, modeBtn);
    ok(h.st.complex !== before, label + " · 模式切换没生效");
    tap(h, modeBtn);
    ok(h.st.complex === before, label + " · 模式切回来没生效");
  }

  // 帮助：打开 → 棋盘重取景且不压 HUD → 关闭
  const helpBtn = find(/^help$/);
  if (ok(helpBtn, label + " · 找不到帮助按钮")) {
    tap(h, helpBtn);
    const open = h.frame();
    ok(open.draws.some((d) => d.kind === "text" && d.s.indexOf("扫雷玩法") >= 0),
      label + " · 帮助面板没打开");
    const bs2 = h.boardScreen();
    const bands2 = open.draws.filter((d) => d.kind === "rect" && d.fill === "#c0c0c0" && d.w >= w * 0.9);
    for (const b of bands2.filter((x) => inRect(x, bs2))) {
      const covered = [...h.hudBlocks.values()].some((r) =>
        r.x <= b.x + 1 && r.y <= b.y + 1 &&
        r.x + r.w >= b.x + b.w - 1 && r.y + r.h >= b.y + b.h - 1);
      ok(covered, label + " · 帮助面板压住格子却没登记界面区");
    }
    // 7 条帮助正文都要出现，且必须画在面板矩形内（画到面板外 = 文案被静默裁掉）。
    // ⚠ 只统计落在面板范围内的那些文字：顶带的状态行也含「首击必安全」等关键词，
    //   按内容正则会把它误当成帮助行，所以这里按**位置**筛，不按内容猜。
    const panel = open.draws.filter((d) => d.kind === "rect" && d.fill === "#f4f1e8")[0];
    if (ok(panel, label + " · 帮助面板底色没画出来")) {
      const inside = open.draws.filter((d) => d.kind === "text"
        && d.x >= panel.x && d.x <= panel.x + panel.w
        && d.y >= panel.y - 1 && d.y <= panel.y + panel.h);
      const want = ["扫雷玩法", "翻开：", "插旗：", "连锁：", "首击必安全", "复雷加殊：雷有虚实", "手机：双指缩放"];
      const missing = want.filter((k) => !inside.some((t) => t.s.indexOf(k) >= 0));
      ok(missing.length === 0, label + " · 帮助文案缺失/被裁", missing.join(","));
      // 底部溢出：最后一行的下边缘不能超出面板
      const over = inside.filter((t) => t.y + (t.size || 16) * 1.32 > panel.y + panel.h + 1);
      ok(over.length === 0, label + " · 帮助文字溢出面板底边",
        over.slice(0, 2).map((t) => `${t.s.slice(0, 10)}@${t.y.toFixed(0)}`).join(" | "));
    }
    const closeBtn = open.btns.find((b) => /^close$/.test(String(b.id)));
    if (ok(closeBtn, label + " · 帮助面板没有关闭按钮")) tap(h, closeBtn);
    const closed = h.frame();
    ok(!closed.draws.some((d) => d.kind === "text" && d.s.indexOf("扫雷玩法") >= 0),
      label + " · 帮助关不掉");
  }

  // 直接键入（手机软键盘路径）
  h.submit("mines", "60");
  ok(h.st.mines === 60, label + " · 键入雷数没生效", String(h.st.mines));
  h.submit("rows", "9");
  ok(h.st.rows === 9, label + " · 键入行数没生效", String(h.st.rows));
  h.submit("rows", "1");
  ok(h.st.rows === 5, label + " · 越界输入没被钳制", String(h.st.rows));
  h.submit("rows", "999");
  ok(h.st.rows === 64, label + " · 超上限没被钳制", String(h.st.rows));

  // 笑脸 = 新游戏
  const face = find(/^face$/);
  if (ok(face, label + " · 找不到笑脸")) {
    const before = h.st.resets;
    tap(h, face);
    ok(h.st.resets > before, label + " · 笑脸没触发重开");
  }

  // 新游戏按钮
  const nb = find(/newGame/);
  if (ok(nb, label + " · 找不到新游戏按钮")) {
    const before = h.st.resets;
    tap(h, nb);
    ok(h.st.resets > before, label + " · 新游戏没触发重开");
  }

  // 复位视角（竖屏）/ 窗口按钮（横屏）：至少有一个能把相机拉回基准
  const resetBtn = find(/resetView/) || find(/^win0$/);
  if (ok(resetBtn, label + " · 没有复位视角入口")) {
    h.view.zoom = 0.3;
    tap(h, resetBtn);
    ok(Math.abs(h.view.zoom - snap.bs.w / (h.st.cols * h.st.cell)) < 0.05 || h.view.zoom > 0.3,
      label + " · 复位视角没重算取景", `zoom=${h.view.zoom}`);
  }
}

// ---------------------------------------------------------------------------
//  主流程
// ---------------------------------------------------------------------------

/**
 * .bwproj 里 scenes / assets / scripts 都是**以名字为键的对象**（不是数组），
 * 这里统一成脚本以外只关心「第一个场景」的形态。
 */
function loadProject(f) {
  const p = JSON.parse(readFileSync(join(EX, f), "utf8"));
  const scenes = Array.isArray(p.scenes) ? p.scenes : Object.values(p.scenes || {});
  return { ...p, scenes };
}

const cases = [];
if (!ONLY_PORTRAIT) cases.push({
  file: "扫雷.bwproj", name: "横屏",
  ports: [[1280, 720], [1920, 1080], [2598, 1236], [1024, 768], [2280, 1080]],
});
if (!ONLY_LAND) cases.push({
  file: "扫雷-竖屏.bwproj", name: "竖屏",
  ports: [[1080, 2400], [1236, 2750], [1242, 2688], [828, 1792], [750, 1624], [1170, 2532]],
});

const summary = [];
for (const c of cases) {
  const base = loadProject(c.file);
  for (const [pw, ph] of c.ports) {
    const lg = androidLogical(pw, ph);
    const label = `${c.name} ${pw}x${ph} → 逻辑${lg.w}x${lg.h}`;
    const h = makeHarness(JSON.parse(JSON.stringify(base)));
    h.setViewport(lg.w, lg.h);
    h.frame();                       // 首帧完成初始取景
    const init = {
      grid: `${h.st.rows}x${h.st.cols}`, cell: h.st.cell,
      zoom: +h.view.zoom.toFixed(3), cellPx: +(h.st.cell * h.view.zoom).toFixed(1),
    };
    const snap = audit(h, label);
    behavior(h, label, snap);
    summary.push({ label, ...init });
  }
}

// 横竖屏功能对等：同一组控件、同一批行为，两边必须一致
if (!ONLY_PORTRAIT && !ONLY_LAND) {
  const p = makeHarness(loadProject("扫雷-竖屏.bwproj"));
  const lg = androidLogical(1080, 2400);
  p.setViewport(lg.w, lg.h); p.frame();
  const l = makeHarness(loadProject("扫雷.bwproj"));
  l.setViewport(1280, 720); l.frame();
  const sp = audit(p, "对等-竖屏"), sl = audit(l, "对等-横屏");
  for (const key of ["face", "arrows", "newGame", "mode", "help", "counters", "status", "readout", "range", "labels"]) {
    ok(sp.inv[key] === sl.inv[key], `横竖屏功能不对等 · ${key}`,
      `竖屏=${JSON.stringify(sp.inv[key])} 横屏=${JSON.stringify(sl.inv[key])}`);
  }
  const norm = (s) => s.split(",").sort().join(",");
  ok(norm(sp.inv.fields) === norm(sl.inv.fields), "横竖屏输入框不一致",
    `${sp.inv.fields} vs ${sl.inv.fields}`);
}

// 出厂规格（64×64）在每种分辨率下都要「格子可读」：≥ CELL_READABLE
for (const r of summary) {
  ok(r.cellPx >= MIN_CELL_PX, `出厂规格格子偏小 · ${r.label}`, `格子 ${r.cellPx}px`);
}

// 打包方向：地图是 64×64 正方形，靠宽高比推断会把竖屏工程判成横屏，
// 所以方向必须显式写在工程字段上（package-bwe.mjs decideOrientation 优先读它）。
// 这里直接调打包端的真实判断函数，而不是自己复制一份逻辑 —— 否则改了打包端测不出来。
for (const [f, want] of [["扫雷.bwproj", "landscape"], ["扫雷-竖屏.bwproj", "portrait"]]) {
  const raw = JSON.parse(readFileSync(join(EX, f), "utf8"));
  ok(raw.orientation === want, `工程方向缺失 · ${f}`,
    `orientation=${JSON.stringify(raw.orientation)}（应为 ${want}；正方形地图靠宽高比推断会判成 landscape）`);
  ok(decideOrientation(raw, undefined) === want, `打包方向错误 · ${f}`,
    `decideOrientation → ${decideOrientation(raw, undefined)}，APK 会${want === "portrait" ? "躺倒" : "竖着"}`);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ checks, failed: fails.length, fails, summary }, null, 2));
} else {
  for (const s of summary) {
    console.log(`  ${s.label.padEnd(32)} 棋盘 ${s.grid.padEnd(6)} 格子 ${String(s.cell).padStart(2)}px × zoom ${String(s.zoom).padStart(5)} = ${String(s.cellPx).padStart(5)}px`);
  }
  console.log(`\n检查 ${checks} 项，失败 ${fails.length} 项`);
  for (const f of fails) console.log(`  ✗ ${f.label}${f.detail ? " — " + f.detail : ""}`);
  if (!fails.length) console.log("✅ 横竖屏功能对等；手机触摸目标、可读性、无遮挡全部达标");
}
process.exit(fails.length ? 1 : 0);
