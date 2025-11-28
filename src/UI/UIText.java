package UI;

import com.jogamp.opengl.util.awt.TextRenderer;

import javax.media.opengl.GL2;
import java.awt.Color;
import java.awt.geom.Rectangle2D;
import java.util.ArrayList;
import java.util.List;

/**
 * Multi-line text element with optional wrapping and alignment.
 */
public class UIText extends UIElement {
    public enum Align {
        Left, Center, Right
    }

    private String text;
    private Color color = new Color(255, 255, 255, 255);
    private float maxWidth = 0f; // 0 = no wrap
    private float lineSpacing = 2f;
    private Align align = Align.Left;

    public UIText(String name, String text, float x, float y) {
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

    public void setMaxWidth(float maxWidth) {
        this.maxWidth = Math.max(0f, maxWidth);
    }

    public void setLineSpacing(float lineSpacing) {
        this.lineSpacing = Math.max(0f, lineSpacing);
    }

    public void setAlign(Align align) {
        if (align != null) {
            this.align = align;
        }
    }

    @Override
    protected void drawSelf(GL2 gl, TextRenderer textRenderer) {
        if (text == null || text.isEmpty()) {
            return;
        }
        TextRenderUtils.begin(textRenderer);
        textRenderer.setColor(color);
        List<String> lines = wrapText(text, textRenderer);
        float baseHeight = (float) textRenderer.getBounds("Ag").getHeight();
        if (baseHeight <= 0f) {
            baseHeight = textRenderer.getFont().getSize2D();
        }
        float lineHeight = baseHeight + lineSpacing;
        float ax = getAbsoluteX();
        float startY = getAbsoluteY();
        if (height > 0f) {
            startY += height - baseHeight;
        }
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            Rectangle2D bounds = textRenderer.getBounds(line);
            float drawX = ax;
            if (align == Align.Center) {
                drawX = ax + 0.5f * Math.max(0f, (maxWidth > 0 ? maxWidth : width) - (float) bounds.getWidth());
            } else if (align == Align.Right) {
                drawX = ax + Math.max(0f, (maxWidth > 0 ? maxWidth : width) - (float) bounds.getWidth());
            }
            float drawY = startY - i * lineHeight;
            textRenderer.draw(line, Math.round(drawX), Math.round(drawY));
        }
        TextRenderUtils.end(textRenderer);
    }

    private List<String> wrapText(String source, TextRenderer renderer) {
        List<String> result = new ArrayList<>();
        if (source == null) {
            return result;
        }
        String[] rawLines = source.split("\n");
        float wrapWidth = maxWidth > 0f ? maxWidth : width;
        for (String raw : rawLines) {
            if (wrapWidth <= 0f) {
                result.add(raw);
                continue;
            }
            result.addAll(wrapLine(raw, renderer, wrapWidth));
        }
        return result;
    }

    private List<String> wrapLine(String line, TextRenderer renderer, float wrapWidth) {
        List<String> lines = new ArrayList<>();
        if (line == null || line.isEmpty()) {
            lines.add("");
            return lines;
        }
        lines.addAll(wrapByCharacters(line, renderer, wrapWidth));
        return lines;
    }

    private List<String> wrapByCharacters(String line, TextRenderer renderer, float wrapWidth) {
        List<String> lines = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        for (int i = 0; i < line.length(); i++) {
            char ch = line.charAt(i);
            current.append(ch);
            Rectangle2D bounds = renderer.getBounds(current.toString());
            if ((float) bounds.getWidth() > wrapWidth && current.length() > 1) {
                // push previous characters (without current), start new line
                String flushed = current.substring(0, current.length() - 1);
                lines.add(flushed);
                current.setLength(0);
                current.append(ch);
            }
        }
        if (current.length() > 0) {
            lines.add(current.toString());
        }
        return lines;
    }
}
