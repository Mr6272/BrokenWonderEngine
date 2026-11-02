# BWE Studio 桌面版 · 契约文档（Web → EXE）

> 本文件是**并行施工的唯一接口契约**。三条工作线（UI / 桌面+AI / Java 引擎）各自只改
> 「§8 归属表」里属于自己的文件，跨线交互一律走本文档定义的接口。
> 任何一方想改接口，先改本文件再改代码。

## 0. 目标

| 项 | 内容 |
|---|---|
| 形态 | Windows 桌面客户端（Electron 37.10.3，离线 vendor，产出 `desktop/dist/BWE Studio.exe`） |
| 免依赖 | **不再需要** `npm run serve`。Web 版原来的 8 个 `/api/*` 能力全部搬进 Electron 主进程 |
| 界面 | VS Code 结构（活动栏 / 侧边栏 / 编辑区多标签 / 底部面板 / 状态栏 / 命令面板）+ 奶油色软科技主题 |
| 智能 | 内置 AI 助手面板：读工程摘要、读脚本诊断、改脚本、给修复建议 |
| 省钱 | 参考 deepx + DeepSeek Harness：零 token 本地路由、前缀缓存友好、工具按需注入、分层压缩、无损续接、缓存命中率可见 |
| 引擎 | Java 运行时补「脚本错误可观测 + 脚本性能剖析」，并把 flaky 性能阈值改成中位数/p99 |

## 1. 目录

```
BrokenWonderEngine/
├── desktop/                        # 桌面壳（Teammate A 独占）
│   ├── package.json                # 主进程依赖声明（不装 electron，用 vendor）
│   ├── main.mjs                    # Electron 主进程：窗口、菜单、IPC、内嵌 API
│   ├── preload.cjs                 # 暴露 window.bweHost
│   ├── lib/
│   │   ├── ai/                     # AI 层（router / cache-prefix / session / compact / usage）
│   │   └── api.mjs                 # 直接复用 web/tools/api-core.mjs
│   ├── tools/package.mjs           # 打包成 dist/BWE Studio.exe（离线，不联网）
│   ├── icons/bwe.ico
│   └── vendor/electron/            # 已解压的 electron 37.10.3（gitignore，脚本可重建）
├── web/
│   ├── index.html                  # 桌面/网页共用入口（Teammate B）
│   ├── styles/app.css              # 既有令牌与组件（B 可加结构类）
│   ├── styles/cream.css            # 奶油软科技主题（Lead 独占，index.html 里排最后）
│   ├── src/core/host.ts            # 宿主抽象：有 bweHost 走 IPC，没有回退 fetch（Lead 独占）
│   └── src/...                     # 其余界面（B 独占）
├── web/tools/api-core.mjs          # 从 serve.mjs 抽出的纯后端能力（A 独占；serve.mjs 改为复用）
└── src/Studio/runtime/             # Java 运行时（C 独占）
```

## 2. 宿主抽象（渲染侧唯一入口）

`web/src/core/host.ts` 导出：

```ts
export type HostMode = "desktop" | "web";
export function hostMode(): HostMode;              // 启动时定一次，之后不变
export function apiFetch(path: string, init?: RequestInit): Promise<Response>;
   // desktop：走 window.bweHost.api(path, init) 返回结构化 Response 兼容对象
   // web：回退原生 fetch（保持网页版行为不变）
export function isDesktop(): boolean;
```

所有原来的 `fetch("/api/...")` 调用点**必须**改成 `apiFetch`（保持 path/method/body 不变）。
这样 desktop 免起服务，web 版零行为变化。

## 3. `window.bweHost`（preload 暴露，主进程实现）

> **新增 / 修改任何 IPC 通道，必须同时登记到 `desktop/lib/ipc-contract.mjs`**
> （`desktop/test/ipc-contract.test.mjs` 会机器校验 preload 方法名、通道名、返回字段与语义注释）。
> 契约靠人读人改会漂，靠数据校验不会。
>
> **由来（真实事故）**：UI 侧按 `aiProbeModel(id)` 期望 `{kind, httpStatus, ms}`，主进程实际提供
> `probeModel(id)` 返回 `{reason, status, latencyMs}` —— **方法名与三个字段名全不同**，
> 结果全部 fallback 到 error 分支，**而且没有任何测试变红**。
> 教训：契约只存在于对话里 = 一定会漂；字段**语义**（三态还是布尔、`ready` 是否含连通性）
> 比字段名更容易出错，必须一起写进契约表。

