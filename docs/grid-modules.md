# 网格模块：从「一整个游戏一个模块」拆成可复用积木

> 面向后续开发者的架构说明。读完这份文档，你应该能回答：
> 「要做个新的格子玩法，我该挂哪些模块、写多少代码」。

## 为什么要拆

原先只有一个 `game.minesweeper` 模块 —— **一整个扫雷（600 行）是一个黑盒**。
后果：

- 想做个「数织」「围线」「战棋」，只能把扫雷那套复制一遍再改，规则和渲染焊死在一起；
- 想调外观（换地砖、改数字配色）必须动玩法逻辑；
- 引擎里 `game.*` 分类下全是「整块游戏」，模块体系名存实亡。

现在按**能力**切开，一个玩法 = 若干模块的组合。

## 五个模块

| 模块 id | 分类 | 提供什么 | 什么时候用 |
|---|---|---|---|
| `grid.board` | 网格 | 行列网格、每格状态、邻域遍历、连通泛洪 | 任何「网格 + 每格状态」的玩法 |
| `grid.tile` | 网格 | 格子渲染：立体地砖 / 平铺 / 贴图 / 数字配色 | 只想要那套外观 |
| `grid.reveal` | 网格 | 翻开行为：首击安全、空白自动展开、失败全亮 | 想要「点开」这套规则 |
| `grid.flag` | 网格 | 标记 + 计数 + 胜负条件 + 计时器 | 想要「插旗/达成条件」 |
| `game.minesweeper` | 玩法 | 以上全部 + 雷生成 + 复雷加殊规则 | 完整扫雷（**老工程照旧用它，行为不变**） |

`game.minesweeper` 是「全开」组合体，不是重复实现：它内部建的是同一套
`GridBoard` / `GridPainter`，只是把所有能力打开。

## 组合示例

```js
// 1) 只想要一块可点的网格（数织、战棋、消除都从这里起步）
//    模块：grid.board + grid.tile（不要挂 game.minesweeper）
//    规则由脚本决定：
function onUpdate(dt) {
  if (!bwe.board.mounted) { return; }
  if (bwe.input.pressed("Mouse0")) {
    var i = bwe.board.indexAt(bwe.input.mouse.worldX, bwe.input.mouse.worldY);
    if (i >= 0) { bwe.board.open(i); }        // 纯翻开，不判负
  }
}

// 2) 完整扫雷：拖一个「扫雷棋盘」模块即可，什么都不用写
```

### `bwe.board`（网格模块的格子状态）

> 别和 `bwe.grid` 搞混：`bwe.grid` 是**瓦片地图**的坐标换算（`toCell`/`toWorld`/`snap`），
> 任何工程都有；`bwe.board` 才是**网格模块**的格子状态，只有挂了 `grid.*` 或
> `game.minesweeper` 才有内容。两个命名空间刻意分开，避免同名不同义。

| 调用 | 说明 |
|---|---|
| `bwe.board.mounted` | 本工程是否挂了网格模块 |
| `bwe.board.size()` | `{rows, cols, count}` |
| `bwe.board.opened(idx)` / `flagged(idx)` | 该格是否已翻开 / 已标记 |
| `bwe.board.indexAt(wx, wy)` | 世界坐标 → 格子索引（越界 `-1`） |
| `bwe.board.open(idx)` | 翻开一格（无雷玩法用它代替「点开」） |
| `bwe.board.toggle(idx)` | 切换标记（没挂 `grid.flag` 时不生效） |
| `bwe.board.floodCount(idx)` | 从该格泛洪能翻开多少格（写规则时很有用） |''；

## 能力裁剪（关键实现细节）

`Minesweeper` 现在按对象上挂的模块裁剪行为（`GridModules.Bundle`）：

| 没挂什么 | 后果 |
|---|---|
| 没有 `game.minesweeper` | **不生成雷**（`wantedMines = 0`），棋盘只是空白网格 |
| 没有 `grid.reveal` | 不做首击安全、不自动展开、踩中不判负 |
| 没有 `grid.flag` | 不响应插旗、不维护旗帜计数、不显示计时器 |
| 没有 `grid.tile` 的资源参数 | 用内置样式画格子和数字 |

所以同一个棋盘内核能同时服务「完整扫雷」和「只要一块网格」，
而不是被迫继承扫雷的全部规则。

## 源码在哪

| 文件 | 职责 |
|---|---|
| `src/Studio/runtime/GridBoard.java` | 网格状态机：索引换算、8/4 邻域遍历、泛洪、标记计数 |
| `src/Studio/runtime/GridPainter.java` | 通用格子渲染：离屏位图 + 纹理缓存 + 脏标记 + 绘制工具 |
| `src/Studio/runtime/GridModules.java` | 模块 → 能力集的解析（`Bundle`） |
| `src/Studio/runtime/Minesweeper.java` | 扫雷玩法：雷生成、翻开/标记/连开规则、Win9x 画法 |
| `src/Studio/runtime/ComplexRules.java` | 复雷加殊的纯规则数学（无状态、无渲染） |
| `src/Studio/runtime/Actor.java` `Texture.java` | 从宿主提升为包级类型，供玩法模块独立引用 |

## 自检

```bash
.\tools\bwe.ps1 test-all        # 含 GridBoardTest：33 项断言
```

`GridBoardTest` 专门验证「网格能力真的独立可用」：

- 几何/索引换算正确；
- 8/4 邻域边界处理正确、不含自身；
- 泛洪能翻开连通区域、遇标记障碍停住；
- **只挂 `grid.board` 时没有雷、不判扫雷胜负**（能力裁剪的验收项）。

## 新增玩法时怎么做

1. 选模块：至少要 `grid.board`；要外观加 `grid.tile`；要「点开」加 `grid.reveal`。
2. 写脚本：用 `bwe.grid.*` 读写格子状态，规则留在脚本里 —— 不要往
   `Minesweeper` 里塞新游戏的分支（那会退回到「整块游戏」的老路）。
3. 加测试：仿 `GridBoardTest` 写法，验证规则纯逻辑，不依赖 GL。

## 迁移说明

**不需要迁移**。`game.minesweeper` 的模块 id、参数名、运行时行为、脚本 API
（`bwe.mine.*`）全部保持不变；已有工程打开即用。新的 `grid.*` 模块是增量能力。
