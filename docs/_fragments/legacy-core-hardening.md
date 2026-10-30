# 旧核心加固（Legacy Core Hardening）— 交付说明

> 对应任务板 `task-1`、审计 [`open-world-engine-audit.md`](../open-world-engine-audit.md) §2.1 / §2.2 / §2.3、
> 架构 [`open-world-architecture.md`](../open-world-architecture.md) §3.3 / §4。
> 范围：`src/Core`、`src/Framework`、`src/Tool`、`src/TypeStructure` + 5 个新测试类。
> 不触碰 `src/Studio/runtime` 下任何已有文件（并行开发中的其它任务负责）。

## 1. 六条 Ability 缺陷的修法与权衡

| # | 缺陷（审计 §2.1） | 修法 | 权衡 / 兼容性 |
|---|---|---|---|
| **a** | `AddAbility` 无去重，同一实例可重复添加 | 新增 `boolean TryAddAbility(IAbility)`；旧的 `void AddAbility` 保留，内部转发并**同样去重** | 旧调用方（`Xia`/`Kuwu`/`SunAttack` 用 `AddAbility`）零改动；但"重复添加"从静默生效变成静默忽略——这是有意的行为修正，旧的重复添加本来就是 bug |
| **b** | `OnInit()` 在 `OnAdded()` **之前**调用，OnInit 里 `gameObject` 还是 null | 顺序改为 `OnAdded(host)` → `OnInit()`；同时在 `IAbility` 上新增 **default** 方法 `getHost()`（未挂载返回 null），4 个内建能力都覆盖了它 | `IAbility` 的 6 个抽象方法签名一个没动（红线）；`getHost()` 是 default，旧实现类不实现也能编译。**语义变化**：若某个旧实现在 `OnInit()` 里做了依赖"此时还没有宿主"的事，现在会看到宿主——本仓库里没有这种实现，已核实 4 个内建类 + 3 个 Demo 实现 |
| **c** | `GameObject` 无 `Destroy()` | 新增 `Destroy()` / `isDestroyed()` / `CommitDestroy()` + `Core.destroy.DestroyQueue`（帧末统一提交，幂等）。提交时逐个能力 `OnRemove()` 恰好一次并清空能力列表 | 延迟销毁保证"OnUpdate 遍历中销毁自己"安全。`GameSekai.fixedUpdate` 末尾与 `Update()` 末尾都会 `commit()`；`DestroyQueue` 有 64 轮连锁上限，防止销毁回调里死循环造对象卡死主循环 |
| **d** | `Update()` 直接 `for (IAbility : Abilitys)`，能力在 `OnUpdate` 里 `RemoveAbility` 必抛 `ConcurrentModificationException` | `Update()` / `Draw()` 改为 **数组快照迭代**，并跳过"本帧已被移除"的能力 | 语义明确：本帧被移除的能力**不再**收到本帧剩余的 `OnUpdate`（否则会拿到半销毁状态）。`Draw` 仍是倒序，保持原绘制层级行为 |
| **e** | `RemoveAbility` 对不在列表里的对象也调 `OnRemove()`（重复回调） | 先按**对象同一性**查下标，不在列表直接 `return false` 且不回调；`RemoveAbilityByIndex` 越界安全返回 | 用 `==` 不用 `equals`，避免用户自定义 `equals` 的能力互相误伤。`BoxColliderAbility.OnRemove` 另加了 `released` 标志，保证物理体只 `destroyBody` 一次 |
| **f** | 能力执行顺序依赖插入顺序，无显式 order | 新增 `Framework.AbilityOrder`（`IdentityHashMap` 存 order，不占 `IAbility` 状态）+ `GameObject.SetAbilityOrder` / `GetAbilityOrder`；`Collections.sort` **稳定排序**，同 order 保持加入顺序；`TransformAbility` 恒为 `AbilityOrder.TRANSFORM_FIRST`（-1000），`SetAbilityOrder` 无法把它排后 | 为什么不把 order 放 `IAbility`：接口不能持有状态，且加字段会破坏实现类。为什么用 `IdentityHashMap`：不依赖用户的 `equals/hashCode`。`RemoveAbility`/`CommitDestroy` 会 `forget()` 条目，避免强引用泄漏 |

## 2. 顺带修的审计条目（§2.1 第 3 行、§2.2）