```ts
interface BweHost {
  mode: "desktop";
  version: string;                       // 应用版本
  paths: { userData: string; workspace: string; repo: string; settings: string };

  api(path: string, init?: { method?: string; body?: string; headers?: Record<string,string> })
     : Promise<{ ok: boolean; status: number; json?: unknown; text?: string; headers?: Record<string,string> }>;

  // 文件
  openProject(): Promise<{ ok: boolean; path?: string; content?: string; error?: string }>;
  saveProject(project: unknown, suggestedName?: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  saveProjectAs(project: unknown, suggestedName?: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  recentProjects(): Promise<{ path: string; name: string; at: number }[]>;
  revealInExplorer(path: string): Promise<void>;

  // 设置（AI 供应商等）
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;

  // AI（详见 §4）
  aiStatus(): Promise<AiStatus>;
  aiChat(req: AiChatRequest): Promise<{ requestId: string }>;   // 立刻返回，流式事件推送
  aiCancel(requestId: string): Promise<void>;
  aiReset(): Promise<void>;
  onAiEvent(cb: (ev: AiEvent) => void): () => void;             // 返回取消订阅函数
  onMenuCommand(cb: (command: string) => void): () => void;      // 原生菜单 → 渲染侧
}

interface Settings {
  ai: {
    provider: "deepseek" | "openai-compatible" | "mock";
    baseUrl: string; apiKey: string; modelFlash: string; modelPro: string;
    autoRoute: boolean; manualModel: "flash" | "pro" | ""; contextWindow: number; maxTokens: number;
  };
  editor: { theme: "cream" | "midnight" | "high-contrast"; uiScale: number; autoSave: boolean };
}
```

渲染侧在 `web/src/core/host.ts` 里做一层 `window.bweHost` 存在性判断；B 的 AI 面板只通过
host.ts 的 AI 包装函数调用，不直接碰 `window.bweHost`。

## 4. AI 协议（主进程 ↔ 渲染进程）

### 4.1 请求

```ts
interface AiChatRequest {
  requestId: string;                  // 渲染侧生成 uuid，主进程原样回显
  messages: { role: "user" | "assistant"; text: string }[];  // 本轮新增的用户消息 + 上一轮摘要
  context?: {
    sceneDigest?: string;             // 已压缩的工程摘要（见 §4.5），不含全量 JSON
    diagnostics?: { errors: number; firstError?: string };
    activeScript?: { name: string; lang: "js" | "yarn"; code: string };
    selection?: { count: number; kinds: string[] };
  };
  intent: "chat" | "explain-error" | "edit-script" | "scene-review";
}
```

### 4.2 流式事件（`onAiEvent`）

```ts
type AiEvent =
  | { type: "route"; requestId; model: "flash"|"pro"; reason: string; localOnly: true }
  | { type: "thinking"; requestId; phase: ThinkingPhase; chars?: number; delta?: string }
  | { type: "delta"; requestId; text: string }
  | { type: "tool"; requestId; name: string; detail: string }
  | { type: "usage"; requestId; usage: TokenUsage }
  | { type: "done"; requestId; text: string; usage: TokenUsage; cacheHitRate: number; savedUsdApprox: number }
  | { type: "error"; requestId; message: string; recoverable: boolean };

type ThinkingPhase =
  | "connecting"   // 请求已发出，还没有任何返回（首字延迟期，推理模型常 2~5 秒）
  | "reasoning"    // 模型在思考（DeepSeek reasoning_content），还没有可显示正文
  | "answering"    // 已有正文在流（思考提示应撤掉）
  | "slow";        // 兜底：超过 8 秒什么都没收到（网络慢 / 模型排队）

interface TokenUsage {           // 与 DeepSeek Harness 的 TokenUsage 语义一致：三者互不重叠
  inputTokens: number;           // 未命中缓存的输入
  cacheReadTokens: number;       // 命中前缀缓存的输入
  cacheWriteTokens: number;      // 写入缓存
  outputTokens: number;
  reason?: string;
}
```

