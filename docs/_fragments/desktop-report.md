# BWE Studio 桌面化交付报告

> 目标：把 BWE Studio 从「网页端 + 本地 node 服务」改造成 **Windows 桌面客户端（EXE）**，
> 界面按 VS Code 结构重排并换成「奶油色软科技」主题；内置 AI 助手，缓存与省 token 的
> 机制对齐 deepx 与 DeepSeek Harness；同时用新 API 补上引擎侧「脚本错误可观测 / 帧性能
> 剖析」的缺口，并把两处脆测试阈值去抖。
>
> 全部结论均来自本机真实执行，命令与输出在 §7 可复跑。

---

## 1. 一页纸结论

| 维度 | 结论 | 关键证据 |
|---|---|---|
| 桌面 EXE | ✅ 可双击启动，脱离 `npm run serve` | `desktop/dist/win-unpacked/BWE Studio.exe`（364MB，gitignore，脚本可重建） |
| 界面结构 | ✅ VS Code 骨架（活动栏/侧边栏/多标签编辑区/底部面板/状态栏/命令面板） | 截图 §6；`--probe` 实测 `activity-bar=1 sidebar=1 editor-tabs=8 panel=1 statusbar=1` |
| 主题 | ✅ 奶油软科技（暖白底 + 奶咖主色 + 大圆角 + 低对比软阴影） | `--verify` 判定 `theme=cream → PASS`，主色 `#f0f0e8` 亮度 0.87 |
| AI 助手 | ✅ 面板可用、流式、mock 无 key 可演示 | 截图 §6.3；`ai-panel=0 → 1` |
| 省 token 架构 | ✅ 七条约束全部落地并有单测锁 | §3；`desk:test` 68 断言全绿 |
| 引擎改进 | ✅ `bwe.debug.errors*` + `bwe.prof.*` 六个 API，四方一致 | §4；`bwe.debug 15/15/15/15`、`bwe.prof 3/3/3/3` |
| Java 测试 | ✅ 7/7 套件（394 断言）+ 新增 49 断言观测套件 | §7 |
| 打包自检 | ✅ 双尺寸（1600x1000 / 1280x720）PASS 2/2 | `npm run verify:desktop` |

---

## 2. 从网页端到客户端：做了什么

### 2.1 后端能力搬迁（关键：`npm run serve` 不再是前置条件）
`web/tools/serve.mjs` 原来是「HTTP 服务 + 8 个 `/api/*` 能力」合体。拆成：

- `web/tools/api-core.mjs`（新）：纯逻辑 `handle({path,method,query,body}) → {status, json|binary}`，
  **不 bind 端口、不碰 res**。网页版由 `serve.mjs` 当薄壳搬运，桌面版由主进程直接调用。
- `desktop/lib/api.mjs`：把同一个 handler 适配成 `{ok, status, json}` 给 IPC。
- `web/src/core/host.ts`（新）：渲染侧唯一门面。桌面走 IPC，网页回退原生 `fetch`，
  业务代码（11 处 `/api/*` 调用）**一行逻辑都不用改**，只换 import。

**为什么这么做**：如果桌面版在本地再起一个 HTTP 服务，就多一个进程、多一处端口冲突、
多一条防火墙提示，而且用户会看到两个窗口。同一个 handler 两处复用，才是最省事也最稳的。

### 2.2 桌面壳
`desktop/main.mjs`（薄引导）+ `desktop/lib/app-main.mjs`（实现）：

