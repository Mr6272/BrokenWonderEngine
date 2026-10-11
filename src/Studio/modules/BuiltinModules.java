package Studio.modules;

import Studio.data.ModuleCategory;
import Studio.data.ModuleDef;
import Studio.data.ParamDef;
import Studio.data.ParamType;
import Studio.data.Trigger;

/**
 * 内置模块库 —— 完全俯视角 RPG（奇幻 / 科幻）专用。
 *
 * 命名纪律（用户的核心诉求：不专业但一眼看懂）：
 * 1. 模块名用动词短语 + 对象，例："朝玩家走" 而不是 "FollowTarget"；
 * 2. 参数名用口语问句，例："走多快"、"离多远就停下"；
 * 3. detail 里只写"什么时候该用/会和什么冲突"，不写实现原理；
 * 4. 每个模块都必须给全默认值，拖进场景立刻能用。
 *
 * 被高频组合使用的模块，在 RulePacks 里再封装成整包。
 */
final class BuiltinModules {

    private BuiltinModules() {
    }

    static void register(ModuleRegistry r) {
        move(r);
        look(r);
        sense(r);
        rule(r);
        fight(r);
        talk(r);
        show(r);
    }

    // ---------------- 怎么动 ----------------

    private static void move(ModuleRegistry r) {
        add(r, def("move.follow", "朝玩家走", ModuleCategory.MOVE,
                "发现玩家后一路追过去",
                "适合敌人、跟随的同伴。追的过程会自动绕开墙壁与障碍（若场景里有「挡住去路」的物件）。"
                        + "和「原地巡逻」同时挂会互相抢控制权，一般二选一。")
                .params(
                        ParamDef.num("speed", "走多快", 60, 5, 400, "像素/秒", "数值越大追得越急"),
                        ParamDef.num("stopDist", "离多远就停下", 24, 0, 300, "像素", "贴到这么近就不再往前挤，避免抖"),
                        ParamDef.num("seeRange", "多远开始追", 200, 20, 1200, "像素", "超过这个距离就不理会玩家"),
                        ParamDef.bool("ignoreWalls", "可以穿墙", false, "打开后会无视墙壁直冲，通常只在剧情演出时用")
                )
                .triggers(Trigger.ALWAYS)
                .build());

        add(r, def("move.patrol", "来回巡逻", ModuleCategory.MOVE,
                "在两个点之间来回走",
                "适合守卫、巡逻的机器人。走到头会稍作停留再折返，观感比瞬间掉头自然。")
                .params(
                        ParamDef.num("speed", "走多快", 40, 5, 300, "像素/秒", ""),
                        ParamDef.num("range", "来回多远", 96, 8, 2000, "像素", "以放置点为中心，左右各走这么远"),
                        ParamDef.text("axis", "沿哪个方向", "左右", "填「左右」或「上下」"),
                        ParamDef.num("wait", "到头的停顿", 0.6f, 0, 10, "秒", "0 表示不停，立刻折返")
                )
                .triggers(Trigger.ALWAYS)
                .build());

        add(r, def("move.wander", "随意游荡", ModuleCategory.MOVE,
                "在附近随便走走停停",
                "适合村民、野生动物。不追人，只在指定范围内随机选点移动，让人感觉场景是活的。")
                .params(
                        ParamDef.num("speed", "走多快", 30, 5, 200, "像素/秒", ""),
                        ParamDef.num("area", "活动范围", 120, 16, 2000, "像素", "以放置点为圆心的半径"),
                        ParamDef.num("pauseMin", "最短停留", 0.8f, 0, 20, "秒", ""),
                        ParamDef.num("pauseMax", "最长停留", 2.5f, 0, 30, "秒", "")
                )
                .build());

        add(r, def("move.path", "沿指定路线走", ModuleCategory.MOVE,
                "按你画的路线一段段走",
                "适合剧情运镜、固定巡逻路线。路线用「路径点」对象画出来，这里填路径点所在标签即可。")
                .params(
                        ParamDef.num("speed", "走多快", 50, 5, 300, "像素/秒", ""),
                        ParamDef.ref("routeTag", "走哪条路线", ParamType.TAG, "在场景里给路径点对象打上同一个标签"),
                        ParamDef.bool("loop", "走完重头再来", true, "关掉则走到终点就停下"),
                        ParamDef.ref("onArrive", "走到后叫哪个模块", ParamType.TEXT, "可留空；填模块的自定义名字")
                )
                .build());

        add(r, def("move.pushable", "可以被推动", ModuleCategory.MOVE,
                "玩家撞上去能把它顶开",
                "适合箱子、木桶。打开后会参与物理，重量越大越难推。")
                .params(
                        ParamDef.num("weight", "有多重", 1, 0.1f, 50, "倍", "越大越推不动"),
                        ParamDef.bool("canFall", "会掉下悬崖", false, "关掉则永远浮在原地")
                )
                .build());

        add(r, def("move.locked", "钉死不动", ModuleCategory.MOVE,
                "任何力量都推不动它",
                "适合墙壁、山体、大树。这是「挡住去路」之外的另一半：它自己不动，但也别被别的模块挪走。")
                .build());

        add(r, def("move.flee", "躲着玩家跑", ModuleCategory.MOVE,
                "玩家一靠近就往反方向逃",
                "适合胆小的小动物、怕光的小怪。逃离时会尽量找没有障碍的方向。")
                .params(
                        ParamDef.num("speed", "跑多快", 70, 5, 400, "像素/秒", ""),
                        ParamDef.num("fearRange", "多近开始逃", 140, 20, 800, "像素", ""),
                        ParamDef.bool("giveUp", "拉开距离后停下", true, "关掉会一直逃到地图边界")
                )
                .build());
    }

