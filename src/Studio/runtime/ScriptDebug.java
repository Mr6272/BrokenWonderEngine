package Studio.runtime;

import org.mozilla.javascript.Scriptable;

/**
 * 调试绘制命名空间 {@code bwe.debug}（契约 {@code docs/api/lifecycle.md} 附录；
 * 任务书 §8「调试绘制」）。
 *
 * <h3>解决什么问题</h3>
 * 开放世界出问题时的第一句话永远是"我看不到它到底在哪"：碰撞盒、寻路路径、空间边界、
 * 楼层层高。没有调试绘制就只能靠 print 猜。
 *
 * <h3>层归属</h3>
 * L2 通用框架。纯绘制，不改任何游戏状态 —— 关掉之后游戏行为必须逐像素一致。
 *
 * <h3>实现方式</h3>
 * 复用 {@code bwe.draw} 的同一条立即模式管线（{@link ScriptRender}），
 * 所以不需要新的 GL 路径、不会与合批冲突。绘制指令只在 {@code onUpdate}/{@code draw} 期间有效。
 */
final class ScriptDebug {

    static ScriptDebug LAST;

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final TopDownRuntime host;
    private final Scriptable scope;
    private final ScriptJs.Flex ns;

    /** 全局开关（{@code debug.on()/off()}）；打开后才允许逐项绘制。 */
    private boolean enabled;
    private boolean drawColliders;
    private boolean drawPaths;
    private boolean drawZones;
    private boolean drawNav;

    private ScriptDebug(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.host = api.hostRef();
        this.ns = (ScriptJs.Flex) api.newObj();
        this.scope = ns.getParentScope();
    }

    static void install(ScriptApi api) {
        ScriptDebug d = new ScriptDebug(api);
        d.build();
        api.attach("debug", d.ns);
        LAST = d;
    }

