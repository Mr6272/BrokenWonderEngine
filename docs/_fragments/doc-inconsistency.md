# 文档一致性清单（doc-inconsistency）

> 本文件记录 **`bwe.d.ts` / `apiDocs.ts` / `docs/scripting-api.md` 与 Java 实现（唯一权威）不一致**的地方。
> 生成方式：逐条比对 `ScriptApi.java` / `ScriptEngine.java` / `ScriptWorld.java` / `ScriptPrefab.java` / `ScriptRender.java` / `ScriptFields.java` / `ScriptAi.java` / `ScriptPhysics.java` 的实际成员与签名。
> 基准时间：本清单对应 347 项断言全绿的那一版代码（`ScriptSelfTest` 109 + Fields 43 + Physics 47 + Ai 51 + Prefab 97）。

**图例**：`A` = 实现已改、文档未跟（**文档需要改**）；`B` = 文档承诺、实现没有（**要么补实现，要么改文档**）；`C` = 表述细节不一致（不影响可运行性，但会误导）；`D` = 遗留/别名，建议保留但标注。

---

## 一、A 类：实现已改、文档未跟（Lead 已修，请同步 d.ts / apiDocs.ts / scripting-api.md）

### A1 `bwe.world.layers()` —— 已从「恒空数组」变成真实现

| 项 | 内容 |
|---|---|
| 旧文档（`docs/scripting-api.md` §2.1、`apiDocs.ts` L103） | 「图层信息（只读，Phase 2）」「当前返回空数组」+ `phase2: true` |
| 实际实现 | `ScriptApi.java:799` 读 `host.scene.layers`（`GameData.RtLayer`），返回 `[{id, name, visible, locked, order}]`；`GameData.java:238` 从 `scene_*.json` 顶层 `layers[]` 解析 |
| 实测 | 端到端 `count=3`：`layer-terrain/地形`、`layer-prop/物件`、`layer-actor/角色` |
| 差异要点 | **旧 Build 的 scene_*.json 没有 `layers` 字段 → 返回空数组**（向后兼容，不报错） |
| 需改 | `apiDocs.ts` L103 去掉 `phase2` 标记、更新 desc；`scripting-api.md` §2.1 把该行从 Phase 2 挪到 Phase 1；`bwe.d.ts:516` 的类型本身已正确 |

### A2 `bwe.input.cursor(visible)` —— 已从空实现变成真实现

| 项 | 内容 |
|---|---|
| 旧文档（`scripting-api.md` §2.3、`apiDocs.ts` L163） | 文档层写「显隐鼠标」（本来是对的），但实现曾是 `return null` 空方法 |
| 实际实现 | `ScriptApi.java:953` → `host.setCursorVisible(v)` → `TopDownRuntime.java:1236` 真改 AWT 光标 |
| 实现细节 | 「隐藏」走 **1×1 全透明自定义光标**（AWT 不允许 `setCursor(null)`）；平台不支持时静默保留系统光标，不崩 |
| 需改 | 无强制项（文档语义一直是对的）。建议在 `apiDocs.ts` desc 里补一句「用透明自定义光标实现」 |

### A3 `bwe.audio.play` 的 `pitch` —— 已从「完全不读」变成真实现

| 项 | 内容 |
|---|---|
| 旧状态 | `bwe.d.ts:686` 声明了 `pitch?: number`，`apiDocs.ts` L197 签名里也写了 `pitch = 1`，但 `ScriptAudio.play` 曾只有 `(name, vol, loop)` —— **参数被静默丢弃** |
| 实际实现 | `ScriptApi.java:1261` 读 `pitch`（`<=0` 归一为 1）→ `ScriptAudio.play(name, vol, loop, pitch)` → `detune(in, pitch)` |
| 实现语义 | **改采样率**（保留原始 PCM 字节、只把标称采样率乘 pitch）：`pitch=2` ⇒ 音高升八度**且时长减半**；`pitch=0.5` ⇒ 降八度**且时长翻倍**。这是「变速变调」语义，**不是**「变速不变调」 |
| 限制 | **仅 PCM WAV 有效**；非 PCM 编码忽略。`pitch ≈ 1` 走原始 Clip 快路径 |
| 踩坑（务必写进契约，防止有人「优化」回错误实现） | 第一版用 `AudioSystem.getAudioInputStream(dstFormat, in)` 去重采样：流速确实变了（22050→33075），但 `Clip` 时长**仍是 1000.1ms**，音高**根本没变** —— 因为 AudioSystem 是「按时间轴插值重采样」，频率成分原样保留。**正确做法必须重打包 `AudioInputStream` 的 `format`，让播放器按新速率解释同一串样本** |
| 实测 | `pitch=1.0 → 1000ms`、`pitch=1.5 → 666.7ms`、`pitch=0.5 → 2000ms` |
| 需改 | `scripting-api.md` §2.7 补 `pitch` 的说明与限制；`apiDocs.ts` L197 desc 补「改采样率，时长随之反比变化」 |

