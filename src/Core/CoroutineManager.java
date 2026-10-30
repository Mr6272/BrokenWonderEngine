package Core;

import java.util.ArrayList;
import java.util.List;

/**
 * 协程驱动器。
 *
 * <p>本轮加固（审计 §2.2 场景生命周期 + §3 第 7 条作用域化）：
 * <ol>
 *   <li><b>快照迭代</b>：协程在自己的一步里 {@link #start(Coroutine)} 新协程，
 *       不会让本次遍历抛 {@link java.util.ConcurrentModificationException}；</li>
 *   <li><b>延迟加入</b>：当帧新加入的协程从**下一帧**才开始跑，
 *       避免"刚 start 就被同一帧 update 两次"的不确定语义；</li>
 *   <li><b>可取消</b>：{@link #cancel(Coroutine)} 立即摘除，不再回调；
 *       返回是否是本次摘掉的（幂等）；</li>
 *   <li><b>场景级清空</b>：{@link #clear()} 保留原语义，但改为不抛异常版本。</li>
 * </ol>
 */
public class CoroutineManager {

    private final List<Coroutine> coroutines = new ArrayList<>();
    /** 本帧新加入的协程：下一帧才进入 coroutines。 */
    private final List<Coroutine> pending = new ArrayList<>();

    public void start(Coroutine c) {
        if (c == null) {
            return;
        }
        pending.add(c);
    }

    public void update() {
        // 1) 先把上一帧挂起的协程并入
        if (!pending.isEmpty()) {
            coroutines.addAll(pending);
            pending.clear();
        }
        // 2) 快照迭代：协程内部 start/其他协程不会改动正在遍历的列表
        Coroutine[] snapshot = coroutines.toArray(new Coroutine[0]);
        for (Coroutine c : snapshot) {
            if (c == null) {
                continue;
            }
            if (!containsIdentity(c)) {
                continue; // 本帧被 cancel / 已结束
            }
            boolean finished;
            try {
                finished = c.update();
            } catch (RuntimeException e) {
                System.err.println("CoroutineManager: 协程异常 -> " + e);
                finished = true; // 出错的协程不要每帧重复抛
            }
            if (finished) {
                removeIdentity(c);
            }
        }
    }

    /** 立即取消一个协程（含尚未并入本帧的挂起队列）。返回是否真的摘掉。 */
    public boolean cancel(Coroutine c) {
        if (c == null) {
            return false;
        }
        boolean removed = removeIdentity(c);
        for (int i = pending.size() - 1; i >= 0; i--) {
            if (pending.get(i) == c) {
                pending.remove(i);
                removed = true;
            }
        }
        return removed;
    }

    /**
     * 按作用域批量取消（任务书 §11「可取消任务 + 场景销毁时清理」）。
     *
     * <p>作用域由 {@link Coroutine#scope()} 声明（默认 null）。null 作用域不参与批量清理，
     * 只能由 {@link #clear()} 一次全清——这是刻意的：避免"忘记声明作用域"的协程被误杀。
     *
     * @return 被摘掉的协程数
     */
    public int cancelScope(Object scope) {
        if (scope == null) {
            return 0;
        }
        int removed = 0;
        for (int i = coroutines.size() - 1; i >= 0; i--) {
            if (scope.equals(coroutines.get(i).scope())) {
                coroutines.remove(i);
                removed++;
            }
        }
        for (int i = pending.size() - 1; i >= 0; i--) {
            if (scope.equals(pending.get(i).scope())) {
                pending.remove(i);
                removed++;
            }
        }
        return removed;
    }

    /** 某作用域当前有多少协程（含挂起项；诊断 / 测试用）。 */
    public int sizeOfScope(Object scope) {
        if (scope == null) {
            return 0;
        }
        int n = 0;
        for (int i = 0; i < coroutines.size(); i++) {
            if (scope.equals(coroutines.get(i).scope())) {
                n++;
            }
        }
        for (int i = 0; i < pending.size(); i++) {
            if (scope.equals(pending.get(i).scope())) {
                n++;
            }
        }
        return n;
    }

    /** 当前正在驱动的协程数量（不含尚未并入的挂起项）。 */
    public int size() {
        return coroutines.size();
    }

    public boolean isEmpty() {
        return coroutines.isEmpty() && pending.isEmpty();
    }

    /** 清空全部协程（场景切换时调用）。 */
    public void clear() {
        coroutines.clear();
        pending.clear();
    }

    private boolean containsIdentity(Coroutine c) {
        for (int i = 0; i < coroutines.size(); i++) {
            if (coroutines.get(i) == c) {
                return true;
            }
        }
        return false;
    }

    private boolean removeIdentity(Coroutine c) {
        for (int i = 0; i < coroutines.size(); i++) {
            if (coroutines.get(i) == c) {
                coroutines.remove(i);
                return true;
            }
        }
        return false;
    }
}
