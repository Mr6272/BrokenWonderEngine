package Studio.app;

import Studio.data.ModuleCategory;
import Studio.data.ModuleDef;
import Studio.data.ModuleInstance;
import Studio.data.ParamDef;
import Studio.data.ParamType;
import Studio.data.SceneObject;
import Studio.modules.ModuleRegistry;
import Studio.ui.Btn;
import Studio.ui.Field;
import Studio.ui.Ico;
import Studio.ui.Theme;
import Studio.ui.Toast;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.DefaultListModel;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.ListCellRenderer;
import javax.swing.ListSelectionModel;
import javax.swing.SwingUtilities;
import javax.swing.TransferHandler;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.datatransfer.Transferable;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.ArrayList;
import java.util.List;

/**
 * 模块目录面板。
 *
 * 用户看到的是"积木货架"：按「怎么动 / 怎么显示 / 怎么感知 / 什么时候做 / 怎么打 / 怎么说话 / 画面与声音」
 * 分组，每块积木一行说明。可以双击或拖到选中对象上加装。
 *
 * 关键体验取舍：不显示参数、不显示内部 id —— 货架上只回答"这块积木是干什么的"。
 */
public final class ModulePanel extends Panel {

    private final JPanel root = new JPanel(new BorderLayout());
    private final DefaultListModel<Object> model = new DefaultListModel<>();
    private final JList<Object> list = new JList<>(model);
    private final Field search = new Field("", "搜模块：走路、点击、范围…");
    private final JLabel status = new JLabel(" ");
    private ModuleCategory filter;

    public ModulePanel(AppState st) {
        super(st);
        build();
        refill();
    }

    @Override
    public String title() {
        return "模块";
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

        JPanel top = new JPanel();
        top.setOpaque(false);
        top.setLayout(new BoxLayout(top, BoxLayout.Y_AXIS));
        top.setBorder(BorderFactory.createEmptyBorder(0, 0, Theme.S2, 0));
        search.setMaximumSize(new Dimension(Integer.MAX_VALUE, 28));
        search.addCaretListener(e -> refill());
        top.add(search);

        JPanel chips = new JPanel(new java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 4, 4));
        chips.setOpaque(false);
        chips.add(chip("全部", null));
        for (ModuleCategory c : ModuleCategory.values()) {
            chips.add(chip(c.cn, c));
        }
        top.add(chips);