### A4 `onSceneEnd(ctx)` —— 已从「从未派发」变成真实现

| 项 | 内容 |
|---|---|
| 旧状态 | `scripting-api.md` §1.2 **一直承诺**有这个回调，但全 `src/` 里**没有任何派发点**（`apiDocs.ts` L76 也照写，`phase2` 都没标） |
| 实际实现 | `ScriptEngine.sceneEnd()`（`ScriptEngine.java:536`）+ `TopDownRuntime.installSceneEndHook()`（`TopDownRuntime.java:1198`）|
| 语义 | **只派发给场景脚本**（`onStartScript` 与 `jsMain`），**不派发给对象脚本**；**只派发一次**（`sceneEnded` 幂等保护）；触发时机是**运行时关闭**（窗口关闭 / 进程退出 / Ctrl+C，挂 JVM shutdown hook + `dispose()`） |
| 易误会点 | **不是**「场景切换时」（当前运行时只加载第一个场景，没有场景切换）；**不是** Unity 的 `OnDestroy`（每对象）；**不是** `OnApplicationQuit` 的等价物（虽然行为接近）—— 它是**场景级**结束回调 |
| 前提 | 仅当脚本引擎成功启动过（`started && !failed`）才派发；此时窗口已在关，**不要**在里面调 `bwe.draw.*` |
| 需改 | `scripting-api.md` §1.2 补触发时机与「只派发场景脚本 / 只一次」；`apiDocs.ts` L76 desc 从「离开 / 销毁场景时」改成「运行时关闭时（窗口关闭 / 退出），只派发给场景脚本」 |

### A5 实体染色 `e.setColor` / `setAlpha` / `clearColor` / `e.color` —— 新增，实现与文档一致

| 项 | 内容 |
|---|---|
| 实际实现 | `ScriptApi.java:1820/1848/1860/1864`；渲染侧 `TopDownRuntime.setActorTint` + `Actor.tint/tintVersion` |
| 语义 | 0~1；**任一通道 > 1 时整组按 0~255 解释**；与 blink 模块 alpha **相乘**；`clearColor()` 回到「未染色零开销」快路径 |
| 状态 | `bwe.d.ts` / `apiDocs.ts` **已同步**（L125-128 / L292-302），无需再改 |

---

## 二、B 类：文档承诺、实现没有（要么补实现，要么改文档）

### B1 `bwe.tween(...)` —— 确认是**纯占位**

| 项 | 内容 |
|---|---|
| 文档（`scripting-api.md` §2.5 / `bwe.d.ts` L665 / `apiDocs.ts` L184） | `bwe.tween(target, props, dur, opts) → {done(fn), cancel()}` |
| 实际实现 | `ScriptApi.java:377` 只在首次调用写一条日志 `bwe.tween 属 Phase 2，本版本不生效（返回空句柄）`，返回**空句柄**（`done` 返回自身、`cancel` 返回 null）。**不插值、不读任何参数** |
| 状态 | ✅ 文档标 `📋 规划` 是对的。`apiDocs.ts` 已标 `phase2: true`；`scripting-api.md` §7 也把它列在「Phase 2 后续」 |
| 建议 | 保留占位不改。如果将来实现，注意 d.ts 里 `TweenHandle.done(fn)` 返回 `TweenHandle`（可链式），实现里 `done` 确实返回 handle —— 这一点是一致的 |

### B2 `bwe.field.on` / `bwe.ai.onAlert` / `bwe.ai.onSpot` —— **不返回取消订阅函数**

