package Studio.app;

import Studio.ui.Btn;
import Studio.ui.Card;
import Studio.ui.EmptyState;
import Studio.ui.Ico;
import Studio.ui.Theme;
import Studio.ui.Toast;
import Studio.ui.UIKit;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JComponent;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;
import javax.swing.JPanel;
import javax.swing.JSplitPane;
import javax.swing.KeyStroke;
import javax.swing.SwingUtilities;
import javax.swing.WindowConstants;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.event.InputEvent;
import java.awt.event.KeyEvent;
import java.util.List;

/**
 * BWE Studio 主窗口。
 *
 * 界面结构（三栏 + 顶栏 + 状态栏），刻意保持窄而稳定：
 *   左栏：素材 / 模块 / 剧本 / 场景（标签页切换，不堆叠）
 *   中栏：画布（唯一的大面积区域）
 *   右栏：对象积木（选中对象后编辑它的模块）
 *   底栏：状态栏（鼠标坐标、缩放、选中数、提示语）
 *
 * 交互纪律：
 * - 所有反馈走 Toast 或状态栏，不弹模态框；
 * - 只有"会丢数据"的动作才允许弹确认框；
 * - 任何面板为空都给引导，不留白屏。
 */
public class MainWindow extends JFrame {

    private final AppState st;
    private final UndoStack undo = new UndoStack();

    private final JPanel leftHost = new JPanel(new BorderLayout());
    private final JPanel centerHost = new JPanel(new BorderLayout());
    private final JPanel rightHost = new JPanel(new BorderLayout());
    private final JLabel titleInfo = new JLabel();
    /**
     * 状态栏必须在这里手动创建，不能写成字段初始化。
     * 字段初始化早于构造体，那时 st 还是 null，状态栏刚构造就会刷新而崩掉。
     */
    private StatusBar statusBar;
    private CanvasPanel canvas;
    private InspectorPanel inspector;

    public MainWindow(AppState state) {
        super("BWE Studio");
        this.st = state;

        setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);
        setMinimumSize(new Dimension(860, 560));
        // 不写死尺寸：不同显示器的可用分辨率差别很大，窗口一旦超屏，右栏会彻底看不见
        int[] box = pickWindowSize();
        setSize(box[0], box[1]);
        setLocation(box[2], box[3]);

        // 顺序有讲究：状态栏要先于工具栏创建，工具栏的缩放按钮会用到画布
        statusBar = new StatusBar(st);
        canvas = new CanvasPanel(st);
        inspector = new InspectorPanel(st);

        JPanel root = new JPanel(new BorderLayout());
        root.setBackground(Theme.SHELL);
        root.add(buildToolbar(), BorderLayout.NORTH);

        leftHost.setBackground(Theme.SHELL);
        leftHost.setBorder(BorderFactory.createEmptyBorder(Theme.S2, Theme.S2, Theme.S2, 0));
        centerHost.setBackground(Theme.SHELL);
        centerHost.setBorder(BorderFactory.createEmptyBorder(Theme.S2, Theme.S2, Theme.S2, Theme.S2));
        rightHost.setBackground(Theme.SHELL);
        rightHost.setBorder(BorderFactory.createEmptyBorder(Theme.S2, 0, Theme.S2, Theme.S2));

        leftHost.add(buildLeftDock(), BorderLayout.CENTER);
        centerHost.add(canvas, BorderLayout.CENTER);
        rightHost.add(inspector.view(), BorderLayout.CENTER);

