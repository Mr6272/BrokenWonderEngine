package Studio.data;

import java.util.UUID;

/** 图层：只负责绘制顺序与整体可见/锁定，不承载逻辑。 */
public class Layer {

    public String id = UUID.randomUUID().toString();
    public String name;
    public boolean visible = true;
    /** 锁定后画布上不可选中/拖动，防止误操作背景层。 */
    public boolean locked = false;
    public int order = 0;

    public Layer() {
    }

    public Layer(String name) {
        this.name = name;
    }
}
