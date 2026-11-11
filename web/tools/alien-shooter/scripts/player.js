// player.js —— 孤胆枪手：主角。
//
// 手感对照原作（Alien Shooter, Sigma Team 2003）：
//   - WASD 按「屏幕方向」走（不是按朝向走），斜走同速；人物永远面向鼠标；
//   - 左键按住连射；右键按住 = 朝光标方向走（原作的「鼠标走路」）；
//   - 1~4 直接切枪，Q/E 上一把/下一把（不循环）；没有换弹，手枪弹药无限；
//   - 被怪咬时先扣护甲（护甲吸收一定比例），HP 归零掉一条命原地复活（短暂无敌）。
//
// 共享状态全部写在「玩家」实体的 props 上（每个脚本独立作用域，见 docs/api/lifecycle.md），
// hud / enemy / director / pickup 都靠 bwe.world.find("玩家").prop(...) 读同一份。

// ---------------------------------------------------------------- 武器表
// rate=两发间隔（秒），dmg=单发伤害，spread=散布（度），pellets=弹丸数，
// range=射程（世界像素），kick=后坐镜头抖动，pool=弹药池名（null=无限）。
// 数值取自原作武器表的相对比例（手枪 3/MG 6/霰弹 20×多丸/榴弹 40+溅射），再按「怪的血量」等比放大。
var WEAPONS = [
  { id: "pistols",  name: "双枪",     rate: 0.22, dmg: 9,  spread: 3,  pellets: 1, range: 420, kick: 0.0, pool: null,      snd: "snd_pistol",   alt: true },
  { id: "shotgun",  name: "霰弹枪",   rate: 0.62, dmg: 9,  spread: 26, pellets: 7, range: 300, kick: 2.5, pool: "shells",  snd: "snd_shotgun" },
  { id: "launcher", name: "榴弹发射器", rate: 0.75, dmg: 70, spread: 2,  pellets: 1, range: 380, kick: 3.5, pool: "grenades", snd: "snd_launcher", grenade: true },
  { id: "mg",       name: "机枪",     rate: 0.075, dmg: 7, spread: 7,  pellets: 1, range: 460, kick: 0.9, pool: "belt",    snd: "snd_mg" }
];
var POOL_MAX = { shells: 120, grenades: 30, belt: 600 };

var P = {
  speed: 168,          // 原作 640×480 下约 160px/s，这里地图格子 32px，同比例
  radius: 11,
  hpMax: 100,
  invuln: 0
};

// 运行时状态（每次场景开始都重置，因为脚本作用域跨场景重载是保留的）
var S = null;

function resetState() {
  S = {
    cooldown: 0,
    altSide: 1,          // 双枪左右手交替
    walkT: 0,
    flash: 0,            // 枪口火焰剩余时间
    flashFrame: 0,
    flashX: 0, flashY: 0, flashAng: 0,
    tracers: [],         // {x0,y0,x1,y1,t}
    muzzleLight: -1,
    muzzleT: 0,
    hurtT: 0,
    deadT: 0,
    dir: 0,
    biteSnd: 0
  };
}

function num(e, k, d) {
  var v = Number(e.prop(k, d));
  return isFinite(v) ? v : d;
}

function onStart(ctx) {
  var p = ctx.self;
  resetState();
  bwe.off("draw", drawEffects);
  bwe.on("draw", drawEffects);
  // 血量只记在 props 上：引擎会给 0<hp<hpMax 的角色自动画血条（原作没有），所以不碰 p.hp/p.hpMax
  p.setProps({
    hp: P.hpMax, hpMax: P.hpMax,
    armor: 0, armorMax: 0, armorAbs: 0,
    lives: 3, money: 20, kills: 0,
    weapon: 0, owned: "1000",
    shells: 0, grenades: 0, belt: 0,
    invuln: 0, over: 0, win: 0, msg: "", msgT: 0,
    facing: 0
  });
  // 准星自己画（隐藏系统光标）
  bwe.input.cursor(false);
  // 手电筒：聚光，跟着人物；方向每帧按鼠标改
  bwe.light.attach(p, {
    radius: 330, color: "#FFE6B0", intensity: 1.25, type: "spot",
    angle: 70, dir: 0, coneSoft: 22, falloff: 1.6, shadow: true
  });
  bwe.log("[孤胆枪手] player ready");
}

