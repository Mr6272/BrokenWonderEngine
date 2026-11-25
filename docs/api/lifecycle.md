# 生命周期与运行上下文（Lifecycle & Ctx）

> 本页覆盖：对象脚本 / 场景脚本的回调约定、`ctx` 结构、全局钩子 `bwe.on`/`bwe.off`、定时器 `bwe.after`/`bwe.every`/`bwe.cancel`、以及根命名空间的工具函数（日志、随机、数学、跨脚本调用）。
>
> 相关页：[world：实体查找与生成](world.md) · [entity：实体属性与行为](entity.md) · [input-camera-time：输入 / 相机 / 时间](input-camera-time.md) · [README：索引](README.md)

**执行环境**：全部示例都是 ES5（`var` / `function`）。运行时是 Rhino 1.7.15，编辑器可以把现代语法降级，但文档统一用 ES5 最稳。

**Phase 说明**：`✅ 已实现` = 代码里确实有；`🧪 试验` = 有实现但语义可能变；`📋 规划` = 还没有实现，只是契约占位。

---

## 一、脚本怎么被调用

引擎里有两类脚本：

| 类型 | 挂在哪里 | 拿到哪些回调 |
|---|---|---|
| **对象脚本** | 对象 Inspector → 「脚本」区 → 选脚本（写进 `script.js` 模块的 `params.script`） | `onStart` / `onUpdate` / `onClick` / `onEnter` / `onLeave` / `onInteract` / `onDamage` / `onDeath` / `onDestroy` / `onKey` |
| **场景脚本** | 场景设置里的 `onStartScript`，或 `boot.json` 的 `jsMain` | `onSceneStart` / `onSceneEnd` |

**代码里真实派发的回调一共 12 个**：`onStart`、`onUpdate`、`onClick`、`onKey`、`onDestroy`、`onEnter`、`onLeave`、`onInteract`、`onDamage`、`onDeath`、`onSceneStart`、`onSceneEnd`。表里没写的名字（例如 `onSceneEnd` 之前被当成占位的那些）不会被调用。

两类脚本共享同一个全局作用域：顶层 `var` / `function` 是全局共享的，**没有模块隔离**（所以不能用 `import` / `require`，跨脚本调用走 `bwe.call`）。

每个脚本有独立的 scope 对象用于顶层执行，但 `bwe` / `console` 等全局对象都挂在共同的原型链上。

---

### onStart(ctx) → void

**签名**
`function onStart(ctx: Ctx): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文；`ctx.self` 是挂了本脚本的实体 |

**返回**
`void`（返回值被忽略）

**说明**
✅ 已实现。对象生成完成后调用一次：场景原生对象在脚本引擎首次启动时调用，`bwe.world.spawn` / `bwe.prefab.spawn` 生成的实体在生成当帧调用。
在 `onStart` 里注册全局钩子（`bwe.on`）要注意：同一个脚本挂到 2 个对象上时，`onStart` 会跑 2 次，钩子也注册 2 次 —— 用全局标记位防重。

**示例**
```js
var G = { hp: 100, ready: false };

