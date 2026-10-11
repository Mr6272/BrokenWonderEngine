package Studio.app;

import Studio.data.AssetEntry;
import Studio.data.Project;
import Studio.data.ProjectIO;
import Studio.data.SceneModel;
import Studio.data.SceneObject;
import Studio.data.YarnScript;
import Studio.ui.Btn;
import Studio.ui.Card;
import Studio.ui.Dialogs;
import Studio.ui.Ico;
import Studio.ui.Theme;
import Studio.ui.Toast;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JComponent;
import javax.swing.JFileChooser;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;
import javax.swing.WindowConstants;
import javax.swing.filechooser.FileNameExtensionFilter;
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Window;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * 菜单与工具栏背后的动作集合。
 *
 * 约定：所有动作都是"安静的" —— 成功给 Toast 或状态栏，失败才给警告，
 * 并且尽量把工程留在可用状态（保存失败不清空、导入失败不半途改工程）。
 */
public final class Actions {

    private Actions() {
    }

    private static File lastDir;

    // ---------------- 工程 ----------------

    public static void newProject(Window owner, AppState st) {
        if (!guardUnsaved(owner, st)) {
            return;
        }
        JFileChooser fc = chooser("选择新工程存放的位置", JFileChooser.SAVE_DIALOG);
        fc.setSelectedFile(new File("我的工程" + ProjectIO.EXT));
        if (fc.showSaveDialog(owner) != JFileChooser.APPROVE_OPTION) {
            return;
        }
        File f = ensureExt(fc.getSelectedFile(), ProjectIO.EXT);
        if (!confirmOverwrite(owner, f)) {
            return;
        }
        Project p = ProjectIO.blank(stripExt(f.getName()));
        try {
            ProjectIO.save(p, f.toPath());
        } catch (IOException e) {
            Toast.error("建工程失败：" + e.getMessage());
            return;
        }
        st.setProject(p, f);
        st.clearDirty();
        Toast.ok("工程已创建：" + f.getName());
    }

    public static void openProject(Window owner, AppState st) {
        if (!guardUnsaved(owner, st)) {
            return;
        }
        JFileChooser fc = chooser("打开工程", JFileChooser.OPEN_DIALOG);
        fc.setFileFilter(new FileNameExtensionFilter("BWE 工程 (*.bwproj)", "bwproj"));
        if (fc.showOpenDialog(owner) != JFileChooser.APPROVE_OPTION) {
            return;
        }
        File f = fc.getSelectedFile();
        try {
            Project p = ProjectIO.load(f.toPath());
            if (p == null) {
                Toast.error("这个文件不是有效的工程");
                return;
            }
            st.setProject(p, f);
            Toast.ok("已打开 " + f.getName());
        } catch (Exception e) {
            // 读盘失败绝不覆盖用户文件，也不把工程清空
            Toast.error("打开失败：" + e.getMessage());
        }
    }

    /** 保存；返回是否真的保存成功。未命名工程会转成"另存为"。 */
    public static boolean save(AppState st) {
        if (st.project() == null) {
            return false;
        }
        if (st.projectFile() == null) {
            return saveAs(null, st);
        }
        try {
            ProjectIO.save(st.project(), st.projectFile().toPath());
            st.clearDirty();
            Toast.ok("已保存　" + st.projectFile().getName());
            return true;
        } catch (IOException e) {
            Toast.error("保存失败：" + e.getMessage());
            return false;
        }
    }

    public static boolean saveAs(Window owner, AppState st) {
        if (st.project() == null) {
            return false;
        }
        JFileChooser fc = chooser("另存为", JFileChooser.SAVE_DIALOG);
        fc.setSelectedFile(new File((st.projectFile() == null ? st.project().name : stripExt(st.projectFile().getName())) + ProjectIO.EXT));
        if (fc.showSaveDialog(owner) != JFileChooser.APPROVE_OPTION) {
            return false;
        }
        File f = ensureExt(fc.getSelectedFile(), ProjectIO.EXT);
        try {
            ProjectIO.save(st.project(), f.toPath());
            st.setProjectFile(f);
            st.clearDirty();
            Toast.ok("已保存到 " + f.getName());
            return true;
        } catch (IOException e) {
            Toast.error("保存失败：" + e.getMessage());
            return false;
        }
    }

