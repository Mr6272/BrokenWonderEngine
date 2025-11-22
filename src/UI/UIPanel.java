package UI;

import com.jogamp.opengl.util.awt.TextRenderer;

import javax.media.opengl.GL2;
import java.awt.Color;

public class UIPanel extends UIElement {
    private Color backgroundColor = new Color(30, 30, 30, 160);
    private Color borderColor = null;
    private float borderThickness = 0f;

    public UIPanel(String name, float x, float y, float width, float height) {
        super(name, x, y, width, height);
    }

    public void setBackgroundColor(Color backgroundColor) {
        this.backgroundColor = backgroundColor;
    }

    public void setBorder(Color color, float thickness) {
        this.borderColor = color;
        this.borderThickness = thickness;
    }

    public Color getBackgroundColor() {
        return backgroundColor;
    }

    public Color getBorderColor() {
        return borderColor;
    }

    public float getBorderThickness() {
        return borderThickness;
    }

    @Override
    protected void drawSelf(GL2 gl, TextRenderer textRenderer) {
        float ax = getAbsoluteX();
        float ay = getAbsoluteY();
        if (backgroundColor != null) {
            UIRenderHelper.fillRect(gl, ax, ay, width, height, backgroundColor);
        }
        if (borderColor != null && borderThickness > 0f) {
            UIRenderHelper.drawBorder(gl, ax, ay, width, height, borderThickness, borderColor);
        }
    }
}
