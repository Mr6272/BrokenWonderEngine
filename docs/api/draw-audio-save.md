# bwe.draw / bwe.audio / bwe.save — 绘制 · 音频 · 存档

> 本页覆盖：`bwe.draw`（立即模式绘制：HUD / 调试 / 世界内特效）、`bwe.audio`（音效与 BGM，WAV）、`bwe.save`（本地 JSON 存档与槽位）。
>
> 相关页：[input-camera-time](input-camera-time.md) · [emergence：物理调试绘制 / 场燃烧格](emergence.md) · [lifecycle：生命周期与 ctx](lifecycle.md) · [README：索引](README.md)

**Phase 说明**：`✅ 已实现` / `🧪 试验` / `📋 规划`。

---

## 一、bwe.draw — 立即模式绘制

## 1.1 先理解它怎么工作

`bwe.draw.*` 是**立即模式录制**：

1. 你在 `onUpdate`（或 `"draw"` 钩子）里调用 `bwe.draw.text(...)` —— 此时**只是把一条绘制指令塞进本帧的指令列表**，并没有真的画。
2. 帧末，宿主统一执行渲染：先 `glLoadIdentity()`，再逐条执行这些指令。
3. **每帧开始时会清空指令列表** —— 所以绘制必须每帧重新调用。写在 `onStart` 里的绘制调用只会显示一帧（通常看不到）。

**两个坐标空间**：
- 默认（**屏幕空间**）：左上原点、**逻辑像素**，适合 HUD / 调试信息。
- `bwe.draw.world(fn)` 里的调用（**世界空间**）：世界像素，会叠加视口变换，适合血条 / 地面标记 / 特效。

⚠ 所有 `bwe.draw.*` 只在脚本 `update` / `draw` 调用栈里有效。在 `bwe.after` 回调里也能用（回调也在 update 栈里），但在 `onSceneEnd` 里没意义（窗口已在关）。

---

### bwe.draw.text(x, y, text, opts?) → void

**签名**
`bwe.draw.text(x: number, y: number, text: string, opts?: TextOpts): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | X（屏幕或世界，取决于是否在 `draw.world` 里） |
| y | number | Y |
| text | string | 要画的文字（支持中文） |
| opts.size | number | 字号（像素），默认 16 |
| opts.color | string | 颜色，默认 `"#ffffff"` |
| opts.align | string | 对齐：`"left"`（默认）/ `"center"` / `"middle"` / `"right"` / `"end"` |
| opts.alpha | number | 透明度 0~1，默认 1 |
| opts.shadow | boolean | 是否画阴影，默认 `true` |

**返回**
`void`

**说明**
✅ 已实现。**录制时就渲染成图片纹理**（AWT 画字），再作为贴图绘制。
`align` 的语义：`"left"` 时 `x` 是**左边缘**；`"center"` / `"middle"` 时 `x` 是**中心**；`"right"` / `"end"` 时 `x` 是**右边缘**。`y` 永远是文字基线附近的顶部锚点，不是中心。
默认带阴影（无阴影版本更锐利但小字可能糊）。

**缓存**：文字纹理按「字号 + 颜色 + 阴影 + 内容」做 key 缓存，**有界 LRU（上限 256 条）** —— 每帧变化的数字不会无限吃显存，但**绘制大量不同文字**会频繁淘汰/重建（慢）。HUD 数字变慢一点、或把静态文字合成一张图，会更省。

**示例**
```js
// 屏幕空间 HUD
bwe.draw.text(8, 8, "HP " + Math.round(ctx.self.hp), { size: 18, color: "#ffffff" });
bwe.draw.text(8, 30, "无敌中", { size: 14, color: "#ffcc00", shadow: false });

// 居中标题
bwe.draw.text(640, 40, "第 1 关", { size: 32, align: "center", color: "#ffffff" });

