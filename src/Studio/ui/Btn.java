package Studio.ui;

import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.SwingConstants;
import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;

/**
 * 统一样式按钮。
 *
 * 为什么不用默认 JButton：默认按钮在不同平台观感差异大，且圆角/悬停/禁用
 * 三态无法统一。这里一次性自绘，全工程按钮视觉一致。
 *
 * 交互纪律：悬停变浅、按下变深、禁用降透明度且不改光标 —— 用户在任何状态下
 * 都能从外观判断"这个能不能点"。
 */
public class Btn extends JButton {

    public enum Variant { PRIMARY, SECONDARY, GHOST, DANGER, SOFT }

    private Variant variant;
    // 这两个状态被子类 IconOnly 读取，保持包内可见
    boolean hover;
    boolean press;
    private boolean compact;

    /** 供内部嵌套类读取悬停/按下状态。 */
    final boolean hovering() {
        return hover;
    }

    final boolean pressing() {
        return press;
    }

    public Btn(String text) {
        this(text, Variant.SECONDARY);
    }

    public Btn(String text, Variant variant) {
        super(text);
        this.variant = variant;
        setFont(Theme.F_BODY);
        setBorder(BorderFactory.createEmptyBorder(7, 14, 7, 14));
        setContentAreaFilled(false);
        setFocusPainted(false);
        setOpaque(false);
        setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        addMouseListener(new MouseAdapter() {
            @Override
            public void mouseEntered(MouseEvent e) {
                hover = true;
                repaint();
            }

            @Override
            public void mouseExited(MouseEvent e) {
                hover = false;
                press = false;
                repaint();
            }

            @Override
            public void mousePressed(MouseEvent e) {
                press = true;
                repaint();
            }

            @Override
            public void mouseReleased(MouseEvent e) {
                press = false;
                repaint();
            }
        });
    }

    public Btn variant(Variant v) {
        this.variant = v;
        return this;
    }

    public Btn icon(Ico.Kind kind) {
        setIcon(Ico.of(kind, 15, fg()));
        setIconTextGap(6);
        return this;
    }

    /** 紧凑尺寸，用于卡片标题栏与列表行内。 */
    public Btn small() {
        compact = true;
        setFont(Theme.F_SMALL);
        setBorder(BorderFactory.createEmptyBorder(4, 9, 4, 9));
        revalidate();
        return this;
    }

    @Override
    public Dimension getPreferredSize() {
        Dimension d = super.getPreferredSize();
        return new Dimension(d.width, Math.max(d.height, compact ? 26 : 32));
    }

    private Color fg() {
        if (!isEnabled()) {
            return Theme.INK_MUTE;
        }
        return switch (variant) {
            case PRIMARY, DANGER -> Color.WHITE;
            case GHOST -> Theme.INK_SUB;
            case SOFT -> Theme.ACCENT;
            default -> Theme.INK;
        };
    }

    private Color bg() {
        boolean on = isEnabled();
        switch (variant) {
            case PRIMARY:
                if (!on) return Theme.SURFACE_SUNK;
                return press ? Theme.ACCENT_DOWN : (hover ? Theme.ACCENT_HOVER : Theme.ACCENT);
            case DANGER:
                if (!on) return Theme.SURFACE_SUNK;
                return press ? Theme.mix(Theme.DANGER, Color.BLACK, 0.15f)
                        : (hover ? Theme.mix(Theme.DANGER, Color.WHITE, 0.12f) : Theme.DANGER);
            case SOFT:
                if (!on) return Theme.SURFACE_ALT;
                return press ? Theme.mix(Theme.ACCENT_SOFT, Theme.ACCENT, 0.22f)
                        : (hover ? Theme.mix(Theme.ACCENT_SOFT, Theme.ACCENT, 0.1f) : Theme.ACCENT_SOFT);
            case GHOST:
                if (!on) return null;
                return press ? Theme.mix(Theme.SURFACE_ALT, Theme.LINE, 0.5f)
                        : (hover ? Theme.SURFACE_ALT : null);
            default:
                if (!on) return Theme.SURFACE_ALT;
                return press ? Theme.mix(Theme.SURFACE_ALT, Theme.LINE, 0.7f)
                        : (hover ? Theme.mix(Theme.SURFACE, Theme.LINE_SOFT, 0.55f) : Theme.SURFACE);
        }
    }

