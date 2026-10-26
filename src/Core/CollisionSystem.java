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

    /**
     * 枚举 0..count-1 的全部 (i, j) i&lt;j 配对，是碰撞检测配对的唯一来源。
     * 修复：旧实现循环从 size-1 到 1 结束，导致第一个注册的碰撞体永不参与配对。
     * 该方法同时供单元测试使用，保证测试覆盖真实配对逻辑。
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
        for (int[] pair : enumeratePairs(snapshot.length)) {
            ICollider a = snapshot[pair[0]];
            ICollider b = snapshot[pair[1]];
            if (a.overlaps(b)) {
                onCollision(a, b);
            }
        }
    }

    private void onCollision(ICollider a, ICollider b) {
        if (a instanceof BoxColliderAbility && b instanceof BoxColliderAbility) {
            BoxColliderAbility aa = (BoxColliderAbility) a;
            BoxColliderAbility bb = (BoxColliderAbility) b;
            GameObject goA = aa.getGameObject();
            GameObject goB = bb.getGameObject();
            if (goA != null) {
                goA.OnCollision(goB);
            }
            if (goB != null) {
                goB.OnCollision(goA);
            }
        }
    }
}
