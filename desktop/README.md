# BWE Studio 桌面版（desktop/）

Electron 37.10.3 桌面壳 + 内嵌 API + AI 层。**离线可用，不需要 `npm install`，不需要 `npm run serve`。**

契约见 [`docs/desktop-migration.md`](../docs/desktop-migration.md) §3 / §4 / §8。

## 首次从仓库跑起来（三步）

```bash
# 1) 重建 Electron 二进制（离线：从本机 electron 缓存解压，不联网）
node desktop/tools/fetch-electron.mjs

# 2) 构建前端（bundle 是 web/dist/studio.js）
npm run build

# 3) 启动桌面版
npm run desk
```

### 关于 `desktop/vendor/` 与 `desktop/dist/`（clone 后必读）

这两个目录都在 `.gitignore` 里，**仓库不背二进制**（合计约 680MB）：

| 目录 | 大小 | 内容 | 怎么重建 |
|---|---|---|---|
| `desktop/vendor/electron/` | ~317MB | Electron 37.10.3 win32-x64 运行时 | `node desktop/tools/fetch-electron.mjs`（**离线**，从本机 `%LOCALAPPDATA%\electron\Cache` 解压，不联网） |
| `desktop/dist/` | ~364MB | 打包产物 `BWE Studio.exe` | `node desktop/tools/package.mjs`（即 `npm run desk:pack`） |

所以别人 clone 完仓库后：

- **只想跑编辑器** → 跑上面三步即可（vendor 是 `npm run desk` 的必要前提）；
- **想拿到 EXE** → 再跑 `npm run desk:pack`（或 `npm run desk:verify` 打包并自检）。

`fetch-electron.mjs` 找不到本机缓存时会打印四条补救路径（`BWE_ELECTRON_ZIP` 环境变量 /
手工把 zip 放进 `desktop/vendor/` / 下载 URL / 缓存目录位置），不会只说一句 "not found"。
`package.mjs` 发现 vendor 缺失时会**自动调用** `fetch-electron.mjs`，所以通常直接跑打包也行。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run desk` | 启动桌面版（等价 `node desktop/main.mjs`，会自动用 vendor 里的 Electron 重启自己） |
| `npm run desk:shot` | 截图到 `.tmp_desk/shot.png`（1600x1000） |
| `npm run desk:pack` | 打包出 `desktop/dist/win-unpacked/BWE Studio.exe` |
| `npm run desk:verify` | 打包 + 以 `--shot --verify` 真实启动产物做自检 |
| `npm run desk:test` | 四个单测（prefix / router / session / usage）；另有 png / ai-bridge / concurrency 三个见「验收命令清单」 |

## 命令行参数（全部给主进程，`--shot` 与 `--verify` 是验收用的）

```
node desktop/main.mjs [--console] [--shot=<png>] [--size=WxH] [--probe=<json>] [--tap=<sel[,sel]>] [--verify]
```

- `--console`：主进程与渲染进程日志同时打到 stdout（默认只进内存缓冲）。
- `--shot=<png>`：启动 → 等页面 ready（`did-finish-load` + 2s）→ `capturePage` → 存 PNG → 退出。
  退出码：`0` 成功 / `3` 判定失败（页面没加载、截图空白、`--verify` 下主题或布局不达标）/ `4` 截图异常。
- `--size=WxH`：截图窗口尺寸，默认 `1600x1000`。截图模式会**强制 dpr=1**，
  所以这个值就是逻辑像素尺寸（高 DPI 屏上也不会被缩放误导）。
- `--probe=<json>`：额外输出几何探针（区域宽度、横向溢出、UI 计数、主题令牌），并落盘 JSON。
- `--tap=<sel[,sel]>`：截图前依次点击这些元素（逗号分隔），用来打开非默认标签。
  每次点击后等 250ms。**找不到元素不判死**（打印 `[tap] 未找到 …`，截图照出）。
- `--verify`：严格模式。**非奶油主题 = FAIL**、**横向溢出 = FAIL**、**非背景像素不在 20%~92% = FAIL**。
  `--verify` 会**自动跑两个尺寸**（1600x1000 → 1280x720），任一尺寸失败即整体 exit 3；
  同时**忽略** `--tap`（自检只针对干净默认视图）。
  双尺寸的理由：1280x720 是本次交付明写的最低验收尺寸，而**溢出类缺陷只在窄屏暴露**，
  只截 1600x1000 会让窄屏回归漏过去。
  非背景占比**双边**的理由：单边下界只防「界面没起来」（只剩底栏），
  防不了「渲染退化成噪点/纯色块」——那种图前景接近 100%，看着"内容很多"，其实什么都没画对。

## 验收命令清单

> README 是唯一会被后来人读的东西。**验收命令散落在对话里等于没有** —— 所以集中列在这里。
> 全量验收就一条条往下跑，**任一失败即不可交付**。

```bash
# ── 0. 首次（clone 后只跑一次）────────────────────────────────
node desktop/tools/fetch-electron.mjs        # 离线重建 vendor（不联网）

