package Studio.runtime;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * 预制体（Prefab）与对象池：{@code bwe.prefab} / {@code bwe.pool}。
 *
 * <p>设计目标是 Unity 的「模板 → 实例」心智，但只做运行期这一层（不碰编辑器工程文件）：
 * <ul>
 *   <li>{@code bwe.prefab.define(name, spec)} 注册一份纯数据模板；</li>
 *   <li>{@code bwe.prefab.spawn(name, opts)} 实例化，opts 在模板上做覆盖；</li>
 *   <li>{@code bwe.prefab.fromEntity(e, name)} 把场上对象反向抓成模板；</li>
 *   <li>{@code bwe.pool.*} 建对象池：acquire 复用隐藏实例，release 收回归还。</li>
 * </ul>
 *
 * <p><b>v1 的确定性取舍</b>（写进 docs）：
 * <ul>
 *   <li>预制体 <b>不做热更新</b>：define 之后已生成的实例保持原样，之后 spawn 用新定义；</li>
 *   <li>模板里的 {@code children} 用本引擎已有的「子精灵」（{@link ScriptEngine.Attachment}）实现，
 *       不是嵌套 Actor 层级；</li>
 *   <li>{@code jitter} 用本类自己的 {@link Random}，不与 {@code bwe.seed} 联动。</li>
 * </ul>
 *
 * <p>实例数据全部落在 {@link GameData.RtObject} 上，因此和编辑器/模块共用同一份数据（契约 §3）。
 * 生成一律走 {@link ScriptApi#spawnActor(Object)}（唯一的生成入口）。
 *
 * <p>本类只在「脚本 update 调用栈」里被 Rhino 调到，可以放心用 {@link Context#getCurrentContext()}。
 */
final class ScriptPrefab {

    /** 最近一次安装的实例（诊断 / 自检用；同一 JVM 同一时刻只有一个运行时）。 */
    static ScriptPrefab LAST;

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final TopDownRuntime host;

    /** 模板表：名字 → 定义（LinkedHashMap 保证 list() 顺序 = define 顺序）。 */
    private final Map<String, Def> defs = new LinkedHashMap<String, Def>();
    /** 实例归属：Actor → 预制体名（{@code bwe.prefab.count} 用）。 */
    private final Map<Actor, String> owners =
            new IdentityHashMap<Actor, String>();
    /** 对象池：handle → 池。 */
    private final Map<Long, Pool> pools = new LinkedHashMap<Long, Pool>();
    private long nextPoolId = 1;
    private int autoNameSeq = 0;

    private final Random random = new Random();

    private ScriptJs.Flex prefabNs;
    private ScriptJs.Flex poolNs;

    private ScriptPrefab(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.host = api.hostRef();
    }

    /** 注册 {@code bwe.prefab} / {@code bwe.pool}，并把 boot.json 里的 prefabs[] 预定义一遍。 */
    static ScriptPrefab install(ScriptApi api) {
        ScriptPrefab p = new ScriptPrefab(api);
        p.buildPrefabNs();
        p.buildPoolNs();
        p.loadBootPrefabs();
        LAST = p;
        return p;
    }

    ScriptJs.Flex prefabNamespace() {
        return prefabNs;
    }

    ScriptJs.Flex poolNamespace() {
        return poolNs;
    }

    // ==================================================================
    // 模板数据
    // ==================================================================

    /** 一份预制体定义（纯 Java 数据；JS 侧看到的是它的深拷贝快照）。 */
    static final class Def {
        String name = "";
        String kind = "PROP";
        String asset = "";
        int z = 0;
        int layer = 0;
        float halfW = 0f;
        float halfH = 0f;
        float scaleX = 1f;
        float scaleY = 1f;
        float rotation = 0f;
        boolean visible = true;
        String animMode = "默认";
        float animFps = 8f;
        String script = "";
        float x = 0f;
        float y = 0f;
        float jitterX = 0f;
        float jitterY = 0f;
        final List<String> tags = new ArrayList<String>();
        final List<GameData.RtModule> modules = new ArrayList<GameData.RtModule>();
        final Map<String, String> props = new LinkedHashMap<String, String>();
        /** 子精灵（用引擎已有 Attachment 画，不做嵌套 Actor）。 */
        final List<Child> children = new ArrayList<Child>();
    }

    /** 一条子精灵定义。 */
    static final class Child {
        String asset = "";
        float dx;
        float dy;
        int z;
        float rotation;
        float alpha = 1f;
        float w;
        float h;
    }

    /** 对象池。 */
    private static final class Pool {
        final long id;
        final String prefab;
        int capacity;
        final List<Actor> idle = new ArrayList<Actor>();
        final Map<Actor, Boolean> all =
                new IdentityHashMap<Actor, Boolean>();

        Pool(long id, String prefab, int capacity) {
            this.id = id;
            this.prefab = prefab;
            this.capacity = Math.max(1, capacity);
        }
    }

    // ==================================================================
    // bwe.prefab
    // ==================================================================

    private void buildPrefabNs() {
        prefabNs = flex();
        api.addMethod(prefabNs, "define", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            if (name.isEmpty()) {
                engine.log("[预制体] define 需要名字");
                return Boolean.FALSE;
            }
            Def p = parseSpec(name, ScriptJs.arg(args, 1));
            if (p == null) {
                engine.log("[预制体] define(\"" + name + "\") 的 spec 不是对象");
                return Boolean.FALSE;
            }
            defs.put(name, p);
            return Boolean.TRUE;
        });
        api.addMethod(prefabNs, "get", (cx, thisObj, args) -> {
            Def p = defs.get(ScriptJs.str(ScriptJs.arg(args, 0), ""));
            return p == null ? null : toJsSpec(p);
        });
        api.addMethod(prefabNs, "list", (cx, thisObj, args) -> {
            List<Object> names = new ArrayList<Object>();
            for (String n : defs.keySet()) {
                names.add(n);
            }
            return arr(names);
        });
        api.addMethod(prefabNs, "has", (cx, thisObj, args) ->
                Boolean.valueOf(defs.containsKey(ScriptJs.str(ScriptJs.arg(args, 0), ""))));
        api.addMethod(prefabNs, "remove", (cx, thisObj, args) ->
                Boolean.valueOf(defs.remove(ScriptJs.str(ScriptJs.arg(args, 0), "")) != null));
        api.addMethod(prefabNs, "spawn", (cx, thisObj, args) ->
                spawnEntity(ScriptJs.str(ScriptJs.arg(args, 0), ""), argObj(ScriptJs.arg(args, 1)), true));
        api.addMethod(prefabNs, "spawnMany", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            List<Object> out = new ArrayList<Object>();
            Object list = ScriptJs.arg(args, 1);
            if (list instanceof Scriptable) {
                int n = lengthOf(list);
                for (int i = 0; i < n; i++) {
                    Scriptable e = spawnEntity(name,
                            argObj(ScriptableObject.getProperty((Scriptable) list, i)), true);
                    if (e != null) {
                        out.add(e);
                    }
                }
            }
            return arr(out);
        });
        api.addMethod(prefabNs, "count", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            pruneOwners();
            int n = 0;
            for (String owner : owners.values()) {
                if (owner != null && owner.equals(name)) {
                    n++;
                }
            }
            return Double.valueOf(n);
        });
        api.addMethod(prefabNs, "fromEntity", (cx, thisObj, args) -> {
            Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null || a.dead) {
                return null;
            }
            String name = ScriptJs.str(ScriptJs.arg(args, 1), "");
            if (name.isEmpty()) {
                name = a.o.name == null || a.o.name.isEmpty() ? "prefab-" + (++autoNameSeq) : a.o.name;
            }
            Def p = capture(a, true);
            p.name = name;
            defs.put(name, p);
            return name;
        });
    }

    /** 实例化一个预制体；opts 在模板之上覆盖（覆盖语义见 docs）。 */
    private Scriptable spawnEntity(String name, ScriptableObject opts, boolean templateJitterAllowed) {
        if (name == null || name.isEmpty()) {
            return null;
        }
        Def p = defs.get(name);
        if (p == null) {
            engine.log("[预制体] 没有叫「" + name + "」的预制体");
            return null;
        }
        Actor a = spawnFromSpec(p, opts, templateJitterAllowed);
        return a == null ? null : api.entityOf(a);
    }

    /**
     * 模板 + 覆盖 → 生成一个 Actor（所有 prefab 实例化的唯一实现）。
     *
     * <p>覆盖语义：{@code tags} <b>追加去重</b>；{@code modules} 同 def <b>替换参数</b>、
     * 新 def <b>追加</b>；{@code props} <b>合并</b>（同名以 opts 为准）；其余标量有就用 opts 的。
     *
     * @param templateJitterAllowed 本调用是否<b>允许</b>模板自带 jitter 生效（pool 内部传 false）；
     *                              即使为 true，也只有「opts 没给 x/y」时才真的抖（见下方 jitter 决策）
     */
    Actor spawnFromSpec(Def p, ScriptableObject override, boolean templateJitterAllowed) {
        ScriptJs.Flex o = flex();
        o.values.put("kind", p.kind);
        o.values.put("asset", p.asset);
        o.values.put("z", Double.valueOf(p.z));
        o.values.put("layer", Double.valueOf(p.layer));
        o.values.put("halfW", Double.valueOf(p.halfW));
        o.values.put("halfH", Double.valueOf(p.halfH));
        o.values.put("scaleX", Double.valueOf(p.scaleX));
        o.values.put("scaleY", Double.valueOf(p.scaleY));
        o.values.put("rotation", Double.valueOf(p.rotation));
        o.values.put("visible", Boolean.valueOf(p.visible));
        o.values.put("animMode", p.animMode);
        o.values.put("animFps", Double.valueOf(p.animFps));
        if (p.script != null && !p.script.isEmpty()) {
            o.values.put("script", p.script);
        }

        List<Object> tags = new ArrayList<Object>();
        for (String t : p.tags) {
            tags.add(t);
        }
        List<GameData.RtModule> mods = new ArrayList<GameData.RtModule>();
        for (GameData.RtModule m : p.modules) {
            mods.add(copyModule(m));
        }
        ScriptJs.Flex props = flex();
        for (Map.Entry<String, String> e : p.props.entrySet()) {
            props.values.put(e.getKey(), e.getValue());
        }

        double x = p.x;
        double y = p.y;
        // 实例默认名字：模板名字（spawn 时再被 opts.name 覆盖）。
        if (!p.name.isEmpty()) {
            o.values.put("name", p.name);
        }
        if (override != null) {
            if (hasProp(override, "kind")) {
                o.values.put("kind", ScriptJs.str(ScriptJs.get(override, "kind"), p.kind));
            }
            if (hasProp(override, "asset")) {
                o.values.put("asset", ScriptJs.str(ScriptJs.get(override, "asset"), p.asset));
            }
            if (hasProp(override, "script")) {
                o.values.put("script", ScriptJs.str(ScriptJs.get(override, "script"), p.script));
            }
            if (hasProp(override, "name")) {
                o.values.put("name", ScriptJs.str(ScriptJs.get(override, "name"), ""));
            }
            if (hasProp(override, "z")) {
                o.values.put("z", Double.valueOf(ScriptJs.inum(ScriptJs.get(override, "z"), p.z)));
            }
            if (hasProp(override, "layer")) {
                o.values.put("layer", Double.valueOf(ScriptJs.inum(ScriptJs.get(override, "layer"), p.layer)));
            }
            if (hasProp(override, "halfW")) {
                o.values.put("halfW", Double.valueOf(ScriptJs.fnum(ScriptJs.get(override, "halfW"), p.halfW)));
            }
            if (hasProp(override, "halfH")) {
                o.values.put("halfH", Double.valueOf(ScriptJs.fnum(ScriptJs.get(override, "halfH"), p.halfH)));
            }
            if (hasProp(override, "scaleX")) {
                o.values.put("scaleX", Double.valueOf(ScriptJs.fnum(ScriptJs.get(override, "scaleX"), p.scaleX)));
            }
            if (hasProp(override, "scaleY")) {
                o.values.put("scaleY", Double.valueOf(ScriptJs.fnum(ScriptJs.get(override, "scaleY"), p.scaleY)));
            }
            if (hasProp(override, "rotation")) {
                o.values.put("rotation", Double.valueOf(ScriptJs.fnum(ScriptJs.get(override, "rotation"), p.rotation)));
            }
            if (hasProp(override, "visible")) {
                o.values.put("visible", Boolean.valueOf(ScriptJs.bool(ScriptJs.get(override, "visible"), p.visible)));
            }
            if (hasProp(override, "animMode")) {
                o.values.put("animMode", normalizeAnimMode(
                        ScriptJs.str(ScriptJs.get(override, "animMode"), p.animMode)));
            }
            if (hasProp(override, "animFps")) {
                o.values.put("animFps", Double.valueOf(ScriptJs.fnum(ScriptJs.get(override, "animFps"), p.animFps)));
            }
            if (hasProp(override, "x")) {
                x = ScriptJs.num(ScriptJs.get(override, "x"), p.x);
            }
            if (hasProp(override, "y")) {
                y = ScriptJs.num(ScriptJs.get(override, "y"), p.y);
            }
            Object ot = ScriptJs.get(override, "tags");
            if (ot instanceof Scriptable) {
                int n = lengthOf(ot);
                for (int i = 0; i < n; i++) {
                    String t = ScriptJs.str(ScriptableObject.getProperty((Scriptable) ot, i), "");
                    if (!t.isEmpty() && !tags.contains(t)) {
                        tags.add(t);
                    }
                }
            }
            Object om = ScriptJs.get(override, "modules");
            if (om instanceof Scriptable) {
                int n = lengthOf(om);
                for (int i = 0; i < n; i++) {
                    GameData.RtModule m = parseModule(ScriptableObject.getProperty((Scriptable) om, i));
                    if (m == null) {
                        continue;
                    }
                    boolean replaced = false;
                    for (int j = 0; j < mods.size(); j++) {
                        if (mods.get(j).def.equals(m.def)) {
                            mods.set(j, m);
                            replaced = true;
                            break;
                        }
                    }
                    if (!replaced) {
                        mods.add(m);
                    }
                }
            }
            Object op = ScriptJs.get(override, "props");
            if (op instanceof ScriptableObject) {
                for (Object keyObj : ScriptableObject.getPropertyIds((ScriptableObject) op)) {
                    String k = Context.toString(keyObj);
                    props.values.put(k, propText(ScriptableObject.getProperty((ScriptableObject) op, k)));
                }
            }
            Object par = ScriptJs.get(override, "parent");
            if (par != null && !ScriptJs.isMissing(par)) {
                o.values.put("parent", par);
            }
        }
        if (!tags.isEmpty()) {
            o.values.put("tags", arr(tags));
        }
        List<Object> modJs = new ArrayList<Object>();
        for (GameData.RtModule m : mods) {
            modJs.add(moduleToJs(m));
        }
        if (!modJs.isEmpty()) {
            o.values.put("modules", arr(modJs));
        }
        if (!props.values.isEmpty()) {
            o.values.put("props", props);
        }

        // ---- jitter 决策（v1.1 修正后的语义，见 docs §A.9）----
        //   1) opts.jitter === true      → 抖（显式要求）
        //   2) opts.jitter === false     → 不抖
        //   3) opts.jitter 是对象         → 抖
        //   4) 未给 opts.jitter：
        //        opts 给了 x 或 y        → 不抖（用户显式指定了位置，必须精确落位）
        //        没给 x/y 且本调用允许     → 抖（"没给位置就随机撒"）
        // 旧行为是"永远抖"，导致 `spawn(name, {x:100,y:120})` 出来是 99,118，
        // 且让确定性对拍失效 —— 端到端验证抓到的真 bug，这里按 Unity
        // Instantiate(pos, rot) 的心智改正：给了位置就精确落位。
        boolean hasOverridePos = override != null
                && (hasProp(override, "x") || hasProp(override, "y"));
        boolean jitter = false;
        if (override != null && hasProp(override, "jitter")) {
            Object jv = ScriptJs.get(override, "jitter");
            jitter = !(jv instanceof Boolean) || ((Boolean) jv).booleanValue();
        } else if (templateJitterAllowed && !hasOverridePos) {
            jitter = true;
        }
        if (jitter) {
            x += jitterOf(p.jitterX);
            y += jitterOf(p.jitterY);
        }
        o.values.put("x", Double.valueOf(x));
        o.values.put("y", Double.valueOf(y));

        Actor a = api.spawnActor(o);
        if (a == null) {
            return null;
        }
        for (Child c : p.children) {
            api.attachSprite(a, c.asset, c.dx, c.dy, c.z, c.rotation, c.alpha, c.w, c.h);
        }
        owners.put(a, p.name);
        return a;
    }

    private double jitterOf(float amp) {
        if (amp <= 0f) {
            return 0.0;
        }
        return (random.nextDouble() * 2.0 - 1.0) * amp;
    }

    /** 把场上对象抓成模板（fromEntity / clone 用）。 */
    Def capture(Actor a, boolean withChildren) {
        Def p = new Def();
        p.name = a.o.name;
        p.kind = a.o.kind;
        p.asset = a.o.assetName;
        p.z = a.o.z;
        p.layer = a.o.layer;
        p.halfW = a.o.halfW;
        p.halfH = a.o.halfH;
        p.scaleX = a.o.scaleX;
        p.scaleY = a.o.scaleY;
        p.rotation = a.o.rotation;
        p.visible = a.o.visible;
        p.animMode = a.o.animMode;
        p.animFps = a.o.animFps;
        p.x = a.x;
        p.y = a.y;
        p.tags.addAll(a.o.tags);
        p.props.putAll(a.o.props);
        for (GameData.RtModule m : a.o.modules) {
            if (isScriptModule(m)) {
                if (p.script == null || p.script.isEmpty()) {
                    p.script = m.str("script", "");
                }
                continue;
            }
            p.modules.add(copyModule(m));
        }
        if (withChildren) {
            for (ScriptEngine.Attachment at : new ArrayList<ScriptEngine.Attachment>(engine.attachments)) {
                if (at.owner != a) {
                    continue;
                }
                Child c = new Child();
                c.asset = at.assetName;
                c.dx = at.dx;
                c.dy = at.dy;
                c.z = at.z;
                c.rotation = at.rotation;
                c.alpha = at.alpha;
                c.w = at.w;
                c.h = at.h;
                p.children.add(c);
            }
        }
        return p;
    }

    // ==================================================================
    // 模板 ⇄ JS
    // ==================================================================

    private Def parseSpec(String name, Object spec) {
        Scriptable o = asScriptable(spec);
        if (o == null) {
            return null;
        }
        Def p = new Def();
        p.name = name;
        p.kind = ScriptJs.str(ScriptJs.get(o, "kind"), "PROP");
        p.asset = ScriptJs.str(ScriptJs.get(o, "asset"), "");
        p.z = ScriptJs.inum(ScriptJs.get(o, "z"), 0);
        p.layer = ScriptJs.inum(ScriptJs.get(o, "layer"), 0);
        p.halfW = ScriptJs.fnum(ScriptJs.get(o, "halfW"), 0f);
        p.halfH = ScriptJs.fnum(ScriptJs.get(o, "halfH"), 0f);
        p.scaleX = ScriptJs.fnum(ScriptJs.get(o, "scaleX"), 1f);
        p.scaleY = ScriptJs.fnum(ScriptJs.get(o, "scaleY"), 1f);
        p.rotation = ScriptJs.fnum(ScriptJs.get(o, "rotation"), 0f);
        p.visible = ScriptJs.bool(ScriptJs.get(o, "visible"), true);
        p.animMode = normalizeAnimMode(ScriptJs.str(ScriptJs.get(o, "animMode"), "默认"));
        p.animFps = ScriptJs.fnum(ScriptJs.get(o, "animFps"), 8f);
        p.script = ScriptJs.str(ScriptJs.get(o, "script"), "");
        p.x = ScriptJs.fnum(ScriptJs.get(o, "x"), 0f);
        p.y = ScriptJs.fnum(ScriptJs.get(o, "y"), 0f);
        Object size = ScriptJs.get(o, "size");
        if (size instanceof Scriptable) {
            float w = ScriptJs.fnum(ScriptJs.get((Scriptable) size, "w"), 0f);
            float h = ScriptJs.fnum(ScriptJs.get((Scriptable) size, "h"), 0f);
            if (w > 0f) {
                p.halfW = w / 2f;
            }
            if (h > 0f) {
                p.halfH = h / 2f;
            }
        }
        Object jitter = ScriptJs.get(o, "jitter");
        if (jitter instanceof Scriptable) {
            p.jitterX = Math.abs(ScriptJs.fnum(ScriptJs.get((Scriptable) jitter, "x"), 0f));
            p.jitterY = Math.abs(ScriptJs.fnum(ScriptJs.get((Scriptable) jitter, "y"), 0f));
        } else {
            p.jitterX = Math.abs(ScriptJs.fnum(ScriptJs.get(o, "jitterX"), 0f));
            p.jitterY = Math.abs(ScriptJs.fnum(ScriptJs.get(o, "jitterY"), 0f));
        }
        Object tags = ScriptJs.get(o, "tags");
        if (tags instanceof Scriptable) {
            int n = lengthOf(tags);
            for (int i = 0; i < n; i++) {
                String t = ScriptJs.str(ScriptableObject.getProperty((Scriptable) tags, i), "");
                if (!t.isEmpty() && !p.tags.contains(t)) {
                    p.tags.add(t);
                }
            }
        }
        Object mods = ScriptJs.get(o, "modules");
        if (mods instanceof Scriptable) {
            int n = lengthOf(mods);
            for (int i = 0; i < n; i++) {
                GameData.RtModule m = parseModule(ScriptableObject.getProperty((Scriptable) mods, i));
                if (m == null) {
                    continue;
                }
                if (isScriptModule(m)) {
                    if (p.script.isEmpty()) {
                        p.script = m.str("script", "");
                    }
                    continue;
                }
                p.modules.add(m);
            }
        }
        Object props = ScriptJs.get(o, "props");
        if (props instanceof ScriptableObject) {
            for (Object keyObj : ScriptableObject.getPropertyIds((ScriptableObject) props)) {
                String k = Context.toString(keyObj);
                p.props.put(k, propText(ScriptableObject.getProperty((ScriptableObject) props, k)));
            }
        }
        Object children = ScriptJs.get(o, "children");
        if (children instanceof Scriptable) {
            int n = lengthOf(children);
            for (int i = 0; i < n; i++) {
                Scriptable c = asScriptable(ScriptableObject.getProperty((Scriptable) children, i));
                if (c == null) {
                    continue;
                }
                Child child = new Child();
                child.asset = ScriptJs.str(ScriptJs.get(c, "asset"), "");
                child.dx = ScriptJs.fnum(ScriptJs.get(c, "dx"), ScriptJs.fnum(ScriptJs.get(c, "offsetX"), 0f));
                child.dy = ScriptJs.fnum(ScriptJs.get(c, "dy"), ScriptJs.fnum(ScriptJs.get(c, "offsetY"), 0f));
                child.z = ScriptJs.inum(ScriptJs.get(c, "z"), 0);
                child.rotation = ScriptJs.fnum(ScriptJs.get(c, "rotation"), 0f);
                child.alpha = ScriptJs.fnum(ScriptJs.get(c, "alpha"), 1f);
                child.w = ScriptJs.fnum(ScriptJs.get(c, "w"), 0f);
                child.h = ScriptJs.fnum(ScriptJs.get(c, "h"), 0f);
                p.children.add(child);
            }
        }
        return p;
    }

    /** 模板 → JS 快照。每次调用都新建对象/数组，所以改返回值不会动到注册表（= 深拷贝语义）。 */
    private Scriptable toJsSpec(Def p) {
        ScriptJs.Flex o = flex();
        o.values.put("name", p.name);
        o.values.put("kind", p.kind);
        o.values.put("asset", p.asset);
        o.values.put("z", Double.valueOf(p.z));
        o.values.put("layer", Double.valueOf(p.layer));
        o.values.put("halfW", Double.valueOf(p.halfW));
        o.values.put("halfH", Double.valueOf(p.halfH));
        o.values.put("scaleX", Double.valueOf(p.scaleX));
        o.values.put("scaleY", Double.valueOf(p.scaleY));
        o.values.put("rotation", Double.valueOf(p.rotation));
        o.values.put("visible", Boolean.valueOf(p.visible));
        o.values.put("animMode", p.animMode);
        o.values.put("animFps", Double.valueOf(p.animFps));
        o.values.put("script", p.script);
        o.values.put("x", Double.valueOf(p.x));
        o.values.put("y", Double.valueOf(p.y));
        List<Object> tags = new ArrayList<Object>();
        for (String t : p.tags) {
            tags.add(t);
        }
        o.values.put("tags", arr(tags));
        List<Object> mods = new ArrayList<Object>();
        for (GameData.RtModule m : p.modules) {
            mods.add(moduleToJs(m));
        }
        o.values.put("modules", arr(mods));
        ScriptJs.Flex props = flex();
        for (Map.Entry<String, String> e : p.props.entrySet()) {
            props.values.put(e.getKey(), e.getValue());
        }
        o.values.put("props", props);
        ScriptJs.Flex size = flex();
        size.values.put("w", Double.valueOf(p.halfW * 2f));
        size.values.put("h", Double.valueOf(p.halfH * 2f));
        o.values.put("size", size);
        ScriptJs.Flex jitter = flex();
        jitter.values.put("x", Double.valueOf(p.jitterX));
        jitter.values.put("y", Double.valueOf(p.jitterY));
        o.values.put("jitter", jitter);
        List<Object> children = new ArrayList<Object>();
        for (Child c : p.children) {
            ScriptJs.Flex co = flex();
            co.values.put("asset", c.asset);
            co.values.put("dx", Double.valueOf(c.dx));
            co.values.put("dy", Double.valueOf(c.dy));
            co.values.put("offsetX", Double.valueOf(c.dx));
            co.values.put("offsetY", Double.valueOf(c.dy));
            co.values.put("z", Double.valueOf(c.z));
            co.values.put("rotation", Double.valueOf(c.rotation));
            co.values.put("alpha", Double.valueOf(c.alpha));
            co.values.put("w", Double.valueOf(c.w));
            co.values.put("h", Double.valueOf(c.h));
            children.add(co);
        }
        o.values.put("children", arr(children));
        return o;
    }

    private Scriptable moduleToJs(GameData.RtModule m) {
        ScriptJs.Flex o = flex();
        o.values.put("def", m.def);
        o.values.put("when", m.when);
        ScriptJs.Flex params = flex();
        for (Map.Entry<String, String> e : m.params.entrySet()) {
            params.values.put(e.getKey(), e.getValue());
        }
        o.values.put("params", params);
        return o;
    }

    // ==================================================================
    // bwe.pool
    // ==================================================================

    private void buildPoolNs() {
        poolNs = flex();
        api.addMethod(poolNs, "create", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            int capacity = ScriptJs.inum(ScriptJs.arg(args, 1), 8);
            ScriptableObject opts = argObj(ScriptJs.arg(args, 2));
            boolean prewarm = opts != null && ScriptJs.bool(ScriptJs.get(opts, "prewarm"), false);
            Def p = defs.get(name);
            if (p == null) {
                engine.log("[对象池] 没有叫「" + name + "」的预制体");
                return Double.valueOf(-1);
            }
            if (capacity <= 0) {
                capacity = 8;
            }
            Pool pool = new Pool(nextPoolId++, name, capacity);
            if (prewarm) {
                for (int i = 0; i < capacity; i++) {
                    Actor a = spawnFromSpec(p, hiddenOpts(), false);
                    if (a == null) {
                        break;
                    }
                    pool.all.put(a, Boolean.TRUE);
                    pool.idle.add(a);
                }
            }
            pools.put(Long.valueOf(pool.id), pool);
            return Double.valueOf(pool.id);
        });
        api.addMethod(poolNs, "acquire", (cx, thisObj, args) -> {
            Pool pool = poolOf(ScriptJs.arg(args, 0));
            if (pool == null) {
                return null;
            }
            float x = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 2), 0f);
            prunePool(pool);
            Actor reuse = null;
            while (!pool.idle.isEmpty()) {
                Actor cand = pool.idle.remove(pool.idle.size() - 1);
                if (cand != null && !cand.dead) {
                    reuse = cand;
                    break;
                }
            }
            if (reuse != null) {
                reuse.x = x;
                reuse.y = y;
                reuse.baseX = x;
                reuse.baseY = y;
                reuse.o.visible = true;
                return api.entityOf(reuse);
            }
            if (pool.all.size() >= pool.capacity) {
                return null;
            }
            Def p = defs.get(pool.prefab);
            if (p == null) {
                return null;
            }
            Actor a = spawnFromSpec(p, positionOpts(x, y), false);
            if (a == null) {
                return null;
            }
            pool.all.put(a, Boolean.TRUE);
            return api.entityOf(a);
        });
        api.addMethod(poolNs, "release", (cx, thisObj, args) -> {
            Pool pool = poolOf(ScriptJs.arg(args, 0));
            if (pool == null) {
                return Boolean.FALSE;
            }
            Actor a = api.actorOf(ScriptJs.arg(args, 1));
            if (a == null || a.dead || !pool.all.containsKey(a)) {
                return Boolean.FALSE;
            }
            a.o.visible = false;
            if (!pool.idle.contains(a)) {
                pool.idle.add(a);
            }
            return Boolean.TRUE;
        });
        api.addMethod(poolNs, "stats", (cx, thisObj, args) -> {
            Pool pool = poolOf(ScriptJs.arg(args, 0));
            if (pool == null) {
                return null;
            }
            prunePool(pool);
            int total = pool.all.size();
            int idle = pool.idle.size();
            if (idle > total) {
                idle = total;
            }
            ScriptJs.Flex o = flex();
            o.values.put("idle", Double.valueOf(idle));
            o.values.put("active", Double.valueOf(total - idle));
            o.values.put("total", Double.valueOf(total));
            o.values.put("capacity", Double.valueOf(pool.capacity));
            return o;
        });
    }

    private ScriptJs.Flex hiddenOpts() {
        ScriptJs.Flex o = flex();
        o.values.put("visible", Boolean.FALSE);
        return o;
    }

    private ScriptJs.Flex positionOpts(float x, float y) {
        ScriptJs.Flex o = flex();
        o.values.put("x", Double.valueOf(x));
        o.values.put("y", Double.valueOf(y));
        return o;
    }

    private Pool poolOf(Object handle) {
        double id = ScriptJs.num(handle, -1);
        if (id < 0) {
            return null;
        }
        return pools.get(Long.valueOf((long) id));
    }

    private void prunePool(Pool pool) {
        for (int i = pool.idle.size() - 1; i >= 0; i--) {
            if (pool.idle.get(i) == null || pool.idle.get(i).dead) {
                pool.idle.remove(i);
            }
        }
        List<Actor> dead = new ArrayList<Actor>();
        for (Actor a : pool.all.keySet()) {
            if (a.dead) {
                dead.add(a);
            }
        }
        for (Actor a : dead) {
            pool.all.remove(a);
            pool.idle.remove(a);
        }
    }

    /**
     * 场景卸载：清掉所有<b>实例级</b>记录（实例归属、池里的实例表）。
     *
     * <p>不清什么：{@code defs}（模板表）—— 模板属于<b>工程</b>，不是场景。
     * 切场景后 {@code bwe.prefab.spawn} 必须仍然能按名字生成（这是兼容性红线，
     * 由 ScriptPrefabTest 的 prefab 计数断言保护）。
     */
    void onSceneUnload() {
        owners.clear();
        for (Pool pool : pools.values()) {
            pool.all.clear();
            pool.idle.clear();
        }
    }

    /** 实体被销毁时立刻清理引用（由 {@link ScriptApi#invalidate} 调用），避免池/实例表留死引用。 */
    void onActorDestroyed(Actor a) {
        if (a == null) {
            return;
        }
        owners.remove(a);
        for (Pool pool : pools.values()) {
            pool.all.remove(a);
            pool.idle.remove(a);
        }
    }

    private void pruneOwners() {
        List<Actor> dead = new ArrayList<Actor>();
        for (Actor a : owners.keySet()) {
            if (a.dead) {
                dead.add(a);
            }
        }
        for (Actor a : dead) {
            owners.remove(a);
        }
    }

    // ==================================================================
    // boot.json prefabs[]
    // ==================================================================

    /**
     * 读 {@code boot.json} 顶层的 {@code "prefabs": [...]} 并逐个 define。
     * 缺字段时静默用默认值、整块缺失时按空数组处理（老工程照样能跑）。
     *
     * <p>字段契约（与 web 侧导出器逐字一致）：
     * {@code name, kind, asset, z, layer, halfW, halfH, tags, modules[{def,when,params}],
     * props, script, animMode, animFps, scaleX, scaleY, rotation, jitter{x,y}, children[]}。
     * 其中 {@code asset} 是素材名、{@code script} 是脚本名（boot.scripts[].name）。
     */
    private void loadBootPrefabs() {
        File boot = host.bootFileForScripts();
        if (boot == null || !boot.isFile()) {
            return;
        }
        try {
            String json = new String(Files.readAllBytes(boot.toPath()), StandardCharsets.UTF_8);
            JsonObject root = new Gson().fromJson(json, JsonObject.class);
            if (root == null || !root.has("prefabs") || !root.get("prefabs").isJsonArray()) {
                return;
            }
            JsonArray list = root.getAsJsonArray("prefabs");
            int n = 0;
            for (JsonElement el : list) {
                if (!el.isJsonObject()) {
                    continue;
                }
                JsonObject o = el.getAsJsonObject();
                String name = jstr(o, "name", "");
                if (name.isEmpty()) {
                    continue;
                }
                defs.put(name, parseJsonPrefab(name, o));
                n++;
            }
            if (n > 0) {
                engine.log("[预制体] 从 boot.json 载入 " + n + " 个预制体");
            }
        } catch (Throwable t) {
            engine.log("[预制体] 读取 boot.json prefabs 失败: " + t);
        }
    }

    private static Def parseJsonPrefab(String name, JsonObject o) {
        Def p = new Def();
        p.name = name;
        p.kind = jstr(o, "kind", "PROP");
        p.asset = jstr(o, "asset", "");
        p.z = jnum(o, "z", 0);
        p.layer = jnum(o, "layer", 0);
        p.halfW = jfloat(o, "halfW", 0f);
        p.halfH = jfloat(o, "halfH", 0f);
        p.scaleX = jfloat(o, "scaleX", 1f);
        p.scaleY = jfloat(o, "scaleY", 1f);
        p.rotation = jfloat(o, "rotation", 0f);
        p.visible = jbool(o, "visible", true);
        p.animMode = normalizeAnimMode(jstr(o, "animMode", "默认"));
        p.animFps = jfloat(o, "animFps", 8f);
        p.script = jstr(o, "script", "");
        p.x = jfloat(o, "x", 0f);
        p.y = jfloat(o, "y", 0f);
        if (o.has("size") && o.get("size").isJsonObject()) {
            JsonObject s = o.getAsJsonObject("size");
            float w = jfloat(s, "w", 0f);
            float h = jfloat(s, "h", 0f);
            if (w > 0f) {
                p.halfW = w / 2f;
            }
            if (h > 0f) {
                p.halfH = h / 2f;
            }
        }
        if (o.has("jitter") && o.get("jitter").isJsonObject()) {
            JsonObject j = o.getAsJsonObject("jitter");
            p.jitterX = Math.abs(jfloat(j, "x", 0f));
            p.jitterY = Math.abs(jfloat(j, "y", 0f));
        } else {
            p.jitterX = Math.abs(jfloat(o, "jitterX", 0f));
            p.jitterY = Math.abs(jfloat(o, "jitterY", 0f));
        }
        if (o.has("tags") && o.get("tags").isJsonArray()) {
            for (JsonElement te : o.getAsJsonArray("tags")) {
                String t = te.isJsonPrimitive() ? te.getAsString() : "";
                if (!t.isEmpty() && !p.tags.contains(t)) {
                    p.tags.add(t);
                }
            }
        }
        if (o.has("modules") && o.get("modules").isJsonArray()) {
            for (JsonElement me : o.getAsJsonArray("modules")) {
                if (!me.isJsonObject()) {
                    continue;
                }
                JsonObject m = me.getAsJsonObject();
                GameData.RtModule rm = new GameData.RtModule();
                rm.def = jstr(m, "def", "");
                if (rm.def.isEmpty()) {
                    continue;
                }
                rm.when = jstr(m, "when", "ALWAYS");
                rm.label = jstr(m, "label", "");
                if (m.has("params") && m.get("params").isJsonObject()) {
                    JsonObject ps = m.getAsJsonObject("params");
                    for (String k : ps.keySet()) {
                        JsonElement v = ps.get(k);
                        rm.params.put(k, v.isJsonPrimitive() ? v.getAsString() : v.toString());
                    }
                }
                if (isScriptModule(rm)) {
                    if (p.script.isEmpty()) {
                        p.script = rm.str("script", "");
                    }
                    continue;
                }
                p.modules.add(rm);
            }
        }
        if (o.has("props") && o.get("props").isJsonObject()) {
            JsonObject ps = o.getAsJsonObject("props");
            for (String k : ps.keySet()) {
                JsonElement v = ps.get(k);
                p.props.put(k, v.isJsonPrimitive() ? v.getAsString() : "");
            }
        }
        if (o.has("children") && o.get("children").isJsonArray()) {
            for (JsonElement ce : o.getAsJsonArray("children")) {
                if (!ce.isJsonObject()) {
                    continue;
                }
                JsonObject c = ce.getAsJsonObject();
                Child child = new Child();
                child.asset = jstr(c, "asset", "");
                child.dx = jfloat(c, "dx", jfloat(c, "offsetX", 0f));
                child.dy = jfloat(c, "dy", jfloat(c, "offsetY", 0f));
                child.z = jnum(c, "z", 0);
                child.rotation = jfloat(c, "rotation", 0f);
                child.alpha = jfloat(c, "alpha", 1f);
                child.w = jfloat(c, "w", 0f);
                child.h = jfloat(c, "h", 0f);
                p.children.add(child);
            }
        }
        return p;
    }

    private static String jstr(JsonObject o, String k, String def) {
        JsonElement e = o.get(k);
        if (e == null || e.isJsonNull()) {
            return def;
        }
        try {
            return e.getAsString();
        } catch (Throwable t) {
            return def;
        }
    }

    private static int jnum(JsonObject o, String k, int def) {
        JsonElement e = o.get(k);
        try {
            return e == null || e.isJsonNull() ? def : e.getAsInt();
        } catch (Throwable t) {
            return def;
        }
    }

    private static float jfloat(JsonObject o, String k, float def) {
        JsonElement e = o.get(k);
        try {
            return e == null || e.isJsonNull() ? def : e.getAsFloat();
        } catch (Throwable t) {
            return def;
        }
    }

    private static boolean jbool(JsonObject o, String k, boolean def) {
        JsonElement e = o.get(k);
        try {
            return e == null || e.isJsonNull() ? def : e.getAsBoolean();
        } catch (Throwable t) {
            return def;
        }
    }

    // ==================================================================
    // 小工具
    // ==================================================================

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

    /** 模板里的 script.js 模块（脚本绑定走 {@code script} 字段，避免重复挂两次）。 */
    private static boolean isScriptModule(GameData.RtModule m) {
        return m != null && ("script.js".equals(m.def) || "script".equals(m.def));
    }

    private static GameData.RtModule copyModule(GameData.RtModule src) {
        GameData.RtModule m = new GameData.RtModule();
        m.def = src.def;
        m.when = src.when;
        m.label = src.label;
        m.params.putAll(src.params);
        return m;
    }

    /** 模块解析（与 ScriptApi.parseModule 同规则；本类自留一份，不扩大 ScriptApi 的可见面）。 */
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
                m.params.put(k, ScriptJs.str(ScriptableObject.getProperty(p, k), ""));
            }
        }
        return m;
    }

    /** JS 值 → props 文本（与 ScriptApi.propText 同规则）。 */
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

    private ScriptJs.Flex flex() {
        Scriptable seed = api.newObj();
        return ScriptJs.flex(ScriptableObject.getTopLevelScope(seed));
    }

    private Scriptable arr(List<Object> values) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        Scriptable scope = ScriptableObject.getTopLevelScope(api.newObj());
        return cx.newArray(scope, values.toArray());
    }

    private static Scriptable asScriptable(Object v) {
        return v instanceof Scriptable ? (Scriptable) v : null;
    }

    private static ScriptableObject argObj(Object v) {
        return v instanceof ScriptableObject ? (ScriptableObject) v : null;
    }

    private static boolean hasProp(Scriptable o, String key) {
        Object v = ScriptJs.get(o, key);
        return v != null && !ScriptJs.isMissing(v);
    }

    private static int lengthOf(Object arrayLike) {
        if (!(arrayLike instanceof Scriptable)) {
            return 0;
        }
        Object len = ScriptableObject.getProperty((Scriptable) arrayLike, "length");
        return (int) ScriptJs.num(len, 0);
    }
}
