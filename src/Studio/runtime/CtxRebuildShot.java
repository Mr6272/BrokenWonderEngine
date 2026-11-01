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
import java.nio.ByteBuffer;

/**
 * GL 上下文重建回归驱动器（校验专用，不是运行时代码）。
 *
 * <p><b>它固定的是哪条契约</b>：玩家反馈「<b>切一下窗口就黑屏</b>」。
 * 根因是 GL 上下文丢失重建后，旧纹理/显示列表 id 全部失效，而引擎仍继续 bind 它们
 * —— 不报错、不崩溃，只是整屏变黑。
 *
 * <p><b>怎么验证</b>：在同一次 GL 上下文里渲染 N 帧得到截图 A；然后
 * <b>再次调 {@code rt.init(drawable)}</b>（这正是 JOGL 上下文重建后真实发生的回调），
 * 使引擎丢弃全部 GPU 资源并重新申请；再渲染 N 帧得到截图 B。
 * <ul>
 *   <li>若重建路径正确 → B 与 A <b>逐像素相同</b>（进度没丢、画面没黑）；
 *   <li>若重建路径缺失（旧版行为）→ 引擎拿失效 id 继续 bind → B 大面积为黑/空白。</li>
 * </ul>
 *
 * <p>这是「不靠肉眼、不靠真机」就能抓住黑屏回归的方法：真机上要复现上下文丢失很难，
 * 但 {@code init()} 被二次调用这件事本身是确定的。
 *
 * <p>用法（同包，能调 package-private 入口）：
 * <pre>
 *   java ... Studio.runtime.CtxRebuildShot &lt;Build/boot.json&gt; &lt;输出前缀&gt; [帧数] [宽] [高]
 * </pre>
 * 写出 {@code <前缀>-before.png} / {@code <前缀>-after.png}，并打印 {@code CTXSHOT_*} 行供断言。
 */
public final class CtxRebuildShot {

