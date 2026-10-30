# bwe.actions — 输入动作映射（Actions）

> 本页覆盖：`bwe.actions` 的全部成员 —— 动作映射（可配置改键）、动作查询（按住 / 按下 / 松开 / 方向轴）、输入上下文栈与放行规则、焦点状态、动作事件。
>
> 相关页：[input：输入](input-camera-time.md) · [lifecycle：生命周期与 ctx](lifecycle.md) · [README：索引](README.md)

## 解决什么问题

`bwe.input` 只给**原始键**（`down("KeyW")`）和一个写死 WASD/方向键的 `axis()`。改键就必须改游戏逻辑脚本。

`bwe.actions` 把输入分成三层，让**键位可以在配置里改**，游戏逻辑只碰中间那层：

```
物理键（KeyW / Space / Mouse0 …）
    │  ← bwe.input（原始层，完全保留不动）
    ▼
动作映射 bind({ move_up: ["KeyW","ArrowUp"], ... })
    │
    ▼
动作查询 down / pressed / released / axis   ← 游戏逻辑只碰这一层
    │
    ▼
输入上下文 pushContext("ui") → 只有当前上下文放行的动作可见
```

**生命周期**：映射表与上下文栈是**工程级**（跨场景保留），所以 `onSceneStart` 里 `bind` 一次即可。场景卸载**不清**映射（否则每次切场景都要重 bind，容易漏）。

**窗口失焦**：引擎在窗口失焦时会通知本命名空间 —— 所有动作立刻变 `false`，且本帧不产生 `pressed`。避免"按住 W 切出去，回来角色一直在走"。

**Phase 说明**：`✅ 已实现`。

## 默认动作映射

任务书点名的 9 个动作，`reset()` 会恢复成这张表：

| 动作 | 默认键 |
|---|---|
| `move_up` | `KeyW` / `ArrowUp` |
| `move_down` | `KeyS` / `ArrowDown` |
| `move_left` | `KeyA` / `ArrowLeft` |
| `move_right` | `KeyD` / `ArrowRight` |
| `attack` | `Space` / `Mouse0` |
| `defend` | `KeyQ` / `Mouse2` |
| `interact` | `KeyE` |
| `enter_vehicle` | `KeyF` |
| `switch_weapon` | `KeyR` |

---

## 一、映射管理

### bwe.actions.bind({action: [...]}) → boolean

**签名**
`bwe.actions.bind(map: { [action: string]: string | string[] }): boolean`

**参数**
- `map` — 动作名 → 键。值可以是：
  - 键名字符串：`"KeyW"`
  - 键名数组：`["KeyW", "ArrowUp"]`
  - 逗号分隔字符串：`"KeyW,ArrowUp"`
  - 数值键码（向后兼容）

**返回**
`boolean` — 是否写入成功（参数不是对象时 `false`）

**说明**
✅ 已实现。**合并写入**：只改 `map` 里提到的动作，未提到的保持原样。所以可以分多次 bind 不同动作。

键名与编辑器同名（`"KeyW"` / `"Space"` / `"Mouse0"`），脚本作者不需要记 Java 键码。

**示例**
```js
// onSceneStart 里 bind 一次（工程级，跨场景保留）
bwe.actions.bind({
  move_up:    ["KeyW", "ArrowUp"],
  attack:     ["Space", "Mouse0"],
  interact:   "KeyE",
});

// 之后游戏逻辑只问动作名，不问键名
if (bwe.actions.pressed("interact")) {
  bwe.log("按了交互键");
}
```

