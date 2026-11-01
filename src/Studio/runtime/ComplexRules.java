package Studio.runtime;

import java.awt.Color;

/**
 * 复数雷规则（「复雷加殊」玩法）—— <b>纯规则，不含渲染与状态</b>。
 *
 * <p><b>为什么拆出来</b>：这段逻辑原本埋在 {@code TopDownRuntime.Minesweeper} 旁边，
 * 与外层耦合为零（只做整数运算与颜色映射）。独立后：
 * <ul>
 *   <li>任何需要「复数雷」规则的地方都能复用（测试、生成器、其它棋类玩法）；</li>
 *   <li>{@link #isqrt} / {@link #isPerfectSquare} 这类<b>通用整数工具</b>不再只属于扫雷；</li>
 *   <li>{@code Minesweeper} 可以专注棋盘状态机，文件也回到可读长度。</li>
 * </ul>
 *
 * <p>规则事实来源：{@code docs/complexweeper-rules.md}。
 * 四种雷编码：0 无雷 / 1 = +1 / 2 = −1 / 3 = +i / 4 = −i；
 * 格子数字 = 周围八格雷值之和的<b>模长</b>（n = re² + im²，是完全平方则显示整数，否则显示 √n）。
 */
final class ComplexRules {
    /** 无雷。 */
    static final int NONE = 0;
    /** 实雷 +1（红）。 */
    static final int POS_RE = 1;
    /** 实雷 −1（蓝）。 */
    static final int NEG_RE = 2;
    /** 虚雷 +i（紫）。 */
    static final int POS_IM = 3;
    /** 虚雷 −i（青）。 */
    static final int NEG_IM = 4;

    private ComplexRules() {
    }

    /** 雷值编码 → 实部（+1 / −1 / 0）。 */
    static int reOf(int code) {
        if (code == POS_RE) {
            return 1;
        }
        if (code == NEG_RE) {
            return -1;
        }
        return 0;
    }

    /** 雷值编码 → 虚部（+i / −i / 0）。 */
    static int imOf(int code) {
        if (code == POS_IM) {
            return 1;
        }
        if (code == NEG_IM) {
            return -1;
        }
        return 0;
    }

    /** 编码 → {实部, 虚部}；{@code mineValue} 的解码工具。 */
    static int[] decompose(int code) {
        return new int[]{reOf(code), imOf(code)};
    }

    /** 实雷（只有实部）：{@code +1} / {@code −1}。 */
    static boolean isReal(int code) {
        return code == POS_RE || code == NEG_RE;
    }

    /** 虚雷（只有虚部）：{@code +i} / {@code −i}。 */
    static boolean isImag(int code) {
        return code == POS_IM || code == NEG_IM;
    }

    /** 一组雷值编码求和 → {sumRe, sumIm}。 */
    static int[] sumOf(int... codes) {
        int re = 0;
        int im = 0;
        for (int i = 0; i < codes.length; i++) {
            re += reOf(codes[i]);
            im += imOf(codes[i]);
        }
        return new int[]{re, im};
    }

    /**
     * 整数开方（Newton 迭代，<b>全程整数</b>，不碰 double）。
     *
     * <p>模长判定必须整数化：{@code Math.sqrt} 在边界值上可能差 1 ulp，
     * 用 {@code (int) Math.sqrt(n) == r} 这种写法判定完全平方会有假阴性。
     */
    static int isqrt(int n) {
        if (n < 0) {
            return -1;
        }
        if (n < 2) {
            return n;
        }
        int x = n;
        int y = (x + 1) / 2;
        while (y < x) {
            x = y;
            y = (x + n / x) / 2;
        }
        return x;
    }

    /** n 是否为完全平方数（整数判定）。 */
    static boolean isPerfectSquare(int n) {
        int r = isqrt(n);
        return r >= 0 && r * r == n;
    }

    /**
     * 规则文档第 2 节：{@code n = re² + im²}；完全平方 → 十进制整数，否则 {@code "√" + n}。
     *
     * <p>模长恒 ≥ 0，所以 {@code (−1,0)} 与 {@code (+1,0)} 都显示 {@code 1}。
     */
    static String label(int sumRe, int sumIm) {
        long n = (long) sumRe * (long) sumRe + (long) sumIm * (long) sumIm;
        if (n > Integer.MAX_VALUE) {
            // 8 邻域最多 8 颗 ±1/±i，n ≤ 128，这条路实际走不到；留个兜底避免溢出静默错值。
            return "\u221a" + n;
        }
        int in = (int) n;
        if (isPerfectSquare(in)) {
            return String.valueOf(isqrt(in));
        }
        return "\u221a" + in;
    }

    /**
     * 规则文档第 4 节 ①②：虚实比例正确。
     *
     * <p>交叉相乘不做除法（因此不存在除零）。A（同向）: {@code fR * aI == fI * aR}；
     * B（反向）: {@code fR * aR == fI * aI}；满足任一即可。
     * 「标满且标对」（{@code fR == aR && fI == aI}）时 A 恒真 → 必然通过。
     */
    static boolean ratioOk(int fR, int fI, int aR, int aI) {
        return fR * aI == fI * aR || fR * aR == fI * aI;
    }

    /** 雷值编码 → 雷格上的小标注文案（普通模式不画）。 */
    static String tag(int code) {
        switch (code) {
            case POS_RE:
                return "+1";
            case NEG_RE:
                return "-1";
            case POS_IM:
                return "+i";
            case NEG_IM:
                return "-i";
            default:
                return "";
        }
    }

    /** 雷值编码 → 小标注颜色（红 / 蓝 / 紫 / 青，对齐视频里四种雷的配色）。 */
    static Color tagColor(int code) {
        switch (code) {
            case POS_RE:
                return new Color(0xd9, 0x3b, 0x3b);
            case NEG_RE:
                return new Color(0x2f, 0x64, 0xd8);
            case POS_IM:
                return new Color(0x8a, 0x4f, 0xa8);
            case NEG_IM:
                return new Color(0x2a, 0xa1, 0x98);
            default:
                return new Color(0x5a, 0x64, 0x78);
        }
    }

    /** 带根号数字的颜色：√2 青、√5 深绿、√8 蓝、√10 紫，其它灰蓝（规则文档第 9 节）。 */
    static Color rootColor(int n) {
        switch (n) {
            case 2:
                return new Color(0x2a, 0xa1, 0x98);
            case 5:
                return new Color(0x1f, 0x8a, 0x4c);
            case 8:
                return new Color(0x2f, 0x64, 0xd8);
            case 10:
                return new Color(0x8a, 0x4f, 0xa8);
            default:
                return new Color(0x5a, 0x64, 0x78);
        }
    }
    }