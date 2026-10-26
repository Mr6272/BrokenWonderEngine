# 编辑器 → 引擎 映射契约

打包后的游戏画得对不对，只取决于这份契约。**任何一侧改了这里的行为，必须同步改另一侧，并跑一次自检。**

```
.bwproj (Web 编辑器)
   │  web/src/app/packageBwe.ts  收集素材
   │  web/tools/package-bwe.mjs  writeBuild()
   ▼
Build/boot.json + Build/scene_0.json + Build/assets/<assetId>/*
   │  Studio.runtime.GameData  读 JSON
   │  Studio.runtime.Viewport  世界 → 屏幕
   ▼
Studio.runtime.TopDownRuntime  JOGL 固定管线绘制
```

> 桌面 Swing 编辑器的「试玩」走 `Studio.runtime.GameLauncher.exportForPlay()`，
> 写的是同一套 `Build/boot.json` 格式，所以两边必须遵守同一份契约。

## 1. 世界坐标

| 项目 | 约定 | 真值来源 |
|------|------|----------|
| 轴向 | X 向右，Y **向下** | `web/src/app/painter.ts` 文件头 |
| 单位 | 1 单位 = 1 像素（**不是**格、不是米） | 同上 |
| 对象位置 `(x, y)` | **中心点**，不是左上角 | `painter.ts#boundsOf`：`x - w/2` |
| `rotation` | 度，屏幕上**顺时针** | `painter.ts#paintObject` 的 `g.rotate(+deg)` |
| 场景矩形 | `[0, widthTiles*tileSize] × [0, heightTiles*tileSize]` | `painter.ts#paintGrid` |

## 2. 对象尺寸（最容易错的一条）

排序严格按优先级命中，命中即返回（`painter.ts#sizeOf`）：

| 优先级 | 条件 | 宽 / 高 | 是否乘 `scaleX/scaleY` |
|--------|------|---------|------------------------|
| 1 | `halfW > 0 或 halfH > 0` | 各自独立取 `half*2`，缺的一边取 **16**，最小 **4** | **不乘** |
| 2 | `props.w > 0 且 props.h > 0` | `props.w` / `props.h` | 乘 |
| 3 | 素材有像素尺寸 | 素材像素（`ATLAS` 用 `cellW/cellH`） | 乘 |
| 4 | 兜底 | `tileSize` | 乘 |

`scaleX/scaleY == 0` 时按 1 处理（两侧一致的容错）。

## 3. 视图与视口

唯一公式（`Studio.runtime.Viewport`）：

```
screen = (world - cam) * zoom + view / 2         // cam = 视口中心对准的世界坐标
world  = (screen - view / 2) / zoom + cam        // 鼠标点击必须走这条反变换
```

视图策略（默认**全屏 + 留边 contain**：整张地图都看得见，不会裁掉任何内容，可能左右/上下留底色）：

| 场景 | 行为 |
|------|------|
| 默认 `contain`（留边） | `zoom = clamp(min(viewW/mapW, viewH/mapH), 0.15, 4)`，整张地图可见、居中，可能留边 |
| 按 `F` 切 `cover`（铺满） | `zoom = clamp(max(viewW/mapW, viewH/mapH), 0.15, 4)`，等比铺满视口，超出部分裁掉、无黑边 |
| 玩家挂了 `fx.cameraFollow` / `show.camera` **且**地图比视口大 | `zoom = 1`（1:1 像素），相机跟随玩家；`clampToMap` 决定是否钳制在地图内 |
| 窗口缩放 / 全屏切换 | 必须重算 zoom 与相机钳制（`reshape` 里做） |

> `MAX_ZOOM` 运行时是 **4**（编辑器视口是 2）：4:3 的地图放进 16:9/16:10 全屏要 2.2~2.7 倍
> 才铺满，钳到 2 就必然留边。

### 3.1 高 DPI：逻辑尺寸 vs 物理尺寸（这条错了就「画面不满 + 点击偏移」）

Windows 显示缩放 125%/150% 时，同一个窗口有两套尺寸，**JOGL 2.1 是 HiDPI 无感知的**：

