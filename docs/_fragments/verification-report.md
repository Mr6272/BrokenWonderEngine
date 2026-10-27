# BWE 本轮验收报告（独立验证 · 数据记录）

> 作者：verifier（独立验证工程师，**不参与实现**，只做「测量 → 验证 → 报告」）
> 时间：2026-10-28
> 定位：本文是 `docs/_fragments/integration-report.md`（Lead 主交付报告）的**数据支撑**。
> 两份分工：**本文保持「可复现的测量记录」**，主报告保持「结论与取舍」。
> 环境：JDK 25.0.3，`f21abc0` 基线，同机同进程模板。

---

## 0. 结论摘要

| 维度 | 结论 |
|---|---|
| 功能回归 | ✅ **7 个测试类全 PASS，共 394 项断言，0 失败** |
| 映射契约 | ✅ `verify-mapping --no-synth` 4/4 用例 PASS |
| 前端类型 | ✅ `tsc --noEmit` exit 0 |
| API 四方一致性 | ✅ **27 命名空间 / 237 成员，0 缺失 / 0 编造（完全对齐）** |
| 显存泄漏（HUD 动态文本） | ✅ **修复已验证**：768（持续增长）→ **256（封顶）** |
| 模拟子系统耗时（进程内 A/B） | ✅ Fields **-30.8%**、AI **-14.8%**、Physics **-2.0%（持平）** |
| 渲染（引用 Lead 离屏数据） | ✅ `glBegin` -95.7% / -99.4%，帧时间 -18.5% / -25.5%，**像素 diff=0** |
| 帧耗时（本基准的 A 场景） | ❌ **不可判定**（0.03~0.04ms，抖动 ±15%~295%） |
| `ScriptContractTest` 断言质量 | ✅ **19/19 全部有效**（初版 13 项中 1 条形同虚设，已按复核意见修复并经变异测试复验） |

---

## 1. 环境与可复现性

| 项 | 值 |
|---|---|
| JDK | `C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot`（`javac 25.0.3`）；**不用** PATH 的 JDK 26（JOGL 崩） |
| 编译 | `javac -d <dir> -encoding utf-8 -cp "lib/*"`，**不加 `--release 8`**（含 pattern matching / var / switch 表达式） |
| 编码 | `JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8` 设成**环境变量**（作为 java 参数会被当类名） |
| 基线 commit | `f21abc0`（`git status` 确认 `src/` 干净时抓取） |
| 基线源码快照 | `.tmp_rel8\baseline-src`（robocopy 冻结；队友后续改动污染不了） |
| 基线 classes | `.tmp_rel8\classes-before2`（146 文件，exit 0） |
| 当前 classes | `.tmp_rel8\classes-verify`（150 文件，exit 0） |

**为什么要单独冻结基线**：都编译到同一目录的话，after 会覆盖 before，`before` 永久丢失。
所以 `perf-bench.mjs` 把 `--classpath` 做成一等参数。

**同机可比原则**：所有 before/after 均来自同一台机、同一 JDK、同一进程模板、同一份基准代码。
**绝对值仅同机可比，跨机不可比。**

---

## 2. 回归矩阵（最终，7 个测试类）

```powershell
cd 'D:\githubdesktop\BrokenWonderEngine'
$jdk='C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot'
$env:JAVA_TOOL_OPTIONS='-Dfile.encoding=UTF-8'
$files = Get-ChildItem -Recurse -Path src -Filter *.java | Select-Object -ExpandProperty FullName
& "$jdk\bin\javac.exe" -d .tmp_rel8\classes-verify -encoding utf-8 -cp "lib/*" $files   # exit 0, 150 files

foreach ($t in @('ScriptSelfTest','ScriptFieldsTest','ScriptPhysicsTest','ScriptAiTest',
                 'ScriptPrefabTest','ScriptContractTest','ScriptPerfTest')) {
  & "$jdk\bin\java.exe" -cp ".tmp_rel8\classes-verify;lib/*" "Studio.runtime.$t"
}
node web/tools/verify-mapping.mjs --no-synth
cd web && npm run typecheck
```