    // ---------------- 怎么显示 ----------------

    private static void look(ModuleRegistry r) {
        add(r, def("look.faceMove", "走动时朝向转向", ModuleCategory.LOOK,
                "自动切换四方向（或八方向）的走路图",
                "俯视角 RPG 的标配。只要素材按「下、左、右、上」四组命名好，这里不用填任何东西。")
                .params(
                        ParamDef.pick("dirs", "几个方向", "四方向", "四方向素材少一半，八方向更顺滑",
                                "四方向", "八方向", "不转方向"),
                        ParamDef.num("fps", "每秒几帧", 8, 1, 30, "帧/秒", "走路动画的播放速度"),
                        ParamDef.text("idleName", "站着不动的图", "待机", "素材里的名字，找不到就用第一帧")
                )
                .build());

        add(r, def("look.playOnce", "播一遍就停", ModuleCategory.LOOK,
                "某个动作只播一次，播完停在最后一帧",
                "适合开门、爆炸、挥刀。和「循环播放」冲突，别同时挂。")
                .params(
                        ParamDef.ref("asset", "播哪个素材", ParamType.ASSET, "从素材库挑一条序列帧"),
                        ParamDef.num("fps", "每秒几帧", 12, 1, 60, "帧/秒", ""),
                        ParamDef.ref("thenDo", "播完做什么", ParamType.TEXT, "可留空；填另一个模块的自定义名字")
                )
                .build());

        add(r, def("look.blink", "一闪一闪", ModuleCategory.LOOK,
                "让它明暗或可见度周期变化",
                "适合发光的水晶、警示灯、任务提示点。比加特效便宜，观感也不差。")
                .params(
                        ParamDef.num("period", "一次闪多久", 1.2f, 0.1f, 20, "秒", "一个完整亮灭循环"),
                        ParamDef.num("minAlpha", "最暗到多少", 0.35f, 0, 1, "倍", "1 表示不闪"),
                        ParamDef.bool("scalePulse", "同时轻微涨缩", false, "像在呼吸")
                )
                .build());

        add(r, def("look.shadow", "脚下阴影", ModuleCategory.LOOK,
                "在脚下画一圈椭圆阴影",
                "俯视角最有效的「贴地感」来源。人物、箱子、树都建议加上。")
                .params(
                        ParamDef.num("w", "阴影宽", 28, 4, 400, "像素", ""),
                        ParamDef.num("h", "阴影高", 12, 2, 400, "像素", "俯视角一般取宽的一半"),
                        ParamDef.num("alpha", "深浅", 0.35f, 0, 1, "倍", "")
                )
                .build());

        add(r, def("look.sortByY", "按前后自动遮挡", ModuleCategory.LOOK,
                "站在更下面的人挡住上面的人",
                "俯视角 2D 必须开。否则人物会穿过桌子、树冠会盖住头顶。")
                .build());

        add(r, def("look.light", "发一圈光", ModuleCategory.LOOK,
                "在它周围照亮一圈",
                "适合火把、路灯、魔法阵。夜间场景里，这是氛围的主力。")
                .params(
                        ParamDef.num("radius", "照多远", 140, 16, 1200, "像素", ""),
                        ParamDef.text("color", "光的颜色", "#FFC978", "十六进制，如 #80CCFF"),
                        ParamDef.num("strength", "强度", 0.8f, 0, 2, "倍", ""),
                        ParamDef.bool("flicker", "会闪动", false, "像火苗一样")
                )
                .build());
    }