| 量 | 来源 | 实测（1707×1067 @150%） |
|----|------|------------------------|
| 逻辑尺寸 | `canvas.getWidth()/getHeight()`、`MouseEvent.getX/Y`、`GraphicsConfiguration.getDefaultTransform()` | 1707×1067，scale=1.5 |
| 物理尺寸 | GL framebuffer 真实像素（`BWE_FBPROBE=1` 时 dump `Build/fb-frame.png` 可量） | **2560×1600** |
| `reshape` 报告的尺寸 | JOGL 组件尺寸（**逻辑**，不是 framebuffer） | 1707×1067 |

所以必须这样分工（`TopDownRuntime.updateSurfaceSize`）：

- `glOrtho` / fit / 相机 / 鼠标反变换 → **逻辑尺寸**（和 `MouseEvent` 同一坐标系）
- `glViewport` → **物理尺寸** = `floor(逻辑 × getDefaultTransform().scale)`

> 历史 bug：两边都用 JOGL 报的 1707×1067 → `glViewport` 只覆盖 framebuffer 左下 2/3，
> 于是「画面只占一块」+ 鼠标整体偏移。验证方法见 §8 的 `BWE_FBPROBE`。

### 3.2 快捷键

| 键 | 行为 |
|----|------|
| `F11` | 全屏 ↔ 无边框窗口（不 dispose 重建，GL 上下文与纹理不丢） |
| `F` | 铺满 `cover` ↔ 留边 `contain` |
| `R` | 重新开始小游戏（扫雷/换装重置） |
| `ESC` | 全屏时先退全屏，再按退出 |
| `WASD` / 方向键 | 玩家移动（挂 `move.*` 模块时） |

## 4. 绘制顺序

与编辑器 `web/src/app/canvas.ts#orderObjects` 一致：

```
图层下标 → z → y
```

- 图层下标由导出器写进每个对象的 `layer` 字段（`scene.layers` 里的下标）。
- 缺失时按 0 处理（向后兼容旧 Build）。
- 点击命中测试用**相反**顺序（从最上层往下找）。

## 5. 可见性

导出时对象 `visible = object.visible && layer.visible`；
运行时只认这个合成结果，不再自己判图层。

## 6. 动画

`animMode` 是编辑器里的中文枚举（`web/src/panels/inspector.ts`）：

| 值 | 运行行为 |
|----|----------|
| `默认` | 循环播放，`fps = animFps` |
| `只显示首帧` | 永远第 1 帧 |
| `单次播放` | 播到最后一帧停住 |

`ATLAS` 按 `cols × rows` 切 UV；`SEQUENCE` 按 `path/frameN.png` 逐帧读。

## 7. 模块 id 兼容

Web 编辑器用新 id，桌面模块用旧 id，运行时要两个都认（`GameData.module(a, b)`）：

| Web (.bwproj) | 桌面 (Swing) |
|---------------|--------------|
| `combat.health` | `fight.hp` |
| `fx.cameraFollow` | `show.camera` |
| `render.shadow` | `look.shadow` |
| `render.blink` | `look.blink` |
| `render.sortByY` | `look.sortByY` |
| `render.playOnce` | `look.playOnce` |

运行时**真正会执行**的模块清单见 `web/src/app/packageBwe.ts#RUNTIME_MODULES`；
不在清单里的模块只会被忽略，不会崩，但打包界面会提示用户。

## 8. 映射自检（改完映射必须跑）

```powershell
# 一条命令跑完：编译运行时 + esbuild 打 painter.ts 真代码 + LayoutDump + 逐项对拍
node web/tools/verify-mapping.mjs
# 指定某个用例的 Build 目录（默认自动找 web/.build/packages/*/out/<工程名>/app/Build）
node web/tools/verify-mapping.mjs --build 换装示例=.tmp_rel8/e2e-dressup/out/E2E-Dressup/app/Build
# 只跑现场工程，不跑合成用例
node web/tools/verify-mapping.mjs --no-synth
```