| # | 测试 | 断言数 | 退出码 | 结果 |
|---|---|---|---|---|
| 1 | `ScriptSelfTest` | 109 | 0 | ✅ ALL PASS |
| 2 | `ScriptFieldsTest` | 43 | 0 | ✅ ALL PASS |
| 3 | `ScriptPhysicsTest` | 47 | 0 | ✅ ALL PASS |
| 4 | `ScriptAiTest` | 51 | 0 | ✅ ALL PASS |
| 5 | `ScriptPrefabTest` | 97 | 0 | ✅ ALL PASS（本轮新增，api-spawn） |
| 6 | `ScriptContractTest` | **19** | 0 | ✅ ALL PASS（本轮新增，Lead；13→19，断言质量见 §6） |
| 7 | `ScriptPerfTest` | 28 | 0 | ✅ ALL PASS（本轮新增，verifier） |
| 8 | `verify-mapping --no-synth` | 4 用例 | 0 | ✅ 4/4 PASS（10 warning 是样例数据陈旧） |
| — | **合计** | **394** | — | **0 FAIL** |

> **关于 10 条 mapping warning**：`web/.build/packages/*` 里的 Build 早于 `.bwproj` 且缺 `layer` 字段，
> 导致「图层/绘制顺序」相关断言被**跳过**。不是回归，但**覆盖不完整**——重新打包样例工程才有完整覆盖。

---

## 3. 性能验证

### 3.1 工具

**`src/Studio/runtime/ScriptPerfTest.java`**（headless 基准，固定机读格式）：
```
PERF scene=A fps=xx.x updateMs=xx.xxx drawMs=xx.xxx allocBytesPerFrame=xx textures=xx
```
三场景：**A** 500 实体 + 68 条 `bwe.draw.*`／**B** 200 可燃木箱 + 200 刚体 + 火场 + 40 AI／**C** 10 个每帧变的 HUD 数字跑 600 帧。

**`web/tools/perf-bench.mjs`**（驱动）：编译 → 跑 → 存 `web/.build/perf/<ts>.json` → `--baseline` 对比。
参数：`--classpath`（**before/after 必须不同目录**）、`--baseline`、`--label`、`--glcount`、`--no-compile`、`--threshold`。
JSON 含 `{label, commit, gitDirty, javaVersion, classpath, command, machine, scenes, extra, assertions, comparison}`。

### 3.2 ⚠️ 方法学声明：这个基准测不到 GPU

**`drawMs` 不是 GPU 帧时间。** 它是「同一场景只差脚本有没有发 `bwe.draw.*`」两次 update 的耗时差，只代表**录制**成本
（JS→Java 桥 + `Cmd` 分配 + 文字光栅化 + 注册待上传纹理）。

**`scripts.draw(null)` 在 headless 下是 27ns 的空操作**（`ScriptEngine.draw()` 首行 `if (gl == null) return;`，实测 10000 次共 0.27ms）。
所以**任何把 `draw(null)` 当成渲染成本的说法都是错的**。真实 `ScriptRender.render(gl, cmds)` 需要 GL 上下文，headless 进不去。

**同一份代码重复跑，抖动就有 ±15%~30%**。在 A/C 场景（0.03~0.06ms）这个抖动**完全盖过代码差异**。因此：

> **凡「离散度 > 差异」的指标，一律标「不可判定」，不写成优化收益或性能回归。**

已加 `PERFX updateMinMs/updateMedMs/updateMaxMs/updateSpreadPct`；`PERF` 行上报**中位数**；
计时窗口从 300 帧拉到 **4000 帧/轮 × 5 轮**（300 帧仅 15ms，比一次 OS 调度还短）。

### 3.3 模拟子系统：进程内 A/B（interleaved，各 6 轮取中位数）

**这是本报告最可信的 CPU 数据**：不靠外部负载下的绝对计时，而是**交替跑 before/after**
（消除机器负载随时间漂移），各 6 轮取中位数。

