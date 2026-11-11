/**
 * 扫雷 · Minesweeper 主脚本（横屏工程与竖屏工程**共用这一份**，功能完全一致）。
 *
 * 设计要点：
 *   1. 素材（格子的风车小花 / 旗帜人头 / 雷）= 像素图，由 Java 端棋盘直接绘制，
 *      脚本**不**碰这些图，也不拉伸它们。
 *   2. 所有文字 / 数字 / 按钮全部走 `bwe.draw.text` + `bwe.draw.rect` 的独立图层：
 *      HUD 与像素素材彻底分离（文字永远是可编辑的、不被烤进图里）。
 *   3. UI 是 Win98 / Win2000 的经典银灰立体风格：标题栏 + 凸起按钮 + 凹陷输入框 +
 *      红字 LED 计数器 + 上左亮/下右暗的 3D 边框。
 *   4. 行 / 列 / 雷数在游戏内自选：− / + 步进键 + 点数值框直接键入（手机弹系统软键盘）。
 *   5. HUD 只占屏幕上/下两条带，绝不压住棋盘（棋盘位置由 camera.worldToScreen 实测）。
 *   6. **手机适配的关键**：相机按「上下 HUD 之间的可用区正好铺满棋盘」取景，
 *      而不是按整张地图取景。旧版走引擎默认的整图 contain（竖屏地图 1152×2048 塞进
 *      720×1602 视口 → zoom 只有 0.625），32px 的格子在手机上只剩 20px，
 *      既看不清也点不准。现在格子稳定放大，一指一格。
 *   7. 横屏与竖屏**只有 HUD 布局一套差别**：状态行、雷/旗/规格读数、步进器、
 *      模式切换、新游戏、帮助、复位视角，两边一一对等，缺一个就是 bug。
 */

// ---------------------------------------------------------------- 常量

var SILVER = "#c0c0c0";
var SILVER_LIGHT = "#ffffff";
var SILVER_MID = "#dfdfdf";
var SILVER_DARK = "#808080";
var SILVER_OUT = "#404040";
var BLACK = "#000000";
var TITLE_BLUE1 = "#0a246a";
var LED_RED = "#ff0000";
var LED_BG = "#1a0000";
var TEXT_DARK = "#000000";
var HINT_GRAY = "#303030";

var SFX = {
  flag: { a: "ms-sfx-flag", v: 0.85 },
  hit: { a: "ms-sfx-hit", v: 1.0 },
};
var BGM = { a: "ms-bgm", v: 0.28 };

/** 引擎的视口缩放上下限（Viewport.MIN_ZOOM / MAX_ZOOM），超出会被钳掉。 */
var ZOOM_MIN = 0.15;
var ZOOM_MAX = 4;

/**
 * 行列雷数的取值范围（与 Java 侧 Minesweeper.MAX_SIDE 一致，留 9 格首击安全区）。
 * 64×64 = 4096 格，是「超专家」棋盘。
 */
var ROW_MIN = 5, ROW_MAX = 64;
var COL_MIN = 5, COL_MAX = 64;

/** 格子边长的取值范围（世界像素；Java 侧同样钳 16~64）。 */
var CELL_MIN = 16, CELL_MAX = 64;

/**
 * 可读格子的下限（屏幕像素）。
 *
 * <p>这是 64×64 能玩的关键：4096 格在任何手机上都<b>不可能</b>「整盘可见又可读」
 * ——720 逻辑像素宽 ÷ 64 格 = 每格 11px，数字看不清、手指也点不准。
 * 所以大棋盘改成「保持可读 + 平移浏览」：格子至少这么大，装不下就靠拖动看别的区域。
 */
var CELL_READABLE = 28;

/**
 * 棋盘世界边长上限（= 工程地图边长 64 格 × tileSize 32 = 2048）。
 *
 * <p>必须是硬上限，不能只靠屏幕算：Android 的双指平移由引擎按<b>地图范围</b>钳制
 * （AndroidRuntimeBridge.setCamera → Viewport.clampCamera），棋盘一旦比地图大，
 * 超出地图的那部分格子<b>永远拖不到</b> —— 表现为「有些雷怎么都点不到、无法通关」。
 * 反过来把格子压到棋盘正好等于地图，整盘就都在可拖范围内。
 * 同时这也把离屏位图/纹理限制在 2048×2048（≈16MB），不会出现 4096² 的巨型纹理。
 */
var BOARD_MAX = 2048;

var MS = {
  cell: 32,
  engineCell: 0,          // 引擎里棋盘当前的格子尺寸（state() 不回传，自己记）
  baseZoom: 1,            // 本脚本给相机设的取景倍数（键盘平移按它换算速度）
  rows: 12,
  cols: 16,
  mines: 40,
  modeIdx: 0,             // 0 = 普通扫雷，1 = 复雷加殊 Complexweeper
  help: false,            // 帮助面板（占底带，棋盘随之重取景）
  fitKey: "",             // 上次取景的参数指纹；变了才重算（不跟双指缩放抢方向盘）
  viewW: 0, viewH: 0,     // 上次取景时的视口尺寸
};

var prev = { flags: -1, over: false, won: false };

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
  try {
    bwe.textinput.onSubmit(function (id, text) { applyInputField(id, text); });
  } catch (e) { wlog("textinput fail " + e); }

  // 初始规格**以工程里棋盘模块的参数为准**（横屏 12 行×16 列，竖屏 16 行×12 列 ——
  // 竖屏把行列反过来，正好让长边吃满手机的长边），不在脚本里硬编码。
  try {
    var s0 = bwe.mine.state();
    if (s0) {
      if (s0.rows > 0) { MS.rows = s0.rows; }
      if (s0.cols > 0) { MS.cols = s0.cols; }
      if (s0.mines > 0) { MS.mines = s0.mines; }
      // 模式以模块参数为准：必须在 pushBoard() 之前读，
      // 否则 pushBoard() 会把「复雷加殊」覆盖回「普通」。
      if (typeof s0.modeIndex === "number") { MS.modeIdx = s0.modeIndex; }
    }
  } catch (e) { wlog("state fail " + e); }
  pushBoard();
  wlog("start · " + MS.rows + "×" + MS.cols + " · " + MS.mines + " 雷 · 模式 "
    + (MS.modeIdx ? "复雷加殊" : "普通"));
  try { bwe.on("update", onUpdate); } catch (e) { wlog("onUpdate bind fail " + e); }
}

