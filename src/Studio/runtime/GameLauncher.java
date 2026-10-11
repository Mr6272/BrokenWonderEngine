package Studio.runtime;

import Studio.app.AppState;
import Studio.app.MainWindow;
import Studio.data.AssetEntry;
import Studio.data.Project;
import Studio.data.ProjectIO;
import Studio.ui.Toast;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 试玩启动器：把当前工程交给游戏运行时。
 *
 * 做法：先导出关卡 JSON 到工程的 Build/ 目录，再起一个独立 JVM 进程跑运行时。
 * 独立进程的三个好处：
 * 1. 编辑器不会被游戏循环拖慢；
 * 2. 游戏崩溃不影响编辑中的工程；
 * 3. 关掉游戏窗口就是关掉进程，不留残留状态。
 */
public final class GameLauncher {

    private GameLauncher() {
    }

    public static void launch(MainWindow owner, AppState st) {
        if (st.project() == null || st.scene() == null) {
            Toast.warn("先新建工程并放点东西进场景");
            return;
        }
        File boot;
        try {
            boot = exportForPlay(st);
        } catch (IOException e) {
            Toast.error("生成试玩数据失败：" + e.getMessage());
            return;
        }
        List<String> cmd = buildCommand(boot);
        if (cmd == null) {
            Toast.error("找不到 java 运行环境，无法启动试玩");
            return;
        }
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.directory(new File(System.getProperty("user.dir")));
            pb.redirectErrorStream(true);
            Process p = pb.start();
            Toast.ok("游戏已启动（独立窗口），关掉那个窗口就结束试玩");
            // 输出转发到控制台，方便排查；不阻塞编辑器
            new Thread(() -> {
                try (var r = p.getInputStream()) {
                    r.transferTo(OutputStream.nullOutputStream());
                } catch (IOException ignored) {
                }
            }, "bwe-play-log").start();
        } catch (IOException e) {
            Toast.error("启动失败：" + e.getMessage());
        }
    }

    /** 把工程写成运行时可直接读的 boot.json + 逐场景关卡文件。 */
    private static File exportForPlay(AppState st) throws IOException {
        Project p = st.project();
        File root = st.projectFile() != null ? st.projectFile().getParentFile() : new File(".");
        Path build = root.toPath().resolve("Build");
        Files.createDirectories(build);

        var gson = new com.google.gson.GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
        var boot = new com.google.gson.JsonObject();
        boot.addProperty("project", p.name);
        boot.addProperty("tileSize", p.tileSize);
        boot.addProperty("masterVolume", p.masterVolume);

        var sceneArr = new com.google.gson.JsonArray();
        for (Studio.data.SceneModel s : p.scenes) {
            String fname = "scene_" + safe(s.name) + ".json";
            Files.writeString(build.resolve(fname), sceneJson(p, s), StandardCharsets.UTF_8);
            var sj = new com.google.gson.JsonObject();
            sj.addProperty("name", s.name);
            sj.addProperty("file", fname);
            sj.addProperty("width", s.widthTiles);
            sj.addProperty("height", s.heightTiles);
            sceneArr.add(sj);
        }
        boot.add("scenes", sceneArr);

        var vars = new com.google.gson.JsonObject();
        p.variables.forEach(vars::addProperty);
        boot.add("variables", vars);

        var scripts = new com.google.gson.JsonArray();
        for (var e : p.scripts.entrySet()) {
            var sj = new com.google.gson.JsonObject();
            sj.addProperty("name", e.getKey());
            sj.addProperty("source", e.getValue().source);
            scripts.add(sj);
        }
        boot.add("scripts", scripts);

        Path bootFile = build.resolve("boot.json");
        Files.writeString(bootFile, gson.toJson(boot), StandardCharsets.UTF_8);
        return bootFile.toFile();
    }

    private static String sceneJson(Project p, Studio.data.SceneModel s) {
        var root = new com.google.gson.JsonObject();
        root.addProperty("width", s.widthTiles);
        root.addProperty("height", s.heightTiles);
        root.addProperty("tileSize", p.tileSize);
        var objs = new com.google.gson.JsonArray();
        for (Studio.data.SceneObject o : s.objects) {
            var j = new com.google.gson.JsonObject();
            j.addProperty("id", o.id);
            j.addProperty("kind", o.kind.name());
            j.addProperty("name", o.name);
            j.addProperty("x", o.x);
            j.addProperty("y", o.y);
            j.addProperty("z", o.z);
            j.addProperty("rotation", o.rotation);
            j.addProperty("scaleX", o.scaleX);
            j.addProperty("scaleY", o.scaleY);
            j.addProperty("halfW", o.halfW);
            j.addProperty("halfH", o.halfH);
            j.addProperty("visible", o.visible);
            AssetEntry a = p.assets.get(o.assetId);
            if (a != null) {
                var aj = new com.google.gson.JsonObject();
                aj.addProperty("kind", a.kind.name());
                aj.addProperty("path", a.path);
                aj.addProperty("head", a.headName);
                aj.addProperty("frames", a.frameCount);
                aj.addProperty("cols", a.cols);
                aj.addProperty("rows", a.rows);
                aj.addProperty("cellW", a.cellW);
                aj.addProperty("cellH", a.cellH);
                aj.addProperty("zeroBased", a.zeroBased);
                j.add("asset", aj);
            }
            j.addProperty("animMode", o.animMode);
            j.addProperty("animFps", o.animFps);
            var tags = new com.google.gson.JsonArray();
            o.tags.forEach(tags::add);
            j.add("tags", tags);
            var mods = new com.google.gson.JsonArray();
            for (Studio.data.ModuleInstance m : o.modules) {
                if (!m.enabled) {
                    continue;
                }
                var mj = new com.google.gson.JsonObject();
                mj.addProperty("def", m.defId);
                mj.addProperty("when", (m.trigger == null
                        ? (Studio.modules.ModuleRegistry.get().def(m.defId) == null
                        ? Studio.data.Trigger.ALWAYS
                        : Studio.modules.ModuleRegistry.get().def(m.defId).defaultTrigger())
                        : m.trigger).name());
                if (m.label != null && !m.label.isEmpty()) {
                    mj.addProperty("label", m.label);
                }
                var vals = new com.google.gson.JsonObject();
                m.values.forEach(vals::addProperty);
                mj.add("params", vals);
                mods.add(mj);
            }
            j.add("modules", mods);
            var props = new com.google.gson.JsonObject();
            o.props.forEach(props::addProperty);
            j.add("props", props);
            objs.add(j);
        }
        root.add("objects", objs);
        return new com.google.gson.GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(root);
    }

    private static List<String> buildCommand(File boot) {
        String javaHome = System.getProperty("java.home");
        String exe = javaHome + File.separator + "bin" + File.separator
                + (System.getProperty("os.name").toLowerCase().contains("win") ? "java.exe" : "java");
        if (!new File(exe).exists()) {
            exe = "java";
        }
        List<String> cmd = new ArrayList<>();
        cmd.add(exe);
        cmd.add("-Dfile.encoding=UTF-8");
        cmd.add("-Djava.library.path=lib");
        cmd.add("-cp");
        cmd.add(System.getProperty("java.class.path"));
        cmd.add("Studio.runtime.TopDownRuntime");
        cmd.add(boot.getAbsolutePath());
        return cmd;
    }

    private static String safe(String n) {
        return n == null || n.isEmpty() ? "scene" : n.replaceAll("[\\\\/:*?\"<>| ]", "_");
    }
}
