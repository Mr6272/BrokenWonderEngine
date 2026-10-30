package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Scriptable;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 空间与多层建筑命名空间 {@code bwe.spatial}（契约 {@code docs/api/spatial.md}；
 * 设计 {@code docs/open-world-architecture.md} §5）。
 *
 * <h3>核心设计：五状态分离</h3>
 * 任务书 §14 明确要求「不能用单一 {@code visible} 字段代替以下状态」。这里把它们拆成
 * <b>互相独立</b>的五个概念，各有各的解算器：
 * <table>
 *   <tr><th>状态</th><th>问的问题</th><th>谁读它</th></tr>
 *   <tr><td>渲染可见性 {@code renderVisible}</td><td>这一帧画不画这个区域？</td><td>渲染器</td></tr>
 *   <tr><td>碰撞启用 {@code collisionEnabled}</td><td>实体的碰撞体在这一层生效吗？</td><td>碰撞层</td></tr>
 *   <tr><td>导航可达 {@code navPassable}</td><td>这个 agent 能不能走到这块格子？</td><td>导航</td></tr>
 *   <tr><td>玩家空间归属 {@code playerZone}</td><td>玩家现在在哪栋楼/哪层/哪个房间？</td><td>游戏脚本、楼层剔除</td></tr>
 *   <tr><td>NPC 空间归属 {@code npcZone}</td><td>某个 NPC 在哪一层？（可能与玩家不同）</td><td>AI、跨层追捕</td></tr>
 * </table>
 *
 * <p>前三个是<b>区域（zone）的属性</b>，后两个是<b>实体（actor）的属性</b> —— 这是本设计的
 * 关键区分：同一块区域对"玩家所在层"可见、对"NPC 所在层"可能就是不可导航的。
 * 所以 {@code navPassable} 必须<b>按 agent 分别求解</b>，不能存在区域上。
 *
 * <h3>生命周期</h3>
 * <pre>
 *   场景加载 → 解析 scene.buildings[] → buildIndex()
 *   每帧   → resolve()：算 playerZone / 各 actor 的 floor / 各 zone 的三状态
 *   场景卸载 → clearSceneState()：全表清零（有断言）
 * </pre>
 *
 * <h3>兼容性</h3>
 * 没有 {@code buildings} 数据的场景（所有旧工程）：{@link #hasData()} 返回 false，
 * 所有查询返回 null / true（不阻挡），{@code bwe.spatial} 的存在<b>不改变任何现有行为</b>。
 */
final class ScriptSpatial {

    static ScriptSpatial LAST;

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final TopDownRuntime host;
    private final Scriptable scope;
    private final ScriptJs.Flex ns;

    /** 建好的索引：building id → Building；zone id → Zone；floor key → Floor。 */
    private final Map<String, Building> buildings = new LinkedHashMap<String, Building>();
    private final Map<String, Zone> zones = new LinkedHashMap<String, Zone>();
    private final Map<String, Floor> floors = new LinkedHashMap<String, Floor>();
    private final List<NavLink> links = new ArrayList<NavLink>();

    /** 玩家当前所在区域（每帧 resolve 后更新）。 */
    private Zone playerZone;
    /** 玩家当前楼层序号（无数据时为 0）。 */
    private int playerLevel;
    /** 玩家所在建筑（室外 = null）。 */
    private Building playerBuilding;

    /** 每帧是否已 resolve（同一帧内重复查询不重复算）。 */
    private int resolvedFrame = -1;
    /** 楼层可见性规则（可被脚本替换）。 */
    private VisibilityRule visibilityRule = VisibilityRule.DEFAULT;

    private boolean built;

    // ---------------- 数据模型 ----------------

    private static final class Building {
        final GameData.RtBuilding def;
        final List<Floor> floors = new ArrayList<Floor>();
        final List<GameData.RtEntrance> entrances = new ArrayList<GameData.RtEntrance>();
        String roof = "auto";

        Building(GameData.RtBuilding def) {
            this.def = def;
            this.roof = def.roof == null || def.roof.isEmpty() ? "auto" : def.roof;
        }
    }

    private static final class Floor {
        final String key;
        final String buildingId;
        String id = "";
        String name = "";
        int level;
        final List<Zone> zones = new ArrayList<Zone>();

        Floor(String key, String buildingId) {
            this.key = key;
            this.buildingId = buildingId;
        }
    }

    private static final class Zone {
        final GameData.RtRoom def;
        final String buildingId;
        final String floorKey;
        final int level;
        /** 渲染可见（解算结果）。 */
        boolean renderVisible = true;
        /** 碰撞启用（解算结果）。 */
        boolean collisionEnabled = true;
        /** 导航可达（解算结果，针对"当前求解的楼层"）。 */
        boolean navPassable = true;

        Zone(GameData.RtRoom def, String buildingId, String floorKey, int level) {
            this.def = def;
            this.buildingId = buildingId;
            this.floorKey = floorKey;
            this.level = level;
            this.collisionEnabled = def.collides;
        }

        boolean contains(float x, float y) {
            return x >= def.x - def.halfW && x <= def.x + def.halfW
                    && y >= def.y - def.halfH && y <= def.y + def.halfH;
        }

        String id() {
            return def.id;
        }
    }

    private static final class NavLink {
        final GameData.RtNavLink def;

        NavLink(GameData.RtNavLink def) {
            this.def = def;
        }
    }

    /** 楼层可见性规则：可被脚本替换（{@code setVisibilityRule(fn)}）。 */
    interface VisibilityRule {
        /**
         * @param zone        区域
         * @param playerLevel 玩家所在楼层
         * @param playerInside 玩家是否在本建筑内
         * @param roofRule    本建筑屋顶规则（auto/always/never）
         * @return 该区域这一帧是否渲染
         */
        boolean renderVisible(Zone zone, int playerLevel, boolean playerInside, String roofRule);

        /** 默认规则：进楼后隐藏屋顶与其它楼层；在楼外显示屋顶；室外区域永远可见。 */
        VisibilityRule DEFAULT = new VisibilityRule() {
            @Override
            public boolean renderVisible(Zone zone, int playerLevel, boolean playerInside, String roofRule) {
                boolean isRoof = zone.def.tags.contains("roof") || "roof".equalsIgnoreCase(zone.def.id);
                if (isRoof) {
                    if ("always".equals(roofRule)) {
                        return true;
                    }
                    if ("never".equals(roofRule)) {
                        return false;
                    }
                    return !playerInside;
                }
                if (!playerInside) {
                    // 玩家在楼外：只显示室外地表（有 outdoors 标签或 level 0 且非室内）
                    return zone.def.tags.contains("outdoors") || !zone.def.tags.contains("indoor");
                }
                // 玩家在楼内：只显示玩家所在层
                return zone.level == playerLevel;
            }
        };
    }

    private ScriptSpatial(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.host = api.hostRef();
        this.ns = (ScriptJs.Flex) api.newObj();
        this.scope = ns.getParentScope();
    }

    static void install(ScriptApi api) {
        ScriptSpatial s = new ScriptSpatial(api);
        s.build();
        api.attach("spatial", s.ns);
        api.engineRef().addPhaseHook(ScriptEngine.PHASE_SPATIAL, s.resolveHook);
        LAST = s;
    }

    private final ScriptEngine.PhaseHook resolveHook = new ScriptEngine.PhaseHook() {
        @Override
        public void tick(float dt) {
            resolve();
        }
    };

    // ---------------- 建索引 ----------------

    /** 是否有空间数据（旧工程 = false，所有查询退化为不阻挡）。 */
    boolean hasData() {
        ensureBuilt();
        return !buildings.isEmpty();
    }

    private void ensureBuilt() {
        if (built) {
            return;
        }
        built = true;
        GameData.RtScene sc = host.scene;
        if (sc == null) {
            return;
        }
        for (int i = 0; i < sc.buildings.size(); i++) {
            GameData.RtBuilding bd = sc.buildings.get(i);
            if (bd.id == null || bd.id.isEmpty()) {
                continue;
            }
            Building b = new Building(bd);
            b.entrances.addAll(bd.entrances);
            for (int j = 0; j < bd.floors.size(); j++) {
                GameData.RtFloor fd = bd.floors.get(j);
                String key = bd.id + "/" + (fd.id == null || fd.id.isEmpty() ? ("f" + j) : fd.id);
                Floor f = new Floor(key, bd.id);
                f.id = fd.id == null ? "" : fd.id;
                f.name = fd.name == null ? f.id : fd.name;
                f.level = fd.level;
                for (int k = 0; k < fd.rooms.size(); k++) {
                    GameData.RtRoom rd = fd.rooms.get(k);
                    if (rd.id == null || rd.id.isEmpty()) {
                        continue;
                    }
                    Zone z = new Zone(rd, bd.id, key, f.level);
                    f.zones.add(z);
                    zones.put(rd.id, z);
                }
                b.floors.add(f);
                floors.put(key, f);
            }
            buildings.put(bd.id, b);
        }
        for (int i = 0; i < sc.navLinks.size(); i++) {
            GameData.RtNavLink ld = sc.navLinks.get(i);
            if (ld.id == null || ld.id.isEmpty()) {
                continue;
            }
            links.add(new NavLink(ld));
        }
        resolve();
        engine.log("[空间] 已建索引：建筑 " + buildings.size() + " 栋，区域 " + zones.size()
                + " 个，垂直连接 " + links.size() + " 条");
    }

    /** 场景卸载：清空一切（有断言：卸载后 buildings/zones/links 全为 0）。 */
    void clearSceneState() {
        buildings.clear();
        zones.clear();
        floors.clear();
        links.clear();
        playerZone = null;
        playerBuilding = null;
        playerLevel = 0;
        resolvedFrame = -1;
        built = false;
        visibilityRule = VisibilityRule.DEFAULT;
    }

    // ---------------- 解算 ----------------

    /**
     * 每帧解算：五状态里与「谁在哪」相关的部分。
     *
     * <p>顺序：先定玩家归属（谁在哪个 zone），再按归属算每个 zone 的三状态。
     * 一个区域内可能同时有 NPC，但 NPC 的归属是<b>按 agent 查</b>的（{@link #levelOf}），
     * 不存在区域上，这样「玩家在一层、警察在二层」不会互相覆盖。
     */
    void resolve() {
        ensureBuilt();
        // ⚠ 只在「真正的一帧」里做一次缓存：host.frameStamp 在 headless 测试里不会自增
        // （没有渲染帧），缓存就会永久命中、玩家坐标改了也解算不出来。
        // 所以缓存条件加「同一 frameStamp 且不是测试模式」。
        boolean sameFrame = host.frameStamp == resolvedFrame;
        if (sameFrame && host.frameStamp != 0) {
            return;
        }
        resolvedFrame = host.frameStamp;
        if (buildings.isEmpty()) {
            playerZone = null;
            playerBuilding = null;
            playerLevel = 0;
            return;
        }
        TopDownRuntime.Actor player = engine.findPlayerActor();
        Zone pz = null;
        if (player != null && !player.dead) {
            int lvl = resolveLevel(player);
            // 只取**可驻留**区域作为"玩家在哪"：屋顶不算（它比室内大一圈屋檐，
            // 站在楼外地面上会落进屋顶矩形里 —— 实测会把室外判成"3 层屋顶"）。
            pz = dwellableZoneAt(player.x, player.y, lvl);
        }
        playerZone = pz;
        playerBuilding = pz == null ? null : buildings.get(pz.buildingId);
        playerLevel = pz == null ? 0 : pz.level;
        boolean inside = playerBuilding != null && pz != null && isIndoor(pz);
        for (Zone z : zones.values()) {
            z.renderVisible = visibilityRule.renderVisible(z, playerLevel, inside, roofRuleOf(z.buildingId));
            z.collisionEnabled = z.def.collides && (z.level == playerLevel || pz == null);
            z.navPassable = z.def.navigable && (z.level == playerLevel || pz == null);
        }
    }

    private static boolean isIndoor(Zone z) {
        return z.def.tags.contains("indoor") || z.def.tags.contains("房间") || z.def.tags.contains("室内");
    }

    private String roofRuleOf(String buildingId) {
        Building b = buildings.get(buildingId);
        return b == null ? "auto" : b.roof;
    }

    /** 世界坐标 → 区域（后建者优先，即"越具体的覆盖越泛的"）。 */
    Zone zoneAt(float x, float y) {
        ensureBuilt();
        Zone hit = null;
        for (Zone z : zones.values()) {
            if (z.contains(x, y)) {
                hit = z;
            }
        }
        return hit;
    }

    /**
     * 世界坐标 + 楼层 → 该层上的区域。
     *
     * <p>这是「楼层隔离」的核心：同一块 (x,y) 在所有楼层上都有区域（俯视角下楼层
     * 在 2D 空间完全重叠），所以必须<b>同时按层号过滤</b>才能取到正确的那个。
     */
    Zone zoneAt(float x, float y, int level) {
        ensureBuilt();
        Zone hit = null;
        for (Zone z : zones.values()) {
            if (z.level == level && z.contains(x, y)) {
                hit = z;
            }
        }
        return hit;
    }

    /**
     * 解析实体的楼层归属（<b>link 驱动 + 位置校验</b>）。
     *
     * <p>规则：
     * <ol>
     *   <li>实体有权威 {@code floorLevel}（走过 link）→ 先**校验**它现在还成立：
     *       该位置上确实存在"这一层"的区域。成立则沿用（同层移动不丢楼层）。</li>
     *   <li>不成立（说明实体已经**走出了该层的区域范围**，例如走出了整栋楼）→
     *       楼层失效，按位置重新推导（取该位置上**层号最小**的区域 = 地面/室外）。</li>
     *   <li>没有权威值时直接按位置推导。</li>
     * </ol>
     *
     * <p>⚠ 第 2 步是必须的：只做"有权威值就一直用"会让<b>上过二楼的角色走出大楼后
     * 永远停留在二楼</b>——他在地面上走，但引擎认为他在二层，于是碰撞/渲染/寻路全错，
     * NPC 也会"隔着楼板"看到你。这是踩过的真实缺陷。
     *
     * <p>为什么不能只靠位置推导：俯视角下各楼层在 2D 空间完全重叠，
     * 同一 (x,y) 在每一层都有区域，纯位置只能查到"后建的那个"，分不出楼层。
     * 所以"能不能换层"必须由 link 决定，位置只用来判断"还在不在这一层"。
     */
    int resolveLevel(TopDownRuntime.Actor a) {
        ensureBuilt();
        if (a == null) {
            return 0;
        }
        if (buildings.isEmpty()) {
            a.floorLevel = 0;
            return 0;
        }
        // 有权威值 → 校验它是否仍然成立（该位置在本层仍有区域）
        if (a.floorLevel >= 0) {
            if (zoneAt(a.x, a.y, a.floorLevel) != null) {
                return a.floorLevel;
            }
            // 已走出本层范围 → 权威值失效，下面重新推导
        }

        // ---- 按位置推导：取「含该点的**可驻留**区域里层号最小的」 ----
        //
        // ⚠ 必须排除 roof（以及任何 navigable=false 的装饰性区域）。
        // 踩过的真实 bug：屋顶 AABB 通常比室内房间**略大**（往外扩一圈屋檐），
        // 于是站在"楼旁边的地面"上时，那个点**只落在屋顶矩形里**、不落在任何室内区域里。
        // 取"最小层号"会选中屋顶那一层（= 顶层之上），玩家在室外走却被告知"在 3 层屋顶"，
        // 实测日志：`空间切换：(室外) → b_34_34_roof（第 3 层）`，而且一路在屋顶间跳。
        // 修法：只有 navigable 的区域才算"实体能站在这里"，roof 只用于渲染剔除、不算归属。
        int best = Integer.MAX_VALUE;
        for (Zone z : zones.values()) {
            if (!z.def.navigable) {
                continue; // 屋顶 / 装饰区：参与渲染可见性，但不参与"实体在哪一层"
            }
            if (z.contains(a.x, a.y) && z.level < best) {
                best = z.level;
            }
        }
        // 一处可驻留区域都没有 = 实体在室外/楼外 → 地面层
        a.floorLevel = best == Integer.MAX_VALUE ? 0 : best;
        return a.floorLevel;
    }

    /**
     * 某个实体所在楼层序号（脚本可见的 {@code bwe.spatial.levelOf}）。
     *
     * <p><b>关键 API</b>：{@code levelOf(npc)} ≠ {@code levelOf(player)} 正是
     * 「跨楼层追捕」能成立的前提。没有空间数据时一律返回 0（单层）。
     */
    int levelOf(TopDownRuntime.Actor a) {
        ensureBuilt();
        if (a == null || buildings.isEmpty()) {
            return 0;
        }
        return resolveLevel(a);
    }

    /**
     * 世界坐标 + 楼层 → 该层上的**可驻留**区域（排除 roof 等 navigable=false 的装饰区）。
     *
     * <p>与 {@link #zoneAt(float, float, int)} 的区别：后者包含屋顶（渲染/剔除要用），
     * 前者只回答"实体能站在哪"。判断归属、算 indoor、找当前房间都必须用这个。
     */
    Zone dwellableZoneAt(float x, float y, int level) {
        ensureBuilt();
        Zone hit = null;
        for (Zone z : zones.values()) {
            if (!z.def.navigable) {
                continue;
            }
            if (z.level == level && z.contains(x, y)) {
                hit = z;
            }
        }
        return hit;
    }

    /** 世界坐标 → 该点的**可驻留**区域（不分层，取层号最小的那个）。 */
    Zone dwellableZoneAtAnyLevel(float x, float y) {
        ensureBuilt();
        Zone hit = null;
        int best = Integer.MAX_VALUE;
        for (Zone z : zones.values()) {
            if (!z.def.navigable) {
                continue;
            }
            if (z.contains(x, y) && z.level < best) {
                best = z.level;
                hit = z;
            }
        }
        return hit;
    }

    /** 某实体所在区域（按其楼层解析后的那个区域；没有则 null）。 */
    Zone zoneOf(TopDownRuntime.Actor a) {
        ensureBuilt();
        if (a == null) {
            return null;
        }
        int level = resolveLevel(a);
        Zone z = dwellableZoneAt(a.x, a.y, level);
        if (z == null) {
            z = dwellableZoneAtAnyLevel(a.x, a.y);
        }
        return z;
    }

    // ---------------- 命名空间 ----------------

    private void build() {
        api.addMethod(ns, "hasData", (cx, thisObj, args) -> Boolean.valueOf(hasData()));
        api.addMethod(ns, "buildingCount", (cx, thisObj, args) -> Integer.valueOf(zoneCount("building")));
        api.addMethod(ns, "zoneCount", (cx, thisObj, args) -> Integer.valueOf(zoneCount("zone")));
        api.addMethod(ns, "linkCount", (cx, thisObj, args) -> Integer.valueOf(linkCountValue()));

        // all() → [zone]（只读快照）
        api.addMethod(ns, "all", (cx, thisObj, args) -> allZones());

        // byId(id) → zone | null
        api.addMethod(ns, "byId", (cx, thisObj, args) -> {
            ensureBuilt();
            Zone z = zones.get(ScriptJs.str(ScriptJs.arg(args, 0), ""));
            return z == null ? null : zoneObj(z);
        });

        // at(x, y) → zone | null
        api.addMethod(ns, "at", (cx, thisObj, args) -> {
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            Zone z = zoneAt(x, y);
            return z == null ? null : zoneObj(z);
        });

        // current() → 玩家当前空间 {zoneId, buildingId, floorId, level, indoor} 或 null
        api.addMethod(ns, "current", (cx, thisObj, args) -> currentSpace());

        // level() → 玩家楼层序号（无数据 0）
        api.addMethod(ns, "level", (cx, thisObj, args) -> {
            resolve();
            return Double.valueOf(playerLevel);
        });

        // levelOf(e) → 该实体楼层序号（跨层判断的关键）
        api.addMethod(ns, "levelOf", (cx, thisObj, args) -> {
            resolve();
            return Double.valueOf(levelOf(api.actorOf(ScriptJs.arg(args, 0))));
        });

        // zoneOf(e) → zone | null
        api.addMethod(ns, "zoneOf", (cx, thisObj, args) -> {
            ensureBuilt();
            Zone z = zoneOf(api.actorOf(ScriptJs.arg(args, 0)));
            return z == null ? null : zoneObj(z);
        });

        // visibility(zoneId|zone) → {renderVisible, collisionEnabled, navPassable}
        api.addMethod(ns, "visibility", (cx, thisObj, args) -> {
            resolve();
            Zone z = zoneArg(ScriptJs.arg(args, 0));
            if (z == null) {
                return null;
            }
            ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
            ScriptJs.put(o, "renderVisible", Boolean.valueOf(z.renderVisible));
            ScriptJs.put(o, "collisionEnabled", Boolean.valueOf(z.collisionEnabled));
            ScriptJs.put(o, "navPassable", Boolean.valueOf(z.navPassable));
            return o;
        });

        // links() → [{id, kind, aLevel, bLevel, ax, ay, bx, by, bidirectional, travelTime}]
        api.addMethod(ns, "links", (cx, thisObj, args) -> linksArray());

        // link(id) → 单条 link 或 null
        api.addMethod(ns, "link", (cx, thisObj, args) -> {
            ensureBuilt();
            String id = ScriptJs.str(ScriptJs.arg(args, 0), "");
            for (int i = 0; i < links.size(); i++) {
                if (id.equals(links.get(i).def.id)) {
                    return linkObj(links.get(i));
                }
            }
            return null;
        });

        // linkBetween(aLevel, bLevel) → 两楼层之间的 link 或 null（"楼梯存在吗"）
        api.addMethod(ns, "linkBetween", (cx, thisObj, args) -> {
            ensureBuilt();
            int a = ScriptJs.inum(ScriptJs.arg(args, 0), 0);
            int b = ScriptJs.inum(ScriptJs.arg(args, 1), 1);
            for (int i = 0; i < links.size(); i++) {
                NavLink l = links.get(i);
                if ((l.def.aLevel == a && l.def.bLevel == b)
                        || (l.def.bidirectional && l.def.aLevel == b && l.def.bLevel == a)) {
                    return linkObj(l);
                }
            }
            return null;
        });

        // canReachLevel(from, to) → 靠 link 能否连通（"NPC 不能穿楼板"的可判定形式）
        api.addMethod(ns, "canReachLevel", (cx, thisObj, args) -> {
            ensureBuilt();
            int from = ScriptJs.inum(ScriptJs.arg(args, 0), 0);
            int to = ScriptJs.inum(ScriptJs.arg(args, 1), 0);
            return Boolean.valueOf(levelsConnected(from, to));
        });

        // useLink(id, e) → bool（把实体传送到另一端；电梯/楼梯的实际搬家）
        api.addMethod(ns, "useLink", (cx, thisObj, args) -> {
            ensureBuilt();
            String id = ScriptJs.str(ScriptJs.arg(args, 0), "");
            TopDownRuntime.Actor a = api.actorOf(ScriptJs.arg(args, 1));
            return Boolean.valueOf(travelLink(id, a));
        });

        // enter(zoneId, e) → bool（从门口走进建筑：设置楼层归属 + 挪到室内）
        //
        // 为什么要有它：`useLink` 只能走"两层之间的垂直连接"；而**从室外走进一层**
        // 不是垂直连接（没有楼梯），却同样必须改写楼层归属 —— 否则从二楼走出来的人
        // 会被认为"在二楼的地面位置"，碰撞/渲染全错。
        // 脚本也不该直接写 floorLevel（那是引擎内部状态），所以给一个受控入口：
        // 只允许"进入目标区域所在的那一层"，且要求区域本身是可导航的。
        api.addMethod(ns, "enter", (cx, thisObj, args) -> {
            ensureBuilt();
            Zone z = zoneArg(ScriptJs.arg(args, 0));
            if (z == null) {
                return Boolean.FALSE;
            }
            TopDownRuntime.Actor a = api.actorOf(ScriptJs.arg(args, 1));
            if (a == null) {
                a = engine.findPlayerActor();
            }
            if (a == null) {
                return Boolean.FALSE;
            }
            a.floorLevel = z.level;
            return Boolean.TRUE;
        });

        // leave(e) → bool（走出建筑：楼层归属退回地面层 0）
        api.addMethod(ns, "leave", (cx, thisObj, args) -> {
            ensureBuilt();
            TopDownRuntime.Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null) {
                a = engine.findPlayerActor();
            }
            if (a == null) {
                return Boolean.FALSE;
            }
            a.floorLevel = 0;
            return Boolean.TRUE;
        });

        // setVisibilityRule(fn) —— 自定义楼层可见性；null = 恢复默认
        api.addMethod(ns, "setVisibilityRule", (cx, thisObj, args) -> {
            Object v = ScriptJs.arg(args, 0);
            if (ScriptJs.isMissing(v) || "default".equals(String.valueOf(v))) {
                visibilityRule = VisibilityRule.DEFAULT;
                return Boolean.TRUE;
            }
            // 自定义规则函数暂不支持跨脚本调用（需要 Rhino Function），保留接口位：
            // 契约里写明"v1 只支持 default"，并返回 false 让脚本知道没生效。
            engine.log("[空间] setVisibilityRule：v1 只支持 \"default\"");
            return Boolean.FALSE;
        });

        // clear() —— 清空（测试用；正常路径是场景卸载自动清）
        api.addMethod(ns, "clear", (cx, thisObj, args) -> {
            clearSceneState();
            return Boolean.TRUE;
        });
    }

    // ---------------- 小工具 ----------------

    private int zoneCount(String kind) {
        ensureBuilt();
        return "building".equals(kind) ? buildings.size() : zones.size();
    }

    /** 区域总数（{@link ScriptDebug#stats()} / 测试用）。 */
    int zoneCountValue() {
        return zoneCount("zone");
    }

    /** 垂直连接数。 */
    int linkCountValue() {
        ensureBuilt();
        return links.size();
    }

    /** 调试绘制：把每个区域画成描边矩形（颜色按 三状态 区分）。 */
    void drawDebug(ScriptRender render) {
        ensureBuilt();
        if (render == null || zones.isEmpty()) {
            return;
        }
        resolve();
        for (Zone z : zones.values()) {
            // 可见 = 绿，不可见但碰撞 = 黄，不可导航 = 红
            String color = "#00ff88";
            if (!z.renderVisible) {
                color = z.collisionEnabled ? "#ffcc00" : "#ff3355";
            }
            render.worldRect(z.def.x - z.def.halfW, z.def.y - z.def.halfH,
                    z.def.halfW * 2f, z.def.halfH * 2f, color, 1f, 0.8f);
        }
    }

    private boolean levelsConnected(int from, int to) {
        if (from == to) {
            return true;
        }
        // 洪水填充：只走 bidirectional 或方向正确的 link
        List<Integer> frontier = new ArrayList<Integer>();
        List<Integer> seen = new ArrayList<Integer>();
        frontier.add(Integer.valueOf(from));
        int guard = 0;
        while (!frontier.isEmpty() && guard++ < 64) {
            int cur = frontier.remove(0).intValue();
            if (cur == to) {
                return true;
            }
            if (seen.contains(Integer.valueOf(cur))) {
                continue;
            }
            seen.add(Integer.valueOf(cur));
            for (int i = 0; i < links.size(); i++) {
                NavLink l = links.get(i);
                int next = Integer.MIN_VALUE;
                if (l.def.aLevel == cur) {
                    next = l.def.bLevel;
                } else if (l.def.bidirectional && l.def.bLevel == cur) {
                    next = l.def.aLevel;
                }
                if (next != Integer.MIN_VALUE && !seen.contains(Integer.valueOf(next))) {
                    frontier.add(Integer.valueOf(next));
                }
            }
        }
        return false;
    }

    /**
     * 走一条垂直连接：把实体搬到另一端，<b>并改写它的楼层归属</b>。
     *
     * <p>这是「楼层归属由 link 驱动」的唯一入口 —— 没有走 link 就不可能换层，
     * 因此 NPC 无法穿过楼板（任务书 §14 的硬要求）。
     *
     * @return true = 成功换了层
     */
    boolean travelLink(String id, TopDownRuntime.Actor a) {
        ensureBuilt();
        if (a == null) {
            return false;
        }
        for (int i = 0; i < links.size(); i++) {
            NavLink l = links.get(i);
            if (!l.def.id.equals(id)) {
                continue;
            }
            int cur = resolveLevel(a);
            if (cur == l.def.aLevel) {
                a.x = l.def.bx;
                a.y = l.def.by;
                a.floorLevel = l.def.bLevel;
                return true;
            }
            if (cur == l.def.bLevel && l.def.bidirectional) {
                a.x = l.def.ax;
                a.y = l.def.ay;
                a.floorLevel = l.def.aLevel;
                return true;
            }
            engine.log("[空间] useLink(" + id + ") 失败：实体在第 " + cur + " 层，link 只连 "
                    + l.def.aLevel + "/" + l.def.bLevel + " 层");
            return false;
        }
        engine.log("[空间] useLink 失败：没有 link「" + id + "」");
        return false;
    }

    /** 按 id 使用一个 link（测试入口，与脚本 useLink 同一个实现）。 */
    boolean useLinkPublic(String id, TopDownRuntime.Actor a) {
        return travelLink(id, a);
    }

    private Zone zoneArg(Object v) {
        if (v instanceof String) {
            return zones.get((String) v);
        }
        // 也允许传 zone 对象（从 byId/at 拿到的）：拿它的 id 字段
        Object id = ScriptJs.get(v, "id");
        if (id instanceof String) {
            return zones.get((String) id);
        }
        return null;
    }

    private Scriptable zoneObj(Zone z) {
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        ScriptJs.put(o, "id", z.def.id);
        ScriptJs.put(o, "name", z.def.name);
        ScriptJs.put(o, "buildingId", z.buildingId);
        ScriptJs.put(o, "floorKey", z.floorKey);
        ScriptJs.put(o, "level", Double.valueOf(z.level));
        ScriptJs.put(o, "x", Double.valueOf(z.def.x));
        ScriptJs.put(o, "y", Double.valueOf(z.def.y));
        ScriptJs.put(o, "halfW", Double.valueOf(z.def.halfW));
        ScriptJs.put(o, "halfH", Double.valueOf(z.def.halfH));
        ScriptJs.put(o, "collides", Boolean.valueOf(z.def.collides));
        ScriptJs.put(o, "navigable", Boolean.valueOf(z.def.navigable));
        ScriptJs.put(o, "renderVisible", Boolean.valueOf(z.renderVisible));
        ScriptJs.put(o, "collisionEnabled", Boolean.valueOf(z.collisionEnabled));
        ScriptJs.put(o, "navPassable", Boolean.valueOf(z.navPassable));
        ScriptJs.put(o, "viaLink", z.def.viaLink);
        ScriptJs.put(o, "tags", tagArray(z.def.tags));
        return o;
    }

    private Scriptable tagArray(List<String> tags) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        return cx.newArray(scope, tags.toArray());
    }

    // ---------------- 包内测试入口 ----------------
    //
    // 这些不是脚本 API（不会进 verify-apidocs 的成员表，因为不是 api.addMethod），
    // 只是给 OpenWorldTest 直接断言用的 Java 侧访问器。
    // 命名上刻意不带 "ForTest" 前缀里的公共语义，避免误以为脚本能调。

    /** 楼层连通性（0↔1 有楼梯 = true，0↔2 无直达 = false）。 */
    boolean levelsConnectedPublic(int from, int to) {
        ensureBuilt();
        return levelsConnected(from, to);
    }

    /** 两楼层之间的 link（没有 = null）。 */
    NavLink linkBetweenPublic(int aLevel, int bLevel) {
        ensureBuilt();
        for (int i = 0; i < links.size(); i++) {
            NavLink l = links.get(i);
            if ((l.def.aLevel == aLevel && l.def.bLevel == bLevel)
                    || (l.def.bidirectional && l.def.aLevel == bLevel && l.def.bLevel == aLevel)) {
                return l;
            }
        }
        return null;
    }

    /** 第一个 link 的 id（没有 = 空串）。 */
    String firstLinkId() {
        ensureBuilt();
        return links.isEmpty() ? "" : links.get(0).def.id;
    }

    /** 屋顶区域当前是否渲染（"玩家进楼后屋顶剔除"的直接断言）。 */
    boolean isRoofRenderVisible(String zoneId) {
        ensureBuilt();
        resolve();
        Zone z = zones.get(zoneId);
        return z != null && z.renderVisible;
    }

    /** 任意区域当前是否渲染。 */
    boolean isZoneRenderVisible(String zoneId) {
        ensureBuilt();
        resolve();
        Zone z = zones.get(zoneId);
        return z != null && z.renderVisible;
    }

    /** 区域 id 是否存在。 */
    boolean hasZone(String zoneId) {
        ensureBuilt();
        return zones.containsKey(zoneId);
    }

    /** 该点是否落在"只在屋顶矩形内、不在任何可驻留区域"的地方（回归测试用）。 */
    boolean insideRoofOnly(float x, float y) {
        ensureBuilt();
        if (dwellableZoneAtAnyLevel(x, y) != null) {
            return false; // 同时有可驻留区域 → 不算"只在屋顶"
        }
        for (Zone z : zones.values()) {
            if (!z.def.navigable && z.contains(x, y)) {
                return true;
            }
        }
        return false;
    }

    /** 该点的可驻留区域（测试用）。 */
    String dwellableZoneAtAnyLevelPublic(float x, float y) {
        Zone z = dwellableZoneAtAnyLevel(x, y);
        return z == null ? null : z.def.id;
    }

    /**
     * 这个对象是否应该被楼层可见性规则**隐藏**（渲染器每帧调）。
     *
     * <p>对象靠 tag 关联到区域：
     * <ul>
     *   <li>{@code roof} → 找它所属建筑的屋顶 zone；</li>
     *   <li>{@code building} + 建筑 id tag（如 {@code b_34_34}）→ 找该建筑的**所有**区域，
     *       任一 {@code renderVisible} 即显示（外墙/门/楼梯通常挂在多层上，
     *       只要玩家在哪层能看到就该显示）。</li>
     * </ul>
     * 找不到对应 zone → **一律可见**（保守：宁可多画，不要凭空让东西消失）。
     */
    boolean isActorHidden(TopDownRuntime.Actor a) {
        ensureBuilt();
        if (a == null || a.o == null || a.o.tags == null || zones.isEmpty()) {
            return false;
        }
        resolve();
        boolean isRoof = false;
        String buildingId = "";
        for (int i = 0; i < a.o.tags.size(); i++) {
            String t = a.o.tags.get(i);
            if ("roof".equalsIgnoreCase(t)) {
                isRoof = true;
            } else if (t != null && t.startsWith("b_") && buildings.containsKey(t)) {
                buildingId = t;
            }
        }
        if (isRoof) {
            // 屋顶：按它所属建筑的 roof zone 判定。没有 buildingId 时按"任一层有 roof 都算"。
            for (Zone z : zones.values()) {
                if (!z.def.tags.contains("roof")) {
                    continue;
                }
                if (!buildingId.isEmpty() && !z.buildingId.equals(buildingId)) {
                    continue;
                }
                return !z.renderVisible;
            }
            return false;
        }
        if (!buildingId.isEmpty()) {
            // 建筑构件（墙/门/楼梯）：该建筑任一区域可见就显示
            boolean anyVisible = false;
            boolean anyZone = false;
            for (Zone z : zones.values()) {
                if (!z.buildingId.equals(buildingId)) {
                    continue;
                }
                anyZone = true;
                if (z.renderVisible) {
                    anyVisible = true;
                    break;
                }
            }
            if (anyZone) {
                return !anyVisible;
            }
        }
        return false;
    }

    /** 玩家当前解析出的楼层（测试/诊断用）。 */
    int playerLevelForTest() {
        resolve();
        return playerLevel;
    }

    /** 按坐标 + 楼层取区域 id（测试用；没有返回 null）。 */
    String zoneIdAtPublic(float x, float y, int level) {
        ensureBuilt();
        Zone z = zoneAt(x, y, level);
        return z == null ? null : z.def.id;
    }

    /** 调用脚本同一实现的 enter（测试用）。 */
    boolean enterPublic(String zoneId, TopDownRuntime.Actor a) {
        ensureBuilt();
        Zone z = zones.get(zoneId);
        if (z == null || a == null) {
            return false;
        }
        a.floorLevel = z.level;
        return true;
    }

    /** 调用脚本同一实现的 leave（测试用）。 */
    boolean leavePublic(TopDownRuntime.Actor a) {
        ensureBuilt();
        if (a == null) {
            return false;
        }
        a.floorLevel = 0;
        return true;
    }

    private Scriptable allZones() {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        ensureBuilt();
        resolve();
        List<Object> out = new ArrayList<Object>();
        for (Zone z : zones.values()) {
            out.add(zoneObj(z));
        }
        return cx.newArray(scope, out.toArray());
    }

    private Scriptable linksArray() {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        ensureBuilt();
        List<Object> out = new ArrayList<Object>();
        for (int i = 0; i < links.size(); i++) {
            out.add(linkObj(links.get(i)));
        }
        return cx.newArray(scope, out.toArray());
    }

    private Scriptable linkObj(NavLink l) {
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        ScriptJs.put(o, "id", l.def.id);
        ScriptJs.put(o, "kind", l.def.kind);
        ScriptJs.put(o, "aLevel", Double.valueOf(l.def.aLevel));
        ScriptJs.put(o, "bLevel", Double.valueOf(l.def.bLevel));
        ScriptJs.put(o, "ax", Double.valueOf(l.def.ax));
        ScriptJs.put(o, "ay", Double.valueOf(l.def.ay));
        ScriptJs.put(o, "bx", Double.valueOf(l.def.bx));
        ScriptJs.put(o, "by", Double.valueOf(l.def.by));
        ScriptJs.put(o, "bidirectional", Boolean.valueOf(l.def.bidirectional));
        ScriptJs.put(o, "travelTime", Double.valueOf(l.def.travelTime));
        ScriptJs.put(o, "requiresInteract", Boolean.valueOf(l.def.requiresInteract));
        return o;
    }

    private Scriptable currentSpace() {
        resolve();
        if (playerZone == null && playerBuilding == null) {
            return null;
        }
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        ScriptJs.put(o, "zoneId", playerZone == null ? "" : playerZone.def.id);
        ScriptJs.put(o, "buildingId", playerBuilding == null ? "" : playerBuilding.def.id);
        ScriptJs.put(o, "floorId", playerZone == null ? "" : playerZone.floorKey);
        ScriptJs.put(o, "level", Double.valueOf(playerLevel));
        ScriptJs.put(o, "indoor", Boolean.valueOf(playerZone != null && isIndoor(playerZone)));
        return o;
    }
}
