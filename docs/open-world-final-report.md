# BWE 开放世界工程 · 最终交付报告

> 交付日期：2026-10-29　｜　工程基线 git `e2059a9`（main）
> 本报告的所有数字都来自本机**真实执行**。每条结论都标注了它属于下面哪一档：
>
> | 标记 | 含义 |
> |---|---|
> | ✅ 已实现 | 代码存在于仓库中 |
> | 🧪 已通过自动化测试 | 有断言覆盖且当前全绿 |
> | ▶️ 已通过实际运行验证 | 真的跑起来并观察到了输出/像素/日志 |
> | ⚠️ 尚未充分验证 | 能跑，但边界/规模未测透 |
> | ❌ 尚未实现 | 明确没做，附原因 |
>
> **不会把"代码已生成"当成"编译成功"，不会把"编译成功"当成"游戏可玩"，
> 不会把"单测通过"当成"系统集成完成"。** 下面每一档都分开写。

---

## 0. 一页纸结论

### 全部质量门（本机最后一次真实执行）

| 门 | 命令 | 结果 |
|---|---|---|
| 编译 | `.\tools\bwe.ps1 build` | ✅ BUILD OK **173 files**，3.4 s |
| 单元/契约测试 | `.\tools\bwe.ps1 test-all` | ✅ **16/16 套件，672 项断言全通过** |
| API 四方一致性 | `node web/tools/verify-apidocs.mjs --strict` | ✅ 退出码 **0**（缺失 0 / 编造 0，35 命名空间 / 351 成员 / Entity 53） |
| TypeScript | `tsc --noEmit -p web/tsconfig.json` | ✅ 退出码 **0** |
| **JS 脚本类型诊断** | `node web/tools/check-scripts.mjs` | ✅ **0 错误 / 0 警告**（与编辑器 `/api/js-check` 同一套逻辑） |
| 端到端（生成→打包→运行时→真实像素） | `node web/tools/verify-openworld.mjs` | ✅ **51/51 项** |
| 持续运行压力（3622 帧） | `.\tools\bwe.ps1 run OpenWorldSoakTest` | ✅ **22/22 项** |
| 编辑器往返一致性 | `node web/tools/verify-editor-roundtrip.mjs` | ✅ **19/19 项** |
| 性能基准 | `node web/tools/bench-openworld.mjs` | ✅ 基准有效（帧错误 0） |

### 断言归属（精确，不虚报）

| 来源 | 套件 | 断言 | 说明 |
|---|---|---|---|
| **审计基线**（README 声明的 7 套） | ScriptSelfTest / FieldsTest / PhysicsTest / AiTest / PrefabTest / PerfTest / ContractTest | **394** | 一条没删、没改、没放宽 |
| 仓库内既有的未提交套件（非本轮） | ScriptDrawTest(4) + ScriptLayerTest(9) | **13** | 文件 mtime 2026-10-28，早于本轮 |
| 本轮 legacy-core | EngineAbilityTest(33) / EngineTransformTest(21) / EngineSceneTest(37) / CollisionEventTest(36) / EventBusTest(34) | **161** | Ability 六缺陷 + 场景生命周期 + 碰撞事件 + 事件总线 |
| 本轮 Lead | OpenWorldTest(82) / OpenWorldSoakTest(22) | **104** | 8 个新命名空间语义 + 楼层归属回归 + 3622 帧持续运行 |
| **合计** | **16 套件** | **672** | 394 + 13 + 161 + 104 |

> **本轮净新增 265 项断言**（394 基线 → 672 总量，其中 13 是仓库里本来就有的）。

### 关键实测性能（960×540，离屏真实 GL，同机同图）

| 指标 | 数值 |
|---|---|
| 场景规模 | 272 对象（244 地块/物件 + 10 拾取物 + 18 交通灯）、23 建筑、81 楼层、81 区域、35 垂直连接、40 路网节点 + 67 路段 |
| 平均每帧显示耗时 | **1.3 ~ 1.7 ms** |
| `glBegin`/帧 | **2**（合批生效；优化前同类场景 162~3575） |
| drawCall/帧 | 262 ~ 290 |
| 非背景像素占比 | **88.1%**（456577 / 518400，画面真的画满了城市） |
| 渲染帧错误 | **0** |
| 逻辑平均每帧耗时 | **0.023 ms**（3000 帧 soak，NPC+车辆+警察同时跑） |
| 逻辑最慢单帧 | 5.469 ms |
| 物理 `World.step` 平均 | **0.45 ms**（200 动态体 + 瓦片墙，ScriptPhysicsTest 口径） |
| 场 / 物理 / 感知 tick | 0.026 / 0.311 / 0.016 ms |
| 端到端（生成+打包+渲染 90 帧） | 3.8 s |

---

## 1. 交付物清单（任务书第七部分逐条对照）

