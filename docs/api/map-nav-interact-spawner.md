# bwe.grid / bwe.tilemap / bwe.nav / bwe.interact / bwe.spawner — 网格 · 瓦片 · 寻路 · 交互 · 刷怪

> 本页覆盖俯视角专精的五个命名空间：像素⇄格子的换算、瓦片地图与阻挡判定、A* 寻路与沿路径移动、最近交互物与按键提示、定时刷怪器。
>
> 相关页：[world：实体生成与查找](world.md) · [entity：Entity](entity.md) · [emergence：材质场 / 物理](emergence.md) · [lifecycle：生命周期](lifecycle.md) · [README：索引](README.md)

**坐标约定**：世界像素、中心点、**Y 轴向下**。
格子换算固定公式：`cx = floor(x / tileSize)`、`cy = floor(y / tileSize)`；格子中心 = `(cx + 0.5) * tileSize`。

**Phase 说明**：`✅ 已实现` / `🧪 试验` / `📋 规划`。

---

## 一、bwe.grid — 网格换算

### bwe.grid.cellSize → number

**签名**
`bwe.grid.cellSize: number`（**只读**）

**参数**
无

**返回**
`number` — 一格多少像素（= `bwe.world.tileSize()`）

**说明**
✅ 已实现。活属性（getter），场景不同会自动变。和 `bwe.world.tileSize()` 是同一个值，两处都能用。

**示例**
```js
bwe.log("格子大小 " + bwe.grid.cellSize + "px");
var cols = bwe.world.scene.widthTiles;
```

