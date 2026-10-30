# BWE 本轮交付：性能优化 + 物体生成/修改接口 + Unity 风格 API 文档

> 本文是 Lead 的**集成验收报告**。子系统的详细数据见：
> `_fragments/verification-report.md`（性能基准与回归矩阵）、`_fragments/prefab-spawn-modify.md`（接口正文素材）、
> `_fragments/web-prefab-report.md`（编辑器预制体）、`_fragments/doc-inconsistency.md`（32 条不一致清单）。

---

## 一、总体验收状态

| 项 | 结果 |
|---|---|
| 全量编译（150 个 java，JDK 25 默认模式） | **exit=0** |
| **打包链路编译（`--release 8`，24 个 runtime 源文件）** | **exit=0** |
| 自检断言总数 | **411 项全绿**（9 个测试类；其中 ScriptDrawTest 需 GPU） |
| 渲染像素回归 | **逐像素 diff=0**（低 DPI 场景，改动前后哈希完全一致） |
| 游戏运行时 UI | **修复 2 个既有显示 bug**（圆角矩形楔形空洞 / 高 DPI 文字发虚），见 §十 |
| API 四方一致性 | **0 缺失 / 0 编造**（Java ↔ d.ts ↔ apiDocs.ts ↔ docs/api） |
| Web 编辑器 | `typecheck` 0 error、`build` 成功 |
| 真实打包（`package-bwe.mjs` 全 5 段） | **exit=0，产出 50MB zip + 可运行的 exe** |
| 文档 | `docs/api/` 10 页、271 条目、**0 死链** |

```
ScriptSelfTest      109 PASS      ScriptFieldsTest   43 PASS
ScriptPhysicsTest    47 PASS      ScriptAiTest       51 PASS
ScriptPrefabTest     97 PASS      ScriptPerfTest     28 PASS
ScriptContractTest   19 PASS      ScriptLayerTest     9 PASS
ScriptDrawTest        4 PASS（需 GPU；无 GPU 记 SKIP）
──────────────────────────────────────────────────────
                                        合计 411 项
```

> ⚠ **这些数字是用 `--release 8` 编译出的 classes 跑的**（与打包链路完全一致），
> 不是用 JDK 25 默认模式跑的那份。两者都要绿 —— 详见 §九「Java 8 兼容性事故」。

---

## 二、性能优化

### 2.1 渲染（本轮最大收益）

测量方式：**离屏 OpenGL**（`GLOffscreenAutoDrawable`，NVIDIA GL4bc，不弹窗），
同机同进程模板，剔除前 2 帧预热，**5 次取中位数**。
像素回归用自研 `web/tools/frame-diff.mjs`（自己实现 PNG 编解码，无第三方依赖）。

| 场景 | 指标 | 改动前 | 改动后 | 变化 |
|---|---|---|---|---|
| 40×30 有贴图（170 实体） | `glBegin`/帧 | 162 | **7** | **-95.7%** |
| 同上 | 帧时间 | 2.097 ms | **1.708 ms** | **-18.5%** |
| 同上 | 像素 diff | — | **0** | 完全一致 |
| 100×100（3600 无贴图 TILE） | `glBegin`/帧 | 3575 | **20** | **-99.4%** |
| 同上 | 帧时间 | 2.062 ms | **1.537 ms** | **-25.5%** |
| 同上 | 像素 diff | — | **0** | 完全一致 |
| HUD 文本压力（600 帧） | 文本纹理数 | 768 且持续增长 | **256（封顶）** | **泄漏已修** |

**做了什么（每一条都用像素对比验证过）：**

1. **纹理按文件路径共享**（收益最大）：原来每个 Actor 都走 `readImage → textureFromImage`，
   等于「同一张墙纸被 151 个对象各上传一份」。151 份相同 64×64 RGBA ≈ 2.5MB 显存白烧，
   **更致命的是每个对象的 `tex.id` 都不同 → 合批永远不可能命中**。
   改为按绝对路径缓存后，151 面墙 = 1 个纹理 + 1 次 `glBindTexture`。
