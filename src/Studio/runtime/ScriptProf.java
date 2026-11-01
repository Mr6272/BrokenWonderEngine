package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Scriptable;

/**
 * 脚本性能剖析命名空间 {@code bwe.prof}（契约 {@code docs/desktop-migration.md} §6）。
 *
 * <h3>解决什么问题</h3>
 * 「这一帧到底卡在哪个脚本」原来只能靠肉眼猜：引擎只有一个「单帧超 250ms 打一条告警」的兜底。
 * 这里给出可编程的剖析：开启后按<b>每脚本</b>累计执行耗时，随时读整帧耗时的
 * p50 / p95 / p99 / max，定位到具体脚本后再单独看它的 p95。
 *
 * <h3>层归属</h3>
 * L2 通用框架。纯观测，<b>不改变</b>任何脚本执行语义：关掉之后每帧行为逐字节一致。
 *
 * <h3>默认关闭 + 开销上限</h3>
 * 默认关闭时热路径只多一次布尔判断（见 {@link ScriptMetrics#recordCall}）。
 * 开启后每次 JS 调用多一次 {@code nanoTime()} + 一次 long 加法 + 一次 map 查 + 一次环形写，
 * 实测对帧耗时的影响 &lt; 3%（见 {@code ScriptObservabilityTest} 的采样开销断言）。
 */
final class ScriptProf {

    static ScriptProf LAST;

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final ScriptMetrics metrics;
    private final Scriptable ns;

    private ScriptProf(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.metrics = engine.metrics();
        this.ns = api.newObj();
    }

    static void install(ScriptApi api) {
        ScriptProf p = new ScriptProf(api);
        p.build();
        api.attach("prof", p.ns);
        LAST = p;
    }

    private void build() {
        // enable(on = true) → boolean
        api.addMethod(ns, "enable", (cx, thisObj, args) -> {
            boolean on = ScriptJs.isMissing(ScriptJs.arg(args, 0))
                    || ScriptJs.bool(ScriptJs.arg(args, 0), true);
            return Boolean.valueOf(metrics.setProfEnabled(on));
        });

        // report() → { frames, avgMs, p50Ms, p95Ms, p99Ms, maxMs, scripts: [{name, p95Ms, calls}] }
        //
        // ⚠ frames 的语义（给 UI/AI 面板的判读口径，实测确认过三种状态）：
        //   · 从未 enable()            → frames = 0（一个样本都没推进过）
        //   · reset() 之后             → frames = 0（样本清零）
        //   · enable 后跑了 N 帧        → frames = N（封顶 2048）
        //   · enable 跑过再 enable(false) → frames **保持 N**（关开关不清样本，见 setProfEnabled 注释）
        // 所以 **frames == 0 恒等价于「没有可用样本」**，可以安全当作"没测过"来显示；
        // 但 frames > 0 不代表"当前在采"—— 要判断是否在采必须看 Java 侧 isProfEnabled()
        // （契约没暴露 enabled()，见文件末尾注释）。
        api.addMethod(ns, "report", (cx, thisObj, args) -> reportObject());

        // reset() → boolean
        api.addMethod(ns, "reset", (cx, thisObj, args) -> Boolean.valueOf(metrics.reset()));

        // ⚠ 刻意**不**暴露 enabled()：契约 §6 只定义 enable/report/reset 三个成员，
        // 多一个成员就要在 bwe.d.ts / apiDocs.ts / docs/api 四处同步解释它的语义，
        // 反而把「开关状态」这个内部细节变成对外承诺。脚本要判断"是否在看数据"，
        // 直接看 report().frames > 0 就够了（0 就是没数据）。
    }

    /**
     * 建 report 的 JS 对象。
     *
     * <p>为什么整帧用数组而不是 Java List 返回：Rhino 把 Java List 包成 Java 对象，
     * 脚本里 {@code r.scripts.length} / {@code for (var i...)} 都会走 Java 反射，
     * 且 {@code JSON.stringify} 拿不到元素。这里统一建 <b>JS 原生数组</b>
     * （与 {@code bwe.debug.stats()} 的做法一致：Flex 对象 + ScriptJs.put）。
     */
    private Object reportObject() {
        ScriptMetrics.Report r = metrics.computeReport();
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        ScriptJs.put(o, "frames", Double.valueOf(r.frames));
        ScriptJs.put(o, "avgMs", Double.valueOf(r.avgMs));
        ScriptJs.put(o, "p50Ms", Double.valueOf(r.p50Ms));
        ScriptJs.put(o, "p95Ms", Double.valueOf(r.p95Ms));
        ScriptJs.put(o, "p99Ms", Double.valueOf(r.p99Ms));
        ScriptJs.put(o, "maxMs", Double.valueOf(r.maxMs));

        Object[] items = new Object[r.scripts.size()];
        for (int i = 0; i < r.scripts.size(); i++) {
            ScriptMetrics.ScriptStat st = r.scripts.get(i);
            ScriptJs.Flex s = (ScriptJs.Flex) api.newObj();
            ScriptJs.put(s, "name", st.name);
            ScriptJs.put(s, "p95Ms", Double.valueOf(ScriptMetrics.p95Of(st)));
            ScriptJs.put(s, "calls", Double.valueOf(st.calls));
            items[i] = s;
        }
        ScriptJs.put(o, "scripts", newArray(items));
        return o;
    }

    private Scriptable newArray(Object[] values) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        return cx.newArray(ns.getParentScope(), values == null ? new Object[0] : values);
    }

    // ---------------- 包内测试入口（不是脚本 API） ----------------

    boolean enabledForTest() {
        return metrics.isProfEnabled();
    }
}
