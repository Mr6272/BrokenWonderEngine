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
- `--tap-seq="click:<sel>|probe:<sel1>,<sel2>|wait:<ms>"`：**多步交互 + 每步取证**（分号分段）。
  与 `--tap` 的区别：`--tap` 是「点一次→截图→退出」，拿不到前后对比；`--tap-seq` 在**同一次运行**
  里做多步，把每步结果按顺序追加到 `--probe-dom` JSON 的 `sequence` 字段，因此能证明
  「折叠前 264px → 折叠后 0px → 再展开 0px」这类状态变化（排除用户手速/缓存/随机布局等中间变量）。
  - `click:<selector>` 点击（会先 scrollIntoView），默认点后等 **250ms**（折叠动画/面板重建需要时间落定）；
    可用 `click:<selector>|800` 覆盖等待时长（上限 5000ms）。
  - `probe:<sel1>,<sel2>` 读每个选择器**第一个**匹配元素的 rect + 文本（与 `--probe-selector` 同构）。
  - `wait:<ms>` 纯等待。
  - **找不到元素不判死**：打印 `未找到` 并继续后续步骤（验收最怕第 2 步失败导致后面证据全丢）。
  - `--verify` 忽略 `--tap-seq`（自检只跑干净默认视图）。
- `--probe-selector=<sel[,sel]>`：配合 `--probe-dom`，按逗号分隔的选择器逐个读**第一个**匹配元素的
  `getBoundingClientRect()`（x/y/width/height，CSS 像素）+ 前 200 字文本，写进 JSON 的 `selectors`。
  用于「某个元素实际多大」的取证 —— 截图量像素会被缩放/DPI 干扰，探针读数是可靠证据
  （例：B 改脚本编辑器高度前后，`.js-code` 的 `height` 从 N 变成 M）。
- `--user-data=<绝对目录>`：用一份**现成**的用户配置做验收（非隔离语义，见下文）。
- `--tap=<sel[,sel]>`：截图前依次点击这些元素（逗号分隔），用来打开非默认标签。
  每次点击后等 250ms。**找不到元素不判死**（打印 `[tap] 未找到 …`，截图照出）。
- `--verify`：严格模式。**非奶油主题 = FAIL**、**横向溢出 = FAIL**、**非背景像素不在 20%~92% = FAIL**。
  `--verify` 会**自动跑两个尺寸**（1600x1000 → 1280x720），任一尺寸失败即整体 exit 3；
  同时**忽略** `--tap`（自检只针对干净默认视图）。
  双尺寸的理由：1280x720 是本次交付明写的最低验收尺寸，而**溢出类缺陷只在窄屏暴露**，
  只截 1600x1000 会让窄屏回归漏过去。
  非背景占比**双边**的理由：单边下界只防「界面没起来」（只剩底栏），
  防不了「渲染退化成噪点/纯色块」——那种图前景接近 100%，看着"内容很多"，其实什么都没画对。

## 模型切换与 Trae 导入

编辑器支持**多供应商、一份可增删的模型清单**（下拉开切），数据在 `settings.json` 的 `ai.models`：

```json
{
  "ai": {
    "activeModelId": "trae:siliconflow-moonshotai-kimi-k2-thinking",
    "models": [
      { "id": "ds-flash", "label": "DeepSeek Flash", "provider": "deepseek",
        "baseUrl": "https://api.deepseek.com", "model": "deepseek-v4-flash",
        "apiKey": "", "encryptedApiKey": "<DPAPI 密文>", "needsKey": true, "source": "" }
    ]
  }
}
```

- 每条模型可有**自己的** `apiKey` —— 不同供应商用不同 key，不会串用。
  Key 落盘时统一加密成 `encryptedApiKey`（safeStorage/DPAPI），明文只在内存。
- `provider` 支持 `deepseek` / `siliconflow` / `openai-compatible` / `mock` / `trae-imported`。
  预设（baseUrl、建议模型名、去哪拿 key）见 `desktop/lib/ai/provider.mjs` 的 `PRESETS`。
- **向后兼容**：老的 `ai.provider` + `ai.modelFlash/modelPro`（两槽配置）继续有效，
  `resolveProvider(ai, "flash"|"pro")` 行为与改造前完全一致（有单测锁定）。

