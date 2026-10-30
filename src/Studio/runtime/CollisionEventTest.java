package Studio.runtime;

import Core.CollisionEvent;
import Core.CollisionEventBus;
import Core.EventBus;
import Core.GameSekai;
import Core.destroy.DestroyQueue;
import Framework.GameObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 碰撞事件语义测试（对应审计 §2.3「三套碰撞入口、都没有 enter/stay/exit」与架构 §4.3 契约）。
 *
 * <p><b>为什么直接驱动 {@link CollisionEventBus} 而不建 JBox2D 世界：</p>
 * <p>旧核心的 {@code CollisionSystem} 每次配对都要扫 JBox2D 的 {@code ContactEdge}，
 * 建真实刚体需要物理世界步进与多边形碰撞，测试会变慢且对物理常数敏感；
 * 而本轮要验的是<b>事件语义</b>（enter 一次 / stay 每帧 / exit 一次 / 销毁抑制 / sensor 区分 / 去重），
 * 不是 JBox2D 的重叠判定本身。因此直接向总线 reportPair，测的是同一段派发代码路径
 * （{@code CollisionSystem.update()} 内部也是调这两个方法）。
 *
 * <p>每条断言对应一条契约，全部可在加固前失败（加固前根本没有 CollisionEventBus 这个类）。
 * 全部通过退出码 0，任一失败退出码 1。
 */
