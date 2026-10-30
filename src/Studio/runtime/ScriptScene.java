package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 场景管理命名空间 {@code bwe.scene}（契约见 {@code docs/api/scene.md}；
 * 设计见 {@code docs/open-world-architecture.md} §5 / {@code docs/open-world-api-roadmap.md} §1.1）。
 *
 * <h3>解决什么问题</h3>
 * 审计发现运行时的场景在构造函数里就<b>写死</b>成 {@code data.scenes.get(0)}
 * （{@code TopDownRuntime.java:465}），一张图跑到底，没有室内/室外切换、没有分块加载。
 * 本命名空间提供 加载 / 卸载 / 切换 / 生命周期回调。
 *
 * <h3>生命周期（脚本可见语义）</h3>
 * <pre>
 *   bwe.scene.switchTo("室内")            // 只登记请求，返回 true
 *        │  （同一帧内继续跑，脚本不会被打断）
 *        ▼
 *   帧末 commitSceneSwitch()
 *        ├─ 校验目标场景存在（不存在 → 不动当前场景，返回 false + 日志）
 *        ├─ scripts.unloadScene()       清定时器/事件/实体包装/子精灵/跟随/prefab 实例
 *        ├─ 换 scene 数据 + spawn()      重建全部 Actor
 *        ├─ scripts.buildWorldForScene() 重建瓦片图/网格
 *        └─ scripts.reloadScene()       重新绑定对象脚本 + onStart + 场景脚本 onSceneStart
 *        ▼
 *   脚本的 onSceneChanged 回调（如果注册了）
 * </pre>
 *
 * <h3>错误处理</h3>
 * 未知场景名 → 返回 {@code false} 且<b>不改变当前场景</b>（先校验后提交）。
 * 读盘失败 → 同上。切换请求的重复调用只有最后一次生效。
 *
 * <h3>与已有 API 的关系</h3>
 * {@code bwe.world.*} 一律作用于<b>当前</b>场景；切换后自动指向新场景，不需要脚本重新取句柄。
 * {@code bwe.world.scene} 的返回结构不变（只多一个 {@code epoch} 字段）。
 */
final class ScriptScene {

    /** 最近一次安装的实例（诊断/自检用）。 */
    static ScriptScene LAST;

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final TopDownRuntime host;
    private final Scriptable scope;
    private final ScriptJs.Flex ns;

    /** 场景切换回调（onChanged），按注册顺序派发。 */
    private final List<Holder> changedHandlers = new ArrayList<Holder>();
    /** 切换前回调（onWillChange）。 */
    private final List<Holder> willHandlers = new ArrayList<Holder>();

    /** 已派发 over 的 epoch（防止同一帧重复派发 onChanged）。 */
    private int notifiedEpoch = -1;

    /** 一个 JS 回调 + 它属于哪个脚本（用于场景卸载时按脚本清理）。 */
    private static final class Holder {
        final Function fn;
        final ScriptEngine.ScriptDef def;

        Holder(Function fn, ScriptEngine.ScriptDef def) {
            this.fn = fn;
            this.def = def;
        }
    }

    private ScriptScene(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.host = api.hostRef();
        this.ns = (ScriptJs.Flex) api.newObj();
        this.scope = ns.getParentScope();
    }

    /** 注册 {@code bwe.scene} 并挂上帧末的 onChanged 派发。 */
    static void install(ScriptApi api) {
        ScriptScene s = new ScriptScene(api);
        s.build();
        api.attach("scene", s.ns);
        api.engineRef().addPhaseHook(ScriptEngine.PHASE_COMMIT, s.commHook);
        LAST = s;
    }

    private final ScriptEngine.PhaseHook commHook = new ScriptEngine.PhaseHook() {
        @Override
        public void tick(float dt) {
            notifyIfSwitched();
        }
    };

    // ---------------- 命名空间 ----------------