    /** 有未保存改动时问一次；返回 true 表示可以继续。 */
    private static boolean guardUnsaved(Window owner, AppState st) {
        if (!st.isDirty()) {
            return true;
        }
        int r = Dialogs.unsavedChanges(owner, st.project() == null ? "未命名工程" : st.project().name);
        if (r == Dialogs.CANCEL) {
            return false;
        }
        if (r == Dialogs.SAVE) {
            return save(st);
        }
        return true;
    }

    // ---------------- 素材导入 ----------------

    public static void importAssets(Window owner, AppState st) {
        if (st.project() == null) {
            Toast.warn("先新建或打开一个工程");
            return;
        }
        JFileChooser fc = chooser("选一张或多张图片 / 音频", JFileChooser.OPEN_DIALOG);
        fc.setMultiSelectionEnabled(true);
        fc.setFileFilter(new FileNameExtensionFilter("图片与音频", "png", "jpg", "jpeg", "bmp", "gif", "wav", "ogg", "mp3"));
        if (fc.showOpenDialog(owner) != JFileChooser.APPROVE_OPTION) {
            return;
        }
        AssetImport.Result r = AssetImport.importFiles(st, fc.getSelectedFiles());
        reportImport(st, r);
    }

    public static void importSequence(Window owner, AppState st) {
        if (st.project() == null) {
            Toast.warn("先新建或打开一个工程");
            return;
        }
        JFileChooser fc = chooser("选一个文件夹（里面的图按名字顺序成帧）", JFileChooser.DIRECTORIES_ONLY);
        if (fc.showOpenDialog(owner) != JFileChooser.APPROVE_OPTION) {
            return;
        }
        AssetImport.Result r = AssetImport.importSequenceFolder(st, fc.getSelectedFile());
        reportImport(st, r);
    }

    private static void reportImport(AppState st, AssetImport.Result r) {
        if (r.added == 0) {
            if (r.skipped > 0) {
                Toast.info("这些素材已经在库里了，跳过了 " + r.skipped + " 个");
            } else {
                Toast.warn(r.message.isEmpty() ? "没有找到可用素材" : r.message);
            }
            return;
        }
        st.markDirty();
        String extra = r.skipped > 0 ? "（跳过重复 " + r.skipped + " 个）" : "";
        Toast.ok("导入 " + r.added + " 个素材" + extra);
    }

    // ---------------- 导出 ----------------

    /** 导出成原引擎 MapLoader 能读的关卡 JSON，附 topdown 扩展块。 */
    public static void exportLevel(Window owner, AppState st) {
        SceneModel s = st.scene();
        if (s == null || st.project() == null) {
            Toast.warn("没有可导出的场景");
            return;
        }
        JFileChooser fc = chooser("导出关卡 JSON", JFileChooser.SAVE_DIALOG);
        fc.setSelectedFile(new File(safeName(s.name) + ".json"));
        if (fc.showSaveDialog(owner) != JFileChooser.APPROVE_OPTION) {
            return;
        }
        File f = ensureExt(fc.getSelectedFile(), ".json");
        try {
            Files.createDirectories(f.getParentFile().toPath());
            Files.writeString(f.toPath(), buildLevelJson(st, s), StandardCharsets.UTF_8);
            Toast.ok("已导出 " + f.getName() + "　（" + s.objects.size() + " 个对象）");
        } catch (IOException e) {
            Toast.error("导出失败：" + e.getMessage());
        }
    }

