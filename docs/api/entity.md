# Entity — 实体（世界对象）

> 本页覆盖：`Entity` 的全部属性与方法 —— 身份、变换、图层与动画、尺寸、精灵、模块、属性（props）、标签、父子关系、染色、子精灵、事件、血量与伤害。
>
> 相关页：[world：实体查找与生成](world.md) · [prefab：预制体与对象池](prefab.md) · [lifecycle：生命周期与 ctx](lifecycle.md) · [modules：可视化模块目录](modules.md) · [README：索引](README.md)

**怎么拿到 Entity**：`ctx.self`（对象脚本里）、`bwe.world.find(q)`、`bwe.world.spawn(opts)`、`bwe.world.findAll(q)[i]`、`bwe.prefab.spawn(name)`、`bwe.pool.acquire(handle, x, y)`。

**同一个 Actor 永远返回同一个 JS 对象** —— 所以 `e1 === e2` 可用作身份判断（缓存友好）。实体被销毁后包装对象不会复用。

**坐标约定**：世界像素、`(x, y)` 是**中心点**、**Y 轴向下**。角度单位是**度**、**顺时针**为正（0 = 向右）。

**Phase 说明**：`✅ 已实现` / `🧪 试验` / `📋 规划`。

---

## 一、身份

### e.id → string

**签名**
`e.id: string`（**只读**）

**参数**
无

**返回**
`string`

**说明**
✅ 已实现。场景原生对象的 id 来自场景文件；脚本生成的实体是 `"js-<递增序号>"`。全局唯一，可传给 `bwe.world.find({ id: "..." })`。

**示例**
```js
bwe.log("我的 id 是 " + ctx.self.id);
var same = bwe.world.find({ id: ctx.self.id });
```

