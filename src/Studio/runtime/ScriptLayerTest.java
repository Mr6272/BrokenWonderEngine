package Studio.runtime;

import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 绘制层级（遮挡顺序）回归自检。
 *
 * <p><b>为什么需要它</b>：本轮性能优化给「每帧排序」加了缓存，第一版用
 * 「可见数量 + 所有 y 的总和」判断要不要重排。这个判据有两个致命漏洞，
 * 会导致用户看到的<b>层级错乱</b>：
 * <ol>
 *   <li>脚本改 {@code z} 但不动 {@code y}（或编辑器「上移一层 / 置顶」菜单）⇒
 *       y 总和不变 ⇒ 不重排 ⇒ <b>点了置顶没反应</b>。</li>
 *   <li>两个对象<b>互换 y</b>（A:100,B:200 → A:200,B:100）⇒ 总和不变 ⇒
 *       不重排 ⇒ 遮挡关系错乱。</li>
 * </ol>
 * 真正的排序键是 <b>layer → z → y</b> 三元组，任一变化都必须重排。
 * 这些边界只有用「取出真实绘制顺序再断言」才抓得住。
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class ScriptLayerTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;

    private ScriptLayerTest() {
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
            RESULTS.add(new String[]{"layer test caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptLayerTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("-------------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null || detail.isEmpty() ? null : detail});
    }

    private static void run() throws Exception {
        root = new File(".tmp_rel8/layer");
        deleteRecursively(root);
        File build = new File(root, "Build");
        File scripts = new File(build, "scripts");
        scripts.mkdirs();
        write(new File(build, "boot.json"), bootJson());
        write(new File(build, "scene_0.json"), sceneJson());
        // 探针脚本：在 onStart 里改 z；在 onUpdate 里翻转两个对象的 y（保持总和不变）
        write(new File(scripts, "probe.js"), probeJs());

        TopDownRuntime rt = new TopDownRuntime(new File(build, "boot.json"));
        check("引擎已创建", rt.scripts != null, "");

        // 第 1 帧：建立基线顺序
        rt.scripts.update(0.02f);
        List<String> base = rt.debugDrawOrder();
        System.out.println("BASELINE=" + base);
        // mid 与 top 同 z=1，所以由 y 决序：mid(y=200) 先画、top(y=300) 后画 ⇒ top 盖住 mid
        check("基线顺序 = bottom < mid < top（y 小者先画）",
                base.equals(list("bottom", "mid", "top")), String.valueOf(base));

        // ---- 用例 1：只改 z，y 完全不动（旧缓存最典型的漏判）----
        rt.scripts.update(0.02f);   // tick=2：把 bottom 的 z 改成 9
        List<String> afterZ = rt.debugDrawOrder();
        System.out.println("AFTER_Z=" + afterZ);
        check("只改 z 后顺序必须变（旧缓存会漏判成「置顶没反应」）",
                afterZ.indexOf("bottom") == afterZ.size() - 1, String.valueOf(afterZ));

        // ---- 用例 2：互换 y，总和不变，且两者 z 相同（只由 y 决序）----
        rt.scripts.update(0.02f);   // tick=3：互换 mid/top 的 y
        List<String> afterSwap = rt.debugDrawOrder();
        System.out.println("AFTER_SWAP=" + afterSwap);
        check("互换 y 后顺序必须变（总和判据会漏判）",
                !afterSwap.equals(afterZ), "before=" + afterZ + " after=" + afterSwap);
        check("互换 y 后 top 应排到 mid 之前（y 变小 ⇒ 更先画 ⇒ 被盖住）",
                indexOf(afterSwap, "top") < indexOf(afterSwap, "mid"),
                String.valueOf(afterSwap));
        check("bottom 仍是最上层（z=9 压过一切 y）",
                afterSwap.indexOf("bottom") == afterSwap.size() - 1, String.valueOf(afterSwap));

        // ---- 用例 3：再跑一帧，顺序必须稳定（缓存不能在没变化时乱动）----
        rt.scripts.update(0.02f);
        List<String> stable = rt.debugDrawOrder();
        System.out.println("STABLE=" + stable);
        check("无变化时顺序稳定（缓存可复用且不抖动）", stable.equals(afterSwap),
                "prev=" + afterSwap + " now=" + stable);

        // ---- 用例 4：偶发 y 总和撞车（A,B 互换总和相同）也不得复用旧序 ----
        check("顺序里包含全部 3 个对象（无丢失）", stable.size() == 3, String.valueOf(stable));
        check("顺序无重复项", new java.util.HashSet<String>(stable).size() == stable.size(), String.valueOf(stable));
    }

    private static List<String> list(String... a) {
        List<String> l = new ArrayList<String>();
        for (String s : a) {
            l.add(s);
        }
        return l;
    }

    private static int indexOf(List<String> l, String v) {
        int i = l.indexOf(v);
        return i < 0 ? Integer.MAX_VALUE : i;
    }

    private static String bootJson() {
        return "{\n"
                + "  \"project\": \"ScriptLayerTest\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"scenes\": [ { \"name\": \"S\", \"file\": \"scene_0.json\", \"width\": 10, \"height\": 10 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [ { \"name\": \"probe\", \"file\": \"scripts/probe.js\", \"lang\": \"js\" } ],\n"
                + "  \"assets\": []\n"
                + "}\n";
    }

    /**
     * 三个同图层对象。注意 z 的分配是刻意的：
     * <ul>
     *   <li>{@code bottom}：z=0（最低）</li>
     *   <li>{@code mid} 与 {@code top}：<b>z 相同（=1）</b> —— 这样它们的先后<b>只由 y 决定</b>，
     *       才能用来验证「互换 y（总和不变）必须重排」。</li>
     * </ul>
     * ⚠ 如果给它们不同的 z，z 会压过 y，互换 y 根本不改变顺序 ——
     * 那样写出来的测试会「永远绿」而抓不到任何 bug。
     */
    private static String sceneJson() {
        return "{\n"
                + "  \"width\": 10,\n"
                + "  \"height\": 10,\n"
                + "  \"tileSize\": 32,\n"
                + "  \"onStartScript\": \"probe\",\n"
                + "  \"objects\": [\n"
                + "    { \"id\": \"bottom\", \"kind\": \"PROP\", \"name\": \"底\", \"x\": 50, \"y\": 100,\n"
                + "      \"z\": 0, \"layer\": 0, \"halfW\": 10, \"halfH\": 10 },\n"
                + "    { \"id\": \"mid\", \"kind\": \"PROP\", \"name\": \"中\", \"x\": 60, \"y\": 200,\n"
                + "      \"z\": 1, \"layer\": 0, \"halfW\": 10, \"halfH\": 10 },\n"
                + "    { \"id\": \"top\", \"kind\": \"PROP\", \"name\": \"顶\", \"x\": 70, \"y\": 300,\n"
                + "      \"z\": 1, \"layer\": 0, \"halfW\": 10, \"halfH\": 10 }\n"
                + "  ]\n"
                + "}\n";
    }

    private static String probeJs() {
        return String.join("\n",
                "// 脚本里没有「当前第几帧」的概念：update 回调由引擎每帧调一次，",
                "// 这里自己数次数。注意：bwe.on('update') 的回调在 scripts.update 期间触发，",
                "// 所以每调一次 rt.scripts.update(dt)，这个回调就跑一次。",
                "var tick = 0;",
                "function onSceneStart(ctx) {",
                "  tick = 0;",
                "  bwe.on('update', function () {",
                "    tick = tick + 1;",
                "    var bottom = bwe.world.find('bottom');",
                "    var top = bwe.world.find('top');",
                "    if (!bottom || !top) return;",
                "    // tick=2：只改 z，y 完全不动（旧缓存按 y 总和判据会漏判）",
                "    if (tick === 2) {",
                "      bottom.z = 9;",
                "    }",
                "    // tick=3：把 mid 与 top 的 y 互换（两者 z 相同=1，所以次序只由 y 决定；总和不变）",
                "    if (tick === 3) {",
                "      var mid = bwe.world.find('mid');",
                "      if (!mid) return;",
                "      var my = mid.y;",
                "      mid.y = top.y;",
                "      top.y = my;",
                "    }",
                "  });",
                "}",
                "");
    }

    private static void write(File f, String text) throws Exception {
        File p = f.getParentFile();
        if (p != null) {
            p.mkdirs();
        }
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
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
