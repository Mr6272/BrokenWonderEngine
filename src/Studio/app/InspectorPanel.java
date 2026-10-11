package Studio.app;

import Studio.data.ModuleDef;
import Studio.data.ModuleInstance;
import Studio.data.ObjKind;
import Studio.data.ParamDef;
import Studio.data.ParamType;
import Studio.data.SceneObject;
import Studio.data.Trigger;
import Studio.modules.ModuleRegistry;
import Studio.ui.Btn;
import Studio.ui.Card;
import Studio.ui.EmptyState;
import Studio.ui.Field;
import Studio.ui.Ico;
import Studio.ui.SimpleCombo;
import Studio.ui.Theme;
import Studio.ui.Toast;
import Studio.ui.Toggle;
import Studio.ui.UIKit;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.SwingUtilities;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * 右侧「对象积木」面板 —— 编辑器里最常停留的地方。
 *
 * 结构固定为两块，顺序不乱：
 *   上：这个对象是什么、在哪、长什么样（属性）
 *   下：它由哪些积木组成（模块栈）
 *
 * 之所以把模块做成"可展开的卡片列表"而不是表格：
 * 表格能塞下参数，但用户看不出积木之间的关系；卡片 + 折叠能同时满足
 * "一眼扫完"和"需要时看到全部参数"两种使用节奏。
 */
public final class InspectorPanel extends Panel {

    private final JPanel root = new JPanel(new BorderLayout());
    private final JPanel stack = new JPanel();
    private final JLabel title = new JLabel("没有选中对象");

    public InspectorPanel(AppState st) {
        super(st);
        build();
        st.addSelectionListener(this::refresh);
        st.addSceneListener(this::refresh);
        refresh();
    }

    @Override
    public String title() {
        return "对象积木";
    }

    @Override
    public Ico.Kind icon() {
        return Ico.Kind.PUZZLE;
    }

    @Override
    public JComponent view() {
        return root;
    }

    private void build() {
        root.setOpaque(false);
        stack.setOpaque(false);
        stack.setLayout(new BoxLayout(stack, BoxLayout.Y_AXIS));
        stack.setBorder(BorderFactory.createEmptyBorder(0, 0, 12, 0));

        JPanel content = new JPanel();
        content.setOpaque(false);
        content.setLayout(new BoxLayout(content, BoxLayout.Y_AXIS));

        JPanel header = new JPanel(new BorderLayout());
        header.setOpaque(false);
        header.setBorder(BorderFactory.createEmptyBorder(0, 2, Theme.S2, 2));
        title.setFont(Theme.F_H2);
        title.setForeground(Theme.INK);
        header.add(title, BorderLayout.WEST);

        content.add(header);
        content.add(stack);

        root.add(UIKit.scroll(content), BorderLayout.CENTER);
    }

    @Override
    public void refresh() {
        SwingUtilities.invokeLater(this::rebuild);
    }

    private void rebuild() {
        stack.removeAll();
        List<SceneObject> sel = st.selection();

        if (sel.isEmpty() || st.project() == null) {
            title.setText("没有选中对象");
            stack.add(emptyState());
            relayout();
            return;
        }
        if (sel.size() > 1) {
            title.setText("选中 " + sel.size() + " 个对象");
            stack.add(multiSelectCard(sel));
            relayout();
            return;
        }

        SceneObject o = sel.get(0);
        title.setText(o.name);
        stack.add(identityCard(o));
        gap();
        stack.add(placeCard(o));
        gap();
        stack.add(modulesCard(o));
        relayout();
    }

    private void relayout() {
        stack.revalidate();
        stack.repaint();
        root.revalidate();
        root.repaint();
    }

    private void gap() {
        stack.add(Box.createVerticalStrut(Theme.S3));
    }

    private JComponent emptyState() {
        Card c = new Card("对象积木");
        c.content().add(new EmptyState(Ico.Kind.MODULE, "还没选中对象",
                "在画布上点一个对象，这里就会出现它的积木。<br>"
                        + "想批量改可以框选多个对象。", null), BorderLayout.CENTER);
        return widen(c);
    }