    private void build() {
        // list() → [{name, file, width, height, index, current}]
        api.addMethod(ns, "list", (cx, thisObj, args) -> listScenes());

        // current() → {name, index, epoch, width, height, tileSize} 或 null
        api.addMethod(ns, "current", (cx, thisObj, args) -> currentScene());

        // count() → 场景总数
        api.addMethod(ns, "count", (cx, thisObj, args) ->
                Integer.valueOf(host.sceneRefs() == null ? 0 : host.sceneRefs().size()));

        // has(name) → bool
        api.addMethod(ns, "has", (cx, thisObj, args) ->
                Boolean.valueOf(findRef(ScriptJs.str(ScriptJs.arg(args, 0), "")) != null));

        // switchTo(name) → bool（只登记，帧末生效）
        api.addMethod(ns, "switchTo", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            boolean ok = host.requestSceneSwitch(name);
            if (!ok) {
                engine.log("[场景] switchTo 失败：不存在场景「" + name + "」（当前仍是「"
                        + host.currentSceneName() + "」）");
            }
            return Boolean.valueOf(ok);
        });

        // load(name) 是 switchTo 的别名（语义：加载并切过去）
        api.addMethod(ns, "load", (cx, thisObj, args) -> {
            String name = ScriptJs.str(ScriptJs.arg(args, 0), "");
            boolean ok = host.requestSceneSwitch(name);
            if (!ok) {
                engine.log("[场景] load 失败：不存在场景「" + name + "」");
            }
            return Boolean.valueOf(ok);
        });

        // pending() → 待切换的场景名（没有就 null）
        api.addMethod(ns, "pending", (cx, thisObj, args) ->
                host.sceneSwitchPending() ? host.pendingSceneName() : null);

        // epoch() → 场景代数（每次真切换 +1）
        api.addMethod(ns, "epoch", (cx, thisObj, args) -> Integer.valueOf(host.sceneEpoch));

