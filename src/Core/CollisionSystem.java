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

    // 每帧调用一次
    public void update() {
        int size = colliders.size();
        for (int i = size - 1; i > 0; i--) {
            if (i <= colliders.size() - 1)
            {
                ICollider a = colliders.get(i);
                for (int j = i; j > 0; j--) {
                    ICollider b = colliders.get(j);
                    if (a.overlaps(b)) {
                        onCollision(a, b);
                    }
                }
            }
        }
    }

    private void onCollision(ICollider a, ICollider b) {
        // 这里你可以：
        // 1. 拿到 GameObject
        // 2. 通知它们的其他 Ability：比如 OnHit, OnTrigger
        if (a instanceof BoxColliderAbility && b instanceof BoxColliderAbility) {
            BoxColliderAbility aa = (BoxColliderAbility) a;
            BoxColliderAbility bb = (BoxColliderAbility) b;
            GameObject goA = aa.getGameObject();
            GameObject goB = bb.getGameObject();
            goA.OnCollision(goB);
            goB.OnCollision(goA);
        }
    }
}
