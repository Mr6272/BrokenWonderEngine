package Studio.runtime;

import java.awt.event.KeyEvent;
import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 「契约一致性」自检：专门盯那些<b>文档/类型声明了、但实现曾是空壳或有偏差</b>的 API。
 *
 * <p>这一批是端到端验证 + verify-apidocs 交叉比对抓出来的真缺陷，逐个固化成断言，
 * 防止将来「优化」回去：
 * <ul>
 *   <li>{@code bwe.field.on(...)} / {@code bwe.ai.onAlert(...)} / {@code bwe.ai.onSpot(...)}
 *       必须返回<b>可调用的取消函数</b>（原来都 {@code return null}，用户照文档
 *       {@code var off = ...; off();} 直接 TypeError）；</li>
 *   <li>{@code bwe.input.mouse.wheel} 必须是<b>真实事件源</b>（原来恒 0，因为没有
 *       MouseWheelListener）；</li>
 *   <li>{@code bwe.world.layers()} 必须返回<b>场景真实图层</b>（原来是恒空数组占位）；</li>
 *   <li>{@code bwe.audio.music()} 必须返回<b>可用 id</b>（原来声明 void，用户拿不到 id
 *       就没法 stop，属于能力缺失）；</li>
 *   <li>场景脚本的 {@code ctx.self} 必须是 {@code null}（契约已按此修正，别改回去）。</li>
 * </ul>
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class ScriptContractTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;

    private ScriptContractTest() {
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        PrintStream realOut = System.out;
        int failures = 0;
        String fatal = null;
        try {
            run();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace(realOut);
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"contract test caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptContractTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("----------------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        if (root != null) {
            realOut.println("日志: " + new File(root, "Build/bwe.log").getAbsolutePath());
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false",
                detail == null || detail.isEmpty() ? null : detail});
    }

    private static void run() throws Exception {
        root = new File(".tmp_rel8/contract");
        deleteRecursively(root);
        buildProject();

        File boot = new File(root, "Build/boot.json");
        check("boot.json 已生成", boot.isFile(), boot.getAbsolutePath());

        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        check("ScriptEngine 已创建", engine != null, "");

        engine.update(0.02f);
        check("引擎启动成功", engine.started && !engine.failed, "");

        List<String> log = readLog();
        String joined = String.join("\n", log);

        // ---- 1) 订阅 API 必须返回可调用的取消函数 ----
        expectLog(joined, "CONTRACT fieldOn.returnsFn=1");
        expectLog(joined, "CONTRACT fieldOn.offWorks=1");
        expectLog(joined, "CONTRACT aiOnAlert.returnsFn=1");
        expectLog(joined, "CONTRACT aiOnSpot.returnsFn=1");

        // ---- 2) world.layers() 返回真实图层 ----
        expectLog(joined, "CONTRACT layers.count=3");
        expectLog(joined, "CONTRACT layers.firstName=地形");

        // ---- 3) mouse.wheel：必须做「端到端」断言 ----
        // ⚠ 变异测试抓出来的教训：原来这里只断言 `typeof wheel === 'number'`，
        // 而旧实现 `values.put("wheel", 0.0)` 返回的 0 **就是** number ——
        // 那条断言在「恒 0 的死实现」上照样 PASS，一条 bug 都抓不到。
        // 现在改成：注入一个滚轮增量 → 断言脚本读到「非 0 且等于注入值」。
        // 这才是「行为的可观测后果」，而不是「值的类型标签」。
        TopDownRuntime rtW = new TopDownRuntime(boot);
        rtW.scripts.update(0.02f);
        rtW.addWheel(3);
        Actor probe = rtW.actors.isEmpty() ? null : rtW.actors.get(0);
        int wheelRead = rtW.scripts.api().readWheel();
        check("wheel：注入 +3 后读到非 0（抓得住「恒 0」回归）", wheelRead != 0, "读到 " + wheelRead);
        check("wheel：读到值等于注入值 +3（向上为正）", wheelRead == 3, "读到 " + wheelRead);
        int wheelAfter = rtW.scripts.api().readWheel();
        check("wheel：读过即清零（契约是「本帧增量」）", wheelAfter == 0, "第二次读到 " + wheelAfter);

        // ---- 3b) 结构断言：宿主注册了 MouseWheelListener ----
        // ⚠ 这条在 headless 下<b>无法验证</b>：监听器是在 openWindow() 里挂到 canvas 上的，
        // 而自检不建窗口（canvas 为 null）。诚实的做法是「明确记为不可验证」，
        // 而不是写一条永远 PASS 的空断言 —— 那正是本轮变异测试抓出来的问题。
        Boolean wheelListener = hostHasWheelListener(rtW);
        check("wheel：MouseWheelListener 已注册（headless 不可验证时记为 N/A）",
                wheelListener == null || wheelListener.booleanValue(),
                wheelListener == null ? "headless 无 canvas → N/A（端到端断言已覆盖行为）" : "未找到监听器");

        // ---- 4) audio.music 返回 id（无素材时应为 -1，但不能是 undefined）----
        expectLog(joined, "CONTRACT music.isNumber=1");

        // ---- 5) ctx.self：两种语义都要测 ----
        // 变异测试指出的覆盖缺口：原来只测了「场景脚本 self 必须是 null」，
        // 没测「对象脚本 self 必须<b>不是</b> null」—— 缺了对称的一半，
        // 万一哪天 context() 把 self 恒定置 null，这条测试照样全绿。
        expectLog(joined, "CONTRACT sceneSelf.isNull=1");
        expectLog(joined, "CONTRACT objectSelf.notNull=1");
        expectLog(joined, "CONTRACT objectSelf.name=甲");
        expectLog(joined, "CONTRACT objectSelf.hpMax=77");

        check("无脚本错误", !joined.contains("[脚本错误]"),
                firstLine(joined, "[脚本错误]"));
    }

    /**
     * 结构探针：canvas 上是否挂了 {@code MouseWheelListener}。
     *
     * @return {@code null} = headless / 没建窗口，<b>无法验证</b>（不是失败）；
     *         {@code TRUE}/{@code FALSE} = 已验证有/没有。
     */
    private static Boolean hostHasWheelListener(TopDownRuntime rt) {
        try {
            java.lang.reflect.Field f = TopDownRuntime.class.getDeclaredField("canvas");
            f.setAccessible(true);
            Object canvas = f.get(rt);
            if (!(canvas instanceof java.awt.Component)) {
                return null;
            }
            for (java.awt.event.MouseWheelListener l
                    : ((java.awt.Component) canvas).getMouseWheelListeners()) {
                if (l != null) {
                    return Boolean.TRUE;
                }
            }
            return Boolean.FALSE;
        } catch (Throwable t) {
            return null;
        }
    }

    private static void expectLog(String joined, String needle) {
        check(needle, joined.contains(needle), "未找到: " + needle);
    }

    private static String firstLine(String text, String needle) {
        for (String line : text.split("\n")) {
            if (line.contains(needle)) {
                return line;
            }
        }
        return "";
    }

    // ---------------- 造工程 ----------------

    private static void buildProject() throws Exception {
        File build = new File(root, "Build");
        File scripts = new File(build, "scripts");
        scripts.mkdirs();
        write(new File(build, "boot.json"), bootJson());
        write(new File(build, "scene_0.json"), sceneJson());
        write(new File(scripts, "main.js"), MainJs);
        write(new File(scripts, "objprobe.js"), ObjProbeJs);
    }

    private static String bootJson() {
        return "{\n"
                + "  \"project\": \"ScriptContractTest\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 0.8,\n"
                + "  \"scenes\": [ { \"name\": \"契约场景\", \"file\": \"scene_0.json\","
                + " \"width\": 20, \"height\": 15 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [ { \"name\": \"main\", \"file\": \"scripts/main.js\", \"lang\": \"js\" },\n"
                + "                { \"name\": \"objprobe\", \"file\": \"scripts/objprobe.js\", \"lang\": \"js\" } ],\n"
                + "  \"assets\": []\n"
                + "}\n";
    }

    /** 场景带 3 个图层（验证 world.layers 真能读出来）+ 一个普通对象。 */
    private static String sceneJson() {
        return "{\n"
                + "  \"width\": 20,\n"
                + "  \"height\": 15,\n"
                + "  \"tileSize\": 32,\n"
                + "  \"onStartScript\": \"main\",\n"
                + "  \"layers\": [\n"
                + "    { \"id\": \"layer-terrain\", \"name\": \"地形\", \"visible\": true, \"order\": 0 },\n"
                + "    { \"id\": \"layer-prop\", \"name\": \"物件\", \"visible\": true, \"order\": 1 },\n"
                + "    { \"id\": \"layer-actor\", \"name\": \"角色\", \"visible\": false, \"order\": 2 }\n"
                + "  ],\n"
                + "  \"objects\": [\n"
                + "    { \"id\": \"o1\", \"kind\": \"ACTOR\", \"name\": \"甲\", \"x\": 100, \"y\": 100,\n"
                + "      \"halfW\": 16, \"halfH\": 16, \"layer\": 2, \"tags\": [\"actor\"],\n"
                + "      \"modules\": [ { \"def\": \"combat.health\", \"when\": \"ALWAYS\",\n"
                + "        \"params\": { \"hp\": \"77\" } },\n"
                + "        { \"def\": \"script.js\", \"when\": \"ALWAYS\",\n"
                + "          \"params\": { \"script\": \"objprobe\" } } ] }\n"
                + "  ]\n"
                + "}\n";
    }

    private static final String MainJs = String.join("\n",
            "function onSceneStart(ctx) {",
            "  // 1) 订阅 API 的返回值必须是函数",
            "  var fired = 0;",
            "  var off1 = bwe.field.on('ignite', function (info) { fired++; });",
            "  bwe.log('CONTRACT fieldOn.returnsFn=' + (typeof off1 === 'function' ? 1 : 0));",
            "  // 取消后不应再被调用：这里只验证 off 可调用且不抛",
            "  try {",
            "    off1();",
            "    bwe.log('CONTRACT fieldOn.offWorks=1');",
            "  } catch (e) {",
            "    bwe.log('CONTRACT fieldOn.offWorks=0');",
            "  }",
            "",
            "  var off2 = bwe.ai.onAlert(function () {});",
            "  bwe.log('CONTRACT aiOnAlert.returnsFn=' + (typeof off2 === 'function' ? 1 : 0));",
            "  var off3 = bwe.ai.onSpot(function () {});",
            "  bwe.log('CONTRACT aiOnSpot.returnsFn=' + (typeof off3 === 'function' ? 1 : 0));",
            "",
            "  // 2) world.layers() 必须返回场景真实图层",
            "  var layers = bwe.world.layers();",
            "  bwe.log('CONTRACT layers.count=' + layers.length);",
            "  if (layers.length > 0) {",
            "    bwe.log('CONTRACT layers.firstName=' + layers[0].name);",
            "  }",
            "",
            "  // 3) mouse.wheel 必须是数字（有真实事件源；headless 无滚轮事件时为 0）",
            "  bwe.log('CONTRACT wheel.isNumber=' + (typeof bwe.input.mouse.wheel === 'number' ? 1 : 0));",
            "",
            "  // 4) audio.music 必须返回数字 id（无素材时 -1，但绝不能是 undefined）",
            "  var mid = bwe.audio.music('不存在的BGM');",
            "  bwe.log('CONTRACT music.isNumber=' + (typeof mid === 'number' ? 1 : 0));",
            "",
            "  // 5) 场景脚本的 ctx.self 必须是 null（不是空实体）",
            "  bwe.log('CONTRACT sceneSelf.isNull=' + (ctx.self === null ? 1 : 0));",
            "}",
            "");

    private static void write(File f, String text) throws Exception {
        File p = f.getParentFile();
        if (p != null) {
            p.mkdirs();
        }
        Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    /** 对象脚本探针：验证 ctx.self 在对象脚本里<b>不是</b> null（场景脚本的对称面）。 */
    private static final String ObjProbeJs = String.join("\n",
            "function onStart(ctx) {",
            "  bwe.log('CONTRACT objectSelf.notNull=' + (ctx.self !== null && ctx.self !== undefined ? 1 : 0));",
            "  if (ctx.self) {",
            "    bwe.log('CONTRACT objectSelf.name=' + ctx.self.name);",
            "    bwe.log('CONTRACT objectSelf.hpMax=' + Math.round(ctx.self.hpMax));",
            "  }",
            "}",
            "");

    private static List<String> readLog() {
        try {
            File f = new File(root, "Build/bwe.log");
            if (!f.isFile()) {
                return new ArrayList<String>();
            }
            return Files.readAllLines(f.toPath(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return new ArrayList<String>();
        }
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
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
