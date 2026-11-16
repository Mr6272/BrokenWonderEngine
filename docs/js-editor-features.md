# BWE Studio · JS 编辑器代码功能（交付说明）

> 2026-11-13 于 `D:/githubdesktop/BrokenWonderEngine`。目标：把「带行号的 textarea」
> 升级成一套轻量 IDE —— 代码提示、补全、编译、查找引用、查找字符串等等。

---

## 一、怎么用（快捷键一览）

进 **剧本面板 → JS 脚本**，光标在代码区：

| 想做什么 | 快捷键 | 触发方式 |
|---|---|---|
| 补全 | `Ctrl+Space` | `bwe.` / `bwe.world.` 这类链上**自动弹**，其它位置手动 |
| 类型提示 | 鼠标在标识符上停 0.3 秒 | 显示签名 + 中文说明 |
| 跳转到定义 | `F12` | 跨脚本；内置 API 显示 `bwe.d.ts` 里的声明 |
| 查找引用 | `Shift+F12` | 跨脚本；结果在下部「引用」页签 |
| 编译（诊断 + ES5） | `Ctrl+B` | 产物在下部「编译」页签 |
| 查找字符串 | `Ctrl+F` | 支持 区分大小写 / 全词 / 正则 三开关 |
| 查找替换 | `Ctrl+H` | 「替换」「全部替换」，可 Ctrl+Z 撤销 |
| 下一个 / 上一个命中 | `F3` / `Shift+F3` | 查找条打开时 `Enter` / `Shift+Enter` 同效 |
| 括号配对高亮 | 光标落进括号 | 开闭两个括号同时标出 |
| 整行上移 / 下移 | `Alt+↑` / `Alt+↓` | 不破坏缩进，一步撤销 |
| 跳到某行某列 | 点「检查 / 大纲 / 引用」里的一条 | 同文件直接跳，跨文件先切脚本再跳 |
| 在全部脚本里搜一个词 | 查找条里的「工程内」按钮 | 把词带到左栏「搜索」面板 |
| 语法着色开关 | 标题行右侧「着色 开/关」 | 关掉后所有文字同色，便于专注读结构；状态记住 |

下部辅助区是**五页签**（检查 / 大纲 / 引用 / 编译 / API 速查），默认折叠把高度让给代码；
由 `F12` / `Shift+F12` / `Ctrl+B` 触发时会**自动展开**（折叠着等于按了没反应）。

---

## 一·五、语法着色（内置 API + JS 标准库都上色）

六个类别，各一色，三套主题各有一组配色：

| 类别 | 例 | 为什么单独一色 |
|---|---|---|
| `tk-comment` | `// 说明` `/* … */` | |
| `tk-string` | `'a'` `"b"` `` `c` `` | |
| `tk-number` | `123` `0x1f` `1.5e-3` | |
| `tk-keyword` | `var` `function` `return` `if` | |
| **`tk-bwe`** | `bwe` / `bwe.world` / `onStart` `onUpdate` | **引擎自己的 API**，与界面主色同族 |
| **`tk-global`** | `Math` `JSON` `Object` `Array` `console` `parseInt` … | **JS 内置 API**，冷色系，与 bwe 的暖色天然对照 |

一眼就能分清"这是引擎给的 / 这是语言标准给的 / 这是我自己的变量"。

**结构**（关键）：`textarea` 只负责输入与光标（文字透明、`caret-color` 保持可见），
覆盖层 `.js-hl` 显示**全部彩色文字**。两者是同一个 `.js-edit` 的子项 —— 只有这样才能保证同原点。

```
.js-code
├─ .js-gutter            行号栏
└─ .js-edit              ← textarea 与覆盖层同原点（这是修掉 40px 偏移的关键）
   ├─ textarea          输入层（文字透明）
   └─ .js-hl            显示层（彩色文字 + 搜索底色 + 括号 + 当前行）
```

**三个坑**（都不报错，只能靠断言发现）：

1. **输入法组字**：中文打拼音时组字串在 `textarea` 里而它的字是透明的 →
   不处理就是"打拼音时屏幕一片空白"。所以 `compositionstart/end` 切成 textarea 显示文字、
   覆盖层 `visibility:hidden`（必须成对，只改一边会重影或全消失）。
2. **着色开关关掉后仍要显示文字**：只停着色而不显示文字 = 整篇空白。
3. **`.js-hl-inner` 不能加 `position:absolute`**：滚动靠 `transform`（对 static 元素同样生效），
   而 padding 只在正常流子元素上推得动内容。改成 absolute 后文字整体左上偏 8/10px，
   而"6 项属性全同"的断言**依然绿**。

---

## 二、架构：五个能力共用一套语言服务

