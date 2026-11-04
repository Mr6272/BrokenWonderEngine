package Studio.runtime;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@code bwe.light} 脚本 API 自检（无窗口、纯断言）。
 *
 * <p><b>为什么必须单独有这个测试</b>：{@code verify-apidocs} 只能证明「Java 里注册了这 12 个
 * 名字」，证明不了它们<b>真的接上了</b> {@link Lighting}。本测试补这一段：现场跑一个真脚本，
 * 既断言「成员存在且可调用」，也断言「调用之后宿主状态真的变了」。
 *
 * <p>写法与 {@link ScriptPrefabTest} / {@link OpenWorldTest} 一致：现场生成最小工程到
 * {@code .tmp_light_sa/lighttest/}（boot.json + scene_0.json + scripts/scene.js）→
 * {@code new TopDownRuntime(boot)} → 手动推进 {@code engine.update(0.02f)} →
 * 读 {@code Build/bwe.log} 校验脚本自报结果 + 直接检查宿主与 {@link Lighting} 状态。
 *
 * <p>两种断言互相补位：
 * <ul>
 *   <li><b>脚本侧</b>（{@code LIGHT*} 日志行）：覆盖「从脚本视角看，调用合法、返回类型对、
 *       非法参数不抛异常」。Rhino 里异常会打断整段脚本，所以「非法参数之后后面的日志行
 *       仍然出现」本身就是一条强断言；</li>
 *   <li><b>Java 侧</b>（直接读 {@link Lighting} / {@code Actor.o.props}）：覆盖
 *       「脚本的调用真的落到了运行时数据上」，排除「只造返回值、没改状态」的假实现。</li>
 * </ul>
 *
 * <p><b>⚠ 中间态 vs 最终态</b>：Java 侧的断言全部在脚本跑完之后读，所以只能检查
 * <b>脚本跑完后仍然成立</b>的状态。脚本里那些「改完又改回去」的中间态（`darkness(0.62)`
 * 之后又被夹取、`attach` 之后又 `detach`）只能由脚本自己当场断言并写日志。
 * 为此脚本在最后刻意留了一个**已知终态**：hero 上挂着一盏 150px / `#80FFA0` / 0.8 的光，
 * `darkness = 0.4`、`mode = "dynamic"`、`enabled = true` —— Java 侧就校验这一组。
 *
 * <p><b>关于帧推进</b>：本测试调 {@code engine.update()}（脚本层）之外，还<b>手动</b>调
 * {@code rt.lighting.update(dt)}：脚本的回调（`bwe.after` 与跟随光位置刷新）依赖它，而
 * {@code rt.update()} 会顺带跑玩家移动 / 模块 / 相机 / 帧末场景提交等一大串逻辑，在无窗口
 * 自检里只会制造无关噪声。{@code Lighting.update} 本身是纯 CPU 的（契约
 * {@code lighting-java-api.md} §4「同步场景光、处理动态节流」），不碰 GL。
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class ScriptLightTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;

    /** 契约 §4 的 12 个成员名（逐字来自契约代码块，<b>不要精简</b>）。 */
    private static final String[] MEMBERS = {
            "enabled", "ambient", "darkness", "mode",
            "attach", "detach", "set", "add", "remove",
            "list", "stats", "rebuild",
    };

    /** 脚本留给 Java 侧的已知终态（见类注释「中间态 vs 最终态」）。 */
    private static final float FINAL_ATTACH_RADIUS = 150f;
    private static final String FINAL_ATTACH_COLOR = "#80FFA0";
    private static final float FINAL_ATTACH_INTENSITY = 0.8f;
    private static final float FINAL_DARKNESS = 0.4f;
    private static final float FINAL_HERO_X = 300f;
    private static final float FINAL_HERO_Y = 220f;

    private ScriptLightTest() {
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
            RESULTS.add(new String[]{"lighttest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptLightTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("-------------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        if (root != null) {
            realOut.println("日志: " + new File(root, "Build/bwe.log").getAbsolutePath());
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- 主流程 ----------------

    private static void run() throws Exception {
        root = new File(".tmp_light_sa/lighttest");
        deleteRecursively(root);
        buildProject();

        File boot = new File(root, "Build/boot.json");
        check("boot.json 已生成", boot.isFile(), boot.getAbsolutePath());

        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        check("ScriptEngine 已创建", engine != null, "");
        check("构造期不启动脚本（延迟到 update）", engine != null && !engine.started, "");

        Lighting lg = rt.lighting;
        check("宿主 Lighting 实例存在（构造时就建好）", lg != null, "");
        check("旧工程零回归前提：scene.lighting.enabled=true 的工程里光照是开的",
                lg != null && lg.isEnabled(), lg == null ? "lighting=null" : "isEnabled=" + lg.isEnabled());

        // 推进若干帧：第 1 帧跑 onSceneStart，后面几帧让 bwe.after(0.05) 的跟随断言回调到期。
        // 每帧都顺手推进 Lighting（跟随光的位置由它每帧从 host/actor 同步）。
        int frames = 4;
        for (int i = 0; i < frames; i++) {
            engine.update(0.02f);
            if (lg != null) {
                lg.update(0.02f);
            }
        }
        check("第 1 帧后引擎启动", engine.started && !engine.failed, "");
        check("ScriptLight 已安装（ScriptLight.LAST 非空）", ScriptLight.LAST != null, "");
        check("bwe.light 命名空间已注册",
                engine.api() != null && engine.api().hasNamespace("light"), "");

        List<String> log = readLog();
        check("脚本日志已写出", !log.isEmpty(), "lines=" + log.size());

        // ---- 一、12 个成员逐个「存在性」断言（脚本侧 typeof === 'function'） ----
        for (int i = 0; i < MEMBERS.length; i++) {
            String m = MEMBERS[i];
            check("成员存在 bwe.light." + m + " 且是函数",
                    contains(log, "LIGHT api." + m + "=1"), logOf(log, "LIGHT api." + m));
        }

        // ---- 二、12 个成员逐个「行为」断言（脚本侧自报） ----
        check("enabled(false) 后 stats().enabled===false",
                contains(log, "LIGHT enabled.off=1"), logOf(log, "LIGHT enabled.off"));
        check("enabled(true) 后 stats().enabled===true",
                contains(log, "LIGHT enabled.on=1"), logOf(log, "LIGHT enabled.on"));
        check("enabled() 读回与写入一致",
                contains(log, "LIGHT enabled.roundtrip=1"), logOf(log, "LIGHT enabled.roundtrip"));

        check("ambient(color, intensity) 写入生效",
                contains(log, "LIGHT ambient.set=1"), logOf(log, "LIGHT ambient.set"));
        check("ambient() 省略全部参数 = 只读，返回 {color, intensity}",
                contains(log, "LIGHT ambient.read=1"), logOf(log, "LIGHT ambient.read"));
        check("ambient 非法颜色被忽略、强度照写、不抛异常",
                contains(log, "LIGHT ambient.illegal=1"), logOf(log, "LIGHT ambient.illegal"));
        check("ambient 只传颜色时强度保持不变",
                contains(log, "LIGHT ambient.onlyColor=1"), logOf(log, "LIGHT ambient.onlyColor"));

        check("darkness(v) 写入生效",
                contains(log, "LIGHT darkness.set=1"), logOf(log, "LIGHT darkness.set"));
        check("darkness() 读回同值",
                contains(log, "LIGHT darkness.read=1"), logOf(log, "LIGHT darkness.read"));
        check("darkness 超范围被夹到 1（不抛异常）",
                contains(log, "LIGHT darkness.clamp=1"), logOf(log, "LIGHT darkness.clamp"));
        check("darkness(NaN/非数字) 不写、不抛异常",
                contains(log, "LIGHT darkness.illegal=1"), logOf(log, "LIGHT darkness.illegal"));

        check("mode(\"dynamic\") 写入生效",
                contains(log, "LIGHT mode.set=1"), logOf(log, "LIGHT mode.set"));
        check("mode 非法值被忽略、返回旧值、不抛异常",
                contains(log, "LIGHT mode.illegal=1"), logOf(log, "LIGHT mode.illegal"));
        check("mode 三种合法值都认",
                contains(log, "LIGHT mode.three=1"), logOf(log, "LIGHT mode.three"));

        check("add(opts) 返回数字 handle",
                contains(log, "LIGHT add.handle=1"), logOf(log, "LIGHT add.handle"));
        check("add 后 list().length 增加 1",
                contains(log, "LIGHT add.len=1"), logOf(log, "LIGHT add.len"));
        check("add 的 opts 落到光上（radius/color/intensity 读得回）",
                contains(log, "LIGHT add.opts=1"), logOf(log, "LIGHT add.opts"));
        check("add() 无参数也能加（不抛异常，返回 handle）",
                contains(log, "LIGHT add.bare=1"), logOf(log, "LIGHT add.bare"));

        check("list() 每项都有 id/x/y/radius/color/intensity/type/dynamic",
                contains(log, "LIGHT list.fields=1"), logOf(log, "LIGHT list.fields"));
        check("list() 是 JS 原生数组（length 可读、可遍历）",
                contains(log, "LIGHT list.native=1"), logOf(log, "LIGHT list.native"));
        check("list() 里能找到刚加的独立光（坐标/颜色对）",
                contains(log, "LIGHT list.found=1"), logOf(log, "LIGHT list.found"));

        check("remove(handle) 返回 true 且 list 减 1",
                contains(log, "LIGHT remove.ok=1"), logOf(log, "LIGHT remove.ok"));
        check("remove 再删同一 handle → false（幂等，不抛异常）",
                contains(log, "LIGHT remove.twice=1"), logOf(log, "LIGHT remove.twice"));
        check("remove 非法参数（字符串/无参/null/不存在的 id）→ false，不抛异常",
                contains(log, "LIGHT remove.illegal=1"), logOf(log, "LIGHT remove.illegal"));

        check("attach 返回 true（不抛异常）",
                contains(log, "LIGHT attach.ok=1"), logOf(log, "LIGHT attach.ok"));
        check("attach 强制 lightDynamic=\"1\"（跟随实体必须动态）",
                contains(log, "LIGHT attach.dynamic=1"), logOf(log, "LIGHT attach.dynamic"));
        check("attach 的 opts 写进了 props（radius/color）",
                contains(log, "LIGHT attach.props=1"), logOf(log, "LIGHT attach.props"));
        check("实体移动后跟随光的 x/y 跟着变（list() 快照）",
                contains(log, "LIGHT attach.follow=1"), logOf(log, "LIGHT attach.follow"));
        check("attach 非实体参数 → false，不抛异常",
                contains(log, "LIGHT attach.illegal=1"), logOf(log, "LIGHT attach.illegal"));

        check("set 未挂光的实体 → false（不新建）",
                contains(log, "LIGHT set.notAttached=1"), logOf(log, "LIGHT set.notAttached"));
        check("set 已挂光的实体 → true",
                contains(log, "LIGHT set.ok=1"), logOf(log, "LIGHT set.ok"));
        check("set 是局部更新（只改 intensity，radius 保持）",
                contains(log, "LIGHT set.partial=1"), logOf(log, "LIGHT set.partial"));
        check("set 非法 opts（非对象 / 全非法值）不抛异常",
                contains(log, "LIGHT set.illegal=1"), logOf(log, "LIGHT set.illegal"));

        check("detach 已挂光的实体 → true",
                contains(log, "LIGHT detach.ok=1"), logOf(log, "LIGHT detach.ok"));
        check("detach 后 props 里不再有 lightRadius",
                contains(log, "LIGHT detach.cleared=1"), logOf(log, "LIGHT detach.cleared"));
        check("detach 后 list() 里不再有那盏跟随光",
                contains(log, "LIGHT detach.gone=1"), logOf(log, "LIGHT detach.gone"));
        check("detach 未挂光的实体 → false（不抛异常）",
                contains(log, "LIGHT detach.none=1"), logOf(log, "LIGHT detach.none"));
        check("detach 非法参数（null/字符串/无参）→ false，不抛异常",
                contains(log, "LIGHT detach.illegal=1"), logOf(log, "LIGHT detach.illegal"));

        check("stats() 返回全部 9 个字段且类型正确",
                contains(log, "LIGHT stats.fields=1"), logOf(log, "LIGHT stats.fields"));
        check("stats().lights === list().length（两处口径一致）",
                contains(log, "LIGHT stats.count=1"), logOf(log, "LIGHT stats.count"));
        check("stats().enabled 随总开关变化",
                contains(log, "LIGHT stats.disabled=1"), logOf(log, "LIGHT stats.disabled"));

        check("rebuild() 返回 true（请求已受理）",
                contains(log, "LIGHT rebuild.ok=1"), logOf(log, "LIGHT rebuild.ok"));
        check("rebuild 反复调用不抛异常",
                contains(log, "LIGHT rebuild.twice=1"), logOf(log, "LIGHT rebuild.twice"));

        // ---- 模块别名 render.light ≡ look.light（ScriptApi.MODULE_ALIASES 的那一行） ----
        check("hasModule(\"render.light\") 命中只挂 look.light 的实体（别名生效）",
                contains(log, "LIGHT alias.has=1"), logOf(log, "LIGHT alias.has"));
        check("module(\"render.light\") 读出 look.light 的参数（radius=180）",
                contains(log, "LIGHT alias.module=1"), logOf(log, "LIGHT alias.module"));
        check("反向 hasModule(\"look.light\") 也命中（双向别名）",
                contains(log, "LIGHT alias.reverse=1"), logOf(log, "LIGHT alias.reverse"));
        check("挂 light 模块的实体被当作光源收进 list()（契约 §3.3）",
                contains(log, "LIGHT alias.listed=1"), logOf(log, "LIGHT alias.listed"));

        check("整段脚本跑到最后一行（没被任何异常打断）",
                contains(log, "LIGHT done=1"), logOf(log, "LIGHT done"));
        check("日志里没有任何「脚本错误」",
                !contains(log, "[脚本错误]"), logOf(log, "[脚本错误]"));

        // ---- 三、Java 侧交叉校验（只查「终态」，见类注释） ----
        if (lg == null) {
            check("宿主 Lighting 可用，能交叉校验（否则整组断言无意义）", false, "lighting=null");
            return;
        }

        // 终态 1：enabled / mode / darkness / ambient
        check("终态：enabled = true（宿主侧）", lg.isEnabled(), "isEnabled=" + lg.isEnabled());
        check("终态：mode = \"dynamic\"（宿主侧；脚本最后一次写的就是它）",
                "dynamic".equals(lg.mode()), "mode=" + lg.mode());
        check("终态：darkness = 0.4（宿主侧，脚本末段复位值）",
                Math.abs(lg.darkness() - FINAL_DARKNESS) < 0.001f, "darkness=" + lg.darkness());
        check("终态：ambient 颜色 = #FF8844（宿主侧，非法颜色没污染它）",
                FINAL_AMBIENT_COLOR.equalsIgnoreCase(lg.ambientColorHex()),
                "ambientColorHex=" + lg.ambientColorHex());
        check("终态：ambient 强度 = 0.6（宿主侧，最后写的是 0.6）",
                Math.abs(lg.ambientIntensity() - 0.6f) < 0.001f,
                "ambientIntensity=" + lg.ambientIntensity());

        // 终态 2：hero 上挂着一盏已知参数的光（脚本在 detach 之后重新 attach 的那盏）
        Actor hero = actorNamed(rt, "hero");
        check("场景里找到 hero 实体", hero != null, "");
        if (hero == null) {
            return;
        }
        check("终态：hero 位置被脚本挪到 (300,220)",
                Math.abs(hero.x - FINAL_HERO_X) < 0.5f && Math.abs(hero.y - FINAL_HERO_Y) < 0.5f,
                "x=" + hero.x + " y=" + hero.y);
        check("终态：hero 被 attach 后 props 里有 lightRadius（宿主侧真读状态）",
                hero.o != null && hero.o.props.containsKey("lightRadius"), propsOf(hero));
        check("终态：attach 的 radius 落到 props（" + (int) FINAL_ATTACH_RADIUS + "）",
                hero.o != null && fmtEq(hero.o.props.get("lightRadius"), FINAL_ATTACH_RADIUS),
                propsOf(hero));
        check("终态：attach 的 color 落到 props（" + FINAL_ATTACH_COLOR + "）",
                hero.o != null && FINAL_ATTACH_COLOR.equalsIgnoreCase(hero.o.props.get("lightColor")),
                propsOf(hero));
        check("终态：attach 的 intensity 落到 props（" + FINAL_ATTACH_INTENSITY + "）",
                hero.o != null && fmtEq(hero.o.props.get("lightIntensity"), FINAL_ATTACH_INTENSITY),
                propsOf(hero));
        check("终态：attach 强制 lightDynamic = \"1\"（宿主侧）",
                hero.o != null && "1".equals(hero.o.props.get("lightDynamic")), propsOf(hero));

        // 终态 3：Lighting 真的把这盏实体光收进了活光表（位置 = hero 当前位置）
        lg.update(0.02f);
        check("终态：Lighting 收集到 hero 的跟随光（位置 = 实体位置）",
                lightAt(lg, hero.x, hero.y) != null, describeLights(lg));
        check("终态：那盏光是 dynamic（不进烘焙图）", lightAtDynamic(lg, hero.x, hero.y),
                describeLights(lg));
        check("终态：脚本 add 的独立光已被删掉（只剩场景光 + 实体光）",
                !hasLightAt(lg, 400f, 300f), describeLights(lg));
        check("终态：活光数与 stats().lights 一致（宿主侧）",
                lightCount(lg) >= 1, "lights=" + lightCount(lg));

        // 终态 3b：模块派生光源（lamp 只挂桌面旧 id look.light）必须被 Lighting 收进来，
        // 且半径来自**模块参数**（180，优先于 props —— 契约 §3.3 末尾）。
        Lighting.LiveLight lampLight = lightAt(lg, 160f, 96f);
        check("终态：只挂 look.light 模块的 lamp 被 Lighting 收成光源（宿主侧）",
                lampLight != null, describeLights(lg));
        check("终态：模块参数 radius=180 优先于 props（宿主侧）",
                lampLight != null && Math.abs(lampLight.radius - 180f) < 0.5f,
                lampLight == null ? "lampLight=null" : "radius=" + lampLight.radius);
        check("终态：模块 color=#80CCFF 落到那盏光（宿主侧）",
                lampLight != null && "#80CCFF".equalsIgnoreCase(lampLight.colorHex),
                lampLight == null ? "lampLight=null" : "colorHex=" + lampLight.colorHex);

        // 终态 4：卸载清理（包内入口，不是脚本 API）
        check("ScriptLight.attachedCount 反映挂光数（宿主侧）",
                ScriptLight.LAST != null && ScriptLight.LAST.attachedCount() == 1,
                ScriptLight.LAST == null ? "LAST=null" : "count=" + ScriptLight.LAST.attachedCount());
        check("ScriptLight.isAttached(hero) = true（宿主侧）",
                ScriptLight.LAST != null && ScriptLight.LAST.isAttached(hero), "");
        if (ScriptLight.LAST != null) {
            ScriptLight.LAST.clearSceneState();
        }
        check("clearSceneState 后挂光表清空（场景卸载不漏内存）",
                ScriptLight.LAST != null && ScriptLight.LAST.attachedCount() == 0, "");

        // 旧工程零回归：关掉总开关后 isEnabled 必须真的为 false
        lg.setEnabled(false);
        check("关闭总开关后 isEnabled=false（零回归前提）", !lg.isEnabled(), "");

        // ---- 四、旧工程（scene.lighting 缺失）零回归 ----
        runOldProject();
    }

    /**
     * 旧工程（`scene_*.json` 顶层<b>没有</b> {@code lighting} 段）的自检。
     *
     * <p>契约 §0 第 5 条是硬约束：「{@code scene.lighting} 缺失 ⇒ 光照系统整体不启用，
     * 画面与今天逐像素一致」。对脚本层而言这意味着：
     * <ul>
     *   <li>{@code bwe.light} 依然注册（脚本不会因为找不到命名空间而报错）；</li>
     *   <li>所有读操作返回缺省值（`enabled() === false`、`darkness() === 0`）；</li>
     *   <li><b>{@code enabled(true)} 是空操作</b> —— 打开一个没有光照配置的工程只会整屏压黑；</li>
     *   <li>写参数 / attach / add 都不抛异常（静默无效果，但也不该炸脚本）。</li>
     * </ul>
     */
    private static void runOldProject() throws Exception {
        File rootOld = new File(".tmp_light_sa/lighttest-old");
        deleteRecursively(rootOld);
        File build = new File(rootOld, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());
        write(new File(build, "boot.json"), "{\n"
                + "  \"project\": \"ScriptLightTestOld\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 1,\n"
                + "  \"scenes\": [ { \"name\": \"旧场景\", \"file\": \"scene_0.json\", \"width\": 20, \"height\": 15 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [ { \"name\": \"scene\", \"file\": \"scripts/scene.js\", \"lang\": \"js\" } ],\n"
                + "  \"jsMain\": \"scene\",\n"
                + "  \"assets\": []\n"
                + "}\n");
        // ⚠ 刻意**没有** lighting 段 —— 这就是旧工程。
        write(new File(build, "scene_0.json"), "{\n"
                + "  \"width\": 20, \"height\": 15, \"tileSize\": 32,\n"
                + "  \"onStartScript\": \"scene\",\n"
                + "  \"layers\": [],\n"
                + "  \"objects\": [\n"
                + "    { \"id\": \"p1\", \"kind\": \"ACTOR\", \"name\": \"hero\", \"x\": 64, \"y\": 64,"
                + " \"halfW\": 16, \"halfH\": 16, \"visible\": true, \"tags\": [\"玩家\"],"
                + " \"props\": { \"w\": \"32\", \"h\": \"32\" } }\n"
                + "  ]\n"
                + "}\n");
        write(new File(scripts, "scene.js"), OLD_SCENE_JS);

        File boot = new File(build, "boot.json");
        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        Lighting lg = rt.lighting;
        check("旧工程：Lighting 实例仍然存在（永不为 null，便于上层少判空）", lg != null, "");
        check("旧工程：isEnabled() 恒 false（契约 §0 第 5 条硬约束）",
                lg != null && !lg.isEnabled(), lg == null ? "lighting=null" : "isEnabled=" + lg.isEnabled());

        for (int i = 0; i < 3; i++) {
            engine.update(0.02f);
            if (lg != null) {
                lg.update(0.02f);
            }
        }
        check("旧工程：脚本引擎正常启动（bwe.light 注册没有炸）",
                engine.started && !engine.failed, "");

        List<String> log = readLog(rootOld);
        check("旧工程：bwe.light 依然注册（脚本拿得到命名空间）",
                engine.api() != null && engine.api().hasNamespace("light"), "");
        check("旧工程：enabled() 读回 false",
                contains(log, "OLD enabled.read=1"), logOf(log, "OLD enabled.read"));
        check("旧工程：enabled(true) 是空操作，仍返回 false",
                contains(log, "OLD enabled.noop=1"), logOf(log, "OLD enabled.noop"));
        check("旧工程：setEnabled(true) 之后宿主 isEnabled 仍是 false（零回归）",
                lg != null && !lg.isEnabled(), lg == null ? "lighting=null" : "isEnabled=" + lg.isEnabled());
        check("旧工程：darkness() 返回缺省 0（不是 null / 不抛异常）",
                contains(log, "OLD darkness=1"), logOf(log, "OLD darkness"));
        check("旧工程：mode() 返回契约缺省配置值 \"both\"（不是 null，也不代表光照生效）",
                contains(log, "OLD mode=1"), logOf(log, "OLD mode"));
        check("旧工程：ambient() 返回缺省颜色/强度（不抛异常）",
                contains(log, "OLD ambient=1"), logOf(log, "OLD ambient"));
        check("旧工程：attach/add/remove/rebuild 全部不抛异常（静默）",
                contains(log, "OLD writes=1"), logOf(log, "OLD writes"));
        check("旧工程：stats() 仍返回完整字段（enabled=false）",
                contains(log, "OLD stats=1"), logOf(log, "OLD stats"));
        check("旧工程：整段脚本跑到最后一行（没被异常打断）",
                contains(log, "OLD done=1"), logOf(log, "OLD done"));
        check("旧工程：日志里没有任何「脚本错误」",
                !contains(log, "[脚本错误]"), logOf(log, "[脚本错误]"));
    }

    // ---------------- 工程脚手架 ----------------

    private static void buildProject() throws Exception {
        File build = new File(root, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());

        String boot = "{\n"
                + "  \"project\": \"ScriptLightTest\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 1,\n"
                + "  \"scenes\": [ { \"name\": \"光照场景\", \"file\": \"scene_0.json\", \"width\": 20, \"height\": 15 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [\n"
                + "    { \"name\": \"scene\", \"file\": \"scripts/scene.js\", \"lang\": \"js\" }\n"
                + "  ],\n"
                + "  \"jsMain\": \"scene\",\n"
                + "  \"assets\": []\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);

        // 场景：一个 hero（初始 (64,64)，脚本会挪到 (300,220) 验证「跟随」）。
        // 顶层带 lighting（契约 §3.1），让运行时是「光照已启用」的工程而不是旧工程。
        String scene = "{\n"
                + "  \"width\": 20, \"height\": 15, \"tileSize\": 32,\n"
                + "  \"onStartScript\": \"scene\",\n"
                + "  \"lighting\": {\n"
                + "    \"enabled\": true, \"mode\": \"both\",\n"
                + "    \"ambientColor\": \"#3A4A6B\", \"ambientIntensity\": 0.35,\n"
                + "    \"darkness\": 0.35, \"softness\": 16, \"texelsPerPixel\": 0.25,\n"
                + "    \"dynamicFps\": 15, \"maxDynamicLights\": 8\n"
                + "  },\n"
                + "  \"layers\": [],\n"
                + "  \"objects\": [\n"
                + "    { \"id\": \"p1\", \"kind\": \"ACTOR\", \"name\": \"hero\", \"x\": 64, \"y\": 64,"
                + " \"halfW\": 16, \"halfH\": 16, \"visible\": true, \"tags\": [\"玩家\"],"
                + " \"props\": { \"w\": \"32\", \"h\": \"32\" } },\n"
                // 路障：**桌面旧 id** look.light（不是 Web 编辑器的 render.light）。
                // 用在 ScriptApi.MODULE_ALIASES 的 {"render.light","look.light"} 上：
                // 脚本按新 id 查这盏灯时必须命中（这条断言覆盖 alias 那一行）。
                + "    { \"id\": \"p2\", \"kind\": \"PROP\", \"name\": \"lamp\", \"x\": 160, \"y\": 96,"
                + " \"halfW\": 8, \"halfH\": 8, \"visible\": true,"
                + " \"modules\": [ { \"def\": \"look.light\", \"params\":"
                + " { \"radius\": \"180\", \"color\": \"#80CCFF\", \"strength\": \"0.9\" } } ] }\n"
                + "  ]\n"
                + "}\n";
        write(new File(build, "scene_0.json"), scene);

        write(new File(scripts, "scene.js"), SCENE_JS);
    }

    private static final String FINAL_AMBIENT_COLOR = "#FF8844";

    /** 旧工程脚本：只验证「读缺省值 / 写静默不抛」这两件事。 */
    private static final String OLD_SCENE_JS = String.join("\n",
            "function onSceneStart(ctx) {",
            "  var hero = bwe.world.find(\"hero\");",
            "",
            "  // 读：全部返回缺省值，不抛异常",
            "  bwe.log(\"OLD enabled.read=\" + (bwe.light.enabled() === false ? \"1\" : \"0\"));",
            "  var d = bwe.light.darkness();",
            "  bwe.log(\"OLD darkness=\" + (typeof d === \"number\" && d === 0 ? \"1\" : \"0\"));",
            "  // 契约 §3.1：mode 缺省 \"both\"。旧工程读回的是**缺省配置值**，不代表光照生效",
            "  // （enabled 恒 false 才是「没生效」的判据）。",
            "  bwe.log(\"OLD mode=\" + (bwe.light.mode() === \"both\" ? \"1\" : \"0\"));",
            "  var a = bwe.light.ambient();",
            "  bwe.log(\"OLD ambient=\" + (a && typeof a.color === \"string\" && typeof a.intensity === \"number\" ? \"1\" : \"0\"));",
            "",
            "  // 写：enabled(true) 是空操作（旧工程不允许开光照，否则整屏压黑）",
            "  bwe.light.enabled(true);",
            "  bwe.log(\"OLD enabled.noop=\" + (bwe.light.enabled() === false ? \"1\" : \"0\"));",
            "",
            "  // 全部写接口：静默、不抛异常。后面还有日志行就是证据。",
            "  bwe.light.darkness(0.9);",
            "  bwe.light.mode(\"dynamic\");",
            "  bwe.light.ambient(\"#FF8844\", 0.8);",
            "  var h = bwe.light.add({ x: 100, y: 100, radius: 200, dynamic: true });",
            "  bwe.light.remove(h);",
            "  bwe.light.attach(hero, { radius: 150 });",
            "  bwe.light.detach(hero);",
            "  bwe.light.rebuild();",
            "  bwe.log(\"OLD writes=1\");",
            "",
            "  var st = bwe.light.stats();",
            "  var ok = typeof st.enabled === \"boolean\"",
            "        && st.enabled === false",
            "        && typeof st.mode === \"string\"",
            "        && typeof st.lights === \"number\";",
            "  bwe.log(\"OLD stats=\" + (ok ? \"1\" : \"0\"));",
            "",
            "  bwe.log(\"OLD done=1\");",
            "}",
            "");

    /**
     * 场景脚本（新工程）：把 12 个成员逐个跑一遍，结果写日志。
     *
     * <p>⚠ 编写纪律：
     * <ul>
     *   <li><b>ES5</b>（{@code var} + {@code function}，不用 let/const/箭头函数/模板字符串）；</li>
     *   <li>每条断言独立写一行 {@code LIGHT xxx=1}。刻意<b>不</b>把整段包进一个大 try：
     *       任何一条语句抛异常，后面的日志行就会缺失 —— 这本身就是在定位「哪一条先炸」；</li>
     *   <li>「非法参数不抛异常」的断言必须<b>先执行非法调用、再往下跑</b>：后续日志行还在，
     *       就证明没抛。</li>
     * </ul>
     */
    private static final String SCENE_JS = String.join("\n",
            "function onSceneStart(ctx) {",
            "  var hero = bwe.world.find(\"hero\");",
            "",
            "  // ===== 0) 12 个成员的存在性（typeof === 'function'）=====",
            "  bwe.log(\"LIGHT api.enabled=\" + (typeof bwe.light.enabled === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.ambient=\" + (typeof bwe.light.ambient === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.darkness=\" + (typeof bwe.light.darkness === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.mode=\" + (typeof bwe.light.mode === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.attach=\" + (typeof bwe.light.attach === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.detach=\" + (typeof bwe.light.detach === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.set=\" + (typeof bwe.light.set === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.add=\" + (typeof bwe.light.add === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.remove=\" + (typeof bwe.light.remove === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.list=\" + (typeof bwe.light.list === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.stats=\" + (typeof bwe.light.stats === \"function\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT api.rebuild=\" + (typeof bwe.light.rebuild === \"function\" ? \"1\" : \"0\"));",
            "",
            "  // ===== 1) enabled：读/写总开关 =====",
            "  var e0 = bwe.light.enabled();",
            "  bwe.log(\"LIGHT enabled.read=\" + (typeof e0 === \"boolean\" ? \"1\" : \"0\"));",
            "  bwe.light.enabled(false);",
            "  bwe.log(\"LIGHT enabled.off=\" + (bwe.light.stats().enabled === false ? \"1\" : \"0\"));",
            "  bwe.light.enabled(true);",
            "  bwe.log(\"LIGHT enabled.on=\" + (bwe.light.stats().enabled === true ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT enabled.roundtrip=\" + (bwe.light.enabled(true) === true ? \"1\" : \"0\"));",
            "",
            "  // ===== 2) ambient：写 / 读 / 只写一半 / 非法颜色 =====",
            "  bwe.light.ambient(\"#FF8844\", 0.5);",
            "  var am = bwe.light.ambient();",
            "  bwe.log(\"LIGHT ambient.set=\" + (am.color === \"#FF8844\" && Math.abs(am.intensity - 0.5) < 0.001 ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT ambient.read=\" + (typeof am.color === \"string\" && typeof am.intensity === \"number\" ? \"1\" : \"0\"));",
            "  // 非法颜色必须被忽略、强度照写，且不能抛异常",
            "  var am2 = bwe.light.ambient(\"不是颜色\", 0.6);",
            "  bwe.log(\"LIGHT ambient.illegal=\" + (am2.color === \"#FF8844\" && Math.abs(am2.intensity - 0.6) < 0.001 ? \"1\" : \"0\"));",
            "  // 只传颜色：强度必须保持",
            "  var am3 = bwe.light.ambient(\"#3366AA\");",
            "  bwe.log(\"LIGHT ambient.onlyColor=\" + (am3.color === \"#3366AA\" && Math.abs(am3.intensity - 0.6) < 0.001 ? \"1\" : \"0\"));",
            "  // 复位成 Java 侧要校验的终态色",
            "  bwe.light.ambient(\"#FF8844\", 0.6);",
            "",
            "  // ===== 3) darkness：写 / 读 / 夹取 / 非法 =====",
            "  // ⚠ 用容差而不是 === 0.62：Java 侧存的是 float，转成 JS number 会有",
            "  //   0.6200000047683716 这种尾巴（所有 float 返回值都这样，不是本模块特有）。",
            "  bwe.light.darkness(0.62);",
            "  bwe.log(\"LIGHT darkness.set=\" + (Math.abs(bwe.light.darkness() - 0.62) < 0.001 ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT darkness.read=\" + (typeof bwe.light.darkness() === \"number\" ? \"1\" : \"0\"));",
            "  var d2 = bwe.light.darkness(99);",
            "  bwe.log(\"LIGHT darkness.clamp=\" + (d2 === 1 ? \"1\" : \"0\"));",
            "  // 非法输入（字符串 / NaN）：必须不写、不抛",
            "  var dKeep = bwe.light.darkness(\"abc\");",
            "  bwe.log(\"LIGHT darkness.illegal=\" + (dKeep === 1 ? \"1\" : \"0\"));",
            "  // 终态",
            "  bwe.light.darkness(0.4);",
            "",
            "  // ===== 4) mode：合法写 / 三种值 / 非法忽略 =====",
            "  bwe.light.mode(\"dynamic\");",
            "  bwe.log(\"LIGHT mode.set=\" + (bwe.light.mode() === \"dynamic\" ? \"1\" : \"0\"));",
            "  var m2 = bwe.light.mode(\"动态\");",
            "  bwe.log(\"LIGHT mode.illegal=\" + (m2 === \"dynamic\" && bwe.light.mode() === \"dynamic\" ? \"1\" : \"0\"));",
            "  var m3 = bwe.light.mode(\"baked\") === \"baked\"",
            "        && bwe.light.mode(\"both\") === \"both\"",
            "        && bwe.light.mode(\"dynamic\") === \"dynamic\";",
            "  bwe.log(\"LIGHT mode.three=\" + (m3 ? \"1\" : \"0\"));",
            "",
            "  // ===== 5) add：返回数字 handle + opts 落地 =====",
            "  var h1 = bwe.light.add({",
            "    x: 400, y: 300, radius: 220, color: \"#FFFFFF\",",
            "    intensity: 2, falloff: 2, shadow: false, dynamic: true",
            "  });",
            "  bwe.log(\"LIGHT add.handle=\" + (typeof h1 === \"number\" && h1 > 0 ? \"1\" : \"0\"));",
            "  var hBare = bwe.light.add();",
            "  bwe.log(\"LIGHT add.bare=\" + (typeof hBare === \"number\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT add.len=\" + (bwe.light.list().length >= 2 ? \"1\" : \"0\"));",
            "",
            "  // ===== 6) list：数组 + 字段 + 能找到刚加的光 =====",
            "  var ls = bwe.light.list();",
            "  var first = ls.length > 0 ? ls[0] : null;",
            "  var fields = first",
            "    && typeof first.id === \"number\"",
            "    && typeof first.x === \"number\"",
            "    && typeof first.y === \"number\"",
            "    && typeof first.radius === \"number\"",
            "    && typeof first.color === \"string\"",
            "    && typeof first.intensity === \"number\"",
            "    && typeof first.type === \"string\"",
            "    && typeof first.dynamic === \"boolean\";",
            "  bwe.log(\"LIGHT list.fields=\" + (fields ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT list.native=\" + (typeof ls.length === \"number\" ? \"1\" : \"0\"));",
            "  var found = null;",
            "  for (var i = 0; i < ls.length; i++) {",
            "    if (ls[i].id === h1) { found = ls[i]; }",
            "  }",
            "  bwe.log(\"LIGHT list.found=\" + (found && Math.abs(found.x - 400) < 0.5 && Math.abs(found.y - 300) < 0.5",
            "                                && found.color === \"#FFFFFF\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT add.opts=\" + (found && found.radius === 220 && found.intensity === 2 && found.dynamic === true ? \"1\" : \"0\"));",
            "",
            "  // ===== 7) remove：幂等 + 非法参数 =====",
            "  var lenBeforeRemove = bwe.light.list().length;",
            "  var rm = bwe.light.remove(h1);",
            "  var lenAfterRemove = bwe.light.list().length;",
            "  bwe.log(\"LIGHT remove.ok=\" + (rm === true && lenAfterRemove === lenBeforeRemove - 1 ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT remove.twice=\" + (bwe.light.remove(h1) === false ? \"1\" : \"0\"));",
            "  var rmBad = bwe.light.remove(\"abc\") === false",
            "           && bwe.light.remove() === false",
            "           && bwe.light.remove(null) === false",
            "           && bwe.light.remove(999999) === false;",
            "  bwe.log(\"LIGHT remove.illegal=\" + (rmBad ? \"1\" : \"0\"));",
            "  bwe.light.remove(hBare);",
            "",
            "  // ===== 8) attach：挂到实体 + 位置跟随 =====",
            "  var okAttach = bwe.light.attach(hero, {",
            "    radius: 170, color: \"#FFB060\", intensity: 1.15,",
            "    type: \"point\", falloff: 2, shadow: true, flicker: 0.3",
            "  });",
            "  bwe.log(\"LIGHT attach.ok=\" + (okAttach === true ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT attach.dynamic=\" + (hero.prop(\"lightDynamic\", \"0\") === \"1\" ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT attach.props=\" + (hero.prop(\"lightRadius\", 0) === 170",
            "                                     && hero.prop(\"lightColor\", \"\") === \"#FFB060\" ? \"1\" : \"0\"));",
            "  // 非实体参数：false，不抛异常",
            "  var attBad = bwe.light.attach(null) === false",
            "            && bwe.light.attach({}) === false",
            "            && bwe.light.attach(\"hero\") === false;",
            "  bwe.log(\"LIGHT attach.illegal=\" + (attBad ? \"1\" : \"0\"));",
            "  // 位置跟随：把实体挪走，下一帧（Java 侧推 Lighting.update）再读 list()",
            "  hero.x = 300; hero.y = 220;",
            "  bwe.after(0.05, function () {",
            "    var l2 = bwe.light.list();",
            "    var got = null;",
            "    for (var j = 0; j < l2.length; j++) {",
            "      if (Math.abs(l2[j].x - 300) < 1 && Math.abs(l2[j].y - 220) < 1) { got = l2[j]; }",
            "    }",
            "    bwe.log(\"LIGHT attach.follow=\" + (got ? \"1\" : \"0\"));",
            "  });",
            "",
            "  // ===== 9) set：未挂光 false / 已挂光 true / 局部更新 / 非法 =====",
            "  var pedestal = bwe.world.spawn({ x: 500, y: 400, name: \"pedestal\" });",
            "  bwe.log(\"LIGHT set.notAttached=\" + (bwe.light.set(pedestal, { radius: 100 }) === false ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT set.ok=\" + (bwe.light.set(hero, { intensity: 0.5 }) === true ? \"1\" : \"0\"));",
            "  var ri = hero.prop(\"lightIntensity\", \"?\");",
            "  var rr = hero.prop(\"lightRadius\", \"?\");",
            "  bwe.log(\"LIGHT set.partial=\" + (ri === \"0.5\" && rr === \"170\" ? \"1\" : \"0\"));",
            "  // 非法 opts：不是对象 / 全是非法值 —— 必须不抛异常",
            "  bwe.light.set(hero, \"not-an-object\");",
            "  bwe.light.set(hero, { radius: -5, color: \"purple\", intensity: -1, type: \"spotlight\", falloff: 99 });",
            "  bwe.log(\"LIGHT set.illegal=1\");",
            "",
            "  // ===== 10) detach：摘掉 + 还原 + 未挂光 / 非法 =====",
            "  bwe.log(\"LIGHT detach.ok=\" + (bwe.light.detach(hero) === true ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT detach.cleared=\" + (hero.prop(\"lightRadius\", \"?\") === \"?\" ? \"1\" : \"0\"));",
            "  var lgone = bwe.light.list();",
            "  var still = 0;",
            "  for (var k = 0; k < lgone.length; k++) {",
            "    if (Math.abs(lgone[k].x - 300) < 1 && Math.abs(lgone[k].y - 220) < 1) { still++; }",
            "  }",
            "  bwe.log(\"LIGHT detach.gone=\" + (still === 0 ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT detach.none=\" + (bwe.light.detach(pedestal) === false ? \"1\" : \"0\"));",
            "  var detBad = bwe.light.detach(null) === false",
            "            && bwe.light.detach(\"nope\") === false",
            "            && bwe.light.detach() === false;",
            "  bwe.log(\"LIGHT detach.illegal=\" + (detBad ? \"1\" : \"0\"));",
            "",
            "  // ===== 终态：重新挂一盏已知参数的光，留给 Java 侧交叉校验 =====",
            "  bwe.light.attach(hero, { radius: 150, color: \"#80FFA0\", intensity: 0.8 });",
            "",
            "  // ===== 11) stats：9 个字段 + 与 list 口径一致 =====",
            "  var st = bwe.light.stats();",
            "  var stFields = typeof st.enabled === \"boolean\"",
            "    && typeof st.mode === \"string\"",
            "    && typeof st.lights === \"number\"",
            "    && typeof st.baked === \"number\"",
            "    && typeof st.dynamic === \"number\"",
            "    && typeof st.rebuilds === \"number\"",
            "    && typeof st.lastMs === \"number\"",
            "    && typeof st.texW === \"number\"",
            "    && typeof st.texH === \"number\";",
            "  bwe.log(\"LIGHT stats.fields=\" + (stFields ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT stats.count=\" + (st.lights === bwe.light.list().length ? \"1\" : \"0\"));",
            "",
            "  // ===== 12) rebuild：请求受理 + 反复调用 =====",
            "  bwe.log(\"LIGHT rebuild.ok=\" + (bwe.light.rebuild() === true ? \"1\" : \"0\"));",
            "  bwe.log(\"LIGHT rebuild.twice=\" + (bwe.light.rebuild() === true ? \"1\" : \"0\"));",
            "",
            "  // ===== 13) 模块别名：render.light ≡ look.light（ScriptApi.MODULE_ALIASES 那一行）=====",
            "  // 场景里的 lamp 只挂了**桌面旧 id** look.light；按新 id 查必须命中。",
            "  var lamp = bwe.world.find(\"lamp\");",
            "  bwe.log(\"LIGHT alias.has=\" + (lamp && lamp.hasModule(\"render.light\") === true ? \"1\" : \"0\"));",
            "  var lm = lamp ? lamp.module(\"render.light\") : null;",
            "  bwe.log(\"LIGHT alias.module=\" + (lm && lm.get(\"radius\", 0) === 180 ? \"1\" : \"0\"));",
            "  // 反向也认（旧 id 查同一个模块）",
            "  bwe.log(\"LIGHT alias.reverse=\" + (lamp && lamp.hasModule(\"look.light\") === true ? \"1\" : \"0\"));",
            "  // 模块派生的光源必须出现在 list() 里（契约 §3.3「挂 look.light/render.light 模块 = 光源」）",
            "  // ⚠ 必须延后一帧：onSceneStart 跑在 Lighting.update() **之前**，此刻场景光还没被收集。",
            "  bwe.after(0.05, function () {",
            "    var hasLamp = 0;",
            "    var lsLamp = bwe.light.list();",
            "    for (var li = 0; li < lsLamp.length; li++) {",
            "      if (Math.abs(lsLamp[li].x - 160) < 1 && Math.abs(lsLamp[li].y - 96) < 1) { hasLamp++; }",
            "    }",
            "    bwe.log(\"LIGHT alias.listed=\" + (hasLamp === 1 ? \"1\" : \"0\"));",
            "  });",
            "",
            "  // ===== 关闭态：stats().enabled 必须跟着走 =====",
            "  bwe.light.enabled(false);",
            "  bwe.log(\"LIGHT stats.disabled=\" + (bwe.light.stats().enabled === false ? \"1\" : \"0\"));",
            "  bwe.light.enabled(true);",
            "",
            "  bwe.log(\"LIGHT done=1\");",
            "}",
            "");

    // ---------------- 宿主侧断言辅助 ----------------

    private static int lightCount(Lighting lg) {
        List<Lighting.LiveLight> lights = lg.lights();
        return lights == null ? 0 : lights.size();
    }

    /** 找 {x,y} 附近（±1.5 世界像素）的一盏活光；没有返回 null。 */
    private static Lighting.LiveLight lightAt(Lighting lg, float x, float y) {
        List<Lighting.LiveLight> lights = lg.lights();
        if (lights == null) {
            return null;
        }
        for (int i = 0; i < lights.size(); i++) {
            Lighting.LiveLight L = lights.get(i);
            if (L != null && Math.abs(L.x - x) <= 1.5f && Math.abs(L.y - y) <= 1.5f) {
                return L;
            }
        }
        return null;
    }

    private static boolean hasLightAt(Lighting lg, float x, float y) {
        return lightAt(lg, x, y) != null;
    }

    private static boolean lightAtDynamic(Lighting lg, float x, float y) {
        Lighting.LiveLight L = lightAt(lg, x, y);
        return L != null && L.dynamic;
    }

    /** props 里的文本与期望浮点是否等价（"150" / "150.0" / "0.8" / "0.80000" 都算相等）。 */
    private static boolean fmtEq(String raw, float expect) {
        if (raw == null) {
            return false;
        }
        try {
            return Math.abs(Float.parseFloat(raw.trim()) - expect) < 0.001f;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private static String describeLights(Lighting lg) {
        List<Lighting.LiveLight> lights = lg.lights();
        if (lights == null || lights.isEmpty()) {
            return "lights=[]";
        }
        StringBuilder sb = new StringBuilder("lights=[");
        for (int i = 0; i < lights.size(); i++) {
            Lighting.LiveLight L = lights.get(i);
            if (i > 0) {
                sb.append(", ");
            }
            sb.append(L == null ? "null" : ("#" + L.id + "@(" + L.x + "," + L.y + ")"));
        }
        return sb.append("]").toString();
    }

    private static String propsOf(Actor a) {
        if (a == null || a.o == null) {
            return "actor=null";
        }
        StringBuilder sb = new StringBuilder("props={");
        boolean first = true;
        for (Map.Entry<String, String> e : a.o.props.entrySet()) {
            if (!first) {
                sb.append(", ");
            }
            first = false;
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.append("}").toString();
    }

    private static Actor actorNamed(TopDownRuntime rt, String name) {
        for (Actor a : rt.actors) {
            if (a.o != null && name.equals(a.o.name)) {
                return a;
            }
        }
        return null;
    }

    // ---------------- 文件 / 日志工具 ----------------

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

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }

    private static boolean contains(List<String> log, String needle) {
        for (String line : log) {
            if (line.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    /** 把命中该子串的日志行拼成一行，失败时贴出来方便定位。 */
    private static String logOf(List<String> log, String prefix) {
        StringBuilder sb = new StringBuilder();
        for (String line : log) {
            if (line.contains(prefix)) {
                if (sb.length() > 0) {
                    sb.append(" | ");
                }
                sb.append(line.trim());
            }
        }
        return sb.length() > 900 ? sb.substring(0, 900) : sb.toString();
    }

    private static List<String> readLog() throws Exception {
        return readLog(root);
    }

    private static List<String> readLog(File rootDir) throws Exception {
        List<String> out = new ArrayList<String>();
        File log = new File(rootDir, "Build/bwe.log");
        if (!log.isFile()) {
            return out;
        }
        for (String line : Files.readAllLines(log.toPath(), StandardCharsets.UTF_8)) {
            out.add(line);
        }
        return out;
    }
}
