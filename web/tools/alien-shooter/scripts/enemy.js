// enemy.js —— 孤胆枪手：外星虫（绿蜘蛛 / 黄蜘蛛）。
//
// 原作手感：
//   - 怪一看见你就直线扑过来（不绕弯、不躲子弹），速度跟人差不多甚至更快，靠数量压人；
//   - 贴身就咬，咬的伤害不高但频率快 —— 被一群围住几秒就死；
//   - 中弹会被打得「一顿」（短暂减速 + 往后推一点），这是打击感的关键；
//   - 没直接视线时，沿导演维护的「距离场」往玩家那边绕（墙后的怪也会找门绕过来）。
//
// 血量：props.life（combat.js 扣），不用引擎 hp —— 不想要引擎自动画的血条。

var TYPES = {
  green:  { life: 26, speed: 132, bite: 6,  biteEvery: 0.45, radius: 11, frameRate: 13 },
  yellow: { life: 60, speed: 112, bite: 11, biteEvery: 0.55, radius: 13, frameRate: 11 }
};
var SIGHT = 520;       // 超过这个距离、且看不见玩家 → 原地发呆（省 CPU 也符合原作「不开灯不招怪」）
var WAKE_RANGE = 360;  // 在这个距离内一定会醒（哪怕没视线）

var st = {};           // e.id -> 状态

function num(e, k, d) {
  var v = Number(e.prop(k, d));
  return isFinite(v) ? v : d;
}

/** director 场景开始时调用：清掉上一局的怪物状态表。 */
function init() {
  st = {};
}

// bwe.call 的返回值类型是 unknown：在这里统一收窄
function vec(v) {
  var o = v && typeof v === "object" ? v : {};
  var x = Number(o["x"]), y = Number(o["y"]);
  return { x: isFinite(x) ? x : 0, y: isFinite(y) ? y : 0 };
}
function list(v) {
  return Object.prototype.toString.call(v) === "[object Array]" ? v : [];
}

function stateOf(e) {
  var s = st[e.id];
  if (!s) {
    var type = TYPES[String(e.prop("color", "green"))] || TYPES.green;
    s = {
      type: type,
      awake: e.prop("awake", "0") === "1",
      stun: 0,
      bite: bwe.random() * 0.3,
      walkT: bwe.random(),
      losT: 0,
      los: false,
      jitter: (bwe.random() - 0.5) * 0.5,  // 每只怪扑过来的角度略有不同，避免叠成一条线
      dir: Math.floor(bwe.random() * 16),
      lastX: e.x, lastY: e.y, stuckT: 0
    };
    st[e.id] = s;
    if (e.prop("life", "") === "") e.setProp("life", String(type.life));
  }
  return s;
}

// ⚠ 脚本 spawn 的怪：onStart 执行时 spawn 的 props（color/awake）还没写进去，
// 所以状态在第一帧 onUpdate 里才建（stateOf 惰性创建），onStart 什么都不做。
function onStart(ctx) {
  delete st[ctx.self.id];
}

function onDestroy(ctx) {
  delete st[ctx.self.id];
}

/** combat.js 命中回调：顿一下 + 后推（打击感）。 */
function onHit(e, dmg, angDeg) {
  var s = stateOf(e);
  s.awake = true;
  s.stun = Math.max(s.stun, Math.min(0.16, 0.05 + dmg * 0.006));
  var a = angDeg * Math.PI / 180;
  var push = Math.min(10, 2 + dmg * 0.25);
  tryMove(e, Math.cos(a) * push, Math.sin(a) * push, s.type.radius);
  if (bwe.random() < 0.35) bwe.audio.play("snd_alien_hit", { volume: 0.35, pitch: 0.9 + bwe.random() * 0.25 });
}

function tryMove(e, sx, sy, r) {
  var moved = false;
  if (sx !== 0 && !bwe.tilemap.blocked(e.x + sx - r, e.y - r, r * 2, r * 2)) { e.x += sx; moved = true; }
  if (sy !== 0 && !bwe.tilemap.blocked(e.x - r, e.y + sy - r, r * 2, r * 2)) { e.y += sy; moved = true; }
  return moved;
}