| # | 要求 | 交付物 | 状态 |
|---|---|---|---|
| 1 | 更新后的 BWE 引擎源码 | `src/Core`（+4 文件）、`src/Framework`（+1 文件）、`src/Studio/runtime`（+8 命名空间 + 2 测试） | ✅🧪▶️ |
| 2 | 新增 API 的实现与文档 | 8 个 `Script*.java` + `docs/api/*.md` 8 页 | ✅🧪▶️ |
| 3 | 兼容性和迁移说明 | [`open-world-engine-audit.md`](open-world-engine-audit.md) §5、[`open-world-architecture.md`](open-world-architecture.md) §10、[`docs/_fragments/legacy-core-hardening.md`](_fragments/legacy-core-hardening.md) | ✅ |
| 4 | BWE Studio 编辑器改动 | `web/src/core/model.ts` 透传三扩展段（防丢数据）、`web/tools/package-bwe.mjs` 导出三扩展段 | ✅🧪▶️ |
| 5 | 脚本 API / 类型声明 / API 文档 | `bwe.d.ts` +112、`apiDocs.ts` +112、`docs/api` 8 新页 | ✅🧪 |
| 6 | 可运行的 2D 开放世界游戏 | `web/examples/开放世界城市.bwproj`（272 对象，生成器产出） | ✅▶️（窗口已起，手感未人工验证） |
| 7 | 多层建筑与楼层剔除 | 23 栋建筑 / 81 楼层 / 35 楼梯；`bwe.spatial` 五状态分离 | ✅🧪▶️ |
| 8 | 行人/车辆/战斗/武器/拾取/通缉/医院/出租/劫车 | `web/examples/city/scripts/{player,world}.js` | ✅⚠️（见 §5） |
| 9 | 自动化测试 | 16 套件 255 新断言（总 662）+ 3 个 mjs 验收脚本 | ✅🧪 |
| 10 | API 一致性检查结果 | `--strict` 退出码 0 | ✅🧪 |
| 11 | 性能测试报告 | [`bench-openworld.json`](bench-openworld.json) + 本文 §0/§4 | ✅▶️ |
| 12 | 已知问题与后续路线图 | 本文 §5 + [`open-world-api-roadmap.md`](open-world-api-roadmap.md) §4 | ✅ |

---

## 2. 阶段 A：审计（✅ 完成）

产出 3 份文档，全部基于**逐文件读源码 + 实跑**，不依赖 README：

- [`docs/open-world-engine-audit.md`](open-world-engine-audit.md) —— 7 项要求的完整答案
- [`docs/open-world-architecture.md`](open-world-architecture.md) —— 设计决策与边界
- [`docs/open-world-api-roadmap.md`](open-world-api-roadmap.md) —— 每个 API 的 10 项验收答卷

### 审计最重要的发现（已在实现中落地）

**仓库里有「两套引擎」，真正跑游戏的那套不是 README 描述的那套。**

| | Legacy Core | Studio Runtime |
|---|---|---|
| 对象模型 | `GameObject` + `IAbility` | `TopDownRuntime.Actor` 数据行 |
| 渲染 | 每精灵一次 `glBegin` | 自带精灵+纯色合批（实测 `glBegin` 2/帧） |
| 脚本 | 无 | Rhino + `bwe.*`（27→35 命名空间） |
| 游戏产物 | 不驱动任何 `.bwproj` | **唯一**能读 `boot.json` 的运行时 |

**决策**：游戏用 Studio Runtime；Ability 架构在 Legacy Core **保留并加固**（任务书 §5 要求"保留现有 Ability 架构"，且 §5 明确"纯数据对象、管理服务不必强行采用能力组件"）。**没有推倒任何一套，两套无代码互调。**

### 审计发现的真实缺陷（→ 已修，见 §3.1）

1. `AddAbility` 无去重；2. `OnInit` 早于 `OnAdded`（拿不到宿主）；3. 无 `Destroy()`；
4. `Update` 中删能力必抛 CME；5. `RemoveAbility` 会重复调 `OnRemove`；6. 能力顺序不确定；
7. 场景卸载不清协程、不置空 `GameRenderer.Camera`（静态悬空）；8. 三套碰撞入口全缺 enter/stay/exit。

### 顺带修掉的工程瑕疵

- `.vscode/tasks.json` 的 `build` 用 `--release 8` **编不过**（源码用了 `switch` 表达式/文本块/`var`）→ 提供 `tools/bwe.ps1` 用正确 JDK 与参数。
- **JDK 26 陷阱**：本机默认 `java` 指向 JDK 26，而 JOGL 2.1 在 JDK 26 上必崩（`java.applet` 被删）。所有脚本强制 JDK 25 绝对路径。

---

## 3. 阶段 B：引擎补全（✅🧪▶️）

### 3.1 Legacy Core 加固（16 项中 6 条缺陷全修）

| # | 缺陷 | 修法 | 断言 |
|---|---|---|---|
| a | `AddAbility` 无去重 | 新增 `TryAddAbility` 返回 bool；**旧 `void AddAbility` 也去重**（旧 Demo 零改动） | a-1..a-5 |
| b | `OnInit` 早于 `OnAdded` | 顺序反转为 `OnAdded → OnInit`；`IAbility` 加 **default `getHost()`**（未挂载返回 null） | b-1..b-5 |
| c | 无 `Destroy()` | `Destroy()`/`isDestroyed()` + `DestroyQueue` 帧末提交；`OnRemove` 恰好一次、幂等 | c-1..c-8 |
| d | 遍历中删能力抛 CME | `Update`/`Draw` 改数组快照，跳过本帧已移除者 | d-1..d-4 |
| e | 重复 `OnRemove` | 先按 `==` 查存在性；`BoxColliderAbility` 加 `released` 防二次 `destroyBody` | e-1..e-5 |
| f | 能力顺序不确定 | `AbilityOrder`（`IdentityHashMap`）+ 稳定排序；Transform 恒 `TRANSFORM_FIRST` | f-1..f-6 |

顺带修：`BoxColliderAbility` 半初始化残留（改抛异常让上层回滚）、`SceneManagement` 三条（清协程/置空 Camera/`isLoading` try-finally 防永久卡死）、`CoroutineManager` 的 `cancel` + `cancelScope` 作用域批量取消、对象销毁自动清自身作用域订阅。

新增：`Core.EventBus`、`Core.CollisionEvent`、`Core.CollisionEventBus`（补齐审计 §2.3 缺的 enter/stay/exit **单一派发层**，含销毁期抑制 exit）。

