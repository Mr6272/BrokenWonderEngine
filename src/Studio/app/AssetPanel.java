package Studio.app;

import Studio.data.AssetEntry;
import Studio.data.AssetKind;
import Studio.render.ImageCache;
import Studio.ui.Btn;
import Studio.ui.Card;
import Studio.ui.EmptyState;
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
import javax.swing.TransferHandler;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.RenderingHints;
import java.awt.datatransfer.Transferable;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * 素材库面板。
 *
 * 导入两种方式对应两种入口：
 *   「导入图片」—— 一次选多张，一张一条；
 *   「导入序列帧」—— 选一个文件夹，按名字前缀自动分组。
 * 两种都支持直接把文件从资源管理器拖进来，不强迫用户先点按钮。
 */
public final class AssetPanel extends Panel {

    private final DefaultListModel<AssetEntry> model = new DefaultListModel<>();
    private final JList<AssetEntry> list = new JList<>(model);
    private final JPanel root = new JPanel(new BorderLayout());
    private final JPanel hintBar = new JPanel(new BorderLayout());
    private final Field search = new Field("", "搜素材名");
    private String group = "全部";

    public AssetPanel(AppState st) {
        super(st);
        build();
        st.subscribe(() -> SwingUtilities.invokeLater(this::refill));
        refill();
    }

    @Override
    public String title() {
        return "素材";
    }