| 项 | 内容 |
|---|---|
| 文档 | `bwe.d.ts:1040` `on(...): () => void`；`bwe.d.ts` 里 `onAlert` / `onSpot` 声明返回 `() => void`；`apiDocs.ts` L287 / L309 / L310 签名写 `→ 取消函数` |
| 实际实现 | 三处都 `return null`（`ScriptFields.java:1610`、`ScriptAi.java:678`、`ScriptAi.java:685`）。**没有取消订阅机制** |
| 影响 | 用户按 d.ts 写 `var off = bwe.field.on("ignite", fn); off();` → **运行期 `TypeError: off is not a function`** |
| 需改 | **优先**：三处都实现返回一个真正可用的 off 函数（`bwe.physics.on` 已经是这个模式，`ScriptPhysics.java:874` 返回 `api.newFn("offCollision", ...)`，可作为模板）。**退路**：d.ts 与 apiDocs 改成返回 `void` 并注明「注册后无法取消」 |
| 备注 | `bwe.physics.on("collision", fn)` 是**唯一**实现了取消订阅的（返回 `Function`），文档也是这么写的，一致 |

### B3 `bwe.input.mouse.wheel` —— 恒为 0

| 项 | 内容 |
|---|---|
| 文档 | `bwe.d.ts:534` 声明 `wheel: number`，`scripting-api.md` §2.3 也列出 `wheel`（描述「本帧滚轮增量，向上为正」） |
| 实际实现 | `ScriptApi.java:949` 硬编码 `o.values.put("wheel", Double.valueOf(0))`；全 `src/` 无任何 `MouseWheel` 监听（`TopDownRuntime` 只装了 `MouseListener` / `MouseMotionAdapter`） |
| 影响 | 用户拿 `wheel` 做缩放/切武器 → 永远没反应 |
| 需改 | **优先**：补 `MouseWheelListener` 写入 `host.wheelDelta`（reset 逻辑照 `mouseNow`/`mousePressed` 的模式）。**退路**：文档里明确标 `📋 规划（恒 0）`，并从 `apiDocs.ts` 的推荐用法里去掉 |

### B4 `fit.hp` 模块的 `defense` / `invincible` / `showBar` 参数 —— 运行时不读

| 项 | 内容 |
|---|---|
| 模块定义（`BuiltinModules.java`） | `fight.hp` 有 4 个参数：`hp` / `defense` / `showBar` / `invincible` |
| 运行时读取 | `TopDownRuntime.java:769` 只读 `maxHealth`（回退 `hp`）设 `hpMax`。**`defense` / `showBar` / `invincible` 完全没读** |
| 影响 | 用户调「防御 5」→ 伤害不减；关掉 `showBar` → 血条照画；勾 `invincible` → 照样掉血 |
| 需改 | 属于**模块语义缺口**，已在 `docs/api/modules.md` 标注 ⚠ 部分。修实现不在本轮文档 scope，建议 Lead 决定是否补 |

### B5 模块参数名不一致导致的「改了没反应」（6 组）

这是最容易让用户困惑的一类：**模块定义里的参数名 ≠ 运行时读的参数名**。

| 模块 | 模块定义参数名 | 运行时读的名字 | 位置 | 结果 |
|---|---|---|---|---|
| `move.follow` | `stopDist` | `stopDistance` | `TopDownRuntime.java:1532` | 改了没用，恒 48px |
| `move.patrol` | `range` | `distance` | `TopDownRuntime.java:1519` | 改了没用，恒 96px |
| `move.wander` | `area` | `radius` | `TopDownRuntime.java:1558` | 改了没用，恒 80px |
| `move.flee` | `fearRange` | `range` | `TopDownRuntime.java:1545` | 改了没用，恒 240px |
| `show.camera` | `clamp` | `clampToMap` | `TopDownRuntime.java:844` | 改了没用，恒 true |
| `fight.hp` | `hp` | `maxHealth` → 回退 `hp` | `TopDownRuntime.java:769` | ✅ 有回退，生效 |

**需改**：运行时改成读模块定义的参数名（或 `RtModule.num` 里加别名回退）。文档侧已在 `docs/api/modules.md` §六 汇总。

### B6 `look.blink` / `look.shadow` 模块的参数全部不生效

