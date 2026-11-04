package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;

/**
 * 全局 {@code bwe} 命名空间（契约 docs/scripting-api.md §2 Phase 1）。
 *
 * <p>全部用 Java 侧 Scriptable 实现，没有 JS 预置脚本。对象/方法都包成
 * {@link ScriptJs.Flex} + lambda 函数；坐标、尺寸、可见性等「活属性」用 getter/setter，
 * 写进去立刻反映到宿主运行时（与编辑器模块共用同一份数据，契约 §3）。
 *
 * <p>这里的每个方法都只会在「ScriptEngine 的 update/draw 调用栈里」被 Rhino 调到，
 * 所以可以放心用 {@link Context#getCurrentContext()}。
 */
final class ScriptApi {

    private final ScriptEngine engine;
    private final TopDownRuntime host;
    private final Scriptable shared;

    private ScriptJs.Flex bwe;
    private ScriptJs.Flex worldObj;
    private ScriptJs.Flex inputObj;
    private ScriptJs.Flex cameraObj;
    private ScriptJs.Flex timeObj;
    private ScriptJs.Flex drawObj;
    private ScriptJs.Flex saveObj;
    private ScriptJs.Flex audioObj;
    private ScriptJs.Flex prefabObj;
    private ScriptJs.Flex poolObj;

    /** 预制体 / 对象池（{@code bwe.prefab} / {@code bwe.pool}）。 */
    private ScriptPrefab prefabs;

    /** 实体染色（{@code e.setColor} / {@code e.setAlpha}）直接存在 {@code Actor.tint} 上（渲染热字段）。 */

    /**
     * 父子关系（{@code e.parent} / {@code e.children()}）。
     *
     * <p>只有<b>脚本层</b>的归属关系：父子各自仍是独立 Actor（参与物理/绘制/查找），
     * 不是真正的坐标继承场景图 —— v1 的取舍，写进文档。
     */
    private final Map<Actor, Actor> parents =
            new IdentityHashMap<Actor, Actor>();

    /** {@code e.locked}：纯脚本侧状态（宿主 Actor 没有该字段，v1 只做「记住这个值」）。 */
    private final Map<Actor, Boolean> lockedActors =
            new IdentityHashMap<Actor, Boolean>();

    /** Actor ↔ 实体包装（同一 Actor 永远同一个 JS 对象）。 */
    private final Map<Actor, ScriptableObject> entities =
            new IdentityHashMap<Actor, ScriptableObject>();
    private final Map<Scriptable, Actor> wrapperActor =
            new IdentityHashMap<Scriptable, Actor>();
    private final Map<Actor, Map<String, ScriptableObject>> moduleWrappers =
            new IdentityHashMap<Actor, Map<String, ScriptableObject>>();
    private final Map<Actor, Map<String, List<Function>>> entityHandlers =
            new IdentityHashMap<Actor, Map<String, List<Function>>>();
    private final Map<Actor, Integer> frameLocks =
            new IdentityHashMap<Actor, Integer>();
    private final Map<Long, ScriptEngine.Attachment> attachHandles =
            new LinkedHashMap<Long, ScriptEngine.Attachment>();
    private long nextAttachId = 1;

    private final Random random = new Random();
    private boolean tweenWarned;

    ScriptApi(ScriptEngine engine, ScriptableObject shared) {
        this.engine = engine;
        this.host = engine.host;
        this.shared = shared;
    }

    // ---------------- 构建 ----------------

    void build(Context cx) {
        bwe = ScriptJs.flex(shared);
        buildRootFns();
        buildPrefab();
        buildWorld();
        buildInput();
        buildStick();
        buildCamera();
        buildTime();
        buildDraw();
        buildSave();
        buildAudio();
        buildMine();
        buildGrid();
        buildBoard();
        buildTextInput();
        buildTilemap();
        buildNav();
        buildInteract();
        buildSpawner();
        buildEmergence();
        buildOpenWorld();
        ScriptableObject.putProperty(shared, "bwe", bwe);
        // 常见 JS 习惯：console.log/error 映射到 bwe.log / bwe.error（契约外的小便利，不会冲突）。
        ScriptJs.Flex console = obj();
        method(console, "log", (c2, thisObj, args) -> {
            engine.log(joinArgs(args));
            return null;
        });
        method(console, "info", (c2, thisObj, args) -> {
            engine.log(joinArgs(args));
            return null;
        });
        method(console, "warn", (c2, thisObj, args) -> {
            engine.log(joinArgs(args));
            return null;
        });
        method(console, "error", (c2, thisObj, args) -> {
            engine.logError(joinArgs(args));
            return null;
        });
        ScriptableObject.putProperty(shared, "console", console);
    }

    // ---------------- 涌现式模拟基底（Phase 2，各自独立文件） ----------------

    /**
     * 材质 / 场 / 物理 / 感知·AI·阵营 / 拾取器。
     * 三个子系统分别由 {@link ScriptFields}、{@link ScriptPhysics}、{@link ScriptAi} 注册，
     * 互不改同一个文件；任何一个注册失败都只记日志，不影响其它脚本能力。
     */
    private void buildEmergence() {
        try {
            ScriptFields.install(this);
        } catch (Throwable t) {
            engine.host.scriptLog("[脚本] field/material 注册失败: " + t);
        }
        try {
            ScriptPhysics.install(this);
        } catch (Throwable t) {
            engine.host.scriptLog("[脚本] physics 注册失败: " + t);
        }
        try {
            ScriptAi.install(this);
        } catch (Throwable t) {
            engine.host.scriptLog("[脚本] ai/sense 注册失败: " + t);
        }
    }

    /**
     * 开放世界子系统注册（本轮新增）。
     *
     * <p>每个子系统<b>一个文件</b>、<b>一个 {@code install(ScriptApi)} 入口</b>，
     * 与 {@link ScriptFields} / {@link ScriptPhysics} / {@link ScriptAi} 同一套模式。
     * 这样改一个子系统不会碰到另一个人的文件，且任何一个注册失败都只记日志，
     * 不影响其它脚本能力（与 buildEmergence 的容错策略一致）。
     *
     * <p><b>注册顺序有语义</b>：
     * <ol>
     *   <li>{@code bwe.scene}    —— 场景切换要最先能接指令；</li>
     *   <li>{@code bwe.spatial} —— 空间区域要在碰撞/导航之前建好（它们要查 zone）；</li>
     *   <li>{@code bwe.collision} —— 碰撞事件派发依赖空间过滤；</li>
     *   <li>{@code bwe.actions} —— 输入映射层，独立，位置不重要；</li>
     *   <li>{@code bwe.road} / {@code bwe.vehicle} —— 车辆要查路网；</li>
     *   <li>{@code bwe.combat}  —— 战斗要查空间与碰撞；</li>
     *   <li>{@code bwe.debug}   —— 纯绘制，最后。</li>
     * </ol>
     */
    private void buildOpenWorld() {
        installSafely("scene", new Runnable() {
            @Override
            public void run() {
                ScriptScene.install(ScriptApi.this);
            }
        });
        installSafely("spatial", new Runnable() {
            @Override
            public void run() {
                ScriptSpatial.install(ScriptApi.this);
            }
        });
        installSafely("collision", new Runnable() {
            @Override
            public void run() {
                ScriptCollision.install(ScriptApi.this);
            }
        });
        installSafely("actions", new Runnable() {
            @Override
            public void run() {
                ScriptActions.install(ScriptApi.this);
            }
        });
        installSafely("road", new Runnable() {
            @Override
            public void run() {
                ScriptRoad.install(ScriptApi.this);
            }
        });
        installSafely("vehicle", new Runnable() {
            @Override
            public void run() {
                ScriptVehicle.install(ScriptApi.this);
            }
        });
        installSafely("combat", new Runnable() {
            @Override
            public void run() {
                ScriptCombat.install(ScriptApi.this);
            }
        });
        installSafely("debug", new Runnable() {
            @Override
            public void run() {
                ScriptDebug.install(ScriptApi.this);
            }
        });
        // 脚本性能剖析（契约 §6 的 bwe.prof）。放最后：它只读 ScriptEngine.metrics()，
        // 不依赖任何其它子系统；而 install 顺序决定「谁先挂到 bwe 上」，
        // 放末尾不会打乱既有 8 个子系统的注册顺序（有确定性断言依赖那个顺序）。
        installSafely("prof", new Runnable() {
            @Override
            public void run() {
                ScriptProf.install(ScriptApi.this);
            }
        });
        // 2D 光照脚本层（契约 docs/_fragments/lighting-contract.md §4 的 bwe.light）。
        // 放在最后：它只转发给 host.lighting（TopDownRuntime 构造时已建好），
        // 不依赖任何其它命名空间，也不被别的命名空间依赖。
        installSafely("light", new Runnable() {
            @Override
            public void run() {
                ScriptLight.install(ScriptApi.this);
            }
        });
    }

    private void installSafely(String name, Runnable body) {
        try {
            body.run();
        } catch (Throwable t) {
            engine.host.scriptLog("[脚本] " + name + " 注册失败: " + t);
        }
    }

    // ---- 供 ScriptFields / ScriptPhysics / ScriptAi 使用的包内工具 ----
    // 这三个类与 ScriptApi 同包，直接用下面这些入口，避免去改本文件。

    /** 新建一个 JS 对象（属性/方法表，见 ScriptJs.Flex）。 */
    Scriptable newObj() {
        return obj();
    }

    /** 在 target 上挂一个 Java 实现的方法。 */
    void addMethod(Scriptable target, String name, ScriptJs.Fn body) {
        method(target, name, body);
    }

    /** 新建一个 JS 函数值（可回传给用户当句柄）。 */
    Function newFn(String name, ScriptJs.Fn body) {
        return fn(name, body);
    }

    /**
     * 自检专用：按脚本视角读一次 {@code bwe.input.mouse.wheel}。
     *
     * <p>刻意走<b>和脚本完全相同</b>的 getter 路径（不是直接读宿主字段），
     * 这样断言才覆盖到「getter 真的接上了宿主事件源」。
     * 注意它有副作用：契约是「本帧增量」，读一次即清零。
     */
    int readWheel() {
        Object mouse = ScriptJs.get(inputObj, "mouse");
        Object w = ScriptJs.get(mouse, "wheel");
        return ScriptJs.inum(w, -999);
    }

    /** 把对象挂到 bwe.<name> 命名空间。 */
    void attach(String name, Scriptable value) {
        bwe.values.put(name, value);
    }

    /** 某个命名空间是否已注册（诊断/自检用，不是脚本 API）。 */
    boolean hasNamespace(String name) {
        return bwe != null && !ScriptJs.isMissing(ScriptJs.get(bwe, name));
    }

    /** 把 Actor 包成 JS 里的 Entity（同一 Actor 复用同一个包装对象）。 */
    Scriptable entityOf(Actor a) {
        return entity(a);
    }

    /** JS 值 → Actor（不是 Entity 包装则返回 null）。 */
    Actor actorOf(Object jsValue) {
        return unwrap(jsValue);
    }

    ScriptEngine engineRef() {
        return engine;
    }

    TopDownRuntime hostRef() {
        return host;
    }

    /** 当前所有 Actor（只读快照，包含脚本 spawn 出来的）。 */
    List<Actor> actorsSnapshot() {
        return new ArrayList<Actor>(host.actors);
    }

