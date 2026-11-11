# BWE Studio 编辑器界面截图（docs/readme/raw/editor/）

本目录里的 15 张 PNG 全部由**当前工作区的桌面壳真实渲染**：`node desktop/main.mjs --shot=...`
检测到不在 Electron 运行时后，自动用 `desktop/vendor/electron/electron.exe` 重启自身，
建真窗口 → 载入 `web/index.html` → `capturePage()` 落盘 → 退出。
不是设计稿、不是浏览器截图、不是历史旧图、没有一张是手工 P 的。

截图时间：2026-11-11 21:53~22:06（Asia/Shanghai）· 引擎与编辑器代码即当前工作区 HEAD
临时脚本与逐图原始日志：`/d/tmp/bwe_shots/`（不在仓库内，不参与提交）

## 判定标准（怎么排除「空白 / 白屏 / 假图」）

截图工具自己会打印一行可 grep 的结论，本目录的图全部取自那个行：

```
[shot] result=OK loaded=true empty=false errors=0 nonbg=xx.x% theme=cream
```

| 指标 | 来源 | 门槛 | 说明 |
|---|---|---|---|
| `loaded` | `pageState.finished && errors === 0` | 必须 `true` | 页面真的 `did-finish-load`，且主框架无 `did-fail-load` |
| `errors` | Electron `did-fail-load` 计数 | 必须 `0` | 任何资源加载失败都会破这条 |
| `empty` | `analyzePng`：非背景占比 < 1.5% 或颜色数 < 8 | 必须 `false` | 排除纯色白屏 |
| 非背景占比 `nonbg` | 与全图**众数色**不同的像素比例 | **> 25%**（本目录实际 39.9%~74.5%） | 太低=界面没渲染出来；太高=底色被填满/渲染成色块 |
| 颜色数 | 全图 distinct RGB 个数 | 记录（298~717） | 交叉验证「有内容」不是靠大面积单色冒充 |
| 骨架计数 | `probeUiSkeleton()` | 记录 | `activity-bar=1 sidebar=1 editor-tabs=N panel=1 statusbar=1`，证明是完整编辑器外壳而不是半个页面 |

`theme` 一栏默认期望奶油主题（`#f7f4ee`，亮度约 0.94）。**`midnight.png` 是有意违反这一条的**，
见下面逐图说明——它是唯一一张深色图，`theme=dark` 是预期结果，不是失败。

合并统计：**15 / 15 全部 `result=OK`、`errors=0`、`nonbg > 25%`。0 失败。**

### ⚠ 下表的度量口径

表里的「颜色数 / 非背景 / 众数色」三项**直接取自上面那行 `[shot]` 日志**，而 `analyzePng()`
（`desktop/lib/png.mjs`）统计时会做两件事，看数时别误会：

1. **抽样**：`step = floor(w*h/120000)`，1600×1000 图隔 13 个像素取 1 个（约 12.3 万个样本）；
2. **量化**：RGB 各截到 5 bit 再聚合，所以日志里的「众数色」是量化后的近似值
   （`#f8f8f0` 对应的真实像素是 `#fdfbf6`），「颜色数」是量化色桶数而非真实 distinct RGB 数。

为了不让口径混淆，另用 Pillow 逐像素（不抽样、不量化）独立复核了一遍，
真值与日志值的对照如下——**两套口径都判「有内容」，结论一致**：

