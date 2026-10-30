# BWE 开放世界工程审计报告

> 审计对象：`D:\githubdesktop\BrokenWonderEngine`（git `e2059a9`，main 分支，工作区有未提交改动）
> 审计方式：逐文件读源码 + 跑构建 + 跑全部测试 + 跑 API 四方一致性 + 跑离屏 GL 像素验证。
> 本文所有结论都标注了「代码位置」，不依据 README 推断。
> 审计时间：2026-10-29。

---

## 0. 审计结论摘要（先看这段）

**最重要的一条发现：这个仓库里有「两套引擎」，而且真正在跑游戏的那套不是 README 描述的那套。**

| | 旧核心 Legacy Core | Studio 运行时 Studio Runtime |
|---|---|---|
| 位置 | `src/Core`、`src/Framework`、`src/Tool`、`src/UI`、`src/TypeStructure`、`src/AbstractLayer` | `src/Studio/runtime` |
| 对象模型 | `GameObject` + `IAbility` 能力组件 | `TopDownRuntime.Actor` 纯字段结构体 |
| 驱动者 | `UserUsage.xia_demo.gameWindow`（README 里的 Demo） | BWE Studio 的 `.bwproj` → `Build/boot.json` → `Studio.runtime.TopDownRuntime` |
| 渲染 | `Renderer2DAbility` 每个精灵一次 `glBegin` | 自带精灵合批 + 纯色合批（`flushSpriteBatch` / `batchSolid`） |
| 脚本 | 无脚本 | 内嵌 Rhino 1.7.15，全局 `bwe.*`（27 个命名空间 / 271 个成员） |
| 物理 | `ColliderWorld` + `BoxColliderAbility` + `CollisionSystem`（O(n²) 配对） | `ScriptPhysics`（JBox2D 桥，自带 ContactListener） |
| 规模 | 约 60 文件 | `TopDownRuntime` 单文件 2913 行 + `ScriptApi` 2263 行 |

**这两套之间没有任何代码互调。** 它们只共享 `lib/` 里的 JOGL / JBox2D / Gson / Rhino。

因此，本项目的技术路线必须是：

- **游戏原型跑在 Studio Runtime 上**（它是唯一能承接 `.bwproj` 编辑器产物、有脚本 API、有合批渲染、有离屏像素回归的那套）。改旧核心来做游戏是死路。
- **旧核心仍要按任务书要求完成审计与局部修复**（Ability 生命周期缺陷是真 bug，且有测试价值），但**不把游戏逻辑写进旧核心**，也不为了统一而重写任何一套。
- 两套之间的能力缺口要**分别**补：旧核心补「通用框架能力」，Studio Runtime 补「脚本可见的 `bwe.*` 能力」。同一份设计意图，两处落地。

**已实测的基线（都是本机真实输出，不是宣称）：**

| 项 | 结果 |
|---|---|
| 编译（JDK 25，`javac -d ... -cp "lib/*"`） | ✅ 152 个 .java 全部通过，3.4 s |
| 7 个测试类 | ✅ **394 项断言全部通过**（109 + 43 + 47 + 51 + 97 + 28 + 19） |
| API 四方一致性 `node web/tools/verify-apidocs.mjs` | ✅ 缺失 0 / 编造 0，退出码 0 |
| TypeScript `tsc --noEmit` | ✅ 通过，退出码 0 |
| 离屏 GL 像素渲染 `OffscreenFrameDump` | ✅ 跑通，12 帧，`nonBgPixels=91800`，`frameErrors=0`，能产出 PNG + 像素哈希 |
| 编辑器 → 运行时打包 `package-bwe.mjs --build-only` | ✅ 跑通，产出 `Build/boot.json` + `Build/scripts/*.js` |

