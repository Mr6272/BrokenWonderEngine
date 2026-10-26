package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
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

    /** Actor ↔ 实体包装（同一 Actor 永远同一个 JS 对象）。 */
    private final Map<TopDownRuntime.Actor, ScriptableObject> entities =
            new IdentityHashMap<TopDownRuntime.Actor, ScriptableObject>();
    private final Map<Scriptable, TopDownRuntime.Actor> wrapperActor =
            new IdentityHashMap<Scriptable, TopDownRuntime.Actor>();
    private final Map<TopDownRuntime.Actor, Map<String, ScriptableObject>> moduleWrappers =
            new IdentityHashMap<TopDownRuntime.Actor, Map<String, ScriptableObject>>();
    private final Map<TopDownRuntime.Actor, Map<String, List<Function>>> entityHandlers =
            new IdentityHashMap<TopDownRuntime.Actor, Map<String, List<Function>>>();
    private final Map<TopDownRuntime.Actor, Integer> frameLocks =
            new IdentityHashMap<TopDownRuntime.Actor, Integer>();
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
        buildWorld();
        buildInput();
        buildCamera();
        buildTime();
        buildDraw();
        buildSave();
        buildAudio();
        buildGrid();
        buildTilemap();
        buildNav();
        buildInteract();
        buildSpawner();
        buildEmergence();
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

    /** 把对象挂到 bwe.<name> 命名空间。 */
    void attach(String name, Scriptable value) {
        bwe.values.put(name, value);
    }

    /** 把 Actor 包成 JS 里的 Entity（同一 Actor 复用同一个包装对象）。 */
    Scriptable entityOf(TopDownRuntime.Actor a) {
        return entity(a);
    }

    /** JS 值 → Actor（不是 Entity 包装则返回 null）。 */
    TopDownRuntime.Actor actorOf(Object jsValue) {
        return unwrap(jsValue);
    }

    ScriptEngine engineRef() {
        return engine;
    }

    TopDownRuntime hostRef() {
        return host;
    }

    /** 当前所有 Actor（只读快照，包含脚本 spawn 出来的）。 */
    List<TopDownRuntime.Actor> actorsSnapshot() {
        return new ArrayList<TopDownRuntime.Actor>(host.actors);
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
            TopDownRuntime.Actor a = findOne(ScriptJs.arg(args, 0));
            return a == null ? null : entity(a);
        });
        method(worldObj, "findAll", (cx, thisObj, args) -> {
            List<Scriptable> list = new ArrayList<Scriptable>();
            for (TopDownRuntime.Actor a : filtered(ScriptJs.arg(args, 0))) {
                list.add(entity(a));
            }
            return array(list);
        });
        method(worldObj, "entities", (cx, thisObj, args) -> {
            List<Scriptable> list = new ArrayList<Scriptable>();
            for (TopDownRuntime.Actor a : host.actors) {
                if (!a.dead) {
                    list.add(entity(a));
                }
            }
            return array(list);
        });
        method(worldObj, "spawn", (cx, thisObj, args) -> spawn(ScriptJs.arg(args, 0)));
        method(worldObj, "destroy", (cx, thisObj, args) -> {
            TopDownRuntime.Actor a = unwrap(ScriptJs.arg(args, 0));
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
        // Phase 2 占位：返回空数组，脚本可以先探测而不会崩。
        method(worldObj, "layers", (cx, thisObj, args) -> array(new ArrayList<Object>()));
        ScriptJs.put(bwe, "world", worldObj);
    }

    private TopDownRuntime.Actor findOne(Object q) {
        List<TopDownRuntime.Actor> all = filtered(q);
        return all.isEmpty() ? null : all.get(0);
    }

    /** find/findAll 共用的查询：字符串（名字/标签/id）或 {name,tag,kind,id}。 */
    private List<TopDownRuntime.Actor> filtered(Object q) {
        List<TopDownRuntime.Actor> out = new ArrayList<TopDownRuntime.Actor>();
        if (ScriptJs.isMissing(q)) {
            return out;
        }
        if (!(q instanceof Scriptable)) {
            String s = ScriptJs.str(q, "");
            if (s.isEmpty()) {
                return out;
            }
            for (TopDownRuntime.Actor a : host.actors) {
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
        for (TopDownRuntime.Actor a : host.actors) {
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

    private Object spawn(Object opts) {
        if (!(opts instanceof Scriptable)) {
            return null;
        }
        Scriptable o = (Scriptable) opts;
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
                tags.add(ScriptJs.str(ScriptableObject.getProperty((Scriptable) tagv, i), ""));
            }
        }
        List<GameData.RtModule> modules = new ArrayList<GameData.RtModule>();
        Object modv = ScriptJs.get(o, "modules");
        if (modv instanceof Scriptable) {
            int n = lengthOf(modv);
            for (int i = 0; i < n; i++) {
                Object item = ScriptableObject.getProperty((Scriptable) modv, i);
                GameData.RtModule m = parseModule(item);
                if (m != null) {
                    modules.add(m);
                }
            }
        }
        TopDownRuntime.Actor a = engine.spawnScripted(x, y, asset, name, kind, z, halfW, halfH,
                script, tags, modules);
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
            o.values.put("wheel", Double.valueOf(0));
            return o;
        });
        // 宿主没有暴露光标接口：Phase 1 记录意图但不改变系统光标（不崩、不报错）。
        method(inputObj, "cursor", (cx, thisObj, args) -> null);
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

    // ---------------- bwe.camera ----------------

    private void buildCamera() {
        cameraObj = obj();
        method(cameraObj, "follow", (cx, thisObj, args) -> {
            TopDownRuntime.Actor a = unwrap(ScriptJs.arg(args, 0));
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
            return Double.valueOf(audio == null ? -1 : audio.play(name, volume, loop));
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
            TopDownRuntime.Actor a = unwrap(ScriptJs.arg(args, 0));
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
            TopDownRuntime.Actor a = unwrap(ScriptJs.arg(args, 0));
            if (a != null) {
                engine.world.stopFollow(a);
            }
            return null;
        });
        ScriptJs.put(bwe, "nav", navObj);
    }

    private float[] pointOf(Object o) {
        TopDownRuntime.Actor a = unwrap(o);
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
            TopDownRuntime.Actor from = unwrap(ScriptJs.arg(args, 0));
            if (from == null) {
                from = engine.findPlayerActor();
            }
            ScriptableObject opts = argObj(ScriptJs.arg(args, 1));
            float radius = opts == null ? 48f : ScriptJs.fnum(ScriptJs.get(opts, "radius"), 48f);
            String tag = opts == null ? "" : ScriptJs.str(ScriptJs.get(opts, "tag"), "");
            Function filter = opts == null ? null : ScriptJs.fnArg(ScriptJs.get(opts, "filter"));
            TopDownRuntime.Actor best = null;
            float bestDist = Float.MAX_VALUE;
            for (TopDownRuntime.Actor a : host.actors) {
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
    Scriptable entity(TopDownRuntime.Actor a) {
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
            TopDownRuntime.Actor other = unwrap(ScriptJs.arg(args, 0));
            if (other == null) {
                return Double.valueOf(0);
            }
            double dx = other.x - a.x;
            double dy = other.y - a.y;
            return Double.valueOf(Math.sqrt(dx * dx + dy * dy));
        });
        method(e, "angleTo", (c, thisObj, args) -> {
            TopDownRuntime.Actor other = unwrap(ScriptJs.arg(args, 0));
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

    private Scriptable tagsOf(TopDownRuntime.Actor a) {
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
    private static GameData.RtModule moduleOf(TopDownRuntime.Actor a, String id) {
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

    private ScriptableObject moduleWrapper(TopDownRuntime.Actor a, final GameData.RtModule m) {
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

    TopDownRuntime.Actor unwrap(Object o) {
        if (o == null || ScriptJs.isMissing(o)) {
            return null;
        }
        if (!(o instanceof Scriptable)) {
            return null;
        }
        return wrapperActor.get(o);
    }

    void dispatchEntityEvent(TopDownRuntime.Actor a, String name, Object[] args) {
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

    /** spawn/destroy 后清掉索引（包装对象按 Actor 身份缓存，Actor 换内容时不用重建）。 */
    void invalidate(TopDownRuntime.Actor a) {
        if (a == null) {
            return;
        }
        if (a.dead) {
            entities.remove(a);
        }
    }

    // ---------------- ctx ----------------

    Scriptable context(TopDownRuntime.Actor self) {
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
        for (Map.Entry<TopDownRuntime.Actor, Integer> e : frameLocks.entrySet()) {
            TopDownRuntime.Actor a = e.getKey();
            if (a == null || a.dead) {
                continue;
            }
            a.o.animFps = 1f;
            a.animT = e.getValue().intValue() + 0.5f;
        }
    }
}