```
                         ┌─────────────────────────────────────────┐
  web/src/panels/        │  web/tools/script-language.mjs          │
   jsCodeIntel.ts  ─────►│  单个 TypeScript LanguageService 实例   │
   （唯一客户端门面）    │  + 项目级 service（跨脚本）+ LRU 缓存   │
                         └──────────────┬──────────────────────────┘
                                        │ 同一份代码，两条传输
                        ┌───────────────┴───────────────┐
                  网页版 │                               │ 桌面版
                web/tools/api-core.mjs            bwe:api → desktop/lib/api.mjs
                POST /api/script-*                    （无新 IPC 通道）
```

**为什么强制共用**：本仓库的历史事故几乎都是「两处各写一套，然后慢慢分叉」。
五个能力（补全 / 悬浮 / 定义 / 引用 / 编译）如果各自装配 TS，桌面版和网页版
迟早会出现「补全能用、提示不准」这类最难查的不一致。

新增端点（body 都是 `{ files, active, offset }`，`offset` 是 **UTF-16 code unit**，
与 `textarea.selectionStart` 同一口径，不做任何字符数换算 —— 中英混排时会错位）：

| 端点 | 返回 |
|---|---|
| `POST /api/script-references` | `{ok, refs:[{name,line,col,text,isDefinition}]}` |
| `POST /api/script-definition` | `{ok, defs:[{name,line,col,text}]}` |

`name` 是**脚本名**（不是文件路径）；命中内置 API 声明时为 `"__bwe_dts__"`
（它的 `line` 是 `.d.ts` 自己的行号，**不能**拿去当前脚本 `setSelection`）。

---

## 三、这次修掉的三个既有 Bug（都是端到端验收抓出来的）

这三个都不是"新功能没做好"，而是**原来就坏着、只是没人发现**：

### 1. `bwe:commit` 全仓库无人接收 → 一堆操作不可撤销

7 处代码（预制体面板、属性面板、模块编辑器、光照面板、AI 改脚本、删除对象、复制对象）
都在 `dispatchEvent(new CustomEvent("bwe:commit"))`，而**没有任何监听器**。

- 症状：删对象 / 改模块参数 / 改光源 / AI 改脚本后按 `Ctrl+Z`，**什么也没发生**。
- 为什么长期没发现：不报错、不红条，撤销按钮只是"没反应"，看起来像"没有可撤销的步骤"。
- 修法：在 `editor.ts` 的 `bindGlobalEvents` 里接住它 → `scheduleSnapshot`（320ms 合并）。
  离散动作可传 `detail.immediate = true` 要求**当场**入栈。

### 2. 撤销后剧本编辑器不重建 → 数据回退了、面板还显示改后的内容

`applySnapshot` 走 `store.setProject(新对象)`，整个 `scripts[name]` 都换成新引用，
而剧本编辑器持有旧 `script` 对象、textarea 里也还是撤销前的文本。用户接着敲一个字
就把它写回去了。修法：还原快照后广播 `bwe:refresh-script-ui` 让编辑器重建。

### 3. 查找条抢焦点 → 打开 Ctrl+F 后输不进第二个字符

`goto()` 无条件 `ta.focus()`，于是每跳一个命中焦点就回代码区，查找输入框立刻失焦。
修法：`goto(match, focusEditor)`，查找条自己驱动的跳转一律传 `false`。

---

## 四、验收（四条，全部可真跑）

```bash
npm run typecheck                       # 类型闸门
npm run verify:js-editor                # 82 条：编辑器纯逻辑（查找/替换/坐标/括号/大纲/移行）
npm run verify:js-tokenizer             # 43 条：语法着色令牌器（含性能：两万字符 4ms）
npm run verify:script-references        # 73 条：语言服务 + 两个端点 + 参数校验 + 性能
npm run verify:js-editor-ui             # 57 条：真 Electron / 真 store / 真 DOM 端到端
npm run verify:syntax-pixels            # 11 条：像素级（截图采样，证明颜色真的上屏）
```

端到端那 41 条里带 ★ 的是这次的关键回归：

- 覆盖层 `.js-hl` 与 `.js-source` 的**排版度量逐项一致**（6 项），
  这条是硬约束：改任何一边的字号/行高/padding 而不改另一边，高亮会整体错位一行。
- 替换后按 `Ctrl+Z`，**textarea 与 store 里的源码都回退**（两处都核，不只看 DOM）。
- 编译产物里**没有箭头函数 / const / 模板字符串**（证明真的降级到 ES5 了）。
- `Shift+F12` 时辅助区**自动展开**。
- `js-editor.css` 的**浏览器解析规则数 == 源文件花括号数**。

最后一条值得单独说：设计它是因为 css-ui 那轮真实踩到 —— 注释里写了「点星斜杠」
三字符序列，提前闭合了块注释，紧跟的 `.js-findbar-row` 整条规则被浏览器**静默丢弃**
（CSS 容错：坏一条跳过一条）。语法合法、文件能读、肉眼完全看不出来。
现在这条对账会把它变成红灯。

---

