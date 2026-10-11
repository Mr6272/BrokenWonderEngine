package Studio.ui;

import javax.swing.JComponent;
import javax.swing.JWindow;
import javax.swing.Timer;
import java.awt.AlphaComposite;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.Window;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * 非阻塞式轻提示。
 *
 * 设计纪律（这是"不乱弹窗"的核心）：
 * 1. 任何"操作成功/失败/被忽略"的反馈都走这里，不放 JOptionPane。
 * 2. JOptionPane 只允许出现在"会丢失数据"的确认场景。
 * 3. 提示自动消失，可叠加但最多 3 条，超出的排队等前一条结束。
 * 4. 纯信息提示（如"已复制"）不用 Toast，用状态栏文案，避免打扰。
 */
public final class Toast {

    public enum Kind {
        OK(Theme.OK), INFO(Theme.ACCENT), WARN(Theme.WARN), ERROR(Theme.DANGER);

        final Color color;

        Kind(Color c) {
            this.color = c;
        }
    }

    private static final int MAX_LIVE = 3;
    private static final int WIDTH = 320;
    private static final int PAD = 14;

    private static final Deque<Msg> QUEUE = new ArrayDeque<>();
    private static final List<Card> LIVE = new ArrayList<>();
    private static Window owner;

    private Toast() {
    }

    public static void bindOwner(Window w) {
        owner = w;
    }

    public static void ok(String text) {
        show(text, Kind.OK);
    }

    public static void info(String text) {
        show(text, Kind.INFO);
    }

    public static void warn(String text) {
        show(text, Kind.WARN);
    }

    public static void error(String text) {
        show(text, Kind.ERROR);
    }

    private static final class Msg {
        final String text;
        final Kind kind;

        Msg(String text, Kind kind) {
            this.text = text;
            this.kind = kind;
        }
    }

    private static void show(String text, Kind kind) {
        if (text == null || text.isEmpty()) {
            return;
        }
        QUEUE.add(new Msg(text, kind));
        pump();
    }

    private static void pump() {
        while (LIVE.size() < MAX_LIVE && !QUEUE.isEmpty()) {
            Msg m = QUEUE.poll();
            LIVE.add(new Card(m));
        }
        relayout();
    }

    private static void relayout() {
        if (owner == null || !owner.isShowing()) {
            return;
        }
        int baseY = owner.getY() + owner.getHeight() - Theme.STATUSBAR_H - 24;
        for (int i = LIVE.size() - 1; i >= 0; i--) {
            Card c = LIVE.get(i);
            int slot = LIVE.size() - 1 - i;
            int x = owner.getX() + (owner.getWidth() - c.getWidth()) / 2;
            int y = baseY - slot * (c.getHeight() + 10) - c.getHeight();
            c.setLocation(x, y);
        }
    }

    /** 单条提示卡片：自带淡入淡出，生命周期结束后自动销毁并唤醒队列。 */
    private static final class Card extends JWindow {
        private final Msg msg;
        private final int textW;
        private final int height;
        private float alpha = 0f;
        private boolean closing;
        private Timer fade;
        private Timer life;

        Card(Msg msg) {
            super(owner);
            this.msg = msg;
            FontMetrics fm = getFontMetrics(Theme.F_BODY);
            int avail = WIDTH - PAD * 2 - 12;
            int w = Math.min(WIDTH, Math.max(180, fm.stringWidth(msg.text) + PAD * 2 + 12));
            this.textW = w - PAD * 2 - 12;
            this.height = Math.max(44, fm.getHeight() + PAD * 2);
            // 现代 JDK：JWindow 背景设为全透明色即可得到逐像素透明窗口。
            // （旧写法 com.sun.awt.AWTUtilities 属内部 API，JDK 9 后已移除，不可依赖）
            setBackground(new Color(0, 0, 0, 0));
            setSize(w, height);
            setAlwaysOnTop(true);
            setFocusableWindowState(false);
            add(new Body());
            setVisible(true);
            fadeIn();
            life = new Timer(msg.kind == Kind.ERROR ? 4200 : 2600, e -> fadeOut());
            life.setRepeats(false);
            life.start();
        }

        private void fadeIn() {
            fade = new Timer(16, e -> {
                alpha = Math.min(1f, alpha + 0.14f);
                repaint();
                if (alpha >= 1f) {
                    fade.stop();
                }
            });
            fade.start();
        }

        private void fadeOut() {
            if (closing) {
                return;
            }
            closing = true;
            life.stop();
            fade = new Timer(16, e -> {
                alpha = Math.max(0f, alpha - 0.1f);
                repaint();
                if (alpha <= 0f) {
                    fade.stop();
                    dismiss();
                }
            });
            fade.start();
        }

        private void dismiss() {
            LIVE.remove(this);
            dispose();
            pump();
        }

        private final class Body extends JComponent {
            @Override
            public Dimension getPreferredSize() {
                return new Dimension(getWidth(), height);
            }

            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, Math.max(0.01f, alpha)));
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);

                g2.setColor(new Color(0, 0, 0, 26));
                g2.fillRoundRect(2, 3, getWidth() - 4, height - 4, Theme.R_LG, Theme.R_LG);

                g2.setColor(Theme.INK);
                g2.fillRoundRect(0, 0, getWidth() - 2, height - 5, Theme.R_LG, Theme.R_LG);

                g2.setColor(msg.kind.color);
                g2.fillRoundRect(0, 0, 4, height - 5, 2, 2);

                g2.setFont(Theme.F_BODY);
                g2.setColor(new Color(0xF2F5FA));
                FontMetrics fm = g2.getFontMetrics();
                int tx = PAD + 8;
                int ty = (height - 5) / 2 + fm.getAscent() / 2 - 2;
                g2.drawString(ellipsis(msg.text, fm, textW), tx, ty);
                g2.dispose();
            }
        }

        private static String ellipsis(String s, FontMetrics fm, int max) {
            if (fm.stringWidth(s) <= max) {
                return s;
            }
            StringBuilder sb = new StringBuilder();
            for (char ch : s.toCharArray()) {
                if (fm.stringWidth(sb.toString() + ch + "…") > max) {
                    break;
                }
                sb.append(ch);
            }
            return sb + "…";
        }
    }
}
