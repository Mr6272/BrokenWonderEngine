/**
 * 扫雷 · Minesweeper 主脚本（BWE Studio 场景的 onStartScript）。
 *
 * 设计要点：
 *   1. 素材（格子的风车小花 / 旗帜人头 / 雷）= 像素图，由 Java 端棋盘直接绘制，
 *      脚本**不**碰这些图，也不拉伸它们。
 *   2. 所有文字 / 数字 / 按钮全部走 `bwe.draw.text` + `bwe.draw.rect` 的独立图层：
      HUD 与像素素材彻底分离（文字永远是可编辑的、不被烤进图里）。
 *   3. UI 是 Win98 / Win2000 的经典银灰立体风格：标题栏 + 凸起按钮 + 凹陷输入框 +
      红字 LED 计数器 + 上左亮/下右暗的 3D 边框。
 *   4. 行 / 列 / 雷数在游戏内自选：底栏三组 +/- 步进器，实时调用
      `bwe.mine.set({rows, cols, mines})` 重建棋盘。
 *   5. HUD 只占屏幕上/下两条带，绝不压住棋盘（棋盘位置由 camera.worldToScreen 实测）。
 */

// ---------------------------------------------------------------- 常量

var SILVER = "#c0c0c0";
var SILVER_LIGHT = "#ffffff";
var SILVER_MID = "#dfdfdf";
var SILVER_DARK = "#808080";
var SILVER_OUT = "#404040";
var BLACK = "#000000";
var TITLE_BLUE1 = "#0a246a";
var TITLE_BLUE2 = "#a6caf0";
var LED_RED = "#ff0000";
var LED_BG = "#1a0000";
var TEXT_DARK = "#000000";

var SFX = {
  flag: { a: "ms-sfx-flag", v: 0.85 },
  hit: { a: "ms-sfx-hit", v: 1.0 },
};
var BGM = { a: "ms-bgm", v: 0.28 };

// 自选行列/雷数的当前值
var MS = {
  cell: 32,
  winX: 0, winY: 0,       // 标题栏拖动的窗口偏移（相对 HUD 基准）
  drag: null,
  baseZoom: 0,      // 整图 fit 的基准 zoom（格子尺寸按它算，缩放后不再变）
  rows: 12,
  cols: 16,
  mines: 40,
  curElapsed: 0,
  started: false,
  modeIdx: 0,             // 0 = 普通扫雷，1 = 复雷加殊 Complexweeper
};

var prev = { flags: -1, over: false, won: false };
var mousePrev = false;
var hoverId = "";

function wlog(s) { try { bwe.log("[ms] " + s); } catch (e) { } }

// ---------------------------------------------------------------- 启动

function onSceneStart(ctx) {
  try {
    var bgmId = bwe.audio.music(BGM.a, { volume: BGM.v, loop: true });
    wlog("bgm id=" + bgmId);
  } catch (e) { wlog("bgm fail " + e); }

  // 输入框提交回调：回车 / 点框外确认时应用新值
  //
  // ⚠ 这里**不挂虚拟按键**（bwe.stick）：扫雷是纯触摸/鼠标操作（点格子、
  // 点笑脸、点配置箭头、直接输入数字），根本不需要 WASD/空格/回车/Tab/Esc
  // 这些键盘模拟。挂了只会在屏幕上凭空多出四个按钮，挡住棋盘和 HUD。
  // 需要虚拟按键的是「桌面向键盘操作」的游戏（平台跳跃、RPG 移动等），
  // 由那些工程自己调 bwe.stick.mount()，不要塞进扫雷。
  try {
    bwe.textinput.onSubmit(function (id, text) { applyInputField(id, text); });
  } catch (e) { wlog("textinput fail " + e); }

  MS.rows = 12; MS.cols = 16; MS.mines = 40;
  // 模式以模块参数为准：先读一次运行时状态，再重建棋盘。
  // ⚠ 顺序很重要：pushBoard() 会把 MS.modeIdx 下发给 bwe.mine.set()，
  // 如果先 pushBoard() 就晚了 —— 那会把模块参数里设的「复雷加殊」覆盖回「普通」。
  try {
    var s0 = bwe.mine.state();
    if (s0 && typeof s0.modeIndex === "number") { MS.modeIdx = s0.modeIndex; }
  } catch (e) { wlog("state fail " + e); }
  pushBoard();
  wlog("start · " + MS.rows + "×" + MS.cols + " · " + MS.mines + " 雷 · 模式 "
    + (MS.modeIdx ? "复雷加殊" : "普通"));
  try { bwe.on("update", onUpdate); } catch (e) { wlog("onUpdate bind fail " + e); }
}

function pushBoard() {
  try {
    // 自动挑格子大小：让棋盘刚好填满上下 HUD 之间的可用区
    bwe.mine.set({
      rows: MS.rows, cols: MS.cols, mines: MS.mines, seed: 0,
      cellSize: autoCellSize(MS.rows, MS.cols),
      // 模式一并下发：set() 里 mode 变化也会 reset，合并成一次调用避免重置两次
      mode: MS.modeIdx === 1 ? "complex" : "normal",
    });
  } catch (e) { wlog("mine.set fail " + e); }
  fitBoard();
}