    private static String joinArgs(Object[] args) {        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < args.length; i++) {
            if (i > 0) {
                sb.append(' ');
            }
            sb.append(ScriptJs.str(args[i], ""));
        }
        return sb.toString();
    }

    private ScriptJs.Flex obj() {
        return ScriptJs.flex(shared);
    }

    private Function fn(String name, ScriptJs.Fn body) {
        return ScriptJs.fn(shared, name, body);
    }

    private void method(Scriptable target, String name, ScriptJs.Fn body) {
        ScriptJs.method(target, name, body);
    }

    private Scriptable array(List<?> values) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        return cx.newArray(shared, values.toArray());
    }

    private static ScriptableObject argObj(Object v) {
        if (v instanceof ScriptableObject) {
            return (ScriptableObject) v;
        }
        if (v instanceof Scriptable) {
            return null;
        }
        return null;
    }

    // ---------------- 根：log / 工具函数 / 全局事件 ----------------

    private void buildRootFns() {
        method(bwe, "log", (cx, thisObj, args) -> {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < args.length; i++) {
                if (i > 0) {
                    sb.append(' ');
                }
                sb.append(ScriptJs.str(args[i], ""));
            }
            engine.log(sb.toString());
            return null;
        });
        method(bwe, "error", (cx, thisObj, args) -> {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < args.length; i++) {
                if (i > 0) {
                    sb.append(' ');
                }
                sb.append(ScriptJs.str(args[i], ""));
            }
            engine.logError(sb.toString());
            return null;
        });
        method(bwe, "random", (cx, thisObj, args) -> {
            double a = ScriptJs.num(ScriptJs.arg(args, 0), 0);
            double b = ScriptJs.num(ScriptJs.arg(args, 1), 1);
            if (b < a) {
                double t = a;
                a = b;
                b = t;
            }
            return Double.valueOf(a + random.nextDouble() * (b - a));
        });
        method(bwe, "randomInt", (cx, thisObj, args) -> {
            int a = ScriptJs.inum(ScriptJs.arg(args, 0), 0);
            int b = ScriptJs.inum(ScriptJs.arg(args, 1), 1);
            if (b < a) {
                int t = a;
                a = b;
                b = t;
            }
            return Double.valueOf(a + random.nextInt(b - a + 1));
        });
        method(bwe, "chance", (cx, thisObj, args) ->
                Boolean.valueOf(random.nextDouble() < ScriptJs.num(ScriptJs.arg(args, 0), 0.5)));
        method(bwe, "pick", (cx, thisObj, args) -> {
            Object a = ScriptJs.arg(args, 0);
            if (a instanceof Scriptable) {
                int n = lengthOf(a);
                if (n <= 0) {
                    return null;
                }
                return ScriptableObject.getProperty((Scriptable) a, random.nextInt(n));
            }
            return null;
        });
        method(bwe, "clamp", (cx, thisObj, args) -> {
            double v = ScriptJs.num(ScriptJs.arg(args, 0), 0);
            double a = ScriptJs.num(ScriptJs.arg(args, 1), 0);
            double b = ScriptJs.num(ScriptJs.arg(args, 2), 1);
            if (b < a) {
                double t = a;
                a = b;
                b = t;
            }
            return Double.valueOf(v < a ? a : (v > b ? b : v));
        });
        method(bwe, "lerp", (cx, thisObj, args) -> {
            double a = ScriptJs.num(ScriptJs.arg(args, 0), 0);
            double b = ScriptJs.num(ScriptJs.arg(args, 1), 1);
            double t = ScriptJs.num(ScriptJs.arg(args, 2), 0);
            return Double.valueOf(a + (b - a) * t);
        });
        method(bwe, "dist", (cx, thisObj, args) -> {
            double x1 = ScriptJs.num(ScriptJs.arg(args, 0), 0);
            double y1 = ScriptJs.num(ScriptJs.arg(args, 1), 0);
            double x2 = ScriptJs.num(ScriptJs.arg(args, 2), 0);
            double y2 = ScriptJs.num(ScriptJs.arg(args, 3), 0);
            return Double.valueOf(Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)));
        });
        method(bwe, "call", (cx, thisObj, args) -> {
            String scriptName = ScriptJs.str(ScriptJs.arg(args, 0), "");
            String fnName = ScriptJs.str(ScriptJs.arg(args, 1), "");
            if (scriptName.isEmpty() || fnName.isEmpty()) {
                return null;
            }
            Object[] rest = new Object[Math.max(0, args.length - 2)];
            for (int i = 0; i < rest.length; i++) {
                rest[i] = args[i + 2];
            }
            return engine.callNamed(scriptName, fnName, rest);
        });
        method(bwe, "has", (cx, thisObj, args) ->
                Boolean.valueOf(engine.hasScript(ScriptJs.str(ScriptJs.arg(args, 0), ""))));
        method(bwe, "on", (cx, thisObj, args) -> {
            String event = ScriptJs.str(ScriptJs.arg(args, 0), "");
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            engine.addHook(event, f, engine.def(engine.currentScriptName()));
            return null;
        });
        method(bwe, "off", (cx, thisObj, args) -> {
            String event = ScriptJs.str(ScriptJs.arg(args, 0), "");
            engine.removeHook(event, ScriptJs.fnArg(ScriptJs.arg(args, 1)));
            return null;
        });
        method(bwe, "after", (cx, thisObj, args) -> {
            double sec = ScriptJs.num(ScriptJs.arg(args, 0), 0);
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            return Double.valueOf(engine.addTimer(sec, false, f, engine.def(engine.currentScriptName()), 1));
        });
        method(bwe, "every", (cx, thisObj, args) -> {
            double sec = ScriptJs.num(ScriptJs.arg(args, 0), 1);
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            ScriptableObject opts = argObj(ScriptJs.arg(args, 2));
            int times = opts == null ? -1 : ScriptJs.inum(ScriptJs.get(opts, "times"), -1);
            return Double.valueOf(engine.addTimer(sec, true, f, engine.def(engine.currentScriptName()), times));
        });
        method(bwe, "cancel", (cx, thisObj, args) -> {
            engine.cancelTimer(ScriptJs.num(ScriptJs.arg(args, 0), -1));
            return null;
        });
        // bwe.scripts.call / bwe.scripts.has（与 bwe.call / bwe.has 等价，兼容 bwe.d.ts）
        ScriptJs.Flex scriptsNs = obj();
        method(scriptsNs, "call", (cx, thisObj, args) -> {
            String scriptName = ScriptJs.str(ScriptJs.arg(args, 0), "");
            String fnName = ScriptJs.str(ScriptJs.arg(args, 1), "");
            if (scriptName.isEmpty() || fnName.isEmpty()) {
                return null;
            }
            Object[] rest = new Object[Math.max(0, args.length - 2)];
            for (int i = 0; i < rest.length; i++) {
                rest[i] = args[i + 2];
            }
            return engine.callNamed(scriptName, fnName, rest);
        });
        method(scriptsNs, "has", (cx, thisObj, args) ->
                Boolean.valueOf(engine.hasScript(ScriptJs.str(ScriptJs.arg(args, 0), ""))));
        ScriptJs.put(bwe, "scripts", scriptsNs);
        // Phase 2 占位：返回句柄，不改变任何属性；避免脚本探测 API 时炸掉。
        method(bwe, "tween", (cx, thisObj, args) -> {
            if (!tweenWarned) {
                tweenWarned = true;
                engine.log("bwe.tween 属 Phase 2，本版本不生效（返回空句柄）");
            }
            final ScriptJs.Flex handle = obj();
            method(handle, "done", (c2, t2, a2) -> handle);
            method(handle, "cancel", (c2, t2, a2) -> null);
            return handle;
        });
    }

    private static int lengthOf(Object arrayLike) {
        if (!(arrayLike instanceof Scriptable)) {
            return 0;
        }
        Object len = ScriptableObject.getProperty((Scriptable) arrayLike, "length");
        return (int) ScriptJs.num(len, 0);
    }

    // ---------------- bwe.prefab / bwe.pool ----------------

    /**
     * 预制体与对象池：{@link ScriptPrefab} 负责模板/实例/池的全部数据，
     * 这里只做「挂命名空间 + 提供唯一的生成入口」。
     */
    private void buildPrefab() {
        try {
            prefabs = ScriptPrefab.install(this);
            prefabObj = prefabs.prefabNamespace();
            poolObj = prefabs.poolNamespace();
            bwe.values.put("prefab", prefabObj);
            bwe.values.put("pool", poolObj);
        } catch (Throwable t) {
            engine.host.scriptLog("[脚本] prefab/pool 注册失败: " + t);
        }
    }

    /**
     * <b>唯一的实体生成入口</b>：{@code bwe.world.spawn} / {@code bwe.prefab.spawn} / clone /
     * pool.acquire 全部走这里，保证「生成出来的东西」只有一套行为。
     *
     * <p>{@code opts} 是可选的 {@code ScriptableObject}（键名见 docs/scripting-api.md §2.1），
     * 支持的字段：x,y,asset,name,kind,z,layer,halfW,halfH,scaleX,scaleY,rotation,visible,
     * animMode,animFps,script,tags,modules,props,parent。
     */
    Actor spawnActor(Object opts) {
        Scriptable o = opts instanceof Scriptable ? (Scriptable) opts : null;
        if (o == null) {
            return null;
        }
        float x = ScriptJs.fnum(ScriptJs.get(o, "x"), 0f);
        float y = ScriptJs.fnum(ScriptJs.get(o, "y"), 0f);
        String asset = ScriptJs.str(ScriptJs.get(o, "asset"), "");
        String name = ScriptJs.str(ScriptJs.get(o, "name"), "");
        String kind = ScriptJs.str(ScriptJs.get(o, "kind"), "PROP");
        int z = ScriptJs.inum(ScriptJs.get(o, "z"), 0);
        float halfW = ScriptJs.fnum(ScriptJs.get(o, "halfW"), 0f);
        float halfH = ScriptJs.fnum(ScriptJs.get(o, "halfH"), 0f);
        String script = ScriptJs.str(ScriptJs.get(o, "script"), "");
        List<String> tags = new ArrayList<String>();
        Object tagv = ScriptJs.get(o, "tags");
        if (tagv instanceof Scriptable) {
            int n = lengthOf(tagv);
            for (int i = 0; i < n; i++) {
                String t = ScriptJs.str(ScriptableObject.getProperty((Scriptable) tagv, i), "");
                if (!t.isEmpty() && !tags.contains(t)) {
                    tags.add(t);
                }
            }
        }
        List<GameData.RtModule> modules = new ArrayList<GameData.RtModule>();
        Object modv = ScriptJs.get(o, "modules");
        if (modv instanceof Scriptable) {
            int n = lengthOf(modv);
            for (int i = 0; i < n; i++) {
                GameData.RtModule m = parseModule(ScriptableObject.getProperty((Scriptable) modv, i));
                if (m != null) {
                    modules.add(m);
                }
            }
        }
        Actor a = engine.spawnScripted(x, y, asset, name, kind, z, halfW, halfH,
                script, tags, modules);
        if (a == null) {
            return null;
        }
        // 宿主 spawnScripted 只填了基础字段，其余在返回后补齐（都是包内可见字段，不需要改宿主）。
        if (o != null) {
            Object v = ScriptJs.get(o, "layer");
            if (!ScriptJs.isMissing(v)) {
                a.o.layer = ScriptJs.inum(v, 0);
            } else {
                // ★ 没显式给 layer 时，跟随**场景对象的主 layer**（不是写死的 0）。
                //
                // 踩过的真实缺陷：排序键是 layer → z → y，而本工程的城市对象全在 layer=4，
                // 脚本 spawn 出来的 NPC/车辆 layer 默认 0 → 排在最前面先画，
                // 被底图（layer=4）整片盖住。表现是「日志说生成了 20 个行人，
                // 画面上一个都看不见」，而 drawCall 计数完全正常 —— 极难定位。
                a.o.layer = engine.host.dominantSceneLayer();
            }
            v = ScriptJs.get(o, "scaleX");
            if (!ScriptJs.isMissing(v)) {
                a.o.scaleX = ScriptJs.fnum(v, 1f);
            }
            v = ScriptJs.get(o, "scaleY");
            if (!ScriptJs.isMissing(v)) {
                a.o.scaleY = ScriptJs.fnum(v, 1f);
            }
            v = ScriptJs.get(o, "rotation");
            if (!ScriptJs.isMissing(v)) {
                a.o.rotation = ScriptJs.fnum(v, 0f);
            }
            v = ScriptJs.get(o, "visible");
            if (!ScriptJs.isMissing(v)) {
                a.o.visible = ScriptJs.bool(v, true);
            }
            v = ScriptJs.get(o, "animMode");
            if (!ScriptJs.isMissing(v)) {
                a.o.animMode = normalizeAnimMode(ScriptJs.str(v, "默认"));
            }
            v = ScriptJs.get(o, "animFps");
            if (!ScriptJs.isMissing(v)) {
                a.o.animFps = ScriptJs.fnum(v, 8f);
            }
            Object props = ScriptJs.get(o, "props");
            if (props instanceof ScriptableObject) {
                for (Object keyObj : ScriptableObject.getPropertyIds((ScriptableObject) props)) {
                    String k = Context.toString(keyObj);
                    a.o.props.put(k, propText(
                            ScriptableObject.getProperty((ScriptableObject) props, k)));
                }
            }
            Object parent = ScriptJs.get(o, "parent");
            if (!ScriptJs.isMissing(parent)) {
                setParent(a, parent);
            }
        }
        return a;
    }

    /** {@code e.attach} 的 Java 版（预制体的 children 复用同一套子精灵数据）。 */
    ScriptEngine.Attachment attachSprite(Actor a, String asset, float dx, float dy,
                                         int z, float rotation, float alpha, float w, float h) {
        if (a == null) {
            return null;
        }
        ScriptEngine.Attachment at = new ScriptEngine.Attachment(a);
        at.assetName = asset == null ? "" : asset;
        at.dx = dx;
        at.dy = dy;
        at.z = z;
        at.rotation = rotation;
        at.alpha = alpha;
        at.w = w;
        at.h = h;
        at.id = nextAttachId++;
        engine.attachments.add(at);
        attachHandles.put(Long.valueOf(at.id), at);
        return at;
    }

    /** 实体染色（0~1）；null = 未染色（渲染侧原样画）。状态存在宿主 Actor 上，这里只读。 */
    float[] tintOf(Actor a) {
        return a == null ? null : a.tint;
    }

    /** 设置父子关系（{@code null} = 脱离父级）。 */
    void setParent(Actor child, Object parentValue) {
        if (child == null) {
            return;
        }
        Actor parent = unwrap(parentValue);
        if (parent == null) {
            parents.remove(child);
            return;
        }
        if (parent == child || isAncestor(parent, child)) {
            return;
        }
        parents.put(child, parent);
    }

    /** 取父级（没有返回 null）。 */
    Actor parentOf(Actor child) {
        return child == null ? null : parents.get(child);
    }

    /** 取所有直接子级（顺序 = 设置顺序，不保证稳定）。 */
    List<Actor> childrenOf(Actor parent) {
        List<Actor> out = new ArrayList<Actor>();
        if (parent == null) {
            return out;
        }
        for (Map.Entry<Actor, Actor> e : parents.entrySet()) {
            if (e.getValue() == parent && !e.getKey().dead) {
                out.add(e.getKey());
            }
        }
        return out;
    }

    /** candidate 是否在 node 的祖先链上（防环）。 */
    private boolean isAncestor(Actor candidate, Actor node) {
        Actor cur = parents.get(node);
        int guard = 0;
        while (cur != null && guard++ < 256) {
            if (cur == candidate) {
                return true;
            }
            cur = parents.get(cur);
        }
        return false;
    }

    /** 编辑器里的中文动画枚举归一化（{@code "first"/"once"/"loop"} 也认）。 */
    static String normalizeAnimMode(String mode) {
        if (mode == null || mode.isEmpty()) {
            return "默认";
        }
        if ("first".equalsIgnoreCase(mode) || "只显示首帧".equals(mode)) {
            return "只显示首帧";
        }
        if ("once".equalsIgnoreCase(mode) || "单次播放".equals(mode)) {
            return "单次播放";
        }
        return "默认";
    }

    // ---------------- bwe.world ----------------

    private void buildWorld() {
        worldObj = obj();
        method(worldObj, "mapSize", (cx, thisObj, args) -> {
            ScriptJs.Flex o = obj();
            o.values.put("w", Double.valueOf(host.mapWidth()));
            o.values.put("h", Double.valueOf(host.mapHeight()));
            return o;
        });
        method(worldObj, "tileSize", (cx, thisObj, args) ->
                Double.valueOf(host.scene == null ? host.data.tileSize : host.scene.tileSize));
        ScriptJs.Flex sceneObj = obj();
        String sceneName = host.data.scenes.isEmpty() ? "" : host.data.scenes.get(0).name;
        sceneObj.values.put("name", sceneName);
        sceneObj.getters.put("width", () -> Double.valueOf(host.mapWidth()));
        sceneObj.getters.put("height", () -> Double.valueOf(host.mapHeight()));
        sceneObj.getters.put("widthTiles", () -> Double.valueOf(host.scene == null ? 0 : host.scene.width));
        sceneObj.getters.put("heightTiles", () -> Double.valueOf(host.scene == null ? 0 : host.scene.height));
        sceneObj.getters.put("tileSize", () -> Double.valueOf(host.scene == null ? host.data.tileSize : host.scene.tileSize));
        worldObj.getters.put("scene", () -> sceneObj);

        method(worldObj, "find", (cx, thisObj, args) -> {
            Actor a = findOne(ScriptJs.arg(args, 0));
            return a == null ? null : entity(a);
        });
        method(worldObj, "findAll", (cx, thisObj, args) -> {
            List<Scriptable> list = new ArrayList<Scriptable>();
            for (Actor a : filtered(ScriptJs.arg(args, 0))) {
                list.add(entity(a));
            }
            return array(list);
        });
        method(worldObj, "entities", (cx, thisObj, args) -> {
            List<Scriptable> list = new ArrayList<Scriptable>();
            for (Actor a : host.actors) {
                if (!a.dead) {
                    list.add(entity(a));
                }
            }
            return array(list);
        });
        method(worldObj, "spawn", (cx, thisObj, args) -> spawn(ScriptJs.arg(args, 0)));
        // ---- 批量生成 / 克隆 ----
        method(worldObj, "spawnMany", (cx, thisObj, args) -> {
            List<Object> out = new ArrayList<Object>();
            Object list = ScriptJs.arg(args, 0);
            if (list instanceof Scriptable) {
                int n = lengthOf(list);
                for (int i = 0; i < n; i++) {
                    Scriptable e = spawn(ScriptableObject.getProperty((Scriptable) list, i));
                    if (e != null) {
                        out.add(e);
                    }
                }
            }
            return array(out);
        });
        method(worldObj, "spawnAt", (cx, thisObj, args) -> {
            ScriptableObject opts = argObj(ScriptJs.arg(args, 0));
            if (opts == null) {
                return null;
            }
            // 不复制 opts，直接在其上补 x/y：调用方通常是一次性字面量。
            ScriptJs.Flex merged = obj();
            if (opts instanceof ScriptJs.Flex) {
                merged.values.putAll(((ScriptJs.Flex) opts).values);
                for (Map.Entry<String, ScriptJs.Getter> e : ((ScriptJs.Flex) opts).getters.entrySet()) {
                    merged.getters.put(e.getKey(), e.getValue());
                }
                for (Map.Entry<String, ScriptJs.Setter> e : ((ScriptJs.Flex) opts).setters.entrySet()) {
                    merged.setters.put(e.getKey(), e.getValue());
                }
            }
            merged.values.put("x", Double.valueOf(ScriptJs.num(ScriptJs.arg(args, 1), 0)));
            merged.values.put("y", Double.valueOf(ScriptJs.num(ScriptJs.arg(args, 2), 0)));
            return spawn(merged);
        });
        method(worldObj, "clone", (cx, thisObj, args) -> {
            Actor src = unwrap(ScriptJs.arg(args, 0));
            if (src == null || src.dead) {
                return null;
            }
            if (prefabs == null) {
                return null;
            }
            ScriptPrefab.Def spec = prefabs.capture(src, true);
            ScriptableObject opts = argObj(ScriptJs.arg(args, 1));
            ScriptJs.Flex merged = obj();
            merged.values.put("x", Double.valueOf(src.x));
            merged.values.put("y", Double.valueOf(src.y));
            merged.values.put("name", src.o.name);
            if (opts != null) {
                if (opts instanceof ScriptJs.Flex) {
                    merged.values.putAll(((ScriptJs.Flex) opts).values);
                } else {
                    for (Object keyObj : ScriptableObject.getPropertyIds(opts)) {
                        String k = Context.toString(keyObj);
                        merged.values.put(k, ScriptableObject.getProperty(opts, k));
                    }
                }
            }
            Actor a = prefabs.spawnFromSpec(spec, merged, false);
            return a == null ? null : entity(a);
        });
        // ---- 批量销毁 ----
        method(worldObj, "clear", (cx, thisObj, args) -> {
            for (Actor a : new ArrayList<Actor>(host.actors)) {
                if (!a.dead) {
                    engine.destroyEntity(a);
                }
            }
            return null;
        });
        method(worldObj, "clearTag", (cx, thisObj, args) -> {
            String tag = ScriptJs.str(ScriptJs.arg(args, 0), "");
            if (tag.isEmpty()) {
                return null;
            }
            for (Actor a : new ArrayList<Actor>(host.actors)) {
                if (!a.dead && a.o.tags.contains(tag)) {
                    engine.destroyEntity(a);
                }
            }
            return null;
        });
        method(worldObj, "destroyAll", (cx, thisObj, args) -> {
            Object q = ScriptJs.arg(args, 0);
            List<Actor> targets = ScriptJs.isMissing(q)
                    ? new ArrayList<Actor>(host.actors)
                    : new ArrayList<Actor>(filtered(q));
            int n = 0;
            for (Actor a : targets) {
                if (!a.dead) {
                    engine.destroyEntity(a);
                    n++;
                }
            }
            return Double.valueOf(n);
        });
        method(worldObj, "count", (cx, thisObj, args) -> {
            Object q = ScriptJs.arg(args, 0);
            if (ScriptJs.isMissing(q)) {
                int n = 0;
                for (Actor a : host.actors) {
                    if (!a.dead) {
                        n++;
                    }
                }
                return Double.valueOf(n);
            }
            return Double.valueOf(filtered(q).size());
        });
        method(worldObj, "each", (cx, thisObj, args) -> {
            Object q = ScriptJs.arg(args, 0);
            Function fn = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            if (fn == null) {
                return null;
            }
            // 先拍快照：回调里 spawn/destroy 不会破坏迭代。
            List<Actor> list = ScriptJs.isMissing(q)
                    ? new ArrayList<Actor>(host.actors)
                    : filtered(q);
            for (Actor a : list) {
                if (a.dead) {
                    continue;
                }
                engine.invoke(engine.def(engine.currentScriptName()), fn, shared,
                        new Object[]{entity(a)});
            }
            return null;
        });

        method(worldObj, "destroy", (cx, thisObj, args) -> {
            Actor a = unwrap(ScriptJs.arg(args, 0));
            if (a != null) {
                engine.destroyEntity(a);
            }
            return null;
        });
        worldObj.getters.put("paused", () -> Boolean.valueOf(engine.paused));
        worldObj.setters.put("paused", v -> engine.paused = ScriptJs.bool(v, false));
        worldObj.getters.put("timeScale", () -> Double.valueOf(engine.timeScale));
        worldObj.setters.put("timeScale", v -> engine.timeScale = ScriptJs.fnum(v, 1f));
        method(worldObj, "on", (cx, thisObj, args) -> {
            engine.addWorldHandler(ScriptJs.str(ScriptJs.arg(args, 0), ""),
                    ScriptJs.fnArg(ScriptJs.arg(args, 1)), engine.def(engine.currentScriptName()));
            return null;
        });
        method(worldObj, "off", (cx, thisObj, args) -> {
            engine.removeWorldHandler(ScriptJs.str(ScriptJs.arg(args, 0), ""),
                    ScriptJs.fnArg(ScriptJs.arg(args, 1)));
            return null;
        });
        method(worldObj, "emit", (cx, thisObj, args) -> {
            engine.emitWorld(ScriptJs.str(ScriptJs.arg(args, 0), ""), ScriptJs.arg(args, 1));
            return null;
        });
        // 图层表：从 scene_*.json 顶层 "layers" 解析（GameData.RtScene.layers）。
        // 之前这里是「返回空数组」的 Phase 2 占位，而数据其实一直有导出 —— 现在真的返回。
        // 旧 Build 没有 layers 字段时返回空数组（向后兼容，脚本可先探测 length）。
        method(worldObj, "layers", (cx, thisObj, args) -> {
            List<Scriptable> out = new ArrayList<Scriptable>();
            if (host.scene != null) {
                for (GameData.RtLayer rl : host.scene.layers) {
                    ScriptJs.Flex o = obj();
                    o.values.put("id", rl.id);
                    o.values.put("name", rl.name);
                    o.values.put("visible", Boolean.valueOf(rl.visible));
                    o.values.put("locked", Boolean.valueOf(rl.locked));
                    o.values.put("order", Double.valueOf(rl.order));
                    out.add(o);
                }
            }
            return array(out);
        });
        ScriptJs.put(bwe, "world", worldObj);
    }

    private Actor findOne(Object q) {
        List<Actor> all = filtered(q);
        return all.isEmpty() ? null : all.get(0);
    }

    /** find/findAll 共用的查询：字符串（名字/标签/id）或 {name,tag,kind,id}。 */
    private List<Actor> filtered(Object q) {
        List<Actor> out = new ArrayList<Actor>();
        if (ScriptJs.isMissing(q)) {
            return out;
        }
        if (!(q instanceof Scriptable)) {
            String s = ScriptJs.str(q, "");
            if (s.isEmpty()) {
                return out;
            }
            for (Actor a : host.actors) {
                if (a.dead) {
                    continue;
                }
                if (s.equals(a.o.name) || s.equals(a.o.id) || a.o.tags.contains(s)) {
                    out.add(a);
                }
            }
            return out;
        }
        Scriptable o = (Scriptable) q;
        String name = ScriptJs.str(ScriptJs.get(o, "name"), null);
        String tag = ScriptJs.str(ScriptJs.get(o, "tag"), null);
        String kind = ScriptJs.str(ScriptJs.get(o, "kind"), null);
        String id = ScriptJs.str(ScriptJs.get(o, "id"), null);
        for (Actor a : host.actors) {
            if (a.dead) {
                continue;
            }
            if (name != null && !name.isEmpty() && !name.equals(a.o.name)) {
                continue;
            }
            if (id != null && !id.isEmpty() && !id.equals(a.o.id)) {
                continue;
            }
            if (tag != null && !tag.isEmpty() && !a.o.tags.contains(tag)) {
                continue;
            }
            if (kind != null && !kind.isEmpty() && !kind.equalsIgnoreCase(a.o.kind)) {
                continue;
            }
            out.add(a);
        }
        return out;
    }

    private Scriptable spawn(Object opts) {
        Actor a = spawnActor(opts);
        return a == null ? null : entity(a);
    }

    private static GameData.RtModule parseModule(Object item) {
        if (!(item instanceof Scriptable)) {
            return null;
        }
        Scriptable o = (Scriptable) item;
        GameData.RtModule m = new GameData.RtModule();
        m.def = ScriptJs.str(ScriptJs.get(o, "def"), ScriptJs.str(ScriptJs.get(o, "id"), ""));
        if (m.def.isEmpty()) {
            return null;
        }
        m.when = ScriptJs.str(ScriptJs.get(o, "when"), "ALWAYS");
        Object params = ScriptJs.get(o, "params");
        if (params instanceof Scriptable) {
            Scriptable p = (Scriptable) params;
            for (Object keyObj : ScriptableObject.getPropertyIds(p)) {
                String k = Context.toString(keyObj);
                Object v = ScriptableObject.getProperty(p, k);
                m.params.put(k, ScriptJs.str(v, ""));
            }
        }
        return m;
    }

    // ---------------- bwe.stick（虚拟摇杆 / 虚拟按键） ----------------

    /**
     * 虚拟摇杆与虚拟按键。
     *
     * <p><b>解决什么问题</b>：桌面向游戏靠 WASD/空格/回车/Tab/Esc 操作，触屏上没法按。
     * 这个模块一行就能把常用键变成屏幕按钮，并按手机手感自动摆位
     * （左下十字摇杆 + 右侧功能键），绘制在最上层、输入优先于场景点击。
     *
     * <p>用法：
     * <pre>
     * bwe.stick.mount()                          // 默认：WASD 十字 + 空格/回车/Tab/Esc
     * bwe.stick.mount("WASD,space,enter,tab,esc")
     * bwe.stick.mount("arrows,space")            // 方向键十字 + 空格
     * bwe.stick.hide() / bwe.stick.show()
     * bwe.stick.opacity(0.6)
     * bwe.stick.axis()                           // {x,y} 摇杆归一化轴（-1..1）
     * bwe.stick.down("space")                    // 该键当前是否按下
     * </pre>
     */
    private void buildStick() {
        ScriptJs.Flex stickObj = obj();
        method(stickObj, "mount", (cx, thisObj, args) -> {
            String spec = ScriptJs.str(ScriptJs.arg(args, 0), "");
            if (host.stick != null) {
                host.stick.mount(spec);
            }
            return null;
        });
        method(stickObj, "unmount", (cx, thisObj, args) -> {
            if (host.stick != null) {
                host.stick.releaseAll();
            }
            return null;
        });
        method(stickObj, "show", (cx, thisObj, args) -> {
            if (host.stick != null) {
                host.stick.setVisible(true);
            }
            return null;
        });
        method(stickObj, "hide", (cx, thisObj, args) -> {
            if (host.stick != null) {
                host.stick.releaseAll();
                host.stick.setVisible(false);
            }
            return null;
        });
        method(stickObj, "opacity", (cx, thisObj, args) -> {
            if (host.stick != null) {
                host.stick.setOpacity(ScriptJs.fnum(ScriptJs.arg(args, 0), 0.55f));
            }
            return null;
        });
        method(stickObj, "axis", (cx, thisObj, args) -> {
            ScriptJs.Flex o = obj();
            float[] a = host.stick == null ? new float[]{0f, 0f} : host.stick.axis();
            o.values.put("x", Double.valueOf(a[0]));
            o.values.put("y", Double.valueOf(a[1]));
            return o;
        });
        method(stickObj, "down", (cx, thisObj, args) -> {
            String id = ScriptJs.str(ScriptJs.arg(args, 0), "");
            return Boolean.valueOf(host.stick != null && host.stick.pressed(id));
        });
        stickObj.getters.put("mounted", () ->
                Boolean.valueOf(host.stick != null && host.stick.isMounted()));
        ScriptJs.put(bwe, "stick", stickObj);
    }

    // ---------------- bwe.input ----------------

    private void buildInput() {
        inputObj = obj();
        method(inputObj, "down", (cx, thisObj, args) -> {
            int code = keyCodeOf(ScriptJs.arg(args, 0));
            if (isMouse(code)) {
                return Boolean.valueOf(engine.mouseNow[mouseIndex(code)] || engine.mousePressed[mouseIndex(code)]);
            }
            return Boolean.valueOf(code > 0 && code < engine.held.length && engine.held[code]);
        });
        method(inputObj, "pressed", (cx, thisObj, args) -> {
            int code = keyCodeOf(ScriptJs.arg(args, 0));
            if (isMouse(code)) {
                return Boolean.valueOf(engine.mousePressed[mouseIndex(code)]);
            }
            return Boolean.valueOf(code > 0 && code < engine.pressed.length && engine.pressed[code]);
        });
        method(inputObj, "released", (cx, thisObj, args) -> {
            int code = keyCodeOf(ScriptJs.arg(args, 0));
            if (isMouse(code)) {
                int i = mouseIndex(code);
                return Boolean.valueOf(engine.mousePrev[i] && !engine.mouseNow[i]);
            }
            return Boolean.valueOf(code > 0 && code < engine.released.length && engine.released[code]);
        });
        method(inputObj, "axis", (cx, thisObj, args) -> {
            boolean left = engine.held[java.awt.event.KeyEvent.VK_A] || engine.held[java.awt.event.KeyEvent.VK_LEFT];
            boolean right = engine.held[java.awt.event.KeyEvent.VK_D] || engine.held[java.awt.event.KeyEvent.VK_RIGHT];
            boolean up = engine.held[java.awt.event.KeyEvent.VK_W] || engine.held[java.awt.event.KeyEvent.VK_UP];
            boolean down = engine.held[java.awt.event.KeyEvent.VK_S] || engine.held[java.awt.event.KeyEvent.VK_DOWN];
            float x = (right ? 1f : 0f) - (left ? 1f : 0f);
            float y = (down ? 1f : 0f) - (up ? 1f : 0f);
            float len = (float) Math.sqrt(x * x + y * y);
            if (len > 1f) {
                x /= len;
                y /= len;
            }
            ScriptJs.Flex o = obj();
            o.values.put("x", Double.valueOf(x));
            o.values.put("y", Double.valueOf(y));
            return o;
        });
        inputObj.getters.put("mouse", () -> {
            ScriptJs.Flex o = obj();
            o.values.put("x", Double.valueOf(host.mouseX));
            o.values.put("y", Double.valueOf(host.mouseY));
            o.values.put("worldX", Double.valueOf(host.view.toWorldX(host.mouseX)));
            o.values.put("worldY", Double.valueOf(host.view.toWorldY(host.mouseY)));
            o.values.put("left", Boolean.valueOf(engine.mouseNow[0] || engine.mousePressed[0]));
            o.values.put("middle", Boolean.valueOf(engine.mouseNow[1] || engine.mousePressed[1]));
            o.values.put("right", Boolean.valueOf(engine.mouseNow[2] || engine.mousePressed[2]));
            o.values.put("wheel", Double.valueOf(host.takeWheel()));
            return o;
        });
        // 光标显示/隐藏：真的改 AWT 组件光标（之前是空实现 -> null，文档却承诺有行为）。
        method(inputObj, "cursor", (cx, thisObj, args) -> {
            host.setCursorVisible(ScriptJs.bool(ScriptJs.arg(args, 0), true));
            return null;
        });
        ScriptJs.put(bwe, "input", inputObj);
    }

    private static boolean isMouse(int code) {
        return code <= -2;
    }

    private static int mouseIndex(int code) {
        return Math.max(0, Math.min(2, -code - 2));
    }

    private static int keyCodeOf(Object v) {
        if (v instanceof Number) {
            return ((Number) v).intValue();
        }
        String s = ScriptJs.str(v, "");
        if (s == null || s.isEmpty()) {
            return -1;
        }
        String lower = s.toLowerCase();
        if (lower.startsWith("mouse")) {
            String rest = lower.substring(5);
            if (rest.isEmpty()) {
                return -2;
            }
            try {
                int idx = Integer.parseInt(rest);
                return -2 - Math.max(0, Math.min(2, idx));
            } catch (NumberFormatException ignored) {
                if ("left".equals(rest)) {
                    return -2;
                }
                if ("middle".equals(rest)) {
                    return -3;
                }
                if ("right".equals(rest)) {
                    return -4;
                }
            }
        }
        return ScriptEngine.keyCode(s);
    }

    /**
     * 供其它命名空间（{@link ScriptActions}）复用的键名解析。
     *
     * <p>语义与 {@code bwe.input.down("KeyW")} 完全一致：三种写法都认
     * （{@code "Space"} / {@code " "} / {@code 32}），鼠标是 {@code "Mouse0"}。
     * 返回 {@code -1} 表示无法识别。
     */
    static int keyCodeOfPublic(Object v) {
        return keyCodeOf(v);
    }

    /** 供其它命名空间复用的数组长度读取（安全，非数组返回 0）。 */
    static int lengthOfPublic(Object arrayLike) {
        return lengthOf(arrayLike);
    }

    // ---------------- bwe.camera ----------------

    private void buildCamera() {
        cameraObj = obj();
        method(cameraObj, "follow", (cx, thisObj, args) -> {
            Actor a = unwrap(ScriptJs.arg(args, 0));
            ScriptableObject opts = argObj(ScriptJs.arg(args, 1));
            float smooth = opts == null ? 0.15f : ScriptJs.fnum(ScriptJs.get(opts, "smooth"), 0.15f);
            float lookAhead = opts == null ? 0f : ScriptJs.fnum(ScriptJs.get(opts, "lookAhead"), 0f);
            engine.cameraFollow(a, smooth, lookAhead);
            return null;
        });
        cameraObj.getters.put("pos", () -> {
            ScriptJs.Flex o = obj();
            o.values.put("x", Double.valueOf(host.view.camX));
            o.values.put("y", Double.valueOf(host.view.camY));
            return o;
        });
        method(cameraObj, "setPos", (cx, thisObj, args) -> {
            engine.cameraSetPos(ScriptJs.fnum(ScriptJs.arg(args, 0), host.view.camX),
                    ScriptJs.fnum(ScriptJs.arg(args, 1), host.view.camY));
            return null;
        });
        cameraObj.getters.put("zoom", () -> Double.valueOf(host.view.zoom));
        cameraObj.getters.put("size", () -> {
            ScriptJs.Flex o = obj();
            o.values.put("w", Double.valueOf((double) host.view.viewW));
            o.values.put("h", Double.valueOf((double) host.view.viewH));
            return o;
        });
        cameraObj.setters.put("zoom", v -> engine.cameraSetZoom(ScriptJs.fnum(v, 1f)));
        method(cameraObj, "setZoom", (cx, thisObj, args) -> {
            engine.cameraSetZoom(ScriptJs.fnum(ScriptJs.arg(args, 0), 1f));
            return null;
        });
        method(cameraObj, "shake", (cx, thisObj, args) -> {
            engine.cameraShake(ScriptJs.fnum(ScriptJs.arg(args, 0), 6f),
                    ScriptJs.fnum(ScriptJs.arg(args, 1), 0.25f));
            return null;
        });
        method(cameraObj, "bounds", (cx, thisObj, args) -> {
            Object rect = ScriptJs.arg(args, 0);
            if (rect instanceof Scriptable) {
                Scriptable r = (Scriptable) rect;
                engine.cameraBounds(ScriptJs.fnum(ScriptJs.get(r, "x"), 0f),
                        ScriptJs.fnum(ScriptJs.get(r, "y"), 0f),
                        ScriptJs.fnum(ScriptJs.get(r, "w"), host.mapWidth()),
                        ScriptJs.fnum(ScriptJs.get(r, "h"), host.mapHeight()));
            } else {
                engine.cameraClearBounds();
            }
            return null;
        });
        method(cameraObj, "worldToScreen", (cx, thisObj, args) -> {
            ScriptJs.Flex o = obj();
            o.values.put("x", Double.valueOf(host.view.toScreenX(ScriptJs.fnum(ScriptJs.arg(args, 0), 0f))));
            o.values.put("y", Double.valueOf(host.view.toScreenY(ScriptJs.fnum(ScriptJs.arg(args, 1), 0f))));
            return o;
        });
        method(cameraObj, "screenToWorld", (cx, thisObj, args) -> {
            ScriptJs.Flex o = obj();
            o.values.put("x", Double.valueOf(host.view.toWorldX(ScriptJs.fnum(ScriptJs.arg(args, 0), 0f))));
            o.values.put("y", Double.valueOf(host.view.toWorldY(ScriptJs.fnum(ScriptJs.arg(args, 1), 0f))));
            return o;
        });
        method(cameraObj, "setFit", (cx, thisObj, args) -> {
            String mode = ScriptJs.str(ScriptJs.arg(args, 0), "contain");
            host.view.fitMode = "cover".equalsIgnoreCase(mode)
                    ? Viewport.FIT_COVER : Viewport.FIT_CONTAIN;
            host.scriptCameraControl = true;
            if (engine.cameraTarget == null) {
                host.view.zoom = host.view.fitZoom();
                host.view.camX = host.mapWidth() / 2f;
                host.view.camY = host.mapHeight() / 2f;
            }
            return null;
        });
        ScriptJs.put(bwe, "camera", cameraObj);
    }

    // ---------------- bwe.time ----------------

    private void buildTime() {
        timeObj = obj();
        timeObj.getters.put("now", () -> Double.valueOf(engine.time));
        timeObj.getters.put("dt", () -> Double.valueOf(engine.frameDt));
        timeObj.getters.put("frame", () -> Double.valueOf(engine.frame));
        ScriptJs.put(bwe, "time", timeObj);
    }

    // ---------------- bwe.draw ----------------

    private void buildDraw() {
        drawObj = obj();
        method(drawObj, "text", (cx, thisObj, args) -> {
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            String text = ScriptJs.str(ScriptJs.arg(args, 2), "");
            ScriptableObject opts = argObj(ScriptJs.arg(args, 3));
            float size = opts == null ? 16f : ScriptJs.fnum(ScriptJs.get(opts, "size"), 16f);
            String color = opts == null ? "#ffffff" : ScriptJs.str(ScriptJs.get(opts, "color"), "#ffffff");
            String align = opts == null ? "left" : ScriptJs.str(ScriptJs.get(opts, "align"), "left");
            float alpha = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "alpha"), 1f);
            boolean shadow = opts == null || ScriptJs.bool(ScriptJs.get(opts, "shadow"), true);
            ScriptRender.Cmd cmd = engine.render.text(x, y, text, size, color, align, alpha, shadow);
            addDraw(cmd);
            return null;
        });
        method(drawObj, "rect", (cx, thisObj, args) -> {
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            float w = ScriptJs.fnum(ScriptJs.arg(args, 2), 0f);
            float h = ScriptJs.fnum(ScriptJs.arg(args, 3), 0f);
            ScriptableObject opts = argObj(ScriptJs.arg(args, 4));
            String fill = opts == null ? "#ffffff" : ScriptJs.str(ScriptJs.get(opts, "fill"), null);
            String stroke = opts == null ? null : ScriptJs.str(ScriptJs.get(opts, "stroke"), null);
            float alpha = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "alpha"), 1f);
            int radius = opts == null ? 0 : ScriptJs.inum(ScriptJs.get(opts, "radius"), 0);
            float lineWidth = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "width"), 1f);
            addDraw(engine.render.rect(x, y, w, h, fill, stroke, alpha, radius, lineWidth));
            return null;
        });
        method(drawObj, "line", (cx, thisObj, args) -> {
            float x1 = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y1 = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            float x2 = ScriptJs.fnum(ScriptJs.arg(args, 2), 0f);
            float y2 = ScriptJs.fnum(ScriptJs.arg(args, 3), 0f);
            ScriptableObject opts = argObj(ScriptJs.arg(args, 4));
            String color = opts == null ? "#ffffff" : ScriptJs.str(ScriptJs.get(opts, "color"), "#ffffff");
            float width = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "width"), 1f);
            float alpha = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "alpha"), 1f);
            addDraw(engine.render.line(x1, y1, x2, y2, color, width, alpha));
            return null;
        });
        method(drawObj, "circle", (cx, thisObj, args) -> {
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            float r = ScriptJs.fnum(ScriptJs.arg(args, 2), 0f);
            ScriptableObject opts = argObj(ScriptJs.arg(args, 3));
            String fill = opts == null ? "#ffffff" : ScriptJs.str(ScriptJs.get(opts, "fill"), null);
            String stroke = opts == null ? null : ScriptJs.str(ScriptJs.get(opts, "stroke"), null);
            float alpha = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "alpha"), 1f);
            float lineWidth = opts == null ? 1.5f : ScriptJs.fnum(ScriptJs.get(opts, "width"), 1.5f);
            addDraw(engine.render.circle(x, y, r, fill, stroke, alpha, lineWidth));
            return null;
        });
        method(drawObj, "sprite", (cx, thisObj, args) -> {
            String asset = ScriptJs.str(ScriptJs.arg(args, 0), "");
            float x = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 2), 0f);
            ScriptableObject opts = argObj(ScriptJs.arg(args, 3));
            float w = opts == null ? 0f : ScriptJs.fnum(ScriptJs.get(opts, "w"), 0f);
            float h = opts == null ? 0f : ScriptJs.fnum(ScriptJs.get(opts, "h"), 0f);
            float alpha = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "alpha"), 1f);
            float rotation = opts == null ? 0f : ScriptJs.fnum(ScriptJs.get(opts, "rotation"), 0f);
            int frame = opts == null ? 0 : ScriptJs.inum(ScriptJs.get(opts, "frame"), 0);
            String tint = opts == null ? null : ScriptJs.str(ScriptJs.get(opts, "tint"), null);
            addDraw(engine.render.sprite(asset, x, y, w, h, alpha, rotation, frame, tint));
            return null;
        });
        method(drawObj, "bar", (cx, thisObj, args) -> {
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            float w = ScriptJs.fnum(ScriptJs.arg(args, 2), 100f);
            float h = ScriptJs.fnum(ScriptJs.arg(args, 3), 8f);
            float pct = ScriptJs.fnum(ScriptJs.arg(args, 4), 1f);
            ScriptableObject opts = argObj(ScriptJs.arg(args, 5));
            String bg = opts == null ? null : ScriptJs.str(ScriptJs.get(opts, "bg"), null);
            String fg = opts == null ? null : ScriptJs.str(ScriptJs.get(opts, "fg"), null);
            String border = opts == null ? null : ScriptJs.str(ScriptJs.get(opts, "border"), null);
            float alpha = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "alpha"), 1f);
            addDraw(engine.render.bar(x, y, w, h, pct, bg, fg, border, alpha));
            return null;
        });
        method(drawObj, "measureText", (cx, thisObj, args) -> {
            String text = ScriptJs.str(ScriptJs.arg(args, 0), "");
            float size = ScriptJs.fnum(ScriptJs.arg(args, 1), 16f);
            float[] m = engine.render.measure(text, size);
            ScriptJs.Flex o = obj();
            o.values.put("w", Double.valueOf(m[0]));
            o.values.put("h", Double.valueOf(m[1]));
            return o;
        });
        method(drawObj, "world", (cx, thisObj, args) -> {
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 0));
            if (f == null) {
                return null;
            }
            engine.worldDrawDepth++;
            try {
                engine.callValue(f, new Object[0]);
            } finally {
                engine.worldDrawDepth--;
            }
            return null;
        });
        ScriptJs.put(bwe, "draw", drawObj);
    }

    // ---------------- bwe.mine（扫雷棋盘的运行时设置） ----------------
    // game.minesweeper 的参数平时在编辑器里改；这里给脚本一个运行时通道：
    // bwe.mine.set({rows:20, cols:16, mines:60}) → 立刻重建棋盘；
    // bwe.mine.state() → 回 {rows, cols, mines, flags, over, won}，给 HUD 用。
    private void buildMine() {
        ScriptJs.Flex o = obj();
        method(o, "set", (cx, thisObj, args) -> {
            Object opts = argObj(ScriptJs.arg(args, 0));
            if (host.minesweeper == null) return null;
            int rows = opts == null ? -1 : ScriptJs.inum(ScriptJs.get(opts, "rows"), -1);
            int cols = opts == null ? -1 : ScriptJs.inum(ScriptJs.get(opts, "cols"), -1);
            int mines = opts == null ? -1 : ScriptJs.inum(ScriptJs.get(opts, "mines"), -1);
            int seed = opts == null ? -1 : ScriptJs.inum(ScriptJs.get(opts, "seed"), -1);
            int cellSize = opts == null ? -1 : ScriptJs.inum(ScriptJs.get(opts, "cellSize"), -1);
            // 玩法模式：只认文档里的四种写法，认不出（含未传）就当「不改」
            int modeIdx = opts == null ? -1 : mineModeIndex(ScriptJs.get(opts, "mode"));
            Minesweeper m = host.minesweeper;
            if (rows > 0) m.rows = Math.max(3, Math.min(40, rows));
            if (cols > 0) m.cols = Math.max(3, Math.min(40, cols));
            boolean changed = rows > 0 || cols > 0 || modeIdx >= 0;
            if (mines > 0) m.wantedMines = mines;
            if (seed >= 0) m.seed = seed;
            if (cellSize > 0) m.cell = Math.max(16, Math.min(64, cellSize));
            if (modeIdx >= 0) m.complexMode = (modeIdx == 1);
            if (changed || mines > 0 || seed >= 0 || cellSize > 0) m.reset();
            return null;
        });
        method(o, "reset", (cx, thisObj, args) -> {
            if (host.minesweeper != null) host.minesweeper.reset();
            return null;
        });
        method(o, "state", (cx, thisObj, args) -> {
            Minesweeper m = host.minesweeper;
            ScriptJs.Flex out = obj();
            if (m == null) {
                out.values.put("rows", Double.valueOf(0));
                out.values.put("cols", Double.valueOf(0));
                out.values.put("mines", Double.valueOf(0));
                out.values.put("flags", Double.valueOf(0));
                out.values.put("mode", "normal");
                out.values.put("modeIndex", Double.valueOf(0));
                out.values.put("over", Boolean.valueOf(false));
                out.values.put("won", Boolean.valueOf(false));
                out.values.put("hitMine", Boolean.valueOf(false));
                out.values.put("elapsed", Double.valueOf(0));
                return out;
            }
            out.values.put("rows", Double.valueOf((double) m.rows));
            out.values.put("cols", Double.valueOf((double) m.cols));
            out.values.put("mines", Double.valueOf((double) m.mineCount));
            out.values.put("flags", Double.valueOf((double) m.flags));
            out.values.put("mode", m.complexMode ? "complex" : "normal");
            out.values.put("modeIndex", Double.valueOf(m.complexMode ? 1d : 0d));
            out.values.put("started", Boolean.valueOf(m.started));
            out.values.put("over", Boolean.valueOf(m.over));
            out.values.put("won", Boolean.valueOf(m.won));
            out.values.put("hitMine", Boolean.valueOf(m.over && !m.won));
            out.values.put("elapsed", Double.valueOf((double) m.elapsed));
            return out;
        });
        /**
         * 调试用：把整张棋盘的逐格状态打出来（"r,c:数字/雷/旗/开"）。
         *
         * <p><b>为什么需要</b>：{@code state()} 只给汇总（行列/雷数/旗数），
         * 而验证「点数字连锁翻开（chord）」必须知道<b>哪一格是数字、周围有几颗雷、
         * 哪几格还盖着</b>。没有逐格视图就只能靠猜坐标点，测不出真实行为。
         *
         * <p>输出格式：每格 {@code r,c=N}{@code M}{@code F}{@code O}
         * （M=是雷、F=已插旗、O=已翻开），行末换行。仅调试/取证用，不影响玩法。
         */
        method(o, "dump", (cx, thisObj, args) -> {
            Minesweeper m = host.minesweeper;
            if (m == null) {
                return "no-minesweeper";
            }
            StringBuilder sb = new StringBuilder();
            sb.append("grid ").append(m.rows).append('x').append(m.cols)
                    .append(" mines=").append(m.mineCount)
                    .append(" flags=").append(m.flags)
                    .append(" over=").append(m.over)
                    .append(" won=").append(m.won).append('\n');
            for (int r = 0; r < m.rows; r++) {
                for (int c = 0; c < m.cols; c++) {
                    int i = r * m.cols + c;
                    sb.append(r).append(',').append(c).append('=')
                            .append(m.counts[i]);
                    if (m.mine[i]) {
                        sb.append('M');
                    }
                    if (m.flag[i]) {
                        sb.append('F');
                    }
                    if (m.open[i]) {
                        sb.append('O');
                    }
                    sb.append(' ');
                }
                sb.append('\n');
            }
            String line = sb.toString();
            host.scriptLog("[mine.dump] " + line);
            return line;
        });
        ScriptJs.put(bwe, "mine", o);
    }

    /**
     * 解析 {@code bwe.mine.set({mode})} 的取值：{@code 1} = 复雷加殊，{@code 0} = 普通，
     * {@code -1} = 认不出（调用方按「不改」处理）。
     *
     * <p>口径同编辑器 pick 参数（docs/complexweeper-rules.md §8）：值里含 {@code 复雷} 或
     * {@code complex}（忽略大小写）即复雷；含 {@code 普通} 或 {@code normal} 即普通。
     * 这是 {@code bwe.mine} 的既有成员载荷字段，不新增方法名。
     */
    private static int mineModeIndex(Object v) {
        if (ScriptJs.isMissing(v)) {
            return -1;
        }
        String s = ScriptJs.str(v, "").trim();
        if (s.isEmpty()) {
            return -1;
        }
        String low = s.toLowerCase(Locale.ROOT);
        if (s.contains("复雷") || low.contains("complex")) {
            return 1;
        }
        if (s.contains("普通") || low.contains("normal")) {
            return 0;
        }
        return -1;
    }

    private void addDraw(ScriptRender.Cmd cmd) {
        if (cmd == null) {
            return;
        }
        cmd.world = engine.worldDrawDepth > 0;
        engine.drawCmds.add(cmd);
    }

    // ---------------- bwe.save（Phase 1 的 JSON 存档） ----------------

    private void buildSave() {
        saveObj = obj();
        final ScriptSave save = engine.save;
        method(saveObj, "set", (cx, thisObj, args) -> {
            if (save != null) {
                save.set(ScriptJs.str(ScriptJs.arg(args, 0), ""), ScriptJs.arg(args, 1));
            }
            return null;
        });
        method(saveObj, "get", (cx, thisObj, args) -> {
            if (save == null) {
                return ScriptJs.arg(args, 1);
            }
            return save.get(ScriptJs.str(ScriptJs.arg(args, 0), ""), ScriptJs.arg(args, 1));
        });
        method(saveObj, "has", (cx, thisObj, args) ->
                Boolean.valueOf(save != null && save.has(ScriptJs.str(ScriptJs.arg(args, 0), ""))));
        method(saveObj, "remove", (cx, thisObj, args) -> {
            if (save != null) {
                save.remove(ScriptJs.str(ScriptJs.arg(args, 0), ""));
            }
            return null;
        });
        method(saveObj, "clear", (cx, thisObj, args) -> {
            if (save != null) {
                save.clear();
            }
            return null;
        });
        method(saveObj, "flush", (cx, thisObj, args) ->
                Boolean.valueOf(save != null && save.write("auto")));
        method(saveObj, "write", (cx, thisObj, args) ->
                Boolean.valueOf(save != null && save.write(slotArg(args))));
        method(saveObj, "read", (cx, thisObj, args) ->
                Boolean.valueOf(save != null && save.read(slotArg(args))));
        method(saveObj, "exists", (cx, thisObj, args) ->
                Boolean.valueOf(save != null && save.exists(slotArg(args))));
        method(saveObj, "delete", (cx, thisObj, args) ->
                Boolean.valueOf(save != null && save.delete(slotArg(args))));
        ScriptJs.put(bwe, "save", saveObj);
    }

    private static String slotArg(Object[] args) {
        String slot = ScriptJs.str(ScriptJs.arg(args, 0), "auto");
        return slot == null || slot.isEmpty() ? "auto" : slot;
    }

    // ---------------- bwe.audio（WAV） ----------------

    private void buildAudio() {
        audioObj = obj();
        final ScriptAudio audio = engine.audio;
        method(audioObj, "play", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            ScriptableObject opts = argObj(ScriptJs.arg(args, 1));
            float volume = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "volume"), 1f);
            boolean loop = opts != null && ScriptJs.bool(ScriptJs.get(opts, "loop"), false);
            // pitch: 音高倍数（1 = 原调）。之前完全不读，d.ts/apiDocs 却声明了 —— 现在真的生效。
            float pitch = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "pitch"), 1f);
            if (!(pitch > 0f)) {
                pitch = 1f;
            }
            return Double.valueOf(audio == null ? -1 : audio.play(name, volume, loop, pitch));
        });
        method(audioObj, "stop", (cx, thisObj, args) -> {
            if (audio != null) {
                Object v = ScriptJs.arg(args, 0);
                if (v instanceof Number) {
                    audio.stop(((Number) v).longValue());
                } else {
                    audio.stopByName(ScriptJs.str(v, ""));
                }
            }
            return null;
        });
        method(audioObj, "music", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            ScriptableObject opts = argObj(ScriptJs.arg(args, 1));
            float volume = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "volume"), 1f);
            boolean loop = opts == null || ScriptJs.bool(ScriptJs.get(opts, "loop"), true);
            return Double.valueOf(audio == null ? -1 : audio.music(name, volume, loop));
        });
        method(audioObj, "volume", (cx, thisObj, args) -> {
            if (audio != null) {
                audio.setVolume(ScriptJs.fnum(ScriptJs.arg(args, 0), 1f));
            }
            return null;
        });
        ScriptJs.put(bwe, "audio", audioObj);
    }

    // ---------------- bwe.grid ----------------

    private void buildGrid() {
        ScriptJs.Flex gridObj = obj();
        gridObj.getters.put("cellSize",
                () -> Double.valueOf(host.scene == null ? host.data.tileSize : host.scene.tileSize));
        method(gridObj, "toCell", (cx, thisObj, args) -> {
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            ScriptJs.Flex o = obj();
            o.values.put("cx", Double.valueOf(engine.world.toCellX(x)));
            o.values.put("cy", Double.valueOf(engine.world.toCellY(y)));
            return o;
        });
        method(gridObj, "toWorld", (cx, thisObj, args) -> {
            int cx0 = ScriptJs.inum(ScriptJs.arg(args, 0), 0);
            int cy0 = ScriptJs.inum(ScriptJs.arg(args, 1), 0);
            ScriptJs.Flex o = obj();
            o.values.put("x", Double.valueOf(engine.world.cellCenterX(cx0)));
            o.values.put("y", Double.valueOf(engine.world.cellCenterY(cy0)));
            return o;
        });
        method(gridObj, "snap", (cx, thisObj, args) -> {
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            ScriptJs.Flex o = obj();
            o.values.put("x", Double.valueOf(engine.world.cellCenterX(engine.world.toCellX(x))));
            o.values.put("y", Double.valueOf(engine.world.cellCenterY(engine.world.toCellY(y))));
            return o;
        });
        ScriptJs.put(bwe, "grid", gridObj);
    }

    // ---------------- bwe.textinput（点一下就能直接键入的输入框） ----------------

    /**
     * 文本/数字输入框。解决「手机上改不了数字参数」：点一下弹软键盘，直接敲。
     *
     * <pre>
     * bwe.textinput.define("rows", 12, 5, 30)     // 数字框，范围 5~30
     * bwe.textinput.rect("rows", x, y, w, h)      // 归一化 0~1 位置（脚本知道自己的布局）
     * bwe.textinput.value("rows")                  // 当前文本
     * bwe.textinput.number("rows", 12)             // 当前整数值
     * bwe.textinput.active()                       // 是否有框在编辑
     * bwe.textinput.onSubmit(function(id, text){}) // 回车/点外面确认
     * </pre>
     */
    private void buildTextInput() {
        ScriptJs.Flex tObj = obj();
        method(tObj, "define", (cx, thisObj, args) -> {
            ScriptTextInput ti = host.textInput;
            if (ti == null) {
                return null;
            }
            String id = ScriptJs.str(ScriptJs.arg(args, 0), "");
            String val = ScriptJs.str(ScriptJs.arg(args, 1), "");
            int min = ScriptJs.inum(ScriptJs.arg(args, 2), 0);
            int max = ScriptJs.inum(ScriptJs.arg(args, 3), 0);
            boolean numeric = args.length > 4 ? ScriptJs.bool(ScriptJs.arg(args, 4), true)
                    : isAllDigitsOrEmpty(val);
            ti.define(id, val, min, max, numeric);
            return null;
        });
        method(tObj, "rect", (cx, thisObj, args) -> {
            ScriptTextInput ti = host.textInput;
            if (ti == null) {
                return null;
            }
            ScriptTextInput.Field f = ti.find(ScriptJs.str(ScriptJs.arg(args, 0), ""));
            if (f == null) {
                return null;
            }
            f.nx = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            f.ny = ScriptJs.fnum(ScriptJs.arg(args, 2), 0f);
            f.nw = ScriptJs.fnum(ScriptJs.arg(args, 3), 0f);
            f.nh = ScriptJs.fnum(ScriptJs.arg(args, 4), 0f);
            return null;
        });
        method(tObj, "value", (cx, thisObj, args) -> {
            ScriptTextInput ti = host.textInput;
            return ti == null ? "" : ti.textOf(ScriptJs.str(ScriptJs.arg(args, 0), ""));
        });
        method(tObj, "number", (cx, thisObj, args) -> {
            ScriptTextInput ti = host.textInput;
            if (ti == null) {
                return Double.valueOf(ScriptJs.fnum(ScriptJs.arg(args, 1), 0f));
            }
            return Double.valueOf(ti.intOf(ScriptJs.str(ScriptJs.arg(args, 0), ""),
                    (int) ScriptJs.fnum(ScriptJs.arg(args, 1), 0f)));
        });
        method(tObj, "setValue", (cx, thisObj, args) -> {
            ScriptTextInput ti = host.textInput;
            if (ti != null) {
                ScriptTextInput.Field f = ti.find(ScriptJs.str(ScriptJs.arg(args, 0), ""));
                if (f != null) {
                    f.text = ScriptJs.str(ScriptJs.arg(args, 1), "");
                }
            }
            return null;
        });
        method(tObj, "active", (cx, thisObj, args) -> {
            ScriptTextInput ti = host.textInput;
            return ti == null ? "" : (ti.isActive() ? ti.activeField().id : "");
        });
        method(tObj, "cancel", (cx, thisObj, args) -> {
            if (host.textInput != null) {
                host.textInput.cancelActive();
            }
            return null;
        });
        method(tObj, "onSubmit", (cx, thisObj, args) -> {
            ScriptTextInput ti = host.textInput;
            if (ti == null) {
                return null;
            }
            Object a0 = ScriptJs.arg(args, 0);
            if (!(a0 instanceof Function)) {
                return null;
            }
            final Function fn = (Function) a0;
            ti.setOnSubmit(field -> {
                // ⚠ 必须走「跨线程排队」，不能直接 invoke。
                //
                // 提交发生在 AWT 点击 / Android 触摸 / 软键盘回调里 —— 这些线程都没有
                // Rhino Context，直接调 engine.invoke 会静默返回 null（回调永不执行，
                // 表现就是「输入框按回车/点确认没反应」，且不报错）。
                // postScriptCall 把它排到下一次 update，在脚本上下文里执行，延迟 ≤1 帧。
                //
                // ⚠⚠ 必须**当场快照文本**，不能把 field.text 的读取留到下一帧 ——
                // 这是「输入有时无效 / 输入 30 却变成 12 / 串到别的框」的真因：
                // commitActive() 已经把 active=false 设好，而下一帧脚本 draw 会先执行
                // syncInputField → define(id, 业务值, ...)，define 看到 !active 就把
                // f.text 覆盖回业务值（12）。等排队回调真正跑起来，读到的已是 "12"，
                // 玩家输入的值被静默丢弃。快照之后无论下一帧怎么覆盖都不会再串。
                final String submittedId = field.id;
                final String submittedText = field.text;
                engine.postScriptCall(() -> engine.invoke(null, fn, null,
                        new Object[]{submittedId, submittedText}));
            });
            return null;
        });
        // ⚠ 必须返回「正在编辑的字段 id 字符串」（没有则 false），不是布尔值。
        // 脚本的写法是 `if (bwe.textinput.editing === it.id)` 来判断「这个框是不是在编辑」，
        // 早先这里返回 Boolean → 与任意 id 字符串都不相等 → 条件恒为 false，
        // 输入框的高亮底色和光标永远画不出来，看起来就是「输入框根本没有」。
        /** 校验某字段当前值；合法返回空串，否则返回给玩家看的中文提示。 */
        method(tObj, "validate", (cx, thisObj, args) ->
                host.textInput == null ? ""
                        : host.textInput.validate(ScriptJs.str(ScriptJs.arg(args, 0), "")));
        /** 刷新所有字段的提示（返回是否有字段非法）。 */
        method(tObj, "refreshHints", (cx, thisObj, args) ->
                Boolean.valueOf(host.textInput != null && host.textInput.refreshHints()));
        /** 某字段的提示文本（空 = 合法）。 */
        method(tObj, "hint", (cx, thisObj, args) -> {
            ScriptTextInput ti = host.textInput;
            if (ti == null) {
                return "";
            }
            ScriptTextInput.Field f = ti.find(ScriptJs.str(ScriptJs.arg(args, 0), ""));
            return f == null ? "" : f.hint;
        });
        tObj.getters.put("editing", () -> {
            ScriptTextInput ti = host.textInput;
            if (ti == null || !ti.isActive() || ti.activeField() == null) {
                return Boolean.FALSE;
            }
            return ti.activeField().id;
        });
        ScriptJs.put(bwe, "textinput", tObj);
    }

    private static boolean isAllDigitsOrEmpty(String v) {
        if (v == null || v.isEmpty()) {
            return true;
        }
        for (int i = 0; i < v.length(); i++) {
            if (v.charAt(i) < '0' || v.charAt(i) > '9') {
                return false;
            }
        }
        return true;
    }

    // ---------------- bwe.board（网格棋盘：格子状态读写） ----------------
    //
    // 注意与 bwe.grid 的区别（很容易混）：
    //   bwe.grid  = **瓦片地图**的坐标换算（toCell / toWorld / snap），任何工程都有；
    //   bwe.board = **网格模块**（grid.board 等）的格子状态（翻开/标记/读格），
    //               只有对象上挂了 grid.* / game.minesweeper 才有实际内容。
    // 两个命名空间分开，避免「同名不同义」的混乱。
    private void buildBoard() {
        ScriptJs.Flex boardObj = obj();
        method(boardObj, "size", (cx, thisObj, args) -> {
            GridBoard b = hostBoard();
            ScriptJs.Flex o = obj();
            o.values.put("rows", Double.valueOf(b == null ? 0 : b.rows));
            o.values.put("cols", Double.valueOf(b == null ? 0 : b.cols));
            o.values.put("count", Double.valueOf(b == null ? 0 : b.size()));
            return o;
        });
        method(boardObj, "opened", (cx, thisObj, args) -> {
            GridBoard b = hostBoard();
            if (b == null) {
                return Boolean.FALSE;
            }
            return Boolean.valueOf(b.isOpened(ScriptJs.inum(ScriptJs.arg(args, 0), -1)));
        });
        method(boardObj, "flagged", (cx, thisObj, args) -> {
            GridBoard b = hostBoard();
            if (b == null) {
                return Boolean.FALSE;
            }
            return Boolean.valueOf(b.isFlagged(ScriptJs.inum(ScriptJs.arg(args, 0), -1)));
        });
        /** 世界坐标 → 格子索引（越界 -1）。 */
        method(boardObj, "indexAt", (cx, thisObj, args) -> {
            GridBoard b = hostBoard();
            Minesweeper ms = host.minesweeper;
            if (b == null || ms == null) {
                return Integer.valueOf(-1);
            }
            float wx = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float wy = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            return Integer.valueOf(b.idxAtWorld(wx, wy,
                    ms.actor.x - b.pixelWidth() / 2f, ms.actor.y - b.pixelHeight() / 2f));
        });
        /** 打开一格（无雷玩法用它代替「点开」）。 */
        method(boardObj, "open", (cx, thisObj, args) -> {
            Minesweeper ms = host.minesweeper;
            if (ms == null) {
                return Boolean.FALSE;
            }
            int idx = ScriptJs.inum(ScriptJs.arg(args, 0), -1);
            if (idx < 0 || idx >= ms.board.size()) {
                return Boolean.FALSE;
            }
            ms.reveal(idx);
            return Boolean.TRUE;
        });
        /** 切换标记（无 flag 能力时不生效）。 */
        method(boardObj, "toggle", (cx, thisObj, args) -> {
            Minesweeper ms = host.minesweeper;
            if (ms == null) {
                return Boolean.FALSE;
            }
            int idx = ScriptJs.inum(ScriptJs.arg(args, 0), -1);
            if (idx < 0 || idx >= ms.board.size()) {
                return Boolean.FALSE;
            }
            ms.toggleFlag(idx);
            return Boolean.TRUE;
        });
        /** 泛洪统计：从某格开始能连到的未翻开格数（规则脚本常用）。 */
        method(boardObj, "floodCount", (cx, thisObj, args) -> {
            Minesweeper ms = host.minesweeper;
            if (ms == null) {
                return Integer.valueOf(0);
            }
            int idx = ScriptJs.inum(ScriptJs.arg(args, 0), -1);
            if (idx < 0 || idx >= ms.board.size()) {
                return Integer.valueOf(0);
            }
            return Integer.valueOf(ms.board.floodOpen(idx, i -> true));
        });
        boardObj.getters.put("mounted", () -> Boolean.valueOf(hostBoard() != null));
        ScriptJs.put(bwe, "board", boardObj);
    }

    /** 当前工程的网格内核（没挂网格模块时为 null）。 */
    private GridBoard hostBoard() {
        Minesweeper ms = host.minesweeper;
        return ms == null ? null : ms.board;
    }

    // ---------------- bwe.tilemap ----------------

    private void buildTilemap() {
        ScriptJs.Flex tm = obj();
        method(tm, "get", (cx, thisObj, args) ->
                Double.valueOf(engine.world.get(ScriptJs.inum(ScriptJs.arg(args, 0), 0),
                        ScriptJs.inum(ScriptJs.arg(args, 1), 0))));
        method(tm, "set", (cx, thisObj, args) -> {
            engine.world.set(ScriptJs.inum(ScriptJs.arg(args, 0), 0),
                    ScriptJs.inum(ScriptJs.arg(args, 1), 0),
                    ScriptJs.inum(ScriptJs.arg(args, 2), 0));
            return null;
        });
        method(tm, "solid", (cx, thisObj, args) ->
                Boolean.valueOf(engine.world.solidCell(ScriptJs.inum(ScriptJs.arg(args, 0), 0),
                        ScriptJs.inum(ScriptJs.arg(args, 1), 0))));
        method(tm, "setSolid", (cx, thisObj, args) -> {
            engine.world.setSolid(ScriptJs.inum(ScriptJs.arg(args, 0), 0),
                    ScriptJs.bool(ScriptJs.arg(args, 1), true));
            return null;
        });
        method(tm, "blocked", (cx, thisObj, args) ->
                Boolean.valueOf(engine.world.blocked(
                        ScriptJs.fnum(ScriptJs.arg(args, 0), 0f),
                        ScriptJs.fnum(ScriptJs.arg(args, 1), 0f),
                        ScriptJs.fnum(ScriptJs.arg(args, 2), 0f),
                        ScriptJs.fnum(ScriptJs.arg(args, 3), 0f))));
        method(tm, "raycast", (cx, thisObj, args) -> {
            float[] r = engine.world.raycast(
                    ScriptJs.fnum(ScriptJs.arg(args, 0), 0f),
                    ScriptJs.fnum(ScriptJs.arg(args, 1), 0f),
                    ScriptJs.fnum(ScriptJs.arg(args, 2), 0f),
                    ScriptJs.fnum(ScriptJs.arg(args, 3), 0f));
            ScriptJs.Flex o = obj();
            o.values.put("hit", Boolean.valueOf(r[0] > 0.5f));
            o.values.put("x", Double.valueOf(r[1]));
            o.values.put("y", Double.valueOf(r[2]));
            o.values.put("cx", Double.valueOf(r[3]));
            o.values.put("cy", Double.valueOf(r[4]));
            return o;
        });
        ScriptJs.put(bwe, "tilemap", tm);
    }

    // ---------------- bwe.nav ----------------

    private void buildNav() {
        ScriptJs.Flex navObj = obj();
        method(navObj, "find", (cx, thisObj, args) -> {
            float[] from = pointOf(ScriptJs.arg(args, 0));
            float[] to = pointOf(ScriptJs.arg(args, 1));
            if (from == null || to == null) {
                return array(new ArrayList<Object>());
            }
            ScriptableObject opts = argObj(ScriptJs.arg(args, 2));
            boolean diagonal = opts == null || ScriptJs.bool(ScriptJs.get(opts, "diagonal"), true);
            int maxNodes = opts == null ? 2000 : ScriptJs.inum(ScriptJs.get(opts, "maxNodes"), 2000);
            boolean smooth = opts == null || ScriptJs.bool(ScriptJs.get(opts, "smooth"), true);
            List<float[]> path = engine.world.findPath(from[0], from[1], to[0], to[1],
                    diagonal, maxNodes, smooth);
            List<Scriptable> out = new ArrayList<Scriptable>();
            for (float[] p : path) {
                ScriptJs.Flex o = obj();
                o.values.put("x", Double.valueOf(p[0]));
                o.values.put("y", Double.valueOf(p[1]));
                out.add(o);
            }
            return array(out);
        });
        method(navObj, "lineOfSight", (cx, thisObj, args) -> {
            float[] a = pointOf(ScriptJs.arg(args, 0));
            float[] b = pointOf(ScriptJs.arg(args, 1));
            if (a == null || b == null) {
                return Boolean.FALSE;
            }
            return Boolean.valueOf(engine.world.lineOfSight(a[0], a[1], b[0], b[1]));
        });
        method(navObj, "follow", (cx, thisObj, args) -> {
            Actor a = unwrap(ScriptJs.arg(args, 0));
            List<float[]> path = pathOf(ScriptJs.arg(args, 1));
            if (a == null || path.isEmpty()) {
                return null;
            }
            ScriptableObject opts = argObj(ScriptJs.arg(args, 2));
            float speed = opts == null ? 100f : ScriptJs.fnum(ScriptJs.get(opts, "speed"), 100f);
            float arrive = opts == null ? 2f : ScriptJs.fnum(ScriptJs.get(opts, "arrive"), 2f);
            Function onArrive = opts == null ? null : ScriptJs.fnArg(ScriptJs.get(opts, "onArrive"));
            engine.world.follow(a, path, speed, arrive, onArrive, engine.def(engine.currentScriptName()));
            return null;
        });
        method(navObj, "stop", (cx, thisObj, args) -> {
            Actor a = unwrap(ScriptJs.arg(args, 0));
            if (a != null) {
                engine.world.stopFollow(a);
            }
            return null;
        });
        ScriptJs.put(bwe, "nav", navObj);
    }

    private float[] pointOf(Object o) {
        Actor a = unwrap(o);
        if (a != null) {
            return new float[]{a.x, a.y};
        }
        if (o instanceof Scriptable) {
            Scriptable s = (Scriptable) o;
            Object x = ScriptJs.get(s, "x");
            Object y = ScriptJs.get(s, "y");
            if (!ScriptJs.isMissing(x) && !ScriptJs.isMissing(y)) {
                return new float[]{ScriptJs.fnum(x, 0f), ScriptJs.fnum(y, 0f)};
            }
        }
        return null;
    }

    private List<float[]> pathOf(Object o) {
        List<float[]> out = new ArrayList<float[]>();
        if (!(o instanceof Scriptable)) {
            return out;
        }
        int n = lengthOf(o);
        for (int i = 0; i < n; i++) {
            Object item = ScriptableObject.getProperty((Scriptable) o, i);
            float[] p = pointOf(item);
            if (p != null) {
                out.add(p);
            }
        }
        return out;
    }

    // ---------------- bwe.interact ----------------

    private void buildInteract() {
        ScriptJs.Flex it = obj();
        method(it, "nearest", (cx, thisObj, args) -> {
            Actor from = unwrap(ScriptJs.arg(args, 0));
            if (from == null) {
                from = engine.findPlayerActor();
            }
            ScriptableObject opts = argObj(ScriptJs.arg(args, 1));
            float radius = opts == null ? 48f : ScriptJs.fnum(ScriptJs.get(opts, "radius"), 48f);
            String tag = opts == null ? "" : ScriptJs.str(ScriptJs.get(opts, "tag"), "");
            Function filter = opts == null ? null : ScriptJs.fnArg(ScriptJs.get(opts, "filter"));
            Actor best = null;
            float bestDist = Float.MAX_VALUE;
            for (Actor a : host.actors) {
                if (a == from || a.dead || !a.o.visible) {
                    continue;
                }
                if (!tag.isEmpty() && !a.o.tags.contains(tag)) {
                    continue;
                }
                float dx = a.x - from.x;
                float dy = a.y - from.y;
                float d = (float) Math.sqrt(dx * dx + dy * dy);
                if (d > radius) {
                    continue;
                }
                if (filter != null) {
                    Object r = engine.callValue(filter, new Object[]{entity(a)});
                    if (!ScriptJs.bool(r, false)) {
                        continue;
                    }
                }
                if (d < bestDist) {
                    bestDist = d;
                    best = a;
                }
            }
            engine.interactActor = best;
            return best == null ? null : entity(best);
        });
        method(it, "prompt", (cx, thisObj, args) -> {
            Object v = ScriptJs.arg(args, 0);
            String text = ScriptJs.isMissing(v) || v == null ? null : ScriptJs.str(v, null);
            if (text == null || text.isEmpty()) {
                engine.prompt = null;
            } else {
                ScriptEngine.Prompt p = new ScriptEngine.Prompt();
                p.text = text;
                engine.prompt = p;
            }
            return null;
        });
        method(it, "setKey", (cx, thisObj, args) -> {
            engine.interactKey = keyCodeOf(ScriptJs.arg(args, 0));
            return null;
        });
        method(it, "onTrigger", (cx, thisObj, args) -> {
            engine.world.addInteractHandler(ScriptJs.fnArg(ScriptJs.arg(args, 0)),
                    engine.def(engine.currentScriptName()));
            return null;
        });
        ScriptJs.put(bwe, "interact", it);
    }

    // ---------------- bwe.spawner ----------------

    private void buildSpawner() {
        ScriptJs.Flex sp = obj();
        method(sp, "create", (cx, thisObj, args) -> {
            ScriptableObject opts = argObj(ScriptJs.arg(args, 0));
            if (opts == null) {
                return null;
            }
            String asset = ScriptJs.str(ScriptJs.get(opts, "asset"), "");
            String script = ScriptJs.str(ScriptJs.get(opts, "script"), "");
            int count = ScriptJs.inum(ScriptJs.get(opts, "count"), 1);
            float interval = ScriptJs.fnum(ScriptJs.get(opts, "interval"), 2f);
            int max = ScriptJs.inum(ScriptJs.get(opts, "max"), 10);
            ScriptableObject area = argObj(ScriptJs.get(opts, "area"));
            float ax = area == null ? 0f : ScriptJs.fnum(ScriptJs.get(area, "x"), 0f);
            float ay = area == null ? 0f : ScriptJs.fnum(ScriptJs.get(area, "y"), 0f);
            float aw = area == null ? host.mapWidth() : ScriptJs.fnum(ScriptJs.get(area, "w"), host.mapWidth());
            float ah = area == null ? host.mapHeight() : ScriptJs.fnum(ScriptJs.get(area, "h"), host.mapHeight());
            Function onSpawn = ScriptJs.fnArg(ScriptJs.get(opts, "onSpawn"));
            ScriptWorld.Spawner s = engine.world.createSpawner(asset, script, count, interval, max,
                    ax, ay, aw, ah, onSpawn, engine.def(engine.currentScriptName()));
            // 与 bwe.d.ts 的 SpawnerHandle = number 一致；stop 既接受 id 也接受 {id}
            return Double.valueOf(s.id);
        });
        method(sp, "stop", (cx, thisObj, args) -> {
            engine.world.stopSpawner(ScriptJs.arg(args, 0));
            return null;
        });
        ScriptJs.put(bwe, "spawner", sp);
    }

    // ---------------- 实体包装 ----------------

    /** 同一 Actor 的 JS 包装对象（缓存，保证 e1 === e2）。 */
    Scriptable entity(Actor a) {
        if (a == null) {
            return null;
        }
        ScriptableObject cached = entities.get(a);
        if (cached != null) {
            return cached;
        }
        final ScriptJs.Flex e = obj();
        entities.put(a, e);
        wrapperActor.put(e, a);

        e.getters.put("id", () -> a.o.id);
        e.getters.put("name", () -> a.o.name);
        e.setters.put("name", v -> a.o.name = ScriptJs.str(v, a.o.name));
        e.getters.put("kind", () -> a.o.kind);
        e.setters.put("kind", v -> a.o.kind = ScriptJs.str(v, a.o.kind));
        e.getters.put("x", () -> Double.valueOf(a.x));
        e.setters.put("x", v -> {
            a.x = ScriptJs.fnum(v, a.x);
            a.baseX = a.x;
        });
        e.getters.put("y", () -> Double.valueOf(a.y));
        e.setters.put("y", v -> {
            a.y = ScriptJs.fnum(v, a.y);
            a.baseY = a.y;
        });
        e.getters.put("z", () -> Double.valueOf(a.o.z));
        e.setters.put("z", v -> a.o.z = ScriptJs.inum(v, a.o.z));
        e.getters.put("rotation", () -> Double.valueOf(a.o.rotation));
        e.setters.put("rotation", v -> a.o.rotation = ScriptJs.fnum(v, a.o.rotation));
        e.getters.put("scaleX", () -> Double.valueOf(a.o.scaleX));
        e.setters.put("scaleX", v -> a.o.scaleX = ScriptJs.fnum(v, a.o.scaleX));
        e.getters.put("scaleY", () -> Double.valueOf(a.o.scaleY));
        e.setters.put("scaleY", v -> a.o.scaleY = ScriptJs.fnum(v, a.o.scaleY));
        e.getters.put("visible", () -> Boolean.valueOf(a.o.visible));
        e.setters.put("visible", v -> a.o.visible = ScriptJs.bool(v, a.o.visible));
        e.getters.put("layer", () -> Double.valueOf(a.o.layer));
        e.setters.put("layer", v -> a.o.layer = ScriptJs.inum(v, a.o.layer));
        e.getters.put("locked", () -> Boolean.valueOf(lockedActors.containsKey(a)));
        e.setters.put("locked", v -> {
            if (ScriptJs.bool(v, false)) {
                lockedActors.put(a, Boolean.TRUE);
            } else {
                lockedActors.remove(a);
            }
        });
        e.getters.put("animMode", () -> a.o.animMode);
        e.setters.put("animMode", v -> a.o.animMode = normalizeAnimMode(ScriptJs.str(v, a.o.animMode)));
        e.getters.put("animFps", () -> Double.valueOf(a.o.animFps));
        e.setters.put("animFps", v -> {
            a.o.animFps = ScriptJs.fnum(v, a.o.animFps);
            // 改 fps 时把帧锁定解除，否则会继续被 applyFrameLocks 钉住。
            frameLocks.remove(a);
        });
        e.getters.put("asset", () -> a.o.assetName);
        e.setters.put("asset", v -> {
            String name = ScriptJs.str(v, a.o.assetName);
            if (name != null && !name.isEmpty() && !name.equals(a.o.assetName)) {
                if (host.applyAsset(a, name)) {
                    // applyAsset 只换纹理，不改 assetName：这里同步，否则 e.asset 读回还是旧名。
                    a.o.assetName = name;
                } else {
                    engine.log("精灵素材不存在：" + name);
                }
            }
        });
        e.getters.put("alive", () -> Boolean.valueOf(!a.dead));
        e.getters.put("hp", () -> Double.valueOf(a.hp));
        e.setters.put("hp", v -> a.hp = ScriptJs.fnum(v, a.hp));
        e.getters.put("hpMax", () -> Double.valueOf(a.hpMax));
        e.setters.put("hpMax", v -> a.hpMax = ScriptJs.fnum(v, a.hpMax));
        e.getters.put("tags", () -> tagsOf(a));
        e.getters.put("pos", () -> {
            ScriptJs.Flex o = obj();
            o.values.put("x", Double.valueOf(a.x));
            o.values.put("y", Double.valueOf(a.y));
            return o;
        });
        e.getters.put("size", () -> {
            ScriptJs.Flex o = obj();
            o.values.put("w", Double.valueOf(host.drawWidth(a)));
            o.values.put("h", Double.valueOf(host.drawHeight(a)));
            return o;
        });
        e.setters.put("size", v -> {
            Scriptable s = v instanceof Scriptable ? (Scriptable) v : null;
            if (s == null) {
                return;
            }
            float w = ScriptJs.fnum(ScriptJs.get(s, "w"), host.drawWidth(a));
            float h = ScriptJs.fnum(ScriptJs.get(s, "h"), host.drawHeight(a));
            a.o.halfW = w / 2f;
            a.o.halfH = h / 2f;
        });

        method(e, "setPos", (c, thisObj, args) -> {
            a.x = ScriptJs.fnum(ScriptJs.arg(args, 0), a.x);
            a.y = ScriptJs.fnum(ScriptJs.arg(args, 1), a.y);
            a.baseX = a.x;
            a.baseY = a.y;
            return null;
        });
        method(e, "setSize", (c, thisObj, args) -> {
            float w = ScriptJs.fnum(ScriptJs.arg(args, 0), host.drawWidth(a));
            float h = ScriptJs.fnum(ScriptJs.arg(args, 1), host.drawHeight(a));
            a.o.halfW = w / 2f;
            a.o.halfH = h / 2f;
            return null;
        });
        method(e, "sprite", (c, thisObj, args) -> {
            ScriptableObject opts = argObj(ScriptJs.arg(args, 0));
            if (opts == null) {
                return null;
            }
            String asset = ScriptJs.str(ScriptJs.get(opts, "asset"), "");
            if (!asset.isEmpty()) {
                if (!host.applyAsset(a, asset)) {
                    engine.log("精灵素材不存在：" + asset);
                }
            }
            int frame = ScriptJs.inum(ScriptJs.get(opts, "frame"), -1);
            float fps = ScriptJs.fnum(ScriptJs.get(opts, "fps"), 8f);
            String mode = ScriptJs.str(ScriptJs.get(opts, "mode"), "loop");
            if (fps > 0f) {
                a.o.animFps = fps;
            }
            if ("first".equalsIgnoreCase(mode)) {
                a.o.animMode = "只显示首帧";
            } else if ("once".equalsIgnoreCase(mode)) {
                a.o.animMode = "单次播放";
            } else {
                a.o.animMode = "默认";
            }
            if (frame >= 0) {
                frameLocks.put(a, Integer.valueOf(frame));
            } else {
                frameLocks.remove(a);
            }
            return null;
        });
        method(e, "play", (c, thisObj, args) -> {
            String asset = ScriptJs.str(ScriptJs.arg(args, 0), "");
            frameLocks.remove(a);
            a.o.animMode = "默认";
            if (!asset.isEmpty() && !host.applyAsset(a, asset)) {
                engine.log("精灵素材不存在：" + asset);
            }
            return null;
        });
        method(e, "setFrame", (c, thisObj, args) -> {
            frameLocks.put(a, Integer.valueOf(Math.max(0, ScriptJs.inum(ScriptJs.arg(args, 0), 0))));
            a.o.animMode = "默认";
            a.o.animFps = 1f;
            return null;
        });
        method(e, "prop", (c, thisObj, args) -> {
            String key = ScriptJs.str(ScriptJs.arg(args, 0), "");
            Object def = ScriptJs.arg(args, 1);
            String raw = a.o.props.get(key);
            if (raw == null) {
                return def;
            }
            if (def instanceof Number) {
                try {
                    return Double.valueOf(Double.parseDouble(raw.trim()));
                } catch (NumberFormatException ex) {
                    return def;
                }
            }
            if (def instanceof Boolean) {
                String v = raw.trim();
                return Boolean.valueOf("开".equals(v) || "true".equalsIgnoreCase(v) || "1".equals(v));
            }
            return raw;
        });
        method(e, "setProp", (c, thisObj, args) -> {
            String key = ScriptJs.str(ScriptJs.arg(args, 0), "");
            if (key.isEmpty()) {
                return null;
            }
            a.o.props.put(key, propText(ScriptJs.arg(args, 1)));
            return null;
        });
        // ---- props 整体读写 ----
        method(e, "props", (c, thisObj, args) -> {
            ScriptJs.Flex o = obj();
            for (Map.Entry<String, String> entry : a.o.props.entrySet()) {
                o.values.put(entry.getKey(), entry.getValue());
            }
            return o;
        });
        method(e, "setProps", (c, thisObj, args) -> {
            ScriptableObject src = argObj(ScriptJs.arg(args, 0));
            if (src == null) {
                return null;
            }
            for (Object keyObj : ScriptableObject.getPropertyIds(src)) {
                String k = Context.toString(keyObj);
                a.o.props.put(k, propText(ScriptableObject.getProperty(src, k)));
            }
            return null;
        });
        // ---- 标签 ----
        method(e, "addTag", (c, thisObj, args) -> {
            String t = ScriptJs.str(ScriptJs.arg(args, 0), "");
            if (!t.isEmpty() && !a.o.tags.contains(t)) {
                a.o.tags.add(t);
            }
            return Boolean.valueOf(a.o.tags.contains(t));
        });
        method(e, "removeTag", (c, thisObj, args) -> {
            String t = ScriptJs.str(ScriptJs.arg(args, 0), "");
            boolean removed = !t.isEmpty() && a.o.tags.remove(t);
            return Boolean.valueOf(removed);
        });
        method(e, "hasTag", (c, thisObj, args) ->
                Boolean.valueOf(a.o.tags.contains(ScriptJs.str(ScriptJs.arg(args, 0), ""))));
        method(e, "setTags", (c, thisObj, args) -> {
            a.o.tags.clear();
            Object v = ScriptJs.arg(args, 0);
            if (v instanceof Scriptable) {
                int n = lengthOf(v);
                for (int i = 0; i < n; i++) {
                    String t = ScriptJs.str(ScriptableObject.getProperty((Scriptable) v, i), "");
                    if (!t.isEmpty() && !a.o.tags.contains(t)) {
                        a.o.tags.add(t);
                    }
                }
            }
            return null;
        });
        // ---- 模块增删 ----
        method(e, "addModule", (c, thisObj, args) -> {
            String def = ScriptJs.str(ScriptJs.arg(args, 0), "");
            if (def.isEmpty()) {
                return Boolean.FALSE;
            }
            GameData.RtModule m = moduleOf(a, def);
            if (m == null) {
                m = new GameData.RtModule();
                m.def = def;
                m.when = "ALWAYS";
                a.o.modules.add(m);
            }
            Object params = ScriptJs.arg(args, 1);
            if (params instanceof ScriptableObject) {
                for (Object keyObj : ScriptableObject.getPropertyIds((ScriptableObject) params)) {
                    String k = Context.toString(keyObj);
                    m.params.put(k, propText(ScriptableObject.getProperty((ScriptableObject) params, k)));
                }
            }
            String when = ScriptJs.str(ScriptJs.arg(args, 2), "");
            if (!when.isEmpty()) {
                m.when = when;
            }
            // ⚠ 运行时加 combat.health 后必须重算血量，否则 hpMax 还停在上一次的值
            // （与 spawnScripted 里的 applyHealthModule 同一份语义）。
            engine.applyHealthModule(a);
            return Boolean.TRUE;
        });
        method(e, "removeModule", (c, thisObj, args) -> {
            GameData.RtModule m = moduleOf(a, ScriptJs.str(ScriptJs.arg(args, 0), ""));
            if (m == null) {
                return Boolean.FALSE;
            }
            a.o.modules.remove(m);
            Map<String, ScriptableObject> cache = moduleWrappers.get(a);
            if (cache != null) {
                cache.remove(m.def);
            }
            // 移掉血量模块后 hpMax 不该再跟着旧值走：回到"无模块"语义（保留当前值不重置）。
            return Boolean.TRUE;
        });
        // ---- 父子关系 ----
        e.getters.put("parent", () -> {
            Actor p = parentOf(a);
            return p == null || p.dead ? null : entity(p);
        });
        e.setters.put("parent", v -> setParent(a, v));
        method(e, "children", (c, thisObj, args) -> {
            List<Scriptable> list = new ArrayList<Scriptable>();
            for (Actor child : childrenOf(a)) {
                list.add(entity(child));
            }
            return array(list);
        });
        // ---- 染色 / 透明度 ----
        method(e, "setColor", (c, thisObj, args) -> {
            Object first = ScriptJs.arg(args, 0);
            float r;
            float g;
            float b;
            float alpha = ScriptJs.fnum(ScriptJs.arg(args, 3), 1f);
            if (first instanceof Scriptable && args.length <= 2) {
                // setColor({r, g, b, a}) 也认
                Scriptable o = (Scriptable) first;
                r = ScriptJs.fnum(ScriptJs.get(o, "r"), 1f);
                g = ScriptJs.fnum(ScriptJs.get(o, "g"), 1f);
                b = ScriptJs.fnum(ScriptJs.get(o, "b"), 1f);
                alpha = ScriptJs.fnum(ScriptJs.get(o, "a"), 1f);
            } else {
                r = ScriptJs.fnum(first, 1f);
                g = ScriptJs.fnum(ScriptJs.arg(args, 1), 1f);
                b = ScriptJs.fnum(ScriptJs.arg(args, 2), 1f);
            }
            // 0~1 与 0~255 都认（任意通道 > 1 视作 0~255）。
            if (r > 1f || g > 1f || b > 1f || alpha > 1f) {
                r /= 255f;
                g /= 255f;
                b /= 255f;
                alpha /= 255f;
            }
            host.setActorTint(a, new float[]{clamp01(r), clamp01(g), clamp01(b), clamp01(alpha)});
            return null;
        });
        method(e, "setAlpha", (c, thisObj, args) -> {
            float v = ScriptJs.fnum(ScriptJs.arg(args, 0), 1f);
            if (v > 1f) {
                v /= 255f;
            }
            float[] cur = a.tint;
            float r = cur == null ? 1f : cur[0];
            float g = cur == null ? 1f : cur[1];
            float b = cur == null ? 1f : cur[2];
            host.setActorTint(a, new float[]{r, g, b, clamp01(v)});
            return null;
        });
        method(e, "clearColor", (c, thisObj, args) -> {
            host.setActorTint(a, null);
            return null;
        });
        e.getters.put("color", () -> {
            float[] t = a.tint;
            ScriptJs.Flex o = obj();
            o.values.put("r", Double.valueOf(t == null ? 1f : t[0]));
            o.values.put("g", Double.valueOf(t == null ? 1f : t[1]));
            o.values.put("b", Double.valueOf(t == null ? 1f : t[2]));
            o.values.put("a", Double.valueOf(t == null ? 1f : t[3]));
            return o;
        });
        method(e, "hasModule", (c, thisObj, args) ->
                Boolean.valueOf(moduleOf(a, ScriptJs.str(ScriptJs.arg(args, 0), "")) != null));
        method(e, "module", (c, thisObj, args) -> {
            String id = ScriptJs.str(ScriptJs.arg(args, 0), "");
            GameData.RtModule m = moduleOf(a, id);
            if (m == null) {
                return null;
            }
            return moduleWrapper(a, m);
        });
        method(e, "modules", (c, thisObj, args) -> {
            List<Scriptable> list = new ArrayList<Scriptable>();
            for (GameData.RtModule m : a.o.modules) {
                list.add(moduleWrapper(a, m));
            }
            return array(list);
        });
        method(e, "attach", (c, thisObj, args) -> {
            ScriptableObject opts = argObj(ScriptJs.arg(args, 0));
            if (opts == null) {
                return null;
            }
            ScriptEngine.Attachment at = new ScriptEngine.Attachment(a);
            at.assetName = ScriptJs.str(ScriptJs.get(opts, "asset"), "");
            at.dx = ScriptJs.fnum(ScriptJs.get(opts, "dx"), 0f);
            at.dy = ScriptJs.fnum(ScriptJs.get(opts, "dy"), 0f);
            at.z = ScriptJs.inum(ScriptJs.get(opts, "z"), 0);
            at.rotation = ScriptJs.fnum(ScriptJs.get(opts, "rotation"), 0f);
            at.alpha = ScriptJs.fnum(ScriptJs.get(opts, "alpha"), 1f);
            at.w = ScriptJs.fnum(ScriptJs.get(opts, "w"), 0f);
            at.h = ScriptJs.fnum(ScriptJs.get(opts, "h"), 0f);
            long id = nextAttachId++;
            at.id = id;
            engine.attachments.add(at);
            attachHandles.put(Long.valueOf(id), at);
            final ScriptJs.Flex handle = obj();
            handle.values.put("id", Double.valueOf(id));
            method(handle, "remove", (c2, t2, a2) -> {
                detach(id);
                return null;
            });
            return handle;
        });
        method(e, "detach", (c, thisObj, args) -> {
            long id = (long) ScriptJs.num(ScriptJs.get(ScriptJs.arg(args, 0), "id"),
                    ScriptJs.num(ScriptJs.arg(args, 0), -1));
            detach(id);
            return null;
        });
        method(e, "distanceTo", (c, thisObj, args) -> {
            Actor other = unwrap(ScriptJs.arg(args, 0));
            if (other == null) {
                return Double.valueOf(0);
            }
            double dx = other.x - a.x;
            double dy = other.y - a.y;
            return Double.valueOf(Math.sqrt(dx * dx + dy * dy));
        });
        method(e, "angleTo", (c, thisObj, args) -> {
            Actor other = unwrap(ScriptJs.arg(args, 0));
            if (other == null) {
                return Double.valueOf(0);
            }
            return Double.valueOf(Math.toDegrees(Math.atan2(other.y - a.y, other.x - a.x)));
        });
        method(e, "destroy", (c, thisObj, args) -> {
            engine.destroyEntity(a);
            return null;
        });
        method(e, "damage", (c, thisObj, args) -> {
            float amount = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            Object from = ScriptJs.arg(args, 1);
            a.hp -= amount;
            dispatchEntityEvent(a, "damage", new Object[]{Double.valueOf(amount), from});
            engine.dispatchObject(a, engine.boundScript(a), "onDamage",
                    new Object[]{Double.valueOf(amount), from});
            if (a.hp <= 0f && !a.dead) {
                a.dead = true;
                dispatchEntityEvent(a, "death", new Object[]{from});
                engine.dispatchObject(a, engine.boundScript(a), "onDeath", new Object[]{from});
            }
            return Double.valueOf(a.hp);
        });
        method(e, "heal", (c, thisObj, args) -> {
            a.hp = Math.min(a.hpMax, a.hp + ScriptJs.fnum(ScriptJs.arg(args, 0), 0f));
            return Double.valueOf(a.hp);
        });
        method(e, "on", (c, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            if (name.isEmpty() || f == null) {
                return null;
            }
            Map<String, List<Function>> map = entityHandlers.get(a);
            if (map == null) {
                map = new LinkedHashMap<String, List<Function>>();
                entityHandlers.put(a, map);
            }
            List<Function> list = map.get(name);
            if (list == null) {
                list = new ArrayList<Function>();
                map.put(name, list);
            }
            list.add(f);
            return null;
        });
        return e;
    }

    private void detach(long id) {
        ScriptEngine.Attachment at = attachHandles.remove(Long.valueOf(id));
        if (at != null) {
            engine.attachments.remove(at);
        }
    }

    private static String propText(Object v) {
        if (ScriptJs.isMissing(v)) {
            return "";
        }
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (d == Math.rint(d) && !Double.isInfinite(d)) {
                return String.valueOf((long) d);
            }
            return String.valueOf(d);
        }
        if (v instanceof Boolean) {
            return ((Boolean) v).booleanValue() ? "开" : "关";
        }
        return Context.toString(v);
    }

    private Scriptable tagsOf(Actor a) {
        List<Object> list = new ArrayList<Object>();
        for (String t : a.o.tags) {
            list.add(t);
        }
        Scriptable arr = array(list);
        if (arr == null) {
            return null;
        }
        ScriptJs.method(arr, "has", (cx, thisObj, args) ->
                Boolean.valueOf(a.o.tags.contains(ScriptJs.str(ScriptJs.arg(args, 0), ""))));
        ScriptJs.method(arr, "includes", (cx, thisObj, args) ->
                Boolean.valueOf(a.o.tags.contains(ScriptJs.str(ScriptJs.arg(args, 0), ""))));
        return arr;
    }

    /** 模块查找：Web id / 桌面旧 id 都认（mapping-contract §7）。 */
    private static GameData.RtModule moduleOf(Actor a, String id) {
        if (id == null || id.isEmpty()) {
            return null;
        }
        for (GameData.RtModule m : a.o.modules) {
            if (id.equals(m.def)) {
                return m;
            }
        }
        String alias = aliasOf(id);
        if (alias != null) {
            for (GameData.RtModule m : a.o.modules) {
                if (alias.equals(m.def)) {
                    return m;
                }
            }
        }
        return null;
    }

    private static final String[][] MODULE_ALIASES = {
            {"combat.health", "fight.hp"},
            {"fx.cameraFollow", "show.camera"},
            {"render.shadow", "look.shadow"},
            {"render.blink", "look.blink"},
            {"render.sortByY", "look.sortByY"},
            {"render.playOnce", "look.playOnce"},
            // 光照模块：Web 编辑器 id = render.light，桌面旧 id = look.light（契约 §3.3）。
            {"render.light", "look.light"},
    };

    private static String aliasOf(String id) {
        for (String[] pair : MODULE_ALIASES) {
            if (pair[0].equals(id)) {
                return pair[1];
            }
            if (pair[1].equals(id)) {
                return pair[0];
            }
        }
        return null;
    }

    private ScriptableObject moduleWrapper(Actor a, final GameData.RtModule m) {
        Map<String, ScriptableObject> cache = moduleWrappers.get(a);
        if (cache == null) {
            cache = new LinkedHashMap<String, ScriptableObject>();
            moduleWrappers.put(a, cache);
        }
        ScriptableObject cached = cache.get(m.def);
        if (cached != null) {
            return cached;
        }
        final ScriptJs.Flex o = obj();
        o.values.put("id", m.def);
        o.values.put("def", m.def);
        o.getters.put("enabled", () -> Boolean.valueOf(a.o.modules.contains(m)));
        o.setters.put("enabled", v -> {
            boolean enable = ScriptJs.bool(v, true);
            boolean present = a.o.modules.contains(m);
            if (enable && !present) {
                a.o.modules.add(m);
            } else if (!enable && present) {
                a.o.modules.remove(m);
            }
        });
        method(o, "get", (cx, thisObj, args) -> {
            String key = ScriptJs.str(ScriptJs.arg(args, 0), "");
            Object def = ScriptJs.arg(args, 1);
            String raw = m.params.get(key);
            if (raw == null) {
                return def;
            }
            if (def instanceof Number) {
                try {
                    return Double.valueOf(Double.parseDouble(raw.trim()));
                } catch (NumberFormatException e) {
                    return def;
                }
            }
            if (def instanceof Boolean) {
                String v = raw.trim();
                return Boolean.valueOf("开".equals(v) || "true".equalsIgnoreCase(v) || "1".equals(v));
            }
            return raw;
        });
        method(o, "set", (cx, thisObj, args) -> {
            String key = ScriptJs.str(ScriptJs.arg(args, 0), "");
            if (!key.isEmpty()) {
                m.params.put(key, propText(ScriptJs.arg(args, 1)));
            }
            return null;
        });
        cache.put(m.def, o);
        return o;
    }

    // ---------------- 实体反向解包 / 事件派发 ----------------

    Actor unwrap(Object o) {
        if (o == null || ScriptJs.isMissing(o)) {
            return null;
        }
        if (!(o instanceof Scriptable)) {
            return null;
        }
        return wrapperActor.get(o);
    }

    void dispatchEntityEvent(Actor a, String name, Object[] args) {
        Map<String, List<Function>> map = entityHandlers.get(a);
        if (map == null) {
            return;
        }
        List<Function> list = map.get(name);
        if (list == null || list.isEmpty()) {
            return;
        }
        for (Function f : new ArrayList<Function>(list)) {
            engine.invoke(engine.def(engine.currentScriptName()), f, shared, args == null ? new Object[0] : args);
        }
    }

    /**
     * 建一个 JS 对象（键值交替给出），供<b>测试/诊断</b>构造事件载荷用。
     *
     * <p>为什么放在这里：建 Rhino 对象需要当前 {@code Context} 与共享 scope，
     * 只有 ScriptApi 拿得到。它不是脚本 API（不走 {@code api.addMethod}），
     * 所以不影响四方一致性的成员表。
     */
    Scriptable buildPayloadForTest(String[] keys, Object[] values) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        ScriptJs.Flex o = obj();
        for (int i = 0; i < keys.length && i < values.length; i++) {
            ScriptJs.put(o, keys[i], values[i]);
        }
        return o;
    }

    /**
     * 场景卸载：清掉所有<b>与具体实体/具体场景绑定</b>的脚本侧状态。
     *
     * <p>由 {@link ScriptEngine#unloadScene()} 在场景切换时调用。这里只清「上一次场景留下的」，
     * 不动跨场景的配置（例如 {@code prefab.define} 的模板表 —— 模板属于工程，不属于场景）。
     *
     * <p>不清就会出的事故：切场景后旧的 {@code entityHandlers} 仍持有已销毁 Actor 的
     * Java 引用 → 内存泄漏 + 回调打到僵尸对象；{@code parents} 表同样。
     */
    void clearSceneState() {
        entities.clear();
        wrapperActor.clear();
        moduleWrappers.clear();
        entityHandlers.clear();
        parents.clear();
        lockedActors.clear();
        frameLocks.clear();
        attachHandles.clear();
        nextAttachId = 1;
        if (prefabs != null) {
            prefabs.onSceneUnload();
        }
    }

    /** spawn/destroy 后清掉索引（包装对象按 Actor 身份缓存，Actor 换内容时不用重建）。 */
    void invalidate(Actor a) {
        if (a == null) {
            return;
        }
        if (a.dead) {
            entities.remove(a);
            wrapperActor.remove(entities.get(a));
            moduleWrappers.remove(a);
            lockedActors.remove(a);
            parents.remove(a);
            // 父子：被销毁节点若还有子级，子级一并脱钩（不级联销毁，避免意外连锁）。
            List<Actor> orphans = new ArrayList<Actor>();
            for (Map.Entry<Actor, Actor> e : parents.entrySet()) {
                if (e.getValue() == a) {
                    orphans.add(e.getKey());
                }
            }
            for (Actor orphan : orphans) {
                parents.remove(orphan);
            }
            frameLocks.remove(a);
            entityHandlers.remove(a);
            if (prefabs != null) {
                prefabs.onActorDestroyed(a);
            }
        }
    }

    /** 0~1 夹取（setColor/setAlpha 用）。 */
    private static float clamp01(float v) {
        return v < 0f ? 0f : (v > 1f ? 1f : v);
    }

    // ---------------- ctx ----------------

    Scriptable context(Actor self) {
        final ScriptJs.Flex c = obj();
        c.values.put("self", self == null ? null : entity(self));
        c.values.put("world", worldObj);
        c.values.put("scene", ScriptJs.get(worldObj, "scene"));
        c.values.put("time", timeObj);
        c.values.put("camera", cameraObj);
        c.values.put("input", inputObj);
        c.values.put("save", saveObj);
        c.getters.put("dt", () -> Double.valueOf(engine.frameDt));
        c.values.put("game", bwe);
        return c;
    }

    /** 点击事件参数对象（全局 click 钩子用）。 */
    Scriptable clickInfo(int sx, int sy, int wx, int wy, boolean right, Object entity) {
        ScriptJs.Flex o = obj();
        o.values.put("screenX", Double.valueOf(sx));
        o.values.put("screenY", Double.valueOf(sy));
        o.values.put("worldX", Double.valueOf(wx));
        o.values.put("worldY", Double.valueOf(wy));
        o.values.put("x", Double.valueOf(wx));
        o.values.put("y", Double.valueOf(wy));
        o.values.put("right", Boolean.valueOf(right));
        o.values.put("entity", entity);
        return o;
    }

    /** 帧锁定（setFrame）：每帧把 animT 钉在目标帧上（宿主按 animT*fps 取帧）。 */
    void applyFrameLocks() {
        if (frameLocks.isEmpty()) {
            return;
        }
        for (Map.Entry<Actor, Integer> e : frameLocks.entrySet()) {
            Actor a = e.getKey();
            if (a == null || a.dead) {
                continue;
            }
            a.o.animFps = 1f;
            a.animT = e.getValue().intValue() + 0.5f;
        }
    }
}
