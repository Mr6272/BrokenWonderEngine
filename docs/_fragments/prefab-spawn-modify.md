# 预制体 / 物体生成 / 物体修改（Unity 风格正文素材）

> 本片段供 `docs/scripting-api.md`（或 Unity 风格手册）编排使用。三章：
> **§A 预制体 Prefab**、**§B 物体生成 Spawn**、**§C 物体修改 Modify**。
>
> 所有示例统一 **ES5**（`var` / `function`），因为脚本最终在 Rhino 1.7.15 里跑。
> 契约同步处：`web/src/js/bwe.d.ts`、`web/src/data/apiDocs.ts`、`src/Studio/runtime/ScriptPrefab.java`、
> `src/Studio/runtime/ScriptApi.java`、自检 `src/Studio/runtime/ScriptPrefabTest.java`。

---

## §A 预制体 Prefab（`bwe.prefab` / `bwe.pool`）

### A.0 它是什么

Unity 里 Prefab 是「存起来的 GameObject 模板」：在编辑器里配一次，运行时 `Instantiate` 出任意多个。
BWE 的 `bwe.prefab` 是**同一心智的运行时版**：

- 一份模板 = 一个纯数据对象（`kind / asset / z / halfW / halfH / tags / modules / props / script / …`）；
- `spawn` 就是 `Instantiate`，可以在模板之上覆盖任意字段；
- 模板来源有两种：**运行期 `define`**，和**把场上对象反向抓成模板 `fromEntity`**；
- 另有 **`bwe.pool`**（对象池），用于高频刷怪/子弹这类「生成—销毁」循环。

**注意 v1 的边界（有意取舍）**：

| 能力 | v1 |
|---|---|
| 运行期 `define` / `spawn` / `fromEntity` | ✅ |
| 从 `boot.json` 的 `prefabs[]` 自动载入（编辑器导出） | ✅ |
| 预制体**热更新**（改模板让已生成实例跟着变） | ❌ **不做**。`define` 之后已生成的实例保持原样，之后 `spawn` 才用新定义 |
| 嵌套 Actor 层级（模板里放模板） | ❌ **不做**。`children` 用引擎既有的「子精灵」实现，不是真正的场景图 |
| 坐标继承（子实体跟着父实体移动） | ❌ **不做**。`e.parent` 只是归属关系，父子各自独立参与物理/绘制/查找 |

### A.1 快速上手

```js
// 1) 定义模板（跑一次，通常放在场景脚本的 onSceneStart 里）
bwe.prefab.define("slime", {
  kind: "ACTOR",
  asset: "slime.png",
  halfW: 12,
  halfH: 12,
  tags: ["enemy", "slime"],
  animFps: 8,
  animMode: "loop",
  props: { lv: 1, speed: 40 },
  modules: [
    { def: "move.patrol", when: "ALWAYS", params: { speed: 40, range: 96 } },
    { def: "combat.health", params: { maxHealth: 30 } }
  ],
  jitter: { x: 6, y: 6 }          // 没给 x/y 时抖 ±6px（见 A.9）
});

// 2) 实例化（给了 x/y 就是精确落位，不会抖）
var a = bwe.prefab.spawn("slime", { x: 320, y: 240 });
var b = bwe.prefab.spawn("slime", { x: 320, y: 240, name: "boss-slime", scaleX: 2, scaleY: 2 });

// 3) 批量
var wave = bwe.prefab.spawnMany("slime", [
  { x: 100, y: 100 }, { x: 140, y: 100 }, { x: 180, y: 100 }
]);
```

### A.2 模板 spec 的完整字段

`bwe.prefab.define(name, spec)` 与 `boot.json` 的 `prefabs[]` **是同一套字段**（导出器直接可 `define`）。

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `name` | `string` | — | 模板名。`define` 时用第一个参数；`boot.json` 里是 `name`，**必填** |
| `kind` | `string` | `"PROP"` | 对象大类：`ACTOR / PROP / TILE / ZONE / SPAWN / PORTAL / LIGHT` |
| `asset` | `string` | `""` | **素材名**（与 `boot.assets[].name`、场景 `objects[].asset` 同一套命名空间） |
| `z` | `number` | `0` | 排序层级，大的盖住小的 |
| `layer` | `number` | `0` | 图层下标（绘制顺序 `layer → z → y`） |
| `halfW` / `halfH` | `number` | `0` | 碰撞体半宽半高；`0` = 不参与碰撞，绘制尺寸走 `sizeOf` 兜底 |
| `size` | `{w, h}` | — | `halfW/halfH` 的便捷写法（`halfW = w/2`）；两者同时给时以 `halfW/halfH` 为准 |
| `scaleX` / `scaleY` | `number` | `1` | 缩放 |
| `rotation` | `number` | `0` | 角度，顺时针，单位度 |
| `visible` | `boolean` | `true` | 是否可见 |
| `animMode` | `string` | `"默认"` | `"默认"` / `"只显示首帧"` / `"单次播放"`；写 `"loop"/"first"/"once"` 会被归一化 |
| `animFps` | `number` | `8` | 每秒帧数 |
| `script` | `string` | `""` | 挂上的**脚本名**（`boot.scripts[].name`，**不是文件路径**） |
| `tags` | `string[]` | `[]` | 初始标签 |
| `modules` | `{def, when?, params?}[]` | `[]` | 初始模块（与场景对象导出的模块同构） |
| `props` | `Record<string, unknown>` | `{}` | 初始对象属性；数值/布尔会归一成编辑器同构文本（`"48"` / `"开"`） |
| `jitter` | `{x, y}` | `{0, 0}` | 随机抖动幅度；**只在 `spawn` 没给 `x/y` 时生效**（语义见 A.9） |
| `x` / `y` | `number` | `0` | 模板自带的基础位置（`spawn` 未给 `x/y` 时用） |
| `children` | `PrefabChildSpec[]` | `[]` | 子精灵列表（见 A.6） |

