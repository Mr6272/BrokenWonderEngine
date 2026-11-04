# BWE 2D 光照系统 · 权威契约（Lead 维护，所有实现方必须逐字遵守）

> 仓库根：`D:/githubdesktop/BrokenWonderEngine`。
> 本文件是**唯一事实来源**：编辑器烘焙（TS）、运行时（Java）、脚本 API、文档/类型四方都按它实现。
> 任何一方想改公式、字段名、API 名，先改本文件，再同步四处。

## 0. 硬约束（先读，踩过坑）

1. **渲染是 JOGL 2.1 固定管线**，没有着色器。只能 `glBegin/glEnd` + 纹理 + 混合。
2. **Android 的 `GL2Compat` 只认三种混合因子**（`GL_SRC_ALPHA` / `GL_ONE` / `GL_ONE_MINUS_SRC_ALPHA`），
   `mapBlend` 其它值一律退化成 `GL_SRC_ALPHA`。所以**禁止** `GL_ZERO`、`GL_SRC_COLOR`、
   `GL_DST_COLOR` 这类乘法混合。本项目的光照因此**只用两种混合**：
   - 压暗：`glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)` + 纯黑 quad（alpha=`darkness`）
   - 加光：`glBlendFunc(GL_SRC_ALPHA, GL_ONE)` + 光照贴图（alpha=1，见 §2）
3. **Java 8 兼容**（打包链路 `javac --release 8`）：不能用 `var` / `List.of` / `String.isBlank` 等 Java 9+ API。
4. **游戏脚本是 Rhino 1.7.15 / ES5**：`var` + `function`，禁止 `let/const/箭头函数/模板字符串`。
5. **旧工程零回归**：`scene.lighting` 缺失 ⇒ 光照系统整体不启用，画面与今天**逐像素一致**。
6. 禁止 `git reset/checkout/revert`；仓库里有别人的未提交改动。
7. 纹理必须能承受 GL 上下文重建（`rebuildGpuResources()` 之后 id 失效）：光照贴图要能被重建。

## 1. 世界与像素约定

- 世界坐标单位 = 世界像素，X 向右、Y 向下；对象 `(x,y)` 是**中心点**（与 `Viewport`/`painter.ts` 一致）。
- 场景矩形 = `[0,0, W,H] ×`，其中 `W = scene.widthTiles * tileSize`，`H = scene.heightTiles * tileSize`。
- 光照贴图覆盖**整张场景矩形**（不是视口）。烘焙产物是一张从 `(0,0)` 到 `(W,H)` 的贴图。

## 2. 光照贴图（Lightmap）的数学定义 —— 编辑器烘焙与运行时动态共用同一套

### 2.1 采样网格

- `texelsPerPixel`（下文 `s`，默认 `0.25`）：1 世界像素 = `s` 个纹素；1 纹素 = `1/s` 世界像素。
- 贴图尺寸：`texW = clamp(round(W*s), 1, 2048)`，`texH = clamp(round(H*s), 1, 2048)`。
  若 `round(W*s) > 2048` 或 `round(H*s) > 2048`，**整张贴图按同一比例缩小**（保持长边 ≤ 2048），
  实际比例记为 `sEff = min(texW/W, texH/H)`，写进数据里（运行时按 `sEff` 反推，不重算）。
- 纹素 `(i,j)`（0-based，j 向下）的**世界中心坐标**：
  `x = (i + 0.5) / sEff`，`y = (j + 0.5) / sEff`。

### 2.2 环境光（每像素基底）

`ambient = ambientColor * ambientIntensity`（各通道 0..1，不做 clamp，最后一起 clamp）。
- `ambientColor` 缺省 `#3A4A6B`，`ambientIntensity` 缺省 `0.35`（0..1）。

### 2.3 光源贡献（逐光源叠加）

对每个纹素、每个**启用**的光源：

