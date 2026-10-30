package Studio.runtime;

import Core.CollisionEvent;
import Core.EventBus;
import Core.GameSekai;
import Core.destroy.DestroyQueue;
import Framework.GameObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 事件总线测试（对应审计 §3 第 7 条「作用域化事件/定时器生命周期，场景卸载后悬空回调」
 * 与架构 §4.2「单一派发层」的前置条件）。
 *
 * <p>覆盖点（每条一个断言）：
 * <ul>
 *   <li>订阅 / 退订 / 重复订阅幂等；</li>
 *   <li>派发到多个作用域的全部监听器；</li>
 *   <li>{@code clearScope} 一次摘掉整个作用域（跨事件），其它作用域不受影响；</li>
 *   <li>派发期间退订/订阅安全（不抛 ConcurrentModificationException、不回调已退订的）；</li>
 *   <li>单个监听器抛异常不中断其它监听器；</li>
 *   <li>派发计数可用于对账（订阅了就要真的被调用）。</li>
 * </ul>
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class EventBusTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();

    private EventBusTest() {
    }

    public static void main(String[] args) {
        int failures = 0;
        String fatal = null;
        try {
            runSubscribeDispatch();
            runIdempotent();
            runUnsubscribe();
            runClearScope();
            runMutateDuringDispatch();
            runListenerThrows();
            runDestroyAutoClearsSubscriptions();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace();
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"eventbustest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        System.out.println("========== EventBusTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            System.out.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        System.out.println("----------------------------------");
        System.out.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- 订阅 / 派发 ----------------

    private static void runSubscribeDispatch() {
        EventBus bus = EventBus.get();
        bus.clear();
        final List<String> got = new ArrayList<String>();
        EventBus.Listener<String> l1 = new EventBus.Listener<String>() {
            public void onEvent(String p) {
                got.add("l1:" + p);
            }
        };
        EventBus.Listener<String> l2 = new EventBus.Listener<String>() {
            public void onEvent(String p) {
                got.add("l2:" + p);
            }
        };
        Object scopeA = new Object();
        Object scopeB = new Object();

        bus.subscribe("ev", scopeA, l1);
        bus.subscribe("ev", scopeB, l2);
        check("bus-1 订阅计数正确", bus.listenerCount("ev") == 2,
                "count=" + bus.listenerCount("ev"));
        check("bus-2 作用域计数正确", bus.scopeCount("ev") == 2,
                "scopes=" + bus.scopeCount("ev"));
        check("bus-3 hasEvent 反映事件是否存在", bus.hasEvent("ev"), "");

        bus.dispatch("ev", "hello");
        check("bus-4 两个作用域各收到一次", got.size() == 2, got.toString());
        check("bus-5 载荷原样传递",
                got.contains("l1:hello") && got.contains("l2:hello"), got.toString());
        check("bus-6 派发计数正确", bus.dispatchCount("ev") == 1,
                "count=" + bus.dispatchCount("ev"));

        bus.dispatch("ev", "again");
        check("bus-7 重复派发每次都能到达", got.size() == 4, got.toString());

        bus.clear();
        check("bus-8 clear 后无残留", bus.listenerCount("ev") == 0 && !bus.hasEvent("ev"), "");
    }

    // ---------------- 幂等订阅 ----------------

    private static void runIdempotent() {
        EventBus bus = EventBus.get();
        bus.clear();
        final int[] calls = new int[1];
        EventBus.Listener<Object> l = new EventBus.Listener<Object>() {
            public void onEvent(Object p) {
                calls[0]++;
            }
        };
        Object scope = new Object();
        check("bus-9 首次订阅返回 true", bus.subscribe("idem", scope, l), "");
        check("bus-10 同一作用域重复订阅返回 false", !bus.subscribe("idem", scope, l), "");
        check("bus-11 重复订阅不增加计数", bus.listenerCount("idem") == 1,
                "count=" + bus.listenerCount("idem"));

        bus.dispatch("idem", null);
        check("bus-12 幂等订阅只回调一次", calls[0] == 1, "calls=" + calls[0]);

        // 同一监听器在不同作用域应该是两份独立订阅
        Object other = new Object();
        check("bus-13 不同作用域可订阅同一监听器", bus.subscribe("idem", other, l), "");
        bus.dispatch("idem", null);
        check("bus-14 两个作用域各回调一次", calls[0] == 3, "calls=" + calls[0]);

        bus.clear();
    }

    // ---------------- 退订 ----------------

    private static void runUnsubscribe() {
        EventBus bus = EventBus.get();
        bus.clear();
        final int[] calls = new int[1];
        EventBus.Listener<Object> l = new EventBus.Listener<Object>() {
            public void onEvent(Object p) {
                calls[0]++;
            }
        };
        Object scope = new Object();
        bus.subscribe("unsub", scope, l);

        check("bus-15 退订已存在的订阅返回 true", bus.unsubscribe("unsub", scope, l), "");
        bus.dispatch("unsub", null);
        check("bus-16 退订后不再回调", calls[0] == 0, "calls=" + calls[0]);
        check("bus-17 退订后事件被清理", !bus.hasEvent("unsub"), "");

        check("bus-18 重复退订返回 false（幂等）", !bus.unsubscribe("unsub", scope, l), "");
        check("bus-19 退订不存在的事件返回 false",
                !bus.unsubscribe("never", new Object(), l), "");

        bus.clear();
    }

    // ---------------- 作用域整体清理 ----------------

    private static void runClearScope() {
        EventBus bus = EventBus.get();
        bus.clear();
        final int[] aCalls = new int[1];
        final int[] bCalls = new int[1];
        EventBus.Listener<Object> la = new EventBus.Listener<Object>() {
            public void onEvent(Object p) {
                aCalls[0]++;
            }
        };
        EventBus.Listener<Object> lb = new EventBus.Listener<Object>() {
            public void onEvent(Object p) {
                bCalls[0]++;
            }
        };
        Object scopeA = new Object();
        Object scopeB = new Object();
        bus.subscribe("e1", scopeA, la);
        bus.subscribe("e2", scopeA, la);
        bus.subscribe("e1", scopeB, lb);

        int cleared = bus.clearScope(scopeA);
        check("bus-20 clearScope 跨事件摘掉该作用域全部订阅", cleared == 2,
                "cleared=" + cleared);
        check("bus-21 其它作用域订阅保留", bus.listenerCount("e1") == 1,
                "count=" + bus.listenerCount("e1"));

        bus.dispatch("e1", null);
        bus.dispatch("e2", null);
        check("bus-22 被清作用域不再回调", aCalls[0] == 0, "a=" + aCalls[0]);
        check("bus-23 保留作用域仍回调", bCalls[0] == 1, "b=" + bCalls[0]);

        check("bus-24 clearScope(null) 安全返回 0", bus.clearScope(null) == 0, "");
        bus.clear();
    }

    // ---------------- 派发期间修改 ----------------

    private static void runMutateDuringDispatch() {
        EventBus bus = EventBus.get();
        bus.clear();
        final Object scopeA = new Object();
        final Object scopeB = new Object();
        final List<String> got = new ArrayList<String>();
        final EventBus.Listener<Object> lb = new EventBus.Listener<Object>() {
            public void onEvent(Object p) {
                got.add("b");
            }
        };
        EventBus.Listener<Object> la = new EventBus.Listener<Object>() {
            public void onEvent(Object p) {
                got.add("a");
                // 派发期间退订 b、并加入新监听器 —— 都不应该破坏本次派发
                bus.unsubscribe("mut", scopeB, lb);
                bus.subscribe("mut", scopeB, new EventBus.Listener<Object>() {
                    public void onEvent(Object q) {
                        got.add("c");
                    }
                });
            }
        };
        bus.subscribe("mut", scopeA, la);
        bus.subscribe("mut", scopeB, lb);

        boolean threw = false;
        try {
            bus.dispatch("mut", null);
        } catch (Throwable t) {
            threw = true;
        }
        check("bus-25 派发期间退订/订阅不抛异常", !threw, "");
        check("bus-26 本次派发不回调已被退订的监听器",
                got.size() == 1 && got.get(0).equals("a"), got.toString());

        bus.dispatch("mut", null);
        check("bus-27 新订阅的监听器在下次派发生效",
                got.size() == 3 && got.get(1).equals("a") && got.get(2).equals("c"),
                got.toString());
        bus.clear();
    }

    // ---------------- 监听器抛异常 ----------------

    private static void runListenerThrows() {
        EventBus bus = EventBus.get();
        bus.clear();
        final int[] okCalls = new int[1];
        EventBus.Listener<Object> bad = new EventBus.Listener<Object>() {
            public void onEvent(Object p) {
                throw new IllegalStateException("监听器故意抛异常");
            }
        };
        EventBus.Listener<Object> good = new EventBus.Listener<Object>() {
            public void onEvent(Object p) {
                okCalls[0]++;
            }
        };
        Object s1 = new Object();
        Object s2 = new Object();
        bus.subscribe("thr", s1, bad);
        bus.subscribe("thr", s2, good);

        boolean threw = false;
        try {
            bus.dispatch("thr", null);
        } catch (Throwable t) {
            threw = true;
        }
        check("bus-28 单个监听器异常不向外抛", !threw, "");
        check("bus-29 其它监听器仍然被回调", okCalls[0] == 1, "calls=" + okCalls[0]);
        check("bus-30 异常监听器仍在订阅中（不被静默摘掉）", bus.listenerCount("thr") == 2,
                "count=" + bus.listenerCount("thr"));
        bus.clear();
    }

    // ---------------- 对象销毁自动清订阅（审计 §3 第 7 条） ----------------

    private static void runDestroyAutoClearsSubscriptions() {
        EventBus bus = EventBus.get();
        bus.clear();
        final int[] calls = new int[1];
        EventBus.Listener<Object> l = new EventBus.Listener<Object>() {
            public void onEvent(Object p) {
                calls[0]++;
            }
        };
        GameObject host = new GameObject();
        host.tag = new TypeStructure.Tag("scope-host");
        // 以「对象自身」为作用域订阅：对象销毁时这条订阅必须被自动摘掉
        bus.subscribe("autoClear", host, l);
        check("bus-31 以对象自身为作用域订阅成功", bus.listenerCount("autoClear") == 1,
                "count=" + bus.listenerCount("autoClear"));

        bus.dispatch("autoClear", null);
        check("bus-32 销毁前的派发能到达", calls[0] == 1, "calls=" + calls[0]);

        host.Destroy();
        DestroyQueue.commit();
        check("bus-33 对象销毁自动摘掉自身作用域的订阅（无悬空回调）",
                bus.listenerCount("autoClear") == 0,
                "count=" + bus.listenerCount("autoClear"));
        bus.dispatch("autoClear", null);
        check("bus-34 销毁后不再回调", calls[0] == 1, "calls=" + calls[0]);

        GameSekai.GameObjects.clear();
        DestroyQueue.clear();
        bus.clear();
    }

    // ---------------- 断言 ----------------

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }
}
