package UI;

import com.jogamp.opengl.util.awt.TextRenderer;

/**
 * Small helper to avoid double beginRendering/endRendering on the shared TextRenderer.
 */
public final class TextRenderUtils {
    private TextRenderUtils() {
    }

    public static void begin(TextRenderer renderer) {
        if (renderer == null) {
            return;
        }
        renderer.beginRendering(UIManager.getViewportWidth(), UIManager.getViewportHeight());
    }

    public static void end(TextRenderer renderer) {
        if (renderer == null) {
            return;
        }
        renderer.endRendering();
    }
}
