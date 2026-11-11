# AI 交互式引擎改造方案

> 分支：`feat/ai-interactive-engine`
> 状态：Phase 1 设计 + Phase 2 落地骨架
> 作者：Jony Ive（Brand & Design）

---

## 一、问题：AI 能写脚本，但不能造世界

摸清现有 `desktop/lib/ai/` 与 `web/src/core/scriptOps.ts` 之后，缺口非常具体：

现在的 AI 只有**一条写入通道**——`scripts[name].source`。工具面板里 11 个工具，写类 5 个，
全部围绕「脚本文本」：

| 现有能力 | 落点 | 后果 |
|---|---|---|
| `WriteScript` / `EditScript` | `scripts[n].source` | 能写 `player.js` |
| `ReadScript` / `ListScripts` | `scripts[n].source` | 能读回 |
| `SceneDigest` | 只读摘要 | 「3 个场景 / 42 个对象」这种计数 |

AI **碰不到**：关卡图层的格子、`SceneObject` 的摆放、`PrefabDef` 模板、UI 场景、
`ModuleInstance` 的行为装配、`LightingModel` 的光照参数。

所以今天让 AI「做一个塔防关卡」，它只能给你一段 800 行的脚本，在里面用
`bwe.spawn()` 在运行时凭空 `spawn` 出所有东西。这在技术上是能跑的，在产品上是错的：

1. **玩家和策划看不见。** 编辑器画布是空的，所有内容藏在脚本里。
2. **改一个数值要重读整段脚本。** 没有结构化 diff，没有 Inspector。
3. **和引擎的涌现/物理/光照系统脱节。** 那些系统建立在 `SceneObject` 原子上。
4. **AI 无法自我校验。** 它写完不知道画面对不对。

**一句话：AI 现在是个代码补全器，不是个关卡设计师。**

---

## 二、目标

把 AI 从「往一个字符串里写代码」提升为「**在一个结构化工程模型上做原子操作**」。

```
今天：  自然语言 → 800 行脚本 → 运行时 spawn 出世界
目标：  自然语言 → 结构化操作序列 → SceneObject / PrefabDef / SceneModel 真实落盘
                                  ↓
                            玩家打开工程就能看见
```

设计原则四条，对应这个仓库已有的纪律：

1. **结构化优先于文本。** 能用 `add_object` 表达的就不要生成脚本。
2. **原子应用。** 一个计划要么整体成功，要么整体回滚，不留半成品场景。
3. **校验先行。** 每个操作在执行前用 `model.ts` 的真实类型校验，不信任模型输出。
4. **不可用 ≠ 空结果。** 无 key 时明确报 `unavailable`，绝不假装成功（沿用 `tools.mjs`
   里「Don't claim you did it if you can't」的既有注释纪律）。

---

## 三、调研结论（只看可落地的开源实现）

| 项目 | 做法 | 我们采用什么 |
|---|---|---|
| **Blender MCP**（ahujasid） | 工具面**极窄**：`get_scene_info` / `get_object_info` / `execute_blender_code` / `get_viewport_screenshot`。宽能力靠 `execute_code` 逃生口，不堆几十个细粒度工具 | **窄工具面 + 逃生口**。核心 6 个结构化工具，加一个 `run_engine_script` 兜底 |
| **Godot MCP**（Coding-Solo） | 把参数映射（snake↔camel）与错误响应标准化，错误里带 `possibleSolutions` | 错误响应**带修复建议**，不返回裸异常 |
| **Unity MCP**（CoplayDev） | **48 个聚焦工具入口**，scene / asset / script / test 分组 | 工具按**领域分组**，一组一次规划，不一次给 40 个 |
| **Aider edit-formats** | 多种 diff 格式（whole / udiff / diff-fenced），**按模型能力选格式**，不强求一种 | 结构化操作**不搞文本 patch**，直接传 JSON 对象；脚本仍走整文件替换 |
| **Roo Code / Cline** | `ask` / `plan` / `act` 模式分离，先出计划再执行，diff 需人工确认 | **Plan → Apply 两段式**：先返回计划预览，确认后才写入 |

