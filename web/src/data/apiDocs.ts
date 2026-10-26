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
  | "life" | "world" | "entity" | "input" | "camera" | "time"
  | "draw" | "audio" | "save" | "map" | "nav" | "interact" | "spawner" | "util"
  | "material" | "field" | "sense" | "physics";

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
  { id: "physics", label: "物理 physics", blurb: "刚体、冲量、抛掷、射线（jbox2d）" }
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
  d("bwe.world.spawn", "bwe.world.spawn({x, y, asset?, name?, kind?, tags?, z?, halfW?, halfH?, script?, modules?}) → Entity", "运行时生成一个实体", "world"),
  d("bwe.world.destroy", "bwe.world.destroy(e)", "销毁实体（同 e.destroy()）", "world"),
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
  d("e.z", "e.z", "排序层级，大的盖住小的", "entity"),
  d("e.rotation", "e.rotation", "角度，顺时针，单位度", "entity"),
  d("e.visible", "e.visible", "显示 / 隐藏", "entity"),
  d("e.alive", "e.alive", "是否还活着（只读）", "entity"),
  d("e.tags", "e.tags → Tags", "标签集合：e.tags.has(\"敌人\") / e.tags.includes(\"敌人\")", "entity"),
  d("e.actor", "type Entity", "所有 e.xxx 里的 e 都是 Entity（脚本里 e = ctx.self）", "entity"),
  d("e.pos", "e.pos → {x, y}", "位置（只读快照）", "entity"),
  d("e.setPos", "e.setPos(x, y)", "设置位置（世界像素，中心点）", "entity"),
  d("e.size", "e.size → {w, h}", "可视化尺寸（与编辑器 halfW/halfH 同一套规则）", "entity"),
  d("e.setSize", "e.setSize(w, h)", "设置尺寸", "entity"),
  d("e.sprite", "e.sprite({asset, frame?, fps?, mode?})", "换精灵；mode: \"loop\" | \"once\" | \"first\"", "entity"),
  d("e.play", "e.play(assetName)", "直接换素材（沿用当前播放参数）", "entity"),
  d("e.setFrame", "e.setFrame(i)", "冻结到第 i 帧（0 起）", "entity"),
  d("e.prop", "e.prop(key, def?)", "读对象属性（与编辑器 props 打通）", "entity"),
  d("e.setProp", "e.setProp(key, val)", "写对象属性；会影响下一帧绘制尺寸", "entity"),
  d("e.hasModule", "e.hasModule(\"move.patrol\")", "有没有挂这个模块", "entity"),
  d("e.module", "e.module(id) → {enabled, get(k), set(k, v)}", "取模块实例，读写它的参数与开关", "entity"),
  d("e.modules", "e.modules() → ModuleInstance[]", "所有模块实例", "entity"),
  d("e.attach", "e.attach({asset, dx, dy, z, rotation}) → handle", "挂一个子精灵（武器 / 影子 / 特效）", "entity"),
  d("e.detach", "e.detach(handle)", "摘掉子精灵", "entity"),
  d("e.distanceTo", "e.distanceTo(other) → number", "到另一个实体的距离（像素）", "entity"),
  d("e.angleTo", "e.angleTo(other) → number", "到另一个实体的角度（度，0 = 向右）", "entity"),
  d("e.destroy", "e.destroy()", "销毁自己", "entity"),
  d("e.hp", "e.hp / e.hpMax", "生命值（读写 combat.health 模块，没有则用内部值）", "entity"),
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

  // ===== 辅助函数 =====
  d("bwe.random", "bwe.random(min, max) → number", "随机小数", "util"),
  d("bwe.randomInt", "bwe.randomInt(min, max) → number", "随机整数（含两端）", "util"),
  d("bwe.chance", "bwe.chance(p) → boolean", "概率命中（p = 0~1）", "util"),
  d("bwe.pick", "bwe.pick(arr) → element", "从数组里随机取一个", "util"),
  d("bwe.clamp", "bwe.clamp(v, a, b) → number", "夹取到 [a, b]", "util"),
  d("bwe.lerp", "bwe.lerp(a, b, t) → number", "线性插值", "util"),
  d("bwe.dist", "bwe.dist(x1, y1, x2, y2) → number", "两点距离", "util"),
  d("bwe.log", "bwe.log(...args)", "写日志到 Build/bwe.log（带脚本名）", "util"),
  d("bwe.error", "bwe.error(...args)", "写错误日志", "util"),
  d("bwe.call", "bwe.call(scriptName, handlerName, ...args)", "调用另一个脚本里的具名函数", "util"),
  d("bwe.has", "bwe.has(scriptName) → boolean", "该脚本是否存在", "util"),
  d("bwe.scripts.call", "bwe.scripts.call(scriptName, handlerName, ...args)", "bwe.call 的等价写法", "util"),

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
  d("bwe.physics.enable", "bwe.physics.enable() / enabled()", "打开物理子步（默认关）", "physics"),
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

  // ===== 涌现式模拟：确定性随机 =====
  d("bwe.seed.set", "bwe.seed.set(n)", "固定随机种子（同种子 + 同输入 ⇒ 同结果，对拍用）", "util"),
  d("bwe.seed.get", "bwe.seed.get() → number", "当前种子", "util"),
  d("bwe.seed.reset", "bwe.seed.reset()", "恢复默认种子", "util")
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