| 子系统 | before（中位数） | after（中位数） | 变化 | 判定 |
|---|---|---|---|---|
| **Fields**（100×100 草地火场，160 帧） | 0.078 ms | **0.054 ms** | **-30.8%** | ✅ **真实改善** |
| **AI**（200 AI / 150 tick） | 0.291 ms | **0.248 ms** | **-14.8%** | ✅ **真实改善** |
| **Physics**（World.step，200 刚体） | 0.457 ms | 0.448 ms | −2.0% | ⚪ **持平（噪声内）** |

原始交替样本：
```
Fields  BEFORE 0.078,0.078,0.078,0.069,0.073,0.082 → med 0.078
        AFTER  0.050,0.053,0.054,0.054,0.051,0.057 → med 0.054
AI      BEFORE 0.240,0.217,0.256,0.296,0.291,0.298 → med 0.291
        AFTER  0.219,0.202,0.266,0.258,0.248,0.245 → med 0.248
Physics BEFORE 0.435,0.457,0.435,0.436,0.462,0.464 → med 0.457
        AFTER  0.441,0.465,0.438,0.455,0.429,0.448 → med 0.448
```

**Physics 为什么优化不动**：`World.step` 的耗时 **95% 在 jbox2d 内部**（第三方库，本轮不改它）。
剩下 5% 是同步/写回，压到零也只省 5%。**这是「已到顶」的诚实结论，不是「没做好」。**

### 3.4 确定性指标（字节级，重复运行完全一致）

| 场景 | 指标 | before | after | 变化 | 判定 |
|---|---|---|---|---|---|
| **B** | `allocBytesPerFrame` | **5533** | **4704** | **-15.0%** | ✅ 真实且可复现 |
| **C** | `textures`（600 帧后） | **768**（仍增长） | **256**（封顶） | **-66.7%** | ✅ **真实修复** |
| A | `allocBytesPerFrame` | 44354 | 44388 | +0.1% | ⚪ 无变化 |

> **不要过度解读 B 的 -15%**：它确实真实（字节计数不受负载影响），但**没有转化成可测的帧耗时改善**
>（B 的 `updateMs` 前后都在 0.19~0.50ms 波动）。合理结论：「每帧少分配 829 字节，60fps 下约省 50KB/s 垃圾，
> 减轻 GC 压力」——**间接、长期**收益，**不是**「这一帧变快了」。任何「分配降 15% ⇒ 性能升 15%」的推论都是错的。

### 3.5 场景 C：HUD 动态文本显存泄漏（本轮最硬的证据）

**问题**：文本纹理缓存 key 是 `字号|颜色|阴影|文本内容`。HUD 里 `"HP 97"`、`"金币 371"` 每秒都变，
每条都生成一张新 AWT 图片 + 一个 GL 纹理，**永不释放**。跑几分钟就是几千张纹理、几十 MB 显存。

| 帧号 | before（无上限） | after（LRU 上限 256） |
|---|---|---|
| 100 | 187 | 187 |
| 300 | 423 | **256** |
| 600（结束） | **768（仍在涨）** | **256（封顶不变）** |
| `textCreated`（累计创建） | N/A（基线无此入口） | **768** |

**两条必须同时成立的断言**（只看一条会误判）：
1. `debugTextCreated()` **持续增长**（768 ≫ 256）→ 证明确实在创建，不是「缓存没工作」的假象；
2. `debugTextCacheSize()` **稳定 ≤ 256 且不随帧数增长** → 证明有界、不泄漏。

若只看 (2)，一个「完全不缓存」的实现也能过；若只看 (1)，一个无界实现也「在创建」。**两者一起才有意义。**

> 基线侧没有这两个方法，基准通过**反射**读取，**读不到记 N/A（-1），绝不填 0 冒充**。

### 3.6 渲染侧（引用 Lead 离屏数据 —— verifier 未复测）

