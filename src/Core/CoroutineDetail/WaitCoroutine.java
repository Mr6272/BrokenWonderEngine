package Core.CoroutineDetail;

import Core.Coroutine;
import Core.GameRenderer;

public class WaitCoroutine implements Coroutine {

    private float remaining;
    private final Runnable onStart;
    private final Runnable onDone;
    private final Runnable onUpdate;
    boolean isStart = false;

    public WaitCoroutine(float seconds, Runnable onStart, Runnable onUpdate, Runnable onDone) {
        this.onStart = onStart;
        this.onUpdate = onUpdate;
        this.remaining = seconds;
        this.onDone = onDone;
    }

    @Override
    public boolean update() {
        if (!isStart) {
            isStart = true;
            if (onStart != null)
                onStart.run();
        }
        if (onUpdate != null) {
            onUpdate.run();
        }
        remaining -= GameRenderer.deltaTime; // 真实时间（固定步长内为 1/60）
        if (remaining <= 0f) {
            if (onDone != null) {
                onDone.run();
            }
            return true; // 协程结束
        }
        return false;    // 还在等待中
    }
}

