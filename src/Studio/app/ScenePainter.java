package Studio.app;

import Studio.data.AssetEntry;
import Studio.data.Project;
import Studio.data.SceneModel;
import Studio.data.SceneObject;
import Studio.render.ImageCache;
import Studio.ui.Theme;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.RenderingHints;
import java.awt.geom.AffineTransform;
import java.awt.geom.Ellipse2D;
import java.awt.geom.Path2D;
import java.awt.geom.RoundRectangle2D;
import java.io.File;
import java.util.HashMap;
import java.util.Map;

/**
 * 画布绘制器：把场景画到任意 Graphics2D 上。
 *
 * 之所以独立于画布控件：导出缩略图、场景预览、未来的小地图都要复用同一套绘制，
 * 复制一份必然走样。
 *
 * 俯视角约定：世界坐标 X 向右、Y 向下，1 单位 = 1 像素，与运行时一致。
 */
public final class ScenePainter {

    /** 绘制所需的上下文（由画布提供）。 */
    public static final class Ctx {
        public File root;
        public double zoom = 1;
        public boolean showGrid = true;
        public boolean showColliders = true;
        public boolean showZones = true;
        public boolean showNames = true;
        public long animClockMs;
        /** 正在拖动/缩放的临时覆盖（避免每帧改模型） */
        public Map<String, float[]> overrides = new HashMap<>();
    }

    private ScenePainter() {
    }

    /** 网格 + 原点标尺。缩放很小时自动隐藏细网格，避免糊成一片。 */
    public static void paintGrid(Graphics2D g, SceneModel s, Ctx ctx, int tile) {
        int w = s.widthTiles * tile;
        int h = s.heightTiles * tile;

        g.setColor(Theme.CANVAS_BG);
        g.fillRect(0, 0, w, h);

        if (ctx.showGrid && ctx.zoom > 0.28) {
            g.setStroke(new BasicStroke(1f));
            g.setColor(Theme.CANVAS_GRID);
            for (int x = 0; x <= s.widthTiles; x++) {
                int px = x * tile;
                g.drawLine(px, 0, px, h);
            }
            for (int y = 0; y <= s.heightTiles; y++) {
                int py = y * tile;
                g.drawLine(0, py, w, py);
            }
            // 每 8 格加粗一根，便于目测距离
            g.setColor(Theme.CANVAS_GRID_MAJOR);
            for (int x = 0; x <= s.widthTiles; x += 8) {
                int px = x * tile;
                g.drawLine(px, 0, px, h);
            }
            for (int y = 0; y <= s.heightTiles; y += 8) {
                int py = y * tile;
                g.drawLine(0, py, w, py);
            }
        }

        // 地图外边界
        g.setColor(Theme.alpha(Theme.ACCENT, 90));
        g.setStroke(new BasicStroke(2f));
        g.drawRect(0, 0, w, h);
    }