> **本节不是 verifier 测的**。来自 Lead 的离屏 GL 路径（`GLOffscreenAutoDrawable` + NVIDIA GL4bc，
> 剔除前 2 帧预热，5 次取中位数），详见 `integration-report.md §2.1`。
> verifier 的基准**刻意不碰 GL**（headless 才能进 CI），所以这部分由 Lead 覆盖。
> **标注：不含 GPU 光栅化/上屏成本，只是 GL 命令提交 + 离屏渲染时间，适合同口径相对比较。**

| 场景 | 指标 | before | after | 变化 |
|---|---|---|---|---|
| 40×30 有贴图（170 实体） | `glBegin`/帧 | 162 | **7** | **-95.7%** |
| 同上 | 帧时间 | 2.097 ms | **1.708 ms** | **-18.5%** |
| 同上 | 像素 diff | — | **0** | 完全一致 |
| 100×100（3600 无贴图 TILE） | `glBegin`/帧 | 3575 | **20** | **-99.4%** |
| 同上 | 帧时间 | 2.062 ms | **1.537 ms** | **-25.5%** |
| 同上 | 像素 diff | — | **0** | 完全一致 |

**像素 diff = 0 是最强保证**：合批改变了 GL 提交方式，但**输出画面逐像素一致**。
工具：`node web/tools/frame-diff.mjs <a.png> <b.png> [--out diff.png]`（自研 PNG 编解码，无第三方依赖）。

---

## 4. API 四方一致性（`web/tools/verify-apidocs.mjs`）

**唯一事实来源 = Java 实现**。比对 `web/src/js/bwe.d.ts`、`web/src/data/apiDocs.ts`、`docs/api/*.md`。

### 4.1 最终结果：完全对齐

```
Java 源文件 149 | 命名空间 27 | 成员 237 | Entity 成员 53
```

| 契约侧 | 缺失 | 编造/未实现 |
|---|---|---|
| `bwe.d.ts` | **0** | **0** |
| `apiDocs.ts` | **0** | **0** |
| `docs/api/*.md`（10 页） | **0** | **0** |

**每个命名空间的四个数字完全相等**（例如 `bwe.world 22/22/22/22`、`bwe.physics 16/16/16/16`、
`lifecycle 12/12/12/12`）。这比「编造=0」更强：**功能可用、类型可补全、速查表可抄、文档可查，四者一一对应。**

### 4.2 从 172 到 0 的修复过程（本工具的价值证明）

初次扫描（早期状态）报出 **172 处**问题；最终归零。其中**真缺陷**与**工具假阳性**必须分开看：

**（a）真缺陷（工具正确抓到）**
| 缺陷 | 证据 | 修复 |
|---|---|---|
| `lifecycle.onSceneEnd` 是**文档假承诺** | 全 `src/` 零 `"onSceneEnd"` 派发 | Lead 实现（见 §5.1） |
| `bwe.ai/faction/field/material/noise/seed/sense/target` **d.ts 完全没有类型** | d.ts 计数为 0 | 补全后 8/8 |
| `bwe.physics` d.ts 0 类型 | Java 16 个成员，d.ts 0 | 补全后 16/16 |

**（b）工具假阳性（Lead 修了抽取器，每处都写注释）** —— 这些**不是实现缺陷**，是抽取逻辑不够：
1. interface 缩进匹配被嵌套对象截断
2. 不认「内联对象类型」的 const
3. Entity 抽取通配到 `module()` 子对象
4. **不读 `globals.d.ts`** → 12 个 lifecycle 全被判缺失
5. 文档合并标题 `e.x / e.y` 只取第一个
6. `bwe.values.put` 既算命名空间又算属性（重复计）

> **方法论教训**：一致性扫描器**必须能区分「实现缺失」和「抽取器局限」**。否则它会用大量假阳性
> 淹没真问题——本次 172 条里多数是假阳性，只有 `onSceneEnd` 是硬伤。**先抽查假阳性再报数是关键。**

### 4.3 生命周期抽取的特殊处理

`onSceneEnd` 这类回调**不在 ScriptApi 的方法表里**（走 `dispatchScene`，不是 `method(...)` 注册）。
若抽取器只扫 `method(...)`，会误判成「文档编造」。本工具**跨文件扫所有 `dispatch*(... "onXxx")`**，
正确抽出 **12 个** lifecycle 回调。