        // on("changed"|"willChange", fn) / off(fn)
        api.addMethod(ns, "on", (cx, thisObj, args) -> {
            String evt = ScriptJs.str(ScriptJs.arg(args, 0), "");
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            if (f == null) {
                return null;
            }
            ScriptEngine.ScriptDef def = engine.def(engine.currentScriptName());
            if (isWill(evt)) {
                willHandlers.add(new Holder(f, def));
            } else if (isChanged(evt)) {
                changedHandlers.add(new Holder(f, def));
            } else {
                engine.log("[场景] on 未知事件「" + evt + "」，只认 willChange / changed");
                return null;
            }
            return f;
        });
        api.addMethod(ns, "off", (cx, thisObj, args) -> {
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 0));
            if (f == null) {
                return Boolean.FALSE;
            }
            boolean removed = removeHolder(willHandlers, f) | removeHolder(changedHandlers, f);
            return Boolean.valueOf(removed);
        });
    }

    private static boolean isWill(String evt) {
        return "willChange".equalsIgnoreCase(evt) || "will".equalsIgnoreCase(evt)
                || "before".equalsIgnoreCase(evt);
    }

    private static boolean isChanged(String evt) {
        return "changed".equalsIgnoreCase(evt) || "change".equalsIgnoreCase(evt)
                || "after".equalsIgnoreCase(evt);
    }

    private static boolean removeHolder(List<Holder> list, Function f) {
        for (int i = list.size() - 1; i >= 0; i--) {
            if (list.get(i).fn == f) {
                list.remove(i);
                return true;
            }
        }
        return false;
    }

    // ---------------- 数据 ----------------

    private GameData.SceneRef findRef(String name) {
        if (name == null || name.isEmpty() || host.sceneRefs() == null) {
            return null;
        }
        String t = name.trim();
        for (int i = 0; i < host.sceneRefs().size(); i++) {
            GameData.SceneRef r = host.sceneRefs().get(i);
            if (t.equals(r.name)) {
                return r;
            }
        }
        // 允许按文件名（不带后缀 / 不带目录）指代
        for (int i = 0; i < host.sceneRefs().size(); i++) {
            GameData.SceneRef r = host.sceneRefs().get(i);
            String f = r.file;
            if (f == null || f.isEmpty()) {
                continue;
            }
            String noExt = f;
            int dot = noExt.lastIndexOf('.');
            if (dot > 0) {
                noExt = noExt.substring(0, dot);
            }
            String base = noExt;
            int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
            if (slash >= 0) {
                base = base.substring(slash + 1);
            }
            if (base.equals(t) || noExt.equals(t)) {
                return r;
            }
        }
        return null;
    }

    private Scriptable listScenes() {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return null;
        }
        List<Object> out = new ArrayList<Object>();
        List<GameData.SceneRef> refs = host.sceneRefs();
        if (refs != null) {
            int cur = host.currentSceneIndex();
            for (int i = 0; i < refs.size(); i++) {
                ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
                ScriptJs.put(o, "name", refs.get(i).name);
                ScriptJs.put(o, "file", refs.get(i).file);
                ScriptJs.put(o, "width", Double.valueOf(refs.get(i).width));
                ScriptJs.put(o, "height", Double.valueOf(refs.get(i).height));
                ScriptJs.put(o, "index", Double.valueOf(i));
                ScriptJs.put(o, "current", Boolean.valueOf(i == cur));
                out.add(o);
            }
        }
        return cx.newArray(scope, out.toArray());
    }

    private Scriptable currentScene() {
        List<GameData.SceneRef> refs = host.sceneRefs();
        if (refs == null || refs.isEmpty()) {
            return null;
        }
        int idx = host.currentSceneIndex();
        GameData.SceneRef r = idx >= 0 ? refs.get(idx) : null;
        if (r == null) {
            return null;
        }
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        ScriptJs.put(o, "name", r.name);
        ScriptJs.put(o, "file", r.file);
        ScriptJs.put(o, "index", Double.valueOf(idx));
        ScriptJs.put(o, "epoch", Double.valueOf(host.sceneEpoch));
        ScriptJs.put(o, "width", Double.valueOf(r.width));
        ScriptJs.put(o, "height", Double.valueOf(r.height));
        ScriptJs.put(o, "tileSize", Double.valueOf(host.data == null ? 32 : host.data.tileSize));
        return o;
    }

    // ---------------- 派发 ----------------

    /**
     * 场景真的切过之后派发 {@code onChanged}。
     *
     * <p>放在 COMMIT 阶段的<b>最后</b>（{@link ScriptScene} 注册在
     * {@link TopDownRuntime} 的 commitSceneSwitch 之后），所以脚本收到回调时
     * 新场景的实体、瓦片图、脚本绑定都已经就绪 —— 可以直接 {@code bwe.world.find(...)}。
     */
    private void notifyIfSwitched() {
        int epoch = host.sceneEpoch;
        if (epoch == notifiedEpoch) {
            return;
        }
        notifiedEpoch = epoch;
        if (changedHandlers.isEmpty() && willHandlers.isEmpty()) {
            return;
        }
        Context cx = null;
        try {
            cx = Context.enter();
            cx.setLanguageVersion(Context.VERSION_ES6);
            cx.setOptimizationLevel(-1);
            ScriptJs.Flex payload = (ScriptJs.Flex) api.newObj();
            ScriptJs.put(payload, "name", host.currentSceneName());
            ScriptJs.put(payload, "epoch", Double.valueOf(epoch));
            for (int i = 0; i < changedHandlers.size(); i++) {
                Holder h = changedHandlers.get(i);
                try {
                    Context.getCurrentContext().evaluateString(h.def == null ? scope : h.def.scope,
                            "", "noop", 1, null);
                    h.fn.call(cx, scope, scope, new Object[]{payload});
                } catch (Throwable t) {
                    host.scriptLog("[场景] onChanged 回调异常: " + t);
                }
            }
        } catch (Throwable t) {
            host.scriptLog("[场景] onChanged 派发异常: " + t);
        } finally {
            if (cx != null) {
                try {
                    Context.exit();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    /** 场景卸载：清掉本文件注册的回调（回调属于场景，不属于工程）。 */
    void clearSceneState() {
        changedHandlers.clear();
        willHandlers.clear();
        notifiedEpoch = -1;
    }
}