### A.3 API 一览

| 调用 | 返回 | 说明 |
|---|---|---|
| `bwe.prefab.define(name, spec)` | `boolean` | 注册 / 覆盖模板；`spec` 不是对象时返回 `false` |
| `bwe.prefab.get(name)` | `PrefabSpec \| null` | **深拷贝**快照：改返回值不会影响注册表 |
| `bwe.prefab.list()` | `string[]` | 所有模板名，顺序 = `define` 顺序 |
| `bwe.prefab.has(name)` | `boolean` | 模板是否存在 |
| `bwe.prefab.remove(name)` | `boolean` | 移除模板；**已生成的实例不受影响** |
| `bwe.prefab.spawn(name, opts?)` | `Entity \| null` | 实例化；模板不存在返回 `null` |
| `bwe.prefab.spawnMany(name, optsList?)` | `Entity[]` | 批量实例化（跳过失败项） |
| `bwe.prefab.count(name)` | `number` | 当前**存活**的该预制体实例数 |
| `bwe.prefab.fromEntity(e, name?)` | `string \| null` | 把场上实体抓成模板并注册，返回模板名 |

#### `bwe.prefab.get` 的「深拷贝」语义

```js
var spec = bwe.prefab.get("slime");
spec.tags.push("tampered");
spec.props.lv = 999;
bwe.prefab.get("slime").tags.indexOf("tampered"); // -1，注册表没被改
```

内部每次 `get` 都新建对象与数组，所以这是**真正的深拷贝**，不是引用别名。

#### `bwe.prefab.count` 用来做上限

```js
var MAX_SLIME = 30;
function trySpawnSlime() {
  if (bwe.prefab.count("slime") >= MAX_SLIME) { return null; }
  return bwe.prefab.spawn("slime", { x: bwe.random(0, bwe.world.mapSize().w), y: 64 });
}
```

`count` 只数「由 `spawn`/`spawnMany`/`pool.acquire` 生成、且还没被销毁」的实例，
**不计**通过 `bwe.world.spawn` 手工造出来的对象。

### A.4 覆盖语义（`spawn` 的 opts）

`bwe.prefab.spawn(name, opts)` 的 `opts` 是 `PrefabSpawnOpts`。**只覆盖你给的字段**，其余继承模板。

| 类型 | 字段 | 语义 |
|---|---|---|
| 标量（直接替换） | `x, y, z, layer, rotation, scaleX, scaleY, halfW, halfH, visible, animMode, animFps, asset, script, name, parent` | 有就用 opts 的 |
| 数组（**追加去重**） | `tags` | 模板 tags 在前，opts 追加，重复的丢弃 |
| 数组（**按 def 合并**） | `modules` | 同 `def` → 替换该模块；新 `def` → 追加 |
| 对象（**合并**） | `props` | 与模板合并，同名以 opts 为准 |
| 布尔开关 | `jitter` | `true` = 强制抖；`false` = 不抖；省略见 A.9 |

```js
// 模板 slime 有 tags:["enemy","slime"]、props:{lv:1,speed:40}、modules:[move.patrol]
var a = bwe.prefab.spawn("slime", {
  x: 100, y: 100,
  tags: ["elite"],                    // → ["enemy","slime","elite"]
  props: { lv: 5 },                   // → {lv:5, speed:40}（lv 被覆盖，speed 保留）
  modules: [ { def: "render.shadow" } ] // move.patrol 保留 + render.shadow 追加
});
```

**实例默认名字 = 模板名**（所以 `bwe.world.find("slime")` 能直接找到实例），`opts.name` 可覆盖。

### A.4.1 `jitter` 的触发规则（v1.1 修正，重要）

**结论：给了 `x`/`y` 就精确落位，不抖。**

| `spawn` 的调用形态 | 是否抖 |
|---|---|
| `spawn("slime", { x: 100, y: 120 })` | ❌ **不抖**（精确落在 100,120） |
| `spawn("slime", { x: 100, y: 120, jitter: true })` | ✅ 抖（显式要求，落在模板幅度内） |
| `spawn("slime", { jitter: false })` | ❌ 不抖 |
| `spawn("slime", {})` / `spawn("slime")`（没给 x/y） | ✅ 抖（从模板 `x/y` 起抖） |
| `pool.acquire(handle, x, y)` | ❌ **永不抖**（池内部禁止） |

**为什么这么定**：

- Unity 的 `Instantiate(prefab, position, rotation)` 不会在你给的位置上额外偏移；
  「我给了坐标，结果不是那个坐标」是反直觉的。
- `jitter` 的随机源**不与 `bwe.seed` 联动**，所以只要抖了，结果就**不可复现** ——
  确定性对拍（涌现式模拟的验收手段）会失效。精确落位是不抖的，才能复现。