// 世界空间（跟着实体）
bwe.draw.world(function () {
  bwe.draw.text(ctx.self.x, ctx.self.y - 36, ctx.self.name, { size: 12, align: "center" });
});
```

**另见**
[bwe.draw.measureText](#bwedrawmeasuretexttext-size--size) · [bwe.draw.world](#bwedrawworldfn--void)

---

### bwe.draw.rect(x, y, w, h, opts?) → void

**签名**
`bwe.draw.rect(x: number, y: number, w: number, h: number, opts?: RectDrawOpts): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 左上角 X |
| y | number | 左上角 Y |
| w | number | 宽 |
| h | number | 高 |
| opts.fill | string | 填充色。**整个 `opts` 省略时默认 `"#ffffff"`**；给了 `opts` 却没给 `fill` = **不填充**。传 `null` / `"transparent"` / `"none"` 也是不填充 |
| opts.stroke | string | 描边色；缺省不描边 |
| opts.width | number | 描边宽度，默认 1（`<= 0` 按 1） |
| opts.alpha | number | 透明度 0~1，默认 1 |
| opts.radius | number | 圆角半径（整数），默认 0 |

**返回**
`void`

**说明**
✅ 已实现。`x/y` 是**左上角**（不是中心）—— 与 `Entity` 的「中心点」约定不同，注意别看错。
⚠ 填充色的默认值有个容易踩的坑：**只有完全不传 `opts`（第 5 个参数）时才白底**；一旦传了 `{ stroke: ... }` 这种不含 `fill` 的对象，就变成「只描边不填充」。

**示例**
```js
// 半透明面板
bwe.draw.rect(20, 20, 200, 80, { fill: "#0a0f18", alpha: 0.75, radius: 8 });

// 只描边
bwe.draw.rect(20, 120, 200, 40, { stroke: "#ffffff", width: 2 });

// 只要填充不要边
bwe.draw.rect(240, 20, 10, 100, { fill: "red" });
```

