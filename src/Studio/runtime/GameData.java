package Studio.runtime;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 运行时数据模型：把编辑器导出的 Build/boot.json 读成内存对象。
 *
 * 刻意与编辑器模型分开：编辑器模型随编辑器演进，运行时只依赖这份"已经定稿的导出格式"。
 * 两者之间唯一的契约就是 boot.json，这样游戏包不会因为编辑器重构而失效。
 */
public final class GameData {

    public String project = "";
    public int tileSize = 32;
    public float masterVolume = 0.8f;
    public final List<SceneRef> scenes = new ArrayList<>();
    public final Map<String, String> variables = new LinkedHashMap<>();
    public final Map<String, String> scripts = new LinkedHashMap<>();
    /** 工程级素材表：玩法模块按素材名找图时用（扫雷、换装）。 */
    public final Map<String, RtAsset> assets = new LinkedHashMap<>();
    public final Map<String, RtAsset> assetsByName = new LinkedHashMap<>();

    public static final class SceneRef {
        public String name;
        public String file;
        public int width;
        public int height;
    }

    public static final class RtAsset {
        public String id = "";
        public String name = "";
        public String kind = "IMAGE";
        public String path = "";
        public String head = "";
        public int frames = 1;
        public int cols = 1;
        public int rows = 1;
        public int cellW = 0;
        public int cellH = 0;
        public boolean zeroBased = false;
    }

    /** 场景里的一个对象（含它挂的模块，模块由解释器执行）。 */
    public static final class RtObject {
        public String id = "";
        public String kind = "PROP";
        public String name = "";
        public float x, y, rotation = 0;
        public float scaleX = 1, scaleY = 1;
        public int z = 0;
        /** 图层下标：编辑器绘制顺序是 layer → z → y（见 web/src/app/canvas.ts orderObjects）。 */
        public int layer = 0;
        public float halfW, halfH;
        public boolean visible = true;
        public String assetId = "";
        public String assetName = "";
        public RtAsset asset;
        public String animMode = "默认";
        public float animFps = 8;
        public final List<String> tags = new ArrayList<>();
        public final List<RtModule> modules = new ArrayList<>();
        public final Map<String, String> props = new LinkedHashMap<>();
    }

    /** 挂在对象上的模块：定义 id + 触发时机 + 参数。 */
    public static final class RtModule {
        public String def = "";
        public String when = "ALWAYS";
        public String label = "";
        public final Map<String, String> params = new LinkedHashMap<>();

        public float num(String key, float def) {
            try {
                return Float.parseFloat(params.getOrDefault(key, String.valueOf(def)).trim());
            } catch (Exception e) {
                return def;
            }
        }

        public int intOf(String key, int def) {
            return Math.round(num(key, def));
        }

        public boolean bool(String key, boolean def) {
            String v = params.getOrDefault(key, def ? "开" : "关");
            return v.equalsIgnoreCase("开") || v.equalsIgnoreCase("true") || v.equals("1");
        }

        public String str(String key, String def) {
            String v = params.get(key);
            return v == null || v.isEmpty() ? def : v;
        }
    }

    public static final class RtScene {
        public int width = 60;
        public int height = 40;
        public int tileSize = 32;
        public final List<RtObject> objects = new ArrayList<>();
    }

    // ---------------- 读盘 ----------------

    public static File resolveRoot(File bootFile) {
        File dir = bootFile.getParentFile();
        return dir == null ? new File(".") : dir.getParentFile() == null ? dir : dir.getParentFile();
    }

    public static GameData load(File bootFile) throws IOException {
        String json = readText(bootFile);
        JsonObject root = new Gson().fromJson(json, JsonObject.class);
        GameData g = new GameData();
        g.project = str(root, "project", "未命名");
        g.tileSize = num(root, "tileSize", 32);
        g.masterVolume = num(root, "masterVolume", 0.8f);
        JsonArray sc = arr(root, "scenes");
        for (JsonElement e : sc) {
            JsonObject o = e.getAsJsonObject();
            SceneRef r = new SceneRef();
            r.name = str(o, "name", "");
            r.file = str(o, "file", "");
            r.width = num(o, "width", 60);
            r.height = num(o, "height", 40);
            g.scenes.add(r);
        }
        JsonObject v = obj(root, "variables");
        for (String k : v.keySet()) {
            g.variables.put(k, v.get(k).getAsString());
        }
        for (JsonElement e : arr(root, "scripts")) {
            JsonObject o = e.getAsJsonObject();
            g.scripts.put(str(o, "name", ""), str(o, "source", ""));
        }
        for (JsonElement e : arr(root, "assets")) {
            if (!e.isJsonObject()) {
                continue;
            }
            RtAsset a = readAsset(e.getAsJsonObject());
            if (!a.id.isEmpty()) {
                g.assets.put(a.id, a);
            }
            if (!a.name.isEmpty()) {
                g.assetsByName.put(a.name, a);
            }
        }
        return g;
    }