> ⚠ **JDK 版本硬约束**：JOGL 2.1 在 **JDK 26 上必崩**（`NoClassDefFoundError: java/applet/Applet`，JDK 26 删了 `java.applet`）。
> 本机 `java` 默认指向 JDK 26（`C:\Program Files\Java\jdk-26.0.2.1`）。**必须显式用 `C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot\bin\java.exe`**。
> 另需三个 flag：`--enable-native-access=ALL-UNNAMED --add-opens=java.desktop/sun.awt=ALL-UNNAMED --add-opens=java.desktop/sun.java2d=ALL-UNNAMED`
> （见 `docs/scripting-api.md` §0.1、`web/tools/package-bwe.mjs` `RUNTIME_JDK_MIN/MAX`）。
>
> ⚠ `javac --release 8` **编不过**：源码用了 `switch` 表达式、`instanceof` 模式匹配、文本块、`var`。
> `.vscode/tasks.json` 里的 `build` 任务写的是 `--release 8`，**当前实际失效**。这是已存在的工程瑕疵，审计记录在案。

---

## 1. 已有且可以直接复用的功能

### 1.1 Studio Runtime（游戏主战场）——可直接复用

以下全部为源码核实，并已被 394 项断言覆盖：

| 能力 | 位置 | 状态 |
|---|---|---|
| `.bwproj` → `boot.json` 打包、素材内联、脚本 TS→ES5 降级 | `web/src/app/packageBwe.ts`、`web/tools/package-bwe.mjs` | ✅ 实测跑通 |
| 固定步长逻辑（dt 钳制 ≤0.1 s）+ `paused` / `timeScale` | `ScriptEngine.tick()` 626–690 | ✅ |
| 实体模型：`Actor`（x/y/face/hp/hpMax/dead/anim/tint/尺寸缓存） | `TopDownRuntime.Actor` 360–421 | ✅ |
| `bwe.world`：find/findAll/spawn/spawnMany/spawnAt/clone/destroy/clear/clearTag/destroyAll/count/each/entities/on/off/emit/layers | `ScriptApi` + `ScriptWorld` | ✅ 22 成员 |
| `Entity` 53 成员：pos/size/sprite/play/setFrame/prop/setProp/module/attach/detach/distanceTo/angleTo/damage/heal/on/… | `ScriptApi.entity()` | ✅ |
| 瓦片图 `bwe.tilemap`：get/set/solid/setSolid/blocked/raycast | `ScriptWorld` 60–197 | ✅ |
| **A\* 寻路** `bwe.nav`：`find`（八方向、octile 启发、不切角、`maxNodes` 上限、`smooth` 抽稀）/`lineOfSight`/`follow`/`stop` | `ScriptWorld.findPath` 205–359、`smoothPath` 341 | ✅ 已在用 |
| 相机 `bwe.camera`：follow/pos/setPos/zoom/setZoom/shake/bounds/worldToScreen/screenToWorld/setFit | `ScriptApi` | ✅ 10 成员 |
| 输入 `bwe.input`：down/pressed/released/axis/mouse{x,y,worldX,worldY,left,middle,right,wheel}/cursor | `ScriptApi` | ✅ 6 成员 |
| 时间 `bwe.time`：now/dt/frame + `bwe.after/every/cancel` | `ScriptApi` / `ScriptEngine.fireTimers` | ✅ |
| 绘制 `bwe.draw`：text/rect/line/circle/sprite/bar/measureText/world | `ScriptApi` | ✅ 8 成员 |
| Prefab `bwe.prefab`（9）+ 对象池 `bwe.pool`（4） | `ScriptPrefab` 1050 行 | ✅ 97 项断言 |
| 物理 `bwe.physics`：enable/gravity/debug/body/remove/applyImpulse/velocity/setVelocity/throwAt/raycast/queryPoint/queryAABB/on("collision")/bodyCount/tileBodyCount | `ScriptPhysics` 1067 行 | ✅ 47 项断言，`World.step` 平均 0.401 ms |
| 涌现基底：`bwe.material`(7) / `bwe.field`(9，火/水/烟格子场) / `bwe.noise`(2) / `bwe.sense`(4) / `bwe.ai`(8) / `bwe.faction`(4) / `bwe.target`(3) | `ScriptFields` / `ScriptAi` | ✅ 51 + 43 项断言 |
| 触发器 `ZONE` 的玩家进出派发（`onEnter`/`onLeave` + `e.on("enter")`） | `ScriptEngine.processZones` 1539–1568 | ⚠ 仅玩家 + 仅 ZONE |
| 模块解释器：`move.patrol`/`move.follow`/`move.wander`/`fx.cameraFollow`/`render.*`/`combat.health` | `TopDownRuntime.updateModules` 1568+ | ✅ |
| 存档 `bwe.save`（10）、音频 `bwe.audio`（4） | `ScriptSave` / `ScriptAudio` | ✅ |
| 确定性种子 `bwe.seed`（4） | `ScriptAi.installSeed` | ✅ 同种子同结果 |
| 脚本间调用 `bwe.scripts`（2）、`bwe.call/has` | `ScriptEngine` | ✅ |
| 纹理缓存 + 懒加载 + PNG 上传 | `TopDownRuntime.textureCache/uploadTextures` | ✅ |
| 渲染合批（精灵 + 纯色） | `flushSpriteBatch` 204、`batchSolid` 293 | ✅ 已优化，见 §1.3 |
| 离屏像素回归驱动器 | `OffscreenFrameDump` + `web/tools/frame-diff.mjs` | ✅ 实测跑通 |
| 性能基准 | `ScriptPerfTest` + `web/tools/perf-bench.mjs` | ✅ |
| API 四方一致性检查器 | `web/tools/verify-apidocs.mjs` 931 行 | ✅ |

