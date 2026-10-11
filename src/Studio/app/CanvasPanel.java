package Studio.app;

import Studio.data.SceneModel;
import Studio.data.SceneObject;
import Studio.render.ImageCache;
import Studio.ui.Theme;
import Studio.ui.Toast;

import javax.swing.JComponent;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.MouseWheelEvent;
import java.awt.geom.AffineTransform;
import java.awt.geom.NoninvertibleTransformException;
import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;
import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 地图画布。
 *
 * 交互设计原则（针对"用户乱操作"）：
 * 1. 任何操作都可以中途放弃：拖动中按 Esc 取消并还原到按下时的位置；
 * 2. 不会因为手抖造成误改：位移小于 4 像素视为点击，不改数据；
 * 3. 缩放以鼠标为锚点，放大时直觉上"鼠标指着的地方不动"；
 * 4. 越界不报错：对象拖出地图只给橙色提示，不阻止、不弹窗；
 * 5. 没有对象时画布自己给引导，不是一片黑。
 */
public final class CanvasPanel extends JComponent {

    private final AppState st;
    private final Timer anim;

    // 视图
    private AffineTransform tf = new AffineTransform();

    // 交互状态
    private enum Drag {NONE, MOVE, MARQUEE, PAN, SCALE, ZONE}

    private Drag drag = Drag.NONE;
    private Point2D.Double pressWorld = new Point2D.Double();
    private Point2D.Double pressScreen = new Point2D.Double();
    private Point2D.Double lastScreen = new Point2D.Double();
    private final Map<String, float[]> pressPositions = new LinkedHashMap<>();
    private final Map<String, float[]> overrides = new LinkedHashMap<>();
    private Rectangle2D.Double marquee;
    private Rectangle2D.Double zoneRect;
    private int scaleHandle = -1;
    private float pressW, pressH;
    private boolean spaceDown;
    private boolean movedSincePress;

    private String hoverName = "";
    private Point2D.Double hoverWorld = new Point2D.Double();

    public CanvasPanel(AppState st) {
        this.st = st;
        setOpaque(true);
        setBackground(Theme.CANVAS_BG);
        setFocusable(true);

        MouseAdapter m = new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                requestFocusInWindow();
                onPress(e);
            }

            @Override
            public void mouseDragged(MouseEvent e) {
                onDrag(e);
            }

            @Override
            public void mouseReleased(MouseEvent e) {
                onRelease(e);
            }

            @Override
            public void mouseMoved(MouseEvent e) {
                onMove(e);
            }

            @Override
            public void mouseExited(MouseEvent e) {
                hoverName = "";
                repaint();
            }