    @Override
    public Ico.Kind icon() {
        return Ico.Kind.ASSET;
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

        JPanel bar = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 0));
        bar.setOpaque(false);
        Btn many = Btn.primary("导入图片").icon(Ico.Kind.IMAGE);
        many.setFont(Theme.F_SMALL);
        many.setBorder(BorderFactory.createEmptyBorder(5, 10, 5, 10));
        many.setToolTipText("一次可以选多张，每张算一条素材");
        many.addActionListener(e -> Actions.importAssets(SwingUtilities.getWindowAncestor(this.root), st));

        Btn seq = Btn.normal("导入序列帧").icon(Ico.Kind.MUSIC);
        seq.setFont(Theme.F_SMALL);
        seq.setBorder(BorderFactory.createEmptyBorder(5, 10, 5, 10));
        seq.setToolTipText("选一个文件夹：待机1.png、待机2.png … 会自动变成会动的素材");
        seq.addActionListener(e -> Actions.importSequence(SwingUtilities.getWindowAncestor(this.root), st));

        bar.add(many);
        bar.add(seq);

        JPanel bar2 = new JPanel(new BorderLayout(6, 0));
        bar2.setOpaque(false);
        bar2.setBorder(BorderFactory.createEmptyBorder(Theme.S2, 0, 0, 0));
        search.setPreferredSize(new Dimension(120, 28));
        search.addCaretListener(e -> refill());
        bar2.add(search, BorderLayout.CENTER);

        top.add(bar);
        top.add(bar2);

        list.setCellRenderer(new CardRenderer());
        list.setLayoutOrientation(JList.VERTICAL_WRAP);
        list.setVisibleRowCount(-1);
        list.setFixedCellWidth(96);
        list.setFixedCellHeight(112);
        list.setSelectionMode(ListSelectionModel.MULTIPLE_INTERVAL_SELECTION);
        list.setBackground(Theme.SURFACE);
        list.setBorder(BorderFactory.createEmptyBorder(6, 6, 6, 6));
        list.setDragEnabled(true);
        list.setTransferHandler(new TransferHandler() {
            @Override
            protected Transferable createTransferable(JComponent c) {
                AssetEntry e = list.getSelectedValue();
                return e == null ? null : new DragPayload(DragPayload.What.ASSET, e.id, e.name);
            }

            @Override
            public int getSourceActions(JComponent c) {
                return COPY;
            }
        });
        list.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                if (e.getClickCount() == 2 && list.getSelectedValue() != null) {
                    AssetEntry a = list.getSelectedValue();
                    st.statusHint("素材「" + a.name + "」：" + a.kind.cn + "　" + hintOf(a));
                }
            }
        });

        hintBar.setOpaque(false);
        hintBar.setBorder(BorderFactory.createEmptyBorder(0, 2, 0, 0));

        root.add(top, BorderLayout.NORTH);
        root.add(UIKit.scroll(list), BorderLayout.CENTER);
        root.add(hintBar, BorderLayout.SOUTH);
        installDrop();
    }

    /** 支持从资源管理器直接拖文件进入素材面板。 */
    private void installDrop() {
        root.setTransferHandler(new TransferHandler() {
            @Override
            public boolean canImport(TransferSupport support) {
                return support.isDrop()
                        && (support.isDataFlavorSupported(java.awt.datatransfer.DataFlavor.javaFileListFlavor)
                        || support.isDataFlavorSupported(DragPayload.FLAVOR));
            }

            @Override
            public boolean importData(TransferSupport support) {
                if (!canImport(support)) {
                    return false;
                }
                List<File> files = DragPayload.files(support.getTransferable());
                if (!files.isEmpty()) {
                    List<File> dirs = new ArrayList<>();
                    List<File> plain = new ArrayList<>();
                    for (File f : files) {
                        if (f.isDirectory()) {
                            dirs.add(f);
                        } else {
                            plain.add(f);
                        }
                    }
                    if (!plain.isEmpty()) {
                        AssetImport.Result r = AssetImport.importFiles(st, plain.toArray(new File[0]));
                        report(r);
                    }
                    for (File d : dirs) {
                        report(AssetImport.importSequenceFolder(st, d));
                    }
                    refill();
                    return true;
                }
                return false;
            }
        });
    }

    private void report(AssetImport.Result r) {
        if (r.added > 0) {
            st.markDirty();
            Toast.ok("导入 " + r.added + " 个素材" + (r.skipped > 0 ? "（跳过重复 " + r.skipped + "）" : ""));
        } else if (r.skipped > 0) {
            Toast.info("这些素材已经在库里了");
        } else if (r.message != null && !r.message.isEmpty()) {
            Toast.warn(r.message);
        }
    }

    private static String hintOf(AssetEntry a) {
        return switch (a.kind) {
            case SEQUENCE -> a.frameCount + " 帧　·　" + a.headName + "1.." + a.headName + a.frameCount;
            case ATLAS -> a.cols + " 列 × " + a.rows + " 行";
            case AUDIO -> "音频文件";
            default -> a.width + " × " + a.height;
        };
    }

    private void refill() {
        String q = search.getText() == null ? "" : search.getText().trim().toLowerCase();
        model.clear();
        if (st.project() == null) {
            showHint("还没有打开工程", "先「文件 → 新建工程」，然后就能把图片导进来了");
            return;
        }
        int n = 0;
        for (AssetEntry e : st.project().assets.items) {
            if (!group.equals("全部")) {
                String g = e.group == null || e.group.isEmpty() ? "未分组" : e.group;
                if (!g.equals(group)) {
                    continue;
                }
            }
            if (!q.isEmpty() && !e.name.toLowerCase().contains(q) && !e.path.toLowerCase().contains(q)) {
                continue;
            }
            model.addElement(e);
            n++;
        }
        if (n == 0) {
            if (st.project().assets.items.isEmpty()) {
                showHint("素材库是空的", "「导入图片」选几张图，或「导入序列帧」选一个动画文件夹");
            } else {
                showHint("没有匹配的素材", "换个关键词，或者点搜索框旁边的 × 清空条件");
            }
        } else {
            showHint(n + " 个素材", "拖到中间画布上就能摆到地图里");
        }
    }

    private void showHint(String title, String text) {
        hintBar.removeAll();
        JLabel l = new JLabel(title);
        l.setFont(Theme.F_SMALL);
        l.setForeground(Theme.INK_MUTE);
        l.setToolTipText(text);
        hintBar.add(l, BorderLayout.WEST);
        hintBar.revalidate();
        hintBar.repaint();
    }

    /** 卡片式素材格子：缩略图 + 名字 + 关键信息。 */
    private final class CardRenderer implements ListCellRenderer<AssetEntry> {
        @Override
        public Component getListCellRendererComponent(JList<? extends AssetEntry> l, AssetEntry e, int idx,
                                                      boolean sel, boolean focus) {
            JPanel card = new JPanel() {
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
            card.setLayout(new BorderLayout());
            card.setBorder(BorderFactory.createEmptyBorder(6, 6, 6, 6));

            JComponent thumb = new JComponent() {
                @Override
                protected void paintComponent(Graphics g) {
                    Graphics2D g2 = (Graphics2D) g.create();
                    g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                    g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                            RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                    g2.setColor(Theme.SURFACE_SUNK);
                    g2.fillRoundRect(0, 0, getWidth(), getHeight(), Theme.R_SM, Theme.R_SM);
                    if (e.kind == AssetKind.AUDIO) {
                        Ico.of(Ico.Kind.MUSIC, 26, Theme.INK_MUTE).paintIcon(this, g2,
                                (getWidth() - 26) / 2, (getHeight() - 26) / 2);
                    } else {
                        Image img = ImageCache.thumb(AssetImport.projectRoot(st), e, 72);
                        if (img != null) {
                            g2.drawImage(img, (getWidth() - img.getWidth(null)) / 2,
                                    (getHeight() - img.getHeight(null)) / 2, null);
                        } else {
                            Ico.of(Ico.Kind.WARN, 22, Theme.WARN).paintIcon(this, g2,
                                    (getWidth() - 22) / 2, (getHeight() - 22) / 2);
                        }
                    }
                    g2.dispose();
                }
            };
            thumb.setPreferredSize(new Dimension(72, 68));

            JPanel texts = new JPanel();
            texts.setOpaque(false);
            texts.setLayout(new BoxLayout(texts, BoxLayout.Y_AXIS));
            JLabel name = new JLabel(shorten(e.name, 9));
            name.setFont(Theme.F_SMALL);
            name.setForeground(Theme.INK);
            name.setToolTipText(e.name + "　" + hintOf(e));
            JLabel sub = new JLabel(hintOf(e));
            sub.setFont(Theme.F_SMALL.deriveFont(10f));
            sub.setForeground(Theme.INK_MUTE);
            texts.add(name);
            texts.add(sub);

            card.add(thumb, BorderLayout.NORTH);
            card.add(texts, BorderLayout.SOUTH);
            card.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            return card;
        }
    }

    private static String shorten(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }

    /** 供外部（左栏分组切换）使用。 */
    public void setGroup(String g) {
        group = g;
        refill();
    }

    /** 素材库为空时的引导卡（备用）。 */
    public static JComponent emptyCard(AppState st) {
        Card c = new Card("素材");
        c.content().add(new EmptyState(Ico.Kind.ASSET, "还没有素材",
                "把图片或音频拖到这里，或者用上面的导入按钮。",
                Btn.primary("导入图片")), BorderLayout.CENTER);
        return c;
    }
}
