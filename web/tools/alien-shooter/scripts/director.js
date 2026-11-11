// director.js —— 孤胆枪手：关卡导演（场景脚本 onStartScript）。
//
// 负责：
//   - 怪物寻路用的「距离场」（以玩家所在格为源点的 BFS，每 0.25 秒或玩家换格时重算）；
//   - 怪物分桶邻居查询（分离力用，避免每只怪都扫一遍全图）；
//   - 巢穴刷怪（巢穴活着就一直出怪，有上限；原作打掉巢穴才算清场）；
//   - 掉落物（木箱掉的钱/弹药/药包/武器），12 秒后闪烁消失；
//   - 裂墙：油桶/气瓶的爆炸炸开裂墙，露出地下入口；走进入口 → 过关；
//   - 游戏结束 / 过关后按 R 重开。

var TILE = 32;
var COLS = 64, ROWS = 48;
var FLOW_EVERY = 0.25;
var MAX_ALIENS = 46;           // 同屏上限（原作一屏几十只是常态）
var NEST_EVERY = [3.2, 5.0];   // 巢穴出怪间隔（秒，随机区间）
var NEST_WAKE = 560;           // 玩家离巢穴多近才开始出怪
var PICKUP_LIFE = 12;

var flow = null;               // Int16Array 风格的普通数组：到玩家的步数，-1 = 不可达
var flowT = 0, flowCell = -1;
var buckets = {};              // "bx,by" -> [alien]
var aliens = [];
var nests = [];
var pickups = [];              // {e, t}
var cracked = [];              // 裂墙 TILE 实体
var wallOpen = false;
var exitE = null;
var ended = false;
var endT = 0;
var started = false;

function num(e, k, d) {
  var v = Number(e.prop(k, d));
  return isFinite(v) ? v : d;
}

function onSceneStart() {
  // 模块脚本（combat/fx/enemy）收不到 onSceneStart，由导演统一初始化；
  // 场景重开（R）会清空全部 bwe.on 钩子，所以钩子也在这里重新注册。
  bwe.call("combat", "init");
  bwe.call("fx", "init");
  bwe.call("enemy", "init");
  bwe.off("update", tick);
  bwe.on("update", tick);
  flow = null; flowT = 0; flowCell = -1;
  buckets = {}; aliens = []; pickups = [];
  wallOpen = false; ended = false; endT = 0; started = false;
  nests = bwe.world.findAll({ tag: "巢穴" }) || [];
  for (var i = 0; i < nests.length; i++) {
    nests[i].setProp("spawnT", String(1 + bwe.random() * 2));
  }
  cracked = bwe.world.findAll({ tag: "裂墙" }) || [];
  exitE = bwe.world.find("入口");
  if (exitE) exitE.visible = false;
  // 相机：以玩家为中心、不超前（原作就是死死锁在主角身上），按 640×480 的视野缩放
  var p = bwe.world.find("玩家");
  var sz = bwe.camera.size;
  bwe.camera.setZoom(Math.max(1, Math.min(sz.w / 640, sz.h / 480)));
  if (p) {
    bwe.camera.follow(p, { smooth: 0.3, lookAhead: 0 });
    bwe.camera.setPos(p.x, p.y);
  }
  bwe.camera.bounds({ x: 0, y: 0, w: COLS * TILE, h: ROWS * TILE });
  bwe.audio.stop("amb_night");
  bwe.audio.play("amb_night", { volume: 0.35, loop: true });
  bwe.log("[孤胆枪手] 第一关「潜入」开始：巢穴 " + nests.length + "，裂墙 " + cracked.length);
}

// ------------------------------------------------------------------ 距离场
function cellOf(x, y) {
  var cx = Math.floor(x / TILE), cy = Math.floor(y / TILE);
  if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return -1;
  return cy * COLS + cx;
}

function rebuildFlow(p) {
  var n = COLS * ROWS;
  if (!flow) flow = new Array(n);
  for (var i = 0; i < n; i++) flow[i] = -1;
  var src = cellOf(p.x, p.y);
  if (src < 0) return;
  var q = [src];
  flow[src] = 0;
  var head = 0;
  // 4 邻接 BFS；只扩展到 40 步（再远的怪本来就醒不了）
  while (head < q.length) {
    var c = q[head++];
    var dist = flow[c];
    if (dist >= 40) continue;
    var cx = c % COLS, cy = (c - cx) / COLS;
    if (cx > 0) visit(c - 1, cx - 1, cy, dist, q);
    if (cx < COLS - 1) visit(c + 1, cx + 1, cy, dist, q);
    if (cy > 0) visit(c - COLS, cx, cy - 1, dist, q);
    if (cy < ROWS - 1) visit(c + COLS, cx, cy + 1, dist, q);
  }
}

function visit(c, cx, cy, dist, q) {
  if (flow[c] !== -1) return;
  if (bwe.tilemap.solid(cx, cy)) { flow[c] = -2; return; }
  flow[c] = dist + 1;
  q.push(c);
}

