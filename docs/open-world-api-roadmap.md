# BWE 开放世界 API 路线图

> 配套：[`open-world-engine-audit.md`](open-world-engine-audit.md)、[`open-world-architecture.md`](open-world-architecture.md)。
> 每个 API 必须回答任务书 §24 的 10 个问题才能公开；本文就是那张答卷。
> 状态图例：✅ 已有可用 ｜ 🔧 已有需扩展 ｜ ❌ 不存在 ｜ ⛔ 明确不做

---

## 0. 状态总表

### 0.1 Studio Runtime 脚本 API（`bwe.*`，对外）

| 命名空间 | 成员数 | 状态 | 本轮动作 |
|---|---|---|---|
| `bwe`（根） | 17 | ✅ | 不动 |
| `bwe.world` | 22 | ✅ | 不动（`layers()` Phase2 占位）|
| `Entity` | 53 | ✅ | 只加：`e.zone` 只读、`e.floor` 只读、`e.alive` 已有 |
| `bwe.prefab` / `bwe.pool` | 9 / 4 | ✅ | 只加：复用状态重置语义（修 bug，不加成员）|
| `bwe.input` | 6 | 🔧 | 不动；新增 `bwe.actions` 独立命名空间 |
| `bwe.camera` | 10 | ✅ | 不动 |
| `bwe.time` | 3 (+ after/every/cancel) | ✅ | 只加：`bwe.timer` 作用域语义（文档+行为）|
| `bwe.draw` | 8 | ✅ | 只加：`draw.debug`? → 走 `bwe.debug`（见下）|
| `bwe.audio` / `bwe.save` / `bwe.scripts` / `bwe.seed` | 4/10/2/4 | ✅ | 不动 |
| `bwe.grid` / `bwe.tilemap` | 4 / 6 | ✅ | `tilemap.setSolid` 触发 nav 失效（行为）|
| `bwe.nav` | 4 | 🔧 | 加 `canReach` / `nearest` / `agent`（楼层感知）|
| `bwe.interact` / `bwe.spawner` | 4 / 2 | ✅ | 不动 |
| `bwe.material` / `bwe.field` / `bwe.noise` | 7/9/2 | ✅ | 不动 |
| `bwe.sense` / `bwe.ai` / `bwe.faction` / `bwe.target` | 4/8/4/3 | ✅ | `bwe.ai` 加 `onStateChange`? → L4 用轮询，不加 |
| `bwe.physics` | 16 | ✅ | 不动；内部改从 `CollisionEventBus` 转发 |
| `bwe.scene` | **0** | ❌ | **新增** |
| `bwe.spatial` | **0** | ❌ | **新增** |
| `bwe.collision` | **0** | ❌ | **新增** |
| `bwe.actions` | **0** | ❌ | **新增** |
| `bwe.road` | **0** | ❌ | **新增** |
| `bwe.vehicle` | **0** | ❌ | **新增** |
| `bwe.combat` | **0** | ❌ | **新增** |
| `bwe.debug` | **0** | ❌ | **新增**（调试绘制：碰撞框/路径/空间边界）|

### 0.2 Legacy Core Java API（不暴露脚本）

| 能力 | 状态 | 本轮动作 |
|---|---|---|
| `IAbility` / `GameObject` 生命周期 | 🔧 | **加固**（6 条缺陷，见路线图 §2）|
| `TransformAbility` 父子/世界局部 | 🔧 | **扩展** |
| `ColliderWorld` / `BoxColliderAbility` | ✅ | 保留 |
| `CollisionSystem` | 🔧 | **语义升级**（enter/stay/exit），保留旧静态方法 |
| `SceneManagement` | 🔧 | **加固**（清协程、清 Camera、可重入）|
| `CoroutineManager` | 🔧 | **加取消句柄 + 作用域** |
| `KeyManager` | 🔧 | **加动作映射层**（保留原方法）|
| `EventBus` | ❌ | **新增** |
| `NavigationGrid/Query/Agent/Link` | ❌ | **新增**（纯 Java，旧核心侧；Studio 侧走 `bwe.*` 同一算法）|
| `SpatialZone/Building/Floor/Room` | ❌ | **新增** |
| 渲染后端迁移（VBO/GL3） | ⛔ | 不做 |

---

## 1. 每个新 API 的 10 项验收答卷

### 1.1 `bwe.scene`（L2 通用框架）