1. `dx = px - lx`，`dy = py - ly`，`d = sqrt(dx*dx + dy*dy)`。
2. `t = d / radius`；`t >= 1` ⇒ 贡献 0。`radius <= 0` ⇒ 跳过。
3. 距离衰减：`atten = (1 - t) ^ falloff`（`falloff` 缺省 `2`，允许 1..4）。
4. 聚光（`type == "spot"`）：
   - `dirRad = radians(dir)`（`dir` 单位度，0 = +x，90 = +y 即向下，顺时针）。
   - `angRad = atan2(dy, dx)`；`diff = |normalizeToPi(angRad - dirRad)|`（取 [-π,π]）。
   - `halfRad = radians(angle) / 2`；`angle` 缺省 `60` 度。
   - `diff > halfRad` ⇒ 贡献 0。
   - 锥边软化：`coneSoftDeg` 缺省 `10`；若 `diff > halfRad - coneSoftRad`，
     乘 `(halfRad - diff) / coneSoftRad`（clamp 0..1）。
5. 阴影：若 `shadow == true` 且**线段 `(lx,ly) → (px,py)` 与任一遮挡体 AABB 相交**（见 §2.4），贡献 0。
   - 相交判定用 slab/ray-AABB，交点参数 `t ∈ (0,1)` 才算相交（贴着边缘不算）。
   - 允许**性能裁剪**（不得改变结果）：先用线段包围盒与 AABB 的 AABB 相交做粗筛，再逐条 slab。
     先按光源半径筛掉必定不相交的遮挡体（AABB 到光源距离 > radius 的）也是精确裁剪。
6. 颜色与强度：`contrib = lightColor * intensity * atten * coneFactor`（`intensity` 缺省 `1`，0..4）。
   - `intensity <= 0` ⇒ 整盏跳过（不要参与累加，避免 -0 之类的差异）。
7. 闪烁（`flicker > 0`）：`scale = 1 + flicker * sin(2π * (timeSec * 1.7 + phase))`，
   `phase = hash01(lightId)`（见 §2.7）。**烘焙时**：`flicker` 光源按 `flicker = 0` 计算
   （烘焙图是静态底图，抖动交给运行时动态层）。`lightDynamic="1"` 的光源**完全不进烘焙**
   （连环境光叠加都不做），由运行时动态算。

**累加顺序（必须一致，影响浮点尾数）**：`acc = ambient`；然后**按 lights 数组下标顺序**逐盏累加；
同一盏的 r/g/b 三个通道独立累加。允许按「逐光源遍历纹素」实现（性能），只要对每个纹素而言
累加顺序仍是那个下标顺序。

累加：`accR/G/B = ambient + Σ contrib`，最后每通道 `clamp(0,1)`。

### 2.4 遮挡体（Occluder）

一个对象是遮挡体，当且仅当：

- `props.lightBlock == "0"` ⇒ **永不遮挡**（显式关闭优先）；
- 否则 `props.lightBlock == "1"` ⇒ 遮挡；
- 否则：`tags` 含 `"wall"` 或 `"occluder"` 或 `"lightblock"` ⇒ 遮挡；
- 否则不遮挡。

**遮挡体 AABB 尺寸（唯一规则，不许各自实现第二份）**：

```
hw = drawWidth(obj)  / 2
hh = drawHeight(obj) / 2
```

`drawWidth/drawHeight` 就是**引擎/编辑器实际绘制这个对象的宽高**：

- 运行时 = `TopDownRuntime.drawWidth/drawHeight`（包内可见，已含尺寸缓存）；
- 编辑器 = `painter.sizeOf(obj, project)`。

**为什么必须这样，不能自己写一套优先级链**：曾经契约写的是「`halfW/halfH` > `props.w/h` > 素材像素 > tileSize，最后统一再乘 `scaleX/scaleY`」。
这条公式与 `sizeOf` 的真实行为**不一致**：`sizeOf` 的 `halfW>0` 分支**不乘 scale**
（`return max(4, halfW*2)`），其余三个分支乘 scale。
于是同一个对象（`halfW=30, scaleX=2`）：

| 实现 | 画出来的宽度 | 算出的遮挡半宽 | 结果 |
|---|---|---|---|
| `sizeOf` / 真实渲染 | 60 | — | 玩家看到 60px 宽的墙 |
| 按「统一乘 scale」 | 60 | **60** | 阴影按 **120px** 宽的墙算 ⇒ 阴影是实物的 2 倍 |
| 按 `sizeOf/2`（**本契约**） | 60 | **30** | 阴影与实物严丝合缝 |

**结论**：遮挡体尺寸一律取「实际绘制尺寸的一半」。这样「画布上看到多大的墙，就挡多大的光」——
再也不会出现"阴影框比物体大一倍"这种只有对着像素才能发现的错。各实现**禁止**再写自己的尺寸优先级链。