    // ---------------- 怎么感知 ----------------

    private static void sense(ModuleRegistry r) {
        add(r, def("sense.block", "挡住去路", ModuleCategory.SENSE,
                "别人走不过去（墙、家具、水）",
                "俯视角地图的「墙模块」。它不主动做任何事，只负责不让别人穿过。"
                        + "水、岩浆这类「能走但有代价」的地形，改用「走上去受伤/减速」。")
                .params(
                        ParamDef.pick("shape", "阻挡范围", "整块", "贴图不规则时用「身体大小」更自然",
                                "整块", "身体大小"),
                        ParamDef.bool("seeThrough", "不挡视线", false, "打开后敌人能隔着它看见你"),
                        ParamDef.bool("blockFlying", "也挡飞行", false, "关掉则飞行的东西可以越过")
                )
                .build());

        add(r, def("sense.range", "范围内有没有东西", ModuleCategory.SENSE,
                "检查以自己为圆心的一圈里有什么",
                "这是所有「范围检查」的总开关：后面接「有东西进来时」或「变量到达条件时」使用。"
                        + "它自己只负责判断，不负责反应。")
                .params(
                        ParamDef.num("radius", "检查半径", 96, 4, 2000, "像素", ""),
                        ParamDef.pick("who", "检查谁", "玩家", "按标签匹配可以一次管一类东西",
                                "玩家", "全部角色", "同标签的物件", "任意东西"),
                        ParamDef.ref("tag", "指定标签", ParamType.TAG, "上一步选「同标签」时用"),
                        ParamDef.bool("needSight", "需要看得见", false, "打开后被墙挡住不算进范围")
                )
                .build());

        add(r, def("sense.dist", "离玩家有多远", ModuleCategory.SENSE,
                "把距离算出来，供别的模块判断",
                "用于「太远就不追」「近到一定程度才说话」这类逻辑。数值存进变量，别的模块读它。")
                .params(
                        ParamDef.text("var", "存到哪个变量", "距离", "给这个名字起个好记的，别的模块按名字读"),
                        ParamDef.bool("rounded", "四舍五入到整格", true, "关掉则保留精确像素")
                )
                .build());

        add(r, def("sense.lineOfSight", "能不能看见玩家", ModuleCategory.SENSE,
                "直线中间没有墙就算看得见",
                "藏在箱子后面就看不见了 —— 潜行玩法的基础。")
                .params(
                        ParamDef.num("range", "看多远", 260, 8, 1600, "像素", ""),
                        ParamDef.num("fov", "视野角度", 120, 10, 360, "度", "360 表示不需要转头就能看见"),
                        ParamDef.bool("instant", "立刻发现", true, "关掉则要在视野里待一会儿才被发现"),
                        ParamDef.num("delay", "要盯多久", 0.8f, 0.1f, 10, "秒", "只有上面关掉时才起作用")
                )
                .build());

        add(r, def("sense.onTile", "踩在什么地形上", ModuleCategory.SENSE,
                "判断脚下是什么地面",
                "用于「走在草丛里敌人看不见」「踩到岩浆掉血」「走进传送阵」。")
                .params(
                        ParamDef.ref("tileTag", "哪种地形", ParamType.TAG, "给地面块打上标签后在这里选"),
                        ParamDef.ref("thenDo", "踩上后叫哪个模块", ParamType.TEXT, "填模块的自定义名字")
                )
                .build());

        add(r, def("sense.overlap", "和什么东西重叠了", ModuleCategory.SENSE,
                "精确判断自己的范围与指定对象是否压在一起",
                "比范围检查更准，但更耗性能，适合数量不多的关键物件，例如钥匙与锁孔。")
                .params(
                        ParamDef.ref("targetTag", "和什么重叠", ParamType.TAG, ""),
                        ParamDef.ref("thenDo", "重叠后叫哪个模块", ParamType.TEXT, "")
                )
                .build());
    }

