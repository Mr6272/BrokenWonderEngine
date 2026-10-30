# bwe.scene — 场景（Scene）

> 本页覆盖：`bwe.scene` 的全部成员 —— 场景列表、当前场景、按名字/文件名查找、切换（帧末生效）、待切换状态、场景代数、切换回调。
>
> 相关页：[spatial：多层空间](spatial.md) · [road：路网](road.md) · [world：世界](world.md) · [lifecycle：生命周期与 ctx](lifecycle.md) · [README：索引](README.md)

**核心约定**：`bwe.world.*` 一律作用于**当前**场景；切换后自动指向新场景，脚本不需要重新取句柄。

**切换是延迟的**：`switchTo` / `load` 只**登记请求**，真正切换发生在帧末（COMMIT 阶段）。所以：

- 同一帧内 `switchTo` 之后立刻 `bwe.world.find(...)` 拿到的还是**旧场景**的实体；
- 判断"数据是不是新的"用 `epoch()`；
- 需要在切换完成后做事，用 `on("changed", fn)`。

**Phase 说明**：`✅ 已实现`（本页全部成员均为已实现）。

---

## 一、查询

### bwe.scene.list() → SceneListItem[]

**签名**
`bwe.scene.list(): SceneListItem[]`

**参数**
无

**返回**
数组，每项 `{name, file, width, height, index, current}`

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 场景名 |
| `file` | `string` | 场景文件名 |
| `width` / `height` | `number` | 像素尺寸 |
| `index` | `number` | 在场景列表里的序号 |
| `current` | `boolean` | 是否当前场景 |

**说明**
✅ 已实现。每次调用都新建数组与对象。

**示例**
```js
var scenes = bwe.scene.list();
for (var i = 0; i < scenes.length; i++) {
  if (scenes[i].current) {
    bwe.log("当前：" + scenes[i].name + " (" + scenes[i].width + "x" + scenes[i].height + ")");
  }
}
```

