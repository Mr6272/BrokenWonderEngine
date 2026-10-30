package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Scriptable;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.PriorityQueue;
import java.util.Comparator;
import java.util.Map;

/**
 * 道路网络命名空间 {@code bwe.road}（契约 {@code docs/api/vehicle.md}；
 * 设计 {@code docs/open-world-architecture.md} §7）。
 *
 * <h3>为什么车辆不能复用瓦片 A*</h3>
 * 任务书 §18 明确："道路网络应具备明确的节点、路段和路口连接，不能只让车辆沿固定直线移动"。
 * 瓦片 A* 是<b>每格 8 方向</b>的，车辆走它会贴着墙角、无法表达车道宽度/限速/单行，
 * 也做不出"路口转弯"。所以路网是<b>独立的图</b>：
 * <pre>
 *   nodes（路口 / 途经点 / 站点）  +  edges（路段：宽、限速、单行）
 *            ↓
 *   route(from, to) = 在地图上跑 Dijkstra/A*，权重 = 长度 / 限速
 * </pre>
 *
 * <h3>与 bwe.nav 的关系</h3>
 * 行人用 {@code bwe.nav}（瓦片 A*）；车辆用 {@code bwe.road}（路网图）。
 * 两者<b>互不替代</b>，这正是任务书 §18「车辆移动与行人导航应使用不同的导航配置」。
 *
 * <h3>没有路网数据时</h3>
 * {@link #hasData()} false，所有查询返回空 —— 现有游戏（俯视角JS示例等）完全不受影响。
 */
final class ScriptRoad {

    static ScriptRoad LAST;

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final TopDownRuntime host;
    private final Scriptable scope;
    private final ScriptJs.Flex ns;

    private final Map<String, Node> nodes = new LinkedHashMap<String, Node>();
    /** 邻接表：nodeId → 边列表。 */
    private final Map<String, List<Edge>> adjacency = new LinkedHashMap<String, List<Edge>>();
    private final List<Edge> edges = new ArrayList<Edge>();

    private boolean built;

    /** 路径缓存：key = "from>to"，value = 节点 id 列表。阻挡变化时才失效。 */
    private final Map<String, List<String>> routeCache = new LinkedHashMap<String, List<String>>();
    private static final int MAX_CACHE = 256;

    private static final class Node {
        final String id;
        final float x;
        final float y;
        final String kind;

        Node(String id, float x, float y, String kind) {
            this.id = id;
            this.x = x;
            this.y = y;
            this.kind = kind;
        }
    }

    private static final class Edge {
        final String from;
        final String to;
        final float width;
        final float speedLimit;
        final boolean oneway;
        /** 两点距离（预计算）。 */
        final float length;

        Edge(String from, String to, float width, float speedLimit, boolean oneway, float length) {
            this.from = from;
            this.to = to;
            this.width = width;
            this.speedLimit = speedLimit;
            this.oneway = oneway;
            this.length = length;
        }
    }

    private ScriptRoad(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.host = api.hostRef();
        this.ns = (ScriptJs.Flex) api.newObj();
        this.scope = ns.getParentScope();
    }

    static void install(ScriptApi api) {
        ScriptRoad r = new ScriptRoad(api);
        r.build();
        api.attach("road", r.ns);
        LAST = r;
    }

    // ---------------- 建图 ----------------

    boolean hasData() {
        ensureBuilt();
        return !nodes.isEmpty();
    }

    private void ensureBuilt() {
        if (built) {
            return;
        }
        built = true;
        GameData.RtScene sc = host.scene;
        if (sc == null || sc.road == null) {
            return;
        }
        for (int i = 0; i < sc.road.nodes.size(); i++) {
            GameData.RtRoadNode nd = sc.road.nodes.get(i);
            if (nd.id == null || nd.id.isEmpty()) {
                continue;
            }
            nodes.put(nd.id, new Node(nd.id, nd.x, nd.y,
                    nd.kind == null || nd.kind.isEmpty() ? "waypoint" : nd.kind));
        }
        for (int i = 0; i < sc.road.edges.size(); i++) {
            GameData.RtRoadEdge ed = sc.road.edges.get(i);
            Node a = nodes.get(ed.from);
            Node b = nodes.get(ed.to);
            if (a == null || b == null) {
                continue;
            }
            addEdge(ed.from, ed.to, ed.width, ed.speedLimit, ed.oneway);
            if (!ed.oneway) {
                addEdge(ed.to, ed.from, ed.width, ed.speedLimit, false);
            }
        }
        if (!nodes.isEmpty()) {
            engine.log("[路网] 已建图：节点 " + nodes.size() + " 个，有向边 " + edges.size() + " 条");
        }
    }

