# Web 预制体（Prefab）交付报告

> Owner: web-prefab（task-5）
> 范围：BWE Studio Web 编辑器的预制体数据模型、左栏面板、Inspector 链接卡片、`boot.json` 导出链路。
> 配套：运行期 `bwe.prefab.*` 由 api-spawn 交付；本报告只覆盖 Web 编辑器侧。

---

## 一、改了哪些文件

| 文件 | 改动 |
|---|---|
| `web/src/core/model.ts` | 新增 `PrefabDef` 接口、`Project.prefabs`、`SceneObject.prefabId`；新增工厂与转换函数；`normalizeProject()` 里补 `prefabs` 与 `prefabId` 的逐字段兜底 |
| `web/src/panels/prefabPanel.ts` | **新建**。左栏「预制体」面板：列表 + 属性表单 + 建/复制/删/改名 + 从场景对象创建 + 放置到场景 + 拖放 |
| `web/src/app/editor.ts` | 左栏新增 `prefabs` tab；文件菜单加「预制体面板…」；监听 `bwe:prefab-view-center` 回填视图中心 |
| `web/src/app/canvas.ts` | 导出 `DND_PREFAB`；`onDrop` 支持预制体落点放置；新增 `viewCenterWorld()`；新增 `drawPrefabBadge()` 画链接角标 |
| `web/src/panels/inspector.ts` | 新增「预制体链接 Prefab」卡片（还原默认值 / 断开链接 / 失效链接处理） |
| `web/src/app/packageBwe.ts` | `unsupportedModules()` 同时扫预制体里的模块，返回 `{ids, inPrefab}`；打包面板加「有 N 个预制体会一起导出 / 其中 M 种模块不执行」提示 |
| `web/tools/package-bwe.mjs` | 新增 `prefabBootList()`，`writeBuild()` 的 `boot` 字面量加 `prefabs` 字段（Lead 一次性授权，仅此两处） |

**未改动**（按约束）：`web/src/js/bwe.d.ts`、`web/src/data/apiDocs.ts`、`web/src/data/modules.ts`、任何 `.java`。
`web/styles/app.css` 也没动 —— 新面板全部复用既有 class（`.item-list` / `.item` / `.card` / `.field-row` / `.mod-overview` / `.empty` / `.segmented`），没有新增样式。

### 一个重要的实现位置说明

任务描述里写「导出改 `web/src/app/packageBwe.ts`」，但**实际写 `boot.json` 的不是它**。
`packageBwe.ts` 只负责收集 IndexedDB 素材、`POST /api/package-bwe`、轮询进度；
真正拼 `boot.json` 的是服务端 `web/tools/package-bwe.mjs#writeBuild()`。
所以导出的改动落在 `package-bwe.mjs`（Lead 已授权，范围精确到「`boot` 字面量 + 一个新的组装函数」）。

---

## 二、UI 入口在哪

### 1. 左栏「预制体 Prefab」标签页（主入口）

左栏 tab 顺序：`素材 Assets` → `模块 Modules` → **`预制体 Prefab`** → `场景 Scenes` → `剧本 Script` → `工程 Project`。

面板结构（上↔下，不左右分栏，因为左栏本来就窄）：

```
[新建] [从场景对象创建]      ← 顶部动作
[搜索预制体名 / 说明]         ← 过滤：名字 / 说明 / 标签
─────────────
主角                   1 个   ← 列表条目：类型图标 + 名字 + 「类型 · 模块数 · 标签」+ 已用数量
  · 双击 = 放置到场景
  · 右键 = 放置 / 重命名 / 复制 / 删除
  · 拖拽 = 拖进画布，落在鼠标位置
─────────────
[放置到场景] [复制] [删除]
▸ 模板 Prefab：名称 / 说明 / 类型 / 标签
▸ 外观 Appearance：精灵 / 排序层级 / 旋转 / 缩放 / 碰撞体 / 动画模式与帧率
▸ 模块 Modules：只读概览 + 复制/粘贴模块 + 对象脚本选择
▸ 随机散布 Spawn Jitter：左右 / 上下散布
```

空工程时不是白屏，而是 `emptyState`：一句话讲清「预制体是什么」+ 一个立刻可点的「从当前场景对象抓一个」。

### 2. Inspector「预制体链接 Prefab」卡片（右栏）

只在**当前选中对象确实来自某个预制体**时出现，普通对象不占位置：

- 「还原为预制体默认值」——素材/模块/标签/属性/缩放/碰撞体按模板重置，**保留**对象自己的名字、位置、图层
- 「断开链接」——`prefabId` 置空，对象本身不做任何改动
- 模板被删后仍带 `prefabId` 的对象：显示「链接已失效」+ 一键清理

