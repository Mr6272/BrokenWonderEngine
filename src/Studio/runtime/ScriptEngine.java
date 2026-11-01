package Studio.runtime;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.EcmaError;
import org.mozilla.javascript.EvaluatorException;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.JavaScriptException;
import org.mozilla.javascript.RhinoException;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;

import javax.media.opengl.GL2;
import java.awt.event.KeyEvent;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;

/**
 * 内嵌 Rhino 的脚本引擎（契约见 docs/scripting-api.md）。
 *
 * <h3>线程</h3>
 * Rhino 的 {@link Context} 是线程绑定的：宿主在 <b>构造方法</b>里 new 出本对象（主线程），
 * 但 {@code update/draw} 在 JOGL 动画线程里跑。因此这里<b>不在构造方法里创建任何 Rhino 对象</b>：
 * 构造只读 boot.json 脚本表；真正的 {@code initStandardObjects} + 脚本顶层执行 + onStart 派发
 * 都推迟到第一次 {@code update}（或 {@code draw}）里做。这样从初始化到生命周期回调全部发生在
 * 同一个线程上，不需要 ContextFactory 跨线程传递。
 *
 * <h3>作用域</h3>
 * 每个脚本一个独立 scope（parentScope 指向共享全局），互不覆盖同名生命周期函数；
 * 共享的只有 {@code bwe} 与标准对象。跨脚本调用走 {@code bwe.call(script, fn, ...)}。
 *
 * <h3>错误</h3>
 * 语法/运行时异常统一 `[脚本错误] 脚本名:行: 消息` 写 Build/bwe.log，同一脚本同一行只报一次，
 * 游戏继续跑；单脚本单帧执行超过 250ms 记一条告警。
 */
final class ScriptEngine {

    // ---------------- 脚本表 ----------------

    static final class ScriptDef {
        final String name;
        final String source;
        Scriptable scope;
        boolean slowWarned;

        ScriptDef(String name, String source) {
            this.name = name;
            this.source = source;
        }
    }

    private static final class Handler {
        final Function fn;
        final Scriptable scope;
        final ScriptDef def;

        Handler(Function fn, Scriptable scope, ScriptDef def) {
            this.fn = fn;
            this.scope = scope == null ? (def == null ? null : def.scope) : scope;
            this.def = def;
        }
    }

    private static final class Timer {
        long id;
        double due;
        float interval;
        boolean repeat;
        int left = -1; // -1 = 无限
        Function fn;
        ScriptDef def;
        boolean cancelled;
    }

    private static final class Click {
        final int wx;
        final int wy;
        final boolean right;
        final int sx;
        final int sy;

        Click(int wx, int wy, boolean right, int sx, int sy) {
            this.wx = wx;
            this.wy = wy;
            this.right = right;
            this.sx = sx;
            this.sy = sy;
        }
    }

    /** 脚本挂的子精灵（{@code e.attach}）：引擎在帧末统一画。 */
    static final class Attachment {
        final Actor owner;
        long id;
        String assetName = "";
        float dx;
        float dy;
        int z;
        float rotation;
        float alpha = 1f;
        float w;
        float h;

        Attachment(Actor owner) {
            this.owner = owner;
        }
    }

    /** 交互触发回调（{@code bwe.interact.onTrigger}）。 */
    static final class InteractHandler {
        final Function fn;
        final ScriptDef def;

        InteractHandler(Function fn, ScriptDef def) {
            this.fn = fn;
            this.def = def;
        }
    }

    /** 交互提示（{@code bwe.interact.prompt}）。 */
    static final class Prompt {
        String text;
    }

    // ---------------- 宿主与文件 ----------------

    final TopDownRuntime host;
    private final File bootFile;
    final File buildDir;
    final File assetRoot;

    /** 共享全局（标准对象 + bwe）。 */
    ScriptableObject shared;
    ScriptApi api;
    ScriptRender render;

    /** 名字 → 脚本（boot.json 里 lang=js 的条目）。 */
    private final Map<String, ScriptDef> scripts = new LinkedHashMap<String, ScriptDef>();
    private final List<ScriptDef> scriptOrder = new ArrayList<ScriptDef>();
    boolean sceneStartRequested;

    /** 场景脚本名（scene_0.json 的 onStartScript）。 */
    String sceneScriptName = "";
    /** 全局入口脚本名（boot.json 的 jsMain）。 */
    String jsMain = "";

    /** Actor → 对象脚本（script.js 模块）。 */
    // 用 LinkedHashMap：对象脚本 onUpdate 的派发顺序必须稳定（= 场景对象顺序）。
    // IdentityHashMap 的迭代顺序跨运行会变，会让「同种子同输入」的涌现结果不可复现（见 docs/scripting-api.md §2.11.7 第 6 条）。
    private final Map<Actor, ScriptDef> bound = new LinkedHashMap<Actor, ScriptDef>();

    // ---------------- 运行状态 ----------------

    boolean started;
    boolean failed;

    double time;
    float frameDt;
    int frame;
    boolean paused;
    float timeScale = 1f;

    private final List<Timer> timers = new ArrayList<Timer>();
    private long nextTimerId = 1;

    private final Map<String, List<Handler>> hooks = new HashMap<String, List<Handler>>();
    private final java.util.Deque<Click> clicks = new ArrayDeque<Click>();
    private final List<Integer> keyDownQueue = new ArrayList<Integer>();

    // 键盘边沿（每帧从 host.keys 快照计算）
    final boolean[] held = new boolean[512];
    private final boolean[] prevHeld = new boolean[512];
    final boolean[] pressed = new boolean[512];
    final boolean[] released = new boolean[512];

    // 鼠标（宿主只有 pointerDown，没有抬起事件：按下状态只维持这一帧）
    final boolean[] mouseNow = new boolean[3];
    final boolean[] mousePrev = new boolean[3];
    final boolean[] mousePressed = new boolean[3];
    int lastWorldX;
    int lastWorldY;
    int lastScreenX;
    int lastScreenY;

    // 相机
    Actor cameraTarget;
    float cameraSmooth = -1f;
    float cameraLookAhead;
    float[] cameraBounds; // {x,y,w,h}
    float shakeTime;
    float shakeDuration;
    float shakeStrength;
    private final Random random = new Random();

    // 绘制列表（本帧）
    final List<ScriptRender.Cmd> drawCmds = new ArrayList<ScriptRender.Cmd>();
    int worldDrawDepth;

    // 交互 / 子精灵 / 刷怪器 / 寻路跟随（Phase 1 的俯视角专长）
    final List<Attachment> attachments = new ArrayList<Attachment>();
    final List<ScriptWorld.Spawner> spawners = new ArrayList<ScriptWorld.Spawner>();
    final List<ScriptWorld.Follow> follows = new ArrayList<ScriptWorld.Follow>();
    final List<InteractHandler> interactHandlers = new ArrayList<InteractHandler>();
    ScriptWorld world; // 网格/瓦片/寻路/交互（无 Rhino 对象，可安全在构造期建）
    ScriptSave save;
    ScriptAudio audio;
    Prompt prompt;
    int interactKey = java.awt.event.KeyEvent.VK_E; // 默认触发键 KeyE（bwe.d.ts）
    Actor interactActor;
    long nextSpawnerId = 1;

    /** 世界事件总线（bwe.world.on/off/emit）。 */
    private final Map<String, List<Handler>> worldEvents = new HashMap<String, List<Handler>>();

    // 错误去重
    private final Set<String> reportedErrors = new HashSet<String>();
    private String currentScript = "";
    private String lastErrorLine = "";

    /**
     * 可观测性数据仓：错误环形缓冲 + 性能剖析样本。
     *
     * <p>为什么放这里而不是静态单例：一份运行时对应一份数据，多开窗口/多次
     * {@code new TopDownRuntime} 的测试之间互不串味（静态单例会被上一个工程的
     * 错误残留污染，单测断言直接失效）。
     */
    private final ScriptMetrics metrics = new ScriptMetrics();

    /** 包内访问（ScriptProf / ScriptDebug / 测试用）。 */
    ScriptMetrics metrics() {
        return metrics;
    }

    // ---------------- 构造 ----------------

    ScriptEngine(TopDownRuntime host) {
        this.host = host;
        this.bootFile = host.bootFileForScripts();
        this.buildDir = bootFile == null ? new File(".") : bootFile.getParentFile();
        this.assetRoot = host.assetRoot;
        loadScriptTable();
        this.world = new ScriptWorld(this);
        this.world.buildTileMap(host.actors);
    }

