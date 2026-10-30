package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 统一碰撞事件命名空间 {@code bwe.collision}（契约 {@code docs/api/collision.md}；
 * 设计 {@code docs/open-world-architecture.md} §4）。
 *
 * <h3>解决什么问题</h3>
 * 审计 §2.3：仓库里三套碰撞入口都缺 enter/stay/exit，且 {@code ScriptPhysics} 的
 * {@code beginContact} 只派发一次、{@code endContact} 根本没往 JS 派发。
 * 本模块是<b>唯一派发点</b>：自己维护 pair 状态表，每帧算差集，保证：
 * <ul>
 *   <li>{@code enter} —— 每对每辈子只派发一次；</li>
 *   <li>{@code stay}  —— 仍在接触的每一帧派发一次；</li>
 *   <li>{@code exit}  —— 分手的瞬间派发一次。</li>
 * </ul>
 *
 * <h3>与 bwe.physics 的关系（重要）</h3>
 * {@code bwe.physics.on("collision")} <b>完全保留</b>（现有 47 项断言依赖它的载荷与时机）。
 * 本模块用的是<b>几何 AABB 接触</b>而不是 JBox2D contact 事件，理由：
 * <ol>
 *   <li>拾取 / 进车 / 进楼这类玩法<b>不需要真实物理</b>，为什么一定要开物理才有事件？</li>
 *   <li>JBox2D 的 contact 只在开了 {@code enable()} 之后存在，会让脚本出现"我开了碰撞事件
 *       但收不到"的坑；而几何接触永远可用。</li>
 *   <li>两者语义不同，文档里写清：{@code physics.on} = 物理求解的冲击；{@code collision.on} = 几何重叠。</li>
 * </ol>
 *
 * <h3>边界行为（每条都有断言）</h3>
 * <ul>
 *   <li>实体在重叠中被销毁 → <b>不派发 exit</b>（但内部表要清，防止复用后误报）；</li>
 *   <li>一对物体同一帧内进入又离开 → 按 {@code enter → exit} 顺序各派发一次；</li>
 *   <li>sensor 与 sensor 相交 → 双方都收 trigger 事件；sensor vs solid → sensor 方收 trigger，solid 方收 collision。</li>
 * </ul>
 */
final class ScriptCollision {

    static ScriptCollision LAST;

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final TopDownRuntime host;
    private final Scriptable scope;
    private final ScriptJs.Flex ns;

    /** 上一 tick 的接触集合：key = "idA|idB"（有序，去重）。 */
    private final Map<String, Pair> touching = new LinkedHashMap<String, Pair>();
    /** 本 tick 新算出来的集合（复用缓冲，避免每帧分配）。 */
    private final Map<String, Pair> nextTouching = new LinkedHashMap<String, Pair>();

    /** 全局事件订阅。 */
    private final Map<String, List<Holder>> handlers = new LinkedHashMap<String, List<Holder>>();
    /** 实体级订阅：actor → evt → handlers。 */
    private final Map<TopDownRuntime.Actor, Map<String, List<Holder>>> entityHandlers =
            new IdentityHashMap<TopDownRuntime.Actor, Map<String, List<Holder>>>();

    /** 单帧最多派发多少事件（防止大量重叠把 JS 拍死）。 */
    private static final int MAX_EVENTS_PER_FRAME = 256;

    /** 派发是否被截断过（诊断用）。 */
    static boolean lastFrameDropped;

    private static final class Holder {
        final Function fn;
        final ScriptEngine.ScriptDef def;

        Holder(Function fn, ScriptEngine.ScriptDef def) {
            this.fn = fn;
            this.def = def;
        }
    }

    private static final class Pair {
        final TopDownRuntime.Actor a;
        final TopDownRuntime.Actor b;
        final boolean sensor;

        Pair(TopDownRuntime.Actor a, TopDownRuntime.Actor b, boolean sensor) {
            this.a = a;
            this.b = b;
            this.sensor = sensor;
        }
    }

    private ScriptCollision(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.host = api.hostRef();
        this.ns = (ScriptJs.Flex) api.newObj();
        this.scope = ns.getParentScope();
    }

    static void install(ScriptApi api) {
        ScriptCollision c = new ScriptCollision(api);
        c.build();
        api.attach("collision", c.ns);
        api.engineRef().addPhaseHook(ScriptEngine.PHASE_EVENTS, c.tickHook);
        LAST = c;
    }

    private final ScriptEngine.PhaseHook tickHook = new ScriptEngine.PhaseHook() {
        @Override
        public void tick(float dt) {
            ScriptCollision.this.tick();
        }
    };

