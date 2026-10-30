# bwe.debug — 调试绘制（Debug）

> 本页覆盖：`bwe.debug` 的全部成员 —— 总开关、逐项绘制（碰撞盒 / 路径 / 区域 / 阻挡图）、单次绘制（矩形 / 圆 / 线）、画实体碰撞框、运行时统计。
>
> 相关页：[draw：绘制](draw-audio-save.md) · [collision：碰撞](collision.md) · [spatial：多层空间](spatial.md) · [road：路网](road.md) · [README：索引](README.md)

## 解决什么问题

开放世界出问题时的第一句话永远是"**我看不到它到底在哪**"：碰撞盒、寻路路径、空间边界、楼层层高。没有调试绘制就只能靠 `print` 猜。

## 层归属：纯绘制，不改游戏状态

`bwe.debug` 是 L2 通用框架，**只画不改**：

> 关掉调试绘制之后，游戏行为必须**逐像素一致**。

实现上复用 `bwe.draw` 的同一条立即模式管线，所以不需要新的 GL 路径、不会与合批冲突。绘制指令只在 `onUpdate` / `draw` 期间有效。

## 三层开关

```
debug.on()        ← 总开关（不打开，下面全部不画、单次绘制也不出图）
  ├─ colliders(bool)   画所有有碰撞盒的实体
  ├─ paths(bool)       画正在沿路径跟随的实体的路径
  ├─ zones(bool)       画空间区域边界
  └─ nav(bool)         画瓦片阻挡图（开销大，慎用）
```

`off()` 会**一次性**关掉总开关并复位全部逐项开关。

**Phase 说明**：`✅ 已实现`。

---

## 一、总开关

### bwe.debug.on() → boolean

**签名**
`bwe.debug.on(): boolean`

**参数**
无

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。打开总开关。**只是打开**：逐项绘制还要各自 `colliders(true)` 等才会真的画。

**示例**
```js
bwe.debug.on();               // 总开关
bwe.debug.colliders(true);    // 同时画碰撞盒
```