    public static RtScene loadScene(File sceneFile, int fallbackTile) throws IOException {
        String json = readText(sceneFile);
        JsonObject root = new Gson().fromJson(json, JsonObject.class);
        RtScene s = new RtScene();
        s.width = num(root, "width", 60);
        s.height = num(root, "height", 40);
        s.tileSize = num(root, "tileSize", fallbackTile);
        for (JsonElement e : arr(root, "objects")) {
            JsonObject o = e.getAsJsonObject();
            RtObject t = new RtObject();
            t.id = str(o, "id", "");
            t.kind = str(o, "kind", "PROP");
            t.name = str(o, "name", "");
            // ⚠ 默认值必须写字面量 float（0f/1f/8f）：写成 0/1/8 会命中
            // num(JsonObject,String,int) 重载，内部 getAsInt() 会把编辑器里产生的
            // 小数坐标/半宽/缩放全部截断，打包后就变成「位置差一截、大小比例不对」。
            t.x = num(o, "x", 0f);
            t.y = num(o, "y", 0f);
            t.rotation = num(o, "rotation", 0f);
            t.scaleX = num(o, "scaleX", 1f);
            t.scaleY = num(o, "scaleY", 1f);
            t.z = num(o, "z", 0);
            t.layer = num(o, "layer", 0);
            t.halfW = num(o, "halfW", 0f);
            t.halfH = num(o, "halfH", 0f);
            t.visible = !o.has("visible") || o.get("visible").getAsBoolean();
            t.assetId = str(o, "assetId", "");
            t.assetName = str(o, "assetName", "");
            t.animMode = str(o, "animMode", "默认");
            t.animFps = num(o, "animFps", 8f);
            if (o.has("asset") && o.get("asset").isJsonObject()) {
                t.asset = readAsset(o.getAsJsonObject("asset"));
            }
            for (JsonElement te : arr(o, "tags")) {
                t.tags.add(te.getAsString());
            }
            for (JsonElement me : arr(o, "modules")) {
                JsonObject m = me.getAsJsonObject();
                RtModule rm = new RtModule();
                rm.def = str(m, "def", "");
                rm.when = str(m, "when", "ALWAYS");
                rm.label = str(m, "label", "");
                if (m.has("params") && m.get("params").isJsonObject()) {
                    JsonObject ps = m.getAsJsonObject("params");
                    for (String k : ps.keySet()) {
                        rm.params.put(k, ps.get(k).isJsonPrimitive() ? ps.get(k).getAsString() : ps.get(k).toString());
                    }
                }
                t.modules.add(rm);
            }
            if (o.has("props") && o.get("props").isJsonObject()) {
                JsonObject ps = o.getAsJsonObject("props");
                for (String k : ps.keySet()) {
                    t.props.put(k, ps.get(k).isJsonPrimitive() ? ps.get(k).getAsString() : "");
                }
            }
            s.objects.add(t);
        }
        return s;
    }

    public RtModule firstModule(RtObject o, String def, String when) {
        for (RtModule m : o.modules) {
            if (m.def.equals(def) && (when == null || m.when.equals(when))) {
                return m;
            }
        }
        return null;
    }

    public boolean has(RtObject o, String def) {
        return firstModule(o, def, null) != null;
    }

    /** 兼容两套 id：Web 编辑器用 combat.health / fx.cameraFollow，桌面模块用 fight.hp / show.camera。 */
    public RtModule module(RtObject o, String a, String b) {
        RtModule m = firstModule(o, a, null);
        return m != null ? m : firstModule(o, b, null);
    }

    public RtAsset assetByName(String name) {
        if (name == null || name.isEmpty()) {
            return null;
        }
        RtAsset a = assetsByName.get(name);
        if (a != null) {
            return a;
        }
        for (RtAsset v : assets.values()) {
            if (v.name.equalsIgnoreCase(name)) {
                return v;
            }
        }
        return null;
    }

    public RtAsset assetById(String id) {
        return id == null || id.isEmpty() ? null : assets.get(id);
    }

    // ---------------- Json 小工具 ----------------

    private static String readText(File f) throws IOException {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    private static RtAsset readAsset(JsonObject a) {
        RtAsset ra = new RtAsset();
        ra.id = str(a, "id", "");
        ra.name = str(a, "name", "");
        ra.kind = str(a, "kind", "IMAGE");
        ra.path = str(a, "path", "");
        ra.head = str(a, "head", "");
        ra.frames = Math.max(1, num(a, "frames", 1));
        ra.cols = Math.max(1, num(a, "cols", 1));
        ra.rows = Math.max(1, num(a, "rows", 1));
        ra.cellW = num(a, "cellW", 0);
        ra.cellH = num(a, "cellH", 0);
        ra.zeroBased = a.has("zeroBased") && a.get("zeroBased").getAsBoolean();
        return ra;
    }

    private static String str(JsonObject o, String k, String def) {
        JsonElement e = o.get(k);
        return e == null || e.isJsonNull() ? def : e.getAsString();
    }

    private static int num(JsonObject o, String k, int def) {
        JsonElement e = o.get(k);
        try {
            return e == null || e.isJsonNull() ? def : e.getAsInt();
        } catch (Exception ex) {
            return def;
        }
    }

    private static float num(JsonObject o, String k, float def) {
        JsonElement e = o.get(k);
        try {
            return e == null || e.isJsonNull() ? def : e.getAsFloat();
        } catch (Exception ex) {
            return def;
        }
    }

    private static JsonArray arr(JsonObject o, String k) {
        JsonElement e = o.get(k);
        return e != null && e.isJsonArray() ? e.getAsJsonArray() : new JsonArray();
    }

    private static JsonObject obj(JsonObject o, String k) {
        JsonElement e = o.get(k);
        return e != null && e.isJsonObject() ? e.getAsJsonObject() : new JsonObject();
    }
}
