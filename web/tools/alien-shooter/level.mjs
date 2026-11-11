/**
 * 孤胆枪手示例 · 关卡布局（第 1 关「潜入」的还原 + 战斗）。
 *
 * 原作第一关的结构（9game 攻略整理）：
 *   - 开局在基地外的草坪上，地上画着绿色箭头指向大门方向；
 *   - 基地外围是围墙 + 铁丝网，从铁丝网的破口钻进去；
 *   - 院子里有卡车、沙袋、木箱（打碎出钱/弹药）；左上角房子拐角藏着 $200，控制室后面也有钱；
 *   - 右下角的房子外墙边堆满气瓶和油桶，打爆后把墙炸出大洞，洞里是通往地下设施的入口 → 过关。
 * 原作第一关没有怪（怪从第三关开始）；按需求「还原一个关卡 + 手感还原」，这里保留第一关的地形与
 * 解谜流程，再把第三关的绿/黄蜘蛛与巢穴加进来，让射击手感有东西可打。
 *
 * 格子 32px，地图 64×48 格（2048×1536 世界像素）。
 *
 * 字符表（墙/障碍会进 tilemap 变成实心格）：
 *   '.' 草地           ',' 暗草（墙根）       ':' 土路
 *   '_' 水泥（院子）    '=' 车道线             '+' 金属地板（室内）
 *   'W' 围墙            'F' 铁丝网（实心，但光能穿过）   'G' 大门（关着）
 *   'B' 建筑墙          'R' 屋顶（实心，挡光）  'X' 裂墙（可被爆炸炸开）
 *   'o' 室内门洞（地板，可通行）
 * 物件放在 OBJECTS 里（格坐标，可带小数）。
 */

export const TILE = 32;

// 64 列 × 48 行。用「画布 + 指令」生成（手写 ASCII 很容易对不齐列数）。
// 布局：左侧 0..13 列是基地外的草坪（开局区），14 列是西墙（中间一段是铁丝网，破口在 y=29..31）；
// 院子在 15..62 列；左上是营房（藏 $200），中上是控制室，右下是仓库（裂墙 + 地下入口）。
export function buildMap() {
  const W = 64;
  const H = 48;
  const g = [];
  for (let y = 0; y < H; y++) g.push(new Array(W).fill("."));
  const rect = (x0, y0, x1, y1, ch) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = ch;
  };
  const hline = (x0, x1, y, ch) => rect(x0, y, x1, y, ch);
  const vline = (x, y0, y1, ch) => rect(x, y0, x, y1, ch);
  /** 一栋房子：外墙 B、内部地板 +；doors = [[x,y],...] 改成门洞 o。 */
  const house = (x0, y0, x1, y1, doors = []) => {
    rect(x0, y0, x1, y1, "B");
    rect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, "+");
    for (const [dx, dy] of doors) g[dy][dx] = "o";
  };

  // ---- 地图外圈：最外一格是草地暗边（不可走由地图边界保证） ----
  // ---- 基地院子（水泥） ----
  rect(15, 2, 62, 45, "_");
  // 外圈围墙：x=14..63, y=1..46
  hline(14, 63, 1, "W");
  hline(14, 63, 46, "W");
  vline(63, 1, 46, "W");
  vline(14, 1, 46, "W");
  // 西墙中段换成铁丝网（y=20..38），破口在 y=29..31（三格宽，人能钻、怪能涌）
  vline(14, 20, 38, "F");
  g[29][14] = "_";
  g[30][14] = "_";
  g[31][14] = "_";
  // 南墙上的大门（关着的，进不去 —— 原作箭头指向大门，但真正的入口是铁丝网破口）
  hline(30, 35, 46, "G");
  // 墙根一圈暗草
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < 14; x++) {
      if (x >= 12 || y === 0 || y === H - 1 || x === 0) g[y][x] = ",";
    }
  }
  for (let x = 14; x < W; x++) {
    g[0][x] = ",";
    g[47][x] = ",";
  }
  // 开局区：一条土路从左下方通向破口
  for (let x = 2; x < 14; x++) {
    g[30][x] = ":";
    g[31][x] = ":";
  }
  rect(2, 31, 4, 41, ":");
  // 南门外一条土路（通往大门，原作箭头的指向）
  rect(31, 47, 34, 47, ":");

  // ---- 院子里的车道 ----
  hline(15, 62, 24, "=");

  // ---- 营房（左上）：x=17..28, y=4..12；门朝南 ----
  house(17, 4, 28, 12, [[22, 12], [23, 12]]);
  // 营房内隔墙
  vline(24, 5, 9, "B");

  // ---- 控制室（中上）：x=34..46, y=4..13；门朝南，后墙（北）外侧有一条窄道藏钱 ----
  house(34, 5, 46, 13, [[39, 13], [40, 13]]);
  // 控制室后面的窄道：y=2..4 本来就是水泥；在控制室两侧用沙袋/箱子挡一下（物件层）

  // ---- 机库（右上）：屋顶 R（不可进，只是遮挡与视觉体积） ----
  rect(51, 4, 60, 14, "R");
  hline(51, 60, 14, "B");

  // ---- 仓库（右下）：x=46..60, y=32..43；西墙中段是裂墙（被气瓶炸开），里面是地下入口 ----
  house(46, 32, 60, 43, []);
  // 裂墙：西墙 x=46，y=36..38（三格）
  for (let y = 36; y <= 38; y++) g[y][46] = "X";
  // 仓库内部隔间
  hline(52, 60, 37, "B");
  g[37][55] = "o";
  g[37][56] = "o";

  // ---- 中部掩体：一段矮墙 ----
  hline(24, 28, 33, "B");
  vline(28, 33, 37, "B");

  return { W, H, grid: g.map((r) => r.join("")) };
}

