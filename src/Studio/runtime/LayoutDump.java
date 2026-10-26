package Studio.runtime;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * 布局自检入口：不创建窗口，只把「编辑器数据 → 引擎画面」的几何结果打印成 JSON。
 *
 * <p>用途：打包前/改完映射后，用 {@code web/tools/verify-mapping.mjs} 跑一遍
 * 「编辑器公式复算 vs 引擎实际计算」，避免再次出现「编辑器里好好的，打包出来错位」。
 *
 * <pre>
 * java -cp "bin;lib/*" Studio.runtime.LayoutDump --boot Build/boot.json --view 1280x720 --out layout.json
 * </pre>
 */
public final class LayoutDump {

    private LayoutDump() {
    }

    public static void main(String[] args) {
        try {
            String bootArg = readArg(args, "--boot", null);
            if (bootArg == null) {
                bootArg = firstPositional(args);
            }
            if (bootArg == null) {
                usage();
                System.exit(2);
                return;
            }
            File boot = new File(bootArg).getAbsoluteFile();
            if (!boot.isFile()) {
                System.err.println("找不到 boot.json: " + boot);
                System.exit(2);
                return;
            }
            int[] view = parseView(readArg(args, "--view", "1280x720"));
            String fit = readArg(args, "--fit", null);
            TopDownRuntime runtime = new TopDownRuntime(boot);
            if (fit != null) {
                runtime.setFitMode(fit);
            }
            String json = runtime.dumpLayout(view[0], view[1]);
            String out = readArg(args, "--out", null);
            if (out == null) {
                System.out.println(json);
            } else {
                File f = new File(out).getAbsoluteFile();
                File parent = f.getParentFile();
                if (parent != null) {
                    //noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                }
                Files.write(f.toPath(), json.getBytes(StandardCharsets.UTF_8));
                System.out.println("已写出布局报告: " + f);
            }
        } catch (Throwable t) {
            System.err.println("布局自检失败: " + t);
            t.printStackTrace();
            System.exit(1);
        }
    }

    private static int[] parseView(String raw) {
        String s = raw == null ? "" : raw.trim().toLowerCase();
        int idx = s.indexOf('x');
        if (idx > 0) {
            try {
                int w = Integer.parseInt(s.substring(0, idx).trim());
                int h = Integer.parseInt(s.substring(idx + 1).trim());
                if (w > 0 && h > 0) {
                    return new int[]{w, h};
                }
            } catch (NumberFormatException ignored) {
            }
        }
        return new int[]{1280, 720};
    }

    private static String readArg(String[] args, String key, String def) {
        for (int i = 0; i < args.length; i++) {
            if (args[i].equals(key) && i + 1 < args.length) {
                return args[i + 1];
            }
            if (args[i].startsWith(key + "=")) {
                return args[i].substring(key.length() + 1);
            }
        }
        return def;
    }

    private static String firstPositional(String[] args) {
        for (String a : args) {
            if (!a.startsWith("--")) {
                return a;
            }
        }
        return null;
    }

    private static void usage() {
        System.out.println("用法: LayoutDump --boot <Build/boot.json> [--view 1280x720] [--fit contain|cover] [--out layout.json]");
        System.out.println("说明: 不建窗口，输出世界坐标与屏幕坐标的映射结果，供映射校验脚本使用。");
    }
}
