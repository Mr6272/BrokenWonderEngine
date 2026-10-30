# bwe.vehicle — 车辆（Vehicle）

> 本页覆盖：`bwe.vehicle` 的全部成员 —— 生成车辆、车辆状态、上下车与劫车、驾驶控制（油门 / 制动 / 转向）、速度与朝向、损伤、沿路网自动驾驶、停车、车辆事件。
>
> 相关页：[road：路网](road.md) · [combat：战斗](combat.md) · [collision：碰撞](collision.md) · [actions：输入动作](actions.md) · [README：索引](README.md)

## 坐标与角度约定

- 速度单位 **px/s**
- `heading` 单位**度**，`0` = 朝右（+X），**顺时针为正** —— 与 `e.rotation` 同一套
- 油门 / 制动 / 损伤都是 `0..1`，转向是 `-1..1`

**Phase 说明**：`✅ 已实现`。

---

## 一、生成与识别

### bwe.vehicle.spawn(opts) → Entity | null

**签名**
`bwe.vehicle.spawn(opts: { kind?: string; x?: number; y?: number; ... }): Entity | null`

**参数**
- `opts` — 与 `bwe.world.spawn` **同构**（`tag` / `x` / `y` / `w` / `h` / `color` …），另认 `kind`（车辆类型，默认 `"car"`）

**返回**
`Entity` — 新车；生成失败返回 `null`

**说明**
✅ 已实现。内部先走普通的实体生成，再登记成车辆。

**示例**
```js
var cab = bwe.vehicle.spawn({ kind: "taxi", tag: "cab", x: 320, y: 480 });
bwe.log("生成出租车：" + bwe.vehicle.count() + " 辆");
```

