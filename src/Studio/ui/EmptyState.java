package Studio.ui;

import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;

/**
 * 空状态占位。
 *
 * 这不是"报错"，是引导：任何列表在没有内容时都必须给出
 * 「一句话说明这里会有什么」+「一个立刻可点的动作」，
 * 绝不允许出现一片空白让用户猜下一步做什么。
 */
public class EmptyState extends JPanel {

    public EmptyState(Ico.Kind icon, String title, String hint, JComponent action) {
        setOpaque(false);
        setLayout(new BoxLayout(this, BoxLayout.Y_AXIS));
        JLabel ico = new JLabel(Ico.of(icon, 34, Theme.LINE));
        ico.setAlignmentX(Component.CENTER_ALIGNMENT);
        JLabel t = new JLabel(title);
        t.setFont(Theme.F_H2);
        t.setForeground(Theme.INK_SUB);
        t.setAlignmentX(Component.CENTER_ALIGNMENT);
        JLabel h = new JLabel("<html><div style='text-align:center;width:210px'>" + hint + "</div></html>");
        h.setFont(Theme.F_SMALL);
        h.setForeground(Theme.INK_MUTE);
        h.setAlignmentX(Component.CENTER_ALIGNMENT);

        add(Box.createVerticalGlue());
        add(ico);
        add(Box.createVerticalStrut(10));
        add(t);
        add(Box.createVerticalStrut(6));
        add(h);
        if (action != null) {
            action.setAlignmentX(Component.CENTER_ALIGNMENT);
            add(Box.createVerticalStrut(14));
            add(action);
        }
        add(Box.createVerticalGlue());
    }

    @Override
    public Dimension getMaximumSize() {
        return new Dimension(Integer.MAX_VALUE, Integer.MAX_VALUE);
    }

    @Override
    protected void paintComponent(Graphics g) {
        super.paintComponent(g);
        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g2.setColor(Theme.LINE_SOFT);
        g2.setStroke(new java.awt.BasicStroke(1f, java.awt.BasicStroke.CAP_ROUND,
                java.awt.BasicStroke.JOIN_ROUND, 1f, new float[]{5f, 5f}, 0f));
        g2.drawRoundRect(12, 12, getWidth() - 25, getHeight() - 25, Theme.R_LG, Theme.R_LG);
        g2.dispose();
    }
}
