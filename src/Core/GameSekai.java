package Core;

import AbstractLayer.MainWindow;
import Core.Physics.Collider.ColliderWorld;
import Framework.BoxColliderAbility;
import Framework.GameObject;
import Framework.IAbility;

import javax.media.opengl.GLAutoDrawable;
import java.util.List;

public class GameSekai {
    public static List<GameObject> GameObjects = new java.util.ArrayList<>();
    public static CoroutineManager coroutineManager = new CoroutineManager();
    public static ColliderWorld colliderWorld = new ColliderWorld(new Vector2(0, 0));

    public GameSekai() {
        GameObjects = new java.util.ArrayList<>();
    }

    public void Update() {
        float dt = 1f / GameRenderer.Frame; // GameRenderer.Frame 为 60f 时，这里就是 1/60
        // 1. 逻辑更新
        if (!GameObjects.isEmpty()) {
            for (int i = GameObjects.size() - 1; i >= 0; i--) {
                if (i >= GameObjects.size()) {
                    continue;
                }
                GameObjects.get(i).Update(); // 这里面会调用 Ability.OnUpdate()
            }
        }

        // 2. Transform -> Body
        if (!GameObjects.isEmpty()) {
            for (int i = GameObjects.size() - 1; i >= 0; i--) {
                if (i >= GameObjects.size()) {
                    continue;
                }
                GameObject tg = GameObjects.get(i);
                for (IAbility ab : tg.Abilitys) {
                    if (ab instanceof BoxColliderAbility) {
                        BoxColliderAbility box = (BoxColliderAbility) ab;
                        box.syncTransformToBody();
                    }
                }
            }
        }

        // 3. 物理世界
        colliderWorld.step(dt, 30, 24);

        // 4. Body -> Transform
        if (!GameObjects.isEmpty()) {
            for (GameObject tg : GameObjects) {
                for (IAbility ab : tg.Abilitys) {
                    if (ab instanceof BoxColliderAbility) {
                        BoxColliderAbility box = (BoxColliderAbility) ab;
                        if (GameRenderer.isVisible(box.getGameObject())) {
                            box.syncBodyToTransform();
                        }
                    }
                }
            }
        }

        // 5. 自定义碰撞
        CollisionSystem.get().update();

        // 6. 协程
        coroutineManager.update();
    }

    public void Draw(GLAutoDrawable gld) {
        if (!GameObjects.isEmpty()) {
            for (int i = GameObjects.size() - 1; i >= 0; i--) {
                GameObjects.get(i).Draw(gld);
            }
        }
    }
}