| 文件 | 日志颜色数（5bit 量化） | Pillow 真实颜色数 | 日志非背景 | Pillow 非背景 | 日志众数色 | Pillow 真实众数色 |
|---|---|---|---|---|---|---|
| `hero.png` | 510 | 1804 | 59.9% | 60.2% | `#f8f8f0` | `#fdfbf6` |
| `script.png` | 696 | 2527 | 57.1% | 57.1% | `#f8f8f0` | `#fdfbf6` |
| `modules.png` | 477 | 1488 | 62.0% | 62.0% | `#f0f0e0` | `#f4f0e7` |
| `prefabs.png` | 544 | 1918 | 63.6% | 63.6% | `#f0f0e0` | `#f4f0e7` |
| `package.png` | 481 | 1522 | 39.9% | 39.9% | `#f8f8f0` | `#fdfbf6` |
| `package-workbench.png` | 298 | 2852 | 74.5% | 74.6% | `#f8f8f0` | `#fdfbf6` |
| `ai.png` | 515 | 2012 | 59.8% | 60.3% | `#f8f8f0` | `#fdfbf6` |
| `ai-models.png` | 505 | 1641 | 59.7% | 59.9% | `#f8f8f0` | `#fdfbf6` |
| `ai-thinking.png` | 498 | 1605 | 61.2% | 61.4% | `#f8f8f0` | `#fdfbf6` |
| `settings.png` | 494 | 1854 | 61.9% | 62.2% | `#f8f8f0` | `#fdfbf6` |
| `palette.png` | 314 | 20576 | 70.5% | 75.3% | `#e0d8d0` | `#e9e6e0` |
| `explorer.png` | 594 | 1803 | 64.7% | 64.9% | `#f8f8f0` | `#fdfbf6` |
| `lighting.png` | 713 | 2599 | 59.7% | 59.7% | `#f8f8f0` | `#fdfbf6` |
| `midnight.png` | 717 | 2349 | 57.6% | 57.7% | `#181820` | `#1a1c24` |
| `mobile.png` | 583 | 1824 | 61.6% | 61.6% | `#f0f0e0` | `#f4f0e7` |

`palette.png` 的两套口径差得最大（70.5% vs 75.3%，颜色数 314 vs 20576）：
命令面板遮罩是**半透明渐变**，量化会把大量相邻的暗色压进同一个 5bit 色桶 ——
这正是「量化色桶数」与「真实颜色数」在渐变画面上必然分叉的地方，不是哪一边算错了。

## 图 list

| 文件 | 尺寸 | 字节数 | 颜色数 | 非背景 | 背景色 | md5(前12) | 这张图证明什么 |
|---|---|---|---|---|---|---|---|
| `hero.png` | 1600×1000 | 140687 | 510 | **59.9%** | `#f8f8f0` | `ab07d5c04780` | 默认启动视图：活动栏 + 资源管理器 + 画布工具条 + 右侧检查器 + 底部面板 + 状态栏六块骨架齐全，README 主图用它 |
| `script.png` | 1600×1000 | 173651 | 696 | **57.1%** | `#f8f8f0` | `3a260c92fea8` | 内置俯视角 JS 示例载入后打开「剧本」：`.js-source` 代码框 453×598、编辑区文本 12417 字，证明脚本编辑器真的在编辑真实 JS |
| `modules.png` | 1600×1000 | 145972 | 477 | **62.0%** | `#f0f0e0` | `18b1facb8723` | 「模块与规则」面板载入 5 个内置规则包后：侧栏文本 1635 字、`规则包 Pack（5）`，证明积木式模块系统有内容而非空态 |
| `prefabs.png` | 1600×1000 | 153937 | 544 | **63.6%** | `#f0f0e0` | `3864ffdda076` | 「预制体」面板新建一个模板后：侧栏 579 字，含 `新预制体`、`放置到场景`、`复制`/`删除`、`名称/说明/类型` 属性表单 |
| `package.png` | 1600×1000 | 133715 | 481 | **39.9%** | `#f8f8f0` | `b9eb3e8d09fc` | 「打包」标签页：把当前工程打成 Windows EXE / Android APK 的入口与说明文案 |
| `package-workbench.png` | 1600×1000 | 129714 | 298 | **74.5%** | `#f8f8f0` | `37ca2f26acb3` | 点开「打包工作台」弹窗：1160×787 的模态层，证明打包不是一句文案而是有真实工作台 UI |
| `ai.png` | 1600×1000 | 130031 | 515 | **59.8%** | `#f8f8f0` | `06801608c40c` | AI 助手面板（459×648）默认态：模型下拉框 2 项、历史标签、「读工程摘要/读脚本诊断/直接改代码」能力说明 |
| `ai-models.png` | 1600×1000 | 123259 | 505 | **59.7%** | `#f8f8f0` | `5e021681eafe` | AI 面板注入多条真实模型后：`DeepSeek 聊天 · 已配置`、`moonshotai/Kimi-K2-Thinking（配置不全）`，证明模型清单与「哪条配齐了 key」的标记都会渲染 |
| `ai-thinking.png` | 1600×1000 | 125985 | 498 | **61.2%** | `#f8f8f0` | `297804c60eeb` | AI 面板「正在思考」态：面板文本出现 `正在思考（已思考 128 字）`、`看思考过程`，证明流式思考 UI 存在（瞬时状态，靠演示钩子冻结才截得到） |
| `settings.png` | 1600×1000 | 160386 | 494 | **61.9%** | `#f8f8f0` | `2bcf56529523` | 工程设置侧栏（599 字）：工程名/作者/格子尺寸/默认地图宽高/主音量等表单 |
| `palette.png` | 1600×1000 | 292046 | 314 | **70.5%** | `#e0d8d0` | `d4d571b65b2d` | 命令面板浮层真的弹出来了：`.command-palette` 680×620、48 个 `.cp-item`、骨架探针 `palette=1`，遮罩层把整图压暗所以亮度只有 0.70 |
| `explorer.png` | 1600×1000 | 154009 | 594 | **64.7%** | `#f8f8f0` | `890318252b79` | 示例工程载入后的「资源管理器 + 画布」：侧栏显示 `地面/墙体/玩家` 素材及「已被 N 个对象使用」，画布区 518×634 有网格读数 |
| `lighting.png` | 1600×1000 | 176687 | 713 | **59.7%** | `#f8f8f0` | `3556eaf3caad` | 右栏「光照」面板：`当前场景：荒原哨站`、`2D 光照 Lighting 2D`、`启用 2D 光照` 开关与夜色预览说明；713 色为全目录最高一档，与光照渐变的色彩特征吻合 |
| `midnight.png` | 1600×1000 | 171406 | 717 | **57.6%** | `#181820` | `f4d02ace4b03` | 深夜靛蓝主题确实生效：`body` 计算背景 `rgb(18, 20, 26)`、全图众数色 `#181820`，证明主题不是只有 CSS 变量而是整壳换色 |
| `mobile.png` | 1280×720 | 124124 | 583 | **61.6%** | `#f0f0e0` | `54e9293445a2` | 最窄验收尺寸下界面不塌：侧栏 232×460 / 编辑区 318×460 / 右栏 268×460 / 底部面板 1280×190，四栏都还在，`--verify` 判横向溢出 PASS |

