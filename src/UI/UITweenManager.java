package UI;

import java.util.ArrayList;
import java.util.List;

/**
 * Singleton ticker that advances all active tweens each frame.
 */
public class UITweenManager {
    private static final UITweenManager INSTANCE = new UITweenManager();

    private final List<UITween> tweens = new ArrayList<>();

    private UITweenManager() {
    }

    public static UITweenManager get() {
        return INSTANCE;
    }

    public UITween add(UITween tween) {
        if (tween != null) {
            tweens.add(tween);
        }
        return tween;
    }

    public void clear() {
        tweens.clear();
    }

    public void update(float dt) {
        if (tweens.isEmpty()) {
            return;
        }
        for (int i = tweens.size() - 1; i >= 0; i--) {
            UITween t = tweens.get(i);
            t.update(dt);
            if (t.isCompleted()) {
                tweens.remove(i);
            }
        }
    }
}
