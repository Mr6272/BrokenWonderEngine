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
| `data-demo-interaction-states` | 顶栏的隐形触发器（0 尺寸、不可聚焦） | 截图前把工具条按钮套上常态/hover/active 三档，用于自证交互态对比度 |
| `data-demo-models` | 顶栏的隐形触发器（0 尺寸、不可聚焦） | 截图前注入一份演示模型清单（形状与门面一致），用于自证多模型渲染；只改内存、不写设置 |
| `data-ai-model-select` | AI 面板的模型下拉 | 换模型用例定位它 |
| `data-ai-import-trae` | 「从 Trae 导入」按钮 | 导入 Trae 模型用例 |
| `data-ai-model-count` | 模型计数文字（「共 N 个（M 个待填 key）」） | 断言清单规模与 needsKey 数量 |
| `data-ai-key-input` | 填 API Key 的输入框（password） | 断言"needsKey 条目走填 key 路径" |
| `data-ai-add-model` | 「+ 添加模型」按钮 | 手动添加 Trae 里没有的模型用例 |
| `data-ai-probe-model` | 顶部 chip 里的「测试连接」按钮 | 连通性探测用例（loading 态 / 四类结果） |
| `data-ai-probe-result` | 探测结果区容器 | 断言结果区已渲染（结论 / 下一步 / 细节） |

### ⚠ `data-demo-*` 两个锚点的特殊说明（仅验收用演示出口）

`data-demo-interaction-states` 与 `data-demo-models` **不是业务流程的一部分**，
它们是**仅验收用的演示出口**，作用分别是：

| 锚点 | 作用 | 为什么必须存在 |
|---|---|---|
| `data-demo-interaction-states` | 给工具条按钮套上常态 / hover / active 三档 | `--shot` 抓不到瞬时 hover 状态；不这么做，"hover 文字是否还看得清"永远无法截图自证 |
| `data-demo-models` | 注入一份**与门面形状完全一致的**假模型清单 | `--shot` 用隔离的临时 profile，settings 是空的，模型清单永远是 mock 两条；不注入就永远无法自证多模型渲染 |

两条共同的关键约束（后来人别理解错）：

1. **渲染路径完全不变** —— 注入的数据形状与 `aiModels()` 返回值逐字一致，
   UI 走的还是同一条渲染代码。所以它证明的是"UI 能正确渲染 N 条模型"，
   **不证明**"主进程能正确读出 settings 里的 N 条"（后者要用 `--ipc-probe` 验）。
2. **只改内存，不写设置** —— 绝不落盘，`--shot` 进程退出即消失，
   不会污染任何真实配置。

**不要顺手删掉它们**。删了不会报错，只会让验收截图静默退回"只有 mock 两条"的状态，
而那时没有人会注意到"模型切换功能其实一直没被自动验证过"。

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

---

## 4. 模型状态语义：`ready` 不等于「能连上」（必读）

这是本项目最容易写错文案的一处，**改动任何模型相关 UI 前先读这段**。

主进程 `desktop/lib/ai/provider.mjs` 的 `fromEntry()` 判定 `ready` **只做配置检查**：

```js
provider === "mock"                 → ready: true          // 本地模板
needsKey && !apiKey                 → ready: false         // 缺 key
!baseUrl                            → ready: false         // 没服务地址
!entry.model                        → ready: false         // 没模型名
其余                                 → ready: true          // ← 有 key + url + 模型名 = 一律 true
```

**它从不发网络请求。** 所以：

| 字段 | 真正含义 | 不能推出什么 |
|---|---|---|
| `ready: true` | **配置齐了** | ❌ 不能推出「连得上」 |
| `ready: false` | 配置不全（缺 key / 缺 url / 缺模型名） | ❌ 不是「网络不通」 |
| `needsKeyMissing` | **这一条**是否真的缺 key | — |
| `needsKey` | **这个供应商类型**是否需要 key（mock=false） | ❌ 不能用来判断"要不要提示填 key" |

### UI 文案三档（`web/src/panels/aiModelState.ts` 单点定义）

| 档位 | 条件 | 文案 | 下一步 |
|---|---|---|---|
| `configured` | `ready` 且不缺 key | **已配置** | 点「测试连接」验证 |
| `needs-key` | `needsKeyMissing` | **待填 key** | 填 key |
| `incomplete` | `ready:false` 且不缺 key | **配置不全**（附 `reason`） | 补 baseUrl / 模型名 |
| `mock` | provider=mock | **本地演示** | 无需处理 |

**禁止写「可用」** —— 那是在替引擎保证它自己保证不了的事。

### 为什么必须单点定义

这套语义有三处消费（顶部常驻 chip、用量条 chip、下拉项后缀）。历史上曾三处各写一份，
其中一处判断了 `listModels()` **根本不产出的 `reachable` 字段** → 分支永不触发、
界面永远显示默认文案，而且**不报错**。这类「看起来实现了、实际一条路径都不走」
的缺陷最难发现，所以统一收到 `aiModelState.ts`，新增消费方一律从那里取。

### 连通性只能主动测

真正的连通性由「测试连接」（`probeModel()`）验证，**只在用户点击时跑**：

- **绝不放进清单加载路径**：N 条模型逐个探活会把面板打开拖成几秒，还可能在用户没要求时打 N 个网络请求；
- 结果分四类，下一步动作各不相同，不能合并成「连接失败」：

| kind | 含义 | 下一步 | 本机实测过的构造 |
|---|---|---|---|
| `ok` | 明确可用 | 直接发消息 | 无有效 key，见下方说明 |
| `auth` | Key 被拒绝 | 重新填 Key | SiliconFlow + 假 key → 401 / code 30014 |
| `dns` | 域名解析失败 | 检查 baseUrl 拼写 | 不存在的域名 → ENOTFOUND |
| `timeout` | 请求超时 | 检查网络/代理/服务 | （需可控的超时服务） |
| `network` | 连不上服务 | 检查地址与端口 | `127.0.0.1:9` → bad port |
| `http` | 拿到响应但状态异常 | 看状态码与服务端日志 | 实测量见下 |
| `unknown` | **判不出来** | 直接发一条短消息验证 | 404（服务未实现 `/models`）→ `ok:null` |
| `unsupported` | 当前环境无探测通道 | 用桌面客户端 | 网页版 |
| `error` | 探测过程本身出错 | 看细节 | — |

**`unknown` 这一档是三态 `ok:(true|false|null)` 的落点，不可压成布尔。**
主进程 `probe.mjs` 的设计：`/models` 端点的 401 或 404 **不能**证明对话接口不可用
（该端点权限要求更高 / 服务可能没实现它），所以返回 `ok:null`——
既不是成功也不是失败。UI 必须用中性色 + `?` 图标，画绿或画红都是替引擎下结论。

映射实现见 `web/src/panels/aiModelState.ts` 的 `classifyProbe()`，
**判定顺序：`unsupported` → `ok===null` → `ok===true` → 用 reason 细分**。
（曾把顺序写成「先查 reason 表」，导致 404 的 `ok:null + reason:"http-error"`
被映射成 `http`＝"确定有问题"，是方向性的错。）

后台通道：`web/src/core/host.ts` 的 `probeModel(id) → AiProbeResult`
（主进程的 `status`/`latencyMs`/`reason` 与 UI 字段不同，归一化在门面里做，**不在面板里做**：
两处各自映射一次必然漂移 —— 本轮真的因此断过一次，四类结果全部 fallback 到 `error` 且不报错）。
