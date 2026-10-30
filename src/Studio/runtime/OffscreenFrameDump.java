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

/**
 * 离屏 GL 逐帧回归驱动器（校验专用，不是运行时代码）。
 *
 * <p>为什么需要它：现有自检（ScriptSelfTest 等）只看「脚本记录了哪些 draw 指令」，
 * 看不到「GL 真正画出了什么像素」。渲染批量化/合批这类优化最危险的回归是
 * <b>画面变了但指令数不变</b>，只有读 framebuffer 才抓得住。
 *
 * <p>做法：用 {@link GLOffscreenAutoDrawable}（FBO，不弹窗）挂上真的 {@link TopDownRuntime}
 * 作为 GLEventListener，推进 N 帧后 glReadPixels 存 PNG。两次运行的 PNG 做逐像素 diff，
 * 给出「差异像素数 / 最大通道差 / 差异包围盒」。
 *
 * <p>用法（同包，能调 package-private 入口）：
 * <pre>
 *   java ... Studio.runtime.OffscreenFrameDump &lt;Build/boot.json&gt; &lt;输出前缀&gt; &lt;帧数&gt; [宽] [高]
 * </pre>
 * 会写出 {@code <输出前缀>.png}（末帧）与 {@code <输出前缀>.hash.txt}（像素摘要，供快速比对）。
 */
public final class OffscreenFrameDump {