## 逐图复现命令

全部命令都在仓库根 `D:\githubdesktop\BrokenWonderEngine` 下执行。单张约 20~40 秒，跑完即退（退出码 0 = 成功）。
每次都是**独立进程 + 独立 userData**，所以可以串行跑、互不影响。

`--tap` 与 `--tap-seq` 的区别：前者「点一次 → 截图」，后者能在同一次运行里做多步（`click:` / `wait:` / `probe:`），
这是本目录里好几张图能截到「有内容的中间态」的原因。

### 1. hero.png —— 默认启动视图

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/hero.png --size=1600x1000
```

不传 `--tap`。这张**逐字节可复现**（重跑一次 md5 仍是 `ab07d5c04780`）。

### 2. script.png —— 内置 JS 示例 + 剧本面板

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/script.png --size=1600x1000 \
  --tap='[data-load-js-demo="1"],[data-activity="script"]'
```

`[data-load-js-demo="1"]` 是画布工具条里 `left:-9999px` 的隐藏验收按钮（0 尺寸、不可聚焦），
它走的是「文件 → 俯视角 JS 示例」同一个 `loadExampleProject()`，并额外 `requestOpenScriptPanel("js")`。
逐字节可复现。

### 3. modules.png —— 模块与规则（需先点「载入内置模板」）

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/modules.png --size=1600x1000 \
  --tap='[data-activity="modules"]' \
  --tap-seq='click:.sidebar .btn.primary|1200'
```

**为什么不止一个 `--tap`**：内置示例工程的 `.bwproj` 里 `packs` 是空数组，
只切到「模块」页看到的是一片「还没有自己的规则包」空态。侧栏里那个 `.btn.primary`
就是 `载入内置模板` 按钮（`modulePanel.ts` 的 `loadTemplates()`，会推入 5 个内置规则包），
点它之后 `规则包 Pack（5）` 才有卡片可看。

### 4. prefabs.png —— 预制体（需先建一个）

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/prefabs.png --size=1600x1000 \
  --tap='[data-activity="prefabs"]' \
  --tap-seq='click:.sidebar .btn.primary|1000'
```