## 五、三个"看不出来"的坑（写给下一个改这里的人）

1. **`.js-hl` 与 `.js-source` 的排版度量硬耦合**。两边都必须写死 `12px / 19px`
   且 padding 同为 `8px 10px`，不能用 `1.6` 这类相对行高（浏览器算出来的整数不同，
   几百行之后就是整层错位）。验收脚本已用真实 Chromium 逐项比对。

2. **验收脚本不要用内嵌模板字符串写探针**。我用四种方式踩了同一类坑：
   注释里的反引号截断脚本、`split("\n")` 变成真实换行、正则 `\s` 被模板吃掉变成 `s`
   （这条**不报错**，只是让断言静默变绿或变红）。
   现在探针是独立文件 `desktop/tools/probes/js-editor-ui.probe.js`，
   并由验收脚本先跑一次 `node --check` 做语法闸门（语法错时给具名原因，
   而不是 Electron 那句 "Script failed to execute"）。

3. **验收脚本读陈旧 DOM 引用 = 确定性的假红/假绿**。
   撤销会重建剧本编辑器，所以撤销之后**必须重新 `querySelector`**，
   否则读到的还是已脱离 DOM 的旧 textarea（替换后的内容），于是"撤销没生效"永远红 ——
   而它其实生效了。同理，`Ctrl+H` 必须发给 `document.activeElement`
   而不是硬塞给 textarea（真实用户那时焦点在查找框里）。

---

## 六、改动的文件

**新增**

| 文件 | 说明 |
|---|---|
| `web/src/panels/jsEditorLogic.ts` | 纯逻辑：查找/替换、坐标换算、括号配对、大纲、整行移动 |
| `web/src/panels/jsOverlay.ts` | 搜索高亮覆盖层 + 字符宽度测量 |
| `web/src/panels/jsFindBar.ts` | 查找 / 替换条 |
| `web/src/panels/jsToolsPanel.ts` | 下部五页签（检查 / 大纲 / 引用 / 编译 / API 速查） |
| `web/src/panels/jsCodeIntel.ts` | 语言服务客户端门面（唯一出口，失败静默降级） |
| `web/styles/js-editor.css` | 新增 UI 的样式（只用既有设计令牌，支持三套主题） |
| `web/tools/verify-script-references.mjs` | 语言服务验收（73 条） |
| `web/tools/ui-checks/verify-js-editor.ts` | 编辑器纯逻辑验收（82 条） |
| `desktop/tools/verify-js-editor-ui.mjs` | 端到端验收（41 条） |
| `desktop/tools/probes/js-editor-ui.probe.js` | 端到端探针（独立文件，零转义） |

**修改**

| 文件 | 改动 |
|---|---|
| `web/src/panels/scriptPanel.ts` | `renderJsEditor` 重写（接上五页签 / 查找条 / 覆盖层 / 新快捷键） |
| `web/src/app/editor.ts` | 接住 `bwe:commit`（修不可撤销）；撤销后重建剧本 UI；`bwe:search-project` |
| `web/src/panels/searchPanel.ts` | 新增 `setSearchQuery()`（从编辑器带词进搜索面板） |
| `web/tools/script-language.mjs` | `references()` / `definition()` + 项目级 service + LRU 缓存 |
| `web/tools/api-core.mjs` | 两个 POST 端点 + 参数校验 |
| `web/index.html` | 加一行 `<link href="styles/js-editor.css">` |
| `docs/scripting-api.md` | §5.1 代码智能契约、§5.2 `bwe:commit` 语义 |
| `package.json` | 三个 verify 脚本 |

**性能实测**（6 脚本 / 12.7KB 工程）：跨脚本引用冷启动 273ms、缓存命中 1.2~2.4ms，
紧随其后的定义查询 1.4~2.5ms（共用同一 program，`F12` 不重复付费）。

---

## 七、已知限制（不是 bug，是有意的）

- **标准库成员查引用会返回空**：`Math.max` / `arr.push` 的命中落在 TS 自带的
  `lib.es*.d.ts` 里，按"不是用户代码"过滤掉了。此时标题会说明
  「在脚本里出现 N 次，但没有跨脚本引用」，不会静默空着。
- **同名生命周期会合并**：每个脚本都可以有自己的 `onStart`，TS 把它们视作同一符号，
  所以「引用」列表里会出现多条「定义」。标题会写明「N 处定义：每个脚本都可以有自己的…」。
- **正则字面量里的括号不参与配对**：`/[)]/` 里的 `)` 会被当成真括号高亮。
  区分它需要看前一个 token（那是另一条解析器线），而错判的后果只是高亮跳错位置，
  不会改坏文本。
- **大纲只覆盖常见形态**：`function` / `class` / `const x = () => {}` / 顶层变量 / 分节注释。
  解构声明、IIFE 内层、块内局部函数刻意不列（脚本是平铺过程式代码，列出来只会变吵）。