        // 三栏用 X 轴 BoxLayout：左固定宽度、中自适应、右固定宽度。
        // 不用 BorderLayout.EAST + JSplitPane 的原因：JSplitPane 的最小尺寸会把
        // CENTER 撑满，EAST 直接被挤出可视区（实测踩过，别改回去）。
        leftHost.setPreferredSize(new Dimension(300, 10));
        leftHost.setMinimumSize(new Dimension(220, 10));
        leftHost.setMaximumSize(new Dimension(300, Integer.MAX_VALUE));
        // 关键：中间栏必须给出"较小的首选宽度"。
        // BoxLayout 先按 preferred 分配，中间栏的 preferred 若很大，会把右栏挤到窗口之外
        // （实测：右栏 x 落在 1198 之后，而窗口只有 1420 宽，右边 100 多像素被裁掉）。
        centerHost.setPreferredSize(new Dimension(400, 10));
        centerHost.setMinimumSize(new Dimension(320, 10));
        centerHost.setMaximumSize(new Dimension(Integer.MAX_VALUE, Integer.MAX_VALUE));
        rightHost.setPreferredSize(new Dimension(348, 10));
        rightHost.setMinimumSize(new Dimension(300, 10));
        rightHost.setMaximumSize(new Dimension(348, Integer.MAX_VALUE));

        JPanel main = new JPanel();
        main.setOpaque(false);
        main.setLayout(new BoxLayout(main, BoxLayout.X_AXIS));
        main.add(leftHost);
        main.add(centerHost);
        main.add(rightHost);
        root.add(main, BorderLayout.CENTER);
        root.add(statusBar, BorderLayout.SOUTH);

        setJMenuBar(buildMenuBar());
        setContentPane(root);

        st.addDirtyListener(this::updateTitle);
        st.subscribe(statusBar::refresh);
        st.addSelectionListener(statusBar::refresh);
        updateTitle();
        installShortcuts();
        installCanvasDrop();

        addWindowListener(new java.awt.event.WindowAdapter() {
            @Override
            public void windowClosing(java.awt.event.WindowEvent e) {
                requestClose();
            }
        });