    private void addEdge(String from, String to, float width, float speedLimit, boolean oneway) {
        Node a = nodes.get(from);
        Node b = nodes.get(to);
        if (a == null || b == null) {
            return;
        }
        float dx = b.x - a.x;
        float dy = b.y - a.y;
        float len = (float) Math.sqrt(dx * dx + dy * dy);
        Edge e = new Edge(from, to, Math.max(1f, width), Math.max(1f, speedLimit), oneway, len);
        edges.add(e);
        List<Edge> list = adjacency.get(from);
        if (list == null) {
            list = new ArrayList<Edge>();
            adjacency.put(from, list);
        }
        list.add(e);
    }

    /** 清缓存（路网被脚本改过 / 场景卸载）。 */
    void invalidateRoutes() {
        routeCache.clear();
    }

    /** 最近的节点 id（没有节点返回空串）。供 {@code bwe.vehicle.followRoad} 用。 */
    String nearestId(float x, float y) {
        ensureBuilt();
        Node best = null;
        float bestD = Float.MAX_VALUE;
        for (Node n : nodes.values()) {
            float dx = n.x - x;
            float dy = n.y - y;
            float d = dx * dx + dy * dy;
            if (d < bestD) {
                bestD = d;
                best = n;
            }
        }
        return best == null ? "" : best.id;
    }

    /** 一串节点 id → 世界坐标点列表（车辆沿它开）。 */
    java.util.List<float[]> routePoints(java.util.List<String> ids) {
        java.util.List<float[]> out = new java.util.ArrayList<float[]>();
        for (int i = 0; i < ids.size(); i++) {
            Node n = nodes.get(ids.get(i));
            if (n != null) {
                out.add(new float[]{n.x, n.y});
            }
        }
        return out;
    }

    // ---------------- 命名空间 ----------------