### IPC 三通道（渲染侧经 `preload` 调用）

| 通道 | 返回 |
|---|---|
| `bwe:ai-import-trae` | `{ ok, providers, warnings, dbPath, totalEntries, uniqueModels, importedEntries }` |
| `bwe:ai-models` | `{ ok, models: [{id,label,provider,baseUrl,model,ready,needsKey,source,contextWindow,reason}], active }` |
| `bwe:ai-set-model` | 参数 `{ id, apiKey? }` → `{ ok, models, active, message, ready }` |
| `bwe:ai-add-model` | 参数 `{ label, provider, baseUrl, model, apiKey? }` → `{ ok, models, active, id, created, updated }`（同 `provider+baseUrl+model` 就地覆盖） |
| `bwe:ai-probe-model` | 参数 `{ id }` → `{ ok, id, status, reachable, method, detail, reason, latencyMs }`（**真实探测连通性**） |

### ⚠ `ready` 的语义边界（重要）

`ready === true` 的意思是 **「配置齐全」**（provider/baseUrl/model/apiKey 都到位），
**不是「能连上」**。填了假 key、或地址根本不通，`ready` 仍然是 `true`。

为什么不在加载清单时逐个探测：几十个模型每个打一次网络请求会让「打开设置」卡死几秒到几十秒。
所以拆成两层：

| 层 | 谁提供 | 回答的问题 | 成本 |
|---|---|---|---|
| 配置状态 | `ready` / `needsKeyMissing` / `hasApiKey` | 我配好了没 | 零网络 |
| 连通状态 | `bwe:ai-probe-model`（`probeModel(id)`） | 这条现在能用吗 | 一次 `/models` 请求，3 秒超时 |

UI 应该用前者显示「未配置」，用后者显示「测试连通性」的结果 —— 两者混用会让用户
看到「可用」然后一发消息就 401。

`probeModel()` 的 `ok` 是**三态**，不要当布尔用：
- `true` 明确可用（端点连通且 Key 被接受）
- `false` 明确不可用（连不上 / Key 明确无效 / HTTP 错误）
- `null` **判不出来** —— 例如 `/models` 端点权限要求更高而拒绝了 key。
  这种情况 `reason` 是 `unauthorized-on-models`，`detail` 会说明
  「不代表对话接口一定失败」。宁可给出模糊的正确答案，也不给确切的错误答案。

`aiStatus()` 额外返回 `activeModelId` / `activeModel` / `modelList` / `intendedProvider`，
面板据此渲染下拉框与「缺 key」提示。

### 从 Trae 导入（`desktop/lib/ai/trae-import.mjs`）

读 `%APPDATA%\Trae CN\User\globalStorage\state.vscdb`（**只读**打开，`node:sqlite`），
取键 `4337993333357580_AI.agent.model.model_list_map`，按 `base_url` 归组去重（实测 46 条 → 2 条）。

**三条硬约束（写在代码注释里，改之前先读）**：
1. **不解密、不伪造 Trae 的 API Key。** 它的 key 是设备绑定的 AES-256-GCM（密钥服务端下发），
   DPAPI/os_crypt 主密钥/sha256(deviceId) 等派生全部认证失败，既解不开也不该去解。
   导入条目的 `apiKey` **恒为空**、`needsKey: true`、`source: "trae-import"`，界面提示手动填。
2. **空 key 绝不当成可用。** `resolveProvider` 见到 `needsKey && !apiKey` 就 `ready:false`
   并给出人话原因 —— 否则界面显示「已就绪」，用户一提问就 401。
3. **模型名取 `name` 里 `//` 之后的部分**，不是 `custom_model_id`。
   `custom_model_id`（如 `7443714`）只是 Trae 内部数字 ID，发给供应商会报「模型不存在」。
   （实测踩过：拿它当 model 发出去必然失败。）数字 ID 保留在 `traeModelId` 里仅供排查。

网络可达性自检：对每个 baseUrl 探 `HEAD /models`（3 秒超时），遇到 404/405 自动降级 `GET`
—— 实测 SiliconFlow 的 HEAD 返 404 而 GET 返 401，只用 HEAD 会误判。**拿到任何 HTTP 响应
就算可达**（401 恰好证明「网络通、只是没 key」），失败只记 `reachable:false`，不阻断导入。

