package UI;

import AbstractLayer.MainWindow;
import com.jogamp.opengl.util.awt.TextRenderer;

import Core.GameRenderer;
import javax.media.opengl.GL2;
import javax.media.opengl.GLAutoDrawable;
import java.awt.Font;
import java.awt.GraphicsEnvironment;
import java.awt.event.KeyEvent;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Singleton UI manager responsible for updating and rendering screen-space widgets.
 */
public class UIManager {
    private static final UIManager INSTANCE = new UIManager();
    private static final String DEFAULT_LAYOUT_PATH = Paths.get("Data", "ui_layout.json").toString();

    private final List<UIElement> roots = new ArrayList<>();
    private final Map<String, List<UIElement>> namedGroups = new HashMap<>();
    private final TextRenderer textRenderer;
    private String hotReloadPath = DEFAULT_LAYOUT_PATH;
    private String hotReloadGroup = null;
    private int viewportWidth = 1;
    private int viewportHeight = 1;

    private UIManager() {
        textRenderer = new TextRenderer(selectFont(), true, true);
    }

    public static UIManager getInstance() {
        return INSTANCE;
    }

    private Font selectFont() {
        // Prefer free, widely available font families.
        List<String> preferred = Arrays.asList(
                "Noto Sans",
                "Noto Sans CJK SC",
                "Source Han Sans SC",
                "Source Han Sans CN",
                "Source Han Sans",
                "Inter",
                "DejaVu Sans",
                "WenQuanYi Zen Hei",
                "PingFang SC",
                Font.SANS_SERIF
        );
        GraphicsEnvironment ge = GraphicsEnvironment.getLocalGraphicsEnvironment();
        List<String> available = Arrays.asList(ge.getAvailableFontFamilyNames());
        for (String name : preferred) {
            if (available.contains(name)) {
                return new Font(name, Font.PLAIN, 20);
            }
        }
        return new Font(Font.SANS_SERIF, Font.PLAIN, 20);
    }

    public static int getViewportWidth() {
        return INSTANCE.viewportWidth;
    }

    public static int getViewportHeight() {
        return INSTANCE.viewportHeight;
    }

    public void addElement(UIElement element) {
        if (element != null && !roots.contains(element)) {
            roots.add(element);
        }
    }

    public void removeElement(UIElement element) {
        roots.remove(element);
        for (List<UIElement> group : namedGroups.values()) {
            group.remove(element);
        }
    }

    public void clear() {
        roots.clear();
        namedGroups.clear();
    }

    public UIElement findElement(String name) {
        if (name == null || name.isEmpty()) {
            return null;
        }
        for (UIElement root : roots) {
            UIElement found = findRecursive(root, name);
            if (found != null) {
                return found;
            }
        }
        return null;
    }

    public List<UIElement> loadLayoutFromJson(String path) {
        String resolved = (path == null || path.isEmpty()) ? DEFAULT_LAYOUT_PATH : path;
        UIJsonLayoutLoader.UILayout layout = UIJsonLayoutLoader.readLayout(resolved);
        List<UIElement> added = new ArrayList<>();
        clear();
        if (layout != null) {
            if (layout.elements != null && !layout.elements.isEmpty()) {
                List<UIElement> rootElements = UIJsonLayoutLoader.buildElements(layout.elements);
                registerGroup("root", rootElements);
                added.addAll(rootElements);
            }
            if (layout.groups != null) {
                for (UIJsonLayoutLoader.UIGroupConfig group : layout.groups) {
                    if (group == null || group.name == null) {
                        continue;
                    }
                    List<UIElement> groupElements = UIJsonLayoutLoader.buildElements(group.elements);
                    registerGroup(group.name, groupElements);
                    added.addAll(groupElements);
                }
            }
        }
        hotReloadPath = resolved;
        hotReloadGroup = null;
        return added;
    }

    public List<UIElement> loadGroupFromJson(String path, String groupName) {
        String resolved = (path == null || path.isEmpty()) ? DEFAULT_LAYOUT_PATH : path;
        String targetGroup = (groupName == null || groupName.isEmpty()) ? "default" : groupName;
        UIJsonLayoutLoader.UILayout layout = UIJsonLayoutLoader.readLayout(resolved);
        List<UIElement> groupElements = UIJsonLayoutLoader.buildGroup(layout, targetGroup);
        registerGroup(targetGroup, groupElements);
        hotReloadPath = resolved;
        hotReloadGroup = targetGroup;
        return groupElements;
    }

    public UIElement loadElementFromJson(String path, String elementName) {
        return loadElementFromJson(path, elementName, true);
    }

    public UIElement loadElementFromJson(String path, String elementName, boolean addAsRoot) {
        if (elementName == null || elementName.isEmpty()) {
            return null;
        }
        String resolved = (path == null || path.isEmpty()) ? DEFAULT_LAYOUT_PATH : path;
        UIJsonLayoutLoader.UILayout layout = UIJsonLayoutLoader.readLayout(resolved);
        UIElement element = UIJsonLayoutLoader.buildElementByName(layout, elementName);
        if (addAsRoot && element != null) {
            addElement(element);
        }
        hotReloadPath = resolved;
        return element;
    }

    public void setHotReloadTarget(String path, String groupName) {
        if (path != null && !path.isEmpty()) {
            hotReloadPath = path;
        }
        hotReloadGroup = (groupName == null || groupName.isEmpty()) ? null : groupName;
    }

    public void beginFrame(GLAutoDrawable drawable) {
        viewportWidth = Math.max(1, drawable.getWidth());
        viewportHeight = Math.max(1, drawable.getHeight());
        UIMouse mouse = UIMouse.get();
        mouse.setViewport(viewportWidth, viewportHeight);
        mouse.beginFrame();
    }

    public void update() {
        float dt = GameRenderer.deltaTime;
        UITweenManager.get().update(dt);
        hotReloadIfNeeded();
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

        List<UIElement> orderedRoots = new ArrayList<>(roots);
        orderedRoots.sort((a, b) -> Float.compare(a.getZIndex(), b.getZIndex()));
        for (UIElement element : orderedRoots) {
            element.render(gl, textRenderer);
        }

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

    private void registerGroup(String groupName, List<UIElement> elements) {
        String key = (groupName == null || groupName.isEmpty()) ? "group_" + namedGroups.size() : groupName;
        List<UIElement> existing = namedGroups.remove(key);
        if (existing != null) {
            for (UIElement element : existing) {
                roots.remove(element);
            }
        }
        if (elements == null || elements.isEmpty()) {
            return;
        }
        List<UIElement> copy = new ArrayList<>(elements);
        for (UIElement element : copy) {
            addElement(element);
        }
        namedGroups.put(key, copy);
    }

    private void hotReloadIfNeeded() {
        if (hotReloadPath == null || hotReloadPath.isEmpty()) {
            return;
        }
        if (MainWindow.keyManager.isKeyDown(KeyEvent.VK_F5)) {
            if (hotReloadGroup == null) {
                loadLayoutFromJson(hotReloadPath);
            } else {
                loadGroupFromJson(hotReloadPath, hotReloadGroup);
            }
        }
    }

    private UIElement findRecursive(UIElement element, String name) {
        if (element == null) {
            return null;
        }
        if (name.equals(element.getName())) {
            return element;
        }
        for (UIElement child : element.getChildren()) {
            UIElement found = findRecursive(child, name);
            if (found != null) {
                return found;
            }
        }
        return null;
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
            if (current == null || element.getZIndex() > current.getZIndex()) {
                return element;
            }
        }
        return current;
    }
}