> 实现提示（Java）：直接调 `host.drawWidth(a) / 2`、`host.drawHeight(a) / 2`。
> 不要复制 `sizeOf` 的分支逻辑 —— 复制出来的第二份迟早与第一份漂移。


### 2.5 柔化（penumbra）

对**整张累加结果**做 2 遍方框模糊，半径
`r = max(0, round(softness * sEff))`，`softness` 缺省 `16` 世界像素（0..128）。
方框模糊边界按当前半径内有效像素数归一（不做边缘外推）。

**允许的两种等价写法**（方框模糊对常数是恒等，所以结果相同，各实现任选其一）：
- (a) 先算 `ambient + Σ contrib` 再整体模糊；
- (b) 只模糊 `Σ contrib`，再叠加**未模糊**的 `ambient`。

两者在图的内部完全等价；在**边界**上会有微弱差异（边界归一的作用对象不同），
能量守恒都成立。**不要求跨端逐像素一致**，但每端内部必须自洽。
（柔化的正确性用性质断言验证：内部能量守恒 ±1%、峰值必须下降、半径 0 恒等。
不要试图用 fixture 钉模糊的逐像素值 —— fixture 的 `softness` 一律为 0，正是为此。）

### 2.6 输出格式

- 烘焙产物是一张 **不透明 PNG**：`RGB = round(clamp01(acc) * 255)`，`A = 255`。
- 运行时"加光"绘制用 `glBlendFunc(GL_SRC_ALPHA, GL_ONE)`：`scene + RGB * (A/255)`。
  所以 `A=255` ⇒ 直接加 `RGB`；没有光的纹素 `RGB=(0,0,0)` ⇒ 加 0（完全无副作用）。

### 2.7 确定性

- 全程 `float/double` 同一公式，**不得**使用平台相关随机。
- `hash01(id)`：对字符串逐 **UTF-16 code unit**（等同 JS 的 `charCodeAt`）算
  `h = (h*31 + codeUnit) >>> 0`（32 位无符号回绕），取 `(h >>> 0) % 100000 / 100000.0`。
  **必须与 JS `charCodeAt` 一致**，否则同一盏灯的闪烁相位在编辑器预览与游戏里会不同步；
  中文灯名也必须对齐（不要用 UTF-8 字节或 UTF-32 code point）。
- 同一输入必须得到逐像素相同输出（TS 与 Java 各自内部确定性即可）。

## 3. 场景数据格式（`.bwproj` ↔ `scene_*.json`）

### 3.1 `SceneModel.lighting`（编辑器）→ `scene_*.json` 顶层 `lighting`

```ts
interface LightingModel {
  enabled: boolean;          // 缺省 false。false ⇒ 运行时光照完全不启用
  mode: "baked" | "dynamic" | "both";   // 缺省 "both"
  ambientColor: string;      // "#3A4A6B"
  ambientIntensity: number;  // 0..1，缺省 0.35
  darkness: number;          // 0..1，缺省 0.35。压暗程度（0 = 白天，不压暗）
  softness: number;          // 世界像素，缺省 16
  texelsPerPixel: number;    // 缺省 0.25
  dynamicFps: number;        // 运行时动态光照重算上限帧率，缺省 15
  maxDynamicLights: number;  // 运行时动态光源上限，缺省 8
}
```

`mode` 的**可用性规则**（各实现统一）：`mode` 只描述用户想用哪一层，**不代表那一层真的存在**。
- `baked` 但没有可解析的烘焙图 ⇒ 只能用环境光（这是用户的明确选择，不要偷偷改成动态）；
- `both` 但没有烘焙图 ⇒ 动态层承担**环境光 + 全部灯**（保证环境光恰好算一次，且灯不会凭空消失）。
- 旧工程（`lighting` 缺失）：`bwe.light.mode()` 返回缺省 `both`（**配置缺省值，不代表光照已启用**）；
  判断是否真的生效一律看 `bwe.light.enabled()` / `stats().enabled`。

Java 侧 `GameData.RtLighting` 字段名一一对应（`enabled/mode/ambientColor/ambientIntensity/darkness/softness/texelsPerPixel/dynamicFps/maxDynamicLights`）。
**`lighting` 缺失 ⇒ `enabled=false`，零行为变化。**