真实验证命令见「验收命令清单」：
- 第 5b 项 `--ipc-probe`：打印四个通道的真实返回（覆盖 safeStorage 加密 + 真实 sqlite + 真实网络）；
- 第 5c 项 `verify-models.mjs`：**真实 settings → 真实下拉框**的闭环验收。

#### `--user-data=<绝对目录>`（让自动化读真实配置）

自动化模式（`--shot` / `--ipc-probe`）默认用一次性 `pid` 后缀 userData（并发安全），
于是里面的 settings **永远是空的** —— 意味着「模型清单 / 已填的 key / 切到哪个模型」
从未在自动化里被真实验证过。`--user-data` 就是出口：

```bash
# 语义：用一份现成的用户配置做验收（非隔离）
node desktop/main.mjs --shot=... --user-data=D:/tmp/verify-ud --tap="[data-panel-tab=ai]"
```

- 给了目录 → `USER_DATA_DIR = 该目录`（**不加 pid 后缀**），不存在则创建；
- 不参与 `.shot-profile/` 的「只保留最近 6 个」清理，**也不在退出时删除**（那是用户数据）；
- 启动日志会注明 `（来自 --user-data，非隔离模式）`。

#### `--probe-dom=<json>`（读 DOM 内容而不是只数元素）

`UI 骨架: xxx=1` 只能证明"有这个元素"，证明不了"里面装的内容对不对"。
`--probe-dom` 读真实 DOM，返回 `selects`（每个 select 的 option 数量与文本）、
`modelSelect`（模型下拉框的专查，按 `[data-model-select]` → `.ai-panel select` → 首个 select 依次查找）、
`aiPanelText`、`statusText` 并落盘 JSON。

### 探测的可复跑验证（`verify-probe-scenarios.mjs`）

`bwe:ai-probe-model` 的三态分类必须**真打网络**才能证明（单元测试用假 fetch，只证明逻辑对）。
所以提供可复跑脚本，5 个场景各带明确期望：

```bash
node desktop/tools/verify-probe-scenarios.mjs
node desktop/tools/verify-probe-scenarios.mjs --allow-offline   # 无网时按跳过处理
```

| 场景 | 期望 reason | 为什么期望它 |
|---|---|---|
| SiliconFlow · 假 key | `unauthorized` | 401 且响应体点名 `Token is invalid`（code 30014）→ 可确信 key 不对；**不是 404 说明地址与模型名都对** |
| SiliconFlow · 无 key | `unauthorized` | 没配 key 时 401 是明确的「缺配置」 |
| DeepSeek · 假 key | `unauthorized` | 401 响应体含 `api key ... is invalid` |
| 不存在的域名 | `dns` | DNS 失败在 `err.cause.code` 里（Node fetch 的 message 只有 `fetch failed`） |
| 连不上的地址 | `network` | 端口不通要与 DNS 区分，否则排查时分不清 |

实测输出（本机，2026-11-02）：
```
SiliconFlow · 假 key   unauthorized / ok=false  status=401  428ms  PASS
SiliconFlow · 无 key   unauthorized / ok=false  status=401  356ms  PASS
DeepSeek · 假 key      unauthorized / ok=false  status=401  323ms  PASS
不存在的域名            dns / ok=false           status=0    106ms  PASS
连不上的地址            network / ok=false       status=0    1ms    PASS
[probe-scenarios] 全部 5 个场景符合期望
```
（不需要真 key —— 假 key 恰好是最强的判据：401 + 点名无效 = 地址与模型名都对。）

### ⚠ 新增 IPC 通道必须登记契约（否则测试会红）

新增/修改任何 IPC 通道，**必须同时登记到 `desktop/lib/ipc-contract.mjs`**
（`desktop/test/ipc-contract.test.mjs` 会机器校验 preload 方法名、通道名、返回字段与语义注释）。

**契约靠人读人改会漂，靠数据校验不会。** 这条规则的由来是一次真实的跨线断裂：
B 侧按 `aiProbeModel(id)` 期望 `{kind, httpStatus, ms}`，而主进程实际是 `probeModel(id)` 返回
`{reason, status, latencyMs}` —— 方法名与三个字段名全不同，且**没有任何测试变红**（字段全 undefined
后静默 fallback 到 error）。