2. **同纹理相邻精灵合批**：`flushSpriteBatch` 把连续轴对齐精灵塞进一个 `glBegin(GL_QUADS)`。
   每个 quad 单独 `glColor4f`（固定管线里颜色是状态不是顶点属性，必须逐 quad 重设）。
3. **纯色块单独合批**：3600 个无贴图 TILE 走 `batchSolid`，从 3600 次 `glBegin` 降到个位数。
4. **地图网格编译成显示列表**：网格线是纯静态几何（只依赖地图尺寸 + tileSize），
   改成 `glNewList(GL_COMPILE)` 录一次、每帧一个 `glCallList`。尺寸变化时自动重建。
5. **文本纹理缓存改成有界 LRU（256）**：原来 key 含完整文本且无上限，HUD 里
   `"FPS 62"` / `"金币 37"` 每秒都变 → 每帧新建一张 AWT 图 + 一个 GL 纹理，永不释放。
   现在超限按 LRU 淘汰，且**淘汰的纹理在 GL 线程真正 `glDeleteTextures`**。
6. **每帧分配归零**：`drawActors` 的排序缓冲复用（数量与 y 总和不便则跳过重排）、
   `snapshotBound()` 快照复用、`handlers()` 下标遍历、`drawFallback` 的 `new Color` 改预分配常量、
   `sizeOf()` 按输入校验的缓存。

**踩过的两个坑（都是用像素对比抓出来的，已写进代码注释）：**

- **`GL_ALPHA_TEST` 绝对不能开**。我一度在合批里设了 `alphaFunc(0.2)`，结果文字抗锯齿边缘
  （alpha<0.2）被丢弃，逐像素对比出现 **302 个像素差异**。原实现从不启用 alpha test。
- **状态缓存的陷阱**。我一开始用 `spriteStateReady` 缓存「纹理已开」的一次性状态，但原始 GL 路径
  （影子/血条/扫雷盘/脚本 HUD）会随意 `glDisable(GL_TEXTURE_2D)`，导致后续精灵画成**白块**
  （整张地图变白/黑两色）。改成每批重设状态（一帧 7 批，成本可忽略）。

### 2.2 模拟子系统

测量方式：因为机器上多 agent 并发跑测试，**跨时间点测量不可比**（同一份未改代码的 physics
在不同时刻测出 0.34 / 0.64 / 0.99ms）。改用**进程内交替 A/B**（baseline 与 current 各编一份 class，
同一 JVM 各跑 15 次取中位数，重复 5 次），并用「两边代码完全相同的 physics」当**噪声对照**（+1.1%）。

| 项 | before | after | Δ |
|---|---|---|---|
| fields tick avg | 0.0356 ms | **0.0173 ms** | **-51.4%** |
| ai avgTick | 0.0308 ms | **0.0253 ms** | **-17.9%** |
| physics（未改，噪声对照） | 0.2131 ms | 0.2154 ms | +1.1% |

**Fields 的收益来自一个「契约不一致 bug」，不是常见优化手法**：
`alive()` 用 `> EPS(0.005)` 判活，而 `processCell()` 的 smoke 分支要 `> 0.01` 才干活。
稳态下 100×100 场景有 **4148 个格子全部只有 smoke、值都落在 0.005~0.01 区间** ——
每 tick 被完整遍历一遍却什么都不做，白烧约 100µs/帧。把两个门限对齐即可。
**这类「判活门限 ≠ 工作门限」是场/粒子/脏标记系统的通用漏点，已作为可复用检查项写进报告。**

**主动回滚了 4 个「测了没收益」的方案**（全部有实测数字）：
AI 空间分桶（visionScan 39µs→68µs，**反而慢 74%**）、除法查表（总收益<2%）、
physics body↔actor 同步（只占物理帧 4.3%，且 jbox2d 的 getter 确认不分配）、
World findPath 池化（world tick 总计仅 3.4µs/帧，<1%）。

