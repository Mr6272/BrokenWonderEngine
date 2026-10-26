package Studio.runtime;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 本地 JSON 存档（契约 §2.8）。
 *
 * <p>内存里是一棵 JSON 值树；{@code write(slot)} 落盘到
 * {@code <Build 的父目录>/saves/<slot>.json}，不可写时退回 {@code ~/.bwe/saves}。
 * 只接受 JSON 值（字符串/数字/布尔/null/数组/对象），函数会被忽略并告警。
 */
final class ScriptSave {

    private final ScriptEngine engine;
    private final File dir;
    private final Map<String, Object> values = new LinkedHashMap<String, Object>();
    private boolean warned;

    ScriptSave(ScriptEngine engine) {
        this.engine = engine;
        this.dir = resolveDir(engine);
    }

    private static File resolveDir(ScriptEngine engine) {
        File buildDir = engine.buildDir;
        File root = buildDir == null ? null : buildDir.getParentFile();
        File primary = new File(root == null ? buildDir : root, "saves");
        if (ensure(primary)) {
            return primary;
        }
        File fallback = new File(System.getProperty("user.home", "."), ".bwe" + File.separator + "saves");
        ensure(fallback);
        return fallback;
    }

    private static boolean ensure(File d) {
        if (d == null) {
            return false;
        }
        try {
            if (!d.isDirectory() && !d.mkdirs()) {
                return false;
            }
            return d.isDirectory() && d.canWrite();
        } catch (Throwable t) {
            return false;
        }
    }

    // ---------------- 内存读写 ----------------

    void set(String key, Object jsValue) {
        if (key == null || key.isEmpty()) {
            return;
        }
        try {
            values.put(key, toJson(jsValue));
        } catch (Throwable t) {
            warn("存档值无法序列化（key=" + key + "）：" + t.getMessage());
        }
    }

    Object get(String key, Object def) {
        if (key == null || !values.containsKey(key)) {
            return def;
        }
        return toJs(values.get(key));
    }

    boolean has(String key) {
        return key != null && values.containsKey(key);
    }

    void remove(String key) {
        if (key != null) {
            values.remove(key);
        }
    }

    void clear() {
        values.clear();
    }

    // ---------------- 槽位 ----------------

    boolean write(String slot) {
        File f = file(slot);
        if (f == null) {
            return false;
        }
        try {
            String json = new GsonBuilder().setPrettyPrinting().create().toJson(values);
            File parent = f.getParentFile();
            if (parent != null && !parent.isDirectory()) {
                parent.mkdirs();
            }
            Files.write(f.toPath(), json.getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (Throwable t) {
            warn("存档写入失败（" + f + "）：" + t.getMessage());
            return false;
        }
    }

    @SuppressWarnings("unchecked")
    boolean read(String slot) {
        File f = file(slot);
        if (f == null || !f.isFile()) {
            return false;
        }
        try {
            String json = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            Map<String, Object> loaded = new Gson().fromJson(json, Map.class);
            values.clear();
            if (loaded != null) {
                values.putAll(loaded);
            }
            return true;
        } catch (Throwable t) {
            warn("存档读取失败（" + f + "）：" + t.getMessage());
            return false;
        }
    }

    boolean exists(String slot) {
        File f = file(slot);
        return f != null && f.isFile();
    }

    boolean delete(String slot) {
        File f = file(slot);
        if (f == null || !f.isFile()) {
            return false;
        }
        try {
            return f.delete();
        } catch (Throwable t) {
            return false;
        }
    }

    private File file(String slot) {
        String name = slot == null || slot.isEmpty() ? "auto" : slot;
        name = name.replaceAll("[\\\\/:*?\"<>|\\s]", "_");
        if (name.isEmpty()) {
            name = "auto";
        }
        if (!name.toLowerCase().endsWith(".json")) {
            name = name + ".json";
        }
        return new File(dir, name);
    }

    // ---------------- JS ↔ JSON ----------------

    /** JS 值 → 纯 JSON 值（Map/List/String/Double/Boolean/null）。函数直接抛错。 */
    static Object toJson(Object v) {
        if (ScriptJs.isMissing(v)) {
            return null;
        }
        if (v instanceof String || v instanceof Boolean) {
            return v;
        }
        if (v instanceof Number) {
            return Double.valueOf(((Number) v).doubleValue());
        }
        if (v instanceof Function) {
            throw new IllegalArgumentException("不能存函数");
        }
        if (v instanceof Scriptable) {
            Scriptable s = (Scriptable) v;
            Object len = ScriptableObject.getProperty(s, "length");
            if (!ScriptJs.isMissing(len)) {
                int n = ScriptJs.inum(len, -1);
                if (n >= 0 && n <= 100000 && isIndexArray(s)) {
                    List<Object> list = new ArrayList<Object>();
                    for (int i = 0; i < n; i++) {
                        list.add(toJson(ScriptableObject.getProperty(s, i)));
                    }
                    return list;
                }
            }
            Map<String, Object> map = new LinkedHashMap<String, Object>();
            for (Object id : ScriptableObject.getPropertyIds(s)) {
                String k = Context.toString(id);
                if ("length".equals(k)) {
                    continue;
                }
                map.put(k, toJson(ScriptableObject.getProperty(s, k)));
            }
            return map;
        }
        return Context.toString(v);
    }

    /** 只有下标键（+ length）才算数组；带额外属性的对象按对象存。 */
    private static boolean isIndexArray(Scriptable s) {
        for (Object id : ScriptableObject.getPropertyIds(s)) {
            if (id instanceof Number) {
                continue;
            }
            String k = String.valueOf(id);
            if ("length".equals(k)) {
                continue;
            }
            boolean numeric = k.matches("\\d+");
            if (!numeric) {
                return false;
            }
        }
        return true;
    }

    /** JSON 值 → JS 值。 */
    Object toJs(Object v) {
        Context cx = Context.getCurrentContext();
        Scriptable scope = engine.shared;
        if (cx == null || scope == null) {
            return v;
        }
        if (v == null || v instanceof String || v instanceof Number || v instanceof Boolean) {
            return v;
        }
        if (v instanceof List) {
            List<?> list = (List<?>) v;
            Object[] arr = new Object[list.size()];
            for (int i = 0; i < list.size(); i++) {
                arr[i] = toJs(list.get(i));
            }
            return cx.newArray(scope, arr);
        }
        if (v instanceof Map) {
            ScriptJs.Flex o = ScriptJs.flex(scope);
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                o.values.put(String.valueOf(e.getKey()), toJs(e.getValue()));
            }
            return o;
        }
        return Context.toString(v);
    }

    File directory() {
        return dir;
    }

    private void warn(String msg) {
        if (!warned) {
            warned = true;
            engine.log(msg);
        }
    }
}
