package Studio.runtime;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 复雷加殊（Complexweeper）规则内核自检。
 *
 * <p>验证 {@link ComplexRules} 的两条核心规则与
 * {@code docs/complexweeper-rules.md} 第 2、4 节完全一致：
 * <ul>
 *   <li>{@code label(re,im)}：{@code n = re² + im²}，完全平方 → 十进制整数，否则 {@code √n}；</li>
 *   <li>{@code ratioOk(fR,fI,aR,aI)}：交叉相乘 {@code fR*aI == fI*aR || fR*aR == fI*aI}。</li>
 * </ul>
 *
 * <p>断言来源有两路，互不依赖：
 * <ol>
 *   <li><b>fixtures</b>：{@code test/fixtures/complexweeper.json}（由
 *       {@code python tools/gen-complexweeper-fixtures.py} 生成，Node 侧 {@code verify-complexweeper.mjs}
 *       读同一份文件 → 三方交叉验证）；</li>
 *   <li><b>结构化断言</b>：直接把规则文档里的句子写成断言（标满标对必过、模长恒 ≥ 0 等）。</li>
 * </ol>
 * fixtures 找不到时<b>必须 FAIL 并打印绝对路径</b> —— 静默跳过会让这个套件在 CI 里变成永真。
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class ComplexMineRulesTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    /** fixtures 与仓库根的解析基准，失败信息里要打印绝对路径。 */
    private static final File FIXTURE = resolveFixture();

    private ComplexMineRulesTest() {
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
            RESULTS.add(new String[]{"rules test caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ComplexMineRulesTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("----------------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false",
                detail == null || detail.isEmpty() ? null : detail});
    }

    /** 找一个真实存在的 fixtures 路径；找不到则返回一个「会失败」的期望路径。 */
    private static File resolveFixture() {
        List<File> candidates = new ArrayList<File>();
        candidates.add(new File("test/fixtures/complexweeper.json"));
        String userDir = System.getProperty("user.dir");
        if (userDir != null) {
            candidates.add(new File(userDir, "test/fixtures/complexweeper.json"));
            File parent = new File(userDir).getParentFile();
            if (parent != null) {
                candidates.add(new File(parent, "test/fixtures/complexweeper.json"));
            }
        }
        // 从 class 文件位置向上找（IDE / 不同 cwd 兜底）。
        try {
            File self = new File(ComplexMineRulesTest.class.getProtectionDomain()
                    .getCodeSource().getLocation().toURI());
            File p = self;
            for (int i = 0; i < 6 && p != null; i++) {
                candidates.add(new File(p, "test/fixtures/complexweeper.json"));
                p = p.getParentFile();
            }
        } catch (Throwable ignored) {
            // 拿不到 code source 就走其它候选，不在这里失败。
        }
        for (File f : candidates) {
            if (f.isFile()) {
                return f.getAbsoluteFile();
            }
        }
        return new File("test/fixtures/complexweeper.json").getAbsoluteFile();
    }

    private static void run() throws Exception {
        // ---------------- 0) fixtures 必须存在 ----------------
        boolean fixtureOk = FIXTURE.isFile();
        check("fixtures 文件存在", fixtureOk, "期望路径: " + FIXTURE.getAbsolutePath());
        if (!fixtureOk) {
            // 找不到就等于「规则没验证过」，直接失败返回，不静默跳过。
            return;
        }

        JsonObject root;
        Reader reader = new InputStreamReader(Files.newInputStream(FIXTURE.toPath()), StandardCharsets.UTF_8);
        try {
            root = new Gson().fromJson(reader, JsonObject.class);
        } finally {
            reader.close();
        }
        check("fixtures 可解析为 JSON 对象", root != null, FIXTURE.getAbsolutePath());
        if (root == null) {
            return;
        }

        // ---------------- 1) label：fixtures 全量 ----------------
        JsonArray labels = root.getAsJsonArray("labels");
        check("fixtures 含 labels[]", labels != null && labels.size() > 0,
                labels == null ? "null" : String.valueOf(labels.size()));
        int labelCount = 0;
        int labelBad = 0;
        String firstBad = null;
        if (labels != null) {
            for (JsonElement el : labels) {
                JsonObject o = el.getAsJsonObject();
                int re = o.get("re").getAsInt();
                int im = o.get("im").getAsInt();
                String expect = o.get("label").getAsString();
                String actual = ComplexRules.label(re, im);
                labelCount++;
                if (!expect.equals(actual)) {
                    labelBad++;
                    if (firstBad == null) {
                        firstBad = "label(" + re + "," + im + ") 期望 " + expect + " 实得 " + actual;
                    }
                }
            }
        }
        check("label：fixtures 全部 " + labelCount + " 条一致", labelBad == 0,
                firstBad == null ? "" : (labelBad + " 条不一致；" + firstBad));

        // 顺带核对 fixtures 自带的 n / isInt 与我们的整数判定同源。
        int nBad = 0;
        String nFirst = null;
        if (labels != null) {
            for (JsonElement el : labels) {
                JsonObject o = el.getAsJsonObject();
                int re = o.get("re").getAsInt();
                int im = o.get("im").getAsInt();
                int n = o.get("n").getAsInt();
                boolean isInt = o.get("isInt").getAsBoolean();
                int actualN = re * re + im * im;
                boolean actualInt = ComplexRules.isPerfectSquare(actualN);
                if (actualN != n || actualInt != isInt) {
                    nBad++;
                    if (nFirst == null) {
                        nFirst = "label(" + re + "," + im + ") n 期望 " + n + " 实得 " + actualN
                                + " / isInt 期望 " + isInt + " 实得 " + actualInt;
                    }
                }
            }
        }
        check("label：fixtures 的 n / isInt 与整数完全平方判定一致", nBad == 0,
                nFirst == null ? "" : (nBad + " 条不一致；" + nFirst));

        // ---------------- 2) ratioOk：fixtures 全量 ----------------
        JsonArray ratios = root.getAsJsonArray("ratios");
        check("fixtures 含 ratios[]", ratios != null && ratios.size() > 0,
                ratios == null ? "null" : String.valueOf(ratios.size()));
        int ratioCount = 0;
        int ratioBad = 0;
        String ratioFirst = null;
        if (ratios != null) {
            for (JsonElement el : ratios) {
                JsonObject o = el.getAsJsonObject();
                int fR = o.get("fR").getAsInt();
                int fI = o.get("fI").getAsInt();
                int aR = o.get("aR").getAsInt();
                int aI = o.get("aI").getAsInt();
                boolean expect = o.get("ok").getAsBoolean();
                boolean actual = ComplexRules.ratioOk(fR, fI, aR, aI);
                ratioCount++;
                if (expect != actual) {
                    ratioBad++;
                    if (ratioFirst == null) {
                        ratioFirst = "ratioOk(" + fR + "," + fI + "," + aR + "," + aI + ") 期望 "
                                + expect + " 实得 " + actual;
                    }
                }
            }
        }
        check("ratioOk：fixtures 全部 " + ratioCount + " 条一致", ratioBad == 0,
                ratioFirst == null ? "" : (ratioBad + " 条不一致；" + ratioFirst));

        // ---------------- 3) sums：雷值编码求和 ----------------
        JsonArray sums = root.getAsJsonArray("sums");
        int sumCount = 0;
        int sumBad = 0;
        String sumFirst = null;
        if (sums != null) {
            for (JsonElement el : sums) {
                JsonObject o = el.getAsJsonObject();
                int expectRe = o.get("re").getAsInt();
                int expectIm = o.get("im").getAsInt();
                String expectLabel = o.get("label").getAsString();
                JsonArray mines = o.getAsJsonArray("mines");
                List<Integer> codes = new ArrayList<Integer>();
                if (mines != null) {
                    for (JsonElement m : mines) {
                        codes.add(parseMineTag(m.getAsString()));
                    }
                }
                int[] arr = new int[codes.size()];
                for (int i = 0; i < codes.size(); i++) {
                    arr[i] = codes.get(i);
                }
                int[] actual = ComplexRules.sumOf(arr);
                String actualLabel = ComplexRules.label(actual[0], actual[1]);
                sumCount++;
                if (actual[0] != expectRe || actual[1] != expectIm || !expectLabel.equals(actualLabel)) {
                    sumBad++;
                    if (sumFirst == null) {
                        sumFirst = "sums[" + sums.toString() + "] 期望 (" + expectRe + "," + expectIm
                                + ")=\"" + expectLabel + "\" 实得 (" + actual[0] + "," + actual[1]
                                + ")=\"" + actualLabel + "\"";
                    }
                }
            }
        }
        if (sums != null) {
            check("sums：fixtures 全部 " + sumCount + " 条一致（编码求和 → label）", sumBad == 0, sumFirst);
        }

        // ---------------- 4) 规则文档第 2 节的结构化断言 ----------------
        String[][] labelCases = {
                {"0", "0", "0"},
                {"1", "1", "0"},
                {"1", "-1", "0"},          // 模长恒 ≥ 0：(+1,0) 与 (−1,0) 都显示 1
                {"\u221a2", "1", "1"},
                {"5", "3", "4"},
                {"\u221a8", "2", "2"},
                {"\u221a2", "-1", "1"},    // 符号不影响模长
                {"\u221a2", "1", "-1"},   // (re,im)=(1,-1) → n=2 → √2；「抵消显示 0」是「两格雷求和」的事，不是单格
                {"\u221a32", "4", "4"},   // 4²+4²=32 非平方 → √32（与上一条 3²+4²=25 构成「非平方 / 平方」对照）
        };
        int structBad = 0;
        String structFirst = null;
        for (String[] c : labelCases) {
            int re = Integer.parseInt(c[1]);
            int im = Integer.parseInt(c[2]);
            String actual = ComplexRules.label(re, im);
            if (!c[0].equals(actual)) {
                structBad++;
                if (structFirst == null) {
                    structFirst = "label(" + re + "," + im + ") 期望 \"" + c[0] + "\" 实得 \"" + actual + "\"";
                }
            }
        }
        check("label：文档结构化断言 " + labelCases.length + " 条", structBad == 0, structFirst);

        // 完全平方判定必须是「整数」判定：double sqrt 在边界上会误判，这里钉死行为。
        boolean perfectOk = checkPerfectSquares();
        check("label：0 到 128 的整数完全平方判定与整数表一致", perfectOk, "");

        // ---------------- 5) 规则文档第 4 节的结构化断言 ----------------
        ComplexRules.class.getName(); // 触发类初始化（static 常量可读性）
        boolean zeroZero = ComplexRules.ratioOk(0, 0, 0, 0);
        check("ratioOk(0,0,0,0) == true（空邻域恒通过）", zeroZero, "实得 " + zeroZero);

        boolean realReal = ComplexRules.ratioOk(1, 0, 1, 0);
        check("ratioOk(1,0,1,0) == true（实雷对上实雷）", realReal, "实得 " + realReal);

        // A：1*1 == 0*0 → 1 == 0 不成立；B：1*0 == 0*1 → 0 == 0 成立 → true。
        boolean crossB = ComplexRules.ratioOk(1, 0, 0, 1);
        check("ratioOk(1,0,0,1) == true（B 反向等式成立）", crossB, "实得 " + crossB);

        // 文档：标满且标对时必然通过 —— fR==aR && fI==aI 的 A 恒真。
        int fillBad = 0;
        String fillFirst = null;
        for (int aR = 0; aR <= 4; aR++) {
            for (int aI = 0; aI <= 4; aI++) {
                boolean ok = ComplexRules.ratioOk(aR, aI, aR, aI);
                if (!ok) {
                    fillBad++;
                    if (fillFirst == null) {
                        fillFirst = "ratioOk(" + aR + "," + aI + "," + aR + "," + aI + ") 实得 false";
                    }
                }
            }
        }
        check("ratioOk：标满标对必过（aR/aI 各 0..4 共 25 组）", fillBad == 0, fillFirst);

        // 文档：① 只保证数量对、不保证旗插在对的格子 → 存在被 ①+② 骗过的情况；
        // 但「数量不对」时无论比例如何都不该通过（数量门槛由 chord 层实施，这里只钉比例函数本身）。
        boolean wrongKind = ComplexRules.ratioOk(2, 0, 1, 1);
        check("ratioOk(2,0,1,1) == false（数量/构成不匹配必须拒绝）", !wrongKind, "实得 " + wrongKind);

        // 交叉相乘不应有除零：虚雷全 0 的一侧也能给出稳定结果。
        boolean noDivide = ComplexRules.ratioOk(0, 2, 0, 2);
        check("ratioOk(0,2,0,2) == true（纯虚雷侧，无除零）", noDivide, "实得 " + noDivide);

        // ---------------- 6) 雷值编码工具 ----------------
        int[] posRe = ComplexRules.decompose(ComplexRules.POS_RE);
        int[] negRe = ComplexRules.decompose(ComplexRules.NEG_RE);
        int[] posIm = ComplexRules.decompose(ComplexRules.POS_IM);
        int[] negIm = ComplexRules.decompose(ComplexRules.NEG_IM);
        boolean decomposeOk = posRe[0] == 1 && posRe[1] == 0
                && negRe[0] == -1 && negRe[1] == 0
                && posIm[0] == 0 && posIm[1] == 1
                && negIm[0] == 0 && negIm[1] == -1;
        check("decompose：四种雷值编码 → (±1,0)/(0,±1)", decomposeOk,
                "实得 (" + posRe[0] + "," + posRe[1] + ") (" + negRe[0] + "," + negRe[1] + ") ("
                        + posIm[0] + "," + posIm[1] + ") (" + negIm[0] + "," + negIm[1] + ")");

        check("isReal / isImag 互斥且覆盖四种雷",
                ComplexRules.isReal(ComplexRules.POS_RE)
                        && ComplexRules.isReal(ComplexRules.NEG_RE)
                        && !ComplexRules.isReal(ComplexRules.POS_IM)
                        && ComplexRules.isImag(ComplexRules.POS_IM)
                        && ComplexRules.isImag(ComplexRules.NEG_IM)
                        && !ComplexRules.isImag(ComplexRules.POS_RE)
                        && !ComplexRules.isReal(ComplexRules.NONE)
                        && !ComplexRules.isImag(ComplexRules.NONE),
                "");

        // 入门一等：百位以内的整数平方判定逐值比对。
        boolean isqrtOk = checkIsqrt();
        check("isqrt：0..128 的整数开方逐值正确", isqrtOk, "");
    }

    /** fixtures 的 mines 标签 → 雷值编码。 */
    private static int parseMineTag(String tag) {
        String t = tag.trim();
        if ("+1".equals(t)) {
            return ComplexRules.POS_RE;
        }
        if ("-1".equals(t) || "\u22121".equals(t)) {
            return ComplexRules.NEG_RE;
        }
        if ("+i".equals(t)) {
            return ComplexRules.POS_IM;
        }
        if ("-i".equals(t)) {
            return ComplexRules.NEG_IM;
        }
        throw new IllegalArgumentException("未知雷标签: " + tag);
    }

    /** 0..128 逐个比对「完全平方」判定与整数平方表（钉死「不许用 double sqrt」）。 */
    private static boolean checkPerfectSquares() {
        for (int n = 0; n <= 128; n++) {
            int r = 0;
            while (r * r < n) {
                r++;
            }
            boolean expect = r * r == n;
            boolean actual = ComplexRules.isPerfectSquare(n);
            if (expect != actual) {
                return false;
            }
        }
        return true;
    }

    /** isqrt 逐值比对。 */
    private static boolean checkIsqrt() {
        for (int n = 0; n <= 128; n++) {
            int expect = 0;
            while ((expect + 1) * (expect + 1) <= n) {
                expect++;
            }
            if (ComplexRules.isqrt(n) != expect) {
                return false;
            }
        }
        return true;
    }
}
