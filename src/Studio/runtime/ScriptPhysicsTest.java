package Studio.runtime;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 物理桥接自检（无窗口、纯断言），对应 {@code docs/scripting-api.md} §2.11.5 + §2.11.7 第 5 条。
 *
 * <p>流程：
 * <ol>
 *   <li>现场生成一个 20×15 的项目到 {@code .tmp_rel8/phys/proj/}：1 个玩家（不加刚体）、3 个木箱、
 *       1 个传感器、一列石墙（TILE，cx=8）；</li>
 *   <li>{@code new TopDownRuntime(boot)} → 逐帧 {@code scripts.update(1/60)}；脚本里驱动
 *       {@code bwe.physics.*}，把结果写进 {@code Build/bwe.log}；</li>
 *   <li>断言：默认关闭 → enable 后建世界；applyImpulse 位移 ≥20px 且触发 collision 回调；
 *       撞墙不穿；setPos 反向同步（teleport）；传感器回调；raycast/query/throwAt/remove；
 *       debug(true) 真的产生绘制指令；没刚体的实体位置不变；</li>
 *   <li>再生成一个 40×30 的项目到 {@code .tmp_rel8/phys/perf/}：脚本 spawn 200 个动态箱并给初速度，
 *       统计 {@code World.step} 的平均耗时（要求 &lt; 1ms）。</li>
 * </ol>
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class ScriptPhysicsTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;
    private static String perfSummary = "";

    private ScriptPhysicsTest() {
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        PrintStream realOut = System.out;
        PrintStream realErr = System.err;
        ByteArrayOutputStream outBuf = new ByteArrayOutputStream();
        ByteArrayOutputStream errBuf = new ByteArrayOutputStream();
        System.setOut(new PrintStream(outBuf, true));
        System.setErr(new PrintStream(errBuf, true));

        int failures = 0;
        String fatal = null;
        try {
            run();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace(realOut);
        } finally {
            System.setOut(realOut);
            System.setErr(realErr);
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"physicstest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptPhysicsTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        if (!perfSummary.isEmpty()) {
            realOut.println(perfSummary);
        }
        realOut.println("---------------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        if (failures != 0) {
            String err = new String(errBuf.toByteArray(), StandardCharsets.UTF_8).trim();
            if (!err.isEmpty()) {
                realOut.println("---- stderr（最后 20 行）----");
                String[] lines = err.split("\\R");
                int from = Math.max(0, lines.length - 20);
                for (int i = from; i < lines.length; i++) {
                    realOut.println(lines[i]);
                }
            }
            realOut.println("---- stdout（最后 20 行）----");
            String[] lines = new String(outBuf.toByteArray(), StandardCharsets.UTF_8).trim().split("\\R");
            int from = Math.max(0, lines.length - 20);
            for (int i = from; i < lines.length; i++) {
                realOut.println(lines[i]);
            }
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- 主流程 ----------------

    private static void run() throws Exception {
        functional();
        performance();
    }

    private static void functional() throws Exception {
        root = new File(".tmp_rel8/phys/proj");
        deleteRecursively(root);
        buildFunctionalProject();

        File boot = new File(root, "Build/boot.json");
        check("boot.json 已生成", boot.isFile(), boot.getAbsolutePath());

        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        check("ScriptEngine 已创建", engine != null, "");
        check("构造期不建物理世界（默认关闭）", ScriptPhysics.LAST == null
                || ScriptPhysics.LAST.bodyCount() == 0, "");

        // 第 1 帧：脚本 onSceneStart 里 enable + 建刚体 + applyImpulse。
        engine.update(1f / 60f);
        check("第 1 帧后脚本启动", engine.started && !engine.failed, "");

        TopDownRuntime.Actor player = actorNamed(rt, "player");
        TopDownRuntime.Actor crate = actorNamed(rt, "crate");
        check("找到 player/crate", player != null && crate != null, "");
        float startX = crate == null ? 0f : crate.x;
        float startPlayerX = player == null ? 0f : player.x;
        float startPlayerY = player == null ? 0f : player.y;

        int debugOnCmds = -1;
        int debugOffCmds = -1;
        for (int f = 2; f <= 130; f++) {
            engine.update(1f / 60f);
            // 脚本第 80 帧打开 debug，物理 hook 同帧就该写入绘制指令；第 82 帧关掉。
            if (f == 80) {
                debugOnCmds = engine.drawCmds.size();
            }
            if (f == 83) {
                debugOffCmds = engine.drawCmds.size();
            }
        }
        check("引擎未进入失败态", !engine.failed, "");

        List<String> log = readLog(new File(root, "Build/bwe.log"));

        // 1) 默认关闭
        expectLog("默认关闭：body() 返回 null", log, "PHYS.off.body=null");
        expectLog("默认关闭：enabled()=false", log, "PHYS.off.enabled=0");
        expectLog("默认关闭：没有任何刚体", log, "PHYS.off.bodyCount=0");

        // 2) enable
        expectLog("enable() 返回 true", log, "PHYS.enable=1");
        expectLog("enable 后 enabled()=true", log, "PHYS.enabledAfter=1");
        expectLog("俯视角默认重力 0", log, "PHYS.gravity0=0");
        int tileBodies = intAfter(log, "PHYS.tileBodies=");
        check("tilemap 实体格自动建静态墙", tileBodies >= 19, "tileBodies=" + tileBodies);

        // 3) 刚体 + 冲量
        expectLog("body(e,opts) 返回同一个 Entity", log, "PHYS.body=1");
        expectLog("bodyCount=1", log, "PHYS.bodyCount2=1");
        expectLog("applyImpulse 后速度 = 400px/s", log, "PHYS.velAfterImpulse=400.0,0.0");

        // 4) 射线/查询
        expectLog("queryPoint 命中木箱", log, "PHYS.queryPoint=1:1");
        int aabbHits = intAfter(log, "PHYS.queryAABB=1:");
        check("queryAABB 命中木箱", aabbHits >= 1, "hits=" + aabbHits);
        expectLog("raycast 命中木箱（entity 是实体）", log, "PHYS.ray.crate hit=1 self=1");
        expectLog("raycast 命中墙（entity=null）", log, "PHYS.ray.wall hit=1 entity=null x=256");

        // 5) 抛 / 速度 / 移除
        expectLog("setVelocity 成功", log, "PHYS.setVel=1");
        expectLog("throwAt 成功", log, "PHYS.throwAt=1");
        expectLog("throwAt 朝目标 200px/s", log, "PHYS.throwVel=200.0,0.0");
        expectLog("remove 后 applyImpulse 返回 false", log, "PHYS.remove=1");
        expectLog("remove 后 bodyCount=3", log, "PHYS.bodyCount3=3");

        // 6) 碰撞回调（触墙 + 传感器）
        //    注意 a/b 的先后取决于 fixture 创建顺序，断言只看「两边分别是木箱和墙」。
        int crateWallEvents = countCollisionPair(log, "crate", "wall");
        check("collision 回调触发（木箱撞墙）", crateWallEvents >= 1,
                "crate-wall 事件数=" + crateWallEvents);
        check("collision 回调带正冲量", maxImpulse(log) > 0f, "impulse=" + maxImpulse(log));
        check("collision 回调触发（传感器）", countContaining(log, "PHYS.collisionEvent") >= 2,
                "事件数=" + countContaining(log, "PHYS.collisionEvent"));
        expectLog("传感器事件标记 sensor=1", log, "sensor=1");
        int hits = intAfter(log, "PHYS.hits=");
        check("脚本侧统计到的碰撞次数 ≥ 2", hits >= 2, "hits=" + hits);
        int sensorHits = intAfter(log, "PHYS.sensorHits=");
        check("脚本侧统计到的传感器碰撞 ≥ 1", sensorHits >= 1, "sensorHits=" + sensorHits);

        // 7) 位移与撞墙（§2.11.7 第 5 条：位移 ≥20px）
        float moved = crate == null ? 0f : crate.x - startX;
        check("applyImpulse 位移 ≥ 20px", moved >= 20f, "moved=" + moved);
        // 第 60 帧（撞墙后、teleport 之前）的位置来自脚本日志。
        float wallStopX = floatAfter(log, "PHYS.crateX=");
        check("撞墙不穿：木箱停在墙左侧", wallStopX >= 225f && wallStopX <= 250f,
                "crateX@60=" + wallStopX);
        check("撞墙后基本静止", Math.abs(speedOf(log)) < 5f, "vx=" + speedOf(log));

        // 8) setPos 反向同步（teleport）
        expectLog("脚本 setPos 后位置=400,96（不被物理拉回）", log, "PHYS.teleport=400.0,96.0");
        expectLog("teleport 后 queryAABB 命中", log, "PHYS.queryAfterTeleport=1");
        check("Actor 保持在脚本设定的位置", crate != null && Math.abs(crate.x - 400f) < 3f
                && Math.abs(crate.y - 96f) < 3f, "crate=" + (crate == null ? "?" : crate.x + "," + crate.y));

        // 9) 没有刚体的实体完全不受影响
        check("无刚体实体位置不变", player != null && player.x == startPlayerX && player.y == startPlayerY,
                "player=" + (player == null ? "?" : player.x + "," + player.y));

        // 10) debug(true) 真的画碰撞体
        check("debug(true) 产生碰撞体绘制指令", debugOnCmds > 0, "cmds=" + debugOnCmds);
        check("debug(false) 不再绘制", debugOffCmds == 0, "cmds=" + debugOffCmds);

        expectLog("脚本跑到收尾", log, "PHYS.done=1");
        check("无物理错误日志", !contains(log, "collision 回调异常")
                && !contains(log, "未 enable()"), "");
    }

    private static void performance() throws Exception {
        File perfRoot = new File(".tmp_rel8/phys/perf");
        deleteRecursively(perfRoot);
        buildPerfProject(perfRoot);
        File boot = new File(perfRoot, "Build/boot.json");

        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        engine.update(1f / 60f);
        check("perf：脚本启动", engine.started && !engine.failed, "");

        List<String> log = readLog(new File(perfRoot, "Build/bwe.log"));
        expectLog("perf：200 个动态刚体已建立", log, "PERF.bodies=200:200");

        // 预热 60 帧（碰撞求解器建立接触缓存），再统计 300 帧。
        for (int f = 0; f < 60; f++) {
            engine.update(1f / 60f);
        }
        long sum = 0L;
        long max = 0L;
        int samples = 300;
        for (int f = 0; f < samples; f++) {
            engine.update(1f / 60f);
            long ns = ScriptPhysics.lastStepNanos;
            sum += ns;
            if (ns > max) {
                max = ns;
            }
        }
        double avgMs = (sum / (double) samples) / 1_000_000.0;
        double maxMs = max / 1_000_000.0;
        int bodyCount = ScriptPhysics.lastBodyCount;
        int tileCount = ScriptPhysics.lastTileBodyCount;
        double tickMs = ScriptPhysics.lastTickNanos / 1_000_000.0;
        check("perf：刚体数 = 200", bodyCount == 200, "bodies=" + bodyCount);
        check("perf：世界步进平均 < 1ms", avgMs < 1.0,
                String.format("avg=%.3fms max=%.3fms", avgMs, maxMs));
        System.out.println("PERF-WorldStep avg=" + String.format("%.3f", avgMs) + "ms"
                + " max=" + String.format("%.3f", maxMs) + "ms"
                + " bodies=" + bodyCount + " tileBodies=" + tileCount
                + " lastTick=" + String.format("%.3f", tickMs) + "ms");
        perfSummary = "性能：World.step 平均 " + String.format("%.3f", avgMs) + "ms / 最大 "
                + String.format("%.3f", maxMs) + "ms（" + bodyCount + " 动态刚体 + " + tileCount
                + " 瓦片墙，40×30 图）；单帧 tick 总耗时 " + String.format("%.3f", tickMs) + "ms";
        check("perf：单次 tick（同步+步进+写回）也 < 2ms", tickMs < 2.0,
                String.format("tick=%.3fms", tickMs));
    }

    // ---------------- 生成测试工程 ----------------

    private static void buildFunctionalProject() throws Exception {
        File build = new File(root, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());

        String boot = "{\n"
                + "  \"project\": \"ScriptPhysicsTest\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 1,\n"
                + "  \"scenes\": [ { \"name\": \"物理场景\", \"file\": \"scene_0.json\", \"width\": 20, \"height\": 15 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [ { \"name\": \"main\", \"file\": \"scripts/main.js\", \"lang\": \"js\" } ],\n"
                + "  \"jsMain\": \"main\"\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);

        StringBuilder scene = new StringBuilder();
        scene.append("{\n");
        scene.append("  \"width\": 20, \"height\": 15, \"tileSize\": 32,\n");
        scene.append("  \"layers\": [],\n");
        scene.append("  \"objects\": [\n");
        scene.append("    { \"id\": \"p1\", \"kind\": \"ACTOR\", \"name\": \"player\", \"x\": 64, \"y\": 64,")
                .append(" \"halfW\": 16, \"halfH\": 16, \"visible\": true, \"tags\": [\"玩家\"] },\n");
        scene.append("    { \"id\": \"c1\", \"kind\": \"PROP\", \"name\": \"crate\", \"x\": 160, \"y\": 96,")
                .append(" \"halfW\": 16, \"halfH\": 16, \"visible\": true },\n");
        scene.append("    { \"id\": \"c2\", \"kind\": \"PROP\", \"name\": \"crate2\", \"x\": 100, \"y\": 260,")
                .append(" \"halfW\": 12, \"halfH\": 12, \"visible\": true },\n");
        scene.append("    { \"id\": \"c3\", \"kind\": \"PROP\", \"name\": \"crate3\", \"x\": 400, \"y\": 400,")
                .append(" \"halfW\": 12, \"halfH\": 12, \"visible\": true },\n");
        scene.append("    { \"id\": \"s1\", \"kind\": \"PROP\", \"name\": \"sensor\", \"x\": 100, \"y\": 300,")
                .append(" \"halfW\": 8, \"halfH\": 8, \"visible\": false }");
        // 石墙：cx=8 整列（rows 0..14）→ 木箱从 x=160 向右撞上去必须停住。
        for (int row = 0; row <= 14; row++) {
            scene.append(",\n    { \"id\": \"w").append(row).append("\", \"kind\": \"TILE\", \"name\": \"wall")
                    .append(row).append("\", \"x\": ").append((8 + 0.5) * 32).append(", \"y\": ")
                    .append((row + 0.5) * 32).append(", \"visible\": true }");
        }
        scene.append("\n  ]\n}\n");
        write(new File(build, "scene_0.json"), scene.toString());

        write(new File(scripts, "main.js"), FUNCTIONAL_JS);
    }

    private static void buildPerfProject(File perfRoot) throws Exception {
        File build = new File(perfRoot, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());
        String boot = "{\n"
                + "  \"project\": \"ScriptPhysicsPerf\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 1,\n"
                + "  \"scenes\": [ { \"name\": \"性能场景\", \"file\": \"scene_0.json\", \"width\": 40, \"height\": 30 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [ { \"name\": \"main\", \"file\": \"scripts/main.js\", \"lang\": \"js\" } ],\n"
                + "  \"jsMain\": \"main\"\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);
        write(new File(build, "scene_0.json"),
                "{\n  \"width\": 40, \"height\": 30, \"tileSize\": 32,\n  \"layers\": [],\n"
                        + "  \"objects\": [ { \"id\": \"p1\", \"kind\": \"ACTOR\", \"name\": \"player\","
                        + " \"x\": 640, \"y\": 480, \"halfW\": 16, \"halfH\": 16, \"visible\": true } ]\n}\n");

        String js = String.join("\n",
                "function onSceneStart(ctx) {",
                "  bwe.physics.enable();",
                "  var made = 0;",
                "  for (var i = 0; i < 200; i++) {",
                "    var x = 80 + (i % 20) * 58;",
                "    var y = 80 + Math.floor(i / 20) * 80;",
                "    var e = bwe.world.spawn({ x: x, y: y, name: \"box\" + i, kind: \"PROP\", halfW: 14, halfH: 14 });",
                "    if (!e) { continue; }",
                "    bwe.physics.body(e, { type: \"dynamic\", shape: \"box\", halfW: 14, halfH: 14, density: 1 });",
                "    bwe.physics.setVelocity(e, ((i % 7) - 3) * 60, ((i % 5) - 2) * 60);",
                "    made++;",
                "  }",
                "  bwe.log(\"PERF.bodies=\" + made + \":\" + bwe.physics.bodyCount());",
                "}",
                "");
        write(new File(scripts, "main.js"), js);
    }

    // ---------------- 功能测试脚本 ----------------

    private static final String FUNCTIONAL_JS = String.join("\n",
            "var S = { hits: 0, sensorHits: 0, frame: 0, crate: null, player: null };",
            "",
            "function onSceneStart(ctx) {",
            "  S.crate = bwe.world.find(\"crate\");",
            "  S.player = bwe.world.find(\"player\");",
            "  var c2 = bwe.world.find(\"crate2\");",
            "  var c3 = bwe.world.find(\"crate3\");",
            "  var sensorEnt = bwe.world.find(\"sensor\");",
            "  bwe.on(\"update\", tick);",
            "",
            "  // 1) 默认关闭：enable() 之前 body() 不建刚体",
            "  bwe.log(\"PHYS.off.body=\" + (bwe.physics.body(S.crate, { type: \"dynamic\" }) === null ? \"null\" : \"obj\"));",
            "  bwe.log(\"PHYS.off.enabled=\" + (bwe.physics.enabled() === false ? \"0\" : \"1\"));",
            "  bwe.log(\"PHYS.off.bodyCount=\" + bwe.physics.bodyCount());",
            "",
            "  // 2) enable + 俯视角默认无重力",
            "  bwe.log(\"PHYS.enable=\" + (bwe.physics.enable() === true ? \"1\" : \"0\"));",
            "  bwe.log(\"PHYS.enabledAfter=\" + (bwe.physics.enabled() === true ? \"1\" : \"0\"));",
            "  bwe.log(\"PHYS.gravity0=\" + bwe.physics.gravity());",
            "  bwe.log(\"PHYS.tileBodies=\" + bwe.physics.tileBodyCount());",
            "",
            "  // 3) 碰撞回调",
            "  bwe.physics.on(\"collision\", function (ev) {",
            "    if (!ev) { return; }",
            "    S.hits++;",
            "    if (ev.sensor) { S.sensorHits++; }",
            "    var an = ev.a ? ev.a.name : \"wall\";",
            "    var bn = ev.b ? ev.b.name : \"wall\";",
            "    bwe.log(\"PHYS.collisionEvent a=\" + an + \" b=\" + bn + \" impulse=\" + ev.impulse",
            "            + \" sensor=\" + (ev.sensor ? 1 : 0));",
            "  });",
            "",
            "  // 4) 木箱刚体 + 冲量（32x32、density=1 → 质量 1kg，400px/s）",
            "  var r = bwe.physics.body(S.crate, { type: \"dynamic\", shape: \"box\", halfW: 16, halfH: 16,",
            "                               density: 1, friction: 0.2, restitution: 0 });",
            "  bwe.log(\"PHYS.body=\" + (r === S.crate ? \"1\" : \"0\"));",
            "  bwe.log(\"PHYS.bodyCount2=\" + bwe.physics.bodyCount());",
            "  bwe.physics.applyImpulse(S.crate, 400, 0);",
            "  var v = bwe.physics.velocity(S.crate);",
            "  bwe.log(\"PHYS.velAfterImpulse=\" + v.vx.toFixed(1) + \",\" + v.vy.toFixed(1));",
            "",
            "  // 5) 查询 / 射线",
            "  var qp = bwe.physics.queryPoint(S.crate.x, S.crate.y);",
            "  bwe.log(\"PHYS.queryPoint=\" + qp.length + \":\" + (qp.length > 0 && qp[0] === S.crate ? \"1\" : \"0\"));",
            "  var qa = bwe.physics.queryAABB(S.crate.x - 20, S.crate.y - 20, 40, 40);",
            "  bwe.log(\"PHYS.queryAABB=\" + (qa.length >= 1 ? \"1\" : \"0\") + \":\" + qa.length);",
            "  var r1 = bwe.physics.raycast(40, 96, 400, 96);",
            "  bwe.log(\"PHYS.ray.crate hit=\" + (r1.hit ? 1 : 0) + \" self=\" + (r1.entity === S.crate ? 1 : 0));",
            "  var r2 = bwe.physics.raycast(40, 208, 400, 208);",
            "  bwe.log(\"PHYS.ray.wall hit=\" + (r2.hit ? 1 : 0) + \" entity=\"",
            "          + (r2.entity === null ? \"null\" : \"obj\") + \" x=\" + Math.round(r2.x));",
            "",
            "  // 6) 传感器：crate2 向下穿过圆形 sensor",
            "  bwe.physics.body(sensorEnt, { type: \"static\", shape: \"circle\", radius: 24, sensor: true });",
            "  bwe.physics.body(c2, { type: \"dynamic\", shape: \"circle\", radius: 12 });",
            "  bwe.log(\"PHYS.setVel=\" + (bwe.physics.setVelocity(c2, 0, 300) ? \"1\" : \"0\"));",
            "",
            "  // 7) throwAt + remove",
            "  bwe.physics.body(c3, { type: \"dynamic\", shape: \"circle\", radius: 12 });",
            "  bwe.log(\"PHYS.throwAt=\" + (bwe.physics.throwAt(c3, c3.x + 200, c3.y, 200) ? \"1\" : \"0\"));",
            "  var v3 = bwe.physics.velocity(c3);",
            "  bwe.log(\"PHYS.throwVel=\" + v3.vx.toFixed(1) + \",\" + v3.vy.toFixed(1));",
            "  bwe.physics.remove(c3);",
            "  bwe.log(\"PHYS.remove=\" + (bwe.physics.applyImpulse(c3, 10, 0) === false ? \"1\" : \"0\"));",
            "  bwe.log(\"PHYS.bodyCount3=\" + bwe.physics.bodyCount());",
            "}",
            "",
            "function tick(dt) {",
            "  S.frame++;",
            "  // 60 帧（1s）：木箱早该撞到 cx=8 的墙并停住",
            "  if (S.frame === 60) {",
            "    bwe.log(\"PHYS.crateX=\" + S.crate.x.toFixed(1));",
            "    var v = bwe.physics.velocity(S.crate);",
            "    bwe.log(\"PHYS.crateVel=\" + v.vx.toFixed(1) + \",\" + v.vy.toFixed(1));",
            "    bwe.log(\"PHYS.hits=\" + S.hits);",
            "    bwe.log(\"PHYS.sensorHits=\" + S.sensorHits);",
            "  }",
            "  // 70 帧：脚本直接改位置 → 刚体要被反向同步（teleport），不允许被物理拉回",
            "  if (S.frame === 70) {",
            "    S.crate.setPos(400, 96);",
            "  }",
            "  if (S.frame === 80) {",
            "    bwe.log(\"PHYS.teleport=\" + S.crate.x.toFixed(1) + \",\" + S.crate.y.toFixed(1));",
            "    bwe.log(\"PHYS.debugOn=\" + (bwe.physics.debug(true) === true ? \"1\" : \"0\"));",
            "  }",
            "  if (S.frame === 82) {",
            "    bwe.physics.debug(false);",
            "  }",
            "  if (S.frame === 90) {",
            "    var q = bwe.physics.queryAABB(360, 76, 80, 40);",
            "    bwe.log(\"PHYS.queryAfterTeleport=\" + (q.length >= 1 ? \"1\" : \"0\"));",
            "    bwe.log(\"PHYS.done=1\");",
            "  }",
            "}",
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

    private static List<String> readLog(File log) throws Exception {
        List<String> out = new ArrayList<String>();
        if (log == null || !log.isFile()) {
            return out;
        }
        for (String line : Files.readAllLines(log.toPath(), StandardCharsets.UTF_8)) {
            out.add(line);
        }
        return out;
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

    private static void expectLog(String name, List<String> log, String needle) {
        check(name, contains(log, needle), "未找到: " + needle);
    }

    private static boolean contains(List<String> log, String needle) {
        for (String line : log) {
            if (line.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    private static int countContaining(List<String> log, String needle) {
        int n = 0;
        for (String line : log) {
            if (line.contains(needle)) {
                n++;
            }
        }
        return n;
    }

    private static String firstLineContaining(List<String> log, String needle) {
        for (String line : log) {
            if (line.contains(needle)) {
                return line;
            }
        }
        return null;
    }

    /** 读 "PREFIX<number>"（取最后一次出现，容忍 float 尾巴）。 */
    private static int intAfter(List<String> log, String prefix) {
        int value = -1;
        for (String line : log) {
            int at = line.indexOf(prefix);
            if (at < 0) {
                continue;
            }
            String rest = line.substring(at + prefix.length()).trim();
            int end = 0;
            while (end < rest.length() && (Character.isDigit(rest.charAt(end)) || rest.charAt(end) == '-')) {
                end++;
            }
            if (end == 0) {
                continue;
            }
            try {
                value = Integer.parseInt(rest.substring(0, end));
            } catch (Throwable ignored) {
            }
        }
        return value;
    }

    /** 读 "PREFIX<number>"（取最后一次出现，容忍 float 尾巴）。 */
    private static float floatAfter(List<String> log, String prefix) {
        float value = -1f;
        for (String line : log) {
            int at = line.indexOf(prefix);
            if (at < 0) {
                continue;
            }
            String rest = line.substring(at + prefix.length()).trim();
            int end = 0;
            while (end < rest.length() && "0123456789.-+E".indexOf(rest.charAt(end)) >= 0) {
                end++;
            }
            try {
                value = Float.parseFloat(rest.substring(0, end));
            } catch (Throwable ignored) {
            }
        }
        return value;
    }

    /** 统计「一边是 actorA、一边是 actorB（或墙）」的碰撞事件数。 */
    private static int countCollisionPair(List<String> log, String actorA, String actorB) {
        int n = 0;
        for (String line : log) {
            if (line.contains("PHYS.collisionEvent") && line.contains(actorA) && line.contains(actorB)) {
                n++;
            }
        }
        return n;
    }

    /** 所有 collisionEvent 里最大的 impulse。 */
    private static float maxImpulse(List<String> log) {
        float max = 0f;
        for (String line : log) {
            int at = line.indexOf("impulse=");
            if (at < 0) {
                continue;
            }
            String rest = line.substring(at + "impulse=".length()).trim();
            int end = 0;
            while (end < rest.length() && "0123456789.-+E".indexOf(rest.charAt(end)) >= 0) {
                end++;
            }
            try {
                max = Math.max(max, Float.parseFloat(rest.substring(0, end)));
            } catch (Throwable ignored) {
            }
        }
        return max;
    }

    /** "PHYS.crateVel=vx,vy" 里的 vx。 */
    private static float speedOf(List<String> log) {
        String line = firstLineContaining(log, "PHYS.crateVel=");
        if (line == null) {
            return 999f;
        }
        String rest = line.substring(line.indexOf("PHYS.crateVel=") + "PHYS.crateVel=".length()).trim();
        int comma = rest.indexOf(',');
        try {
            return Float.parseFloat(comma < 0 ? rest : rest.substring(0, comma));
        } catch (Throwable t) {
            return 999f;
        }
    }
}