### 3. 其它入口

- **画布拖放**：把列表里的预制体直接拖进画布，落在鼠标位置
- **画布角标**：来自预制体的对象右上角一个小方块，紫色 = 链接完好，灰色 = 模板已删
- **文件菜单**：「预制体面板…」直接跳到左栏该页

---

## 三、v1 明确不做自动同步（重要）

**改了预制体不会自动改已放到场景里的对象；反之亦然。** 这是刻意的取舍，不是没做完：

- Unity 的 Prefab override 语义（哪些字段被用户覆盖过、增删模块怎么合并、嵌套预制体谁负责）远比本编辑器需要的能力复杂；
- 做一半最危险 —— 用户会按 Unity 的肌肉记忆预期「改模板就全同步」，发现没生效却不知道该点哪个按钮；
- 所以 v1 只提供两个**手动**操作（还原为默认值 / 断开链接），并在面板与 Inspector 卡片上都写明了这件事。

要同步时的工作流：改模板 → 选中目标对象 → Inspector「还原为预制体默认值」。
需要让模板跟着对象走：改好对象 → 「预制体」面板「从场景对象创建」重新抓一个。

---

## 四、数据模型

```ts
export interface PrefabDef {
  id: string;                 // 编辑器内部链接用，不导出
  name: string;               // 唯一名，运行期 bwe.prefab.spawn 的 key
  blurb?: string;             // 一行说明，不导出
  kind: GameObjectKind;
  assetId: string;            // 编辑器内部，导出时换算成素材名 asset
  z: number;
  layer?: number;             // 场景里的默认图层序号，缺省 0
  rotation: number;
  scaleX: number;
  scaleY: number;
  halfW: number;              // 0 = 不参与碰撞
  halfH: number;
  animMode: string;
  animFps: number;
  tags: string[];
  modules: ModuleInstance[];
  props: Record<string, string>;
  script: string;             // 对象脚本**名字**
  spawnJitter?: { x: number; y: number };
}
```

与 `SceneObject` 的差异只有三处，其余字段同名同义：没有 `x`/`y`（位置是放置时决定的）、
没有 `id`/`layerId`/`visible`/`locked`/`parentId`（这些只在放进场景后才有意义）、多一个 `name` 与 `blurb`。

`SceneObject.prefabId?: string | null` —— 来自哪个预制体。只用于标记与两个手动操作。

### 向后兼容

| 场景 | 行为 |
|---|---|
| 旧 `.bwproj` 没有 `prefabs` | `normalizeProject()` 补成 `[]`，打开不报错 |
| 旧对象没有 `prefabId` | 补成 `null` |
| 保存后 | `prefabs` 字段自动齐全，原有字段一个不丢 |
| `prefabs` 里有脏数据 | 逐字段兜底；非法条目跳过，重名自动加序号，重复 id 换新 id |
| `prefabId` 指向已删模板 | **保留**不清空，UI 显示「链接已失效」（用户可能只是先删模板再补回来） |

---

## 五、`boot.json` 的 `prefabs` 片段样例

字段契约与 api-spawn 的 `ScriptPrefab` 逐字对齐（他确认「这套我全部采纳，就是最终契约」）。

```json
{
  "project": "示例工程",
  "tileSize": 32,
  "masterVolume": 0.7,
  "scenes": [ ... ],
  "variables": { ... },
  "scripts": [ ... ],
  "assets": [ ... ],
  "prefabs": [
    {
      "name": "小怪",
      "kind": "ACTOR",
      "asset": "小怪",
      "z": 2,
      "layer": 2,
      "halfW": 14,
      "halfH": 14,
      "tags": ["敌人"],
      "modules": [
        {
          "def": "move.patrol",
          "when": "ALWAYS",
          "label": "",
          "params": { "speed": "40", "range": "96" }
        },
        {
          "def": "combat.health",
          "when": "ALWAYS",
          "label": "",
          "params": { "maxHealth": "30", "showBar": "开" }
        }
      ],
      "props": {},
      "script": "小怪AI",
      "animMode": "默认",
      "animFps": 8,
      "scaleX": 1,
      "scaleY": 1,
      "rotation": 0,
      "jitter": { "x": 48, "y": 16 }
    }
  ]
}
```

### 导出规则（每条都有理由）