function pushBoard() {
  var L = layout();
  clampConfig();
  try {
    // 自动挑格子大小：让棋盘刚好填满上下 HUD 之间的可用区
    bwe.mine.set({
      rows: MS.rows, cols: MS.cols, mines: MS.mines, seed: 0,
      cellSize: autoCellSize(MS.rows, MS.cols, L),
      // 模式一并下发：set() 里 mode 变化也会 reset，合并成一次调用避免重置两次
      mode: MS.modeIdx === 1 ? "complex" : "normal",
    });
  } catch (e) { wlog("mine.set fail " + e); }
  MS.engineCell = MS.cell;
  fitBoard();
  fitCamera(L, true);
}

/** 在当前两种模式之间切换，并重建棋盘（行列雷数保持不变）。 */
function toggleMode() {
  MS.modeIdx = MS.modeIdx === 1 ? 0 : 1;
  pushBoard();
  wlog("模式 " + (MS.modeIdx ? "复雷加殊" : "普通"));
}

// ---------------------------------------------------------------- 布局（横屏 / 竖屏唯一的差别）

/**
 * 屏幕可用区能容下的最大格子边长（世界像素，16~64）。
 *
 * ⚠ 关键：这里**不再除以 zoom**。旧写法每帧读 `bwe.camera.zoom` 反算世界像素，
 * 玩家双指一放大，cell 就跟着变小 → 棋盘整体缩小，看起来像「缩放没生效、还在抖」。
 * 现在格子尺寸只由「可用区像素 / 行列数」决定，取景倍数交给相机（见 fitCamera）。
 */
function autoCellSize(rows, cols, L) {
  L = L || layout();
  var byW = Math.floor(L.bandW / cols);
  var byH = Math.floor(L.bandH / rows);
  var cell = Math.min(byW, byH);
  // 装不下时**不继续缩**：小于可读下限就没意义了（看不清还点不准），
  // 改成保持可读尺寸 + 平移浏览整盘。
  if (cell < CELL_READABLE) { cell = CELL_READABLE; }
  // 但也不能超过「地图 ÷ 行列数」，否则棋盘比地图大，那部分拖不到（见 BOARD_MAX）。
  var byBoard = Math.floor(BOARD_MAX / Math.max(rows, cols));
  if (cell > byBoard) { cell = byBoard; }
  cell = Math.max(CELL_MIN, Math.min(CELL_MAX, cell));
  MS.cell = cell;
  return cell;
}

/** 把棋盘对象的逻辑尺寸设成 cols×cell / rows×cell，让它和实际绘制的棋盘一致。 */
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

/**
 * 取景：把棋盘**居中到上下 HUD 之间的可用区**，必要时缩小到刚好塞进去。
 *
 * <p>为什么必须脚本接管相机：引擎默认视图是「整张地图 contain 居中」，
 * 而扫雷的地图（竖屏 36×64 格 = 1152×2048 世界像素）远大于棋盘本身，
 * 于是手机上 zoom≈0.625，32px 格子被压成 20px —— 看不清、点不准。
 * 现在格子尺寸直接按可用区算（见 autoCellSize），zoom 常态就是 1。
 *
 * <p>⚠ zoom **只降不升**（钳到 ≤1）：棋盘纹理是按 cell 画的像素图，
 * 放大走 GL_NEAREST 会糊成大色块。宁可留一点边，也不放大。
 *
 * <p>只按 fitKey 变化时重算（行列数 / 格子尺寸 / 可用区 / 视口尺寸）。
 * 双指缩放与拖动是玩家的手动接管，**不能**每帧被这里覆盖回去。
 */
function fitCamera(L, force) {
  L = L || layout();
  var st;
  try { st = bwe.mine.state(); } catch (e) { return; }
  var cell = MS.cell || 32;
  var bw = Math.max(1, st.cols * cell), bh = Math.max(1, st.rows * cell);
  var z = Math.min(L.bandW / bw, L.bandH / bh);
  // 大棋盘（64×64）：缩到「整盘可见」会把格子压到 11px，看不清也点不准。
  // 格子尺寸已经按可读下限算过，所以这里**保持 1:1**（GL_NEAREST 下 1:1 最锐利），
  // 装不下的部分靠双指/鼠标拖动浏览。
  if (z > 1) { z = 1; }
  if (cell * z < CELL_READABLE) { z = CELL_READABLE / cell; }
  z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  // 向下取整到两位小数：向上取整会让棋盘比可用区大出不到 1px，正好压住 HUD 边线；
  // 同时 0.9999999 与 1 的差别会让 fitKey 每帧都变，于是永远在重取景，
  // 玩家的双指缩放会被立刻抹掉。
  z = Math.floor(z * 100) / 100;
  var key = st.rows + "x" + st.cols + "/" + cell + "@" + L.bandW + "x" + L.bandH
    + "|" + L.bandY0 + "," + L.H + "|" + (L.portrait ? "p" : "l");
  if (!force && key === MS.fitKey) { return; }
  MS.fitKey = key;
  MS.baseZoom = z;
  try {
    var b = bwe.world.find("棋盘 Minesweeper");
    var bx = b ? b.x : L.W / 2, by = b ? b.y : L.H / 2;
    // screenY(worldY) = H/2 + (worldY - camY) * zoom
    // 要让棋盘中心落在带中心 bandCy：camY = by - (bandCy - H/2)/zoom
    var bandCy = (L.bandY0 + L.bandY1) / 2;
    var c = clampCam(bx, by - (bandCy - L.H / 2) / z, bx, by, bw, bh, z, L);
    bwe.camera.setZoom(z);
    bwe.camera.setPos(c.x, c.y);
  } catch (e) { wlog("camera fail " + e); }
}

/**
 * 读数/提示行占的垂直空间（缝 10 + 字形盒高 size*1.32 + 收尾 4）。
 *
 * ⚠ 底带高度与提示行的 y 必须用**同一个**算式：以前一个写 6+fs、另一个写 fs*0.5，
 * 结果 13px 的字顶边比上一行按钮底只低 5px，文字挤在 −/+ 按钮下边缘上。
 */
function tipGap(fs) {
  return 10 + Math.round(fs * 1.32) + 4;
}

