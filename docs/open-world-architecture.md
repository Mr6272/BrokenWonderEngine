# BWE 开放世界架构设计

> 配套：[`open-world-engine-audit.md`](open-world-engine-audit.md)（事实与证据）、[`open-world-api-roadmap.md`](open-world-api-roadmap.md)（排期与验收）。
> 本文只讲**设计决策与边界**。所有"现状"结论以审计报告为准。

---

## 1. 最重要的架构决策：两套运行时，各司其职

审计发现仓库里有两套互不调用的引擎（见审计 §0）。本项目的决策是**双轨承接**，而不是合并：

```
┌────────────────────────────────────────────────────────────────┐
│  BWE Studio Runtime（游戏主战场）                                │
│                                                                 │
│  .bwproj ──packageBwe.ts──> Build/boot.json + Build/scripts/*.js│
│       │                            │                            │
│       │                            ▼                            │
│       │                 Studio.runtime.TopDownRuntime           │
│       │                   ├ Actor（实体，纯字段）                │
│       │                   ├ Viewport（世界↔屏幕唯一换算）        │
│       │                   ├ 精灵合批 / 纯色合批（已优化）         │
│       │                   └ ScriptEngine（Rhino，bwe.* 命名空间）│
│       │                         ├ ScriptApi    （bwe 根 + Entity）│
│       │                         ├ ScriptWorld  （grid/tilemap/nav）│
│       │                         ├ ScriptPrefab （prefab/pool）    │
│       │                         ├ ScriptPhysics（jbox2d 桥）      │
│       │                         ├ ScriptFields / ScriptAi         │
│       │                         └ ★ 本轮新增：scene/spatial/       │
│       │                            collision/actions/road/vehicle/ │
│       │                            combat                          │
│       ▼                                                          │
│  BWE Studio（Web 编辑器，ts）── 编辑 .bwproj / 预览 / 打包         │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  Legacy Core（旧核心，保持可跑、按需加固，不承接游戏）             │
│  Core.GameSekai / Framework.GameObject + IAbility /  UI / …      │
│  唯一职责：UserUsage.xia_demo 等历史 Demo 不回归；                │
│            作为"能力组件生命周期"的参考实现与测试对象。             │
│  ★ 本轮加固：Ability 生命周期、Destroy、Transform 父子、事件总线、(输入/物理…)│
└────────────────────────────────────────────────────────────────┘

              （两套之间：无代码互调，只共享 lib/ 依赖）
```

**为什么不在旧核心上做游戏**（证据）：
1. `.bwproj` 编辑器只输出 `boot.json`，只有 Studio Runtime 读它（`GameData.load`）。
2. 旧核心的渲染是每精灵一次 `glBegin`（`Renderer2DAbility`），Studio 侧已有合批（`glBegin` 162→7）。
3. 旧核心无脚本层；Studio 有 27 个命名空间 271 成员的 `bwe.*`。
4. 旧核心的 O(n²) `CollisionSystem` 无法承载开放世界。

**为什么不把 Studio Runtime 改成 Ability 架构**（任务书要求保留 Ability）：
- Ability 架构的参考实现已在旧核心，且有 `UserUsage` 3 个真实使用方与测试。要"保留"，就保留那套。
- Studio Runtime 的 `Actor` 是**数据行**（编辑器导出的对象），不是组合体；强行套 Ability 会同时破坏 97 项 Prefab 断言和 `boot.json` 契约。
- 任务书 §5 明确："纯数据对象、管理服务和全局资源缓存不必强行采用能力组件。"

**结论**：Ability 架构**在旧核心保留并加固**（满足"保留现有 Ability 架构"）；游戏用 Studio Runtime 的实体+脚本模型（满足"不要为玩家单独创建绕开引擎核心的另一套对象系统"——因为 Studio Runtime 就是编辑器与导出器的官方运行时，玩家对象就是普通 Actor + 普通脚本，没有绕开任何东西）。

---

## 2. 分层原则（任务书 §4）

新 API 一律先回答"我属于哪一层"，再决定放哪：

