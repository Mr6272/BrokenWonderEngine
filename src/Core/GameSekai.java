package Core;

import Core.Physics.Collider.ColliderWorld;
import Core.destroy.DestroyQueue;
import Framework.BoxColliderAbility;
import Framework.GameObject;
import Framework.IAbility;

import javax.media.opengl.GLAutoDrawable;
import java.util.ArrayList;
import java.util.List;

public class GameSekai {
    public static List<GameObject> GameObjects = new java.util.ArrayList<>();
    public static CoroutineManager coroutineManager = new CoroutineManager();
    public static ColliderWorld colliderWorld = new ColliderWorld(new Vector2(0, 0));

    /** 固定逻辑步长（秒）：物理与游戏逻辑都在该步长下推进，保证帧率无关。 */
    public static final float FIXED_DT = 1f / 60f;
    private float accumulator;

    public GameSekai() {
        GameObjects = new java.util.ArrayList<>();
    }

    /** 同步兜底：正常情况下只有动画器线程调用；防止窗口重绘等其他线程并发进入 */
    public synchronized void Update() {
        // 真实时间累积，按固定步长推进逻辑：帧率波动不会让游戏变快/变慢
        accumulator += GameRenderer.deltaTime;
        if (accumulator > 0.25f) {
            accumulator = 0.25f; // 卡顿保护，防止恢复瞬间螺旋执行
        }
        while (accumulator >= FIXED_DT) {
            float prevDt = GameRenderer.deltaTime;
            GameRenderer.deltaTime = FIXED_DT; // 逻辑侧看到的始终是固定步长
            fixedUpdate(FIXED_DT);
            GameRenderer.deltaTime = prevDt;
            accumulator -= FIXED_DT;
        }
        // 帧末无逻辑步可跑时也要提交销毁：低帧率下 Destroy() 不至于跨帧悬挂
        DestroyQueue.commit();
    }

    private void fixedUpdate(float dt) {
        // 1. 逻辑更新（快照迭代：Update 过程中可能创建/销毁对象）
        List<GameObject> snap = new ArrayList<>(GameObjects);
        for (GameObject go : snap) {
            if (go != null && !go.isDestroyed()) {
                go.Update(); // 这里面会调用 Ability.OnUpdate()
            }
        }

        // 2. Transform -> Body
        snap = new ArrayList<>(GameObjects);
        for (GameObject go : snap) {
            if (go == null || go.isDestroyed()) continue;
            for (IAbility ab : go.Abilitys) {
                if (ab instanceof BoxColliderAbility) {
                    ((BoxColliderAbility) ab).syncTransformToBody();
                }
            }
        }

        // 3. 物理世界
        // 注意：迭代次数沿用引擎原调参 30/24（速度/位置迭代）。
        // 标准推荐是 8/3，但本项目物体少、且玩家是"transform 直接位移 + 每帧写回 body"的
        // 瞬移式移动，低位置迭代会导致重叠分离不足、物体能挤进墙里。
        // 30/24 更硬、防穿透；若未来同屏刚体数量大、性能吃紧，再按需调低。
        colliderWorld.step(dt, 30, 24);

        // 4. Body -> Transform（全部物体同步，离屏物体同样保持物理一致）
        snap = new ArrayList<>(GameObjects);
        for (GameObject go : snap) {
            if (go == null || go.isDestroyed()) continue;
            for (IAbility ab : go.Abilitys) {
                if (ab instanceof BoxColliderAbility) {
                    ((BoxColliderAbility) ab).syncBodyToTransform();
                }
            }
        }

        // 5. 自定义碰撞（含 enter/stay/exit 派发，见 CollisionEventBus）
        CollisionSystem.get().update();

        // 6. 协程
        coroutineManager.update();

        // 7. 帧末延迟销毁提交（架构 §3.2 阶段⑥ / §3.3 规则 2）
        DestroyQueue.commit();
    }

    public void Draw(GLAutoDrawable gld) {
        if (!GameObjects.isEmpty()) {
            for (int i = GameObjects.size() - 1; i >= 0; i--) {
                GameObject go = GameObjects.get(i);
                if (go == null || go.isDestroyed()) continue;
                go.Draw(gld);
            }
        }
    }
}
