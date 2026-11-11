# BWE 引擎运行时光栅截图（真实离屏 GL 渲染）

本目录里的 PNG 全部由**真实引擎**渲染：`.bwproj` → `writeQuickBuild` 导出 `Build/boot.json`
→ JDK 25 跑 `Studio.runtime.OffscreenFrameDump`（`GLOffscreenAutoDrawable` FBO，不弹窗），
推进 45 帧后 `glReadPixels` 存盘。不是 UI 截图、不是设计稿、不是历史旧图。

渲染时间：2026-11-11 · 引擎代码即当前工作区 HEAD · 生成脚本 `.tmp_readme_shot/render-all.mjs`

## 判定标准（怎么排除「黑屏 / 纯色 / 假图」）

每张图按三类硬指标判定（前三项，全过才算「有内容」），另外两列只做交叉记录不做门槛：

| 指标 | 含义 | 阈值 |
|---|---|---|
| 颜色数 | 全图 distinct RGBA 值的个数 | > 2 |
| 非背景占比 | 与 (0,0) 像素值不同的像素比例 | ≥ 1% |
| 最大亮度 | 全图最大相对亮度（排除「有颜色但整片漆黑」） | ≥ 8 |
| 边缘密度 | FIND_EDGES 后 > 24 的像素占比（证明有形状而非渐变噪声） | 记录，> 0.01 |
| 动画对照 | 同工程再渲 3 帧版，与 45 帧版逐像素比对 | 记录，仅对有固定种子的工程当证据 |
| 重复渲染 | 同一 boot.json 连渲两次比对 md5 | 记录，用来筛掉「每次都不一样」的工程 |

`frameErrors=0` 是引擎侧自报（`OffscreenFrameDump` 里 GL 回调抛异常会计数）；
`glBeginsPerFrame` / `drawCallsPerFrame` / `textureBindsTotal` 来自引擎的绘制计数器，
可以交叉验证「这一帧真的提交了 draw call」，而不只是把 framebuffer 清成某个颜色。

## 图list

| 工程 | 文件 | 尺寸 | 颜色数 | 非背景 | 亮度 | 边缘密度 | md5(前12) | 判定 |
|---|---|---|---|---|---|---|---|---|
| BWE 扫雷 · 秋天的旗 | `minesweeper-landscape.png` | 1280×720 | 498 | 91.66% | 163.2 | 15.44 | `2fea4ddb331f` | ✅ 有内容 |
| BWE 扫雷（竖屏） | `minesweeper-portrait.png` | 720×1600 | 498 | 89.65% | 160.4 | 21.82 | `11a347456587` | ✅ 有内容 |
| 孤胆枪手 | `alien-shooter.png` | 1280×720 | 12014 | 100.0% | 45.2 | 0.051 | `5649b5eb6173` | ✅ 有内容 |
| 2D 光照示例 | `lighting-2d.png` | 1280×720 | 41376 | 75.16% | 53.8 | 0.012 | `254c614900bb` | ✅ 有内容 |
| 吸血鬼幸存者 | `vampire-survivors.png` | 1280×720 | 1722 | 73.73% | 28.1 | 0.073 | `1b5d10b45872` | ✅ 有内容 |
| 涌现沙盘 | `emergence-sandbox.png` | 1280×720 | 64 | 75.16% | 47.4 | 0.126 | `1464675f479e` | ✅ 有内容 |
| 开放世界城市 | `open-world-city.png` | 1280×720 | 885 | 99.81% | 123.0 | 0.332 | `c75f85818c42` | ✅ 有内容（不可复现，见 §可复现性） |

**7 / 7 成功，0 失败。** 字节数：52754 / 76678 / 360046 / 446266 / 81925 / 48245 / 115523。
像素统计与 md5 的机读版在 `.tmp_readme_shot/pixel-stats.json`。

## 整图视角变体（`-fit.png`）

`OffscreenFrameDump` 默认是 **1:1 跟随玩家**（玩家眼前一小块），加 `--fit` 是**整图 contain**（看全景）。
两种视角对 README 各有用途，所以对 4 个确实不同的工程额外出了一张 `-fit`：