    // ---------------- 什么时候做 ----------------

    private static void rule(ModuleRegistry r) {
        add(r, def("rule.click", "被点击时", ModuleCategory.RULE,
                "玩家用鼠标点它才算数",
                "这是「点击模块」。可以限制点击距离，避免隔着半张地图点开宝箱。")
                .params(
                        ParamDef.ref("thenDo", "点了做什么", ParamType.TEXT, "填另一个模块的自定义名字"),
                        ParamDef.num("maxDist", "最远能点多远", 64, 0, 2000, "像素", "0 表示不限距离"),
                        ParamDef.bool("onlyOnce", "只响应第一次", false, "适合一次性机关")
                )
                .build());

        add(r, def("rule.touch", "碰到东西时", ModuleCategory.RULE,
                "和别的东西撞上时触发",
                "适合陷阱、掉落的物品、会咬人的怪物。可以按标签指定只对某类东西反应。")
                .params(
                        ParamDef.ref("withTag", "和什么东西碰", ParamType.TAG, "留空表示任何东西都算"),
                        ParamDef.ref("thenDo", "碰到后做什么", ParamType.TEXT, ""),
                        ParamDef.num("cooldown", "多久内不重复触发", 0.5f, 0, 30, "秒", "防止一帧内触发几十次")
                )
                .build());

        add(r, def("rule.enterArea", "有东西进来时", ModuleCategory.RULE,
                "有东西进入指定范围的那一刻做一次",
                "配「范围内有没有东西」用，是做伏击、开门、播放剧情最常用的组合。"
                        + "注意：只触发一次进入，停在范围里不会反复触发。")
                .params(
                        ParamDef.num("radius", "范围半径", 120, 4, 2000, "像素", ""),
                        ParamDef.pick("who", "什么东西进来", "玩家", "", "玩家", "全部角色", "任意东西"),
                        ParamDef.ref("thenDo", "进来后做什么", ParamType.TEXT, ""),
                        ParamDef.bool("once", "只触发一次", false, "适合一次性剧情")
                )
                .build());

        add(r, def("rule.leaveArea", "有东西离开时", ModuleCategory.RULE,
                "有东西走出范围的那一刻做一次",
                "配「有东西进来时」成对使用，例如进了房间开灯、出去了关灯。")
                .params(
                        ParamDef.num("radius", "范围半径", 120, 4, 2000, "像素", ""),
                        ParamDef.ref("thenDo", "离开后做什么", ParamType.TEXT, "")
                )
                .build());

        add(r, def("rule.timer", "计时到点", ModuleCategory.RULE,
                "过一段时间做一次（也可以反复做）",
                "适合刷怪、定时开关的机关、限时任务。")
                .params(
                        ParamDef.num("delay", "等多久", 3, 0.1f, 600, "秒", ""),
                        ParamDef.bool("repeat", "反复触发", false, "打开后每隔这么久触发一次"),
                        ParamDef.ref("thenDo", "到点做什么", ParamType.TEXT, "")
                )
                .build());

        add(r, def("rule.var", "变量到达条件", ModuleCategory.RULE,
                "存档里的某个数满足条件时触发",
                "用于任务链：收集满 3 把钥匙、好感度到 50、击败数到 10。")
                .params(
                        ParamDef.text("varName", "哪个变量", "", "剧本里用 $名字 记的那个"),
                        ParamDef.pick("op", "怎么算达到", "大于等于", "数值比较用大于/小于，是/否用等于",
                                "大于等于", "小于等于", "等于", "不等于"),
                        ParamDef.text("value", "比较的值", "1", ""),
                        ParamDef.ref("thenDo", "达到后做什么", ParamType.TEXT, ""),
                        ParamDef.bool("once", "只触发一次", true, "")
                )
                .build());

        add(r, def("rule.call", "被别人叫到时", ModuleCategory.RULE,
                "只有当别的模块点名它才执行",
                "把一段逻辑打包成「可以反复调用的动作」：给这个积木起个自定义名字，"
                        + "其他积木在「然后做什么」里填这个名字即可。这是模块复用的关键。")
                .params(
                        ParamDef.text("name", "给这段动作起名", "开门", "别的模块会按这个名字叫它")
                )
                .build());

        add(r, def("rule.enableIf", "满足条件才生效", ModuleCategory.RULE,
                "给上面的积木加一道开关条件",
                "用于「白天不出现」「拿到钥匙后才会说话」。不满足条件时，它上面的积木完全不工作。")
                .params(
                        ParamDef.text("cond", "什么条件下生效", "", "如：$钥匙数 >= 1　或　$见过老人 == true"),
                        ParamDef.bool("alsoHide", "不满足时连人都藏起来", false, "")
                )
                .build());
    }