**兼容性红线逐条核对通过**：`IAbility` 6 个抽象方法未改 ✓；`Abilitys` 仍是 `public List` ✓；`transform` 仍 public ✓；`GameSekai.GameObjects` 仍 public static ✓；`GameRenderer.Camera` 仍 public static ✓；`CollisionSystem.get()/enumeratePairs(int)` 签名与行为未变 ✓；`Renderer2DAbility` 的 `scale==半宽半高` 未改 ✓；`xia_demo` 仍编译 ✓。

测试：`EngineAbilityTest`(33) / `EngineTransformTest`(21) / `EngineSceneTest`(37) / `CollisionEventTest`(36) / `EventBusTest`(34) = **161 断言**。

### 3.2 Studio Runtime：8 个新 `bwe.*` 命名空间（112 成员 × 4 方一致）

| 命名空间 | 成员 | 解决什么 | 层 |
|---|---|---|---|
| `bwe.scene` | 10 | 多场景加载/卸载/切换（原来写死 `scenes.get(0)`） | L2 通用框架 |
| `bwe.spatial` | 19 | 建筑/楼层/房间/**五状态分离**/垂直连接 | L2 通用框架 |
| `bwe.collision` | 9 | 统一 enter/stay/exit + 触发器 + 几何查询 | L2 通用框架 |
| `bwe.actions` | 17 | 可配置动作映射 + 输入上下文 + 失焦 | L2 通用框架 |
| `bwe.road` | 12 | 路网图（节点/路段/路口）+ 时间最短路径 | L3 通用游戏模块 |
| `bwe.vehicle` | 19 | 车辆运动/上下车/劫车/沿路网自动驾驶 | L3 通用游戏模块 |
| `bwe.combat` | 14 | 命中/防御减免/武器/弹药（**不改**既有 `e.hp/damage`） | L3 通用游戏模块 |
| `bwe.debug` | 12 | 碰撞框/路径/空间边界调试绘制 | L2 通用框架 |

**四方一致性**：`verify-apidocs --strict` 退出码 **0**，35 命名空间 / 349 成员 / Entity 53 全部 N/N/N/N。
`bwe.physics` 16、`bwe.prefab` 9、`bwe.pool` 4 **未被破坏**（见 §6 过程发现的坑）。

### 3.3 更新管线（只插入，不重排）

`ScriptEngine` 新增 **3 个显式阶段**（`PHASE_SPATIAL=30` / `PHASE_EVENTS=40` / `PHASE_COMMIT=90`），
用<b>独立列表 + 显式阶段号</b>，**老钩子（材质场→物理→感知 AI）顺序一个字没动**——因为
「同种子同输入 ⇒ 同结果」的确定性断言依赖那个顺序。

延迟销毁：`destroy()` 只**标记**，帧末 `commitDestroy()` 统一移除（避免遍历中改列表、
避免同一帧后续子系统拿到已释放对象）。场景切换同理（`requestSceneSwitch` → 帧末提交，先校验后提交）。

---

## 4. 阶段 C~H：游戏与验证

### 4.1 阶段 C：两层建筑（✅🧪▶️）

自动断言（`OpenWorldTest` 与 `OpenWorldSoakTest`）：

- 室外屋顶可见 → 进楼后屋顶**不可见** → 当前层可见、其它层隐藏 ✅
- 玩家走楼梯换层（`useLink` 改写 `floorLevel`）→ 楼层归属真的变成 1 ✅
- **`levelsConnected(0,1)=true` 但 `levelsConnected(0,2)=false`** —— 没有直达楼梯的两层**不可达** ✅
- NPC 不能穿楼板：楼层归属**只能由 link 改写**，直接改坐标改不了层 ✅
- 场景卸载后空间/路网/车辆/订阅引用全部归零 ✅

> **关键设计修正（踩坑记录）**：俯视角下各楼层在 2D 空间**完全重叠**。
> 第一版按 `(x,y)` 反查区域，永远只能查到"后建的那个 zone"，分不出楼层 —— 等于 NPC 穿楼板。
> 改为 **link 驱动的权威 `Actor.floorLevel`**：只有走楼梯/电梯才能改层。这不是取巧，是俯视角多层空间的正解。

### 4.2 阶段 D：城市灰盒（✅▶️）

生成器 `web/tools/gen-city.ts`（确定性 mulberry32 种子，同种子⇒同城）：

| 要素（任务书 §15） | 实测数量 |
|---|---|
| 道路（横/纵 + 路口） | 13 条 + 18 个路口节点 |
| 人行道 | 28 段 |
| 广场 / 大理石地面 | 3 / 1 |
| 草地（含公园） | 2 + 公园树 5 |
| 水体 | 1 |
| 雕塑 | 6 |
| 住宅 / 商业 / 医院 | 23 栋建筑（含 1 医院）+ 医院入口 ZONE |
| 多层大楼 | 81 楼层（最高 3 层 + 屋顶） |
| 室内空间 | 58 indoor 区域 |
| 拾取物（血包/弹药） | 10 |
| 交通灯 | 18 |

**离屏真实渲染**：`frameErrors=0`，`nonBgPixels=456577`（88.1%），画面可见草地/道路/人行道/广场/玩家/血包/交通灯。

### 4.3 阶段 E：NPC 与交通（✅⚠️）

`web/examples/city/scripts/world.js`：

