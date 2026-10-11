package Studio.app;

import javax.swing.JComponent;

/**
 * 侧栏 / 底部面板的统一接口。
 * 每个面板只负责"显示自己 + 响应状态变化"，不互相调用。
 */
public abstract class Panel {

    protected final AppState st;

    protected Panel(AppState st) {
        this.st = st;
    }

    /** 面板标题（侧栏标签与卡片标题共用）。 */
    public abstract String title();

    /** 侧栏图标。 */
    public abstract Studio.ui.Ico.Kind icon();

    /** 面板主体。首次访问时构建，之后复用。 */
    public abstract JComponent view();

    /** 状态变化时刷新显示。默认什么都不做。 */
    public void refresh() {
    }
}
