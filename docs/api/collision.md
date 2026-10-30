# bwe.collision — 碰撞与触发（Collision）

> 本页覆盖：`bwe.collision` 的全部成员 —— 碰撞 / 触发事件订阅、几何查询（矩形 / 圆 / 射线）、传感器标记、接触列表、接触对数。
>
> 相关页：[physics：物理](emergence.md) · [spatial：多层空间](spatial.md) · [world：世界](world.md) · [debug：调试](debug.md) · [README：索引](README.md)

## 和 `bwe.physics` 的分工

| | `bwe.collision` | `bwe.physics` |
|---|---|---|
| 干什么 | **纯几何**：谁碰到谁、谁是传感器、射线打中了什么 | 刚体动力学：冲量、速度、抛掷 |
| 有物理引擎吗 | 没有（引擎自己的 AABB 判定） | 有（jbox2d 子步） |
| 事件来源 | 引擎每帧的 pair 差分 | 物理引擎的碰撞回调 |

所以：**只想知道"碰到了没"用 `bwe.collision`；想要"撞了会弹开"用 `bwe.physics`。**

## 成本纪律（重要）

`bwe.collision` 的事件派发是**零成本直到有人订阅**：

- 没有订阅者时，一帧都不算（直接返回）
- 第一个订阅者出现时做一次"预热"（只建表不派发），避免刚订阅就误报一堆 `enter`

这条纪律是实测踩出来的：早期版本无论有没有订阅都跑 O(n²) 配对，`ScriptPerfTest` 从 11s 涨到 55s。

**取消订阅一定要做**：`on()` 用 `off(fn)` 摘掉；场景卸载时引擎也会清（`clearSceneState`）。

**Phase 说明**：`✅ 已实现`。

---

## 一、事件

### bwe.collision.on(ev, fn, e?) → Function | null

**签名**
`bwe.collision.on(ev: string, fn: (info: CollisionEvent) => void, e?: Entity): Function | null`

**参数**
- `ev` — 事件名，只认这 6 个：

  | 事件 | 含义 |
  |---|---|
  | `"enter"` | 本帧开始接触 |
  | `"stay"` | 持续接触 |
  | `"exit"` | 本帧结束接触 |
  | `"triggerEnter"` / `"triggerStay"` / `"triggerExit"` | 传感器（触发区）的对应三种 |

- `fn` — 回调，入参为事件对象（见下）
- `e`（可选）— 实体。传了 = **只收该实体**的事件；不传 = 收**全局**事件

**返回**
传进去的 `fn` 本身（便于 `off(fn)`）；事件名未知或 `fn` 不是函数时返回 `null`

**事件对象字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | `string` | 事件名 |
| `self` | `Entity \| null` | 按实体订阅时的"我" |
| `other` | `Entity \| null` | 按实体订阅时的"对方" |
| `a` | `Entity \| null` | 这一对的 A 侧 |
| `b` | `Entity \| null` | 这一对的 B 侧 |
| `sensor` | `boolean` | 这一对是否涉及传感器 |

**说明**
✅ 已实现。同一对物体的 A / B 顺序是**稳定的**（按内部 uid 排序），不会这一帧是 A-pair、下一帧变成 B-pair —— 可以拿来做 key。

回调异常会被捕获并写进脚本日志（不会让整个碰撞层崩掉）。

**示例**
```js
function onEnter(info) {
  // 全局订阅：谁撞谁都能收到
  bwe.log(info.event + "：" + info.a.tag + " × " + info.b.tag);
}
var cancel = bwe.collision.on("enter", onEnter);

// 只关心玩家自己的碰撞
var player = bwe.world.find({ tag: "player" });
bwe.collision.on("triggerEnter", function (info) {
  bwe.log("玩家进入触发区");
}, player);
```