**诚实结论**：`ScriptPhysics` 95% 时间在 jbox2d `World.step` 内部（141.6µs/148µs），
我方能控的只有 7µs。真正的杠杆是减少迭代次数，但那会**改变模拟结果、破坏确定性，不能动**。

---

## 三、物体生成 / 修改接口 + 预制体

### 3.1 新增 `bwe.prefab`（9）/ `bwe.pool`（4）
- 模板注册与实例化、深拷贝快照、`fromEntity` 反向抓取、实例计数
- 对象池支持 `prewarm` 预生成
- **`boot.json` 的 `prefabs[]` 运行期自动 define**（编辑器导出 → 运行时可用，链路已端到端验证）

### 3.2 `bwe.world` 扩展（+8）
`spawnMany` / `spawnAt` / `clone` / `clear` / `clearTag` / `destroyAll` / `count` / `each`，
`spawn(opts)` 补齐 `rotation` / `scaleX` / `scaleY` / `layer` / `visible` / `animMode` / `animFps` / `props` / `parent`。

### 3.3 Entity 扩展（约 20 项）
`size`（可写）/ `layer` / `locked` / `animMode` / `animFps` / `asset` / `color` / `parent`
+ `setColor` / `setAlpha` / `clearColor` / `addTag` / `removeTag` / `hasTag` / `setTags`
+ `props` / `setProps` / `addModule` / `removeModule` / `hasModule` / `children`

**tint 真出像素**（不是「记录不画」）：染色状态存在 `Actor` 上（不是 Map —— 热字段零查找），
渲染侧合批时每 quad 单独 `glColor4f`，所以**同一预制体不同颜色的实例仍能合批**。

### 3.4 编辑器侧预制体（BWE Studio）
- 左栏新增「预制体 Prefab」tab（列表/搜索/新建/从场景对象创建/双击放置/拖进画布/属性表单）
- Inspector「预制体链接」卡片（还原为默认值 / 断开链接）
- 画布拖放 + 链接角标；`.bwproj` 新增 `prefabs` 字段（**旧工程向后兼容**，缺省 `[]`）
- 导出到 `boot.json` 的 `prefabs[]`，字段与 Java 侧逐字对齐

**4 个只有真跑浏览器才发现的 bug**（typecheck 与单测都不会报）：
面板首次渲染空白、`viewCenter` 用 `0,0` 当哨兵与真坐标撞车、无模块的预制体挂不上脚本、
重命名用隐藏输入框（用户看不见）。

---

## 四、端到端验证抓到的 3 个真 bug（已修）

这条链路是**真导出 → 真跑运行时 → 读日志**，不是纸面推演：

```
.bwproj（含预制体） → writeBuild() → boot.json → 注入探针脚本 → 离屏跑 → 读 bwe.log
```

| # | Bug | 根因 | 修法 |
|---|---|---|---|
| 1 | `hpMax=10`（应为 40） | 脚本/prefab spawn 走 `ScriptEngine.spawnScripted`，那里 `modules.addAll()` 后**没人读血量模块**（场景对象走的是另一条路） | 抽出 `applyHealthModule(Actor)`，两条路径共用 |
| 2 | `spawn({x:100,y:120})` 出来是 `99,118` | prefab spawn 无条件应用 jitter，且随机源不与 `bwe.seed` 联动 ⇒ **破坏确定性** | 改为「给了 x/y 就精确落位，`jitter:true` 才抖，池永不抖」+ 加了 20 次一致性断言 |
| 3 | `size` 改了但绘制尺寸不变 | 我给 `sizeOf()` 加的缓存用**帧号**做失效戳，脚本同帧内 `setSize` 不失效 | 改成**按输入校验**（halfW/halfH/scale/props.w/h/texW/texH/asset 全比对） |

**教训**：一帧内多次读同一函数的缓存，必须按**输入**校验，不能按帧号。

---

## 五、把「文档撒谎」的 API 变成真实现

