package Core;

import Framework.BoxColliderAbility;
import Framework.GameObject;
import Framework.ICollider;

import java.util.ArrayList;
import java.util.List;

public class CollisionSystem {

    private static final CollisionSystem instance = new CollisionSystem();
    public static CollisionSystem get() { return instance; }

    private final List<ICollider> colliders = new ArrayList<>();

    public void register(ICollider c) {
        colliders.add(c);
    }

    public void unregister(ICollider c) {
        colliders.remove(c);
    }

    /** 已注册的碰撞体数量（诊断 / 测试用）。 */
    public int size() {
        return colliders.size();
    }

    /**
     * 枚举 0..count-1 的全部 (i, j) i&lt;j 配对，是碰撞检测配对的唯一来源。
     * 修复：旧实现循环从 size-1 到 1 结束，导致第一个注册的碰撞体永不参与配对。
     * 该方法同时供单元测试使用，保证测试覆盖真实配对逻辑。
     *
     * <p>兼容性红线（审计 §5）：本方法与 {@link #get()} 的静态签名/行为不许变，
     * {@code test/CollisionSystemTest.java} 直接调用它。
     */
    public static List<int[]> enumeratePairs(int count) {
        List<int[]> pairs = new ArrayList<>(Math.max(0, count * (count - 1) / 2));
        for (int i = 0; i < count; i++) {
            for (int j = i + 1; j < count; j++) {
                pairs.add(new int[]{i, j});
            }
        }
        return pairs;
    }

    // 每帧调用一次
    public void update() {
        // 快照迭代：onCollision 回调里可能注销碰撞体，避免边遍历边删
        ICollider[] snapshot = colliders.toArray(new ICollider[0]);

        // 架构 §4.2：O(n²) 配对保留（旧 Demo 依赖），但配对结果同时喂给单一派发层，
        // 由 CollisionEventBus 翻译成 enter/stay/exit。旧 OnCollision 路径保持不变。
        CollisionEventBus bus = CollisionEventBus.get();
        bus.beginTick();

        for (int[] pair : enumeratePairs(snapshot.length)) {
            ICollider a = snapshot[pair[0]];
            ICollider b = snapshot[pair[1]];
            if (a == null || b == null) {
                continue;
            }
            if (a.overlaps(b)) {
                onCollision(a, b);
                GameObject goA = gameObjectOf(a);
                GameObject goB = gameObjectOf(b);
                if (goA != null && goB != null) {
                    bus.reportPair(goA, goB, isSensor(a) || isSensor(b));
                }
            }
        }

        bus.endTick();
    }

    private void onCollision(ICollider a, ICollider b) {
        if (a instanceof BoxColliderAbility && b instanceof BoxColliderAbility) {
            BoxColliderAbility aa = (BoxColliderAbility) a;
            BoxColliderAbility bb = (BoxColliderAbility) b;
            GameObject goA = aa.getGameObject();
            GameObject goB = bb.getGameObject();
            if (goA != null && !goA.isDestroyed()) {
                goA.OnCollision(goB);
            }
            if (goB != null && !goB.isDestroyed()) {
                goB.OnCollision(goA);
            }
        }
    }

    private static GameObject gameObjectOf(ICollider c) {
        if (c instanceof BoxColliderAbility) {
            return ((BoxColliderAbility) c).getGameObject();
        }
        return null;
    }

    private static boolean isSensor(ICollider c) {
        if (c instanceof BoxColliderAbility) {
            BoxColliderAbility box = (BoxColliderAbility) c;
            if (box.isTrigger) {
                return true;
            }
            return box.collider2D != null && box.collider2D.fixture != null
                    && box.collider2D.fixture.isSensor();
        }
        return false;
    }
}
