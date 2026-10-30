// ============================================================================
// 自由城 · 世界系统脚本（场景 onStartScript）
// ----------------------------------------------------------------------------
// 负责：红绿灯循环、交通车流（followRoad 连续随机目的地 + 红灯/前车减速）、
//       停放空车、行人逛街（CITY.walk 图上 A* → POI 停留）、步行警察、通缉。
// 约定：
//   - CITY 由 gen-city 打包时前置（var CITY = {...};），这里只读不定义。
//   - 与 player.js 不共享作用域：通过 bwe.world.emit/on 通讯。
//     收：crime / player_died / respawn / enter_building / leave_building /
//         floor_changed / player_vehicle；发：wanted{level} / busted{fine}。
//   - 本脚本生成的实体一律 layer 3；车 z 2..8（每种车色一个 z），人 z 10..16
//     （每种图集一个 z），保证同 z 同纹理、合批不退化。
//   - 全局 W 供 CityPlaytest 读取：W.stats / W.npcs / W.traffic / W.police。
// Rhino ES5：只用 var/function。
// ============================================================================

var WCFG = {
  lightCycle: 20,          // 秒：h 绿 8 → h 黄 2 → v 绿 8 → v 黄 2
  trafficCount: 26,        // 玩家附近维持的交通车数
  trafficRecycle: 1700,    // 离玩家超过这个距离的交通车回收
  trafficSpawnMin: 650,    // 补车出生点离玩家的最近距离（屏外）
  trafficSpawnMax: 1500,
  carStuckSeconds: 6,      // 无正当理由停住超过这个秒数 → 重新规划
  npcTarget: 26,           // 玩家附近维持的行人数（20–30）
  npcRecycle: 900,         // 离玩家超过这个距离的行人回收
  npcSpawnMin: 520,        // 补人出生点离玩家距离（屏外）
  npcSpawnMax: 850,
  walkMin: 28, walkMax: 42,
  laneOffset: 8,           // 行人在人行道中线左右偏移
  pairChance: 0.2, pairGap: 14,
  fleeSpeed: 92,
  witnessRadius: 220,
  policeMax: 5,
  policeSpeed: 104,
  arrestRadius: 40, arrestSeconds: 1.0,
  wantedDecay: 25
};

var W = {
  gen: 0, dead: false, hookUpdate: null, errCount: 0,
  t: 0, lightT: 0,
  player: null, playerFindT: 0, pCar: null, pCarSpd: 0, pCarHx: 1, pCarHy: 0,
  pfx: 0, pfy: 0,              // 玩家脚点（开车时 = 车中心）
  pBld: "", pLevel: 0,
  wanted: 0, heat: 0, lastCrimeT: -999,
  npcs: [], traffic: [], parked: [], abandoned: [], police: [], corpses: [],
  lights: [], lightByNode: {}, lightEnts: [], phase: { h: "green", v: "red" }, phaseKey: "",
  npcPopT: 0, carPopT: 0, copSpawnT: 0, bustT: 0,
  stats: {
    poiArrivals: 0, retargets: 0, hijacks: 0,
    npcSpawned: 0, npcRecycled: 0, npcReplans: 0, crossings: 0, flees: 0, astar: 0, astarFail: 0,
    carsSpawned: 0, carsRecycled: 0, redStops: 0, carPlanFail: 0,
    policeSpawned: 0, arrests: 0, peakWanted: 0
  }
};

var DEG = Math.PI / 180;
// 方向下标与图集行一致：0 S, 1 W, 2 E, 3 N
var DIRV = [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }];
var SKINS = ["actor-npc", "actor-npc-b", "actor-npc-c", "actor-npc-d", "actor-npc-e", "actor-npc-f"];
var SKIN_Z = {
  "actor-npc": 10, "actor-npc-b": 11, "actor-npc-c": 12, "actor-npc-d": 13,
  "actor-npc-e": 14, "actor-npc-f": 15, "actor-police": 16
};
var CAR_ASSETS = ["vehicle-car", "vehicle-car-red", "vehicle-car-white", "vehicle-car-green", "vehicle-taxi", "vehicle-van"];
var CAR_Z = {
  "vehicle-car": 2, "vehicle-car-red": 3, "vehicle-car-white": 4, "vehicle-car-green": 5,
  "vehicle-taxi": 6, "vehicle-police": 7, "vehicle-van": 8
};