**另见**
[bwe.scene.current](#bwescenecurrent--scenecurrent--null) · [bwe.scene.count](#bwescenecount--number)

---

### bwe.scene.current() → SceneCurrent | null

**签名**
`bwe.scene.current(): SceneCurrent | null`

**参数**
无

**返回**
`{name, file, index, epoch, width, height, tileSize}`，没有场景时 `null`

**说明**
✅ 已实现。比 `list()` 的单项多两个字段：`epoch`（场景代数）与 `tileSize`（当前场景的每格像素）。

**示例**
```js
var cur = bwe.scene.current();
if (cur) {
  bwe.log("场景 " + cur.name + "，第 " + cur.epoch + " 代，格 " + cur.tileSize + "px");
}
```

**另见**
[bwe.scene.epoch](#bwesceneepoch--number)

---

### bwe.scene.count() → number

**签名**
`bwe.scene.count(): number`

**参数**
无

**返回**
`number` — 场景总数（无工程数据时 0）

**说明**
✅ 已实现。

**示例**
```js
bwe.log("一共 " + bwe.scene.count() + " 个场景");
```

---

### bwe.scene.has(name) → boolean

**签名**
`bwe.scene.has(name: string): boolean`

**参数**
- `name` — 场景名，**或**文件名，**或**去掉扩展名的 basename（三种写法都认）

**返回**
`boolean` — 是否存在

**说明**
✅ 已实现。查找顺序：先按 `name` 精确匹配，再按文件名（含去掉扩展名、去掉目录的一部分）匹配。空字符串返回 `false`。

**示例**
```js
if (bwe.scene.has("city")) {
  bwe.scene.switchTo("city");
}
// 这三种写法通常都指向同一个场景
bwe.scene.has("city");        // 场景名
bwe.scene.has("city.json");   // 文件名
```

**另见**
[bwe.scene.switchTo](#bwesceneswitchtoname--boolean)

---

## 二、切换

### bwe.scene.switchTo(name) → boolean

**签名**
`bwe.scene.switchTo(name: string): boolean`

**参数**
- `name` — 场景名 / 文件名 / basename

**返回**
`boolean` — **是否登记成功**（不代表已经切完）

**说明**
✅ 已实现。只登记请求，帧末生效。找不到场景时返回 `false` 并打日志（当前场景不变）。

**示例**
```js
if (!bwe.scene.switchTo("suburb")) {
  bwe.log("场景不存在，仍留在 " + bwe.scene.current().name);
}
```

**另见**
[bwe.scene.pending](#bwescenepending--string--null) · [bwe.scene.epoch](#bwesceneepoch--number) · [bwe.scene.on](#bwesceneonwillchange--changed-fnname-epoch)

---

### bwe.scene.load(name) → boolean

**签名**
`bwe.scene.load(name: string): boolean`

**参数**
- `name` — 同上

**返回**
`boolean` — 是否登记成功

**说明**
✅ 已实现。`switchTo` 的**别名**（语义：加载并切过去）。两者行为完全一致，选一个用即可。

**示例**
```js
bwe.scene.load("city");
```

---

### bwe.scene.pending() → string | null

**签名**
`bwe.scene.pending(): string | null`

**参数**
无

**返回**
`string | null` — 待切换的场景名；没有待切换时 `null`

**说明**
✅ 已实现。可以用来防连点：已经排了一次切换就别排第二次。

**示例**
```js
if (bwe.scene.pending() === null) {
  bwe.scene.switchTo("city");
}
```

---

### bwe.scene.epoch() → number

**签名**
`bwe.scene.epoch(): number`

**参数**
无

**返回**
`number` — 场景代数（每次**真正**切换 +1，没切换过就是初始值）

**说明**
✅ 已实现。缓存了世界数据的脚本用它判断"我手上的缓存是不是过期了"。

**示例**
```js
var seen = bwe.scene.epoch();
function ensureFresh() {
  if (bwe.scene.epoch() !== seen) {
    seen = bwe.scene.epoch();
    rebuildCache();   // 场景换过了，重建
  }
}
```

**另见**
[bwe.scene.current](#bwescenecurrent--scenecurrent--null)

---

## 三、切换回调

### bwe.scene.on("willChange" | "changed", fn({name, epoch}))

**签名**
`bwe.scene.on(ev: "willChange" | "changed", fn: (info: { name: string; epoch: number }) => void): Function | null`

**参数**
- `ev` — 事件名。`"willChange"`（切换前）/ `"changed"`（切换后）
- `fn` — 回调，入参 `{name, epoch}`

**返回**
传进去的 `fn` 本身（便于 `off(fn)`）；事件名未知时返回 `null` 并打日志

**说明**
✅ 已实现。`changed` 在帧末 COMMIT 阶段的**最后**派发，所以回调里新场景的实体、瓦片图、脚本绑定**都已就绪** —— 可以直接 `bwe.world.find(...)`。

事件名接受别名：

| 事件 | 认的写法 |
|---|---|
| 切换前 | `willChange` / `will` / `before`（不区分大小写） |
| 切换后 | `changed` / `change` / `after`（不区分大小写） |

**示例**
```js
bwe.scene.on("changed", function (info) {
  bwe.log("切到 " + info.name + "（第 " + info.epoch + " 代）");
  var player = bwe.world.find({ tag: "player" });   // 新场景的实体，已就绪
});
```

**另见**
[bwe.scene.off](#bwesceneofffn--boolean)

---

### bwe.scene.off(fn) → boolean

**签名**
`bwe.scene.off(fn: Function): boolean`

**参数**
- `fn` — 之前传给 `on` 的那个函数**引用**（同一个函数对象）

**返回**
`boolean` — 是否真的摘掉了一个（`willChange` 与 `changed` 两处都会找）

**说明**
✅ 已实现。必须在**场景卸载前**摘掉，否则回调会跟着场景一起被清（`clearSceneState`）。

**示例**
```js
var onChanged = function (info) { bwe.log("切到 " + info.name); };
bwe.scene.on("changed", onChanged);
// 之后：
bwe.scene.off(onChanged);
```

---

## 另见

- [spatial：多层空间](spatial.md) —— 楼层 / 区域 / 垂直连接
- [road：路网](road.md) —— 道路节点与路径
- [world：世界](world.md) —— 当前场景的实体查找与生成
- [lifecycle：生命周期与 ctx](lifecycle.md) —— `onSceneStart` / `onSceneEnd`