    // ---------------- 怎么打 ----------------

    private static void fight(ModuleRegistry r) {
        add(r, def("fight.hp", "有血量会掉血", ModuleCategory.FIGHT,
                "给它一个血条，能被打死",
                "几乎所有能被打的东西都要加这一块。血量归零时会走「死亡时」的积木。")
                .params(
                        ParamDef.num("hp", "血量", 100, 1, 100000, "点", ""),
                        ParamDef.num("defense", "防御", 0, 0, 1000, "点", "每次受伤害减去这个数"),
                        ParamDef.bool("showBar", "显示血条", true, "只在受伤或靠近时显示更干净"),
                        ParamDef.bool("invincible", "无敌", false, "调试时用，或做剧情保护")
                )
                .build());

        add(r, def("fight.melee", "靠近就打", ModuleCategory.FIGHT,
                "玩家进入攻击距离就挥一下",
                "近战怪的基础模块。会自动播放攻击素材、按间隔出手。")
                .params(
                        ParamDef.num("range", "攻击距离", 40, 8, 400, "像素", ""),
                        ParamDef.num("damage", "每下伤害", 10, 0, 100000, "点", ""),
                        ParamDef.num("interval", "多久打一下", 1.2f, 0.1f, 30, "秒", ""),
                        ParamDef.num("windup", "出手前的抬手", 0.25f, 0, 3, "秒", "给玩家反应时间，手感更好"),
                        ParamDef.ref("attackAnim", "攻击时播哪个素材", ParamType.ASSET, "留空则只做数值伤害")
                )
                .triggers(Trigger.ALWAYS)
                .build());

        add(r, def("fight.projectile", "发射子弹", ModuleCategory.FIGHT,
                "朝玩家吐出会飞的东西",
                "适合法师、炮台、激光。子弹碰到墙会消失，可以设置穿透。")
                .params(
                        ParamDef.num("speed", "飞多快", 200, 20, 1500, "像素/秒", ""),
                        ParamDef.num("damage", "打中掉多少血", 12, 0, 100000, "点", ""),
                        ParamDef.num("interval", "多久发一次", 1.6f, 0.1f, 60, "秒", ""),
                        ParamDef.ref("bullet", "用哪个素材", ParamType.ASSET, ""),
                        ParamDef.num("life", "最多飞多久", 3, 0.2f, 60, "秒", "防止子弹永远飞下去"),
                        ParamDef.bool("pierce", "能穿透", false, "穿透后打到第一个目标继续飞")
                )
                .build());

        add(r, def("fight.damage", "受到伤害时", ModuleCategory.FIGHT,
                "被打中时做的事情",
                "配「有血量会掉血」用。常见组合：闪白 + 后退 + 播受伤音效 + 血条变化。")
                .params(
                        ParamDef.bool("flash", "闪一下白", true, "最便宜的命中反馈，务必保留"),
                        ParamDef.bool("knockback", "往后退", true, ""),
                        ParamDef.num("knockDist", "退多远", 12, 0, 300, "像素", ""),
                        ParamDef.ref("hurtSfx", "播哪个音效", ParamType.ASSET, ""),
                        ParamDef.ref("thenDo", "接着做什么", ParamType.TEXT, "")
                )
                .build());

        add(r, def("fight.die", "死亡时", ModuleCategory.FIGHT,
                "血量归零后发生的事情",
                "可以做掉落、播放死亡动画、留一具尸体或者直接消失。")
                .params(
                        ParamDef.pick("way", "怎么消失", "淡出后消失", "留尸体适合做「可搜刮」的体验",
                                "立刻消失", "淡出后消失", "留下尸体"),
                        ParamDef.ref("dropAsset", "掉落什么东西", ParamType.ASSET, "留空表示不掉"),
                        ParamDef.num("exp", "给多少经验", 0, 0, 1000000, "点", ""),
                        ParamDef.ref("thenDo", "之后做什么", ParamType.TEXT, ""),
                        ParamDef.bool("respawn", "过一会儿重生", false, "刷怪点用")
                )
                .build());

        add(r, def("fight.invuln", "受伤后短暂无敌", ModuleCategory.FIGHT,
                "挨打之后有一小段时间不再掉血",
                "防止一段动画里被连续打十几下。主角必加。")
                .params(
                        ParamDef.num("time", "无敌多久", 0.8f, 0.05f, 10, "秒", ""),
                        ParamDef.bool("blink", "无敌期间闪烁", true, "给玩家明确的视觉反馈")
                )
                .build());
    }

