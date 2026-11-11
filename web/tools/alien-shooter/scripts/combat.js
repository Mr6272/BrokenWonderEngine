// combat.js —— 孤胆枪手：伤害结算中心（没有绑定到对象，靠 bwe.call("combat", ...) 调用）。
//
// 所有「可击中」的东西都走这里：外星虫、巢穴、木箱、油桶、气瓶。
// 血量记在 props.life 上（不用引擎 hp/hpMax —— 引擎会给 0<hp<hpMax 的角色自动画血条，原作没有血条）。
//
// 爆炸（油桶/气瓶/榴弹）是范围伤害 + 连锁：被炸到的油桶不会立刻炸，而是延迟 0.12~0.25 秒，
// 这样一排油桶会「噼里啪啦」依次炸开（原作的连环爆炸手感就是这个节奏）。

var pending = [];   // 延迟爆炸队列 {e, t}

function num(e, k, d) {
  var v = Number(e.prop(k, d));
  return isFinite(v) ? v : d;
}

/**
 * 场景开始时由 director 调用（模块脚本收不到 onSceneStart）。
 * 场景重开会清掉全部 bwe.on 钩子、但不重跑脚本顶层，所以钩子只能在这里注册（先 off 再 on 防重复）。
 */
function init() {
  pending = [];
  bwe.off("update", tick);
  bwe.on("update", tick);
}

/** 一发子弹/弹丸命中实体 e。angDeg = 子弹飞行方向（血往这个方向溅）。 */
function hit(e, dmg, hx, hy, angDeg) {
  if (!e || !e.alive) return;
  var kind = String(e.prop("kind", ""));
  var life = num(e, "life", 1) - dmg;
  e.setProp("life", String(life));
  if (kind === "alien") {
    bwe.call("enemy", "onHit", e, dmg, angDeg);
    bwe.call("fx", "splat", hx, hy, angDeg, String(e.prop("color", "green")));
    if (life <= 0) killAlien(e, angDeg);
    return;
  }
  if (kind === "nest") {
    bwe.call("fx", "splat", hx, hy, angDeg, "green");
    e.setProp("flash", "0.08");
    if (life <= 0) killNest(e);
    return;
  }
  if (kind === "crate") {
    bwe.call("fx", "spark", hx, hy);
    if (life <= 0) breakCrate(e);
    return;
  }
  if (kind === "barrel" || kind === "gas") {
    bwe.call("fx", "spark", hx, hy);
    if (life <= 0) explodeLater(e, 0.02);
    return;
  }
}

function killAlien(e, angDeg) {
  if (!e.alive) return;
  var color = String(e.prop("color", "green"));
  bwe.call("fx", "corpse", e.x, e.y, color, angDeg);
  bwe.audio.play("snd_alien_die", { volume: 0.55, pitch: (color === "yellow" ? 0.85 : 1.0) + bwe.random() * 0.15 });
  var p = bwe.world.find("玩家");
  if (p) {
    p.setProp("kills", String(num(p, "kills", 0) + 1));
    // 原作：每只怪按种类给钱（钱直接进账，不掉落）
    p.setProp("money", String(num(p, "money", 0) + (color === "yellow" ? 6 : 3)));
  }
  bwe.call("director", "alienDied", e);
  bwe.world.destroy(e);
}

function killNest(e) {
  if (!e.alive) return;
  e.setProp("kind", "dead");
  bwe.audio.play("snd_nest_die", { volume: 0.9 });
  bwe.call("fx", "boom", e.x, e.y, 1.3);
  for (var i = 0; i < 5; i++) {
    bwe.call("fx", "splat", e.x + (bwe.random() - 0.5) * 40, e.y + (bwe.random() - 0.5) * 40, bwe.random() * 360, "green");
  }
  bwe.camera.shake(7, 0.35);
  // 巢穴死后留下破洞（图集第 2 帧），不再可击中
  e.setFrame(1);
  e.removeTag("可击中");
  e.clearColor();
  var p = bwe.world.find("玩家");
  if (p) p.setProp("money", String(num(p, "money", 0) + 50));
  bwe.call("director", "nestDied", e);
  bwe.log("[孤胆枪手] 巢穴被摧毁");
}

