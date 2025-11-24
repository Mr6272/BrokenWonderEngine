package UI;

import TypeStructure.Sprite;
import TypeStructure.SpriteAtlas;
import TypeStructure.SpriteWrapMode;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.awt.Color;
import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * JSON-driven layout loader for UI elements.
 *
 * Supported element fields (per ElementConfig):
 * - type: panel | label | button | image
 * - name: unique identifier
 * - position: { x, y }
 * - size: { width, height }
 * - zIndex, visible, enabled
 * - background: "#RRGGBB" or "#RRGGBBAA"
 * - border: { color, thickness }
 * - text / color (label) / textColor (button)
 * - hoverColor / pressColor (button)
 * - sprite: see SpriteConfig for image
 * - autoPlay, frameRate, frame, fitSpriteSize (image)
 * - children: nested ElementConfig list
 */
public final class UIJsonLayoutLoader {
    private static final Gson GSON = new GsonBuilder().create();

    private UIJsonLayoutLoader() {
    }

    public static UILayout readLayout(String path) {
        if (path == null || path.isEmpty()) {
            return new UILayout();
        }
        try (Reader reader = Files.newBufferedReader(Paths.get(path), StandardCharsets.UTF_8)) {
            UILayout layout = GSON.fromJson(reader, UILayout.class);
            return layout == null ? new UILayout() : layout;
        } catch (IOException ex) {
            System.err.println("UIJsonLayoutLoader: failed to read layout " + path + " -> " + ex.getMessage());
            return new UILayout();
        }
    }

    public static List<UIElement> buildAll(UILayout layout) {
        if (layout == null) {
            return Collections.emptyList();
        }
        List<UIElement> result = new ArrayList<>();
        if (layout.elements != null) {
            result.addAll(buildElements(layout.elements));
        }
        if (layout.groups != null) {
            for (UIGroupConfig group : layout.groups) {
                result.addAll(buildElements(group.elements));
            }
        }
        return result;
    }

    public static List<UIElement> buildGroup(UILayout layout, String groupName) {
        if (layout == null || groupName == null) {
            return Collections.emptyList();
        }
        if (layout.groups != null) {
            for (UIGroupConfig group : layout.groups) {
                if (groupName.equalsIgnoreCase(group.name)) {
                    return buildElements(group.elements);
                }
            }
        }
        return Collections.emptyList();
    }

    public static UIElement buildElementByName(UILayout layout, String elementName) {
        if (layout == null || elementName == null) {
            return null;
        }
        if (layout.elements != null) {
            for (ElementConfig config : layout.elements) {
                ElementConfig found = findElement(config, elementName);
                if (found != null) {
                    return buildElement(found);
                }
            }
        }
        if (layout.groups != null) {
            for (UIGroupConfig group : layout.groups) {
                if (group.elements == null) {
                    continue;
                }
                for (ElementConfig config : group.elements) {
                    ElementConfig found = findElement(config, elementName);
                    if (found != null) {
                        return buildElement(found);
                    }
                }
            }
        }
        return null;
    }

    public static List<UIElement> buildElements(List<ElementConfig> configs) {
        if (configs == null || configs.isEmpty()) {
            return Collections.emptyList();
        }
        List<UIElement> list = new ArrayList<>();
        for (ElementConfig config : configs) {
            UIElement element = buildElement(config);
            if (element != null) {
                list.add(element);
            }
        }
        return list;
    }

    private static UIElement buildElement(ElementConfig config) {
        if (config == null || config.type == null || config.name == null) {
            return null;
        }
        String type = config.type.toLowerCase(Locale.ROOT);
        UIElement element;
        switch (type) {
            case "label":
                element = createLabel(config);
                break;
            case "text":
                element = createText(config);
                break;
            case "button":
                element = createButton(config);
                break;
            case "image":
                element = createImage(config);
                break;
            case "panel":
            default:
                element = createPanel(config);
                break;
        }
        if (element != null && config.children != null) {
            for (ElementConfig child : config.children) {
                UIElement builtChild = buildElement(child);
                if (builtChild != null) {
                    element.addChild(builtChild);
                }
            }
        }
        return element;
    }