# ── 1. 前端 ──────────────────────────────────────────────────
npm run typecheck                            # TS 0 错误
npm run build                                # web/dist/studio.js

# ── 2. Java 引擎（需要 JDK 25，JDK 26 上 JOGL 2.1 必崩）────────
node web/tools/verify-apidocs.mjs            # API 四方一致（非 strict）
powershell -File tools/bwe.ps1 build         # Java 编译
powershell -File tools/bwe.ps1 test          # 7 套件

# ── 3. 桌面壳 / AI 层单测 ─────────────────────────────────────
npm run desk:test
#   等价于逐个跑：prefix / router / session / usage
#   另有三个（重点，别漏）：
node desktop/test/png.test.mjs           # 截图判死阈值（10 项：主题/空白/双边非背景）
node desktop/test/ai-bridge.test.mjs     # AI 端到端链路（9 项：mock 流式/工具/取消/压缩）
node desktop/test/concurrency.test.mjs   # 并发截图回归（2 进程 × 2 轮，两边都必须出奶油图）

# ── 4. 打包 + 产物自检（双尺寸断言）───────────────────────────
node desktop/tools/package.mjs --verify
#   期望：✓ 产物清单全绿 → 启动 dist/win-unpacked/BWE Studio.exe --shot --verify →
#         [verify] 1600x1000 → theme=PASS overflow=PASS nonbg=…% → PASS
#         [verify] 1280x720  → theme=PASS overflow=PASS nonbg=…% → PASS
#         [verify] 结论：PASS（2/2 尺寸）

# ── 5. 截图验收（看具体界面，含 AI 面板证据图）─────────────────
node desktop/main.mjs --shot=.tmp_desk/shot.png --size=1600x1000 --console
node desktop/main.mjs --shot=.tmp_desk/ai.png --size=1600x1000 --tap="[data-panel-tab=ai]" --probe=.tmp_desk/ai.json --console
node desktop/main.mjs --shot=.tmp_desk/narrow.png --size=1280x720 --probe=.tmp_desk/narrow.json --console

# ── 6. 打包产物也能截（双击 exe 那条路）──────────────────────
"desktop/dist/win-unpacked/BWE Studio.exe" --shot=D:/tmp/ai.png --size=1600x1000 --tap="[data-panel-tab=ai]" --console
desktop\tools\run-exe.cmd --shot=D:/tmp/ai.png --size=1600x1000 --tap="[data-panel-tab=ai]"
```

判读标准：
- `theme=cream → PASS` 出现，`midnight → FAIL` 不出现；
- `overflow=PASS`（横向无溢出）；
- `nonbg` 落在 **45%~75%**（正常界面实测区间）：低于 20% 说明界面没起来只剩底栏，
  高于 92% 说明底色没铺开或渲染退化成色块；
- `ai-panel=1` 出现在 `--tap="[data-panel-tab=ai]"` 之后（默认视图应为 0）。

### 验收命令示例

```bash
# 默认视图截图
node desktop/main.mjs --shot=.tmp_desk/shot.png --size=1600x1000 --console

# 打开「AI 助手」面板再截图（推荐用 data-panel-tab 锚点，不依赖 DOM 顺序）
node desktop/main.mjs --shot=.tmp_desk/ai.png --size=1600x1000 --tap="[data-panel-tab=ai]" --console

# 几何探针（判定 1280x720 下是否横向溢出）
node desktop/main.mjs --shot=.tmp_desk/s.png --size=1280x720 --probe=.tmp_desk/probe.json --console

