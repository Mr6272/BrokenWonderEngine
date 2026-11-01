# BWE Script — VS Code 扩展

给 **BrokenWonderEngine（BWE）** 的 JS 脚本用的 VS Code 扩展：

- **补全**：`bwe.` 之后按命名空间给成员补全，带签名与摘要；
- **悬浮提示**：光标停在 `bwe.xxx.yyy` / `e.xxx` / `onStart` 上，显示签名、摘要、分组、文档链接；
- **签名帮助**：在 `bwe.draw.text(` 里逐参数提示；
- **生命周期代码片段**：`onStart` / `onUpdate` / `onClick` / `onSceneStart` … 一键生成函数骨架；
- **规则检查**（本地、离线可用）：`import` / `require` / `export`、浏览器与 Node 宿主对象、`setTimeout`、`onSceneStart` 里的 `ctx.self` 等坑；
- **类型检查**（可选）：把脚本源码 POST 到 BWE Studio 本地服务的 `/api/js-check`，把 TypeScript 诊断合并进 VS Code 诊断面板；**服务没开时静默降级**，只留一条状态栏提示。

> 数据全部来自生成的 `data/bwe-api.json`（`web/tools/gen-vscode-api.mjs` 从 `web/src/data/apiDocs.ts` + `web/src/js/bwe.d.ts` + `web/src/js/globals.d.ts` + `docs/api/*.md` 生成），扩展里**不手抄** API 名字。

---

## 一、安装

### 方式 A：装 vsix（推荐）

```powershell
# 在仓库根目录
node tools/vscode-bwe/build-vsix.mjs
code --install-extension "tools/vscode-bwe/dist/bwe-script-0.1.0.vsix"
```

VS Code 里也可以：「扩展」面板右上角 `...` → **从 VSIX 安装** → 选 `tools/vscode-bwe/dist/bwe-script-<version>.vsix`。

`code` 命令不可用时：VS Code 里执行 `Shell Command: Install 'code' command in PATH`，或直接用面板安装。
（本机 VS Code 的命令在 `D:\Microsoft VS Code\bin\code.cmd`。）

### 方式 B：目录方式（开发调试用）

```powershell
# 把目录整个复制到用户扩展目录，然后重启 VS Code
node tools/vscode-bwe/build-vsix.mjs --no-verify   # 先确认能打包
Copy-Item -Recurse tools/vscode-bwe "$env:USERPROFILE\.vscode\extensions\bwe.bwe-script-0.1.0"
```

（目录方式不做插件市场校验，适合改代码时热重启验证；日常使用请装 vsix。）

### 装完确认

1. 打开任意一个 BWE 脚本（`web/.build/scripts/<工程>/<脚本>.js`）；
2. 输入 `bwe.` → 应弹出补全列表；
3. 打开「问题」面板（`Ctrl+Shift+M`），诊断的「来源」列应显示 **BWE**；
4. 左下角状态栏出现 **BWE 检查：…**。

---

## 二、使用

### 1. 补全 / 悬浮 / 签名帮助

| 输入 | 得到 |
|---|---|
| `bwe.` | 全部顶层成员（`world` / `draw` / `camera` …） |
| `bwe.world.f` | `bwe.world.find` / `bwe.world.findAll`（带签名与摘要） |
| `onS` | `onStart` / `onSceneStart` 的代码片段 |
| 光标停在 `bwe.world.find` | 签名 + 摘要 + 分组 + `docs/api/world.md#…` 链接 |

> 数据表里**没有**的成员不会瞎补；拼错时会提示「是不是想写 `bwe.world`？」，而不是静默无反应。

### 2. 命令（`Ctrl+Shift+P` → 输入 `BWE`）

| 命令 | 作用 |
|---|---|
| `BWE: 检查当前脚本` | 立刻跑一次（规则 + 服务端），强制重试本地服务 |
| `BWE: 写入类型声明（bwe.d.ts → .bwe/）` | 复制 `bwe.d.ts` 到工作区 `.bwe/bwe.d.ts`，生成/合并 `jsconfig.json`（`checkJs: true`），让 **VS Code 自带补全**也能识别 `bwe` |
| `BWE: 打开当前 API 的文档` | 打开光标所在 API 的 `docs/api/xxx.md` 并跳到对应小节 |

