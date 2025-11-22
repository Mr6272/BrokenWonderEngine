package UI;

import com.jogamp.opengl.util.awt.TextRenderer;

import javax.media.opengl.GL2;
import java.util.ArrayList;
import java.util.List;

/**
 * Base class for screen-space UI elements.
 */
public class UIElement {
    private final String name;
    protected float x;
    protected float y;
    protected float width;
    protected float height;
    private boolean visible = true;
    private boolean enabled = true;
    private boolean hovered = false;
    private float zIndex = 0f;
    private UIElement parent;
    private final List<UIElement> children = new ArrayList<>();

    public UIElement(String name, float x, float y, float width, float height) {
        this.name = name;
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
    }

    public String getName() {
        return name;
    }

    public float getX() {
        return x;
    }

    public float getY() {
        return y;
    }

    public float getWidth() {
        return width;
    }

    public float getHeight() {
        return height;
    }

    public void setSize(float width, float height) {
        this.width = width;
        this.height = height;
    }

    public void setPosition(float x, float y) {
        this.x = x;
        this.y = y;
    }

    public boolean isVisible() {
        return visible;
    }

    public void setVisible(boolean visible) {
        this.visible = visible;
    }

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public boolean isHovered() {
        return hovered;
    }

    public void setHovered(boolean hovered) {
        this.hovered = hovered;
    }

    public float getZIndex() {
        return zIndex;
    }

    public void setZIndex(float zIndex) {
        this.zIndex = zIndex;
    }

    public UIElement getParent() {
        return parent;
    }

    public void setParent(UIElement parent) {
        this.parent = parent;
    }

    public List<UIElement> getChildren() {
        return children;
    }

    public void addChild(UIElement child) {
        if (child != null && !children.contains(child)) {
            child.setParent(this);
            children.add(child);
        }
    }

    public void removeChild(UIElement child) {
        if (child != null) {
            children.remove(child);
            child.setParent(null);
        }
    }

    public float getAbsoluteX() {
        if (parent == null) {
            return x;
        }
        return parent.getAbsoluteX() + x;
    }

    public float getAbsoluteY() {
        if (parent == null) {
            return y;
        }
        return parent.getAbsoluteY() + y;
    }

    public boolean contains(float px, float py) {
        float ax = getAbsoluteX();
        float ay = getAbsoluteY();
        return px >= ax && px <= ax + width && py >= ay && py <= ay + height;
    }

    public void update(UIMouse mouse) {
        if (!enabled || !visible) {
            return;
        }
        for (UIElement child : children) {
            child.update(mouse);
        }
    }

    public final void render(GL2 gl, TextRenderer textRenderer) {
        if (!visible) {
            return;
        }
        drawSelf(gl, textRenderer);
        for (UIElement child : children) {
            child.render(gl, textRenderer);
        }
    }

    protected void drawSelf(GL2 gl, TextRenderer textRenderer) {
        // base element does not draw by default
    }
}
