package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;
import org.mozilla.javascript.Undefined;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * 涌现式模拟基底之三：<b>感知 · 噪音 · 阵营 · 状态机 · 拾取器 · 确定性随机</b>
 * （契约见 {@code docs/scripting-api.md} §2.11.3 / §2.11.4 / §2.11.6，以及 §2.11.7 第 4 条）。
 *
 * <p><b>引擎只负责「看得见 / 听得见 / 记得住 / 传警报」，不替脚本做决策</b>——
 * 守卫听见爆炸去查看、发现尸体进入 chase、被同伴喊来增援，全部由 JS 用状态机组合。
 * 引擎唯一自动写入的状态是：{@code ai.target(e)}（当前可见的敌对目标）与
 * {@code sense.lastKnown(e)}（最后已知位置 + age）。
 *
 * <p>对外命名空间：
 * <pre>
 *   bwe.noise.emit(x, y, {radius, intensity, tag}) / events()
 *   bwe.sense.canSee(a, b) / inSightRange(a, b) / audible(e) / lastKnown(e)
 *   bwe.faction.set(e, name) / relation(a, b, v) / hostile(a, b) / members(name)
 *   bwe.ai.attach(e, {sight, fov, hearing, memory, speed}) / detach(e)
 *   bwe.ai.state(e) / setState(e, s) / target(e) / alert(e, position)
 *   bwe.ai.onAlert(fn) / onSpot(fn)
 *   bwe.target.cell() / entity() / inFront(e, range)
 *   bwe.seed.set(n) / get() / reset()
 * </pre>
 *
 * <p>实现要点：
 * <ul>
 *   <li>视线：半径 + FOV + 瓦片遮挡（复用 {@link ScriptWorld#solidCell}，按 tile/2 步进采样）+
 *       烟雾（反射读 {@code ScriptFields.smokeAt(cx,cy)}，读不到就只按瓦片遮挡——两个子系统并行开发，
 *       这里<b>不</b>对 ScriptFields 形成编译期依赖）；</li>
 *   <li>听力：噪音按距离衰减，隔墙按 0.55^n 衰减，只对挂了 {@code ai.attach} 的实体派发；</li>
 *   <li>记忆：{@code lastKnown(e)} 带 age（秒），超过 memory 秒清空（target 一起清）；</li>
 *   <li>警报：{@code ai.alert} 入队，下一个模拟 tick 才投递给同阵营 agent（一跳延迟），
 *       投递时触发全局 {@code onAlert}；</li>
 *   <li>确定性：{@code bwe.seed.set(n)} 重置本引擎的随机源，并替换
 *       {@code bwe.random/randomInt/chance/pick} 让它们复用同一个 {@link Random}；
 *       默认种子是固定常量，保证自检/回归不会随机失败。兄弟子系统（场/物理）可用
 *       {@link #createRandom(String)} 拿到同一族种子的独立随机源。</li>
 * </ul>
 *
 * <p><b>本文件由「感知/AI」负责人独占</b>；其它子系统不修改本文件。
 */
final class ScriptAi {

    private ScriptAi() {
    }

    // ---------------- 常量 ----------------

    /** 默认确定性种子（固定值：自检/回归永远可复现；开局想要变化就 bwe.seed.set(Date.now())）。 */
    static final long DEFAULT_SEED = 20251026L;

    /** 未 attach 的实体调用 sense 时的兜底参数（全向、较大半径）。 */
    static final float DEFAULT_SIGHT = 512f;
    static final float DEFAULT_FOV = 360f;
    static final float DEFAULT_HEARING = 300f;
    static final float DEFAULT_MEMORY = 6f;
    /** attach(e) 不传 opts 时的默认值（与契约示例一致）。 */
    static final float ATTACH_SIGHT = 260f;
    static final float ATTACH_FOV = 120f;
    static final float ATTACH_HEARING = 300f;
    static final float ATTACH_MEMORY = 6f;
    static final float ATTACH_SPEED = 90f;

    /** 隔一道墙的听觉半径倍率（两道 0.55² ≈ 0.3，与契约一致）。 */
    static final float WALL_FACTOR = 0.55f;
    /** 听到后 audible(e) 保持为 true 的时长（秒），避免脚本只在 emit 那一帧能查询。 */
    static final double HEARD_HOLD = 0.4;
    /** noise.events() 保留多久的事件。 */
    static final double NOISE_KEEP = 2.0;

    // ---------------- 数据 ----------------

    /** 一个挂了 ai.attach 的实体的感知状态（引擎只存状态，不做决策）。 */
    static final class Agent {
        final Actor actor;
        float sight = ATTACH_SIGHT;
        float fov = ATTACH_FOV;
        float hearing = ATTACH_HEARING;
        float memory = ATTACH_MEMORY;
        float speed = ATTACH_SPEED;

        String state = "idle";
        Actor target;
        boolean targetVisible;

        boolean hasKnown;
        float knownX;
        float knownY;
        double knownTime;
        String knownFrom = "";

        double heardTime = -1;
        float heardX;
        float heardY;
        String heardTag = "";

        Agent(Actor actor) {
            this.actor = actor;
        }
    }

    static final class NoiseEvent {
        float x;
        float y;
        float radius;
        float intensity;
        String tag = "";
        double when;
    }

    static final class AlertMsg {
        Actor from;
        String faction;
        float x;
        float y;
        int frame;
    }

    static final class JsHandler {
        final Function fn;
        final ScriptEngine.ScriptDef def;

        JsHandler(Function fn, ScriptEngine.ScriptDef def) {
            this.fn = fn;
            this.def = def;
        }
    }

    /** 每个引擎一份状态（两个运行时实例互不串味；自检可以做确定性对拍）。 */
    static final class AiState {
        final ScriptApi api;
        final ScriptEngine engine;
        final TopDownRuntime host;
        final ScriptWorld world;

        // LinkedHashMap：Actor 没有覆写 equals/hashCode，键仍是身份语义，但能保证
        // 遍历顺序 = onStart 注册顺序（可复现：同种子同输入 ⇒ 同日志序列）。
        final Map<Actor, Agent> agents =
                new LinkedHashMap<Actor, Agent>();
        final Map<Actor, String> factions =
                new IdentityHashMap<Actor, String>();
        /** "a\u0000b" → -1/0/1，同时写两个方向。 */
        final Map<String, Integer> relations = new HashMap<String, Integer>();
        /**
         * 与 {@link #relations} 同步的嵌套索引（source → target → rel）。
         * 热路径查关系时不再拼 "a\u0000b" 字符串，避免每帧数百次短命分配。
         */
        final Map<String, Map<String, Integer>> relationsBySource =
                new HashMap<String, Map<String, Integer>>();

        final List<NoiseEvent> noises = new ArrayList<NoiseEvent>();
        final List<AlertMsg> pendingAlerts = new ArrayList<AlertMsg>();
        final List<JsHandler> onAlert = new ArrayList<JsHandler>();
        final List<JsHandler> onSpot = new ArrayList<JsHandler>();

        Random rng;
        long seed = DEFAULT_SEED;

        long tickNanos;
        long tickCount;

        // ---- 场景顺序 agent 列表（每帧算一次，三个阶段复用） ----
        final List<Agent> agentOrder = new ArrayList<Agent>();
        int orderFrame = -1;

        // ---- 敌对候选缓存（阵营名 → 敌对实体列表） ----
        // 只在「阵营映射变了」或「场景 actor 数量变了」时重建；阵营与实体构成在
        // 正常情况下逐帧稳定，因此不必每帧重建并分配 Map/List。
        final Map<String, List<Actor>> hostileByFaction =
                new HashMap<String, List<Actor>>();
        int factionVersion;
        int hostileVersion = -1;
        int hostileActorCount = -1;

        AiState(ScriptApi api) {
            this.api = api;
            this.engine = api.engineRef();
            this.host = api.hostRef();
            this.world = engine.world;
            this.rng = new Random(seed);
        }

        double now() {
            return engine.time;
        }

        int frame() {
            return engine.frame;
        }

        /**
         * 按场景（host.actors）顺序返回 agent：onStart 派发顺序来自 IdentityHashMap，
         * 跨运行不可复现；这里用场景顺序兜底，保证「同种子同输入 ⇒ 同日志/同状态序列」。
         *
         * <p>每帧要按同一顺序走三遍（alerts / vision / memory），原先每遍都新建
         * {@code ArrayList} 并重新做一遍 actors×agents 的 IdentityHashMap 查找。
         * 现在每帧只算一次（{@link #agentOrder}），后续调用直接复用——顺序与内容完全一致。
         */
        List<Agent> agentsInSceneOrder() {
            if (orderFrame >= 0 && orderFrame == frame()) {
                return agentOrder;
            }
            agentOrder.clear();
            for (Actor a : host.actors) {
                Agent ag = agents.get(a);
                if (ag != null) {
                    agentOrder.add(ag);
                }
            }
            orderFrame = frame();
            return agentOrder;
        }

        /** 失效缓存（agent 列表/场景顺序变化时调用）。 */
        void invalidateAgentOrder() {
            orderFrame = -1;
        }
    }

    private static final Map<ScriptEngine, AiState> STATES =
            new IdentityHashMap<ScriptEngine, AiState>();

    static AiState stateFor(ScriptEngine engine) {
        synchronized (STATES) {
            return engine == null ? null : STATES.get(engine);
        }
    }

    /** 最近一次模拟 tick 的平均耗时（毫秒），供自检报告性能。 */
    static double averageTickMs(ScriptEngine engine) {
        AiState st = stateFor(engine);
        if (st == null || st.tickCount <= 0) {
            return -1;
        }
        return st.tickNanos / 1_000_000.0 / st.tickCount;
    }

    // ---------------- 安装 ----------------

    /** 注册 {@code bwe.noise/sense/faction/ai/target/seed} 并挂上感知模拟。 */
    static void install(ScriptApi api) {
        AiState st = new AiState(api);
        synchronized (STATES) {
            STATES.put(api.engineRef(), st);
        }
        buildNoise(api, st);
        buildSense(api, st);
        buildFaction(api, st);
        buildAi(api, st);
        buildTarget(api, st);
        installSeed(api, st);
        api.engineRef().addSimHook(new ScriptEngine.SimHook() {
            @Override
            public void tick(float dt) {
                ScriptAi.tick(st, dt);
            }
        });
    }

    // ---------------- bwe.noise ----------------

    private static void buildNoise(final ScriptApi api, final AiState st) {
        Scriptable noise = api.newObj();
        api.addMethod(noise, "emit", (cx, thisObj, args) -> {
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            Scriptable o = argObj(ScriptJs.arg(args, 2));
            float radius = o == null ? 260f : ScriptJs.fnum(ScriptJs.get(o, "radius"), 260f);
            float intensity = o == null ? 1f : ScriptJs.fnum(ScriptJs.get(o, "intensity"), 1f);
            String tag = o == null ? "" : ScriptJs.str(ScriptJs.get(o, "tag"), "");
            emitNoise(st, x, y, radius, intensity, tag);
            return null;
        });
        api.addMethod(noise, "events", (cx, thisObj, args) -> {
            pruneNoises(st, st.now());
            List<Object> list = new ArrayList<Object>();
            for (NoiseEvent n : st.noises) {
                Scriptable item = api.newObj();
                put(item, "x", Double.valueOf(n.x));
                put(item, "y", Double.valueOf(n.y));
                put(item, "radius", Double.valueOf(n.radius));
                put(item, "intensity", Double.valueOf(n.intensity));
                put(item, "tag", n.tag);
                put(item, "age", Double.valueOf(st.now() - n.when));
                list.add(item);
            }
            return jsArray(api, list);
        });
        api.attach("noise", noise);
    }

    private static void emitNoise(AiState st, float x, float y, float radius, float intensity, String tag) {
        double now = st.now();
        NoiseEvent ev = new NoiseEvent();
        ev.x = x;
        ev.y = y;
        ev.radius = Math.max(0f, radius);
        ev.intensity = intensity;
        ev.tag = tag == null ? "" : tag;
        ev.when = now;
        st.noises.add(ev);
        pruneNoises(st, now);

        for (Agent ag : new ArrayList<Agent>(st.agents.values())) {
            Actor a = ag.actor;
            if (a == null || a.dead) {
                continue;
            }
            float dx = x - a.x;
            float dy = y - a.y;
            float dist = (float) Math.sqrt(dx * dx + dy * dy);
            float base = ev.radius;
            if (ag.hearing > 0f) {
                base = Math.min(base, ag.hearing);
            }
            int walls = wallRuns(st.world, a.x, a.y, x, y);
            float eff = base * (float) Math.pow(WALL_FACTOR, Math.max(0, walls));
            eff *= clamp(intensity, 0.25f, 3f);
            if (dist > eff) {
                continue;
            }
            ag.heardTime = now;
            ag.heardX = x;
            ag.heardY = y;
            ag.heardTag = ev.tag;
            // 噪音是「第二感知通道」：没有视觉锁定时，它写入最后已知位置（引擎不决定去不去，
            // 只负责让脚本能从 sense.lastKnown 里查到声源）。
            if (!ag.targetVisible) {
                ag.hasKnown = true;
                ag.knownX = x;
                ag.knownY = y;
                ag.knownTime = now;
                ag.knownFrom = "noise";
            }
        }
    }

    private static void pruneNoises(AiState st, double now) {
        for (int i = st.noises.size() - 1; i >= 0; i--) {
            if (now - st.noises.get(i).when > NOISE_KEEP) {
                st.noises.remove(i);
            }
        }
        // 上限保护：脚本狂刷噪音时也只留最近 64 条。
        while (st.noises.size() > 64) {
            st.noises.remove(0);
        }
    }

    // ---------------- bwe.sense ----------------

    private static void buildSense(final ScriptApi api, final AiState st) {
        Scriptable sense = api.newObj();
        api.addMethod(sense, "canSee", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            Actor b = api.actorOf(ScriptJs.arg(args, 1));
            return Boolean.valueOf(canSee(st, a, b));
        });
        api.addMethod(sense, "inSightRange", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            Actor b = api.actorOf(ScriptJs.arg(args, 1));
            return Boolean.valueOf(inSightRange(st, a, b));
        });
        api.addMethod(sense, "audible", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            return Boolean.valueOf(audible(st, a));
        });
        api.addMethod(sense, "lastKnown", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            Agent ag = agentOf(st, a);
            if (ag == null || !ag.hasKnown) {
                return null;
            }
            double age = st.now() - ag.knownTime;
            if (age > Math.max(0.01f, ag.memory)) {
                clearKnown(ag);
                return null;
            }
            Scriptable o = api.newObj();
            put(o, "x", Double.valueOf(ag.knownX));
            put(o, "y", Double.valueOf(ag.knownY));
            put(o, "age", Double.valueOf(age));
            put(o, "from", ag.knownFrom);
            return o;
        });
        api.attach("sense", sense);
    }

    private static Agent agentOf(AiState st, Actor a) {
        return a == null ? null : st.agents.get(a);
    }

    private static boolean inSightRange(AiState st, Actor a, Actor b) {
        if (a == null || b == null || a.dead || b.dead) {
            return false;
        }
        Agent ag = agentOf(st, a);
        float sight = ag != null ? ag.sight : DEFAULT_SIGHT;
        float dx = b.x - a.x;
        float dy = b.y - a.y;
        return dx * dx + dy * dy <= sight * sight;
    }

    /** 视野半径 + FOV + 瓦片遮挡 + 烟雾减半（契约 §2.11.4）。 */
    private static boolean canSee(AiState st, Actor a, Actor b) {
        if (a == null || b == null || a.dead || b.dead || !b.o.visible) {
            return false;
        }
        Agent ag = agentOf(st, a);
        float sight = ag != null ? ag.sight : DEFAULT_SIGHT;
        float fov = ag != null ? ag.fov : DEFAULT_FOV;
        float dx = b.x - a.x;
        float dy = b.y - a.y;
        float d2 = dx * dx + dy * dy;
        if (d2 > sight * sight) {
            return false;
        }
        if (fov < 359.9f && d2 > 0.0001f) {
            float fx = a.faceX;
            float fy = a.faceY;
            if (fx == 0f && fy == 0f) {
                fx = 0f;
                fy = 1f;
            }
            float flen = (float) Math.sqrt(fx * fx + fy * fy);
            float dlen = (float) Math.sqrt(d2);
            float dot = (dx * fx + dy * fy) / (dlen * flen);
            float halfFov = (float) Math.cos(Math.toRadians(fov / 2f));
            if (dot < halfFov) {
                return false;
            }
        }
        if (!los(st.world, a.x, a.y, b.x, b.y)) {
            return false;
        }
        // 烟雾：读得到就按「视线减半」判定（强度 > 0.45 且超出半视距 → 看不见）。
        float smoke = smokeAt(st.world.toCellX(b.x), st.world.toCellY(b.y));
        if (smoke > 0.45f) {
            float dist = (float) Math.sqrt(d2);
            if (dist > sight * 0.5f) {
                return false;
            }
        }
        return true;
    }

    private static boolean audible(AiState st, Actor a) {
        Agent ag = agentOf(st, a);
        if (ag == null || ag.heardTime < 0) {
            return false;
        }
        return st.now() - ag.heardTime <= HEARD_HOLD;
    }

    private static void clearKnown(Agent ag) {
        ag.hasKnown = false;
        ag.knownFrom = "";
        ag.target = null;
        ag.targetVisible = false;
    }

    // ---------------- bwe.faction ----------------

    private static void buildFaction(final ScriptApi api, final AiState st) {
        Scriptable faction = api.newObj();
        api.addMethod(faction, "set", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null) {
                return null;
            }
            String name = ScriptJs.str(ScriptJs.arg(args, 1), "");
            if (name == null || name.isEmpty() || "null".equals(name)) {
                st.factions.remove(a);
            } else {
                st.factions.put(a, name);
            }
            // 敌对候选缓存依赖「实体 → 阵营」映射，这里一改就作废。
            st.factionVersion++;
            return null;
        });
        api.addMethod(faction, "relation", (cx, thisObj, args) -> {
            String a = factionName(api, st, ScriptJs.arg(args, 0));
            String b = factionName(api, st, ScriptJs.arg(args, 1));
            if (a == null || b == null) {
                return Double.valueOf(0);
            }
            Object v = ScriptJs.arg(args, 2);
            if (ScriptJs.isMissing(v)) {
                return Double.valueOf(relationOf(st, a, b));
            }
            int rel = ScriptJs.inum(v, 0);
            rel = rel < 0 ? -1 : (rel > 0 ? 1 : 0);
            putRelation(st, a, b, rel);
            putRelation(st, b, a, rel);
            return Double.valueOf(rel);
        });
        api.addMethod(faction, "hostile", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            Actor b = api.actorOf(ScriptJs.arg(args, 1));
            return Boolean.valueOf(hostile(st, a, b));
        });
        api.addMethod(faction, "members", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            List<Object> list = new ArrayList<Object>();
            for (Actor a : api.actorsSnapshot()) {
                if (a == null || a.dead) {
                    continue;
                }
                String f = st.factions.get(a);
                if (f != null && f.equals(name)) {
                    list.add(api.entityOf(a));
                }
            }
            return jsArray(api, list);
        });
        api.attach("faction", faction);
    }

    private static String factionName(ScriptApi api, AiState st, Object v) {
        Actor a = api.actorOf(v);
        if (a != null) {
            return st.factions.get(a);
        }
        String s = ScriptJs.str(v, null);
        return s == null || s.isEmpty() ? null : s;
    }

    private static String key(String a, String b) {
        return a + "\u0000" + b;
    }

    /**
     * 阵营关系查询。
     *
     * <p>热路径要点：{@link #key(String, String)} 每次都拼一个新字符串，而
     * {@code processVision} 每帧要为每个阵营的每个实体查一次（200 AI × 220 实体级别），
     * 那是每帧数百次短命字符串分配。这里改走「内层 Map 嵌套」，命中时零分配；
     * 结果与 {@code relations} 表完全一致（同一个 {@code put} 同时写两边）。
     */
    private static int relationOf(AiState st, String a, String b) {
        if (a == null || b == null) {
            return 0;
        }
        if (a.equals(b)) {
            return 1;
        }
        Map<String, Integer> inner = st.relationsBySource.get(a);
        if (inner != null) {
            Integer hit = inner.get(b);
            if (hit != null) {
                return hit.intValue();
            }
        }
        // 兜底：直接查扁平表（保持与直接把 relations 表当真相的来源一致）
        Integer v = st.relations.get(key(a, b));
        return v == null ? 0 : v.intValue();
    }

    /** 与 {@code relations.put(key(a,b), v)} 保持同步的嵌套索引（避免热路径拼 key）。 */
    private static void putRelation(AiState st, String a, String b, int rel) {
        Integer boxed = Integer.valueOf(rel);
        st.relations.put(key(a, b), boxed);
        Map<String, Integer> inner = st.relationsBySource.get(a);
        if (inner == null) {
            inner = new HashMap<String, Integer>();
            st.relationsBySource.put(a, inner);
        }
        inner.put(b, boxed);
    }

    private static boolean hostile(AiState st, Actor a, Actor b) {
        if (a == null || b == null || a == b) {
            return false;
        }
        String fa = st.factions.get(a);
        String fb = st.factions.get(b);
        if (fa == null || fb == null) {
            return false;
        }
        return relationOf(st, fa, fb) < 0;
    }

    // ---------------- bwe.ai ----------------

    private static void buildAi(final ScriptApi api, final AiState st) {
        Scriptable ai = api.newObj();
        api.addMethod(ai, "attach", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null) {
                return null;
            }
            Scriptable o = argObj(ScriptJs.arg(args, 1));
            Agent ag = st.agents.get(a);
            if (ag == null) {
                ag = new Agent(a);
                st.agents.put(a, ag);
                st.invalidateAgentOrder();
            }
            if (o != null) {
                ag.sight = ScriptJs.fnum(ScriptJs.get(o, "sight"), ag.sight);
                ag.fov = ScriptJs.fnum(ScriptJs.get(o, "fov"), ag.fov);
                ag.hearing = ScriptJs.fnum(ScriptJs.get(o, "hearing"), ag.hearing);
                ag.memory = ScriptJs.fnum(ScriptJs.get(o, "memory"), ag.memory);
                ag.speed = ScriptJs.fnum(ScriptJs.get(o, "speed"), ag.speed);
            }
            return null;
        });
        api.addMethod(ai, "detach", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a != null) {
                st.agents.remove(a);
                st.invalidateAgentOrder();
            }
            return null;
        });
        api.addMethod(ai, "state", (cx, thisObj, args) -> {
            Agent ag = agentOf(st, api.actorOf(ScriptJs.arg(args, 0)));
            return ag == null ? null : ag.state;
        });
        api.addMethod(ai, "setState", (cx, thisObj, args) -> {
            Agent ag = agentOf(st, api.actorOf(ScriptJs.arg(args, 0)));
            if (ag != null) {
                String s = ScriptJs.str(ScriptJs.arg(args, 1), "");
                if (s != null && !s.isEmpty()) {
                    ag.state = s;
                }
            }
            return null;
        });
        api.addMethod(ai, "target", (cx, thisObj, args) -> {
            Agent ag = agentOf(st, api.actorOf(ScriptJs.arg(args, 0)));
            if (ag == null) {
                return null;
            }
            Actor t = validTarget(st, ag);
            ag.target = t;
            return t == null ? null : api.entityOf(t);
        });
        api.addMethod(ai, "alert", (cx, thisObj, args) -> {
            Actor from = api.actorOf(ScriptJs.arg(args, 0));
            if (from == null) {
                return null;
            }
            float[] pos = pointArg(api, st, ScriptJs.arg(args, 1));
            if (pos == null) {
                return null;
            }
            String faction = st.factions.get(from);
            if (faction == null) {
                return null;
            }
            AlertMsg m = new AlertMsg();
            m.from = from;
            m.faction = faction;
            m.x = pos[0];
            m.y = pos[1];
            m.frame = st.frame();
            st.pendingAlerts.add(m);
            while (st.pendingAlerts.size() > 64) {
                st.pendingAlerts.remove(0);
            }
            return null;
        });
        api.addMethod(ai, "onAlert", (cx, thisObj, args) -> {
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 0));
            if (f == null) {
                return null;
            }
            JsHandler h = new JsHandler(f, api.engineRef().def(api.engineRef().currentScriptName()));
            st.onAlert.add(h);
            // ⚠ 契约声明返回「取消函数」，原实现 `return null` → 用户 `off()` 会 TypeError。
            return api.newFn("offAlert", (c2, t2, a2) -> {
                st.onAlert.remove(h);
                return null;
            });
        });
        api.addMethod(ai, "onSpot", (cx, thisObj, args) -> {
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 0));
            if (f == null) {
                return null;
            }
            JsHandler h = new JsHandler(f, api.engineRef().def(api.engineRef().currentScriptName()));
            st.onSpot.add(h);
            return api.newFn("offSpot", (c2, t2, a2) -> {
                st.onSpot.remove(h);
                return null;
            });
        });
        api.attach("ai", ai);
    }

    private static Actor validTarget(AiState st, Agent ag) {
        Actor t = ag.target;
        if (t == null || t.dead) {
            return null;
        }
        if (!ag.targetVisible) {
            double age = st.now() - ag.knownTime;
            if (age > Math.max(0.01f, ag.memory)) {
                return null;
            }
        }
        return t;
    }

    private static float[] pointArg(ScriptApi api, AiState st, Object v) {
        Actor a = api.actorOf(v);
        if (a != null) {
            return new float[]{a.x, a.y};
        }
        if (v instanceof Scriptable) {
            Scriptable s = (Scriptable) v;
            Object x = ScriptJs.get(s, "x");
            Object y = ScriptJs.get(s, "y");
            if (!ScriptJs.isMissing(x) && !ScriptJs.isMissing(y)) {
                return new float[]{ScriptJs.fnum(x, 0f), ScriptJs.fnum(y, 0f)};
            }
        }
        return null;
    }

    // ---------------- bwe.target ----------------

    private static void buildTarget(final ScriptApi api, final AiState st) {
        Scriptable target = api.newObj();
        api.addMethod(target, "cell", (cx, thisObj, args) -> {
            float wx = st.host.view.toWorldX(st.host.mouseX);
            float wy = st.host.view.toWorldY(st.host.mouseY);
            int ccx = st.world.toCellX(wx);
            int ccy = st.world.toCellY(wy);
            return cellObj(api, st, ccx, ccy);
        });
        api.addMethod(target, "entity", (cx, thisObj, args) -> {
            float wx = st.host.view.toWorldX(st.host.mouseX);
            float wy = st.host.view.toWorldY(st.host.mouseY);
            Actor hit = st.engine.topmostAt(wx, wy);
            return hit == null ? null : api.entityOf(hit);
        });
        api.addMethod(target, "inFront", (cx, thisObj, args) -> {
            Actor e = api.actorOf(ScriptJs.arg(args, 0));
            if (e == null) {
                return null;
            }
            float range = ScriptJs.fnum(ScriptJs.arg(args, 1),
                    st.host.scene == null ? 32f : st.host.scene.tileSize);
            float fx = e.faceX;
            float fy = e.faceY;
            if (fx == 0f && fy == 0f) {
                fx = 0f;
                fy = 1f;
            }
            float len = (float) Math.sqrt(fx * fx + fy * fy);
            float px = e.x + fx / len * range;
            float py = e.y + fy / len * range;
            Actor hit = st.engine.topmostAt(px, py);
            if (hit == null || hit == e) {
                return cellObj(api, st, st.world.toCellX(px), st.world.toCellY(py));
            }
            return api.entityOf(hit);
        });
        api.attach("target", target);
    }

    private static Scriptable cellObj(ScriptApi api, AiState st, int cx, int cy) {
        Scriptable o = api.newObj();
        put(o, "cx", Double.valueOf(cx));
        put(o, "cy", Double.valueOf(cy));
        put(o, "x", Double.valueOf(st.world.cellCenterX(cx)));
        put(o, "y", Double.valueOf(st.world.cellCenterY(cy)));
        String mat = materialAt(cx, cy);
        put(o, "material", mat);
        return o;
    }

    // ---------------- bwe.seed（确定性随机） ----------------

    private static void installSeed(final ScriptApi api, final AiState st) {
        Scriptable seed = api.newObj();
        api.addMethod(seed, "set", (cx, thisObj, args) -> {
            double n = ScriptJs.num(ScriptJs.arg(args, 0), DEFAULT_SEED);
            reseed(st, (long) n);
            return Double.valueOf(st.seed);
        });
        api.addMethod(seed, "get", (cx, thisObj, args) -> Double.valueOf(st.seed));
        api.addMethod(seed, "reset", (cx, thisObj, args) -> {
            reseed(st, DEFAULT_SEED);
            return Double.valueOf(st.seed);
        });
        api.addMethod(seed, "defaultSeed", (cx, thisObj, args) -> Double.valueOf(DEFAULT_SEED));
        api.attach("seed", seed);

        // 让根上的 random/randomInt/chance/pick 复用同一个确定性随机源：
        // Flex 的 get 先查 values 再查槽位，所以这里 attach 会覆盖 ScriptApi 注册的版本。
        api.attach("random", api.newFn("random", (cx, thisObj, args) -> {
            double a = ScriptJs.num(ScriptJs.arg(args, 0), 0);
            double b = ScriptJs.num(ScriptJs.arg(args, 1), 1);
            if (b < a) {
                double t = a;
                a = b;
                b = t;
            }
            return Double.valueOf(a + st.rng.nextDouble() * (b - a));
        }));
        api.attach("randomInt", api.newFn("randomInt", (cx, thisObj, args) -> {
            int a = ScriptJs.inum(ScriptJs.arg(args, 0), 0);
            int b = ScriptJs.inum(ScriptJs.arg(args, 1), 1);
            if (b < a) {
                int t = a;
                a = b;
                b = t;
            }
            return Double.valueOf(a + st.rng.nextInt(b - a + 1));
        }));
        api.attach("chance", api.newFn("chance", (cx, thisObj, args) ->
                Boolean.valueOf(st.rng.nextDouble() < ScriptJs.num(ScriptJs.arg(args, 0), 0.5))));
        api.attach("pick", api.newFn("pick", (cx, thisObj, args) -> {
            Object arr = ScriptJs.arg(args, 0);
            if (!(arr instanceof Scriptable)) {
                return null;
            }
            int n = lengthOf(arr);
            if (n <= 0) {
                return null;
            }
            return ScriptableObject.getProperty((Scriptable) arr, st.rng.nextInt(n));
        }));
    }

    private static void reseed(AiState st, long seed) {
        st.seed = seed;
        st.rng = new Random(seed);
        // 兄弟子系统（材质场 / 物理）各自有确定性随机：把种子转调给它们的静态入口。
        // 用反射是为了不形成编译期依赖（三个文件并行开发）；对端没有这个入口就静默跳过。
        propagateSeed("Studio.runtime.ScriptFields", seed);
        propagateSeed("Studio.runtime.ScriptPhysics", seed);
    }

    private static final Map<String, Method> SEED_METHODS = new HashMap<String, Method>();
    private static final Map<String, Boolean> SEED_RESOLVED = new HashMap<String, Boolean>();

    private static void propagateSeed(String className, long seed) {
        Method m;
        synchronized (SEED_METHODS) {
            if (!SEED_RESOLVED.containsKey(className)) {
                SEED_RESOLVED.put(className, Boolean.TRUE);
                try {
                    Method found = Class.forName(className).getDeclaredMethod("setSeed", long.class);
                    if (java.lang.reflect.Modifier.isStatic(found.getModifiers())) {
                        found.setAccessible(true);
                        SEED_METHODS.put(className, found);
                    }
                } catch (Throwable ignored) {
                }
            }
            m = SEED_METHODS.get(className);
        }
        if (m == null) {
            return;
        }
        try {
            m.invoke(null, Long.valueOf(seed));
        } catch (Throwable ignored) {
        }
    }

    /** 供兄弟子系统（场/物理）复用的确定性随机源：同一 base seed + 子系统名 → 固定序列。 */
    static Random createRandom(String salt) {
        long s = DEFAULT_SEED;
        if (salt != null) {
            for (int i = 0; i < salt.length(); i++) {
                s = s * 31L + salt.charAt(i);
            }
        }
        return new Random(s);
    }

    // ---------------- 每帧模拟 ----------------

    private static void tick(AiState st, float dt) {
        long t0 = System.nanoTime();
        try {
            double now = st.now();
            if (st.agents.isEmpty() && st.pendingAlerts.isEmpty()) {
                return;
            }
            pruneAgents(st);
            processAlerts(st, now);
            processVision(st, now);
            processMemory(st, now);
        } catch (Throwable t) {
            st.engine.host.scriptLog("[脚本] ai tick 异常: " + t);
        } finally {
            st.tickNanos += System.nanoTime() - t0;
            st.tickCount++;
        }
    }

    private static void pruneAgents(AiState st) {
        if (st.agents.isEmpty()) {
            return;
        }
        List<Actor> dead = null;
        for (Actor a : st.agents.keySet()) {
            if (a == null || a.dead) {
                if (dead == null) {
                    dead = new ArrayList<Actor>();
                }
                dead.add(a);
            }
        }
        if (dead != null) {
            for (Actor a : dead) {
                st.agents.remove(a);
            }
            st.invalidateAgentOrder();
        }
    }

    /** 警报：入队后下一个模拟 tick 才投递（一跳延迟），同阵营、排除发起者。 */
    private static void processAlerts(AiState st, double now) {
        if (st.pendingAlerts.isEmpty()) {
            return;
        }
        List<AlertMsg> batch = new ArrayList<AlertMsg>();
        for (int i = st.pendingAlerts.size() - 1; i >= 0; i--) {
            AlertMsg m = st.pendingAlerts.get(i);
            // 同帧发出的警报留到下一帧再投递：这就是契约里的「一跳延迟」。
            if (m.frame < st.frame()) {
                batch.add(m);
                st.pendingAlerts.remove(i);
            }
        }
        if (batch.isEmpty()) {
            return;
        }
        for (AlertMsg m : batch) {
            if (m.from == null || m.from.dead) {
                continue;
            }
            for (Agent ag : st.agentsInSceneOrder()) {
                Actor a = ag.actor;
                if (a == null || a.dead || a == m.from) {
                    continue;
                }
                String f = st.factions.get(a);
                if (f == null || !f.equals(m.faction)) {
                    continue;
                }
                if (!ag.targetVisible) {
                    ag.hasKnown = true;
                    ag.knownX = m.x;
                    ag.knownY = m.y;
                    ag.knownTime = now;
                    ag.knownFrom = "alert";
                }
                fireHandlers(st, st.onAlert, alertPayload(st, ag, m));
            }
        }
    }

    private static Scriptable alertPayload(AiState st, Agent ag, AlertMsg m) {
        Scriptable o = st.api.newObj();
        put(o, "entity", st.api.entityOf(ag.actor));
        Scriptable pos = st.api.newObj();
        put(pos, "x", Double.valueOf(m.x));
        put(pos, "y", Double.valueOf(m.y));
        put(o, "position", pos);
        put(o, "from", m.from == null || m.from.dead ? null : st.api.entityOf(m.from));
        return o;
    }

    /** 视觉：找最近的可见敌对目标；发现边缘触发 onSpot。引擎不决定任何状态转换。 */
    private static void processVision(AiState st, double now) {
        if (st.agents.isEmpty()) {
            return;
        }
        List<Actor> all = st.api.actorsSnapshot();
        // 按「观察者阵营」预筛敌对候选：200 个 AI × 220 个实体的全量两两 hostile 检查
        // 会白白吃掉大半帧预算，先按阵营各算一次（阵营数一般个位数）。
        // 缓存只在阵营映射或场景 actor 数量变化时重建（逐帧稳定时不分配任何容器）。
        int actorCount = st.host.actors.size();
        if (st.hostileVersion != st.factionVersion || st.hostileActorCount != actorCount) {
            st.hostileByFaction.clear();
            for (Agent ag : st.agentsInSceneOrder()) {
                String f = st.factions.get(ag.actor);
                if (f == null || st.hostileByFaction.containsKey(f)) {
                    continue;
                }
                List<Actor> list = new ArrayList<Actor>();
                for (int i = 0; i < all.size(); i++) {
                    Actor b = all.get(i);
                    if (b == null) {
                        continue;
                    }
                    String fb = st.factions.get(b);
                    if (fb != null && relationOf(st, f, fb) < 0) {
                        list.add(b);
                    }
                }
                st.hostileByFaction.put(f, list);
            }
            st.hostileVersion = st.factionVersion;
            st.hostileActorCount = actorCount;
        }
        Map<String, List<Actor>> hostileCache = st.hostileByFaction;
        for (Agent ag : st.agentsInSceneOrder()) {
            Actor a = ag.actor;
            if (a == null || a.dead) {
                continue;
            }
            String f = st.factions.get(a);
            List<Actor> candidates = f == null ? null : hostileCache.get(f);
            Actor best = null;
            float bestD2 = Float.MAX_VALUE;
            if (candidates != null) {
                // 试过「按空间桶索引只扫视距内候选」：实测反而更慢（visionScan
                // 39µs → 68µs），因为本场景 20 个敌人摊在 200 个守卫的小地图里，
                // 桶查找的 Map/散列开销超过了省下的距离比较。已回滚，保留全量扫描。
                for (int i = 0; i < candidates.size(); i++) {
                    Actor b = candidates.get(i);
                    if (b == a || b.dead || !b.o.visible) {
                        continue;
                    }
                    float dx = b.x - a.x;
                    float dy = b.y - a.y;
                    float d2 = dx * dx + dy * dy;
                    if (d2 > ag.sight * ag.sight || d2 >= bestD2) {
                        continue;
                    }
                    if (!canSee(st, a, b)) {
                        continue;
                    }
                    best = b;
                    bestD2 = d2;
                }
            }
            boolean firstSpot = best != null && ag.target != best;
            ag.targetVisible = best != null;
            if (best != null) {
                ag.target = best;
                ag.hasKnown = true;
                ag.knownX = best.x;
                ag.knownY = best.y;
                ag.knownTime = now;
                ag.knownFrom = "sight";
                if (firstSpot) {
                    fireHandlers(st, st.onSpot, spotPayload(st, ag, best));
                }
            }
        }
    }

    private static Scriptable spotPayload(AiState st, Agent ag, Actor target) {
        Scriptable o = st.api.newObj();
        put(o, "entity", st.api.entityOf(ag.actor));
        put(o, "target", st.api.entityOf(target));
        return o;
    }

    private static void processMemory(AiState st, double now) {
        for (Agent ag : st.agentsInSceneOrder()) {
            if (ag.target != null && ag.target.dead) {
                clearKnown(ag);
                continue;
            }
            if (ag.targetVisible) {
                continue;
            }
            if (ag.hasKnown && now - ag.knownTime > Math.max(0.01f, ag.memory)) {
                clearKnown(ag);
            }
        }
    }

    private static void fireHandlers(AiState st, List<JsHandler> list, Scriptable payload) {
        if (list.isEmpty()) {
            return;
        }
        for (JsHandler h : new ArrayList<JsHandler>(list)) {
            try {
                st.engine.invoke(h.def, h.fn,
                        h.def == null ? null : h.def.scope, new Object[]{payload});
            } catch (Throwable t) {
                st.engine.host.scriptLog("[脚本] ai 回调异常: " + t);
            }
        }
    }

    // ---------------- 几何 / 可见性 ----------------

    /** 瓦片视线：按 tile/2 步进采样（比 1px 步进快一个数量级，32px 墙不会漏）。 */
    private static boolean los(ScriptWorld world, float x1, float y1, float x2, float y2) {
        if (world == null) {
            return true;
        }
        float dx = x2 - x1;
        float dy = y2 - y1;
        float len = (float) Math.sqrt(dx * dx + dy * dy);
        float step = Math.max(4f, world.tile * 0.5f);
        int steps = (int) Math.min(512, Math.ceil(len / step));
        if (steps <= 1) {
            return !world.solidCell(world.toCellX(x1), world.toCellY(y1));
        }
        for (int i = 1; i < steps; i++) {
            float t = i / (float) steps;
            float x = x1 + dx * t;
            float y = y1 + dy * t;
            if (world.solidCell(world.toCellX(x), world.toCellY(y))) {
                return false;
            }
        }
        return true;
    }

    /** 一条线段穿过的「墙段数」（连续 solid 采样算一道墙）。 */
    private static int wallRuns(ScriptWorld world, float x1, float y1, float x2, float y2) {
        if (world == null) {
            return 0;
        }
        float dx = x2 - x1;
        float dy = y2 - y1;
        float len = (float) Math.sqrt(dx * dx + dy * dy);
        float step = Math.max(4f, world.tile * 0.5f);
        int steps = (int) Math.min(512, Math.ceil(len / step));
        if (steps <= 0) {
            return 0;
        }
        int runs = 0;
        boolean inWall = false;
        for (int i = 0; i <= steps; i++) {
            float t = i / (float) steps;
            float x = x1 + dx * t;
            float y = y1 + dy * t;
            boolean solid = world.solidCell(world.toCellX(x), world.toCellY(y));
            if (solid && !inWall) {
                runs++;
            }
            inWall = solid;
        }
        return runs;
    }

    // ---------------- 与 ScriptFields 的弱耦合（反射，读不到就跳过） ----------------

    private static volatile boolean smokeResolved;
    private static volatile Method smokeMethod;
    private static volatile boolean materialResolved;
    private static volatile Method materialMethod;

    /**
     * 烟雾强度：反射调用 {@code ScriptFields} 的静态查询方法（字段：
     * {@code smokeAt(int cx,int cy)} / {@code smokeAtCell} / {@code smoke} / {@code sample(String,int,int)}）。
     * 读不到（对端还没实现 / 没暴露）→ 返回 -1，canSee 只按瓦片遮挡。
     */
    private static float smokeAt(int cx, int cy) {
        if (!smokeResolved) {
            smokeResolved = true;
            smokeMethod = resolveStatic("smokeAt", "smokeAtCell", "smoke", "sampleSmoke");
            if (smokeMethod == null) {
                smokeMethod = resolveSample();
            }
        }
        Method m = smokeMethod;
        if (m == null) {
            return -1f;
        }
        try {
            Object r;
            if (m.getParameterTypes().length == 3 && m.getParameterTypes()[0] == String.class) {
                r = m.invoke(null, "smoke", Integer.valueOf(cx), Integer.valueOf(cy));
            } else {
                r = m.invoke(null, Integer.valueOf(cx), Integer.valueOf(cy));
            }
            return r instanceof Number ? ((Number) r).floatValue() : -1f;
        } catch (Throwable t) {
            return -1f;
        }
    }

    private static String materialAt(int cx, int cy) {
        if (!materialResolved) {
            materialResolved = true;
            materialMethod = resolveStatic("materialAt", "materialOf", "material", "tileMaterial");
        }
        Method m = materialMethod;
        if (m == null) {
            return null;
        }
        try {
            Object r = m.invoke(null, Integer.valueOf(cx), Integer.valueOf(cy));
            return r == null || r == Undefined.instance ? null : Context.toString(r);
        } catch (Throwable t) {
            return null;
        }
    }

    private static Method resolveStatic(String... names) {
        try {
            Class<?> c = Class.forName("Studio.runtime.ScriptFields");
            for (String name : names) {
                try {
                    Method m = c.getDeclaredMethod(name, int.class, int.class);
                    if (java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                        m.setAccessible(true);
                        return m;
                    }
                } catch (NoSuchMethodException ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static Method resolveSample() {
        try {
            Class<?> c = Class.forName("Studio.runtime.ScriptFields");
            Method m = c.getDeclaredMethod("sample", String.class, int.class, int.class);
            if (java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                m.setAccessible(true);
                return m;
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    // ---------------- 小工具 ----------------

    private static float clamp(float v, float a, float b) {
        return v < a ? a : (v > b ? b : v);
    }

    private static Scriptable argObj(Object v) {
        return v instanceof ScriptableObject ? (ScriptableObject) v : null;
    }

    private static void put(Scriptable target, String name, Object value) {
        ScriptJs.put(target, name, value);
    }

    private static Scriptable jsArray(ScriptApi api, List<Object> values) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        Scriptable scope = ScriptableObject.getTopLevelScope(api.newObj());
        return cx.newArray(scope, values.toArray());
    }

    private static int lengthOf(Object arrayLike) {
        if (!(arrayLike instanceof Scriptable)) {
            return 0;
        }
        Object len = ScriptableObject.getProperty((Scriptable) arrayLike, "length");
        return (int) ScriptJs.num(len, 0);
    }
}
