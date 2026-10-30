// ============================================================================
// 自由城 · 玩家脚本（绑定在 ACTOR「玩家」上）
// ----------------------------------------------------------------------------
// 负责：步行移动 + 墙体碰撞（空间哈希、x/y 分轴滑墙）、门/楼梯/楼层、
//       上车 / 劫车 / 驾驶 / 下车、出租车、攻击、拾取、死亡与医院复活、HUD。
// 约定：
//   - CITY 由 gen-city 在打包时前置（var CITY = {...};），这里只读不定义。
//   - 引擎原生移动由 move.locked 关掉，移动完全由本脚本负责。
//   - E 是唯一交互键：楼梯 > 拾取 > 车辆；F 只做上下车备用键。
//   - 与 world.js 不共享作用域：通过 bwe.world.emit/on 通讯。
// Rhino ES5：只用 var/function。
// ============================================================================

var G = {
  player: null,
  hp: 100,
  hpMax: 100,
  stamina: 100,
  staminaMax: 100,
  weapon: "fist",
  ammo: 0,
  money: 200,
  wanted: 0,
  dead: false,
  respawnTimer: 0,
  defending: false,
  attackCd: 0,
  hitFlash: 0,
  // 空间
  level: 0,
  bld: "",          // 玩家所在建筑 id（在 inner 内才算）
  bldName: "",
  indoor: false,
  visKey: "",
  // 载具
  car: null,        // 正在手动驾驶的车
  taxi: null,       // 正在乘坐的出租车（自动驾驶）
  lastCarX: 0,
  lastCarY: 0,
  carHitCd: {},
  exitLockT: 0,     // 下车后若干秒内持续 setSpeed(0)
  exitCar: null,
  // 表现
  dir: 0,
  animT: 0,
  frame: -1,
  zoom: 2.0,
  zoomTarget: 2.0,
  hint: "",
  toast: "",
  toastT: 0,
  lastBlockLog: -10,
  errCount: 0,
  stats: { wallBlocks: 0, floorChanges: 0, hijacks: 0, carEnters: 0, carExits: 0, taxiRides: 0, pickups: 0 }
};

var PCFG = {
  walkSpeed: 80,
  runSpeed: 140,
  footHalfW: 6,
  footHalfH: 4,
  footOffY: 8,
  stairRadius: 32,
  carReach: 24,
  zoomWalk: 2.0,
  zoomDrive: 1.4,
  taxiFare: 15
};

var P_HAS_CITY = (typeof CITY !== "undefined") && !!CITY && !!CITY.walls;

// ---------------------------------------------------------------------------
// 墙体空间哈希（64px 均匀网格）
// ---------------------------------------------------------------------------
var WH = { cell: 64, map: {}, walls: [], stamp: 0, marks: [] };

function buildWallHash(walls) {
  WH.map = {};
  WH.walls = walls || [];
  WH.marks = [];
  for (var i = 0; i < WH.walls.length; i++) {
    var w = WH.walls[i];
    WH.marks.push(0);
    var cx0 = Math.floor(w[0] / WH.cell), cy0 = Math.floor(w[1] / WH.cell);
    var cx1 = Math.floor((w[0] + w[2]) / WH.cell), cy1 = Math.floor((w[1] + w[3]) / WH.cell);
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var k = cx + "," + cy;
        var b = WH.map[k];
        if (!b) {
          b = [];
          WH.map[k] = b;
        }
        b.push(i);
      }
    }
  }
}

/** 轴对齐盒（中心 x,y，半宽 hw，半高 hh）与 level 层的墙相交？返回墙下标或 -1。 */
function boxHitsWall(x, y, hw, hh, level) {
  var x0 = x - hw, y0 = y - hh, x1 = x + hw, y1 = y + hh;
  var cx0 = Math.floor(x0 / WH.cell), cy0 = Math.floor(y0 / WH.cell);
  var cx1 = Math.floor(x1 / WH.cell), cy1 = Math.floor(y1 / WH.cell);
  WH.stamp++;
  for (var cy = cy0; cy <= cy1; cy++) {
    for (var cx = cx0; cx <= cx1; cx++) {
      var b = WH.map[cx + "," + cy];
      if (!b) continue;
      for (var i = 0; i < b.length; i++) {
        var wi = b[i];
        if (WH.marks[wi] === WH.stamp) continue;
        WH.marks[wi] = WH.stamp;
        var w = WH.walls[wi];
        var wl = w[4];
        if (wl !== -1 && wl !== level) continue;
        if (x1 > w[0] && x0 < w[0] + w[2] && y1 > w[1] && y0 < w[1] + w[3]) return wi;
      }
    }
  }
  return -1;
}

/** 圆与 level 层墙相交？ */
function circleHitsWall(x, y, r, level) {
  var cx0 = Math.floor((x - r) / WH.cell), cy0 = Math.floor((y - r) / WH.cell);
  var cx1 = Math.floor((x + r) / WH.cell), cy1 = Math.floor((y + r) / WH.cell);
  WH.stamp++;
  for (var cy = cy0; cy <= cy1; cy++) {
    for (var cx = cx0; cx <= cx1; cx++) {
      var b = WH.map[cx + "," + cy];
      if (!b) continue;
      for (var i = 0; i < b.length; i++) {
        var wi = b[i];
        if (WH.marks[wi] === WH.stamp) continue;
        WH.marks[wi] = WH.stamp;
        var w = WH.walls[wi];
        if (w[4] !== -1 && w[4] !== level) continue;
        var px = Math.max(w[0], Math.min(x, w[0] + w[2]));
        var py = Math.max(w[1], Math.min(y, w[1] + w[3]));
        var dx = x - px, dy = y - py;
        if (dx * dx + dy * dy < r * r) return wi;
      }
    }
  }
  return -1;
}

