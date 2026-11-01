package Studio.runtime;

import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 输入动作映射命名空间 {@code bwe.actions}（契约 {@code docs/api/actions.md}；
 * 设计 {@code docs/open-world-architecture.md} §3.2 / 任务书 §10）。
 *
 * <h3>解决什么问题</h3>
 * 审计 §2.4：{@code bwe.input} 只给原始键 + 一个写死 WASD/方向键的 {@code axis()}。
 * 改键必须改游戏逻辑脚本 —— 任务书 §10 明确要求"能在配置文件中修改按键，而不必修改游戏逻辑脚本"。
 *
 * <h3>三层结构</h3>
 * <pre>
 *   物理键（KeyW / Space / Mouse0 …）
 *        │  ← bwe.input（原始层，完全保留不动）
 *        ▼
 *   动作映射 bind({move_up: ["KeyW","ArrowUp"], ...})
 *        │
 *        ▼
 *   动作查询 down/pressed/released/axis（游戏逻辑只碰这一层）
 *        │
 *        ▼
 *   输入上下文 pushContext("ui") → 只有当前上下文里的动作可见
 * </pre>
 *
 * <h3>生命周期</h3>
 * 映射表与上下文栈是<b>工程级</b>（跨场景保留），所以 {@code onSceneStart} 里 bind 一次即可。
 * 场景卸载不清映射（否则每次切场景都要重 bind，容易漏）。
 *
 * <h3>窗口失焦</h3>
 * 宿主在 {@code windowLostFocus()} 里调 {@link #onFocusLost()}：所有动作立刻变 false，
 * 且本帧不产生 pressed —— 避免"按住 W 切出去，回来角色一直在走"。
 */
final class ScriptActions {

    static ScriptActions LAST;

    /**
     * 默认动作映射（任务书 §10 点名的 9 个动作）。
     *
     * <p>值是 {@code bwe.input} 认的键名（"KeyW"/"Space"/"Mouse0"），与编辑器同名，
     * 脚本作者不需要记 Java 键码。数值键码也认（向后兼容）。
     */
    private static final String[][] DEFAULT_BINDINGS = {
            {"move_up", "KeyW", "ArrowUp"},
            {"move_down", "KeyS", "ArrowDown"},
            {"move_left", "KeyA", "ArrowLeft"},
            {"move_right", "KeyD", "ArrowRight"},
            {"attack", "Space", "Mouse0"},
            {"defend", "KeyQ", "Mouse2"},
            {"interact", "KeyE"},
            {"enter_vehicle", "KeyF"},
            {"switch_weapon", "KeyR"},
            {"run", "Shift"},
            {"pause", "Escape"},
    };

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final TopDownRuntime host;
    private final Scriptable scope;
    private final ScriptJs.Flex ns;

    /** 动作名 → 绑定的键码列表。用 LinkedHashMap 保持 bind 顺序可复现。 */
    private final Map<String, int[]> bindings = new LinkedHashMap<String, int[]>();

    /** 上下文栈：最后一个是当前生效的。空栈 = "game"（默认）。 */
    private final List<String> contexts = new ArrayList<String>();

    /** 上下文 → 该上下文里允许的动作集合（null = 全部允许）。 */
    private final Map<String, List<String>> contextAllow = new LinkedHashMap<String, List<String>>();

    /** 失焦后本帧强制全 false。 */
    private boolean focusLost;

    /** 动作级事件订阅（bwe.actions.on(action, fn)）。 */
    private final Map<String, List<Holder>> handlers = new LinkedHashMap<String, List<Holder>>();

    private static final class Holder {
        final Function fn;
        final ScriptEngine.ScriptDef def;

        Holder(Function fn, ScriptEngine.ScriptDef def) {
            this.fn = fn;
            this.def = def;
        }
    }

    private ScriptActions(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.host = api.hostRef();
        this.ns = (ScriptJs.Flex) api.newObj();
        this.scope = ns.getParentScope();
        installDefaults();
    }

    private void installDefaults() {
        for (int i = 0; i < DEFAULT_BINDINGS.length; i++) {
            String action = DEFAULT_BINDINGS[i][0];
            int[] codes = new int[DEFAULT_BINDINGS[i].length - 1];
            for (int j = 1; j < DEFAULT_BINDINGS[i].length; j++) {
                codes[j - 1] = ScriptApi.keyCodeOfPublic(DEFAULT_BINDINGS[i][j]);
            }
            bindings.put(action, codes);
        }
    }

    static void install(ScriptApi api) {
        ScriptActions a = new ScriptActions(api);
        a.build();
        api.attach("actions", a.ns);
        LAST = a;
    }

    // ---------------- 命名空间 ----------------

    private void build() {
        // bind(map) —— 合并写入（不覆盖未提到的动作）
        api.addMethod(ns, "bind", (cx, thisObj, args) -> bindMap(ScriptJs.arg(args, 0)));

        // unbind(action)
        api.addMethod(ns, "unbind", (cx, thisObj, args) -> {
            String a = ScriptJs.str(ScriptJs.arg(args, 0), "");
            return Boolean.valueOf(a.isEmpty() ? false : bindings.remove(a) != null);
        });

        // reset() —— 恢复默认映射
        api.addMethod(ns, "reset", (cx, thisObj, args) -> {
            bindings.clear();
            installDefaults();
            return Boolean.TRUE;
        });

        // actions() → 所有动作名
        api.addMethod(ns, "actions", (cx, thisObj, args) -> {
            List<Object> out = new ArrayList<Object>();
            for (String k : bindings.keySet()) {
                out.add(k);
            }
            return array(out);
        });

        // keys(action) → 该动作绑定的键名列表
        api.addMethod(ns, "keys", (cx, thisObj, args) -> {
            String a = ScriptJs.str(ScriptJs.arg(args, 0), "");
            int[] codes = bindings.get(a);
            List<Object> out = new ArrayList<Object>();
            if (codes != null) {
                for (int i = 0; i < codes.length; i++) {
                    out.add(String.valueOf(codes[i]));
                }
            }
            return array(out);
        });

        // down(action) —— 持续按住
        api.addMethod(ns, "down", (cx, thisObj, args) ->
                Boolean.valueOf(isDown(ScriptJs.str(ScriptJs.arg(args, 0), ""))));
        // pressed(action) —— 本帧刚按下
        api.addMethod(ns, "pressed", (cx, thisObj, args) ->
                Boolean.valueOf(isPressed(ScriptJs.str(ScriptJs.arg(args, 0), ""))));
        // released(action)
        api.addMethod(ns, "released", (cx, thisObj, args) ->
                Boolean.valueOf(isReleased(ScriptJs.str(ScriptJs.arg(args, 0), ""))));

        // axis() → {x, y}（用 move_* 动作算，已归一化）
        api.addMethod(ns, "axis", (cx, thisObj, args) -> axis());

        // context() / pushContext(name) / popContext()
        api.addMethod(ns, "context", (cx, thisObj, args) -> currentContext());
        api.addMethod(ns, "pushContext", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            if (name.isEmpty()) {
                return Boolean.FALSE;
            }
            contexts.add(name);
            return Boolean.TRUE;
        });
        api.addMethod(ns, "popContext", (cx, thisObj, args) -> {
            if (contexts.isEmpty()) {
                return null;
            }
            return contexts.remove(contexts.size() - 1);
        });
        api.addMethod(ns, "setContext", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            contexts.clear();
            if (!name.isEmpty()) {
                contexts.add(name);
            }
            return Boolean.TRUE;
        });

        // allow(context, actions[]) —— 声明这个上下文只放行哪些动作（不调用 = 全部放行）
        api.addMethod(ns, "allow", (cx, thisObj, args) -> {
            String ctx = ScriptJs.str(ScriptJs.arg(args, 0), "");
            List<String> list = new ArrayList<String>();
            Object v = ScriptJs.arg(args, 1);
            int n = ScriptJs.arrayLength(v);
            for (int i = 0; i < n; i++) {
                Object item = ScriptJs.getIndex(v, i);
                String s = ScriptJs.str(item, "");
                if (!s.isEmpty()) {
                    list.add(s);
                }
            }
            contextAllow.put(ctx, list);
            return Boolean.TRUE;
        });

        // on(action, fn) / off(fn)
        api.addMethod(ns, "on", (cx, thisObj, args) -> {
            String action = ScriptJs.str(ScriptJs.arg(args, 0), "");
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            if (action.isEmpty() || f == null) {
                return null;
            }
            List<Holder> list = handlers.get(action);
            if (list == null) {
                list = new ArrayList<Holder>();
                handlers.put(action, list);
            }
            list.add(new Holder(f, engine.def(engine.currentScriptName())));
            return f;
        });
        api.addMethod(ns, "off", (cx, thisObj, args) -> {
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 0));
            if (f == null) {
                return Boolean.FALSE;
            }
            boolean any = false;
            for (List<Holder> list : handlers.values()) {
                for (int i = list.size() - 1; i >= 0; i--) {
                    if (list.get(i).fn == f) {
                        list.remove(i);
                        any = true;
                    }
                }
            }
            if (any) {
                return Boolean.TRUE;
            }
            // 也允许 off(action, fn)
            String action = ScriptJs.str(ScriptJs.arg(args, 0), "");
            List<Holder> list = handlers.get(action);
            Function g = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            if (list == null || g == null) {
                return Boolean.FALSE;
            }
            for (int i = list.size() - 1; i >= 0; i--) {
                if (list.get(i).fn == g) {
                    list.remove(i);
                    return Boolean.TRUE;
                }
            }
            return Boolean.FALSE;
        });

        // focused() —— 窗口是否有焦点
        api.addMethod(ns, "focused", (cx, thisObj, args) -> Boolean.valueOf(!focusLost));
    }

    // ---------------- 查询 ----------------

    /**
     * 动作 → 鼠标键下标（{@code -2/-3/-4} = 左/中/右），键盘返回 -1。
     *
     * <p><b>为什么必须有这个映射</b>：{@code keyCodeOf} 把 {@code "Mouse0"} 编码成
     * <b>负数</b>（{@code -2}），而旧实现里 {@link #isDown} 用 {@code c < 0 continue}
     * 直接把鼠标跳过、{@link #isPressed} 又只认 {@code c >= 10000}（{@code keyCodeOf}
     * 根本不产生这个区间）。结果：默认绑定 {@code attack: Space, Mouse0} 中的
     * {@code Mouse0} 永久失效 —— 用鼠标左键攻击没有任何反应，而文档写着能用。
     */
    private static int mouseIndex(int code) {
        return code <= -2 ? Math.max(0, Math.min(2, -code - 2)) : -1;
    }

    private boolean isDown(String action) {
        if (focusLost || action == null || action.isEmpty()) {
            return false;
        }
        if (!allowed(action)) {
            return false;
        }
        int[] codes = bindings.get(action);
        if (codes == null) {
            return false;
        }
        for (int i = 0; i < codes.length; i++) {
            int c = codes[i];
            int m = mouseIndex(c);
            if (m >= 0) {
                if (m < engine.mouseNow.length
                        && (engine.mouseNow[m] || engine.mousePressed[m])) {
                    return true;
                }
            } else if (c >= 0 && c < 512 && engine.held != null && engine.held[c]) {
                return true;
            }
        }
        return false;
    }

    private boolean isPressed(String action) {
        if (focusLost || action == null || action.isEmpty()) {
            return false;
        }
        if (!allowed(action)) {
            return false;
        }
        int[] codes = bindings.get(action);
        if (codes == null) {
            return false;
        }
        for (int i = 0; i < codes.length; i++) {
            int c = codes[i];
            int m = mouseIndex(c);
            if (m >= 0) {
                if (m < engine.mousePressed.length && engine.mousePressed[m]) {
                    return true;
                }
            } else if (c >= 0 && c < 512 && engine.pressed != null && engine.pressed[c]) {
                return true;
            }
        }
        return false;
    }

    private boolean isReleased(String action) {
        if (focusLost || action == null || action.isEmpty()) {
            return false;
        }
        if (!allowed(action)) {
            return false;
        }
        int[] codes = bindings.get(action);
        if (codes == null) {
            return false;
        }
        for (int i = 0; i < codes.length; i++) {
            int c = codes[i];
            int m = mouseIndex(c);
            if (m >= 0) {
                if (m < engine.mousePrev.length && engine.mousePrev[m] && !engine.mouseNow[m]) {
                    return true;
                }
            } else if (c >= 0 && c < 512 && engine.released != null && engine.released[c]) {
                return true;
            }
        }
        return false;
    }

    /** 当前上下文是否放行该动作。 */
    private boolean allowed(String action) {
        String ctx = currentContext();
        List<String> allow = contextAllow.get(ctx);
        if (allow == null) {
            return true;
        }
        return allow.contains(action);
    }

    private String currentContext() {
        return contexts.isEmpty() ? "game" : contexts.get(contexts.size() - 1);
    }

    private Scriptable axis() {
        float x = 0f;
        float y = 0f;
        if (isDown("move_left")) {
            x -= 1f;
        }
        if (isDown("move_right")) {
            x += 1f;
        }
        if (isDown("move_up")) {
            y -= 1f;
        }
        if (isDown("move_down")) {
            y += 1f;
        }
        float len = (float) Math.sqrt(x * x + y * y);
        if (len > 1f) {
            x /= len;
            y /= len;
        }
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        ScriptJs.put(o, "x", Double.valueOf(x));
        ScriptJs.put(o, "y", Double.valueOf(y));
        return o;
    }

    /** bind({action: ["KeyW", ...]}) —— 值可以是字符串、数组、或逗号分隔字符串。 */
    private Boolean bindMap(Object v) {
        if (ScriptJs.isMissing(v) || !(v instanceof Scriptable)) {
            return Boolean.FALSE;
        }
        Scriptable map = (Scriptable) v;
        Object[] ids = ScriptJs.ids(map);
        int count = 0;
        for (int i = 0; i < ids.length; i++) {
            String action = String.valueOf(ids[i]);
            Object value = ScriptJs.get(map, action);
            List<Integer> codes = parseKeys(value);
            if (codes.isEmpty()) {
                engine.log("[动作] bind：" + action + " 没有可用键，已跳过");
                continue;
            }
            int[] arr = new int[codes.size()];
            for (int k = 0; k < arr.length; k++) {
                arr[k] = codes.get(k).intValue();
            }
            bindings.put(action, arr);
            count++;
        }
        return Boolean.valueOf(count > 0);
    }

    private List<Integer> parseKeys(Object v) {
        List<Integer> out = new ArrayList<Integer>();
        if (ScriptJs.isMissing(v)) {
            return out;
        }
        if (v instanceof Scriptable && !(v instanceof Number)) {
            int n = ScriptJs.arrayLength(v);
            for (int i = 0; i < n; i++) {
                addCode(out, ScriptJs.getIndex(v, i));
            }
            return out;
        }
        String s = ScriptJs.str(v, "");
        if (s.isEmpty()) {
            return out;
        }
        String[] parts = s.split("[,\\s]+");
        for (int i = 0; i < parts.length; i++) {
            addCode(out, parts[i]);
        }
        return out;
    }

    private void addCode(List<Integer> out, Object raw) {
        if (ScriptJs.isMissing(raw)) {
            return;
        }
        int code = ScriptApi.keyCodeOfPublic(raw);
        if (code != -1) {
            out.add(Integer.valueOf(code));
        }
    }

    private Scriptable array(List<Object> items) {
        org.mozilla.javascript.Context cx = org.mozilla.javascript.Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        return cx.newArray(scope, items.toArray());
    }

    // ---------------- 宿主回调 ----------------

    /** 窗口失焦：所有动作立刻失效（宿主在 FocusListener 里调）。 */
    void onFocusLost() {
        focusLost = true;
    }

    void onFocusGained() {
        focusLost = false;
    }

    /** 场景卸载：按脚本作用域清理订阅（映射表是工程级，保留）。 */
    void clearSceneState() {
        handlers.clear();
        contexts.clear();
        contextAllow.clear();
        focusLost = false;
    }

    /** 是否有动作绑定（测试/诊断）。 */
    boolean hasBinding(String action) {
        return bindings.containsKey(action);
    }

    // ---------------- 包内测试入口 ----------------
    //
    // 不是脚本 API（不走 api.addMethod，因此不进四方一致性成员表）。

    /** 动作总数。 */
    int actionCount() {
        return bindings.size();
    }

    /** 改绑一个动作（测试用：验证"改配置即改键"，不动游戏逻辑）。 */
    void bindForTest(String action) {
        bindings.put(action, new int[]{java.awt.event.KeyEvent.VK_I});
    }

    boolean isDownTest(String action) {
        return isDown(action);
    }

    boolean isPressedTest(String action) {
        return isPressed(action);
    }

    boolean isFocusedTest() {
        return !focusLost;
    }
}
