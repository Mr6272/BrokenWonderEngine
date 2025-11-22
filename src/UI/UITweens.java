package UI;

import java.awt.Color;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Convenience factory methods for common UI tweens.
 */
public final class UITweens {
    private UITweens() {
    }

    public static UITween moveTo(UIElement target, float toX, float toY, float duration, UITween.Ease ease, UITween.LoopType loopType, int loopCount, Runnable onComplete) {
        if (target == null) {
            return null;
        }
        UITween tx = new UITween(target::getX, v -> target.setPosition(v, target.getY()), toX, duration, ease, null, loopType, loopCount);
        UITween ty = new UITween(target::getY, v -> target.setPosition(target.getX(), v), toY, duration, ease, onComplete, loopType, loopCount);
        UITweenManager.get().add(tx);
        UITweenManager.get().add(ty);
        return ty;
    }

    public static UITween moveTo(UIElement target, float toX, float toY, float duration) {
        return moveTo(target, toX, toY, duration, UITween.Ease.Linear, null);
    }

    public static UITween moveTo(UIElement target, float toX, float toY, float duration, UITween.Ease ease, Runnable onComplete) {
        return moveTo(target, toX, toY, duration, ease, UITween.LoopType.None, 0, onComplete);
    }

    public static UITween sizeTo(UIElement target, float toWidth, float toHeight, float duration, UITween.Ease ease, UITween.LoopType loopType, int loopCount, Runnable onComplete) {
        if (target == null) {
            return null;
        }
        UITween tw = new UITween(target::getWidth, v -> target.setSize(v, target.getHeight()), toWidth, duration, ease, null, loopType, loopCount);
        UITween th = new UITween(target::getHeight, v -> target.setSize(target.getWidth(), v), toHeight, duration, ease, onComplete, loopType, loopCount);
        UITweenManager.get().add(tw);
        UITweenManager.get().add(th);
        return th;
    }

    public static UITween sizeTo(UIElement target, float toWidth, float toHeight, float duration) {
        return sizeTo(target, toWidth, toHeight, duration, UITween.Ease.Linear, null);
    }

    public static UITween sizeTo(UIElement target, float toWidth, float toHeight, float duration, UITween.Ease ease, Runnable onComplete) {
        return sizeTo(target, toWidth, toHeight, duration, ease, UITween.LoopType.None, 0, onComplete);
    }

    public static UITween fadePanelAlpha(UIPanel panel, int targetAlpha, float duration, UITween.Ease ease, UITween.LoopType loopType, int loopCount, Runnable onComplete) {
        if (panel == null || panel.getBackgroundColor() == null) {
            return null;
        }
        int clamped = Math.max(0, Math.min(255, targetAlpha));
        Color bg = panel.getBackgroundColor();
        UITween tween = new UITween(() -> bg.getAlpha(), v -> {
            Color current = panel.getBackgroundColor();
            if (current == null) {
                return;
            }
            int a = Math.max(0, Math.min(255, Math.round(v)));
            panel.setBackgroundColor(new Color(current.getRed(), current.getGreen(), current.getBlue(), a));
        }, clamped, duration, ease, onComplete, loopType, loopCount);
        UITweenManager.get().add(tween);
        return tween;
    }

    public static UITween fadePanelAlpha(UIPanel panel, int targetAlpha, float duration) {
        return fadePanelAlpha(panel, targetAlpha, duration, UITween.Ease.Linear, null);
    }

    public static UITween fadePanelAlpha(UIPanel panel, int targetAlpha, float duration, UITween.Ease ease, Runnable onComplete) {
        return fadePanelAlpha(panel, targetAlpha, duration, ease, UITween.LoopType.None, 0, onComplete);
    }

    public static UITween shakePosition(UIElement target, float amplitude, float duration, UITween.Ease ease, UITween.LoopType loopType, int loopCount, Runnable onComplete) {
        if (target == null) {
            return null;
        }
        float baseX = target.getX();
        float baseY = target.getY();
        float amp = Math.max(0f, amplitude);
        UITween tween = new UITween(() -> amp, value -> {
            float offsetX = (float) ((ThreadLocalRandom.current().nextDouble() * 2.0 - 1.0) * value);
            float offsetY = (float) ((ThreadLocalRandom.current().nextDouble() * 2.0 - 1.0) * value);
            target.setPosition(baseX + offsetX, baseY + offsetY);
        }, 0f, duration, ease, () -> {
            target.setPosition(baseX, baseY);
            if (onComplete != null) {
                onComplete.run();
            }
        }, loopType, loopCount);
        UITweenManager.get().add(tween);
        return tween;
    }

    public static UITween shakePosition(UIElement target, float amplitude, float duration) {
        return shakePosition(target, amplitude, duration, UITween.Ease.EaseOut, null);
    }

    public static UITween shakePosition(UIElement target, float amplitude, float duration, UITween.Ease ease, Runnable onComplete) {
        return shakePosition(target, amplitude, duration, ease, UITween.LoopType.None, 0, onComplete);
    }
}