| 问题 | 答案 |
|---|---|
| 解决什么问题 | 一张图跑到底 → 支持多场景加载 / 卸载 / 切换（室内、室外、分块）|
| 谁调用 | 游戏脚本（场景切换门、电梯、进出建筑）、`bwe.interact` 回调 |
| 生命周期 | 场景级：`load` 建 Actor + 空间 + 导航；`unload` 全清 |
| 参数/返回值 | `list()` → `[{name,file,width,height}]`；`current()` → `{name,index,...}`；`load(name, opts)` → `bool`；`unload(opts)` → `bool`；`switchTo(name, opts)` → `bool`；`on(evt, fn)` / `off`；`unloading()` |
| 错误处理 | 未知名字 → 返回 false + 写 `bwe.log` 一行；加载中重复调用 → 返回 false（不抛）；卸载后 `current()` 返回 null；失败**不破坏当前场景**（先校验后提交）|
| 与已有 API 关系 | `bwe.world.*` 全部作用于**当前**场景，切换后自动指向新场景；`bwe.world.scene` 保持返回当前场景信息（不改语义）|
| 暴露给 JS | 是 |
| 编辑器如何配置 | 场景列表本来就有（`Project.scenes[]`）；新增可选 `transitions` 不改必需字段 |
| 自动化测试 | `bwe.scene.list` 计数；`switchTo` 后 `world.count()` 与旧场景不同；`unload` 后所有清理项为 0；未知名返回 false |
| 文档位置 | `docs/api/scene.md` |

### 1.2 `bwe.spatial`（L2 通用框架）

| 问题 | 答案 |
|---|---|
| 解决什么问题 | 建筑 / 楼层 / 房间 / 垂直连接 / 五状态分离 |
| 谁调用 | 场景加载器（建 zone）、渲染器（读 `renderVisible`）、碰撞层（读 `collisionEnabled`）、导航（读 `navPassable`）、游戏脚本（`current()` 判断玩家在哪）|
| 生命周期 | 场景级；随 `unload` 清空 |
| 参数/返回值 | `defineBuilding(def)` / `defineFloor` / `defineRoom` → id；`building(id)` / `floor(id)` / `room(id)` / `byId(id)`；`all()`；`at(x,y)` → zone；`current()` → `{building, floor, room, id}`；`enter(zoneId)` / `leave()`；`visibility(zoneId)` → `{renderVisible, collisionEnabled, navPassable}`；`setFloorVisibilityRule(fn)`；`links()` / `link(id)` / `useLink(id, e)`；`clear()` |
| 错误处理 | `byId` 未知 → null；`at()` 无 zone → null；`enter` 未知 → false；循环 link → `useLink` 拒绝并返回 false |
| 与已有 API 关系 | `Entity` 新增只读 `e.zone` / `e.floor`（由 `at()` 解析）；`bwe.tilemap.solid` 不变（每层有独立 tilemap 实例，旧 API 默认作用于当前层）|
| 暴露给 JS | 是 |
| 编辑器如何配置 | 场景新增 `buildings[]` / `floors[]` / `rooms[]` / `entrances[]`（可选段）；画布可放 `ZONE`/`PORTAL` 已存在 |
| 自动化测试 | 两层测试楼：屋顶剔除、当前层/他层、五状态互不覆盖、卸载归零、NPC 不能穿楼板 |
| 文档位置 | `docs/api/spatial.md` |

### 1.3 `bwe.collision`（L2 通用框架）

| 问题 | 答案 |
|---|---|
| 解决什么问题 | 统一 enter/stay/exit + 触发器 + 过滤 + 查询 |
| 谁调用 | 拾取、进车、进楼、攻击命中、区域触发 |
| 生命周期 | 订阅随实体/场景销毁自动注销（作用域）|
| 参数/返回值 | `on(evt, fn, opts)` → handle（evt: `enter`/`stay`/`exit`/`triggerEnter`/`triggerStay`/`triggerExit`）；`off(handle)`；`query(rect)` → Entity[]；`overlapCircle(x,y,r)` → Entity[]；`raycast(x1,y1,x2,y2,opts)` → `{hit,x,y,entity,normal}`；`setFilter(e, {layer, mask})`；`setTrigger(e, on)` |
| 错误处理 | 未开物理时 `query` 仍可工作（纯 AABB 查询，文档写明这是"查询不是接触"）；`raycast` 无命中 → `{hit:false}`（不是 null）；`on` 无效 evt → 返回 null + log |
| 与已有 API 关系 | `bwe.physics.on("collision")` **保留**（改成从同一总线转发，载荷不变）；`bwe.physics.raycast` 保留；`queryAABB` 与 `query` 语义并存（前者含物理体，后者含所有实体）|
| 暴露给 JS | 是 |
| 编辑器如何配置 | 对象已有 `halfW/halfH`；新增可选 `collision:{layer,mask,trigger}` |
| 自动化测试 | enter 一次/stay 每帧/exit 一次；销毁期不派发；快速擦过 enter→exit 顺序；sensor 区分 |
| 文档位置 | `docs/api/collision.md` |