契约测试的两层：
- **静态层**：preload 引用的通道 ↔ 主进程注册的通道 ↔ 声明表，三方必须完全对齐（防「一边叫 A、一边叫 B」）。
- **运行时层**：真 Electron 里跑只读探针，比对**实际返回的字段集合**与声明。
  （不用静态解析 return 对象：本仓库有 `return await respond(...)` 和 `{...response, ...}` 两种形态，
  硬解析必然误报，误报一多测试就没人信了。）
  注意 `bwe:ai-probe-model` 有 **mock 与真实两个分支**，两个都必须查 —— 只查 mock 的话，
  真实分支的字段名被改坏测不出来（我用注入断裂验证过这个盲区）。

### `--tap-seq` 用法示例（多步取证）

折叠按钮类 bug 的标准取证命令（同一次运行拿到折叠前/后/再展开三组宽度）：

```bash
node desktop/main.mjs --shot=.tmp_desk/collapse.png --size=1600x1000   --probe-dom=.tmp_desk/collapse.json   --tap-seq="probe:.sidebar,.panel; click:[data-sidebar-collapse]; probe:.sidebar,.panel; wait:200; probe:.sidebar,.panel"
```

实测输出（BWE 编辑器，2026-11-02）：
```
[seq] #1 probe → .sidebar: x=48 y=40 264x710（匹配 1 个）
[seq] #2 click:[data-sidebar-collapse] → 已点击 <BUTTON.btn ghost sm sidebar-collapse-btn> @ 136,45 59x24
[seq] #3 probe → .sidebar: x=48 y=40 0x710（匹配 1 个）
[seq] #5 probe → .sidebar: x=48 y=40 0x710（匹配 1 个）      ← 折叠后在 200ms 内未恢复
```
JSON 里 `sequence[]` 每项含 `{step, phase, selector, found, rect{x,y,width,height}, text, visible, error}`，
直接按 step 顺序对比即可；`visible` 由 `rect.width && rect.height` 推导，折叠后为 `false`。

### 验收工具只读原则

`verify-models.mjs` 用 `--ipc-probe-no-import`（只读模式）读被测目录，**不修改被测状态**。
实测证据（同一份 settings.json，跑前/跑后 hash）：

| 模式 | settings.json | 结论 |
|---|---|---|
| `--ipc-probe`（完整） | 297 → 2382 字节，hash **变了** | 会执行 Trae 导入并写入模型清单 |
| `--ipc-probe --ipc-probe-no-import` | 297 → 297 字节，hash **未变** | 只读，符合预期 |

**验收工具必须只读**，否则「跑两次结果不同」会让人怀疑产品代码而不是工具。
（注：Electron 自身会在 userData 下写 `Code Cache`/`IndexedDB` 等浏览器运行时文件，
那是宿主行为、不影响业务状态；判断「有没有改被测状态」应看 `settings.json` 而非目录里的文件数。）

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
#   另有五个（重点，别漏）：
node desktop/test/png.test.mjs           # 截图判死阈值（10 项：主题/空白/双边非背景）
node desktop/test/ai-bridge.test.mjs     # AI 端到端链路（9 项：mock 流式/工具/取消/压缩）
node desktop/test/concurrency.test.mjs   # 并发截图回归（2 进程 × 2 轮，两边都必须出奶油图）
node desktop/test/trae-import.test.mjs   # Trae 导入（12 项：去重/模型名/不伪造 key/降级）
node desktop/test/models.test.mjs        # 模型清单（20 项：向后兼容/按 id 取/每模型独立 key）
node desktop/test/modelCatalog.test.mjs   # 清单写操作（18 项：判重/id/apiKey 三态）
node desktop/test/probe.test.mjs         # 连通性探测（18 项：三态分类/降级/cause 链）
node desktop/test/ipc-contract.test.mjs  # IPC 契约一致性（14 项：通道/字段/语义/事件清单，含真进程运行时校验）
node desktop/test/thinking.test.mjs      # 思考状态机（8 项：connecting/answering 顺序、只发一次、字段白名单）
node desktop/test/tapSeq.test.mjs        # --tap-seq 解析器（16 项：三段语法/等待上限/错误不静默）
node desktop/test/script-language.test.mjs # 补全/提示（14 项：UTF-16 offset/性能/insertText/kind/降级）
node desktop/test/conversations.test.mjs   # 多会话存储（20 项：迁移/新建/切换/删除/标题/自愈）
node desktop/test/session-title.test.mjs   # 标题随对话生成（5 项：零 token/不覆盖用户标题/不串会话）
node desktop/test/ai-session-switch.test.mjs # 切会话时 abort 在途请求（4 项：不串会话）
node desktop/test/ai-tools.test.mjs       # 工具链路（6 项：sceneDigest 注入/失败止损/轮次兜底/callId 配对）