    private void build() {
        api.addMethod(ns, "hasData", (cx, thisObj, args) -> Boolean.valueOf(hasData()));
        api.addMethod(ns, "nodeCount", (cx, thisObj, args) -> Integer.valueOf(nodeCountValue()));
        api.addMethod(ns, "edgeCount", (cx, thisObj, args) -> Integer.valueOf(edgeCountValue()));

        // nodes() → [{id,x,y,kind}]
        api.addMethod(ns, "nodes", (cx, thisObj, args) -> nodesArray());

        // edges() → [{from,to,width,speedLimit,oneway,length}]
        api.addMethod(ns, "edges", (cx, thisObj, args) -> edgesArray());

        // node(id) → {id,x,y,kind} | null
        api.addMethod(ns, "node", (cx, thisObj, args) -> {
            ensureBuilt();
            Node n = nodes.get(ScriptJs.str(ScriptJs.arg(args, 0), ""));
            return n == null ? null : nodeObj(n);
        });

        // nearest(x, y) → {id,x,y,kind,dist} | null
        api.addMethod(ns, "nearest", (cx, thisObj, args) -> {
            ensureBuilt();
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            Node best = null;
            float bestD = Float.MAX_VALUE;
            for (Node n : nodes.values()) {
                float dx = n.x - x;
                float dy = n.y - y;
                float d = dx * dx + dy * dy;
                if (d < bestD) {
                    bestD = d;
                    best = n;
                }
            }
            if (best == null) {
                return null;
            }
            ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
            ScriptJs.put(o, "id", best.id);
            ScriptJs.put(o, "x", Double.valueOf(best.x));
            ScriptJs.put(o, "y", Double.valueOf(best.y));
            ScriptJs.put(o, "kind", best.kind);
            ScriptJs.put(o, "dist", Double.valueOf(Math.sqrt(bestD)));
            return o;
        });

        // route(from, to) → [{x,y,id}] | []（不可达 = 空）
        api.addMethod(ns, "route", (cx, thisObj, args) -> {
            ensureBuilt();
            String from = nodeIdArg(ScriptJs.arg(args, 0));
            String to = nodeIdArg(ScriptJs.arg(args, 1));
            List<String> path = findRoute(from, to);
            List<Object> out = new ArrayList<Object>();
            for (int i = 0; i < path.size(); i++) {
                Node n = nodes.get(path.get(i));
                if (n == null) {
                    continue;
                }
                ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
                ScriptJs.put(o, "id", n.id);
                ScriptJs.put(o, "x", Double.valueOf(n.x));
                ScriptJs.put(o, "y", Double.valueOf(n.y));
                ScriptJs.put(o, "kind", n.kind);
                out.add(o);
            }
            return toArray(out);
        });

        // canReach(from, to) → bool
        api.addMethod(ns, "canReach", (cx, thisObj, args) -> {
            ensureBuilt();
            String from = nodeIdArg(ScriptJs.arg(args, 0));
            String to = nodeIdArg(ScriptJs.arg(args, 1));
            return Boolean.valueOf(!findRoute(from, to).isEmpty());
        });

        // routeThrough(from, via, to) → 依次走两段（出租车"先接客再送客"）
        api.addMethod(ns, "routeThrough", (cx, thisObj, args) -> {
            ensureBuilt();
            String from = nodeIdArg(ScriptJs.arg(args, 0));
            String via = nodeIdArg(ScriptJs.arg(args, 1));
            String to = nodeIdArg(ScriptJs.arg(args, 2));
            List<String> a = findRoute(from, via);
            List<String> b = findRoute(via, to);
            List<Object> out = new ArrayList<Object>();
            if (a.isEmpty() || b.isEmpty()) {
                return toArray(out);
            }
            List<String> merged = new ArrayList<String>(a);
            if (!merged.isEmpty()) {
                merged.remove(merged.size() - 1);
            }
            merged.addAll(b);
            for (int i = 0; i < merged.size(); i++) {
                Node n = nodes.get(merged.get(i));
                if (n == null) {
                    continue;
                }
                ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
                ScriptJs.put(o, "id", n.id);
                ScriptJs.put(o, "x", Double.valueOf(n.x));
                ScriptJs.put(o, "y", Double.valueOf(n.y));
                ScriptJs.put(o, "kind", n.kind);
                out.add(o);
            }
            return toArray(out);
        });

        // routes() → 缓存条数（诊断）
        api.addMethod(ns, "cachedRoutes", (cx, thisObj, args) -> Integer.valueOf(routeCache.size()));

        // clear() → 清缓存（测试用）
        api.addMethod(ns, "clear", (cx, thisObj, args) -> {
            invalidateRoutes();
            return Boolean.TRUE;
        });
    }

    /** 路网节点数（测试/诊断用）。 */
    int nodeCountValue() {
        ensureBuilt();
        return nodes.size();
    }

    private int edgeCountValue() {
        ensureBuilt();
        return edges.size();
    }

    private String nodeIdArg(Object v) {
        if (v instanceof String) {
            return (String) v;
        }
        Object id = ScriptJs.get(v, "id");
        if (id instanceof String) {
            return (String) id;
        }
        // 也允许直接传坐标点 {x,y} → 取最近节点
        Object x = ScriptJs.get(v, "x");
        if (!ScriptJs.isMissing(x)) {
            float px = ScriptJs.fnum(x, 0f);
            float py = ScriptJs.fnum(ScriptJs.get(v, "y"), 0f);
            Node best = null;
            float bestD = Float.MAX_VALUE;
            for (Node n : nodes.values()) {
                float dx = n.x - px;
                float dy = n.y - py;
                float d = dx * dx + dy * dy;
                if (d < bestD) {
                    bestD = d;
                    best = n;
                }
            }
            return best == null ? "" : best.id;
        }
        return "";
    }

    // ---------------- 寻路（Dijkstra，权重 = 长度 / 限速） ----------------

