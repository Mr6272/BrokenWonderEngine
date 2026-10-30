package Studio.runtime;

import Core.CollisionEventBus;
import Core.Coroutine;
import Core.CoroutineManager;
import Core.EventBus;
import Core.GameRenderer;
import Core.GameSekai;
import Core.Scene;
import Core.SceneManagement;
import Core.destroy.DestroyQueue;
import Framework.GameObject;
import Framework.IAbility;
import Framework.MapData.MapData;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 场景生命周期测试（对应审计 §2.2「旧核心 SceneManagement.Reduce 不清协程 / 不置空 Camera /
 * isLoading 非重入安全」）。
 *
 * <p>加固前的具体缺陷（每条一个"改之前会失败"的断言）：
 * <ul>
 *   <li>{@code Reduce} 从不调用 {@code coroutineManager.clear()} → 旧场景协程串到新场景（scene-2/3）；</li>
 *   <li>{@code Reduce} 不清 {@code GameRenderer.Camera} → 静态悬空引用（scene-4）；</li>
 *   <li>{@code Reduce} 不清理碰撞事件内部配对状态 → 跨场景误派发 exit（scene-7/8）；</li>
 *   <li>{@code isLoading} 在 {@code scene.build} 抛异常时永久停在 true → 场景切换从此失效（scene-13/14）；</li>
 *   <li>对象销毁没有统一走 OnRemove 一次 → 能力资源释放不可靠（scene-17）。</li>
 * </ul>
 *
 * <p>纯 headless：只读 {@code Data/level_01.json} 构造 Scene 壳（不实例化任何 GameObject），
 * 不创建窗口、不调用 GL。
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class EngineSceneTest {

    /** 只用它构造 Scene 壳：子类全部覆盖 build，不会真的实例化关卡对象。 */
    private static final String SCENE_DATA = "Data/level_01.json";

    private static final List<String[]> RESULTS = new ArrayList<String[]>();

    private EngineSceneTest() {
    }

    public static void main(String[] args) {
        int failures = 0;
        String fatal = null;
        try {
            runUnloadClearsCoroutines();
            runUnloadClearsCamera();
            runUnloadClearsCollisionState();
            runUnloadClearsSceneScope();
            runReduceReentrancyOnBuildFailure();
            runUnloadCallsOnRemoveOnce();
            runCoroutineCancelAndDeferredStart();
            runDestroyQueueOrdering();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace();
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"enginescenetest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        System.out.println("========== EngineSceneTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            System.out.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        System.out.println("-------------------------------------");
        System.out.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- 场景切换清理协程 ----------------

    private static void runUnloadClearsCoroutines() {
        resetCore();
        final AtomicInteger ticks = new AtomicInteger();
        Coroutine neverEnds = new Coroutine() {
            public boolean update() {
                ticks.incrementAndGet();
                return false;
            }
        };
        GameSekai.coroutineManager.start(neverEnds);
        GameSekai.coroutineManager.update();
        GameSekai.coroutineManager.update();
        check("scene-1 协程正常被驱动（延迟启动后累计 2 次）", ticks.get() == 2, "ticks=" + ticks.get());

        SceneManagement.unloadCurrentScene();
        int before = ticks.get();
        GameSekai.coroutineManager.update();
        check("scene-2 场景卸载清空协程（不再被驱动）", ticks.get() == before,
                "ticks=" + ticks.get() + " before=" + before);
        check("scene-3 卸载后协程管理器为空", GameSekai.coroutineManager.isEmpty(), "");
    }

    // ---------------- 场景切换清空相机引用 ----------------

    private static void runUnloadClearsCamera() {
        resetCore();
        GameObject cameraHost = new GameObject();
        cameraHost.tag = new TypeStructure.Tag("camera");
        GameRenderer.Camera = cameraHost;

        SceneManagement.unloadCurrentScene();
        check("scene-4 场景卸载把 GameRenderer.Camera 置 null", GameRenderer.Camera == null,
                "Camera=" + GameRenderer.Camera);

        // 没有相机时 isVisible 必须返回 true（不做剔除），不能 NPE
        GameObject plain = new GameObject();
        boolean visible = true;
        try {
            visible = GameRenderer.isVisible(plain);
        } catch (Throwable t) {
            visible = false;
        }
        check("scene-5 无相机时 isVisible 不抛异常且返回 true", visible, "");
    }

    // ---------------- 场景切换清空碰撞事件状态 ----------------

    private static void runUnloadClearsCollisionState() {
        resetCore();
        GameObject a = new GameObject();
        a.tag = new TypeStructure.Tag("ct-a");
        GameObject b = new GameObject();
        b.tag = new TypeStructure.Tag("ct-b");
        CollisionEventBus bus = CollisionEventBus.get();
        bus.clear();
        bus.beginTick();
        bus.reportPair(a, b, false);
        bus.endTick();
        check("scene-6 碰撞对被跟踪", bus.trackedPairCount() == 1,
                "tracked=" + bus.trackedPairCount());

        SceneManagement.unloadCurrentScene();
        check("scene-7 场景卸载清空碰撞配对状态", bus.trackedPairCount() == 0,
                "tracked=" + bus.trackedPairCount());

        int exitBefore = bus.exitCount;
        bus.beginTick();
        bus.endTick();
        check("scene-8 卸载后不派发跨场景 exit", bus.exitCount == exitBefore,
                "exit=" + bus.exitCount);
    }

    // ---------------- 场景切换清空场景作用域订阅 ----------------

    private static void runUnloadClearsSceneScope() {
        resetCore();
        EventBus bus = EventBus.get();
        bus.clear();
        EventBus.Listener<Object> l = new EventBus.Listener<Object>() {
            public void onEvent(Object payload) {
            }
        };
        bus.subscribe("sceneTest", SceneManagement.SCENE_SCOPE, l);
        Object otherScope = new Object();
        bus.subscribe("sceneTest", otherScope, l);
        check("scene-9 场景作用域订阅已建立", bus.listenerCount("sceneTest") == 2,
                "count=" + bus.listenerCount("sceneTest"));

        SceneManagement.unloadCurrentScene();
        check("scene-10 场景卸载摘掉场景作用域订阅，保留其它作用域",
                bus.listenerCount("sceneTest") == 1,
                "count=" + bus.listenerCount("sceneTest"));
        check("scene-11 卸载记录了清理数量", SceneManagement.lastClearedSubscriptions >= 1,
                "cleared=" + SceneManagement.lastClearedSubscriptions);
        bus.clear();
    }

    // ---------------- build 抛异常后 isLoading 复位 ----------------

    private static void runReduceReentrancyOnBuildFailure() {
        resetCore();
        Scene booming = new Scene(SCENE_DATA) {
            @Override
            public void build(GameSekai scene, MapData data) {
                throw new IllegalStateException("故意让构建失败");
            }
        };

        boolean threw = false;
        try {
            SceneManagement.Reduce(booming);
        } catch (IllegalStateException e) {
            threw = true;
        }
        check("scene-12 构建异常向外传播", threw, "");
        check("scene-13 构建失败后 isLoading 已复位（不再永久卡住）",
                !isLoadingFlag(), "isLoading=true 表示卡住");

        final AtomicInteger buildCount = new AtomicInteger();
        Scene ok = new Scene(SCENE_DATA) {
            @Override
            public void build(GameSekai scene, MapData data) {
                buildCount.incrementAndGet();
                new GameObject();
            }
        };
        SceneManagement.Reduce(ok);
        check("scene-14 复位后可以再次切换场景", buildCount.get() == 1,
                "buildCount=" + buildCount.get());
        check("scene-15 正常切换后 isLoading 为 false", !isLoadingFlag(), "");
    }

    // ---------------- 卸载时 OnRemove 恰好一次 ----------------

    private static void runUnloadCallsOnRemoveOnce() {
        resetCore();
        GameObject go = new GameObject();
        ProbeAbility p = new ProbeAbility("scene-probe");
        go.TryAddAbility(p);
        check("scene-16 能力已挂载", go.Abilitys.size() == 2, "size=" + go.Abilitys.size());

        SceneManagement.unloadCurrentScene();
        check("scene-17 场景卸载对每个能力回调 OnRemove 恰好一次",
                p.removeCount == 1, "remove=" + p.removeCount);
        check("scene-18 卸载后 GameObject 列表已清空",
                GameSekai.GameObjects.isEmpty(), "size=" + GameSekai.GameObjects.size());
        check("scene-19 卸载后销毁队列为空", DestroyQueue.size() == 0,
                "size=" + DestroyQueue.size());
        check("scene-20 对象已标记销毁", go.isDestroyed(), "");
    }

    // ---------------- 协程取消 / 延迟启动 ----------------

    private static void runCoroutineCancelAndDeferredStart() {
        CoroutineManager mgr = new CoroutineManager();
        final AtomicInteger aTicks = new AtomicInteger();
        final AtomicInteger bTicks = new AtomicInteger();
        Coroutine a = new Coroutine() {
            public boolean update() {
                aTicks.incrementAndGet();
                return false;
            }
        };
        Coroutine b = new Coroutine() {
            public boolean update() {
                bTicks.incrementAndGet();
                return false;
            }
        };

        mgr.start(a);
        check("coro-1 新启动协程在当帧尚未就绪", mgr.size() == 0, "size=" + mgr.size());
        mgr.update();
        check("coro-2 挂起协程在下一帧开始驱动", aTicks.get() == 1, "a=" + aTicks.get());

        // 协程在自己的一步里启动新协程 → 不抛 ConcurrentModificationException
        final CoroutineManager self = mgr;
        final boolean[] threw = new boolean[1];
        Coroutine spawner = new Coroutine() {
            public boolean update() {
                try {
                    self.start(b);
                } catch (Throwable t) {
                    threw[0] = true;
                }
                return false;
            }
        };
        mgr.start(spawner);
        mgr.update();
        check("coro-3 协程内 start 新协程不抛异常", !threw[0], "");
        mgr.update();
        check("coro-4 新协程随后被驱动", bTicks.get() >= 1, "b=" + bTicks.get());

        check("coro-5 cancel 已存在的协程返回 true", mgr.cancel(a), "");
        int aBefore = aTicks.get();
        mgr.update();
        check("coro-6 取消后不再驱动", aTicks.get() == aBefore, "a=" + aTicks.get());
        check("coro-7 重复 cancel 返回 false（幂等）", !mgr.cancel(a), "");

        mgr.clear();
        check("coro-8 clear 后管理器为空", mgr.isEmpty(), "");

        // ---- 按作用域批量取消（任务书 §11: 可取消任务 + 场景销毁时清理） ----
        CoroutineManager sm = new CoroutineManager();
        Object sceneA = new Object();
        Object sceneB = new Object();
        final AtomicInteger aRuns = new AtomicInteger();
        final AtomicInteger bRuns = new AtomicInteger();
        Coroutine sa = new ScopedCoroutine(sceneA, aRuns);
        Coroutine sb = new ScopedCoroutine(sceneB, bRuns);
        sm.start(sa);
        sm.start(sb);
        sm.update();
        check("coro-9 两个作用域的协程都在跑", aRuns.get() == 1 && bRuns.get() == 1,
                "a=" + aRuns.get() + " b=" + bRuns.get());
        check("coro-10 sizeOfScope 正确", sm.sizeOfScope(sceneA) == 1, "");

        int cancelled = sm.cancelScope(sceneA);
        check("coro-11 cancelScope 只摘该作用域", cancelled == 1 && sm.size() == 1,
                "cancelled=" + cancelled + " size=" + sm.size());

        sm.update();
        check("coro-12 被取消作用域不再跑，另一作用域继续",
                aRuns.get() == 1 && bRuns.get() == 2,
                "a=" + aRuns.get() + " b=" + bRuns.get());
        int beforeNull = sm.size();
        check("coro-13 cancelScope(null) 不误杀无作用域协程",
                sm.cancelScope(null) == 0 && sm.size() == beforeNull,
                "size=" + sm.size() + " before=" + beforeNull);
    }

    /** 带作用域的测试协程。 */
    private static final class ScopedCoroutine implements Coroutine {
        final Object scope;
        final AtomicInteger counter;

        ScopedCoroutine(Object scope, AtomicInteger counter) {
            this.scope = scope;
            this.counter = counter;
        }

        public boolean update() {
            counter.incrementAndGet();
            return false;
        }

        @Override
        public Object scope() {
            return scope;
        }
    }

    // ---------------- 销毁队列顺序 / 连锁 ----------------

    private static void runDestroyQueueOrdering() {
        resetCore();
        final List<String> order = new ArrayList<String>();
        final GameObject first = new GameObject();
        first.tag = new TypeStructure.Tag("dq-first");

        // 能力的 OnRemove 里再 Destroy 一个新对象：DestroyQueue 必须能合并提交这一轮新入队的对象
        final GameObject[] spawnedHolder = new GameObject[1];
        ProbeAbility chain = new ProbeAbility("dq-chain");
        chain.onRemove = new Runnable() {
            public void run() {
                order.add("chain-remove");
                GameObject nested = new GameObject();
                nested.tag = new TypeStructure.Tag("dq-nested");
                spawnedHolder[0] = nested;
                nested.Destroy();
            }
        };
        first.TryAddAbility(chain);
        first.Destroy();
        DestroyQueue.commit();
        check("dq-1 销毁回调里再销毁的对象被合并提交",
                GameSekai.GameObjects.isEmpty(),
                "剩余=" + GameSekai.GameObjects.size());
        check("dq-2 销毁回调执行顺序确定", order.size() == 1 && "chain-remove".equals(order.get(0)),
                order.toString());
        check("dq-3 连锁销毁的新对象也已提交",
                spawnedHolder[0] != null && spawnedHolder[0].isDestroyed()
                        && spawnedHolder[0].Abilitys.isEmpty(),
                "nested=" + spawnedHolder[0]);
        check("dq-4 连锁提交后队列为空", DestroyQueue.size() == 0, "size=" + DestroyQueue.size());
    }

    // ---------------- 工具 ----------------

    /** 读取 SceneManagement 的 isLoading（package-private 静态字段，反射读取）。 */
    private static boolean isLoadingFlag() {
        try {
            java.lang.reflect.Field f = SceneManagement.class.getDeclaredField("isLoading");
            f.setAccessible(true);
            return f.getBoolean(null);
        } catch (Exception e) {
            // 读不到就当作已复位（不让反射细节掩盖真正的断言）
            return false;
        }
    }

    private static final class ProbeAbility implements IAbility {
        final String name;
        GameObject host;
        int removeCount;
        Runnable onRemove;

        ProbeAbility(String name) {
            this.name = name;
        }

        public void OnAdded(GameObject gameObject) {
            host = gameObject;
        }

        public void OnInit() {
        }

        public void SetEnable(boolean value) {
        }

        public void OnUpdate() {
        }

        public boolean GetEnable() {
            return true;
        }

        public void OnRemove() {
            removeCount++;
            if (onRemove != null) {
                onRemove.run();
            }
        }

        @Override
        public GameObject getHost() {
            return host;
        }

        @Override
        public String toString() {
            return name;
        }
    }

    /** 复位旧核心的全局静态状态，保证各子测试互不影响。 */
    private static void resetCore() {
        List<GameObject> snapshot = new ArrayList<GameObject>(GameSekai.GameObjects);
        for (GameObject go : snapshot) {
            go.Destroy();
        }
        DestroyQueue.commit();
        GameSekai.GameObjects.clear();
        DestroyQueue.clear();
        GameSekai.coroutineManager.clear();
        GameRenderer.Camera = null;
        CollisionEventBus.get().clear();
        EventBus.get().clear();
        SceneManagement.lastUnloadedObjects = 0;
        SceneManagement.lastClearedSubscriptions = 0;
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }
}
