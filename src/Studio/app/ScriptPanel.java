package Studio.app;

import Studio.data.YarnScript;
import Studio.ui.Btn;
import Studio.ui.Card;
import Studio.ui.EmptyState;
import Studio.ui.Field;
import Studio.ui.Ico;
import Studio.ui.Theme;
import Studio.ui.Toast;
import Studio.ui.UIKit;
import Studio.yarn.YarnParser;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.DefaultListModel;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JSplitPane;
import javax.swing.JTabbedPane;
import javax.swing.JTextArea;
import javax.swing.ListCellRenderer;
import javax.swing.ListSelectionModel;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.util.Map;

/**
 * 剧本面板（Yarn Spinner 格式）。
 *
 * 布局：左边剧本与节点，右边源码编辑，下边实时解析结果。
 * 三种信息分开放，互不遮挡：
 *   节点   —— 这段剧本由哪几节组成、谁跳到谁
 *   要改   —— 语法与引用问题，逐条指出行号
 *   变量   —— 用了哪些存档变量，方便和模块里的条件对上号
 *
 * 编辑即时生效（300ms 防抖），不需要点保存按钮；离开面板或保存工程时落盘。
 */
public final class ScriptPanel extends Panel {

    private final JPanel root = new JPanel(new BorderLayout());
    private final DefaultListModel<String> scriptModel = new DefaultListModel<>();
    private final DefaultListModel<YarnParser.Node> nodeModel = new DefaultListModel<>();
    private final JList<String> scriptList = new JList<>(scriptModel);
    private final JList<YarnParser.Node> nodeList = new JList<>(nodeModel);
    private final JTextArea editor = new JTextArea();
    private final JLabel stat = new JLabel(" ");
    private final JPanel nodesBody = new JPanel();
    private final JPanel issuesBody = new JPanel();
    private final JPanel varsBody = new JPanel();
    private final JTabbedPane tabs = new JTabbedPane();
    private final Timer debounce;
    private String current;
    private boolean loading;

    public ScriptPanel(AppState st) {
        super(st);
        debounce = new Timer(300, e -> analyze());
        debounce.setRepeats(false);
        build();
        st.subscribe(() -> SwingUtilities.invokeLater(() -> refillScripts(false)));
        refillScripts(true);
    }

    @Override
    public String title() {
        return "剧本";
    }

    @Override
    public Ico.Kind icon() {
        return Ico.Kind.SCRIPT;
    }

    @Override
    public JComponent view() {
        return root;
    }

