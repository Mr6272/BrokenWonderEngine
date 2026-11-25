package Studio.runtime;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 脚本「公开字段」自检（契约 {@code docs/scripting-api.md} §1.4）。
 *
 * <p>要钉住的是一件事，也是这件事**唯一**难的地方：<b>参数必须按对象作用域生效</b>。
 * 同一个脚本挂两个对象、各改各的速度 —— 如果实现成"全局参数表"，最后初始化的那个会把
 * 前一个覆盖掉，而两个对象都不会报错，只是行为悄悄变成一样。光看代码看不出来，
 * 必须让两个对象在**同一帧里**各自报一次自己的参数才能断言。
 *
 * <p>断言覆盖：
 * <ol>
 *   <li>顶层 {@code bwe.params({...})} 被登记，且返回值与默认值一致；</li>
 *   <li>{@code ctx.params} 与 {@code bwe.params()} 都能拿到「默认值 ∪ 覆盖值」；</li>
 *   <li><b>A 用 100（默认）、B 用 250（覆盖），同一帧内互不影响</b> —— 作用域的关键断言；</li>
 *   <li>覆盖值里的未知键被忽略（脚本没声明的参数不该冒出来）；</li>
 *   <li>坏 JSON 的覆盖值 ⇒ 退回默认值，不抛异常、不中断脚本；</li>
 *   <li>没有覆盖值的对象拿到的是默认值本身；</li>
 *   <li>场景脚本（无 self）里 {@code ctx.params} 为 null，{@code bwe.params()} 不炸。</li>
 * </ol>
 *
 * <p>无窗口、无 GL：只跑 {@code ScriptEngine}。全部通过退出码 0，任一失败 1。
 */