### 3.2 `SceneModel.lightmap`（编辑器）→ `scene_*.json` 顶层 `lightmap`

```ts
interface LightmapRef {
  assetId: string;      // 工程 assets[] 里的 IMAGE 素材 id（烘焙产物）
  x: number; y: number; // 覆盖矩形左上角世界坐标（固定 0,0）
  w: number; h: number; // 覆盖矩形宽高（世界像素 = 场景矩形）
  texW: number; texH: number;   // 实际纹素尺寸
  texelsPerPixel: number;       // 实际 sEff
  lights: number;               // 参与烘焙的光源数
  bakedAt: string;              // ISO 时间戳
  version: number;              // 烘焙算法版本 = 1
}
```

Java 侧 `GameData.RtLightmap`：`assetId/x/y/w/h/texW/texH/texelsPerPixel/lights/version`。
`lightmap` 缺失 ⇒ 没有烘焙图（`mode=baked` 时只有环境光）。

### 3.3 光源与遮挡体写在**对象**上（已有对象模型，零新字段）

`LIGHT` 类型对象，或**任意**带 `look.light` / `render.light` 模块的对象，或 `props.lightRadius > 0` 的对象 = 光源。

props 键（编辑器写入，脚本 `e.setProp` 也能改；运行时与烘焙都读）：

| prop | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `lightRadius` | num px | `140`（模块 `radius` 优先） | 照亮半径 |
| `lightColor` | `#rrggbb` | `#FFC978` | 光色 |
| `lightIntensity` | num 0..4 | `1`（模块 `strength`/`intensity`） | 强度 |
| `lightType` | `"point"`\|`"spot"` | `point` | 点光 / 聚光 |
| `lightAngle` | deg | `60` | 聚光锥总角度（仅 spot） |
| `lightDir` | deg | 对象 `rotation` | 聚光方向（0=+x，90=向下） |
| `lightConeSoft` | deg | `10` | 锥边软化角 |
| `lightFalloff` | num 1..4 | `2` | 衰减指数 |
| `lightShadow` | `"0"`/`"1"` | `"1"` | 是否被遮挡体挡光 |
| `lightFlicker` | num 0..1 | `0` | 闪烁幅度 |
| `lightDynamic` | `"0"`/`"1"` | `"0"` | 1 = 不进烘焙，运行时动态算（移动/跟随实体的光必须为 1） |
| `lightBlock` | `"0"`/`"1"` | — | 遮挡体标记（见 §2.4） |
| `color` | `#rrggbb` | — | 若缺 `lightColor`，光源颜色回退到它（旧 `look.light` 模块的 `color` 也如此） |

模块参数映射（模块存在时**优先于 props**）：
- `look.light` / `render.light`：`radius`→`lightRadius`，`color`→`lightColor`，
  `strength`/`intensity`→`lightIntensity`，`flicker`（bool）→`lightFlicker = 0.25`。
- **`render.light` 是 Web 编辑器 id，`look.light` 是桌面旧 id**，两个都要认（见 `ScriptApi.MODULE_ALIASES`）。

## 4. JS 脚本 API `bwe.light`（10 个成员，名字逐字固定）

```
bwe.light.enabled(flag?) -> boolean            读/写总开关
bwe.light.ambient(color?, intensity?) -> { color, intensity }   读/写环境光
bwe.light.darkness(v?) -> number               读/写压暗程度 0..1
bwe.light.mode(m?) -> string                   "baked" | "dynamic" | "both"
bwe.light.attach(e, opts?) -> boolean          把一盏光挂到实体上（跟随实体位置，自动 dynamic）
bwe.light.detach(e) -> boolean                 移除实体上的光
bwe.light.set(e, opts) -> boolean              改实体光的参数
bwe.light.add(opts) -> handle                  在世界坐标处加一盏独立光（返回 handle，数字 id）
bwe.light.remove(handle) -> boolean             删独立光
bwe.light.list() -> Array<{ id, x, y, radius, color, intensity, type, dynamic }>
bwe.light.stats() -> { enabled, mode, lights, baked, dynamic, rebuilds, lastMs, texW, texH }
bwe.light.rebuild() -> boolean                 立刻重建动态光照贴图
```