**为什么有 `installTypes`**：扩展自己的补全只覆盖 `bwe.*` / `e.*` / 生命周期；
把 `bwe.d.ts` 装进工作区后，TypeScript 语言服务会给**全部** `bwe.*` 成员做类型检查与补全（含参数类型），
两者互补。**故意不复制 `globals.d.ts`**：它声明的是全局 `function onStart()`，
会和用户脚本里自己写的 `function onStart()` 冲突（`Overload signatures must all be ambient`）。

### 3. 生命周期片段

输入 `onStart` / `onUpdate` / `onSceneStart` 等前缀后按 `Tab`，会生成带参数名的函数骨架；
`bwescript` 可以一次生成整段脚本骨架。

---

## 三、配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `bwe.serverUrl` | `http://127.0.0.1:5273` | BWE Studio 本地服务地址（`npm run serve` 的默认端口） |
| `bwe.enableServerCheck` | `true` | 关掉后只做本地规则检查 |
| `bwe.enableRules` | `true` | 关掉后只做服务端类型检查 |
| `bwe.serverTimeoutMs` | `2500` | `/api/js-check` 超时；超时按「不可达」静默降级 |
| `bwe.checkDelayMs` | `500` | 编辑后多久开始检查（防抖） |

---

## 四、规则清单

**来源：本地分析器（`lib/analyzer.js`），离线可用，不依赖本地服务。**

| 编号 | 严重度 | 规则 |
|---|---|---|
| `E001` | error | 不能 `import`（Rhino 没有模块系统；跨脚本用 `bwe.scripts.call`） |
| `E002` | error | 不能 `require`（同上） |
| `E003` | error | 不能 `export` / `module.exports`（脚本共享一个全局作用域） |
| `E004` | error | 浏览器 / Node 宿主对象不存在：`document` `window` `localStorage` `sessionStorage` `XMLHttpRequest` `navigator` `location` `history` `requestAnimationFrame` `WebSocket` `process` `module` `exports` `global` `fetch` `alert` `confirm` `prompt` `open` |
| `E005` | warning | 没有 `setTimeout` / `setInterval` / `setImmediate` / `clearTimeout` / `clearInterval` → 用 `bwe.after` / `bwe.every` / `bwe.cancel` |
| `E006` | error | `onSceneStart` / `onSceneEnd` 里访问 `ctx.self`（场景脚本的 `ctx.self` 恒为 `null`，用 `bwe.world.find(...)`） |
| `W001` | warning | `console.log` 在引擎里被映射到 `bwe.log`，但这是契约外便利；建议直接写 `bwe.log` |
| `W002` | warning | `bwe.xxx` 拼错（按编辑距离 ≤2 给出最近候选，例如 `bwe.wrold` → `bwe.world`） |
| `W003` | warning | 不要用 `eval`（绕过脚本引擎的编译与诊断） |

**不误报的设计**：注释与字符串里的同名文本不参与匹配；`o.setTimeout(...)` 这类对象属性名不报；
**未知但不像拼错的成员一律不报**（`bwe.d.ts` 有时落后于 Java 实现，例如 `bwe.textinput.validate`）。

---

## 五、与服务端检查的关系

```
编辑脚本
   ├── 本地规则检查（立刻，离线，10~50ms）
   └── bwe.enableServerCheck 且服务可达时
         POST {source, name} → http://127.0.0.1:5273/api/js-check
         ← {ok, name, hasTypes, diagnostics:[{line,col,severity,message}], transpiled}
       把返回的诊断（来源标 BWE）与本地规则**合并**后显示
```

- 服务由仓库里的 `npm run serve`（`web/tools/serve.mjs`，默认端口 5273）提供；
  它的 `/api/js-check` 用 TypeScript + 仓库里的 `bwe.d.ts` / `globals.d.ts` 给脚本出诊断
  （`ok` 为 false = 有 error；`hasTypes` 为 false = 声明文件缺失，退化成纯语法检查）。
- **服务不可达 / 非 200 / 响应不是 JSON / 超时 → 静默降级**：
  不弹错误、不刷通知，只把状态栏改成 `BWE 检查：本地服务未启动（仅规则检查）`，
  并在 20 秒后才重试（避免每敲一个字都打请求）。
- 状态栏文案对照：

| 状态栏 | 含义 |
|---|---|
| `BWE 检查：通过（类型检查已启用）` | 规则 + 类型都过 |
| `BWE 检查：N 错误 / M 警告` | 有诊断（去「问题」面板看） |
| `BWE 检查：本地服务未启动（仅规则检查…）` | 服务没开 / 端口不对，只剩本地规则 |
| `BWE 检查：规则检查通过（服务端检查已关闭）` | 配置里关掉了服务端检查 |