```js
// 确定性刷怪：位置完全可复现（同脚本同帧序 ⇒ 同结果）
var e = bwe.prefab.spawn("slime", { x: 320, y: 240 });

// 随机撒怪：不指定位置（或显式 jitter: true）
var r = bwe.prefab.spawn("slime", {});                  // 从模板位置抖
var r2 = bwe.prefab.spawn("slime", { x: 320, y: 240, jitter: true });  // 强制抖
```

### A.5 从场上对象反向抓模板（`fromEntity`）

编辑器里「把场景对象拖成预制体」的运行时版：

```js
var boss = bwe.world.find("boss");
var name = bwe.prefab.fromEntity(boss, "boss-prefab");
// name === "boss-prefab"

// 抓出来的模板包含：kind / asset / z / layer / halfW / halfH / scale / rotation / visible /
// animMode / animFps / tags / props / modules / script / 以及当时挂着的子精灵（children）
bwe.prefab.spawn("boss-prefab", { x: 600, y: 400 });
```

- 第二个参数省略时用实体的 `name`；`name` 也为空则自动生成 `prefab-1`、`prefab-2`…
- `fromEntity` **会注册**（同名覆盖），返回值是最终模板名。
- 实体的 `script.js` 模块会被解析成模板的 `script` 字段（不会重复挂两次）。

### A.6 子精灵（`children`）

`children` 用引擎既有的「子精灵」（`e.attach`）实现，**不是嵌套 Actor**：

```js
bwe.prefab.define("soldier", {
  kind: "ACTOR", asset: "soldier.png", halfW: 14, halfH: 20,
  children: [
    { asset: "sword.png", dx: 16, dy: -2, z: 1, rotation: 0 },
    { asset: "shadow.png", dx: 0, dy: 22, alpha: 0.35 }
  ]
});
```

字段：`asset`（必填）、`dx/dy`（像素偏移，别名 `offsetX/offsetY`）、`z`、`rotation`、`alpha`、`w`、`h`。

> **`e.attach()` 返回的是「对象句柄」`{id, remove()}`，不是数字。**
> `e.detach()` 既接受这个对象，也接受它的 `id`：
> ```js
> var h = e.attach({ asset: "sword.png", dx: 16 });
> h.id;        // number
> h.remove();  // 立刻摘掉（等价 e.detach(h)）
> e.detach(h.id);  // 也可以直接传 id
> ```

子精灵跟随实体绘制，**跟随父实体的 `visible` / 位置**；不参与物理与查找。

### A.7 对象池 `bwe.pool`

高频「生成 → 销毁」循环（子弹、粒子、刷怪波）用池避免反复分配：

```js
// 建池（capacity = 上限；prewarm = 立刻预生成隐藏实例，适合进场景时一次性准备）
var bullets = bwe.pool.create("bullet", 64, { prewarm: true });

// 取一个：优先复用空闲实例，池满返回 null
var b = bwe.pool.acquire(bullets, player.x, player.y);
if (b) { b.setProp("vx", 600); }

// 归还：实例变 visible=false 并留在池里等下次复用
bwe.pool.release(bullets, b);

// 统计
var s = bwe.pool.stats(bullets);   // {idle, active, total, capacity}
```

| 调用 | 返回 | 说明 |
|---|---|---|
| `bwe.pool.create(prefabName, capacity?, opts?)` | `number` | 池句柄；预制体不存在返回 **-1**；`opts.prewarm` 预生成隐藏实例 |
| `bwe.pool.acquire(handle, x, y)` | `Entity \| null` | 优先复用空闲实例（落位到 x/y 并 visible=true）；池满返回 `null` |
| `bwe.pool.release(handle, e)` | `boolean` | 归还；实体不属于该池 / 已销毁 → `false` |
| `bwe.pool.stats(handle)` | `{idle, active, total, capacity} \| null` | 句柄无效返回 `null` |

**语义细节**：

- `acquire` 复用时会重置 `x/y/visible`；**不重置** props/tags/模块（脚本里自己清）。
- `release` 只是 `visible = false`，实体仍在 `world.entities()` 里（池实例不是销毁）。
- 池实例被 `destroy()` 掉时，池会自动丢弃引用（下次 `acquire` 不会给你个死对象）。
- `capacity` 是「池里最多缓存多少个实例」，不是「世界上一共能有多少个」——`acquire` 拿出的实例不算在容量里时，会新建到 `total >= capacity` 为止。

### A.8 从 `boot.json` 载入（编辑器导出链路）

编辑器导出 `boot.json` 时可以带顶层 `prefabs[]`，运行时启动时逐个 `define`：

```json
{
  "prefabs": [
    {
      "name": "小怪",
      "kind": "ACTOR",
      "asset": "goblin.png",
      "z": 0,
      "layer": 0,
      "halfW": 0,
      "halfH": 0,
      "tags": ["enemy"],
      "modules": [{ "def": "move.patrol", "when": "ALWAYS", "params": { "speed": "40" } }],
      "props": {},
      "script": "mob",
      "animMode": "默认",
      "animFps": 8,
      "scaleX": 1,
      "scaleY": 1,
      "rotation": 0,
      "jitter": { "x": 0, "y": 0 }
    }
  ]
}
```