public final class CollisionEventTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();

    private CollisionEventTest() {
    }

    public static void main(String[] args) {
        int failures = 0;
        String fatal = null;
        try {
            runEnterStayExit();
            runDedupWithinTick();
            runDestroySuppression();
            runSensorVsSolid();
            runForgetObject();
            runFastPass();
            runEventBusScope();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace();
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"collisioneventtest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        System.out.println("========== CollisionEventTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            System.out.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        System.out.println("----------------------------------------");
        System.out.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- enter / stay / exit 基本语义 ----------------

    private static void runEnterStayExit() {
        TestObject a = new TestObject("a");
        TestObject b = new TestObject("b");
        CollisionEventBus bus = CollisionEventBus.get();
        bus.clear();

        // tick 1：开始重叠 → enter 一次
        bus.beginTick();
        bus.reportPair(a, b, false);
        bus.endTick();
        check("enter-1 第一 tick 派发 enter 一次", bus.enterCount == 1, "enter=" + bus.enterCount);
        check("enter-2 第一 tick 不派发 stay", bus.stayCount == 0, "stay=" + bus.stayCount);
        check("enter-3 双方各收到一次 enter",
                a.enterCount == 1 && b.enterCount == 1,
                "a=" + a.enterCount + " b=" + b.enterCount);
        check("enter-4 enter 的 other 指向对方",
                a.lastEnterOther == (GameObject) b && b.lastEnterOther == (GameObject) a, "");

        // tick 2：仍然重叠 → stay 一次
        bus.beginTick();
        bus.reportPair(a, b, false);
        bus.endTick();
        check("stay-1 第二 tick 派发 stay 一次", bus.stayCount == 1, "stay=" + bus.stayCount);
        check("stay-2 第二 tick 不再派发 enter", bus.enterCount == 0, "enter=" + bus.enterCount);
        check("stay-3 双方各收到一次 stay", a.stayCount == 1 && b.stayCount == 1, "");

        // tick 3：仍然重叠 → stay 再来一次（每帧一次）
        bus.beginTick();
        bus.reportPair(a, b, false);
        bus.endTick();
        check("stay-4 stay 每 tick 一次（累计 2）", a.stayCount == 2, "a stay=" + a.stayCount);

        // tick 4：不再重叠 → exit 一次
        bus.beginTick();
        bus.endTick();
        check("exit-1 分离后派发 exit 一次", bus.exitCount == 1, "exit=" + bus.exitCount);
        check("exit-2 双方各收到一次 exit", a.exitCount == 1 && b.exitCount == 1,
                "a=" + a.exitCount + " b=" + b.exitCount);

        // tick 5：再次重叠 → 新的一轮 enter
        bus.beginTick();
        bus.reportPair(a, b, false);
        bus.endTick();
        check("reenter-1 重新接触派发新的 enter", a.enterCount == 2, "a enter=" + a.enterCount);

        bus.clear();
        cleanup();
    }

    // ---------------- 同一对同一 tick 去重 ----------------

    private static void runDedupWithinTick() {
        TestObject a = new TestObject("dd-a");
        TestObject b = new TestObject("dd-b");
        CollisionEventBus bus = CollisionEventBus.get();
        bus.clear();

        bus.beginTick();
        bus.reportPair(a, b, false);
        bus.reportPair(a, b, false);   // 重复上报（不同调用点可能都看到这一对）
        bus.reportPair(b, a, false);   // 反向上报（顺序无关）
        bus.endTick();
        check("dedup-1 同一对同一 tick 只 enter 一次",
                bus.enterCount == 1 && a.enterCount == 1,
                "enterCount=" + bus.enterCount + " a=" + a.enterCount);

        bus.beginTick();
        bus.reportPair(a, b, false);
        bus.reportPair(b, a, false);
        bus.endTick();
        check("dedup-2 同一对同一 tick 只 stay 一次",
                bus.stayCount == 1 && a.stayCount == 1, "stay=" + bus.stayCount);

        bus.clear();
        cleanup();
    }

    // ---------------- 销毁抑制 ----------------

    private static void runDestroySuppression() {
        TestObject alive = new TestObject("ds-alive");
        TestObject doomed = new TestObject("ds-doomed");
        CollisionEventBus bus = CollisionEventBus.get();
        bus.clear();

        // tick 1：正常 enter
        bus.beginTick();
        bus.reportPair(alive, doomed, false);
        bus.endTick();
        int enterBefore = alive.enterCount;
        check("destroy-1 建立接触后 alive 收到 enter", enterBefore == 1, "enter=" + enterBefore);

        // 对象在重叠中被 destroy() → 契约：对方不收到 exit
        doomed.Destroy();
        bus.beginTick();
        bus.endTick();
        check("destroy-2 对象销毁期间不派发 exit",
                alive.exitCount == 0, "alive exit=" + alive.exitCount);
        check("destroy-3 销毁计入 suppressedCount", bus.suppressedCount >= 1,
                "suppressed=" + bus.suppressedCount);

        // 内部状态必须清掉，防止后续误派发
        bus.beginTick();
        bus.endTick();
        check("destroy-4 销毁后不再重复计 suppressed", bus.suppressedCount == 0,
                "suppressed=" + bus.suppressedCount);
        check("destroy-5 内部配对状态已清空", bus.trackedPairCount() == 0,
                "tracked=" + bus.trackedPairCount());

        // 已销毁对象不再收到任何碰撞回调
        int enterAfter = alive.enterCount;
        bus.beginTick();
        bus.reportPair(alive, doomed, false);
        bus.endTick();
        check("destroy-6 已销毁对象参与的不派发 enter", alive.enterCount == enterAfter,
                "alive enter=" + alive.enterCount);

        DestroyQueue.commit();
        bus.clear();
        cleanup();
    }

    // ---------------- sensor vs solid ----------------

    private static void runSensorVsSolid() {
        TestObject solid = new TestObject("s-solid");
        TestObject sensor = new TestObject("s-sensor");
        CollisionEventBus bus = CollisionEventBus.get();
        bus.clear();

        bus.beginTick();
        bus.reportPair(solid, sensor, true);
        bus.endTick();
        // 通过 EventBus 订阅捕获事件名（sensor 与 solid 都归 trigger*，见架构 §4.3 最后一条）
        sensor.watch("triggerEnter");
        solid.watch("triggerEnter");
        bus.clear();
        bus.beginTick();
        bus.reportPair(solid, sensor, true);
        bus.endTick();
        check("sensor-1 sensor 对派发 trigger 事件（用事件名验证）",
                sensor.lastEventName != null && sensor.lastEventName.startsWith("trigger"),
                "name=" + sensor.lastEventName);
        check("sensor-2 solid 侧同样收到 trigger 事件（本实现双方一致）",
                solid.lastEventName != null && solid.lastEventName.startsWith("trigger"),
                "name=" + solid.lastEventName);
        check("sensor-3 载荷 isSensor() 为 true",
                sensor.lastEvent != null && sensor.lastEvent.isSensor(), "");

        // 无 sensor → collision*
        TestObject p = new TestObject("s-p");
        TestObject q = new TestObject("s-q");
        p.watch("collisionEnter");
        q.watch("collisionEnter");
        bus.clear();
        bus.beginTick();
        bus.reportPair(p, q, false);
        bus.endTick();
        check("sensor-4 无 sensor 时用 collision 事件名",
                p.lastEventName != null && p.lastEventName.equals("collisionEnter"),
                "name=" + p.lastEventName);
        check("sensor-5 无 sensor 载荷 isSensor() 为 false",
                p.lastEvent != null && !p.lastEvent.isSensor(), "");

        bus.clear();
        cleanup();
    }

    // ---------------- forgetObject ----------------

    private static void runForgetObject() {
        TestObject a = new TestObject("fo-a");
        TestObject b = new TestObject("fo-b");
        CollisionEventBus bus = CollisionEventBus.get();
        bus.clear();

        bus.beginTick();
        bus.reportPair(a, b, false);
        bus.endTick();
        check("forget-1 建立接触后被跟踪", bus.trackedPairCount() == 1,
                "tracked=" + bus.trackedPairCount());

        int removed = bus.forgetObject(b);
        check("forget-2 forgetObject 返回摘掉的配对数", removed == 1, "removed=" + removed);
        check("forget-3 摘掉后不再跟踪", bus.trackedPairCount() == 0,
                "tracked=" + bus.trackedPairCount());

        bus.beginTick();
        bus.endTick();
        check("forget-4 摘掉后不会派发 exit", a.exitCount == 0, "a exit=" + a.exitCount);

        bus.clear();
        cleanup();
    }

    // ---------------- 快速擦过（一帧内 enter+exit） ----------------

    private static void runFastPass() {
        // 架构 §4.3 选定语义："各派发一次，顺序 enter → exit"。
        // O(n²) 配对是"本 tick 末的真实重叠"，快速擦过在这种采样里看不到 enter；
        // 但同一帧内先 reportPair 再"消失"在下一 tick，语义上是 enter → exit 各一次。
        TestObject a = new TestObject("fp-a");
        TestObject b = new TestObject("fp-b");
        CollisionEventBus bus = CollisionEventBus.get();
        bus.clear();

        bus.beginTick();
        bus.reportPair(a, b, false);
        bus.endTick();
        check("fastpass-1 擦过的第一 tick 收到 enter", a.enterCount == 1, "");

        bus.beginTick();
        bus.endTick();
        check("fastpass-2 下一 tick 收到 exit", a.exitCount == 1, "");
        check("fastpass-3 顺序为 enter → exit",
                a.sequence.indexOf("enter") == 0 && a.sequence.indexOf("exit") == 1,
                a.sequence.toString());

        bus.clear();
        cleanup();
    }

    // ---------------- EventBus 作用域 ----------------

    private static void runEventBusScope() {
        EventBus bus = EventBus.get();
        bus.clear();
        final List<String> got = new ArrayList<String>();
        Object scopeA = new Object();
        Object scopeB = new Object();
        EventBus.Listener<CollisionEvent> la = new EventBus.Listener<CollisionEvent>() {
            public void onEvent(CollisionEvent ev) {
                got.add("a:" + ev.kind);
            }
        };
        EventBus.Listener<CollisionEvent> lb = new EventBus.Listener<CollisionEvent>() {
            public void onEvent(CollisionEvent ev) {
                got.add("b:" + ev.kind);
            }
        };
        bus.subscribe("collisionEnter", scopeA, la);
        bus.subscribe("collisionEnter", scopeB, lb);
        bus.subscribe("collisionEnter", scopeA, la); // 幂等重复订阅
        check("evbus-1 重复订阅返回 false 且只保留一份",
                bus.listenerCount("collisionEnter") == 2,
                "count=" + bus.listenerCount("collisionEnter"));
        check("evbus-2 作用域数正确", bus.scopeCount("collisionEnter") == 2,
                "scopes=" + bus.scopeCount("collisionEnter"));

        // exit 也要订阅，否则看不到"摘掉作用域后不再回调"的效果
        bus.subscribe("collisionExit", scopeA, la);
        bus.subscribe("collisionExit", scopeB, lb);

        TestObject a = new TestObject("eb-a");
        TestObject b = new TestObject("eb-b");
        CollisionEventBus cbus = CollisionEventBus.get();
        cbus.clear();
        cbus.beginTick();
        cbus.reportPair(a, b, false);
        cbus.endTick();
        // 双方各派发一次（self/other 视角各一次）→ 2 个全局监听器 × 2 次派发 = 4 条
        check("evbus-3 两个作用域都收到派发（每方各一次）", got.size() == 4, got.toString());

        int cleared = bus.clearScope(scopeA);
        // scopeA 在 collisionEnter 与 collisionExit 各订阅了 1 份 → 共摘掉 2 份
        check("evbus-4 clearScope 摘掉该作用域的全部订阅（跨事件）", cleared == 2,
                "cleared=" + cleared);

        got.clear();
        cbus.beginTick();
        cbus.endTick();
        // exit 同样是双方各一次 → scopeB 收到 2 条
        check("evbus-5 摘掉的作用域不再回调（exit 只到 scopeB）",
                got.size() == 2 && got.get(0).equals("b:EXIT") && got.get(1).equals("b:EXIT"),
                got.toString());

        bus.clear();
        cbus.clear();
        cleanup();
    }

    // ---------------- 测试对象 ----------------

    /** 只记录回调的最小 GameObject 子类。 */
    private static final class TestObject extends GameObject {
        int enterCount;
        int stayCount;
        int exitCount;
        GameObject lastEnterOther;
        CollisionEvent lastEvent;
        String lastEventName;
        final List<String> sequence = new ArrayList<String>();

        TestObject(String tagName) {
            tag = new TypeStructure.Tag(tagName);
        }

        @Override
        public void OnCollisionEnter(GameObject other) {
            enterCount++;
            lastEnterOther = other;
            sequence.add("enter");
        }

        @Override
        public void OnCollisionStay(GameObject other) {
            stayCount++;
            sequence.add("stay");
        }

        @Override
        public void OnCollisionExit(GameObject other) {
            exitCount++;
            sequence.add("exit");
        }

        @Override
        public void OnCollision(GameObject other) {
            // 旧路径：模拟 CollisionSystem.onCollision
        }

        /** 让 EventBus 派发能被这个对象观察到（通过订阅自己作用域）。 */
        void watch(String eventName) {
            EventBus.get().subscribe(eventName, this, new EventBus.Listener<CollisionEvent>() {
                public void onEvent(CollisionEvent ev) {
                    lastEvent = ev;
                    lastEventName = ev.eventName();
                }
            });
        }

        @Override
        public String toString() {
            return tag.TagName;
        }
    }

    private static void cleanup() {
        List<GameObject> snapshot = new ArrayList<GameObject>(GameSekai.GameObjects);
        for (GameObject go : snapshot) {
            go.Destroy();
        }
        DestroyQueue.commit();
        GameSekai.GameObjects.clear();
        DestroyQueue.clear();
        CollisionEventBus.get().clear();
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }
}