public final class ScriptParamsTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;

    private ScriptParamsTest() {
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
            RESULTS.add(new String[]{"ScriptParamsTest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptParamsTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("--------------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        if (root != null) {
            realOut.println("日志: " + new File(root, "Build/bwe.log").getAbsolutePath());
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- 主流程 ----------------

    private static void run() throws Exception {
        root = new File(".tmp_rel8/scriptparams");
        deleteRecursively(root);
        buildProject();

        File boot = new File(root, "Build/boot.json");
        check("boot.json 已生成", boot.isFile(), boot.getAbsolutePath());

        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        check("ScriptEngine 已创建", engine != null, "");

        // 第 1 帧：脚本顶层执行 + onStart 派发
        engine.update(0.02f);
        check("引擎启动成功", engine.started && !engine.failed, "");
        // 第 2 帧：onUpdate 派发（参数在这里读第二遍，验证跨帧一致）
        engine.update(0.02f);

        List<String> log = readLog();

        // ---- 1. 顶层声明被登记 ----
        check("顶层 bwe.params({...}) 返回默认值（a.speed=100）",
                "100".equals(logValue(log, "PARAMS decl.speed=")),
                String.valueOf(logValue(log, "PARAMS decl.speed=")));
        check("顶层声明里 bool 默认值正确（alive=true）",
                "true".equals(logValue(log, "PARAMS decl.alive=")),
                String.valueOf(logValue(log, "PARAMS decl.alive=")));
        check("中文键在顶层声明里也能读（中文键=值）",
                "值".equals(logValue(log, "PARAMS decl.cn=")),
                String.valueOf(logValue(log, "PARAMS decl.cn=")));

        // ---- 2. ctx.params 与 bwe.params() 等价 ----
        check("ctx.params 可用（a）", "100".equals(logValue(log, "PARAMS a.ctx=")),
                String.valueOf(logValue(log, "PARAMS a.ctx=")));
        check("bwe.params() 与 ctx.params 等价（a）",
                "100".equals(logValue(log, "PARAMS a.fn=")),
                String.valueOf(logValue(log, "PARAMS a.fn=")));

        // ---- 3. ★ 按对象作用域：同一脚本、两个对象、参数不同 ----
        check("对象A 用默认值 100（没覆盖）", "100".equals(logValue(log, "PARAMS a.speed=")),
                String.valueOf(logValue(log, "PARAMS a.speed=")));
        check("对象B 用覆盖值 250（同一个脚本）", "250".equals(logValue(log, "PARAMS b.speed=")),
                String.valueOf(logValue(log, "PARAMS b.speed=")));
        check("★ A 没有被 B 的覆盖值污染（同一帧内）",
                "100".equals(logValue(log, "PARAMS a.speed=")),
                String.valueOf(logValue(log, "PARAMS a.speed=")));
        check("★ B 的字符串覆盖值生效（label=快速怪）",
                "快速怪".equals(logValue(log, "PARAMS b.label=")),
                String.valueOf(logValue(log, "PARAMS b.label=")));
        check("A 的字符串仍是默认值（label=小怪）",
                "小怪".equals(logValue(log, "PARAMS a.label=")),
                String.valueOf(logValue(log, "PARAMS a.label=")));
        check("B 的 bool 覆盖值生效（alive=false）",
                "false".equals(logValue(log, "PARAMS b.alive=")),
                String.valueOf(logValue(log, "PARAMS b.alive=")));
        check("A 的 bool 保持默认（alive=true）",
                "true".equals(logValue(log, "PARAMS a.alive=")),
                String.valueOf(logValue(log, "PARAMS a.alive=")));

        // onUpdate 第二帧读到的值必须一致（不是只在 onStart 那一刻对）
        check("onUpdate 里参数仍然按对象解析（a=100）",
                "100".equals(logValue(log, "PARAMS a.upd=")),
                String.valueOf(logValue(log, "PARAMS a.upd=")));
        check("onUpdate 里参数仍然按对象解析（b=250）",
                "250".equals(logValue(log, "PARAMS b.upd=")),
                String.valueOf(logValue(log, "PARAMS b.upd=")));

        // ---- 4. 未知键被忽略 ----
        check("覆盖值里的未知键被忽略（ghost 不出现）",
                "undefined".equals(logValue(log, "PARAMS b.ghost=")),
                String.valueOf(logValue(log, "PARAMS b.ghost=")));

        // ---- 5. 坏 JSON ⇒ 退回默认值 ----
        check("坏 JSON 的覆盖值 ⇒ 退回默认值（c=100）",
                "100".equals(logValue(log, "PARAMS c.speed=")),
                String.valueOf(logValue(log, "PARAMS c.speed=")));
        check("坏 JSON 不影响脚本继续执行（c 的 onStart 跑完了）",
                "1".equals(logValue(log, "PARAMS c.started=")),
                String.valueOf(logValue(log, "PARAMS c.started=")));

        // ---- 6. 场景脚本没有 self ----
        check("场景脚本 ctx.params 为 null", "null".equals(logValue(log, "PARAMS scene.ctx=")),
                String.valueOf(logValue(log, "PARAMS scene.ctx=")));
        check("场景脚本里 bwe.params() 不抛异常", "ok".equals(logValue(log, "PARAMS scene.fn=")),
                String.valueOf(logValue(log, "PARAMS scene.fn=")));

        // ---- 7. 默认值表独立（脚本改自己的字面量不影响缓存）----
        check("默认值表是拷贝：脚本改 defs 后其他对象不受影响",
                "100".equals(logValue(log, "PARAMS a.afterMutate=")),
                String.valueOf(logValue(log, "PARAMS a.afterMutate=")));

        // 没有 [脚本错误] 行
        boolean anyError = false;
        StringBuilder errLines = new StringBuilder();
        for (String line : log) {
            if (line.startsWith("[脚本错误]")) {
                anyError = true;
                errLines.append(line).append(" | ");
            }
        }
        check("日志里没有 [脚本错误]", !anyError, errLines.toString());
    }

    // ---------------- 工程构造 ----------------

    private static void buildProject() throws Exception {
        File build = new File(root, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());

        String boot = "{\n"
                + "  \"project\": \"ScriptParamsTest\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 0,\n"
                + "  \"scenes\": [ { \"name\": \"参数自检\", \"file\": \"scene_0.json\", \"width\": 20, \"height\": 15 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [\n"
                + "    { \"name\": \"scene\", \"file\": \"scripts/scene.js\", \"lang\": \"js\" },\n"
                + "    { \"name\": \"enemy\", \"file\": \"scripts/enemy.js\", \"lang\": \"js\" }\n"
                + "  ]\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);

        StringBuilder scene = new StringBuilder();
        scene.append("{\n  \"width\": 20, \"height\": 15, \"tileSize\": 32,\n");
        scene.append("  \"onStartScript\": \"scene\",\n");
        scene.append("  \"layers\": [],\n  \"objects\": [\n");
        // A：默认值（没有 params 覆盖）
        scene.append("    { \"id\": \"a\", \"kind\": \"ACTOR\", \"name\": \"A\", \"x\": 64, \"y\": 64,")
                .append(" \"halfW\": 16, \"halfH\": 16, \"visible\": true,")
                .append(" \"modules\": [ { \"def\": \"script.js\", \"when\": \"ALWAYS\",")
                .append(" \"params\": { \"script\": \"enemy\" } } ] },\n");
        // B：同一个脚本，覆盖 speed / label / alive（外加一个脚本没声明的 ghost）
        scene.append("    { \"id\": \"b\", \"kind\": \"ACTOR\", \"name\": \"B\", \"x\": 160, \"y\": 64,")
                .append(" \"halfW\": 16, \"halfH\": 16, \"visible\": true,")
                .append(" \"modules\": [ { \"def\": \"script.js\", \"when\": \"ALWAYS\",")
                .append(" \"params\": { \"script\": \"enemy\",")
                .append(" \"params\": \"{\\\"speed\\\":250,\\\"label\\\":\\\"快速怪\\\",\\\"alive\\\":false,\\\"ghost\\\":1}\"")
                .append(" } } ] },\n");
        // C：坏 JSON
        scene.append("    { \"id\": \"c\", \"kind\": \"PROP\", \"name\": \"C\", \"x\": 240, \"y\": 64,")
                .append(" \"visible\": true,")
                .append(" \"modules\": [ { \"def\": \"script.js\", \"when\": \"ALWAYS\",")
                .append(" \"params\": { \"script\": \"enemy\", \"params\": \"{not json\" } } ] }");
        scene.append("\n  ]\n}\n");
        write(new File(build, "scene_0.json"), scene.toString());

        write(new File(scripts, "scene.js"), SCENE_JS);
        write(new File(scripts, "enemy.js"), ENEMY_JS);
    }

    /**
     * 场景脚本：证明「没有 self」的路径不炸。
     * <p>注意顺序 —— 场景脚本在对象 onStart 之前派发，正好能验证参数不是全局残留。
     */
    private static final String SCENE_JS =
            "function onSceneStart(ctx) {\n"
            + "  bwe.log('PARAMS scene.ctx=' + (ctx.params === null ? 'null' : typeof ctx.params));\n"
            + "  try {\n"
            + "    var p = bwe.params();\n"
            + "    bwe.log('PARAMS scene.fn=' + (p && typeof p === 'object' ? 'ok' : 'bad'));\n"
            + "  } catch (e) {\n"
            + "    bwe.log('PARAMS scene.fn=throw:' + e);\n"
            + "  }\n"
            + "}\n";

    /**
     * 对象脚本：同一份脚本挂三个对象，各自读自己的参数。
     * <p>顶层声明故意带上中文键与布尔，覆盖「只支持字面量」里最容易错的两种。
     */
    private static final String ENEMY_JS =
            "var DECL = bwe.params({\n"
            + "  speed: 100,\n"
            + "  label: \"小怪\",\n"
            + "  alive: true,\n"
            + "  \"中文键\": \"值\"\n"
            + "});\n"
            + "bwe.log('PARAMS decl.speed=' + DECL.speed);\n"
            + "bwe.log('PARAMS decl.alive=' + DECL.alive);\n"
            + "bwe.log('PARAMS decl.cn=' + DECL['中文键']);\n"
            + "\n"
            + "function onStart(ctx) {\n"
            + "  var tag = ctx.self.name;\n"
            + "  bwe.log('PARAMS ' + tag.toLowerCase() + '.ctx=' + ctx.params.speed);\n"
            + "  bwe.log('PARAMS ' + tag.toLowerCase() + '.fn=' + bwe.params().speed);\n"
            + "  bwe.log('PARAMS ' + tag.toLowerCase() + '.speed=' + ctx.params.speed);\n"
            + "  bwe.log('PARAMS ' + tag.toLowerCase() + '.label=' + ctx.params.label);\n"
            + "  bwe.log('PARAMS ' + tag.toLowerCase() + '.alive=' + ctx.params.alive);\n"
            + "  bwe.log('PARAMS ' + tag.toLowerCase() + '.ghost=' + (typeof ctx.params.ghost));\n"
            + "  bwe.log('PARAMS ' + tag.toLowerCase() + '.started=1');\n"
            + "  // 改自己拿到的那个对象（应该改不动默认值表，也改不动别的对象）\n"
            + "  var mine = bwe.params();\n"
            + "  mine.speed = 9999;\n"
            + "  DECL.speed = 9999;\n"
            + "  bwe.log('PARAMS ' + tag.toLowerCase() + '.afterMutate=' + bwe.params().speed);\n"
            + "}\n"
            + "\n"
            + "function onUpdate(ctx, dt) {\n"
            + "  var tag = ctx.self.name.toLowerCase();\n"
            + "  bwe.log('PARAMS ' + tag + '.upd=' + ctx.params.speed);\n"
            + "}\n";

    // ---------------- 工具 ----------------

    private static void write(File f, String text) throws Exception {
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    private static List<String> readLog() throws Exception {
        File log = new File(root, "Build/bwe.log");
        if (!log.isFile()) {
            return new ArrayList<String>();
        }
        return Files.readAllLines(log.toPath(), StandardCharsets.UTF_8);
    }

    /** 取日志里 `key` 后面的值（最后一条，因为 onUpdate 会重复打）。 */
    private static String logValue(List<String> log, String key) {
        String found = null;
        for (String line : log) {
            int at = line.indexOf(key);
            if (at >= 0) {
                found = line.substring(at + key.length()).trim();
            }
        }
        return found;
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
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