// ---------------------------------------------------------------- 工具
function wlog(s) { bwe.log("[世界] " + s); }
function rnd(a, b) { return a + Math.random() * (b - a); }
function rndi(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
function dist(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function hasCity() { return typeof CITY !== "undefined" && !!CITY && CITY.version >= 2; }
function removeFrom(arr, item) { var i = arr.indexOf(item); if (i >= 0) arr.splice(i, 1); }
function logErr(where, err) {
  W.errCount++;
  if (W.errCount <= 5) wlog("帧逻辑出错（已忽略）[" + where + "]：" + err);
}
function guard(where, fn) {
  try { fn(); } catch (err) { logErr(where, err); }
}
function setSpeedSafe(car, v) {
  var fn = bwe.vehicle["setSpeed"];
  if (typeof fn === "function") fn(car, v);
}
function killEntity(e) {
  if (!e) return;
  try { e.destroy(); } catch (err) { /* 已销毁 */ }
}

function playerEnt() {
  var p = W.player;
  if (p && p.alive) return p;
  if (W.t < W.playerFindT) return null;
  W.playerFindT = W.t + 0.5;
  p = bwe.world.find("玩家");
  W.player = p;
  return p;
}

function updatePlayerState() {
  var p = playerEnt();
  W.pCar = null;
  if (!p) {
    if (hasCity() && CITY.playerSpawn) { W.pfx = CITY.playerSpawn.x; W.pfy = CITY.playerSpawn.y; }
    return;
  }
  var car = null;
  try { car = bwe.vehicle.vehicleOf(p); } catch (err) { car = null; }
  if (car && car.alive) {
    W.pCar = car;
    W.pfx = car.x; W.pfy = car.y;
    W.pCarSpd = bwe.vehicle.speed(car);
    var h = bwe.vehicle.heading(car) * DEG;
    W.pCarHx = Math.cos(h); W.pCarHy = Math.sin(h);
  } else {
    W.pfx = p.x; W.pfy = p.y + 8;
  }
}

// ---------------------------------------------------------------- 墙体（只看 0 层，NPC/警察兜底碰撞）
var WALLS = { cell: 64, map: {}, ok: false };
function wallKey(cx, cy) { return cy * 4096 + cx; }
function buildWalls() {
  WALLS.map = {}; WALLS.ok = false;
  if (!hasCity() || !CITY.walls) return;
  var ws = CITY.walls, c = WALLS.cell;
  for (var i = 0; i < ws.length; i++) {
    var w = ws[i];
    if (w[4] !== -1 && w[4] !== 0) continue;
    var x0 = Math.floor(w[0] / c), x1 = Math.floor((w[0] + w[2]) / c);
    var y0 = Math.floor(w[1] / c), y1 = Math.floor((w[1] + w[3]) / c);
    for (var cy = y0; cy <= y1; cy++) {
      for (var cx = x0; cx <= x1; cx++) {
        var k = wallKey(cx, cy);
        var b = WALLS.map[k];
        if (!b) { b = []; WALLS.map[k] = b; }
        b.push(i);
      }
    }
  }
  WALLS.ok = true;
}
/** 以 (x,y) 为中心、半宽 hw 半高 hh 的盒子是否压到 0 层墙。 */
function wallHit(x, y, hw, hh) {
  if (!WALLS.ok) return false;
  var c = WALLS.cell, ws = CITY.walls;
  var x0 = Math.floor((x - hw) / c), x1 = Math.floor((x + hw) / c);
  var y0 = Math.floor((y - hh) / c), y1 = Math.floor((y + hh) / c);
  for (var cy = y0; cy <= y1; cy++) {
    for (var cx = x0; cx <= x1; cx++) {
      var b = WALLS.map[wallKey(cx, cy)];
      if (!b) continue;
      for (var j = 0; j < b.length; j++) {
        var w = ws[b[j]];
        if (x + hw > w[0] && x - hw < w[0] + w[2] && y + hh > w[1] && y - hh < w[1] + w[3]) return true;
      }
    }
  }
  return false;
}
/** 脚点盒（12×6）是否压墙。 */
function footHit(fx, fy) { return wallHit(fx, fy, 5, 3); }
function losClear(ax, ay, bx, by) {
  var d = dist(ax, ay, bx, by), n = Math.ceil(d / 8);
  for (var i = 1; i < n; i++) {
    var t = i / n;
    if (wallHit(ax + (bx - ax) * t, ay + (by - ay) * t, 2, 2)) return false;
  }
  return true;
}
function buildingAt(x, y) {
  if (!hasCity()) return "";
  var bs = CITY.buildings;
  for (var i = 0; i < bs.length; i++) {
    var o = bs[i].outer;
    if (x >= o[0] && x < o[0] + o[2] && y >= o[1] && y < o[1] + o[3]) return bs[i].id;
  }
  return "";
}

// ---------------------------------------------------------------- 红绿灯
function phaseAt(t) {
  var c = t % WCFG.lightCycle;
  return {
    h: c < 8 ? "green" : (c < 10 ? "yellow" : "red"),
    v: c < 10 ? "red" : (c < 18 ? "green" : "yellow")
  };
}
/** 该轴向剩余绿灯秒数（行人过街用）。 */
function greenLeft(axis) {
  var c = W.lightT % WCFG.lightCycle;
  if (axis === "h") return c < 8 ? 8 - c : 0;
  return (c >= 10 && c < 18) ? 18 - c : 0;
}
function lightsInit() {
  W.lights = [];
  W.lightT = 0;
  W.phaseKey = "";
  var ls = hasCity() ? (CITY.lights || []) : [];
  var edges = [];
  try { if (bwe.road.hasData()) edges = bwe.road.edges(); } catch (err) { edges = []; }
  W.lightByNode = {};
  for (var i = 0; i < ls.length; i++) {
    var L = ls[i];
    var nid = String(L.node);
    var hHalf = 0, vHalf = 0;
    var me = null;
    try { me = bwe.road.node(nid); } catch (err) { me = null; }
    var cx = me ? me.x : L.x, cy = me ? me.y : L.y;
    for (var j = 0; j < edges.length; j++) {
      var e = edges[j];
      if (e.from !== nid && e.to !== nid) continue;
      var other = bwe.road.node(e.from === nid ? e.to : e.from);
      if (!other) continue;
      if (Math.abs(other.x - cx) >= Math.abs(other.y - cy)) hHalf = Math.max(hHalf, e.width / 2);
      else vHalf = Math.max(vHalf, e.width / 2);
    }
    // hHalf = 横向道路半宽（竖向行驶的车要穿过它），vHalf = 竖向道路半宽
    var rec = { node: nid, x: L.x, y: L.y, nx: cx, ny: cy, hHalf: hHalf || 48, vHalf: vHalf || 48 };
    W.lights.push(rec);
    W.lightByNode[nid] = rec;
  }
  W.lightEnts = bwe.world.findAll({ tag: "trafficlight" }) || [];
  lightsTick(0);
}
function lightsTick(dt) {
  W.lightT += dt;
  var ph = phaseAt(W.lightT);
  W.phase = ph;
  var key = ph.h + "/" + ph.v;
  if (key === W.phaseKey) return;
  W.phaseKey = key;
  if (!W.lightEnts.length) W.lightEnts = bwe.world.findAll({ tag: "trafficlight" }) || [];
  for (var i = 0; i < W.lightEnts.length; i++) {
    var e = W.lightEnts[i];
    if (!e || !e.alive) continue;
    var axis = String(e.prop("axis", "h"));
    var st = axis === "v" ? ph.v : ph.h;
    e.setProp("phase", st);
    if (st === "green") e.setColor(0.3, 1, 0.4, 1);
    else if (st === "yellow") e.setColor(1, 0.9, 0.2, 1);
    else e.setColor(1, 0.25, 0.25, 1);
  }
}
function nearestLight(x, y, r) {
  var best = null, bd = r;
  for (var i = 0; i < W.lights.length; i++) {
    var L = W.lights[i];
    var d = dist(x, y, L.x, L.y);
    if (d < bd) { bd = d; best = L; }
  }
  return best;
}

// ---------------------------------------------------------------- 通缉
var HEAT = { attack: 1, kill: 2, hijack: 2, attack_police: 3 };
function onCrime(c) {
  if (!c) return;
  W.heat += HEAT[c.kind] || 1;
  W.lastCrimeT = W.t;
  setWanted(Math.min(5, Math.floor(W.heat / 2) + 1), "犯罪：" + c.kind);
  npcOnCrime(c);
}
function setWanted(lv, why) {
  lv = clamp(lv, 0, 5);
  if (lv === W.wanted) return;
  var old = W.wanted;
  W.wanted = lv;
  if (lv > W.stats.peakWanted) W.stats.peakWanted = lv;
  bwe.log("[通缉] " + old + " → " + lv + " 星（" + why + "）");
  bwe.world.emit("wanted", { level: lv });
  if (lv === 0) policeLeaveAll();
}
function resetWanted(why) {
  W.heat = 0;
  W.lastCrimeT = W.t;
  setWanted(0, why);
  policeClearAll();
}
function wantedTick(dt) {
  if (W.wanted > 0 && W.t - W.lastCrimeT > WCFG.wantedDecay) {
    W.lastCrimeT = W.t;
    W.heat = Math.max(0, (W.wanted - 2) * 2);
    setWanted(W.wanted - 1, "风头过去");
  }
}

// ---------------------------------------------------------------- 事件
function bindEvents(gen) {
  function on(name, fn) {
    bwe.world.on(name, function (ev) {
      if (gen !== W.gen || W.dead) return;
      guard(name, function () { fn(ev || {}); });
    });
  }
  on("crime", function (ev) { onCrime(ev); });
  on("player_died", function () { resetWanted("玩家倒下"); });
  on("respawn", function () { W.pBld = ""; W.pLevel = 0; resetWanted("医院复活"); });
  on("enter_building", function (ev) { W.pBld = String(ev.building || ""); W.pLevel = 0; });
  on("leave_building", function () { W.pBld = ""; W.pLevel = 0; });
  on("floor_changed", function (ev) {
    if (ev.building) W.pBld = String(ev.building);
    W.pLevel = Number(ev.to) || 0;
  });
  on("player_vehicle", function (ev) {
    if (ev.inside && ev.vehicle) { trafficForget(ev.vehicle); removeFrom(W.parked, ev.vehicle); }
  });
  function onVeh(name, fn) {
    bwe.vehicle.on(name, function (info) {
      if (gen !== W.gen || W.dead) return;
      guard("车辆 " + name, function () { if (info) fn(info); });
    });
  }
  onVeh("hijack", function (info) { trafficOnHijack(info); });
  onVeh("enter", function (info) {
    if (info.actor && W.player && info.actor === W.player && info.vehicle) {
      trafficForget(info.vehicle);
      removeFrom(W.parked, info.vehicle);
      removeFrom(W.abandoned, info.vehicle);
    }
  });
  onVeh("exit", function (info) {
    if (info.actor && W.player && info.actor === W.player && info.vehicle) {
      if (W.abandoned.indexOf(info.vehicle) < 0) W.abandoned.push(info.vehicle);
    }
  });
}

// ---------------------------------------------------------------- 生命周期
function onSceneStart(ctx) {
  if (W.hookUpdate) { try { bwe.off("update", W.hookUpdate); } catch (err) { /* 已被引擎清掉 */ } }
  W.gen++;
  var gen = W.gen;
  W.dead = false;
  W.t = 0; W.errCount = 0;
  W.npcs = []; W.traffic = []; W.parked = []; W.abandoned = []; W.police = []; W.corpses = [];
  W.wanted = 0; W.heat = 0; W.lastCrimeT = -999; W.pBld = ""; W.pLevel = 0;
  var sc = ctx && ctx.scene ? ctx.scene : null;
  wlog("自由城启动，场景=" + (sc ? sc.name : "?")
    + (hasCity()
      ? "，CITY v" + CITY.version + " " + CITY.width + "x" + CITY.height + "，建筑 " + CITY.buildings.length
        + "，行人节点 " + CITY.walk.nodes.length + "，POI " + CITY.pois.length
      : "，CITY 缺失（只跑红绿灯）"));
  W.playerFindT = 0;
  playerEnt();
  updatePlayerState();
  buildWalls();
  lightsInit();
  bindEvents(gen);
  guard("交通初始化", function () { trafficInit(); });
  guard("行人初始化", function () { npcInit(); });
  wlog("初始人口：行人 " + W.npcs.length + "，交通车 " + W.traffic.length + "，停放空车 " + W.parked.length
    + "，红绿灯 " + W.lightEnts.length + "（路口 " + W.lights.length + "）");
  W.hookUpdate = function (dt) {
    if (gen !== W.gen || W.dead) return;
    try { worldTick(Number(dt) || 0.016); } catch (err) { logErr("update", err); }
  };
  bwe.on("update", W.hookUpdate);
}

function onSceneEnd(ctx) {
  W.dead = true;
  if (W.hookUpdate) { try { bwe.off("update", W.hookUpdate); } catch (err) { /* ignore */ } }
  var s = W.stats;
  wlog("收工统计：POI 到达 " + s.poiArrivals + "，行人生成 " + s.npcSpawned + "/回收 " + s.npcRecycled
    + "，车辆生成 " + s.carsSpawned + "/回收 " + s.carsRecycled + "，卡住重规划 " + s.retargets
    + "，红灯停车 " + s.redStops + "，劫车 " + s.hijacks + "，逮捕 " + s.arrests + "，通缉峰值 " + s.peakWanted);
}

function worldTick(dt) {
  if (dt > 0.1) dt = 0.1;
  W.t += dt;
  updatePlayerState();
  lightsTick(dt);
  wantedTick(dt);
  trafficTick(dt);
  npcTick(dt);
  policeTick(dt);
  corpseTick();
}

function corpseTick() {
  for (var i = W.corpses.length - 1; i >= 0; i--) {
    var c = W.corpses[i];
    if (W.t >= c.t) { killEntity(c.e); W.corpses.splice(i, 1); }
  }
}

// ==== [WALK+NPC] ====
// ---------------------------------------------------------------- 行人图（CITY.walk）
// 节点 kind：0 人行道 / 1 斑马线端点 / 2 门外 / 3 室内；边 kind：0 人行道 / 1 斑马线 / 2 门
var WG = {
  ok: false, n: 0, x: [], y: [], k: [], b: [], adj: [], comp: [], grid: {}, cell: 128,
  gs: [], from: [], mark: [], closed: [], stamp: 0, sidewalk: []
};
var POIS = [];
var POI_W = { window: 3, shop: 2.2, bench: 2, plaza: 1.2, park: 1.2, fountain: 1.2, view: 1 };
var FACE_DIR = { S: 0, W: 1, E: 2, N: 3 };
var TMP = { x: 0, y: 0 };

function gridKey(cx, cy) { return cy * 1000 + cx; }
function walkInit() {
  WG.ok = false;
  WG.n = 0; WG.x = []; WG.y = []; WG.k = []; WG.b = []; WG.adj = []; WG.comp = [];
  WG.grid = {}; WG.gs = []; WG.from = []; WG.mark = []; WG.closed = []; WG.sidewalk = [];
  POIS = [];
  if (!hasCity() || !CITY.walk || !CITY.walk.nodes || !CITY.walk.nodes.length) return;
  var ns = CITY.walk.nodes, es = CITY.walk.edges || [];
  var n = ns.length, i;
  for (i = 0; i < n; i++) {
    var nx = Number(ns[i][0]), ny = Number(ns[i][1]), nk = Number(ns[i][2]) | 0;
    WG.x.push(nx); WG.y.push(ny); WG.k.push(nk);
    WG.b.push(nk === 3 ? buildingAt(nx, ny) : "");
    WG.adj.push([]); WG.comp.push(-1);
    WG.gs.push(0); WG.from.push(-1); WG.mark.push(0); WG.closed.push(0);
    if (nk === 0) WG.sidewalk.push(i);
    var key = gridKey(Math.floor(nx / WG.cell), Math.floor(ny / WG.cell));
    var cellList = WG.grid[key];
    if (!cellList) { cellList = []; WG.grid[key] = cellList; }
    cellList.push(i);
  }
  WG.n = n;
  for (i = 0; i < es.length; i++) {
    var a = Number(es[i][0]) | 0, b = Number(es[i][1]) | 0, ek = Number(es[i][2]) | 0;
    if (a === b || a < 0 || b < 0 || a >= n || b >= n) continue;
    var len = dist(WG.x[a], WG.y[a], WG.x[b], WG.y[b]);
    // 斑马线小惩罚（少折返过街），门边大惩罚（不把商店当捷径穿行）
    var cost = len + (ek === 1 ? 30 : 0) + (ek === 2 ? 250 : 0);
    WG.adj[a].push({ to: b, kind: ek, cost: cost });
    WG.adj[b].push({ to: a, kind: ek, cost: cost });
  }
  // 连通分量：只给同一分量的 POI 派单，A* 不会白跑
  var compId = 0;
  for (i = 0; i < n; i++) {
    if (WG.comp[i] >= 0) continue;
    var stack = [i];
    WG.comp[i] = compId;
    while (stack.length) {
      var c = stack.pop();
      var adj = WG.adj[c];
      for (var j = 0; j < adj.length; j++) {
        if (WG.comp[adj[j].to] < 0) { WG.comp[adj[j].to] = compId; stack.push(adj[j].to); }
      }
    }
    compId++;
  }
  var ps = CITY.pois || [];
  for (i = 0; i < ps.length; i++) {
    var p = ps[i];
    var pn = Number(p.node) | 0;
    if (pn < 0 || pn >= n) continue;
    POIS.push({
      x: Number(p.x), y: Number(p.y), kind: String(p.kind), node: pn,
      building: p.building ? String(p.building) : "",
      dir: FACE_DIR.hasOwnProperty(String(p.face)) ? FACE_DIR[String(p.face)] : -1
    });
  }
  WG.ok = true;
}
function edgeKind(a, b) {
  var adj = WG.adj[a];
  for (var j = 0; j < adj.length; j++) if (adj[j].to === b) return adj[j].kind;
  return 0;
}
/** 半径 r 内最近的行人节点；pred 可选过滤。 */
function nearestNode(x, y, r, pred) {
  var c = WG.cell, best = -1, bd = r;
  var x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
  var y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
  for (var cy = y0; cy <= y1; cy++) {
    for (var cx = x0; cx <= x1; cx++) {
      var list = WG.grid[gridKey(cx, cy)];
      if (!list) continue;
      for (var i = 0; i < list.length; i++) {
        var id = list[i];
        var d = dist(x, y, WG.x[id], WG.y[id]);
        if (d < bd && (!pred || pred(id))) { bd = d; best = id; }
      }
    }
  }
  return best;
}
/** 行人图 A*（二叉堆）。返回节点下标数组（含起点），不可达返回 null。 */
function astar(s, g) {
  W.stats.astar++;
  if (s < 0 || g < 0) return null;
  if (s === g) return [s];
  if (WG.comp[s] !== WG.comp[g]) return null;
  WG.stamp++;
  var st = WG.stamp, gs = WG.gs, from = WG.from, mark = WG.mark, closed = WG.closed;
  var gx = WG.x[g], gy = WG.y[g];
  var hn = [], hf = [];
  function push(id, f) {
    var i = hn.length;
    hn.push(id); hf.push(f);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hn[i] = hn[p]; hf[i] = hf[p];
      i = p;
    }
    hn[i] = id; hf[i] = f;
  }
  function pop() {
    var top = hn[0];
    var lastN = hn.pop(), lastF = hf.pop();
    var len = hn.length;
    if (len > 0) {
      var i = 0;
      while (true) {
        var l = i * 2 + 1, r = l + 1, m = i;
        var mf = lastF;
        if (l < len && hf[l] < mf) { m = l; mf = hf[l]; }
        if (r < len && hf[r] < mf) { m = r; }
        if (m === i) break;
        hn[i] = hn[m]; hf[i] = hf[m];
        i = m;
      }
      hn[i] = lastN; hf[i] = lastF;
    }
    return top;
  }
  mark[s] = st; gs[s] = 0; from[s] = -1;
  push(s, dist(WG.x[s], WG.y[s], gx, gy));
  var iter = 0;
  while (hn.length) {
    var cur = pop();
    if (cur === g) break;
    if (closed[cur] === st) continue;
    closed[cur] = st;
    if (++iter > 8000) return null;
    var adj = WG.adj[cur];
    for (var j = 0; j < adj.length; j++) {
      var nb = adj[j].to;
      if (closed[nb] === st) continue;
      var ng = gs[cur] + adj[j].cost;
      if (mark[nb] !== st || ng < gs[nb]) {
        mark[nb] = st; gs[nb] = ng; from[nb] = cur;
        push(nb, ng + dist(WG.x[nb], WG.y[nb], gx, gy));
      }
    }
  }
  if (mark[g] !== st) return null;
  var path = [], c = g, guardN = 0;
  while (c !== -1 && guardN++ < 10000) { path.push(c); c = from[c]; }
  path.reverse();
  return path;
}

// ---------------------------------------------------------------- 行人
function faceDir(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 2 : 1;
  return dy > 0 ? 0 : 3;
}
function npcInit() {
  walkInit();
  W.npcPopT = 0.5;
  if (!WG.ok) { wlog("CITY.walk 缺失：不生成行人"); return; }
  var want = WCFG.npcTarget, guardN = 0;
  while (W.npcs.length < want && guardN++ < want * 4) {
    if (Math.random() < 0.25 && POIS.length) {
      var pi = rndi(0, POIS.length - 1), p = POIS[pi];
      if (p.kind === "shop" || dist(p.x, p.y, W.pfx, W.pfy) > 800 || footHit(p.x, p.y)) continue;
      var n = npcSpawnAt(p.x, p.y, p.node, null);
      if (n) { n.lastPoi = pi; npcArriveKind(n, p); }
    } else {
      var id = pickSpawnNode(60, 800);
      if (id >= 0) npcSpawnGroup(id);
    }
  }
}


/** 在离玩家 [dmin,dmax] 的人行道节点里随机挑一个（室外）。 */
function pickSpawnNode(dmin, dmax) {
  var sw = WG.sidewalk;
  if (!sw.length) return -1;
  for (var t = 0; t < 40; t++) {
    var id = sw[rndi(0, sw.length - 1)];
    var d = dist(WG.x[id], WG.y[id], W.pfx, W.pfy);
    if (d >= dmin && d <= dmax && !footHit(WG.x[id], WG.y[id])) return id;
  }
  return -1;
}

function npcSpawnGroup(node) {
  var lead = npcSpawnAt(WG.x[node], WG.y[node], node, null);
  if (!lead) return;
  if (Math.random() < WCFG.pairChance && W.npcs.length < WCFG.npcTarget) {
    var fx = WG.x[node] + WCFG.pairGap, fy = WG.y[node];
    if (footHit(fx, fy)) { fx = WG.x[node]; fy = WG.y[node] + WCFG.pairGap; }
    if (footHit(fx, fy)) { fx = WG.x[node]; fy = WG.y[node]; }
    var f = npcSpawnAt(fx, fy, node, null);
    if (f) {
      f.leader = lead; lead.follower = f;
      f.state = "follow"; f.speed = lead.speed;
    }
  }
}
function npcSpawnAt(fx, fy, node, skin) {
  if (!skin) skin = SKINS[rndi(0, SKINS.length - 1)];
  var e = bwe.world.spawn({
    x: fx, y: fy - 8, asset: skin, name: "路人", kind: "ACTOR",
    tags: ["npc", "civilian", "pedestrian"], z: SKIN_Z[skin] || 10, layer: 3,
    halfW: 8, halfH: 12, scaleX: 1, scaleY: 1, animMode: "只显示首帧"
  });
  if (!e) return null;
  e.hpMax = 30; e.hp = 30;
  W.stats.npcSpawned++;
  return npcAdopt(e, skin, node, fx, fy);
}
/** 把一个现成的人物实体接管成行人（新生成的路人 / 被劫车的司机）。 */
function npcAdopt(e, skin, node, fx, fy) {
  var n = {
    e: e, skin: skin, kind: "civ", node: node, fx: fx, fy: fy, onWalk: true,
    speed: rnd(WCFG.walkMin, WCFG.walkMax), fps: rnd(6, 8), lane: rnd(3, 8),
    dir: rndi(0, 3), frame: -1, animT: rnd(0, 1), moving: false,
    state: "think", t: rnd(0.1, 1.5), chk: 0,
    path: null, pi: 0, tail: null, poi: -1, lastPoi: -1, pending: "", lastKind: "",
    bld: WG.b[node] || "", vis: true, stuckT: 0, crossing: false,
    look: false, lookT: 0, loop: null, li: 0, benchShift: false,
    leader: null, follower: null, dead: false, arrivals: 0
  };
  e.on("damage", function (amount, from) {
    if (n.dead) return;
    npcFlee(n, from ? from.x : W.pfx, from ? from.y : W.pfy);
  });
  e.on("death", function (by) { npcDie(n); });
  W.npcs.push(n);
  return n;
}
function npcDespawn(n) {
  if (n.dead) return;
  n.dead = true;
  if (n.follower) { var f = n.follower; n.follower = null; f.leader = null; npcDespawn(f); }
  if (n.leader) { n.leader.follower = null; n.leader = null; }
  killEntity(n.e);
}
function npcDie(n) {
  if (n.dead) return;
  n.dead = true;
  if (n.follower) { var f = n.follower; n.follower = null; f.leader = null; npcFlee(f, n.fx, n.fy); }
  if (n.leader) { var L = n.leader; n.leader = null; L.follower = null; npcFlee(L, n.fx, n.fy); }
  var e = n.e;
  try {
    e.removeTag("npc"); e.removeTag("civilian"); e.removeTag("pedestrian"); e.addTag("corpse");
    e.setFrame(n.dir * 4);
    e.rotation = 90;
    e.setColor(0.7, 0.7, 0.7, 1);
  } catch (err) { /* 已被引擎回收 */ }
  W.corpses.push({ e: e, t: W.t + 15 });
}
function npcPopulation() {
  var i, n, alive = 0;
  for (i = 0; i < W.npcs.length; i++) {
    n = W.npcs[i];
    if (n.dead || n.leader) continue;
    if (dist(n.fx, n.fy, W.pfx, W.pfy) > WCFG.npcRecycle) { npcDespawn(n); W.stats.npcRecycled++; }
  }
  for (i = 0; i < W.npcs.length; i++) if (!W.npcs[i].dead) alive++;
  var spawned = 0;
  while (alive < WCFG.npcTarget && spawned < 2) {
    var id = pickSpawnNode(WCFG.npcSpawnMin, WCFG.npcSpawnMax);
    if (id < 0) break;
    var before = W.npcs.length;
    npcSpawnGroup(id);
    alive += W.npcs.length - before;
    spawned++;
  }
}
function npcTick(dt) {
  if (!WG.ok) return;
  W.npcPopT -= dt;
  if (W.npcPopT <= 0) { W.npcPopT = 0.5; npcPopulation(); }
  var list = W.npcs, i;
  for (i = 0; i < list.length; i++) {
    var n = list[i];
    if (n.dead) continue;
    if (!n.e || !n.e.alive) { n.dead = true; continue; }
    try { npcUpdate(n, dt); } catch (err) { logErr("行人", err); n.state = "think"; n.t = 1; n.path = null; }
  }
  var keep = [];
  for (i = 0; i < list.length; i++) if (!list[i].dead) keep.push(list[i]);
  W.npcs = keep;
}
function npcUpdate(n, dt) {
  var e = n.e;
  n.fx = e.x; n.fy = e.y + 8;
  var ox = n.fx, oy = n.fy;
  n.moving = false;
  switch (n.state) {
    case "think":
      n.t -= dt;
      if (n.t <= 0) npcPlan(n);
      break;
    case "walk":
      if (npcWalk(n, dt, n.speed * (n.crossing ? 1.3 : 1))) npcReached(n);
      break;
    case "wait":
      npcWaitCross(n, dt);
      break;
    case "dwell":
      n.t -= dt;
      if (n.look) {
        n.lookT -= dt;
        if (n.lookT <= 0) { n.lookT = rnd(1.2, 2.2); n.dir = rndi(0, 3); }
      }
      if (n.t <= 0) npcEndDwell(n);
      break;
    case "loop":
      if (n.li < n.loop.length) {
        var lp = n.loop[n.li];
        if (npcStep(n, lp.x, lp.y, n.speed * 0.6, dt)) n.li++;
      } else {
        n.loop = null;
        npcStartDwell(n, rnd(2, 4), -1, true);
      }
      break;
    case "flee":
      n.t -= dt;
      if (npcWalk(n, dt, WCFG.fleeSpeed) || n.t <= 0) {
        n.path = null; n.tail = null; n.crossing = false;
        n.state = "think"; n.t = rnd(0.5, 1.5);
        if (n.kind === "victim") {
          if (!n.onWalk) {
            // 被劫司机：先跑上人行道，再顺着人行道跑远
            n.onWalk = true;
            try { n.e.addTag("civilian"); } catch (err) { /* ignore */ }
            npcFlee(n, W.pfx, W.pfy);
          } else if (dist(n.fx, n.fy, W.pfx, W.pfy) > 420) {
            npcDespawn(n);
            return;
          } else n.kind = "civ";
        }
      }
      break;
    case "follow":
      npcFollow(n, dt);
      break;
    default:
      n.state = "think"; n.t = 0.5;
  }
  if (n.stuckT > 1.2) npcUnstick(n);
  if (n.fx !== ox || n.fy !== oy) e.setPos(n.fx, n.fy - 8);
  // 动画：4 帧行走，6–8fps；站立用第 0 帧
  if (n.moving) n.animT += dt;
  var frame = n.dir * 4 + (n.moving ? Math.floor(n.animT * n.fps) % 4 : 0);
  if (frame !== n.frame) { n.frame = frame; e.setFrame(frame); }
  // 玩家不在的楼里，行人隐藏（屋顶本就盖着，但避免 2F 视角穿帮）
  var vis = !n.bld || (n.bld === W.pBld && W.pLevel === 0);
  if (vis !== n.vis) { n.vis = vis; e.visible = vis; }
}
/** 朝 (tx,ty) 走一步；到达返回 true。墙体碰撞为兜底（按轴滑动）。 */
function npcStep(n, tx, ty, spd, dt) {
  var dx = tx - n.fx, dy = ty - n.fy;
  var d = Math.sqrt(dx * dx + dy * dy);
  var stepLen = spd * dt;
  if (d < 0.01) return true;
  n.dir = faceDir(dx, dy);
  n.moving = true;
  if (d <= Math.max(1.5, stepLen)) {
    if (!footHit(tx, ty)) { n.fx = tx; n.fy = ty; n.stuckT = 0; return true; }
    n.stuckT += dt;
    return false;
  }
  var mx = dx / d * stepLen, my = dy / d * stepLen;
  if (!footHit(n.fx + mx, n.fy + my)) { n.fx += mx; n.fy += my; n.stuckT = 0; }
  else if (Math.abs(mx) > 0.05 && !footHit(n.fx + mx, n.fy)) { n.fx += mx; n.stuckT += dt * 0.5; }
  else if (Math.abs(my) > 0.05 && !footHit(n.fx, n.fy + my)) { n.fy += my; n.stuckT += dt * 0.5; }
  else n.stuckT += dt;
  return false;
}
/** 边 a→b 的行走目标点：右侧通行，横向偏移 lane；门边/室内不偏移。 */
function edgeTarget(n, a, b) {
  TMP.x = WG.x[b]; TMP.y = WG.y[b];
  if (a < 0) return TMP;
  if (edgeKind(a, b) === 2 || WG.k[a] >= 2 || WG.k[b] >= 2) return TMP;
  var dx = WG.x[b] - WG.x[a], dy = WG.y[b] - WG.y[a];
  var L = Math.sqrt(dx * dx + dy * dy);
  if (L < 1) return TMP;
  TMP.x += -dy / L * n.lane;
  TMP.y += dx / L * n.lane;
  if (footHit(TMP.x, TMP.y)) { TMP.x = WG.x[b]; TMP.y = WG.y[b]; }
  return TMP;
}
/** 沿 n.path 走；全部走完（含尾段 tail）返回 true。 */
function npcWalk(n, dt, spd) {
  if (n.path && n.pi < n.path.length) {
    var a = n.pi > 0 ? n.path[n.pi - 1] : -1, b = n.path[n.pi];
    var tp = edgeTarget(n, a, b);
    if (npcStep(n, tp.x, tp.y, spd, dt)) {
      n.node = b;
      n.bld = WG.b[b];
      n.pi++;
      n.crossing = false;
      npcBeginEdge(n);
    }
    return false;
  }
  if (n.tail) {
    if (npcStep(n, n.tail.x, n.tail.y, spd, dt)) n.tail = null;
    return false;
  }
  return true;
}
/** 即将走下一条边：斑马线前在端点等灯/等车。 */
function npcBeginEdge(n) {
  if (!n.path || n.pi < 1 || n.pi >= n.path.length) return;
  var a = n.path[n.pi - 1], b = n.path[n.pi];
  if (edgeKind(a, b) !== 1) return;
  if (n.state === "flee" || n.kind === "cop") { n.crossing = true; return; }
  if (crossOk(n, a, b)) { n.crossing = true; W.stats.crossings++; return; }
  n.state = "wait"; n.t = 0; n.chk = 0.25;
  n.dir = faceDir(WG.x[b] - WG.x[a], WG.y[b] - WG.y[a]);
}
function npcWaitCross(n, dt) {
  n.t += dt;
  n.chk -= dt;
  if (n.chk > 0) return;
  n.chk = 0.25;
  var a = n.path[n.pi - 1], b = n.path[n.pi];
  if (crossOk(n, a, b) || n.t > 25) {
    n.state = "walk"; n.crossing = true; W.stats.crossings++;
  }
}
/** 能否走斑马线 a→b：有灯看灯（竖向走看 v 绿、横向走看 h 绿），没灯看来车。 */
function crossOk(n, a, b) {
  var ax = WG.x[a], ay = WG.y[a], bx = WG.x[b], by = WG.y[b];
  var mx = (ax + bx) / 2, my = (ay + by) / 2;
  var len = dist(ax, ay, bx, by);
  var L = nearestLight(mx, my, 170);
  if (L) {
    var axis = Math.abs(by - ay) > Math.abs(bx - ax) ? "v" : "h";
    var need = Math.min(len / (n.speed * 1.3) * 0.7, 6);
    return greenLeft(axis) > need;
  }
  return !carApproaching(mx, my, len / 2 + 130);
}
function carApproaching(x, y, r) {
  var i, c, list = W.traffic;
  for (i = 0; i < list.length; i++) {
    c = list[i].e;
    if (!c || !c.alive) continue;
    if (carTowards(c, x, y, r)) return true;
  }
  if (W.pCar && carTowards(W.pCar, x, y, r)) return true;
  return false;
}
function carTowards(car, x, y, r) {
  var d = dist(car.x, car.y, x, y);
  if (d > r) return false;
  var sp = bwe.vehicle.speed(car);
  if (Math.abs(sp) < 12) return d < 40;
  var h = bwe.vehicle.heading(car) * DEG;
  var s = sp >= 0 ? 1 : -1;
  return ((x - car.x) * Math.cos(h) + (y - car.y) * Math.sin(h)) * s > -20;
}
/** 卡墙兜底：吸附到附近可视节点，按原目标重规划。 */
function npcUnstick(n) {
  n.stuckT = 0;
  W.stats.npcReplans++;
  var nn = nearestNode(n.fx, n.fy, 96, function (id) { return losClear(n.fx, n.fy, WG.x[id], WG.y[id]); });
  if (nn < 0) nn = n.node;
  if (nn < 0) return;
  if (n.state === "follow") { n.fx = WG.x[nn]; n.fy = WG.y[nn]; return; }
  n.node = nn;
  var goal = n.path && n.path.length ? n.path[n.path.length - 1] : -1;
  var path = goal >= 0 ? astar(nn, goal) : null;
  if (path) { n.path = path; n.pi = 0; return; }
  n.fx = WG.x[nn]; n.fy = WG.y[nn];
  n.path = null; n.tail = null; n.loop = null; n.poi = -1; n.pending = "";
  n.state = "think"; n.t = 0.5;
}
function npcStartDwell(n, t, dir, look) {
  n.state = "dwell"; n.t = t; n.look = look; n.lookT = rnd(1, 2);
  if (dir >= 0) n.dir = dir;
}
function npcEndDwell(n) {
  if (n.benchShift) { n.fy -= 3; n.benchShift = false; }
  n.state = "think"; n.t = rnd(0.3, 1.0);
}
/** 想一想下一站：优先附近 POI；看完橱窗常顺着看下一家。 */
function npcPlan(n) {
  var chain = n.lastKind === "window" && Math.random() < 0.45;
  for (var tries = 0; tries < 4; tries++) {
    var useChain = chain && tries < 2;
    var pi = pickPoi(n, useChain ? "window" : "", useChain ? 260 : 0);
    if (pi >= 0 && npcGo(n, pi)) return;
  }
  npcWander(n);
}
function pickPoi(n, kindOnly, maxD) {
  if (!POIS.length || n.node < 0) return -1;
  var comp = WG.comp[n.node], total = 0, cands = [], ws = [];
  for (var i = 0; i < POIS.length; i++) {
    if (i === n.lastPoi) continue;
    var p = POIS[i];
    if (WG.comp[p.node] !== comp) continue;
    if (kindOnly && p.kind !== kindOnly) continue;
    var d = dist(n.fx, n.fy, p.x, p.y);
    if (maxD && d > maxD) continue;
    var w = (POI_W[p.kind] || 1) / (1 + d / 350);
    if (d < 40) w *= 0.2;
    if (dist(p.x, p.y, W.pfx, W.pfy) > WCFG.npcRecycle) w *= 0.3;
    cands.push(i); ws.push(w); total += w;
  }
  if (!cands.length) return -1;
  var r = Math.random() * total;
  for (var k = 0; k < cands.length; k++) { r -= ws[k]; if (r <= 0) return cands[k]; }
  return cands[cands.length - 1];
}
function npcGo(n, pi) {
  var p = POIS[pi];
  var path = astar(n.node, p.node);
  if (!path) { W.stats.astarFail++; return false; }
  n.path = path;
  n.pi = dist(n.fx, n.fy, WG.x[path[0]], WG.y[path[0]]) < 14 ? 1 : 0;
  n.tail = null;
  if (dist(p.x, p.y, WG.x[p.node], WG.y[p.node]) > 2 && !footHit(p.x, p.y)
    && losClear(WG.x[p.node], WG.y[p.node], p.x, p.y)) n.tail = { x: p.x, y: p.y };
  n.poi = pi; n.pending = ""; n.crossing = false;
  n.state = "walk";
  npcBeginEdge(n);
  return true;
}
function npcWander(n) {
  var adj = n.node >= 0 ? WG.adj[n.node] : [];
  var opts = [];
  for (var j = 0; j < adj.length; j++) if (adj[j].kind === 0) opts.push(adj[j].to);
  if (!opts.length) { n.state = "think"; n.t = 2; return; }
  n.path = [n.node, opts[rndi(0, opts.length - 1)]];
  n.pi = 1; n.tail = null; n.poi = -1; n.pending = ""; n.state = "walk";
}
function npcReached(n) {
  n.path = null; n.crossing = false;
  if (n.pending === "instore") {
    n.pending = "";
    npcStartDwell(n, rnd(4, 10), -1, true);
    return;
  }
  if (n.poi >= 0) {
    var p = POIS[n.poi];
    n.lastPoi = n.poi; n.poi = -1;
    W.stats.poiArrivals++;
    n.arrivals++;
    npcArriveKind(n, p);
    return;
  }
  n.state = "think"; n.t = rnd(0.3, 1.2);
}
function npcArriveKind(n, p) {
  n.lastKind = p.kind;
  var k = p.kind;
  if (k === "window") { npcStartDwell(n, rnd(2, 6), p.dir, false); return; }
  if (k === "shop") {
    var inner = -1, adj = WG.adj[p.node];
    for (var j = 0; j < adj.length; j++) {
      var to = adj[j].to;
      if (WG.k[to] === 3 && (inner < 0 || Math.random() < 0.5)) inner = to;
    }
    if (inner >= 0) {
      n.path = [p.node, inner]; n.pi = 1; n.tail = null; n.pending = "instore"; n.state = "walk";
    } else npcStartDwell(n, rnd(4, 10), -1, true);
    return;
  }
  if (k === "bench") {
    n.fy += 3; n.benchShift = true;
    npcStartDwell(n, rnd(5, 12), p.dir >= 0 ? p.dir : 0, false);
    return;
  }
  if (k === "plaza" || k === "fountain" || k === "park") {
    var pts = [];
    for (var t = 0; t < 8 && pts.length < 3; t++) {
      var ang = Math.random() * Math.PI * 2, rr = rnd(18, 40);
      var lx = p.x + Math.cos(ang) * rr, ly = p.y + Math.sin(ang) * rr;
      if (!footHit(lx, ly) && losClear(p.x, p.y, lx, ly)) pts.push({ x: lx, y: ly });
    }
    if (pts.length && Math.random() < 0.6) {
      n.loop = pts; n.li = 0; n.state = "loop";
    } else npcStartDwell(n, rnd(4, 8), -1, true);
    return;
  }
  npcStartDwell(n, rnd(5, 10), p.dir >= 0 ? p.dir : 0, false);
}
/** 同伴：跟在领头者左侧 14px（贴墙时退到身后）。 */
function npcFollow(n, dt) {
  var L = n.leader;
  if (!L || L.dead) {
    n.leader = null;
    n.node = nearestNode(n.fx, n.fy, 96, null);
    if (n.node < 0) n.node = L ? L.node : 0;
    n.state = "think"; n.t = 0.5;
    return;
  }
  var fv = DIRV[L.dir], g = WCFG.pairGap;
  var tx = L.fx + fv.y * g, ty = L.fy - fv.x * g;
  if (footHit(tx, ty) || !losClear(L.fx, L.fy, tx, ty)) {
    tx = L.fx - fv.x * g; ty = L.fy - fv.y * g;
    if (footHit(tx, ty) || !losClear(L.fx, L.fy, tx, ty)) { tx = L.fx; ty = L.fy; }
  }
  var d = dist(n.fx, n.fy, tx, ty);
  if (d > 90) { n.fx = tx; n.fy = ty; }
  else if (d > 2) npcStep(n, tx, ty, Math.min(Math.max(L.speed * 1.5, 20), d * 4 + 10), dt);
  if (!n.moving) n.dir = L.dir;
  n.bld = L.bld; n.node = L.node; n.crossing = L.crossing;
  n.stuckT = 0;
}
/** 受惊逃跑：沿行人图跑向远离威胁的节点。 */
function npcFlee(n, tx, ty) {
  if (n.dead || !WG.ok) return;
  if (n.leader) { n.leader.follower = null; n.leader = null; }
  if (n.follower) { var f = n.follower; n.follower = null; f.leader = null; npcFlee(f, tx, ty); }
  if (n.benchShift) { n.fy -= 3; n.benchShift = false; }
  var start = nearestNode(n.fx, n.fy, 96, function (id) { return losClear(n.fx, n.fy, WG.x[id], WG.y[id]); });
  if (start < 0) start = n.node;
  if (start < 0) return;
  var d0 = dist(n.fx, n.fy, tx, ty), best = -1, sw = WG.sidewalk;
  for (var t = 0; t < 40 && best < 0; t++) {
    var id = sw[rndi(0, sw.length - 1)];
    var dn = dist(WG.x[id], WG.y[id], n.fx, n.fy);
    if (dn < 120 || dn > 480 || WG.comp[id] !== WG.comp[start]) continue;
    if (dist(WG.x[id], WG.y[id], tx, ty) > d0 + 140) best = id;
  }
  var path = best >= 0 ? astar(start, best) : null;
  n.node = start;
  n.path = path || [start];
  n.pi = 0; n.tail = null; n.loop = null; n.poi = -1; n.pending = "";
  n.state = "flee"; n.t = rnd(5, 7); n.crossing = true;
  W.stats.flees++;
}
function npcOnCrime(c) {
  var cx = Number(c.x), cy = Number(c.y);
  if (isNaN(cx) || isNaN(cy)) { cx = W.pfx; cy = W.pfy; }
  for (var i = 0; i < W.npcs.length; i++) {
    var n = W.npcs[i];
    if (n.dead || n.state === "flee") continue;
    if (n.bld && n.bld !== W.pBld) continue;
    if (dist(n.fx, n.fy, cx, cy) < WCFG.witnessRadius) npcFlee(n, cx, cy);
  }
}
// ==== [/WALK+NPC] ====

// ==== [TRAFFIC] ====
// 交通车：每辆车一个隐形司机（tag driver）。followRoad 连续开往随机远处路口，
// 快到目标前就接上下一段（不在目标处减速、不掉头）；红灯/前车/行人用 brake 比例减速。
var ROADS = { ok: false, x: {}, y: {}, deg: {}, adj: {}, lim: {}, inter: [], edges: [] };
function roadInit() {
  ROADS.ok = false; ROADS.x = {}; ROADS.y = {}; ROADS.deg = {}; ROADS.adj = {}; ROADS.lim = {};
  ROADS.inter = []; ROADS.edges = [];
  var ns = [], es = [], i;
  try {
    if (!bwe.road.hasData()) return;
    ns = bwe.road.nodes(); es = bwe.road.edges();
  } catch (err) { return; }
  for (i = 0; i < ns.length; i++) {
    var id = String(ns[i].id);
    ROADS.x[id] = ns[i].x; ROADS.y[id] = ns[i].y; ROADS.deg[id] = 0; ROADS.adj[id] = [];
  }
  for (i = 0; i < es.length; i++) {
    var e = es[i], a = String(e.from), b = String(e.to);
    if (ROADS.x[a] === undefined || ROADS.x[b] === undefined || a === b) continue;
    if (ROADS.adj[a].indexOf(b) >= 0) continue;
    ROADS.deg[a]++; ROADS.deg[b]++;
    ROADS.adj[a].push(b); ROADS.adj[b].push(a);
    ROADS.lim[a + "|" + b] = e.speedLimit; ROADS.lim[b + "|" + a] = e.speedLimit;
    ROADS.edges.push({ a: a, b: b, w: e.width });
  }
  for (i = 0; i < ns.length; i++) {
    var nid = String(ns[i].id);
    if (String(ns[i].kind) === "intersection" && ROADS.deg[nid] >= 3) ROADS.inter.push(nid);
  }
  ROADS.ok = ROADS.inter.length > 1;
}
function segDist(px, py, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  var t = L2 < 1e-6 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1);
  return dist(px, py, ax + dx * t, ay + dy * t);
}
/** 车头前方 / 车尾后方的路网节点（优先 VehicleInfo.nextNode，缺省按几何）。 */
function carAhead(car) {
  var info = bwe.vehicle.of(car);
  var nx = info ? String(info["nextNode"] || "") : "";
  var pv = info ? String(info["prevNode"] || "") : "";
  if (nx && ROADS.x[nx] !== undefined) return { ahead: nx, behind: pv };
  var h = bwe.vehicle.heading(car) * DEG, hx = Math.cos(h), hy = Math.sin(h);
  var best = null, bd = 1e9;
  for (var i = 0; i < ROADS.edges.length; i++) {
    var e = ROADS.edges[i];
    var ax = ROADS.x[e.a], ay = ROADS.y[e.a], bx = ROADS.x[e.b], by = ROADS.y[e.b];
    var L = Math.max(1e-3, dist(ax, ay, bx, by));
    var d = segDist(car.x, car.y, ax, ay, bx, by) + (1 - Math.abs(((bx - ax) * hx + (by - ay) * hy) / L)) * 12;
    if (d < bd) { bd = d; best = e; }
  }
  if (!best) return { ahead: "", behind: "" };
  var toB = (ROADS.x[best.b] - ROADS.x[best.a]) * hx + (ROADS.y[best.b] - ROADS.y[best.a]) * hy >= 0;
  return toB ? { ahead: best.b, behind: best.a } : { ahead: best.a, behind: best.b };
}
/** 随机远处路口（大致在前方、不掉头、非死路）。 */
function carPickTarget(car, ahead, behind) {
  var h = bwe.vehicle.heading(car) * DEG, hx = Math.cos(h), hy = Math.sin(h);
  var inter = ROADS.inter, deadEnd = (ROADS.deg[ahead] || 0) <= 1;
  for (var t = 0; t < 16; t++) {
    var id = inter[rndi(0, inter.length - 1)];
    if (id === ahead || id === behind) continue;
    var dx = ROADS.x[id] - car.x, dy = ROADS.y[id] - car.y, d = Math.sqrt(dx * dx + dy * dy);
    if (t < 10 && (d < 800 || d > 2600)) continue;
    if (t < 8 && dx * hx + dy * hy < d * 0.2) continue;
    var r = null;
    try { r = bwe.road.route(ahead, id); } catch (err) { r = null; }
    if (!r || r.length < 2) continue;
    if (!deadEnd && behind && String(r[1].id) === behind) continue;
    return id;
  }
  // 兜底：顺着前方节点往前走几步，找一个不回头的路口
  var prev = behind, cur = ahead;
  for (var s = 0; s < 8; s++) {
    var nb = ROADS.adj[cur] || [], opts = [];
    for (var k = 0; k < nb.length; k++) if (nb[k] !== prev) opts.push(nb[k]);
    if (!opts.length) break;
    prev = cur; cur = opts[rndi(0, opts.length - 1)];
    if (s >= 1 && (ROADS.deg[cur] || 0) >= 3) return cur;
  }
  return cur !== ahead ? cur : "";
}
function carGo(c) {
  var car = c.e;
  if (!car || !car.alive) return false;
  var a = carAhead(car);
  var tgt = a.ahead ? carPickTarget(car, a.ahead, a.behind) : "";
  var ok = false;
  if (tgt) {
    var gen = W.gen;
    ok = bwe.vehicle.followRoad(car, tgt, {
      onArrive: function () {
        if (gen !== W.gen || W.dead) return;
        guard("车辆到达", function () { if (W.traffic.indexOf(c) >= 0) carGo(c); });
      }
    });
  }
  if (!ok) { c.failT = 2; W.stats.carPlanFail++; return false; }
  c.target = tgt; c.brake = -1; c.failT = 0;
  return true;
}
function carRetarget(c) {
  W.stats.retargets++;
  c.idle = 0; c.blockT = 0;
  carGo(c);
}
function carNear(x, y, r) {
  var lists = [W.traffic, W.parked, W.abandoned], i, j;
  for (i = 0; i < lists.length; i++) {
    for (j = 0; j < lists[i].length; j++) {
      var it = lists[i][j], e = it.e ? it.e : it;
      if (e && e.alive && dist(e.x, e.y, x, y) < r) return true;
    }
  }
  if (W.pCar && dist(W.pCar.x, W.pCar.y, x, y) < r) return true;
  return false;
}
function carSpawnOpts(x, y, heading, tags) {
  var asset = CAR_ASSETS[rndi(0, CAR_ASSETS.length - 1)];
  var van = asset === "vehicle-van";
  return {
    kind: "car", x: x, y: y, heading: heading, rotation: heading, asset: asset,
    name: van ? "货车" : "轿车", tags: tags, z: CAR_Z[asset], layer: 3,
    halfW: van ? 36 : 32, halfH: van ? 17 : 16, speedLimit: 260
  };
}
function trafficSpawn(sp) {
  var o = carSpawnOpts(Number(sp.x), Number(sp.y), Number(sp.heading) || 0, ["vehicle", "car", "traffic"]);
  var car = bwe.vehicle.spawn(o);
  if (!car) return null;
  var skin = SKINS[rndi(0, SKINS.length - 1)];
  var drv = bwe.world.spawn({
    x: o.x, y: o.y, asset: skin, name: "司机", kind: "ACTOR", tags: ["driver"],
    z: SKIN_Z[skin], layer: 3, halfW: 8, halfH: 12, visible: false, animMode: "只显示首帧"
  });
  if (drv) bwe.vehicle.enter(drv, car);
  var c = {
    e: car, drv: drv, skin: skin, asset: o.asset, halfW: o.halfW, f: rnd(0.6, 1.0),
    target: "", brake: -1, lx: car.x, ly: car.y, chkT: 1, idle: 0, blockT: 0, pushT: 0, failT: 0,
    reason: "", redWait: false
  };
  W.traffic.push(c);
  W.stats.carsSpawned++;
  carGo(c);
  return c;
}
function trafficInit() {
  roadInit();
  W.carPopT = 0.5;
  if (!hasCity()) return;
  var i, ps = CITY.parking || [];
  for (i = 0; i < ps.length; i++) {
    var pe = bwe.vehicle.spawn(carSpawnOpts(Number(ps[i].x), Number(ps[i].y), Number(ps[i].heading) || 0,
      ["vehicle", "car", "parked"]));
    if (pe) W.parked.push(pe);
  }
  if (!ROADS.ok) { wlog("路网缺失：不生成交通车"); return; }
  var sps = (CITY.carSpawns || []).slice(0), near = [], far = [];
  for (i = 0; i < sps.length; i++) {
    var d = dist(sps[i].x, sps[i].y, W.pfx, W.pfy);
    if (d >= 140 && d <= WCFG.trafficSpawnMax) near.push(sps[i]);
    else if (d > WCFG.trafficSpawnMax && d < WCFG.trafficRecycle) far.push(sps[i]);
  }
  var pools = [near, far];
  for (var p = 0; p < pools.length; p++) {
    var pool = pools[p];
    while (pool.length && W.traffic.length < WCFG.trafficCount) {
      var sp = pool.splice(rndi(0, pool.length - 1), 1)[0];
      if (!carNear(sp.x, sp.y, 110)) trafficSpawn(sp);
    }
  }
}
function trafficFind(car) {
  for (var i = 0; i < W.traffic.length; i++) if (W.traffic[i].e === car) return W.traffic[i];
  return null;
}
function trafficForget(car) {
  var c = trafficFind(car);
  if (c) removeFrom(W.traffic, c);
}
function trafficDespawn(c) {
  removeFrom(W.traffic, c);
  if (c.drv && c.drv.alive) killEntity(c.drv);
  killEntity(c.e);
}
function trafficOnHijack(info) {
  var car = info.vehicle, victim = info.actor;
  var c = car ? trafficFind(car) : null;
  if (c) removeFrom(W.traffic, c);
  if (car) removeFrom(W.parked, car);
  W.stats.hijacks++;
  if (victim && victim.alive && victim !== W.player) victimFlee(victim, c ? c.skin : "actor-npc");
}
/** 被劫司机：现身、去掉 driver、加 npc，先逃上最近的人行道，再沿人行道跑远后消失。 */
function victimFlee(e, skin) {
  e.visible = true;
  e.removeTag("driver");
  e.addTag("npc");
  e.z = SKIN_Z[skin] || 10;
  e.hpMax = 30; e.hp = 30;
  var fx = e.x, fy = e.y + 8;
  bwe.log("[交通] 司机被赶下车，逃向人行道");
  if (!WG.ok) { W.corpses.push({ e: e, t: W.t + 4 }); return; }
  var node = nearestNode(fx, fy, 320, function (id) {
    return WG.k[id] <= 1 && losClear(fx, fy, WG.x[id], WG.y[id]);
  });
  if (node < 0) node = nearestNode(fx, fy, 800, function (id) { return WG.k[id] <= 1; });
  var n = npcAdopt(e, skin, node, fx, fy);
  n.kind = "victim"; n.onWalk = false;
  n.path = node >= 0 ? [node] : null; n.pi = 0; n.tail = null;
  n.state = "flee"; n.t = 12; n.crossing = true;
  W.stats.flees++;
}
/** 前方障碍对本车的限速（0 = 必须停）。 */
function obstacleSpeed(c, hx, hy, sp, ox, oy, ohw, ohh, ohx, ohy, osp) {
  var car = c.e;
  var rx = ox - car.x, ry = oy - car.y;
  var along = rx * hx + ry * hy;
  var look = 30 + c.halfW + ohw + Math.max(0, sp) * 0.8;
  if (along <= 0 || along > look) return 1e9;
  var lat = Math.abs(-rx * hy + ry * hx);
  var dotH = ohx * hx + ohy * hy;
  var crossH = Math.abs(ohx * hy - ohy * hx);
  var latLim = 12 + ohw * crossH + ohh * Math.abs(dotH);
  if (lat > latLim) return 1e9;
  var gap = along - c.halfW - (ohw * Math.abs(dotH) + ohh * crossH) - 8;
  if (gap <= 0) return 0;
  var vAlong = Math.max(0, osp * dotH);
  return Math.min(Math.sqrt(2 * 300 * gap), vAlong + gap * 1.5);
}
function carControl(c, dt) {
  var car = c.e;
  var info = bwe.vehicle.of(car);
  if (!info) return;
  var sp = Number(info.speed) || 0;
  var h = Number(info.heading) * DEG, hx = Math.cos(h), hy = Math.sin(h);
  var nx = String(info["nextNode"] || ""), pv = String(info["prevNode"] || "");
  var inJ = !!info["inJunction"];
  var lim = ROADS.lim[pv + "|" + nx] || 180;
  var desired = lim * c.f, reason = "";
  // 1) 提前接上下一段路线（不在目标路口刹停）
  if (info.autoDrive && nx && nx === c.target && !inJ && c.failT <= 0) {
    var nd = Number(info["nextNodeDist"]);
    if (nd > 0 && nd < 170 + Math.abs(sp) * 0.6) { carGo(c); return; }
  }
  // 2) 红灯 / 黄灯
  var L = nx ? W.lightByNode[nx] : null;
  if (L && !inJ && ROADS.x[nx] !== undefined) {
    var tdx = hx, tdy = hy;
    if (pv && ROADS.x[pv] !== undefined) { tdx = ROADS.x[nx] - ROADS.x[pv]; tdy = ROADS.y[nx] - ROADS.y[pv]; }
    var axis = Math.abs(tdx) >= Math.abs(tdy) ? "h" : "v";
    var st = W.phase[axis];
    var cross = axis === "h" ? L.vHalf : L.hHalf;
    var along = (ROADS.x[nx] - car.x) * hx + (ROADS.y[nx] - car.y) * hy;
    // 车头停在横穿道路边缘外 20px（斑马线之前）
    var stopAt = along - (cross + 20 + c.halfW);
    var canStop = stopAt > sp * sp / (2 * 450) - 4;
    // 车头已压过停止线 12px 以上 → 视为已进路口，直接通过（不在斑马线上急刹）
    if (stopAt > -12 && (st === "red" || (st === "yellow" && (canStop || c.redWait)))) {
      var vr = stopAt <= 2 ? 0 : Math.sqrt(2 * 380 * stopAt);
      if (vr < desired) {
        desired = vr; reason = "red";
        if (!c.redWait && stopAt < 220) { c.redWait = true; W.stats.redStops++; }
      }
    } else c.redWait = false;
  } else c.redWait = false;
  // 3) 前车 / 行人 / 玩家
  if (c.pushT > 0) c.pushT -= dt;
  else {
    var vo = 1e9, i, o, oh;
    for (i = 0; i < W.traffic.length; i++) {
      o = W.traffic[i];
      if (o === c || !o.e.alive) continue;
      if (Math.abs(o.e.x - car.x) > 330 || Math.abs(o.e.y - car.y) > 330) continue;
      oh = o.e.rotation * DEG;
      vo = Math.min(vo, obstacleSpeed(c, hx, hy, sp, o.e.x, o.e.y, o.halfW, 16, Math.cos(oh), Math.sin(oh), bwe.vehicle.speed(o.e)));
    }
    var stills = [W.parked, W.abandoned];
    for (var s = 0; s < stills.length; s++) {
      for (i = 0; i < stills[s].length; i++) {
        o = stills[s][i];
        if (!o || !o.alive || o === W.pCar) continue;
        if (Math.abs(o.x - car.x) > 330 || Math.abs(o.y - car.y) > 330) continue;
        oh = o.rotation * DEG;
        vo = Math.min(vo, obstacleSpeed(c, hx, hy, sp, o.x, o.y, 32, 16, Math.cos(oh), Math.sin(oh), 0));
      }
    }
    if (W.pCar) {
      vo = Math.min(vo, obstacleSpeed(c, hx, hy, sp, W.pCar.x, W.pCar.y, 32, 16, W.pCarHx, W.pCarHy, W.pCarSpd));
    } else if (W.player && !W.pBld) {
      vo = Math.min(vo, obstacleSpeed(c, hx, hy, sp, W.pfx, W.pfy, 6, 6, 1, 0, 0));
    }
    for (i = 0; i < W.npcs.length; i++) {
      o = W.npcs[i];
      if (o.dead || o.bld || !(o.crossing || o.state === "flee" || o.kind === "victim")) continue;
      if (Math.abs(o.fx - car.x) > 260 || Math.abs(o.fy - car.y) > 260) continue;
      vo = Math.min(vo, obstacleSpeed(c, hx, hy, sp, o.fx, o.fy, 6, 6, 1, 0, 0));
    }
    for (i = 0; i < W.police.length; i++) {
      o = W.police[i];
      if (o.dead || o.bld) continue;
      if (Math.abs(o.fx - car.x) > 260 || Math.abs(o.fy - car.y) > 260) continue;
      vo = Math.min(vo, obstacleSpeed(c, hx, hy, sp, o.fx, o.fy, 6, 6, 1, 0, 0));
    }
    if (vo < desired) { desired = vo; reason = reason || "block"; }
  }
  c.reason = reason;
  var br = desired <= 1 ? 1 : clamp(1 - desired / Math.max(lim, 1), 0, 0.98);
  if (c.brake < 0 || Math.abs(br - c.brake) > 0.02 || (br === 1 && c.brake !== 1) || (br === 0 && c.brake !== 0)) {
    bwe.vehicle.brake(car, br);
    c.brake = br;
  }
  // 4) 卡住检测：每秒看位移
  c.chkT -= dt;
  if (c.chkT <= 0) {
    c.chkT = 1;
    var moved = dist(car.x, car.y, c.lx, c.ly);
    c.lx = car.x; c.ly = car.y;
    if (moved < 6) {
      if (reason === "red") { c.idle = 0; }
      else if (reason === "block") {
        c.blockT++;
        if (c.blockT === 6) { c.pushT = 1.5; }
        else if (c.blockT >= 14) carRetarget(c);
      } else {
        c.idle++;
        if (c.idle >= WCFG.carStuckSeconds) carRetarget(c);
      }
    } else { c.idle = 0; c.blockT = 0; }
  }
}
function trafficPopulation() {
  var i;
  for (i = W.traffic.length - 1; i >= 0; i--) {
    var c = W.traffic[i];
    if (!c.e || !c.e.alive) { removeFrom(W.traffic, c); if (c.drv && c.drv.alive) killEntity(c.drv); continue; }
    if (dist(c.e.x, c.e.y, W.pfx, W.pfy) > WCFG.trafficRecycle) { trafficDespawn(c); W.stats.carsRecycled++; }
  }
  var keepAb = [];
  for (i = 0; i < W.abandoned.length; i++) {
    var ab = W.abandoned[i];
    if (ab && ab.alive && ab !== W.pCar && keepAb.length < 12) keepAb.push(ab);
  }
  W.abandoned = keepAb;
  if (!ROADS.ok || !hasCity()) return;
  var sps = CITY.carSpawns || [];
  var spawned = 0, tries = 0;
  while (W.traffic.length < WCFG.trafficCount && spawned < 2 && tries++ < 20 && sps.length) {
    var sp = sps[rndi(0, sps.length - 1)];
    var d = dist(sp.x, sp.y, W.pfx, W.pfy);
    if (d < WCFG.trafficSpawnMin || d > WCFG.trafficSpawnMax || carNear(sp.x, sp.y, 110)) continue;
    if (trafficSpawn(sp)) spawned++;
  }
}
function trafficTick(dt) {
  W.carPopT -= dt;
  if (W.carPopT <= 0) { W.carPopT = 0.5; trafficPopulation(); }
  var list = W.traffic.slice(0);
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (W.traffic.indexOf(c) < 0 || !c.e || !c.e.alive) continue;
    try {
      var vi = bwe.vehicle.of(c.e);
      if (!vi) { removeFrom(W.traffic, c); continue; }
      if (c.failT > 0) c.failT -= dt;
      if (!vi.autoDrive) {
        // 路线走完但续接失败 / 被外力打断：冷却后重新出发（不计入卡住重规划）
        if (c.failT <= 0) carGo(c);
        continue;
      }
      carControl(c, dt);
    } catch (err) { logErr("交通", err); c.failT = 2; }
  }
}
// ==== [/TRAFFIC] ====