    /**
     * 在图里找最短<b>时间</b>路径（不是最短距离）：权重 = 长度 / 限速。
     *
     * <p>为什么用时间而不是距离：车辆限速不同（主干道 300、小巷 120），
     * 纯距离会让车绕进小巷。这也是"路口转向"能被 SUV/出租共用的前提。
     *
     * <p>不可达返回空列表（不是 null），与 {@code bwe.nav.find} 的"不可达 = 空数组"一致。
     */
    List<String> findRoute(String from, String to) {
        ensureBuilt();
        List<String> empty = new ArrayList<String>();
        if (from == null || to == null || from.isEmpty() || to.isEmpty()) {
            return empty;
        }
        if (!nodes.containsKey(from) || !nodes.containsKey(to)) {
            return empty;
        }
        String key = from + ">" + to;
        List<String> cached = routeCache.get(key);
        if (cached != null) {
            return new ArrayList<String>(cached);
        }
        if (from.equals(to)) {
            List<String> one = new ArrayList<String>();
            one.add(from);
            return one;
        }
        final Map<String, Float> dist = new LinkedHashMap<String, Float>();
        final Map<String, String> prev = new LinkedHashMap<String, String>();
        for (String id : nodes.keySet()) {
            dist.put(id, Float.MAX_VALUE);
        }
        dist.put(from, Float.valueOf(0f));
        PriorityQueue<String> open = new PriorityQueue<String>(16, new Comparator<String>() {
            @Override
            public int compare(String a, String b) {
                float da = dist.get(a) == null ? Float.MAX_VALUE : dist.get(a).floatValue();
                float db = dist.get(b) == null ? Float.MAX_VALUE : dist.get(b).floatValue();
                return Float.compare(da, db);
            }
        });
        open.add(from);
        java.util.Set<String> closed = new java.util.HashSet<String>();
        boolean found = false;
        int guard = 0;
        while (!open.isEmpty() && guard++ < nodes.size() * 8) {
            String cur = open.poll();
            if (closed.contains(cur)) {
                continue;
            }
            closed.add(cur);
            if (cur.equals(to)) {
                found = true;
                break;
            }
            List<Edge> outs = adjacency.get(cur);
            if (outs == null) {
                continue;
            }
            float curD = dist.get(cur).floatValue();
            for (int i = 0; i < outs.size(); i++) {
                Edge e = outs.get(i);
                float w = e.length / Math.max(1f, e.speedLimit);
                float nd = curD + w;
                Float old = dist.get(e.to);
                if (old == null || nd < old.floatValue()) {
                    dist.put(e.to, Float.valueOf(nd));
                    prev.put(e.to, cur);
                    open.add(e.to);
                }
            }
        }
        if (!found) {
            return empty;
        }
        List<String> path = new ArrayList<String>();
        String cur = to;
        int guard2 = 0;
        while (cur != null && guard2++ < nodes.size() * 4) {
            path.add(0, cur);
            if (cur.equals(from)) {
                break;
            }
            cur = prev.get(cur);
        }
        if (path.isEmpty() || !path.get(0).equals(from)) {
            return empty;
        }
        if (routeCache.size() > MAX_CACHE) {
            routeCache.clear();
        }
        routeCache.put(key, new ArrayList<String>(path));
        return path;
    }

    // ---------------- 小工具 ----------------

    private Scriptable nodeObj(Node n) {
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        ScriptJs.put(o, "id", n.id);
        ScriptJs.put(o, "x", Double.valueOf(n.x));
        ScriptJs.put(o, "y", Double.valueOf(n.y));
        ScriptJs.put(o, "kind", n.kind);
        return o;
    }

    private Scriptable nodesArray() {
        ensureBuilt();
        List<Object> out = new ArrayList<Object>();
        for (Node n : nodes.values()) {
            out.add(nodeObj(n));
        }
        return toArray(out);
    }

    private Scriptable edgesArray() {
        ensureBuilt();
        List<Object> out = new ArrayList<Object>();
        for (int i = 0; i < edges.size(); i++) {
            Edge e = edges.get(i);
            ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
            ScriptJs.put(o, "from", e.from);
            ScriptJs.put(o, "to", e.to);
            ScriptJs.put(o, "width", Double.valueOf(e.width));
            ScriptJs.put(o, "speedLimit", Double.valueOf(e.speedLimit));
            ScriptJs.put(o, "oneway", Boolean.valueOf(e.oneway));
            ScriptJs.put(o, "length", Double.valueOf(e.length));
            out.add(o);
        }
        return toArray(out);
    }

    private Scriptable toArray(List<Object> items) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        return cx.newArray(scope, items.toArray());
    }

    /** 场景卸载：清空图与缓存。 */
    void clearSceneState() {
        nodes.clear();
        adjacency.clear();
        edges.clear();
        routeCache.clear();
        built = false;
    }
}