**另见**
[bwe.debug.off](#bwedebugoff--boolean) · [bwe.debug.enabled](#bwedebugenabled--boolean)

---

### bwe.debug.off() → boolean

**签名**
`bwe.debug.off(): boolean`

**参数**
无

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。关闭总开关，并**把 colliders / paths / zones / nav 全部复位为 `false`** —— 一刀切，不会留下某个开关还开着。

**示例**
```js
bwe.debug.off();   // 一键回到干净状态
```

---

### bwe.debug.enabled() → boolean

**签名**
`bwe.debug.enabled(): boolean`

**参数**
无

**返回**
`boolean` — 总开关当前是否开启

**说明**
✅ 已实现。脚本里可以拿它做"调试模式下才打印"的判断，避免影响正式运行。

**示例**
```js
if (bwe.debug.enabled()) {
  bwe.log("路径长度 " + path.length);
}
```

---

## 二、逐项绘制

### bwe.debug.colliders(on = true) → boolean

**签名**
`bwe.debug.colliders(on?: boolean): boolean`

**参数**
- `on` — 省略 = `true`

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。每帧自动画所有**有碰撞盒**的实体的框。颜色区分：

| 颜色 | 含义 |
|---|---|
| 绿色 `#00ff88` | 普通实体 |
| 黄色 `#ffcc00` | 传感器（触发区） |

**示例**
```js
bwe.debug.on();
bwe.debug.colliders(true);
// 调试完：
bwe.debug.colliders(false);
```

**另见**
[bwe.debug.actor](#bwedebugactore-color--00ff88) · [bwe.collision.isTrigger](collision.md#bwecollisionistriggere--boolean)

---

### bwe.debug.paths(on = true) → boolean

**签名**
`bwe.debug.paths(on?: boolean): boolean`

**参数**
- `on` — 省略 = `true`

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。每帧画**正在沿路径跟随**的实体的剩余路径（`bwe.world` 的路径跟随与车辆自动驾驶都算）。

**示例**
```js
bwe.debug.paths(true);
```

**另见**
[road：路网](road.md) · [bwe.vehicle.followRoad](vehicle.md#bwevehiclefollowroade-target-onarrive----boolean)

---

### bwe.debug.zones(on = true) → boolean

**签名**
`bwe.debug.zones(on?: boolean): boolean`

**参数**
- `on` — 省略 = `true`

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。每帧画 [bwe.spatial](spatial.md) 的区域边界。**空间数据不存在时不画**（旧工程上开了也看不到东西）。

**示例**
```js
if (bwe.spatial.hasData()) {
  bwe.debug.zones(true);
}
```

---

### bwe.debug.nav(on = true) → boolean

**签名**
`bwe.debug.nav(on?: boolean): boolean`

**参数**
- `on` — 省略 = `true`

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。画瓦片阻挡图。**开销大，慎用** —— 整张地图的格子都要画一遍，大图上掉帧很明显。只在排查寻路问题时临时开。

**示例**
```js
bwe.debug.nav(true);    // 排查"为什么寻路绕圈"
// 查完立刻关：
bwe.debug.nav(false);
```

---

## 三、单次绘制

### bwe.debug.box(x, y, w, h, color = "#00ff88")

**签名**
`bwe.debug.box(x: number, y: number, w: number, h: number, color?: string): void`

**参数**
- `x` / `y` — 矩形左上角（世界像素）
- `w` / `h` — 宽高
- `color` — 颜色字符串，省略 `"#00ff88"`

**返回**
无（总开关没开时**直接返回，什么都不画**）

**说明**
✅ 已实现。画一次当前帧的矩形。后续 `bwe.debug.off()` 之后不会再有。

**示例**
```js
bwe.debug.on();
bwe.debug.box(100, 100, 64, 64, "#ff0000");
```

---

### bwe.debug.circle(x, y, r, color = "#00ff88")

**签名**
`bwe.debug.circle(x: number, y: number, r: number, color?: string): void`

**参数**
- `x` / `y` — 圆心
- `r` — 半径
- `color` — 省略 `"#00ff88"`

**返回**
无（总开关没开时不画）

**说明**
✅ 已实现。用来可视化 `bwe.collision.overlapCircle` 的查询范围：

```js
bwe.debug.circle(me.x, me.y, 120, "#00ff88");
var near = bwe.collision.overlapCircle(me.x, me.y, 120);
```

**示例**
```js
bwe.debug.on();
bwe.debug.circle(320, 240, 80);
```

---

### bwe.debug.line(x1, y1, x2, y2, color = "#00ff88")

**签名**
`bwe.debug.line(x1: number, y1: number, x2: number, y2: number, color?: string): void`

**参数**
- `x1 / y1` — 起点
- `x2 / y2` — 终点
- `color` — 省略 `"#00ff88"`

**返回**
无（总开关没开时不画）

**说明**
✅ 已实现。用来可视化射线检测：

```js
var hit = bwe.collision.raycast(me.x, me.y, me.x + 300, me.y);
bwe.debug.line(me.x, me.y, me.x + 300, me.y, hit.hit ? "#ff0000" : "#00ff88");
```

**示例**
```js
bwe.debug.on();
bwe.debug.line(0, 0, 640, 480);
```

---

### bwe.debug.actor(e, color = "#00ff88")

**签名**
`bwe.debug.actor(e: Entity, color?: string): void`

**参数**
- `e` — 实体
- `color` — 省略 `"#00ff88"`

**返回**
无（总开关没开、实体无效或已死亡时不画）

**说明**
✅ 已实现。画**这一个**实体的碰撞框。与 `colliders(true)` 的区别：那个是每帧自动画所有，这个是手动画指定的一个。

**示例**
```js
bwe.debug.on();
var boss = bwe.world.find({ tag: "boss" });
if (boss) bwe.debug.actor(boss, "#ff00ff");
```

---

## 四、统计

### bwe.debug.stats() → {actors, pendingDestroy, sceneEpoch, colliders, vehicles, spatialZones, drawCommands, enabled}

**签名**
`bwe.debug.stats(): DebugStats`

**参数**
无

**返回**

| 字段 | 类型 | 说明 |
|---|---|---|
| `actors` | `number` | 当前实体总数 |
| `pendingDestroy` | `number` | 本帧待销毁的实体数 |
| `sceneEpoch` | `number` | 场景代数（见 [bwe.scene.epoch](scene.md#bwesceneepoch--number)） |
| `colliders` | `number` | 有碰撞盒的实体数 |
| `vehicles` | `number` | 车辆数（= [bwe.vehicle.count](vehicle.md#bwevehiclecount--number)） |
| `spatialZones` | `number` | 空间区域数（= [bwe.spatial.zoneCount](spatial.md#bwespatialzonecount--number)） |
| `drawCommands` | `number` | 本帧新增的绘制指令数 |
| `enabled` | `boolean` | 调试总开关状态 |

**说明**
✅ 已实现。**性能水位观察**的第一手数据：`actors` 和 `drawCommands` 疯涨通常是泄漏或绘制没配对。

`spatialZones` / `vehicles` 在没有对应数据时是 `0`（不会报错）。

**示例**
```js
onUpdate = function (ctx, dt) {
  var s = bwe.debug.stats();
  bwe.draw.text(8, 8, "实体 " + s.actors + " / 绘制 " + s.drawCommands, 14, "#fff");
  if (s.actors > 800) bwe.log("实体数偏高：" + s.actors);
};
```

**另见**
[bwe.debug.enabled](#bwedebugenabled--boolean) · [bwe.world.count](world.md)

---

## 另见

- [draw：绘制](draw-audio-save.md) —— `bwe.draw` 是正式 HUD 绘制，`bwe.debug` 是临时调试
- [collision：碰撞](collision.md) —— 用 `debug.box` / `debug.circle` 可视化查询范围
- [spatial：多层空间](spatial.md) —— `debug.zones` 画区域边界
- [road：路网](road.md) —— `debug.paths` 画路径