### 1.2 旧核心 Legacy Core——可复用但与游戏无接线

| 能力 | 位置 | 备注 |
|---|---|---|
| `GameObject` + `IAbility` 组合（`OnInit`→`OnAdded`→`OnUpdate`→`OnRemove`） | `Framework/GameObject.java`、`IAbility.java` | 生命周期齐全，但有缺陷（§2.1） |
| `TransformAbility`（position/rotation/scale） | `Framework/TransformAbility.java` | 无父子 / 无世界坐标 |
| `Renderer2DAbility`（单图 / 多帧 / 图集，UV 复用） | `Framework/Renderer2DAbility.java` 149 行 | 三模式共用一段四边形 |
| `TextureCache`（按路径缓存 + 引用计数） | `Tool/TextureCache.java` | 复用良好，建议沿用 |
| `BoxColliderAbility` + `BoxCollider2D`（JBox2D 刚体） | `Framework/`、`Core/Physics/Collider/` | `syncTransformToBody` / `syncBodyToTransform` |
| `CollisionSystem`（O(n²) 配对 + `enumeratePairs` 可测） | `Core/CollisionSystem.java` 67 行 | 每帧触发，**无 enter/stay/exit** |
| 固定步长管线（accumulator，1/60，钳制 0.25 s） | `Core/GameSekai.java` 26–84 | 顺序：逻辑→T2B→step→B2T→碰撞→协程 |
| `SceneObjReg` 按 type 注册工厂 | `Core/SceneManageTool/` | 关卡 JSON 驱动 |
| UI（JSON 布局 + 补间 + F5 热重载） | `UI/` 14 文件 | `UIJsonLayoutLoader` 502 行 |
| `MainWindow` 窗口 | `AbstractLayer/MainWindow.java` | 静态 `keyManager` |

### 1.3 已有性能优化的实测证据（必须保留，不得回退）

来源 `docs/_fragments/integration-report.md`，并在本轮基线中复验（`ScriptPerfTest` 全绿）：

| 场景 | 指标 | 优化前 | 优化后 | 像素 diff |
|---|---|---|---|---|
| 40×30 有贴图（170 实体） | `glBegin`/帧 | 162 | **7** | **0** |
| 同上 | 帧时间 | 2.097 ms | **1.708 ms** | — |
| 100×100（3600 无贴图 TILE） | `glBegin`/帧 | 3575 | **20** | **0** |
| 同上 | 帧时间 | 2.062 ms | **1.537 ms** | — |
| `fields` tick avg | — | 0.0356 ms | **0.0173 ms** | — |

本轮任何渲染改动都必须用 `OffscreenFrameDump` 出 PNG + `frame-diff.mjs` 比像素，**逐像素一致才算通过**。

---

## 2. 已有但需要扩展的功能

### 2.1 Ability 生命周期与对象生命周期（旧核心）——**有真实缺陷**

逐条对照任务书 §5 要求检查，结果：