/** 在当前两种模式之间切换，并重建棋盘（行列雷数保持不变）。 */
function toggleMode() {
  MS.modeIdx = MS.modeIdx === 1 ? 0 : 1;
  pushBoard();
  wlog("模式 " + (MS.modeIdx ? "复雷加殊" : "普通"));
}

/**
 * 屏幕可用区能容下的最大格子边长（世界像素，16~64）。
 * 关键：棋盘是按**世界坐标**画的，再被相机缩放；所以要先把屏幕可用像素
 * 除回 zoom 才是世界像素，否则格子会小得看不清。
 */
function autoCellSize(rows, cols) {
  var scr = screenSize();
  var portrait = isPortrait(scr.w, scr.h);
  // HUD 固定贴边（顶 108 / 底 116 横屏；顶 92 / 底 116 竖屏），中间是棋盘可用区
  var availW = scr.w - (portrait ? 16 : 24);
  var availH = scr.h - (portrait ? 92 + 116 + 16 : 108 + 116 + 20);
  // ⚠ 关键：格子尺寸按「初始 fit 的 zoom」算一次，缩放后不再重算。
  // 旧写法每帧读 bwe.camera.zoom，玩家双指一放大，cell 就变小 → 棋盘整体缩小，
  // 看起来像「缩放没生效、反而在抖」。
  // 现在用「整图 fit 时的基准 zoom」：只有屏幕尺寸/行列数变化才重算。
  var zoom = MS.baseZoom;
  if (!zoom || zoom <= 0.05) {
    zoom = 1;
    try { zoom = bwe.camera.zoom || 1; } catch (e) { zoom = 1; }
    if (zoom <= 0.05) { zoom = 1; }
    MS.baseZoom = zoom;
  }
  var byW = Math.floor((availW / cols) / zoom);
  var byH = Math.floor((availH / rows) / zoom);
  var cell = Math.min(byW, byH);
  cell = Math.max(16, Math.min(64, cell));
  MS.cell = cell;
  return cell;
}

/** 把棋盘对象的显示尺寸设成 rows×cell，让它和实际绘制的棋盘一致。 */
function fitBoard() {
  try {
    var b = bwe.world.find("棋盘 Minesweeper");
    if (!b) { return; }
    var st = bwe.mine.state();
    var cell = MS.cell || 32;
    var w = st.cols * cell, h = st.rows * cell;
    // ⚠ 只更新「逻辑尺寸」元数据（引擎按 props.w/h 知道棋盘多大），
    // **绝不能调 setSize()**：那个方法改的是对象的渲染尺寸（o.halfW/halfH），
    // 棋盘对象上挂着美术素材，一改尺寸素材就被拉伸/缩放 ——
    // 表现就是「那朵花显示出来了」以及「加减行列时花跟着变大变小」。
    b.setProp("w", w);
    b.setProp("h", h);
  } catch (e) { wlog("fitBoard fail " + e); }
}

// ---------------------------------------------------------------- 每帧

function onUpdate(dt) {
  var S = { rows: MS.rows, cols: MS.cols, mines: MS.mines, flags: 0, started: false, over: false, won: false, hitMine: false, elapsed: 0, modeIndex: 0 };
  try { S = bwe.mine.state(); } catch (e) { }
  // 模式以运行时为准（模块参数里也可以直接设成复雷加殊）
  if (typeof S.modeIndex === "number") { MS.modeIdx = S.modeIndex; }

  // —— 音效 ——
  if (prev.flags === -1) prev.flags = S.flags;
  if (S.flags > prev.flags) {
    try { bwe.audio.play(SFX.flag.a, { volume: SFX.flag.v }); } catch (e) { }
  }
  if (S.over && !prev.over) {
    if (S.won) { try { bwe.audio.play(SFX.flag.a, { volume: SFX.flag.v, pitch: 1.35 }); } catch (e) { } }
    else { try { bwe.audio.play(SFX.hit.a, { volume: SFX.hit.v }); } catch (e) { } }
  }
  prev.flags = S.flags;
  prev.over = S.over;
  prev.won = S.won;

  try { drawHud(S); } catch (e) { drawErr(e); }
}

function drawErr(e) {
  try { bwe.draw.text(8, 14, "HUD: " + e, { size: 14, color: "#ff4040" }); } catch (e2) { }
}

// ---------------------------------------------------------------- 基础绘制工具

function screenSize() {
  var w = 960, h = 540;
  try {
    var s = bwe.camera.size;
    if (s && s.w > 0) { w = s.w; h = s.h; }
  } catch (e) { }
  return { w: w, h: h };
}

/**
 * 纯色矩形。
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {string} fill
 */
function box(x, y, w, h, fill) {
  bwe.draw.rect(x, y, w, h, { fill: fill, alpha: 1 });
}

/**
 * 带 1px 描边的矩形。
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {string} fill
 * @param {string} stroke
 */
function frame(x, y, w, h, fill, stroke) {
  bwe.draw.rect(x, y, w, h, { fill: fill, alpha: 1, stroke: stroke, width: 1 });
}

/**
 * 画字符串。
 * @param {string} s
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {string} color
 * @param {"left"|"center"|"right"} align
 */
/**
 * 画字符串。**y 是这一行文字的垂直中心**（不是顶部）。
 *
 * 引擎的 bwe.draw.text 把 y 当「文字纹理的顶边」，直接用会让所有文案整体下移
 * 一个字号的高度 —— 这正是之前「每处文字都偏」的根因。这里统一先量高度，
 * 再减去一半，调用方只需关心「这行字要在哪个高度居中」。
 */
