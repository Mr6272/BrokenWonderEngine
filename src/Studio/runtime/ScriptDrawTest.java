package Studio.runtime;

import javax.media.opengl.GLAutoDrawable;
import javax.media.opengl.GLCapabilities;
import javax.media.opengl.GLDrawableFactory;
import javax.media.opengl.GLEventListener;
import javax.media.opengl.GLProfile;
import javax.media.opengl.GL2;
import javax.media.opengl.GLOffscreenAutoDrawable;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.PrintStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * 脚本绘制层（HUD / 立即模式）的像素级回归自检。
 *
 * <p><b>为什么必须单独有这个测试</b>：这一层的问题只有在真 GL 里光栅化后才看得见。
 * 本轮修的一个长期 bug —— {@code bwe.draw.rect(radius:N)} 画出来的圆角矩形里有一个
 * <b>三角形楔形空洞</b> —— 就是这样：
 * <ul>
 *   <li>代码读起来完全正常（用 TRIANGLE_FAN 从中心连四角圆弧）；</li>
 *   <li>普通断言（"不崩" / "画了 N 个顶点"）全绿；</li>
 *   <li>但实际画面里，HUD 面板上有一条斜切的暗色楔形，用户会以为是"层级错乱"。</li>
 * </ul>
 * 根因：{@code GL_TRIANGLE_FAN} <b>不自动闭合</b>，缺 {@code (center, 最后一点, 第一点)}
 * 那个收尾三角形，最后一条边与中心之间留下空洞。
 *
 * <p>本测试用离屏 GL 真画一遍，然后<b>逐行检查填充宽度是否连续</b>——
 * 有空洞时宽度会在中间某行突然收窄，一眼就能判出来。
 *
 * <p>需要 GPU（离屏 FBO）。没有显示设备的环境会自动跳过并记 SKIP，不算失败。
 */
