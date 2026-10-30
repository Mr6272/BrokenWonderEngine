package Core;

/**
 * 协程：每逻辑帧被 {@link CoroutineManager} 推进一步。
 *
 * <p>本轮加固新增两个 <b>default</b> 方法（不改变 {@link #update()} 这个已有抽象方法，
 * 因此不会破坏任何既有实现，例如 {@code Core.CoroutineDetail.WaitCoroutine}）：
 * <ul>
 *   <li>{@link #isCancelled()}：取消标记，{@link CoroutineManager#cancel(Coroutine)} 会置位，
 *       之后 {@code update()} 不再被调用；</li>
 *   <li>{@link #scope()}：该协程归属的作用域（场景名 / 对象），供场景卸载时按作用域清理。</li>
 * </ul>
 */
public interface Coroutine {
    /**
     * @return true 表示这个协程已经结束，可以从列表里删掉
     */
    boolean update();

    /** 是否已被取消。默认 false，由 {@link CoroutineManager#cancel(Coroutine)} 维护。 */
    public default boolean isCancelled() {
        return false;
    }

    /** 协程归属的作用域。默认 null（= 全局，只由 clear() 清理）。 */
    public default Object scope() {
        return null;
    }
}
