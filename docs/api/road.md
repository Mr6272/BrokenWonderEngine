# bwe.road — 路网（Road）

> 本页覆盖：`bwe.road` 的全部成员 —— 路网节点与路段、最近节点、最短**时间**路径、连通性判定、途经点路径、路径缓存。
>
> 相关页：[vehicle：车辆](vehicle.md) · [nav：寻路](map-nav-interact-spawner.md) · [spatial：多层空间](spatial.md) · [README：索引](README.md)

## 和 `bwe.nav` 的区别

| | `bwe.road` | `bwe.nav` |
|---|---|---|
| 图是什么 | **路网**：路口 / 站点 / 路段（有宽度、限速、单行） | **瓦片网格**：可走 / 阻挡格 |
| 谁用 | 车辆（车只能在路上开） | 步行 actor |
| 权重 | **时间**（长度 / 限速） | 距离（A*） |
| 不可达 | 空数组 | 空数组 |

两者约定一致：**不可达 = 空数组，不是 `null`**。

## 为什么权重是时间不是距离

路段限速不同（主干道 300、小巷 120）。纯距离寻路会让车**绕进小巷** —— 看着近，实际更慢。用 `长度 / 限速` 做权重才是"最快到达"。这也是 SUV / 出租能共用同一套路径的前提。

**Phase 说明**：`✅ 已实现`。

---

## 一、数据是否存在 / 计数

### bwe.road.hasData() → boolean

**签名**
`bwe.road.hasData(): boolean`

**参数**
无

**返回**
`boolean` — 当前场景是否有路网数据

**说明**
✅ 已实现。旧工程返回 `false`，此时 `nodes()` / `route()` 都是空，`nearest()` / `node()` 是 `null`。**用之前先判它。**

**示例**
```js
if (!bwe.road.hasData()) {
  bwe.log("这个场景没有路网，车辆只能手动开");
} else {
  bwe.log("路网：" + bwe.road.nodeCount() + " 节点 / " + bwe.road.edgeCount() + " 路段");
}
```

---

### bwe.road.nodeCount() → number

**签名**
`bwe.road.nodeCount(): number`

**参数**
无

**返回**
`number` — 路网节点数量

**说明**
✅ 已实现。

---

### bwe.road.edgeCount() → number

**签名**
`bwe.road.edgeCount(): number`

**参数**
无

**返回**
`number` — 路段数量

**说明**
✅ 已实现。

**示例**
```js
bwe.log(bwe.road.nodeCount() + " 个路口，" + bwe.road.edgeCount() + " 条路");
```

---

## 二、节点与路段

### bwe.road.nodes() → RoadNode[]

**签名**
`bwe.road.nodes(): RoadNode[]`

**返回**
数组，每项 `{id, x, y, kind}`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 节点 id |
| `x` / `y` | `number` | 世界像素坐标 |
| `kind` | `string` | 节点类型（如路口 / 站点） |

**说明**
✅ 已实现。每次调用新建数组。

**示例**
```js
var nodes = bwe.road.nodes();
bwe.log("第一个路口在 (" + nodes[0].x + ", " + nodes[0].y + ")");
```

---

### bwe.road.edges() → RoadEdge[]

**签名**
`bwe.road.edges(): RoadEdge[]`

**返回**
数组，每项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `from` | `string` | 起点节点 id |
| `to` | `string` | 终点节点 id |
| `width` | `number` | 路面宽度 |
| `speedLimit` | `number` | 限速（px/s） |
| `oneway` | `boolean` | 是否单行 |
| `length` | `number` | 路段长度（像素） |

**说明**
✅ 已实现。`oneway` 为 `true` 时只能 `from → to`。

**示例**
```js
var edges = bwe.road.edges();
for (var i = 0; i < edges.length; i++) {
  if (edges[i].oneway) bwe.log("单行道：" + edges[i].from + " → " + edges[i].to);
}
```

---

### bwe.road.node(id) → RoadNode | null

**签名**
`bwe.road.node(id: string): RoadNode | null`

**参数**
- `id` — 节点 id

**返回**
节点；不存在返回 `null`

**说明**
✅ 已实现。

**示例**
```js
var n = bwe.road.node("cross_3");
if (n) bwe.log("路口类型：" + n.kind);
```

---

### bwe.road.nearest(x, y) → {id, x, y, kind, dist} | null