**另见**
[bwe.draw.bar](#bwedrawbarx-y-w-h-pct-opts--void) · [颜色写法](#15-颜色怎么写)

---

### bwe.draw.line(x1, y1, x2, y2, opts?) → void

**签名**
`bwe.draw.line(x1: number, y1: number, x2: number, y2: number, opts?: LineDrawOpts): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x1, y1 | number | 起点 |
| x2, y2 | number | 终点 |
| opts.color | string | 颜色，默认 `"#ffffff"` |
| opts.width | number | 线宽，默认 1（`<= 0` 按 1） |
| opts.alpha | number | 透明度，默认 1 |

**返回**
`void`

**说明**
✅ 已实现。固定管线 `GL_LINES`，单像素宽度之外的表现取决于驱动。

**示例**
```js
// 瞄准线
var m = bwe.input.mouse;
bwe.draw.world(function () {
  bwe.draw.line(ctx.self.x, ctx.self.y, m.worldX, m.worldY, { color: "#ff5555", width: 2, alpha: 0.6 });
});
```

**另见**
[bwe.draw.circle](#bwedrawcirclex-y-r-opts--void)

---

### bwe.draw.circle(x, y, r, opts?) → void

**签名**
`bwe.draw.circle(x: number, y: number, r: number, opts?: CircleDrawOpts): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 圆心 X |
| y | number | 圆心 Y |
| r | number | 半径（像素） |
| opts.fill | string | 填充色。**整个 `opts` 省略时默认 `"#ffffff"`**；给了 `opts` 却没给 `fill` = **不填充**。传 `null` 也是不填充 |
| opts.stroke | string | 描边色；缺省不描边 |
| opts.width | number | 描边宽度，默认 1.5 |
| opts.alpha | number | 透明度，默认 1 |

**返回**
`void`

**说明**
✅ 已实现。用三角扇逼近圆（段数随半径缩放），不是真圆弧。
`x/y` 是**圆心**（和 rect 的左上角不同）。

**示例**
```js
// 范围圈
bwe.draw.world(function () {
  bwe.draw.circle(ctx.self.x, ctx.self.y, 120, { stroke: "#40e060", width: 2, alpha: 0.5 });
});

// 实心点
bwe.draw.circle(100, 100, 6, { fill: "#ff0000" });
```

**另见**
[bwe.draw.line](#bwedrawlinex1-y1-x2-y2-opts--void)

---

### bwe.draw.sprite(asset, x, y, opts?) → void

**签名**
`bwe.draw.sprite(asset: string, x: number, y: number, opts?: SpriteDrawOpts): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| asset | string | 素材名（`boot.json` 的 `assets[].name`） |
| x | number | 中心 X |
| y | number | 中心 Y |
| opts.w | number | 绘制宽，默认 0 = 素材宽 |
| opts.h | number | 绘制高，默认 0 = 素材高 |
| opts.alpha | number | 透明度 0~1，默认 1 |
| opts.tint | string | 染色（与素材**相乘**），缺省不染色 |
| opts.rotation | number | 旋转（度，顺时针），默认 0 |
| opts.frame | number | 帧下标（0 起），默认 0 |

**返回**
`void`

**说明**
✅ 已实现。和 `bwe.draw.text` 一样是**录制 + 帧末统一画**。素材不存在时这一条指令被**静默跳过**（`hit` 失败不报错）。
`x/y` 是**中心点**，和 `Entity` 一致（`rect` 是左上角，`circle` 是圆心 —— 三种约定都不同，务必看清）。
`w`/`h` 有一个为 0 时用素材原始尺寸。

**示例**
```js
// 屏幕空间画图标（左上原点）
bwe.draw.sprite("金币图标", 40, 40, { w: 24, h: 24 });

// 世界空间画地面标记，带旋转和染色
bwe.draw.world(function () {
  bwe.draw.sprite("瞄准圈", ctx.self.x, ctx.self.y, {
    w: 64, h: 64, tint: "#ff5555", alpha: 0.6, rotation: 0
  });
});
```

**另见**
[bwe.draw.text](#bwedrawtextx-y-text-opts--void) · [e.sprite](entity.md#espriteopts--void)（给实体换图，不是画一次）

---

### bwe.draw.bar(x, y, w, h, pct, opts?) → void

**签名**
`bwe.draw.bar(x: number, y: number, w: number, h: number, pct: number, opts?: BarDrawOpts): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| x | number | 左上角 X |
| y | number | 左上角 Y |
| w | number | 宽，默认 100 |
| h | number | 高，默认 8 |
| pct | number | 进度 0~1，默认 1（内部会钳制） |
| opts.bg | string | 底槽颜色；**缺省 `null` = 不画底槽** |
| opts.fg | string | 前景颜色；缺省 `null` = 不画前景 |
| opts.border | string | 边框颜色；缺省 `null` = 不画边框 |
| opts.alpha | number | 整体透明度，默认 1 |

**返回**
`void`

**说明**
✅ 已实现。血条 / 蓝条 / 经验条专用。`x/y` 是**左上角**。
⚠ `bg` / `fg` / `border` 全部缺省时**什么都不画** —— 至少给一个。

**示例**
```js
// 屏幕空间血条
bwe.draw.bar(8, 60, 180, 12, ctx.self.hp / ctx.self.hpMax,
  { bg: "#200808", fg: "#40e060", border: "#000000" });

// 世界空间头顶血条
bwe.draw.world(function () {
  bwe.draw.bar(ctx.self.x - 20, ctx.self.y - 30, 40, 5, 0.6,
    { bg: "#000000", fg: "#ffcc00" });
});
```

**另见**
[bwe.draw.rect](#bwedrawrectx-y-w-h-opts--void) · [e.hp](entity.md#ehp--number)

---

### bwe.draw.measureText(text, size?) → Size

**签名**
`bwe.draw.measureText(text: string, size?: number): { w: number; h: number }`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| text | string | 要量的文字 |
| size | number | 字号，默认 16（`<= 0` 按 16） |

**返回**
`{w, h}` — 逻辑像素尺寸（宽度按字体度量算，包含中文的全宽字符）

**说明**
✅ 已实现。渲染侧用 AWT `FontMetrics` 算，和真正画出来的尺寸一致（同一套字体）。**不触发纹理创建**，但第一次调用会加载字体（引擎初始化时已预热过，正常是热路径）。
用于居中排版：`x = 中心 - measured.w / 2`。

**示例**
```js
var m = bwe.draw.measureText("得分：1200", 20);
bwe.draw.text(640 - m.w / 2, 20, "得分：1200", { size: 20 });
```

**另见**
[bwe.draw.text](#bwedrawtextx-y-text-opts--void)

---

### bwe.draw.world(fn) → void

**签名**
`bwe.draw.world(fn: Function): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| fn | Function | 回调；**在回调内**所有 `bwe.draw.*` 都改用世界坐标 |

**返回**
`void`

**说明**
✅ 已实现。**即时**切换（不是延迟）：`fn` 里同步调用的 `bwe.draw.*` 都标成世界空间，回调返回后恢复屏幕空间。
可嵌套（内部用深度计数），但嵌套没有额外意义。
回调抛异常时深度计数仍然会正确回退（`finally` 保证）。

**示例**
```js
function onUpdate(ctx, dt) {
  // 屏幕空间
  bwe.draw.text(8, 8, "HP " + Math.round(ctx.self.hp));

  // 世界空间：跟着实体走的血条 + 名字
  bwe.draw.world(function () {
    bwe.draw.bar(ctx.self.x - 20, ctx.self.y - 30, 40, 5, ctx.self.hp / ctx.self.hpMax,
      { bg: "#000000", fg: "#40e060" });
    bwe.draw.text(ctx.self.x, ctx.self.y - 36, ctx.self.name, { size: 12, align: "center" });
  });

  // 回到屏幕空间（自动的）
  bwe.draw.text(8, 30, "调试信息");
}
```

**另见**
[bwe.camera.worldToScreen](#bwecameraworldtoscreenx-y--vec2)（手动换算的替代方案）

---

## 1.5 颜色怎么写

所有 `color` / `fill` / `stroke` / `bg` / `fg` / `border` / `tint` 参数都吃下面这套：

| 写法 | 例子 | 说明 |
|---|---|---|
| `#rrggbb` | `"#ff0000"` | 6 位十六进制 |
| `#rgb` | `"#f00"` | 3 位缩写（等价 `#ff0000`） |
| `#rrggbbaa` | `"#ff000080"` | 8 位带 alpha |
| 颜色名 | `"white"` `"black"` `"red"` `"green"` `"blue"` `"yellow"` `"gray"` / `"grey"` `"orange"` `"cyan"` `"magenta"` | 引擎内建映射表 |
| 透明 | `"transparent"` / `"none"` | 完全透明（= 不画） |
| 无法识别 | 其它字符串 | 回退到该参数的默认色（不报错） |

---

## 二、bwe.audio — 音频

> **只保证 WAV**。素材名走宿主的素材表（`assets[].name` → Build 内相对路径），也可以直接给相对 / 绝对文件路径。
> 文件缺失、无声卡、格式不支持 —— **任何失败都只写一条告警，绝不抛到游戏循环里**，返回值是 `-1`。

### bwe.audio.play(name, opts?) → number

**签名**
`bwe.audio.play(name: string, opts?: { volume?: number; loop?: boolean; pitch?: number }): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 素材名，或相对 / 绝对文件路径 |
| opts.volume | number | 音量 0~1，默认 1（会再乘全局音量） |
| opts.loop | boolean | 是否循环，默认 `false` |
| opts.pitch | number | 音高倍数（1 = 原调），默认 1；`<= 0` 按 1 |

**返回**
`number` — 播放句柄 id（从 1 递增）；失败返回 `-1`

**说明**
✅ 已实现。每次调用都新建一个 `javax.sound.sampled.Clip` —— **不要每帧调**，会耗尽音频资源。同一个音效重复播放会叠在一起（多个 id）。

**`pitch` 的确切语义（重要）**：

```
pitch: number — 音高倍数（1 = 原调）。实现是「改采样率」，所以时长也随之变化：
        pitch=2 ⇒ 音高升八度且时长减半；pitch=0.5 ⇒ 降八度且时长翻倍。
        这是音效变调的常见语义（不是「变速不变调」）。
        仅 PCM WAV 有效；非 PCM 编码会忽略。
```

技术实现：`Clip` 没有变调控制，所以做法是**保留原始 PCM 字节，只把标称采样率乘 `pitch`**（重打包 `AudioInputStream` 的 `format`）—— 播放器按新速率解释同一串样本，于是时长变成 `1/pitch`、音高变成 `pitch` 倍。
⚠ **不是**「用 `AudioSystem.getAudioInputStream(dstFormat, in)` 去重采样」那条路：那样做流速会变，但 `Clip` 时长**仍是原长** —— 因为是按时间轴插值，频率成分原样保留，音高根本没变（这是本项目实现时踩过的假实现）。
`pitch` 缺失或 ≈1 时走**原始 Clip 快路径**，零额外开销。

**示例**
```js
// 受击随机音高（经典游戏音效手感）
var p = 0.85 + bwe.random(0, 0.3);      // 0.85 ~ 1.15
bwe.audio.play("受击", { volume: 0.8, pitch: p });

// 固定变调
bwe.audio.play("提示", { pitch: 1.5 });   // 变尖、时长 2/3
bwe.audio.play("提示", { pitch: 0.5 });   // 变沉、时长翻倍

// 失败要判
var id = bwe.audio.play("开箱", { volume: 0.8 });
if (id < 0) { bwe.log("开箱音效不可用"); }

// 循环的环境音（留着 id 以便停掉）
var ambienceId = bwe.audio.play("风声", { volume: 0.4, loop: true });
```

**另见**
[bwe.audio.stop](#bweaudiostopidorname--void) · [bwe.audio.music](#bweaudiomusicname-opts--number) · [bwe.audio.volume](#bweaudiovolumev--void)

---

### bwe.audio.stop(idOrName) → void

**签名**
`bwe.audio.stop(idOrName: number | string): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| idOrName | `number \| string` | 数字 = `play` 返回的 id；字符串 = 素材名（停掉**所有**该名字的实例） |

**返回**
`void`

**说明**
✅ 已实现。停掉并 `close()` clip。传不存在的 id / 名字是空操作。
传字符串时按**当初传给 `play` 的那个 name** 匹配（不是解析后的文件路径）。

**示例**
```js
bwe.audio.stop(ambienceId);          // 按 id
bwe.audio.stop("开箱");              // 按名字，停掉所有同名实例
```

**另见**
[bwe.audio.play](#bweaudioplayname-opts--number)

---

### bwe.audio.music(name, opts?) → number

**签名**
`bwe.audio.music(name: string, opts?: { volume?: number; loop?: boolean }): number`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| name | string | 素材名或文件路径 |
| opts.volume | number | 音量 0~1，默认 1 |
| opts.loop | boolean | 是否循环，**默认 `true`**（注意和 `play` 相反） |

**返回**
`number` — 新 id；失败返回 `-1`

**说明**
✅ 已实现。**同一时刻只有一首 BGM**：调 `music` 会自动停掉之前那首（先 `stop(musicId)` 再播新的）。
**但重复调同一首会重新从头播**（没有「同一首不重启」的判断）—— 想避免请自己记状态。

**示例**
```js
function onSceneStart(ctx) {
  bwe.audio.music("主旋律", { volume: 0.5 });
}

function onSceneEnd(ctx) {
  // 收尾时想静音
  bwe.audio.stop(bwe.audio.music("静音占位", { volume: 0 }));  // ✗ 别这样，见下
}
```

> 上面的反例只是提醒：`music()` **总是**返回新 id 并替换当前 BGM。想停 BGM 请存下 `music()` 的返回值再 `stop` 它：
> ```js
> var bgmId = bwe.audio.music("主旋律", { volume: 0.5 });
> // 之后
> bwe.audio.stop(bgmId);
> ```

**另见**
[bwe.audio.play](#bweaudioplayname-opts--number) · [bwe.audio.stop](#bweaudiostopidorname--void)

---

### bwe.audio.volume(v) → void

**签名**
`bwe.audio.volume(v: number): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| v | number | 全局音量 0~1（自动钳制） |

**返回**
`void`

**说明**
✅ 已实现。设置全局音量并**立刻重算所有正在播的 clip 的 gain**（`play` 时各自的 volume 与全局音量是乘法关系）。

**示例**
```js
bwe.audio.volume(0);        // 静音
bwe.audio.volume(0.8);      // 正常
```

**另见**
[bwe.audio.play](#bweaudioplayname-opts--number)

---

## 三、bwe.save — 本地 JSON 存档

> 内存里是一棵 JSON 值树。`write(slot)` 落盘到 **`<Build 的父目录>/saves/<slot>.json`**；该目录不可写时退回 **`~/.bwe/saves/`**。
> 只接受 JSON 值（字符串 / 数字 / 布尔 / null / 数组 / 对象）。**函数存不进去**（会被忽略并写一次告警）。

### bwe.save.set(k, v) → void

**签名**
`bwe.save.set(k: string, v: unknown): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| k | string | 键；空字符串是空操作 |
| v | unknown | 任意 JSON 值 |

**返回**
`void`

**说明**
✅ 已实现。写入**内存**（不会立刻落盘，除非你调 `flush` / `write`）。
值的转换规则：数字统一存成 `double`；数组存成数组；对象存成对象；布尔 / 字符串原样；函数**抛错被捕获**并写一次告警。

**示例**
```js
bwe.save.set("level", 3);
bwe.save.set("playerPos", { x: ctx.self.x, y: ctx.self.y });
bwe.save.set("visited", ["哨站", "洞穴"]);
```

**另见**
[bwe.save.get](#bwesavegetk-def--unknown) · [bwe.save.flush](#bwesaveflush--boolean)

---

### bwe.save.get(k, def?) → unknown

**签名**
`bwe.save.get(k: string, def?: unknown): unknown`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| k | string | 键 |
| def | unknown | 键不存在时的返回值，默认 `undefined` |

**返回**
`unknown` — 存的值（数字已还原成 JS number，数组 / 对象已还原成 JS 结构）

**说明**
✅ 已实现。返回的是**新构造的 JS 值**（不是内部引用）—— 改它不会影响存档。

**示例**
```js
var level = bwe.save.get("level", 1);
var pos = bwe.save.get("playerPos", { x: 64, y: 64 });
bwe.log("从第 " + level + " 关开始，位置 " + pos.x + "," + pos.y);
```

**另见**
[bwe.save.set](#bwesavesetk-v--void) · [bwe.save.has](#bwesavehask--boolean)

---

### bwe.save.has(k) → boolean

**签名**
`bwe.save.has(k: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| k | string | 键 |

**返回**
`boolean`

**说明**
✅ 已实现。只看**内存里**有没有这个键（不会去磁盘探测）。想探测槽位文件请用 `exists(slot)`。

**示例**
```js
if (bwe.save.has("firstRun")) {
  bwe.log("不是第一次玩");
} else {
  bwe.save.set("firstRun", true);
}
```

**另见**
[bwe.save.exists](#bwesaveexistsslot--boolean) · [bwe.save.read](#bwesavereadslot--boolean)

---

### bwe.save.remove(k) → void

**签名**
`bwe.save.remove(k: string): void`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| k | string | 键 |

**返回**
`void`

**说明**
✅ 已实现。只删内存里的键，不落盘。不存在也是空操作。

**示例**
```js
bwe.save.remove("临时数据");
```

**另见**
[bwe.save.clear](#bwesaveclear--void)

---

### bwe.save.clear() → void

**签名**
`bwe.save.clear(): void`

**参数**
无

**返回**
`void`

**说明**
✅ 已实现。清空**内存里**的全部键。**不删磁盘文件** —— 想真正清掉槽位，清空后再 `write(slot)` 覆盖，或 `delete(slot)`。

**示例**
```js
bwe.save.clear();
bwe.save.write("auto");     // 把空存档写回去 = 相当于重置存档
```

**另见**
[bwe.save.delete](#bwesavedeleteslot--boolean)

---

### bwe.save.flush() → boolean

**签名**
`bwe.save.flush(): boolean`

**参数**
无

**返回**
`boolean` — 是否写成功

**说明**
✅ 已实现。等价于 `bwe.save.write("auto")` —— 落盘到 `auto` 槽位。
⚠ **不会自动落盘**：引擎没有「定时自动写盘」的机制，别指望不调它也能保住数据。收尾时（[`onSceneEnd`](lifecycle.md#onsceneendctx--void)）记得调一次。

**示例**
```js
function onSceneEnd(ctx) {
  bwe.save.set("lastScore", G.score);
  if (!bwe.save.flush()) {
    bwe.log("存档写入失败");
  }
}
```

**另见**
[bwe.save.write](#bwesavewriteslot--boolean) · [onSceneEnd](lifecycle.md#onsceneendctx--void)

---

### bwe.save.write(slot?) → boolean

**签名**
`bwe.save.write(slot?: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| slot | string | 槽位名，默认 `"auto"`；空字符串也按 `"auto"` |

**返回**
`boolean` — 是否写成功

**说明**
✅ 已实现。槽位名会被清洗：`\ / : * ? " < > |` 和空白字符都替换成 `_`，自动补 `.json` 后缀。
写文件用 UTF-8 + 缩进格式（`GsonBuilder().setPrettyPrinting()`），方便用户看。

**示例**
```js
bwe.save.write("slot1");
bwe.save.write();          // → auto.json
```

**另见**
[bwe.save.read](#bwesavereadslot--boolean) · [bwe.save.exists](#bwesaveexistsslot--boolean)

---

### bwe.save.read(slot?) → boolean

**签名**
`bwe.save.read(slot?: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| slot | string | 槽位名，默认 `"auto"` |

**返回**
`boolean` — 是否读成功（文件不存在 / 解析失败返回 `false`）

**说明**
✅ 已实现。**读会整体替换内存里的值**（先 `clear()` 再填），不是合并。读失败时内存保持原样（不变空）。
⚠ `read` 之后 `has(k)` 才会反映文件内容 —— 但在调用 `read` 之前，**引擎不会自动读盘**。开局要在 `onSceneStart` 里自己 `read`。

**示例**
```js
function onSceneStart(ctx) {
  if (bwe.save.read("slot1")) {
    bwe.log("读档成功，关卡 = " + bwe.save.get("level", 1));
  } else {
    bwe.log("没有存档，从头开始");
  }
}
```

**另见**
[bwe.save.write](#bwesavewriteslot--boolean) · [bwe.save.exists](#bwesaveexistsslot--boolean)

---

### bwe.save.exists(slot?) → boolean

**签名**
`bwe.save.exists(slot?: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| slot | string | 槽位名，默认 `"auto"` |

**返回**
`boolean` — 槽位文件是否存在

**说明**
✅ 已实现。探测**磁盘文件**（`isFile()`），不读内容、不改内存。

**示例**
```js
if (bwe.save.exists("slot1")) {
  bwe.draw.text(8, 60, "有存档");
}
```

**另见**
[bwe.save.read](#bwesavereadslot--boolean) · [bwe.save.delete](#bwesavedeleteslot--boolean)

---

### bwe.save.delete(slot?) → boolean

**签名**
`bwe.save.delete(slot?: string): boolean`

**参数**
| 名称 | 类型 | 说明 |
|---|---|---|
| slot | string | 槽位名，默认 `"auto"` |

**返回**
`boolean` — 是否删掉了文件（不存在 / 删除失败返回 `false`）

**说明**
✅ 已实现。只删**磁盘文件**，不动内存里的值。

**示例**
```js
if (bwe.save.delete("slot1")) {
  bwe.log("存档已删除");
}
```

**另见**
[bwe.save.exists](#bwesaveexistsslot--boolean) · [bwe.save.clear](#bwesaveclear--void)

---

## 四、组合示例：完整的 HUD + 音效 + 存档

```js
var G = { score: 0, best: 0 };

function onSceneStart(ctx) {
  if (bwe.save.read("auto")) {
    G.best = bwe.save.get("best", 0);
  }
  bwe.on("draw", function () {
    // 屏幕空间 HUD
    bwe.draw.rect(6, 6, 220, 56, { fill: "#000000", alpha: 0.55, radius: 6 });
    bwe.draw.text(14, 12, "得分 " + G.score, { size: 18, color: "#ffffff" });
    bwe.draw.text(14, 36, "最高 " + G.best, { size: 14, color: "#9fb0c8" });
    bwe.draw.bar(14, 52, 200, 6, G.score / 100, { bg: "#222222", fg: "#ffcc00" });
  });
}

function onClick(ctx) {
  G.score += 10;
  bwe.audio.play("得分", { volume: 0.6 });
  if (G.score > G.best) { G.best = G.score; }
}

function onSceneEnd(ctx) {
  bwe.save.set("best", G.best);
  bwe.save.flush();
}
```

---

## 五、边界与陷阱

| 情况 | 行为 |
|---|---|
| `bwe.draw.*` 写在 `onStart` 里 | 只显示**一帧**（每帧清空指令）；要用 `"draw"` 钩子或每帧重调 |
| `bwe.draw.rect` 的 `x/y` | **左上角** |
| `bwe.draw.circle` 的 `x/y` | **圆心** |
| `bwe.draw.sprite` 的 `x/y` | **中心点** |
| `bwe.draw.bar` 的 `x/y` | **左上角** |
| `bwe.draw.bar` 三个颜色都不给 | **什么都不画** |
| 素材不存在（`draw.sprite`） | 该条指令静默跳过 |
| 文字纹理 | 有界 LRU **256 条**；大量不同文字会频繁重建（慢但不泄漏） |
| `bwe.audio.play` 每帧调 | ⚠ 会不断新建 clip，最终耗尽音频资源 —— 峰值应该用对象池或限流 |
| `bwe.audio.play` 的 `pitch` | ✅ 已实现（改采样率）；**仅 PCM WAV 有效**，非 PCM 编码忽略；**时长随 pitch 反比变化** |
| 音频文件格式 | **只保证 WAV**；其它格式能否读取决于 JDK 解码能力，读不了只告警 |
| 音频失败 | 只写一条日志（同名只报一次），返回 `-1`，不崩 |
| `bwe.audio.music` 重复同一首 | **会重新从头播**（不判断「是否已在播」） |
| `bwe.save` 不调 `flush`/`write` | **数据不会落盘**（引擎不会自动存盘） |
| `bwe.save.read` | **整体替换**内存（先 clear 再填），不是合并 |
| `bwe.save.set(k, 函数)` | 函数存不进去，值被丢弃并写一次告警 |
| 存档路径 | `<Build 父目录>/saves/<slot>.json`，不可写时退回 `~/.bwe/saves/` |
| 槽位名非法字符 | 自动替换成 `_`，并补 `.json` |