| 规则 | 为什么 |
|---|---|
| `asset` 是**素材名**不是 assetId | 运行期 `assetByName()` 按名字找图；给 id 会静默退回色块 |
| `script` 是**脚本名**不是文件路径 | 运行期按 `scripts[].name` 查；给路径永远查不到，实例不会跑脚本 |
| `modules[].params` 值全是字符串 | Java 侧 `RtModule.params` 是 `Map<String,String>`；复用场景对象的 `moduleJson`，编码规则完全一致 |
| `jitter` 缺省输出 `{x:0,y:0}` 而不是 `null` | 运行期直接读 `.x/.y`，少一层判空 |
| `layer` 输出整数，缺省 0 | 与 `scene_*.json` 的 `objects[].layer` 同义 |
| 没有预制体也输出 `"prefabs": []` | 显式空表便于排查；Java 侧两种都认 |
| `id` / `blurb` / `assetId` / `spawnJitter` **不导出** | 编辑器专用，运行期不认 |
| 预制体里的模块也过 `moduleJson` | 否则会出现「同样的模块在场景里能用、在预制体里不能」 |
| 未使用预制体里的不支持模块 → 软告警不阻断 | 与场景对象的 `unsupportedModules` 提示同等级 |

---

## 六、验证结果

### typecheck / build

```
npm run typecheck   → 0 error
npm run build       → 成功（web/dist/studio.js）
```

### 旧工程兼容（`normalizeProject` 直接跑，不需要浏览器）

临时脚本 `.tmp_rel8/prefab-check/normalize-probe.ts`（esbuild 打 node 包）跑 `web/examples/*.bwproj` 全部 5 个：

```
俯视角JS示例.bwproj / 吸血鬼幸存者.bwproj / 扫雷示例.bwproj / 换装示例.bwproj / 涌现沙盘.bwproj
  PASS  打开不报错
  PASS  prefabs 是数组且被补齐为 []
  PASS  原有顶层字段一个都没丢
  PASS  场景名 / 对象数 / 对象 id / 模块数 / 素材数 / 脚本数 全部保留
  PASS  场景对象 prefabId 补成 null
```

外加：保存→重新打开幂等、预制体工厂/抓取/放置/还原的深拷贝隔离、脏数据容错（`null` 条目、`"不是对象"`、重复 id、重复名字、`modules` 不是数组、`props: null`）全部通过。

### 导出链路（改前/改后 diff）

先跑一次改前的 `writeBuild` 存下 `boot.json`，改后再跑，逐字段比对：

```
plain  （无预制体）：除 prefabs 外全部字段 JSON 完全相等 = true；scene_0/scene_1 逐字节一致 = true
prefab （3 个预制体）：除 prefabs 外全部字段 JSON 完全相等 = true；scene_0/scene_1 逐字节一致 = true
```

`prefabs[]` 内容断言 21 项全过：`asset` 是素材名、`script` 是脚本名、`params` 全字符串、
`jitter` 是 `{x,y}`、缺省 `jitter` 不为 null、`layer` 整数、`modules` 用 `def/when/params`、
且不含 `id`/`blurb`/`assetId`/`spawnJitter` 等编辑器专用字段。

### `verify-mapping.mjs --no-synth`（回归护栏）

```
通过 4/4 个用例，失败 0 项，警告 10 项
```

10 条警告全部是**改动前就存在**的「Build 比 .bwproj 旧 / 旧 Build 缺 layer 字段」类提示，
与本次改动无关（`web/.build/packages/` 里是历史打包产物）。

### 真实浏览器验证（CDP 驱动 headless Chrome 155）

`.tmp_rel8/prefab-check/verify-prefab-ui.mjs`：**25 / 25 通过**

```
PASS  编辑器加载
PASS  左栏有「预制体」tab
PASS  面板空状态提示
PASS  有「新建」与「从场景对象创建」按钮
PASS  示例工程已载入（有对象、无预制体）
PASS  选中一个场景对象
PASS  从场景对象抓出预制体  — n:1 name:主角 模块:3
PASS  模板坐标已归零（不含 x/y 字段）
PASS  模板带上了模块与默认 jitter
PASS  源对象被标记为来自该预制体
PASS  属性表单渲染（放置按钮 / 随机散布 / 卡片 / 输入框）
PASS  「放置到场景」新增一个对象  — 4 → 5
PASS  放下的对象带 prefabId 链接
PASS  放下的对象名字跟随模板
PASS  放下的对象被自动选中
PASS  视图中心回填生效（has=true 且非 0,0）
PASS  Inspector 显示「预制体链接」卡片
PASS  卡片有「还原为预制体默认值」与「断开链接」
PASS  卡片写明 v1 不自动同步
PASS  「还原为默认值」把标签/碰撞体恢复成模板值
PASS  还原后保留对象自身位置
PASS  「断开链接」把 prefabId 置空
PASS  断开后卡片消失
PASS  工程数据里 prefabs 是数组且已持久化
PASS  页面无未捕获异常
```

