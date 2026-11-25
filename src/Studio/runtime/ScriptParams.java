package Studio.runtime;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/**
 * 脚本「公开字段」的运行期实现（契约 {@code docs/scripting-api.md} §1.4 / {@code docs/api/lifecycle.md}）。
 *
 * <h3>要解决什么</h3>
 * 同一个脚本可以被很多对象挂载（十只小怪共用一个 {@code enemy.js}），但每只的速度/血量应该能各调各的。
 * 编辑器把用户改过的那几项存成 {@code script.js} 模块参数里的 {@code params}（JSON 文本），
 * 运行时必须把这些**覆盖值**送进脚本，而且必须**按对象作用域**生效。
 *
 * <h3>为什么不能"装一个全局参数表"</h3>
 * 每个脚本一个独立 scope（{@link ScriptEngine} 的线程/作用域说明），
 * 但 <b>scope 是脚本级共享的</b>：{@code enemy.js} 只有一个 scope，十只小怪共用。
 * 如果把参数写进 scope（或写进 {@code bwe}），最后一只把参数改成自己的，前十只全部跟着变 ——
 * 这正是"全局污染"。所以这里只用两条**调用期**通道：
 * <ol>
 *   <li>{@code bwe.params(defs)}：调用发生的那一刻，{@link ScriptEngine#currentSelf()} 就是
 *       当前正在跑回调的那个对象（{@link ScriptEngine#dispatchObject} 在调用前后保存/恢复），
 *       于是拿得到「这一只」的覆盖值；返回的是**新对象**，脚本改它也不会影响别人。</li>
 *   <li>{@code ctx.params}：ctx 本来就是每次回调新建的（{@link ScriptApi#context}），
 *       把「默认值 ∪ 覆盖值」直接挂上去，脚本连 {@code bwe.params()} 都不用调。</li>
 * </ol>
 *
 * <h3>默认值从哪来</h3>
 * 不从 JS 源码里静态解析 —— 那是编辑器（{@code web/src/core/scriptParams.ts}）的活。
 * 运行时用更可靠的办法：脚本**顶层**执行时必然会调用一次 {@code bwe.params({...})} 把声明交出来，
 * 这里按 {@link ScriptEngine.ScriptDef} 缓存那份默认值，之后每个对象的回调都能拿到同一份默认表。
 * 于是 Java 侧不需要第二套解析器，也就不存在"两份解析器对不上"的隐患。
 *
 * <h3>没有覆盖值时</h3>
 * 原样返回默认值（{@code bwe.params(defs)} 返回一个与 defs 等值的新对象）；
 * 脚本没声明公开字段时 {@code ctx.params} 是个空对象，不抛错、不告警。
 */
final class ScriptParams {

    private ScriptParams() {
    }

    /** 脚本名 → 该脚本顶层声明的默认参数（{@code bwe.params({...})} 的那一份）。 */
    private static final Map<ScriptEngine.ScriptDef, ScriptableObject> DECLARED =
            new IdentityHashMap<ScriptEngine.ScriptDef, ScriptableObject>();

    // ---------------- 入口 ----------------

    /**
     * {@code bwe.params(defs)} 的实现。
     *
     * <p>两种调用时机都要正确处理：
     * <ul>
     *   <li><b>脚本顶层</b>（最常见）：没有 self，把 defs 记为该脚本的默认值表并原样返回一份拷贝；</li>
     *   <li><b>回调里</b>（onStart/onUpdate）：把当前对象的覆盖值叠上去再返回。</li>
     * </ul>
     * 无论哪种时机都返回**新对象**：脚本往里写东西不会污染缓存，也不会串到别的对象。
     */
    static Object call(ScriptEngine engine, ScriptApi api, Object[] args) {
        ScriptableObject defs = asObject(ScriptJs.arg(args, 0));
        if (defs == null) {
            // bwe.params() 不带参数 = 「我要当前对象的有效参数」，与 ctx.params 等价。
            return effective(engine, api, engine.currentSelf(), null);
        }
        ScriptEngine.ScriptDef def = engine.def(engine.currentScriptName());
        if (def != null) {
            DECLARED.put(def, snapshot(api, defs));
        }
        Actor self = engine.currentSelf();
        if (self == null) {
            return snapshot(api, defs); // 顶层：只登记默认值，返回一份等值拷贝
        }
        return effective(engine, api, self, defs);
    }