- **向后兼容**：`boot.json` 没有 `prefabs` 字段时按空数组处理（老工程照样跑）。
- `asset` 是素材名、`script` 是脚本**名**（`boot.scripts[].name`）——两者都**不要**写成文件路径。
- boot 里的模板与运行期 `define` 等价：`bwe.prefab.get("小怪")` 能读到，`spawn` 能直接实例化。

---

## §B 物体生成 Spawn（`bwe.world`）

### B.1 `bwe.world.spawn(opts)` 的完整字段

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `x` / `y` | `number` | `0` | 世界像素坐标（**对象中心点**，Y 轴向下） |
| `asset` | `string` | `""` | 素材名 |
| `name` | `string` | `""` | 对象名（用于 `find`） |
| `kind` | `string` | `"PROP"` | 对象大类 |
| `z` | `number` | `0` | 排序层级 |
| `layer` | `number` | `0` | 图层下标 |
| `halfW` / `halfH` | `number` | `0` | 碰撞体半宽半高 |
| `scaleX` / `scaleY` | `number` | `1` | 缩放 |
| `rotation` | `number` | `0` | 角度（度，顺时针） |
| `visible` | `boolean` | `true` | 是否可见 |
| `animMode` | `string` | `"默认"` | 动画模式（归一化规则同模板） |
| `animFps` | `number` | `8` | 每秒帧数 |
| `script` | `string` | `""` | 脚本名 |
| `tags` | `string[]` | `[]` | 初始标签 |
| `modules` | `{def, when?, params?}[]` | `[]` | 初始模块 |
| `props` | `Record<string, unknown>` | `{}` | 初始属性 |
| `parent` | `Entity \| null` | `null` | 父实体 |

**`bwe.prefab.spawn` 与 `bwe.world.spawn` 走同一条生成路径**，所以字段语义、`sizeOf` 兜底、
模块绑定、标签、脚本 `onStart` 派发全部一致。区别只有：`prefab.spawn` 先套模板再套覆盖。

### B.2 API 一览

| 调用 | 返回 | 说明 |
|---|---|---|
| `bwe.world.spawn(opts)` | `Entity` | 生成一个实体 |
| `bwe.world.spawnMany(list)` | `Entity[]` | 批量生成（每个元素一份 opts） |
| `bwe.world.spawnAt(opts, x, y)` | `Entity` | 便捷式：生成并**强制**指定 x/y（覆盖 opts 里的） |
| `bwe.world.clone(e, opts?)` | `Entity \| null` | 复制实体（tags/模块/props/子精灵一并带上） |
| `bwe.world.destroy(e)` | `void` | 销毁（派发 `onDestroy` / `"destroy"`） |
| `bwe.world.clear()` | `void` | 销毁**所有**实体（含场景原生对象） |
| `bwe.world.clearTag(tag)` | `void` | 只销毁带该标签的实体 |
| `bwe.world.destroyAll(filter?)` | `number` | 批量销毁；`filter` 省略 = 全部。返回**实际销毁数** |
| `bwe.world.count(q?)` | `number` | 无参 = 存活实体总数；有参 = 匹配数 |
| `bwe.world.each(q, fn)` | `void` | 遍历（`q` 传 `null`/省略 = 全部） |

### B.3 `spawnMany` 与 `spawnAt`

```js
// 一次造一排怪
var row = bwe.world.spawnMany([
  { x: 100, y: 200, asset: "goblin.png", tags: ["enemy"] },
  { x: 140, y: 200, asset: "goblin.png", tags: ["enemy"] },
  { x: 180, y: 200, asset: "goblin.png", tags: ["enemy"] }
]);

// spawnAt：把坐标单独拎出来（适合在循环里根据格子算位置）
for (var cx = 0; cx < 5; cx++) {
  var p = bwe.grid.toWorld(cx, 3);
  bwe.world.spawnAt({ asset: "tower.png", kind: "PROP" }, p.x, p.y);
}
```

### B.4 `clone`

```js
var proto = bwe.world.find("crate");
var copy = bwe.world.clone(proto, { x: proto.x + 64, name: "crate-copy" });
```

- `clone` 内部走 `prefab.capture` → `prefab.spawnFromSpec`，所以**模板能表达的字段都能复制**：
  `kind / asset / z / layer / halfW / halfH / scale / rotation / visible / animMode / animFps /
  tags / props / modules / script`，以及**当时挂着的子精灵**。
- `opts` 可覆盖任意字段（含 `name`）。
- **注意**：`hp/hpMax` 这类运行时状态**不在模板里**，`clone` 出来的是满血（按模块参数初始化）。

### B.5 批量销毁的三个层次

```js
bwe.world.clearTag("bullet");        // 只清子弹，保留场景和玩家
bwe.world.destroyAll({ kind: "PROP" });  // 按查询条件清（返回删除数）
bwe.world.clear();                   // 清场全部（换关、重开一局时用）
```

**重要**：`clear()` 会连**场景原生对象**一起删（包括玩家）。只想清自己生成的东西，
请用标签或 `kind` 区分——这也是为什么生成时建议打标签。

### B.6 `count` 与 `each`