| 项 | 内容 |
|---|---|
| 模块定义 | `look.blink`: `period` / `minAlpha` / `scalePulse`；`look.shadow`: `w` / `h` / `alpha` |
| 运行时 | `TopDownRuntime.java:1335/1339` **只看模块 id 在不在**，参数一律不读：闪烁固定 `0.3 + 0.7*abs(sin(t*6))`；阴影固定 `宽×0.42 / 高×0.12 / alpha 0.22` |
| 需改 | 同上，属于模块语义缺口。文档已标 ⚠ 部分 |

### B7 `ai.attach` 的 `speed` 参数 —— 引擎只存不驱动

| 项 | 内容 |
|---|---|
| 文档 | `bwe.d.ts` / `scripting-api.md` 都写了 `speed: 90`（「移动速度」） |
| 实际 | `ScriptAi.java:641` 存进 `ag.speed`，但**整个 AI 子步没有任何地方用它移动实体**（没有内置移动行为） |
| 影响 | 用户以为 attach 之后 AI 会自己走 → 不会 |
| 需改 | 文档已注明「只是配置值，要动请用 `bwe.nav.follow`」。d.ts 可在注释里补一句（当前只写「速度」） |

### B8 `docs/scripting-api.md` §2.11.6 `bwe.target.cell()` 返回值形状

| 项 | 内容 |
|---|---|
| 文档 | 返回 `{cx, cy, material}` |
| 实际 | `ScriptAi.java` 的 `cellObj()` 返回 `{cx, cy, x, y, material}` —— **多了 `x, y`（世界坐标）** |
| 影响 | 无破坏性（多字段），但文档少写了有用的字段 |
| 需改 | `scripting-api.md` §2.11.6 补 `x/y`；`bwe.d.ts` 的 `TargetCell` **已正确**（含 x/y） |

### B9 `docs/scripting-api.md` §2.11.4 `bwe.sense.lastKnown()` 的 `from` 取值

| 项 | 内容 |
|---|---|
| 文档 | `{x, y, age}`，没写 `from` 字段与取值 |
| 实际 | 返回 `{x, y, age, from}`，`from` ∈ `"sight"` / `"noise"` / `"alert"`（未命中过时是 `""`） |
| 需改 | `scripting-api.md` 补 `from`；`bwe.d.ts` 的 `LastKnown` **已正确** |

### B10 `docs/scripting-api.md` §2.11.2 `bwe.field.on` 的事件 `cause` 枚举

| 项 | 内容 |
|---|---|
| 文档 | `bwe.field.on("extinguish", fn)` 只写 `fn({cx, cy, cause})`，没列 `cause` 取值 |
| 实际 | `cause` ∈ `"water"` / `"decay"` / `"burned"` / `"clear"`（四值，`ScriptFields.java:1092-1099`） |
| 需改 | `scripting-api.md` 列出四个取值 |

---

## 三、C 类：表述细节不一致（不影响运行，但会误导）

### C1 `AttachHandle` 类型

| 项 | 内容 |
|---|---|
| 旧 `bwe.d.ts` | `type AttachHandle = number`（**旧版**，已过时） |
| 当前 `bwe.d.ts` | ✅ **已修正**为 `interface AttachHandle { readonly id: number; remove(): void }`（L64-71） |
| 实际实现 | `ScriptApi.java:1890` 返回 `{id, remove()}` 对象；`detach` **同时接受对象和裸 id 数字**（`ScriptApi.java:1916` 先取 `.id`，取不到就当数字） |
| 状态 | 一致。我方文档 `entity.md` 已按实现写「是对象不是 number」，并注明 d.ts 旧版残留已修 |

### C2 `e.hp` / `e.heal` / `e.damage` 的返回类型

| 项 | 内容 |
|---|---|
| `bwe.d.ts` | `damage(n): void`、`heal(n): void`（L397/L399） |
| 实际实现 | 两者都**返回数字**（扣/回之后的 `hp`）：`ScriptApi.java:1942` `return Double.valueOf(a.hp)`、`1956` 同 |
| 影响 | 无破坏性（丢弃返回值不会错），但用户 `var left = e.damage(10)` 在 TS 下会被判为 `void` 从而报错 |
| 需改 | `bwe.d.ts` 改成 `damage(n, from?): number` / `heal(n): number`。⚠ 另外 `damage` **还有第二个可选参数 `from`**（伤害来源）d.ts 完全没声明 |