# ── 5f. 脚本编辑器（含 Yarn）尺寸与「新建后不再空态」回归 ──
node desktop/tools/verify-script-editor.mjs

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

# ── 5b. 模型清单 / Trae 导入（在真 Electron 里跑，覆盖 safeStorage + sqlite + 网络）──
node desktop/main.mjs --ipc-probe=.tmp_desk/ipc.json --console

# ── 5c. 模型切换功能的机器可验证证据（真实 settings → 真实下拉框）──
node desktop/tools/verify-models.mjs

# ── 5d. 探测三态的真实网络验证（可选，需外网；无网加 --allow-offline）──
node desktop/tools/verify-probe-scenarios.mjs

# ── 5e. 思考事件序列取证（不需要网络与 key）──
node desktop/tools/verify-thinking-events.mjs
#   期望：cryptoAvailable=true；ai-import-trae 的 ok=true、providers 含 siliconflow、
#        uniqueModels=2、reachable=true/reachableStatus=401；
#        ai-models 每项 ready=false + needsKey=true（导入的模型没 key）；
#        ai-status 的 intendedProvider=siliconflow 而 provider=mock（缺 key 时降级）

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

## 脚本补全与悬浮提示

编辑器代码框的**补全**与**悬浮提示**由 TypeScript LanguageService 提供，
**不引入 monaco / codemirror** —— 仓库已有 `web/src/js/bwe.d.ts`（271 条完整类型声明），
`/api/js-check` 本来就在用它做诊断，同一个 service 直接能出补全与提示。

### 唯一实现：`web/tools/script-language.mjs`

```js
createScriptLanguage({ bweDts, globalsDts })   // 或 createScriptLanguageFromDisk({ webRoot })
  → {
      diagnostics(source)         // 与既有 /api/js-check 完全同一套规则
      complete(source, offset)    // → { entries: [{name,kind,detail,docs,insertText}], isMemberAccess }
      quickInfo(source, offset)   // → { display, docs, kind } | null
      version                     // 版本号（验证「增量更新」生效）
    }
```

**四个必须做对的点：**

1. **单实例 + 版本号增量更新**。每次按键都 `createLanguageService` 会重建 program（271 条声明 + lib），
   卡几百毫秒。正确做法是一个 service 常驻，每次只更新 snapshot 并把 `version` 加一。
   **实测性能（80 行中文注释 + 40 个函数的长脚本，20 次取中位数）**：
   ```
   中位 4.82ms · p95 6.08ms · 最小 3.08ms        （要求 < 30ms）
   ```
2. **offset 是 UTF-16 code unit**（TypeScript 约定）。渲染侧 `textarea.selectionStart` 也是 UTF-16，
   **两边天然一致，直接透传**。⚠ 千万不要按「字符数」算 —— 逐码点遍历与 UTF-16 索引在
   emoji/生僻字上会错位，表现为「中文或 emoji 之后的补全整体错位」。单测里有 emoji 前缀用例锁住这条。
3. **`insertText` 只给名字、不带括号**。带不带括号是 UI 的决策（用户可能想先看签名再决定），
   后端替 UI 决定等于越权。
4. **`kind` 是粗糙分类**：`function | property | namespace | keyword | constant`
   （由 `ts.ScriptElementKind` 转），UI 可直接拿来选图标。

### 两条传输通道（同一套语言服务，两边结果必然一致）

| 场景 | 接口 |
|---|---|
| 网页版（`npm run serve`） | `POST /api/script-complete` `{ source, offset }` → `{ ok, entries, isMemberAccess }` |
| 网页版 | `POST /api/script-quickinfo` `{ source, offset }` → `{ ok, info }` |
| 桌面版（IPC） | `bwe:script-complete` / `bwe:script-quickinfo`（同上形状） |

