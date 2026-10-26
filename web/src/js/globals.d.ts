/**
 * 用户 JS 脚本的「生命周期全局函数」声明。
 *
 * 为什么不写在 bwe.d.ts 里：/api/js-check 会把 bwe.d.ts 拼给用户脚本做诊断，
 * 如果那份文件里出现 `declare function onStart(...)`，用户脚本自己写的
 * `function onStart(ctx) {}` 就会撞成「Overload signatures must all be ambient」。
 * 所以生命周期单独放这里，**只以独立 .d.ts 文件的方式加载**（IDE / 服务端的 program 模式），
 * 不做文本拼接。
 *
 * 运行时按事件调用脚本里的同名函数；没定义就直接跳过，不用写空壳。
 * 契约见 docs/scripting-api.md §1。
 */

/** 对象生成时执行一次。 */
declare function onStart(ctx: bwe.Ctx): void;

/** 每帧执行，dt = 秒。 */
declare function onUpdate(ctx: bwe.Ctx, dt: number): void;

/** 鼠标左键点中该对象。 */
declare function onClick(ctx: bwe.Ctx): void;

/** 触发区：别的对象进来了。 */
declare function onEnter(ctx: bwe.Ctx, other: bwe.Entity): void;

/** 触发区：别的对象离开了。 */
declare function onLeave(ctx: bwe.Ctx, other: bwe.Entity): void;

/** 玩家走近并按下交互键。 */
declare function onInteract(ctx: bwe.Ctx, actor: bwe.Entity): void;

/** 受到伤害。 */
declare function onDamage(ctx: bwe.Ctx, amount: number, from: bwe.Entity): void;

/** 生命值归零。 */
declare function onDeath(ctx: bwe.Ctx, by: bwe.Entity): void;

/** 销毁前（最后一个回调）。 */
declare function onDestroy(ctx: bwe.Ctx): void;

/** 任意按键按下（可选）。 */
declare function onKey(ctx: bwe.Ctx, key: string | number): void;

/** 场景脚本：场景载入完、对象 spawn 完之后执行一次。 */
declare function onSceneStart(ctx: bwe.Ctx): void;

/** 场景脚本：离开 / 销毁场景时执行。 */
declare function onSceneEnd(ctx: bwe.Ctx): void;
