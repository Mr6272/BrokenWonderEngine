package UI;

import com.jogamp.opengl.util.awt.TextRenderer;

import javax.media.opengl.GL2;
import java.awt.Color;

public class UILabel extends UIElement {
    private String text;
    private Color color = new Color(255, 255, 255, 255);

    public UILabel(String name, String text, float x, float y) {
        super(name, x, y, 0, 0);
        this.text = text;
    }

    public void setText(String text) {
        this.text = text;
    }

    public String getText() {
        return text;
    }

    public void setColor(Color color) {
        this.color = color;
    }

    public Color getColor() {
        return color;
    }

    @Override
    protected void drawSelf(GL2 gl, TextRenderer textRenderer) {
        if (text == null || text.isEmpty()) {
            return;
        }
        TextRenderUtils.begin(textRenderer);
        textRenderer.setColor(color);
        int drawX = Math.round(getAbsoluteX());
        int drawY = Math.round(getAbsoluteY());
        textRenderer.draw(text, drawX, drawY);
        TextRenderUtils.end(textRenderer);
    }
}
