# bwe.debug — 调试绘制（Debug）

> 本页覆盖：`bwe.debug` 的全部成员 —— 总开关、逐项绘制（碰撞盒 / 路径 / 区域 / 阻挡图）、单次绘制（矩形 / 圆 / 线）、画实体碰撞框、运行时统计。
>
> 相关页：[draw：绘制](draw-audio-save.md) · [collision：碰撞](collision.md) · [spatial：多层空间](spatial.md) · [road：路网](road.md) · [README：索引](README.md)

## 解决什么问题

开放世界出问题时的第一句话永远是"**我看不到它到底在哪**"：碰撞盒、寻路路径、空间边界、楼层层高。没有调试绘制就只能靠 `print` 猜。

## 层归属：纯绘制，不改游戏状态

`bwe.debug` 是 L2 通用框架，**只画不改**：

> 关掉调试绘制之后，游戏行为必须**逐像素一致**。

实现上复用 `bwe.draw` 的同一条立即模式管线，所以不需要新的 GL 路径、不会与合批冲突。绘制指令只在 `onUpdate` / `draw` 期间有效。

## 三层开关

```
debug.on()        ← 总开关（不打开，下面全部不画、单次绘制也不出图）
  ├─ colliders(bool)   画所有有碰撞盒的实体
  ├─ paths(bool)       画正在沿路径跟随的实体的路径
  ├─ zones(bool)       画空间区域边界
  └─ nav(bool)         画瓦片阻挡图（开销大，慎用）
```

`off()` 会**一次性**关掉总开关并复位全部逐项开关。

**Phase 说明**：`✅ 已实现`。

---

## 一、总开关

### bwe.debug.on() → boolean

**签名**
`bwe.debug.on(): boolean`

**参数**
无

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。打开总开关。**只是打开**：逐项绘制还要各自 `colliders(true)` 等才会真的画。

**示例**
```js
bwe.debug.on();               // 总开关
bwe.debug.colliders(true);    // 同时画碰撞盒
```

