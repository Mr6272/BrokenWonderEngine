# AI 界面（AI 工作面）实现契约

> 本文件是 **AI 栏 → AI 界面** 改造的唯一契约。三处代码（`panels/aiPanel.ts`、`ui/shell.ts` + `app/editor.ts`、`styles/*.css`）按此对齐类名与状态，
> 任一方私自改名都会让另一方静默失效（样式不生效 / 断言量不到元素），所以类名与 data 属性先写死在这里。

## 1. 目标行为

1. **进入**：点活动栏「AI 助手」→ 进入 **AI 界面**。其余界面（侧边栏 / 编辑区 / 辅助栏 / 底部面板）**退场**，AI 界面占满主工作区，活动栏保留在最左。
2. **退场**：在 AI 界面里点活动栏任何**其它**按钮（资源管理器 / 搜索 / 剧本 / 模块 / 预制体 / 打包 / 设置）→ AI 界面退场，对应界面按原逻辑出现。另有「退出 AI 界面」按钮与 `Esc`。
3. **两态**：
   - **空闲态（idle）**：中央一个聊天框（欢迎标题 + 建议 + 输入框 + 快捷动作），垂直居中。
   - **对话态（active）**：中央聊天框**下沉到下方**，上方是 **Agent 行为区**（工具调用 / 思考 / 提示 / 错误 / diff）。
4. **工具调用不许被挤成一条缝**：`.ai-agent-list` / `.ai-thread` 的所有子元素一律 `flex: 0 0 auto`（见 §5 的根因）。

## 2. DOM 契约（`web/src/panels/aiPanel.ts` 产出）

```
.ai-panel[data-ai-zone="1"]            ← 根；空闲时加 .is-idle，忙时加 data-busy="1"
  .ai-head                              （已有：模型选择器 / 状态 chip）
  .ai-mock-hint / .ai-insecure-hint / .ai-keybroken-hint / .ai-probe-host   （已有，保持在 streams 之外）
  .ai-streams                           ← 新增：两区容器（flex 列）
    .ai-hero                            ← 只在空闲态存在（欢迎标题 + 建议行）
    .ai-agent[data-ai-agent="1"]        ← 上方：Agent 行为
      .ai-agent-head                    ← 「Agent 行为」+ 步骤计数 + 状态徽标（data-state=idle|running|done|failed）
      .ai-agent-list[data-ai-agent-list="1"]   ← 工具块/思考/提示/错误/diff 的宿主（自身 overflow:auto）
    .ai-chat[data-ai-chat="1"]          ← 下方：聊天
      .ai-thread[data-ai-thread="1"]    ← 用户/助手消息宿主（**类名保持不变**，verify-sessions 探针依赖它）
  .ai-compose                           （已有：快捷动作 + 输入框 + 用量条；实现不变）
```

### `web/src/panels/aiZones.ts` 的导出签名（单测 `web/tools/ui-checks/verify-ai-zones.ts` 按此写死）

```ts
export type AiStreamKind = "user" | "assistant" | "system" | "tool" | "thinking" | "notice" | "note" | "error" | "diff";
export type AiZone = "thread" | "agent";
export function zoneFor(kind: AiStreamKind): AiZone;
export interface AiStreamBlock { kind: AiStreamKind; ok?: boolean }
export interface AgentSummary { steps: number; failed: number; state: "idle" | "running" | "done" | "failed" }
export function summarizeAgent(blocks: AiStreamBlock[], opts?: { busy?: boolean }): AgentSummary;
```

`summarizeAgent` 判定顺序（顺序即优先级，别调换）：空列表 → `idle`；有 `tool.ok === false` → `failed`；`opts.busy` → `running`；存在 `tool.ok === undefined`（末块还没回执）或存在 `thinking` 块 → `running`；其余 → `done`。
`steps` 只数 `kind === "tool"`；`failed` 只数 `tool.ok === false`。

### 元素去向（唯一规则，落在 `web/src/panels/aiZones.ts` 的 `zoneFor()`）

