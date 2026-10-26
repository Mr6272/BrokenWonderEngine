# JS 脚本系统契约（BWE Scripting）

> 这份文件是「编辑器 / 导出器 / 运行时 / 校验脚本」四方共同遵守的唯一契约。
> 改名、改签名、改语义都先改这里，再同步四处（§8 有检查命令）。

## 0. 总览：JS 怎么跑起来

```
Web 编辑器（写现代 JS，带类型诊断）
   │  .bwproj 里 scripts[name] = { name, file, source, lang: "js" }
   │  服务端用 TypeScript 编译 API 做诊断（/api/js-check）
   ▼
打包（web/tools/package-bwe.mjs）
   │  TypeScript transpile → ES5（target: ES5, module: none）
   │  Build/scripts/<name>.js + boot.json.scripts[]={name,file,lang}
   ▼
Java 运行时（Studio.runtime.TopDownRuntime）
   │  内嵌 Rhino 1.7.15 执行 ES5；每帧调用 Context.processMicrotasks()
   │  暴露全局 `bwe` 对象（Java 侧 Scriptable 实现，无 JS 预置脚本）
   ▼
你的游戏逻辑
```

**为什么是「现代 JS → TypeScript 降级 ES5 → Rhino」**：
Rhino 1.7.15 的解析器只认 ES5.1 + 部分 ES6（class / 展开 / for-of / 默认参数 / 可选链 都不认），
但 TypeScript 编译器能把这些全部降级成 ES5，连 `async/await` 也能降（配 `Context.processMicrotasks()`
每帧排空微任务即可用）。TypeScript 已经是本项目依赖，**不需要新增 npm 包**；
运行时唯一新增依赖是 `lib/rhino-1.7.15.jar`（1.34 MB）。

## 0.1 运行环境要求（踩过坑，务必遵守）

JOGL 2.1 对 JVM 很挑，**用错组合的表现极具误导性：窗口能开、日志写着「窗口已打开」，但 GL 一帧都不跑 → 脚本永远不启动（看起来像"脚本引擎坏了"）**。

| 组合 | 结果 |
|------|------|
| JDK 17~25 + 三个 JVM flag | ✅ 正常（全屏、渲染、脚本都跑） |
| JDK 17~25，不带 flag | ❌ `ArrayIndexOutOfBoundsException: Index -1 ... chooseGraphicsConfigurationImpl`（WGL 枚举失败，无 GL） |
| JDK 26（任何 flag） | ❌ `NoClassDefFoundError: java/applet/Applet`（JDK 26 删了 java.applet，JOGL 2.1 还在引用） |

三个必须的 flag（打包时 `jpackage --java-options` 已带上，**quick-run/手写命令行也必须带**）：

```
--enable-native-access=ALL-UNNAMED
--add-opens=java.desktop/sun.awt=ALL-UNNAMED
--add-opens=java.desktop/sun.java2d=ALL-UNNAMED
```

- `web/tools/serve.mjs` 的「试跑」会自动挑 major ∈ [17,25] 的 JDK（本机是 `C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot`），
  并把上面三个 flag 带上；挑不到会返回明确错误而不是起一个空窗口。
