# UI 逻辑自检 + 验收锚点

本目录放**不依赖浏览器的界面逻辑回归测试**，以及**跨线共用的 DOM 锚点清单**。

---

## 1. 跑法

```bash
node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-ui-logic.ts \
  --bundle --platform=node --format=esm --outfile=.tmp_ui/verify.mjs
node .tmp_ui/verify.mjs
```

退出码 0 = 全过（当前 20/20）。

也可以用根 `package.json` 的脚本（Lead 维护，名称以 package.json 为准）：

```bash
npm run verify:ui
```

覆盖内容：

| 层 | 断言 |
|---|---|
| 命令注册表 | 可见命令 42 条（47 注册 - 5 隐藏）、分组顺序（文件优先） |
| 模糊过滤 | 空查询返回全部；「保存」命中保存与另存为；「AI」命中 AI 组；多关键词 AND；按快捷键文本可搜；无关词返回空 |
| 诊断中心 | 写入/计数、错误排在警告前、重复写入不堆叠、覆盖写入、多来源合并、清单个来源、清空全部 |

**为什么需要它**：截图只能证明"面板弹出来了"，证明不了"过滤对不对、计数会不会堆叠"。
命令面板这种"看起来能用"的交互，必须靠纯函数断言锁住。
这个测试已经逼出一个产品级 bug：「另存为（下载 .bwproj）」搜「保存」搜不到 —— 人点永远发现不了。

---

## 2. 验收锚点（`data-*`）—— 跨线契约，**不要随手改名**

桌面壳线（A）的 `--tap` 与 Lead 的验收命令都靠这些锚点定位。
改名 / 删除会静默破坏别人的验收截图（`--tap` 找不到元素只打日志、退出码仍是 0，不会报错）。

| 锚点 | 位置 | 用途 |
|---|---|---|
| `data-panel-tab="problems"` / `="output"` / `="ai"` | 底部面板的三个标签按钮 | 切到指定底部面板（**推荐用这个，不要用 `nth-child`**，标签顺序变了会点错） |
| `data-sidebar-collapse` | 侧边栏头部的「折叠」按钮 | 折叠侧边栏后截图，验证画布是否拿满宽度 |
| `data-command-palette-trigger` | 顶栏「搜索命令」按钮 | 打开 Ctrl+Shift+P 命令面板 |
| `data-command-palette` | 命令面板浮层根节点 | 探针判断"浮层真的弹出来了" |
| `data-cp-input` | 命令面板的输入框 | 需要往命令面板输入过滤词时定位它 |
| `data-quickstart-banner` | 首启引导条 | 判断首次启动提示是否出现 |
| `data-quickstart-open` / `data-quickstart-close` | 引导条的「看引导」/「×」按钮 | 展开完整引导 / 关闭提示 |

### 对应的现成命令

```bash
# AI 助手面板（1600x1000 与 1280x720 各一张）
node desktop/main.mjs --shot=.tmp_desk/ai.png --size=1600x1000 --tap='[data-panel-tab="ai"]'

# 命令面板
node desktop/main.mjs --shot=.tmp_desk/cmd.png --size=1600x1000 --tap='[data-command-palette-trigger]'

# 折叠侧边栏（配合 --probe 看 sidebar 宽度是否归零、canvas 是否变宽）
node desktop/main.mjs --shot=.tmp_desk/collapsed.png --size=1280x720 \
  --tap='[data-sidebar-collapse]' --probe=.tmp_desk/collapsed.json
```

`--tap` 支持逗号分隔多点，找不到元素**不判死**（截图照出、退出码 0），
所以锚点缺失不会让验收挂掉 —— 这也正是它必须被本清单锁住的原因。

---

## 3. 调试出口（`window.__BWE__`）

`web/src/main.ts` 暴露了一个调试对象，验收脚本可以借助它注入状态：

| 键 | 用途 |
|---|---|
| `__BWE__.store` / `__BWE__.editor` | 直接访问状态中心与编辑器实例 |
| `__BWE__.dump()` | 一次性拿到工程/场景/选中/脏标记的摘要（排查"数据丢没丢"） |
| `__BWE__.injectProblems(list)` | 注入一组假诊断，用来截图验证「问题」面板的渲染 |
| `__BWE__.showPanelTab(id)` | 切换底部面板（`problems` / `output` / `ai`） |

正常使用没人会调它们，只在控制台排查与自动化截图时用。
