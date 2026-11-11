# BrokenWonderEngine · BWE

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Java](https://img.shields.io/badge/runtime-Java%2017~25-orange.svg)](tools/bwe.ps1)
[![Electron](https://img.shields.io/badge/editor-Electron%2037%20%2B%20TypeScript-9feaf9.svg)](desktop/README.md)

**中文** | [English](README.en.md)

> 一个自制的 2D 俯视角游戏引擎：Java + JOGL 负责跑游戏，TypeScript 负责做编辑器。
> 你在浏览器/桌面编辑器里摆场景、拼模块、写 JS，点一下打出 Windows EXE / Android APK。

![BWE Studio 编辑器总览](docs/readme/raw/editor/hero.png)

---

## 这是什么

BWE 由两块拼起来，界限很清楚：

| 部分 | 技术栈 | 干什么 |
|---|---|---|
| **BWE Studio** | TypeScript + Electron 37 | 可视化编辑器：摆场景、拼模块、写脚本、烘焙光照、预览、打包 |
| **BWE Runtime** | Java 17~25 / JOGL 2.1 固定管线 | 读 `boot.json` 跑游戏：渲染、物理、脚本（Rhino 1.7.15，ES5） |

编辑器和运行时之间只靠一份**映射契约**（[`docs/mapping-contract.md`](docs/mapping-contract.md)）通信：
`.bwproj` 工程文件 → `Build/boot.json` + 素材 → 运行时读取。契约的任何一侧改了行为，另一侧必须一起改，否则画面就不对。

## 现在能跑什么

编辑器里内置了 10 个可以直接打开的工程（`web/examples/*.bwproj`），从 3 个对象的扫雷到 1309 个对象的城市，
都是同一套引擎按真实数据跑出来的：

| 扫雷（可玩，横竖屏双版） | 孤胆枪手（8 脚本射击） |
|---|---|
| ![扫雷](docs/readme/raw/runtime/minesweeper-landscape-fit.png) | ![孤胆枪手](docs/readme/raw/runtime/alien-shooter.png) |

| 2D 光照（烘焙 + 动态 + 遮挡） | 开放世界城市（1309 对象 / 101 素材） |
|---|---|
| ![2D光照](docs/readme/raw/runtime/lighting-2d.png) | ![开放世界城市](docs/readme/raw/runtime/open-world-city.png) |

| 吸血鬼幸存者 | 涌现沙盘（火 / 烟 / 感知 AI） |
|---|---|
| ![吸血鬼幸存者](docs/readme/raw/runtime/vampire-survivors.png) | ![涌现沙盘](docs/readme/raw/runtime/emergence-sandbox.png) |

> 以上 PNG 全部由**真实引擎**离屏渲染：`.bwproj` → `boot.json` → JDK 跑 `OffscreenFrameDump`
> （FBO 离屏 GL，推进 45 帧后 `glReadPixels` 存盘），不是 UI 截图，也不是设计稿。
> 每张图的像素统计、引擎自报 draw call、以及「3 帧 vs 45 帧是否不同」的动画对照都在
> [`docs/readme/raw/runtime/SHOTS.md`](docs/readme/raw/runtime/SHOTS.md) 里，可以逐条核。

## 编辑器长什么样

整个界面按 VS Code 的结构排：活动栏 / 侧边栏 / 多标签编辑区 / 底部面板 / 状态栏 / `Ctrl+Shift+P` 命令面板。

| 剧本（JS / Yarn 双语言） | 模块与规则 |
|---|---|
| ![剧本面板](docs/readme/raw/editor/script.png) | ![模块面板](docs/readme/raw/editor/modules.png) |

| AI 助手（带 token 计量） | 命令面板 |
|---|---|
| ![AI 面板](docs/readme/raw/editor/ai.png) | ![命令面板](docs/readme/raw/editor/palette.png) |

<details>
<summary><b>更多界面截图（资源管理器 / 预制体 / 打包 / 光照 / 设置 / 小窗下限 / 深色主题）</b></summary>

| 资源管理器 + 画布 | 预制体 Prefab |
|---|---|
| ![资源管理器](docs/readme/raw/editor/explorer.png) | ![预制体](docs/readme/raw/editor/prefabs.png) |

| 打包面板 | 打包工作台 |
|---|---|
| ![打包](docs/readme/raw/editor/package.png) | ![打包工作台](docs/readme/raw/editor/package-workbench.png) |

| 光照烘焙面板 | 设置 |
|---|---|
| ![光照](docs/readme/raw/editor/lighting.png) | ![设置](docs/readme/raw/editor/settings.png) |

| 1280×720 小窗下限 | midnight 深色主题 |
|---|---|
| ![小窗](docs/readme/raw/editor/mobile.png) | ![深色](docs/readme/raw/editor/midnight.png) |

</details>

## 三分钟跑起来

### 双击就能开

Windows 上双击仓库根目录的 **`start.cmd`**，等它把五件事做完，编辑器窗口自己就出来了：

```
 [1/5] Node.js v24.16.0
 [2/5] npm dependencies: already installed
 [3/5] Electron runtime: already vendored
 [4/5] Building front-end bundle (web/dist/studio.js)
 [5/5] Starting BWE Studio...
```

它做的事就是下面那五行命令，只是帮你把「装依赖 / 重建 Electron / 打包前端 / 启动」串起来，每一步都幂等：
已经做过的步骤第二次直接跳过，缺 Node 或网络不通时会停在原地告诉你缺什么，不会留下一个白窗口。

Linux / macOS / Git Bash 用 `./start.sh`，五步一样。但**桌面壳只有 Windows 能跑**：仓库里的
`desktop/vendor/electron/` 是 win32-x64 的二进制，`fetch-electron.mjs` 解的就是那个 Windows zip。
所以在 Linux / macOS 上 `start.sh` 会说明这一点，然后退到网页版（`npm run dev`，不需要 Electron）。

两个脚本都接受透传参数，例如 `start.cmd --shot=out.png --size=1600x1000` 会直接进入截图模式。

> 编辑器的界面与下面所有截图都是**同一份前端 bundle**。`start.cmd` 只是把「打开它」这件事压成一次双击，
> 没有另一套启动路径，也没有隐藏的开关。

### 只想看编辑器（手动四步）

桌面版要跑起来需要三样东西：Node 依赖（`esbuild` 打前端 bundle）、Electron 运行时、以及打好包的 `web/dist/studio.js`。
最后那个在 `.gitignore` 里，所以**必须自己 build 一次**；Electron 运行时也不入库（`desktop/vendor/`，317MB），
但可以从本机缓存离线重建。跑起来之后就不需要再起本地服务了。

```powershell
git clone https://github.com/Mr6272/BrokenWonderEngine.git
cd BrokenWonderEngine

node desktop/tools/fetch-electron.mjs   # 从本机 electron 缓存离线解压，不联网
npm install                             # 只装 esbuild + typescript（前端 bundle 用）
npm run build                           # esbuild 打包前端 → web/dist/studio.js
npm run desk                            # 启动桌面版
```

打开后：`文件 → 扫雷示例`（或按 `Ctrl+Shift+P` 搜「示例」），然后点工具条上的「预览」就能试玩。

### 直接跑命令行

不经过编辑器也可以，仓库里的每个能力都有一条命令：

```powershell
# 启动桌面版（start.cmd 的最后一步就是它）
npm run desk
node desktop/main.mjs

# 截图取证（自动用 vendor 里的 electron.exe 重启，跑完即退）
node desktop/main.mjs --shot=out.png --size=1600x1000
node desktop/main.mjs --shot=out.png --size=1600x1000 --tap='[data-activity="modules"]'
node desktop/main.mjs --verify                 # 双尺寸自检：主题 / 横向溢出 / 非背景占比

# 网页版（构建 + 起本地服务）
npm run dev                                     # → http://localhost:5273
npm run serve                                   # 只起服务（假设已 build 过）
npm run watch                                   # 改前端自动重打包

# 用真实引擎离屏渲染一个工程出 PNG
node web/tools/render-minesweeper.mjs

# 打包成 EXE（jpackage）/ 打包后自检
npm run desk:pack
npm run desk:verify
```

`desktop/main.mjs` 的全部参数：`--shot=<png>`、`--size=WxH`、`--tap=<选择器,...>`、`--tap-seq=<步骤>`、
`--probe=<json>`、`--probe-dom=<json>`、`--e2e-script=<js>`、`--e2e-out=<json>`、`--console`、`--verify`、
`--user-data=<dir>`、`--ipc-probe=<json>`。

### 想跑 Java 运行时（预览 / 打包 / 自检都要它）

需要 **JDK 17~25**。

> ⚠ **不要用 JDK 26 去开预览/试跑窗口。** JOGL 2.1 依赖 `java.applet.Applet`，而 JDK 26 已把它移除，
> 真实 AWT 窗口初始化时会抛 `NoClassDefFoundError: java/applet/Applet`。
> （编译、无窗口测试、离屏渲染在 26 上其实都能跑通，崩的只有开窗那一条路。）
> `web/tools/package-bwe.mjs` 的 `findRuntimeJdk()` 会自动在 17~25 里挑。

```powershell
.\tools\bwe.ps1 build     # 编译全部 Java 源码 → .tmp_build\bin
.\tools\bwe.ps1 test      # 编译 + 跑 7 个测试套件
.\tools\bwe.ps1 run ScriptSelfTest        # 只跑一个测试类
```

`tools/bwe.ps1` 也接受透传的第五个位置参数：`offscreen <boot.json> <outPrefix> [frames] [w] [h]`。

### 网页版（不用 Electron）

```powershell
npm install
npm run dev      # 构建并在 http://localhost:5273 打开
```

网页版要起 `serve.mjs`，因为脚本诊断、打包、试跑这些能力都挂在它的 `/api/*` 上；桌面版把同一批能力
搬进了 Electron 主进程（共用 `web/tools/api-core.mjs` 这一份业务逻辑），所以桌面版不需要它。
`api-core.mjs` 里实现的顶层能力有 7 个：`js-check`、`script-complete`、`script-quickinfo`、
`script-file`、`open-in-vscode`、`quick-run`、`package-bwe`。

## 核心概念

### 两套运行时，各司其职

仓库里有两套引擎，是**有意保留**的，不是没清理干净：

```
 Studio Runtime（游戏主战场）
   .bwproj ──packageBwe.ts──> Build/boot.json + Build/scripts/*.js
        └──> Studio.runtime.TopDownRuntime
               ├ Actor（实体，纯数据行）
               ├ Viewport（世界↔屏幕唯一换算）
               ├ 精灵合批 / 纯色合批
               └ ScriptEngine（Rhino ES5，bwe.* 命名空间）

 Legacy Core（旧核心，保持可跑）
   Core.GameSekai / Framework.GameObject + IAbility
   职责：历史 Demo 不回归 + 作为能力组件生命周期的参考实现与测试对象
```

两套之间没有代码互调，只共享 `lib/` 依赖。为什么这样分、为什么不合并，写在
[`docs/open-world-architecture.md`](docs/open-world-architecture.md) §1（含证据）。

### 能力组件（Ability，旧核心）

`GameObject` 是一组能力的容器，行为靠组合获得：

```java
GameObject go = new GameObject();          // 自动附带 TransformAbility
Renderer2DAbility renderer = new Renderer2DAbility();
renderer.SpriteObj = new Sprite(SpriteWrapMode.Clamp, "Art/角色", "待机", 66);
go.AddAbility(renderer);                   // 统一入口：OnInit -> OnAdded -> 加入列表
```

生命周期：`OnInit()` → `OnAdded(go)` → 每帧 `OnUpdate()` → 销毁时 `OnRemove()`。

### 固定步长更新管线

`GameSekai.Update()` 按 **1/60 秒固定步长**推进（真实时间累积 + accumulator），所以逻辑、物理、协程都与帧率无关：
掉帧时游戏不会变慢，高刷屏也不会变快。渲染侧的 UI 补间与精灵动画走真实 `deltaTime`。

每帧顺序：逻辑更新（快照迭代，可安全增删对象）→ Transform 写进 JBox2D Body → 物理步进（速度/位置迭代 8/3）
→ Body 同步回 Transform → 自定义碰撞配对 → 协程推进。

### 脚本（Rhino ES5）

运行时是 **Rhino 1.7.15**，执行 **ES5**。`bwe` 全局对象完全由 Java 侧实现，没有 JS 预置脚本。

```js
function onStart(ctx) {
  ctx.self.setPos(120, 80);
}
function onUpdate(ctx, dt) {
  if (bwe.input.key("W")) ctx.self.move(0, -120 * dt);
}
```

几条硬规则（写错了运行时报错或静默失效）：

| 规则 | 说明 |
|---|---|
| 没有 `setTimeout` / `setInterval` | 用 `bwe.after` / `bwe.every` / `bwe.cancel`（走游戏时间，受暂停与 `timeScale` 影响） |
| 没有 `import` / `require` | 脚本之间用 `bwe.call(script, fn, ...args)` |
| 数组从 0 开始 | 这是 JS，不是 Lua：`array[0]` 是第一项 |
| 属性底层永远是字符串 | 与编辑器同构；用 `e.prop(k, def)` 按 def 的类型转型 |
| 布尔文本用 `"开"` / `"关"` | 读取时 `"开"` `"true"` `"1"` 都算真 |
| 钩子会被场景切换清空 | `bwe.scene.switchTo` 会清掉全部 `bwe.on` 钩子，且脚本顶层代码只跑一次不会重跑；钩子必须具名、在 `onStart`/`onSceneStart` 里先 `bwe.off` 再 `bwe.on` |

脚本报错不会让游戏停下：写进 `Build/bwe.log`，格式 `[脚本错误] <script>:<line>: <message>`，同一脚本同一行只报一次。

### 模块（可视化积木）

51 个内置模块，9 个分类，拖进去就能跑，参数面板可调，不用写代码：

| 分类 | 数量 | 举几个 |
|---|---|---|
| 移动 Movement | 8 | 朝玩家移动、巡逻、游荡、寻路、可推动、锁定 |
| 渲染 Rendering | 6 | 八向朝向、单次播放、闪烁、阴影、按 Y 排序、发光 |
| 检测 Detection | 6 | 碰撞体、范围、距离、视线、地形判定、重叠 |
| 事件 Events | 7 | 点击、进入/离开触发区、计时、变量、调用、条件 |
| 战斗 Combat | 6 | 生命值、近战、投射物、受击、死亡 |
| 对话 Dialogue | 4 | 气泡台词、对话框、分支选项、交互 |
| 表现 Feedback | 6 | 音效、音乐、特效、震屏、切场景、镜头跟随 |
| 网格 Grid | 4 | 棋盘、格子渲染、翻开规则、标记规则 |
| 玩法 Gameplay | 4 | 对象脚本、扫雷棋盘、换装部件、换装衣柜 |

模块名在编辑器里是「中文动作 + Unity 英文名」，例如「朝玩家移动 Follow Target」，
参数名也带单位，例如「移动速度 Move Speed (px/s)」。每个模块都填好了默认值，拖进场景立刻能跑。

模块和脚本**共存不打架**：模块负责默认行为，脚本再加一层逻辑。

### 2D 光照

光照维护一张覆盖整张场景的**光照贴图**，不给每个光源单独画圆：

| 模式 | 行为 |
|---|---|
| `baked` | 编辑器里烘焙一张静态底图（离线算遮挡阴影） |
| `dynamic` | 运行时每帧算（按 `dynamicFps` 节流） |
| `both` | 烘焙图打底 + 动态光叠加 |

脚本侧的 `bwe.light` 有 12 个成员：拨总开关 / 环境光 / 压暗（白天↔夜晚，不改场景数据）、
给实体挂一盏光（火把、车灯跟着跑）、在世界坐标临时加光（爆炸闪光）。

### 涌现式模拟

引擎只提供「材质 → 场 → 感知/记忆 → 物理」四层可组合基底，**行为由 JS 组合，不写死关卡**。
典型的一条链：点火 → 草地自燃蔓延 → 烧到油桶火势暴涨 → 烧穿木墙开路 → 烟雾挡视线 → 守卫听见声音赶来 → 水渠把火线切断。

## 截图是怎么来的（可复现）

这两种截图都是**从代码跑出来的**，不是手工截屏：

```powershell
# 编辑器界面：真实 Electron 窗口 + 隔离 userData，跑完即退
node desktop/main.mjs --shot=out.png --size=1600x1000 --tap='[data-activity="modules"]'

# 游戏画面：真实引擎离屏 GL 渲染，推进 45 帧后读像素
node web/tools/render-minesweeper.mjs
```

`--tap` 接受一串 CSS 选择器，依次点击后再截图，所以「打开某个面板之后长什么样」也能自动化取证。
`--verify` 会额外断言主题、横向溢出与非背景像素占比，用来防「白窗口 + 静默退出 0」这类假绿。

## 工程结构

```
src/                          Java 引擎（202 个文件 / 62550 行）
├── Studio/runtime/           Studio 运行时（72 个文件 / 44990 行），负责跑 boot.json 的那套
│   ├ TopDownRuntime.java      主循环 + 绘制
│   ├ ScriptApi/World/Prefab…  bwe.* 命名空间的 Java 实现（41 个命名空间 / 437 成员，其中 bwe.* 占 38 个）
│   ├ OffscreenFrameDump.java  离屏渲染取证工具（README 里的游戏截图就是它出的）
│   └ Minesweeper/GridModules  内置玩法与网格系统
├── Core/                     旧核心：GameSekai 主循环、物理、场景、碰撞、协程
├── Framework/                旧核心：能力组件（GameObject、Transform/Renderer/Collider/Camera）
├── UI/                       屏幕空间 UI（JSON 布局 + 补间）
├── Tool/                     Log / KeyManager / ImgLoader / TextureCache / FileManager
└── UserUsage/                历史 Demo（侠客、孟婆）

web/                          编辑器前端（59 个 .ts / 32915 行）
├── src/app/                  编辑器主体：canvas、editor、packageBwe、lightBake…
├── src/panels/               23 个面板文件：剧本、模块、预制体、AI、光照、搜索…
├── src/ui/                   外壳：活动栏、标签页、命令面板、toast
├── src/data/                 51 个模块定义、示例工程、API 文档数据
├── styles/                   cream.css（默认主题）+ app.css
├── examples/                 10 个 .bwproj 示例工程
└── tools/                    40 个入口（verify-* / gen-* / serve.mjs / package-bwe.mjs 等）

desktop/                      Electron 桌面壳（63 个 .mjs / 21640 行）
├── main.mjs                  引导层：不在 Electron 里就用 vendor 的 electron.exe 重启自己
├── lib/app-main.mjs          主进程 + 内嵌 API（与网页版共用 api-core.mjs）+ 截图/探针/自检模式
├── lib/ai/                   AI 层：路由、前缀缓存、剪枝、压缩、知识库、13 个工具
└── test/                     23 个单测

docs/                         文档（41 个 .md / 20702 行）
├── api/                      JS API 手册（18 页正文 + 1 页索引，Unity Scripting API 体例）
├── mapping-contract.md       编辑器 → 引擎 映射契约（改任一侧都要同步）
└── _fragments/               各轮改造的交付报告

lib/                          7 个 jar：jogl-all 2.1.2、gluegen-rt 2.1.2、jbox2d 2.1.2、gson 2.13.1、rhino 1.7.15
```

## 自检

这个仓库的纪律是**每个能力都要有一条能跑的命令证明它没坏**，不靠肉眼。

```powershell
# Java 侧：7 个测试套件，396 项断言（需 JDK 17~25）
.\tools\bwe.ps1 test

# Java 8 兼容性闸门（打包链路用 --release 8，用 Java 10+ API 会当场失败）
npm run check:java8

# TypeScript 类型检查
npm run typecheck

# API 四方一致性：Java ↔ bwe.d.ts ↔ apiDocs.ts ↔ docs/api
npm run verify:apidocs

# 编辑器 → 打包 → Java 运行时 全链路往返
npm run verify:roundtrip
npm run verify:uiscene
npm run verify:openworld

# 内置示例的字段完整性（接口层）+ 载入后各面板不崩（真 Electron 端到端）
npm run verify:example-fields
npm run verify:example-panels

# 一次跑完
npm run verify:all
```

实测结果（2026-11-11，本机 JDK 25 / Node 24.16）：

| 命令 | 结果 |
|---|---|
| `tools/bwe.ps1 test` | 7/7 套件通过，396 项断言全绿 |
| `npm run typecheck` | 0 错误 |
| `npm run verify:roundtrip` | 19/19 通过 |
| `npm run verify:uiscene` | 47/47 通过 |
| `npm run verify:openworld` | 51/51 通过 |
| `npm run verify:example-fields` | 34/34 通过 |
| `npm run verify:example-panels` | 32/32 通过 |
| `npm run check:scripts` | 全部脚本无类型错误 |
| `npm run verify:apidocs` | 0 条「编造/未实现」；162 处「缺文档」 |

最后两条是为一类具体 bug 加的：`web/examples/` 里有 6 个工程缺 `prefabs` 字段（历史版本早于这个字段），
而「载入内置示例」走的是 `cloneProject()`，一度绕过了 `normalizeProject()` 的字段兜底，
结果点开预制体面板只剩十几个字并抛 `TypeError: ... undefined (reading 'length')`。
`verify:example-fields` 在接口层断言字段齐全，`verify:example-panels` 在真实 Electron 里
经命令面板逐个载入 7 个示例、点开预制体面板、并核对**工程名真的变了**（防止 7 次循环测的其实是同一个工程）。

`verify-apidocs` 检查的是**文档里出现的成员在 Java 里真的有实现吗**。
现在的结论是「0 条编造」，说明文档没有吹牛；但那 162 处「代码有、文档没写」是真实欠账。

这个脚本有两种跑法，别混：`verify:apidocs` 带 `--strict`，会把「缺文档」也算失败（退出码 1），
适合 CI；`verify:apidocs:soft` 只对「编造/未实现」报错，`verify:all` 用的是后者。
（最早 `verify:all` 的第一步就是 `--strict` 版本，于是它在那 162 处欠账清掉之前**从来没跑通过** —— 后面几项压根没执行。）

两处已经知道和实际实现不符的地方，留在明面上：

- `tools/bwe.ps1` 把 JDK 路径硬编码成 `jdk-25.0.3.9-hotspot`（找不到就 throw），
  它并没有实现「在 17~25 之间挑一个」；真正按区间挑的是 `web/tools/package-bwe.mjs`
  里的 `RUNTIME_JDK_MIN = 17` / `RUNTIME_JDK_MAX = 25`。
- `check-java8.mjs` 的 `findJavac()` 注释写着「优先 JDK 17~25」，代码里其实是 `return candidates[0]`，
  不做版本判断。把 `JAVA_HOME` 指向 JDK 26 时它照样用 26 编译并通过。

JDK 26 也并非全崩：编译、无窗口测试、离屏渲染都能跑通，**崩的只有真实的 JOGL AWT 窗口**
（`JAWTWindow.determineIfApplet` → `NoClassDefFoundError: java/applet/Applet`）。
所以「不要用 26」针对的是预览和试跑窗口，不是全部场景。

## AI 助手

编辑器右侧常驻 AI 栏，设计目标是**省 token**：本地零 token 路由、稳定前缀缓存、工具按需注入、
结果剪枝、分层压缩、无损续接，面板底部实时显示缓存命中率与三类 token。

AI 有 13 个工具，其中 4 个是写类，全部围绕**结构化工程模型**而不是生成一坨脚本文本：

| 类别 | 工具 |
|---|---|
| 读 | `ReadFile`、`ReadToolResult`、`SceneDigest`、`SearchApi`、`ListScripts`、`ReadScript`、`ProjectDigest` |
| 写 | `WriteScript`、`PatchScript`、`DeleteScript`、`ApplyProjectOps` |
| 知识 | `SearchKnowledge`、`ReadKnowledge` |

`ApplyProjectOps` 是事务性的：一个计划要么整体成功，要么整体回滚，不留半成品场景。
没有 API Key 时走本地 mock 演示模式（面板仍可用，但**不假装调通**）。

## 已知边界

- 渲染是 **OpenGL 固定管线**（`glBegin/glEnd` + 显示列表）。已做纹理按路径共享 + 同纹理合批
  （实测 `glBegin` 从 162→7 次/帧有贴图，3575→20 次/帧纯色瓦片，**输出像素逐位一致**），
  但还没迁到 VBO / 图集批处理。
- 两套碰撞入口并存：JBox2D 接触（物理）+ `CollisionSystem` 配对（每帧触发，无 enter/stay/exit 语义）。
- 协程是回调式接口（`Coroutine.update()`），不是语言级 yield。
- 全局状态较多（`GameSekai.GameObjects` 等 static 字段），单窗口 Demo 够用，多场景/多窗口需要收敛为实例。
- 文档欠账 162 处「代码有、文档没写」（见上）。

## 文档

| 文档 | 说明 |
|---|---|
| [`docs/api/`](docs/api/README.md) | **JS 脚本 API 手册**（41 个命名空间 / 437 成员，Unity Scripting API 体例） |
| [`docs/scripting-api.md`](docs/scripting-api.md) | 脚本系统契约（编辑器 / 导出器 / 运行时 / 文档四方共同遵守） |
| [`docs/mapping-contract.md`](docs/mapping-contract.md) | 编辑器 → 引擎 映射契约（坐标 / 尺寸 / 绘制顺序） |
| [`docs/open-world-architecture.md`](docs/open-world-architecture.md) | 开放世界架构设计与分层原则 |
| [`docs/desktop-migration.md`](docs/desktop-migration.md) | 桌面版接口契约（网页版的 `/api/*` 能力如何搬进主进程） |
| [`desktop/README.md`](desktop/README.md) | 桌面壳细节与全部命令行参数 |
| [`tools/vscode-bwe/README.md`](tools/vscode-bwe/README.md) | VS Code 扩展（`bwe.` 补全 401 条 + 9 条规则检查） |
| [`docs/readme/raw/`](docs/readme/raw/) | 本文所有截图的取证报告 |

## 用 VS Code 写脚本

编辑器里「剧本」面板的 JS / Yarn 编辑器有两个按钮：**VS Code 打开** 与 **载入 VS Code 改动**。
脚本存在 `.bwproj` 的 JSON 里而不是磁盘文件上，所以服务端会把它镜像成
`web/.build/scripts/<工程名>/<脚本名>.js|.yarn`，再用 `code -g file:line` 打开。

配套的 **BWE Script** 扩展给这些脚本提供补全 / 悬浮 / 签名帮助 / 规则检查：

```powershell
node tools/vscode-bwe/build-vsix.mjs
code --install-extension "tools/vscode-bwe/dist/bwe-script-0.1.0.vsix"
```

那 9 条规则检查针对的都是 ES5/Rhino 的真实坑：`import` / `require` / `export`、浏览器宿主对象、
`setTimeout`/`setInterval`、`onSceneStart` 里访问 `ctx.self`，这些在运行时一律不存在。

## 许可

MIT，见 [`LICENSE`](LICENSE)。`package.json` 与 `desktop/package.json` 都已标 `"license": "MIT"`。

用之前有几件事值得知道：

- `lib/` 里的依赖各有各的许可，而且都不是 MIT：

  | 依赖 | 许可 |
  |---|---|
  | JOGL 2.1.2 / GlueGen 2.1.2 | [New BSD 2-Clause](https://jogamp.org/cgit/jogl.git/plain/LICENSE.txt)（含 Sun / SGI / LWJGL / Khronos 等兼容条款） |
  | JBox2D 2.1.2 | [zlib](http://www.jbox2d.org/)（与上游 Box2D 一致） |
  | gson 2.13.1 | Apache-2.0（jar 的 `Bundle-License` 字段自报） |
  | Rhino 1.7.15 | [MPL-2.0](https://rhino.github.io/license.html) |

  MIT 只覆盖这个仓库自己的代码，不改变这些第三方库的条款。MPL-2.0 是文件级 copyleft：
  改了 Rhino 自身的源码要公开那些文件，但把它当依赖用不受影响。
- 仓库里的美术素材（`Assets/`、`Art/` 以及示例工程内联的图）来源不一，如果要商用建议先逐个确认。
  示例工程（`web/examples/`）里的素材目前都是**程序生成**的：像素画由 `web/tools/` 下的 `gen-*` 脚本用代码画，
  扫雷那套由 `tools/gen-minesweeper-assets-code.mjs` 合成（含音效与 BGM，全是正弦/噪声合成，不基于任何现成作品）。
  历史上扫雷用过一批来自仓库外委托单子的素材（含第三方 BGM），因为版权不在本仓库，已全部替换。
- Electron 运行时是打包时从本机缓存重建的，不进版本库。