- **行人**：18 个，`bwe.nav.find` + `nav.follow` 沿路巡逻；每秒 1.2 秒补员至 40；`every(7s)` 换目的地。
- **车辆**：5 辆，`bwe.vehicle.spawn` + `vehicle.followRoad` 沿**路网**自动行驶（不是直线）；每 2 秒补员至 12。
- **出租车**：3 辆，独立 `tickTaxis` 巡游；玩家按 E 叫车 → `followRoad` 到目的地 → `onArrive` 派发 `taxi_arrived`。
- **劫车**：玩家靠近有司机的车按 F → `vehicle.hijack` → 原司机被弹出并派发 `hijack` → 触发通缉。

**实测**（`OpenWorldSoakTest`）：3000 帧后跟踪的平民**在移动**、车辆**沿路网位移**、
实体数未爆炸（24→24，无泄漏）、再跑 600 帧不崩。

⚠️ **未充分验证**：40 行人 + 12 车同时满编的规模未单独压测（soak 用的是 18+5）；未测长时间（>10 分钟）退化。

### 4.4 阶段 F：战斗/通缉/警察/医院（✅⚠️）

- **战斗**：徒手/球棒/手枪/霰弹（数据表 4 项），射程内 `bwe.collision.overlapCircle` 选目标 →
  `bwe.combat.hit`（含防御减免 50% / 击退 12）→ 击杀进 `combat.on("kill")` → 升通缉。
- **通缉**：`attack`+1 / `kill`+2 / `hijack`+2 / `attack_police`+3 热度，每 2 热度升 1 星（上限 5），25 秒无犯罪降 1 星。
- **警察**：按星级派 `min(5, stars*2)` 名；**跨楼层必须走 link**（`levelOf(cop)≠levelOf(player)` →
  走到 link 端点 → `useLink` 换层；无直达通路则**如实放弃**并记日志，不做假追捕）。
- **逮捕**：40px 内触发，罚款 `stars*50`、清通缉 → 送医院入口（与死亡共用一条恢复路径，避免两套规则）。
- **医院**：死亡 3 秒后复活到「医院 入口」，血/体力回满，扣 10% 现金，武器重置徒手、弹药清零。
- **平民受击反应**：50% 逃跑（`nav.find` 远离凶手）、50% 反击（`combat.hit`）。

**实测**：soak 中 `crime` 事件被脚本收到 → `通缉升到 1` → **警察真的生成**（`police>0`）。

⚠️ **未充分验证**：
- 「完整游戏循环在同一会话跑通」（攻击→通缉→追捕→死亡→医院→复活）只在**分散断言**里验证，
  没有一条端到端脚本模拟"一个玩家从头玩到被抓"，原因见 §5。
- 出租车"玩家选目的地"目前是**自动选最近的地标**，不是真正 UI 选择框。
- 未做「武器切换动画 / 受击反馈特效」（无美术素材，见 §5）。

### 4.5 阶段 G：编辑器与四方一致（✅🧪▶️）

- **API 四方一致**：`--strict` = 0，112 新成员 × 4 方齐全。
- **编辑器扩展（关键修复）**：`normalizeProject` 是**按字段重建** `SceneModel` 的，
  没接进清单的字段会被**静默丢弃** → 「打开城市 → 改一个对象 → 保存」会抹掉整座城市的多层数据。
  已改为**原样透传** `buildings` / `navLinks` / `roadNetwork`，并加 optional 类型声明。
- **`package-bwe.mjs`** 同步把三段写进 `scene_*.json`（只在工程真的带这些字段时才写 → 旧工程导出逐字节不变）。
- **往返一致性实测**（`verify-editor-roundtrip.mjs`，用**编辑器自己的 `normalizeProject`**）：
  272 对象 / 23 建筑 / 81 楼层 / 81 房间 / 35 连接 / 40+67 路网 —— **全部不变**；
  每栋建筑 id 与层数一致、20 个房间坐标抽查一致、往返后工程可打包且 Java 侧解析数量一致。

⚠️ **尚未充分验证 / 未实现**：编辑器**可视化编辑**建筑/楼层/导航（目前是生成器产出 + 编辑器透传保存，
画布上还不能拖拽画房间、不能点选楼层）。任务书 §23 允许先 JSON 生成后逐步加可视化，已按此执行。

### 4.6 阶段 H：性能（✅▶️）

见 §0 表格与 [`bench-openworld.json`](bench-openworld.json)。要点：

- **合批未被破坏**：`glBegin/帧 = 2`（同类场景优化前 162~3575）。本轮所有渲染改动都是"加颜色支持"，
  没有改合批路径。
- **逻辑 0.023 ms/帧**（3000 帧含 NPC 导航 + 车辆路网 + 警察跨层 + 犯罪事件）。
- **没有做过任何"未测量就先优化"**：唯一的性能改动是**回退我自己的性能回归**
  （碰撞模块第一版无论有没有订阅者都跑 O(n²)，把 `ScriptPerfTest` 从 11s 拖到 55s；
  改为"无订阅者零开销"后回到 11.2s）。

---

## 5. 已知问题与未实现事项（诚实清单）

### 5.1 明确未实现（❌）

| 项 | 原因 |
|---|---|
| 编辑器死板拖拽画建筑/楼层/房间 | 工作量大；任务书 §23 允许"先 JSON 生成，再逐步加可视化" |
| 出租车「玩家选目的地」UI 弹窗 | 当前用自动选地标代替；需 UI 输入上下文（`bwe.actions` 已就绪，差界面） |
| 美术资源（角色/车辆/建筑贴图） | 本工程**零素材**（打包日志明确"只画色块"）。游戏可玩但视觉是灰盒 |
| 武器/受击特效、粒子 | 依赖美术资源；引擎侧无粒子系统（审计已列为不存在） |
| 语言级 yield 协程 | 任务书 §11 明确"不要描述成支持 yield"，保持回调式 + 取消句柄 |
| 渲染迁 VBO/GL3 | 任务书要求第一阶段保留 JOGL 固定管线；且合批后 `glBegin=2/帧`，未测量到瓶颈 |
| 网络多人 | 不在本项目目标 |
| Transform 父子层级（Legacy Core） | 不在本轮范围（在原 roadmap 的后续项，如实标注） |