function text(s, x, y, size, color, align) {
  /** @type {"left"|"center"|"right"} */
  var a = /** @type {any} */ (align) || "left";
  var h = size * 1.32;
  try {
    var m = bwe.draw.measureText(s, size);
    if (m && m.h > 0) { h = m.h; }
  } catch (e) { }
  bwe.draw.text(x, y - h / 2, s, {
    size: size, color: color, align: a, shadow: false,
  });
}

/** Win98 凸起边框（亮边在上/左，暗边在下/右）。 */
function bevelRaise(x, y, w, h) {
  box(x + 2, y + 2, w - 4, h - 4, SILVER);
  box(x, y, w, 2, SILVER_LIGHT);
  box(x, y, 2, h, SILVER_LIGHT);
  box(x + w - 2, y + 2, 2, h - 2, SILVER_DARK);
  box(x + 2, y + h - 2, w - 2, 2, SILVER_DARK);
  box(x + 1, y + 1, w - 2, 1, SILVER_MID);
  box(x + 1, y + 1, 1, h - 2, SILVER_MID);
}

/** Win98 凹陷边框（暗边在上/左，亮边在下/右）。 */
function bevelSunken(x, y, w, h) {
  box(x + 2, y + 2, w - 4, h - 4, SILVER);
  box(x, y, w, 2, SILVER_DARK);
  box(x, y, 2, h, SILVER_DARK);
  box(x + w - 2, y + 2, 2, h - 2, SILVER_LIGHT);
  box(x + 2, y + h - 2, w - 2, 2, SILVER_LIGHT);
  box(x + 2, y + 2, w - 4, 1, SILVER_OUT);
  box(x + 2, y + 2, 1, h - 4, SILVER_OUT);
}

function hit(r) {
  try {
    var m = bwe.input.mouse;
    return m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h;
  } catch (e) { return false; }
}

function mouseDown() {
  try { return !!bwe.input.down("mouse0"); } catch (e) { return false; }
}

/**
 * 一次点击：只在「刚按下」那一帧、并且指针落在 r 内时返回 true。
 * 帧末统一更新 mousePrev（见 drawHud 末尾），所以一次按下只会命中一个按钮。
 */
function clicked(r) {
  if (MS.drag) { return false; }
  return hit(r) && mouseDown() && !mousePrev;
}

function pad3(n) {
  var s = String(Math.max(0, Math.floor(n)));
  while (s.length < 3) { s = "0" + s; }
  return s;
}

function fmtTime(sec) {
  var s = Math.floor(sec);
  var mm = Math.floor(s / 60), ss = s % 60;
  return pad3(mm) + ":" + (ss < 10 ? "0" : "") + ss;
}

// ---------------------------------------------------------------- 棋盘屏幕位置

/** 实测棋盘在屏幕上的矩形（世界坐标 → 屏幕），用于避开 HUD。 */
function boardScreenRect() {
  var out = { x: 0, y: 0, w: 0, h: 0 };
  try {
    var b = bwe.world.find("棋盘 Minesweeper");
    if (!b) { return out; }
    var z = bwe.camera.zoom || 1;
    var hw = Number(b.prop("w")) || 896;
    var hh = Number(b.prop("h")) || 640;
    var bw = hw * z, bh = hh * z;
    var p = bwe.camera.worldToScreen(b.x - hw / 2, b.y - hh / 2);
    out.x = p.x; out.y = p.y; out.w = bw; out.h = bh;
    return out;
  } catch (e) { return out; }
}

// ---------------------------------------------------------------- HUD

// ---------------------------------------------------------------- 可编辑 HUD 配置

/** HUD 配置对象（场景里叫「HUD 配置」）：文案 / 配色 / 字号都在它的 props 里。 */
var HUD = null;
var HUDP = {};

function loadHudCfg() {
  if (HUD) { return; }
  try {
    var list = bwe.world.findAll({ tag: "hudcfg" });
    HUD = list.length ? list[0] : null;
  } catch (e) { HUD = null; }
  if (HUD) {
    try {
      var all = HUD.props();
      for (var k in all) { if (Object.prototype.hasOwnProperty.call(all, k)) { HUDP[k] = String(all[k]); } }
    } catch (e2) { }
  }
}

/** 读一条 HUD 文案；编辑器里没填就用 fallback。 */
function cfg(key, fallback) {
  loadHudCfg();
  var v = HUDP[key];
  return (v !== undefined && v !== null && String(v).length) ? String(v) : fallback;
}


// ---------------------------------------------------------------- 可编辑 label

var LABELS = {};
var labelsReady = false;

/** 收集场景里的 label 对象（文字/字号/颜色都在 props 里，编辑器可改）。 */
function findLabels() {
  if (labelsReady) { return; }
  try {
    var list = bwe.world.findAll({ tag: "label" });
    for (var i = 0; i < list.length; i++) {
      LABELS[list[i].name] = list[i];
    }
    labelsReady = true;
  } catch (e) { }
}

/** 把某个 label 摆到 (x, y)；y 是文字垂直中心。 */
function putLabel(name, x, y) {
  findLabels();
  var e = LABELS[name];
  if (!e) { return; }
  try { e.setPos(x, y); } catch (e2) { }
}