**另见**
[bwe.vehicle.isVehicle](#bwevehicleisvehiclee--boolean) · [bwe.world.spawn](world.md)

---

### bwe.vehicle.of(e) → VehicleInfo | null

**签名**
`bwe.vehicle.of(e: Entity): VehicleInfo | null`

**参数**
- `e` — 实体

**返回**
车辆完整状态；不是车辆返回 `null`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `number` | 车辆内部 id |
| `kind` | `string` | 车辆类型 |
| `speed` | `number` | 当前速度 px/s |
| `speedLimit` | `number` | 当前路段限速 |
| `heading` | `number` | 朝向角度 |
| `damage` | `number` | 损伤 0..1 |
| `driver` | `Entity \| null` | 驾驶员 |
| `autoDrive` | `boolean` | 是否在自动驾驶 |
| `routeIndex` | `number` | 当前开到路径的第几个点（路点含车道点与路口弧线采样点，只表示进度） |
| `routeLength` | `number` | 路径总点数 |
| `nextNode` | `string` | 下一个尚未通过的路网节点 id；无路线为 `""` |
| `prevNode` | `string` | 最近通过（或出发）的路网节点 id |
| `nextNodeDist` | `number` | 车到 `nextNode` 中心的直线距离 px；无路线为 `-1` |
| `inJunction` | `boolean` | 已越过 `nextNode` 的停止线（在路口内） |
| `parked` | `boolean` | 驻车中（下车 / `stop` / 到站后） |
| `brake` | `number` | 当前制动输入 0..1 |
| `throttle` | `number` | 当前油门输入 0..1 |

**说明**
✅ 已实现。一次拿全状态，比逐个调 `speed()` / `heading()` / `damage()` 便宜。

**示例**
```js
var v = bwe.vehicle.of(cab);
if (v) {
  bwe.log(v.kind + "：" + v.speed.toFixed(0) + "px/s，损伤 " + (v.damage * 100).toFixed(0) + "%");
  if (v.autoDrive) bwe.log("自动驾驶进度 " + v.routeIndex + "/" + v.routeLength);
}
```

---

### bwe.vehicle.isVehicle(e) → boolean

**签名**
`bwe.vehicle.isVehicle(e: Entity): boolean`

**参数**
- `e` — 实体

**返回**
`boolean` — 是否已登记为车辆

**说明**
✅ 已实现。

**示例**
```js
if (bwe.vehicle.isVehicle(e)) bwe.log("这是辆车");
```

---

### bwe.vehicle.count() → number

**签名**
`bwe.vehicle.count(): number`

**参数**
无

**返回**
`number` — 当前车辆总数

**说明**
✅ 已实现。性能水位观察用。

**示例**
```js
bwe.log("场景里 " + bwe.vehicle.count() + " 辆车");
```

---

## 二、驾驶员

### bwe.vehicle.driver(e) → Entity | null

**签名**
`bwe.vehicle.driver(e: Entity): Entity | null`

**参数**
- `e` — **车辆**实体

**返回**
驾驶员；无人驾驶 / 不是车辆返回 `null`

**说明**
✅ 已实现。

**示例**
```js
var d = bwe.vehicle.driver(cab);
bwe.log(d ? "司机是 " + d.tag : "空车");
```

**另见**
[bwe.vehicle.vehicleOf](#bwevehiclevehicleofe--entity--null)

---

### bwe.vehicle.vehicleOf(e) → Entity | null

**签名**
`bwe.vehicle.vehicleOf(e: Entity): Entity | null`

**参数**
- `e` — **驾驶员**实体

**返回**
他正在驾驶的车；没开车返回 `null`

**说明**
✅ 已实现。`driver()` 与 `vehicleOf()` 是反查关系。

**示例**
```js
var car = bwe.vehicle.vehicleOf(me);
if (car) bwe.log("我在车上，速度 " + bwe.vehicle.speed(car));
```

---

## 三、上下车

### bwe.vehicle.enter(driver, vehicle) → boolean

**签名**
`bwe.vehicle.enter(driver: Entity, vehicle: Entity): boolean`

**参数**
- `driver` — 要上车的人
- `vehicle` — 车

**返回**
`boolean` — 是否成功

**说明**
✅ 已实现。成功后该人成为驾驶员，派发 `enter` 事件。

**示例**
```js
if (bwe.actions.pressed("enter_vehicle")) {
  var car = bwe.world.find({ tag: "cab", x: me.x, y: me.y });
  if (car) bwe.vehicle.enter(me, car);
}
```

**另见**
[bwe.vehicle.exit](#bwevehicleexitdriver--boolean)

---

### bwe.vehicle.exit(driver) → boolean

**签名**
`bwe.vehicle.exit(driver: Entity): boolean`

**参数**
- `driver` — 驾驶员

**返回**
`boolean` — 是否成功

**说明**
✅ 已实现。下车后**车留下**，派发 `exit` 事件。

**示例**
```js
bwe.vehicle.exit(me);   // 下车
```

---

### bwe.vehicle.hijack(hijacker, vehicle) → boolean

**签名**
`bwe.vehicle.hijack(hijacker: Entity, vehicle: Entity): boolean`

**参数**
- `hijacker` — 劫车者
- `vehicle` — 目标车

**返回**
`boolean` — 是否成功

**说明**
✅ 已实现。和 `enter` 的区别：**原驾驶员会被踢出**（不是"上不去"），并派发 `hijack` 事件。

**示例**
```js
bwe.vehicle.on("hijack", function (info) {
  bwe.log("车被抢了！");
});
bwe.vehicle.hijack(thief, cab);
```

---

## 四、驾驶控制

### bwe.vehicle.throttle(e, v = 1) → boolean

**签名**
`bwe.vehicle.throttle(e: Entity, v?: number): boolean`

**参数**
- `e` — 车辆
- `v` — 油门 `0..1`（省略 = `1`，超出范围会被夹到 `0..1`）

**返回**
`boolean` — 设置成功；不是车辆返回 `false`

**说明**
✅ 已实现。

**示例**
```js
bwe.vehicle.throttle(car, 1);    // 地板油
```

---

### bwe.vehicle.brake(e, v = 1) → boolean

**签名**
`bwe.vehicle.brake(e: Entity, v?: number): boolean`

**参数**
- `e` — 车辆
- `v` — 制动 `0..1`（省略 = `1`）

**返回**
`boolean` — 设置成功；不是车辆返回 `false`

**说明**
✅ 已实现。

**示例**
```js
bwe.vehicle.brake(car, 1);    // 刹死
```

---

### bwe.vehicle.steer(e, v = 0) → boolean

**签名**
`bwe.vehicle.steer(e: Entity, v?: number): boolean`

**参数**
- `e` — 车辆
- `v` — 转向 `-1..1`（省略 = `0`；负左正右，超出会被夹到 `-1..1`）

**返回**
`boolean` — 设置成功；不是车辆返回 `false`

**说明**
✅ 已实现。

**示例**
```js
// 用动作层算转向，键位可配置
var ax = bwe.actions.axis();
bwe.vehicle.throttle(car, 1);
bwe.vehicle.steer(car, ax.x);
```

**另见**
[bwe.actions.axis](actions.md#bweactionsaxis--x-y)

---

## 五、状态读取

### bwe.vehicle.speed(e) → number

**签名**
`bwe.vehicle.speed(e: Entity): number`

**参数**
- `e` — 车辆

**返回**
`number` — 当前速度 px/s；不是车辆返回 `0`

**说明**
✅ 已实现。有方向的量用 `heading()` 配合。

**示例**
```js
bwe.log("车速 " + bwe.vehicle.speed(car).toFixed(0) + "px/s");
```

---

### bwe.vehicle.heading(e) → number

**签名**
`bwe.vehicle.heading(e: Entity): number`

**参数**
- `e` — 车辆

**返回**
`number` — 朝向角度（度）；不是车辆返回 `0`

**说明**
✅ 已实现。`0` = 朝右，顺时针为正，与 `e.rotation` 同一套。

**示例**
```js
bwe.log("朝向 " + bwe.vehicle.heading(car).toFixed(1) + "°");
```

---

### bwe.vehicle.damage(e, n?) → number

**签名**
`bwe.vehicle.damage(e: Entity, n?: number): number`

**参数**
- `e` — 车辆
- `n`（可选）— **要累加的损伤量**。**不传 = 只读**；传了 = 累加后返回新值

**返回**
`number` — 累加后的损伤 `0..1`；不是车辆返回 `0`

**说明**
✅ 已实现。**同一个方法两种语义**：读和写。容易看错，注意参数。

```js
bwe.vehicle.damage(car);        // 只读，返回当前损伤
bwe.vehicle.damage(car, 0.25);  // 累加 0.25，再返回结果
```

**示例**
```js
var d = bwe.vehicle.damage(car, 0.3);
if (d >= 1) bwe.log("车报废了");
```

---

## 六、自动驾驶

### bwe.vehicle.followRoad(e, target, {onArrive} = {}) → boolean

**签名**
`bwe.vehicle.followRoad(e: Entity, target: string | RoadNode | Vec2, opts?: { onArrive?: Function }): boolean`

**参数**
- `e` — 车辆
- `target` — 目的地，三种写法都认：节点 id 字符串 / 节点对象 / 坐标 `{x, y}`（取最近节点）
- `opts.onArrive`（可选）— 到达时回调

**返回**
`boolean` — 是否成功开始自动驾驶

**说明**
✅ 已实现。内部用 [bwe.road](road.md) 算最短时间路径，然后沿路径自动开。返回 `false` 的常见原因：

- 该实体不是车辆
- 场景没有路网（`bwe.road.hasData()` 为 `false`）
- 从当前位置到目的地**不可达**

到达后会清掉 `autoDrive` 并派发 `arrive` 事件（也会调 `onArrive`）。

**示例**
```js
var ok = bwe.vehicle.followRoad(cab, "hospital", {
  onArrive: function () {
    bwe.log("到医院了");
  },
});
if (!ok) bwe.log("去不了，可能路网不通");
```

**另见**
[bwe.road.route](road.md#bweroadroutefrom-to--roadnode) · [bwe.vehicle.stop](#bwevehiclestope--boolean)

---

### bwe.vehicle.stop(e) → boolean

**签名**
`bwe.vehicle.stop(e: Entity): boolean`

**参数**
- `e` — 车辆

**返回**
`boolean` — 是否成功；不是车辆返回 `false`

**说明**
✅ 已实现。取消自动驾驶、清空路径、油门/制动归零，并把车置为**驻车**：以约 500 px/s² 平滑减速到 0，之后保持不动、也不会倒车。`throttle()` / `steer()` / `followRoad()` / `enter()` 解除驻车。

**示例**
```js
bwe.vehicle.stop(cab);   // 靠边停车
```

---

### bwe.vehicle.setSpeed(e, v) → boolean

**签名**
`bwe.vehicle.setSpeed(e: Entity, v: number): boolean`

**参数**
- `e` — 车辆
- `v` — 速度 px/s（负数 = 倒车）

**返回**
`boolean` — 是否成功；不是车辆或 `v` 不是有限数返回 `false`

**说明**
✅ 已实现。锁定**当前这一帧**的速度：这一帧车按 `v` 移动，不经过加减速；下一帧起恢复正常物理（油门/制动/滑行/自动驾驶目标速度）。不改变自动驾驶、路线、驻车状态。

**示例**
```js
bwe.vehicle.setSpeed(car, 0);     // 撞墙 / 剧情：瞬停
bwe.vehicle.setSpeed(car, 200);   // 出场给个初速度，之后照常加减速
```

---

## 七、事件

### bwe.vehicle.on(ev, fn) → Function | null

**签名**
`bwe.vehicle.on(ev: string, fn: Function): Function | null`

**参数**
- `ev` — 事件名，只认这 5 个：

  | 事件 | 含义 |
  |---|---|
  | `"crash"` | 撞车 |
  | `"hijack"` | 被劫车 |
  | `"enter"` | 有人上车 |
  | `"exit"` | 有人下车 |
  | `"arrive"` | 自动驾驶到达 |

- `fn` — 回调

**返回**
传进去的 `fn` 本身（便于 `off(fn)`）；事件名未知或 `fn` 非法时返回 `null`

**说明**
✅ 已实现。回调属于注册它的脚本，场景卸载时按脚本清理。

**示例**
```js
bwe.vehicle.on("crash", function (info) {
  bwe.log("撞车了！");
});
bwe.vehicle.on("arrive", function () {
  bwe.log("到站");
});
```

**另见**
[bwe.vehicle.off](#bwevehicleofffn--boolean)

---

### bwe.vehicle.off(fn) → boolean

**签名**
`bwe.vehicle.off(fn: Function): boolean`

**参数**
- `fn` — 回调引用

**返回**
`boolean` — 是否真的摘掉了

**说明**
✅ 已实现。按函数引用在所有事件里找。

**示例**
```js
var onCrash = function () { bwe.log("撞了"); };
bwe.vehicle.on("crash", onCrash);
bwe.vehicle.off(onCrash);
```

---

## 另见

- [road：路网](road.md) —— `followRoad` 的路径来源
- [collision：碰撞](collision.md) —— 撞车的几何判定
- [combat：战斗](combat.md) —— 车辆也可以有武器 / 损伤
- [actions：输入动作](actions.md) —— `enter_vehicle` 动作驱动上下车