| 检查项 | 实测结论 | 证据 |
|---|---|---|
| 同一 Ability 是否可能被重复添加 | ❌ **会**。`AddAbility` 无去重 | `GameObject.java:57-62` |
| Ability 是否安全访问宿主 | ⚠ 部分。`OnAdded(go)` 给了宿主，但 `OnInit()` **在 `OnAdded` 之前**调用，此刻 `gameObject` 还是 null | `GameObject.java:59-60`；`Renderer2DAbility.OnAdded` 才赋值 `gameObject` |
| Ability 依赖是否明确 | ❌ 每帧 O(n) 线性扫 `Abilitys` 找 Transform，且 `BoxColliderAbility` 找不到就 print 后 `return`（半初始化状态留在列表里） | `BoxColliderAbility.java:36-46`、`Renderer2DAbility.java:53-60` |
| 对象销毁后能力是否继续执行 | ❌ **无 `Destroy()` 方法**。`GameSekai.GameObjects` 是 public static List，只能靠 `GameRenderer.RecycleTex` 顺手 remove；不经过它就没法正确销毁 | `GameObject.java` 全类无 destroy；`GameRenderer.java:103-117` |
| 更新期间增删是否安全 | ❌ **不安全**。`Update()` 直接 `for (IAbility tg : Abilitys)`，能力在 `OnUpdate` 里 `RemoveAbility` 必 `ConcurrentModificationException` | `GameObject.java:36-39` |
| 移除时是否释放资源/订阅 | ⚠ `RemoveAbility` 对**不在列表里**的对象也会调 `OnRemove()`（重复调用 `OnRemove`），且不校验 | `GameObject.java:70-74` |
| 执行顺序是否确定 | ⚠ 依赖 `Abilitys` 插入顺序；Transform 特殊（第 0 位），无显式 order | `GameObject` 构造函数 24–29 |
| 运行时创建 vs 场景加载创建的生命周期一致 | ⚠ 基本一致，但都没走 `OnInit`→`OnAdded` 之外的东西 | 同上 |

**修复策略（最小必要 + 先测试）**：新增 `Destroy()` / `isDestroyed` / 延迟销毁队列、`AddAbility` 去重、`OnUpdate` 快照迭代、`OnRemove` 幂等、能力 `order` 字段。**不改 `IAbility` 抽象方法签名**（会破坏 `UserUsage` 3 个实现类），只在实现类加字段与重载。
测试先行：先写会失败的断言，再改。

### 2.2 场景生命周期（两套都缺）

- 旧核心：`SceneManagement.Reduce` 是唯一切换入口，但**不清协程**（`coroutineManager` 未 clear）、**不置空 `GameRenderer.Camera`**（静态悬空引用）、`isLoading` 是静态布尔（非重入安全）。
  证据：`SceneManagement.java:10-47`。
- Studio Runtime：**根本没有场景切换**。构造函数写死 `data.scenes.get(0)`。
  证据：`TopDownRuntime.java:465-468`。打包器自己也在 UI 里明说「多场景切换模块暂未实现」（`packageBwe.ts:305`）。

### 2.3 碰撞事件语义（关键缺口）

现状是三套并存、语义都不完整：

| 入口 | 事件 | 语义 |
|---|---|---|
| `CollisionSystem`（旧核心） | `GameObject.OnCollision(other)` | 每帧对**仍在重叠**的每一对都调 → 只相当于 "stay"，且 `GameObject.OnCollision` 是空方法体 |
| JBox2D 接触（旧核心） | 无回调，只有 `BoxColliderAbility.overlaps()` 反查 `ContactEdge` | 查询式，无事件 |
| `ScriptPhysics`（Studio） | `bwe.physics.on("collision", fn)` | 只在 `beginContact` 派发一次，`endContact` 只做了 `pending.remove`，**没有向 JS 派发 end**，也没有 stay |

任务书要求的 enter / stay / exit、触发器等，**一个都不完整**。
另外 `enumeratePairs` 是 O(n²)：3600 个碰撞体会到 647 万对/帧——这是明确的可测性能风险，但也**不能未测量就先优化**。

### 2.4 输入（Studio 侧）