/** 读 label 当前文案（编辑器里改过就以此为准）。 */
function labelText(name, fallback) {
  findLabels();
  var e = LABELS[name];
  if (!e) { return fallback; }
  try {
    var t = e.prop("text");
    if (t && String(t).length) { return String(t); }
  } catch (e2) { }
  return fallback;
}


// ---------------------------------------------------------------- 可拖动的窗口

/** 标题栏拖动：按住蓝条拖，整个「窗口」（HUD 两条带 + 棋盘视口）跟着平移。 */
function updateWindowDrag(W) {
  var titleR = { x: 2, y: 2, w: W - 4, h: 24 };
  var over = hit(titleR);
  var down = mouseDown();
  if (over && down && !mousePrev) {
    MS.drag = { x: mousePos().x - MS.winX, y: mousePos().y - MS.winY };
  }
  if (!down) {
    MS.drag = null;
  } else if (MS.drag) {
    MS.winX = mousePos().x - MS.drag.x;
    MS.winY = mousePos().y - MS.drag.y;
    // 限制在屏幕内，别拖丢
    var maxX = Math.max(0, W * 0.5);
    var maxY = 200;
    MS.winX = Math.max(-maxX, Math.min(maxX, MS.winX));
    MS.winY = Math.max(-maxY, Math.min(maxY, MS.winY));
  }
}

function mousePos() {
  try {
    var m = bwe.input.mouse;
    return { x: m.x, y: m.y };
  } catch (e) { return { x: 0, y: 0 }; }
}


var BTN = [];         // 本帧可点区域（供调试）
var BTN_ACT = {};     // id → 动作

/** 屏幕是横屏还是竖屏：竖屏时 HUD 改到左右两侧。 */
function isPortrait(W, H) { return H > W * 1.05; }

function drawHud(S) {
  BTN = []; BTN_ACT = {};
  var wasDown = mouseDown();
  var scr = screenSize();
  var W = scr.w, H = scr.h;
  var br = boardScreenRect();
  updateWindowDrag(W);

  if (isPortrait(W, H)) {
    // 竖屏：顶部只放一条窄标题带，配置条压在底部，棋盘居中
    var topH = 92;
    var botH = 116;
    drawFrameTop(W, topH);
    drawFrameBottom(W, H - botH, botH);
    putLabel("标题 扫雷", 8, 2 + 22 / 2);
    putLabel("提示 玩法", 8, topH - 10);
    drawInfoBarPortrait(W, topH, S);
    drawConfigBarPortrait(W, H - botH, botH);
    drawOverlay(W, H, br, S);
    mousePrev = mouseDown();
    return;
  }

  // 横屏：上下两条带
  //
  // ⚠ 这里**不能**用棋盘的屏幕位置来定 HUD 高度。
  // 旧写法是 topH2 = br.y - 10、botY = br.y + br.h + 10 —— 一旦玩家缩放/平移
  // （手机上双指手势、桌面改 zoom），棋盘在屏幕上的位置就变，两条灰带跟着变高变矮，
  // 表现是「UI 一直在跳」。
  // HUD 是界面层，必须固定在屏幕边缘：顶带固定高度、底带贴底，中间留给棋盘的可用区
  // 只用来「提示」不参与布局。
  var topH2 = 108;
  var botH2 = 116;
  var botY = H - botH2;
  // 棋盘可用区（供 autoCellSize / 提示文案用；布局不再依赖它）
  var availH = botY - topH2;
  drawFrameTop(W, topH2);
  drawFrameBottom(W, botY, botH2);
  putLabel("标题 扫雷", 10, 2 + 26 / 2);
  putLabel("标签 剩余雷数", 16 + 100, 60);
  putLabel("标签 用时", W - 16 - 96 - 96, 60);
  putLabel("标签 行", 24, botY + 24);
  putLabel("标签 列", 24 + 216, botY + 24);
  putLabel("标签 雷", 24 + 432, botY + 24);
  putLabel("提示 玩法", 16, botY + botH - 12);
  drawInfoBar(W, topH2, S);
  drawConfigBar(W, botY, botH2);
  drawOverlay(W, H, br, S);
  mousePrev = mouseDown();
}

function drawFrameTop(W, h) {
  box(0, 0, W, h, SILVER);
  bevelSunken(0, 0, W, h);
}
function drawFrameBottom(W, y, h) {
  box(0, y, W, h, SILVER);
  bevelSunken(0, y, W, h);
}

/** 只铺上、下两条带（中间留给棋盘，绝不盖住游玩区）。 */
function drawFrame(W, H, topH, botY, botH) {
  box(0, 0, W, topH, SILVER);
  bevelSunken(0, 0, W, topH);
  box(0, botY, W, botH, SILVER);
  bevelSunken(0, botY, W, botH);
}

