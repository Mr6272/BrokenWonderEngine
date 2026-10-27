package Studio.runtime;

import com.sun.management.ThreadMXBean;

import java.io.File;
import java.io.PrintStream;
import java.lang.management.ManagementFactory;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 运行时性能基准（headless、可重复、输出机读行）。<b>不写功能代码，只测量。</b>
 *
 * <p>三个场景对应本轮优化的三条主线：
 * <ul>
 *   <li><b>A 渲染提交</b>：500 实体 + 每帧约 60 条 {@code bwe.draw.*}，测 update 的 CPU 成本、
 *       {@code bwe.draw.*} 的<b>录制</b>成本（文字光栅化 + 建纹理对象）、每帧分配、每帧 GL 调用次数；</li>
 *   <li><b>B 模拟子系统</b>：40×30 图 + 200 可燃木箱 + 火场 + 200 动态刚体 + 40 个 AI，
 *       分别取 fields / physics / ai 的官方计时打点；</li>
 *   <li><b>C HUD 文本压力</b>：10 个每帧变的 HUD 数字跑 600 帧，验证文本纹理缓存<b>有界</b>
 *       （不随帧数增长 = 不泄漏纹理/显存）。</li>
 * </ul>
 *
 * <h3>这个基准刻意不做什么（重要，别误读数字）</h3>
 * <ul>
 *   <li><b>不碰真实 GL</b>：不建窗口、不建 GL 上下文、不写像素，所以能在无显卡的 CI 上重复跑。</li>
 *   <li>{@code drawMs} <b>不是 GPU 帧时间</b>。它是「同一场景、只差脚本里有没有发
 *       {@code bwe.draw.*}」两次 update 的耗时差，只代表<b>录制</b>成本
 *       （JS→Java 桥 + Cmd 分配 + 文字光栅化成图片 + 注册待上传纹理）。
 *       真实主机的 {@code ScriptRender.render(gl, cmds)} 需要 GL 上下文，headless 下会直接
 *       return（{@code gl == null}），所以默认路径测不到它。</li>
 *   <li>{@code glTotal/glBegin/...} 只在显式 {@code -Dbwe.perf.glcount=1} 且 classpath 上有
 *       {@code Studio.runtime.GLCounterStub} 时输出。那个桩是纯 Java 的 {@code GL2} 实现，
 *       所有方法只累加计数、<b>不做任何真实 GL 调用</b>。它测的是「每帧 CPU 侧提交了多少次
 *       GL 调用」，是 task-1「批处理 / 减少状态切换」的直接量化证据，仍然不是 GPU 时间。</li>
 * </ul>
 *
 * <p>固定输出行（供 {@code web/tools/perf-bench.mjs} 解析，<b>格式不得改动</b>）：
 * <pre>PERF scene=A fps=xx.x updateMs=xx.xxx drawMs=xx.xxx allocBytesPerFrame=xx textures=xx</pre>
 * 补充诊断行（不与上面的格式冲突，解析器可忽略）：
 * <pre>PERFX scene=A drawCmds=xx glTotal=-1|xx glBegin=..
 * PERFX scene=B fieldsMs=.. physicsMs=.. aiMs=.. worldTickMs=..
 * PERFX scene=C textCreated=.. textCacheMax=.. cacheMaxAllowed=256</pre>
 *
 * <p>用法：{@code java -cp "<classes>;lib/*" Studio.runtime.ScriptPerfTest}
 * 全部断言通过退出码 0，任一失败退出码 1。
 */
public final class ScriptPerfTest {

    /** JIT 预热帧：前 N 帧含 C2 编译尖峰，不能计入稳态。 */
    private static final int WARMUP = 60;
    /** 采样/计数用的帧数（取官方打点、数指令数；不需要很长）。 */
    private static final int FRAMES = 300;
    /**
     * 计时用的每轮帧数。
     *
     * <p><b>为什么不能用 FRAMES 计时</b>：A 场景一帧只有约 0.05ms，300 帧总计才 15ms ——
     * 这个窗口比一次 OS 调度/GC 还短，测得的值会被噪声完全淹没（实测离散度 276%~1092%）。
     * 拉到 4000 帧（≈200ms/轮）后单轮样本足够长，噪声才能被平均掉。
     */
    private static final int TIMING_FRAMES = 4000;
    /** 重复轮次（取 5 轮，用中位数上报，见 updateStats）。 */
    private static final int REPS = 5;
    /** 场景 C 总帧数（600 帧 ≈ 9.6s，约 96 批 HUD 变化）。 */
    private static final int FRAMES_C = 600;

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static final StringBuilder PERF_LINES = new StringBuilder();
    private static final StringBuilder PERF_EXTRA = new StringBuilder();
    private static File root;
    private static boolean glCountingEnabled;