| 元素 | 目标宿主 |
| --- | --- |
| `.ai-msg.user` / `.ai-msg.assistant` | `.ai-thread` |
| `.ai-msg.system` | `.ai-agent-list` |
| `.ai-tool` | `.ai-agent-list` |
| `.ai-thinking` | `.ai-agent-list` |
| `.ai-notice` / `.ai-note` / `.ai-error` | `.ai-agent-list` |
| `.ai-diff` | `.ai-agent-list` |

顺序纪律：两个宿主各自**只追加**，不重排 —— 同一类元素在数组里的先后即渲染先后，跨区先后不要求（用户的心智是「上面是它干了什么，下面是我和它的对话」）。

## 3. 状态契约

- `.ai-panel.is-idle` ⇔ `turns.length === 0`（`turns` 是 aiPanel 现有会话数组）。
  - idle：`.ai-hero` 在，`.ai-agent` 与 `.ai-chat` 由 CSS 隐藏；`.ai-compose` 与 hero 一起在面板中垂直居中。
  - active：`.ai-hero` 移除，`.ai-agent` 在上 `flex: 1 1 auto`，`.ai-chat` 在下 `flex: 0 1 auto` 且 `max-height` 约 46%，`.ai-compose` 贴底。
- `.ai-panel[data-busy="1"]` ⇔ `currentRequest !== ""`（用于 agent 头部的「执行中」呼吸点）。
- `.ai-agent-head[data-state]`：`idle`（无块）/ `running`（busy 或最后一块无 `ok`）/ `failed`（存在 `.ai-tool.failed`）/ `done`（其余）。

### 调试/验收出口（main.ts 的 `__BWE__`）

- `enterAiMode()` / `exitAiMode()` / `aiMode(): boolean`
- `debugAiStream(n)`：往当前面板灌 `n` 条**假的**工具调用（`callId: demo-N`）+ 1 条用户消息 + 1 条助手消息，只改内存 DOM，用于验证「工具块不被压扁」。

## 4. shell / editor 契约

`web/src/ui/shell.ts`：

- `setAiMode(on: boolean): void` —— 在 `this.root`（`.app-root`）上切 `ai-mode` 类；进入前记住 `sidebar/panel/ai` 三处折叠状态与 AI 栏宽度，退出时原样恢复。
- `aiModeOn(): boolean`
- 进入时必须**清掉 `.ai-dock` 的内联 `flex` / `width`**（`setAiPanelWidth` 写的是内联样式，优先级高于样式表 —— 不清就等于 `ai-mode` 的 `flex:1` 不生效，这个坑 `toggleAiPanel` 里已经踩过一次）。
- 进入：侧边栏折叠、底部面板折叠、AI 栏展开、`aiResizer` 隐藏；退出：逐项恢复。

`web/src/app/editor.ts`：

- `enterAiMode()` / `exitAiMode()` / `aiModeActive()`；`focusAiPanel()` 改为 `enterAiMode()`（保留旧名做别名，命令面板与 `openBottomTab("ai")` 都走它）。
- `onActivity(id)`：`id !== "ai"` 且当前在 AI 模式 → 先 `exitAiMode()`，再执行原有分支；`id === "ai"` → `enterAiMode()`。
- `.ai-dock-head`：AI 模式下显示「退出 AI 界面」按钮（`data-ai-exit="1"`）并隐藏「收起」；非 AI 模式反过来。
- 快捷键 `Ctrl+Shift+A`：AI 模式内外都是「进入 / 退出 AI 界面」（不再只做折叠）。

## 5. 样式契约与「被挤成一条缝」的根因

根因（已确认，不是猜）：`.ai-thread` 是 `display:flex; flex-direction:column; overflow:auto`，子元素默认为 `flex-shrink:1`；
而 `.ai-panel .ai-tool { overflow: hidden }` 让它自己的 `min-height:auto` 解析为 **0**。于是工具块一多，总高超出容器，每条都被压到几像素 —— 表现为「挤成一条缝」。

修法（必须同时满足）：

```css
.ai-thread > *, .ai-agent-list > * { flex: 0 0 auto; }   /* 不许收缩 */
.ai-panel .ai-tool { min-height: 34px; }                  /* 头部一行 + 边框的可读下限 */
```

另：`.ai-agent-list` 自己滚动，`.ai-agent` 给 `min-height: 120px`，`.ai-chat` 给 `min-height: 110px`，两区都不会把对方压没。

AI 模式的几何：