    private void loadScriptTable() {
        if (bootFile == null || !bootFile.isFile()) {
            return;
        }
        try {
            String json = new String(Files.readAllBytes(bootFile.toPath()), StandardCharsets.UTF_8);
            JsonObject root = new Gson().fromJson(json, JsonObject.class);
            if (root == null) {
                return;
            }
            JsonArray arr = root.has("scripts") && root.get("scripts").isJsonArray()
                    ? root.getAsJsonArray("scripts") : new JsonArray();
            int index = 0;
            for (JsonElement e : arr) {
                index++;
                if (!e.isJsonObject()) {
                    continue;
                }
                JsonObject o = e.getAsJsonObject();
                String name = str(o, "name", "");
                String lang = str(o, "lang", "");
                String file = str(o, "file", "");
                String source = str(o, "source", "");
                boolean js = "js".equalsIgnoreCase(lang) || (lang.isEmpty() && !file.isEmpty());
                if (!js) {
                    continue;
                }
                if (name.isEmpty()) {
                    name = baseName(file, "script" + index);
                }
                String code = source;
                if (!file.isEmpty()) {
                    File f = new File(buildDir, file);
                    try {
                        if (f.isFile()) {
                            code = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
                        }
                    } catch (Throwable t) {
                        warn("读取脚本文件失败 " + f + ": " + t.getMessage());
                    }
                }
                if (code == null || code.trim().isEmpty()) {
                    warn("脚本「" + name + "」没有内容（file/source 都为空），已跳过");
                    continue;
                }
                if (scripts.containsKey(name)) {
                    warn("脚本名重复：「" + name + "」，后一个被忽略");
                    continue;
                }
                ScriptDef def = new ScriptDef(name, code);
                scripts.put(name, def);
                scriptOrder.add(def);
            }
            jsMain = str(root, "jsMain", "");
            JsonArray scenes = root.has("scenes") && root.get("scenes").isJsonArray()
                    ? root.getAsJsonArray("scenes") : new JsonArray();
            if (scenes.size() > 0 && scenes.get(0).isJsonObject()) {
                String sceneFile = str(scenes.get(0).getAsJsonObject(), "file", "");
                if (!sceneFile.isEmpty()) {
                    try {
                        File f = new File(buildDir, sceneFile);
                        if (f.isFile()) {
                            String sj = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
                            JsonObject root2 = new Gson().fromJson(sj, JsonObject.class);
                            if (root2 != null) {
                                sceneScriptName = str(root2, "onStartScript", "");
                            }
                        }
                    } catch (Throwable ignored) {
                    }
                }
            }
        } catch (Throwable t) {
            warn("读取 boot.json 脚本表失败: " + t);
        }
    }

    private static String baseName(String path, String def) {
        if (path == null || path.isEmpty()) {
            return def;
        }
        String p = path.replace('\\', '/');
        int slash = p.lastIndexOf('/');
        String b = slash >= 0 ? p.substring(slash + 1) : p;
        if (b.toLowerCase().endsWith(".js")) {
            b = b.substring(0, b.length() - 3);
        }
        return b.isEmpty() ? def : b;
    }

    private static String str(JsonObject o, String k, String def) {
        JsonElement e = o.get(k);
        if (e == null || e.isJsonNull()) {
            return def;
        }
        try {
            return e.getAsString();
        } catch (Throwable t) {
            return def;
        }
    }

    // ---------------- 宿主调用入口 ----------------

    /** 场景载入完成。真正的脚本执行推迟到第一次 update/draw（见类注释的线程说明）。 */
    void sceneStart() {
        sceneStartRequested = true;
    }

    // ---------------- 涌现式模拟基底（Phase 2） ----------------

    /** 每帧模拟钩子（材质场 / 物理 / 感知 AI）。在 update 的同一线程里跑。 */
    interface SimHook {
        void tick(float dt);
    }

    private final List<SimHook> simHooks = new ArrayList<SimHook>();

    /** 供 ScriptFields / ScriptPhysics / ScriptAi 注册每帧模拟（按注册顺序执行）。 */
    void addSimHook(SimHook hook) {
        if (hook != null) {
            simHooks.add(hook);
        }
    }

    /**
     * 带<b>执行阶段</b>的模拟钩子。用于「必须在逻辑之后、渲染之前」的新子系统
     * （碰撞事件派发、空间归属解析、车辆推进）。
     *
     * <p>为什么不复用 {@link #addSimHook}：那个列表由 ScriptFields / ScriptPhysics / ScriptAi
     * 按 install 顺序占用（材质场 → 物理 → 感知 AI）。往中间插一个新子系统会改变既有顺序，
     * 而「同种子同输入 ⇒ 同结果」的确定性断言依赖该顺序。所以新阶段用**独立列表 + 显式阶段号**，
     * 老钩子的顺序一个字都不动。
     *
     * <p>阶段语义（见 docs/open-world-architecture.md §3.2）：
     * <ul>
     *   <li>{@link #PHASE_SPATIAL} —— 物理事件与空间归属之前（③）</li>
     *   <li>{@link #PHASE_EVENTS}  —— 物理步进之后，派发碰撞 enter/stay/exit（④）</li>
     *   <li>{@link #PHASE_COMMIT}  —— 帧末延迟提交：延迟销毁、延迟场景切换（⑥）</li>
     * </ul>
     */
    static final int PHASE_SPATIAL = 30;
    static final int PHASE_EVENTS = 40;
    static final int PHASE_COMMIT = 90;

    /** 一个带阶段号的每帧钩子。 */
    interface PhaseHook {
        void tick(float dt);
    }

    private static final class PhaseEntry {
        final int phase;
        final PhaseHook hook;

        PhaseEntry(int phase, PhaseHook hook) {
            this.phase = phase;
            this.hook = hook;
        }
    }

    private final List<PhaseEntry> phaseHooks = new ArrayList<PhaseEntry>();

    /**
     * 注册一个带阶段的每帧钩子。同一阶段按注册顺序执行；阶段号小的先执行。
     * 注册时会插入排序，所以运行期遍历零分配、顺序稳定可复现。
     */
    void addPhaseHook(int phase, PhaseHook hook) {
        if (hook == null) {
            return;
        }
        int at = phaseHooks.size();
        for (int i = 0; i < phaseHooks.size(); i++) {
            if (phaseHooks.get(i).phase > phase) {
                at = i;
                break;
            }
        }
        phaseHooks.add(at, new PhaseEntry(phase, hook));
    }

    /** 按阶段号执行所有已注册钩子（阶段区间 [from, to]）。 */
    private void runPhaseHooks(float dt, int from, int to) {
        for (int i = 0; i < phaseHooks.size(); i++) {
            PhaseEntry e = phaseHooks.get(i);
            if (e.phase < from || e.phase > to) {
                continue;
            }
            try {
                e.hook.tick(dt);
            } catch (Throwable t) {
                recordSwallowed((ScriptDef) null, t);
                host.scriptLog("[脚本] 阶段钩子异常(" + e.phase + "): " + t);
            }
        }
    }

    /** 当前脚本 API（子系统用它挂命名空间、包 Entity）。 */
    ScriptApi api() {
        return api;
    }

    /** 每帧：计时器 + 全局 update 钩子 + 对象 onUpdate + 微任务。 */
    /**
     * 待执行回调队列：**跨线程**事件（AWT 点击、Android 触摸/软键盘）不能直接调脚本函数。
     *
     * <p><b>为什么必须排队</b>：{@code invoke()} 依赖 {@code Context.getCurrentContext()}，
     * 而 AWT 事件线程没有 Rhino Context → 直接调用会<b>静默返回 null</b>，
     * 回调永远不执行（表现是「输入框按回车没反应」这类，且不报错、极难查）。
     *
     * <p>做法：跨线程处把「要做的脚本调用」塞进队列，下一次 {@link #update} 在脚本上下文里排空。
     * 代价是延迟一帧（≤16ms），对 UI 回调完全无感。
     */
    private final java.util.List<Runnable> pendingScriptCalls =
            java.util.Collections.synchronizedList(new java.util.ArrayList<Runnable>());

    /** 从任意线程安全地排队一次脚本调用（会在下次 update 的脚本上下文里执行）。 */
    void postScriptCall(Runnable call) {
        if (call != null) {
            pendingScriptCalls.add(call);
        }
    }

    /** 在脚本上下文里排空跨线程回调。必须在已进入 Context 的调用栈里调。 */
    private void drainPendingCalls() {
        if (pendingScriptCalls.isEmpty()) {
            return;
        }
        java.util.List<Runnable> batch;
        synchronized (pendingScriptCalls) {
            batch = new java.util.ArrayList<Runnable>(pendingScriptCalls);
            pendingScriptCalls.clear();
        }
        for (Runnable r : batch) {
            try {
                r.run();
            } catch (Throwable t) {
                recordSwallowed((ScriptDef) null, t);
                host.scriptLog("[脚本] 跨线程回调异常: " + t);
            }
        }
    }

    void update(float dt) {
        Context cx = Context.enter();
        try {
            prepare(cx);
            if (!started) {
                start(cx);
            }
            if (failed) {
                return;
            }
            drainPendingCalls();
            tick(cx, dt);
            // 帧末结算剖析样本。
            //
            // ⚠ 结算点选在 update() 末尾（而不是整帧最后），是有意的：
            //   · 宿主一帧的调用顺序是 update() → 模块更新 → draw()，脚本回调的主体在 update；
            //   · draw() 里的脚本回调（draw 钩子）会在下一帧的 update 结算时被算进去 ——
            //     因为 metrics 的累计器是跨调用累加的，下一个 endFrame 会把它带走。
            //   两种口径（"本帧 update 内" vs "跨 update+draw"）差的是 1 帧归属，对
            //   p50/p95/p99 这类窗口统计没有意义；而把它放在 update 末尾的好处是
            //   无窗口自检（只调 update、不调 draw）也能采到样本。
            metrics.endFrame();
        } catch (Throwable t) {
            // 异常帧的累计器必须清掉，否则这段耗时会漏进下一帧的样本（读数虚高）。
            metrics.endFrameOnError();
            recordSwallowed((ScriptDef) null, t);
            host.scriptLog("[脚本] update 异常: " + t);
        } finally {
            Context.exit();
        }
    }