    /** 画一个对象（含素材、碰撞框、名字、模块角标）。 */
    public static void paintObject(Graphics2D g, Project p, SceneObject o, Ctx ctx, boolean selected) {
        float[] ov = ctx.overrides.get(o.id);
        float ox = o.x, oy = o.y;
        if (ov != null) {
            ox = ov[0];
            oy = ov[1];
        }
        int w = sizeW(p, o);
        int h = sizeH(p, o);

        Image img = null;
        AssetEntry a = p.assets.get(o.assetId);
        if (a != null && a.kind != Studio.data.AssetKind.AUDIO) {
            int frames = Math.max(1, a.totalFrames());
            int idx = 0;
            if (frames > 1 && o.animMode != null && !o.animMode.equals("只显示首帧")) {
                float fps = o.animFps <= 0 ? 8 : o.animFps;
                idx = (int) ((ctx.animClockMs / 1000.0 * fps) % frames);
            }
            img = ImageCache.frame(ctx.root, a, idx);
        }

        AffineTransform old = g.getTransform();
        g.translate(ox, oy);
        if (o.rotation != 0) {
            g.rotate(Math.toRadians(o.rotation));
        }

        if ("ZONE".equals(o.kind.name()) || (o.halfW > 0 && o.halfH > 0)) {
            if (ctx.showZones || !"ZONE".equals(o.kind.name())) {
                // 触发区与碰撞区：半透明填充 + 虚线轮廓
                Color c = "ZONE".equals(o.kind.name()) ? new Color(0x12A06B) : Theme.paletteOf(o.kind.name());
                g.setColor(Theme.alpha(c, 46));
                g.fillRect((int) (-w / 2f), (int) (-h / 2f), w, h);
                g.setStroke(new BasicStroke(1.4f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER,
                        1f, new float[]{4f, 3f}, 0f));
                g.setColor(Theme.alpha(c, 190));
                g.drawRect((int) (-w / 2f), (int) (-h / 2f), w, h);
            }
        }

        if (img != null) {
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                    ctx.zoom >= 1 ? RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR
                            : RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.drawImage(img, -w / 2, -h / 2, w, h, null);
        } else {
            paintPlaceholder(g, o, w, h, ctx.zoom);
        }

        // 出生点 / 传送口：用固定符号标出来，避免和普通物件混淆
        if ("SPAWN".equals(o.kind.name())) {
            g.setColor(new Color(0x12A06B));
            g.setStroke(new BasicStroke(2f));
            g.draw(new Ellipse2D.Double(-w / 2.0, -h / 2.0, w, h));
            g.drawString("出", -4, 4);
        } else if ("PORTAL".equals(o.kind.name())) {
            g.setColor(new Color(0x7A5AF8));
            g.setStroke(new BasicStroke(2.5f));
            g.draw(new Ellipse2D.Double(-w / 2.0, -h / 2.0, w, h));
        }

        g.setTransform(old);

        // 选中框 + 控制点
        if (selected) {
            g.setColor(Theme.SELECT);
            g.setStroke(new BasicStroke(1.6f));
            g.setColor(Theme.alpha(Theme.SELECT, 200));
            g.fillRect((int) (ox - w / 2f), (int) (oy - h / 2f), w, h);
            g.setColor(Theme.SELECT);
            g.drawRect((int) (ox - w / 2f), (int) (oy - h / 2f), w, h);
            int hs = 5;
            for (int dx = -1; dx <= 1; dx += 2) {
                for (int dy = -1; dy <= 1; dy += 2) {
                    int px = (int) (ox + dx * w / 2f) - hs / 2;
                    int py = (int) (oy + dy * h / 2f) - hs / 2;
                    g.setColor(Color.WHITE);
                    g.fillRect(px, py, hs, hs);
                    g.setColor(Theme.SELECT);
                    g.drawRect(px, py, hs, hs);
                }
            }
            if (ctx.showColliders && o.halfW > 0 && o.halfH > 0) {
                g.setColor(Theme.alpha(new Color(0xE08A00), 200));
                g.setStroke(new BasicStroke(1.2f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER,
                        1f, new float[]{3f, 3f}, 0f));
                g.drawRect((int) (ox - o.halfW), (int) (oy - o.halfH), (int) (o.halfW * 2), (int) (o.halfH * 2));
            }
        }

        // 名字与模块数
        if (ctx.showNames && ctx.zoom > 0.42) {
            g.setFont(Theme.F_SMALL);
            String label = o.name;
            int tw = g.getFontMetrics().stringWidth(label);
            int tx = (int) (ox - tw / 2.0);
            int ty = (int) (oy + h / 2.0 + 13);
            g.setColor(new Color(0, 0, 0, 150));
            g.fillRoundRect(tx - 4, ty - 11, tw + 8, 15, 6, 6);
            g.setColor(new Color(0xDCE3ED));
            g.drawString(label, tx, ty);
        }
        if (!o.modules.isEmpty() && ctx.zoom > 0.5) {
            int badge = 0;
            for (Studio.data.ModuleInstance m : o.modules) {
                if (m.enabled) {
                    badge++;
                }
            }
            if (badge > 0) {
                int bx = (int) (ox + w / 2f) - 9;
                int by = (int) (oy - h / 2f) - 4;
                g.setColor(new Color(0x2F6BFF));
                g.fillRoundRect(bx, by, 18, 15, 7, 7);
                g.setColor(Color.WHITE);
                g.setFont(Theme.F_SMALL.deriveFont(Font.BOLD, 10f));
                String t = String.valueOf(badge);
                g.drawString(t, bx + 9 - g.getFontMetrics().stringWidth(t) / 2, by + 11);
            }
        }
    }

    /** 没有素材时的占位：按对象类型画出可辨认的轮廓，绝不留空白。 */
    private static void paintPlaceholder(Graphics2D g, SceneObject o, int w, int h, double zoom) {
        Color base = Theme.paletteOf(o.kind.name());
        g.setColor(Theme.alpha(base, 210));
        float r = Math.min(10, Math.min(w, h) * 0.25f);
        g.fill(new RoundRectangle2D.Float(-w / 2f, -h / 2f, w, h, r, r));
        g.setColor(Theme.alpha(Theme.mix(base, Color.BLACK, 0.35f), 235));
        g.setStroke(new BasicStroke(1.4f));
        g.draw(new RoundRectangle2D.Float(-w / 2f, -h / 2f, w, h, r, r));

        if (zoom > 0.5) {
            g.setColor(new Color(255, 255, 255, 230));
            String t = o.kind.cn;
            g.setFont(Theme.F_SMALL);
            int tw = g.getFontMetrics().stringWidth(t);
            g.drawString(t, -tw / 2f, 4);
        }
        // 朝向小三角，便于判断旋转
        g.setColor(new Color(255, 255, 255, 200));
        Path2D tri = new Path2D.Float();
        tri.moveTo(0, -h / 2f - 6);
        tri.lineTo(-4, -h / 2f - 1);
        tri.lineTo(4, -h / 2f - 1);
        tri.closePath();
        g.fill(tri);
    }

    public static int sizeW(Project p, SceneObject o) {
        if (o.halfW > 0) {
            return Math.round(o.halfW * 2);
        }
        AssetEntry a = p.assets.get(o.assetId);
        int w = a != null && a.width > 0 ? a.width : (int) (p.tileSize * o.scaleX);
        return Math.max(6, Math.round(w * o.scaleX));
    }

    public static int sizeH(Project p, SceneObject o) {
        if (o.halfH > 0) {
            return Math.round(o.halfH * 2);
        }
        AssetEntry a = p.assets.get(o.assetId);
        int h = a != null && a.height > 0 ? a.height : (int) (p.tileSize * o.scaleY);
        return Math.max(6, Math.round(h * o.scaleY));
    }

    /** 命中测试用的轴对齐框（旋转对象用外接框，够用且不会误选）。 */
    public static java.awt.geom.Rectangle2D bounds(Project p, SceneObject o) {
        int w = sizeW(p, o);
        int h = sizeH(p, o);
        return new java.awt.geom.Rectangle2D.Float(o.x - w / 2f, o.y - h / 2f, w, h);
    }
}