- `opts` 对象字段 = 与 §3.3 同名的驼峰短名：`{ radius, color, intensity, type, angle, dir, coneSoft, falloff, shadow, flicker, dynamic }`。
- **`add()` 的 `dynamic` 缺省是 `true`**（与 §3.3 场景 props 的 `lightDynamic` 缺省 `0` **不同**，这是刻意的）：
  脚本临时光不在烘焙 PNG 里，若 `dynamic=false` 且场景有烘焙图，它会烘焙里没有、动态也不算 ⇒ **静默看不见**。
- `attach()` **强制** `dynamic=true`（跟随实体的光进静态烘焙图毫无意义，烘焙时它在一个空位置）。
- `detach()` 必须把 `attach` 前那批 props **精确还原**（原本不存在的键删掉、原本有值的写回）；
  不许塞任何私有标记（§3.3「零新字段」）。
- `bwe.light` 与 `bwe.draw` 的区别：`bwe.draw` 是立即模式 HUD/调试；`bwe.light` 影响**世界光照层**。
- 语义：`enabled(false)` 后光照层完全不画（= 白天）。`attach` 后光源位置每帧取实体 `(x,y)`。
- 缺省值/范围与 §3.3 完全一致；非法输入不抛异常，返回 `false`/当前值（Rhino 里异常会打断脚本）。

## 5. 编辑器侧（web/src）

- 新增 `web/src/app/lightMath.ts`：**纯函数**（不碰 DOM/canvas），实现 §2 全部数学：
  `bakeLightmap(input) -> { texW, texH, sEff, rgba: Uint8ClampedArray }`。
  输入 = 光源数组 + 遮挡体数组 + ambient + 参数；`samples` 用于自检。
- 新增 `web/src/app/lightBake.ts`：把 `rgba` 写成 PNG（用离屏 canvas 的 `putImageData` + `toBlob`），
  注册成工程素材（`addRasterAsset`，见下），回写 `scene.lightmap`，返回统计。
- `web/src/data/assets.ts` 新增导出 `addRasterAsset(project, { name, blob, width, height, group })`
  —— 与 `importFiles` 同一套 IDB 存储格式（`frames: [File/Blob]`、`src:"blob"`），保证打包链路零改动可用。
- 新增 `web/src/panels/lightingPanel.ts`：光照总览面板（总开关 / 模式 / 环境光色+强度 / 压暗 /
  柔化 / 采样率 / **一键烘焙** 按钮 + 结果统计 + 警告）+ 光源清单（点选定位、逐光源参数。
- `web/src/panels/inspector.ts`：`LIGHT` 对象专属卡片（写 §3.3 的 props；含"烘焙时排除（动态）"开关、
  "遮挡体 lightBlock" 三态）。
- `web/src/app/painter.ts`：编辑态**近似预览**（压暗 + 各光源径向渐变叠加），只在
  `pctx.showLighting` 为真且 `scene.lighting?.enabled` 时画；不得影响无光照工程的渲染。
- `web/src/app/editor.ts`：挂面板 + 「光照/一键烘焙」入口（命令面板项也要有）。
- `web/src/ui/terms.ts`：`LIGHT` 的 hint 更新为"照亮周围一圈（2D 光照系统）"。
- `web/src/data/modules.ts`：`render.light` 模块补参数说明（与 §3.3 对齐，不新增字段名）。

## 6. 运行时侧（src/Studio/runtime）

- 新增 `LightMap.java`：**纯 CPU**（无 GL），实现 §2。供 `Lighting` 与自检使用。
  必须提供：`static float[] bakeFloat(...)`（长度 `texW*texH*3`）与 `static BufferedImage toImage(float[] rgb, int texW, int texH)`。
