package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 涌现式模拟基底之一：<b>材质 + 多通道格子场</b>（契约见 {@code docs/scripting-api.md} §2.11.1 / §2.11.2）。
 *
 * <p>这一层的设计目标：让「火/水/油/烟」不是写死的特例，而是**材质属性 + 场规则**自然组合出来的结果。
 * 例：grass.flammable=0.8 烧得快；wood 烧穿后该格变成可通行；water 扑灭相邻 fire 并把材质标记 wet；
 * oil.flammable=1.0 让火势突然加速。脚本只调用 {@code bwe.field.emit/sample}，不关心蔓延细节。
 *
 * <p>对外命名空间（在 {@link #install(ScriptApi)} 里挂到 {@code bwe.material} 与 {@code bwe.field}）：
 * <pre>
 *   bwe.material.define(name, props) / get(name) / tags(name)
 *   bwe.material.of(cx, cy) / setTile(cx, cy, name|null)
 *   bwe.material.ofEntity(e) / setEntity(e, name)
 *   bwe.field.emit(ch, cx, cy, intensity) / sample(ch, cx, cy) / clear(ch)
 *   bwe.field.tickRate(sec) / channel(name).max(v) / wind(dx, dy)
 *   bwe.field.on("ignite"|"extinguish"|"burned", fn)
 *   bwe.field.burning() -> [{cx,cy,intensity,material}]
 * </pre>
 *
 * <p>实现要点：
 * <ul>
 *   <li>格子数据一律扁平数组（{@code float[] cells, String[] mats}），避免每 tick 分配对象；</li>
 *   <li>固定 tickRate（默认 0.1s）与帧率解耦；只在「活跃格 + 其邻居」上迭代，大地图不退化；</li>
 *   <li>用 {@code ScriptEngine.addSimHook(...)} 注册每帧模拟；Rhino 调用在 update 线程内自然可用；</li>
 *   <li>TILE 格烧尽时同步从 {@code ScriptWorld} 的 tilemap 阻挡里移除（烧穿墙 = 开出一条路）；</li>
 *   <li>需要随机时用固定种子的散列噪声（{@link #setSeed(long)} 可统一到 {@code bwe.seed}），保证同种子同结果。</li>
 * </ul>
 *
 * <p><b>给 AI/感知子系统的只读入口</b>（同包直接调用，不需要 new 任何对象）：
 * <pre>
 *   ScriptFields.smokeAt(cx, cy)          // 烟雾通道强度 0..1（canSee 判定用）
 *   ScriptFields.channelAt("poison", cx, cy)
 *   ScriptFields.materialAt(cx, cy)       // 该格材质名（null = 空）
 *   ScriptFields.flammabilityAt(cx, cy)   // 含 wet 折减后的有效易燃度
 *   ScriptFields.wetAt(cx, cy)            // 湿润度 0..1
 *   ScriptFields.burnedCount() / lastTickMs()
 * </pre>
 *
 * <p><b>本文件由「材质/场」负责人独占</b>；其它两个子系统不修改本文件。
 */
final class ScriptFields {

    private ScriptFields() {
    }

    // ---------------- 静态入口（供 AI / 自检 / 测试） ----------------

    /** 默认固定种子：同种子 + 同输入 ⇒ 同结果（§2.11.2）。 */
    private static final long DEFAULT_SEED = 0x5EE0F1E1DL;

    /** 下一次 {@link #install} 使用的种子（{@code bwe.seed.set(n)} 若由 AI 侧提供，可转调这里）。 */
    private static volatile long pendingSeed = DEFAULT_SEED;

    /** 最近一次 install 的模拟实例（单进程一个游戏世界；测试里多运行时以最后一个为准）。 */
    private static volatile Sim current;

    /** 统一确定性随机源：AI 侧实现 {@code bwe.seed.set(n)} 时调用这里即可与场同步。 */
    static void setSeed(long seed) {
        pendingSeed = seed;
    }

    static long seed() {
        return pendingSeed;
    }

    /** 烟雾遮挡入口：给 {@code bwe.sense.canSee} 用（0 = 通视，1 = 浓烟）。 */
    static float smokeAt(int cx, int cy) {
        Sim s = current;
        return s == null ? 0f : s.channelAt("smoke", cx, cy);
    }

    /** 任意通道的格子强度（AI 侧若要用 poison 致盲等，可读这里）。 */
    static float channelAt(String channel, int cx, int cy) {
        Sim s = current;
        return s == null ? 0f : s.channelAt(channel, cx, cy);
    }

    static String materialAt(int cx, int cy) {
        Sim s = current;
        return s == null ? null : s.materialNameAt(cx, cy);
    }

    static float wetAt(int cx, int cy) {
        Sim s = current;
        return s == null ? 0f : s.wetAtCell(cx, cy);
    }

    /** 有效易燃度（材质 flammable × 湿润折减），不受当前是否在燃烧影响。 */
    static float flammabilityAt(int cx, int cy) {
        Sim s = current;
        return s == null ? 0f : s.flammabilityAtCell(cx, cy);
    }

    static int burnedCount() {
        Sim s = current;
        return s == null ? 0 : s.burnedTotal;
    }

    static double lastTickMs() {
        Sim s = current;
        return s == null ? 0d : s.lastTickMs;
    }

    // ---------------- 安装 ----------------

    /** 注册 {@code bwe.material} / {@code bwe.field} 并挂上每帧模拟。 */
    static void install(ScriptApi api) {
        Sim sim = new Sim(api, pendingSeed);
        sim.bindJs();
        current = sim;
        api.engineRef().addSimHook(sim);
    }

    // ---------------- 材质表 ----------------

    private static final String[] NO_TAGS = new String[0];

    private static final class Material {
        final String name;
        float flammable;
        float burnTime;
        boolean conductive;
        boolean wet;
        float hardness = 1f;
        float density = 1f;
        String[] tags = NO_TAGS;
        /** 是否是「水」（水材质永久压火 + 不可燃 + 火不能蔓延进去）。由 name/tags 推导，缓存避免热路径判断。 */
        boolean waterish;

        Material(String name) {
            this.name = name;
        }

        void refreshDerived() {
            boolean w = "water".equalsIgnoreCase(name);
            if (!w) {
                for (int i = 0; i < tags.length; i++) {
                    if ("water".equalsIgnoreCase(tags[i])) {
                        w = true;
                        break;
                    }
                }
            }
            waterish = w;
        }
    }

    /** 素材名/对象名 → 内置材质的别名表（先长后短，避免「毒草」被「草」抢走）。 */
    private static final String[] NAME_ALIASES = {
            "poisonplant", "poisonPlant", "poison", "poisonPlant", "毒", "poisonPlant",
            "glass", "glass", "玻璃", "glass",
            "metal", "metal", "iron", "metal", "steel", "metal", "金属", "metal",
            "铁", "metal", "钢", "metal", "铜", "metal",
            "ice", "ice", "冰", "ice",
            "water", "water", "水", "water",
            "oil", "oil", "油", "oil",
            "cloth", "cloth", "fabric", "cloth", "布", "cloth", "丝绸", "cloth", "绸", "cloth",
            "wood", "wood", "plank", "wood", "log", "wood", "crate", "wood", "木", "wood", "箱", "wood",
            "grass", "grass", "moss", "grass", "草", "grass",
            "stone", "stone", "rock", "stone", "wall", "stone", "brick", "stone",
            "石", "stone", "墙", "stone", "岩", "stone", "砖", "stone"
    };

    /** material 模块可能用的参数名。 */
    private static final String[] MAT_KEYS = {
            "material", "mat", "材质", "name", "value", "type", "类型"
    };

    // ---------------- 模拟实例 ----------------

    private static final class Sim implements ScriptEngine.SimHook {

        private static final boolean DEBUG = System.getProperty("bwe.fields.debug") != null;

        private void dbg(String msg) {
            if (DEBUG) {
                System.err.println("[fields] " + msg);
            }
        }

        // ---- 规则常数（全部可调；验收场景用的就是这一组） ----
        /** 火焰衰减速度（每秒）。 */
        private static final float FIRE_DECAY = 0.9f;
        /** 火势达到该值才点燃材质。 */
        private static final float IGNITE_THRESHOLD = 0.12f;
        /** 燃烧中维持的最小火势（保证材质能烧够 burnTime）。 */
        private static final float HOLD_FIRE = 0.55f;
        /** 蔓延概率系数：p = flammable × intensity × 本系数 × dt。 */
        private static final float SPREAD_RATE = 5.5f;
        /** 火每秒产生的烟。 */
        private static final float SMOKE_PER_FIRE = 0.6f;
        /** 烟自然衰减（每秒）。 */
        private static final float SMOKE_DECAY = 0.35f;
        /** 湿润恢复时间（秒）。 */
        private static final float WET_RECOVER = 6f;
        /** 水通道（泼出去的水）蒸发/渗干速度（每秒）；水材质格子不受影响。 */
        private static final float WATER_DECAY = 0.12f;
        /** 水通道要「浇灭相邻的活火」所需的最小强度（低于它只能打湿，不能压火）。 */
        private static final float WATER_DOUSE_MIN = 0.55f;
        /** 每浇灭一个相邻格消耗的水量（保证一桶水只能灭有限几处火）。 */
        private static final float WATER_DOUSE_COST = 0.22f;
        /** 结构化刷新（TILE/PROP 变动后重建材质表）的最小间隔（秒），避免大量烧毁时每帧全量扫描。 */
        private static final float REFRESH_INTERVAL = 0.5f;
        /** 数值视为 0 的门限。 */
        private static final float EPS = 0.005f;
        /**
         * 烟雾格的「值得继续遍历」门限：必须与 {@link #processCell} 里 smoke 分支的
         * {@code sv > SMOKE_WORK_MIN} 完全一致，否则会留下一批永远空转的活跃格。
         */
        private static final float SMOKE_WORK_MIN = 0.01f;
        /** 实体被火烧到的伤害倍率（每秒 × 火势）。 */
        private static final float DAMAGE_RATE = 22f;

        // ---- 事件类型 ----
        private static final byte EV_IGNITE = 0;
        private static final byte EV_EXT_WATER = 1;
        private static final byte EV_EXT_DECAY = 2;
        private static final byte EV_EXT_CLEAR = 3;

        private final ScriptApi api;
        private final ScriptEngine engine;
        private final TopDownRuntime host;
        private final ScriptWorld world;
        private final int cols;
        private final int rows;
        private final long seed;

        // ---- 材质表 ----
        private final Map<String, Material> materials = new HashMap<String, Material>();
        private final Map<String, Material> matIndex = new HashMap<String, Material>();

        // ---- 格子数据（扁平数组，预分配；每 tick 不分配） ----
        private final String[] mats;
        private final Material[] matCache;
        private final boolean[] matFixed;
        private final float[] wet;
        private final TopDownRuntime.Actor[] tileActor;

        // ---- 通道 ----
        private final float[] fireV;
        private final float[] waterV;
        private final float[] smokeV;
        private final Map<String, Chan> channels = new HashMap<String, Chan>();
        private final List<Chan> customs = new ArrayList<Chan>();
        private Chan smokeChan;

        // ---- 燃烧进度 ----
        private final boolean[] burning;
        private final float[] burnT;
        private final float[] burnLimit;
        private final String[] burnName;
        private final TopDownRuntime.Actor[] burnActor;

        // ---- 实体覆盖层（非 TILE 实体站在格子上时的材质） ----
        private final Material[] ovMat;
        private final TopDownRuntime.Actor[] ovActor;
        private final int[] ovTouched;
        private int ovTouchedN;
        private final List<TopDownRuntime.Actor> props = new ArrayList<TopDownRuntime.Actor>();
        private final List<Material> propMats = new ArrayList<Material>();
        private final IdentityHashMap<TopDownRuntime.Actor, String> entityMats =
                new IdentityHashMap<TopDownRuntime.Actor, String>();
        private int lastActorCount = -1;
        /** 结构化刷新冷却（秒）：见 tick() 里的节流说明。 */
        private float refreshDelay = 0f;

        // ---- 活跃格 ----
        private final int[] active;
        private final boolean[] activeFlag;
        private int activeN;

        // ---- 事件队列（复用数组，容量足够所有活跃格） ----
        private final int[] qCell;
        private final byte[] qType;
        private int qN;
        private final int[] burnQ;
        private int burnQN;

        private final Map<String, List<Handler>> evHandlers = new HashMap<String, List<Handler>>();

        private static final class Handler {
            final Function fn;
            final Scriptable scope;

            Handler(Function fn) {
                this.fn = fn;
                this.scope = fn.getParentScope();
            }
        }

        /** 按函数引用摘掉订阅（bwe.field.on 返回的取消函数用）。 */
        private static void removeHandler(List<Handler> list, Function fn) {
            if (list == null || fn == null) {
                return;
            }
            for (int i = list.size() - 1; i >= 0; i--) {
                if (list.get(i).fn == fn) {
                    list.remove(i);
                }
            }
        }

        // ---- 配置 / 状态 ----
        private float tickRate = 0.1f;
        private float acc;
        private float windX;
        private float windY;
        private long tickNo;
        double lastTickMs;
        int burnedTotal;
        private final List<String> warned = new ArrayList<String>();

        Sim(ScriptApi api, long seed) {
            this.api = api;
            this.engine = api.engineRef();
            this.host = api.hostRef();
            this.world = engine.world;
            this.cols = Math.max(1, world.cols);
            this.rows = Math.max(1, world.rows);
            this.seed = seed;
            int n = cols * rows;

            this.mats = new String[n];
            this.matCache = new Material[n];
            this.matFixed = new boolean[n];
            this.wet = new float[n];
            this.tileActor = new TopDownRuntime.Actor[n];

            this.fireV = new float[n];
            this.waterV = new float[n];
            this.smokeV = new float[n];

            this.burning = new boolean[n];
            this.burnT = new float[n];
            this.burnLimit = new float[n];
            this.burnName = new String[n];
            this.burnActor = new TopDownRuntime.Actor[n];

            this.ovMat = new Material[n];
            this.ovActor = new TopDownRuntime.Actor[n];
            this.ovTouched = new int[n];

            this.active = new int[n];
            this.activeFlag = new boolean[n];

            int cap = n * 4 + 16;
            this.qCell = new int[cap];
            this.qType = new byte[cap];
            this.burnQ = new int[n];

            addBuiltins();
            this.channels.put("fire", new Chan("fire", fireV, 1f));
            this.channels.put("water", new Chan("water", waterV, 1f));
            this.smokeChan = new Chan("smoke", smokeV, 1f);
            this.channels.put("smoke", smokeChan);
            refreshStructure();
        }

        private static final class Chan {
            final String name;
            final float[] v;
            float max;
            float decay;

            Chan(String name, float[] v, float max) {
                this.name = name;
                this.v = v;
                this.max = max;
            }
        }

        // ---------------- 内置材质 ----------------

        private void addBuiltins() {
            Material stone = new Material("stone");
            stone.hardness = 8f;
            stone.density = 3f;
            stone.tags = new String[]{"mineral", "wall"};
            add(stone);

            Material wood = new Material("wood");
            wood.flammable = 0.6f;
            wood.burnTime = 3.5f;
            wood.hardness = 3f;
            wood.density = 1f;
            wood.tags = new String[]{"plant", "wood", "solid"};
            add(wood);

            Material grass = new Material("grass");
            grass.flammable = 0.8f;
            grass.burnTime = 1.2f;
            grass.hardness = 1f;
            grass.density = 0.6f;
            grass.tags = new String[]{"plant", "ground"};
            add(grass);

            Material oil = new Material("oil");
            oil.flammable = 1f;
            oil.burnTime = 2.5f;
            oil.hardness = 0.5f;
            oil.density = 0.9f;
            oil.tags = new String[]{"fuel", "liquid"};
            add(oil);

            Material cloth = new Material("cloth");
            cloth.flammable = 0.9f;
            cloth.burnTime = 2f;
            cloth.hardness = 0.5f;
            cloth.density = 0.5f;
            cloth.tags = new String[]{"fabric"};
            add(cloth);

            Material metal = new Material("metal");
            metal.conductive = true;
            metal.hardness = 9f;
            metal.density = 7f;
            metal.tags = new String[]{"metal", "conductive"};
            add(metal);

            Material water = new Material("water");
            water.conductive = true;
            water.hardness = 0f;
            water.density = 1f;
            water.tags = new String[]{"liquid", "water"};
            add(water);

            Material ice = new Material("ice");
            ice.hardness = 2f;
            ice.density = 0.9f;
            ice.tags = new String[]{"ice", "cold"};
            add(ice);

            Material glass = new Material("glass");
            glass.hardness = 1.5f;
            glass.density = 2.5f;
            glass.tags = new String[]{"glass", "fragile"};
            add(glass);

            Material poison = new Material("poisonPlant");
            poison.flammable = 0.7f;
            poison.burnTime = 2.5f;
            poison.hardness = 1f;
            poison.density = 0.7f;
            poison.tags = new String[]{"plant", "poison"};
            add(poison);
        }

        private void add(Material m) {
            m.refreshDerived();
            materials.put(m.name, m);
            matIndex.put(m.name.toLowerCase(Locale.ROOT), m);
        }

        /** 水材质（永久水源 / 不可燃 / 火不能蔓延进去）。 */
        private boolean isWaterMaterial(Material m) {
            return m != null && m.waterish;
        }

        /** 格子 8 邻域里是否有水材质（河/水渠）——泡透的燃料不会被点着。 */
        private boolean adjacentToWaterMaterial(int idx) {
            int cx = idx % cols;
            int cy = idx / cols;
            for (int dy = -1; dy <= 1; dy++) {
                int ny = cy + dy;
                if (ny < 0 || ny >= rows) {
                    continue;
                }
                int base = ny * cols;
                for (int dx = -1; dx <= 1; dx++) {
                    int nx = cx + dx;
                    if (nx < 0 || nx >= cols) {
                        continue;
                    }
                    int n = base + nx;
                    Material m = matCache[n];
                    if (m == null) {
                        m = ovMat[n];
                    }
                    if (m != null && m.waterish) {
                        return true;
                    }
                }
            }
            return false;
        }

        private Material ensureMaterial(String rawName) {
            if (rawName == null) {
                return materials.get("stone");
            }
            String key = rawName.trim().toLowerCase(Locale.ROOT);
            if (key.isEmpty()) {
                return materials.get("stone");
            }
            Material m = matIndex.get(key);
            if (m != null) {
                return m;
            }
            m = new Material(rawName.trim());
            add(m);
            warnOnce("未定义材质「" + rawName + "」按默认（不燃、硬度 1）处理");
            return m;
        }

        /** 脚本 define 时静默创建（不告警）。 */
        private Material createMaterial(String rawName) {
            String key = rawName.trim().toLowerCase(Locale.ROOT);
            Material m = matIndex.get(key);
            if (m != null) {
                return m;
            }
            m = new Material(rawName.trim());
            add(m);
            return m;
        }

        private Material materialByName(String rawName) {
            if (rawName == null) {
                return null;
            }
            String key = rawName.trim().toLowerCase(Locale.ROOT);
            if (key.isEmpty()) {
                return null;
            }
            return matIndex.get(key);
        }

        private String matchMaterialName(String raw) {
            if (raw == null) {
                return null;
            }
            String s = raw.trim().toLowerCase(Locale.ROOT);
            if (s.isEmpty()) {
                return null;
            }
            Material m = matIndex.get(s);
            if (m != null) {
                return m.name;
            }
            for (int i = 0; i + 1 < NAME_ALIASES.length; i += 2) {
                if (s.contains(NAME_ALIASES[i])) {
                    return NAME_ALIASES[i + 1];
                }
            }
            return null;
        }

        private void warnOnce(String msg) {
            String key = msg.length() > 160 ? msg.substring(0, 160) : msg;
            for (int i = 0; i < warned.size(); i++) {
                if (warned.get(i).equals(key)) {
                    return;
                }
            }
            if (warned.size() < 32) {
                warned.add(key);
            }
            host.scriptLog("[材质/场] " + msg);
        }

        // ---------------- 结构刷新（实体/瓦片变化时） ----------------

        private void refreshStructure() {
            List<TopDownRuntime.Actor> actors = host.actors;
            int n = actors.size();
            lastActorCount = n;
            props.clear();
            propMats.clear();
            for (int i = 0; i < n; i++) {
                TopDownRuntime.Actor a = actors.get(i);
                if (a == null || a.dead || a.o == null) {
                    continue;
                }
                int cx = world.toCellX(a.x);
                int cy = world.toCellY(a.y);
                boolean in = world.inBoundsCell(cx, cy);
                Material m = resolveActorMaterial(a);
                if ("TILE".equalsIgnoreCase(a.o.kind)) {
                    if (!in) {
                        continue;
                    }
                    int idx = cy * cols + cx;
                    if (!matFixed[idx]) {
                        if (DEBUG && idx == 246) {
                            dbg("refreshStructure restore idx=246 mats=" + mats[idx] + " -> " + m.name
                                    + " actor=" + a.o.name);
                            dbg("   stack: " + stack());
                        }
                        mats[idx] = m.name;
                        matCache[idx] = m;
                        if (m.wet && wet[idx] <= 0f) {
                            wet[idx] = 1f;
                        }
                    }
                    tileActor[idx] = a;
                } else {
                    props.add(a);
                    propMats.add(m);
                }
            }
        }

        /** 每 tick 重建实体覆盖层（实体可能移动，数量通常很少）。 */
        private void rebuildOverlay() {
            for (int i = 0; i < ovTouchedN; i++) {
                int idx = ovTouched[i];
                ovMat[idx] = null;
                ovActor[idx] = null;
            }
            ovTouchedN = 0;
            for (int i = 0; i < props.size(); i++) {
                TopDownRuntime.Actor a = props.get(i);
                if (a == null || a.dead || a.o == null) {
                    continue;
                }
                int cx = world.toCellX(a.x);
                int cy = world.toCellY(a.y);
                if (!world.inBoundsCell(cx, cy)) {
                    continue;
                }
                int idx = cy * cols + cx;
                ovMat[idx] = propMats.get(i);
                ovActor[idx] = a;
                if (ovTouchedN < ovTouched.length) {
                    ovTouched[ovTouchedN++] = idx;
                }
            }
        }

        private Material resolveActorMaterial(TopDownRuntime.Actor a) {
            String ov = entityMats.get(a);
            if (ov != null) {
                return ensureMaterial(ov);
            }
            String name = actorMaterialName(a);
            if (name == null) {
                name = "stone"; // 契约：TILE 默认 stone，其它实体同样兜底 stone（不燃，安全）
            }
            return ensureMaterial(name);
        }

        private String actorMaterialName(TopDownRuntime.Actor a) {
            if (a == null || a.o == null) {
                return null;
            }
            // 1) material / 材质 模块的参数
            for (int i = 0; i < a.o.modules.size(); i++) {
                GameData.RtModule m = a.o.modules.get(i);
                if (m == null) {
                    continue;
                }
                String def = m.def == null ? "" : m.def.toLowerCase(Locale.ROOT);
                if (def.contains("material") || def.contains("材质")) {
                    for (int k = 0; k < MAT_KEYS.length; k++) {
                        String hit = matchMaterialName(m.params.get(MAT_KEYS[k]));
                        if (hit != null) {
                            return hit;
                        }
                    }
                    for (String v : m.params.values()) {
                        String hit = matchMaterialName(v);
                        if (hit != null) {
                            return hit;
                        }
                    }
                }
            }
            // 2) 对象 props.material
            String hit = matchMaterialName(a.o.props.get("material"));
            if (hit != null) {
                return hit;
            }
            // 3) 任意模块里叫 material 的参数（兼容编辑器自建模块）
            for (int i = 0; i < a.o.modules.size(); i++) {
                GameData.RtModule m = a.o.modules.get(i);
                if (m == null) {
                    continue;
                }
                for (int k = 0; k < MAT_KEYS.length; k++) {
                    String hit2 = matchMaterialName(m.params.get(MAT_KEYS[k]));
                    if (hit2 != null) {
                        return hit2;
                    }
                }
            }
            // 4) 素材名 → 对象名
            hit = matchMaterialName(a.o.assetName);
            if (hit != null) {
                return hit;
            }
            return matchMaterialName(a.o.name);
        }

        // ---------------- 每帧 ----------------

        @Override
        public void tick(float dt) {
            long t0 = System.nanoTime();
            try {
                // 结构化刷新节流：烧穿时每销毁一个 TILE 都会改变 actors 数量，
                // 若每次全量重建材质表，大地图上会周期性出现 3~5ms 尖峰；0.5s 一次足够跟上实体增删。
                refreshDelay -= dt;
                int actorCount = host.actors.size();
                if (actorCount > lastActorCount) {
                    // 只处理「新增实体」：烧穿销毁不需要重建（材质/阻挡已在 resolveBurns 里清掉），
                    // 否则大规模烧毁时每 0.5s 仍会有一次全量扫描尖峰。
                    refreshStructure();
                    refreshDelay = REFRESH_INTERVAL;
                } else if (actorCount != lastActorCount) {
                    lastActorCount = actorCount;
                }
                if (dt > 0f) {
                    acc += dt;
                    float maxAcc = tickRate * 5f;
                    if (acc > maxAcc) {
                        acc = maxAcc; // 卡顿不追帧，避免死亡螺旋
                    }
                    int steps = 0;
                    while (acc >= tickRate && steps < 5) {
                        step(tickRate);
                        acc -= tickRate;
                        steps++;
                    }
                }
                rebuildOverlay();
            } finally {
                lastTickMs = (System.nanoTime() - t0) / 1_000_000.0;
            }
        }

        private void step(float dt) {
            qN = 0;
            burnQN = 0;
            int windIX = Math.round(windX * 2f);
            int windIY = Math.round(windY * 2f);
            int limit = activeN;
            for (int k = 0; k < limit; k++) {
                processCell(active[k], dt, windIX, windIY);
            }
            // 状态变更（烧穿/移除阻挡/销毁实体）与事件派发都在遍历之外做，脚本回调不会打乱迭代。
            resolveBurns();
            dispatchEvents();
            damageProps(dt);
            compact();
            tickNo++;
        }

        private void processCell(int idx, float dt, int windIX, int windIY) {
            int cx = idx % cols;
            int cy = idx / cols;

            // ---- water：水材质永久压火；泼出去的水会渗干 ----
            // 两种水要区分开：
            //   · 水材质格（河/水渠/water 材质）→ 永久水源，同格与相邻格的火每次 tick 都压灭；
            //   · 水通道（脚本 emit("water") 泼出去的）→ 会蒸发，只有强度够才压得住相邻火，且压一次消耗一些。
            // 不区分的话「一桶水永久封锁 3x3」会让火再也烧不过来，涌现链就断了。
            float wv = waterV[idx];
            Material wm = effMat(idx);
            boolean waterSource = wv > 0f || isWaterMaterial(wm);
            if (waterSource) {
                boolean materialWater = isWaterMaterial(wm);
                if (fireV[idx] > 0f) {
                    extinguish(idx, EV_EXT_WATER);
                }
                for (int dy = -1; dy <= 1; dy++) {
                    int ny = cy + dy;
                    if (ny < 0 || ny >= rows) {
                        continue;
                    }
                    for (int dx = -1; dx <= 1; dx++) {
                        int nx = cx + dx;
                        if (nx < 0 || nx >= cols) {
                            continue;
                        }
                        int n = ny * cols + nx;
                        if (fireV[n] > 0f && (materialWater || wv >= WATER_DOUSE_MIN)) {
                            extinguish(n, EV_EXT_WATER);
                            if (!materialWater) {
                                wv -= WATER_DOUSE_COST;
                                if (wv < 0f) {
                                    wv = 0f;
                                }
                                waterV[idx] = wv;
                            }
                        }
                        if (effMat(n) != null) {
                            wet[n] = 1f;
                            activate(n);
                        }
                    }
                }
            }
            // 泼出去的水会渗干（水材质格本身不需要通道值）
            if (waterV[idx] > 0f) {
                float left = waterV[idx] - WATER_DECAY * dt;
                waterV[idx] = left <= 0f ? 0f : left;
            }

            // ---- fire：点燃 / 燃烧进度 / 蔓延 / 产烟 ----
            float fv = fireV[idx];
            if (fv > 0f) {
                if (waterV[idx] > 0f) {
                    // 水淹格：火一进来就被吸收，不会点燃湿透的燃料
                    extinguish(idx, EV_EXT_WATER);
                    fv = 0f;
                }
                Material m = effMat(idx);
                if (fv > 0f && burning[idx]) {
                    burnT[idx] += dt * (0.6f + fv);
                    if (fireV[idx] < HOLD_FIRE) {
                        fireV[idx] = HOLD_FIRE;
                    }
                    if (burnT[idx] >= burnLimit[idx]) {
                        queueBurn(idx);
                    }
                    fv = fireV[idx];
                } else if (fv > 0f && m != null && m.flammable > 0f && fv >= IGNITE_THRESHOLD
                        && burnName[idx] == null) {
                    startBurn(idx, m);
                    fv = fireV[idx];
                }
                if (!burning[idx]) {
                    fv -= FIRE_DECAY * dt;
                    if (fv <= 0f) {
                        fireV[idx] = 0f;
                        queueExtinguish(idx, EV_EXT_DECAY);
                        fv = 0f;
                    } else {
                        fireV[idx] = fv;
                    }
                }
                if (fv > 0f) {
                    if (fv > 0.02f) {
                        spread(idx, cx, cy, fv, dt);
                    }
                    float sv = smokeV[idx] + fv * dt * SMOKE_PER_FIRE;
                    if (sv > smokeChan.max) {
                        sv = smokeChan.max;
                    }
                    smokeV[idx] = sv;
                    activate(idx);
                }
            }

            // ---- smoke：向上 + 顺风扩散、横向扩散、衰减 ----
            float sv = smokeV[idx];
            if (sv > SMOKE_WORK_MIN) {
                float smax = smokeChan.max;
                float out = sv * (0.5f * dt);
                if (out > sv) {
                    out = sv;
                }
                int tx = cx + windIX;
                int ty = cy - 1 + windIY;
                addSmoke(tx, ty, out * 0.5f, smax);
                addSmoke(cx - 1, cy, out * 0.15f, smax);
                addSmoke(cx + 1, cy, out * 0.15f, smax);
                addSmoke(cx, cy + 1, out * 0.1f, smax);
                float keep = (sv - out) * (1f - SMOKE_DECAY * dt);
                smokeV[idx] = keep < EPS ? 0f : keep;
            }

            // ---- 自定义通道：只衰减（规则由脚本组合） ----
            int nc = customs.size();
            for (int i = 0; i < nc; i++) {
                Chan ch = customs.get(i);
                float v = ch.v[idx];
                if (v > 0f && ch.decay > 0f) {
                    v -= ch.decay * dt;
                    ch.v[idx] = v < 0f ? 0f : v;
                }
            }

            // ---- 湿润恢复 ----
            float w = wet[idx];
            if (w > 0f) {
                w -= dt / WET_RECOVER;
                wet[idx] = w <= 0f ? 0f : w;
            }
        }

        private void startBurn(int idx, Material m) {
            dbg("startBurn idx=" + idx + " mat=" + m.name + " burnTime=" + m.burnTime
                    + " tileActor=" + (tileActor[idx] == null ? "-" : tileActor[idx].o.name)
                    + " ovActor=" + (ovActor[idx] == null ? "-" : ovActor[idx].o.name));
            burning[idx] = true;
            burnT[idx] = 0f;
            burnLimit[idx] = m.burnTime > 0f ? m.burnTime : 2f;
            burnName[idx] = m.name;
            burnActor[idx] = matCache[idx] != null ? tileActor[idx] : ovActor[idx];
            if (fireV[idx] < HOLD_FIRE) {
                fireV[idx] = HOLD_FIRE;
            }
            activate(idx);
            if (hasHandlers("ignite")) {
                queueEvent(idx, EV_IGNITE);
            }
        }

        private void spread(int idx, int cx, int cy, float fv, float dt) {
            long h = mix(seed + (long) idx * 0x9E3779B97F4A7C15L + tickNo * 0x94D049BB133111EBL);
            int slot = 0;
            for (int dy = -1; dy <= 1; dy++) {
                int ny = cy + dy;
                if (ny < 0 || ny >= rows) {
                    continue;
                }
                for (int dx = -1; dx <= 1; dx++) {
                    if (dx == 0 && dy == 0) {
                        continue;
                    }
                    int nx = cx + dx;
                    if (nx < 0 || nx >= cols) {
                        continue;
                    }
                    int n = ny * cols + nx;
                    if (fireV[n] >= IGNITE_THRESHOLD || waterV[n] > 0f) {
                        continue; // 已经在烧，或目标被水淹（水渠切断火势）
                    }
                    Material nm = effMat(n);
                    if (nm == null || nm.flammable <= 0f) {
                        continue;
                    }
                    // 水材质/水淹格：火不会蔓延进去（水渠切断火势的物理基础）
                    if (nm.waterish || waterV[n] > 0f) {
                        wet[n] = 1f;
                        continue;
                    }
                    // 紧贴水材质的格子被反复打湿 → 泡透的燃料点不着。
                    // 注意只认「水材质」（河/水渠），不认泼出去的临时水（否则一桶水会永久封锁一片区域，
                    // 涌现链（烧过去→引燃油桶→烧穿墙）就断了）。
                    if (adjacentToWaterMaterial(n)) {
                        wet[n] = 1f;
                        continue;
                    }
                    float fl = nm.flammable * (1f - 0.5f * wet[n]);
                    if (fl <= 0f) {
                        continue;
                    }
                    float bias = 1f;
                    if (windX != 0f || windY != 0f) {
                        bias = 1f + 0.35f * (dx * windX + dy * windY);
                        if (bias < 0.2f) {
                            bias = 0.2f;
                        }
                    }
                    float p = fl * fv * SPREAD_RATE * dt * bias;
                    int bits = (int) ((h >>> (slot * 8)) & 0xFFL);
                    slot++;
                    if (bits / 255f < p) {
                        float nf = 0.45f + 0.55f * fv;
                        if (nf > 0.9f) {
                            nf = 0.9f;
                        }
                        if (nf > fireV[n]) {
                            fireV[n] = nf;
                        }
                        activate(n);
                    }
                }
            }
        }

        private void addSmoke(int cx, int cy, float amount, float max) {
            if (amount <= 0f || cx < 0 || cy < 0 || cx >= cols || cy >= rows) {
                return;
            }
            int n = cy * cols + cx;
            float v = smokeV[n] + amount;
            if (v > max) {
                v = max;
            }
            smokeV[n] = v;
            activate(n);
        }

        /** 灭火：清 fire 通道并取消正在进行的燃烧（材质不消失）。 */
        private void extinguish(int idx, byte cause) {
            if (fireV[idx] <= 0f && !burning[idx]) {
                return;
            }
            if (DEBUG && idx == 246) {
                dbg("extinguish idx=" + idx + " cause=" + cause + " burning=" + burning[idx]
                        + " burnT=" + burnT[idx]);
                dbg("   stack: " + stack());
            }
            fireV[idx] = 0f;
            burning[idx] = false;
            burnT[idx] = 0f;
            burnName[idx] = null;
            burnLimit[idx] = 0f;
            burnActor[idx] = null;
            if (hasHandlers("extinguish")) {
                queueEvent(idx, cause);
            }
        }

        private void queueBurn(int idx) {
            dbg("queueBurn idx=" + idx + " burnT=" + burnT[idx] + " limit=" + burnLimit[idx]
                    + " mat=" + burnName[idx]);
            burning[idx] = false;
            burnT[idx] = 0f;
            if (burnQN < burnQ.length) {
                burnQ[burnQN++] = idx;
            }
        }

        private void queueExtinguish(int idx, byte cause) {
            if (hasHandlers("extinguish")) {
                queueEvent(idx, cause);
            }
        }

        private void queueEvent(int idx, byte type) {
            if (qN < qCell.length) {
                qCell[qN] = idx;
                qType[qN] = type;
                qN++;
            }
        }

        /** 烧穿：材质变 null；TILE 从 tilemap 阻挡移除；实体消失；派发 burned 事件。 */
        private void resolveBurns() {
            for (int i = 0; i < burnQN; i++) {
                int idx = burnQ[burnQN - 1 - i];
                int cx = idx % cols;
                int cy = idx / cols;
                String name = burnName[idx];
                // 保险：startBurn 时若 tileActor 还没挂上，burnActor 会是 null，
                // 结果材质清了但 TILE 实体还在 → 下一次 refreshStructure 又把材质恢复回来。
                TopDownRuntime.Actor who = burnActor[idx] != null ? burnActor[idx] : tileActor[idx];
                boolean fromCell = matCache[idx] != null || mats[idx] != null || tileActor[idx] != null;
                dbg("resolveBurn idx=" + idx + " name=" + name + " fromCell=" + fromCell
                        + " matCache=" + (matCache[idx] == null ? "-" : matCache[idx].name)
                        + " mats=" + mats[idx] + " who=" + (who == null ? "-" : who.o.name));
                if (fromCell) {
                    mats[idx] = null;
                    matCache[idx] = null;
                    if (world.get(cx, cy) != 0) {
                        world.set(cx, cy, 0); // 烧穿墙 = 开出一条路
                    }
                    tileActor[idx] = null;
                }
                burnName[idx] = null;
                burnLimit[idx] = 0f;
                burnActor[idx] = null;
                fireV[idx] = 0f;
                burning[idx] = false;
                burnT[idx] = 0f;
                burnedTotal++;
                if (who != null && !who.dead) {
                    if (engine.boundScript(who) != null) {
                        engine.destroyEntity(who); // 有脚本：走完整 onDestroy 流程
                    } else {
                        // 纯瓦片/道具：只标脏，结束时从尾部批量移除（避免 ArrayList O(n) 逐个删除）
                        who.dead = true;
                        api.invalidate(who);
                    }
                }
                if (hasHandlers("burned")) {
                    fireEvent("burned", burnedPayload(cx, cy, name));
                }
                if (hasHandlers("extinguish")) {
                    fireEvent("extinguish", extinguishPayload(cx, cy, "burned"));
                }
            }
            removeDeadActors();
        }

        /** 从尾向前压掉 dead 实体：逐个按尾部删除无位移，整体 O(n)。 */
        private void removeDeadActors() {
            List<TopDownRuntime.Actor> actors = host.actors;
            for (int i = actors.size() - 1; i >= 0; i--) {
                if (actors.get(i).dead) {
                    actors.remove(i);
                }
            }
        }

        private void dispatchEvents() {
            for (int i = 0; i < qN; i++) {
                int idx = qCell[i];
                int cx = idx % cols;
                int cy = idx / cols;
                switch (qType[i]) {
                    case EV_IGNITE: {
                        TopDownRuntime.Actor a = burnActor[idx];
                        Object entity = (a == null || a.dead) ? null : api.entityOf(a);
                        fireEvent("ignite", ignitePayload(cx, cy, burnName[idx], entity));
                        break;
                    }
                    case EV_EXT_WATER:
                        fireEvent("extinguish", extinguishPayload(cx, cy, "water"));
                        break;
                    case EV_EXT_DECAY:
                        fireEvent("extinguish", extinguishPayload(cx, cy, "decay"));
                        break;
                    case EV_EXT_CLEAR:
                        fireEvent("extinguish", extinguishPayload(cx, cy, "clear"));
                        break;
                    default:
                        break;
                }
            }
        }

        /** 火烧到实体的伤害（连续伤害 + 相邻热辐射）。 */
        private void damageProps(float dt) {
            for (int i = 0; i < props.size(); i++) {
                TopDownRuntime.Actor a = props.get(i);
                if (a == null || a.dead || a.o == null) {
                    continue;
                }
                int cx = world.toCellX(a.x);
                int cy = world.toCellY(a.y);
                if (!world.inBoundsCell(cx, cy)) {
                    continue;
                }
                int idx = cy * cols + cx;
                float heat = fireV[idx];
                if (heat < 0.02f) {
                    if (cx > 0) {
                        heat = Math.max(heat, fireV[idx - 1]);
                    }
                    if (cx + 1 < cols) {
                        heat = Math.max(heat, fireV[idx + 1]);
                    }
                    if (cy > 0) {
                        heat = Math.max(heat, fireV[idx - cols]);
                    }
                    if (cy + 1 < rows) {
                        heat = Math.max(heat, fireV[idx + cols]);
                    }
                    heat *= 0.45f;
                }
                if (heat < 0.02f) {
                    continue;
                }
                Material m = propMats.get(i);
                // 材质驱动：易燃物烧得快，金属/石头只被轻微炙烤。
                float mult = (m.flammable > 0f ? 1.5f : 0.25f) / (1f + m.hardness * 0.5f);
                float dmg = heat * DAMAGE_RATE * dt * mult;
                if (dmg > 0f) {
                    damageActor(a, dmg);
                }
            }
        }

        private void damageActor(TopDownRuntime.Actor a, float dmg) {
            if (a == null || a.dead) {
                return;
            }
            a.hp -= dmg;
            Object[] args = new Object[]{Double.valueOf(dmg), null};
            api.dispatchEntityEvent(a, "damage", args);
            engine.dispatchObject(a, engine.boundScript(a), "onDamage", args);
            if (a.hp <= 0f) {
                api.dispatchEntityEvent(a, "death", new Object[]{null});
                engine.dispatchObject(a, engine.boundScript(a), "onDeath", new Object[]{null});
                engine.destroyEntity(a);
            }
        }

        private void compact() {
            int w = 0;
            for (int k = 0; k < activeN; k++) {
                int idx = active[k];
                if (alive(idx)) {
                    active[w++] = idx;
                } else {
                    activeFlag[idx] = false;
                }
            }
            activeN = w;
        }

        /**
         * 该格是否还需要留在 active 列表里。
         *
         * <p><b>契约</b>：只有在 {@link #processCell} 可能改动状态时才返回 true。
         * 否则这一格会每 tick 被遍历一遍却什么都不做——大地图烟雾消散期会出现
         * 数千个这种空转格（实测 100x100 草地场景稳态 ~4148 格、约 100µs/帧）。
         *
         * <p>每个门限都必须与 processCell 里对应分支的「工作门限」逐字对齐：
         * <ul>
         *   <li>smoke 分支是 {@code sv > 0.01f}，所以这里也必须用 0.01 而不是 EPS
         *       （用 EPS 会多留一批 0.005~0.01 的格子空转）；</li>
         *   <li>自定义通道只在 {@code decay > 0} 时才衰减，decay 为 0 的通道值永远不变，
         *       留着它也只是空转；</li>
         *   <li>fire / water / wet 仍用 EPS：它们的分支门限是 {@code > 0f}，与 EPS 不等价，
         *       但改成 0f 会让「低于 EPS 的残留值」永远留在表中，属于行为变更，故保持不变。</li>
         * </ul>
         */
        private boolean alive(int idx) {
            if (burning[idx]) {
                return true;
            }
            if (fireV[idx] > EPS || waterV[idx] > EPS || wet[idx] > EPS) {
                return true;
            }
            if (smokeV[idx] > SMOKE_WORK_MIN) {
                return true;
            }
            for (int i = 0; i < customs.size(); i++) {
                Chan ch = customs.get(i);
                if (ch.decay > 0f && ch.v[idx] > EPS) {
                    return true;
                }
            }
            return false;
        }

        private void activate(int idx) {
            if (!activeFlag[idx]) {
                activeFlag[idx] = true;
                if (activeN < active.length) {
                    active[activeN++] = idx;
                }
            }
        }

        private Material effMat(int idx) {
            Material m = matCache[idx];
            return m != null ? m : ovMat[idx];
        }

        // ---------------- 通道读写（JS 与静态入口共用） ----------------

        private Chan channel(String rawName) {
            String key = rawName == null ? "" : rawName.trim().toLowerCase(Locale.ROOT);
            if (key.isEmpty()) {
                key = "fire";
            }
            Chan c = channels.get(key);
            if (c != null) {
                return c;
            }
            c = new Chan(key, new float[cols * rows], 1f);
            channels.put(key, c);
            customs.add(c);
            return c;
        }

        private int cellIndex(int cx, int cy) {
            return world.inBoundsCell(cx, cy) ? cy * cols + cx : -1;
        }

        float channelAt(String rawName, int cx, int cy) {
            String key = rawName == null ? "" : rawName.trim().toLowerCase(Locale.ROOT);
            int idx = cellIndex(cx, cy);
            if (idx < 0) {
                return 0f;
            }
            if ("fire".equals(key)) {
                return fireV[idx];
            }
            if ("water".equals(key)) {
                return waterV[idx];
            }
            if ("smoke".equals(key)) {
                return smokeV[idx];
            }
            Chan c = channels.get(key);
            return c == null ? 0f : c.v[idx];
        }

        String materialNameAt(int cx, int cy) {
            int idx = cellIndex(cx, cy);
            if (idx < 0) {
                return null;
            }
            if (matCache[idx] != null) {
                return mats[idx];
            }
            return ovMat[idx] == null ? null : ovMat[idx].name;
        }

        float wetAtCell(int cx, int cy) {
            int idx = cellIndex(cx, cy);
            return idx < 0 ? 0f : wet[idx];
        }

        float flammabilityAtCell(int cx, int cy) {
            int idx = cellIndex(cx, cy);
            if (idx < 0) {
                return 0f;
            }
            Material m = effMat(idx);
            if (m == null) {
                return 0f;
            }
            return m.flammable * (1f - 0.5f * wet[idx]);
        }

        private void putCell(Chan c, int cx, int cy, float v) {
            int idx = cellIndex(cx, cy);
            if (idx < 0) {
                return;
            }
            c.v[idx] = v;
            if (v > 0f) {
                activate(idx);
            }
        }

        private void clearChannel(String rawName) {
            String key = rawName == null ? "" : rawName.trim().toLowerCase(Locale.ROOT);
            boolean all = key.isEmpty() || "all".equals(key);
            boolean fire = all || "fire".equals(key);
            Chan ch = null;
            if (!all) {
                ch = channels.get(key);
                if (ch == null) {
                    return;
                }
            }
            int limit = activeN;
            for (int k = 0; k < limit; k++) {
                int idx = active[k];
                if (fire && fireV[idx] > 0f) {
                    fireV[idx] = 0f;
                    if (hasHandlers("extinguish")) {
                        queueEvent(idx, EV_EXT_CLEAR);
                    }
                }
                if (fire && burning[idx]) {
                    burning[idx] = false;
                    burnT[idx] = 0f;
                    burnName[idx] = null;
                    burnLimit[idx] = 0f;
                    burnActor[idx] = null;
                }
                if (all) {
                    waterV[idx] = 0f;
                    smokeV[idx] = 0f;
                    for (int i = 0; i < customs.size(); i++) {
                        customs.get(i).v[idx] = 0f;
                    }
                } else {
                    ch.v[idx] = 0f;
                }
            }
            dispatchEvents();
            compact();
        }

        // ---------------- JS 表面 ----------------

        private void bindJs() {
            final Scriptable mat = api.newObj();
            api.addMethod(mat, "define", (cx, thisObj, args) -> {
                String name = ScriptJs.str(ScriptJs.arg(args, 0), "").trim();
                if (name.isEmpty()) {
                    return null;
                }
                Material m = createMaterial(name);
                Scriptable props = asScriptable(ScriptJs.arg(args, 1));
                if (props != null) {
                    applyProps(m, props);
                }
                return materialObj(m);
            });
            api.addMethod(mat, "get", (cx, thisObj, args) -> {
                Material m = materialByName(ScriptJs.str(ScriptJs.arg(args, 0), ""));
                return m == null ? null : materialObj(m);
            });
            api.addMethod(mat, "tags", (cx, thisObj, args) -> {
                Material m = materialByName(ScriptJs.str(ScriptJs.arg(args, 0), ""));
                return tagsArray(m == null ? NO_TAGS : m.tags);
            });
            api.addMethod(mat, "of", (cx, thisObj, args) -> {
                int cellX = ScriptJs.inum(ScriptJs.arg(args, 0), 0);
                int cellY = ScriptJs.inum(ScriptJs.arg(args, 1), 0);
                return materialNameAt(cellX, cellY);
            });
            api.addMethod(mat, "setTile", (cx, thisObj, args) -> {
                int cellX = ScriptJs.inum(ScriptJs.arg(args, 0), 0);
                int cellY = ScriptJs.inum(ScriptJs.arg(args, 1), 0);
                int idx = cellIndex(cellX, cellY);
                if (idx < 0) {
                    return null;
                }
                String raw = ScriptJs.str(ScriptJs.arg(args, 2), null);
                if (raw == null || raw.trim().isEmpty()) {
                    mats[idx] = null;
                    matCache[idx] = null;
                    matFixed[idx] = true;
                } else {
                    Material m = ensureMaterial(raw);
                    mats[idx] = m.name;
                    matCache[idx] = m;
                    matFixed[idx] = true;
                    if (m.wet) {
                        wet[idx] = 1f;
                        activate(idx);
                    }
                }
                return null;
            });
            api.addMethod(mat, "ofEntity", (cx, thisObj, args) -> {
                TopDownRuntime.Actor a = api.actorOf(ScriptJs.arg(args, 0));
                if (a == null) {
                    return null;
                }
                return resolveActorMaterial(a).name;
            });
            api.addMethod(mat, "setEntity", (cx, thisObj, args) -> {
                TopDownRuntime.Actor a = api.actorOf(ScriptJs.arg(args, 0));
                String name = ScriptJs.str(ScriptJs.arg(args, 1), "").trim();
                if (a == null || name.isEmpty()) {
                    return null;
                }
                entityMats.put(a, ensureMaterial(name).name);
                lastActorCount = -1; // 下 tick 重建材质映射
                return null;
            });
            api.attach("material", mat);

            final Scriptable fld = api.newObj();
            api.addMethod(fld, "emit", (cx, thisObj, args) -> {
                String name = ScriptJs.str(ScriptJs.arg(args, 0), "fire");
                int cellX = ScriptJs.inum(ScriptJs.arg(args, 1), 0);
                int cellY = ScriptJs.inum(ScriptJs.arg(args, 2), 0);
                float v = ScriptJs.fnum(ScriptJs.arg(args, 3), 1f);
                Chan c = channel(name);
                if (v < 0f) {
                    v = 0f;
                }
                if (v > c.max) {
                    v = c.max;
                }
                putCell(c, cellX, cellY, v);
                return null;
            });
            api.addMethod(fld, "sample", (cx, thisObj, args) -> {
                String name = ScriptJs.str(ScriptJs.arg(args, 0), "fire");
                int cellX = ScriptJs.inum(ScriptJs.arg(args, 1), 0);
                int cellY = ScriptJs.inum(ScriptJs.arg(args, 2), 0);
                return Double.valueOf(channelAt(name, cellX, cellY));
            });
            api.addMethod(fld, "clear", (cx, thisObj, args) -> {
                clearChannel(ScriptJs.str(ScriptJs.arg(args, 0), ""));
                return null;
            });
            api.addMethod(fld, "tickRate", (cx, thisObj, args) -> {
                if (args == null || args.length == 0) {
                    return Double.valueOf(tickRate);
                }
                float v = ScriptJs.fnum(ScriptJs.arg(args, 0), tickRate);
                if (v < 0.01f) {
                    v = 0.01f;
                }
                if (v > 1f) {
                    v = 1f;
                }
                tickRate = v;
                return Double.valueOf(tickRate);
            });
            api.addMethod(fld, "channel", (cx, thisObj, args) -> {
                String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
                final Chan c = channel(name);
                Scriptable o = api.newObj();
                ScriptJs.put(o, "name", c.name);
                api.addMethod(o, "max", (c2, thisObj2, args2) -> {
                    if (args2 != null && args2.length > 0) {
                        float v = ScriptJs.fnum(ScriptJs.arg(args2, 0), c.max);
                        if (v < 0.01f) {
                            v = 0.01f;
                        }
                        if (v > 1000f) {
                            v = 1000f;
                        }
                        c.max = v;
                    }
                    return Double.valueOf(c.max);
                });
                return o;
            });
            api.addMethod(fld, "wind", (cx, thisObj, args) -> {
                if (args != null && args.length >= 2) {
                    float wx = ScriptJs.fnum(ScriptJs.arg(args, 0), windX);
                    float wy = ScriptJs.fnum(ScriptJs.arg(args, 1), windY);
                    if (wx < -1f) {
                        wx = -1f;
                    }
                    if (wx > 1f) {
                        wx = 1f;
                    }
                    if (wy < -1f) {
                        wy = -1f;
                    }
                    if (wy > 1f) {
                        wy = 1f;
                    }
                    windX = wx;
                    windY = wy;
                }
                Scriptable o = api.newObj();
                ScriptJs.put(o, "x", Double.valueOf(Math.round(windX * 10000f) / 10000.0));
                ScriptJs.put(o, "y", Double.valueOf(Math.round(windY * 10000f) / 10000.0));
                return o;
            });
            api.addMethod(fld, "on", (cx, thisObj, args) -> {
                String event = ScriptJs.str(ScriptJs.arg(args, 0), "");
                Function fn = ScriptJs.fnArg(ScriptJs.arg(args, 1));
                if (event.isEmpty() || fn == null) {
                    return null;
                }
                List<Handler> list = evHandlers.get(event);
                if (list == null) {
                    list = new ArrayList<Handler>();
                    evHandlers.put(event, list);
                }
                final List<Handler> fList = list;
                final Function fFn = fn;
                list.add(new Handler(fn));
                // ⚠ 必须返回「取消订阅函数」：契约（bwe.d.ts / apiDocs / docs/api）
                // 一直声明返回 `() => void`，而这里原来 `return null`。
                // 用户照文档写 `var off = bwe.field.on("ignite", f); off();` 会
                // 直接 TypeError: off is not a function —— 这是真会崩用户代码的缺陷。
                return api.newFn("offFieldEvent", (c2, t2, a2) -> {
                    removeHandler(fList, fFn);
                    return null;
                });
            });

            api.addMethod(fld, "off", (cx, thisObj, args) -> {
                String event = ScriptJs.str(ScriptJs.arg(args, 0), "");
                Function fn = ScriptJs.fnArg(ScriptJs.arg(args, 1));
                List<Handler> list = evHandlers.get(event);
                if (list == null) {
                    return null;
                }
                if (fn == null) {
                    list.clear();
                } else {
                    removeHandler(list, fn);
                }
                return null;
            });
            api.addMethod(fld, "burning", (cx, thisObj, args) -> {
                List<Object> out = new ArrayList<Object>();
                for (int k = 0; k < activeN; k++) {
                    int idx = active[k];
                    if (fireV[idx] <= 0.01f) {
                        continue;
                    }
                    Scriptable o = api.newObj();
                    int cx2 = idx % cols;
                    int cy2 = idx / cols;
                    ScriptJs.put(o, "cx", Double.valueOf(cx2));
                    ScriptJs.put(o, "cy", Double.valueOf(cy2));
                    ScriptJs.put(o, "intensity", Double.valueOf(fireV[idx]));
                    Material m = effMat(idx);
                    ScriptJs.put(o, "material", m == null ? null : m.name);
                    out.add(o);
                }
                return newArray(out.toArray());
            });
            api.attach("field", fld);
        }

        private void applyProps(Material m, Scriptable props) {
            Object v = ScriptJs.get(props, "flammable");
            if (!ScriptJs.isMissing(v)) {
                m.flammable = clamp01(ScriptJs.fnum(v, m.flammable));
            }
            v = ScriptJs.get(props, "burnTime");
            if (!ScriptJs.isMissing(v)) {
                float b = ScriptJs.fnum(v, m.burnTime);
                m.burnTime = b < 0f ? 0f : b;
            }
            v = ScriptJs.get(props, "conductive");
            if (!ScriptJs.isMissing(v)) {
                m.conductive = ScriptJs.bool(v, m.conductive);
            }
            v = ScriptJs.get(props, "wet");
            if (!ScriptJs.isMissing(v)) {
                m.wet = ScriptJs.bool(v, m.wet);
            }
            v = ScriptJs.get(props, "hardness");
            if (!ScriptJs.isMissing(v)) {
                float h = ScriptJs.fnum(v, m.hardness);
                m.hardness = h < 0f ? 0f : h;
            }
            v = ScriptJs.get(props, "density");
            if (!ScriptJs.isMissing(v)) {
                float d = ScriptJs.fnum(v, m.density);
                m.density = d < 0f ? 0f : d;
            }
            v = ScriptJs.get(props, "tags");
            String[] tags = stringArray(v);
            if (tags != null) {
                m.tags = tags;
            }
            // define() 可能改了 tags/名字 → 重算「是否水材质」，否则永久灭火判定会过期
            m.refreshDerived();
            if (m.waterish) {
                m.flammable = 0f; // 水不可燃：防止脚本把 water 定义成可燃后出现「水在燃烧」
            }
        }

        private static float clamp01(float v) {
            if (v < 0f) {
                return 0f;
            }
            if (v > 1f) {
                return 1f;
            }
            return v;
        }

        private static Scriptable asScriptable(Object v) {
            return v instanceof Scriptable ? (Scriptable) v : null;
        }

        private static String[] stringArray(Object v) {
            if (!(v instanceof Scriptable)) {
                return null;
            }
            Scriptable s = (Scriptable) v;
            int n = -1;
            try {
                Object lenObj = s.get("length", s);
                if (!ScriptJs.isMissing(lenObj)) {
                    n = ScriptJs.inum(lenObj, -1);
                }
            } catch (Throwable ignored) {
            }
            if (n < 0) {
                return null;
            }
            if (n == 0) {
                return NO_TAGS;
            }
            if (n > 64) {
                n = 64;
            }
            String[] out = new String[n];
            for (int i = 0; i < n; i++) {
                Object item = null;
                try {
                    item = s.get(i, s);
                } catch (Throwable ignored) {
                }
                out[i] = item == null || item == Scriptable.NOT_FOUND ? "" : ScriptJs.str(item, "");
            }
            return out;
        }

        private Scriptable materialObj(Material m) {
            Scriptable o = api.newObj();
            ScriptJs.put(o, "name", m.name);
            ScriptJs.put(o, "flammable", Double.valueOf(m.flammable));
            ScriptJs.put(o, "burnTime", Double.valueOf(m.burnTime));
            ScriptJs.put(o, "conductive", Boolean.valueOf(m.conductive));
            ScriptJs.put(o, "wet", Boolean.valueOf(m.wet));
            ScriptJs.put(o, "hardness", Double.valueOf(m.hardness));
            ScriptJs.put(o, "density", Double.valueOf(m.density));
            ScriptJs.put(o, "tags", tagsArray(m.tags));
            return o;
        }

        private Scriptable tagsArray(String[] tags) {
            String[] t = tags == null ? NO_TAGS : tags;
            Object[] arr = new Object[t.length];
            for (int i = 0; i < t.length; i++) {
                arr[i] = t[i];
            }
            Scriptable s = newArray(arr);
            return s == null ? api.newObj() : s;
        }

        private Scriptable newArray(Object[] values) {
            Context cx = Context.getCurrentContext();
            if (cx == null || engine.shared == null) {
                return null;
            }
            return cx.newArray(engine.shared, values);
        }

        // ---------------- 事件 ----------------

        private boolean hasHandlers(String event) {
            List<Handler> list = evHandlers.get(event);
            return list != null && !list.isEmpty();
        }

        private void fireEvent(String event, Scriptable payload) {
            List<Handler> list = evHandlers.get(event);
            if (list == null || list.isEmpty()) {
                return;
            }
            int n = list.size();
            for (int i = 0; i < n; i++) {
                Handler h = list.get(i);
                engine.invoke(null, h.fn, h.scope, new Object[]{payload});
            }
        }

        private Scriptable ignitePayload(int cx, int cy, String material, Object entity) {
            Scriptable o = api.newObj();
            putCellPos(o, cx, cy);
            ScriptJs.put(o, "material", material);
            ScriptJs.put(o, "entity", entity);
            return o;
        }

        private Scriptable extinguishPayload(int cx, int cy, String cause) {
            Scriptable o = api.newObj();
            putCellPos(o, cx, cy);
            ScriptJs.put(o, "cause", cause);
            return o;
        }

        private Scriptable burnedPayload(int cx, int cy, String material) {
            Scriptable o = api.newObj();
            putCellPos(o, cx, cy);
            ScriptJs.put(o, "material", material);
            return o;
        }

        private static void putCellPos(Scriptable o, int cx, int cy) {
            ScriptJs.put(o, "cx", Double.valueOf(cx));
            ScriptJs.put(o, "cy", Double.valueOf(cy));
        }

        /** 确定性散列（同一 seed + 格 + tick 永远同一结果）。 */
        private static long mix(long x) {
            x ^= x >>> 33;
            x *= 0xff51afd7ed558ccdL;
            x ^= x >>> 33;
            x *= 0xc4ceb9fe1a85ec53L;
            x ^= x >>> 33;
            return x;
        }

        private static String stack() {
            StackTraceElement[] st = Thread.currentThread().getStackTrace();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < st.length && i < 10; i++) {
                sb.append(st[i].getMethodName()).append(" <- ");
            }
            return sb.toString();
        }
    }
}
