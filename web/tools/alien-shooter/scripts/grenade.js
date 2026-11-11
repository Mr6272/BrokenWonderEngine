// grenade.js —— 孤胆枪手：榴弹（直线飞，撞墙/撞怪/飞到射程就炸）。

var st = {};

function num(e, k, d) {
  var v = Number(e.prop(k, d));
  return isFinite(v) ? v : d;
}

// ⚠ 脚本 spawn 时 onStart 先于 spawn 的 props 写入执行，所以参数在第一帧 onUpdate 里读。
function init(g) {
  var s = {
    vx: num(g, "vx", 0), vy: num(g, "vy", 0),
    left: num(g, "range", 380), dmg: num(g, "dmg", 70), spin: 0
  };
  st[g.id] = s;
  return s;
}

function onDestroy(ctx) {
  delete st[ctx.self.id];
}

function boom(g, s) {
  var x = g.x, y = g.y;
  bwe.world.destroy(g);
  bwe.call("combat", "grenadeBoom", x, y, s.dmg);
}

function onUpdate(ctx, dt) {
  var g = ctx.self;
  var s = st[g.id] || init(g);
  var sx = s.vx * dt, sy = s.vy * dt;
  var step = Math.sqrt(sx * sx + sy * sy);
  s.left -= step;
  var nx = g.x + sx, ny = g.y + sy;
  if (bwe.tilemap.blocked(nx - 3, ny - 3, 6, 6)) {
    // 撞墙：退回半步再炸（爆心别在墙里，不然半边伤害被墙吃掉）
    g.x = g.x + sx * 0.3; g.y = g.y + sy * 0.3;
    boom(g, s);
    return;
  }
  g.x = nx; g.y = ny;
  s.spin += dt * 900;
  g.rotation = s.spin % 360;
  var list = bwe.world.findAll({ tag: "可击中" }) || [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e.alive) continue;
    var r = num(e, "hitR", 12) + 3;
    var dx = e.x - g.x, dy = e.y - g.y;
    if (dx * dx + dy * dy < r * r) { boom(g, s); return; }
  }
  if (s.left <= 0) boom(g, s);
}