桌面版**复用同一个 `api-core` 实例**的方法（`core.completeScript` / `core.quickInfoScript`），
不是另写一套 —— 否则桌面版与网页版的补全结果迟早不一致，那是最难查的一类不一致。

**`info === null` 是正常结果**（光标在括号/空白处没有符号），UI 隐藏提示框即可，不要当错误。

**补全不依赖 `apiDocs.ts`**：它读的是 `bwe.d.ts`（类型声明）。改 `apiDocs.ts` 只会影响剧本面板的
API 侧栏，**不会**改变补全内容 —— 别以为改那儿能让补全多一条。

### 验收

```bash
node desktop/test/script-language.test.mjs    # 14 项：UTF-16 offset/性能/insertText/kind/降级
node desktop/test/ipc-contract.test.mjs       # 运行时校验两个通道的实际返回字段
```

实测（`bwe.world.fi`）：
```
entries = 22 条 · isMemberAccess = true
前 3 条: clear (function), clearTag (function), clone (function)
第 1 条 detail: (method) bwe.World.clear(): void
        docs: 销毁所有实体（包含场景原生对象）
quickInfo(光标在 world 上) → (method) bwe.World.find(q: bwe.EntityQuery): bwe.Entity | null
```

## 多会话 / 对话历史

支持「开新对话」「在历史会话间切换」「删除会话」。存储从「单份 history.json」改为：

```
%APPDATA%\BWE Studio\sessions\<workspaceHash>\
├── index.json                      [{id,title,createdAt,updatedAt,messageCount,modelId}], active
└── conversations\<id>\
    ├── history.json                该会话完整消息（无损）
    ├── summary.json                该会话压缩摘要 + usage
    └── meta.json
```

### 四条实现规矩（改代码前必读）

1. **老数据自动迁移，绝不丢历史。** 首次启动把旧的顶层 `history.json` 整体搬成第一个会话，
   旧文件**改名归档**（`history.json.migrated`）而不是删除 —— 迁移逻辑万一有 bug 还能手工找回。
   迁移只发生一次（避免重复 load 产生重复会话）。
2. **`active` 永不悬空。** 删当前会话时自动落到「最近更新」的下一个；删到只剩 0 个时自动补一个空会话
   （否则 UI 没有可用会话，下次启动也难恢复）。
3. **切换会话必须先 abort 在途请求，再换绑 session 对象。** 顺序不能反 ——
   否则旧请求收尾时会把消息 append 进**新会话**的 history（数据写错地方，且不报错）。
   这是本功能最危险的一条，有专项单测 `ai-session-switch.test.mjs` 锁住。
4. **`index.json` 原子写（`.tmp` → rename）。** 半截 JSON 会让用户「所有会话都消失」
   （内容其实还在磁盘，但 UI 看不到）。

### 标题生成：零 token，且必须**随对话更新**

取**第一条用户消息前 20 字**（多行压成一行、超长加 `…`、空内容回落「新对话」）。
不调模型生成标题 —— 那是额外开销，而第一条消息本身就是最好的标题（用户自己写的话最贴近意图）。

⚠ **光有 `makeTitle()` 不够**：`bridge` 写盘后必须通知会话存储（`onSessionUpdated` 回调），
否则标题只在迁移时生成一次，之后永远停在「新对话」，`messageCount` 也永远是 0 ——
通道全通、数据全对，但**用户看到的历史列表是空的**。
这是实测发现的真实缺陷（单测能过、端到端才发现），回归锁是 `session-title.test.mjs`。

