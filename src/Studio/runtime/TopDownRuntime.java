package Studio.runtime;

import javax.imageio.ImageIO;
import javax.media.opengl.GL2;
import javax.media.opengl.GLAutoDrawable;
import javax.media.opengl.GLCapabilities;
import javax.media.opengl.GLEventListener;
import javax.media.opengl.GLProfile;
import javax.media.opengl.awt.GLCanvas;
import javax.swing.JFrame;
import javax.swing.SwingUtilities;
import javax.swing.WindowConstants;
import com.jogamp.opengl.util.FPSAnimator;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.MouseMotionAdapter;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * 俯视角 RPG / 小游戏运行时。
 *
 * 职责边界：
 *  - 只读 Build/boot.json 与 Build/scene_*.json（导出格式即契约）；
 *  - 渲染走 JOGL 2.1 固定管线（与引擎原有实现一致，避免动 90% 兼容的老代码）；
 *  - 玩家的输入、相机跟随、模块解释器在这里驱动。
 *
 * 这里同时负责打包后的「可玩」部分：
 *  - 解析素材并绘制贴图 / 序列帧 / 图集；
 *  - 支持扫雷（点击翻开、右键插旗、计时、胜负）；
 *  - 支持换装部件点击切换造型。
 * 没有实现的模块不会让游戏崩溃，只是被忽略。
 */
public final class TopDownRuntime implements GLEventListener {

    private final File bootFile;
    // 以下字段/方法对 Studio.runtime 包内可见：脚本引擎（ScriptEngine）要读写世界、相机、实体。
    final GameData data;
    GameData.RtScene scene;
    private String sceneName = "";

    final List<Actor> actors = new ArrayList<>();
    final File assetRoot;
    private final Map<String, Texture> textureCache = new HashMap<>();
    private final Map<String, BufferedImage> imageCache = new HashMap<>();

    /** 世界 → 屏幕的唯一换算入口（契约见 Viewport 的注释）。 */
    final Viewport view = new Viewport();
    final boolean[] keys = new boolean[512];
    /** true = 相机交给脚本（bwe.camera.follow/setPos）控制，运行时不再每帧重置。 */
    boolean scriptCameraControl = false;
    /** JS 脚本引擎（null = 本工程没有脚本 / 初始化失败）。 */
    ScriptEngine scripts;
    /** 鼠标当前位置（逻辑屏幕坐标，供 bwe.input.mouse 读取）。 */
    int mouseX = 0;
    int mouseY = 0;
    private float time = 0f;
    private long lastNanos = 0L;
    int viewW = 1280;
    int viewH = 720;
    /** 相机跟随模式：玩家挂了 fx.cameraFollow / show.camera 时为 true。 */
    private boolean cameraFollow = false;
    private boolean cameraClampToMap = true;
    private float cameraSmooth = 0f;
    private float cameraLookAhead = 0f;

    private Actor player;
    private Minesweeper minesweeper;
    private final List<DressPart> dressParts = new ArrayList<>();
    private GameData.RtObject dressController;
    private String dressTag = "";
    private boolean dressAllowReset = true;

    private JFrame frame;
    private GLCanvas canvas;
    private boolean fullscreen = false;
    private int drawableW = 1280;
    private int drawableH = 720;
    private int surfaceW = 1280;
    private int surfaceH = 720;
    private boolean dumpedFrame = false;
    private boolean loggedScaleInfo = false;
    private int clickLogCount = 0;
    private FPSAnimator animator;
    private String lastTitle = "";
    private boolean loggedDisplayError = false;
    private boolean loggedViewport = false;

    static final class Texture {
        int id;
        int w;
        int h;
    }

    static final class Actor {
        GameData.RtObject o;
        float x;
        float y;
        float faceX = 0f;
        float faceY = 1f;
        float hp = 10f;
        float hpMax = 10f;
        boolean dead;
        float animT;
        int animIdx;

        GameData.RtAsset asset;
        final List<Texture> textures = new ArrayList<>();
        final List<Frame> frames = new ArrayList<>();
        int texW;
        int texH;

        DressPart dress;
        Minesweeper mine;

        float baseX;
        float baseY;
        float wanderT;
        float wanderDirX;
        float wanderDirY;
    }

    private static final class Frame {
        Texture texture;
        float u0, v0, u1, v1;

        Frame(Texture texture, float u0, float v0, float u1, float v1) {
            this.texture = texture;
            this.u0 = u0;
            this.v0 = v0;
            this.u1 = u1;
            this.v1 = v1;
        }
    }

    /**
     * 只读数据 + 建 Actor，不碰 OpenGL：LayoutDump 也走这个入口，
     * 保证「自检看到的布局」和「真正画出来的布局」是同一份代码算的。
     */
    TopDownRuntime(File bootFile) throws IOException {
        this.bootFile = bootFile;
        this.data = GameData.load(bootFile);
        this.assetRoot = GameData.resolveRoot(bootFile);
        if (data.scenes.isEmpty()) {
            throw new IOException("boot.json 里没有场景");
        }
        GameData.SceneRef ref = data.scenes.get(0);
        this.sceneName = ref.name;
        File sceneFile = new File(bootFile.getParentFile(), ref.file);
        this.scene = GameData.loadScene(sceneFile, data.tileSize);
        spawn();
        // 脚本要在场景对象就绪后启动（onStart 里可能马上要 find/spawn）。
        try {
            this.scripts = new ScriptEngine(this);
            this.scripts.sceneStart();
        } catch (Throwable t) {
            this.scripts = null;
            BweLauncher.log(bootFile, "[脚本] 引擎初始化失败: " + t);
        }
    }

    // ---------------- 启动 ----------------

    public static void main(String[] args) {
        File boot = resolveBoot(args);
        if (boot == null || !boot.isFile()) {
            BweLauncher.fail(boot, "找不到游戏数据 Build/boot.json",
                    new IOException("请确认 Build 目录与 exe 放在一起。"));
            return;
        }
        try {
            final TopDownRuntime runtime = new TopDownRuntime(boot);
            SwingUtilities.invokeLater(new Runnable() {
                @Override
                public void run() {
                    try {
                        runtime.openWindow();
                    } catch (Throwable t) {
                        BweLauncher.fail(boot, "游戏窗口启动失败", t);
                    }
                }
            });
        } catch (Throwable t) {
            BweLauncher.fail(boot, "读取游戏数据失败", t);
        }
    }

    private static File resolveBoot(String[] args) {
        if (args != null && args.length > 0 && args[0] != null && !args[0].isEmpty()) {
            return new File(args[0]).getAbsoluteFile();
        }
        String prop = System.getProperty("bwe.boot", "");
        if (!prop.isEmpty()) {
            File f = new File(prop);
            if (f.isFile()) {
                return f.getAbsoluteFile();
            }
        }
        File beside = new File(BweLauncher.appDir(), "Build" + File.separator + "boot.json");
        if (beside.isFile()) {
            return beside.getAbsoluteFile();
        }
        File cwd = new File("Build" + File.separator + "boot.json").getAbsoluteFile();
        return cwd;
    }