```css
.app-root.ai-mode .sidebar-wrap,
.app-root.ai-mode .sidebar-resizer,
.app-root.ai-mode .editor-area,
.app-root.ai-mode .aux-panel,
.app-root.ai-mode .ai-resizer,
.app-root.ai-mode .panel,
.app-root.ai-mode .panel-resizer { display: none; }

.app-root.ai-mode .ai-dock { flex: 1 1 auto; width: auto; border-left: 0; }
```

内容列最大宽度 880px 居中（`margin-inline:auto`），1280×720 下不得出现横向滚动。

## 6. 验收（机器判定）

- `npm run typecheck` / `npm run build` 必须过。
- `node desktop/tools/verify-ai-dock-layout.mjs`（真 Electron 量几何）新增断言：
  1. 非 AI 模式：`.ai-dock` 仍是右侧固定宽度栏且 ≥320；
  2. `enterAiMode()` 后：`.app-root.ai-mode` 在、`.editor-area` 与 `.sidebar-wrap` 不可见、`.ai-dock` 宽 ≥ 窗口宽 − 活动栏 − 24、无横向溢出；
  3. 点活动栏「资源管理器」后：退出 AI 模式且 `.editor-area` 宽 > 0；
  4. `debugAiStream(12)` 后：12 条 `.ai-tool` 每条高度 ≥ 24、`.ai-agent-list` 出现纵向滚动、`.ai-thread` 里消息 ≥ 1；
  5. 空闲态：`.ai-panel.is-idle` 在、`.ai-agent` 不可见；灌消息后 `is-idle` 消失、`.ai-chat` 可见、`.ai-compose` 底边贴近面板底边。
- `npm run verify:ui:all` 里既有用例（尤其 `verify-tool-blocks`、`verify-sessions`）不得回退。

### 实际分派（2026-11-12 落地）

- `npm run verify:ai-zones` —— `web/tools/ui-checks/verify-ai-zones.ts`（纯函数：分区规则 + Agent 头摘要，20 项）
- `npm run verify:ai-interface` —— `desktop/tools/verify-ai-interface.mjs`（真 Electron 量几何，31 项；上面的 1-5 条都在这里）
- `node desktop/tools/verify-ai-dock-layout.mjs` —— 右侧栏形态的回归（22 项，未改一行断言，仍全绿）
- 截图入口（验收用隐形按钮，产品上不可见）：`[data-demo-ai-stream]` 灌 8 条演示工具调用
  ```bash
  node desktop/main.mjs --shot=ai-idle.png   --size=1600x1000 --tap='[data-activity="ai"]'
  node desktop/main.mjs --shot=ai-active.png --size=1600x1000 --tap='[data-activity="ai"],[data-demo-ai-stream]'
  ```

## 7. 实测几何（记下来，别靠猜）

| 视口 | .ai-dock | .ai-agent | .ai-chat | .ai-compose | 工具块高度 | 横向溢出 |
| --- | --- | --- | --- | --- | --- | --- |
| 1600×1000（AI 模式，12 条工具） | 1552×934 | 550（自滚 574） | 110 | 贴底 0px | 12 × 34px | 无 |
| 1280×720（AI 模式，8 条工具） | 1238×654 | 856×300 | 856×110 | 880×138（底 694 = 面板底） | 8 × 34px | 无 |

右侧栏形态（非 AI 模式）未变：1600 下 460 宽、1280 下 410 宽、与辅助栏同高。

已知取舍：空闲态 hero + 输入卡是**用 auto 外边距居中**的（不是 `justify-content:center`），
所以视觉中心比面板中心低约状态条高度的一半（实测 ~31px）—— 顶上那条模型选择条仍在流内。
换成绝对定位可以像素级居中，但矮窗口会把标题压在状态条下面，选择了安全的一侧。


---

# v2（2026-11-12 二轮）：历史进左侧栏 + 启动不留 AI 小窗口

## 8. 两条新要求（用户原话）

1. 「参考完整布局改进，**把历史做到左侧**」——会话历史从浮层（popover）升级为 AI 界面**左侧常驻栏**。
2. 「主界面刚启动的时候还是有个小 AI 窗口，这很不对劲，**把那个残留去掉**」——启动时不应出现右侧 460px 的 AI 窄栏。