### C3 `bwe.save.flush()` / `delete(slot)` 的返回类型

| 项 | 内容 |
|---|---|
| `bwe.d.ts` | `flush(): void`（L718）、`delete(slot?): void`（L724） |
| 实际实现 | 两者都返回 `boolean`（`ScriptApi.java:1213` / `1221`） |
| 影响 | 用户 `if (!bwe.save.flush())` 在 TS 下会被判为「对 void 做条件判断」 |
| 需改 | `bwe.d.ts` 改成 `flush(): boolean`、`delete(slot?): boolean` |

### C4 `bwe.audio.music()` 的返回类型

| 项 | 内容 |
|---|---|
| `bwe.d.ts` | `music(name, opts?): void`（L701） |
| 实际实现 | 返回 `number`（id，失败 `-1`）：`ScriptApi.java:1254` `return Double.valueOf(audio.music(...))` |
| 影响 | 用户无法拿到 BGM 的 id 去 `stop`（而 `stop(id)` 是支持的）—— 这是个**实际能力缺失** |
| 需改 | `bwe.d.ts` 改成 `music(name, opts?): number` |

### C5 `bwe.spawner.stop()` 的返回/接受类型

| 项 | 内容 |
|---|---|
| `bwe.d.ts` | `stop(sp: SpawnerHandle): void`（L828），`SpawnerHandle = number` |
| 实际实现 | 返回 `null`；`scripting-api.md` 写 `bwe.spawner.stop(sp)`。实现接受 `number` **或** 带 `id` 字段的对象（`ScriptWorld.java:494`）。**传 `-1` 会停掉全部刷怪器** |
| 需改 | d.ts 补「`number \| {id}`」联合类型；文档里明确「传 -1 停全部」（我方已写） |

### C6 `bwe.every()` 的第三个参数

| 项 | 内容 |
|---|---|
| `bwe.d.ts` | `every(sec, fn: () => void, opts?: EveryOpts)`（L925）—— `fn` 声明为**无参数** |
| 实际实现 | 回调**不带参数**（`ScriptEngine.fireTimers` 调 `invoke(..., new Object[0])`） |
| 状态 | 一致 ✅（备注：`bwe.on("update", fn)` 的 fn **带** `dt`，这两个别混） |

### C7 `SceneInfo` 缺 `widthTiles` / `heightTiles` / `tileSize`

| 项 | 内容 |
|---|---|
| `bwe.d.ts` L462-466 | `SceneInfo { name, width, height }` —— 只有 3 个字段 |
| 实际实现 | `bwe.world.scene` 还提供 **`widthTiles`**、**`heightTiles`**、**`tileSize`**（`ScriptApi.java:614-617`） |
| 影响 | 用户按 d.ts 写 `ctx.scene.widthTiles` → TS 报「Property does not exist」，而运行时明明有 |
| 需改 | `bwe.d.ts` 的 `SceneInfo` 补三个字段；`apiDocs.ts` L83 签名也补 |

### C8 `ctx.self` 在场景脚本里是 `null`，但 d.ts 声明是 `Entity`

| 项 | 内容 |
|---|---|
| `bwe.d.ts` L578+ | `interface Ctx { self: Entity; ... }` |
| 实际实现 | `ScriptApi.context(self)`：传 `null` 时 `c.values.put("self", null)` —— 场景脚本（`onSceneStart` / `onSceneEnd`）拿到的 `ctx.self` **就是 `null`** |
| 影响 | 用户照 d.ts 写 `ctx.self.name` → 场景脚本里运行期 `TypeError: Cannot read property 'name' of null` |
| 需改 | `bwe.d.ts` 改成 `self: Entity \| null` 并在注释里注明「对象脚本里非 null，场景脚本里是 null」 |

### C9 `ctx` 缺 `game` 字段

| 项 | 内容 |
|---|---|
| `bwe.d.ts` `Ctx` | 没有 `game` |
| 实际实现 | `ScriptApi.java:2187` `c.values.put("game", bwe)` —— `ctx.game` 就是 `bwe` 根对象 |
| 需改 | d.ts 补 `game: typeof bwe` |