doc-writer 与 verifier 交叉比对抓出一批「文档/类型声明了、代码是空壳或行为不符」的 API。
**没有删文档了事，而是把 6 个改成了真实现**，并固化成 `ScriptContractTest`（19 项断言）：

| API | 原来 | 现在 |
|---|---|---|
| `bwe.world.layers()` | `return` 恒空数组 | 真解析 `scene_*.json` 的 `layers[]`，返回 id/name/visible/locked/order（旧 Build 返回 `[]`） |
| `bwe.input.cursor(v)` | `-> null` 空实现 | 真改 AWT 组件光标（「隐藏」用 1×1 全透明图，AWT 不允许 `setCursor(null)`） |
| `bwe.input.mouse.wheel` | 恒 0（全 src 无 `MouseWheelListener`） | 接上真实滚轮事件源（向上为正） |
| `bwe.audio.play({pitch})` | 参数**完全不读** | 真变调（实测 `1.0→1000ms / 1.5→666.7ms / 0.5→2000ms`） |
| `bwe.field.on()` / `ai.onAlert()` / `ai.onSpot()` | `return null` | 返回**可调用的取消函数**（照文档 `var off=...; off();` 原来直接 TypeError） |
| `onSceneEnd` | **从未派发**（12 处 grep 无结果） | 真派发（挂 JVM shutdown hook，实测日志 `SELFTEST_ONSCENEEND_FIRED`） |

**`ScriptContractTest` 用变异测试自证有效**：独立复核（verifier）用「注入缺陷看断言会不会 FAIL」的方法
审出第一版有 **1 条形同虚设**的断言 —— `typeof wheel === 'number'` 在「滚轮恒 0 的死实现」上照样 PASS。
已重写为**端到端断言**（注入 +3 → 脚本读到非 0 且等于 3 → 读过清零），并把同样变异（改回 `Double.valueOf(0)`）
跑了一遍：**改后确实 FAIL，改前不会**。同时补了两个覆盖缺口：
`ctx.self` 的对象脚本对称断言（并借 `hpMax=77` 同时验证血量模块在对象路径生效）、
`MouseWheelListener` 结构探针（headless 下明确记 N/A，不写假绿）。

**教训（值得复用）**：断言要验证**行为的可观测后果**，不是**值的类型标签**。
`typeof x === 'number'` 只证明「有个数字」，不证明「这个数字对」。

**`pitch` 的踩坑值得单独记**：第一版用 `AudioSystem.getAudioInputStream(新采样率, in)` 去重采样，
流速确实变成 22050→33075，**但 Clip 时长仍是 1000.1ms、音高根本没变**（它按时间轴插值，
频率成分原样保留）。正确做法是保留原始 PCM 字节、只重打包 format 的采样率。
这条已写进文档的「防回退警告」，防止后人优化回去。

**`onSceneEnd` 也是两次才对**：第一次只挂在 `dispose()` 上，实测探针日志**什么都没有** ——
窗口用 `EXIT_ON_CLOSE`，点 X 直接 `System.exit`，**根本不会走 dispose()**。

---

## 六、文档

### 6.1 Unity 风格 API 手册：`docs/api/`（10 页，271 条目）

| 页面 | 条目 | 覆盖 |
|---|---|---|
| [README.md](../api/README.md) | 10 分组 | 索引，链接 ~236 个成员 |
| [lifecycle.md](../api/lifecycle.md) | 31 | 12 个真实回调 + ctx + 全局钩子 + 工具函数 |
| [world.md](../api/world.md) | 22 | 查找/生成/销毁/批量/图层 |
| [entity.md](../api/entity.md) | 51 | 属性、模块、子精灵、染色、父子 |
| [prefab.md](../api/prefab.md) | 20 | prefab + pool + **性能提示** |
| [input-camera-time.md](../api/input-camera-time.md) | 25 | 输入/相机/时间 |
| [draw-audio-save.md](../api/draw-audio-save.md) | 22 | HUD/音频/存档 |
| [map-nav-interact-spawner.md](../api/map-nav-interact-spawner.md) | 20 | 网格/瓦片/寻路/交互/刷怪 |
| [emergence.md](../api/emergence.md) | 56 | 材质/场/噪音/感知/阵营/物理/种子 |
| [modules.md](../api/modules.md) | 14 + 43 模块总表 | 可视化模块 |

