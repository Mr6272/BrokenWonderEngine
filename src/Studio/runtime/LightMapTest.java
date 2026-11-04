package Studio.runtime;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.Gson;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 2D 光照烘焙的<b>纯 CPU</b> 自检（契约 §7.1）。
 *
 * <p><b>为什么这个测试必须存在</b>：光照公式有两份实现 —— 编辑器的
 * {@code web/src/app/lightMath.ts} 与运行时的 {@link LightMap}。两份只要有一处公式走样，
 * 玩家看到的就是「编辑器预览一个样、进游戏另一个样」，而这种偏差<b>不会崩、不会报错</b>，
 * 只会「看起来有点怪」。所以两边都必须对上同一份<b>第三方独立算出的</b>像素值：
 * {@code test/fixtures/lighting-case.json}。
 *
 * <p>断言分三层，缺一层都会漏掉真问题：
 * <ol>
 *   <li><b>逐点对 fixture</b>：3 个 case 的全部 samples，每通道容差 ≤ 2（0..255）；</li>
 *   <li><b>性质断言</b>：环境光常量、半径边界、锥内外、遮挡、采样率、确定性、
 *       模糊能量守恒 —— 这些 fixture 的采样点没覆盖到的角落；</li>
 *   <li><b>输出格式</b>：{@code toImage} 必须 A=255 且 RGB 与 float 逐字节一致。</li>
 * </ol>
 *
 * <p>仅用 Java 8 的 API；无 GL、无窗口，可在任何机器（含 CI 无显示器）跑。
 * 用法：{@code java -cp ".tmp_light_jc;lib/*" Studio.runtime.LightMapTest}
 */