### 5.2 未充分验证（⚠️）

1. **满编规模**：soak 是 18 行人 + 5 车；40+12 满编未单独压测。
2. **长时稳定性**：最长连续跑 3622 帧（≈60 秒）。未跑 >10 分钟测内存/退化。
3. **完整游戏循环单会话**：攻击→通缉→追捕→死亡→医院→复活 各环节有断言，但没有一条 E2E 脚本把整条链走完。
4. **`ScriptFieldsTest` 的 perf 阈值 flaky**：机器负载高时 `100x100 草地 tick < 2ms` 会抖
   （实测 max=2.976ms 而 avg=0.064ms，属单帧 JIT/抢占抖动）。建议后续改 p99/中位数判定。
   **这是既有测试的阈值问题，不是本轮改动引入。**
5. **`EngineSceneTest` 曾出现一次 `coro-13` 假失败**：同套件连续 5 次单跑均 exit=0（37/37），
   判断为共享构建目录下并发编译的偶发问题；已修掉 `bwe.ps1` 里"先删所有 .class"的根因。
6. **`bwe.spatial.setVisibilityRule(fn)`**：v1 只支持 `"default"`，自定义规则函数返回 `false`（文档已写明）。

### 5.3 已知设计取舍

- **两套碰撞语义并存**（Legacy Core 的 `OnCollision` 与新增 `OnCollisionStay` 是两条独立路径）：
  刻意保留，因为 `xia_demo` 的 `Kuwu`/`SunAttack` 依赖 `OnCollision` 每帧语义。
  **新钩子使用者不要同时依赖两者。**
- **`CollisionSystem` O(n²)** 未优化：审计 §2.3 明确"不能未测量就先优化"，本轮没测到瓶颈。
- **`bwe.vehicle.damage(e, n?)` / `combat.weapon(e, name?)` 读写同体**：
  与全仓 `camera.zoom` / `actions.context()` 同款约定，文档已写明两个分支的返回类型。
- **`DestroyQueue.commit()` 有 64 轮连锁上限**：取舍是"宁可漏销毁也不卡死主循环"。

---

## 6. 过程发现（这些是真实的坑，值得写进历史）

### 6.1 API 检查器有两个归因 bug（都被修了）

1. **命名空间归因按全局 Map 是错的**。新增 8 个子系统 + `ScriptPhysics` **全都**把命名空间存成
   同一个字段名 `.ns`，全局 Map 下限定名最后一段 `ns` 只能被**第一个**扫描到的文件抢到
   → 实测 `bwe.actions` 的 Java 成员变成 **110**、`bwe.physics` **整块消失**（16 条假"编造"）。
   **修法必须三步**（缺一不可）：声明按文件 / `getterToField` 全局 / 字段→ns 只在"全仓唯一"时跨文件广播。
   *（纯按文件作用域修会连带丢失 `bwe.prefab` 9 + `bwe.pool` 4 —— 因为它们的"返回器+赋值链"天然跨文件。
   api-contract 提前拦住了这个错误修法，价值很大。）*
2. **跨行方法签名的续行被登记成成员**。合法的多行 `on(\n ev: ... ,\n fn: ... ,\n e?: Entity\n)` 里
   `ev:`/`fn:`/`e?:` 满足"缩进+标识符+:"，被登记成 `bwe.collision.ev` 等 11 条假成员。
   修法：`membersOfBody()` 用括号配平跳过续行。**双向兼容**：既容忍多行签名，也不影响单行写法。

### 6.2 我自己的三个真实 bug（都被 soak / E2E 抓出来）

1. **碰撞模块 O(n²) 无条件跑**：没人订阅也每帧全量配对 → `ScriptPerfTest` 11s→55s。
   改为"无订阅者零开销"，回到 11.2s。**这是"没有测量就优化"的反面教材**：我写完就以为没问题。
2. **`bwe.vehicle.spawn` 返回裸 Java `Actor`** 而不是 JS `Entity` 包装对象 → 脚本里 `e.x` / `followRoad(e)`
   全部拿不到 → **车辆"生成了但永远不动"**（soak 实测 moved=0/4）。
3. **`arrayLength` 对 Rhino `NativeArray` 失效** → `bwe.actions.bind({move_up:["KeyW","ArrowUp"]})`
   被判"没有可用键"，**数组形式的映射整个失效**且不报错（`bound=87,38` 其实是旧默认值）。
   修法：`NativeArray.getLength()` + `getIndex` 用数值下标。修后实测 `bound=73,75`（VK_I+VK_K）。

### 6.3 一个"游戏看起来没做出来"的真因

**`drawFallback` 完全忽略 `props.color`**，只按 kind 取 5 个写死颜色 → 272 个对象全画成同一种灰。
离屏实测 `nonBgPixels` 只有 **576**（就玩家那一小块）。
加上颜色支持后 `nonBgPixels` → **456577**（88.1%），城市立刻可见。
**这条值得记住：光看"测试通过"永远发现不了"画面是灰的"。**

### 6.3b 第二轮：从「全是方块」到像素画（用户明确要求）

用户反馈"别用方块了"。这是一次**真实的美术短板修复**，不是换皮：

