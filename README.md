# BrokenWonderEngine (BWE)

一个用 Java + JOGL 写的轻量 2D 游戏引擎，采用**能力组件（Ability）**架构：
游戏对象（`GameObject`）是一组能力的容器，行为通过组合 `TransformAbility`、
`Renderer2DAbility`、`BoxColliderAbility`、`CameraAbility` 等能力获得。

物理基于 [JBox2D](https://github.com/jbox2d/jbox2d)，渲染基于 JOGL 2.1（OpenGL 2.1 固定管线），
UI 是 JSON 驱动的屏幕空间组件系统（支持 F5 热重载与补间动画）。

## 目录结构

```
src/
├── AbstractLayer/       窗口与启动（MainWindow、MapGen 关卡生成接口）
├── Core/                核心循环（GameSekai 更新管线、GameRenderer 渲染、场景、碰撞、协程、Vector2）
│   └── Physics/Collider/ JBox2D 封装（ColliderWorld、BoxCollider2D）
├── Framework/           能力组件（GameObject、Transform/Renderer/Collider/Camera）
│   └── MapData/         关卡 JSON 数据模型 + MapLoader
├── TypeStructure/       数据类型（Sprite、SpriteAtlas、Tag）
├── Tool/                工具（Log、KeyManager、ImgLoader、TextureCache、FileManager）
├── UI/                  屏幕空间 UI（JSON 布局加载、按钮/标签/图片/补间）
└── UserUsage/           使用示例（xia_demo 侠客 Demo、FightMengpo 孟婆 Demo）
Data/                    关卡与 UI 布局 JSON
Art/                     美术资源
lib/                     依赖 jar（jogl、gluegen、jbox2d、gson）
test/                    单元测试
web/                     BWE Studio（Web 版 RPG 编辑器，源码在 web/src）
```

## 构建与运行

依赖：JDK 8+（JOGL 2.1 使用 `javax.media.opengl` 旧包名，不要升级 JOGL 主版本）。

VS Code 内 `Ctrl+Shift+B`（build），任务面板选择：

| 任务 | 说明 |
|------|------|
| `build` | 编译全部源码到 `bin/`（自动解压 native dll 到 `bin/natives`） |
| `package` | 打包 `BrokenWonder.jar` |
| `run` | 运行侠客 Demo（`UserUsage.xia_demo.gameWindow`） |
| `test` | 编译并运行单元测试（`test/CollisionSystemTest`） |

命令行等价操作：

```powershell
javac -d bin -encoding utf-8 -cp "lib/*" (Get-ChildItem -Recurse -Path src -Filter *.java)
java -cp "bin;lib/*" -Djava.library.path=lib UserUsage.xia_demo.gameWindow
```

## 核心概念

### 能力组件（Ability）

```java
GameObject go = new GameObject();          // 自动附带 TransformAbility
Renderer2DAbility renderer = new Renderer2DAbility();
renderer.SpriteObj = new Sprite(SpriteWrapMode.Clamp, "Art/角色", "待机", 66);
go.AddAbility(renderer);                   // 统一入口：OnInit -> OnAdded -> 加入列表
```

`IAbility` 生命周期：`OnInit()` → `OnAdded(go)` → 每帧 `OnUpdate()` → 销毁时 `OnRemove()`。

### 更新管线（固定步长）

`GameSekai.Update()` 按**固定步长 1/60 秒**推进（真实时间累积 + accumulator），
因此逻辑、物理、协程与帧率无关：掉帧时游戏不会变慢，高刷屏也不会变快。
渲染侧的 UI 补间与精灵动画使用真实 `GameRenderer.deltaTime` 推进。

每帧固定步长内的顺序：

1. 逻辑更新（`GameObject.Update` → 各能力 `OnUpdate`，快照迭代，安全增删对象）
2. Transform → JBox2D Body
3. 物理步进（速度/位置迭代 8/3）
4. Body → Transform（全部物体同步，离屏物体保持物理一致）
5. 自定义碰撞检测（两两配对，快照迭代）
6. 协程推进

### 纹理缓存

`Tool.TextureCache` 以资源路径为 key 缓存 GPU 纹理并带引用计数：
同一张图片整个引擎只上传一次显存；`GameRenderer.RecycleTex / DeleteTexture`
释放时引用计数减一，归零才真正删除。多帧命名约定：`头名称1.png ... 头名称N.png`，
`textures[frame-1]` 即第 frame 帧。

### UI 系统

- `UIManager.loadLayoutFromJson("Data/ui_layout.json")` 加载 JSON 布局（panel/label/button/image）
- F5 热重载：改 JSON 后按 F5 即时生效
- `UITweens.moveTo(...)` 做补间动画
- 分辨率自适应：用 `UIManager.getViewportWidth/Height()` 获取当前视口

## 关卡数据

`Data/level_01.json` 格式（`Framework.MapData.MapData`）：

```json
{
  "width": 20, "height": 15, "cellSize": 40,
  "objects": [
    { "type": "player", "x": 50, "y": 100, "rotation": 0, "scaleX": 1, "scaleY": 1, "z": 0 }
  ]
}
```

对象类型通过 `SceneObjReg.register(type, factory)` 注册，`Map.build` 里按类型实例化。
`Data/ui_layout.json` 与 `Data/DialogueData.json` 分别为 UI 布局与对话数据。

### BWE Studio（Web 编辑器 + Windows 桌面客户端）

**桌面版（推荐）**：不需要 `npm run serve`，双击 EXE 即可用，内置 AI 助手。

```powershell
node desktop/tools/fetch-electron.mjs   # 首次：离线重建 Electron 运行时（不联网）
npm run build                           # 构建前端 bundle
npm run desk                            # 启动桌面版
npm run desk:pack                       # 打包出 desktop/dist/win-unpacked/BWE Studio.exe
npm run desk:verify                     # 打包并自检（双尺寸 1600x1000 / 1280x720）
```

- 桌面版把网页版原来的 8 个 `/api/*` 能力搬进了 Electron 主进程，所以**不再需要本地 node 服务**；
  网页版行为不变（`serve.mjs` 仍可照旧跑）。
- 界面按 VS Code 结构重排（活动栏 / 侧边栏 / 多标签编辑区 / 底部面板 / 状态栏 / `Ctrl+Shift+P` 命令面板），
  默认主题是**奶油软科技**（`web/styles/cream.css`），另提供 `theme-midnight` 与 `theme-high-contrast`。
- AI 助手面板按 deepx / DeepSeek Harness 的思路做省 token：本地零 token 路由、稳定前缀缓存、
  工具按需注入、结果剪枝、分层压缩、无损续接；面板底部实时显示**缓存命中率与三类 token**。
  没有 API Key 时走本地 mock 演示模式（面板仍可用，不假装调通）。
- 完整交付说明见 [`docs/_fragments/desktop-report.md`](docs/_fragments/desktop-report.md)，
  接口契约见 [`docs/desktop-migration.md`](docs/desktop-migration.md)，
  桌面壳细节与全部命令行参数见 [`desktop/README.md`](desktop/README.md)。

**网页版**：

```powershell
npm install
npm run dev        # 构建并在 http://localhost:5273 打开
npm run typecheck
npm run gen:examples
```

- 工程文件为 `.bwproj`，`Ctrl+S` 保存，浏览器本地也会自动保存
- 内置示例：`文件 → 扫雷示例 / 换装示例`，对应 `web/examples/*.bwproj`
- 扫雷的行数、列数、地雷数，以及换装每个部位的造型，都在「模块编辑器」（工具栏「模块」或 `M`）里调
- 挂上 `game.minesweeper` / `game.dressup` 模块后，点「预览」可直接试玩

### UI 场景（界面独立编一层）

界面的排版不该和地图上的角色、地块混在同一个坐标系里。所以场景分成两类：

| 类型 | 坐标系 | 干什么 |
|------|--------|--------|
| **世界场景** | 格 × `tileSize` | 地图、角色、地块、触发区 |
| **UI 场景** | 设计分辨率像素（默认 1280×720） | 文字、图片、面板、按钮 |

- 场景面板左栏分成「世界场景」与「UI 场景」两组，点「新建 UI」建一张设计稿
- UI 场景的画布不画瓦片网格，改画「设计分辨率外框 + 5% 安全区」；右键菜单只给界面元素
- 文字用 `tags: ["label"]` + `props.text / textSize / textColor / textAlign` 表达，运行时按真实字体渲染
- 导出时 UI 场景进 `boot.json` 的 `uiScenes[]`（世界场景仍在 `scenes[]`），**旧工程导出的 boot.json 逐字节不变**
- 运行时把设计分辨率按「等比 contain 居中」铺进真实窗口，所以窗口缩放不会裁掉界面
- 完整契约见 [`docs/mapping-contract.md §6`](docs/mapping-contract.md)

### 用 VS Code 写脚本

编辑器「剧本」面板的 JS / Yarn 编辑器有两个按钮：**VS Code 打开** 与 **载入 VS Code 改动**。

- 脚本存在 `.bwproj` 的 JSON 里，不是磁盘上的文件，所以服务端会把它**镜像**成
  `web/.build/scripts/<工程名>/<脚本名>.js|.yarn`，再用 `code -g file:line` 打开（需要 `npm run serve`）
- 在 VS Code 里改完保存，编辑器轮询到 mtime 变化后会亮出「载入 VS Code 改动」，点一下取回
  （不自动覆盖，避免吞掉编辑器里正在敲的内容）
- 服务端找不到 `code` 命令时不会只说失败：文件已经写好，返回里带 `file` 与可执行的下一步

配套的 **BWE Script** VS Code 扩展给这些脚本提供补全 / 悬浮 / 规则检查：

```powershell
node tools/vscode-bwe/build-vsix.mjs
code --install-extension tools/vscode-bwe/dist/bwe-script-0.1.0.vsix
```

- 输入 `bwe.` 出补全（401 条，来自 `data/bwe-api.json`，由 `node web/tools/gen-vscode-api.mjs` 从
  `apiDocs.ts` + `bwe.d.ts` 生成）；悬浮显示签名、摘要、分组与 `docs/api` 链接
- 规则检查（9 条）：`import` / `require` / `export`、浏览器宿主对象、`setTimeout/setInterval`、
  `onSceneStart` 里访问 `ctx.self` 等 —— 运行时是 Rhino ES5，这些一律不存在
- 开了 `npm run serve` 后自动把源码 POST 到 `/api/js-check` 合并 TypeScript 诊断；
  没开服务静默降级成「仅规则检查」，不弹错误
- 详见 [`tools/vscode-bwe/README.md`](tools/vscode-bwe/README.md)

## 已知边界

- 渲染为 OpenGL 固定管线（`glBegin/glEnd` + 显示列表）。已做**纹理按路径共享 + 同纹理合批**：
  实测 `glBegin` 从 162→7 次/帧（有贴图）、3575→20 次/帧（纯色瓦片），**输出像素逐位一致**。
  后续可迁移到 VBO / 图集批处理进一步压提交量。
- 两套碰撞入口并存：JBox2D 接触（物理）+ `CollisionSystem` 配对（每帧触发，无 enter/stay/exit 语义）
- 协程是回调式接口（`Coroutine.update()`），不是语言级 yield 协程
- 全局状态较多（`GameSekai.GameObjects` 等 static 字段），单窗口 Demo 够用，多场景/多窗口需收敛为实例

## 文档

| 文档 | 说明 |
|------|------|
| [`docs/api/`](docs/api/README.md) | **JS 脚本 API 手册**（Unity Scripting API 体例，10 页 271 条目） |
| [`docs/scripting-api.md`](docs/scripting-api.md) | 脚本系统契约（编辑器 / 导出器 / 运行时四方共同遵守） |
| [`docs/mapping-contract.md`](docs/mapping-contract.md) | 编辑器 → 引擎 映射契约（坐标 / 尺寸 / 绘制顺序） |
| [`docs/_fragments/`](docs/_fragments/) | 本轮性能优化与预制体交付的详细报告 |

### 预制体（Prefab）

编辑器左栏「预制体 Prefab」可建模板、从场景对象抓取、拖进画布放置；
`boot.json` 的 `prefabs[]` 运行期自动注册，脚本里用 `bwe.prefab.spawn(名字, {x, y})` 实例化，
`bwe.pool` 做对象池。详见 [`docs/api/prefab.md`](docs/api/prefab.md)。

## 自检

```powershell
# 7 个测试类，共 394 项断言（需 JDK 17~25，不要 JDK 26）
$all = Get-ChildItem -Recurse -Path src -Filter *.java | Select-Object -ExpandProperty FullName
javac -d .tmp_rel8\rel -encoding utf-8 -cp "lib/*" $all
foreach ($t in 'ScriptSelfTest','ScriptFieldsTest','ScriptPhysicsTest','ScriptAiTest',
               'ScriptPrefabTest','ScriptPerfTest','ScriptContractTest') {
  java -cp ".tmp_rel8\rel;lib/*" "Studio.runtime.$t"
}

# API 四方一致性（Java ↔ bwe.d.ts ↔ apiDocs.ts ↔ docs/api）
node web/tools/verify-apidocs.mjs

# UI 场景往返一致性（模型保存→重开 / 导出 / Java 运行时真解析）
npm run verify:uiscene

# VS Code 扩展：数据表同步 + 单元测试 + 打包
node web/tools/gen-vscode-api.mjs --check
node tools/vscode-bwe/test/analyzer.test.mjs
node tools/vscode-bwe/test/table.test.mjs
node tools/vscode-bwe/test/serverCheck.test.mjs
node tools/vscode-bwe/test/extension.test.mjs
node tools/vscode-bwe/build-vsix.mjs
```