**另见**
[bwe.actions.unbind](#bweactionsunbindaction--boolean) · [bwe.actions.reset](#bweactionsreset--boolean)

---

### bwe.actions.unbind(action) → boolean

**签名**
`bwe.actions.unbind(action: string): boolean`

**参数**
- `action` — 动作名

**返回**
`boolean` — 是否真的删掉了一个映射；动作为空串或不存在返回 `false`

**说明**
✅ 已实现。删掉后该动作的所有查询恒为 `false`。

**示例**
```js
bwe.actions.bind({ attack: ["KeyF"] });
bwe.actions.unbind("attack");    // 攻击键彻底失效
```

---

### bwe.actions.reset() → boolean

**签名**
`bwe.actions.reset(): boolean`

**参数**
无

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。清空自定义映射并恢复[默认动作映射](#默认动作映射)。

**示例**
```js
bwe.actions.reset();   // "恢复默认按键" 菜单项
```

---

### bwe.actions.actions() → string[]

**签名**
`bwe.actions.actions(): string[]`

**参数**
无

**返回**
`string[]` — 当前映射表里的全部动作名

**说明**
✅ 已实现。注意到返回的是**当前表**里的，不是默认表的。

**示例**
```js
var names = bwe.actions.actions();
bwe.log("已绑定 " + names.length + " 个动作：" + names.join(","));
```

---

### bwe.actions.keys(action) → string[]

**签名**
`bwe.actions.keys(action: string): string[]`

**参数**
- `action` — 动作名

**返回**
`string[]` — 该动作绑定的键（键名 / 键码的字符串形式）；动作不存在返回**空数组**

**说明**
✅ 已实现。用于做"当前键位"设置界面。

**示例**
```js
bwe.log("attack 绑了：" + bwe.actions.keys("attack").join(","));
// → "32,10000"（Space / Mouse0 的码；具体形式见 bwe.input）
```

**另见**
[bwe.actions.bind](#bweactionsbindaction---boolean)

---

## 二、动作查询

### bwe.actions.down(action) → boolean

**签名**
`bwe.actions.down(action: string): boolean`

**参数**
- `action` — 动作名

**返回**
`boolean` — 是否**持续按住**

**说明**
✅ 已实现。同时满足三个条件才为 `true`：
1. 窗口有焦点
2. 该动作在当前上下文**被放行**
3. 该动作的任一键处于按下状态

**示例**
```js
if (bwe.actions.down("move_right")) {
  me.x += speed * dt;
}
```

---

### bwe.actions.pressed(action) → boolean

**签名**
`bwe.actions.pressed(action: string): boolean`

**参数**
- `action` — 动作名

**返回**
`boolean` — 是否**本帧刚按下**（边沿触发）

**说明**
✅ 已实现。鼠标键（码 ≥ 10000）与键盘键走不同的判定路径，但结果一致。

**示例**
```js
if (bwe.actions.pressed("attack")) {
  bwe.combat.hit({ from: me, to: nearestEnemy });
}
```

---

### bwe.actions.released(action) → boolean

**签名**
`bwe.actions.released(action: string): boolean`

**参数**
- `action` — 动作名

**返回**
`boolean` — 是否**本帧刚松开**（边沿触发）

**说明**
✅ 已实现。

**示例**
```js
if (bwe.actions.released("attack")) {
  bwe.log("松开了攻击键");
}
```

---

### bwe.actions.axis() → {x, y}

**签名**
`bwe.actions.axis(): { x: number; y: number }`

**参数**
无

**返回**
`{x, y}` — 方向轴，已归一化（斜向不会更长）

**说明**
✅ 已实现。用 `move_up` / `move_down` / `move_left` / `move_right` 四个动作合成：`x ∈ [-1, 1]`、`y ∈ [-1, 1]`，长度超过 1 时归一化。**Y 向下**（与全引擎一致）。

**关键区别**：`bwe.actions.axis()` 用的是**动作**（可改键），`bwe.input.axis()` 用的是写死 WASD/方向键。前者才是推荐写法。

**示例**
```js
var ax = bwe.actions.axis();
me.x += ax.x * speed * dt;
me.y += ax.y * speed * dt;
```

**另见**
[bwe.input.axis](input-camera-time.md)

---

## 三、输入上下文

### bwe.actions.context() → string

**签名**
`bwe.actions.context(): string`

**参数**
无

**返回**
`string` — 当前上下文名（栈空时 `"game"`）

**说明**
✅ 已实现。上下文是**栈**，取栈顶。

**示例**
```js
bwe.log("当前输入上下文：" + bwe.actions.context());
```

---

### bwe.actions.pushContext(name) → boolean

**签名**
`bwe.actions.pushContext(name: string): boolean`

**参数**
- `name` — 上下文名（如 `"ui"`）

**返回**
`boolean` — 是否压入成功（空串返回 `false`）

**说明**
✅ 已实现。典型用途：打开背包 / 菜单时压 `"ui"`，让游戏逻辑的动作查询全部失效，而不必在每个 `if` 里判断"菜单开着吗"。

**示例**
```js
function openMenu() {
  bwe.actions.pushContext("ui");
}
function closeMenu() {
  bwe.actions.popContext();
}
```

**另见**
[bwe.actions.popContext](#bweactionspopcontext--string--null) · [bwe.actions.allow](#bweactionsallowcontext-actions--boolean)

---

### bwe.actions.popContext() → string | null

**签名**
`bwe.actions.popContext(): string | null`

**参数**
无

**返回**
`string | null` — 被弹出的上下文名；栈空时 `null`（不报错）

**说明**
✅ 已实现。**成对使用**，别只 push 不 pop —— 栈会一直长，且游戏动作永久失效。

**示例**
```js
var popped = bwe.actions.popContext();
bwe.log("退出上下文：" + popped);
```

---

### bwe.actions.setContext(name) → boolean

**签名**
`bwe.actions.setContext(name: string): boolean`

**参数**
- `name` — 上下文名；空串 = 清空栈

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。直接**重置**成单一上下文（清空整个栈再压一个），适合"回到游戏"这种强复位。

**示例**
```js
bwe.actions.setContext("");        // 清空栈 → 回到 "game"
bwe.actions.setContext("game");    // 显式设为 game
```

---

### bwe.actions.allow(context, actions) → boolean

**签名**
`bwe.actions.allow(context: string, actions: string[]): boolean`

**参数**
- `context` — 上下文名
- `actions` — 该上下文**只放行**的动作名数组（空数组 = 全禁）

**返回**
`boolean` — 恒 `true`

**说明**
✅ 已实现。**不调用 `allow` = 全部放行**（这是默认行为，旧脚本不受影响）。调用了之后，该上下文里**不在名单里的动作**查询一律返回 `false`。

**示例**
```js
// UI 上下文里只允许这两个动作
bwe.actions.allow("ui", ["interact", "attack"]);
bwe.actions.pushContext("ui");
// 现在 down("move_right") 为 false，down("interact") 仍可查
```

---

## 四、事件与焦点

### bwe.actions.on(action, fn) → Function | null

**签名**
`bwe.actions.on(action: string, fn: Function): Function | null`

**参数**
- `action` — 动作名
- `fn` — 该动作**按下**时派发的回调

**返回**
传进去的 `fn` 本身（便于 `off(fn)`）；动作名为空或 `fn` 非法时返回 `null`

**说明**
✅ 已实现。回调属于**注册它的那个脚本**，场景卸载时按脚本清理。

**示例**
```js
var onJump = function () { bwe.log("跳！"); };
bwe.actions.on("move_up", onJump);
```

**另见**
[bwe.actions.off](#bweactionsofffn--boolean)

---

### bwe.actions.off(fn) → boolean

**签名**
`bwe.actions.off(fn: Function): boolean`

**参数**
- `fn` — 回调引用

**返回**
`boolean` — 是否真的摘掉了

**说明**
✅ 已实现。两种调用形式：

```js
bwe.actions.off(fn);                 // 所有动作里找这个函数
bwe.actions.off("attack", fn);       // 只在 attack 里找
```

注意：第二种形式只有在**第一种没删掉任何东西**时才会走（源码里是"先全扫，没删到再按动作找"）。

**示例**
```js
bwe.actions.off(onJump);
```

---

### bwe.actions.focused() → boolean

**签名**
`bwe.actions.focused(): boolean`

**参数**
无

**返回**
`boolean` — 窗口当前是否有焦点

**说明**
✅ 已实现。失焦期间所有动作查询恒为 `false`（见页面开头的失焦说明）。UI 可以拿它做"点击继续"提示。

**示例**
```js
if (!bwe.actions.focused()) {
  bwe.log("窗口失焦，暂停输入");
}
```

---

## 另见

- [input：输入](input-camera-time.md) —— 原始键层（`bwe.input`）
- [combat：战斗](combat.md) —— `attack` / `switch_weapon` 动作的常见消费者
- [vehicle：车辆](vehicle.md) —— `enter_vehicle` 动作的常见消费者