    /** 帧末立即模式绘制（HUD / 世界内特效）。gl 为 null 时安全跳过。 */
    void draw(GL2 gl) {
        if (gl == null) {
            // 无窗口自检：不碰 GL，也不消费绘制列表。
            return;
        }
        Context cx = Context.enter();
        try {
            prepare(cx);
            if (!started) {
                start(cx);
            }
            if (failed) {
                return;
            }
            List<Handler> drawList = handlers("draw");
            for (int i = 0; i < handlerCount(drawList); i++) {
                Handler h = handlerAt(drawList, i);
                if (h == null) {
                    continue;
                }
                invoke(h.def, h.fn, h.scope, new Object[0]);
            }
            drawAttachments(gl);
            if (render != null) {
                render.render(gl, drawCmds);
                // 文本纹理缓存是按 LRU 淘汰的：淘汰掉的 GL 纹理必须在这里（GL 线程、
                // 上下文 current）真正删除，否则显存只增不减。
                render.releaseEvicted(gl);
            }
            drawCmds.clear();
        } catch (Throwable t) {
            recordSwallowed((ScriptDef) null, t);
            host.scriptLog("[脚本] draw 异常: " + t);
        } finally {
            Context.exit();
        }
    }

    /** 键盘按下（AWT/EDT 线程）：只入队，dispatch 在 update 的同线程里做。 */
    void keyDown(int keyCode) {
        if (keyCode <= 0) {
            return;
        }
        synchronized (keyDownQueue) {
            if (keyDownQueue.size() < 64) {
                keyDownQueue.add(keyCode);
            }
        }
    }

    /** 键盘抬起：宿主已经更新 keys[]，这里不用额外处理（边沿在 update 里算）。 */
    void keyUp(int keyCode) {
    }

    /** 点击（AWT/EDT 线程）：入队，update 时派发。 */
    /** 指针移动（触摸拖动）：优先给虚拟摇杆，否则只更新鼠标坐标。 */
    void pointerMove(int screenX, int screenY) {
        if (host != null) {
            host.pointerMoveAt(screenX, screenY);
        }
    }

    /** 指针抬起：释放虚拟摇杆占用。 */
    void pointerUp() {
        if (host != null) {
            host.pointerUpAt();
        }
    }

    void pointerDown(int worldX, int worldY, boolean right, int screenX, int screenY) {
        synchronized (clicks) {
            if (clicks.size() < 32) {
                clicks.add(new Click(worldX, worldY, right, screenX, screenY));
            }
        }
    }

    private static void prepare(Context cx) {
        cx.setLanguageVersion(Context.VERSION_ES6);
        // 解释执行：不生成字节码，跨线程使用 scope 更安全，也便于调试行号。
        cx.setOptimizationLevel(-1);
    }

    // ---------------- 初始化（第一次 update 的线程上） ----------------

    private void start(Context cx) {
        started = true;
        try {
            render = new ScriptRender(this);
            save = new ScriptSave(this);
            audio = new ScriptAudio(this);
            shared = (ScriptableObject) cx.initStandardObjects();
            api = new ScriptApi(this, shared);
            api.build(cx);

            // 1) 每个脚本在自己的 scope 里执行顶层代码
            for (ScriptDef def : scriptOrder) {
                Scriptable scope = cx.newObject(shared);
                scope.setPrototype(ScriptableObject.getObjectPrototype(shared));
                scope.setParentScope(shared);
                def.scope = scope;
                evalTop(cx, def);
            }

            // 2) 对象脚本绑定 + onStart
            bindSceneObjects();
            for (Map.Entry<Actor, ScriptDef> e : new ArrayList<Map.Entry<Actor, ScriptDef>>(bound.entrySet())) {
                dispatchObject(e.getKey(), e.getValue(), "onStart", new Object[0]);
            }

            // 3) 全局入口脚本（jsMain）先于场景脚本
            if (!jsMain.isEmpty()) {
                ScriptDef def = scripts.get(jsMain);
                if (def != null) {
                    dispatchScene(def, "onSceneStart");
                } else {
                    warn("boot.json 的 jsMain 指向不存在的脚本「" + jsMain + "」");
                }
            }
            // 4) 场景脚本
            // 旧工程（Yarn 剧本）没有 JS 脚本，onStartScript 指向的是 Yarn 剧本名：
            // 这种「一个 JS 脚本都没有」的 Build 不告警，避免无意义噪音。
            if (!sceneScriptName.isEmpty() && !sceneScriptName.equals(jsMain)) {
                ScriptDef def = scripts.get(sceneScriptName);
                if (def != null) {
                    dispatchScene(def, "onSceneStart");
                } else if (!scriptOrder.isEmpty()) {
                    warn("场景 onStartScript 指向不存在的脚本「" + sceneScriptName + "」");
                }
            }

            drainMicrotasks(cx);
            host.scriptLog("[脚本] 已启动：" + scriptOrder.size() + " 个 JS 脚本"
                    + (jsMain.isEmpty() ? "" : "，jsMain=" + jsMain)
                    + (sceneScriptName.isEmpty() ? "" : "，场景脚本=" + sceneScriptName));
        } catch (Throwable t) {
            failed = true;
            recordSwallowed((ScriptDef) null, t);
            host.scriptLog("[脚本] 引擎初始化失败: " + t);
        }
    }