**注意这里踩到一个真实缺陷**：直接 `--tap='[data-activity="prefabs"]'` 而不带示例工程时面板是空态；
带上 `[data-load-js-demo="1"]` 反而会崩——`web/examples/俯视角JS示例.bwproj` 里**没有 `prefabs` 字段**
（`p.prefabs === undefined`），`renderPrefabPanel` 里 `store.project.prefabs.length` 抛
`Uncaught TypeError: Cannot read properties of undefined (reading 'length')`，
结果是侧栏只剩 `资源管理器 折叠 素材 模块 预制体 场景` 十几个字、内容全空。
该问题不是本次截图引入的（`model.ts` 的「旧工程补 `prefabs: []`」归一化只在读文件路径上生效，
内置示例走的是 `buildExample()` → `cloneProject()`，绕过了它）。
所以这张图的做法是：**不载入示例工程**，直接点「新建」按钮造一个预制体，
拿到 579 字的真实面板（列表项 + `名称/说明/类型` 属性表单）。

### 5. package.png —— 打包标签页

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/package.png --size=1600x1000 \
  --tap-seq='click:[data-activity="package"]|1200'
```

`[data-activity="package"]` 单击也能切过去，但用 `--tap-seq` 是为了在点击后等 1200ms 让标签页内容渲染完
（`--tap` 只等 250ms，这一页在慢机上容易截到半成品）。

### 6. package-workbench.png —— 打包工作台弹窗

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/package-workbench.png --size=1600x1000 \
  --tap='[data-activity="package"]' \
  --tap-seq='click:.editor-body .btn.primary|1800'
```

两步：先进打包标签页，再点页内那个 `打开打包工作台` 主按钮（`.editor-body .btn.primary`），
等 1800ms 让动态 import 的 `packageBwe.ts` 把模态层挂上（`.modal` 实测 1160×787）。

### 7. ai.png —— AI 助手默认态

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/ai.png --size=1600x1000 \
  --tap='[data-activity="ai"]'
```

`onActivity("ai")` → `focusAiPanel()`，把底部面板切到 AI 页并展开。

### 8. ai-models.png —— AI 面板的多模型清单

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/ai-models.png --size=1600x1000 \
  --tap='[data-demo-models="1"],[data-activity="ai"]'
```

`[data-demo-models]` 是隐藏验收按钮（同样 `-9999px` 定位），点击走 `__BWE__.demoModels()`
往面板注入演示模型清单。**顺序不能反**：先注入再切到 AI 页，否则注入的内容会被面板重渲染冲掉。
注入后面板文本从 209 字变成 299 字，出现 `已配置` / `（配置不全）` 标记。

### 9. ai-thinking.png —— AI「正在思考」态

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/ai-thinking.png --size=1600x1000 \
  --tap='[data-activity="ai"]' \
  --tap-seq='wait:1200; click:[data-demo-thinking-reasoning="1"]|1200'
```

思考态是**瞬时状态**，正常截图抓不到，所以用 `[data-demo-thinking-reasoning="1"]` 把它冻结
（`aiPanel.ts` 的 `demoThinking("reasoning", 128)`）。必须先 `wait` 再点：
第一次试的时候把两个 tap 写在同一串里，`demoThinking` 往还没切到前台的面板里写，渲染被覆盖掉了。

### 10. settings.png —— 工程设置

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/settings.png --size=1600x1000 \
  --tap='[data-activity="settings"]'
```

活动栏「设置」是 `bottom: true` 的条目，在活动栏最下方（`y=704`）。

### 11. palette.png —— 命令面板（不是靠键盘触发的）

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/palette.png --size=1600x1000 \
  --tap='[data-command-palette-trigger="1"]'
```

**这张是怎么绕过 Ctrl+Shift+P 的**：`--tap` 只能 `el.click()`，没法发键盘事件；
`--e2e-script` 能执行 JS 但它和 `--shot` 是互斥的两种批处理模式（`SHOT_MODE` 分支里 e2e 先返回并 `app.exit`，
走不到截图那一步），所以「注入 KeyboardEvent 再截图」这条路走不通。
可用的口子是顶栏那个可见的「搜索命令」按钮，它带稳定锚点
`[data-command-palette-trigger="1"]`（`editor.ts` 里 `palBtn.dataset.commandPaletteTrigger = "1"`），
点击调的正是 `openCommandPalette()`——和 Ctrl+Shift+P 是**同一个函数**，只是触发源不同。

**证据不是靠看图**：骨架探针打出 `palette=1`（默认视图是 `palette=0`），
`.command-palette` 实测 680×620、内部 `.cp-item` 匹配 **48** 个，
面板文本以 `新建工程 文件 Ctrl+N / 打开工程… 文件 Ctrl+O / 保存 文件 Ctrl+S …` 开头。
遮罩层把整图压暗是这张的亮度只有 0.70、众数色变成 `#e0d8d0` 的原因，不是渲染坏了。