**另见**
[bwe.world.tileSize](world.md#bweworldtilesize--number) · [bwe.world.scene](world.md#bweworldscene--sceneinfo)

---

### bwe.grid.toCell(x, y) → CellPos

**签名**
`bwe.grid.toCell(x: number, y: number): { cx: number; cy: number }`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 世界 X（像素） |
| y | number | 世界 Y（像素） |

**返回**
`CellPos` — `{cx, cy}`，**向下取整**（`floor`）

**说明**
✅ 已实现。负坐标会得到负格子号（`floor(-0.5) = -1`），**不做钳制** —— 判越界请自己比 `0 <= cx < widthTiles`。

**示例**
```js
var c = bwe.grid.toCell(ctx.self.x, ctx.self.y);
bwe.log("所在格子 " + c.cx + "," + c.cy);
```

**另见**
[bwe.grid.toWorld](#bwegridtoworldcx-cy--vec2) · [bwe.grid.snap](#bwegridsnapx-y--vec2)

---

### bwe.grid.toWorld(cx, cy) → Vec2

**签名**
`bwe.grid.toWorld(cx: number, cy: number): { x: number; y: number }`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| cx | number | 格子 X |
| cy | number | 格子 Y |

**返回**
`Vec2` — 该格子的**中心点**世界坐标

**说明**
✅ 已实现。返回的是**格子中心**（`(cx+0.5)*tileSize`），不是左上角 —— 因为实体坐标是中心点，这样直接把实体摆到格子正中。

**示例**
```js
var p = bwe.grid.toWorld(10, 8);
bwe.world.spawn({ x: p.x, y: p.y, asset: "火把", kind: "PROP" });
```

**另见**
[bwe.grid.toCell](#bwegridtocellx-y--cellpos) · [bwe.grid.snap](#bwegridsnapx-y--vec2)

---

### bwe.grid.snap(x, y) → Vec2

**签名**
`bwe.grid.snap(x: number, y: number): { x: number; y: number }`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 任意世界 X |
| y | number | 任意世界 Y |

**返回**
`Vec2` — 该点所在格子**中心**的世界坐标

**说明**
✅ 已实现。等价于 `toWorld(toCell(x, y))`。放置 / 对齐用。

**示例**
```js
var s = bwe.grid.snap(bwe.input.mouse.worldX, bwe.input.mouse.worldY);
bwe.world.spawn({ x: s.x, y: s.y, asset: "砖块", kind: "TILE" });
```

**另见**
[bwe.grid.toWorld](#bwegridtoworldcx-cy--vec2)

---

## 二、bwe.tilemap — 瓦片地图

> **瓦片地图怎么来的**：场景里 `kind === "TILE"` 的对象在**生成时自动**写进瓦片表 —— 每个不同素材分配一个自增 `tileId`（从 1 开始），并**自动标记为阻挡**。
> 普通道具（`PROP`）和脚本刷出来的实体**不会**变成瓦片。空格的 `tileId` 是 `0`。

### bwe.tilemap.get(cx, cy) → number

**签名**
`bwe.tilemap.get(cx: number, cy: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| cx | number | 格子 X |
| cy | number | 格子 Y |

**返回**
`number` — 瓦片 id；`0` = 空；**越界也返回 0**

**说明**
✅ 已实现。`tileId` 是按「素材名首次出现顺序」自增分配的，**不是**素材 id、也**不是**固定的美术编号 —— 别把具体数字写死在脚本里，要用 `solid` 判断。

**示例**
```js
var id = bwe.tilemap.get(5, 5);
bwe.log("格子 (5,5) 的瓦片 id = " + id + (id === 0 ? "（空）" : ""));
```

**另见**
[bwe.tilemap.set](#bwetilemapsetcx-cy-tileid--void) · [bwe.tilemap.solid](#bwetilemapsolidcx-cy--boolean)

---

### bwe.tilemap.set(cx, cy, tileId) → void

**签名**
`bwe.tilemap.set(cx: number, cy: number, tileId: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| cx | number | 格子 X |
| cy | number | 格子 Y |
| tileId | number | 瓦片 id；`<= 0` 按 0（清空）。**越界格子忽略** |

**返回**
`void`

**说明**
✅ 已实现。**只改瓦片表，不改绘制** —— 瓦片 id 目前不驱动渲染（地块是靠 `TILE` 实体的贴图画的）。用它做阻挡 / 寻路数据层，视觉表现要自己另外处理。
新写入的 `tileId` 如果不在 `solidIds` 里，那它**不阻挡** —— 需要的话再 `setSolid(id, true)`。

**示例**
```js
// 把 (5,5) 标成"墙"（用一个已有的阻挡 id）
bwe.tilemap.set(5, 5, 1);
bwe.log("阻挡？" + bwe.tilemap.solid(5, 5));
```

**另见**
[bwe.tilemap.setSolid](#bwetilemapsetsolidtileid-solid--void) · [bwe.material.setTile](emergence.md#bwematerialsettilecx-cy-name--void)（材质层，不是瓦片层）

---

### bwe.tilemap.solid(cx, cy) → boolean

**签名**
`bwe.tilemap.solid(cx: number, cy: number): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| cx | number | 格子 X |
| cy | number | 格子 Y |

**返回**
`boolean` — 是否阻挡；**越界一律 `true`（地图外算墙）**

**说明**
✅ 已实现。判定 = 「该格有 tileId（非 0）**且** 该 tileId 在阻挡集合里」。
⚠ 越界返回 `true` 这点很重要：写「能不能走过去」判定时不用额外判边界。

**示例**
```js
if (bwe.tilemap.solid(cx, cy)) {
  bwe.log("这格是墙");
}
```

**另见**
[bwe.tilemap.blocked](#bwetilemapblockedx-y-w-h--boolean) · [bwe.nav.find](#bwenavfindfrom-to-opts--vec2)

---

### bwe.tilemap.setSolid(tileId, solid) → void

**签名**
`bwe.tilemap.setSolid(tileId: number, solid: boolean): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| tileId | number | 瓦片 id（**不是**格子坐标） |
| solid | boolean | `true` = 该 id 的瓦片全部阻挡；`false` = 全部可走 |

**返回**
`void`

**说明**
✅ 已实现。⚠ 注意这个函数改的是**整类瓦片**，不是某一个格子。所以「只把某一面墙打开」用它是做不到的 —— 要么换 tileId（`set` 成另一个不阻挡的 id），要么直接把该格的 tileId 设成 0。

**示例**
```js
// 让"木门"这个瓦片类型不再阻挡（全部木门一起打开）
bwe.tilemap.setSolid(doorTileId, false);
```

**另见**
[bwe.tilemap.set](#bwetilemapsetcx-cy-tileid--void) · [bwe.tilemap.solid](#bwetilemapsolidcx-cy--boolean)

---

### bwe.tilemap.blocked(x, y, w, h) → boolean

**签名**
`bwe.tilemap.blocked(x: number, y: number, w: number, h: number): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 矩形**左上角** X（像素） |
| y | number | 矩形**左上角** Y（像素） |
| w | number | 宽（像素）；`<= 0` 直接返回 `false` |
| h | number | 高（像素）；`<= 0` 直接返回 `false` |

**返回**
`boolean` — 矩形范围内**有任何**阻挡格子就 `true`

**说明**
✅ 已实现。AABB 遍历覆盖的所有格子。**`x/y` 是左上角**，不是中心 —— 和 Entity 的约定不同，用实体做判定时要自己减半宽半高：

```js
var s = ctx.self.size;
bwe.tilemap.blocked(ctx.self.x - s.w / 2, ctx.self.y - s.h / 2, s.w, s.h);
```

**示例**
```js
// 玩家脚下的碰撞盒
var s = ctx.self.size;
var hitWall = bwe.tilemap.blocked(ctx.self.x - s.w / 2, ctx.self.y - s.h / 2, s.w, s.h);
if (hitWall) { bwe.log("撞墙了"); }
```

**另见**
[bwe.tilemap.raycast](#bwetilemapraycastx1-y1-x2-y2--rayhit) · [e.size](entity.md#esize--size)

---

### bwe.tilemap.raycast(x1, y1, x2, y2) → RayHit

**签名**
`bwe.tilemap.raycast(x1: number, y1: number, x2: number, y2: number): RayHit`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x1, y1 | number | 起点（世界像素） |
| x2, y2 | number | 终点（世界像素） |

**返回**
`RayHit` — `{ hit: boolean, x: number, y: number, cx: number, cy: number }`

| 字段 | 说明 |
|---|---|
| `hit` | 是否撞到阻挡格 |
| `x, y` | 命中点世界坐标（没命中 = 终点） |
| `cx, cy` | 命中点在哪个格子（没命中 = 终点所在格子） |

**说明**
✅ 已实现。按 **1 像素步进采样**（最多 4000 步），不是精确的网格 DDA —— 格子 32px 时精度足够，但对**极长的射线**会截断到 4000px。超长射线请分段调用。
⚠ 这是**瓦片层**的射线；物理刚体 / 实体命中请用 [bwe.physics.raycast](emergence.md#bwephysicsraycastx1-y1-x2-y2--rayhit)。

**示例**
```js
var r = bwe.tilemap.raycast(ctx.self.x, ctx.self.y, m.worldX, m.worldY);
if (r.hit) {
  bwe.log("视线被墙挡住，命中点 " + Math.round(r.x) + "," + Math.round(r.y));
} else {
  bwe.log("一路畅通");
}
```

**另见**
[bwe.nav.lineOfSight](#bwenavlineofsighta-b--boolean) · [bwe.physics.raycast](emergence.md#bwephysicsraycastx1-y1-x2-y2--rayhit)

---

## 三、bwe.nav — 寻路

### bwe.nav.find(from, to, opts?) → Vec2[]

**签名**
`bwe.nav.find(from: Vec2 | Entity, to: Vec2 | Entity, opts?: NavOpts): Vec2[]`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| from | `Vec2 \| Entity` | 起点；传 Entity 就用它的 `x/y` |
| to | `Vec2 \| Entity` | 终点；同上 |
| opts.diagonal | boolean | 允许斜走，默认 `true` |
| opts.maxNodes | number | 最多展开节点数，默认 2000；`<= 0` 按 2000 |
| opts.smooth | boolean | 用视线检测抽稀拐点，默认 `true` |

**返回**
`Vec2[]` — 世界像素路径点数组；**没有通路返回空数组**（不是 `null`）

**说明**
✅ 已实现。网格 A*，octile 启发（允许斜走时的可采纳启发）。细节：

- **首元素是精确的 `from` 坐标**，**末元素是精确的 `to` 坐标**（中间才是格子中心）。
- 斜走**不切角**：两个正交邻格都必须可走，避免从墙角穿过去。
- **目标格即使是墙也允许到达**（「走到墙边」由调用方决定）。
- 起点或终点**越界** → 返回空数组。
- 起点终点**同格** → 返回 `[from]`，若两点不同再加 `[to]`（2 个点）。
- 超过 `maxNodes` 还没找到 → 放弃，返回空数组（大地图上把 `maxNodes` 调大）。
- `smooth` 会再用 `lineOfSight` 抽掉能直连的中间点。

**示例**
```js
var path = bwe.nav.find(ctx.self, { x: 800, y: 600 });
if (path.length === 0) {
  bwe.log("走不过去");
} else {
  bwe.nav.follow(ctx.self, path, { speed: 120, arrive: 4 });
}

// 大地图上放宽搜索预算
var longPath = bwe.nav.find({ x: 0, y: 0 }, { x: 3000, y: 2000 }, { maxNodes: 20000, smooth: false });
```

**另见**
[bwe.nav.follow](#bwenavfollowe-path-opts--void) · [bwe.nav.lineOfSight](#bwenavlineofsighta-b--boolean) · [bwe.tilemap.solid](#bwetilemapsolidcx-cy--boolean)

---

### bwe.nav.lineOfSight(a, b) → boolean

**签名**
`bwe.nav.lineOfSight(a: Vec2 | Entity, b: Vec2 | Entity): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| a | `Vec2 \| Entity` | 起点 |
| b | `Vec2 \| Entity` | 终点 |

**返回**
`boolean` — 两点之间**没有**阻挡格就 `true`；任一参数无效返回 `false`

**说明**
✅ 已实现。内部就是 `tilemap.raycast(a, b).hit === false`（1px 步进采样）。

**示例**
```js
if (bwe.nav.lineOfSight(ctx.self, bwe.world.find("玩家"))) {
  bwe.log("看得见玩家");
}
```

**另见**
[bwe.tilemap.raycast](#bwetilemapraycastx1-y1-x2-y2--rayhit) · [bwe.sense.canSee](emergence.md#bwesensecanseea-b--boolean)（带视野角 + 烟雾）

---

### bwe.nav.follow(e, path, opts?) → void

**签名**
`bwe.nav.follow(e: Entity, path: Vec2[], opts?: NavFollowOpts): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 要移动的实体 |
| path | Vec2[] | 路径点数组（一般来自 `bwe.nav.find`） |
| opts.speed | number | 移动速度 px/s，默认 100（`<= 0` 按 100） |
| opts.arrive | number | 到达判定距离 px，默认 2（最小 0.01） |
| opts.onArrive | Function | 走完调用：`fn(entity)` |

**返回**
`void`

**说明**
✅ 已实现。给实体挂一个「路径跟随」任务，**每帧自动推进**（不需要你在 `onUpdate` 里驱动）。
要点：
- 对同一个实体重复调 `follow` 会**先停掉旧的再挂新的**。
- 路径第一个点会被**跳过**（约定它就是实体当前位置），从第 2 个点开始走。
- 走完（或路径只有 1 个点）会回调 `onArrive(entity)` 并从任务表移除。
- 实体被销毁 → 任务自动清掉。
- `dt` 用的是 `frameDt`，所以**暂停 / 慢动作会同步影响移动速度**。
- **直接改 `e.x/e.y`**（绕过 follow）会和 follow 打架 —— 想瞬移请先 `bwe.nav.stop(e)`。

**示例**
```js
function goTo(ctx, tx, ty) {
  var path = bwe.nav.find(ctx.self, { x: tx, y: ty });
  if (path.length === 0) { return; }
  bwe.nav.follow(ctx.self, path, {
    speed: 140,
    arrive: 4,
    onArrive: function (e) {
      bwe.log(e.name + " 到达目的地");
      bwe.audio.play("到达");
    }
  });
}
```

**另见**
[bwe.nav.find](#bwenavfindfrom-to-opts--vec2) · [bwe.nav.stop](#bwenavstope--void)

---

### bwe.nav.stop(e) → void

**签名**
`bwe.nav.stop(e: Entity): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 要停止的实体 |

**返回**
`void`

**说明**
✅ 已实现。停掉该实体身上**所有**的路径跟随任务（不会派发 `onArrive`）。对没有任务的实体是空操作。

**示例**
```js
bwe.nav.stop(ctx.self);
ctx.self.setPos(64, 64);       // 现在可以安全瞬移了
```

**另见**
[bwe.nav.follow](#bwenavfollowe-path-opts--void)

---

## 四、bwe.interact — 交互

> 交互模型：脚本每帧用 `nearest()` 找出「最近的可交互物」，把它记在引擎里；玩家按交互键时，引擎把 `onTrigger` 回调和该对象的 `onInteract` / `"interact"` 事件一起派发。

### bwe.interact.nearest(actor, opts?) → Entity | null

**签名**
`bwe.interact.nearest(actor: Entity | null, opts?: NearestOpts): Entity | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| actor | Entity \| null | 查询原点；传 `null` 时自动找玩家（带 `玩家` / `Player` / `player` 标签的，或第一个 `ACTOR`） |
| opts.radius | number | 搜索半径（像素），默认 48 |
| opts.tag | string | 只看带这个标签的对象；空字符串 = 不限 |
| opts.filter | Function | 自定义过滤：`fn(entity) → boolean`，返回真才参与 |

**返回**
`Entity | null` — 最近的可交互对象；没有返回 `null`

**说明**
✅ 已实现。**副作用**：结果会被记进引擎的「当前交互目标」，供 `prompt()` 和 `onTrigger` 使用。所以每帧调它才能保持提示实时。

排除规则：跳过 `actor` 自己、跳过 `dead` 的、跳过 `visible === false` 的、跳过超出 `radius` 的、跳过 `filter` 返回假的。

**示例**
```js
function onUpdate(ctx, dt) {
  var target = bwe.interact.nearest(ctx.self, { radius: 64, tag: "可交互" });
  if (target) {
    bwe.interact.prompt(target.name + " [E]");
  } else {
    bwe.interact.prompt(null);
  }
}
```

**另见**
[bwe.interact.prompt](#bweinteractprompttext--void) · [bwe.interact.onTrigger](#bweinteractontriggerfn--void) · [onInteract](lifecycle.md#oninteractctx-actor--void)

---

### bwe.interact.prompt(text) → void

**签名**
`bwe.interact.prompt(text: string | null): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| text | `string \| null` | 提示文字；`null` / 空字符串 = 清除提示 |

**返回**
`void`

**说明**
✅ 已实现。提示会被画在**当前交互目标**（最近一次 `nearest` 的结果）的**头顶**（世界空间、居中对齐、固定 14px 白色带阴影）。
触发条件是：`prompt` 有文字 **且** `nearest` 给出过目标 **且** 目标还活着 —— 三者缺一就不画。

**示例**
```js
bwe.interact.prompt("按 E 打开");
bwe.interact.prompt(null);    // 清除
```

**另见**
[bwe.interact.nearest](#bweinteractnearestactor-opts--entity--null)

---

### bwe.interact.setKey(key) → void

**签名**
`bwe.interact.setKey(key: KeyName): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| key | `string \| number` | 交互键（键名或 keyCode）；默认 `KeyE` |

**返回**
`void`

**说明**
✅ 已实现。只影响 `onTrigger` / `onInteract` / `"interact"` 的触发键。传无效键名会得到 `-1`，等于**关掉**交互触发。

**示例**
```js
bwe.interact.setKey("KeyF");      // 换成 F
bwe.interact.setKey("Space");     // 空格
```

**另见**
[键名表](lifecycle.md#五键名表)

---

### bwe.interact.onTrigger(fn) → void

**签名**
`bwe.interact.onTrigger(fn: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| fn | Function | `fn(target: Entity, actor: Entity \| null)` —— `target` 是被交互的对象，`actor` 是玩家（可能是 `null`） |

**返回**
`void`

**说明**
✅ 已实现。注册一个**全局**交互回调（所有交互都走它），和对象脚本的 `onInteract` 是**并列**关系，两者都会被调用。
触发顺序：所有 `onTrigger` 回调 → 对象的 `"interact"` 实体事件 → 对象脚本的 `onInteract`。
**没有取消订阅的方法**，且每次调用都**追加**一个回调 —— 在 `onUpdate` 里注册会每帧加一个（⚠ 常见 bug）。注册一次就好（放在 `onSceneStart` / `onStart`）。

**示例**
```js
var registered = false;

function onSceneStart(ctx) {
  if (registered) { return; }
  registered = true;
  bwe.interact.onTrigger(function (target, actor) {
    bwe.log("交互了 " + target.name);
    if (target.hasTag("箱子")) {
      bwe.call("loot", "open", target);
    }
  });
}
```

**另见**
[onInteract](lifecycle.md#oninteractctx-actor--void) · [bwe.interact.nearest](#bweinteractnearestactor-opts--entity--null)

---

## 五、bwe.spawner — 刷怪器

### bwe.spawner.create(opts) → number

**签名**
`bwe.spawner.create(opts: SpawnerOpts): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| opts.asset | string | 素材名（与 `script` 二选一或都给） |
| opts.script | string | 生成的实体挂这个脚本 |
| opts.count | number | 每次刷几个，默认 1（钳制到 `[1, 100]`） |
| opts.interval | number | 间隔秒数，默认 2（最小 0.05） |
| opts.max | number | 场上**累计**上限，默认 10；`<= 0` = 不限 |
| opts.area | `{x,y,w,h}` | 生成区域（像素，左上 + 宽高）；缺省 = 整张地图 |
| opts.onSpawn | Function | 每次生成后回调：`fn(entity)` |

**返回**
`number` — 刷怪器句柄 id（从 1 递增）；`opts` 不是对象返回 `null`

**说明**
✅ 已实现。刷怪器每帧推进计时器，`interval` 到点就在 `area` 里**随机取点**生成 `count` 个 `kind: "PROP"` 的实体。
要点：
- `max` 统计的是**该刷怪器自己刷出的累计数量**（`spawned` 计数器），**不是场上存活数** —— 刷满 `max` 次后刷怪器**自动停止并移除**。
- 区域参数会兜底：`w`/`h` `<= 0` 用整图尺寸；`area` 缺省时用 `(0,0,地图宽,地图高)`。
- 生成的实体**不带标签**（只能靠 `asset` / `script` / `onSpawn` 区分）。
- 刷怪器**不随脚本销毁** —— 想停必须 `bwe.spawner.stop(handle)`。

**示例**
```js
var slimeSpawner = -1;

function onSceneStart(ctx) {
  slimeSpawner = bwe.spawner.create({
    asset: "史莱姆",
    script: "slime",
    count: 1,
    interval: 3,
    max: 12,
    area: { x: 100, y: 100, w: 400, h: 300 },
    onSpawn: function (e) {
      e.addTag("敌人");
      bwe.log("刷出一只 " + e.name);
    }
  });
  bwe.log("刷怪器 handle = " + slimeSpawner);
}

function onKey(ctx, key) {
  if (key === "KeyP") {
    bwe.spawner.stop(slimeSpawner);
  }
}
```

**另见**
[bwe.spawner.stop](#bwespawnerstophandle--void) · [bwe.world.spawn](world.md#bweworldspawnopts--entity--null) · [bwe.pool.acquire](prefab.md#bwepoolacquirehandle-x-y--entity--null)（想要「复用而非新建」用池）

---

### bwe.spawner.stop(handle) → void

**签名**
`bwe.spawner.stop(handle: number | { id: number }): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| handle | `number \| {id: number}` | `create` 返回的 id；也接受带 `id` 字段的对象 |

**返回**
`void`

**说明**
✅ 已实现。停掉并移除该刷怪器。**传无效 id 会停掉全部刷怪器**（内部 `id < 0` 时匹配所有）—— 想「停全部」可以传 `-1`。

**示例**
```js
bwe.spawner.stop(slimeSpawner);
bwe.spawner.stop(-1);              // 停掉所有刷怪器
```

**另见**
[bwe.spawner.create](#bwespawnercreateopts--number)

---

## 六、组合示例：寻路巡逻 + 交互拾取

```js
var G = { path: [], idx: 0, target: null };

function onSceneStart(ctx) {
  // 每帧刷新最近交互物 + 提示
  bwe.on("update", function (dt) {
    G.target = bwe.interact.nearest(null, { radius: 56, tag: "可交互" });
    bwe.interact.prompt(G.target ? G.target.name + " [E]" : null);
  });

  // 交互一次就够，别每帧注册
  bwe.interact.onTrigger(function (target, actor) {
    if (target && target.hasTag("可交互")) {
      bwe.log("拾取了 " + target.name);
      target.destroy();
      bwe.audio.play("拾取");
    }
  });
}

function onInteract_goTo(ctx, cx, cy) {
  var p = bwe.grid.toWorld(cx, cy);
  var path = bwe.nav.find(ctx.self, p);
  if (path.length > 1) {
    bwe.nav.follow(ctx.self, path, { speed: 120, arrive: 4 });
  }
}
```

---

## 七、边界与陷阱

| 情况 | 行为 |
|---|---|
| `grid.toCell` 负坐标 | 返回负格子号（`floor`），不钳制 |
| `tilemap.solid` 越界 | **返回 `true`**（地图外算墙） |
| `tilemap.get` / `set` 越界 | `get` 返回 0；`set` 忽略写入 |
| `tilemap.setSolid` | 改的是**整类瓦片**，不能只开一格 |
| `tilemap.set` | 只改数据层，**不改变绘制**（瓦片靠 TILE 实体画） |
| `tilemap.blocked` 的 `x/y` | **左上角**，不是中心 |
| `tilemap.raycast` | 1px 步进、最多 4000 步（超长射线会被截断） |
| `nav.find` 越界起点/终点 | 返回 `[]` |
| `nav.find` 超过 maxNodes | 返回 `[]`（调大预算） |
| `nav.find` 目标格是墙 | **允许到达**（走到墙边） |
| `nav.follow` 路径只有 1 点 | 立刻 `onArrive` 并结束 |
| `nav.follow` 后再直接改 `e.x/e.y` | 会和 follow 打架 —— 先 `nav.stop` |
| `interact.nearest(null, ...)` | 自动找玩家（标签 `玩家`/`Player`/`player`，否则第一个 ACTOR） |
| `interact.onTrigger` 在 `onUpdate` 里注册 | ⚠ **每帧加一个回调** —— 只注册一次 |
| `interact.onTrigger` | **没有取消订阅** |
| `interact.setKey(无效键名)` | 交互触发被关掉（keyCode 变 -1） |
| `spawner.create` 的 `max` | 统计的是**累计生成数**，刷满即自动停止 |
| `spawner.create` 生成实体的 kind | 固定 `"PROP"`、无标签 |
| `spawner.stop(-1)` | 停掉**全部**刷怪器 |
| 刷怪器生命周期 | 不随脚本销毁，必须显式 `stop` |
