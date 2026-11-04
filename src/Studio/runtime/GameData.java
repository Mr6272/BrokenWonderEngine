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
    /**
     * UI 场景表（{@code boot.uiScenes[]}）。
     *
     * <p>空表 = 没有界面层，行为与改动前完全一致 —— 这是「旧 Build 必须还能跑」的硬保证。
     * 有内容时运行时会在世界画面之上按设计分辨率铺一张界面。
     */
    public final List<UiSceneRef> uiScenes = new ArrayList<>();
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

    /** 一张 UI 场景的引用（boot.json 的 {@code uiScenes[]} 一条）。 */
    public static final class UiSceneRef {
        public String name = "";
        public String file = "";
        /** 设计分辨率宽（像素）。 */
        public int designW = 1280;
        /** 设计分辨率高（像素）。 */
        public int designH = 720;
        /** 图层数量（只用于日志/诊断；实际排序仍按对象上的 layer 下标）。 */
        public int layers = 0;
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

        /**
         * 把另一个模块的参数合并进来（<b>已有的键不覆盖</b>）。
         *
         * <p>用途：网格模块被拆成 grid.board / grid.tile / grid.reveal / grid.flag 四个，
         * 但运行时只有一个棋盘对象，需要把这几个模块的参数汇成一份来读。
         * 保持「不覆盖」语义，避免后面的模块意外改掉前面已声明的值。
         */
        public void mergeParams(RtModule other) {
            if (other == null) {
                return;
            }
            for (Map.Entry<String, String> e : other.params.entrySet()) {
                if (!params.containsKey(e.getKey())) {
                    params.put(e.getKey(), e.getValue());
                }
            }
        }
    }

    public static final class RtScene {
        public int width = 60;
        public int height = 40;
        public int tileSize = 32;
        public final List<RtObject> objects = new ArrayList<>();
        /**
         * UI 场景标记：{@code true} = 这张「场景」其实是屏幕空间的界面画布，不是地图。
         *
         * <p>导出契约（web/tools/package-bwe.mjs）：
         * <ul>
         *   <li>UI 场景写在 {@code boot.uiScenes[]}，世界场景写在 {@code boot.scenes[]}；</li>
         *   <li>UI 场景的 scene json 顶层带 {@code ui:true / designW / designH}；</li>
         *   <li>为了让老的 {@code mapWidth = width × tileSize} 公式直接给出设计分辨率，
         *       UI 场景导出时 {@code tileSize = 1}、{@code width = designW}。</li>
         * </ul>
         * 缺省 false = 旧 Build 完全照老路走（没有界面层）。
         */
        public boolean ui = false;
        /** UI 场景设计分辨率宽（像素）。非 UI 场景为 0。 */
        public int designW = 0;
        /** UI 场景设计分辨率高（像素）。非 UI 场景为 0。 */
        public int designH = 0;
        /**
         * 场景图层（编辑器 scene.layers，导出时写在 scene_*.json 顶层 "layers"）。
         *
         * <p>之前<b>完全没有解析</b>：绘制只用对象的 {@code layer} 整数下标，
         * 所以 {@code bwe.world.layers()} 只能返回空数组（Phase 2 占位），
         * 图层的名字 / 可见性对脚本不可见。
         * 现在解析出来，供 {@code bwe.world.layers()} 与「按图层名隐藏」用。
         */
        public final List<RtLayer> layers = new ArrayList<>();

        // ---------- 开放世界新增段（全部可选；旧 Build 没有 → 空表，行为与今天一致） ----------

        /**
         * 建筑 / 楼层 / 房间定义（{@code bwe.spatial} 的数据源）。
         *
         * <p><b>兼容性</b>：空表 = 单层平地，{@code bwe.spatial} 的所有查询都返回 null / false，
         * 游戏行为与没有这个功能时<b>完全一致</b>。这是「旧工程必须还能跑」的硬保证。
         */
        public final List<RtBuilding> buildings = new ArrayList<>();
        /** 垂直连接（楼梯 / 电梯 / 坡道）。 */
        public final List<RtNavLink> navLinks = new ArrayList<>();
        /** 道路网络（车辆用；行人不走这个）。 */
        public RtRoadNetwork road;

        // ---------- 2D 光照段（契约 docs/_fragments/lighting-contract.md §3.1 / §3.2） ----------

        /**
         * 光照配置（{@code scene_*.json} 顶层 {@code lighting}）。
         *
         * <p><b>null = 没有光照配置</b>，这不是「缺省功能的空对象」，而是<b>旧工程的零回归开关</b>：
         * {@link Lighting#isEnabled()} 直接返回 false、一根 quad 都不画、GL 状态一个字节都不动，
         * 画面与改动前逐像素一致。所以这里刻意用 {@code null} 而不是「默认 enabled=false 的对象」——
         * 后者会让 {@code bwe.light.enabled(true)} 在没有光照数据的工程上「打开」一个空系统。
         */
        public RtLighting lighting;
        /** 烘焙产物引用（{@code scene_*.json} 顶层 {@code lightmap}）。null = 没有烘焙图。 */
        public RtLightmap lightmap;
    }

    /**
     * 光照配置（契约 §3.1 的 {@code LightingModel}，字段名一一对应）。
     *
     * <p>全部缺省值与契约表格一致；解析时任何字段缺失都走这里的缺省，
     * 所以「只写了 {@code {"enabled": true}} 的工程」也能跑。
     */
    public static final class RtLighting {
        /** 总开关。false ⇒ 运行时光照完全不启用（= 白天）。 */
        public boolean enabled = false;
        /** {@code "baked"} | {@code "dynamic"} | {@code "both"}。 */
        public String mode = "both";
        /** 环境光颜色 {@code #rrggbb}。 */
        public String ambientColor = "#3A4A6B";
        /** 环境光强度 0..1。 */
        public float ambientIntensity = 0.35f;
        /** 压暗程度 0..1（0 = 白天，不压暗）。 */
        public float darkness = 0.35f;
        /** 柔化半径（世界像素，0..128）。 */
        public float softness = 16f;
        /** 采样率（纹素 / 世界像素）。 */
        public float texelsPerPixel = 0.25f;
        /** 运行时动态光照重算上限帧率。 */
        public float dynamicFps = 15f;
        /** 运行时动态光源上限。 */
        public int maxDynamicLights = 8;
    }

    /**
     * 烘焙贴图引用（契约 §3.2 的 {@code LightmapRef}）。
     *
     * <p>{@code texW/texH/texelsPerPixel} 是<b>烘焙时的真实值</b>，运行时按它反推纹理坐标，
     * <b>不重算</b> —— 否则尺寸被 2048 上限截断过的工程会整体错位。
     */
    public static final class RtLightmap {
        /** 工程 {@code assets[]} 里的 IMAGE 素材 id（烘焙产物）。 */
        public String assetId = "";
        /** 覆盖矩形左上角世界坐标（契约固定 0,0）。 */
        public float x = 0f;
        public float y = 0f;
        /** 覆盖矩形宽高（世界像素 = 场景矩形）。 */
        public float w = 0f;
        public float h = 0f;
        /** 实际纹素尺寸。 */
        public int texW = 0;
        public int texH = 0;
        /** 实际 {@code sEff}（纹素 / 世界像素）。 */
        public float texelsPerPixel = 0f;
        /** 参与烘焙的光源数（诊断用）。 */
        public int lights = 0;
        /** 烘焙算法版本（{@link LightMap#VERSION}；对不上就不复用这张图）。 */
        public int version = 0;
    }

    /** 一栋建筑：若干楼层 + 出入口。 */
    public static final class RtBuilding {
        public String id = "";
        public String name = "";
        public final List<RtFloor> floors = new ArrayList<>();
        /** 出入口（{@code x,y,r}）：玩家走进来即视为进入本建筑。 */
        public final List<RtEntrance> entrances = new ArrayList<>();
        /** 屋顶可见性规则：{@code "auto"}（默认，玩家进楼就隐藏）/ {@code "always"} / {@code "never"}。 */
        public String roof = "auto";
    }

    /** 一层楼：区域列表 + 显示 z 序。 */
    public static final class RtFloor {
        public String id = "";
        public String name = "";
        /** 楼层序号（0 = 底层，越大越高）。用于「当前层显示、其它层隐藏」。 */
        public int level = 0;
        public final List<RtRoom> rooms = new ArrayList<>();
    }

    /** 一个房间/区域：一块 AABB + 状态。 */
    public static final class RtRoom {
        public String id = "";
        public String name = "";
        /** AABB（世界像素，中心点 + 半宽半高，与对象同一套坐标约定）。 */
        public float x, y, halfW, halfH;
        /** 区域标签（入口/楼梯/电梯/室内/室外…由脚本或编辑器给）。 */
        public final List<String> tags = new ArrayList<>();
        /** 本区域是否参与碰撞（房间本身通常 false，墙才是实体）。 */
        public boolean collides = false;
        /** 本区域是否可导航（false = 不可通行，例如楼板空洞）。 */
        public boolean navigable = true;
        /** 渲染可见性规则覆盖：null = 走楼层规则。 */
        public String visibility;
        /** 到达此区域需要经过的 link（用于「NPC 不能穿楼板」）。 */
        public String viaLink = "";
    }

    /** 建筑出入口。 */
    public static final class RtEntrance {
        public String id = "";
        public float x, y;
        /** 触发半径。 */
        public float radius = 24f;
        /** 通向哪个楼层（默认 0 = 底层）。 */
        public int level = 0;
    }

    /** 垂直连接：楼梯 / 电梯 / 坡道。 */
    public static final class RtNavLink {
        public String id = "";
        /** {@code "stairs"} / {@code "elevator"} / {@code "ramp"} / {@code "jump"}。 */
        public String kind = "stairs";
        /** 两端点（世界像素）。 */
        public float ax, ay, bx, by;
        /** 两端所在楼层序号。 */
        public int aLevel = 0;
        public int bLevel = 1;
        /** 双向（楼梯默认 true，单向跳下 false）。 */
        public boolean bidirectional = true;
        /** 通行耗时（秒）；电梯 > 0，走路楼梯 = 0。 */
        public float travelTime = 0f;
        /** 是否需要交互（电梯按键）。 */
        public boolean requiresInteract = false;
    }

    /** 道路网络：节点 + 路段。 */
    public static final class RtRoadNetwork {
        public final List<RtRoadNode> nodes = new ArrayList<>();
        public final List<RtRoadEdge> edges = new ArrayList<>();
    }

    /** 路网节点（路口 / 途经点 / 站点）。 */
    public static final class RtRoadNode {
        public String id = "";
        public float x, y;
        /** {@code "intersection"} / {@code "waypoint"} / {@code "stop"} / {@code "spawn"}。 */
        public String kind = "waypoint";
    }

    /** 路段（有向或双向）。 */
    public static final class RtRoadEdge {
        public String from = "";
        public String to = "";
        /** 路宽（像素），车辆避障用。 */
        public float width = 48f;
        /** 限速（px/s）。 */
        public float speedLimit = 240f;
        public boolean oneway = false;
    }

    /** 一个场景图层。 */
    public static final class RtLayer {
        public String id = "";
        public String name = "";
        public boolean visible = true;
        public boolean locked = false;
        public int order = 0;
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
        // UI 场景：缺失 = 空表（旧 Build 逐字节兼容）。
        for (JsonElement e : arr(root, "uiScenes")) {
            if (!e.isJsonObject()) {
                continue;
            }
            JsonObject o = e.getAsJsonObject();
            UiSceneRef r = new UiSceneRef();
            r.name = str(o, "name", "");
            r.file = str(o, "file", "");
            r.designW = num(o, "designW", 1280);
            r.designH = num(o, "designH", 720);
            r.layers = num(o, "layers", 0);
            if (!r.file.isEmpty()) {
                g.uiScenes.add(r);
            }
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
        // UI 场景三件套：旧 Build 没有这些字段 → ui=false，走原来的地图路径。
        s.ui = root.has("ui") && root.get("ui").isJsonPrimitive() && root.get("ui").getAsBoolean();
        s.designW = num(root, "designW", 0);
        s.designH = num(root, "designH", 0);
        if (s.ui) {
            // 设计分辨率兜底：导出器保证 tileSize=1、width/height=设计像素，
            // 但万一手工改了 json，这里也用 designW/designH 校正一次，避免 UI 按格子算尺寸。
            if (s.designW > 0) {
                s.width = s.designW;
            }
            if (s.designH > 0) {
                s.height = s.designH;
            }
            s.tileSize = 1;
        }
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
        // 图层表：编辑器导出在 scene_*.json 顶层 "layers"（旧 Build 没有这个字段 → 空表，向后兼容）。
        for (JsonElement e : arr(root, "layers")) {
            if (!e.isJsonObject()) {
                continue;
            }
            JsonObject lo = e.getAsJsonObject();
            RtLayer rl = new RtLayer();
            rl.id = str(lo, "id", "");
            rl.name = str(lo, "name", "");
            rl.visible = !lo.has("visible") || lo.get("visible").getAsBoolean();
            rl.locked = lo.has("locked") && lo.get("locked").getAsBoolean();
            rl.order = num(lo, "order", 0);
            s.layers.add(rl);
        }
        // ---- 开放世界新增段（全部可选；缺省 = 空表 / null，行为与旧 Build 完全一致） ----
        for (JsonElement e : arr(root, "buildings")) {
            if (!e.isJsonObject()) {
                continue;
            }
            s.buildings.add(readBuilding(e.getAsJsonObject()));
        }
        for (JsonElement e : arr(root, "navLinks")) {
            if (!e.isJsonObject()) {
                continue;
            }
            s.navLinks.add(readNavLink(e.getAsJsonObject()));
        }
        if (root.has("roadNetwork") && root.get("roadNetwork").isJsonObject()) {
            s.road = readRoad(root.getAsJsonObject("roadNetwork"));
        }
        // ---- 2D 光照段（可选；缺失 = null = 旧工程零行为变化） ----
        //
        // ⚠ 这里必须判「有没有这个键」，不能写成 readLighting(root) 无条件返回对象：
        //   契约 §3.1 的「lighting 缺失 ⇒ enabled=false，零行为变化」是靠 Lighting 拿到 null
        //   才成立的（否则 bwe.light 会在没有光照数据的工程上「看起来可用」却什么都不画）。
        if (root.has("lighting") && root.get("lighting").isJsonObject()) {
            s.lighting = readLighting(root.getAsJsonObject("lighting"));
        }
        if (root.has("lightmap") && root.get("lightmap").isJsonObject()) {
            s.lightmap = readLightmap(root.getAsJsonObject("lightmap"));
        }
        return s;
    }

    /**
     * 读光照配置（契约 §3.1）。任何字段缺失/类型不对都走 {@link RtLighting} 的缺省值。
     *
     * <p>{@code mode} 只接受 {@code baked/dynamic/both}，其它值一律按缺省 {@code both} ——
     * 运行时不该因为编辑器写了错字就整层不画（那是最难排查的「灯不亮了」）。
     */
    private static RtLighting readLighting(JsonObject o) {
        RtLighting l = new RtLighting();
        l.enabled = o.has("enabled") && o.get("enabled").isJsonPrimitive()
                && o.get("enabled").getAsBoolean();
        String m = str(o, "mode", "both").trim().toLowerCase(java.util.Locale.ROOT);
        if ("baked".equals(m) || "dynamic".equals(m) || "both".equals(m)) {
            l.mode = m;
        }
        String color = str(o, "ambientColor", "#3A4A6B").trim();
        if (color.startsWith("#") && (color.length() == 4 || color.length() == 7)) {
            l.ambientColor = color;
        }
        // 数值统一走 float 重载：写 num(o,"darkness",0.35) 会命中 int 重载、getAsInt() 把 0.35 截成 0
        // （GameData.loadScene 里已有同类注释，是这个项目踩过的坑）。
        l.ambientIntensity = clamp01(num(o, "ambientIntensity", 0.35f));
        l.darkness = clamp01(num(o, "darkness", 0.35f));
        l.softness = Math.max(0f, Math.min(128f, num(o, "softness", 16f)));
        l.texelsPerPixel = Math.max(0.01f, Math.min(4f, num(o, "texelsPerPixel", 0.25f)));
        l.dynamicFps = Math.max(1f, Math.min(240f, num(o, "dynamicFps", 15f)));
        l.maxDynamicLights = Math.max(0, Math.min(64, num(o, "maxDynamicLights", 8)));
        return l;
    }

    /** 读烘焙贴图引用（契约 §3.2）。任何字段缺失都走安全缺省。 */
    private static RtLightmap readLightmap(JsonObject o) {
        RtLightmap m = new RtLightmap();
        m.assetId = str(o, "assetId", "");
        m.x = num(o, "x", 0f);
        m.y = num(o, "y", 0f);
        m.w = num(o, "w", 0f);
        m.h = num(o, "h", 0f);
        m.texW = Math.max(0, num(o, "texW", 0));
        m.texH = Math.max(0, num(o, "texH", 0));
        m.texelsPerPixel = num(o, "texelsPerPixel", 0f);
        m.lights = Math.max(0, num(o, "lights", 0));
        m.version = num(o, "version", 0);
        return m;
    }

    private static float clamp01(float v) {
        if (!(v > 0f)) {
            return 0f;      // 含 NaN / 负数
        }
        return v > 1f ? 1f : v;
    }

    /** 读一栋建筑（含楼层/房间/出入口）。任何字段缺失都走安全缺省。 */
    private static RtBuilding readBuilding(JsonObject o) {
        RtBuilding b = new RtBuilding();
        b.id = str(o, "id", "");
        b.name = str(o, "name", b.id);
        b.roof = str(o, "roof", "auto");
        for (JsonElement fe : arr(o, "floors")) {
            if (!fe.isJsonObject()) {
                continue;
            }
            JsonObject fo = fe.getAsJsonObject();
            RtFloor f = new RtFloor();
            f.id = str(fo, "id", "");
            f.name = str(fo, "name", f.id);
            f.level = num(fo, "level", 0);
            for (JsonElement re : arr(fo, "rooms")) {
                if (!re.isJsonObject()) {
                    continue;
                }
                JsonObject ro = re.getAsJsonObject();
                RtRoom r = new RtRoom();
                r.id = str(ro, "id", "");
                r.name = str(ro, "name", r.id);
                r.x = num(ro, "x", 0f);
                r.y = num(ro, "y", 0f);
                r.halfW = num(ro, "halfW", 0f);
                r.halfH = num(ro, "halfH", 0f);
                r.collides = ro.has("collides") && ro.get("collides").getAsBoolean();
                r.navigable = !ro.has("navigable") || ro.get("navigable").getAsBoolean();
                r.visibility = str(ro, "visibility", "");
                r.viaLink = str(ro, "viaLink", "");
                for (JsonElement te : arr(ro, "tags")) {
                    r.tags.add(te.getAsString());
                }
                f.rooms.add(r);
            }
            b.floors.add(f);
        }
        for (JsonElement ee : arr(o, "entrances")) {
            if (!ee.isJsonObject()) {
                continue;
            }
            JsonObject eo = ee.getAsJsonObject();
            RtEntrance en = new RtEntrance();
            en.id = str(eo, "id", "");
            en.x = num(eo, "x", 0f);
            en.y = num(eo, "y", 0f);
            en.radius = num(eo, "radius", 24f);
            en.level = num(eo, "level", 0);
            b.entrances.add(en);
        }
        return b;
    }

    private static RtNavLink readNavLink(JsonObject o) {
        RtNavLink l = new RtNavLink();
        l.id = str(o, "id", "");
        l.kind = str(o, "kind", "stairs");
        l.ax = num(o, "ax", 0f);
        l.ay = num(o, "ay", 0f);
        l.bx = num(o, "bx", 0f);
        l.by = num(o, "by", 0f);
        l.aLevel = num(o, "aLevel", 0);
        l.bLevel = num(o, "bLevel", 1);
        l.bidirectional = !o.has("bidirectional") || o.get("bidirectional").getAsBoolean();
        l.travelTime = num(o, "travelTime", 0f);
        l.requiresInteract = o.has("requiresInteract") && o.get("requiresInteract").getAsBoolean();
        // 兼容：允许用 from/to 端点坐标形式 {from:{x,y}, to:{x,y}}
        if (o.has("from") && o.get("from").isJsonObject()) {
            JsonObject f = o.getAsJsonObject("from");
            l.ax = num(f, "x", l.ax);
            l.ay = num(f, "y", l.ay);
        }
        if (o.has("to") && o.get("to").isJsonObject()) {
            JsonObject t = o.getAsJsonObject("to");
            l.bx = num(t, "x", l.bx);
            l.by = num(t, "y", l.by);
        }
        return l;
    }

    private static RtRoadNetwork readRoad(JsonObject o) {
        RtRoadNetwork net = new RtRoadNetwork();
        for (JsonElement ne : arr(o, "nodes")) {
            if (!ne.isJsonObject()) {
                continue;
            }
            JsonObject no = ne.getAsJsonObject();
            RtRoadNode n = new RtRoadNode();
            n.id = str(no, "id", "");
            n.x = num(no, "x", 0f);
            n.y = num(no, "y", 0f);
            n.kind = str(no, "kind", "waypoint");
            net.nodes.add(n);
        }
        for (JsonElement ee : arr(o, "edges")) {
            if (!ee.isJsonObject()) {
                continue;
            }
            JsonObject eo = ee.getAsJsonObject();
            RtRoadEdge e = new RtRoadEdge();
            e.from = str(eo, "from", "");
            e.to = str(eo, "to", "");
            e.width = num(eo, "width", 48f);
            e.speedLimit = num(eo, "speedLimit", 240f);
            e.oneway = eo.has("oneway") && eo.get("oneway").getAsBoolean();
            net.edges.add(e);
        }
        return net;
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