    private static int frames = 8;
    private static int width = 1280;
    private static int height = 720;

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("用法: CtxRebuildShot <boot.json> <outPrefix> [frames] [w] [h]");
            System.exit(2);
            return;
        }
        File boot = new File(args[0]).getAbsoluteFile();
        String outPrefix = args[1];
        if (args.length > 2) {
            frames = Math.max(2, Integer.parseInt(args[2]));
        }
        if (args.length > 3) {
            width = Math.max(64, Integer.parseInt(args[3]));
        }
        if (args.length > 4) {
            height = Math.max(64, Integer.parseInt(args[4]));
        }

        System.out.println("CTXSHOT_START boot=" + boot + " frames=" + frames + " " + width + "x" + height);

        final TopDownRuntime rt = new TopDownRuntime(boot);
        if (rt.scripts == null) {
            System.out.println("CTXSHOT_FAIL 脚本引擎没建起来");
            System.exit(3);
            return;
        }

        GLProfile prof = GLProfile.getDefault();
        GLCapabilities caps = new GLCapabilities(prof);
        caps.setAlphaBits(8);
        caps.setDoubleBuffered(false);
        final GLOffscreenAutoDrawable drawable =
                GLDrawableFactory.getFactory(prof)
                        .createOffscreenAutoDrawable(null, caps, null, width, height);

        final int[] phase = {0};          // 0 = 重建前，1 = 重建后
        final int[] frameInPhase = {0};
        final int[] errCount = {0};
        final BufferedImage[] before = {null};
        final BufferedImage[] after = {null};

        drawable.addGLEventListener(new GLEventListener() {
            @Override
            public void init(GLAutoDrawable d) {
                // ⚠ 完全按真实宿主的调用方式：上下文（重建）建立时回调 init。
                rt.init(d);
            }

            @Override
            public void dispose(GLAutoDrawable d) {
            }

            @Override
            public void reshape(GLAutoDrawable d, int x, int y, int w, int h) {
                rt.reshape(d, x, y, w, h);
            }

            @Override
            public void display(GLAutoDrawable d) {
                try {
                    java.lang.reflect.Field f = TopDownRuntime.class.getDeclaredField("lastNanos");
                    f.setAccessible(true);
                    f.setLong(rt, 0L);

                    rt.display(d);
                    frameInPhase[0]++;
                    if (frameInPhase[0] >= frames) {
                        GL2 gl = d.getGL().getGL2();
                        gl.glFinish();
                        BufferedImage img = readPixels(gl, width, height);
                        if (phase[0] == 0) {
                            before[0] = img;
                        } else {
                            after[0] = img;
                        }
                    }
                } catch (Throwable t) {
                    errCount[0]++;
                    if (errCount[0] <= 3) {
                        System.out.println("CTXSHOT_FRAME_ERROR " + t);
                    }
                }
            }
        });

        // ---- 阶段 1：正常渲染 ----
        drawable.display();
        while (before[0] == null) {
            frameSleep();
            drawable.display();
        }
        if (before[0] == null) {
            System.out.println("CTXSHOT_FAIL 重建前没抓到帧");
            System.exit(5);
            return;
        }
        writePng(before[0], outPrefix + "-before.png");

        System.out.println("CTXSHOT_BEFORE hash=" + Long.toHexString(pixelHash(before[0]))
                + " nonBg=" + countNonBg(before[0]));

        // ---- 模拟 GL 上下文丢失重建 ----
        //
        // ⚠ 只调 init() 是<b>不够</b>的：离屏 FBO 的上下文一直在，id 依旧有效，
        // 那样即使代码有缺陷也照样「通过」（第一次写这个驱动器就踩了这个坑）。
        // 真正的上下文丢失，特征是<b>引擎手里所有 GL 句柄都变成悬空值</b>。
        // 所以这里先把引擎知道的句柄全部「毒化」成无效 id（模拟驱动把旧 id 全部作废），
        // 再走真实宿主的回调顺序 init()。修好之后 init() 会从 CPU 侧源位图重建这些资源。
        int poisoned = poisonGlHandles(rt);
        System.out.println("CTXSHOT_POISON 已作废句柄数=" + poisoned);

        phase[0] = 1;
        frameInPhase[0] = 0;
        rt.init(drawable);

        // ---- 阶段 2：重建后继续渲染（必须照样有画面）----
        drawable.display();
        while (after[0] == null) {
            frameSleep();
            drawable.display();
        }
        if (after[0] == null) {
            System.out.println("CTXSHOT_FAIL 重建后没抓到帧");
            System.exit(5);
            return;
        }
        writePng(after[0], outPrefix + "-after.png");

        long hb = pixelHash(before[0]);
        long ha = pixelHash(after[0]);
        int diff = diffPixels(before[0], after[0]);
        int nonBgAfter = countNonBg(after[0]);

        System.out.println("CTXSHOT_AFTER hash=" + Long.toHexString(ha)
                + " nonBg=" + nonBgAfter
                + " diffPixels=" + diff
                + " frameErrors=" + errCount[0]);
        System.out.println("CTXSHOT_DONE before=" + Long.toHexString(hb)
                + " after=" + Long.toHexString(ha)
                + " identical=" + (hb == ha)
                + " diffPixels=" + diff);

        // 契约：重建后必须仍然有画面（非背景像素数与重建前同量级）。
        boolean ok = ha == hb && nonBgAfter > 0;
        System.out.println(ok ? "CTXSHOT_PASS 重建后画面与重建前一致"
                : "CTXSHOT_FAIL 重建后画面不一致或变黑");
        System.exit(ok ? 0 : 1);
    }

    /**
     * 把所有引擎已知的 GL 句柄「毒化」成无效值，模拟上下文丢失后驱动作废旧 id。
     *
     * <p>为什么必须这么做：{@code init()} 二次调用只是<b>时机</b>，真正让画面变黑的是
     * <b>句柄失效</b>这件事。只有让句柄真的失效，才能区分「代码正确重建了资源」
     * 和「代码什么都没做、但恰好 id 还能用」。
     *
     * @return 被作废的句柄数量
     */
    private static int poisonGlHandles(TopDownRuntime rt) {
        int n = 0;
        try {
            // ① 已上传纹理：id 全部置 -1
            java.lang.reflect.Field fUp = TopDownRuntime.class.getDeclaredField("uploadedTextures");
            fUp.setAccessible(true);
            @SuppressWarnings("unchecked")
            java.util.List<Texture> uploaded = (java.util.List<Texture>) fUp.get(rt);
            if (uploaded != null) {
                for (Texture t : uploaded) {
                    t.id = -1;
                    n++;
                }
            }
            // ② 地图显示列表 id 归零（旧上下文里录制的列表不再存在）
            java.lang.reflect.Field fMap = TopDownRuntime.class.getDeclaredField("mapListId");
            fMap.setAccessible(true);
            if (fMap.getInt(rt) != 0) {
                fMap.setInt(rt, 0);
                n++;
            }
            // ③ 按文件路径共享的纹理缓存：这些对象也会被 bind，id 必须一起作废
            java.lang.reflect.Field fCache = TopDownRuntime.class.getDeclaredField("textureCache");
            fCache.setAccessible(true);
            @SuppressWarnings("unchecked")
            java.util.Map<String, Texture> cache =
                    (java.util.Map<String, Texture>) fCache.get(rt);
            if (cache != null) {
                for (Texture t : cache.values()) {
                    t.id = -1;
                    n++;
                }
            }
            // ④ 扫雷棋盘自绘纹理：id 失效（修好之后 invalidateTexture 会让它重新申请）
            java.lang.reflect.Field fMine = TopDownRuntime.class.getDeclaredField("minesweeper");
            fMine.setAccessible(true);
            Object ms = fMine.get(rt);
            if (ms != null) {
                java.lang.reflect.Field fTex = ms.getClass().getDeclaredField("texture");
                fTex.setAccessible(true);
                Object tex = fTex.get(ms);
                if (tex instanceof Texture) {
                    ((Texture) tex).id = -1;
                    n++;
                }
            }
            // ⑤ 文字纹理缓存的 key 是「字号|颜色|阴影|内容」，值是 Texture ——
            //    这些也全是旧上下文的 id，必须一起作废。
            java.lang.reflect.Field fRender = TopDownRuntime.class.getDeclaredField("scripts");
            fRender.setAccessible(true);
            Object scripts = fRender.get(rt);
            if (scripts != null) {
                java.lang.reflect.Field fSr = scripts.getClass().getDeclaredField("render");
                fSr.setAccessible(true);
                Object render = fSr.get(scripts);
                if (render != null) {
                    java.lang.reflect.Field fTc = render.getClass().getDeclaredField("textCache");
                    fTc.setAccessible(true);
                    @SuppressWarnings("unchecked")
                    java.util.Map<String, Texture> tc =
                            (java.util.Map<String, Texture>) fTc.get(render);
                    if (tc != null) {
                        for (Texture t : tc.values()) {
                            t.id = -1;
                            n++;
                        }
                    }
                }
            }
        } catch (Throwable t) {
            System.out.println("CTXSHOT_POISON_ERROR " + t);
        }
        return n;
    }

    private static void frameSleep() {
        try {
            Thread.sleep(16L);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private static void writePng(BufferedImage img, String path) throws Exception {
        File f = new File(path);
        if (f.getParentFile() != null) {
            f.getParentFile().mkdirs();
        }
        javax.imageio.ImageIO.write(img, "png", f);
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
                int a = buf.get(i + 3) & 0xFF;
                img.setRGB(x, h - 1 - y, (a << 24) | (r << 16) | (g << 8) | b);
            }
        }
        return img;
    }

    private static long pixelHash(BufferedImage img) {
        long h = 0xcbf29ce484222325L;
        for (int y = 0; y < img.getHeight(); y++) {
            for (int x = 0; x < img.getWidth(); x++) {
                h = (h ^ (img.getRGB(x, y) & 0xFFFFFFFFL)) * 0x100000001b3L;
            }
        }
        return h;
    }

    /** 统计「非背景色」像素：背景是 glClearColor(0.055,0.067,0.1) → 约 (14,17,26)。 */
    private static int countNonBg(BufferedImage img) {
        int n = 0;
        for (int y = 0; y < img.getHeight(); y++) {
            for (int x = 0; x < img.getWidth(); x++) {
                int p = img.getRGB(x, y);
                int r = (p >> 16) & 0xFF;
                int g = (p >> 8) & 0xFF;
                int b = p & 0xFF;
                if (Math.abs(r - 14) > 6 || Math.abs(g - 17) > 6 || Math.abs(b - 26) > 6) {
                    n++;
                }
            }
        }
        return n;
    }

    private static int diffPixels(BufferedImage a, BufferedImage b) {
        if (a == null || b == null) {
            return Integer.MAX_VALUE;
        }
        if (a.getWidth() != b.getWidth() || a.getHeight() != b.getHeight()) {
            return Integer.MAX_VALUE;
        }
        int n = 0;
        for (int y = 0; y < a.getHeight(); y++) {
            for (int x = 0; x < a.getWidth(); x++) {
                if (a.getRGB(x, y) != b.getRGB(x, y)) {
                    n++;
                }
            }
        }
        return n;
    }

    private CtxRebuildShot() {
    }
}