```js
// count：无参 = 存活总数
var alive = bwe.world.count();
var enemies = bwe.world.count({ tag: "enemy" });
var props = bwe.world.count({ kind: "PROP" });

// each：内部先拍快照，回调里 spawn / destroy 都安全
bwe.world.each({ tag: "enemy" }, function (e) {
  if (e.hp < e.hpMax * 0.3) { e.addTag("fleeing"); }
});

// 回调里销毁也不会漏项或崩（遍历的是快照，且跳过已死项）
bwe.world.each({ tag: "bullet" }, function (e) { e.destroy(); });
```

`each` 相对 `findAll` 的优势：**不建中间数组**（大地图/几百实体时更省），且回调内可安全改世界。

---

## §C 物体修改 Modify（`Entity`）

### C.1 先看 Entity 的完整字段表

**位置与变换**

| 成员 | 读写 | 说明 |
|---|---|---|
| `e.id` | 只读 | 唯一 id |
| `e.name` | 读写 | 对象名（`find` 用） |
| `e.kind` | 读写 | 对象大类 |
| `e.x` / `e.y` | 读写 | 世界像素坐标（中心点）；写会同步 `baseX/baseY`（AI 巡逻基准点） |
| `e.z` | 读写 | 排序层级 |
| `e.layer` | 读写 | 图层下标（绘制顺序 `layer → z → y`） |
| `e.rotation` | 读写 | 角度（度，顺时针） |
| `e.scaleX` / `e.scaleY` | 读写 | 缩放 |
| `e.visible` | 读写 | 显示 / 隐藏 |
| `e.locked` | 读写 | 锁定标记（**运行时只记忆，不影响行为**；为与编辑器接口一致而保留） |
| `e.alive` | 只读 | 是否还活着 |
| `e.pos` | 只读 | `{x, y}` 快照 |
| `e.setPos(x, y)` | — | 设置位置 |

**尺寸**

| 成员 | 读写 | 说明 |
|---|---|---|
| `e.size` | **读写** | `{w, h}`；读走 `sizeOf` 规则（与编辑器一致），写等价 `setSize` |
| `e.setSize(w, h)` | — | 设置尺寸（写 `halfW = w/2`、`halfH = h/2`） |

**外观**

| 成员 | 读写 | 说明 |
|---|---|---|
| `e.asset` | **读写** | 当前**素材名**；写入会同时生效到渲染（换图）与 `assetName` 查询，但**不改播放参数**（`animMode`/`animFps` 保持） |
| `e.animMode` | 读写 | `"默认"` / `"只显示首帧"` / `"单次播放"`（写 `"loop"/"first"/"once"` 也认） |
| `e.animFps` | 读写 | 每秒帧数；**写会解除 `setFrame` 的帧锁定** |
| `e.sprite({asset, frame?, fps?, mode?})` | — | 换精灵**并**设播放参数（`mode: "loop"\|"once"\|"first"`） |
| `e.play(assetName)` | — | 直接换素材（沿用当前播放参数），并恢复 `"默认"` 模式 |
| `e.setFrame(i)` | — | 冻结到第 `i` 帧（0 起）；会把 `animFps` 钉成 1 |
| `e.setColor(r, g, b, a?)` | — | **染色**（见 C.4） |
| `e.setAlpha(a)` | — | 只改透明度 |
| `e.clearColor()` | — | 清除染色 |
| `e.color` | 只读 | `{r, g, b, a}` 当前染色 |

**标签**

| 成员 | 说明 |
|---|---|
| `e.tags` | 标签集合（数组，且带 `.has(t)` / `.includes(t)`） |
| `e.addTag(t)` / `e.removeTag(t)` | 加 / 删单个标签 |
| `e.hasTag(t)` | 是否有该标签 |
| `e.setTags(arr)` | **整体替换** |

**属性与模块**

| 成员 | 说明 |
|---|---|
| `e.prop(key, def?)` | 读一个属性（与编辑器 `props` 打通） |
| `e.setProp(key, val)` | 写一个属性（会影响下一帧绘制尺寸，规则同 `sizeOf`） |
| `e.props()` | **全部属性**快照（`Record<string, string>`） |
| `e.setProps(obj)` | **批量写**属性 |
| `e.hasModule(def)` | 有没有挂这个模块 |
| `e.module(def)` | 取模块实例 `{enabled, get(k, def?), set(k, v)}` |
| `e.modules()` | 全部模块实例 |
| `e.addModule(def, params?, when?)` | 追加模块；**同 def 已存在时合并参数**（加 `combat.health` 会立刻重算 `hpMax`/`hp`） |
| `e.removeModule(def)` | 移除模块。**移除 `combat.health` 不重置当前 `hp`/`hpMax`**（见 C.5.1） |

**父子关系**

| 成员 | 说明 |
|---|---|
| `e.parent` | 读写；`Entity \| null`，设 `null` 解除 |
| `e.children()` | 直接子级 `Entity[]`（只读快照） |

**子精灵 / 事件 / 战斗 / 查询**

| 成员 | 说明 |
|---|---|
| `e.attach({asset, dx?, dy?, z?, rotation?, alpha?, w?, h?})` | 挂一个子精灵，返回**对象句柄** `{id, remove()}` |
| `e.detach(handle)` | 摘掉子精灵 |
| `e.on("click"\|"enter"\|"leave"\|"damage"\|"death", fn)` | 注册实体事件 |
| `e.hp` / `e.hpMax` | 生命值 |
| `e.damage(n)` / `e.heal(n)` | 扣血 / 回血 |
| `e.distanceTo(other)` / `e.angleTo(other)` | 到另一个实体的距离 / 角度 |
| `e.destroy()` | 销毁自己 |