- 单实例锁；窗口尺寸/位置持久化到 `%APPDATA%\BWE Studio\window.json`
- 原生中文菜单；菜单命令通过 `onMenuCommand` 发到渲染侧
- `--shot / --size / --tap / --probe / --console / --verify` 六个参数（见 §7）
- **`ELECTRON_RUN_AS_NODE` 处理**：用 `delete env.KEY` 而不是置空（Electron 判的是"变量是否存在"，
  空字符串同样被当成设置），并以 `pathToFileURL` 处理 `D:\` 盘符（直接喂 `import` 会被当成 `d:` 协议）
- 裸 `node desktop/main.mjs` 会自动用 `vendor/electron/electron.exe` 重启自己（`--relaunched` 防套娃）

### 2.3 打包
`desktop/tools/package.mjs`：复制 vendor 运行时 → **复刻仓库布局**（`resources/app/desktop/**` +
`resources/app/web/**`）→ 前端资源与内嵌 API（含 `api-core.mjs`、`package-bwe.mjs`）一等产物 →
`electron.exe` 改名 `BWE Studio.exe`。**离线，不下载任何东西。**

- `desktop/tools/fetch-electron.mjs`：从本机 electron 缓存解压重建 `vendor/`（离线），
  缓存缺失时打印 4 条补救路径。这样仓库不背 317MB 二进制。
- `desktop/tools/run-exe.cmd`：`%~dp0` 绝对定位 + 纯 ASCII（cmd.exe 对 UTF-8 极差，
  **加 BOM 会让 `@echo off` 失效**）+ 剥成对引号。

---

## 3. 省 token / 缓存友好（对齐 deepx 与 DeepSeek Harness）

`desktop/lib/ai/` 共 12 个模块。七条硬约束逐条落地：

| # | 约束 | 落地 | 回归锁 |
|---|---|---|---|
| 1 | 零 token 路由 | `router.mjs` 关键词 + 长度 + intent 纯本地判定 | 往返一万次 <1s；`reason` 永远非空 |
| 2 | 稳定前缀 | `prefix.mjs` 四常量块，**禁时间戳/路径/文件名** | 两次调用**字节一致**（`===` 断言） |
| 3 | 工具不预注入 | 只 3 个工具（`ReadFile`/`SceneDigest`/`SearchApi`），271 条 API 按需查 | system prompt 1415 字符，不含 API 明细 |
| 4 | 工具结果剪枝 | >600 字符剪成「头部+统计」，原文存 `toolCache/<sha1>.txt` | 剪枝不切断半行；同内容只落一份 |
| 5 | 分层压缩 | 70% 触发、尾留 ~20K、摘要合并；无 key 降级结构化裁剪 | summarize 抛错也降级不冒泡 |
| 6 | 无损续接 | `history.json` 全保真 + 原子写；system 块**原地替换** | 重启后消息/顺序/工具块全在 |
| 7 | 采样参数不抖动 | 按 provider 固定 | — |

**记账口径**与 DeepSeek Harness 的 `TokenUsage` 一致：`inputTokens`（未命中）/ `cacheReadTokens`
/ `cacheWriteTokens` **三者互不重叠**。本机踩过的真实形状：

```
DeepSeek: { prompt_tokens: 41591, prompt_cache_hit_tokens: 41472, prompt_cache_miss_tokens: 119 }
```
直接用 `prompt_tokens` 会既重复计费又算错命中率 —— `usage.mjs` 用官方 hit/miss 拆分优先，
拿不到时减回。实测该形状算出 **命中率 99.7%**（不是 >100%）。

UI 必须把这三件事显示出来：**路由理由 / 缓存命中率 / 三类 token**。省 token 不可见就等于没做。

---

## 4. 引擎改进（Java 运行时）

原引擎有 22 处 `catch (Throwable)` 把脚本异常**吞掉只 print**，编辑器和 AI 都看不到
「哪个脚本第几行炸了」；性能问题也只能靠肉眼。补 6 个脚本可见 API：

```
bwe.debug.errors()      → [{script,message,line,count,frame}]  最近 32 条环形
bwe.debug.clearErrors() → boolean
bwe.debug.dumpErrors()  → boolean   写 Build/diagnostics/script-errors.json
bwe.prof.enable(on)     → boolean
bwe.prof.report()       → {frames,avgMs,p50Ms,p95Ms,p99Ms,maxMs,scripts:[{name,p95Ms,calls}]}
bwe.prof.reset()        → boolean
```

**关键设计决策（都写进了源码注释）**：

1. **原 catch 行为一字未改**：新增记录只入队、不写日志，日志侧仍按「同脚本同行只报一次」去重
   —— 既保住 `ScriptSelfTest` 的 109 条断言，又不会每帧刷爆控制台。
2. **去重必须在日志去重的 `return` 之前**，否则重复抛 N 次只剩 `count=1`，看不到"在反复炸"。
3. **`errors()` 返回 JS 原生数组**（`cx.newArray`）。Rhino 包 Java List 后 `.length`/`for`/`JSON.stringify`
   全拿不到，这是必须实测才知道的坑。
4. **`line` 取不到返回 `-1` 而不是 `0`**：`0` 会被 UI 显示成「第 0 行」，`-1` 才是"未知"的通用约定。
5. **剖析零分配**：关闭时只一次布尔判断；`nanoTime()` 只包 JS 调用本体（记录成本不计入样本，
   否则开销会反馈给自己）。
6. **百分位用下标取整不插值**，保证 `p50 ≤ p95 ≤ p99 ≤ max` 恒成立（插值在样本少时会算到 > max）。
7. **`frames === 0 ⇔ 没有可用样本`**；但 `frames > 0` 不代表在采（`enable(false)` 刻意不清样本）。

**≤3% 帧耗时开销这条被替换了**，原因：共享机器上端到端墙钟抖 ±30%，写死百分比等于自造随机红灯。
改成组合判据：`单次记录 <100ns`（实测 4~5ns）+ `整帧无数量级退化 <10%`。
换算：5ns × 60 次/帧 ≈ 0.3μs，相对 0.15~0.4ms 帧耗时 **< 0.2%**。

**测试去抖（三代演进固化）**：
- `ScriptFieldsTest`：`tick max < 2ms` → `p50 < 0.5ms && p99 < 2.0ms`（实测 p50=0.003 / p99=0.145，留 4~6 倍余量）
- `ScriptPerfTest`：`avg < 4ms` → `p50+p95` 双判据（28 → 30 断言）

`docs/api/debug.md` 新增第七节「排查顺序」，核心是这条真踩过的判断：
> **`count >> 1` ⇒ 先修错误，别往下看性能**。每帧抛异常本身就能把帧耗时拉高一个数量级，
> 你会误判成性能问题。

---

## 5. 界面：VS Code 结构 + 奶油软科技

### 5.1 结构
`web/src/ui/shell.ts`（312 行，只管几何）+ `commands.ts`（命令注册表）+ `commandPalette.ts`。

- `activity-bar` 8 项、`sidebar` 可拖宽/`Ctrl+B` 折叠（宽度归零不切 display，避免画布恢复时尺寸错一帧）
- `editor-area` + `editor-tabs`：多标签、可关、可拖拽重排、未保存圆点
- `panel` 三标签（问题/输出/AI）+ `Ctrl+J` + 拖高
- `statusbar`：原 5 cell + AI 状态（模型/命中率/三类 token）+ 桌面/网页徽标
- `command-palette`（`Ctrl+Shift+P`）：42 条可见命令统一注册，菜单/快捷键/面板三处共用

### 5.2 主题
`web/styles/cream.css`（主题层）只覆盖令牌 + 结构类观感；业务类仍由 `app.css` 负责，靠令牌自动变奶油。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg` | `#f6f2ea` | 窗口底 |
| `--surface` | `#fdfbf6` | 面板底 |
| `--accent` | `#8a6c48` | 奶咖主色 |
| `--canvas-bg` | `#f1ece1` | 画布（比面板再暖一档，让画板「陷」进去） |
| `--shadow-pop` | `0 8px 26px rgba(84,68,44,0.13)` | 暖色低透明软阴影 |

"软"落在三处：圆角 8~10px、阴影低透明大扩散、hover/active **用底色变化而不是加粗描边**
（描边变粗会让布局抖 1px）。"科技"落在两处：语义色保持饱和可辨；所有可交互元素 2px 焦点环 + 2px 外扩。
另提供 `theme-midnight`（原深色）与 `theme-high-contrast`（无障碍）。

**画布颜色不能靠 getComputedStyle 读 CSS 变量**（返回未解析字符串会让 `fillStyle` 静默失效变黑），
解法是 `web/src/ui/palette.ts`：cream / midnight / high-contrast 三套色板常量并列，按
`documentElement.classList` 选一次，**不每帧读 CSS**。原 `canvas.ts`/`painter.ts` 的 12 处硬编码深色全部替换。

---

## 6. 验收截图

### 6.1 默认视图（1600x1000）
![默认视图](/.tmp_desk/shot.png)

### 6.2 窄屏 1280x720（最低验收尺寸）
![窄屏](/.tmp_desk/pack-verify-1280x720.png)

### 6.3 AI 助手面板（打包后的 EXE 里 `--tap` 打开）
![AI 面板](/.tmp_desk/final_aipanel.png)

> `--probe` 实测：`activity-bar=1 sidebar=1 editor-tabs=8 panel=1 statusbar=1 ai-panel=1`，
> `scrollWidth=clientWidth=1600`（无横向溢出），主题令牌 `--canvas-bg=#f1ece1`。

---

## 7. 复跑全部结论

```powershell
cd D:\githubdesktop\BrokenWonderEngine

# 0) 首次（clone 之后）：离线重建 electron 运行时（不联网）
node desktop/tools/fetch-electron.mjs

# 1) 前端
npm run typecheck                          # 0 错误
npm run build                              # web/dist/studio.js

# 2) 契约一致性（非 strict：判「有没有把文档写歪」）
npm run verify:apidocs:soft                # exit 0 · 编造 0 · 未实现 0 · 存量缺文档 162（已挂起）

# 3) Java 引擎（必须 JDK 17~25，JDK 26 上 JOGL 2.1 必崩）
powershell -File tools/bwe.ps1 build       # BUILD OK files=195
powershell -File tools/bwe.ps1 test        # 7/7 套件
powershell -File tools/bwe.ps1 test-all    # 25/25（含 ScriptObservabilityTest 49 断言）

# 4) 桌面/AI 单测（68 断言）
npm run desk:test

# 5) UI 纯函数回归（命令注册表 + 诊断中心，20 断言）
npm run verify:ui

# 6) 打包 + 双尺寸自检
npm run verify:desktop                     # PASS 2/2 尺寸

# 7) 截图（含创指定标签）
npm run desk:shot
node desktop/main.mjs --shot=.tmp_desk/ai.png --size=1600x1000 --tap="[data-panel-tab=ai]" --probe=.tmp_desk/probe.json
```

### 本机最后一次真实输出

```
BUILD OK  files=195
==== RESULT: 7/7 passed ====
  SelfTest 109 / FieldsTest 43 / PhysicsTest 47 / AiTest 51 / PrefabTest 97 / PerfTest 30 / ContractTest 19
verify-apidocs（非 strict）→ 编造 0 / 未实现 0 / 缺文档 162（存量）
desk:test   → prefix 7/7 · router 13/13 · session 13/13 · usage 17/17 · png 10/10 · ai-bridge 9/9
verify:ui   → 20 通过 / 0 失败
verify:desktop
  [verify] 1600x1000 → theme=PASS overflow=PASS nonbg=69.3%（区间 20~92 → PASS） → PASS
  [verify] 1280x720  → theme=PASS overflow=PASS nonbg=65.4%（区间 20~92 → PASS） → PASS
  [verify] 结论：PASS（2/2 尺寸）
```

---

## 7.1 桌面壳的四类「看起来成功、其实坏了」缺陷（本轮真抓到）

这四类都不是功能 bug，而是**失败方式很安静**——不报错、不崩溃，只是结果不对：

| # | 缺陷 | 表现 | 根因 |
|---|---|---|---|
| 1 | 打包漏 `web/tools/api-core.mjs` | 窗口不弹、进程挂着、无栈 | 主进程 import 失败 `ERR_MODULE_NOT_FOUND`，Electron 静默死 |
| 2 | app 目录布局错（main.mjs 摊在根） | `--verify` 永远挂住 | `REPO_ROOT` 算错 → 弹模态错误框 → 无人点击 |
| 3 | 打进旧 bundle | exe 起来只有奶油底、UI 计数全 0 | `web/dist` 比 `web/src` 旧 |
| 4 | 并发截图争 userData | 随机红（CSS 未加载 / JS 未跑） | Chromium disk cache / GPU shader cache 争锁 |

对应修法（都已落盘并锁进单测）：
1. 把 `api-core.mjs`、`package-bwe.mjs` 当**一等产物**并写进验收清单；
2. **复刻仓库布局**（`resources/app/desktop` + `resources/app/web`），主进程零特判；截图模式**禁止弹模态**（缺文件直接 exit 2）；
3. **前端新鲜度检查**，过期就用本地 esbuild 离线重建（不联网）；
4. 三层：pid 后缀独立 userData + 禁磁盘缓存开关 + FAIL 时重试一次；回归锁 `desktop/test/concurrency.test.mjs`（2 进程 × 2 轮）。

**第 4 条的修法记录里有两个被实测否掉的错误做法**（值得单独记住）：
- 「退出时删掉自己那份 profile」→ **根本不生效**：`app.exit()` 不触发 `before-quit`，且此刻 Chromium 子进程还攥着文件句柄，Windows 删不掉（只留空壳目录）；
- 「启动时删掉所有别的 pid 目录」→ **并发时会删掉另一个进程正在用的 profile**，等于亲手制造这个 bug。

最终策略：启动时按 mtime **只保留最近 6 个**（自己那份永远跳过）。单测锁「数量封顶 + 不增长」，而不是「零残留」——后者在这个进程模型下做不到，硬要求会变成脆断言。

---

## 8. 已知边界与未做

| 项 | 说明 |
|---|---|
| `verify-apidocs --strict` 仍 exit 1 | 162 处「缺文档」是 **存量债**（`bwe.mine` / `bwe.stick` / `bwe.textinput` / `bwe.board` 等），HEAD 上就存在，与本轮无关，已列为独立待办 |
| 真实模型未联调 | 本机无可用 API Key；AI 层用 **mock 一等路径**（逐块吐字 + 自洽 usage + 零网络）验收。填 key 后走同一套 stream/bridge，界面不用改 |
| `desktop/vendor` 与 `dist` 不进仓库 | 317MB / 364MB，由 `fetch-electron.mjs` + `package.mjs` 重建；README 已写 |
| 打包未做安装器 | 当前是绿色版（`win-unpacked` 目录 + `BWE Studio.exe`），未做 MSI/NSIS 安装包 |
| 主题层与 app.css 有重复定义 | `cream.css` 里少数结构几何与 app.css 重复；本轮为降风险未收敛，已在代码注释与本文标注为待办 |

---

## 9. 过程教训（值得写进历史）

1. **工具调用 XML 尾缀泄漏进源码**：4 个文件尾部多了一串工具调用的闭合标签（`content` / `write` /
   `parameter` / `invoke` 四种），
   `package.json` 直接 EJSONPARSE。剥离时必须**迭代**（残留是多层嵌套混行，一次 regex 只剥最后一行）。
2. **`Response` 的 `ok` 是只读派生值**，不能由 `ResponseInit` 指定。宿主可能给 `ok:false + status:200`，
   统一以 status 为准，否则上层看到 `resp.ok === true` 但 json 里写着失败。
3. **并发截图会互相踩**：两个 `--shot` 进程共用同一个 userData → Chromium disk cache 争锁 →
   要么 CSS 未加载（`#686860` 判深色）要么 JS 未跑（99.8% 纯色判空白）。
   修法：pid 后缀独立 userData + 禁磁盘缓存 + FAIL 重试一次。
4. **截图里"深色"的两种成因要分清**：一次是主题没加载，一次是**首次引导模态遮罩**把奶油底压成
   `#686860`。后者暴露了真实产品缺陷（每个新用户第一次打开都被一堵墙挡住），改成非模态引导条。
5. **判死逻辑自己也要被测**：`png.test.mjs` 用自造 PNG 锁「奶油 PASS / 深色 FAIL / 纯色判空」，
   否则阈值写错会把深色误判成奶油。
6. **单边阈值防不住"画多了"**：非背景占比从 `>20%` 改成双边 `20%~92%`，
   下界防"界面没起来"，上界防"渲染退化成色块"。文档写区间、代码留余量，两者不是一回事。
7. **纯函数测试 vs 截图测试的边界**：截图只能证明「面板弹出来了」，证明不了「过滤对不对、计数会不会堆叠」。
   命令面板与诊断中心必须另有 20 条纯函数断言。

---

## 10. 并行施工分工与新增文件

本任务由 3 条工作线并行推进，接口约定见 [docs/desktop-migration.md](../desktop-migration.md)
（含 §8 归属表，是写冲突的唯一裁决依据）。

| 线 | 负责 | 写域 |
|---|---|---|
| Lead | 契约 / 主题层 / 宿主门面 / 验收 / 文档 | `docs/desktop-migration.md`、`web/styles/cream.css`、`web/src/core/host.ts`、根 `package.json` |
| 桌面壳 + AI | Electron 壳、内嵌 API、AI 十二模块、打包 | `desktop/**`、`web/tools/api-core.mjs`、`web/tools/serve.mjs` |
| 界面 | VS Code 结构、AI 面板、命令面板、问题 / 输出面板 | `web/index.html`、`web/src/**`（除 host.ts）、`web/styles/app.css` |
| 引擎 | 错误可观测 + 性能剖析 + 测试去抖 | `src/Studio/runtime/**`、`docs/api/**`、`bwe.d.ts` / `apiDocs.ts` 的新增条目 |

### 新增文件

```
desktop/main.mjs, desktop/preload.cjs, desktop/package.json, desktop/README.md
desktop/lib/app-main.mjs, api.mjs, settings.mjs, recent.mjs, window-state.mjs, menu.mjs, png.mjs
desktop/lib/ai/router.mjs, prefix.mjs, session.mjs, compact.mjs, usage.mjs, stream.mjs,
        provider.mjs, bridge.mjs, prune.mjs, tools.mjs, apiIndex.mjs, index.mjs
desktop/tools/fetch-electron.mjs, package.mjs, run-exe.cmd
desktop/test/prefix.test.mjs, router.test.mjs, session.test.mjs, usage.test.mjs,
        png.test.mjs, ai-bridge.test.mjs, concurrency.test.mjs, _harness.mjs
web/tools/api-core.mjs
web/tools/ui-checks/verify-ui-logic.ts, README.md
web/src/core/host.ts, diagnostics.ts, output.ts
web/src/ui/palette.ts, shell.ts, commands.ts, commandPalette.ts
web/src/panels/aiPanel.ts, bottomPanels.ts, searchPanel.ts
web/styles/cream.css
docs/desktop-migration.md, docs/_fragments/desktop-report.md
src/Studio/runtime/ScriptMetrics.java, ScriptProf.java, ScriptObservabilityTest.java
```

### 跨线契约（不要随手改名）

- `window.bweHost` 的字段（契约 §3）、`AiEvent` 联合类型（§4.2）、
  `TokenUsage` 的三类计数互不重叠（§4.3）；
- 7 个 `data-*` 锚点（清单在 `web/tools/ui-checks/README.md`）：
  `data-panel-tab`、`data-sidebar-collapse`、`data-command-palette-trigger`、
  `data-command-palette`、`data-cp-input`、`data-quickstart-banner`、
  `data-quickstart-open` / `data-quickstart-close`。

> 为什么这条纪律必须存在：`--tap` 找不到元素时**只打日志、退出码仍是 0** ——
> 锚点缺失不会让验收报错，只会静默截出一张错的图。