### 1.4 `bwe.actions`（L2 通用框架）

| 问题 | 答案 |
|---|---|
| 解决什么问题 | 可配置动作映射 + 输入上下文（游戏/UI/对话互斥）+ 焦点丢失 |
| 谁调用 | 玩家控制脚本、UI 脚本 |
| 生命周期 | 全局；`onSceneStart` 时 `bind`，场景切换保持 |
| 参数/返回值 | `bind(map)` → 合并写入；`reset()`；`down(a)`/`pressed(a)`/`released(a)`；`axis()` → `{x,y}`；`context(name)` / `context()`；`pushContext(name)`/`popContext()`；`on(a, fn)` |
| 错误处理 | 未绑定动作 → `down` 返回 false（不抛）；未注册键名 → log 一次并 false；窗口失焦 → 全部 `down` 立即 false、`pressed` 不再产生 |
| 与已有 API 关系 | `bwe.input` 完全保留（原始键层）；`bwe.actions` 是它上面的映射层；`bwe.input.axis()` 不变 |
| 暴露给 JS | 是 |
| 编辑器如何配置 | `boot.json` 新增 `data.inputMap`（可选）；编辑器「设置」页可编辑 |
| 自动化测试 | 改配置 = 改键；上下文切换后互斥；失焦清空 |
| 文档位置 | `docs/api/actions.md` |

### 1.5 `bwe.nav` 扩展（L2）

| 问题 | 答案 |
|---|---|
| 解决什么问题 | 楼层感知寻路 + 可达性 + 最近可走点 |
| 谁调用 | NPC AI、警察、出租车 |
| 生命周期 | 场景级图；agent 随实体 |
| 参数/返回值 | 既有 4 个不动；新增 `canReach(a, b, opts)` → bool；`nearest(x, y, opts)` → `{x,y,cx,cy}`；`agent(e, cfg)` / `agentOf(e)` / `agentStop(e)`（`follow/stop` 保持）|
| 错误处理 | `canReach` 超出网格 → false；agent 卡住 → 自动重算（有上限），超限 → 状态 `stuck` 并回调 |
| 与已有 API 关系 | `bwe.nav.follow/stop/find/lineOfSight` **签名和语义不变**（51 项 AI 断言依赖）|
| 暴露给 JS | 是 |
| 编辑器如何配置 | 导航标记（`ZONE` 已有）+ 新增 `navLinks[]` |
| 自动化测试 | A\* 最优性、不可达、动态障碍、楼层隔离、楼梯/电梯连接 |
| 文档位置 | `docs/api/map-nav-interact-spawner.md`（追加）|

### 1.6 `bwe.road` / `bwe.vehicle`（L3 通用游戏模块）

| 问题 | 答案 |
|---|---|
| 解决什么问题 | 路网（节点/路段/路口）+ 车辆运动（加速/制动/转向/驾驶员）|
| 谁调用 | 交通系统脚本、出租车、警车、劫车逻辑 |
| 生命周期 | 路网随场景；车辆随实体 |
| 参数/返回值 | `road.graph()` / `nearest(x,y)` / `route(from, to)` → `[{x,y}]` / `edges()`；`vehicle.spawn(opts)` → Entity；`vehicle.enter(e, veh)`；`vehicle.exit(e)`；`vehicle.steer(e, dir)`；`vehicle.throttle(e, v)`；`vehicle.brake(e, v)`；`vehicle.speed(e)`；`vehicle.driver(e)`；`vehicle.damage(e, n)`；`vehicle.on(evt, fn)`（`crash`/`hijack`/`enter`/`exit`）|
| 错误处理 | 不在路网上 → `route` 返回空；无驾驶员 → `steer` 无效；车辆销毁时有驾驶员 → 先派发 `exit` |
| 与已有 API 关系 | 复用车内 `NavigationAgent2D`（不同 NavConfig）；不复用瓦片 A\* |
| 暴露给 JS | 是（文档标注"可替换实现"）|
| 编辑器如何配置 | 场景新增 `roadNetwork`（可选段）；可先 JSON 生成，后续再加可视化 |
| 自动化测试 | 路网 route 非空；车辆到达；路口转向；避障；劫车控制权转移 |
| 文档位置 | `docs/api/vehicle.md` |