### C.2 尺寸的读写语义（最容易踩）

`e.size` 的**读**不是「直接读 halfW*2」，而是走 `sizeOf` 兜底链：

```
1) halfW 或 halfH 任一 > 0  → 两方向各自取值（缺的一边 16），最小 4，不乘 scale
2) props.w 与 props.h 都 > 0 → 用 props 尺寸，乘 scale
3) 素材像素尺寸（ATLAS 用 cellW/cellH）→ 乘 scale
4) 兜底：scene.tileSize → 乘 scale
```

所以：

```js
var e = bwe.world.spawn({ x: 10, y: 10, asset: "crate.png" });
e.size.w;                 // 素材宽度（A.2 第 3 条）

e.size = { w: 48, h: 64 }; // 等价 setSize(48, 64) → halfW=24, halfH=32
e.size.w;                 // 48

e.setSize(10, 12);
e.size;                   // {w:10, h:12}（走第 1 条：halfW/halfH 有值）
```

**注意**：一旦写过 `size` / `setSize`，对象就进入「第 1 条」分支，之后 `props.w/h` 和
素材尺寸都不再影响绘制大小（除非把 `halfW/halfH` 清成 0）。

### C.3 标签与属性的整体操作

```js
// 标签
e.addTag("frozen");
e.hasTag("frozen");        // true
e.removeTag("frozen");     // true（原本没有则 false）
e.setTags(["only", "these"]);   // 整体替换，原来的标签全丢

// 属性
e.setProp("w", 48);
e.prop("w", 0);            // 48（按 def 的类型做转换）
e.props();                 // {"w":"48","h":"64", …}
e.setProps({ w: 40, h: 20, flag: true });  // 批量写；布尔会归一成 "开"/"关"
```

`props` 的值内部统一存**字符串**（与编辑器同一份数据），读写时按 `def` 的类型转换：

```js
e.prop("n", 0)        // def 是 number → 返回 number
e.prop("b", false)    // def 是 boolean → 返回 boolean（"开"/"true"/"1" 都算真）
e.prop("s", "")       // 其余 → 返回字符串
```

### C.4 染色（`setColor` / `setAlpha`）

**真的出像素**：渲染侧用 GL 调制（乘法）实现，不走「近似半透明」之类的假色。

```js
e.setColor(1, 0, 0);            // 受击闪红（a 默认 1）
e.setColor(0.2, 0.4, 1, 0.5);   // 半透明蓝
e.setAlpha(0.25);               // 只改透明度（保留当前 rgb）
e.clearColor();                 // 恢复原样
e.color;                        // {r:1, g:0, b:0, a:0.25}
```

**通道标度**：每个通道接受 `0~1`；**任一通道 > 1 时整组按 `0~255` 解释**：

```js
e.setColor(255, 128, 0);        // 等价 setColor(1, 0.502, 0)
e.setAlpha(128);                // 等价 setAlpha(0.502)
```

**与 blink 模块的关系**：`look.blink` / `render.blink` 模块也是改 alpha，
两者**相乘**，不冲突：

```js
// 最终 alpha = 实体染色 alpha × blink 抖动 alpha × 该帧基础 alpha
```

**染色参与合批**：同预制体、不同颜色的实例仍然会被合进同一批（每个 quad 单独设色），
所以「受击闪红」这种大量实例同时染色的场景不会打断渲染批处理。

### C.5 模块的增删

```js
// 追加新模块
e.addModule("render.shadow", { size: 3 });

// 同 def 已存在 → 合并参数（不会新建第二个）
e.addModule("move.patrol", { speed: 99 });
e.module("move.patrol").get("speed", 0);   // 99

// 移除
e.removeModule("render.shadow");   // true
e.hasModule("render.shadow");      // false
```

**注意**：`addModule` 对**脚本模块**（`script.js`）不做特殊处理——
脚本绑定请走 `spawn({script})` 或 `prefab` 的 `script` 字段（那才会真正绑定并派发 `onStart`）。

### C.5.1 血量模块的增删语义

`combat.health`（旧 id `fight.hp`）是唯一**有副作用**的模块：它决定 `hpMax`。

```js
var e = bwe.world.spawn({ x: 0, y: 0 });
e.hpMax;                                    // 10（无模块时的默认值）

e.addModule("combat.health", { maxHealth: 40 });
e.hpMax;                                    // 40 —— 加/改模块会**立刻重算**
e.hp;                                       // 40 —— 同时重置为满血

e.addModule("combat.health", { maxHealth: 60 });
e.hpMax;                                    // 60（再次重算）
```

**移除不重置**：

```js
e.hp = 55;                                  // 残血
e.removeModule("combat.health");            // true
e.hpMax;                                    // 仍是 60
e.hp;                                       // 仍是 55
```

> **`e.removeModule("combat.health")` 只是「不再跟模块参数联动」，不会重置当前 `hp`/`hpMax`。**
> 理由：运行时抽掉血模块不应该把一个满血 boss 打回 10 血（破坏性行为）。
> 想让实体回到默认血量，**显式设** `e.hp` / `e.hpMax`。

