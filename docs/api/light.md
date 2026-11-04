# bwe.light — 2D 光照（Light）

> 本页覆盖：`bwe.light` 的全部成员 —— 总开关、环境光、压暗程度、模式、把光挂到实体上 / 摘掉 / 改参数、在世界坐标加独立光 / 删光、活光清单、运行时统计、立刻重建。
>
> 相关页：[draw：绘制](draw-audio-save.md) · [collision：碰撞](collision.md) · [entity：Entity](entity.md) · [README：索引](README.md)

## 解决什么问题

俯视角 2D 画面里，光源本身没有代码位置：它靠**光照贴图**这张覆盖整张场景的贴图实现。

- 编辑器里烘焙一张静态底图（`mode = "baked"`）；
- 或者运行时每帧算一张（`mode = "dynamic"`，按 `dynamicFps` 节流）；
- 或者两者都开（`mode = "both"`，烘焙图打底 + 动态光叠加）。

脚本能用 `bwe.light` 做到的三件事：

1. **拨总开关 / 环境光 / 压暗** —— 白天 ↔ 夜晚、室内 ↔ 室外，不用改场景数据；
2. **给实体挂一盏光** —— 火把、矿灯、车灯跟着角色跑；
3. **在世界坐标临时加一盏光** —— 爆炸闪光、技能特效，用完删掉。

## 层归属：只改「光照层」，不改游戏状态

`bwe.light` 只影响**世界光照层**这一张贴图，不碰任何对象的位置 / 尺寸 / 碰撞 / 血量。

> `enabled(false)` 之后光照层**完全不画**，画面等价于「白天」；旧工程（`scene.lighting` 缺失）整层不启用，行为与今天逐像素一致。

和 `bwe.draw` 的区别：

| 命名空间 | 画到哪 | 生命周期 |
|---|---|---|
| `bwe.draw` | 立即模式 HUD / 调试图形，**每帧重画** | 本帧有效 |
| `bwe.light` | **世界光照层**（覆盖整张场景的贴图） | 常驻，直到 `remove` / `detach` |

**Phase 说明**：`✅ 已实现`。

## 成员总览

全部 12 个成员都是**方法形式**（读写同一入口：传参 = 写，省略 = 读）。这一组里没有「属性」形式的成员 —— Java 侧统一用 `api.addMethod` 注册，所以 `bwe.light.darkness` 是函数而不是属性，**不要**写 `bwe.light.darkness = 0.9`。

```
bwe.light.enabled(flag?)            → boolean          读/写总开关
bwe.light.ambient(color?, intensity?) → {color, intensity}  读/写环境光
bwe.light.darkness(v?)              → number            读/写压暗程度 0..1
bwe.light.mode(m?)                  → string            "baked" | "dynamic" | "both"
bwe.light.attach(e, opts?)          → boolean           把光挂到实体上（跟随位置）
bwe.light.detach(e)                 → boolean           移除实体上的光
bwe.light.set(e, opts)              → boolean           改实体光的参数
bwe.light.add(opts)                 → number            加独立光，返回 handle
bwe.light.remove(handle)            → boolean           删独立光
bwe.light.list()                    → LightEntry[]      全部活光
bwe.light.stats()                   → LightStats        运行时统计
bwe.light.rebuild()                 → boolean           立刻重建动态贴图
```

**非法参数一律不抛异常**（Rhino 里一个异常会打断整段脚本）。写操作遇到非法值有两种处理：忽略该字段（`opts` 里的坏字段），或者整个调用返回 `false`（参数类型根本不对，拿不到实体 / handle）。

---

## 一、全局参数

### bwe.light.enabled(flag?) → boolean

**签名**
`bwe.light.enabled(flag?: boolean): boolean`

**参数**
- `flag` — 省略 = **只读**，返回当前开关；传 `true` / `false` = 写。

**返回**
`boolean` — 写入时返回写入后的值；读取时返回当前值。