- `BoxColliderAbility.OnAdded` 找不到 `TransformAbility` 时原来"打印后 return"，把**半初始化能力留在列表里**。现改为抛 `IllegalStateException`，由 `TryAddAbility` 回滚（能力不入列表、order 条目清除）。注释里写明了原因。
- `SceneManagement.Reduce` 加固（审计 §2.2 三条全中）：
  1. 清空 `coroutineManager`（旧场景协程不再串到新场景）；
  2. `GameRenderer.Camera = null`（消除静态悬空引用）；
  3. `isLoading` 改 `try/finally`，`scene.build` 抛异常不再永久卡死场景切换；
  4. 新增 `unloadCurrentScene()`（可单独调用），统一走 `Destroy()` + `DestroyQueue.commit()`，**不再手工拼三份 `OnRemove + unregister + DeleteTexture`**；
  5. 清 `CollisionEventBus` 配对状态（防跨场景误派发 exit）与 `EventBus` 场景作用域订阅；清 `DestroyQueue`。
- `CoroutineManager`：快照迭代 + 延迟启动（`start` 的协程下一帧才跑）+ `cancel()` / `cancelScope(scope)` / `size()` / `sizeOfScope()` / `isEmpty()`；单个协程抛异常只记日志并摘除，不会每帧重复抛。
- `Coroutine`：只加两个 **default** 方法（`isCancelled()` / `scope()`），`update()` 抽象方法不动。
- `GameObject.CommitDestroy()` 在清空能力后调用 `EventBus.clearScope(this)`：**对象销毁自动摘掉以自身为作用域的全部事件订阅**，这就是任务书 §11「不产生无约束全局依赖」/审计 §3 第 7 条「场景卸载后悬空回调」的落地点。
- `TransformAbility.SetEnable` 原来是空实现（永远 `true`），改为真正写入 `enable`。
- `CameraAbility.OnUpdate` 对 `playerTransform`/`transform` 为 null 时不再 NPE。

## 3. 新增的碰撞事件语义（审计 §2.3，架构 §4）

- `Core.CollisionEvent`：`ENTER` / `STAY` / `EXIT` + `sensor` 区分 + 载荷（`self`/`other`/`normal`/`point`）。
- `Core.CollisionEventBus`：**单一派发层**。`beginTick()` → `reportPair(a,b,sensor)` → `endTick()` 统一算 enter/stay/exit。
  契约已写成测试：enter 每对一次、stay 每 tick 一次、exit 每对一次、同 tick 去重、
  任一方销毁则不派发**且不产生 exit**、双方各收一次、`forgetObject` 可定向摘除。
- `GameObject` 新增 `OnCollisionEnter` / `OnCollisionStay` / `OnCollisionExit` 三个空实现钩子（旧 `OnCollision` 语义与时机**完全不变**）。
- `CollisionSystem.update()` 内部把配对结果同时喂给总线；`get()` 与 `enumeratePairs(int)` 的静态签名与行为一字未改。

## 4. 新增 `Core.EventBus`（作用域化事件）

审计 §3 第 7 条「场景卸载后悬空回调」的地基：订阅必须挂作用域 key，`clearScope(scope)` 一次摘掉整组；
派发用快照，回调里订阅/退订安全；单监听器异常不中断其它监听器；重复订阅幂等。
场景卸载清的是 `SceneManagement.SCENE_SCOPE`。

## 5. 测试

全部放在 `src/Studio/runtime/`（包名 `Studio.runtime`），这样 `tools/bwe.ps1 test-all` 自动发现。
格式与 `ScriptSelfTest` 一致：`main` 风格、`check(String, boolean, String)` 累加、末行
`共 N 项，通过 N，失败 0 → ALL PASS`、`System.exit(failures==0?0:1)`。

| 测试类 | 断言数 | 覆盖 |
|---|---|---|
| `EngineAbilityTest` | 33 | a/b/c/d/e/f 六条缺陷，断言名带编号 |
| `CollisionEventTest` | 36 | enter/stay/exit、同 tick 去重、销毁抑制、sensor、forgetObject、作用域清理 |
| `EngineSceneTest` | 37 | 场景卸载清协程/相机/碰撞状态/作用域、build 异常后 isLoading 复位、OnRemove 一次、协程 cancel + `cancelScope` 按作用域批量取消、销毁队列连锁 |
| `EngineTransformTest` | 21 | Transform 自动创建/order/宿主/scale 语义（兼容性红线）/启用开关/销毁后 |
| `EventBusTest` | 34 | 订阅/派发/幂等/退订/clearScope/派发期修改/监听器异常/对象销毁自动清自身作用域订阅 |

