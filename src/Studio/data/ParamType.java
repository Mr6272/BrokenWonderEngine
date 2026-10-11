package Studio.data;

/** 模块参数的取值类型。决定属性面板默认给什么控件，避免用户手敲格式。 */
public enum ParamType {

    /** 数字（像素、秒、格数…）。room 给出合理区间，面板用带步进的输入框。 */
    NUM("数字"),
    /** 单行文本。 */
    TEXT("文字"),
    /** 开关。 */
    BOOL("开关"),
    /** 从固定选项里挑一个（内部仍存文字）。 */
    PICK("选项"),
    /** 从场景中挑一个对象。 */
    OBJ("对象"),
    /** 从素材库挑一条素材。 */
    ASSET("素材"),
    /** 挑一个标签（用于批量匹配同类对象）。 */
    TAG("标签"),
    /** 挑一个剧本节点（Yarn 剧本）。 */
    SCRIPT("剧本"),
    /** 一段日志式的文字，只读展示。 */
    NOTE("说明");

    public final String cn;

    ParamType(String cn) {
        this.cn = cn;
    }

    @Override
    public String toString() {
        return cn;
    }
}
