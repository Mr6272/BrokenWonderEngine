package Studio.app;

import Studio.data.Layer;
import Studio.data.SceneModel;
import Studio.ui.Btn;
import Studio.ui.Card;
import Studio.ui.Field;
import Studio.ui.Ico;
import Studio.ui.Theme;
import Studio.ui.Toast;
import Studio.ui.UIKit;

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
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.UUID;

/**
 * 场景与图层面板。
 *
 * 俯视角 RPG 的典型结构：一张地图一个场景，场景之间用传送口连。
 * 因此这里刻意做成"场景列表 + 图层开关"两段，不引入嵌套文件夹这类复杂结构。
 */
public final class ScenePanel extends Panel {

    private final JPanel root = new JPanel(new BorderLayout());
    private final DefaultListModel<SceneModel> sceneModel = new DefaultListModel<>();
    private final DefaultListModel<Layer> layerModel = new DefaultListModel<>();
    private final JList<SceneModel> sceneList = new JList<>(sceneModel);
    private final JList<Layer> layerList = new JList<>(layerModel);
    private final JPanel settings = new JPanel();

    public ScenePanel(AppState st) {
        super(st);
        build();
        st.addSceneListener(this::refresh);
        st.subscribe(() -> SwingUtilities.invokeLater(this::refresh));
        refresh();
    }

    @Override
    public String title() {
        return "场景";
    }

    @Override
    public Ico.Kind icon() {
        return Ico.Kind.LAYER;
    }

    @Override
    public JComponent view() {
        return root;
    }

