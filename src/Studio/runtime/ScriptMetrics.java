package Studio.runtime;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 脚本可观测性数据仓：{@code bwe.debug.errors}（错误环形缓冲）与 {@code bwe.prof}（性能剖析）
 * 的唯一数据源。
 *
 * <h3>解决什么问题</h3>
 * 引擎原来把所有脚本异常 {@code catch (Throwable)} 后只 print 一行日志就走掉，
 * 网页版/桌面版都拿不到「哪个脚本第几行炸了、炸了几次」的<b>结构化</b>信息；
 * 性能上也只有一个「单帧超 250ms」的粗告警。这里把两类数据集中进<b>有界</b>缓冲，
 * 由 {@link ScriptProf} / {@link ScriptDebug} 暴露给脚本。
 *
 * <h3>为什么单独一个类，而不是塞进 ScriptEngine</h3>
 * ScriptEngine 已经不短，且它是「执行」而这里是「记录」。分开之后，
 * 记录逻辑可以单测（{@link ScriptObservabilityTest}），也不会被引擎里 22 处 catch 的增长牵着改。
 *
 * <h3>内存上界（都是硬上界，绝不无限增长）</h3>
 * <ul>
 *   <li>错误条目：最多 {@link #MAX_ERRORS} 条，满了淘汰最老的；</li>
 *   <li>整帧耗时样本：{@link #FRAME_SAMPLES} 个 float（开启剖析时才分配，约 8KB）；</li>
 *   <li>每脚本样本：每个脚本 {@link #SCRIPT_SAMPLES} 个 float（约 2KB），脚本数上限 = 工程脚本数。</li>
 * </ul>
 *
 * <h3>开销</h3>
 * 记录错误：先线性扫最多 32 条做去重，命中就只自增计数 —— O(32)，摊还 O(1)。
 * 记录耗时：{@code if (!enabled) return;} 之后是一次 long 累加 + 一次 map 查 + 一次环形写入，
 * 全程零分配。**剖析本身耗时不算进样本**（{@code nanoTime()} 只包住 JS 调用本体）。
 */
final class ScriptMetrics {

    /** 错误环形缓冲容量（契约 §6：最近 32 条）。 */
    static final int MAX_ERRORS = 32;

    /** 整帧耗时样本窗口（契约：p50/p95/p99 用最近 N=2048 帧）。 */
    static final int FRAME_SAMPLES = 2048;

    /** 每脚本单次调用耗时的样本窗口（用于该脚本的 p95）。 */
    static final int SCRIPT_SAMPLES = 512;

    // ==================== 一、脚本错误环形缓冲 ====================

    /** 一条被记录下来的脚本错误。字段与契约 {@code bwe.debug.errors()} 的条目一一对应。 */
    static final class Err {
        final String script;
        final String message;
        final int line;
        final int frame;
        /** 同一条重复次数（去重键 = script + line + message）。 */
        int count;

        Err(String script, String message, int line, int frame) {
            this.script = script;
            this.message = message;
            this.line = line;
            this.frame = frame;
            this.count = 1;
        }
    }

    private final List<Err> errors = new ArrayList<Err>(MAX_ERRORS);

    /**
     * 记录一条脚本错误。
     *
     * <p><b>去重语义</b>：script + line + message 完全相同的重复错误只自增 {@code count}，
     * 不新增条目 —— 否则每帧抛一次的脚本会在两秒内把 32 条缓冲冲干净，
     * 反而看不到首次发生的位置。命中时完全不动其它字段（保留首次的 frame）。
     *
     * <p><b>淘汰语义</b>：缓冲满了就移除最老的一条（下标 0）。
     */
    void recordError(String script, String message, int line, int frame) {
        String s = script == null || script.isEmpty() ? "?" : script;
        String m = message == null ? "" : message;
        for (int i = 0; i < errors.size(); i++) {
            Err e = errors.get(i);
            if (e.line == line && e.script.equals(s) && e.message.equals(m)) {
                e.count++;
                return;
            }
        }
        if (errors.size() >= MAX_ERRORS) {
            errors.remove(0);
        }
        errors.add(new Err(s, m, line, frame));
    }

    /** 当前缓冲里的错误（快照，按从旧到新；调用方可以安全遍历）。 */
    List<Err> errorSnapshot() {
        return new ArrayList<Err>(errors);
    }

    int errorCount() {
        return errors.size();
    }

    void clearErrors() {
        errors.clear();
    }

    /** 最近一条错误的 {@code script:line} 描述（只读诊断用，不进脚本 API）。 */
    String lastErrorKey() {
        if (errors.isEmpty()) {
            return "";
        }
        Err e = errors.get(errors.size() - 1);
        return e.script + ":" + e.line;
    }

    /**
     * 把错误缓冲序列化成 JSON。
     *
     * <p>形状固定为 {@code {count, errors:[{script,message,line,count,frame}]}}，
     * 下游（编辑器「问题」面板 / AI 助手）只按这个形状读，不要随手加字段。
     */
    String errorsToJson() {
        JsonObject root = new JsonObject();
        JsonArray arr = new JsonArray();
        for (int i = 0; i < errors.size(); i++) {
            Err e = errors.get(i);
            JsonObject o = new JsonObject();
            o.addProperty("script", e.script);
            o.addProperty("message", e.message);
            o.addProperty("line", e.line);
            o.addProperty("count", e.count);
            o.addProperty("frame", e.frame);
            arr.add(o);
        }
        root.addProperty("count", errors.size());
        root.add("errors", arr);
        return new GsonBuilder().setPrettyPrinting().create().toJson(root);
    }

    /**
     * 把错误缓冲落盘（{@code bwe.debug.dumpErrors}）。
     *
     * @param buildRoot Build 目录的父目录（工程根）。为 null 时退化为当前工作目录。
     * @param relPath   相对工程根的路径；空串用默认 {@code Build/diagnostics/script-errors.json}。
     * @return 写成功返回 true。**任何失败都只返回 false，不抛异常** ——
     *         这是调试辅助功能，不该因为它把游戏搞崩。
     */
    boolean dumpErrors(java.io.File buildRoot, String relPath) {
        String rel = relPath == null ? "" : relPath.trim().replace('\\', '/');
        if (rel.isEmpty()) {
            rel = DEFAULT_DUMP_PATH;
        }
        // 安全：拒绝绝对路径与 ".."，避免脚本把诊断文件写到任意位置（与 bwe.save 同一纪律）。
        if (rel.startsWith("/") || rel.startsWith(":") || rel.contains("..")) {
            return false;
        }
        java.io.File base = buildRoot == null ? new java.io.File(".") : buildRoot;
        java.io.File f = new java.io.File(base, rel);
        try {
            java.io.File parent = f.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                return false;
            }
            java.nio.file.Files.write(f.toPath(),
                    errorsToJson().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 默认落盘路径（契约 §6）。 */
    static final String DEFAULT_DUMP_PATH = "Build/diagnostics/script-errors.json";

    // ==================== 二、脚本性能剖析 ====================

    /** 单个脚本的累计统计：总调用次数 + 最近若干次单次耗时的环形样本。 */
    static final class ScriptStat {
        final String name;
        long calls;
        /** 只在开启剖析后才有内容（float 存毫秒足够，省一半内存）。 */
        final float[] samples = new float[SCRIPT_SAMPLES];
        int pos;
        int filled;

        ScriptStat(String name) {
            this.name = name;
        }

        void record(long nanos) {
            calls++;
            samples[pos] = (float) (nanos / 1_000_000.0);
            pos = (pos + 1) % SCRIPT_SAMPLES;
            if (filled < SCRIPT_SAMPLES) {
                filled++;
            }
        }

        /** 最近样本的毫秒值，按从旧到新（只供 report 拷贝，热路径不用）。 */
        double[] distinctSamples() {
            double[] out = new double[filled];
            int start = filled == SCRIPT_SAMPLES ? pos : 0;
            for (int i = 0; i < filled; i++) {
                out[i] = samples[(start + i) % SCRIPT_SAMPLES];
            }
            return out;
        }
    }

    private boolean profEnabled;
    private float[] frameMs;
    private int framePos;
    private int frameFilled;
    /** 当前帧已经累计的脚本耗时（纳秒）。帧末由 {@link #endFrame()} 结算。 */
    private long frameNanos;

    private final Map<String, ScriptStat> scriptStats = new LinkedHashMap<String, ScriptStat>();

    boolean isProfEnabled() {
        return profEnabled;
    }

    /**
     * 开/关剖析。默认关闭。
     *
     * <p>关闭不清空已有样本（这样「关掉再打开」不会丢历史）；要清空请调 {@link #reset()}
     * —— 两个语义分开，免得用户在 UI 上切开关时意外把刚测的数据弄没。
     */
    boolean setProfEnabled(boolean on) {
        if (on && frameMs == null) {
            frameMs = new float[FRAME_SAMPLES];
        }
        profEnabled = on;
        return profEnabled;
    }

    /**
     * 记录一次 JS 调用（{@code ScriptEngine.invoke} 的唯一出口）。
     *
     * <p>⚠ 热路径：关闭时只有一次布尔判断；开启时也只有一次 long 加法 + 一次 map 查 +
     * 一次数组写入，<b>不分配任何对象</b>。{@code nanos} 由调用方用 {@code nanoTime()}
     * 只包住 JS 调用本体算出，不含记录成本。
     */
    void recordCall(String name, long nanos) {
        if (!profEnabled) {
            return;
        }
        frameNanos += nanos;
        ScriptStat st = scriptStats.get(name);
        if (st == null) {
            st = new ScriptStat(name);
            scriptStats.put(name, st);
        }
        st.record(nanos);
    }

    /** 帧末结算：把本帧累计的脚本耗时推进环形窗口。 */
    void endFrame() {
        // ⚠ 累计器必须**无条件**清零：如果在累计途中关掉剖析再打开，
        // 残留的旧值会被算进新帧（表现为 avg 莫名偏高）。清零本身是 O(1)，不值得省。
        long nanos = frameNanos;
        frameNanos = 0L;
        if (!profEnabled) {
            return;
        }
        frameMs[framePos] = (float) (nanos / 1_000_000.0);
        framePos = (framePos + 1) % FRAME_SAMPLES;
        if (frameFilled < FRAME_SAMPLES) {
            frameFilled++;
        }
    }

    /** 异常帧：只清零累计器，不推进样本（避免把异常处理耗时算成脚本耗时）。 */
    void endFrameOnError() {
        frameNanos = 0L;
    }

    /** {@code bwe.prof.report()} 的数据体（脚本侧再转成 JS 对象）。 */
    static final class Report {
        int frames;
        double avgMs;
        double p50Ms;
        double p95Ms;
        double p99Ms;
        double maxMs;
        final List<ScriptStat> scripts = new ArrayList<ScriptStat>();
    }

    /**
     * 计算报告。
     *
     * <p>百分位用「最近 N 帧的排序快照」算：样本窗口固定 2048，排序只在调用时发生
     * （report 不是每帧调的），所以不会拖慢帧循环。
     */
    Report computeReport() {
        Report r = new Report();
        r.frames = frameFilled;
        double[] v = new double[frameFilled];
        int start = frameFilled == FRAME_SAMPLES ? framePos : 0;
        for (int i = 0; i < frameFilled; i++) {
            v[i] = frameMsToEpoch(frameMs, start, i);
        }
        if (v.length == 0) {
            return r;
        }
        java.util.Arrays.sort(v);
        double sum = 0;
        for (int i = 0; i < v.length; i++) {
            sum += v[i];
        }
        r.avgMs = sum / v.length;
        r.maxMs = v[v.length - 1];
        r.p50Ms = percentile(v, 0.50);
        r.p95Ms = percentile(v, 0.95);
        r.p99Ms = percentile(v, 0.99);
        for (ScriptStat st : scriptStats.values()) {
            r.scripts.add(st);
        }
        return r;
    }

    /**
     * 取一个已<b>升序排序</b>数组的百分位。
     *
     * <p>用「下标取整」而不是插值：这是性能水位线，不是分位数测量，
     * 取整保证 {@code p50 ≤ p95 ≤ p99 ≤ max} 恒成立（下标单调 ⇒ 值单调），
     * 而插值在样本很少时会算出比 max 更大的值。
     */
    static double percentile(double[] sorted, double p) {
        if (sorted.length == 0) {
            return 0d;
        }
        int idx = (int) Math.round(p * (sorted.length - 1));
        if (idx < 0) {
            idx = 0;
        }
        if (idx >= sorted.length) {
            idx = sorted.length - 1;
        }
        return sorted[idx];
    }

    /** 脚本侧 p95（对单个脚本的单次调用耗时样本求）。 */
    static double p95Of(ScriptStat st) {
        if (st == null || st.filled == 0) {
            return 0d;
        }
        double[] v = st.distinctSamples();
        java.util.Arrays.sort(v);
        return percentile(v, 0.95);
    }

    private double frameMsToEpoch(float[] buf, int start, int i) {
        return buf[(start + i) % FRAME_SAMPLES];
    }

    /** 清空剖析样本与每脚本统计（不清错误缓冲 —— 那是 {@link #clearErrors()} 的事）。 */
    boolean reset() {
        if (frameMs != null) {
            java.util.Arrays.fill(frameMs, 0f);
        }
        framePos = 0;
        frameFilled = 0;
        frameNanos = 0L;
        scriptStats.clear();
        return true;
    }

    /** 当前帧累计的脚本耗时（纳秒），供自测断言「剖析没把耗时算进去」。 */
    long pendingFrameNanos() {
        return frameNanos;
    }
}
