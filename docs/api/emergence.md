# 涌现式模拟基底 — material · field · noise · sense · ai · faction · target · physics · seed

> 本页覆盖：`bwe.material`、`bwe.field`、`bwe.noise`、`bwe.sense`、`bwe.faction`、`bwe.ai`、`bwe.target`、`bwe.physics`、`bwe.seed`。
> 设计原则：引擎只提供「**材质 → 场 → 感知 / 记忆 → 物理**」这四层可组合基底，**行为由 JS 组合**，不写死关卡。
>
> 相关页：[world：实体](world.md) · [entity：Entity](entity.md) · [map-nav-interact-spawner：瓦片 / 寻路](map-nav-interact-spawner.md) · [README：索引](README.md)

**典型的涌现链**：点火 → 草地自燃蔓延 → 烧到油桶火势暴涨 → 烧穿木墙开路 → 烟雾挡住视线 → 守卫听见声音赶来 → 水渠把火线切断。

**Phase 说明**：`✅ 已实现` / `🧪 试验` / `📋 规划`。

---

## 一、bwe.material — 材质

> 材质是「涌现的第一性」：**一切熔 / 燃 / 湿 / 导电都由这几个数字推导**，不写死具体地块。
> 材质有两个来源：**格子层面**（`setTile` / TILE 对象的素材名自动匹配）和**实体层面**（`setEntity`）。

## 1.1 内置材质

| 名称 | flammable | burnTime | conductive | hardness | density | tags |
|---|---|---|---|---|---|---|
| `stone` | 0 | — | false | 8 | 3 | `mineral` `wall` |
| `wood` | 0.6 | 3.5 | false | 3 | 1 | `plant` `wood` `solid` |
| `grass` | 0.8 | 1.2 | false | 1 | 0.6 | `plant` `ground` |
| `oil` | 1.0 | 2.5 | false | 0.5 | 0.9 | `fuel` `liquid` |
| `cloth` | 0.9 | 2.0 | false | 0.5 | 0.5 | `fabric` |
| `metal` | 0 | — | **true** | 9 | 7 | `metal` `conductive` |
| `water` | 0（强制） | — | **true** | 0 | 1 | `liquid` `water` |
| `ice` | 0 | — | false | 2 | 0.9 | `ice` `cold` |
| `glass` | 0 | — | false | 1.5 | 2.5 | `glass` `fragile` |
| `poisonPlant` | 0.7 | 2.5 | false | 1 | 0.7 | `plant` `poison` |

**素材名 → 材质名的自动匹配**（用于 TILE 对象和实体，中英文都认）：

```
poisonPlant / poison / 毒 / 毒草      → poisonPlant
glass / 玻璃                          → glass
metal / iron / steel / 金属 / 铁 / 钢 / 铜 → metal
ice / 冰                              → ice
water / 水                            → water
oil / 油                              → oil
cloth / fabric / 布 / 丝绸 / 绸         → cloth
wood / plank / log / crate / 木 / 箱   → wood
grass / moss / 草                     → grass
stone / rock / wall / brick / 石 / 墙 / 岩 / 砖 → stone
```

匹配不上的**默认 `stone`**（不燃，安全）。
⚠ `water` 是**特殊**的：它名字或 tags 里含 `water` 就会被判成「水材质」，此时 `flammable` 被**强制清零**（防止脚本把 water 定义成可燃后出现「水在燃烧」）。

---

### bwe.material.define(name, props) → Material

**签名**
`bwe.material.define(name: string, props: MaterialProps): Material | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 材质名（大小写不敏感）；空字符串返回 `null` |
| props.flammable | number | 易燃度 0~1（自动钳制）；0 = 不可燃 |
| props.burnTime | number | 烧尽需要几秒（负数按 0）；`<= 0` 时实际燃烧按 2 秒算 |
| props.conductive | boolean | 是否导电 |
| props.wet | boolean | 初始是否湿（湿了易燃度折减） |
| props.hardness | number | 破坏所需伤害，默认 1；影响火焰对**实体**的伤害倍率 |
| props.density | number | 物理密度倍数，默认 1 |
| props.tags | string[] | 语义标签 |

**返回**
`Material` — 材质对象快照 `{name, flammable, burnTime, conductive, wet, hardness, density, tags}`；失败 `null`

**说明**
✅ 已实现。**定义 / 覆盖**材质（同名直接替换）。没给的字段保持该名字原名材质的旧值（不是重置成默认）—— 所以「只想改 grass 的 burnTime」可以只传那一个字段。
返回的是**快照**，改它不影响注册表。

**示例**
```js
bwe.material.define("grass", { flammable: 0.9, burnTime: 0.8 });   // 草烧得更快
bwe.material.define("magma", {
  flammable: 0, burnTime: 0, conductive: true, hardness: 10, density: 5, tags: ["rock", "hot"]
});
bwe.log(bwe.material.get("magma").hardness);
```

**另见**
[bwe.material.get](#bwematerialgetname--material--null) · [bwe.material.tags](#bwematerialtagsname--string)

---

### bwe.material.get(name) → Material | null

**签名**
`bwe.material.get(name: string): Material | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 材质名（大小写不敏感） |

**返回**
`Material | null` — `{name, flammable, burnTime, conductive, wet, hardness, density, tags}`；不存在返回 `null`

**说明**
✅ 已实现。返回**新建的快照对象**（每次调用都新建）。改它不影响注册表。

**示例**
```js
var m = bwe.material.get("wood");
if (m) {
  bwe.log("木头易燃度 " + m.flammable + "，烧 " + m.burnTime + " 秒");
}
```

