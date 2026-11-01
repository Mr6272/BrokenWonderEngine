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
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.util.Random;

/**
 * 扫雷取证驱动器（校验专用，不是运行时代码）。
 *
 * <p>为什么需要它：{@link OffscreenFrameDump} 只能「跑 N 帧然后截图」，没法翻开格子。
 * 未翻开的棋盘在两种模式下长得一模一样（都有地砖），所以光靠它证明不了
 * 复雷加殊的数字渲染。本驱动器在同一个 package 里直接调 {@code Minesweeper.click(wx,wy,right)}，
 * 把格子真正翻开，再走离屏 GL 截图 —— 看到的是引擎**真渲染**出来的像素，不是自绘图。
 *
 * <p>用法：
 * <pre>
 *   java ... Studio.runtime.MineShot &lt;boot.json&gt; &lt;输出前缀&gt; [宽] [高] [--mode normal|complex] [--reveal N]
 * </pre>
 * 写出 {@code <前缀>.png}，并打印 {@code MINESHOT_*} 行供脚本断言。
 */
public final class MineShot {

    private static int width = 960;
    private static int height = 540;

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("用法: MineShot <boot.json> <输出前缀> [宽] [高] [--reveal N]");
            System.exit(2);
            return;
        }
        java.util.List<String> pos = new java.util.ArrayList<String>();
        int reveal = 12;
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if ("--reveal".equals(a)) {
                reveal = Integer.parseInt(args[++i]);
            } else if (a.startsWith("--")) {
                // 忽略未知开关
            } else {
                pos.add(a);
            }
        }
        File boot = new File(pos.get(0)).getAbsoluteFile();
        String outPrefix = pos.get(1);
        if (pos.size() > 2) {
            width = Math.max(64, Integer.parseInt(pos.get(2)));
        }
        if (pos.size() > 3) {
            height = Math.max(64, Integer.parseInt(pos.get(3)));
        }

        System.out.println("MINESHOT_START boot=" + boot + " " + width + "x" + height);

        final TopDownRuntime rt = new TopDownRuntime(boot);
        if (rt.scripts == null) {
            System.out.println("MINESHOT_FAIL 脚本引擎没建起来");
            System.exit(3);
            return;
        }
        final Minesweeper ms = rt.minesweeper;
        if (ms == null) {
            System.out.println("MINESHOT_FAIL 场景里没有 game.minesweeper");
            System.exit(4);
            return;
        }

        System.out.println("MINESHOT_MODE " + (ms.complexMode ? "complex" : "normal")
                + " rows=" + ms.rows + " cols=" + ms.cols + " mines=" + ms.wantedMines);

        // 固定 seed 的时机必须在**脚本预热之后**：脚本的 pushBoard() 会带 seed:0 调
        // bwe.mine.set() 并 reset()，在预热帧里执行 —— 如果在这里就设 seed，会被它覆盖掉。
        // 所以真正设 seed 的地方在 display() 的 warmup 帧（见 warmupAndSeed）。
        final int revealCount = Math.max(0, reveal);
        final int[] clicked = {0};
        final int[] failures = {0};
        final BufferedImage[] captured = {null};

        GLProfile prof = GLProfile.getDefault();
        GLCapabilities caps = new GLCapabilities(prof);
        caps.setAlphaBits(8);
        caps.setDoubleBuffered(false);
        GLOffscreenAutoDrawable drawable =
                GLDrawableFactory.getFactory(prof).createOffscreenAutoDrawable(null, caps, null, width, height);

        final java.lang.reflect.Field fLastNanos = field("lastNanos");
        final int frames = 12;
        // 前 3 帧留给脚本 onSceneStart（pushBoard → reset），之后才点击。
        final int warmupFrames = 3;
        final int totalFrames = frames;
        final int[] frameIdx = {0};
        // display() 内部截图（GL 上下文 current 时才读得到像素）
        final BufferedImage[] capturedFrom = {null};

        drawable.addGLEventListener(new GLEventListener() {
            @Override
            public void init(GLAutoDrawable d) {
                rt.init(d);
            }

            @Override
            public void dispose(GLAutoDrawable d) {
                try {
                    rt.dispose(d);
                } catch (Throwable ignored) {
                }
            }

            @Override
            public void reshape(GLAutoDrawable d, int x, int y, int w, int h) {
                rt.reshape(d, x, y, w, h);
            }

            @Override
            public void display(GLAutoDrawable d) {
                try {
                    setLong(fLastNanos, rt, 0L);
                    // ⚠ 点击必须在**脚本初始化之后**：ScriptEngine.start() 是在 update() 里
                    // 第一次派发 onSceneStart 的，而脚本的 onSceneStart 会调 pushBoard()
                    // → bwe.mine.set() → reset()。如果在第 1 帧就点，进度会被这次 reset 清掉
                    // （现象：MINESHOT_AFTER_REVEAL open=40，但 MINESHOT_FRAME 0 立刻 open=0）。
                    // 所以先跑 WARMUP 帧让脚本跑完 onSceneStart，再翻开。
                    if (frameIdx[0] == warmupFrames && revealCount > 0 && clicked[0] == 0) {
                        // 此时脚本 onSceneStart 已跑完（pushBoard 的 seed:0 已生效过）。
                        // 设固定 seed 再 reset，保证 A/B 与两种模式的牌面**完全一致**。
                        ms.seed = 424242;
                        ms.reset();
                        int[] hits = revealSomeCells(ms, revealCount);
                        clicked[0] = hits[0];
                        failures[0] = hits[1];
                        System.out.println("MINESHOT_AFTER_REVEAL clicked=" + clicked[0]
                                + " open=" + countOpen(ms)
                                + " started=" + ms.started + " over=" + ms.over + " won=" + ms.won
                                + " flags=" + ms.flags + " mineCount=" + ms.mineCount
                                + " board=" + ms.boardW + "x" + ms.boardH
                                + " actor=(" + ms.actor.x + "," + ms.actor.y + ") cell=" + ms.cell);
                    }
                    frameIdx[0]++;
                    rt.display(d);
                    // ⚠ 截图必须在 GL 上下文 current 的 display() 内做。
                    // 在帧循环外 getGL() 读到的是未初始化的默认 framebuffer（全黑）。
                    if (frameIdx[0] >= totalFrames) {
                        GL2 g2 = d.getGL().getGL2();
                        g2.glFinish();
                        capturedFrom[0] = readPixels(g2, width, height);
                    }
                } catch (Throwable t) {
                    failures[0]++;
                    if (failures[0] <= 3) {
                        System.out.println("MINESHOT_FRAME_ERROR " + t);
                    }
                }
            }
        });

        // 手动推进帧：先画一帧让棋盘就绪，再翻开，再画若干帧。
        for (int i = 0; i < frames; i++) {
            final boolean[] openArrBefore = ms.open;
            final int openBefore = countOpen(ms);
            drawable.display();
            System.out.println("MINESHOT_FRAME " + i + " openBefore=" + openBefore
                    + " openAfter=" + countOpen(ms)
                    + " started=" + ms.started + " over=" + ms.over
                    + " arrayReplaced=" + (ms.open != openArrBefore));
        }
        captured[0] = capturedFrom[0];

        if (captured[0] == null) {
            System.out.println("MINESHOT_FAIL 截图为空");
            System.exit(5);
            return;
        }
        javax.imageio.ImageIO.write(captured[0], "png", new File(outPrefix + ".png"));
        System.out.println("MINESHOT_DONE png=" + outPrefix + ".png"
                + " clicked=" + clicked[0]
                + " open=" + countOpen(ms)
                + " frameErrors=" + failures[0]
                + " hash=" + hash(captured[0]));
        System.exit(0);
    }

    /**
     * 翻开若干个「安全」格子。
     *
     * <p>⚠ 关键顺序：雷是在**第一次点击**时才生成的（placeMines）。所以绝不能
     * 先按 {@code mine[]} 预筛格子再点 —— 那时 {@code mine} 还全是 false，筛了个寂寞，
     * 首击布雷之后下一格很可能就是雷，一点就判负、再点又触发 reset，最后
     * 「clicked 涨了但 open 还是 0」。正确做法：先点一格布雷，再按真实 {@code mine[]} 挑安全格。
     */
    private static int[] revealSomeCells(Minesweeper ms, int want) {
        int ok = 0;
        int rows = ms.rows, cols = ms.cols;
        float left = ms.actor.x - (cols * ms.cell) / 2f;
        float top = ms.actor.y - (rows * ms.cell) / 2f;
        // 第一击：布雷（首击必安全，除非模块关掉了 firstClickSafe）。
        int firstR = 0, firstC = 0;
        int wx0 = (int) (left + firstC * ms.cell + ms.cell / 2f);
        int wy0 = (int) (top + firstR * ms.cell + ms.cell / 2f);
        if (ms.click(wx0, wy0, false)) {
            ok++;
        }
        if (ms.over) {
            return new int[]{ok, 0};
        }
        // 之后按真实 mine[] 挑安全格，避开已经翻开的。
        for (int r = 0; r < rows && ok < want && !ms.over; r++) {
            for (int c = 0; c < cols && ok < want && !ms.over; c++) {
                int idx = r * cols + c;
                if (ms.mine[idx] || ms.open[idx]) {
                    continue;
                }
                int wx = (int) (left + c * ms.cell + ms.cell / 2f);
                int wy = (int) (top + r * ms.cell + ms.cell / 2f);
                if (ms.click(wx, wy, false)) {
                    ok++;
                }
            }
        }
        return new int[]{ok, 0};
    }

    private static int countOpen(Minesweeper ms) {
        int n = 0;
        for (int i = 0; i < ms.open.length; i++) {
            if (ms.open[i]) {
                n++;
            }
        }
        return n;
    }

    private static java.lang.reflect.Field field(String name) throws Exception {
        java.lang.reflect.Field f = TopDownRuntime.class.getDeclaredField(name);
        f.setAccessible(true);
        return f;
    }

    private static void setLong(java.lang.reflect.Field f, Object target, long v) {
        try {
            f.setLong(target, v);
        } catch (Throwable ignored) {
        }
    }

    private static BufferedImage readPixels(GL2 gl, int w, int h) {
        ByteBuffer buf = ByteBuffer.allocate(w * h * 4);
        gl.glReadPixels(0, 0, w, h, GL2.GL_RGBA, GL2.GL_UNSIGNED_BYTE, buf);
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int i = ((h - 1 - y) * w + x) * 4;
                int r = buf.get(i) & 0xff;
                int g = buf.get(i + 1) & 0xff;
                int b = buf.get(i + 2) & 0xff;
                img.setRGB(x, y, 0xff000000 | (r << 16) | (g << 8) | b);
            }
        }
        return img;
    }

    private static String hash(BufferedImage img) {
        long h = 1469598103934665603L;
        for (int y = 0; y < img.getHeight(); y++) {
            for (int x = 0; x < img.getWidth(); x++) {
                h ^= img.getRGB(x, y);
                h *= 1099511628211L;
            }
        }
        return Long.toHexString(h);
    }

    private MineShot() {
    }
}
