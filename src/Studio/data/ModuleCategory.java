package Studio.data;

/**
 * 模块类别。分类名全部用日常词 + 一个大白话说明，
 * 目的是让完全不懂编程的人看名字就知道"这类积木是干什么的"。
 */
public enum ModuleCategory {

    MOVE("怎么动", "让它自己走、追人、绕开障碍", "#2F6BFF"),
    LOOK("怎么显示", "决定它长什么样、播哪段动画、发什么光", "#7A5AF8"),
    SENSE("怎么感知", "判断距离、视线、范围里有没有东西", "#12A06B"),
    RULE("什么时候做", "被碰到、被点、进入范围、计时到点", "#E08A00"),
    FIGHT("怎么打", "掉血、攻击、受伤、死亡", "#E14A4A"),
    TALK("怎么说话", "弹对话框、播剧本、给选项", "#0EA5B7"),
    SHOW("画面与声音", "播特效、播音效、震屏、切场景", "#8A6D3B");

    public final String cn;
    public final String blurb;
    public final String color;

    ModuleCategory(String cn, String blurb, String color) {
        this.cn = cn;
        this.blurb = blurb;
        this.color = color;
    }

    @Override
    public String toString() {
        return cn;
    }
}