| 文件 | 尺寸 | 颜色数 | 非背景 | 亮度 | 边缘密度 | md5(前12) | 说明 |
|---|---|---|---|---|---|---|---|
| `minesweeper-landscape-fit.png` | 1280×720 | 538 | 95.15% | 122.7 | 12.42 | `762e654d0342` | 整块棋盘 + 边框，README 主图候选 |
| `minesweeper-portrait-fit.png` | 720×1600 | 504 | 95.06% | 96.4 | 0.448 | `975efc2e9c2a` | 竖屏整图 |
| `alien-shooter-fit.png` | 1280×720 | 16044 | 100.0% | 43.6 | 0.066 | `957f1c068456` | 整关卡视野 |
| `open-world-city-fit.png` | 1280×720 | 1067 | 97.69% | 115.9 | 0.362 | `d1029a5f9ebd` | 看全城街区布局（主图已接近全图，这张填充率反而更低 97.69% vs 99.81%） |

另外 3 个工程（`lighting-2d` / `vampire-survivors` / `emergence-sandbox`）的 `--fit` 输出与主图
**逐字节相同**（相机本来就等于整图），已删除重复文件，只保留一张。

⚠ 取舍：`-fit` 是把整张地图缩进视口，缩放比例与原设计分辨率不一致，像素画会有重采样痕迹。
需要「玩家真实看到什么」用不带 `-fit` 的主图；需要「这个工程有什么内容」用 `-fit`。

## 逐图证据

下面每条只写**像素测出来的**东西 + 引擎自报数据；我没有视觉模型可用（本机 vision 接口
返回 HTTP 400，`sharp` 模块也装不上），所以不做「画面里有个什么角色」这类目测描述。

先说一个对所有图都成立的交叉验证：每张图的 `内容包围盒` 与该工程的网格尺寸对得上。
做法是取与左上角像素不同的像素的 min/max 行列：

| 工程 | 网格 | 内容框 | 每格像素 |
|---|---|---|---|
| 扫雷（横） | 64×64 | 全屏 | — （1:1 跟随相机，只看到一块） |
| 扫雷（竖） | 64×64 | 全屏 | — |
| 孤胆枪手 | 64×48 | 全屏 | — |
| 2D 光照 | 40×30 | x∈[159,1120] 962×720 | 24.1 × 24.0 |
| 吸血鬼幸存者 | 44×34 | x∈[19,1257] 1239×720 | 28.2 × 21.2 |
| 涌现沙盘 | 40×30 | x∈[159,1120] 962×720 | 24.1 × 24.0 |
| 开放世界城市 | 128×96 | 全屏 | — |

两个 40×30 的工程（光照 / 沙盘）内容框完全一致且左右各留 160px 空白，
`px/tile ≈ 24` 高度吻合 —— 说明这两个工程共用同一套 1:1 视口映射，
不是随手拼出来的图。

### minesweeper-landscape.png / minesweeper-portrait.png
`shot.hash.txt`：`size=1280x720`（竖屏 `720x1600`）· `hash=652b014814172ded`（竖屏 `1016b33aa0b3d7a9`）·
`nonBgPixels=844761`（竖屏 1032772）· `frameErrors=0` · `drawCallsPerFrame=3` · `textureBindsTotal=90` ·
`avgDisplayMs≈3.5`
边缘密度 0.215 / 0.307，是全部图里最高的一档，与 32px tile 的棋盘格 + 边框节奏一致。

> 这两张用的是**程序生成的新素材**（`tools/gen-minesweeper-assets-code.mjs`）。
> 旧素材来自仓库外委托单子，已因版权原因整体替换，旧的测量值不再适用。

### alien-shooter.png
`nonBgPixels=921564` · `frameErrors=0` · `drawCallsPerFrame=498` · `textureBindsTotal=4815`
498 draw call/帧、12014 色、52 个素材 —— 引擎侧计数与工程素材数量最大的一个匹配。
周期峰 6/9/12/15 px 密集，符合小 tile + 精灵堆叠的关卡画面。
注意：这张的「非背景占比 100%」只说明**与左上角像素不同的像素覆盖全图**，
不代表「整屏被内容填满」；实际上它顶行本身就是一个渐变色带（左上角不是纯背景色）。
拿另外两条更硬的指标看：主色只占 22.0%、前 3 色合计 49.3% —— 一半以上像素是散色，
不存在「大面积纯色 = 没画东西」的可能。

### lighting-2d.png
`frameErrors=0` · `drawCallsPerFrame=11` · `textureBindsTotal=270` · 41376 色
色数是全部图里最高的一档，而 draw call 只有 11/帧 —— 少的 draw 产生大量的中间色，
这正是光照叠加（多 pass 混合）的特征，不是贴图堆出来的。边缘密度只有 0.012
（最低）：光照是柔和渐变，几乎没有硬边。