/** 顶带：标题栏 + 两个 LED 计数器 + 笑脸按钮。 */
function drawInfoBar(W, topH, S) {
  var titleH = 26;
  // 标题栏（Win98 经典深蓝 → 浅蓝渐变，用两段纯色近似）
  box(2, 2, W - 4, titleH, TITLE_BLUE1);
  box(2, 2, W - 4, 10, "#2a4b9b");
  text(MS.modeIdx === 1 ? "扫雷 · 复雷加殊 Complexweeper" : cfg("bgTitle", "扫雷 · Minesweeper"),
    10, 2 + titleH / 2, 15, cfg("silverLight", "#ffffff"), "left");
  // 右上角三个窗口按钮
  drawTitleButtons(W, titleH);

  // LED 计数器：剩余雷数 / 用时
  var cy = titleH + 12;
  var cw = 96, ch = 40;
  var leftX = 16, rightX = W - 16 - cw;
  drawCounter(leftX, cy, cw, ch, S.mines - S.flags);
  drawCounter(rightX, cy, cw, ch, Math.min(999, S.elapsed));
  // 计数器上方的说明文字（同样来自可编辑配置）
  text(cfg("labelMines", "剩余雷数"), leftX, cy - 6, 11, "#303030", "left");
  text(cfg("labelTime", "用时"), rightX, cy - 6, 11, "#303030", "left");

  // 中间：状态标签 + 笑脸按钮
  var faceW = 34, faceH = 34;
  var faceX = Math.floor((W - faceW) / 2), faceY = cy + 3;
  var face = { x: faceX, y: faceY, w: faceW, h: faceH };
  var down = mouseDown() && hit(face);
  if (down) { bevelSunken(face.x, face.y, face.w, face.h); }
  else { bevelRaise(face.x, face.y, face.w, face.h); }
  drawFace(face, S);
  if (clicked(face)) {
    bwe.mine.reset();
    wlog("新游戏");
  }

  // 标题下的状态文字
  var msg;
  if (MS.modeIdx === 1) {
    msg = S.over
      ? (S.won ? "复雷加殊 · 全部安全格已翻开" : "踩到雷了，按笑脸重开")
      : (S.started
        ? "复雷加殊 · 数字 = 周围雷之和的模长 · 点数字可连锁翻开"
        : "左键翻开第一格（首击必安全）· 点数字可连锁翻开（数量与虚实比例都要对）");
  } else {
    msg = S.over
      ? (S.won ? "恭喜！全部安全格已翻开" : "踩到雷了，按笑脸重开")
      : (S.started
        ? "进行中 · 左键翻开 / 右键插旗 · 点数字可连锁翻开"
        : "左键翻开第一格（首击必安全）· 点数字可连锁翻开（旗数要对）");
  }
  text(msg, 16 + cw + 14, cy + 26, 15, TEXT_DARK, "left");

  // 行/列/雷数 只读显示
  text("雷 " + S.mines + " · 旗 " + S.flags + " · " + S.rows + "×" + S.cols,
    W - 16 - cw - 250, cy + 26, 15, TEXT_DARK, "left");
}

function drawTitleButtons(W, titleH) {
  var b = { w: 18, h: 16 };
  var x = W - 8 - b.w * 3 - 8;
  var y = Math.floor((titleH - b.h) / 2) + 2;
  for (var i = 0; i < 3; i++) {
    var r = { x: x + i * (b.w + 4), y: y, w: b.w, h: b.h };
    bevelRaise(r.x, r.y, r.w, r.h);
    if (i === 0 && clicked(r)) { MS.winX = 0; MS.winY = 0; wlog("窗口复位"); }
    if (i === 1 && clicked(r)) { MS.winX = 0; MS.winY = 0; bwe.mine.reset(); }
    if (i === 2 && clicked(r)) { bwe.mine.reset(); }
    if (i === 0) { box(r.x + 4, r.y + 11, 10, 2, BLACK); }
    else if (i === 1) { frame(r.x + 4, r.y + 4, 10, 9, null, BLACK); }
    else {
      box(r.x + 5, r.y + 4, 8, 1, BLACK); box(r.x + 5, r.y + 7, 8, 1, BLACK);
      box(r.x + 5, r.y + 10, 8, 1, BLACK);
      box(r.x + 5, r.y + 4, 1, 7, BLACK); box(r.x + 12, r.y + 4, 1, 7, BLACK);
    }
  }
}

/** 红色 LED 计数器（黑底凹陷 + 红字）。 */
function drawCounter(x, y, w, h, value) {
  bevelSunken(x, y, w, h);
  box(x + 5, y + 5, w - 10, h - 10, LED_BG);
  var s = pad3(value);
  text(s, x + w / 2, y + h / 2, 26, LED_RED, "center");
}

/** 笑脸：凹陷格 + 像素笑脸（笑脸表情随状态变化）。 */
function drawFace(r, S) {
  var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  var eye = 3, mw = 12;
  // 眼睛
  box(cx - 8, cy - 6, eye, eye, BLACK);
  box(cx + 5, cy - 6, eye, eye, BLACK);
  if (S.over && !S.won) {
    // 倒霉脸：嘴角向下
    box(cx - mw / 2, cy + 7, mw, 2, BLACK);
    box(cx - mw / 2, cy + 5, 3, 2, BLACK);
    box(cx + mw / 2 - 3, cy + 5, 3, 2, BLACK);
  } else if (S.over && S.won) {
    // 赢：大笑 + 墨镜
    box(cx - 9, cy - 7, 18, 6, BLACK);
    box(cx - 6, cy + 4, 12, 3, BLACK);
  } else {
    box(cx - mw / 2, cy + 5, mw, 2, BLACK);
    box(cx - mw / 2, cy + 3, 3, 2, BLACK);
    box(cx + mw / 2 - 3, cy + 3, 3, 2, BLACK);
  }
}

