# bwe.input / bwe.camera / bwe.time — 输入 · 相机 · 时间

> 本页覆盖：`bwe.input`（键盘、鼠标、方向轴）、`bwe.camera`（跟随、缩放、抖动、范围、坐标换算、画面适配）、`bwe.time`（时间与帧）。
> 定时器（`bwe.after` / `bwe.every` / `bwe.cancel`）在 [lifecycle.md](lifecycle.md#三定时器)，这里不重复。
>
> 相关页：[lifecycle：生命周期与 ctx](lifecycle.md) · [draw-audio-save](draw-audio-save.md) · [map-nav-interact-spawner](map-nav-interact-spawner.md) · [README：索引](README.md)

**坐标约定**：世界像素、中心点、**Y 轴向下**。屏幕坐标是**逻辑像素、左上原点**。

**Phase 说明**：`✅ 已实现` / `🧪 试验` / `📋 规划`。

---

## 一、bwe.input — 输入

### 键名（所有 input 函数通用）

`down` / `pressed` / `released` / `setKey` 都接受同一套键名，也接受 AWT keyCode 数字。完整列表见 [lifecycle.md 的键名表](lifecycle.md#五键名表)，常见的：

```
"KeyW" "KeyA" "KeyS" "KeyD" "KeyE" "KeyR"     字母（"W" / "w" 也认）
"Space" " "  "Enter" "Escape" "Tab"          空白与功能键
"ArrowLeft" "ArrowUp" ...                    方向键
"Digit1" ... "Digit0"                        数字键
"F1" ... "F12"                               功能键
"Mouse0" / "MouseLeft"                       鼠标左键
"Mouse1" / "MouseMiddle"                     鼠标中键
"Mouse2" / "MouseRight"                      鼠标右键
32 / 87 / ...                                AWT keyCode 数字
```

---

### bwe.input.down(key) → boolean

**签名**
`bwe.input.down(key: KeyName): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| key | `string \| number` | 键名或 keyCode |

**返回**
`boolean` — 当前是否**按住**

**说明**
✅ 已实现。键盘查「本帧按住状态」；鼠标同样是**真按住**：宿主把 AWT 的 `mousePressed` / `mouseReleased` 转给 `ScriptEngine.mouseButton(button, down)`，按住期间每帧都是 `true`，松开后变 `false`（窗口失焦时自动全部松开，不会卡键）。所以「按住左键连射」直接写 `if (bwe.input.down("Mouse0")) fire();` 即可（示例：孤胆枪手 player.js）。
无法识别的键名恒为 `false`（不抛异常）。

**示例**
```js
if (bwe.input.down("KeyW")) {
  ctx.self.y -= 100 * bwe.time.dt;
}
if (bwe.input.down("Mouse0")) {
  bwe.log("左键按着");
}
```

**另见**
[bwe.input.pressed](#bweinputpressedkey--boolean) · [bwe.input.axis](#bweinputax--vec2) · [bwe.input.block](#bweinputblockid-x-y-w-h--boolean) · [bwe.input.block](#bweinputblockid-x-y-w-h--boolean)

---

### bwe.input.pressed(key) → boolean

**签名**
`bwe.input.pressed(key: KeyName): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| key | `string \| number` | 键名或 keyCode |

**返回**
`boolean` — 本帧**刚按下**（边沿）

**说明**
✅ 已实现。只在「上一帧没按、这一帧按了」的那一帧为 `true`。
鼠标的 `pressed` 也是「本帧刚按下」，由点击队列统一派发（每帧末清空）。

**示例**
```js
function onUpdate(ctx, dt) {
  if (bwe.input.pressed("Space")) {
    bwe.audio.play("跳跃");
  }
  if (bwe.input.pressed("KeyE")) {
    bwe.interact.onTrigger(function (target, actor) { bwe.log("交互"); });
  }
}
```

**另见**
[bwe.input.down](#bweinputdownkey--boolean) · [bwe.input.released](#bweinputreleasedkey--boolean)

---

### bwe.input.released(key) → boolean

**签名**
`bwe.input.released(key: KeyName): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| key | `string \| number` | 键名或 keyCode |

**返回**
`boolean` — 本帧**刚抬起**（边沿）

**说明**
✅ 已实现。鼠标的 released 通过「上一帧按住 && 本帧没按住」推断：松开鼠标的那一帧为 `true`，其余帧为 `false`（右键亦然）。

**示例**
```js
if (bwe.input.released("KeyW")) {
  bwe.log("松开了 W");
}
```

**另见**
[bwe.input.pressed](#bweinputpressedkey--boolean)

---

### bwe.input.axis() → Vec2

**签名**
`bwe.input.axis(): { x: number; y: number }`

**参数**
无

**返回**
`Vec2` — 方向轴，已归一化（长度 0 或 1）

**说明**
✅ 已实现。固定读这几组键：

| 轴方向 | 可用按键 |
|---|---|
| 左 | `A` / `←` |
| 右 | `D` / `→` |
| 上 | `W` / `↑` |
| 下 | `S` / `↓` |

`y` 的正方向是**下**（与屏幕一致）。**不能自定义按键** —— 想用别的键请自己组合 `bwe.input.down`。

**示例**
```js
function onUpdate(ctx, dt) {
  var a = bwe.input.axis();
  if (a.x !== 0 || a.y !== 0) {
    ctx.self.x += a.x * 150 * dt;
    ctx.self.y += a.y * 150 * dt;
    ctx.self.rotation = Math.atan2(a.y, a.x) * 180 / Math.PI;
  }
}
```

**另见**
[bwe.input.down](#bweinputdownkey--boolean) · [e.rotation](entity.md#erotation--number)

---

### bwe.input.mouse → MouseState

**签名**
`bwe.input.mouse: { x, y, worldX, worldY, left, middle, right, wheel }`（**只读**）

**参数**
无

**返回**
`MouseState` — 每次读都是**新建的快照对象**

| 字段 | 类型 | 说明 |
|---|---|---|
| `x` / `y` | number | **逻辑屏幕坐标**（左上原点，像素） |
| `worldX` / `worldY` | number | 已过视口反变换的**世界坐标** |
| `left` / `middle` / `right` | boolean | `mouseNow \|\| mousePressed`（按住状态：按住期间持续为 true，松开即 false） |
| `wheel` | number | **恒为 0** —— 宿主没有接滚轮事件，这个字段是占位 |

**说明**
✅ 已实现（`wheel` 除外，📋 规划）。

⚠ **无窗口 headless 自检/驱动器要注意**：`worldX/worldY` 来自宿主鼠标屏幕坐标 + 视口反变换，不是 `pointerDown(...)` 传进来的那份世界坐标。headless 里必须手动同步 `rt.mouseX/rt.mouseY`，否则会读到离谱值；真窗口由 AWT 事件写入，正常不受影响。

**示例**
```js
function onUpdate(ctx, dt) {
  var m = bwe.input.mouse;
  bwe.draw.text(8, 8, "鼠标 " + Math.round(m.x) + "," + Math.round(m.y));
  bwe.draw.text(8, 28, "世界 " + Math.round(m.worldX) + "," + Math.round(m.worldY));
}

function onKey(ctx, key) {
  if (key === "Mouse0") {
    var m = bwe.input.mouse;
    var hit = bwe.world.find({ name: "靶子" });
    bwe.log("点到世界坐标 " + m.worldX + "," + m.worldY);
  }
}
```

**另见**
[bwe.camera.screenToWorld](#bwecamerascreentoworldx-y--vec2) · [bwe.target.cell](emergence.md#bwetargetcell--targetcell--null)（鼠标所在格子）

---

### bwe.input.cursor(visible) → void

**签名**
`bwe.input.cursor(visible: boolean): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| visible | boolean | `true` = 恢复系统默认光标；`false` = 隐藏光标。省略按 `true` |

**返回**
`void`

**说明**
✅ 已实现。**真的改 AWT 组件的系统光标**（不是空实现）。

实现细节（踩过的坑）：
- 显示：`canvas.setCursor(Cursor.getDefaultCursor())`。
- 隐藏：AWT **不允许** `setCursor(null)`，所以走「**1×1 全透明自定义光标**」—— 用 `Toolkit.getBestCursorSize(1,1)` 取平台支持的尺寸，画一张全透明 ARGB 图，`createCustomCursor(...)` 装上去。观感等于光标消失。
- 某些平台不支持自定义光标 → 静默保留系统光标，**不崩、不报错**。
- 意图值会被记住（`host.cursorVisible`），但**不提供读取接口**（没有 `bwe.input.cursorVisible`）。

⚠ 这是**改系统光标**，不是「在游戏里画一个假光标」。想要自定义准星，请 `cursor(false)` 再自己用 `bwe.draw.sprite` 画一个跟随 `bwe.input.mouse` 的图。

**示例**
```js
function onStart(ctx) {
  bwe.input.cursor(false);      // 隐藏系统光标（做准星 / 触屏风格 UI）
}

function onSceneEnd(ctx) {
  bwe.input.cursor(true);       // 恢复（收尾时留个好印象）
}
```

**另见**
[bwe.input.mouse](#bweinputmouse--mousestate) · [bwe.draw.sprite](draw-audio-save.md#bwedrawspriteasset-x-y-opts--void)（自绘准星）

### bwe.input.block(id, x, y, w, h) → boolean

**签名**
`bwe.input.block(id: string, x: number, y: number, w: number, h: number): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| id | string | 区域名；同 id 重复调用即覆盖 |
| x, y | number | 矩形左上角（**屏幕逻辑像素**，不是世界坐标） |
| w, h | number | 矩形宽高；任一 ≤ 0 等于撤销该区域 |

**返回**
`boolean` —— 是否登记成功（id 为空或宽高非法返回 `false`）。

**说明**
✅ 已实现。登记一块**界面区**：落在其中的点击被界面吃掉，**不再传给可视化模块**
（扫雷棋盘 `game.minesweeper`、换装部件等）。

引擎的点击派发顺序是「虚拟摇杆 → 文本输入框 → 脚本 → 可视化模块」，脚本拿到点击后
**无法阻止**它继续往下传。小棋盘时代无所谓 —— 棋盘完全落在上下两条 HUD 带之间，
两者像素范围不相交。但 64×64 = 4096 格在任何手机上都不可能「整盘可见又可读」
（720 逻辑像素宽 ÷ 64 格 = 每格 11px，看不清也点不准），只能保持格子可读 + 平移浏览，
于是棋盘必然伸到 HUD 底下 —— 不登记界面区的话，**点「新游戏」会顺带把底下的格子翻开
（很可能直接踩雷）**。

⚠ 用**持久 keyed 矩形**而不是「每帧清空再登记」：清空与登记之间存在窗口，
UI 线程正好在那一刻派发点击就会漏防（表现为偶发误翻，最难查的那类 bug）。
正确写法是每帧用同一个 id 覆盖同一块区域，值恒定，不存在空窗。

**示例**
```js
// 每帧按当前布局登记两条 HUD 带（同 id 覆盖，无空窗）
function drawHud(L) {
  bwe.input.block("hudTop", 0, 0, L.W, L.topH);
  bwe.input.block("hudBottom", 0, L.H - L.botH, L.W, L.botH);
}
```

**另见**
[bwe.input.unblock](#bweinputunblockid--boolean) · [bwe.textinput.rect](text-input.md)（输入框自带命中优先）

### bwe.input.unblock(id) → boolean

**签名**
`bwe.input.unblock(id: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| id | string | 要撤销的界面区名 |

**返回**
`boolean` —— 该 id 之前是否存在（即是否真的撤销掉了什么）。

**说明**
✅ 已实现。撤销 `bwe.input.block` 登记的界面区。

---

## 二、bwe.camera — 相机

> 相机由脚本接管后，运行时的「模块驱动相机」（`show.camera` / `fx.cameraFollow` 模块）会**永久让位** —— 只要调过任意一个会设置 `scriptCameraControl` 的方法（`follow` / `setPos` / `setZoom` / `bounds` / `setFit`），本局后续都归脚本管，运行时不再每帧重置相机。

### bwe.camera.follow(e, opts?) → void

**签名**
`bwe.camera.follow(e: Entity | null, opts?: { smooth?: number; lookAhead?: number }): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| e | Entity \| null | 跟随目标；**传 `null` 取消跟随**（但脚本相机控制不会归还给模块） |
| opts.smooth | number | 平滑系数，默认 0.15。`0` = 硬跟（每帧瞬移到位）；越大越慵懒 |
| opts.lookAhead | number | 朝目标朝向多带一点像素，默认 0；让玩家早点看到前方 |

**返回**
`void`

**说明**
✅ 已实现。相机中心会追到目标位置（若开了 `lookAhead`，会偏移到 `faceX * lookAhead`）。平滑用的是 `k = min(1, smooth * dt * 60)` 的指数逼近 —— 与帧率无关。
跟随期间还会自动做「不越出地图」的钳制（除非你设了 `bounds`）。
目标被销毁后跟随自动失效（相机停在原位）。

**示例**
```js
function onStart(ctx) {
  bwe.camera.follow(ctx.self, { smooth: 0.12, lookAhead: 24 });
}
function onDestroy(ctx) {
  bwe.camera.follow(null);
}
```

**另见**
[bwe.camera.setPos](#bwecamerasetposx-y--void) · [bwe.camera.bounds](#bwecameraboundsrect--void)

---

### bwe.camera.pos → Vec2

**签名**
`bwe.camera.pos: { x: number; y: number }`（**只读**）

**参数**
无

**返回**
`Vec2` — 相机中心的世界坐标（新对象快照）

**说明**
✅ 已实现。`pos` 表示「视口中心对着哪个世界点」，不是左上角。

**示例**
```js
var c = bwe.camera.pos;
bwe.log("相机中心在 " + c.x + "," + c.y);
```

**另见**
[bwe.camera.setPos](#bwecamerasetposx-y--void) · [bwe.camera.worldToScreen](#bwecameraworldtoscreenx-y--vec2)

---

### bwe.camera.setPos(x, y) → void

**签名**
`bwe.camera.setPos(x: number, y: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 世界 X；省略时保持当前值 |
| y | number | 世界 Y；省略时保持当前值 |

**返回**
`void`

**说明**
✅ 已实现。直接摆相机中心，**不做边界钳制**（想钳制请配 `bwe.camera.bounds`）。调用后脚本接管相机。
⚠ 设了 `follow` 之后每帧会被跟随逻辑覆盖 —— `setPos` 要和 `follow` 二选一。

**示例**
```js
bwe.camera.setPos(ctx.self.x, ctx.self.y);
```

**另见**
[bwe.camera.pos](#bwecamerapos--vec2) · [bwe.camera.follow](#bwecamerafollowe-opts--void)

---

### bwe.camera.zoom → number

**签名**
`bwe.camera.zoom: number`（**可读写**）

**参数**
写入：`number` — 1 = 1:1 像素

**返回**
读取：`number`

**说明**
✅ 已实现。读取是直接读视口；**写入等价于 `setZoom(z)`**（会钳制到 `[0.15, 4]`，并让脚本接管相机）。
默认视图是「整张地图 contain 居中」，`zoom` 会是 `fitZoom()` 算出的值（可能远大于 1）。

**示例**
```js
bwe.log("当前缩放 " + bwe.camera.zoom);
bwe.camera.zoom = 2;
```

**另见**
[bwe.camera.setZoom](#bwecamerasetzoomz--void) · [bwe.camera.setFit](#bwecamerasetfitmode--void)

---

### bwe.camera.setZoom(z) → void

**签名**
`bwe.camera.setZoom(z: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| z | number | 缩放倍数，会钳制到 `[0.15, 4]`；非法值按 1 |

**返回**
`void`

**说明**
✅ 已实现。`0.15` 是编辑器手动缩放下限；上限放宽到 `4`（打包后要铺满全屏，4:3 地图进 1080p 要 2.2~2.7 倍）。

**示例**
```js
bwe.camera.setZoom(0.5);   // 拉远
```

**另见**
[bwe.camera.zoom](#bwecamerazoom--number) · [bwe.camera.setFit](#bwecamerasetfitmode--void)

---

### bwe.camera.shake(strength, duration) → void

**签名**
`bwe.camera.shake(strength?: number, duration?: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| strength | number | 抖幅（像素），默认 6 |
| duration | number | 持续时间（秒），默认 0.25 |

**返回**
`void`

**说明**
✅ 已实现。抖动是**视口级偏移**（`shakeX/shakeY`），线性衰减：时间过半幅度减半。重复调用会重置计时。

**示例**
```js
function onDamage(ctx, amount, from) {
  bwe.camera.shake(8, 0.2);
}
bwe.camera.shake();          // 用默认值：6 像素 / 0.25 秒
```

**另见**
[bwe.camera.follow](#bwecamerafollowe-opts--void)

---

### bwe.camera.bounds(rect) → void

**签名**
`bwe.camera.bounds(rect: Rect | null): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| rect | `{x, y, w, h} \| null` | 相机活动范围（世界坐标，左上 + 宽高）；**传 `null` 或非对象 = 取消限制** |
| rect 缺字段 | — | `x`/`y` 缺省 0，`w`/`h` 缺省**整张地图**尺寸 |

**返回**
`void`

**说明**
✅ 已实现。设置后相机中心被钳制在矩形内（若矩形比视口还小，则居中）。调用后脚本接管相机。
**只有跟随模式下生效**：钳制发生在跟随逻辑内部，所以 `bwe.camera.bounds(...)` 要配合 `follow` 才有约束效果。

**示例**
```js
function onSceneStart(ctx) {
  var s = ctx.scene;
  bwe.camera.bounds({ x: 0, y: 0, w: s.width, h: s.height });   // 不拍到地图外
  bwe.camera.follow(bwe.world.find("玩家"), { smooth: 0.15 });
}

// 取消
bwe.camera.bounds(null);
```

**另见**
[bwe.camera.follow](#bwecamerafollowe-opts--void) · [bwe.world.scene](world.md#bweworldscene--sceneinfo)

---

### bwe.camera.worldToScreen(x, y) → Vec2

**签名**
`bwe.camera.worldToScreen(x: number, y: number): { x: number; y: number }`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 世界 X |
| y | number | 世界 Y |

**返回**
`Vec2` — **逻辑屏幕坐标**（左上原点）

**说明**
✅ 已实现。公式：`screen = (world - cam) * zoom + view / 2`。**不含抖动偏移** —— 抖动只影响最终 GL 变换，不影响这里算出的屏幕坐标。

**示例**
```js
var p = bwe.camera.worldToScreen(ctx.self.x, ctx.self.y);
bwe.draw.text(p.x, p.y - 40, "头顶文字", { align: "center" });
```

**另见**
[bwe.camera.screenToWorld](#bwecamerascreentoworldx-y--vec2) · [bwe.draw.world](draw-audio-save.md#bwedrawworldfn--void)（直接画在世界空间，省掉换算）

---

### bwe.camera.screenToWorld(x, y) → Vec2

**签名**
`bwe.camera.screenToWorld(x: number, y: number): { x: number; y: number }`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 屏幕 X（逻辑像素） |
| y | number | 屏幕 Y（逻辑像素） |

**返回**
`Vec2` — 世界坐标

**说明**
✅ 已实现。`worldToScreen` 的逆运算。

**示例**
```js
var m = bwe.input.mouse;
var w = bwe.camera.screenToWorld(m.x, m.y);
bwe.log("鼠标在世界 " + w.x + "," + w.y);   // 与 m.worldX/worldY 一致
```

**另见**
[bwe.camera.worldToScreen](#bwecameraworldtoscreenx-y--vec2) · [bwe.input.mouse](#bweinputmouse--mousestate)

---

### bwe.camera.setFit(mode) → void

**签名**
`bwe.camera.setFit(mode: "contain" | "cover"): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| mode | string | `"contain"`（默认，整图看得见、四边可能留边）/ `"cover"`（铺满视口、超出裁掉） |

**返回**
`void`

**说明**
✅ 已实现。覆盖默认的画面适配方式。**只有当前没有跟随目标时**，调用会立刻重算 `zoom` 并把相机居中到地图中心；有跟随目标时只改适配模式。
非 `"cover"` 的任何值都按 `"contain"` 处理。

**示例**
```js
function onSceneStart(ctx) {
  bwe.camera.setFit("cover");     // 铺满，不留黑边
}
```

**另见**
[bwe.camera.zoom](#bwecamerazoom--number) · [bwe.camera.follow](#bwecamerafollowe-opts--void)

---

## 三、bwe.time — 时间

`bwe.time` 是一个**长期存在的对象**，三个字段都是活属性（每帧更新），不是快照。
下面按成员分节，方便索引与跳转。

### bwe.time.now → number

**签名**
`bwe.time.now: number`（只读）

**返回**
`number` — 已运行**秒数**

**说明**
✅ 已实现。受 `bwe.world.paused` 停止、受 `bwe.world.timeScale` 缩放 —— 它是**游戏时间**，不是墙钟时间。
暂停时不增长。

**示例**
```js
bwe.log("已运行 " + bwe.time.now.toFixed(2) + " 秒");
```

**另见**
[bwe.time.dt](#bwetime-dt--number) · [bwe.world.timeScale](world.md#bweworldtimescale--number)

### bwe.time.dt → number

**签名**
`bwe.time.dt: number`（只读）

**返回**
`number` — **本帧步长**（秒），等于 `ctx.dt`

**说明**
✅ 已实现。暂停时为 **0**。原始 `dt` 由宿主钳制到 `[0, 0.1]`，掉帧时不会一次跳很远。
**所有按时间推进的移动都要乘它**，这样掉帧与高刷屏都不会变速。

**示例**
```js
ctx.self.x += 200 * bwe.time.dt;   // 200 像素/秒
```

**另见**
[bwe.time.now](#bwetime-now--number) · [bwe.world.paused](world.md#bweworldpaused--boolean)

### bwe.time.frame → number

**签名**
`bwe.time.frame: number`（只读）

**返回**
`number` — 已运行**帧数**（从 1 开始）

**说明**
✅ 已实现。⚠ 与 `now` 的差别：暂停时 `frame` **仍然 +1**，`now` 不增长。
适合做「每 N 帧做一次」的节流（比按时间更省）。

**示例**
```js
if (bwe.time.frame % 10 === 0) { bwe.log("每 10 帧一次"); }
```

**另见**
[bwe.time.now](#bwetime-now--number)

### 时间计算细节（三者关系）

| 字段 | 类型 | 说明 |
|---|---|---|
| `now` | number | 已运行**秒数**（受 `paused` 停止、受 `timeScale` 缩放） |
| `dt` | number | **本帧步长**（秒），等于 `ctx.dt`；暂停时为 0 |
| `frame` | number | 已运行**帧数**（从 1 开始，暂停时**仍然增长**） |

1. 宿主给的原始 `dt` 先钳制到 `[0, 0.1]`（掉帧时不会一次跳很远）。
2. 暂停 → `frameDt = 0`，`now` 不增长，但 `frame` **照样 +1**。
3. 未暂停 → `frameDt = dt * timeScale`，`now += frameDt`。

**完整示例**
```js
// 做秒表（暂停时自动停表，这正是游戏时间的语义）
var elapsed = 0;
function onUpdate(ctx, dt) { elapsed += dt; }
```

**另见**
[bwe.world.paused](world.md#bweworldpaused--boolean) · [bwe.world.timeScale](world.md#bweworldtimescale--number) · [ctx](lifecycle.md#四ctx-结构)

---

## 四、常见组合

### 4.1 WASD 移动 + 相机跟随（最常见的开场）

```js
function onStart(ctx) {
  bwe.camera.follow(ctx.self, { smooth: 0.12, lookAhead: 20 });
}

function onUpdate(ctx, dt) {
  var a = bwe.input.axis();
  var speed = 160;
  if (a.x !== 0 || a.y !== 0) {
    ctx.self.x += a.x * speed * dt;
    ctx.self.y += a.y * speed * dt;
  }
}
```

### 4.2 暂停菜单

```js
function onKey(ctx, key) {
  if (key === "Escape") {
    bwe.world.paused = !bwe.world.paused;
  }
}

function onUpdate(ctx, dt) {
  if (bwe.world.paused) { return; }     // 注意：paused 时 onUpdate 根本不会被调用
}
```

### 4.3 鼠标点选 + 世界坐标

```js
function onUpdate(ctx, dt) {
  if (!bwe.input.pressed("Mouse0")) { return; }
  var m = bwe.input.mouse;
  var hit = bwe.world.find({ name: "靶子" });
  if (hit && bwe.dist(m.worldX, m.worldY, hit.x, hit.y) < 24) {
    bwe.log("点中靶子");
  }
}
```

### 4.4 屏幕坐标 HUD + 世界坐标血条

```js
function onUpdate(ctx, dt) {
  // 屏幕空间：固定右上角
  bwe.draw.text(8, 8, "HP " + Math.round(ctx.self.hp), { size: 18, color: "#ffffff" });

  // 世界空间：跟着实体
  bwe.draw.world(function () {
    bwe.draw.bar(ctx.self.x - 20, ctx.self.y - 28, 40, 5, ctx.self.hp / ctx.self.hpMax,
      { bg: "#000000", fg: "#40e060" });
  });
}
```

---

## 五、边界与陷阱

| 情况 | 行为 |
|---|---|
| `bwe.input.down("不存在的键")` | 恒 `false`，不崩溃 |
| 鼠标按下状态 | 真按住（宿主转发按下/抬起，失焦自动松开）；同一帧里先按后抬也不会丢 `pressed` |
| `bwe.input.mouse.wheel` | **恒 0**（没有接滚轮事件）—— 别拿它做缩放 |
| `bwe.input.cursor(false)` | 用 1×1 全透明自定义光标实现「隐藏」；平台不支持时静默保留系统光标 |
| `bwe.input.axis()` | 只认 **WASD + 方向键**，不能改绑 |
| `bwe.camera.setPos` + `follow` 同时用 | 每帧 follow 会覆盖 setPos 的效果 —— 二选一 |
| 调过任一相机控制方法后 | **运行时模块相机永久让位**（本局无法归还） |
| `bwe.camera.bounds` 不配 follow | 没有约束效果（钳制在跟随逻辑里） |
| `bwe.time.now` / `dt` | 暂停时为 0；`frame` 暂停时**仍增长** |
| `dt` 上限 | 0.1 秒，掉帧不会让游戏「瞬移」 |
