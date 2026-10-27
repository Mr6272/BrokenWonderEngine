# ScriptContractTest 独立复核（verifier 挑刺 → 修复 → 复验）

> 复核对象：`src/Studio/runtime/ScriptContractTest.java`
> 复核方法：**变异测试**（人为注入它本该抓的缺陷，看断言会不会 FAIL）
> 版本演进：**13 项（12/13 有效）→ 19 项（19/19 全部有效）**
> 最终结论：**19/19 有效，0 条形同虚设，0 条空断言。**

---

## 〇、最终状态（复验结论）

| 轮次 | 断言数 | 有效 | 形同虚设 | 说明 |
|---|---|---|---|---|
| 初版（Lead 自测） | 13 | 12 | **1**（`wheel.isNumber`） | verifier 变异测试抓出 |
| **修复后（最终）** | **19** | **19** | **0** | verifier 独立变异复验通过 |

**verifier 独立复验**（不采信 Lead 的自述，自己重跑变异测试）：
```
MutationProbe2（verifier 写的独立探针）
PASS  对照组（正常实现）读到注入值 +3
PASS  变异 W1（恒 0 死实现）断言应 FAIL → 抓得住
PASS  对照组（正常绑定）objectSelf.notNull=1 存在
PASS  变异 W2（对象未绑定脚本 → 无 self）断言应 FAIL → 抓得住
PASS=4 FAIL=0
```

---

## 一、初版的问题（历史记录，保留作为「为什么改成这样」的来由）

| # | 断言 | 初版判定 | 依据 |
|---|---|---|---|
| 1 | `fieldOn.returnsFn=1` | ✅ 有效 | 变异：`off1=null` → 日志变 `=0`，断言 FAIL。HEAD 旧实现确实 `return null` → 实测 FAIL |
| 2 | `fieldOn.offWorks=1` | ✅ 有效 | 旧实现 `off1` 是 null，调用即抛 → 不会打出 `=1` |
| 3 | `aiOnAlert.returnsFn=1` | ✅ 有效 | 同 1（HEAD 实测 FAIL） |
| 4 | `aiOnSpot.returnsFn=1` | ✅ 有效 | 同 1 |
| 5 | `layers.count=3` | ✅ 有效 | 变异 `var layers=[]` → `count=0` FAIL。HEAD 恒空 → 实测 FAIL |
| 6 | `layers.firstName=地形` | ✅ 有效 | 空数组不进 `if`，该行缺失 |
| 7 | **`wheel.isNumber=1`** | ❌ **形同虚设** | 见 §二 |
| 8 | `music.isNumber=1` | ⚠️ 偏弱但有效 | 能抓「返回 void/undefined」，抓不住「恒 -1 死实现」 |
| 9 | `sceneSelf.isNull=1` | ⚠️ 偏弱（回归锁） | HEAD 本来就是 null → 从未抓过 bug，是防回归用的 |
| 10 | 无脚本错误 | ✅ 有效 | 标准做法 |
| 11-13 | boot/ScriptEngine/启动 | ✅ 有效 | 前置条件 |

---

## 二、初版的硬伤：`wheel.isNumber` 抓不到任何 bug

**旧实现（HEAD）**：
```java
o.values.put("wheel", Double.valueOf(0));   // 恒 0，完全没有事件源
```
**初版断言**：
```js
typeof bwe.input.mouse.wheel === 'number'
```

**问题**：`typeof 0 === 'number'` 为真。

> 所以在「滚轮恒 0、完全没有事件源」的**最坏实现**上，这条断言**照样 PASS**。

变异测试实测（初版）：
```
VACUOUS  wheel.isNumber (旧实现恒 0 也能过)
         坏实现下断言仍 PASS → 抓不住缺陷
```

它唯一能抓的是 `wheel` 是 `undefined` —— 但 `values.put` 保证属性一定存在。**所以它一条 bug 都抓不到。**

---

## 三、修复后（Lead 按复核意见重写，verifier 独立复验）

### 3.1 wheel 从「1 条形同虚设」变成「3 条端到端断言」

```java
rt.addWheel(3);                              // 注入滚轮增量（和 AWT 监听器同一个入口）
check("注入 +3 后读到非 0（抓得住「恒 0」回归）", wheelRead != 0);
check("读到值等于注入值 +3（向上为正）",          wheelRead == 3);
check("读过即清零（契约是「本帧增量」）",        wheelReadAfter == 0);
```

**关键设计（比断言本身更重要）**：读值走的是**和脚本完全相同的 getter 路径**
（`ScriptApi.readWheel()` → `ScriptJs.get(inputObj,"mouse")`），不是直接读宿主字段。
这样才覆盖到「getter 真的接上了宿主事件源」。

