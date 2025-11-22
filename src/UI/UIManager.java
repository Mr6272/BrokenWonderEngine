package UI;

import com.jogamp.opengl.util.awt.TextRenderer;

import Core.GameRenderer;
import javax.media.opengl.GL2;
import javax.media.opengl.GLAutoDrawable;
import java.awt.Font;
import java.util.ArrayList;
import java.util.List;

/**
 * Singleton UI manager responsible for updating and rendering screen-space widgets.
 */
public class UIManager {
    private static final UIManager INSTANCE = new UIManager();

    private final List<UIElement> roots = new ArrayList<>();
    private final TextRenderer textRenderer;
    private int viewportWidth = 1;
    private int viewportHeight = 1;

    private UIManager() {
        textRenderer = new TextRenderer(new Font("SansSerif", Font.PLAIN, 18), true, true);
    }

    public static UIManager getInstance() {
        return INSTANCE;
    }

    public void addElement(UIElement element) {
        if (element != null && !roots.contains(element)) {
            roots.add(element);
        }
    }

    public void removeElement(UIElement element) {
        roots.remove(element);
    }

    public void clear() {
        roots.clear();
    }

    public void beginFrame(GLAutoDrawable drawable) {
        viewportWidth = Math.max(1, drawable.getWidth());
        viewportHeight = Math.max(1, drawable.getHeight());
        UIMouse mouse = UIMouse.get();
        mouse.setViewport(viewportWidth, viewportHeight);
        mouse.beginFrame();
    }

    public void update() {
        float dt = 1f / GameRenderer.Frame;
        UITweenManager.get().update(dt);
        if (roots.isEmpty()) {
            return;
        }
        UIMouse mouse = UIMouse.get();
        UIElement hovered = findTopElement(mouse.getX(), mouse.getY());
        clearHover(roots);
        if (hovered != null) {
            hovered.setHovered(true);
        }
        for (UIElement element : roots) {
            element.update(mouse);
        }
    }

    public void render(GLAutoDrawable drawable) {
        if (roots.isEmpty()) {
            return;
        }
        GL2 gl = drawable.getGL().getGL2();
        gl.glMatrixMode(GL2.GL_PROJECTION);
        gl.glPushMatrix();
        gl.glLoadIdentity();
        gl.glOrtho(0, viewportWidth, 0, viewportHeight, -1, 1);

        gl.glMatrixMode(GL2.GL_MODELVIEW);
        gl.glPushMatrix();
        gl.glLoadIdentity();
        gl.glDisable(GL2.GL_DEPTH_TEST);
        gl.glDisable(GL2.GL_CULL_FACE);
        gl.glEnable(GL2.GL_BLEND);
        gl.glBlendFunc(GL2.GL_SRC_ALPHA, GL2.GL_ONE_MINUS_SRC_ALPHA);

        textRenderer.beginRendering(viewportWidth, viewportHeight);
        for (UIElement element : roots) {
            element.render(gl, textRenderer);
        }
        textRenderer.endRendering();

        gl.glPopMatrix();
        gl.glMatrixMode(GL2.GL_PROJECTION);
        gl.glPopMatrix();
        gl.glMatrixMode(GL2.GL_MODELVIEW);
        gl.glEnable(GL2.GL_DEPTH_TEST);
        gl.glEnable(GL2.GL_TEXTURE_2D);
    }

    public void endFrame() {
        UIMouse.get().endFrame();
    }

    private void clearHover(List<UIElement> list) {
        for (UIElement element : list) {
            element.setHovered(false);
            clearHover(element.getChildren());
        }
    }

    private UIElement findTopElement(float x, float y) {
        UIElement target = null;
        for (int i = roots.size() - 1; i >= 0; i--) {
            target = findTopElementRecursive(roots.get(i), x, y, target);
        }
        return target;
    }

    private UIElement findTopElementRecursive(UIElement element, float x, float y, UIElement current) {
        if (element == null || !element.isVisible() || !element.isEnabled()) {
            return current;
        }
        List<UIElement> children = element.getChildren();
        for (int i = children.size() - 1; i >= 0; i--) {
            current = findTopElementRecursive(children.get(i), x, y, current);
        }
        if (element.contains(x, y)) {
            if (current == null || element.getZIndex() >= current.getZIndex()) {
                return element;
            }
        }
        return current;
    }
}