/** 底带：行 / 列 / 雷数 三个步进器 + 新游戏按钮。 */
function drawConfigBar(W, botY, botH) {
  var items = [
    { id: "rows", cap: "Rows", label: "行 Rows", value: MS.rows, min: 5, max: 30, step: 1 },
    { id: "cols", cap: "Cols", label: "列 Cols", value: MS.cols, min: 5, max: 30, step: 1 },
    { id: "mines", cap: "MineCount", label: "雷 Mines", value: MS.mines, min: 1, max: Math.max(1, MS.rows * MS.cols - 9), step: 1 },
  ];
  var gx = 14;
  var gw = Math.min(206, Math.floor((W - 200) / 3));
  var gy = botY + Math.floor((botH - 58) / 2);

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var x = gx + i * (gw + 10);
    // 组外框
    bevelRaise(x, gy, gw, 52);
    // 标签（文字层）：组框上半部居中
    text(cfg("label" + it.cap, it.label), x + 10, gy + 15, 13, cfg("textDark", "#303030"), "left");
    // 凹陷数值框：组框下半部
    var fx = x + 10, fy = gy + 26, fw = gw - 48, fh = 20;
    bevelSunken(fx, fy, fw, fh);
    syncInputField(it.id, fx, fy, fw, fh, it.value, it.min, it.max, W);
    var shown = curFieldText(it.id, String(it.value));
    // 输入超范围 → 红框提示（否则玩家填 1 被悄悄钳成 5，完全不知道发生了什么）
    var bad = inputHint(it.id);
    // 编辑态画白底，让「现在能打字」一眼可见
    if (bwe.textinput.editing === it.id) {
      box(fx, fy, fw, fh, bad ? "#ffe0e0" : "#ffffff");
    }
    text(shown, fx + fw / 2, fy + fh / 2, 16, bad ? "#c00000" : BLACK, "center");
    if (bad) {
      text(bad, fx + fw / 2, fy - 8, 11, "#c00000", "center");
    }
    // 编辑时画一条闪烁光标
    if (bwe.textinput.editing === it.id) {
      var tw = bwe.draw.measureText(shown, 16).w;
      box(fx + fw / 2 + tw / 2 + 2, fy + 3, 2, fh - 6, "#1a66ff");
    }
    // +/- 两个凸起按钮
    var bw2 = 20, bh2 = 9;
    var up = { x: fx + fw + 7, y: fy, w: bw2, h: bh2 };
    var dn = { x: fx + fw + 7, y: fy + bh2 + 2, w: bw2, h: bh2 };
    var upHover = hit(up), dnHover = hit(dn);
    bevelRaise(up.x, up.y, up.w, up.h);
    bevelRaise(dn.x, dn.y, dn.w, dn.h);
    if (upHover && mouseDown()) { box(up.x + 2, up.y + 2, up.w - 4, up.h - 4, "#a8a8a8"); }
    if (dnHover && mouseDown()) { box(dn.x + 2, dn.y + 2, dn.w - 4, dn.h - 4, "#a8a8a8"); }
    drawArrow(up, true);
    drawArrow(dn, false);
    if (clicked(up)) { changeValue(it.id, it.step, it.max, it.min); }
    if (clicked(dn)) { changeValue(it.id, -it.step, it.max, it.min); }
  }

  // 新游戏按钮
  var nbW = 118, nbH = 34;
  var nb = { x: W - nbW - 16, y: gy + 9, w: nbW, h: nbH };
  bevelRaise(nb.x, nb.y, nb.w, nb.h);
  if (hit(nb) && mouseDown()) { box(nb.x + 2, nb.y + 2, nb.w - 4, nb.h - 4, "#a8a8a8"); }
  text(cfg("labelNewGame", "新游戏"), nb.x + nb.w / 2, nb.y + nb.h / 2, 16, BLACK, "center");
  if (clicked(nb)) {
    bwe.mine.reset();
    wlog("新游戏（" + MS.rows + "×" + MS.cols + " · " + MS.mines + "）");
  }

  // 模式切换按钮：普通 ⇄ 复雷加殊（放在「新游戏」左边）
  var mbW = 116, mbH = 34;
  var mb = { x: nb.x - 12 - mbW, y: gy + 9, w: mbW, h: mbH };
  if (mb.x > gx + 3 * (gw + 10) + 4) {
    bevelRaise(mb.x, mb.y, mb.w, mb.h);
    // 复雷模式用浅蓝底提示当前不是普通扫雷
    if (MS.modeIdx === 1) { box(mb.x + 2, mb.y + 2, mb.w - 4, mb.h - 4, "#cfe0ff"); }
    if (hit(mb) && mouseDown()) { box(mb.x + 2, mb.y + 2, mb.w - 4, mb.h - 4, "#a8a8a8"); }
    text(MS.modeIdx === 1 ? "模式：复雷" : "模式：普通",
      mb.x + mb.w / 2, mb.y + mb.h / 2, 15, BLACK, "center");
    if (clicked(mb)) { toggleMode(); }
  }

  // 底部提示
  var rangeTip = MS.modeIdx === 1
    ? "复雷加殊：点数字连锁翻开需①旗数正确 ②虚实比例正确（不需标雷的属性）"
    : cfg("labelRange", "行 5–30 · 列 5–30 · 雷 1–(行×列−9)");
  text(rangeTip, 16, botY + botH - 12, 11, "#404040", "left");
}