- 新增 `Lighting.java`：
  - 读 `scene.lighting` / `scene.lightmap`；收集场景光源与遮挡体（`Actor`）与脚本光源；
  - `mode=baked|both`：载入烘焙 PNG 纹理，一次性上传（`GL_LINEAR` + `GL_CLAMP_TO_EDGE`）；
  - `mode=dynamic|both`：以 `1/dynamicFps` 节流、`maxDynamicLights` 为上限重建动态贴图
    （有变化才重建：光源位置/参数变、`darkness` 变、脚本调用 `rebuild()`）；
  - 渲染顺序（在 `renderFrame` 里）：`drawMap` → `drawActors` → **`lighting.draw(gl)`** → `drawUiScenes` → 脚本 draw → 摇杆。
    内部顺序：先压暗 quad（世界矩形 or 屏幕矩形，`GL_SRC_ALPHA/GL_ONE_MINUS_SRC_ALPHA`），
    再加光 quad（`GL_SRC_ALPHA/GL_ONE`，贴图普通 `GL_MODULATE`）。
  - `rebuildGpuResources()` 时丢弃贴图 id 并重新上传。
  - 统计字段 `debugLightQuads` / `debugLightRebuilds` / `lastRebuildMs`，供自检断言；
    无 GL（`gl==null`）时整体跳过、绝不抛异常。
- `GameData.java`：解析 `lighting` / `lightmap`（缺省 = null，零行为变化）。
- `TopDownRuntime.java`：只在三处加钩子（构造后建 `Lighting`、`renderFrame` 插入绘制、
  `rebuildGpuResources` 里让光照资源重建），**不改动任何既有绘制/排序逻辑**。
- `ScriptLight.java`：注册 §4 的 `bwe.light`（`api.attach("light", ns)` + `api.addMethod(ns, ...)`，
  getter/setter 用 `addGetter/addSetter` 或方法形式，二者取其一并保持一致）。
- `ScriptApi.java`：`buildOpenWorld()` 里加 `installSafely("light", ...)`，
  并在 `MODULE_ALIASES` 里补 `{"render.light","look.light"}`。

## 7. 自检与验收（每条都必须真实跑过）

1. `src/Studio/runtime/LightMapTest.java`：纯 CPU 数学自检（无 GL，可在任何机器跑）：
   - 环境光/距离衰减/半径边界/聚光锥/遮挡阴影/柔化/采样率缩放/确定性；
   - **与 `test/fixtures/lighting-case.json` 的 `samples` 逐点比对**（容差每通道 ≤ 2/255）：
     该 fixture 的 `samples` 由 Lead 用契约公式独立算出，Java 与 TS 各自实现都必须对上。
2. `src/Studio/runtime/ScriptLightTest.java`：`bwe.light` 12 个成员的**存在性 + 行为**断言
   （含"非法参数不抛异常"、`attach/detach` 后 `list()` 数量、`enabled(false)` 后 `stats()`）。
3. `web/tools/ui-checks/verify-lighting.ts`（esbuild + node 跑）：`lightMath.bakeLightmap`
   对同一 fixture 逐点比对；烘焙尺寸/缩放/`hash01` 确定性；`lighting` 缺失时输出全 0 加光。
4. `src/Studio/runtime/LightRenderTest.java`（离屏 GL 像素断言，可选 GPU）：
   同一场景 `enabled=false` vs `enabled=true` 两帧截图，断言"灯下像素更亮（加光）"、
   "远处角落更暗（压暗）"、遮挡体背后不亮；无 GPU 时 SKIP 不算失败。
5. `npm run typecheck` / `node web/tools/check-java8.mjs` / `node web/tools/verify-apidocs.mjs --strict`
   / `node web/tools/verify-openworld.mjs` / `node web/tools/verify-roundtrip.mjs`
   全部通过（apidocs 要求 bwe.light 在 Java / d.ts / apiDocs.ts / docs/api 四方齐全且无编造）。
6. `powershell -NoProfile -File tools/bwe.ps1 build`（JDK 25）编译通过。

## 8. Fixture `test/fixtures/lighting-case.json` 格式

```json
{
  "version": 1,
  "width": 256, "height": 192,
  "texelsPerPixel": 0.5,
  "softness": 0,
  "ambient": { "color": "#3A4A6B", "intensity": 0.35 },
  "lights": [
    { "id": "L1", "x": 64, "y": 64, "radius": 100, "color": "#FFC978",
      "intensity": 1, "type": "point", "falloff": 2, "shadow": false }
  ],
  "occluders": [ { "x": 96, "y": 96, "hw": 8, "hh": 32 } ],
  "samples": [ { "i": 10, "j": 10, "expect": [r, g, b] } ]
}
```

- `softness: 0` 让两侧实现不必对齐模糊实现的细节差异（模糊另有单独断言）。
- `samples[].expect` 是 0..255 整数 RGB（`A=255` 恒定）。
