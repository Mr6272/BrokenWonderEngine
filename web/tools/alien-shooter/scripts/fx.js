// fx.js —— 孤胆枪手：特效与地面痕迹（不绑定对象，靠 bwe.call("fx", ...) 调用）。
//
// 两类东西：
//   1) 「贴花」：血迹 / 尸体 / 焦痕 / 箱子碎片 / 弹壳 —— 真正 spawn 成地面层的 PROP，
//      会被光照压暗（夜里的血迹只有手电照到才看得清，原作就是这种观感）。
//      数量有上限（超过就删最老的），避免越打越卡。
//   2) 「闪光」：爆炸火球 / 火花 / 血雾粒子 —— 立即模式画（bwe.draw，不受光照，夜里也亮）。

var DECAL_MAX = 180;
var SHELL_MAX = 60;
var decals = [];     // 先进先出
var shells = [];
var booms = [];      // {x,y,t,s}
var sparks = [];     // {x,y,t,f}
var drops = [];      // 血雾粒子 {x,y,vx,vy,t,c}

var DECAL_LAYER = 0; // 地形层（地面上面一点，z 控制先后）

/** director 在场景开始时调用（模块脚本收不到 onSceneStart；钩子必须每次重新注册）。 */
function init() {
  decals = [];
  shells = [];
  booms = [];
  sparks = [];
  drops = [];
  bwe.off("update", tick);
  bwe.on("update", tick);
  bwe.off("draw", draw);
  bwe.on("draw", draw);
}

function pushDecal(e, list, max) {
  list.push(e);
  if (list.length > max) {
    var old = list.shift();
    if (old && old.alive) bwe.world.destroy(old);
  }
}

function decal(asset, frame, x, y, rot, z, size) {
  var e = bwe.world.spawn({
    x: x, y: y, asset: asset, name: "decal", kind: "PROP",
    layer: DECAL_LAYER, z: z, halfW: size / 2, halfH: size / 2, rotation: rot
  });
  if (e) {
    e.setFrame(frame);
    pushDecal(e, decals, DECAL_MAX);
  }
  return e;
}

/** 血迹（绿 = 外星虫，红 = 主角）。 */
function blood(x, y, red) {
  var f = (red ? 4 : 0) + Math.floor(bwe.random() * 4);
  decal("血迹", f, x, y, Math.floor(bwe.random() * 4) * 90, -60 + bwe.random(), 24 + bwe.random() * 12);
}

/** 命中飞溅：地上一滩 + 几颗飞散的血点。 */
function splat(x, y, angDeg, color) {
  var a = angDeg * Math.PI / 180;
  var c = color === "yellow" ? "#C8B830" : (color === "red" ? "#A01818" : "#5CC81E");
  for (var i = 0; i < 4; i++) {
    var aa = a + (bwe.random() - 0.5) * 1.4;
    var sp = 60 + bwe.random() * 120;
    drops.push({ x: x, y: y, vx: Math.cos(aa) * sp, vy: Math.sin(aa) * sp, t: 0.18 + bwe.random() * 0.12, c: c });
  }
  if (drops.length > 160) drops.splice(0, drops.length - 160);
  if (bwe.random() < 0.55) {
    blood(x + Math.cos(a) * (6 + bwe.random() * 10), y + Math.sin(a) * (6 + bwe.random() * 10), color === "red");
  }
}

/** 怪物尸体（留在地上，原作尸体会一直在）。 */
function corpse(x, y, color, angDeg) {
  var f = (color === "yellow" ? 2 : 0) + Math.floor(bwe.random() * 2);
  decal("尸体", f, x, y, Math.round((angDeg || 0) / 90) * 90, -50 + bwe.random(), 32);
  blood(x, y, false);
}

function scorch(x, y) {
  decal("尸体", 6 + Math.floor(bwe.random() * 2), x, y, Math.floor(bwe.random() * 4) * 90, -70 + bwe.random(), 56);
}

function debris(x, y) {
  decal("尸体", 4 + Math.floor(bwe.random() * 2), x, y, Math.floor(bwe.random() * 4) * 90, -55 + bwe.random(), 32);
  for (var i = 0; i < 4; i++) sparks.push({ x: x + (bwe.random() - 0.5) * 16, y: y + (bwe.random() - 0.5) * 16, t: 0.16, f: 0 });
}

function shell(x, y) {
  var e = bwe.world.spawn({
    x: x, y: y, asset: "弹壳", name: "shell", kind: "PROP",
    layer: DECAL_LAYER, z: -40, halfW: 2, halfH: 1, rotation: Math.floor(bwe.random() * 4) * 45
  });
  if (e) pushDecal(e, shells, SHELL_MAX);
}

function spark(x, y) {
  sparks.push({ x: x, y: y, t: 0.12, f: 0 });
  if (sparks.length > 60) sparks.shift();
}

/** 爆炸火球（8 帧图集，约 0.5 秒放完）。s = 尺寸倍率。 */
function boom(x, y, s) {
  booms.push({ x: x, y: y, t: 0, s: s || 1 });
  // 爆炸瞬间的大光（不投影，0.25 秒）
  var id = bwe.light.add({ x: x, y: y, radius: 220 * (s || 1), color: "#FFB050", intensity: 1.6, shadow: false, dynamic: true });
  if (id >= 0) bwe.after(0.25, function () { bwe.light.remove(id); });
  for (var i = 0; i < 6; i++) {
    sparks.push({ x: x + (bwe.random() - 0.5) * 50 * s, y: y + (bwe.random() - 0.5) * 50 * s, t: 0.2 + bwe.random() * 0.2, f: 0 });
  }
}

function tick(dt) {
  for (var i = booms.length - 1; i >= 0; i--) {
    booms[i].t += dt;
    if (booms[i].t >= 0.5) booms.splice(i, 1);
  }
  for (var j = sparks.length - 1; j >= 0; j--) {
    sparks[j].t -= dt;
    if (sparks[j].t <= 0) sparks.splice(j, 1);
  }
  for (var k = drops.length - 1; k >= 0; k--) {
    var d = drops[k];
    d.t -= dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.vx *= 0.9;
    d.vy *= 0.9;
    if (d.t <= 0) drops.splice(k, 1);
  }
}

function draw() {
  if (!booms.length && !sparks.length && !drops.length) return;
  bwe.draw.world(function () {
    for (var k = 0; k < drops.length; k++) {
      var d = drops[k];
      bwe.draw.rect(d.x - 1, d.y - 1, 2, 2, { fill: d.c, alpha: Math.min(1, d.t * 8) });
    }
    for (var j = 0; j < sparks.length; j++) {
      var s = sparks[j];
      var f = Math.min(3, Math.floor((0.12 - Math.min(0.12, s.t)) / 0.03));
      bwe.draw.sprite("火花", s.x, s.y, { w: 8, h: 8, frame: f });
    }
    for (var i = 0; i < booms.length; i++) {
      var b = booms[i];
      var fr = Math.min(7, Math.floor(b.t / 0.5 * 8));
      var sz = 64 * b.s * 1.25;
      bwe.draw.sprite("爆炸", b.x, b.y, { w: sz, h: sz, frame: fr });
    }
  });
}