`.tmp_rel8/prefab-check/verify-roundtrip.mjs`（真实浏览器里的 setProject 往返）：**5 / 5 通过**
—— 预制体逐字段还原、原有 scenes/objects/assets/scripts/variables 全保留、`.bwproj` 文本含 `prefabs`。

`.tmp_rel8/prefab-check/verify-packpanel.mjs`（打包面板提示）：**5 / 5 通过**

```
PASS  造出含预制体的工程
PASS  打包面板打开
PASS  面板显示预制体数量提示
PASS  面板提示预制体里有不执行的模块
PASS  不执行模块列表包含 detect.collider 对应中文名
```

实际渲染出的文案（1 个预制体，里面挂了一块运行期不执行的 `detect.collider`）：

```
工程里有 1 个预制体会一起导出；其中 1 种模块运行期不执行
（预制体数据保留，生成出来的对象不会带这块行为）。
以下 2 个模块在打包运行时里不会执行（工程数据保留，不会报错）：碰撞体 · 阻挡、打开对话框
```

`.tmp_rel8/prefab-check/verify-dragdrop.mjs`（拖到画布放置）：**6 / 6 通过**

HTML5 drag&drop 没法用鼠标事件模拟，这里用真实 `DataTransfer` 合成 `DragEvent`：

```
PASS  编辑器就绪
PASS  准备干净场景 + 1 个预制体
PASS  拖进画布新增一个对象      — {"name":"拖放测试","prefabId":"pf-drop","tags":["拖放"],"z":3,"halfW":10,"selected":true}
PASS  拖放出来的对象带 prefabId
PASS  拖放出来的对象名字/标签/层级照抄模板
PASS  拖放后对象被选中
```

---

## 七、验证过程中发现并修掉的真实 bug

| 问题 | 现象 | 修法 |
|---|---|---|
| 面板首次渲染空白 | `rebuild()` 只在搜索/点击时调用，面板打开时列表与表单都是空的，得先点一下才「醒过来」 | 在 `renderPrefabPanel` 末尾补一次 `rebuild()` |
| `viewCenter()` 的哨兵不可靠 | 用 `0,0` 表示「没人监听」，与真实坐标 `0,0` 无法区分 → 放置永远落在左上角 | detail 上加 `has` 标记，编辑器监听到才置 true |
| 无模块的预制体挂不了脚本 | `scriptField` 在「模块为空」的早退分支之后，模板没模块时永远看不到脚本入口 | 早退分支里也渲染 `scriptField` |
| 重命名用了隐藏输入框 | 输入框挂在屏外，用户看不到、也没法点确定 | 改成小模态，回车提交 |

---

## 八、未做 / 已知限制（诚实清单）

1. **不做预制体自动同步**（见第三节，v1 明确定版，不是遗漏）。
2. **不能在预制体面板里直接拖模块排序或改模块参数**：模板没有「真实对象」可挂模块编辑器，
   所以模块区是只读概览 + 复制/粘贴。改参数的工作流是「放置到场景 → 选中 → M 打开模块编辑器 → 重新抓成预制体」。
   面板上写明了这条路。
3. **预制体不能嵌套**（模板里不能再引用别的模板），运行期也没有对应语义。
4. **画布拖放的落点用 `snap()`**（跟随「吸附到网格」开关）；「放置到场景」按钮也按格对齐。
   如果用户关掉吸附，按钮放置会落在视图中心原始坐标。
5. **`prefabId` 不参与导出** —— 它只是编辑器标记；运行期由 `bwe.prefab.spawn` 自己决定实例归属。
6. **预制体面板里改不了模块参数**（同第 2 条）。这是有意的：模块编辑器绑定真实 `SceneObject`，
   强行给模板造一个「假对象」会让模块编辑器的 `store.scene.objects.includes(obj)` 校验失效，
   反而更容易出现「改了没保存到模板」的静默 bug。

---

## 九、给 Lead 的对接确认

- 字段契约已与 api-spawn 双向确认（他明确回了「这套我全部采纳，就是最终契约」），含我补的 `layer`。
- 运行期启动时会把 `boot.prefabs[]` 逐个 `bwe.prefab.define()`，所以导出格式 = define 的 spec，无需转换。
- `script` 按 api-spawn 要求**原样导出脚本名**，没转成 `scripts/<base>.js`。