    private static UIPanel createPanel(ElementConfig config) {
        UIPanel panel = new UIPanel(config.name, config.position == null ? 0f : getX(config),
                config.position == null ? 0f : getY(config),
                config.size == null ? 0f : getWidth(config),
                config.size == null ? 0f : getHeight(config));
        applyCommon(panel, config);
        if (config.background != null) {
            panel.setBackgroundColor(parseColor(config.background, panel.getBackgroundColor()));
        }
        if (config.border != null) {
            Color borderColor = parseColor(config.border.color, panel.getBorderColor());
            float thickness = config.border.thickness == null ? panel.getBorderThickness() : config.border.thickness;
            panel.setBorder(borderColor, thickness);
        }
        return panel;
    }

    private static UILabel createLabel(ElementConfig config) {
        UILabel label = new UILabel(config.name, config.text == null ? "" : config.text,
                config.position == null ? 0f : getX(config),
                config.position == null ? 0f : getY(config));
        applyCommon(label, config);
        if (config.color != null) {
            label.setColor(parseColor(config.color, label.getColor()));
        }
        return label;
    }

    private static UIText createText(ElementConfig config) {
        UIText text = new UIText(config.name, config.text == null ? "" : config.text,
                config.position == null ? 0f : getX(config),
                config.position == null ? 0f : getY(config));
        applyCommon(text, config);
        if (config.color != null) {
            text.setColor(parseColor(config.color, text.getColor()));
        }
        if (config.maxWidth != null) {
            text.setMaxWidth(config.maxWidth);
        }
        if (config.lineSpacing != null) {
            text.setLineSpacing(config.lineSpacing);
        }
        if (config.align != null) {
            text.setAlign(parseAlign(config.align));
        }
        return text;
    }

    private static UIButton createButton(ElementConfig config) {
        UIButton button = new UIButton(config.name, config.text == null ? "" : config.text,
                config.position == null ? 0f : getX(config),
                config.position == null ? 0f : getY(config),
                config.size == null ? 0f : getWidth(config),
                config.size == null ? 0f : getHeight(config));
        applyCommon(button, config);
        if (config.background != null) {
            button.setBackgroundColor(parseColor(config.background, button.getBackgroundColor()));
        }
        if (config.textColor != null) {
            button.setTextColor(parseColor(config.textColor, Color.WHITE));
        }
        if (config.hoverColor != null) {
            button.setHoverColor(parseColor(config.hoverColor, Color.GRAY));
        }
        if (config.pressColor != null) {
            button.setPressColor(parseColor(config.pressColor, Color.DARK_GRAY));
        }
        if (config.border != null) {
            Color borderColor = parseColor(config.border.color, Color.WHITE);
            float thickness = config.border.thickness == null ? 0f : config.border.thickness;
            button.setBorder(borderColor, thickness);
        }
        return button;
    }

    private static UIImage createImage(ElementConfig config) {
        Sprite sprite = buildSprite(config.sprite);
        UIImage image = new UIImage(config.name, sprite,
                config.position == null ? 0f : getX(config),
                config.position == null ? 0f : getY(config),
                config.size == null ? 0f : getWidth(config),
                config.size == null ? 0f : getHeight(config));
        applyCommon(image, config);
        if (sprite == null && config.imagePath != null) {
            image.setExternalImage(config.imagePath, false);
        } else if (sprite == null && config.imageUrl != null) {
            image.setExternalImage(config.imageUrl, true);
        }
        if (config.frame != null) {
            image.setFrame(config.frame);
        }
        if (config.frameRate != null) {
            image.setFrameRate(config.frameRate);
        }
        if (config.autoPlay != null) {
            image.setAutoPlay(config.autoPlay);
        }
        autoSizeImage(image, config);
        return image;
    }

