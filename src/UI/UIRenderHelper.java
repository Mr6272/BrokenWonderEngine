package UI;

import javax.media.opengl.GL2;
import java.awt.Color;

public final class UIRenderHelper {
    private UIRenderHelper() {
    }

    public static void fillRect(GL2 gl, float x, float y, float width, float height, Color color) {
        if (gl == null || color == null) {
            return;
        }
        gl.glDisable(GL2.GL_TEXTURE_2D);
        gl.glColor4f(color.getRed() / 255f, color.getGreen() / 255f, color.getBlue() / 255f, color.getAlpha() / 255f);
        gl.glBegin(GL2.GL_QUADS);
        gl.glVertex2f(x, y);
        gl.glVertex2f(x + width, y);
        gl.glVertex2f(x + width, y + height);
        gl.glVertex2f(x, y + height);
        gl.glEnd();
        gl.glEnable(GL2.GL_TEXTURE_2D);
        gl.glColor4f(1f, 1f, 1f, 1f); // reset tint for following textured draws
    }

    public static void drawBorder(GL2 gl, float x, float y, float width, float height, float thickness, Color color) {
        if (gl == null || color == null || thickness <= 0f) {
            return;
        }
        fillRect(gl, x, y, width, thickness, color);
        fillRect(gl, x, y + height - thickness, width, thickness, color);
        fillRect(gl, x, y, thickness, height, color);
        fillRect(gl, x + width - thickness, y, thickness, height, color);
        gl.glColor4f(1f, 1f, 1f, 1f);
    }
}
