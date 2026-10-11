package Studio.ui;

import javax.swing.BorderFactory;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollBar;
import javax.swing.JScrollPane;
import javax.swing.ScrollPaneConstants;
import javax.swing.ToolTipManager;
import javax.swing.UIManager;
import java.awt.Color;
import java.awt.Dimension;

/**
 * 全局外观装配与通用小工具。
 *
 * 策略：不接管整个 LAF（自己实现一套 LAF 是有几百个 UIDefaults 的活），
 * 而是「系统 LAF + 全局字体/边距/圆角覆盖 + 关键控件自绘」。
 * 这样 JTextField / JScrollPane / JList / JFileChooser 天然可用且风格统一，
 * 只有输入框、列表、卡片这些真正影响观感的部件才自己画。
 */
public final class UIKit {

    private UIKit() {
    }

    /** 必须在创建任何 Swing 组件之前调用。重复调用是安全的。 */
    public static void install() {
        if (installed) {
            return;
        }
        installed = true;
        try {
            UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
        } catch (Exception ignored) {
        }
        applyDefaults();
        ToolTipManager.sharedInstance().setInitialDelay(420);
        ToolTipManager.sharedInstance().setDismissDelay(12000);
    }

    private static boolean installed;

    private static void applyDefaults() {
        // 用 Map 直接铺 UIDefaults 的 alias key（比逐个 put 字面量好维护）
        java.util.Map<String, Object> d = new java.util.HashMap<>();

        // 字体（关键：中文字体缺失会导致整个界面观感崩掉）
        String[] fontKeys = {
                "Label.font", "Button.font", "TextField.font", "TextArea.font", "TextPane.font",
                "EditorPane.font", "ComboBox.font", "List.font", "Table.font", "Tree.font",
                "Menu.font", "MenuItem.font", "CheckBox.font", "RadioButton.font",
                "TabbedPane.font", "TitledBorder.font", "OptionPane.font", "ToolTip.font",
                "Spinner.font", "ScrollPane.font", "Panel.font", "FormattedTextField.font",
                "PasswordField.font", "CheckBoxMenuItem.font", "RadioButtonMenuItem.font",
                "MenuBar.font", "PopupMenu.font", "SplitPane.font", "Slider.font", "ProgressBar.font"
        };
        for (String k : fontKeys) {
            d.put(k, Theme.F_BODY);
        }

        // 文本与控件配色
        d.put("Label.foreground", Theme.INK);
        d.put("Label.disabledForeground", Theme.INK_MUTE);
        d.put("Panel.background", Theme.SURFACE);
        d.put("TextField.background", Theme.SURFACE);
        d.put("TextField.foreground", Theme.INK);
        d.put("TextField.caretForeground", Theme.ACCENT);
        d.put("TextField.selectionBackground", Theme.ACCENT);
        d.put("TextField.selectionForeground", Color.WHITE);
        d.put("TextField.border", BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(Theme.LINE),
                BorderFactory.createEmptyBorder(4, 8, 4, 8)));
        d.put("TextArea.background", Theme.SURFACE);
        d.put("TextArea.foreground", Theme.INK);
        d.put("List.background", Theme.SURFACE);
        d.put("List.foreground", Theme.INK);
        d.put("List.selectionBackground", Theme.ACCENT_SOFT);
        d.put("List.selectionForeground", Theme.INK);
        d.put("Tree.background", Theme.SURFACE);
        d.put("Tree.selectionBackground", Theme.ACCENT_SOFT);
        d.put("Tree.selectionForeground", Theme.INK);
        d.put("Table.background", Theme.SURFACE);
        d.put("Table.gridColor", Theme.LINE_SOFT);
        d.put("Table.selectionBackground", Theme.ACCENT_SOFT);
        d.put("Table.selectionForeground", Theme.INK);
        d.put("TableHeader.background", Theme.SURFACE_ALT);
        d.put("TableHeader.foreground", Theme.INK_SUB);
        d.put("ComboBox.background", Theme.SURFACE);
        d.put("ComboBox.foreground", Theme.INK);
        d.put("ComboBox.selectionBackground", Theme.ACCENT_SOFT);
        d.put("ComboBox.selectionForeground", Theme.INK);
        d.put("ToolTip.background", new Color(0x26303D));
        d.put("ToolTip.foreground", new Color(0xF0F4FA));
        d.put("ToolTip.border", BorderFactory.createEmptyBorder(6, 9, 6, 9));
        d.put("MenuBar.background", Theme.SURFACE);
        d.put("Menu.background", Theme.SURFACE);
        d.put("Menu.foreground", Theme.INK);
        d.put("Menu.selectionBackground", Theme.ACCENT_SOFT);
        d.put("Menu.selectionForeground", Theme.INK);
        d.put("MenuItem.selectionBackground", Theme.ACCENT_SOFT);
        d.put("MenuItem.selectionForeground", Theme.INK);
        d.put("MenuItem.background", Theme.SURFACE);
        d.put("PopupMenu.background", Theme.SURFACE);
        d.put("PopupMenu.border", BorderFactory.createLineBorder(Theme.LINE));
        d.put("Separator.foreground", Theme.LINE);
        d.put("TabbedPane.background", Theme.SURFACE);
        d.put("TabbedPane.foreground", Theme.INK_SUB);
        d.put("TabbedPane.selected", Theme.SURFACE);
        d.put("TabbedPane.contentAreaColor", Theme.SURFACE);
        d.put("TabbedPane.tabAreaBackground", Theme.SURFACE_ALT);
        d.put("TabbedPane.borderHightlightColor", Theme.LINE);
        d.put("TabbedPane.darkShadow", Theme.LINE);
        d.put("TabbedPane.light", Theme.SURFACE);
        d.put("TabbedPane.highlight", Theme.SURFACE);
        d.put("TabbedPane.shadow", Theme.LINE);
        d.put("TabbedPane.focus", Theme.ACCENT);
        d.put("ScrollBar.width", 10);
        d.put("ScrollBar.background", Theme.SURFACE_ALT);
        d.put("ScrollBar.thumb", new Color(0xC3CBD8));
        d.put("ScrollBar.thumbDarkShadow", Theme.SURFACE_ALT);
        d.put("ScrollBar.thumbHighlight", new Color(0xC3CBD8));
        d.put("ScrollBar.thumbShadow", Theme.SURFACE_ALT);
        d.put("ScrollBar.track", Theme.SURFACE_ALT);
        d.put("ScrollPane.background", Theme.SURFACE);
        d.put("Viewport.background", Theme.SURFACE);
        d.put("SplitPane.background", Theme.SHELL);
        d.put("SplitPane.dividerSize", 6);
        d.put("SplitPane.border", BorderFactory.createEmptyBorder());
        d.put("CheckBox.background", Theme.SURFACE);
        d.put("CheckBox.foreground", Theme.INK);
        d.put("RadioButton.background", Theme.SURFACE);
        d.put("RadioButton.foreground", Theme.INK);
        d.put("OptionPane.background", Theme.SURFACE);
        d.put("OptionPane.messageForeground", Theme.INK);
        d.put("Slider.background", Theme.SURFACE);
        d.put("Slider.foreground", Theme.ACCENT);
        d.put("ProgressBar.background", Theme.SURFACE_SUNK);
        d.put("ProgressBar.foreground", Theme.ACCENT);
        d.put("Spinner.background", Theme.SURFACE);
        d.put("Spinner.foreground", Theme.INK);
        d.put("FileChooser.background", Theme.SURFACE);
        d.put("FileChooser.foreground", Theme.INK);