| 层 | 判定标准 | 落地位置 | 例子 |
|---|---|---|---|
| L1 引擎核心 | 与具体游戏无关，任何 2D 游戏都要用；改变它会影响其他游戏 | `src/Core`、`src/Framework`（旧核心） | 对象销毁、Transform 父子、碰撞事件语义、时间服务 |
| L1' 运行时核心 | 同上，但服务于 `boot.json` 驱动的 Studio 游戏 | `src/Studio/runtime`（Java，不暴露脚本） | 场景切换执行器、空间分区、楼层可见性求解、A\* 的楼层维度 |
| L2 通用游戏框架 | 只是"俯视角 2D 游戏"通用，但不限某个游戏 | `bwe.*` 命名空间（脚本可见） | `bwe.scene`、`bwe.spatial`、`bwe.collision`、`bwe.actions`、`bwe.road`、`bwe.vehicle`、`bwe.combat` |
| L3 通用游戏模块 | 有明确玩法语义，换个游戏可能换实现 | `bwe.*` 但文档标注"可替换" | `bwe.vehicle`（街机手感 vs 真实物理）|
| L4 游戏专属 | 只有本游戏需要 | **只放游戏脚本/数据**，永不进引擎 | 通缉等级、犯罪记录、警察状态机、医院规则、出租车计价 |

**红线**：`wanted`、`犯罪`、`警察追捕`、`医院`、`出租车目的地` 这些词**不允许**出现在 `src/Core`、`src/Framework`、`src/Studio/runtime` 的非注释代码里。

---

## 3. 更新管线（任务书 §7）

### 3.1 Studio Runtime 现状（已核实）

`ScriptEngine.tick(cx, rawDt)`：键盘快照 → 帧号 → dt 钳制 → `paused/timeScale` → 点击/按键派发 → 清绘制列表 → `fireTimers` → 全局 `update` 回调 → 对象脚本 `onUpdate` → `processZones` → `world.tick`（路径跟随）→ `simHooks`（fields → physics → ai）→ `updateAttachments` → `updateCamera` → `applyFrameLocks` → 微任务。

`TopDownRuntime.display()`：算真实 dt（钳制 [0.0001, 0.1]）→ `uploadTextures` → 画地图 → `update(dt)`（player → modules → camera）→ 排序 → 画 actor → HUD。

### 3.2 目标管线（本轮补 3 个阶段，其余保持）

```
① 输入采样            keys[] 快照 + 边沿 + 鼠标 + ★ 动作映射/上下文
② 游戏逻辑更新        全局 update → 对象 onUpdate → world.tick → simHooks
③ ★ 空间归属解析      spatial: 谁在哪层/哪个房间（玩家、NPC、车）
④ 物理状态同步        ★ 碰撞事件收集（enter/stay/exit）→ 派发
⑤ 定时任务 / 协程     after/every/cancel + ★ 作用域清理
⑥ ★ 延迟提交          destroy 队列、场景切换队列、空间引用清理
⑦ 渲染               ▲ 真实帧时间（不固定步长）；相机；Y 排序；合批；HUD
```

**改动纪律**：
- **不重排已有顺序**，只在既有钩子点之间**插入**新阶段（②之后插 ③，④内部插事件派发，⑥放在帧末）。
- 逻辑与物理继续用固定步长（Studio 侧 `dt` 钳制到 0.1，物理内部 1/60 累计）。
- 渲染用真实帧时间，不插值（现有实现如此，且 60 fps 下无收益；如要做，必须先用 `OffscreenFrameDump` 证明不改变静止画面）。
- 掉帧保护已有（`ScriptEngine` dt ≤ 0.1；`ScriptPhysics` `MAX_ACCUM=0.25` / `MAX_STEPS=6`）。**保持不变**。

### 3.3 延迟销毁语义（新增，必须严格）

`e.destroy()` 现状（`TopDownRuntime.destroyActor`）是即刻移除 `actors` 并把 `dead=true`。
本轮扩展为：**标记 → 帧末统一提交**。理由：`onUpdate` 遍历中删对象、碰撞回调里删对象都必须安全。

规则：
1. `destroy(e)` → 置 `dead=true`，加入 `pendingDestroy`（同帧不真正移除）。
2. 帧末 `commitDestroy()`：从 `actors` 移除 → 清 GPU 纹理引用 → 清 physics 刚体 → 清 `bound` 脚本作用域 → 清计时器/事件订阅作用域 → 清空间归属 → 清 prefab/pool 记录。
3. 已 `dead` 的实体：不再 `onUpdate`、不再派发事件、不再参与碰撞、不再绘制。
4. **幂等**：重复 `destroy` 无副作用。

---

## 4. 碰撞事件架构（任务书 §9，关键）

### 4.1 问题

三套并存且都缺 enter/stay/exit（审计 §2.3）。且旧核心 `CollisionSystem.overlaps()` 内部又扫 JBox2D `ContactEdge` = 重复计算。

### 4.2 设计：单一事实来源 + 单一派发层