- `web/tools/package-bwe.mjs` 在 jpackage 所在 JDK major > 25 时会写 warning。
- 手写命令行调试时：
  ```powershell
  & 'C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot\bin\java.exe' `
    --enable-native-access=ALL-UNNAMED --add-opens=java.desktop/sun.awt=ALL-UNNAMED `
    --add-opens=java.desktop/sun.java2d=ALL-UNNAMED `
    -cp "bin;src;lib/*" -Djava.library.path=lib Studio.runtime.TopDownRuntime Build\boot.json
  ```
- 判断「GL 到底跑没跑」：日志里有 `视口映射:` 行 = 出了第一帧；没有这一行就是 GL 没起来，别去查脚本。

**限制（写脚本的人必须知道）**：
- 不能 `import/require`（脚本共享一个全局作用域；用 `bwe.scripts.call()` 跨脚本调用）
- 不能用 `setTimeout` / `setInterval` → 用 `bwe.after()` / `bwe.every()`
- `async/await` 可用，但 `await` 的后续会在**下一帧**继续（不是同一帧内同步完成）
- 不能用 `require('fs')` 等宿主能力；文件读写走 `bwe.save.*`

## 1. 生命周期

### 1.1 对象脚本（最常用）

对象挂 `script.js` 模块（params: `script` = 脚本名）后，运行时按事件调用同名函数：

```js
function onStart(ctx) {}                 // 对象生成时一次
function onUpdate(ctx, dt) {}            // 每帧，dt = 秒
function onClick(ctx) {}                 // 鼠标左键点中
function onEnter(ctx, other) {}          // 触发区：别人进来
function onLeave(ctx, other) {}
function onInteract(ctx, actor) {}       // 交互（走近 + 按键）
function onDamage(ctx, amount, from) {}  // 受击
function onDeath(ctx, by) {}
function onDestroy(ctx) {}               // 销毁前
function onKey(ctx, key) {}              // 可选：任意按键
```

`ctx` 结构：`{ self: Entity, world, scene, time, camera, input, save, dt }`。
没有定义的函数直接跳过（不用写空壳）。

### 1.2 场景脚本

场景有 `scene.onStartScript`（编辑器场景设置里选脚本）。运行时在场景载入完、对象 spawn 完之后调用：

```js
function onSceneStart(ctx) {}    // ctx.scene, ctx.world
function onSceneEnd(ctx) {}
```

场景脚本适合放「系统级」逻辑（刷怪、计分、天气、全局状态），并可用 `bwe.world.on("update", fn)` 注册每帧回调。

### 1.3 全局

`bwe.on("update" | "draw" | "keydown" | "click", fn)` 注册全局钩子，`bwe.off(...)` 取消。

## 2. `bwe` 命名空间（Phase 1 必须实现）

> Phase 1 = 本轮交付；Phase 2 = 后续迭代，契约先占位。

### 2.1 `bwe.world`

| 调用 | 说明 |
|---|---|
| `bwe.world.mapSize()` | `{w, h}` 像素 |
| `bwe.world.tileSize()` | 每格像素 |
| `bwe.world.scene` | `{name, width, height}` |
| `bwe.world.find(q)` | q: 字符串（名字/标签）或 `{name, tag, kind, id}` → `Entity \| null` |
| `bwe.world.findAll(q)` | → `Entity[]` |
| `bwe.world.spawn(opts)` | `{ x, y, asset?, name?, kind?, tags?, z?, halfW?, halfH?, script?, modules? }` → `Entity` |
| `bwe.world.destroy(e)` | 销毁实体 |
| `bwe.world.entities()` | 所有实体（只读数组） |
| `bwe.world.paused` / `bwe.world.timeScale` | 暂停 / 时间缩放 |
| `bwe.world.on(name, fn)` / `off` / `emit(name, payload)` | 全局事件总线（Phase 1） |
| `bwe.world.layers()` | 图层信息（只读，Phase 2） |

### 2.2 `Entity`（世界对象）

属性：`id, name, kind, x, y, z, rotation, scaleX, scaleY, visible, alive, tags`（`tags.has(t)`、`tags.includes(t)`）
方法：

| 调用 | 说明 |
|---|---|
| `e.pos` / `e.setPos(x, y)` | 位置（世界像素，中心点，Y 向下） |
| `e.size` / `e.setSize(w, h)` | 与可视化 `halfW/halfH` 同一套（见 mapping-contract §2） |
| `e.sprite(opts)` | `{asset: 素材名, frame?, fps?, mode?: "loop"\|"once"\|"first"}` |
| `e.play(assetName)` | 直接换素材 |
| `e.setFrame(i)` | 冻结到第 i 帧 |
| `e.prop(key, def)` / `e.setProp(key, val)` | 与模块 `props` 打通 |
| `e.hasModule(id)` / `e.module(id)` / `e.modules()` | 模块实例：`{id, enabled, get(k), set(k, v)}` |
| `e.attach(opts)` → `handle` | 子精灵（武器/影子/特效）：`{asset, dx, dy, z, rotation}` |
| `e.detach(handle)` | |
| `e.distanceTo(other)` | 像素 |
| `e.angleTo(other)` | 度 |
| `e.destroy()` | 同 `world.destroy(e)` |
| `e.hp` / `e.hpMax` / `e.damage(n)` / `e.heal(n)` | 读写 `combat.health` 模块（有就同步，没有就用内部值） |
| `e.on(name, fn)` | 实体事件：`"click" \| "enter" \| "leave" \| "damage" \| "death"` |

> **JS ↔ 可视化**：`e.prop()` / `e.module()` 读写的就是编辑器里点到的那份数据；
> 反过来，编辑器里的模块（`move.*`、`game.*`、`render.*`）照旧由运行时驱动，
> 脚本只是「加一层行为」，两者共存不打架。

### 2.3 `bwe.input`

| 调用 | 说明 |
|---|---|
| `bwe.input.down("Space")` / `"KeyW"` / `"ArrowLeft"` / `"Mouse0"` | 当前按住 |
| `bwe.input.pressed(key)` / `released(key)` | 本帧按下 / 抬起（边沿） |
| `bwe.input.axis()` | `{x, y}`，已归一化，WASD + 方向键都算 |
| `bwe.input.mouse` | `{x, y, worldX, worldY, left, middle, right, wheel}`（x/y 为逻辑屏幕坐标，worldX/Y 已过视口反变换） |
| `bwe.input.cursor(visible)` | 显隐鼠标 |

键名兼容三种写法：`"Space"` / `" "` / `32`。

### 2.4 `bwe.camera`

| 调用 | 说明 |
|---|---|
| `bwe.camera.follow(e, opts)` | `{smooth=0.15, lookAhead=0}`；`follow(null)` 取消跟随 |
| `bwe.camera.pos` / `setPos(x, y)` | 相机中心（世界坐标） |
| `bwe.camera.zoom` / `setZoom(z)` | 1 = 1:1 像素 |
| `bwe.camera.shake(strength=6, duration=0.25)` | 屏幕抖动 |
| `bwe.camera.bounds(rect\|null)` | 限制相机范围 `{x,y,w,h}` |
| `bwe.camera.worldToScreen(x, y)` / `screenToWorld(x, y)` | |
| `bwe.camera.setFit("contain"\|"cover")` | 覆盖默认 fit（默认 contain） |

### 2.5 `bwe.time`

`bwe.time.now`（秒）、`bwe.time.dt`、`bwe.time.frame`、
`bwe.after(sec, fn)` → id、`bwe.every(sec, fn, opts?)` → id、`bwe.cancel(id)`、
`bwe.tween(target, props, dur, opts)` → `{done(fn), cancel()}`（Phase 2）

### 2.6 `bwe.draw`（立即模式：HUD / 调试 / 世界内特效）

默认画在**屏幕空间**（左上原点、逻辑像素）；`bwe.draw.world(fn)` 里画在世界空间。

| 调用 | 说明 |
|---|---|
| `bwe.draw.text(x, y, text, opts)` | `{size=16, color="#fff", align="left", alpha=1, shadow=true}` |
| `bwe.draw.rect(x, y, w, h, opts)` | `{fill, stroke, width, alpha, radius}` |
| `bwe.draw.line(x1, y1, x2, y2, opts)` | `{color, width, alpha}` |
| `bwe.draw.circle(x, y, r, opts)` | |
| `bwe.draw.sprite(assetName, x, y, opts)` | `{w, h, alpha, tint, rotation, frame}` |
| `bwe.draw.bar(x, y, w, h, pct, opts)` | `{bg, fg, border}` |
| `bwe.draw.measureText(text, size)` | `{w, h}` |
| `bwe.draw.world(fn)` | 该回调内所有绘制用世界坐标 |

> 绘制调用只在 `onUpdate` 期间有效（运行期会缓存到本帧的绘制列表里，帧末统一画）。

### 2.7 `bwe.audio`

`bwe.audio.play(name, {volume=1, loop=false, pitch=1})` → id、`bwe.audio.stop(id|name)`、
`bwe.audio.music(name, {volume, loop=true})`、`bwe.audio.volume(0..1)`（全局）。
素材名或 `Audio` 素材相对路径都行。Phase 1 支持 WAV；OGG/MP3 看 JDK 解码能力，读不了会进日志告警（不崩）。

### 2.8 `bwe.save`（本地存档，JSON）

`bwe.save.set(k, v)` / `get(k, def)` / `has(k)` / `remove(k)` / `clear()` / `flush()`
以及槽位：`bwe.save.write(slot="auto")` / `read(slot="auto")` / `exists(slot)` / `delete(slot)`。
落盘位置：`<exe 同目录>/saves/<slot>.json`，不可写时退回用户目录。**不能存函数**，只存 JSON 值。

### 2.9 俯视角专长（Phase 1 重点）

```js
// 网格
bwe.grid.cellSize                 // = tileSize
bwe.grid.toCell(x, y)             // {cx, cy}（floor）
bwe.grid.toWorld(cx, cy)          // 格子中心 {x, y}
bwe.grid.snap(x, y)               // 对齐到格子中心