`bwe.input` 只给原始键 + 一个内建 `axis()`（WASD+方向键写死）。缺：**动作映射**（可配置改键）、**输入上下文**（游戏 / UI / 对话互斥）、**窗口失焦清空**。
`ScriptEngine` 有 `held/pressed/released` 快照（626–632），骨架已经在，加映射层是低成本扩展。

### 2.5 定时任务 / 事件订阅（Studio 侧）

`bwe.after/every/cancel` 已有；`bwe.world.on/off/emit` 已有；`e.on(...)` 已有。
缺的是**生命周期绑定**：实体 `destroy()` 或场景卸载后，全局总线上指向它的回调**不会自动摘除**（这正是任务书 §11 点名的"无约束全局依赖"风险）。需要在 destroy/切场景时按作用域清理。
另外 `ScriptEngine.tick` 里 `fireTimers` 只受 `!paused` 门控（651–652），`timeScale` 是否影响定时器需测试确认语义后再定文档。

### 2.6 渲染（Studio 侧）

已有合批，但缺：**Y 排序**（现有 `actorOrder` 是 layer→z→y，需确认与开放世界的"脚底 y 排序"一致）、**视口/分辨率适配已做**（`Viewport` 144 行 + `updateSurfaceSize`）、**裁剪区域**（无 scissor）、**调试绘制框**（`bwe.physics.debug` 有，但通用碰撞框 debug 无）。
这些是"扩展"不是"重写"。

### 2.7 Prefab / 对象池（Studio 侧）

已相当完整（1050 行 + 97 断言）。扩展点：复用时的**临时状态重置**需确认（`pool.release/acquire` 是否清了 tint/hp/anim/attach）。已有 `ScriptPrefabTest` 覆盖实例化与计数，但"复用后残留状态"用例需补。

---

## 3. 尚不存在的功能（真缺口）

按"游戏能否做出来"排序，全部经源码确认**不存在**：

| # | 缺口 | 为什么是硬缺口 | 证据 |
|---|---|---|---|
| 1 | **场景管理与多场景切换** | 一张图跑到底，无室内外切换、无分块加载 | `TopDownRuntime.java:465` 写死 `scenes.get(0)` |
| 2 | **多层空间模型**（建筑 / 楼层 / 房间 / 垂直连接 / 可见性规则） | GTA 式"进楼—上楼—屋顶剔除—跨楼层追捕"全部依赖它 | 无任何 building/floor/room 类型；`ZONE`/`PORTAL` 只是视觉 kind（`TopDownRuntime.java:2188`） |
| 3 | **楼层感知的导航** | `ScriptWorld` 的 A\* 是单一二维格，NPC 会"穿楼板"寻路 | `ScriptWorld.findPath` 208–332 只有 `cols/rows/solidCell` |
| 4 | **第三人称/通用战斗与伤害管线** | 只有 `combat.health` 模块与 `e.damage/heal`，无防御、无武器、无命中的统一查询 | `ScriptApi` 无 combat 命名空间 |
| 5 | **道路网络 + 车辆运动** | 只有 tilemap 阻挡；无路网节点/路段/路口，无车辆转向 | 无 road/vehicle 类型 |
| 6 | **可配置输入动作映射 + 输入上下文** | 改键必须改脚本 | §2.4 |
| 7 | **作用域化事件/定时器生命周期** | 场景卸载后悬空回调 | §2.5 |
| 8 | **碰撞 enter/stay/exit 统一事件层** | 触发器、拾取、进车、进楼全部依赖 | §2.3 |
| 9 | **场景数据校验与版本迁移** | 新增空间字段后旧 `.bwproj` 必须还能读 | `Project.format = 1`（`model.ts:9`），`normalizeProject` 只补缺省 |
| 10 | **编辑器的建筑/楼层/导航编辑** | 否则新数据只能手写 JSON | `model.ts:15` 的 kind 枚举里没有建筑/楼层 |
| 11 | **对象唯一 ID 与标签查询（旧核心）** | `Tag` 只有单个 `TagName` 字符串，无 id | `TypeStructure/Tag.java` 全 8 行 |
| 12 | **Transform 父子层级 / 世界局部互转（旧核心）** | 无 | `TransformAbility.java` 无 parent |