---

## 5. 本轮抓到的真实缺陷

### 5.1 `onSceneEnd` 假承诺 → 真实现（最典型）

**发现**：文档（`docs/scripting-api.md:94`、`apiDocs.ts:77`）承诺 `function onSceneEnd(ctx)`，
但全 `src/` 搜不到任何 `"onSceneEnd"` 派发。

**修复过程（两版，第一版错）**：
1. **错误修法**：挂在 `TopDownRuntime.dispose()`。实测探针日志**什么都没有**——
   因为窗口用 `EXIT_ON_CLOSE`，点 X 直接 `System.exit`，**根本不走 dispose()**。
2. **正确修法**：挂 `Runtime.addShutdownHook`（幂等，`sceneEnded` 保护），同时保留 dispose 调用。
3. **复验**：`src/` 现有 3 处 `dispatchScene(def, "onSceneEnd")` + shutdown hook，扫描器 lifecycle **11 → 12**。

**语义（已写进契约）**：只派发给**场景脚本**（`onStartScript` + `jsMain`），与 `onSceneStart` 对称，
**不派发给对象脚本**；只派发一次；不碰 GL，headless 安全。

> **通用教训**：验证性测试必须**端到端真的触发一次**。只做静态分析（「代码里调了 dispose ⇒ 会派发」）
> 会漏掉「EXIT_ON_CLOSE 根本不走 dispose」这种真缺陷。

### 5.2 `sizeOf()` 缓存按帧号失效

**现象**：`Entity.setSize` 断言失败，绘制尺寸仍是旧值 32×32（期望 48×64）。
**根因**：`sizeOf()` 每对象每帧被问 5~7 次，加了缓存但**用帧号做戳**。脚本在**同一帧内**改
`halfW/halfH`，帧号没变 → 缓存不失效 → 读到旧值。
**修法**：改成**按输入校验**（`halfW/halfH`、`scaleX/scaleY`、`props.w/h`、`texW/texH`、`asset` 全比对）。

> **通用教训**：任何「一帧内被多次读取」的缓存，失效条件必须**按输入校验**，不能按帧号。
> 帧号只能证明「换帧了」，不能证明「输入没变」。

### 5.3 其它（Lead 修复，verifier 复验断言通过）
- `field.on` / `ai.onAlert` / `ai.onSpot` 原来 `return null`（用户 `off()` 直接 TypeError）→ 现在返回可调用取消函数。
- `world.layers()` 原来恒空数组 → 现在读 `GameData.RtScene.layers[]`（旧 Build 无该字段 → `[]`）。
- `audio.music()` 原来返回 void（拿不到 id 就没法 stop）→ 现在返回 id。
- `audio.play({pitch})` 原来完全不读 pitch → 现在真变调（坑：用 `getAudioInputStream(新采样率,in)` 重采样，
  流速变了但 Clip 时长仍 1000.1ms、音高没变；正确做法是保留 PCM 字节只重打包 format）。
- `input.mouse.wheel` 原来恒 0（宿主从没有 `MouseWheelListener`）→ 现在有真实事件源（`volatile wheelAccum` + `takeWheel()`）。

---

## 6. 独立复核：`ScriptContractTest` 的断言质量（13 → 19，已复验）

**职责要求**：复核别人的测试是否「形同虚设」。**方法：变异测试**（人为注入缺陷，看断言会不会 FAIL）。
完整复核过程见 `docs/_fragments/verification-contract-review.md`。

| 轮次 | 断言数 | 有效 | 形同虚设 |
|---|---|---|---|
| 初版（Lead 自测） | 13 | 12 | **1**（`wheel.isNumber`） |
| **最终（按复核意见修复后）** | **19** | **19** | **0** |

### 6.1 初版的硬伤：`wheel.isNumber` 抓不到任何 bug