# 打包并自检
node desktop/tools/package.mjs --verify
```

### 打包产物怎么启动

**推荐**（参数一定能被解析到）：

```bash
"desktop/dist/win-unpacked/BWE Studio.exe" --shot=D:/tmp/ai.png --size=1600x1000 --tap="[data-panel-tab=ai]" --console
```

或者用启动脚本（纯 ASCII，从任意目录可用，自动带 `--console`）：

```bash
desktop\tools\run-exe.cmd --shot=D:/tmp/ai.png --size=1600x1000 --tap="[data-panel-tab=ai]"
```

直接双击 `BWE Studio.exe` 也可以（正常窗口模式，不带参数）。

> 若在**本终端环境**直接跑，注意本环境默认带 `ELECTRON_RUN_AS_NODE=1`。
> `main.mjs` 会检测到并自动用真正的 Electron 重启自己（`delete` 该环境变量后重启），
> 所以 `node desktop/main.mjs ...` 也能正常工作，不需要手动 unset。

## 截图模式输出怎么看

```
[shot] UI 骨架: activity-bar=1 sidebar=1 editor-tabs=8 panel=1 statusbar=1 ai-panel=1 palette=0 root=1
[shot] 主题样式: cream.css 已加载 · body 背景 rgb(246, 242, 234)
[probe] 宽度 activityBar: x=0 width=48 height=710
[probe] 溢出: 横向 否 · scrollWidth=1600 clientWidth=1600
[probe] 计数: activity-item=8 editor-tab=1 panel-tab=3 ai-panel=1 problem-row=0
[probe] 主题令牌: --canvas-bg=#f1ece1 --bg=#f6f2ea --surface=#fdfbf6
[shot] 尺寸 1600x1000 · 101017 字节 · 颜色数 420 · 背景 #f0f0e8 31.4% · 非背景像素 68.6% · 亮度 0.87
[shot] 主题: cream → PASS（主色 #f0f0e8（亮度 0.87），浅底主题）
[shot] result=OK loaded=true empty=false errors=0 theme=cream
```

- `ai-panel=0` 表示 AI 面板没打开（`--tap="[data-panel-tab=ai]"` 之后应该变 1）。
- `主题: cream → PASS` / `midnight → FAIL（期望奶油）`：主色亮度 < 0.35 判深色，`--verify` 下判死。
- `非背景像素` 太低（< 1.5%）或 `颜色数 < 8` 判为空白截图（白屏、纯色、加载占位）。

## 目录

```
desktop/
├── main.mjs              启动引导（环境变量纠偏 + 自动用 vendor Electron 重启）
├── preload.cjs           暴露 window.bweHost（契约 §3，字段名一个不改）
├── lib/
│   ├── app-main.mjs      窗口 / 菜单 / IPC / 截图模式 / 探针
│   ├── api.mjs           内嵌 API 适配（复用 web/tools/api-core.mjs）
│   ├── settings.mjs      设置 + API Key（safeStorage → encryptedApiKey）
│   ├── recent.mjs        最近工程（userData/recent.json）
│   ├── window-state.mjs  窗口尺寸位置记忆（userData/window.json）
│   ├── menu.mjs          中文原生菜单（模板是纯数据）
│   ├── png.mjs           截图自检（解码 / 空白判定 / 主题断言）
│   └── ai/               AI 层（见下）
├── tools/
│   ├── fetch-electron.mjs  离线重建 vendor（从本机 electron 缓存解压）
│   ├── package.mjs         离线打包 → dist/win-unpacked/BWE Studio.exe（+ --verify）
│   └── run-exe.cmd         打包产物启动脚本（纯 ASCII）
├── test/                 单测（prefix / router / session / usage / png / ai-bridge）
├── vendor/electron/      已解压 Electron（gitignore，可重建）
└── dist/                 打包产物（gitignore，可重建）
```

## AI 层（`lib/ai/`）

严格按契约 §4.3 七条：

| 文件 | 职责 |
|---|---|
| `router.mjs` | **零 token 本地路由**：中英关键词 + 长度 + intent，选 flash/pro，不发任何 LLM 调用 |
| `prefix.mjs` | **稳定前缀**：四个编译期常量块；同版本两次调用**字节级一致**（有单测断言 `===`） |
| `session.mjs` | history.json 无损 + summary.json（摘要+usage）+ 原子写；prompt 版本变化时**原地替换**该块 |
| `compact.mjs` | 超 70% 窗口触发，尾留 ~20K；有 key 走 LLM 摘要，**无 key 降级结构化裁剪**（不报错） |
| `usage.mjs` | `TokenUsage` disjoint 三计数；DeepSeek 把 cached 折进 `prompt_tokens`，**减回来**；给命中率与省钱估算 |
| `stream.mjs` | OpenAI 兼容 `/chat/completions` + SSE 解析 + 增量 tool_calls + `AbortController` 取消 |
| `provider.mjs` | deepseek / openai-compatible / **mock**（mock 是一等路径：本地模板、零网络、完整 usage） |
| `bridge.mjs` | 编排：路由 → 压缩 → 拼 messages → 流式 → 工具轮 → 落盘 → done |
| `tools.mjs` | 只有 3 个工具：`ReadFile` / `SceneDigest` / `SearchApi`（一次 ≤5 条） |
| `prune.mjs` | 工具结果 >600 字符剪成「头部 + 统计」，原文按 sha1 存 `toolCache/<sha1>.txt` |
| `apiIndex.mjs` | 解析 `web/src/data/apiDocs.ts` 建索引（不抄一份，避免与面板分叉） |

**存储位置**（`%APPDATA%\BWE Studio\`）：`settings.json` / `sessions\<hash>\{history,summary,meta}.json` / `toolCache\<sha1>.txt` / `window.json` / `recent.json`。

**API Key**：Windows 上经 `safeStorage`（DPAPI）加密后存 `encryptedApiKey`。
取不到 `safeStorage` 时退回明文并在设置里标 `insecure: true`（界面据此提示）。

**mock 模式**：没配 API Key 时也推完整流式事件（route → delta… → done，带 usage/cacheHitRate），
所以无 key 环境下界面可演示、可截图。`aiStatus()` 会返回 `provider:"mock"` + 一段中文说明。

## 已知约束

- **不联网、不装包**：Electron 用 `vendor/`，前端重建用仓库里已有的 `esbuild`（devDependency）。
- **截图模式每次进程用独立 userData**（`.shot-profile/<pid>`，启动时按 mtime 保留最近 6 个）。
  这是为了隔离 Chromium 的 disk cache / GPU shader cache —— 共用目录时**并发截图会争锁**，
  表现是随机的红：要么 CSS 没加载（截图变窗口默认底色 `#686860`，判深色 FAIL），
  要么 JS 没跑（截图 99.8% 纯色，判空白 FAIL）。**这类假红比逻辑错更危险**，
  因为它让人去改判定阈值而不是修环境。回归锁：`desktop/test/concurrency.test.mjs`。