**关键取舍**：不做任意代码执行式的场景生成（`execute_code` 能画一切，但结果不可校验、
不可增量修改、不可 diff）。我们做**声明式结构化操作**，因为工程模型已经是结构化的，
白白丢掉这个优势去拼脚本是退步。

---

## 四、架构

```
┌─────────────────────────────────────────────────────────┐
│ web/src/panels/aiPanel.ts        ← 对话 UI（已有）        │
└───────────────────────┬─────────────────────────────────┘
                        │ 已有流式通道
┌───────────────────────▼─────────────────────────────────┐
│ desktop/lib/ai/tools.mjs         ← 工具表（扩展）         │
│   ├─ 脚本组（已有 11 个）                                  │
│   └─ 工程组（新增 8 个）──► projectOps bridge            │
└───────────────────────┬─────────────────────────────────┘
                        │ runProjectOps(ops[]) 一次批量
┌───────────────────────▼─────────────────────────────────┐
│ web/src/core/projectOps.ts       ← 新增：唯一写入入口      │
│   validatePlan() → applyPlan()  （事务性）                │
│   ├─ schema.ts      真实类型校验                          │
│   ├─ ops/objects.ts add/update/delete/move               │
│   ├─ ops/prefabs.ts 预制体增删改                          │
│   ├─ ops/scenes.ts  场景与图层                            │
│   └─ ops/modules.ts 行为装配（module 白名单 + 参数域校验）  │
└───────────────────────┬─────────────────────────────────┘
                        │ store.commit()（已有 undo 栈）
┌───────────────────────▼─────────────────────────────────┐
│ web/src/core/store.ts  →  Project 模型（已有，不改）       │
└─────────────────────────────────────────────────────────┘
```

### 为什么写入走 `projectOps.ts` 而不是各工具各自改 store

因为这个仓库刚刚（`2ed3ea1`「参数化改造：渲染函数接收数据而非自读全局状态，第四次同类事故的根因修法」）
用一次重构买来的教训就是：**多个入口写同一份状态，迟早漂移。**
所有 AI 写入必须汇聚到一个函数，它独占 `validate → apply → commit` 三步。

---

## 五、工具面（新增 8 个，窄而深）

设计成**批量声明式**：一次调用可携带多个操作，避免模型为摆 20 个对象跑 20 轮。

### 5.1 `Project_Describe`
只读。返回工程的**可操作摘要**：场景列表（id/name/尺寸/ui）、图层、预制体目录
（id/name/kind/tags）、素材目录（id/name/kind/尺寸）、变量、脚本列表。
取代现在贫瘠的 `SceneDigest`（保留它，标记为轻量版）。

**为什么需要**：模型必须先知道工程里有什么 id，才能引用。没有这个它只能瞎编 id。

### 5.2 `Scene_AddObjects`
批量新增 `SceneObject`。
```json
{ "sceneId": "s1", "objects": [
  { "name": "城墙", "kind": "PROP", "x": 320, "y": 160,
    "assetId": "a_wall", "halfW": 16, "halfH": 16,
    "layerId": "l_ground", "tags": ["地形","阻挡"] }
]}
```
缺省补全由 `projectOps` 负责（`z` / `rotation` / `scaleX/Y` / `visible` / `locked` /
`modules: []` / `props: {}`），模型不需要填 20 个字段。

### 5.3 `Scene_UpdateObjects`
批量局部更新。只传要改的字段，`id` 定位。

### 5.4 `Scene_DeleteObjects`
按 id 批量删除。

### 5.5 `Prefab_Define`
定义 `PrefabDef` 模板（id/name/blurb/kind/assetId/halfW/halfH/tags/modules/props/script）。
这是「造一个可复用兵种」的操作。

### 5.6 `Modules_Attach`
给对象/预制体装配行为模块。**必须校验**：`defId` 在 `MODULES` 白名单内，
`values` 的每个 key 在 `ModuleDef.params` 里，数值在 `min..max` 内。
这是防「AI 编出一个不存在的模块 id，运行时静默失效」的关键闸门。

