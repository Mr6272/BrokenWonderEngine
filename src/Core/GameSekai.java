package Core;

import AbstractLayer.MainWindow;
import Core.Physics.Collider.ColliderWorld;
import Framework.BoxColliderAbility;
import Framework.GameObject;
import Framework.IAbility;

import javax.media.opengl.GLAutoDrawable;
import java.util.List;

public class GameSekai {
    public static List<GameObject> GameObjects = new java.util.ArrayList<GameObject>();
    public static CoroutineManager coroutineManager = new CoroutineManager();
    public static ColliderWorld colliderWorld = new ColliderWorld(new Vector2(0, 0));


    public GameSekai()
    {
        GameObjects = new java.util.ArrayList<GameObject>();
    }
    public void Update()
    {
        float dt = 1f / GameRenderer.Frame; // GameRenderer.Frame 是 60f 的话，这里就是 1/60
        MainWindow.keyManager.update();
        // 1. 先跑你自己的逻辑（玩家输入、AI、协程里改 Transform，等等）
        if (!GameObjects.isEmpty()) {
            for (int i = GameObjects.size() - 1; i >= 0; i--) {
                if (i >= GameObjects.size())
                    continue;
                GameObjects.get(i).Update();   // 这里面会调用各 Ability.OnUpdate()
            }
        }

        // 2. Transform -> Body：让所有刚体跟上最新的 Transform
        if (!GameObjects.isEmpty()) {
            for (int i = GameObjects.size() - 1; i >= 0; i--) {
                if (i >= GameObjects.size())
                    continue;
                GameObject tg = GameObjects.get(i);
                for (IAbility ab : tg.Abilitys) {
                    if (ab instanceof BoxColliderAbility) {
                        BoxColliderAbility box = (BoxColliderAbility) ab;
                        box.syncTransformToBody();
                    }
                }
            }
        }

        // 3. 物理世界前进一步
        colliderWorld.step(dt, 30, 24);
        // 4. Body -> Transform：用物理解算结果修正 Transform，防止穿模
        if (!GameObjects.isEmpty()) {
            for (GameObject tg : GameObjects) {
                for (IAbility ab : tg.Abilitys) {
                    if (ab instanceof BoxColliderAbility) {
                        BoxColliderAbility box = (BoxColliderAbility) ab;
                        if (GameRenderer.isVisible(box.getGameObject()))
                            box.syncBodyToTransform();
                    }
                }
            }
        }

        // 5. 如果你还保留自己的 CollisionSystem（非 box2d 那套），放这里
        CollisionSystem.get().update();

        // 6. 协程系统最后收尾
        coroutineManager.update();
    }


    public void Draw(GLAutoDrawable gld)
    {
        if (!GameObjects.isEmpty())
            for (int i = GameObjects.size() - 1; i >= 0; i--)
                    GameObjects.get(i).Draw(gld);
    }
}