**体例**（严格 Unity 式）：每成员固定顺序「签名 → 参数表 → 返回 → 说明 → 示例 → 另见」，
每个 API 标 Phase（`✅ 已实现` / `🧪 试验` / `📋 规划`），
**所有示例都是可跑的 ES5**（`var`/`function`，因为运行时是 Rhino 1.7.15）。

自查：**351 个内部锚点 0 死链、10 页全被 README 链接、0 断表、0 个 ES5 违规**。

### 6.2 四方一致性：从「172 处缺失」做到「0 缺失 / 0 编造」

`web/tools/verify-apidocs.mjs` 以 Java 实现为唯一事实来源，比对 `bwe.d.ts` / `apiDocs.ts` /
`docs/api/*.md` 三侧。**首次跑出 172 处「缺失」+ 1 处「编造」** —— 逐条排查后发现
**绝大多数是校验器自己的解析缺陷**（假阳性），逐个修掉：

1. `interface` 用「缩进匹配 `}`」→ 成员里嵌对象字面量类型时第一个内层 `}` 就截断，
   导致 physics/field/ai/material 等 8 个命名空间**整块被判缺失**。改花括号配平。
2. 只认 `const x: Ident;` 绑定 → 内联对象类型的 9 个命名空间全判缺失。加了内联分支。
3. Entity 抽取用 `[A-Za-z0-9_]+` 通配 → `e.module(def)` 返回的子对象 `m` 上的
   `get/set/has/remove/enabled/dt` 被算成 Entity 成员（多出 9 个）。钉成 `e`。
4. 不读 `globals.d.ts` → 12 个 lifecycle 回调全判缺失。加了 `extractGlobals`。
5. 文档标题只认 `bwe.x.y` / `Entity.x` → 文档用 `e.x`、裸 `onStart(...)`、
   **合并节 `e.x / e.y`** 时第二个成员丢失。扩展了标题解析。
6. `bwe.values.put("prefab", obj)` 既算命名空间又算 `bwe` 属性 → 凭空造出
   `bwe.prefab [属性]` 两条永远对不上的成员。排除了。
7. `d("e.x", "e.x / e.y", ...)` 合并条目只登记第一个名字 → 第二个永久「缺失」。

**最终真实修掉的契约缺口**：`AttachHandle` 类型错（number → 接口对象）、
`apiDocs.ts` 缺 9 条（physics 3 条 / seed 1 / scripts 1 / Entity 4）、`bwe.field.off` 缺三处文档。

---

## 七、诚实列出的限制与风险

1. **帧时间数字的边界**：离屏 harness 测的是「CPU + 驱动提交」耗时，**不含 GPU 实际光栅化**
   （FBO 不锁帧、无 vsync）。它适合做**相对比较**（before/after 同口径），不能当成玩家看到的帧时间。
   `glBegin` 次数是更硬的指标（-95.7% / -99.4%），因为它直接反映提交量。
2. **`ScriptPhysics` 无法有效优化**：95% 时间在 jbox2d 内部，动迭代次数会破坏确定性。这是设计边界，不是没做。
3. **预制体 v1 不做自动同步**（Unity 的 override 语义太复杂）：同步靠 Inspector 的「还原为预制体默认值」手动操作。
   预制体也不支持嵌套、不能继承坐标。
4. **`kind: "LIGHT"` 没有真实光照**：只在对象**没有贴图**时画一个暖黄兜底色块。
   文档已把措辞改准（原来会让用户以为有光照系统）。
