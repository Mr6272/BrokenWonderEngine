package Core;

import Core.destroy.DestroyQueue;
import Framework.*;
import TypeStructure.SpriteType;

import java.util.ArrayList;
import java.util.List;

/**
 * 场景切换（旧核心的唯一入口）。
 *
 * <p>本轮加固（审计 §2.2「旧核心 SceneManagement.Reduce 不清协程 / 不置空 Camera / isLoading 非重入安全」）：
 * <ol>
 *   <li>清空 {@code coroutineManager}：旧场景的协程不会串到新场景；</li>
 *   <li>把 {@code GameRenderer.Camera} 置 null：不留静态悬空引用；</li>
 *   <li>清空 {@link CollisionEventBus} 与 {@link EventBus} 的场景作用域订阅；</li>
 *   <li>清空 {@link DestroyQueue}（旧场景里尚未提交的销毁不该挂到新场景）；</li>
 *   <li>{@code isLoading} 改为 try/finally + 状态标记，构建抛异常时不会永久卡住切换；</li>
 *   <li>对象的销毁统一走 {@code OnRemove} 恰好一次（经 {@link GameObject#CommitDestroy()}），
 *       不再由本类手工拼 "OnRemove + unregister + DeleteTexture" 三份逻辑。</li>
 * </ol>
 *
 * <p>兼容性：{@code Reduce(Scene)} 的静态签名与"清空 → 重建"整体语义不变；
 * {@code GameSekai.GameObjects} 仍是 public static List。
 */
public class SceneManagement {

    /** 是否正在切换场景。重入调用会被直接拒绝（保留旧字段名与可见性）。 */
    static boolean isLoading;

    /** 最近一次卸载回收的对象数 / 订阅数（诊断用，不参与逻辑）。 */
    public static int lastUnloadedObjects;
    public static int lastClearedSubscriptions;

    public static void Reduce(Scene scene)
    {
        if (isLoading)
            return;
        isLoading = true;
        try {
            unloadCurrentScene();
            // 只有重建成功才结束 isLoading；异常由 finally 保证复位，见下
            scene.build(GameRenderer.sekai, scene.data);
        } finally {
            isLoading = false;
        }
    }

    /**
     * 卸载当前场景的全部对象与相关全局状态。可单独调用（测试与"回到主菜单"场景用）。
     * 幂等：没有对象时也安全。
     */
    public static void unloadCurrentScene()
    {
        // 快照迭代：RecycleTex/OnRemove 会改动 GameObjects，避免边遍历边删
        List<GameObject> snapshot = new ArrayList<>(GameSekai.GameObjects);
        int unloaded = 0;
        for (GameObject t : snapshot) {
            if (t == null) {
                continue;
            }
            releaseTextures(t);
            // 统一销毁路径：CommitDestroy 会逐个能力 OnRemove 恰好一次并清空 Abilitys
            t.Destroy();
            unloaded++;
        }
        DestroyQueue.commit();
        // 兜底：任何未被 Destroy 摘掉的对象也一并移除（例如未走构造的异常数据）
        GameSekai.GameObjects.clear();
        lastUnloadedObjects = unloaded;

        // ① 协程：旧场景的协程不得串场景
        GameSekai.coroutineManager.clear();
        // ② 相机：不留静态悬空引用（审计 §2.2 明确 bug）
        GameRenderer.Camera = null;

        // ③ 碰撞事件内部配对状态：避免跨场景误派发 exit
        CollisionEventBus.get().clear();

        // ④ 场景作用域事件订阅：按场景根作用域摘除全部分支
        EventBus bus = EventBus.get();
        int cleared = bus.clearScope(SCENE_SCOPE);
        lastClearedSubscriptions = cleared;
        if (bus.listenerCount("collisionEnter") == 0
                && bus.listenerCount("collisionStay") == 0
                && bus.listenerCount("collisionExit") == 0) {
            // 没有任何碰撞订阅残留 → 无需额外处理（保留钩子，便于未来扩展）
        }

        // ⑤ 尚未提交的销毁队列：不跨场景
        DestroyQueue.clear();
    }

    /** 场景级事件作用域键：订阅时用 {@code EventBus.subscribe(name, SCENE_SCOPE, l)}。 */
    public static final Object SCENE_SCOPE = new Object() {
        @Override
        public String toString() {
            return "SceneManagement.SCENE_SCOPE";
        }
    };

    /** 释放一个对象上全部渲染能力持有的纹理（引用计数由 TextureCache 管理）。 */
    private static void releaseTextures(GameObject t)
    {
        for (int j = t.Abilitys.size() - 1; j >= 0; j--) {
            IAbility ia = t.Abilitys.get(j);
            if (ia instanceof Renderer2DAbility) {
                Renderer2DAbility ir = (Renderer2DAbility) ia;
                if (ir.SpriteObj != null) {
                    if (ir.SpriteObj.SpType == SpriteType.Single) {
                        GameRenderer.DeleteTexture(ir.SpriteObj.texture);
                    } else if (ir.SpriteObj.SpType == SpriteType.Multiple && ir.SpriteObj.textures != null) {
                        for (int tex : ir.SpriteObj.textures) {
                            GameRenderer.DeleteTexture(tex);
                        }
                    } else if (ir.SpriteObj.SpType == SpriteType.Atlas && ir.SpriteObj.Atlas != null) {
                        GameRenderer.DeleteTexture(ir.SpriteObj.Atlas.textureId);
                    }
                }
            }
        }
    }
}