    private static String buildLevelJson(AppState st, SceneModel s) {
        Project p = st.project();
        JsonObject root = new JsonObject();
        root.addProperty("width", s.widthTiles);
        root.addProperty("height", s.heightTiles);
        root.addProperty("cellSize", p.tileSize);
        root.addProperty("originX", s.originX);
        root.addProperty("originY", s.originY);
        if (s.bgmAssetId != null && !s.bgmAssetId.isEmpty()) {
            AssetEntry bgm = p.assets.get(s.bgmAssetId);
            if (bgm != null) {
                root.addProperty("bgm", bgm.path);
            }
        }
        if (s.onEnterScript != null && !s.onEnterScript.isEmpty()) {
            root.addProperty("onEnterScript", s.onEnterScript);
        }

        JsonArray objs = new JsonArray();
        for (SceneObject o : s.objects) {
            JsonObject j = new JsonObject();
            j.addProperty("type", runtimeType(o));
            j.addProperty("name", o.name);
            j.addProperty("tag", o.tags.isEmpty() ? "" : o.tags.get(0));
            j.addProperty("x", o.x);
            j.addProperty("y", o.y);
            j.addProperty("z", o.z);
            j.addProperty("rotation", o.rotation);
            j.addProperty("scaleX", o.scaleX);
            j.addProperty("scaleY", o.scaleY);

            JsonObject top = new JsonObject();
            top.addProperty("id", o.id);
            top.addProperty("kind", o.kind.name());
            AssetEntry a = p.assets.get(o.assetId);
            if (a != null) {
                JsonObject aj = new JsonObject();
                aj.addProperty("kind", a.kind.name());
                aj.addProperty("path", a.path);
                if (a.kind == Studio.data.AssetKind.SEQUENCE) {
                    aj.addProperty("head", a.headName);
                    aj.addProperty("frames", a.frameCount);
                } else if (a.kind == Studio.data.AssetKind.ATLAS) {
                    aj.addProperty("cols", a.cols);
                    aj.addProperty("rows", a.rows);
                    aj.addProperty("cell", a.cellW);
                }
                top.add("asset", aj);
            }
            top.addProperty("animMode", o.animMode);
            top.addProperty("animFps", o.animFps);
            if (o.halfW > 0 && o.halfH > 0) {
                JsonObject col = new JsonObject();
                col.addProperty("halfW", o.halfW);
                col.addProperty("halfH", o.halfH);
                top.add("collider", col);
            }
            JsonArray tags = new JsonArray();
            o.tags.forEach(tags::add);
            top.add("tags", tags);
            JsonArray mods = new JsonArray();
            for (Studio.data.ModuleInstance m : o.modules) {
                if (!m.enabled) {
                    continue;
                }
                Studio.data.ModuleDef def = Studio.modules.ModuleRegistry.get().def(m.defId);
                JsonObject mj = new JsonObject();
                mj.addProperty("module", m.defId);
                mj.addProperty("title", def == null ? m.defId : def.title);
                mj.addProperty("when", (m.trigger == null ? (def == null ? Studio.data.Trigger.ALWAYS : def.defaultTrigger()) : m.trigger).name());
                if (m.label != null && !m.label.isEmpty()) {
                    mj.addProperty("label", m.label);
                }
                JsonObject vals = new JsonObject();
                if (def != null) {
                    for (Studio.data.ParamDef d : def.params) {
                        if (d.type == Studio.data.ParamType.NOTE) {
                            continue;
                        }
                        vals.addProperty(d.key, m.value(d.key, d.def));
                    }
                } else {
                    m.values.forEach(vals::addProperty);
                }
                mj.add("params", vals);
                mods.add(mj);
            }
            top.add("modules", mods);
            if (!o.props.isEmpty()) {
                JsonObject pj = new JsonObject();
                o.props.forEach(pj::addProperty);
                top.add("props", pj);
            }
            j.add("topdown", top);
            objs.add(j);
        }
        root.add("objects", objs);

        // 剧本单独携带，方便运行时/打包时一并落地
        JsonObject scripts = new JsonObject();
        for (var e : p.scripts.entrySet()) {
            JsonObject sj = new JsonObject();
            sj.addProperty("file", e.getValue().file);
            sj.addProperty("source", e.getValue().source);
            scripts.add(e.getKey(), sj);
        }
        root.add("scripts", scripts);

        return new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(root);
    }

    /** 编辑器对象类型 → 运行时工厂注册名。 */
    private static String runtimeType(SceneObject o) {
        return switch (o.kind) {
            case ACTOR -> "actor";
            case PROP -> "prop";
            case TILE -> "tile";
            case ZONE -> "zone";
            case SPAWN -> "spawn";
            case PORTAL -> "portal";
            case LIGHT -> "light";
        };
    }

    // ---------------- 剧本 ----------------

    public static void newScript(AppState st) {
        if (st.project() == null) {
            Toast.warn("先新建或打开一个工程");
            return;
        }
        String name = "剧本" + (st.project().scripts.size() + 1);
        YarnScript y = new YarnScript(name, YarnScript.starterSource());
        st.project().scripts.put(name, y);
        st.markDirty();
        Toast.ok("已新建剧本「" + name + "」，可在左侧剧本页编辑");
    }

