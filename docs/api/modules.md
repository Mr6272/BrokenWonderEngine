# 可视化模块目录（Visual Module Catalog）

> 本页覆盖编辑器里那些「积木」（模块）：id / 中文名 / 分类 / 参数 / 触发时机 / **运行时是否真的执行**。
>
> 相关页：[entity：模块读写 API](entity.md#五模块) · [world：生成时挂模块](world.md#bweworldspawnopts--entity--null) · [README：索引](README.md)

---

## ⚠ 先读这一节：模块目录 ≠ 运行时行为

这是本页最重要的一条事实：

| 事实 | 含义 |
|---|---|
| **模块目录**（`src/Studio/modules/BuiltinModules.java`）是**编辑器**侧的积木清单 | 它决定 Inspector 里能看到什么、每个模块有哪些参数、参数默认值是什么 |
| **运行时**（`TopDownRuntime.java`）只解释其中**一部分**模块 | 运行时按**模块 id 硬编码**读几个参数做行为；没被读到的模块**只是数据，不会产生任何效果** |
| 因此 | 一个模块出现在 Inspector 里、能拖进场景、参数能改 —— 但**不代表运行时它会干活** |

本页每个模块都标了「**运行时**」列：

| 标记 | 含义 |
|---|---|
| ✅ 执行 | 运行时有对应代码读它的参数并驱动行为 |
| ⚠ 部分 | 运行时有代码，但**只读了一部分参数**（其它参数运行时不生效，见下方备注） |
| 📋 无 | 运行时不读该 id —— 纯数据 / 留给未来 / 靠脚本或其它机制实现 |
| 🌐 全局 | 不做成模块，效果是引擎全局固有的（与该模块挂不挂无关） |

**共 43 个模块，7 个分类。**

---

## 一、模块总表

### 怎么动 MOVE（`#2F6BFF`）

| id | 中文名 | 一句话 | 参数 | 运行时 |
|---|---|---|---|---|
| `move.follow` | 朝玩家走 | 发现玩家后一路追过去 | `speed` `stopDist` `seeRange` `ignoreWalls` | ⚠ 部分 |
| `move.patrol` | 来回巡逻 | 在两个点之间来回走 | `speed` `range` `axis` `wait` | ⚠ 部分 |
| `move.wander` | 随意游荡 | 在附近随意走走停停 | `speed` `area` `pauseMin` `pauseMax` | ⚠ 部分 |
| `move.path` | 沿指定路线走 | 按你画的路线一段段走 | `speed` `routeTag` `loop` `onArrive` | 📋 无 |
| `move.pushable` | 可以被推动 | 玩家撞上去能把它顶开 | `weight` `canFall` | 📋 无 |
| `move.locked` | 钉死不动 | 任何力量都推不动它 | （无参数） | ✅ 执行 |
| `move.flee` | 躲着玩家跑 | 玩家一靠近就往反方向逃 | `speed` `fearRange` `giveUp` | ⚠ 部分 |

### 怎么显示 LOOK（`#7A5AF8`）

| id | 中文名 | 一句话 | 参数 | 运行时 |
|---|---|---|---|---|
| `look.faceMove` | 走动时朝向转向 | 自动切换四方向（或八方向）的走路图 | `dirs` `fps` `idleName` | 📋 无 |
| `look.playOnce` | 播一遍就停 | 某个动作只播一次，播完停在最后一帧 | `asset` `fps` `thenDo` | 📋 无 ※ |
| `look.blink` | 一闪一闪 | 让它明暗或可见度周期变化 | `period` `minAlpha` `scalePulse` | ⚠ 部分 |
| `look.shadow` | 脚下阴影 | 在脚下画一圈椭圆阴影 | `w` `h` `alpha` | ⚠ 部分 |
| `look.sortByY` | 按前后自动遮挡 | 站在更下面的人挡住上面的人 | （无参数） | 🌐 全局 ※ |
| `look.light` | 发一圈光 | 在它周围照亮一圈 | `radius` `color` `strength` `flicker` | 📋 无 ※ |

### 怎么感知 SENSE（`#12A06B`）

| id | 中文名 | 一句话 | 参数 | 运行时 |
|---|---|---|---|---|
| `sense.block` | 挡住去路 | 别人走不过去（墙、家具、水） | `shape` `seeThrough` `blockFlying` | 📋 无 ※ |
| `sense.range` | 范围内有没有东西 | 检查以自己为圆心的一圈里有什么 | `radius` `who` `tag` `needSight` | 📋 无 |
| `sense.dist` | 离玩家有多远 | 把距离算出来，供别的模块判断 | `var` `rounded` | 📋 无 |
| `sense.lineOfSight` | 能不能看见玩家 | 直线中间没有墙就算看得见 | `range` `fov` `instant` `delay` | 📋 无 |
| `sense.onTile` | 踩在什么地形上 | 判断脚下是什么地面 | `tileTag` `thenDo` | 📋 无 |
| `sense.overlap` | 和什么东西重叠了 | 精确判断自己的范围与指定对象是否压在一起 | `targetTag` `thenDo` | 📋 无 |

### 什么时候做 RULE（`#E08A00`）

| id | 中文名 | 一句话 | 参数 | 运行时 |
|---|---|---|---|---|
| `rule.click` | 被点击时 | 玩家用鼠标点它才算数 | `thenDo` `maxDist` `onlyOnce` | 📋 无 ※ |
| `rule.touch` | 碰到东西时 | 和别的东西撞上时触发 | `withTag` `thenDo` `cooldown` | 📋 无 |
| `rule.enterArea` | 有东西进来时 | 有东西进入指定范围的那一刻做一次 | `radius` `who` `thenDo` `once` | 📋 无 ※ |
| `rule.leaveArea` | 有东西离开时 | 有东西走出范围的那一刻做一次 | `radius` `thenDo` | 📋 无 ※ |
| `rule.timer` | 计时到点 | 过一段时间做一次（也可以反复做） | `delay` `repeat` `thenDo` | 📋 无 |
| `rule.var` | 变量到达条件 | 存档里的某个数满足条件时触发 | `varName` `op` `value` `thenDo` `once` | 📋 无 |
| `rule.call` | 被别人叫到时 | 只有当别的模块点名它才执行 | `name` | 📋 无 |
| `rule.enableIf` | 满足条件才生效 | 给上面的积木加一道开关条件 | `cond` `alsoHide` | 📋 无 |

### 怎么打 FIGHT（`#E14A4A`）

| id | 中文名 | 一句话 | 参数 | 运行时 |
|---|---|---|---|---|
| `fight.hp` | 有血量会掉血 | 给它一个血条，能被打死 | `hp` `defense` `showBar` `invincible` | ⚠ 部分 |
| `fight.melee` | 靠近就打 | 玩家进入攻击距离就挥一下 | `range` `damage` `interval` `windup` `attackAnim` | 📋 无 |
| `fight.projectile` | 发射子弹 | 朝玩家吐出会飞的东西 | `speed` `damage` `interval` `bullet` `life` `pierce` | 📋 无 |
| `fight.damage` | 受到伤害时 | 被打中时做的事情 | `flash` `knockback` `knockDist` `hurtSfx` `thenDo` | 📋 无 |
| `fight.die` | 死亡时 | 血量归零后发生的事情 | `way` `dropAsset` `exp` `thenDo` `respawn` | 📋 无 |
| `fight.invuln` | 受伤后短暂无敌 | 挨打之后有一小段时间不再掉血 | `time` `blink` | 📋 无 |

### 怎么说话 TALK（`#0EA5B7`）

| id | 中文名 | 一句话 | 参数 | 运行时 |
|---|---|---|---|---|
| `talk.say` | 说一句话 | 在角色头顶弹一个小气泡 | `text` `duration` `rise` | 📋 无 |
| `talk.dialogue` | 弹出对话框 | 打开底部对话框，走一段剧本 | `script` `node` `lockMove` `portrait` | 📋 无 |
| `talk.choice` | 给玩家几个选项 | 弹出选项让玩家选一个 | `q` `options` `results` `cancelable` | 📋 无 |
| `talk.interact` | 按键交谈 | 玩家走近并按下交互键时触发 | `range` `thenDo` `hintIcon` | 📋 无 |

### 画面与声音 SHOW（`#8A6D3B`）

| id | 中文名 | 一句话 | 参数 | 运行时 |
|---|---|---|---|---|
| `show.sfx` | 播一段声音 | 放一个短音效 | `asset` `volume` `positional` | 📋 无 |
| `show.bgm` | 切换背景音乐 | 换掉正在播的音乐 | `asset` `fadeIn` `loop` | 📋 无 |
| `show.effect` | 在它身上播特效 | 播放一段粒子或序列帧特效 | `asset` `scale` `life` `follow` | 📋 无 |
| `show.shake` | 画面震动 | 让镜头抖一下 | `strength` `time` `sfx` | 📋 无 |
| `show.changeScene` | 换到另一张地图 | 切场景，并把玩家放到指定出生点 | `scene` `spawn` `fade` `keepBgm` | 📋 无 |
| `show.camera` | 镜头跟着它 | 把镜头挂在它身上 | `smooth` `lookAhead` `clamp` | ⚠ 部分 |

**※ 备注**（「运行时」列里带 ※ 的，或 ⚠ 部分的细节）：

| 模块 | 运行时到底怎么处理 |
|---|---|
| `look.playOnce` ※ | **不读该 id**。运行时的单次播放靠实体字段 `animMode === "单次播放"`（可用 [`e.sprite({mode:"once"})`](entity.md#espriteopts--void) / [`e.animMode`](entity.md#eanimmode--string) 设）；模块本身的 `asset` / `fps` / `thenDo` 运行时不读 |
| `look.sortByY` ※ | **不读该 id**，但「按 Y 排序」是引擎**固有行为**：绘制顺序恒为 `layer → z → y`，与是否挂这个模块无关 |
| `look.light` ※ | **不读该 id**。运行时的**灯光只有「兜底色块颜色」**（`kind === "LIGHT"` 的对象在无贴图时画暖黄色块），**没有真正的发光/照亮渲染** |
| `sense.block` ※ | **不读该 id**。阻挡靠**瓦片地图**：`kind === "TILE"` 的对象生成时自动写进瓦片表并标记阻挡；要放墙请用 TILE 对象，而不是挂这个模块 |
| `rule.click` ※ | **不读该 id**，但点击派发是引擎固有的：点中对象会派发对象脚本的 `onClick` 与实体 `"click"` 事件（`maxDist` / `onlyOnce` 无对应实现） |
| `rule.enterArea` / `rule.leaveArea` ※ | **不读该 id**，但 ZONE 对象的进出派发是引擎固有的：`kind === "ZONE"` 的对象在玩家进出时派发 `onEnter` / `onLeave`（`radius` 参数无对应实现，用的是对象自身尺寸） |

---

## 二、逐模块细节（参数 + 触发时机）

> 参数格式：`key`（中文标签，默认值）—— 范围 / 单位。默认值来自模块定义，**不是运行时行为**的保证。

### 怎么动 MOVE

#### move.follow — 朝玩家走

> 发现玩家后一路追过去。适合敌人、跟随的同伴。追的过程会自动绕开墙壁与障碍（若场景里有「挡住去路」的物件）。和「原地巡逻」同时挂会互相抢控制权，一般二选一。

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `speed` | 走多快 | 60 | 5~400 px/s | 数值越大追得越急 |
| `stopDist` | 离多远就停下 | 24 | 0~300 px | 贴到这么近就不再往前挤，避免抖 |
| `seeRange` | 多远开始追 | 200 | 20~1200 px | 超过这个距离就不理会玩家 |
| `ignoreWalls` | 可以穿墙 | false | — | 打开后会无视墙壁直冲，通常只在剧情演出时用 |

触发时机：`ALWAYS`（一直生效）
**运行时**：⚠ 部分 —— 实际读到的是 **`speed`** 与 **`stopDistance`**。
⚠ **参数名不一致**：模块定义的是 `stopDist`，运行时读的是 `stopDistance` → **`stopDist` 改了没用**，实际停止距离恒为 48px（运行时默认值）。`seeRange` / `ignoreWalls` 运行时不读（跟随没有距离门槛、也不绕墙）。

#### move.patrol — 来回巡逻

> 在两个点之间来回走。适合守卫、巡逻的机器人。走到头会稍作停留再折返。

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `speed` | 走多快 | 40 | 5~300 px/s | — |
| `range` | 来回多远 | 96 | 8~2000 px | 以放置点为中心，左右各走这么远 |
| `axis` | 沿哪个方向 | `"左右"` | — | 填「左右」或「上下」 |
| `wait` | 到头的停顿 | 0.6 | 0~10 s | 0 表示不停，立刻折返 |

触发时机：`ALWAYS`
**运行时**：⚠ 部分 —— 读到 **`axis`**（含「垂直」或 `vertical` 就走上下）与 **`speed`**。
⚠ **参数名不一致**：模块定义 `range`，运行时读 **`distance`** → **`range` 改了没用**，实际半径恒为 96px。`wait` 运行时不读（不会停顿，那是正弦往复）。

#### move.wander — 随意游荡

> 在附近随意走走停停。适合村民、野生动物。不追人，只在指定范围内随机选点移动。

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `speed` | 走多快 | 30 | 5~200 px/s | — |
| `area` | 活动范围 | 120 | 16~2000 px | 以放置点为中心的半径 |
| `pauseMin` | 最短停留 | 0.8 | 0~20 s | — |
| `pauseMax` | 最长停留 | 2.5 | 0~30 s | — |

触发时机：ALWAYS（空列表 = 立刻生效）
**运行时**：⚠ 部分 —— 读到 **`speed`**。
⚠ **参数名不一致**：模块定义 `area`，运行时读 **`radius`** → **`area` 改了没用**，实际活动半径恒为 80px。`pauseMin` / `pauseMax` 运行时不读（固定 1.2~3.4 秒换向）。

#### move.path — 沿指定路线走

> 按你画的路线一段段走。路线用「路径点」对象画出来。

| 参数 | 标签 | 默认 | 类型 | 说明 |
|---|---|---|---|---|
| `speed` | 走多快 | 50 | 5~300 px/s | — |
| `routeTag` | 走哪条路线 | — | TAG | 在场景里给路径点对象打上同一个标签 |
| `loop` | 走完重头再来 | true | 开关 | 关掉则走到终点就停下 |
| `onArrive` | 走到后叫哪个模块 | — | 文字 | 可留空；填模块的自定义名字 |

**运行时**：📋 无 —— 运行时不读这个 id。想沿路径走请用脚本 [`bwe.nav.find` + `bwe.nav.follow`](map-nav-interact-spawner.md#bwenavfollowe-path-opts--void)。

#### move.pushable — 可以被推动

> 玩家撞上去能把它顶开。适合箱子、木桶。打开后会参与物理。

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `weight` | 有多重 | 1 | 0.1~50 倍 | 越大越推不动 |
| `canFall` | 会掉下悬崖 | false | 开关 | 关掉则永远浮在原地 |

**运行时**：📋 无 —— 运行时不读这个 id。物理可推要用脚本 [`bwe.physics.body(...)`](emergence.md#bwephysicsbodye-opts--entity--null) 建 dynamic 刚体。

#### move.locked — 钉死不动

> 任何力量都推不动它。适合墙壁、山体、大树。

无参数。
**运行时**：✅ 执行 —— 运行时会**提前返回**（`updatePlayer` 里 `data.has(player.o, "move.locked")` 就直接跳过玩家移动）。**只对玩家生效**（非玩家对象本来也不受键盘驱动，所以挂不挂没差别）。

#### move.flee — 躲着玩家跑

> 玩家一靠近就往反方向逃。适合胆小的小动物。

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `speed` | 跑多快 | 70 | 5~400 px/s | — |
| `fearRange` | 多近开始逃 | 140 | 20~800 px | — |
| `giveUp` | 拉开距离后停下 | true | 开关 | 关掉会一直逃到地图边界 |

**运行时**：⚠ 部分 —— 读到 **`speed`**。
⚠ **参数名不一致**：模块定义 `fearRange`，运行时读 **`range`** → **`fearRange` 改了没用**，实际逃跑触发距离恒为 240px。`giveUp` 运行时不读。

---

### 怎么显示 LOOK

#### look.faceMove — 走动时朝向转向

> 自动切换四方向（或八方向）的走路图。俯视角 RPG 的标配。

| 参数 | 标签 | 默认 | 类型 | 说明 |
|---|---|---|---|---|
| `dirs` | 几个方向 | `"四方向"` | 选项 | 四方向 / 八方向 / 不转方向 |
| `fps` | 每秒几帧 | 8 | 1~30 帧/秒 | 走路动画的播放速度 |
| `idleName` | 站着不动的图 | `"待机"` | 文字 | 素材里的名字，找不到就用第一帧 |

**运行时**：📋 无。

#### look.playOnce — 播一遍就停

> 某个动作只播一次，播完停在最后一帧。适合开门、爆炸、挥刀。

| 参数 | 标签 | 默认 | 类型 | 说明 |
|---|---|---|---|---|
| `asset` | 播哪个素材 | — | ASSET | 从素材库挑一条序列帧 |
| `fps` | 每秒几帧 | 12 | 1~60 帧/秒 | — |
| `thenDo` | 播完做什么 | — | 文字 | 可留空；填另一个模块的自定义名字 |

**运行时**：📋 无（※ 但「单次播放」这个行为本身**存在**：靠实体字段 `animMode = "单次播放"`，用 [`e.sprite({mode:"once"})`](entity.md#espriteopts--void) 设）。

#### look.blink — 一闪一闪

> 让它明暗或可见度周期变化。

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `period` | 一次闪多久 | 1.2 | 0.1~20 s | 一个完整亮灭循环 |
| `minAlpha` | 最暗到多少 | 0.35 | 0~1 倍 | 1 表示不闪 |
| `scalePulse` | 同时轻微涨缩 | false | 开关 | 像在呼吸 |

**运行时**：⚠ 部分 —— 读到的是**这个模块 id 本身**（`data.has(a.o, "look.blink")`），但**不读任何参数**：alpha 固定为 `0.3 + 0.7 * |sin(time * 6)|`。
即：`period` / `minAlpha` / `scalePulse` **全部不生效**。（旧 id `render.blink` 也认。）

#### look.shadow — 脚下阴影

> 在脚下画一圈椭圆阴影。俯视角最有效的「贴地感」来源。

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `w` | 阴影宽 | 28 | 4~400 px | — |
| `h` | 阴影高 | 12 | 2~400 px | 俯视角一般取宽的一半 |
| `alpha` | 深浅 | 0.35 | 0~1 倍 | — |

**运行时**：⚠ 部分 —— 读到**模块 id**（`look.shadow` / 旧 id `render.shadow`）才画，但**不读参数**：宽固定 = `绘制宽 × 0.42`、高 = `max(6, 绘制高 × 0.12)`、alpha 固定 `0.22`。
即：`w` / `h` / `alpha` **全部不生效**。

#### look.sortByY — 按前后自动遮挡

> 站在更下面的人挡住上面的人。俯视角 2D 必须开。

无参数。
**运行时**：🌐 全局 —— 运行时不读该 id，但「按 Y 排序」是**引擎固有行为**：绘制顺序恒为 `layer → z → y`，**不挂这个模块也一样**。

#### look.light — 发一圈光

> 在它周围照亮一圈。适合火把、路灯、魔法阵。

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `radius` | 照多远 | 140 | 16~1200 px | — |
| `color` | 光的颜色 | `"#FFC978"` | 文字 | 十六进制，如 `#80CCFF` |
| `strength` | 强度 | 0.8 | 0~2 倍 | — |
| `flicker` | 会闪动 | false | 开关 | 像火苗一样 |

**运行时**：📋 无 —— `radius` / `color` / `strength` / `flicker` 运行时不读。运行时的「灯」只是 `kind === "LIGHT"` 对象在**没有贴图**时画的暖黄色块，**没有光照/发光渲染**。想要真光效请自己用 `bwe.draw.circle` 叠半透明圆。

---

### 怎么感知 SENSE

#### sense.block — 挡住去路

> 别人走不过去（墙、家具、水）。俯视角地图的「墙模块」。

| 参数 | 标签 | 默认 | 类型 | 说明 |
|---|---|---|---|---|
| `shape` | 阻挡范围 | `"整块"` | 选项 | 整块 / 身体大小 |
| `seeThrough` | 不挡视线 | false | 开关 | 打开后敌人能隔着它看见你 |
| `blockFlying` | 也挡飞行 | false | 开关 | 关掉则飞行的东西可以越过 |

**运行时**：📋 无（※ **阻挡实际靠瓦片地图**：`kind === "TILE"` 的对象生成时自动写瓦片表并标记阻挡。放墙请用 TILE 对象。）

#### sense.range — 范围内有没有东西

> 检查以自己为圆心的一圈里有什么。

| 参数 | 标签 | 默认 | 范围/类型 | 说明 |
|---|---|---|---|---|
| `radius` | 检查半径 | 96 | 4~2000 px | — |
| `who` | 检查谁 | `"玩家"` | 选项 | 玩家 / 全部角色 / 同标签的物件 / 任意东西 |
| `tag` | 指定标签 | — | TAG | 上一步选「同标签」时用 |
| `needSight` | 需要看得见 | false | 开关 | 打开后被墙挡住不算进范围 |

**运行时**：📋 无 —— 用脚本 [`bwe.interact.nearest`](map-nav-interact-spawner.md#bweinteractnearestactor-opts--entity--null) 或自己算距离。

#### sense.dist — 离玩家有多远

> 把距离算出来，供别的模块判断。

| 参数 | 标签 | 默认 | 类型 | 说明 |
|---|---|---|---|---|
| `var` | 存到哪个变量 | `"距离"` | 文字 | 给这个名字起个好记的 |
| `rounded` | 四舍五入到整格 | true | 开关 | 关掉则保留精确像素 |

**运行时**：📋 无 —— 用 [`bwe.dist`](lifecycle.md#bwedistx1-y1-x2-y2--number) 或 [`e.distanceTo`](entity.md#edistancetoother--number)。

#### sense.lineOfSight — 能不能看见玩家

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `range` | 看多远 | 260 | 8~1600 px | — |
| `fov` | 视野角度 | 120 | 10~360 度 | 360 表示不需要转头 |
| `instant` | 立刻发现 | true | 开关 | 关掉则要在视野里待一会儿才被发现 |
| `delay` | 要盯多久 | 0.8 | 0.1~10 s | 只有 `instant` 关掉时才起作用 |

**运行时**：📋 无 —— 用 [`bwe.nav.lineOfSight`](map-nav-interact-spawner.md#bwenavlineofsighta-b--boolean) 或（带视野角/烟雾）[`bwe.sense.canSee`](emergence.md#bwesensecanseea-b--boolean)。

#### sense.onTile — 踩在什么地形上

| 参数 | 标签 | 默认 | 类型 | 说明 |
|---|---|---|---|---|
| `tileTag` | 哪种地形 | — | TAG | 给地面块打上标签后在这里选 |
| `thenDo` | 踩上后叫哪个模块 | — | 文字 | 填模块的自定义名字 |

**运行时**：📋 无 —— 自己比对 [`bwe.material.of`](emergence.md#bwematerialofcx-cy--string--null) 或瓦片 id。

#### sense.overlap — 和什么东西重叠了

| 参数 | 标签 | 默认 | 类型 | 说明 |
|---|---|---|---|---|
| `targetTag` | 和什么重叠 | — | TAG | — |
| `thenDo` | 重叠后叫哪个模块 | — | 文字 | — |

**运行时**：📋 无。

---

### 什么时候做 RULE

| 模块 | 参数（标签 / 默认） | 运行时 |
|---|---|---|
| `rule.click` 被点击时 | `thenDo`（点了做什么）· `maxDist`（最远能点多远 / 64）· `onlyOnce`（只响应第一次 / false） | 📋 无（※ 点击派发是引擎固有：对象脚本 `onClick` + 实体 `"click"` 事件；`maxDist` / `onlyOnce` 无实现） |
| `rule.touch` 碰到东西时 | `withTag`（和什么东西碰）· `thenDo`（碰到后做什么）· `cooldown`（多久内不重复触发 / 0.5s） | 📋 无 |
| `rule.enterArea` 有东西进来时 | `radius`（范围半径 / 120）· `who`（什么东西进来 / 玩家）· `thenDo` · `once`（只触发一次 / false） | 📋 无（※ 引擎固有：`kind === "ZONE"` 的对象在玩家进出时派发 `onEnter`；`radius` 无实现，用对象自身尺寸） |
| `rule.leaveArea` 有东西离开时 | `radius`（范围半径 / 120）· `thenDo` | 📋 无（※ 同上，对应 `onLeave`） |
| `rule.timer` 计时到点 | `delay`（等多久 / 3s）· `repeat`（反复触发 / false）· `thenDo` | 📋 无 —— 用 [`bwe.after` / `bwe.every`](lifecycle.md#三定时器) |
| `rule.var` 变量到达条件 | `varName`（哪个变量）· `op`（怎么算达到 / 大于等于）· `value`（比较的值 / "1"）· `thenDo` · `once`（只触发一次 / true） | 📋 无 |
| `rule.call` 被别人叫到时 | `name`（给这段动作起名 / "开门"） | 📋 无 |
| `rule.enableIf` 满足条件才生效 | `cond`（什么条件下生效）· `alsoHide`（不满足时连人都藏起来 / false） | 📋 无 |

`op` 的选项：`大于等于` / `小于等于` / `等于` / `不等于`。

---

### 怎么打 FIGHT

#### fight.hp — 有血量会掉血

> 给它一个血条，能被打死。血量归零时会走「死亡时」的积木。

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `hp` | 血量 | 100 | 1~100000 点 | — |
| `defense` | 防御 | 0 | 0~1000 点 | 每次受伤害减去这个数 |
| `showBar` | 显示血条 | true | 开关 | 只在受伤或靠近时显示更干净 |
| `invincible` | 无敌 | false | 开关 | 调试时用，或做剧情保护 |

**运行时**：⚠ 部分 —— **只读到血量上限**：`hpMax = max(1, params.maxHealth ?? params.hp ?? 10)`，且 `hp` 初始化为满血。
⚠ **参数名注意**：模块定义 `hp`，运行时优先读 **`maxHealth`**（编辑器旧字段名），读不到才读 `hp`。所以 `hp` 是生效的。
`defense` / `showBar` / `invincible` **运行时不读**（伤害没有减防、血条由引擎恒绘制、`invincible` 不存在无敌判定）。
⚠ 别名叫 `combat.health`（旧 id）。

#### fight.melee — 靠近就打

| 参数 | 标签 | 默认 | 范围/类型 | 说明 |
|---|---|---|---|---|
| `range` | 攻击距离 | 40 | 8~400 px | — |
| `damage` | 每下伤害 | 10 | 0~100000 点 | — |
| `interval` | 多久打一下 | 1.2 | 0.1~30 s | — |
| `windup` | 出手前的抬手 | 0.25 | 0~3 s | 给玩家反应时间 |
| `attackAnim` | 攻击时播哪个素材 | — | ASSET | 留空则只做数值伤害 |

触发时机：`ALWAYS`
**运行时**：📋 无 —— 用脚本 [`e.damage`](entity.md#edamagen--number) 自己实现。

#### fight.projectile — 发射子弹

| 参数 | 标签 | 默认 | 范围/类型 |
|---|---|---|---|
| `speed` | 飞多快 | 200 | 20~1500 px/s |
| `damage` | 打中掉多少血 | 12 | 0~100000 点 |
| `interval` | 多久发一次 | 1.6 | 0.1~60 s |
| `bullet` | 用哪个素材 | — | ASSET |
| `life` | 最多飞多久 | 3 | 0.2~60 s |
| `pierce` | 能穿透 | false | 开关 |

**运行时**：📋 无 —— 用 [`bwe.world.spawn`](world.md#bweworldspawnopts--entity--null) + [`bwe.physics.throwAt`](emergence.md#bwephysicsthrowate-tx-ty-speed--boolean) 自己实现。

#### fight.damage — 受到伤害时

| 参数 | 标签 | 默认 | 类型 |
|---|---|---|---|
| `flash` | 闪一下白 | true | 开关 |
| `knockback` | 往后退 | true | 开关 |
| `knockDist` | 退多远 | 12 | 0~300 px |
| `hurtSfx` | 播哪个音效 | — | ASSET |
| `thenDo` | 接着做什么 | — | 文字 |

**运行时**：📋 无（※ 受击**事件**是引擎固有的：`e.damage()` 会派发对象脚本 `onDamage` 与实体 `"damage"` 事件，但闪白 / 击退 / 音效都没实现）。

#### fight.die — 死亡时

| 参数 | 标签 | 默认 | 类型 |
|---|---|---|---|
| `way` | 怎么消失 | `"淡出后消失"` | 选项（立刻消失 / 淡出后消失 / 留下尸体） |
| `dropAsset` | 掉落什么东西 | — | ASSET |
| `exp` | 给多少经验 | 0 | 0~1000000 点 |
| `thenDo` | 之后做什么 | — | 文字 |
| `respawn` | 过一会儿重生 | false | 开关 |

**运行时**：📋 无（※ 死亡**事件**是引擎固有的：`hp <= 0` 派发 `onDeath` / `"death"`；但「淡出/留尸体/掉落/经验/重生」都没实现）。

#### fight.invuln — 受伤后短暂无敌

| 参数 | 标签 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `time` | 无敌多久 | 0.8 | 0.05~10 s | — |
| `blink` | 无敌期间闪烁 | true | 开关 | 给玩家明确的视觉反馈 |

**运行时**：📋 无。

---

### 怎么说话 TALK

| 模块 | 参数（标签 / 默认 / 类型） | 运行时 |
|---|---|---|
| `talk.say` 说一句话 | `text`（说的话 / "……" / 文字）· `duration`（显示多久 / 2.5s）· `rise`（向上飘多远 / 12px） | 📋 无 —— 用 [`bwe.draw.text`](draw-audio-save.md#bwedrawtextx-y-text-opts--void) + `draw.world` |
| `talk.dialogue` 弹出对话框 | `script`（用哪段剧本 / SCRIPT）· `node`（从哪个节点开始）· `lockMove`（对话时锁住移动 / true）· `portrait`（说话人的头像 / ASSET） | 📋 无 |
| `talk.choice` 给玩家几个选项 | `q`（问什么 / "要买吗？"）· `options`（选项 / "买\|不买"，竖线分隔最多四个）· `results`（各自跳哪一段）· `cancelable`（允许按取消退出 / true） | 📋 无 |
| `talk.interact` 按键交谈 | `range`（多近才能交谈 / 48px）· `thenDo`（发生时做什么 / 文字）· `hintIcon`（提示图标 / ASSET） | 📋 无 —— 「按键交互」用 [`bwe.interact.*`](map-nav-interact-spawner.md#四bweinteract--交互) |

---

### 画面与声音 SHOW

| 模块 | 参数（标签 / 默认 / 类型） | 运行时 |
|---|---|---|
| `show.sfx` 播一段声音 | `asset`（播哪个音效 / ASSET）· `volume`（音量 / 1）· `positional`（离得远就小声 / true） | 📋 无 —— 用 [`bwe.audio.play`](draw-audio-save.md#bweaudioplayname-opts--number) |
| `show.bgm` 切换背景音乐 | `asset`（换哪首 / ASSET）· `fadeIn`（淡入时长 / 1.5s）· `loop`（循环播放 / true） | 📋 无 —— 用 [`bwe.audio.music`](draw-audio-save.md#bweaudiomusicname-opts--number) |
| `show.effect` 在它身上播特效 | `asset`（用哪个特效 / ASSET）· `scale`（大小 / 1）· `life`（持续多久 / 1s）· `follow`（跟着对象走 / true） | 📋 无 —— 用 [`e.attach`](entity.md#eattachopts--attachhandle)（子精灵） |
| `show.shake` 画面震动 | `strength`（抖多厉害 / 6px）· `time`（抖多久 / 0.22s）· `sfx`（同时播哪个音效 / ASSET） | 📋 无 —— 用 [`bwe.camera.shake`](input-camera-time.md#bwecamerashakestrength-duration--void) |
| `show.changeScene` 换到另一张地图 | `scene`（去哪张地图 / 文字）· `spawn`（落到哪个出生点 / OBJ）· `fade`（黑屏过渡 / 0.35s）· `keepBgm`（音乐不要断 / true） | 📋 无（运行时只加载第一个场景，**没有场景切换能力**） |
| `show.camera` 镜头跟着它 | `smooth`（跟随的柔和程度 / 0.15）· `lookAhead`（朝前多带一点 / 24px）· `clamp`（限制在地图内 / true） | ⚠ 部分 —— 读到 `smooth`（也认旧名 `smoothing`）、`lookAhead`、**`clampToMap`**；⚠ 模块定义的是 **`clamp`**，运行时读的是 **`clampToMap`** → **`clamp` 改了没用**（恒为 true）。旧 id `fx.cameraFollow` 也认。⚠ 调过任意 `bwe.camera.*` 控制方法后，本局模块相机**永久让位**给脚本 |

---

## 三、模块在运行时的完整生效清单

只有这 **7 个**模块 id 会被运行时读到：

| 模块 id（含旧别名） | 运行时读的参数 | 说明 |
|---|---|---|
| `move.locked` | （无） | 玩家移动直接跳过 |
| `move.patrol` | `axis`, `speed`, **`distance`** | 正弦往复（`range`/`wait` 无效） |
| `move.follow` | `speed`, **`stopDistance`** | 直线追玩家（`stopDist`/`seeRange`/`ignoreWalls` 无效） |
| `move.flee` | `speed`, **`range`** | 远离玩家（`fearRange`/`giveUp` 无效） |
| `move.wander` | `speed`, **`radius`** | 随机游荡（`area`/`pauseMin`/`pauseMax` 无效） |
| `fight.hp`（旧 `combat.health`） | **`maxHealth`**（回退 `hp`） | 只设初始血量上限 |
| `show.camera`（旧 `fx.cameraFollow`） | `smoothing`/`smooth`, `lookAhead`, **`clampToMap`** | 相机跟随（`clamp` 无效） |

另外**按模块 id 存在与否**（不读参数）就生效的 3 个：

| 模块 id（含旧别名） | 效果 |
|---|---|
| `look.blink`（旧 `render.blink`） | 每帧 alpha 正弦闪烁（固定频率/幅度） |
| `look.shadow`（旧 `render.shadow`） | 多画一个椭圆阴影（固定尺寸/alpha） |
| `move.locked` | 玩家不响应 WASD |

> 其余 30+ 个模块**运行时不执行** —— 它们目前是编辑器侧的「意图描述」，要靠 JS 脚本或引擎未来版本实现。

---

## 四、不在模块目录里、但运行时认的 id

运行时还有几个**模块目录里没有**的 id（编辑器旧版遗留 / 内置小游戏专用）：

| id | 运行时用途 |
|---|---|
| `move.player` / `move.speed` | 玩家自己写速度（`move.player` 优先，读 `speed` / `moveSpeed`） |
| `game.minesweeper` | 扫雷小游戏（读 `firstClickSafe` `rightClickFlag` `autoOpenZeros` `revealAllOnLose` `showTimer` `hiddenAsset` `mineAsset` `flagAsset`） |
| `game.dressup` | 换装控制器（读 `partTag` `allowReset`） |
| `game.dressPart` | 换装部件（读 `slot` `fallbackColor` `offsetX` `offsetY` `partScale` `optionAssets`） |
| `script.js` / `script` | 对象挂 JS 脚本（读 `script`；由 `ScriptEngine` 处理，不是运行时模块） |

**这些 id 不要写进用户工程** —— 目录里没有对应积木，Inspector 也点不出来。

---

## 五、怎么用 JS 代替这些模块

运行时没实现模块时，用脚本补是标准做法（这也是本引擎的设计意图：**模块给默认行为，脚本加额外逻辑**）：

| 你想做的事 | 模块（Inspector） | 等价的脚本写法 |
|---|---|---|
| 追玩家 | `move.follow`（部分生效） | `bwe.nav.find` + `bwe.nav.follow`，或自己改 `x/y` |
| 沿路线巡逻 | `move.path` | `bwe.nav.find` 逐点 + `onArrive` 链式调用 |
| 可推动 | `move.pushable` | `bwe.physics.body(e, { type: "dynamic" })` |
| 范围检测 | `sense.range` | `bwe.interact.nearest` 或 `bwe.dist` 自己算 |
| 看不见玩家 | `sense.lineOfSight` | `bwe.nav.lineOfSight` / `bwe.sense.canSee` |
| 被点击时做事 | `rule.click` | 对象脚本 `onClick`，或 `bwe.on("click", fn)` |
| 进出区域 | `rule.enterArea` | 用 `kind: "ZONE"` 对象 + `onEnter`/`onLeave` |
| 计时 | `rule.timer` | `bwe.after` / `bwe.every` |
| 近战 | `fight.melee` | 距离判定 + `e.damage(n)` |
| 发射子弹 | `fight.projectile` | `bwe.world.spawn` + `bwe.physics.throwAt` |
| 受击反馈 | `fight.damage` | `onDamage` 里 `bwe.camera.shake` + `e.setColor` + `bwe.audio.play` |
| 死亡表现 | `fight.die` | `onDeath` 里 spawn 掉落物 + `e.destroy()` |
| 短暂无敌 | `fight.invuln` | 脚本里记 `invulnUntil` 时间戳自己判 |
| 说一句话 | `talk.say` | `bwe.draw.world` + `bwe.draw.text`（世界空间气泡） |
| 播放音效 / BGM | `show.sfx` / `show.bgm` | `bwe.audio.play` / `bwe.audio.music` |
| 镜头跟随 | `show.camera` | `bwe.camera.follow(e, { smooth, lookAhead })` |
| 震屏 | `show.shake` | `bwe.camera.shake(strength, duration)` |

---

## 六、参数命名不一致汇总（改参数没反应时先看这张表）

这是运行时最容易让人困惑的地方 —— **模块定义的参数名和运行时读的名字不一样**，改了模块参数没效果：

| 模块 | 模块里的参数名 | 运行时读的名字 | 结果 |
|---|---|---|---|
| `move.follow` | `stopDist` | `stopDistance` | 改了没用（恒 48px） |
| `move.patrol` | `range` | `distance` | 改了没用（恒 96px） |
| `move.wander` | `area` | `radius` | 改了没用（恒 80px） |
| `move.flee` | `fearRange` | `range` | 改了没用（恒 240px） |
| `show.camera` | `clamp` | `clampToMap` | 改了没用（恒 true） |
| `fight.hp` | `hp` | `maxHealth` → 回退 `hp` | ✅ 生效（有回退） |

**其余读到的参数（`speed` / `axis` / `smooth` / `lookAhead`）名字一致，正常生效。**