// ---------------------------------------------------------------- 工具
function weapon(p) {
  return WEAPONS[Math.max(0, Math.min(WEAPONS.length - 1, num(p, "weapon", 0)))];
}
function owns(p, i) {
  var s = String(p.prop("owned", "1000"));
  return s.charAt(i) === "1";
}
function ammoOf(p, w) {
  return w.pool ? num(p, w.pool, 0) : Infinity;
}
function say(p, text, t) {
  p.setProp("msg", text);
  p.setProp("msgT", String(t || 2.5));
}
function selectWeapon(p, i) {
  if (i < 0 || i >= WEAPONS.length) return;
  if (!owns(p, i)) return;
  if (num(p, "weapon", 0) === i) return;
  p.setProp("weapon", String(i));
  S.cooldown = Math.max(S.cooldown, 0.12);
  bwe.audio.play("snd_switch", { volume: 0.5 });
}

// ---------------------------------------------------------------- 主循环
function onUpdate(ctx, dt) {
  var p = ctx.self;
  if (!S) resetState();
  if (num(p, "over", 0) > 0 || num(p, "win", 0) > 0) {
    updateEffects(dt);
    return;
  }
  var msgT = num(p, "msgT", 0);
  if (msgT > 0) p.setProp("msgT", String(Math.max(0, msgT - dt)));

  // ---- 死亡 → 掉命复活 ----
  if (S.deadT > 0) {
    S.deadT -= dt;
    if (S.deadT <= 0) respawn(p);
    updateEffects(dt);
    return;
  }

  var m = bwe.input.mouse;
  var ang = Math.atan2(m.worldY - p.y, m.worldX - p.x);

  // ---- 移动：屏幕方向 WASD（斜走归一化）+ 右键朝光标走 ----
  var mx = 0, my = 0;
  if (bwe.input.down("KeyA") || bwe.input.down("ArrowLeft")) mx -= 1;
  if (bwe.input.down("KeyD") || bwe.input.down("ArrowRight")) mx += 1;
  if (bwe.input.down("KeyW") || bwe.input.down("ArrowUp")) my -= 1;
  if (bwe.input.down("KeyS") || bwe.input.down("ArrowDown")) my += 1;
  if (mx === 0 && my === 0 && m.right) {
    var ddx = m.worldX - p.x, ddy = m.worldY - p.y;
    if (ddx * ddx + ddy * ddy > 14 * 14) { mx = Math.cos(ang); my = Math.sin(ang); }
  }
  var len = Math.sqrt(mx * mx + my * my);
  var moving = len > 0.01;
  if (moving) {
    var sp = P.speed * dt / len;
    moveAxis(p, mx * sp, 0);
    moveAxis(p, 0, my * sp);
    S.walkT += dt;
  } else {
    S.walkT = 0;
  }

  // ---- 朝向：16 方向图集，frame = row*16 + dir ----
  var deg = ang * 180 / Math.PI;
  var dir = Math.round(deg / 22.5) & 15;
  S.dir = dir;
  var row = 0;
  if (moving) {
    // 走路循环 1→2→3→2（约 9 帧/秒，和 168px/s 的步幅大致对上）
    var cyc = [1, 2, 3, 2];
    row = cyc[Math.floor(S.walkT * 9) % 4];
  }
  p.setFrame(row * 16 + dir);
  p.setProp("facing", String(Math.round(deg)));
  bwe.light.set(p, { dir: deg });

  // ---- 切枪 ----
  for (var k = 0; k < WEAPONS.length; k++) {
    if (bwe.input.pressed("Digit" + (k + 1))) selectWeapon(p, k);
  }
  if (bwe.input.pressed("KeyQ")) {
    for (var q = num(p, "weapon", 0) - 1; q >= 0; q--) if (owns(p, q)) { selectWeapon(p, q); break; }
  }
  if (bwe.input.pressed("KeyE")) {
    for (var e2 = num(p, "weapon", 0) + 1; e2 < WEAPONS.length; e2++) if (owns(p, e2)) { selectWeapon(p, e2); break; }
  }

  // ---- 开火（按住连射） ----
  S.cooldown -= dt;
  if (m.left && S.cooldown <= 0) fire(p, ang);

  // ---- 无敌时间 / 受伤闪烁 ----
  var inv = num(p, "invuln", 0);
  if (inv > 0) {
    inv = Math.max(0, inv - dt);
    p.setProp("invuln", String(inv));
    p.setAlpha(Math.floor(inv * 12) % 2 === 0 ? 0.45 : 1);
    if (inv <= 0) p.setAlpha(1);
  }
  if (S.hurtT > 0) S.hurtT -= dt;
  if (S.biteSnd > 0) S.biteSnd -= dt;

  updateEffects(dt);
}