    private void build() {
        api.addMethod(ns, "on", (cx, thisObj, args) -> {
            enabled = true;
            return Boolean.TRUE;
        });
        api.addMethod(ns, "off", (cx, thisObj, args) -> {
            enabled = false;
            drawColliders = false;
            drawPaths = false;
            drawZones = false;
            drawNav = false;
            return Boolean.TRUE;
        });
        api.addMethod(ns, "enabled", (cx, thisObj, args) -> Boolean.valueOf(enabled));

        // colliders(bool) —— 画所有有碰撞盒的实体的框
        api.addMethod(ns, "colliders", (cx, thisObj, args) -> {
            drawColliders = ScriptJs.isMissing(ScriptJs.arg(args, 0))
                    || ScriptJs.bool(ScriptJs.arg(args, 0), true);
            return Boolean.TRUE;
        });
        // paths(bool) —— 画正在沿路径跟随的实体的路径
        api.addMethod(ns, "paths", (cx, thisObj, args) -> {
            drawPaths = ScriptJs.isMissing(ScriptJs.arg(args, 0))
                    || ScriptJs.bool(ScriptJs.arg(args, 0), true);
            return Boolean.TRUE;
        });
        // zones(bool) —— 画空间区域边界
        api.addMethod(ns, "zones", (cx, thisObj, args) -> {
            drawZones = ScriptJs.isMissing(ScriptJs.arg(args, 0))
                    || ScriptJs.bool(ScriptJs.arg(args, 0), true);
            return Boolean.TRUE;
        });
        // nav(bool) —— 画瓦片阻挡图（小地图开销大，慎用）
        api.addMethod(ns, "nav", (cx, thisObj, args) -> {
            drawNav = ScriptJs.isMissing(ScriptJs.arg(args, 0))
                    || ScriptJs.bool(ScriptJs.arg(args, 0), true);
            return Boolean.TRUE;
        });

        // box(x,y,w,h,color) / circle(x,y,r,color) / line(x1,y1,x2,y2,color) —— 单次绘制
        api.addMethod(ns, "box", (cx, thisObj, args) -> {
            if (!enabled) {
                return null;
            }
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            float w = ScriptJs.fnum(ScriptJs.arg(args, 2), 0f);
            float h = ScriptJs.fnum(ScriptJs.arg(args, 3), 0f);
            String color = ScriptJs.str(ScriptJs.arg(args, 4), "#00ff88");
            engine.render.worldRect(x, y, w, h, color, 1f, 1f);
            return null;
        });
        api.addMethod(ns, "circle", (cx, thisObj, args) -> {
            if (!enabled) {
                return null;
            }
            float x = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            float r = ScriptJs.fnum(ScriptJs.arg(args, 2), 0f);
            String color = ScriptJs.str(ScriptJs.arg(args, 3), "#00ff88");
            engine.render.worldCircle(x, y, r, color, 1f);
            return null;
        });
        api.addMethod(ns, "line", (cx, thisObj, args) -> {
            if (!enabled) {
                return null;
            }
            float x1 = ScriptJs.fnum(ScriptJs.arg(args, 0), 0f);
            float y1 = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            float x2 = ScriptJs.fnum(ScriptJs.arg(args, 2), 0f);
            float y2 = ScriptJs.fnum(ScriptJs.arg(args, 3), 0f);
            String color = ScriptJs.str(ScriptJs.arg(args, 4), "#00ff88");
            engine.render.worldLine(x1, y1, x2, y2, color, 1f, 1f);
            return null;
        });

        // actor(e, color) —— 画一个实体的碰撞框
        api.addMethod(ns, "actor", (cx, thisObj, args) -> {
            if (!enabled) {
                return null;
            }
            TopDownRuntime.Actor a = api.actorOf(ScriptJs.arg(args, 0));
            if (a == null || a.dead || a.o == null) {
                return null;
            }
            String color = ScriptJs.str(ScriptJs.arg(args, 1), "#00ff88");
            engine.render.worldRect(a.x - a.o.halfW, a.y - a.o.halfH,
                    a.o.halfW * 2f, a.o.halfH * 2f, color, 1f, 1f);
            return null;
        });

        // stats() → {actors, colliders, vehicles, zones, drawCommands}
        api.addMethod(ns, "stats", (cx, thisObj, args) -> {
            ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
            ScriptJs.put(o, "actors", Double.valueOf(host.actors.size()));
            ScriptJs.put(o, "pendingDestroy", Double.valueOf(host.pendingDestroyCount()));
            ScriptJs.put(o, "sceneEpoch", Double.valueOf(host.sceneEpoch));
            int colliders = 0;
            java.util.List<TopDownRuntime.Actor> snap = api.actorsSnapshot();
            for (int i = 0; i < snap.size(); i++) {
                TopDownRuntime.Actor a = snap.get(i);
                if (a.o != null && a.o.halfW > 0f && a.o.halfH > 0f) {
                    colliders++;
                }
            }
            ScriptJs.put(o, "colliders", Double.valueOf(colliders));
            ScriptJs.put(o, "vehicles", Double.valueOf(ScriptVehicle.LAST == null ? 0 : ScriptVehicle.LAST.countValue()));
            ScriptJs.put(o, "spatialZones", Double.valueOf(ScriptSpatial.LAST == null ? 0 : ScriptSpatial.LAST.zoneCountValue()));
            ScriptJs.put(o, "drawCommands", Double.valueOf(engine.drawCmds.size()));
            ScriptJs.put(o, "enabled", Boolean.valueOf(enabled));
            return o;
        });
    }

    /** 每帧自动绘制（由 ScriptEngine.draw 之前调用）。 */
    void autoDraw() {
        if (!enabled) {
            return;
        }
        if (drawColliders) {
            java.util.List<TopDownRuntime.Actor> snap = api.actorsSnapshot();
            for (int i = 0; i < snap.size(); i++) {
                TopDownRuntime.Actor a = snap.get(i);
                if (a.dead || a.o == null || a.o.halfW <= 0f || a.o.halfH <= 0f) {
                    continue;
                }
                String color = a.trigger ? "#ffcc00" : "#00ff88";
                engine.render.worldRect(a.x - a.o.halfW, a.y - a.o.halfH,
                        a.o.halfW * 2f, a.o.halfH * 2f, color, 1f, 1f);
            }
        }
        if (drawZones && ScriptSpatial.LAST != null) {
            ScriptSpatial.LAST.drawDebug(engine.render);
        }
        if (drawPaths && engine.world != null) {
            engine.world.drawDebugPaths(engine.render);
        }
    }

    boolean isEnabled() {
        return enabled;
    }

    // ---------------- 包内测试入口 ----------------
    //
    // 不是脚本 API（不走 api.addMethod）。

    void onTest() {
        enabled = true;
    }

    void offTest() {
        enabled = false;
        drawColliders = false;
        drawPaths = false;
        drawZones = false;
        drawNav = false;
    }

    /** 场景卸载：开关是工程级的，但逐项绘制会被重置。 */
    void clearSceneState() {
        drawColliders = false;
        drawPaths = false;
        drawZones = false;
        drawNav = false;
    }
}
