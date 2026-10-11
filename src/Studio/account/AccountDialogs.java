package Studio.account;

import Studio.ui.Btn;
import Studio.ui.Dialogs;
import Studio.ui.Ico;
import Studio.ui.Seg;
import Studio.ui.Theme;
import Studio.ui.Toast;
import Studio.ui.UIKit;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JPasswordField;
import javax.swing.JTextField;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.Window;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.Arrays;
import java.util.List;
import java.util.function.Consumer;

/** 登录 / 注册 / 选订阅计划的界面。 */
final class AccountDialogs {

    private AccountDialogs() {
    }

    // ---------------- 登录 ----------------

    static void showLogin(Window owner) {
        JDialog d = Dialogs.shell(owner, "登录");
        JPanel root = new JPanel(new BorderLayout());
        root.setOpaque(false);
        root.setBorder(BorderFactory.createEmptyBorder(Theme.S5, Theme.S5, Theme.S4, Theme.S5));

        JLabel title = new JLabel("登录 BWE Studio");
        title.setFont(Theme.F_H1);
        title.setForeground(Theme.INK);
        JLabel sub = new JLabel("登录后可以同步订阅计划与团队规则包；不登录也能完整使用所有编辑功能。");
        sub.setFont(Theme.F_SMALL);
        sub.setForeground(Theme.INK_MUTE);
        sub.setBorder(BorderFactory.createEmptyBorder(Theme.S1, 0, Theme.S3, 0));

        JTextField email = new JTextField();
        style(email, "邮箱");
        JPasswordField pw = new JPasswordField();
        style(pw, "密码");
        JTextField name = new JTextField();
        style(name, "昵称（可以留空）");

        JLabel emailLabel = fieldLabel("邮箱");
        JLabel pwLabel = fieldLabel("密码");
        JLabel nameLabel = fieldLabel("昵称");
        JPanel nameRow = new JPanel(new BorderLayout(0, 4));
        nameRow.setOpaque(false);
        nameRow.add(nameLabel, BorderLayout.NORTH);
        nameRow.add(name, BorderLayout.CENTER);
        nameRow.setVisible(false);

        JPanel form = new JPanel();
        form.setOpaque(false);
        form.setLayout(new BoxLayout(form, BoxLayout.Y_AXIS));
        form.add(labelPair("邮箱", email));
        form.add(Box.createVerticalStrut(Theme.S3));
        form.add(labelPair("密码", pw));
        form.add(Box.createVerticalStrut(Theme.S3));
        form.add(nameRow);

        Seg<String> mode = new Seg<>(List.of("登录", "注册"), List.of("登录", "注册"), "登录", m -> {
            boolean reg = m.equals("注册");
            nameRow.setVisible(reg);
            d.pack();
            d.setLocationRelativeTo(owner);
        });
        nameRow.setVisible(false);

        JPanel top = new JPanel();
        top.setOpaque(false);
        top.setLayout(new BoxLayout(top, BoxLayout.Y_AXIS));
        top.add(title);
        top.add(sub);
        top.add(mode);
        top.add(Box.createVerticalStrut(Theme.S4));
        top.add(form);

        Btn go = Btn.primary("登录");
        go.setPreferredSize(new Dimension(120, 34));
        JLabel status = new JLabel(" ");
        status.setFont(Theme.F_SMALL);
        status.setForeground(Theme.DANGER);
        status.setAlignmentX(Component.LEFT_ALIGNMENT);

        Session s = Session.get();
        Runnable submit = () -> {
            status.setText(" ");
            String e = email.getText().trim();
            String p = new String(pw.getPassword());
            boolean reg = mode.selected().equals("注册");
            AuthProvider.Result r = reg
                    ? s.provider().register(e, p, name.getText().trim())
                    : s.provider().login(e, p);
            if (!r.ok) {
                status.setText(r.message);
                return;
            }
            s.adopt(r.account);
            d.dispose();
            Toast.ok("欢迎回来，" + r.account.display());
        };
        go.addActionListener(e -> submit.run());
        ((JTextField) pw).addActionListener(e -> submit.run());

        JPanel foot = new JPanel();
        foot.setOpaque(false);
        foot.setLayout(new BoxLayout(foot, BoxLayout.X_AXIS));
        Btn later = Btn.ghost("暂时不登录");
        later.addActionListener(e -> d.dispose());
        foot.add(later);
        foot.add(Box.createHorizontalGlue());
        foot.add(go);

        JPanel body = new JPanel();
        body.setOpaque(false);
        body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS));
        body.add(top);
        body.add(Box.createVerticalStrut(Theme.S2));
        body.add(status);
        body.add(Box.createVerticalStrut(Theme.S3));
        body.add(foot);

        root.add(body, BorderLayout.CENTER);
        ((JPanel) d.getContentPane()).add(root, BorderLayout.CENTER);
        d.getRootPane().setDefaultButton(go);
        d.pack();
        d.setLocationRelativeTo(owner);
        d.setVisible(true);
    }

    // ---------------- 订阅计划 ----------------

    static void showPlans(Window owner) {
        JDialog d = Dialogs.shell(owner, "订阅计划");
        JPanel root = new JPanel(new BorderLayout());
        root.setOpaque(false);
        root.setBorder(BorderFactory.createEmptyBorder(Theme.S5, Theme.S5, Theme.S4, Theme.S5));

        JLabel title = new JLabel("订阅计划");
        title.setFont(Theme.F_H1);
        title.setForeground(Theme.INK);
        JLabel sub = new JLabel("当前：" + Session.get().planLabel()
                + "　·　免费版可以完成一整局游戏，付费解锁的是效率与团队能力。");
        sub.setFont(Theme.F_SMALL);
        sub.setForeground(Theme.INK_MUTE);

        JPanel cards = new JPanel();
        cards.setOpaque(false);
        cards.setLayout(new BoxLayout(cards, BoxLayout.X_AXIS));
        Plan cur = Session.get().plan();
        for (Plan p : Plan.values()) {
            cards.add(planCard(d, owner, p, p == cur));
            cards.add(Box.createHorizontalStrut(Theme.S3));
        }

        JPanel head = new JPanel();
        head.setOpaque(false);
        head.setLayout(new BoxLayout(head, BoxLayout.Y_AXIS));
        head.add(title);
        head.add(sub);
        head.setBorder(BorderFactory.createEmptyBorder(0, 0, Theme.S4, 0));

        JPanel closeRow = new JPanel();
        closeRow.setOpaque(false);
        closeRow.setLayout(new BoxLayout(closeRow, BoxLayout.X_AXIS));
        JLabel note = new JLabel("接上正式计费后端之前，这里的切换只在本机生效。");
        note.setFont(Theme.F_SMALL);
        note.setForeground(Theme.INK_MUTE);
        closeRow.add(note);
        closeRow.add(Box.createHorizontalGlue());
        Btn close = Btn.normal("关闭");
        close.addActionListener(e -> d.dispose());
        closeRow.add(close);
        closeRow.setBorder(BorderFactory.createEmptyBorder(Theme.S4, 0, 0, 0));

        root.add(head, BorderLayout.NORTH);
        root.add(cards, BorderLayout.CENTER);
        root.add(closeRow, BorderLayout.SOUTH);
        ((JPanel) d.getContentPane()).add(root, BorderLayout.CENTER);
        d.pack();
        d.setLocationRelativeTo(owner);
        d.setVisible(true);
    }

    private static JComponent planCard(JDialog host, Window owner, Plan p, boolean current) {
        JPanel card = new JPanel() {
            private boolean hover;

            {
                addMouseListener(new MouseAdapter() {
                    @Override
                    public void mouseEntered(MouseEvent e) {
                        hover = true;
                        repaint();
                    }

                    @Override
                    public void mouseExited(MouseEvent e) {
                        hover = false;
                        repaint();
                    }
                });
            }

            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                int w = getWidth(), h = getHeight();
                g2.setColor(current ? Theme.ACCENT_SOFT : Theme.SURFACE);
                g2.fillRoundRect(0, 0, w - 1, h - 1, Theme.R_LG, Theme.R_LG);
                g2.setColor(current ? Theme.ACCENT : (hover ? Theme.mix(Theme.LINE, Theme.ACCENT, 0.35f) : Theme.LINE));
                g2.drawRoundRect(0, 0, w - 1, h - 1, Theme.R_LG, Theme.R_LG);
                g2.dispose();
                super.paintComponent(g);
            }
        };
        card.setOpaque(false);
        card.setLayout(new BoxLayout(card, BoxLayout.Y_AXIS));
        card.setBorder(BorderFactory.createEmptyBorder(Theme.S4, Theme.S4, Theme.S4, Theme.S4));
        card.setPreferredSize(new Dimension(238, 356));

        JLabel name = new JLabel(p.cn);
        name.setFont(Theme.F_H2);
        name.setForeground(Theme.INK);
        name.setAlignmentX(Component.LEFT_ALIGNMENT);

        JLabel price = new JLabel(p.priceText());
        price.setFont(Theme.F_H1.deriveFont(22f));
        price.setForeground(p.monthlyYuan == 0 ? Theme.INK_SUB : Theme.ACCENT);
        price.setBorder(BorderFactory.createEmptyBorder(Theme.S2, 0, 2, 0));
        price.setAlignmentX(Component.LEFT_ALIGNMENT);

        JLabel who = new JLabel(p.who);
        who.setFont(Theme.F_SMALL);
        who.setForeground(Theme.INK_MUTE);
        who.setAlignmentX(Component.LEFT_ALIGNMENT);

        card.add(name);
        card.add(price);
        card.add(who);
        card.add(Box.createVerticalStrut(Theme.S3));

        for (String line : p.includes) {
            JPanel row = new JPanel();
            row.setOpaque(false);
            row.setLayout(new BoxLayout(row, BoxLayout.X_AXIS));
            row.setAlignmentX(Component.LEFT_ALIGNMENT);
            JLabel tick = new JLabel(Ico.of(Ico.Kind.MODULE, 13, Theme.OK));
            row.add(tick);
            row.add(Box.createHorizontalStrut(6));
            JLabel t = new JLabel("<html><div style='width:168px'>" + line + "</div></html>");
            t.setFont(Theme.F_SMALL);
            t.setForeground(Theme.INK_SUB);
            row.add(t);
            card.add(row);
            card.add(Box.createVerticalStrut(5));
        }
        card.add(Box.createVerticalGlue());

        Btn action;
        if (current) {
            action = Btn.normal("当前计划");
            action.setEnabled(false);
        } else {
            action = p.monthlyYuan == 0 ? Btn.ghost("降级到免费版") : Btn.primary("切换到" + p.cn);
            action.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            action.addActionListener(e -> {
                if (Session.get().switchPlan(p)) {
                    Toast.ok("已切换到「" + p.cn + "」");
                    host.dispose();
                    javax.swing.SwingUtilities.invokeLater(() -> showPlans(owner));
                }
            });
        }
        action.setAlignmentX(Component.LEFT_ALIGNMENT);
        action.setMaximumSize(new Dimension(Integer.MAX_VALUE, 34));
        card.add(action);
        return card;
    }

    // ---------------- 小工具 ----------------

    private static JComponent labelPair(String label, JComponent field) {
        JPanel p = new JPanel(new BorderLayout(0, 4));
        p.setOpaque(false);
        p.setAlignmentX(Component.LEFT_ALIGNMENT);
        p.add(fieldLabel(label), BorderLayout.NORTH);
        field.setPreferredSize(new Dimension(300, 32));
        p.add(field, BorderLayout.CENTER);
        return p;
    }

    private static JLabel fieldLabel(String s) {
        JLabel l = new JLabel(s);
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.INK_SUB);
        return l;
    }

    private static void style(JTextField f, String tip) {
        f.setFont(Theme.F_BODY);
        f.setToolTipText(tip);
        f.setBorder(BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(Theme.LINE),
                BorderFactory.createEmptyBorder(5, 8, 5, 8)));
    }

    /** 订阅相关按钮的统一样式（供将来的账号页复用）。 */
    public static JComponent planButton(String text, Consumer<Void> onClick) {
        Btn b = Btn.normal(text);
        b.addActionListener(e -> onClick.accept(null));
        return b;
    }
}