**`thinking` 是思考态的唯一真来源**（2026-11-02 新增）。在此之前 UI 只能靠「多久没收到 delta」去猜，
推理模型首字 2~5 秒的静默期会被误读成卡死。规矩：

- **四个 phase 不可合并**：它们对应四种不同的等待体验，文案与「下一步能做什么」都不同。
- `chars` 是已累计的思考字符数（可显示「已思考 N 字」）；`delta` 是**最近一小段**思考文本，
  供「展开看思考过程」用，**不是全量**（全量既贵又会让事件通道变成第二个正文流）。
- `answering` 只发一次（不是每个 delta 都发），否则 UI 每帧都要做一次状态判断。
- **mock 分支也要发 `connecting`**（人为 400~600ms 延迟），否则无 API Key 时思考态无法演示与截图。
  真模型分支**不允许加任何人为延迟**。

UI 必须把 `cacheHitRate`、`savedUsdApprox`、`route.reason` 显示出来（"省 token"要可见）。

### 4.3 省 token / 缓存友好（硬性约束，实现时必须逐条满足）

1. **零 token 路由**：本地关键词 + 长度判定选 flash/pro，不发任何 LLM 调用。关键词表在
   `desktop/lib/ai/router.mjs`，中/英双语；本轮内模型可经工具 `SwitchModel` 升级。
2. **稳定前缀**：system prompt 由**编译期常量块**拼成（身份、仓库结构、BWE API 摘要、规则），
   **禁止**包含时间戳 / 会话 id / 文件名列表 / 当前选中对象等易变内容。易变内容一律放在
   `messages` 之后或作为 user 消息追加。序列化后前缀跨轮**字节级一致**，DeepSeek 前缀缓存才命中。
3. **工具不预注入**：工具定义只保留 3 个（`ReadFile` / `SceneDigest` / `SearchApi`），
   API 271 条文档不进 system prompt，改为 `SearchApi` 按需取（一次 ≤ 5 条）。
4. **工具结果剪枝**：超过 600 字符的工具结果入库前压缩成「头部 + 统计」，原文留在本地
   `toolCache/` 里按 hash 存取（下次同一结果零成本复用）。
5. **分层压缩**：上下文 > 窗口 70% 时触发；尾部保留 ~20K token 原文，旧内容 LLM 摘要并与已有
   摘要合并；摘要在会话文件里持久化，重启后不重复消耗 token。
6. **无损续接**：会话用 JSON 全保真落盘（含 tool calls/results），重启读取；system prompt
   版本升级时**原地替换**该块、其余历史与顺序不动（保持前缀一致）。
7. **不抖动采样参数**：`temperature/top_p` 按 provider 固定，不随轮次变化。

### 4.4 存储位置

```
%APPDATA%\BWE Studio\
├── settings.json                       # Settings（apiKey 用 DPAPI 加密后存 encryptedApiKey）
├── sessions\<workspaceHash>\meta.json
├── sessions\<workspaceHash>\history.json      # 完整消息（无损）
├── sessions\<workspaceHash>\summary.json      # 压缩摘要 + usage 快照
└── toolCache\<sha1>.txt
```

### 4.5 工程摘要（省 token 关键）

渲染侧算好 `sceneDigest` 再发（不允许把整个 `.bwproj` 塞进 prompt）：

```
工程「未命名工程」 3 场景 / 12 素材 / tileSize 32
- 世界场景 city：48 对象（精灵 30 / 触发区 5 / 瓦片 13），脚本 2（player.js, world.js）
- UI 场景 hud：9 对象（label 6 / panel 3）
选中：2 个（sprite「玩家」、zone「出生点」）
脚本错误：1 条（world.js:42 TypeError: ...）
```

## 5. 主题契约（奶油色软科技）

`web/styles/cream.css` 覆盖 `:root` 令牌，**不新增业务类**（业务类仍由 app.css 定义）：