**另见**
[bwe.debug.off](#bwedebugoff--boolean) · [bwe.debug.enabled](#bwedebugenabled--boolean)

---

### bwe.debug.off() → boolean

**签名**
`bwe.debug.off(): boolean`

**参数**
无

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。关闭总开关，并**把 colliders / paths / zones / nav 全部复位为 `false`** —— 一刀切，不会留下某个开关还开着。

**示例**
```js
bwe.debug.off();   // 一键回到干净状态
```

---

### bwe.debug.enabled() → boolean

**签名**
`bwe.debug.enabled(): boolean`

**参数**
无

**返回**
`boolean` — 总开关当前是否开启

**说明**
✅ 已实现。脚本里可以拿它做"调试模式下才打印"的判断，避免影响正式运行。

**示例**
```js
if (bwe.debug.enabled()) {
  bwe.log("路径长度 " + path.length);
}
```

---

## 二、逐项绘制

### bwe.debug.colliders(on = true) → boolean

**签名**
`bwe.debug.colliders(on?: boolean): boolean`

**参数**
- `on` — 省略 = `true`

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。每帧自动画所有**有碰撞盒**的实体的框。颜色区分：

| 颜色 | 含义 |
|---|---|
| 绿色 `#00ff88` | 普通实体 |
| 黄色 `#ffcc00` | 传感器（触发区） |

**示例**
```js
bwe.debug.on();
bwe.debug.colliders(true);
// 调试完：
bwe.debug.colliders(false);
```

**另见**
[bwe.debug.actor](#bwedebugactore-color--00ff88) · [bwe.collision.isTrigger](collision.md#bwecollisionistriggere--boolean)

---

### bwe.debug.paths(on = true) → boolean

**签名**
`bwe.debug.paths(on?: boolean): boolean`

**参数**
- `on` — 省略 = `true`

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。每帧画**正在沿路径跟随**的实体的剩余路径（`bwe.world` 的路径跟随与车辆自动驾驶都算）。

**示例**
```js
bwe.debug.paths(true);
```

**另见**
[road：路网](road.md) · [bwe.vehicle.followRoad](vehicle.md#bwevehiclefollowroade-target-onarrive----boolean)

---

### bwe.debug.zones(on = true) → boolean

**签名**
`bwe.debug.zones(on?: boolean): boolean`

**参数**
- `on` — 省略 = `true`

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。每帧画 [bwe.spatial](spatial.md) 的区域边界。**空间数据不存在时不画**（旧工程上开了也看不到东西）。

**示例**
```js
if (bwe.spatial.hasData()) {
  bwe.debug.zones(true);
}
```

---

### bwe.debug.nav(on = true) → boolean

**签名**
`bwe.debug.nav(on?: boolean): boolean`

**参数**
- `on` — 省略 = `true`

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。画瓦片阻挡图。**开销大，慎用** —— 整张地图的格子都要画一遍，大图上掉帧很明显。只在排查寻路问题时临时开。

**示例**
```js
bwe.debug.nav(true);    // 排查"为什么寻路绕圈"
// 查完立刻关：
bwe.debug.nav(false);
```

---

## 三、单次绘制

### bwe.debug.box(x, y, w, h, color = "#00ff88")

**签名**
`bwe.debug.box(x: number, y: number, w: number, h: number, color?: string): void`

**参数**
- `x` / `y` — 矩形左上角（世界像素）
- `w` / `h` — 宽高
- `color` — 颜色字符串，省略 `"#00ff88"`

**返回**
无（总开关没开时**直接返回，什么都不画**）

**说明**
✅ 已实现。画一次当前帧的矩形。后续 `bwe.debug.off()` 之后不会再有。

**示例**
```js
bwe.debug.on();
bwe.debug.box(100, 100, 64, 64, "#ff0000");
```

---

### bwe.debug.circle(x, y, r, color = "#00ff88")

**签名**
`bwe.debug.circle(x: number, y: number, r: number, color?: string): void`

**参数**
- `x` / `y` — 圆心
- `r` — 半径
- `color` — 省略 `"#00ff88"`

**返回**
无（总开关没开时不画）

**说明**
✅ 已实现。用来可视化 `bwe.collision.overlapCircle` 的查询范围：

```js
bwe.debug.circle(me.x, me.y, 120, "#00ff88");
var near = bwe.collision.overlapCircle(me.x, me.y, 120);
```

**示例**
```js
bwe.debug.on();
bwe.debug.circle(320, 240, 80);
```

---

### bwe.debug.line(x1, y1, x2, y2, color = "#00ff88")

**签名**
`bwe.debug.line(x1: number, y1: number, x2: number, y2: number, color?: string): void`

**参数**
- `x1 / y1` — 起点
- `x2 / y2` — 终点
- `color` — 省略 `"#00ff88"`

**返回**
无（总开关没开时不画）

**说明**
✅ 已实现。用来可视化射线检测：

```js
var hit = bwe.collision.raycast(me.x, me.y, me.x + 300, me.y);
bwe.debug.line(me.x, me.y, me.x + 300, me.y, hit.hit ? "#ff0000" : "#00ff88");
```

**示例**
```js
bwe.debug.on();
bwe.debug.line(0, 0, 640, 480);
```

---

### bwe.debug.actor(e, color = "#00ff88")

**签名**
`bwe.debug.actor(e: Entity, color?: string): void`

**参数**
- `e` — 实体
- `color` — 省略 `"#00ff88"`

**返回**
无（总开关没开、实体无效或已死亡时不画）

**说明**
✅ 已实现。画**这一个**实体的碰撞框。与 `colliders(true)` 的区别：那个是每帧自动画所有，这个是手动画指定的一个。

**示例**
```js
bwe.debug.on();
var boss = bwe.world.find({ tag: "boss" });
if (boss) bwe.debug.actor(boss, "#ff00ff");
```

---

## 四、统计

### bwe.debug.stats() → {actors, pendingDestroy, sceneEpoch, colliders, vehicles, spatialZones, drawCommands, enabled}

**签名**
`bwe.debug.stats(): DebugStats`

**参数**
无

**返回**

| 字段 | 类型 | 说明 |
|---|---|---|
| `actors` | `number` | 当前实体总数 |
| `pendingDestroy` | `number` | 本帧待销毁的实体数 |
| `sceneEpoch` | `number` | 场景代数（见 [bwe.scene.epoch](scene.md#bwesceneepoch--number)） |
| `colliders` | `number` | 有碰撞盒的实体数 |
| `vehicles` | `number` | 车辆数（= [bwe.vehicle.count](vehicle.md#bwevehiclecount--number)） |
| `spatialZones` | `number` | 空间区域数（= [bwe.spatial.zoneCount](spatial.md#bwespatialzonecount--number)） |
| `drawCommands` | `number` | 本帧新增的绘制指令数 |
| `enabled` | `boolean` | 调试总开关状态 |

**说明**
✅ 已实现。**性能水位观察**的第一手数据：`actors` 和 `drawCommands` 疯涨通常是泄漏或绘制没配对。

`spatialZones` / `vehicles` 在没有对应数据时是 `0`（不会报错）。

**示例**
```js
onUpdate = function (ctx, dt) {
  var s = bwe.debug.stats();
  bwe.draw.text(8, 8, "实体 " + s.actors + " / 绘制 " + s.drawCommands, 14, "#fff");
  if (s.actors > 800) bwe.log("实体数偏高：" + s.actors);
};
```

**另见**
[bwe.debug.enabled](#bwedebugenabled--boolean) · [bwe.world.count](world.md)

---

## 五、脚本错误可观测

脚本抛异常时引擎**从来不会中断游戏**（这是对的：一个脚本写错不该让整个场景挂掉），
但原来只把异常 print 到 stdout —— 网页版 / 桌面版都拿不到「哪个脚本第几行炸了」。
这一节把那些被吞掉的异常收进一个**有界环形缓冲**，供编辑器「问题」面板 / AI 助手读。

> **缓冲语义（三条，都必须记住）**
> 1. **有界**：最多 32 条，满了淘汰最老的；
> 2. **重复只累加**：同一处（同脚本 + 同行 + 同消息）重复抛出只自增 `count`，不新增条目
>    —— 否则每帧抛一次的脚本会在两秒内把 32 条冲干净，反而看不到首次发生的位置；
> 3. **不改行为**：原来的 `catch` 该吞还吞、日志该去的重还去，只多一次入队（O(1) 摊还）。

---

### bwe.debug.errors() → [{script, message, line, count, frame}]

**签名**
`bwe.debug.errors(): ScriptErrorEntry[]`

**参数**
无

**返回**
JS **原生数组**（可以直接 `.length` / `for` / `JSON.stringify`），元素字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `script` | `string` | 脚本名（`boot.json` 里 `scripts[].name`）；拿不到上下文时是 `"?"` |
| `message` | `string` | 异常消息（换行已单行化，最长 300 字） |
| `line` | `number` | Rhino 行号；**取不到时是 `-1`**（不是 0 —— 0 会被 UI 误显示成"第 0 行"） |
| `count` | `number` | 同一处错误的重复次数 |
| `frame` | `number` | **首次**发生时的帧号 |

**说明**
✅ 已实现。返回的是**快照**，调用之后引擎继续记录不会改变已经拿到的数组。

**示例**
```js
onUpdate = function (ctx, dt) {
  var errs = bwe.debug.errors();
  if (errs.length > 0) {
    var e = errs[errs.length - 1];        // 最新一条
    bwe.draw.text(8, 8, e.script + ":" + e.line + " ×" + e.count, 14, "#ff5555");
    bwe.draw.text(8, 26, e.message, 12, "#ffaaaa");
  }
};
```

**另见**
[bwe.debug.clearErrors](#bwedebugclearerrors--boolean) · [bwe.debug.dumpErrors](#bwedebugdumpErrorspath--boolean)

---

### bwe.debug.clearErrors() → boolean

**签名**
`bwe.debug.clearErrors(): boolean`

**参数**
无

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。清空错误缓冲，**并且**重置日志侧「同一脚本同一行只报一次」的去重表。

为什么要一起重置：清空的意图是"从现在开始重新观察"。只清缓冲、留着去重表的话，
下一次同一处再抛异常时日志不会再写、`errors()` 也不会再收到 —— 等于清空一次就永久失声。

**示例**
```js
bwe.debug.clearErrors();     // 修完 bug 后从干净状态重新观察
```

---

### bwe.debug.dumpErrors(path) → boolean

**签名**
`bwe.debug.dumpErrors(path?: string): boolean`

**参数**
- `path` — 相对**工程根**的路径。省略 = `Build/diagnostics/script-errors.json`

**返回**
`boolean` — 写成功 `true`；失败 `false`（**不抛异常**：调试辅助功能不该把游戏搞崩）

**落盘格式**
```json
{
  "count": 3,
  "errors": [
    { "script": "world", "message": "res is not defined", "line": 42, "count": 7, "frame": 118 },
    { "script": "player", "message": "boom", "line": 9, "count": 1, "frame": 120 }
  ]
}
```

**安全约束**
含 `..` 或以 `/` 开头的路径**一律返回 `false`**（与 [bwe.save](draw-audio-save.md) 同一纪律，
不允许脚本把诊断文件写到任意位置）。

**示例**
```js
// 崩溃现场一次性取证，方便把文件贴给别人 / 喂给 AI 助手
if (bwe.debug.errors().length > 5) {
  bwe.log("错误太多，正在落盘：" + bwe.debug.dumpErrors());
}
```

---

## 六、脚本性能剖析

「这一帧到底卡在哪个脚本」原来只能靠肉眼猜。`bwe.prof` 给出可编程的剖析：
开启后按**每脚本**累计执行耗时，随时读整帧耗时的 p50 / p95 / p99 / max。

> **默认关闭**。关闭时热路径只多一次布尔判断；开启时每次 JS 调用多一次
> `nanoTime()` + 一次 long 加法 + 一次 map 查 + 一次环形写，全程**零分配**。
> 实测单次记录 ≈ 4ns，本项目每帧约 60 次调用 ⇒ 每帧 &lt; 0.5μs，相对 0.4ms 的帧耗时 &lt; 0.1%。

---

### bwe.prof.enable(on = true) → boolean

**签名**
`bwe.prof.enable(on?: boolean): boolean`

**参数**
- `on` — 省略 = `true`

**返回**
`boolean` — 开启后的开关状态

**说明**
✅ 已实现。**关闭不清空已有样本**（"关掉再打开"不会丢历史）；要清空请调
[bwe.prof.reset](#bweproofreset--boolean)。两个语义分开，免得在 UI 上切开关时意外把刚测的数据弄没。

**示例**
```js
bwe.prof.enable(true);
```

---

### bwe.prof.report() → {frames, avgMs, p50Ms, p95Ms, p99Ms, maxMs, scripts}

**签名**
`bwe.prof.report(): ProfReport`

**参数**
无

**返回**

| 字段 | 类型 | 说明 |
|---|---|---|
| `frames` | `number` | 已结算帧数（样本窗口上限 **2048**）。**0 = 还没采到样本** |
| `avgMs` | `number` | 整帧脚本耗时均值 |
| `p50Ms` / `p95Ms` / `p99Ms` | `number` | 整帧耗时的百分位（最近 2048 帧的排序快照） |
| `maxMs` | `number` | 样本窗口内的最大值 |
| `scripts` | `array` | 每脚本统计，见下表 |

`scripts[]` 元素：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 脚本名 |
| `p95Ms` | `number` | 该脚本**单次调用**耗时的 p95 |
| `calls` | `number` | 该脚本累计被调用次数 |

**百分位保证**：`p50 ≤ p95 ≤ p99 ≤ max` **恒成立**（用下标取整而非插值，
插值在样本很少时会算出比 max 还大的数）。

**说明**
✅ 已实现。耗时只统计**脚本回调本体**（`nanoTime()` 包住 JS 调用），
记录/转换成本不计入 —— 否则剖析开销会随帧耗时一起反馈给自己，读数虚高。

**示例**
```js
if (bwe.prof.report().frames > 0 && bwe.prof.report().p95Ms > 8) {
  var r = bwe.prof.report();
  var worst = null;
  for (var i = 0; i < r.scripts.length; i++) {
    if (!worst || r.scripts[i].p95Ms > worst.p95Ms) worst = r.scripts[i];
  }
  bwe.log("帧耗时 p95=" + r.p95Ms.toFixed(2)
         + "ms，最慢脚本 " + worst.name + " p95=" + worst.p95Ms.toFixed(2) + "ms");
}
```

---

### bwe.prof.reset() → boolean

**签名**
`bwe.prof.reset(): boolean`

**参数**
无

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。清空整帧样本与每脚本统计，**开关状态保持不变**。
注意它**不清**错误缓冲 —— 那是 [bwe.debug.clearErrors](#bwedebugclearerrors--boolean) 的事。

**示例**
```js
bwe.prof.reset();    // 刚打开剖析时先清一次，避免把预热期算进来
```

---

## 七、排查顺序：一次真实的排错走法

API 会用 ≠ 知道先看哪个数。这一节给一个**固定顺序**，照着走能少绕几圈。
核心原则：**先确认「坏了没有」，再定位「坏在哪」，最后才量「有多慢」**。
顺序反了就会在没问题的地方调参。

### 第 1 步：有没有脚本在报错

```js
var errs = bwe.debug.errors();
if (errs.length) {
  bwe.log("错误 " + errs.length + " 条，最新：" + errs[errs.length - 1].script
          + ":" + errs[errs.length - 1].line + " ×" + errs[errs.length - 1].count);
}
```

**只看两件事**：`count` 大不大、`script:line` 是不是同一个位置。

- `count` 远大于 1 ⇒ 这条在**每帧反复抛**，先修它，别继续往下看性能
  （每帧抛异常本身就能把帧耗时拉高一个数量级，你会误判成"性能问题"）。
- `line` 是 `-1` ⇒ 拿不到行号（通常来自非 Rhino 的 Java 侧异常），按 `message` 定位。

### 第 2 步：把错误固定下来（不要边看边消失）

```js
if (bwe.debug.errors().length > 0) bwe.debug.dumpErrors();
// → 工程根/Build/diagnostics/script-errors.json
```

落盘之后你能：把文件贴给别人、喂给 AI 助手、或和修复后的版本对 diff。
**修完再 `bwe.debug.clearErrors()`**，让"重新观察"从干净状态开始（它还一并重置了日志去重表，
所以修好后同一个位置再炸，日志会重新出现 —— 不会出现"改了但日志不报"的假象）。

### 第 3 步：错误清干净了才看耗时

```js
bwe.prof.reset();          // 丢掉预热期
bwe.prof.enable(true);
// ... 让它跑 30~60 秒 ...
var r = bwe.prof.report();
bwe.log("frames=" + r.frames + " p50=" + r.p50Ms.toFixed(2)
       + " p95=" + r.p95Ms.toFixed(2) + " p99=" + r.p99Ms.toFixed(2));
```

**读数的顺序是 p50 → p99 → p95，不是反过来**：

| 先看 | 判读 | 说明 |
|---|---|---|
| `p50` | **算法成本** | 稳、不受偶发抢占影响。它涨了就是真的变慢了，别怀疑"机器忙" |
| `p99` | **尾延迟** | 玩家能感知的是这个。p99 高而 p50 正常 ⇒ 存在周期性长卡顿（GC / 一次性资源加载） |
| `p95` | 定位到人 | 配上 `scripts[].p95Ms` 找出最慢的那一个脚本 |

`frames` 为 `0` ⇒ **没有可用样本**（从未 `enable`，或 `reset` 之后还没跑过帧），
这时候 `p50Ms` 等全是 `0`，不要当成"很快"。

### 第 4 步：找到最慢的脚本，然后**回去看第 1 步**

```js
var r = bwe.prof.report(), worst = null;
for (var i = 0; i < r.scripts.length; i++) {
  if (!worst || r.scripts[i].p95Ms > worst.p95Ms) worst = r.scripts[i];
}
if (worst) bwe.log("最慢脚本 " + worst.name + " p95=" + worst.p95Ms.toFixed(2)
                 + "ms 调用 " + worst.calls + " 次");
```

看到某个脚本很慢，**先确认它是不是在报错**（回到第 1 步查 `scripts` 名）：
抛异常 + 每帧重试的脚本一定又慢又吵，修掉错误之后性能常常自己就好了。

### 一次完整的排查示例（可直接复制）

```js
// 放在场景脚本的 onSceneStart 里：开测
function onSceneStart(ctx) {
  bwe.prof.enable(true);
}

// 放在 onUpdate 里：每 60 帧打印一次水位，异常时自动落盘
var n = 0;
function onUpdate(ctx, dt) {
  if (++n % 60 !== 0) return;

  var errs = bwe.debug.errors();
  if (errs.length > 3) {
    var e = errs[errs.length - 1];
    bwe.log("[观测] 错误 " + errs.length + " 条，最新 " + e.script + ":" + e.line
            + " ×" + e.count);
    bwe.debug.dumpErrors();          // 现场取证
  }

  var r = bwe.prof.report();
  if (r.frames > 0 && r.p99Ms > 8) {
    var worst = null;
    for (var i = 0; i < r.scripts.length; i++) {
      if (!worst || r.scripts[i].p95Ms > worst.p95Ms) worst = r.scripts[i];
    }
    bwe.log("[观测] p50=" + r.p50Ms.toFixed(2) + " p95=" + r.p95Ms.toFixed(2)
           + " p99=" + r.p99Ms.toFixed(2) + "ms，最慢脚本 "
           + (worst ? worst.name + " p95=" + worst.p95Ms.toFixed(2) + "ms" : "无"));
  }
}
```

### 三个常见误判

| 现象 | 不是这个原因 | 真因 |
|---|---|---|
| `p99` 很高但 `p50` 正常 | 算法退化成 O(n²) | 周期性长卡顿：GC / 一次性加载。查 `maxFrame` 附近的场景事件 |
| `frames` 一直是 `0` | 帧跑得太快 | 剖析没 `enable`，或 `reset` 之后还没推进帧 |
| 加了观测之后变卡 | 观测开销 | 先量 `recordCall` 单次开销（实测约 4ns）；变卡更可能是 **`dumpErrors` 被每帧调用**（有磁盘 IO），改成"错误数超阈值才落盘" |

---

## 另见

- [draw：绘制](draw-audio-save.md) —— `bwe.draw` 是正式 HUD 绘制，`bwe.debug` 是临时调试
- [collision：碰撞](collision.md) —— 用 `debug.box` / `debug.circle` 可视化查询范围
- [spatial：多层空间](spatial.md) —— `debug.zones` 画区域边界
- [road：路网](road.md) —— `debug.paths` 画路径