5. **43 个可视化模块里运行时只认 10 个 id**（7 个读参数 + 3 个只看 id），其余 30+ 是纯编辑器侧
   「意图描述」。已在 `modules.md` 开头做成显著警告 + 16 行「用 JS 代替」对照表。
6. **6 组模块参数名不一致**（`stopDist`↔`stopDistance` 等，改了没反应）：这些是运行时读取名与
   编辑器参数名对不上，已在 `modules.md` 汇总成表。**未修代码**（会改变现有工程行为），只如实记录。
7. **`docs/scripting-api.md` §5「编辑器侧」未核对**：属 Web 编辑器 scope，本轮未逐项验证。
8. **web-prefab 的浏览器验证用的是 headless Chrome + CDP 合成事件**，不是真人操作；
   输入法/拖拽手感/高分屏等场景未覆盖。
9. **`src/Studio/runtime/` 里混着 7 个 `*Test.java`，打包链路会把它们一起编进去**。
   这是「测试文件用错 API 就炸用户构建」的结构性风险（§九 就是实例）。
   `npm run check:java8` 已能拦住这类问题，但**更彻底的做法是把测试类挪出 `runtime/` 目录**
   （需要同步改打包脚本的源文件选择规则），本轮未做 —— 因为会动到打包链路的核心逻辑，风险大于收益。

---

## 八、复现命令

```powershell
cd 'D:\githubdesktop\BrokenWonderEngine'
$jdk='C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot'   # 不要用 JDK 26（JOGL 2.1 崩）
$env:JAVA_TOOL_OPTIONS='-Dfile.encoding=UTF-8'

# 全量编译（150 文件，不要加 --release 8）
$all = Get-ChildItem -Recurse -Path src -Filter *.java | Select-Object -ExpandProperty FullName
& "$jdk\bin\javac.exe" -d .tmp_rel8\release -encoding utf-8 -cp "lib/*" $all

# ⚠ 打包链路用的是 --release 8，必须单独验一遍（见 §九）
npm run check:java8

# 9 个自检（共 411 断言；ScriptDrawTest 需要 GPU，无 GPU 会记 SKIP）
foreach ($t in 'ScriptSelfTest','ScriptFieldsTest','ScriptPhysicsTest','ScriptAiTest',
               'ScriptPrefabTest','ScriptPerfTest','ScriptContractTest','ScriptLayerTest') {
  & "$jdk\bin\java.exe" -cp ".tmp_rel8\release;lib/*" "Studio.runtime.$t"
}
# 绘制层像素回归（需要真 GL：离屏 FBO）
& "$jdk\bin\java.exe" --enable-native-access=ALL-UNNAMED `
  --add-opens=java.desktop/sun.awt=ALL-UNNAMED --add-opens=java.desktop/sun.java2d=ALL-UNNAMED `
  -cp ".tmp_rel8\release;lib/*" -Djava.library.path=lib Studio.runtime.ScriptDrawTest

# 真实打包链路（javac --release 8 + jar + jpackage + zip，全 5 段）
node web/tools/package-bwe.mjs <工程.bwproj> --name BWECheck

# 像素回归（离屏 GL，需要显示设备）
& "$jdk\bin\java.exe" --enable-native-access=ALL-UNNAMED `
  --add-opens=java.desktop/sun.awt=ALL-UNNAMED --add-opens=java.desktop/sun.java2d=ALL-UNNAMED `
  -cp ".tmp_rel8\release;lib/*" -Djava.library.path=lib `
  Studio.runtime.OffscreenFrameDump .tmp_rel8\lead-build\Build\boot.json out\demo 90 960 540
node web/tools/frame-diff.mjs baseline.png out\demo.png

# API 四方一致性
node web/tools/verify-apidocs.mjs

# Web 编辑器
npm run typecheck ; npm run build
```

## 九、Java 8 兼容性事故（本轮修的一个「用户点预览就失败」的 bug）

### 现象
用户点「预览 / 打包」时直接报错：
```
✗ javac 退出码 1
ScriptPerfTest.java:87: 错误: 不兼容的类型: Charset无法转换为 String
   System.setOut(new PrintStream(engineNoise, true, StandardCharsets.UTF_8));