### C10 `e.on` 的事件名缺 `"interact"` / `"destroy"`，且「重复注册会覆盖」说法错误

| 项 | 内容 |
|---|---|
| `bwe.d.ts` L278 | `type EntityEvent = "click" \| "enter" \| "leave" \| "damage" \| "death"` —— **缺 `"interact"` 和 `"destroy"`** |
| `bwe.d.ts` L401 注释 | 「同名事件重复注册**会覆盖**」 |
| 实际实现 | `ScriptApi.java:1960` 的 `e.on` 是 **`list.add(f)`（追加）**，同一事件可以注册多个回调，按顺序全部执行 |
| 影响 | ① 用户 `e.on("interact", ...)` TS 报错但运行期有效；② 用户以为注册第二个会覆盖第一个 → 实际两个都会跑（可能重复执行） |
| 需改 | d.ts 的 `EntityEvent` 补两个值；注释改成「追加，不是覆盖」 |

### C11 `bwe.world.spawn` 的 `kind` 默认值文档不一致

| 项 | 内容 |
|---|---|
| `bwe.d.ts` L430（`SpawnOpts.kind` 注释） | 「对象大类，默认 **ACTOR**」——**确认仍在，且与实现相反**（`PrefabSpec.kind` 的 L118 写 PROP 是对的） |
| 实际实现 | `ScriptApi.spawnActor`：`String kind = ScriptJs.str(ScriptJs.get(o, "kind"), "PROP")` —— **默认 `"PROP"`** |
| `scripting-api.md` §2.1 | 没写默认值 |
| 影响 | 用户不填 `kind` 期待拿到 ACTOR（会被识别为玩家候选）→ 实际是 PROP |
| 需改 | d.ts 改成「默认 PROP」 |

### C12 `e.kind` 的 kind 列表

| 项 | 内容 |
|---|---|
| `bwe.d.ts` L259 | 「ACTOR / PROP / TILE / ZONE / SPAWN / PORTAL / LIGHT」 |
| 实际 | 代码里真正**有特殊分支**的只有 `TILE`（写瓦片表）、`ZONE`（进出派发）、`LIGHT`（光照绘制）、`ACTOR`（玩家识别）；`SPAWN` / `PORTAL` **运行时不读** |
| 需改 | d.ts 注释里标注哪些 kind 有实际效果（不是错，但不精确） |

---

## 四、D 类：遗留 / 别名（建议保留，但要在文档里点明）

### D1 模块 id 的双套别名（6 组）

`ScriptApi.MODULE_ALIASES`（`ScriptApi.java:1532`）里 `e.module()` / `e.hasModule()` 双向识别：

| Web id | 桌面旧 id |
|---|---|
| `combat.health` | `fight.hp` |
| `fx.cameraFollow` | `show.camera` |
| `render.shadow` | `look.shadow` |
| `render.blink` | `look.blink` |
| `render.sortByY` | `look.sortByY` |
| `render.playOnce` | `look.playOnce` |

**但运行时**（`TopDownRuntime`）在少数地方也硬编码了旧 id（例如 `render.blink` / `render.shadow` 也认）。文档已注明。

### D2 模块目录里没有、运行时却认的 id

`move.player` / `move.speed`（玩家速度）、`game.minesweeper`、`game.dressup`、`game.dressPart`、`script.js` / `script`。

这几个**不在** `BuiltinModules.java` 的 43 个模块里，Inspector 点不出来。用户工程不应手写它们。文档 `docs/api/modules.md` 已注明。

### D3 `bwe.scripts.call` / `bwe.scripts.has` 与 `bwe.call` / `bwe.has` 完全等价

`ScriptApi.java:318/330`（根）与 `361/373`（`scripts` 命名空间）实现**逐字相同**。d.ts 两套都声明了，保留即可。

### D4 `console.log` / `console.info` / `console.warn` / `console.error`

不是契约的一部分，是「契约外的小便利」（`ScriptApi.java:85` 注释自己说的），映射到 `bwe.log` / `bwe.error`。d.ts **没有**声明 `console` —— 但 JS 运行时里存在。可考虑补进 d.ts（用户写 `console.log` 会 TS 报错）。

---

## 五、`docs/scripting-api.md` 里「有文档、无实现」的其他条目