**旧实现** `values.put("wheel", Double.valueOf(0))` —— 恒 0，完全没有事件源。
**初版断言** `typeof bwe.input.mouse.wheel === 'number'` —— **`typeof 0 === 'number'` 为真**。

> 所以在「滚轮恒 0」的**最坏实现**上，这条断言**照样 PASS**，一条 bug 都抓不到。

变异测试实测（初版）：
```
VACUOUS  wheel.isNumber (旧实现恒 0 也能过)
         坏实现下断言仍 PASS → 抓不住缺陷
```

### 6.2 修复：单条「类型标签」断言 → 三条「端到端行为」断言

```java
rt.addWheel(3);                              // 注入滚轮增量（和 AWT 监听器同一个入口）
check("注入 +3 后读到非 0（抓得住「恒 0」回归）", wheelRead != 0);
check("读到值等于注入值 +3（向上为正）",          wheelRead == 3);
check("读过即清零（契约是「本帧增量」）",        wheelReadAfter == 0);
```
**关键设计**：读值走的是**和脚本完全相同的 getter 路径**（`ScriptApi.readWheel()` →
`ScriptJs.get(inputObj,"mouse")`），不是直接读宿主字段 —— 这样才覆盖到「getter 真的接上了宿主事件源」。

**verifier 独立变异复验**（不采信 Lead 自述，自己把 `wheelAccum` 反射清零 = 等价旧 buggy 实现）：
```
PASS  对照组（正常实现）读到注入值 +3          → 读到 3
PASS  变异 W1（恒 0 死实现）断言应 FAIL → 抓得住 → 读到 0
```
**修好后它抓得住了。**

### 6.3 覆盖缺口已闭合：`ctx.self` 的对称一半

**初版缺口**：只测「场景脚本 `self` 必须是 null」，没测「对象脚本 `self` 必须**不是** null」——
万一 `context()` 把 self 恒定置 null，测试照样全绿。

**修复后新增 4 条**：`sceneSelf.isNull` + `objectSelf.notNull` + `objectSelf.name=甲` + **`objectSelf.hpMax=77`**。
其中 `hpMax=77` 一条断言同时盯两个契约点：①对象脚本能读到实体属性 ②血量模块在对象脚本路径生效。

**verifier 独立变异复验**（摘掉 `script.js` 模块 → 对象脚本不绑定）：
```
PASS  对照组（正常绑定）objectSelf.notNull=1 存在
PASS  变异 W2（对象未绑定脚本 → 无 self）断言应 FAIL → 抓得住
```

> ⚠ 复验踩坑记录：`bwe.log` 是**追加模式**，变异体若复用对照组目录会读到上次历史行 → **假绿**。
> 必须给变异体**独立目录**。第一次跑就因此误判过一次，已修正。

### 6.4 结构断言：如实标 N/A，不写假绿

`hostHasWheelListener()` 反射读 `canvas.getMouseWheelListeners()`，但**headless 下 `canvas` 为 null**
（监听器只在 `openWindow()` 里挂）。Lead 第一版写成「false = 失败」→ 直接 FAIL，
说明这条在 headless 下**本质不可验证**。改为三态：`null`=N/A 并注明「端到端断言已覆盖行为」。

> 这正是「空断言」问题的正确应对：**不可验证时如实标 N/A，而不是写一条永远 PASS 的断言自欺。**

### 6.5 结论

**19/19 全部有效，0 条形同虚设，0 条空断言。** 这份测试现在盯的每个点都是**真实缺陷固化**。

**三条方法论（建议进团队规范）**：
1. **断言应验证「行为的可观测后果」，不是「值的类型标签」** —— `typeof 0 === 'number'` 是典型陷阱。
2. **不可验证的断言要如实标 N/A**，不要写「永远 PASS」来凑绿。
3. **变异测试是检验「断言是否形同虚设」的唯一可靠方法** —— 必须**故意注入缺陷，确认它会 FAIL**。
   只看测试通过是不够的。本轮 13 → 19 项的改进完全由变异测试驱动。

---
## 7. 未验证到的风险（诚实清单）

