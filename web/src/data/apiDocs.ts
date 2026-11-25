/**
 * JS 脚本 API 速查数据。
 *
 * 唯一事实来源是 docs/scripting-api.md §2（Phase 1 必须实现的那张表）；
 * 本文件是它的「可搜索索引」，给剧本面板的 API 侧栏用。
 * 改契约先改 docs/scripting-api.md，再回来同步这里 —— 两处的名字必须一字不差，
 * 否则用户照着速查抄下来的代码会跑不通。
 *
 * 每条记录：{ name, signature, desc, group }，另有 phase2 标记（契约占位、当前不保证有行为）。
 */

/** API 速查的分组（顺序即侧栏里的显示顺序）。 */
export type ApiGroupId =
  | "life" | "world" | "entity" | "prefab" | "input" | "camera" | "time"
  | "draw" | "audio" | "save" | "map" | "nav" | "interact" | "spawner" | "util"
  | "material" | "field" | "sense" | "physics"
  | "scene" | "spatial" | "collision" | "actions" | "road" | "vehicle" | "combat" | "debug"
  | "light";

export interface ApiGroup {
  id: ApiGroupId;
  label: string;
  blurb: string;
}

export interface ApiDoc {
  /** 调用名，例如 "bwe.world.find"（搜索与插入都用它） */
  name: string;
  /** 展示用签名，例如 "bwe.world.find(q) → Entity | null" */
  signature: string;
  /** 一句话说明 */
  desc: string;
  group: ApiGroupId;
  /** Phase 2 占位：当前契约先占住，运行时不保证有行为 */
  phase2?: boolean;
}

export const API_GROUPS: ApiGroup[] = [
  { id: "life", label: "生命周期 Lifecycle", blurb: "运行时按事件调用脚本里的同名函数" },
  { id: "world", label: "世界 world", blurb: "地图尺寸、查找 / 生成 / 销毁、全局事件" },
  { id: "entity", label: "实体 Entity", blurb: "对象属性、模块、子精灵、血量" },
  { id: "prefab", label: "预制体 prefab / pool", blurb: "模板注册、批量生成、对象池" },
  { id: "input", label: "输入 input", blurb: "按键、鼠标、方向轴" },
  { id: "camera", label: "相机 camera", blurb: "跟随、缩放、抖动、坐标换算" },
  { id: "time", label: "时间 time", blurb: "时间 / 帧、延时与重复任务" },
  { id: "draw", label: "绘制 draw", blurb: "HUD、文字、形状、精灵（立即模式）" },
  { id: "audio", label: "音频 audio", blurb: "音效与背景音乐" },
  { id: "save", label: "存档 save", blurb: "本地 JSON 存档与槽位" },
  { id: "map", label: "网格与瓦片 grid / tilemap", blurb: "像素 ⇄ 格子、阻挡查询、射线" },
  { id: "nav", label: "寻路 nav", blurb: "A* 寻路、视线判断、沿路径移动" },
  { id: "interact", label: "交互 interact", blurb: "最近交互物、按键提示" },
  { id: "spawner", label: "生成器 spawner", blurb: "定时刷怪 / 掉落" },
  { id: "util", label: "辅助函数", blurb: "随机、夹取、插值、日志、跨脚本调用" },
  { id: "material", label: "材质 material", blurb: "易燃 / 燃烧时长 / 导电 / 湿：涌现的第一性" },
  { id: "field", label: "格子场 field", blurb: "火 / 水 / 烟 / 自定义通道的蔓延与熄灭" },
  { id: "sense", label: "感知与 AI sense / ai", blurb: "视野、噪音、记忆、阵营、状态机" },
  { id: "physics", label: "物理 physics", blurb: "刚体、冲量、抛掷、射线（jbox2d）" },
  { id: "scene", label: "场景 scene", blurb: "场景列表、切换、场景代数与切换回调" },
  { id: "spatial", label: "空间 spatial", blurb: "多层建筑：区域、楼层、垂直连接、可见性" },
  { id: "collision", label: "碰撞 collision", blurb: "碰撞 / 触发事件、几何查询、射线、传感器" },
  { id: "actions", label: "输入动作 actions", blurb: "动作映射、上下文栈、可配置改键" },
  { id: "road", label: "路网 road", blurb: "道路节点与路段、最短时间路径" },
  { id: "vehicle", label: "车辆 vehicle", blurb: "上下车、油门刹车转向、沿路网自动驾驶" },
  { id: "combat", label: "战斗 combat", blurb: "武器参数、命中判定、格挡与弹药" },
  { id: "debug", label: "调试 debug", blurb: "碰撞盒 / 路径 / 区域 / 阻挡图的调试绘制" },
  { id: "light", label: "光照 light", blurb: "2D 光照层：总开关、环境光、压暗、光源挂载与动态重建" }
];

function d(name: string, signature: string, desc: string, group: ApiGroupId, phase2 = false): ApiDoc {
  return phase2 ? { name, signature, desc, group, phase2 } : { name, signature, desc, group };
}

// ---------------- 数据 ----------------

