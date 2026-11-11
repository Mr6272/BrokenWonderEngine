# README 截图 / Screenshots used by the README

这里放 [README.md](../../../README.md) 与 [README.en.md](../../../README.en.md) 用到的全部截图，
以及它们是怎么产生的。**没有一张是手工截屏或设计稿。**

| 目录 | 内容 | 生成方式 | 取证报告 |
|---|---|---|---|
| `editor/` | BWE Studio 编辑器界面（15 张） | 真实 Electron 窗口 + 隔离 userData，跑完即退 | [`editor/SHOTS.md`](editor/SHOTS.md) |
| `runtime/` | 引擎跑出来的游戏画面（11 张） | 真实引擎离屏 GL 渲染（FBO，45 帧后 `glReadPixels`） | [`runtime/SHOTS.md`](runtime/SHOTS.md) |

两份 SHOTS.md 里每条都带：像素尺寸、字节数、颜色数、非背景占比、边缘密度、引擎自报 draw call，
以及「这张图能证明什么」。判定标准写在各自的报告里，可以直接复算。

## 重新生成

```powershell
# 编辑器界面（需要 desktop/vendor 里的 Electron，见 desktop/README.md）
node desktop/main.mjs --shot=docs/readme/raw/editor/hero.png --size=1600x1000
node desktop/main.mjs --shot=docs/readme/raw/editor/script.png --size=1600x1000 `
  --tap='[data-load-js-demo="1"],[data-activity="script"]'

# 游戏画面（需要 JDK 17~25 与已编译的 .tmp_build/bin）
node web/tools/render-minesweeper.mjs
```

`--tap` 收一串 CSS 选择器，依次点击后再截图，所以「打开某个面板之后长什么样」也能自动化取证。
`--verify` 会额外断言主题、横向溢出与非背景像素占比，用来防「白窗口 + 静默退出 0」这类假绿。

## README 用到的图与用途

| 文件 | 用在哪 | 这张图证明什么 |
|---|---|---|
| `editor/hero.png` | README 首图 | 编辑器默认启动后的完整布局（活动栏 / 侧栏 / 编辑区 / AI 栏 / 状态栏都在） |
| `editor/script.png` | 「编辑器长什么样」 | 剧本面板按 JS / Yarn 两种语言编辑 |
| `editor/modules.png` | 同上 | 51 个可视化模块的分类与参数面板 |
| `editor/ai.png` | 同上 | AI 栏含缓存命中率与三类 token 计量 |
| `editor/palette.png` | 同上 | `Ctrl+Shift+P` 命令面板 |
| `editor/explorer.png` | 折叠区 | 资源管理器 + 载入示例工程后的画布 |
| `editor/prefabs.png` | 折叠区 | 预制体面板 |
| `editor/package.png` | 折叠区 | 打包面板（Windows EXE / Android APK / 本机试跑） |
| `editor/package-workbench.png` | 折叠区 | 打包工作台（jpackage 调用与日志） |
| `editor/lighting.png` | 折叠区 | 2D 光照烘焙面板 |
| `editor/settings.png` | 折叠区 | 设置面板 |
| `editor/mobile.png` | 折叠区 | 1280×720 验收下限下界面没有被挤坏 |
| `editor/midnight.png` | 折叠区 | midnight 深色主题 |
| `runtime/minesweeper-landscape-fit.png` | 「现在能跑什么」 | 扫雷整块棋盘（整图 contain 视角） |
| `runtime/alien-shooter.png` | 同上 | 孤胆枪手 1280×720，498 draw call/帧 |
| `runtime/lighting-2d.png` | 同上 | 2D 光照的柔和渐变（41376 色、仅 11 draw call/帧） |
| `runtime/open-world-city.png` | 同上 | 开放世界城市，1223 draw call/帧、101 素材 |
| `runtime/vampire-survivors.png` | 同上 | 吸血鬼幸存者开局 |
| `runtime/emergence-sandbox.png` | 同上 | 涌现沙盘（大量同色图元平铺，64 色） |

`editor/ai-models.png` 与 `editor/ai-thinking.png` 是备用图（模型清单注入态、「正在思考」冻结态），
README 没有引用。另有 5 张是同一工程的另一视角或另一画幅，也没进 README：
`runtime/minesweeper-landscape.png`、`minesweeper-portrait.png`、`minesweeper-portrait-fit.png`、
`alien-shooter-fit.png`、`open-world-city-fit.png`。

合计 26 张，README 用掉 19 张，剩下 7 张留在目录里备查。全部 26 张在对应的 SHOTS.md 里都有记录。

## 两条已知限制

- `runtime/open-world-city.png` **不可复现**：该工程脚本用 `Math.random` 且从不调 `bwe.seed.set`，
  连渲三次 md5 全不同。所以它的「3 帧 vs 45 帧不同」不能当动画证据，判定改用
  draw call（1223/帧）+ 色数（885）+ 边缘密度（0.332）。其余 6 张连渲两次字节一致。
- 本机视觉模型接口不可用（HTTP 400 缺 model 参数），`sharp` 也装不上，所以两份 SHOTS.md
  都**只写像素测量与引擎自报数字**，不写「画面里有个什么角色」这类目测描述。