/** 敌人问：从 (x,y) 往玩家走，下一步朝哪？返回单位向量（朝距离更小的邻格中心）。 */
function flowDir(x, y) {
  if (!flow) return { x: 0, y: 0 };
  var c = cellOf(x, y);
  if (c < 0 || flow[c] < 0) return { x: 0, y: 0 };
  var cx = c % COLS, cy = (c - cx) / COLS;
  var best = flow[c], bx = 0, by = 0;
  var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  for (var i = 0; i < dirs.length; i++) {
    var nx = cx + dirs[i][0], ny = cy + dirs[i][1];
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
    var v = flow[ny * COLS + nx];
    if (v < 0) continue;
    // 斜走要求两边都不是墙（不切墙角）
    if (dirs[i][0] !== 0 && dirs[i][1] !== 0) {
      if (flow[cy * COLS + nx] < 0 || flow[ny * COLS + cx] < 0) continue;
    }
    if (v < best) { best = v; bx = dirs[i][0]; by = dirs[i][1]; }
  }
  if (bx === 0 && by === 0) return { x: 0, y: 0 };
  // 朝目标格中心走（而不是纯方向），这样过门洞时会对准
  var tx = (cx + bx + 0.5) * TILE - x, ty = (cy + by + 0.5) * TILE - y;
  var l = Math.sqrt(tx * tx + ty * ty) || 1;
  return { x: tx / l, y: ty / l };
}

// ------------------------------------------------------------------ 怪物分桶
function rebucket() {
  buckets = {};
  aliens = bwe.world.findAll({ tag: "外星虫" }) || [];
  for (var i = 0; i < aliens.length; i++) {
    var a = aliens[i];
    var key = Math.floor(a.x / 64) + "," + Math.floor(a.y / 64);
    (buckets[key] || (buckets[key] = [])).push(a);
  }
}

function neighbors(e) {
  var bx = Math.floor(e.x / 64), by = Math.floor(e.y / 64);
  var out = [];
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      var b = buckets[(bx + dx) + "," + (by + dy)];
      if (!b) continue;
      for (var i = 0; i < b.length; i++) if (b[i] !== e && b[i].alive) out.push(b[i]);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 刷怪
function spawnAlien(color, x, y, awake) {
  var e = bwe.world.spawn({
    x: x, y: y, asset: color === "yellow" ? "黄蜘蛛" : "绿蜘蛛", name: "alien", kind: "ACTOR",
    layer: 2, z: 5, halfW: 16, halfH: 16, tags: ["外星虫", "可击中"], script: "enemy",
    props: { kind: "alien", color: color, hitR: color === "yellow" ? 14 : 12, awake: awake ? "1" : "0" }
  });
  return e;
}

function updateNests(p, dt) {
  if (aliens.length >= MAX_ALIENS) return;
  for (var i = 0; i < nests.length; i++) {
    var n = nests[i];
    if (!n.alive || String(n.prop("kind", "")) !== "nest") continue;
    var f = num(n, "flash", 0);
    if (f > 0) {
      f -= dt;
      n.setProp("flash", String(f));
      if (f <= 0) n.clearColor(); else n.setColor("#FFFFFF");
    }
    var dx = p.x - n.x, dy = p.y - n.y;
    if (dx * dx + dy * dy > NEST_WAKE * NEST_WAKE) continue;
    var t = num(n, "spawnT", 2) - dt;
    if (t <= 0) {
      t = NEST_EVERY[0] + bwe.random() * (NEST_EVERY[1] - NEST_EVERY[0]);
      var a = bwe.random() * Math.PI * 2;
      var color = bwe.random() < 0.25 ? "yellow" : "green";
      var sx = n.x + Math.cos(a) * 30, sy = n.y + Math.sin(a) * 30;
      if (!bwe.tilemap.blocked(sx - 12, sy - 12, 24, 24)) spawnAlien(color, sx, sy, true);
    }
    n.setProp("spawnT", String(t));
  }
}

function nestDied(e) {
  var left = 0;
  for (var i = 0; i < nests.length; i++) if (nests[i].alive && String(nests[i].prop("kind", "")) === "nest") left++;
  var p = bwe.world.find("玩家");
  if (p) {
    p.setProp("msg", left > 0 ? "巢穴已摧毁（还剩 " + left + " 个）" : "所有巢穴已摧毁！");
    p.setProp("msgT", "2.5");
  }
}

function alienDied(e) { /* 预留：统计用 */ }

// ------------------------------------------------------------------ 掉落物
function dropItem(drop, x, y) {
  var parts = String(drop).split(":");
  var type = parts[0], val = parts[1] || "";
  var asset = "钱", frame = 0, size = [20, 16];
  if (type === "money") { asset = "钱"; frame = Number(val) >= 150 ? 2 : (Number(val) >= 100 ? 1 : 0); }
  else if (type === "ammo") { asset = "弹药箱"; frame = val === "grenades" ? 1 : (val === "belt" ? 2 : 0); }
  else if (type === "medkit") { asset = "医疗包"; frame = -1; size = [18, 16]; }
  else if (type === "weapon") { asset = "武器箱"; frame = val === "launcher" ? 1 : (val === "mg" ? 2 : 0); size = [32, 16]; }
  var e = bwe.world.spawn({
    x: x, y: y, asset: asset, name: "pickup", kind: "PROP", layer: 1, z: 2,
    halfW: size[0] / 2, halfH: size[1] / 2, tags: ["拾取"],
    props: { item: type, val: val }
  });
  if (e && frame >= 0) e.setFrame(frame);
  // 武器箱不会消失（关键道具）；其余 12 秒后消失
  if (e) pickups.push({ e: e, t: type === "weapon" ? 1e9 : PICKUP_LIFE });
}

function updatePickups(p, dt) {
  for (var i = pickups.length - 1; i >= 0; i--) {
    var it = pickups[i];
    if (!it.e.alive) { pickups.splice(i, 1); continue; }
    it.t -= dt;
    if (it.t <= 0) { bwe.world.destroy(it.e); pickups.splice(i, 1); continue; }
    if (it.t < 3) it.e.visible = Math.floor(it.t * 8) % 2 === 0;
    var dx = p.x - it.e.x, dy = p.y - it.e.y;
    if (dx * dx + dy * dy < 22 * 22 && p.visible) {
      if (bwe.call("pickup", "take", p, it.e)) {
        bwe.world.destroy(it.e);
        pickups.splice(i, 1);
      }
    }
  }
}

/** 场景里预放的钱（地上的 $200 等）也走同一套拾取逻辑。 */
function registerStaticPickups() {
  var list = bwe.world.findAll({ tag: "拾取" }) || [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i].prop("frame", "");
    if (f !== "") list[i].setFrame(Number(f));
    pickups.push({ e: list[i], t: 1e9 });
  }
}

