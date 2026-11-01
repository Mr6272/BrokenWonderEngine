package Studio.runtime;

import java.awt.event.KeyEvent;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 感知/AI 基底自检（契约 §2.11.3 / §2.11.4 / §2.11.6 / §2.11.7-4）。
 *
 * <p>现场生成两个小工程到 {@code .tmp_rel8/ai/}：
 * <ul>
 *   <li>{@code core}：荒原哨站剧本 —— 噪音→守卫 investigate 并朝声源移动；隔墙 canSee=false 但听到噪音；
 *       记忆随 memory 衰减；同阵营警报一跳传播；阵营敌我；target 拾取；seed 确定性；状态机读写；detach；</li>
 *   <li>{@code perf}：200 个挂了 ai.attach 的守卫 + 20 个敌对目标 + 墙体，测每帧感知耗时（要求 &lt;1ms）。</li>
 * </ul>
 *
 * <p>同时做两遍 {@code core} 的对拍，验证「同种子 + 同输入 ⇒ 同结果」。
 */
public final class ScriptAiTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;
    private static double PERF_AVG_MS = -1;
    private static int PERF_AGENTS = -1;
    private static int PERF_TICKS = -1;

    private ScriptAiTest() {
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        PrintStream realOut = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true));
        int failures = 0;
        String fatal = null;
        try {
            root = new File(".tmp_rel8/ai");
            deleteRecursively(root);
            runCoreAndDeterminism();
            runPerf();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace(realOut);
        } finally {
            System.setOut(realOut);
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"selftest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptAiTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("------------------------------------");
        if (PERF_AVG_MS >= 0) {
            realOut.println(String.format("感知性能：%d 个 AI × %d tick，平均 %.3f ms/帧（<1ms 要求）",
                    PERF_AGENTS, PERF_TICKS, PERF_AVG_MS));
        }
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- core ----------------

    private static void runCoreAndDeterminism() throws Exception {
        File core = new File(root, "core");
        buildCoreProject(core);

        File boot = new File(core, "Build/boot.json");
        check("core 工程已生成", boot.isFile(), boot.getAbsolutePath());

        Run run1 = run(core, boot, 95, 14);
        List<String> log1 = readLog(core);
        check("core bwe.log 已写入", !log1.isEmpty(), "lines=" + log1.size());
        check("core 无脚本错误", countContaining(log1, "[脚本错误]") == 0,
                firstLineContaining(log1, "[脚本错误]"));
        assertCore(log1, run1, true);

        // 确定性：同一工程、同 95 帧、同输入，日志里所有 SELFTEST 行必须逐字一致。
        deleteFile(new File(core, "Build/bwe.log"));
        Run run2 = run(core, boot, 95, 14);
        List<String> log2 = readLog(core);
        List<String> det1 = selftestLines(log1);
        List<String> det2 = selftestLines(log2);
        check("两次运行 SELFTEST 行数一致", det1.size() == det2.size(),
                det1.size() + " vs " + det2.size());
        boolean same = det1.size() == det2.size();
        if (same) {
            for (int i = 0; i < det1.size(); i++) {
                if (!det1.get(i).equals(det2.get(i))) {
                    same = false;
                    check("确定性首个差异", false, "run1=" + det1.get(i) + " | run2=" + det2.get(i));
                    break;
                }
            }
        }
        check("确定性：同种子同输入 ⇒ 同日志序列", same, "");
        ScriptAi.AiState st2 = ScriptAi.stateFor(run2.engine);
        Actor ga1 = actorNamed(run1.rt, "guardA");
        Actor ga2 = actorNamed(run2.rt, "guardA");
        check("确定性：guardA 最终位置一致",
                ga1 != null && ga2 != null
                        && Math.abs(ga1.x - ga2.x) < 0.001f && Math.abs(ga1.y - ga2.y) < 0.001f,
                (ga1 == null ? "?" : ga1.x + "," + ga1.y) + " vs "
                        + (ga2 == null ? "?" : ga2.x + "," + ga2.y));

        // bwe.seed.set/reset 会反射转调兄弟子系统的 setSeed：脚本最后调用的是 reset()，
        // 所以场系统当前种子应等于 ScriptAi.DEFAULT_SEED（对端没这个入口时跳过）。
        long fs = fieldsSeed();
        check("seed 已同步给场系统（反射转调）", fs == Long.MIN_VALUE || fs == ScriptAi.DEFAULT_SEED,
                "fieldsSeed=" + fs + " expected=" + ScriptAi.DEFAULT_SEED);
    }

    /** 反射读 ScriptFields.seed()：不形成编译期依赖，对端没有就返回 Long.MIN_VALUE。 */
    private static long fieldsSeed() {
        try {
            java.lang.reflect.Method m = Class.forName("Studio.runtime.ScriptFields")
                    .getDeclaredMethod("seed");
            m.setAccessible(true);
            Object v = m.invoke(null);
            return v instanceof Number ? ((Number) v).longValue() : Long.MIN_VALUE;
        } catch (Throwable t) {
            return Long.MIN_VALUE;
        }
    }

    private static void assertCore(List<String> log, Run run, boolean firstRun) {
        ScriptAi.AiState st = ScriptAi.stateFor(run.engine);
        check("ScriptAi 状态已挂到引擎", st != null, "");

        // ---- 阵营 ----
        expectLog("faction.members(guard) = 2", log, "SELFTEST faction.members=2");
        expectLog("faction.hostile(guard, bandit) = true", log, "SELFTEST faction.hostile=1");

        // ---- 视野 ----
        expectLog("canSee 近处敌人 = true", log, "SELFTEST sight.near=1");
        expectLog("canSee 隔墙 = false", log, "SELFTEST sight.wall=0");
        expectLog("inSightRange 隔墙仍在半径内 = true", log, "SELFTEST sight.range=1");
        expectLog("onSpot：guardA 发现 banditNear", log, "SELFTEST spot=guardA->banditNear");
        expectLog("guard 拿到 target", log, "SELFTEST guard.seen=guardA,banditNear");

        // ---- 噪音 ----
        expectLog("噪音前 audible = false", log, "SELFTEST audible.before=0");
        expectLog("noise.emit 成功", log, "SELFTEST noise.emitted=1");
        expectLog("噪音后 audible = true", log, "SELFTEST noise.audible=1");
        expectLog("noise.events() 有事件", log, "SELFTEST noise.events=1");
        expectLog("隔墙听得到（canSee 仍 false）", log, "SELFTEST noise.wallCanSee=0");
        expectLog("lastKnown 记录声源", log, "SELFTEST noise.lastKnown=720,200");
        expectLog("audible 有过期（0.4s hold）", log, "SELFTEST audible.late=0");

        // ---- 状态机：噪音 → investigate 并朝声源移动 ----
        expectLog("guardA 进入 investigate", log, "SELFTEST guard.investigate=guardA");
        Actor ga = actorNamed(run.rt, "guardA");
        check("guardA 朝声源移动（x 明显增大）", ga != null && ga.x > 330f,
                ga == null ? "guardA 不存在" : "x=" + ga.x);
        if (st != null && ga != null) {
            ScriptAi.Agent ag = st.agents.get(ga);
            check("引擎侧 guardA 状态 = investigate", ag != null && "investigate".equals(ag.state),
                    ag == null ? "agent 不存在" : ag.state);
        }

        // ---- 记忆衰减 ----
        expectLog("丢失目标后仍记得（lastKnown 有 age 增长）", log, "SELFTEST log.age=");
        double maxAge = maxAgeLogged(log);
        check("记忆 age 随时间增长到 >0.5s", maxAge > 0.5, "maxAge=" + maxAge);
        expectLog("memory 秒后遗忘", log, "SELFTEST guard.forgot=guardA");
        if (st != null && ga != null) {
            ScriptAi.Agent ag = st.agents.get(ga);
            check("引擎侧 lastKnown 已清空", ag != null && !ag.hasKnown && ag.target == null,
                    ag == null ? "agent 不存在" : "hasKnown=" + ag.hasKnown);
        }

        // ---- 警报一跳传播 ----
        expectLog("alert.sent", log, "SELFTEST alert.sent=1");
        expectLog("同阵营收到警报（带位置）", log, "SELFTEST alert.recv=guardB,700");

        // ---- 拾取器 ----
        expectLog("target.cell 鼠标格子", log, "SELFTEST target.cell=9,6");
        expectLog("target.entity 鼠标下实体", log, "SELFTEST target.entity=crate");
        expectLog("target.inFront 取到实体", log, "SELFTEST target.front=crate2");
        expectLog("target.inFront 空格返回格子", log, "SELFTEST target.frontCell=3,23");

        // ---- 确定性随机 ----
        expectLog("seed：同种子同序列", log, "SELFTEST seed.seq2=");
        String seq1 = firstLineContaining(log, "SELFTEST seed.seq1=");
        String seq2 = firstLineContaining(log, "SELFTEST seed.seq2=");
        check("seed：seed.set(777) 两次序列一致", seq1 != null && seq2 != null
                        && seq1.replace("seq1", "seqX").equals(seq2.replace("seq2", "seqX")),
                seq1 + " | " + seq2);
        expectLog("seed：默认种子固定", log, "SELFTEST seed.default=1");

        // ---- detach ----
        expectLog("ai.detach 后 state = null", log, "SELFTEST detach=1");

        // ---- 引擎状态 ----
        if (st != null) {
            check("ai.attach 生效（2 个 agent）", st.agents.size() == 1 || st.agents.size() == 2,
                    "agents=" + st.agents.size()); // detach 之后剩 1 个
            check("噪音事件被记录", !st.noises.isEmpty(), "noises=" + st.noises.size());
            check("AI tick 有执行", st.tickCount >= 90, "ticks=" + st.tickCount);
        }
    }

    private static double maxAgeLogged(List<String> log) {
        double max = -1;
        for (String line : log) {
            int i = line.indexOf("SELFTEST log.age=");
            if (i < 0) {
                continue;
            }
            String v = line.substring(i + "SELFTEST log.age=".length()).trim();
            try {
                double d = Double.parseDouble(v);
                if (d > max) {
                    max = d;
                }
            } catch (NumberFormatException ignored) {
            }
        }
        return max;
    }

    // ---------------- perf ----------------

    private static void runPerf() throws Exception {
        File perf = new File(root, "perf");
        buildPerfProject(perf);
        File boot = new File(perf, "Build/boot.json");
        check("perf 工程已生成", boot.isFile(), boot.getAbsolutePath());

        Run run = run(perf, boot, 150, -1);
        List<String> log = readLog(perf);
        check("perf 无脚本错误", countContaining(log, "[脚本错误]") == 0,
                firstLineContaining(log, "[脚本错误]"));
        expectLog("perf 脚本启动", log, "SELFTEST perf.ready=20");

        ScriptAi.AiState st = ScriptAi.stateFor(run.engine);
        check("perf：200 个 AI 已 attach", st != null && st.agents.size() == 200,
                st == null ? "state 缺失" : "agents=" + st.agents.size());
        check("perf：已跑满 150 tick", st != null && st.tickCount >= 150,
                st == null ? "" : "ticks=" + st.tickCount);
        double avg = ScriptAi.averageTickMs(run.engine);
        PERF_AVG_MS = avg;
        PERF_AGENTS = st == null ? -1 : st.agents.size();
        PERF_TICKS = st == null ? -1 : (int) st.tickCount;
        check("感知耗时 < 1ms/帧（200 AI）", avg >= 0 && avg < 1.0,
                String.format("%.3f ms", avg));
    }

    // ---------------- 运行 ----------------

    private static final class Run {
        final TopDownRuntime rt;
        final ScriptEngine engine;

        Run(TopDownRuntime rt, ScriptEngine engine) {
            this.rt = rt;
            this.engine = engine;
        }
    }

    private static Run run(File project, File boot, int frames, int mouseFromFrame) throws Exception {
        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        check("引擎已创建：" + project.getName(), engine != null, "");
        for (int i = 1; i <= frames; i++) {
            if (mouseFromFrame > 0 && i >= mouseFromFrame) {
                // 鼠标放到世界 (300,200)：走宿主的视口正变换，避免假设 zoom/cam。
                rt.mouseX = Math.round(rt.view.toScreenX(300f));
                rt.mouseY = Math.round(rt.view.toScreenY(200f));
            }
            engine.update(0.02f);
            engine.draw(null);
        }
        return new Run(rt, engine);
    }

    // ---------------- 工程生成 ----------------

    private static void buildCoreProject(File dir) throws Exception {
        File build = new File(dir, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());

        String boot = "{\n"
                + "  \"project\": \"ScriptAiTest-Core\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"scenes\": [ { \"name\": \"哨站\", \"file\": \"scene_0.json\", \"width\": 40, \"height\": 30 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [\n"
                + "    { \"name\": \"system\", \"file\": \"scripts/system.js\", \"lang\": \"js\" },\n"
                + "    { \"name\": \"guard\", \"file\": \"scripts/guard.js\", \"lang\": \"js\" }\n"
                + "  ]\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);
        write(new File(build, "scene_0.json"), coreSceneJson());
        write(new File(scripts, "system.js"), SystemJs);
        write(new File(scripts, "guard.js"), GuardJs);
    }

    private static String coreSceneJson() {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n \"width\": 40, \"height\": 30, \"tileSize\": 32,\n");
        sb.append(" \"onStartScript\": \"system\",\n");
        sb.append(" \"objects\": [\n");
        sb.append(obj("guardA", "ACTOR", "guardA", 200, 200, "[\"guard\"]", "guard"));
        sb.append(",\n").append(obj("guardB", "ACTOR", "guardB", 200, 400, "[\"guard\"]", "guard"));
        sb.append(",\n").append(obj("banditNear", "PROP", "banditNear", 360, 200, "[\"bandit\"]", null));
        sb.append(",\n").append(obj("player", "ACTOR", "player", 720, 200, "[\"玩家\"]", null));
        sb.append(",\n").append(obj("crate", "PROP", "crate", 300, 200, "[]", null));
        sb.append(",\n").append(obj("crate2", "PROP", "crate2", 720, 240, "[]", null));
        sb.append(",\n").append(obj("girl", "PROP", "girl", 100, 700, "[]", null));
        // 竖墙：cx=20，rows 5..25（把 (720,200) 的 player 挡在墙后）
        for (int row = 5; row <= 25; row++) {
            sb.append(",\n    { \"id\": \"w").append(row).append("\", \"kind\": \"TILE\", \"name\": \"wall")
                    .append(row).append("\", \"x\": ").append((20 + 0.5) * 32).append(", \"y\": ")
                    .append((row + 0.5) * 32).append(", \"visible\": true }");
        }
        sb.append("\n ]\n}\n");
        return sb.toString();
    }

    private static String obj(String id, String kind, String name, float x, float y,
                              String tags, String script) {
        StringBuilder sb = new StringBuilder();
        sb.append("    { \"id\": \"").append(id).append("\", \"kind\": \"").append(kind)
                .append("\", \"name\": \"").append(name).append("\", \"x\": ").append(x)
                .append(", \"y\": ").append(y).append(", \"halfW\": 16, \"halfH\": 16,")
                .append(" \"visible\": true, \"tags\": ").append(tags);
        if (script != null) {
            sb.append(", \"modules\": [ { \"def\": \"script.js\", \"params\": { \"script\": \"")
                    .append(script).append("\" } } ]");
        }
        sb.append(" }");
        return sb.toString();
    }

    private static void buildPerfProject(File dir) throws Exception {
        File build = new File(dir, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());

        String boot = "{\n"
                + "  \"project\": \"ScriptAiTest-Perf\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"scenes\": [ { \"name\": \"演武场\", \"file\": \"scene_0.json\", \"width\": 40, \"height\": 30 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [\n"
                + "    { \"name\": \"systemPerf\", \"file\": \"scripts/systemPerf.js\", \"lang\": \"js\" },\n"
                + "    { \"name\": \"guardPerf\", \"file\": \"scripts/guardPerf.js\", \"lang\": \"js\" }\n"
                + "  ]\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);
        write(new File(build, "scene_0.json"), perfSceneJson());
        write(new File(scripts, "systemPerf.js"), SystemPerfJs);
        write(new File(scripts, "guardPerf.js"), GuardPerfJs);
    }

    private static String perfSceneJson() {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n \"width\": 40, \"height\": 30, \"tileSize\": 32,\n");
        sb.append(" \"onStartScript\": \"systemPerf\",\n");
        sb.append(" \"objects\": [\n");
        List<String> objs = new ArrayList<String>();
        for (int i = 0; i < 200; i++) {
            int col = i % 20;
            int row = i / 20;
            float x = 48 + col * 58;
            float y = 48 + row * 72;
            objs.add(obj("g" + i, "ACTOR", "g" + i, x, y, "[\"guard\"]", "guardPerf"));
        }
        for (int j = 0; j < 20; j++) {
            float x = 100 + ((j * 137) % 1100);
            float y = 760 + ((j * 53) % 150);
            objs.add(obj("b" + j, "PROP", "b" + j, x, y, "[\"bandit\"]", null));
        }
        // 两道竖墙，制造一部分视线遮挡（每道 30 格）
        for (int row = 0; row < 30; row++) {
            objs.add("{ \"id\": \"w1_" + row + "\", \"kind\": \"TILE\", \"name\": \"wallA\", \"x\": "
                    + (10.5 * 32) + ", \"y\": " + ((row + 0.5) * 32) + ", \"visible\": true }");
            objs.add("{ \"id\": \"w2_" + row + "\", \"kind\": \"TILE\", \"name\": \"wallB\", \"x\": "
                    + (25.5 * 32) + ", \"y\": " + ((row + 0.5) * 32) + ", \"visible\": true }");
        }
        sb.append(String.join(",\n    ", objs));
        sb.append("\n ]\n}\n");
        return sb.toString();
    }

    // ---------------- 脚本 ----------------

    private static final String GuardJs = String.join("\n",
            "function onStart(ctx) {",
            "  var e = ctx.self;",
            "  bwe.ai.attach(e, { sight: 600, fov: 360, hearing: 700, memory: 1.2, speed: 90 });",
            "  bwe.faction.set(e, \"guard\");",
            "}",
            "function onUpdate(ctx, dt) {",
            "  var e = ctx.self;",
            "  var st = bwe.ai.state(e);",
            "  var t = bwe.ai.target(e);",
            "  // 注意：对象脚本 onUpdate 的派发顺序由引擎内部 map 决定，跨运行不保证；",
            "  // 所以日志只由 guardA 打点，保证确定性对拍只依赖 AI 子系统的顺序。",
            "  if (e.name === \"guardA\" && t && e.prop(\"seen\", \"0\") !== \"1\") {",
            "    e.setProp(\"seen\", \"1\");",
            "    bwe.log(\"SELFTEST guard.seen=\" + e.name + \",\" + t.name);",
            "  }",
            "  if (e.name === \"guardA\" && !t && e.prop(\"seen\", \"0\") === \"1\" && e.prop(\"forgot\", \"0\") !== \"1\") {",
            "    if (!bwe.sense.lastKnown(e)) {",
            "      e.setProp(\"forgot\", \"1\");",
            "      bwe.log(\"SELFTEST guard.forgot=\" + e.name);",
            "    }",
            "  }",
            "  if (bwe.sense.audible(e) && st === \"idle\") {",
            "    bwe.ai.setState(e, \"investigate\");",
            "    st = \"investigate\";",
            "    if (e.name === \"guardA\") {",
            "      bwe.log(\"SELFTEST guard.investigate=\" + e.name);",
            "    }",
            "  }",
            "  if (st === \"investigate\") {",
            "    var lk = bwe.sense.lastKnown(e);",
            "    if (lk) {",
            "      var dx = lk.x - e.x;",
            "      var dy = lk.y - e.y;",
            "      var d = Math.sqrt(dx * dx + dy * dy);",
            "      if (d > 4) {",
            "        e.setPos(e.x + dx / d * 120 * dt, e.y + dy / d * 120 * dt);",
            "      } else if (e.prop(\"arrived\", \"0\") !== \"1\") {",
            "        e.setProp(\"arrived\", \"1\");",
            "        bwe.log(\"SELFTEST guard.arrived=\" + e.name);",
            "      }",
            "    }",
            "  }",
            "  if (e.name === \"guardA\" && bwe.time.frame % 20 === 0) {",
            "    var lk2 = bwe.sense.lastKnown(e);",
            "    bwe.log(\"SELFTEST log.age=\" + (lk2 ? Math.round(lk2.age * 100) / 100 : -1));",
            "  }",
            "}",
            "");

    private static final String SystemJs = String.join("\n",
            "var gA = null;",
            "var gB = null;",
            "function onSceneStart(ctx) {",
            "  gA = bwe.world.find(\"guardA\");",
            "  gB = bwe.world.find(\"guardB\");",
            "  bwe.faction.set(bwe.world.find(\"banditNear\"), \"bandit\");",
            "  bwe.faction.relation(\"guard\", \"bandit\", -1);",
            "",
            "  bwe.log(\"SELFTEST faction.members=\" + bwe.faction.members(\"guard\").length);",
            "  bwe.log(\"SELFTEST faction.hostile=\" + (bwe.faction.hostile(gA, bwe.world.find(\"banditNear\")) ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST sight.near=\" + (bwe.sense.canSee(gA, bwe.world.find(\"banditNear\")) ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST sight.wall=\" + (bwe.sense.canSee(gA, bwe.world.find(\"player\")) ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST sight.range=\" + (bwe.sense.inSightRange(gA, bwe.world.find(\"player\")) ? \"1\" : \"0\"));",
            "",
            "  bwe.seed.set(777);",
            "  var r1 = bwe.random(0, 100);",
            "  var i1 = bwe.randomInt(1, 6);",
            "  var c1 = bwe.chance(0.5);",
            "  var k1 = bwe.pick([\"a\", \"b\", \"c\"]);",
            "  bwe.seed.set(777);",
            "  var r2 = bwe.random(0, 100);",
            "  var i2 = bwe.randomInt(1, 6);",
            "  var c2 = bwe.chance(0.5);",
            "  var k2 = bwe.pick([\"a\", \"b\", \"c\"]);",
            "  bwe.log(\"SELFTEST seed.seq1=\" + r1.toFixed(4) + \",\" + i1 + \",\" + (c1 ? 1 : 0) + \",\" + k1);",
            "  bwe.log(\"SELFTEST seed.seq2=\" + r2.toFixed(4) + \",\" + i2 + \",\" + (c2 ? 1 : 0) + \",\" + k2);",
            "  bwe.seed.reset();",
            "  bwe.log(\"SELFTEST seed.default=\" + (bwe.seed.get() === bwe.seed.defaultSeed() ? \"1\" : \"0\"));",
            "",
            "  bwe.ai.onSpot(function (info) {",
            "    bwe.log(\"SELFTEST spot=\" + info.entity.name + \"->\" + info.target.name);",
            "  });",
            "  bwe.ai.onAlert(function (info) {",
            "    bwe.log(\"SELFTEST alert.recv=\" + info.entity.name + \",\" + Math.round(info.position.x));",
            "    if (bwe.ai.state(info.entity) === \"idle\") {",
            "      bwe.ai.setState(info.entity, \"investigate\");",
            "    }",
            "  });",
            "",
            "  bwe.after(0.02, function () {",
            "    bwe.log(\"SELFTEST audible.before=\" + (bwe.sense.audible(gA) ? \"1\" : \"0\"));",
            "  });",
            "  bwe.after(0.08, function () {",
            "    bwe.world.find(\"banditNear\").setPos(1000, 900);",
            "    bwe.log(\"SELFTEST bandit.moved=1\");",
            "  });",
            "  bwe.after(0.15, function () {",
            "    bwe.noise.emit(720, 200, { radius: 1200, intensity: 1.5, tag: \"combat\" });",
            "    bwe.log(\"SELFTEST noise.emitted=1\");",
            "  });",
            "  bwe.after(0.2, function () {",
            "    bwe.log(\"SELFTEST noise.audible=\" + (bwe.sense.audible(gA) ? \"1\" : \"0\"));",
            "    bwe.log(\"SELFTEST noise.events=\" + bwe.noise.events().length);",
            "  });",
            "  bwe.after(0.25, function () {",
            "    var lk = bwe.sense.lastKnown(gA);",
            "    bwe.log(\"SELFTEST noise.lastKnown=\" + (lk ? Math.round(lk.x) + \",\" + Math.round(lk.y) : \"none\"));",
            "    bwe.log(\"SELFTEST noise.wallCanSee=\" + (bwe.sense.canSee(gA, bwe.world.find(\"player\")) ? \"1\" : \"0\"));",
            "  });",
            "  bwe.after(0.3, function () {",
            "    bwe.ai.alert(gA, { x: 700, y: 300 });",
            "    bwe.log(\"SELFTEST alert.sent=1\");",
            "  });",
            "  bwe.after(0.35, function () {",
            "    var cell = bwe.target.cell();",
            "    bwe.log(\"SELFTEST target.cell=\" + cell.cx + \",\" + cell.cy);",
            "    var te = bwe.target.entity();",
            "    bwe.log(\"SELFTEST target.entity=\" + (te ? te.name : \"none\"));",
            "    var front = bwe.target.inFront(bwe.world.find(\"player\"), 40);",
            "    bwe.log(\"SELFTEST target.front=\" + (front && front.name ? front.name : (\"cell:\" + front.cx + \",\" + front.cy)));",
            "    var fc = bwe.target.inFront(bwe.world.find(\"girl\"), 48);",
            "    bwe.log(\"SELFTEST target.frontCell=\" + (fc && fc.name ? fc.name : (fc.cx + \",\" + fc.cy)));",
            "  });",
            "  bwe.after(0.6, function () {",
            "    bwe.log(\"SELFTEST audible.late=\" + (bwe.sense.audible(gA) ? \"1\" : \"0\"));",
            "  });",
            "  bwe.after(1.6, function () {",
            "    bwe.ai.detach(gB);",
            "    bwe.log(\"SELFTEST detach=\" + (bwe.ai.state(gB) === null ? \"1\" : \"0\"));",
            "  });",
            "}",
            "");

    private static final String GuardPerfJs = String.join("\n",
            "function onStart(ctx) {",
            "  bwe.ai.attach(ctx.self, { sight: 260, fov: 120, hearing: 300, memory: 6, speed: 90 });",
            "  bwe.faction.set(ctx.self, \"guard\");",
            "}",
            "function onUpdate(ctx, dt) { }",
            "");

    private static final String SystemPerfJs = String.join("\n",
            "function onSceneStart(ctx) {",
            "  var bandits = bwe.world.findAll({ tag: \"bandit\" });",
            "  for (var i = 0; i < bandits.length; i++) {",
            "    bwe.faction.set(bandits[i], \"bandit\");",
            "  }",
            "  bwe.faction.relation(\"guard\", \"bandit\", -1);",
            "  bwe.log(\"SELFTEST perf.ready=\" + bandits.length);",
            "}",
            "");

    // ---------------- 文件/断言工具 ----------------

    private static void write(File f, String content) throws Exception {
        Files.createDirectories(f.getParentFile().toPath());
        Files.write(f.toPath(), content.getBytes(StandardCharsets.UTF_8));
    }

    private static void deleteFile(File f) {
        try {
            Files.deleteIfExists(f.toPath());
        } catch (Throwable ignored) {
        }
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

    private static List<String> readLog(File project) throws Exception {
        List<String> out = new ArrayList<String>();
        File log = new File(project, "Build/bwe.log");
        if (!log.isFile()) {
            return out;
        }
        for (String line : Files.readAllLines(log.toPath(), StandardCharsets.UTF_8)) {
            out.add(line);
        }
        return out;
    }

    private static List<String> selftestLines(List<String> log) {
        List<String> out = new ArrayList<String>();
        for (String line : log) {
            int i = line.indexOf("SELFTEST");
            if (i >= 0) {
                out.add(line.substring(i));
            }
        }
        return out;
    }

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

    private static Actor actorNamed(TopDownRuntime rt, String name) {
        for (Actor a : rt.actors) {
            if (a.o != null && name.equals(a.o.name)) {
                return a;
            }
        }
        return null;
    }
}
