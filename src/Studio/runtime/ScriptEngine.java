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
        final TopDownRuntime.Actor owner;
        long id;
        String assetName = "";
        float dx;
        float dy;
        int z;
        float rotation;
        float alpha = 1f;
        float w;
        float h;

        Attachment(TopDownRuntime.Actor owner) {
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
    private final Map<TopDownRuntime.Actor, ScriptDef> bound = new LinkedHashMap<TopDownRuntime.Actor, ScriptDef>();

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
    TopDownRuntime.Actor cameraTarget;
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
    TopDownRuntime.Actor interactActor;
    long nextSpawnerId = 1;

    /** 世界事件总线（bwe.world.on/off/emit）。 */
    private final Map<String, List<Handler>> worldEvents = new HashMap<String, List<Handler>>();

    // 错误去重
    private final Set<String> reportedErrors = new HashSet<String>();
    private String currentScript = "";
    private String lastErrorLine = "";

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

    /** 当前脚本 API（子系统用它挂命名空间、包 Entity）。 */
    ScriptApi api() {
        return api;
    }

    /** 每帧：计时器 + 全局 update 钩子 + 对象 onUpdate + 微任务。 */
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
            tick(cx, dt);
        } catch (Throwable t) {
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
            for (Handler h : handlers("draw")) {
                invoke(h.def, h.fn, h.scope, new Object[0]);
            }
            drawAttachments(gl);
            if (render != null) {
                render.render(gl, drawCmds);
            }
            drawCmds.clear();
        } catch (Throwable t) {
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
            for (Map.Entry<TopDownRuntime.Actor, ScriptDef> e : new ArrayList<Map.Entry<TopDownRuntime.Actor, ScriptDef>>(bound.entrySet())) {
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
            host.scriptLog("[脚本] 引擎初始化失败: " + t);
        }
    }

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

    private void bindSceneObjects() {
        for (TopDownRuntime.Actor a : host.actors) {
            bindActor(a);
        }
    }

    private void bindActor(TopDownRuntime.Actor a) {
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
            for (Handler h : handlers("update")) {
                invoke(h.def, h.fn, h.scope, new Object[]{Double.valueOf(frameDt)});
            }
            for (Map.Entry<TopDownRuntime.Actor, ScriptDef> e : snapshotBound()) {
                TopDownRuntime.Actor a = e.getKey();
                if (a.dead) {
                    continue;
                }
                dispatchObject(a, e.getValue(), "onUpdate", new Object[]{Double.valueOf(frameDt)});
            }
            processZones();
            world.tick(cx);
            // 涌现式模拟：材质场 → 物理 → 感知/AI，按注册顺序；异常只记日志，不中断游戏。
            for (int i = 0; i < simHooks.size(); i++) {
                try {
                    simHooks.get(i).tick(frameDt);
                } catch (Throwable t) {
                    host.scriptLog("[脚本] 模拟异常(" + i + "): " + t);
                }
            }
            updateAttachments();
            updateCamera(dt);
            if (api != null) {
                api.applyFrameLocks();
            }
        }
        drainMicrotasks(cx);

        System.arraycopy(held, 0, prevHeld, 0, held.length);
        System.arraycopy(mouseNow, 0, mousePrev, 0, mouseNow.length);
        java.util.Arrays.fill(mouseNow, false);
        java.util.Arrays.fill(mousePressed, false);
    }

    private List<Map.Entry<TopDownRuntime.Actor, ScriptDef>> snapshotBound() {
        return new ArrayList<Map.Entry<TopDownRuntime.Actor, ScriptDef>>(bound.entrySet());
    }

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
            TopDownRuntime.Actor hit = topmostAt(c.wx, c.wy);
            Object entityArg = hit == null ? null : api.entity(hit);
            for (Handler h : handlers("click")) {
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
            for (Handler h : handlers("keydown")) {
                invoke(h.def, h.fn, h.scope, new Object[]{name, Integer.valueOf(code)});
            }
            for (Map.Entry<TopDownRuntime.Actor, ScriptDef> e : snapshotBound()) {
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
    void dispatchObject(TopDownRuntime.Actor a, ScriptDef def, String fnName, Object[] extra) {
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

    List<Handler> handlers(String event) {
        List<Handler> list = hooks.get(event);
        return list == null ? Collections.<Handler>emptyList() : new ArrayList<Handler>(list);
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
    ScriptDef boundScript(TopDownRuntime.Actor a) {
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
            slowCheck(def, t0);
        }
    }

    /** 一次调用超出 250ms：告警一次（契约 §4 的无限循环保护）。 */
    private void slowCheck(ScriptDef def, long startNanos) {
        if (def == null) {
            return;
        }
        long ms = (System.nanoTime() - startNanos) / 1_000_000L;
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
        int line = 0;
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

    Scriptable context(TopDownRuntime.Actor self) {
        return api.context(self);
    }

    Scriptable entity(TopDownRuntime.Actor a) {
        return api.entity(a);
    }

    /** 按世界坐标点命中实体（从最上层往下，顺序与绘制相反）。 */
    TopDownRuntime.Actor topmostAt(float wx, float wy) {
        List<TopDownRuntime.Actor> sorted = new ArrayList<TopDownRuntime.Actor>(host.actors);
        Collections.sort(sorted, new Comparator<TopDownRuntime.Actor>() {
            @Override
            public int compare(TopDownRuntime.Actor a, TopDownRuntime.Actor b) {
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
            TopDownRuntime.Actor a = sorted.get(i);
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

    TopDownRuntime.Actor findPlayerActor() {
        for (TopDownRuntime.Actor a : host.actors) {
            if (a.o.tags.contains("玩家") || a.o.tags.contains("Player") || a.o.tags.contains("player")) {
                return a;
            }
        }
        for (TopDownRuntime.Actor a : host.actors) {
            if ("ACTOR".equalsIgnoreCase(a.o.kind)) {
                return a;
            }
        }
        return null;
    }

    /** 脚本 spawn：复用宿主 spawnScripted，然后绑定脚本/模块/标签，派发 onStart。 */
    TopDownRuntime.Actor spawnScripted(float x, float y, String assetName, String name, String kind,
                                       int z, float halfW, float halfH, String scriptName,
                                       List<String> tags, List<GameData.RtModule> modules) {
        TopDownRuntime.Actor a = host.spawnScripted(x, y, assetName, name, kind, z, halfW, halfH);
        if (a == null) {
            return null;
        }
        if (tags != null) {
            a.o.tags.addAll(tags);
        }
        if (modules != null) {
            a.o.modules.addAll(modules);
        }
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
                dispatchObject(a, def, "onStart", new Object[0]);
            }
        }
        api.invalidate(a);
        world.refreshAfterSpawn(a);
        return a;
    }

    /** 脚本销毁实体：先派发 onDestroy / "destroy" 事件，再从宿主移除。 */
    void destroyEntity(TopDownRuntime.Actor a) {
        if (a == null || a.dead) {
            return;
        }
        dispatchObject(a, bound.get(a), "onDestroy", new Object[0]);
        api.dispatchEntityEvent(a, "destroy", new Object[0]);
        bound.remove(a);
        for (int i = attachments.size() - 1; i >= 0; i--) {
            if (attachments.get(i).owner == a) {
                attachments.remove(i);
            }
        }
        host.destroyActor(a);
        api.invalidate(a);
    }

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
                TopDownRuntime.Texture tex = null;
                try {
                    tex = host.firstTextureForName(at.assetName);
                } catch (Throwable ignored) {
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

    void cameraFollow(TopDownRuntime.Actor target, float smooth, float lookAhead) {
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
        TopDownRuntime.Actor player = findPlayerActor();
        if (player == null) {
            return;
        }
        for (TopDownRuntime.Actor a : new ArrayList<TopDownRuntime.Actor>(host.actors)) {
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

    private final Map<TopDownRuntime.Actor, Boolean> zoneInside = new IdentityHashMap<TopDownRuntime.Actor, Boolean>();
}