// 瓦片地图（从场景里的 TILE 对象/道具自动建图，或纯脚本建）
bwe.tilemap.get(cx, cy)           // 0 = 空
bwe.tilemap.set(cx, cy, tileId)
bwe.tilemap.solid(cx, cy)         // 是否阻挡
bwe.tilemap.setSolid(tileId, bool)
bwe.tilemap.blocked(x, y, w, h)   // 矩形是否撞墙（AABB，像素）
bwe.tilemap.raycast(x1, y1, x2, y2) // → {hit, x, y, cx, cy}

// 寻路（A*，Phase 1）
bwe.nav.find(from, to, opts)      // opts: {diagonal=true, maxNodes=2000, smooth=true}
                                  // → [{x,y}, ...]（世界像素，首元素是起点附近）
bwe.nav.lineOfSight(a, b)         // → bool（Bresenham + solid 瓦片）
bwe.nav.follow(e, path, opts)     // 让实体沿路径移动：{speed=100, arrive=2, onArrive}
bwe.nav.stop(e)

// 交互（走近 + 按键提示）
bwe.interact.nearest(actor, opts) // {radius=48, tag, filter}
bwe.interact.prompt(text)         // 在最近交互物头顶画提示（null 清除）
bwe.interact.setKey("KeyE")       // 触发键
bwe.interact.onTrigger(fn)        // 玩家按触发键时 fn(target, actor)

