package Studio;

import Studio.app.AppState;
import Studio.app.MainWindow;
import Studio.data.Project;
import Studio.data.ProjectIO;
import Studio.ui.Theme;
import Studio.ui.Toast;
import Studio.ui.UIKit;

import javax.swing.SwingUtilities;
import javax.swing.UIManager;
import java.io.File;
import java.nio.file.Path;

/**
 * BWE Studio 的启动入口。
 *
 *   java Studio.EditorEntry                     启动编辑器（空工程）
 *   java Studio.EditorEntry 路径/工程.bwproj     启动编辑器并打开该工程
 *
 * 编辑器与游戏运行时是两条独立的进程：编辑器不自带 GL 上下文，
 * 避免编辑时占用显卡、也避免两边共享静态状态。
 */
public final class EditorEntry {

    private EditorEntry() {
    }

    public static void main(String[] args) {
        System.setProperty("sun.java2d.uiScale.enabled", "true");
        SwingUtilities.invokeLater(() -> {
            UIKit.install();
            try {
                UIManager.put("Component.focusWidth", 1);
            } catch (Exception ignored) {
            }
            boot(args);
        });
    }

    private static void boot(String[] args) {
        Project project;
        File file = null;

        File want = args.length > 0 ? new File(args[0]) : null;
        if (want != null && want.isFile()) {
            try {
                project = ProjectIO.load(want.toPath());
                file = want;
            } catch (Exception e) {
                project = null;
                Toast.error("打不开这个工程：" + e.getMessage());
            }
        } else {
            File last = lastProject();
            if (last != null && last.isFile()) {
                try {
                    project = ProjectIO.load(last.toPath());
                    file = last;
                    Toast.info("接着上次继续：" + last.getName());
                } catch (Exception e) {
                    project = null;
                }
            } else {
                project = null;
            }
        }

        if (project == null) {
            project = Project.createDefault("未命名工程");
            file = null;
        }

        AppState st = new AppState(project);
        if (file != null) {
            st.setProjectFile(file);
        }

        MainWindow win = new MainWindow(st);
        st.setStatusSink(win.status()::hint);
        Toast.bindOwner(win);
        win.setVisible(true);
        win.status().hint("打开「文件 → 新建工程」，或直接把素材拖进来开始");
        rememberProject(file);
    }

    // ---------------- 最近工程 ----------------

    private static Path recentFile() {
        return Path.of(System.getProperty("user.home", "."), ".bwe-studio", "recent.txt");
    }

    private static File lastProject() {
        try {
            Path p = recentFile();
            if (!java.nio.file.Files.exists(p)) {
                return null;
            }
            String s = java.nio.file.Files.readString(p, java.nio.charset.StandardCharsets.UTF_8).trim();
            return s.isEmpty() ? null : new File(s);
        } catch (Exception e) {
            return null;
        }
    }

    private static void rememberProject(File f) {
        if (f == null) {
            return;
        }
        try {
            Path p = recentFile();
            java.nio.file.Files.createDirectories(p.getParent());
            java.nio.file.Files.writeString(p, f.getAbsolutePath(), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception ignored) {
        }
    }

    /** 供 MainWindow 在"另存为"之后更新最近工程。 */
    static void remember(File f) {
        rememberProject(f);
    }

    /** 主题色导出，供外部（例如未来的深色主题切换）读取。 */
    public static String accentHex() {
        return String.format("#%06X", Theme.ACCENT.getRGB() & 0xFFFFFF);
    }
}