/** 实心字符（进 tilemap 的 TILE 对象）。 */
export const SOLID = { W: "围墙", F: "铁丝网", G: "大门", B: "建筑墙", R: "屋顶", X: "裂墙" };

/** 地面字符 → 地面类型（art-env 的 ground 键）。实心格下面也要有地面（裂墙炸开后露出来）。 */
export const GROUND = {
  ".": "草地",
  ",": "草地暗",
  ":": "土路",
  _: "水泥",
  "=": "车道线",
  "+": "金属地板",
  o: "金属地板",
  W: "水泥",
  F: "草地暗",
  G: "水泥",
  B: "水泥",
  R: "水泥",
  X: "金属地板"
};

/**
 * 物件：格坐标（中心 = (x+0.5)*32），kind = 生成器里的物件类型。
 *   crate: 木箱（打碎掉落 drop）；barrel: 油桶；gas: 气瓶；money: 地上的钱；
 *   nest: 巢穴；lamp: 路灯（场景光源）；truck/sandbag/arrow/exit: 装饰与功能件；
 *   spawn: 预置的怪；player: 玩家出生点。
 */
export const OBJECTS = [
  { kind: "player", x: 4, y: 37 },
  // 地上的绿色大箭头：从出生点指向东北（大门/破口方向）。rotation 单位度、顺时针、0=右
  { kind: "arrow", x: 6.5, y: 34, rot: -35 },
  { kind: "arrow", x: 10, y: 30.5, rot: 0 },

  // ---- 开局区：几个木箱 + 弹药 ----
  { kind: "crate", x: 8, y: 40, drop: "money:50" },
  { kind: "crate", x: 9, y: 41, drop: "ammo:shells" },
  { kind: "lamp", x: 11, y: 27 },

  // ---- 破口附近的第一波：几只绿蜘蛛在院子里游荡 ----
  { kind: "spawn", type: "green", x: 20, y: 28 },
  { kind: "spawn", type: "green", x: 21, y: 31 },
  { kind: "spawn", type: "green", x: 23, y: 29 },

  // ---- 营房（左上）：拐角藏 $200 ----
  { kind: "money", x: 18, y: 5, amount: 200 },
  { kind: "crate", x: 27, y: 5, drop: "ammo:shells" },
  { kind: "crate", x: 25.5, y: 10.5, drop: "medkit" },
  { kind: "crate", x: 20, y: 10, drop: "weapon:shotgun" },
  { kind: "spawn", type: "green", x: 21, y: 7 },
  { kind: "spawn", type: "green", x: 26, y: 8 },

  // ---- 院子西北：卡车 + 沙袋 + 第一个巢穴 ----
  { kind: "truck", x: 31, y: 17 },
  { kind: "sandbag", x: 18, y: 18 },
  { kind: "sandbag", x: 19, y: 18 },
  { kind: "nest", x: 20.5, y: 15.5 },
  { kind: "crate", x: 29, y: 20, drop: "money:50" },
  { kind: "barrel", x: 27, y: 16 },
  { kind: "barrel", x: 26.3, y: 16.8 },
  { kind: "lamp", x: 24, y: 14 },

  // ---- 控制室（中上）：门口守卫 + 后面的钱 ----
  { kind: "money", x: 40, y: 3, amount: 150 },
  { kind: "money", x: 43, y: 3, amount: 100 },
  { kind: "crate", x: 36, y: 7, drop: "ammo:grenades" },
  { kind: "crate", x: 44, y: 11, drop: "weapon:launcher" },
  { kind: "crate", x: 37, y: 11, drop: "money:100" },
  { kind: "spawn", type: "yellow", x: 40, y: 9 },
  { kind: "spawn", type: "green", x: 38, y: 16 },
  { kind: "spawn", type: "green", x: 42, y: 16 },
  { kind: "lamp", x: 40, y: 15 },

  // ---- 院子中部：车道两侧 ----
  { kind: "sandbag", x: 33, y: 27 },
  { kind: "sandbag", x: 34, y: 27 },
  { kind: "barrel", x: 37, y: 22 },
  { kind: "crate", x: 25, y: 35, drop: "ammo:shells" },
  { kind: "crate", x: 26, y: 35, drop: "money:50" },
  { kind: "nest", x: 36.5, y: 34.5 },
  { kind: "lamp", x: 32, y: 30 },

  // ---- 院子东：机库前 + 第三个巢穴 ----
  { kind: "nest", x: 55.5, y: 20.5 },
  { kind: "crate", x: 50, y: 17, drop: "weapon:mg" },
  { kind: "crate", x: 61, y: 17, drop: "ammo:belt" },
  { kind: "barrel", x: 58, y: 26 },
  { kind: "barrel", x: 59, y: 26.6 },
  { kind: "lamp", x: 48, y: 22 },

  // ---- 仓库（右下）西墙外：成堆的气瓶和油桶（打爆 → 裂墙炸开） ----
  { kind: "gas", x: 44.6, y: 36 },
  { kind: "gas", x: 44.4, y: 37.6 },
  { kind: "barrel", x: 45, y: 38.9 },
  { kind: "barrel", x: 43.6, y: 36.9 },
  { kind: "barrel", x: 44.2, y: 34.9 },
  { kind: "lamp", x: 42, y: 33 },
  { kind: "spawn", type: "yellow", x: 40, y: 39 },
  { kind: "spawn", type: "green", x: 41, y: 41 },
  // 仓库内：地下入口 + 守卫
  { kind: "exit", x: 50, y: 40 },
  { kind: "crate", x: 58, y: 34, drop: "money:150" },
  { kind: "crate", x: 59, y: 35, drop: "ammo:belt" },
  { kind: "spawn", type: "yellow", x: 53, y: 35 },
  { kind: "spawn", type: "green", x: 57, y: 41 },
  { kind: "spawn", type: "green", x: 55, y: 39 }
];