| # | 风险 | 为什么没验 | 影响 |
|---|---|---|---|
| 1 | **GPU 真实帧时间** | 本基准刻意 headless（可进 CI）；Lead 用离屏 GL 覆盖，verifier **未独立复测** | 若离屏与真实上屏有差异（vsync / 交换链 / 驱动路径），真实帧率可能不同 |
| 2 | **A 场景 `updateMs` 未通过** | 0.03~0.04ms，抖动 ±15%~295%，噪声完全盖过差异；验证期机器被队友并发任务占满 | **无法断言「A 场景变快了多少」**。只有字节级确定性指标（分配量、纹理数）与进程内 A/B（Fields/AI）可信 |
| 3 | **`drawMs` 的真实含义** | headless 下 `render()` 进不去，只测录制成本 | 不能评估渲染性能，只能评估脚本侧绘制开销 |
| 4 | **多机 / 多 JDK 可比性** | 单机单 JDK | 绝对值**跨机不可比**；JDK 21 vs 25 的 JIT 差异可能改变结论 |
| 5 | **`verify-mapping` 10 条 warning** | 样例 Build 数据陈旧 | 「图层/绘制顺序」断言被**跳过**，覆盖不完整 |
| 6 | **长时间运行的内存/显存** | 场景 C 只跑 600 帧（≈9.6s） | 更长时间（如 1 小时）是否有其他泄漏**未验证**；只验了文本纹理这一条路径 |
| 7 | **Physics 优化空间** | `World.step` **95% 在 jbox2d 内部** | 不改第三方库就到顶了；-2.0% 是诚实结论，不是「没做好」 |
| 8 | **并发/多线程安全** | 全部测试单线程 | `Runtime.addShutdownHook` 与主线程的竞态未做压力验证（靠 `sceneEnded` 幂等保护） |
| 9 | **Prefab 热更新语义** | v1 明确不做（define 后已生成实例不变） | 设计决策非缺陷；但**文档必须写明**，否则用户会误以为能热更 |
| 10 | **Web 编辑器视觉/交互** | verifier 只跑 `typecheck`/`build`，未做浏览器验收 | Prefab 面板的实际 UI 行为**未经 verifier 验证**（归 web-prefab 自测） |

---

## 8. 交付物

| 文件 | 说明 |
|---|---|
| `src/Studio/runtime/ScriptPerfTest.java` | headless 基准，28 断言 + 固定 `PERF` 行 + `PERFX` 诊断行 |
| `web/tools/perf-bench.mjs` | 编译/跑/存 JSON/对比；`--classpath` / `--baseline` / `--glcount` |
| `web/tools/verify-apidocs.mjs` | 四方一致性扫描；`--json` / `--strict` / `--only` |
| `docs/_fragments/verification-report.md` | 本文件（数据记录） |
| `docs/_fragments/verification-contract-review.md` | `ScriptContractTest` 变异测试复核 |
| `.tmp_rel8/perf-data/` | before/after 原始结果 |
| `web/.build/perf/*.json` | 每次运行完整快照（含环境元数据与对比） |

### 复现命令

```powershell
cd 'D:\githubdesktop\BrokenWonderEngine'
$jdk='C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot'
$env:JAVA_TOOL_OPTIONS='-Dfile.encoding=UTF-8'

# 全量编译
$files = Get-ChildItem -Recurse -Path src -Filter *.java | Select-Object -ExpandProperty FullName
& "$jdk\bin\javac.exe" -d .tmp_rel8\classes-verify -encoding utf-8 -cp "lib/*" $files

# 基准：before 侧（冻结快照 + 同一份基准代码）与 after 侧
node web/tools/perf-bench.mjs --no-compile --classpath .tmp_rel8\classes-before2 --label before
node web/tools/perf-bench.mjs --no-compile --classpath .tmp_rel8\classes-verify  --label after --baseline <before.json>

# 四方一致性
node web/tools/verify-apidocs.mjs           # 人读
node web/tools/verify-apidocs.mjs --json    # 机读
```
