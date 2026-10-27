# bwe.prefab / bwe.pool — 预制体与对象池（Prefab & Object Pool）

> 本页覆盖：`bwe.prefab`（运行期模板注册表）与 `bwe.pool`（对象池）的全部成员。心智模型是 Unity 的「模板 → 实例」，但**只做运行期这一层**。
>
> 相关页：[world：实体生成](world.md#三生成) · [entity：Entity](entity.md) · [README：索引](README.md)

**一句话**：`prefab` 让你把一份「对象配方」注册成模板，之后每条命都是从模板实例化；`pool` 让你复用这些实例，避免频繁 spawn/destroy。

**v1 的三个确定性取舍**（写代码前必读）：

| 取舍 | 含义 |
|---|---|
| **不做热更新** | `define` 之后**已经生成的实例保持原样**；之后 `spawn` 才用新定义。改模板不会「回溯」改已存在的实体 |
| **`children` 不是嵌套 Actor** | 模板里的 `children` 用引擎已有的**子精灵**（`e.attach`）实现，不是真正的子实体层级 |
| **`jitter` 不联动 `bwe.seed`** | 随机抖动用的是 `prefab` 自己的 `Random`，与 `bwe.seed` 的确定性随机源**不是同一个**。想要可复现的散布请自己在脚本里算好坐标 |

**Phase 说明**：`✅ 已实现` / `🧪 试验` / `📋 规划`。

---

## 一、`bwe.prefab` 成员一览

| 成员 | 说明 |
|---|---|
| `define(name, spec)` | 注册 / 覆盖模板 |
| `get(name)` | 读模板的**深拷贝快照** |
| `list()` | 所有模板名（顺序 = define 顺序） |
| `has(name)` | 有没有这个模板 |
| `remove(name)` | 移除模板 |
| `spawn(name, opts?)` | 实例化一个 |
| `spawnMany(name, optsList?)` | 批量实例化 |
| `count(name)` | 当前存活的该模板实例数 |
| `fromEntity(e, name?)` | 把场上实体抓成模板 |

模板也可以来自 `boot.json` 的 `prefabs[]`（编辑器导出的那一份），引擎启动时会自动预定义，脚本里直接 `spawn` 即可。

---

### bwe.prefab.define(name, spec) → boolean

**签名**
`bwe.prefab.define(name: string, spec: PrefabSpec): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 模板名，全局唯一；空字符串返回 `false` |
| spec | PrefabSpec | 模板定义（纯 JSON 可序列化对象） |

`spec` 的字段（**全部可缺省**）：

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `kind` | string | `"PROP"` | 对象大类：`ACTOR` / `PROP` / `TILE` / `ZONE` / `SPAWN` / `PORTAL` / `LIGHT` |
| `asset` | string | `""` | 素材名（`boot.json` 的 `assets[].name`） |
| `z` | number | 0 | 排序层级 |
| `layer` | number | 0 | 图层下标（排序 `layer → z → y`） |
| `halfW` | number | 0 | 碰撞半宽（0 = 不参与瓦片阻挡） |
| `halfH` | number | 0 | 碰撞半高 |
| `size` | `{w,h}` | — | 便捷写法，等価于 `halfW = w/2, halfH = h/2`（回读时总以 halfW/halfH 为准） |
| `scaleX` | number | 1 | 横向缩放 |
| `scaleY` | number | 1 | 纵向缩放 |
| `rotation` | number | 0 | 旋转（度，顺时针） |
| `visible` | boolean | `true` | 是否可见 |
| `animMode` | string | `"默认"` | 动画模式（也认 `"loop"` / `"first"` / `"once"`） |
| `animFps` | number | 8 | 每秒帧数 |
| `script` | string | `""` | 挂上的 JS 脚本名（`boot.json` 的 `scripts[].name`） |
| `tags` | string[] | `[]` | 初始标签（自动去重） |
| `modules` | array | `[]` | 初始模块：`{ def, when?, params? }`；`script.js` 模块会被折叠进 `script` 字段 |
| `props` | object | `{}` | 初始对象属性（值归一成编辑器同构文本） |
| `children` | array | `[]` | 子精灵列表（见 [children 小节](#61-children子精灵)） |
| `x` / `y` | number | 0 | 模板自带的基础位置（`spawn` 没给 x/y 时用它） |
| `jitter` | `{x,y}` | — | 实例化时的随机抖动幅度：各加 `[-x,+x]` / `[-y,+y]` |
| `jitterX` / `jitterY` | number | 0 | `jitter` 的扁平写法，取绝对值 |

**返回**
`boolean` — `true` = 注册成功；`spec` 不是对象或 `name` 为空返回 `false`

**说明**
✅ 已实现。同名模板会被**整体覆盖**（不是合并）。注册表是 `LinkedHashMap`，所以 `list()` 的顺序 = define 顺序。
`props` 里的值会被转成字符串（数字整数去小数点、布尔 → `"开"/"关"`），和编辑器里那份数据同构。

**示例**
```js
bwe.prefab.define("goblin", {
  kind: "ACTOR",
  asset: "哥布林",
  halfW: 16, halfH: 16,
  tags: ["敌人", "哥布林"],
  script: "goblin",
  modules: [
    { def: "fight.hp", params: { hp: 30 } },
    { def: "move.wander", params: { speed: 30, area: 100 } }
  ],
  props: { w: 32, h: 32 },
  jitter: { x: 24, y: 24 }
});

bwe.log("模板数：" + bwe.prefab.list().length);
```

**另见**
[bwe.prefab.spawn](#bweprefabspawnname-opts--entity--null) · [bwe.prefab.fromEntity](#bweprefabfromentitye-name--string--null) · [PrefabSpec 字段表](#bweprefabdefinename-spec--boolean)

---

### bwe.prefab.get(name) → PrefabSpec | null

**签名**
`bwe.prefab.get(name: string): PrefabSpec | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 模板名 |

**返回**
`PrefabSpec | null` — **深拷贝快照**（每次调用都新建对象 / 数组）；模板不存在返回 `null`

**说明**
✅ 已实现。回读的字段总是 `halfW/halfH`（即使当初写的是 `size`），并且额外补出 `size` / `jitter` / `children` 三个便利对象。
**改返回值不会影响注册表** —— 想改模板请重新 `define`。

**示例**
```js
var spec = bwe.prefab.get("goblin");
if (spec) {
  bwe.log("hp 参数 = " + spec.modules[0].params.hp);
  bwe.log("尺寸 = " + spec.size.w + "x" + spec.size.h);
  spec.z = 999;     // ← 只改快照，注册表里的 z 还是原值
}
```

**另见**
[bwe.prefab.define](#bweprefabdefinename-spec--boolean) · [bwe.prefab.list](#bweprefablist--string)

---

### bwe.prefab.list() → string[]

**签名**
`bwe.prefab.list(): string[]`

**参数**
无

**返回**
`string[]` — 所有模板名，**顺序 = define 顺序**（包括从 `boot.json` 预载的那些，排在最前）

**说明**
✅ 已实现。新数组快照。

**示例**
```js
var names = bwe.prefab.list();
for (var i = 0; i < names.length; i++) {
  bwe.log(names[i] + " 存活 " + bwe.prefab.count(names[i]));
}
```

**另见**
[bwe.prefab.count](#bweprefabcountname--number) · [bwe.prefab.has](#bweprefabhasname--boolean)

---

### bwe.prefab.has(name) → boolean

**签名**
`bwe.prefab.has(name: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 模板名 |

**返回**
`boolean`

**说明**
✅ 已实现。spawn 之前先判断，可以避免那一条 `[预制体] 没有叫「x」的预制体` 日志。

**示例**
```js
if (!bwe.prefab.has("goblin")) {
  bwe.prefab.define("goblin", { kind: "ACTOR", asset: "哥布林" });
}
```

**另见**
[bwe.prefab.define](#bweprefabdefinename-spec--boolean)

---

### bwe.prefab.remove(name) → boolean

**签名**
`bwe.prefab.remove(name: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 模板名 |

**返回**
`boolean` — `true` = 确实删掉了一个模板；`false` = 本来就没有

**说明**
✅ 已实现。**只删模板定义**，已经生成的实例**不受影响**（它们已经是独立的实体了）。之后 `spawn(name)` 会返回 `null`。

**示例**
```js
if (bwe.prefab.remove("goblin")) {
  bwe.log("模板已删；场上 " + bwe.world.count("哥布林") + " 个实例还在");
}
```

**另见**
[bwe.prefab.define](#bweprefabdefinename-spec--boolean) · [bwe.world.destroyAll](world.md#bweworlddestroyallfilter--number)

---

### bwe.prefab.spawn(name, opts?) → Entity | null

**签名**
`bwe.prefab.spawn(name: string, opts?: PrefabSpawnOpts): Entity`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 模板名；不存在时返回 `null` 并写一条日志 |
| opts.x / opts.y | number | 位置覆盖；缺省用模板的 `x`/`y`（默认 0），再叠加 jitter |
| opts.z / opts.layer | number | 覆盖排序层级 / 图层 |
| opts.rotation | number | 覆盖旋转 |
| opts.scaleX / opts.scaleY | number | 覆盖缩放 |
| opts.halfW / opts.halfH | number | 覆盖碰撞半宽半高 |
| opts.visible | boolean | 覆盖可见性 |
| opts.animMode / opts.animFps | string / number | 覆盖动画参数 |
| opts.asset | string | 覆盖素材 |
| opts.script | string | 覆盖脚本名；**传 `""` = 不挂脚本** |
| opts.name | string | 覆盖实例名；**缺省用模板名**（见下） |
| opts.parent | Entity \| null | 父实体（脚本层归属） |
| opts.tags | string[] | **追加**到模板 tags 之后（自动去重） |
| opts.modules | array | **同 def 替换参数，新 def 追加** |
| opts.props | object | 与模板 props **合并**，同名以 opts 为准 |
| opts.jitter | boolean | 传 `false` 关掉模板自带的抖动 |

**返回**
`Entity | null` — 模板不存在 / 生成失败返回 `null`

**说明**
✅ 已实现。**三个必须记住的行为**：

1. **实例默认 `name` = 模板名**（可被 `opts.name` 覆盖）。所以 `bwe.world.find("goblin")` 能直接找到某模板的第一个实例、`bwe.world.findAll("goblin")` 找到全部、`bwe.world.count({ name: "goblin" })` 数出数量。
2. **覆盖语义是「按字段」的**：`tags` 追加去重、`modules` 同 def 替换 / 新 def 追加、`props` 合并、其余标量有就用 opts 的。**不会**整体替换。
3. **jitter 在 opts.x/y 之后叠加**：最终位置 = `(opts.x ?? 模板.x) + random(-jitterX, +jitterX)`，Y 同理。

生成走的是 `bwe.world.spawn` 的同一条内部路径，所以 `onStart` 会在生成当帧派发。

**示例**
```js
// 最基本：模板名 = 实例名
var g1 = bwe.prefab.spawn("goblin", { x: 320, y: 240 });
bwe.log(g1.name);                    // → "goblin"
bwe.log(g1 === bwe.world.find("goblin"));   // → true（第一个匹配）

// 给唯一名字 + 追加标签 + 覆盖模块参数
var boss = bwe.prefab.spawn("goblin", {
  x: 640, y: 480,
  name: "goblin-boss",
  tags: ["精英"],
  scaleX: 2, scaleY: 2,
  props: { hp: 200 },
  modules: [{ def: "fight.hp", params: { hp: 200 } }],
  jitter: false                       // 关掉模板抖动，位置精确
});

// 一次刷 5 个，只要名字和位置不同
for (var i = 0; i < 5; i++) {
  bwe.prefab.spawn("goblin", { name: "goblin-" + i, x: 100 + i * 48, y: 600 });
}
bwe.log("场上哥布林：" + bwe.prefab.count("goblin"));   // → 7
```

**另见**
[bwe.world.find](world.md#bweworldfindq--entity--null) · [bwe.prefab.spawnMany](#bweprefabspawnmanyname-opts--entity) · [bwe.pool.acquire](#bwepoolacquirehandle-x-y--entity--null) · [性能提示](#七性能提示)

---

### bwe.prefab.spawnMany(name, optsList?) → Entity[]

**签名**
`bwe.prefab.spawnMany(name: string, optsList?: PrefabSpawnOpts[]): Entity[]`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 模板名 |
| optsList | PrefabSpawnOpts[] | 每个元素是一份覆盖参数；效果等同循环调 `spawn` |

**返回**
`Entity[]` — 实际生成成功的实例（失败的元素被跳过，**不占位**）

**说明**
✅ 已实现。`optsList` 不是数组时返回 `[]`。每个元素都会**独立**吃一次 jitter（若模板开了抖动且该元素没传 `jitter: false`）。
刷怪 / 布置关卡用这个比手写循环短，但没有额外性能收益 —— 真正要省的是 `bwe.pool`。

**示例**
```js
var wave = [];
for (var i = 0; i < 8; i++) {
  wave.push({ x: 120 + i * 40, y: 520, name: "wave1-" + i, jitter: false });
}
var spawned = bwe.prefab.spawnMany("goblin", wave);
bwe.log("刷了 " + spawned.length + " 个");
```

**另见**
[bwe.prefab.spawn](#bweprefabspawnname-opts--entity--null) · [bwe.world.spawnMany](world.md#bweworldspawnmanylist--entity)

---

### bwe.prefab.count(name) → number

**签名**
`bwe.prefab.count(name: string): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 模板名 |

**返回**
`number` — 当前**存活**的、由该模板生成的实例数

**说明**
✅ 已实现。统计前会先清理已销毁的实例记录，所以数字是准确的。
⚠ 只统计 **`prefab.spawn` / `spawnMany` / `pool` 产生的**实例；`bwe.world.spawn` 或场景原生对象**不计入**（引擎没记录它们的来源）。想按名字数就用 `bwe.world.count({ name: "goblin" })`。

**示例**
```js
if (bwe.prefab.count("goblin") < 20) {
  bwe.prefab.spawn("goblin", { x: 400, y: 400 });
}
```

**另见**
[bwe.world.count](world.md#bweworldcountq--number) · [bwe.pool.stats](#bwepoolstatshandle--poolstats--null)

---

### bwe.prefab.fromEntity(e, name?) → string | null

**签名**
`bwe.prefab.fromEntity(e: Entity, name?: string): string | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 场上实体（必须 `alive`） |
| name | string | 模板名；省略时用实体的 `name`，实体也没名字就自动生成 `"prefab-<序号>"` |

**返回**
`string | null` — 注册成功的模板名；`e` 无效返回 `null`

**说明**
✅ 已实现。抓取的内容：`kind` / `asset` / `z` / `layer` / `halfW` / `halfH` / `scaleX` / `scaleY` / `rotation` / `visible` / `animMode` / `animFps` / **当前位置 x,y** / `tags` / `props` / `modules`（深拷贝）/ `script`（从 `script.js` 模块里折叠出来）/ **子精灵**（`e.attach` 挂的那些）。
⚠ 抓出来的模板会带上实体**当前位置**作为 `x/y` —— 想让模板可复用，通常 spawn 时显式给 `x`/`y`（会覆盖）。

**示例**
```js
var guard = bwe.world.find("守卫");
if (guard) {
  var name = bwe.prefab.fromEntity(guard, "guard-template");
  bwe.log("模板已注册：" + name);
  bwe.prefab.spawn(name, { x: 200, y: 200 });
}
```

**另见**
[bwe.world.clone](world.md#bweworldclonee-opts--entity--null) · [bwe.prefab.define](#bweprefabdefinename-spec--boolean)

---

## 二、`bwe.pool` 成员一览

对象池 = 「同一模板的一批实例，用的时候取、不用的时候还」。适合**高频生成 / 销毁**的东西：子弹、飘字、掉落物、特效。

| 成员 | 说明 |
|---|---|
| `create(prefabName, capacity?, opts?)` | 建池 → handle（`number`） |
| `acquire(handle, x, y)` | 取一个实例 |
| `release(handle, e)` | 归还一个实例 |
| `stats(handle)` | 统计 `{idle, active, total, capacity}` |

---

### bwe.pool.create(prefabName, capacity?, opts?) → number

**签名**
`bwe.pool.create(prefabName: string, capacity?: number, opts?: { prewarm?: boolean }): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| prefabName | string | 模板名（必须已 define）；不存在返回 `-1` 并写日志 |
| capacity | number | 池上限，默认 8（≤ 0 时按 8） |
| opts.prewarm | boolean | `true` = 立刻预生成 `capacity` 个**隐藏**实例放进空闲队列 |

**返回**
`number` — 池句柄（从 1 开始递增）；失败返回 `-1`

**说明**
✅ 已实现。一个模板可以建多个池（各自独立计数）。
`prewarm` 的实例是 `visible = false` 的，`acquire` 时会自动设为可见 —— 适合「开局就把子弹都建好」，避免战斗中卡顿。

**示例**
```js
// 预生成 32 发子弹，开打时零延迟
var bulletPool = bwe.pool.create("bullet", 32, { prewarm: true });
bwe.log("池句柄 = " + bulletPool);        // -1 表示模板不存在
```

**另见**
[bwe.prefab.define](#bweprefabdefinename-spec--boolean) · [bwe.pool.acquire](#bwepoolacquirehandle-x-y--entity--null) · [bwe.pool.stats](#bwepoolstatshandle--poolstats--null)

---

### bwe.pool.acquire(handle, x, y) → Entity | null

**签名**
`bwe.pool.acquire(handle: number, x: number, y: number): Entity | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| handle | number | `create` 返回的池句柄 |
| x | number | 落点 X（世界像素） |
| y | number | 落点 Y（世界像素） |

**返回**
`Entity | null` — 可用的实例；**池已满且无空闲**时返回 `null`

**说明**
✅ 已实现。取用顺序：
1. 先从空闲队列里捞一个（LIFO，最后归还的最先复用），把位置设到 `(x, y)`、**恢复可见**（`visible = true`）。
2. 没有空闲且 `总数 < capacity` → 现场**新建**一个。
3. 否则返回 `null`（**不会**强行超出上限）。

复用的实例**不会重跑** `onStart`（它一直活着，只是被隐藏了）—— 需要「重新初始化」的逻辑请在取用后自己调。

**示例**
```js
function fire(x, y, tx, ty) {
  var b = bwe.pool.acquire(bulletPool, x, y);
  if (!b) { return; }                 // 池满，跳过这一发
  b.setColor(1, 0.9, 0.4);            // 每次取用都要重设你要的状态
  bwe.physics.throwAt(b, tx, ty, 600);
}

function onUpdate(ctx, dt) {
  if (bwe.input.pressed("Mouse0")) {
    var m = bwe.input.mouse;
    fire(ctx.self.x, ctx.self.y, m.worldX, m.worldY);
  }
}
```

**另见**
[bwe.pool.release](#bwepoolreleasehandle-e--boolean) · [bwe.pool.stats](#bwepoolstatshandle--poolstats--null)

---

### bwe.pool.release(handle, e) → boolean

**签名**
`bwe.pool.release(handle: number, e: Entity): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| handle | number | 池句柄 |
| e | Entity | 要归还的实例 |

**返回**
`boolean` — `true` = 归还成功；`false` = 实体不属于该池 / 已被销毁 / 池句柄无效

**说明**
✅ 已实现。归还做的事：**设为不可见**（`visible = false`）并放回空闲队列。**不销毁**、不重跑生命周期、不重置你的 props / 颜色（下次取用时需要你自己重置）。
重复归还是安全的（已在空闲队列里就不再加）。

**示例**
```js
// 子弹飞出地图 → 归还
function onUpdate(ctx, dt) {
  var s = bwe.world.scene;
  if (ctx.self.x < 0 || ctx.self.y < 0 || ctx.self.x > s.width || ctx.self.y > s.height) {
    bwe.pool.release(bulletPool, ctx.self);
  }
}
```

**另见**
[bwe.pool.acquire](#bwepoolacquirehandle-x-y--entity--null) · [e.destroy](entity.md#edestroy--void)

---

### bwe.pool.stats(handle) → PoolStats | null

**签名**
`bwe.pool.stats(handle: number): PoolStats | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| handle | number | 池句柄；无效返回 `null` |

**返回**
`PoolStats` — `{ idle: number, active: number, total: number, capacity: number }`

| 字段 | 说明 |
|---|---|
| `idle` | 空闲（已归还，可复用） |
| `active` | 使用中 |
| `total` | 池里现有实例总数（idle + active） |
| `capacity` | `create` 时给的上限 |

**说明**
✅ 已实现。统计前会先清理掉已销毁的实例记录。

**示例**
```js
var st = bwe.pool.stats(bulletPool);
if (st) {
  bwe.draw.text(8, 8, "子弹 " + st.active + "/" + st.capacity + " 空闲 " + st.idle);
}
```

**另见**
[bwe.pool.create](#bwepoolcreateprefabname-capacity-opts--number) · [bwe.prefab.count](#bweprefabcountname--number)

---

## 三、完整的一局例子

```js
var G = {
  goblinPool: -1,
  spawnTimer: 0
};

function onSceneStart(ctx) {
  // 1) 注册模板
  bwe.prefab.define("goblin", {
    kind: "ACTOR",
    asset: "哥布林",
    halfW: 16, halfH: 16,
    tags: ["敌人"],
    modules: [
      { def: "fight.hp", params: { hp: 30 } },
      { def: "move.wander", params: { speed: 30, area: 100 } }
    ],
    props: { w: 32, h: 32 }
  });

  // 2) 建池，预生成 20 个（全部隐藏）
  G.goblinPool = bwe.pool.create("goblin", 20, { prewarm: true });
  bwe.log("池句柄=" + G.goblinPool);

  // 3) 每 2 秒刷一个，池满就跳过
  bwe.every(2, function () {
    var st = bwe.pool.stats(G.goblinPool);
    if (!st || st.idle <= 0) {
      bwe.log("池满了（" + (st ? st.total : 0) + "），跳过这一波");
      return;
    }
    var e = bwe.pool.acquire(G.goblinPool, bwe.random(64, 1216), bwe.random(64, 896));
    if (e) {
      e.setColor(1, 1, 1, 1);       // 每次取用重置状态（归还不重置）
      bwe.log("刷出 " + e.name);
    }
  });
}

function onSceneEnd(ctx) {
  bwe.log("本局共 " + bwe.prefab.count("goblin") + " 个哥布林实例");
}
```

---

## 四、boot.json 里的预制体

编辑器导出的 `boot.json` 可以带一份 `prefabs[]`：

```json
{
  "prefabs": [
    {
      "name": "goblin",
      "kind": "ACTOR",
      "asset": "哥布林",
      "z": 0,
      "layer": 0,
      "halfW": 16,
      "halfH": 16,
      "scaleX": 1,
      "scaleY": 1,
      "rotation": 0,
      "visible": true,
      "animMode": "默认",
      "animFps": 8,
      "tags": ["敌人"],
      "modules": [{ "def": "fight.hp", "params": { "hp": "30" } }],
      "props": { "w": "32", "h": "32" },
      "script": "goblin",
      "jitter": { "x": 24, "y": 24 }
    }
  ]
}
```

引擎启动时会把它们**逐个预定义**进 `bwe.prefab`（先于你的脚本顶层代码执行），脚本里直接 `bwe.prefab.spawn("goblin")` 即可。
载入成功会写一条日志：`[预制体] 从 boot.json 载入 N 个预制体`。

**字段映射注意**：`JSON` 里的 `modules[].params` 值、`props` 值都是**字符串**（编辑器导出的就是文本），效果与脚本里传数字相同（引擎内部同样存文本）。

---

## 五、`PrefabSpec` 与 `PrefabSpawnOpts` 的类型细节

### 5.1 `size` 与 `halfW/halfH` 的关系

`spec.size = { w, h }` 是**只写便捷写法**：`define` 时若有 `size` 且 `w > 0` / `h > 0`，会换算成 `halfW = w/2` / `halfH = h/2`。
**回读（`get`）时永远以 `halfW/halfH` 为准**，`size` 是反算出来的。所以两者不要同时写（写了以 `size` 为准，因为它后面的处理覆盖 halfW）。

### 5.2 模块的两种写法

```js
// 完整写法
modules: [{ def: "fight.hp", when: "ALWAYS", params: { hp: 30 } }]

// def 也可以写成 id（同一个字段的别名）
modules: [{ id: "fight.hp", params: { hp: 30 } }]
```

`params` 里没有的值不会被填 —— 运行时读参数时会退回模块定义里的默认值。

### 5.3 `children`（子精灵）

```js
children: [
  { asset: "剑",   dx: 16, dy: 0, z: 1, rotation: 30, alpha: 0.9, w: 24, h: 24 },
  { asset: "影子", offsetX: 0, offsetY: 18, alpha: 0.3, w: 28, h: 12 }
]
```

| 字段 | 说明 |
|---|---|
| `asset` | 素材名 |
| `dx` / `dy` | 相对实体中心的像素偏移；`offsetX` / `offsetY` 是**别名** |
| `z` | 排序层级 |
| `rotation` | 旋转（度） |
| `alpha` | 透明度 0~1（默认 1） |
| `w` / `h` | 绘制尺寸（0 = 用素材尺寸的兜底逻辑） |

每个 `children` 项在实例化时等价于对该实例调一次 `e.attach(...)` —— 它们**跟着实例走**，但**不是独立实体**（不能被 `find`、不参与物理、不能有脚本）。
⚠ 没有单独的句柄暴露出来（`prefab.spawn` 只返回 Entity）—— 想事后摘掉某个子精灵，目前只能 `e.destroy()` 或不管它。

---

## 六、性能提示

> 下面这组数字和机制来自本轮渲染优化的实测。

### 6.1 实例多不会多吃显存

同素材的实例**共享同一份 GL 纹理**（按文件绝对路径 / 素材 id 缓存，见 `textureCache`）。所以刷 500 个同素材的预制体实例，纹理还是那 1 份。

### 6.2 合批：怎么刷怪最快

渲染按 **`layer` → `z` → `y`** 排序后逐精灵绘制。**相邻且同纹理、未旋转（`rotation === 0`）** 的精灵会被塞进同一个 `glBegin(GL_QUADS)` 批次。

实测（同场景对比）：
- `glBegin` 调用从 **162 次/帧** 降到 **7 次/帧**
- 帧时间 **-24.5%**
- 像素输出逐位一致（无视觉回归）

### 6.3 ⚠ 性能陷阱：别给同批实例设不同的 `z` / `layer` / `rotation`

这是最容易踩的一条：

| 你做的事 | 后果 |
|---|---|
| 每个 prefab 实例设**不同的 `z`** | 排序后它们不再相邻 → **打断合批** → 每个实例一次 `glBegin` |
| 每个实例设**不同的 `layer`** | 同上（`layer` 比 `z` 优先级更高，分得更多） |
| 每个实例设**非 0 的 `rotation`** | 旋转精灵**必然**走逐精灵路径（浮点一致性优先），不进合批 |
| 同批实例**相同 `z`、相同 `layer`、`rotation = 0`** | ✅ 相邻 + 同纹理 → 合并成少数几个批次 |

**实践建议**：批量刷同种怪时，保持 `z` / `layer` **相同**、`rotation = 0`；靠 `y` 做前后遮挡（`y` 排序本身就参与，且不需要额外层级）。
只有需要视觉分层时才动 `z`，并且尽量让同类对象用**同一个** `z`。

### 6.4 HUD 文字不会泄漏显存

`bwe.draw.text` 的文字纹理缓存是**有界 LRU（上限 256 条）**，超出后淘汰最久未用的并登记给宿主销毁。所以每帧变化的数字（血量 / 计时 / 分数）**不会**无限增长纹理与显存。
即便这样，仍然建议：变化慢的文字别每帧重建、少用超大字号、能用图形代替的别用文字。

---

## 七、边界与已知限制

| 情况 | 行为 |
|---|---|
| `define` 的 `spec` 不是对象 | 返回 `false`，写日志 |
| `spawn` 的模板不存在 | 返回 `null`，写日志 `[预制体] 没有叫「x」的预制体` |
| `create` 的模板不存在 | 返回 `-1`，写日志 |
| `acquire` 池满且无空闲 | 返回 `null`（不强行超上限） |
| `release` 不属于该池的实体 | 返回 `false` |
| 模板热更新 | **不支持**：改 `define` 不影响已生成实例 |
| 嵌套实体层级 | **不支持**：`children` 是子精灵，不是子实体 |
| `jitter` 与 `bwe.seed` | **不联动**：jitter 用 `prefab` 自己的随机源，同种子不可复现散布 |
| `prefab.count` 统计范围 | 只统计 `prefab.*` / `pool.*` 产生的实例 |
| 一帧内大量 `acquire` | 受 `capacity` 限制，超出的直接 `null` —— 池容量要按峰值预估 |

**另见**：[bwe.world.spawn](world.md#bweworldspawnopts--entity--null)（不用模板时的等价能力）· [entity.md](entity.md)（实例拿到的 Entity 的全部能力）