// ==== [POLICE] ====
// 步行警察：沿行人图（含门）追捕；近距离无墙时直追；3 星以上会动手；贴身 1s 即逮捕。
function copWant() {
  if (W.wanted <= 0) return 0;
  return Math.min(WCFG.policeMax, W.wanted + (W.wanted >= 3 ? 1 : 0));
}
function copSpawn() {
  var id = pickSpawnNode(420, 760);
  if (id < 0) id = pickSpawnNode(250, 1100);
  if (id < 0) return;
  var e = bwe.world.spawn({
    x: WG.x[id], y: WG.y[id] - 8, asset: "actor-police", name: "警察", kind: "ACTOR",
    tags: ["police"], z: SKIN_Z["actor-police"], layer: 3, halfW: 8, halfH: 12, animMode: "只显示首帧"
  });
  if (!e) return;
  e.hpMax = 60; e.hp = 60;
  var c = {
    e: e, kind: "cop", node: id, fx: WG.x[id], fy: WG.y[id], speed: WCFG.policeSpeed, fps: 8, lane: 0,
    dir: 0, frame: -1, animT: 0, moving: false, state: "chase", path: null, pi: 0, tail: null,
    bld: "", vis: true, stuckT: 0, unst: 0, crossing: false, replanT: 0, atkT: 1,
    leaving: false, leaveT: 0, dead: false
  };
  e.on("death", function (by) {
    if (c.dead) return;
    c.dead = true;
    try {
      e.removeTag("police"); e.addTag("corpse");
      e.rotation = 90; e.setColor(0.7, 0.7, 0.7, 1);
    } catch (err) { /* ignore */ }
    W.corpses.push({ e: e, t: W.t + 15 });
  });
  W.police.push(c);
  W.stats.policeSpawned++;
  bwe.log("[警察] 出警（" + W.police.length + "/" + copWant() + "）");
}
function losNode(x, y, r, pred) {
  return nearestNode(x, y, r, function (id) {
    return (!pred || pred(id)) && losClear(x, y, WG.x[id], WG.y[id]);
  });
}
function copPlan(c, px, py) {
  c.replanT = 1.5;
  var start = losNode(c.fx, c.fy, 160, null);
  if (start < 0) start = c.node;
  var goal = losNode(px, py, 220, function (id) { return W.pBld ? WG.b[id] === W.pBld : WG.k[id] !== 3; });
  if (goal < 0) goal = nearestNode(px, py, 500, null);
  if (start < 0 || goal < 0) { c.path = null; return; }
  var path = astar(start, goal);
  c.node = start;
  c.path = path;
  c.pi = path && dist(c.fx, c.fy, WG.x[path[0]], WG.y[path[0]]) < 14 ? 1 : 0;
  c.tail = null;
}
function copUnstick(c) {
  c.stuckT = 0; c.replanT = 0; c.path = null; c.unst++;
  if (c.unst >= 3) {
    var nn = nearestNode(c.fx, c.fy, 200, null);
    if (nn >= 0) { c.fx = WG.x[nn]; c.fy = WG.y[nn]; c.node = nn; c.bld = WG.b[nn]; }
    c.unst = 0;
  }
}
function copDespawn(c) {
  if (c.dead) return;
  c.dead = true;
  killEntity(c.e);
}
function copUpdate(c, dt, p) {
  var e = c.e;
  c.fx = e.x; c.fy = e.y + 8;
  var ox = c.fx, oy = c.fy, close = false;
  c.moving = false;
  c.atkT -= dt; c.replanT -= dt;
  var d = dist(c.fx, c.fy, W.pfx, W.pfy);
  if (c.leaving) {
    c.leaveT -= dt;
    if (c.leaveT <= 0 || d > 650) { copDespawn(c); return false; }
    if (npcWalk(c, dt, c.speed * 0.6)) c.leaveT = Math.min(c.leaveT, 1);
  } else {
    var same = c.bld === W.pBld && W.pLevel === 0;
    if (d < 140 && same && losClear(c.fx, c.fy, W.pfx, W.pfy)) {
      c.path = null; c.tail = null;
      if (d > 18) npcStep(c, W.pfx, W.pfy, c.speed * (W.pCar ? 1.15 : 1), dt);
      else c.dir = faceDir(W.pfx - c.fx, W.pfy - c.fy);
    } else {
      if (!c.path || c.replanT <= 0) copPlan(c, W.pfx, W.pfy);
      if (c.path && npcWalk(c, dt, c.speed)) { c.path = null; c.replanT = 0.4; }
    }
    if (p && same && !W.pCar && d <= 28 && W.wanted >= 3 && c.atkT <= 0) {
      c.atkT = 1.1;
      try { bwe.combat.hit({ from: e, to: p, amount: 7, knockback: 60 }); } catch (err) { /* ignore */ }
    }
    close = same && d <= WCFG.arrestRadius;
  }
  if (c.stuckT > 1.2) copUnstick(c);
  if (c.fx !== ox || c.fy !== oy) e.setPos(c.fx, c.fy - 8);
  if (c.moving) c.animT += dt;
  var frame = c.dir * 4 + (c.moving ? Math.floor(c.animT * c.fps) % 4 : 0);
  if (frame !== c.frame) { c.frame = frame; e.setFrame(frame); }
  var vis = !c.bld || (c.bld === W.pBld && W.pLevel === 0);
  if (vis !== c.vis) { c.vis = vis; e.visible = vis; }
  return close;
}
function policeTick(dt) {
  if (!WG.ok) return;
  var p = playerEnt(), i, c;
  var want = copWant(), active = 0;
  for (i = 0; i < W.police.length; i++) if (!W.police[i].dead && !W.police[i].leaving) active++;
  W.copSpawnT -= dt;
  if (active < want && W.copSpawnT <= 0) { W.copSpawnT = 2.5; copSpawn(); }
  var near = false;
  for (i = 0; i < W.police.length; i++) {
    c = W.police[i];
    if (c.dead) continue;
    if (!c.e || !c.e.alive) { c.dead = true; continue; }
    try { if (copUpdate(c, dt, p)) near = true; } catch (err) { logErr("警察", err); c.path = null; c.replanT = 1; }
  }
  var keep = [];
  for (i = 0; i < W.police.length; i++) if (!W.police[i].dead) keep.push(W.police[i]);
  W.police = keep;
  if (near && p && !W.pCar && W.pLevel === 0 && W.wanted > 0) {
    W.bustT += dt;
    if (W.bustT >= WCFG.arrestSeconds) bust();
  } else W.bustT = Math.max(0, W.bustT - dt * 2);
}
function bust() {
  var fine = Math.min(300, W.wanted * 50);
  W.stats.arrests++;
  W.bustT = 0;
  bwe.log("[警察] 玩家被捕，罚款 $" + fine);
  bwe.world.emit("busted", { fine: fine });
  resetWanted("被捕");
}
/** 通缉清零：警察收队（往远处走，出屏或 8s 后消失）。 */
function policeLeaveAll() {
  for (var i = 0; i < W.police.length; i++) {
    var c = W.police[i];
    if (c.dead || c.leaving) continue;
    c.leaving = true; c.leaveT = 8;
    var start = losNode(c.fx, c.fy, 160, null);
    var goal = pickSpawnNode(500, 900);
    c.path = start >= 0 && goal >= 0 ? astar(start, goal) : null;
    c.pi = 0; c.tail = null;
    if (!c.path) c.leaveT = 0;
  }
}
/** 立即撤掉所有警察（被捕 / 玩家倒下 / 复活）。 */
function policeClearAll() {
  for (var i = 0; i < W.police.length; i++) copDespawn(W.police[i]);
  W.police = [];
  W.bustT = 0;
}
// ==== [/POLICE] ====