    /**
     * 生成「默认值 ∪ 覆盖值」，供 {@code ctx.params} 使用。
     *
     * <p>找不到脚本/没有声明时返回空对象而不是 null：脚本里 `ctx.params.x` 拿到 undefined 就够了，
     * 不需要再写一层判空（也不该因为"没声明字段"就让整个回调抛异常）。
     */
    static ScriptableObject contextParams(ScriptEngine engine, ScriptApi api, Actor self) {
        Object v = effective(engine, api, self, null);
        return v instanceof ScriptableObject ? (ScriptableObject) v : null;
    }

    /** 脚本热重载 / 场景切换后清掉缓存的默认值表（脚本源码可能已经改了声明）。 */
    static void forget(ScriptEngine.ScriptDef def) {
        if (def != null) {
            DECLARED.remove(def);
        }
    }

    // ---------------- 核心合并 ----------------

    /**
     * 默认值 ∪ 覆盖值。
     *
     * @param self 当前对象；null = 场景脚本/全局钩子，此时只有默认值（调用方给的 defs 优先）
     * @param defs 调用方当场传进来的声明；null 时用缓存的那一份
     */
    private static Object effective(ScriptEngine engine, ScriptApi api, Actor self, ScriptableObject defs) {
        ScriptableObject defaults = defs != null ? defs : declaredFor(engine, self);
        // ScriptApi.newObj() 是包内的「新建 JS 对象」入口（内部就是 ScriptJs.flex(shared)）。
        // 不要在这里自己 new Flex：parentScope/prototype 没接上，脚本拿到的对象会缺 Object 原型。
        ScriptableObject out = (ScriptableObject) api.newObj();
        if (defaults != null) {
            for (Object keyObj : ScriptableObject.getPropertyIds(defaults)) {
                String key = Context.toString(keyObj);
                ObjectProto.put(out, key, ScriptableObject.getProperty(defaults, key));
            }
        }
        // 覆盖值：只认「默认值表里存在的键」，类型以默认值为准。
        // 脚本删掉某个字段后，工程文件里的残留覆盖不该凭空冒出来变成一个新参数。
        for (Map.Entry<String, Object> e : overridesOf(self).entrySet()) {
            String key = e.getKey();
            if (defaults != null && !hasProperty(defaults, key)) {
                continue;
            }
            Object base = defaults == null ? null : ScriptableObject.getProperty(defaults, key);
            Object coerced = coerce(e.getValue(), base);
            if (coerced != null) {
                ObjectProto.put(out, key, coerced);
            }
        }
        return out;
    }

    /** 该对象所挂脚本的默认参数表（顶层声明那一份）。 */
    private static ScriptableObject declaredFor(ScriptEngine engine, Actor self) {
        if (self == null) {
            return null;
        }
        String name = scriptNameOf(self);
        if (name.isEmpty()) {
            return null;
        }
        ScriptEngine.ScriptDef def = engine.def(name);
        return def == null ? null : DECLARED.get(def);
    }

    /**
     * 该对象的覆盖值（{@code script.js} 模块参数 {@code params} 的 JSON 文本）。
     *
     * <p>解析失败一律当成"没有覆盖"：手改坏的工程文件、旧版本留下的怪值都不该让游戏起不来。
     * 类型归一延迟到与默认值比对时再做（见 {@link #coerce}）。
     */
    private static Map<String, Object> overridesOf(Actor self) {
        Map<String, Object> out = new java.util.LinkedHashMap<String, Object>();
        if (self == null || self.o == null) {
            return out;
        }
        GameData.RtModule m = scriptModule(self.o);
        if (m == null) {
            return out;
        }
        String text = m.str("params", "");
        if (text.isEmpty()) {
            return out;
        }
        try {
            JsonElement root = JsonParser.parseString(text);
            if (!root.isJsonObject()) {
                return out;
            }
            JsonObject obj = root.getAsJsonObject();
            for (String key : obj.keySet()) {
                JsonElement v = obj.get(key);
                if (v == null || v.isJsonNull()) {
                    out.put(key, null);
                } else if (v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()) {
                    out.put(key, Double.valueOf(v.getAsDouble()));
                } else if (v.isJsonPrimitive() && v.getAsJsonPrimitive().isBoolean()) {
                    out.put(key, Boolean.valueOf(v.getAsBoolean()));
                } else if (v.isJsonPrimitive()) {
                    out.put(key, v.getAsString());
                }
                // 对象/数组不是合法的字段值（编辑器只允许字面量），静默忽略
            }
        } catch (Throwable ignored) {
            // 坏 JSON = 没有覆盖；编辑器侧另有提示（collectScriptParamProblems）
        }
        return out;
    }