**verifier 独立变异复验**（把 `wheelAccum` 反射清零 = 等价旧 buggy 实现）：
```
PASS  对照组（正常实现）读到注入值 +3        → 读到 3
PASS  变异 W1（恒 0 死实现）断言应 FAIL → 抓得住  → 读到 0
```
**修好之后它抓得住了。这是本次复核最实质的改进。**

### 3.2 结构断言：明确标 N/A 而不是假绿

`hostHasWheelListener()` 用反射读 `canvas.getMouseWheelListeners()`。**但 headless 下 `canvas` 是 null** ——
监听器只在 `openWindow()` 里挂。

**Lead 第一版写成「返回 false = 断言失败」，跑出来 FAIL** —— 说明这条断言在 headless 下**本质不可验证**。
改成三态：`null` = 无法验证（记 N/A 并说明「端到端断言已覆盖行为」），`TRUE`/`FALSE` = 已验证。

> **这正是 verifier 指出的「空断言」问题的正确应对**：不可验证时**如实标 N/A**，
> 而不是写一条永远 PASS 的断言自欺。

### 3.3 `sceneSelf` 覆盖缺口 → 已补对称一半

**verifier 指出的缺口**：原来只测「场景脚本 self 必须是 null」，没测「对象脚本 self 必须**不是** null」——
万一哪天 `context()` 把 self 恒定置 null，这条测试照样全绿。

**修复**：`scene_0.json` 给对象 `甲` 挂 `combat.health{maxHealth:77}` + `script.js→objprobe`，新增：
- `objectSelf.notNull=1`
- `objectSelf.name=甲`
- **`objectSelf.hpMax=77`**

**`hpMax=77` 是有意设计的**：一条断言同时盯两个契约点——
①对象脚本能读到实体属性 ②血量模块在对象脚本路径生效（后者正是 Lead 本轮修的 `applyHealthModule` bug）。

**verifier 独立变异复验**（把 `script.js` 模块摘掉 → 对象脚本不绑定）：
```
PASS  对照组（正常绑定）objectSelf.notNull=1 存在
PASS  变异 W2（对象未绑定脚本 → 无 self）断言应 FAIL → 抓得住
```

> ⚠ 复验时踩了一个坑，值得记录：`bwe.log` 是**追加模式**，变异体如果复用对照组目录，
> 会读到上一次的历史行 → **假绿**。必须给变异体**独立目录**。第一次跑就因此误判过一次。

---

## 四、最终判定：19/19

| 组 | 断言 | 数量 | 判定 |
|---|---|---|---|
| 1 | `fieldOn.returnsFn/offWorks`、`aiOnAlert/aiOnSpot.returnsFn` | 4 | ✅ 有效 |
| 2 | `layers.count=3`、`layers.firstName=地形` | 2 | ✅ 有效 |
| 3 | **wheel 端到端 3 条**（非 0 / 等于注入值 / 读过清零） | 3 | ✅ **有效（已变异验证）** |
| 3b | wheel 结构断言（headless 时 N/A） | 1 | ✅ 有效（N/A 语义正确） |
| 4 | `music.isNumber=1` | 1 | ✅ 有效（能抓「返回 void」） |
| 5 | **ctx.self 对称 4 条**（scene null + object notNull/name/hpMax） | 4 | ✅ **有效（已变异验证）** |
| 6 | 无脚本错误 + 4 条前置条件 | 4 | ✅ 有效 |
| — | **合计** | **19** | **0 形同虚设** |

**`sceneSelf` 的覆盖缺口已闭合。** 不再有「只测一半」的问题。

---

## 五、方法论总结（三条，建议进团队规范）

1. **断言应验证「行为的可观测后果」，不是「值的类型标签」。**
   `typeof x === 'number'` 只能证明「有个数字」，不能证明「这个数字对」。
   `typeof 0 === 'number'` 是这类空断言的典型陷阱。

2. **不可验证的断言要如实标 N/A，不要写「永远 PASS」来凑绿。**
   headless 下 canvas 为 null → 结构断言无法验证 → 标 N/A，并说明「端到端断言已覆盖行为」。

3. **变异测试是检验「断言是否形同虚设」的唯一可靠方法。**
   只看测试通过是不够的 —— 必须**故意注入缺陷，确认它会 FAIL**。
   本轮 13 → 19 项的改进，完全由变异测试驱动。

---

## 六、给未来的维护者

这份测试现在盯的每个点都是**真实缺陷固化**，不要为了「让测试变绿」而放宽断言。特别是：

- `wheel` 的 3 条端到端断言：不要退回成 `typeof === 'number'`。
- `objectSelf.hpMax=77`：这是「模块在对象脚本路径生效」的唯一覆盖，别删。
- 结构断言标 N/A 不是「偷懒」，是**headless 的客观限制**；有窗口的环境里它应该是 `TRUE`。

如果要新增契约断言，请先用变异测试证明它抓得住东西，再加进矩阵。