### 1.7 `bwe.combat`（L3）

| 问题 | 答案 |
|---|---|
| 解决什么问题 | 统一命中/伤害/防御/武器，数据驱动 |
| 谁调用 | 武器脚本、NPC 战斗 AI、警察 |
| 生命周期 | 参数表随 boot.json；状态随实体 |
| 参数/返回值 | `hit(opts)` → `{hit, target, amount, blocked, killed}`；`defend(e, on)` / `defending(e)`；`weapon(e, def)` / `weaponOf(e)` / `switchWeapon(e)`；`ammo(e)` / `setAmmo(e,n)`；`params(kind)` → 数据表项；`on("kill"/"damage", fn)` |
| 错误处理 | 目标已死 → `{hit:false}`；无武器 → 徒手参数；参数缺失 → 用内置默认表并 log 一次 |
| 与已有 API 关系 | `e.hp/hpMax/damage/heal` **完全不动**；`combat.health` 模块不动；`bwe.combat.hit` 是上层组合 |
| 暴露给 JS | 是 |
| 编辑器如何配置 | `boot.json` 新增 `data.weapons` / `data.itemTypes` / `data.npcTypes` |
| 自动化测试 | 伤害扣血、防御减免、死亡事件、拾取、弹药递减 |
| 文档位置 | `docs/api/combat.md` |

### 1.8 `bwe.debug`（L2）

`box(e, color)` / `circle(x,y,r)` / `path(e)` / `zones(bool)` / `nav(bool)` / `collision(bool)` / `on/off`。
只做调试绘制，走 `bwe.draw` 同一套立即模式。错误处理：无 GL 时安全跳过。测试：指令被记录（`debugDrawCount`）。

### 1.9 Legacy Core 新 API 要点

- `GameObject.Destroy()` / `isDestroyed` / `AddAbility` 返回 bool（已存在则 false）/ `GetAbility(Class)` / `AbilityOrder`。
- `TransformAbility.parent` / `worldPosition()` / `worldRotation()` / `localToWorld` / `worldToLocal`。
- `EventBus<T>`（`Subscribe/Unsubscribe/Publish`，含 `Subscription` 句柄，`Dispose` 全清）。
- `CoroutineManager` 返回 `CoroutineHandle`（`Cancel()` / `IsFinished`），并按 `SceneScope` 批量取消。
- `KeyManager` 增 `BindAction(action, keys[])` / `IsActionHeld/Down/Up`（旧方法不动）。
- `CollisionEvents`（`OnCollisionEnter/Stay/Exit` 回调接口，内部维护 pair 表）。
- `NavigationGrid`（`Build(cols,rows,cellSize)`、`SetBlocked`、`FindPath`、`LineOfSight`）+ `NavigationAgent2D`（`SetTarget`、`Update(dt)`、`OnArrive`）+ `NavigationLink`。
- `SpatialZone` / `Building` / `Floor` / `Room`（五状态字段 + `SpatialResolver`）。

---

## 2. 实施顺序与依赖（为什么是这个顺序）

