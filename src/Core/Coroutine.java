package Core;

public interface Coroutine {
    /**
     * @return true 表示这个协程已经结束，可以从列表里删掉
     */
    boolean update();
}
