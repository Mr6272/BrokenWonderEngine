package UI;

import java.util.Objects;

/**
 * Simple float tween with easing, targeting any float property via getter/setter.
 */
public class UITween {
    public enum Ease {
        Linear,
        EaseIn,
        EaseOut,
        EaseInOut
    }

    public enum LoopType {
        None,
        Loop,
        PingPong
    }

    public interface FloatGetter {
        float get();
    }

    public interface FloatSetter {
        void set(float value);
    }

    private final FloatGetter getter;
    private final FloatSetter setter;
    private final float duration;
    private final Ease ease;
    private final Runnable onComplete;
    private final LoopType loopType;
    private final int loopCount; // -1 = infinite

    private float baseFrom;
    private float baseTo;
    private float currentFrom;
    private float currentTo;
    private float elapsed;
    private boolean initialized;
    private boolean completed;
    private boolean forward = true;
    private int loopsRemaining;

    public UITween(FloatGetter getter, FloatSetter setter, float to, float duration, Ease ease, Runnable onComplete) {
        this(getter, setter, to, duration, ease, onComplete, LoopType.None, 0);
    }

    public UITween(FloatGetter getter, FloatSetter setter, float to, float duration, Ease ease, Runnable onComplete, LoopType loopType, int loopCount) {
        this.getter = Objects.requireNonNull(getter, "getter");
        this.setter = Objects.requireNonNull(setter, "setter");
        this.duration = Math.max(0.0001f, duration);
        this.ease = ease == null ? Ease.Linear : ease;
        this.onComplete = onComplete;
        this.loopType = loopType == null ? LoopType.None : loopType;
        this.loopCount = loopCount == 0 ? 0 : (loopCount < 0 ? -1 : loopCount);
        this.loopsRemaining = this.loopCount;
        this.baseTo = to;
    }

    public boolean isCompleted() {
        return completed;
    }

    public void update(float dt) {
        if (completed) {
            return;
        }
        if (!initialized) {
            baseFrom = getter.get();
            currentFrom = baseFrom;
            currentTo = baseTo;
            initialized = true;
        }
        elapsed += dt;
        float t = Math.min(1f, elapsed / duration);
        float factor = applyEase(t);
        float value = currentFrom + (currentTo - currentFrom) * factor;
        setter.set(value);
        if (elapsed >= duration) {
            if (loopType != LoopType.None && (loopCount < 0 || loopsRemaining > 0)) {
                if (loopCount > 0) {
                    loopsRemaining--;
                }
                if (loopType == LoopType.Loop) {
                    currentFrom = baseFrom;
                    currentTo = baseTo;
                    elapsed = 0f;
                    setter.set(currentFrom);
                    return;
                } else if (loopType == LoopType.PingPong) {
                    forward = !forward;
                    float temp = currentFrom;
                    currentFrom = currentTo;
                    currentTo = temp;
                    elapsed = 0f;
                    setter.set(currentFrom);
                    return;
                }
            }
            completed = true;
            if (onComplete != null) {
                onComplete.run();
            }
        }
    }

    private float applyEase(float t) {
        switch (ease) {
            case EaseIn:
                return t * t;
            case EaseOut:
                return 1f - (1f - t) * (1f - t);
            case EaseInOut:
                if (t < 0.5f) {
                    return 2f * t * t;
                }
                return 1f - 2f * (1f - t) * (1f - t);
            case Linear:
            default:
                return t;
        }
    }
}