    /**
     * 场景结束：派发场景脚本的 {@code onSceneEnd}。
     *
     * <p>契约（docs/scripting-api.md §1.2）一直承诺有这个回调，但<b>之前从未派发过</b>
     * —— 校验脚本 verify-apidocs 抓出了这个「文档有、代码没有」的假承诺。
     * 现在接在运行时真正关闭的位置：{@code TopDownRuntime.dispose()}（窗口关闭 / 进程退出 / 离屏跑完）。
     *
     * <p>语义：只派发给<b>场景脚本</b>（onStartScript 与 jsMain），不派发给对象脚本 ——
     * 与 onSceneStart 对称。只派发一次（{@link #sceneEnded} 保护）。
     * gl 相关的东西一概不碰，所以 headless 也能安全调用。
     */
    void sceneEnd() {
        if (sceneEnded || !started || failed) {
            return;
        }
        sceneEnded = true;
        Context cx = null;
        try {
            cx = Context.enter();
            prepare(cx);
            if (!jsMain.isEmpty()) {
                ScriptDef def = scripts.get(jsMain);
                if (def != null) {
                    dispatchScene(def, "onSceneEnd");
                }
            }
            if (!sceneScriptName.isEmpty() && !sceneScriptName.equals(jsMain)) {
                ScriptDef def = scripts.get(sceneScriptName);
                if (def != null) {
                    dispatchScene(def, "onSceneEnd");
                }
            }
            drainMicrotasks(cx);
        } catch (Throwable t) {
            recordSwallowed((ScriptDef) null, t);
            host.scriptLog("[脚本] onSceneEnd 异常: " + t);
        } finally {
            if (cx != null) {
                try {
                    Context.exit();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    /** onSceneEnd 是否已派发（避免重复派发）。 */
    private boolean sceneEnded = false;

    private void evalTop(Context cx, ScriptDef def) {
        long t0 = System.nanoTime();
        String prev = currentScript;
        currentScript = def.name;
        try {
            cx.evaluateString(def.scope, def.source, def.name, 1, null);
        } catch (Throwable t) {
            reportError(def, t);
            // 顶层的半截定义可能已生效；继续跑别的脚本，不整体失败。
        } finally {
            currentScript = prev;
            slowCheck(def, t0);
        }
    }

    /**
     * 测试钩子：在某个脚本的作用域里求值一段表达式，结果转成字符串（JSON.stringify 由调用方自己写）。
     * <p>只给无窗口集成测试读玩法状态用（例如 player.js 的 G、world.js 的 W），不进 bwe API。
     * 必须在 update 的同一线程调用；脚本未启动或找不到时返回 null。
     */
    String evalForTest(String scriptName, String expr) {
        if (!started) {
            return null;
        }
        ScriptDef target = null;
        for (ScriptDef def : scriptOrder) {
            if (def.name.equals(scriptName) || def.name.startsWith(scriptName)) {
                target = def;
                break;
            }
        }
        if (target == null || target.scope == null) {
            return null;
        }
        Context cx = Context.enter();
        try {
            prepare(cx);
            Object r = cx.evaluateString(target.scope, expr, "evalForTest", 1, null);
            return r == null ? "null" : Context.toString(r);
        } catch (Throwable t) {
            return "ERROR: " + t;
        } finally {
            Context.exit();
        }
    }

    private void bindSceneObjects() {
        for (Actor a : host.actors) {
            bindActor(a);
        }
    }

    private void bindActor(Actor a) {
        if (a == null || a.o == null) {
            return;
        }
        GameData.RtModule m = scriptModule(a.o);
        if (m == null) {
            return;
        }
        String name = m.str("script", "");
        if (name.isEmpty()) {
            return;
        }
        ScriptDef def = scripts.get(name);
        if (def == null) {
            warn("对象「" + (a.o.name.isEmpty() ? a.o.id : a.o.name) + "」引用了不存在的脚本「" + name + "」");
            return;
        }
        bound.put(a, def);
        boundVersion++;
    }

    private static GameData.RtModule scriptModule(GameData.RtObject o) {
        for (GameData.RtModule m : o.modules) {
            if ("script.js".equals(m.def) || "script".equals(m.def)) {
                return m;
            }
        }
        return null;
    }

    // ---------------- 每帧 ----------------

    private void tick(Context cx, float rawDt) {
        // 键盘快照/边沿
        for (int i = 0; i < held.length; i++) {
            boolean cur = i < host.keys.length && host.keys[i];
            held[i] = cur;
            pressed[i] = cur && !prevHeld[i];
            released[i] = !cur && prevHeld[i];
        }
        frame++;
        float dt = rawDt;
        if (dt < 0f) {
            dt = 0f;
        }
        if (dt > 0.1f) {
            dt = 0.1f;
        }
        frameDt = paused ? 0f : dt * timeScale;
        if (!paused) {
            time += frameDt;
        }

        processClicks();
        processKeys();
        drawCmds.clear();

        if (!paused) {
            fireTimers(cx);
            List<Handler> updateList = handlers("update");
            for (int i = 0; i < handlerCount(updateList); i++) {
                Handler h = handlerAt(updateList, i);
                if (h == null) {
                    continue;
                }
                invoke(h.def, h.fn, h.scope, new Object[]{Double.valueOf(frameDt)});
            }
            for (Map.Entry<Actor, ScriptDef> e : snapshotBound()) {
                Actor a = e.getKey();
                if (a.dead) {
                    continue;
                }
                dispatchObject(a, e.getValue(), "onUpdate", new Object[]{Double.valueOf(frameDt)});
            }
            processZones();
            world.tick(cx);
            // ③ 空间归属解析（新增阶段；老钩子顺序不动）
            runPhaseHooks(frameDt, PHASE_SPATIAL, PHASE_SPATIAL);
            // 涌现式模拟：材质场 → 物理 → 感知/AI，按注册顺序；异常只记日志，不中断游戏。
            for (int i = 0; i < simHooks.size(); i++) {
                try {
                    simHooks.get(i).tick(frameDt);
                } catch (Throwable t) {
                    recordSwallowed("simHooks[" + i + "]", t);
                    host.scriptLog("[脚本] 模拟异常(" + i + "): " + t);
                }
            }
            // ④ 物理之后：碰撞事件 enter/stay/exit 派发
            runPhaseHooks(frameDt, PHASE_EVENTS, PHASE_EVENTS);
            updateAttachments();
            updateCamera(dt);
            if (api != null) {
                api.applyFrameLocks();
            }
        }
        drainMicrotasks(cx);

        // ⑥ 帧末延迟提交：延迟销毁 / 延迟场景切换。暂停时也要跑，
        // 否则「暂停中 requestDestroy」会永远挂着（这是脚本可见语义，必须一致）。
        runPhaseHooks(paused ? 0f : frameDt, PHASE_COMMIT, PHASE_COMMIT);

        System.arraycopy(held, 0, prevHeld, 0, held.length);
        System.arraycopy(mouseNow, 0, mousePrev, 0, mouseNow.length);
        java.util.Arrays.fill(mouseNow, false);
        java.util.Arrays.fill(mousePressed, false);
    }

    /**
     * bound 表的快照，用于「遍历中允许增删」。
     *
     * <p>原来是每帧 {@code new ArrayList<>(bound.entrySet())}：200 个挂脚本的对象
     * 就是每帧一个 200 元素数组 + 200 次 Map.Entry 分配，60fps 下每秒 12000 次分配，
     * 全部压给 GC。现在改成复用缓冲：
     * <ul>
     *   <li>正常帧（表没变）→ 直接返回上一帧的快照，零分配；</li>
     *   <li>表变了（新增/销毁对象）→ 才重建快照。</li>
     * </ul>
     * 语义与原实现一致：遍历期间不会看到本帧新增的对象（这正是快照要保证的）。
     */
    private final List<Map.Entry<Actor, ScriptDef>> boundSnapshotBuf =
            new ArrayList<Map.Entry<Actor, ScriptDef>>();
    private int boundSnapshotVersion = -1;

    private List<Map.Entry<Actor, ScriptDef>> snapshotBound() {
        if (boundSnapshotVersion == boundVersion && !boundSnapshotBuf.isEmpty()) {
            return boundSnapshotBuf;
        }
        boundSnapshotBuf.clear();
        boundSnapshotBuf.addAll(bound.entrySet());
        boundSnapshotVersion = boundVersion;
        return boundSnapshotBuf;
    }

    /** bound 表结构版本号：put/remove 时自增，供快照复用判断。 */
    private int boundVersion = 0;

    private void processClicks() {
        List<Click> batch;
        synchronized (clicks) {
            if (clicks.isEmpty()) {
                return;
            }
            batch = new ArrayList<Click>(clicks);
            clicks.clear();
        }
        for (Click c : batch) {
            lastWorldX = c.wx;
            lastWorldY = c.wy;
            lastScreenX = c.sx;
            lastScreenY = c.sy;
            int button = c.right ? 2 : 0;
            mouseNow[button] = true;
            mousePressed[button] = true;
            Actor hit = topmostAt(c.wx, c.wy);
            Object entityArg = hit == null ? null : api.entity(hit);
            List<Handler> clickList = handlers("click");
            for (int i = 0; i < handlerCount(clickList); i++) {
                Handler h = handlerAt(clickList, i);
                if (h == null) {
                    continue;
                }
                invoke(h.def, h.fn, h.scope, new Object[]{api.clickInfo(c.sx, c.sy, c.wx, c.wy, c.right, entityArg)});
            }
            if (hit != null) {
                api.dispatchEntityEvent(hit, "click", new Object[0]);
                dispatchObject(hit, bound.get(hit), "onClick", new Object[0]);
            }
        }
    }

    private void processKeys() {
        List<Integer> batch;
        synchronized (keyDownQueue) {
            if (keyDownQueue.isEmpty()) {
                return;
            }
            batch = new ArrayList<Integer>(keyDownQueue);
            keyDownQueue.clear();
        }
        for (Integer code : batch) {
            String name = keyName(code);
            List<Handler> keyList = handlers("keydown");
            for (int i = 0; i < handlerCount(keyList); i++) {
                Handler h = handlerAt(keyList, i);
                if (h == null) {
                    continue;
                }
                invoke(h.def, h.fn, h.scope, new Object[]{name, Integer.valueOf(code)});
            }
            for (Map.Entry<Actor, ScriptDef> e : snapshotBound()) {
                if (e.getKey().dead) {
                    continue;
                }
                dispatchObject(e.getKey(), e.getValue(), "onKey", new Object[]{name});
            }
        }
    }

    private void dispatchScene(ScriptDef def, String fnName) {
        if (def == null) {
            return;
        }
        Function f = getFn(def, fnName);
        if (f == null) {
            return;
        }
        invoke(def, f, def.scope, new Object[]{api.context(null)});
    }

    /** 对象脚本回调：args[0] 固定是 ctx。 */
    void dispatchObject(Actor a, ScriptDef def, String fnName, Object[] extra) {
        if (def == null || a == null) {
            return;
        }
        Function f = getFn(def, fnName);
        if (f == null) {
            return;
        }
        Object[] args = new Object[1 + (extra == null ? 0 : extra.length)];
        args[0] = api.context(a);
        if (extra != null) {
            System.arraycopy(extra, 0, args, 1, extra.length);
        }
        invoke(def, f, def.scope, args);
    }

    // ---------------- 计时器 ----------------

    double addTimer(double seconds, boolean repeat, Function fn, ScriptDef def, int times) {
        if (fn == null) {
            return -1;
        }
        double sec = seconds;
        if (Double.isNaN(sec) || sec < 0.0) {
            sec = 0.0;
        }
        Timer t = new Timer();
        t.id = nextTimerId++;
        t.due = time + sec;
        t.interval = (float) sec;
        t.repeat = repeat;
        t.left = repeat ? times : 1;
        t.fn = fn;
        t.def = def;
        timers.add(t);
        return t.id;
    }

    void cancelTimer(double id) {
        for (Timer t : timers) {
            if (t.id == (long) id) {
                t.cancelled = true;
            }
        }
    }

    private void fireTimers(Context cx) {
        if (timers.isEmpty()) {
            return;
        }
        List<Timer> due = new ArrayList<Timer>();
        for (Timer t : timers) {
            if (!t.cancelled && time >= t.due) {
                due.add(t);
            }
        }
        for (Timer t : due) {
            if (t.cancelled) {
                continue;
            }
            invoke(t.def, t.fn, t.def == null ? shared : t.def.scope, new Object[0]);
            if (t.cancelled) {
                continue;
            }
            if (t.repeat) {
                if (t.left > 0) {
                    t.left--;
                }
                if (t.left == 0) {
                    t.cancelled = true;
                } else {
                    float interval = Math.max(0.001f, t.interval);
                    t.due = t.due + interval;
                    // 掉帧时不要一次性补跑一堆。
                    if (t.due < time) {
                        t.due = time + interval;
                    }
                }
            } else {
                t.cancelled = true;
            }
        }
        if (!due.isEmpty()) {
            for (int i = timers.size() - 1; i >= 0; i--) {
                if (timers.get(i).cancelled) {
                    timers.remove(i);
                }
            }
        }
    }

    // ---------------- 事件总线（全局钩子） ----------------

    void addHook(String event, Function fn, ScriptDef def) {
        if (event == null || fn == null) {
            return;
        }
        List<Handler> list = hooks.computeIfAbsent(event, k -> new ArrayList<Handler>());
        list.add(new Handler(fn, def == null ? null : def.scope, def));
    }

    void removeHook(String event, Function fn) {
        List<Handler> list = hooks.get(event);
        if (list == null) {
            return;
        }
        for (int i = list.size() - 1; i >= 0; i--) {
            if (list.get(i).fn == fn) {
                list.remove(i);
            }
        }
    }

    /**
     * 取某事件的处理器列表（<b>只读</b>，遍历请用 {@link #handlerCount} + {@link #handlerAt}）。
     *
     * <p>原实现每次 {@code new ArrayList<>(list)} 拷贝：{@code handlers("update")} 与
     * {@code handlers("draw")} 每帧各调一次 = 每帧 2 次数组分配，纯喂 GC。
     * 但<b>不能</b>简单返回原列表：脚本可以在回调里调 {@code bwe.on(...)} 往同一个列表里加处理器，
     * for-each 遍历活列表会直接抛 ConcurrentModificationException。
     * 所以这里配合下面的下标遍历：ArrayList 按下标读对「遍历中追加」是安全的，
     * 既零分配又不改原有容错性。
     */
    List<Handler> handlers(String event) {
        List<Handler> list = hooks.get(event);
        return list == null ? Collections.<Handler>emptyList() : list;
    }

    static int handlerCount(List<Handler> list) {
        return list.size();
    }

    static Handler handlerAt(List<Handler> list, int i) {
        return i >= 0 && i < list.size() ? list.get(i) : null;
    }

    String currentScriptName() {
        return currentScript == null ? "" : currentScript;
    }

    /** 世界事件总线：bwe.world.on/off/emit。 */
    void addWorldHandler(String event, Function fn, ScriptDef def) {
        if (event == null || event.isEmpty() || fn == null) {
            return;
        }
        List<Handler> list = worldEvents.computeIfAbsent(event, k -> new ArrayList<Handler>());
        list.add(new Handler(fn, def == null ? null : def.scope, def));
    }

    void removeWorldHandler(String event, Function fn) {
        List<Handler> list = worldEvents.get(event);
        if (list == null) {
            return;
        }
        for (int i = list.size() - 1; i >= 0; i--) {
            if (list.get(i).fn == fn) {
                list.remove(i);
            }
        }
    }

    /**
     * 建一个事件载荷对象（测试/诊断用）。
     *
     * <p>需要当前 Rhino {@code Context} 才能建 JS 对象，所以包一层；调用方必须已经在
     * {@code update} 的调用栈里（或自己 {@code Context.enter()}）。
     */
    Object buildEventPayloadForTest(String[] keys, Object[] values) {
        if (api == null) {
            return null;
        }
        return api.buildPayloadForTest(keys, values);
    }

    /** 进入 Rhino Context（测试用；与 update/draw 内部做法一致）。 */
    void enterTestContext() {
        if (Context.getCurrentContext() != null) {
            return;
        }
        Context cx = Context.enter();
        prepare(cx);
    }

    /** 退出 Rhino Context（测试用）。 */
    void exitTestContext() {
        try {
            Context.exit();
        } catch (Throwable ignored) {
        }
    }

    void emitWorld(String event, Object payload) {
        if (event == null || event.isEmpty()) {
            return;
        }
        List<Handler> list = worldEvents.get(event);
        if (list == null) {
            return;
        }
        for (Handler h : new ArrayList<Handler>(list)) {
            invoke(h.def, h.fn, h.scope, new Object[]{payload});
        }
    }

    /** 用当前脚本身份调用一个 JS 函数（draw.world 这类回调）。 */
    Object callValue(Function fn, Object[] args) {
        return invoke(def(currentScript), fn,
                def(currentScript) == null ? shared : def(currentScript).scope, args);
    }

    /** 某对象上挂的脚本（没有返回 null）。 */
    ScriptDef boundScript(Actor a) {
        return a == null ? null : bound.get(a);
    }

    // ---------------- 脚本调用 ----------------

    ScriptDef def(String name) {
        return name == null ? null : scripts.get(name);
    }

    boolean hasScript(String name) {
        return def(name) != null;
    }

    Function getFn(ScriptDef def, String fnName) {
        if (def == null || def.scope == null || fnName == null) {
            return null;
        }
        try {
            Object v = ScriptableObject.getProperty(def.scope, fnName);
            return v instanceof Function ? (Function) v : null;
        } catch (Throwable t) {
            return null;
        }
    }

    Object callNamed(String scriptName, String fnName, Object[] args) {
        ScriptDef def = def(scriptName);
        if (def == null) {
            return null;
        }
        Function f = getFn(def, fnName);
        if (f == null) {
            return null;
        }
        return invoke(def, f, def.scope, args == null ? new Object[0] : args);
    }

    /**
     * 调用一个 JS 函数：计时、错误捕获、当前脚本名维护都在这里。
     * 调用方必须已经进入 Rhino Context。
     */
    Object invoke(ScriptDef def, Function fn, Scriptable thisObj, Object[] args) {
        if (fn == null) {
            return null;
        }
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        Scriptable useThis = thisObj != null ? thisObj : (def != null && def.scope != null ? def.scope : shared);
        String prev = currentScript;
        if (def != null) {
            currentScript = def.name;
        }
        long t0 = System.nanoTime();
        try {
            return fn.call(cx, useThis, useThis, args == null ? new Object[0] : args);
        } catch (Throwable t) {
            reportError(def, t);
            return null;
        } finally {
            currentScript = prev;
            // 先算出耗时，再交给剖析/慢调用检查 —— 这样「记录本身」不会被算进样本
            // （否则剖析开销会随帧耗时一起反馈给自己，读数会虚高）。
            long elapsed = System.nanoTime() - t0;
            metrics.recordCall(def != null ? def.name : currentScript, elapsed);
            slowCheckElapsed(def, elapsed);
        }
    }

    /** 一次调用超出 250ms：告警一次（契约 §4 的无限循环保护）。 */
    private void slowCheck(ScriptDef def, long startNanos) {
        slowCheckElapsed(def, System.nanoTime() - startNanos);
    }

    /** 与 {@link #slowCheck} 同义，但耗时已由调用方算好（剖析已经用过同一段时间）。 */
    private void slowCheckElapsed(ScriptDef def, long elapsedNanos) {
        if (def == null) {
            return;
        }
        long ms = elapsedNanos / 1_000_000L;
        if (ms > 250 && !def.slowWarned) {
            def.slowWarned = true;
            host.scriptLog("[脚本] " + def.name + " 单帧执行超过 250ms（" + ms + "ms），可能存在死循环");
        }
    }

    private void drainMicrotasks(Context cx) {
        try {
            cx.processMicrotasks();
        } catch (Throwable t) {
            reportError(def(currentScript), t);
        }
    }

    // ---------------- 错误 ----------------

    void reportError(ScriptDef def, Throwable t) {
        if (t == null) {
            return;
        }
        String name = def != null ? def.name : (currentScript == null || currentScript.isEmpty() ? "?" : currentScript);
        // 行号取不到时用 -1（契约 §6 明确要求 -1，而不是 0）：
        // 0 会被 UI 误当成"第 0 行"显示，-1 才是"未知"的通用约定。
        int line = -1;
        String msg = null;
        if (t instanceof RhinoException) {
            RhinoException re = (RhinoException) t;
            line = re.lineNumber();
            if (t instanceof JavaScriptException) {
                Object value = ((JavaScriptException) t).getValue();
                Object m = value instanceof Scriptable
                        ? ScriptableObject.getProperty((Scriptable) value, "message") : null;
                msg = ScriptJs.str(m, null);
                if (msg == null || msg.isEmpty()) {
                    msg = re.details();
                }
            } else if (t instanceof EcmaError) {
                msg = ((EcmaError) t).getErrorMessage();
            } else if (t instanceof EvaluatorException) {
                msg = re.getMessage();
            } else {
                msg = re.details();
            }
        } else if (t instanceof StackOverflowError) {
            msg = "递归过深（StackOverflow）";
        } else {
            msg = t.toString();
        }
        // ① 先进环形缓冲：**必须早于下面的去重返回**，否则"同一处重复抛 N 次"
        // 就只剩一条 count=1，编辑器看不到"这条在反复炸"（这是可观测性的核心诉求）。
        // 缓冲内部按 script+line+message 去重自增 count，所以这里多调也不会爆内存。
        metrics.recordError(name, oneLine(msg), line, frame);
        // ② 日志侧保持原有语义：同一脚本同一行只 print 一次，避免每帧刷屏。
        String key = name + ":" + line;
        if (!reportedErrors.add(key)) {
            return;
        }
        String one = oneLine(msg);
        lastErrorLine = "[脚本错误] " + name + ":" + line + ": " + one;
        host.scriptLog(lastErrorLine);
    }

    private static String oneLine(String s) {
        if (s == null) {
            return "";
        }
        String v = s.replace("\r", " ").replace("\n", " / ");
        if (v.length() > 300) {
            v = v.substring(0, 300) + "…";
        }
        return v;
    }

    /** 自检/调试用：最近一条脚本错误行（格式已按契约拼好）。 */
    String lastErrorLineForTest() {
        return lastErrorLine;
    }

    /**
     * 把一处「被吞掉的异常」登记进可观测性缓冲，<b>但不写日志</b>。
     *
     * <p>这是本轮的关键纪律：原 {@code catch (Throwable)} 的既有行为必须**一个字不变**
     * （原来 print 什么就还 print 什么，原来不 print 的就还不 print），
     * 只额外做一次 O(1) 摊还的入队。否则会凭空多出日志行，
     * 打乱现有测试按行计数的断言（{@code ScriptSelfTest} 就按行数断言错误去重）。
     *
     * <p>与 {@link #reportError} 的分工：{@code reportError} 负责「脚本执行出错」的完整语义
     * （拼契约格式日志 + 去重 + 入队）；本方法只负责入队，给那些"本来就静默吞掉"的位置用。
     */
    void recordSwallowed(ScriptDef def, Throwable t) {
        if (t == null) {
            return;
        }
        String name = def != null ? def.name
                : (currentScript == null || currentScript.isEmpty() ? "?" : currentScript);
        int line = t instanceof RhinoException ? ((RhinoException) t).lineNumber() : -1;
        String msg = t instanceof RhinoException ? ((RhinoException) t).details() : t.toString();
        metrics.recordError(name, oneLine(msg), line, frame);
    }

    /** 同上，但脚本名直接给（宿主侧子系统的异常没有 ScriptDef 上下文）。 */
    void recordSwallowed(String scriptName, Throwable t) {
        if (t == null) {
            return;
        }
        int line = t instanceof RhinoException ? ((RhinoException) t).lineNumber() : -1;
        String msg = t instanceof RhinoException ? ((RhinoException) t).details() : t.toString();
        metrics.recordError(scriptName == null || scriptName.isEmpty() ? "?" : scriptName,
                oneLine(msg), line, frame);
    }

    /**
     * 清空日志侧的「同一脚本同一行只报一次」去重表（{@code bwe.debug.clearErrors} 联动）。
     *
     * <p>为什么必须联动：用户清空错误列表的意图是「从现在开始重新观察」。
     * 如果只清环形缓冲、留着去重表，那么下次同一处再抛异常时日志不会再写，
     * 脚本侧 {@code bwe.debug.errors()} 也不会再收到 —— 等于清空一次就永久失声。
     */
    void clearReportedErrors() {
        reportedErrors.clear();
    }

    /**
     * 诊断文件的根目录 = Build 的父目录（工程根）。
     *
     * <p>与 {@code bwe.save} 的沙箱口径一致：脚本看到的相对路径都相对工程根，
     * 而不是相对 Build（Build 是生成物目录，往里面写用户文件不符合直觉）。
     */
    java.io.File buildRootForDiagnostics() {
        if (buildDir == null) {
            return new java.io.File(".");
        }
        java.io.File parent = buildDir.getParentFile();
        return parent == null ? buildDir : parent;
    }

    // ---------------- 日志 ----------------

    void log(String msg) {
        String prefix = currentScript == null || currentScript.isEmpty() ? "[脚本] " : "[脚本] " + currentScript + ": ";
        host.scriptLog(prefix + msg);
    }

    void logError(String msg) {
        String prefix = currentScript == null || currentScript.isEmpty() ? "[脚本] " : "[脚本] " + currentScript + ": ";
        host.scriptLog(prefix + "[错误] " + msg);
    }

    private void warn(String msg) {
        host.scriptLog("[脚本] " + msg);
    }

    // ---------------- 世界操作 ----------------

    Scriptable context(Actor self) {
        return api.context(self);
    }

    Scriptable entity(Actor a) {
        return api.entity(a);
    }

    /** 按世界坐标点命中实体（从最上层往下，顺序与绘制相反）。 */
    Actor topmostAt(float wx, float wy) {
        List<Actor> sorted = new ArrayList<Actor>(host.actors);
        Collections.sort(sorted, new Comparator<Actor>() {
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
        });
        for (int i = sorted.size() - 1; i >= 0; i--) {
            Actor a = sorted.get(i);
            if (a.dead || !a.o.visible) {
                continue;
            }
            float w = host.drawWidth(a);
            float h = host.drawHeight(a);
            if (Math.abs(wx - a.x) <= w / 2f && Math.abs(wy - a.y) <= h / 2f) {
                return a;
            }
        }
        return null;
    }

    Actor findPlayerActor() {
        for (Actor a : host.actors) {
            if (a.o.tags.contains("玩家") || a.o.tags.contains("Player") || a.o.tags.contains("player")) {
                return a;
            }
        }
        for (Actor a : host.actors) {
            if ("ACTOR".equalsIgnoreCase(a.o.kind)) {
                return a;
            }
        }
        return null;
    }

    /** 脚本 spawn：复用宿主 spawnScripted，然后绑定脚本/模块/标签，派发 onStart。 */
    Actor spawnScripted(float x, float y, String assetName, String name, String kind,
                                       int z, float halfW, float halfH, String scriptName,
                                       List<String> tags, List<GameData.RtModule> modules) {
        Actor a = host.spawnScripted(x, y, assetName, name, kind, z, halfW, halfH);
        if (a == null) {
            return null;
        }
        if (tags != null) {
            a.o.tags.addAll(tags);
        }
        if (modules != null) {
            a.o.modules.addAll(modules);
        }
        // ⚠ 血量必须在这里初始化：宿主 spawnScripted 只建 Actor（hpMax 默认 10），
        // 而场景对象走的是 TopDownRuntime.spawn() 里那段 combat.health 读取。
        // 脚本 spawn / prefab spawn 走的是这条路径，之前没人读模块 → 任何带
        // combat.health{hp:40} 的预制体实例出来都是 hpMax=10（端到端验证抓到的真 bug）。
        applyHealthModule(a);
        if (scriptName != null && !scriptName.isEmpty()) {
            GameData.RtModule m = new GameData.RtModule();
            m.def = "script.js";
            m.when = "ALWAYS";
            m.params.put("script", scriptName);
            a.o.modules.add(m);
            ScriptDef def = scripts.get(scriptName);
            if (def == null) {
                warn("spawn 引用了不存在的脚本「" + scriptName + "」");
            } else {
                bound.put(a, def);
                boundVersion++;
                dispatchObject(a, def, "onStart", new Object[0]);
            }
        }
        api.invalidate(a);
        world.refreshAfterSpawn(a);
        return a;
    }

    /**
     * 从对象身上的 {@code combat.health} / {@code fight.hp} 模块读取血量上限并初始化。
     *
     * <p>与 {@code TopDownRuntime.spawn()}（场景对象路径）用同一份语义，保证
     * 「编辑器里摆的对象」和「脚本 spawn / prefab spawn 出来的实体」血量行为一致。
     * 运行时新增模块（{@code e.addModule("combat.health", ...)}）也要调它。
     */
    void applyHealthModule(Actor a) {
        if (a == null) {
            return;
        }
        GameData.RtModule hp = host.data.module(a.o, "combat.health", "fight.hp");
        if (hp == null) {
            return;
        }
        a.hpMax = Math.max(1f, hp.num("maxHealth", hp.num("hp", a.hpMax)));
        a.hp = a.hpMax;
    }

    /** 脚本销毁实体：先派发 onDestroy / "destroy" 事件，再从宿主移除。 */
    void destroyEntity(Actor a) {
        if (a == null || a.dead) {
            return;
        }
        dispatchObject(a, bound.get(a), "onDestroy", new Object[0]);
        api.dispatchEntityEvent(a, "destroy", new Object[0]);
        detachActor(a);
        host.requestDestroy(a);
    }

    /**
     * 把一个实体从所有<b>脚本侧</b>表里摘掉（不碰宿主 actors 列表）。
     *
     * <p>两个调用方：
     * <ul>
     *   <li>{@link #destroyEntity} —— 脚本主动销毁，摘表后交给宿主的延迟销毁队列；</li>
     *   <li>{@link TopDownRuntime#commitDestroy()} —— 帧末真正移除前，再兜底摘一次
     *       （场景切换、物理/场系统直接置 dead 的路径也必须走到这里）。</li>
     * </ul>
     * 幂等：对已经摘过的 Actor 重复调用无副作用。
     */
    void detachActor(Actor a) {
        if (a == null) {
            return;
        }
        if (bound.remove(a) != null) {
            boundVersion++;
        }
        for (int i = attachments.size() - 1; i >= 0; i--) {
            if (attachments.get(i).owner == a) {
                attachments.remove(i);
            }
        }
        for (int i = follows.size() - 1; i >= 0; i--) {
            if (follows.get(i).actor == a) {
                follows.remove(i);
            }
        }
        if (interactActor == a) {
            interactActor = null;
        }
        if (cameraTarget == a) {
            cameraTarget = null;
        }
        if (api != null) {
            api.invalidate(a);
        }
    }

    /**
     * 场景卸载：把<b>所有</b>与上一场景绑定的脚本侧状态清空。
     *
     * <p>由 {@link TopDownRuntime#commitSceneSwitch()} 调用，顺序是
     * 「宿主换 scene 数据 → unloadScene() → spawn() → buildWorldForScene() → reloadScene()」。
     * 这里<b>不</b>派发 onDestroy（对象是被场景切换整体丢弃的，不是"死亡"；
     * 契约 §1.2 的 onSceneEnd 只给场景脚本，已由 sceneEnd() 单独负责）。
     *
     * <p>清空清单（每一项都有断言，见 docs/open-world-architecture.md §5.4）：
     * 定时器 / 全局钩子 / 世界事件 / 实体事件 / 实体包装 / 子精灵 / 跟随 /
     * 交互回调 / 刷怪器 / 提交队列 / 脚本绑定表 / 相机状态 / 绘制列表。
     */
    void unloadScene() {
        for (Timer t : timers) {
            t.cancelled = true;
        }
        timers.clear();
        hooks.clear();
        worldEvents.clear();
        bound.clear();
        boundVersion++;
        attachments.clear();
        follows.clear();
        spawners.clear();
        interactHandlers.clear();
        interactActor = null;
        prompt = null;
        drawCmds.clear();
        cameraTarget = null;
        worldDrawDepth = 0;
        frame = 0;
        time = 0;
        // 实体包装 / 实体事件表 / 子精灵句柄 / 相机接管标志 / prefab 实例表都在 ScriptApi 里，
        // 由它自己的 clearSceneState 统一清（那里能看到所有私有表）。
        if (api != null) {
            api.clearSceneState();
        }
        if (world != null) {
            world.clearSceneState();
        }
        // 新增子系统的场景态（每个 install() 注册的模块自己负责清）
        clearSubsystemSceneState();
        // 让新场景的脚本重新走 onStart / onSceneStart
        sceneStartDone = false;
    }

    /**
     * 让所有开放世界子系统清掉自己的场景态。
     *
     * <p>为什么集中在这里而不是各自注册 cleanup 钩子：卸载顺序必须<b>确定</b>
     * （空间 → 碰撞 → 车辆 → 战斗 → 路网 → 场景），否则会出现"车辆还在查已被清空的路网"。
     * 这里用固定顺序逐个调，任何一个抛异常都不影响后面的（容错与 install 时一致）。
     */
    private void clearSubsystemSceneState() {
        clearOne("spatial", new Runnable() {
            @Override
            public void run() {
                if (ScriptSpatial.LAST != null) {
                    ScriptSpatial.LAST.clearSceneState();
                }
            }
        });
        clearOne("collision", new Runnable() {
            @Override
            public void run() {
                if (ScriptCollision.LAST != null) {
                    ScriptCollision.LAST.clearSceneState();
                }
            }
        });
        clearOne("vehicle", new Runnable() {
            @Override
            public void run() {
                if (ScriptVehicle.LAST != null) {
                    ScriptVehicle.LAST.clearSceneState();
                }
            }
        });
        clearOne("combat", new Runnable() {
            @Override
            public void run() {
                if (ScriptCombat.LAST != null) {
                    ScriptCombat.LAST.clearSceneState();
                }
            }
        });
        clearOne("road", new Runnable() {
            @Override
            public void run() {
                if (ScriptRoad.LAST != null) {
                    ScriptRoad.LAST.clearSceneState();
                }
            }
        });
        clearOne("actions", new Runnable() {
            @Override
            public void run() {
                if (ScriptActions.LAST != null) {
                    ScriptActions.LAST.clearSceneState();
                }
            }
        });
        clearOne("debug", new Runnable() {
            @Override
            public void run() {
                if (ScriptDebug.LAST != null) {
                    ScriptDebug.LAST.clearSceneState();
                }
            }
        });
        clearOne("scene", new Runnable() {
            @Override
            public void run() {
                if (ScriptScene.LAST != null) {
                    ScriptScene.LAST.clearSceneState();
                }
            }
        });
        // 剖析开关是**工程级**的（用户在测帧耗时，切场景不该把测量关掉），
        // 所以这里刻意不清 bwe.prof 的状态 —— 只保留这条注释说明为什么它不在清单里。
    }

    private void clearOne(String name, Runnable body) {
        try {
            body.run();
        } catch (Throwable t) {
            recordSwallowed(name, t);
            host.scriptLog("[脚本] " + name + " 场景清理失败: " + t);
        }
    }

    /**
     * 新场景的瓦片图 / 网格必须按新 scene 的逻辑尺寸重建
     * （{@link ScriptWorld} 的 cols/rows 在构造期就定死了，切场景后必须换一个新实例）。
     */
    void buildWorldForScene() {
        this.world = new ScriptWorld(this);
        this.world.buildTileMap(host.actors);
    }

    /** 新场景的对象就绪后重新绑定对象脚本并派发生命周期。 */
    void reloadScene() {
        if (!started || failed) {
            return;
        }
        Context cx = null;
        try {
            cx = Context.enter();
            prepare(cx);
            bindSceneObjects();
            for (Map.Entry<Actor, ScriptDef> e
                    : new ArrayList<Map.Entry<Actor, ScriptDef>>(bound.entrySet())) {
                dispatchObject(e.getKey(), e.getValue(), "onStart", new Object[0]);
            }
            sceneStartDone = true;
            if (!sceneScriptName.isEmpty()) {
                ScriptDef def = scripts.get(sceneScriptName);
                if (def != null) {
                    dispatchScene(def, "onSceneStart");
                }
            }
            drainMicrotasks(cx);
        } catch (Throwable t) {
            recordSwallowed((ScriptDef) null, t);
            host.scriptLog("[脚本] 场景重载异常: " + t);
        } finally {
            if (cx != null) {
                try {
                    Context.exit();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    /** reloadScene 是否已在当前场景派发过（避免重复 onStart）。 */
    private boolean sceneStartDone = false;

    // ---------------- 子精灵 ----------------

    private void updateAttachments() {
        for (int i = attachments.size() - 1; i >= 0; i--) {
            Attachment at = attachments.get(i);
            if (at.owner == null || at.owner.dead) {
                attachments.remove(i);
            }
        }
    }

    private void drawAttachments(GL2 gl) {
        if (attachments.isEmpty()) {
            return;
        }
        gl.glPushMatrix();
        try {
            host.view.applyGL(gl);
            for (Attachment at : attachments) {
                if (at.owner == null || at.owner.dead || !at.owner.o.visible) {
                    continue;
                }
                float x = at.owner.x + at.dx;
                float y = at.owner.y + at.dy;
                Texture tex = null;
                try {
                    tex = host.firstTextureForName(at.assetName);
                } catch (Throwable t) {
                    recordSwallowed("drawAttachments", t);
                }
                if (tex == null) {
                    continue;
                }
                float w = at.w > 0f ? at.w : tex.w;
                float h = at.h > 0f ? at.h : tex.h;
                host.drawTexture(gl, tex, x, y, w, h, at.rotation, at.alpha, 0f, 0f, 1f, 1f);
            }
        } finally {
            gl.glPopMatrix();
        }
    }

    // ---------------- 相机 ----------------

    void cameraFollow(Actor target, float smooth, float lookAhead) {
        cameraTarget = target;
        cameraSmooth = smooth;
        cameraLookAhead = lookAhead;
        host.scriptCameraControl = true;
    }

    void cameraSetPos(float x, float y) {
        host.scriptCameraControl = true;
        host.view.camX = x;
        host.view.camY = y;
    }

    void cameraSetZoom(float z) {
        host.scriptCameraControl = true;
        host.view.zoom = Viewport.clampZoom(z);
    }

    void cameraShake(float strength, float duration) {
        shakeStrength = Math.max(0f, strength);
        shakeDuration = Math.max(0.01f, duration);
        shakeTime = shakeDuration;
    }

    void cameraBounds(float x, float y, float w, float h) {
        cameraBounds = new float[]{x, y, w, h};
        host.scriptCameraControl = true;
    }

    void cameraClearBounds() {
        cameraBounds = null;
    }

    private void updateCamera(float dt) {
        Viewport view = host.view;
        if (cameraTarget != null && !cameraTarget.dead) {
            float tx = cameraTarget.x + cameraTarget.faceX * cameraLookAhead;
            float ty = cameraTarget.y + cameraTarget.faceY * cameraLookAhead;
            if (cameraSmooth <= 0f) {
                view.camX = tx;
                view.camY = ty;
            } else {
                float k = Math.min(1f, cameraSmooth * (dt * 60f));
                view.camX += (tx - view.camX) * k;
                view.camY += (ty - view.camY) * k;
            }
            if (cameraBounds != null) {
                clampCameraToBounds();
            } else {
                view.clampCamera();
            }
        }
        if (shakeTime > 0f) {
            shakeTime -= dt;
            if (shakeTime <= 0f) {
                shakeTime = 0f;
                view.shakeX = 0f;
                view.shakeY = 0f;
            } else {
                float s = shakeStrength * (shakeTime / shakeDuration);
                view.shakeX = (random.nextFloat() * 2f - 1f) * s;
                view.shakeY = (random.nextFloat() * 2f - 1f) * s;
            }
        }
    }

    private void clampCameraToBounds() {
        Viewport view = host.view;
        float[] b = cameraBounds;
        if (b == null) {
            return;
        }
        float halfW = view.viewW / (2f * view.zoom);
        float halfH = view.viewH / (2f * view.zoom);
        if (b[2] <= halfW * 2f) {
            view.camX = b[0] + b[2] / 2f;
        } else {
            view.camX = Math.max(b[0] + halfW, Math.min(b[0] + b[2] - halfW, view.camX));
        }
        if (b[3] <= halfH * 2f) {
            view.camY = b[1] + b[3] / 2f;
        } else {
            view.camY = Math.max(b[1] + halfH, Math.min(b[1] + b[3] - halfH, view.camY));
        }
    }

    // ---------------- 键名 ----------------

    private static final Map<String, Integer> KEY_NAMES = new HashMap<String, Integer>();

    static {
        for (char c = 'A'; c <= 'Z'; c++) {
            KEY_NAMES.put("Key" + c, KeyEvent.VK_A + (c - 'A'));
            KEY_NAMES.put(String.valueOf(c), KeyEvent.VK_A + (c - 'A'));
            KEY_NAMES.put(String.valueOf(c).toLowerCase(), KeyEvent.VK_A + (c - 'A'));
        }
        for (char c = '0'; c <= '9'; c++) {
            KEY_NAMES.put("Digit" + c, KeyEvent.VK_0 + (c - '0'));
            KEY_NAMES.put(String.valueOf(c), KeyEvent.VK_0 + (c - '0'));
        }
        KEY_NAMES.put("Space", KeyEvent.VK_SPACE);
        KEY_NAMES.put(" ", KeyEvent.VK_SPACE);
        KEY_NAMES.put("Enter", KeyEvent.VK_ENTER);
        KEY_NAMES.put("Escape", KeyEvent.VK_ESCAPE);
        KEY_NAMES.put("Esc", KeyEvent.VK_ESCAPE);
        KEY_NAMES.put("Tab", KeyEvent.VK_TAB);
        KEY_NAMES.put("Backspace", KeyEvent.VK_BACK_SPACE);
        KEY_NAMES.put("Shift", KeyEvent.VK_SHIFT);
        KEY_NAMES.put("ShiftLeft", KeyEvent.VK_SHIFT);
        KEY_NAMES.put("Control", KeyEvent.VK_CONTROL);
        KEY_NAMES.put("ControlLeft", KeyEvent.VK_CONTROL);
        KEY_NAMES.put("Alt", KeyEvent.VK_ALT);
        KEY_NAMES.put("AltLeft", KeyEvent.VK_ALT);
        KEY_NAMES.put("ArrowLeft", KeyEvent.VK_LEFT);
        KEY_NAMES.put("ArrowRight", KeyEvent.VK_RIGHT);
        KEY_NAMES.put("ArrowUp", KeyEvent.VK_UP);
        KEY_NAMES.put("ArrowDown", KeyEvent.VK_DOWN);
        KEY_NAMES.put("Left", KeyEvent.VK_LEFT);
        KEY_NAMES.put("Right", KeyEvent.VK_RIGHT);
        KEY_NAMES.put("Up", KeyEvent.VK_UP);
        KEY_NAMES.put("Down", KeyEvent.VK_DOWN);
        KEY_NAMES.put("Minus", KeyEvent.VK_MINUS);
        KEY_NAMES.put("Equal", KeyEvent.VK_EQUALS);
        KEY_NAMES.put("Comma", KeyEvent.VK_COMMA);
        KEY_NAMES.put("Period", KeyEvent.VK_PERIOD);
        KEY_NAMES.put("Slash", KeyEvent.VK_SLASH);
        KEY_NAMES.put("Semicolon", KeyEvent.VK_SEMICOLON);
        KEY_NAMES.put("Quote", KeyEvent.VK_QUOTE);
        KEY_NAMES.put("BracketLeft", KeyEvent.VK_OPEN_BRACKET);
        KEY_NAMES.put("BracketRight", KeyEvent.VK_CLOSE_BRACKET);
        KEY_NAMES.put("Backslash", KeyEvent.VK_BACK_SLASH);
        KEY_NAMES.put("Backquote", KeyEvent.VK_BACK_QUOTE);
    }

    /** 键名 → AWT keyCode；支持 "Space"/" "/32、"KeyW"/"W"/87。未知返回 -1。 */
    static int keyCode(String key) {
        if (key == null) {
            return -1;
        }
        String k = key.trim();
        if (k.isEmpty()) {
            return -1;
        }
        try {
            return Integer.parseInt(k);
        } catch (NumberFormatException ignored) {
        }
        Integer code = KEY_NAMES.get(k);
        if (code != null) {
            return code;
        }
        code = KEY_NAMES.get(k.toUpperCase());
        if (code != null) {
            return code;
        }
        // "F1".."F12"
        if (k.length() <= 3 && (k.charAt(0) == 'F' || k.charAt(0) == 'f')) {
            try {
                int n = Integer.parseInt(k.substring(1));
                if (n >= 1 && n <= 12) {
                    return KeyEvent.VK_F1 + n - 1;
                }
            } catch (NumberFormatException ignored) {
            }
        }
        return -1;
    }

    /** AWT keyCode → 脚本友好的键名（用于 onKey / 全局 keydown 钩子）。 */
    static String keyName(int code) {
        if (code <= 0) {
            return "";
        }
        if (code >= KeyEvent.VK_A && code <= KeyEvent.VK_Z) {
            return "Key" + (char) ('A' + (code - KeyEvent.VK_A));
        }
        if (code >= KeyEvent.VK_0 && code <= KeyEvent.VK_9) {
            return "Digit" + (char) ('0' + (code - KeyEvent.VK_0));
        }
        switch (code) {
            case KeyEvent.VK_SPACE:
                return "Space";
            case KeyEvent.VK_ENTER:
                return "Enter";
            case KeyEvent.VK_ESCAPE:
                return "Escape";
            case KeyEvent.VK_TAB:
                return "Tab";
            case KeyEvent.VK_BACK_SPACE:
                return "Backspace";
            case KeyEvent.VK_SHIFT:
                return "Shift";
            case KeyEvent.VK_CONTROL:
                return "Control";
            case KeyEvent.VK_ALT:
                return "Alt";
            case KeyEvent.VK_LEFT:
                return "ArrowLeft";
            case KeyEvent.VK_RIGHT:
                return "ArrowRight";
            case KeyEvent.VK_UP:
                return "ArrowUp";
            case KeyEvent.VK_DOWN:
                return "ArrowDown";
            case KeyEvent.VK_MINUS:
                return "Minus";
            case KeyEvent.VK_EQUALS:
                return "Equal";
            case KeyEvent.VK_COMMA:
                return "Comma";
            case KeyEvent.VK_PERIOD:
                return "Period";
            case KeyEvent.VK_SLASH:
                return "Slash";
            default:
                return "KeyCode" + code;
        }
    }

    // ---------------- 自检辅助 ----------------

    int debugDrawCount() {
        return drawCmds.size();
    }

    List<ScriptRender.Cmd> debugDrawCommands() {
        return drawCmds;
    }

    private void processZones() {
        // 触发区（kind=ZONE）：玩家进出时派发对象脚本 onEnter/onLeave 与实体 "enter"/"leave"。
        Actor player = findPlayerActor();
        if (player == null) {
            return;
        }
        for (Actor a : new ArrayList<Actor>(host.actors)) {
            if (a.dead || a.o == null || !"ZONE".equalsIgnoreCase(a.o.kind)) {
                continue;
            }
            float w = host.drawWidth(a);
            float h = host.drawHeight(a);
            boolean inside = Math.abs(player.x - a.x) <= w / 2f && Math.abs(player.y - a.y) <= h / 2f;
            Boolean was = zoneInside.get(a);
            boolean before = was != null && was;
            if (inside && !before) {
                zoneInside.put(a, Boolean.TRUE);
                Object other = api.entity(player);
                api.dispatchEntityEvent(a, "enter", new Object[]{other});
                dispatchObject(a, bound.get(a), "onEnter", new Object[]{other});
            } else if (!inside && before) {
                zoneInside.put(a, Boolean.FALSE);
                Object other = api.entity(player);
                api.dispatchEntityEvent(a, "leave", new Object[]{other});
                dispatchObject(a, bound.get(a), "onLeave", new Object[]{other});
            }
        }
    }

    private final Map<Actor, Boolean> zoneInside = new IdentityHashMap<Actor, Boolean>();
}