    private JComponent multiSelectCard(List<SceneObject> sel) {
        Card c = new Card("批量编辑");
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new BoxLayout(p, BoxLayout.Y_AXIS));
        JLabel l = new JLabel("<html><div style='width:250px'>共选中 " + sel.size()
                + " 个对象。下面这些改动会同时作用到全部选中对象。</div></html>");
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.INK_SUB);
        l.setAlignmentX(Component.LEFT_ALIGNMENT);
        p.add(l);
        p.add(Box.createVerticalStrut(Theme.S3));

        Btn show = Btn.normal("全部显示");
        show.addActionListener(e -> {
            st.edit(() -> sel.forEach(x -> x.visible = true));
            Toast.ok("已显示 " + sel.size() + " 个对象");
        });
        Btn hide = Btn.normal("全部隐藏");
        hide.addActionListener(e -> {
            st.edit(() -> sel.forEach(x -> x.visible = false));
            Toast.ok("已隐藏 " + sel.size() + " 个对象");
        });
        Btn align = Btn.normal("按纵向对齐");
        align.setToolTipText("把它们的 X 坐标对齐到第一个对象");
        align.addActionListener(e -> {
            if (sel.isEmpty()) {
                return;
            }
            float x = sel.get(0).x;
            st.edit(() -> sel.forEach(o -> o.x = x));
            Toast.ok("已对齐");
        });
        Btn del = new Btn("全部删除", Btn.Variant.DANGER);
        del.addActionListener(e -> Actions.deleteSelection(st));

        p.add(UIKit.row(6, show, hide));
        p.add(Box.createVerticalStrut(6));
        p.add(UIKit.row(6, align, del));
        c.content().add(p, BorderLayout.CENTER);
        return widen(c);
    }

    // ---------------- 身份 ----------------

    private JComponent identityCard(SceneObject o) {
        Card c = new Card("它是什么");
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new BoxLayout(p, BoxLayout.Y_AXIS));

        JPanel nameRow = new JPanel();
        nameRow.setOpaque(false);
        nameRow.setLayout(new BoxLayout(nameRow, BoxLayout.X_AXIS));
        nameRow.setAlignmentX(Component.LEFT_ALIGNMENT);
        nameRow.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));
        Field name = new Field(o.name, "给它起个名字");
        name.setPreferredSize(new Dimension(150, 28));
        name.setToolTipText("名字会显示在画布上，也用于「换到另一张地图」等模块里选对象");
        name.addActionListener(e -> {
            rename(o, name.getText());
        });
        name.addFocusListener(new java.awt.event.FocusAdapter() {
            @Override
            public void focusLost(java.awt.event.FocusEvent e) {
                rename(o, name.getText());
            }
        });
        JLabel kind = new JLabel(o.kind.cn);
        kind.setFont(Theme.F_SMALL);
        kind.setForeground(Theme.INK_MUTE);
        kind.setBorder(BorderFactory.createEmptyBorder(0, 8, 0, 0));
        nameRow.add(name);
        nameRow.add(kind);
        nameRow.add(Box.createHorizontalGlue());
        p.add(nameRow);

        p.add(Box.createVerticalStrut(Theme.S2));
        JPanel kindRow = new JPanel();
        kindRow.setOpaque(false);
        kindRow.setLayout(new BoxLayout(kindRow, BoxLayout.X_AXIS));
        kindRow.setAlignmentX(Component.LEFT_ALIGNMENT);
        SimpleCombo<ObjKind> kinds = new SimpleCombo<>(ObjKind.values());
        kinds.select(o.kind);
        kinds.setMaximumSize(new Dimension(130, 28));
        kinds.setToolTipText(o.kind.hint);
        kinds.addActionListener(e -> {
            ObjKind k = (ObjKind) kinds.getSelectedItem();
            if (k != null && k != o.kind) {
                st.edit(() -> o.kind = k);
                Toast.info("改成了「" + k.cn + "」：" + k.hint);
                refresh();
            }
        });
        JLabel kindHint = new JLabel(o.kind.hint);
        kindHint.setFont(Theme.F_SMALL);
        kindHint.setForeground(Theme.INK_MUTE);
        kindHint.setBorder(BorderFactory.createEmptyBorder(0, 8, 0, 0));
        kindRow.add(kinds);
        kindRow.add(kindHint);
        kindRow.add(Box.createHorizontalGlue());
        p.add(kindRow);

        p.add(Box.createVerticalStrut(Theme.S2));
        JPanel tagRow = new JPanel(new BorderLayout(6, 0));
        tagRow.setOpaque(false);
        tagRow.setAlignmentX(Component.LEFT_ALIGNMENT);
        Field tags = new Field(String.join(",", o.tags), "标签，逗号分开");
        tags.setPreferredSize(new Dimension(180, 28));
        tags.setToolTipText("标签用于批量匹配：例如给所有敌人都打上「敌人」，范围检查就能一次全管");
        tags.addFocusListener(new java.awt.event.FocusAdapter() {
            @Override
            public void focusLost(java.awt.event.FocusEvent e) {
                applyTags(o, tags.getText());
            }
        });
        tags.addActionListener(e -> applyTags(o, tags.getText()));
        tagRow.add(tags, BorderLayout.CENTER);
        p.add(tagRow);
        p.add(Box.createVerticalStrut(4));
        JLabel tagHint = new JLabel(o.tags.isEmpty() ? "（没有标签）" : "标签：" + String.join(" · ", o.tags));
        tagHint.setFont(Theme.F_SMALL.deriveFont(10.5f));
        tagHint.setForeground(Theme.INK_MUTE);
        tagHint.setAlignmentX(Component.LEFT_ALIGNMENT);
        p.add(tagHint);

        c.content().add(p, BorderLayout.CENTER);
        return widen(c);
    }

    private void rename(SceneObject o, String v) {
        String s = v == null ? "" : v.trim();
        if (s.isEmpty() || s.equals(o.name)) {
            return;
        }
        st.edit(() -> o.name = s);
        st.statusHint("改名为「" + s + "」");
    }

    private void applyTags(SceneObject o, String raw) {
        List<String> tags = new ArrayList<>();
        for (String part : (raw == null ? "" : raw).split("[,，、|]")) {
            String t = part.trim();
            if (!t.isEmpty() && !tags.contains(t)) {
                tags.add(t);
            }
        }
        if (tags.equals(o.tags)) {
            return;
        }
        st.edit(() -> {
            o.tags.clear();
            o.tags.addAll(tags);
        });
        st.statusHint(tags.isEmpty() ? "已清空标签" : "标签：" + String.join(" · ", tags));
        refresh();
    }

    // ---------------- 位置与显示 ----------------

    private JComponent placeCard(SceneObject o) {
        Card c = new Card("在哪、长什么样");
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new BoxLayout(p, BoxLayout.Y_AXIS));

        p.add(numRow("横向位置", o.x, v -> {
            st.edit(() -> o.x = v);
            repaintCanvas();
        }, "像素，往右变大"));
        p.add(numRow("纵向位置", o.y, v -> {
            st.edit(() -> o.y = v);
            repaintCanvas();
        }, "像素，往下变大（俯视角）"));
        p.add(numRow("旋转角度", o.rotation, v -> {
            st.edit(() -> o.rotation = v);
            repaintCanvas();
        }, "度，顺时针"));
        p.add(numRow("横向缩放", o.scaleX, v -> {
            st.edit(() -> o.scaleX = Math.max(0.05f, v));
            repaintCanvas();
        }, "1 表示原始大小"));
        p.add(numRow("纵向缩放", o.scaleY, v -> {
            st.edit(() -> o.scaleY = Math.max(0.05f, v));
            repaintCanvas();
        }, ""));
        p.add(numRow("碰撞半宽", o.halfW, v -> {
            st.edit(() -> o.halfW = Math.max(0, v));
            repaintCanvas();
        }, "0 表示不参与碰撞"));
        p.add(numRow("碰撞半高", o.halfH, v -> {
            st.edit(() -> o.halfH = Math.max(0, v));
            repaintCanvas();
        }, "0 表示不参与碰撞"));

        p.add(Box.createVerticalStrut(Theme.S2));
        JPanel toggles = new JPanel();
        toggles.setOpaque(false);
        toggles.setLayout(new BoxLayout(toggles, BoxLayout.X_AXIS));
        toggles.setAlignmentX(Component.LEFT_ALIGNMENT);
        toggles.add(smallToggle("显示", o.visible, v -> {
            st.edit(() -> o.visible = v);
            repaintCanvas();
        }));
        toggles.add(Box.createHorizontalStrut(14));
        toggles.add(smallToggle("锁定", o.locked, v -> {
            st.edit(() -> o.locked = v);
            st.statusHint(v ? "已锁定，画布上点不到它了" : "已解锁");
        }));
        toggles.add(Box.createHorizontalGlue());
        p.add(toggles);

        c.content().add(p, BorderLayout.CENTER);
        return widen(c);
    }

    private JComponent numRow(String label, float value, java.util.function.Consumer<Float> onChange, String hint) {
        JPanel row = new JPanel();
        row.setOpaque(false);
        row.setLayout(new BoxLayout(row, BoxLayout.X_AXIS));
        row.setAlignmentX(Component.LEFT_ALIGNMENT);
        row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));
        JLabel l = new JLabel(label);
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.INK_SUB);
        l.setPreferredSize(new Dimension(74, 24));
        Field f = new Field(Studio.ui.Field.ParamFmt.trim(value), "");
        f.numeric(value, -1000000, 1000000);
        f.setPreferredSize(new Dimension(76, 28));
        f.setMaximumSize(new Dimension(76, 28));
        if (hint != null && !hint.isEmpty()) {
            f.setToolTipText(hint);
        }
        Runnable commit = () -> onChange.accept(f.floatValue(value));
        f.addActionListener(e -> commit.run());
        f.addFocusListener(new java.awt.event.FocusAdapter() {
            @Override
            public void focusLost(java.awt.event.FocusEvent e) {
                commit.run();
            }
        });
        row.add(l);
        row.add(f);
        row.add(Box.createHorizontalGlue());
        row.setBorder(BorderFactory.createEmptyBorder(0, 0, 5, 0));
        return row;
    }

    private JComponent smallToggle(String label, boolean init, java.util.function.Consumer<Boolean> onChange) {
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new BoxLayout(p, BoxLayout.X_AXIS));
        p.add(new Toggle(init, onChange));
        JLabel l = new JLabel(label);
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.INK_SUB);
        l.setBorder(BorderFactory.createEmptyBorder(0, 6, 0, 0));
        p.add(l);
        return p;
    }

    private void repaintCanvas() {
        for (java.awt.Window w : java.awt.Window.getWindows()) {
            if (w instanceof MainWindow) {
                w.repaint();
            }
        }
        st.statusHint("已更新");
    }

    // ---------------- 模块栈 ----------------

    private JComponent modulesCard(SceneObject o) {
        Card c = new Card("它的积木");
        c.addTool(hintIcon("模块是加在对象身上的行为。点标题展开看参数。"));
        JPanel head = new JPanel();
        head.setOpaque(false);
        head.setLayout(new BoxLayout(head, BoxLayout.X_AXIS));
        head.setAlignmentX(Component.LEFT_ALIGNMENT);
        Btn add = Btn.primary("+ 加积木").small();
        add.setToolTipText("打开左侧「模块」标签页，双击积木即可加上");
        add.addActionListener(e -> Toast.info("左侧「模块」标签页里，双击一块积木就加到这个对象上"));
        JLabel cnt = new JLabel(o.modules.isEmpty() ? "还没有积木" : o.modules.size() + " 块积木");
        cnt.setFont(Theme.F_SMALL);
        cnt.setForeground(Theme.INK_MUTE);
        cnt.setBorder(BorderFactory.createEmptyBorder(0, 8, 0, 0));
        head.add(add);
        head.add(cnt);
        head.add(Box.createHorizontalGlue());

        JPanel listPanel = new JPanel();
        listPanel.setOpaque(false);
        listPanel.setLayout(new BoxLayout(listPanel, BoxLayout.Y_AXIS));
        listPanel.setAlignmentX(Component.LEFT_ALIGNMENT);

        if (o.modules.isEmpty()) {
            JLabel none = new JLabel("<html><div style='width:250px'>这个对象现在什么都不做，只是安静地摆在那里。"
                    + "<br>去左边「模块」页挑一块积木，例如「怎么动 → 朝玩家走」。</div></html>");
            none.setFont(Theme.F_SMALL);
            none.setForeground(Theme.INK_MUTE);
            none.setAlignmentX(Component.LEFT_ALIGNMENT);
            none.setBorder(BorderFactory.createEmptyBorder(4, 0, 8, 0));
            listPanel.add(none);
        } else {
            for (int i = 0; i < o.modules.size(); i++) {
                listPanel.add(moduleCard(o, o.modules.get(i), i));
                listPanel.add(Box.createVerticalStrut(6));
            }
        }

        JPanel wrap = new JPanel();
        wrap.setOpaque(false);
        wrap.setLayout(new BoxLayout(wrap, BoxLayout.Y_AXIS));
        wrap.add(head);
        wrap.add(Box.createVerticalStrut(8));
        wrap.add(listPanel);
        c.content().add(wrap, BorderLayout.CENTER);
        return widen(c);
    }

    /** 一块积木的卡片：色条 + 标题 + 摘要 + 展开后的参数。 */
    private JComponent moduleCard(SceneObject owner, ModuleInstance inst, int index) {
        ModuleDef def = ModuleRegistry.get().def(inst.defId);
        String moduleTitle = def == null ? "（未知积木：" + inst.defId + "）" : def.title;
        Color accent = def == null ? Theme.INK_MUTE : Color.decode(def.category.color);

        JPanel card = new JPanel(new BorderLayout()) {
            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setColor(inst.enabled ? Theme.SURFACE_ALT : Theme.SURFACE_SUNK);
                g2.fillRoundRect(0, 0, getWidth() - 1, getHeight() - 1, Theme.R_MD, Theme.R_MD);
                g2.setColor(Theme.LINE_SOFT);
                g2.drawRoundRect(0, 0, getWidth() - 1, getHeight() - 1, Theme.R_MD, Theme.R_MD);
                g2.setColor(inst.enabled ? accent : Theme.LINE);
                g2.fillRoundRect(2, 5, 3, getHeight() - 10, 3, 3);
                g2.dispose();
                super.paintComponent(g);
            }
        };
        card.setOpaque(false);
        card.setAlignmentX(Component.LEFT_ALIGNMENT);
        card.setBorder(BorderFactory.createEmptyBorder(6, 12, 6, 6));

        JPanel header = new JPanel(new BorderLayout());
        header.setOpaque(false);
        header.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        header.setToolTipText(def == null ? inst.defId
                : "<html><div style='width:330px'>" + def.detail + "</div></html>");

        JPanel left = new JPanel();
        left.setOpaque(false);
        left.setLayout(new BoxLayout(left, BoxLayout.X_AXIS));
        JLabel arrow = new JLabel(Ico.of(inst.collapsed ? Ico.Kind.CHEVRON_RIGHT : Ico.Kind.CHEVRON_DOWN,
                14, Theme.INK_MUTE));
        JLabel name = new JLabel(moduleTitle);
        name.setFont(Theme.F_BODY.deriveFont(inst.collapsed ? Font.PLAIN : Font.BOLD));
        name.setForeground(inst.enabled ? Theme.INK : Theme.INK_MUTE);
        left.add(arrow);
        left.add(Box.createHorizontalStrut(6));
        left.add(name);

        JPanel right = new JPanel();
        right.setOpaque(false);
        right.setLayout(new BoxLayout(right, BoxLayout.X_AXIS));
        Toggle on = new Toggle(inst.enabled, v -> {
            inst.enabled = v;
            st.markDirty();
            st.statusHint(v ? "已启用「" + moduleTitle + "」" : "已停用「" + moduleTitle + "」（保留配置）");
            refresh();
        });
        right.add(on);
        right.add(Box.createHorizontalStrut(6));
        javax.swing.JButton del = Btn.iconOnly(Ico.Kind.TRASH, "移掉这块积木");
        del.setPreferredSize(new Dimension(26, 26));
        del.addActionListener(e -> {
            owner.modules.remove(inst);
            st.markDirty();
            Toast.ok("已移掉「" + moduleTitle + "」");
            refresh();
        });
        right.add(del);

        header.add(left, BorderLayout.WEST);
        header.add(right, BorderLayout.EAST);
        header.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                if (e.getX() < header.getWidth() - 70) {
                    inst.collapsed = !inst.collapsed;
                    refresh();
                }
            }
        });

        card.add(header, BorderLayout.NORTH);

        if (!inst.collapsed) {
            JPanel body = new JPanel();
            body.setOpaque(false);
            body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS));
            body.setBorder(BorderFactory.createEmptyBorder(8, 20, 2, 0));

            if (def != null) {
                JLabel blurb = new JLabel("<html><div style='width:236px'>" + def.blurb + "</div></html>");
                blurb.setFont(Theme.F_SMALL.deriveFont(10.5f));
                blurb.setForeground(Theme.INK_MUTE);
                blurb.setAlignmentX(Component.LEFT_ALIGNMENT);
                body.add(blurb);
                body.add(Box.createVerticalStrut(6));

                if (def.triggers.size() > 1) {
                    body.add(triggerRow(inst, def));
                } else if (def.triggers.size() == 1) {
                    JLabel w = new JLabel("触发时机：" + def.triggers.get(0).cn);
                    w.setFont(Theme.F_SMALL);
                    w.setForeground(Theme.INK_SUB);
                    w.setAlignmentX(Component.LEFT_ALIGNMENT);
                    w.setBorder(BorderFactory.createEmptyBorder(0, 0, 6, 0));
                    body.add(w);
                }

                for (ParamDef d : def.params) {
                    if (d.type == ParamType.NOTE) {
                        JLabel n = new JLabel("<html><div style='width:230px'>" + d.label + "</div></html>");
                        n.setFont(Theme.F_SMALL.deriveFont(10.5f));
                        n.setForeground(Theme.INK_MUTE);
                        n.setAlignmentX(Component.LEFT_ALIGNMENT);
                        n.setBorder(BorderFactory.createEmptyBorder(2, 0, 4, 0));
                        body.add(n);
                        continue;
                    }
                    body.add(paramRow(inst, d));
                }
                body.add(Box.createVerticalStrut(4));
                JPanel ops = new JPanel();
                ops.setOpaque(false);
                ops.setLayout(new BoxLayout(ops, BoxLayout.X_AXIS));
                ops.setAlignmentX(Component.LEFT_ALIGNMENT);
                Btn dup = Btn.ghost("复制一块").small();
                dup.addActionListener(e -> {
                    ModuleInstance c = new ModuleInstance(inst.defId);
                    c.label = inst.label;
                    c.trigger = inst.trigger;
                    c.values.putAll(inst.values);
                    c.collapsed = false;
                    owner.modules.add(index + 1, c);
                    st.markDirty();
                    Toast.ok("已复制「" + moduleTitle + "」");
                    refresh();
                });
                Btn up = Btn.ghost("上移").small();
                up.addActionListener(e -> {
                    if (index > 0) {
                        owner.modules.remove(index);
                        owner.modules.add(index - 1, inst);
                        st.markDirty();
                        refresh();
                    }
                });
                Btn down = Btn.ghost("下移").small();
                down.addActionListener(e -> {
                    if (index < owner.modules.size() - 1) {
                        owner.modules.remove(index);
                        owner.modules.add(index + 1, inst);
                        st.markDirty();
                        refresh();
                    }
                });
                ops.add(dup);
                ops.add(Box.createHorizontalStrut(4));
                ops.add(up);
                ops.add(Box.createHorizontalStrut(4));
                ops.add(down);
                ops.add(Box.createHorizontalGlue());
                body.add(ops);
            }
            card.add(body, BorderLayout.CENTER);
        }
        return card;
    }

    private JComponent triggerRow(ModuleInstance inst, ModuleDef def) {
        JPanel row = new JPanel();
        row.setOpaque(false);
        row.setLayout(new BoxLayout(row, BoxLayout.X_AXIS));
        row.setAlignmentX(Component.LEFT_ALIGNMENT);
        row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));
        JLabel l = new JLabel("什么时候做");
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.INK_SUB);
        l.setPreferredSize(new Dimension(74, 24));
        SimpleCombo<Trigger> combo = new SimpleCombo<>(def.triggers);
        Trigger cur = inst.trigger == null ? def.defaultTrigger() : inst.trigger;
        if (!def.triggers.contains(cur)) {
            cur = def.defaultTrigger();
        }
        combo.select(cur);
        combo.setMaximumSize(new Dimension(150, 28));
        combo.addActionListener(e -> {
            Trigger t = (Trigger) combo.getSelectedItem();
            if (t != null) {
                inst.trigger = t;
                st.markDirty();
                st.statusHint("「" + def.title + "」改成：" + t.cn);
            }
        });
        row.add(l);
        row.add(combo);
        row.add(Box.createHorizontalGlue());
        row.setBorder(BorderFactory.createEmptyBorder(0, 0, 5, 0));
        return row;
    }

    /** 单个参数行：按类型给合适的控件，绝不让用户手敲格式。 */
    private JComponent paramRow(ModuleInstance inst, ParamDef d) {
        JPanel row = new JPanel();
        row.setOpaque(false);
        row.setLayout(new BoxLayout(row, BoxLayout.X_AXIS));
        row.setAlignmentX(Component.LEFT_ALIGNMENT);
        row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));
        row.setBorder(BorderFactory.createEmptyBorder(0, 0, 5, 0));

        JLabel l = new JLabel(d.label);
        l.setFont(Theme.F_SMALL);
        l.setForeground(d.required ? Theme.INK : Theme.INK_SUB);
        l.setPreferredSize(new Dimension(74, 24));
        l.setToolTipText(d.hint);
        row.add(l);

        String cur = inst.value(d.key, d.def);
        switch (d.type) {
            case NUM: {
                float v = inst.floatOf(d.key, parseFloat(d.def));
                float min = d.max > d.min ? d.min : -1000000;
                float max = d.max > d.min ? d.max : 1000000;
                Field f = new Field(Studio.ui.Field.ParamFmt.trim(v), "");
                f.numeric(v, min, max);
                f.setPreferredSize(new Dimension(70, 28));
                f.setMaximumSize(new Dimension(70, 28));
                if (!d.unit.isEmpty()) {
                    f.setToolTipText(d.hint + "（单位：" + d.unit + "）");
                }
                Runnable commit = () -> {
                    float nv = f.floatValue(v);
                    if (d.max > d.min) {
                        nv = Math.max(min, Math.min(max, nv));
                    }
                    inst.set(d.key, Studio.ui.Field.ParamFmt.trim(nv));
                    st.markDirty();
                };
                f.addActionListener(e -> commit.run());
                f.addFocusListener(new java.awt.event.FocusAdapter() {
                    @Override
                    public void focusLost(java.awt.event.FocusEvent e) {
                        commit.run();
                    }
                });
                row.add(f);
                if (!d.unit.isEmpty()) {
                    JLabel u = new JLabel(d.unit);
                    u.setFont(Theme.F_SMALL.deriveFont(10f));
                    u.setForeground(Theme.INK_MUTE);
                    u.setBorder(BorderFactory.createEmptyBorder(0, 4, 0, 0));
                    row.add(u);
                }
                break;
            }
            case BOOL: {
                Toggle t = new Toggle(inst.boolOf(d.key, "开".equals(d.def)), v -> {
                    inst.set(d.key, v ? "开" : "关");
                    st.markDirty();
                });
                t.setToolTipText(d.hint);
                row.add(t);
                break;
            }
            case PICK: {
                if (d.options.size() > 6) {
                    SimpleCombo<String> c = new SimpleCombo<>(d.options);
                    c.select(cur);
                    c.setMaximumSize(new Dimension(150, 28));
                    c.addActionListener(e -> {
                        inst.set(d.key, c.selectedText());
                        st.markDirty();
                    });
                    row.add(c);
                } else {
                    Studio.ui.Seg<String> seg = new Studio.ui.Seg<>(d.options, d.options, cur, v -> {
                        inst.set(d.key, v);
                        st.markDirty();
                    });
                    seg.setMaximumSize(new Dimension(170, 28));
                    seg.setPreferredSize(new Dimension(150, 28));
                    row.add(seg);
                }
                break;
            }
            default: {
                Field f = new Field(cur, d.hint);
                f.setPreferredSize(new Dimension(140, 28));
                f.setMaximumSize(new Dimension(200, 28));
                f.setToolTipText(d.hint);
                Runnable commit = () -> {
                    inst.set(d.key, f.getText().trim());
                    st.markDirty();
                };
                f.addActionListener(e -> commit.run());
                f.addFocusListener(new java.awt.event.FocusAdapter() {
                    @Override
                    public void focusLost(java.awt.event.FocusEvent e) {
                        commit.run();
                    }
                });
                row.add(f);
                if (d.type == ParamType.OBJ || d.type == ParamType.ASSET
                        || d.type == ParamType.TAG || d.type == ParamType.SCRIPT) {
                    JLabel pick = new JLabel("选择 ▸");
                    pick.setFont(Theme.F_SMALL.deriveFont(10f));
                    pick.setForeground(Theme.ACCENT);
                    pick.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
                    pick.setBorder(BorderFactory.createEmptyBorder(0, 6, 0, 0));
                    pick.setToolTipText(pickHint(d.type));
                    pick.addMouseListener(new MouseAdapter() {
                        @Override
                        public void mouseClicked(MouseEvent e) {
                            pickValue(inst, d, f);
                        }
                    });
                    row.add(pick);
                }
                break;
            }
        }
        row.add(Box.createHorizontalGlue());
        return row;
    }

    private static String pickHint(ParamType t) {
        return switch (t) {
            case OBJ -> "从当前场景里挑一个对象";
            case ASSET -> "从素材库里挑一条素材";
            case TAG -> "挑一个标签（在对象面板里设置过才会出现）";
            case SCRIPT -> "挑一段剧本";
            default -> "";
        };
    }

    /** 引用类参数的取值弹窗：只列已存在的候选，不让人手填 id。 */
    private void pickValue(ModuleInstance inst, ParamDef d, Field target) {
        List<String> options = new ArrayList<>();
        switch (d.type) {
            case OBJ -> {
                if (st.scene() != null) {
                    for (SceneObject o : st.scene().objects) {
                        options.add(o.name);
                    }
                }
            }
            case ASSET -> {
                if (st.project() != null) {
                    for (Studio.data.AssetEntry a : st.project().assets.items) {
                        options.add(a.name);
                    }
                }
            }
            case TAG -> {
                if (st.scene() != null) {
                    LinkedHashMap<String, Boolean> seen = new LinkedHashMap<>();
                    for (SceneObject o : st.scene().objects) {
                        for (String t : o.tags) {
                            seen.put(t, true);
                        }
                    }
                    options.addAll(seen.keySet());
                }
            }
            case SCRIPT -> {
                if (st.project() != null) {
                    options.addAll(st.project().scripts.keySet());
                }
            }
            default -> {
            }
        }
        if (options.isEmpty()) {
            Toast.info("这边还没有可选项，先把对象或素材准备好；也可以直接手填名字");
            return;
        }
        javax.swing.JPopupMenu menu = new javax.swing.JPopupMenu();
        for (String o : options) {
            javax.swing.JMenuItem it = new javax.swing.JMenuItem(o);
            it.addActionListener(e -> {
                inst.set(d.key, o);
                st.markDirty();
                target.setText(o);
                st.statusHint(d.label + " → " + o);
            });
            menu.add(it);
        }
        menu.show(target, 0, target.getHeight());
    }

    private static float parseFloat(String s) {
        try {
            return Float.parseFloat(s);
        } catch (Exception e) {
            return 0;
        }
    }

    private JComponent hintIcon(String tip) {
        JLabel l = new JLabel(Ico.of(Ico.Kind.WARN, 14, Theme.INK_MUTE));
        l.setToolTipText(tip);
        return l;
    }

    /** 卡片在 BoxLayout 纵向排列下需要"横向拉满、纵向按内容"。 */
    private static JComponent widen(JComponent c) {
        c.setAlignmentX(Component.LEFT_ALIGNMENT);
        c.setMaximumSize(new Dimension(Integer.MAX_VALUE, Integer.MAX_VALUE));
        return c;
    }
}