**另见**
[bwe.collision.off](#bwecollisionofffn--boolean)

---

### bwe.collision.off(fn) → boolean

**签名**
`bwe.collision.off(fn: Function): boolean`

**参数**
- `fn` — 之前传给 `on` 的函数**引用**

**返回**
`boolean` — 是否真的摘掉了

**说明**
✅ 已实现。全局回调与按实体的回调**都会找**，一个 `off` 足够。

**示例**
```js
var onEnter = function (info) { bwe.log("撞了"); };
bwe.collision.on("enter", onEnter);
// 不需要了：
bwe.collision.off(onEnter);
```

---

## 二、几何查询

### bwe.collision.query(rect) → Entity[]

**签名**
`bwe.collision.query(rect: {x, y, w, h}): Entity[]`

**参数**
- `rect` — 矩形，`x, y` 为**左上角**，`w, h` 为尺寸（像素）

**返回**
`Entity[]` — 与该矩形重叠的**可见**实体

**说明**
✅ 已实现。纯几何 AABB 判定，不经过物理引擎、不含瓦片。死亡实体与不可见实体被跳过。

**示例**
```js
var hits = bwe.collision.query({ x: 100, y: 100, w: 200, h: 150 });
bwe.log("矩形里 " + hits.length + " 个实体");
```

**另见**
[bwe.collision.overlapCircle](#bwecollisionoverlapcirclex-y-r--entity)

---

### bwe.collision.overlapCircle(x, y, r) → Entity[]

**签名**
`bwe.collision.overlapCircle(x: number, y: number, r: number): Entity[]`

**参数**
- `x` / `y` — 圆心（世界像素）
- `r` — 半径（像素）

**返回**
`Entity[]` — 与这个圆重叠的可见实体

**说明**
✅ 已实现。判定方式为**圆 vs AABB**：先把圆心夹到实体的矩形上取最近点，再比距离 —— 不是把实体当圆，所以贴边比"圆 vs 圆"更准。

**示例**
```js
var near = bwe.collision.overlapCircle(player.x, player.y, 120);
bwe.log("周围 120px 有 " + near.length + " 个");
```

---

### bwe.collision.raycast(x1, y1, x2, y2) → {hit, x, y, entity, distance}

**签名**
`bwe.collision.raycast(x1: number, y1: number, x2: number, y2: number): CollisionRayHit`

**参数**
- `x1 / y1` — 起点
- `x2 / y2` — 终点

**返回**

| 字段 | 类型 | 说明 |
|---|---|---|
| `hit` | `boolean` | 是否命中 |
| `x` / `y` | `number` | 命中点（未命中 = 终点 `x2, y2`） |
| `entity` | `Entity \| null` | 第一个命中的实体（未命中 = `null`） |
| `distance` | `number` | 命中距离（未命中 = 线段全长） |

**说明**
✅ 已实现。**纯几何，不含瓦片** —— 想知道"有没有墙挡着"要自己再查 `bwe.tilemap`，或用 `bwe.physics.raycast`。

**示例**
```js
var hit = bwe.collision.raycast(me.x, me.y, me.x + 300, me.y);
if (hit.hit) {
  bwe.log("300px 内打到 " + hit.entity.tag + "，距离 " + hit.distance);
} else {
  bwe.log("视线通畅");
}
```

**另见**
[bwe.spatial.visibility](spatial.md#bwespatialvisibilityzoneid--zone--rendervisible-collisionenabled-navpassable)

---

## 三、传感器（触发区）

### bwe.collision.setTrigger(e, on = true) → boolean

**签名**
`bwe.collision.setTrigger(e: Entity, on?: boolean): boolean`

**参数**
- `e` — 实体
- `on` — 省略 = `true`

**返回**
`boolean` — 设置成功；实体无效返回 `false`

**说明**
✅ 已实现。把实体的碰撞体标为**传感器**：它参与"碰上了"的判定和 `trigger*` 事件，但不做实体阻挡。

**示例**
```js
var zone = bwe.world.spawn({ tag: "pickupZone", x: 200, y: 200, w: 64, h: 64 });
bwe.collision.setTrigger(zone, true);
bwe.collision.on("triggerEnter", function (info) {
  bwe.log("有人进来了");
});
```

**另见**
[bwe.collision.isTrigger](#bwecollisionistriggere--boolean)

---

### bwe.collision.isTrigger(e) → boolean

**签名**
`bwe.collision.isTrigger(e: Entity): boolean`

**参数**
- `e` — 实体

**返回**
`boolean` — 是否传感器（实体无效返回 `false`）

**说明**
✅ 已实现。

**示例**
```js
if (bwe.collision.isTrigger(e)) bwe.log("这是个触发区");
```

---

## 四、接触列表

### bwe.collision.contacts(e) → Entity[]

**签名**
`bwe.collision.contacts(e: Entity): Entity[]`

**参数**
- `e` — 实体

**返回**
`Entity[]` — 当前与该实体接触的实体（几何重叠，死掉的会被跳过）

**说明**
✅ 已实现。返回的是**当前帧**的接触集合。没有订阅者时接触表不会被维护，此时通常为空 —— 需要接触数据就先订阅一个事件（哪怕回调是空的）。

**示例**
```js
bwe.collision.on("enter", function () {});   // 保证接触表被维护
var touching = bwe.collision.contacts(me);
bwe.log("贴着 " + touching.length + " 个");
```

---

### bwe.collision.count() → number

**签名**
`bwe.collision.count(): number`

**参数**
无

**返回**
`number` — 当前接触对数

**说明**
✅ 已实现。诊断 / 断言用（"这张地图上到底有几对在接触"）。同样依赖接触表被维护。

**示例**
```js
bwe.log("当前接触对：" + bwe.collision.count());
```

---

## 另见

- [physics：物理](emergence.md) —— 刚体、冲量、抛掷、物理射线
- [spatial：多层空间](spatial.md) —— 楼层 / 区域的碰撞启用状态
- [debug：调试](debug.md) —— `bwe.debug.colliders` 直接画出所有碰撞盒