    private void build() {
        root.setOpaque(false);

        scriptList.setCellRenderer(new ScriptRenderer());
        scriptList.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        scriptList.setBackground(Theme.SURFACE);
        scriptList.setFixedCellHeight(44);
        scriptList.setBorder(BorderFactory.createEmptyBorder(4, 4, 4, 4));
        scriptList.addListSelectionListener(e -> {
            if (e.getValueIsAdjusting()) {
                return;
            }
            String name = scriptList.getSelectedValue();
            if (name != null && !name.equals(current)) {
                open(name);
            }
        });

        nodeList.setCellRenderer(new NodeRenderer());
        nodeList.setBackground(Theme.SURFACE);
        nodeList.setFixedCellHeight(40);
        nodeList.setBorder(BorderFactory.createEmptyBorder(4, 4, 4, 4));
        nodeList.addListSelectionListener(e -> {
            if (e.getValueIsAdjusting()) {
                return;
            }
            YarnParser.Node n = nodeList.getSelectedValue();
            if (n != null) {
                gotoLine(n.line);
            }
        });

        JPanel scriptBar = new JPanel();
        scriptBar.setOpaque(false);
        scriptBar.setLayout(new BoxLayout(scriptBar, BoxLayout.X_AXIS));
        scriptBar.setBorder(BorderFactory.createEmptyBorder(0, 0, Theme.S2, 0));
        Btn add = Btn.primary("+ 新剧本").small();
        add.addActionListener(e -> newScript());
        Btn insert = Btn.ghost("+ 插入节点").small();
        insert.setToolTipText("在当前剧本末尾加一个空白节点骨架");
        insert.addActionListener(e -> insertNode());
        scriptBar.add(add);
        scriptBar.add(Box.createHorizontalStrut(4));
        scriptBar.add(insert);
        scriptBar.add(UIKit.grow());

        JPanel left = new JPanel(new BorderLayout());
        left.setOpaque(false);
        left.add(scriptBar, BorderLayout.NORTH);
        JPanel leftBody = new JPanel();
        leftBody.setOpaque(false);
        leftBody.setLayout(new BoxLayout(leftBody, BoxLayout.Y_AXIS));
        JLabel sl = new JLabel("剧本");
        sl.setFont(Theme.F_SMALL.deriveFont(Font.BOLD));
        sl.setForeground(Theme.INK_SUB);
        sl.setBorder(BorderFactory.createEmptyBorder(0, 2, 3, 0));
        sl.setAlignmentX(Component.LEFT_ALIGNMENT);
        JScrollPane sp1 = UIKit.scroll(scriptList);
        sp1.setPreferredSize(new Dimension(240, 130));
        JLabel nl = new JLabel("节点");
        nl.setFont(Theme.F_SMALL.deriveFont(Font.BOLD));
        nl.setForeground(Theme.INK_SUB);
        nl.setBorder(BorderFactory.createEmptyBorder(Theme.S3, 2, 3, 0));
        nl.setAlignmentX(Component.LEFT_ALIGNMENT);
        leftBody.add(sl);
        leftBody.add(sp1);
        leftBody.add(nl);
        leftBody.add(UIKit.scroll(nodeList));
        left.add(leftBody, BorderLayout.CENTER);

        editor.setFont(Theme.F_MONO);
        editor.setBackground(Theme.SURFACE);
        editor.setForeground(Theme.INK);
        editor.setCaretColor(Theme.ACCENT);
        editor.setBorder(BorderFactory.createEmptyBorder(10, 12, 10, 12));
        editor.setTabSize(4);
        editor.addKeyListener(new KeyAdapter() {
            @Override
            public void keyReleased(KeyEvent e) {
                if (!loading) {
                    debounce.restart();
                }
            }
        });
        editor.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {
            @Override
            public void insertUpdate(javax.swing.event.DocumentEvent e) {
                touched();
            }

            @Override
            public void removeUpdate(javax.swing.event.DocumentEvent e) {
                touched();
            }

            @Override
            public void changedUpdate(javax.swing.event.DocumentEvent e) {
                touched();
            }
        });

        JPanel editorWrap = new JPanel(new BorderLayout());
        editorWrap.setOpaque(false);
        editorWrap.setBorder(BorderFactory.createEmptyBorder(0, Theme.S2, 0, 0));
        JPanel editorHead = new JPanel(new BorderLayout());
        editorHead.setOpaque(false);
        editorHead.setBorder(BorderFactory.createEmptyBorder(0, 0, 4, 0));
        JLabel hint = new JLabel("Yarn Spinner 格式　·　改完自动生效，不用点保存");
        hint.setFont(Theme.F_SMALL.deriveFont(10.5f));
        hint.setForeground(Theme.INK_MUTE);
        editorHead.add(hint, BorderLayout.WEST);
        editorWrap.add(editorHead, BorderLayout.NORTH);
        editorWrap.add(UIKit.scroll(editor), BorderLayout.CENTER);

        nodesBody.setOpaque(false);
        nodesBody.setLayout(new BoxLayout(nodesBody, BoxLayout.Y_AXIS));
        issuesBody.setOpaque(false);
        issuesBody.setLayout(new BoxLayout(issuesBody, BoxLayout.Y_AXIS));
        varsBody.setOpaque(false);
        varsBody.setLayout(new BoxLayout(varsBody, BoxLayout.Y_AXIS));
        tabs.setFont(Theme.F_SMALL);
        tabs.addTab("节点", UIKit.scroll(nodesBody));
        tabs.addTab("要改", UIKit.scroll(issuesBody));
        tabs.addTab("变量", UIKit.scroll(varsBody));
        tabs.setPreferredSize(new Dimension(0, 230));

        JPanel right = new JPanel(new BorderLayout());
        right.setOpaque(false);
        right.add(editorWrap, BorderLayout.CENTER);
        right.add(tabs, BorderLayout.SOUTH);