**说明**
✅ 已实现。光照层总开关。`false` ⇒ **压暗 quad 与加光 quad 都不画**，等于回到白天。

注意：`enabled(false)` 不是「把光删掉」，活光清单与参数原样保留，`enabled(true)` 立刻恢复。

**旧工程（`scene.lighting` 缺失时）**：光照系统整体不存在，`enabled()` 恒为 `false`，`enabled(true)` 是**无操作**（仍返回 `false`）—— 打开一个没有光照配置的工程只会得到「整屏压黑」，那是最坏的回归，所以刻意不允许。想让旧工程有光，得先在场景数据里加 `lighting` 段（或改用别的做法，例如 `bwe.draw` 叠色）。

旧工程下其它成员读回的是**缺省配置值**（不是「生效中的配置」）：

| 成员 | 旧工程读回 / 行为 |
|---|---|
| `enabled()` | `false`（且无法打开） |
| `mode()` | `"both"`（契约 §3.1 缺省） |
| `darkness()` | `0` |
| `ambient().intensity` | `0` |
| `ambient().color` | `"#3A4A6B"`（无配置时的默认色值） |
| `list()` | **场景里的对象不会派生光源**（`Lighting.update()` 在未启用时早退，根本不收集）。只有脚本 `add` 的独立光会进表 —— 见下 |
| `add()` / `remove()` | **照常工作**：光真的被加进活光表、`list()` 能读到、`remove` 能删（只是 `enabled=false` 所以永远不会画出来） |
| `attach()` / `set()` / `detach()` | 照常写 / 还原对象的 props，返回 `true`；但**不会出现在 `list()`** 里（同上，场景光不收集），也永远不会画出来 |
| `rebuild()` | 返回 `true`（请求受理），但不会有任何重建动作（无启用、无动态层） |

判断「光照到底生效没有」**一律看 `enabled()`**，不要看 `mode()` 或 `darkness()`。

**示例**
```js
// 白天 / 夜晚切换
var night = false;
function onUpdate(ctx, dt) {
  if (bwe.input.pressed("KeyN")) {
    night = !night;
    bwe.light.enabled(night);
    bwe.light.darkness(night ? 0.55 : 0);
    bwe.log("光照 " + (bwe.light.enabled() ? "开" : "关"));
  }
}
```