它断言的内容：每个对象的 `world w/h/left/top` 与编辑器 `painter.sizeOf` 完全一致（0.01 容差）、
`screen = (world-cam)*zoom + view/2` 复算一致、`zoom`（按 `fitMode` 用 min/max 公式，钳 0.15..4）、
尺寸四级优先级（含小数与 scale=0）、`rotation` 与 `edgeScreen`（顺时针）、导出元数据与 Build 新鲜度。

单独看布局也可以（不建窗口）：

```powershell
javac --release 8 -encoding UTF-8 -cp "lib/*" -d .tmp\classes `
  (Get-ChildItem src\Studio\runtime\*.java | Where-Object { $_.Name -ne 'GameLauncher.java' })
java -cp ".tmp\classes;lib/*" Studio.runtime.LayoutDump --boot Build\boot.json --view 1280x720 `
  --fit cover --out layout.json
```

`LayoutDump` 和渲染用的是同一份 `Viewport` / `sizeOf`，所以报告里的数字就是玩家看到的数字。

### 8.1 高 DPI 现场取证（画面不满屏 / 点击偏移时先跑这个）

```powershell
# 跑一次，会把第一帧的 framebuffer 原始像素存成 Build/fb-frame.png
$env:BWE_FBPROBE='1'; .\你的游戏.exe
# 然后量：内容像素占比应为 1.000（铺满）；若只有左下角一块，就是逻辑/物理尺寸又用混了
```

`bwe.log` 里同时会写：`尺寸自检:`（逻辑/物理/屏幕/scale）、`视口映射:`、`点击诊断:`（组件坐标 → 世界坐标），
用户把 `Build/bwe.log` 发回来就能直接定位。

## 9. 踩坑记录（都是真发生过的）

| 坑 | 症状 | 正确做法 |
|----|------|----------|
| 相机只 `glTranslatef(-cam)`，没补 `view/2` | 地图一大就「整体偏移、只看到一角」 | 统一走 `Viewport.applyGL` |
| 把 JOGL 报的尺寸同时当逻辑和物理用 | 高 DPI 下「画面只占左下 2/3」+「点击整体偏移」 | `glViewport` 用物理（逻辑×scale）、`glOrtho`/鼠标用逻辑，见 §3.1 |
| 窗口开 1280x720 不是全屏 | 打包出来「没占满屏」 | 默认 `setFullScreenWindow`，F11 切无边框窗口 |
| fit 上限照抄编辑器的 2 | 全屏下 4:3 地图铺不满 | 运行时 `MAX_ZOOM = 4` |
| 全屏切换用 dispose 重建窗口 | GL 上下文/纹理丢失，切一次就黑图 | 全程 undecorated，只 `setFullScreenWindow`/`setBounds` |
| `glRotatef(-rotation)` | 旋转过的对象与编辑器镜像 | **正号**；因为 `glOrtho(0,w,h,0)` 的 y 反射与窗口 y 翻转抵消，`screen_y = y_eye` |
| `GameData` 里 `num(o,"x",0)`（int 字面量） | 编辑器里的小数坐标/半宽/缩放被打包截断，位置差半截、大小比例错 | 浮点字段的默认值必须写 `0f/1f/8f`，否则命中 `num(...,int)` 重载走 `getAsInt()` |
| 导出时丢掉图层信息 | 跨图层遮挡关系错乱（地形压住角色） | 每个对象导出 `layer`（`scene.layers` 下标），运行时按 `layer → z → y` |
| `halfW` 分支里又乘了一次 `scale` | 设了碰撞体的对象大小翻倍 | `halfW/halfH` 分支**不乘** scale（编辑器就是这样） |
| data URL 正则 `(;base64)?` 太死 | `data:image/svg+xml;charset=utf-8,...` 解析失败被**静默丢弃**，整包没图 | 按 `data:<meta>,<payload>` 解析，失败要进 warnings |

## 10. 已知未实现

- 多场景：运行时只加载 `scenes[0]`，场景跳转（`fx.loadScene`）尚未接线。
- 序列帧的 `hiddenFrames` / `frameDurations` 不导出（导出器只写全部帧、统一 fps）。
- 音效 / BGM、脚本（Yarn）、气泡对白：数据保留，运行时未执行。
- `parentId` 父子层级：导出保留，运行时按扁平坐标处理。