```

### 根因
**两条编译链路的 `--release` 不同**：
- 我本地自检：`javac`（JDK 25 默认，等价 Java 25）→ 用 `PrintStream(OutputStream, boolean, Charset)` 没问题
- **打包链路**（`web/tools/serve.mjs:451`、`web/tools/package-bwe.mjs:1288`）：`--release 8` →
  该重载是 **Java 10+ 才有**，Java 8 只有 `PrintStream(OutputStream, boolean, String)`

**盲区在哪**：`src/Studio/runtime/` 里同时住着 **17 个产品类和 7 个 `*Test` 类**，
打包链路把整个目录都编进去。所以任何一个**测试文件**用了 Java 9+ API，
就会让**用户的打包失败** —— 而本地自检全绿，完全看不出来。

### 修法
`PrintStream(engineNoise, true, "UTF-8")` + `try/catch UnsupportedEncodingException`
（Java 8 的 String 重载声明了受检异常，必须兜住；UTF-8 是 JLS 强制存在的字符集，实际走不到 catch）。

### 防复发：新增 `web/tools/check-java8.mjs`
**用与打包链路完全相同的参数**（`--release 8 -encoding UTF-8 -Xlint:-options -cp "lib/*"`）
+ 完全相同的源文件选择规则（`src/Studio/runtime/*.java` 排除 `GameLauncher.java`）编译一遍。

- 已挂进 `package.json`：`npm run check:java8` / `npm run check`（typecheck + java8）
- **变异测试自证**：把它改回 `Charset` 版本 → `check-java8.mjs` 退出码 1，
  并精确指出 `ScriptPerfTest.java:94: 不兼容的类型: Charset无法转换为String`；改回后恢复绿。

**教训**：只测「我本机的编译方式」是不够的，**必须测「用户实际走的编译方式」**。
这次的差异就是一个 `--release` 参数，但它把「全绿」变成了「点预览就崩」。

### 端到端验证（不只是编译过）
```
node web/tools/package-bwe.mjs <工程> --build-only   → exit=0（javac + jar 通过）
node web/tools/package-bwe.mjs <工程> --name BWECheck → exit=0（全 5 段：编译/收 lib/jpackage/打 zip）
   产出：BWECheck-win64.zip 50.3MB + app/bwe-runtime.jar
用打包出来的 bwe-runtime.jar 跑 ScriptSelfTest → 109/109 ALL PASS
```

---


## 十、游戏运行时 UI 的两个显示 bug（用户报告「UI 偏移 / 层级问题」）

> 用户反馈：**游戏运行时（预览 / 打包后）的 HUD 和对象位置看起来不对**，
> 而且「一直都有，只是现在更明显」。
> 这两个都是**既有 bug**，不是本轮性能优化引入的（已用改动前基线截图逐像素证实）。

### 10.1 圆角矩形里有个三角形楔形空洞（真「层级错乱」错觉）

**现象**：HUD 面板（`bwe.draw.rect(..., {radius: 8})`）上有一条**斜切的暗色楔形**贯穿面板，
看起来像「某个半透明图层叠错了」或「面板被切掉一角」。

**根因**：`ScriptRender.fillRoundRect()` 用 `GL_TRIANGLE_FAN` 从中心连到四角圆弧。
GL 的 fan 只生成 `(v0,v1,v2), (v0,v2,v3) … (v0,v_{n-1},v_n)`，**不会自动闭合** ——
缺 `(v0, v_n, v_1)` 这个收尾三角形，于是最后一条边（左边：左下角 → 左上角）
与中心之间留下一个三角空洞。

**修法**：扇形末尾**重复一次起点顶点**，用退化三角形补上收尾。这是 fan 画闭合多边形的标准做法。

**验证**（隔离复现 + 变异测试）：
- 单独画那一个 `rect(radius=8)`，逐行量填充宽度：修复前左边界 18→135→18（X 形收窄），修复后**每行稳定 271px**
- **变异测试**：把「重复起点」那一行删掉 → `ScriptDrawTest` 立刻 FAIL，并打印
  `minW=136 maxW=251 spread=115` 加整行宽度序列 —— 楔形被完整捕获
- 改动前的基线截图与改动后对比，楔形消失

### 10.2 高 DPI 屏 HUD 文字发虚（真「偏移」错觉）

**现象**：1707×1067 @1.5 缩放的屏幕上，HUD 文字边缘模糊、看起来「位置飘」。

**根因**：投影用**逻辑**尺寸（1707），`glViewport` 用**物理**尺寸（2560），
于是 GL 把整幅画面放大 1.5 倍。而文字纹理是按**逻辑字号**生成、再用 `GL_NEAREST`
非整数拉伸 1.5 倍 ⇒ 锯齿 / 发虚。

**修法**：文字纹理按「逻辑字号 × 物理/逻辑倍率」**超采样**生成，
贴出去时再除回该倍率（保持逻辑尺寸不变）。
`displayScale()` 提供倍率，并钳在 `[0.5, 4]` 防止异常窗口尺寸把纹理撑爆。

**验证**：
- scale=1（低 DPI）时**逐像素 diff=0**（完全向后兼容）
- 高 DPI 真窗口截图对比，文字边缘变清晰
- 文本纹理缓存 key 改成按**实际像素字号**区分，避免不同 DPI 之间串用错误尺寸的缓存

### 10.3 新增两个像素级回归测试

| 测试 | 项数 | 需要 GPU | 抓什么 |
|---|---|---|---|
| `ScriptLayerTest` | 9 | 否 | 绘制层级顺序（layer→z→y）：改 z 后必须重排、互换 y（总和不变）必须重排 |
| `ScriptDrawTest` | 4 | **是**（离屏 FBO） | 圆角矩形填充无空洞、宽度一致、四角真圆、中心实心 |

`ScriptDrawTest` 在没有 GPU 的环境（CI / 无显示 session）会**记 SKIP 而不是失败** ——
这样它既能进日常回归，又不会让无显卡环境误报。

### 10.4 顺带修掉的一处性能缓存缺陷（是我这轮引入的）

`TopDownRuntime.sortedActors()` 的排序缓存第一版用「可见数量 + 所有 y 的**总和**」判断要不要重排，
有两个致命漏洞：

1. **脚本改 `z` 但不动 `y`**（或编辑器「上移一层 / 置顶」）⇒ y 总和不变 ⇒ 不重排 ⇒
   **画面层级不变**，用户看到「点了置顶没反应」。
2. **两个对象互换 y** ⇒ 总和不变 ⇒ 不重排 ⇒ 遮挡关系错乱。

真正的排序键是 **layer → z → y** 三元组。改成把每个可见对象的 `(layer,z,y)`
按存储顺序逐项比较（O(n) 纯数值比较，仍比每帧 sort 的 O(n log n)+分配便宜），
**不会漏判也不会撞车**。

**变异测试**：把判据改回「数量 + y 总和」→ `ScriptLayerTest` 立刻 FAIL 4 条，
顺序恒为 `[bottom, mid, top]`（置顶完全无效）—— 正是用户描述的症状。

---

## 十一、本轮最终回归矩阵（9 个测试类）

```
ScriptSelfTest      109 PASS      ScriptFieldsTest    43 PASS
ScriptPhysicsTest    47 PASS      ScriptAiTest        51 PASS
ScriptPrefabTest     97 PASS      ScriptPerfTest      28 PASS
ScriptContractTest   19 PASS      ScriptLayerTest      9 PASS
ScriptDrawTest        4 PASS（需 GPU；无 GPU 记 SKIP）
──────────────────────────────────────────────────────
                                合计 407 + 4 = 411 项
```
全量编译（150 文件，JDK 25）exit=0；打包链路编译（26 文件，`--release 8`）exit=0。

---
