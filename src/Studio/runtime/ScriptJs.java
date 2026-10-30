package Studio.runtime;

import org.mozilla.javascript.BaseFunction;
import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.ScriptRuntime;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;
import org.mozilla.javascript.Undefined;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Rhino ↔ Java 的小工具。
 *
 * <p>脚本 API 全部用「Java 侧 Scriptable 对象 + Java lambda 函数」实现，
 * 不依赖任何 JS 预置脚本（契约 §0：`bwe` 由 Java 侧 Scriptable 实现）。
 *
 * <p>这个类只做三件事：
 * <ul>
 *   <li>{@link #fn}：把 Java lambda 包成 Rhino 函数（{@link BaseFunction}）；</li>
 *   <li>{@link #flex}：可声明 getter/setter 的通用 JS 对象（`bwe.world.paused`、`e.x` 这类）；</li>
 *   <li>参数解包：JS 的 undefined/null/Number/String/Boolean → Java 值。</li>
 * </ul>
 *
 * <p><b>线程</b>：所有 Rhino 调用都要求当前线程已经 {@code Context.enter()}，
 * 所以这些静态方法只在 ScriptEngine 的 update/draw 调用栈里被使用（见 ScriptEngine 的线程说明）。
 */
final class ScriptJs {

    private ScriptJs() {
    }

    // ---------------- 函数 ----------------

    /** Java 侧实现的 JS 函数体。 */
    interface Fn {
        Object call(Context cx, Scriptable thisObj, Object[] args);
    }

    // 注意：不能叫 EMPTY —— ScriptableObject 有个 public static final int EMPTY（属性标志位），
    // 名称解析会先命中继承来的静态字段，导致「int 无法转换为 Object[]」。
    private static final Object[] NO_ARGS = new Object[0];

    /** 一个 Rhino 原生函数节点：名字只用于调试/异常信息。 */
    static final class JsFn extends BaseFunction {
        private static final long serialVersionUID = 1L;

        private final String fname;
        private final Fn body;

        JsFn(String fname, Fn body) {
            this.fname = fname;
            this.body = body;
        }

        @Override
        public Object call(Context cx, Scriptable scope, Scriptable thisObj, Object[] args) {
            return body.call(cx, thisObj, args == null ? NO_ARGS : args);
        }

        @Override
        public String getFunctionName() {
            return fname;
        }

        @Override
        public Object getDefaultValue(Class<?> hint) {
            return "[function " + fname + "]";
        }
    }

    static JsFn fn(Scriptable scope, String name, Fn body) {
        JsFn f = new JsFn(name, body);
        f.setParentScope(scope);
        try {
            f.setPrototype(ScriptableObject.getFunctionPrototype(scope));
        } catch (Throwable ignored) {
            // 没有标准环境时也能调用（Java 侧直接 Function.call）。
        }
        return f;
    }

    // ---------------- 对象 ----------------

    interface Getter {
        Object get();
    }

    interface Setter {
        void set(Object value);
    }

    /**
     * 通用 JS 对象：普通属性存在 ScriptableObject 的槽位里，
     * 需要「活属性」的（paused / e.x …）注册 getter/setter。
     */
    static final class Flex extends ScriptableObject {
        private static final long serialVersionUID = 1L;

        final Map<String, Object> values = new LinkedHashMap<String, Object>();
        final Map<String, Getter> getters = new LinkedHashMap<String, Getter>();
        final Map<String, Setter> setters = new LinkedHashMap<String, Setter>();

        @Override
        public String getClassName() {
            return "Object";
        }

        @Override
        public Object get(String name, Scriptable start) {
            Getter g = getters.get(name);
            if (g != null) {
                try {
                    return g.get();
                } catch (Throwable t) {
                    return null;
                }
            }
            if (values.containsKey(name)) {
                return values.get(name);
            }
            return super.get(name, start);
        }

        @Override
        public void put(String name, Scriptable start, Object value) {
            Setter s = setters.get(name);
            if (s != null) {
                try {
                    s.set(value);
                } catch (Throwable ignored) {
                }
                return;
            }
            values.put(name, value);
        }

        @Override
        public boolean has(String name, Scriptable start) {
            return getters.containsKey(name) || values.containsKey(name) || super.has(name, start);
        }

        @Override
        public Object[] getIds() {
            Object[] base = super.getIds();
            List<Object> all = new ArrayList<Object>();
            for (Object o : base) {
                all.add(o);
            }
            for (String k : values.keySet()) {
                if (!all.contains(k)) {
                    all.add(k);
                }
            }
            for (String k : getters.keySet()) {
                if (!all.contains(k)) {
                    all.add(k);
                }
            }
            return all.toArray();
        }

        @Override
        public void delete(String name) {
            values.remove(name);
            getters.remove(name);
            setters.remove(name);
            super.delete(name);
        }
    }

    static Flex flex(Scriptable scope) {
        Flex f = new Flex();
        f.setParentScope(scope);
        try {
            f.setPrototype(ScriptableObject.getObjectPrototype(scope));
        } catch (Throwable ignored) {
        }
        return f;
    }

    /** 普通属性写入（不经 Java 桥再包一层）。 */
    static void put(Scriptable target, String name, Object value) {
        if (target instanceof ScriptableObject) {
            ((ScriptableObject) target).put(name, target, value);
        } else {
            ScriptableObject.putProperty(target, name, value);
        }
    }

    static void method(Scriptable target, String name, Fn body) {
        put(target, name, fn(target, name, body));
    }

    static Object get(Object target, String name) {
        if (!(target instanceof Scriptable)) {
            return null;
        }
        Object v;
        try {
            v = ScriptableObject.getProperty((Scriptable) target, name);
        } catch (Throwable t) {
            return null;
        }
        return v == Scriptable.NOT_FOUND ? null : v;
    }

    static boolean isMissing(Object v) {
        return v == null || v == Undefined.instance || v == Scriptable.NOT_FOUND;
    }

    /**
     * 取一个 JS 对象上的<b>全部自身键名</b>（{@code bind({move_up: [...]})} 这类
     * "以键名为数据"的调用需要）。返回稳定顺序（Rhino 的 getIds 已是声明顺序）。
     */
    static Object[] ids(Object target) {
        if (!(target instanceof Scriptable)) {
            return new Object[0];
        }
        try {
            return ((Scriptable) target).getIds();
        } catch (Throwable t) {
            return new Object[0];
        }
    }

    /** 按<b>字符串</b>键取属性（数组下标要先转字符串，否则重载不匹配）。 */
    /** 数组下标取值（对 NativeArray 用 get(i,array) 才能拿到元素）。 */
    static Object getIndex(Object target, int i) {
        if (!(target instanceof Scriptable)) {
            return null;
        }
        try {
            Object v = ScriptableObject.getProperty((Scriptable) target, i);
            return v == Scriptable.NOT_FOUND ? null : v;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 数组类对象的长度（非数组 / 缺失 → 0）。
     *
     * <p>⚠ {@code ScriptableObject.getProperty(arr, "length")} 在 Rhino 1.7.15 上
     * <b>对真正的 JS 数组不可靠</b>（{@code NativeArray} 把 length 作为特殊 tag 处理，
     * 按字符串名字取可能拿到 NOT_FOUND）→ 返回 0。
     * 实测后果：{@code bwe.actions.bind({move_up:["KeyW","ArrowUp"]})} 被判「没有可用键」，
     * 数组形式的映射<b>整个失效</b>，只剩字符串形式能用；而默认映射仍是旧值，
     * 于是「bind 了但没生效」且不报错 —— 极难发现。
     * 所以这里对 {@code NativeArray} 直接走 {@code getLength()}。
     */
    static int arrayLength(Object arrayLike) {
        if (isMissing(arrayLike)) {
            return 0;
        }
        if (arrayLike instanceof org.mozilla.javascript.NativeArray) {
            try {
                return (int) ((org.mozilla.javascript.NativeArray) arrayLike).getLength();
            } catch (Throwable ignored) {
            }
        }
        if (arrayLike instanceof Scriptable) {
            try {
                Object len = ScriptableObject.getProperty((Scriptable) arrayLike, "length");
                if (len instanceof Number) {
                    return ((Number) len).intValue();
                }
            } catch (Throwable ignored) {
            }
        }
        return 0;
    }

    // ---------------- 参数解包 ----------------

    static Object arg(Object[] args, int i) {
        return args != null && i < args.length ? args[i] : null;
    }

    static double num(Object v, double def) {
        if (isMissing(v)) {
            return def;
        }
        if (v instanceof Number) {
            return ((Number) v).doubleValue();
        }
        try {
            double d = ScriptRuntime.toNumber(v);
            return Double.isNaN(d) ? def : d;
        } catch (Throwable t) {
            return def;
        }
    }

    static float fnum(Object v, float def) {
        return (float) num(v, def);
    }

    static int inum(Object v, int def) {
        double d = num(v, def);
        return (int) Math.round(d);
    }

    static boolean bool(Object v, boolean def) {
        if (isMissing(v)) {
            return def;
        }
        try {
            return ScriptRuntime.toBoolean(v);
        } catch (Throwable t) {
            return def;
        }
    }

    static String str(Object v, String def) {
        if (isMissing(v)) {
            return def;
        }
        if (v instanceof String) {
            return (String) v;
        }
        try {
            return Context.toString(v);
        } catch (Throwable t) {
            return def;
        }
    }

    static Function fnArg(Object v) {
        return v instanceof Function ? (Function) v : null;
    }
}
