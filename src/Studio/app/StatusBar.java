package Studio.app;

import Studio.ui.Theme;

import javax.swing.BorderFactory;
import javax.swing.BoxLayout;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.Timer;
import java.awt.BorderLayout;
import java.awt.Dimension;

/**
 * 底部状态栏：场景名、选中数量、鼠标所在格、缩放、临时提示。
 *
 * 单独成类而不是内部类：内部类的字段初始化早于外部类构造函数体，
 * 稍不注意就会在 st 还没赋值时刷新而崩溃。
 */
public final class StatusBar extends JPanel {

    private final AppState st;
    private final JLabel mouse = cell(150);
    private final JLabel sel = cell(130);
    private final JLabel zoom = cell(90);
    private final JLabel scene = cell(160);
    private final JLabel hint = new JLabel("就绪");
    private Timer hintTimer;

    public StatusBar(AppState st) {
        this.st = st;
        setLayout(new BorderLayout());
        setPreferredSize(new Dimension(0, Theme.STATUSBAR_H));
        setBorder(BorderFactory.createMatteBorder(1, 0, 0, 0, Theme.LINE));
        setBackground(Theme.SURFACE_ALT);

        JPanel left = new JPanel();
        left.setOpaque(false);
        left.setLayout(new BoxLayout(left, BoxLayout.X_AXIS));
        left.setBorder(BorderFactory.createEmptyBorder(0, Theme.S3, 0, 0));
        left.add(scene);
        left.add(sep());
        left.add(sel);
        left.add(sep());
        left.add(mouse);
        left.add(sep());
        left.add(zoom);

        hint.setFont(Theme.F_SMALL);
        hint.setForeground(Theme.INK_SUB);
        hint.setBorder(BorderFactory.createEmptyBorder(0, 0, 0, Theme.S3));

        add(left, BorderLayout.WEST);
        add(hint, BorderLayout.EAST);
        refresh();
        hint.setText(readyText());
    }

    private static JLabel cell(int w) {
        JLabel l = new JLabel("");
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.INK_SUB);
        l.setPreferredSize(new Dimension(w, 22));
        return l;
    }

    private static JComponent sep() {
        JLabel l = new JLabel("·");
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.LINE);
        l.setBorder(BorderFactory.createEmptyBorder(0, 8, 0, 8));
        return l;
    }

    /** 临时提示：4 秒后自动回到默认文案，避免过期信息残留误导用户。 */
    public void hint(String text) {
        hint.setText(text);
        hint.setForeground(Theme.INK);
        if (hintTimer != null) {
            hintTimer.stop();
        }
        hintTimer = new Timer(4200, e -> {
            hint.setText(readyText());
            hint.setForeground(Theme.INK_SUB);
        });
        hintTimer.setRepeats(false);
        hintTimer.start();
    }

    private static String readyText() {
        return "就绪　·　空格拖动画面　·　滚轮缩放　·　F1 快速上手";
    }

    /** 由画布调用，回报鼠标所在的地图格坐标。 */
    public void mouseAt(int tx, int ty) {
        mouse.setText("格 (" + tx + ", " + ty + ")");
    }

    public void refresh() {
        sel.setText("选中 " + st.selection().size() + " 个");
        zoom.setText(Math.round(st.zoom * 100) + "%");
        Studio.data.SceneModel s = st.scene();
        scene.setText(s == null ? "无场景" : s.name + "　" + s.objects.size() + " 个对象");
    }
}