    private static void applyCommon(UIElement element, ElementConfig config) {
        if (config.position != null) {
            element.setPosition(getX(config), getY(config));
        }
        if (config.size != null) {
            element.setSize(getWidth(config), getHeight(config));
        }
        if (config.visible != null) {
            element.setVisible(config.visible);
        }
        if (config.enabled != null) {
            element.setEnabled(config.enabled);
        }
        if (config.zIndex != null) {
            element.setZIndex(config.zIndex);
        }
    }

    private static void autoSizeImage(UIImage image, ElementConfig config) {
        boolean keepAspect = config.keepAspect == null || config.keepAspect;
        float w = config.size == null || config.size.width == null ? 0f : config.size.width;
        float h = config.size == null || config.size.height == null ? 0f : config.size.height;
        int intrinsicW = 0;
        int intrinsicH = 0;
        if (image.getSprite() != null) {
            if (Boolean.TRUE.equals(config.fitSpriteSize) || w <= 0f || h <= 0f) {
                image.fitToSpriteSize();
                intrinsicW = (int) image.getWidth();
                intrinsicH = (int) image.getHeight();
            } else {
                image.setSize(w, h);
                intrinsicW = (int) w;
                intrinsicH = (int) h;
            }
        } else if (config.imagePath != null || config.imageUrl != null) {
            float[] dims = probeExternalImage(config.imagePath, config.imageUrl);
            intrinsicW = Math.round(dims[0]);
            intrinsicH = Math.round(dims[1]);
        }
        if (intrinsicW <= 0 || intrinsicH <= 0) {
            return;
        }
        if (w > 0f && h > 0f && !keepAspect) {
            image.setSize(w, h);
            return;
        }
        if (w > 0f && h > 0f) {
            // Both provided; scale to fit while keeping aspect if requested.
            if (keepAspect) {
                float scale = Math.min(w / intrinsicW, h / intrinsicH);
                image.setSize(intrinsicW * scale, intrinsicH * scale);
            } else {
                image.setSize(w, h);
            }
        } else if (w > 0f) {
            float scale = keepAspect ? (w / intrinsicW) : 1f;
            image.setSize(w, keepAspect ? intrinsicH * scale : intrinsicH);
        } else if (h > 0f) {
            float scale = keepAspect ? (h / intrinsicH) : 1f;
            image.setSize(keepAspect ? intrinsicW * scale : intrinsicW, h);
        } else {
            image.setSize(intrinsicW, intrinsicH);
        }
    }

    private static float[] probeExternalImage(String path, String url) {
        float[] dims = new float[]{0f, 0f};
        try {
            java.awt.image.BufferedImage img;
            if (url != null) {
                img = javax.imageio.ImageIO.read(new java.net.URL(url));
            } else if (path != null) {
                img = javax.imageio.ImageIO.read(new java.io.File(path));
            } else {
                return dims;
            }
            if (img != null) {
                dims[0] = img.getWidth();
                dims[1] = img.getHeight();
            }
        } catch (Exception ignored) {
        }
        return dims;
    }

    private static Sprite buildSprite(SpriteConfig config) {
        if (config == null || config.mode == null) {
            return null;
        }
        SpriteWrapMode wrap = parseWrap(config.wrap);
        String mode = config.mode.toLowerCase(Locale.ROOT);
        try {
            switch (mode) {
                case "single":
                    if (config.singlePath != null && config.singleName != null) {
                        return new Sprite(wrap, config.singlePath, config.singleName);
                    }
                    break;
                case "multiple":
                    if (config.folder != null && config.head != null && config.end != null) {
                        return new Sprite(wrap, config.folder, config.head, config.end);
                    }
                    break;
                case "atlas":
                    if (config.atlasPath != null && config.atlasColumns != null && config.atlasRows != null
                            && config.atlasSize != null && config.atlasStart != null && config.atlasEnd != null) {
                        SpriteAtlas atlas = new SpriteAtlas(config.atlasPath, config.atlasColumns, config.atlasRows,
                                config.atlasStart, config.atlasEnd, config.atlasSize);
                        return new Sprite(wrap, atlas);
                    }
                    break;
                default:
                    break;
            }
        } catch (Exception ex) {
            System.err.println("UIJsonLayoutLoader: failed to build sprite '" + config.mode + "' -> " + ex.getMessage());
        }
        return null;
    }

