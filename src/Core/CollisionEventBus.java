package Core;

import Framework.GameObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 碰撞事件总线：把"每帧是否仍然重叠"的配对结果，翻译成 enter / stay / exit 三条语义。
 *
 * <p>架构依据 {@code docs/open-world-architecture.md} §4.2「单一派发层」与 §4.3「事件契约」。
 * 旧核心原来的 {@code CollisionSystem} 只对"仍在重叠"的每一对调用
 * {@link GameObject#OnCollision(GameObject)}，等价于只派发 stay，且没有 enter / exit。
 * 本类不改那条老路径（旧 Demo 依赖），只在其上补一层的语义。
 *
 * <p>用法（由 {@link CollisionSystem#update()} 驱动，也可被测试直接驱动）：
 * <pre>
 *   bus.beginTick();
 *   bus.reportPair(a, b, sensor);   // 本 tick 实测到的全部重叠对
 *   bus.endTick();                  // 统一计算并派发 enter/stay/exit
 * </pre>
 *
 * <p>契约（每条都有测试）：
 * <ul>
 *   <li>enter：上一 tick 无、本 tick 有 → 每对一次；</li>
 *   <li>stay：连续两 tick 都有 → 每 tick 一次（第一 tick 只 enter 不 stay）；</li>
 *   <li>exit：上一 tick 有、本 tick 无 → 每对一次；</li>
 *   <li>同一对同一 tick 最多派发一次（去重）；</li>
 *   <li>任一方 {@code isDestroyed()} → 不派发，且内部状态清掉，**不产生 exit**；</li>
 *   <li>双方各收一次（self/other 互换）；sensor 用 trigger* 事件名，否则用 collision*；</li>
 *   <li>派发经 {@link EventBus}（作用域 = 接收方 GameObject），因此可被 {@code clearScope} 批量摘除。</li>
 * </ul>
 */
public final class CollisionEventBus {

    private static final CollisionEventBus INSTANCE = new CollisionEventBus();

    public static CollisionEventBus get() {
        return INSTANCE;
    }

    /** 一对碰撞体的身份键（顺序无关，按对象同一性而非 equals）。 */
    private static final class PairKey {
        final Object a;
        final Object b;
        final int hash;

        PairKey(Object a, Object b) {
            this.a = a;
            this.b = b;
            // 顺序无关的哈希：hash(a,b) == hash(b,a)。XOR 是对称的，加法乘法都不行
            this.hash = System.identityHashCode(a) ^ System.identityHashCode(b);
        }

        @Override
        public int hashCode() {
            return hash;
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) {
                return true;
            }
            if (!(o instanceof PairKey)) {
                return false;
            }
            PairKey other = (PairKey) o;
            // 对称比较：(a,b) 与 (b,a) 必须相等
            return (a == other.a && b == other.b) || (a == other.b && b == other.a);
        }
    }

    /** 上一 tick 存在过的一对。 */
    private static final class PairState {
        GameObject a;
        GameObject b;
        boolean sensor;
    }

    private final Map<PairKey, PairState> previous = new HashMap<PairKey, PairState>();
    private final Map<PairKey, PairState> current = new HashMap<PairKey, PairState>();

    /** 本 tick 的派发计数（诊断 / 测试用）。 */
    public int enterCount;
    public int stayCount;
    public int exitCount;
    public int suppressedCount;

    private CollisionEventBus() {
    }

    /** 开始新的一 tick 的采样。 */
    public void beginTick() {
        current.clear();
        enterCount = 0;
        stayCount = 0;
        exitCount = 0;
        suppressedCount = 0;
    }

    /**
     * 记录本 tick 观测到的一对重叠。重复记录同一对是安全的（tick 内去重）。
     *
     * @param sensor 这一对里是否至少有一方是传感器
     */
    public void reportPair(GameObject a, GameObject b, boolean sensor) {
        if (a == null || b == null || a == b) {
            return;
        }
        PairKey key = new PairKey(a, b);
        if (current.containsKey(key)) {
            return; // tick 内去重（缺陷：同一对一帧最多一次）
        }
        PairState st = new PairState();
        st.a = a;
        st.b = b;
        st.sensor = sensor;
        current.put(key, st);
    }

    /** 结束采样：计算 enter/stay/exit，派发到 EventBus 与 GameObject 钩子，然后滚动状态。 */
    public void endTick() {
        // 1. 本 tick 有的对
        for (Map.Entry<PairKey, PairState> e : current.entrySet()) {
            PairKey key = e.getKey();
            PairState st = e.getValue();
            if (isDead(st.a) || isDead(st.b)) {
                // 契约：任一方已销毁 → 不派发；内部状态不保留，避免对方收到 exit
                suppressedCount++;
                previous.remove(key);
                continue;
            }
            boolean wasThere = previous.containsKey(key);
            dispatch(st, wasThere ? CollisionEvent.Kind.STAY : CollisionEvent.Kind.ENTER);
            if (wasThere) {
                stayCount++;
            } else {
                enterCount++;
            }
        }

        // 2. 上一 tick 有、本 tick 没有的对 → exit
        for (Map.Entry<PairKey, PairState> e : previous.entrySet()) {
            PairKey key = e.getKey();
            if (current.containsKey(key)) {
                continue;
            }
            PairState st = e.getValue();
            if (isDead(st.a) || isDead(st.b)) {
                suppressedCount++; // 销毁期不派发 exit
                continue;
            }
            dispatch(st, CollisionEvent.Kind.EXIT);
            exitCount++;
        }

        // 3. 滚动：current 成为新的 previous
        previous.clear();
        previous.putAll(current);
        current.clear();
    }

    /** 清空全部状态（场景卸载 / 测试复位）。 */
    public void clear() {
        previous.clear();
        current.clear();
        enterCount = 0;
        stayCount = 0;
        exitCount = 0;
        suppressedCount = 0;
    }

    /** 当前跟踪的存活对数（诊断 / 测试用）。 */
    public int trackedPairCount() {
        return previous.size();
    }

    /**
     * 单个物体销毁时调用：把它参与的 all 配对从内部状态里摘掉，且**不产生 exit**。
     * 这样"对象在重叠中被 destroy()"的边界行为就是确定的。
     */
    public int forgetObject(GameObject go) {
        if (go == null) {
            return 0;
        }
        int removed = 0;
        List<PairKey> drop = new ArrayList<PairKey>();
        for (Map.Entry<PairKey, PairState> e : previous.entrySet()) {
            if (e.getValue().a == go || e.getValue().b == go) {
                drop.add(e.getKey());
            }
        }
        for (PairKey k : drop) {
            previous.remove(k);
            removed++;
        }
        drop.clear();
        for (Map.Entry<PairKey, PairState> e : current.entrySet()) {
            if (e.getValue().a == go || e.getValue().b == go) {
                drop.add(e.getKey());
            }
        }
        for (PairKey k : drop) {
            current.remove(k);
        }
        return removed;
    }

    private static boolean isDead(GameObject go) {
        return go == null || go.isDestroyed();
    }

    /** 双方各收一次（self/other 互换），同时走 EventBus 与 GameObject 的 OnCollision* 钩子。 */
    private void dispatch(PairState st, CollisionEvent.Kind kind) {
        dispatchTo(st.a, st.b, kind, st.sensor);
        dispatchTo(st.b, st.a, kind, st.sensor);
    }

    private void dispatchTo(GameObject self, GameObject other, CollisionEvent.Kind kind, boolean sensor) {
        CollisionEvent ev = new CollisionEvent(self, other, kind, sensor, null, null);
        switch (kind) {
            case ENTER:
                self.OnCollisionEnter(other);
                break;
            case STAY:
                self.OnCollisionStay(other);
                break;
            case EXIT:
                self.OnCollisionExit(other);
                break;
            default:
                break;
        }
        EventBus.get().dispatch(ev.eventName(), ev);
    }
}
