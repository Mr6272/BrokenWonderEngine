package Studio.ui;

import java.awt.Color;
import java.awt.Font;
import java.awt.GraphicsEnvironment;
import java.util.HashSet;
import java.util.Set;

/**
 * BWE Studio 视觉令牌。
 * 单一色彩来源：所有面板只从这里取色，禁止在业务代码里写死 new Color(...)。
 * 设计语言 —— 浅底、墨蓝主色、8px 圆角、1px 细描边、无重投影。
 */
public final class Theme {

    private Theme() {
    }

    // ---------- 基础色 ----------
    public static final Color INK = new Color(0x1B2431);   // 主文字
    public static final Color INK_SUB = new Color(0x5A6675); // 次文字
    public static final Color INK_MUTE = new Color(0x8B96A5); // 弱文字

    public static final Color SHELL = new Color(0xE9EDF3);  // 窗口底
    public static final Color SURFACE = new Color(0xFFFFFF);  // 卡片面
    public static final Color SURFACE_ALT = new Color(0xF7F9FC); // 次级面
    public static final Color SURFACE_SUNK = new Color(0xEDF1F7); // 凹陷面
    public static final Color LINE = new Color(0xD8DEE8);  // 描边
    public static final Color LINE_SOFT = new Color(0xE8EDF4);  // 弱描边

    public static final Color ACCENT = new Color(0x2F6BFF);  // 主色
    public static final Color ACCENT_HOVER = new Color(0x4C81FF);
    public static final Color ACCENT_DOWN = new Color(0x1F55E0);
    public static final Color ACCENT_SOFT = new Color(0xE8EFFF); // 主色淡底

    public static final Color OK = new Color(0x12A06B);
    public static final Color WARN = new Color(0xE08A00);
    public static final Color DANGER = new Color(0xE14A4A);

    // ---------- 编辑器专用 ----------
    public static final Color CANVAS_BG = new Color(0x33383F);   // 画布工作区
    public static final Color CANVAS_GRID = new Color(0x3F454D);
    public static final Color CANVAS_GRID_MAJOR = new Color(0x4C535C);
    public static final Color SELECT = new Color(0x2F6BFF);
    public static final Color SELECT_FILL = new Color(0x2F, 0x6B, 0xFF, 40);
    public static final Color HOVER = new Color(0xFFD166);

    /** 模块色条：按模块类别取色，画布与积木卡片共用，保证"颜色即语义"。 */
    public static final Color MOD_MOVE = new Color(0x2F6BFF);
    public static final Color MOD_LOOK = new Color(0x7A5AF8);
    public static final Color MOD_SENSE = new Color(0x12A06B);
    public static final Color MOD_RULE = new Color(0xE08A00);
    public static final Color MOD_FIGHT = new Color(0xE14A4A);
    public static final Color MOD_TALK = new Color(0x0EA5B7);
    public static final Color MOD_SHOW = new Color(0x8A6D3B);

    // ---------- 尺度 ----------
    public static final int R_SM = 4, R_MD = 8, R_LG = 12;
    public static final int S1 = 4, S2 = 8, S3 = 12, S4 = 16, S5 = 24, S6 = 32;
    public static final int TOOLBAR_H = 44, STATUSBAR_H = 26, TOPBAR_H = 38;
    public static final int CARD_PAD = 12, CARD_GAP = 8;

    // ---------- 字体 ----------
    public static final Font F_H1 = ui(17, Font.BOLD);
    public static final Font F_H2 = ui(14, Font.BOLD);
    public static final Font F_BODY = ui(13, Font.PLAIN);
    public static final Font F_SMALL = ui(11, Font.PLAIN);
    public static final Font F_MONO = mono(12);

    private static String pickUi() {
        Set<String> have = new HashSet<>();
        for (String f : GraphicsEnvironment.getLocalGraphicsEnvironment().getAvailableFontFamilyNames()) {
            have.add(f);
        }
        String[] prefer = {"Microsoft YaHei UI", "微软雅黑", "Microsoft YaHei", "PingFang SC", "Segoe UI", "Dialog"};
        for (String p : prefer) {
            if (have.contains(p)) {
                return p;
            }
        }
        return Font.SANS_SERIF;
    }

    private static Font ui(int size, int style) {
        return new Font(pickUi(), style, size);
    }

    private static Font mono(int size) {
        Set<String> have = new HashSet<>();
        for (String f : GraphicsEnvironment.getLocalGraphicsEnvironment().getAvailableFontFamilyNames()) {
            have.add(f);
        }
        for (String p : new String[]{"Cascadia Mono", "JetBrains Mono", "Consolas", "Monospaced"}) {
            if (have.contains(p)) {
                return new Font(p, Font.PLAIN, size);
            }
        }
        return new Font(Font.MONOSPACED, Font.PLAIN, size);
    }

    /** 混色：t=0 取 a，t=1 取 b。 */
    public static Color mix(Color a, Color b, float t) {
        t = Math.max(0f, Math.min(1f, t));
        return new Color(
                Math.round(a.getRed() + (b.getRed() - a.getRed()) * t),
                Math.round(a.getGreen() + (b.getGreen() - a.getGreen()) * t),
                Math.round(a.getBlue() + (b.getBlue() - a.getBlue()) * t));
    }

    /** 透明度改写。 */
    public static Color alpha(Color c, int a) {
        return new Color(c.getRed(), c.getGreen(), c.getBlue(), Math.max(0, Math.min(255, a)));
    }

    /** 画布上可辨识的对象配色（按类型哈希取色，保证同一类型颜色稳定）。 */
    public static final Color[] CANVAS_PALETTE = {
            new Color(0x4C81FF), new Color(0x12A06B), new Color(0xE08A00),
            new Color(0xA855F7), new Color(0x0EA5B7), new Color(0xE14A4A),
            new Color(0x64748B), new Color(0x65A30D)
    };

    public static Color paletteOf(String key) {
        if (key == null) {
            return CANVAS_PALETTE[0];
        }
        return CANVAS_PALETTE[Math.abs(key.hashCode()) % CANVAS_PALETTE.length];
    }
}