---

## 4. 重复实现与职责冲突的模块

1. **【最严重】两套引擎并存**：`Core+Framework` 与 `Studio.runtime`。
   两套都有自己的对象模型、渲染路径、物理入口、生命周期。游戏只能选一套（选 Studio Runtime）。
   **不合并**（任务书禁止推倒重写），但要**明确写入架构文档：哪套承接游戏，哪套只保证 Demo 不回归**。
2. **两套碰撞入口**（旧核心内）：`CollisionSystem` O(n²) 配对 vs JBox2D 接触。两者对**同一对物体**各算一次。
   任务书 §9 明确要求："不要让自定义碰撞系统与 JBox2D 对同一对物体重复执行相同的碰撞逻辑"。
   现状：`CollisionSystem.update()` 对每对调 `overlaps()`，而 `overlaps()` 内部又扫 JBox2D `ContactEdge` → **每对物体每帧一次链表扫描**，是重复的。
3. **两套"触发器"**：旧核心无；Studio 侧有 `ZONE` 的 `processZones`（仅玩家）与 `ScriptPhysics` 的 sensor 接触回调（仅开了物理）。
   语义重叠但不是同一套 API，玩家在脚本里要学两种。需要统一（见架构文档）。
4. **两套时间源**：`GameRenderer.deltaTime`（静态，逻辑侧被临时改写为固定 dt）与 `WaitCoroutine` 直接用 `GameRenderer.deltaTime`。
   `GameSekai.Update` 在固定步长里把 `deltaTime` 改成 `FIXED_DT` 再改回（28–37 行），**这是靠改静态全局来骗过下游**，脆弱但当前行为正确。属于"职责冲突"，改动要极其小心。
5. **两套坐标/尺寸语义**：
   - 旧核心：`transform.scale` 当**半宽半高**用（`Renderer2DAbility` 顶点 ±scale；`isVisible` 也当半宽半高）。
   - Studio：`halfW/halfH` 是半宽半高，`scaleX/scaleY` 是倍率，绘制尺寸 = `assetPixel × scale`。
   两者同名不同义。**新增 API 必须写清属于哪一套**，否则脚本作者必踩坑。
6. **两套 UI**：`UI/`（旧核心 JSON 固定管线 UI）与 Studio 的 `bwe.draw`（立即模式 HUD）。游戏用后者。

---

## 5. 可能影响兼容性的 API（改之前必须想清楚）

| API / 数据 | 兼容风险 | 约束 |
|---|---|---|
| `IAbility` 接口的 6 个抽象方法 | 新增抽象方法 → `UserUsage` 的 3 个实现类 + `TransformAbility` 等全部编译失败 | **只加 default 方法 / 只加实现类字段**，不改签名 |
| `GameObject.Abilitys`（public List） | `BoxColliderAbility`/`Renderer2DAbility`/`CameraAbility` 的 `OnAdded` 直接遍历它找 Transform | 若改为管理器，必须保留 `Abilitys` 视图 |
| `GameObject.transform`（public 字段） | `GameRenderer.isVisible`、`CameraAbility` 直接读 `.transform.position` | 保留为 `TransformAbility` 类型 |
| `GameSekai.GameObjects`（`public static List`） | `GameRenderer.RecycleTex`、`SceneManagement.Reduce`、`GameSekai.Draw` 全部直接操作它 | 收敛场景状态时**必须留静态兼容视图** |
| `GameRenderer.Camera`（`public static GameObject`） | `CameraAbility.OnAdded` 写入，`isVisible`/`display` 读 | 场景卸载必须置 null（当前 bug） |
| `Renderer2DAbility` 的 `scale == 半宽半高` | `xia_demo` 依赖此语义 | **绝不改**，新增 API 另立语义 |
| `CollisionSystem.get()` 单例 + `enumeratePairs` | `test/CollisionSystemTest.java` 直接用 | 保留静态方法与签名 |
| `boot.json` 格式 | 已发布工程 + `packageBwe.ts` 写出方 + `GameData.load` 读取方 | **只做加法**；读取侧缺省值必须兜底 |
| `.bwproj` `format: 1` | 编辑器 `normalizeProject` 与旧工程 | 格式升级要写迁移，`normalizeProject` 兜底 |
| `bwe.*` 271 个成员 | 四方一致性检查器要求**集合完全相等** | 只能加法；每个新成员必须同批进入 4 处：Java / `bwe.d.ts` / `apiDocs.ts` / `docs/api` |
| `docs/scripting-api.md` 契约 | 编辑器 `/api/js-check` 用它做类型诊断 | 改契约先改此文件 |
| `GameSekai.FIXED_DT` / 1/60 | 所有测试与手感 | 不改默认值 |

