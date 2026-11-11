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
import java.util.IdentityHashMap;
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
    /**
     * 脚本声明的「界面屏蔽区」：id → 屏幕逻辑像素矩形 {x, y, w, h}。
     *
     * <p><b>为什么需要</b>：点击派发顺序是「摇杆 → 输入框 → 脚本 → 可视化模块（扫雷棋盘）」，
     * 脚本拿到点击后<b>无法阻止</b>它继续传给棋盘。小棋盘时代无所谓 —— 棋盘完全落在上下两条
     * HUD 带之间，两者像素范围不相交。但 64×64（4096 格）在任何手机上都不可能「整盘可见又可读」
     * （720 逻辑像素宽 ÷ 64 格 = 每格 11px），要可读就必须放大并允许平移，于是棋盘必然伸到
     * HUD 底下，结果就是<b>点「新游戏」会顺带把底下的格子翻开（很可能直接踩雷）</b>。
     *
     * <p>用<b>持久 keyed 矩形</b>而不是「每帧清空再登记」：清空与登记之间存在窗口，UI 线程
     * 正好在那一刻派发点击就会漏防（表现为偶发误翻，最难查的那类 bug）。
     * 脚本每帧用同一个 id 覆盖同一块区域，值恒定，不存在空窗。
     *
     * <p>线程：AWT EDT / Android UI 线程读，GL 线程（脚本）写；ConcurrentHashMap，
     * 且数组整体替换（不原地改元素）。
     */
    final java.util.concurrent.ConcurrentHashMap<String, float[]> hudBlocks =
            new java.util.concurrent.ConcurrentHashMap<String, float[]>();

    /** 点落在任一屏蔽区内 → 这次点击归界面，不再传给棋盘。 */
    boolean inHudBlock(float sx, float sy) {
        if (hudBlocks.isEmpty()) {
            return false;
        }
        for (float[] r : hudBlocks.values()) {
            if (r != null && r.length >= 4
                    && sx >= r[0] && sx < r[0] + r[2]
                    && sy >= r[1] && sy < r[1] + r[3]) {
                return true;
            }
        }
        return false;
    }
    /**
     * 滚轮累积量（向上为正）。AWT 事件在 EDT 线程写、脚本在 GL 线程读，
     * 所以用 volatile；每帧读完由 {@link #takeWheel()} 清空（契约是「本帧增量」）。
     */
    private volatile int wheelAccum = 0;

    /** 取走本帧滚轮增量并清零（bwe.input.mouse.wheel 用）。 */
    int takeWheel() {
        int v = wheelAccum;
        wheelAccum = 0;
        return v;
    }

    /**
     * 物理像素 / 逻辑像素 的缩放倍率（高 DPI 屏通常 1.25 / 1.5 / 2）。
     *
     * <p><b>为什么脚本绘制层需要它</b>：投影用逻辑尺寸（1707）、glViewport 用物理尺寸（2560），
     * 所以 GL 会把所有绘制内容整体放大 {@code surfaceW/viewW} 倍。文字纹理若按「逻辑字号」
     * 生成再被拉伸 1.5 倍，配合 {@code GL_NEAREST} 过滤就会出现<b>锯齿/模糊</b>——
     * 用户看到的就是「HUD 文字发虚、位置像偏了」。
     *
     * <p>修法：文字纹理按 <b>逻辑字号 × 该倍率</b> 生成（超采样），
     * 绘制时仍按逻辑尺寸贴出去，于是 1 个纹理像素 ≈ 1 个物理像素，清晰。
     */
    float displayScale() {
        if (viewW <= 0 || surfaceW <= 0) {
            return 1f;
        }
        float sx = surfaceW / (float) viewW;
        // 只接受合理范围，避免异常窗口尺寸把纹理撑爆（超大纹理会让显存爆掉）
        if (!(sx >= 0.5f && sx <= 4f)) {
            return 1f;
        }
        return sx;
    }

    /**
     * 注入滚轮增量（向上为正）。AWT 监听器与自检都走这一个入口 ——
     * 自检能据此做<b>端到端</b>断言（注入 → 脚本读到非 0），
     * 比只断言 {@code typeof wheel === 'number'} 强：后者在「恒 0 的死实现」上照样 PASS。
     */
    void addWheel(int delta) {
        wheelAccum += delta;
    }
    private float time = 0f;
    private long lastNanos = 0L;
    int viewW = 1280;
    int viewH = 720;
    /** 相机跟随模式：玩家挂了 fx.cameraFollow / show.camera 时为 true。 */
    private boolean cameraFollow = false;
    private boolean cameraClampToMap = true;
    /** true = 强制整图视角（离屏 --fit 用），忽略脚本相机与跟随 */
    private boolean cameraFitOverride = false;
    private float cameraSmooth = 0f;
    private float cameraLookAhead = 0f;

    private Actor player;
    Minesweeper minesweeper;
    /** 虚拟摇杆/按键（bwe.stick）：引擎内建模块，绘制在最上层并优先消费触摸。 */
    ScriptStick stick;
    /** 文本输入框（bwe.textinput）：点一下就能直接键入数字/文字，两端共用状态机。 */
    ScriptTextInput textInput;
    /**
     * 2D 光照系统（契约 {@code docs/_fragments/lighting-contract.md}）。
     *
     * <p><b>永不为 null</b>：没有 {@code scene.lighting} 的旧工程也会拿到一个
     * {@code isEnabled()==false} 的实例 —— 这样 {@code bwe.light.*} 的所有调用都安全
     * （返回 false / 缺省值），而渲染侧一根 quad 都不画、GL 状态一个字节都不动
     * （{@link Lighting#draw} 在未启用时<b>第一行</b>就 return）。
     *
     * <p>包内可见：{@code ScriptLight}（{@code bwe.light} 的注册方）直接读写它。
     */
    final Lighting lighting;
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
    /** 当前触摸是否被虚拟摇杆占用（占用时 pointer 移动交给摇杆）。 */
    boolean stickTouchActive = false;
    /** 点击标记诊断：屏幕坐标 + 世界坐标 + 存活帧数（排查「点击与画面错位」用）。 */
    private int dbgMatrixProbe = 0;
    private FPSAnimator animator;
    private String lastTitle = "";
    private boolean loggedDisplayError = false;
    private boolean loggedViewport = false;

    // ---------------- 渲染打点（自检 / 离屏基准用，不属于脚本 API） ----------------
    /**
     * 本帧 / 上一帧的 GL 提交量。优化批量化时用它证明「提交次数真的降了」，
     * 而 {@link #debugDrawCallCount} 增量证明「绘制指令数没漏」。
     * 全是 int 自增，无额外分配，运行时开销可忽略。
     */
    int debugDrawCallCount = 0;
    int debugGlBeginCount = 0;
    int debugTextureBindCount = 0;
    int debugBatchCount = 0;
    int debugDrawCallsLastFrame = 0;
    int debugGlBeginsLastFrame = 0;

    // ---------------- 精灵批处理 ----------------
    /**
     * 合批：把「相邻、同纹理、未旋转」的精灵塞进同一个 glBegin(GL_QUADS)。
     *
     * <p><b>为什么是像素等价的</b>：GL 保证同一批 primitive 按顶点提交顺序光栅化，
     * 而每个 quad 内部仍然各自调 glColor4f 设 alpha —— 所以混合顺序、深度关系、
     * 每个 quad 的颜色都与「逐个 glBegin/glEnd」完全一致，只是省掉了重复的
     * glBindTexture / glEnable / glPushMatrix / glBegin。
     *
     * <p>三条硬边界（碰到就必须先 flush，否则顺序会变）：
     * <ul>
     *   <li>纹理 id 变了 → flush 后重新绑定</li>
     *   <li>精灵带旋转 → 走原来的矩阵路径（CPU 算旋转会引入浮点差异，宁可慢也不改像素）</li>
     *   <li>中间要画非精灵的东西（影子 / 血条 / 扫雷盘 / 脚本 HUD）→ 先 flush</li>
     * </ul>
     */
    private static final int BATCH_MAX_QUADS = 180;
    /**
     * 每个 quad 存 4 顶点 × 6 个 float：(u, v, x, y, r, g, b, a 打包) —— 实际布局见下。
     * 布局：[u0,v0,x0,y0][u1,v1,x1,y1][u2,v2,x2,y2][u3,v3,x3,y3] 各 4 个 float(u,v,x,y)，
     * 再加 4 个 float 的 rgba，共 20 个 float。
     *
     * <p>⚠ 颜色为什么要存进批里：固定管线里 {@code glColor4f} 是<b>状态</b>，不是顶点属性。
     * 如果在 glBegin 外面设颜色，它只决定「之后 begin 的那一批」的当前颜色，<b>不会</b>逐顶点记录。
     * 所以必须把 rgba 一起缓存，在 glBegin 内部、每个 quad 的顶点之前重新 glColor4f。
     */
    private final float[] batchData = new float[BATCH_MAX_QUADS * 20];
    private int batchTexture = -1;
    private int batchQuads = 0;
    int debugFlushCount = 0;

    /**
     * ⚠ 不做「状态只设一次」的缓存。
     * 原始 GL 路径（drawFallback / drawHp / drawEllipse / 扫雷盘 / 脚本 HUD）会随意
     * {@code glDisable(GL_TEXTURE_2D)}、改 glColor4f；一旦缓存「已就绪」标志，
     * 中途某条原始路径把纹理关掉之后，后续精灵就会画成<b>没有贴图的白块</b>
     * （这个 bug 真的出现过：整张地图变成白/黑两色）。
     * 现在每批只设一次（一帧 7 批），成本可忽略，正确性优先。
     */
    private void flushSpriteBatch(GL2 gl) {
        if (batchQuads == 0) {
            return;
        }
        debugFlushCount++;
        // ⚠ 只开纹理，<b>不要</b>开 GL_ALPHA_TEST。
        // 原实现（drawTexture）从不启用 alpha test，像素等价要求这一点必须保留：
        // 一旦开出 alphaFunc(0.2)，文字抗锯齿边缘（alpha<0.2 的像素）会被丢弃，
        // 截图上表现为「字体轮廓变了」——实测 302 个像素的差异就是这么来的。
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glBegin(GL2.GL_QUADS);
        int base = 0;
        for (int q = 0; q < batchQuads; q++) {
            // 每个 quad 独立设色：GL 保证同一批 primitive 按提交顺序光栅化，
            // 所以混合顺序与「逐个 glBegin/glEnd」完全一致。
            gl.glColor4f(batchData[base + 16], batchData[base + 17],
                    batchData[base + 18], batchData[base + 19]);
            for (int v = 0; v < 4; v++) {
                int i = base + v * 4;
                gl.glTexCoord2f(batchData[i], batchData[i + 1]);
                gl.glVertex2f(batchData[i + 2], batchData[i + 3]);
            }
            base += 20;
        }
        gl.glEnd();
        debugGlBeginCount++;
        batchQuads = 0;
    }

    /**
     * 往批里加一个轴对齐精灵；纹理不同就先 flush。
     * 调用方保证 rotation == 0。
     */
    private void batchSprite(GL2 gl, Texture tex, float cx, float cy, float w, float h,
                             float r, float g, float b, float a,
                             float u0, float v0, float u1, float v1) {
        if (tex == null || tex.id < 0) {
            return;
        }
        if (solidQuads > 0) {
            // 纯色批在前：先画它，保证顺序。
            flushSolidBatch(gl);
        }
        if (tex.id != batchTexture || batchQuads >= BATCH_MAX_QUADS) {
            flushSpriteBatch(gl);
            gl.glEnable(GL2.GL_TEXTURE_2D);
            gl.glBindTexture(GL2.GL_TEXTURE_2D, tex.id);
            debugTextureBindCount++;
            batchTexture = tex.id;
        }
        float l = cx - w / 2f;
        float rr = cx + w / 2f;
        float t = cy - h / 2f;
        float bb = cy + h / 2f;
        int o = batchQuads * 20;
        batchData[o] = u0;
        batchData[o + 1] = v0;
        batchData[o + 2] = l;
        batchData[o + 3] = t;
        batchData[o + 4] = u1;
        batchData[o + 5] = v0;
        batchData[o + 6] = rr;
        batchData[o + 7] = t;
        batchData[o + 8] = u1;
        batchData[o + 9] = v1;
        batchData[o + 10] = rr;
        batchData[o + 11] = bb;
        batchData[o + 12] = u0;
        batchData[o + 13] = v1;
        batchData[o + 14] = l;
        batchData[o + 15] = bb;
        batchData[o + 16] = r;
        batchData[o + 17] = g;
        batchData[o + 18] = b;
        batchData[o + 19] = a;
        batchQuads++;
        debugDrawCallCount++;
    }

    /**
     * 搬一个<b>未贴图</b>的纯色矩形进合批。
     *
     * <p>为什么单独一条路径：纯色块走「无纹理」状态、精灵走「有纹理」状态，
     * 两者不能混在同一批里。但<b>顺序必须严格保持</b>（谁先绘制谁在下层），
     * 所以规则很简单：两个批各存各的，谁要往批里加东西时，先把「另一类」的批冲掉。
     * 这样绘制顺序与逐个 glBegin 时完全一致。
     *
     * <p>顶点顺序与原 drawFallback 一致（左上→右上→右下→左下），像素等价。
     */
    private void batchSolid(GL2 gl, float x, float y, float w, float h,
                            float r, float g, float b, float a) {
        if (batchQuads > 0) {
            // 精灵批在前：先画它，保证「精灵在纯色块下面」的顺序不被打乱。
            flushSpriteBatch(gl);
            batchTexture = -1;
        }
        if (solidQuads >= BATCH_MAX_QUADS) {
            flushSolidBatch(gl);
        }
        int o = solidQuads * 20;
        solidData[o + 2] = x;
        solidData[o + 3] = y;
        solidData[o + 6] = x + w;
        solidData[o + 7] = y;
        solidData[o + 10] = x + w;
        solidData[o + 11] = y + h;
        solidData[o + 14] = x;
        solidData[o + 15] = y + h;
        solidData[o + 16] = r;
        solidData[o + 17] = g;
        solidData[o + 18] = b;
        solidData[o + 19] = a;
        solidQuads++;
        debugDrawCallCount++;
    }

    private void flushSolidBatch(GL2 gl) {
        if (solidQuads == 0) {
            return;
        }
        debugFlushCount++;
        gl.glDisable(GL2.GL_TEXTURE_2D);
        gl.glBegin(GL2.GL_QUADS);
        int base = 0;
        for (int q = 0; q < solidQuads; q++) {
            gl.glColor4f(solidData[base + 16], solidData[base + 17],
                    solidData[base + 18], solidData[base + 19]);
            gl.glVertex2f(solidData[base + 2], solidData[base + 3]);
            gl.glVertex2f(solidData[base + 6], solidData[base + 7]);
            gl.glVertex2f(solidData[base + 10], solidData[base + 11]);
            gl.glVertex2f(solidData[base + 14], solidData[base + 15]);
            base += 20;
        }
        gl.glEnd();
        debugGlBeginCount++;
        solidQuads = 0;
    }

    private final float[] solidData = new float[BATCH_MAX_QUADS * 20];
    private int solidQuads = 0;

    /** 批里有东西就先画掉，并把状态恢复成「什么纹理都没绑」（原始 GL 路径依赖这个前提）。 */
    private void flushSprites(GL2 gl) {
        flushSpriteBatch(gl);
        flushSolidBatch(gl);
        gl.glDisable(GL2.GL_TEXTURE_2D);
        gl.glColor4f(1f, 1f, 1f, 1f);
        batchTexture = -1;
    }

    /**
     * 光照层的「结束当前精灵批」入口（<b>包内可见</b>，契约 lighting-java-api.md §5）。
     *
     * <p>为什么需要它：{@link Lighting#draw} 要自己 {@code glBindTexture} 光照贴图并
     * {@code glDisable(GL_TEXTURE_2D)}，而批的纹理断言是「{@code batchTexture} 就是当前绑定的纹理」。
     * 如果批里还有残留精灵，绑定被改掉之后继续 {@code flushSpriteBatch} 就会拿着错的纹理画。
     *
     * <p>{@code flushSprites} 本身刻意保持 private（它带着「恢复干净状态」的语义，
     * 是绘制路径的内部约定，不该被外部随手调）；这里只暴露一个别名，语义完全一样。
     */
    void flushSpritesForLighting(GL2 gl) {
        flushSprites(gl);
    }



    /** 脚本侧设置染色（包内可见，ScriptApi 调）。null / 缺省 = 清除染色。 */
    void setActorTint(Actor a, float[] rgba) {
        if (a == null) {
            return;
        }
        if (rgba == null) {
            a.tint = null;
            a.tintR = 1f;
            a.tintG = 1f;
            a.tintB = 1f;
            a.tintA = 1f;
            a.tintAppliedVersion = a.tintVersion;
            return;
        }
        a.tint = rgba;
        a.tintVersion++;
    }

    static final class Frame {
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
    /**
     * 无数据构造：给单元测试用（摇杆/输入这类纯状态逻辑不需要加载工程）。
     *
     * <p>只初始化能安全初始化的字段；{@code data}/{@code scene} 保持 null，
     * 任何碰地图/渲染的代码在测试里都不该被调用。
     */
    static TopDownRuntime newStub() {
        try {
            return new TopDownRuntime();
        } catch (Exception e) {
            throw new IllegalStateException("无法创建测试桩", e);
        }
    }

    private TopDownRuntime() {
        this.bootFile = null;
        this.data = null;
        this.scene = null;
        this.assetRoot = null;
        this.stick = new ScriptStick(this);
        this.textInput = new ScriptTextInput();
        this.textInput.setKeyboardHost(visible -> { });
        // 测试桩同样要有一个「未启用」的光照实例（scene==null ⇒ isEnabled() 恒 false）。
        this.lighting = new Lighting(this);
    }

    TopDownRuntime(File bootFile) throws IOException {
        this.bootFile = bootFile;
        this.data = GameData.load(bootFile);
        this.assetRoot = GameData.resolveRoot(bootFile);
        if (data.scenes.isEmpty()) {
            // 只有 UI 场景的工程：运行时也得能起来（否则用户在编辑器里做的第一版界面
            // 一打包就黑屏崩溃）。用一张最小空地图兜底，界面层照常叠在上面。
            if (!data.uiScenes.isEmpty()) {
                BweLauncher.log(bootFile, "[UI] boot.json 没有世界场景，使用空地图兜底（界面临时层仍会绘制）");
                this.sceneName = data.uiScenes.get(0).name;
                GameData.RtScene emptyScene = new GameData.RtScene();
                emptyScene.width = 60;
                emptyScene.height = 40;
                emptyScene.tileSize = Math.max(1, data.tileSize);
                this.scene = emptyScene;
            } else {
                throw new IOException("boot.json 里没有场景");
            }
        } else {
            GameData.SceneRef ref = data.scenes.get(0);
            this.sceneName = ref.name;
            File sceneFile = new File(bootFile.getParentFile(), ref.file);
            this.scene = GameData.loadScene(sceneFile, data.tileSize);
        }
        // UI 场景：世界场景就绪后再载入（顺序无所谓，但失败必须只告警不中断 ——
        // 界面画不出来是「难看」，起不来是「不能用」，后者严重得多）。
        loadUiScenes();
        spawn();
        // 虚拟摇杆：默认不 mount（由脚本调 bwe.stick.mount() 启用）。
        this.stick = new ScriptStick(this);
        this.textInput = new ScriptTextInput();
        // 桌面端有物理键盘，软键盘后端是空实现（接口存在只为两端统一）。
        this.textInput.setKeyboardHost(visible -> { });
        // ★ 光照必须在 scripts 之前建：脚本 onSceneStart 里可能马上调 bwe.light.*
        //   （契约 lighting-java-api.md §5）。scene 已载入 ⇒ 能读到 lighting/lightmap 段。
        this.lighting = new Lighting(this);
        // 脚本要在场景对象就绪后启动（onStart 里可能马上要 find/spawn）。
        try {
            this.scripts = new ScriptEngine(this);
            this.scripts.sceneStart();
        } catch (Throwable t) {
            this.scripts = null;
            BweLauncher.log(bootFile, "[脚本] 引擎初始化失败: " + t);
        }
    }

    // ---------------- UI 场景 ----------------

    /**
     * 已载入的 UI 场景层（按 {@code boot.uiScenes[]} 顺序，后面的画在上面）。
     *
     * <p>每个层持有自己的 {@code RtScene}（沿用同一套对象模型）与 Actor 表。
     * 绘制时按「设计分辨率 → 视口等比 contain 居中」做一次缩放，所以 1280×720 的
     * 设计稿在任何窗口尺寸下都完整可见，相对位置比例不变。
     *
     * <p><b>为什么不复用 {@code actors}</b>：世界 Actor 会被玩法模块（物理/碰撞/寻路/
     * 相机/bwe.world.find）当成「活物」处理 —— 把界面文字塞进去就会跟着角色一起被推、
     * 被物理步进。分开一张表，世界逻辑一行都不用改。
     */
    private static final class UiLayer {
        final GameData.RtScene scene;
        final java.util.List<Actor> actors = new java.util.ArrayList<Actor>();

        UiLayer(GameData.RtScene scene) {
            this.scene = scene;
        }
    }

    private final java.util.List<UiLayer> uiLayers = new java.util.ArrayList<UiLayer>();

    /** 载入 boot.json 里列出的全部 UI 场景。失败只告警不中断（起不来比难看严重）。 */
    private void loadUiScenes() {
        uiLayers.clear();
        if (data == null || data.uiScenes.isEmpty()) {
            return;
        }
        for (GameData.UiSceneRef ref : data.uiScenes) {
            File f = new File(bootFile.getParentFile(), ref.file);
            try {
                GameData.RtScene s = GameData.loadScene(f, 1);
                if (!s.ui) {
                    s.ui = true;
                }
                UiLayer layer = new UiLayer(s);
                for (GameData.RtObject o : s.objects) {
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
                    layer.actors.add(a);
                }
                uiLayers.add(layer);
                int w = s.designW > 0 ? s.designW : s.width;
                int h = s.designH > 0 ? s.designH : s.height;
                BweLauncher.log(bootFile, "[UI] 已载入 UI 场景「" + ref.name + "」 "
                        + w + "×" + h + "，对象 " + s.objects.size() + " 个");
            } catch (Throwable t) {
                BweLauncher.log(bootFile, "[UI] UI 场景载入失败（跳过，不影响游戏本体）: " + ref.file + " → " + t);
            }
        }
    }

    /** UI 场景在设计分辨率里的宽高（导出时 width×tileSize 已等于设计像素，这里再做一次兜底）。 */
    private static float uiSceneW(GameData.RtScene s) {
        if (s.designW > 0) {
            return s.designW;
        }
        float v = s.width * (float) Math.max(1, s.tileSize);
        return v > 0f ? v : 1280f;
    }

    private static float uiSceneH(GameData.RtScene s) {
        if (s.designH > 0) {
            return s.designH;
        }
        float v = s.height * (float) Math.max(1, s.tileSize);
        return v > 0f ? v : 720f;
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
            public void keyTyped(KeyEvent e) {
                // 字符输入（真正的「敲了什么字」）：输入框激活时优先给它。
                // keyPressed 拿到的是键码（VK_0..VK_9），那是「按了哪个键」，
                // 要还原成数字字符得另外映射；keyTyped 直接给字符，更可靠。
                if (textInput != null && textInput.isActive()) {
                    textInput.type(e.getKeyChar());
                    e.consume();
                }
            }

            @Override
            public void keyPressed(KeyEvent e) {
                int code = e.getKeyCode();
                // 输入框激活时，Esc = 取消编辑，其它按键别触发游戏快捷键
                // （否则一边输入行数一边按 R 就把局面重置了）。
                if (textInput != null && textInput.isActive()) {
                    if (code == KeyEvent.VK_ESCAPE) {
                        textInput.cancelKey();
                        e.consume();
                        return;
                    }
                    if (code == KeyEvent.VK_ENTER) {
                        textInput.commitActive();
                        e.consume();
                        return;
                    }
                    // 其余按键继续往下走（退格由 keyTyped 处理）
                }
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
                if (scripts != null) {
                    scripts.mouseButton(mouseButtonIndex(e), true);
                }
                handleClick(e);
            }

            @Override
            public void mouseReleased(MouseEvent e) {
                // 有了抬起事件，bwe.input.down("Mouse0") 才是真正的「按住」（连射武器要靠它）。
                if (scripts != null) {
                    scripts.mouseButton(mouseButtonIndex(e), false);
                }
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
        // 滚轮：契约里 bwe.input.mouse.wheel 一直声明「本帧滚轮增量，向上为正」，
        // 但宿主从来没有 MouseWheelListener，该值恒为 0 —— 拿它做缩放/切武器的脚本
        // 会以为引擎坏了。这里接上真正的事件源。
        canvas.addMouseWheelListener(new java.awt.event.MouseWheelListener() {
            @Override
            public void mouseWheelMoved(java.awt.event.MouseWheelEvent e) {
                // AWT 向下滚是正数，而契约要求「向上为正」→ 取负。
                addWheel(-e.getWheelRotation());
            }
        });
        // 焦点：bwe.actions 的契约要求「失焦后所有动作立刻失效，且不产生 pressed」。
        // 没有这个监听器就会出现著名的手感 bug：按住 W 切出去，回来角色一直在走。
        canvas.addFocusListener(new java.awt.event.FocusListener() {
            @Override
            public void focusGained(java.awt.event.FocusEvent e) {
                onWindowFocus(true);
            }

            @Override
            public void focusLost(java.awt.event.FocusEvent e) {
                onWindowFocus(false);
            }
        });
        this.canvas = canvas;

        frame = new JFrame("BWE");
        frame.setDefaultCloseOperation(WindowConstants.EXIT_ON_CLOSE);
        frame.setLayout(new java.awt.BorderLayout());
        frame.setBackground(java.awt.Color.BLACK);
        frame.add(canvas, java.awt.BorderLayout.CENTER);
        // 窗口化时使用系统边框（标题栏 + 关闭/最小化按钮），F11 切全屏。
        // 不 dispose 重建，只做 setExtendedState / setBounds，保护 GL 上下文。
        frame.setUndecorated(false);
        frame.setResizable(true);
        // 默认以 1280×720 窗口打开（有边框），用户可按 F11 进全屏。
        frame.setBounds(centeredBounds(1280, 720));
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

    /** 全屏：最大化窗口（保留系统边框），不 dispose 重建以保护 GL 上下文。 */
    private void enterFullscreen() {
        try {
            frame.setExtendedState(java.awt.Frame.MAXIMIZED_BOTH);
            fullscreen = true;
        } catch (Throwable t) {
            BweLauncher.log(bootFile, "全屏失败，退回窗口模式: " + t);
            fullscreen = false;
        }
    }

    private void exitFullscreen() {
        fullscreen = false;
        frame.setExtendedState(java.awt.Frame.NORMAL);
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
        clickAt(e.getX(), e.getY(), e.getButton() == MouseEvent.BUTTON3);
    }

    /** AWT 按钮 → 脚本鼠标下标（0 左 / 1 中 / 2 右）。 */
    private static int mouseButtonIndex(MouseEvent e) {
        if (e.getButton() == MouseEvent.BUTTON3) {
            return 2;
        }
        if (e.getButton() == MouseEvent.BUTTON2) {
            return 1;
        }
        return 0;
    }

    /**
     * 平台无关的点击入口：<b>屏幕坐标 + 是否右键</b>。
     *
     * <p>桌面端（AWT MouseEvent）与 Android（触摸手势识别成左/右键）共用这一份逻辑 ——
     * 不复制判定流程，避免两端行为分叉。手机上没有右键，所以由宿主把「长按」映射成
     * {@code right=true}（扫雷的插旗就是右键语义）。
     *
     * <p>注释里的「鼠标是屏幕坐标、玩法判定是世界坐标」约束在这里统一处理：
     * 内部走视口逆变换（含 zoom / 居中偏移）。
     *
     * @param sx    组件/视口内屏幕坐标 X
     * @param sy    组件/视口内屏幕坐标 Y
     * @param right true = 右键（插旗/次要动作），false = 左键（主要动作）
     */
    /** 指针移动（触摸拖动时）：摇杆占用则更新轴值，否则只同步鼠标坐标。 */
    void pointerMoveAt(int sx, int sy) {
        mouseX = sx;
        mouseY = sy;
        if (stick != null && stickTouchActive) {
            stick.pointerMove(0, sx, sy);
        }
    }

    /** 指针抬起：释放摇杆占用。 */
    void pointerUpAt() {
        if (stick != null) {
            stick.releaseAll();
        }
        stickTouchActive = false;
    }

    void clickAt(int sx, int sy, boolean right) {
        int wx = Math.round(view.toWorldX(sx));
        int wy = Math.round(view.toWorldY(sy));
        mouseX = sx;
        mouseY = sy;
        // 虚拟摇杆优先：手指落在摇杆/按键上时，这次点击被它消费，不传给场景
        // （否则「点摇杆」会顺带把地图点一下）。
        if (stick != null && stick.pointerDown(0, sx, sy)) {
            stickTouchActive = true;
            return;
        }
        stickTouchActive = false;
        // 输入框优先于场景：点击框即激活并弹软键盘；点框外=提交。
        if (textInput != null && textInput.pointerDown(sx, sy, viewW, viewH)) {
            return;
        }
        // 脚本先拿点击（目前统一派发，不阻断可视化模块的行为）。
        if (scripts != null) {
            scripts.pointerDown(wx, wy, right, sx, sy);
        }
        // 脚本声明的界面区域吃掉这次点击：按钮优先，绝不让它顺带翻开底下的格子。
        // 位置必须在「脚本之后、棋盘之前」—— 脚本自己要用同一个点击命中按钮。
        if (inHudBlock(sx, sy)) {
            return;
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
            // 网格类模块：game.minesweeper 是「全开」组合，grid.* 是可选能力。
            // 任何对象只要挂 game.minesweeper 或任一 grid.*，都走这条路径建棋盘。
            GridModules.Bundle grid = GridModules.Bundle.of(a.o);
            // 只要挂了任一网格模块就建棋盘（grid.tile / grid.reveal / grid.flag 单独挂也成立，
            // 否则「只挂 grid.reveal」会因为没有 grid.board 而静默不生效）。
            if (grid.any()) {
                // 参数要从**所有**网格模块合并：拆分后 rows/cols 在 grid.board、
                // firstClickSafe 在 grid.reveal、rightClickFlag 在 grid.flag……
                // 只读某一个模块会丢掉其它模块的参数（那正是拆分后最容易漏的地方）。
                GameData.RtModule merged = GridModules.Bundle.mergedParams(a.o, "grid.board");
                if (minesweeper == null) {
                    minesweeper = new Minesweeper(this, a, merged, grid);
                    a.mine = minesweeper;
                    BweLauncher.log(bootFile, "网格模块: " + grid.describe()
                            + " 参数源=" + merged.def + " 对象=" + a.o.name);
                }
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
    /**
     * 强制「整图 contain」视角（离屏截图 / 检查像素画整体观感用）。
     *
     * <p>给 {@code OffscreenFrameDump --fit} 调。设一次 cameraFitOverride，
     * 之后每帧 {@link #applyCameraPolicy} 都走 fit 分支，脚本的相机控制也不生效
     * （否则玩家身上的 fx.cameraFollow 会把视角拉回 1:1）。
     */
    void forceFitWholeMap() {
        cameraFitOverride = true;
        scriptCameraControl = false;
        applyCameraPolicy(true);
    }

    private void applyCameraPolicy(boolean snap) {
        view.setViewport(viewW, viewH);
        view.setMap(mapWidth(), mapHeight());
        if (cameraFitOverride) {
            // --fit：忽略脚本相机与跟随，固定整图视角
            view.fitWholeMap();
            return;
        }
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
        // ★ 默认 layer 跟随场景主 layer（不是写死的 0）。
        //
        // 踩过的真实缺陷：排序键是 layer → z → y，layer 小的先画（会被后画的盖住）。
        // 城市场景对象全在 layer=4，而脚本 spawn 的 NPC/车辆默认 0
        // → 排在最前面先画、被整张底图盖住。
        // 表现是「日志说生成了 20 个行人，屏幕上一个都看不见」，
        // 而 drawCall 计数、可见性、尺寸、纹理 id 全部正常 —— 极难定位。
        o.layer = dominantSceneLayer();
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

    // ---------------- 延迟销毁 / 场景切换（帧末统一提交） ----------------

    /**
     * 本帧待销毁的实体（<b>延迟到帧末提交</b>）。
     *
     * <p>为什么必须延迟：{@code onUpdate} / 碰撞回调 / 定时器回调都在遍历实体或实体列表的时刻
     * 执行，直接 {@code actors.remove} 会让「正在遍历的列表被改动」，也可能让同一帧后续的
     * 子系统拿到已释放的对象。契约见 docs/open-world-architecture.md §3.3：
     * {@code destroy()} 只做<b>标记</b>，真正移除在帧末 {@code commitDestroy()}。
     *
     * <p>用 LinkedHashSet：既去重（重复 destroy 幂等），又保持销毁顺序稳定可复现。
     */
    private final java.util.LinkedHashSet<Actor> pendingDestroy = new java.util.LinkedHashSet<Actor>();

    /** 把一个实体排入销毁队列。已 dead 的重复请求直接忽略（幂等）。 */
    void requestDestroy(Actor a) {
        if (a == null || a.dead) {
            return;
        }
        a.dead = true; // 立刻不可交互/不可绘制，但仍在列表里直到帧末
        pendingDestroy.add(a);
    }

    /** 帧末提交：真正从各系统移除。顺序固定，保证可复现。 */
    void commitDestroy() {
        if (pendingDestroy.isEmpty()) {
            return;
        }
        java.util.List<Actor> batch = new ArrayList<Actor>(pendingDestroy);
        pendingDestroy.clear();
        for (int i = 0; i < batch.size(); i++) {
            Actor a = batch.get(i);
            if (scripts != null) {
                scripts.detachActor(a);
            }
            destroyActor(a);
        }
    }

    /** 有多少实体在等帧末销毁（测试/诊断用）。 */
    int pendingDestroyCount() {
        return pendingDestroy.size();
    }

    // ---------------- 场景切换（延迟提交） ----------------

    /** 待切换到的场景名（null = 没有待处理的切换）。 */
    private String pendingSceneName;
    /** 待切换场景的附加选项（透传给脚本的 onChanged 载荷）。 */
    private String pendingSceneReason = "";
    /** 场景代数：每次真正切换 +1，供缓存/引用失效判断。 */
    int sceneEpoch;

    /** 当前场景名（脚本 `bwe.scene.current()` 用）。 */
    String currentSceneName() {
        return sceneName;
    }

    /** 当前场景在 boot.json 里的下标（找不到 = -1）。 */
    int currentSceneIndex() {
        for (int i = 0; i < data.scenes.size(); i++) {
            if (data.scenes.get(i).name.equals(sceneName)) {
                return i;
            }
        }
        return -1;
    }

    /**
     * 请求切换场景（<b>不在调用栈里立即切换</b>）。
     *
     * <p>为什么延迟：切换要清空并重建全部实体、物理体、导航图、空间引用，
     * 如果在脚本 {@code onUpdate} 里直接做，正在执行的脚本 scope、正在遍历的列表全会失效。
     * 所以只登记请求，帧末 {@code commitSceneSwitch()} 统一执行。
     *
     * @return true = 请求已登记；false = 场景名不存在（不登记，当前场景不受影响）
     */
    boolean requestSceneSwitch(String name) {
        if (name == null || name.trim().isEmpty()) {
            return false;
        }
        String target = name.trim();
        for (int i = 0; i < data.scenes.size(); i++) {
            if (data.scenes.get(i).name.equals(target)) {
                pendingSceneName = target;
                return true;
            }
            // 允许用「不带后缀的文件名」或下标指代
            String file = data.scenes.get(i).file;
            if (file != null) {
                String noExt = file;
                int dot = noExt.lastIndexOf('.');
                if (dot > 0) {
                    noExt = noExt.substring(0, dot);
                }
                String base = noExt;
                int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
                if (slash >= 0) {
                    base = base.substring(slash + 1);
                }
                if (base.equals(target)) {
                    pendingSceneName = data.scenes.get(i).name;
                    return true;
                }
            }
        }
        return false;
    }

    /** 是否有待处理切换。 */
    boolean sceneSwitchPending() {
        return pendingSceneName != null;
    }

    /** 待切换的场景名（没有则 null）。 */
    String pendingSceneName() {
        return pendingSceneName;
    }

    /** 帧末执行挂起的场景切换。返回是否真的切了。 */
    boolean commitSceneSwitch() {
        if (pendingSceneName == null) {
            return false;
        }
        String target = pendingSceneName;
        pendingSceneName = null;
        GameData.SceneRef ref = null;
        for (int i = 0; i < data.scenes.size(); i++) {
            if (data.scenes.get(i).name.equals(target)) {
                ref = data.scenes.get(i);
                break;
            }
        }
        if (ref == null) {
            BweLauncher.log(bootFile, "[场景] 切换失败：找不到场景「" + target + "」");
            return false;
        }
        try {
            File sceneFile = new File(bootFile.getParentFile(), ref.file);
            GameData.RtScene next = GameData.loadScene(sceneFile, data.tileSize);
            // 先校验后提交：读盘失败就不动当前场景（契约 §1.1 的 bwe.scene.load 错误处理）
            scene = next;
            sceneName = ref.name;
            sceneEpoch++;
            // 先让脚本层清理上一场景的一切引用（作用域化的定时器/事件/prefab/空间/导航）
            if (scripts != null) {
                scripts.unloadScene();
            }
            pendingDestroy.clear();
            spawn();
            if (scripts != null) {
                scripts.buildWorldForScene();
                scripts.reloadScene();
            }
            // 纹理/显示列表与新场景尺寸相关，必须重算
            invalidateMapList();
            resetCamera();
            BweLauncher.log(bootFile, "[场景] 已切换到「" + sceneName + "」"
                    + "（epoch=" + sceneEpoch + "，" + actors.size() + " 个对象）");
            return true;
        } catch (Throwable t) {
            BweLauncher.log(bootFile, "[场景] 切换到「" + target + "」失败，保留当前场景: " + t);
            return false;
        }
    }

    /** 全部场景名（`bwe.scene.list()` 用）。 */
    java.util.List<GameData.SceneRef> sceneRefs() {
        return data.scenes;
    }

    /**
     * 场景对象里出现次数最多的 layer 值（脚本 spawn 的默认 layer）。
     *
     * <p>为什么需要它：排序键是 layer → z → y，layer 小的先画（会被后画的盖住）。
     * 脚本 {@code spawn()} 出来的实体如果 layer 默认 0，而场景对象都在 layer=4，
     * 新实体就会排到最前面、被整张底图盖住 —— 表现是「生成了但一个都看不见」，
     * 而 drawCall 计数完全正常（实测就是这样，极难定位）。
     *
     * <p>没有场景对象时返回 0（保持旧行为）。
     */
    int dominantSceneLayer() {
        java.util.Map<Integer, Integer> counts = new java.util.HashMap<Integer, Integer>();
        for (Actor a : new ArrayList<Actor>(actors)) {
            if (a == null || a.o == null) {
                continue;
            }
            Integer key = Integer.valueOf(a.o.layer);
            Integer c = counts.get(key);
            counts.put(key, Integer.valueOf(c == null ? 1 : c.intValue() + 1));
        }
        int best = 0;
        int bestCount = 0;
        for (java.util.Map.Entry<Integer, Integer> e : counts.entrySet()) {
            if (e.getValue().intValue() > bestCount) {
                bestCount = e.getValue().intValue();
                best = e.getKey().intValue();
            }
        }
        return best;
    }

    /**
     * 窗口焦点变化。失焦时把所有按键状态清空，并通知 {@code bwe.actions}。
     *
     * <p>为什么要清 {@code keys[]}：AWT 在失焦时<b>不会</b>补发 keyReleased，
     * 于是"按住 W 切出去"会让 keys[VK_W] 永远为 true。这条是真实手感 bug，必须治。
     */
    void onWindowFocus(boolean focused) {
        if (!focused) {
            for (int i = 0; i < keys.length; i++) {
                keys[i] = false;
            }
            if (scripts != null) {
                scripts.releaseMouseButtons();
            }
            if (ScriptActions.LAST != null) {
                ScriptActions.LAST.onFocusLost();
            }
        } else {
            if (ScriptActions.LAST != null) {
                ScriptActions.LAST.onFocusGained();
            }
        }
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
                Texture tex = textureForFile(f);
                if (tex == null) {
                    continue;
                }
                a.textures.add(tex);
                a.frames.add(new Frame(tex, 0f, 0f, 1f, 1f));
                if (a.texW == 0) {
                    a.texW = tex.w;
                    a.texH = tex.h;
                }
            }
            return;
        }

        Texture tex = textureForFile(new File(assetRoot, a.asset.path));
        if (tex == null) {
            return;
        }
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

    /**
     * 按<b>文件路径</b>共享纹理：同一张图无论被多少个对象引用，显存里只有一份。
     *
     * <p>这是本轮最大的性能修复。改动前每个 Actor 都走
     * {@code readImage → textureFromImage}，等于「同一张墙纸被 151 个对象各上传一次」：
     * 151 份相同的 64×64 RGBA = 2.5MB 显存，而且每个对象的 {@code tex.id} 都不同，
     * 于是<b>合批永远无法触发</b>（相邻精灵纹理 id 全不一样）。共享之后 151 面墙
     * 变成一个纹理 + 一次 glBindTexture。
     *
     * <p>BMP 缓存（{@link #imageCache}）仍保留：必要时可以回退「每对象独立纹理」的老行为。
     */
    private Texture textureForFile(File f) {
        if (f == null || !f.isFile()) {
            return null;
        }
        String key = f.getAbsolutePath();
        Texture cached = textureCache.get(key);
        if (cached != null) {
            return cached;
        }
        BufferedImage img = readImage(f);
        if (img == null) {
            return null;
        }
        Texture t = textureFromImage(img);
        textureCache.put(key, t);
        return t;
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

    /** 每个已上传纹理的<b>源位图</b>（GL 上下文重建时要拿它重新上传）。 */
    private final Map<Texture, BufferedImage> textureSources = new IdentityHashMap<>();

    /**
     * <b>GL 上下文重建后，在新上下文里重建所有 GPU 资源。</b>
     *
     * <p><b>为什么必须有这个方法（「偶发黑屏」的根因）</b>：纹理 id、显示列表 id 都隶属于
     * <b>某一个 GL 上下文</b>。Android 上上下文会因切后台 / 内存压力 / 旋转 / 驱动重置
     * 而丢失并重建，重建后旧 id 全部失效 —— 但引擎侧仍持有它们并继续 {@code glBindTexture}，
     * 结果就是<b>静默黑屏</b>：不报错、不崩溃、只是不显示。
     *
     * <p>做法是让所有 GPU 资源「重新申请」：
     * <ul>
     *   <li>每个已上传纹理的 id 置回 -1，并把<b>源位图</b>重新放进 {@link #pendingUploads}，
     *       这样下次 {@link #uploadTextures} 会重新 {@code glGenTextures} 并上传像素；</li>
     *   <li>丢弃显示列表 id（地图合批缓存），下次按需重建；</li>
     *   <li>清掉文字纹理缓存（同样全是旧上下文的 id）；</li>
     *   <li>让玩法模块（扫雷棋盘）把自绘纹理标脏、整块重画。</li>
     * </ul>
     *
     * <p>本方法<b>不改任何 CPU 侧状态</b>（棋盘进度、脚本、对象位置），所以玩家进度不会丢。
     */
    void rebuildGpuResources() {
        // ① 待删队列里的纹理属于旧上下文，新上下文里 delete 它们毫无意义
        //    （id 可能恰好被新上下文复用成别人的纹理 → 删掉别人的画）。
        //    直接丢弃登记，别让 flushPendingDeletes 在新上下文里乱删。
        pendingDeletes.clear();

        // ② <b>先</b>让玩法模块丢弃自绘纹理，并把那张纹理从「待重建」名单里摘掉。
        //
        // ⚠ 顺序很关键：早先写成「先重新排队所有纹理、再让模块丢引用」。
        // 模块把引用丢了、下一帧自己 new 一张新的 —— 而旧的已经在队列里，
        // 会被照常上传，变成一张谁都不画、也没人删的 GPU 纹理（每次切窗口泄漏一张）。
        // 所以这里先丢弃、再按「仍在被引用」来重建。
        Texture orphanedBoard = null;
        if (minesweeper != null) {
            orphanedBoard = minesweeper.invalidateTexture();
        }

        // ③ 每个仍在使用的纹理：id 作废、源位图重新排队。
        for (Texture t : new ArrayList<>(uploadedTextures)) {
            if (t == orphanedBoard) {
                // 已被模块丢弃：不再重建（新纹理由模块自己申请），也从队列里清掉。
                pendingUploads.remove(t);
                continue;
            }
            BufferedImage src = textureSources.get(t);
            t.id = -1;
            if (src != null) {
                pendingUploads.put(t, src);
            }
        }
        uploadedTextures.clear();
        textureSources.clear();

        // ③ 按文件路径共享纹理的 {@code textureCache}：<b>不能清空</b>。
        //    它缓存的是 Texture 对象本身，而这些对象已经在第 ② 步重新排进 pendingUploads；
        //    清空索引会把它们变成不可达对象，下次 textureForFile 重新 readImage + new Texture，
        //    旧对象就永远卡在 pendingUploads 里（显存与位图两头泄漏）。
        //    保留索引后，下次取到的是同一个「id=-1、已排队」的对象，uploadTextures 会重新
        //    glGenTextures 并上传。

        // ④ 显示列表属于旧上下文
        mapListId = 0;
        mapListW = 0;
        mapListH = 0;
        mapListTile = 0;

        // ⑤ 文字纹理缓存全是旧 id（缓存在 ScriptRender 里，不在 ScriptEngine 上）
        if (scripts != null && scripts.render != null) {
            scripts.render.clearTextTextures();
        }

        // ⑥ 光照贴图：id 属于旧上下文，本类只复位「已解析/已上传」的假定；
        //    真正的重新上传仍由上面的 pendingUploads 重排机制负责（本类不自己 glGenTextures）。
        lighting.invalidateGpuResources();
    }

    /** 上传待处理纹理（包内可见：玩法模块自绘时也要触发上传）。 */
    /** 包内日志：玩法模块（Minesweeper/GridPainter）打诊断用，不要各自去碰 bootFile。 */
    void logLine(String message) {
        BweLauncher.log(bootFile, message);
    }

    void uploadTextures(GL2 gl) {
        // 先在当前 GL 上下文里删掉上一轮标记的纹理，再上传新的。
        flushPendingDeletes(gl);
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
            textureSources.put(t, img);
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
        // ⚠ 必须是 REPEAT 而不是 CLAMP：
        // 像素画瓦片（地面/墙/屋顶）的原生尺寸只有 32px，而一个 TILE 对象往往代表
        // 一整行道路（96 格 = 3072px）。用 CLAMP + UV 0..1 会把 32px 的纹理**拉伸**
        // 成 3072px 长条 —— 实测画面上整条道路只有 1 张放大的砖纹，完全看不出平铺。
        // REPEAT 之后 UV 可以大于 1（见 drawActor 里的 uvRepeat），纹理按格数重复。
        // 对非瓦片素材（角色/车辆/图标）UV 仍是 0..1，REPEAT 不产生任何副作用。
        gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_WRAP_S, GL2.GL_REPEAT);
        gl.glTexParameteri(GL2.GL_TEXTURE_2D, GL2.GL_TEXTURE_WRAP_T, GL2.GL_REPEAT);
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

    /**
     * 是否已经初始化过 GL 上下文。
     *
     * <p><b>为什么需要这个标志</b>：{@code init()} 在 JOGL 里<b>不只会被调一次</b> ——
     * 窗口最小化还原、切到别的窗口、显卡驱动重置、远程桌面接管，都会让 GL 上下文丢失，
     * JOGL 重建后<b>再次回调 {@code init()}</b>。
     *
     * <p>重建后的上下文里，之前 {@code glGenTextures} / {@code glGenLists} 拿到的 id
     * <b>全部无效</b>，但引擎仍持有它们并继续 bind —— 结果是<b>静默黑屏</b>
     * （不报错、不崩溃、就是不显示）。这正是「切一下窗口就黑屏」的根因。
     *
     * <p>所以第二次及以后的 {@code init()} 必须先把所有 GPU 资源重新申请一遍
     * （见 {@link #rebuildGpuResources()}），而不能只设状态了事。
     */
    private boolean glInitialized;

    /**
     * 当前 GL 上下文的状态初始化（混合、纹理环境、清屏色、显示列表失效）。
     *
     * <p>这些<b>全是「每个上下文独立」的状态</b>：新上下文里不会继承旧上下文的
     * {@code glEnable(GL_BLEND)}，忘了重设就会出现「纹理透明通道失效 → 整片黑/整片白」。
     * 因此上下文重建路径必须重跑本方法，不能只重建资源。
     */
    private void initGlState(GL2 gl) {
        gl.glEnable(GL2.GL_BLEND);
        gl.glBlendFunc(GL2.GL_SRC_ALPHA, GL2.GL_ONE_MINUS_SRC_ALPHA);
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glTexEnvi(GL2.GL_TEXTURE_ENV, GL2.GL_TEXTURE_ENV_MODE, GL2.GL_MODULATE);
        gl.glClearColor(0.055f, 0.067f, 0.1f, 1f);
        // 新的 GL 上下文里没有旧的显示列表：重置缓存，drawMap 会重新录制。
        invalidateMapList();
        // 保证窗口关闭 / 进程退出时 onSceneEnd 一定会派发。
        installSceneEndHook();
    }

    /**
     * 为<b>全新的 GL 上下文</b>重设「每个上下文独立」的 GL 状态（<b>安卓宿主专用入口</b>）。
     *
     * <p><b>为什么必须有这个入口</b>：安卓的上下文重建路径是
     * {@code BweAndroidGameView.onSurfaceCreated} → {@code AndroidRuntimeBridge.rebindGl}
     * + {@code rebuildGpuResources()}，它<b>不会</b>再调 {@link #init(GLAutoDrawable)} ——
     * {@code init()} 是 JOGL 的回调概念，安卓侧由 GLSurfaceView 直接把新 GL 句柄交给宿主。
     * 于是 {@link #initGlState} 在这条路径上<b>从未重跑</b>。
     *
     * <p><b>为什么这一定是黑屏</b>：{@code glEnable(GL_BLEND)} 是「每个上下文独立」的状态，
     * 新上下文不继承旧上下文的混合开关。混合关掉后 alpha 通道被忽略 ——
     * ARGB 纹理里所有 alpha=0 的像素（文字纹理的字外区域、棋盘位图的外框、
     * HUD 的透明底）都按<b>不透明黑</b>画出来，整屏就被这些黑块盖满。
     * 这正是玩家说的「切后台回来 / 输入法收起后就黑屏」：不报错、不崩溃、日志干净。
     *
     * <p>⚠ 与桌面端 {@link #init} 的第二次调用是<b>同一件事的两条分支</b>：
     * 修黑屏必须两边同时成立，只修桌面端会让安卓继续黑。
     */
    void resetGlStateForNewContext(GL2 gl) {
        if (gl == null) {
            return;
        }
        initGlState(gl);
    }

    /**
     * JOGL 的 GL 初始化回调。<b>同一进程里会被调用多次</b>（上下文丢失 → 重建）。
     *
     * <p>两次以下的语义完全不同：
     * <ul>
     *   <li><b>第一次</b>：全新上下文，只设状态、什么都不用重建；</li>
     *   <li><b>第二次及以后</b>：旧上下文已死，旧纹理/显示列表 id 全部失效 ——
     *       必须先重设状态（新上下文不继承 blend/清屏色），再把所有 GPU 资源
     *       重新申请（{@link #rebuildGpuResources()}），否则就是「切一下窗口黑屏」。</li>
     * </ul>
     *
     * <p>⚠ 不要以为「init 只会跑一次」：这正是上一版桌面端黑屏的成因 ——
     * 只设状态、不清资源，旧 id 继续 bind，画面静默变黑。
     */
    @Override
    public void init(GLAutoDrawable drawable) {
        GL2 gl = drawable.getGL().getGL2();
        initGlState(gl);
        if (glInitialized) {
            // 上下文重建：旧 id 全部作废，重建资源。
            BweLauncher.log(bootFile, "GL 上下文重建：重设状态并重建纹理/显示列表");
            rebuildGpuResources();
        }
        glInitialized = true;
    }

    /**
     * 场景结束派发（契约 §1.2 的 onSceneEnd）。
     *
     * <p>为什么需要这个显式入口：窗口用 {@code EXIT_ON_CLOSE}，点 X 会直接 {@code System.exit}，
     * <b>根本不会走 {@code dispose()}</b> —— 只挂在 dispose 上，onSceneEnd 永远不会派发
     * （实测确认：加了 onSceneEnd 的脚本在窗口关闭后日志里没有这一行）。
     * 所以这里同时挂 shutdown hook，保证「窗口关闭 / 进程退出 / Ctrl+C」都能派发一次。
     *
     * <p>幂等：{@link ScriptEngine#sceneEnd()} 内部有 sceneEnded 保护，重复调用无害。
     */
    private void installSceneEndHook() {
        if (sceneEndHookInstalled) {
            return;
        }
        sceneEndHookInstalled = true;
        try {
            Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (scripts != null) {
                            scripts.sceneEnd();
                        }
                    } catch (Throwable ignored) {
                    }
                }
            }, "bwe-scene-end"));
        } catch (Throwable ignored) {
        }
    }

    private boolean sceneEndHookInstalled = false;

    // ---------------- 光标（bwe.input.cursor 的宿主实现） ----------------

    private static final String TRANSPARENT_CURSOR_NAME = "bwe-blank-cursor";
    private boolean cursorVisible = true;

    /**
     * 真正把光标显示 / 隐藏。
     *
     * <p>之前 {@code ScriptApi} 里是 {@code -> null} 空实现（「记意图但不改系统光标」），
     * 而文档写着能显示/隐藏光标 —— 校验脚本 verify-apidocs 把它列为
     * 「文档承诺、代码不生效」。现在真的改 AWT 组件光标。
     *
     * <p>⚠ 「隐藏」用 1×1 全透明图实现：AWT 不允许 {@code setCursor(null)}，
     * 透明图是等价且跨平台的写法。canvas 还没建（headless / 构造期）时只记意图。
     */
    void setCursorVisible(boolean visible) {
        cursorVisible = visible;
        if (canvas == null) {
            return;
        }
        try {
            if (visible) {
                canvas.setCursor(java.awt.Cursor.getDefaultCursor());
            } else {
                java.awt.Toolkit tk = java.awt.Toolkit.getDefaultToolkit();
                java.awt.Dimension best = tk.getBestCursorSize(1, 1);
                int w = Math.max(1, best == null ? 1 : best.width);
                int h = Math.max(1, best == null ? 1 : best.height);
                java.awt.image.BufferedImage img = new java.awt.image.BufferedImage(
                        w, h, java.awt.image.BufferedImage.TYPE_INT_ARGB);
                canvas.setCursor(tk.createCustomCursor(img,
                        new java.awt.Point(0, 0), TRANSPARENT_CURSOR_NAME));
            }
        } catch (Throwable ignored) {
            // 某些平台不支持自定义光标：保持系统光标，不崩。
        }
    }

    /** 脚本读当前光标意图。 */
    boolean cursorVisible() {
        return cursorVisible;
    }

    @Override
    public void dispose(GLAutoDrawable drawable) {
        try {
            if (animator != null) {
                animator.stop();
            }
            // 契约 §1.2 承诺的 onSceneEnd：在运行时真正关闭时派发一次。
            if (scripts != null) {
                try {
                    scripts.sceneEnd();
                } catch (Throwable ignored) {
                }
            }
            GL2 gl = drawable.getGL().getGL2();
            for (Texture t : uploadedTextures) {
                int[] ids = {t.id};
                gl.glDeleteTextures(1, ids, 0);
            }
            if (mapListId != 0) {
                gl.glDeleteLists(mapListId, 1);
                mapListId = 0;
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void reshape(GLAutoDrawable drawable, int x, int y, int width, int height) {
        // ⚠ Windows 高 DPI（125%/150%）下：
        //   - GL 绘制表面（framebuffer）= 物理像素 = AWT 组件逻辑尺寸 × GraphicsConfiguration 缩放
        //   - AWT 组件尺寸 / 鼠标事件坐标 / 文字布局 = 逻辑像素
        // reshape 的 width/height 在「有 canvas」时只用于 headless（FBO）路径；窗口路径统一以
        // canvas.getWidth()/getHeight()（逻辑）+ getDefaultTransform().scale（物理）为准。
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
        applyGLViewportAndProjection(gl);
    }

    /**
     * 把「当前逻辑视口 + 物理 framebuffer」刷到 GL：glViewport 用<b>物理</b>像素（= 逻辑 × DPI 缩放），
     * 投影（glOrtho）用<b>逻辑</b>像素。
     *
     * <p>reshape 与 display 共用这份实现，保证任何时刻（窗口化、全屏、窗口拉伸、HiDPI、首帧建帧）
     * 都不出现「glViewport 比 framebuffer 大/小」——后者正是旧故障「画面只画了一部分 / 只显示左下角一块」的根因
     * （视口被钉死在旧尺寸上，内容只压进 framebuffer 的子矩形）。
     */
    private void applyGLViewportAndProjection(GL2 gl) {
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
     * 只设置物理 framebuffer 尺寸（glViewport 用），不改逻辑视口。
     *
     * <p><b>给 Android 宿主用</b>：桌面端 updateSurfaceSize 能从 canvas + GraphicsConfiguration
     * 自己推出「逻辑 / 物理」两套尺寸；Android 没有 canvas（canvas==null 分支会把两者设成同一个值），
     * 于是逻辑视口被错误地当成物理像素 —— 脚本 HUD 按逻辑像素设计的字号就会显得只有一半大。
     *
     * <p>Android 侧由桥接类显式区分：调用 {@code reshape(logicalW, logicalH)} 让逻辑视口等于
     * 「物理 / dpr」，再调本方法把物理尺寸补回去，{@code glViewport} 才能铺满整块屏幕。
     */
    void setSurfaceSize(int physicalW, int physicalH) {
        this.surfaceW = Math.max(1, physicalW);
        this.surfaceH = Math.max(1, physicalH);
    }

    /**
     * 重新把「逻辑视口 + 物理 framebuffer」刷到 GL。
     *
     * <p>Android 宿主先调 {@code reshape(逻辑宽, 逻辑高)}（让 viewW/viewH 正确），
     * 再调 {@link #setSurfaceSize} 补物理尺寸 —— 但 reshape 当时已经把 glViewport
     * 按<b>逻辑</b>尺寸下发过了，不重刷就会出现「画面只画在屏幕左下角一块」。
     *
     * @param gl 当前 GL 上下文
     */
    void refreshViewport(GL2 gl) {
        applyGLViewportAndProjection(gl);
    }

    /**
     * Android 专用 reshape：一次给出「逻辑视口 + 物理 framebuffer」，内部算完再下发。
     *
     * <p>为什么不复用 {@link #reshape}：桌面 reshape 依赖 canvas + GraphicsConfiguration
     * 自己推导两套尺寸；Android 没有 canvas，那条分支会把逻辑与物理设成同一个值。
     * 而「先 reshape 再补 setSurfaceSize」会让 glViewport 与 glOrtho 各被下发两次，
     * 第二次覆盖第一次的矩阵状态 —— 实测表现为整屏全黑。所以必须在一次调用里算对再下发。
     *
     * @param logicalW  逻辑视口宽（脚本 UI 的坐标系宽度）
     * @param logicalH  逻辑视口高
     * @param physicalW 物理 framebuffer 宽（glViewport 用）
     * @param physicalH 物理 framebuffer 高
     */
    void reshapeForAndroid(int logicalW, int logicalH, int physicalW, int physicalH, GL2 gl) {
        this.viewW = Math.max(1, logicalW);
        this.viewH = Math.max(1, logicalH);
        this.surfaceW = Math.max(1, physicalW);
        this.surfaceH = Math.max(1, physicalH);
        this.drawableW = this.viewW;
        this.drawableH = this.viewH;
        view.setViewport(viewW, viewH);
        view.setMap(mapWidth(), mapHeight());
        applyCameraPolicy(true);
        applyGLViewportAndProjection(gl);
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
            // 窗口化之后（窗口尺寸/DPI/全屏切换/首帧建帧），「画布实际尺寸 → 逻辑/物理」可能晚于 reshape 一次。
            // 所以 display 帧内也做一次幂等刷新：先把 canvas 实际尺寸刷进逻辑/物理两套尺寸，再把
            // viewport + 投影下发。杜绝「窗口化后 glViewport 仍按旧尺寸钉死」导致的「只显示左上/左下角一块」。
            if (canvas != null) {
                updateSurfaceSize(canvas.getWidth(), canvas.getHeight());
            }
            applyGLViewportAndProjection(gl);
            // 每帧自增，失效「本帧尺寸缓存」与「本帧排序缓存」之外的一次性缓存。
            frameStamp++;
            renderFrame(dt, gl);
        } catch (Throwable t) {
            if (!loggedDisplayError) {
                loggedDisplayError = true;
                BweLauncher.fail(bootFile, "游戏渲染失败", t);
            }
        }
    }

    /**
     * 窗口无关的帧渲染：逻辑更新 + GL 绘制 + 脚本 draw。桌面（reshape/display）与安卓
     * （GLSurfaceRenderer / JOGL Android）共用这份帧循环，只是谁在驱动谁。
     *
     * <p>⚠ <b>这里刻意每帧「不」下发 viewport/投影</b>。曾经加过一版
     * {@code if (canvas == null) applyGLViewportAndProjection(gl)}，实测是<b>回归</b>：
     * 安卓宿主每帧手里只有「当前 drawable 的 GL 句柄」，而
     * {@link #applyGLViewportAndProjection} 用的是引擎内部的 {@code surfaceW/surfaceH} ——
     * 这两者在尺寸切换的当口未必一致，每帧用旧值覆盖会把 {@code reshapeForAndroid}
     * 刚下发的正确视口冲掉。
     *
     * <p>实测（{@code AdjustResizeShot}，2750x1236 ↔ 2750x760 ↔ 2750x1236）：
     * <pre>
     *   去掉这条：恢复后 diffPixels=0、pureBlack=0      （与修复前一致）
     *   保留这条：恢复后 diffPixels=80564、pureBlack 4454→80636（HUD 三条带整片黑）
     * </pre>
     * 尺寸同步的职责归 {@code AndroidRuntimeBridge.resize()} → {@code reshapeForAndroid}，
     * 不归帧循环。不要为了「保险」再加回来 —— 它会制造比它预防的更严重的黑屏。
     */
    void renderFrame(float dt, GL2 gl) {
        gl.glClear(GL2.GL_COLOR_BUFFER_BIT);
        gl.glLoadIdentity();
        uploadTextures(gl);

        gl.glDisable(GL2.GL_TEXTURE_2D);
        // 唯一的视图变换：screen = (world - cam) * zoom + view/2
        view.applyGL(gl);

        drawMap(gl);
        drawActors(gl);

        // ★ 2D 光照层：世界画面之上、UI 场景层之下（契约 lighting-contract.md §6）。
        //
        // 为什么必须夹在这里：光照是「世界的一部分」（灯照在地面和角色上），
        // 如果画在 UI 场景之后，界面会被压暗/加光（菜单文字变成橙的）—— 那是错的。
        // 同时它必须在 drawActors 之后：先把所有世界精灵画完，再统一压暗 + 加光。
        // 未启用（旧工程）时 lighting.draw 直接 return，一个 GL 调用都不发 → 逐像素零回归。
        lighting.draw(gl);

        // ★ UI 场景层：世界画面之上、脚本 HUD 之下。
        //
        // 为什么夹在中间（而不是最上层）：脚本 HUD（bwe.draw.*）通常是「临时调试信息 / 数值」，
        // 用户希望它压在上面；而 UI 场景是「正式界面」，应当压在地图/角色之上，
        // 否则界面会被地图物件遮挡（这正是「把 UI 混在场景里编辑」最直接的后果）。
        // 虚拟摇杆仍然最后画，保证它永远能点到。
        drawUiScenes(gl);

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


        // 虚拟摇杆画在所有内容之上（包括脚本 HUD），保证不被遮挡。
        if (stick != null && stick.isMounted() && stick.isVisible()) {
            gl.glLoadIdentity();
            drawStick(gl);
            gl.glLoadIdentity();
        }

        gl.glFlush();
        dumpFrameOnce(gl);
    }

    // ---------------- 更新 ----------------

    /** 包内可见：桌面 display() 与安卓宿主共用这套更新管线（安卓在 GLSurfaceRenderer 里调它）。 */
    void update(float dt) {
        // 脚本先跑：这样 onUpdate 里改的位置/相机/可见性，本帧的模块与绘制都能立刻用上。
        if (scripts != null) {
            try {
                scripts.update(dt);
            } catch (Throwable t) {
                BweLauncher.log(bootFile, "[脚本] update 异常: " + t);
            }
        }
        // 防御：脚本里遍历时改 actors 的极端情况，模块更新用快照。
        // ⚠ 顺序保持原样（玩家先、模块后），不要因为"看起来更整齐"而调换 —— 那会改变手感。
        if (player != null && !player.dead) {
            updatePlayer(dt);
        }
        for (Actor a : new ArrayList<Actor>(actors)) {
            if (a == player || a.dead) {
                continue;
            }
            updateModules(a, dt);
        }
        updateCamera(dt);
        if (minesweeper != null) {
            minesweeper.update(dt);
        }
        // ⑥ 帧末延迟提交（顺序固定）：先销毁，再切换场景。
        // 这两步必须放在「逻辑全部跑完、渲染尚未开始」的位置。
        commitDestroy();
        commitSceneSwitch();
        // ⑦ 光照：场景光源收集 / 实体跟随 / 按 dynamicFps 节流重建动态贴图。
        //    必须放在 commitSceneSwitch() <b>之后</b>：切换场景后要先让新场景的 actors 就位，
        //    否则本帧收集到的还是上一场景的光源（新场景第一帧会少灯）。
        lighting.update(dt);
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

    /**
     * 地图底图 + 网格线。
     *
     * <p>网格线是纯静态几何（只依赖地图尺寸与 tileSize），但原来是每帧重新提交
     * {@code (w/ts + h/ts) * 2} 个顶点：40×30 格 @32px 就是 70 条线 = 140 个顶点/帧，
     * 而大地图（100×100 格）是 400 个顶点、每帧固定成本 —— 内容却一个像素都不会变。
     *
     * <p>所以编译成 OpenGL 显示列表：第一次录制，之后每帧只发一个 glCallList。
     * 显示列表属于 GL 2.1 固定管线，与现有立即模式代码完全兼容，
     * 且<b>输出像素逐位相同</b>（驱动存的就是同一串命令）。
     *
     * <p>失效条件：地图尺寸或 tileSize 变化 → 重建。GL 上下文重建时列表会失效，
     * {@link #init} 里重置、{@link #dispose} 里删除。
     */
    private int mapListId = 0;
    private float mapListW = -1f;
    private float mapListH = -1f;
    private int mapListTile = -1;

    private void drawMap(GL2 gl) {
        float mapW = mapWidth();
        float mapH = mapHeight();
        int ts = Math.max(8, scene.tileSize);
        if (mapListId == 0 || mapListW != mapW || mapListH != mapH || mapListTile != ts) {
            mapListId = buildMapList(gl, mapW, mapH, ts);
            mapListW = mapW;
            mapListH = mapH;
            mapListTile = ts;
        }
        // ⚠ 没有显示列表能力时（安卓 ES 1.x 适配层）**不能**走 glCallList 分支。
        //
        // GL2Compat.glGenLists 会返回一个「看起来有效」的 id（自增计数器），
        // 但 glNewList 只是把 listRecording 置真、glCallList 是彻头彻尾的空操作 ——
        // 也就是说 buildMapList 返回的 id 非 0，却从来没有任何东西被重放。
        // 结果：地面上那张底图（底色块 + 网格线）在安卓上**一次都没画出来**；
        // 扫雷棋盘是另一条纹理路径，所以只有「棋盘以外」的区域变黑 ——
        // 玩家看到的就是「整屏黑、只剩棋盘」。
        //
        // 修复方式不是「让适配层假装支持显示列表」，而是**问能力、走立即模式**：
        // 适配层已经提供了 supportsDisplayLists()，这里必须真的把它用上。
        if (mapListId != 0 && supportsDisplayLists(gl)) {
            gl.glCallList(mapListId);
            return;
        }
        drawMapImmediate(gl, mapW, mapH, ts);
    }

    /**
     * 当前 GL 后端<b>是否真的支持显示列表</b>。
     *
     * <p><b>为什么必须显式检测</b>：安卓的 {@code GL2Compat} 为了不改动一万多行运行时，
     * 提供了同名的 {@code glGenLists/glNewList/glCallList}，但实现是<b>空壳</b>：
     * <ul>
     *   <li>{@code glGenLists} 返回一个自增计数器（看起来完全合法、且非 0）；</li>
     *   <li>{@code glNewList/glEndList} 只翻转一个布尔标志，<b>不录制任何命令</b>；</li>
     *   <li>{@code glCallList} 是<b>空操作</b>。</li>
     * </ul>
     * 于是引擎按「有缓存 → 每帧 glCallList」的路径跑，而实际上<b>一个顶点都没提交</b> ——
     * 地图底图（地图外底色 + 地图底色 + 网格线）在安卓上从来没被画过。
     *
     * <p>这个缺陷一直在，但因为扫雷棋盘是<b>另一条</b>纹理路径（GridPainter 自绘 + 贴图），
     * 棋盘本身照常显示，所以首发能跑；只有在整屏被别的黑块盖住时才暴露成「整屏黑」。
     *
     * <p>检测方式：适配层自己声明了 {@code supportsDisplayLists()}，用反射问它。
     * 桌面 JOGL 的 {@code GL2} 没有这个方法 → 反射取不到 → 视为「支持」（桌面行为不变）。
     * 安卓拿到的 {@code javax.media.opengl.GL2} 同样没有这个方法，但它的实现对象
     * {@code GL2Compat} 有 —— 所以通过 {@code raw()} 之外再问一次实现层。
     */
    private boolean supportsDisplayLists(GL2 gl) {
        if (gl == null) {
            return false;
        }
        // ① 宿主的 GL 包装类自己暴露了能力查询（安卓 GL2 shim 的将来版本可能直接加）
        try {
            java.lang.reflect.Method m = gl.getClass().getMethod("supportsDisplayLists");
            Object r = m.invoke(gl);
            if (r instanceof Boolean) {
                return (Boolean) r;
            }
        } catch (Throwable ignored) {
        }
        // ② 安卓：javax.media.opengl.GL2 只是个转发壳，真正的实现在 GL2Compat 里。
        //    壳上有 raw()（返回 GL10），再顺着 impl 字段找到能力声明。
        try {
            java.lang.reflect.Field f = gl.getClass().getDeclaredField("impl");
            f.setAccessible(true);
            Object impl = f.get(gl);
            if (impl != null) {
                java.lang.reflect.Method m = impl.getClass().getMethod("supportsDisplayLists");
                Object r = m.invoke(impl);
                if (r instanceof Boolean) {
                    return (Boolean) r;
                }
            }
        } catch (Throwable ignored) {
        }
        // ③ 桌面的真 JOGL GL2：没有该能力查询方法 → 它是真支持显示列表的。
        return true;
    }

    /** 把地图底图录进显示列表，返回列表 id（失败返回 0，调用方回退到立即模式）。 */
    private int buildMapList(GL2 gl, float mapW, float mapH, int ts) {
        // 没有显示列表能力的后端（安卓 GL2Compat）**不要**申请 id：
        // 申请到的 id 既不会录制、也不会被重放，只会让 drawMap 误判「有缓存、可以 glCallList」。
        if (!supportsDisplayLists(gl)) {
            return 0;
        }
        int id = 0;
        try {
            id = gl.glGenLists(1);
            if (id == 0) {
                return 0;
            }
            gl.glNewList(id, GL2.GL_COMPILE);
            drawMapImmediate(gl, mapW, mapH, ts);
            gl.glEndList();
            return id;
        } catch (Throwable t) {
            if (id != 0) {
                try {
                    gl.glDeleteLists(id, 1);
                } catch (Throwable ignored) {
                }
            }
            return 0;
        }
    }

    /** 真正的地图绘制（也是显示列表的编译体，保证两条路径同一份代码）。 */
    private void drawMapImmediate(GL2 gl, float mapW, float mapH, int ts) {
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
        gl.glLineWidth(1f);
    }

    /** 地图尺寸变了要让显示列表失效（换场景 / 脚本改地图大小时）。 */
    void invalidateMapList() {
        mapListId = 0;
        mapListW = -1f;
        mapListH = -1f;
        mapListTile = -1;
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
                // ★ 同层同 z 时的次序：先按"是否地面瓦片"分组，再按纹理，最后按 y。
                //
                // 为什么：地面瓦片（tag=tile）是**平铺的地砖，不会互相遮挡**，
                // 它们的相对顺序对画面没有任何影响。但按 y 排序会让不同纹理的瓦片
                // 交错排列 → 合批被打断（实测 16 种纹理却要 27 次 glBegin）。
                // 把瓦片按「纹理 id」聚在一起，就能把几十块砖压成 1~2 次提交；
                // 真正需要 y 排序的是角色/车辆/建筑这类**会互相遮挡**的精灵。
                boolean tileA = isTileObject(a.o);
                boolean tileB = isTileObject(b.o);
                if (tileA != tileB) {
                    return tileA ? -1 : 1;   // 地面瓦片先画（垫底）
                }
                if (tileA) {
                    // 瓦片内部：按纹理分组（合批关键），纹理相同再按 y（稳定可复现）
                    int ta = a.asset != null && a.asset.id != null ? a.asset.id.hashCode() : 0;
                    int tb = b.asset != null && b.asset.id != null ? b.asset.id.hashCode() : 0;
                    if (ta != tb) {
                        return Integer.compare(ta, tb);
                    }
                }
                return Float.compare(a.y, b.y);
            }
        };
    }

    /** 对象是否是"地面瓦片"（tag=tile/ground，或名字以 tile- 开头）。 */
    private static boolean isTileObject(GameData.RtObject o) {
        if (o == null) {
            return false;
        }
        if (o.tags != null) {
            for (int i = 0; i < o.tags.size(); i++) {
                String t = o.tags.get(i);
                if ("tile".equalsIgnoreCase(t) || "ground".equalsIgnoreCase(t)) {
                    return true;
                }
            }
        }
        String name = o.name == null ? "" : o.name;
        return name.startsWith("tile-") || name.startsWith("tile ");
    }

    private void drawActors(GL2 gl) {
        List<Actor> sorted = sortedActors();
        ScriptSpatial sp = ScriptSpatial.LAST;
        boolean spatialActive = sp != null && sp.hasData();
        for (Actor a : sorted) {
            if (!a.o.visible || a.dead) {
                continue;
            }
            // ★ 楼层可见性：`bwe.spatial` 每帧解算出的 renderVisible 必须在这里生效。
            //
            // 之前这里完全不读空间状态 —— 结果：屋顶（普通 PROP 对象）永远照画，
            // 把整栋楼的室内和门口全遮住。全城截图实测：23 栋建筑全是灰屋顶，
            // 玩家/行人/血包在楼附近基本看不见，城市"看起来没做出来"。
            //
            // 只对「带建筑/屋顶 tag 的对象」生效：普通物件不受影响；
            // 没有空间数据的旧工程 spatialActive=false，完全不受影响。
            if (spatialActive && sp.isActorHidden(a)) {
                continue;
            }
            drawActor(gl, a);
        }
        // 帧末把最后一批精灵冲掉（否则残留到下一帧，混合顺序就错了）。
        flushSprites(gl);
    }

    /**
     * 自检专用：返回「本帧的绘制顺序」（从下往上）。
     *
     * <p>层级 bug 只有把顺序取出来断言才抓得住 —— 光看「对象还在、没崩」是看不出来的。
     * 实现走的就是真实绘制用的 {@link #sortedActors()}，所以断言的顺序 =
     * 玩家看到的遮挡顺序。
     *
     * @return 可见对象的 id 列表，下标 0 是<b>最先画</b>（最底层）
     */
    List<String> debugDrawOrder() {
        List<String> out = new ArrayList<String>();
        for (Actor a : sortedActors()) {
            if (a.dead || !a.o.visible) {
                continue;
            }
            out.add(a.o.id);
        }
        return out;
    }

    /**
     * 排序用的复用缓冲。原来每帧 {@code new ArrayList<>(actors)} + {@code Collections.sort}：
     * 200 实体就是每帧 200 次装箱 + 一个 200 元素数组，60fps 下等于每秒 12000 次分配。
     * 这里改成字段复用，只在「排序键真的变了」时才重排。
     *
     * <p><b>⚠ 血泪教训（这个缓存第一版是错的，导致 UI 层级错乱）</b>：
     * 第一版用「可见对象数量 + 所有 y 的<b>总和</b>」当变化判据。它有两个致命漏洞：
     * <ol>
     *   <li><b>脚本改 z 但不动 y</b>（{@code e.z = 5}，或用「上移一层/置顶」菜单）→
     *       y 总和不变 ⇒ 不重排 ⇒ <b>画面层级不变</b>。用户看到的是「点了置顶没反应」。</li>
     *   <li><b>两个对象互换 y</b>（A.y=100,B.y=200 → A.y=200,B.y=100）→ 总和不变 ⇒
     *       不重排 ⇒ 遮挡关系错乱。</li>
     * </ol>
     * 而真正的排序键是 <b>layer → z → y</b> 三元组（见 {@link #actorOrder()}），
     * 任何一个变了都必须重排。
     *
     * <p>现在的判据：把「每个可见对象的 (layer,z,y)」按 actors 的<b>存储顺序</b>逐项比较，
     * 任一不同就重排。比较是 O(n) 的纯数值比较（比每帧 sort 的 O(n log n) + 分配便宜得多），
     * 且<b>不会漏判、不会撞车</b>。对象存储顺序本身变了也算变化（用 id 引用逐一比对覆盖到）。
     */
    private final Comparator<Actor> actorComparator = actorOrder();
    private List<Actor> actorSortBuf = new ArrayList<Actor>();
    private final List<Actor> visibleSnapshot = new ArrayList<Actor>();
    /** 上一帧的排序键快照：每个可见对象存 3 个 float（layer,z,y），按 actors 存储顺序。 */
    private float[] sortKeyBuf = new float[0];
    private int sortKeyCount = -1;
    /** 上一帧可见对象的引用序列，用来发现「存储顺序/成员」变化（数量相同但换了对象）。 */
    private Actor[] sortRefBuf = new Actor[0];

    private List<Actor> sortedActors() {
        visibleSnapshot.clear();
        int need = 0;
        for (int i = 0; i < actors.size(); i++) {
            Actor a = actors.get(i);
            if (a.dead || !a.o.visible) {
                // 不可见的也进不了绘制，但「可见性」本身是绘制键的一部分 → 记下来参与判据
                continue;
            }
            visibleSnapshot.add(a);
            need += 3;
        }
        int n = visibleSnapshot.size();

        boolean dirty = n != sortKeyCount;
        if (!dirty) {
            for (int i = 0; i < n; i++) {
                Actor a = visibleSnapshot.get(i);
                if (sortRefBuf[i] != a) {
                    dirty = true;
                    break;
                }
                int o = i * 3;
                if (sortKeyBuf[o] != (float) a.o.layer
                        || sortKeyBuf[o + 1] != (float) a.o.z
                        || sortKeyBuf[o + 2] != a.y) {
                    dirty = true;
                    break;
                }
            }
        }

        if (dirty) {
            if (sortKeyBuf.length < need) {
                sortKeyBuf = new float[Math.max(need, 64)];
            }
            if (sortRefBuf.length < n) {
                sortRefBuf = new Actor[Math.max(n, 32)];
            }
            for (int i = 0; i < n; i++) {
                Actor a = visibleSnapshot.get(i);
                int o = i * 3;
                sortKeyBuf[o] = (float) a.o.layer;
                sortKeyBuf[o + 1] = (float) a.o.z;
                sortKeyBuf[o + 2] = a.y;
                sortRefBuf[i] = a;
            }
            sortKeyCount = n;
            actorSortBuf.clear();
            actorSortBuf.addAll(visibleSnapshot);
            Collections.sort(actorSortBuf, actorComparator);
            return actorSortBuf;
        }
        return actorSortBuf;
    }

    private void drawActor(GL2 gl, Actor a) {
        // ★ label 对象：文字由 props 决定（text / textSize / textColor / textAlign），
        //   位置就是对象的 x/y。这样 HUD 文案在编辑器里可拖动、可直接改字，
        //   而不是必须改脚本。
        if (a.o.tags != null && a.o.tags.contains("label")) {
            flushSprites(gl);
            drawLabel(gl, a, 1f);
            return;
        }
        float alpha = 1f;
        if (data.has(a.o, "look.blink") || data.has(a.o, "render.blink")) {
            alpha = 0.3f + 0.7f * Math.abs((float) Math.sin(time * 6f));
        }

        if (data.has(a.o, "look.shadow") || data.has(a.o, "render.shadow")) {
            // 影子走 GL_TRIANGLE_FAN（原始调用）→ 先把精灵批冲掉，否则会在 glBegin 里嵌套 glBegin。
            flushSprites(gl);
            float hw = drawWidth(a) * 0.42f;
            float hh = Math.max(6f, drawHeight(a) * 0.12f);
            drawEllipse(gl, a.x, a.y + drawHeight(a) * 0.42f, hw, hh, 0.22f * alpha);
        }

        if (a.dress != null) {
            flushSprites(gl);
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
            // 挂了网格模块的对象（没素材）**不要**在这里额外画棋盘：
            // drawFallback 内部已经会画（它在纯色块批完之后调 a.mine.draw(gl)）。
            // 早先在这里又加了一次 → 棋盘被画两遍：第一遍小、第二遍大，
            // 重叠后看起来像「格子被放大 / 位置错位」。
            // ⚠ 这里原来先 flushSprites 再画 fallback。那是错的：3600 个 TILE 就是
            // 3600 次「冲批 + 重新开批」，等于把批处理的收益全扔了（实测 glBegin 3575/帧）。
            // 纯色块有自己的批，两条批交替时各存各的、按需 flush，顺序天然正确。
            drawFallback(gl, a, alpha);
            return;
        }

        float w = drawWidth(a);
        float h = drawHeight(a);
        // 染色：只有设置了才走拆包，未染色实例完全零额外开销。
        float tr = 1f;
        float tg = 1f;
        float tb = 1f;
        float ta = alpha;
        if (a.tint != null) {
            if (a.tintAppliedVersion != a.tintVersion) {
                float[] t = a.tint;
                a.tintR = t.length > 0 ? t[0] : 1f;
                a.tintG = t.length > 1 ? t[1] : 1f;
                a.tintB = t.length > 2 ? t[2] : 1f;
                a.tintA = t.length > 3 ? t[3] : 1f;
                a.tintAppliedVersion = a.tintVersion;
            }
            tr = a.tintR;
            tg = a.tintG;
            tb = a.tintB;
            ta = a.tintA * alpha;
        }
        // ★ 平铺 UV：瓦片类素材（地面/墙/屋顶）原生只有 32px，
        // 而对象可能代表一整行（w=3072px）。UV 需要重复 ceil(w / 素材宽) 次，
        // 配合 GL_REPEAT 才能看到真实的砖纹平铺，而不是一张被拉长的图。
        //
        // 判定条件（刻意保守，避免影响角色/车辆）：
        //   1) 只对 IMAGE 素材（图集有自己的 cell 逻辑，不能重复）；
        //   2) 世界尺寸 >= 素材尺寸的 1.5 倍（纯粹"放大的图标"不该平铺）；
        //   3) 对象带 tag "tile" 或名字以 tile- 开头（即生成器明确标为瓦片）。
        // 满足才把 u1/v1 放大成整数倍。
        float u0 = frame.u0, v0 = frame.v0, u1 = frame.u1, v1 = frame.v1;
        if (isTileActor(a) && !a.frames.isEmpty()) {
            float texW = Math.max(1f, a.texW);
            float texH = Math.max(1f, a.texH);
            float rx = w / texW;
            float ry = h / texH;
            // 只在「明显比一个格子大」时才平铺；小数部分保留（避免边缘被切半块）
            if (rx >= 2f) u1 = u0 + (float) Math.ceil(rx);
            if (ry >= 2f) v1 = v0 + (float) Math.ceil(ry);
        }
        if (a.o.rotation == 0f) {
            // 轴对齐 → 进合批（同纹理相邻的会并成一个 glBegin）
            batchSprite(gl, tex, a.x, a.y, w, h, tr, tg, tb, ta, u0, v0, u1, v1);
        } else {
            // 旋转精灵走原路径：CPU 算旋转会造成浮点差异，宁可少优化也不动像素。
            flushSpriteBatch(gl);
            drawTexture(gl, tex, a.x, a.y, w, h, a.o.rotation, alpha,
                    u0, v0, u1, v1, tr, tg, tb, a.tint == null ? 1f : a.tintA);
            debugDrawCallCount++;
        }

        // 扫雷棋盘 / 血条要盖在这个精灵之上：先把批画掉。
        if (a.mine != null || (a.hpMax > 0f && a.hp < a.hpMax && a.hp > 0f)) {
            flushSprites(gl);
        }
        // 扫雷棋盘：面板贴图之上再画可玩格子。
        if (a.mine != null) {
            a.mine.draw(gl);
        }
        drawHp(gl, a, alpha);
    }


    /**
     * ★ UI 场景层绘制：世界画面之上、脚本 HUD 之下。
     *
     * <p>坐标契约：UI 场景的 (x, y) 是**设计分辨率像素**（1280×720 里的坐标）。
     * 这里用一次「等比 contain + 居中」的变换把它映射到当前逻辑视口：
     * <pre>
     *   z  = min(viewW / designW, viewH / designH)
     *   ox = (viewW - designW * z) / 2
     *   oy = (viewH - designH * z) / 2
     * </pre>
     * 与 {@link Viewport#fitWholeMap()} 的 contain 语义一致 —— 所以「编辑器里 WYSIWYG」，
     * 窗口怎么缩放，界面的相对位置都不变、四边可能留底色（不会被裁掉）。
     *
     * <p>绘制顺序与世界场景同一套规则：layer → z → y（与编辑器 orderObjects 一致）。
     * 文字对象（tags 含 label）走 {@link #drawLabel} 的真实字体路径，
     * 其余走精灵 / 纯色块，全部复用世界绘制链路，避免「界面和场景两套画法各说各话」。
     */
    private void drawUiScenes(GL2 gl) {
        if (uiLayers.isEmpty() || viewW <= 0 || viewH <= 0) {
            return;
        }
        for (UiLayer layer : uiLayers) {
            GameData.RtScene s = layer.scene;
            float dw = uiSceneW(s);
            float dh = uiSceneH(s);
            if (!(dw > 0f) || !(dh > 0f)) {
                continue;
            }
            float z = Math.min(viewW / dw, viewH / dh);
            if (!(z > 0f)) {
                continue;
            }
            float ox = (viewW - dw * z) / 2f;
            float oy = (viewH - dh * z) / 2f;

            // 先把世界批冲掉：世界精灵带着世界变换矩阵提交，混在 UI 变换里会画错位置。
            flushSprites(gl);

            gl.glLoadIdentity();
            gl.glTranslatef(ox, oy, 0f);
            gl.glScalef(z, z, 1f);

            // 排序：layer → z → y（与编辑器 orderObjects 同一规则）
            java.util.List<Actor> ordered = new java.util.ArrayList<Actor>(layer.actors);
            Collections.sort(ordered, actorOrder());
            for (Actor a : ordered) {
                if (a.o != null && !a.o.visible) {
                    continue;
                }
                if (a.o != null && a.o.tags != null && a.o.tags.contains("label")) {
                    flushSprites(gl);
                    drawLabel(gl, a, 1f, z * displayScale());
                    continue;
                }
                drawActor(gl, a);
            }
            flushSprites(gl);
        }
        gl.glLoadIdentity();
        // 恢复「没有绑纹理、白色」的干净状态：后续脚本 HUD 依赖这个前提。
        gl.glDisable(GL2.GL_TEXTURE_2D);
        gl.glColor4f(1f, 1f, 1f, 1f);
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
        return sizeOfCached(a, true);
    }

    float drawHeight(Actor a) {
        return sizeOfCached(a, false);
    }

    /**
     * 尺寸计算带缓存。
     *
     * <p>{@code sizeOf()} 每对象每帧会被问 5~7 次（drawActor 一次、drawHp 两次、影子两次…），
     * 每次都要 HashMap 查 props + parseFloat。缓存把这部分砍掉一个量级。
     *
     * <p>⚠ <b>缓存必须按「输入」校验，不能只按帧号</b>。脚本可以在同一帧内
     * {@code e.setSize(...)} / {@code e.scaleX = ...} / {@code e.setProp("w", ...)}，
     * 只按帧号会读到本帧旧值 —— 这个 bug 真的出现过（ScriptSelfTest 的
     * {@code ent.size2=48x64} 断言失败，绘制尺寸仍是 32x32）。
     */
    private float sizeOfCached(Actor a, boolean horizontal) {
        GameData.RtObject o = a.o;
        boolean halfBranch = o.halfW > 0f || o.halfH > 0f;
        float propsW = halfBranch ? 0f : propNum(o, "w");
        float propsH = halfBranch ? 0f : propNum(o, "h");
        if (a.sizeStamp < 0
                || a.sigHalfW != o.halfW
                || a.sigHalfH != o.halfH
                || a.sigScaleX != o.scaleX
                || a.sigScaleY != o.scaleY
                || a.sigTexW != a.texW
                || a.sigTexH != a.texH
                || a.sigAsset != a.asset
                || a.sigPropsW != propsW
                || a.sigPropsH != propsH) {
            a.cachedW = sizeOf(a, true);
            a.cachedH = sizeOf(a, false);
            a.sigHalfW = o.halfW;
            a.sigHalfH = o.halfH;
            a.sigScaleX = o.scaleX;
            a.sigScaleY = o.scaleY;
            a.sigTexW = a.texW;
            a.sigTexH = a.texH;
            a.sigAsset = a.asset;
            a.sigPropsW = propsW;
            a.sigPropsH = propsH;
            a.sizeStamp = 0;
        }
        return horizontal ? a.cachedW : a.cachedH;
    }

    /** 强制让尺寸缓存失效（按输入校验后已非必需，保留作保险）。 */
    void invalidateSize(Actor a) {
        if (a != null) {
            a.sizeStamp = -1;
        }
    }

    /** 帧号戳：每帧 display 开头自增（保留给其它一次性缓存用）。 */
    int frameStamp = 0;

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

    // 未贴图色块的常量颜色（**预分配**，避免每帧每对象 new Color）。
    // ⚠ 必须用 Color 构造而不是直接写 0.45f：原实现是
    //   new Color(0.45f,...) → getRed()=round(0.45*255)=115 → 115/255f = 0.4509804
    // 直接写 0.45f 会差 1 个色阶（实测逐像素对比抓到 maxDelta=1）。
    private static final Color FALLBACK_ZONE = new Color(0.35f, 0.55f, 0.95f, 0.25f);
    private static final Color FALLBACK_SPAWN = new Color(0.35f, 0.9f, 0.55f, 0.55f);
    private static final Color FALLBACK_LIGHT = new Color(1f, 0.85f, 0.35f, 0.35f);
    private static final Color FALLBACK_ACTOR = new Color(0.3f, 0.62f, 1f, 1f);
    private static final Color FALLBACK_PROP = new Color(0.45f, 0.5f, 0.62f, 1f);

    // ---------------- label 对象（编辑器可编辑的 HUD 文字） ----------------

    /** label 纹理缓存：key = 字号|颜色|文字。上限 400 条，超了整体清空（HUD 数量有限）。 */
    private final Map<String, Texture> labelTex = new HashMap<String, Texture>();

    private void drawLabel(GL2 gl, Actor a, float alpha) {
        drawLabel(gl, a, alpha, 1f);
    }

    /**
     * 画文字对象。
     *
     * @param alpha      透明度
     * @param extraScale 额外缩放（UI 场景层用：该层已经 {@code glScalef(z)}，
     *                   所以字形纹理也要按 z 超采样，否则界面文字在大窗口下会发虚）
     */
    private void drawLabel(GL2 gl, Actor a, float alpha, float extraScale) {
        String txt = propStr(a.o, "text");
        if (txt.isEmpty()) {
            return;
        }
        float size = propNum(a.o, "textSize");
        if (size <= 0f) {
            size = 16f;
        }
        String color = propStr(a.o, "textColor");
        if (color.isEmpty()) {
            color = "#101010";
        }
        String align = propStr(a.o, "textAlign");
        // 超采样倍率：物理像素密度 × 当前层缩放。纹理按放大后的字号生成，
        // 贴出去时再除回来，于是「1 个纹理像素 ≈ 1 个物理像素」。
        float ss = displayScale() * Math.max(0.25f, extraScale);
        Texture t = labelTexture(txt, size, color, ss);
        if (t == null) {
            return;
        }
        float w = t.w / ss;
        float h = t.h / ss;
        float x = a.x;
        if ("center".equalsIgnoreCase(align) || "middle".equalsIgnoreCase(align)) {
            x -= w / 2f;
        } else if ("right".equalsIgnoreCase(align) || "end".equalsIgnoreCase(align)) {
            x -= w;
        }
        // y 是文字块的**垂直中心**（编辑器里拖起来更直观）
        float y = a.y - h / 2f;
        // 编辑器给的 halfW/halfH 若 > 0，则按它拉伸（方便做定框文本）
        float dw = a.o.halfW > 0f ? a.o.halfW * 2f : w;
        float dh = a.o.halfH > 0f ? a.o.halfH * 2f : h;
        drawTexture(gl, t, x + dw / 2f, y + dh / 2f, dw, dh, 0f, alpha, 0f, 0f, 1f, 1f);
    }

    private Texture labelTexture(String txt, float size, String color) {
        return labelTexture(txt, size, color, displayScale());
    }

    private Texture labelTexture(String txt, float size, String color, float superSample) {
        String key = Math.round(size) + "|" + color + "|" + Math.round(superSample * 100f) + "|" + txt;
        Texture cached = labelTex.get(key);
        if (cached != null) {
            return cached;
        }
        if (labelTex.size() > 400) {
            labelTex.clear();
        }
        try {
            int px = Math.max(6, Math.round(size * Math.max(0.5f, superSample)));
            Font f = new Font("Microsoft YaHei", Font.PLAIN, px);
            BufferedImage probe = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB);
            Graphics2D pg = probe.createGraphics();
            pg.setFont(f);
            FontMetrics fm = pg.getFontMetrics();
            int tw = Math.max(1, fm.stringWidth(txt));
            int th = Math.max(1, fm.getHeight());
            pg.dispose();
            BufferedImage img = new BufferedImage(tw + 4, th + 2, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g = img.createGraphics();
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            g.setFont(f);
            Color c = parseHexColor(color);
            g.setColor(c);
            g.drawString(txt, 2, fm.getAscent() + 1);
            g.dispose();
            Texture t = textureFromImage(img);
            if (t != null) {
                labelTex.put(key, t);
            }
            return t;
        } catch (Throwable e) {
            return null;
        }
    }

    private static Color parseHexColor(String s) {
        try {
            if (s != null && s.startsWith("#") && s.length() >= 7) {
                return new Color(Integer.parseInt(s.substring(1, 7), 16));
            }
        } catch (Throwable ignored) {
        }
        return Color.BLACK;
    }

    private static String propStr(GameData.RtObject o, String key) {
        if (o == null || o.props == null) {
            return "";
        }
        String raw = o.props.get(key);
        return raw == null ? "" : raw.trim();
    }

    private void drawFallback(GL2 gl, Actor a, float alpha) {
        String kind = a.o.kind == null ? "PROP" : a.o.kind.toUpperCase();
        Color c;
        // ★ 优先读对象自带的颜色（props.color）。
        //
        // 为什么必须支持：编辑器/生成器产出的无贴图对象（TILE / PROP / ZONE）用它表达
        // 视觉语义 —— 道路是深灰、草地是绿、水是蓝、屋顶是浅灰。
        // 之前这里只按 kind 取 5 个写死的 FALLBACK_* 颜色，于是**整张城市画出来是一块灰板**
        // （244 个对象全同色，离屏渲染实测 nonBgPixels≈576 只有玩家那一小块）。
        // 这是"游戏看起来没做出来"的真实原因，不是性能问题。
        Color custom = colorOf(a);
        if (custom != null) {
            c = custom;
        } else if ("ZONE".equals(kind) || "PORTAL".equals(kind)) {
            c = FALLBACK_ZONE;
        } else if ("SPAWN".equals(kind)) {
            c = FALLBACK_SPAWN;
        } else if ("LIGHT".equals(kind)) {
            c = FALLBACK_LIGHT;
        } else if ("ACTOR".equals(kind)) {
            c = FALLBACK_ACTOR;
        } else {
            c = FALLBACK_PROP;
        }
        float w = drawWidth(a);
        float h = drawHeight(a);
        // 未贴图的纯色块也进合批：3600 个 TILE 从 3600 次 glBegin 降到个位数。
        batchSolid(gl, a.x - w / 2f, a.y - h / 2f, w, h,
                c.getRed() / 255f, c.getGreen() / 255f, c.getBlue() / 255f,
                c.getAlpha() / 255f * alpha);
        if (a.mine != null) {
            flushSprites(gl);
            a.mine.draw(gl);
        }
    }

    /**
     * 对象自带的纯色（{@code props.color}），没有/非法 → null。
     *
     * <p>按 AABB 缓存：这个方法是**每个无贴图对象每帧**都会走的路径，而
     * {@code props.get} 是 HashMap 查找 + 字符串解析。缓存按「props 表身份 + color 值」
     * 校验（脚本改了 color 立刻生效，不用等帧号变化）。
     */
    private Color colorOf(Actor a) {
        if (a.o == null || a.o.props == null) {
            return null;
        }
        String raw = a.o.props.get("color");
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        if (a.colorCacheRaw != null && a.colorCacheRaw.equals(raw)
                && a.colorCacheProps == a.o.props) {
            return a.colorCache;
        }
        Color c = parseColor(raw, null);
        a.colorCacheRaw = raw;
        a.colorCacheProps = a.o.props;
        a.colorCache = c;
        return c;
    }

    void drawTexture(GL2 gl, Texture tex, float cx, float cy, float w, float h,
                             float rotation, float alpha,
                             float u0, float v0, float u1, float v1) {
        drawTexture(gl, tex, cx, cy, w, h, rotation, alpha, u0, v0, u1, v1, 1f, 1f, 1f, 1f);
    }

    /**
     * 带染色/alpha 乘数的精灵绘制。
     *
     * @param tr,tg,tb 颜色乘数（1 = 原色）
     * @param ta       额外 alpha 乘数（1 = 只用 {@code alpha} 参数）
     */
    void drawTexture(GL2 gl, Texture tex, float cx, float cy, float w, float h,
                             float rotation, float alpha,
                             float u0, float v0, float u1, float v1,
                             float tr, float tg, float tb, float ta) {
        if (tex == null || tex.id < 0) {
            return;
        }
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glBindTexture(GL2.GL_TEXTURE_2D, tex.id);
        gl.glColor4f(tr, tg, tb, alpha * ta);
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

    /**
     * 这个对象是不是「瓦片」（应该平铺纹理而不是拉伸）。
     *
     * <p>判据：名字以 {@code tile-} 开头，或带 {@code tile} / {@code ground} 标签。
     * 生成器给地面/墙/屋顶的对象名就是素材名（`tile-grass` 等），所以直接命中。
     */
    private static boolean isTileActor(Actor a) {
        if (a == null || a.o == null) {
            return false;
        }
        if (a.o.tags != null) {
            for (int i = 0; i < a.o.tags.size(); i++) {
                String t = a.o.tags.get(i);
                if ("tile".equalsIgnoreCase(t) || "ground".equalsIgnoreCase(t)) {
                    return true;
                }
            }
        }
        String name = a.o.name == null ? "" : a.o.name;
        return name.startsWith("tile-") || name.startsWith("tile ");
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

    /** 画虚拟摇杆/按键（屏幕空间，调用前矩阵应为单位阵）。 */
    private void drawStick(GL2 gl) {
        float w = viewW, h = viewH;
        float base = stick.opacity();
        gl.glDisable(GL2.GL_TEXTURE_2D);
        gl.glEnable(GL2.GL_BLEND);
        for (ScriptStick.Control c : stick.controls()) {
            if (c.analog) {
                // 摇杆：底盘 + 摇杆头
                float cx = c.cxN * w, cy = c.cyN * h;
                float r = c.radiusN * Math.min(w, h) * 1.6f;
                drawCircleFill(gl, cx, cy, r, 0.85f, 0.88f, 0.92f, base * 0.45f);
                drawCircleFill(gl, cx, cy, r * 0.92f, 0.25f, 0.28f, 0.34f, base * 0.55f);
                float hx = cx + c.axisX * r * 0.55f;
                float hy = cy + c.axisY * r * 0.55f;
                drawCircleFill(gl, hx, hy, r * 0.38f, 0.95f, 0.96f, 1f, base * 0.95f);
            } else {
                float bx = c.nx * w, by = c.ny * h;
                float bw = c.nw * w, bh = c.nh * h;
                float a = c.pressed ? base : base * 0.62f;
                gl.glColor4f(0.15f, 0.17f, 0.22f, a);
                gl.glBegin(GL2.GL_QUADS);
                gl.glVertex2f(bx, by);
                gl.glVertex2f(bx + bw, by);
                gl.glVertex2f(bx + bw, by + bh);
                gl.glVertex2f(bx, by + bh);
                gl.glEnd();
                // 边框
                gl.glColor4f(0.85f, 0.88f, 0.95f, a);
                gl.glLineWidth(2f);
                gl.glBegin(GL2.GL_LINE_LOOP);
                gl.glVertex2f(bx, by);
                gl.glVertex2f(bx + bw, by);
                gl.glVertex2f(bx + bw, by + bh);
                gl.glVertex2f(bx, by + bh);
                gl.glEnd();
                drawKeyLabel(gl, c.id, bx + bw * 0.5f, by + bh * 0.5f, a);
            }
        }
    }

    /** 填充圆（三角扇）。 */
    private void drawCircleFill(GL2 gl, float cx, float cy, float r,
                                float cr, float cg, float cb, float ca) {
        gl.glColor4f(cr, cg, cb, ca);
        int seg = 28;
        gl.glBegin(GL2.GL_TRIANGLE_FAN);
        gl.glVertex2f(cx, cy);
        for (int i = 0; i <= seg; i++) {
            float ang = (float) (i * Math.PI * 2.0 / seg);
            gl.glVertex2f(cx + (float) Math.cos(ang) * r, cy + (float) Math.sin(ang) * r);
        }
        gl.glEnd();
    }

    /** 按键上的文字标签（用文字纹理，避免依赖字体绘制）。 */
    private void drawKeyLabel(GL2 gl, String id, float cx, float cy, float alpha) {
        String label = keyLabelOf(id);
        if (label.isEmpty()) {
            return;
        }
        float size = Math.min(18f, Math.max(11f, viewH * 0.024f));
        Texture t = labelTexture(label, size);
        if (t == null) {
            return;
        }
        float tw = t.w / displayScale();
        float th = t.h / displayScale();
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glBindTexture(GL2.GL_TEXTURE_2D, t.id);
        gl.glColor4f(1f, 1f, 1f, alpha);
        float x = cx - tw / 2f, y = cy - th / 2f;
        gl.glBegin(GL2.GL_QUADS);
        gl.glTexCoord2f(0f, 0f); gl.glVertex2f(x, y);
        gl.glTexCoord2f(1f, 0f); gl.glVertex2f(x + tw, y);
        gl.glTexCoord2f(1f, 1f); gl.glVertex2f(x + tw, y + th);
        gl.glTexCoord2f(0f, 1f); gl.glVertex2f(x, y + th);
        gl.glEnd();
        gl.glDisable(GL2.GL_TEXTURE_2D);
    }

    private static String keyLabelOf(String id) {
        switch (id) {
            case "space": return "SPC";
            case "enter": return "ENT";
            case "tab": return "TAB";
            case "esc": return "ESC";
            default: return id.length() <= 4 ? id.toUpperCase() : id.substring(0, 4).toUpperCase();
        }
    }

    /** 标签纹理缓存（每个标签只生成一次）。 */
    private final java.util.Map<String, Texture> labelTexCache =
            new java.util.HashMap<String, Texture>();

    private Texture labelTexture(String label, float size) {
        String key = label + "|" + (int) size;
        Texture cached = labelTexCache.get(key);
        if (cached != null) {
            return cached;
        }
        java.awt.image.BufferedImage img = ScriptRender.textImageForHost(label, (int) size,
                new java.awt.Color(255, 255, 255), false);
        if (img == null) {
            return null;
        }
        Texture t = textureFromImage(img);
        labelTexCache.put(key, t);
        return t;
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

    static final class DressPart {
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

    /**
     * 复雷加殊（Complexweeper）规则内核：<b>纯静态、无状态、不依赖 GL</b>，单测可直接调用。
     *
     * <p>唯一事实来源：{@code docs/complexweeper-rules.md}。要点：
     * <ul>
     *   <li>雷不是「1 颗」，而是 4 种复数：{@code +1}（实雷+，红）、{@code −1}（实雷−，蓝）、
     *       {@code +i}（虚雷+，紫）、{@code −i}（虚雷−，青）；</li>
     *   <li>数字 = 周围八格雷值之和的<b>模长</b>：{@code n = re² + im²}，完全平方显示整数，否则 {@code √n}；</li>
     *   <li>点已翻开的数字格可连锁翻开（chord），需「旗数正确」+「虚实比例正确」两条同时成立。</li>
     * </ul>
     *
     * <p>普通模式的 {@code sumRe == counts}、{@code sumIm == 0}，所以同一套 {@link #label} 走出来的
     * 就是旧版的整数串 —— 渲染零回归靠的是这个不变量，而不是两条分支。
     */


    /** 扫雷需要在 paint 里重新上传同一张纹理，这里暴露一个小入口。 */
    /** 把一张图上传到指定纹理 id（包内可见：玩法模块自绘复用）。 */
    /**
     * 把一张位图重新上传到<b>已有</b>的纹理 id（用于「位图重画后刷新 GPU 像素」）。
     *
     * <p><b>踩过的坑（「玩久了越来越卡」）</b>：早先这里每次 {@code new Texture()} 当 map key，
     * 而 {@link Texture} 没有 {@code equals}/{@code hashCode} —— 每个新对象都是新 key，
     * 于是 {@link #pendingUploads} 里会不断堆积**永远无法合并**的条目：
     * <ul>
     *   <li>内存随帧数线性增长（每帧一整张棋盘位图的引用）；</li>
     *   <li>每次 {@link #uploadTextures} 都要遍历这些历史条目重传整张位图 → 越玩越卡。</li>
     * </ul>
     *
     * <p>正确做法：按 id 找到**真正的那个 Texture 实例**再入队，这样同一张纹理只占一个 key。
     */
    void uploadImageTo(int id, BufferedImage image) {
        // 实际 GL 上下文只在 display() 内可用，这里先缓存，下一帧上传。
        Texture t = findTextureById(id);
        if (t == null) {
            // id 不属于已托管的纹理（理论上不该发生）：退化成一次性上传，
            // 但不能污染 pendingUploads 的 key 空间 —— 用一个带标记的临时实例即可，
            // 上传完立即移除。
            t = new Texture();
            t.id = id;
        }
        t.w = image.getWidth();
        t.h = image.getHeight();
        pendingUploads.put(t, image);
    }

    /** 待删除的纹理（GL 只能在下一次 draw 里删，所以先记下来）。 */
    private final List<Texture> pendingDeletes = new ArrayList<Texture>();

    /**
     * 请求释放一张纹理（真正的 GL 删除推迟到下一次 {@link #flushPendingDeletes}）。
     *
     * <p><b>为什么需要</b>：{@code GridPainter} 在改行列/重置时会重建自身，
     * 旧纹理如果只是「断开引用」而不删，GPU 显存会持续增长
     * （实测 uploadedTextures 从 18 涨到 54、且只增不减）。
     */
    void deleteTexture(Texture t) {
        if (t == null || t.id < 0) {
            return;
        }
        pendingDeletes.add(t);
        uploadedTextures.remove(t);
        textureSources.remove(t);
    }

    /** 在 GL 上下文可用时真正删除待删纹理。 */
    private void flushPendingDeletes(GL2 gl) {
        if (pendingDeletes.isEmpty() || gl == null) {
            return;
        }
        List<Texture> batch = new ArrayList<Texture>(pendingDeletes);
        pendingDeletes.clear();
        for (Texture t : batch) {
            try {
                if (t.id >= 0) {
                    int[] ids = {t.id};
                    gl.glDeleteTextures(1, ids, 0);
                }
            } catch (Throwable ignored) {
            }
            t.id = -1;
        }
    }

    /** 在已上传纹理里按 id 找实例（找不到返回 null）。 */
    private Texture findTextureById(int id) {
        for (Texture t : uploadedTextures) {
            if (t.id == id) {
                return t;
            }
        }
        return null;
    }
}