// ------------------------------------------------------------------ 裂墙 / 过关
function blastWalls(x, y, radius) {
  if (wallOpen) return;
  var hitAny = false;
  for (var i = 0; i < cracked.length; i++) {
    var w = cracked[i];
    if (!w.alive) continue;
    var dx = w.x - x, dy = w.y - y;
    if (dx * dx + dy * dy < (radius + 24) * (radius + 24)) { hitAny = true; break; }
  }
  if (!hitAny) return;
  wallOpen = true;
  for (var j = 0; j < cracked.length; j++) {
    var c = cracked[j];
    if (!c.alive) continue;
    bwe.tilemap.set(Math.floor(c.x / TILE), Math.floor(c.y / TILE), 0);
    bwe.call("fx", "debris", c.x, c.y);
    bwe.call("fx", "scorch", c.x, c.y);
    bwe.world.destroy(c);
  }
  // 遮光体也一起拆掉（裂墙那一段单独做成了一块遮挡）
  var occ = bwe.world.findAll({ tag: "裂墙遮挡" }) || [];
  for (var k = 0; k < occ.length; k++) bwe.world.destroy(occ[k]);
  bwe.audio.play("snd_wall", { volume: 1.0 });
  bwe.camera.shake(12, 0.6);
  if (exitE) exitE.visible = true;
  flowCell = -1;  // 地形变了：下一帧重算距离场
  var p = bwe.world.find("玩家");
  if (p) { p.setProp("msg", "墙被炸开了！进入地下入口"); p.setProp("msgT", "3.5"); }
  bwe.log("[孤胆枪手] 裂墙被炸开");
}

function checkExit(p) {
  if (!wallOpen || !exitE || ended) return;
  var dx = p.x - exitE.x, dy = p.y - exitE.y;
  if (dx * dx + dy * dy < 26 * 26) {
    ended = true;
    p.setProp("win", "1");
    bwe.audio.play("snd_win", { volume: 0.9 });
    bwe.log("[孤胆枪手] 过关：进入地下入口（击杀 " + num(p, "kills", 0) + "，金钱 $" + num(p, "money", 0) + "）");
  }
}

// ------------------------------------------------------------------ 主循环
function tick(dt) {
  var p = bwe.world.find("玩家");
  if (!p) return;
  if (!started) {
    started = true;
    registerStaticPickups();
  }
  rebucket();
  var c = cellOf(p.x, p.y);
  flowT -= dt;
  if (c !== flowCell || flowT <= 0) {
    flowCell = c;
    flowT = FLOW_EVERY;
    rebuildFlow(p);
  }
  if (num(p, "over", 0) > 0 || num(p, "win", 0) > 0) {
    endT += dt;
    if (endT > 0.8 && bwe.input.pressed("KeyR")) bwe.scene.switchTo(bwe.scene.current().name);
    return;
  }
  updateNests(p, dt);
  updatePickups(p, dt);
  checkExit(p);
}
