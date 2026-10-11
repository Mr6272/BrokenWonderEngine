package Studio.ui;

import javax.swing.BorderFactory;
import javax.swing.JPanel;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.MouseMotionAdapter;
import java.util.List;
import java.util.function.Consumer;

/**
 * 分段控件：2~4 个互斥选项时用它替代下拉与单选钮。
 * 一眼看全所有选项、单击即切换，是编辑器里最省事的切换方式。
 */
public class Seg<T> extends JPanel {

    private final List<T> items;
    private final List<String> labels;
    private int index;
    private int hoverIndex = -1;
    private Consumer<T> onChange;

    public Seg(List<T> items, List<String> labels, T initial, Consumer<T> onChange) {
        this.items = items;
        this.labels = labels;
        this.onChange = onChange;
        setOpaque(false);
        int i = 0;
        if (initial != null) {
            for (int k = 0; k < items.size(); k++) {
                if (items.get(k).toString().equals(initial.toString())) {
                    i = k;
                    break;
                }
            }
        }
        index = i;
        setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        addMouseListener(new MouseAdapter() {
            @Override
            public void mouseExited(MouseEvent e) {
                hoverIndex = -1;
                repaint();
            }

            @Override
            public void mouseClicked(MouseEvent e) {
                int hit = hit(e.getX());
                if (hit >= 0 && hit != index) {
                    index = hit;
                    repaint();
                    if (Seg.this.onChange != null) {
                        Seg.this.onChange.accept(items.get(index));
                    }
                }
            }
        });
        addMouseMotionListener(new MouseMotionAdapter() {
            @Override
            public void mouseMoved(MouseEvent e) {
                int h = hit(e.getX());
                if (h != hoverIndex) {
                    hoverIndex = h;
                    repaint();
                }
            }
        });
    }

    private int hit(int x) {
        if (getWidth() <= 0 || items.isEmpty()) {
            return -1;
        }
        int seg = getWidth() / items.size();
        int i = x / Math.max(1, seg);
        return i < 0 || i >= items.size() ? -1 : i;
    }

    public T selected() {
        return items.get(index);
    }

    public void select(T v) {
        for (int k = 0; k < items.size(); k++) {
            if (items.get(k).toString().equals(v.toString())) {
                index = k;
                repaint();
                return;
            }
        }
    }

    public void setOnChange(Consumer<T> c) {
        this.onChange = c;
    }

    @Override
    public Dimension getPreferredSize() {
        int w = 0;
        FontMetrics fm = getFontMetrics(Theme.F_BODY);
        for (String s : labels) {
            w += fm.stringWidth(s) + 24;
        }
        return new Dimension(Math.max(w, 120), 30);
    }

    @Override
    public Dimension getMaximumSize() {
        return new Dimension(Integer.MAX_VALUE, 30);
    }

    @Override
    protected void paintComponent(Graphics g) {
        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        int w = getWidth(), h = getHeight();

        g2.setColor(Theme.SURFACE_SUNK);
        g2.fillRoundRect(0, 0, w, h, Theme.R_MD, Theme.R_MD);

        int n = items.size();
        int seg = w / n;
        for (int i = 0; i < n; i++) {
            int x = i * seg;
            int sw = (i == n - 1) ? w - x : seg;
            if (i == index) {
                g2.setColor(Theme.SURFACE);
                g2.fillRoundRect(x + 2, 2, sw - 4, h - 4, Theme.R_SM + 1, Theme.R_SM + 1);
                g2.setColor(Theme.LINE);
                g2.drawRoundRect(x + 2, 2, sw - 5, h - 5, Theme.R_SM + 1, Theme.R_SM + 1);
            } else if (i == hoverIndex) {
                g2.setColor(Theme.alpha(Theme.SURFACE, 120));
                g2.fillRoundRect(x + 2, 2, sw - 4, h - 4, Theme.R_SM + 1, Theme.R_SM + 1);
            }
            g2.setFont(i == index ? Theme.F_BODY.deriveFont(java.awt.Font.BOLD) : Theme.F_BODY);
            FontMetrics fm = g2.getFontMetrics();
            String s = labels.get(i);
            int tx = x + (sw - fm.stringWidth(s)) / 2;
            int ty = (h - fm.getHeight()) / 2 + fm.getAscent();
            g2.setColor(i == index ? Theme.INK : Theme.INK_SUB);
            g2.drawString(s, tx, ty);
        }
        g2.dispose();
    }

    public void setBorder1() {
        setBorder(BorderFactory.createEmptyBorder());
    }
}