function drawArrow(r, up) {
  var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  if (up) {
    box(cx - 4, cy, 2, 1, BLACK);
    box(cx + 3, cy, 2, 1, BLACK);
    box(cx - 3, cy - 1, 6, 1, BLACK);
    box(cx - 2, cy - 2, 4, 1, BLACK);
    box(cx - 1, cy - 3, 2, 1, BLACK);
  } else {
    box(cx - 4, cy + 1, 2, 1, BLACK);
    box(cx + 3, cy + 1, 2, 1, BLACK);
    box(cx - 3, cy + 2, 6, 1, BLACK);
    box(cx - 2, cy + 3, 4, 1, BLACK);
    box(cx - 1, cy + 4, 2, 1, BLACK);
  }
}

/** 改行/列/雷数并重建棋盘（列改时会修正雷数上限）。 */
// ---------------------------------------------------------------- 可编辑输入框
//
// 玩家反馈：手机上改「40 雷」要点 30 多次 +/-。改成点一下数值框就能直接键入。
// 实现在引擎侧（bwe.textinput）：桌面端走物理键盘、Android 弹系统软键盘，
// 脚本只负责「把框放在哪、值是什么、提交后怎么办」。

/** 把脚本的布局同步给引擎（归一化 0~1，引擎按逻辑视口换算）。 */
function syncInputField(id, x, y, w, h, value, min, max, viewW) {
  // ⚠ 不要要求调用方传视口高度：drawConfigBar / drawConfigBarPortrait 的签名里
  // 根本没有 H（只有 W/botY/botH），直接引用 H 会抛 "H is not defined"。
  // 这里自己从 bwe.camera.size 取，调用方只需给宽度做归一化基准。
  var ss = screenSize();
  var viewH = ss.h > 0 ? ss.h : 1;
  var baseW = viewW > 0 ? viewW : (ss.w > 0 ? ss.w : 1);
  try {
    bwe.textinput.define(id, String(value), min, max, true);
    bwe.textinput.rect(id, x / baseW, y / viewH, w / baseW, h / viewH);
    bwe.textinput.refreshHints();
  } catch (e) { /* 输入框不可用时静默降级为只读显示 */ }
}

/** 编辑中的框显示用户敲的内容，否则显示业务值。 */
function curFieldText(id, fallback) {
  try {
    if (bwe.textinput.editing === id) {
      var v = bwe.textinput.value(id);
      return v.length ? v : "_";
    }
  } catch (e) { /* ignore */ }
  return fallback;
}

/** 当前输入框的校验提示（合法返回空串）。 */
function inputHint(id) {
  try {
    return bwe.textinput.hint(id) || "";
  } catch (e) { return ""; }
}

/** 提交回调：把输入的数字应用回配置。 */
function applyInputField(id, text) {
  // 空/非数字：直接忽略（输入框本身也会给出「只能填数字」提示）
  var n = Number(text);
  if (!isFinite(n) || n <= 0) { wlog("输入配置 " + id + " 非法: " + text); return; }
  var want = Math.floor(n);
  MS[id] = want;
  clampConfig();
  pushBoard();
  // 被钳制时明确记录，方便玩家/我们看出「我填 1 为什么变成 5」
  if (MS[id] !== want) {
    wlog("输入配置 " + id + "=" + want + " 超出范围，已修正为 " + MS[id]);
  } else {
    wlog("输入配置 " + id + "=" + MS[id]);
  }
}

/** 行/列变化后把雷数钳到合法范围。 */
function clampConfig() {
  MS.rows = Math.max(5, Math.min(30, MS.rows));
  MS.cols = Math.max(5, Math.min(30, MS.cols));
  var cap = Math.max(1, MS.rows * MS.cols - 9);
  MS.mines = Math.max(1, Math.min(cap, MS.mines));
}

function changeValue(id, delta, max, min) {
  var v = MS[id] + delta;
  if (v < min) { v = min; }
  if (v > max) { v = max; }
  if (v === MS[id]) { return; }
  MS[id] = v;
  // 雷数上限随行×列变化
  var cap = Math.max(1, MS.rows * MS.cols - 9);
  if (MS.mines > cap) { MS.mines = cap; }
  pushBoard();
  wlog("配置 " + MS.rows + "×" + MS.cols + " · " + MS.mines + " 雷");
}

/** 胜负横幅：放在棋盘下方，绝不压在格子上。 */
function drawOverlay(W, H, br, S) {
  if (!S.over) { return; }
  var bw = 380, bh = 46;
  var x = Math.floor((W - bw) / 2);
  var y = br.h > 0 ? br.y + br.h + 12 : H - 120;
  if (y + bh > H) { y = Math.floor(H / 2); }
  bevelRaise(x, y, bw, bh);
  box(x + 2, y + 2, bw - 4, bh - 4, S.won ? "#d8f0d0" : "#f4d8d8");
  var msg = S.won ? cfg("labelWin", "✓ 通关！") : cfg("labelLose", "✗ 踩雷了");
  text(msg, x + bw / 2, y + 28, 18, S.won ? "#106010" : "#a00000", "center");
  text(cfg("labelRestart", "点笑脸 / 新游戏 再来一局"), x + bw / 2, y + 42, 12, "#303030", "center");
}

// ---------------------------------------------------------------- 竖屏 HUD