function breakCrate(e) {
  if (!e.alive) return;
  bwe.audio.play("snd_crate", { volume: 0.7, pitch: 0.9 + bwe.random() * 0.2 });
  bwe.call("fx", "debris", e.x, e.y);
  var drop = String(e.prop("drop", ""));
  if (drop) bwe.call("director", "dropItem", drop, e.x, e.y);
  bwe.world.destroy(e);
}

function explodeLater(e, delay) {
  if (!e.alive || e.prop("fused", "0") === "1") return;
  e.setProp("fused", "1");
  pending.push({ e: e, t: delay });
}

/** 立刻在 (x,y) 炸开：半径内的怪/箱/桶/玩家都吃伤害；可选 cracked 墙判定。 */
function blast(x, y, radius, dmg, src, quiet) {
  var list = bwe.world.findAll({ tag: "可击中" }) || [];
  var r2 = radius * radius;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e || !e.alive || e === src) continue;
    var dx = e.x - x, dy = e.y - y;
    var d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    var kind = String(e.prop("kind", ""));
    var fall = 1 - Math.sqrt(d2) / radius * 0.6;
    if (dmg <= 0) {
      // 「推开」模式（复活清场）：只推怪，不伤害
      if (kind === "alien") {
        var d = Math.max(1, Math.sqrt(d2));
        e.x = x + dx / d * radius;
        e.y = y + dy / d * radius;
      }
      continue;
    }
    if (kind === "barrel" || kind === "gas") {
      explodeLater(e, 0.12 + bwe.random() * 0.13);
      continue;
    }
    hit(e, dmg * fall, e.x, e.y, Math.atan2(dy, dx) * 180 / Math.PI);
  }
  if (dmg <= 0) return;
  // 玩家也会被自己的爆炸炸到（原作如此：贴脸打榴弹会掉血）
  var p = bwe.world.find("玩家");
  if (p && p.visible) {
    var pdx = p.x - x, pdy = p.y - y;
    var pd2 = pdx * pdx + pdy * pdy;
    if (pd2 < r2 * 0.7) bwe.call("player", "hurt", dmg * 0.35 * (1 - Math.sqrt(pd2) / radius));
  }
  // 裂墙：爆炸半径内有裂墙格就炸开
  bwe.call("director", "blastWalls", x, y, radius);
  if (!quiet) bwe.camera.shake(Math.min(14, 4 + radius / 12), 0.35);
}

function explodeNow(e) {
  if (!e.alive) return;
  var kind = String(e.prop("kind", ""));
  var x = e.x, y = e.y;
  var big = kind === "gas";
  e.setProp("kind", "dead");
  bwe.world.destroy(e);
  bwe.audio.play("snd_explode", { volume: big ? 1.0 : 0.9, pitch: (big ? 0.85 : 1) + bwe.random() * 0.1 });
  bwe.call("fx", "boom", x, y, big ? 1.5 : 1.15);
  bwe.call("fx", "scorch", x, y);
  blast(x, y, big ? 120 : 96, big ? 120 : 90, e, false);
}

/** 榴弹落点：爆炸。 */
function grenadeBoom(x, y, dmg) {
  bwe.audio.play("snd_explode", { volume: 0.85, pitch: 1.05 + bwe.random() * 0.1 });
  bwe.call("fx", "boom", x, y, 1.0);
  bwe.call("fx", "scorch", x, y);
  blast(x, y, 72, dmg, null, false);
}

function tick(dt) {
  for (var i = pending.length - 1; i >= 0; i--) {
    var it = pending[i];
    it.t -= dt;
    if (it.t <= 0) {
      pending.splice(i, 1);
      explodeNow(it.e);
    }
  }
}