        JSplitPane split = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, left, right);
        split.setDividerSize(6);
        split.setBorder(BorderFactory.createEmptyBorder());
        split.setDividerLocation(250);
        split.setOpaque(false);

        stat.setFont(Theme.F_SMALL);
        stat.setForeground(Theme.INK_MUTE);
        stat.setBorder(BorderFactory.createEmptyBorder(Theme.S2, 2, 0, 2));

        root.add(split, BorderLayout.CENTER);
        root.add(stat, BorderLayout.SOUTH);
    }

    private void touched() {
        if (loading) {
            return;
        }
        debounce.restart();
    }

    @Override
    public void refresh() {
        refillScripts(false);
    }

    private void refillScripts(boolean forceOpen) {
        String keep = current;
        scriptModel.clear();
        if (st.project() == null) {
            stat.setText("还没有工程");
            return;
        }
        for (String k : st.project().scripts.keySet()) {
            scriptModel.addElement(k);
        }
        if (scriptModel.isEmpty()) {
            current = null;
            loading = true;
            editor.setText("");
            editor.setEnabled(false);
            loading = false;
            nodesBody.removeAll();
            issuesBody.removeAll();
            varsBody.removeAll();
            varsBody.add(emptyHint("还没有剧本",
                    "点上面的「+ 新剧本」，会给你一段能直接跑的示例剧本，照着改就行。"));
            revalidateAll();
            stat.setText("没有剧本");
            return;
        }
        editor.setEnabled(true);
        if (keep != null && scriptModel.contains(keep)) {
            scriptList.setSelectedValue(keep, true);
            if (forceOpen) {
                open(keep);
            }
        } else if (forceOpen || current == null) {
            String first = scriptModel.get(0);
            scriptList.setSelectedValue(first, true);
            open(first);
        }
    }

    private void open(String name) {
        if (st.project() == null) {
            return;
        }
        YarnScript y = st.project().scripts.get(name);
        if (y == null) {
            return;
        }
        current = name;
        loading = true;
        editor.setText(y.source);
        editor.setCaretPosition(0);
        loading = false;
        analyze();
    }

    private void analyze() {
        if (st.project() == null || current == null) {
            return;
        }
        YarnScript y = st.project().scripts.get(current);
        if (y == null) {
            return;
        }
        String text = editor.getText();
        if (!text.equals(y.source)) {
            y.source = text;
            st.markDirty();
        }
        YarnParser.Result r = YarnParser.parse(text);

        nodeModel.clear();
        for (YarnParser.Node n : r.nodes) {
            nodeModel.addElement(n);
        }

        nodesBody.removeAll();
        if (r.nodes.isEmpty()) {
            nodesBody.add(emptyHint("没有节点", "一个节点从 title: 名字 开始，用 --- 进入正文，用 === 结束。"));
        } else {
            for (YarnParser.Node n : r.nodes) {
                nodesBody.add(nodeCard(n));
                nodesBody.add(Box.createVerticalStrut(6));
            }
        }

        issuesBody.removeAll();
        if (r.issues.isEmpty()) {
            JLabel ok = new JLabel("没有问题，这段剧本可以直接跑。");
            ok.setFont(Theme.F_BODY);
            ok.setForeground(Theme.OK);
            ok.setBorder(BorderFactory.createEmptyBorder(12, 12, 0, 0));
            ok.setAlignmentX(Component.LEFT_ALIGNMENT);
            issuesBody.add(ok);
        } else {
            for (YarnParser.Issue i : r.issues) {
                JLabel l = new JLabel((i.error ? "要改  " : "建议  ") + "第 " + i.line + " 行　" + i.message);
                l.setFont(Theme.F_SMALL);
                l.setForeground(i.error ? Theme.DANGER : Theme.WARN);
                l.setBorder(BorderFactory.createEmptyBorder(6, 12, 0, 12));
                l.setAlignmentX(Component.LEFT_ALIGNMENT);
                issuesBody.add(l);
            }
        }

        varsBody.removeAll();
        if (r.variables.isEmpty()) {
            varsBody.add(emptyHint("还没有用到变量",
                    "在剧本里写 <<set $见过老人 = true>> 就能记一件事，"
                            + "模块里的「变量到达条件」可以读它。"));
        } else {
            for (String v : r.variables) {
                JLabel l = new JLabel("$" + v);
                l.setFont(Theme.F_MONO);
                l.setForeground(Theme.INK);
                l.setBorder(BorderFactory.createEmptyBorder(6, 12, 0, 12));
                l.setAlignmentX(Component.LEFT_ALIGNMENT);
                varsBody.add(l);
            }
        }

        if (r.errorCount() > 0) {
            tabs.setTitleAt(1, "要改 (" + r.errorCount() + ")");
            stat.setForeground(Theme.DANGER);
        } else {
            tabs.setTitleAt(1, "要改");
            stat.setForeground(Theme.INK_MUTE);
        }
        stat.setText(YarnParser.summarize(r));
        revalidateAll();
    }

    private void revalidateAll() {
        nodesBody.revalidate();
        issuesBody.revalidate();
        varsBody.revalidate();
        root.revalidate();
        root.repaint();
    }

    private JComponent nodeCard(YarnParser.Node n) {
        JPanel card = new JPanel(new BorderLayout()) {
            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setColor(Theme.SURFACE_ALT);
                g2.fillRoundRect(0, 0, getWidth() - 1, getHeight() - 1, Theme.R_MD, Theme.R_MD);
                g2.setColor(n.issues.isEmpty() ? Theme.LINE_SOFT : Theme.DANGER);
                g2.drawRoundRect(0, 0, getWidth() - 1, getHeight() - 1, Theme.R_MD, Theme.R_MD);
                g2.dispose();
                super.paintComponent(g);
            }
        };
        card.setOpaque(false);
        card.setAlignmentX(Component.LEFT_ALIGNMENT);
        card.setBorder(BorderFactory.createEmptyBorder(8, 12, 8, 12));

        JPanel body = new JPanel();
        body.setOpaque(false);
        body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS));

        JLabel name = new JLabel(n.title);
        name.setFont(Theme.F_BODY.deriveFont(Font.BOLD));
        name.setForeground(Theme.INK);
        name.setAlignmentX(Component.LEFT_ALIGNMENT);
        body.add(name);

        StringBuilder sb = new StringBuilder();
        sb.append("第 ").append(n.line).append("–").append(n.endLine).append(" 行");
        if (n.choices.size() > 0) {
            sb.append("　·　").append(n.choices.size()).append(" 个选项");
        }
        if (!n.jumps.isEmpty()) {
            sb.append("　·　去 ").append(String.join("、", n.jumps));
        }
        if (!n.speakers.isEmpty()) {
            sb.append("　·　说话人 ").append(String.join("、", n.speakers));
        }
        if (!n.setsVars.isEmpty()) {
            sb.append("　·　记下 ").append(String.join("、", n.setsVars));
        }
        JLabel meta = new JLabel("<html><div style='width:520px'>" + sb + "</div></html>");
        meta.setFont(Theme.F_SMALL);
        meta.setForeground(Theme.INK_SUB);
        meta.setAlignmentX(Component.LEFT_ALIGNMENT);
        meta.setBorder(BorderFactory.createEmptyBorder(3, 0, 0, 0));
        body.add(meta);

        if (!n.choices.isEmpty()) {
            StringBuilder ch = new StringBuilder("选项：");
            for (int i = 0; i < n.choices.size(); i++) {
                if (i > 0) {
                    ch.append("　|　");
                }
                ch.append(n.choices.get(i).text);
                if (!n.choices.get(i).condition.isEmpty()) {
                    ch.append("（").append(n.choices.get(i).condition).append(" 才出现）");
                }
            }
            JLabel c = new JLabel("<html><div style='width:520px'>" + ch + "</div></html>");
            c.setFont(Theme.F_SMALL);
            c.setForeground(Theme.INK_MUTE);
            c.setAlignmentX(Component.LEFT_ALIGNMENT);
            c.setBorder(BorderFactory.createEmptyBorder(3, 0, 0, 0));
            body.add(c);
        }
        for (YarnParser.Issue i : n.issues) {
            JLabel l = new JLabel("· " + i.message);
            l.setFont(Theme.F_SMALL);
            l.setForeground(i.error ? Theme.DANGER : Theme.WARN);
            l.setAlignmentX(Component.LEFT_ALIGNMENT);
            body.add(l);
        }
        card.add(body, BorderLayout.CENTER);
        card.setMaximumSize(new Dimension(Integer.MAX_VALUE, Integer.MAX_VALUE));
        return card;
    }

    private JComponent emptyHint(String title, String text) {
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new BoxLayout(p, BoxLayout.Y_AXIS));
        p.setBorder(BorderFactory.createEmptyBorder(14, 12, 12, 12));
        JLabel t = new JLabel(title);
        t.setFont(Theme.F_BODY.deriveFont(Font.BOLD));
        t.setForeground(Theme.INK_SUB);
        t.setAlignmentX(Component.LEFT_ALIGNMENT);
        JLabel d = new JLabel("<html><div style='width:460px'>" + text + "</div></html>");
        d.setFont(Theme.F_SMALL);
        d.setForeground(Theme.INK_MUTE);
        d.setAlignmentX(Component.LEFT_ALIGNMENT);
        d.setBorder(BorderFactory.createEmptyBorder(4, 0, 0, 0));
        p.add(t);
        p.add(d);
        p.setAlignmentX(Component.LEFT_ALIGNMENT);
        return p;
    }

    private void newScript() {
        if (st.project() == null) {
            Toast.warn("先新建或打开一个工程");
            return;
        }
        int i = 1;
        String name;
        do {
            name = "剧本 " + i++;
        } while (st.project().scripts.containsKey(name));
        YarnScript y = new YarnScript(name, YarnScript.starterSource());
        st.project().scripts.put(name, y);
        st.markDirty();
        current = null;
        refillScripts(true);
        scriptList.setSelectedValue(name, true);
        open(name);
        Toast.ok("建好了「" + name + "」，里面是一段可以直接跑的示例");
    }

    private void insertNode() {
        if (st.project() == null) {
            Toast.warn("先新建或打开一个工程");
            return;
        }
        if (current == null) {
            newScript();
            return;
        }
        int i = 1;
        String title;
        do {
            title = "新节点 " + i++;
        } while (editor.getText().contains("title: " + title));
        int pos = editor.getCaretPosition();
        String snippet = YarnParser.newNodeSnippet(title);
        editor.insert(snippet, pos);
        st.statusHint("已插入节点「" + title + "」");
        debounce.restart();
    }

    private void gotoLine(int line) {
        try {
            int start = editor.getLineStartOffset(Math.max(0, line - 1));
            int end = editor.getLineEndOffset(Math.max(0, line - 1));
            editor.requestFocusInWindow();
            editor.select(start, Math.min(end, start + 80));
        } catch (Exception ignored) {
        }
    }

    /** 剧本列表项。 */
    private static final class ScriptRenderer implements ListCellRenderer<String> {
        @Override
        public Component getListCellRendererComponent(JList<? extends String> l, String name, int i,
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
            JLabel n = new JLabel(name);
            n.setFont(Theme.F_BODY.deriveFont(Font.BOLD));
            n.setForeground(Theme.INK);
            JLabel d = new JLabel("点开编辑");
            d.setFont(Theme.F_SMALL.deriveFont(10f));
            d.setForeground(Theme.INK_MUTE);
            JPanel t = new JPanel();
            t.setOpaque(false);
            t.setLayout(new BoxLayout(t, BoxLayout.Y_AXIS));
            t.add(n);
            t.add(d);
            card.add(t, BorderLayout.CENTER);
            return card;
        }
    }

    /** 节点列表项。 */
    private static final class NodeRenderer implements ListCellRenderer<YarnParser.Node> {
        @Override
        public Component getListCellRendererComponent(JList<? extends YarnParser.Node> l, YarnParser.Node n, int i,
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
            row.setBorder(BorderFactory.createEmptyBorder(4, 8, 4, 8));
            JLabel name = new JLabel(n.title);
            name.setFont(Theme.F_BODY);
            name.setForeground(Theme.INK);
            String sub = n.line + "–" + n.endLine + " 行";
            if (n.choices.size() > 0) {
                sub += "　" + n.choices.size() + " 选项";
            }
            JLabel meta = new JLabel(sub);
            meta.setFont(Theme.F_SMALL.deriveFont(10f));
            meta.setForeground(Theme.INK_MUTE);
            JPanel t = new JPanel();
            t.setOpaque(false);
            t.setLayout(new BoxLayout(t, BoxLayout.Y_AXIS));
            t.add(name);
            t.add(meta);
            row.add(t, BorderLayout.CENTER);
            if (!n.issues.isEmpty()) {
                JLabel warn = new JLabel(Ico.of(Ico.Kind.WARN, 13, Theme.DANGER));
                row.add(warn, BorderLayout.EAST);
            }
            return row;
        }
    }

    /** 供未来把剧本节点画成流程图时复用。 */
    public Map<String, YarnParser.Node> nodes() {
        return YarnParser.parse(editor.getText()).byTitle;
    }
}