// 生成器（刷怪/掉落）
bwe.spawner.create(opts)          // {asset|script, count=1, interval=2, max=10, area:{x,y,w,h}, onSpawn}
bwe.spawner.stop(sp)
```

### 2.10 辅助

`bwe.random(min, max)` / `bwe.randomInt(min, max)` / `bwe.chance(p)` / `bwe.pick(arr)` /
`bwe.clamp(v, a, b)` / `bwe.lerp(a, b, t)` / `bwe.dist(x1,y1,x2,y2)` /
`bwe.log(...)`（写进 `Build/bwe.log`，带脚本名）/ `bwe.error(...)` /
`bwe.call(scriptName, handlerName, ...args)` / `bwe.has(scriptName)`

## 3. 与可视化模块的双向打通

1. **脚本挂到对象**：对象 Inspector → 「脚本」区 → 选脚本（写进 `script.js` 模块）。
2. **脚本读模块**：`e.module("move.patrol").set("speed", 120)`、`e.module("combat.health").get("maxHealth")`。
3. **脚本改属性**：`e.setProp("w", "64")` 会影响下一帧的绘制尺寸（与编辑器同一条 `sizeOf` 规则）。
4. **模块触发脚本**：对象上的 `onClick/onEnter/onLeave/onDamage/onDeath` 由运行时统一派发给该对象脚本。
5. **跨对象**：`bwe.call(otherScript, "fnName", ...)` 或事件总线 `bwe.world.emit("bossDead")`。
6. **不覆盖可视化行为**：模块负责「默认行为」，脚本负责「额外逻辑」；同名的默认行为可以被脚本用 `e.module("...").enabled = false` 关掉。

## 4. 错误与调试

- 脚本语法/运行时异常：写 `Build/bwe.log`，格式 `[脚本错误] <script>:<line>: <message>`，**同一脚本同一行只报一次**，游戏继续跑。
- 无限循环保护：单脚本单帧执行超过 250ms 记一次告警（Phase 2 可加指令数限制）。
- `bwe.log()` 写到 `Build/bwe.log`，方便用户回传。
- 编辑器 `/api/js-check` 返回 `{diagnostics:[{line, col, severity, message}]}`（TypeScript 编译 `bwe.d.ts` + 用户脚本）。

## 5. 编辑器侧

- 面板：`剧本` 面板增加 **JS / Yarn** 语言切换；JS 模式有行号、Tab 缩进、Ctrl+S 保存、诊断列表（点跳行）、API 速查（可搜索）。
- 模块目录新增 `script.js`（分类 `game`，参数 `script`）。
- 场景设置里 `onStartScript` 可选任意脚本（Yarn 或 JS，按后缀/语言区分）。
- 顶部/打包面板加 **「试跑」**：调本地服务 `/api/quick-run`，2~3 秒起 Java 窗口（不走 jpackage）。

## 6. 导出格式

`boot.json` 新增：

```json
{
  "scripts": [
    { "name": "player", "file": "scripts/player.js", "lang": "js" },
    { "name": "对话1",  "source": "...",            "lang": "yarn" }
  ],
  "jsMain": "main"          // 可选：全局入口脚本名（有就跑 onSceneStart 前先执行）
}
```

- `lang` 缺省 = `yarn`（向后兼容旧工程）。
- JS 脚本文件统一放 `Build/scripts/<安全文件名>.js`，内容已是 **ES5**。
- 对象上的 `script.js` 模块导出为：`{"def":"script.js","params":{"script":"player"}}`。

## 2.11 涌现式模拟基底（Phase 2 · 当前重点：俯视角涌现式机制）

涌现式玩法 = **少量通用规则 + 可组合的模拟基底**，玩家能做出设计者没写死的组合（火烧草→引燃油桶→墙烧穿→守卫听见赶来→水桶灭火）。
所以引擎不再堆「功能模块」，而是提供四层基底：**材质 → 场（fire/water/smoke）→ 感知/AI → 物理**，行为由 JS 组合。

### 2.11.1 `bwe.material`（材质：涌现的第一性）

```js
bwe.material.define("grass", {          // 自定义/覆盖材质
  flammable: 0.8,      // 0..1 易燃度（点燃概率与蔓延速度）
  burnTime: 2.5,       // 秒，烧完需要多久
  conductive: false,   // 是否导电（电通道用）
  wet: false,          // 初始是否湿（湿了易燃度减半）
  hardness: 6,         // 破坏所需的伤害
  density: 1,          // 物理密度倍数
  tags: ["plant"]      // 语义标签，规则/脚本可查询
});
bwe.material.of(cx, cy)                 // 格子的材质名（字符串）
bwe.material.setTile(cx, cy, "grass")   // 改格子材质（null = 空）
bwe.material.ofEntity(e)                // 实体的材质名
bwe.material.setEntity(e, "wood")
bwe.material.get("grass")               // 读材质属性（对象副本）
bwe.material.tags("grass")              // ["plant"]
```
内置材质：`stone`（不燃）、`wood`（易燃、烧穿）、`grass`（易燃、快）、`oil`（极易燃）、`cloth`、`metal`（导电）、`water`、`ice`、`glass`、`poisonPlant`。
**TILE 对象的材质映射**：导出的 `material` 模块参数（或按素材名自动匹配内置名），默认 `stone`。

### 2.11.2 `bwe.field`（多通道格子场：火/水/烟/自定义）

固定步长模拟（默认 0.1s/tick，与帧率解耦；同种子 + 同输入 ⇒ 同结果）。

```js
bwe.field.emit("fire", cx, cy, 1.0)     // 点火（强度 0..1）
bwe.field.sample("fire", cx, cy)        // 读该通道强度（0..1）
bwe.field.clear("fire")                 // 清空通道
bwe.field.tickRate(0.1)                 // 模拟步长（秒）
bwe.field.channel("poison").max(1)      // 自定义通道
bwe.field.on("ignite", fn)              // fn({cx, cy, material, entity})
bwe.field.on("extinguish", fn)          // fn({cx, cy, cause})
bwe.field.on("burned", fn)              // fn({cx, cy, material}) 烧穿/烧尽
bwe.field.burning()                     // [{cx,cy,intensity,material}...]（调试/UI）
```

内置规则（全部走材质属性，不写死具体关卡）：
- **fire**：强度随时间衰减；相邻格若 `flammable>0` 则按 `flammable × intensity` 累积概率自燃；烧够 `burnTime` 后材质变 `null`（若该格是 TILE → 同时从 tilemap 的阻挡里移除，**烧穿墙就开出一条路**），相邻实体按材质受损。
- **water**：扑灭同格与相邻格 fire；把材质标记为 `wet`（易燃度 ×0.5，随时间恢复）。
- **smoke**：fire 产生；向上/顺风扩散并衰减；遮挡视线（`bwe.sense.canSee` 减半判定）、可被风吹散（`bwe.field.wind(dx, dy)`）。
- **oil/poison**：用同一套通道 + 材质驱动，不新增特例。
- 每 tick 只遍历活跃格（有强度或邻接活跃格），大地图也不会 O(全图)。

### 2.11.3 `bwe.noise`（声音：AI 的第二感知通道）

```js
bwe.noise.emit(x, y, { radius: 260, intensity: 1, tag: "combat" })
bwe.noise.events()                      // 本帧/最近的噪音事件（调试）
```
墙会衰减（隔墙半径 ×0.55，穿两道 ×0.3）；`bwe.ai` 挂载的实体会收到。

### 2.11.4 `bwe.sense` / `bwe.ai` / `bwe.faction`（感知 → 记忆 → 反应）

```js
bwe.sense.canSee(a, b)                  // 视野半径 + FOV + 瓦片遮挡 + 烟雾
bwe.sense.inSightRange(a, b)            // 只判距离
bwe.sense.audible(e)                    // 能否听到最近噪音
bwe.sense.lastKnown(e)                  // {x, y, age} 记忆中的目标位置

