package Core.destroy;

import Framework.GameObject;

import java.util.ArrayList;
import java.util.List;

/*
 * 帧末延迟销毁队列（审计 §2.1 缺陷 c：GameObject 没有 Destroy()；架构 §3.3 延迟销毁语义）。
 *
 * 规则（与 docs/open-world-architecture.md §3.3 一致，只是这里落在旧核心上）：
 *   1. GameObject.Destroy() → 立刻标记 destroyed=true，进入本队列，同帧不真正移除；
 *   2. 帧末（GameSekai.fixedUpdate 末尾）commit()：从 GameSekai.GameObjects 移除，
 *      对每个仍挂在对象上的能力各回调一次 OnRemove，然后清空能力列表；
 *   3. 已 destroyed 的对象不再 Update / Draw / 参与物理同步；
 *   4. 幂等：重复 Destroy()、重复 commit() 都不产生额外副作用。
 *
 * 为什么必须延迟：OnUpdate 遍历、碰撞回调里销毁对象都很常见，立即移除会让当帧的迭代失效。
 * */
public final class DestroyQueue {

    /** 一次 commit 最多合并几次「销毁回调里又销毁了新对象」的连锁，防止异常数据无限循环。 */
    private static final int MAX_COMMIT_ROUNDS = 64;

    private static final List<GameObject> PENDING = new ArrayList<GameObject>();

    private DestroyQueue() {
    }

    public static void enqueue(GameObject go) {
        if (go == null) {
            return;
        }
        for (int i = 0; i < PENDING.size(); i++) {
            if (PENDING.get(i) == go) {
                return; // 幂等：同一对象只入队一次
            }
        }
        PENDING.add(go);
    }

    public static int size() {
        return PENDING.size();
    }

    public static boolean isPending(GameObject go) {
        if (go == null) {
            return false;
        }
        for (int i = 0; i < PENDING.size(); i++) {
            if (PENDING.get(i) == go) {
                return true;
            }
        }
        return false;
    }

    /**
     * 帧末统一提交。销毁回调里再次 Destroy() 新对象会在下一轮被合并提交（最多 {@link #MAX_COMMIT_ROUNDS} 轮）。
     */
    public static void commit() {
        int rounds = 0;
        while (!PENDING.isEmpty() && rounds < MAX_COMMIT_ROUNDS) {
            rounds++;
            List<GameObject> batch = new ArrayList<GameObject>(PENDING);
            PENDING.clear();
            for (GameObject go : batch) {
                if (go == null) {
                    continue;
                }
                try {
                    go.CommitDestroy();
                } catch (RuntimeException e) {
                    // 单个对象的销毁回调失败不能中断其它对象的清理
                    System.err.println("DestroyQueue: 提交销毁失败 -> " + e);
                }
            }
        }
        if (!PENDING.isEmpty()) {
            // 仍然清不掉说明销毁回调里在死循环造对象：留日志并放弃，避免卡死主循环
            System.err.println("DestroyQueue: 超过 " + MAX_COMMIT_ROUNDS + " 轮仍有待销毁对象 "
                    + PENDING.size() + " 个，已放弃");
            PENDING.clear();
        }
    }

    /** 清空待销毁队列（不回调 OnRemove）。仅供测试 / 强制复位使用。 */
    public static void clear() {
        PENDING.clear();
    }
}