两条细节：
- 只在标题**仍是默认值**时用首条消息生成 —— 用户手改过标题后不再覆盖。
- 用 `basename(sess.dir)` 取会话 id：Windows 路径分隔符是 `\`，按 `/` 分会拿不到 id（踩过）。

### 自愈：索引丢了历史也还在

`index.json` 被删/写坏时，启动会扫 `conversations/<id>/` 把磁盘上还在的会话补回列表。
**宁可多列一个会话，也不要让用户的历史凭空消失。**

### 四个 IPC 通道

| 通道 | 参数 | 返回 |
|---|---|---|
| `bwe:ai-sessions-list` | 无 | `{ ok, sessions:[{id,title,createdAt,updatedAt,messageCount}], active }` |
| `bwe:ai-session-new` | `{ title? }` | `{ ok, id, sessions, active, aborted }` |
| `bwe:ai-session-switch` | `{ id }` | `{ ok, sessions, active, messages, aborted }`（messages **不含 system 前缀块**） |
| `bwe:ai-session-delete` | `{ id }` | `{ ok, sessions, active }` |

`aiStatus()` 增加 `activeSession`（当前会话 id）与 `sessionCount`。

### 验收

```bash
node desktop/test/conversations.test.mjs    # 20 项：迁移/新建/切换/删除/标题/索引健壮性
node desktop/test/ai-session-switch.test.mjs # 4 项：切换时 abort 在途请求、不串会话
```

## 工具链（AI 调用工具的四个坑）

「AI 会在修复过程中中断自己」——用户报的这个现象，根因不是模型，是工具链的三处缺陷叠加。
四个坑都值得记住，因为它们**都不报错**，只在真实对话里表现为「AI 说半句就消失」。

### 坑 1：构造时闭包 vs 每次请求传入（最重要）

`createToolRunner` 只在 `createAiBridge` 时**创建一次**，它闭包了构造那一刻的 `opts.sceneDigest`。
而工程摘要是**每次请求**由渲染侧随 `request.context.sceneDigest` 传来的。

```
错误形态：启动时闭包一个全局值 → 之后每次请求都用它（工程切换后就是错的，没有时则每次必失败）
正确形态：每次 run() 开头把 request.context.sceneDigest 注入 → toolRunner.setSceneDigest(...)
```

历史缺陷：`app-main` 从未传 `opts.sceneDigest`（grep 计数 0），而 `tools.mjs` 又要求它必须是函数
→ **SceneDigest 工具每次必抛错** → 模型"换个路径再试一次"→ 再调 → 再失败 → 耗尽轮次。

> **这条经验通用**：任何"工厂只创建一次 + 数据每请求变化"的组合，都必须有**注入点**，
> 不能让工厂在构造时闭包。判据：问自己「这个值会不会在处理后续请求时变旧？」会 → 必须注入。

### 坑 2：轮次耗尽没有兜底 → 静默结束

```
while (rounds <= MAX_TOOL_ROUNDS) { ... if (toolCalls) { ...; continue; } break; }
// 退出后直接落盘 + done —— finalText 可能是空串
```

模型连续 3 轮都在调工具（因为工具一直失败），**从没机会产出正文**，循环退出后直接 `done`。
用户看到的就是「AI 说了半句话就消失了」。

**修法（两条都必须有）**：
1. **轮次耗尽后再做一次不带 `tools` 的调用**，逼模型基于已有信息作答 —— 否则用户永远拿不到答案。
2. **同一工具连续失败 2 次即止损**，并在工具结果里明确写「该工具不可用，请基于已有信息作答」。
   **模型不会自己意识到"这个工具坏了"，它会一直重试** —— 这个判断必须由我们做。

### 坑 3：工具事件按 name 配对会串

一次对话里可能**两次调用同名工具**（真实发生过：SceneDigest ×2）。
按 `name` 配对会让第一次的 `start` 配到第二次的 `end` —— 耗时算错、成败也可能串。

**修法**：事件带 `callId`（取模型返回的 `tool_call.id`，天然唯一），UI 按 `callId` 配对。
`tool` 事件形状：
```ts
{ type: "tool", requestId, callId, name, phase: "start" | "end",
  detail, ok?, error?, ms? }   // ok/error/ms 仅 end
```
`error` 必须是**完整原文**，不经过剪枝：错误通常很短，剪枝反而把根因削掉。

### 坑 4：依赖缺失要等运行时才暴露

`sceneDigest` / `apiIndex` / `toolCache` 这类"工具依赖"缺了不会影响界面，
直到用户在真实对话里触发那个工具才炸 —— 而那时错误发生在对话中间，表现为"AI 中断自己"，极难定位。

**修法**：启动时 `checkToolDependencies()` 扫一遍，缺什么直接打警告。
（这和「打包漏复制文件 → Electron 静默挂死」是同一类：**依赖缺失不该等到运行时才暴露**。）

### 验收

```bash
node desktop/test/ai-tools.test.mjs    # 6 项：注入/止损/兜底/callId 配对
```
覆盖五条：`SceneDigest 读 request.context.sceneDigest`、`bridge 每次 run 都注入`、
`连续失败 2 次止损`、`轮次耗尽仍产出答复`、`同名工具 callId 不配错`。

## 「思考中」事件（thinking）

推理模型（DeepSeek reasoner 等）首字延迟常 2~5 秒。这期间原来只发一个空 delta 做心跳，
UI 收不到任何可显示内容 —— 用户以为卡死。现在改为**有语义的阶段事件流**：

```ts
{ type: "thinking", requestId, phase: "connecting" | "reasoning" | "answering" | "slow",
  chars?: number,   // reasoning 已累计字符数（UI 显示「已思考 N 字」）
  delta?: string }  // 最近一小段思考文本（供「展开看」，**不是全量**）