function onUpdate(ctx, dt) {
  var e = ctx.self;
  var s = stateOf(e);
  var p = bwe.world.find("玩家");
  if (!p) return;
  var dead = !p.visible || num(p, "over", 0) > 0 || num(p, "win", 0) > 0;

  var dx = p.x - e.x, dy = p.y - e.y;
  var d2 = dx * dx + dy * dy;
  var d = Math.sqrt(d2);

  // ---- 视线检测（每 0.2 秒一次，射线很贵） ----
  s.losT -= dt;
  if (s.losT <= 0) {
    s.losT = 0.2 + bwe.random() * 0.1;
    s.los = d < SIGHT && !bwe.tilemap.raycast(e.x, e.y, p.x, p.y).hit;
    if (!s.awake && (s.los || d < WAKE_RANGE)) s.awake = true;
  }
  if (!s.awake || dead) {
    e.setFrame(16 + s.dir);
    return;
  }

  // ---- 中弹硬直 ----
  if (s.stun > 0) {
    s.stun -= dt;
    return;
  }

  // ---- 咬 ----
  var reach = s.type.radius + 13;
  if (d < reach + 2) {
    s.bite -= dt;
    if (s.bite <= 0) {
      s.bite = s.type.biteEvery;
      bwe.call("player", "hurt", s.type.bite);
      bwe.audio.play("snd_alien_bite", { volume: 0.4, pitch: 0.9 + bwe.random() * 0.2 });
    }
    face(e, s, dx, dy, false);
    return;
  }
  s.bite = Math.min(s.bite, 0.12);   // 刚贴上来时很快咬第一口

  // ---- 移动方向：有视线 → 直扑；没视线 → 走距离场 ----
  var mx, my;
  if (s.los) {
    var a = Math.atan2(dy, dx) + s.jitter * Math.min(1, d / 200);
    mx = Math.cos(a);
    my = Math.sin(a);
  } else {
    var g = vec(bwe.call("director", "flowDir", e.x, e.y));
    if (g.x !== 0 || g.y !== 0) {
      mx = g.x; my = g.y;
    } else {
      mx = dx / Math.max(1, d); my = dy / Math.max(1, d);
    }
  }

  // ---- 怪与怪之间互相挤开（简单分离力，原作怪不会完全叠在一起） ----
  var near = list(bwe.call("director", "neighbors", e));
  for (var i = 0; i < near.length; i++) {
    var o = near[i];
    var ox = e.x - o.x, oy = e.y - o.y;
    var od2 = ox * ox + oy * oy;
    if (od2 > 0.01 && od2 < 22 * 22) {
      var od = Math.sqrt(od2);
      var k = (22 - od) / 22 * 0.9;
      mx += ox / od * k;
      my += oy / od * k;
    }
  }
  var ml = Math.sqrt(mx * mx + my * my);
  if (ml < 0.001) return;
  var sp = s.type.speed * dt;
  var moved = tryMove(e, mx / ml * sp, my / ml * sp, s.type.radius);

  // 卡住检测：0.5 秒没挪动多少 → 随机扭一下方向
  s.stuckT += dt;
  if (s.stuckT > 0.5) {
    var md = Math.abs(e.x - s.lastX) + Math.abs(e.y - s.lastY);
    if (md < 6) s.jitter = (bwe.random() - 0.5) * 2.4;
    else s.jitter *= 0.5;
    s.lastX = e.x; s.lastY = e.y; s.stuckT = 0;
  }

  s.walkT += dt;
  face(e, s, mx, my, moved);
}

function face(e, s, fx, fy, walking) {
  var dir = Math.round(Math.atan2(fy, fx) * 180 / Math.PI / 22.5) & 15;
  s.dir = dir;
  var row = walking ? Math.floor(s.walkT * s.type.frameRate) % 4 : 1;
  e.setFrame(row * 16 + dir);
}