**签名**
`bwe.road.nearest(x: number, y: number): RoadNearest | null`

**参数**
- `x` / `y` — 世界像素坐标

**返回**
最近的节点，**多一个 `dist` 字段**（直线距离）；路网为空时 `null`

**说明**
✅ 已实现。常用于"我现在的位置对应哪个路口" —— 车辆自动驾驶的起点就是这么算的。

**示例**
```js
var near = bwe.road.nearest(car.x, car.y);
if (near) {
  bwe.log("最近的节点 " + near.id + "，距离 " + near.dist.toFixed(1));
}
```

---

## 三、寻路

### bwe.road.route(from, to) → RoadNode[]

**签名**
`bwe.road.route(from: string | RoadNode | Vec2, to: string | RoadNode | Vec2): RoadNode[]`

**参数**
- `from` / `to` — 三种写法都认：
  1. 节点 id 字符串 `"cross_3"`
  2. 节点对象 `{id, x, y, kind}`
  3. 坐标 `{x, y}` —— 自动取**最近节点**

**返回**
`RoadNode[]` — 从起点到终点的节点序列；**不可达返回空数组**

**说明**
✅ 已实现。权重 = `长度 / 限速`（最短**时间**路径，不是最短距离）。

返回的每个节点是 `{id, x, y, kind}` —— 车辆沿着这串坐标开就行，可以直接交给 [bwe.vehicle.followRoad](vehicle.md#bwevehiclefollowroade-target-onarrive----boolean)。

**示例**
```js
var path = bwe.road.route({ x: car.x, y: car.y }, "hospital");
if (!path.length) {
  bwe.log("到不了医院");
} else {
  for (var i = 0; i < path.length; i++) {
    bwe.log("第 " + i + " 步：" + path[i].id + " (" + path[i].x + ", " + path[i].y + ")");
  }
}
```

**另见**
[bwe.road.canReach](#bweroadcanreachfrom-to--boolean) · [bwe.vehicle.followRoad](vehicle.md)

---

### bwe.road.canReach(from, to) → boolean

**签名**
`bwe.road.canReach(from: string | RoadNode | Vec2, to: string | RoadNode | Vec2): boolean`

**参数**
- `from` / `to` — 同 `route()` 的三种写法

**返回**
`boolean` — 是否连通

**说明**
✅ 已实现。等价于 `route(from, to).length > 0`，但**不生成数组**，便宜。

**示例**
```js
if (!bwe.road.canReach(car, target)) {
  bwe.log("这条路不通，换个目的地");
}
```

---

### bwe.road.routeThrough(from, via, to) → RoadNode[]

**签名**
`bwe.road.routeThrough(from: string | RoadNode | Vec2, via: string | RoadNode | Vec2, to: string | RoadNode | Vec2): RoadNode[]`

**参数**
- `from` — 起点
- `via` — 途经点
- `to` — 终点

**返回**
两段路径拼接后的节点序列（**去掉重复的途经点**）；任一段不可达返回**空数组**

**说明**
✅ 已实现。典型用途：出租车"先接客再送客"。

**示例**
```js
// 先到乘客位置，再去医院
var path = bwe.road.routeThrough(cab, passenger, "hospital");
if (!path.length) bwe.log("接不了这单");
```

---

### bwe.road.cachedRoutes() → number

**签名**
`bwe.road.cachedRoutes(): number`

**参数**
无

**返回**
`number` — 当前缓存的路径条数

**说明**
✅ 已实现。诊断用：路径算过一次会被缓存，重复请求同一对起终点不会重算。缓存随场景卸载 / 路网重建失效。

**示例**
```js
bwe.log("路径缓存 " + bwe.road.cachedRoutes() + " 条");
```

---

### bwe.road.clear() → boolean

**签名**
`bwe.road.clear(): boolean`

**参数**
无

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。清空路径缓存并让索引下次查询时重建。主要用于测试与"路网数据改了之后强制刷新"。

**示例**
```js
bwe.road.clear();
```

---

## 另见

- [vehicle：车辆](vehicle.md) —— `followRoad` 直接消费本页的路径
- [nav：寻路](map-nav-interact-spawner.md) —— 步行 actor 的瓦片 A*
- [spatial：多层空间](spatial.md) —— 垂直连接（楼梯电梯）是另一套
- [debug：调试](debug.md) —— `bwe.debug.paths` 画出正在跟随的路径