    /** 按默认值的类型归一覆盖值；归不了返回 null（= 这一项不要了）。 */
    private static Object coerce(Object raw, Object base) {
        if (base == null) {
            return raw; // 没有默认值可参照（理论上到不了这里，effective 已过滤）
        }
        if (base instanceof Number) {
            if (raw instanceof Number) {
                return Double.valueOf(((Number) raw).doubleValue());
            }
            if (raw instanceof Boolean) {
                return Double.valueOf(((Boolean) raw).booleanValue() ? 1d : 0d);
            }
            if (raw instanceof String) {
                try {
                    return Double.valueOf(Double.parseDouble(((String) raw).trim()));
                } catch (Exception e) {
                    return null;
                }
            }
            return null;
        }
        if (base instanceof Boolean) {
            if (raw instanceof Boolean) {
                return raw;
            }
            if (raw instanceof Number) {
                return Boolean.valueOf(((Number) raw).doubleValue() != 0d);
            }
            if (raw instanceof String) {
                String s = ((String) raw).trim();
                if ("true".equalsIgnoreCase(s) || "1".equals(s) || "开".equals(s) || "是".equals(s)) {
                    return Boolean.TRUE;
                }
                if ("false".equalsIgnoreCase(s) || "0".equals(s) || "关".equals(s) || "否".equals(s)) {
                    return Boolean.FALSE;
                }
            }
            return null;
        }
        if (base instanceof String) {
            if (raw == null) {
                return "";
            }
            return Context.toString(raw);
        }
        // 默认值是 null 的字段：保留 null（编辑器里这类字段固定为 null）
        return raw;
    }

    // ---------------- 小工具 ----------------

    /** 对象的 script.js 模块（与 {@link ScriptEngine#scriptModule} 同规则，本类自留一份）。 */
    private static GameData.RtModule scriptModule(GameData.RtObject o) {
        if (o == null) {
            return null;
        }
        for (GameData.RtModule m : o.modules) {
            if ("script.js".equals(m.def) || "script".equals(m.def)) {
                return m;
            }
        }
        return null;
    }

    private static String scriptNameOf(Actor self) {
        GameData.RtModule m = scriptModule(self.o);
        return m == null ? "" : m.str("script", "");
    }

    /**
     * 把 JS 对象浅拷贝成一个新的 Flex。
     *
     * <p>为什么要拷贝：{@code bwe.params({...})} 的 defs 是脚本自己的对象字面量，
     * 直接把它当默认值表缓存下来，脚本后面改自己那个对象就会连带改掉默认值
     * （以及所有共用这个脚本的对象）。深拷贝不必要 —— 本契约只允许字面量。
     */
    private static ScriptableObject snapshot(ScriptApi api, ScriptableObject src) {
        ScriptableObject out = (ScriptableObject) api.newObj();
        if (src == null) {
            return out;
        }
        for (Object keyObj : ScriptableObject.getPropertyIds(src)) {
            String key = Context.toString(keyObj);
            ObjectProto.put(out, key, ScriptableObject.getProperty(src, key));
        }
        return out;
    }

    private static boolean hasProperty(ScriptableObject o, String key) {
        for (Object id : ScriptableObject.getPropertyIds(o)) {
            if (key.equals(Context.toString(id))) {
                return true;
            }
        }
        return false;
    }

    private static ScriptableObject asObject(Object v) {
        return v instanceof ScriptableObject ? (ScriptableObject) v : null;
    }

    /** {@code Flex} 的属性写入是 {@code put(name, start, value)}，这里收口成一行。 */
    private static final class ObjectProto {
        static void put(ScriptableObject target, String key, Object value) {
            target.put(key, target, value);
        }
    }

    /** 诊断用：当前缓存了几个脚本的默认参数表（不进脚本 API）。 */
    static int declaredCount() {
        return DECLARED.size();
    }

    /** 诊断用：某个对象此刻的有效参数键（自检断言用，不进脚本 API）。 */
    static List<String> keysFor(ScriptEngine engine, ScriptApi api, Actor self) {
        List<String> out = new ArrayList<String>();
        Object v = effective(engine, api, self, null);
        if (v instanceof ScriptableObject) {
            for (Object id : ScriptableObject.getPropertyIds((ScriptableObject) v)) {
                out.add(Context.toString(id));
            }
        }
        return out;
    }
}
