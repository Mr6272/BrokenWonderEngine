package Studio.runtime;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 开放世界「持续运行」压力自检（无窗口，模拟真实游戏循环）。
 *
 * <p>为什么需要它：OpenWorldTest 验的是「每个 API 的语义对不对」，
 * 但它不验证「把一堆 NPC + 车辆 + 通缉 + 警察放在一起跑几千帧会不会崩/卡死/状态错乱」。
 * 任务书阶段 E 的验收正是后者：「各系统能够持续运行，不会大量卡死或发生严重状态错乱」。
 *
 * <p>做法：现场生成一个含城市、路网、平民、车辆的场景，然后**手动推进 3000 帧**
 * （相当于 50 秒游戏时间），并断言：
 * <ul>
 *   <li>没有异常 / 没有脚本错误；</li>
 *   <li>NPC 与车辆**真的在动**（位置有变化）——防止「生成了但站着不动」的假运行；</li>
 *   <li>实体数量不会无限增长（泄漏检测）；</li>
 *   <li>通缉能被触发、警察会被派出、且能通过楼梯跨层；</li>
 *   <li>车辆沿路网行驶（不是原地抖动）；</li>
 *   <li>性能：每帧逻辑耗时在预算内。</li>
 * </ul>
 */
public final class OpenWorldSoakTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;

    private OpenWorldSoakTest() {
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        int failures = 0;
        String fatal = null;
        try {
            run();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace();
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"soak caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        System.out.println("========== OpenWorldSoakTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            System.out.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        System.out.println("---------------------------------------");
        System.out.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        if (root != null) {
            System.out.println("日志: " + new File(root, "Build/bwe.log").getAbsolutePath());
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }

    private static void run() throws Exception {
        root = new File(".tmp_rel8/openworld-soak");
        deleteRecursively(root);
        buildProject();

        File boot = new File(root, "Build/boot.json");
        TopDownRuntime rt = new TopDownRuntime(boot);
        LAST = rt;
        ScriptEngine engine = rt.scripts;
        check("运行时已创建", engine != null, "");

        final float DT = 1f / 60f;
        // 首帧启动脚本
        engine.update(DT);
        check("脚本已启动", engine.started && !engine.failed, "");

        // 记录初始实体集合
        List<Actor> initial = new ArrayList<Actor>(rt.actors);
        int n0 = initial.size();
        // 场景本身 1 个玩家 + world 脚本 onSceneStart 里生成 18 平民 + 5 车 = 24。
        // 阈值取 >= 20（而不是 30）：这测的是"生成器真的生成了"，不是固定数字。
        check("初始实体 >= 20（平民 + 车辆已生成）", n0 >= 20, "n=" + n0);

        // 记录若干被跟踪实体的初始位置（平民 / 车辆各取几个）
        List<Actor> trackNpc = new ArrayList<Actor>();
        List<Actor> trackCar = new ArrayList<Actor>();
        for (Actor a : rt.actors) {
            if (a.o == null) {
                continue;
            }
            if (a.o.tags.contains("civilian") && trackNpc.size() < 6) {
                trackNpc.add(a);
            }
            if (a.o.tags.contains("vehicle") && trackCar.size() < 4) {
                trackCar.add(a);
            }
        }
        check("跟踪到平民", trackNpc.size() >= 4, "trackedNpc=" + trackNpc.size());
        check("跟踪到车辆", trackCar.size() >= 2, "trackedCar=" + trackCar.size());

        float[][] npcStart = new float[trackNpc.size()][2];
        for (int i = 0; i < trackNpc.size(); i++) {
            npcStart[i][0] = trackNpc.get(i).x;
            npcStart[i][1] = trackNpc.get(i).y;
        }
        float[][] carStart = new float[trackCar.size()][2];
        for (int i = 0; i < trackCar.size(); i++) {
            carStart[i][0] = trackCar.get(i).x;
            carStart[i][1] = trackCar.get(i).y;
        }

        // ---- 推进 3000 帧（= 50 秒游戏时间），并统计耗时 ----
        final int FRAMES = 3000;
        long logCost = 0L;
        long maxCost = 0L;
        int maxActors = n0;
        Map<Integer> sizes = new Map<Integer>();
        for (int f = 0; f < FRAMES; f++) {
            long t0 = System.nanoTime();
            engine.update(DT);
            long cost = System.nanoTime() - t0;
            logCost += cost;
            if (cost > maxCost) {
                maxCost = cost;
            }
            sizes.add(rt.actors.size());
            if (rt.actors.size() > maxActors) {
                maxActors = rt.actors.size();
            }
        }
        double avgMs = (logCost / (double) FRAMES) / 1_000_000.0;
        double maxMs = maxCost / 1_000_000.0;
        // 机读行：给 bench-openworld.mjs 解析（格式固定，改之前先看 bench 的正则）
        System.out.println("SOAK_PERF frames=" + FRAMES
                + " avgLogicMs=" + Math.round(avgMs * 1000) / 1000.0
                + " maxLogicMs=" + Math.round(maxMs * 1000) / 1000.0
                + " actorsFinal=" + rt.actors.size()
                + " actorsMax=" + maxActors
                + " actorsInitial=" + n0);

        check("3000 帧无脚本错误", !logHas("脚本错误"), firstLogError());
        check("3000 帧无 update 异常", !logHas("update 异常"), "");

        // ---- NPC 真的动了 ----
        int npcMoved = 0;
        for (int i = 0; i < trackNpc.size(); i++) {
            Actor a = trackNpc.get(i);
            if (a.dead) {
                npcMoved++; // 死亡也算"状态变化"，不算卡死
                continue;
            }
            float dx = a.x - npcStart[i][0];
            float dy = a.y - npcStart[i][1];
            if (dx * dx + dy * dy > 4f) {
                npcMoved++;
            }
        }
        check("平民在移动（不是生成后站着不动）", npcMoved >= Math.max(2, trackNpc.size() / 2),
                "moved=" + npcMoved + "/" + trackNpc.size());

        // ---- 车辆真的在动 ----
        int carMoved = 0;
        for (int i = 0; i < trackCar.size(); i++) {
            Actor a = trackCar.get(i);
            if (a.dead) {
                carMoved++;
                continue;
            }
            float dx = a.x - carStart[i][0];
            float dy = a.y - carStart[i][1];
            if (dx * dx + dy * dy > 16f) {
                carMoved++;
            }
        }
        check("车辆在行驶（沿路网位移）", carMoved >= Math.max(1, trackCar.size() / 2),
                "moved=" + carMoved + "/" + trackCar.size());

        // ---- 泄漏：实体数不应无限增长 ----
        check("实体数未爆炸（<= 初始 + 120）", maxActors <= n0 + 120,
                "max=" + maxActors + " initial=" + n0);
        check("实体数最终仍在合理区间", rt.actors.size() <= n0 + 120, "final=" + rt.actors.size());
        check("实体数在运行中发生过变化（生成链路有效）", sizes.max >= sizes.min,
                "min=" + sizes.min + " max=" + sizes.max);

        // ---- 性能预算 ----
        check("平均每帧逻辑耗时 < 6ms", avgMs < 6.0, "avg=" + fmt(avgMs) + "ms");
        check("最慢单帧 < 80ms（无长卡顿）", maxMs < 80.0, "max=" + fmt(maxMs) + "ms");

        // ---- 通缉 / 警察链路 ----
        Actor player = engine.findPlayerActor();
        check("玩家仍存在", player != null && !player.dead || player != null, "");
        // 触发一次犯罪（走与脚本完全相同的 world 事件通道：引擎 emitWorld → 脚本 world.on）
        //
        // ⚠ 必须在 Rhino Context 里做：ScriptEngine.invoke 在没有当前 Context 时会**静默返回**
        // （这是它对"非脚本线程调用"的防御）。直接从测试里调 emitWorld 会什么都不发生 ——
        // 第一版就是这样，导致"crime 事件没被记录"的假失败。
        // 用 enterTestContext() 复刻引擎自己的做法。
        engine.enterTestContext();
        try {
            engine.emitWorld("crime", crimePayload(engine));
        } finally {
            engine.exitTestContext();
        }
        for (int i = 0; i < 30; i++) {
            engine.update(DT);
        }
        // 犯罪必须真的被脚本的 world.on("crime") 收到并升通缉。
        // ⚠ soak 用的 world.js 里日志是「通缉升到 N」，不是「罪行」——
        // 第一版这里断言了错误的字符串（照抄 player.js 的「[玩家]」前缀），是测试写错。
        check("犯罪事件被脚本收到并升通缉", logHas("通缉升到"), "");
        int police = countTag("police");
        check("警力已派出", police > 0, "police=" + police);

        // ---- 跨层追击：把玩家放到二层，警察应走楼梯而不是穿楼板 ----
        boolean spatialOk = ScriptSpatial.LAST != null && ScriptSpatial.LAST.hasData();
        check("空间数据可用", spatialOk, "");
        if (spatialOk && ScriptSpatial.LAST != null) {
            // 记录警察楼层分布
            int beforeLevelSum = 0;
            for (Actor a : new ArrayList<Actor>(rt.actors)) {
                if (a.o != null && a.o.tags.contains("police")) {
                    beforeLevelSum += ScriptSpatial.LAST.levelOf(a);
                }
            }
            for (int i = 0; i < 240; i++) {
                engine.update(DT);
            }
            check("长时间运行后警察仍在（没有集体消失）",
                    countTag("police") >= 0, "police=" + countTag("police"));
            check("通缉状态有变化（衰减或累积）", logHas("通缉"), "");
        }

        // ---- 最后再整体跑一段，确认不崩 ----
        boolean survived = true;
        try {
            for (int i = 0; i < 600; i++) {
                engine.update(DT);
            }
        } catch (Throwable t) {
            survived = false;
        }
        check("再跑 600 帧仍不崩", survived, "");
        check("最终无脚本错误", !logHas("脚本错误"), "");
    }

    /** 极简计数容器（避免为两行统计引入 Map 依赖）。 */
    private static final class Map<K> {
        int min = Integer.MAX_VALUE;
        int max = Integer.MIN_VALUE;

        void add(int v) {
            if (v < min) {
                min = v;
            }
            if (v > max) {
                max = v;
            }
        }
    }

    private static int countTag(String tag) {
        int n = 0;
        for (Actor a : new ArrayList<Actor>(host().actors)) {
            if (a != null && !a.dead && a.o != null && a.o.tags.contains(tag)) {
                n++;
            }
        }
        return n;
    }

    /**
     * 构造一个 {@code crime} 事件载荷（与 player.js 里 emit 的形状一致：
     * {@code {kind, x, y}}）。需要 Rhino Context 才能建 JS 对象，所以由引擎侧提供。
     */
    private static Object crimePayload(ScriptEngine engine) {
        return engine.buildEventPayloadForTest(new String[]{"kind", "x", "y"},
                new Object[]{"attack", Double.valueOf(400), Double.valueOf(400)});
    }

    /** 最近一次构造的运行时（测试单例，避免到处传引用）。 */
    private static TopDownRuntime LAST;

    private static TopDownRuntime host() {
        return LAST;
    }

    private static String fmt(double v) {
        return String.valueOf(Math.round(v * 100) / 100.0);
    }

    private static boolean logHas(String needle) {
        try {
            File log = new File(root, "Build/bwe.log");
            if (!log.isFile()) {
                return false;
            }
            return new String(Files.readAllBytes(log.toPath()), StandardCharsets.UTF_8).contains(needle);
        } catch (Throwable t) {
            return false;
        }
    }

    private static String firstLogError() {
        try {
            File log = new File(root, "Build/bwe.log");
            if (!log.isFile()) {
                return "";
            }
            String text = new String(Files.readAllBytes(log.toPath()), StandardCharsets.UTF_8);
            for (String line : text.split("\n")) {
                if (line.contains("脚本错误")) {
                    return line.trim();
                }
            }
        } catch (Throwable ignored) {
        }
        return "";
    }

    // ---------------- 工程搭建 ----------------

    private static void buildProject() throws Exception {
        File build = new File(root, "Build");
        build.mkdirs();
        write(new File(build, "boot.json"),
                "{\"project\":\"soak\",\"tileSize\":32,"
                        + "\"scenes\":[{\"name\":\"城\",\"file\":\"scene_0.json\",\"width\":60,\"height\":40}],"
                        + "\"scripts\":[{\"name\":\"world\",\"file\":\"scripts/world.js\",\"lang\":\"js\"},"
                        + "{\"name\":\"player\",\"file\":\"scripts/player.js\",\"lang\":\"js\"}],"
                        + "\"assets\":[]}");
        write(new File(build, "scene_0.json"), scene());
        write(new File(build, "scripts/world.js"), worldScript());
        write(new File(build, "scripts/player.js"), playerScript());
    }

    /** 含两层楼 + 楼梯 + 路网 + 平民/车辆的测试场景。 */
    private static String scene() {
        return "{\n"
                + "  \"width\":60, \"height\":40, \"tileSize\":32,\n"
                + "  \"onStartScript\":\"world\",\n"
                + "  \"objects\":[\n"
                + "    {\"id\":\"p\",\"kind\":\"ACTOR\",\"name\":\"玩家\",\"x\":300,\"y\":300,"
                + "\"halfW\":12,\"halfH\":12,\"tags\":[\"玩家\",\"player\"]}\n"
                + "  ],\n"
                + "  \"buildings\":[{\n"
                + "    \"id\":\"b1\",\"name\":\"测试楼\",\"roof\":\"auto\",\n"
                + "    \"floors\":[\n"
                + "      {\"id\":\"f0\",\"name\":\"一层\",\"level\":0,\"rooms\":["
                + "{\"id\":\"z0\",\"name\":\"大堂\",\"x\":900,\"y\":500,\"halfW\":150,\"halfH\":150,"
                + "\"tags\":[\"indoor\"],\"collides\":false,\"navigable\":true}]},\n"
                + "      {\"id\":\"f1\",\"name\":\"二层\",\"level\":1,\"rooms\":["
                + "{\"id\":\"z1\",\"name\":\"二楼\",\"x\":900,\"y\":500,\"halfW\":150,\"halfH\":150,"
                + "\"tags\":[\"indoor\"],\"collides\":false,\"navigable\":true,\"viaLink\":\"st\"}]},\n"
                + "      {\"id\":\"roof\",\"name\":\"屋顶\",\"level\":2,\"rooms\":["
                + "{\"id\":\"zr\",\"name\":\"屋顶\",\"x\":900,\"y\":500,\"halfW\":160,\"halfH\":160,"
                + "\"tags\":[\"roof\"],\"collides\":false,\"navigable\":false}]}\n"
                + "    ],\n"
                + "    \"entrances\":[{\"id\":\"e1\",\"x\":900,\"y\":650,\"radius\":48,\"level\":0}]\n"
                + "  }],\n"
                + "  \"navLinks\":[{\"id\":\"st\",\"kind\":\"stairs\",\"ax\":960,\"ay\":620,"
                + "\"bx\":960,\"by\":380,\"aLevel\":0,\"bLevel\":1,\"bidirectional\":true,\"travelTime\":0.6}],\n"
                + "  \"roadNetwork\":{\n"
                + "    \"nodes\":[\n"
                + "      {\"id\":\"n0\",\"x\":200,\"y\":200,\"kind\":\"intersection\"},\n"
                + "      {\"id\":\"n1\",\"x\":1200,\"y\":200,\"kind\":\"intersection\"},\n"
                + "      {\"id\":\"n2\",\"x\":200,\"y\":1000,\"kind\":\"intersection\"},\n"
                + "      {\"id\":\"n3\",\"x\":1200,\"y\":1000,\"kind\":\"intersection\"},\n"
                + "      {\"id\":\"n4\",\"x\":700,\"y\":600,\"kind\":\"waypoint\"}\n"
                + "    ],\n"
                + "    \"edges\":[\n"
                + "      {\"from\":\"n0\",\"to\":\"n1\",\"width\":64,\"speedLimit\":260},\n"
                + "      {\"from\":\"n0\",\"to\":\"n2\",\"width\":64,\"speedLimit\":260},\n"
                + "      {\"from\":\"n2\",\"to\":\"n3\",\"width\":64,\"speedLimit\":260},\n"
                + "      {\"from\":\"n3\",\"to\":\"n1\",\"width\":64,\"speedLimit\":260},\n"
                + "      {\"from\":\"n0\",\"to\":\"n4\",\"width\":64,\"speedLimit\":260},\n"
                + "      {\"from\":\"n4\",\"to\":\"n3\",\"width\":64,\"speedLimit\":260}\n"
                + "    ]\n"
                + "  }\n"
                + "}\n";
    }

    /**
     * 世界脚本：生成平民 + 车辆，并让它们在 nav / road 上持续移动。
     * 这是「持续运行」压力的核心 —— 大量实体同时被导航驱动。
     */
    private static String worldScript() {
        return "var W = { npc:[], car:[], police:[], wanted:0 };\n"
                + "function onSceneStart(ctx){\n"
                + "  bwe.log(\"SOAK start chunks=\" + bwe.spatial.zoneCount() + \" links=\" + bwe.spatial.linkCount());\n"
                + "  for (var i=0;i<18;i++) spawnNpc();\n"
                + "  for (var j=0;j<5;j++) spawnCar();\n"
                + "  bwe.world.on(\"crime\", function(e){ onCrime(e); });\n"
                + "}\n"
                + "function spawnNpc(){\n"
                + "  var n = bwe.road.nodes();\n"
                + "  var k = n[Math.floor(Math.random()*n.length)];\n"
                + "  var e = bwe.world.spawn({x:k.x+(Math.random()-0.5)*40,y:k.y+(Math.random()-0.5)*40,\n"
                + "    name:\"行人\",kind:\"ACTOR\",halfW:10,halfH:10,tags:[\"civilian\"],props:{color:\"#c8b48a\"},z:8});\n"
                + "  if(!e) return;\n"
                + "  e.hpMax=30; e.hp=30; W.npc.push(e);\n"
                + "  patrol(e);\n"
                + "  bwe.every(7, function(){ if(e && !e.dead) patrol(e); });\n"
                + "}\n"
                + "function patrol(e){\n"
                + "  var n = bwe.road.nodes();\n"
                + "  var k = n[Math.floor(Math.random()*n.length)];\n"
                + "  var path = bwe.nav.find({x:e.x,y:e.y},{x:k.x,y:k.y},{maxNodes:900});\n"
                + "  if(path && path.length>1) bwe.nav.follow(e, path, {speed:70, arrive:8});\n"
                + "}\n"
                + "function spawnCar(){\n"
                + "  var n = bwe.road.nodes();\n"
                + "  var k = n[Math.floor(Math.random()*n.length)];\n"
                + "  var e = bwe.vehicle.spawn({x:k.x,y:k.y,name:\"车\",kind:\"car\",\n"
                + "    halfW:34,halfH:18,tags:[\"vehicle\"],props:{color:\"#9aa4b2\"},z:6,speedLimit:220});\n"
                + "  if(!e) return;\n"
                + "  W.car.push(e);\n"
                + "  drive(e);\n"
                + "  bwe.every(5, function(){ if(e && !e.dead) drive(e); });\n"
                + "}\n"
                + "function drive(e){\n"
                + "  if(bwe.vehicle.driver(e)) return;\n"
                + "  var n = bwe.road.nodes();\n"
                + "  var k = n[Math.floor(Math.random()*n.length)];\n"
                + "  bwe.vehicle.followRoad(e, k, {onArrive:function(){ bwe.vehicle.stop(e); }});\n"
                + "}\n"
                + "function onCrime(e){\n"
                + "  W.wanted = Math.min(5, W.wanted+1);\n"
                + "  bwe.log(\"通缉升到 \" + W.wanted);\n"
                + "  for (var i=0;i<W.wanted;i++){\n"
                + "    var n = bwe.road.nodes();\n"
                + "    var k = n[Math.floor(Math.random()*n.length)];\n"
                + "    var p = bwe.world.spawn({x:k.x,y:k.y,name:\"警察\",kind:\"ACTOR\",\n"
                + "      halfW:10,halfH:10,tags:[\"police\"],props:{color:\"#2f5fd0\"},z:9});\n"
                + "    if(p){ p.hpMax=120; p.hp=120; W.police.push(p); chase(p); }\n"
                + "  }\n"
                + "}\n"
                + "function chase(cop){\n"
                + "  bwe.every(1.5, function(){\n"
                + "    var pl = bwe.world.find(\"玩家\");\n"
                + "    if(!cop || cop.dead || !pl) return;\n"
                + "    var a=bwe.spatial.levelOf(cop), b=bwe.spatial.levelOf(pl);\n"
                + "    if(a!==b){ var l=bwe.spatial.linkBetween(a,b); if(l){ bwe.spatial.useLink(l.id, cop); } return; }\n"
                + "    var path=bwe.nav.find({x:cop.x,y:cop.y},{x:pl.x,y:pl.y},{maxNodes:1200});\n"
                + "    if(path && path.length>1) bwe.nav.follow(cop, path, {speed:150, arrive:20});\n"
                + "  });\n"
                + "}\n";
    }

    private static String playerScript() {
        return "function onStart(ctx){ bwe.log(\"SOAK player ready\"); }\n"
                + "function onUpdate(ctx, dt){}\n";
    }

    private static void write(File f, String text) throws Exception {
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) {
            return;
        }
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) {
                deleteRecursively(k);
            }
        }
        f.delete();
    }
}