这条语义与「场景对象」完全一致：场景对象也是在生成时读一次模块参数初始化血量。


### C.6 父子关系（不是场景图）

```js
var hand = bwe.world.spawn({ x: 0, y: 0, asset: "hand.png" });
hand.parent = player;              // 归属
player.children();                 // [hand]

hand.parent = null;                // 解除
player.children();                 // []
```

**v1 的语义边界**（重要）：

- 父子各自仍是**独立 Actor**：参与物理、参与绘制排序、能被 `find` 找到；
- **没有坐标继承**：父实体移动时子实体**不会**跟着移动（脚本里自己同步）；
- 父实体被销毁时，子实体**自动脱钩**（`parent` 变 `null`），但**不会被级联销毁**（避免意外连锁）；
- 防环：不能把祖先设成自己的子级（会被忽略）。

要做「部件跟随」，用 `e.attach()`（子精灵，绘制层面跟随）而不是 `parent`：

```js
// 手上的武器：跟随绘制（推荐）
var handle = player.attach({ asset: "sword.png", dx: 18, dy: -4 });

// 需要独立逻辑的对象（会被单独查找/物理），用 parent 记录归属，但位置自己同步
var pet = bwe.world.spawn({ x: player.x, y: player.y, asset: "pet.png" });
pet.parent = player;
```

### C.7 完整示例：刷怪波 + 受击闪红 + 死亡回收

```js
var wavePool;
var waveAlive = [];

function onSceneStart(ctx) {
  bwe.prefab.define("grunt", {
    kind: "ACTOR", asset: "goblin.png", halfW: 12, halfH: 12,
    tags: ["enemy"], animFps: 8,
    props: { lv: 1 },
    modules: [{ def: "combat.health", params: { maxHealth: 30 } }]
  });
  wavePool = bwe.pool.create("grunt", 32, { prewarm: true });
  bwe.every(2, spawnWave);
}

function spawnWave() {
  var i;
  for (i = 0; i < 5; i++) {
    var e = bwe.pool.acquire(wavePool, 80 + i * 48, 64);
    if (!e) { return; }                  // 池满
    e.setTags(["enemy", "wave"]);
    e.hp = e.hpMax;
    e.on("damage", function () {
      var self = this;                   // 事件回调里 this 是实体
      self.setColor(1, 0, 0);
      bwe.after(0.12, function () { self.clearColor(); });
    });
    waveAlive.push(e);
  }
}

function onUpdate(ctx, dt) {
  var i = waveAlive.length - 1;
  for (; i >= 0; i--) {
    var e = waveAlive[i];
    if (!e.alive || e.hp <= 0) {
      bwe.pool.release(wavePool, e);     // 归还池，不销毁
      waveAlive.splice(i, 1);
    }
  }
}
```

---

## §F 性能提示（预制体 / 批量生成）

渲染侧本轮做了三项优化，**预制体的性能表现直接吃这些红利**，写批量的脚本时值得知道：

### F.1 纹理按文件路径共享 → 实例越多越省显存

同一张图无论被多少个对象引用，**显存里只有一份 GL 纹理**。
所以 `bwe.prefab.spawnMany("slime", ...)` 造 100 个实例，不会上传 100 份 `slime.png`。
（旧的实现是每个 Actor 各传一份，151 面墙 = 151 个纹理。）

**推论**：预制体实例数不是显存瓶颈；**素材种类**才是。批量生成优先复用同几个预制体。

### F.2 同纹理 + 相邻 + 未旋转 → 合批

`glBegin` 次数从 **162/帧 → 7/帧**、帧时间 **2.452ms → 1.452ms**，像素逐像素一致（diffPixels=0）。

合批条件（三个都满足才合）：

1. 同一张纹理（同 `asset`）
2. 按 `layer → z → y` 排序后**相邻**
3. **未旋转**（`rotation == 0`）

**最关键的一条推论——写进性能提示**：

> **prefab 实例的 `z` / `layer` 如果每个实例都不同，会打断合批。**

```js
// ❌ 打断合批：每个实例的 z 都不同，排序后同纹理的不相邻
for (var i = 0; i < 100; i++) {
  bwe.prefab.spawn("slime", { x: i * 40, y: 200, z: i });
}

// ✅ 能合批：同 z（靠 y 排序），同纹理的相邻
for (var i = 0; i < 100; i++) {
  bwe.prefab.spawn("slime", { x: i * 40, y: 200, z: 0 });
}
```

同理：**大量实例各自旋转**（`rotation` 各不相同）也不合批。
如果只是「朝向左右」，用 `scaleX = -1` 翻转比 `rotation = 180` 便宜。

### F.3 染色参与合批

`setColor` 走 `glColor4f`，**每个 quad 单独设色**，所以：

> **同一预制体、不同颜色的实例仍然能合进同一批。**

「受击闪红」「选中高亮」「半透明化」这类大量实例同时染色的场景，**不会打断批处理**。

### F.4 排序是「按需重排」

引擎按「数量或 y 总和是否变化」决定要不要重排，静止场景不产生每帧排序开销。
但**大量实例每帧移动**会触发重排 —— 这是正常的，不必为了避免它而牺牲玩法。

### F.5 对象池 vs 反复 spawn/destroy

高频循环（子弹、粒子、刷怪波）用 `bwe.pool`：