bwe.faction.set(e, "guard")
bwe.faction.relation("guard", "bandit", -1)   // -1 敌 / 0 中立 / 1 友
bwe.faction.hostile(a, b)                     // → bool
bwe.faction.members("guard")                  // → Entity[]

bwe.ai.attach(e, { sight: 260, fov: 120, hearing: 300, memory: 6, speed: 90 })
bwe.ai.detach(e)
bwe.ai.state(e)                          // "idle" | "patrol" | "investigate" | "chase" | "attack" | "flee" | 自定义
bwe.ai.setState(e, "investigate")
bwe.ai.target(e)                         // 当前锁定的敌人或 null
bwe.ai.alert(e, position)                // 同阵营警报传播（带一跳延迟）
bwe.ai.onAlert(fn)                       // 全局：fn({entity, position, from})
bwe.ai.onSpot(fn)                        // 发现敌人：fn({entity, target})
```
引擎只做**感知/记忆/状态存储/警报传播**；「看到之后干什么」由 JS 决定（这样组合是玩家/设计者写的，不是引擎写死的）。

### 2.11.5 `bwe.physics`（jbox2d 桥接：可推、可抛、可压）

```js
bwe.physics.enable()                                    // 打开物理子步（默认关，开了才有开销）
bwe.physics.gravity(0)                                  // 俯视角默认无重力
bwe.physics.body(e, { type: "dynamic"|"kinematic"|"static",
                      shape: "circle"|"box", radius, halfW, halfH,
                      density: 1, friction: 0.4, restitution: 0.1, sensor: false })