```
        ┌──────────────────────────────────────────┐
        │  JBox2D World（唯一物理模拟）             │
        │  ContactListener.begin/endContact        │
        └───────────────┬──────────────────────────┘
                        │ 接触变更（存活/消失）
                        ▼
        ┌──────────────────────────────────────────┐
        │  CollisionEventBus（新增，唯一派发点）    │
        │  · 维护 pair → state 表                   │
        │  · 每 tick 结束统一计算：                 │
        │     新增 pair  → onCollisionEnter/TriggerEnter
        │     仍在 pair  → onCollisionStay / TriggerStay
        │     消失 pair  → onCollisionExit / TriggerExit
        │  · 过滤：layer / mask / sensor 区分       │
        │  · 去重：同一 pair 同一帧最多一次         │
        │  · 抑制：任一方 dead → 不派发（也不产生 exit）
        └───────────────┬──────────────────────────┘
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
   脚本层 bwe.collision.*        旧核心 GameObject.OnCollision*
```

**约束**：
- `CollisionSystem`（旧核心 O(n²) 配对）**保留但降级**：只服务于没开 JBox2D 的旧 Demo，且 `overlaps()` 改为读缓存的接触状态，不再每次扫 `ContactEdge`。
- Studio 侧 `ScriptPhysics` 的 `on("collision")` **保留兼容**（现有 47 项断言依赖它），但其内部改为从 `CollisionEventBus` 转发，**不新增第二个 beginContact 消费者**。
- "区域检测"（不需要真实物理）：走 `bwe.collision.query` / `overlapCircle` / `overlapRect`，明确文档写明"这是查询，不是物理接触"。

### 4.3 事件契约（写进 `docs/api`）

| 事件 | 时机 | 次数 | 载荷 |
|---|---|---|---|
| `enter` | 上一 tick 无接触、本 tick 有 | 每对一次 | `{self, other, sensor, normal, point}` |
| `stay` | 连续两 tick 都有接触 | 每 tick一次 | 同上（normal/point 可能为 null）|
| `exit` | 上一 tick 有、本 tick 无 | 每对一次 | `{self, other, sensor}` |
| 触发器 | sensor=true 时用 `triggerEnter/Stay/Exit` | 同上 | 同上 |

**边界行为（必须测试）**：
- 对象在重叠中被 `destroy()` → **不派发 exit**（对方也不知道），但内部状态要清掉，防止后续误派发。
- 同一对物体一帧内 enter+exit（快速擦过）→ 若在同一 tick 内，按"净效果"处理：不派发（或 enter+exit 各一次，需选定一种并写成文档 + 测试）。**选定：各派发一次，顺序 enter → exit**，因为脚本可能要播放音效。
- 传感器 vs 实体：sensor 与 sensor 相交 → 双方都收 trigger 事件；sensor vs solid → sensor 方收 trigger，solid 方收 collision。

---

## 5. 空间与多层建筑架构（任务书 §14，最大新增）

### 5.1 五状态分离（硬要求）

任务书明确"不能用单一 `visible` 字段代替"。设计：

```
SpatialZone（区域基类）
  id            唯一
  kind          building | floor | room | corridor | outdoors | link
  buildingId    所属建筑
  floorId       所属楼层
  bounds        AABB（世界像素）
  tags          []
  ┌── 5 个独立状态 ──────────────────────────────┐
  │ renderVisible   bool   渲染可见性（含屋顶/墙段剔除）│
  │ collisionEnabled bool  碰撞启用                  │
  │ navPassable      bool  导航可达                  │
  │  （玩家归属 / NPC 归属 是"运行时解析结果"，不是字段）│
  └──────────────────────────────────────────────┘
  entrances     [{x,y,kind:door|stairs|elevator, target}]
  links         指向其它 zone（同层门 / 跨层楼梯电梯）
```

- **玩家归属** `playerZoneId`、**NPC 归属** `npcZoneId` 是**求解器的输出**，存在运行时状态里，不写进 zone 数据。
- 五状态由 `SpatialResolver` 每帧按规则计算：

```
for zone in activeZones:
    zone.renderVisible  = rule(zone, playerFloor, playerBuilding, occluders)
    zone.collisionEnabled = (zone.floorId == playerFloor) or zone.alwaysSolidCollide
    zone.navPassable    = (zone.floorId == agentFloor)   ← 按 agent 分别算
```

### 5.2 楼层可见性规则

| 情形 | 屋顶 | 当前层 | 其他层 | 墙段 |
|---|---|---|---|---|
| 玩家在室外 | 显示 | — | 隐藏 | 显示（建筑外轮廓）|
| 玩家在本楼某层 | 隐藏 | 显示 | 隐藏 | 只显示遮挡玩家的墙段（可选裁剪）|
| 玩家在楼外但在本建筑 zone | 隐藏 | 显示 | 隐藏 | 显示 |