| 方式 | 每帧成本 |
|---|---|
| `spawn` + `destroy` | 分配 Actor、加载帧数据、绑模块、派发 `onStart/onDestroy` |
| `pool.acquire` + `release` | 改 `x/y/visible`（复用已有 Actor） |

差别在**分配与生命周期派发**上，实例数量越大越明显。经验阈值：**每秒生成/销毁超过几十个**就该上池。

---

## §D 与既有契约的差异说明（给文档编排者的备注）

这些是 Java 实现时**按实际行为定下来**、可能与旧版 `docs/scripting-api.md` / `bwe.d.ts` 略有出入的点：

1. **`e.size` 变成可写**：旧文档只写了 `readonly size` + `setSize`。现在 `e.size = {w,h}` 也可写，
   等价 `setSize`。`bwe.d.ts` 已相应去掉 `readonly`。
2. **`e.asset` 是「素材名」，写入会同步 `assetName`**：宿主的 `applyAsset()` 只换纹理不改名字，
   否则 `e.asset` 读回还是旧名（round-trip 会假通过）。实现里已同步：**写入同时生效到渲染（换图）
   与 `a.o.assetName` 查询**，但**不改 `animMode`/`animFps`**（要一起改请用 `e.sprite({...})`）。
3. **`e.locked` 只记忆不生效**：宿主 `Actor` 没有该字段，为接口一致性保留（运行时锁定无意义）。
4. **`e.animFps` 写入会解除 `setFrame` 的帧锁定**：否则 `setFrame` 之后改 fps 看起来没效果。
5. **`prefab` 实例默认名字 = 模板名**（不是空字符串），便于 `world.find`。
6. **`spawn` 的 `kind` 缺省是 `"PROP"`**（旧文档里 `d.ts` 注释写的是 `ACTOR`，以实现为准）。
7. **`prefab` 不做热更新**；`children` 是子精灵不是嵌套 Actor；`jitter` 随机源不与 `bwe.seed` 联动。
8. **`world.clear()` 连场景原生对象一起删**（包括玩家）——文档里要显著标注。
9. **`jitter` 默认不生效（v1.1 修正）**：早期实现是「`spawn` 永远抖」，端到端验证发现
   `spawn(name, {x:100, y:120})` 出来是 `99,118` —— 显式给了位置却不精确，且让确定性对拍失效。
   现在改为「**给了 `x`/`y` 就精确落位；`opts.jitter = true` 才强制抖；不给位置时才抖**」。
   详见 §A.4.1。
10. **血量模块（`combat.health`）在脚本 spawn 路径上也生效（v1.1 修正）**：
    早期宿主 `spawnScripted` 只建 Actor（`hpMax` 默认 10），而场景对象走的是另一段读取逻辑，
    导致 prefab 模板里 `combat.health{maxHealth:40}` 的实例出来是 `hpMax=10`。
    现在 `ScriptEngine.spawnScripted` 与 `e.addModule("combat.health", ...)` 都会调
    `applyHealthModule`，语义与场景对象一致。
11. **`AttachHandle` 是对象不是数字（v1.1 修正）**：`bwe.d.ts` 早期声明成 `type AttachHandle = number`，
    但 `e.attach()` 实际返回 `{id, remove()}` 对象。照数字去写 `.remove()` 会报错。
    现已改成 `interface AttachHandle { readonly id: number; remove(): void }`，
    且 `e.detach()` 的签名放宽为 `AttachHandle | number`（两种都接受，与实现一致）。
    顺带补了 `AttachOpts` 里实现早已支持、但 d.ts 漏掉的 `alpha` / `w` / `h` 三个字段。
12. **`e.removeModule("combat.health")` 不重置血量（v1.1 确认）**：只解除「跟模块参数联动」，
    当前 `hp`/`hpMax` 保持原值。原理由：运行时抽掉血模块不该把满血 boss 打回 10 血。
    要让实体回默认血量请显式设 `e.hp` / `e.hpMax`。详见 §C.5.1。

## E. 自检

新增独立自检类 `src/Studio/runtime/ScriptPrefabTest.java`（headless）：

```powershell
cd D:\githubdesktop\BrokenWonderEngine
$jdk='C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot'
& "$jdk\bin\java.exe" -cp ".tmp_rel8\classes-api;lib/*" Studio.runtime.ScriptPrefabTest
```

覆盖 **97 项**断言：prefab `define/get/list/has/remove/spawn/spawnMany/fromEntity/count`、
pool `create/acquire/release/stats`、world `spawnMany/spawnAt/clone/clear/clearTag/destroyAll/count/each`、
`spawn(opts)` 的全部新字段、Entity 每个新 setter 与 getter 的 round-trip、
`addTag/removeTag/hasTag/setTags`、`addModule/removeModule`、`parent/children`、
`setColor/setAlpha/clearColor`、`boot.json` 的 `prefabs[]` 载入、
以及 **jitter 触发规则**（给了 x/y 精确落位 / 20 次反复生成位置一致 / 显式 jitter 才抖 / 池不抖）
与 **血量模块**（运行时 `addModule("combat.health")` 立刻重算 / prefab 模板血量生效）。

既有 4 个自检必须保持全绿：`ScriptSelfTest 109` / `ScriptFieldsTest 43` / `ScriptPhysicsTest 47` / `ScriptAiTest 51`。
