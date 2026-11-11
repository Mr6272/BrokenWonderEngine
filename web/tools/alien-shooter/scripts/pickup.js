// pickup.js —— 孤胆枪手：拾取结算（director 发现玩家碰到拾取物时调 bwe.call("pickup","take",p,e)）。
// 返回 true = 吃掉（导演会销毁拾取物）；false = 吃不下（比如满血不吃药包、弹药满了不吃弹药）。

var AMMO = { shells: 24, grenades: 6, belt: 150 };
var POOL_MAX = { shells: 120, grenades: 30, belt: 600 };
var WEAPON_INDEX = { shotgun: 1, launcher: 2, mg: 3 };
var WEAPON_AMMO = { shotgun: ["shells", 24], launcher: ["grenades", 10], mg: ["belt", 200] };
var WEAPON_NAME = { shotgun: "霰弹枪", launcher: "榴弹发射器", mg: "机枪" };
var AMMO_NAME = { shells: "霰弹", grenades: "榴弹", belt: "机枪弹链" };

function num(e, k, d) {
  var v = Number(e.prop(k, d));
  return isFinite(v) ? v : d;
}

function say(p, text) {
  p.setProp("msg", text);
  p.setProp("msgT", "2.2");
}

function addAmmo(p, pool, n) {
  var cur = num(p, pool, 0);
  if (cur >= POOL_MAX[pool]) return false;
  p.setProp(pool, String(Math.min(POOL_MAX[pool], cur + n)));
  return true;
}

function take(p, e) {
  var item = String(e.prop("item", ""));
  var val = String(e.prop("val", ""));
  if (item === "money") {
    var amt = Number(val) || 0;
    p.setProp("money", String(num(p, "money", 0) + amt));
    bwe.audio.play("snd_money", { volume: 0.7 });
    say(p, "+$" + amt);
    bwe.log("[孤胆枪手] 拾取金钱 $" + amt);
    return true;
  }
  if (item === "ammo") {
    if (!addAmmo(p, val, AMMO[val] || 10)) return false;
    bwe.audio.play("snd_pickup", { volume: 0.6 });
    say(p, AMMO_NAME[val] + " +" + AMMO[val]);
    return true;
  }
  if (item === "medkit") {
    var hp = num(p, "hp", 100), max = num(p, "hpMax", 100);
    if (hp >= max) return false;
    p.setProp("hp", String(Math.min(max, hp + 50)));
    bwe.audio.play("snd_pickup", { volume: 0.6, pitch: 1.2 });
    say(p, "生命 +50");
    return true;
  }
  if (item === "weapon") {
    var idx = WEAPON_INDEX[val];
    if (idx === undefined) return false;
    var owned = String(p.prop("owned", "1000")).split("");
    var had = owned[idx] === "1";
    owned[idx] = "1";
    p.setProp("owned", owned.join(""));
    var wa = WEAPON_AMMO[val];
    addAmmo(p, wa[0], wa[1]);
    // 原作：捡到新枪自动换上
    if (!had) p.setProp("weapon", String(idx));
    bwe.audio.play("snd_pickup", { volume: 0.8, pitch: 0.85 });
    say(p, had ? (WEAPON_NAME[val] + " 弹药") : ("获得 " + WEAPON_NAME[val] + "！按 " + (idx + 1) + " 切换"));
    bwe.log("[孤胆枪手] 拾取武器 " + val);
    return true;
  }
  return false;
}
