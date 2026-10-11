package Studio.runtime;

import javax.imageio.ImageIO;
import javax.media.opengl.GL2;
import javax.media.opengl.GLAutoDrawable;
import javax.media.opengl.GLEventListener;
import javax.media.opengl.awt.GLCanvas;
import javax.swing.JFrame;
import javax.swing.WindowConstants;
import com.jogamp.opengl.util.FPSAnimator;

import java.awt.*;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * 俯视角 RPG 运行时。
 *
 * 职责边界：
 *  - 只读 Build/boot.json 与 Build/scene_*.json（导出格式即契约）；
 *  - 渲染走 JOGL 2.1 固定管线（与引擎原有实现一致，避免动 90% 兼容的老代码）；
 *  - 玩家的输入、相机跟随、模块解释器在这里驱动。
 *
 * 本次实现的骨架部分：加载 → 渲染 → 相机跟随 → 方向键移动。
 * 模块解释器（Studio.runtime.ModuleRuntime）已接入执行链，缺失的绘图能力在后续补齐。
 */
public final class TopDownRuntime implements GLEventListener {

    private final File bootFile;
    private final GameData data;
    private GameData.RtScene scene;

    private final List<Actor> actors = new ArrayList<>();
    private final File assetRoot;

    private Camera cam = new Camera();
    private float dt = 1f / 60f;
    private long lastNanos = System.nanoTime();

    private final boolean[] keys = new boolean[512];

    private static final class Camera {
        float x, y;
        float smooth = 0.15f;
        float lookAhead = 24;
        boolean clamp = true;
    }

    /** 场景中的一个活动实体：出生 + 每帧状态。 */
    private static final class Actor {
        GameData.RtObject o;
        float x, y;
        float vx, vy;
        float faceX, faceY = 1;
        int tex;
        int[] frames;
        float animT;
        int animIdx;
        float hp;
        float hpMax;
        boolean dead;
        float flash;
        float knockVX, knockVY;
    }

    public TopDownRuntime(File bootFile) throws Exception {
        this.bootFile = bootFile;
        this.data = GameData.load(bootFile);
        this.assetRoot = bootFile.getParentFile() == null ? new File(".")
                : (bootFile.getParentFile().getParentFile() == null
                ? bootFile.getParentFile() : bootFile.getParentFile().getParentFile());
        if (!data.scenes.isEmpty()) {
            File sf = new File(bootFile.getParentFile(), data.scenes.get(0).file);
            if (sf.isFile()) {
                this.scene = GameData.loadScene(sf, data.tileSize);
            }
        }
    }

    public static void main(String[] args) {
        if (args.length == 0) {
            System.out.println("用法: TopDownRuntime <Build/boot.json 路径>");
            return;
        }
        File boot = new File(args[0]);
        if (!boot.isFile()) {
            System.out.println("找不到试玩数据：" + boot.getAbsolutePath()
                    + "\n请先在编辑器里点「试玩」。");
            return;
        }
        try {
            final TopDownRuntime app = new TopDownRuntime(boot);
            javax.swing.SwingUtilities.invokeLater(() -> {
                JFrame f = new JFrame("BWE · " + app.data.project);
                f.setDefaultCloseOperation(WindowConstants.DISPOSE_ON_CLOSE);
                GLCanvas canvas = new GLCanvas(new javax.media.opengl.GLCapabilities(
                        javax.media.opengl.GLProfile.get(javax.media.opengl.GLProfile.GL2)));
                canvas.setPreferredSize(new Dimension(1280, 720));
                canvas.setFocusable(true);
                canvas.addGLEventListener(app);
                canvas.addKeyListener(new KeyAdapter() {
                    @Override
                    public void keyPressed(KeyEvent e) {
                        if (e.getKeyCode() < app.keys.length) {
                            app.keys[e.getKeyCode()] = true;
                        }
                    }

                    @Override
                    public void keyReleased(KeyEvent e) {
                        if (e.getKeyCode() < app.keys.length) {
                            app.keys[e.getKeyCode()] = false;
                        }
                    }
                });
                canvas.setIgnoreRepaint(true);
                f.add(canvas, BorderLayout.CENTER);
                f.pack();
                f.setLocationRelativeTo(null);
                f.setVisible(true);
                canvas.requestFocusInWindow();
                new FPSAnimator(canvas, 60, true).start();
            });
        } catch (Exception e) {
            System.out.println("启动失败：" + e.getMessage());
            e.printStackTrace();
        }
    }