**另见**
[bwe.light.darkness](#bwelightdarknessv--number) · [bwe.light.stats](#bwelightstats--enabled-mode-lights-baked-dynamic-rebuilds-lastms-texw-texh)

---

### bwe.light.ambient(color?, intensity?) → {color, intensity}

**签名**
`bwe.light.ambient(color?: string, intensity?: number): { color: string; intensity: number }`

**参数**
- `color` — `"#rrggbb"` 环境光色。省略 = 不改。
- `intensity` — `0..1` 环境光强度。省略 = 不改。
- **两个都省略** = 只读，不改任何东西。

**返回**
`{ color: string, intensity: number }` — 写入时返回**写入后**的值（非法 color 会被忽略，此时 `color` 是旧值）；只读时返回当前值。

**说明**
✅ 已实现。环境光是每个纹素的**基底**：`ambient = color * intensity`（各通道 0..1）。缺省 `"#3A4A6B"` / `0.35`。

两个参数各自独立：`ambient("#FF8844")` 只改颜色，强度保持原值；`ambient("", 0.8)` 只改强度（空字符串不是合法颜色，被当作「不改颜色」）。

**示例**
```js
// 傍晚：偏橙的环境光，强度拉高一点
var a = bwe.light.ambient();
bwe.log("原环境光 " + a.color + " / " + a.intensity);

bwe.light.ambient("#FF8844", 0.5);
var b2 = bwe.light.ambient();         // 省略全部参数 = 读
bwe.log("新环境光 " + b2.color + " / " + b2.intensity);

bwe.light.ambient("#3A4A6B");         // 只改颜色，强度保持 0.5
```

**另见**
[bwe.light.darkness](#bwelightdarknessv--number) · [bwe.light.rebuild](#bwelightrebuild--boolean)

---

### bwe.light.darkness(v?) → number

**签名**
`bwe.light.darkness(v?: number): number`

**参数**
- `v` — `0..1`。`0` = 不压暗（白天），`1` = 最暗。超出范围自动夹到 `0..1`。省略 = 只读。

**返回**
`number` — 写入时返回**夹取后**的值；只读时返回当前值。

**说明**
✅ 已实现。压暗程度。实现上是一张纯黑 quad，`alpha = darkness`，本层盖住整个世界。

> **压暗不是「整体调暗」**：它盖在画面上（`GL_SRC_ALPHA / GL_ONE_MINUS_SRC_ALPHA`），再用加光 quad 把有光的区域「打回来」。所以：
> - `darkness > 0` 且**一盏光都没有** ⇒ 整张画面变暗；
> - `darkness = 0` ⇒ 压暗层完全透明，但加光层仍在（只是看起来是「白天叠加光晕」）。

缺省 `0.35`（来自 `scene.lighting.darkness`）。改这个值会**触发一次动态贴图重建**（模式含 `dynamic` 时）。

**示例**
```js
bwe.light.darkness(0.6);              // 写
var d = bwe.light.darkness();         // 读
bwe.log("压暗 " + d);

bwe.light.darkness(5);                // 超范围 → 夹到 1
bwe.log("夹取后 " + bwe.light.darkness());
```

**另见**
[bwe.light.mode](#bwelightmodem--string) · [bwe.light.enabled](#bwelightenabledflag--boolean)

---

### bwe.light.mode(m?) → string

**签名**
`bwe.light.mode(m?: string): string`

**参数**
- `m` — `"baked"` | `"dynamic"` | `"both"`。省略 = 只读。

**返回**
`string` — 写入时返回写入后的模式（**非法值被忽略**，返回的是旧模式）；只读时返回当前模式。

**说明**
✅ 已实现。三种模式的差别：

| 模式 | 用烘焙图 | 运行时每帧算 | 适合 |
|---|---|---|---|
| `"baked"` | ✅ | ❌ | 静态场景：性能最好，光源参数改了也不会立刻反映 |
| `"dynamic"` | ❌ | ✅ | 全动态：光源随便动，但每帧有 CPU + 上传开销 |
| `"both"` | ✅ | ✅ | 默认：烘焙图打底 + 动态光叠加 |

缺省 `"both"`（契约 §3.1）。**旧工程（没有 `lighting` 段）也返回 `"both"`** —— 那是「缺省配置值」，**不代表光照生效**；旧工程 `enabled()` 恒为 `false`，判断生效要看 `enabled`，不要看 `mode`。其余数值读回 `0`，`ambient().color` 读回契约缺省色 `"#3A4A6B"`。

**非法字符串**（例如 `"boke"`、`"动态"`、`null`）不写，返回当前模式 —— 不抛异常。首尾空格与大小写**不敏感**（`"BOTH "` 等同 `"both"`），与内部归一化一致。

**示例**
```js
bwe.light.mode("dynamic");            // 全动态（调试光源时用）
bwe.log("模式 = " + bwe.light.mode());

var bad = bwe.light.mode("动态");      // 非法 → 忽略
bwe.log("非法后仍是 " + bwe.light.mode());
```

**另见**
[bwe.light.rebuild](#bwelightrebuild--boolean) · [bwe.light.stats](#bwelightstats--enabled-mode-lights-baked-dynamic-rebuilds-lastms-texw-texh)

---

## 二、把光挂到实体上

### bwe.light.attach(e, opts?) → boolean

**签名**
`bwe.light.attach(e: Entity, opts?: LightOpts): boolean`

**参数**
- `e` — 目标实体。不是实体 ⇒ 返回 `false`。
- `opts` — 光源参数（见下表，全部可省略）。

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `radius` | num px | `140` | 照亮半径 |
| `color` | `"#rrggbb"` | `"#FFC978"` | 光色 |
| `intensity` | num `0..4` | `1` | 强度 |
| `type` | `"point"` / `"spot"` | `"point"` | 点光 / 聚光 |
| `angle` | deg | `60` | 聚光锥总角度（仅 `spot`） |
| `dir` | deg | 实体 rotation | 聚光方向（`0` = +x，`90` = 向下/顺时针） |
| `coneSoft` | deg | `10` | 锥边软化角 |
| `falloff` | num `1..4` | `2` | 衰减指数 |
| `shadow` | boolean | `true` | 是否被遮挡体挡光 |
| `flicker` | num `0..1` | `0` | 闪烁幅度 |
| `dynamic` | boolean | `true`（`attach` 恒为 true） | 不进烘焙图，运行时动态算 |

**返回**
`boolean` — 成功 `true`；`e` 不是实体 / 实体已销毁 ⇒ `false`。

**说明**
✅ 已实现。把一盏光**绑到实体上**：光照位置每帧取实体的 `(x, y)`，实体移动光就跟着走。

三个要点：

1. **自动 `dynamic = true`**。跟随实体的光**必须**动态算 —— 烘焙图是静态底图，不可能跟着实体跑。所以 `attach` 会强制置 `dynamic`，`opts.dynamic = false` 会被忽略。
2. **已挂过就就地改参数**，不会挂第二盏。返回值仍是 `true`。想「换一盏」先 `detach`。
3. **省略的字段保持当前值**（第一次挂时是上表缺省值）。所以 `set` 与 `attach` 的参数语义完全一样，`attach` 只是多了「没有就新建」。

实现上是把参数写进对象的 §3.3 props（`lightRadius` / `lightColor` / … / `lightDynamic = "1"`），再由运行时每帧收集 —— 所以这些值也能用 `e.setProp("lightRadius", 200)` 改。

**示例**
```js
// 给玩家挂一盏暖色火把，带闪烁
function onSceneStart(ctx) {
  var hero = bwe.world.find("hero");
  bwe.light.attach(hero, {
    radius: 180,
    color: "#FFB060",
    intensity: 1.2,
    flicker: 0.35
  });

  // 一盏朝下的聚光灯（手电筒）
  var lamp = bwe.world.find("lamp");
  bwe.light.attach(lamp, {
    radius: 220,
    color: "#E8F4FF",
    type: "spot",
    angle: 50,
    dir: 90,
    coneSoft: 12,
    falloff: 3
  });

  bwe.log("活光 " + bwe.light.list().length);
}
```

**另见**
[bwe.light.set](#bwelightsete-opts--boolean) · [bwe.light.detach](#bwelightdetache--boolean) · [bwe.light.list](#bwelightlist--lightentry)

---

### bwe.light.detach(e) → boolean

**签名**
`bwe.light.detach(e: Entity): boolean`

**参数**
- `e` — 目标实体。

**返回**
`boolean` — 摘掉了一盏光 `true`；本来就没挂 / 不是实体 ⇒ `false`。

**说明**
✅ 已实现。移除 `attach` 挂上的那盏光（把 `lightRadius` 等 props 清掉）。

- 对**场景里原生就有的 LIGHT 对象**调 `detach` 也会返回 `false` —— 它不是 `attach` 挂的。想关掉这类光，改它的 `lightIntensity` / `visible` 属性。
- 实体被销毁时光会自动跟着消失，不需要手动 `detach`。

**示例**
```js
function onUpdate(ctx, dt) {
  if (bwe.input.pressed("KeyF")) {
    var hero = bwe.world.find("hero");
    var ok = bwe.light.detach(hero);
    bwe.log("熄灯 " + (ok ? "成功" : "本来就亮着没灯"));
  }
}
```

**另见**
[bwe.light.attach](#bwelightattache-opts--boolean) · [bwe.light.list](#bwelightlist--lightentry)

---

### bwe.light.set(e, opts) → boolean

**签名**
`bwe.light.set(e: Entity, opts: LightOpts): boolean`

**参数**
- `e` — 已挂光的实体。
- `opts` — 要改的字段（语义与 [attach](#bwelightattache-opts--boolean) 的表完全相同）；**省略的字段保持当前值**。

**返回**
`boolean` — 改成功 `true`；实体上没挂光（或 `e` 不是实体）⇒ `false`。

**说明**
✅ 已实现。**只改参数、不新建**。语义是「局部更新」而不是「整体覆盖」：

```js
bwe.light.attach(hero, { radius: 180, color: "#FFB060" });
bwe.light.set(hero, { intensity: 0.4 });   // radius / color 原样保留，只改强度
```

所以想「精确设置」某一个光，要么一次给全，要么用 `list()` 查当前值再拼。`opts` 里的非法字段被忽略（不影响其它字段生效）。

**示例**
```js
// 血量越低，灯越暗
function onUpdate(ctx, dt) {
  var hero = ctx.self;
  var pct = hero.hp / hero.hpMax;
  bwe.light.set(hero, {
    intensity: 0.2 + pct * 1.0,
    radius: 100 + pct * 120,
    color: pct > 0.5 ? "#FFC978" : "#FF6040"
  });
}
```

**另见**
[bwe.light.attach](#bwelightattache-opts--boolean) · [bwe.light.list](#bwelightlist--lightentry)

---

## 三、独立光（世界坐标）

### bwe.light.add(opts) → number

**签名**
`bwe.light.add(opts?: LightOpts): number`

**参数**
- `opts` — 光源参数（同 [attach](#bwelightattache-opts--boolean) 的表），外加两个只有 `add` 认的字段：
  - `x` — 世界坐标 X，缺省 `0`。
  - `y` — 世界坐标 Y，缺省 `0`。
- 省略 `opts` = 在 `(0,0)` 加一盏缺省光（合法但基本没用）。

**关于 `dynamic`（与 `attach` 不同）**：`add` 的 `dynamic` **缺省 `true`**。

> 为什么缺省是 `true` 而契约 §3.3 的 props 缺省是 `"0"`：脚本临时加的这盏光**不在编辑器烘焙出的 PNG 里**。如果它是 `dynamic = false`，而场景又有烘焙图（`mode = "baked"` / `"both"` 且有 `lightmap`），那么它会被判定为「应该在烘焙图里」，于是**两处都不算，整盏光看不见**。所以缺省按「脚本光只属于运行时」处理。
>
> 显式传 `dynamic: false` 仍然照办（大多数情况下不会有任何视觉差异，但语义上它会被当作「已烘焙」）。

**返回**
`number` — **数字 handle**（Java 侧 `long` 转成的 double），删光时用。不是对象，不要想着从它读字段；要查参数请用 `list()`。

**说明**
✅ 已实现。在**世界坐标**处加一盏不绑实体的光：爆炸闪光、技能特效、路灯光晕、临时的「照一下」。

- `dynamic` 缺省 `true`（见上面「关于 `dynamic`」）。**做一闪而过的特效请显式传 `dynamic: true`**（也就是让它保持缺省）；只有你真的想让这盏光「当作已经在烘焙图里」时才传 `false`。
- 加完不会自动消失，**必须** `remove(handle)` 或等场景切换（场景切换会清空全部脚本光）。
- 每帧加的临时光务必当帧或下一帧删掉，否则 `list()` 会无限增长（还有 `maxDynamicLights` 上限，超出的光不参与动态计算）。

**示例**
```js
// 爆炸：加一盏白光，0.2 秒后删掉
function boom(x, y) {
  var h = bwe.light.add({
    x: x, y: y,
    radius: 320,
    color: "#FFFFFF",
    intensity: 2.5,
    falloff: 2,
    shadow: false,
    dynamic: true
  });

  bwe.after(0.2, function () {
    bwe.light.remove(h);
  });
}
```

**另见**
[bwe.light.remove](#bwelightremovehandle--boolean) · [bwe.light.list](#bwelightlist--lightentry)

---

### bwe.light.remove(handle) → boolean

**签名**
`bwe.light.remove(handle: number): boolean`

**参数**
- `handle` — `add` 返回的数字。

**返回**
`boolean` — 删掉了 `true`；handle 不存在 / 已经删过 / 不是数字 ⇒ `false`。

**说明**
✅ 已实现。删独立光。**幂等**：重复删同一个 handle 第二次返回 `false`，不抛异常。

> 只能删**脚本 `add` 出来的光**。场景里原生的 LIGHT 对象、`attach` 挂的实体光都不在这个 handle 空间里 —— 删它们请用 `detach` 或改对象属性。`handle` 全场景单调递增，删掉后不会被复用。

**示例**
```js
var h = bwe.light.add({ x: 100, y: 100, radius: 200, dynamic: true });

bwe.light.remove(h);          // → true
bwe.light.remove(h);          // → false（已经删过）
bwe.light.remove("abc");      // → false（不是数字，不抛异常）
bwe.light.remove();           // → false（没传参）
```

**另见**
[bwe.light.add](#bwelightaddopts--number) · [bwe.light.list](#bwelightlist--lightentry)

---

## 四、查询与统计

### bwe.light.list() → LightEntry[]

**签名**
`bwe.light.list(): LightEntry[]`

**参数**
无

**返回**
**JS 原生数组**（不是 Java List，`length` / 下标 / `JSON.stringify` 都能用）。每项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 稳定 id。`> 0` = 脚本 `add` 的独立光（可 `remove`）；`< 0` = 场景对象派生的光（改 props 才能动它） |
| `x` | number | 当前世界坐标 X（跟随实体的光每帧被刷新） |
| `y` | number | 当前世界坐标 Y |
| `radius` | number | 照亮半径（世界像素） |
| `color` | string | 光色 `"#rrggbb"` |
| `intensity` | number | 强度 `0..4` |
| `type` | string | `"point"` / `"spot"` |
| `dynamic` | boolean | 是否只由运行时算（不进烘焙图） |

**说明**
✅ 已实现。**全部活光**：场景里 LIGHT 对象 / 带 `look.light`、`render.light` 模块的对象 / `props.lightRadius > 0` 的对象派生的光 + 脚本 `add` 的独立光 + `attach` 挂的实体光。

用途：调试看「到底有几盏灯、在哪」、按 id 找一盏临时改、`attach` 后断言数量。注意这是**快照**，改它不影响引擎内部表；要改光请用 `set` / 对象属性。

**示例**
```js
var lights = bwe.light.list();
bwe.log("活光 " + lights.length + " 盏");

for (var i = 0; i < lights.length; i++) {
  var L = lights[i];
  bwe.log("  #" + L.id + " @(" + Math.round(L.x) + "," + Math.round(L.y)
        + ") r=" + Math.round(L.radius)
        + " " + L.color
        + " i=" + L.intensity
        + " " + L.type
        + (L.dynamic ? " [动态]" : " [烘焙]"));
}

// 统计有多少盏是动态的
var dyn = 0;
for (var j = 0; j < lights.length; j++) {
  if (lights[j].dynamic) { dyn++; }
}
bwe.log("动态光 " + dyn + " / " + lights.length);
```

**另见**
[bwe.light.add](#bwelightaddopts--number) · [bwe.light.stats](#bwelightstats--enabled-mode-lights-baked-dynamic-rebuilds-lastms-texw-texh)

---

### bwe.light.stats() → {enabled, mode, lights, baked, dynamic, rebuilds, lastMs, texW, texH}

**签名**
`bwe.light.stats(): LightStats`

**参数**
无

**返回**

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 光照层总开关 |
| `mode` | string | `"baked"` / `"dynamic"` / `"both"` |
| `lights` | number | 活光总数（= `list().length`） |
| `baked` | number | 烘焙图里的光源数；没有烘焙图为 `0` |
| `dynamic` | number | 参与动态计算的活光数 |
| `rebuilds` | number | 累计重建次数（诊断用） |
| `lastMs` | number | 最近一次动态贴图重建耗时（ms） |
| `texW` | number | 动态贴图纹素宽 |
| `texH` | number | 动态贴图纹素高 |

**说明**
✅ 已实现。运行时统计。最有用的是 `lastMs` + `rebuilds`：

- `rebuilds` 不涨 ⇒ 你改的东西没被判定为「有变化」，或者被 `dynamicFps` 节流了；
- `lastMs` 很大 ⇒ 动态光照是性能瓶颈，考虑改 `mode = "baked"` 或降 `texelsPerPixel`。

**示例**
```js
// 每 2 秒打一次光照水位
bwe.every(2, function () {
  var s = bwe.light.stats();
  bwe.log("光照 " + (s.enabled ? "开" : "关")
        + " / " + s.mode
        + " / " + s.lights + " 盏"
        + "（烘焙 " + s.baked + "、动态 " + s.dynamic + "）"
        + " / 重建 " + s.rebuilds + " 次，最近 " + s.lastMs + "ms"
        + " / " + s.texW + "x" + s.texH);
});
```

**另见**
[bwe.light.list](#bwelightlist--lightentry) · [bwe.light.rebuild](#bwelightrebuild--boolean) · [bwe.debug.stats](debug.md#bwedebugstats--actors-pendingdestroy-scenepoch-colliders-vehicles-spatialzones-drawcommands-enabled)

---

### bwe.light.rebuild() → boolean

**签名**
`bwe.light.rebuild(): boolean`

**参数**
无

**返回**
`boolean` — 恒 `true`（重建请求已被接收）；光照层没启用 / 模式是纯 `"baked"` 时同样返回 `true`，只是不会有重建动作。

**说明**
✅ 已实现。**请求立刻重建动态光照贴图**。

> **为什么不是「函数返回时贴图已经重建好」**：脚本回调（`onStart` / `onUpdate`）跑在 GL 上下文**之外**，拿不到 GL 句柄。所以这个调用做的是「置一个跳过节流的重建请求」，实际重建发生在同帧的运行时推进（`Lighting.update` 里的 CPU 烘焙，位图随即排进纹理上传队列，绘制时上传）。脚本里紧接着读 `stats().rebuilds` 可能还是旧值 —— 想验证重建生效，隔一两帧再读。

什么时候需要它：运行时改了光源参数、`mode` 含 `dynamic`，但**不想等 `dynamicFps` 的节流窗口**（缺省 15fps，最多等 1/15 秒）。

> `dynamicFps` 节流 + 「参数指纹没变就不重建」都是正常的性能保护；`rebuild()` 是唯一能**强行**跳过它们的入口。

**示例**
```js
// 一次性改变全局亮度后，要求立刻反映（不等节流）
bwe.light.darkness(0.8);
bwe.light.ambient("#203050", 0.2);
bwe.light.rebuild();

bwe.after(0.1, function () {
  var s = bwe.light.stats();
  bwe.log("重建后 " + s.rebuilds + " 次 / 最近 " + s.lastMs + "ms");
});
```

**另见**
[bwe.light.stats](#bwelightstats--enabled-mode-lights-baked-dynamic-rebuilds-lastms-texw-texh) · [bwe.light.mode](#bwelightmodem--string)

---

## 五、一张完整的「夜晚 + 火把」示例

把上面的成员串起来 —— 直接跑（ES5，`var` / `function`）：

```js
// 场景脚本：入夜 + 玩家火把 + 两盏路灯 + 一个会闪的爆炸技能
var lamps = [];

function onSceneStart(ctx) {
  // 1) 入夜
  bwe.light.enabled(true);
  bwe.light.mode("both");
  bwe.light.darkness(0.62);
  bwe.light.ambient("#1A2340", 0.22);
  bwe.light.rebuild();

  // 2) 玩家火把（跟随实体，带闪烁）
  var hero = bwe.world.find("hero");
  if (hero) {
    bwe.light.attach(hero, {
      radius: 170,
      color: "#FFB060",
      intensity: 1.15,
      flicker: 0.3
    });
  }

  // 3) 两盏固定的暖光（独立光，做路灯）
  lamps.push(bwe.light.add({ x: 320, y: 200, radius: 150, color: "#FFC978", intensity: 0.9, dynamic: true }));
  lamps.push(bwe.light.add({ x: 640, y: 200, radius: 150, color: "#FFC978", intensity: 0.9, dynamic: true }));

  // 4) 周期性爆炸闪光
  bwe.every(3, function () {
    var ex = 200 + Math.random() * 600;
    var ey = 150 + Math.random() * 300;
    var h = bwe.light.add({
      x: ex, y: ey,
      radius: 360,
      color: "#FFFFFF",
      intensity: 2.2,
      falloff: 2,
      shadow: false,
      dynamic: true
    });
    bwe.after(0.18, function () { bwe.light.remove(h); });
  });

  bwe.log("夜晚已开启，活光 " + bwe.light.list().length + " 盏");
}

function onUpdate(ctx, dt) {
  // 每秒看一次水位（别每帧打日志）
  if (bwe.time.frame % 60 === 0) {
    var s = bwe.light.stats();
    bwe.log("光照 " + s.lights + " 盏 / 重建 " + s.rebuilds + " 次 / " + s.lastMs + "ms");
  }
}

function onSceneEnd(ctx) {
  // 场景卸载时清掉独立光（实体光会跟着实体一起没）
  for (var i = 0; i < lamps.length; i++) {
    bwe.light.remove(lamps[i]);
  }
  lamps = [];
  bwe.light.enabled(false);
  bwe.light.darkness(0);
}
```

## 六、常见误判

| 现象 | 真实原因 |
|---|---|
| `bwe.light.darkness = 0.9` 看起来「没生效」 | 它是**方法**，不是属性。必须写成 `bwe.light.darkness(0.9)`。 |
| 改了 `attach` 的 `radius` 但画面没变 | 参数写进了 props，动态层要等下一次重建。等 1~2 帧，或者 `rebuild()`。 |
| `attach` 传了 `dynamic: false` 却仍没进烘焙图 | `attach` 的光**恒为动态**（跟随实体不可能进静态底图），该字段被忽略。 |
| `add()` 加的独立光没出现（或有的光只在某些模式亮） | `dynamic: false` + 场景有烘焙图 ⇒ 被当成「已在烘焙图里」。脚本临时光应当 `dynamic: true`（这也是 `add` 的缺省）。 |
| `list()` 越来越长 | 临时光加了没 `remove`。每帧加的临时光必须自己删。 |
| `enabled(false)` 后 `list()` 还有一堆 | 正常。`enabled` 只管画不画，不删数据。 |
| `stop` 掉光照后画面**更亮**了 | 压暗层关掉了。想「保留压暗但没光」应该只 `mode("baked")` 而不关 `enabled`。 |
| `stats().rebuilds` 一直是 0 | 模式是纯 `"baked"`（没有动态层），或光源参数一直没变。 |
| `bwe.light` 是 `undefined` | 旧运行时。`bwe.light` 是本轮新增的命名空间。 |

## 另见

- [entity：Entity](entity.md) —— `attach` / `set` / `detach` 的第一个参数
- [world：世界](world.md) —— `bwe.world.find` 找实体
- [debug：调试绘制](debug.md) —— `bwe.debug.stats` 一起看运行时水位
- [README：索引](README.md) —— 全部命名空间一览
- 契约：`docs/_fragments/lighting-contract.md` §4（成员名逐字固定）、§3.3（参数键名）
