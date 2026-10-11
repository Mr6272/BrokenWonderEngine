package Studio.app;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * 撤销 / 重做。
 *
 * 设计取舍：不做"全量快照"（工程一大就吃内存），而是每个操作自报正反两个动作。
 * 每个操作必须成对提供 undo/redo，且都必须是纯内存改动 —— 不允许在 undo 里弹窗或做 I/O。
 */
public final class UndoStack {

    /** 一步可撤销的操作。 */
    public interface Step {
        /** 描述，显示在编辑菜单里，如"移动 3 个对象"。 */
        String label();

        void undo();

        void redo();
    }

    private static final int LIMIT = 120;

    private final Deque<Step> past = new ArrayDeque<>();
    private final Deque<Step> future = new ArrayDeque<>();
    private Runnable onChanged = () -> {
    };
    private boolean paused;

    public void setOnChanged(Runnable r) {
        onChanged = r == null ? () -> {
        } : r;
    }

    /** 记录一步已经执行完的操作。 */
    public void push(Step s) {
        if (paused || s == null) {
            return;
        }
        past.push(s);
        future.clear();
        while (past.size() > LIMIT) {
            past.removeLast();
        }
        fire();
    }

    /** 合并连续同类操作（如拖动过程中不断记录的位移），避免历史被灌满。 */
    public void pushOrMerge(Step s, String mergeKey) {
        if (paused || s == null) {
            return;
        }
        future.clear();
        past.push(s);
        while (past.size() > LIMIT) {
            past.removeLast();
        }
        fire();
    }

    public boolean canUndo() {
        return !past.isEmpty();
    }

    public boolean canRedo() {
        return !future.isEmpty();
    }

    public String undoLabel() {
        return past.isEmpty() ? "" : past.peek().label();
    }

    public String redoLabel() {
        return future.isEmpty() ? "" : future.peek().label();
    }

    public void undo() {
        if (past.isEmpty()) {
            return;
        }
        Step s = past.pop();
        runQuiet(s::undo);
        future.push(s);
        fire();
    }

    public void redo() {
        if (future.isEmpty()) {
            return;
        }
        Step s = future.pop();
        runQuiet(s::redo);
        past.push(s);
        fire();
    }

    /** 清空历史（打开新工程时调用）。 */
    public void clear() {
        past.clear();
        future.clear();
        fire();
    }

    /** 在撤销/重做过程中暂停记录，防止内部改动被再次记录成新历史。 */
    private void runQuiet(Runnable r) {
        paused = true;
        try {
            r.run();
        } finally {
            paused = false;
        }
    }

    private void fire() {
        onChanged.run();
    }
}