/** 竖屏顶带：窄标题 + 两个 LED + 笑脸。 */
function drawInfoBarPortrait(W, topH, S) {
  var titleH = 22;
  box(2, 2, W - 4, titleH, TITLE_BLUE1);
  box(2, 2, W - 4, 8, "#2a4b9b");
  text(MS.modeIdx === 1 ? "扫雷 · 复雷加殊" : cfg("bgTitle", "扫雷"), 8, 2 + titleH / 2, 14, cfg("silverLight", "#ffffff"), "left");
  drawTitleButtonsTiny(W, titleH);

  var cy = titleH + 8;
  var cw = 84, ch = 34;
  drawCounter(8, cy, cw, ch, S.mines - S.flags);
  drawCounter(W - 8 - cw, cy, cw, ch, Math.min(999, S.elapsed));

  var faceW = 30, faceH = 30;
  var face = { x: Math.floor((W - faceW) / 2), y: cy + 2, w: faceW, h: faceH };
  if (mouseDown() && hit(face)) { bevelSunken(face.x, face.y, face.w, face.h); }
  else { bevelRaise(face.x, face.y, face.w, face.h); }
  drawFace(face, S);
  if (clicked(face)) { bwe.mine.reset(); }
}

function drawTitleButtonsTiny(W, titleH) {
  var bw2 = 14, bh2 = 12;
  var x = W - 6 - bw2 * 3 - 6;
  var y = Math.floor((titleH - bh2) / 2) + 2;
  for (var i = 0; i < 3; i++) {
    var r = { x: x + i * (bw2 + 3), y: y, w: bw2, h: bh2 };
    bevelRaise(r.x, r.y, r.w, r.h);
    if (i === 2) {
      box(r.x + 4, r.y + 3, 6, 1, BLACK); box(r.x + 4, r.y + 6, 6, 1, BLACK);
      box(r.x + 4, r.y + 3, 1, 4, BLACK); box(r.x + 9, r.y + 3, 1, 4, BLACK);
    }
  }
}

/** 竖屏底带：三行步进器（每行一个「标签 + 值 + 上下」）。 */
function drawConfigBarPortrait(W, botY, botH) {
  var rowH = 26;
  var gy = botY + 8;
  var items = [
    { id: "rows", cfgKey: "labelRows", label: "行", min: 5, max: 30 },
    { id: "cols", cfgKey: "labelCols", label: "列", min: 5, max: 30 },
    { id: "mines", cfgKey: "labelMineCount", label: "雷", min: 1, max: Math.max(1, MS.rows * MS.cols - 9) },
  ];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var y = gy + i * rowH;
    // 竖屏标签用小字短名（配置对象里是长名，这里只取一个字）
    var shortName = it.id === "rows" ? "行" : it.id === "cols" ? "列" : "雷";
    text(shortName, 10, y + 17, 14, "#202020", "left");
    var fx = 34, fw = W - 34 - 66, fh = 20;
    bevelSunken(fx, y + 2, fw, fh);
    syncInputField(it.id, fx, y + 2, fw, fh, MS[it.id], it.min, it.max, W);
    var shown2 = curFieldText(it.id, String(MS[it.id]));
    var bad2 = inputHint(it.id);
    if (bwe.textinput.editing === it.id) {
      box(fx, y + 2, fw, fh, bad2 ? "#ffe0e0" : "#ffffff");
    }
    text(shown2, fx + fw / 2, y + 18, 15, bad2 ? "#c00000" : BLACK, "center");
    if (bad2) {
      text(bad2, fx + fw + 30, y + 18, 10, "#c00000", "left");
    }
    if (bwe.textinput.editing === it.id) {
      var tw2 = bwe.draw.measureText(shown2, 15).w;
      box(fx + fw / 2 + tw2 / 2 + 2, y + 5, 2, fh - 6, "#1a66ff");
    }
    var up = { x: fx + fw + 6, y: y + 2, w: 22, h: 9 };
    var dn = { x: fx + fw + 6, y: y + 13, w: 22, h: 9 };
    bevelRaise(up.x, up.y, up.w, up.h);
    bevelRaise(dn.x, dn.y, dn.w, dn.h);
    drawArrow(up, true);
    drawArrow(dn, false);
    if (clicked(up)) { changeValue(it.id, 1, it.max, it.min); }
    if (clicked(dn)) { changeValue(it.id, -1, it.max, it.min); }
  }
  // 竖屏右下：上面「模式」，下面「重局」——一列两个按钮，宽 52 高 22。
  var mb = { x: W - 60, y: gy + 4, w: 52, h: 22 };
  bevelRaise(mb.x, mb.y, mb.w, mb.h);
  if (MS.modeIdx === 1) { box(mb.x + 2, mb.y + 2, mb.w - 4, mb.h - 4, "#cfe0ff"); }
  text(MS.modeIdx === 1 ? "复雷" : "普通", mb.x + mb.w / 2, mb.y + mb.h / 2, 13, BLACK, "center");
  if (clicked(mb)) { toggleMode(); }

  var nb = { x: W - 60, y: gy + 30, w: 52, h: 22 };
  bevelRaise(nb.x, nb.y, nb.w, nb.h);
  text(cfg("labelRestart", "重局"), nb.x + nb.w / 2, nb.y + nb.h / 2, 13, BLACK, "center");
  if (clicked(nb)) { bwe.mine.reset(); }
}
