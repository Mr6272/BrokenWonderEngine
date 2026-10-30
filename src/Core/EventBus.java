package Core;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/**
 * 轻量事件总线（架构 §4.2 的"单一派发层"在旧核心侧的最小实现；审计 §3 第 7 条"作用域化事件生命周期"）。
 *
 * <p>设计要点：
 * <ul>
 *   <li><b>作用域订阅</b>：每次订阅必须挂到一个作用域 key（一般是对象的 {@code Tag} 或场景名），
 *       {@link #clearScope(Object)} 一次摘掉整组回调。场景卸载时按作用域清理，避免悬空回调。</li>
 *   <li><b>身份相等</b>：作用域与监听器都用 {@link IdentityHashMap} 语义，不用 equals，
 *       避免用户自定义 equals 的对象互相串扰。</li>
 *   <li><b>派发期间修改安全</b>：派发用数组快照；订阅/退订在回调里调用不会抛
 *       {@link java.util.ConcurrentModificationException}。</li>
 *   <li><b>幂等</b>：同一监听器重复订阅同一事件只保留一份；重复退订无副作用。</li>
 * </ul>
 *
 * <p>不依赖任何 GL / 窗口，可纯 headless 测试。
 */
public final class EventBus {

    /** 事件监听器。载荷由调用方定义（旧核心多为 GameObject 或事件对象）。 */
    public interface Listener<T> {
        void onEvent(T payload);
    }

    private static final EventBus INSTANCE = new EventBus();

    public static EventBus get() {
        return INSTANCE;
    }

    /** eventName -> (scope -> listeners) */
    private final Map<String, Map<Object, List<Listener<?>>>> listeners =
            new HashMap<String, Map<Object, List<Listener<?>>>>();
    /** eventName -> 派发计数（对账用：订阅要真的被调用） */
    private final Map<String, Integer> dispatchCounts = new HashMap<String, Integer>();

    private EventBus() {
    }

    /**
     * 订阅。scope 为 null 时归入 {@link #GLOBAL_SCOPE}。
     *
     * @return true 表示新增了一份订阅；false 表示该监听器已在同一作用域下订阅过（幂等）
     */
    @SuppressWarnings("unchecked")
    public <T> boolean subscribe(String eventName, Object scope, Listener<T> listener) {
        if (eventName == null || listener == null) {
            return false;
        }
        Map<Object, List<Listener<?>>> byScope = listeners.get(eventName);
        if (byScope == null) {
            byScope = new IdentityHashMap<Object, List<Listener<?>>>();
            listeners.put(eventName, byScope);
        }
        Object key = scope == null ? GLOBAL_SCOPE : scope;
        List<Listener<?>> group = byScope.get(key);
        if (group == null) {
            group = new ArrayList<Listener<?>>();
            byScope.put(key, group);
        }
        for (int i = 0; i < group.size(); i++) {
            if (group.get(i) == listener) {
                return false; // 幂等：同一作用域下不重复订阅
            }
        }
        group.add(listener);
        return true;
    }

    /** 退订。返回是否真的摘掉了一份。 */
    public boolean unsubscribe(String eventName, Object scope, Listener<?> listener) {
        if (eventName == null || listener == null) {
            return false;
        }
        Map<Object, List<Listener<?>>> byScope = listeners.get(eventName);
        if (byScope == null) {
            return false;
        }
        Object key = scope == null ? GLOBAL_SCOPE : scope;
        List<Listener<?>> group = byScope.get(key);
        if (group == null) {
            return false;
        }
        for (int i = 0; i < group.size(); i++) {
            if (group.get(i) == listener) {
                group.remove(i);
                if (group.isEmpty()) {
                    byScope.remove(key);
                }
                if (byScope.isEmpty()) {
                    listeners.remove(eventName);
                }
                return true;
            }
        }
        return false;
    }

    /** 摘掉某个作用域在**全部事件**上的所有订阅，返回摘掉的数量。 */
    public int clearScope(Object scope) {
        if (scope == null) {
            return 0;
        }
        int removed = 0;
        List<String> emptyEvents = new ArrayList<String>();
        for (Map.Entry<String, Map<Object, List<Listener<?>>>> e : listeners.entrySet()) {
            Map<Object, List<Listener<?>>> byScope = e.getValue();
            List<Listener<?>> group = byScope.get(scope);
            if (group != null) {
                removed += group.size();
                byScope.remove(scope);
            }
            if (byScope.isEmpty()) {
                emptyEvents.add(e.getKey());
            }
        }
        for (String ev : emptyEvents) {
            listeners.remove(ev);
        }
        return removed;
    }

    /** 清空全部事件与计数（场景卸载 / 测试复位）。 */
    public void clear() {
        listeners.clear();
        dispatchCounts.clear();
    }

    /** 派发。接收方用 Object 强转各自的载荷类型。 */
    public void dispatch(String eventName, Object payload) {
        if (eventName == null) {
            return;
        }
        Integer prev = dispatchCounts.get(eventName);
        dispatchCounts.put(eventName, Integer.valueOf((prev == null ? 0 : prev.intValue()) + 1));

        Map<Object, List<Listener<?>>> byScope = listeners.get(eventName);
        if (byScope == null || byScope.isEmpty()) {
            return;
        }
        // 快照迭代：回调里退订/订阅均安全
        List<Listener<?>> all = new ArrayList<Listener<?>>();
        for (List<Listener<?>> group : byScope.values()) {
            all.addAll(group);
        }
        Listener<?>[] snapshot = all.toArray(new Listener<?>[0]);
        for (Listener<?> l : snapshot) {
            // 派发过程中可能被退订：跳过已摘掉的那些
            if (!isStillSubscribed(eventName, l)) {
                continue;
            }
            try {
                @SuppressWarnings("unchecked")
                Listener<Object> typed = (Listener<Object>) l;
                typed.onEvent(payload);
            } catch (RuntimeException ex) {
                // 单个监听器异常不中断其它监听器
                System.err.println("EventBus: 监听器异常 event=" + eventName + " -> " + ex);
            }
        }
    }

    private boolean isStillSubscribed(String eventName, Listener<?> l) {
        Map<Object, List<Listener<?>>> byScope = listeners.get(eventName);
        if (byScope == null) {
            return false;
        }
        for (List<Listener<?>> group : byScope.values()) {
            for (int i = 0; i < group.size(); i++) {
                if (group.get(i) == l) {
                    return true;
                }
            }
        }
        return false;
    }

    public int listenerCount(String eventName) {
        Map<Object, List<Listener<?>>> byScope = listeners.get(eventName);
        if (byScope == null) {
            return 0;
        }
        int n = 0;
        for (List<Listener<?>> group : byScope.values()) {
            n += group.size();
        }
        return n;
    }

    public int scopeCount(String eventName) {
        Map<Object, List<Listener<?>>> byScope = listeners.get(eventName);
        return byScope == null ? 0 : byScope.size();
    }

    public int dispatchCount(String eventName) {
        Integer prev = dispatchCounts.get(eventName);
        return prev == null ? 0 : prev.intValue();
    }

    public boolean hasEvent(String eventName) {
        return listeners.containsKey(eventName);
    }

    /** 无作用域的订阅归到这里。 */
    public static final Object GLOBAL_SCOPE = new Object() {
        @Override
        public String toString() {
            return "EventBus.GLOBAL_SCOPE";
        }
    };
}