    private static SpriteWrapMode parseWrap(String wrap) {
        if (wrap == null) {
            return SpriteWrapMode.Clamp;
        }
        try {
            return SpriteWrapMode.valueOf(wrap);
        } catch (IllegalArgumentException ex) {
            return SpriteWrapMode.Clamp;
        }
    }

    private static UIText.Align parseAlign(String align) {
        if (align == null) {
            return UIText.Align.Left;
        }
        try {
            return UIText.Align.valueOf(align);
        } catch (IllegalArgumentException ex) {
            return UIText.Align.Left;
        }
    }

    private static float getX(ElementConfig config) {
        return config.position == null || config.position.x == null ? 0f : config.position.x;
    }

    private static float getY(ElementConfig config) {
        return config.position == null || config.position.y == null ? 0f : config.position.y;
    }

    private static float getWidth(ElementConfig config) {
        return config.size == null || config.size.width == null ? 0f : config.size.width;
    }

    private static float getHeight(ElementConfig config) {
        return config.size == null || config.size.height == null ? 0f : config.size.height;
    }

    private static Color parseColor(String hex, Color fallback) {
        if (hex == null || hex.isEmpty()) {
            return fallback;
        }
        String value = hex.trim();
        if (value.startsWith("#")) {
            value = value.substring(1);
        }
        try {
            if (value.length() == 6) {
                int r = Integer.parseInt(value.substring(0, 2), 16);
                int g = Integer.parseInt(value.substring(2, 4), 16);
                int b = Integer.parseInt(value.substring(4, 6), 16);
                return new Color(r, g, b);
            } else if (value.length() == 8) {
                int r = Integer.parseInt(value.substring(0, 2), 16);
                int g = Integer.parseInt(value.substring(2, 4), 16);
                int b = Integer.parseInt(value.substring(4, 6), 16);
                int a = Integer.parseInt(value.substring(6, 8), 16);
                return new Color(r, g, b, a);
            }
        } catch (NumberFormatException ignored) {
            // fallback below
        }
        return fallback;
    }

    private static ElementConfig findElement(ElementConfig root, String name) {
        if (root == null) {
            return null;
        }
        if (name.equals(root.name)) {
            return root;
        }
        if (root.children != null) {
            for (ElementConfig child : root.children) {
                ElementConfig found = findElement(child, name);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    public static class UILayout {
        public List<ElementConfig> elements = new ArrayList<>();
        public List<UIGroupConfig> groups = new ArrayList<>();
    }

    public static class UIGroupConfig {
        public String name;
        public List<ElementConfig> elements = new ArrayList<>();
    }

    public static class ElementConfig {
        public String type;
        public String name;
        public Vec2 position;
        public Size size;
        public Boolean keepAspect;
        public Boolean visible;
        public Boolean enabled;
        public Float zIndex;
        public String background;
        public Border border;
        public String text;
        public String color;
        public String textColor;
        public String hoverColor;
        public String pressColor;
        public String align;
        public Float lineSpacing;
        public Float maxWidth;
        public SpriteConfig sprite;
        public String imagePath;
        public String imageUrl;
        public Boolean autoPlay;
        public Float frameRate;
        public Integer frame;
        public Boolean fitSpriteSize;
        public List<ElementConfig> children;
    }

    public static class Vec2 {
        public Float x;
        public Float y;
    }

    public static class Size {
        public Float width;
        public Float height;
    }

    public static class Border {
        public String color;
        public Float thickness;
    }

    public static class SpriteConfig {
        public String mode; // single | multiple | atlas
        public String wrap; // Repeat | Clamp | Mirror
        public String singlePath;
        public String singleName;
        public String folder;
        public String head;
        public Integer end;
        public String atlasPath;
        public Integer atlasColumns;
        public Integer atlasRows;
        public Integer atlasSize;
        public Integer atlasStart;
        public Integer atlasEnd;
    }
}
