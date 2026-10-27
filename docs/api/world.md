# bwe.world — 世界（World）

> 本页覆盖：`bwe.world` 的全部成员 —— 地图信息、实体查找、生成（单个 / 批量 / 克隆）、销毁（单个 / 批量 / 按标签 / 按查询）、计数与遍历、暂停与时间缩放、世界事件总线、图层信息。
>
> 相关页：[entity：Entity](entity.md) · [prefab：预制体与对象池](prefab.md) · [lifecycle：生命周期与 ctx](lifecycle.md) · [map-nav-interact-spawner：网格 / 瓦片 / 寻路 / 交互 / 刷怪](map-nav-interact-spawner.md) · [README：索引](README.md)

**坐标约定**（全页通用）：世界像素、`(x, y)` 是对象的**中心点**、**Y 轴向下**。格子大小 = `tileSize`。

**Phase 说明**：`✅ 已实现` / `🧪 试验` / `📋 规划`。

---

## 一、地图信息

### bwe.world.mapSize() → {w, h}

**签名**
`bwe.world.mapSize(): { w: number; h: number }`

**参数**
无

**返回**
`{w, h}` — 地图尺寸（**像素**，不是格数）

**说明**
✅ 已实现。每次调用都新建一个对象。格数请用 `bwe.world.scene.widthTiles`。

**示例**
```js
var size = bwe.world.mapSize();
bwe.log("地图 " + size.w + "x" + size.h + " 像素");
```