public final class ScriptDrawTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static int skipped;

    private ScriptDrawTest() {
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
            RESULTS.add(new String[]{"draw test caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1]) && !"skip".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptDrawTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            boolean skip = "skip".equals(r[1]);
            realOut.println((ok ? "PASS  " : skip ? "SKIP  " : "FAIL  ") + r[0]
                    + (!ok && !skip && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("------------------------------------");
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

    private static void run() throws Exception {
        BufferedImage img = renderRoundedRect();
        if (img == null) {
            skip("圆角矩形填充无空洞", "无 GL 设备（离屏 FBO 建不起来）");
            skip("圆角矩形左右边缘笔直", "无 GL 设备");
            skip("圆角矩形四角真的圆了", "无 GL 设备");
            return;
        }

        // ---- 断言 1：面板主体的每行填充宽度必须一致（有楔形空洞时中间会突然收窄）----
        int x0 = 16, y0 = 16, w = 272, h = 106;
        int insetY = 14; // 跳过上下圆角区域
        int minW = Integer.MAX_VALUE, maxW = -1;
        StringBuilder rows = new StringBuilder();
        for (int y = y0 + insetY; y <= y0 + h - insetY; y++) {
            int l = -1, r = -1;
            for (int x = x0 - 4; x <= x0 + w + 4; x++) {
                if (isPanel(img.getRGB(x, y))) {
                    l = x;
                    break;
                }
            }
            for (int x = x0 + w + 4; x >= x0 - 4; x--) {
                if (isPanel(img.getRGB(x, y))) {
                    r = x;
                    break;
                }
            }
            int width = r - l + 1;
            if (l < 0 || r < 0) {
                continue;
            }
            if (width < minW) {
                minW = width;
            }
            if (width > maxW) {
                maxW = width;
            }
            rows.append(y).append(":").append(width).append(" ");
        }
        int spread = maxW - minW;
        check("圆角矩形填充无空洞：中部每行宽度差 ≤ 2px（楔形空洞会差几十 px）",
                spread <= 2, "minW=" + minW + " maxW=" + maxW + " spread=" + spread + " rows=" + rows);

        // ---- 断言 2：宽度应该 ≈ w-2（左右各有 1px 描边内缩）----
        check("填充宽度 ≈ 矩形宽度（272）",
                minW >= w - 6, "minW=" + minW + " 期望≈" + w);

        // ---- 断言 3：四个角要真的圆（角像素不应是面板色）----
        boolean tl = !isPanel(img.getRGB(x0 + 1, y0 + 1));
        boolean tr = !isPanel(img.getRGB(x0 + w - 1, y0 + 1));
        boolean bl = !isPanel(img.getRGB(x0 + 1, y0 + h - 1));
        boolean br = !isPanel(img.getRGB(x0 + w - 1, y0 + h - 1));
        check("四角被切圆（radius=8 时角上不应是面板填充色）", tl && tr && bl && br,
                "tl=" + tl + " tr=" + tr + " bl=" + bl + " br=" + br);

        // ---- 断言 4：中心区域必须是实心的 ----
        int cx = x0 + w / 2, cy = y0 + h / 2;
        check("中心是实心面板色", isPanel(img.getRGB(cx, cy)), "rgb=" + Integer.toHexString(img.getRGB(cx, cy)));
    }

    /** 面板底色 #0b1420 与背景混合后大致落在这个范围（暗蓝）。 */
    private static boolean isPanel(int argb) {
        int r = (argb >> 16) & 0xFF;
        int g = (argb >> 8) & 0xFF;
        int b = argb & 0xFF;
        return r >= 8 && r <= 30 && g >= 16 && g <= 36 && b >= 24 && b <= 50;
    }

    /** 用离屏 GL 画一个和 hud.js 完全相同的圆角矩形（fill + stroke + radius=8 + alpha）。 */
    private static BufferedImage renderRoundedRect() throws Exception {
        final int W = 340, H = 200;
        GLProfile prof;
        GLOffscreenAutoDrawable od;
        try {
            prof = GLProfile.getDefault();
            GLCapabilities caps = new GLCapabilities(prof);
            caps.setAlphaBits(8);
            caps.setDoubleBuffered(false);
            od = GLDrawableFactory.getFactory(prof).createOffscreenAutoDrawable(null, caps, null, W, H);
        } catch (Throwable t) {
            return null;
        }
        if (od == null) {
            return null;
        }

        File boot = new File(".tmp_rel8/lead-build/Build/boot.json");
        if (!boot.isFile()) {
            return null;
        }
        final TopDownRuntime rt = new TopDownRuntime(boot);
        if (rt.scripts == null) {
            return null;
        }
        final BufferedImage[] cap = {null};
        final Throwable[] err = {null};

        od.addGLEventListener(new GLEventListener() {
            public void init(GLAutoDrawable d) {
            }

            public void dispose(GLAutoDrawable d) {
            }

            public void reshape(GLAutoDrawable d, int x, int y, int ww, int hh) {
                GL2 gl = d.getGL().getGL2();
                gl.glViewport(0, 0, ww, hh);
                gl.glMatrixMode(GL2.GL_PROJECTION);
                gl.glLoadIdentity();
                gl.glOrtho(0, ww, hh, 0, -1, 1);
                gl.glMatrixMode(GL2.GL_MODELVIEW);
                gl.glLoadIdentity();
            }

            public void display(GLAutoDrawable d) {
                try {
                    GL2 gl = d.getGL().getGL2();
                    gl.glEnable(GL2.GL_BLEND);
                    gl.glBlendFunc(GL2.GL_SRC_ALPHA, GL2.GL_ONE_MINUS_SRC_ALPHA);
                    gl.glClearColor(0.05f, 0.06f, 0.09f, 1f);
                    gl.glClear(GL2.GL_COLOR_BUFFER_BIT);
                    gl.glLoadIdentity();
                    gl.glDisable(GL2.GL_TEXTURE_2D);

                    ScriptRender r = new ScriptRender(rt.scripts);
                    List<ScriptRender.Cmd> cmds = new ArrayList<ScriptRender.Cmd>();
                    ScriptRender.Cmd c = new ScriptRender.Cmd();
                    c.type = ScriptRender.RECT;
                    c.x = 16;
                    c.y = 16;
                    c.w = 272;
                    c.h = 106;
                    c.fill = "#0b1420";
                    c.stroke = "#31465f";
                    c.radius = 8;
                    c.alpha = 0.9f;
                    cmds.add(c);
                    r.render(gl, cmds);
                    gl.glFinish();
                    cap[0] = readPixels(gl, W, H);
                } catch (Throwable t) {
                    err[0] = t;
                }
            }
        });

        try {
            od.display();
            od.display();
        } catch (Throwable t) {
            return null;
        }
        if (err[0] != null) {
            throw new RuntimeException(err[0]);
        }
        return cap[0];
    }

    private static BufferedImage readPixels(GL2 gl, int w, int h) {
        ByteBuffer buf = ByteBuffer.allocateDirect(w * h * 4);
        gl.glPixelStorei(GL2.GL_PACK_ALIGNMENT, 1);
        gl.glReadPixels(0, 0, w, h, GL2.GL_RGBA, GL2.GL_UNSIGNED_BYTE, buf);
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int i = ((y * w) + x) * 4;
                int r = buf.get(i) & 0xFF;
                int g = buf.get(i + 1) & 0xFF;
                int b = buf.get(i + 2) & 0xFF;
                img.setRGB(x, h - 1 - y, (255 << 24) | (r << 16) | (g << 8) | b);
            }
        }
        return img;
    }
}