- 截图模式还额外做了两件事抑制偶发：启动参数关掉 http-cache / gpu-shader-disk-cache；
  判定失败且疑似「首帧未渲染」（空白或主题撞深色）时**重排 800ms 后重试一次**，
  重试仍失败才判死（日志会同时打印两次的 `nonbg`，便于区分「偶发」和「真坏」）。
- 截图模式在 preload 里预置 `localStorage.bwe.seenQuickStart=1`：每次截图是全新 profile，
  否则「首次使用引导」每次都会弹，模态遮罩会把奶油底压成深色、直接污染主题断言。
- 打包后 `resources/app` **复刻仓库布局**（`app/desktop/**` + `app/web/**`）。
  不要改成「main.mjs 摊在 app 根」——那会让 `REPO_ROOT` 算错、找不到 `web/index.html`。
- `resources/app/web/tools/{api-core,package-bwe}.mjs` 是**启动必需**：漏了主进程会在
  模块加载期抛 `ERR_MODULE_NOT_FOUND`，Electron 表现为「窗口不出现、进程静默挂着」。
- 截图模式**禁止弹模态框**（否则无人点击 → `--verify` 永远挂住）。
- `desktop/tools/run-exe.cmd` 必须是**纯 ASCII**：UTF-8 带 BOM 会让 `@echo off` 失效
  （整个脚本被回显执行，中文注释也会变问号）。它用 `%~dp0` 定位，从任意目录都能跑。
- 打包前会检查 `web/dist/studio.js` 是否比 `web/src` 旧，旧了就用本地 esbuild 离线重建；
  重建失败（源码语法错）会**直接报错**而不是打进一个过期 bundle。