---

## 六、已知限制

1. **只对「像 BWE 脚本」的 JS 文档生效**：文件里出现 `bwe.` 或 `function on…` 才激活诊断
   （避免在普通 JS 项目里刷无关诊断）。普通 JS 文件里 `bwe.` 补全仍可用（补全会主动看前缀）。
2. **补全数据是生成快照**：Java 侧新增 API 后要重跑
   `node web/tools/gen-vscode-api.mjs` 并重新打包安装，否则补全/悬浮看不到新成员
   （本地规则检查不受影响）。
3. **规则检查是手写扫描器，不是完整 AST**：极少数写法（例如把 `document` 存进变量、
   然后隔几层调用）不会报 —— 宁可漏报也不误报；精确的类型诊断交给 `/api/js-check`。
4. **`W002` 只覆盖「像拼错」的情况**：`bwe.d.ts` / `apiDocs.ts` 落后于 Java 时，
   不认识的成员不会报错（避免把已实现功能误报成错误）。
5. **没有 `.bwe` 目录自动创建**：`installTypes` 需要工作区已打开（`文件 → 打开文件夹`）。
6. **文档链接依赖仓库目录**：`bwe.openDocs` 与悬浮里的文档链接需要工作区位于
   BrokenWonderEngine 仓库内（能向上找到 `web/src/js/bwe.d.ts`）；扩展装在别处时链接退化为不可点。
7. **不支持 Yarn 脚本**（`.yarn`）：Yarn 是对话剧本，没有 `bwe` API 契约。

---

## 七、手工验收：两个现成的样例脚本

`test/fixtures/` 里有两个文件，打开 VS Code 后**直接对照**就能确认扩展在工作：

| 文件 | 期望 |
|---|---|
| `test/fixtures/demo-good.js` | 「问题」面板 **0 条** BWE 诊断（正常 BWE 写法不该有波浪线） |
| `test/fixtures/demo-bad.js` | **6 条**：`E001`(import) / `E005`(setTimeout) / `E004`(document) / `W001`(console.log) / `W002`(bwe.wrold 拼错) / `E006`(onSceneStart 里的 ctx.self) |

```powershell
# 用命令行在 VS Code 里打开（本机 code 在 D:\Microsoft VS Codein\code.cmd）
code tools/vscode-bwe/test/fixtures/demo-bad.js
```

同时验证补全：在 `demo-good.js` 里输入 `bwe.world.f` → 应出现 `find` / `findAll`；
输入 `bwe.draw.t` → 应出现 `text`；把光标放进 `bwe.draw.text(` → 出现签名帮助。

---

## 八、开发 / 重新生成数据

```powershell
# 1) 从 apiDocs.ts + bwe.d.ts + globals.d.ts + docs/api 重新生成数据表（自带自检）
node web/tools/gen-vscode-api.mjs

# 2) 只检查数据表是否与源码同步（CI 用；不同步退出码 1）
node web/tools/gen-vscode-api.mjs --check

# 3) 跑测试（纯 node，不需要 vscode）
node tools/vscode-bwe/test/analyzer.test.mjs
node tools/vscode-bwe/test/table.test.mjs
node tools/vscode-bwe/test/serverCheck.test.mjs

# 4) 打包 vsix（自带解包校验）
node tools/vscode-bwe/build-vsix.mjs
```

### 目录结构

```
tools/vscode-bwe/
├── package.json              # 清单：命令 / 配置 / snippets / main
├── extension.js              # 入口（CommonJS，只用 node 内置 + vscode）
├── lib/
│   ├── apiIndex.js           # 数据表索引 + 补全/悬浮纯函数（可 node 直接测）
│   ├── analyzer.js           # 手写规则检查器（注释/字符串遮罩 + 定点扫描）
│   └── serverCheck.js        # /api/js-check 客户端（永不抛异常）
├── data/
│   ├── bwe-api.json          # 生成的数据表（勿手改）
│   └── bwe.d.ts              # bwe.d.ts 副本（installTypes 用）
├── snippets/bwe.code-snippets
├── test/*.test.mjs
├── build-vsix.mjs
└── dist/bwe-script-<version>.vsix
```

数据表结构：`{meta, groupOrder, groups, apis:[{name, signature, summary, group, groupLabel, kind, link, typeOnly?, phase2?}]}`
（`meta.sha256` 记录三份源文件的哈希，`--check` 用它判断是否过期）。