public final class LightMapTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static int skipped;

    private LightMapTest() {
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        PrintStream realOut = System.out;
        String fatal = null;
        try {
            run();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace(realOut);
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"LightMapTest 执行时抛异常（不是「断言失败」，是测试自己没跑完）", "false", fatal});
        }
        int failures = 0;
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1]) && !"skip".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== LightMapTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            boolean skip = "skip".equals(r[1]);
            realOut.println((ok ? "PASS  " : skip ? "SKIP  " : "FAIL  ") + r[0]
                    + (!ok && !skip && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("-----------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures - skipped)
                + "，跳过 " + skipped + "，失败 " + failures
                + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail});
    }

    private static void skip(String name, String why) {
        skipped++;
        RESULTS.add(new String[]{name, "skip", why});
    }

    /** 容差（契约 §7.1：每通道 ≤ 2/255）。 */
    private static final int TOL = 2;

    // ---------------- 主流程 ----------------

    private static void run() throws IOException {
        File fixture = locateFixture();
        if (fixture == null || !fixture.isFile()) {
            skip("fixture 逐点比对", "找不到 test/fixtures/lighting-case.json（在仓库根下跑）");
        } else {
            runFixture(fixture);
        }
        runProperties();
        runHash();
    }

    /**
     * 定位 fixture：从当前目录逐级向上找 {@code test/fixtures/lighting-case.json}。
     * 这样无论从仓库根、还是从 {@code .tmp_light_jc} 下跑都能找到（不写死绝对路径）。
     */
    private static File locateFixture() {
        File dir = new File(System.getProperty("user.dir", ".")).getAbsoluteFile();
        for (int depth = 0; depth < 6 && dir != null; depth++) {
            File f = new File(new File(new File(dir, "test"), "fixtures"), "lighting-case.json");
            if (f.isFile()) {
                return f;
            }
            dir = dir.getParentFile();
        }
        return null;
    }

    // ---------------- ① fixture 逐点比对 ----------------

    private static void runFixture(File fixture) throws IOException {
        String json = new String(Files.readAllBytes(fixture.toPath()), StandardCharsets.UTF_8);
        JsonObject root = new Gson().fromJson(json, JsonObject.class);
        JsonArray cases = root.has("cases") ? root.getAsJsonArray("cases") : new JsonArray();
        check("fixture 至少有 3 个 case（main / ambientOnly / scale）", cases.size() >= 3,
                "cases=" + cases.size());
        int totalSamples = 0;
        int caseIdx = 0;
        for (JsonElement ce : cases) {
            if (!ce.isJsonObject()) {
                continue;
            }
            JsonObject c = ce.getAsJsonObject();
            String name = str(c, "name", "#" + caseIdx);
            caseIdx++;
            CaseResult r = bakeCase(c);
            if (r == null) {
                check("case " + name + "：能烘焙出贴图", false, "bake 返回未就绪（尺寸/环境光解析失败）");
                continue;
            }

            // 尺寸 + sEff 必须与 fixture 的 expect 完全一致（这是「同一套采样网格」的前提）
            int expW = (int) num(c, "expect.texW", -1);
            int expH = (int) num(c, "expect.texH", -1);
            float expS = (float) num(c, "expect.sEff", -1);
            boolean sizeOk = r.res.texW == expW && r.res.texH == expH;
            // sEff 是 float 反推值：用相对误差 1e-5 判定（文字精确相等在 float 上不现实）
            boolean sOk = Math.abs(r.res.sEff - expS) <= Math.max(1e-5f, expS * 1e-5f);
            check("case " + name + "：贴图尺寸 " + expW + "x" + expH + " 与 sEff=" + expS,
                    sizeOk && sOk, "实际 " + r.res.texW + "x" + r.res.texH + " sEff=" + r.res.sEff);

            // 逐点比对
            JsonArray samples = c.has("samples") ? c.getAsJsonArray("samples") : new JsonArray();
            check("case " + name + "：samples 非空", samples.size() > 0, "n=" + samples.size());
            int maxDelta = 0;
            StringBuilder bad = new StringBuilder();
            int badCount = 0;
            for (JsonElement se : samples) {
                if (!se.isJsonObject()) {
                    continue;
                }
                JsonObject s = se.getAsJsonObject();
                int i = (int) num(s, "i", -1);
                int j = (int) num(s, "j", -1);
                if (i < 0 || j < 0 || i >= r.res.texW || j >= r.res.texH) {
                    check("case " + name + "：sample 下标 (" + i + "," + j + ") 在贴图范围内", false, "");
                    continue;
                }
                totalSamples++;
                int[] got = r.getAt(i, j);
                JsonArray expect = s.has("expect") ? s.getAsJsonArray("expect") : new JsonArray();
                int[] want = new int[]{0, 0, 0};
                for (int k = 0; k < 3 && k < expect.size(); k++) {
                    want[k] = expect.get(k).getAsInt();
                }
                int d0 = Math.abs(got[0] - want[0]);
                int d1 = Math.abs(got[1] - want[1]);
                int d2 = Math.abs(got[2] - want[2]);
                int d = Math.max(d0, Math.max(d1, d2));
                if (d > maxDelta) {
                    maxDelta = d;
                }
                if (d > TOL) {
                    badCount++;
                    if (badCount <= 4) {
                        bad.append(" (").append(i).append(",").append(j).append(") want=")
                                .append(want[0]).append(",").append(want[1]).append(",").append(want[2])
                                .append(" got=").append(got[0]).append(",").append(got[1]).append(",").append(got[2])
                                .append(" d=").append(d).append(";");
                    }
                }
            }
            check("case " + name + "：全部 " + samples.size() + " 个 samples 逐点对上（容差 "
                    + TOL + "/255，通道最大差 " + maxDelta + "）",
                    badCount == 0, badCount == 0 ? "" : (badCount + " 点超差:" + bad));
        }
        check("三个 case 合计比对 " + totalSamples + " 个采样点", totalSamples >= 15, "n=" + totalSamples);
    }

    /** 一个 case 的烘焙结果 + 按纹素取值的小工具。 */
    private static final class CaseResult {
        LightMap.Result res;
        int texW, texH;

        int[] getAt(int i, int j) {
            int o = (j * texW + i) * 3;
            return new int[]{LightMap.channel(res.rgb[o]), LightMap.channel(res.rgb[o + 1]),
                    LightMap.channel(res.rgb[o + 2])};
        }
    }

    /** 按 fixture 的 case JSON 跑一次 bake（与 fixture 生成器同一套字段名与缺省值）。 */
    private static CaseResult bakeCase(JsonObject c) {
        float w = (float) num(c, "width", 0);
        float h = (float) num(c, "height", 0);
        float s = (float) num(c, "texelsPerPixel", 0.25f);
        JsonObject amb = c.has("ambient") && c.get("ambient").isJsonObject()
                ? c.getAsJsonObject("ambient") : new JsonObject();
        float[] ambient = parseHex(str(amb, "color", "#3A4A6B"));
        if (ambient == null) {
            ambient = new float[]{0.227f, 0.29f, 0.42f};
        }
        float ai = (float) num(amb, "intensity", 0.35f);
        ambient[0] *= ai;
        ambient[1] *= ai;
        ambient[2] *= ai;

        List<LightMap.Light> lights = new ArrayList<LightMap.Light>();
        JsonArray la = c.has("lights") ? c.getAsJsonArray("lights") : new JsonArray();
        for (JsonElement le : la) {
            if (!le.isJsonObject()) {
                continue;
            }
            JsonObject lo = le.getAsJsonObject();
            LightMap.Light L = new LightMap.Light();
            L.id = str(lo, "id", "");
            L.x = (float) num(lo, "x", 0);
            L.y = (float) num(lo, "y", 0);
            L.radius = (float) num(lo, "radius", 140);
            float[] col = parseHex(str(lo, "color", "#FFC978"));
            if (col != null) {
                L.r = col[0];
                L.g = col[1];
                L.b = col[2];
            }
            L.intensity = (float) num(lo, "intensity", 1);
            L.spot = "spot".equalsIgnoreCase(str(lo, "type", "point"));
            L.dirDeg = (float) num(lo, "dir", 0);
            L.angleDeg = (float) num(lo, "angle", 60);
            L.coneSoftDeg = (float) num(lo, "coneSoft", 10);
            L.falloff = (float) num(lo, "falloff", 2);
            L.shadow = boolOf(lo, "shadow", true);
            // 烘焙：dynamic 的光源完全不进烘焙；flicker 在烘焙里按 0 算（契约 §2.3 第 7 条）。
            if (boolOf(lo, "dynamic", false)) {
                continue;
            }
            L.tickle = 0f;
            lights.add(L);
        }

        List<LightMap.Occluder> occs = new ArrayList<LightMap.Occluder>();
        JsonArray oa = c.has("occluders") ? c.getAsJsonArray("occluders") : new JsonArray();
        for (JsonElement oe : oa) {
            if (!oe.isJsonObject()) {
                continue;
            }
            JsonObject oo = oe.getAsJsonObject();
            occs.add(new LightMap.Occluder((float) num(oo, "x", 0), (float) num(oo, "y", 0),
                    (float) num(oo, "hw", 0), (float) num(oo, "hh", 0)));
        }

        LightMap.Result res = LightMap.bake(w, h, s, ambient, lights, occs);
        if (res == null || res.rgb == null) {
            return null;
        }
        // 柔化（fixture 的 softness 单位是世界像素，半径 = softness * sEff，契约 §2.5）
        float softness = (float) num(c, "softness", 16f);
        int radius = Math.max(0, Math.round(softness * res.sEff));
        if (radius > 0) {
            res.rgb = LightMap.blur(res.rgb, res.texW, res.texH, radius);
        }
        CaseResult out = new CaseResult();
        out.res = res;
        out.texW = res.texW;
        out.texH = res.texH;
        return out;
    }

    // ---------------- ② 性质断言 ----------------

    private static void runProperties() {
        // ---- 环境光：没有光源时整张图逐像素等于 ambientColor * ambientIntensity ----
        {
            float[] ambient = new float[]{0.227f, 0.29f, 0.42f};
            float ai = 0.42f;
            ambient[0] *= ai;
            ambient[1] *= ai;
            ambient[2] *= ai;
            LightMap.Result r = LightMap.bake(64, 64, 1f, ambient, null, null);
            int[] want = new int[]{LightMap.channel(ambient[0]), LightMap.channel(ambient[1]),
                    LightMap.channel(ambient[2])};
            boolean all = true;
            int n = 0;
            for (int j = 0; j < r.texH && all; j++) {
                for (int i = 0; i < r.texW; i++) {
                    int o = (j * r.texW + i) * 3;
                    int gotR = LightMap.channel(r.rgb[o]);
                    int gotG = LightMap.channel(r.rgb[o + 1]);
                    int gotB = LightMap.channel(r.rgb[o + 2]);
                    if (Math.abs(gotR - want[0]) > TOL || Math.abs(gotG - want[1]) > TOL
                            || Math.abs(gotB - want[2]) > TOL) {
                        all = false;
                        break;
                    }
                    n++;
                }
            }
            check("没有光源时整张图 = 环境光（逐像素，n=" + n + "）", all,
                    all ? "" : "期望 " + want[0] + "," + want[1] + "," + want[2]);
        }

        // ---- 尺寸推导：2048 上限触发等比缩小，且 sEff 用反推值 ----
        {
            LightMap.Result r = LightMap.sizeFor(20000f, 10000f, 0.5f);
            boolean capped = r.texW <= LightMap.MAX_TEX && r.texH <= LightMap.MAX_TEX;
            check("超大世界按长边 ≤ 2048 等比缩小（契约 §2.1）", capped,
                    "tex=" + r.texW + "x" + r.texH + " sEff=" + r.sEff);
            // 20000x10000 @0.5 = 10000x5000 → shrink=0.2048 → 2048x1024，sEff=min(2048/20000,1024/10000)
            boolean exact = r.texW == 2048 && r.texH == 1024;
            check("20000x10000 → 2048x1024（round 后等比）", exact, "实际 " + r.texW + "x" + r.texH);
            float expectS = Math.min(2048f / 20000f, 1024f / 10000f);
            check("sEff 由实际尺寸反推（不是直接用 0.5）", Math.abs(r.sEff - expectS) < 1e-6f,
                    "sEff=" + r.sEff + " 期望=" + expectS);
        }
        {
            LightMap.Result r = LightMap.sizeFor(0f, 0f, 0.25f);
            check("世界尺寸 <= 0 ⇒ 1x1 / sEff=1 / rgb 全 0（不返回 null）",
                    r.texW == 1 && r.texH == 1 && Math.abs(r.sEff - 1f) < 1e-6f && r.rgb != null
                            && r.rgb.length == 3 && r.rgb[0] == 0f && r.rgb[1] == 0f && r.rgb[2] == 0f,
                    "tex=" + r.texW + "x" + r.texH + " sEff=" + r.sEff);
        }
        {
            // texelsPerPixel 非法（0 / 负 / NaN）⇒ 退到缺省 0.25，不抛异常、不产生 0 尺寸
            LightMap.Result r0 = LightMap.sizeFor(640, 480, 0f);
            LightMap.Result rn = LightMap.sizeFor(640, 480, Float.NaN);
            check("texelsPerPixel=0 / NaN ⇒ 退到缺省 0.25（160x120）",
                    r0.texW == 160 && r0.texH == 120 && rn.texW == 160 && rn.texH == 120,
                    "0→" + r0.texW + "x" + r0.texH + " NaN→" + rn.texW + "x" + rn.texH);
        }

        // ---- 半径边界：t >= 1 ⇒ 贡献 0（只剩环境光）----
        {
            float[] ambient = new float[]{0.1f, 0.1f, 0.1f};
            List<LightMap.Light> lights = new ArrayList<LightMap.Light>();
            LightMap.Light L = new LightMap.Light();
            L.x = 100f;
            L.y = 100f;
            L.radius = 50f;
            L.intensity = 1f;
            L.r = 1f;          // 纯白光：灯心三个通道才是 255（缺省 #FFC978 的 g/b 不满）
            L.g = 1f;
            L.b = 1f;
            L.shadow = false;
            lights.add(L);
            LightMap.Result r = LightMap.bake(200, 200, 1f, ambient, lights, null);
            // 半径 50：纹素中心 (100.5,100.5) 距灯 0.707 → 亮；恰好在 d>=50 的纹素必须只有环境光
            int[] atCenter = px(r, 100, 100);
            check("半径内的灯心被照亮（> 环境光）", atCenter[0] > 26 && atCenter[1] > 26,
                    "rgb=" + atCenter[0] + "," + atCenter[1] + "," + atCenter[2]);
            // (150,100)：d = 49.5 < 50 → 还亮一点点；(151,100)：d=50.5 >= 50 → 环境光
            int[] edgeIn = px(r, 149, 100);
            int[] edgeOut = px(r, 152, 100);
            check("t 略小于 1 仍有微弱贡献（衰减到 ~0 但不是 0）", edgeIn[0] >= 26,
                    "d≈49 rgb=" + edgeIn[0]);
            check("t >= 1 的纹素贡献严格为 0（只剩环境光）",
                    Math.abs(edgeOut[0] - 26) <= TOL && Math.abs(edgeOut[1] - 26) <= TOL
                            && Math.abs(edgeOut[2] - 26) <= TOL,
                    "d≈51 rgb=" + edgeOut[0] + "," + edgeOut[1] + "," + edgeOut[2]);
            // 灯心必须饱和到 255（intensity=1 的白光）
            check("灯心通道饱和到 255（强度 1 的白光 + 环境光一起 clamp）",
                    atCenter[0] == 255 && atCenter[1] == 255 && atCenter[2] == 255,
                    "rgb=" + atCenter[0] + "," + atCenter[1] + "," + atCenter[2]);
        }

        // ---- 聚光锥：dir=0（+x）时锥内亮、锥外严格只有环境光 ----
        {
            float[] ambient = new float[]{0.05f, 0.05f, 0.05f};
            List<LightMap.Light> lights = new ArrayList<LightMap.Light>();
            LightMap.Light L = new LightMap.Light();
            L.x = 100f;
            L.y = 100f;
            L.radius = 90f;
            L.intensity = 1f;
            L.spot = true;
            L.angleDeg = 60f;
            L.dirDeg = 0f;        // +x
            L.coneSoftDeg = 0f;   // 关软化：边界必须是硬切换，才验得准
            L.shadow = false;
            lights.add(L);
            LightMap.Result r = LightMap.bake(200, 200, 1f, ambient, lights, null);
            int[] inside = px(r, 140, 100);   // +x 方向，锥心
            int[] outside = px(r, 60, 100);   // -x 方向（diff=180°）
            check("聚光锥内（+x，diff=0）被照亮", inside[0] > 20, "rgb=" + inside[0]);
            check("聚光锥外（-x，diff=180°）严格只有环境光",
                    outside[0] <= 13 + TOL && outside[1] <= 13 + TOL && outside[2] <= 13 + TOL,
                    "rgb=" + outside[0] + "," + outside[1] + "," + outside[2]);
            // ±30° 边界：angle=60 ⇒ half=30°。(100+40cos15, 100+40sin15) 在锥内；(cos45) 在锥外
            int inX = 100 + (int) Math.round(40 * Math.cos(Math.toRadians(15)));
            int inY = 100 + (int) Math.round(40 * Math.sin(Math.toRadians(15)));
            int[] nearEdgeIn = px(r, inX, inY);
            check("锥内 15°（half=30°）仍有光", nearEdgeIn[0] > 20, "rgb=" + nearEdgeIn[0]);
            int outX = 100 + (int) Math.round(40 * Math.cos(Math.toRadians(45)));
            int outY = 100 + (int) Math.round(40 * Math.sin(Math.toRadians(45)));
            int[] nearEdgeOut = px(r, outX, outY);
            check("锥外 45° 只剩环境光", nearEdgeOut[0] <= 13 + TOL, "rgb=" + nearEdgeOut[0]);
        }

        // ---- 遮挡：墙后的纹素严格只有环境光；绕过墙的纹素仍被照亮 ----
        {
            float[] ambient = new float[]{0.08f, 0.08f, 0.08f};
            List<LightMap.Light> lights = new ArrayList<LightMap.Light>();
            LightMap.Light L = new LightMap.Light();
            L.x = 40f;
            L.y = 100f;
            L.radius = 120f;
            L.intensity = 1f;
            L.shadow = true;
            lights.add(L);
            List<LightMap.Occluder> occs = new ArrayList<LightMap.Occluder>();
            occs.add(new LightMap.Occluder(100f, 100f, 6f, 60f));   // 竖墙 x∈[94,106], y∈[40,160]
            LightMap.Result r = LightMap.bake(200, 200, 1f, ambient, lights, occs);
            int[] behind = px(r, 140, 100);   // 正后方（被墙挡）
            check("墙正后方的纹素严格只有环境光",
                    Math.abs(behind[0] - 20) <= TOL && Math.abs(behind[1] - 20) <= TOL,
                    "rgb=" + behind[0] + "," + behind[1] + "," + behind[2]);
            int[] above = px(r, 100, 20);     // 墙顶上方（射线从 y=20 段掠过墙外）→ 应被照亮
            // 灯 (40,100) → 该点 (100,20)：线段在 x∈[94,106] 段的 y≈39.9..31.6，全在墙顶 y=40 之上
            // ⇒ 不挡；但距离 d≈103 已接近 radius=120，衰减后只剩几阶 —— 判据只要求「比环境光高」。
            check("从墙上方绕过的纹素仍被照亮（遮挡必须按线段判，不能按距离判）",
                    above[0] > 20, "rgb=" + above[0] + "," + above[1] + "," + above[2]);
        }

        // ---- shadow=false 的灯完全无视遮挡体 ----
        {
            float[] ambient = new float[]{0.08f, 0.08f, 0.08f};
            List<LightMap.Light> lights = new ArrayList<LightMap.Light>();
            LightMap.Light L = new LightMap.Light();
            L.x = 40f;
            L.y = 100f;
            L.radius = 120f;
            L.shadow = false;
            lights.add(L);
            List<LightMap.Occluder> occs = new ArrayList<LightMap.Occluder>();
            occs.add(new LightMap.Occluder(100f, 100f, 6f, 60f));
            LightMap.Result r = LightMap.bake(200, 200, 1f, ambient, lights, occs);
            int[] behind = px(r, 140, 100);
            check("shadow=false 的灯无视遮挡体（墙后仍亮）", behind[0] > 20,
                    "rgb=" + behind[0]);
        }

        // ---- 累加顺序 + 包围盒裁剪：逐光源遍历的优化实现必须与逐纹素参考实现<b>逐位相同</b> ----
        // 契约 §2.3 允许「按逐光源遍历纹素」实现，但要求「对每个纹素而言累加顺序仍是 lights 下标顺序」。
        // 这条断言用一份<b>朴素的逐纹素参考实现</b>（每纹素按 0..n 顺序累加、不做包围盒裁剪）反向验证：
        // 优化后的结果必须逐位相同 —— 否则就是「裁剪漏算 / 累加顺序错 / 通道串了」，而且只会在
        // 某些像素上冒出来（用 fixture 的 3 个点根本抓不住）。
        {
            List<LightMap.Light> lights = new ArrayList<LightMap.Light>();
            LightMap.Light l1 = new LightMap.Light();
            l1.x = 50f;
            l1.y = 50f;
            l1.radius = 90f;
            l1.intensity = 0.7f;
            l1.shadow = false;
            lights.add(l1);
            LightMap.Light l2 = new LightMap.Light();
            l2.x = 120f;
            l2.y = 80f;
            l2.r = 0.5f;
            l2.g = 0.8f;
            l2.b = 1f;
            l2.radius = 80f;
            l2.intensity = 0.9f;
            l2.spot = true;
            l2.dirDeg = 30f;
            l2.angleDeg = 70f;
            l2.shadow = false;
            lights.add(l2);
            LightMap.Light l3 = new LightMap.Light();     // 第三盏：只覆盖角落一环，测裁剪不越界
            l3.x = 199f;
            l3.y = 8f;
            l3.radius = 30f;
            l3.intensity = 0.6f;
            l3.shadow = false;
            lights.add(l3);
            float[] amb = new float[]{0.06f, 0.07f, 0.08f};
            LightMap.Result opt = LightMap.bake(200f, 150f, 0.5f, amb, lights, null);
            float[] ref = referenceBake(200f, 150f, 0.5f, amb, lights);
            // ⚠ 比的是**最终输出字节**（0..255），不是 float 位：JS 侧（fixture 生成器）在 double 上
            //   累加、最后一次落进 Float32Array；本实现逐项落 float32 再累加。两者差 1~2 ulp（≈1e-7），
            //   远小于 1/255，对输出字节无影响 —— 契约只要求两端「逐像素对上（±2/255）」。
            //   但**裁剪漏格 / 累加顺序错 / 通道串位**都会产生 ≥1 个字节的可见偏差，这条断言抓的就是那些。
            int maxByteDelta = 0;
            int firstBad = -1;
            for (int k = 0; k < opt.rgb.length; k++) {
                int d = Math.abs(LightMap.channel(opt.rgb[k]) - LightMap.channel(ref[k]));
                if (d > maxByteDelta) {
                    maxByteDelta = d;
                    if (firstBad < 0) {
                        firstBad = k;
                    }
                }
            }
            check("逐光源+包围盒裁剪的烘焙与逐纹素参考实现一致（" + (opt.texW * opt.texH)
                            + " 纹素 / 3 盏灯，输出字节最大差 " + maxByteDelta + " ≤ 1）",
                    maxByteDelta <= 1,
                    maxByteDelta <= 1 ? "" : "首个差异 idx=" + firstBad + " opt=" + opt.rgb[firstBad]
                            + " ref=" + ref[firstBad]);
        }

        // ---- 确定性：同一输入连跑两次，逐位相同（契约 §2.7）----
        {
            List<LightMap.Light> lights = new ArrayList<LightMap.Light>();
            LightMap.Light L = new LightMap.Light();
            L.x = 77.3f;
            L.y = 41.9f;
            L.radius = 60.5f;
            L.spot = true;
            L.dirDeg = 37.5f;
            L.angleDeg = 55f;
            L.coneSoftDeg = 12f;
            L.falloff = 2.3f;
            lights.add(L);
            List<LightMap.Occluder> occs = new ArrayList<LightMap.Occluder>();
            occs.add(new LightMap.Occluder(95f, 60f, 4.5f, 20f));
            float[] ambient = new float[]{0.11f, 0.13f, 0.17f};
            LightMap.Result r1 = LightMap.bake(160f, 120f, 0.5f, ambient, lights, occs);
            LightMap.Result r2 = LightMap.bake(160f, 120f, 0.5f, ambient, lights, occs);
            boolean same = true;
            for (int k = 0; k < r1.rgb.length; k++) {
                if (r1.rgb[k] != r2.rgb[k]) {
                    same = false;
                    break;
                }
            }
            check("同一输入两次烘焙逐像素相同（确定性）", same, "len=" + r1.rgb.length);
        }

        // ---- 模糊：能量守恒（±1%），且半径 0 = 恒等 ----
        {
            float[] ambient = new float[]{0.2f, 0.2f, 0.2f};
            List<LightMap.Light> lights = new ArrayList<LightMap.Light>();
            LightMap.Light L = new LightMap.Light();
            L.x = 40f;
            L.y = 40f;
            L.radius = 30f;
            L.intensity = 0.8f;
            L.shadow = false;
            lights.add(L);
            LightMap.Result raw = LightMap.bake(100, 100, 1f, ambient, lights, null);

            float[] copy = cloneArray(raw.rgb);
            float[] zero = LightMap.blur(copy, raw.texW, raw.texH, 0);
            boolean identity = zero != null && zero.length == raw.rgb.length;
            for (int k = 0; k < raw.rgb.length && identity; k++) {
                if (zero[k] != raw.rgb[k]) {
                    identity = false;
                }
            }
            check("blur 半径 0 是恒等运算（不做无意义拷贝/不失真）", identity, "");

            float[] blurred = LightMap.blur(cloneArray(raw.rgb), raw.texW, raw.texH, 8);
            double sumRaw = 0.0;
            double sumBlur = 0.0;
            for (int k = 0; k < raw.rgb.length; k += 3) {
                sumRaw += raw.rgb[k] + raw.rgb[k + 1] + raw.rgb[k + 2];
                sumBlur += blurred[k] + blurred[k + 1] + blurred[k + 2];
            }
            double rel = sumRaw <= 0 ? 0 : Math.abs(sumBlur - sumRaw) / sumRaw;
            check("2 遍方框模糊能量守恒（相对误差 " + String.format(java.util.Locale.ROOT, "%.4f", rel)
                    + " ≤ 0.01）", rel <= 0.01, "raw=" + sumRaw + " blur=" + sumBlur);
            // 边缘归一：角落像素不能被「凭空外推」的像素填亮 —— 模糊前后角落亮度不得上升
            int corner = (0 * raw.texW + 0) * 3;
            boolean noEdgeGain = blurred[corner] <= raw.rgb[corner] + 1e-6f;
            check("模糊不放大暗边界（边缘按有效像素归一，不做外推）", noEdgeGain,
                    "raw=" + raw.rgb[corner] + " blur=" + blurred[corner]);
            check("模糊返回非 null 且长度不变", blurred != null && blurred.length == raw.rgb.length, "");
        }

        // ---- toImage：A=255、RGB 与 float 逐字节一致（契约 §2.6）----
        {
            float[] rgb = new float[]{0f, 0.5f, 1f, 0.25f, 0.75f, 0.9f, -0.2f, 1.2f, 0.4f};
            BufferedImage img = LightMap.toImage(rgb, 3, 1);
            boolean sizeOk = img != null && img.getWidth() == 3 && img.getHeight() == 1;
            boolean alphaOk = sizeOk;
            if (sizeOk) {
                for (int x = 0; x < 3; x++) {
                    if (((img.getRGB(x, 0) >>> 24) & 0xFF) != 255) {
                        alphaOk = false;
                    }
                }
            }
            int p0 = img.getRGB(0, 0);
            int p1 = img.getRGB(1, 0);
            int p2 = img.getRGB(2, 0);
            boolean pxOk = ((p0 >> 16) & 0xFF) == 0 && ((p0 >> 8) & 0xFF) == LightMap.channel(0.5f)
                    && (p0 & 0xFF) == 255
                    && ((p1 >> 16) & 0xFF) == LightMap.channel(0.25f)
                    && ((p1 >> 8) & 0xFF) == LightMap.channel(0.75f)
                    && (p1 & 0xFF) == LightMap.channel(0.9f)
                    // 超界值必须被 clamp：-0.2 → 0，1.2 → 255
                    && ((p2 >> 16) & 0xFF) == 0 && (p2 & 0xFF) == LightMap.channel(0.4f);
            check("toImage 尺寸正确", sizeOk, "");
            check("toImage 全部像素 A=255（不透明 PNG，契约 §2.6）", alphaOk, "");
            check("toImage RGB = round(clamp01(float)*255) 逐字节一致（含越界 clamp）", pxOk,
                    "p0=" + Integer.toHexString(p0) + " p1=" + Integer.toHexString(p1)
                            + " p2=" + Integer.toHexString(p2));

            BufferedImage blk = LightMap.black(4, 2);
            boolean blkOk = blk != null && blk.getWidth() == 4 && blk.getHeight() == 2
                    && blk.getRGB(0, 0) == 0xFF000000;
            check("black(w,h) 是全黑不透明贴图（加光层兜底，避免 upload 空指针）", blkOk,
                    blk == null ? "null" : Integer.toHexString(blk.getRGB(0, 0)));
            BufferedImage zero = LightMap.black(0, 0);
            check("black(0,0) 不抛异常且至少 1x1", zero != null && zero.getWidth() >= 1, "");
        }

        // ---- 退化输入：null 光源表 / 空 ambient / 空光源都不抛异常 ----
        {
            boolean ok = true;
            try {
                LightMap.bake(64, 32, 0.5f, null, null, null);
                LightMap.bake(64, 32, 0.5f, new float[0], null, null);
                LightMap.blur(null, 4, 4, 2);
            } catch (Throwable t) {
                ok = false;
            }
            check("null/空的 ambient / lights / rgb 不抛异常（脚本非法参数不炸运行时）", ok, "");
        }
    }

    // ---------------- ③ hash01 ----------------

    private static void runHash() {
        // 与 fixture 生成器（JS 的 charCodeAt 版）同一公式：期望值在这里独立手算一遍。
        // h = h*31 + code，取 32 位无符号回绕，再 (h % 100000)/100000
        check("hash01 空串 = 0", Math.abs(LightMap.hash01("") - 0f) < 1e-9f, "");
        check("hash01(null) 不抛异常（当空串）", Math.abs(LightMap.hash01(null) - 0f) < 1e-9f, "");
        String[] ids = {"L1", "L2", "S1", "torch-1", "js-light-17"};
        boolean allInRange = true;
        boolean deterministic = true;
        StringBuilder sb = new StringBuilder();
        for (String id : ids) {
            float v = LightMap.hash01(id);
            if (!(v >= 0f && v < 1f)) {
                allInRange = false;
            }
            if (v != LightMap.hash01(id)) {
                deterministic = false;
            }
            sb.append(id).append("=").append(String.format(java.util.Locale.ROOT, "%.5f", v)).append(" ");
        }
        check("hash01 全部落在 [0,1) 且可复现", allInRange && deterministic, sb.toString());
        // 与手算值对齐（ASCII 的 charCode 就是码位，两端一致）
        check("hash01(\"L1\") = 手算值", Math.abs(LightMap.hash01("L1") - jsHash01("L1")) < 1e-7f,
                "java=" + LightMap.hash01("L1") + " js=" + jsHash01("L1"));
        check("hash01(\"S1\") = 手算值", Math.abs(LightMap.hash01("S1") - jsHash01("S1")) < 1e-7f,
                "java=" + LightMap.hash01("S1") + " js=" + jsHash01("S1"));
        // 不同 id 必须给出不同相位（否则所有灯闪成同一个节奏）
        boolean distinct = LightMap.hash01("L1") != LightMap.hash01("L2")
                && LightMap.hash01("L2") != LightMap.hash01("S1");
        check("不同光源 id 的闪烁相位不同", distinct,
                "L1=" + LightMap.hash01("L1") + " L2=" + LightMap.hash01("L2"));
    }

    // ---------------- 独立参考实现（逐纹素，不做任何裁剪） ----------------

    /**
     * 契约 §2 的<b>朴素</b>参考实现：逐纹素、按 lights 下标顺序逐盏累加、不做包围盒裁剪。
     *
     * <p>它的唯一用途是给 {@link LightMap#bake} 的优化实现做<b>逐位</b>对照 ——
     * 「逐光源遍历 + 精确裁剪」一旦漏算某个纹素（例如包围盒算式差一格），
     * 只会在很窄的边界环上体现，fixture 的十几个采样点根本抓不住。
     * 刻意不复用被测代码的任何私有函数，符号/公式按契约正文再写一遍。
     */
    private static float[] referenceBake(float worldW, float worldH, float s,
                                         float[] ambient, List<LightMap.Light> lights) {
        LightMap.Result size = LightMap.sizeFor(worldW, worldH, s);
        int texW = size.texW;
        int texH = size.texH;
        float sEff = size.sEff;
        float[] rgb = new float[texW * texH * 3];
        for (int j = 0; j < texH; j++) {
            for (int i = 0; i < texW; i++) {
                double px = (i + 0.5) / (double) sEff;
                double py = (j + 0.5) / (double) sEff;
                double ar = ambient[0];
                double ag = ambient[1];
                double ab = ambient[2];
                for (int li = 0; li < lights.size(); li++) {
                    LightMap.Light L = lights.get(li);
                    if (!(L.radius > 0f) || !(L.intensity > 0f)) {
                        continue;
                    }
                    double dx = px - L.x;
                    double dy = py - L.y;
                    double d = Math.sqrt(dx * dx + dy * dy);
                    double t = d / L.radius;
                    if (t >= 1.0) {
                        continue;
                    }
                    double falloff = Math.min(4.0, Math.max(1.0, (double) L.falloff));
                    double atten = Math.pow(1.0 - t, falloff);
                    if (L.spot) {
                        double halfRad = (L.angleDeg / 2.0) * Math.PI / 180.0;
                        double dirRad = L.dirDeg * Math.PI / 180.0;
                        double angRad = Math.atan2(dy, dx);
                        double diff = Math.abs(normalizePiRef(angRad - dirRad));
                        if (diff > halfRad) {
                            continue;
                        }
                        double softRad = Math.max(0.0, L.coneSoftDeg) * Math.PI / 180.0;
                        if (softRad > 0.0 && diff > halfRad - softRad) {
                            atten *= Math.max(0.0, Math.min(1.0, (halfRad - diff) / softRad));
                        }
                    }
                    // 本断言只喂 shadow=false 的灯（遮挡另有专门断言），所以这里不做线段判定。
                    double sc = L.intensity * (1.0 + L.tickle) * atten;
                    ar += L.r * sc;
                    ag += L.g * sc;
                    ab += L.b * sc;
                }
                int o = (j * texW + i) * 3;
                rgb[o] = (float) Math.max(0.0, Math.min(1.0, ar));
                rgb[o + 1] = (float) Math.max(0.0, Math.min(1.0, ag));
                rgb[o + 2] = (float) Math.max(0.0, Math.min(1.0, ab));
            }
        }
        return rgb;
    }

    /** 参考实现自己的 normalizeToPi（不调 {@link LightMap#normalizeToPi}，保证独立）。 */
    private static double normalizePiRef(double a) {
        double v = a;
        while (v > Math.PI) {
            v -= Math.PI * 2.0;
        }
        while (v <= -Math.PI) {
            v += Math.PI * 2.0;
        }
        return v;
    }

    /** 测试内独立复算 hash01（不调被测实现，避免「实现和测试一起错」）。 */    private static float jsHash01(String id) {
        long h = 0L;
        for (int i = 0; i < id.length(); i++) {
            h = (h * 31L + id.charAt(i)) & 0xFFFFFFFFL;
        }
        return (float) ((h % 100000L) / 100000.0);
    }

    // ---------------- 小工具 ----------------

    private static float[] cloneArray(float[] src) {
        float[] out = new float[src.length];
        System.arraycopy(src, 0, out, 0, src.length);
        return out;
    }

    private static int[] px(LightMap.Result r, int i, int j) {
        int ii = Math.max(0, Math.min(r.texW - 1, i));
        int jj = Math.max(0, Math.min(r.texH - 1, j));
        int o = (jj * r.texW + ii) * 3;
        return new int[]{LightMap.channel(r.rgb[o]), LightMap.channel(r.rgb[o + 1]),
                LightMap.channel(r.rgb[o + 2])};
    }

    /** {@code #rrggbb} / {@code #rgb} → 0..1 的 {r,g,b}；非法 → null。 */
    private static float[] parseHex(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        if (!t.startsWith("#")) {
            return null;
        }
        String hex = t.substring(1);
        try {
            if (hex.length() == 3) {
                hex = "" + hex.charAt(0) + hex.charAt(0)
                        + hex.charAt(1) + hex.charAt(1)
                        + hex.charAt(2) + hex.charAt(2);
            }
            if (hex.length() != 6) {
                return null;
            }
            int v = Integer.parseInt(hex, 16);
            return new float[]{((v >> 16) & 0xFF) / 255f, ((v >> 8) & 0xFF) / 255f, (v & 0xFF) / 255f};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String str(JsonObject o, String k, String def) {
        JsonElement e = o.get(k);
        return e == null || e.isJsonNull() ? def : e.getAsString();
    }

    /** 读数值；支持 {@code "expect.texW"} 这种点路径（取嵌套对象里的字段）。 */
    private static double num(JsonObject o, String path, double def) {
        JsonObject cur = o;
        String[] parts = path.split("\\.");
        for (int i = 0; i < parts.length; i++) {
            String k = parts[i];
            JsonElement e = cur.get(k);
            if (e == null || e.isJsonNull()) {
                return def;
            }
            if (i == parts.length - 1) {
                try {
                    return e.getAsDouble();
                } catch (Exception ex) {
                    return def;
                }
            }
            if (!e.isJsonObject()) {
                return def;
            }
            cur = e.getAsJsonObject();
        }
        return def;
    }

    private static boolean boolOf(JsonObject o, String k, boolean def) {
        JsonElement e = o.get(k);
        if (e == null || e.isJsonNull()) {
            return def;
        }
        try {
            if (e.isJsonPrimitive() && e.getAsJsonPrimitive().isBoolean()) {
                return e.getAsBoolean();
            }
            if (e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber()) {
                return e.getAsDouble() != 0;
            }
            if (e.isJsonPrimitive()) {
                String s = e.getAsString().trim();
                return "1".equals(s) || "true".equalsIgnoreCase(s) || "开".equals(s);
            }
        } catch (Exception ignored) {
        }
        return def;
    }
}