---

## 6. 新游戏开发所需的最低 API 集合

按任务书 §4 分层。**只列游戏真的会用到的**。

### L1 引擎核心（Engine Core）— 旧核心侧，纯 Java，不暴露脚本

| API | 层 | 解决什么 | 谁调用 | 生命周期 | 验收 |
|---|---|---|---|---|---|
| `GameObject.Destroy()` + 延迟销毁队列 | 核心 | 对象需要真正可销毁（当前没有） | 场景管理、游戏 | 帧末统一提交 | destroy 后再 Update/Draw 不执行；物理体已释放；列表无残留 |
| `IAbility` 生命周期加固（去重 / 快照 / 幂等 / order） | 核心 | §2.1 全部缺陷 | 引擎自身 | — | 6 条缺陷各有 1 条断言 |
| `Transform` 父子 + 世界/局部转换 | 核心 | 场景对象层级 | 游戏、编辑器 | 随对象 | 三层嵌套变换正确；销毁父不影响子崩溃 |
| `EventBus` + 作用域订阅 | 核心 | 跨系统通知且可注销 | 各系统 | 订阅者显式注销 | 注销后不再回调；作用域销毁自动清 |
| `TimeService`（协程取消句柄 / 暂停 / timeScale） | 核心 | §2.5 | 游戏 | 场景级 | 取消后不再触发；暂停期间不计时 |
| `InputManager`（动作映射 + 上下文 + 失焦） | 核心 | §2.4 | 游戏、UI | 全局 | 改配置即改键；失焦清空 |
| `Physics2D.raycast / overlapCircle / contacts` | 核心 | 统一查询入口 | 游戏 | 查询即用 | 与 JBox2D 结果一致；不重复派发 |
| `CollisionEvents`（enter/stay/exit + 触发器） | 核心 | §2.3 | 游戏 | 对象 | enter 一次、stay 每帧、exit 一次；销毁期不派发 |
| `NavigationGrid` / `NavigationQuery` / `NavigationAgent2D` / `NavigationLink` | 通用框架 | 楼层感知寻路 | NPC、警察、车 | 场景级 | A\* 正确；不可达返回明确失败；跨楼层只走 link |
| `SpatialZone` / `Building` / `Floor` / `Room` / `VisibilityRule` / `VerticalLink` | 通用框架 | §3.2 多层空间 | 编辑器、游戏 | 场景级 | 五种状态分离（渲染/碰撞/导航/玩家归属/NPC 归属）|

### L2 游戏框架（Studio Runtime 脚本侧 `bwe.*`）— 必须四方一致

| API | 层 | 解决什么 | 替代什么 |
|---|---|---|---|
| `bwe.scene.*`（list/current/load/unload/switch/onWillChange/onChanged） | 框架 | §3.1 场景切换 | 写死 `scenes.get(0)` |
| `bwe.spatial.*`（defineBuilding/defineFloor/defineRoom/current/enter/byId/visibility/links） | 通用框架 | §3.2 | 无 |
| `bwe.collision.*`（on enter/stay/exit、query、setTrigger） | 框架 | §3.3 | `physics.on` 的不完整版 |
| `bwe.actions.*`（bind/isDown/wasPressed/context/axis） | 框架 | §3.6 | 硬编码键 |
| `bwe.road.*`（graph/nearest/route） | 通用游戏模块 | §3.5 路网 | 无 |
| `bwe.vehicle.*`（spawn/enter/exit/steer/throttle） | 通用游戏模块 | §3.5 车辆 | 无 |
| `bwe.combat.*`（damage/damageable/hit/defend） | 通用游戏模块 | §3.4 | 只有 hp |
| `bwe.timer.cancelOnDestroy` 语义、`bwe.events` 作用域 | 框架 | §3.7 | 无自动清理 |

