// hud.js —— 孤胆枪手：界面（屏幕坐标，立即模式）。
//
// 布局参照原作：左下 生命/护甲条，右下 当前武器图标 + 弹药，左上 金钱/击杀，右上 生命数；
// 鼠标位置画准星（系统光标已在 player.js 里隐藏）。

var WEAPON_NAMES = ["双枪", "霰弹枪", "榴弹发射器", "机枪"];
var POOLS = [null, "shells", "grenades", "belt"];

function num(e, k, d) {
  var v = Number(e.prop(k, d));
  return isFinite(v) ? v : d;
}

// 绑在不可见的「HUD」对象上：onStart 每次场景开始都会跑（场景重开时引擎会清空钩子）
function onStart() {
  bwe.off("draw", drawHud);
  bwe.on("draw", drawHud);
}

function drawHud() {
  var p = bwe.world.find("玩家");
  if (!p) return;
  var sz = bwe.camera.size;
  var W = sz.w, H = sz.h;
  var s = Math.max(1, Math.min(W / 640, H / 480));   // 界面跟着窗口放大（像素风，整数倍更好看）
  var pad = 12 * s;

  // ---- 左上：金钱 / 击杀 ----
  bwe.draw.text(pad, pad + 14 * s, "$ " + num(p, "money", 0), { size: 16 * s, color: "#F4D35E", shadow: true });
  bwe.draw.text(pad, pad + 32 * s, "击杀 " + num(p, "kills", 0), { size: 11 * s, color: "#C8D0C0", shadow: true });

  // ---- 右上：生命数 ----
  var lives = num(p, "lives", 3);
  bwe.draw.text(W - pad, pad + 14 * s, "生命 × " + lives, { size: 14 * s, color: "#E8E8E8", align: "right", shadow: true });

  // ---- 左下：生命条 + 护甲条 ----
  var hp = num(p, "hp", 100), hpMax = Math.max(1, num(p, "hpMax", 100));
  var bw = 150 * s, bh = 10 * s;
  var bx = pad, by = H - pad - bh;
  var armor = num(p, "armor", 0), armorMax = num(p, "armorMax", 0);
  if (armorMax > 0) {
    bwe.draw.bar(bx, by - bh - 6 * s, bw, bh * 0.7, armor / armorMax, { bg: "#101418", fg: "#5A8CD8", border: "#000000" });
  }
  var hpCol = hp / hpMax > 0.5 ? "#4CC23C" : (hp / hpMax > 0.25 ? "#E0B020" : "#E03020");
  bwe.draw.bar(bx, by, bw, bh, hp / hpMax, { bg: "#101418", fg: hpCol, border: "#000000" });
  bwe.draw.text(bx + bw + 8 * s, by + bh - 1 * s, String(Math.ceil(hp)), { size: 11 * s, color: "#E8E8E8", shadow: true });

  // ---- 右下：武器图标（48×24 图集，放大 2 倍）+ 弹药 ----
  var wi = num(p, "weapon", 0);
  var iw = 48 * s * 1.5, ih = 24 * s * 1.5;
  var ix = W - pad - iw / 2, iy = H - pad - ih / 2 - 14 * s;
  bwe.draw.rect(ix - iw / 2 - 4 * s, iy - ih / 2 - 4 * s, iw + 8 * s, ih + 8 * s, { fill: "#000000", alpha: 0.45, radius: 3 * s });
  bwe.draw.sprite("武器图标", ix, iy, { w: iw, h: ih, frame: wi });
  var pool = POOLS[wi];
  var ammoText = pool ? String(num(p, pool, 0)) : "∞";
  var ammoCol = pool && num(p, pool, 0) <= 0 ? "#E03020" : "#F0F0E0";
  bwe.draw.text(ix - iw / 2 - 10 * s, iy + 6 * s, ammoText, { size: 16 * s, color: ammoCol, align: "right", shadow: true });
  bwe.draw.text(W - pad, H - pad, WEAPON_NAMES[wi] || "", { size: 10 * s, color: "#B8C0B0", align: "right", shadow: true });

  // 已拥有的武器槽（1~4），当前的高亮
  var owned = String(p.prop("owned", "1000"));
  for (var i = 0; i < 4; i++) {
    var sx = W - pad - (4 - i) * 16 * s, sy = H - pad - ih - 34 * s;
    var have = owned.charAt(i) === "1";
    bwe.draw.text(sx, sy, String(i + 1), {
      size: 11 * s, align: "center", shadow: true,
      color: i === wi ? "#F4D35E" : (have ? "#B0B8A8" : "#404840")
    });
  }

  // ---- 屏幕中上：提示消息 ----
  var msgT = num(p, "msgT", 0);
  var msg = String(p.prop("msg", ""));
  if (msgT > 0 && msg) {
    bwe.draw.text(W / 2, 70 * s, msg, { size: 14 * s, color: "#FFF2C0", align: "center", alpha: Math.min(1, msgT * 2), shadow: true });
  }

  // ---- 受伤红闪 ----
  var hpPct = hp / hpMax;
  if (hpPct < 0.3 && p.visible) {
    var pulse = 0.12 + 0.1 * Math.sin(bwe.time.now * 7);
    bwe.draw.rect(0, 0, W, H, { fill: "#B00000", alpha: pulse });
  }

  // ---- 结局面板 ----
  if (num(p, "over", 0) > 0) {
    panel(W, H, s, "任 务 失 败", "#FF7A6A", "击杀 " + num(p, "kills", 0) + "　金钱 $" + num(p, "money", 0));
  } else if (num(p, "win", 0) > 0) {
    panel(W, H, s, "第 一 关 完 成", "#9CFF7A", "进入地下设施　击杀 " + num(p, "kills", 0) + "　金钱 $" + num(p, "money", 0));
  } else {
    // ---- 准星（只在游戏进行中画） ----
    var m = bwe.input.mouse;
    bwe.draw.sprite("准星", m.x, m.y, { w: 24 * s, h: 24 * s });
  }
}

function panel(W, H, s, title, col, sub) {
  var pw = 380 * s, ph = 130 * s;
  bwe.draw.rect(W / 2 - pw / 2, H / 2 - ph / 2, pw, ph, { fill: "#0A0C0A", stroke: "#3A4A30", width: 2 * s, alpha: 0.9, radius: 4 * s });
  bwe.draw.text(W / 2, H / 2 - 20 * s, title, { size: 24 * s, color: col, align: "center", shadow: true });
  bwe.draw.text(W / 2, H / 2 + 14 * s, sub, { size: 12 * s, color: "#D8D8C8", align: "center" });
  bwe.draw.text(W / 2, H / 2 + 42 * s, "按 R 重新开始", { size: 12 * s, color: "#F4D35E", align: "center" });
}
