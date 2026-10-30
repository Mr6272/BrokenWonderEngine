# BWE Scripting API

> **BrokenWonderEngine** 的 JS 脚本 API 参考。体例仿 Unity Scripting API：每个成员一节，固定顺序为「签名 → 参数 → 返回 → 说明 → 示例 → 另见」。
>
> 运行时：Rhino 1.7.15，执行 **ES5**。`bwe` 全局对象**完全由 Java 侧 Scriptable 实现**，没有 JS 预置脚本。
> 所有示例都是可以直接跑的 ES5（`var` / `function`，不用 `let` / `const` / 箭头函数 / 可选链）。

## 从这里开始

| 你想… | 看这一页 |
|---|---|
| 知道脚本什么时候被调用、`ctx` 里有什么 | [lifecycle：生命周期与 ctx](lifecycle.md) |
| 查找 / 生成 / 销毁实体 | [world：世界](world.md) |
| 读或改一个对象的属性（位置、标签、模块、血量） | [entity：Entity](entity.md) |
| 复用模板、做对象池 | [prefab：预制体与对象池](prefab.md) |
| 处理键盘鼠标、相机、时间 | [input-camera-time](input-camera-time.md) |
| 画 HUD、放音效、存档 | [draw-audio-save](draw-audio-save.md) |
| 网格、瓦片地图、A* 寻路、交互、刷怪 | [map-nav-interact-spawner](map-nav-interact-spawner.md) |
| 材质 / 火水烟 / 感知 AI / 物理 / 确定性随机 | [emergence：涌现式模拟基底](emergence.md) |
| 场景切换 / 多楼层空间 / 碰撞与触发 | [scene](scene.md) · [spatial](spatial.md) · [collision](collision.md) |
| 可配置改键 / 路网车辆 / 战斗 / 调试绘制 | [actions](actions.md) · [road](road.md) · [vehicle](vehicle.md) · [combat](combat.md) · [debug](debug.md) |
| 编辑器里那些「积木」分别做什么 | [modules：可视化模块目录](modules.md) |

## Phase 说明

本套文档每个 API 都标了阶段：

| 标记 | 含义 |
|---|---|
| ✅ 已实现 | 代码里真实存在并且有行为 |
| 🧪 试验 | 有实现，但语义可能变（例如只记忆状态、引擎不执行） |
| 📋 规划 | **尚未实现**。调用可能不报错，但没有实际效果（占位） |

> 事实来源优先级：`ScriptApi.java` / `ScriptEngine.java` / `ScriptWorld.java` / `ScriptPrefab.java` / `ScriptRender.java` / `ScriptFields.java` / `ScriptAi.java` / `ScriptPhysics.java`（**代码是唯一权威**）> `bwe.d.ts`。
> `bwe.d.ts` 与实现不一致的地方记在 [docs/_fragments/doc-inconsistency.md](../_fragments/doc-inconsistency.md)。

---

## 命名空间总览

### 1. 生命周期 Lifecycle — [lifecycle.md](lifecycle.md)

运行时按事件调用脚本里的同名函数。