    private void build() {
        root.setOpaque(false);

        sceneList.setCellRenderer(new SceneRenderer());
        sceneList.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        sceneList.setBackground(Theme.SURFACE);
        sceneList.setFixedCellHeight(46);
        sceneList.setBorder(BorderFactory.createEmptyBorder(4, 4, 4, 4));
        sceneList.addListSelectionListener(e -> {
            if (e.getValueIsAdjusting()) {
                return;
            }
            SceneModel s = sceneList.getSelectedValue();
            if (s != null && s != st.scene()) {
                st.setScene(s);
                st.statusHint("已切到「" + s.name + "」");
            }
        });

        layerList.setCellRenderer(new LayerRenderer());
        layerList.setBackground(Theme.SURFACE);
        layerList.setFixedCellHeight(30);
        layerList.setBorder(BorderFactory.createEmptyBorder(2, 4, 2, 4));
        layerList.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                int i = layerList.locationToIndex(e.getPoint());
                if (i < 0) {
                    return;
                }
                Layer l = layerModel.get(i);
                java.awt.Rectangle r = layerList.getCellBounds(i, i);
                if (r == null) {
                    return;
                }
                // 左侧 24 像素内点击 = 切可见性
                if (e.getX() - r.x < 24) {
                    st.edit(() -> l.visible = !l.visible);
                    st.statusHint((l.visible ? "显示" : "隐藏") + "图层「" + l.name + "」");
                    refresh();
                } else if (e.getX() - r.x > r.width - 42) {
                    st.edit(() -> l.locked = !l.locked);
                    st.statusHint(l.locked ? "已锁定图层「" + l.name + "」" : "已解锁图层「" + l.name + "」");
                    refresh();
                }
            }
        });

        JPanel scenes = new JPanel(new BorderLayout());
        scenes.setOpaque(false);
        JPanel sceneBar = new JPanel();
        sceneBar.setOpaque(false);
        sceneBar.setLayout(new BoxLayout(sceneBar, BoxLayout.X_AXIS));
        sceneBar.setBorder(BorderFactory.createEmptyBorder(0, 0, Theme.S2, 0));
        Btn add = Btn.primary("+ 新场景").small();
        add.addActionListener(e -> newScene());
        Btn dup = Btn.ghost("复制").small();
        dup.setToolTipText("复制当前场景（含全部对象）");
        dup.addActionListener(e -> duplicateScene());
        Btn del = Btn.ghost("删除").small();
        del.addActionListener(e -> deleteScene());
        sceneBar.add(add);
        sceneBar.add(Box.createHorizontalStrut(4));
        sceneBar.add(dup);
        sceneBar.add(Box.createHorizontalStrut(4));
        sceneBar.add(del);
        sceneBar.add(UIKit.grow());
        scenes.add(sceneBar, BorderLayout.NORTH);
        scenes.add(UIKit.scroll(sceneList), BorderLayout.CENTER);

        JPanel layers = new JPanel(new BorderLayout());
        layers.setOpaque(false);
        JLabel lt = new JLabel("图层");
        lt.setFont(Theme.F_SMALL.deriveFont(java.awt.Font.BOLD));
        lt.setForeground(Theme.INK_SUB);
        lt.setBorder(BorderFactory.createEmptyBorder(Theme.S3, 2, 4, 0));
        JPanel layerBar = new JPanel();
        layerBar.setOpaque(false);
        layerBar.setLayout(new BoxLayout(layerBar, BoxLayout.X_AXIS));
        Btn addLayer = Btn.ghost("+ 图层").small();
        addLayer.addActionListener(e -> addLayer());
        Btn delLayer = Btn.ghost("删图层").small();
        delLayer.addActionListener(e -> removeLayer());
        layerBar.add(addLayer);
        layerBar.add(Box.createHorizontalStrut(4));
        layerBar.add(delLayer);
        layerBar.add(UIKit.grow());
        layers.add(lt, BorderLayout.NORTH);
        JPanel layerWrap = new JPanel(new BorderLayout());
        layerWrap.setOpaque(false);
        layerWrap.add(layerBar, BorderLayout.NORTH);
        layerWrap.add(UIKit.scroll(layerList), BorderLayout.CENTER);
        layers.add(layerWrap, BorderLayout.CENTER);

        settings.setOpaque(false);
        settings.setLayout(new BoxLayout(settings, BoxLayout.Y_AXIS));

        JPanel center = new JPanel();
        center.setOpaque(false);
        center.setLayout(new BoxLayout(center, BoxLayout.Y_AXIS));
        center.add(scenes);
        center.add(layers);
        center.add(Box.createVerticalStrut(Theme.S2));
        center.add(settings);

        root.add(UIKit.scroll(center), BorderLayout.CENTER);
    }

    @Override
    public void refresh() {
        SceneModel cur = st.scene();
        sceneModel.clear();
        if (st.project() != null) {
            for (SceneModel s : st.project().scenes) {
                sceneModel.addElement(s);
            }
            if (cur != null) {
                sceneList.setSelectedValue(cur, true);
            }
        }
        layerModel.clear();
        if (cur != null) {
            for (Layer l : cur.layers) {
                layerModel.addElement(l);
            }
        }
        rebuildSettings();
    }

    /** 场景基本设置：尺寸、名字。改尺寸不动已有对象（只改边界）。 */
    private void rebuildSettings() {
        settings.removeAll();
        SceneModel s = st.scene();
        if (s == null) {
            settings.revalidate();
            settings.repaint();
            return;
        }
        Card c = new Card("这张地图");
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new BoxLayout(p, BoxLayout.Y_AXIS));

        Field name = new Field(s.name, "地图名字");
        name.setMaximumSize(new Dimension(Integer.MAX_VALUE, 28));
        name.setToolTipText("这个名字会出现在「换到另一张地图」模块的下拉列表里");
        name.addFocusListener(new java.awt.event.FocusAdapter() {
            @Override
            public void focusLost(java.awt.event.FocusEvent e) {
                String v = name.getText().trim();
                if (!v.isEmpty() && !v.equals(s.name)) {
                    st.edit(() -> s.name = v);
                    st.statusHint("地图改名为「" + v + "」");
                }
            }
        });
        p.add(label("地图名字"));
        p.add(name);
        p.add(Box.createVerticalStrut(Theme.S2));

        p.add(label("尺寸（格）"));
        p.add(pairInt("宽", s.widthTiles, v -> {
            st.edit(() -> s.widthTiles = Math.max(4, v));
            st.statusHint("地图宽度改为 " + v + " 格");
        }));
        p.add(pairInt("高", s.heightTiles, v -> {
            st.edit(() -> s.heightTiles = Math.max(4, v));
            st.statusHint("地图高度改为 " + v + " 格");
        }));

        JLabel tip = new JLabel("<html><div style='width:250px'>当前 "
                + (s.widthTiles * st.project().tileSize) + " × " + (s.heightTiles * st.project().tileSize)
                + " 像素，格大小 " + st.project().tileSize + " 像素（在顶部工具栏里改工程设置）。</div></html>");
        tip.setFont(Theme.F_SMALL.deriveFont(10.5f));
        tip.setForeground(Theme.INK_MUTE);
        tip.setAlignmentX(Component.LEFT_ALIGNMENT);
        tip.setBorder(BorderFactory.createEmptyBorder(Theme.S2, 0, 0, 0));
        p.add(tip);

        c.content().add(p, BorderLayout.CENTER);
        c.setAlignmentX(Component.LEFT_ALIGNMENT);
        c.setMaximumSize(new Dimension(Integer.MAX_VALUE, Integer.MAX_VALUE));
        settings.add(c);
        settings.add(Box.createVerticalStrut(Theme.S2));
        settings.revalidate();
        settings.repaint();
    }

    private JComponent label(String t) {
        JLabel l = new JLabel(t);
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.INK_SUB);
        l.setAlignmentX(Component.LEFT_ALIGNMENT);
        l.setBorder(BorderFactory.createEmptyBorder(0, 0, 3, 0));
        return l;
    }

    private JComponent pairInt(String label, int value, java.util.function.IntConsumer onChange) {
        JPanel row = new JPanel();
        row.setOpaque(false);
        row.setLayout(new BoxLayout(row, BoxLayout.X_AXIS));
        row.setAlignmentX(Component.LEFT_ALIGNMENT);
        row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));
        JLabel l = new JLabel(label);
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.INK_SUB);
        l.setPreferredSize(new Dimension(30, 22));
        Field f = new Field(String.valueOf(value), "");
        f.numeric(value, 4, 2000);
        f.setPreferredSize(new Dimension(64, 28));
        f.setMaximumSize(new Dimension(64, 28));
        Runnable commit = () -> onChange.accept(f.intValue(value));
        f.addActionListener(e -> commit.run());
        f.addFocusListener(new java.awt.event.FocusAdapter() {
            @Override
            public void focusLost(java.awt.event.FocusEvent e) {
                commit.run();
            }
        });
        row.add(l);
        row.add(f);
        row.add(Box.createHorizontalStrut(6));
        JLabel unit = new JLabel("格");
        unit.setFont(Theme.F_SMALL.deriveFont(10f));
        unit.setForeground(Theme.INK_MUTE);
        row.add(unit);
        row.add(Box.createHorizontalGlue());
        row.setBorder(BorderFactory.createEmptyBorder(0, 0, 4, 0));
        return row;
    }

    // ---------------- 操作 ----------------

    private void newScene() {
        if (st.project() == null) {
            return;
        }
        SceneModel s = new SceneModel();
        s.name = "场景 " + (st.project().scenes.size() + 1);
        s.widthTiles = st.project().gridW;
        s.heightTiles = st.project().gridH;
        s.layers.add(new Layer("地形"));
        s.layers.add(new Layer("物件"));
        s.layers.add(new Layer("角色"));
        st.project().scenes.add(s);
        st.markDirty();
        st.setScene(s);
        Toast.ok("建好了「" + s.name + "」");
        refresh();
    }

    private void duplicateScene() {
        SceneModel src = st.scene();
        if (src == null) {
            return;
        }
        SceneModel s = new SceneModel();
        s.name = src.name + " 副本";
        s.widthTiles = src.widthTiles;
        s.heightTiles = src.heightTiles;
        s.tint = src.tint;
        for (Layer l : src.layers) {
            Layer nl = new Layer(l.name);
            nl.visible = l.visible;
            nl.locked = l.locked;
            s.layers.add(nl);
        }
        for (Studio.data.SceneObject o : src.objects) {
            s.objects.add(SceneOps.duplicate(o));
        }
        st.project().scenes.add(s);
        st.markDirty();
        st.setScene(s);
        Toast.ok("复制出「" + s.name + "」");
        refresh();
    }

    private void deleteScene() {
        SceneModel s = st.scene();
        if (s == null || st.project() == null) {
            return;
        }
        if (st.project().scenes.size() <= 1) {
            Toast.warn("至少留一张地图，不能全删光");
            return;
        }
        if (!Studio.ui.Dialogs.confirm(SwingUtilities.getWindowAncestor(root),
                "删掉「" + s.name + "」？",
                "这张地图上的 " + s.objects.size() + " 个对象会一起删掉。删除后不能撤销。",
                "删除", true)) {
            return;
        }
        st.project().scenes.remove(s);
        st.markDirty();
        st.setScene(st.project().scenes.get(0));
        Toast.ok("已删除「" + s.name + "」");
        refresh();
    }

    private void addLayer() {
        SceneModel s = st.scene();
        if (s == null) {
            return;
        }
        Layer l = new Layer("图层 " + (s.layers.size() + 1));
        st.edit(() -> s.layers.add(l));
        refresh();
        st.statusHint("加了图层「" + l.name + "」");
    }

    private void removeLayer() {
        SceneModel s = st.scene();
        Layer l = layerList.getSelectedValue();
        if (s == null || l == null) {
            Toast.info("先在列表里选一个图层");
            return;
        }
        if (s.layers.size() <= 1) {
            Toast.warn("至少留一个图层");
            return;
        }
        int used = 0;
        for (Studio.data.SceneObject o : s.objects) {
            if (l.id.equals(o.layerId)) {
                used++;
            }
        }
        String detail = used == 0 ? "这个图层上没有对象，可以放心删。"
                : "这个图层上还有 " + used + " 个对象，删掉图层后它们会被移到最后一个图层里。";
        if (!Studio.ui.Dialogs.confirm(SwingUtilities.getWindowAncestor(root),
                "删掉图层「" + l.name + "」？", detail, "删除", true)) {
            return;
        }
        Layer fallback = s.layers.get(s.layers.size() - 1);
        st.edit(() -> {
            s.layers.remove(l);
            for (Studio.data.SceneObject o : s.objects) {
                if (l.id.equals(o.layerId)) {
                    o.layerId = fallback.id;
                }
            }
        });
        refresh();
    }

    /** 场景列表项：名字 + 对象数 + 尺寸。 */
    private static final class SceneRenderer implements ListCellRenderer<SceneModel> {
        @Override
        public Component getListCellRendererComponent(JList<? extends SceneModel> l, SceneModel s, int i,
                                                      boolean sel, boolean focus) {
            JPanel card = new JPanel(new BorderLayout()) {
                @Override
                protected void paintComponent(Graphics g) {
                    Graphics2D g2 = (Graphics2D) g.create();
                    g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                    g2.setColor(sel ? Theme.ACCENT_SOFT : Theme.SURFACE);
                    g2.fillRoundRect(0, 0, getWidth() - 1, getHeight() - 1, Theme.R_MD, Theme.R_MD);
                    g2.setColor(sel ? Theme.ACCENT : Theme.LINE_SOFT);
                    g2.drawRoundRect(0, 0, getWidth() - 1, getHeight() - 1, Theme.R_MD, Theme.R_MD);
                    g2.dispose();
                    super.paintComponent(g);
                }
            };
            card.setOpaque(false);
            card.setBorder(BorderFactory.createEmptyBorder(6, 10, 6, 8));
            JLabel name = new JLabel(s.name);
            name.setFont(Theme.F_BODY.deriveFont(java.awt.Font.BOLD));
            name.setForeground(Theme.INK);
            JLabel sub = new JLabel(s.objects.size() + " 个对象　·　" + s.widthTiles + "×" + s.heightTiles + " 格");
            sub.setFont(Theme.F_SMALL.deriveFont(10.5f));
            sub.setForeground(Theme.INK_MUTE);
            JPanel t = new JPanel();
            t.setOpaque(false);
            t.setLayout(new BoxLayout(t, BoxLayout.Y_AXIS));
            t.add(name);
            t.add(sub);
            card.add(t, BorderLayout.CENTER);
            return card;
        }
    }

    /** 图层项：眼睛（可见性）与锁（锁定），直接点图标切换。 */
    private static final class LayerRenderer implements ListCellRenderer<Layer> {
        @Override
        public Component getListCellRendererComponent(JList<? extends Layer> l, Layer layer, int i,
                                                      boolean sel, boolean focus) {
            JPanel row = new JPanel(new BorderLayout()) {
                @Override
                protected void paintComponent(Graphics g) {
                    Graphics2D g2 = (Graphics2D) g.create();
                    g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                    if (sel) {
                        g2.setColor(Theme.ACCENT_SOFT);
                        g2.fillRoundRect(0, 0, getWidth() - 1, getHeight() - 1, Theme.R_SM, Theme.R_SM);
                    }
                    g2.dispose();
                    super.paintComponent(g);
                }
            };
            row.setOpaque(false);
            row.setBorder(BorderFactory.createEmptyBorder(3, 4, 3, 4));

            JLabel eye = new JLabel(Ico.of(Ico.Kind.EYE, 14, layer.visible ? Theme.INK_SUB : Theme.LINE));
            eye.setToolTipText(layer.visible ? "点一下隐藏这个图层" : "点一下显示这个图层");
            eye.setPreferredSize(new Dimension(22, 20));
            JLabel lock = new JLabel(Ico.of(Ico.Kind.LOCK, 14, layer.locked ? Theme.WARN : Theme.LINE));
            lock.setToolTipText(layer.locked ? "已锁定，点一下解锁" : "点一下锁定，防止误改");
            lock.setPreferredSize(new Dimension(24, 20));

            JLabel name = new JLabel(layer.name);
            name.setFont(Theme.F_SMALL);
            name.setForeground(layer.visible ? Theme.INK : Theme.INK_MUTE);

            JPanel left = new JPanel();
            left.setOpaque(false);
            left.setLayout(new BoxLayout(left, BoxLayout.X_AXIS));
            left.add(eye);
            left.add(Box.createHorizontalStrut(4));
            left.add(name);
            row.add(left, BorderLayout.WEST);
            row.add(lock, BorderLayout.EAST);
            return row;
        }
    }

    /** 供外部在切场景后定位（当前未用，保留给未来的场景缩略图导航）。 */
    public void selectById(String id) {
        if (st.project() == null) {
            return;
        }
        SceneModel s = st.project().scene(id);
        if (s != null) {
            st.setScene(s);
        }
    }

    private static String newId() {
        return UUID.randomUUID().toString();
    }
}