| 令牌 | 奶油软科技值 | 用途 |
|---|---|---|
| `--bg` | `#f7f4ee` | 窗口底 |
| `--surface` | `#fdfbf7` | 面板底 |
| `--surface-2` | `#f4f0e8` | 次级面 |
| `--surface-3` | `#eae5da` | 三级面 |
| `--sunken` | `#f2eee6` | 凹陷区 |
| `--line` | `#e2dbcd` | 描边 |
| `--line-soft` | `#ece6da` | 弱描边 |
| `--text` | `#3b3730` | 主文字 |
| `--text-2` | `#6f6759` | 次文字 |
| `--text-3` | `#9a9184` | 弱文字 |
| `--accent` | `#8a6f4e` | 主色（奶咖） |
| `--accent-hover` | `#a1845d` | |
| `--accent-soft` | `rgba(138,111,78,0.12)` | |
| `--ok` | `#4f8a5b` / `--warn` `#b8862b` / `--danger` `#bd5348` | |
| `--canvas-bg` | `#f2ede3` | 画布 |
| `--shadow-pop` | `0 6px 20px rgba(80,64,44,0.10)` | 软阴影 |

"软科技"落地要求：圆角 8~10px、1px 暖灰描边、阴影低透明大扩散、无纯黑无纯白、
选中/悬停用 `--accent-soft` 底色而不是加粗描边、焦点环 2px `--accent` + 2px 透明外扩。

### 5.1 VS Code 结构类名（B 新建，Lead 主题只调这些类的观感）

`activity-bar`（48px 竖条，图标 + 底部设置）、`sidebar`（可拖宽，内含原 Tabbed）、
`editor-area`（`editor-tabs` + 画布/面板宿主）、`panel`（底部可折叠面板，含「问题 / 输出 / AI」）、
`statusbar`（沿用）、`command-palette`（Ctrl+Shift+P 浮层）、`ai-panel`（右侧停靠的助手）。

## 6. Java 引擎契约（C）

新增脚本可见 API（必须同步四处：`ScriptApi.java` ↔ `web/src/js/bwe.d.ts` ↔
`web/src/data/apiDocs.ts` ↔ `docs/api/*.md`，`node web/tools/verify-apidocs.mjs --strict` 必须 0 缺失 0 编造）：

```
bwe.debug.errors()            → [{ script, message, line, count, frame }]    最近 32 条，环形
bwe.debug.clearErrors()       → boolean
bwe.debug.dumpErrors(path)    → boolean      写 Build/diagnostics/script-errors.json
bwe.prof.enable(on = true)    → boolean
bwe.prof.report()             → { frames, avgMs, p50Ms, p95Ms, p99Ms, maxMs, scripts: [{name, p95Ms, calls}] }
bwe.prof.reset()              → boolean
```

并把 `ScriptFieldsTest` 的 `100x100 草地 tick < 2ms` 改成**中位数 + p99**判定（消除 flaky）。

## 7. 验证命令（三方共用）

```powershell
cd D:\githubdesktop\BrokenWonderEngine
npm run typecheck                                   # TS 通过
npm run build                                       # 编辑器 bundle
node web/tools/verify-apidocs.mjs --strict          # API 四方一致
.\tools\bwe.ps1 build                               # Java 编译（JDK 25）
.\tools\bwe.ps1 test                                # 7 套件
node desktop/tools/package.mjs                      # 打 EXE
node desktop/main.mjs --shot=.tmp_desk/shot.png --size=1600x1000   # 桌面截图
```

## 8. 归属表（写冲突的唯一裁决依据）

| 路径 | 归属 | 说明 |
|---|---|---|
| `desktop/**` | **A** | 含 package.json / main / preload / lib / tools / icons |
| `web/tools/api-core.mjs`、`web/tools/serve.mjs` | **A** | serve.mjs 改成薄壳复用 api-core |
| `web/src/core/host.ts` | **Lead** | 宿主抽象，A 与 B 都只调用不改 |
| `web/styles/cream.css`、`docs/desktop-migration.md` | **Lead** | |
| `web/index.html`、`web/src/main.ts`、`web/src/app/editor.ts`、`web/src/ui/**`、`web/src/panels/**`、`web/styles/app.css` | **B** | |
| `src/Studio/runtime/**`、`docs/api/**` | **C** | 另可改 `web/src/js/bwe.d.ts`、`web/src/data/apiDocs.ts` 的**新增条目** |
| `docs/_fragments/desktop-report.md` | Lead（汇总） | 各线自测结论进这里 |

`package.json`（根）由 Lead 改（加 `desktop`/`desk:shot` 脚本）。