/** 人物脚底盒（12×8，中心 (x, y+8)）撞墙？ */
function footHits(x, y, level) {
  return boxHitsWall(x, y + PCFG.footOffY, PCFG.footHalfW, PCFG.footHalfH, level) >= 0;
}

/**
 * 纯函数：从 (x,y) 尝试移动 (dx,dy)，分轴解析，可沿墙滑动。
 * 返回 {x, y, blocked, bx, by}（bx/by = 该轴被挡）。
 */
function resolveMove(x, y, dx, dy, level) {
  var nx = x, ny = y, bx = false, by = false;
  var big = Math.max(Math.abs(dx), Math.abs(dy));
  var steps = Math.max(1, Math.ceil(big / 4));
  var sx = dx / steps, sy = dy / steps;
  // 已经嵌在墙里（被传送/击退进来）：先脱困
  if (footHits(nx, ny, level)) {
    var u = unstick(nx, ny, level);
    nx = u.x;
    ny = u.y;
  }
  for (var i = 0; i < steps; i++) {
    if (sx !== 0 && !bx) {
      if (!footHits(nx + sx, ny, level)) nx += sx;
      else bx = true;
    }
    if (sy !== 0 && !by) {
      if (!footHits(nx, ny + sy, level)) ny += sy;
      else by = true;
    }
  }
  return { x: nx, y: ny, blocked: bx || by, bx: bx, by: by };
}

/** 找离 (x,y) 最近的不撞墙点（环形搜索）。 */
function unstick(x, y, level) {
  if (!footHits(x, y, level)) return { x: x, y: y };
  for (var r = 4; r <= 96; r += 4) {
    for (var a = 0; a < 16; a++) {
      var ang = a * Math.PI / 8;
      var px = x + Math.cos(ang) * r, py = y + Math.sin(ang) * r;
      if (!footHits(px, py, level)) return { x: px, y: py };
    }
  }
  return { x: x, y: y };
}