| 成员 | 说明 | Phase |
|---|---|---|
| [`onStart(ctx)`](lifecycle.md#onstartctx--void) | 对象生成时一次 | ✅ 已实现 |
| [`onUpdate(ctx, dt)`](lifecycle.md#onupdatectx-dt--void) | 每帧（未暂停时） | ✅ 已实现 |
| [`onClick(ctx)`](lifecycle.md#onclickctx--void) | 鼠标点中本对象 | ✅ 已实现 |
| [`onEnter(ctx, other)`](lifecycle.md#onenterctx-other--void) | 玩家进入（**仅 ZONE**） | ✅ 已实现 |
| [`onLeave(ctx, other)`](lifecycle.md#onleavectx-other--void) | 玩家离开（**仅 ZONE**） | ✅ 已实现 |
| [`onInteract(ctx, actor)`](lifecycle.md#oninteractctx-actor--void) | 玩家按键交互 | ✅ 已实现 |
| [`onDamage(ctx, amount, from)`](lifecycle.md#ondamagectx-amount-from--void) | 受击 | ✅ 已实现 |
| [`onDeath(ctx, by)`](lifecycle.md#ondeathctx-by--void) | 血量归零 | ✅ 已实现 |
| [`onDestroy(ctx)`](lifecycle.md#ondestroyctx--void) | 销毁前 | ✅ 已实现 |
| [`onKey(ctx, key)`](lifecycle.md#onkeyctx-key--void) | 任意键按下 | ✅ 已实现 |
| [`onSceneStart(ctx)`](lifecycle.md#onscenestartctx--void) | 场景脚本：开局一次 | ✅ 已实现 |
| [`onSceneEnd(ctx)`](lifecycle.md#onsceneendctx--void) | 场景脚本：运行时关闭一次 | ✅ 已实现 |

### 2. 世界 world — [world.md](world.md)

| 成员 | 说明 | Phase |
|---|---|---|
| [`bwe.world.mapSize()`](world.md#bweworldmapsize--w-h) | 地图尺寸（像素） | ✅ 已实现 |
| [`bwe.world.tileSize()`](world.md#bweworldtilesize--number) | 每格像素 | ✅ 已实现 |
| [`bwe.world.scene`](world.md#bweworldscene--sceneinfo) | 场景信息 | ✅ 已实现 |
| [`bwe.world.find(q)`](world.md#bweworldfindq--entity--null) | 找第一个匹配 | ✅ 已实现 |
| [`bwe.world.findAll(q)`](world.md#bweworldfindallq--entity) | 找全部匹配 | ✅ 已实现 |
| [`bwe.world.entities()`](world.md#bweworldentities--entity) | 所有存活实体 | ✅ 已实现 |
| [`bwe.world.spawn(opts)`](world.md#bweworldspawnopts--entity--null) | 生成实体（唯一生成入口） | ✅ 已实现 |
| [`bwe.world.spawnMany(list)`](world.md#bweworldspawnmanylist--entity) | 批量生成 | ✅ 已实现 |
| [`bwe.world.spawnAt(opts, x, y)`](world.md#bweworldspawnatopts-x-y--entity--null) | 便捷生成 | ✅ 已实现 |
| [`bwe.world.clone(e, opts?)`](world.md#bweworldclonee-opts--entity--null) | 复制实体 | ✅ 已实现 |
| [`bwe.world.destroy(e)`](world.md#bweworlddestroye--void) | 销毁 | ✅ 已实现 |
| [`bwe.world.clear()`](world.md#bweworldclear--void) | 清空（含场景原生对象） | ✅ 已实现 |
| [`bwe.world.clearTag(tag)`](world.md#bweworldcleartagtag--void) | 按标签清 | ✅ 已实现 |
| [`bwe.world.destroyAll(filter?)`](world.md#bweworlddestroyallfilter--number) | 批量销毁，返回数量 | ✅ 已实现 |
| [`bwe.world.count(q?)`](world.md#bweworldcountq--number) | 计数 | ✅ 已实现 |
| [`bwe.world.each(q, fn)`](world.md#bweworldeachq-fn--void) | 遍历（快照迭代） | ✅ 已实现 |
| [`bwe.world.paused`](world.md#bweworldpaused--boolean) | 暂停 | ✅ 已实现 |
| [`bwe.world.timeScale`](world.md#bweworldtimescale--number) | 时间缩放 | ✅ 已实现 |
| [`bwe.world.on(name, fn)`](world.md#bweworldonname-fn--void) | 自定义事件：注册 | ✅ 已实现 |
| [`bwe.world.off(name, fn)`](world.md#bweworldoffname-fn--void) | 自定义事件：取消 | ✅ 已实现 |
| [`bwe.world.emit(name, payload)`](world.md#bweworldemitname-payload--void) | 自定义事件：派发 | ✅ 已实现 |
| [`bwe.world.layers()`](world.md#bweworldlayers--layer) | 场景图层表（旧 Build 返回 `[]`） | ✅ 已实现 |

### 3. 实体 Entity — [entity.md](entity.md)

| 成员 | 说明 | Phase |
|---|---|---|
| [`e.id`](entity.md#eid--string) | 唯一 id（只读） | ✅ 已实现 |
| [`e.name`](entity.md#ename--string) | 对象名（可读写） | ✅ 已实现 |
| [`e.kind`](entity.md#ekind--string) | 对象大类 | ✅ 已实现 |
| [`e.alive`](entity.md#ealive--boolean) | 是否存活（只读） | ✅ 已实现 |
| [`e.x` / `e.y`](entity.md#ex--ey--number) | 位置（写 = 瞬移） | ✅ 已实现 |
| [`e.pos`](entity.md#epos--vec2) | 位置快照（只读） | ✅ 已实现 |
| [`e.setPos(x, y)`](entity.md#esetposx-y--void) | 设置位置 | ✅ 已实现 |
| [`e.rotation`](entity.md#erotation--number) | 旋转（度，顺时针） | ✅ 已实现 |
| [`e.scaleX` / `e.scaleY`](entity.md#escalex--escaley--number) | 缩放 | ✅ 已实现 |
| [`e.visible`](entity.md#evisible--boolean) | 可见 / 可点中 | ✅ 已实现 |
| [`e.z`](entity.md#ez--number) | 排序层级 | ✅ 已实现 |
| [`e.layer`](entity.md#elayer--number) | 图层（排序优先于 z） | ✅ 已实现 |
| [`e.locked`](entity.md#elocked--boolean) | 锁定标记（引擎不执行） | 🧪 试验 |
| [`e.size`](entity.md#esize--size) | 读=绘制尺寸，写=setSize | ✅ 已实现 |
| [`e.setSize(w, h)`](entity.md#esetsizew-h--void) | 设置尺寸（= halfW*2） | ✅ 已实现 |
| [`e.asset`](entity.md#easset--string) | 素材名（只换图） | ✅ 已实现 |
| [`e.animMode`](entity.md#eanimmode--string) | 动画模式 | ✅ 已实现 |
| [`e.animFps`](entity.md#eanimfps--number) | 帧率（写会解帧锁） | ✅ 已实现 |
| [`e.sprite(opts)`](entity.md#espriteopts--void) | 一次设素材+帧+fps+模式 | ✅ 已实现 |
| [`e.play(assetName)`](entity.md#eplayassetname--void) | 换素材并重置播放 | ✅ 已实现 |
| [`e.setFrame(i)`](entity.md#esetframei--void) | 冻结到第 i 帧 | ✅ 已实现 |
| [`e.hasModule(id)`](entity.md#ehasmoduleid--boolean) | 有没有挂模块 | ✅ 已实现 |
| [`e.module(id)`](entity.md#emoduleid--moduleinstance--null) | 取模块实例（读写参数） | ✅ 已实现 |
| [`e.modules()`](entity.md#emodules--moduleinstance) | 所有模块 | ✅ 已实现 |
| [`e.addModule(def, params, when?)`](entity.md#eaddmoduledef-params-when--boolean) | 追加 / 合并模块 | ✅ 已实现 |
| [`e.removeModule(def)`](entity.md#eremovemoduledef--boolean) | 移除模块 | ✅ 已实现 |
| [`e.prop(key, def?)`](entity.md#epropkey-def--unknown) | 读 props（按 def 转型） | ✅ 已实现 |
| [`e.setProp(key, val)`](entity.md#esetpropkey-val--void) | 写 props | ✅ 已实现 |
| [`e.props()`](entity.md#eprops--recordstring-string) | 全部 props 快照 | ✅ 已实现 |
| [`e.setProps(obj)`](entity.md#esetpropsobj--void) | 批量写 props（合并） | ✅ 已实现 |
| [`e.tags`](entity.md#etags--tags) | 标签快照（带 `has`） | ✅ 已实现 |
| [`e.addTag(tag)`](entity.md#eaddtagtag--boolean) | 加标签 | ✅ 已实现 |
| [`e.removeTag(tag)`](entity.md#eremovetagtag--boolean) | 删标签 | ✅ 已实现 |
| [`e.hasTag(tag)`](entity.md#ehastagtag--boolean) | 查标签 | ✅ 已实现 |
| [`e.setTags(tags)`](entity.md#esettagstags--void) | 整体替换标签 | ✅ 已实现 |
| [`e.parent`](entity.md#eparent--entity--null) | 父级（脚本层） | ✅ 已实现 |
| [`e.children()`](entity.md#echildren--entity) | 直接子级 | ✅ 已实现 |
| [`e.setColor(r,g,b,a?)`](entity.md#esetcolorr-g-b-a--void) | 染色（0~1 或 0~255） | ✅ 已实现 |
| [`e.setAlpha(a)`](entity.md#esetalphaa--void) | 只改透明度 | ✅ 已实现 |
| [`e.clearColor()`](entity.md#eclearcolor--void) | 清除染色 | ✅ 已实现 |
| [`e.color`](entity.md#ecolor--r-g-b-a) | 染色快照 | ✅ 已实现 |
| [`e.attach(opts)`](entity.md#eattachopts--attachhandle) | 挂子精灵 → 句柄 | ✅ 已实现 |
| [`e.detach(handle)`](entity.md#edetachhandle--void) | 摘子精灵 | ✅ 已实现 |
| [`e.distanceTo(other)`](entity.md#edistancetoother--number) | 距离（像素） | ✅ 已实现 |
| [`e.angleTo(other)`](entity.md#eangletoother--number) | 角度（度） | ✅ 已实现 |
| [`e.on(name, fn)`](entity.md#eonname-fn--void) | 实体事件 | ✅ 已实现 |
| [`e.hp` / `e.hpMax`](entity.md#ehp--number) | 血量 | ✅ 已实现 |
| [`e.damage(n)`](entity.md#edamagen--number) | 扣血（走完整受击流程） | ✅ 已实现 |
| [`e.heal(n)`](entity.md#ehealn--number) | 回血 | ✅ 已实现 |
| [`e.destroy()`](entity.md#edestroy--void) | 销毁自己 | ✅ 已实现 |

### 4. 预制体 prefab / pool — [prefab.md](prefab.md)

| 成员 | 说明 | Phase |
|---|---|---|
| [`bwe.prefab.define(name, spec)`](prefab.md#bweprefabdefinename-spec--boolean) | 注册模板 | ✅ 已实现 |
| [`bwe.prefab.get(name)`](prefab.md#bweprefabgetname--prefabspec--null) | 读模板深拷贝 | ✅ 已实现 |
| [`bwe.prefab.list()`](prefab.md#bweprefablist--string) | 所有模板名 | ✅ 已实现 |
| [`bwe.prefab.has(name)`](prefab.md#bweprefabhasname--boolean) | 有没有模板 | ✅ 已实现 |
| [`bwe.prefab.remove(name)`](prefab.md#bweprefabremovename--boolean) | 移除模板 | ✅ 已实现 |
| [`bwe.prefab.spawn(name, opts)`](prefab.md#bweprefabspawnname-opts--entity--null) | 实例化 | ✅ 已实现 |
| [`bwe.prefab.spawnMany(name, opts)`](prefab.md#bweprefabspawnmanyname-optslist--entity) | 批量实例化 | ✅ 已实现 |
| [`bwe.prefab.count(name)`](prefab.md#bweprefabcountname--number) | 存活实例数 | ✅ 已实现 |
| [`bwe.prefab.fromEntity(e, name?)`](prefab.md#bweprefabfromentitye-name--string--null) | 场上对象 → 模板 | ✅ 已实现 |
| [`bwe.pool.create(name, size, opts?)`](prefab.md#bwepoolcreateprefabname-capacity-opts--number) | 建池 | ✅ 已实现 |
| [`bwe.pool.acquire(handle, x, y)`](prefab.md#bwepoolacquirehandle-x-y--entity--null) | 取实例 | ✅ 已实现 |
| [`bwe.pool.release(handle, e)`](prefab.md#bwepoolreleasehandle-e--boolean) | 归还 | ✅ 已实现 |
| [`bwe.pool.stats(handle)`](prefab.md#bwepoolstatshandle--poolstats--null) | 池统计 | ✅ 已实现 |

### 5. 输入 / 相机 / 时间 — [input-camera-time.md](input-camera-time.md)

| 成员 | 说明 | Phase |
|---|---|---|
| [`bwe.input.down(key)`](input-camera-time.md#bweinputdownkey--boolean) | 当前按住 | ✅ 已实现 |
| [`bwe.input.pressed(key)`](input-camera-time.md#bweinputpressedkey--boolean) | 本帧按下 | ✅ 已实现 |
| [`bwe.input.released(key)`](input-camera-time.md#bweinputreleasedkey--boolean) | 本帧抬起 | ✅ 已实现 |
| [`bwe.input.axis()`](input-camera-time.md#bweinputaxis--vec2) | WASD / 方向键轴 | ✅ 已实现 |
| [`bwe.input.mouse`](input-camera-time.md#bweinputmouse--mousestate) | 鼠标状态 | ✅ 已实现 |
| [`bwe.input.cursor(visible)`](input-camera-time.md#bweinputcursorvisible--void) | 光标显隐（真改系统光标） | ✅ 已实现 |
| [`bwe.camera.follow(e, opts)`](input-camera-time.md#bwecamerafollowe-opts--void) | 跟随实体 | ✅ 已实现 |
| [`bwe.camera.pos`](input-camera-time.md#bwecamerapos--vec2) | 相机中心 | ✅ 已实现 |
| [`bwe.camera.setPos(x, y)`](input-camera-time.md#bwecamerasetposx-y--void) | 摆相机 | ✅ 已实现 |
| [`bwe.camera.zoom` / `setZoom(z)`](input-camera-time.md#bwecamerazoom--number) | 缩放 | ✅ 已实现 |
| [`bwe.camera.shake(strength, duration)`](input-camera-time.md#bwecamerashakestrength-duration--void) | 抖动 | ✅ 已实现 |
| [`bwe.camera.bounds(rect)`](input-camera-time.md#bwecameraboundsrect--void) | 限制范围 | ✅ 已实现 |
| [`bwe.camera.worldToScreen(x, y)`](input-camera-time.md#bwecameraworldtoscreenx-y--vec2) | 世界 → 屏幕 | ✅ 已实现 |
| [`bwe.camera.screenToWorld(x, y)`](input-camera-time.md#bwecamerascreentoworldx-y--vec2) | 屏幕 → 世界 | ✅ 已实现 |
| [`bwe.camera.setFit(mode)`](input-camera-time.md#bwecamerasetfitmode--void) | contain / cover | ✅ 已实现 |
| [`bwe.time.now`](input-camera-time.md#bwetimenow--number) | 已运行秒数 | ✅ 已实现 |
| [`bwe.time.dt`](input-camera-time.md#bwetimedt--number) | 本帧步长 | ✅ 已实现 |
| [`bwe.time.frame`](input-camera-time.md#bwetimeframe--number) | 已运行帧数 | ✅ 已实现 |
| [`bwe.after(sec, fn)`](lifecycle.md#bweaftersec-fn--number) | 延时一次 | ✅ 已实现 |
| [`bwe.every(sec, fn, opts?)`](lifecycle.md#bweeverysec-fn-opts--number) | 定时重复 | ✅ 已实现 |
| [`bwe.cancel(id)`](lifecycle.md#bwecancelid--void) | 取消定时器 | ✅ 已实现 |

### 6. 绘制 / 音频 / 存档 — [draw-audio-save.md](draw-audio-save.md)

| 成员 | 说明 | Phase |
|---|---|---|
| [`bwe.draw.text(x, y, text, opts)`](draw-audio-save.md#bwedrawtextx-y-text-opts--void) | 画文字 | ✅ 已实现 |
| [`bwe.draw.rect(x, y, w, h, opts)`](draw-audio-save.md#bwedrawrectx-y-w-h-opts--void) | 画矩形 | ✅ 已实现 |
| [`bwe.draw.line(x1, y1, x2, y2, opts)`](draw-audio-save.md#bwedrawlinex1-y1-x2-y2-opts--void) | 画线 | ✅ 已实现 |
| [`bwe.draw.circle(x, y, r, opts)`](draw-audio-save.md#bwedrawcirclex-y-r-opts--void) | 画圆 | ✅ 已实现 |
| [`bwe.draw.sprite(asset, x, y, opts)`](draw-audio-save.md#bwedrawspriteasset-x-y-opts--void) | 画素材 | ✅ 已实现 |
| [`bwe.draw.bar(x, y, w, h, pct, opts)`](draw-audio-save.md#bwedrawbarx-y-w-h-pct-opts--void) | 进度条 | ✅ 已实现 |
| [`bwe.draw.measureText(text, size)`](draw-audio-save.md#bwedrawmeasuretexttext-size--size) | 量文字尺寸 | ✅ 已实现 |
| [`bwe.draw.world(fn)`](draw-audio-save.md#bwedrawworldfn--void) | 世界空间绘制 | ✅ 已实现 |
| [`bwe.audio.play(name, opts)`](draw-audio-save.md#bweaudioplayname-opts--number) | 播放音效（支持 `pitch` 变调） | ✅ 已实现 |
| [`bwe.audio.stop(idOrName)`](draw-audio-save.md#bweaudiostopidorname--void) | 停止 | ✅ 已实现 |
| [`bwe.audio.music(name, opts)`](draw-audio-save.md#bweaudiomusicname-opts--number) | 背景音乐 | ✅ 已实现 |
| [`bwe.audio.volume(v)`](draw-audio-save.md#bweaudiovolumev--void) | 全局音量 | ✅ 已实现 |
| [`bwe.save.set(k, v)`](draw-audio-save.md#bwesavesetk-v--void) | 存值 | ✅ 已实现 |
| [`bwe.save.get(k, def?)`](draw-audio-save.md#bwesavegetk-def--unknown) | 读值 | ✅ 已实现 |
| [`bwe.save.has(k)`](draw-audio-save.md#bwesavehask--boolean) | 有没有 | ✅ 已实现 |
| [`bwe.save.remove(k)`](draw-audio-save.md#bwesaveremovek--void) | 删键 | ✅ 已实现 |
| [`bwe.save.clear()`](draw-audio-save.md#bwesaveclear--void) | 清空 | ✅ 已实现 |
| [`bwe.save.flush()`](draw-audio-save.md#bwesaveflush--boolean) | 立即落盘 | ✅ 已实现 |
| [`bwe.save.write(slot?)`](draw-audio-save.md#bwesavewriteslot--boolean) | 写槽位 | ✅ 已实现 |
| [`bwe.save.read(slot?)`](draw-audio-save.md#bwesavereadslot--boolean) | 读槽位 | ✅ 已实现 |
| [`bwe.save.exists(slot?)`](draw-audio-save.md#bwesaveexistsslot--boolean) | 槽位存在？ | ✅ 已实现 |
| [`bwe.save.delete(slot?)`](draw-audio-save.md#bwesavedeleteslot--boolean) | 删槽位 | ✅ 已实现 |

### 7. 网格 / 瓦片 / 寻路 / 交互 / 刷怪 — [map-nav-interact-spawner.md](map-nav-interact-spawner.md)

| 成员 | 说明 | Phase |
|---|---|---|
| [`bwe.grid.cellSize`](map-nav-interact-spawner.md#bwegridcellsize--number) | 每格像素 | ✅ 已实现 |
| [`bwe.grid.toCell(x, y)`](map-nav-interact-spawner.md#bwegridtocellx-y--cellpos) | 像素 → 格子 | ✅ 已实现 |
| [`bwe.grid.toWorld(cx, cy)`](map-nav-interact-spawner.md#bwegridtoworldcx-cy--vec2) | 格子 → 格子中心 | ✅ 已实现 |
| [`bwe.grid.snap(x, y)`](map-nav-interact-spawner.md#bwegridsnapx-y--vec2) | 对齐格子中心 | ✅ 已实现 |
| [`bwe.tilemap.get(cx, cy)`](map-nav-interact-spawner.md#bwetilemapgetcx-cy--number) | 瓦片 id | ✅ 已实现 |
| [`bwe.tilemap.set(cx, cy, id)`](map-nav-interact-spawner.md#bwetilemapsetcx-cy-tileid--void) | 写瓦片 | ✅ 已实现 |
| [`bwe.tilemap.solid(cx, cy)`](map-nav-interact-spawner.md#bwetilemapsolidcx-cy--boolean) | 是否阻挡 | ✅ 已实现 |
| [`bwe.tilemap.setSolid(tileId, bool)`](map-nav-interact-spawner.md#bwetilemapsetsolidtileid-solid--void) | 设某类瓦片阻挡 | ✅ 已实现 |
| [`bwe.tilemap.blocked(x, y, w, h)`](map-nav-interact-spawner.md#bwetilemapblockedx-y-w-h--boolean) | 矩形撞墙 | ✅ 已实现 |
| [`bwe.tilemap.raycast(x1,y1,x2,y2)`](map-nav-interact-spawner.md#bwetilemapraycastx1-y1-x2-y2--rayhit) | 射线检测 | ✅ 已实现 |
| [`bwe.nav.find(from, to, opts)`](map-nav-interact-spawner.md#bwenavfindfrom-to-opts--vec2) | A* 寻路 | ✅ 已实现 |
| [`bwe.nav.lineOfSight(a, b)`](map-nav-interact-spawner.md#bwenavlineofsighta-b--boolean) | 视线判断 | ✅ 已实现 |
| [`bwe.nav.follow(e, path, opts)`](map-nav-interact-spawner.md#bwenavfollowe-path-opts--void) | 沿路径走 | ✅ 已实现 |
| [`bwe.nav.stop(e)`](map-nav-interact-spawner.md#bwenavstope--void) | 停止跟随 | ✅ 已实现 |
| [`bwe.interact.nearest(actor, opts)`](map-nav-interact-spawner.md#bweinteractnearestactor-opts--entity--null) | 最近交互物 | ✅ 已实现 |
| [`bwe.interact.prompt(text)`](map-nav-interact-spawner.md#bweinteractprompttext--void) | 头顶提示 | ✅ 已实现 |
| [`bwe.interact.setKey(key)`](map-nav-interact-spawner.md#bweinteractsetkeykey--void) | 交互键 | ✅ 已实现 |
| [`bwe.interact.onTrigger(fn)`](map-nav-interact-spawner.md#bweinteractontriggerfn--void) | 触发回调 | ✅ 已实现 |
| [`bwe.spawner.create(opts)`](map-nav-interact-spawner.md#bwespawnercreateopts--number) | 创建刷怪器 | ✅ 已实现 |
| [`bwe.spawner.stop(handle)`](map-nav-interact-spawner.md#bwespawnerstophandle--void) | 停止刷怪器 | ✅ 已实现 |

### 8. 涌现式模拟基底 — [emergence.md](emergence.md)

| 成员 | 说明 | Phase |
|---|---|---|
| [`bwe.material.define(name, props)`](emergence.md#bwematerialdefinename-props--material) | 定义材质 | ✅ 已实现 |
| [`bwe.material.get(name)`](emergence.md#bwematerialgetname--material--null) | 读材质 | ✅ 已实现 |
| [`bwe.material.tags(name)`](emergence.md#bwematerialtagsname--string) | 材质标签 | ✅ 已实现 |
| [`bwe.material.of(cx, cy)`](emergence.md#bwematerialofcx-cy--string--null) | 格子材质名 | ✅ 已实现 |
| [`bwe.material.setTile(cx, cy, name)`](emergence.md#bwematerialsettilecx-cy-name--void) | 改格子材质 | ✅ 已实现 |
| [`bwe.material.ofEntity(e)`](emergence.md#bwematerialofentitye--string--null) | 实体材质 | ✅ 已实现 |
| [`bwe.material.setEntity(e, name)`](emergence.md#bwematerialsetentitye-name--void) | 改实体材质 | ✅ 已实现 |
| [`bwe.field.emit(ch, cx, cy, v)`](emergence.md#bwefieldemitchannel-cx-cy-intensity--void) | 点火 / 灌水 | ✅ 已实现 |
| [`bwe.field.sample(ch, cx, cy)`](emergence.md#bwefieldsamplechannel-cx-cy--number) | 读强度 | ✅ 已实现 |
| [`bwe.field.clear(ch)`](emergence.md#bwefieldclearchannel--void) | 清通道 | ✅ 已实现 |
| [`bwe.field.tickRate(sec?)`](emergence.md#bwefieldtickratesec--number) | 模拟步长 | ✅ 已实现 |
| [`bwe.field.channel(name)`](emergence.md#bwefieldchannelname--channelhandle) | 自定义通道 | ✅ 已实现 |
| [`bwe.field.wind(dx, dy)`](emergence.md#bwefieldwinddx-dy--vec2) | 风向 | ✅ 已实现 |
| [`bwe.field.on(ev, fn)`](emergence.md#bwefieldonev-fn--void) | 场事件 | ✅ 已实现 |
| [`bwe.field.burning()`](emergence.md#bwefieldburning--burningcell) | 燃烧格列表 | ✅ 已实现 |
| [`bwe.noise.emit(x, y, opts)`](emergence.md#bwenoiseemitx-y-opts--void) | 制造噪音 | ✅ 已实现 |
| [`bwe.noise.events()`](emergence.md#bwenoiseevents--noiseevent) | 噪音事件 | ✅ 已实现 |
| [`bwe.sense.canSee(a, b)`](emergence.md#bwesensecanseea-b--boolean) | 看得见？ | ✅ 已实现 |
| [`bwe.sense.inSightRange(a, b)`](emergence.md#bwesenseinsightrangea-b--boolean) | 只判距离 | ✅ 已实现 |
| [`bwe.sense.audible(e)`](emergence.md#bwesenseaudiblee--boolean) | 听得到？ | ✅ 已实现 |
| [`bwe.sense.lastKnown(e)`](emergence.md#bwesenselastknowne--lastknown--null) | 记忆位置 | ✅ 已实现 |
| [`bwe.faction.set(e, name)`](emergence.md#bwefactionsete-name--void) | 设阵营 | ✅ 已实现 |
| [`bwe.faction.relation(a, b, v?)`](emergence.md#bwefactionrelationa-b-v--number) | 关系 | ✅ 已实现 |
| [`bwe.faction.hostile(a, b)`](emergence.md#bwefactionhostilea-b--boolean) | 敌对？ | ✅ 已实现 |
| [`bwe.faction.members(name)`](emergence.md#bwefactionmembersname--entity) | 阵营成员 | ✅ 已实现 |
| [`bwe.ai.attach(e, opts)`](emergence.md#bweaiattache-opts--void) | 挂感知 | ✅ 已实现 |
| [`bwe.ai.detach(e)`](emergence.md#bweaidetache--void) | 摘感知 | ✅ 已实现 |
| [`bwe.ai.state(e)` / `setState(e, s)`](emergence.md#bweaistatee--string--null) | 状态字符串 | ✅ 已实现 |
| [`bwe.ai.target(e)`](emergence.md#bweaitargete--entity--null) | 锁定目标 | ✅ 已实现 |
| [`bwe.ai.alert(e, pos)`](emergence.md#bweaialerte-pos--void) | 同阵营警报 | ✅ 已实现 |
| [`bwe.ai.onAlert(fn)`](emergence.md#bweaionalertfn--void) | 收到警报 | ✅ 已实现 |
| [`bwe.ai.onSpot(fn)`](emergence.md#bweaionspotfn--void) | 发现目标 | ✅ 已实现 |
| [`bwe.target.cell()`](emergence.md#bwetargetcell--targetcell--null) | 鼠标格子 | ✅ 已实现 |
| [`bwe.target.entity()`](emergence.md#bwetargetentity--entity--null) | 鼠标下实体 | ✅ 已实现 |
| [`bwe.target.inFront(e, range?)`](emergence.md#bwetargetinfronte-range--entity--cell--null) | 面前物体 | ✅ 已实现 |
| [`bwe.physics.enable()`](emergence.md#bwephysicsenable--boolean) | 打开物理 | ✅ 已实现 |
| [`bwe.physics.enabled()`](emergence.md#bwephysicsenabled--boolean) | 是否已开 | ✅ 已实现 |
| [`bwe.physics.gravity(gy?)`](emergence.md#bwephysicsgravitygy--number) | 重力 | ✅ 已实现 |
| [`bwe.physics.debug(on?)`](emergence.md#bwephysicsdebugon--boolean) | 画碰撞体 | ✅ 已实现 |
| [`bwe.physics.body(e, opts)`](emergence.md#bwephysicsbodye-opts--entity--null) | 建刚体 | ✅ 已实现 |
| [`bwe.physics.remove(e)`](emergence.md#bwephysicsremovee--boolean) | 删刚体 | ✅ 已实现 |
| [`bwe.physics.applyImpulse(e, ix, iy)`](emergence.md#bwephysicsapplyimpulsee-ix-iy--boolean) | 施冲量 | ✅ 已实现 |
| [`bwe.physics.velocity(e)`](emergence.md#bwephysicsvelocitye--vx-vy) | 读速度 | ✅ 已实现 |
| [`bwe.physics.setVelocity(e, vx, vy)`](emergence.md#bwephysicssetvelocitye-vx-vy--boolean) | 设速度 | ✅ 已实现 |
| [`bwe.physics.throwAt(e, tx, ty, speed?)`](emergence.md#bwephysicsthrowate-tx-ty-speed--boolean) | 抛向目标 | ✅ 已实现 |
| [`bwe.physics.raycast(x1,y1,x2,y2)`](emergence.md#bwephysicsraycastx1-y1-x2-y2--rayhit) | 物理射线 | ✅ 已实现 |
| [`bwe.physics.queryPoint(x, y)`](emergence.md#bwephysicsquerypointx-y--entity) | 点查询 | ✅ 已实现 |
| [`bwe.physics.queryAABB(x,y,w,h)`](emergence.md#bwephysicsqueryaabbx-y-w-h--entity) | 矩形查询 | ✅ 已实现 |
| [`bwe.physics.on(ev, fn)`](emergence.md#bwephysicsonev-fn--function--null) | 碰撞回调 | ✅ 已实现 |
| [`bwe.physics.bodyCount()`](emergence.md#bwephysicsbodycount--number) | 刚体数 | ✅ 已实现 |
| [`bwe.physics.tileBodyCount()`](emergence.md#bwephysicstilebodycount--number) | 瓦片墙数 | ✅ 已实现 |
| [`bwe.seed.set(n)`](emergence.md#bweseedsetn--number) | 固定种子 | ✅ 已实现 |
| [`bwe.seed.get()`](emergence.md#bweseedget--number) | 当前种子 | ✅ 已实现 |
| [`bwe.seed.reset()`](emergence.md#bweseedreset--number) | 恢复默认种子 | ✅ 已实现 |
| [`bwe.seed.defaultSeed()`](emergence.md#bweseeddefaultseed--number) | 默认种子值 | ✅ 已实现 |

### 9. 根命名空间工具 — [lifecycle.md](lifecycle.md#五根命名空间工具函数)

| 成员 | 说明 | Phase |
|---|---|---|
| [`bwe.on(name, fn)`](lifecycle.md#bweonname-fn--void) | 全局钩子（`update`/`draw`/`keydown`/`click`） | ✅ 已实现 |
| [`bwe.off(name, fn)`](lifecycle.md#bweoffname-fn--void) | 取消钩子 | ✅ 已实现 |
| [`bwe.log(...)`](lifecycle.md#bwelogargs--void) / [`bwe.error(...)`](lifecycle.md#bweerrorargs--void) | 日志 | ✅ 已实现 |
| [`bwe.random`](lifecycle.md#bwerandommin-max--number) / [`bwe.randomInt`](lifecycle.md#bwerandomintmin-max--number) / [`bwe.chance`](lifecycle.md#bwechancep--boolean) / [`bwe.pick`](lifecycle.md#bwepickarr--unknown) | 随机 | ✅ 已实现 |
| [`bwe.clamp`](lifecycle.md#bweclampv-a-b--number) / [`bwe.lerp`](lifecycle.md#bwelerpa-b-t--number) / [`bwe.dist`](lifecycle.md#bwedistx1-y1-x2-y2--number) | 数学 | ✅ 已实现 |
| [`bwe.call`](lifecycle.md#bwecallscriptname-handlername-args--unknown) / [`bwe.has`](lifecycle.md#bwehasscriptname--boolean) / [`bwe.scripts.*`](lifecycle.md#bwescriptscallscriptname-handlername-args--unknown) | 跨脚本调用 | ✅ 已实现 |
| [`bwe.tween(...)`](lifecycle.md#bwetweentarget-props-dur-opts--tweenhandle) | 补间 | 📋 规划（返回空句柄） |

### 10. 可视化模块目录 — [modules.md](modules.md)

编辑器里的「积木」。共 **43 个**内置模块，分 7 类：怎么动 / 怎么显示 / 怎么感知 / 什么时候做 / 怎么打 / 怎么说话 / 画面与声音。
**重要**：模块目录（`BuiltinModules.java`）是**编辑器**侧的积木清单，**不等于**运行时真的执行 —— 运行时只实现了其中一部分。每个模块的「运行时」列写清了这一点，见 [modules.md](modules.md#一模块总表)。

### 11. 开放世界子命名空间（8 个）

多层建筑、路网车辆、可配置输入、战斗与调试绘制。这些命名空间彼此独立，旧工程不引用它们时行为完全不变。

| 命名空间 | 页面 | 说明 |
|---|---|---|
| 场景 `bwe.scene` | [scene.md](scene.md) | 场景列表 / 切换（帧末生效）/ 场景代数 / 切换回调 |
| 空间 `bwe.spatial` | [spatial.md](spatial.md) | 多层建筑：区域、楼层归属、垂直连接、五状态分离 |
| 碰撞 `bwe.collision` | [collision.md](collision.md) | 碰撞 / 触发事件、几何查询、射线、传感器 |
| 输入动作 `bwe.actions` | [actions.md](actions.md) | 动作映射（可改键）、上下文栈、放行规则 |
| 路网 `bwe.road` | [road.md](road.md) | 道路节点 / 路段、最短**时间**路径 |
| 车辆 `bwe.vehicle` | [vehicle.md](vehicle.md) | 上下车 / 劫车、油门刹车转向、自动驾驶 |
| 战斗 `bwe.combat` | [combat.md](combat.md) | 武器参数表、命中结算、格挡、弹药 |
| 调试 `bwe.debug` | [debug.md](debug.md) | 碰撞盒 / 路径 / 区域 / 阻挡图的调试绘制 |

**常见配对**：

| 你想… | 看 |
|---|---|
| 做多楼层建筑、玩家进出室内 | [spatial.md](spatial.md) |
| 让车沿道路自动开 | [road.md](road.md) + [vehicle.md](vehicle.md) |
| 让键位可配置（不改游戏逻辑） | [actions.md](actions.md) |
| 判断"碰到了没" | [collision.md](collision.md) |
| 排查"我看不到它在哪" | [debug.md](debug.md) |

---

## 约定与陷阱

| 主题 | 说明 |
|---|---|
| 坐标 | 世界像素、中心点、**Y 轴向下**；角度用**度**、**顺时针**为正 |
| 格子 | `(cx, cy) = floor(pos / tileSize)`，格子中心 `(cx + 0.5) * tileSize` |
| 颜色 | `"#rrggbb"` / `"#rrggbbaa"` / `"#rgb"` / `white` `black` `red` `green` `blue` `yellow` `gray` `orange` `cyan` `magenta` / `"transparent"` / `"none"` |
| 属性（props） | 底层永远是**字符串**（与编辑器同构）；`e.prop(k, def)` 按 `def` 的类型转型 |
| 布尔文本 | 编辑器约定 `"开"` / `"关"`；读取时 `"开"` `"true"` `"1"` 都算真 |
| 没有的东西 | `setTimeout` / `setInterval` / `import` / `require` / `require('fs')` 都不存在 |
| 定时器 | 用 `bwe.after` / `bwe.every` / `bwe.cancel`，走游戏时间（受暂停与 `timeScale` 影响） |
| 动画模式 | 中文枚举 `"默认"` / `"只显示首帧"` / `"单次播放"`；写时也认 `"loop"` / `"first"` / `"once"` |
| 模块 id | 新旧两套都认（`combat.health` ≡ `fight.hp` 等 6 组别名） |
| 脚本间通信 | 用 `bwe.call(script, fn, ...args)`；全局钩子用 `bwe.on`；自定义事件总线用 `bwe.world.on/emit` |
| 错误 | 写 `Build/bwe.log`，格式 `[脚本错误] <script>:<line>: <message>`，同一脚本同一行只报一次，游戏继续跑 |

## 性能要点

- 同素材实例**共享一份 GL 纹理**（按文件路径 / 素材 id 缓存），实例数多也不额外吃显存。
- 渲染按 **`layer` → `z` → `y`** 排序，**相邻、同纹理、未旋转**的精灵会合批。
- **性能陷阱**：给每个实例设**不同的 `z` / `layer` / `rotation`** 都会打断合批。批量刷同种怪时保持相同的 `z`、`layer`、`rotation = 0` 最快。
- HUD 动态数字的文字纹理有**有界 LRU（上限 256 条）**，不会无限增长；但仍然建议少画字、把变化慢的文字缓存起来。

详见 [prefab.md 的性能提示](prefab.md#六性能提示)。