实现：`VisibilityRule` 是可替换的接口（默认三条规则），不要硬编码在渲染器里。
渲染侧只读结果（`renderVisible`），**不自己判断楼层**。

### 5.3 垂直连接

```
VerticalLink {
  id, kind: stairs | elevator | ramp | jumpdown,
  fromZoneId, toZoneId,
  fromPoint, toPoint,
  bidirectional,
  travelTime,       // 电梯/楼梯耗时（可 0）
  requiresInteract  // 电梯要按键，楼梯走路就过
}
```

- **导航**：`NavigationQuery.findPath` 的图必须含 link 边，权重 = 欧氏距离 + `travelTime × speed`。
- **硬约束**：没有 link 的两层之间，寻路必须返回"不可达"。这是任务书验收项，必须有断言。

### 5.4 场景卸载清理

`unloadScene()` 必须把以下全部归零（每条一个断言）：
`zones` / `links` / `buildings` / `navGraph` / `collisionPairs` / `physics bodies` / `timer 作用域` / `event 订阅作用域` / `prefab 实例表` / `Actor` 列表 / `Camera` 引用 / `bound` 脚本表。

---

## 6. 导航架构（任务书 §13）

### 6.1 职责分离（严格按任务书）

| 组件 | 职责 | **不做** |
|---|---|---|
| `NavigationGrid` | 每层的可通行位图 + 阻挡写入（tilemap/solid/动态障碍） | 不做搜索 |
| `NavigationGraph` | 节点 + 边（含 link 边），供跨层/路网用 | 不做搜索 |
| `NavigationQuery` | A\* / 最近点 / 可达性；**纯计算，无状态副作用** | 不移动任何东西 |
| `NavigationAgent2D` | 持有路径、按速度跟随、到达回调、卡住检测/重算 | 不算路径 |
| `NavigationLink` | 跨层/跨区连接边 | — |

**禁令**：NPC 移动脚本里**不许出现 A\* 或格子搜索**；A\* 里**不许出现移动代码**。

### 6.2 与现有实现的衔接

现有 `ScriptWorld.findPath` 已是一个**正确的** A\*（八方向、octile 启发、不切角、maxNodes 上限、抽稀）。
本轮**不重写**它，而是：
1. 抽出纯函数 `NavigationQuery`（保留 `bwe.nav.find` 签名与语义，47→51 项断言不变）。
2. 在其上**增加楼层维度**：`findPath(layer, ...)`，`solidCell` 按层查。
3. `NavigationAgent2D` 承接现有 `ScriptWorld.Follow`（把 `Follow` 类升级为 agent，保持 `bwe.nav.follow/stop` 不变）。

### 6.3 路径缓存与失效

- 缓存 key = `(fromCell, toCell, layer, navVersion)`；`navVersion` 在阻挡变更时自增。
- **动态障碍**：`setSolid` 触发 `navVersion++`；正在跟随的 agent 下一帧检测到版本变化 → 重算（有重算次数上限，防抖）。
- **不可达**：`find` 返回空数组（现有语义），`bwe.nav.findPath` 新增 `ok` 字段的包装？——**不改现有返回类型**（4 个 `bwe.nav` 成员签名不许动），改为新增 `bwe.nav.canReach(a, b)` 布尔 API。

---

## 7. 车辆与路网（任务书 §18）

```
RoadNetwork（数据，来自关卡 JSON / 生成器）
  nodes: [{id, x, y, kind: intersection|waypoint|stop}]
  edges: [{from, to, width, lanes, speedLimit, oneway}]
  intersections: [{nodeId, turnRules}]

VehicleController（通用模块，脚本可见 bwe.vehicle）
  throttle / brake / steer 输入
  沿 route 的 航点跟随（和行人共用 NavigationAgent2D，但用不同的 config：
   行人：窄、可直接穿小路、速度 40~90 px/s
   车辆：宽、只能走路网、速度 200~400 px/s、需要转弯半径）
```

**关键**：车辆**不用**瓦片 A\*，用**路网图**（任务书 §18 明确"不能只让车辆沿固定直线移动"）。
行人与车辆共用 `NavigationAgent2D`，但注入不同 `NavConfig`。

---

## 8. 战斗（任务书 §19）