### 5.7 `Ui_Build`
在 `ui: true` 的场景里摆 UI 对象（text / image / panel）。
**注意**：本仓库的 UI 不是独立树，就是 `SceneModel{ui:true}` 里的 `SceneObject`，
所以它其实是 `Scene_AddObjects` 的一个约束模式，单独开工具是因为**坐标语义不同**
（设计分辨率像素，不是 tile）。

### 5.8 `Scene_ApplyScript`
把一段脚本写到指定路径并挂到对象上（`params.script`）。
专用于「结构化操作表达不了的那 10%」，且必须同时给出脚本内容与挂载点。

**逃生口**：`Scene_RunEngineScript`，执行一次性 `bwe.*` 脚本，明确标注为
「不可回滚、不可增量修改」，只在结构化工具确实表达不了时使用。

---

## 六、事务与回滚

```
applyPlan(ops):
  1. snapshot = structuredClone(project)      // 深拷贝
  2. for op in ops: validate(op, workingCopy) // 任何一项失败 → 抛错，project 未动
  3. for op in ops: apply(op, workingCopy)    // 纯内存
  4. store.commit(workingCopy, label="AI: …") // 单次进入 undo 栈
  5. return diff 摘要
```

**关键点：校验全部通过才开始改。** 不允许「改了一半发现第 7 个操作非法」。
AI 一次给 20 个操作，第 19 个写错一个 assetId，前 18 个也不能留。

---

## 七、无 key 降级

现状：`provider` 有多家（DeepSeek / Kimi / OpenAI 兼容 / Trae 导入）。用户明确要求
**provider 无关 + 无 key 可降级，且不能假装调通**。

新增 `projectOps` 的**离线规划器** `planOffline(prompt)`：
- 无 key 时，AI 面板显示明确状态：「未配置模型，已切换到本地模板生成」
- 本地规划器用**规则 + 模板**产出**真实可用的 ops**（例如「一个 20×20 的草地场景 + 4 个巡逻守卫」）
- 产出走**同一条 `applyPlan`**，所以无 key 时功能是真的可用，只是不智能
- 返回值带 `mode: "offline"`，UI 上必须显示出来

这比「无 key 就报错」好，也比「无 key 假装 AI 回答」诚实。

---

## 八、Java 运行时桥接

用户要求「Java 运行时通过桥接调用 Node LLM 层」。当前 `RuntimeBridge`
提供脚本求值与状态轮询。

设计（Phase 3，本阶段只定契约）：
```
Java  RuntimeBridge.ask(prompt, contextJson)  ──┐
                                               │ 现有 bridge 通道
Node  desktop/lib/ai/router.mjs               ←┘
        ↓ 复用同一 provider / 预算 / 缓存
      返回结构化 JSON（同样过 schema 校验）
```
**纪律**：运行时调用必须**同步阻塞在逻辑帧之外**（不能卡 1/60 步长管线），
用现有的协程 `WaitCoroutine` 挂起等待。LLM 延迟 500ms~5s，绝不能进固定步长。

---

## 九、验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | `applyPlan` 事务性：含非法操作的批次，工程状态逐字节不变 | 单元测试：快照对比 |
| 2 | `Modules_Attach` 拒绝不存在的 `defId` | 单元测试：负例 |
| 3 | 参数越界被夹紧或拒绝，不写入非法值 | 单元测试：边界值 |
| 4 | 无 key 时 `planOffline` 产出真实可应用的 ops | 单元测试 |
| 5 | 一次「造一个 20×20 场景 + 3 个守卫」端到端产生可打开的工程 | 集成测试 + 导出的 `.bwproj` 重新载入 |
| 6 | 所有 AI 写入经 `store.commit`，可一次 Ctrl+Z 撤销 | 手动 + 断言 undo 栈深度 +1 |
| 7 | 新增代码不改变既有 11 个脚本工具行为 | `npm run desk:test` 全绿 |

---

## 十、本阶段范围

**做**：设计文档（本文）、`projectOps.ts` 核心 + 事务、对象/预制体/模块三组操作、
schema 校验、离线规划器、单元与集成测试、桌面端工具表接入。

**不做**：Java 运行时桥接实现（Phase 3）、UI 场景的完整设计器能力、
任意代码执行式逃生口的沙箱强化。