    // ---------------- 怎么说话 ----------------

    private static void talk(ModuleRegistry r) {
        add(r, def("talk.say", "说一句话", ModuleCategory.TALK,
                "在角色头顶弹一个小气泡",
                "适合路人闲聊、怪物喊话。不需要开对话框，不打断操作，观感轻。")
                .params(
                        ParamDef.text("text", "说的话", "……", "支持 $变量名 引用存档里的值"),
                        ParamDef.num("duration", "显示多久", 2.5f, 0.5f, 30, "秒", ""),
                        ParamDef.num("rise", "向上飘多远", 12, 0, 200, "像素", "")
                )
                .build());

        add(r, def("talk.dialogue", "弹出对话框", ModuleCategory.TALK,
                "打开底部对话框，走一段剧本",
                "这是剧情的入口。剧本用 Yarn Spinner 语法写在左侧「剧本」页。"
                        + "对话框可以选择是否锁住玩家移动。")
                .params(
                        ParamDef.ref("script", "用哪段剧本", ParamType.SCRIPT, "从左侧剧本列表选"),
                        ParamDef.text("node", "从哪个节点开始", "", "留空则从剧本第一个节点开始"),
                        ParamDef.bool("lockMove", "对话时锁住移动", true, "重要剧情建议打开"),
                        ParamDef.ref("portrait", "说话人的头像", ParamType.ASSET, "留空则不显示")
                )
                .build());

        add(r, def("talk.choice", "给玩家几个选项", ModuleCategory.TALK,
                "弹出选项让玩家选一个",
                "也可以在剧本里写，这里适合临时的小选择（要不要花 50 块钱买药）。")
                .params(
                        ParamDef.text("q", "问什么", "要买吗？", ""),
                        ParamDef.text("options", "选项", "买|不买", "用竖线分开，最多四个"),
                        ParamDef.text("results", "各自跳哪一段", "", "对应上面的顺序，填剧本节点名"),
                        ParamDef.bool("cancelable", "允许按取消退出", true, "")
                )
                .build());

        add(r, def("talk.interact", "按键交谈", ModuleCategory.TALK,
                "玩家走近并按下交互键时触发",
                "RPG 里最标准的「和 NPC 说话」。会自动在头顶显示一个小小的提示图标。")
                .params(
                        ParamDef.num("range", "多近才能交谈", 48, 8, 300, "像素", ""),
                        ParamDef.ref("thenDo", "发生时做什么", ParamType.TEXT, "通常填「弹出对话框」那段的自定义名字"),
                        ParamDef.ref("hintIcon", "提示图标", ParamType.ASSET, "留空用默认的对话图标")
                )
                .build());
    }

    // ---------------- 画面与声音 ----------------