### 12. explorer.png —— 资源管理器 + 示例工程画布

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/explorer.png --size=1600x1000 \
  --tap='[data-load-js-demo="1"]' \
  --tap-seq='wait:1800; click:[data-tab="canvas"]|500; click:[data-activity="explorer"]|800'
```

**为什么需要三步**：`[data-load-js-demo]` 载入示例后会自动把编辑区切到「剧本」标签、
左栏切到「剧本列表」，此时点 `[data-activity="explorer"]` 只会换左栏、编辑区仍停在剧本页，
截出来是一张「剧本列表 + 剧本编辑器」，名不副实。
所以先 `wait:1800` 等示例工程载入完成，再点 `[data-tab="canvas"]` 切回画布，最后才点资源管理器。
实测结果：左栏 133 字（`地面精灵已被 1 个对象使用`、`墙体精灵已被 151 个对象使用`…），
`.canvas-wrap` 518×634、有 `格 0, 0 | px 0, 0` 读数。

### 13. lighting.png —— 右栏光照面板

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/lighting.png --size=1600x1000 \
  --tap='[data-load-js-demo="1"],[data-tab="lighting"]'
```

任务里写的 `[data-activity="lighting"]` **不存在**——光照不是活动栏条目（活动栏只有
`explorer/search/script/modules/prefabs/package/ai/settings` 八个）。
它是**右栏检查器**里的一个 Tab，选择器是 `[data-tab="lighting"]`（`Tabbed` 组件统一下发 `dataset.tab`）。
点开后 `.aux-panel` 文本：`当前场景：荒原哨站（光照设置存在这张场景上）`、
`2D 光照 Lighting 2D`、`启用 2D 光照`、`光照现在是关的。打开它就能看到夜色预览`。

### 14. midnight.png —— 深夜靛蓝主题（两阶段，必须用固定 userData）

```bash
# ① 先往一个专用 profile 里写入主题偏好
cat > /d/tmp/bwe_shots/set-midnight.js <<'EOF'
(() => {
  try { localStorage.setItem("bwe.theme", "midnight"); } catch (e) { return "storage-fail:" + e.message; }
  document.documentElement.classList.add("theme-midnight");
  return { ok: true, theme: localStorage.getItem("bwe.theme"), cls: document.documentElement.className };
})()
EOF
node desktop/main.mjs --e2e-script=/d/tmp/bwe_shots/set-midnight.js \
  --e2e-out=/d/tmp/bwe_shots/midnight-out.json \
  --user-data=/d/tmp/bwe_shots/midnight-profile

# ② 用同一个 profile 截图
node desktop/main.mjs --shot=docs/readme/raw/editor/midnight.png --size=1600x1000 \
  --user-data=/d/tmp/bwe_shots/midnight-profile \
  --tap='[data-load-js-demo="1"],[data-activity="explorer"]'
```

**为什么绕这一圈**：`--e2e-script` 和 `--shot` 互斥（见第 11 条的说明），
所以「在 e2e 里加 class 再截图」做不到；退而求其次去设置面板里改 `<select>` 也不行——
`--tap` 只会 `click()`，不会发 `change` 事件，`settingsPanel` 的 `onChange` 不触发。
真正可行的路径是 `main.ts` 的 `applySavedThemeAndScale()`：启动时读 `localStorage["bwe.theme"]`，
`"midnight"` 就加 `theme-midnight` 类。

而截图模式**默认每次都用一次性隔离 userData**（`%APPDATA%/BWE Studio/.shot-profile/<pid>`），
localStorage 天然是空的，所以必须用 `--user-data=<目录>` 显式指定一份「现成配置」
（该参数语义就是非隔离：不加 pid 后缀、不参与清理），先在阶段 ① 把偏好写进去。
阶段 ① 的返回体是 `{"ok":true,"theme":"midnight","cls":"theme-cream theme-midnight"}`，
说明 `index.html` 上的 `theme-cream` 与后加的 `theme-midnight` 并存，由 `cream.css` 里的
`html.theme-midnight` 规则覆盖（这也是仓库设计如此，`settingsPanel` 切主题时同样只加不减）。