**另见**
[e.name](#ename--string) · [bwe.world.find](world.md#bweworldfindq--entity--null)

---

### e.name → string

**签名**
`e.name: string`（可读写）

**参数**
写入：`string`

**返回**
读取：`string`

**说明**
✅ 已实现。写 `e.name` 立刻生效，之后 `bwe.world.find("新名字")` 就能找到它。
`bwe.prefab.spawn(name)` 生成的实例**默认就用模板名做 `name`** —— 所以 `bwe.world.find("goblin")` 能找到该模板的所有实例（详见 [prefab.md](prefab.md#bweprefabspawnname-opts--entity--null)）。

**示例**
```js
ctx.self.name = "受伤的哥布林";
bwe.log(bwe.world.find("受伤的哥布林").id);
```

**另见**
[e.id](#eid--string) · [bwe.world.find](world.md#bweworldfindq--entity--null)

---

### e.kind → string

**签名**
`e.kind: string`（可读写）

**参数**
写入：`string`，常见值 `ACTOR` / `PROP` / `TILE` / `ZONE` / `SPAWN` / `PORTAL` / `LIGHT`

**返回**
读取：`string`（大写）

**说明**
✅ 已实现。`kind` 决定引擎对它的处理方式，**不只是标签**：

| kind | 引擎行为 |
|---|---|
| `TILE` | 生成时自动写入瓦片地图并标记为**阻挡**（`bwe.tilemap.solid` 为 true）；兜底色块是青绿色 |
| `ZONE` | 每帧检查玩家是否进入其矩形，派发 `onEnter` / `onLeave` |
| `LIGHT` | 只在「没有贴图」时的兜底色块颜色上用（暖黄色）；**没有光照/发光渲染** |
| `ACTOR` | 玩家识别（无标签时取第一个 ACTOR）；兜底色块是蓝色 |
| 其它（含 `PROP`） | 当作普通对象 |

⚠ 中途改 `kind` 不会重跑该类型的初始化逻辑（例如把 `PROP` 改成 `TILE` 不会自动写进瓦片地图）。

**示例**
```js
if (ctx.self.kind === "ZONE") {
  bwe.log("我是一块触发区");
}
```

**另见**
[bwe.world.find](world.md#bweworldfindq--entity--null) · [bwe.tilemap.solid](map-nav-interact-spawner.md#bwetilemapsolidcx-cy--boolean)

---

### e.alive → boolean

**签名**
`e.alive: boolean`（**只读**）

**参数**
无

**返回**
`boolean`

**说明**
✅ 已实现。`false` 表示已被销毁 / 已死亡标记。销毁后**包装对象还在**（你的变量仍然持有它），但所有行为都变成安全空操作：读取属性还能拿到最后的值，写入 / 方法调用基本无效。

**示例**
```js
var target = bwe.world.find("敌人");
if (target && target.alive) {
  target.damage(10);
}
```

**另见**
[e.destroy](#edestroy--void) · [bwe.world.destroy](world.md#bweworlddestroye--void)

---

## 二、位置与变换

### e.x / e.y → number

**签名**
`e.x: number`、`e.y: number`（可读写）

**参数**
写入：`number`（世界像素，中心点）

**返回**
读取：`number`

**说明**
✅ 已实现。直接写坐标 = **瞬移**，并且会同步刷新内部的「基准位置」（`move.patrol` 等模块以它为原点）。
对挂了物理刚体的实体，改 `x`/`y` 会被物理层识别为瞬移（刚体重置到新位置并清零速度）—— 想让它「动」请用 `bwe.physics.setVelocity` / `applyImpulse`。

**示例**
```js
ctx.self.x += 32;
ctx.self.y += 32;
bwe.log(ctx.self.x + "," + ctx.self.y);
```

**另见**
[e.pos](#epos--vec2) · [e.setPos](#esetposx-y--void) · [bwe.physics.setVelocity](emergence.md#bwephysicssetvelocitye-vx-vy--boolean)

---

### e.pos → Vec2

**签名**
`e.pos: { x: number; y: number }`（**只读快照**）

**参数**
无

**返回**
`Vec2` — 每次读都是**新建对象**

**说明**
✅ 已实现。给你「一次性读两个坐标」的写法。**它不是活属性**：`e.pos.x = 100` 不会有任何效果，改了快照也不会写回实体 —— 要写请用 `e.x = 100` 或 `e.setPos(x, y)`。

**示例**
```js
var p = ctx.self.pos;
bwe.log("在 " + p.x + "," + p.y);

// ✗ 无效：改的是快照
ctx.self.pos.x = 100;

// ✓ 有效
ctx.self.x = 100;
```

**另见**
[e.setPos](#esetposx-y--void) · [e.x / e.y](#ex--ey--number)

---

### e.setPos(x, y) → void

**签名**
`e.setPos(x: number, y: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 世界像素 X；省略/非法时保持不变 |
| y | number | 世界像素 Y；省略/非法时保持不变 |

**返回**
`void`

**说明**
✅ 已实现。等价于同时写 `e.x` 和 `e.y`（并刷新基准位置）。

**示例**
```js
function onKey(ctx, key) {
  if (key === "KeyR") {
    ctx.self.setPos(64, 64);
  }
}
```

**另见**
[e.x / e.y](#ex--ey--number) · [bwe.grid.snap](map-nav-interact-spawner.md#bwegridsnapx-y--vec2)

---

### e.rotation → number

**签名**
`e.rotation: number`（可读写）

**参数**
写入：`number`，角度，**顺时针为正**，单位度

**返回**
读取：`number`

**说明**
✅ 已实现。围绕实体中心旋转。
⚠ 旋转精灵会**退出渲染合批**（只有 `rotation === 0` 的轴对齐精灵能合批）—— 大量实体都设不同角度会明显掉帧，见 [prefab 的性能提示](prefab.md#六性能提示)。

**示例**
```js
ctx.self.rotation = 45;    // 顺时针 45°
ctx.self.rotation = 0;     // 回到轴对齐（可合批）
```

**另见**
[e.scaleX / e.scaleY](#escale-x--e-scale-y--number) · [prefab 性能提示](prefab.md#六性能提示)

---

### e.scaleX / e.scaleY → number

**签名**
`e.scaleX: number`、`e.scaleY: number`（可读写）

**参数**
写入：`number`，缩放倍数（1 = 原始大小）

**返回**
读取：`number`

**说明**
✅ 已实现。真实绘制尺寸由 `sizeOf` 规则算出（见 [e.size](#esize--size)），缩放是最后一层乘数。
设成负值会镜像（偶数个负轴 = 旋转 180°）。

**示例**
```js
ctx.self.scaleX = 2;      // 横向拉宽一倍
ctx.self.scaleY = -1;     // 纵向翻转
```

**另见**
[e.size](#esize--size) · [e.setSize](#esetsizew-h--void)

---

### e.visible → boolean

**签名**
`e.visible: boolean`（可读写）

**参数**
写入：`boolean`

**返回**
读取：`boolean`

**说明**
✅ 已实现。`false` 时**不绘制**，也不参与点击命中、`bwe.interact.nearest` 的候选、`bwe.target.entity` 的命中；**不参与** `bwe.sense.canSee` 的可见判定（看不见的对象永远 `canSee === false`）。
**仍然存在**：`find` / `findAll` 照样能找到它、模块照常跑、物理照常模拟。

**示例**
```js
ctx.self.visible = false;     // 隐身
bwe.after(3, function () { ctx.self.visible = true; });
```

**另见**
[e.setAlpha](#esetalphaa--void)（想「半透明但仍可见」用这个）

---

### e.z → number

**签名**
`e.z: number`（可读写）

**参数**
写入：`number`（整数；小数会被四舍五入）

**返回**
读取：`number`

**说明**
✅ 已实现。排序层级：大的盖住小的。完整排序规则是 **`layer` → `z` → `y`**。
⚠ 给同一批同素材实例设**不同的 `z`** 会打断渲染合批（性能陷阱）—— 批量刷同种怪时保持相同 `z` / `layer` 最快。

**示例**
```js
ctx.self.z = 10;      // 盖住 z < 10 的对象
```

**另见**
[e.layer](#elayer--number) · [prefab 性能提示](prefab.md#六性能提示)

---

### e.layer → number

**签名**
`e.layer: number`（可读写）

**参数**
写入：`number`（图层下标，整数）

**返回**
读取：`number`

**说明**
✅ 已实现。排序时 **`layer` 优先于 `z`**：先把所有对象按 `layer` 分组，组内再按 `z`、再按 `y`。
典型用法：把「地面装饰」放 `layer = -1`，角色 `layer = 0`，UI 类特效 `layer = 10`。
⚠ 同 `z` 一样：**不同的 `layer` 会打断合批**。

**示例**
```js
ctx.self.layer = -1;    // 排到地面层
```

**另见**
[e.z](#ez--number) · [bwe.world.layers](world.md#bweworldlayers--layer)（📋 占位，当前返回空数组）

---

### e.locked → boolean

**签名**
`e.locked: boolean`（可读写）

**参数**
写入：`boolean`

**返回**
读取：`boolean`

**说明**
🧪 试验。**纯脚本侧状态**：引擎只「记住这个值」，**不影响任何运行时行为**（不阻止移动、不阻止物理、不阻止编辑）。
它存在是为了让脚本能自己实现「锁定」语义（例如自己检查 `if (!e.locked) { 移动 }`），并保持与编辑器 Inspector 的字段名一致。

**示例**
```js
ctx.self.locked = true;
function onUpdate(ctx, dt) {
  if (!ctx.self.locked) {
    ctx.self.x += 60 * dt;
  }
}
```

**另见**
[e.alive](#ealive--boolean)

---

## 三、尺寸

### e.size → Size

**签名**
`e.size: { w: number; h: number }`（**可读写**）

**参数**
写入：`{ w: number; h: number }` —— 等价于 `e.setSize(w, h)`，写进 `halfW = w/2`、`halfH = h/2`

**返回**
读取：`{w, h}` — 当前**真实绘制尺寸**（新对象快照）

**说明**
✅ 已实现。读和写的语义有微妙差别，务必注意：

- **读** `e.size` 返回的是**绘制尺寸**，由 `sizeOf` 规则算出（顺序：`halfW/halfH > 0` → `props.w/props.h > 0` → 素材像素尺寸 → 兜底 tileSize）。
- **写** `e.size` 只改 `halfW` / `halfH` 两个字段（不碰 `props`），所以一旦 `props.w/h` 有值，绘制的尺寸仍会优先用 `props`。

**示例**
```js
var s = ctx.self.size;
bwe.log("当前画出来是 " + s.w + "x" + s.h);

ctx.self.size = { w: 64, h: 64 };     // ← 等价 setSize(64, 64)
```

**另见**
[e.setSize](#esetsizew-h--void) · [e.setProp](#esetpropkey-val--void)

---

### e.setSize(w, h) → void

**签名**
`e.setSize(w: number, h: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| w | number | 宽（像素）；省略时保持当前绘制宽 |
| h | number | 高（像素）；省略时保持当前绘制高 |

**返回**
`void`

**说明**
✅ 已实现。写 `halfW = w/2`、`halfH = h/2`。**和 `e.size = {w,h}` 完全等价**。
⚠ `halfW`/`halfH` 同时是**碰撞体半宽半高**（`bwe.tilemap.blocked` 与物理刚体都用它），所以改尺寸也会改碰撞范围。

**示例**
```js
ctx.self.setSize(32, 48);
```

**另见**
[e.size](#esize--size) · [bwe.tilemap.blocked](map-nav-interact-spawner.md#bwetilemapblockedx-y-w-h--boolean)

---

## 四、精灵与动画

### e.asset → string

**签名**
`e.asset: string`（可读写）

**参数**
写入：`string` 素材名

**返回**
读取：`string` 当前素材名

**说明**
✅ 已实现。写 `e.asset` = **只换图，不改播放参数**（`animMode` / `animFps` 保持原样）。素材不存在时写一条 `精灵素材不存在：<名字>` 日志，**不换**。
和 `e.play(assetName)` 的区别：`play` 会顺带把 `animMode` 重置成 `"默认"` 并解除 `setFrame` 的帧锁定；写 `e.asset` 不会。

**示例**
```js
ctx.self.asset = "哥布林-走路";     // 播放参数不动
```

**另见**
[e.play](#eplayassetname--void) · [e.sprite](#espriteopts--void)

---

### e.animMode → string

**签名**
`e.animMode: string`（可读写）

**参数**
写入：`"默认"` / `"只显示首帧"` / `"单次播放"`；也认 `"loop"` / `"first"` / `"once"`（自动归一化）

**返回**
读取：`string`（归一化后的中文枚举）

**说明**
✅ 已实现。三个模式的实际行为：

| 模式 | 行为 |
|---|---|
| `"默认"` | 循环播放所有帧 |
| `"只显示首帧"` | 永远停在第 0 帧 |
| `"单次播放"` | 播到最后一帧就停住（不回卷） |

**示例**
```js
ctx.self.animMode = "once";        // 会被归一化成 "单次播放"
bwe.after(1, function () { ctx.self.animMode = "默认"; });
```

**另见**
[e.animFps](#eanimfps--number) · [e.setFrame](#esetframei--void)

---

### e.animFps → number

**签名**
`e.animFps: number`（可读写）

**参数**
写入：`number` 每秒帧数

**返回**
读取：`number`

**说明**
✅ 已实现。写 `e.animFps` 会**顺带解除 `setFrame` 的帧锁定**（否则设了 fps 也不动）。

**示例**
```js
ctx.self.animFps = 12;
```

**另见**
[e.animMode](#eanimmode--string) · [e.setFrame](#esetframei--void)

---

### e.sprite(opts) → void

**签名**
`e.sprite(opts: SpriteOpts): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| opts.asset | string | 素材名；省略或空字符串则不改素材 |
| opts.frame | number | 起始帧（0 起）；`>= 0` 会**锁定**在该帧，省略 / 负数解除锁定 |
| opts.fps | number | 每秒帧数，默认 8；`> 0` 才生效 |
| opts.mode | string | `"loop"`（默认）/ `"once"` / `"first"` |

**返回**
`void`

**说明**
✅ 已实现。一次调用同时设置素材 + 帧 + fps + 模式。素材不存在时**只写日志**，其余参数照样生效。

**示例**
```js
ctx.self.sprite({ asset: "宝箱-开", mode: "once", fps: 10 });
bwe.after(0.8, function () { ctx.self.sprite({ asset: "宝箱-空", mode: "first" }); });
```

**另见**
[e.play](#eplayassetname--void) · [e.setFrame](#esetframei--void) · [bwe.draw.sprite](draw-audio-save.md#bwedrawspriteasset-x-y-opts--void)

---

### e.play(assetName) → void

**签名**
`e.play(assetName: string): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| assetName | string | 素材名；空字符串只重置播放状态不换图 |

**返回**
`void`

**说明**
✅ 已实现。换素材 + 把 `animMode` 重置成 `"默认"` + 解除 `setFrame` 帧锁定。素材不存在时写日志，不换图。

**示例**
```js
ctx.self.play("哥布林-跑步");
```

**另见**
[e.asset](#easset--string) · [e.sprite](#espriteopts--void)

---

### e.setFrame(i) → void

**签名**
`e.setFrame(i: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| i | number | 帧下标（0 起）；负数被钳制到 0 |

**返回**
`void`

**说明**
✅ 已实现。**冻结**到第 i 帧：内部把 `animFps` 设成 1 并在每帧把动画时间钉在该帧上，所以这样**不是一次性**设置 —— 它会持续锁住，直到你调 `e.play(...)` 或写 `e.animFps`。
对 `look.playOnce` 之类的模块动画也会覆盖，注意别打架。

**示例**
```js
ctx.self.setFrame(3);                 // 冻结在第 3 帧
bwe.after(1, function () { ctx.self.play(ctx.self.asset); });   // 解锁
```

**另见**
[e.animFps](#eanimfps--number) · [e.sprite](#espriteopts--void)

---

## 五、模块

### e.hasModule(id) → boolean

**签名**
`e.hasModule(id: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| id | string | 模块 def id，如 `"move.patrol"`；新旧两套 id 都认（`"combat.health"` ≡ `"fight.hp"`） |

**返回**
`boolean`

**说明**
✅ 已实现。别名映射表：

| Web id | 桌面旧 id |
|---|---|
| `combat.health` | `fight.hp` |
| `fx.cameraFollow` | `show.camera` |
| `render.shadow` | `look.shadow` |
| `render.blink` | `look.blink` |
| `render.sortByY` | `look.sortByY` |
| `render.playOnce` | `look.playOnce` |

**示例**
```js
if (!ctx.self.hasModule("move.patrol")) {
  ctx.self.addModule("move.patrol", { speed: 40, range: 96 });
}
```

**另见**
[e.module](#emoduleid--moduleinstance--null) · [e.addModule](#eaddmoduledef-params-when--boolean)

---

### e.module(id) → ModuleInstance | null

**签名**
`e.module(id: string): ModuleInstance | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| id | string | 模块 def id（新旧别名都认） |

**返回**
`ModuleInstance | null` — 没挂这个模块返回 `null`

**说明**
✅ 已实现。返回的模块对象是**活包装**（同一个模块复用同一个 JS 对象），读写的就是编辑器里那份参数数据：

| 成员 | 类型 | 说明 |
|---|---|---|
| `id` | string | 模块 ids |
| `def` | string | 同 `id`（保留字段） |
| `enabled` | boolean（可读写） | 写 `false` = **从对象上移除该模块**；写 `true` = 加回来 |
| `get(key, def)` | function | 读参数；参数不存在返回 `def`。`def` 是数字时尝试转数字，是布尔时认 `"开"` / `"true"` / `"1"` |
| `set(key, val)` | function | 写参数；布尔会被存成 `"开"` / `"关"`，数字整数会去掉小数点 |

**示例**
```js
var patrol = ctx.self.module("move.patrol");
if (patrol) {
  patrol.set("speed", 120);
  bwe.log("巡逻速度 = " + patrol.get("speed", 0));
  patrol.enabled = false;      // 关掉巡逻
}
```

**另见**
[e.modules](#emodules--moduleinstance) · [e.hasModule](#ehasmoduleid--boolean) · [modules.md](modules.md#一模块总表)

---

### e.modules() → ModuleInstance[]

**签名**
`e.modules(): ModuleInstance[]`

**参数**
无

**返回**
`ModuleInstance[]` — 当前挂的所有模块（新数组）

**说明**
✅ 已实现。顺序 = 对象上模块的存储顺序（也就是编辑器 Inspector 里的顺序）。

**示例**
```js
var list = ctx.self.modules();
for (var i = 0; i < list.length; i++) {
  bwe.log(list[i].id + " enabled=" + list[i].enabled);
}
```

**另见**
[e.module](#emoduleid--moduleinstance--null) · [e.addModule](#eaddmoduledef-params-when--boolean)

---

### e.addModule(def, params, when?) → boolean

**签名**
`e.addModule(def: string, params?: object, when?: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| def | string | 模块 def id；空字符串返回 `false` |
| params | object | 初始参数（值会归一成编辑器同构文本：布尔 → `"开"/"关"`、整数 → 去小数点文本） |
| when | string | 触发时机，如 `"ALWAYS"` / `"ON_SPAWN"`；省略保持模块现有值（新模块默认 `"ALWAYS"`） |

**返回**
`boolean` — `true` = 成功（**模块已存在时也返回 `true`**，因为语义是「合并参数」）

**说明**
✅ 已实现。**幂等语义**：同 def 已存在时**不新建**，只把 `params` **合并**进去（同 key 覆盖，新 key 追加）。
注意：`addModule("script.js", { script: "xxx" })` **不会**真的把脚本挂上去 —— 脚本绑定在生成时就决定了，运行期加 `script.js` 模块不会派发 `onStart`。

**示例**
```js
ctx.self.addModule("fight.hp", { hp: 50, defense: 2 });
ctx.self.addModule("move.patrol", { speed: 60, range: 120, axis: "上下" }, "ALWAYS");
```

**另见**
[e.removeModule](#eremovemoduledef--boolean) · [e.module](#emoduleid--moduleinstance--null)

---

### e.removeModule(def) → boolean

**签名**
`e.removeModule(def: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| def | string | 模块 def id |

**返回**
`boolean` — `true` = 确实删掉了一个模块；`false` = 本来就没挂

**说明**
✅ 已实现。等同 `e.module(def).enabled = false`，但能明确知道有没有删掉。
移除后模块包装对象的缓存也会清掉，下次 `e.module(def)` 会拿到新包装。

**示例**
```js
if (ctx.self.removeModule("move.follow")) {
  bwe.log("停止追击");
}
```

**另见**
[e.addModule](#eaddmoduledef-params-when--boolean) · [e.hasModule](#ehasmoduleid--boolean)

---

## 六、对象属性（props）

### e.prop(key, def?) → unknown

**签名**
`e.prop(key: string, def?: unknown): unknown`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| key | string | 属性名 |
| def | unknown | 缺省值；也决定**类型转换**（见说明） |

**返回**
`unknown` — 属性值；键不存在返回 `def`

**说明**
✅ 已实现。props 底层**永远是字符串**（和编辑器同一份数据），读的时候按 `def` 的类型尝试转换：

| `def` 的类型 | 读取行为 |
|---|---|
| `number` | 把字符串 `parseFloat`，失败返回 `def` |
| `boolean` | 认 `"开"` / `"true"` / `"1"` 为 `true`，其它为 `false` |
| 其它 / 省略 | 原样返回字符串 |

⚠ 所以 `e.prop("hp")`（不给 def）拿到的是**字符串** `"100"`，不是数字 `100`。

**示例**
```js
var hp = ctx.self.prop("hp", 100);          // ← 给数字 def，返回 number
var on = ctx.self.prop("开关", false);       // ← 给布尔 def，返回 boolean
var raw = ctx.self.prop("标签");              // ← 字符串
```

**另见**
[e.setProp](#esetpropkey-val--void) · [e.props](#eprops--recordstring-string) · [e.size](#esize--size)

---

### e.setProp(key, val) → void

**签名**
`e.setProp(key: string, val: unknown): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| key | string | 属性名；空字符串是空操作 |
| val | unknown | 值；布尔存成 `"开"/"关"`，整数去掉小数点，其余 `toString()` |

**返回**
`void`

**说明**
✅ 已实现。写的是**编辑器里那份 props**，所以会影响下一帧的绘制尺寸（`props.w` / `props.h` 参与 `sizeOf`）。

**示例**
```js
ctx.self.setProp("w", 64);
ctx.self.setProp("h", 64);
ctx.self.setProp("会发光", true);      // 存成 "开"
if (ctx.self.size.w === 64) { bwe.log("尺寸生效了"); }
```

**另见**
[e.prop](#epropkey-def--unknown) · [e.setProps](#esetpropsobj--void)

---

### e.props() → Record<string, string>

**签名**
`e.props(): Record<string, string>`

**参数**
无

**返回**
`Record<string, string>` — **全部 props 的快照**（新对象，值是字符串）

**说明**
✅ 已实现。注意：方法调用，**不是属性**（`e.props` 是函数，`e.props()` 才是数据）。改了返回的对象**不会**写回实体。

**示例**
```js
var all = ctx.self.props();
for (var k in all) {
  if (all.hasOwnProperty(k)) {
    bwe.log(k + " = " + all[k]);
  }
}
```

**另见**
[e.setProps](#esetpropsobj--void) · [e.prop](#epropkey-def--unknown)

---

### e.setProps(obj) → void

**签名**
`e.setProps(obj: object): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| obj | object | 要写入的键值对；不是对象时空操作 |

**返回**
`void`

**说明**
✅ 已实现。**合并**语义：只覆盖 / 新增 `obj` 里给出的键，**不会清掉**实体原有的其它 props。

**示例**
```js
ctx.self.setProps({ w: 48, h: 48, 颜色: "#ff0000" });
```

**另见**
[e.props](#eprops--recordstring-string) · [e.setProp](#esetpropkey-val--void)

---

## 七、标签

### e.tags → Tags

**签名**
`e.tags: Tags`（**只读**，`Tags extends string[]`）

**参数**
无

**返回**
`Tags` — 标签数组快照，额外带 `has(tag)` / `includes(tag)` 方法

**说明**
✅ 已实现。读到的数组是**快照**，改它不会影响实体 —— 增删标签请用 `addTag` / `removeTag` / `setTags`。
`has(t)` 和 `includes(t)` 是等价的（都查实体的真实标签，不是查快照数组）。

**示例**
```js
if (ctx.self.tags.has("敌人")) {
  bwe.log("是敌人");
}
bwe.log("标签：" + ctx.self.tags.join(","));
```

**另见**
[e.addTag](#eaddtagtag--boolean) · [e.setTags](#esettagstags--void) · [bwe.world.find](world.md#bweworldfindq--entity--null)

---

### e.addTag(tag) → boolean

**签名**
`e.addTag(tag: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| tag | string | 标签名；空字符串不添加 |

**返回**
`boolean` — 添加后实体是否**带这个标签**（已经存在也返回 `true`）

**说明**
✅ 已实现。自动去重。新加的标签立刻能被 `bwe.world.find("标签")` 和 `clearTag` 识别。

**示例**
```js
ctx.self.addTag("已点燃");
bwe.log("带已点燃的对象数：" + bwe.world.count({ tag: "已点燃" }));
```

**另见**
[e.removeTag](#eremovetagtag--boolean) · [bwe.world.clearTag](world.md#bweworldcleartagtag--void)

---

### e.removeTag(tag) → boolean

**签名**
`e.removeTag(tag: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| tag | string | 标签名；空字符串是空操作 |

**返回**
`boolean` — 是否**真的移除**了一个标签（本来没有 = `false`）

**说明**
✅ 已实现。

**示例**
```js
if (ctx.self.removeTag("燃烧中")) {
  bwe.log("火灭了");
}
```

**另见**
[e.addTag](#eaddtagtag--boolean) · [e.hasTag](#ehastagtag--boolean)

---

### e.hasTag(tag) → boolean

**签名**
`e.hasTag(tag: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| tag | string | 标签名 |

**返回**
`boolean`

**说明**
✅ 已实现。与 `e.tags.has(tag)` 等价，但不需要先建数组快照。

**示例**
```js
if (ctx.self.hasTag("玩家")) {
  bwe.log("我是玩家");
}
```

**另见**
[e.tags](#etags--tags) · [e.addTag](#eaddtagtag--boolean)

---

### e.setTags(tags) → void

**签名**
`e.setTags(tags: string[]): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| tags | string[] | 新的标签集合；不是数组则只清空 |

**返回**
`void`

**说明**
✅ 已实现。**整体替换**：先清空再用新数组填充（自动去重、跳过空字符串）。传 `[]` 就是清空所有标签。
⚠ 清空会把 `玩家` 这类引擎用来识别玩家的标签也一起清掉（玩家识别会因为找不到而退化成「第一个 ACTOR」）。

**示例**
```js
ctx.self.setTags(["敌人", "精英"]);
```

**另见**
[e.addTag](#eaddtagtag--boolean) · [e.tags](#etags--tags)

---

## 八、父子关系

### e.parent → Entity | null

**签名**
`e.parent: Entity | null`（可读写）

**参数**
写入：`Entity` 表示挂到该父级；`null` / 非 Entity 表示脱离父级

**返回**
读取：`Entity | null`（父级已死也是 `null`）

**说明**
✅ 已实现。**只是脚本层的归属关系** —— 父子各自仍是**独立的 Actor**，各自参与物理、绘制、查找、`find`。
**没有坐标继承**：移动父级不会带动子级，销毁父级也不会自动销毁子级。想要真正联动得自己写。
防环保护：把 A 挂到自己的后代下面会被**静默忽略**。

**示例**
```js
var bullet = bwe.world.spawn({ x: 0, y: 0, asset: "子弹", kind: "PROP" });
bullet.parent = ctx.self;
bwe.log("子弹的父级：" + bullet.parent.name);
bullet.parent = null;
```

**另见**
[e.children](#echildren--entity) · [bwe.world.spawn](world.md#bweworldspawnopts--entity--null)

---

### e.children() → Entity[]

**签名**
`e.children(): Entity[]`

**参数**
无

**返回**
`Entity[]` — 所有**直接**子级（新数组；已销毁的子级被跳过）

**说明**
✅ 已实现。**方法不是属性**（`e.children()` 带括号）。顺序 = 设置 `parent` 的顺序，但**不保证稳定**（内部是哈希表遍历）。

**示例**
```js
var kids = ctx.self.children();
bwe.log("有 " + kids.length + " 个挂在我名下");
for (var i = 0; i < kids.length; i++) {
  kids[i].setPos(ctx.self.x, ctx.self.y);   // 自己实现跟随
}
```

**另见**
[e.parent](#eparent--entity--null)

---

## 九、染色与透明

### e.setColor(r, g, b, a?) → void

**签名**
`e.setColor(r: number, g: number, b: number, a?: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| r, g, b | number | 颜色乘数；**0~1**，或任一通道 `> 1` 时整组按 **0~255** 解释 |
| a | number | 透明度乘数，默认 1；同样吃 0~1 / 0~255 两种刻度 |
| 对象写法 | `setColor({r, g, b, a})` | 也支持（只在参数个数 ≤ 2 时走这个分支） |

**返回**
`void`

**说明**
✅ 已实现。用 **GL 染色调制**（乘法）实现，不改原图 —— 同素材实例仍然共享纹理、仍然能合批。
与 `look.blink` 模块的 alpha 是**相乘**关系。
染色是 0~1 的乘数：`(1,1,1,1)` = 原色；`(0.5,0.5,0.5,1)` = 压暗一半。

**示例**
```js
ctx.self.setColor(1, 0.3, 0.3);           // 偏红
ctx.self.setColor(255, 80, 80, 200);      // 0~255 刻度也行
ctx.self.setColor({ r: 1, g: 1, b: 1, a: 0.5 });   // 对象写法
```

**另见**
[e.setAlpha](#esetalphaa--void) · [e.clearColor](#eclearcolor--void) · [e.color](#ecolor--rgba)

---

### e.setAlpha(a) → void

**签名**
`e.setAlpha(a: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| a | number | 透明度乘数；`0~1`，`> 1` 时按 0~255 解释 |

**返回**
`void`

**说明**
✅ 已实现。只改 alpha，**保留当前 RGB**（没染过色则 RGB 是 1,1,1）。想「淡入淡出」用它。

**示例**
```js
var t = 0;
function onUpdate(ctx, dt) {
  t = Math.min(1, t + dt);
  ctx.self.setAlpha(1 - t);       // 1 秒内淡出
}
```

**另见**
[e.setColor](#esetcolorr-g-b-a--void) · [e.color](#ecolor--rgba)

---

### e.clearColor() → void

**签名**
`e.clearColor(): void`

**参数**
无

**返回**
`void`

**说明**
✅ 已实现。清除染色，恢复「原样画」的最快路径（未染色实例在渲染侧零额外开销）。

**示例**
```js
ctx.self.clearColor();
```

**另见**
[e.setColor](#esetcolorr-g-b-a--void) · [e.setAlpha](#esetalphaa--void)

---

### e.color → {r, g, b, a}

**签名**
`e.color: { r: number; g: number; b: number; a: number }`（**只读**）

**参数**
无

**返回**
`{r,g,b,a}` — 当前染色乘数（0~1）；未染色时全是 1

**说明**
✅ 已实现。每次读都是新对象。**不能直接写**（`e.color.r = 0.5` 无效）—— 要用 `setColor` / `setAlpha` / `clearColor`。

**示例**
```js
var c = ctx.self.color;
bwe.log("alpha = " + c.a);
```

**另见**
[e.setColor](#esetcolorr-g-b-a--void) · [e.setAlpha](#esetalphaa--void)

---

## 十、子精灵

### e.attach(opts) → AttachHandle

**签名**
`e.attach(opts: AttachOpts): AttachHandle`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| opts.asset | string | 素材名（空字符串 = 不画东西，但仍占一个句柄） |
| opts.dx | number | 相对实体中心的像素 X 偏移，默认 0 |
| opts.dy | number | 相对实体中心的像素 Y 偏移，默认 0 |
| opts.z | number | 排序层级，默认 0 |
| opts.rotation | number | 旋转角度（度，顺时针），默认 0 |
| opts.alpha | number | 透明度 0~1，默认 1 |
| opts.w | number | 绘制宽（像素），默认 0 |
| opts.h | number | 绘制高（像素），默认 0 |

**返回**
`AttachHandle` — 对象 `{ id: number, remove(): void }`。**不是 number**（`bwe.d.ts` 里写成 `type AttachHandle = number` 是旧版残留，以本页为准）

**说明**
✅ 已实现。给实体挂一个**跟随它移动的装饰精灵**（武器 / 影子 / 特效）。引擎每帧统一绘制，随实体坐标走。
实体被销毁时，它的子精灵会自动清掉。**这是 v1 的实现方式，`prefab` 的 `children` 也复用它**（不是嵌套 Actor 层级）。

**示例**
```js
var sword = ctx.self.attach({ asset: "剑", dx: 16, dy: 0, rotation: 30, alpha: 0.9 });

bwe.after(2, function () {
  sword.remove();          // ← 推荐这样摘
  // ctx.self.detach(sword); // ← 也可以（传句柄对象）
});
```

**另见**
[e.detach](#edetachhandle--void) · [prefab.children](prefab.md#53-children子精灵)

---

### e.detach(handle) → void

**签名**
`e.detach(handle: AttachHandle | number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| handle | AttachHandle \| number | `e.attach` 的返回值，或它的 `id` 数字 |

**返回**
`void`

**说明**
✅ 已实现。两种写法都认：先取 `handle.id`，取不到就把参数当数字。摘掉不存在的句柄是空操作。

**示例**
```js
var h = ctx.self.attach({ asset: "影子", dy: 18, alpha: 0.3 });
ctx.self.detach(h);
ctx.self.detach(h.id);    // 也可以只给 id
```

**另见**
[e.attach](#eattachopts--attachhandle)

---

## 十一、几何查询

### e.distanceTo(other) → number

**签名**
`e.distanceTo(other: Entity): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| other | Entity | 另一个实体；无效时返回 0 |

**返回**
`number` — 欧氏距离（像素）

**说明**
✅ 已实现。传 `null` / 已销毁实体都返回 `0`（注意：**不是 `Infinity`**，写判定时别用 `d > 0` 当「有目标」）。

**示例**
```js
var target = bwe.world.find("玩家");
if (target && ctx.self.distanceTo(target) < 100) {
  bwe.log("玩家靠近了");
}
```

**另见**
[e.angleTo](#eangletoother--number) · [bwe.dist](lifecycle.md#bwedistx1-y1-x2-y2--number)

---

### e.angleTo(other) → number

**签名**
`e.angleTo(other: Entity): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| other | Entity | 另一个实体；无效时返回 0 |

**返回**
`number` — 角度（**度**，0 = 向右，**顺时针**为正）

**说明**
✅ 已实现。`Math.atan2(dy, dx)` 转成度。因为 Y 轴向下，所以返回值天然是「屏幕上的顺时针」角度。

**示例**
```js
var player = bwe.world.find("玩家");
if (player) {
  ctx.self.rotation = ctx.self.angleTo(player);
}
```

**另见**
[e.distanceTo](#edistancetoother--number) · [e.rotation](#erotation--number)

---

## 十二、事件

### e.on(name, fn) → void

**签名**
`e.on(name: string, fn: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 事件名（见下表）；空字符串或 `fn` 非函数时空操作 |
| fn | Function | 回调，参数见下表 |

**返回**
`void`

**说明**
✅ 已实现。注册到**这个实体**的事件表，同一事件可以注册多个回调（都按注册顺序执行）。

| 事件名 | 回调参数 | 触发点 |
|---|---|---|
| `"click"` | `fn()` | 鼠标点中该实体 |
| `"enter"` | `fn(other)` | **只有 `kind === "ZONE"`**：玩家进入矩形 |
| `"leave"` | `fn(other)` | **只有 `kind === "ZONE"`**：玩家离开矩形 |
| `"interact"` | `fn(actor)` | 按下交互键（需先被 `bwe.interact.nearest` 选中） |
| `"damage"` | `fn(amount, from)` | `e.damage(n)` 或材质场烧毁 |
| `"death"` | `fn(from)` | `hp <= 0` |
| `"destroy"` | `fn()` | 实体被销毁 |

⚠ 注意这些事件的**载荷形态各不相同**（不是统一的 `ctx`），而且 `"enter"` / `"leave"` 之外的 `other` 类事件传的是 Entity 或数字。
⚠ 没有取消订阅的方法 —— 注册了就会一直有效到实体销毁。

**示例**
```js
function onStart(ctx) {
  ctx.self.on("damage", function (amount, from) {
    bwe.log("扣了 " + amount + " 点");
    bwe.camera.shake(3, 0.1);
  });
  ctx.self.on("death", function (from) {
    bwe.world.emit("enemyDead", { name: ctx.self.name });
  });
}
```

**另见**
[onStart / onDamage / onDeath](lifecycle.md#一脚本怎么被调用)（对象脚本的回调版本，更适合挂逻辑）

---

## 十三、血量与伤害

### e.hp → number

**签名**
`e.hp: number`（可读写）

**参数**
写入：`number`

**返回**
读取：`number`

**说明**
✅ 已实现。**直接写 `e.hp` 不会触发任何事件**（不掉血动画、不派发 `onDamage`、不判死）—— 想走完整受击流程请用 `e.damage(n)`。
初始值来自 `combat.health` / `fight.hp` 模块（`maxHealth`），没有模块时默认 `10`。

**示例**
```js
bwe.log(ctx.self.hp + " / " + ctx.self.hpMax);
ctx.self.hp = 999;            // 静默改值，不触发事件
```

**另见**
[e.hpMax](#ehpmax--number) · [e.damage](#edamagen--number) · [e.heal](#ehealen--number)

---

### e.hpMax → number

**签名**
`e.hpMax: number`（可读写）

**参数**
写入：`number`

**返回**
读取：`number`

**说明**
✅ 已实现。`hpMax > 0` 且 `0 < hp < hpMax` 时引擎会在实体头顶画一个血条（这个血条是引擎内置的，不受 `fight.hp` 的 `showBar` 参数影响）。

**示例**
```js
ctx.self.hpMax = 200;
ctx.self.hp = 200;
```

**另见**
[e.hp](#ehp--number) · [e.heal](#ehealen--number)

---

### e.damage(n) → number

**签名**
`e.damage(n: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| n | number | 扣血量 |
| 第二个参数 | Entity \| null | 可选：伤害来源，会透传给 `onDamage` / `"damage"` 事件 |

**返回**
`number` — **扣完之后**的 `hp`

**说明**
✅ 已实现。完整受击流程：`hp -= n` → 派发实体 `"damage"` 事件 → 派发对象脚本 `onDamage` → 若 `hp <= 0` 且还没死：标记 `dead` → 派发 `"death"` 事件 → 派发脚本 `onDeath`。
**注意**：`invicible` / `defense` / 闪白 / 无敌帧这些参数**引擎没有实现** —— 它们只是 `fight.hp` 模块上的参数占位，不会影响 `e.damage`。要无敌请自己在脚本里判断。

**示例**
```js
var hpLeft = ctx.self.damage(15);
bwe.log("还剩 " + hpLeft);

// 带伤害来源
ctx.self.damage(15, bwe.world.find("玩家"));
```

**另见**
[e.heal](#ehealen--number) · [e.hp](#ehp--number) · [onDamage](lifecycle.md#ondamagectx-amount-from--void)

---

### e.heal(n) → number

**签名**
`e.heal(n: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| n | number | 回血量 |

**返回**
`number` — **回完之后**的 `hp`（已被 `hpMax` 封顶）

**说明**
✅ 已实现。`hp = min(hpMax, hp + n)`。**不会**复活已死实体（`dead` 是独立标志），也**不派发**任何事件。

**示例**
```js
ctx.self.heal(20);
```

**另见**
[e.damage](#edamagen--number) · [e.hpMax](#ehpmax--number)

---

## 十四、销毁

### e.destroy() → void

**签名**
`e.destroy(): void`

**参数**
无

**返回**
`void`

**说明**
✅ 已实现。等同 `bwe.world.destroy(e)`：先派发 `onDestroy` 与 `"destroy"` 事件，再清掉子精灵，最后从场景移除并把 `dead` 置真。
**能销毁自己**（`ctx.self.destroy()`），也能销毁别的实体。重复调用是空操作。
⚠ 在 `onUpdate` 里销毁自己后，本次回调剩下的代码**还会继续执行**（引擎不中断你的函数）—— 之后对这个实体的读操作是安全的空操作。

**示例**
```js
function onDeath(ctx, by) {
  ctx.self.destroy();
}
```

**另见**
[bwe.world.destroy](world.md#bweworlddestroye--void) · [onDestroy](lifecycle.md#ondestroyctx--void)

---

## 附：属性速查

| 成员 | 读写 | 类型 | 一句话 |
|---|---|---|---|
| `id` | 只读 | string | 唯一 id |
| `name` | 读写 | string | 对象名，`find` 可用 |
| `kind` | 读写 | string | 对象大类（影响引擎行为） |
| `x` / `y` | 读写 | number | 世界像素中心点 |
| `pos` | 只读 | Vec2 | 位置快照（写它没效果） |
| `z` | 读写 | number | 排序层级 |
| `layer` | 读写 | number | 图层（排序优先于 z） |
| `rotation` | 读写 | number | 角度（度，顺时针） |
| `scaleX` / `scaleY` | 读写 | number | 缩放 |
| `visible` | 读写 | boolean | 是否绘制 / 可被点中 |
| `alive` | 只读 | boolean | 是否还活着 |
| `locked` | 读写 | boolean | 🧪 纯脚本标记，引擎不执行 |
| `size` | 读写 | Size | 读=绘制尺寸，写=setSize |
| `asset` | 读写 | string | 素材名（只换图） |
| `animMode` | 读写 | string | 动画模式 |
| `animFps` | 读写 | number | 帧率（写会解帧锁） |
| `tags` | 只读 | Tags | 标签快照，带 `has()` |
| `color` | 只读 | {r,g,b,a} | 染色快照 |
| `parent` | 读写 | Entity \| null | 脚本层父子归属 |
| `hp` / `hpMax` | 读写 | number | 血量（直接写不触发事件） |
