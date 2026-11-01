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
node desktop/test/ipc-contract.test.mjs  # IPC 契约一致性（11 项：通道/字段/语义，含真进程运行时校验）

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
