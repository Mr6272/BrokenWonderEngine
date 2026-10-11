package Studio.ui;

import javax.swing.BorderFactory;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;

/** 卡片容器：白底、1px 描边、8px 圆角、可选标题栏与右侧操作区。 */
public class Card extends JPanel {

    private final JPanel header = new JPanel(new BorderLayout());
    private final JPanel body = new JPanel(new BorderLayout());
    private final JPanel tools = new JPanel();
    private boolean showHeader;

    public Card() {
        this("");
    }

    public Card(String title) {
        setOpaque(false);
        setLayout(new BorderLayout());
        header.setOpaque(false);
        header.setBorder(BorderFactory.createEmptyBorder(Theme.S3, Theme.CARD_PAD, Theme.S2, Theme.CARD_PAD));
        tools.setOpaque(false);
        tools.setLayout(new javax.swing.BoxLayout(tools, javax.swing.BoxLayout.X_AXIS));

        if (title != null && !title.isEmpty()) {
            showHeader = true;
            JLabel t = new JLabel(title);
            t.setFont(Theme.F_H2);
            t.setForeground(Theme.INK);
            header.add(t, BorderLayout.WEST);
            header.add(tools, BorderLayout.EAST);
        }
        body.setOpaque(false);
        body.setBorder(BorderFactory.createEmptyBorder(
                showHeader ? 0 : Theme.CARD_PAD, Theme.CARD_PAD, Theme.CARD_PAD, Theme.CARD_PAD));
        add(header, BorderLayout.NORTH);
        add(body, BorderLayout.CENTER);
    }

    /** 卡片内容区。 */
    public JPanel content() {
        return body;
    }

    /** 标题栏右侧放置的按钮（小图标按钮）。 */
    public void addTool(JComponent c) {
        if (!showHeader) {
            return;
        }
        if (tools.getComponentCount() > 0) {
            tools.add(javax.swing.Box.createHorizontalStrut(4));
        }
        tools.add(c);
    }

    public void setTitle(String title) {
        if (title == null || title.isEmpty()) {
            return;
        }
        for (java.awt.Component c : header.getComponents()) {
            if (c instanceof JLabel) {
                ((JLabel) c).setText(title);
                return;
            }
        }
        showHeader = true;
        JLabel t = new JLabel(title);
        t.setFont(Theme.F_H2);
        t.setForeground(Theme.INK);
        header.removeAll();
        header.add(t, BorderLayout.WEST);
        header.add(tools, BorderLayout.EAST);
        body.setBorder(BorderFactory.createEmptyBorder(0, Theme.CARD_PAD, Theme.CARD_PAD, Theme.CARD_PAD));
        revalidate();
    }

    /**
     * 纵向必须放开。
     * 在 BoxLayout 里，如果这里返回"当前 preferred 高度"，布局那一刻内容还没算出来，
     * 高度会被压成几十像素，卡片的正文就整片看不见（实测踩过）。
     */
    @Override
    public Dimension getMaximumSize() {
        return new Dimension(Integer.MAX_VALUE, Integer.MAX_VALUE);
    }

    @Override
    protected void paintComponent(Graphics g) {
        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        int w = getWidth(), h = getHeight();
        g2.setColor(Theme.SURFACE);
        g2.fillRoundRect(0, 0, w - 1, h - 1, Theme.R_LG, Theme.R_LG);
        g2.setColor(Theme.LINE);
        g2.drawRoundRect(0, 0, w - 1, h - 1, Theme.R_LG, Theme.R_LG);
        if (showHeader) {
            g2.setColor(Theme.LINE_SOFT);
            int y = header.getY() + header.getHeight() - 1;
            g2.drawLine(Theme.CARD_PAD, y, w - Theme.CARD_PAD, y);
        }
        g2.dispose();
        super.paintComponent(g);
    }

    /** 便捷构造：标题 + 内容 + 纯色细边框强调（用于选中态）。 */
    public void setAccentBorder(Color c) {
        putClientProperty("accentBorder", c);
        repaint();
    }
}