        // 布局自检：加 -Dbwe.debug.layout=true 启动时，首帧后把各栏实际尺寸打印出来。
        // 布局类问题靠猜成本极高，让它自己报数最快。
        if (Boolean.getBoolean("bwe.debug.layout")) {
            javax.swing.Timer t = new javax.swing.Timer(1500, e -> {
                System.out.println("[LAYOUT] window=" + getWidth() + "x" + getHeight()
                        + " | left x=" + leftHost.getX() + " w=" + leftHost.getWidth()
                        + " | center x=" + centerHost.getX() + " w=" + centerHost.getWidth()
                        + " | right x=" + rightHost.getX() + " w=" + rightHost.getWidth()
                        + " h=" + rightHost.getHeight()
                        + " | inspector w=" + inspector.view().getWidth()
                        + " | hostInMain=" + (rightHost.getParent() != null
                        ? rightHost.getParent().getClass().getSimpleName() : "无父容器")
                        + " | mainChildren=" + (rightHost.getParent() == null ? -1
                        : rightHost.getParent().getComponentCount())
                        + " | status w=" + statusBar.getWidth());
            });
            t.setRepeats(false);
            t.start();
        }
    }


    /**
     * 左侧栏：自绘导航 + 面板堆叠。
     * 不用 JTabbedPane —— Nimbus/Aqua 下它的固定行高会把中文字裁掉一半（实测踩过）。
     */
    private JComponent buildLeftDock() {
        Panel[] panels = {
                new AssetPanel(st), new ModulePanel(st), new ScenePanel(st), new ScriptPanel(st)
        };
        java.awt.CardLayout cards = new java.awt.CardLayout();
        JPanel cardHost = new JPanel(cards);
        cardHost.setOpaque(false);

        JPanel nav = new JPanel();
        nav.setOpaque(false);
        nav.setLayout(new BoxLayout(nav, BoxLayout.X_AXIS));
        nav.setBorder(BorderFactory.createEmptyBorder(0, 0, Theme.S2, 0));

        final Btn[] navBtns = new Btn[panels.length];
        for (int i = 0; i < panels.length; i++) {
            final Panel p = panels[i];
            final int idx = i;
            cardHost.add(p.view(), p.title());
            Btn b = new Btn(p.title(), i == 0 ? Btn.Variant.PRIMARY : Btn.Variant.GHOST);
            b.setFont(Theme.F_SMALL);
            b.setBorder(BorderFactory.createEmptyBorder(5, 9, 5, 9));
            b.setToolTipText(hintOfPanel(p.title()));
            navBtns[i] = b;
            b.addActionListener(e -> {
                cards.show(cardHost, p.title());
                for (int k = 0; k < navBtns.length; k++) {
                    navBtns[k].variant(k == idx ? Btn.Variant.PRIMARY : Btn.Variant.GHOST);
                    navBtns[k].repaint();
                }
                if ("模块".equals(p.title())) {
                    st.statusHint("模块：双击一块积木，就加到画布上选中的对象身上");
                } else if ("素材".equals(p.title())) {
                    st.statusHint("素材：把图拖到中间画布上，就会摆到地图里");
                }
            });
            if (i > 0) {
                nav.add(Box.createHorizontalStrut(4));
            }
            nav.add(b);
        }
        nav.add(UIKit.grow());

        JPanel dock = new JPanel(new BorderLayout());
        dock.setOpaque(false);
        dock.add(nav, BorderLayout.NORTH);
        dock.add(cardHost, BorderLayout.CENTER);
        return dock;
    }

    private static String hintOfPanel(String title) {
        return switch (title) {
            case "素材" -> "图片与音频，拖到画布上使用";
            case "模块" -> "可以加到对象身上的行为积木";
            case "场景" -> "地图列表与图层";
            case "剧本" -> "Yarn Spinner 剧情文本";
            default -> title;
        };
    }

    /** 让画布接收拖放：素材、模块、以及从资源管理器拖进来的文件。 */
    private void installCanvasDrop() {
        canvas.setTransferHandler(new javax.swing.TransferHandler() {
            @Override
            public boolean canImport(TransferSupport support) {
                if (!support.isDrop()) {
                    return false;
                }
                return support.isDataFlavorSupported(DragPayload.FLAVOR)
                        || support.isDataFlavorSupported(java.awt.datatransfer.DataFlavor.javaFileListFlavor);
            }

            @Override
            public boolean importData(TransferSupport support) {
                if (!canImport(support) || st.project() == null || st.scene() == null) {
                    return false;
                }
                java.awt.Point p = support.getDropLocation().getDropPoint();
                java.awt.geom.Point2D.Double world = canvas.screenToWorld(p);

                List<java.io.File> files = DragPayload.files(support.getTransferable());
                if (!files.isEmpty()) {
                    return importDroppedFiles(files, world);
                }

                DragPayload payload = DragPayload.of(support.getTransferable());
                if (payload == null) {
                    return false;
                }
                if (payload.what == DragPayload.What.ASSET) {
                    Studio.data.AssetEntry a = st.project().assets.get(payload.id);
                    if (a == null) {
                        return false;
                    }
                    Studio.data.SceneObject built = SceneOps.fromAsset(st, a, (float) world.x, (float) world.y);
                    st.edit(() -> {
                        st.scene().objects.add(built);
                        SceneOps.normalizeZ(st.scene());
                    });
                    st.select(built);
                    Toast.ok("放好了「" + built.name + "」　右侧可以给它加模块");
                    return true;
                }
                if (payload.what == DragPayload.What.MODULE) {
                    Studio.data.SceneObject hit = canvas.pick(world);
                    if (hit == null) {
                        Toast.info("把积木拖到某一个对象上才会生效");
                        return false;
                    }
                    Studio.data.ModuleDef def = Studio.modules.ModuleRegistry.get().def(payload.id);
                    if (def == null) {
                        return false;
                    }
                    Studio.data.ModuleInstance m = new Studio.data.ModuleInstance(def.id);
                    for (Studio.data.ParamDef d : def.params) {
                        if (d.type != Studio.data.ParamType.NOTE) {
                            m.values.put(d.key, d.def);
                        }
                    }
                    m.trigger = def.defaultTrigger();
                    m.collapsed = false;
                    st.edit(() -> hit.modules.add(m));
                    st.select(hit);
                    Toast.ok("给「" + hit.name + "」加上了「" + def.title + "」");
                    return true;
                }
                return false;
            }
        });
    }

    private boolean importDroppedFiles(List<java.io.File> files, java.awt.geom.Point2D.Double world) {
        List<java.io.File> dirs = new java.util.ArrayList<>();
        List<java.io.File> plain = new java.util.ArrayList<>();
        for (java.io.File f : files) {
            if (f.isDirectory()) {
                dirs.add(f);
            } else {
                plain.add(f);
            }
        }
        int added = 0;
        if (!plain.isEmpty()) {
            AssetImport.Result r = AssetImport.importFiles(st, plain.toArray(new java.io.File[0]));
            added += r.added;
        }
        for (java.io.File d : dirs) {
            AssetImport.Result r = AssetImport.importSequenceFolder(st, d);
            added += r.added;
        }
        if (added == 0) {
            Toast.info("拖进来的文件里没有能用的图片或音频");
            return false;
        }
        st.markDirty();
        // 用刚导入的第一条素材，直接在落点放一个对象 —— 拖进来就想看到东西
        Studio.data.AssetEntry last = null;
        for (Studio.data.AssetEntry e : st.project().assets.items) {
            last = e;
        }
        if (last != null) {
            final Studio.data.AssetEntry target = last;
            Studio.data.SceneObject built = SceneOps.fromAsset(st, target, (float) world.x, (float) world.y);
            st.edit(() -> {
                st.scene().objects.add(built);
                SceneOps.normalizeZ(st.scene());
            });
            st.select(built);
        }
        Toast.ok("导入 " + added + " 个素材，并把最后一个放到了地图上");
        return true;
    }

    // ---------------- 顶部工具栏 ----------------

    /**
     * 计算窗口尺寸与位置。
     *
     * 这里踩过一个坑：屏幕缩放不是 1:1 时（例如 150%），逻辑像素与物理像素不等，
     * 直接按 getScreenSize() 的数值设窗口，逻辑宽度会超过可视的逻辑宽度，
     * 结果右栏被推到屏幕外、用户永远看不到它。
     * 因此这里显式取设备缩放比并按物理空间反算逻辑尺寸，同时给可视线留出余量。
     */
    private static int[] pickWindowSize() {
        java.awt.Toolkit tk = java.awt.Toolkit.getDefaultToolkit();
        java.awt.Dimension screen = tk.getScreenSize();
        java.awt.Insets ins = tk.getScreenInsets(
                java.awt.GraphicsEnvironment.getLocalGraphicsEnvironment()
                        .getDefaultScreenDevice().getDefaultConfiguration());
        double sx = 1.0;
        double sy = 1.0;
        try {
            java.awt.geom.AffineTransform tr =
                    java.awt.GraphicsEnvironment.getLocalGraphicsEnvironment()
                            .getDefaultScreenDevice().getDefaultConfiguration()
                            .getDefaultTransform();
            sx = tr.getScaleX() <= 0 ? 1.0 : tr.getScaleX();
            sy = tr.getScaleY() <= 0 ? 1.0 : tr.getScaleY();
        } catch (Exception ignored) {
        }
        // 物理可用空间 → 逻辑可用空间
        double logicalW = (screen.width - ins.left - ins.right) / sx;
        double logicalH = (screen.height - ins.top - ins.bottom) / sy;
        // 四周各留一点余量，避免贴着屏幕边缘或压住任务栏
        int w = (int) Math.max(760, Math.min(1500, logicalW - 60));
        int h = (int) Math.max(560, Math.min(920, logicalH - 60));
        int x = ins.left + (int) Math.max(10, (logicalW - w) / 2);
        int y = ins.top + (int) Math.max(10, (logicalH - h) / 2);
        return new int[]{w, h, x, y};
    }

    private JComponent buildToolbar() {
        JPanel bar = new JPanel(new BorderLayout()) {
            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setColor(Theme.SURFACE);
                g2.fillRect(0, 0, getWidth(), getHeight());
                g2.setColor(Theme.LINE);
                g2.fillRect(0, getHeight() - 1, getWidth(), 1);
                g2.dispose();
            }
        };
        bar.setOpaque(false);
        bar.setBorder(BorderFactory.createEmptyBorder(6, Theme.S3, 6, Theme.S3));

        JPanel left = new JPanel();
        left.setOpaque(false);
        left.setLayout(new javax.swing.BoxLayout(left, javax.swing.BoxLayout.X_AXIS));

        // 工程名 + 未保存标记
        titleInfo.setFont(Theme.F_H2);
        titleInfo.setForeground(Theme.INK);
        titleInfo.setBorder(BorderFactory.createEmptyBorder(0, 2, 0, Theme.S4));
        left.add(titleInfo);
        left.add(divider());

        // 工具切换
        left.add(toolButton(AppState.Tool.SELECT, Ico.Kind.WAND));
        left.add(toolButton(AppState.Tool.BRUSH, Ico.Kind.ASSET));
        left.add(toolButton(AppState.Tool.ERASE, Ico.Kind.TRASH));
        left.add(toolButton(AppState.Tool.ZONE, Ico.Kind.MODULE));
        left.add(toolButton(AppState.Tool.PAN, Ico.Kind.LAYER));
        left.add(divider());

        left.add(toggleBar("网格", st.showGrid, v -> {
            st.showGrid = v;
            statusBar.refresh();
        }));
        left.add(javax.swing.Box.createHorizontalStrut(6));
        left.add(toggleBar("吸附", st.snapToGrid, v -> st.snapToGrid = v));
        left.add(javax.swing.Box.createHorizontalStrut(6));
        left.add(toggleBar("碰撞框", st.showColliders, v -> statusBar.refresh()));
        left.add(UIKit.grow());

        JPanel right = new JPanel();
        right.setOpaque(false);
        right.setLayout(new javax.swing.BoxLayout(right, javax.swing.BoxLayout.X_AXIS));
        right.add(zoomBar());
        right.add(divider());

        Btn play = Btn.primary("试玩").icon(Ico.Kind.PLAY);
        play.setToolTipText("用当前工程的地图启动游戏窗口");
        play.addActionListener(e -> Studio.app.Actions.play(this));
        right.add(play);
        right.add(javax.swing.Box.createHorizontalStrut(6));
        Btn export = Btn.normal("导出").icon(Ico.Kind.EXPORT);
        export.setToolTipText("导出成游戏能读的关卡 JSON");
        export.addActionListener(e -> Studio.app.Actions.exportLevel(this, st));
        right.add(export);

        bar.add(left, BorderLayout.CENTER);
        bar.add(right, BorderLayout.EAST);
        return bar;
    }

    private JComponent divider() {
        JPanel d = new JPanel();
        d.setOpaque(false);
        d.setPreferredSize(new Dimension(13, 26));
        d.setMaximumSize(new Dimension(13, 26));
        d.add(new JLabel() {
            @Override
            protected void paintComponent(Graphics g) {
                g.setColor(Theme.LINE);
                g.fillRect(6, 4, 1, getHeight() - 8);
            }
        });
        return d;
    }

    private JComponent toolButton(AppState.Tool t, Ico.Kind icon) {
        javax.swing.JButton b = Btn.iconOnly(icon, t.cn + "｜" + t.hint);
        b.addActionListener(e -> {
            st.setTool(t);
            statusBar.hint(t.cn + "：可以" + t.hint);
        });
        return b;
    }

    private JComponent zoomBar() {
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new javax.swing.BoxLayout(p, javax.swing.BoxLayout.X_AXIS));
        JLabel z = new JLabel();
        z.setFont(Theme.F_SMALL);
        z.setForeground(Theme.INK_SUB);
        z.setPreferredSize(new Dimension(46, 26));
        z.setHorizontalAlignment(JLabel.CENTER);
        Runnable sync = () -> z.setText(Math.round(st.zoom * 100) + "%");
        sync.run();
        javax.swing.JButton minus = (javax.swing.JButton) Btn.iconOnly(Ico.Kind.ZOOM_OUT, "缩小");
        javax.swing.JButton plus = (javax.swing.JButton) Btn.iconOnly(Ico.Kind.ZOOM_IN, "放大");
        javax.swing.JButton fit = (javax.swing.JButton) Btn.iconOnly(Ico.Kind.FIT, "适应窗口");
        minus.addActionListener(e -> {
            st.zoom = Math.max(0.2, st.zoom / 1.2);
            sync.run();
            statusBar.refresh();
        });
        plus.addActionListener(e -> {
            st.zoom = Math.min(4, st.zoom * 1.2);
            sync.run();
            statusBar.refresh();
        });
        fit.addActionListener(e -> {
            canvas.zoomToFit();
            sync.run();
        });
        p.add(minus);
        p.add(z);
        p.add(plus);
        p.add(fit);
        return p;
    }

    private JComponent toggleBar(String name, boolean init, java.util.function.Consumer<Boolean> onChange) {
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new javax.swing.BoxLayout(p, javax.swing.BoxLayout.X_AXIS));
        p.add(new Studio.ui.Toggle(init, onChange));
        JLabel l = new JLabel(name);
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.INK_SUB);
        l.setBorder(BorderFactory.createEmptyBorder(0, 6, 0, 0));
        p.add(l);
        return p;
    }

    // ---------------- 菜单 ----------------

    private JMenuBar buildMenuBar() {
        JMenuBar mb = new JMenuBar();
        mb.setBackground(Theme.SURFACE);
        mb.setBorder(BorderFactory.createMatteBorder(0, 0, 1, 0, Theme.LINE));

        JMenu file = menu("文件");
        file.add(item("新建工程…", KeyEvent.VK_N, () -> Actions.newProject(this, st)));
        file.add(item("打开工程…", KeyEvent.VK_O, () -> Actions.openProject(this, st)));
        file.addSeparator();
        file.add(item("保存", KeyEvent.VK_S, () -> Actions.save(st)));
        file.add(item("另存为…", 0, () -> Actions.saveAs(this, st)));
        file.addSeparator();
        file.add(item("导入素材…", 0, () -> Actions.importAssets(this, st)));
        file.add(item("导入序列帧…", 0, () -> Actions.importSequence(this, st)));
        file.add(item("导出关卡 JSON…", 0, () -> Actions.exportLevel(this, st)));
        file.addSeparator();
        file.add(item("退出", 0, this::requestClose));
        mb.add(file);

        JMenu edit = menu("编辑");
        edit.add(item("撤销", KeyEvent.VK_Z, () -> {
            undo.undo();
            statusBar.hint("已撤销");
        }));
        edit.add(item("重做", KeyEvent.VK_Y, () -> {
            undo.redo();
            statusBar.hint("已重做");
        }));
        edit.addSeparator();
        edit.add(item("复制对象", KeyEvent.VK_C, () -> Actions.copy(st)));
        edit.add(item("粘贴对象", KeyEvent.VK_V, () -> Actions.paste(st)));
        edit.add(item("删除对象", KeyEvent.VK_DELETE, () -> Actions.deleteSelection(st)));
        edit.addSeparator();
        edit.add(item("全选", KeyEvent.VK_A, () -> Actions.selectAll(st)));
        edit.add(item("取消选择", KeyEvent.VK_ESCAPE, st::clearSelection));
        mb.add(edit);

        JMenu view = menu("视图");
        view.add(item("放大", 0, () -> st.zoom = Math.min(4, st.zoom * 1.2)));
        view.add(item("缩小", 0, () -> st.zoom = Math.max(0.2, st.zoom / 1.2)));
        view.add(item("回到原位", 0, () -> {
            st.zoom = 1;
            st.camX = 0;
            st.camY = 0;
        }));
        mb.add(view);

        JMenu modules = menu("模块");
        modules.add(item("模块目录", 0, () -> Toast.info("左侧「模块」标签页里列出了全部积木")));
        modules.add(item("保存为规则包…", 0, () -> Actions.saveAsPack(this, st)));
        mb.add(modules);

        JMenu script = menu("剧本");
        script.add(item("新建剧本", 0, () -> Actions.newScript(st)));
        script.add(item("剧本编辑器", 0, () -> Toast.info("左侧「剧本」标签页")));
        mb.add(script);

        JMenu account = menu("账号");
        account.add(item("登录…", 0, () -> Actions.login(this, st)));
        account.add(item("订阅计划", 0, () -> Actions.showPlans(this, st)));
        account.add(item("退出登录", 0, () -> Actions.logout(st)));
        mb.add(account);

        JMenu help = menu("帮助");
        help.add(item("快速上手", 0, () -> Actions.quickStart(this)));
        help.add(item("模块速查", 0, () -> Actions.moduleCheatSheet(this)));
        help.addSeparator();
        help.add(item("关于 BWE Studio", 0, () -> Actions.about(this)));
        mb.add(help);

        return mb;
    }

    private JMenu menu(String name) {
        JMenu m = new JMenu(name);
        m.setFont(Theme.F_BODY);
        return m;
    }

    private JMenuItem item(String name, int key, Runnable action) {
        JMenuItem mi = new JMenuItem(name);
        mi.setFont(Theme.F_BODY);
        if (key != 0) {
            mi.setAccelerator(KeyStroke.getKeyStroke(key, InputEvent.CTRL_DOWN_MASK));
        }
        mi.addActionListener(e -> {
            try {
                action.run();
            } catch (RuntimeException ex) {
                Toast.error("操作失败：" + ex.getMessage());
            }
        });
        return mi;
    }

    private void installShortcuts() {
        JPanel root = (JPanel) getContentPane();
        bind(root, "V", () -> st.setTool(AppState.Tool.SELECT));
        bind(root, "B", () -> st.setTool(AppState.Tool.BRUSH));
        bind(root, "E", () -> st.setTool(AppState.Tool.ERASE));
        bind(root, "Z", () -> st.setTool(AppState.Tool.ZONE));
        bind(root, "H", () -> st.setTool(AppState.Tool.PAN));
        bind(root, "F1", () -> Actions.quickStart(this));
    }

    /** 把单键快捷键绑到根面板（编辑器里单键切工具是肌肉记忆，不能省）。 */
    private void bind(JComponent c, String key, Runnable r) {
        c.getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke(key), "k" + key);
        c.getActionMap().put("k" + key, new javax.swing.AbstractAction() {
            @Override
            public void actionPerformed(java.awt.event.ActionEvent e) {
                r.run();
            }
        });
    }

    // ---------------- 关闭与标题 ----------------

    public void requestClose() {
        if (!st.isDirty()) {
            dispose();
            System.exit(0);
            return;
        }
        int r = Studio.ui.Dialogs.unsavedChanges(this, st.project() == null ? "未命名工程" : st.project().name);
        if (r == Studio.ui.Dialogs.SAVE) {
            if (Actions.save(st)) {
                dispose();
                System.exit(0);
            }
        } else if (r == Studio.ui.Dialogs.DISCARD) {
            dispose();
            System.exit(0);
        }
    }

    private void updateTitle() {
        setTitle(st.title());
        titleInfo.setText(st.project() == null ? "未命名工程" : st.project().name);
        titleInfo.setForeground(st.isDirty() ? Theme.INK : Theme.INK_SUB);
    }

    /** 占位内容：功能未接上时也要给出"这里是什么 + 怎么开始"。 */
    static JComponent placeholder(String title, Ico.Kind icon, String text, JComponent action) {
        Card card = new Card(title);
        card.content().add(new EmptyState(icon, title, text, action), BorderLayout.CENTER);
        return card;
    }

    public UndoStack undoStack() {
        return undo;
    }

    public StatusBar status() {
        return statusBar;
    }

    /** 供启动器与运行时取状态（避免把 AppState 做成全局单例）。 */
    public AppState stPublic() {
        return st;
    }
}
