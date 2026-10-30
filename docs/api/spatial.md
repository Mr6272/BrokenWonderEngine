# bwe.spatial — 多层空间（Spatial）

> 本页覆盖：`bwe.spatial` 的全部成员 —— 建筑 / 区域 / 楼层 / 垂直连接（楼梯电梯）的查询与操作、玩家与实体的楼层归属、五状态分离中的运行时三状态、自定义可见性规则。
>
> 相关页：[scene：场景](scene.md) · [collision：碰撞](collision.md) · [road：路网](road.md) · [debug：调试](debug.md) · [README：索引](README.md)

## 核心设计：五状态分离

一个区域（zone）的"看得见吗 / 撞得到吗 / 走得到吗"是**三个独立状态**，各自有各自的解析器 —— 绝不能用单一 `visible` 字段糊过去：

| 状态 | 回答的问题 | 谁读它 |
|---|---|---|
| `renderVisible` | 这一帧画不画这个区域？ | 渲染器 |
| `collisionEnabled` | 实体的碰撞体在这一层生效吗？ | 碰撞层 |
| `navPassable` | 这个 agent 能不能走到这块格子？ | 导航 |
| `playerZone` | 玩家现在在哪栋楼 / 哪层 / 哪个房间？ | 游戏脚本、楼层剔除 |
| `npcZone` | 某个 NPC 在哪一层？（可能与玩家不同） | AI、跨层追击 |

前三个是**区域（zone）的属性**；后两个是**实体（actor）的属性** —— 这是本设计的关键区分：同一块区域对"玩家所在层"可见、对"NPC 所在层"可能就不可导航。所以 `navPassable` 必须**按 agent 分别求解**，不能存在区域上。

**生命周期**：

```
场景加载 → 解析 scene.buildings[] → 建索引
每帧     → resolve()：算 playerZone / 各 actor 的 floor / 各 zone 的三状态
场景卸载 → 索引全表清零
```

**兼容性**：没有 `buildings` 数据的场景（所有旧工程）`hasData()` 返回 `false`，所有查询返回 `null` / `true`（不阻挡）—— `bwe.spatial` 的存在**不改变任何现有行为**。

**Phase 说明**：`✅ 已实现`。

---

## 一、数据是否存在 / 计数

### bwe.spatial.hasData() → boolean

**签名**
`bwe.spatial.hasData(): boolean`

**参数**
无

**返回**
`boolean` — 当前场景是否有楼层 / 区域数据

**说明**
✅ 已实现。旧工程返回 `false`，此时其它查询一律不阻挡。**改代码前先判它**，否则旧场景上拿到的都是 `null`，容易写出"在我机器上明明能跑"的 bug。

**示例**
```js
if (!bwe.spatial.hasData()) {
  bwe.log("这个场景没有多层数据，跳过楼层逻辑");
} else {
  bwe.log("玩家在 " + bwe.spatial.level() + " 层");
}
```