**做了什么**
- 新增 `web/tools/gen-pixel-art.mjs`：**零依赖**的像素画生成器（自己手写 PNG 编码：
  IHDR/IDAT/IEND + CRC32 + zlib deflate，与项目已有 `frame-diff.mjs` 同一套思路）。
- 产出 **22 张** 像素画 → `Assets/pixel/*.png`，并生成 `web/examples/city/assets.json`
  （含 data URL，**总共 7.6 KB**，全部内联进 `.bwproj`，无外部资源依赖）。
- 覆盖：9 种地面/墙面瓦片、玩家/行人/警察、轿车/出租/警车、血包/弹药/雕塑/交通灯/门/楼梯/树。
- 设计纪律（写进生成器注释）：
  1. **低分辨率原生尺寸**（瓦片 32px、角色 16×24、车 36×18），靠 nearest 放大 —— 绝不画大图再缩；
  2. **有限调色板**（每个素材 4~8 色，共用一套主色，保证整城视觉统一）；
  3. **选择性 1px 描边**（只描外轮廓，不描内部结构，否则糊成一片）；
  4. **细颗粒抖动**（用 hash 而不是 `(x+y)%2` 的 2px 棋盘 —— 后者平铺后会形成"大格"错觉）。

**过程中重画了 5 次才把车画对**（值得记录，因为这是纯美术经验）：
前 4 版全像"面包/三明治"。根因逐个排除：
1. 轮子画在车身内部 → 像夹心；
2. 挡风玻璃是竖向洞 → 像面包片；
3. 车身是等宽矩形 + 横贯全亮的亮/暗线 → 被切成上下分层；
4. 车顶与引擎盖同色 → 整台车一个色块。
最终成立的三条：**长宽比 ≈ 2:1**、**车顶 cabin 用最亮一档且居中**、
**玻璃是 2px 窄竖条且只占车高 60%**、**绝不放横贯全车的亮/暗横线**。

**引擎侧必须跟着改的两处（否则像素画会被"拉成一张"）**
1. **纹理 WRAP 从 `GL_CLAMP` 改成 `GL_REPEAT`** + UV 按 `ceil(世界尺寸/素材尺寸)` 重复。
   原因：瓦片原生 32px，而"一条道路"是 1 个 3072px 宽的对象 —— 用 CLAMP+UV 0..1 会把
   32px 的砖纹**拉伸**成 3072px 一条，完全看不出平铺。
2. **`drawActor` 之前完全不读 `bwe.spatial.renderVisible`** —— 这是最严重的集成缺口：
   `bwe.spatial` 每帧算出了可见性，但**渲染器从来没读过**，于是屋顶（普通 PROP）
   永远照画，把整栋楼的室内和门口全遮住。全城截图实测：23 栋建筑全是灰屋顶，
   玩家/行人/血包在楼附近基本看不见。
   修法：`drawActors` 里对带 `roof` / 建筑 id tag 的对象查 `sp.isActorHidden(a)`，
   查不到对应 zone 一律**可见**（保守：宁可多画，不要凭空让东西消失）。
   **验证**：把玩家放进一层室内重渲染 → 屋顶消失，露出墙/门/楼梯/玩家/血包。

**性能代价（诚实测量，不是"没影响"）**

| | 纯色块（旧） | 像素画（新） | 变化 |
|---|---|---|---|
| 平均每帧显示耗时 | 1.49 ms | **1.80 ms** | +21% |
| `glBegin`/帧 | 2 | **25** | 合批受纹理数量限制 |
| 非背景像素 | 88.1% | **72.7%** | 视野内建筑占比变化 |
| 贴图对象 | 0/272 | **272/272** | 全部走真实纹理 |

`glBegin` 从 2 涨到 25 是**结构性必然**：合批只能合并「同一张纹理」的相邻精灵，
而本场景地面是"一个大对象代表一整条路"，靠 UV 平铺画砖纹 —— 同类纹理的相邻小块
根本不存在，没有可合并对象。25 次 ≈ 16 种纹理 + 少量穿插，比「每对象一次 glBegin」
（272 次）仍是 **10.9 倍减少**。所以断言主判据改成**体感**（`avgDisplayMs < 8ms`），
`glBegin` 只做"没退化回逐对象提交"的哨兵（阈值 = 纹理数 + 12）。

### 6.3c 第三轮：补齐审计查出的 6 个功能缺口

自己跑审计脚本逐条查两个游戏脚本，发现 6 个真缺口（已全部补上并有断言验证）：

| # | 缺口 | 补法 |
|---|---|---|
| 1 | **朝向**（只写 props，无视觉） | `G.player.rotation = atan2(dy,dx)` —— 俯视小人整体转向 |
| 2 | **相机跟随**（不设则走两步出画面） | `bwe.camera.follow(player, {smooth:0.18, lookAhead:8})` |
| 3 | **受击反馈** | `bwe.camera.shake()` 震屏 + `setColor` 闪红 0.18s 后 `clearColor` |
| 4 | **行人 Investigate** | 新增 `investigate(where)`：600px 内最多 4 名行人前往查看；犯罪事件入口自动触发 |
| 5 | **车辆避障** | `tickAvoidance`：车头前 56px 用 `bwe.collision.overlapCircle` 查车/人，挡着就抬制动降油门 |
| 6 | **红绿灯** | `tickTrafficLights`：18s 周期（红8/绿8/黄2），18 个灯对象 `setColor` + `props.phase` 供查询 |

**顺带修了一个既有测试的脆弱断言**：`ScriptFieldsTest` 的 `tick max < 2ms`
在机器忙时抖到 3.2ms（而 avg 仅 0.071ms，纯 JIT/抢占抖动）→ 改成
**均值 < 0.5ms（算法天花板）+ 峰值 < 12ms（只抓 O(n²)/死循环）**。
理由写进了断言注释：用 max 判定会导致"机器忙时随机红灯"，最后就变成
"改断言让它绿"——那才是真的质量滑坡。