/** 两点之间（按脚底小盒采样）是否有墙。 */
function pathBlocked(x0, y0, x1, y1, level) {
  var d = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
  var n = Math.max(1, Math.ceil(d / 4));
  for (var i = 1; i <= n; i++) {
    var t = i / n;
    if (boxHitsWall(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + PCFG.footOffY, 3, 2, level) >= 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 建筑 / 楼层
// ---------------------------------------------------------------------------
var BLD = { byId: {}, list: [], stairs: [], hospital: null, interior: [] };

function indexBuildings() {
  BLD.byId = {};
  BLD.list = [];
  BLD.stairs = [];
  if (!P_HAS_CITY || !CITY.buildings) return;
  for (var i = 0; i < CITY.buildings.length; i++) {
    var b = CITY.buildings[i];
    BLD.byId[b.id] = b;
    BLD.list.push(b);
    if (b.kind === "hospital" && !BLD.hospital) BLD.hospital = b;
    var st = b.stairs || [];
    for (var j = 0; j < st.length; j++) {
      BLD.stairs.push({ bid: b.id, level: st[j].level, kind: st[j].kind, x: st[j].x, y: st[j].y, link: st[j].link, to: st[j].to });
    }
  }
}

function rectHas(r, x, y, m) {
  return x >= r[0] - m && x <= r[0] + r[2] + m && y >= r[1] - m && y <= r[1] + r[3] + m;
}

/** 点所在建筑（在 inner 内才算；m = 外扩边距）。 */
function bldAt(x, y, m) {
  for (var i = 0; i < BLD.list.length; i++) {
    var b = BLD.list[i];
    if (b.inner && rectHas(b.inner, x, y, m || 0)) return b;
  }
  return null;
}

/** 楼上：把玩家 (x,y) 钳在该层 inner 内（脚底盒也在内）。 */
function clampInner(b, x, y) {
  var r = b.inner;
  return {
    x: Math.max(r[0] + 6, Math.min(r[0] + r[2] - 6, x)),
    y: Math.max(r[1] + 2, Math.min(r[1] + r[3] - 12, y))
  };
}

function floorLabel(level) {
  return (level + 1) + " 楼";
}

function spatialLevel() {
  try {
    return bwe.spatial.levelOf(G.player);
  } catch (e) {
    return G.level;
  }
}

/**
 * 每帧同步楼层：以脚本状态 G.level 为准，引擎丢层就用 enter() 修正；
 * 玩家被外部传送出建筑（测试 / 复活）则接受 0 层。
 */
function syncLevel() {
  var p = G.player;
  var sl = spatialLevel();
  if (G.level >= 1) {
    var b = BLD.byId[G.bld];
    if (!b || !rectHas(b.outer || b.inner, p.x, p.y, 24)) {
      try { bwe.spatial.leave(p); } catch (e1) { /* ignore */ }
      setLevel(0, "", "传送");
    } else {
      var c = clampInner(b, p.x, p.y);
      if (c.x !== p.x || c.y !== p.y) p.setPos(c.x, c.y);
      if (sl !== G.level) {
        try { bwe.spatial.enter(G.bld + "_r" + G.level, p); } catch (e2) { /* ignore */ }
      }
    }
  } else if (sl >= 1) {
    // 外部把玩家放到了楼上（别处调用了 enter/useLink）
    var cur = null;
    try { cur = bwe.spatial.current(); } catch (e3) { cur = null; }
    var bid = cur && cur.buildingId ? cur.buildingId : "";
    var bb = BLD.byId[bid] || bldAt(p.x, p.y, 8);
    if (bb) setLevel(sl, bb.id, "同步");
  }
  var hb = G.level >= 1 ? BLD.byId[G.bld] : bldAt(p.x, p.y, 0);
  var newBld = hb ? hb.id : "";
  if (G.level === 0 && newBld !== G.bld) {
    var oldB = G.bld;
    G.bld = newBld;
    if (newBld) {
      bwe.log("[玩家] 进入建筑 " + hb.name + "（" + newBld + "）");
      bwe.world.emit("enter_building", { building: newBld, name: hb.name, level: 0 });
    } else if (oldB) {
      bwe.log("[玩家] 离开建筑 " + oldB);
      bwe.world.emit("leave_building", { building: oldB });
    }
  }
  G.bldName = hb ? hb.name : "";
  G.indoor = !!hb;
  refreshInteriorVisibility();
}

function setLevel(level, bid, why) {
  var old = G.level;
  G.level = level;
  G.bld = bid;
  var b = BLD.byId[bid];
  G.bldName = b ? b.name : "";
  if (old !== level) {
    G.stats.floorChanges++;
    bwe.log("[玩家] 楼层 " + floorLabel(old) + " → " + floorLabel(level) + "（" + (bid || "室外") + "，" + why + "）");
    bwe.world.emit("floor_changed", { building: bid, from: old, to: level });
  }
}

/** interior + bid + lvL：只在玩家位于该楼第 L 层时显示；其余楼层只显示 0 层物件。 */
function refreshInteriorVisibility() {
  var key = G.bld + "#" + G.level;
  if (key === G.visKey) return;
  G.visKey = key;
  for (var i = 0; i < BLD.interior.length; i++) {
    var it = BLD.interior[i];
    var vis;
    if (it.bid === G.bld && G.level >= 1) vis = it.level === G.level;
    else vis = it.level === 0;
    if (it.e.visible !== vis) it.e.visible = vis;
  }
}

function indexInterior() {
  BLD.interior = [];
  var list = [];
  try { list = bwe.world.findAll({ tag: "interior" }) || []; } catch (e) { list = []; }
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    var tags = e.tags || [];
    var bid = "", lv = 0;
    for (var j = 0; j < tags.length; j++) {
      var t = String(tags[j]);
      if (t.indexOf("lv") === 0) lv = parseInt(t.substring(2), 10) || 0;
      else if (t.indexOf("b_") === 0) bid = t;
    }
    BLD.interior.push({ e: e, bid: bid, level: lv });
  }
}

/** 离玩家最近、同层、32px 内的楼梯（量玩家 x,y 到楼梯中心）。 */
function stairNear(x, y, level) {
  var best = null, bd = PCFG.stairRadius * PCFG.stairRadius;
  for (var i = 0; i < BLD.stairs.length; i++) {
    var s = BLD.stairs[i];
    if (s.level !== level) continue;
    var dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
    if (d <= bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

function useStairs(s) {
  var p = G.player;
  var ok = false;
  var lk = null;
  try { lk = bwe.spatial.link(s.link); } catch (e0) { lk = null; }
  var cur = spatialLevel();
  if (cur !== s.level) {
    try { bwe.spatial.enter(s.bid + "_r" + s.level, p); } catch (e1) { /* ignore */ }
    cur = spatialLevel();
  }
  if (lk && (cur === lk.aLevel || (cur === lk.bLevel && lk.bidirectional))) {
    try { ok = bwe.spatial.useLink(s.link, p); } catch (e2) { ok = false; }
  }
  if (!ok) {
    // 没有空间数据：手动传送到目标层对应楼梯口
    var dest = null;
    for (var i = 0; i < BLD.stairs.length; i++) {
      var o = BLD.stairs[i];
      if (o.bid === s.bid && o.level === s.to && o.link === s.link) dest = o;
    }
    if (dest) p.setPos(dest.x, dest.y + 20);
  }
  if (spatialLevel() !== s.to) {
    try { bwe.spatial.enter(s.bid + "_r" + s.to, p); } catch (e4) { /* ignore */ }
  }
  setLevel(s.to, s.bid, s.to > s.level ? "上楼" : "下楼");
  var b = BLD.byId[s.bid];
  if (b && s.to >= 1) {
    var c = clampInner(b, p.x, p.y);
    p.setPos(c.x, c.y);
  }
  var u = unstick(p.x, p.y, s.to);
  p.setPos(u.x, u.y);
  G.visKey = "";
  refreshInteriorVisibility();
  showToast((s.to > s.level ? "↑ " : "↓ ") + floorLabel(s.to));
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
function onStart(ctx) {
  G.player = ctx && ctx.self ? ctx.self : null;
  if (!G.player) G.player = bwe.world.find("玩家");
  if (!G.player) {
    bwe.log("[玩家] 找不到玩家实体，脚本停用");
    return;
  }
  var p = G.player;
  p.z = 18; // 人物图层约定：一种纹理一个 z（行人 10–16，玩家 18）
  try { p.addModule("move.locked"); } catch (e0) { bwe.log("[玩家] 无法锁定原生移动：" + e0); }
  // 生命值由脚本管理（G.hp）；引擎血量保持很高，避免引擎把玩家直接标记死亡
  p.hpMax = 100000;
  p.hp = 100000;
  p.layer = 3;
  buildWallHash(P_HAS_CITY ? CITY.walls : []);
  indexBuildings();
  indexInterior();
  if (P_HAS_CITY && CITY.playerSpawn && footHits(p.x, p.y, 0)) {
    p.setPos(CITY.playerSpawn.x, CITY.playerSpawn.y);
  }
  var u = unstick(p.x, p.y, 0);
  p.setPos(u.x, u.y);
  G.visKey = "";
  refreshInteriorVisibility();

  p.on("damage", function (amount, from) {
    if (G.dead) return;
    var a = Number(amount) || 0;
    G.hp -= a;
    G.player.hp = 100000;
    bwe.camera.shake(Math.min(10, 3 + a * 0.4), 0.22);
    G.player.setColor(1, 0.25, 0.25, 0.9);
    G.hitFlash = 0.18;
    if (G.hp <= 0) onPlayerDeath(from);
  });

  bwe.world.on("wanted", function (d) {
    G.wanted = d && d.level ? d.level : 0;
  });
  bwe.world.on("busted", function (d) {
    onBusted(d && d.fine ? d.fine : 0);
  });
  bwe.world.on("reward", function (d) {
    G.money += d && d.money ? d.money : 0;
  });

  bwe.on("draw", drawHud);

  bwe.camera.follow(p, { smooth: 0.18, lookAhead: 8 });
  try { bwe.camera.setZoom(G.zoom); } catch (e1) { /* ignore */ }
  bwe.log("[玩家] 就绪：墙体 " + WH.walls.length + " 段，建筑 " + BLD.list.length + " 栋，楼梯 " + BLD.stairs.length
    + "，室内物件 " + BLD.interior.length + (P_HAS_CITY ? "" : "（未注入 CITY）"));
}

function onUpdate(ctx, dt) {
  if (!G.player) return;
  try {
    tick(Math.min(0.05, dt || 0));
  } catch (err) {
    G.errCount++;
    if (G.errCount <= 5) bwe.log("[玩家] 帧逻辑出错（已忽略）：" + err);
  }
}

function tick(dt) {
  if (G.attackCd > 0) G.attackCd -= dt;
  if (G.toastT > 0) G.toastT -= dt;
  if (G.hitFlash > 0) {
    G.hitFlash -= dt;
    if (G.hitFlash <= 0) G.player.clearColor();
  }
  tickExitLock(dt);
  if (G.dead) {
    tickRespawn(dt);
    easeZoom(dt);
    return;
  }
  if (G.car) tickDriving(dt);
  else if (G.taxi) tickTaxi(dt);
  else tickOnFoot(dt);
  easeZoom(dt);
}

function easeZoom(dt) {
  var t = G.zoomTarget;
  if (Math.abs(G.zoom - t) < 0.002) return;
  G.zoom += (t - G.zoom) * Math.min(1, dt * 3);
  if (Math.abs(G.zoom - t) < 0.002) G.zoom = t;
  try { bwe.camera.setZoom(G.zoom); } catch (e) { /* ignore */ }
}

function showToast(s) {
  G.toast = s;
  G.toastT = 2.0;
}

// ---------------------------------------------------------------------------
// 步行
// ---------------------------------------------------------------------------
function tickOnFoot(dt) {
  var p = G.player;
  syncLevel();
  var ix = (bwe.actions.down("move_right") ? 1 : 0) - (bwe.actions.down("move_left") ? 1 : 0);
  var iy = (bwe.actions.down("move_down") ? 1 : 0) - (bwe.actions.down("move_up") ? 1 : 0);
  var moving = ix !== 0 || iy !== 0;
  var running = moving && bwe.actions.down("run") && G.stamina > 1;
  var spd = running ? PCFG.runSpeed : PCFG.walkSpeed;
  if (G.defending) spd *= 0.5;
  if (running) G.stamina = Math.max(0, G.stamina - 25 * dt);
  else G.stamina = Math.min(G.staminaMax, G.stamina + 15 * dt);
  if (moving) {
    var len = Math.sqrt(ix * ix + iy * iy);
    var dx = ix / len * spd * dt, dy = iy / len * spd * dt;
    var r = resolveMove(p.x, p.y, dx, dy, G.level);
    var nx = r.x, ny = r.y;
    // 门口辅助：单轴推墙时，若旁边几像素有通路就顺势滑过去
    if (r.blocked && (ix === 0 || iy === 0)) {
      var s = doorAssist(nx, ny, dx, dy, G.level, spd * dt);
      nx = s.x;
      ny = s.y;
    }
    if (r.blocked && Math.abs(nx - p.x) < 0.01 && Math.abs(ny - p.y) < 0.01) noteWallBlock("步行");
    if (G.level >= 1) {
      var b = BLD.byId[G.bld];
      if (b) {
        var c = clampInner(b, nx, ny);
        nx = c.x;
        ny = c.y;
      }
    }
    p.setPos(nx, ny);
    if (Math.abs(ix) > Math.abs(iy)) G.dir = ix < 0 ? 1 : 2;
    else if (iy !== 0) G.dir = iy < 0 ? 3 : 0;
    G.animT += dt * (running ? 10 : 7);
  } else {
    G.animT = 0;
  }
  setAnimFrame(moving ? (Math.floor(G.animT) % 4) : 0);

  // 防御
  var def = !!bwe.actions.down("defend");
  if (def !== G.defending) {
    G.defending = def;
    try { bwe.combat.defend(p, def); } catch (e0) { /* ignore */ }
  }
  if (bwe.actions.pressed("attack")) doAttack();
  if (bwe.actions.pressed("switch_weapon")) doSwitchWeapon();

  var act = findInteraction();
  G.hint = act ? act.hint : "";
  if (bwe.actions.pressed("interact")) {
    if (act) runInteraction(act);
  } else if (bwe.actions.pressed("enter_vehicle")) {
    var car = act && act.kind === "car" ? act : findCarAction();
    if (car) runInteraction(car);
  }
  if (bwe.input.pressed("KeyT")) callTaxi();
}

function doorAssist(x, y, dx, dy, level, step) {
  var horiz = dx !== 0;
  for (var k = 2; k <= 12; k += 2) {
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      var ox = horiz ? 0 : sgn * k, oy = horiz ? sgn * k : 0;
      if (footHits(x + ox, y + oy, level)) continue;
      if (!footHits(x + ox + dx, y + oy + dy, level)) {
        var m = Math.min(step, k);
        var r = resolveMove(x, y, horiz ? 0 : sgn * m, horiz ? sgn * m : 0, level);
        return { x: r.x, y: r.y };
      }
    }
  }
  return { x: x, y: y };
}

function noteWallBlock(what) {
  G.stats.wallBlocks++;
  var now = bwe.time.now;
  if (now - G.lastBlockLog > 3) {
    G.lastBlockLog = now;
    bwe.log("[玩家] " + what + "被墙挡住 @(" + Math.round(G.player.x) + "," + Math.round(G.player.y) + ")，累计 " + G.stats.wallBlocks + " 次");
  }
}

function setAnimFrame(step) {
  var f = G.dir * 4 + step;
  if (f !== G.frame) {
    G.frame = f;
    G.player.setFrame(f);
  }
}

// ---------------------------------------------------------------------------
// 交互：楼梯 > 拾取 > 车辆
// ---------------------------------------------------------------------------
function findInteraction() {
  var p = G.player;
  var s = stairNear(p.x, p.y, G.level);
  if (s) return { kind: "stairs", stair: s, e: null, hint: (s.to > s.level ? "E 上楼（" : "E 下楼（") + floorLabel(s.to) + "）" };
  var pk = findPickup();
  if (pk) return { kind: "pickup", stair: null, e: pk, hint: "E 拾取 " + (pk.name || "物品") };
  return findCarAction();
}

function findPickup() {
  var p = G.player;
  var hits = bwe.collision.overlapCircle(p.x, p.y + 8, 20);
  for (var i = 0; i < hits.length; i++) {
    var e = hits[i];
    if (e && e !== p && e.tags && e.tags.has("pickup")) return e;
  }
  return null;
}

function carHalf(car) {
  var w = 32, h = 16;
  try {
    var sz = car.size;
    if (sz && sz.w > 0) {
      w = sz.w / 2;
      h = sz.h / 2;
    }
  } catch (e) { /* ignore */ }
  if (w < h) {
    var t = w;
    w = h;
    h = t;
  }
  return { w: w, h: h };
}

function findCarAction() {
  var p = G.player;
  if (G.level !== 0 || G.indoor) return null;
  var hits = bwe.collision.overlapCircle(p.x, p.y, 90);
  var best = null, bd = 1e9;
  for (var i = 0; i < hits.length; i++) {
    var e = hits[i];
    if (!e || e === p || !bwe.vehicle.isVehicle(e)) continue;
    var hh = carHalf(e);
    var d = Math.sqrt((e.x - p.x) * (e.x - p.x) + (e.y - p.y) * (e.y - p.y));
    if (d > hh.w + PCFG.carReach) continue;
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  if (!best) return null;
  var drv = bwe.vehicle.driver(best);
  var occupied = !!(drv && drv !== p);
  return { kind: "car", stair: null, e: best, hint: occupied ? "E 劫车" : "E 上车" };
}

function runInteraction(act) {
  if (act.kind === "stairs") useStairs(act.stair);
  else if (act.kind === "pickup") doPickup(act.e);
  else if (act.kind === "car") enterCar(act.e);
}

function doPickup(e) {
  var heal = Number(e.prop("heal", 0)) || 0;
  var ammo = Number(e.prop("ammo", 0)) || 0;
  var money = Number(e.prop("money", 0)) || 0;
  var weapon = String(e.prop("weapon", "") || "");
  if (heal > 0) G.hp = Math.min(G.hpMax, G.hp + heal);
  if (ammo > 0) {
    G.ammo += ammo;
    bwe.combat.setAmmo(G.player, G.ammo);
  }
  if (money > 0) G.money += money;
  if (weapon && bwe.combat.weapon(G.player, weapon) === true) G.weapon = weapon;
  G.stats.pickups++;
  bwe.log("[玩家] 拾取 " + (e.name || "物品") + (heal ? " +HP" + heal : "") + (ammo ? " +弹药" + ammo : "") + (money ? " +$" + money : ""));
  showToast("拾取 " + (e.name || "物品"));
  e.destroy();
}

// ---------------------------------------------------------------------------
// 车辆：上车 / 劫车 / 驾驶 / 下车
// ---------------------------------------------------------------------------
// setSpeed 是 vehicle-java 新增的 API：存在才调用（旧引擎上降级为不处理）
function setCarSpeed(car, v) {
  var fn = bwe.vehicle["setSpeed"];
  if (typeof fn === "function") {
    try { fn(car, v); } catch (e) { /* ignore */ }
  }
}

function enterCar(car) {
  var p = G.player;
  if (!car || G.car || G.taxi) return;
  var drv = bwe.vehicle.driver(car);
  var ok;
  if (drv && drv !== p) {
    ok = bwe.vehicle.hijack(p, car);
    if (ok) {
      G.stats.hijacks++;
      bwe.log("[玩家] 劫车：" + (car.name || "车辆") + "（司机 " + (drv.name || "?") + " 被拽下车）");
      bwe.world.emit("crime", { kind: "hijack", x: p.x, y: p.y, vehicle: car, victim: drv });
      showToast("劫车！");
    }
  } else {
    ok = bwe.vehicle.enter(p, car);
    if (ok) bwe.log("[玩家] 上车：" + (car.name || "车辆"));
  }
  if (!ok) {
    bwe.log("[玩家] 上车失败：" + (car.name || "车辆"));
    return;
  }
  G.stats.carEnters++;
  G.car = car;
  G.exitLockT = 0;
  G.exitCar = null;
  bwe.vehicle.stop(car);
  p.visible = false;
  G.lastCarX = car.x;
  G.lastCarY = car.y;
  G.hint = "E 下车";
  G.zoomTarget = PCFG.zoomDrive;
  bwe.camera.follow(car, { smooth: 0.15, lookAhead: 24 });
  bwe.world.emit("player_vehicle", { vehicle: car, inside: true });
}

/** 车身三圆（沿车头方向前/中/后）撞墙？ */
function carHitsWall(car) {
  var h = bwe.vehicle.heading(car) * Math.PI / 180;
  var fx = Math.cos(h), fy = Math.sin(h);
  var hh = carHalf(car);
  var r = Math.max(10, hh.h - 2);
  var off = Math.max(0, hh.w - r);
  var o = [-off, 0, off];
  for (var i = 0; i < 3; i++) {
    if (circleHitsWall(car.x + fx * o[i], car.y + fy * o[i], r, 0) >= 0) return true;
  }
  return false;
}

function tickDriving(dt) {
  var car = G.car;
  var p = G.player;
  if (!car || !car.alive || bwe.vehicle.vehicleOf(p) !== car) {
    bwe.log("[玩家] 车辆已失效，强制下车");
    finishExit(car, false);
    return;
  }
  // 撞墙：回到上一个安全位置并清速度（每帧）
  if (carHitsWall(car)) {
    car.setPos(G.lastCarX, G.lastCarY);
    setCarSpeed(car, 0);
    noteWallBlock("车辆");
  } else {
    G.lastCarX = car.x;
    G.lastCarY = car.y;
  }
  if (bwe.actions.pressed("interact") || bwe.actions.pressed("enter_vehicle")) {
    exitCar();
    return;
  }
  var th = bwe.actions.down("move_up") ? 1 : 0;
  var br = bwe.actions.down("move_down") ? 1 : 0;
  var st = (bwe.actions.down("move_right") ? 1 : 0) - (bwe.actions.down("move_left") ? 1 : 0);
  bwe.vehicle.throttle(car, th);
  bwe.vehicle.brake(car, br);
  bwe.vehicle.steer(car, st);
  p.setPos(car.x, car.y);
  G.hint = "E 下车";
  G.level = 0;
  carRunOver(car, dt);
}

/** 车速够快时撞到行人 / 警察：伤害 + 犯罪。 */
function carRunOver(car, dt) {
  var k;
  for (k in G.carHitCd) {
    if (G.carHitCd.hasOwnProperty(k)) {
      G.carHitCd[k] -= dt;
      if (G.carHitCd[k] <= 0) delete G.carHitCd[k];
    }
  }
  var sp = bwe.vehicle.speed(car);
  var v = Math.abs(sp);
  if (v < 50) return;
  var h = bwe.vehicle.heading(car) * Math.PI / 180;
  var sgn = sp >= 0 ? 1 : -1;
  var hh = carHalf(car);
  var cx = car.x + Math.cos(h) * hh.w * 0.7 * sgn, cy = car.y + Math.sin(h) * hh.w * 0.7 * sgn;
  var hits = bwe.collision.overlapCircle(cx, cy, hh.h + 4);
  for (var i = 0; i < hits.length; i++) {
    var e = hits[i];
    if (!e || e === car || e === G.player || bwe.vehicle.isVehicle(e)) continue;
    if (!e.tags || !(e.tags.has("npc") || e.tags.has("police") || e.tags.has("civilian"))) continue;
    if (!e.alive || G.carHitCd[e.id]) continue;
    G.carHitCd[e.id] = 0.8;
    var r = bwe.combat.hit({ from: G.player, to: e, amount: Math.min(80, Math.round(v * 0.3)), knockback: 28, ignoreDefense: true });
    if (r && r.hit) {
      bwe.log("[玩家] 开车撞到 " + (e.name || "行人") + "（速度 " + Math.round(v) + "，伤害 " + Math.round(r.amount) + (r.killed ? "，死亡" : "") + "）");
      bwe.world.emit("crime", { kind: e.tags.has("police") ? "attack_police" : (r.killed ? "kill" : "attack"), x: e.x, y: e.y, victim: e });
      bwe.camera.shake(3, 0.15);
    }
  }
}

/** 下车点：左 → 右 → 后 → 前；脚底不在墙里、与车之间没有墙、不在建筑里。 */
function pickExitPoint(car) {
  var h = bwe.vehicle.heading(car) * Math.PI / 180;
  var fx = Math.cos(h), fy = Math.sin(h);
  var lx = fy, ly = -fx;
  var hh = carHalf(car);
  var side = hh.h + 14, back = hh.w + 14;
  var c = [
    [lx * side, ly * side], [lx * (side + 10), ly * (side + 10)],
    [-lx * side, -ly * side], [-lx * (side + 10), -ly * (side + 10)],
    [-fx * back, -fy * back], [fx * back, fy * back]
  ];
  for (var i = 0; i < c.length; i++) {
    var px = car.x + c[i][0], py = car.y + c[i][1] - PCFG.footOffY * 0.5;
    if (footHits(px, py, 0)) continue;
    if (pathBlocked(car.x, car.y - PCFG.footOffY, px, py, 0)) continue;
    if (bldAt(px, py, 0)) continue;
    return { x: px, y: py };
  }
  return unstick(car.x + c[0][0], car.y + c[0][1], 0);
}

function exitCar() {
  var car = G.car || G.taxi;
  if (!car) return;
  var pt = pickExitPoint(car);
  bwe.vehicle.exit(G.player);
  setCarSpeed(car, 0);
  G.player.setPos(pt.x, pt.y);
  G.exitCar = car;
  G.exitLockT = 0.6;
  bwe.log("[玩家] 下车 @(" + Math.round(pt.x) + "," + Math.round(pt.y) + ")，车辆停在 (" + Math.round(car.x) + "," + Math.round(car.y) + ")");
  finishExit(car, true);
}

function finishExit(car, ok) {
  var p = G.player;
  G.stats.carExits++;
  if (!ok && bwe.vehicle.vehicleOf(p)) {
    try { bwe.vehicle.exit(p); } catch (e0) { /* ignore */ }
  }
  var wasTaxi = !!G.taxi;
  G.car = null;
  G.taxi = null;
  p.visible = true;
  G.level = 0;
  try { bwe.spatial.leave(p); } catch (e1) { /* ignore */ }
  var u = unstick(p.x, p.y, 0);
  p.setPos(u.x, u.y);
  G.zoomTarget = PCFG.zoomWalk;
  G.hint = "";
  bwe.camera.follow(p, { smooth: 0.18, lookAhead: 8 });
  bwe.world.emit("player_vehicle", { vehicle: car, inside: false, taxi: wasTaxi });
}

/** 下车后短时间内保持车速为 0（不调 throttle/brake，免得解除停车）。 */
function tickExitLock(dt) {
  if (G.exitLockT <= 0 || !G.exitCar) return;
  G.exitLockT -= dt;
  if (G.exitCar.alive && !bwe.vehicle.driver(G.exitCar)) setCarSpeed(G.exitCar, 0);
  if (G.exitLockT <= 0) G.exitCar = null;
}

// ---------------------------------------------------------------------------
// 出租车（T 叫车，自动驾驶到远处，E/F 提前下车）
// ---------------------------------------------------------------------------
function callTaxi() {
  var p = G.player;
  if (G.level !== 0 || G.indoor || G.car || G.taxi) {
    showToast("这里叫不到车");
    return;
  }
  if (G.money < PCFG.taxiFare) {
    showToast("钱不够打车（$" + PCFG.taxiFare + "）");
    return;
  }
  var near = null;
  try { near = bwe.road.nearest(p.x, p.y); } catch (e0) { near = null; }
  if (!near) {
    bwe.log("[玩家] 叫车失败：没有路网");
    return;
  }
  var nodes = bwe.road.nodes();
  var cands = [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var d = bwe.dist(n.x, n.y, near.x, near.y);
    if (d > 700 && d < 2400) cands.push(n);
  }
  if (!cands.length) cands = nodes;
  var dest = cands[Math.floor(Math.random() * cands.length)];
  var taxi = bwe.vehicle.spawn({
    kind: "taxi", asset: "vehicle-taxi", name: "出租车", x: near.x, y: near.y, heading: 0,
    layer: 3, z: 6, halfW: 32, halfH: 16, speedLimit: 200, tags: ["vehicle", "taxi", "player_taxi"]
  });
  if (!taxi) {
    bwe.log("[玩家] 叫车失败：无法生成车辆");
    return;
  }
  if (!bwe.vehicle.enter(p, taxi)) {
    taxi.destroy();
    return;
  }
  var ok = bwe.vehicle.followRoad(taxi, dest.id, {
    onArrive: function () {
      if (G.taxi !== taxi) return;
      G.money = Math.max(0, G.money - PCFG.taxiFare);
      bwe.log("[的士] 到达目的地 " + dest.id + "，车费 $" + PCFG.taxiFare);
      exitCar();
      bwe.after(6, function () {
        if (taxi.alive && !bwe.vehicle.driver(taxi)) taxi.destroy();
      });
    }
  });
  G.taxi = taxi;
  G.stats.taxiRides++;
  p.visible = false;
  G.zoomTarget = PCFG.zoomDrive;
  bwe.camera.follow(taxi, { smooth: 0.15, lookAhead: 24 });
  bwe.log("[玩家] 叫车 → " + dest.id + (ok ? "（已出发）" : "（不可达）"));
  showToast("出租车 → 目的地");
}

function tickTaxi(dt) {
  var t = G.taxi;
  if (!t || !t.alive || bwe.vehicle.vehicleOf(G.player) !== t) {
    finishExit(t, false);
    return;
  }
  G.player.setPos(t.x, t.y);
  G.hint = "E 下车";
  if (bwe.actions.pressed("interact") || bwe.actions.pressed("enter_vehicle")) {
    bwe.vehicle.stop(t);
    exitCar();
    bwe.after(6, function () {
      if (t.alive && !bwe.vehicle.driver(t)) t.destroy();
    });
  }
}

// ---------------------------------------------------------------------------
// 战斗
// ---------------------------------------------------------------------------
function doAttack() {
  if (G.defending || G.attackCd > 0) return;
  var w = bwe.combat.params(G.weapon) || bwe.combat.params("fist");
  if (!w) return;
  if (!w.melee) {
    if (G.ammo <= 0) {
      bwe.combat.weapon(G.player, "fist");
      G.weapon = "fist";
      showToast("没子弹了");
      return;
    }
    G.ammo -= 1;
    bwe.combat.setAmmo(G.player, G.ammo);
  }
  G.attackCd = w.cooldown || 0.4;
  var p = G.player;
  var hits = bwe.collision.overlapCircle(p.x, p.y, w.range);
  var target = null, bd = 1e9;
  for (var i = 0; i < hits.length; i++) {
    var e = hits[i];
    if (!e || e === p || !e.tags) continue;
    if (!e.tags.has("npc") && !e.tags.has("police")) continue;
    if (!e.alive) continue;
    if (pathBlocked(p.x, p.y, e.x, e.y, G.level)) continue;
    var d = e.distanceTo(p);
    if (d < bd) {
      bd = d;
      target = e;
    }
  }
  if (!target) {
    bwe.world.emit("player_attack", { x: p.x, y: p.y, weapon: G.weapon, hit: false });
    return;
  }
  var r = bwe.combat.hit({ from: p, to: target, weapon: G.weapon, knockback: 12 });
  bwe.world.emit("player_attack", { x: p.x, y: p.y, weapon: G.weapon, hit: true, target: target });
  if (r && r.killed) bwe.log("[玩家] 击杀 " + target.name);
  var kind = target.tags.has("police") ? "attack_police" : (r && r.killed ? "kill" : "attack");
  bwe.world.emit("crime", { kind: kind, x: p.x, y: p.y, victim: target });
}

function doSwitchWeapon() {
  var w = bwe.combat.switchWeapon(G.player);
  if (typeof w === "string") {
    G.weapon = w;
    showToast("武器：" + w);
  }
}

// ---------------------------------------------------------------------------
// 死亡 / 被捕 / 医院
// ---------------------------------------------------------------------------
function onPlayerDeath(from) {
  if (G.dead) return;
  if (G.car || G.taxi) exitCar();
  G.dead = true;
  G.hp = 0;
  G.respawnTimer = 3.0;
  G.player.setColor(0.4, 0.4, 0.4, 1);
  bwe.log("[玩家] 死亡（凶手：" + (from && from.name ? from.name : "未知") + "），3 秒后送医院");
  bwe.world.emit("player_died", { from: from });
}

function hospitalPoint() {
  var b = BLD.hospital;
  if (b && b.doors && b.doors.length) return { x: b.doors[0].outside.x, y: b.doors[0].outside.y };
  if (P_HAS_CITY && CITY.playerSpawn) return { x: CITY.playerSpawn.x, y: CITY.playerSpawn.y };
  return { x: G.player.x, y: G.player.y };
}

function teleportOutside(pt) {
  var p = G.player;
  try { bwe.spatial.leave(p); } catch (e) { /* ignore */ }
  G.level = 0;
  G.bld = "";
  var u = unstick(pt.x, pt.y, 0);
  p.setPos(u.x, u.y);
  G.visKey = "";
  refreshInteriorVisibility();
}

function tickRespawn(dt) {
  G.respawnTimer -= dt;
  if (G.respawnTimer > 0) return;
  teleportOutside(hospitalPoint());
  G.hp = G.hpMax;
  G.stamina = G.staminaMax;
  var fee = Math.floor(G.money * 0.1);
  G.money -= fee;
  G.weapon = "fist";
  G.ammo = 0;
  bwe.combat.weapon(G.player, "fist");
  bwe.combat.setAmmo(G.player, 0);
  G.dead = false;
  G.respawnTimer = 0;
  G.player.clearColor();
  bwe.log("[玩家] 医院复活：血量 " + G.hp + "，扣费 " + fee + "，剩余现金 " + G.money);
  showToast("医院复活 -$" + fee);
  bwe.world.emit("respawn", { fee: fee });
}

function onBusted(fine) {
  if (G.dead) return;
  if (G.car || G.taxi) exitCar();
  var f = Math.min(G.money, fine);
  G.money -= f;
  G.wanted = 0;
  teleportOutside(hospitalPoint());
  bwe.log("[玩家] 被捕：罚款 $" + f + "，剩余 $" + G.money);
  showToast("被捕！罚款 $" + f);
}

// ---------------------------------------------------------------------------
// HUD（bwe.on("draw")：屏幕左上角 + 世界坐标的头顶提示）
// ---------------------------------------------------------------------------
function locationText() {
  if (G.car) return "驾驶中";
  if (G.taxi) return "出租车上";
  if (G.bld) return G.bldName + " · " + floorLabel(G.level);
  return "街道";
}

function drawHud() {
  if (!G.player) return;
  try {
    var d = bwe.draw;
    d.rect(12, 12, 236, 92, { fill: "#000000", alpha: 0.45, radius: 6 });
    d.bar(20, 20, 160, 12, Math.max(0, G.hp) / G.hpMax, { bg: "#3a1010", fg: "#e04040", border: "#000000" });
    d.text(186, 19, "HP " + Math.max(0, Math.round(G.hp)), { size: 11, color: "#ffffff" });
    var stars = "";
    for (var i = 0; i < 5; i++) stars += i < G.wanted ? "★" : "☆";
    d.text(20, 38, stars, { size: 14, color: G.wanted > 0 ? "#ffd040" : "#777777" });
    d.text(120, 38, "$" + G.money, { size: 14, color: "#7fe07f" });
    d.text(20, 58, locationText(), { size: 12, color: "#ffffff" });
    d.text(20, 76, "武器 " + G.weapon + (G.ammo > 0 ? " ×" + G.ammo : ""), { size: 11, color: "#cccccc" });
    if (G.toastT > 0 && G.toast) {
      d.text(20, 112, G.toast, { size: 16, color: "#ffffff", shadow: true, alpha: Math.min(1, G.toastT) });
    }
    if (G.dead) d.text(20, 136, "WASTED", { size: 28, color: "#ff3030", shadow: true });
    if (G.hint) {
      var anchor = G.car || G.taxi || G.player;
      var hx = anchor.x, hy = anchor.y - (G.car || G.taxi ? 30 : 22);
      var txt = G.hint;
      d.world(function () {
        d.text(hx, hy, txt, { size: 8, color: "#ffffff", align: "center", shadow: true });
      });
    }
  } catch (e) {
    G.errCount++;
    if (G.errCount <= 5) bwe.log("[玩家] HUD 绘制出错（已忽略）：" + e);
  }
}