    private void openWindow() {
        GLProfile profile = GLProfile.getDefault();
        GLCapabilities caps = new GLCapabilities(profile);
        caps.setAlphaBits(8);
        caps.setDoubleBuffered(true);
        GLCanvas canvas = new GLCanvas(caps);
        canvas.setPreferredSize(new Dimension(1280, 720));
        canvas.setMinimumSize(new Dimension(640, 360));
        canvas.setFocusable(true);
        canvas.addGLEventListener(this);
        canvas.addKeyListener(new KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                int code = e.getKeyCode();
                if (code >= 0 && code < keys.length) {
                    keys[code] = true;
                }
                if (code == KeyEvent.VK_R) {
                    resetGames();
                }
                if (code == KeyEvent.VK_F11) {
                    toggleFullscreen();
                }
                if (code == KeyEvent.VK_F) {
                    // F：在「整图留边（contain）」和「铺满裁边（cover）」之间切换，
                    // 解决「4:3 的地图放进 16:9 屏幕左右留黑边」的观感问题。
                    view.fitMode = view.fitMode == Viewport.FIT_COVER
                            ? Viewport.FIT_CONTAIN : Viewport.FIT_COVER;
                    applyCameraPolicy(true);
                    BweLauncher.log(bootFile, "视图模式切换为 " + view.fitModeName()
                            + "（F 键切换）：" + view.describe());
                }
                if (code == KeyEvent.VK_ESCAPE) {
                    if (fullscreen) {
                        toggleFullscreen();
                    } else if (frame != null) {
                        frame.dispose();
                    }
                }
                if (scripts != null) {
                    scripts.keyDown(code);
                }
            }

            @Override
            public void keyReleased(KeyEvent e) {
                int code = e.getKeyCode();
                if (code >= 0 && code < keys.length) {
                    keys[code] = false;
                }
                if (scripts != null) {
                    scripts.keyUp(code);
                }
            }
        });
        canvas.addMouseListener(new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                handleClick(e);
            }
        });
        canvas.addMouseMotionListener(new MouseMotionAdapter() {
            @Override
            public void mouseMoved(MouseEvent e) {
                mouseX = e.getX();
                mouseY = e.getY();
            }

            @Override
            public void mouseDragged(MouseEvent e) {
                mouseX = e.getX();
                mouseY = e.getY();
            }
        });
        this.canvas = canvas;

        frame = new JFrame("BWE");
        frame.setDefaultCloseOperation(WindowConstants.EXIT_ON_CLOSE);
        frame.setLayout(new java.awt.BorderLayout());
        frame.setBackground(java.awt.Color.BLACK);
        frame.add(canvas, java.awt.BorderLayout.CENTER);
        // 打包出来的游戏默认全屏（用户反馈「画面没有占全屏」）；F11 切回无边框窗口，ESC 退出。
        // 注意：全程保持 undecorated，切换只做 setFullScreenWindow/setBounds，绝不 dispose 重建，
        // 否则 GLCanvas 的原生 peer 会被销毁、GL 上下文与纹理全部丢失。
        frame.setUndecorated(true);
        frame.setResizable(false);
        enterFullscreen();
        if (!fullscreen) {
            // 全屏失败时退回无边框 1280x720 窗口，保证一定能玩。
            frame.setBounds(centeredBounds(1280, 720));
        }
        frame.setVisible(true);
        canvas.requestFocusInWindow();
        updateTitle();

        animator = new FPSAnimator(canvas, 60, true);
        animator.start();
        BweLauncher.log(bootFile, "窗口已打开: " + sceneName + "（" + (fullscreen ? "全屏" : "窗口") + "）");
        BweLauncher.log(bootFile, "对象: " + actors.size() + " / 玩法: "
                + (minesweeper != null ? "扫雷 " : "") + (!dressParts.isEmpty() ? "换装 " : "")
                + (player != null ? "可移动角色" : "无玩家"));
    }

    private static java.awt.Rectangle centeredBounds(int w, int h) {
        java.awt.Dimension screen = java.awt.Toolkit.getDefaultToolkit().getScreenSize();
        int x = Math.max(0, (screen.width - w) / 2);
        int y = Math.max(0, (screen.height - h) / 2);
        return new java.awt.Rectangle(x, y, w, h);
    }

    /** 全屏：正片全屏（独占），不支持时退回铺满屏幕的无边框窗口。 */
    private void enterFullscreen() {
        try {
            java.awt.GraphicsDevice gd = java.awt.GraphicsEnvironment
                    .getLocalGraphicsEnvironment().getDefaultScreenDevice();
            if (gd.isFullScreenSupported()) {
                gd.setFullScreenWindow(frame);
                fullscreen = gd.getFullScreenWindow() == frame;
            }
            if (!fullscreen) {
                frame.setBounds(gd.getDefaultConfiguration().getBounds());
                fullscreen = true;
            }
        } catch (Throwable t) {
            BweLauncher.log(bootFile, "全屏失败，退回窗口模式: " + t);
            fullscreen = false;
        }
    }

    private void exitFullscreen() {
        try {
            java.awt.GraphicsDevice gd = java.awt.GraphicsEnvironment
                    .getLocalGraphicsEnvironment().getDefaultScreenDevice();
            if (gd.getFullScreenWindow() == frame) {
                gd.setFullScreenWindow(null);
            }
        } catch (Throwable ignored) {
        }
        fullscreen = false;
        frame.setBounds(centeredBounds(1280, 720));
    }

    /**
     * F11：全屏 ↔ 无边框窗口。不 dispose 重建，所以 GL 上下文和已上传纹理都不会丢。
     */
    private void toggleFullscreen() {
        if (fullscreen) {
            exitFullscreen();
            BweLauncher.log(bootFile, "切换为窗口模式");
        } else {
            enterFullscreen();
            BweLauncher.log(bootFile, "切换为全屏" + (fullscreen ? "" : "（不支持，保持窗口）"));
        }
        if (canvas != null) {
            canvas.requestFocusInWindow();
        }
    }

    /** 首帧把视口参数写进 bwe.log，出问题时用户直接把日志发回来就能定位偏移。 */
    private void logViewportOnce() {
        if (loggedViewport) {
            return;
        }
        loggedViewport = true;
        BweLauncher.log(bootFile, "视口映射: " + view.describe()
                + " 每单位像素=" + Math.round(view.zoom * 100f) / 100f);
    }

    /**
     * 记录「AWT 组件逻辑尺寸」与「GL 绘制表面像素尺寸」的比例。
     * Windows 显示缩放 125%/150% 时两者不相等，若拿错一个就会「画面不满屏 + 点击偏移」。
     */
    private void logScaleInfoOnce(int drawableWidth, int drawableHeight) {
        if (loggedScaleInfo) {
            return;
        }
        loggedScaleInfo = true;
        int compW = canvas == null ? -1 : canvas.getWidth();
        int compH = canvas == null ? -1 : canvas.getHeight();
        String dpi = "?";
        try {
            java.awt.GraphicsConfiguration gc = canvas == null ? null : canvas.getGraphicsConfiguration();
            if (gc != null) {
                java.awt.geom.AffineTransform t = gc.getDefaultTransform();
                dpi = "scaleX=" + round3((float) t.getScaleX()) + " scaleY=" + round3((float) t.getScaleY());
            }
        } catch (Throwable ignored) {
        }
        java.awt.Dimension screen = java.awt.Toolkit.getDefaultToolkit().getScreenSize();
        BweLauncher.log(bootFile, "尺寸自检: drawable=" + drawableWidth + "x" + drawableHeight
                + " 组件=" + compW + "x" + compH
                + " 用于投影的逻辑尺寸=" + viewW + "x" + viewH
                + " 用于 glViewport 的物理尺寸=" + surfaceW + "x" + surfaceH
                + " 屏幕=" + screen.width + "x" + screen.height
                + " " + dpi + " 全屏=" + fullscreen);
    }

    private static String round3(float v) {
        return String.valueOf(Math.round(v * 1000f) / 1000f);
    }

    private void resetGames() {
        if (minesweeper != null) {
            minesweeper.reset();
        }
        for (DressPart p : dressParts) {
            p.selected = p.defaultIndex;
        }
        updateTitle();
    }

    private void handleClick(MouseEvent e) {
        // 鼠标是屏幕坐标，玩法判定是世界坐标：必须走视口逆变换（含 zoom / 居中偏移）。
        int wx = Math.round(view.toWorldX(e.getX()));
        int wy = Math.round(view.toWorldY(e.getY()));
        if (clickLogCount < 3) {
            clickLogCount++;
            BweLauncher.log(bootFile, "点击诊断: 组件坐标=(" + e.getX() + "," + e.getY() + ")"
                    + " 组件尺寸=" + (canvas == null ? "?" : canvas.getWidth() + "x" + canvas.getHeight())
                    + " 视口=" + viewW + "x" + viewH
                    + " drawable=" + drawableW + "x" + drawableH
                    + " → 世界=(" + wx + "," + wy + ") " + view.describe());
        }
        boolean right = e.getButton() == MouseEvent.BUTTON3;
        mouseX = e.getX();
        mouseY = e.getY();
        // 脚本先拿点击（目前统一派发，不阻断可视化模块的行为）。
        if (scripts != null) {
            scripts.pointerDown(wx, wy, right, e.getX(), e.getY());
        }
        if (minesweeper != null && minesweeper.click(wx, wy, right)) {
            updateTitle();
            return;
        }
        // 从最上层往下找，避免身体挡住头发时点不到头发（顺序与绘制顺序相反）。
        List<DressPart> sorted = new ArrayList<>(dressParts);
        Collections.sort(sorted, new Comparator<DressPart>() {
            @Override
            public int compare(DressPart a, DressPart b) {
                return actorOrder().compare(b.actor, a.actor);
            }
        });
        for (DressPart p : sorted) {
            if (p.click(wx, wy)) {
                updateTitle();
                return;
            }
        }
        if (dressController != null && dressAllowReset) {
            float hw = 48;
            float hh = 48;
            if (dressController.halfW > 0) {
                hw = dressController.halfW;
            }
            if (dressController.halfH > 0) {
                hh = dressController.halfH;
            }
            if (Math.abs(wx - dressController.x) <= hw && Math.abs(wy - dressController.y) <= hh) {
                resetGames();
            }
        }
    }

    // ---------------- 场景装载 ----------------

    private void spawn() {
        actors.clear();
        dressParts.clear();
        minesweeper = null;
        player = null;

        // 先建对象，再识别玩法模块，保证换装部件能引用到同一批 Actor。
        for (GameData.RtObject o : scene.objects) {
            Actor a = new Actor();
            a.o = o;
            a.x = o.x;
            a.y = o.y;
            a.baseX = o.x;
            a.baseY = o.y;
            a.asset = o.asset != null ? o.asset : data.assetById(o.assetId);
            if (a.asset == null) {
                a.asset = data.assetByName(o.assetName);
            }
            loadActorFrames(a);
            actors.add(a);

            GameData.RtModule hp = data.module(o, "combat.health", "fight.hp");
            if (hp != null) {
                a.hpMax = Math.max(1, hp.num("maxHealth", hp.num("hp", 10)));
                a.hp = a.hpMax;
            }
        }

        for (Actor a : actors) {
            GameData.RtModule mineMod = data.module(a.o, "game.minesweeper", "game.minesweeper");
            if (mineMod != null && minesweeper == null) {
                minesweeper = new Minesweeper(this, a, mineMod);
                a.mine = minesweeper;
            }
            if (dressController == null) {
                GameData.RtModule dressMod = data.module(a.o, "game.dressup", "game.dressup");
                if (dressMod != null) {
                    dressController = a.o;
                    dressTag = dressMod.str("partTag", "");
                    dressAllowReset = dressMod.bool("allowReset", true);
                }
            }
        }

        for (Actor a : actors) {
            GameData.RtModule part = data.module(a.o, "game.dressPart", "game.dressPart");
            if (part == null) {
                continue;
            }
            if (!dressTag.isEmpty() && !a.o.tags.contains(dressTag)) {
                continue;
            }
            DressPart p = new DressPart(this, a, part);
            a.dress = p;
            dressParts.add(p);
        }

        findPlayer();
        resetCamera();
    }

    private void findPlayer() {
        for (Actor a : actors) {
            if (a.o.tags.contains("玩家") || a.o.tags.contains("Player") || a.o.tags.contains("player")) {
                player = a;
                return;
            }
        }
        // 没有显式标记时，取第一个普通 ACTOR；换装部件不算玩家。
        for (Actor a : actors) {
            if (a.dress != null || a.mine != null) {
                continue;
            }
            if ("ACTOR".equalsIgnoreCase(a.o.kind)) {
                player = a;
                return;
            }
        }
    }

    // ---------------- 相机 / 视口 ----------------

    /** 读玩家身上的相机模块，决定是「整图 fit」还是「1:1 跟随」。 */
    private void readCameraModule() {
        cameraFollow = false;
        cameraClampToMap = true;
        cameraSmooth = 0f;
        cameraLookAhead = 0f;
        if (player == null) {
            return;
        }
        GameData.RtModule m = data.module(player.o, "fx.cameraFollow", "show.camera");
        if (m == null) {
            return;
        }
        cameraFollow = true;
        cameraSmooth = Math.max(0f, m.num("smoothing", m.num("smooth", 0f)));
        cameraLookAhead = Math.max(0f, m.num("lookAhead", 0f));
        cameraClampToMap = m.bool("clampToMap", true);
    }

    /** 地图比窗口大才需要跟随；比窗口小就整图居中，避免「地图跟着玩家乱跑」。 */
    private boolean canFollow() {
        return cameraFollow && player != null
                && (mapWidth() > viewW || mapHeight() > viewH);
    }

    private void resetCamera() {
        view.setViewport(viewW, viewH);
        view.setMap(mapWidth(), mapHeight());
        readCameraModule();
        applyCameraPolicy(true);
    }

    /**
     * 视口策略：
     *  - 默认 = 编辑器「缩放到整张地图」：整图等比 contain、居中，画面和编辑器一致；
     *  - 玩家挂了 fx.cameraFollow 且地图大于窗口 = 1:1 跟随（按 clampToMap 钳制）。
     */
    private void applyCameraPolicy(boolean snap) {
        view.setViewport(viewW, viewH);
        view.setMap(mapWidth(), mapHeight());
        if (scriptCameraControl) {
            // 相机由脚本接管（bwe.camera.*）：只同步视口/地图尺寸，位置与缩放不动。
            return;
        }
        if (canFollow()) {
            view.actualSize();
            float tx = player.x + player.faceX * cameraLookAhead;
            float ty = player.y + player.faceY * cameraLookAhead;
            if (snap || cameraSmooth <= 0f) {
                view.camX = tx;
                view.camY = ty;
            }
            if (cameraClampToMap) {
                view.clampCamera();
            }
        } else {
            view.fitWholeMap();
        }
    }

    float mapWidth() {
        return scene.width * (float) scene.tileSize;
    }

    float mapHeight() {
        return scene.height * (float) scene.tileSize;
    }

    // ---------------- 脚本引擎用的宿主接口 ----------------

    /** 脚本日志统一写进 Build/bwe.log。 */
    void scriptLog(String message) {
        BweLauncher.log(bootFile, message);
    }

    File bootFileForScripts() {
        return bootFile;
    }

    /** 脚本按素材名换图（与编辑器共用同一份素材表）。 */
    boolean applyAsset(Actor a, String assetName) {
        GameData.RtAsset asset = data.assetByName(assetName);
        if (asset == null) {
            return false;
        }
        a.asset = asset;
        a.textures.clear();
        a.frames.clear();
        a.texW = 0;
        a.texH = 0;
        loadActorFrames(a);
        return true;
    }

    /** 脚本创建实体：映射成场景里的 Actor。 */
    Actor spawnScripted(float x, float y, String assetName, String name, String kind,
                        int z, float halfW, float halfH) {
        GameData.RtObject o = new GameData.RtObject();
        o.id = "js-" + (++scriptSpawnSeq);
        o.name = name == null ? "" : name;
        o.kind = kind == null || kind.isEmpty() ? "PROP" : kind;
        o.x = x;
        o.y = y;
        o.z = z;
        o.visible = true;
        o.halfW = halfW;
        o.halfH = halfH;
        o.assetName = assetName == null ? "" : assetName;
        Actor a = new Actor();
        a.o = o;
        a.x = x;
        a.y = y;
        a.baseX = x;
        a.baseY = y;
        a.asset = data.assetByName(o.assetName);
        loadActorFrames(a);
        actors.add(a);
        return a;
    }

    void destroyActor(Actor a) {
        if (a == null) {
            return;
        }
        actors.remove(a);
        a.dead = true;
    }

    private int scriptSpawnSeq = 0;

    // ---------------- 素材 ----------------

    private void loadActorFrames(Actor a) {
        a.textures.clear();
        a.frames.clear();
        if (a.asset == null || a.asset.path == null || a.asset.path.isEmpty()
                || "AUDIO".equalsIgnoreCase(a.asset.kind)) {
            return;
        }
        if ("SEQUENCE".equalsIgnoreCase(a.asset.kind)) {
            File dir = new File(assetRoot, a.asset.path);
            int count = Math.max(1, a.asset.frames);
            for (int i = 0; i < count; i++) {
                int n = a.asset.zeroBased ? i : i + 1;
                File f = new File(dir, (a.asset.head.isEmpty() ? "frame" : a.asset.head) + n + ".png");
                BufferedImage img = readImage(f);
                if (img == null) {
                    continue;
                }
                Texture tex = textureFromImage(img);
                a.textures.add(tex);
                a.frames.add(new Frame(tex, 0f, 0f, 1f, 1f));
                if (a.texW == 0) {
                    a.texW = tex.w;
                    a.texH = tex.h;
                }
            }
            return;
        }

        File f = new File(assetRoot, a.asset.path);
        BufferedImage img = readImage(f);
        if (img == null) {
            return;
        }
        Texture tex = textureFromImage(img);
        a.texW = tex.w;
        a.texH = tex.h;
        a.textures.add(tex);
        if ("ATLAS".equalsIgnoreCase(a.asset.kind)) {
            int cols = Math.max(1, a.asset.cols);
            int rows = Math.max(1, a.asset.rows);
            // 图集的显示尺寸以单元格为准（编辑器 sizeOf 用 cellW/cellH），
            // 否则整张图集会被当成一个精灵，画出来大小完全不对。
            if (a.asset.cellW > 0) {
                a.texW = a.asset.cellW;
            } else {
                a.texW = tex.w / cols;
            }
            if (a.asset.cellH > 0) {
                a.texH = a.asset.cellH;
            } else {
                a.texH = tex.h / rows;
            }
            for (int r = 0; r < rows; r++) {
                for (int c = 0; c < cols; c++) {
                    a.frames.add(new Frame(tex,
                            c / (float) cols, r / (float) rows,
                            (c + 1) / (float) cols, (r + 1) / (float) rows));
                }
            }
        } else {
            a.frames.add(new Frame(tex, 0f, 0f, 1f, 1f));
        }
    }

    private BufferedImage readImage(File f) {
        if (f == null || !f.isFile()) {
            return null;
        }
        String key = f.getAbsolutePath();
        BufferedImage cached = imageCache.get(key);
        if (cached != null) {
            return cached;
        }
        try {
            BufferedImage img = ImageIO.read(f);
            if (img != null) {
                imageCache.put(key, img);
            }
            return img;
        } catch (IOException e) {
            BweLauncher.log(bootFile, "读取素材失败: " + key + " / " + e.getMessage());
            return null;
        }
    }

    Texture textureFromImage(BufferedImage img) {
        // 纹理在 GL 线程外生成，这里只负责缓存；真正的上传在 uploadTextures() 里做。
        Texture t = new Texture();
        t.w = img.getWidth();
        t.h = img.getHeight();
        t.id = -1;
        pendingUploads.put(t, img);
        return t;
    }

    final Map<Texture, BufferedImage> pendingUploads = new HashMap<>();
    private final List<Texture> uploadedTextures = new ArrayList<>();

    private void uploadTextures(GL2 gl) {
        if (pendingUploads.isEmpty()) {
            return;
        }
        for (Map.Entry<Texture, BufferedImage> e : new ArrayList<>(pendingUploads.entrySet())) {
            Texture t = e.getKey();
            BufferedImage img = e.getValue();
            if (t.id < 0) {
                int[] ids = new int[1];
                gl.glGenTextures(1, ids, 0);
                t.id = ids[0];
                uploadedTextures.add(t);
            }
            uploadImage(gl, t.id, img);
            pendingUploads.remove(t);
        }
    }

    private void uploadImage(GL2 gl, int id, BufferedImage img) {
        int w = img.getWidth();
        int h = img.getHeight();
        int[] pixels = img.getRGB(0, 0, w, h, null, 0, w);
        ByteBuffer buf = ByteBuffer.allocateDirect(w * h * 4);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int p = pixels[y * w + x];
                buf.put((byte) ((p >> 16) & 0xFF));
                buf.put((byte) ((p >> 8) & 0xFF));
                buf.put((byte) (p & 0xFF));
                buf.put((byte) ((p >>> 24) & 0xFF));
            }
        }
        buf.flip();
        gl.glBindTexture(GL2.GL_TEXTURE_2D, id);
        gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_MIN_FILTER, GL2.GL_NEAREST);
        gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_MAG_FILTER, GL2.GL_NEAREST);
        gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_WRAP_S, GL2.GL_CLAMP);
        gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_WRAP_T, GL2.GL_CLAMP);
        gl.glPixelStorei(GL2.GL_UNPACK_ALIGNMENT, 1);
        gl.glTexImage2D(GL2.GL_TEXTURE_2D, 0, GL2.GL_RGBA, w, h, 0,
                GL2.GL_RGBA, GL2.GL_UNSIGNED_BYTE, buf);
    }

    BufferedImage imageForAssetName(String name) {
        if (name == null || name.isEmpty()) {
            return null;
        }
        GameData.RtAsset a = data.assetByName(name);
        if (a == null || a.path == null || a.path.isEmpty()) {
            return null;
        }
        if ("SEQUENCE".equalsIgnoreCase(a.kind)) {
            File dir = new File(assetRoot, a.path);
            String head = a.head.isEmpty() ? "frame" : a.head;
            File f = new File(dir, head + (a.zeroBased ? "0" : "1") + ".png");
            return readImage(f);
        }
        return readImage(new File(assetRoot, a.path));
    }

    Texture firstTextureForName(String name) {
        if (name == null || name.isEmpty() || "无".equals(name)) {
            return null;
        }
        GameData.RtAsset a = data.assetByName(name);
        if (a == null) {
            return null;
        }
        String key = "asset:" + a.id;
        Texture cached = textureCache.get(key);
        if (cached != null) {
            return cached;
        }
        BufferedImage img = null;
        if ("SEQUENCE".equalsIgnoreCase(a.kind)) {
            File dir = new File(assetRoot, a.path);
            img = readImage(new File(dir, (a.head.isEmpty() ? "frame" : a.head) + (a.zeroBased ? "0" : "1") + ".png"));
        } else if (a.path != null && !a.path.isEmpty()) {
            img = readImage(new File(assetRoot, a.path));
        }
        if (img == null) {
            return null;
        }
        Texture t = textureFromImage(img);
        textureCache.put(key, t);
        return t;
    }

    // ---------------- OpenGL 生命周期 ----------------

    @Override
    public void init(GLAutoDrawable drawable) {
        GL2 gl = drawable.getGL().getGL2();
        gl.glEnable(GL2.GL_BLEND);
        gl.glBlendFunc(GL2.GL_SRC_ALPHA, GL2.GL_ONE_MINUS_SRC_ALPHA);
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glTexEnvi(GL2.GL_TEXTURE_ENV, GL2.GL_TEXTURE_ENV_MODE, GL2.GL_MODULATE);
        gl.glClearColor(0.055f, 0.067f, 0.1f, 1f);
    }

    @Override
    public void dispose(GLAutoDrawable drawable) {
        try {
            if (animator != null) {
                animator.stop();
            }
            GL2 gl = drawable.getGL().getGL2();
            for (Texture t : uploadedTextures) {
                int[] ids = {t.id};
                gl.glDeleteTextures(1, ids, 0);
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void reshape(GLAutoDrawable drawable, int x, int y, int width, int height) {
        // ⚠ Windows 高 DPI（125%/150%）下：
        //   - JOGL 的 reshape 尺寸 / GL 绘制表面 = 物理像素
        //   - AWT 组件尺寸 / 鼠标事件坐标 / 文字布局 = 逻辑像素
        // 之前把物理尺寸当成逻辑用：投影按 1920x1080 算、鼠标按 1280x720 报，
        // 于是「画面只画了一部分 + 点击整体偏移」。现在投影用逻辑尺寸，glViewport 用物理尺寸。
        updateSurfaceSize(width, height);
        logScaleInfoOnce(width, height);
        view.setViewport(viewW, viewH);
        view.setMap(mapWidth(), mapHeight());
        // 视口变了，fit 倍数和相机钳制都要重算，否则窗口一缩放画面就偏。
        applyCameraPolicy(true);
        logViewportOnce();
        GL2 gl = drawable.getGL().getGL2();
        gl.glViewport(0, 0, surfaceW, surfaceH);
        gl.glMatrixMode(GL2.GL_PROJECTION);
        gl.glLoadIdentity();
        // 世界坐标 Y 向下：bottom=viewH, top=0。屏幕 y 与世界 y 同向。
        gl.glOrtho(0, viewW, viewH, 0, -1, 1);
        gl.glMatrixMode(GL2.GL_MODELVIEW);
        gl.glLoadIdentity();
    }

    /**
     * 算出两套尺寸：
     * <ul>
     *   <li>{@code viewW/viewH}：逻辑像素（= AWT 组件尺寸），投影、fit、鼠标坐标都用它</li>
     *   <li>{@code surfaceW/surfaceH}：物理像素（= 逻辑 × 屏幕缩放），只用于 glViewport</li>
     * </ul>
     */
    private void updateSurfaceSize(int drawableWidth, int drawableHeight) {
        drawableW = Math.max(1, drawableWidth);
        drawableH = Math.max(1, drawableHeight);
        if (canvas == null) {
            viewW = drawableW;
            viewH = drawableH;
            surfaceW = drawableW;
            surfaceH = drawableH;
            return;
        }
        int cw = Math.max(1, canvas.getWidth());
        int ch = Math.max(1, canvas.getHeight());
        double sx = 1.0;
        double sy = 1.0;
        try {
            java.awt.GraphicsConfiguration gc = canvas.getGraphicsConfiguration();
            if (gc != null) {
                java.awt.geom.AffineTransform t = gc.getDefaultTransform();
                sx = t.getScaleX();
                sy = t.getScaleY();
            }
        } catch (Throwable ignored) {
        }
        if (!(sx > 0.01)) {
            sx = 1.0;
        }
        if (!(sy > 0.01)) {
            sy = 1.0;
        }
        viewW = cw;
        viewH = ch;
        // 实测（fb-probe）：1707x1067 逻辑 @1.5 → framebuffer 正好 2560x1600，
        // 所以用 floor 而不是 round，避免 glViewport 比真实表面大 1px。
        surfaceW = Math.max(1, (int) Math.floor(cw * sx));
        surfaceH = Math.max(1, (int) Math.floor(ch * sy));
    }

    /**
     * 高 DPI 排查专用：设置环境变量 BWE_FBPROBE=1 后，把第一帧的 framebuffer 原样存成
     * {@code Build/fb-frame.png}。用它可以直接量出「GL 到底画了多大一块、留白在哪」，
     * 不依赖看屏幕，也不依赖 glReadPixels 的越界行为。
     */
    private void dumpFrameOnce(GL2 gl) {
        if (dumpedFrame || !"1".equals(System.getenv("BWE_FBPROBE"))) {
            return;
        }
        dumpedFrame = true;
        try {
            gl.glFinish();
            int w = surfaceW;
            int h = surfaceH;
            java.nio.ByteBuffer buf = java.nio.ByteBuffer.allocateDirect(w * h * 4);
            gl.glPixelStorei(GL2.GL_PACK_ALIGNMENT, 1);
            gl.glReadPixels(0, 0, w, h, GL2.GL_RGBA, GL2.GL_UNSIGNED_BYTE, buf);
            java.awt.image.BufferedImage img =
                    new java.awt.image.BufferedImage(w, h, java.awt.image.BufferedImage.TYPE_INT_ARGB);
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
            File out = new File(bootFile.getParentFile(), "fb-frame.png");
            javax.imageio.ImageIO.write(img, "png", out);
            BweLauncher.log(bootFile, "第一帧原始截图: " + out.getAbsolutePath()
                    + "（" + w + "x" + h + "，逻辑 " + viewW + "x" + viewH + "）");
        } catch (Throwable t) {
            BweLauncher.log(bootFile, "第一帧截图失败: " + t);
        }
    }

    @Override
    public void display(GLAutoDrawable drawable) {
        try {
            long now = System.nanoTime();
            float dt = lastNanos == 0 ? 0.016f : (now - lastNanos) / 1_000_000_000f;
            lastNanos = now;
            dt = Math.min(0.05f, Math.max(0.001f, dt));
            time += dt;

            update(dt);

            GL2 gl = drawable.getGL().getGL2();
            gl.glClear(GL2.GL_COLOR_BUFFER_BIT);
            gl.glLoadIdentity();
            uploadTextures(gl);

            gl.glDisable(GL2.GL_TEXTURE_2D);
            // 唯一的视图变换：screen = (world - cam) * zoom + view/2
            view.applyGL(gl);

            drawMap(gl);
            drawActors(gl);

            // 脚本的立即模式绘制（HUD / 文字 / 特效）。世界/屏幕空间的切换由脚本 API 自己负责。
            if (scripts != null) {
                gl.glLoadIdentity();
                try {
                    scripts.draw(gl);
                } catch (Throwable t) {
                    BweLauncher.log(bootFile, "[脚本] draw 异常: " + t);
                }
                gl.glLoadIdentity();
            }

            gl.glFlush();
            dumpFrameOnce(gl);
        } catch (Throwable t) {
            if (!loggedDisplayError) {
                loggedDisplayError = true;
                BweLauncher.fail(bootFile, "游戏渲染失败", t);
            }
        }
    }

    // ---------------- 更新 ----------------

    private void update(float dt) {
        // 脚本先跑：这样 onUpdate 里改的位置/相机/可见性，本帧的模块与绘制都能立刻用上。
        if (scripts != null) {
            try {
                scripts.update(dt);
            } catch (Throwable t) {
                BweLauncher.log(bootFile, "[脚本] update 异常: " + t);
            }
        }
        if (player != null) {
            updatePlayer(dt);
        }
        for (Actor a : actors) {
            if (a == player) {
                continue;
            }
            updateModules(a, dt);
        }
        updateCamera(dt);
        if (minesweeper != null) {
            minesweeper.update(dt);
        }
        updateTitle();
    }

    private void updatePlayer(float dt) {
        if (data.has(player.o, "move.locked")) {
            return;
        }
        float speed = 150f;
        GameData.RtModule move = data.module(player.o, "move.player", "move.speed");
        if (move != null) {
            speed = move.num("speed", move.num("moveSpeed", speed));
        }
        GameData.RtModule follow = data.module(player.o, "move.follow", "move.follow");
        if (follow != null) {
            speed = follow.num("speed", speed);
        }

        float dx = 0f;
        float dy = 0f;
        if (keys[KeyEvent.VK_A] || keys[KeyEvent.VK_LEFT]) {
            dx -= 1f;
        }
        if (keys[KeyEvent.VK_D] || keys[KeyEvent.VK_RIGHT]) {
            dx += 1f;
        }
        if (keys[KeyEvent.VK_W] || keys[KeyEvent.VK_UP]) {
            dy -= 1f;
        }
        if (keys[KeyEvent.VK_S] || keys[KeyEvent.VK_DOWN]) {
            dy += 1f;
        }
        if (dx != 0f || dy != 0f) {
            float len = (float) Math.sqrt(dx * dx + dy * dy);
            dx /= len;
            dy /= len;
            player.faceX = dx;
            player.faceY = dy;
            player.x += dx * speed * dt;
            player.y += dy * speed * dt;
            float margin = Math.max(8f, Math.min(player.o.halfW, player.o.halfH));
            player.x = Math.max(margin, Math.min(mapWidth() - margin, player.x));
            player.y = Math.max(margin, Math.min(mapHeight() - margin, player.y));
            player.animT += dt;
        } else {
            player.animT += dt * 0.25f;
        }
    }

    private void updateModules(Actor a, float dt) {
        a.animT += dt;
        GameData.RtModule patrol = data.firstModule(a.o, "move.patrol", null);
        if (patrol != null) {
            String axis = patrol.str("axis", "水平 Horizontal");
            float distance = patrol.num("distance", 96);
            float speed = Math.max(1f, patrol.num("speed", 40));
            float t = time * speed / Math.max(1f, distance);
            if (axis.contains("垂直") || axis.toLowerCase().contains("vertical")) {
                a.y = a.baseY + (float) Math.sin(t) * distance;
            } else {
                a.x = a.baseX + (float) Math.sin(t) * distance;
            }
            return;
        }
        GameData.RtModule follow = data.firstModule(a.o, "move.follow", null);
        if (follow != null && player != null) {
            float speed = follow.num("speed", 60);
            float stop = follow.num("stopDistance", 48);
            float ddx = player.x - a.x;
            float ddy = player.y - a.y;
            float dist = (float) Math.sqrt(ddx * ddx + ddy * ddy);
            if (dist > stop) {
                a.x += ddx / dist * speed * dt;
                a.y += ddy / dist * speed * dt;
            }
            return;
        }
        GameData.RtModule flee = data.firstModule(a.o, "move.flee", null);
        if (flee != null && player != null) {
            float speed = flee.num("speed", 70);
            float range = flee.num("range", 240);
            float ddx = a.x - player.x;
            float ddy = a.y - player.y;
            float dist = (float) Math.sqrt(ddx * ddx + ddy * ddy);
            if (dist > 0.01f && dist < range) {
                a.x += ddx / dist * speed * dt;
                a.y += ddy / dist * speed * dt;
            }
            return;
        }
        GameData.RtModule wander = data.firstModule(a.o, "move.wander", null);
        if (wander != null) {
            float speed = wander.num("speed", 30);
            float radius = wander.num("radius", 80);
            a.wanderT -= dt;
            if (a.wanderT <= 0f) {
                a.wanderT = 1.2f + new Random().nextFloat() * 2.2f;
                double ang = new Random().nextDouble() * Math.PI * 2;
                a.wanderDirX = (float) Math.cos(ang);
                a.wanderDirY = (float) Math.sin(ang);
            }
            float nx = a.x + a.wanderDirX * speed * dt;
            float ny = a.y + a.wanderDirY * speed * dt;
            if (Math.abs(nx - a.baseX) <= radius) {
                a.x = nx;
            } else {
                a.wanderDirX = -a.wanderDirX;
            }
            if (Math.abs(ny - a.baseY) <= radius) {
                a.y = ny;
            } else {
                a.wanderDirY = -a.wanderDirY;
            }
        }
    }

    private void updateCamera(float dt) {
        if (scriptCameraControl) {
            return;
        }
        if (!canFollow()) {
            // 默认视图：整图 contain 居中（等价编辑器 F 缩放）。视口变化时会被重算。
            view.fitWholeMap();
            return;
        }
        view.actualSize();
        float targetX = player.x + player.faceX * cameraLookAhead;
        float targetY = player.y + player.faceY * cameraLookAhead;
        if (cameraSmooth > 0f) {
            float k = Math.min(1f, cameraSmooth * dt);
            view.camX += (targetX - view.camX) * k;
            view.camY += (targetY - view.camY) * k;
        } else {
            view.camX = targetX;
            view.camY = targetY;
        }
        if (cameraClampToMap) {
            view.clampCamera();
        }
    }

    private void updateTitle() {
        if (frame == null) {
            return;
        }
        StringBuilder sb = new StringBuilder();
        sb.append("BWE · ").append(data.project);
        if (!sceneName.isEmpty()) {
            sb.append(" · ").append(sceneName);
        }
        if (minesweeper != null) {
            sb.append(" · ").append(minesweeper.status());
        } else if (!dressParts.isEmpty()) {
            sb.append(" · 点击部件换装，R 重置");
        } else if (player != null) {
            sb.append(" · WASD 移动");
        }
        String title = sb.toString();
        if (!title.equals(lastTitle)) {
            lastTitle = title;
            frame.setTitle(title);
        }
    }

    // ---------------- 绘制 ----------------

    private void drawMap(GL2 gl) {
        float mapW = mapWidth();
        float mapH = mapHeight();
        // 地图外的底色
        gl.glColor4f(0.035f, 0.043f, 0.065f, 1f);
        gl.glBegin(GL2.GL_QUADS);
        gl.glVertex2f(-4000, -4000);
        gl.glVertex2f(mapW + 4000, -4000);
        gl.glVertex2f(mapW + 4000, mapH + 4000);
        gl.glVertex2f(-4000, mapH + 4000);
        gl.glEnd();

        gl.glColor4f(0.075f, 0.094f, 0.135f, 1f);
        gl.glBegin(GL2.GL_QUADS);
        gl.glVertex2f(0, 0);
        gl.glVertex2f(mapW, 0);
        gl.glVertex2f(mapW, mapH);
        gl.glVertex2f(0, mapH);
        gl.glEnd();

        int ts = Math.max(8, scene.tileSize);
        gl.glLineWidth(1f);
        gl.glColor4f(0.12f, 0.15f, 0.21f, 0.65f);
        gl.glBegin(GL2.GL_LINES);
        for (float x = 0; x <= mapW; x += ts) {
            gl.glVertex2f(x, 0);
            gl.glVertex2f(x, mapH);
        }
        for (float y = 0; y <= mapH; y += ts) {
            gl.glVertex2f(0, y);
            gl.glVertex2f(mapW, y);
        }
        gl.glEnd();

        gl.glLineWidth(2f);
        gl.glColor4f(0.21f, 0.27f, 0.38f, 1f);
        gl.glBegin(GL2.GL_LINE_LOOP);
        gl.glVertex2f(0, 0);
        gl.glVertex2f(mapW, 0);
        gl.glVertex2f(mapW, mapH);
        gl.glVertex2f(0, mapH);
        gl.glEnd();
    }

    /**
     * 绘制顺序 = 编辑器 canvas.ts 的 orderObjects()：<b>图层 → z → y</b>。
     * 少考虑图层会让「地形层压住角色层」这类错误在打包后必现。
     */
    private static Comparator<Actor> actorOrder() {
        return new Comparator<Actor>() {
            @Override
            public int compare(Actor a, Actor b) {
                int layer = Integer.compare(a.o.layer, b.o.layer);
                if (layer != 0) {
                    return layer;
                }
                int z = Integer.compare(a.o.z, b.o.z);
                if (z != 0) {
                    return z;
                }
                return Float.compare(a.y, b.y);
            }
        };
    }

    private void drawActors(GL2 gl) {
        List<Actor> sorted = new ArrayList<>(actors);
        Collections.sort(sorted, actorOrder());
        for (Actor a : sorted) {
            if (!a.o.visible || a.dead) {
                continue;
            }
            drawActor(gl, a);
        }
    }

    private void drawActor(GL2 gl, Actor a) {
        float alpha = 1f;
        if (data.has(a.o, "look.blink") || data.has(a.o, "render.blink")) {
            alpha = 0.3f + 0.7f * Math.abs((float) Math.sin(time * 6f));
        }

        if (data.has(a.o, "look.shadow") || data.has(a.o, "render.shadow")) {
            float hw = drawWidth(a) * 0.42f;
            float hh = Math.max(6f, drawHeight(a) * 0.12f);
            drawEllipse(gl, a.x, a.y + drawHeight(a) * 0.42f, hw, hh, 0.22f * alpha);
        }

        if (a.dress != null) {
            drawDressPart(gl, a, a.dress, alpha);
            return;
        }

        Texture tex = null;
        Frame frame = null;
        if (!a.frames.isEmpty()) {
            int idx = 0;
            int count = a.frames.size();
            // animMode 是编辑器里的中文枚举：默认 / 只显示首帧 / 单次播放（见 panels/inspector.ts）
            boolean firstOnly = "只显示首帧".equals(a.o.animMode);
            boolean playOnce = "单次播放".equals(a.o.animMode)
                    || "PLAY_ONCE".equalsIgnoreCase(a.o.animMode);
            if (!firstOnly && count > 1) {
                int fps = a.o.animFps > 0f ? Math.round(a.o.animFps) : 8;
                idx = (int) (a.animT * Math.max(1, fps)) % count;
                if (playOnce) {
                    idx = Math.min(idx, count - 1);
                }
            }
            frame = a.frames.get(Math.max(0, Math.min(count - 1, idx)));
            tex = frame.texture;
        }

        if (tex == null) {
            drawFallback(gl, a, alpha);
            return;
        }

        float w = drawWidth(a);
        float h = drawHeight(a);
        drawTexture(gl, tex, a.x, a.y, w, h, a.o.rotation, alpha,
                frame.u0, frame.v0, frame.u1, frame.v1);

        // 扫雷棋盘：面板贴图之上再画可玩格子。
        if (a.mine != null) {
            a.mine.draw(gl);
        }
        drawHp(gl, a, alpha);
    }

    private void drawDressPart(GL2 gl, Actor a, DressPart p, float alpha) {
        String name = p.selectedAsset();
        Texture tex = firstTextureForName(name);
        float w = drawWidth(a);
        float h = drawHeight(a);
        float x = a.x + p.offsetX;
        float y = a.y + p.offsetY;
        if (tex != null && !"无".equals(name) && !"transparent".equalsIgnoreCase(name)) {
            float scale = p.scale <= 0f ? 1f : p.scale;
            drawTexture(gl, tex, x, y, w * scale, h * scale, a.o.rotation, alpha,
                    0f, 0f, 1f, 1f);
        } else {
            Color c = parseColor(p.fallback, new Color(0.5f, 0.5f, 0.5f, 1f));
            if (c.getAlpha() > 0) {
                gl.glDisable(GL2.GL_TEXTURE_2D);
                gl.glColor4f(c.getRed() / 255f, c.getGreen() / 255f, c.getBlue() / 255f,
                        c.getAlpha() / 255f * alpha);
                gl.glBegin(GL2.GL_QUADS);
                gl.glVertex2f(x - w / 2f, y - h / 2f);
                gl.glVertex2f(x + w / 2f, y - h / 2f);
                gl.glVertex2f(x + w / 2f, y + h / 2f);
                gl.glVertex2f(x - w / 2f, y + h / 2f);
                gl.glEnd();
            }
        }
    }

    /**
     * 对象的绘制宽度/高度。这份规则 <b>必须</b> 和编辑器 web/src/app/painter.ts 的 sizeOf() 一致，
     * 否则「打包出来的位置和大小跟编辑器里不一样」：
     * <pre>
     *   1) halfW/halfH 有任意一个 > 0 → 两个方向各自取值（缺的一边 16），最小 4；不再乘 scale
     *   2) props.w / props.h 都 > 0      → 用 props 尺寸，乘 scale
     *   3) 素材像素尺寸（ATLAS 用 cellW/cellH）→ 乘 scale
     *   4) 兜底：tileSize → 乘 scale
     * </pre>
     */
    float drawWidth(Actor a) {
        return sizeOf(a, true);
    }

    float drawHeight(Actor a) {
        return sizeOf(a, false);
    }

    private float sizeOf(Actor a, boolean horizontal) {
        GameData.RtObject o = a.o;
        float scale = horizontal ? nz(o.scaleX) : nz(o.scaleY);
        if (o.halfW > 0f || o.halfH > 0f) {
            float half = horizontal ? o.halfW : o.halfH;
            return Math.max(4f, half > 0f ? half * 2f : 16f);
        }
        float propW = propNum(o, "w");
        float propH = propNum(o, "h");
        if (propW > 0f && propH > 0f) {
            return (horizontal ? propW : propH) * scale;
        }
        float px = assetPixel(a, horizontal);
        if (px > 0f) {
            return px * scale;
        }
        return scene.tileSize * scale;
    }

    /** 素材在「一格对象」意义上的像素尺寸；图集用单元格尺寸，与编辑器一致。 */
    private float assetPixel(Actor a, boolean horizontal) {
        if (a.asset != null && "ATLAS".equalsIgnoreCase(a.asset.kind)) {
            int cell = horizontal ? a.asset.cellW : a.asset.cellH;
            if (cell > 0) {
                return cell;
            }
            // cellW/cellH 为 0 时编辑器按 floor(整图/列数) 切格。
            int total = horizontal ? a.texW : a.texH;
            int n = Math.max(1, horizontal ? a.asset.cols : a.asset.rows);
            return total > 0 ? (float) Math.floorDiv(total, n) : 0f;
        }
        int tex = horizontal ? a.texW : a.texH;
        return Math.max(0, tex);
    }

    private static float nz(float v) {
        // 与编辑器 sizeOf 一致：scale 原样参与计算（编辑器 UI 最小 0.05，0 只可能来自手改工程）。
        return v;
    }

    private static float propNum(GameData.RtObject o, String key) {
        String raw = o.props.get(key);
        if (raw == null || raw.isEmpty()) {
            return 0f;
        }
        try {
            return Float.parseFloat(raw.trim());
        } catch (NumberFormatException e) {
            return 0f;
        }
    }

    private void drawFallback(GL2 gl, Actor a, float alpha) {
        String kind = a.o.kind == null ? "PROP" : a.o.kind.toUpperCase();
        Color c;
        if ("ZONE".equals(kind) || "PORTAL".equals(kind)) {
            c = new Color(0.35f, 0.55f, 0.95f, 0.25f);
        } else if ("SPAWN".equals(kind)) {
            c = new Color(0.35f, 0.9f, 0.55f, 0.55f);
        } else if ("LIGHT".equals(kind)) {
            c = new Color(1f, 0.85f, 0.35f, 0.35f);
        } else if ("ACTOR".equals(kind)) {
            c = new Color(0.3f, 0.62f, 1f, 1f);
        } else {
            c = new Color(0.45f, 0.5f, 0.62f, 1f);
        }
        gl.glDisable(GL2.GL_TEXTURE_2D);
        gl.glColor4f(c.getRed() / 255f, c.getGreen() / 255f, c.getBlue() / 255f,
                c.getAlpha() / 255f * alpha);
        float w = drawWidth(a);
        float h = drawHeight(a);
        gl.glBegin(GL2.GL_QUADS);
        gl.glVertex2f(a.x - w / 2f, a.y - h / 2f);
        gl.glVertex2f(a.x + w / 2f, a.y - h / 2f);
        gl.glVertex2f(a.x + w / 2f, a.y + h / 2f);
        gl.glVertex2f(a.x - w / 2f, a.y + h / 2f);
        gl.glEnd();
        if (a.mine != null) {
            a.mine.draw(gl);
        }
    }

    void drawTexture(GL2 gl, Texture tex, float cx, float cy, float w, float h,
                             float rotation, float alpha,
                             float u0, float v0, float u1, float v1) {
        if (tex == null || tex.id < 0) {
            return;
        }
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glBindTexture(GL2.GL_TEXTURE_2D, tex.id);
        gl.glColor4f(1f, 1f, 1f, alpha);
        gl.glPushMatrix();
        gl.glTranslatef(cx, cy, 0f);
        if (rotation != 0f) {
            // 正号！screen_y = y_eye（glOrtho 的 y 反射与窗口 y 翻转互相抵消），
            // 所以 glRotatef(+φ) 在 y 向下的屏幕上就是顺时针，等于 canvas rotate(+rotation)。
            // 写成 -rotation 会让旋转对象与编辑器镜像。
            gl.glRotatef(rotation, 0f, 0f, 1f);
        }
        float l = -w / 2f;
        float r = w / 2f;
        float t = -h / 2f;
        float b = h / 2f;
        gl.glBegin(GL2.GL_QUADS);
        gl.glTexCoord2f(u0, v0);
        gl.glVertex2f(l, t);
        gl.glTexCoord2f(u1, v0);
        gl.glVertex2f(r, t);
        gl.glTexCoord2f(u1, v1);
        gl.glVertex2f(r, b);
        gl.glTexCoord2f(u0, v1);
        gl.glVertex2f(l, b);
        gl.glEnd();
        gl.glPopMatrix();
        gl.glDisable(GL2.GL_TEXTURE_2D);
    }

    private void drawHp(GL2 gl, Actor a, float alpha) {
        if (a.hpMax <= 0f || a.hp >= a.hpMax || a.hp <= 0f) {
            return;
        }
        float w = Math.max(32f, drawWidth(a) * 0.7f);
        float x = a.x - w / 2f;
        float y = a.y - drawHeight(a) / 2f - 10f;
        gl.glDisable(GL2.GL_TEXTURE_2D);
        gl.glColor4f(0f, 0f, 0f, 0.55f * alpha);
        gl.glBegin(GL2.GL_QUADS);
        gl.glVertex2f(x - 1, y - 1);
        gl.glVertex2f(x + w + 1, y - 1);
        gl.glVertex2f(x + w + 1, y + 6);
        gl.glVertex2f(x - 1, y + 6);
        gl.glEnd();
        float pct = Math.max(0f, Math.min(1f, a.hp / a.hpMax));
        gl.glColor4f(0.3f, 0.85f, 0.45f, alpha);
        gl.glBegin(GL2.GL_QUADS);
        gl.glVertex2f(x, y);
        gl.glVertex2f(x + w * pct, y);
        gl.glVertex2f(x + w * pct, y + 5);
        gl.glVertex2f(x, y + 5);
        gl.glEnd();
    }

    private void drawEllipse(GL2 gl, float cx, float cy, float rx, float ry, float alpha) {
        gl.glDisable(GL2.GL_TEXTURE_2D);
        gl.glColor4f(0f, 0f, 0f, alpha);
        gl.glBegin(GL2.GL_TRIANGLE_FAN);
        gl.glVertex2f(cx, cy);
        for (int i = 0; i <= 24; i++) {
            double a = i * Math.PI * 2 / 24;
            gl.glVertex2f(cx + (float) Math.cos(a) * rx, cy + (float) Math.sin(a) * ry);
        }
        gl.glEnd();
    }

    private static Color parseColor(String s, Color def) {
        if (s == null || s.isEmpty() || "transparent".equalsIgnoreCase(s)) {
            return new Color(0, 0, 0, 0);
        }
        try {
            if (s.startsWith("#")) {
                String hex = s.substring(1);
                if (hex.length() == 3) {
                    hex = "" + hex.charAt(0) + hex.charAt(0)
                            + hex.charAt(1) + hex.charAt(1)
                            + hex.charAt(2) + hex.charAt(2);
                }
                if (hex.length() == 6) {
                    return new Color(Integer.parseInt(hex, 16));
                }
            }
        } catch (Exception ignored) {
        }
        return def;
    }

    // ---------------- 布局自检（不建窗口） ----------------

    /**
     * 生成一份「编辑器 ↔ 引擎」映射自检报告：视口、缩放、相机，以及每个对象在世界/屏幕里的矩形。
     *
     * <p>它和渲染走的是同一套 {@link Viewport} 与 {@link #sizeOf}，所以报告里的数字就是玩家看到的数字。
     * 校验脚本（web/tools/verify-mapping.mjs）用编辑器的 sizeOf 公式复算一遍再逐项比对，
     * 任何人改坏映射都会在这里当场暴露，而不是等到「打包出来才发现错位」。
     */
    /** 校验脚本用：切换 fit 策略（contain / cover）。 */
    void setFitMode(String mode) {
        view.fitMode = "cover".equalsIgnoreCase(mode) ? Viewport.FIT_COVER : Viewport.FIT_CONTAIN;
    }

    String dumpLayout(int width, int height) {
        viewW = Math.max(1, width);
        viewH = Math.max(1, height);
        resetCamera();
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        sb.append("  \"project\": ").append(q(data.project)).append(",\n");
        sb.append("  \"scene\": ").append(q(sceneName)).append(",\n");
        sb.append("  \"tileSize\": ").append(scene.tileSize).append(",\n");
        sb.append("  \"map\": { \"width\": ").append(r(mapWidth()))
                .append(", \"height\": ").append(r(mapHeight())).append(" },\n");
        sb.append("  \"viewport\": { \"width\": ").append(viewW)
                .append(", \"height\": ").append(viewH).append(" },\n");
        sb.append("  \"zoom\": ").append(r3(view.zoom)).append(",\n");
        sb.append("  \"fitMode\": ").append(q(view.fitMode == Viewport.FIT_COVER ? "cover" : "contain")).append(",\n");
        sb.append("  \"camera\": { \"x\": ").append(r(view.camX))
                .append(", \"y\": ").append(r(view.camY)).append(" },\n");
        sb.append("  \"cameraFollow\": ").append(canFollow()).append(",\n");
        sb.append("  \"objects\": [\n");
        List<Actor> sorted = new ArrayList<>(actors);
        Collections.sort(sorted, actorOrder());
        for (int i = 0; i < sorted.size(); i++) {
            Actor a = sorted.get(i);
            float w = drawWidth(a);
            float h = drawHeight(a);
            float left = a.x - w / 2f;
            float top = a.y - h / 2f;
            sb.append("    { \"id\": ").append(q(a.o.id))
                    .append(", \"name\": ").append(q(a.o.name))
                    .append(", \"kind\": ").append(q(a.o.kind))
                    .append(", \"visible\": ").append(a.o.visible)
                    .append(", \"layer\": ").append(a.o.layer)
                    .append(", \"z\": ").append(a.o.z)
                    .append(", \"rotation\": ").append(r(a.o.rotation))
                    .append(", \"assetName\": ").append(q(a.o.assetName))
                    .append(", \"animMode\": ").append(q(a.o.animMode))
                    .append(", \"frames\": ").append(a.frames.size())
                    .append(", \"world\": { \"x\": ").append(r(a.x)).append(", \"y\": ").append(r(a.y))
                    .append(", \"w\": ").append(r(w)).append(", \"h\": ").append(r(h))
                    .append(", \"left\": ").append(r(left)).append(", \"top\": ").append(r(top)).append(" }")
                    .append(", \"screen\": { \"left\": ").append(r(view.toScreenX(left)))
                    .append(", \"top\": ").append(r(view.toScreenY(top)))
                    .append(", \"w\": ").append(r(w * view.zoom))
                    .append(", \"h\": ").append(r(h * view.zoom))
                    .append(", \"cx\": ").append(r(view.toScreenX(a.x)))
                    .append(", \"cy\": ").append(r(view.toScreenY(a.y))).append(" }")
                    .append(", \"edgeScreen\": { \"x\": ").append(r(view.toScreenX(rotatedX(a, w))))
                    .append(", \"y\": ").append(r(view.toScreenY(rotatedY(a, w)))).append(" }")
                    .append(", \"modules\": [");
            for (int m = 0; m < a.o.modules.size(); m++) {
                GameData.RtModule mod = a.o.modules.get(m);
                if (m > 0) {
                    sb.append(", ");
                }
                sb.append(q(mod.def));
            }
            sb.append("] }");
            if (i + 1 < sorted.size()) {
                sb.append(",");
            }
            sb.append("\n");
        }
        sb.append("  ]\n}\n");
        return sb.toString();
    }

    /**
     * 对象「右边缘中点」旋转后的世界 X。坐标系 y 向下，顺时针为正，和 canvas
     * {@code rotate(+deg)} 的公式一致：局部 (r,0) → (r·cosθ, r·sinθ)。
     * 校验脚本用它来防止旋转方向被改反（glRotatef 的正负号很容易搞错）。
     */
    private static float rotatedX(Actor a, float w) {
        double rad = Math.toRadians(a.o.rotation);
        return a.x + (float) (Math.cos(rad) * w / 2f);
    }

    private static float rotatedY(Actor a, float w) {
        double rad = Math.toRadians(a.o.rotation);
        return a.y + (float) (Math.sin(rad) * w / 2f);
    }

    private static String q(String s) {        if (s == null) {
            return "\"\"";
        }
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
            }
        }
        return b.append('"').toString();
    }

    private static String r(float v) {
        float x = Math.round(v * 100f) / 100f;
        if (x == Math.rint(x)) {
            return String.valueOf((long) x);
        }
        return String.valueOf(x);
    }

    private static String r3(float v) {
        return String.valueOf(Math.round(v * 10000f) / 10000f);
    }

    // ---------------- 换装 ----------------

    private static final class DressPart {
        final TopDownRuntime rt;
        final Actor actor;
        final String slot;
        final String fallback;
        final List<String> assets = new ArrayList<>();
        final int defaultIndex;
        int selected;
        final float offsetX;
        final float offsetY;
        final float scale;

        DressPart(TopDownRuntime rt, Actor actor, GameData.RtModule m) {
            this.rt = rt;
            this.actor = actor;
            this.slot = m.str("slot", "");
            this.fallback = m.str("fallbackColor", "#808080");
            this.defaultIndex = Math.max(0, m.intOf("defaultIndex", 0));
            this.selected = defaultIndex;
            this.offsetX = m.num("offsetX", 0);
            this.offsetY = m.num("offsetY", 0);
            this.scale = m.num("partScale", 1);
            String raw = m.str("optionAssets", "");
            if (!raw.isEmpty()) {
                for (String s : raw.split("[,，、|]")) {
                    if (!s.trim().isEmpty()) {
                        assets.add(s.trim());
                    }
                }
            } else if (actor.asset != null && actor.asset.name != null) {
                assets.add(actor.asset.name);
            }
        }

        String selectedAsset() {
            if (assets.isEmpty()) {
                return actor.asset == null ? "" : actor.asset.name;
            }
            int i = Math.max(0, Math.min(assets.size() - 1, selected));
            return assets.get(i);
        }

        boolean click(int wx, int wy) {
            // 命中区要和画出来的矩形一致（同一套 sizeOf），否则点偏了。
            float w = rt.drawWidth(actor) * (scale <= 0f ? 1f : scale);
            float h = rt.drawHeight(actor) * (scale <= 0f ? 1f : scale);
            float cx = actor.x + offsetX;
            float cy = actor.y + offsetY;
            if (Math.abs(wx - cx) > w / 2f || Math.abs(wy - cy) > h / 2f) {
                return false;
            }
            if (assets.size() > 1) {
                selected = (selected + 1) % assets.size();
            }
            return true;
        }
    }

    // ---------------- 扫雷 ----------------

    private static final class Minesweeper {
        final TopDownRuntime rt;
        final Actor actor;
        int rows = 10;
        int cols = 10;
        int cell = 32;
        int wantedMines = 10;
        int mineCount;
        boolean firstClickSafe = true;
        boolean rightClickFlag = true;
        boolean autoOpenZeros = true;
        boolean revealAllOnLose = true;
        boolean showTimer = true;
        int seed;

        boolean[] mine;
        boolean[] open;
        boolean[] flag;
        int[] counts;
        int flags;
        boolean started;
        boolean over;
        boolean won;
        float elapsed;
        float timerAcc;

        String hiddenAsset = "";
        String mineAsset = "";
        String flagAsset = "";

        BufferedImage image;
        Texture texture;
        boolean dirty = true;
        int boardW;
        int boardH;

        Minesweeper(TopDownRuntime rt, Actor actor, GameData.RtModule m) {
            this.rt = rt;
            this.actor = actor;
            rows = Math.max(3, Math.min(40, m.intOf("rows", 10)));
            cols = Math.max(3, Math.min(40, m.intOf("cols", 10)));
            cell = Math.max(16, Math.min(64, m.intOf("cellSize", 32)));
            wantedMines = Math.max(1, m.intOf("mines", 10));
            firstClickSafe = m.bool("firstClickSafe", true);
            rightClickFlag = m.bool("rightClickFlag", true);
            autoOpenZeros = m.bool("autoOpenZeros", true);
            revealAllOnLose = m.bool("revealAllOnLose", true);
            showTimer = m.bool("showTimer", true);
            seed = m.intOf("seed", 0);
            hiddenAsset = m.str("hiddenAsset", "");
            mineAsset = m.str("mineAsset", "");
            flagAsset = m.str("flagAsset", "");
            reset();
        }

        void reset() {
            int n = rows * cols;
            mine = new boolean[n];
            open = new boolean[n];
            flag = new boolean[n];
            counts = new int[n];
            flags = 0;
            started = false;
            over = false;
            won = false;
            elapsed = 0f;
            timerAcc = 0f;
            dirty = true;
            boardW = cols * cell;
            boardH = rows * cell;
            mineCount = Math.min(wantedMines, Math.max(1, n - 1));
        }

        void update(float dt) {
            if (started && !over) {
                timerAcc += dt;
                if (timerAcc >= 1f) {
                    int s = (int) timerAcc;
                    timerAcc -= s;
                    elapsed += s;
                    dirty = true;
                }
            }
        }

        String status() {
            String state;
            if (won) {
                state = "胜利";
            } else if (over) {
                state = "踩雷";
            } else if (started) {
                state = "进行中";
            } else {
                state = "点击开始";
            }
            String timer = showTimer ? " · " + (int) elapsed + "s" : "";
            return "扫雷 " + state + " · " + flags + "/" + mineCount + timer;
        }

        boolean click(int wx, int wy, boolean right) {
            if (over) {
                if (!right) {
                    reset();
                    return true;
                }
                return false;
            }
            float left = actor.x - boardW / 2f;
            float top = actor.y - boardH / 2f;
            if (wx < left || wy < top || wx >= left + boardW || wy >= top + boardH) {
                return false;
            }
            int c = (int) ((wx - left) / cell);
            int r = (int) ((wy - top) / cell);
            if (c < 0 || r < 0 || c >= cols || r >= rows) {
                return false;
            }
            int idx = r * cols + c;
            if (right) {
                if (!rightClickFlag) {
                    return true;
                }
                toggleFlag(idx);
                return true;
            }
            reveal(idx);
            return true;
        }

        void toggleFlag(int idx) {
            if (open[idx] || over) {
                return;
            }
            flag[idx] = !flag[idx];
            flags += flag[idx] ? 1 : -1;
            dirty = true;
        }

        void reveal(int idx) {
            if (open[idx] || flag[idx] || over) {
                return;
            }
            if (!started) {
                started = true;
                placeMines(idx);
            }
            if (mine[idx]) {
                over = true;
                won = false;
                if (revealAllOnLose) {
                    for (int i = 0; i < mine.length; i++) {
                        if (mine[i]) {
                            open[i] = true;
                        }
                    }
                }
                dirty = true;
                return;
            }
            openRegion(idx);
            checkWin();
            dirty = true;
        }

        void openRegion(int start) {
            if (!autoOpenZeros) {
                open[start] = true;
                return;
            }
            int[] stack = new int[Math.max(16, rows * cols * 8)];
            int top = 0;
            stack[top++] = start;
            while (top > 0) {
                int idx = stack[--top];
                if (open[idx] || flag[idx] || mine[idx]) {
                    continue;
                }
                open[idx] = true;
                if (counts[idx] == 0) {
                    int r = idx / cols;
                    int c = idx % cols;
                    for (int dr = -1; dr <= 1; dr++) {
                        for (int dc = -1; dc <= 1; dc++) {
                            if (dr == 0 && dc == 0) {
                                continue;
                            }
                            int nr = r + dr;
                            int nc = c + dc;
                            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                                int ni = nr * cols + nc;
                                if (!open[ni] && !flag[ni]) {
                                    stack[top++] = ni;
                                }
                            }
                        }
                    }
                }
            }
        }

        void placeMines(int safeIdx) {
            boolean[] blocked = new boolean[rows * cols];
            blocked[safeIdx] = true;
            if (firstClickSafe) {
                int sr = safeIdx / cols;
                int sc = safeIdx % cols;
                for (int dr = -1; dr <= 1; dr++) {
                    for (int dc = -1; dc <= 1; dc++) {
                        int nr = sr + dr;
                        int nc = sc + dc;
                        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                            blocked[nr * cols + nc] = true;
                        }
                    }
                }
            }
            List<Integer> pool = new ArrayList<>();
            for (int i = 0; i < blocked.length; i++) {
                if (!blocked[i]) {
                    pool.add(i);
                }
            }
            Random random = seed == 0 ? new Random() : new Random(seed);
            Collections.shuffle(pool, random);
            mineCount = Math.min(wantedMines, pool.size());
            for (int i = 0; i < mineCount; i++) {
                mine[pool.get(i)] = true;
            }
            counts = new int[rows * cols];
            for (int r = 0; r < rows; r++) {
                for (int c = 0; c < cols; c++) {
                    int idx = r * cols + c;
                    if (mine[idx]) {
                        continue;
                    }
                    int n = 0;
                    for (int dr = -1; dr <= 1; dr++) {
                        for (int dc = -1; dc <= 1; dc++) {
                            if (dr == 0 && dc == 0) {
                                continue;
                            }
                            int nr = r + dr;
                            int nc = c + dc;
                            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && mine[nr * cols + nc]) {
                                n++;
                            }
                        }
                    }
                    counts[idx] = n;
                }
            }
        }

        void checkWin() {
            for (int i = 0; i < open.length; i++) {
                if (!mine[i] && !open[i]) {
                    return;
                }
            }
            won = true;
            over = true;
            dirty = true;
        }

        void draw(GL2 gl) {
            if (texture == null || texture.id < 0) {
                paint();
                texture = rt.textureFromImage(image);
                rt.uploadTextures(gl);
            } else if (dirty) {
                paint();
                rt.uploadTextures(gl);
            }
            if (texture == null || texture.id < 0) {
                return;
            }
            float x = actor.x - boardW / 2f;
            float y = actor.y - boardH / 2f;
            gl.glEnable(GL2.GL_TEXTURE_2D);
            gl.glBindTexture(GL2.GL_TEXTURE_2D, texture.id);
            gl.glColor4f(1f, 1f, 1f, 1f);
            gl.glBegin(GL2.GL_QUADS);
            gl.glTexCoord2f(0f, 0f);
            gl.glVertex2f(x, y);
            gl.glTexCoord2f(1f, 0f);
            gl.glVertex2f(x + boardW, y);
            gl.glTexCoord2f(1f, 1f);
            gl.glVertex2f(x + boardW, y + boardH);
            gl.glTexCoord2f(0f, 1f);
            gl.glVertex2f(x, y + boardH);
            gl.glEnd();
            gl.glDisable(GL2.GL_TEXTURE_2D);
        }

        void paint() {
            int w = Math.max(1, boardW);
            int h = Math.max(1, boardH);
            if (image == null || image.getWidth() != w || image.getHeight() != h) {
                image = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
            }
            Graphics2D g = image.createGraphics();
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setColor(new Color(0, 0, 0, 0));
            g.fillRect(0, 0, w, h);

            BufferedImage hidden = rt.imageForAssetName(hiddenAsset);
            BufferedImage mineImg = rt.imageForAssetName(mineAsset);
            BufferedImage flagImg = rt.imageForAssetName(flagAsset);

            for (int r = 0; r < rows; r++) {
                for (int c = 0; c < cols; c++) {
                    int idx = r * cols + c;
                    int x = c * cell;
                    int y = r * cell;
                    if (!open[idx]) {
                        if (hidden != null) {
                            g.drawImage(hidden, x + 1, y + 1, cell - 2, cell - 2, null);
                        } else {
                            g.setColor(new Color(0x4a, 0x56, 0x6e));
                            g.fillRoundRect(x + 1, y + 1, cell - 2, cell - 2, 5, 5);
                            g.setColor(new Color(0x6c, 0x7c, 0x9d));
                            g.drawRoundRect(x + 1, y + 1, cell - 2, cell - 2, 5, 5);
                        }
                        if (flag[idx]) {
                            if (flagImg != null) {
                                g.drawImage(flagImg, x + cell / 4, y + cell / 4, cell / 2, cell / 2, null);
                            } else {
                                g.setColor(new Color(0xf0, 0x52, 0x5f));
                                g.fillPolygon(new int[]{x + 10, x + 24, x + 10},
                                        new int[]{y + 8, y + 15, y + 22}, 3);
                            }
                        }
                    } else if (mine[idx]) {
                        if (mineImg != null) {
                            g.drawImage(mineImg, x + 2, y + 2, cell - 4, cell - 4, null);
                        } else {
                            g.setColor(new Color(0x14, 0x18, 0x21));
                            g.fillOval(x + 8, y + 8, cell - 16, cell - 16);
                        }
                    } else {
                        g.setColor(new Color(0xe8, 0xec, 0xf5));
                        g.fillRect(x + 1, y + 1, cell - 2, cell - 2);
                        int n = counts[idx];
                        if (n > 0) {
                            g.setColor(numberColor(n));
                            g.setFont(new Font("Microsoft YaHei", Font.BOLD, Math.max(12, cell * 3 / 5)));
                            String s = String.valueOf(n);
                            FontMetrics fm = g.getFontMetrics();
                            int tx = x + (cell - fm.stringWidth(s)) / 2;
                            int ty = y + (cell - fm.getHeight()) / 2 + fm.getAscent();
                            g.drawString(s, tx, ty);
                        }
                    }
                }
            }
            g.setColor(new Color(0xb6, 0xc0, 0xd4, 0x88));
            g.setStroke(new BasicStroke(1f));
            for (int c = 0; c <= cols; c++) {
                int x = c * cell;
                g.drawLine(x, 0, x, h);
            }
            for (int r = 0; r <= rows; r++) {
                int y = r * cell;
                g.drawLine(0, y, w, y);
            }
            g.dispose();
            dirty = false;
            if (texture != null) {
                rt.uploadImageTo(texture.id, image);
            }
        }

        private static Color numberColor(int n) {
            switch (n) {
                case 1:
                    return new Color(0x2f, 0x64, 0xd8);
                case 2:
                    return new Color(0x1f, 0x8a, 0x4c);
                case 3:
                    return new Color(0xd9, 0x3b, 0x3b);
                case 4:
                    return new Color(0x52, 0x3a, 0xa8);
                case 5:
                    return new Color(0xa8, 0x3a, 0x2a);
                case 6:
                    return new Color(0x1a, 0x8a, 0x8a);
                case 7:
                    return new Color(0x22, 0x22, 0x22);
                default:
                    return new Color(0x66, 0x6e, 0x82);
            }
        }
    }

    /** 扫雷需要在 paint 里重新上传同一张纹理，这里暴露一个小入口。 */
    private void uploadImageTo(int id, BufferedImage image) {
        // 实际 GL 上下文只在 display() 内可用，这里先缓存，下一帧上传。
        Texture t = new Texture();
        t.id = id;
        t.w = image.getWidth();
        t.h = image.getHeight();
        pendingUploads.put(t, image);
    }
}