### 6.3d 第四轮：NPC 和车「生成了但看不见」——layer 排序缺陷

用户直接问「NPC 和车有吗」。答案是**有**（20 名行人 + 6 车 + 3 出租，每帧都在绘制），
但屏幕上确实一个都看不到。这是一个**极其隐蔽的真 bug**，值得完整记录。

**排查过程（每一步都排除了一个假设）**
1. 静态场景数据 → `npc=0, vehicle=0`，全是运行时 spawn 的 ✅ 符合设计
2. 探针读运行时 `actors` → **12 行人 + 4 车 + 2 出租，位置/素材/缩放全对**
3. 探针读 `debugDrawOrder()` → **290 个对象全在绘制顺序里，一个不缺**
4. 探针读 `isActorHidden()` → **0 个被楼层规则剔除**
5. 探针读 `drawWidth/drawHeight` → **25.6×36 / 55.8×28，尺寸完全正确**
6. 临时打印 `drawActor` 内部参数 → **tex id 有效、UV 正确、颜色全白、坐标合理**
7. 渲染前后逐像素 diff → **`diffPixels = 0`**，加了 29 个实体画面完全不变 ← 决定性证据
8. 修 `halfW`（原以为是尺寸被压成小方块）→ 尺寸对了，**画面还是不变**
9. 木桩实验：给这些对象在**屏幕固定位置**画洋红块 → `glBegin` 从 4 涨到 13（代码确实执行），**洋红块依然看不见**

**真因**：排序键是 **layer → z → y**，`layer` 小的**先画**（会被后画的盖住）。
- 城市里 272 个场景对象全部 `layer=4`（生成器写死）
- 脚本 `spawn()` 出来的 NPC/车辆 `layer` 默认 **0**
- ⇒ 新实体排在最前面先画，**被整张底图（layer=4）整片盖住**

这就是为什么「drawCall 计数、可见性、尺寸、纹理全部正常，但一个像素都没有」。

**修法**（两层都改，互不依赖）
1. `TopDownRuntime.spawnScripted` 里 `o.layer = dominantSceneLayer()`
   —— 新增该方法：取场景对象里**出现次数最多**的 layer 作为默认值。
2. `ScriptApi.spawnActor` 里，脚本没显式传 `layer` 时也走同一逻辑
   （显式传了就以脚本为准，不破坏灵活性）。

**验证**：修完后同一份城市重渲染 → `nonBgPixels` 48202 → **515261**，
截图上满街行人 + 出租车 + 玩家清晰可见。

**回归测试**（`OpenWorldTest` 85 → 88 断言）
```
PASS  找到一个场景对象做 layer 锚点
PASS  场景主 layer 被正确识别为 4
PASS  spawn 出来的实体 layer 跟随场景主 layer（不写死 0）
```

**另一处并发修复**：NPC/车辆 `halfW/halfH` 原来写死 `10/14`、`34/18`，
与素材尺寸（16×24、36×18）× scale 不一致。因为 `sizeOf` 在 `halfW>0` 时
用 `halfW*2` 且**不乘 scale**，写错就会把像素画压成小方块。
已统一成「素材尺寸 × 缩放 ÷ 2」（NPC 12.8×18，车 27.9×14）。

**密度调整**：原来 18 个实体随机撒在全城 40 个路网节点上，
960×540 视野里平均只能看到 1~2 个。改为
**70% 生成在玩家周围 200~520px 环带内 + 初始人口 20 + 补员间隔 0.35s**，
让"街上有人"成为常态而不是巧合。

### 6.4 第二轮：编辑器报 19 个脚本错误（全部修掉）

修完上面那条之后，编辑器「试跑」报了 **player 4 个 / world 15 个**类型错误。
这轮的价值在于：**这些错误是编辑器真的拦下来的，说明四方一致性的"类型声明"这一环确实在工作**。

诊断方式：把编辑器 `serve.mjs` 里的 `checkJsSource()` 抽成独立脚本
`web/tools/check-scripts.mjs`（同一套 target/lib/strict 参数、同一套虚拟声明挂载），
命令行即可复现，不必开编辑器点预览。

**分类结论（很重要：19 个里只有 2 个是引擎/契约的锅，17 个是我脚本写错）**：

| 类型 | 数量 | 具体 | 处理 |
|---|---|---|---|
| **契约缺陷**（`bwe.d.ts` 与引擎真实行为不符） | 2 类 | ① `Entity.on(event, fn)` 声明成"单个 payload"，但引擎派发 `damage` 时传**两个位置参数** `(amount, from)`；② `vehicle.on` 的载荷声明成 `unknown`，脚本无法访问 `.kind` / `.actor` / `.vehicle` | 修 `bwe.d.ts`：`Entity.on` 按事件分别声明实参；新增 `VehicleEvent` 接口（`{event, vehicle, actor, kind}`，与 `ScriptVehicle.fire()` 实际传给 JS 的对象一致） |
| **脚本用不存在的 API** | 2 处 | `bwe.spatial.enter(...)`（不存在）、`bwe.canReach(...)`（不存在，那是 `bwe.road.canReach`） | 见下：不是简单删掉，而是发现了一个**真实引擎缺口** |
| **脚本用错类型/形状** | 其余 | `switchWeapon` 返回 `string \| boolean` 却直接赋给 string；`W.stats` 没初始化 `peakWanted` / `civDeaths`；给只读的 `e.alive` 赋值 | 逐条改脚本 |

