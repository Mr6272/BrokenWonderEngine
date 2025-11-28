package UserUsage.FightMengpo;

import Core.GameRenderer;
import Framework.GameObject;
import UI.UIText;
import UI.UIManager;
import Tool.Log;

/**
 * Simple typewriter effect: gradually reveals a string on a target UIText.
 * Create a new instance (or call start) to run; it auto-adds itself to the GameSekai list via GameObject ctor.
 */
public class TypewriterEffect extends GameObject {
    private final UIText target;
    private final String fullText;
    private final float interval;
    private int index = 0;
    private float timer = 0f;

    /**
     * @param target  UIText to write into
     * @param text    full text content
     * @param cps     characters per second (>= 1)
     */
    public TypewriterEffect(UIText target, String text, float cps) {
        this.target = target;
        this.fullText = text == null ? "" : text;
        this.interval = cps <= 0f ? 0.05f : 1f / cps;
        if (target != null) {
            target.setText("");
        }
    }

    /**
     * Convenience: find UIText by name and start effect.
     */
    public static void start(String uiTextName, String text, float cps) {
        UIText t = (UIText) UIManager.getInstance().findElement(uiTextName);
        if (t == null) {
            Log.d("TypewriterEffect: UIText '" + uiTextName + "' not found");
            return;
        }
        new TypewriterEffect(t, text, cps);
    }

    @Override
    public void Update() {
        super.Update();
        if (target == null) {
            isEnabled = false;
            return;
        }
        if (index >= fullText.length()) {
            isEnabled = false;
            return;
        }
        float dt = 1f / GameRenderer.Frame;
        timer += dt;
        while (timer >= interval && index < fullText.length()) {
            timer -= interval;
            index++;
            target.setText(fullText.substring(0, index));
        }
    }
}