```
阶段A 审计与基线 ✅ 完成
   ｜
阶段B0 旧核心加固（可与其它并行，风险隔离）
   ├─ B0.1 Ability 生命周期测试先行 → 修 6 条缺陷
   ├─ B0.2 GameObject.Destroy + 延迟销毁
   ├─ B0.3 Transform 父子（先测试后实现）
   └─ B0.4 SceneManagement 加固
   ｜
阶段B1 运行时基础（Studio 侧，必须串行：都动 ScriptEngine/TopDownRuntime）
   ├─ B1.1 场景切换执行器（bwe.scene）              ← 其它全部依赖它
   ├─ B1.2 延迟销毁提交（destroy 队列）
   ├─ B1.3 作用域化 timer/event 清理                 ← 依赖 B1.2
   ├─ B1.4 CollisionEventBus（enter/stay/exit）      ← 依赖 B1.2
   └─ B1.5 bwe.actions 输入映射                      ← 独立，可并行
   ｜
阶段B2 空间与导航（依赖 B1.1 + B1.4）
   ├─ B2.1 NavigationQuery 抽出 + 楼层维度
   ├─ B2.2 NavigationAgent2D（升级 Follow）
   └─ B2.3 SpatialZone/Building/Floor/Room + Resolver
   ｜
阶段C 两层建筑验证（依赖 B2 全部）
   ｜
阶段D 城市灰盒（依赖 C）
   ｜
阶段E NPC + 交通（依赖 D；road/vehicle 新增）
   ｜
阶段F 战斗 + 通缉（依赖 E）
   ｜
阶段G 编辑器 + 四方一致（可与 D 并行开始，F 后收口）
   ｜
阶段H 性能 + 全量回归 + 报告
```

**并行约束（写入 Team 任务板）**：
- `ScriptApi.java`（2263 行）与 `ScriptEngine.java`（1384 行）是**热点文件**，任何时刻**只能有一个写者**。
- 新命名空间一律**新文件**（`ScriptScene.java` / `ScriptSpatial.java` / `ScriptCollision.java` / `ScriptActions.java` / `ScriptRoad.java` / `ScriptVehicle.java` / `ScriptCombat.java` / `ScriptDebug.java`），走 `install(ScriptApi)` 模式（与 `ScriptPhysics` 一致），**不改 `ScriptApi` 的已有代码**，只在 `buildEmergence()` 旁新增一行注册。
- 契约三件套（`bwe.d.ts` / `apiDocs.ts` / `docs/api/*.md`）各自独立文件，可并行。

---

## 3. 阶段验收条件（可机检）

| 阶段 | 机检验收 |
|---|---|
| B0 | 新增 `EngineAbilityTest` 全绿（含 6 条缺陷断言）；旧 394 断言全绿；`ScriptSelfTest` 等 7 套退出码 0 |
| B1 | `ScriptSceneTest`/`CollisionEventTest`/`TimerScopeTest`/`InputActionTest` 全绿；`verify-apidocs --strict` 退出 0（新命名空间 4 方齐全）|
| B2 | `NavigationFloorTest`/`SpatialBuildingTest` 全绿；含"无 link 不可达"断言 |
| C | 两层建筑 E2E：屋顶剔除、楼层切换、NPC 不穿楼板、卸载归零 |
| D | 城市生成 + 离屏渲染 `frameErrors=0`；各建筑入口 A\* 可达 |
| E | 200 行人 + 40 车 × 600 帧无异常；无卡死断言 |
| F | 8 条 E2E 断言（攻击/防御/拾取/通缉/追逐/医院/出租/劫车）|
| G | `.bwproj` → `boot.json` → 运行时往返空间信息一致；`verify-apidocs --strict` = 0；`tsc` = 0 |
| H | 性能基准表 + 像素 diff=0 + 全量测试绿 + 报告区分四类状态 |

---

## 4. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| JDK 26 默认 java → 测试全挂 | 高 | 所有脚本/测试显式用 JDK 25 绝对路径；文档置顶警告 |
| `ScriptApi.java` 多人同时改 → 冲突 | 高 | 新 API 全走独立文件 + `install()`；热点文件单写者 |
| 场景切换需要动 `TopDownRuntime` 核心 | 高 | 先写 `ScriptSceneTest`；切换实现放在独立类，`TopDownRuntime` 只加 1 个包内方法 |
| 楼层导航改动破坏现有 51 项 AI 断言 | 中 | `bwe.nav.follow/stop/find` 签名与语义冻结；新能力加新方法 |
| 物理事件改造破坏 47 项断言 | 中 | `bwe.physics.on("collision")` 载荷不变 |
| 编辑器改动破坏旧 `.bwproj` | 中 | 全部新段 optional + `normalizeProject` 兜底 + 往返测试 |
| 城市规模导致帧时间超标 | 中 | 先测量再优化；已有合批不动 |
| 时间预算不够做全部 F | 中 | 优先级：C > D > E(行人/车) > F(战斗/通缉) > G 补齐；未完成的**如实写进报告"未实现"** |