    private static int frames = 60;
    /** --fit：强制整图视角（看全城） */
    private static boolean fitWholeMap = false;
    private static String outPrefix = "frame";
    private static int width = 960;
    private static int height = 540;

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("用法: OffscreenFrameDump <boot.json> <输出前缀> [帧数] [宽] [高] [--fit]");
            System.err.println("  --fit  以「整图 contain」视角渲染（看全城，用于检查像素画整体观感）");
            System.err.println("         默认 = 1:1 跟随玩家（玩家实际看到的视角）");
            System.exit(2);
            return;
        }
        boolean fitAll = false;
        java.util.List<String> pos = new java.util.ArrayList<String>();
        for (String a : args) {
            if ("--fit".equals(a)) {
                fitAll = true;
            } else {
                pos.add(a);
            }
        }
        File boot = new File(pos.get(0)).getAbsoluteFile();
        outPrefix = pos.get(1);
        if (pos.size() > 2) {
            frames = Math.max(1, Integer.parseInt(pos.get(2)));
        }
        if (pos.size() > 3) {
            width = Math.max(64, Integer.parseInt(pos.get(3)));
        }
        if (pos.size() > 4) {
            height = Math.max(64, Integer.parseInt(pos.get(4)));
        }
        fitWholeMap = fitAll;

        System.out.println("OFFSCREEN_START boot=" + boot + " frames=" + frames + " " + width + "x" + height
                + " fitAll=" + fitAll);

        final TopDownRuntime rt = new TopDownRuntime(boot);
        if (rt.scripts == null) {
            System.out.println("OFFSCREEN_FAIL 脚本引擎没建起来");
            System.exit(3);
            return;
        }

        GLProfile prof = GLProfile.getDefault();
        GLCapabilities caps = new GLCapabilities(prof);
        caps.setAlphaBits(8);
        caps.setDoubleBuffered(false);
        GLOffscreenAutoDrawable drawable =
                GLDrawableFactory.getFactory(prof).createOffscreenAutoDrawable(null, caps, null, width, height);

        final int[] errCount = {0};
        final int[] frameNo = {0};
        // ⚠ 反射 Field 必须在帧循环**外面**解析一次再复用。
        // 之前每帧 getDeclaredField + setAccessible 两次，单次就要几十微秒 ——
        // 那是测量工具在污染被测对象，测出来的「帧时间」主要是我自己的反射开销。
        final java.lang.reflect.Field fLastNanos = field("lastNanos");
        final java.lang.reflect.Field fDrawCalls = field("debugDrawCallCount");
        final java.lang.reflect.Field fBegins = field("debugGlBeginCount");
        final java.lang.reflect.Field fBinds = field("debugTextureBindCount");
        // ⚠ glReadPixels 必须在 GL 上下文<b>当前</b>的时候调；离屏 drawable 的上下文只在
        // GLEventListener 回调里是 current。在 display() 外面拿 getGL() 读会读到未初始化的
        // 默认 framebuffer（全白），所以截图放在最后一帧的 display() 里做。
        final BufferedImage[] captured = {null};
        // display() 真实耗时（含 GL 提交 + 驱动开销，不含 vsync：FBO 不锁帧）。
        // 这是渲染优化唯一诚实的 CPU/驱动侧数字。
        final long[] displayNanos = {0L};
        final int[] debugCalls = {0};
        final int[] debugBegins = {0};
        final int[] debugBinds = {0};
        drawable.addGLEventListener(new GLEventListener() {
            @Override
            public void init(GLAutoDrawable d) {
                rt.init(d);
            }

            @Override
            public void dispose(GLAutoDrawable d) {
                // 不调 rt.dispose：它会停 animator（离屏没有），但保留纹理清理逻辑无害。
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
                    // rt.display() 内部用 lastNanos 算 dt；离屏连续调用会得到 ~0 的 dt。
                    // 为了让脚本/动画推进稳定，这里先把 lastNanos 归零，让每帧重新起算。
                    setLong(fLastNanos, rt, 0L);
                    if (fitWholeMap) {
                        // --fit：每帧强制「整图 contain」视角。
                        // 必须在 rt.display() 之前设，否则本帧已经按 1:1 画完了。
                        rt.forceFitWholeMap();
                    }
                    long t0 = System.nanoTime();
                    int drawsBefore = getInt(fDrawCalls, rt);
                    int beginsBefore = getInt(fBegins, rt);
                    rt.display(d);
                    if (frameNo[0] >= 2) {
                        // 前 2 帧是纹理上传/字体预热，剔除掉
                        displayNanos[0] += System.nanoTime() - t0;
                    }
                    debugCalls[0] = getInt(fDrawCalls, rt) - drawsBefore;
                    debugBegins[0] = getInt(fBegins, rt) - beginsBefore;
                    debugBinds[0] = getInt(fBinds, rt);
                    frameNo[0]++;
                    if (frameNo[0] >= frames) {
                        GL2 gl = d.getGL().getGL2();
                        gl.glFinish();
                        captured[0] = readPixels(gl, width, height);
                    }
                } catch (Throwable t) {
                    errCount[0]++;
                    if (errCount[0] <= 3) {
                        System.out.println("OFFSCREEN_FRAME_ERROR " + t);
                    }
                }
            }
        });

        // 首帧会触发 init + reshape + display
        drawable.display();
        while (frameNo[0] < frames) {
            sleepFrame();
            drawable.display();
        }

        BufferedImage img = captured[0];
        if (img == null) {
            System.out.println("OFFSCREEN_FAIL 没有抓到 framebuffer");
            System.exit(5);
            return;
        }
        File png = new File(outPrefix + ".png");
        File parent = png.getParentFile();
        if (parent != null) {
            parent.mkdirs();
        }
        javax.imageio.ImageIO.write(img, "png", png);
        long hash = pixelHash(img);
        BufferedImage norm = normalizeBg(img);
        long hashNorm = pixelHash(norm);
        int measured = Math.max(1, frames - 2);
        double avgDisplayMs = (displayNanos[0] / (double) measured) / 1_000_000.0;
        writeText(new File(outPrefix + ".hash.txt"),
                "size=" + width + "x" + height + "\n"
                        + "hash=" + Long.toHexString(hash) + "\n"
                        + "hashNormalized=" + Long.toHexString(hashNorm) + "\n"
                        + "nonBgPixels=" + countNonBg(norm) + "\n"
                        + "frameErrors=" + errCount[0] + "\n"
                        + "avgDisplayMs=" + String.format(java.util.Locale.ROOT, "%.3f", avgDisplayMs) + "\n"
                        + "glBeginsPerFrame=" + debugBegins[0] + "\n"
                        + "drawCallsPerFrame=" + debugCalls[0] + "\n"
                        + "textureBindsTotal=" + debugBinds[0] + "\n");
        // 机读行，供 mjs 解析（格式固定）
        System.out.println("OFFSCREEN_PERF frames=" + frames
                + " avgDisplayMs=" + String.format(java.util.Locale.ROOT, "%.3f", avgDisplayMs)
                + " glBeginsPerFrame=" + debugBegins[0]
                + " drawCallsPerFrame=" + debugCalls[0]
                + " textureBindsTotal=" + debugBinds[0]
                + " nonBgPixels=" + countNonBg(norm)
                + " hashNormalized=" + Long.toHexString(hashNorm));
        System.out.println("OFFSCREEN_DONE png=" + png.getAbsolutePath()
                + " hash=" + Long.toHexString(hash)
                + " hashNormalized=" + Long.toHexString(hashNorm)
                + " nonBgPixels=" + countNonBg(norm)
                + " frameErrors=" + errCount[0]);
        System.exit(errCount[0] == 0 ? 0 : 4);
    }

    /** 帧循环外解析一次字段；解析不到返回 null（旧类没有这些字段）。 */
    private static java.lang.reflect.Field field(String name) {
        try {
            java.lang.reflect.Field f = TopDownRuntime.class.getDeclaredField(name);
            f.setAccessible(true);
            return f;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static void setLong(java.lang.reflect.Field f, Object target, long v) {
        if (f == null) {
            return;
        }
        try {
            f.setLong(target, v);
        } catch (Throwable ignored) {
        }
    }

    private static int getInt(java.lang.reflect.Field f, Object target) {
        if (f == null) {
            return 0;
        }
        try {
            return f.getInt(target);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    private static void sleepFrame() {
        try {
            Thread.sleep(16L);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
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

    /** 把「纯底色」统一成同一值，抵消清屏色差异（批量化优化可能改清屏方式）。 */
    private static BufferedImage normalizeBg(BufferedImage src) {
        int w = src.getWidth();
        int h = src.getHeight();
        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int p = src.getRGB(x, y);
                out.setRGB(x, y, p);
            }
        }
        return out;
    }

    private static int countNonBg(BufferedImage img) {
        int w = img.getWidth();
        int h = img.getHeight();
        int bg = img.getRGB(0, 0);
        int n = 0;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (img.getRGB(x, y) != bg) {
                    n++;
                }
            }
        }
        return n;
    }

    private static long pixelHash(BufferedImage img) {
        long h = 1125899906842597L;
        int w = img.getWidth();
        int ht = img.getHeight();
        for (int y = 0; y < ht; y++) {
            for (int x = 0; x < w; x++) {
                h = 31 * h + img.getRGB(x, y);
            }
        }
        return h;
    }

    private static void writeText(File f, String text) throws Exception {
        java.nio.file.Files.write(f.toPath(), text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private OffscreenFrameDump() {
    }
}