**另见**
[bwe.spatial.buildingCount](#bwespatialbuildingcount--number)

---

### bwe.spatial.buildingCount() → number

**签名**
`bwe.spatial.buildingCount(): number`

**参数**
无

**返回**
`number` — 建筑数量

**说明**
✅ 已实现。

---

### bwe.spatial.zoneCount() → number

**签名**
`bwe.spatial.zoneCount(): number`

**参数**
无

**返回**
`number` — 区域（房间 / 走廊）数量

**说明**
✅ 已实现。

**示例**
```js
bwe.log(bwe.spatial.buildingCount() + " 栋楼，" + bwe.spatial.zoneCount() + " 个区域");
```

---

### bwe.spatial.linkCount() → number

**签名**
`bwe.spatial.linkCount(): number`

**参数**
无

**返回**
`number` — 垂直连接（楼梯 / 电梯）数量

**说明**
✅ 已实现。

---

## 二、区域查询

### bwe.spatial.all() → SpatialZone[]

**签名**
`bwe.spatial.all(): SpatialZone[]`

**返回**
数组，每项为**区域对象**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 区域 id |
| `name` | `string` | 区域名 |
| `buildingId` | `string` | 所属建筑 |
| `floorKey` | `string` | 楼层键 `建筑id/楼层id` |
| `level` | `number` | 楼层序号 |
| `x` / `y` | `number` | 中心点（世界像素） |
| `halfW` / `halfH` | `number` | 半宽 / 半高 |
| `collides` | `boolean` | 数据里声明的静态属性：参与碰撞 |
| `navigable` | `boolean` | 数据里声明的静态属性：可导航 |
| `renderVisible` | `boolean` | 本帧解析结果 |
| `collisionEnabled` | `boolean` | 本帧解析结果 |
| `navPassable` | `boolean` | 本帧解析结果 |
| `viaLink` | `string` | 进入该区域所需的 link id（空 = 无需过渡） |
| `tags` | `string[]` | 标签 |

**说明**
✅ 已实现。只读快照：拿到的是当前帧的值。

**示例**
```js
var zones = bwe.spatial.all();
for (var i = 0; i < zones.length; i++) {
  var z = zones[i];
  if (z.level === bwe.spatial.level()) {
    bwe.log(z.name + " 在本层，可导航=" + z.navPassable);
  }
}
```

---

### bwe.spatial.byId(id) → SpatialZone | null

**签名**
`bwe.spatial.byId(id: string): SpatialZone | null`

**参数**
- `id` — 区域 id

**返回**
区域对象；不存在返回 `null`

**说明**
✅ 已实现。

**示例**
```js
var room = bwe.spatial.byId("room101");
if (room) bwe.log(room.name);
```

---

### bwe.spatial.at(x, y) → SpatialZone | null

**签名**
`bwe.spatial.at(x: number, y: number): SpatialZone | null`

**参数**
- `x` / `y` — 世界像素坐标（中心点约定，Y 向下）

**返回**
该坐标所在的区域；不在任何区域返回 `null`

**说明**
✅ 已实现。按区域矩形包含判定，不判楼层（楼层归属请用 [bwe.spatial.levelOf](#bwespatiallevelofe--number)）。

**示例**
```js
var z = bwe.spatial.at(bwe.camera.pos.x, bwe.camera.pos.y);
if (z) bwe.log("镜头在看：" + z.name);
```

---

### bwe.spatial.current() → CurrentSpace | null

**签名**
`bwe.spatial.current(): CurrentSpace | null`

**返回**
`{zoneId, buildingId, floorId, level, indoor}`；玩家不在任何区域时 `null`

| 字段 | 类型 | 说明 |
|---|---|---|
| `zoneId` | `string` | 区域 id（空串 = 无） |
| `buildingId` | `string` | 建筑 id（空串 = 无） |
| `floorId` | `string` | 楼层 **id**（不是序号） |
| `level` | `number` | 楼层**序号** |
| `indoor` | `boolean` | 是否在室内 |

**说明**
✅ 已实现。注意 `floorId` 是 id，`level` 是序号 —— 两者不能互换。

**示例**
```js
var sp = bwe.spatial.current();
if (sp) {
  bwe.log((sp.indoor ? "室内 " : "室外 ") + sp.buildingId + " / " + sp.floorId + "（第 " + sp.level + " 层）");
}
```

**另见**
[bwe.spatial.level](#bwespatiallevel--number)

---

## 三、楼层归属

### bwe.spatial.level() → number

**签名**
`bwe.spatial.level(): number`

**参数**
无

**返回**
`number` — 玩家所在楼层序号；无数据 / 不在任何区域时 `0`

**说明**
✅ 已实现。用于"只画玩家这层"的剔除逻辑。

**示例**
```js
var lv = bwe.spatial.level();
bwe.log("玩家在第 " + lv + " 层");
```

---

### bwe.spatial.levelOf(e) → number

**签名**
`bwe.spatial.levelOf(e: Entity): number`

**参数**
- `e` — 实体

**返回**
`number` — 该实体所在楼层序号；未知时 `0`

**说明**
✅ 已实现。**跨层判断的关键**：NPC 与玩家可能在不同层，用它算"我和他是不是同一层"。

**示例**
```js
var me = bwe.world.find({ tag: "player" });
var npc = bwe.world.find({ tag: "guard" });
if (me && npc && bwe.spatial.levelOf(me) !== bwe.spatial.levelOf(npc)) {
  bwe.log("守卫在另一层，不能直接追");
}
```

---

### bwe.spatial.zoneOf(e) → SpatialZone | null

**签名**
`bwe.spatial.zoneOf(e: Entity): SpatialZone | null`

**参数**
- `e` — 实体

**返回**
该实体所在区域；不在任何区域 / 无数据时 `null`

**说明**
✅ 已实现。

**示例**
```js
var z = bwe.spatial.zoneOf(npc);
bwe.log(z ? "在 " + z.name : "不在任何区域内");
```

---

## 四、运行时三状态

### bwe.spatial.visibility(zoneId | zone) → {renderVisible, collisionEnabled, navPassable}

**签名**
`bwe.spatial.visibility(zone: SpatialZone | string): ZoneVisibility | null`

**参数**
- `zone` — **区域对象**或**区域 id**（两种都认）

**返回**
`{renderVisible: boolean, collisionEnabled: boolean, navPassable: boolean}`；找不到区域返回 `null`

**说明**
✅ 已实现。这三个值是 `resolve()` 每帧算出来的结果，不是数据里声明的静态属性（那把用 `all()` 拿到的 `collides` / `navigable`）。

**示例**
```js
var v = bwe.spatial.visibility("room101");
if (v) {
  bwe.log("画=" + v.renderVisible + " 撞=" + v.collisionEnabled + " 走=" + v.navPassable);
}
```

**另见**
[bwe.spatial.all](#bwespatialall--spatialzone)

---

### bwe.spatial.setVisibilityRule(rule = "default") → boolean

**签名**
`bwe.spatial.setVisibilityRule(rule?: "default" | null): boolean`

**参数**
- `rule` — `"default"` 或省略或 `null` = 恢复默认规则

**返回**
`boolean` — 设置成功返回 `true`；**v1 不支持自定义函数，其它值一律返回 `false`**

**说明**
✅ 已实现（**v1 只支持 `default`**）。默认规则：区域 `renderVisible` 取决于"是否是玩家所在层 + 是否室内 + 屋顶规则"。自定义规则需要跨脚本传 Rhino `Function`，v1 未开放，接口位已保留。

调用后返回 `false` 时脚本应当知道"没生效"，不要当成成功。

**示例**
```js
// 恢复默认（推荐：不要依赖未开放的自定义规则）
bwe.spatial.setVisibilityRule("default");
```

---

## 五、垂直连接（楼梯 / 电梯）

### bwe.spatial.links() → SpatialLink[]

**签名**
`bwe.spatial.links(): SpatialLink[]`

**返回**
数组，每项 `{id, kind, aLevel, bLevel, ax, ay, bx, by, bidirectional, travelTime, requiresInteract}`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 连接 id |
| `kind` | `string` | 类型（楼梯 / 电梯 …） |
| `aLevel` / `bLevel` | `number` | 两端楼层序号 |
| `ax` / `ay` | `number` | A 端坐标 |
| `bx` / `by` | `number` | B 端坐标 |
| `bidirectional` | `boolean` | 是否双向 |
| `travelTime` | `number` | 通行耗时（秒） |
| `requiresInteract` | `boolean` | 是否必须先交互才能用 |

**说明**
✅ 已实现。

**示例**
```js
var links = bwe.spatial.links();
for (var i = 0; i < links.length; i++) {
  bwe.log(links[i].kind + "：" + links[i].aLevel + " ↔ " + links[i].bLevel);
}
```

---

### bwe.spatial.link(id) → SpatialLink | null

**签名**
`bwe.spatial.link(id: string): SpatialLink | null`

**参数**
- `id` — 连接 id

**返回**
连接对象；不存在返回 `null`

**说明**
✅ 已实现。

**示例**
```js
var lift = bwe.spatial.link("elevator1");
if (lift) bwe.log("电梯 " + lift.aLevel + " ↔ " + lift.bLevel);
```

---

### bwe.spatial.linkBetween(aLevel, bLevel) → SpatialLink | null

**签名**
`bwe.spatial.linkBetween(aLevel: number, bLevel: number): SpatialLink | null`

**参数**
- `aLevel` / `bLevel` — 楼层序号

**返回**
连接；没有则 `null`

**说明**
✅ 已实现。回答"楼梯存在吗"。双向连接两端顺序都可查（`linkBetween(2, 1)` 与 `linkBetween(1, 2)` 都能找到双向的）。

**示例**
```js
if (bwe.spatial.linkBetween(1, 3)) {
  bwe.log("1 层能直接到 3 层");
}
```

---

### bwe.spatial.canReachLevel(from, to) → boolean

**签名**
`bwe.spatial.canReachLevel(from: number, to: number): boolean`

**参数**
- `from` / `to` — 楼层序号

**返回**
`boolean` — 靠 link 能否连通

**说明**
✅ 已实现。这是"NPC 不能穿楼板"的可判定形式 —— 追击 AI 应当先用它判断能不能跨层。

**示例**
```js
if (!bwe.spatial.canReachLevel(myLevel, targetLevel)) {
  bwe.log("追不过去，放弃这条追路");
}
```

---

### bwe.spatial.useLink(id, e) → boolean

**签名**
`bwe.spatial.useLink(id: string, e: Entity): boolean`

**参数**
- `id` — 连接 id
- `e` — 要被传送的实体

**返回**
`boolean` — 是否真的传送成功

**说明**
✅ 已实现。电梯 / 楼梯的**实际搬家**：把实体的坐标改到连接的另一端。

失败的情况（返回 `false` 并打日志）：
- 连接不存在
- 实体 `null`
- 实体既不在 `aLevel` 也不在 `bLevel`（不在该连接的任何一端）
- `requiresInteract` 为真且该连接未被解锁

**示例**
```js
var me = bwe.world.find({ tag: "player" });
if (me && bwe.spatial.useLink("elevator1", me)) {
  bwe.log("上到 " + bwe.spatial.level() + " 层");
}
```

---

### bwe.spatial.enter(zone, e?) → boolean

**签名**
`bwe.spatial.enter(zone: string | SpatialZone, e?: Entity): boolean`

**参数**
- `zone` — 区域 id 或 `SpatialZone` 对象
- `e` — 要进入的实体；**省略 = 作用于玩家**

**返回**
`boolean` — 区域不存在 / 找不到实体时返回 `false`

**说明**
✅ 已实现。**从门口走进**某个区域：把实体的楼层归属设成该区域所在层。

与 `useLink` 的区别（重要）：
| 场景 | 用哪个 |
|---|---|
| 从室外走进一层（穿越大门） | `enter(zone)` —— **不是垂直连接**，没有楼梯 |
| 一层 ↔ 二层（走楼梯 / 坐电梯） | `useLink(linkId, e)` |

为什么必须有 `enter`：`useLink` 只能处理"两层之间的 link"；而"从室外进一层"同样要改写
**楼层归属**，否则从二楼走出来的人会被引擎认为"在二楼的地面位置"，碰撞/渲染/寻路全错。

**示例**
```js
// 玩家按 E 进楼：把坐标挪到门口内侧，并声明进入该区域所在层
var door = bwe.spatial.at(px, py);
if (door && bwe.spatial.enter(door)) {           // 省略 e = 玩家
  bwe.log("进入 " + door.buildingId + "，第 " + (bwe.spatial.level() + 1) + " 层");
}
```

---

### bwe.spatial.leave(e?) → boolean

**签名**
`bwe.spatial.leave(e?: Entity): boolean`

**参数**
- `e` — 要离开的实体；**省略 = 作用于玩家**

**返回**
`boolean` — 找不到实体时返回 `false`

**说明**
✅ 已实现。走出建筑：楼层归属退回**地面层（0）**。

补充：即使脚本忘了调 `leave`，引擎也会兜底 —— 楼层归属只有在
「该位置上该层仍有区域」时才保留，走出整栋楼后会自动退回地面层。
`leave()` 只是让这个转换**立刻发生**、语义更明确。

**示例**
```js
bwe.world.on("leave_building", function () { bwe.spatial.leave(); });
```

---

### bwe.spatial.clear() → boolean

**签名**
`bwe.spatial.clear(): boolean`

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。清空空间索引并重置为"未建"。**一般不用手调**：场景卸载时引擎自己会清（`clearSceneState`）。手调主要用于 `if` 场景重载的调试。

**示例**
```js
bwe.spatial.clear();   // 强制下次查询时重建索引
```

---

## 另见

- [scene：场景](scene.md) —— 场景切换与代数
- [collision：碰撞](collision.md) —— 碰撞 / 触发事件与查询
- [debug：调试](debug.md) —— `bwe.debug.zones` 直接画出区域边界
- [road：路网](road.md) —— 平面寻路（与多层的垂直连接是两套东西）