    // ---------------- 编辑动作 ----------------

    public static void copy(AppState st) {
        SceneObject o = st.first();
        if (o == null) {
            Toast.info("先选中一个对象");
            return;
        }
        st.setClipboard(o);
        st.statusHint("已复制「" + o.name + "」");
    }

    public static void paste(AppState st) {
        SceneObject src = st.clipboard();
        if (src == null) {
            Toast.info("剪贴板是空的");
            return;
        }
        if (st.scene() == null) {
            return;
        }
        SceneObject c = SceneOps.duplicate(src);
        c.x += st.project().tileSize;
        c.y += st.project().tileSize;
        st.scene().objects.add(c);
        st.edit(() -> {
        });
        st.select(c);
        st.statusHint("已粘贴「" + c.name + "」");
    }

    public static void deleteSelection(AppState st) {
        if (st.selection().isEmpty()) {
            Toast.info("没有选中任何对象");
            return;
        }
        int n = st.selection().size();
        if (n > 4 && !Dialogs.confirm(null, "删除 " + n + " 个对象？",
                "这一步可以用 Ctrl+Z 撤销，但连着删几次之后再想找回会比较麻烦。", "删除", true)) {
            return;
        }
        SceneOps.deleteSelected(st);
        st.statusHint("已删除 " + n + " 个对象");
    }

    public static void selectAll(AppState st) {
        if (st.scene() == null) {
            return;
        }
        st.selectAll(new java.util.ArrayList<>(st.scene().objects));
        st.statusHint("已全选 " + st.selection().size() + " 个对象");
    }

    public static void saveAsPack(Window owner, AppState st) {
        Toast.info("先在右侧「对象积木」里调好一组模块，再用这里的保存为规则包");
    }

    // ---------------- 账号（预留） ----------------

    public static void login(Window owner, AppState st) {
        Studio.account.Session.get().openLoginDialog(owner);
    }

    public static void logout(AppState st) {
        Studio.account.Session.get().logout();
        Toast.ok("已退出登录");
    }

    public static void showPlans(Window owner, AppState st) {
        Studio.account.Session.get().openPlansDialog(owner);
    }

    // ---------------- 试玩 ----------------

    public static void play(MainWindow win) {
        Studio.runtime.GameLauncher.launch(win, win.stPublic());
    }

    // ---------------- 帮助 ----------------

    public static void quickStart(Window owner) {
        showDoc(owner, "快速上手", Ico.Kind.WAND, """
                五步做完一张能玩的地图：

                1. 文件 → 新建工程，选个地方存下来。
                2. 文件 → 导入素材，把角色图、地面图一次选进来。
                3. 从左侧「素材」拖到中间画布上，地图上就出现对象了。
                4. 选中对象，右侧会出现它的积木列表：
                     · 想让它动 → 「怎么动」里挑一块
                     · 想让它能被点 → 「什么时候做」里挑「被点击时」
                     · 想让人走不进去 → 「怎么感知」里挑「挡住去路」
                5. 顶部「试玩」直接开游戏窗口验证。

                常用键：
                    V 选择　B 刷子　E 橡皮　Z 画区　H 抓手
                    空格拖动画面　滚轮缩放　Ctrl+Z 撤销　Ctrl+S 保存
                """);
    }

    public static void moduleCheatSheet(Window owner) {
        StringBuilder sb = new StringBuilder();
        for (Studio.data.ModuleCategory c : Studio.data.ModuleCategory.values()) {
            sb.append("【").append(c.cn).append("】").append(c.blurb).append('\n');
            for (Studio.data.ModuleDef d : Studio.modules.ModuleRegistry.get().byCategory(c)) {
                sb.append("    ").append(d.title);
                if (!d.blurb.isEmpty()) {
                    sb.append("　—　").append(d.blurb);
                }
                sb.append('\n');
            }
            sb.append('\n');
        }
        showDoc(owner, "模块速查", Ico.Kind.PUZZLE, sb.toString());
    }

    public static void about(Window owner) {
        showDoc(owner, "关于 BWE Studio", Ico.Kind.MODULE, """
                BWE Studio —— BrokenWonderEngine 的可视化编辑前端。

                引擎部分（渲染、物理、能力组件）沿用 BWE 原有实现；
                本编辑器面向"完全俯视角奇幻 / 科幻 RPG"，把常用逻辑拆成
                看得懂的积木模块，让不写代码也能把一局游戏搭出来。

                剧本使用 Yarn Spinner 语法，可直接用社区文档与工具互通。
                """);
    }