**⚠ 这张的 `[shot]` 日志会打印 `主题: midnight → FAIL（期望奶油）`、`theme=dark`，这是预期行为**：
`assertTheme()` 的默认期望是奶油主题，而本图故意用深色。
`result=OK` 是因为截图模式（非 `--verify`）的 `ok` 判定是 `loaded && !isEmpty`，不把主题算进失败条件。
它的内容指标全部正常：`errors=0`、非背景 57.6%、717 色、`body` 计算背景 `rgb(18, 20, 26)`。

### 15. mobile.png —— 1280×720 最低验收尺寸

```bash
node desktop/main.mjs --shot=docs/readme/raw/editor/mobile.png --size=1280x720
```

不传 `--tap`。`graphics` 层面由 `--size` 直接决定窗口内容区，`dpr` 在截图模式被强制为 1，
所以出来的就是 1280×720 真实布局（不是缩放图）。
同尺寸另外跑过 `--verify`，输出 `1280x720 → theme=PASS overflow=PASS nonbg=60.6% → PASS`，
横向溢出 PASS 是「最窄尺寸不塌」的硬证据。

## 可复现性

| 图 | 是否逐字节可复现 | 依据 |
|---|---|---|
| `hero.png`、`script.png` | ✅ 重跑 md5 完全相同 | 实测：`hero` 二次运行仍 `ab07d5c04780`；`script` 仍 `3a260c92fea8` |
| `mobile.png`、`palette.png`、`settings.png` | ⚠ 结构可复现，像素有 0.2~1% 抖动 | 见下表 |
| 其余 10 张 | 未做二次比对（各有 `--tap-seq` 时序，比的是「结构一致」而非字节） | 每张都记录了 DOM/骨架探针实测值，可直接对照 |

三张抖动图的量化（Pillow 逐像素与交付图比对）：

| 图 | 差异像素 | 占比 | 差异包围盒 | 判断 |
|---|---|---|---|---|
| `mobile.png` | 2226 / 921600 | 0.242% | (281,126)-(458,713) 177×587 | 画布区光标/网格读数，非结构性差异 |
| `settings.png` | 15069 / 1600000 | 0.942% | (22,301)-(967,769) 945×468 | 表单焦点态/输入框渲染，非结构性差异 |
| `palette.png` | 16695 / 1600000 | 1.043% | (630,694)-(970,765) 340×71 | 命令列表 hover 高亮行，非结构性差异 |

抖动来源是画布指针位置与 hover/focus 态这类真实交互状态，不是渲染不稳定；
判定用的 `nonbg` 在这些差异下变动不到 1 个百分点（60.6% vs 61.6% 这类量级），不影响「有内容」的结论。

## 已知限制与遗留

1. **`prefabs` 面板在「载入内置示例」路径下会空/崩**（详见第 4 条的复现命令）：
   `web/examples/俯视角JS示例.bwproj` 缺 `prefabs` 字段，`store` 的旧工程归一化没覆盖
   `buildExample()` 这条路。这是产品缺陷，不改源码的约束下只能换一种截图路径绕过。
   同理「模块与规则」的内置示例 `packs` 为空，需要多点一次「载入内置模板」。
2. **`--tap` 只能 `click()`**：不发键盘/`change` 事件，所以 Ctrl+Shift+P（命令面板）、
   `<select>` 下拉选项这类交互无法直接用 `--tap` 触发，需要找等价的可见按钮锚点或用两阶段 profile 绕过。
3. **`--e2e-script` 与 `--shot` 互斥**，不能「先跑 JS 再在同一个进程里截图」。
4. 本机没有可用的视觉模型（`view_image` 返回 vision HTTP 400，`sharp` 模块 `ERR_DLOPEN_FAILED`），
   所以本文件里所有「这张图证明什么」都写成**像素统计 + DOM 探针实测值**，不做「画面里画了个什么角色」
   这类目测描述。这也是刻意为之：可 grep 的数字比形容更经得起复核。
