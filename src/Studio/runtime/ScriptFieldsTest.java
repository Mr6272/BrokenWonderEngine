package Studio.runtime;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 材质 + 多通道格子场自检（契约 §2.11.1 / §2.11.2，验收场景 §2.11.7 的 1/2/3/6）。
 *
 * <p>流程：现场生成两个同样的最小工程（runA / runB）→ 各自 {@code new TopDownRuntime(boot)}
 * → 手动推进 {@code engine.update(0.1f)}（固定步长 0.1s，与场 tickRate 对齐）→ 断言：
 * <ol>
 *   <li>点燃草地 3 秒内烧掉 ≥15 格，火烧到石墙停止（墙外格未燃烧）；</li>
 *   <li>木箱被烧毁（实体消失 + 该格不再阻挡）；</li>
 *   <li>相邻水格灭火，且周围材质变 wet（有效易燃度下降）；</li>
 *   <li>同种子两次结果完全一致（烧毁格数 + 材质快照 + 事件计数）；</li>
 *   <li>JS 表面（bwe.material.* / bwe.field.*）按契约可用；</li>
 *   <li>100x100 地图每 tick &lt; 2ms（性能）。</li>
 * </ol>
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class ScriptFieldsTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;
    private static String perfLine = "";

    private ScriptFieldsTest() {
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        PrintStream realOut = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true));
        int failures = 0;
        String fatal = null;
        try {
            run();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace(realOut);
        } finally {
            System.setOut(realOut);
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"ScriptFieldsTest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptFieldsTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("--------------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        if (!perfLine.isEmpty()) {
            realOut.println(perfLine);
        }
        if (root != null) {
            realOut.println("日志: " + new File(root, "runA/Build/bwe.log").getAbsolutePath());
            realOut.println("      " + new File(root, "perf/Build/bwe.log").getAbsolutePath());
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- 主流程 ----------------

    private static void run() throws Exception {
        root = new File(".tmp_rel8/fields");
        deleteRecursively(root);
        buildScenario(new File(root, "runA"));
        buildScenario(new File(root, "runB"));

        // §2.11.7.6：同种子跑两遍
        ScriptFields.setSeed(20261026L);
        Snap a = runScenario(new File(root, "runA"));
        ScriptFields.setSeed(20261026L);
        Snap b = runScenario(new File(root, "runB"));

        check("场景工程已生成", new File(root, "runA/Build/boot.json").isFile(), "");
        check("引擎启动成功", a.engineStarted && !a.failed, a.failDetail);

        // ------------- JS 表面：bwe.material -------------
        check("material.define/get/tags/of/setTile/ofEntity/setEntity 都是函数",
                "function,function,function,function,function,function,function".equals(
                        logValue(a.log, "FIELDS api.material=")),
                String.valueOf(logValue(a.log, "FIELDS api.material=")));
        check("自定义材质 define 生效（flammable=0.2）",
                approx(parse(logValue(a.log, "FIELDS mat.custom="), -1), 0.2, 0.001),
                String.valueOf(logValue(a.log, "FIELDS mat.custom=")));
        check("自定义材质 tags 生效（hot|liquid）",
                "hot|liquid".equals(logValue(a.log, "FIELDS mat.tags=")),
                String.valueOf(logValue(a.log, "FIELDS mat.tags=")));
        check("内置 stone：不燃 + hardness=8",
                approx(parseHead(logValue(a.log, "FIELDS mat.stone="), -1), 0, 0.001),
                String.valueOf(logValue(a.log, "FIELDS mat.stone=")));
        check("内置 grass：flammable=0.8 / tags=plant|ground",
                approx(parse(logValue(a.log, "FIELDS mat.grass="), -1), 0.8, 0.001)
                        && "plant|ground".equals(logValue(a.log, "FIELDS mat.grassTags=")),
                logValue(a.log, "FIELDS mat.grass=") + " / " + logValue(a.log, "FIELDS mat.grassTags="));
        check("material.of(cx,cy) 读到 setTile 后的材质（water）",
                "water".equals(logValue(a.log, "FIELDS mat.water=")),
                String.valueOf(logValue(a.log, "FIELDS mat.water=")));
        check("material.ofEntity(e) 按 material 模块参数映射（wood）",
                "wood".equals(logValue(a.log, "FIELDS mat.ofEntity=")),
                String.valueOf(logValue(a.log, "FIELDS mat.ofEntity=")));
        check("material.setEntity(e, name) 覆盖实体材质（cloth）",
                "cloth".equals(logValue(a.log, "FIELDS mat.setEntity=")),
                String.valueOf(logValue(a.log, "FIELDS mat.setEntity=")));

        // ------------- JS 表面：bwe.field -------------
        check("field.emit/sample/clear/tickRate/channel/wind/on/burning 都是函数",
                "function,function,function,function,function,function,function,function".equals(
                        logValue(a.log, "FIELDS api.field=")),
                String.valueOf(logValue(a.log, "FIELDS api.field=")));
        check("自定义通道 channel(name).max() + emit/sample 生效（1.5）",
                approx(parse(logValue(a.log, "FIELDS ch.poison="), -1), 1.5, 0.001),
                String.valueOf(logValue(a.log, "FIELDS ch.poison=")));
        check("field.clear(ch) 清零通道",
                approx(parse(logValue(a.log, "FIELDS ch.clear="), -1), 0, 0.001),
                String.valueOf(logValue(a.log, "FIELDS ch.clear=")));
        check("field.wind(dx,dy) 写入并回读", "0.3,-0.2".equals(logValue(a.log, "FIELDS wind=")),
                String.valueOf(logValue(a.log, "FIELDS wind=")));
        check("field.tickRate() 缺省 0.1s",
                approx(parse(logValue(a.log, "FIELDS tickRate="), -1), 0.1, 0.0001),
                String.valueOf(logValue(a.log, "FIELDS tickRate=")));
        check("field.on(ignite) 回调被派发",
                parse(logValue(a.log, "FIELDS ev.ignite="), 0) > 0,
                String.valueOf(logValue(a.log, "FIELDS ev.ignite=")));
        check("field.burning() 返回燃烧格列表",
                "1".equals(logValue(a.log, "FIELDS field.burning=")),
                String.valueOf(logValue(a.log, "FIELDS field.burning=")));

        // ------------- §2.11.7.1 烧草地 + 石墙阻断 -------------
        check("§2.11.7.1 点燃草地 3 秒内烧掉 ≥15 格",
                a.burnedAt3s >= 15, "burned=" + a.burnedAt3s);
        check("§2.11.7.1 点火格本身已烧尽（材质变 null）", a.ignitionBurned, "material=" + a.ignitionMat);
        check("§2.11.7.1 石墙不燃（墙格仍是 stone 且继续阻挡）", a.wallStillStone,
                "mat=" + a.wallMat + " solid=" + a.wallSolid);
        check("§2.11.7.1 墙外草地未燃烧", a.farGrassOk, "far=" + a.farGrassMat);
        check("§2.11.7.1 烧穿的地块已不再阻挡（tilemap 放行）",
                a.solidBurnedPatch >= 15, "solidBurned=" + a.solidBurnedPatch);
        check("§2.11.7.1 burned 事件数与烧毁格数一致（3 秒时刻）",
                a.burnedEventsAt3s == a.burnedAt3s,
                "events=" + a.burnedEventsAt3s + " burned=" + a.burnedAt3s);
        check("§2.11.7.1 extinguish 事件被派发（燃烧结束）",
                a.extinguishEventsAt3s > 0, "ext=" + a.extinguishEventsAt3s);
        check("§2.11.7.1 火在 1 秒时刻仍在燃烧（不是瞬间烧完）",
                a.maxFirePatch > 0.05, "fire=" + a.maxFirePatch);

        // ------------- §2.11.7.2 木箱烧毁 -------------
        check("§2.11.7.2 木箱（TILE）被烧毁：实体消失", a.crateTileGone, "crate_tile 仍在");
        check("§2.11.7.2 木箱烧毁后该格不再阻挡", !a.crateTileSolid, "solid=" + a.crateTileSolid);
        check("§2.11.7.2 木箱格材质变 null", a.crateTileMat == null, "mat=" + a.crateTileMat);
        check("§2.11.7.2 隔壁木箱（PROP 实体）也被烧毁", a.cratePropGone, "crate_prop 仍在");

        // ------------- §2.11.7.3 水灭火 + wet -------------
        final float grassFlammable = 0.8f;
        check("§2.11.7.3 水格自身不燃（材质 water、fire=0）",
                "water".equals(a.waterCellMat) && a.maxFireWaterNb <= 0.001f,
                "mat=" + a.waterCellMat + " maxFire=" + a.maxFireWaterNb);
        check("§2.11.7.3 浇水前该格确实在烧（douse.fire>0）",
                parse(logValue(a.log, "FIELDS douse.fire="), -1) > 0.3,
                String.valueOf(logValue(a.log, "FIELDS douse.fire=")));
        check("§2.11.7.3 正在燃烧的格被水扑灭（fire 归零）",
                a.fireDoused < 0.6, "fire=" + a.fireDoused);
        check("§2.11.7.3 被浇水的格没被烧尽（材质仍是 grass）",
                "grass".equals(a.dousedMat), "mat=" + a.dousedMat);
        check("§2.11.7.3 材质被标记 wet（wet>0.5）", a.wetDoused > 0.5f, "wet=" + a.wetDoused);
        check("§2.11.7.3 wet 使有效易燃度减半（≤ ×0.55）",
                a.flammDoused > 0f && a.flammDoused <= grassFlammable * 0.55f,
                "flamm=" + a.flammDoused);
        check("§2.11.7.3 邻近水格的材质也变 wet（扩散到邻格）",
                a.wetWaterNb > 0.5f && a.flammWaterNb <= grassFlammable * 0.55f,
                "wet=" + a.wetWaterNb + " flamm=" + a.flammWaterNb);

        // ------------- §2.11.7.6 确定性 -------------
        check("§2.11.7.6 同种子两遍：3 秒烧毁格数一致", a.burnedAt3s == b.burnedAt3s,
                a.burnedAt3s + " vs " + b.burnedAt3s);
        check("§2.11.7.6 同种子两遍：最终烧毁格数一致", a.burnedAt7s == b.burnedAt7s,
                a.burnedAt7s + " vs " + b.burnedAt7s);
        check("§2.11.7.6 同种子两遍：材质/湿润快照一致",
                a.signature.equals(b.signature), "signature 不同");
        check("§2.11.7.6 同种子两遍：事件计数一致",
                a.burnedEventsAt3s == b.burnedEventsAt3s
                        && a.extinguishEventsAt3s == b.extinguishEventsAt3s
                        && a.igniteEventsAt3s == b.igniteEventsAt3s,
                a.burnedEventsAt3s + "/" + a.extinguishEventsAt3s + "/" + a.igniteEventsAt3s
                        + " vs " + b.burnedEventsAt3s + "/" + b.extinguishEventsAt3s
                        + "/" + b.igniteEventsAt3s);

        // ------------- 性能：100x100 -------------
        buildPerf(new File(root, "perf"));
        Perf perf = runPerf(new File(root, "perf"));
        check("100x100 地图材质场 tick < 2ms（稳态峰值，跳过前 " + PERF_WARMUP + " 帧 JIT 预热）",
                perf.maxMs < 2.0,
                "max=" + fmt(perf.maxMs) + "ms avg=" + fmt(perf.avgMs)
                        + "ms rawMax(含预热)=" + fmt(perf.rawMaxMs)
                        + "ms cells=" + perf.peakBurning);
        check("100x100 地图材质场 tick 平均 < 0.5ms", perf.avgMs < 0.5,
                "avg=" + fmt(perf.avgMs) + "ms");
        check("性能工程确实形成了大规模燃烧（活跃格 > 1500）", perf.peakBurning > 1500,
                "peakBurning=" + perf.peakBurning);

        // 报告数字（不影响断言）
        perfLine = "[perf] 100x100 草地场 tick：max(稳态)=" + fmt(perf.maxMs)
                + "ms rawMax(含预热)=" + fmt(perf.rawMaxMs)
                + "ms avg=" + fmt(perf.avgMs) + "ms frames=" + perf.frames
                + " peakBurning=" + perf.peakBurning
                + " totalBurned=" + perf.totalBurned
                + " | maxFrame=" + perf.maxFrame + " burning@max=" + perf.maxBurning
                + " | top: " + perf.top;
    }

    // ---------------- 场景运行 ----------------

    private static final class Snap {
        boolean engineStarted;
        boolean failed;
        String failDetail = "";

        double maxFirePatch;
        double maxFireWaterNb;
        double fireDoused;
        float wetDoused;
        float flammDoused;
        String dousedMat = "";
        String waterCellMat = "";
        float wetWaterNb;
        float flammWaterNb;

        int burnedAt3s;
        int burnedAt7s;
        String ignitionMat;
        boolean ignitionBurned;
        String wallMat = "";
        boolean wallSolid;
        boolean wallStillStone;
        String farGrassMat = "";
        boolean farGrassOk;
        int solidBurnedPatch;

        boolean crateTileGone;
        boolean cratePropGone;
        boolean crateTileSolid;
        String crateTileMat;

        int igniteEventsAt3s;
        int burnedEventsAt3s;
        int extinguishEventsAt3s;

        String signature = "";
        List<String> log = new ArrayList<String>();
    }

    private static Snap runScenario(File dir) throws Exception {
        Snap s = new Snap();
        File boot = new File(dir, "Build/boot.json");
        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        s.engineStarted = engine != null && !engine.failed;
        s.failed = engine == null || engine.failed;
        if (engine == null) {
            return s;
        }
        // 11 帧 = 1.1s（其中第 6/7 帧由脚本「点火 → 浇水」）
        for (int i = 0; i < 11; i++) {
            engine.update(0.1f);
            s.maxFireWaterNb = Math.max(s.maxFireWaterNb, ScriptFields.channelAt("fire", 5, 5));
        }
        s.maxFirePatch = maxFireIn(engine, 4, 4, 8, 8);
        s.fireDoused = ScriptFields.channelAt("fire", 7, 5);
        s.wetDoused = ScriptFields.wetAt(7, 5);
        s.flammDoused = ScriptFields.flammabilityAt(7, 5);
        s.dousedMat = ScriptFields.materialAt(7, 5);
        s.waterCellMat = ScriptFields.materialAt(4, 4);
        s.wetWaterNb = ScriptFields.wetAt(5, 5);
        s.flammWaterNb = ScriptFields.flammabilityAt(5, 5);
        // 到 30 帧 = 3.0s
        for (int i = 11; i < 30; i++) {
            engine.update(0.1f);
        }
        s.burnedAt3s = ScriptFields.burnedCount();
        s.ignitionMat = ScriptFields.materialAt(6, 6);
        s.ignitionBurned = s.ignitionMat == null;
        s.wallMat = ScriptFields.materialAt(10, 5);
        s.wallSolid = engine.world.solidCell(10, 5);
        s.wallStillStone = "stone".equals(s.wallMat) && s.wallSolid;
        s.farGrassMat = ScriptFields.materialAt(11, 6);
        s.farGrassOk = "grass".equals(s.farGrassMat);
        s.solidBurnedPatch = countNonSolid(engine, 4, 4, 8, 8);
        // 第 31 帧：让脚本的 3 秒统计日志（ev.burned/ev.extinguish）落盘（回报的是前 30 tick）
        engine.update(0.1f);
        // 到 71 帧 = 7.1s
        for (int i = 31; i < 71; i++) {
            engine.update(0.1f);
        }
        s.burnedAt7s = ScriptFields.burnedCount();
        s.crateTileGone = actorNamed(rt, "crate_tile") == null;
        s.cratePropGone = actorNamed(rt, "crate_prop") == null;
        s.crateTileSolid = engine.world.solidCell(9, 6);
        s.crateTileMat = ScriptFields.materialAt(9, 6);
        s.signature = signature(engine);
        s.log = readLog(dir);
        s.igniteEventsAt3s = (int) parse(logValue(s.log, "FIELDS ev.ignite2="), -1);
        s.burnedEventsAt3s = (int) parse(logValue(s.log, "FIELDS ev.burned="), -1);
        s.extinguishEventsAt3s = (int) parse(logValue(s.log, "FIELDS ev.extinguish="), -1);
        return s;
    }

    private static double maxFireIn(ScriptEngine engine, int cx0, int cy0, int cx1, int cy1) {
        double max = 0;
        for (int cy = cy0; cy <= cy1; cy++) {
            for (int cx = cx0; cx <= cx1; cx++) {
                max = Math.max(max, ScriptFields.channelAt("fire", cx, cy));
            }
        }
        return max;
    }

    private static int countNonSolid(ScriptEngine engine, int cx0, int cy0, int cx1, int cy1) {
        int n = 0;
        for (int cy = cy0; cy <= cy1; cy++) {
            for (int cx = cx0; cx <= cx1; cx++) {
                if (!engine.world.solidCell(cx, cy)) {
                    n++;
                }
            }
        }
        return n;
    }

    /** 材质 + 湿润 + 通道强度的确定性快照。 */
    private static String signature(ScriptEngine engine) {
        StringBuilder sb = new StringBuilder(8192);
        ScriptWorld w = engine.world;
        for (int cy = 0; cy < w.rows; cy++) {
            for (int cx = 0; cx < w.cols; cx++) {
                String m = ScriptFields.materialAt(cx, cy);
                sb.append(m == null ? '-' : m).append(',');
                sb.append((int) (ScriptFields.wetAt(cx, cy) * 8f)).append(';');
            }
        }
        sb.append('|');
        for (int cy = 0; cy < w.rows; cy++) {
            for (int cx = 0; cx < w.cols; cx++) {
                sb.append((int) (ScriptFields.channelAt("fire", cx, cy) * 64f)).append(';');
            }
        }
        return sb.toString();
    }

    // ---------------- 性能工程 ----------------

    private static final class Perf {
        double maxMs;
        double avgMs;
        /** 含 JIT 预热帧的原始峰值（只报告，不参与断言）。 */
        double rawMaxMs;
        int frames;
        int peakBurning;
        int totalBurned;
        int maxFrame;
        int maxBurning;
        String top = "";
    }

    /** JIT 预热帧数：前 N 帧会包含 C2 编译热点循环的尖峰，不能算进稳态峰值。 */
    private static final int PERF_WARMUP = 40;

    private static Perf runPerf(File dir) throws Exception {
        Perf p = new Perf();
        File boot = new File(dir, "Build/boot.json");
        ScriptFields.setSeed(20261026L);
        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        if (engine == null) {
            return p;
        }
        double[] ms = new double[200];
        int[] burningAt = new int[200];
        int peak = 0;
        for (int i = 0; i < 200; i++) {
            engine.update(0.1f);
            if (i >= 5) {
                ms[i] = ScriptFields.lastTickMs();
                burningAt[i] = countBurning(engine);
                if (burningAt[i] > peak) {
                    peak = burningAt[i];
                }
            }
        }
        int n = 0;
        double sum = 0;
        double max = 0;
        double rawMax = 0;
        int maxFrame = -1;
        for (int i = 5; i < 200; i++) {
            if (ms[i] > rawMax) {
                rawMax = ms[i];
            }
            if (i < PERF_WARMUP) {
                continue; // JIT 预热阶段，只记录 rawMax
            }
            sum += ms[i];
            n++;
            if (ms[i] > max) {
                max = ms[i];
                maxFrame = i;
            }
        }
        p.maxMs = max;
        p.rawMaxMs = rawMax;
        p.avgMs = n == 0 ? 0 : sum / n;
        p.frames = n;
        p.peakBurning = peak;
        p.totalBurned = ScriptFields.burnedCount();
        p.maxFrame = maxFrame;
        p.maxBurning = maxFrame >= 0 ? burningAt[maxFrame] : 0;
        StringBuilder top = new StringBuilder();
        boolean[] used = new boolean[200];
        for (int k = 0; k < 6; k++) {
            int best = -1;
            for (int i = PERF_WARMUP; i < 200; i++) {
                if (used[i]) {
                    continue;
                }
                if (best < 0 || ms[i] > ms[best]) {
                    best = i;
                }
            }
            if (best < 0) {
                break;
            }
            used[best] = true;
            top.append("f").append(best).append('=').append(fmt(ms[best])).append("ms/b")
                    .append(burningAt[best]).append(' ');
        }
        p.top = top.toString();
        return p;
    }

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

    // ---------------- 工程生成 ----------------

    private static void buildScenario(File dir) throws Exception {
        File build = new File(dir, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());

        String boot = "{\n"
                + "  \"project\": \"ScriptFieldsTest\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 0,\n"
                + "  \"scenes\": [ { \"name\": \"材质场自检\", \"file\": \"scene_0.json\", \"width\": 40, \"height\": 30 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [ { \"name\": \"main\", \"file\": \"scripts/main.js\", \"lang\": \"js\" } ],\n"
                + "  \"jsMain\": \"main\"\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);

        StringBuilder scene = new StringBuilder();
        scene.append("{\n  \"width\": 40, \"height\": 30, \"tileSize\": 32,\n");
        scene.append("  \"layers\": [],\n  \"objects\": [\n");
        boolean first = true;

        // 草地：cx 4..8 × cy 4..8（25 格，其中 (4,4) 由 JS 改成 water）
        for (int cy = 4; cy <= 8; cy++) {
            for (int cx = 4; cx <= 8; cx++) {
                first = obj(scene, first, "g" + cx + "_" + cy, "TILE", "grass", cx, cy,
                        " \"assetName\": \"grass\"");
            }
        }
        // 石墙：cx=10 整列（紧贴木箱外侧）
        for (int cy = 0; cy <= 29; cy++) {
            first = obj(scene, first, "w" + cy, "TILE", "stone_wall", 10, cy,
                    " \"assetName\": \"stone\"");
        }
        // 墙外草地：cx 11..13 × cy 4..8
        for (int cy = 4; cy <= 8; cy++) {
            for (int cx = 11; cx <= 13; cx++) {
                first = obj(scene, first, "f" + cx + "_" + cy, "TILE", "grass_far", cx, cy,
                        " \"assetName\": \"grass\"");
            }
        }
        // 木箱（TILE，烧穿后要开路）：cx=9, cy=6
        first = obj(scene, first, "crateTile", "TILE", "crate_tile", 9, 6,
                " \"assetName\": \"wood\", \"modules\": [ { \"def\": \"material\","
                        + " \"params\": { \"material\": \"wood\" } } ]");
        // 木箱（PROP，实体烧毁）
        first = obj(scene, first, "crateProp", "PROP", "crate_prop", 6, 3,
                " \"halfW\": 12, \"halfH\": 12, \"modules\": [ { \"def\": \"material\","
                        + " \"params\": { \"material\": \"wood\" } } ]");
        // 玩家（与火无关，保证场景里有个 ACTOR）
        obj(scene, first, "player", "ACTOR", "player", 2, 2,
                " \"halfW\": 16, \"halfH\": 16, \"tags\": [\"玩家\"]");
        scene.append("\n  ]\n}\n");
        write(new File(build, "scene_0.json"), scene.toString());

        write(new File(scripts, "main.js"), SCENARIO_JS);
    }

    private static boolean obj(StringBuilder sb, boolean first, String id, String kind, String name,
                               int cx, int cy, String extra) {
        if (!first) {
            sb.append(",\n");
        }
        sb.append("    { \"id\": \"").append(id).append("\", \"kind\": \"").append(kind)
                .append("\", \"name\": \"").append(name).append("\",")
                .append(" \"x\": ").append((cx + 0.5) * 32).append(", \"y\": ")
                .append((cy + 0.5) * 32).append(", \"visible\": true")
                .append(extra.isEmpty() ? "" : "," + extra)
                .append(" }");
        return false;
    }

    private static void buildPerf(File dir) throws Exception {
        File build = new File(dir, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());

        String boot = "{\n"
                + "  \"project\": \"ScriptFieldsPerf\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 0,\n"
                + "  \"scenes\": [ { \"name\": \"100x100\", \"file\": \"scene_0.json\", \"width\": 100, \"height\": 100 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [ { \"name\": \"main\", \"file\": \"scripts/main.js\", \"lang\": \"js\" } ],\n"
                + "  \"jsMain\": \"main\"\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);

        StringBuilder scene = new StringBuilder(600000);
        scene.append("{\n  \"width\": 100, \"height\": 100, \"tileSize\": 32,\n");
        scene.append("  \"layers\": [],\n  \"objects\": [\n");
        boolean first = true;
        // 60x60 草地 = 3600 格，多个点火点铺开，形成大规模同时燃烧
        for (int cy = 20; cy < 80; cy++) {
            for (int cx = 20; cx < 80; cx++) {
                first = obj(scene, first, "g" + cx + "_" + cy, "TILE", "grass", cx, cy,
                        " \"assetName\": \"grass\"");
            }
        }
        scene.append("\n  ]\n}\n");
        write(new File(build, "scene_0.json"), scene.toString());

        write(new File(scripts, "main.js"), String.join("\n",
                "function onSceneStart(ctx) {",
                "  for (var x = 25; x <= 74; x += 10) {",
                "    for (var y = 25; y <= 74; y += 10) {",
                "      bwe.field.emit(\"fire\", x, y, 1.0);",
                "    }",
                "  }",
                "}",
                ""));
    }

    /** 验收场景脚本：只做「玩家会做的事」，不写死蔓延细节。 */
    private static final String SCENARIO_JS = String.join("\n",
            "var igniteEvents = 0;",
            "var burnedEvents = 0;",
            "var extinguishEvents = 0;",
            "",
            "function onSceneStart(ctx) {",
            "  bwe.log(\"FIELDS api.material=\" + [typeof bwe.material.define, typeof bwe.material.get,",
            "    typeof bwe.material.tags, typeof bwe.material.of, typeof bwe.material.setTile,",
            "    typeof bwe.material.ofEntity, typeof bwe.material.setEntity].join(\",\"));",
            "  bwe.log(\"FIELDS api.field=\" + [typeof bwe.field.emit, typeof bwe.field.sample,",
            "    typeof bwe.field.clear, typeof bwe.field.tickRate, typeof bwe.field.channel,",
            "    typeof bwe.field.wind, typeof bwe.field.on, typeof bwe.field.burning].join(\",\"));",
            "  bwe.log(\"FIELDS tickRate=\" + bwe.field.tickRate());",
            "",
            "  bwe.material.define(\"lava\", {",
            "    flammable: 0.2, burnTime: 8, conductive: false, wet: false,",
            "    hardness: 2, density: 2, tags: [\"hot\", \"liquid\"]",
            "  });",
            "  var lava = bwe.material.get(\"lava\");",
            "  bwe.log(\"FIELDS mat.custom=\" + lava.flammable);",
            "  bwe.log(\"FIELDS mat.tags=\" + bwe.material.tags(\"lava\").join(\"|\"));",
            "  var stone = bwe.material.get(\"stone\");",
            "  bwe.log(\"FIELDS mat.stone=\" + stone.flammable + \",\" + stone.hardness);",
            "  var grass = bwe.material.get(\"grass\");",
            "  bwe.log(\"FIELDS mat.grass=\" + grass.flammable);",
            "  bwe.log(\"FIELDS mat.grassTags=\" + bwe.material.tags(\"grass\").join(\"|\"));",
            "",
            "  bwe.field.channel(\"poison\").max(2);",
            "  bwe.field.emit(\"poison\", 3, 3, 1.5);",
            "  bwe.log(\"FIELDS ch.poison=\" + bwe.field.sample(\"poison\", 3, 3));",
            "  bwe.field.clear(\"poison\");",
            "  bwe.log(\"FIELDS ch.clear=\" + bwe.field.sample(\"poison\", 3, 3));",
            "",
            "  var w = bwe.field.wind(0.3, -0.2);",
            "  bwe.log(\"FIELDS wind=\" + w.x + \",\" + w.y);",
            "",
            "  var prop = bwe.world.find(\"crate_prop\");",
            "  bwe.log(\"FIELDS mat.ofEntity=\" + bwe.material.ofEntity(prop));",
            "  bwe.material.setEntity(prop, \"cloth\");",
            "  bwe.log(\"FIELDS mat.setEntity=\" + bwe.material.ofEntity(prop));",
            "  bwe.material.setEntity(prop, \"wood\");",
            "",
            "  bwe.material.setTile(4, 4, \"water\");",
            "  bwe.field.emit(\"water\", 4, 4, 1);",
            "  bwe.log(\"FIELDS mat.water=\" + bwe.material.of(4, 4));",
            "",
            "  bwe.field.on(\"ignite\", function (info) { igniteEvents++; });",
            "  bwe.field.on(\"burned\", function (info) { burnedEvents++; });",
            "  bwe.field.on(\"extinguish\", function (info) { extinguishEvents++; });",
            "",
            "  bwe.field.emit(\"fire\", 6, 6, 1.0);",
            "}",
            "",
            "bwe.on(\"update\", function (dt) {",
            "  var f = bwe.time.frame;",
            "  if (f === 6) {",
            "    bwe.field.emit(\"fire\", 7, 5, 1.0);",
            "  }",
            "  if (f === 7) {",
            "    bwe.log(\"FIELDS douse.fire=\" + bwe.field.sample(\"fire\", 7, 5));",
            "    bwe.field.emit(\"water\", 7, 5, 1);",
            "  }",
            "  if (f === 12) {",
            "    bwe.log(\"FIELDS ev.ignite=\" + igniteEvents);",
            "    bwe.log(\"FIELDS field.burning=\" + (bwe.field.burning().length > 0 ? 1 : 0));",
            "  }",
            "  if (f === 31) {",
            "    bwe.log(\"FIELDS ev.ignite2=\" + igniteEvents);",
            "    bwe.log(\"FIELDS ev.burned=\" + burnedEvents);",
            "    bwe.log(\"FIELDS ev.extinguish=\" + extinguishEvents);",
            "  }",
            "});",
            "");

    // ---------------- 文件工具 ----------------

    private static void write(File f, String content) throws Exception {
        if (f.getParentFile() != null) {
            Files.createDirectories(f.getParentFile().toPath());
        }
        Files.write(f.toPath(), content.getBytes(StandardCharsets.UTF_8));
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) {
            return;
        }
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) {
                deleteRecursively(c);
            }
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static List<String> readLog(File dir) throws Exception {
        List<String> out = new ArrayList<String>();
        File log = new File(dir, "Build/bwe.log");
        if (!log.isFile()) {
            return out;
        }
        for (String line : Files.readAllLines(log.toPath(), StandardCharsets.UTF_8)) {
            out.add(line);
        }
        return out;
    }

    private static String logValue(List<String> log, String prefix) {
        for (String line : log) {
            int i = line.indexOf(prefix);
            if (i >= 0) {
                return line.substring(i + prefix.length()).trim();
            }
        }
        return null;
    }

    private static double parse(String s, double def) {
        if (s == null) {
            return def;
        }
        try {
            return Double.parseDouble(s.trim());
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static double parseHead(String s, double def) {
        if (s == null) {
            return def;
        }
        int comma = s.indexOf(',');
        return parse(comma >= 0 ? s.substring(0, comma) : s, def);
    }

    private static boolean approx(double a, double b, double eps) {
        return Math.abs(a - b) <= eps;
    }

    private static String fmt(double v) {
        return String.format(java.util.Locale.ROOT, "%.3f", v);
    }

    private static TopDownRuntime.Actor actorNamed(TopDownRuntime rt, String name) {
        for (TopDownRuntime.Actor a : rt.actors) {
            if (a.o != null && name.equals(a.o.name)) {
                return a;
            }
        }
        return null;
    }

    // ---------------- 断言 ----------------

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }
}