**另见**
[bwe.material.define](#bwematerialdefinename-props--material) · [bwe.material.of](#bwematerialofcx-cy--string--null)

---

### bwe.material.tags(name) → string[]

**签名**
`bwe.material.tags(name: string): string[]`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 材质名 |

**返回**
`string[]` — 语义标签；材质不存在返回**空数组**

**说明**
✅ 已实现。用于「这一类材质都算可燃物」这类批量判断。

**示例**
```js
if (bwe.material.tags("grass").indexOf("plant") >= 0) {
  bwe.log("草是植物类");
}
```

**另见**
[bwe.material.get](#bwematerialgetname--material--null)

---

### bwe.material.of(cx, cy) → string | null

**签名**
`bwe.material.of(cx: number, cy: number): string | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| cx | number | 格子 X |
| cy | number | 格子 Y |

**返回**
`string | null` — 该格**当前有效的**材质名；`null` = 空 / 越界

**说明**
✅ 已实现。有效材质按优先级取：**脚本固定过的**（`setTile`）→ 该格实体的材质 → `null`。
⚠ **`setTile` 的优先级最高**：它会把格子标成「脚本固定」，之后 TILE 对象的材质（`props.material` / 素材名）**不会再覆盖它**。想用 TILE 表现石墙，就别先给整片区域 `setTile("stone")` 再指望石墙对象生效。

**示例**
```js
var mx = bwe.input.mouse.worldX;
var my = bwe.input.mouse.worldY;
var c = bwe.grid.toCell(mx, my);
bwe.log("鼠标格子材质：" + bwe.material.of(c.cx, c.cy));
```

**另见**
[bwe.material.setTile](#bwematerialsettilcx-cy-name--void) · [bwe.material.ofEntity](#bwematerialofentitye--string--null)

---

### bwe.material.setTile(cx, cy, name) → void

**签名**
`bwe.material.setTile(cx: number, cy: number, name: string | null): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| cx | number | 格子 X（越界忽略） |
| cy | number | 格子 Y |
| name | `string \| null` | 材质名；`null` / 空字符串 = **清空**该格材质 |

**返回**
`void`

**说明**
✅ 已实现。改格子材质并**标记为脚本固定**（优先级最高，覆盖 TILE 对象）。
⚠ 设成水系材质（`water` 或带 `water` 标签）会立刻变成**永久水源**（火会被扑灭、相邻材质被泡湿）。

**示例**
```js
// 铺一片草地（注意：这会让这片区域里 TILE 对象自己的材质失效）
for (var cx = 10; cx < 20; cx++) {
  for (var cy = 5; cy < 12; cy++) {
    bwe.material.setTile(cx, cy, "grass");
  }
}

// 清掉一格
bwe.material.setTile(10, 5, null);
```

**另见**
[bwe.material.of](#bwematerialofcx-cy--string--null) · [bwe.tilemap.set](map-nav-interact-spawner.md#bwetilemapsetcx-cy-tileid--void)（数据层，不是材质层）

---

### bwe.material.ofEntity(e) → string | null

**签名**
`bwe.material.ofEntity(e: Entity): string | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体；无效返回 `null` |

**返回**
`string | null` — 实体材质名；**总有值**（兜底 `stone`，除非实体无效）

**说明**
✅ 已实现。解析顺序：`setEntity` 显式设过的 → 实体 `props.material` / 名字匹配内置别名 → 兜底 `stone`。

**示例**
```js
var crate = bwe.world.find("木箱");
bwe.log("木箱材质：" + bwe.material.ofEntity(crate));   // → "wood"
```

**另见**
[bwe.material.setEntity](#bwematerialsetentitye-name--void)

---

### bwe.material.setEntity(e, name) → void

**签名**
`bwe.material.setEntity(e: Entity, name: string): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体 |
| name | string | 材质名；空字符串 = 不改 |

**返回**
`void`

**说明**
✅ 已实现。显式指定实体材质，**优先级最高的实体层来源**。玩家 / 怪物 / 道具都能设。

**示例**
```js
var barrel = bwe.world.find("油桶");
bwe.material.setEntity(barrel, "oil");       // 现在它极易燃
```

**另见**
[bwe.material.ofEntity](#bwematerialofentitye--string--null)

---

## 二、bwe.field — 多通道格子场（火 / 水 / 烟 / 自定义）

> **固定步长模拟**：默认 `0.1s / tick`，与帧率解耦。同种子 + 同输入 ⇒ 同结果。
> 三个内置通道：`fire`（火）、`water`（水）、`smoke`（烟）。自定义通道用 `channel(name)` 创建。

## 2.1 内置规则（全部走材质属性，不写死具体关卡）

| 通道 | 规则 |
|---|---|
| **fire** | 强度随时间衰减；相邻格若 `flammable > 0` 则按 `flammable × intensity` 累积概率自燃；烧够 `burnTime` 后该格材质变 `null`（**烧穿墙就开出一条路**）；相邻**实体**按材质受损（易燃物快、金属/石头只被炙烤） |
| **water** | 扑灭同格与相邻格 fire；把材质标记为 `wet`（易燃度 ×0.5）；水系材质是**永久水源** |
| **smoke** | fire 产生；向上 / 顺风扩散并衰减；遮挡视线（`bwe.sense.canSee` 判定受影响）；可被 `field.wind` 吹散 |
| **oil / poison** | 用同一套通道 + 材质驱动，**不新增特例** |

模拟只遍历**活跃格**（有强度或邻接活跃格），大地图也不会 O(全图)。

---

### bwe.field.emit(channel, cx, cy, intensity?) → void

**签名**
`bwe.field.emit(channel: string, cx: number, cy: number, intensity?: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| channel | string | 通道名，默认 `"fire"`；不存在会自动建一个 |
| cx | number | 格子 X（越界忽略） |
| cy | number | 格子 Y |
| intensity | number | 强度，默认 1；负数按 0，超过通道上限时钳到上限 |

**返回**
`void`

**说明**
✅ 已实现。「点火 / 灌水 / 放烟」的唯一入口。**这是加法式的「设置」**：写入强度（不是累加）。
⚠ 想「加点柴让它更旺」要自己读 `sample` 再 `emit` 更大的值。

**示例**
```js
// 点一格火
var c = bwe.grid.toCell(bwe.input.mouse.worldX, bwe.input.mouse.worldY);
bwe.field.emit("fire", c.cx, c.cy, 1.0);

// 灌水灭火
bwe.field.emit("water", c.cx, c.cy, 1.0);

// 自定义通道
bwe.field.channel("poison").max(1);
bwe.field.emit("poison", c.cx, c.cy, 0.6);
```

**另见**
[bwe.field.sample](#bwefiledsamplechannel-cx-cy--number) · [bwe.field.burning](#bwefieldburning--burningcell)

---

### bwe.field.sample(channel, cx, cy) → number

**签名**
`bwe.field.sample(channel: string, cx: number, cy: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| channel | string | 通道名，默认 `"fire"` |
| cx | number | 格子 X |
| cy | number | 格子 Y |

**返回**
`number` — 该通道在该格的强度（0 表示没有）；越界返回 0

**说明**
✅ 已实现。**只读**，不会激活格子 / 不产生副作用。

**示例**
```js
var heat = bwe.field.sample("fire", 12, 8);
bwe.log("(12,8) 火势 = " + heat.toFixed(2));
```

**另见**
[bwe.field.emit](#bwefieldemitchannel-cx-cy-intensity--void) · [bwe.field.burning](#bwefieldburning--burningcell)

---

### bwe.field.clear(channel) → void

**签名**
`bwe.field.clear(channel: string): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| channel | string | 通道名；空字符串 = **清空所有通道** |

**返回**
`void`

**说明**
✅ 已实现。清空通道强度。清 `fire` 时还会顺带取消所有正在燃烧的格（并派发 `extinguish` 事件，`cause = "clear"`）。

**示例**
```js
bwe.field.clear("fire");
bwe.field.clear("");        // 所有通道一起清
```

**另见**
[bwe.field.on](#bwefieldonev-fn--void)

---

### bwe.field.tickRate(sec?) → number

**签名**
`bwe.field.tickRate(sec?: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| sec | number | 模拟步长（秒）；省略 = **只读不改**。钳制到 `[0.01, 1]` |

**返回**
`number` — 设置/读取后的当前步长（默认 0.1）

**说明**
✅ 已实现。**双用途**：不传参 = 查询；传参 = 设置并返回新值。步长越小越精细但越耗 CPU。

**示例**
```js
var rate = bwe.field.tickRate();       // 读
bwe.field.tickRate(0.05);              // 设成更精细
```

**另见**
[bwe.field.channel](#bwefieldchannelname--channelhandle)

---

### bwe.field.channel(name) → ChannelHandle

**签名**
`bwe.field.channel(name: string): { name: string; max(v?: number): number }`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 通道名；不存在会**新建**（空名字会得到空名通道） |

**返回**
`ChannelHandle` — `{ name }`，另带 `max(v?)` 方法

**说明**
✅ 已实现。`max(v?)` 同样是双用途：不传参 = 读上限；传参 = 设上限并返回新值。上限钳制到 `[0.01, 1000]`。
⚠ 每次调用 `channel(name)` 都新建一个包装对象（但底层通道是同一个）。

**示例**
```js
var poison = bwe.field.channel("poison");
poison.max(1);
bwe.log("poison 上限 = " + poison.max());
bwe.field.emit("poison", 5, 5, 0.8);
```

**另见**
[bwe.field.emit](#bwefieldemitchannel-cx-cy-intensity--void)

---

### bwe.field.wind(dx, dy) → Vec2

**签名**
`bwe.field.wind(dx?: number, dy?: number): { x: number; y: number }`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| dx | number | 风向 X 分量；钳制到 `[-1, 1]`。省略 = **只读** |
| dy | number | 风向 Y 分量；钳制到 `[-1, 1]` |

**返回**
`Vec2` — 当前风向 `{x, y}`（保留 4 位小数）

**说明**
✅ 已实现。双用途：不传参 = 读；传参（需要**两个参数都有**）= 设置并返回新值。影响烟雾扩散与火势偏向。

**示例**
```js
bwe.field.wind(0, -1);            // 风朝上（Y 向下为负 = 向上）
var w = bwe.field.wind();
bwe.log("风向 " + w.x + "," + w.y);
```

**另见**
[bwe.field.emit](#bwefieldemitchannel-cx-cy-intensity--void)

---

### bwe.field.on(ev, fn) → () => void

**签名**
`bwe.field.on(ev: "ignite" | "extinguish" | "burned", fn: Function): () => void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ev | string | 事件名（见下表）；空字符串 / `fn` 非函数时返回 `null` |
| fn | Function | 回调，载荷见下表 |

**返回**
`() => void` — **取消订阅函数**（调用它即可摘掉这个回调）

**说明**
✅ 已实现。事件与载荷：

| 事件 | 触发点 | 载荷字段 |
|---|---|---|
| `"ignite"` | 某格开始燃烧 | `{cx, cy, material, entity}` |
| `"extinguish"` | 火被扑灭 | `{cx, cy, cause}`，`cause` ∈ `"water"` / `"decay"` / `"burned"` / `"clear"` |
| `"burned"` | 该格烧尽 / 烧穿 | `{cx, cy, material}` |

⚠ `"ignite"` 只在**开始燃烧的那一刻**派发一次（同一格再次自燃不会重复派发）。

**示例**
```js
function onSceneStart(ctx) {
  // 方式一：接住取消函数
  var off = bwe.field.on("ignite", function (info) {
    bwe.log("点着了 " + info.cx + "," + info.cy + "（" + info.material + "）");
  });
  // 不想再听了就调它
  // off();

  bwe.field.on("burned", function (info) {
    bwe.log("烧穿 " + info.cx + "," + info.cy + " 的 " + info.material);
  });
}
```

**另见**
[bwe.field.off](#bwefieldoffev-fn--void) · [bwe.field.burning](#bwefieldburning--burningcell) · [bwe.material.define](#bwematerialdefinename-props--material)

---

### bwe.field.off(ev, fn) → void

**签名**
`bwe.field.off(ev: "ignite" | "extinguish" | "burned", fn?: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ev | string | 事件名 |
| fn | Function? | 给了就只摘这一个回调；**不给就清空该事件的全部回调** |

**返回**
`void`

**说明**
✅ 已实现。与 `bwe.field.on` 返回的取消函数等价，区别是这里按「事件 + 函数引用」定位。
清空整个事件适合「切场景时一次性拆干净」。

**示例**
```js
bwe.field.off("ignite", myHandler);   // 只摘这一个
bwe.field.off("ignite");              // 全部清空
```

**另见**
[bwe.field.on](#bwefieldonev-fn--void)

---

### bwe.field.burning() → BurningCell[]

**签名**
`bwe.field.burning(): { cx, cy, intensity, material }[]`

**参数**
无

**返回**
`BurningCell[]` — 当前火势 `> 0.01` 的格子；`material` 可能是 `null`

**说明**
✅ 已实现。**调试 / UI 专用**：引擎不给火焰上色，想让玩家「看见」火就得自己按格子画。每帧调一次开销与燃烧格数成正比。

**示例**
```js
function onUpdate(ctx, dt) {
  var cells = bwe.field.burning();
  bwe.draw.world(function () {
    for (var i = 0; i < cells.length; i++) {
      var p = bwe.grid.toWorld(cells[i].cx, cells[i].cy);
      bwe.draw.rect(p.x - 16, p.y - 16, 32, 32,
        { fill: "#ff4400", alpha: Math.min(0.8, cells[i].intensity) });
    }
  });
}
```

**另见**
[bwe.draw.world](draw-audio-save.md#bwedrawworldfn--void) · [bwe.field.sample](#bwefiledsamplechannel-cx-cy--number)

---

## 三、bwe.noise — 噪音（AI 的第二感知通道）

### bwe.noise.emit(x, y, opts?) → void

**签名**
`bwe.noise.emit(x: number, y: number, opts?: { radius?: number; intensity?: number; tag?: string }): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 声源世界 X |
| y | number | 声源世界 Y |
| opts.radius | number | 基础半径（像素），默认 260 |
| opts.intensity | number | 强度，默认 1（有效半径乘 `clamp(intensity, 0.25, 3)`） |
| opts.tag | string | 语义标签（如 `"combat"`），默认 `""` |

**返回**
`void`

**说明**
✅ 已实现。制造噪音并**立即**通知所有挂了 `bwe.ai.attach` 的实体（不是延迟派发）。
有效听见距离：`min(radius, ai.hearing) × 0.55^隔墙数 × clamp(intensity, 0.25, 3)` —— 一道墙 **×0.55**，两道 ≈ **×0.30**。
听见之后：
- `ai` 的记忆里写入「听到的位置」，`knownFrom = "noise"`
- `sense.audible(e)` 在接下来的 **0.4 秒**内为 `true`

**示例**
```js
// 打斗噪音
bwe.noise.emit(ctx.self.x, ctx.self.y, { radius: 300, intensity: 1.2, tag: "combat" });

// 扔石头引开守卫
bwe.noise.emit(farX, farY, { radius: 420, tag: "distract" });
```

**另见**
[bwe.noise.events](#bwenoiseevents--noiseevent) · [bwe.ai.attach](#bweaiattache-opts--void) · [bwe.sense.audible](#bwesenseaudiblee--boolean)

---

### bwe.noise.events() → NoiseEvent[]

**签名**
`bwe.noise.events(): { x, y, radius, intensity, tag, age }[]`

**参数**
无

**返回**
`NoiseEvent[]` — 最近 **2 秒**内的噪音事件（`age` 是距今秒数）

**说明**
✅ 已实现。每次调用会先清理过期事件。**调试 / 自己的 AI 决策**用。

**示例**
```js
var list = bwe.noise.events();
for (var i = 0; i < list.length; i++) {
  bwe.log("噪音 " + list[i].tag + " @" + list[i].x + "," + list[i].y + " 距今 " + list[i].age.toFixed(2) + "s");
}
```

**另见**
[bwe.noise.emit](#bwenoiseemitx-y-opts--void) · [bwe.sense.lastKnown](#bwesenselastknowne--lastknown--null)

---

## 四、bwe.sense — 感知

### bwe.sense.canSee(a, b) → boolean

**签名**
`bwe.sense.canSee(a: Entity, b: Entity): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| a | Entity | 观察者 |
| b | Entity | 被观察者 |

**返回**
`boolean`

**说明**
✅ 已实现。综合判定：**视野半径 + FOV（视野角）+ 瓦片遮挡 + 烟雾**。任一不满足就 `false`。
`a` 没挂 `ai.attach` 时用兜底参数：**全向（FOV 360）、半径 512**。
`b` 不可见（`visible === false`）或已死 → `false`。

**示例**
```js
var guard = bwe.world.find("守卫");
var player = bwe.world.find("玩家");
if (bwe.sense.canSee(guard, player)) {
  bwe.log("守卫看见了玩家");
}
```

**另见**
[bwe.sense.inSightRange](#bwesenseinsightrangea-b--boolean) · [bwe.ai.attach](#bweaiattache-opts--void) · [bwe.nav.lineOfSight](map-nav-interact-spawner.md#bwenavlineofsighta-b--boolean)（只判瓦片遮挡）

---

### bwe.sense.inSightRange(a, b) → boolean

**签名**
`bwe.sense.inSightRange(a: Entity, b: Entity): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| a | Entity | 观察者 |
| b | Entity | 被观察者 |

**返回**
`boolean`

**说明**
✅ 已实现。**只判距离**（`sight` 半径），不看视野角、不看遮挡、不看烟雾。适合「玩家进入警戒范围就开始接近」这类早期反应。

**示例**
```js
if (bwe.sense.inSightRange(guard, player)) {
  bwe.ai.setState(guard, "alert");
}
```

**另见**
[bwe.sense.canSee](#bwesensecanseea-b--boolean)

---

### bwe.sense.audible(e) → boolean

**签名**
`bwe.sense.audible(e: Entity): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 实体（需挂 `ai.attach`） |

**返回**
`boolean`

**说明**
✅ 已实现。**听到之后 0.4 秒内为真**（`HEARD_HOLD`），避免脚本只在 emit 那一帧能查询。没挂 `ai.attach` 的实体恒 `false`。

**示例**
```js
if (bwe.sense.audible(ctx.self)) {
  var known = bwe.sense.lastKnown(ctx.self);
  if (known) {
    bwe.ai.setState(ctx.self, "investigate");
    bwe.log("去看看 " + known.x + "," + known.y);
  }
}
```

**另见**
[bwe.noise.emit](#bwenoiseemitx-y-opts--void) · [bwe.sense.lastKnown](#bwesenselastknowne--lastknown--null)

---

### bwe.sense.lastKnown(e) → LastKnown | null

**签名**
`bwe.sense.lastKnown(e: Entity): LastKnown | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 实体（需挂 `ai.attach`） |

**返回**
`LastKnown | null` — `{x, y, age, from}`；没记忆或已超时返回 `null`

| 字段 | 说明 |
|---|---|
| `x, y` | 记住的位置 |
| `age` | 距今多少秒 |
| `from` | 来源：`"sight"`（看见）/ `"noise"`（听见）/ `"alert"`（同伴警报）。未命中过时是 `""` |

**说明**
✅ 已实现。记忆超过 `ai.memory` 秒（默认 6）就自动清除并返回 `null`。读取时也会顺带清理过期记忆。

**示例**
```js
var k = bwe.sense.lastKnown(ctx.self);
if (k) {
  bwe.log("记得目标在 " + k.x + "," + k.y + "（来自 " + k.from + "，" + k.age.toFixed(1) + " 秒前）");
  bwe.nav.follow(ctx.self, bwe.nav.find(ctx.self, { x: k.x, y: k.y }), { speed: 90 });
}
```

**另见**
[bwe.ai.attach](#bweaiattache-opts--void) · [bwe.ai.target](#bweaitargete--entity--null)

---

## 五、bwe.faction — 阵营

### bwe.faction.set(e, name) → void

**签名**
`bwe.faction.set(e: Entity, name: string | null): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体；无效空操作 |
| name | `string \| null` | 阵营名；`null` / 空 / 字符串 `"null"` = **清除阵营** |

**返回**
`void`

**说明**
✅ 已实现。阵营是 AI 自动找目标的前提 —— **没阵营的实体不会被任何 AI 当作敌对候选**。

**示例**
```js
bwe.faction.set(guard, "guard");
bwe.faction.set(bandit, "bandit");
bwe.faction.set(player, "player");
```

**另见**
[bwe.faction.hostile](#bwefactionhostilea-b--boolean) · [bwe.faction.members](#bwefactionmembersname--entity)

---

### bwe.faction.relation(a, b, v?) → number

**签名**
`bwe.faction.relation(a: Entity | string, b: Entity | string, v?: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| a | `Entity \| string` | 实体或阵营名 |
| b | `Entity \| string` | 实体或阵营名 |
| v | number | 省略 = **只读**；给了就**设置**（钳制到 `-1 / 0 / 1`） |

**返回**
`number` — `-1` 敌 / `0` 中立 / `1` 友

**说明**
✅ 已实现。**双用途**。关系是**双向同步**的（设 A→B 同时设 B→A）。
默认规则：**同名阵营 = 友（`1`）**；没显式设过的不同阵营 = 中立（`0`）。

**示例**
```js
bwe.faction.relation("guard", "bandit", -1);      // 设为敌对（双向）
bwe.log(bwe.faction.relation("guard", "bandit")); // 读 → -1
bwe.log(bwe.faction.relation("guard", "guard"));  // → 1（同名自动友）
```

**另见**
[bwe.faction.hostile](#bwefactionhostilea-b--boolean)

---

### bwe.faction.hostile(a, b) → boolean

**签名**
`bwe.faction.hostile(a: Entity, b: Entity): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| a | Entity | 实体 |
| b | Entity | 实体 |

**返回**
`boolean`

**说明**
✅ 已实现。任一方**没阵营** → `false`（不会因为「没阵营」而互相敌对）。同一实体 → `false`。

**示例**
```js
if (bwe.faction.hostile(guard, player)) {
  bwe.log("是敌人");
}
```

**另见**
[bwe.faction.relation](#bwefactionrelationa-b-v--number)

---

### bwe.faction.members(name) → Entity[]

**签名**
`bwe.faction.members(name: string): Entity[]`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 阵营名 |

**返回**
`Entity[]` — 该阵营所有存活成员（新数组）

**说明**
✅ 已实现。

**示例**
```js
var guards = bwe.faction.members("guard");
bwe.log("守卫还有 " + guards.length + " 个");
```

**另见**
[bwe.faction.set](#bwefactionsete-name--void)

---

## 六、bwe.ai — 感知 · 记忆 · 状态存储 · 警报

> 引擎**只做感知 / 记忆 / 状态存储 / 警报传播**；「看到之后干什么」由 JS 决定。
> 引擎**不定义任何状态语义** —— `state` 只是一个字符串，随便你用（`"idle"` / `"chase"` / `"烤火"` 都行）。

### bwe.ai.attach(e, opts?) → void

**签名**
`bwe.ai.attach(e: Entity, opts?: AiOpts): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体；无效空操作 |
| opts.sight | number | 视野半径（像素），默认 260 |
| opts.fov | number | 视野角（度），默认 120；`360` = 不需要转头 |
| opts.hearing | number | 听觉半径（像素），默认 300 |
| opts.memory | number | 记忆保持秒数，默认 6 |
| opts.speed | number | 移动速度（px/s），默认 90 —— ⚠ **引擎只存不驱动**，见说明 |

**返回**
`void`

**说明**
✅ 已实现。给实体挂上感知状态。重复 attach **不会重置**已有参数（只覆盖你给出的字段）。
⚠ **`speed` 目前只是个存储值** —— 引擎的 AI 子步**不用它**移动实体（没有内置移动行为）。要动请在脚本里用 `bwe.nav.follow` / 自己改 `x,y`，把这个值当自己的配置读出来用。

**示例**
```js
bwe.ai.attach(guard, { sight: 320, fov: 110, hearing: 360, memory: 8, speed: 100 });
bwe.faction.set(guard, "guard");
```

**另见**
[bwe.ai.detach](#bweaidetache--void) · [bwe.sense.canSee](#bwesensecanseea-b--boolean)

---

### bwe.ai.detach(e) → void

**签名**
`bwe.ai.detach(e: Entity): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体 |

**返回**
`void`

**说明**
✅ 已实现。摘掉感知状态（记忆、状态、目标一起丢失）。之后再 `sense.*` / `ai.state` 都拿不到东西。

**示例**
```js
bwe.ai.detach(guard);     // 让它「变瞎」
```

**另见**
[bwe.ai.attach](#bweaiattache-opts--void)

---

### bwe.ai.state(e) → string | null

**签名**
`bwe.ai.state(e: Entity): string | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体 |

**返回**
`string | null` — 当前状态字符串；没 attach 返回 `null`

**说明**
✅ 已实现。初始状态是 `"idle"`。**引擎不会改它** —— 只有 `setState` 或你自己的脚本会写。

**示例**
```js
bwe.log("守卫状态：" + bwe.ai.state(guard));
```

**另见**
[bwe.ai.setState](#bweaistatesete-s--void)

---

### bwe.ai.setState(e, s) → void

**签名**
`bwe.ai.setState(e: Entity, s: string): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体 |
| s | string | 新状态；空字符串 = 不修改 |

**返回**
`void`

**说明**
✅ 已实现。没 attach 的实体是空操作（不会自动 attach）。

**示例**
```js
bwe.ai.setState(guard, "investigate");
```

**另见**
[bwe.ai.state](#bweaistatee--string--null)

---

### bwe.ai.target(e) → Entity | null

**签名**
`bwe.ai.target(e: Entity): Entity | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体 |

**返回**
`Entity | null` — 引擎自动锁定的最近可见敌对目标；没有返回 `null`

**说明**
✅ 已实现。引擎每 tick 按「**阵营敌对 + 视野内可见 + 最近**」自动找目标并存下来。
失效条件：目标已死 → 清；目标当前不可见且**记忆超时** → 清。
读取时会重新校验一次有效性。

**示例**
```js
var t = bwe.ai.target(guard);
if (t) {
  bwe.log("锁定 " + t.name + "，距离 " + guard.distanceTo(t));
  bwe.ai.setState(guard, "chase");
}
```

**另见**
[bwe.sense.lastKnown](#bwesenselastknowne--lastknown--null) · [bwe.faction.hostile](#bwefactionhostilea-b--boolean)

---

### bwe.ai.alert(e, pos) → void

**签名**
`bwe.ai.alert(e: Entity, pos: Vec2 | Entity): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 发警报的实体（必须有阵营） |
| pos | `Vec2 \| Entity` | 警报位置 |

**返回**
`void`

**说明**
✅ 已实现。同阵营**警报传播**，有**一跳延迟**：本 tick 发出的警报在**下一个模拟 tick**才投递给同阵营其他成员（排除发起者自己）。
⚠ 没阵营的实体调用它**什么都不发生**（引擎直接返回）。
被通知的成员如果不是当前可见目标，会把警报位置写进记忆（`knownFrom = "alert"`）。

**示例**
```js
bwe.ai.alert(guard, { x: player.x, y: player.y });   // 喊人
bwe.ai.alert(guard, player);                          // 也可以直接传实体
```

**另见**
[bwe.ai.onAlert](#bweaionalertfn--void) · [bwe.faction.set](#bwefactionsete-name--void)

---

### bwe.ai.onAlert(fn) → void

**签名**
`bwe.ai.onAlert(fn: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| fn | Function | `fn(info)`；`info = {entity, position, from}` |

**返回**
`void`（**不返回取消函数** —— 没有取消订阅）

**说明**
✅ 已实现。`info` 的字段：

| 字段 | 说明 |
|---|---|
| `entity` | **收到**警报的那个实体（不是发警报的！） |
| `position` | 警报位置 `{x, y}` |
| `from` | 发警报的实体（可能已是 `null`） |

⚠ payload 里 `entity` 是「收到警报的那一方」，`from` 才是发警报的一方 —— **写反了会导致警报链只生效一半**。
⚠ 这是**全局注册**（不是脚本级单例）：同一段脚本挂到 2 个对象上、`onStart` 里各注册一次 → 同一条警报回调执行 **2 次**。用全局标记位防重。

**示例**
```js
var G = { alertHooked: false };

function onSceneStart(ctx) {
  if (G.alertHooked) { return; }
  G.alertHooked = true;
  bwe.ai.onAlert(function (info) {
    bwe.log(info.entity.name + " 收到 " + (info.from ? info.from.name : "?") + " 的警报");
  });
}
```

**另见**
[bwe.ai.alert](#bweaialerte-pos--void) · [bwe.ai.onSpot](#bweaionspotfn--void)

---

### bwe.ai.onSpot(fn) → void

**签名**
`bwe.ai.onSpot(fn: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| fn | Function | `fn(info)`；`info = {entity, target}` |

**返回**
`void`（**不返回取消函数**）

**说明**
✅ 已实现。**只在「第一次发现」时触发**：`entity` 是发现者，`target` 是新锁定的目标。同一目标持续可见**不会**重复触发。
同样有「全局注册」的问题（见 `onAlert`）。

**示例**
```js
bwe.ai.onSpot(function (info) {
  bwe.log(info.entity.name + " 发现了 " + info.target.name);
  bwe.noise.emit(info.entity.x, info.entity.y, { radius: 260, tag: "alert" });
});
```

**另见**
[bwe.ai.onAlert](#bweaionalertfn--void)

---

## 七、bwe.target — 感知式拾取器

### bwe.target.cell() → TargetCell | null

**签名**
`bwe.target.cell(): { cx, cy, x, y, material } | null`

**参数**
无

**返回**
`TargetCell` — 鼠标所在格子：`{cx, cy, x, y, material}`。`x/y` 是格子中心的世界坐标；**越界返回 `null`**

**说明**
✅ 已实现。用 `bwe.input.mouse` 的屏幕坐标反变换成世界坐标，再取格子。

**示例**
```js
var c = bwe.target.cell();
if (c) {
  bwe.log("鼠标在格子 " + c.cx + "," + c.cy + "，材质 " + c.material);
  bwe.field.emit("fire", c.cx, c.cy, 0.8);
}
```

**另见**
[bwe.target.entity](#bwetargetentity--entity--null) · [bwe.material.of](#bwematerialofcx-cy--string--null)

---

### bwe.target.entity() → Entity | null

**签名**
`bwe.target.entity(): Entity | null`

**参数**
无

**返回**
`Entity | null` — 鼠标下**最上层**的可见实体；没有返回 `null`

**说明**
✅ 已实现。命中顺序与绘制相反（`layer` → `z` → `y`，从上往下找）。

**示例**
```js
if (bwe.input.pressed("Mouse0")) {
  var hit = bwe.target.entity();
  if (hit) { hit.setAlpha(0.5); }
}
```

**另见**
[bwe.target.cell](#bwetargetcell--targetcell--null)

---

### bwe.target.inFront(e, range?) → Entity | Cell | null

**签名**
`bwe.target.inFront(e: Entity, range?: number): Entity | TargetCell | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 参考实体（用它的朝向 `faceX/faceY`） |
| range | number | 探测距离（像素），默认 = `tileSize`（1 格） |

**返回**
`Entity` = 面前的实体；`TargetCell` = 面前没实体时的格子；`e` 无效时 `null`

**说明**
✅ 已实现。参考实体的朝向由「上次移动方向」决定（引擎内部 `faceX/faceY`）；**没移动过时默认朝下**（`0, 1`）。
命中自己不算，会退回返回「面前的格子」。

**示例**
```js
if (bwe.input.pressed("KeyE")) {
  var thing = bwe.target.inFront(ctx.self, 40);
  if (thing && thing.cx !== undefined) {
    bwe.log("面前是格子 " + thing.cx + "," + thing.cy);
  } else if (thing) {
    bwe.log("面前是 " + thing.name);
  }
}
```

**另见**
[bwe.target.entity](#bwetargetentity--entity--null)

---

## 八、bwe.physics — jbox2d 桥接

> **默认关闭**。必须先 `bwe.physics.enable()`，否则 `body()` 返回 `null` 并写一条告警。
> 内部用米（`PX_PER_M = 32`，即 **1 格 = 1 米**），避免 Box2D 在像素量级坐标上丢精度。
> 固定步长 `1/60` 秒；每帧最多补若干步，追不上就丢弃累积（不会越积越多）。
> **瓦片阻挡格会自动成为静态墙**（每 0.25 秒重扫一次）。

### bwe.physics.enable() → boolean

**签名**
`bwe.physics.enable(): boolean`

**参数**
无

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。打开物理子步（幂等，重复调用无副作用）。第一次调用会建 Box2D 世界 + 扫瓦片建静态墙，并写一条日志。
默认无重力（俯视角）、开启连续碰撞检测（高速抛掷不穿墙）。

**示例**
```js
function onSceneStart(ctx) {
  bwe.physics.enable();
  bwe.physics.gravity(0);       // 俯视角：无重力
}
```

**另见**
[bwe.physics.enabled](#bwephysicsenabled--boolean) · [bwe.physics.gravity](#bwephysicsgravitygy--number)

---

### bwe.physics.enabled() → boolean

**签名**
`bwe.physics.enabled(): boolean`

**参数**
无

**返回**
`boolean`

**说明**
✅ 已实现。（同名属性 `enabled` 是**方法**，不是 boolean 属性 —— `bwe.physics.enabled()` 带括号。）

**示例**
```js
if (!bwe.physics.enabled()) {
  bwe.physics.enable();
}
```

**另见**
[bwe.physics.enable](#bwephysicsenable--boolean)

---

### bwe.physics.gravity(gy?) → number

**签名**
`bwe.physics.gravity(gy?: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| gy | number | 重力（px/s²）；**省略 = 只读**。俯视角默认 0 |

**返回**
`number` — 当前重力

**说明**
✅ 已实现。双用途。`gy > 0` 是**向下**（Y 轴向下）。已有世界会立刻生效。

**示例**
```js
bwe.physics.gravity();        // 读，→ 0
bwe.physics.gravity(0);       // 俯视角
bwe.physics.gravity(600);     // 侧视角 / 掉落物
```

**另见**
[bwe.physics.enable](#bwephysicsenable--boolean)

---

### bwe.physics.debug(on?) → boolean

**签名**
`bwe.physics.debug(on?: boolean): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| on | boolean | **省略 = 只读**；`true` 打开碰撞体线框 |

**返回**
`boolean` — 当前开关

**说明**
✅ 已实现。双用途。打开后每帧把所有刚体画成线框（发布前记得关）。

**示例**
```js
bwe.physics.debug(true);
bwe.log("调试绘制：" + bwe.physics.debug());
```

**另见**
[bwe.physics.body](#bwephysicsbodye-opts--entity--null)

---

### bwe.physics.body(e, opts) → Entity | null

**签名**
`bwe.physics.body(e: Entity, opts: BodyOpts): Entity | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体（必须是 Entity，否则写告警并返回 `null`） |
| opts.type | string | `"dynamic"`（默认）/ `"kinematic"` / `"static"` |
| opts.shape | string | `"box"`（默认）/ `"circle"` |
| opts.radius | number | 圆形半径（像素）；默认 = 尺寸短边的一半 |
| opts.halfW | number | 方盒半宽（像素）；默认 = 绘制宽的一半 |
| opts.halfH | number | 方盒半高（像素）；默认 = 绘制高的一半 |
| opts.density | number | 密度，默认 1（`<= 0` 按 0.001） |
| opts.friction | number | 摩擦，默认 0.4（负数按 0） |
| opts.restitution | number | 弹性，默认 0.1（钳制 0~1） |
| opts.sensor | boolean | 传感器（不产生碰撞响应，只发事件），默认 `false` |
| opts.damping | number | 线性阻尼，默认 0（负数按 0） |
| opts.fixedRotation | boolean | 固定旋转，**默认 `true`** |
| opts.bullet | boolean | 高速子弹体（连续碰撞），默认 `false` |

**返回**
`Entity | null` — **返回的就是传进去的 Entity**（不是刚体句柄）；失败（未 enable / 不是实体）返回 `null`

**说明**
✅ 已实现。给实体建刚体；**已存在刚体会先销毁再重建**。
尺寸默认取**绘制尺寸**（`sizeOf` 规则），所以视觉和碰撞体天然对齐。
`fixedRotation` 默认 `true` 意味着大多数东西不会自己转 —— 想做滚动/旋转的物体显式传 `false`。

**示例**
```js
bwe.physics.enable();

var crate = bwe.world.find("木箱");
crate.setSize(48, 48);
bwe.physics.body(crate, { type: "dynamic", shape: "box", density: 1, friction: 0.5 });

var barrel = bwe.world.find("油桶");
bwe.physics.body(barrel, { type: "dynamic", shape: "circle", radius: 24, density: 2 });
```

**另见**
[bwe.physics.remove](#bwephysicsremovee--boolean) · [bwe.physics.applyImpulse](#bwephysicsapplyimpulsee-ix-iy--boolean)

---

### bwe.physics.remove(e) → boolean

**签名**
`bwe.physics.remove(e: Entity): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体 |

**返回**
`boolean` — `true` = 确实删掉了一个刚体；没刚体返回 `false`

**说明**
✅ 已实现。实体被销毁时刚体会**自动清理**（每 0.5 秒扫一次），一般不需要手动调。

**示例**
```js
bwe.physics.remove(crate);
```

**另见**
[bwe.physics.body](#bwephysicsbodye-opts--entity--null)

---

### bwe.physics.applyImpulse(e, ix, iy) → boolean

**签名**
`bwe.physics.applyImpulse(e: Entity, ix: number, iy: number): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体（需有刚体） |
| ix | number | 冲量 X |
| iy | number | 冲量 Y |

**返回**
`boolean` — 是否成功（没刚体 / 未 enable → `false`）

**说明**
✅ 已实现。在实体**质心**施加冲量。单位是 **px·kg/s** —— 一个 1kg 的箱子，400 的冲量约等于 400 px/s 的初速度。

**示例**
```js
// 打飞一个木箱
bwe.physics.applyImpulse(crate, 400, -120);
```

**另见**
[bwe.physics.setVelocity](#bwephysicssetvelocitye-vx-vy--boolean) · [bwe.physics.throwAt](#bwephysicsthrowate-tx-ty-speed--boolean)

---

### bwe.physics.velocity(e) → {vx, vy}

**签名**
`bwe.physics.velocity(e: Entity): { vx: number; vy: number }`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体 |

**返回**
`{vx, vy}` — 速度（**px/s**，已从内部米制换算）；没有刚体时返回 `{vx: 0, vy: 0}`

**说明**
✅ 已实现。

**示例**
```js
var v = bwe.physics.velocity(crate);
bwe.log("速度 " + Math.round(v.vx) + "," + Math.round(v.vy) + " px/s");
```

**另见**
[bwe.physics.setVelocity](#bwephysicssetvelocitye-vx-vy--boolean)

---

### bwe.physics.setVelocity(e, vx, vy) → boolean

**签名**
`bwe.physics.setVelocity(e: Entity, vx: number, vy: number): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 目标实体 |
| vx | number | 速度 X（px/s） |
| vy | number | 速度 Y（px/s） |

**返回**
`boolean`

**说明**
✅ 已实现。直接设速度，并**唤醒**刚体。

**示例**
```js
bwe.physics.setVelocity(crate, 0, -300);   // 往上飞
```

**另见**
[bwe.physics.velocity](#bwephysicsvelocitye--vx-vy)

---

### bwe.physics.throwAt(e, tx, ty, speed?) → boolean

**签名**
`bwe.physics.throwAt(e: Entity, tx: number, ty: number, speed?: number): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity | 要抛的实体（需有刚体） |
| tx | number | 目标世界 X |
| ty | number | 目标世界 Y |
| speed | number | 出射速度（px/s）；`<= 0` = **按距离自适应**（`dist × 1.6`，钳制 `[60, 1600]`） |

**返回**
`boolean` — 成功与否（目标距离 ≈ 0 时返回 `false`）

**说明**
✅ 已实现。朝目标抛出。两种计算方式：

- **无重力**（`|gravity| < 1`）：直线，速度直接指向目标。
- **有重力**：解抛物线，飞行时间 `t = clamp(dist / speed, 0.18, 2.5)`，按 `vy = (dy - 0.5·g·t²) / t` 补偿下坠。

「丢油瓶」这类动词直接用这个。

**示例**
```js
var bottle = bwe.world.spawn({ x: ctx.self.x, y: ctx.self.y, asset: "油瓶", kind: "PROP" });
bwe.physics.body(bottle, { type: "dynamic", shape: "circle", radius: 8, density: 0.8 });
bwe.physics.throwAt(bottle, bwe.input.mouse.worldX, bwe.input.mouse.worldY);
```

**另见**
[bwe.physics.on](#bwephysicsonev-fn--function--null)（落地碰撞回调 → 点火）

---

### bwe.physics.raycast(x1, y1, x2, y2) → RayHit

**签名**
`bwe.physics.raycast(x1: number, y1: number, x2: number, y2: number): RayHit`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x1, y1 | number | 起点（世界像素） |
| x2, y2 | number | 终点 |

**返回**
`RayHit` — `{hit, x, y, nx, ny, fraction, sensor, entity}`

| 字段 | 说明 |
|---|---|
| `hit` | 是否命中 |
| `x, y` | 命中点世界坐标（没命中 = 终点） |
| `nx, ny` | 命中面法线（没命中 = `0, -1`） |
| `fraction` | 命中占比 0~1 |
| `sensor` | 命中的是不是传感器 |
| `entity` | 命中的实体（瓦片墙 / 没命中 = `null`） |

**说明**
✅ 已实现。**物理层的射线**（碰撞体 + 瓦片静态墙），和 `tilemap.raycast`（只查瓦片格）不是一回事。
未 enable 时返回 `hit: false` 的空结果。

**示例**
```js
var r = bwe.physics.raycast(ctx.self.x, ctx.self.y, m.worldX, m.worldY);
if (r.hit && r.entity) {
  bwe.log("打中了 " + r.entity.name);
}
```

**另见**
[bwe.tilemap.raycast](map-nav-interact-spawner.md#bwetilemapraycastx1-y1-x2-y2--rayhit) · [bwe.physics.queryAABB](#bwephysicsqueryaabbx-y-w-h--entity)

---

### bwe.physics.queryPoint(x, y) → Entity[]

**签名**
`bwe.physics.queryPoint(x: number, y: number): Entity[]`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 世界 X |
| y | number | 世界 Y |

**返回**
`Entity[]` — 碰撞体覆盖该点的实体（已去重）；未 enable 返回 `[]`

**说明**
✅ 已实现。**瓦片静态墙不会出现在结果里**（它们没有绑实体）。

**示例**
```js
var hit = bwe.physics.queryPoint(m.worldX, m.worldY);
if (hit.length > 0) { bwe.log("点到了 " + hit[0].name); }
```

**另见**
[bwe.physics.queryAABB](#bwephysicsqueryaabbx-y-w-h--entity)

---

### bwe.physics.queryAABB(x, y, w, h) → Entity[]

**签名**
`bwe.physics.queryAABB(x: number, y: number, w: number, h: number): Entity[]`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | **左上角** X（像素） |
| y | number | **左上角** Y |
| w | number | 宽（像素；**可以为负**，内部会取 min/max 归一化） |
| h | number | 高 |

**返回**
`Entity[]` — 碰撞体与该矩形重叠的实体（已去重）；未 enable 返回 `[]`

**说明**
✅ 已实现。与 `queryPoint` 不同，这里传的是**左上角 + 宽高**（不是中心）。
⚠ `w`/`h` **不传或传 0** 会退化成退化矩形 —— 可能什么都没命中。

**示例**
```js
// 以实体为中心的 64x64 查询
bwe.physics.queryAABB(ctx.self.x - 32, ctx.self.y - 32, 64, 64);
```

**另见**
[bwe.physics.queryPoint](#bwephysicsquerypointx-y--entity)

---

### bwe.physics.on(ev, fn) → Function | null

**签名**
`bwe.physics.on(ev: "collision", fn: Function): Function | null`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ev | string | 只支持 `"collision"`（大小写不敏感）；其它名字写告警并返回 `null` |
| fn | Function | `fn(info)`；`info = {a, b, impulse, sensor}` |

**返回**
`Function | null` — **取消订阅函数**（`var off = bwe.physics.on(...); off();`）；`fn` 无效或事件名不支持返回 `null`

**说明**
✅ 已实现。碰撞回调在**物理步全部结束、位置写回之后**才派发，所以回调里可以安全地 create/destroy 刚体。
单帧事件超过 **64 条**会丢弃多余的并写一次告警（防穿透/堆叠刷屏）。
`info` 里 `a` / `b` 可能是 `null`（一方中途死了）；瓦片墙不会出现在 `a`/`b` 里。

**示例**
```js
var offCollision = bwe.physics.on("collision", function (info) {
  if (!info.a || !info.b) { return; }
  bwe.log(info.a.name + " 撞上 " + info.b.name + "，冲量 " + info.impulse);
});

// 取消
offCollision();
```

**另见**
[bwe.physics.body](#bwephysicsbodye-opts--entity--null) · [e.on](entity.md#eonname-fn--void)（实体事件，不是物理碰撞）

---

### bwe.physics.bodyCount() → number

**签名**
`bwe.physics.bodyCount(): number`

**参数**
无

**返回**
`number` — 当前**实体刚体**数量（不含瓦片静态墙）

**说明**
✅ 已实现。数值是上一物理步结束时的快照。

**示例**
```js
bwe.log("刚体数 " + bwe.physics.bodyCount() + "，瓦片墙 " + bwe.physics.tileBodyCount());
```

**另见**
[bwe.physics.tileBodyCount](#bwephysicstilebodycount--number)

---

### bwe.physics.tileBodyCount() → number

**签名**
`bwe.physics.tileBodyCount(): number`

**参数**
无

**返回**
`number` — 由瓦片阻挡格生成的**静态墙**数量

**说明**
✅ 已实现。用来确认「瓦片墙真的建起来了」（build 日志里也会写）。

**示例**
```js
bwe.log("瓦片墙 " + bwe.physics.tileBodyCount() + " 块");
```

**另见**
[bwe.physics.bodyCount](#bwephysicsbodycount--number)

---

## 九、bwe.seed — 确定性随机

> 涌现对拍 / 回归测试的基础：**同种子 + 同输入 ⇒ 同结果**。
> 默认种子是固定值 `20251026`，所以**不开游戏时也是可复现的**；开局想要变化就 `bwe.seed.set(Date.now())`。

### bwe.seed.set(n) → number

**签名**
`bwe.seed.set(n: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| n | number | 新种子（会被转成 `long`）；非法值用默认种子 |

**返回**
`number` — 实际生效的种子

**说明**
✅ 已实现。**会同时**重置：
- `bwe.random` / `bwe.randomInt` / `bwe.chance` / `bwe.pick`（这四个函数会被换成确定性随机源）
- 材质场（`ScriptFields`）的随机源
- 物理（`ScriptPhysics`）的随机源

⚠ 但 **`prefab` 的 `jitter` 不在其中**（`prefab` 用自己的 `Random`，不联动 seed）。
⚠ 种子切换不回溯已经发生的模拟，只影响之后的随机。

**示例**
```js
bwe.seed.set(Date.now());            // 每局不同
bwe.seed.set(12345);                 // 固定种子做回归
bwe.log("种子 = " + bwe.seed.get());
```

**另见**
[bwe.seed.get](#bweseedget--number) · [bwe.seed.reset](#bweseedreset--number) · [bwe.random](lifecycle.md#bwerandommin-max--number)

---

### bwe.seed.get() → number

**签名**
`bwe.seed.get(): number`

**参数**
无

**返回**
`number` — 当前种子

**说明**
✅ 已实现。

**示例**
```js
bwe.log("当前种子 " + bwe.seed.get());
```

**另见**
[bwe.seed.set](#bweseedsetn--number)

---

### bwe.seed.reset() → number

**签名**
`bwe.seed.reset(): number`

**参数**
无

**返回**
`number` — 恢复后的种子（= 默认种子）

**说明**
✅ 已实现。等价于 `bwe.seed.set(bwe.seed.defaultSeed())`。

**示例**
```js
bwe.seed.reset();
```

**另见**
[bwe.seed.defaultSeed](#bweseeddefaultseed--number)

---

### bwe.seed.defaultSeed() → number

**签名**
`bwe.seed.defaultSeed(): number`

**参数**
无

**返回**
`number` — 默认种子值（`20251026`）

**说明**
✅ 已实现。常量，方便脚本判断「有没有被人改过种子」。

**示例**
```js
if (bwe.seed.get() === bwe.seed.defaultSeed()) {
  bwe.log("用的是默认种子（可复现）");
}
```

**另见**
[bwe.seed.get](#bweseedget--number)

---

## 十、完整示例：火烧草地 + 守卫调查

```js
var G = { guard: null, player: null };

function onSceneStart(ctx) {
  G.guard = bwe.world.find("守卫");
  G.player = bwe.world.find("玩家");

  // 固定种子，保证可复现
  bwe.seed.set(12345);

  // 守卫：挂感知 + 阵营
  bwe.ai.attach(G.guard, { sight: 300, fov: 110, hearing: 360, memory: 8 });
  bwe.faction.set(G.guard, "guard");
  bwe.faction.set(G.player, "player");
  bwe.faction.relation("guard", "player", -1);

  // 噪音 → 调查
  bwe.field.on("ignite", function (info) {
    bwe.noise.emit(bwe.grid.toWorld(info.cx, info.cy).x,
                   bwe.grid.toWorld(info.cx, info.cy).y,
                   { radius: 280, tag: "fire" });
  });

  // 物理：让木箱可推
  bwe.physics.enable();
  bwe.physics.gravity(0);
  var crate = bwe.world.find("木箱");
  if (crate) { bwe.physics.body(crate, { type: "dynamic", shape: "box" }); }

  bwe.on("update", function (dt) {
    // 守卫的决策完全写在脚本里
    if (!G.guard || !G.guard.alive) { return; }
    var st = bwe.ai.state(G.guard);

    if (bwe.sense.canSee(G.guard, G.player)) {
      bwe.ai.setState(G.guard, "chase");
      bwe.ai.alert(G.guard, G.player);
    } else if (bwe.sense.audible(G.guard) && st !== "chase") {
      var known = bwe.sense.lastKnown(G.guard);
      if (known) {
        bwe.ai.setState(G.guard, "investigate");
        var path = bwe.nav.find(G.guard, { x: known.x, y: known.y });
        if (path.length > 1) { bwe.nav.follow(G.guard, path, { speed: 90 }); }
      }
    }
  });
}

function onUpdate(ctx, dt) {
  // 玩家：左键点火，右键浇水
  if (bwe.input.pressed("Mouse0")) {
    var c = bwe.target.cell();
    if (c) { bwe.field.emit("fire", c.cx, c.cy, 1.0); }
  }
  if (bwe.input.pressed("Mouse2")) {
    var d = bwe.target.cell();
    if (d) { bwe.field.emit("water", d.cx, d.cy, 1.0); }
  }

  // HUD：把燃烧格画出来（引擎不给火焰上色）
  var cells = bwe.field.burning();
  bwe.draw.world(function () {
    for (var i = 0; i < cells.length; i++) {
      var p = bwe.grid.toWorld(cells[i].cx, cells[i].cy);
      bwe.draw.rect(p.x - 16, p.y - 16, 32, 32,
        { fill: "#ff4400", alpha: Math.min(0.85, cells[i].intensity) });
    }
  });
}
```

---

## 十一、边界与陷阱

| 情况 | 行为 |
|---|---|
| `material.setTile` 之后再指望 TILE 对象材质生效 | ❌ **不会** —— setTile 优先级最高 |
| `material.setEntity` / `ofEntity` | `ofEntity` **总有值**（兜底 `stone`） |
| 把 `water` 定义成可燃 | 引擎**强制**把 `flammable` 清零（水不会燃烧） |
| `field.emit` 的强度 | **覆盖**写，不是累加 |
| `field.on` / `ai.onAlert` / `ai.onSpot` / `interact.onTrigger` | **没有取消订阅**，注册一次就好 |
| `ai.onAlert` 的 payload | `entity` = **收到**警报的一方，`from` = 发起方 |
| 全局钩子（`ai.on*` / `field.on`）在多对象脚本里注册 | 同一条回调会**执行多次**（用全局标记防重） |
| `ai.attach` 的 `speed` | **引擎只存不驱动**（没有内置移动行为） |
| `ai.state` 的语义 | 引擎**不定义**，纯字符串，随便用 |
| `ai.alert` 无阵营 | **什么都不发生** |
| `faction.relation` 同名阵营 | 自动 `1`（友） |
| `faction.hostile` 任一方无阵营 | `false` |
| `noise` 隔墙衰减 | 一道 `×0.55`，两道 ≈ `×0.30` |
| `sense.audible` | **听到后 0.4 秒内**为真 |
| `physics.body` 未 enable | 返回 `null` + 写告警 |
| `physics.body` 的返回 | 是 **Entity**（不是刚体句柄） |
| `physics` 内部单位 | `32px = 1m`（1 格 = 1 米） |
| `physics.throwAt` 的 `speed` ≤ 0 | 按距离自适应 |
| `physics.on` 单帧事件 | 超过 **64 条**丢弃并告警 |
| `physics.raycast` vs `tilemap.raycast` | 前者查碰撞体 + 瓦片墙；后者只查瓦片格 |
| `physics.queryPoint` / `queryAABB` 结果 | **不含**瓦片静态墙 |
| `seed.set` 与 `prefab.jitter` | **不联动**（jitter 用自己的随机源） |
| `field.burning()` 每次调用 | 开销与燃烧格数成正比（HUD 用可以接受） |