export const API_DOCS: ApiDoc[] = [
  // ===== 生命周期 =====
  d("onStart", "function onStart(ctx)", "对象生成时执行一次", "life"),
  d("onUpdate", "function onUpdate(ctx, dt)", "每帧执行；dt = 本帧秒数", "life"),
  d("onClick", "function onClick(ctx)", "鼠标左键点中这个对象", "life"),
  d("onEnter", "function onEnter(ctx, other)", "触发区：别的对象进来了", "life"),
  d("onLeave", "function onLeave(ctx, other)", "触发区：别的对象离开了", "life"),
  d("onInteract", "function onInteract(ctx, actor)", "玩家走近并按下交互键", "life"),
  d("onDamage", "function onDamage(ctx, amount, from)", "受到伤害；amount 是实际扣血", "life"),
  d("onDeath", "function onDeath(ctx, by)", "生命值归零", "life"),
  d("onDestroy", "function onDestroy(ctx)", "销毁前最后一个回调", "life"),
  d("onKey", "function onKey(ctx, key)", "任意按键按下（可选，全局按键更推荐 bwe.on(\"keydown\")）", "life"),
  d("onSceneStart", "function onSceneStart(ctx)", "场景脚本：场景载入完、对象 spawn 完之后执行一次", "life"),
  d("onSceneEnd", "function onSceneEnd(ctx)", "场景脚本：离开 / 销毁场景时执行", "life"),
  d("bwe.on", "bwe.on(name, fn)", "全局钩子：\"update\" / \"draw\" / \"keydown\" / \"click\"", "life"),
  d("bwe.off", "bwe.off(name, fn)", "取消 bwe.on 注册的全局钩子", "life"),

  // ===== 世界 =====
  d("bwe.world.mapSize", "bwe.world.mapSize() → {w, h}", "地图尺寸（像素）", "world"),
  d("bwe.world.tileSize", "bwe.world.tileSize() → number", "每格多少像素", "world"),
  d("bwe.world.scene", "bwe.world.scene → {name, width, height}", "当前场景信息", "world"),
  d("bwe.world.find", "bwe.world.find(q) → Entity | null", "找第一个匹配的实体；q 可以是名字/标签字符串，或 {name, tag, kind, id}", "world"),
  d("bwe.world.findAll", "bwe.world.findAll(q) → Entity[]", "找所有匹配的实体", "world"),
  d("bwe.world.spawn", "bwe.world.spawn({x, y, asset?, name?, kind?, tags?, z?, layer?, halfW?, halfH?, scaleX?, scaleY?, rotation?, visible?, animMode?, animFps?, script?, modules?, props?, parent?}) → Entity", "运行时生成一个实体", "world"),
  d("bwe.world.spawnMany", "bwe.world.spawnMany(list) → Entity[]", "批量生成（每个元素一份 spawn 参数）", "world"),
  d("bwe.world.spawnAt", "bwe.world.spawnAt(opts, x, y) → Entity", "便捷式：生成并强制指定 x/y", "world"),
  d("bwe.world.clone", "bwe.world.clone(e, opts?) → Entity | null", "复制实体（tags/模块/props/子精灵一并带上）", "world"),
  d("bwe.world.destroy", "bwe.world.destroy(e)", "销毁实体（同 e.destroy()）", "world"),
  d("bwe.world.clear", "bwe.world.clear()", "销毁所有实体（含场景原生对象）", "world"),
  d("bwe.world.clearTag", "bwe.world.clearTag(tag)", "只销毁带该标签的实体", "world"),
  d("bwe.world.destroyAll", "bwe.world.destroyAll(filter?) → number", "批量销毁，返回实际删除数", "world"),
  d("bwe.world.count", "bwe.world.count(q?) → number", "数量：无参 = 存活实体数，有参 = 匹配数", "world"),
  d("bwe.world.each", "bwe.world.each(q, fn(e))", "遍历（快照迭代，回调里 spawn/destroy 安全）", "world"),
  d("bwe.world.entities", "bwe.world.entities() → Entity[]", "当前所有实体（只读数组）", "world"),
  d("bwe.world.paused", "bwe.world.paused = true", "暂停整个运行时", "world"),
  d("bwe.world.timeScale", "bwe.world.timeScale = 0.5", "时间缩放，1 = 正常", "world"),
  d("bwe.world.on", "bwe.world.on(name, fn)", "全局事件总线：注册", "world"),
  d("bwe.world.off", "bwe.world.off(name, fn)", "全局事件总线：取消", "world"),
  d("bwe.world.emit", "bwe.world.emit(name, payload)", "全局事件总线：派发", "world"),
  d("bwe.world.layers", "bwe.world.layers() → Layer[]", "图层信息（Phase 2，当前返回空数组）", "world", true),

  // ===== 实体 =====
  d("e.id", "e.id", "唯一 id（只读）", "entity"),
  d("e.name", "e.name", "对象名（可读写，用于 find）", "entity"),
  d("e.kind", "e.kind", "对象大类：ACTOR / PROP / TILE / ZONE / SPAWN / PORTAL / LIGHT", "entity"),
  d("e.x", "e.x / e.y", "位置（世界像素，中心点，Y 向下）", "entity"),
  d("e.y", "e.y", "位置（世界像素，中心点，Y 向下）：与 e.x 同一节，可直接赋值", "entity"),
  d("e.z", "e.z", "排序层级，大的盖住小的", "entity"),
  d("e.rotation", "e.rotation", "角度，顺时针，单位度", "entity"),
  d("e.scaleX", "e.scaleX / e.scaleY", "缩放倍数（1 = 原尺寸；-1 = 水平翻转）", "entity"),
  d("e.scaleY", "e.scaleY", "缩放倍数：与 e.scaleX 同一节，可直接赋值", "entity"),
  d("e.visible", "e.visible", "显示 / 隐藏", "entity"),
  d("e.alive", "e.alive", "是否还活着（只读）", "entity"),
  d("e.tags", "e.tags → Tags", "标签集合：e.tags.has(\"敌人\") / e.tags.includes(\"敌人\")", "entity"),
  d("e.actor", "type Entity", "所有 e.xxx 里的 e 都是 Entity（脚本里 e = ctx.self）", "entity"),
  d("e.pos", "e.pos → {x, y}", "位置（只读快照）", "entity"),
  d("e.setPos", "e.setPos(x, y)", "设置位置（世界像素，中心点）", "entity"),
  d("e.size", "e.size → {w, h}（可写）", "可视化尺寸（与编辑器 halfW/halfH 同一套规则）；写 size = {w,h} 等价 setSize", "entity"),
  d("e.setSize", "e.setSize(w, h)", "设置尺寸", "entity"),
  d("e.layer", "e.layer", "图层下标（绘制顺序 layer → z → y）", "entity"),
  d("e.locked", "e.locked", "锁定标记（运行时只记忆，不影响行为）", "entity"),
  d("e.animMode", "e.animMode", "\"默认\" / \"只显示首帧\" / \"单次播放\"（写时 loop/first/once 也认）", "entity"),
  d("e.animFps", "e.animFps", "每秒帧数（写会解除 setFrame 的帧锁定）", "entity"),
  d("e.asset", "e.asset", "当前素材名（可读写；写入等价换图但不改播放参数）", "entity"),
  d("e.setColor", "e.setColor(r, g, b, a?)", "染色：0~1；任一通道 > 1 时整组按 0~255 解释", "entity"),
  d("e.setAlpha", "e.setAlpha(a)", "只改透明度（0~1；>1 视作 0~255），与 blink 模块 alpha 相乘", "entity"),
  d("e.clearColor", "e.clearColor()", "清除染色，恢复原样", "entity"),
  d("e.color", "e.color → {r, g, b, a}", "当前染色值（只读）", "entity"),
  d("e.addTag", "e.addTag(t) → boolean", "加标签（已存在返回 true 且不重复）", "entity"),
  d("e.removeTag", "e.removeTag(t) → boolean", "删标签；原本没有返回 false", "entity"),
  d("e.hasTag", "e.hasTag(t) → boolean", "有没有这个标签", "entity"),
  d("e.setTags", "e.setTags(arr)", "整体替换标签集合", "entity"),
  d("e.props", "e.props() → Record<string, string>", "全部对象属性（快照）", "entity"),
  d("e.setProps", "e.setProps(obj)", "批量写属性（值归一成编辑器同构文本）", "entity"),
  d("e.addModule", "e.addModule(def, params?, when?) → boolean", "追加模块；同 def 已存在时合并参数。加 combat.health 会立刻重算 hpMax/hp", "entity"),
  d("e.removeModule", "e.removeModule(def) → boolean", "移除模块；不存在返回 false。移除 combat.health 不重置当前 hp/hpMax", "entity"),
  d("e.parent", "e.parent（可写）→ Entity | null", "父实体；设 null 解除关系", "entity"),
  d("e.children", "e.children() → Entity[]", "直接子级（只读快照）", "entity"),
  d("e.sprite", "e.sprite({asset, frame?, fps?, mode?})", "换精灵；mode: \"loop\" | \"once\" | \"first\"", "entity"),
  d("e.play", "e.play(assetName)", "直接换素材（沿用当前播放参数）", "entity"),
  d("e.setFrame", "e.setFrame(i)", "冻结到第 i 帧（0 起）", "entity"),
  d("e.prop", "e.prop(key, def?)", "读对象属性（与编辑器 props 打通）", "entity"),
  d("e.setProp", "e.setProp(key, val)", "写对象属性；会影响下一帧绘制尺寸", "entity"),
  d("e.hasModule", "e.hasModule(\"move.patrol\")", "有没有挂这个模块", "entity"),
  d("e.module", "e.module(id) → {enabled, get(k), set(k, v)}", "取模块实例，读写它的参数与开关", "entity"),
  d("e.modules", "e.modules() → ModuleInstance[]", "所有模块实例", "entity"),
  d("e.attach", "e.attach({asset, dx?, dy?, z?, rotation?, alpha?, w?, h?}) → {id, remove()}", "挂一个子精灵（武器 / 影子 / 特效），返回**对象**句柄", "entity"),
  d("e.detach", "e.detach(handle | id)", "摘掉子精灵（传 attach 的返回值，或直接传 id）", "entity"),
  d("e.distanceTo", "e.distanceTo(other) → number", "到另一个实体的距离（像素）", "entity"),
  d("e.angleTo", "e.angleTo(other) → number", "到另一个实体的角度（度，0 = 向右）", "entity"),
  d("e.destroy", "e.destroy()", "销毁自己", "entity"),
  d("e.hp", "e.hp / e.hpMax", "生命值（读写 combat.health 模块，没有则用内部值）", "entity"),
  d("e.hpMax", "e.hpMax", "生命值上限：与 e.hp 同一节，可写（改它不会自动回满）", "entity"),
  d("e.damage", "e.damage(n)", "扣血（走受击流程：闪白 / 无敌帧 / onDamage）", "entity"),
  d("e.heal", "e.heal(n)", "回血", "entity"),
  d("e.on", "e.on(\"click\"|\"enter\"|\"leave\"|\"damage\"|\"death\", fn)", "注册实体事件", "entity"),

  // ===== 输入 =====
  d("bwe.input.down", "bwe.input.down(key) → boolean", "当前是否按住；key 支持 \"Space\" / \" \" / \"KeyW\" / \"ArrowLeft\" / \"Mouse0\" / 32", "input"),
  d("bwe.input.pressed", "bwe.input.pressed(key) → boolean", "本帧刚按下（边沿）", "input"),
  d("bwe.input.released", "bwe.input.released(key) → boolean", "本帧刚抬起（边沿）", "input"),
  d("bwe.input.axis", "bwe.input.axis() → {x, y}", "方向轴，WASD + 方向键都算，已归一化", "input"),
  d("bwe.input.mouse", "bwe.input.mouse → {x, y, worldX, worldY, left, middle, right, wheel}", "鼠标状态；worldX/Y 已过视口反变换", "input"),
  d("bwe.input.cursor", "bwe.input.cursor(visible)", "显示 / 隐藏鼠标光标", "input"),
  d("bwe.input.block", "bwe.input.block(id, x, y, w, h) → boolean",
    "登记一块「界面区」（屏幕逻辑像素矩形）。落在其中的点击被界面吃掉，不再传给可视化模块（扫雷棋盘等）。同 id 重复调用即覆盖，w/h ≤0 等于撤销。大棋盘（如 64×64）必然伸到 HUD 底下，不登记就会出现「点新游戏顺带翻开底下的格子」", "input"),
  d("bwe.input.unblock", "bwe.input.unblock(id) → boolean", "撤销某块界面区", "input"),

  // ===== 相机 =====
  d("bwe.camera.follow", "bwe.camera.follow(e, {smooth = 0.15, lookAhead = 0})", "跟随实体；传 null 取消跟随", "camera"),
  d("bwe.camera.pos", "bwe.camera.pos → {x, y}", "相机中心（世界坐标）", "camera"),
  d("bwe.camera.setPos", "bwe.camera.setPos(x, y)", "直接摆相机中心", "camera"),
  d("bwe.camera.zoom", "bwe.camera.zoom", "当前缩放，1 = 1:1 像素", "camera"),
  d("bwe.camera.setZoom", "bwe.camera.setZoom(z)", "设置缩放", "camera"),
  d("bwe.camera.shake", "bwe.camera.shake(strength = 6, duration = 0.25)", "屏幕抖动", "camera"),
  d("bwe.camera.bounds", "bwe.camera.bounds({x, y, w, h} | null)", "限制相机范围；null 取消限制", "camera"),
  d("bwe.camera.worldToScreen", "bwe.camera.worldToScreen(x, y) → {x, y}", "世界坐标 → 屏幕坐标", "camera"),
  d("bwe.camera.screenToWorld", "bwe.camera.screenToWorld(x, y) → {x, y}", "屏幕坐标 → 世界坐标", "camera"),
  d("bwe.camera.setFit", "bwe.camera.setFit(\"contain\" | \"cover\")", "覆盖默认的画面适配方式", "camera"),

  // ===== 时间 =====
  d("bwe.time.now", "bwe.time.now", "已运行秒数", "time"),
  d("bwe.time.dt", "bwe.time.dt", "本帧步长（秒）", "time"),
  d("bwe.time.frame", "bwe.time.frame", "已运行帧数", "time"),
  d("bwe.after", "bwe.after(sec, fn) → id", "延时执行一次（代替 setTimeout）", "time"),
  d("bwe.every", "bwe.every(sec, fn, {times?}) → id", "每 sec 秒执行一次（代替 setInterval）", "time"),
  d("bwe.cancel", "bwe.cancel(id)", "取消 after / every 的 id", "time"),
  d("bwe.tween", "bwe.tween(target, props, dur, opts) → {done(fn), cancel()}", "补间动画（Phase 2，当前不保证有行为）", "time", true),

  // ===== 绘制 =====
  d("bwe.draw.text", "bwe.draw.text(x, y, text, {size = 16, color = \"#fff\", align = \"left\", alpha = 1, shadow = true})", "在屏幕空间画文字（HUD / 调试）", "draw"),
  d("bwe.draw.rect", "bwe.draw.rect(x, y, w, h, {fill, stroke, width, alpha, radius})", "画矩形", "draw"),
  d("bwe.draw.line", "bwe.draw.line(x1, y1, x2, y2, {color, width, alpha})", "画线", "draw"),
  d("bwe.draw.circle", "bwe.draw.circle(x, y, r, {fill, stroke, width, alpha})", "画圆", "draw"),
  d("bwe.draw.sprite", "bwe.draw.sprite(assetName, x, y, {w, h, alpha, tint, rotation, frame})", "画一张素材 / 精灵", "draw"),
  d("bwe.draw.bar", "bwe.draw.bar(x, y, w, h, pct, {bg, fg, border})", "进度条（血条 / 经验条）", "draw"),
  d("bwe.draw.measureText", "bwe.draw.measureText(text, size) → {w, h}", "量文字尺寸（居中排版用）", "draw"),
  d("bwe.draw.world", "bwe.draw.world(fn)", "该回调内的绘制改用世界坐标（画在世界里）", "draw"),

  // ===== 音频 =====
  d("bwe.audio.play", "bwe.audio.play(name, {volume = 1, loop = false, pitch = 1}) → id", "播放音效", "audio"),
  d("bwe.audio.stop", "bwe.audio.stop(id | name)", "停止音效", "audio"),
  d("bwe.audio.music", "bwe.audio.music(name, {volume, loop = true})", "播放背景音乐（同时只有一首）", "audio"),
  d("bwe.audio.volume", "bwe.audio.volume(0..1)", "全局音量", "audio"),

  // ===== 存档 =====
  d("bwe.save.set", "bwe.save.set(k, v)", "存一个 JSON 值（不能存函数）", "save"),
  d("bwe.save.get", "bwe.save.get(k, def)", "读，没有则返回 def", "save"),
  d("bwe.save.has", "bwe.save.has(k)", "有没有这个键", "save"),
  d("bwe.save.remove", "bwe.save.remove(k)", "删掉这个键", "save"),
  d("bwe.save.clear", "bwe.save.clear()", "清空当前存档", "save"),
  d("bwe.save.flush", "bwe.save.flush()", "立即落盘", "save"),
  d("bwe.save.write", "bwe.save.write(slot = \"auto\")", "写到槽位文件", "save"),
  d("bwe.save.read", "bwe.save.read(slot = \"auto\")", "从槽位读回", "save"),
  d("bwe.save.exists", "bwe.save.exists(slot)", "槽位文件是否存在", "save"),
  d("bwe.save.delete", "bwe.save.delete(slot)", "删除槽位文件", "save"),

  // ===== 网格与瓦片 =====
  d("bwe.grid.cellSize", "bwe.grid.cellSize", "一格多少像素（= tileSize）", "map"),
  d("bwe.grid.toCell", "bwe.grid.toCell(x, y) → {cx, cy}", "世界像素 → 格子（floor）", "map"),
  d("bwe.grid.toWorld", "bwe.grid.toWorld(cx, cy) → {x, y}", "格子 → 格子中心的世界像素", "map"),
  d("bwe.grid.snap", "bwe.grid.snap(x, y) → {x, y}", "对齐到格子中心", "map"),
  d("bwe.tilemap.get", "bwe.tilemap.get(cx, cy) → number", "取格子上的瓦片 id（0 = 空）", "map"),
  d("bwe.tilemap.set", "bwe.tilemap.set(cx, cy, tileId)", "写格子", "map"),
  d("bwe.tilemap.solid", "bwe.tilemap.solid(cx, cy) → boolean", "这一格是否阻挡", "map"),
  d("bwe.tilemap.setSolid", "bwe.tilemap.setSolid(tileId, solid)", "设置某种瓦片是否阻挡", "map"),
  d("bwe.tilemap.blocked", "bwe.tilemap.blocked(x, y, w, h) → boolean", "矩形是否撞墙（AABB，像素）", "map"),
  d("bwe.tilemap.raycast", "bwe.tilemap.raycast(x1, y1, x2, y2) → {hit, x, y, cx, cy}", "射线与阻挡格子求交", "map"),

  // ===== 寻路 =====
  d("bwe.nav.find", "bwe.nav.find(from, to, {diagonal = true, maxNodes = 2000, smooth = true}) → [{x, y}, …]", "A* 寻路，返回世界像素路径点", "nav"),
  d("bwe.nav.lineOfSight", "bwe.nav.lineOfSight(a, b) → boolean", "两点之间有没有阻挡", "nav"),
  d("bwe.nav.follow", "bwe.nav.follow(e, path, {speed = 100, arrive = 2, onArrive})", "让实体沿路径走", "nav"),
  d("bwe.nav.stop", "bwe.nav.stop(e)", "停下沿路径走", "nav"),

  // ===== 交互 =====
  d("bwe.interact.nearest", "bwe.interact.nearest(actor, {radius = 48, tag, filter}) → Entity | null", "找离 actor 最近的交互物", "interact"),
  d("bwe.interact.prompt", "bwe.interact.prompt(text | null)", "在交互物头顶画提示；null 清除", "interact"),
  d("bwe.interact.setKey", "bwe.interact.setKey(\"KeyE\")", "设置交互触发键", "interact"),
  d("bwe.interact.onTrigger", "bwe.interact.onTrigger(fn(target, actor))", "玩家按触发键时回调", "interact"),

  // ===== 生成器 =====
  d("bwe.spawner.create", "bwe.spawner.create({asset?, script?, count = 1, interval = 2, max = 10, area?, onSpawn}) → handle", "定时刷怪 / 掉落", "spawner"),
  d("bwe.spawner.stop", "bwe.spawner.stop(handle)", "停掉生成器", "spawner"),

  // ===== 预制体 / 对象池 =====
  d("bwe.prefab.define", "bwe.prefab.define(name, spec) → boolean", "注册 / 覆盖一个预制体模板（spec 字段同 boot.json prefabs[]）", "prefab"),
  d("bwe.prefab.get", "bwe.prefab.get(name) → PrefabSpec | null", "读模板的深拷贝快照（改它不影响注册表）", "prefab"),
  d("bwe.prefab.list", "bwe.prefab.list() → string[]", "所有模板名（顺序 = define 顺序）", "prefab"),
  d("bwe.prefab.has", "bwe.prefab.has(name) → boolean", "模板是否存在", "prefab"),
  d("bwe.prefab.remove", "bwe.prefab.remove(name) → boolean", "移除模板（已生成的实例不受影响）", "prefab"),
  d("bwe.prefab.spawn", "bwe.prefab.spawn(name, {x, y, z, rotation, scaleX, scaleY, tags, modules, props, name, parent, jitter}?) → Entity | null", "实例化；opts 在模板之上覆盖。给了 x/y 就精确落位不抖，jitter:true 才抖", "prefab"),
  d("bwe.prefab.spawnMany", "bwe.prefab.spawnMany(name, optsList) → Entity[]", "批量实例化（每个元素一份覆盖）", "prefab"),
  d("bwe.prefab.count", "bwe.prefab.count(name) → number", "当前存活的该预制体实例数（对象池 / 上限用）", "prefab"),
  d("bwe.prefab.fromEntity", "bwe.prefab.fromEntity(e, name?) → string | null", "把场上实体抓成模板并注册（含模块/属性/标签/子精灵）", "prefab"),
  d("bwe.pool.create", "bwe.pool.create(prefabName, capacity?, {prewarm}?) → handle", "建对象池；prewarm 会预生成隐藏实例。预制体不存在返回 -1", "prefab"),
  d("bwe.pool.acquire", "bwe.pool.acquire(handle, x, y) → Entity | null", "取一个实例（优先复用空闲），池满返回 null", "prefab"),
  d("bwe.pool.release", "bwe.pool.release(handle, e) → boolean", "归还实例；不属于该池 / 已销毁返回 false", "prefab"),
  d("bwe.pool.stats", "bwe.pool.stats(handle) → {idle, active, total, capacity} | null", "池统计", "prefab"),

  // ===== 辅助函数 =====
  d("bwe.random", "bwe.random(min, max) → number", "随机小数", "util"),
  d("bwe.randomInt", "bwe.randomInt(min, max) → number", "随机整数（含两端）", "util"),
  d("bwe.chance", "bwe.chance(p) → boolean", "概率命中（p = 0~1）", "util"),
  d("bwe.pick", "bwe.pick(arr) → element", "从数组里随机取一个", "util"),
  d("bwe.clamp", "bwe.clamp(v, a, b) → number", "夹取到 [a, b]", "util"),
  d("bwe.lerp", "bwe.lerp(a, b, t) → number", "线性插值", "util"),
  d("bwe.dist", "bwe.dist(x1, y1, x2, y2) → number", "两点距离", "util"),
  // 脚本公开字段：顶层声明默认值，回调里取「默认值 ∪ 本对象的覆盖值」（按对象作用域）
  d("bwe.params", "bwe.params(defs?) → Record<string, unknown>", "声明/读取脚本公开字段：顶层 bwe.params({...}) 给默认值，回调里 bwe.params() 取本对象的有效值（等价 ctx.params）", "util"),
  d("bwe.log", "bwe.log(...args)", "写日志到 Build/bwe.log（带脚本名）", "util"),
  d("bwe.error", "bwe.error(...args)", "写错误日志", "util"),
  d("bwe.call", "bwe.call(scriptName, handlerName, ...args)", "调用另一个脚本里的具名函数", "util"),
  d("bwe.has", "bwe.has(scriptName) → boolean", "该脚本是否存在", "util"),
  d("bwe.scripts.call", "bwe.scripts.call(scriptName, handlerName, ...args)", "bwe.call 的等价写法", "util"),
  d("bwe.scripts.has", "bwe.scripts.has(scriptName) → boolean", "该脚本是否存在", "util"),

  // ===== 涌现式模拟：材质 =====
  d("bwe.material.define", "bwe.material.define(name, {flammable, burnTime, conductive, wet, hardness, density, tags})", "定义 / 覆盖材质：一切燃烧与导电源自这些数字", "material"),
  d("bwe.material.get", "bwe.material.get(name) → Material | null", "读材质属性", "material"),
  d("bwe.material.tags", "bwe.material.tags(name) → string[]", "材质的语义标签（如 plant / liquid）", "material"),
  d("bwe.material.of", "bwe.material.of(cx, cy) → string | null", "该格子的材质名", "material"),
  d("bwe.material.setTile", "bwe.material.setTile(cx, cy, name | null)", "改格子材质（设成 water 就成了永久水源）", "material"),
  d("bwe.material.ofEntity", "bwe.material.ofEntity(e) → string | null", "实体材质", "material"),
  d("bwe.material.setEntity", "bwe.material.setEntity(e, name | null)", "改实体材质", "material"),

  // ===== 涌现式模拟：格子场 =====
  d("bwe.field.emit", "bwe.field.emit(channel, cx, cy, intensity = 1)", "点火 / 灌水 / 放烟", "field"),
  d("bwe.field.sample", "bwe.field.sample(channel, cx, cy) → number", "读某通道强度 0~1", "field"),
  d("bwe.field.clear", "bwe.field.clear(channel)", "清空通道", "field"),
  d("bwe.field.tickRate", "bwe.field.tickRate(sec = 0.1) → number", "模拟步长（与帧率解耦）", "field"),
  d("bwe.field.channel", "bwe.field.channel(name) → {max(v)}", "自定义通道", "field"),
  d("bwe.field.wind", "bwe.field.wind(dx, dy) → Vec2", "风向：影响烟雾与火势偏向", "field"),
  d("bwe.field.on", "bwe.field.on(\"ignite\" | \"extinguish\" | \"burned\", fn) → 取消函数", "场事件：被点燃 / 熄灭 / 烧尽", "field"),
  d("bwe.field.off", "bwe.field.off(ev, fn?)", "取消订阅：给 fn 只摘那一个，不给 fn 清空该事件全部回调", "field"),
  d("bwe.field.burning", "bwe.field.burning() → [{cx, cy, intensity, material}]", "当前正在燃烧的格子", "field"),

  // ===== 涌现式模拟：噪音 =====
  d("bwe.noise.emit", "bwe.noise.emit(x, y, {radius = 260, intensity = 1, tag})", "制造噪音（墙会衰减，AI 会听见）", "sense"),
  d("bwe.noise.events", "bwe.noise.events() → NoiseEvent[]", "最近的噪音事件", "sense"),

  // ===== 涌现式模拟：感知 / 阵营 / 状态机 =====
  d("bwe.sense.canSee", "bwe.sense.canSee(a, b) → boolean", "看得见？（半径 + 视野角 + 瓦片遮挡 + 烟雾）", "sense"),
  d("bwe.sense.inSightRange", "bwe.sense.inSightRange(a, b) → boolean", "只判距离", "sense"),
  d("bwe.sense.audible", "bwe.sense.audible(e) → boolean", "听得到最近的噪音？", "sense"),
  d("bwe.sense.lastKnown", "bwe.sense.lastKnown(e) → {x, y, age, from} | null", "记忆中的目标位置（会随时间过期）", "sense"),
  d("bwe.faction.set", "bwe.faction.set(e, name | null)", "设置阵营", "sense"),
  d("bwe.faction.relation", "bwe.faction.relation(a, b, v = ?) → number", "关系：-1 敌 / 0 中立 / 1 友", "sense"),
  d("bwe.faction.hostile", "bwe.faction.hostile(a, b) → boolean", "是否敌对", "sense"),
  d("bwe.faction.members", "bwe.faction.members(name) → Entity[]", "该阵营成员", "sense"),
  d("bwe.ai.attach", "bwe.ai.attach(e, {sight = 260, fov = 120, hearing = 300, memory = 6, speed = 90})", "挂感知/记忆/状态（决策仍写在脚本里）", "sense"),
  d("bwe.ai.detach", "bwe.ai.detach(e)", "摘掉感知", "sense"),
  d("bwe.ai.state", "bwe.ai.state(e) → string | null", "当前状态字符串（引擎不做决策）", "sense"),
  d("bwe.ai.setState", "bwe.ai.setState(e, s)", "设置状态", "sense"),
  d("bwe.ai.target", "bwe.ai.target(e) → Entity | null", "引擎锁定的最近可见敌对目标", "sense"),
  d("bwe.ai.alert", "bwe.ai.alert(e, pos | entity)", "同阵营警报（一跳延迟传播）", "sense"),
  d("bwe.ai.onAlert", "bwe.ai.onAlert(fn({entity, position, from})) → 取消函数", "收到同伴警报", "sense"),
  d("bwe.ai.onSpot", "bwe.ai.onSpot(fn({entity, target})) → 取消函数", "发现新目标", "sense"),
  d("bwe.target.cell", "bwe.target.cell() → {cx, cy, x, y, material} | null", "鼠标所在格子", "sense"),
  d("bwe.target.entity", "bwe.target.entity() → Entity | null", "鼠标下最上层实体", "sense"),
  d("bwe.target.inFront", "bwe.target.inFront(e, range = 1格) → Entity | cell | null", "实体面前的东西", "sense"),

  // ===== 涌现式模拟：物理 =====
  d("bwe.physics.enable", "bwe.physics.enable() / bwe.physics.enabled()", "打开物理子步（默认关）；enabled() 读当前状态", "physics"),
  d("bwe.physics.enabled", "bwe.physics.enabled() → boolean", "物理子步当前是否开启（与 enable 同一节）", "physics"),
  d("bwe.physics.gravity", "bwe.physics.gravity(gy = 0) → number", "重力 px/s²（俯视角默认 0）", "physics"),
  d("bwe.physics.body", "bwe.physics.body(e, {type, shape, radius, halfW, halfH, density, friction, restitution, sensor})", "给实体建刚体（瓦片阻挡会自动成为静态墙）", "physics"),
  d("bwe.physics.remove", "bwe.physics.remove(e)", "移除刚体", "physics"),
  d("bwe.physics.applyImpulse", "bwe.physics.applyImpulse(e, ix, iy) → boolean", "施加冲量（400 ≈ 箱子 400px/s）", "physics"),
  d("bwe.physics.velocity", "bwe.physics.velocity(e) → {vx, vy}", "读速度", "physics"),
  d("bwe.physics.setVelocity", "bwe.physics.setVelocity(e, vx, vy)", "设速度", "physics"),
  d("bwe.physics.throwAt", "bwe.physics.throwAt(e, tx, ty, speed = 自适应)", "朝目标抛出（丢油瓶）", "physics"),
  d("bwe.physics.raycast", "bwe.physics.raycast(x1, y1, x2, y2) → {hit, x, y, entity, nx, ny, fraction, sensor}", "射线检测", "physics"),
  d("bwe.physics.queryPoint", "bwe.physics.queryPoint(x, y) → Entity[]", "点查询", "physics"),
  d("bwe.physics.queryAABB", "bwe.physics.queryAABB(x, y, w, h) → Entity[]", "矩形查询（x,y 为左上角）", "physics"),
  d("bwe.physics.on", "bwe.physics.on(\"collision\", fn({a, b, impulse, sensor})) → 取消函数", "碰撞回调", "physics"),
  d("bwe.physics.debug", "bwe.physics.debug(on = true) → boolean", "画碰撞体线框", "physics"),
  d("bwe.physics.bodyCount", "bwe.physics.bodyCount() → number", "当前动态刚体数量（性能水位观察）", "physics"),
  d("bwe.physics.tileBodyCount", "bwe.physics.tileBodyCount() → number", "当前瓦片静态墙体数量（建/拆 tilemap 后核对）", "physics"),

  // ===== 涌现式模拟：确定性随机 =====
  d("bwe.seed.set", "bwe.seed.set(n)", "固定随机种子（同种子 + 同输入 ⇒ 同结果，对拍用）", "util"),
  d("bwe.seed.get", "bwe.seed.get() → number", "当前种子", "util"),
  d("bwe.seed.reset", "bwe.seed.reset()", "恢复默认种子", "util"),
  d("bwe.seed.defaultSeed", "bwe.seed.defaultSeed() → number", "引擎内置的默认种子常量", "util"),

  // ===== 开放世界：场景 =====
  d("bwe.scene.list", "bwe.scene.list() → SceneListItem[]", "工程里的全部场景（name / file / index / width / height / current）", "scene"),
  d("bwe.scene.current", "bwe.scene.current() → SceneCurrent | null", "当前场景信息（含 epoch / tileSize）", "scene"),
  d("bwe.scene.count", "bwe.scene.count() → number", "场景总数", "scene"),
  d("bwe.scene.has", "bwe.scene.has(name) → boolean", "是否存在该场景（名字 / 文件名 / 去扩展名 basename 都认）", "scene"),
  d("bwe.scene.switchTo", "bwe.scene.switchTo(name) → boolean", "请求切场景：只登记，帧末生效；返回是否登记成功", "scene"),
  d("bwe.scene.load", "bwe.scene.load(name) → boolean", "switchTo 的别名（加载并切过去）", "scene"),
  d("bwe.scene.pending", "bwe.scene.pending() → string | null", "待切换的场景名（没有 = null）", "scene"),
  d("bwe.scene.epoch", "bwe.scene.epoch() → number", "场景代数：每次真正切换 +1", "scene"),
  d("bwe.scene.on", "bwe.scene.on(\"willChange\" | \"changed\", fn({name, epoch}))", "注册切换回调（切换前 / 切换后），返回该函数，未知事件返回 null", "scene"),
  d("bwe.scene.off", "bwe.scene.off(fn) → boolean", "按函数引用摘掉切换回调", "scene"),

  // ===== 开放世界：空间 / 多层建筑 =====
  d("bwe.spatial.hasData", "bwe.spatial.hasData() → boolean", "当前场景是否有楼层/区域数据（旧工程 = false，所有查询不阻挡）", "spatial"),
  d("bwe.spatial.buildingCount", "bwe.spatial.buildingCount() → number", "建筑数量", "spatial"),
  d("bwe.spatial.zoneCount", "bwe.spatial.zoneCount() → number", "区域数量", "spatial"),
  d("bwe.spatial.linkCount", "bwe.spatial.linkCount() → number", "垂直连接（楼梯/电梯）数量", "spatial"),
  d("bwe.spatial.all", "bwe.spatial.all() → SpatialZone[]", "全部区域（只读快照）", "spatial"),
  d("bwe.spatial.byId", "bwe.spatial.byId(id) → SpatialZone | null", "按区域 id 取", "spatial"),
  d("bwe.spatial.at", "bwe.spatial.at(x, y) → SpatialZone | null", "坐标所在的区域", "spatial"),
  d("bwe.spatial.current", "bwe.spatial.current() → CurrentSpace | null", "玩家当前空间 {zoneId, buildingId, floorId, level, indoor}", "spatial"),
  d("bwe.spatial.level", "bwe.spatial.level() → number", "玩家楼层序号（无数据 = 0）", "spatial"),
  d("bwe.spatial.levelOf", "bwe.spatial.levelOf(e) → number", "某实体所在楼层序号（跨层判断的关键）", "spatial"),
  d("bwe.spatial.zoneOf", "bwe.spatial.zoneOf(e) → SpatialZone | null", "某实体所在区域", "spatial"),
  d("bwe.spatial.visibility", "bwe.spatial.visibility(zoneId | zone) → {renderVisible, collisionEnabled, navPassable}", "某区域本帧解析出的三个运行时状态", "spatial"),
  d("bwe.spatial.links", "bwe.spatial.links() → SpatialLink[]", "全部垂直连接", "spatial"),
  d("bwe.spatial.link", "bwe.spatial.link(id) → SpatialLink | null", "按 id 取连接", "spatial"),
  d("bwe.spatial.linkBetween", "bwe.spatial.linkBetween(aLevel, bLevel) → SpatialLink | null", "两楼层之间是否有连接（“楼梯存在吗”）", "spatial"),
  d("bwe.spatial.canReachLevel", "bwe.spatial.canReachLevel(from, to) → boolean", "靠 link 能否从一层到另一层", "spatial"),
  d("bwe.spatial.useLink", "bwe.spatial.useLink(id, e) → boolean", "把实体沿连接传送到另一端（电梯/楼梯搬家）", "spatial"),
  d("bwe.spatial.enter", "bwe.spatial.enter(zoneId | zone, e?) → boolean", "从门口走进某区域（设置楼层归属）；省略 e = 作用于玩家", "spatial"),
  d("bwe.spatial.leave", "bwe.spatial.leave(e?) → boolean", "走出建筑，楼层归属退回地面层；省略 e = 作用于玩家", "spatial"),
  d("bwe.spatial.setVisibilityRule", "bwe.spatial.setVisibilityRule(rule = \"default\") → boolean", "自定义楼层可见性规则；v1 只接受 default，其它值返回 false", "spatial"),
  d("bwe.spatial.clear", "bwe.spatial.clear() → boolean", "清空空间索引（场景卸载时引擎自己会清）", "spatial"),

  // ===== 开放世界：碰撞 =====
  d("bwe.collision.on", "bwe.collision.on(ev, fn({event, self, other, a, b, sensor}), e?)", "订阅 enter / stay / exit / trigger* 碰撞事件；传 e = 只看该实体", "collision"),
  d("bwe.collision.off", "bwe.collision.off(fn) → boolean", "摘掉碰撞回调（全局与按实体的都会找）", "collision"),
  d("bwe.collision.query", "bwe.collision.query(rect) → Entity[]", "矩形几何查询（全部可见实体）", "collision"),
  d("bwe.collision.overlapCircle", "bwe.collision.overlapCircle(x, y, r) → Entity[]", "圆形查询（圆 vs AABB）", "collision"),
  d("bwe.collision.raycast", "bwe.collision.raycast(x1, y1, x2, y2) → {hit, x, y, entity, distance}", "线段射线检测（纯几何，不含瓦片）", "collision"),
  d("bwe.collision.setTrigger", "bwe.collision.setTrigger(e, on = true) → boolean", "把实体的碰撞体标为传感器（触发区）", "collision"),
  d("bwe.collision.isTrigger", "bwe.collision.isTrigger(e) → boolean", "该实体是否传感器", "collision"),
  d("bwe.collision.contacts", "bwe.collision.contacts(e) → Entity[]", "当前与该实体接触的实体（几何重叠）", "collision"),
  d("bwe.collision.count", "bwe.collision.count() → number", "当前接触对数（诊断/断言用）", "collision"),

  // ===== 开放世界：输入动作映射 =====
  d("bwe.actions.bind", "bwe.actions.bind({action: [\"KeyW\", ...]}) → boolean", "批量写入动作映射（合并，不动未提到的动作）", "actions"),
  d("bwe.actions.unbind", "bwe.actions.unbind(action) → boolean", "解绑单个动作", "actions"),
  d("bwe.actions.reset", "bwe.actions.reset() → boolean", "恢复默认映射", "actions"),
  d("bwe.actions.actions", "bwe.actions.actions() → string[]", "全部动作名", "actions"),
  d("bwe.actions.keys", "bwe.actions.keys(action) → string[]", "某动作绑定的键", "actions"),
  d("bwe.actions.down", "bwe.actions.down(action) → boolean", "持续按住（且当前上下文放行）", "actions"),
  d("bwe.actions.pressed", "bwe.actions.pressed(action) → boolean", "本帧刚按下", "actions"),
  d("bwe.actions.released", "bwe.actions.released(action) → boolean", "本帧刚松开", "actions"),
  d("bwe.actions.axis", "bwe.actions.axis() → {x, y}", "方向轴（用 move_* 动作算，已归一化，Y 向下）", "actions"),
  d("bwe.actions.context", "bwe.actions.context() → string", "当前上下文名（栈空 = \"game\"）", "actions"),
  d("bwe.actions.pushContext", "bwe.actions.pushContext(name) → boolean", "压入上下文（如 \"ui\"）", "actions"),
  d("bwe.actions.popContext", "bwe.actions.popContext() → string | null", "弹出上下文，返回被弹出的名字", "actions"),
  d("bwe.actions.setContext", "bwe.actions.setContext(name) → boolean", "直接设为单一上下文（空串 = 清空栈）", "actions"),
  d("bwe.actions.allow", "bwe.actions.allow(context, actions[]) → boolean", "声明某上下文只放行哪些动作（不调用 = 全部放行）", "actions"),
  d("bwe.actions.on", "bwe.actions.on(action, fn)", "订阅动作触发（按下时派发），返回该函数", "actions"),
  d("bwe.actions.off", "bwe.actions.off(fn) → boolean", "摘掉动作回调；也支持 off(action, fn)", "actions"),
  d("bwe.actions.focused", "bwe.actions.focused() → boolean", "窗口是否有焦点（失焦时所有动作立即为 false）", "actions"),

  // ===== 开放世界：路网 =====
  d("bwe.road.hasData", "bwe.road.hasData() → boolean", "当前场景是否有路网数据", "road"),
  d("bwe.road.nodeCount", "bwe.road.nodeCount() → number", "路网节点数量", "road"),
  d("bwe.road.edgeCount", "bwe.road.edgeCount() → number", "路网路段数量", "road"),
  d("bwe.road.nodes", "bwe.road.nodes() → RoadNode[]", "全部节点 {id, x, y, kind}", "road"),
  d("bwe.road.edges", "bwe.road.edges() → RoadEdge[]", "全部路段 {from, to, width, speedLimit, oneway, length}", "road"),
  d("bwe.road.node", "bwe.road.node(id) → RoadNode | null", "按 id 取节点", "road"),
  d("bwe.road.nearest", "bwe.road.nearest(x, y) → {id, x, y, kind, dist} | null", "最近的节点（带距离）", "road"),
  d("bwe.road.route", "bwe.road.route(from, to) → RoadNode[]", "最短时间路径（权重 = 长度 / 限速）；不可达 = 空数组", "road"),
  d("bwe.road.canReach", "bwe.road.canReach(from, to) → boolean", "两点是否连通", "road"),
  d("bwe.road.routeThrough", "bwe.road.routeThrough(from, via, to) → RoadNode[]", "途经点的两段路径（先接客再送客），任一段不可达 = 空", "road"),
  d("bwe.road.cachedRoutes", "bwe.road.cachedRoutes() → number", "当前缓存的路径条数（诊断用）", "road"),
  d("bwe.road.clear", "bwe.road.clear() → boolean", "清空路径缓存", "road"),

  // ===== 开放世界：车辆 =====
  d("bwe.vehicle.spawn", "bwe.vehicle.spawn(opts) → Entity | null", "生成一辆车（opts 与 world.spawn 同构，另认 kind）", "vehicle"),
  d("bwe.vehicle.of", "bwe.vehicle.of(e) → VehicleInfo | null", "车辆完整状态 {id, kind, speed, speedLimit, heading, damage, driver, autoDrive, ...}", "vehicle"),
  d("bwe.vehicle.isVehicle", "bwe.vehicle.isVehicle(e) → boolean", "该实体是否车辆", "vehicle"),
  d("bwe.vehicle.driver", "bwe.vehicle.driver(e) → Entity | null", "该车的驾驶员", "vehicle"),
  d("bwe.vehicle.vehicleOf", "bwe.vehicle.vehicleOf(e) → Entity | null", "该实体正在驾驶的车", "vehicle"),
  d("bwe.vehicle.enter", "bwe.vehicle.enter(driver, vehicle) → boolean", "上车", "vehicle"),
  d("bwe.vehicle.exit", "bwe.vehicle.exit(driver) → boolean", "下车（车留下）", "vehicle"),
  d("bwe.vehicle.hijack", "bwe.vehicle.hijack(hijacker, vehicle) → boolean", "劫车：原驾驶员被踢出并派发 hijack 事件", "vehicle"),
  d("bwe.vehicle.throttle", "bwe.vehicle.throttle(e, v = 1) → boolean", "油门 0..1", "vehicle"),
  d("bwe.vehicle.brake", "bwe.vehicle.brake(e, v = 1) → boolean", "制动 0..1", "vehicle"),
  d("bwe.vehicle.steer", "bwe.vehicle.steer(e, v = 0) → boolean", "转向 -1..1", "vehicle"),
  d("bwe.vehicle.speed", "bwe.vehicle.speed(e) → number", "当前速度 px/s", "vehicle"),
  d("bwe.vehicle.heading", "bwe.vehicle.heading(e) → number", "朝向角度（0 = 朝右，顺时针为正）", "vehicle"),
  d("bwe.vehicle.damage", "bwe.vehicle.damage(e, n = ?) → number", "读损伤，或累加损伤后返回 0..1", "vehicle"),
  d("bwe.vehicle.followRoad", "bwe.vehicle.followRoad(e, target, {onArrive} = {}) → boolean", "沿路网自动驾驶到某节点，到达时回调", "vehicle"),
  d("bwe.vehicle.stop", "bwe.vehicle.stop(e) → boolean", "停车（取消自动驾驶与路线、油门/制动归零、驻车平滑减速到 0）", "vehicle"),
  d("bwe.vehicle.setSpeed", "bwe.vehicle.setSpeed(e, v) → boolean", "本帧把速度直接设为 v（px/s，负=倒车），不经过加减速；下一帧恢复正常物理", "vehicle"),
  d("bwe.vehicle.count", "bwe.vehicle.count() → number", "当前车辆总数", "vehicle"),
  d("bwe.vehicle.on", "bwe.vehicle.on(\"crash\" | \"hijack\" | \"enter\" | \"exit\" | \"arrive\", fn)", "订阅车辆事件，返回该函数", "vehicle"),
  d("bwe.vehicle.off", "bwe.vehicle.off(fn) → boolean", "摘掉车辆事件回调", "vehicle"),

  // ===== 开放世界：战斗 =====
  d("bwe.combat.params", "bwe.combat.params(kind) → WeaponParams | null", "查武器参数（数据驱动）；未知武器 = null", "combat"),
  d("bwe.combat.weapons", "bwe.combat.weapons() → string[]", "全部武器名", "combat"),
  d("bwe.combat.hit", "bwe.combat.hit({from, to, weapon}) → {hit, target, amount, blocked, killed}", "发起一次攻击并返回结果", "combat"),
  d("bwe.combat.defend", "bwe.combat.defend(e, on = true) → boolean", "开/关格挡", "combat"),
  d("bwe.combat.defending", "bwe.combat.defending(e) → boolean", "是否在格挡", "combat"),
  d("bwe.combat.setDefense", "bwe.combat.setDefense(e, v = 0.5) → boolean", "格挡减伤系数 0..1", "combat"),
  d("bwe.combat.weapon", "bwe.combat.weapon(e, name = ?) → string | boolean", "读武器（不传 name）或换武器（传 name，未知武器返回 false）", "combat"),
  d("bwe.combat.weaponOf", "bwe.combat.weaponOf(e) → string", "该实体当前武器名", "combat"),
  d("bwe.combat.switchWeapon", "bwe.combat.switchWeapon(e) → string | boolean", "循环切到下一把武器，返回新武器名", "combat"),
  d("bwe.combat.ammo", "bwe.combat.ammo(e) → number", "当前弹药", "combat"),
  d("bwe.combat.setAmmo", "bwe.combat.setAmmo(e, n) → boolean", "设置弹药", "combat"),
  d("bwe.combat.on", "bwe.combat.on(\"kill\" | \"damage\", fn({event, from, to, amount, killed}))", "订阅战斗事件，返回该函数", "combat"),
  d("bwe.combat.off", "bwe.combat.off(fn) → boolean", "摘掉战斗事件回调", "combat"),
  d("bwe.combat.inRange", "bwe.combat.inRange(a, b, range = 无限) → boolean", "两点距离是否在射程内", "combat"),

  // ===== 开放世界：调试绘制 =====
  d("bwe.debug.on", "bwe.debug.on() → boolean", "打开调试绘制总开关", "debug"),
  d("bwe.debug.off", "bwe.debug.off() → boolean", "关闭总开关并复位所有逐项开关", "debug"),
  d("bwe.debug.enabled", "bwe.debug.enabled() → boolean", "当前是否开启", "debug"),
  d("bwe.debug.colliders", "bwe.debug.colliders(on = true) → boolean", "画所有有碰撞盒的实体", "debug"),
  d("bwe.debug.paths", "bwe.debug.paths(on = true) → boolean", "画沿路径跟随的实体的路径", "debug"),
  d("bwe.debug.zones", "bwe.debug.zones(on = true) → boolean", "画空间区域边界", "debug"),
  d("bwe.debug.nav", "bwe.debug.nav(on = true) → boolean", "画瓦片阻挡图（小地图开销大，慎用）", "debug"),
  d("bwe.debug.box", "bwe.debug.box(x, y, w, h, color = \"#00ff88\")", "单次画矩形", "debug"),
  d("bwe.debug.circle", "bwe.debug.circle(x, y, r, color = \"#00ff88\")", "单次画圆", "debug"),
  d("bwe.debug.line", "bwe.debug.line(x1, y1, x2, y2, color = \"#00ff88\")", "单次画线", "debug"),
  d("bwe.debug.actor", "bwe.debug.actor(e, color = \"#00ff88\")", "画某实体的碰撞框", "debug"),
  d("bwe.debug.stats", "bwe.debug.stats() → {actors, pendingDestroy, sceneEpoch, colliders, vehicles, spatialZones, drawCommands, enabled}", "运行时统计（性能水位观察）", "debug"),
  d("bwe.debug.errors", "bwe.debug.errors() → [{script, message, line, count, frame}]", "最近 32 条脚本错误（环形缓冲，重复只累加 count）", "debug"),
  d("bwe.debug.clearErrors", "bwe.debug.clearErrors() → boolean", "清空错误缓冲并重置日志去重表", "debug"),
  d("bwe.debug.dumpErrors", "bwe.debug.dumpErrors(path = \"Build/diagnostics/script-errors.json\") → boolean", "把错误缓冲写成 JSON 落盘", "debug"),

  // ===== 脚本性能剖析 =====
  d("bwe.prof.enable", "bwe.prof.enable(on = true) → boolean", "开/关按每脚本累计执行耗时（默认关闭）", "debug"),
  d("bwe.prof.report", "bwe.prof.report() → {frames, avgMs, p50Ms, p95Ms, p99Ms, maxMs, scripts: [{name, p95Ms, calls}]}", "整帧耗时直方图 + 每脚本 p95", "debug"),
  d("bwe.prof.reset", "bwe.prof.reset() → boolean", "清空剖析样本（开关状态不变）", "debug"),

  // ===== 2D 光照 =====
  d("bwe.light.enabled", "bwe.light.enabled(flag?) → boolean", "读/写光照总开关（false = 完全不画光照层，等于白天）", "light"),
  d("bwe.light.ambient", "bwe.light.ambient(color?, intensity?) → {color, intensity}", "读/写环境光（省略 = 读；给任意一个 = 写）", "light"),
  d("bwe.light.darkness", "bwe.light.darkness(v?) → number", "读/写压暗程度 0..1（0 = 不压暗）", "light"),
  d("bwe.light.mode", "bwe.light.mode(m?) → string", "读/写模式 \"baked\" | \"dynamic\" | \"both\"", "light"),
  d("bwe.light.attach", "bwe.light.attach(e, opts?) → boolean", "把一盏光挂到实体上（跟随位置，自动动态）；已有则改参数", "light"),
  d("bwe.light.detach", "bwe.light.detach(e) → boolean", "移除实体上挂的光", "light"),
  d("bwe.light.set", "bwe.light.set(e, opts) → boolean", "改实体光的参数（没挂光返回 false）", "light"),
  d("bwe.light.add", "bwe.light.add(opts) → number", "在世界坐标处加一盏独立光，返回数字 handle", "light"),
  d("bwe.light.remove", "bwe.light.remove(handle) → boolean", "删独立光（按 add 返回的 handle）", "light"),
  d("bwe.light.list", "bwe.light.list() → [{id, x, y, radius, color, intensity, type, dynamic}]", "全部活光（场景光 + 脚本光 + 实体光）", "light"),
  d("bwe.light.stats", "bwe.light.stats() → {enabled, mode, lights, baked, dynamic, rebuilds, lastMs, texW, texH}", "光照运行时统计（性能水位观察）", "light"),
  d("bwe.light.rebuild", "bwe.light.rebuild() → boolean", "立刻重建动态光照贴图（下一帧绘制生效）", "light")
];

// ---------------- 查询 ----------------

/** 按分组返回，空分组不返回。 */
export function apiDocsByGroup(): { group: ApiGroup; items: ApiDoc[] }[] {
  const out: { group: ApiGroup; items: ApiDoc[] }[] = [];
  for (const g of API_GROUPS) {
    const items = API_DOCS.filter((x) => x.group === g.id);
    if (items.length) out.push({ group: g, items });
  }
  return out;
}

/**
 * 模糊搜索：名字、签名、说明、分组名都参与匹配。
 * 多个关键词用空格分开，全部命中才算（例如 "camera 抖动"）。
 */
export function searchApiDocs(query: string): ApiDoc[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return API_DOCS;
  const groupLabel = new Map(API_GROUPS.map((g) => [g.id, `${g.label} ${g.blurb}`.toLowerCase()]));
  return API_DOCS.filter((x) => {
    const hay = `${x.name} ${x.signature} ${x.desc} ${groupLabel.get(x.group) ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