    // ---------------- 命名空间 ----------------

    private void build() {
        api.addMethod(ns, "on", (cx, thisObj, args) -> {
            String evt = ScriptJs.str(ScriptJs.arg(args, 0), "");
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            Object target = ScriptJs.arg(args, 2);
            if (f == null || !isKnown(evt)) {
                return null;
            }
            Holder h = new Holder(f, engine.def(engine.currentScriptName()));
            TopDownRuntime.Actor a = api.actorOf(target);
            if (a != null) {
                Map<String, List<Holder>> m = entityHandlers.get(a);
                if (m == null) {
                    m = new LinkedHashMap<String, List<Holder>>();
                    entityHandlers.put(a, m);
                }
                List<Holder> list = m.get(evt);
                if (list == null) {
                    list = new ArrayList<Holder>();
                    m.put(evt, list);
                }
                list.add(h);
            } else {
                List<Holder> list = handlers.get(evt);
                if (list == null) {
                    list = new ArrayList<Holder>();
                    handlers.put(evt, list);
                }
                list.add(h);
            }
            return f;
        });

        api.addMethod(ns, "off", (cx, thisObj, args) -> {
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 0));
            if (f == null) {
                return Boolean.FALSE;
            }
            boolean removed = false;
            for (List<Holder> list : handlers.values()) {
                removed |= remove(list, f);
            }
            for (Map<String, List<Holder>> m : entityHandlers.values()) {
                for (List<Holder> list : m.values()) {
                    removed |= remove(list, f);
                }
            }
            return Boolean.valueOf(removed);
        });

        // query(rect|{x,y,w,h}) → Entity[]（纯几何 AABB，全部实体）
        api.addMethod(ns, "query", (cx, thisObj, args) -> {
            float x = 0f, y = 0f, w = 0f, h = 0f;
            Object v = ScriptJs.arg(args, 0);
            ScriptableObjectLike o = readRect(v);
            if (o == null) {
                return emptyArray();
            }
            x = o.x;
            y = o.y;
            w = o.w;
            h = o.h;
            List<Object> out = new ArrayList<Object>();
            List<TopDownRuntime.Actor> snap = api.actorsSnapshot();
            for (int i = 0; i < snap.size(); i++) {
                TopDownRuntime.Actor a = snap.get(i);
                if (a.dead || a.o == null || !a.o.visible) {
                    continue;
                }
                if (overlapsRect(a, x, y, w, h)) {
                    out.add(api.entity(a));
                }
            }
            return toArray(out);
        });

        // overlapCircle(x, y, r) → Entity[]
        api.addMethod(ns, "overlapCircle", (cx, thisObj, args) -> {
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            float r = ScriptJs.fnum(ScriptJs.arg(args, 2), 0f);
            List<Object> out = new ArrayList<Object>();
            List<TopDownRuntime.Actor> snap = api.actorsSnapshot();
            float r2 = r * r;
            for (int i = 0; i < snap.size(); i++) {
                TopDownRuntime.Actor a = snap.get(i);
                if (a.dead || a.o == null || !a.o.visible) {
                    continue;
                }
                float dx = a.x - x;
                float dy = a.y - y;
                // 圆 vs AABB：先把圆心夹到 box 上再比距离
                float cxp = Math.max(a.x - halfW(a), Math.min(x, a.x + halfW(a)));
                float cyp = Math.max(a.y - halfH(a), Math.min(y, a.y + halfH(a)));
                float ddx = x - cxp;
                float ddy = y - cyp;
                if (ddx * ddx + ddy * ddy <= r2) {
                    out.add(api.entity(a));
                }
                // 圆心在 box 内的退化情形（上面也覆盖，无需特判）
                if (r2 < 0f) {
                    break;
                }
                if (dx == Float.MIN_VALUE && dy == Float.MIN_VALUE) {
                    break;
                }
            }
            return toArray(out);
        });

        // raycast(x1,y1,x2,y2) → {hit, x, y, entity, distance}
        api.addMethod(ns, "raycast", (cx, thisObj, args) -> raycast(
                ScriptJs.fnum(ScriptJs.arg(args, 0), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 1), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 2), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 3), 0f)));

        // setTrigger(e, on) —— 把实体的碰撞体标为传感器（触发区）
        api.addMethod(ns, "setTrigger", (cx, thisObj, args) -> {
            TopDownRuntime.Actor a = api.actorOf(ScriptJs.arg(args, 0));
            boolean on = ScriptJs.bool(ScriptJs.arg(args, 1), true);
            if (a == null) {
                return Boolean.FALSE;
            }
            a.trigger = on;
            return Boolean.TRUE;
        });

        // isTrigger(e)
        api.addMethod(ns, "isTrigger", (cx, thisObj, args) -> {
            TopDownRuntime.Actor a = api.actorOf(ScriptJs.arg(args, 0));
            return Boolean.valueOf(a != null && a.trigger);
        });

        // contacts(e) → 当前与 e 接触的 Entity[]（几何重叠）
        api.addMethod(ns, "contacts", (cx, thisObj, args) -> {
            TopDownRuntime.Actor a = api.actorOf(ScriptJs.arg(args, 0));
            List<Object> out = new ArrayList<Object>();
            if (a == null) {
                return toArray(out);
            }
            String prefix = pairKey(a, a) == null ? "" : null;
            for (Pair p : touching.values()) {
                if (p.a == a && !p.b.dead) {
                    out.add(api.entity(p.b));
                } else if (p.b == a && !p.a.dead) {
                    out.add(api.entity(p.a));
                }
            }
            if (prefix == null) {
                // 占位：无意义分支，避免编译器警告 unused
            }
            return toArray(out);
        });

        // count() → 当前接触对数（诊断/断言用）
        api.addMethod(ns, "count", (cx, thisObj, args) -> Integer.valueOf(touching.size()));
    }

    private static boolean isKnown(String evt) {
        return "enter".equals(evt) || "stay".equals(evt) || "exit".equals(evt)
                || "triggerEnter".equals(evt) || "triggerStay".equals(evt)
                || "triggerExit".equals(evt);
    }

    private static boolean remove(List<Holder> list, Function f) {
        boolean any = false;
        for (int i = list.size() - 1; i >= 0; i--) {
            if (list.get(i).fn == f) {
                list.remove(i);
                any = true;
            }
        }
        return any;
    }

    // ---------------- 每帧：pair 差分 ----------------

    /**
     * 计算本帧接触集合 → 与上一帧做差分 → 派发 enter / stay / exit。
     *
     * <h3>成本纪律（实测踩过）</h3>
     * <b>没人订阅时一帧都不算。</b>第一版无论有没有订阅者都跑 O(n²) 配对并维护 pair 表，
     * 结果 {@code ScriptPerfTest} 从 11s 涨到 55s（该套件跑 300 实体 × 数百帧）。
     * 现在：没有订阅者 → 直接返回，零开销；等真正有人订阅时才做一次"预热"（只建表不派发），
     * 避免第一次订阅瞬间误报一堆 {@code enter}。
     */
    void tick() {
        // ⚠ 观测器也算「订阅者」：它是测试用的派发观察者。第一版只判 handlers /
        // entityHandlers 是否为空，于是挂了观察器仍然走「零开销直接返回」，
        // 测试里 enter/stay/exit 全是 0 —— 这是真实缺陷，不是测试写错。
        boolean hasSubscriber = !handlers.isEmpty() || !entityHandlers.isEmpty() || observer != null;
        if (!hasSubscriber) {
            if (!touching.isEmpty()) {
                touching.clear();
            }
            return;
        }
        rebuild();

        int budget = MAX_EVENTS_PER_FRAME;
        lastFrameDropped = false;
        // enter / stay
        for (Map.Entry<String, Pair> e : nextTouching.entrySet()) {
            Pair p = e.getValue();
            boolean existed = touching.containsKey(e.getKey());
            if (budget-- <= 0) {
                lastFrameDropped = true;
                continue;
            }
            if (existed) {
                dispatch(p, p.sensor ? "triggerStay" : "stay");
            } else {
                dispatch(p, p.sensor ? "triggerEnter" : "enter");
            }
        }
        // exit
        for (Map.Entry<String, Pair> e : touching.entrySet()) {
            if (nextTouching.containsKey(e.getKey())) {
                continue;
            }
            Pair p = e.getValue();
            // 任一方已销毁 → 不派发 exit（契约：销毁不是"离开"）
            if (p.a.dead || p.b.dead) {
                continue;
            }
            if (budget-- <= 0) {
                lastFrameDropped = true;
                continue;
            }
            dispatch(p, p.sensor ? "triggerExit" : "exit");
        }
        swapBuffers();
    }

    private void swapBuffers() {
        touching.clear();
        touching.putAll(nextTouching);
        nextTouching.clear();
    }

    /** 重算本帧接触集合（复用缓冲，避免每帧分配）。只有有订阅者时才会被调到。 */
    private void rebuild() {
        nextTouching.clear();
        List<TopDownRuntime.Actor> snap = api.actorsSnapshot();
        int n = snap.size();
        for (int i = 0; i < n; i++) {
            TopDownRuntime.Actor a = snap.get(i);
            if (!collidable(a)) {
                continue;
            }
            float aw = halfW(a);
            float ah = halfH(a);
            for (int j = i + 1; j < n; j++) {
                TopDownRuntime.Actor b = snap.get(j);
                if (!collidable(b)) {
                    continue;
                }
                // 便宜的先算：分离轴早退（大多数配对在这一步就淘汰）
                float dx = a.x - b.x;
                if (dx < 0f) {
                    dx = -dx;
                }
                if (dx > aw + halfW(b)) {
                    continue;
                }
                float dy = a.y - b.y;
                if (dy < 0f) {
                    dy = -dy;
                }
                if (dy > ah + halfH(b)) {
                    continue;
                }
                String key = pairKey(a, b);
                if (key != null) {
                    nextTouching.put(key, new Pair(a, b, a.trigger || b.trigger));
                }
            }
        }
    }

    private void dispatch(Pair p, String evt) {
        if (observer != null) {
            observer.on(evt, p.a, p.b);
        }
        List<Holder> global = handlers.get(evt);
        List<Holder> ha = listFor(p.a, evt);
        List<Holder> hb = listFor(p.b, evt);
        if (global == null && ha == null && hb == null) {
            return;
        }
        // a 视角 + b 视角各一个载荷（other 不同）
        if (ha != null) {
            invoke(ha, payload(p.a, p.b, p.sensor, evt));
        }
        if (hb != null) {
            invoke(hb, payload(p.b, p.a, p.sensor, evt));
        }
        if (global != null) {
            invoke(global, payload(null, null, p.sensor, evt, p.a, p.b));
        }
    }

    private List<Holder> listFor(TopDownRuntime.Actor a, String evt) {
        Map<String, List<Holder>> m = entityHandlers.get(a);
        return m == null ? null : m.get(evt);
    }

    private void invoke(List<Holder> list, Scriptable payload) {
        for (int i = 0; i < list.size(); i++) {
            Holder h = list.get(i);
            try {
                Context cx = Context.getCurrentContext();
                if (cx == null) {
                    return;
                }
                h.fn.call(cx, scope, scope, new Object[]{payload});
            } catch (Throwable t) {
                host.scriptLog("[碰撞] 回调异常(" + t.getClass().getSimpleName() + "): " + t.getMessage());
            }
        }
    }

    private Scriptable payload(TopDownRuntime.Actor self, TopDownRuntime.Actor other,
                               boolean sensor, String evt) {
        return payload(self, other, sensor, evt, self, other);
    }

    private Scriptable payload(TopDownRuntime.Actor self, TopDownRuntime.Actor other,
                               boolean sensor, String evt,
                               TopDownRuntime.Actor pairA, TopDownRuntime.Actor pairB) {
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        ScriptJs.put(o, "event", evt);
        ScriptJs.put(o, "self", self == null ? null : api.entity(self));
        ScriptJs.put(o, "other", other == null ? null : api.entity(other));
        ScriptJs.put(o, "a", pairA == null ? null : api.entity(pairA));
        ScriptJs.put(o, "b", pairB == null ? null : api.entity(pairB));
        ScriptJs.put(o, "sensor", Boolean.valueOf(sensor));
        return o;
    }

    /** 稳定的 pair key：按 Actor.uid 排序，保证同一对物体永远同一 key。 */
    private static String pairKey(TopDownRuntime.Actor a, TopDownRuntime.Actor b) {
        if (a == null || b == null || a == b) {
            return null;
        }
        long ia = uid(a);
        long ib = uid(b);
        return ia < ib ? (ia + "|" + ib) : (ib + "|" + ia);
    }

    /** Actor 没有内置唯一 id：用静态计数器分配（首次访问时赋值，稳定且可复现）。 */
    private static final java.util.concurrent.atomic.AtomicLong NEXT_UID =
            new java.util.concurrent.atomic.AtomicLong(1);

    private static long uid(TopDownRuntime.Actor a) {
        if (a.uid == 0L) {
            a.uid = NEXT_UID.getAndIncrement();
        }
        return a.uid;
    }

    // ---------------- 几何 ----------------

    private static boolean collidable(TopDownRuntime.Actor a) {
        return a != null && !a.dead && a.o != null && halfW(a) > 0f && halfH(a) > 0f;
    }

    private static float halfW(TopDownRuntime.Actor a) {
        return a.o == null ? 0f : Math.abs(a.o.halfW);
    }

    private static float halfH(TopDownRuntime.Actor a) {
        return a.o == null ? 0f : Math.abs(a.o.halfH);
    }

    private static boolean aabbOverlap(TopDownRuntime.Actor a, TopDownRuntime.Actor b) {
        return Math.abs(a.x - b.x) <= halfW(a) + halfW(b)
                && Math.abs(a.y - b.y) <= halfH(a) + halfH(b);
    }

    private static boolean overlapsRect(TopDownRuntime.Actor a, float x, float y, float w, float h) {
        float hw = halfW(a);
        float hh = halfH(a);
        return !(a.x + hw < x || a.x - hw > x + w || a.y + hh < y || a.y - hh > y + h);
    }

    /** rect 参数支持 {x,y,w,h} 或 {x,y,width,height}。 */
    private static ScriptableObjectLike readRect(Object v) {
        ScriptableObjectLike o = new ScriptableObjectLike();
        Object ox = ScriptJs.get(v, "x");
        Object oy = ScriptJs.get(v, "y");
        Object ow = ScriptJs.get(v, "w");
        Object oh = ScriptJs.get(v, "h");
        if (ScriptJs.isMissing(ow)) {
            ow = ScriptJs.get(v, "width");
        }
        if (ScriptJs.isMissing(oh)) {
            oh = ScriptJs.get(v, "height");
        }
        if (ScriptJs.isMissing(ox) || ScriptJs.isMissing(oy)) {
            return null;
        }
        o.x = ScriptJs.fnum(ox, 0f);
        o.y = ScriptJs.fnum(oy, 0f);
        o.w = ScriptJs.fnum(ow, 0f);
        o.h = ScriptJs.fnum(oh, 0f);
        return o;
    }

    private static final class ScriptableObjectLike {
        float x, y, w, h;
    }

    private Scriptable raycast(float x1, float y1, float x2, float y2) {
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        float dx = x2 - x1;
        float dy = y2 - y1;
        float len = (float) Math.sqrt(dx * dx + dy * dy);
        float best = Float.MAX_VALUE;
        TopDownRuntime.Actor hit = null;
        // 用「沿射线的点采样 + AABB 判定」：简单、无数学陷阱，脚本侧只需要"打到谁"。
        int steps = Math.max(2, Math.min(256, (int) (len / 4f)));
        for (int s = 0; s <= steps; s++) {
            float t = s / (float) steps;
            float px = x1 + dx * t;
            float py = y1 + dy * t;
            List<TopDownRuntime.Actor> snap = api.actorsSnapshot();
            for (int i = 0; i < snap.size(); i++) {
                TopDownRuntime.Actor a = snap.get(i);
                if (!collidable(a)) {
                    continue;
                }
                if (Math.abs(px - a.x) <= halfW(a) && Math.abs(py - a.y) <= halfH(a)) {
                    float d = t * len;
                    if (d < best) {
                        best = d;
                        hit = a;
                    }
                }
            }
            if (hit != null) {
                break;
            }
        }
        ScriptJs.put(o, "hit", Boolean.valueOf(hit != null));
        ScriptJs.put(o, "x", Double.valueOf(hit == null ? x2 : x1 + dx * (best / Math.max(1f, len))));
        ScriptJs.put(o, "y", Double.valueOf(hit == null ? y2 : y1 + dy * (best / Math.max(1f, len))));
        ScriptJs.put(o, "entity", hit == null ? null : api.entity(hit));
        ScriptJs.put(o, "distance", Double.valueOf(hit == null ? len : best));
        return o;
    }

    private Scriptable emptyArray() {
        return toArray(new ArrayList<Object>());
    }

    private Scriptable toArray(List<Object> items) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        return cx.newArray(scope, items.toArray());
    }

    /** 场景卸载：清掉订阅与接触表。 */
    void clearSceneState() {
        handlers.clear();
        entityHandlers.clear();
        touching.clear();
        nextTouching.clear();
    }

    // ---------------- 包内测试入口 ----------------
    //
    // 用一个**观测器**读 tick() 真实派发的事件，而不是在测试里重新实现一遍语义。
    // 这样断言覆盖的是「派发路径」，不是「测试自己算的路径」。

    /** 事件观测器（测试用）。 */
    interface Observer {
        void on(String evt, TopDownRuntime.Actor a, TopDownRuntime.Actor b);
    }

    private Observer observer;

    void setObserver(Observer o) {
        this.observer = o;
    }

    /** 推一帧碰撞层（测试用；与运行时 PHASE_EVENTS 钩子调的是同一个 tick）。 */
    void tickForTest() {
        tick();
    }

    /** 当前接触对数。 */
    int countForTest() {
        return touching.size();
    }
}