    // ---------------- 通用 UI 小工具 ----------------

    /** 只读长文本查看窗（用于帮助文档）。 */
    private static void showDoc(Window owner, String title, Ico.Kind icon, String text) {
        javax.swing.JDialog d = Dialogs.shell(owner, title);
        JPanel body = new JPanel(new BorderLayout());
        body.setOpaque(false);
        body.setBorder(javax.swing.BorderFactory.createEmptyBorder(Theme.S4, Theme.S4, Theme.S2, Theme.S4));

        JPanel head = new JPanel();
        head.setOpaque(false);
        head.setLayout(new BoxLayout(head, BoxLayout.X_AXIS));
        head.add(new JLabel(icon == null ? Ico.of(Ico.Kind.MODULE, 18) : Ico.of(icon, 18)));
        head.add(Box.createHorizontalStrut(8));
        JLabel t = new JLabel(title);
        t.setFont(Theme.F_H1);
        t.setForeground(Theme.INK);
        head.add(t);
        head.add(Box.createHorizontalGlue());
        head.setBorder(javax.swing.BorderFactory.createEmptyBorder(0, 0, Theme.S3, 0));
        body.add(head, BorderLayout.NORTH);

        JTextArea ta = new JTextArea(text);
        ta.setEditable(false);
        ta.setFont(Theme.F_BODY);
        ta.setForeground(Theme.INK_SUB);
        ta.setBackground(Theme.SURFACE_ALT);
        ta.setBorder(javax.swing.BorderFactory.createEmptyBorder(Theme.S3, Theme.S3, Theme.S3, Theme.S3));
        ta.setLineWrap(true);
        ta.setWrapStyleWord(true);
        JScrollPane sp = new JScrollPane(ta);
        sp.setBorder(javax.swing.BorderFactory.createLineBorder(Theme.LINE));
        sp.setPreferredSize(new Dimension(560, 460));
        body.add(sp, BorderLayout.CENTER);

        JPanel foot = new JPanel();
        foot.setOpaque(false);
        foot.setLayout(new BoxLayout(foot, BoxLayout.X_AXIS));
        foot.add(Box.createHorizontalGlue());
        Btn close = Btn.primary("知道了");
        close.addActionListener(e -> d.dispose());
        foot.add(close);
        foot.setBorder(javax.swing.BorderFactory.createEmptyBorder(Theme.S2, Theme.S4, Theme.S4, Theme.S4));

        ((JPanel) d.getContentPane()).add(body, BorderLayout.CENTER);
        ((JPanel) d.getContentPane()).add(foot, BorderLayout.SOUTH);
        d.getRootPane().setDefaultButton(close);
        d.pack();
        d.setLocationRelativeTo(owner);
        d.setVisible(true);
    }

    private static JFileChooser chooser(String title, int mode) {
        JFileChooser fc = new JFileChooser(lastDir);
        fc.setDialogTitle(title);
        fc.setDialogType(mode);
        fc.setAcceptAllFileFilterUsed(true);
        fc.setPreferredSize(new Dimension(760, 500));
        javax.swing.JComponent c = fc;
        // 让文件选择器也继承全局字体设置
        return fc;
    }

    private static boolean confirmOverwrite(Window owner, File f) {
        if (!f.exists()) {
            return true;
        }
        return Dialogs.confirm(owner, "文件已存在", "同名文件会被覆盖，原来那份会留成 .bak 备份。", "覆盖", true);
    }

    private static File ensureExt(File f, String ext) {
        if (f == null) {
            return null;
        }
        lastDir = f.getParentFile();
        String n = f.getName();
        if (!n.toLowerCase().endsWith(ext.toLowerCase())) {
            return new File(f.getParentFile(), n + ext);
        }
        return f;
    }

    private static String stripExt(String n) {
        int i = n.lastIndexOf('.');
        return i <= 0 ? n : n.substring(0, i);
    }

    private static String safeName(String n) {
        return n == null || n.isEmpty() ? "level" : n.replaceAll("[\\\\/:*?\"<>|]", "_");
    }
}