        for (java.util.Map.Entry<String, Object> e : d.entrySet()) {
            UIManager.put(e.getKey(), e.getValue());
        }
    }

    // ---------- 布局小工具 ----------

    /** 竖排容器，子项之间留固定间距。 */
    public static JPanel col(int gap, JComponent... items) {
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new javax.swing.BoxLayout(p, javax.swing.BoxLayout.Y_AXIS));
        for (int i = 0; i < items.length; i++) {
            if (i > 0) {
                p.add(javax.swing.Box.createVerticalStrut(gap));
            }
            p.add(items[i]);
        }
        return p;
    }

    /** 横排容器，左对齐。 */
    public static JPanel row(int gap, JComponent... items) {
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new javax.swing.BoxLayout(p, javax.swing.BoxLayout.X_AXIS));
        for (int i = 0; i < items.length; i++) {
            if (i > 0) {
                p.add(javax.swing.Box.createHorizontalStrut(gap));
            }
            p.add(items[i]);
        }
        return p;
    }

    /** 可拉伸的空白，用来把后面的元素推到右边。 */
    public static JComponent grow() {
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setPreferredSize(new Dimension(0, 0));
        p.setMaximumSize(new Dimension(Integer.MAX_VALUE, Integer.MAX_VALUE));
        return p;
    }

    /** 一个带标题的小节标题行（左侧 3px 色条 + 文字）。 */
    public static JLabel sectionTitle(String text, Color accent) {
        JLabel l = new JLabel(text) {
            @Override
            protected void paintComponent(java.awt.Graphics g) {
                java.awt.Graphics2D g2 = (java.awt.Graphics2D) g.create();
                g2.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING,
                        java.awt.RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setColor(accent);
                g2.fillRoundRect(0, getHeight() / 2 - 7, 3, 14, 3, 3);
                g2.dispose();
                super.paintComponent(g);
            }
        };
        l.setFont(Theme.F_H2);
        l.setForeground(Theme.INK);
        l.setBorder(BorderFactory.createEmptyBorder(0, 12, 0, 0));
        return l;
    }

    /** 统一风格的滚动容器：无边框、细滚动条、竖向滚动。 */
    public static JScrollPane scroll(JComponent view) {
        JScrollPane sp = new JScrollPane(view);
        sp.setBorder(BorderFactory.createEmptyBorder());
        sp.setOpaque(false);
        sp.getViewport().setOpaque(false);
        sp.setHorizontalScrollBarPolicy(ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER);
        sp.getVerticalScrollBar().setUnitIncrement(18);
        styleScrollBar(sp.getVerticalScrollBar());
        styleScrollBar(sp.getHorizontalScrollBar());
        return sp;
    }

    private static void styleScrollBar(JScrollBar sb) {
        sb.setBackground(Theme.SURFACE_ALT);
        sb.setPreferredSize(new Dimension(10, sb.getPreferredSize().height));
    }

    /** 把组件放进留白容器，用于卡片内边距。 */
    public static JComponent pad(JComponent c, int t, int l, int b, int r) {
        JPanel p = new JPanel(new java.awt.BorderLayout());
        p.setOpaque(false);
        p.setBorder(BorderFactory.createEmptyBorder(t, l, b, r));
        p.add(c, java.awt.BorderLayout.CENTER);
        return p;
    }
}
