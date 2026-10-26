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
        TopDownRuntime.Texture tex;
    }

    private final ScriptEngine engine;
    private final TopDownRuntime host;

    /** 文字纹理缓存：key = 字号|颜色|阴影|内容。 */
    private final Map<String, TopDownRuntime.Texture> textCache = new HashMap<String, TopDownRuntime.Texture>();

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

    Cmd bar(float x, float y, float w, float h, float pct, String bg, String fg, String border, float alpha) {
        Cmd c = new Cmd();
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

    private TopDownRuntime.Texture textTexture(Cmd c) {
        int fs = Math.max(6, Math.round(c.size));
        String key = fs + "|" + c.color + "|" + (c.shadow ? "1" : "0") + "|" + c.text;
        TopDownRuntime.Texture cached = textCache.get(key);
        if (cached != null) {
            return cached;
        }
        BufferedImage img = textImage(c.text, fs, parseColor(c.color, Color.WHITE), c.shadow);
        if (img == null) {
            return null;
        }
        try {
            TopDownRuntime.Texture t = host.textureFromImage(img);
            if (t != null) {
                textCache.put(key, t);
            }
            return t;
        } catch (Throwable t) {
            return null;
        }
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
        TopDownRuntime.Texture t = c.tex;
        if (t == null) {
            t = textTexture(c);
            c.tex = t;
        }
        if (t == null) {
            return;
        }
        float w = t.w;
        float h = t.h;
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

    private static void fillRoundRect(GL2 gl, float x, float y, float w, float h, float r) {
        if (r <= 0.5f) {
            quad(gl, x, y, w, h);
            return;
        }
        int seg = 4;
        float[][] corners = {
                {x + r, y + r, (float) Math.PI, 1.5f * (float) Math.PI},
                {x + w - r, y + r, 1.5f * (float) Math.PI, 2f * (float) Math.PI},
                {x + w - r, y + h - r, 0f, 0.5f * (float) Math.PI},
                {x + r, y + h - r, 0.5f * (float) Math.PI, (float) Math.PI},
        };
        gl.glBegin(GL2.GL_TRIANGLE_FAN);
        gl.glVertex2f(x + w / 2f, y + h / 2f);
        for (float[] c : corners) {
            for (int i = 0; i <= seg; i++) {
                double a = c[2] + (c[3] - c[2]) * i / seg;
                gl.glVertex2f(c[0] + (float) Math.cos(a) * r, c[1] + (float) Math.sin(a) * r);
            }
        }
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