### vampire-survivors.png
`nonBgPixels=679465` · `frameErrors=0` · `drawCallsPerFrame=190` · `textureBindsTotal=233`
整体亮度 28.1，是全部图里最暗的一张（暗夜题材）。
**为什么「看着空」不等于黑屏**：非背景占比 73.73%（不是 0），1722 个不同颜色，
前 3 种颜色合计只占 85.9%，还有 14.1% 的像素落在其它 1719 种颜色里；
亮度总和 > 560 的「高亮像素」有 790 个，其包围盒横跨 (23,24)–(1256,592)，
即分散在四角与中部 —— 说明 HUD/文字/精灵都有在画。
另外把它渲到 300 帧，与 45 帧只差 1381 像素（0.15%）：底色与地形完全不动，
动的只有少量动态对象。这与「开局约 0.7 秒、敌人刚刷出来」的解释一致。

### emergence-sandbox.png
`nonBgPixels=692640` · `frameErrors=0` · `drawCallsPerFrame=81` · `textureBindsTotal=360`
64 色 —— 全部图里最少。它和光照示例同为 40×30 网格、同样 75.16% 非背景、
同样 962×720 内容框，但颜色数只有 64 vs 41376、draw call 81 vs 11：
**推断**（非实测断言）是沙盘以少量纯色图元平铺为主、几乎没有渐变混合，
而光照是「少量 draw + 大量混合产生的中间色」。相同几何、极端不同的色彩分布，
说明这两张不是同一个渲染程序在不同参数下出的图。
它自带 8 个图片素材（地面/石墙/木栅栏/油桶/玩家/守卫/平民/油瓶），
64 色说明这些素材本身是低色数像素图。

### open-world-city.png
`nonBgPixels=919840` · `frameErrors=0` · `drawCallsPerFrame=1223` · `textureBindsTotal=7335`
draw call 最多（1223/帧）、101 个素材、边缘密度 0.332（最高）。
周期峰 4/6/8/10 px —— 128×96 网格压进 1280×720，每格约 10×7.5 px，
纹理细节是最密的一个。

## 动画对照（证明是活渲染，不是静态占位图）

同一 boot.json 用 **3 帧** 与 **45 帧** 各渲一次，逐像素 md5 比对：

| 工程 | 3 帧 md5 | 45 帧 md5 | 结论 |
|---|---|---|---|
| minesweeper-landscape | `652b0148` | `652b0148` | 相同（棋盘静置，无入场动画） |
| minesweeper-portrait | `1016b33a` | `1016b33a` | 相同（同上） |
| alien-shooter | `5bb3b7a7` | `5649b5eb` | **不同** → 场景在推进 |
| lighting-2d | `66c2162c` | `254c6149` | **不同** → 光效在推进 |
| vampire-survivors | `f7bce93c` | `1b5d10b4` | **不同** → 敌人/计时在推进 |
| emergence-sandbox | `1ee1fcef` | `1464675f` | **不同** → 单位在移动 |
| open-world-city | `988b9a45` | `c75f8581` | ⚠ 不同，但**不能作为动画证据**（见下） |

5 个工程的 45 帧图与 3 帧图不同 → 引擎按脚本真的在跑帧循环。
扫雷两张相同也是对的：它开局是静态棋盘，不点格子就不变 ——
这反过来证明这组图不是「同一模板套出来的」，否则 7 张应当全部相同。

⚠ **open-world-city 的行要单独看**：它脚本里用了 `Math.random` 且**从不调 `bwe.seed.set`**，
所以同一份 boot.json 连渲两次都不一样。实测：

| 渲染 | md5 |
|---|---|
| 45 帧 第 1 次 | `3d595904bdbd` |
| 45 帧 第 2 次 | `b61d6c627acc` |
| 45 帧 第 3 次 | `9afb1782a899` |
| 3 帧 第 1 次 | `246706f4` |
| 3 帧 第 2 次 | `bc0ddd1b` |

它**在 3 帧时就已经不可复现**了，所以「3 帧 ≠ 45 帧」对它说明不了「动画在推进」，
只能说明「有随机量」。因此这一张不用动画对照做证据，
改用 `drawCallsPerFrame=1223` + 885 色 + 边缘密度 0.332 + 内容框全屏来判定有内容。
差异量级供参考：两次 45 帧之间差 5220 像素（0.57%），差异最大通道 200，
包围盒 (438,476)-(520,670) —— 差异集中在局部，不是整屏重绘。

