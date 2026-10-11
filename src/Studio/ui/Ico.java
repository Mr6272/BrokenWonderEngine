package Studio.ui;

import javax.swing.Icon;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Component;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.Ellipse2D;
import java.awt.geom.Line2D;
import java.awt.geom.Path2D;
import java.awt.geom.Rectangle2D;

/**
 * 矢量图标：全部用 Java2D 现场绘制，不依赖图形素材文件与外部字体。
 * 好处是任意尺寸都清晰、可随时换色，也让工程零二进制依赖。
 */
public final class Ico implements Icon {

    public enum Kind {
        ADD, IMPORT, EXPORT, SAVE, OPEN, UNDO, REDO, PLAY, STOP, TRASH, GRID,
        ZOOM_IN, ZOOM_OUT, FIT, LAYER, MODULE, PUZZLE, ASSET, SCRIPT, ACCOUNT,
        MUSIC, IMAGE, WAND, LOCK, CHEVRON_DOWN, CHEVRON_RIGHT, COPY, EYE, SEARCH, WARN
    }

    private final Kind kind;
    private final int size;
    private final Color color;

    private Ico(Kind kind, int size, Color color) {
        this.kind = kind;
        this.size = size;
        this.color = color;
    }

    /** 取图标实例（每次构造很轻，但建议调用方缓存复用）。 */
    public static Ico of(Kind kind, int size) {
        return new Ico(kind, size, Theme.INK_SUB);
    }

    public static Ico of(Kind kind, int size, Color color) {
        return new Ico(kind, size, color);
    }

    public Ico colored(Color c) {
        return new Ico(kind, size, c);
    }

    public Ico sized(int s) {
        return new Ico(kind, s, color);
    }

    @Override
    public int getIconWidth() {
        return size;
    }

    @Override
    public int getIconHeight() {
        return size;
    }

