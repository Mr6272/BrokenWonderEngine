package UI;

import com.jogamp.opengl.util.awt.TextRenderer;

import javax.media.opengl.GL2;
import java.awt.Color;
import java.awt.geom.Rectangle2D;

public class UIButton extends UIPanel {
    private String text;
    private Runnable onClick;
    private Color textColor = new Color(255, 255, 255, 255);
    private Color hoverColor = new Color(60, 60, 60, 200);
    private Color pressColor = new Color(80, 80, 80, 220);
    private boolean pressed;

    public UIButton(String name, String text, float x, float y, float width, float height) {
        super(name, x, y, width, height);
        this.text = text;
    }

    public void setOnClick(Runnable onClick) {
        this.onClick = onClick;
    }

    public void setText(String text) {
        this.text = text;
    }

    public String getText() {
        return text;
    }

    public void setTextColor(Color textColor) {
        this.textColor = textColor;
    }

    public void setHoverColor(Color hoverColor) {
        this.hoverColor = hoverColor;
    }

    public void setPressColor(Color pressColor) {
        this.pressColor = pressColor;
    }

    @Override
    public void update(UIMouse mouse) {
        super.update(mouse);
        if (!isEnabled() || !isVisible()) {
            pressed = false;
            return;
        }
        boolean hover = isHovered();
        if (hover && mouse.isLeftPressed()) {
            pressed = true;
        }
        if (!mouse.isLeftDown()) {
            if (pressed && hover && mouse.isLeftReleased()) {
                if (onClick != null) {
                    onClick.run();
                }
            }
            pressed = false;
        }
    }

    @Override
    protected void drawSelf(GL2 gl, TextRenderer textRenderer) {
        Color base = getBackgroundColor();
        if (pressed) {
            base = pressColor;
        } else if (isHovered()) {
            base = hoverColor;
        }
        if (base != null) {
            UIRenderHelper.fillRect(gl, getAbsoluteX(), getAbsoluteY(), width, height, base);
        }
        if (getBorderColor() != null && getBorderThickness() > 0f) {
            UIRenderHelper.drawBorder(gl, getAbsoluteX(), getAbsoluteY(), width, height, getBorderThickness(), getBorderColor());
        }
        if (text != null && !text.isEmpty()) {
            Rectangle2D bounds = textRenderer.getBounds(text);
            float textX = getAbsoluteX() + (width - (float) bounds.getWidth()) * 0.5f;
            float textY = getAbsoluteY() + (height - (float) bounds.getHeight()) * 0.5f;
            textRenderer.setColor(textColor);
            textRenderer.draw(text, Math.round(textX), Math.round(textY));
        }
    }
}