    @Override
    protected void paintComponent(Graphics g) {
        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        int w = getWidth(), h = getHeight();

        Color fill = bg();
        if (fill != null) {
            g2.setColor(fill);
            g2.fillRoundRect(0, 0, w, h, Theme.R_MD, Theme.R_MD);
        }
        if (variant == Variant.SECONDARY) {
            g2.setColor(hover && isEnabled() ? Theme.mix(Theme.LINE, Theme.ACCENT, 0.25f) : Theme.LINE);
            g2.drawRoundRect(0, 0, w - 1, h - 1, Theme.R_MD, Theme.R_MD);
        } else if (variant == Variant.GHOST || variant == Variant.SOFT) {
            g2.setColor(Theme.LINE_SOFT);
            g2.drawRoundRect(0, 0, w - 1, h - 1, Theme.R_MD, Theme.R_MD);
        }

        // 文本 + 图标手动绘制，保证基线稳定（默认按钮在圆角下会偏）
        FontMetrics fm = g2.getFontMetrics(getFont());
        String text = getText();
        int textW = text == null ? 0 : fm.stringWidth(text);
        int iconW = getIcon() == null ? 0 : getIcon().getIconWidth() + 6;
        int totalW = textW + iconW;
        int x = (w - totalW) / 2;
        int y = (h - fm.getHeight()) / 2 + fm.getAscent();

        if (getIcon() != null) {
            getIcon().paintIcon(this, g2, x, (h - getIcon().getIconHeight()) / 2);
            x += iconW;
        }
        if (text != null && !text.isEmpty()) {
            g2.setFont(getFont());
            g2.setColor(fg());
            g2.drawString(text, x, y);
        }
        g2.dispose();
    }

    /** 主按钮。 */
    public static Btn primary(String text) {
        return new Btn(text, Variant.PRIMARY);
    }

    /** 次按钮（默认）。 */
    public static Btn normal(String text) {
        return new Btn(text, Variant.SECONDARY);
    }

    /** 无底色按钮，用于低优先级操作。 */
    public static Btn ghost(String text) {
        return new Btn(text, Variant.GHOST);
    }

    /** 带图标的纯图标按钮（工具栏用），尺寸为正方形。 */
    public static JButton iconOnly(Ico.Kind kind, String tip) {
        JButton b = new IconOnly(kind);
        b.setToolTipText(tip);
        return b;
    }

    /**
     * 纯图标按钮（工具栏用）。
     * 独立维护悬停状态，不继承 Btn 的私有状态 —— 静态嵌套类读不到外层实例字段，
     * 与其为了省几行把状态开放出去，不如让这个小控件自包含。
     */
    private static final class IconOnly extends JButton {
        private final Ico base;
        private boolean hov;
        private boolean prs;

        IconOnly(Ico.Kind kind) {
            super("");
            this.base = Ico.of(kind, 17);
            setBorder(BorderFactory.createEmptyBorder(0, 0, 0, 0));
            setContentAreaFilled(false);
            setFocusPainted(false);
            setOpaque(false);
            setPreferredSize(new Dimension(32, 32));
            setMinimumSize(new Dimension(32, 32));
            setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            addMouseListener(new MouseAdapter() {
                @Override
                public void mouseEntered(MouseEvent e) {
                    hov = true;
                    repaint();
                }

                @Override
                public void mouseExited(MouseEvent e) {
                    hov = false;
                    prs = false;
                    repaint();
                }

                @Override
                public void mousePressed(MouseEvent e) {
                    prs = true;
                    repaint();
                }

                @Override
                public void mouseReleased(MouseEvent e) {
                    prs = false;
                    repaint();
                }
            });
        }

        @Override
        protected void paintComponent(Graphics g) {
            Graphics2D g2 = (Graphics2D) g.create();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            if (hov || prs) {
                g2.setColor(prs ? Theme.SURFACE_SUNK : Theme.SURFACE_ALT);
                g2.fillRoundRect(0, 0, getWidth(), getHeight(), Theme.R_MD, Theme.R_MD);
            }
            Ico c = isEnabled() ? base.colored(Theme.INK_SUB) : base.colored(Theme.INK_MUTE);
            c.paintIcon(this, g2, (getWidth() - 17) / 2, (getHeight() - 17) / 2);
            g2.dispose();
        }
    }
}