        list.setCellRenderer(new ModuleRenderer());
        list.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        list.setBackground(Theme.SURFACE);
        list.setFixedCellHeight(60);
        list.setBorder(BorderFactory.createEmptyBorder(4, 4, 4, 4));
        list.setDragEnabled(true);
        list.setTransferHandler(new TransferHandler() {
            @Override
            protected Transferable createTransferable(JComponent c) {
                Object o = list.getSelectedValue();
                if (o instanceof Row r) {
                    return new DragPayload(DragPayload.What.MODULE, r.def.id, r.def.title);
                }
                return null;
            }

            @Override
            public int getSourceActions(JComponent c) {
                return COPY;
            }
        });
        list.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                if (e.getClickCount() == 2) {
                    Object o = list.getSelectedValue();
                    if (o instanceof Row r) {
                        addToSelection(r.def);
                    }
                }
            }
        });

        status.setFont(Theme.F_SMALL);
        status.setForeground(Theme.INK_MUTE);
        status.setBorder(BorderFactory.createEmptyBorder(0, 2, 0, 0));

        root.add(top, BorderLayout.NORTH);
        root.add(Studio.ui.UIKit.scroll(list), BorderLayout.CENTER);
        root.add(status, BorderLayout.SOUTH);
    }

    private JComponent chip(String text, ModuleCategory c) {
        Btn b = new Btn(text, filter == c ? Btn.Variant.SOFT : Btn.Variant.GHOST);
        b.setFont(Theme.F_SMALL.deriveFont(11f));
        b.setBorder(BorderFactory.createEmptyBorder(3, 8, 3, 8));
        if (c != null) {
            b.setToolTipText(c.blurb);
        }
        b.addActionListener(e -> {
            filter = (filter == c) ? null : c;
            rebuildChips();
            refill();
        });
        b.putClientProperty("cat", c);
        return b;
    }

    private void rebuildChips() {
        JComponent top = (JComponent) root.getComponent(0);
        JComponent chips = (JComponent) top.getComponent(1);
        chips.removeAll();
        chips.add(chip("全部", null));
        for (ModuleCategory c : ModuleCategory.values()) {
            chips.add(chip(c.cn, c));
        }
        chips.revalidate();
        chips.repaint();
    }

    /** 列表行：分类标题或一块积木。 */
    private static final class Row {
        final ModuleCategory header;
        final ModuleDef def;

        Row(ModuleCategory h, ModuleDef d) {
            header = h;
            def = d;
        }
    }

    private void refill() {
        String q = search.getText() == null ? "" : search.getText().trim();
        model.clear();
        int n = 0;
        if (q.isEmpty()) {
            for (ModuleCategory c : ModuleCategory.values()) {
                if (filter != null && filter != c) {
                    continue;
                }
                List<ModuleDef> defs = ModuleRegistry.get().byCategory(c);
                if (defs.isEmpty()) {
                    continue;
                }
                model.addElement(new Row(c, null));
                for (ModuleDef d : defs) {
                    model.addElement(new Row(null, d));
                    n++;
                }
            }
        } else {
            for (ModuleDef d : ModuleRegistry.get().search(q)) {
                if (filter != null && d.category != filter) {
                    continue;
                }
                model.addElement(new Row(null, d));
                n++;
            }
        }
        if (n == 0) {
            status.setText("没找到这样的模块　·　换个词试试，比如「点击」「范围」「血量」");
        } else {
            status.setText(n + " 块积木可用　·　双击或拖到画布上的对象");
        }
    }

    private void addToSelection(ModuleDef d) {
        if (st.selection().isEmpty()) {
            Toast.info("先在画布上选一个对象，再加模块");
            st.statusHint("提示：模块是加在对象身上的，先点中一个对象");
            return;
        }
        if (Studio.account.Session.get().plan().atLeast(Studio.account.Plan.INDIE) == false && d.premium) {
            Toast.warn("「" + d.title + "」需要订阅才能使用");
            return;
        }
        for (SceneObject o : st.selection()) {
            ModuleInstance m = new ModuleInstance(d.id);
            for (ParamDef p : d.params) {
                if (p.type != ParamType.NOTE) {
                    m.values.put(p.key, p.def);
                }
            }
            m.trigger = d.defaultTrigger();
            o.modules.add(m);
        }
        st.markDirty();
        st.statusHint("已给 " + st.selection().size() + " 个对象加上「" + d.title + "」");
        Toast.ok("加了「" + d.title + "」");
    }

    /** 行渲染：分类标题窄条，积木卡片带左侧色条。 */
    private static final class ModuleRenderer implements ListCellRenderer<Object> {
        @Override
        public Component getListCellRendererComponent(JList<?> l, Object value, int idx, boolean sel, boolean focus) {
            Row row = (Row) value;
            if (row.header != null) {
                JPanel head = new JPanel(new BorderLayout());
                head.setOpaque(false);
                head.setBorder(BorderFactory.createEmptyBorder(10, 4, 2, 4));
                JLabel t = new JLabel(row.header.cn);
                t.setFont(Theme.F_SMALL.deriveFont(java.awt.Font.BOLD));
                t.setForeground(Color.decode(row.header.color));
                JLabel s = new JLabel("　" + row.header.blurb);
                s.setFont(Theme.F_SMALL.deriveFont(10f));
                s.setForeground(Theme.INK_MUTE);
                JPanel line = new JPanel(new BorderLayout());
                line.setOpaque(false);
                line.add(t, BorderLayout.WEST);
                line.add(s, BorderLayout.CENTER);
                head.add(line, BorderLayout.CENTER);
                return head;
            }
            ModuleDef d = row.def;
            Color accent = Color.decode(d.category.color);
            JPanel card = new JPanel(new BorderLayout()) {
                @Override
                protected void paintComponent(Graphics g) {
                    Graphics2D g2 = (Graphics2D) g.create();
                    g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                    g2.setColor(sel ? Theme.ACCENT_SOFT : Theme.SURFACE);
                    g2.fillRoundRect(0, 0, getWidth() - 1, getHeight() - 1, Theme.R_MD, Theme.R_MD);
                    g2.setColor(sel ? Theme.ACCENT : Theme.LINE_SOFT);
                    g2.drawRoundRect(0, 0, getWidth() - 1, getHeight() - 1, Theme.R_MD, Theme.R_MD);
                    g2.setColor(accent);
                    g2.fillRoundRect(3, 6, 3, getHeight() - 12, 3, 3);
                    g2.dispose();
                    super.paintComponent(g);
                }
            };
            card.setOpaque(false);
            card.setBorder(BorderFactory.createEmptyBorder(7, 14, 7, 8));

            JPanel texts = new JPanel();
            texts.setOpaque(false);
            texts.setLayout(new BoxLayout(texts, BoxLayout.Y_AXIS));
            JLabel name = new JLabel(d.title + (d.experimental ? "　（试验中）" : ""));
            name.setFont(Theme.F_BODY.deriveFont(java.awt.Font.BOLD));
            name.setForeground(d.experimental ? Theme.INK_SUB : Theme.INK);
            JLabel blurb = new JLabel("<html><div style='width:206px'>" + d.blurb + "</div></html>");
            blurb.setFont(Theme.F_SMALL.deriveFont(10.5f));
            blurb.setForeground(Theme.INK_MUTE);
            texts.add(name);
            texts.add(blurb);

            card.add(texts, BorderLayout.CENTER);
            card.setToolTipText("<html><div style='width:320px'><b>" + d.title + "</b>（" + d.category.cn
                    + "）<br>" + d.blurb + "<br><br>" + d.detail + "</div></html>");
            card.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            return card;
        }
    }

    private static List<ModuleDef> all() {
        List<ModuleDef> l = new ArrayList<>(ModuleRegistry.get().all());
        return l;
    }

    /** 未选中对象时的引导文案（InspectorPanel 复用）。 */
    static String noSelectionHint() {
        return "先在画布上点一个对象";
    }
}
