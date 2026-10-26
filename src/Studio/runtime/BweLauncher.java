package Studio.runtime;

import javax.swing.JOptionPane;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;

/**
 * 打包后的 BWE 游戏启动入口。
 *
 * 和 Studio 里的「试玩」不同：打包后的程序没有 java.library.path、没有工作目录约定，
 * 甚至用户可能从任意目录双击 exe。这里负责把路径全部换算成 exe 自身所在目录，
 * 再把控制权交给 TopDownRuntime。
 */
public final class BweLauncher {

    private BweLauncher() {
    }

    public static void main(String[] args) {
        File appDir = appDir();
        File boot = resolveBoot(appDir, args);
        try {
            // JOGL 的原生 DLL 放在 app/natives 下。必须在任何 JOGL 类被加载之前设置。
            File natives = new File(appDir, "natives");
            String oldPath = System.getProperty("java.library.path", "");
            String newPath = natives.getAbsolutePath()
                    + (oldPath.isEmpty() ? "" : File.pathSeparator + oldPath);
            System.setProperty("java.library.path", newPath);
            System.setProperty("bwe.boot", boot.getAbsolutePath());
            log(boot, "启动 BWE 游戏: " + boot.getAbsolutePath());
            log(boot, "应用目录: " + appDir.getAbsolutePath());
            log(boot, "Java: " + System.getProperty("java.version")
                    + " / " + System.getProperty("java.vendor"));
            TopDownRuntime.main(new String[]{boot.getAbsolutePath()});
        } catch (Throwable t) {
            fail(boot, "游戏启动失败", t);
        }
    }

    /** 打包后的 jar 位于 app/ 下，所以 jar 的父目录就是应用目录。 */
    public static File appDir() {
        try {
            File code = new File(BweLauncher.class.getProtectionDomain()
                    .getCodeSource().getLocation().toURI());
            File dir = code.isFile() ? code.getParentFile() : code;
            if (dir != null) {
                return dir.getCanonicalFile();
            }
        } catch (Exception ignored) {
        }
        return new File(System.getProperty("user.dir", "."));
    }

    private static File resolveBoot(File appDir, String[] args) {
        if (args != null && args.length > 0 && args[0] != null && !args[0].isEmpty()) {
            return new File(args[0]).getAbsoluteFile();
        }
        String prop = System.getProperty("bwe.boot", "");
        if (!prop.isEmpty()) {
            File f = new File(prop);
            if (f.isFile()) {
                return f.getAbsoluteFile();
            }
        }
        File besideExe = new File(appDir, "Build" + File.separator + "boot.json");
        if (besideExe.isFile()) {
            return besideExe.getAbsoluteFile();
        }
        return new File("Build" + File.separator + "boot.json").getAbsoluteFile();
    }

    public static void log(File boot, String message) {
        System.out.println("[BWE] " + message);
        File log = logFile(boot);
        try (PrintWriter out = new PrintWriter(new OutputStreamWriter(
                new FileOutputStream(log, true), StandardCharsets.UTF_8))) {
            out.println("[" + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date()) + "] " + message);
        } catch (Exception ignored) {
        }
    }

    public static void fail(File boot, String message, Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        log(boot, message + "\n" + sw);
        try {
            JOptionPane.showMessageDialog(null,
                    message + "\n\n" + t.getMessage()
                            + "\n\n详细信息已写入：\n" + logFile(boot).getAbsolutePath(),
                    "BWE",
                    JOptionPane.ERROR_MESSAGE);
        } catch (Throwable ignored) {
        }
    }

    private static File logFile(File boot) {
        File dir = boot == null ? null : boot.getParentFile();
        if (dir == null) {
            dir = appDir();
        }
        return new File(dir, "bwe.log");
    }
}