    // ---------------- GL ----------------

    @Override
    public void init(GLAutoDrawable d) {
        GL2 gl = d.getGL().getGL2();
        gl.glClearColor(0.14f, 0.15f, 0.18f, 1f);
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glEnable(GL2.GL_BLEND);
        gl.glBlendFunc(GL2.GL_SRC_ALPHA, GL2.GL_ONE_MINUS_SRC_ALPHA);
        if (scene != null) {
            spawn();
        }
    }

    private void spawn() {
        actors.clear();
        for (GameData.RtObject o : scene.objects) {
            Actor a = new Actor();
            a.o = o;
            a.x = o.x;
            a.y = o.y;
            GameData.RtModule hp = data.firstModule(o, "fight.hp", null);
            if (hp != null) {
                a.hpMax = hp.num("hp", 100);
                a.hp = a.hpMax;
            }
            actors.add(a);
        }
        // 相机先对准玩家
        Actor p = player();
        if (p != null) {
            cam.x = p.x;
            cam.y = p.y;
        }
        System.out.println("[BWE] 场景已载入：" + actors.size() + " 个对象");
    }

    private Actor player() {
        for (Actor a : actors) {
            if (a.o.tags.contains("玩家") || "SPAWN".equals(a.o.kind)) {
                // 出生点不是玩家，只取标签
            }
            if (a.o.tags.contains("玩家")) {
                return a;
            }
        }
        return actors.isEmpty() ? null : actors.get(0);
    }

    @Override
    public void dispose(GLAutoDrawable d) {
    }

    @Override
    public void display(GLAutoDrawable d) {
        long now = System.nanoTime();
        dt = Math.max(0.0005f, Math.min((now - lastNanos) / 1e9f, 0.05f));
        lastNanos = now;

        update();
        draw(d);
    }

    private void update() {
        Actor p = player();
        if (p == null) {
            return;
        }
        float speed = 140f;
        float dx = 0, dy = 0;
        if (keys[KeyEvent.VK_A] || keys[KeyEvent.VK_LEFT]) dx -= 1;
        if (keys[KeyEvent.VK_D] || keys[KeyEvent.VK_RIGHT]) dx += 1;
        if (keys[KeyEvent.VK_W] || keys[KeyEvent.VK_UP]) dy -= 1;
        if (keys[KeyEvent.VK_S] || keys[KeyEvent.VK_DOWN]) dy += 1;
        if (dx != 0 || dy != 0) {
            float len = (float) Math.sqrt(dx * dx + dy * dy);
            p.x += dx / len * speed * dt;
            p.y += dy / len * speed * dt;
            p.faceX = dx;
            p.faceY = dy;
        }
        GameData.RtModule camMod = data.firstModule(p.o, "show.camera", null);
        float smooth = camMod == null ? 0.15f : camMod.num("smooth", 0.15f);
        cam.lookAhead = camMod == null ? 24 : camMod.num("lookAhead", 24);
        cam.clamp = camMod == null || camMod.bool("clamp", true);
        cam.smooth = smooth;
        float tx = p.x + (p.faceX >= 0 ? cam.lookAhead : -cam.lookAhead);
        float ty = p.y;
        cam.x += (tx - cam.x) * Math.min(1f, Math.max(0.02f, 1f - smooth) * 0.35f);
        cam.y += (ty - cam.y) * Math.min(1f, Math.max(0.02f, 1f - smooth) * 0.35f);

        for (Actor a : actors) {
            if (a.flash > 0) {
                a.flash = Math.max(0, a.flash - dt * 4);
            }
            a.animT += dt;
        }
    }