合计 **161 项新增断言**。每一条缺陷都有"加固前会失败"的断言，对应关系直接写在测试类 Javadoc 与断言名前缀里。

### 实测输出（15 套件，race-free 私有输出目录）

```
ScriptSelfTest        exit=0  共 109 项，通过 109，失败 0 → ALL PASS
ScriptFieldsTest      exit=0  共  43 项，通过  43，失败 0 → ALL PASS
ScriptPhysicsTest     exit=0  共  47 项，通过  47，失败 0 → ALL PASS
ScriptAiTest          exit=0  共  51 项，通过  51，失败 0 → ALL PASS
ScriptPrefabTest      exit=0  共  97 项，通过  97，失败 0 → ALL PASS
ScriptPerfTest        exit=0  共  28 项，通过  28，失败 0 → ALL PASS
ScriptContractTest    exit=0  共  19 项，通过  19，失败 0 → ALL PASS
CollisionEventTest    exit=0  共  36 项，通过  36，失败 0 → ALL PASS   ← 新增
EngineAbilityTest     exit=0  共  33 项，通过  33，失败 0 → ALL PASS   ← 新增
EngineSceneTest       exit=0  共  37 项，通过  37，失败 0 → ALL PASS   ← 新增
EngineTransformTest   exit=0  共  21 项，通过  21，失败 0 → ALL PASS   ← 新增
EventBusTest          exit=0  共  34 项，通过  34，失败 0 → ALL PASS   ← 新增
OpenWorldTest         exit=0  共  72 项，通过  72，失败 0 → ALL PASS
ScriptDrawTest        exit=0  共   4 项，通过   4，失败 0 → ALL PASS
ScriptLayerTest       exit=0  共   9 项，通过   9，失败 0 → ALL PASS
==== 15 passed / 15 ====
```

> ⚠ 并发说明：`tools/bwe.ps1` 的 `Invoke-Build` 会先删除共享 `.tmp_build\bin` 下的全部 `.class`。
> 多个 agent 同时跑 `build`/`test-all` 时会互相把对方的 class 删掉，产生
> `ClassNotFoundException: Studio.runtime.XxxTest` 的假失败（与代码无关）。
> 上表是在独立输出目录 `.tmp_build/verify` 编译 172 文件后连续跑出来的，排除了该竞态。


## 6. 明确没做的事（诚实记录）

1. **`CollisionSystem` 的 O(n²) 与 `overlaps()` 重复扫 `ContactEdge`** 未优化。
   架构 §4.2 提过"改为读缓存的接触状态"，但那需要改 `BoxColliderAbility` 的物理查询路径，
   而 O(n²) 本身就是旧 Demo（几十个物体）才用的路径。审计 §2.3 明确要求"不能未测量就先优化"，本轮没测。
2. **`OnCollision` → `OnCollisionEnter` 的迁移**没做。旧 Demo 的 `Kuwu`/`SunAttack` 覆盖的是
   `OnCollision`（旧的 stay 语义），保持不动；旧核心内部没有使用方切换到新钩子。
3. **`GameObject` 没有 `OnCollision` 的 enter/stay/exit 去重与旧路径合并**：旧 `OnCollision` 与本轮新增的
   `OnCollisionStay` 是两条独立路径，同一对物体在 `CollisionSystem.update()` 里会各触发一次。
   这是刻意的兼容性选择（旧 Demo 依赖 `OnCollision` 的每帧语义），但**意味着新钩子使用者不要同时依赖两者**。
4. **`Renderer2DAbility.scale == 半宽半高`** 语义严格保留，未新增另一套语义。审计 §5 红线。
5. **Transform 父子层级 / 世界局部互转**（审计 §3 第 12 条）**未实现**——那是架构文档里另一层的工作，
   本轮 task-1 的范围只到"ability 生命周期 + 对象生命周期"。
6. `DestroyQueue.commit()` 有 64 轮连锁上限；超限会打印错误并放弃剩余队列（防止主循环卡死）。
   这是取舍：宁可漏销毁也不卡死引擎。