bwe.physics.remove(e)
bwe.physics.applyImpulse(e, ix, iy)
bwe.physics.velocity(e) -> {vx, vy}
bwe.physics.setVelocity(e, vx, vy)
bwe.physics.throwAt(e, tx, ty, speed)                   // 朝目标抛（力度按距离）
bwe.physics.raycast(x1, y1, x2, y2) -> {hit, x, y, entity}
bwe.physics.queryPoint(x, y) -> Entity[]
bwe.physics.queryAABB(x, y, w, h) -> Entity[]
bwe.physics.on("collision", fn)                          // fn({a, b, impulse, sensor})
bwe.physics.debug(true)                                  // 画碰撞体
```
碰撞体与 tilemap 的实体格自动建静态墙；dynamic 实体的模拟位置每帧写回 `Entity.x/y`（脚本读到的就是真位置）。

### 2.11.6 `bwe.target`（涌现式交互的拾取器）

```js
bwe.target.cell()        // 鼠标所在格子 {cx, cy, material}
bwe.target.entity()      // 鼠标下的实体（最近的可见实体）或 null
bwe.target.inFront(e, range) // 角色面前 1 格/range 像素内的格子或实体
```
配合 `bwe.input.pressed("Mouse0")` + 现有 `interact`，玩家「用火把点火」「用水桶灭火」这类动词就是普通 JS。

### 2.11.7 涌现式验收场景（必须有自动化断言）

一个 **荒原哨站** 沙盘必须能跑出下面这些「组合结果」，全部由材质+场+感知+物理自然发生（脚本里不写死位置）：

1. 点燃一片草地 → 3 秒内烧掉 ≥ 15 格；火烧到石墙停止（墙外格未燃烧）。
2. 火蔓延到隔壁木箱 → 木箱被烧毁（实体消失 + 该格不再阻挡）。
3. 相邻水桶/水格 → 该格火被扑灭，且周围材质变 wet（易燃度下降）。
4. 玩家制造噪音（`bwe.noise.emit`）→ 守卫生成 `investigate` 状态并走向声源；隔墙看不见玩家（`canSee=false`）但仍会来查。
5. 对木箱 `applyImpulse` → 位移 ≥ 20px，且触发 `collision` 回调。
6. **确定性**：同种子 + 同输入跑两遍，烧毁格数、AI 状态序列完全一致（回归用）。

### 2.11.8 实践坑（写涌现脚本时最容易踩的 5 条）

1. **`material.setTile` 的优先级最高**：它会把格子标成「脚本固定」，之后 TILE 对象的材质（`props.material` / 素材名）**不会覆盖它**。
   想用 TILE 表现石墙，就别先给整片区域 `setTile("stone")` 再指望石墙对象生效——要么只 setTile 空地，要么最后把石墙格再显式刷一遍 `stone`。
   （验收场景第一版就是这样把「草」刷到了石墙上，火直接烧穿花圃。）
2. **`bwe.input.mouse.worldX/worldY` 来自宿主鼠标屏幕坐标的反变换**，不是 `pointerDown(...)` 传进来的那份世界坐标。
   headless 驱动器/自检里必须手动同步 `rt.mouseX/mouseY`，否则会读到 `-213,0` 这类离谱值；真窗口由 AWT 事件写入，正常不受影响。
3. **`ai.onAlert` 的 payload 里 `entity` 是「收到警报的那个实体」**，`from` 才是发警报的一方。写反了会导致警报链只生效一半。
4. **全局钩子是「注册一次」语义，不是脚本级单例**：同一段脚本挂到 2 个对象上，`onStart` 里各注册一次 `bwe.ai.onAlert` → 同一条警报回调执行 2 次。
   在脚本里用 `if (!G.hook) { G.hook = bwe.ai.onAlert(...) }` 只注册一次。
5. **引擎不给材质/火焰上色**：想让玩家「看见」草地/油/水/火，要么把地形画进底图素材，要么脚本里每帧用 `bwe.draw.rect` 叠一层
   （`bwe.field.burning()` 返回燃烧格，直接按格子画即可）。

## 7. Phase 划分

**Phase 1（已完成）**：§2.1–2.5、2.6、2.7（WAV）、2.8、2.9（grid/tilemap/nav/interact/spawner）、§3、§4、§5、§6。

**Phase 2 · 本轮（涌现式机制）**：§2.11 全部（材质 / 场 / 噪音 / 感知·AI·阵营 / 物理 / 拾取器）+ §2.11.7 验收场景。

**Phase 2 · 后续**：tween/缓动、UI 控件（按钮/滑条/列表）、粒子、动画状态机、prefab、多场景切换、小地图/迷雾、背包/任务辅助、`bwe.world.layers()`。

## 8. 检查命令

```powershell
# 脚本引擎自检（无窗口，纯 API 断言）
javac --release 8 -encoding UTF-8 -cp "lib/*" -d .tmp\classes (Get-ChildItem src\Studio\runtime\*.java)
java -cp ".tmp\classes;lib/*" Studio.runtime.ScriptSelfTest

# 端到端：示例工程 → 打包 → 跑 exe（日志里应有 [脚本] 行）
node web/tools/package-bwe.mjs web/examples/俯视角JS示例.bwproj --out .tmp\jsdemo
```
