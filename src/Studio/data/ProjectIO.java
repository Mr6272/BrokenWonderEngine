package Studio.data;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonSyntaxException;
import Studio.ui.Toast;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * 工程读写。
 *
 * 落盘纪律（防止一次误操作毁掉几十小时的工作）：
 * 1. 写临时文件 → 校验可读回 → 原子替换目标文件；断电/崩溃不会留下半个 json。
 * 2. 覆盖前把上一版留成 .bak（只留一份，不无限增长）。
 * 3. 读盘失败绝不重置工程：报错并让调用方决定，不静默新建空白工程覆盖。
 */
public final class ProjectIO {

    public static final String EXT = ".bwproj";
    private static final String BAK = ".bak";

    private static final Gson GSON = new GsonBuilder()
            .setPrettyPrinting()
            .disableHtmlEscaping()
            .serializeNulls()
            .create();

    private ProjectIO() {
    }

    public static String toJson(Project p) {
        return GSON.toJson(p);
    }

    public static Project fromJson(String json) throws JsonSyntaxException {
        Project p = GSON.fromJson(json, Project.class);
        return normalize(p);
    }

    public static Project load(Path file) throws IOException {
        try (Reader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            Project p = GSON.fromJson(r, Project.class);
            return normalize(p);
        }
    }

    /**
     * 补齐字段并做基本自检。Gson 遇到缺字段会留 null，
     * 如果不在入口处一次性补齐，null 会散落到全场各个面板。
     */
    public static Project normalize(Project p) {
        if (p == null) {
            return null;
        }
        if (p.scenes == null) {
            p.scenes = new java.util.ArrayList<>();
        }
        if (p.assets == null) {
            p.assets = new AssetLibrary();
        }
        if (p.assets.items == null) {
            p.assets.items = new java.util.ArrayList<>();
        }
        if (p.packs == null) {
            p.packs = new java.util.ArrayList<>();
        }
        if (p.scripts == null) {
            p.scripts = new java.util.LinkedHashMap<>();
        }
        if (p.variables == null) {
            p.variables = new java.util.LinkedHashMap<>();
        }
        if (p.tileSize <= 0) {
            p.tileSize = 32;
        }
        p.assets.sanitize();
        for (SceneModel s : p.scenes) {
            if (s == null) {
                continue;
            }
            if (s.layers == null) {
                s.layers = new java.util.ArrayList<>();
            }
            if (s.objects == null) {
                s.objects = new java.util.ArrayList<>();
            }
            s.ensureLayerExists();
            for (SceneObject o : s.objects) {
                if (o == null) {
                    continue;
                }
                if (o.modules == null) {
                    o.modules = new java.util.ArrayList<>();
                }
                if (o.tags == null) {
                    o.tags = new java.util.ArrayList<>();
                }
                if (o.props == null) {
                    o.props = new java.util.LinkedHashMap<>();
                }
                for (ModuleInstance m : o.modules) {
                    if (m != null && m.values == null) {
                        m.values = new java.util.LinkedHashMap<>();
                    }
                }
            }
        }
        return p;
    }

    /** 原子写盘 + 自动备份。 */
    public static void save(Project p, Path file) throws IOException {
        Path dir = file.getParent();
        if (dir != null) {
            Files.createDirectories(dir);
        }
        String json = toJson(p);

        // 先验证自己写得出来也读得回去，再动真文件
        Project check = fromJson(json);
        if (check == null) {
            throw new IOException("工程序列化后无法读回，已中止保存");
        }

        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        try (Writer w = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
            w.write(json);
        }
        if (Files.exists(file)) {
            Path bak = file.resolveSibling(file.getFileName() + BAK);
            Files.copy(file, bak, StandardCopyOption.REPLACE_EXISTING);
        }
        try {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException atomicFailed) {
            // 某些文件系统（网络盘）不支持原子移动，降级为普通覆盖
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    public static void saveQuiet(Project p, Path file) {
        try {
            save(p, file);
        } catch (IOException e) {
            Toast.error("保存失败：" + e.getMessage());
        }
    }

    public static Project blank(String name) {
        return Project.createDefault(name);
    }
}