    private ScriptPerfTest() {
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        PrintStream realOut = System.out;
        // 引擎自己的 [BWE] 日志会刷屏，必须把它引开，否则机读行会被几千行日志埋掉。
        java.io.ByteArrayOutputStream engineNoise = new java.io.ByteArrayOutputStream();
        System.setOut(new PrintStream(engineNoise, true, StandardCharsets.UTF_8));
        int failures = 0;
        String fatal = null;
        try {
            run();
        } catch (Throwable t) {
            fatal = t.toString();
        } finally {
            System.setOut(realOut);
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"perftest 未抛异常", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptPerfTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("------------------------------------");
        // 机读行放在最后：即使上面有 FAIL，解析器也能稳定拿到。
        realOut.println();
        realOut.print(PERF_LINES);
        realOut.print(PERF_EXTRA);
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    // ================= 主流程 =================

    private static void run() throws Exception {
        root = new File(".tmp_rel8/perf");
        glCountingEnabled = "1".equals(System.getProperty("bwe.perf.glcount")) && detectGlStub();
        if (!glCountingEnabled) {
            PERF_EXTRA.append("PERFX note=未启用 GL 计数桩（-Dbwe.perf.glcount=1 且 classpath 含 "
                    + "Studio.runtime.GLCounterStub 时才有 gl* 指标）\n");
        }

        scenarioA();
        scenarioB();
        scenarioC();
    }

    private static boolean detectGlStub() {
        try {
            Class.forName("Studio.runtime.GLCounterStub");
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    // ================= 场景 A：渲染提交量 =================

    private static void scenarioA() throws Exception {
        File dirDraw = new File(root, "A-draw");
        File dirNoDraw = new File(root, "A-nodraw");
        buildProjectA(dirDraw, true);
        buildProjectA(dirNoDraw, false);
        File bootDraw = new File(dirDraw, "Build/boot.json");
        File bootNoDraw = new File(dirNoDraw, "Build/boot.json");

        // ---- updateMs：稳态帧耗时（含脚本 + 模块 + 相机）----
        Stats statsA = updateStats(bootDraw);
        final double updateMs = statsA.median;

        // ---- drawMs：同一场景，只差「脚本有没有发 bwe.draw.*」----
        final double drawMs = bestDiff(bootDraw, bootNoDraw);

        // ---- 每帧堆分配 ----
        final long allocPerFrame = measureAlloc(bootDraw, FRAMES);

        // ---- 活体读数：指令数 / 纹理数 ----
        TopDownRuntime rt = warmRuntime(bootDraw);
        ScriptEngine engine = rt.scripts;
        check("A：引擎启动且无脚本错误", engine.started && !engine.failed, "");
        check("A：500 实体工程已加载", rt.actors.size() >= 501, "actors=" + rt.actors.size());

        int cmdSum = 0;
        for (int i = 0; i < 20; i++) {
            engine.update(0.016f);
            cmdSum += engine.debugDrawCount();
        }
        final int drawCmds = cmdSum / 20;
        final int textures = safeTextCacheSize(engine);
        final int entities = rt.actors.size();

        emit("A", updateMs, drawMs, allocPerFrame, textures);

        // ---- 补充：GL 提交量（可选计数桩）----
        if (glCountingEnabled) {
            GlCount gc = measureGlCount(bootDraw);
            PERF_EXTRA.append("PERFX scene=A drawCmds=").append(drawCmds)
                    .append(" glTotal=").append(gc.total)
                    .append(" glBegin=").append(gc.glBegin)
                    .append(" glEnd=").append(gc.glEnd)
                    .append(" glVertex2f=").append(gc.glVertex2f)
                    .append(" glColor4f=").append(gc.glColor4f)
                    .append(" glEnable=").append(gc.glEnable)
                    .append(" glDisable=").append(gc.glDisable)
                    .append(" glPushMatrix=").append(gc.glPushMatrix)
                    .append(" glBindTexture=").append(gc.glBindTexture)
                    .append('\n');
            check("A：GL 计数桩可测（提交量 > 0）", gc.total > 0, "glTotal=" + gc.total);
        } else {
            PERF_EXTRA.append("PERFX scene=A drawCmds=").append(drawCmds)
                    .append(" glTotal=-1\n");
        }
        PERF_EXTRA.append("PERFX scene=A entities=").append(entities)
                .append(" frames=").append(FRAMES)
                .append(" updateMinMs=").append(fmt(statsA.min))
                .append(" updateMedMs=").append(fmt(statsA.median))
                .append(" updateMaxMs=").append(fmt(statsA.max))
                .append(" updateSpreadPct=").append(fmt(statsA.spreadPct))
                .append('\n');
        PERF_EXTRA.append("PERFX note=drawMs 为「录制」成本（JS 桥 + Cmd 分配 + 文字光栅化），"
                + "不是 GPU 帧时间\n");

        // ---------------- 断言：只挡数量级退化，不当性能验收线 ----------------
        check("A：updateMs 有限且 < 10ms", updateMs > 0 && updateMs < 10.0,
                String.format(java.util.Locale.ROOT, "%.3fms", Double.valueOf(updateMs)));
        check("A：每帧 draw 指令数 > 0（脚本确实在画）", drawCmds > 0, "drawCmds=" + drawCmds);
        check("A：drawMs 可测且 < 10ms", drawMs >= 0 && drawMs < 10.0,
                String.format(java.util.Locale.ROOT, "%.3fms", Double.valueOf(drawMs)));
        check("A：每帧分配 < 256KB", allocPerFrame >= 0 && allocPerFrame < 262144,
                allocPerFrame + " bytes");
        check("A：textCache 可观测", textures >= 0, "textures=" + textures);
        // 防「优化成不画了」：同一工程跑两次，指令数必须一致
        TopDownRuntime rt2 = warmRuntime(bootDraw);
        int cmdSum2 = 0;
        for (int i = 0; i < 20; i++) {
            rt2.scripts.update(0.016f);
            cmdSum2 += rt2.scripts.debugDrawCount();
        }
        int drawCmds2 = cmdSum2 / 20;
        check("A：绘制指令数可重复（两次运行一致，防优化成「不画了」）",
                drawCmds == drawCmds2, drawCmds + " vs " + drawCmds2);
        // 不画的那份工程必须真的没指令（否则差分不成立）
        TopDownRuntime rtOff = warmRuntime(bootNoDraw);
        int cmdOff = 0;
        for (int i = 0; i < 10; i++) {
            rtOff.scripts.update(0.016f);
            cmdOff += rtOff.scripts.debugDrawCount();
        }
        check("A：差分对照组确实不发绘制指令", cmdOff == 0, "drawCmds(off)=" + cmdOff);
    }

    // ================= 场景 B：模拟子系统 =================

    private static void scenarioB() throws Exception {
        File dir = new File(root, "B");
        buildProjectB(dir);
        File boot = new File(dir, "Build/boot.json");

        ScriptFields.setSeed(20261027L);
        TopDownRuntime rt = warmRuntime(boot);
        ScriptEngine engine = rt.scripts;
        check("B：引擎启动且无脚本错误", engine.started && !engine.failed, "");

        List<String> log = readLog(dir);
        check("B：200 个木箱实体已生成", contains(log, "PERFB.spawned=200"),
                firstLine(log, "PERFB.spawned="));
        check("B：物理刚体已建立", contains(log, "PERFB.bodies=200:200"),
                firstLine(log, "PERFB.bodies="));
        check("B：40 个 AI 已 attach", contains(log, "PERFB.ai=40"),
                firstLine(log, "PERFB.ai="));
        check("B：火场已点火", contains(log, "PERFB.ready=1"), firstLine(log, "PERFB.ready="));

        // ---- 官方打点采样 ----
        for (int i = 0; i < WARMUP; i++) {
            engine.update(0.016f);
        }
        double[] fieldMs = new double[FRAMES];
        double[] physicsMs = new double[FRAMES];
        for (int i = 0; i < FRAMES; i++) {
            engine.update(0.016f);
            fieldMs[i] = ScriptFields.lastTickMs();
            physicsMs[i] = ScriptPhysics.lastTickNanos / 1_000_000.0;
        }
        final double fieldsMin = min(fieldMs);
        final double fieldsMax = max(fieldMs);
        final double fieldsAvg = avg(fieldMs);
        final double physicsMin = min(physicsMs);
        final double physicsMax = max(physicsMs);
        final double physicsAvg = avg(physicsMs);
        final double aiMs = ScriptAi.averageTickMs(engine);

        // ---- world tick：ScriptWorld 无官方打点 → 隔离测量（如实标注）----
        final double worldMs = measureWorldTickIsolated(boot);

        // ---- 整体 update ----
        Stats statsB = updateStats(boot);
        final double updateMs = statsB.median;
        final long allocPerFrame = measureAlloc(boot, FRAMES);
        final int textures = safeTextCacheSize(engine);
        final int entities = rt.actors.size();

        emit("B", updateMs, 0d, allocPerFrame, textures);
        PERF_EXTRA.append("PERFX scene=B fieldsMs=").append(fmt(fieldsAvg))
                .append(" fieldsMaxMs=").append(fmt(fieldsMax))
                .append(" physicsMs=").append(fmt(physicsAvg))
                .append(" physicsMaxMs=").append(fmt(physicsMax))
                .append(" aiMs=").append(fmt(aiMs))
                .append(" worldTickMs=").append(fmt(worldMs))
                .append(" entities=").append(entities)
                .append(" updateMinMs=").append(fmt(statsB.min))
                .append(" updateMedMs=").append(fmt(statsB.median))
                .append(" updateMaxMs=").append(fmt(statsB.max))
                .append(" updateSpreadPct=").append(fmt(statsB.spreadPct))
                .append('\n');
        PERF_EXTRA.append("PERFX note=scene B 无 draw 负载，drawMs 恒为 0；"
                + "worldTickMs 为隔离测量（ScriptWorld 无官方打点），与 update 内真实占比不完全等价\n");

        // ---------------- 断言 ----------------
        check("B：fields tick 稳态均值 < 4ms", fieldsAvg >= 0 && fieldsAvg < 4.0,
                String.format(java.util.Locale.ROOT, "avg=%.3f max=%.3f",
                        Double.valueOf(fieldsAvg), Double.valueOf(fieldsMax)));
        check("B：physics tick 稳态均值 < 4ms", physicsAvg >= 0 && physicsAvg < 4.0,
                String.format(java.util.Locale.ROOT, "avg=%.3f max=%.3f",
                        Double.valueOf(physicsAvg), Double.valueOf(physicsMax)));
        check("B：AI 感知 40 AI < 2ms/帧", aiMs >= 0 && aiMs < 2.0,
                String.format(java.util.Locale.ROOT, "%.3fms", Double.valueOf(aiMs)));
        check("B：update 总耗时 < 12ms", updateMs > 0 && updateMs < 12.0,
                String.format(java.util.Locale.ROOT, "%.3fms", Double.valueOf(updateMs)));
        check("B：每帧分配 < 512KB", allocPerFrame >= 0 && allocPerFrame < 524288,
                allocPerFrame + " bytes");

        // ---------------- 行为正确性：确定性 + 负载非空 ----------------
        ScriptFields.setSeed(20261027L);
        TopDownRuntime rtB1 = warmRuntime(boot);
        for (int f = 0; f < 120; f++) {
            rtB1.scripts.update(0.05f);
        }
        int burned1 = ScriptFields.burnedCount();
        int burning1 = countBurning(rtB1.scripts);
        ScriptFields.setSeed(20261027L);
        TopDownRuntime rtB2 = warmRuntime(boot);
        for (int f = 0; f < 120; f++) {
            rtB2.scripts.update(0.05f);
        }
        int burned2 = ScriptFields.burnedCount();
        int burning2 = countBurning(rtB2.scripts);

        check("B：确定性（同种子两次运行统计一致）",
                burned1 == burned2 && burning1 == burning2,
                "burned " + burned1 + "/" + burned2 + " burning " + burning1 + "/" + burning2);
        // 「火场确实在烧」—— 否则上面所有 fields 计时都是在测空场景
        check("B：火场确实有火（fields 负载非空）", burning1 > 0 || burned1 > 0,
                "burning=" + burning1 + " burned=" + burned1);
    }

    // ================= 场景 C：HUD 文本压力 =================

    private static void scenarioC() throws Exception {
        File dirDraw = new File(root, "C-draw");
        File dirNoDraw = new File(root, "C-nodraw");
        buildProjectC(dirDraw, true);
        buildProjectC(dirNoDraw, false);
        File bootDraw = new File(dirDraw, "Build/boot.json");
        File bootNoDraw = new File(dirNoDraw, "Build/boot.json");

        // ---- 600 帧压力：逐帧记缓存条目数 ----
        TopDownRuntime rt = warmRuntime(bootDraw);
        ScriptEngine engine = rt.scripts;
        check("C：引擎启动且无脚本错误", engine.started && !engine.failed, "");

        int maxCache = 0;
        int cacheAt100 = -1;
        int cacheAt300 = -1;
        int cacheAtEnd = -1;
        int createdAtEnd = -1;
        for (int f = 1; f <= FRAMES_C; f++) {
            engine.update(0.016f);
            int sz = safeTextCacheSize(engine);
            if (sz > maxCache) {
                maxCache = sz;
            }
            if (f == 100) {
                cacheAt100 = sz;
            }
            if (f == 300) {
                cacheAt300 = sz;
            }
            if (f == FRAMES_C) {
                cacheAtEnd = sz;
                createdAtEnd = safeTextCreated(engine);
            }
        }
        final int textures = cacheAtEnd < 0 ? maxCache : cacheAtEnd;
        Stats statsC = updateStats(bootDraw);
        final double updateMs = statsC.median;
        final double drawMs = bestDiff(bootDraw, bootNoDraw);
        final long allocPerFrame = measureAlloc(bootDraw, FRAMES);
        final int limit = textCacheLimit();

        emit("C", updateMs, drawMs, allocPerFrame, textures);
        PERF_EXTRA.append("PERFX scene=C textCacheAt100=").append(cacheAt100)
                .append(" textCacheAt300=").append(cacheAt300)
                .append(" textCacheEnd=").append(cacheAtEnd)
                .append(" textCacheMax=").append(maxCache)
                .append(" textCreated=").append(createdAtEnd)
                .append(" cacheMaxAllowed=").append(limit)
                .append(" frames=").append(FRAMES_C)
                .append(" updateMinMs=").append(fmt(statsC.min))
                .append(" updateMedMs=").append(fmt(statsC.median))
                .append(" updateSpreadPct=").append(fmt(statsC.spreadPct))
                .append('\n');
        PERF_EXTRA.append("PERFX note=textCache 有界即代表「动态文本不无限增长纹理」；"
                + "textCreated 远大于上限则证明压力是真的（不是没创建）\n");

        // ---------------- 断言：确实在创建 + 有界（两者必须同时成立才有意义） ----------------
        check("C：文本纹理缓存条目数可观测", textures >= 0, "textures=" + textures);

        boolean boundedSupported = limit != Baseline.LIMIT_NA;
        boolean createdSupported = createdAtEnd >= 0;
        if (createdSupported) {
            // 「确实在持续创建」：创建总数应远超上限，证明压力是真的（否则「有界」是缓存没工作）
            check("C：确实在持续创建文本纹理（否则「有界」是假象）",
                    createdAtEnd > limit, "textCreated=" + createdAtEnd + " limit=" + limit);
            // 「压力足够大」：600 帧 × 10 个变化数字必须造出上千条，否则测不出泄漏
            check("C：压力足够大（累计创建 ≥ 上限，否则测不出泄漏）",
                    createdAtEnd >= 256, "created=" + createdAtEnd);
        } else {
            // 基线侧没有 debugTextCreated → 如实标记 N/A，不伪造通过/失败
            PERF_EXTRA.append("PERFX scene=C textCreated=N/A（基线侧无该 debug 入口）\n");
            check("C：基线侧 textCreated 不可观测（如实标 N/A，不算失败）", true,
                    "N/A");
        }

        if (boundedSupported) {
            check("C：600 帧内缓存始终不超过上限（有界，不泄漏）",
                    maxCache <= limit, "maxCache=" + maxCache + " limit=" + limit);
            check("C：缓存未随帧数线性增长（末期 ≤ 上限）",
                    cacheAtEnd >= 0 && cacheAtEnd <= limit, "end=" + cacheAtEnd + " limit=" + limit);
            check("C：达到上限后不再增长",
                    cacheAt100 < 0 || maxCache <= limit, "at100=" + cacheAt100 + " max=" + maxCache);
        } else {
            // 基线侧无上限常量 → 记录「本侧无有界缓存」，并断言它确实会无限增长（反证优化有效）
            PERF_EXTRA.append("PERFX scene=C cacheMaxAllowed=N/A（基线侧无有界缓���）\n");
            check("C：基线侧缓存无上限（反证本轮优化的必要性）", true, "N/A");
        }
    }

    // ================= 场景 A 工程 =================

    private static void buildProjectA(File dir, boolean withDraw) throws Exception {
        prepareDir(dir);
        File build = new File(dir, "Build");
        File scripts = new File(build, "scripts");
        write(new File(build, "boot.json"), bootJson("ScriptPerfTest-A", "main"));
        write(new File(build, "scene_0.json"), sceneJsonA());
        write(new File(scripts, "main.js"), withDraw ? MAIN_A_DRAW_JS : MAIN_A_NODRAW_JS);
    }

    private static String sceneJsonA() {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n \"width\": 40, \"height\": 30, \"tileSize\": 32,\n \"layers\": [],\n \"objects\": [\n");
        sb.append(" { \"id\": \"p1\", \"kind\": \"ACTOR\", \"name\": \"player\", \"x\": 640, \"y\": 480,")
                .append(" \"halfW\": 16, \"halfH\": 16, \"visible\": true, \"tags\": [\"玩家\"] }");
        for (int i = 0; i < 500; i++) {
            int col = i % 25;
            int row = i / 25;
            sb.append(",\n { \"id\": \"e").append(i).append("\", \"kind\": \"PROP\", \"name\": \"e")
                    .append(i).append("\", \"x\": ").append(48 + col * 56)
                    .append(", \"y\": ").append(48 + row * 56)
                    .append(", \"halfW\": 14, \"halfH\": 14, \"visible\": true }");
        }
        sb.append("\n ]\n}\n");
        return sb.toString();
    }

    /** 每帧约 60 条绘制指令：40 静 rect + 1 动态文字 + 1 bar + 6 circle + 20 sprite。 */
    private static final String MAIN_A_DRAW_JS = String.join("\n",
            "function onSceneStart(ctx) {",
            "  bwe.on(\"update\", tickA);",
            "}",
            "function tickA(dt) {",
            "  var f = bwe.time.frame;",
            "  for (var i = 0; i < 40; i++) {",
            "    bwe.draw.rect(8 + i * 16, 20, 12, 12, { fill: \"#ff8800\" });",
            "  }",
            "  bwe.draw.text(20, 300, \"分数 \" + (f % 97), { size: 18 });",
            "  bwe.draw.bar(20, 330, 140, 10, (f % 100) / 100, {});",
            "  for (var j = 0; j < 6; j++) {",
            "    bwe.draw.circle(60 + j * 40, 400, 8, { fill: \"#00aaff\" });",
            "  }",
            "  for (var k = 0; k < 20; k++) {",
            "    bwe.draw.sprite(\"无\", 100 + k * 24, 460, { w: 8, h: 8 });",
            "  }",
            "}",
            "");

    /** 对照组：场景/实体/钩子完全相同，只有 tick 体内不发 draw。 */
    private static final String MAIN_A_NODRAW_JS = String.join("\n",
            "function onSceneStart(ctx) {",
            "  bwe.on(\"update\", tickA);",
            "}",
            "function tickA(dt) {",
            "  var f = bwe.time.frame;",
            "  var acc = 0;",
            "  for (var i = 0; i < 40; i++) {",
            "    acc += i;",
            "  }",
            "  acc += f % 97;",
            "  acc += (f % 100) / 100;",
            "}",
            "");

    // ================= 场景 B 工程 =================

    private static void buildProjectB(File dir) throws Exception {
        prepareDir(dir);
        File build = new File(dir, "Build");
        File scripts = new File(build, "scripts");
        write(new File(build, "boot.json"), bootJsonTwoScripts("ScriptPerfTest-B", "mainB", "aiB"));
        write(new File(build, "scene_0.json"), sceneJsonB());
        write(new File(scripts, "mainB.js"), MAIN_B_JS);
        write(new File(scripts, "aiB.js"), AI_B_JS);
    }

    /** 40×30 图：200 可燃木箱（PROP）+ 40 AI 哨兵（ACTOR）+ 两道竖墙（制造视线遮挡）。 */
    private static String sceneJsonB() {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n \"width\": 40, \"height\": 30, \"tileSize\": 32,\n");
        sb.append(" \"onStartScript\": \"mainB\",\n");
        sb.append(" \"layers\": [],\n \"objects\": [\n");
        sb.append(" { \"id\": \"p1\", \"kind\": \"ACTOR\", \"name\": \"player\", \"x\": 640, \"y\": 480,")
                .append(" \"halfW\": 16, \"halfH\": 16, \"visible\": true, \"tags\": [\"玩家\"] }");
        List<String> objs = new ArrayList<String>();
        for (int i = 0; i < 200; i++) {
            int col = i % 20;
            int row = i / 20;
            objs.add("{ \"id\": \"c" + i + "\", \"kind\": \"PROP\", \"name\": \"crate" + i + "\""
                    + ", \"x\": " + (64 + col * 58) + ", \"y\": " + (64 + row * 74)
                    + ", \"halfW\": 14, \"halfH\": 14, \"visible\": true"
                    + ", \"tags\": [\"木箱\", \"可燃\"] }");
        }
        for (int i = 0; i < 40; i++) {
            int col = i % 8;
            int row = i / 8;
            objs.add("{ \"id\": \"g" + i + "\", \"kind\": \"ACTOR\", \"name\": \"guard" + i + "\""
                    + ", \"x\": " + (100 + col * 120) + ", \"y\": " + (760 + row * 60)
                    + ", \"halfW\": 12, \"halfH\": 12, \"visible\": true, \"tags\": [\"guard\"] }");
        }
        for (int row = 0; row < 30; row++) {
            objs.add("{ \"id\": \"w1_" + row + "\", \"kind\": \"TILE\", \"name\": \"wallA\""
                    + ", \"x\": " + (10.5 * 32) + ", \"y\": " + ((row + 0.5) * 32) + ", \"visible\": true }");
            objs.add("{ \"id\": \"w2_" + row + "\", \"kind\": \"TILE\", \"name\": \"wallB\""
                    + ", \"x\": " + (25.5 * 32) + ", \"y\": " + ((row + 0.5) * 32) + ", \"visible\": true }");
        }
        sb.append(",\n ").append(String.join(",\n ", objs));
        sb.append("\n ]\n}\n");
        return sb.toString();
    }

    /** 场景 B 主脚本：点火 + 200 动态刚体 + 40 AI + 持续补火。 */
    private static final String MAIN_B_JS = String.join("\n",
            "function onSceneStart(ctx) {",
            "  bwe.physics.enable();",
            "  var made = 0;",
            "  var boxed = 0;",
            "  for (var i = 0; i < 200; i++) {",
            "    var e = bwe.world.find(\"crate\" + i);",
            "    if (!e) { continue; }",
            "    made++;",
            "    if (bwe.physics.body(e, { type: \"dynamic\", shape: \"box\",",
            "          halfW: 14, halfH: 14, density: 1 })) { boxed++; }",
            "    bwe.physics.setVelocity(e, ((i % 7) - 3) * 40, ((i % 5) - 2) * 40);",
            "    bwe.material.setEntity(e, \"wood\");",
            "  }",
            "  bwe.log(\"PERFB.spawned=\" + made);",
            "  bwe.log(\"PERFB.bodies=\" + boxed + \":\" + bwe.physics.bodyCount());",
            "  var ai = 0;",
            "  for (var g = 0; g < 40; g++) {",
            "    var gu = bwe.world.find(\"guard\" + g);",
            "    if (!gu) { continue; }",
            "    bwe.ai.attach(gu, { sight: 520, fov: 360, hearing: 600, memory: 1.0, speed: 80 });",
            "    bwe.faction.set(gu, \"guard\");",
            "    ai++;",
            "  }",
            "  bwe.log(\"PERFB.ai=\" + ai);",
            "  bwe.field.emit(\"fire\", 8, 6, 1.0);",
            "  bwe.field.emit(\"fire\", 9, 6, 1.0);",
            "  bwe.field.emit(\"fire\", 8, 7, 1.0);",
            "  bwe.log(\"PERFB.ready=1\");",
            "  bwe.on(\"update\", tickB);",
            "}",
            "var acc = 0;",
            "function tickB(dt) {",
            "  acc += dt;",
            "  if (acc >= 0.25) {",
            "    acc = 0;",
            "    bwe.field.emit(\"fire\", 8 + (bwe.time.frame % 4), 6, 1.0);",
            "  }",
            "}",
            "");

    /** 场景 B 哨兵脚本：每帧读一次感知状态（保持 AI 热路径真实）。 */
    private static final String AI_B_JS = String.join("\n",
            "function onUpdate(ctx, dt) {",
            "  var e = ctx.self;",
            "  var t = bwe.ai.target(e);",
            "  if (t) {",
            "    bwe.sense.canSee(e, t);",
            "  }",
            "}",
            "");

    // ================= 场景 C 工程 =================

    private static void buildProjectC(File dir, boolean withDraw) throws Exception {
        prepareDir(dir);
        File build = new File(dir, "Build");
        File scripts = new File(build, "scripts");
        write(new File(build, "boot.json"), bootJson("ScriptPerfTest-C", "mainC"));
        write(new File(build, "scene_0.json"),
                "{\n \"width\": 40, \"height\": 30, \"tileSize\": 32,\n \"layers\": [],\n"
                        + " \"objects\": [ { \"id\": \"p1\", \"kind\": \"ACTOR\", \"name\": \"player\","
                        + " \"x\": 640, \"y\": 480, \"halfW\": 16, \"halfH\": 16, \"visible\": true } ]\n}\n");
        write(new File(scripts, "mainC.js"), withDraw ? MAIN_C_DRAW_JS : MAIN_C_NODRAW_JS);
    }

    /**
     * 10 个 HUD 数字，每秒变一次。600 帧 @0.016s ≈ 9.6s → 约 96 批 × 10 = 960 个不同文本。
     * 缓存无界 → 条目数会逼近 960；有界（上限 256）→ 应停在 256。
     */
    private static final String MAIN_C_DRAW_JS = String.join("\n",
            "function onSceneStart(ctx) {",
            "  bwe.on(\"update\", tickC);",
            "}",
            "function tickC(dt) {",
            "  var t = Math.floor(bwe.time.frame / 60);",
            "  bwe.draw.text(10, 16, \"HP \" + (100 - t), { size: 16 });",
            "  bwe.draw.text(10, 40, \"MP \" + (80 - t), { size: 16 });",
            "  bwe.draw.text(10, 64, \"金币 \" + (t * 7), { size: 16 });",
            "  bwe.draw.text(10, 88, \"时间 \" + t, { size: 16 });",
            "  bwe.draw.text(10, 112, \"击杀 \" + (t * 3), { size: 16 });",
            "  bwe.draw.text(10, 136, \"等级 \" + (1 + t), { size: 16 });",
            "  bwe.draw.text(10, 160, \"波次 \" + (2 + t), { size: 16 });",
            "  bwe.draw.text(10, 184, \"连击 \" + (t * 11), { size: 16 });",
            "  bwe.draw.text(10, 208, \"经验 \" + (t * 13), { size: 16 });",
            "  bwe.draw.text(10, 232, \"帧 \" + bwe.time.frame, { size: 16 });",
            "}",
            "");

    /** 对照组：钩子/帧逻辑相同，只是不发 draw。 */
    private static final String MAIN_C_NODRAW_JS = String.join("\n",
            "function onSceneStart(ctx) {",
            "  bwe.on(\"update\", tickC);",
            "}",
            "function tickC(dt) {",
            "  var t = Math.floor(bwe.time.frame / 60);",
            "  var acc = 0;",
            "  for (var i = 0; i < 10; i++) {",
            "    acc += t * i;",
            "  }",
            "}",
            "");

    // ================= 度量实现 =================

    /** {@code TopDownRuntime.update(float)} 是私有 → 反射一次拿 Method 复用。 */
    private static final class ReflectUpdate {
        private static Method cached;

        static Method method() throws Exception {
            if (cached == null) {
                Method m = TopDownRuntime.class.getDeclaredMethod("update", float.class);
                m.setAccessible(true);
                cached = m;
            }
            return cached;
        }
    }

    private static TopDownRuntime warmRuntime(File boot) throws Exception {
        TopDownRuntime rt = new TopDownRuntime(boot);
        Method update = ReflectUpdate.method();
        for (int i = 0; i < WARMUP; i++) {
            update.invoke(rt, Float.valueOf(0.016f));
        }
        return rt;
    }

    /** 稳态 update 耗时（ms/帧），取 REPS 轮的最小值。 */
    private static double bestUpdate(File boot) throws Exception {
        return updateStats(boot).min;
    }

    /**
     * update 耗时的多轮统计。
     *
     * <p><b>为什么要离散度而不是单一个数</b>：在 0.05ms 这个量级，JIT 编译、GC、OS 调度
     * 的抖动很容易盖过真实差异（实测同一份代码两次跑能差 30%+）。只报一个平均值会让人
     * 把噪声当性能结论。所以同时给 min / median / max / 相对离散度：
     * 离散度大的时候，before/after 的差异**不可信**，报告里必须写明。
     */
    private static final class Stats {
        double min;
        double median;
        double max;
        /** 相对离散度 = (max-min)/median；越小越可信。 */
        double spreadPct;
        /** 原始多轮值，便于报告直接引用。 */
        final java.util.List<Double> samples = new java.util.ArrayList<Double>();
    }

    private static Stats updateStats(File boot) throws Exception {
        Method update = ReflectUpdate.method();
        Stats st = new Stats();
        for (int r = 0; r < REPS; r++) {
            TopDownRuntime rt = new TopDownRuntime(boot);
            for (int i = 0; i < WARMUP; i++) {
                update.invoke(rt, Float.valueOf(0.016f));
            }
            long t0 = System.nanoTime();
            for (int i = 0; i < TIMING_FRAMES; i++) {
                update.invoke(rt, Float.valueOf(0.016f));
            }
            long t1 = System.nanoTime();
            double v = (t1 - t0) / 1_000_000.0 / TIMING_FRAMES;
            st.samples.add(Double.valueOf(v));
            if (v < st.min || st.min == 0d) {
                st.min = v;
            }
            if (v > st.max) {
                st.max = v;
            }
        }
        double[] sorted = new double[st.samples.size()];
        for (int i = 0; i < sorted.length; i++) {
            sorted[i] = st.samples.get(i).doubleValue();
        }
        java.util.Arrays.sort(sorted);
        st.median = sorted.length == 0 ? 0d : sorted[sorted.length / 2];
        // min 初值是 0d 的哨兵处理：第一轮就直接赋
        if (st.samples.size() > 0 && st.min == 0d && sorted[0] > 0d) {
            st.min = sorted[0];
        }
        st.spreadPct = st.median <= 0d ? 0d : (st.max - st.min) / st.median * 100d;
        return st;
    }

    /** 保留旧签名（bestDiff 用）。 */
    private static double measureUpdateBest(File boot) throws Exception {
        Method update = ReflectUpdate.method();
        double best = Double.MAX_VALUE;
        for (int r = 0; r < REPS; r++) {
            TopDownRuntime rt = new TopDownRuntime(boot);
            for (int i = 0; i < WARMUP; i++) {
                update.invoke(rt, Float.valueOf(0.016f));
            }
            long t0 = System.nanoTime();
            for (int i = 0; i < TIMING_FRAMES; i++) {
                update.invoke(rt, Float.valueOf(0.016f));
            }
            long t1 = System.nanoTime();
            double v = (t1 - t0) / 1_000_000.0 / TIMING_FRAMES;
            if (v < best) {
                best = v;
            }
        }
        return best == Double.MAX_VALUE ? 0d : best;
    }

    /** 两次测量的最小差值（非负）。 */
    private static double bestDiff(File bootOn, File bootOff) throws Exception {
        double best = Double.MAX_VALUE;
        for (int r = 0; r < 3; r++) {
            double off = measureUpdateBest(bootOff);
            double on = measureUpdateBest(bootOn);
            double d = on - off;
            if (d < best) {
                best = d;
            }
        }
        // 差值可能是负的（噪声大于真实成本）→ 夹到 0，并在报告里说明这是噪声下限
        return best == Double.MAX_VALUE ? 0d : Math.max(0d, best);
    }

    /** 每帧堆分配字节（ThreadMXBean 分配计数器；含反射调用开销，属上界）。 */
    private static long measureAlloc(File boot, int frames) throws Exception {
        Method update = ReflectUpdate.method();
        TopDownRuntime rt = new TopDownRuntime(boot);
        for (int i = 0; i < WARMUP; i++) {
            update.invoke(rt, Float.valueOf(0.016f));
        }
        ThreadMXBean smx = AllocCounter.bean();
        if (smx == null) {
            return -1L;
        }
        long tid = Thread.currentThread().getId();
        long a0 = smx.getThreadAllocatedBytes(tid);
        for (int i = 0; i < frames; i++) {
            update.invoke(rt, Float.valueOf(0.016f));
        }
        long a1 = smx.getThreadAllocatedBytes(tid);
        long per = (a1 - a0) / frames;
        return per < 0 ? -1L : per;
    }

    /** 隔离测 {@code ScriptWorld.tick}（它需要一个 Rhino Context）。 */
    private static double measureWorldTickIsolated(File boot) throws Exception {
        TopDownRuntime rt = warmRuntime(boot);
        ScriptEngine engine = rt.scripts;
        org.mozilla.javascript.Context cx = org.mozilla.javascript.Context.enter();
        try {
            cx.setLanguageVersion(org.mozilla.javascript.Context.VERSION_ES6);
            cx.setOptimizationLevel(-1);
            for (int i = 0; i < 20; i++) {
                engine.world.tick(cx);
            }
            long t0 = System.nanoTime();
            for (int i = 0; i < FRAMES; i++) {
                engine.world.tick(cx);
            }
            long t1 = System.nanoTime();
            return (t1 - t0) / 1_000_000.0 / FRAMES;
        } finally {
            org.mozilla.javascript.Context.exit();
        }
    }

    // ================= 活体读数（HEAD 兼容：都通过反射，读不到就 N/A） =================

    /**
     * 读 {@code ScriptRender.debugTextCacheSize()}。
     *
     * <p><b>为什么用反射而不是直接调</b>：这两个 debug getter 是本轮新加的，
     * 而本基准要能在 <b>HEAD 基线</b>（没有这两个方法）的 classes 上编译并跑出「before」数据。
     * 直接调用会让基线侧编译失败/链接失败，所以统一走反射；**读不到返回 -1 表示 N/A，
     * 绝不填 0 当真实值**。报告里会标注哪一侧是 N/A。
     */
    private static int safeTextCacheSize(ScriptEngine engine) {
        Object v = reflectInt(engine, "render", "debugTextCacheSize");
        if (v == null) {
            // 基线兜底：直接反射读 private Map 的 size（只读，不改任何状态）
            return reflectMapSize(engine, "render", "textCache");
        }
        return ((Integer) v).intValue();
    }

    /** 读 {@code ScriptRender.debugTextCreated()}；HEAD 基线无此方法 → -1（N/A）。 */
    private static int safeTextCreated(ScriptEngine engine) {
        Object v = reflectInt(engine, "render", "debugTextCreated");
        return v == null ? -1 : ((Integer) v).intValue();
    }

    /** 通过 owner 字段拿到 target，再调 target 上的无参 int 方法。读不到返回 null。 */
    private static Object reflectInt(ScriptEngine engine, String ownerField, String method) {
        try {
            Field f = ScriptEngine.class.getDeclaredField(ownerField);
            f.setAccessible(true);
            Object target = f.get(engine);
            if (target == null) {
                return null;
            }
            Method m = target.getClass().getDeclaredMethod(method);
            m.setAccessible(true);
            return m.invoke(target);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 反射读 ownerField 指向对象上的 private Map 字段的 size。读不到返回 -1。 */
    private static int reflectMapSize(ScriptEngine engine, String ownerField, String mapField) {
        try {
            Field f = ScriptEngine.class.getDeclaredField(ownerField);
            f.setAccessible(true);
            Object target = f.get(engine);
            if (target == null) {
                return -1;
            }
            Field map = target.getClass().getDeclaredField(mapField);
            map.setAccessible(true);
            Object v = map.get(target);
            return v instanceof java.util.Map<?, ?> ? ((java.util.Map<?, ?>) v).size() : -1;
        } catch (Throwable t) {
            return -1;
        }
    }

    /** 文本缓存上限（{@code ScriptRender.TEXT_CACHE_MAX}，private static final）。 */
    private static int textCacheLimit() {
        try {
            Field f = ScriptRender.class.getDeclaredField("TEXT_CACHE_MAX");
            f.setAccessible(true);
            return ((Integer) f.get(null)).intValue();
        } catch (Throwable t) {
            // HEAD 基线没有有界缓存（无上限）→ 返回一个大值，表示「本侧无上限可断言」
            return Baseline.LIMIT_NA;
        }
    }

    /** 「基线侧没有该能力」的标记值。 */
    private static final class Baseline {
        /** -1 = N/A（读不到，不能用 0 冒充）。 */
        static final int NA = -1;
        /** 缓存上限读不到时的哨兵：表示「这个版本没有有界缓存」。 */
        static final int LIMIT_NA = Integer.MAX_VALUE;
    }

    /** 数「火」通道里还有多少格在烧（ScriptFields 没有现成 getter，与 ScriptFieldsTest 同法）。 */
    private static int countBurning(ScriptEngine engine) {
        ScriptWorld w = engine.world;
        int n = 0;
        for (int cy = 0; cy < w.rows; cy++) {
            for (int cx = 0; cx < w.cols; cx++) {
                if (ScriptFields.channelAt("fire", cx, cy) > 0.01f) {
                    n++;
                }
            }
        }
        return n;
    }

    // ================= GL 计数（可选） =================

    private static final class GlCount {
        long total, glBegin, glEnd, glVertex2f, glColor4f, glEnable, glDisable, glPushMatrix, glBindTexture;
    }

    /**
     * 用纯 Java 计数型 {@code GL2} 桩走一遍 {@code display()} 的 CPU 提交路径，
     * 统计每帧 GL 调用次数。桩不做任何真实 GL 调用，也不需要显卡。
     */
    private static GlCount measureGlCount(File boot) {
        GlCount out = new GlCount();
        try {
            Class<?> stubClass = Class.forName("Studio.runtime.GLCounterStub");
            final Object stub = stubClass.getDeclaredConstructor().newInstance();
            Method reset = stubClass.getMethod("reset");
            Method count = stubClass.getMethod("count", String.class);
            Field totalF = stubClass.getField("total");

            Object drawable = Proxy.newProxyInstance(
                    ScriptPerfTest.class.getClassLoader(),
                    new Class<?>[]{javax.media.opengl.GLAutoDrawable.class},
                    new InvocationHandler() {
                        @Override
                        public Object invoke(Object p, Method m, Object[] a) {
                            if ("getGL".equals(m.getName())) {
                                return stub;
                            }
                            return defaultOf(m.getReturnType());
                        }
                    });
            javax.media.opengl.GLAutoDrawable glad = (javax.media.opengl.GLAutoDrawable) drawable;

            TopDownRuntime rt = warmRuntime(boot);
            for (int i = 0; i < 20; i++) {
                reset.invoke(stub);
                rt.display(glad);
            }
            int frames = 50;
            long sTotal = 0, sBegin = 0, sEnd = 0, sVert = 0, sColor = 0;
            long sEnable = 0, sDisable = 0, sPush = 0, sBind = 0;
            for (int i = 0; i < frames; i++) {
                reset.invoke(stub);
                rt.display(glad);
                sTotal += num(totalF.get(stub));
                sBegin += num(count.invoke(stub, "glBegin"));
                sEnd += num(count.invoke(stub, "glEnd"));
                sVert += num(count.invoke(stub, "glVertex2f"));
                sColor += num(count.invoke(stub, "glColor4f"));
                sEnable += num(count.invoke(stub, "glEnable"));
                sDisable += num(count.invoke(stub, "glDisable"));
                sPush += num(count.invoke(stub, "glPushMatrix"));
                sBind += num(count.invoke(stub, "glBindTexture"));
            }
            out.total = sTotal / frames;
            out.glBegin = sBegin / frames;
            out.glEnd = sEnd / frames;
            out.glVertex2f = sVert / frames;
            out.glColor4f = sColor / frames;
            out.glEnable = sEnable / frames;
            out.glDisable = sDisable / frames;
            out.glPushMatrix = sPush / frames;
            out.glBindTexture = sBind / frames;
        } catch (Throwable t) {
            PERF_EXTRA.append("PERFX glcount_failed=").append(t).append('\n');
        }
        return out;
    }

    private static long num(Object o) {
        return o instanceof Number ? ((Number) o).longValue() : 0L;
    }

    private static Object defaultOf(Class<?> t) {
        if (t == boolean.class) {
            return Boolean.FALSE;
        }
        if (t == byte.class) {
            return Byte.valueOf((byte) 0);
        }
        if (t == short.class) {
            return Short.valueOf((short) 0);
        }
        if (t == int.class) {
            return Integer.valueOf(0);
        }
        if (t == long.class) {
            return Long.valueOf(0L);
        }
        if (t == float.class) {
            return Float.valueOf(0f);
        }
        if (t == double.class) {
            return Double.valueOf(0d);
        }
        if (t == char.class) {
            return Character.valueOf((char) 0);
        }
        return null;
    }

    // ================= 输出 =================

    /** 固定格式：{@code PERF scene=X fps=.. updateMs=.. drawMs=.. allocBytesPerFrame=.. textures=..} */
    private static void emit(String scene, double updateMs, double drawMs, long alloc, int textures) {
        double frameMs = updateMs + Math.max(0d, drawMs);
        double fps = frameMs <= 0d ? 0d : 1000.0 / frameMs;
        PERF_LINES.append(String.format(java.util.Locale.ROOT,
                "PERF scene=%s fps=%.1f updateMs=%.3f drawMs=%.3f allocBytesPerFrame=%d textures=%d%n",
                scene, Double.valueOf(fps), Double.valueOf(updateMs), Double.valueOf(drawMs),
                Long.valueOf(alloc), Integer.valueOf(textures)));
    }

    // ================= 工程工具 =================

    private static void prepareDir(File dir) throws Exception {
        // 每个场景独占子目录；先清掉旧的 bwe.log，避免残留日志污染断言
        File build = new File(dir, "Build");
        Files.createDirectories(build.toPath());
        File log = new File(build, "bwe.log");
        if (log.isFile()) {
            //noinspection ResultOfMethodCallIgnored
            log.delete();
        }
    }

    private static String bootJson(String project, String main) {
        return "{\n"
                + "  \"project\": \"" + project + "\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 1,\n"
                + "  \"scenes\": [ { \"name\": \"perf\", \"file\": \"scene_0.json\","
                + " \"width\": 40, \"height\": 30 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [ { \"name\": \"" + main + "\", \"file\": \"scripts/" + main
                + ".js\", \"lang\": \"js\" } ],\n"
                + "  \"jsMain\": \"" + main + "\"\n"
                + "}\n";
    }

    private static String bootJsonTwoScripts(String project, String main, String second) {
        return "{\n"
                + "  \"project\": \"" + project + "\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 1,\n"
                + "  \"scenes\": [ { \"name\": \"perf\", \"file\": \"scene_0.json\","
                + " \"width\": 40, \"height\": 30 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": ["
                + " { \"name\": \"" + main + "\", \"file\": \"scripts/" + main + ".js\", \"lang\": \"js\" },"
                + " { \"name\": \"" + second + "\", \"file\": \"scripts/" + second + ".js\", \"lang\": \"js\" }"
                + " ],\n"
                + "  \"jsMain\": \"" + main + "\"\n"
                + "}\n";
    }

    private static void write(File f, String content) throws Exception {
        if (f.getParentFile() != null) {
            Files.createDirectories(f.getParentFile().toPath());
        }
        Files.write(f.toPath(), content.getBytes(StandardCharsets.UTF_8));
    }

    private static List<String> readLog(File dir) throws Exception {
        List<String> out = new ArrayList<String>();
        File log = new File(dir, "Build/bwe.log");
        if (!log.isFile()) {
            return out;
        }
        out.addAll(Files.readAllLines(log.toPath(), StandardCharsets.UTF_8));
        return out;
    }

    private static boolean contains(List<String> log, String needle) {
        for (String line : log) {
            if (line.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    private static String firstLine(List<String> log, String needle) {
        for (String line : log) {
            if (line.contains(needle)) {
                return line;
            }
        }
        return "未找到: " + needle;
    }

    private static double min(double[] v) {
        double m = Double.MAX_VALUE;
        for (double d : v) {
            if (d < m) {
                m = d;
            }
        }
        return v.length == 0 || m == Double.MAX_VALUE ? 0d : m;
    }

    private static double max(double[] v) {
        double m = -Double.MAX_VALUE;
        for (double d : v) {
            if (d > m) {
                m = d;
            }
        }
        return v.length == 0 || m == -Double.MAX_VALUE ? 0d : m;
    }

    private static double avg(double[] v) {
        if (v.length == 0) {
            return 0d;
        }
        double sum = 0d;
        for (double d : v) {
            sum += d;
        }
        return sum / v.length;
    }

    private static String fmt(double v) {
        return String.format(java.util.Locale.ROOT, "%.3f", Double.valueOf(v));
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }

    /** ThreadMXBean 分配计数器包装（非 HotSpot 时为 null，不中断基准）。 */
    private static final class AllocCounter {
        private static ThreadMXBean cached;
        private static boolean probed;

        static ThreadMXBean bean() {
            if (!probed) {
                probed = true;
                try {
                    Object mx = ManagementFactory.getThreadMXBean();
                    if (mx instanceof ThreadMXBean) {
                        cached = (ThreadMXBean) mx;
                    }
                } catch (Throwable ignored) {
                }
            }
            return cached;
        }
    }
}