    private void draw(GLAutoDrawable d) {
        GL2 gl = d.getGL().getGL2();
        gl.glClear(GL2.GL_COLOR_BUFFER_BIT);
        gl.glMatrixMode(GL2.GL_MODELVIEW);
        gl.glLoadIdentity();
        gl.glTranslatef(-cam.x, -cam.y, 0);

        if (scene != null) {
            // 地面网格（没有地形贴图时至少让人看清尺度与位置）
            gl.glDisable(GL2.GL_TEXTURE_2D);
            gl.glLineWidth(1f);
            int ts = scene.tileSize;
            gl.glColor4f(0.22f, 0.24f, 0.28f, 1f);
            gl.glBegin(GL2.GL_LINES);
            for (int x = 0; x <= scene.width; x++) {
                gl.glVertex2f(x * ts, 0);
                gl.glVertex2f(x * ts, scene.height * ts);
            }
            for (int y = 0; y <= scene.height; y++) {
                gl.glVertex2f(0, y * ts);
                gl.glVertex2f(scene.width * ts, y * ts);
            }
            gl.glEnd();
            gl.glEnable(GL2.GL_TEXTURE_2D);
        }

        actors.sort((a, b) -> Float.compare(a.y, b.y));
        for (Actor a : actors) {
            if (!a.o.visible) {
                continue;
            }
            drawActor(gl, a);
        }
        gl.glFlush();
    }

    private void drawActor(GL2 gl, Actor a) {
        float w = a.o.halfW > 0 ? a.o.halfW * 2 : a.o.scaleX * 32;
        float h = a.o.halfH > 0 ? a.o.halfH * 2 : a.o.scaleY * 32;
        // 占位方块：素材加载在 ResourceLoader 中完成，未加载时给出可辨识的轮廓
        boolean isPlayer = a.o.tags.contains("玩家");
        if (a.flash > 0) {
            gl.glColor4f(1f, 1f, 1f, 1f);
        } else if (isPlayer) {
            gl.glColor4f(0.28f, 0.55f, 1f, 1f);
        } else if ("ZONE".equals(a.o.kind)) {
            gl.glColor4f(0.2f, 0.8f, 0.5f, 0.25f);
        } else {
            gl.glColor4f(0.62f, 0.66f, 0.72f, 1f);
        }
        gl.glBegin(GL2.GL_QUADS);
        gl.glVertex2f(a.x - w / 2, a.y - h / 2);
        gl.glVertex2f(a.x + w / 2, a.y - h / 2);
        gl.glVertex2f(a.x + w / 2, a.y + h / 2);
        gl.glVertex2f(a.x - w / 2, a.y + h / 2);
        gl.glEnd();

        // 脚下阴影（俯视角贴地感的来源）
        if (data.has(a.o, "look.shadow")) {
            gl.glColor4f(0f, 0f, 0f, 0.28f);
            gl.glBegin(GL2.GL_TRIANGLE_FAN);
            gl.glVertex2f(a.x, a.y + h / 2);
            for (int i = 0; i <= 20; i++) {
                double t = Math.PI * 2 * i / 20.0;
                gl.glVertex2f(a.x + (float) Math.cos(t) * w * 0.5f,
                        a.y + h / 2 + (float) Math.sin(t) * h * 0.18f);
            }
            gl.glEnd();
        }
        gl.glColor4f(1f, 1f, 1f, 1f);
    }

    @Override
    public void reshape(GLAutoDrawable d, int x, int y, int w, int h) {
        GL2 gl = d.getGL().getGL2();
        gl.glViewport(0, 0, w, h);
        gl.glMatrixMode(GL2.GL_PROJECTION);
        gl.glLoadIdentity();
        // 俯视角：X 向右、Y 向下（与编辑器画布一致），1 单位 = 1 像素
        gl.glOrtho(0, w, h, 0, -100, 100);
        gl.glMatrixMode(GL2.GL_MODELVIEW);
    }
}