    private static void show(ModuleRegistry r) {
        add(r, def("show.sfx", "播一段声音", ModuleCategory.SHOW,
                "放一个短音效",
                "走路、开箱、命中、拾取都用它。同屏大量播放会自动限流，不会爆音。")
                .params(
                        ParamDef.ref("asset", "播哪个音效", ParamType.ASSET, "从素材库挑一条音频"),
                        ParamDef.num("volume", "音量", 1, 0, 1, "倍", ""),
                        ParamDef.bool("positional", "离得远就小声", true, "俯视角建议打开，空间感强很多")
                )
                .build());

        add(r, def("show.bgm", "切换背景音乐", ModuleCategory.SHOW,
                "换掉正在播的音乐",
                "同一时刻只会有一首 BGM。重复调用同一首不会重头再播。")
                .params(
                        ParamDef.ref("asset", "换哪首", ParamType.ASSET, ""),
                        ParamDef.num("fadeIn", "淡入时长", 1.5f, 0, 30, "秒", ""),
                        ParamDef.bool("loop", "循环播放", true, "")
                )
                .build());

        add(r, def("show.effect", "在它身上播特效", ModuleCategory.SHOW,
                "播放一段粒子或序列帧特效",
                "受击火花、升级光芒、传送漩涡。特效播完自动回收，不需要手动清理。")
                .params(
                        ParamDef.ref("asset", "用哪个特效", ParamType.ASSET, ""),
                        ParamDef.num("scale", "大小", 1, 0.1f, 10, "倍", ""),
                        ParamDef.num("life", "持续多久", 1, 0.05f, 60, "秒", ""),
                        ParamDef.bool("follow", "跟着对象走", true, "关掉则留在原地")
                )
                .build());

        add(r, def("show.shake", "画面震动", ModuleCategory.SHOW,
                "让镜头抖一下",
                "打击感的关键。轻攻击用小数值短时间，重击用大数值稍长。别滥用。")
                .params(
                        ParamDef.num("strength", "抖多厉害", 6, 0, 200, "像素", ""),
                        ParamDef.num("time", "抖多久", 0.22f, 0.05f, 5, "秒", ""),
                        ParamDef.ref("sfx", "同时播哪个音效", ParamType.ASSET, "留空则不播")
                )
                .build());

        add(r, def("show.changeScene", "换到另一张地图", ModuleCategory.SHOW,
                "切场景，并把玩家放到指定出生点",
                "配「传送口」对象使用。切换时自动做一次淡出淡入，不会突兀。")
                .params(
                        ParamDef.text("scene", "去哪张地图", "", "填左侧场景列表里的名字"),
                        ParamDef.ref("spawn", "落到哪个出生点", ParamType.OBJ, "留空则落到该场景的第一个出生点"),
                        ParamDef.num("fade", "黑屏过渡", 0.35f, 0, 5, "秒", ""),
                        ParamDef.bool("keepBgm", "音乐不要断", true, "")
                )
                .build());

        add(r, def("show.camera", "镜头跟着它", ModuleCategory.SHOW,
                "把镜头挂在它身上",
                "主角必须加这一个。可以设置镜头活动范围，避免拍到地图外的黑边。")
                .params(
                        ParamDef.num("smooth", "跟随的柔和程度", 0.15f, 0, 1, "倍", "越小越跟手，越大越慵懒"),
                        ParamDef.num("lookAhead", "朝前多带一点", 24, 0, 300, "像素", "让玩家早点看到前方"),
                        ParamDef.bool("clamp", "限制在地图内", true, "打开后镜头不会拍到地图外")
                )
                .build());
    }

    // ---------------- 构造辅助 ----------------

    private static Def def(String id, String title, ModuleCategory cat, String blurb, String detail) {
        return new Def(id, title, cat, blurb, detail);
    }

    private static void add(ModuleRegistry r, Def d) {
        r.add(d.module());
    }

    /** 链式定义模块，避免一大坨 set 语句。 */
    private static final class Def {
        private final ModuleDef m = new ModuleDef();

        Def(String id, String title, ModuleCategory cat, String blurb, String detail) {
            m.id = id;
            m.title = title;
            m.category = cat;
            m.blurb = blurb;
            m.detail = detail;
        }

        Def params(ParamDef... ps) {
            for (ParamDef p : ps) {
                m.params.add(p);
            }
            return this;
        }

        Def triggers(Trigger... ts) {
            for (Trigger t : ts) {
                m.triggers.add(t);
            }
            return this;
        }

        Def experimental() {
            m.experimental = true;
            return this;
        }

        /** 链式收尾：返回自身，让 .params().build() 的链保持同一个 Def 类型。 */
        Def build() {
            return this;
        }

        ModuleDef module() {
            return m;
        }
    }
}