/** 按轴滑墙（与吸血鬼示例同一做法：先 x 后 y，各自检测）。 */
function moveAxis(p, sx, sy) {
  var h = P.radius;
  var nx = p.x + sx, ny = p.y + sy;
  if (!bwe.tilemap.blocked(nx - h, ny - h, h * 2, h * 2) && !blockedByProp(p, nx, ny, h)) {
    p.x = nx;
    p.y = ny;
  }
}

/** 实心道具（木箱/油桶/气瓶/卡车/沙袋）也挡人：它们带「障碍」标签，半径存在 props.r。 */
function blockedByProp(p, x, y, h) {
  // 障碍物数量很少（几十个），按标签取再自己判距离，比 overlapCircle（会扫全部 400+ 墙格）便宜
  var list = bwe.world.findAll({ tag: "障碍" }) || [];
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    if (!o || !o.alive) continue;
    if (Math.abs(x - o.x) > 60 || Math.abs(y - o.y) > 60) continue;
    var hw = num(o, "bw", 12), hh = num(o, "bh", 12);
    var dx = Math.abs(x - o.x), dy = Math.abs(y - o.y);
    if (dx < hw + h - 2 && dy < hh + h - 2) {
      // 已经卡在里面（例如刚复活）时允许往外走
      var odx = Math.abs(p.x - o.x), ody = Math.abs(p.y - o.y);
      if (odx < hw + h - 2 && ody < hh + h - 2) {
        if (dx * dx + dy * dy > odx * odx + ody * ody) continue;
      }
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- 射击
function fire(p, ang) {
  var w = weapon(p);
  if (ammoOf(p, w) <= 0) {
    // 没子弹：咔哒一声，自动退回手枪（原作就是这样）
    bwe.audio.play("snd_empty", { volume: 0.6 });
    S.cooldown = 0.3;
    selectWeapon(p, 0);
    say(p, w.name + " 没子弹了", 1.5);
    return;
  }
  S.cooldown = w.rate;
  if (w.pool) p.setProp(w.pool, String(ammoOf(p, w) - 1));

  // 枪口位置：主角图集里枪管在前方 ~16px，双枪左右手各偏 5px
  var fx = Math.cos(ang), fy = Math.sin(ang);
  var side = 0;
  if (w.alt) { S.altSide = -S.altSide; side = S.altSide * 5; }
  var gx = p.x + fx * 17 - fy * side;
  var gy = p.y + fy * 17 + fx * side;

  bwe.audio.play(w.snd, { volume: w.id === "mg" ? 0.55 : 0.8, pitch: 0.94 + bwe.random() * 0.12 });

  S.flash = 0.06;
  S.flashFrame = Math.floor(bwe.random() * 4);
  S.flashX = gx; S.flashY = gy; S.flashAng = ang * 180 / Math.PI;
  muzzleLight(gx, gy);

  // 抛壳（世界里留下的小铜壳 —— 不受光照也无所谓，很小）
  if (!w.grenade) ejectShell(p, ang);

  if (w.kick > 0) bwe.camera.shake(w.kick, 0.08);

  if (w.grenade) {
    bwe.world.spawn({
      x: gx, y: gy, asset: "榴弹", name: "grenade", kind: "PROP", z: 6, layer: 2,
      halfW: 4, halfH: 4, script: "grenade",
      props: { vx: fx * 520, vy: fy * 520, dmg: w.dmg, range: w.range }
    });
    return;
  }

  for (var i = 0; i < w.pellets; i++) {
    var a = ang + (bwe.random() - 0.5) * w.spread * Math.PI / 180;
    var range = w.range * (w.pellets > 1 ? (0.75 + bwe.random() * 0.25) : 1);
    hitscan(p, gx, gy, a, range, w.dmg);
  }
}

/** 即时命中：沿射线找第一个敌人/可破坏物，墙挡住就停在墙上。 */
function hitscan(p, x0, y0, a, range, dmg) {
  var dx = Math.cos(a), dy = Math.sin(a);
  var x1 = x0 + dx * range, y1 = y0 + dy * range;
  var wall = bwe.tilemap.raycast(x0, y0, x1, y1);
  var maxT = range;
  if (wall.hit) {
    maxT = Math.sqrt((wall.x - x0) * (wall.x - x0) + (wall.y - y0) * (wall.y - y0));
  }
  // 候选：敌人 + 可打爆的东西（木箱/油桶/气瓶/巢穴）
  var best = null, bestT = maxT;
  var cands = bwe.world.findAll({ tag: "可击中" }) || [];
  var mx = (x0 + x1) / 2, my = (y0 + y1) / 2, reach = range / 2 + 40;
  for (var i = 0; i < cands.length; i++) {
    var e = cands[i];
    if (!e || !e.alive) continue;
    if (Math.abs(e.x - mx) > reach || Math.abs(e.y - my) > reach) continue;
    var r = num(e, "hitR", 12);
    // 射线-圆求交（投影长度 t，垂距 d）
    var ex = e.x - x0, ey = e.y - y0;
    var t = ex * dx + ey * dy;
    if (t < 0 || t > bestT + r) continue;
    var px = ex - dx * t, py = ey - dy * t;
    var d2 = px * px + py * py;
    if (d2 > r * r) continue;
    var tt = t - Math.sqrt(r * r - d2);
    if (tt < bestT) { bestT = Math.max(0, tt); best = e; }
  }
  var hx = x0 + dx * bestT, hy = y0 + dy * bestT;
  S.tracers.push({ x0: x0, y0: y0, x1: hx, y1: hy, t: 0.05 });
  if (best) {
    bwe.call("combat", "hit", best, dmg, hx, hy, a * 180 / Math.PI);
  } else if (wall.hit) {
    bwe.call("fx", "spark", hx - dx * 2, hy - dy * 2);
  }
}

function ejectShell(p, ang) {
  var side = ang + Math.PI / 2 + (bwe.random() - 0.5) * 0.8;
  var d = 10 + bwe.random() * 8;
  bwe.call("fx", "shell", p.x + Math.cos(side) * d, p.y + Math.sin(side) * d);
}

function muzzleLight(x, y) {
  // 短促的枪口闪光（不投影，便宜）：沿用同一个句柄，只改位置和亮度
  if (S.muzzleLight < 0) {
    S.muzzleLight = bwe.light.add({
      x: x, y: y, radius: 120, color: "#FFC060", intensity: 1.1, shadow: false, dynamic: true
    });
  } else {
    bwe.light.remove(S.muzzleLight);
    S.muzzleLight = bwe.light.add({
      x: x, y: y, radius: 120, color: "#FFC060", intensity: 1.1, shadow: false, dynamic: true
    });
  }
  S.muzzleT = 0.07;
}

// ---------------------------------------------------------------- 受伤 / 死亡（enemy 通过 bwe.call 调）
function hurt(amount) {
  var p = bwe.world.find("玩家");
  if (!p || !S || S.deadT > 0) return;
  if (num(p, "invuln", 0) > 0 || num(p, "over", 0) > 0 || num(p, "win", 0) > 0) return;
  var armor = num(p, "armor", 0);
  var abs = num(p, "armorAbs", 0);
  var toArmor = armor > 0 ? Math.min(armor, amount * abs) : 0;
  armor -= toArmor;
  var hp = num(p, "hp", P.hpMax) - (amount - toArmor);
  p.setProp("armor", String(Math.max(0, armor)));
  if (armor <= 0) p.setProp("armorAbs", "0");
  p.setProp("hp", String(Math.max(0, hp)));
  if (S.biteSnd <= 0) {
    bwe.audio.play("snd_player_hurt", { volume: 0.7, pitch: 0.9 + bwe.random() * 0.2 });
    S.biteSnd = 0.28;
  }
  if (S.hurtT <= 0) {
    // 红色血点（地上留印）
    bwe.call("fx", "blood", p.x + (bwe.random() - 0.5) * 10, p.y + (bwe.random() - 0.5) * 10, true);
    S.hurtT = 0.35;
  }
  if (hp <= 0) die(p);
}

function die(p) {
  var lives = num(p, "lives", 3) - 1;
  p.setProp("lives", String(Math.max(0, lives)));
  bwe.call("fx", "blood", p.x, p.y, true);
  bwe.call("fx", "blood", p.x + 8, p.y - 6, true);
  bwe.camera.shake(6, 0.4);
  if (lives <= 0) {
    p.setProp("over", "1");
    p.visible = false;
    bwe.log("[孤胆枪手] 阵亡：游戏结束");
    return;
  }
  p.visible = false;
  S.deadT = 1.6;
  bwe.log("[孤胆枪手] 阵亡，剩余生命 " + lives);
}

function respawn(p) {
  p.visible = true;
  p.setProp("hp", String(P.hpMax));
  p.setProp("invuln", "2.5");
  // 复活时把身边的怪推开一点（原作复活点周围会清场）
  bwe.call("combat", "blast", p.x, p.y, 90, 0, null, true);
  say(p, "还剩 " + num(p, "lives", 0) + " 条命", 2);
}

// ---------------------------------------------------------------- 特效（立即模式，不受光照）
function updateEffects(dt) {
  if (S.flash > 0) S.flash -= dt;
  if (S.muzzleT > 0) {
    S.muzzleT -= dt;
    if (S.muzzleT <= 0 && S.muzzleLight >= 0) {
      bwe.light.remove(S.muzzleLight);
      S.muzzleLight = -1;
    }
  }
  for (var i = S.tracers.length - 1; i >= 0; i--) {
    S.tracers[i].t -= dt;
    if (S.tracers[i].t <= 0) S.tracers.splice(i, 1);
  }
}

// ⚠ 钩子必须在 onStart 里注册：场景重开（R）时引擎会清空全部 bwe.on 钩子，
// 但脚本顶层代码不会再跑一遍；具名函数 + 先 off 再 on，保证不重复注册。
function drawEffects() {
  if (!S) return;
  bwe.draw.world(function () {
    for (var i = 0; i < S.tracers.length; i++) {
      var t = S.tracers[i];
      bwe.draw.line(t.x0, t.y0, t.x1, t.y1, { color: "#FFE9A0", width: 1.5, alpha: Math.min(1, t.t * 22) * 0.85 });
    }
    if (S.flash > 0) {
      // 枪口火焰图集原点在 (2,12)、朝右：把中心往前挪 10px 再按角度转
      var a = S.flashAng * Math.PI / 180;
      bwe.draw.sprite("枪口火焰", S.flashX + Math.cos(a) * 9, S.flashY + Math.sin(a) * 9,
        { w: 24, h: 24, rotation: S.flashAng, frame: S.flashFrame });
    }
  });
}