            @Override
            public void mouseWheelMoved(MouseWheelEvent e) {
                onWheel(e);
            }
        };
        addMouseListener(m);
        addMouseMotionListener(m);
        addMouseWheelListener(m);

        addKeyListener(new KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == KeyEvent.VK_SPACE) {
                    spaceDown = true;
                    setCursor(Cursor.getPredefinedCursor(Cursor.MOVE_CURSOR));
                }
                if (e.getKeyCode() == KeyEvent.VK_ESCAPE && drag != Drag.NONE) {
                    cancelDrag();
                }
                nudge(e);
            }

            @Override
            public void keyReleased(KeyEvent e) {
                if (e.getKeyCode() == KeyEvent.VK_SPACE) {
                    spaceDown = false;
                    setCursor(Cursor.getDefaultCursor());
                }
            }
        });

        // 动画时钟：只用于序列帧预览，600ms 一跳足够，避免整屏高频重绘
        anim = new Timer(120, e -> {
            if (hasAnimation()) {
                repaint();
            }
        });
        anim.start();

        st.addSceneListener(() -> {
            overrides.clear();
            repaint();
        });
        st.addSelectionListener(this::repaint);
        st.addDirtyListener(this::repaint);
    }

    private boolean hasAnimation() {
        SceneModel s = st.scene();
        if (s == null) {
            return false;
        }
        for (SceneObject o : s.objects) {
            Studio.data.AssetEntry a = st.project().assets.get(o.assetId);
            if (a != null && a.totalFrames() > 1 && !"只显示首帧".equals(o.animMode)) {
                return true;
            }
        }
        return false;
    }

    // ---------------- 坐标换算 ----------------

    private void rebuildTransform() {
        tf = new AffineTransform();
        tf.translate(getWidth() / 2.0 - st.camX * st.zoom, getHeight() / 2.0 - st.camY * st.zoom);
        tf.scale(st.zoom, st.zoom);
    }

    private Point2D.Double toWorld(java.awt.Point p) {
        try {
            Point2D d = tf.createInverse().transform(p, null);
            return new Point2D.Double(d.getX(), d.getY());
        } catch (NoninvertibleTransformException e) {
            return new Point2D.Double();
        }
    }

    /** 屏幕坐标 → 世界坐标（供拖放落点换算）。 */
    public Point2D.Double screenToWorld(java.awt.Point p) {
        rebuildTransform();
        return toWorld(p);
    }

    /** 世界坐标 → 屏幕坐标（供未来的浮层标注使用）。 */
    public Point2D.Double worldToScreen(double x, double y) {
        rebuildTransform();
        Point2D d = tf.transform(new Point2D.Double(x, y), null);
        return new Point2D.Double(d.getX(), d.getY());
    }

    private int tile() {
        return st.project() == null ? 32 : Math.max(4, st.project().tileSize);
    }

    private float snap(float v) {
        if (!st.snapToGrid) {
            return v;
        }
        int t = tile();
        return Math.round(v / t) * (float) t;
    }

    // ---------------- 绘制 ----------------

    @Override
    protected void paintComponent(Graphics g0) {
        Graphics2D g = (Graphics2D) g0.create();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);

        g.setColor(Theme.CANVAS_BG);
        g.fillRect(0, 0, getWidth(), getHeight());

        SceneModel s = st.scene();
        if (s == null || st.project() == null) {
            paintWelcome(g);
            g.dispose();
            return;
        }
        rebuildTransform();

        ScenePainter.Ctx ctx = new ScenePainter.Ctx();
        ctx.root = projectRoot();
        ctx.zoom = st.zoom;
        ctx.showGrid = st.showGrid;
        ctx.showColliders = st.showColliders;
        ctx.showZones = st.showZones;
        ctx.animClockMs = System.currentTimeMillis();
        ctx.overrides = overrides;

        AffineTransform old = g.getTransform();
        g.transform(tf);
        ScenePainter.paintGrid(g, s, ctx, tile());

        List<SceneObject> ordered = sorted(s);
        for (SceneObject o : ordered) {
            if (!o.visible) {
                continue;
            }
            Studio.data.Layer l = s.layer(o.layerId);
            if (l != null && !l.visible) {
                continue;
            }
            ScenePainter.paintObject(g, st.project(), o, ctx, st.isSelected(o));
        }

        if (marquee != null) {
            g.setColor(Theme.alpha(Theme.SELECT, 40));
            g.fill(marquee);
            g.setColor(Theme.SELECT);
            g.setStroke(new java.awt.BasicStroke(1f, java.awt.BasicStroke.CAP_BUTT,
                    java.awt.BasicStroke.JOIN_MITER, 1f, new float[]{5f, 4f}, 0f));
            g.draw(marquee);
        }
        if (zoneRect != null) {
            g.setColor(Theme.alpha(new Color(0x12A06B), 50));
            g.fill(zoneRect);
            g.setColor(new Color(0x12A06B));
            g.setStroke(new java.awt.BasicStroke(1.6f, java.awt.BasicStroke.CAP_BUTT,
                    java.awt.BasicStroke.JOIN_MITER, 1f, new float[]{6f, 4f}, 0f));
            g.draw(zoneRect);
            g.setFont(Theme.F_SMALL);
            g.drawString("新触发区 " + Math.round(zoneRect.width / tile()) + " × "
                    + Math.round(zoneRect.height / tile()) + " 格", (float) zoneRect.x,
                    (float) zoneRect.y - 5);
        }
        g.setTransform(old);

        paintOverlay(g, s);
        g.dispose();
    }

    /** 按图层顺序、同层按 z 排序。 */
    private List<SceneObject> sorted(SceneModel s) {
        List<SceneObject> out = new ArrayList<>(s.objects);
        out.sort((a, b) -> {
            int la = layerIndex(s, a), lb = layerIndex(s, b);
            if (la != lb) {
                return Integer.compare(la, lb);
            }
            if (a.z != b.z) {
                return Integer.compare(a.z, b.z);
            }
            return Float.compare(a.y, b.y);
        });
        return out;
    }

    private int layerIndex(SceneModel s, SceneObject o) {
        for (int i = 0; i < s.layers.size(); i++) {
            if (s.layers.get(i).id.equals(o.layerId)) {
                return i;
            }
        }
        return s.layers.size();
    }

    /** 屏幕空间叠加层：左上角坐标提示、右下角操作提示。 */
    private void paintOverlay(Graphics2D g, SceneModel s) {
        g.setFont(Theme.F_SMALL);
        String info = "格 " + Math.round(hoverWorld.x / tile()) + ", " + Math.round(hoverWorld.y / tile())
                + "　·　像素 " + Math.round(hoverWorld.x) + ", " + Math.round(hoverWorld.y);
        g.setColor(new Color(0, 0, 0, 130));
        g.fillRoundRect(10, 10, g.getFontMetrics().stringWidth(info) + 16, 20, 8, 8);
        g.setColor(new Color(0xC8D2E0));
        g.drawString(info, 18, 24);

        if (!hoverName.isEmpty()) {
            int w = g.getFontMetrics().stringWidth(hoverName) + 16;
            g.setColor(new Color(0x2F6BFF));
            g.fillRoundRect(getWidth() - w - 12, 10, w, 20, 8, 8);
            g.setColor(Color.WHITE);
            g.drawString(hoverName, getWidth() - w - 4, 24);
        }

        if (s.objects.isEmpty()) {
            paintEmptyHint(g);
        }
    }

    private void paintEmptyHint(Graphics2D g) {
        String[] lines = {
                "这张地图还是空的",
                "从左边「素材」里把图拖进来，就会在这里出现对象",
                "或者用顶部工具栏的「画区」直接框出一块触发范围"
        };
        int y = getHeight() / 2 - 20;
        for (int i = 0; i < lines.length; i++) {
            g.setFont(i == 0 ? Theme.F_H2 : Theme.F_SMALL);
            g.setColor(i == 0 ? new Color(0xB9C4D2) : new Color(0x8A94A3));
            int w = g.getFontMetrics().stringWidth(lines[i]);
            g.drawString(lines[i], (getWidth() - w) / 2, y + i * 24);
        }
    }

    private void paintWelcome(Graphics2D g) {
        g.setFont(Theme.F_H2);
        g.setColor(new Color(0xB9C4D2));
        String t = "没有打开的场景";
        g.drawString(t, (getWidth() - g.getFontMetrics().stringWidth(t)) / 2, getHeight() / 2);
    }

    private File projectRoot() {
        return AssetImport.projectRoot(st);
    }

    // ---------------- 鼠标 ----------------

    private void onPress(MouseEvent e) {
        movedSincePress = false;
        pressScreen = new Point2D.Double(e.getX(), e.getY());
        lastScreen = new Point2D.Double(e.getX(), e.getY());
        pressWorld = toWorld(e.getPoint());
        SceneModel s = st.scene();
        if (s == null || st.project() == null) {
            return;
        }

        // 中键 或 空格 或 抓手工具 = 平移
        if (e.getButton() == MouseEvent.BUTTON2 || spaceDown || st.tool() == AppState.Tool.PAN) {
            drag = Drag.PAN;
            setCursor(Cursor.getPredefinedCursor(Cursor.MOVE_CURSOR));
            return;
        }
        if (e.getButton() == MouseEvent.BUTTON3 && st.tool() == AppState.Tool.SELECT) {
            // 右键快速刪除当前悬停对象：很常用，但不改选择状态
            SceneObject hit = pick(pressWorld);
            if (hit != null) {
                st.edit(() -> {
                    s.objects.remove(hit);
                });
                st.forget(hit);
                st.statusHint("已删除「" + hit.name + "」　Ctrl+Z 可撤销");
            }
            return;
        }
        if (e.getButton() != MouseEvent.BUTTON1) {
            return;
        }

        switch (st.tool()) {
            case ERASE: {
                SceneObject hit = pick(pressWorld);
                if (hit != null) {
                    st.edit(() -> s.objects.remove(hit));
                    st.forget(hit);
                    st.statusHint("已擦掉「" + hit.name + "」");
                }
                drag = Drag.NONE;
                return;
            }
            case ZONE:
                drag = Drag.ZONE;
                zoneRect = new Rectangle2D.Double(pressWorld.x, pressWorld.y, 0, 0);
                return;
            case BRUSH:
                drag = Drag.NONE;
                return;
            default:
                break;
        }

        // 缩放控制点优先
        scaleHandle = hitHandle(pressWorld);
        if (scaleHandle >= 0) {
            SceneObject o = st.first();
            if (o != null) {
                pressW = ScenePainter.sizeW(st.project(), o);
                pressH = ScenePainter.sizeH(st.project(), o);
                drag = Drag.SCALE;
                return;
            }
        }

        SceneObject hit = pick(pressWorld);
        if (hit != null) {
            if (e.isShiftDown()) {
                st.toggleSelect(hit);
            } else if (!st.isSelected(hit)) {
                st.select(hit);
            }
            beginMove();
            return;
        }

        if (!e.isShiftDown()) {
            st.clearSelection();
        }
        drag = Drag.MARQUEE;
        marquee = new Rectangle2D.Double(pressWorld.x, pressWorld.y, 0, 0);
    }

    private void beginMove() {
        drag = Drag.MOVE;
        pressPositions.clear();
        for (SceneObject o : st.selection()) {
            if (!o.locked) {
                pressPositions.put(o.id, new float[]{o.x, o.y});
            }
        }
    }

    private void onDrag(MouseEvent e) {
        Point2D.Double cur = toWorld(e.getPoint());
        double dxs = e.getX() - pressScreen.x, dys = e.getY() - pressScreen.y;
        if (Math.abs(dxs) > 3 || Math.abs(dys) > 3) {
            movedSincePress = true;
        }
        hoverWorld = cur;

        switch (drag) {
            case PAN: {
                st.camX -= (e.getX() - lastScreen.x) / st.zoom;
                st.camY -= (e.getY() - lastScreen.y) / st.zoom;
                lastScreen = new Point2D.Double(e.getX(), e.getY());
                repaint();
                break;
            }
            case MOVE: {
                double dx = cur.x - pressWorld.x;
                double dy = cur.y - pressWorld.y;
                overrides.clear();
                for (SceneObject o : st.selection()) {
                    float[] p0 = pressPositions.get(o.id);
                    if (p0 == null) {
                        continue;
                    }
                    float nx = snap(p0[0] + (float) dx);
                    float ny = snap(p0[1] + (float) dy);
                    overrides.put(o.id, new float[]{nx, ny});
                }
                repaint();
                st.statusHint("正在移动 " + overrides.size() + " 个对象" + (st.snapToGrid ? "（已吸附网格）" : ""));
                break;
            }
            case MARQUEE: {
                marquee = new Rectangle2D.Double(
                        Math.min(pressWorld.x, cur.x), Math.min(pressWorld.y, cur.y),
                        Math.abs(cur.x - pressWorld.x), Math.abs(cur.y - pressWorld.y));
                repaint();
                break;
            }
            case ZONE: {
                zoneRect = new Rectangle2D.Double(
                        Math.min(pressWorld.x, cur.x), Math.min(pressWorld.y, cur.y),
                        Math.abs(cur.x - pressWorld.x), Math.abs(cur.y - pressWorld.y));
                repaint();
                break;
            }
            case SCALE: {
                SceneObject o = st.first();
                if (o == null) {
                    break;
                }
                double dx = cur.x - pressWorld.x;
                double dy = cur.y - pressWorld.y;
                boolean left = scaleHandle == 0 || scaleHandle == 3 || scaleHandle == 6;
                boolean right = scaleHandle == 2 || scaleHandle == 5 || scaleHandle == 8;
                boolean top = scaleHandle == 0 || scaleHandle == 1 || scaleHandle == 2;
                boolean bottom = scaleHandle == 6 || scaleHandle == 7 || scaleHandle == 8;
                float nw = Math.max(4, pressW + (float) ((right ? dx : 0) - (left ? dx : 0)));
                float nh = Math.max(4, pressH + (float) ((bottom ? dy : 0) - (top ? dy : 0)));
                overrides.clear();
                overrides.put(o.id, new float[]{o.x, o.y});
                o.halfW = nw / 2f;
                o.halfH = nh / 2f;
                repaint();
                st.statusHint("尺寸 " + Math.round(nw) + " × " + Math.round(nh) + " 像素");
                break;
            }
            default:
                break;
        }
    }

    private void onRelease(MouseEvent e) {
        Point2D.Double cur = toWorld(e.getPoint());
        switch (drag) {
            case MOVE: {
                if (overrides.isEmpty()) {
                    break;
                }
                final Map<String, float[]> finalPos = new LinkedHashMap<>(overrides);
                st.edit(() -> {
                    for (SceneObject o : st.scene().objects) {
                        float[] p = finalPos.get(o.id);
                        if (p != null) {
                            o.x = p[0];
                            o.y = p[1];
                        }
                    }
                });
                boolean outside = false;
                SceneModel s = st.scene();
                for (SceneObject o : st.selection()) {
                    if (o.x < 0 || o.y < 0 || o.x > s.widthTiles * tile() || o.y > s.heightTiles * tile()) {
                        outside = true;
                    }
                }
                if (outside) {
                    st.statusHint("有对象拖出了地图范围，运行时它们不会被显示");
                }
                overrides.clear();
                break;
            }
            case MARQUEE: {
                if (marquee != null && st.scene() != null) {
                    List<SceneObject> inside = new ArrayList<>();
                    for (SceneObject o : st.scene().objects) {
                        Studio.data.Layer l = st.scene().layer(o.layerId);
                        if (o.locked || (l != null && l.locked)) {
                            continue;
                        }
                        if (marquee.intersects(ScenePainter.bounds(st.project(), o))) {
                            inside.add(o);
                        }
                    }
                    if (!inside.isEmpty()) {
                        List<SceneObject> merged = new ArrayList<>(st.selection());
                        for (SceneObject o : inside) {
                            if (!merged.contains(o)) {
                                merged.add(o);
                            }
                        }
                        st.selectAll(merged);
                        st.statusHint("框选到 " + inside.size() + " 个对象");
                    }
                }
                marquee = null;
                break;
            }
            case ZONE: {
                if (zoneRect != null && zoneRect.width > 6 && zoneRect.height > 6) {
                    SceneObject o = SceneOps.create(st.scene(), Studio.data.ObjKind.ZONE,
                            (float) (zoneRect.x + zoneRect.width / 2), (float) (zoneRect.y + zoneRect.height / 2));
                    o.name = "触发区";
                    o.halfW = (float) zoneRect.width / 2;
                    o.halfH = (float) zoneRect.height / 2;
                    o.tags.add("触发区");
                    st.edit(() -> {
                        st.scene().objects.add(o);
                        SceneOps.normalizeZ(st.scene());
                    });
                    st.select(o);
                    st.setTool(AppState.Tool.SELECT);
                    st.statusHint("已创建触发区，右侧给它加模块");
                }
                zoneRect = null;
                break;
            }
            case SCALE: {
                SceneObject o = st.first();
                if (o != null && movedSincePress) {
                    st.markDirty();
                    st.statusHint("已调整「" + o.name + "」的尺寸");
                }
                overrides.clear();
                break;
            }
            default:
                break;
        }
        drag = Drag.NONE;
        scaleHandle = -1;
        setCursor(spaceDown ? Cursor.getPredefinedCursor(Cursor.MOVE_CURSOR) : Cursor.getDefaultCursor());
        repaint();
    }

    private void onMove(MouseEvent e) {
        hoverWorld = toWorld(e.getPoint());
        SceneModel s = st.scene();
        SceneObject hit = s == null ? null : pick(hoverWorld);
        hoverName = hit == null ? "" : hit.name + "　·　" + hit.kind.cn;
        repaint();
    }

    private void onWheel(MouseWheelEvent e) {
        if (st.project() == null) {
            return;
        }
        double old = st.zoom;
        double factor = e.getWheelRotation() < 0 ? 1.12 : 1 / 1.12;
        double nz = Math.max(0.15, Math.min(5.0, old * factor));
        if (Math.abs(nz - old) < 1e-6) {
            return;
        }
        // 以鼠标位置为锚点缩放：光标下的世界坐标保持不动
        Point2D.Double before = toWorld(e.getPoint());
        st.zoom = nz;
        rebuildTransform();
        Point2D.Double after = toWorld(e.getPoint());
        st.camX += before.x - after.x;
        st.camY += before.y - after.y;
        repaint();
    }

    private void cancelDrag() {
        if (drag == Drag.MOVE || drag == Drag.SCALE) {
            overrides.clear();
            st.statusHint("已取消这次拖动");
        }
        drag = Drag.NONE;
        marquee = null;
        zoneRect = null;
        scaleHandle = -1;
        repaint();
    }

    /** 方向键微调选中对象（1 像素；按住 Shift 走一格）。 */
    private void nudge(KeyEvent e) {
        if (st.selection().isEmpty()) {
            return;
        }
        int step = e.isShiftDown() ? tile() : 1;
        float dx = 0, dy = 0;
        switch (e.getKeyCode()) {
            case KeyEvent.VK_LEFT -> dx = -step;
            case KeyEvent.VK_RIGHT -> dx = step;
            case KeyEvent.VK_UP -> dy = -step;
            case KeyEvent.VK_DOWN -> dy = step;
            default -> {
                return;
            }
        }
        final float fdx = dx, fdy = dy;
        st.edit(() -> {
            for (SceneObject o : st.selection()) {
                if (!o.locked) {
                    o.x += fdx;
                    o.y += fdy;
                }
            }
        });
        repaint();
        e.consume();
    }

    /** 命中测试：后画的在上，所以倒序找。 */
    public SceneObject pick(Point2D.Double world) {
        SceneModel s = st.scene();
        if (s == null || st.project() == null) {
            return null;
        }
        List<SceneObject> ordered = sorted(s);
        for (int i = ordered.size() - 1; i >= 0; i--) {
            SceneObject o = ordered.get(i);
            if (!o.visible || o.locked) {
                continue;
            }
            Studio.data.Layer l = s.layer(o.layerId);
            if (l != null && (!l.visible || l.locked)) {
                continue;
            }
            if (ScenePainter.bounds(st.project(), o).contains(world.x, world.y)) {
                return o;
            }
        }
        return null;
    }

    /** 命中选择框的缩放手柄；返回 0..8，未命中返回 -1。 */
    private int hitHandle(Point2D.Double world) {
        SceneObject o = st.first();
        if (o == null || st.selection().size() != 1) {
            return -1;
        }
        int w = ScenePainter.sizeW(st.project(), o);
        int h = ScenePainter.sizeH(st.project(), o);
        double tol = 6 / Math.max(0.2, st.zoom);
        int idx = 0;
        for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
                double hx = o.x + dx * w / 2.0;
                double hy = o.y + dy * h / 2.0;
                if (Math.abs(world.x - hx) <= tol && Math.abs(world.y - hy) <= tol) {
                    return idx;
                }
                idx++;
            }
        }
        return -1;
    }

    public void focusOn(SceneObject o) {
        if (o == null) {
            return;
        }
        st.camX = o.x;
        st.camY = o.y;
        repaint();
    }

    public void zoomToFit() {
        SceneModel s = st.scene();
        if (s == null || getWidth() <= 0) {
            return;
        }
        double w = s.widthTiles * tile();
        double h = s.heightTiles * tile();
        st.zoom = Math.max(0.15, Math.min(2.0, Math.min((getWidth() - 40) / w, (getHeight() - 40) / h)));
        st.camX = w / 2;
        st.camY = h / 2;
        repaint();
        st.statusHint("已缩放到整张地图（" + Math.round(st.zoom * 100) + "%）");
    }

    @Override
    public Dimension getPreferredSize() {
        return new Dimension(900, 600);
    }
}