/** 提示行实际字号（与 drawConfigBar 里画读数用的字号保持一致）。 */
function tipFs(L) {
  return Math.max(11, L.fs - 2);
}

/**
 * 把视野钳在棋盘内（只有棋盘比视野大时才钳，否则整屏都是棋盘，不用动）。
 *
 * <p>为什么脚本自己钳：桌面端脚本一旦接管相机，引擎就不再钳制
 * （{@code applyCameraPolicy} 见 scriptCameraControl 直接 return），
 * 平移过头会看到一片地图底色。Android 的双指平移由引擎按**地图**钳，
 * 而棋盘（≤2048）始终在地图（64 瓦片 × 32 = 2048）内，那边不会跑飞。
 *
 * <p>返回 {x, y} 而不是数组：bwe.camera.setPos(a, b) 是两个数参数，
 * 传数组进去 Rhino 会取不到数字而退回默认值（表现为「纵向拖不动」）。
 */
function clampCam(camX, camY, bx, by, bw, bh, z, L) {
  var halfW = L.W / (2 * z), halfH = L.H / (2 * z);
  if (bw > halfW * 2) {
    camX = Math.max(bx - bw / 2 + halfW, Math.min(bx + bw / 2 - halfW, camX));
  }
  if (bh > halfH * 2) {
    camY = Math.max(by - bh / 2 + halfH, Math.min(by + bh / 2 - halfH, camY));
  }
  return { x: camX, y: camY };
}

/**
 * 键盘平移（桌面/编辑器）：方向键或 WASD。
 *
 * <p>为什么不用鼠标拖动：引擎在**按下**那一帧就把点击派发给棋盘，
 * 按下起拖会先翻开一格（可能正好是雷），所以拖动平移在扫雷里不安全。
 * Android 的双指平移不受影响（短按才派发点击，双指手势会取消本次点击）。
 */
var PAN_SPEED = 420;   // 世界像素/秒

function handlePan(dt, L) {
  var dx = 0, dy = 0;
  try {
    if (bwe.input.down("ArrowLeft") || bwe.input.down("KeyA")) { dx -= 1; }
    if (bwe.input.down("ArrowRight") || bwe.input.down("KeyD")) { dx += 1; }
    if (bwe.input.down("ArrowUp") || bwe.input.down("KeyW")) { dy -= 1; }
    if (bwe.input.down("ArrowDown") || bwe.input.down("KeyS")) { dy += 1; }
  } catch (e) { return; }
  if (dx === 0 && dy === 0) { return; }
  var z = MS.baseZoom || 1;
  try {
    var st = bwe.mine.state();
    var cell = MS.cell || 32;
    var b = bwe.world.find("棋盘 Minesweeper");
    if (!b) { return; }
    // 读当前相机再增量：直接算绝对值会和双指缩放互相覆盖
    var p = bwe.camera.pos;
    var c = clampCam(p.x + dx * PAN_SPEED * dt / z, p.y + dy * PAN_SPEED * dt / z,
      b.x, b.y, st.cols * cell, st.rows * cell, z, L);
    bwe.camera.setPos(c.x, c.y);
  } catch (e2) { }
}

/**
 * 当前 HUD 布局。**所有**尺寸只从这里出，杜绝「底带高度改了、格子算式没跟着改」
 * 这类注释里警告过的同步坑。
 *
 * @returns {{W:number,H:number,portrait:boolean,safeTop:number,safeBot:number,
 *            topH:number,botH:number,bandY0:number,bandY1:number,bandW:number,bandH:number,
 *            rowH:number,btnW:number,ledW:number,ledH:number,face:number,fs:number,s:number,titleH:number}}
 */
function layout() {
  var scr = screenSize();
  var W = scr.w, H = scr.h;
  var portrait = isPortrait(W, H);
  // 安全边距：刘海/挖孔屏与全面屏手势条。Android 主题已是全屏，
  // 但手势导航条仍会盖住最底下一小条，所以底带留可配置的内缩（HUD 配置里改）。
  var safeTop = Math.max(0, numCfg("safeTop", portrait ? 8 : 0));
  var safeBot = Math.max(0, numCfg("safeBottom", portrait ? 14 : 8));
  // 窄屏（桌面小窗 / 低逻辑分辨率）按比例缩，但触摸目标不得低于 34×30。
  var s = Math.max(0.72, Math.min(1, W / 720));

  var rowH = Math.round(Math.max(40, Math.min(52, 44 * s)));
  var ledW = Math.round(Math.max(76, Math.min(120, 108 * s)));
  var ledH = Math.round(Math.max(34, Math.min(48, 44 * s)));
  var fs = Math.round(Math.max(12, Math.min(17, 15 * s)));
  // 标题条固定 40：要装得下一整颗按钮（手机上点得到），不随屏宽缩
  var titleH = 40;
  // 笑脸不能超过 LED 行高，否则会压到下面的状态行
  var face = Math.round(Math.max(34, Math.min(ledH, 46 * s)));
  // 步进键：**横竖屏都是「− / +」左右并排、整行高**。
  // 旧版是上下叠的 22×9 小箭头，手机上只有 2mm，根本点不准（自检会直接判失败）。
  var stepW = Math.round(Math.max(34, Math.min(46, 42 * s)));
  var fieldH = Math.max(26, rowH - 10);

  // 顶带：标题条 + 「说明文字 + LED/笑脸」行 + 状态行。
  // ⚠ 这里的每一项必须与 drawInfoBar 的 y 算式一一对应，改一处要同时改另一处，
  // 否则状态行会被裁掉或压进棋盘可用区（棋盘按 bandY0 取景）。
  var labelH = Math.max(12, fs - 2);
  var msgH = Math.round(fs * 1.32);            // 状态行的字形盒高
  var topH = 2 + titleH + 4 + (labelH + 6) + ledH + 4 + (msgH + 6) + 6 + safeTop;
  // 底带：三行步进器 + 读数/提示行；帮助打开时整块换成帮助面板
  //（棋盘随之重取景，保证帮助区永远在棋盘矩形之外 —— 点「关闭」不会顺带翻开一格）。
  var botH;
  if (MS.help) {
    // 面板上下各留 8px 边距；内容高度由 helpLayout 一处算出，
    // 与 drawHelpPanel 画文字用的是同一份数据（否则「高度按 A 算、文字按 B 画」会裁行）
    botH = 8 + helpLayout(W, H, portrait, fs).panelH + 8 + safeBot;
  } else {
    botH = 8 + rowH * 3 + tipGap(Math.max(11, fs - 2)) + safeBot;
  }
  var bandY0 = topH;
  var bandY1 = H - botH;
  var bandW = Math.max(40, W - (portrait ? 12 : 20));
  var bandH = Math.max(40, bandY1 - bandY0);

  return {
    W: W, H: H, portrait: portrait, safeTop: safeTop, safeBot: safeBot,
    topH: topH, botH: botH, bandY0: bandY0, bandY1: bandY1, bandW: bandW, bandH: bandH,
    rowH: rowH, fieldH: fieldH, stepW: stepW,
    btnW: Math.round(Math.max(64, Math.min(92, 84 * s))),
    ledW: ledW, ledH: ledH, face: face, fs: fs, s: s, titleH: titleH, labelH: labelH,
  };
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

  // —— 视口变化（转屏 / 改窗口大小 / 手机分屏）→ 重算格子并重新取景 ——
  //
  // ⚠ 重算格子必须走 bwe.mine.set（Java 侧 GridBoard 的 cell 是 final，只能重建），
  // 代价是**这一局会重新开始**。为什么仍然要做：不重算的话，转屏后格子尺寸停留在
  // 旧视口的值（竖屏 16 行在横屏视口下算出 25px），手机上小到看不清、点不准 ——
  // 那比重新开一局严重得多。首次 onSceneStart 时视口已经是最终值，不会白重置。
  var L = layout();
  if (L.W !== MS.viewW || L.H !== MS.viewH) {
    MS.viewW = L.W; MS.viewH = L.H;
    var newCell = autoCellSize(S.rows, S.cols, L);
    // 只有引擎里真的不是这个尺寸才重建（state() 不回传 cellSize，所以自己记一份）
    if (newCell !== MS.engineCell) {
      try { bwe.mine.set({ cellSize: newCell }); } catch (e) { wlog("resize set fail " + e); }
      MS.engineCell = newCell;
      fitBoard();
    }
    fitCamera(L, true);
  } else {
    // 帮助开合会改底带高度 → 可用区变，需要重取景（fitKey 自己会判断）
    fitCamera(L, false);
  }

  handlePan(dt, L);
  try { drawHud(S, L); } catch (e) { drawErr(e); }
}

