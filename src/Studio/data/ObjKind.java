package Studio.data;

/**
 * 场景对象大类。名称刻意用日常词，不引入"实体/预置体"这类工程术语，
 * 保证不看文档也能明白每一类是什么。
 */
public enum ObjKind {

    /** 主角、NPC、怪物：可以走动、有朝向。 */
    ACTOR("角色", "在地图上会动的东西"),
    /** 箱子、树、门、机关：通常不动，但可以被打/被点。 */
    PROP("物件", "摆着不动的景物与家具"),
    /** 地面、墙、水、装饰贴图：只影响画面与阻挡。 */
    TILE("地面块", "拼地图用的单块贴图"),
    /** 看不见的区域：踩进去、点上去会触发东西。 */
    ZONE("触发区", "看不见的区域，进去就触发"),
    /** 玩家出生的位置。 */
    SPAWN("出生点", "玩家从哪开始"),
    /** 通往另一个场景的门。 */
    PORTAL("传送口", "走到这里换地图"),
    /** 独立光源：俯视角 RPG 的夜间氛围。 */
    LIGHT("光源", "照亮周围一圈");

    public final String cn;
    public final String hint;

    ObjKind(String cn, String hint) {
        this.cn = cn;
        this.hint = hint;
    }

    @Override
    public String toString() {
        return cn;
    }
}