    @Override
    public void paintIcon(Component c, Graphics g, int x, int y) {
        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
        g2.translate(x, y);
        float s = size;
        float k = s / 16f;                       // 以 16px 为设计基准等比缩放
        g2.setColor(color);
        g2.setStroke(new BasicStroke(Math.max(1.2f, 1.5f * k), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        draw(g2, k, s);
        g2.dispose();
    }

    private void draw(Graphics2D g, float k, float s) {
        switch (kind) {
            case ADD -> {
                line(g, i(8, k), i(3, k), i(8, k), i(13, k));
                line(g, i(3, k), i(8, k), i(13, k), i(8, k));
            }
            case IMPORT -> {
                line(g, i(8, k), i(2, k), i(8, k), i(10, k));
                line(g, i(4.5f, k), i(6.5f, k), i(8, k), i(10, k));
                line(g, i(11.5f, k), i(6.5f, k), i(8, k), i(10, k));
                line(g, i(2.5f, k), i(13.5f, k), i(13.5f, k), i(13.5f, k));
            }
            case EXPORT -> {
                line(g, i(8, k), i(10, k), i(8, k), i(2, k));
                line(g, i(4.5f, k), i(5.5f, k), i(8, k), i(2, k));
                line(g, i(11.5f, k), i(5.5f, k), i(8, k), i(2, k));
                line(g, i(2.5f, k), i(13.5f, k), i(13.5f, k), i(13.5f, k));
            }
            case SAVE -> {
                Path2D p = new Path2D.Float();
                p.moveTo(i(2.5f, k), i(3.5f, k));
                p.lineTo(i(10.5f, k), i(3.5f, k));
                p.lineTo(i(13.5f, k), i(6.5f, k));
                p.lineTo(i(13.5f, k), i(13, k));
                p.lineTo(i(2.5f, k), i(13, k));
                p.closePath();
                g.draw(p);
                fill(g, i(5, k), i(3.5f, k), 4 * k, 3.5f * k);
                rect(g, i(5, k), i(9, k), 6 * k, 4 * k);
            }
            case OPEN -> {
                Path2D p = new Path2D.Float();
                p.moveTo(i(2, k), i(12.5f, k));
                p.lineTo(i(2, k), i(3.5f, k));
                p.lineTo(i(6.5f, k), i(3.5f, k));
                p.lineTo(i(8, k), i(5.5f, k));
                p.lineTo(i(14, k), i(5.5f, k));
                p.lineTo(i(14, k), i(6.5f, k));
                g.draw(p);
                Path2D q = new Path2D.Float();
                q.moveTo(i(2, k), i(12.5f, k));
                q.lineTo(i(4.5f, k), i(7.5f, k));
                q.lineTo(i(14.5f, k), i(7.5f, k));
                q.lineTo(i(12, k), i(12.5f, k));
                q.closePath();
                g.draw(q);
            }
            case UNDO, REDO -> {
                int dir = kind == Kind.UNDO ? 1 : -1;
                Path2D p = new Path2D.Float();
                p.moveTo(i(8 - 5f * dir, k), i(6, k));
                p.lineTo(i(8 + 1f * dir, k), i(6, k));
                p.lineTo(i(8 + 5f * dir, k), i(10, k));
                g.draw(p);
                line(g, i(8 - 5f * dir, k), i(6, k), i(8 - 5f * dir, k), i(2.5f, k));
                line(g, i(8 + 5f * dir, k), i(10, k), i(8 + 5f * dir, k), i(13, k));
            }
            case PLAY -> {
                Path2D p = new Path2D.Float();
                p.moveTo(i(4.5f, k), i(2.5f, k));
                p.lineTo(i(13, k), i(8, k));
                p.lineTo(i(4.5f, k), i(13.5f, k));
                p.closePath();
                g.fill(p);
            }
            case STOP -> fill(g, i(4, k), i(4, k), 8 * k, 8 * k);
            case TRASH -> {
                line(g, i(2.5f, k), i(4.5f, k), i(13.5f, k), i(4.5f, k));
                line(g, i(5.5f, k), i(4.5f, k), i(6.5f, k), i(2.5f, k));
                line(g, i(6.5f, k), i(2.5f, k), i(9.5f, k), i(2.5f, k));
                line(g, i(9.5f, k), i(2.5f, k), i(10.5f, k), i(4.5f, k));
                Path2D p = new Path2D.Float();
                p.moveTo(i(4, k), i(4.5f, k));
                p.lineTo(i(4.8f, k), i(13.5f, k));
                p.lineTo(i(11.2f, k), i(13.5f, k));
                p.lineTo(i(12, k), i(4.5f, k));
                g.draw(p);
            }
            case GRID -> {
                rect(g, i(2.5f, k), i(2.5f, k), 11 * k, 11 * k);
                line(g, i(8, k), i(2.5f, k), i(8, k), i(13.5f, k));
                line(g, i(2.5f, k), i(8, k), i(13.5f, k), i(8, k));
            }
            case ZOOM_IN, ZOOM_OUT -> {
                g.draw(new Ellipse2D.Float(i(2.5f, k), i(2.5f, k), 9 * k, 9 * k));
                line(g, i(10.5f, k), i(10.5f, k), i(14, k), i(14, k));
                line(g, i(5, k), i(8, k), i(9, k), i(8, k));
                if (kind == Kind.ZOOM_IN) {
                    line(g, i(7, k), i(6, k), i(7, k), i(10, k));
                }
            }
            case FIT -> {
                rect(g, i(2.5f, k), i(2.5f, k), 11 * k, 11 * k);
                line(g, i(5.5f, k), i(5.5f, k), i(8, k), i(8, k));
                line(g, i(10.5f, k), i(5.5f, k), i(8, k), i(8, k));
                line(g, i(5.5f, k), i(10.5f, k), i(8, k), i(8, k));
                line(g, i(10.5f, k), i(10.5f, k), i(8, k), i(8, k));
            }
            case LAYER -> {
                for (int n = 0; n < 3; n++) {
                    float yy = i(4.5f + n * 3.5f, k);
                    Path2D p = new Path2D.Float();
                    p.moveTo(i(8, k), yy - i(1.8f, k));
                    p.lineTo(i(14, k), yy);
                    p.lineTo(i(8, k), yy + i(1.8f, k));
                    p.lineTo(i(2, k), yy);
                    p.closePath();
                    if (n == 0) {
                        g.fill(p);
                    } else {
                        g.draw(p);
                    }
                }
            }
            case MODULE -> {
                rect(g, i(2.5f, k), i(2.5f, k), 6 * k, 6 * k);
                rect(g, i(7.5f, k), i(7.5f, k), 6 * k, 6 * k);
            }
            case PUZZLE -> {
                Path2D p = new Path2D.Float();
                p.moveTo(i(3, k), i(3, k));
                p.lineTo(i(7, k), i(3, k));
                p.curveTo(i(7, k), i(6, k), i(9, k), i(6, k), i(9, k), i(3, k));
                p.lineTo(i(13, k), i(3, k));
                p.lineTo(i(13, k), i(7, k));
                p.curveTo(i(10, k), i(7, k), i(10, k), i(9, k), i(13, k), i(9, k));
                p.lineTo(i(13, k), i(13, k));
                p.lineTo(i(3, k), i(13, k));
                p.closePath();
                g.draw(p);
            }
            case ASSET -> {
                rect(g, i(2.5f, k), i(3.5f, k), 11 * k, 9 * k);
                line(g, i(2.5f, k), i(10.5f, k), i(6.5f, k), i(7, k));
                line(g, i(6.5f, k), i(7, k), i(9.5f, k), i(10.5f, k));
                line(g, i(9.5f, k), i(10.5f, k), i(11.5f, k), i(8.5f, k));
                line(g, i(11.5f, k), i(8.5f, k), i(13.5f, k), i(10.5f, k));
                g.fill(new Ellipse2D.Float(i(10, k), i(5, k), 2.2f * k, 2.2f * k));
            }
            case SCRIPT -> {
                rect(g, i(3, k), i(2.5f, k), 10 * k, 11 * k);
                for (int n = 0; n < 4; n++) {
                    float yy = i(5.5f + n * 2.2f, k);
                    line(g, i(5, k), yy, i(n == 0 ? 11 : 9, k), yy);
                }
            }
            case ACCOUNT -> {
                g.draw(new Ellipse2D.Float(i(5.2f, k), i(2.4f, k), 5.6f * k, 5.6f * k));
                Path2D p = new Path2D.Float();
                p.moveTo(i(2.5f, k), i(14, k));
                p.curveTo(i(2.5f, k), i(9.5f, k), i(13.5f, k), i(9.5f, k), i(13.5f, k), i(14, k));
                g.draw(p);
            }
            case MUSIC -> {
                line(g, i(6, k), i(12, k), i(6, k), i(3, k));
                line(g, i(6, k), i(3, k), i(13, k), i(1.8f, k));
                line(g, i(13, k), i(1.8f, k), i(13, k), i(10.5f, k));
                g.fill(new Ellipse2D.Float(i(2.6f, k), i(10.8f, k), 3.4f * k, 2.8f * k));
                g.fill(new Ellipse2D.Float(i(9.6f, k), i(9.3f, k), 3.4f * k, 2.8f * k));
            }
            case IMAGE -> {
                rect(g, i(2.5f, k), i(3.5f, k), 11 * k, 9 * k);
                g.draw(new Ellipse2D.Float(i(6.4f, k), i(6.4f, k), 3.2f * k, 3.2f * k));
                line(g, i(5.5f, k), i(3.5f, k), i(7f, k), i(1.8f, k));
                line(g, i(7f, k), i(1.8f, k), i(9f, k), i(1.8f, k));
                line(g, i(9f, k), i(1.8f, k), i(10.5f, k), i(3.5f, k));
            }
            case WAND -> {
                line(g, i(3, k), i(13, k), i(11, k), i(5, k));
                line(g, i(12, k), i(2, k), i(12, k), i(5, k));
                line(g, i(10.5f, k), i(3.5f, k), i(13.5f, k), i(3.5f, k));
                line(g, i(4, k), i(2.5f, k), i(4, k), i(4.5f, k));
                line(g, i(3, k), i(3.5f, k), i(5, k), i(3.5f, k));
            }
            case LOCK -> {
                rect(g, i(3.5f, k), i(7, k), 9 * k, 6.5f * k);
                Path2D p = new Path2D.Float();
                p.moveTo(i(5.5f, k), i(7, k));
                p.lineTo(i(5.5f, k), i(4.5f, k));
                p.curveTo(i(5.5f, k), i(1.5f, k), i(10.5f, k), i(1.5f, k), i(10.5f, k), i(4.5f, k));
                p.lineTo(i(10.5f, k), i(7, k));
                g.draw(p);
            }
            case CHEVRON_DOWN -> {
                line(g, i(4, k), i(6, k), i(8, k), i(10, k));
                line(g, i(8, k), i(10, k), i(12, k), i(6, k));
            }
            case CHEVRON_RIGHT -> {
                line(g, i(6, k), i(4, k), i(10, k), i(8, k));
                line(g, i(10, k), i(8, k), i(6, k), i(12, k));
            }
            case COPY -> {
                rect(g, i(2.5f, k), i(2.5f, k), 8 * k, 8 * k);
                rect(g, i(5.5f, k), i(5.5f, k), 8 * k, 8 * k);
            }
            case EYE -> {
                Path2D p = new Path2D.Float();
                p.moveTo(i(1.8f, k), i(8, k));
                p.curveTo(i(4.5f, k), i(3.5f, k), i(11.5f, k), i(3.5f, k), i(14.2f, k), i(8, k));
                p.curveTo(i(11.5f, k), i(12.5f, k), i(4.5f, k), i(12.5f, k), i(1.8f, k), i(8, k));
                p.closePath();
                g.draw(p);
                g.fill(new Ellipse2D.Float(i(6.2f, k), i(6.2f, k), 3.6f * k, 3.6f * k));
            }
            case SEARCH -> {
                g.draw(new Ellipse2D.Float(i(2.5f, k), i(2.5f, k), 8.5f * k, 8.5f * k));
                line(g, i(10, k), i(10, k), i(14, k), i(14, k));
            }
            case WARN -> {
                Path2D p = new Path2D.Float();
                p.moveTo(i(8, k), i(2, k));
                p.lineTo(i(14.5f, k), i(13.5f, k));
                p.lineTo(i(1.5f, k), i(13.5f, k));
                p.closePath();
                g.draw(p);
                line(g, i(8, k), i(6, k), i(8, k), i(9.8f, k));
                g.fill(new Ellipse2D.Float(i(7.2f, k), i(11.2f, k), 1.6f * k, 1.6f * k));
            }
            default -> rect(g, i(3, k), i(3, k), 10 * k, 10 * k);
        }
    }

    private static float i(float v, float k) {
        return v * k;
    }

    // Graphics2D 的 drawLine/drawRect/fillRect 只接受 int，半像素坐标会被截断，
    // 因此统一走 Shape 浮点路径，缩放后依然锐利。
    private static void line(Graphics2D g, float x1, float y1, float x2, float y2) {
        g.draw(new Line2D.Float(x1, y1, x2, y2));
    }

    private static void rect(Graphics2D g, float x, float y, float w, float h) {
        g.draw(new Rectangle2D.Float(x, y, w, h));
    }

    private static void fill(Graphics2D g, float x, float y, float w, float h) {
        g.fill(new Rectangle2D.Float(x, y, w, h));
    }
}