**另见**
[bwe.world.tileSize](#bweworldtilesize--number) · [bwe.world.scene](#bweworldscene--sceneinfo)

---

### bwe.world.tileSize() → number

**签名**
`bwe.world.tileSize(): number`

**参数**
无

**返回**
`number` — 每格像素

**说明**
✅ 已实现。优先取场景的 `tileSize`，场景不存在时退回工程默认值。等价于 `bwe.grid.cellSize`。

**示例**
```js
var ts = bwe.world.tileSize();      // 常见是 32
var cell = bwe.grid.toCell(100, 100);
```

**另见**
[bwe.grid.cellSize](map-nav-interact-spawner.md#bwegridcellsize--number)

---

### bwe.world.scene → SceneInfo

**签名**
`bwe.world.scene: { name: string; width: number; height: number; widthTiles: number; heightTiles: number; tileSize: number }`

**参数**
无（只读属性）

**返回**
`SceneInfo` — 只读快照对象（长期是同一个对象，字段是 getter，每次读都是最新值）

**说明**
✅ 已实现。字段含义：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 当前场景名（取 `boot.json` 的第一个场景，空工程是 `""`） |
| `width` | number | 地图宽（**像素**） |
| `height` | number | 地图高（**像素**） |
| `widthTiles` | number | 地图宽（**格数**） |
| `heightTiles` | number | 地图高（**格数**） |
| `tileSize` | number | 每格像素 |

注意这里**没有** `visible` / `locked` 之类的图层概念 —— 图层需要 `bwe.world.layers()`（见下）。

**示例**
```js
var s = bwe.world.scene;
bwe.log(s.name + " " + s.widthTiles + "x" + s.heightTiles + " 格 @" + s.tileSize + "px");
```

**另见**
[bwe.world.layers](#bweworldlayers--layer)

---

## 二、查找

### bwe.world.find(q) → Entity | null

**签名**
`bwe.world.find(q: EntityQuery): Entity | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| q | `string \| {name?, tag?, kind?, id?}` | 字符串 = 匹配**名字 / id / 标签**三者的任意一个；对象 = 按给出的字段逐项 AND 过滤 |

**返回**
`Entity | null` — 找不到返回 `null`（不是 `undefined`）

**说明**
✅ 已实现。遍历所有**存活**实体（`dead` 的自动跳过），返回**第一个**匹配项。顺序 = `bwe.world.entities()` 的顺序（场景对象顺序，脚本生成的追加在后）。
对象查询里 `kind` 是**大小写不敏感**的，`name` / `id` / `tag` 是精确匹配且大小写敏感。

**示例**
```js
var player = bwe.world.find("玩家");                 // 名字或标签
var byId = bwe.world.find({ id: "o-12" });
var goblins = bwe.world.find({ kind: "ACTOR", tag: "敌人" });   // 先命中的那个
bwe.log(player ? player.name : "没找到");
```

**另见**
[bwe.world.findAll](#bweworldfindallq--entity) · [bwe.world.count](#bweworldcountq--number) · [Entity](entity.md)

---

### bwe.world.findAll(q) → Entity[]

**签名**
`bwe.world.findAll(q: EntityQuery): Entity[]`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| q | `string \| {name?, tag?, kind?, id?}` | 同 `find` |

**返回**
`Entity[]` — 匹配的存活实体；没有匹配返回**空数组**（不是 `null`）

**说明**
✅ 已实现。每次调用都新建数组，可以放心持有 / 排序。
只需要数量时用 `bwe.world.count(q)`；要边遍历边销毁时用 `bwe.world.each(q, fn)`（`each` 内部先拍快照，更安全）。

**示例**
```js
var enemies = bwe.world.findAll("敌人");
bwe.log("还剩 " + enemies.length + " 个敌人");
for (var i = 0; i < enemies.length; i++) {
  bwe.log(enemies[i].name + " @ " + enemies[i].x + "," + enemies[i].y);
}
```

**另见**
[bwe.world.find](#bweworldfindq--entity--null) · [bwe.world.each](#bweworldeachq-fn--void) · [bwe.world.entities](#bweworldentities--entity)

---

### bwe.world.entities() → Entity[]

**签名**
`bwe.world.entities(): Entity[]`

**参数**
无

**返回**
`Entity[]` — 当前所有**存活**实体（新数组快照，不要原地改）

**说明**
✅ 已实现。包含场景原生对象和脚本生成的对象。顺序：场景对象在前（按场景文件顺序），脚本生成的后追加。
数组内容也会包含 `TILE` / `ZONE` / `LIGHT` 等非 ACTOR 对象 —— 想只拿角色请用 `{ kind: "ACTOR" }` 查询。

**示例**
```js
var all = bwe.world.entities();
var tiles = 0;
for (var i = 0; i < all.length; i++) {
  if (all[i].kind === "TILE") { tiles++; }
}
bwe.log("共 " + all.length + " 个对象，其中 " + tiles + " 个地块");
```

**另见**
[bwe.world.findAll](#bweworldfindallq--entity) · [bwe.world.count](#bweworldcountq--number)

---

## 三、生成

### bwe.world.spawn(opts) → Entity | null

**签名**
`bwe.world.spawn(opts: SpawnOpts): Entity | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| opts.x | number | 世界像素 X（中心点），默认 0 |
| opts.y | number | 世界像素 Y（中心点），默认 0 |
| opts.asset | string | 素材名（`boot.json` 的 `assets[].name`），默认 `""` |
| opts.name | string | 对象名（`find` 可用），默认 `""` |
| opts.kind | string | 对象大类，默认 `"PROP"`（可选 `ACTOR` / `PROP` / `TILE` / `ZONE` / `SPAWN` / `PORTAL` / `LIGHT`） |
| opts.z | number | 排序层级，默认 0（大的盖住小的） |
| opts.layer | number | 图层下标，默认 0（绘制顺序 `layer → z → y`） |
| opts.halfW | number | 碰撞半宽，默认 0（0 = 不参与瓦片阻挡判定） |
| opts.halfH | number | 碰撞半高，默认 0 |
| opts.scaleX | number | 横向缩放，默认 1 |
| opts.scaleY | number | 纵向缩放，默认 1 |
| opts.rotation | number | 旋转角度（度，顺时针），默认 0 |
| opts.visible | boolean | 是否可见，默认 `true` |
| opts.animMode | string | 动画模式：`"默认"` / `"只显示首帧"` / `"单次播放"`（也认 `"loop"` / `"first"` / `"once"`），默认 `"默认"` |
| opts.animFps | number | 每秒帧数，默认 8 |
| opts.script | string | 挂上的 JS 脚本名（`boot.json` 的 `scripts[].name`，不是文件路径），默认不挂 |
| opts.tags | string[] | 初始标签（自动去重） |
| opts.modules | SpawnModuleInit[] | 初始模块：`{ def, params?, when? }` |
| opts.props | object | 初始对象属性（数值/布尔会归一成编辑器同构文本） |
| opts.parent | Entity \| null | 父实体（脚本层的归属关系，见 [Entity.parent](entity.md#eparent--entity--null)） |

**返回**
`Entity | null` — 生成失败（`opts` 不是对象）返回 `null`

**说明**
✅ 已实现。这是**唯一的实体生成入口** —— `bwe.prefab.spawn` / `bwe.world.clone` / `bwe.pool.acquire` 内部全部走同一条路径，所以「生成出来的东西」行为完全一致。
如果 `opts.script` 指向不存在的脚本，会写一条告警、照样生成实体（只是没有脚本逻辑）。生成当帧就会派发脚本的 `onStart`。

**示例**
```js
var slime = bwe.world.spawn({
  x: 320, y: 240,
  asset: "史莱姆",
  name: "slime-1",
  kind: "ACTOR",
  halfW: 16, halfH: 16,
  tags: ["敌人", "史莱姆"],
  script: "slime",
  modules: [
    { def: "fight.hp", params: { hp: 30 } },
    { def: "move.wander", params: { speed: 20, area: 80 } }
  ],
  props: { w: 32, h: 32 }
});
if (slime) {
  bwe.log("生成了 " + slime.name + " id=" + slime.id);
}
```

**另见**
[bwe.world.spawnMany](#bweworldspawnmanylist--entity) · [bwe.world.spawnAt](#bweworldspawnatopts-x-y--entity--null) · [bwe.prefab.spawn](prefab.md#bweprefabspawnname-opts--entity--null) · [Entity](entity.md)

---

### bwe.world.spawnMany(list) → Entity[]

**签名**
`bwe.world.spawnMany(list: SpawnOpts[]): Entity[]`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| list | SpawnOpts[] | 每个元素是一份完整的 `spawn` 参数 |

**返回**
`Entity[]` — 实际生成成功的实体（失败的元素被跳过，**不占位**）

**说明**
✅ 已实现。等价于循环调 `spawn` 并收集结果。适合「一次性刷一波」，比手写循环短，但没有额外性能收益 —— 要大量复用同一模板请用 [bwe.prefab.spawnMany](prefab.md#bweprefabspawnmanyname-optslist--entity) 或对象池。
`list` 不是数组时返回空数组。

**示例**
```js
var waves = [];
for (var i = 0; i < 5; i++) {
  waves.push({
    x: 100 + i * 40, y: 600,
    asset: "哥布林", kind: "ACTOR",
    tags: ["敌人"], script: "goblin"
  });
}
var spawned = bwe.world.spawnMany(waves);
bwe.log("刷了 " + spawned.length + " 个哥布林");
```

**另见**
[bwe.world.spawn](#bweworldspawnopts--entity--null) · [bwe.prefab.spawnMany](prefab.md#bweprefabspawnmanyname-optslist--entity)

---

### bwe.world.spawnAt(opts, x, y) → Entity | null

**签名**
`bwe.world.spawnAt(opts: SpawnOpts, x: number, y: number): Entity | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| opts | SpawnOpts | 同 `spawn` 的参数（其中 `x`/`y` 会被后两个参数强制覆盖） |
| x | number | 覆盖的 X（默认 0） |
| y | number | 覆盖的 Y（默认 0） |

**返回**
`Entity | null`

**说明**
✅ 已实现。便捷写法：模板参数放在一处复用，位置每次不同。
实现上会**新建一个合并对象**（浅拷贝 opts 的 values / getters / setters），所以你传的 `opts` 对象**不会被改动**。

**示例**
```js
var dropOpts = { asset: "金币", kind: "PROP", tags: ["掉落"] };

function onUpdate(ctx, dt) {
  if (bwe.input.pressed("Space")) {
    bwe.world.spawnAt(dropOpts, ctx.self.x, ctx.self.y);
  }
}
```

**另见**
[bwe.world.spawn](#bweworldspawnopts--entity--null) · [bwe.world.clone](#bweworldclonee-opts--entity--null)

---

### bwe.world.clone(e, opts?) → Entity | null

**签名**
`bwe.world.clone(e: Entity, opts?: object): Entity | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 被复制的实体（必须先存在且 `alive`） |
| opts | object | 覆盖副本的字段，字段名同 `SpawnOpts`（`x` / `y` / `name` / `scaleX` / `tags` / `props` …） |

**返回**
`Entity | null` — `e` 无效 / 已销毁时返回 `null`

**说明**
✅ 已实现。复制的内容：`kind` / `asset` / `z` / `layer` / `halfW` / `halfH` / `scaleX` / `scaleY` / `rotation` / `visible` / `animMode` / `animFps` / `script` / `tags` / `modules`（深拷贝参数）/ `props` / **子精灵（`e.attach` 挂的那些）**。
默认位置和名字 = 源实体的位置和名字（所以副本和原件重名 —— 想区分请在 `opts.name` 里给新名字）。

**示例**
```js
var src = bwe.world.find("木箱");
if (src) {
  var copy = bwe.world.clone(src, { x: src.x + 64, name: "木箱-2" });
  if (copy) { copy.addTag("复制品"); }
}
```

**另见**
[bwe.world.spawn](#bweworldspawnopts--entity--null) · [bwe.prefab.fromEntity](prefab.md#bweprefabfromentitye-name--string--null)

---

## 四、销毁

### bwe.world.destroy(e) → void

**签名**
`bwe.world.destroy(e: Entity): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 要销毁的实体 |

**返回**
`void`

**说明**
✅ 已实现。等价于 `e.destroy()`。派发顺序：对象脚本 `onDestroy` → 实体 `"destroy"` 事件 → 从公开实体列表移除、标记 `dead`。
传 `null` / 非 Entity / 已销毁的实体都是安全空操作。挂在该实体上的子精灵（`e.attach`）会一起清掉。

**示例**
```js
var old = bwe.world.find("旧特效");
if (old) { bwe.world.destroy(old); }
```

**另见**
[Entity.destroy](entity.md#edestroy--void) · [bwe.world.destroyAll](#bweworlddestroyallfilter--number)

---

### bwe.world.clear() → void

**签名**
`bwe.world.clear(): void`

**参数**
无

**返回**
`void`

**说明**
✅ 已实现。销毁**所有**存活实体 —— **包括场景原生对象**。清完之后场景就是空的，地图仍然在（`mapSize` 不变）。
每销毁一个都走完整 `onDestroy` 流程，所以脚本能感知到。想只清脚本生成的对象，请用 `destroyAll({ tag: "..." })` 或 `clearTag`。

**示例**
```js
function onSceneStart(ctx) {
  // 例如做一个「清版」重来的按钮
  bwe.world.clear();
  bwe.world.spawn({ x: 320, y: 240, asset: "玩家", kind: "ACTOR", tags: ["玩家"] });
}
```

**另见**
[bwe.world.clearTag](#bweworldcleartagtag--void) · [bwe.world.destroyAll](#bweworlddestroyallfilter--number)

---

### bwe.world.clearTag(tag) → void

**签名**
`bwe.world.clearTag(tag: string): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| tag | string | 标签名；空字符串是空操作 |

**返回**
`void`

**说明**
✅ 已实现。只销毁带这个标签的实体。典型用法：清一波小怪 / 清所有掉落物。

**示例**
```js
bwe.world.clearTag("掉落物");
```

**另见**
[bwe.world.clear](#bweworldclear--void) · [Entity.addTag](entity.md#eaddtagtag--boolean)

---

### bwe.world.destroyAll(filter?) → number

**签名**
`bwe.world.destroyAll(filter?: EntityQuery): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| filter | EntityQuery | **省略 = 全部**；给字符串或 `{name,tag,kind,id}` 对象则只销毁匹配项 |

**返回**
`number` — **实际销毁的数量**

**说明**
✅ 已实现。`clear()` 的「带返回值 + 带过滤」版本。
注意「省略 filter」等于 `clear()`：连场景原生对象一起清。只想清脚本产物时，务必给 filter。

**示例**
```js
var n = bwe.world.destroyAll("敌人");
bwe.log("清掉了 " + n + " 个敌人");

// 只清低于 3 级的（先筛再逐个）
var weak = bwe.world.findAll("敌人");
for (var i = 0; i < weak.length; i++) {
  if (weak[i].prop("level", 1) < 3 && weak[i].alive) {
    weak[i].destroy();
  }
}
```

**另见**
[bwe.world.clear](#bweworldclear--void) · [bwe.world.count](#bweworldcountq--number)

---

## 五、计数与遍历

### bwe.world.count(q?) → number

**签名**
`bwe.world.count(q?: EntityQuery): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| q | EntityQuery | 省略 = 存活实体总数；给了就统计匹配数 |

**返回**
`number`

**说明**
✅ 已实现。比 `findAll(q).length` 省一次数组分配 —— 刷怪上限判定优先用它。

**示例**
```js
if (bwe.world.count({ tag: "敌人" }) < 20) {
  bwe.world.spawn({ x: 100, y: 100, asset: "史莱姆", kind: "ACTOR", tags: ["敌人"] });
}
bwe.log("场上共 " + bwe.world.count() + " 个对象");
```

**另见**
[bwe.world.findAll](#bweworldfindallq--entity) · [bwe.prefab.count](prefab.md#bweprefabcountname--number)

---

### bwe.world.each(q, fn) → void

**签名**
`bwe.world.each(q: EntityQuery | null, fn: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| q | EntityQuery \| null | 查询条件；`null` / `undefined` = 遍历全部 |
| fn | Function | 每个实体调一次：`fn(e)` |

**返回**
`void`

**说明**
✅ 已实现。**内部先拍快照**，所以回调里 `spawn` / `destroy` 不会破坏迭代 —— 但这也意味着「刚刚 spawn 出来的对象本次不会被遍历到」。
遍历时跳过 `dead` 的实体。`fn` 不是函数时什么也不做。

**示例**
```js
bwe.world.each({ tag: "敌人" }, function (e) {
  if (e.hp < 10) {
    e.destroy();          // ✓ 安全：快照迭代
  } else {
    e.setAlpha(0.5);
  }
});
```

**另见**
[bwe.world.findAll](#bweworldfindallq--entity) · [bwe.world.entities](#bweworldentities--entity)

---

## 六、暂停与时间缩放

### bwe.world.paused → boolean

**签名**
`bwe.world.paused: boolean`（可读写）

**参数**
写入：`boolean`

**返回**
读取：`boolean`

**说明**
✅ 已实现。`true` 时：不派发 `"update"` 钩子、不派发对象 `onUpdate`、不跑模块 / 交代子系统 / 定时器 / 路径跟随 / 刷怪器；`bwe.time.now` 停止增长，`ctx.dt` 变 0。
**仍然会跑**：`"draw"` 钩子与 `bwe.draw.*` 绘制（所以暂停菜单能正常画）、点击 / 按键派发。

**示例**
```js
function onKey(ctx, key) {
  if (key === "Escape") {
    bwe.world.paused = !bwe.world.paused;
  }
}
```

**另见**
[bwe.world.timeScale](#bweworldtimescale--number)

---

### bwe.world.timeScale → number

**签名**
`bwe.world.timeScale: number`（可读写）

**参数**
写入：`number`（1 = 正常；0 = 时间冻结；2 = 双倍速）

**返回**
读取：`number`

**说明**
✅ 已实现。乘在 `dt` 上：`ctx.dt` 与所有定时器 / 模块都按缩放后的时间走。
原始帧步长先被钳制在 `[0, 0.1]` 秒，再乘 `timeScale`。暂停时 `timeScale` 不生效（时间直接停）。

**示例**
```js
bwe.world.timeScale = 0.25;   // 慢动作
bwe.after(2, function () { bwe.world.timeScale = 1; });   // 注意：after 也走缩放时间
```

**另见**
[bwe.world.paused](#bweworldpaused--boolean) · [bwe.time](input-camera-time.md#三bwetime--时间)

---

## 七、世界事件总线

> ⚠ 别和 `bwe.on` 混了：**`bwe.on` 是引擎内置钩子**（只有 `"update"` / `"draw"` / `"keydown"` / `"click"` 四个名会被自动调用），**`bwe.world.on` 是自定义事件总线**（名字随便起，靠 `emit` 手动派发）。

### bwe.world.on(name, fn) → void

**签名**
`bwe.world.on(name: string, fn: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 自定义事件名（空字符串无效） |
| fn | Function | 回调：`fn(payload)`，`payload` 就是 emit 时传的那个值 |

**返回**
`void`

**说明**
✅ 已实现。注册后长期有效，直到 `bwe.world.off(name, fn)`。可以注册多个回调，派发顺序 = 注册顺序。

**示例**
```js
function onSceneStart(ctx) {
  ctx.world.on("bossDead", function (payload) {
    bwe.log("Boss 倒了：" + payload.name);
    bwe.camera.shake(12, 0.5);
  });
}
```

**另见**
[bwe.world.emit](#bweworldemitname-payload--void) · [bwe.world.off](#bweworldoffname-fn--void)

---

### bwe.world.off(name, fn) → void

**签名**
`bwe.world.off(name: string, fn: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 事件名 |
| fn | Function | 注册时的**同一个函数引用** |

**返回**
`void`

**说明**
✅ 已实现。按引用比较移除。匿名函数字面量无法移除 —— 必须先把函数存进变量。

**示例**
```js
var onBossDead = function (payload) { bwe.log("boss dead"); };
bwe.world.on("bossDead", onBossDead);
bwe.world.off("bossDead", onBossDead);   // ✓
```

**另见**
[bwe.world.on](#bweworldonname-fn--void)

---

### bwe.world.emit(name, payload) → void

**签名**
`bwe.world.emit(name: string, payload?: unknown): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 事件名（空字符串无效） |
| payload | unknown | 任意载荷；回调收到的是**同一个引用**，没有被序列化 |

**返回**
`void`

**说明**
✅ 已实现。**同步**派发：`emit` 返回时所有回调都跑完了。回调里再 `emit` 会递归（注意死循环）。
没有监听者时是安全空操作 —— 所以「先 emit、后注册」会丢事件，注册要早（`onSceneStart` 里）。

**示例**
```js
bwe.world.emit("score", { total: 120, combo: 3 });

// 接收方
function onSceneStart(ctx) {
  ctx.world.on("score", function (data) {
    bwe.log("分数 " + data.total + " 连击 " + data.combo);
  });
}
```

**另见**
[bwe.world.on](#bweworldonname-fn--void) · [bwe.call](lifecycle.md#bwecallscriptname-handlername-args--unknown)

---

## 八、图层

### bwe.world.layers() → Layer[]

**签名**
`bwe.world.layers(): { id: string; name: string; visible: boolean; locked: boolean; order: number }[]`

**参数**
无

**返回**
`Layer[]` — 场景图层表（新数组）；**数据来源缺失时返回空数组**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 图层 id，如 `"layer-terrain"` |
| `name` | string | 图层中文名，如 `"地形"` |
| `visible` | boolean | 该图层是否可见（编辑器里的开关状态） |
| `locked` | boolean | 该图层是否锁定（编辑器里的开关状态） |
| `order` | number | 绘制顺序（小的在下层） |

**说明**
✅ 已实现。数据来源是 `scene_*.json` 顶层的 `layers[]`（编辑器导出时写入）。

⚠ **向后兼容要点**：**旧 Build 的 `scene_*.json` 没有 `layers` 字段** → 返回**空数组**（不报错）。所以脚本要先判长度再用：

```js
var layers = bwe.world.layers();
if (layers.length === 0) { /* 旧工程，没有图层数据 */ }
```

典型返回（新 Build）：

```js
[ {id: "layer-terrain", name: "地形", visible: true, locked: false, order: 0},
  {id: "layer-prop",    name: "物件", visible: true, locked: false, order: 1},
  {id: "layer-actor",   name: "角色", visible: true, locked: false, order: 2} ]
```

**注意**：这里读到的是**图层元数据（只读快照）**，不会驱动渲染 —— 实际绘制排序用的是每个对象的 `layer` 数字下标（`layer → z → y`），见 [Entity.layer](entity.md#elayer--number)。

**示例**
```js
var layers = bwe.world.layers();
bwe.log("图层数：" + layers.length);
for (var i = 0; i < layers.length; i++) {
  var L = layers[i];
  bwe.log(L.order + " " + L.id + " / " + L.name + " visible=" + L.visible + " locked=" + L.locked);
}
```

**另见**
[Entity.layer](entity.md#elayer--number) · [Entity.z](entity.md#ez--number)

---

## 九、错误与边界

| 情况 | 行为 |
|---|---|
| `spawn(null)` / `spawn("字符串")` | 返回 `null`，不抛异常 |
| `spawn` 的 `asset` 不存在 | 实体照样生成，绘制走「无贴图兜底色块」 |
| `spawn` 的 `script` 不存在 | 写一条日志告警，实体照样生成（无脚本逻辑） |
| `destroy(null)` / 重复 destroy | 安全空操作 |
| `find` / `findAll` 传非法查询 | 返回 `null` / `[]` |
| `emit` 一个没人听的事件 | 安全空操作 |
| `bwe.world.clear()` | ⚠ 会连场景原生对象一起清掉 |
