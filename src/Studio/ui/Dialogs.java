package Studio.ui;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JLabel;
import javax.swing.JPanel;
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.Window;

/**
 * 模态对话框。
 *
 * 严格限量使用：只有"继续下去会丢东西"的动作才允许弹窗。
 * 所有提示、警告、成功反馈一律走 Toast / 状态栏，避免打断用户。
 * 弹窗统一为 3 个按钮以内、默认焦点落在安全选项上。
 */
public final class Dialogs {

    public static final int SAVE = 0;
    public static final int DISCARD = 1;
    public static final int CANCEL = 2;

    private Dialogs() {
    }

    /** 未保存改动确认。默认焦点在"保存"，取消永远在 Escape 上。 */
    public static int unsavedChanges(Window owner, String projectName) {
        JDialog d = shell(owner, "还有改动没有保存");
        JPanel body = new JPanel();
        body.setOpaque(false);
        body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS));
        body.setBorder(BorderFactory.createEmptyBorder(Theme.S4, Theme.S4, Theme.S3, Theme.S4));

        JLabel title = new JLabel("「" + projectName + "」有未保存的改动");
        title.setFont(Theme.F_H2);
        title.setForeground(Theme.INK);
        title.setAlignmentX(Component.LEFT_ALIGNMENT);
        JLabel sub = new JLabel("关掉之前先存一下，不然这次改的就没了。");
        sub.setFont(Theme.F_BODY);
        sub.setForeground(Theme.INK_SUB);
        sub.setBorder(BorderFactory.createEmptyBorder(Theme.S2, 0, 0, 0));
        sub.setAlignmentX(Component.LEFT_ALIGNMENT);
        body.add(title);
        body.add(sub);
        body.add(Box.createVerticalStrut(Theme.S4));

        final int[] result = {CANCEL};
        JPanel buttons = new JPanel();
        buttons.setOpaque(false);
        buttons.setLayout(new BoxLayout(buttons, BoxLayout.X_AXIS));
        Btn cancel = Btn.ghost("取消");
        Btn discard = Btn.normal("不保存");
        Btn save = Btn.primary("保存并关闭");
        cancel.addActionListener(e -> {
            result[0] = CANCEL;
            d.dispose();
        });
        discard.addActionListener(e -> {
            result[0] = DISCARD;
            d.dispose();
        });
        save.addActionListener(e -> {
            result[0] = SAVE;
            d.dispose();
        });
        buttons.add(cancel);
        buttons.add(Box.createHorizontalGlue());
        buttons.add(discard);
        buttons.add(Box.createHorizontalStrut(Theme.S2));
        buttons.add(save);
        buttons.setBorder(BorderFactory.createEmptyBorder(0, Theme.S4, Theme.S4, Theme.S4));

        d.add(body, BorderLayout.CENTER);
        d.add(buttons, BorderLayout.SOUTH);
        d.getRootPane().setDefaultButton(save);
        d.pack();
        d.setLocationRelativeTo(owner);
        d.setVisible(true);
        return result[0];
    }

    /** 通用两选一确认（仅用于有破坏性后果的操作，如删除大量对象）。 */
    public static boolean confirm(Window owner, String title, String detail, String okText, boolean danger) {
        JDialog d = shell(owner, title);
        JPanel body = new JPanel();
        body.setOpaque(false);
        body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS));
        body.setBorder(BorderFactory.createEmptyBorder(Theme.S4, Theme.S4, Theme.S3, Theme.S4));
        JLabel t = new JLabel(title);
        t.setFont(Theme.F_H2);
        t.setForeground(Theme.INK);
        t.setAlignmentX(Component.LEFT_ALIGNMENT);
        body.add(t);
        if (detail != null && !detail.isEmpty()) {
            JLabel s = new JLabel("<html><div style='width:330px'>" + detail + "</div></html>");
            s.setFont(Theme.F_BODY);
            s.setForeground(Theme.INK_SUB);
            s.setBorder(BorderFactory.createEmptyBorder(Theme.S2, 0, 0, 0));
            s.setAlignmentX(Component.LEFT_ALIGNMENT);
            body.add(s);
        }
        final boolean[] ok = {false};
        JPanel buttons = new JPanel();
        buttons.setOpaque(false);
        buttons.setLayout(new BoxLayout(buttons, BoxLayout.X_AXIS));
        Btn cancel = Btn.ghost("取消");
        Btn confirm = danger ? new Btn(okText, Btn.Variant.DANGER) : Btn.primary(okText);
        cancel.addActionListener(e -> d.dispose());
        confirm.addActionListener(e -> {
            ok[0] = true;
            d.dispose();
        });
        buttons.add(Box.createHorizontalGlue());
        buttons.add(cancel);
        buttons.add(Box.createHorizontalStrut(Theme.S2));
        buttons.add(confirm);
        buttons.setBorder(BorderFactory.createEmptyBorder(0, Theme.S4, Theme.S4, Theme.S4));
        d.add(body, BorderLayout.CENTER);
        d.add(buttons, BorderLayout.SOUTH);
        d.getRootPane().setDefaultButton(confirm);
        d.pack();
        d.setLocationRelativeTo(owner);
        d.setVisible(true);
        return ok[0];
    }

    /** 统一的弹窗外壳：无装饰、圆角白底、Escape 关闭。 */
    public static JDialog shell(Window owner, String title) {
        JDialog d = new JDialog(owner, title, JDialog.ModalityType.APPLICATION_MODAL);
        d.setUndecorated(true);
        JPanel root = new JPanel(new BorderLayout()) {
            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setColor(new java.awt.Color(0, 0, 0, 30));
                g2.fillRoundRect(3, 5, getWidth() - 6, getHeight() - 8, Theme.R_LG, Theme.R_LG);
                g2.setColor(Theme.SURFACE);
                g2.fillRoundRect(1, 1, getWidth() - 4, getHeight() - 6, Theme.R_LG, Theme.R_LG);
                g2.setColor(Theme.LINE);
                g2.drawRoundRect(1, 1, getWidth() - 5, getHeight() - 7, Theme.R_LG, Theme.R_LG);
                g2.dispose();
            }
        };
        root.setOpaque(false);
        root.setBorder(BorderFactory.createEmptyBorder(6, 6, 8, 8));
        d.setContentPane(root);
        // Escape 关闭 = 取消
        root.getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW)
                .put(javax.swing.KeyStroke.getKeyStroke("ESCAPE"), "esc");
        root.getActionMap().put("esc", new javax.swing.AbstractAction() {
            @Override
            public void actionPerformed(java.awt.event.ActionEvent e) {
                d.dispose();
            }
        });
        d.setMinimumSize(new Dimension(380, 0));
        return d;
    }
}