```

| phase | 何时发 | 含义 | UI 应显示 |
|---|---|---|---|
| `connecting` | 路由判定后、发起网络前 | 已开始请求，还没有任何返回 | 「正在连接…」 |
| `reasoning` | 收到 reasoning 增量 | 模型在思考，还没有可显示正文 | 「正在思考（已思考 N 字）」 |
| `answering` | **收到首个正文 delta 时，只发一次** | 已有正文在流 | 切到正常流式显示 |
| `slow` | 发起请求后 **8 秒**内无任何 reasoning/delta | 网络慢或模型排队 | 文案升级 + 提供取消出口 |

**三条硬约束（改代码前必读）**：
1. **四个 phase 不可合并** —— 它们对应四种不同的等待体验，文案与「下一步」都不同。
2. **`answering` 只发一次** —— 每个 delta 都发会让 UI 每帧做一次状态判断。
3. **mock 分支也必须发 `connecting`**（人为 400~600ms），否则无 key 时思考态无法演示/截图；
   **真模型分支不许加任何人为延迟**（真延迟已经存在，再加只会更差）。

事件里**只放契约字段**（phase / chars / delta）—— 文案由 UI 按 phase 决定，
主进程塞文案会导致两处各写一套措辞（迟早不一致）。

验证：
```bash
node desktop/test/thinking.test.mjs                          # 8 项：顺序/只发一次/字段白名单/mock 延迟
node desktop/tools/verify-thinking-events.mjs                # 打印真实事件序列（取证用）
```
实测序列（mock）：
```
route → thinking/connecting → thinking/answering → delta(18字) ×13 → done
thinking 明细：[2ms] connecting  ·  [509ms] answering
```

### 关于「切会话时中止在途请求」（多会话最危险的一条）

`swapSession()` 是 **async 且内部 `await whenIdle()`** —— 返回时保证在途请求已真正 settle
（落盘、emit、从 running 表移除都已完成）。调用方必须 `await`。

为什么不能只「发出 abort 就换绑」：`AbortController.abort()` 只是发信号，被中止的 Promise
在下一个微任务才 reject，而请求的收尾落盘更晚。中间那个窗口会导致
**「切到 B 会话，A 的回复写进 B 的 history」**（数据错乱且不报错）。

配套的第二道防线：`run()` 在开头就把会话**绑定**成 `targetSession`，落盘只写它，
与后续 `session` 变量指向谁无关。

测试侧纪律：**不要用 sleep 等异步收尾**。用 `await bridge.swapSession(...)` 或
`await bridge.whenIdle()` —— sleep 只降低概率，不消除竞态；而且慢机器上会假红。
（踩过：`ai-session-switch.test.mjs` 曾因断言瞬时状态而 5~12% 随机失败，改为确定性等待后 20/20 稳定。）

### 打包必须扫描依赖，不能硬编码清单

`desktop/tools/package.mjs` 的 `copyApiCore()` 从入口 `api-core.mjs` 递归解析相对 `import`，
把整条依赖链复制进 `resources/app/web/tools/`。

**这条踩过两次**：先漏 `api-core.mjs`、后来又漏 `script-language.mjs`（都是新增 import 但没更新
硬编码清单），症状完全相同 —— 主进程在模块加载期 `ERR_MODULE_NOT_FOUND`，
**Electron 表现为「窗口不出现、进程静默挂死」，不打印栈**，只有打包自检超时才暴露。
硬编码清单的必然结局是「新增一个 import，就多一次线上挂死」。

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