## 9. 页面布局（AI 界面 = 左历史 + 右主区）

```
.ai-dock
  .ai-dock-head                       ← 标题 + 模型/会话信息 + 「退出 AI 界面」
  .ai-dock-body
    .ai-dock-tabs                     ← AI 助手 / 项目知识库（高度 30px 不变）
    .ai-dock-content
      .ai-panel[data-ai-zone="1"][data-ai-layout="page"]
        .ai-page                      ← 新增：两列
          .ai-history[data-ai-history="1"]        ← 左：会话历史（常驻）
            .ai-history-head                      ← 「历史」+ 「+ 新建」按钮（data-ai-session-new）
            .ai-history-list[data-ai-history-list="1"]
              .ai-session-row[data-ai-session-item][data-session-id]   ← 复用既有类名与锚点
                .ai-session-main[data-ai-session-pick="<id>"]
                  .ai-session-title / .ai-session-sub / .ai-session-now
                .ai-session-del[data-ai-session-delete]
            .ai-history-foot                      ← 会话计数（「共 N 个会话」）
          .ai-main
            .ai-head                  （模型选择器 / 状态 chip，原样）
            .ai-streams               （§2 的双区，**内容列铺满主区、不再居中 880**）
              .ai-hero / .ai-agent / .ai-chat
            .ai-compose
```

纪律：
- **不新造会话行的类名**：`.ai-session-row / .ai-session-title / .ai-session-sub / .ai-session-now / .ai-session-del`
  与 `data-ai-session-pick / data-ai-session-delete / data-ai-session-new / data-ai-session-item` 全部沿用 ——
  `desktop/tools/verify-sessions.mjs` 与 `web/tools/ui-checks/README.md` 都按这些锚点定位。
- page 布局下**不再渲染**「历史」浮层按钮（`data-ai-sessions`）；浮层保留给 dock 布局（默认不出现）。
- `renderAiPanel(host, onRepaint, opts?: { layout?: "page" | "dock" })`，缺省 `"dock"`；
  page 时根节点写 `data-ai-layout="page"`，dock 时写 `"dock"`。
- 历史栏宽度：默认 260px（1400 宽以下 232px，1000 宽以下 0 —— 折叠掉，靠 `data-ai-history` 上的
  `data-collapsed` 状态与头部按钮切回）。主区永远 `flex:1 1 auto; min-width:0`。

## 10. 启动态：禁止 AI 小窗口

- `Shell` 构造完成后 AI 栏处于 **collapsed**（宽度 0、不渲染面板）；`renderAiDock()` 在折叠态直接返回，
  因此启动时 DOM 里既没有 460px 窄栏、也没有 `.ai-panel`。
- AI 唯一入口 = 活动栏「AI 助手」/ `Ctrl+Shift+A` / 命令 `ai.focus` / `openBottomTab("ai")` → 全部进 AI 界面。
- `desktop/tools/verify-ai-dock-layout.mjs` 的默认态断言改为「默认收起（宽 0）」，需要量右侧栏形态时
  由脚本自己调 `__BWE__.editor.toggleAiPanel()` 展开 —— 窄栏能力保留（回归项），但不再是默认外观。
- 新增断言（`verify-ai-interface`）：启动后 `.ai-dock` 宽为 0 且不存在 `.ai-panel`；进入 AI 界面后
  `.ai-history` 存在且至少 1 行会话；点某一行后 `.ai-session-row.active` 跟着换。

## 11. 参考图读数（D:/完整布局.png，2559×1452，2x）

- 底色 #151517，面板 #1B1B1C / #212123 / #2C2C2E（深色主题）；内容区 x 0..2558。
- **左列 0..422px（16.5%）**：整列条目列表 + 顶部标题 + 底部按钮 → 会话历史栏（≈211 CSS px @1280）。
- 竖向分隔 423..461，主区自 462 起。
- **主区**：内容行铺满（≈630..2490），不是窄居中列；每行是一条 Agent 行为/消息。
- **底部**：一条几乎满宽的圆角输入卡（高约 96 CSS px），右下角蓝色发送按钮。
- 结论：历史栏固定宽、主区内容铺满、输入卡贴底且宽。这三条已写进 §9。