第 3 节那个「5/7 不同」的说法因此要按 **5 个有据 + 1 个存疑 + 1 个理应相同** 理解。
验证随机性来源（读工程脚本，非猜测）：

| 工程 | `bwe.seed.set` | 用 `Math.random` | 对应上面的可复现性 |
|---|---|---|---|
| 吸血鬼幸存者 | ✅ `bwe.seed.set(20261027)` | 否 | 稳定 |
| 涌现沙盘 | ✅ `bwe.seed.set(W_CFG.seed)` | 否 | 稳定 |
| 开放世界城市 | ❌ 无 | ✅ `player` / `world` 两个脚本 | **不稳定** |
| 扫雷 / 孤胆枪手 / 2D光照 | ❌ 无 | 否 | 稳定（本来就没有随机量） |

## 可复现性（重要）

| 工程 | 是否逐字节可复现 | 原因 |
|---|---|---|
| minesweeper ×2、alien-shooter、lighting-2d、vampire-survivors、emergence-sandbox | ✅ 连渲两次 md5 完全相同 | 无随机量，或脚本里 `bwe.seed.set(固定值)` |

> 扫雷那四张在 2026-11-11 重新渲染过：该工程原来的素材来自仓库外委托单子（含第三方 BGM），
> 版权不在本仓库，已换成 `tools/gen-minesweeper-assets-code.mjs` 程序生成的版本。
> 上面扫雷的行都是新素材的测量值，动画对照实验也重跑过（3 帧 = 45 帧，`652b0148` / `1016b33a`）。
| open-world-city | ❌ 每次不同 | 脚本用 `Math.random` 且没有 `bwe.seed.set` |

所以除了 `open-world-city.png`，其余 6 张都能用 `.tmp_readme_shot/build/<tag>/Build/boot.json` 精确复现出同一个 md5。
`open-world-city.png` 是**一次真实的渲染结果**（内容判定全部通过），只是不能指望再跑一次字节一致。

## 复现方式

```bash
cd D:\githubdesktop\BrokenWonderEngine
node .tmp_readme_shot/render-all.mjs                    # 全部 7 个工程
node .tmp_readme_shot/render-all.mjs --only=alien-shooter
```

脚本做的事（与仓库既有 `web/tools/render-minesweeper.mjs` 完全同一条路径）：

1. `writeQuickBuild(project, null, dir, () => {})` → `<dir>/Build/boot.json`
2. 用 `findRuntimeJdk()` 自动挑 JDK 17~25（本机命中 `jdk-25.0.3.9`）。
   **本机默认 `java` 是 JDK 26，JOGL 2.1 在 26 上因 `java.applet` 被移除而无法初始化 GL** —— 必须绕开。
3. `java --enable-native-access=ALL-UNNAMED --add-opens=java.desktop/sun.awt=ALL-UNNAMED \
   --add-opens=java.desktop/sun.java2d=ALL-UNNAMED -cp ".tmp_build/bin;lib/*" \
   -Djava.library.path=lib Studio.runtime.OffscreenFrameDump <boot> <outPrefix> 45 <w> <h> [--fit]`
4. 像素统计走 Python + PIL（本机 PIL 10.4.0），逐工程 try/catch，单个失败不影响其他。

中间产物全部在 `.tmp_readme_shot/`（`build/<tag>/` 下是 boot.json、PNG、hash.txt、results.json、pixel-stats.json），
**不进 `docs/`**。本目录只有 PNG 与这份 SHOTS.md。

## 顺带记录的可复现数据（引擎自报）

| 工程 | avgDisplayMs | glBegins/帧 | drawCalls/帧 | textureBinds(总) |
|---|---|---|---|---|
| minesweeper-landscape | 3.491 | 3 | 3 | 90 |
| minesweeper-portrait | 3.521 | 3 | 3 | 90 |
| alien-shooter | 6.968 | 107 | 498 | 4815 |
| lighting-2d | 2.812 | 8 | 11 | 270 |
| vampire-survivors | 1.823 | 6 | 190 | 233 |
| emergence-sandbox | 2.183 | 8 | 81 | 360 |
| open-world-city | 7.593 | 164 | 1223 | 7335 |

注：`avgDisplayMs` 是 FBO 离屏渲染耗时（无 vsync、无窗口合成），不等于真机帧时间。