function onStart(ctx) {
  G.hp = ctx.self.hpMax;
  G.ready = true;
  bwe.log("生成了：" + ctx.self.name);
}
```

**另见**
[onUpdate](#onupditectx-dt--void) · [Ctx 结构](#四ctx-结构) · [bwe.on](#bweonname-fn--void)

---

### onUpdate(ctx, dt) → void

**签名**
`function onUpdate(ctx: Ctx, dt: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文 |
| dt | number | 本帧步长（秒），已被 `timeScale` 缩放、被钳制在 `[0, 0.1]` |

**返回**
`void`

**说明**
✅ 已实现。每帧调用，`bwe.world.paused = true` 期间不调用。
`dt` 与 `ctx.dt` 是同一个值。单次回调超过 250ms 会写一次「可能存在死循环」告警（同一脚本只报一次）。

**示例**
```js
function onUpdate(ctx, dt) {
  var a = bwe.input.axis();
  ctx.self.x = ctx.self.x + a.x * 120 * dt;
  ctx.self.y = ctx.self.y + a.y * 120 * dt;
}
```

**另见**
[onStart](#onstartctx--void) · [bwe.time](#二bwetime-只读属性) · [bwe.input](input-camera-time.md#bweinputaxis--vec2)

---

### onClick(ctx) → void

**签名**
`function onClick(ctx: Ctx): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文；`ctx.self` 是被点中的实体 |

**返回**
`void`

**说明**
✅ 已实现。鼠标按下时命中该实体则调用（命中判定从最上层往下：`layer` → `z` → `y`，与绘制顺序相反）。
只有对象脚本会收到 `onClick`；场景脚本请用全局钩子 `bwe.on("click", fn)`，它拿到的是点击信息对象。

**示例**
```js
function onClick(ctx) {
  ctx.self.hp = ctx.self.hpMax;
  bwe.log("点到了 " + ctx.self.name);
}
```

**另见**
[bwe.on](#bweonname-fn--void) · [Entity.on](entity.md#eonname-fn--void)

---

### onEnter(ctx, other) → void

**签名**
`function onEnter(ctx: Ctx, other: Entity): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文 |
| other | Entity | 进入范围的实体（目前只有玩家会触发） |

**返回**
`void`

**说明**
✅ 已实现，但**只对 `kind === "ZONE"` 的对象生效**。引擎每帧检查玩家中心点是否落在该对象的绘制矩形内（半宽/半高判定），只在「从外到内」那一帧派发一次。
不是 ZONE 的对象挂 `onEnter` 永远不会被调用 —— 想要通用范围检测请用 `sense.range` 模块或在脚本里自己算距离。

**示例**
```js
function onEnter(ctx, other) {
  bwe.log("玩家进了房间：" + other.name);
  bwe.audio.play("开门", { volume: 0.8 });
}
```

**另见**
[onLeave](#onleavectx-other--void) · [bwe.world.find](world.md#bweworldfindq--entity--null)

---

### onLeave(ctx, other) → void

**签名**
`function onLeave(ctx: Ctx, other: Entity): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文 |
| other | Entity | 离开范围的实体（目前只有玩家） |

**返回**
`void`

**说明**
✅ 已实现，同样**只对 `kind === "ZONE"` 的对象生效**。玩家从矩形内到外的那一帧派发一次。

**示例**
```js
function onLeave(ctx, other) {
  bwe.log("玩家离开了");
}
```

**另见**
[onEnter](#onenterctx-other--void)

---

### onInteract(ctx, actor) → void

**签名**
`function onInteract(ctx: Ctx, actor: Entity): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文；`ctx.self` 是被交互的对象 |
| actor | Entity \| null | 触发交互的玩家实体（没找到玩家时为 `null`） |

**返回**
`void`

**说明**
✅ 已实现。触发条件：`bwe.interact.nearest(...)` 已把本对象记为「最近交互物」，且玩家按下交互键（默认 `KeyE`，可用 `bwe.interact.setKey` 改）。
派发顺序：先所有 `bwe.interact.onTrigger` 回调（拿到 `(target, actor)`），再实体的 `"interact"` 事件，最后本对象的 `onInteract`。

**示例**
```js
function onInteract(ctx, actor) {
  bwe.interact.prompt(null);
  bwe.call("dialog", "openLine", "欢迎来到哨站。");
}
```

**另见**
[bwe.interact](map-nav-interact-spawner.md#bweinteractnearestactor-opts--entity--null) · [bwe.interact.onTrigger](map-nav-interact-spawner.md#bweinteractontriggerfn--void)

---

### onDamage(ctx, amount, from) → void

**签名**
`function onDamage(ctx: Ctx, amount: number, from: Entity | null): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文 |
| amount | number | 本次扣血量 |
| from | Entity \| null | 伤害来源；火焰/环境伤害时通常是 `null` |

**返回**
`void`

**说明**
✅ 已实现，由 `e.damage(n)` 或材质场（火焰烧毁）派发。
「扣血 → 派发 → 判死 → 派发 `onDeath`」是同一个调用栈里完成的，所以 `onDamage` 里把 `hp` 加回去可以避免死亡。

**示例**
```js
function onDamage(ctx, amount, from) {
  bwe.log("挨了 " + amount + " 点");
  if (from) {
    bwe.camera.shake(4, 0.15);
  }
}
```

**另见**
[onDeath](#ondeathctx-by--void) · [Entity.damage](entity.md#edamagen--number)

---

### onDeath(ctx, by) → void

**签名**
`function onDeath(ctx: Ctx, by: Entity | null): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文 |
| by | Entity \| null | 致死来源 |

**返回**
`void`

**说明**
✅ 已实现。`hp <= 0` 时由 `e.damage(n)` 触发（或在材质场烧毁时由 `ScriptFields` 触发）。
触发时实体已被标记为 `dead`（`e.alive === false`），**但还在场景里**；要真正移除请调 `e.destroy()` 或等一下让引擎清理。

**示例**
```js
function onDeath(ctx, by) {
  bwe.world.spawn({ x: ctx.self.x, y: ctx.self.y, asset: "掉落物", kind: "PROP" });
  ctx.self.destroy();
}
```

**另见**
[onDamage](#ondamagectx-amount-from--void) · [onDestroy](#ondestroyctx--void)

---

### onDestroy(ctx) → void

**签名**
`function onDestroy(ctx: Ctx): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文 |

**返回**
`void`

**说明**
✅ 已实现。实体被销毁（`e.destroy()` / `bwe.world.destroy(e)` / 批量销毁）时派发，**在从场景移除之前**。
这里还能读 `ctx.self` 的属性、还能 spawn 别的实体。派发顺序：先 `onDestroy`，再实体的 `"destroy"` 事件，最后才真正移除。

**示例**
```js
function onDestroy(ctx) {
  bwe.world.emit("敌人被清掉", { name: ctx.self.name });
}
```

**另见**
[Entity.destroy](entity.md#edestroy--void) · [bwe.world.destroy](world.md#bweworlddestroye--void)

---

### onKey(ctx, key) → void

**签名**
`function onKey(ctx: Ctx, key: string): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文 |
| key | string | 键名，如 `"KeyE"` / `"Space"` / `"ArrowLeft"` / `"Digit1"`；无法识别的键是 `"KeyCode<数字>"` |

**返回**
`void`

**说明**
✅ 已实现。任意键按下时对**所有挂了脚本且还活着的对象**派发 —— 没按过滤条件，所以每个对象脚本都会收到每一次按键。全局按键建议用 `bwe.on("keydown", fn)`（载荷更全，带 keyCode）。

**示例**
```js
function onKey(ctx, key) {
  if (key === "KeyR") {
    ctx.self.setPos(64, 64);
    bwe.log("重置位置");
  }
}
```

**另见**
[bwe.on](#bweonname-fn--void) · [键名表](#五键名表)

---

### onSceneStart(ctx) → void

**签名**
`function onSceneStart(ctx: Ctx): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文；`ctx.self` 为 `null`（场景脚本没有实体） |

**返回**
`void`

**说明**
✅ 已实现。执行时机：所有脚本顶层代码执行完 → 对象脚本 `onStart` 全部派发完 → `jsMain` 的 `onSceneStart` → 场景 `onStartScript` 的 `onSceneStart`。
如果 `jsMain` 与场景 `onStartScript` 是同一个脚本，只执行一次。`ctx.self` 在场景脚本里是 `null`，别直接读 `ctx.self.name`。

**示例**
```js
function onSceneStart(ctx) {
  bwe.log("场景开始：" + ctx.scene.name);
  bwe.camera.bounds({ x: 0, y: 0, w: ctx.scene.width, h: ctx.scene.height });
  bwe.every(1, function () {
    bwe.log("tick " + bwe.time.frame);
  });
}
```

**另见**
[onSceneEnd](#onsceneendctx--void) · [Ctx 结构](#四ctx-结构)

---

### onSceneEnd(ctx) → void

**签名**
`function onSceneEnd(ctx: Ctx): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ctx | Ctx | 运行上下文；`ctx.self` 为 `null`（场景脚本没有实体） |

**返回**
`void`

**说明**
✅ 已实现。**场景级**的结束回调，与 `onSceneStart` 完全对称。

精确语义（写代码时按这五条来理解）：

| 项 | 行为 |
|---|---|
| 派发对象 | **只派发给场景脚本** —— `scene.onStartScript` 与 `boot.json` 的 `jsMain`。**不派发给对象脚本** |
| 派发次数 | **只派发一次**（内部有幂等保护，重复关闭不会重复触发） |
| 触发时机 | 运行时**关闭**时：窗口关闭、进程退出、Ctrl+C 都会触发（挂在 JVM shutdown hook + `TopdownRuntime.dispose()` 两处，幂等） |
| **不是**什么 | **不是**「场景切换时」—— 当前运行时只加载第一个场景，没有场景切换，所以不会在游戏中途触发 |
| 用途 | 存档落盘（`bwe.save.flush()`）、上报统计、清理外部资源 |

**它不是 Unity 的 `OnDestroy`**（那是每个对象各自一次），**也不是 `OnApplicationQuit` 的等价物**（虽然行为很接近）—— 它是**场景级**的收尾回调，每局只跑一次。

两个前提要知道：
1. 只有在脚本引擎**成功启动过**（`started === true` 且没 `failed`）时才会派发；脚本初始化就失败的工程不会有这个回调。
2. 引擎在派发前后会排空微任务，但 `gl` 相关的绘制接口完全没有意义（窗口已经在关）—— 这里**不要**调 `bwe.draw.*`。

**示例**
```js
function onSceneEnd(ctx) {
  // 每局收尾：把成绩和位置写进存档并落盘
  bwe.save.set("lastScore", G.score);
  bwe.save.set("lastPos", { x: G.lastX, y: G.lastY });
  bwe.save.flush();
  bwe.log("场景结束，已落盘");
}
```

**另见**
[onSceneStart](#onscenestartctx--void) · [bwe.save.flush](draw-audio-save.md#bwesaveflush--boolean) · [Ctx 结构](#四ctx-结构)

---

## 二、全局钩子（bwe.on / bwe.off）

### bwe.on(name, fn) → void

**签名**
`bwe.on(name: string, fn: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 钩子名。内置：`"update"` / `"draw"` / `"keydown"` / `"click"`；也可以任意自定义名 |
| fn | Function | 回调；签名见下表 |

**返回**
`void`（**不返回取消函数** —— 要取消请用 `bwe.off(name, fn)`，且必须传同一个函数引用）

**说明**
✅ 已实现。注册到引擎的全局钩子表，一次注册长期有效，直到 `bwe.off`。

各内置钩子的回调签名：

| name | 回调参数 | 调用时机 |
|---|---|---|
| `"update"` | `fn(dt)` | 每帧（未暂停时），早于所有对象 `onUpdate` |
| `"draw"` | `fn()` | 帧末渲染前；`gl == null` 的无窗口自检里不调用 |
| `"keydown"` | `fn(keyName, keyCode)` | 按键按下（键盘事件在 update 线程统一派发） |
| `"click"` | `fn(info)` | 鼠标按下；`info` = `{screenX, screenY, worldX, worldY, x, y, right, entity}` |

自定义名不会自动派发 —— 引擎只在上述四个名字上调用；自定义名要靠 `bwe.world.emit` / `bwe.world.on` 那一套（注意那是**另一个**总线，见 [bwe.world.on](world.md#bweworldonname-fn--void)）。

**示例**
```js
function onSceneStart(ctx) {
  bwe.on("update", function (dt) {
    if (bwe.input.pressed("Space")) {
      bwe.log("space");
    }
  });
  bwe.on("keydown", function (keyName, keyCode) {
    bwe.log("按下 " + keyName + " (" + keyCode + ")");
  });
  bwe.on("click", function (info) {
    bwe.log("点在世界坐标 " + info.worldX + "," + info.worldY);
  });
  bwe.on("draw", function () {
    bwe.draw.text(8, 8, "HUD", { size: 16, color: "#ffffff" });
  });
}
```

**另见**
[bwe.off](#bweoffname-fn--void) · [bwe.world.on](world.md#bweworldonname-fn--void)（另一个事件总线）

---

### bwe.off(name, fn) → void

**签名**
`bwe.off(name: string, fn: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 注册时用的钩子名 |
| fn | Function | 注册时传的那个函数引用（按引用比较，不是按内容） |

**返回**
`void`

**说明**
✅ 已实现。从钩子表里移除**所有**与 `fn` 引用相同的回调。传匿名函数字面量是找不到的 —— 必须把函数存到变量里。

**示例**
```js
var onTick = null;

function onStart(ctx) {
  onTick = function (dt) { bwe.log("tick"); };
  bwe.on("update", onTick);
  bwe.after(3, function () {
    bwe.off("update", onTick);  // ✓ 同一个引用
  });
}
```

**另见**
[bwe.on](#bweonname-fn--void)

---

## 三、定时器

### bwe.after(sec, fn) → number

**签名**
`bwe.after(sec: number, fn: Function): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| sec | number | 延迟秒数；负数 / NaN 视为 0 |
| fn | Function | 到点执行一次，无参数 |

**返回**
`number` — 计时器 id，可传给 `bwe.cancel(id)`。`fn` 不是函数时返回 `-1`

**说明**
✅ 已实现。基于游戏时间（`bwe.time.now`），所以暂停时不会走、`timeScale` 会缩放它。
代替 `setTimeout` —— 运行时没有 `setTimeout` / `setInterval`。

**示例**
```js
function onStart(ctx) {
  var id = bwe.after(2.5, function () {
    bwe.log("2.5 秒到了");
  });
  // 想取消：bwe.cancel(id);
}
```

**另见**
[bwe.every](#bweeverysec-fn-opts--number) · [bwe.cancel](#bwecancelid--void)

---

### bwe.every(sec, fn, opts?) → number

**签名**
`bwe.every(sec: number, fn: Function, opts?: { times?: number }): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| sec | number | 间隔秒数，默认 1 |
| fn | Function | 每次触发执行，无参数 |
| opts.times | number | 最多执行几次；缺省或 `-1` = 不限 |

**返回**
`number` — 计时器 id；`fn` 不是函数时返回 `-1`

**说明**
✅ 已实现。代替 `setInterval`。掉帧时不会一次性补跑一堆：下一次的到期时间如果已经过去，就重置为「当前时间 + 间隔」。

**示例**
```js
function onSceneStart(ctx) {
  bwe.every(1, function () {
    bwe.log("第 " + bwe.time.frame + " 帧，已运行 " + bwe.time.now.toFixed(1) + "s");
  });
  // 只跑 3 次
  bwe.every(0.5, function () { bwe.audio.play("滴答"); }, { times: 3 });
}
```

**另见**
[bwe.after](#bweaftersec-fn--number) · [bwe.cancel](#bwecancelid--void)

---

### bwe.cancel(id) → void

**签名**
`bwe.cancel(id: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| id | number | `bwe.after` / `bwe.every` 返回的 id |

**返回**
`void`

**说明**
✅ 已实现。标记为取消，本帧末统一清理。取消不存在的 id 是安全的空操作。

**示例**
```js
var timerId = -1;

function onStart(ctx) {
  timerId = bwe.every(0.2, function () { bwe.log("blink"); });
}

function onDestroy(ctx) {
  if (timerId >= 0) {
    bwe.cancel(timerId);
  }
}
```

**另见**
[bwe.after](#bweaftersec-fn--number) · [bwe.every](#bweeverysec-fn-opts--number)

---

### bwe.tween(target, props, dur, opts) → TweenHandle

**签名**
`bwe.tween(target: unknown, props: Record<string, number>, dur: number, opts?: object): TweenHandle`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| target | unknown | 被补间的对象（当前实现**不看**） |
| props | Record<string, number> | 目标属性（当前实现**不看**） |
| dur | number | 时长（当前实现**不看**） |
| opts | object | 选项（当前实现**不看**） |

**返回**
`TweenHandle` — 空句柄 `{ done(fn), cancel() }`；`done(fn)` 返回自身，`cancel()` 什么都不做

**说明**
📋 规划（尚未实现行为）。这是个**占位**：首次调用会写一次日志 `bwe.tween 属 Phase 2，本版本不生效（返回空句柄）`，然后返回一个空句柄，**不会**真的插值。
之所以保留，是为了脚本探测 API 时不会崩。需要补间请自己在 `onUpdate` 里用 `bwe.lerp` 算。

**示例**
```js
// ⚠ 不会产生任何动画。等价于拿到了一个空对象。
var h = bwe.tween(ctx.self, { alpha: 0 }, 0.5);
h.done(function () { bwe.log("不会打印"); });

// ✓ 现在能用的写法：自己插值
var t = 0;
function onUpdate(ctx, dt) {
  t = Math.min(1, t + dt / 0.5);
  ctx.self.setAlpha(bwe.lerp(1, 0, t));
}
```

**另见**
[bwe.lerp](#bweerpa-b-t--number) · [bwe.after](#bweaftersec-fn--number)

---

## 四、`ctx` 结构

对象脚本和场景脚本拿到的第一个参数都是 `ctx`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `self` | Entity \| null | 挂了脚本的实体；**场景脚本里是 `null`** |
| `world` | World | 等同 `bwe.world` |
| `scene` | SceneInfo | 等同 `bwe.world.scene` |
| `time` | Time | 等同 `bwe.time` |
| `camera` | Camera | 等同 `bwe.camera` |
| `input` | Input | 等同 `bwe.input` |
| `save` | Save | 等同 `bwe.save` |
| `dt` | number | 本帧步长（秒），是 getter，每次读都是最新值 |
| `params` | Record<string, unknown> \| null | 本对象的**脚本公开字段**（默认值 ∪ 覆盖值）；场景脚本里是 `null` |
| `game` | 命名空间 | 等同 `bwe` 根对象 |

**说明**
✅ 已实现。`ctx` 是每次派发时新建的对象，不要长期持有 —— 但它包着的 `world` / `time` / `camera` / `input` / `save` / `game` 都是**同一个**长期对象，可以放心缓存。

`ctx.params` 是**按对象作用域**的：同一个 `enemy.js` 挂在十只小怪上，每只读到的都是自己那份
（声明写法见 [scripting-api.md 契约 §1.4「脚本公开字段」](../scripting-api.md)）。
它是惰性求值的：不读就不解析。等价写法 `bwe.params()` 在对象回调里返回同一个结果。

**示例**
```js
var W = null;

function onStart(ctx) {
  W = ctx.world;        // ✓ 长期有效
  bwe.log(ctx.scene.name + " " + ctx.scene.width + "x" + ctx.scene.height);
}

function onUpdate(ctx, dt) {
  W.emit("tick", { dt: dt });
}
```

**另见**
[Ctx 与全局命名空间的关系](#四ctx-结构) · [world.scene](world.md#bweworldscene--sceneinfo)

---

## 五、根命名空间工具函数

### bwe.params(defs?) → Record<string, unknown>

**签名**
`bwe.params(defs?: Record<string, unknown>): Record<string, unknown>`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| defs | Record<string, unknown> | 默认值表。**脚本顶层**传：声明这个脚本的公开字段。回调里省略：取当前对象的有效参数 |

**返回**
- 顶层调用：默认值的**拷贝**（改它不影响缓存，也不影响别的对象）；
- 回调里调用：`默认值 ∪ 当前对象的覆盖值` 的**新对象**（与 `ctx.params` 等价）；
- 没有对象（场景脚本）或没有声明：空对象 `{}`。

**说明**
✅ 已实现。脚本的「公开字段」——Unity 的 `public float speed` 那套。写一次声明，
编辑器右栏 Inspector 就会为**每个挂着本脚本的对象**渲染可编辑控件（数字框 / 文本框 / 开关，
按默认值类型选），用户改过的值存在对象 `script.js` 模块参数的 `params` 键里（JSON 文本）。

**只支持字面量**：`number` / `string` / `true` / `false` / `null`。
键可以是标识符或字符串（中文键写 `"移动速度": 100`）。嵌套对象、数组、变量、函数调用、
模板字符串一律不支持 —— 它们需要执行代码才知道值，而面板要在**不执行脚本**的前提下画出控件。
写错了会给一条中文原因 + 行号（面板显示一行提示，脚本照常跑）。

**按对象作用域**（关键）：脚本的 scope 是脚本级共享的（一只 `enemy.js` 挂十只怪共用一个 scope），
所以参数只能靠「调用期是哪个对象」区分，不能做成全局表 —— 否则最后初始化的那只把前面全改掉。

**示例**
```js
// 顶层：声明字段与默认值
bwe.params({
  speed: 100,        // 移动速度（这行注释会显示成控件说明）
  hp: 3,
  label: "玩家",
  alive: true
});

// A 用默认 100，B 在 Inspector 里改成 250 —— 同一个脚本，各调各的
function onUpdate(ctx, dt) {
  var p = ctx.params;              // 或者 bwe.params()
  if (!p.alive) return;
  ctx.self.x = ctx.self.x + p.speed * dt;
}
```

**另见**
[Ctx 结构](#四ctx-结构) · [契约 §1.4 脚本公开字段（数据字段 / 导出 / 运行时细节）](../scripting-api.md)

---

### bwe.log(...args) → void

**签名**
`bwe.log(...args: unknown[]): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ...args | unknown | 任意个值，用空格拼成一行 |

**返回**
`void`

**说明**
✅ 已实现。写进 `Build/bwe.log`，自动带 `[脚本] <脚本名>: ` 前缀。
`console.log` / `console.info` / `console.warn` 是它的别名。

**示例**
```js
bwe.log("hp =", ctx.self.hp, "alive =", ctx.self.alive);
console.log("等价写法");
```

**另见**
[bwe.error](#bweerrorargs--void)

---

### bwe.error(...args) → void

**签名**
`bwe.error(...args: unknown[]): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| ...args | unknown | 任意个值 |

**返回**
`void`

**说明**
✅ 已实现。写进日志，前缀带 `[错误]`。`console.error` 是别名。

**示例**
```js
bwe.error("找不到玩家实体");
```

**另见**
[bwe.log](#bwelogargs--void)

---

### bwe.random(min?, max?) → number

**签名**
`bwe.random(min?: number, max?: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| min | number | 下界，默认 0 |
| max | number | 上界（不含），默认 1 |

**返回**
`number` — `[min, max)` 之间的均匀分布；`max < min` 时自动交换

**说明**
✅ 已实现。**注意**：这个函数在涌现系统安装成功后被 `bwe.seed` 的确定性随机源覆盖（`ScriptAi` 会重新 attach 同名函数），所以同种子下可复现。并非 JS `Math.random` 的别名。

**示例**
```js
var x = bwe.random(0, 100);
var y = bwe.randomInt(1, 6);      // 1~6 含两端，骰子
var hit = bwe.chance(0.3);
```

**另见**
[bwe.randomInt](#bwerandomintmin-max--number) · [bwe.seed](emergence.md#bweseedsetn--number)

---

### bwe.randomInt(min, max) → number

**签名**
`bwe.randomInt(min: number, max: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| min | number | 下界（含），默认 0 |
| max | number | 上界（含），默认 1 |

**返回**
`number` — `[min, max]` 的整数；`max < min` 时自动交换

**说明**
✅ 已实现。两端都含。

**示例**
```js
var dmg = bwe.randomInt(5, 12);
```

**另见**
[bwe.random](#bwerandommin-max--number)

---

### bwe.chance(p) → boolean

**签名**
`bwe.chance(p: number): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| p | number | 概率 0~1，默认 0.5 |

**返回**
`boolean`

**说明**
✅ 已实现。`Math.random() < p` 的语义。

**示例**
```js
if (bwe.chance(0.1)) {
  bwe.audio.play("稀有掉落");
}
```

**另见**
[bwe.random](#bwerandommin-max--number)

---

### bwe.pick(arr) → unknown

**签名**
`bwe.pick(arr: unknown[]): unknown`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| arr | unknown[] | 任意数组 |

**返回**
`unknown` — 随机一个元素；数组为空或不是数组时返回 `null`

**说明**
✅ 已实现。用 `length` 判断是不是数组，非数组一律返回 `null`。

**示例**
```js
var names = ["史莱姆", "哥布林", "骷髅"];
var who = bwe.pick(names);
```

**另见**
[bwe.randomInt](#bwerandomintmin-max--number)

---

### bwe.clamp(v, a, b) → number

**签名**
`bwe.clamp(v: number, a: number, b: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| v | number | 待夹取值 |
| a | number | 下界 |
| b | number | 上界 |

**返回**
`number`

**说明**
✅ 已实现。`b < a` 时自动交换；`NaN` 输入会得到 `a`。

**示例**
```js
var hp = bwe.clamp(ctx.self.hp, 0, ctx.self.hpMax);
```

**另见**
[bwe.lerp](#bweerpa-b-t--number)

---

### bwe.lerp(a, b, t) → number

**签名**
`bwe.lerp(a: number, b: number, t: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| a | number | 起点 |
| b | number | 终点 |
| t | number | 插值系数（不做 0~1 钳制） |

**返回**
`number` — `a + (b - a) * t`

**说明**
✅ 已实现。

**示例**
```js
var mid = bwe.lerp(0, 100, 0.25);   // 25
```

**另见**
[bwe.clamp](#bweclampv-a-b--number)

---

### bwe.dist(x1, y1, x2, y2) → number

**签名**
`bwe.dist(x1: number, y1: number, x2: number, y2: number): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x1, y1 | number | 第一个点 |
| x2, y2 | number | 第二个点 |

**返回**
`number` — 欧氏距离（像素）

**说明**
✅ 已实现。

**示例**
```js
var d = bwe.dist(ctx.self.x, ctx.self.y, 100, 100);
```

**另见**
[Entity.distanceTo](entity.md#edistancetoother--number)

---

### bwe.call(scriptName, handlerName, ...args) → unknown

**签名**
`bwe.call(scriptName: string, handlerName: string, ...args: unknown[]): unknown`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| scriptName | string | 目标脚本名（`boot.json` 的 `scripts[].name`），不是文件路径 |
| handlerName | string | 该脚本顶层定义的函数名 |
| ...args | unknown | 透传给目标函数的参数 |

**返回**
`unknown` — 目标函数的返回值；脚本或函数不存在时返回 `null`

**说明**
✅ 已实现。跨脚本通信的推荐方式（脚本共享全局作用域，但显式调用更清晰）。目标函数在**它自己的 scope**里执行。
脚本不存在时静默返回 `null`，不报错 —— 想先判断用 `bwe.has(name)`。

**示例**
```js
if (bwe.has("score")) {
  var total = bwe.call("score", "add", 10);
  bwe.log("总分 " + total);
}
```

**另见**
[bwe.has](#bwehasscriptname--boolean) · [bwe.scripts.call](#bwescriptscallscriptname-handlername-args--unknown)

---

### bwe.has(scriptName) → boolean

**签名**
`bwe.has(scriptName: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| scriptName | string | 脚本名 |

**返回**
`boolean`

**说明**
✅ 已实现。判断 `boot.json` 的脚本表里有没有这个名字。

**示例**
```js
if (!bwe.has("hud")) {
  bwe.log("本工程没有 hud 脚本");
}
```

**另见**
[bwe.call](#bwecallscriptname-handlername-args--unknown)

---

### bwe.scripts.call(scriptName, handlerName, ...args) → unknown

**签名**
`bwe.scripts.call(scriptName: string, handlerName: string, ...args: unknown[]): unknown`

**参数**
同 `bwe.call`

**返回**
同 `bwe.call`

**说明**
✅ 已实现。`bwe.call` 的等价写法，两处实现完全一致，选一个用即可。

**示例**
```js
bwe.scripts.call("world", "spawnWave", 3);
```

**另见**
[bwe.call](#bwecallscriptname-handlername-args--unknown) · [bwe.scripts.has](#bwescriptshasscriptname--boolean)

---

### bwe.scripts.has(scriptName) → boolean

**签名**
`bwe.scripts.has(scriptName: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| scriptName | string | 脚本名 |

**返回**
`boolean`

**说明**
✅ 已实现。`bwe.has` 的等价写法。

**示例**
```js
bwe.scripts.has("player");
```

**另见**
[bwe.has](#bwehasscriptname--boolean)

---

## 五、键名表

`bwe.input.*` / `bwe.interact.setKey` / `onKey` 都吃这一套键名（大小写不敏感，也接受数字 keyCode）：

| 类别 | 可用写法 |
|---|---|
| 字母 | `"KeyA"`~`"KeyZ"`、`"A"`~`"Z"`、`"a"`~`"z"` |
| 数字 | `"Digit0"`~`"Digit9"`、`"0"`~`"9"` |
| 空白 / 回车 | `"Space"`、`" "`、`"Enter"`、`"Tab"`、`"Backspace"` |
| 修饰 | `"Shift"`、`"ShiftLeft"`、`"Control"`、`"ControlLeft"`、`"Alt"`、`"AltLeft"` |
| 方向 | `"ArrowLeft"`、`"ArrowRight"`、`"ArrowUp"`、`"ArrowDown"`、`"Left"`、`"Right"`、`"Up"`、`"Down"` |
| 功能键 | `"F1"`~`"F12"` |
| 符号 | `"Minus"`、`"Equal"`、`"Comma"`、`"Period"`、`"Slash"`、`"Semicolon"`、`"Quote"`、`"BracketLeft"`、`"BracketRight"`、`"Backslash"`、`"Backquote"` |
| 鼠标 | `"Mouse0"` / `"MouseLeft"` / `"mouseleft"`（左）、`"Mouse1"` / `"MouseMiddle"`（中）、`"Mouse2"` / `"MouseRight"`（右） |

**说明**
✅ 已实现。`onKey` 回调里收到的是**规范名**（`"KeyE"` / `"Digit1"` / `"Space"` …），不是用户当初写的别名。

**示例**
```js
bwe.input.down("Space");       // ✓
bwe.input.down(" ");           // ✓ 同一个键
bwe.input.down(32);            // ✓ AWT keyCode 也行
bwe.input.pressed("Mouse0");   // ✓ 鼠标左键
```

**另见**
[bwe.input](input-camera-time.md#bweinputdownkey--boolean)

---

## 附：错误与调试

| 行为 | 细节 |
|---|---|
| 脚本异常 | 写 `Build/bwe.log`，格式 `[脚本错误] <script>:<line>: <message>`；**同一脚本同一行只报一次**，游戏继续跑 |
| 死循环保护 | 单次回调超过 250ms 写一次告警，不做中断 |
| 未捕获异常 | 回调返回 `null`，不向宿主抛 |
| 微任务 | 每帧末排空 `Context.processMicrotasks()`，所以 `async/await` 的后续在下一次 update/draw 前继续 |
| 不可用 | `setTimeout` / `setInterval` / `import` / `require` / `require('fs')` 都没有 |