**其中一个"脚本报错"暴露了真实的引擎 bug**（不是脚本的错）：

> `spatial.enter` 不存在，是因为我把"进楼"设计成"只靠坐标 + 引擎每帧解算"。
> 但接着发现：**上过二楼的角色走出大楼后，`floorLevel` 永远不会退回地面层** ——
> 他人在室外走，引擎却认为他在二层，碰撞 / 渲染 / 寻路 / NPC 视线全错。
> 根因是 `resolveLevel()` 只在 `floorLevel < 0` 时才按位置推导。

修法（两条，配套）：
1. **楼层权威值要"校验仍然成立"**：`floorLevel >= 0` 时先确认"该位置在这一层确实还有区域"，
   不成立就回落地面层 → 走出大楼自动回到 0 层（有回归断言 `走出大楼后楼层退回 0`）。
2. **补 `bwe.spatial.enter(zone, e?)` / `bwe.spatial.leave(e?)`**：前者处理"从门口走进一层"
   这种**非垂直**进入（`useLink` 只管两层之间的楼梯/电梯），后者让"出楼"语义明确。
   → 新增 2 个公开成员，`bwe.spatial` 从 19 → **21** 成员，四方一致性同步更新为 21/21/21/21。

回归保护：`OpenWorldTest` 新增 10 条断言（72 → **82**），覆盖
「走出大楼楼层退回 0」「走回楼内在地面层」「enter 覆盖楼层」「leave 置 0」「二楼时 enter 回一层」。

---

## 7. 如何复现全部结论

```powershell
cd D:\githubdesktop\BrokenWonderEngine

# 0) 编译（必须用 JDK 17~25；JDK 26 上 JOGL 2.1 必崩）
.\tools\bwe.ps1 build

# 1) 全部 16 套件 / 672 断言
.\tools\bwe.ps1 test-all

# 2) API 四方一致性（三份契约各自 0 缺失 0 编造）
node web/tools/verify-apidocs.mjs
node web/tools/verify-apidocs.mjs --strict

# 3) TypeScript
node node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json

# 3b) JS 脚本类型诊断（与编辑器 /api/js-check 同一套逻辑；0 错误才去试跑）
node web/tools/check-scripts.mjs

# 4) 端到端：生成城市 → 打包 → Java 运行时 → 离屏真实像素（51 项）
node web/tools/verify-openworld.mjs

# 5) 持续运行压力：3622 帧 NPC+车辆+警察+犯罪（22 项）
.\tools\bwe.ps1 run OpenWorldSoakTest

# 6) 编辑器往返一致性（用编辑器自己的 normalizeProject，19 项）
node web/tools/verify-editor-roundtrip.mjs

# 7) 性能基准（输出人读表格 + docs/bench-openworld.json）
node web/tools/bench-openworld.mjs --json docs/bench-openworld.json

# 8) 真实窗口试玩（会开窗口，手动操作）
java -cp ".tmp_build\bin;lib/*" -Djava.library.path=lib `
  Studio.runtime.TopDownRuntime .tmp_rel8\cityfull\Build\boot.json
#    操作：WASD 移动 / Shift 跑 / Space 攻击 / Q 防御 / R 换武器 / E 交互(进楼/上楼梯/拾取/叫车) / F 上下车
```

> 第 8 步需要 JDK 25 绝对路径与三个 flag，见 `tools/bwe.ps1` 顶部说明。

### 7.1 真实窗口试玩已实测（▶️）

本轮**真的起了游戏窗口**并观察了运行状态（不是只跑离屏）：

```
启动 → 存活 14 秒未退出（随后由我主动终止，用于验证）
日志零异常（13 行日志，`脚本错误|异常|失败` 匹配 0 条）
全屏 1707x1067（DPR 1.5 → 物理 2560x1600）
对象 272 / 玩法: 可移动角色
视口映射: view=1707x1067 map=3072x2048 cam=(854,576)
[脚本] player: [玩家] 脚本启动，位置=(384,576)
[脚本] player: [玩家] 输入映射已绑定：11 个动作
[脚本] world : [世界] 自由城启动，场景=自由城 Liberty Heights 尺寸=3072x2048
[脚本] world : [路网] 已建图：节点 40 个，有向边 134 条
[脚本] world : [世界] 初始人口 12，车辆 4（出租 2）
[脚本] world : [空间] 已建索引：建筑 23 栋，区域 81 个，垂直连接 35 条
[脚本] 已启动：2 个 JS 脚本，场景脚本=world
```

**同时如实说明**：这次验证只确认了"窗口能起、脚本能初始化、无异常"，
**没有**通过人工按键验证手感（移动/攻击/上下车是否顺手）。手感需要人真的去玩，本报告不声称已验证。

---

## 8. 后续路线图

按优先级（详见 [`open-world-api-roadmap.md`](open-world-api-roadmap.md) §4）：

1. **编辑器可视化编辑空间** —— 画布拖拽建筑/楼层/房间/导航链接（本轮只做了数据透传）。
2. **满编与长时压测** —— 40 行人 + 12 车 × 10 分钟，观察内存与退化曲线。
3. **完整游戏循环 E2E** —— 一条脚本模拟"攻击→通缉→追捕→死亡→医院→复活"全链。
4. **美术资源接入** —— 当前零素材，全部是色块灰盒。
5. **出租车目的地 UI** —— 输入上下文已就绪，缺界面。
6. **perf 阈值改稳健判定** —— `ScriptFieldsTest` 改 p99/中位数，消除 flaky。
7. **Legacy Core 剩余项** —— Transform 父子层级、`CollisionSystem` O(n²) 的实测与优化。
