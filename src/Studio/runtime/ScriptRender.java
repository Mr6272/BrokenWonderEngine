package Studio.runtime;

import org.mozilla.javascript.Context;

import javax.media.opengl.GL2;
import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 脚本立即模式绘制（契约 §2.6）。
 *
 * <p>两个阶段：
 * <ol>
 *   <li><b>录制</b>：脚本在 onUpdate 里调 {@code bwe.draw.*}，参数被翻译成 {@link Cmd} 存进本帧列表
 *       （文字/精灵在这一步就把图片准备好，纹理上传会被宿主在同一帧的 uploadTextures 吃掉）；</li>
 *   <li><b>渲染</b>：宿主帧末调 {@link #render}。屏幕空间用恒等矩阵（宿主已 glLoadIdentity），
 *       世界空间在 push/pop 里临时叠加 {@link Viewport#applyGL}。</li>
 * </ol>
 *
 * <p>{@code gl == null}（无窗口自检）时整体跳过，绝不抛异常。
 */
final class ScriptRender {

    static final int TEXT = 1;
    static final int RECT = 2;
    static final int LINE = 3;
    static final int CIRCLE = 4;
    static final int SPRITE = 5;
    static final int BAR = 6;

    /** 一条绘制指令。字段直接暴露给 ScriptApi 填，避免过多构造重载。 */
    static final class Cmd {
        int type;
        boolean world;
        float x, y, w, h, r, alpha = 1f, size = 16f, width = 1f, pct = 1f, rotation;
        int radius;
        int frame;
        String text = "";
        String asset = "";
        String align = "left";
        String color = "#ffffff";
        String fill;
        String stroke;
        String bg;
        String border;
        String tint;
        boolean shadow = true;
        float u0, v0, u1, v1 = 1f;
        Texture tex;
    }

    private final ScriptEngine engine;
    private final TopDownRuntime host;

    /** 文字纹理缓存：key = 字号|颜色|阴影|内容。 */
    private final Map<String, Texture> textCache = new HashMap<String, Texture>();

    /**
     * 清空文字纹理缓存（GL 上下文重建后必须调）。
     * 缓存里存的是旧上下文的纹理 id，重建后 bind 它们只会得到黑色。
     */
    void clearTextTextures() {
        textCache.clear();
        textLru.clear();
    }
    /**
     * LRU 顺序表（最近使用的在最后）。{@link #textCache} 单靠 HashMap 无上限：
     * HUD 里 {@code "FPS 62"}、{@code "金币 37"}、计时器这类<b>每秒都变</b>的文本
     * 会让缓存无限增长 —— 每一条都是「一张 AWT 图片 + 一个 GL 纹理」，
     * 跑几分钟就是几千张纹理、几十 MB 显存，而且是纯泄漏（永不释放）。
     * 这里加硬上限 + 淘汰，把缓存变成真正的有界缓存。
     */
    private static final int TEXT_CACHE_MAX = 256;
    private final LinkedHashMap<String, Texture> textLru =
            new LinkedHashMap<String, Texture>(16, 0.75f, true);
    /** 被淘汰的纹理：登记给宿主，下一帧在 GL 线程里真正 glDeleteTextures。 */
    private final java.util.ArrayDeque<Texture> evicted =
            new java.util.ArrayDeque<Texture>();
    /** 累计创建过的文本纹理数（只增不减，用于证明「有界」而不是「没创建」）。 */
    private int textCreated;

    ScriptRender(ScriptEngine engine) {
        this.engine = engine;
        this.host = engine.host;
        // 预热 AWT 字体子系统：第一次画中文/measureText 会加载字体（Windows 上可能 100~300ms），
        // 如果留到某个脚本的 onUpdate 里，会被误判成「单帧 >250ms 死循环」。在引擎初始化时付掉。
        try {
            measure("热身", 16f);
            textImage("热身 warmup", 16, Color.WHITE, true);
        } catch (Throwable ignored) {
        }
    }

    // ---------------- 录制 ----------------

    /** 文字：录制时就渲染成图片（宿主本帧的 uploadTextures 会上传）。 */
    Cmd text(float x, float y, String text, float size, String color, String align, float alpha, boolean shadow) {
        Cmd c = new Cmd();
        c.type = TEXT;
        c.x = x;
        c.y = y;
        c.text = text == null ? "" : text;
        c.size = size <= 0f ? 16f : size;
        c.color = color == null || color.isEmpty() ? "#ffffff" : color;
        c.align = align == null ? "left" : align;
        c.alpha = clamp01(alpha);
        c.shadow = shadow;
        c.tex = textTexture(c);
        return c;
    }

    Cmd rect(float x, float y, float w, float h, String fill, String stroke, float alpha,
             int radius, float lineWidth) {
        Cmd c = new Cmd();
        c.type = RECT;
        c.x = x;
        c.y = y;
        c.w = w;
        c.h = h;
        c.fill = fill;
        c.stroke = stroke;
        c.alpha = clamp01(alpha);
        c.radius = Math.max(0, radius);
        c.width = lineWidth <= 0f ? 1f : lineWidth;
        return c;
    }

    Cmd line(float x1, float y1, float x2, float y2, String color, float width, float alpha) {
        Cmd c = new Cmd();
        c.type = LINE;
        c.x = x1;
        c.y = y1;
        c.w = x2;
        c.h = y2;
        c.color = color == null ? "#ffffff" : color;
        c.width = width <= 0f ? 1f : width;
        c.alpha = clamp01(alpha);
        return c;
    }

    Cmd circle(float x, float y, float r, String fill, String stroke, float alpha, float lineWidth) {
        Cmd c = new Cmd();
        c.type = CIRCLE;
        c.x = x;
        c.y = y;
        c.r = Math.max(0f, r);
        c.fill = fill;
        c.stroke = stroke;
        c.alpha = clamp01(alpha);
        c.width = lineWidth <= 0f ? 1f : lineWidth;
        return c;
    }

    // ---------------- 世界空间调试绘制（bwe.debug 用） ----------------
    //
    // 这些是「确保画在世界坐标」的封装：直接调 rect/line/circle 会继承调用时的
    // worldDrawDepth，而 bwe.debug 的绘制是在 onUpdate 之外（帧末自动绘）触发的，
    // 那时 depth 已经是 0。所以这里强制标 world=true。

    /** 世界空间矩形（描边），调试框用。<b>直接入队</b>，不经过 ScriptApi.addDraw。 */
    void worldRect(float x, float y, float w, float h, String color, float width, float alpha) {
        Cmd c = rect(x, y, w, h, null, color, alpha, 0, width);
        c.world = true;
        engine.drawCmds.add(c);
    }

    /** 世界空间直线。 */
    void worldLine(float x1, float y1, float x2, float y2, String color, float width, float alpha) {
        Cmd c = line(x1, y1, x2, y2, color, width, alpha);
        c.world = true;
        engine.drawCmds.add(c);
    }

    /** 世界空间圆（描边）。 */
    void worldCircle(float x, float y, float r, String color, float alpha) {
        Cmd c = circle(x, y, r, null, color, alpha, 1f);
        c.world = true;
        engine.drawCmds.add(c);
    }

    Cmd bar(float x, float y, float w, float h, float pct, String bg, String fg, String border, float alpha) {        Cmd c = new Cmd();
        c.type = BAR;
        c.x = x;
        c.y = y;
        c.w = w;
        c.h = h;
        c.pct = clamp01(pct);
        c.bg = bg;
        c.fill = fg;
        c.border = border;
        c.alpha = clamp01(alpha);
        return c;
    }

    /** 精灵：录制时解析素材纹理与图集 UV。{@code tint} 用 GL 调制实现（不改图片）。 */
    Cmd sprite(String assetName, float x, float y, float w, float h, float alpha,
               float rotation, int frame, String tint) {
        Cmd c = new Cmd();
        c.type = SPRITE;
        c.asset = assetName == null ? "" : assetName;
        c.x = x;
        c.y = y;
        c.alpha = clamp01(alpha);
        c.rotation = rotation;
        c.frame = frame;
        c.tint = tint;
        c.tex = host.firstTextureForName(c.asset);
        fillSpriteUv(c);
        if (w > 0f) {
            c.w = w;
        } else {
            c.w = c.tex != null ? c.tex.w : 32f;
        }
        if (h > 0f) {
            c.h = h;
        } else {
            c.h = c.tex != null ? c.tex.h : 32f;
        }
        return c;
    }

    private void fillSpriteUv(Cmd c) {
        c.u0 = 0f;
        c.v0 = 0f;
        c.u1 = 1f;
        c.v1 = 1f;
        GameData.RtAsset a = host.data.assetByName(c.asset);
        if (a == null || !"ATLAS".equalsIgnoreCase(a.kind)) {
            return;
        }
        int cols = Math.max(1, a.cols);
        int rows = Math.max(1, a.rows);
        int total = cols * rows;
        int idx = Math.max(0, Math.min(total - 1, c.frame));
        int col = idx % cols;
        int row = idx / cols;
        c.u0 = col / (float) cols;
        c.v0 = row / (float) rows;
        c.u1 = (col + 1) / (float) cols;
        c.v1 = (row + 1) / (float) rows;
    }

    /** {@code bwe.draw.measureText} 用：返回逻辑像素尺寸 {w, h}。 */
    float[] measure(String text, float size) {
        int fs = Math.max(6, Math.round(size <= 0f ? 16f : size));
        Font font = font(fs);
        BufferedImage probe = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = probe.createGraphics();
        try {
            g.setFont(font);
            FontMetrics fm = g.getFontMetrics();
            return new float[]{fm.stringWidth(text == null ? "" : text), fm.getHeight()};
        } catch (Throwable t) {
            return new float[]{(text == null ? 0 : text.length()) * fs * 0.6f, fs};
        } finally {
            g.dispose();
        }
    }

    private Texture textTexture(Cmd c) {
        int fs = Math.max(6, Math.round(c.size));
        // 高 DPI 超采样：纹理按「逻辑字号 × 物理/逻辑倍率」生成。
        // 否则 GL 把整幅画面放大 1.5 倍时，文字纹理被 NEAREST 插值拉伸 → 发虚/锯齿。
        float scale = host.displayScale();
        int px = Math.max(6, Math.round(fs * scale));
        String key = px + "|" + c.color + "|" + (c.shadow ? "1" : "0") + "|" + c.text;
        Texture cached = textCache.get(key);
        if (cached != null) {
            textLru.get(key); // 触碰：把这个 key 移到 LRU 末尾
            return cached;
        }
        BufferedImage img = textImage(c.text, px, parseColor(c.color, Color.WHITE), c.shadow);
        if (img == null) {
            return null;
        }
        try {
            Texture t = host.textureFromImage(img);
            if (t != null) {
                textCache.put(key, t);
                textLru.put(key, t);
                textCreated++;
                trimTextCache();
            }
            return t;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 超上限时按 LRU 淘汰，并把旧纹理登记给宿主销毁（避免显存泄漏）。 */
    private void trimTextCache() {
        while (textCache.size() > TEXT_CACHE_MAX) {
            java.util.Iterator<Map.Entry<String, Texture>> it =
                    textLru.entrySet().iterator();
            if (!it.hasNext()) {
                return;
            }
            Map.Entry<String, Texture> eldest = it.next();
            it.remove();
            textCache.remove(eldest.getKey());
            if (eldest.getValue() != null) {
                evicted.add(eldest.getValue());
            }
        }
    }

    /** 宿主每帧在 GL 线程里调：把淘汰掉的文本纹理真正删掉。 */
    void releaseEvicted(GL2 gl) {
        if (evicted.isEmpty() || gl == null) {
            return;
        }
        while (!evicted.isEmpty()) {
            Texture t = evicted.poll();
            if (t != null && t.id >= 0) {
                int[] ids = {t.id};
                try {
                    gl.glDeleteTextures(1, ids, 0);
                } catch (Throwable ignored) {
                }
                t.id = -1;
            }
        }
    }

    /** 自检/基准专用：当前文本纹理缓存条目数（有界缓存，稳定值应 ≤ 256）。 */
    int debugTextCacheSize() {
        return textCache.size();
    }

    /** 自检/基准专用：累计创建过的文本纹理数（证明「确实在创建」而不是缓存假象）。 */
    int debugTextCreated() {
        return textCreated;
    }

    private static Font font(int size) {
        // 中文优先雅黑/黑体，缺字体时回退 sans-serif（AWT 会自己替换）。
        String[] names = {"Microsoft YaHei", "微软雅黑", "SimHei", "SansSerif"};
        for (String n : names) {
            try {
                Font f = new Font(n, Font.PLAIN, size);
                if (f != null && !"Dialog".equalsIgnoreCase(f.getFamily())) {
                    return f;
                }
            } catch (Throwable ignored) {
            }
        }
        return new Font(Font.SANS_SERIF, Font.PLAIN, size);
    }

    /**
     * 给宿主用的文字纹理生成入口（虚拟摇杆的按键标签用）。
     *
     * <p>复用同一套 font/textImage 实现，保证标签与 HUD 文字风格一致；
     * 内部只是 {@link #textImage} 的公开包装。
     */
    static BufferedImage textImageForHost(String text, int size, Color color, boolean shadow) {
        return textImage(text, size, color, shadow);
    }

    /** 把一行文字画成 ARGB 图片；失败返回 null（绝不抛）。 */
    private static BufferedImage textImage(String text, int size, Color color, boolean shadow) {
        try {
            Font f = font(size);
            BufferedImage probe = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB);
            Graphics2D pg = probe.createGraphics();
            FontMetrics fm;
            try {
                pg.setFont(f);
                fm = pg.getFontMetrics();
            } finally {
                pg.dispose();
            }
            int pad = Math.max(2, size / 6);
            int w = Math.max(1, fm.stringWidth(text) + pad * 2);
            int h = Math.max(1, fm.getHeight() + pad * 2);
            BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g = img.createGraphics();
            try {
                g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING,
                        RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
                g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,
                        RenderingHints.VALUE_ANTIALIAS_ON);
                g.setFont(f);
                int baseline = pad + fm.getAscent();
                if (shadow) {
                    g.setColor(new Color(0f, 0f, 0f, 0.62f));
                    g.drawString(text, pad + Math.max(1, size / 16f), baseline + Math.max(1, size / 16f));
                }
                g.setColor(color);
                g.drawString(text, pad, baseline);
            } finally {
                g.dispose();
            }
            return img;
        } catch (Throwable t) {
            return null;
        }
    }

    // ---------------- 渲染 ----------------


    void render(GL2 gl, List<Cmd> cmds) {
        if (gl == null) {
            return;
        }
        for (int i = 0; i < cmds.size(); i++) {
            Cmd c = cmds.get(i);
            try {
                drawOne(gl, c);
            } catch (Throwable ignored) {
                // 单条绘制失败不能拖垮整帧。
            }
        }
        try {
            gl.glDisable(GL2.GL_TEXTURE_2D);
            gl.glColor4f(1f, 1f, 1f, 1f);
            gl.glLineWidth(1f);
        } catch (Throwable ignored) {
        }
    }

    private void drawOne(GL2 gl, Cmd c) {
        gl.glPushMatrix();
        try {
            if (c.world) {
                // 世界空间：叠加视口变换（宿主传进来时是恒等矩阵）。
                host.view.applyGL(gl);
            }
            switch (c.type) {
                case TEXT:
                    drawText(gl, c);
                    break;
                case RECT:
                    drawRect(gl, c);
                    break;
                case LINE:
                    drawLine(gl, c);
                    break;
                case CIRCLE:
                    drawCircle(gl, c);
                    break;
                case SPRITE:
                    drawSprite(gl, c);
                    break;
                case BAR:
                    drawBar(gl, c);
                    break;
                default:
                    break;
            }
        } finally {
            gl.glPopMatrix();
        }
    }


    private void drawText(GL2 gl, Cmd c) {
        Texture t = c.tex;
        if (t == null) {
            t = textTexture(c);
            c.tex = t;
        }
        if (t == null) {
            return;
        }
        // ⚠ 纹理是按「逻辑字号 × 物理倍率」超采样生成的，所以贴出去的尺寸必须
        // 除回该倍率，否则 HUD 文字在高 DPI 屏上会变成 1.5 倍大（位置看起来也整体偏移）。
        float scale = host.displayScale();
        float w = t.w / scale;
        float h = t.h / scale;
        float x = c.x;
        if ("center".equals(c.align) || "middle".equals(c.align)) {
            x -= w / 2f;
        } else if ("right".equals(c.align) || "end".equals(c.align)) {
            x -= w;
        }
        host.drawTexture(gl, t, x + w / 2f, c.y + h / 2f, w, h, 0f, c.alpha, 0f, 0f, 1f, 1f);
    }

    private void drawRect(GL2 gl, Cmd c) {
        Color fill = c.fill == null ? null : parseColor(c.fill, null);
        Color stroke = c.stroke == null ? null : parseColor(c.stroke, null);
        if (fill != null && fill.getAlpha() > 0) {
            setColor(gl, fill, c.alpha);
            if (c.radius > 0) {
                fillRoundRect(gl, c.x, c.y, c.w, c.h, Math.min(c.radius, Math.min(c.w, c.h) / 2f));
            } else {
                quad(gl, c.x, c.y, c.w, c.h);
            }
        }
        if (stroke != null && stroke.getAlpha() > 0) {
            setColor(gl, stroke, c.alpha);
            gl.glLineWidth(Math.max(1f, c.width));
            lineLoop(gl, c.x, c.y, c.w, c.h);
            gl.glLineWidth(1f);
        }
    }

    private void drawLine(GL2 gl, Cmd c) {
        Color color = parseColor(c.color, Color.WHITE);
        setColor(gl, color, c.alpha);
        gl.glLineWidth(c.width);
        gl.glBegin(GL2.GL_LINES);
        gl.glVertex2f(c.x, c.y);
        gl.glVertex2f(c.w, c.h);
        gl.glEnd();
        gl.glLineWidth(1f);
    }

    private void drawCircle(GL2 gl, Cmd c) {
        Color fill = c.fill == null ? null : parseColor(c.fill, null);
        Color stroke = c.stroke == null ? null : parseColor(c.stroke, null);
        int seg = Math.max(12, Math.min(64, (int) (c.r / 2f) + 16));
        if (fill != null && fill.getAlpha() > 0) {
            setColor(gl, fill, c.alpha);
            gl.glBegin(GL2.GL_TRIANGLE_FAN);
            gl.glVertex2f(c.x, c.y);
            for (int i = 0; i <= seg; i++) {
                double a = i * Math.PI * 2 / seg;
                gl.glVertex2f(c.x + (float) Math.cos(a) * c.r, c.y + (float) Math.sin(a) * c.r);
            }
            gl.glEnd();
        }
        if (stroke != null && stroke.getAlpha() > 0) {
            setColor(gl, stroke, c.alpha);
            gl.glLineWidth(Math.max(1f, c.width));
            gl.glBegin(GL2.GL_LINE_LOOP);
            for (int i = 0; i < seg; i++) {
                double a = i * Math.PI * 2 / seg;
                gl.glVertex2f(c.x + (float) Math.cos(a) * c.r, c.y + (float) Math.sin(a) * c.r);
            }
            gl.glEnd();
            gl.glLineWidth(1f);
        }
    }

    private void drawSprite(GL2 gl, Cmd c) {
        if (c.tex != null && c.tex.id >= 0) {
            Color tint = c.tint == null ? null : parseColor(c.tint, null);
            float r = tint == null ? 1f : tint.getRed() / 255f;
            float g = tint == null ? 1f : tint.getGreen() / 255f;
            float b = tint == null ? 1f : tint.getBlue() / 255f;
            float a = c.alpha * (tint == null ? 1f : tint.getAlpha() / 255f);
            gl.glEnable(GL2.GL_TEXTURE_2D);
            gl.glBindTexture(GL2.GL_TEXTURE_2D, c.tex.id);
            gl.glColor4f(r, g, b, a);
            gl.glPushMatrix();
            try {
                gl.glTranslatef(c.x, c.y, 0f);
                if (c.rotation != 0f) {
                    gl.glRotatef(c.rotation, 0f, 0f, 1f);
                }
                float l = -c.w / 2f;
                float rr = c.w / 2f;
                float t = -c.h / 2f;
                float bb = c.h / 2f;
                gl.glBegin(GL2.GL_QUADS);
                gl.glTexCoord2f(c.u0, c.v0);
                gl.glVertex2f(l, t);
                gl.glTexCoord2f(c.u1, c.v0);
                gl.glVertex2f(rr, t);
                gl.glTexCoord2f(c.u1, c.v1);
                gl.glVertex2f(rr, bb);
                gl.glTexCoord2f(c.u0, c.v1);
                gl.glVertex2f(l, bb);
                gl.glEnd();
            } finally {
                gl.glPopMatrix();
                gl.glDisable(GL2.GL_TEXTURE_2D);
                gl.glColor4f(1f, 1f, 1f, 1f);
            }
            return;
        }
        // 没有素材（或纹理还没上传）：画一个淡色块，脚本不会因为缺图崩掉。
        setColor(gl, new Color(0.6f, 0.6f, 0.7f), c.alpha * 0.7f);
        quad(gl, c.x - c.w / 2f, c.y - c.h / 2f, c.w, c.h);
    }

    private void drawBar(GL2 gl, Cmd c) {
        Color bg = c.bg == null ? new Color(0.1f, 0.1f, 0.12f) : parseColor(c.bg, new Color(0.1f, 0.1f, 0.12f));
        Color fg = c.fill == null ? new Color(0.3f, 0.85f, 0.45f) : parseColor(c.fill, new Color(0.3f, 0.85f, 0.45f));
        Color border = c.border == null ? null : parseColor(c.border, null);
        setColor(gl, bg, c.alpha);
        quad(gl, c.x, c.y, c.w, c.h);
        if (c.pct > 0f) {
            setColor(gl, fg, c.alpha);
            quad(gl, c.x, c.y, c.w * c.pct, c.h);
        }
        if (border != null) {
            setColor(gl, border, c.alpha);
            gl.glLineWidth(1f);
            lineLoop(gl, c.x, c.y, c.w, c.h);
        }
    }

    private static void setColor(GL2 gl, Color color, float alpha) {
        gl.glDisable(GL2.GL_TEXTURE_2D);
        float a = (color.getAlpha() / 255f) * alpha;
        gl.glColor4f(color.getRed() / 255f, color.getGreen() / 255f, color.getBlue() / 255f, a);
    }

    private static void quad(GL2 gl, float x, float y, float w, float h) {
        gl.glBegin(GL2.GL_QUADS);
        gl.glVertex2f(x, y);
        gl.glVertex2f(x + w, y);
        gl.glVertex2f(x + w, y + h);
        gl.glVertex2f(x, y + h);
        gl.glEnd();
    }

    private static void lineLoop(GL2 gl, float x, float y, float w, float h) {
        gl.glBegin(GL2.GL_LINE_LOOP);
        gl.glVertex2f(x, y);
        gl.glVertex2f(x + w, y);
        gl.glVertex2f(x + w, y + h);
        gl.glVertex2f(x, y + h);
        gl.glEnd();
    }

    /**
     * 填充圆角矩形。
     *
     * <p><b>⚠ 这里曾经有个长期存在的显示 bug（HUD 面板里出现一个三角形楔形缺口）</b>：
     * 用 {@code GL_TRIANGLE_FAN} 从中心连到四角圆弧时，扇形<b>不会自动闭合</b> ——
     * GL 只生成 {@code (v0,v1,v2), (v0,v2,v3) … (v0,v_{n-1},v_n)}，
     * <b>没有</b> {@code (v0,v_n,v1)} 这个收尾三角形。
     * 于是多边形最后一条边（这里是左边：从左下角回到左上角）与中心之间留下一个
     * 三角空洞 ⇒ 面板上出现一条斜切的暗色楔形，看起来像「层级错乱 / 半透明叠加」。
     *
     * <p>修法：扇形的最后一个顶点<b>重复一次起点</b>，用退化的收尾三角形把最后那段补上。
     * 这是 GL_TRIANGLE_FAN 画闭合多边形的标准做法。
     */
    private static void fillRoundRect(GL2 gl, float x, float y, float w, float h, float r) {
        if (r <= 0.5f) {
            quad(gl, x, y, w, h);
            return;
        }
        int seg = 4;
        // 四角圆心 + 各自的角度区间（屏幕 y 向下，角度顺时针：PI 左、1.5PI 上、0 右、0.5PI 下）
        float[][] corners = {
                {x + r, y + r, (float) Math.PI, 1.5f * (float) Math.PI},
                {x + w - r, y + r, 1.5f * (float) Math.PI, 2f * (float) Math.PI},
                {x + w - r, y + h - r, 0f, 0.5f * (float) Math.PI},
                {x + r, y + h - r, 0.5f * (float) Math.PI, (float) Math.PI},
        };
        float cx = x + w / 2f;
        float cy = y + h / 2f;
        // 先把全部边界点算出来（首尾相邻去重），这样「重复起点」时才不会重复画中间点
        int total = corners.length * seg + 1;
        float[] px = new float[total + 1];
        float[] py = new float[total + 1];
        int n = 0;
        for (float[] c : corners) {
            for (int i = 0; i < seg; i++) {
                double a = c[2] + (c[3] - c[2]) * i / seg;
                px[n] = c[0] + (float) Math.cos(a) * r;
                py[n] = c[1] + (float) Math.sin(a) * r;
                n++;
            }
        }
        if (n == 0) {
            quad(gl, x, y, w, h);
            return;
        }
        gl.glBegin(GL2.GL_TRIANGLE_FAN);
        gl.glVertex2f(cx, cy);
        for (int i = 0; i < n; i++) {
            gl.glVertex2f(px[i], py[i]);
        }
        // ★ 重复起点：补上 (center, 最后一点, 第一点) 这个收尾三角形，闭合多边形
        gl.glVertex2f(px[0], py[0]);
        gl.glEnd();
    }

    // ---------------- 颜色 ----------------

    private static float clamp01(float v) {
        return v < 0f ? 0f : (v > 1f ? 1f : v);
    }

    static Color parseColor(String s, Color def) {
        if (s == null || s.isEmpty()) {
            return def;
        }
        String v = s.trim();
        if ("transparent".equalsIgnoreCase(v) || "none".equalsIgnoreCase(v)) {
            return new Color(0, 0, 0, 0);
        }
        // 常见颜色名（脚本里写起来方便，也避免依赖 AWT 的颜色表差异）。
        if (!v.startsWith("#")) {
            if ("white".equalsIgnoreCase(v)) {
                return Color.WHITE;
            }
            if ("black".equalsIgnoreCase(v)) {
                return Color.BLACK;
            }
            if ("red".equalsIgnoreCase(v)) {
                return new Color(255, 60, 60);
            }
            if ("green".equalsIgnoreCase(v)) {
                return new Color(60, 220, 90);
            }
            if ("blue".equalsIgnoreCase(v)) {
                return new Color(70, 130, 255);
            }
            if ("yellow".equalsIgnoreCase(v)) {
                return new Color(255, 220, 60);
            }
            if ("gray".equalsIgnoreCase(v) || "grey".equalsIgnoreCase(v)) {
                return new Color(150, 150, 155);
            }
            if ("orange".equalsIgnoreCase(v)) {
                return new Color(255, 160, 50);
            }
            if ("cyan".equalsIgnoreCase(v)) {
                return new Color(60, 220, 220);
            }
            if ("magenta".equalsIgnoreCase(v)) {
                return new Color(230, 80, 220);
            }
            return def;
        }
        try {
            String hex = v.substring(1);
            if (hex.length() == 3) {
                hex = "" + hex.charAt(0) + hex.charAt(0)
                        + hex.charAt(1) + hex.charAt(1)
                        + hex.charAt(2) + hex.charAt(2);
            }
            if (hex.length() == 6) {
                return new Color(Integer.parseInt(hex, 16));
            }
            if (hex.length() == 8) {
                // #rrggbbaa
                int rgba = (int) Long.parseLong(hex, 16);
                int r = (rgba >>> 24) & 0xFF;
                int g = (rgba >>> 16) & 0xFF;
                int b = (rgba >>> 8) & 0xFF;
                int a = rgba & 0xFF;
                return new Color(r, g, b, a);
            }
            if (hex.length() == 4) {
                // #rgba
                String full = "" + hex.charAt(0) + hex.charAt(0)
                        + hex.charAt(1) + hex.charAt(1)
                        + hex.charAt(2) + hex.charAt(2)
                        + hex.charAt(3) + hex.charAt(3);
                int rgba = Integer.parseInt(full, 16);
                return new Color((rgba >>> 24) & 0xFF, (rgba >>> 16) & 0xFF,
                        (rgba >>> 8) & 0xFF, rgba & 0xFF);
            }
        } catch (Throwable ignored) {
        }
        return def;
    }
}