```
bwe.combat
  hit({from, to, amount, damageType, knockback, ignoreDefense})  → result
  damage(e, amount, opts)                                        → result   ← 已有 Entity.damage，保持
  defend(e, on/off) / defending(e)
  weapon(e, def) / switchWeapon(e) / weaponOf(e)
  params 全部数据驱动（武器表、NPC 类型表放 boot.json 的 data 段）
```

**禁止**：武器脚本里直接操作 GL / JBox2D 内部。只通过 `query` / `damage` / `input` / `events`。

**注意**：`e.damage(n)` / `e.hp` / `e.hpMax` 已存在且被 97+109+19 项断言覆盖 → **不改**，`bwe.combat.hit` 作为上层组合（走防御、走击退、走事件）。

---

## 9. 编辑器数据扩展（任务书 §23）

只做**加法**，旧工程必须仍能打开：

```jsonc
// .bwproj，format 仍为 1（新增字段全部 optional）
{
  "format": 1,
  "scenes": [{
    "objects": [...],
    // ★ 新增：可选
    "buildings": [{ "id","name","floors":[{"id","z","rooms":[{...}]}],"entrances":[...] }],
    "navLinks":  [{ "id","kind","from","to" }],
    "roadNetwork": { "nodes":[], "edges":[] }
  }]
}
```

- `normalizeProject` 补缺省空数组（已有该函数的模式）。
- `packageBwe.ts` 把这些段原样写进 `boot.json` 的新顶层 key。
- `GameData.load` 缺省为 null → 运行时"没有空间数据"= 单层平地，行为与今天完全一致（**兼容性保证**）。
- `verify-mapping.mjs` / `verify-apidocs.mjs` 扩充检查。

---

## 10. 兼容性策略（任务书 §3）

| 对象 | 策略 |
|---|---|
| 旧 Demo（`xia_demo`、`FightMengpo`） | 编译+运行不变；`IAbility` 签名不动；`MainWindow` 不变 |
| 7 个测试类 394 断言 | **一个都不改，只增不减**。新增测试另起文件 |
| `boot.json` | 只加字段；读取侧全部 null 兜底；旧 `boot.json` 必须仍能跑 |
| `.bwproj` | 同上；`normalizeProject` 补缺省 |
| `bwe.*` 271 成员 | 只加不改；四方一致性必须 0 缺失 0 编造 |
| 渲染像素 | 任何渲染改动必须 `OffscreenFrameDump` 前后 diff = 0（静止场景）|
| 性能优化 | 只做测量证明的瓶颈；每次改动记录前后数字 |

---

## 11. 测试架构

```
自动化测试金字塔（全部 headless 可跑，无需窗口）

单元/断言层（Java main-style，与现有 7 套同格式）
  ScriptSelfTest  ScriptFieldsTest  ScriptPhysicsTest  ScriptAiTest
  ScriptPrefabTest  ScriptPerfTest  ScriptContractTest        ← 现有 394，不动
  ★ EngineAbilityTest        Ability 生命周期 6 条缺陷
  ★ EngineSceneTest          场景生命周期/卸载清理
  ★ CollisionEventTest       enter/stay/exit + 边界（销毁期、擦过、sensor）
  ★ NavigationFloorTest      A* 正确性、楼层隔离、link 必需、不可达
  ★ SpatialBuildingTest      五状态分离、屋顶剔除、楼层切换
  ★ InputActionTest          动作映射、上下文、失焦
  ★ TimerScopeTest           取消、暂停、场景清理
  ★ RuntimeContractTest      新 bwe.* 成员的四方一致

E2E 层（.bwproj → build → 离屏 GL 渲染 / 脚本驱动）
  ★ OpenWorldE2ETest        城市加载、玩家移动、NPC 导航、车辆、战斗、通缉…
  OffscreenFrameDump       像素回归（已有）
```

**新增测试必须能在 CI 里 3 分钟内跑完**；耗时的用 `perf` 开关门控。

---

## 12. 本轮不做（明确记录，防止无限扩张）

| 不做 | 原因 |
|---|---|
| 渲染后端从 JOGL 固定管线迁到 VBO/GL3 | 任务书要求第一阶段保留；且当前合批后 `glBegin` 已降到 7~20/帧，未测量到瓶颈 |
| 把 Studio Runtime 重写成 Ability 架构 | 破坏导出契约与 97 项断言；Ability 已在旧核心保留 |
| 合并两套引擎 | 任务书禁止推倒重写；合并无收益、风险极高 |
| 语言级 yield 协程 | 任务书明确"不要描述成支持 yield"；保持回调式 + 取消句柄 |
| Y 排序批处理兼容优化 | 需先测量；当前 sort 后仍合批，未证伪 |
| 3D / 网络多人 | 不在本次目标 |
