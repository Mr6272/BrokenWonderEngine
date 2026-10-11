package Studio.data;

/**
 * 触发时机。用日常说法描述"什么时候轮到这个模块做事"，
 * 不出现事件名、回调、监听器这类词。
 */
public enum Trigger {

    ALWAYS("一直生效", "每时每刻都在起作用"),
    ON_SPAWN("开局时", "这个场景一开始就做一次"),
    ON_CLICK("被点击时", "玩家用鼠标点它才做"),
    ON_TOUCH("碰到东西时", "和别的物体撞上时做"),
    ON_ENTER_AREA("有东西进来时", "有物体进入指定范围时做"),
    ON_LEAVE_AREA("有东西离开时", "有物体离开指定范围时做"),
    ON_DAMAGED("受伤时", "自己掉血时做"),
    ON_DEATH("死亡时", "自己血量归零时做"),
    ON_TIMER("计时到点时", "过一段时间做一次"),
    ON_INTERACT("玩家按键交谈时", "玩家走近后按交互键时做"),
    ON_SCENE_ENTER("进入本场景时", "玩家刚进这张地图时做"),
    ON_VAR("变量到达条件时", "存档变量满足条件时做"),
    ON_CUSTOM("被别的模块叫到时", "被其他模块点名调用时做");

    public final String cn;
    public final String hint;

    Trigger(String cn, String hint) {
        this.cn = cn;
        this.hint = hint;
    }

    @Override
    public String toString() {
        return cn;
    }
}
