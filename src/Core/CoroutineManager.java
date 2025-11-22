package Core;

import java.util.ArrayList;
import java.util.List;

public class CoroutineManager {

    private final List<Coroutine> coroutines = new ArrayList<>();

    public void start(Coroutine c) {
        if (c != null) {
            coroutines.add(c);
        }
    }

    public void update() {
        // 倒序遍历，方便删除
        for (int i = coroutines.size() - 1; i >= 0; i--) {
            Coroutine c = coroutines.get(i);
            boolean finished = c.update();
            if (finished) {
                coroutines.remove(i);
            }
        }
    }

    public void clear() {
        coroutines.clear();
    }
}