/** 把一块屏幕区域登记为「界面区」，让引擎吃掉落在其中的点击（见 TopDownRuntime.hudBlocks）。 */
function blockBand(id, x, y, w, h) {
  try { bwe.input.block(id, x, y, w, h); } catch (e) { /* 老引擎没这个 API：静默降级 */ }
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

/** 屏幕是横屏还是竖屏：竖屏时 HUD 走竖屏分支（见 layout）。 */
function isPortrait(W, H) { return H > W * 1.05; }

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

/** 量一段文字的宽度（帮助面板自动换行用）。 */
function textW(s, size) {
  try {
    var m = bwe.draw.measureText(s, size);
    if (m && m.w > 0) { return m.w; }
  } catch (e) { }
  return s.length * size * 0.62;
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

/** 左键当前按住（桌面拖动/长按视觉用）。 */
function mouseDown() {
  try { return !!bwe.input.down("mouse0"); } catch (e) { return false; }
}

/** 左键本帧刚按下（所有点击判定用它，见 clicked）。 */
function mousePressed() {
  try { return !!bwe.input.pressed("mouse0"); } catch (e) { return false; }
}

/**
 * 一次点击：本帧刚按下、且指针落在 r 内时为 true。
 * 同一帧里多个按钮只有第一个命中（pressed 每帧只给一次边沿）。
 *
 * ⚠ 手机侧语义：Android 把「短按」翻译成一次左键（抬起才派发），
 * 「长按 400ms」翻译成一次右键（插旗）。所以 HUD 按钮在手机上点一下就生效，
 * 格子靠长按插旗 —— 帮助面板里写明了这一点。
 */
function clicked(r) {
  // 边沿由引擎给（bwe.input.pressed）：手机上一次短按只在一帧里为真，
  // 自己记上一帧状态的话，相邻两帧的两次点击会漏掉第二次。
  return hit(r) && mousePressed();
}

/**
 * 凸起按钮 + 文字 + 点击判定（横竖屏共用，保证两边按钮长得一样、点得一样）。
 * @param {{x:number,y:number,w:number,h:number}} r
 * @param {string} label
 * @param {number} fs 字号
 * @param {string} tint 当前选中态的底色（无选中态传 null）
 * @param {string} [id] 调试/自检用标识（进 BTN 表）
 * @returns {boolean} 本帧是否被点击
 */
function button(r, label, fs, tint, id) {
  bevelRaise(r.x, r.y, r.w, r.h);
  if (tint) { box(r.x + 2, r.y + 2, r.w - 4, r.h - 4, tint); }
  if (hit(r) && mouseDown()) { box(r.x + 2, r.y + 2, r.w - 4, r.h - 4, "#a8a8a8"); }
  text(label, r.x + r.w / 2, r.y + r.h / 2, fs, BLACK, "center");
  pushBtn(id || label, r);
  return clicked(r);
}

/** 登记一个可点区域（自检工具据此验证触摸目标尺寸与互不重叠；不参与渲染）。 */
function pushBtn(id, r) {
  BTN.push({ id: id, x: r.x, y: r.y, w: r.w, h: r.h });
}

function pad3(n) {
  var s = String(Math.max(0, Math.floor(n)));
  while (s.length < 3) { s = "0" + s; }
  return s;
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

// ---------------------------------------------------------------- 可编辑 HUD 配置

/** HUD 配置对象（场景里叫「HUD 配置」）：文案 / 配色 / 安全边距都在它的 props 里。 */
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

/** 读一条数值配置（安全边距等）；非法值退回 fallback。 */
function numCfg(key, fallback) {
  var v = Number(cfg(key, String(fallback)));
  return isFinite(v) ? v : fallback;
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

var BTN = [];         // 本帧可点区域（pushBtn 登记；自检据此验证触摸目标与重叠）

// ---------------------------------------------------------------- HUD 主流程

function drawHud(S, L) {
  BTN = [];
  var W = L.W, H = L.H;
  var br = boardScreenRect();

  box(0, 0, W, L.topH, SILVER);
  bevelSunken(0, 0, W, L.topH);
  box(0, H - L.botH, W, L.botH, SILVER);
  bevelSunken(0, H - L.botH, W, L.botH);
  // 大棋盘（64×64）会伸到两条带底下。引擎的点击派发是「脚本 → 棋盘」且脚本无法拦截，
  // 所以必须显式声明这两块是界面区，否则点「新游戏」会顺带翻开底下的格子（可能直接踩雷）。
  blockBand("hudTop", 0, 0, W, L.topH);
  blockBand("hudBottom", 0, H - L.botH, W, L.botH);

  drawInfoBar(W, L, S);
  if (MS.help) {
    drawHelpPanel(W, L);
  } else {
    drawConfigBar(W, L, S);
  }
  drawOverlay(W, H, br, L, S);
}

/**
 * 顶带：标题栏 + 两个 LED 计数器 + 笑脸 + 状态行（横竖屏内容完全一致）。
 */
function drawInfoBar(W, L, S) {
  var portrait = L.portrait;
  var pad = portrait ? 8 : 16;
  var titleH = L.titleH;
  var ty = L.safeTop + 2;
  // 标题栏（Win98 经典深蓝 → 浅蓝渐变，用两段纯色近似）
  box(2, ty, W - 4, titleH, TITLE_BLUE1);
  box(2, ty, W - 4, Math.round(titleH * 0.4), "#2a4b9b");
  var titleTxt = MS.modeIdx === 1
    ? cfg("bgTitleComplex", "扫雷 · 复雷加殊 Complexweeper")
    : cfg("bgTitle", "扫雷 · Minesweeper");
  text(titleTxt, pad + 2, ty + titleH / 2, Math.max(12, L.fs - 1), cfg("silverLight", "#ffffff"), "left");

  // 标题栏右侧：一个带文字的「复位视角」按钮（横竖屏同一颗）。
  // 旧版横屏画的是三个 22×16 的假窗口按钮（最小化/最大化/关窗），
  // 既点不准、语义也和游戏无关；竖屏干脆没有。现在两边一一对等。
  var rw = Math.round(Math.max(72, 92 * L.s)), rh = Math.max(34, titleH - 6);
  var rbtn = { x: W - 4 - rw, y: ty + (titleH - rh) / 2, w: rw, h: rh };
  if (button(rbtn, cfg("labelResetView", "复位视角"), Math.max(12, L.fs - 2), null, "resetView")) { resetView(); }

  // LED 计数器：剩余雷数 / 用时（说明文字独占一行，在计数器上方）
  var labelH = Math.max(12, L.fs - 2);
  var cy = ty + titleH + 4 + labelH + 6;
  var cw = L.ledW, ch = L.ledH;
  var leftX = pad, rightX = W - pad - cw;
  drawCounter(leftX, cy, cw, ch, S.mines - S.flags);
  drawCounter(rightX, cy, cw, ch, Math.min(999, S.elapsed));
  // 计数器上方的说明文字（同样来自可编辑配置）
  text(cfg("labelMines", "剩余雷数"), leftX, cy - labelH / 2 - 4, Math.max(10, L.fs - 4), HINT_GRAY, "left");
  text(cfg("labelTime", "用时"), rightX, cy - labelH / 2 - 4, Math.max(10, L.fs - 4), HINT_GRAY, "left");

  // 中间：笑脸按钮（新游戏）
  var fw = L.face;
  var face = { x: Math.floor((W - fw) / 2), y: cy + Math.floor((ch - fw) / 2), w: fw, h: fw };
  if (mouseDown() && hit(face)) { bevelSunken(face.x, face.y, face.w, face.h); }
  else { bevelRaise(face.x, face.y, face.w, face.h); }
  drawFace(face, S);
  pushBtn("face", face);
  if (clicked(face)) {
    bwe.mine.reset();
    wlog("新游戏");
  }

  // 状态行：当前局面 + 操作提示（横竖屏都有，内容一致）
  var msgY = cy + ch + 4 + Math.round(L.fs * 0.66);   // 字形盒垂直居中
  text(statusLine(S), W / 2, msgY, L.fs, TEXT_DARK, "center");
  putLabel("标题 扫雷", pad, ty + titleH / 2);
  putLabel("提示 玩法", pad, msgY);
}

/** 当前局面的一句话说明（横竖屏共用，杜绝「竖屏没有状态提示」）。 */
function statusLine(S) {
  if (S.over) {
    return S.won ? cfg("labelWinStatus", "恭喜！全部安全格已翻开")
      : cfg("labelLoseStatus", "踩到雷了，按笑脸或「新游戏」重开");
  }
  if (MS.modeIdx === 1) {
    return S.started
      ? "复雷加殊 · 数字 = 周围雷之和的模长 · 点数字可连锁翻开"
      : "先点一格（首击必安全）· 长按/右键插旗 · 点数字可连锁翻开";
  }
  return S.started
    ? "进行中 · 点格翻开 / 长按或右键插旗 · 点数字可连锁翻开"
    : "先点一格（首击必安全）· 长按/右键插旗 · 点数字要旗数对齐";
}

function resetView() {
  MS.fitKey = "";
  fitCamera(layout(), true);
  wlog("复位视角");
}

/** 红色 LED 计数器（黑底凹陷 + 红字）。 */
function drawCounter(x, y, w, h, value) {
  bevelSunken(x, y, w, h);
  box(x + 5, y + 5, w - 10, h - 10, LED_BG);
  var fs = Math.max(18, Math.min(30, Math.round(h * 0.62)));
  text(pad3(value), x + w / 2, y + h / 2, fs, LED_RED, "center");
}

/** 笑脸：凹陷格 + 像素笑脸（表情随状态变化，尺寸随 face 自适应）。 */
function drawFace(r, S) {
  var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  var u = r.w / 34;                       // 基准是 34px 笑脸，按尺寸等比放大
  var eye = Math.max(2, Math.round(3 * u));
  var mw = Math.max(8, Math.round(12 * u));
  var lw = Math.max(2, Math.round(u));
  var sw = Math.max(2, Math.round(3 * u));
  box(cx - 8 * u, cy - 6 * u, eye, eye, BLACK);
  box(cx + 5 * u, cy - 6 * u, eye, eye, BLACK);
  if (S.over && !S.won) {
    // 倒霉脸：嘴角向下
    box(cx - mw / 2, cy + 7 * u, mw, lw, BLACK);
    box(cx - mw / 2, cy + 5 * u, sw, lw, BLACK);
    box(cx + mw / 2 - sw, cy + 5 * u, sw, lw, BLACK);
  } else if (S.over && S.won) {
    // 赢：大笑 + 墨镜
    box(cx - 9 * u, cy - 7 * u, Math.round(18 * u), Math.max(3, Math.round(6 * u)), BLACK);
    box(cx - mw / 2, cy + 4 * u, mw, Math.max(2, Math.round(3 * u)), BLACK);
  } else {
    box(cx - mw / 2, cy + 5 * u, mw, lw, BLACK);
    box(cx - mw / 2, cy + 3 * u, sw, lw, BLACK);
    box(cx + mw / 2 - sw, cy + 3 * u, sw, lw, BLACK);
  }
}

/**
 * 底带：行 / 列 / 雷数 三组步进器 + 新游戏 + 模式 + 帮助 + 读数/范围提示。
 *
 * <p><b>为什么必须按「列」分区而不是按「行」叠</b>（玩家反馈「竖屏按钮太挤」的根因）：
 * 旧布局里输入框右边距只留 66px，▲▼ 箭头放在 x=W-66，而右下的「模式 / 重局」按钮
 * 放在 x=W-60、y=gy+4 / gy+30 —— 两者的 x 与 y 范围都重叠，箭头被压在按钮下面、
 * 点击还会互相抢（点箭头可能触发重局），而且箭头只有 22×9，手指根本点不准。
 *
 * <p>现在的分区（横竖屏**同一套行结构**，只是宽度不同）：
 * <pre>
 *   标签 │ − │ 数值框 │ + │（右侧独立一列：新游戏 / 模式 / 帮助）
 * </pre>
 * 步进键改成左右并排、整行高的 − / +（旧版上下叠的 22×9 小箭头在手机上只有 2mm，
 * 点不准）；数值框点一下直接弹软键盘键入。所有可点区域 ≥34 逻辑像素见 layout()。
 */
function drawConfigBar(W, L, S) {
  var portrait = L.portrait;
  var botY = L.H - L.botH;
  var rowH = L.rowH;
  var gy = botY + 8;
  var pad = portrait ? 8 : 14;

  // ---- 水平分区（先算好，后面所有元素都按它排，杜绝重叠）----
  var btnW = L.btnW;
  var btnX = W - pad - btnW;
  var stepW = L.stepW;
  // 标签宽度**实测**：竖屏用短名（行/列/雷），横屏用配置全名（行 Rows）。
  // 之前按 40px 估，横屏「行 Rows」实际 ~46px，被 − 按钮切掉一半。
  var lfs = portrait ? L.fs : Math.max(11, L.fs - 3);
  // 竖屏只画空格前的短名，横屏画全名 —— 量的必须是**真正画出来的那串**
  var caps = [cfg("labelRows", "行 Rows"), cfg("labelCols", "列 Cols"), cfg("labelMineCount", "雷 Mines")];
  if (portrait) {
    for (var ci = 0; ci < caps.length; ci++) { caps[ci] = caps[ci].replace(/\s+.*$/, ""); }
  }
  var labelMax = 0;
  for (var cj = 0; cj < caps.length; cj++) {
    var tw2 = textW(caps[cj], lfs);
    if (tw2 > labelMax) { labelMax = tw2; }
  }
  var labelW = Math.round(Math.max(30, labelMax + 8));
  var minusX = pad + labelW;
  var fieldX = minusX + stepW + 6;
  var fieldW = Math.max(60, btnX - 8 - stepW - 6 - fieldX);
  var fieldH = L.fieldH;
  var plusX = fieldX + fieldW + 6;

  var items = [
    { id: "rows", cap: "Rows", label: "行 Rows", value: MS.rows, min: ROW_MIN, max: ROW_MAX },
    { id: "cols", cap: "Cols", label: "列 Cols", value: MS.cols, min: COL_MIN, max: COL_MAX },
    { id: "mines", cap: "MineCount", label: "雷 Mines", value: MS.mines, min: 1, max: Math.max(1, MS.rows * MS.cols - 9) },
  ];

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var y = gy + i * rowH;
    var rowCy = y + rowH / 2;
    var boxY = y + (rowH - fieldH) / 2;
    // 标签：竖屏只取空格前的短名（宽度有限），横屏用配置全名；两边读同一份配置
    var cap = cfg("label" + it.cap, it.label);
    text(portrait ? cap.replace(/\s+.*$/, "") : cap, pad + 2, rowCy, lfs, HINT_GRAY, "left");
    // 凹陷数值框
    bevelSunken(fieldX, boxY, fieldW, fieldH);
    syncInputField(it.id, fieldX, boxY, fieldW, fieldH, it.value, it.min, it.max, W);
    var shown = curFieldText(it.id, String(it.value));
    var bad = inputHint(it.id);
    if (bwe.textinput.editing === it.id) {
      box(fieldX, boxY, fieldW, fieldH, bad ? "#ffe0e0" : "#ffffff");
    }
    text(shown, fieldX + fieldW / 2, boxY + fieldH / 2, L.fs + 1, bad ? "#c00000" : BLACK, "center");
    if (bad) { text(bad, fieldX + fieldW / 2, boxY - 8, Math.max(10, L.fs - 4), "#c00000", "center"); }
    if (bwe.textinput.editing === it.id) {
      var tw = textW(shown, L.fs + 1);
      box(fieldX + fieldW / 2 + tw / 2 + 3, boxY + 4, 2, fieldH - 8, "#1a66ff");
    }
    // − / +：整行高，分列数值框左右
    var minusR = { x: minusX, y: y, w: stepW, h: rowH };
    var plusR = { x: plusX, y: y, w: stepW, h: rowH };
    stepperBtn(minusR, false);
    stepperBtn(plusR, true);
    pushBtn(it.id + "-", minusR);
    pushBtn(it.id + "+", plusR);
    if (clicked(minusR)) { changeValue(it.id, -1, it.max, it.min); }
    if (clicked(plusR)) { changeValue(it.id, 1, it.max, it.min); }
  }

  // ---- 右侧按钮列（独占一列，与输入区不重叠；三颗按钮正好铺满三行高度）----
  var bGap = 6;
  var bH = Math.max(34, Math.floor((rowH * 3 - bGap * 2) / 3));
  var bfs = Math.max(13, L.fs);
  var nb = { x: btnX, y: gy, w: btnW, h: bH };
  if (button(nb, cfg("labelNewGame", "新游戏"), bfs, null, "newGame")) {
    bwe.mine.reset();
    wlog("新游戏（" + MS.rows + "×" + MS.cols + " · " + MS.mines + "）");
  }
  var mb = { x: btnX, y: gy + bH + bGap, w: btnW, h: bH };
  if (button(mb, MS.modeIdx === 1 ? cfg("labelModeComplex", "模式：复雷") : cfg("labelModeNormal", "模式：普通"),
    bfs, MS.modeIdx === 1 ? "#cfe0ff" : null, "mode")) {
    toggleMode();
  }
  var hb = { x: btnX, y: gy + (bH + bGap) * 2, w: btnW, h: bH };
  if (button(hb, cfg("labelHelp", "帮助"), bfs, MS.help ? "#cfe0ff" : null, "help")) {
    MS.help = true;
    MS.fitKey = "";
    wlog("帮助 开");
  }

  // ---- 读数 + 范围提示（横竖屏同一行内容）----
  var tipY = gy + rowH * 3 + 10 + Math.round(tipFs(L) * 0.66);
  var readout = "雷 " + S.mines + " · 旗 " + S.flags + " · " + S.rows + "×" + S.cols
    + " · 格 " + (MS.cell || 32) + "px";
  var rangeTip = MS.modeIdx === 1
    ? cfg("labelRangeComplex", "复雷加殊：点数字连锁翻开需①旗数正确 ②虚实比例正确")
    : cfg("labelRange", "行 5–64 · 列 5–64 · 雷 1–(行×列−9) · 点数值可直接输入");
  text(readout, pad + 2, tipY, tipFs(L), TEXT_DARK, "left");
  text(rangeTip, W - pad - 2, tipY, tipFs(L), "#404040", "right");
}

/**
 * 帮助正文（唯一来源）：按当前宽度换行，返回要画的每一行。
 *
 * ⚠ layout() 用它算面板高度、drawHelpPanel() 用它画文字 ——
 * 两处必须同一个函数，否则「高度按一套算、文字按另一套画」就会裁掉最后几行。
 */
function helpLines(W, portrait, fs) {
  var pad = portrait ? 10 : 16;
  var maxW = W - pad * 2 - 20;
  var raw = [
    { t: cfg("helpTitle", "扫雷玩法"), c: TITLE_BLUE1, b: true },
    { t: cfg("help1", "翻开：点一下未翻开的格子；数字表示周围 8 格里有几颗雷。"), c: "#202020" },
    { t: cfg("help2", "插旗：手机上长按格子（电脑右键）标雷，剩余雷数跟着减。"), c: "#202020" },
    { t: cfg("help3", "连锁：点已翻开的数字格，旗数与数字对齐时把周围一次翻开。"), c: "#202020" },
    { t: cfg("help4", "首击必安全：第一下永远不是雷；翻开全部安全格即通关。"), c: "#202020" },
    { t: cfg("help5", "复雷加殊：雷有虚实（+1/−1/+i/−i），数字是周围雷之和的模长，连锁翻开还要求旗的虚实比例也对。"), c: "#403010" },
    { t: cfg("help6", "手机：双指缩放画面、双指拖动平移；点数值框可直接键入行列雷数。"), c: "#202020" },
    { t: cfg("help7", "大棋盘（如 64×64）：格子保持可读大小，一屏放不下，靠平移浏览整盘。"), c: "#202020" },
    { t: cfg("help8", "平移：手机双指拖动；电脑用方向键或 WASD。「复位视角」回到中间。"), c: "#202020" },
  ];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var seg = wrapText(raw[i].t, raw[i].b ? fs + 2 : fs, maxW);
    for (var j = 0; j < seg.length; j++) {
      out.push({ s: seg[j], c: raw[i].c, b: raw[i].b });
    }
  }
  return out;
}

/**
 * 帮助面板的完整排版：行内容、行距、关闭按钮尺寸、面板总高度。
 * 高度里已经把「关闭按钮那一行」算进去，所以文字永远不会压在按钮上。
 */
var HELP_CACHE = { key: "", val: null };

function helpLayout(W, H, portrait, fs) {
  var key = W + "|" + H + "|" + (portrait ? 1 : 0) + "|" + fs + "|" + HUDKEY();
  if (HELP_CACHE.key === key && HELP_CACHE.val) { return HELP_CACHE.val; }
  var lay = helpLayoutRaw(W, H, portrait, fs);
  HELP_CACHE.key = key; HELP_CACHE.val = lay;
  return lay;
}

/** 帮助文案指纹：编辑器里改过任何一条，缓存就要失效。 */
function HUDKEY() {
  return cfg("helpTitle", "") + "|" + cfg("help1", "") + "|" + cfg("help2", "") + "|" +
    cfg("help3", "") + "|" + cfg("help4", "") + "|" + cfg("help5", "") + "|" + cfg("help6", "") + "|" + cfg("help7", "") + "|" + cfg("help8", "");
}

function helpLayoutRaw(W, H, portrait, fs) {
  var lh = Math.round(fs * 1.55);
  var chh = Math.max(32, Math.round(fs * 2.2));
  var lines = helpLines(W, portrait, fs);
  var firstCy = 10 + Math.round(fs * 0.6);      // 第一行中心（相对面板顶）
  var panelH = firstCy + lines.length * lh + 6 + chh + 10;
  // 内容再多也不吃掉整个屏幕：最多占一半，且不超过 460
  var cap = Math.round(Math.max(140, Math.min(H * 0.5, 460)));
  return {
    lh: lh, chh: chh, lines: lines, firstCy: firstCy,
    panelH: Math.round(Math.min(panelH, cap)),
  };
}

/**
 * 帮助面板：占整条底带（底带此时已按内容加高）。
 *
 * ⚠ 为什么放在底带而不是浮在屏幕中间：引擎的点击派发顺序是「脚本 → 棋盘」，
 * 脚本**无法**拦下落在棋盘矩形内的点击。所以任何盖在棋盘上的浮层，
 * 点它的关闭按钮都会顺带翻开一格（可能直接踩雷）。把帮助留在底带、
 * 同时让棋盘重取景到剩下的可用区，就能保证帮助区永远在棋盘之外。
 */
function drawHelpPanel(W, L) {
  var fs = Math.max(12, L.fs);
  var HP = helpLayout(W, L.H, L.portrait, fs);
  var botY = L.H - L.botH;
  var pad = L.portrait ? 10 : 16;
  var x = pad, y = botY + 8;
  var w = W - pad * 2, h = L.botH - 16 - L.safeBot;
  bevelSunken(x, y, w, h);
  box(x + 3, y + 3, w - 6, h - 6, "#f4f1e8");

  var cy = y + HP.firstCy;
  var limit = y + h - HP.chh - 12;      // 文字一律停在关闭按钮之上
  for (var i = 0; i < HP.lines.length; i++) {
    if (cy > limit) { break; }
    text(HP.lines[i].s, x + 10, cy, HP.lines[i].b ? fs + 2 : fs, HP.lines[i].c, "left");
    cy += HP.lh;
  }
  var cw = Math.round(Math.max(64, 78 * L.s));
  var closeR = { x: x + w - cw - 6, y: y + h - HP.chh - 6, w: cw, h: HP.chh };
  if (button(closeR, cfg("labelClose", "关闭"), Math.max(13, fs), null, "close")) {
    MS.help = false;
    MS.fitKey = "";
    wlog("帮助 关");
  }
}

/** 单个字符的估算宽度（CJK ≈ 1em，ASCII ≈ 0.55em）—— 只用于断行，不用于绘制。 */
function estCharW(ch, fs) {
  return ch.charCodeAt(0) > 0x2000 ? fs : fs * 0.55;
}

/**
 * 按像素宽度把一段文案切成多行（中文按字断行）。
 *
 * ⚠ 不要逐字调 bwe.draw.measureText：帮助面板每帧都要排版，逐字度量会把
 * 字体度量次数放大到几百次/帧。这里先用估算宽度切行，再对**成品行**量一次，
 * 真的超宽才缩紧重切 —— 度量次数与文本长度无关。
 */
function wrapText(s, fs, maxW) {
  var out = [];
  if (textW(s, fs) <= maxW) { out.push(s); return out; }
  var budget = maxW;
  for (var guard = 0; guard < 4; guard++) {
    out = [];
    var cur = "", curW = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var cw = estCharW(ch, fs);
      if (cur.length && curW + cw > budget) {
        out.push(cur);
        cur = ch; curW = cw;
      } else {
        cur += ch; curW += cw;
      }
    }
    if (cur.length) { out.push(cur); }
    // 估算偏小时（英文多）实测会超宽 → 收紧预算重切一次
    var over = false;
    for (var j = 0; j < out.length; j++) {
      if (textW(out[j], fs) > maxW + 1) { over = true; break; }
    }
    if (!over) { break; }
    budget = budget * 0.88;
  }
  return out;
}

/**
 * 步进键：凸起边框 + 居中的 − / + 字形（按按钮尺寸自适应）。
 *
 * <p>旧版是逐行扫描画的小三角箭头，只有 22×9；手机上折成不到 2mm，
 * 而且上下叠放时两键之间只有 2px 缝，手指分不出按了哪个。
 * 现在整行高、左右各一，字形按按钮短边定尺寸。
 */
function stepperBtn(r, up) {
  bevelRaise(r.x, r.y, r.w, r.h);
  if (hit(r) && mouseDown()) { box(r.x + 2, r.y + 2, r.w - 4, r.h - 4, "#a8a8a8"); }
  var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  var arm = Math.max(10, Math.min(18, Math.round(Math.min(r.w, r.h) * 0.5)));
  var th = Math.max(2, Math.round(arm * 0.16));
  // 横杠（两者都有）
  box(cx - arm / 2, cy - th / 2, arm, th, BLACK);
  if (up) {
    // 竖杠 → 加号
    box(cx - th / 2, cy - arm / 2, th, arm, BLACK);
  }
}

// ---------------------------------------------------------------- 可编辑输入框
//
// 玩家反馈：手机上改「40 雷」要点 30 多次 +/-。改成点一下数值框就能直接键入。
// 实现在引擎侧（bwe.textinput）：桌面端走物理键盘、Android 弹系统软键盘，
// 脚本只负责「把框放在哪、值是什么、提交后怎么办」。

/** 把脚本的布局同步给引擎（归一化 0~1，引擎按逻辑视口换算）。 */
function syncInputField(id, x, y, w, h, value, min, max, viewW) {
  // ⚠ 不要要求调用方传视口高度：drawConfigBar 的签名里没有 H，
  // 直接引用会抛 "H is not defined"。这里自己从 bwe.camera.size 取。
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
  MS.rows = Math.max(ROW_MIN, Math.min(ROW_MAX, MS.rows));
  MS.cols = Math.max(COL_MIN, Math.min(COL_MAX, MS.cols));
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

/** 胜负横幅：宽度自适应屏宽，位置保证不越屏、不压底带。 */
function drawOverlay(W, H, br, L, S) {
  if (!S.over) { return; }
  var bw = Math.min(380, W - 24);
  var bh = Math.max(44, Math.round(L.fs * 3.4));
  var x = Math.floor((W - bw) / 2);
  var y = br.h > 0 ? br.y + br.h + 10 : Math.floor((L.bandY0 + L.bandY1) / 2);
  // 落在底带里就会被底带按钮抢点击，也可能超出屏幕 → 钳回可用区
  var lowest = L.bandY1 - bh - 6;
  if (y > lowest || y < L.bandY0) { y = Math.max(L.bandY0 + 6, lowest); }
  bevelRaise(x, y, bw, bh);
  box(x + 2, y + 2, bw - 4, bh - 4, S.won ? "#d8f0d0" : "#f4d8d8");
  text(S.won ? cfg("labelWin", "✓ 通关！") : cfg("labelLose", "✗ 踩雷了"),
    x + bw / 2, y + Math.round(bh * 0.36), L.fs + 3, S.won ? "#106010" : "#a00000", "center");
  text(cfg("labelRestartHint", "点笑脸 / 新游戏 再来一局"),
    x + bw / 2, y + Math.round(bh * 0.72), Math.max(11, L.fs - 3), "#303030", "center");
}