除上面 B 类已列出的，还有这些在旧契约里出现但落地情况需要 Lead 在集成时确认的：

| 契约位置 | 内容 | 实际 |
|---|---|---|
| §2.11.7 涌现式验收场景（E1~E11） | 一整套自动化断言清单 | 属于**验收规格**不是 API。相关能力（field/material/ai/physics）都在，但这份清单本身不在自检里逐条断言（由 `verify-emergence.mjs` 承担） |
| §2.11.8 实践坑 6 条 | 「写涌现脚本最容易踩的 5 条」（实际列了 6 条） | 全部**成立**，已吸收进 `docs/api/emergence.md` 的边界章节 |
| §5 编辑器侧（面板 / 语言切换 / 诊断） | 编辑器功能清单 | 不在运行时 scope；本轮未核对 Web 编辑器实现情况 |
| §6 导出格式 `boot.json` 的 `jsMain` / `scripts[]` | 导出契约 | ✅ 实现（`ScriptEngine.loadScriptTable` + `ScriptEngine.start` 里 `jsMain` 的 `onSceneStart` / `onSceneEnd`） |
| §6 `boot.json` 的 `prefabs[]` | 契约里**完全没有提** | ✅ 新增实现（`ScriptPrefab.loadBootPrefabs`，`GameData` 侧未解析但 `ScriptPrefab` 自己读 boot.json）——**契约需要补这一节** |

### C13 `kind: "LIGHT"` 没有真正的光照效果

| 项 | 内容 |
|---|---|
| 文档暗示 | `bwe.d.ts` / 旧契约把 `LIGHT` 和其他 kind 并列，容易让人以为「挂 LIGHT 就会发光」；`BuiltinModules` 的 `look.light`（发一圈光）也在强化这种印象 |
| 实际实现 | `TopDownRuntime.drawFallback`（L2068）只把 `LIGHT` 当作**兜底色块颜色**分支（暖黄 `FALLBACK_LIGHT`）—— 即「对象没有贴图时画个暖黄色块」。**没有发光、没有照亮周围、没有 `radius` / `color` / `strength` / `flicker`** |
| 影响 | 用户挂 `look.light` 或建 `kind: "LIGHT"` 对象期待光效 → 只会看到一个半透明黄色矩形 |
| 需改 | `bwe.d.ts` 的 kind 注释里注明 `LIGHT` 只有占位色；`docs/api/modules.md` 已写明。要真光效只能脚本用 `bwe.draw.circle` / `e.attach` 叠半透明图 |

---
## 六、汇总统计

| 类别 | 数量 | 说明 |
|---|---|---|
| **A 类**（实现已改、文档未跟） | 5 | layers / cursor / pitch / onSceneEnd / 染色（后者已同步） |
| **B 类**（文档承诺、实现没有） | 10 | tween 占位 / 三个 on* 不返回取消函数 / wheel 恒 0 / fight.hp 三参数 / 6 组参数名不一致 / blink+shadow 参数 / ai.speed / target.cell 多字段 / lastKnown.from / field.on cause |
| **C 类**（表述细节） | 13 | AttachHandle（已修） / damage+heal 返回 / save.flush+delete / music 返回 / spawner.stop / SceneInfo 缺字段 / ctx.self 可为 null / ctx.game / EntityEvent 缺两项 + 追加语义 / spawn.kind 默认值 / kind 列表精确度 |
| **D 类**（遗留别名） | 4 | 模块双 id / 目录外 id / scripts 等价 / console 未声明 |

**其中建议优先修（会让用户代码跑不通的）**：

1. **C8 `ctx.self` 可为 null** —— 场景脚本里 `ctx.self.name` 会运行期崩，而 d.ts 说不是 null。
2. **B2 三个 `on*` 不返回取消函数** —— 用户照 d.ts 写 `off()` 会 `TypeError`。
3. **C4 `audio.music` 返回 void** —— 用户拿不到 id 就没法停 BGM（能力缺失，不只是类型错）。
4. **C10 `EntityEvent` 缺 `"interact"` / `"destroy"` + 「追加不是覆盖」** —— 会导致运行期重复回调。
5. **B3 `mouse.wheel` 恒 0** —— 拿它做缩放/切武器的用户会以为引擎坏了。