### L3 游戏专属（**不进引擎**，只放在游戏脚本里）

- 通缉等级（wanted level）、犯罪事件记录、警察 AI 状态机、医院复活流程、出租车招手/目的地选择、劫车反应、GTA 式规则数值。
- 判据：只有"这个游戏"需要、换一个游戏就无意义 → 一律脚本。

---

## 7. 每个阶段的验收条件

| 阶段 | 验收（可自动化） |
|---|---|
| A 审计与基线 | 本文档 + `open-world-architecture.md` + `open-world-api-roadmap.md`；构建/7 套测试/四方一致性/tsc 基线数字全部记录 ✅ |
| B 最小引擎补全 | 每个新 API 有：单元测试、`docs/api` 文档、四方一致（`verify-apidocs --strict` 退出 0）、至少 1 个可跑示例；旧 394 断言仍全绿 |
| C 两层建筑 | 自动断言：室外屋顶可见 → 进入后屋顶不可见 → 当前层可见 / 其他层隐藏 → 玩家可上下楼 → NPC 跨层路径必须经过 link（构造"无 link 则不可达"断言）→ 卸载后空间引用为 0 |
| D 城市灰盒 | 生成器幂等；`.bwproj` → `boot.json` → 离屏渲染出图 `frameErrors=0`、`nonBgPixels` 达阈值；关键道路与建筑入口可达（A\* 从出生点到各入口返回非空路径）|
| E NPC 与交通 | 200 行人 + 40 车持续 600 帧无异常；无"卡死不动"（位置变化率断言）；E2E 行人导航/车辆行驶/劫车各 1 条断言 |
| F 战斗与通缉 | 攻击/防御/拾取/通缉触发/警察追逐/医院恢复/出租车到达/劫车，各 1 条 E2E 断言，同一会话内连续跑通 |
| G 编辑器与 API | 编辑器保存的含建筑/楼层数据的 `.bwproj` 能被 Java 运行时重新加载且空间信息一致（往返比对）；`verify-apidocs --strict` = 0 |
| H 性能与交付 | 同机同图同数量的基准表（对象/精灵/碰撞体/NPC/车/提交次数/逻辑/物理/导航/内存/加载时间）+ 像素回归 diff=0 + 全量测试绿 + 最终报告区分「已实现 / 已测 / 已运行验证 / 未充分验证 / 未实现」|

---

## 8. 审计中发现的其他问题（顺带修，附证据）

1. `.vscode/tasks.json` 的 `build` 任务用 `--release 8`，**与源码语法不符，当前编不过**（实测 20+ 错误）。要么改任务，要么改语法；审计建议改任务（保留源码可读性）。
2. `README.md` 称"7 个测试类共 394 项断言，需 JDK 17~25，不要 JDK 26"，与本机实测一致 ✅（这条 README 是准的）。
3. `README.md` 把 `src/Core`、`src/Framework` 描述为"引擎核心"，但**它不驱动任何游戏产物**；真正的运行时 `src/Studio/runtime` 在 README 里几乎没有篇幅。文档误导性风险，本轮在架构文档中纠正。
4. `GameRenderer.RecycleTex` 两个重载语义不一致：一个 `remove` 后不置 `isEnabled=false`，另一个置了。同一动作两种后置状态。
5. `TextureCache.loadFile` 首次加载 refCount=1 但**并发/重复加载同一路径的计数语义**依赖调用方成对 release；`SceneManagement.Reduce` 与 `Renderer2DAbility` 的两条释放路径并存，容易出现双重 release。需测试保护。
6. `ScriptEngine` 单脚本单帧 >250 ms 只记告警，无指令数上限（契约 §4 已注明 Phase 2 待办）。
7. `.tmp_*` 与 `.tmp_rel8/` 下有大量历史构建产物（含 chrome profile），未清理；不影响功能，但会干扰"源码搜索"。`verify-apidocs.mjs` 已在 `IGNORE_DIRS` 里排除，处理得当 ✅。
