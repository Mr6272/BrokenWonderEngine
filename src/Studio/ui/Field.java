package Studio.ui;

import javax.swing.BorderFactory;
import javax.swing.JTextField;
import java.awt.Color;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.event.FocusAdapter;
import java.awt.event.FocusEvent;

/**
 * 统一样式输入框。
 *
 * 容错纪律（对应"用户乱操作也不炸"）：
 * - 数值模式下，用户中途清空、打字打到一半（如 "-"、"."）都不报警、不弹窗、不改值；
 * - 只有失焦那一刻才校验，非法则回退到进入编辑前的值，并在边框上做一次短暂提示；
 * - 永远不因为输入非法而丢掉用户原本的数据。
 */
public class Field extends JTextField {

    private final String placeholder;
    private boolean numeric;
    private float numMin = Float.NEGATIVE_INFINITY;
    private float numMax = Float.POSITIVE_INFINITY;
    private float lastGood;
    private boolean invalidFlash;
    private String unit = "";

    public Field(String initial, String placeholder) {
        super(initial == null ? "" : initial);
        this.placeholder = placeholder == null ? "" : placeholder;
        setFont(Theme.F_BODY);
        setOpaque(false);
        setBorder(BorderFactory.createEmptyBorder(5, 9, 5, 9));
        addFocusListener(new FocusAdapter() {
            @Override
            public void focusLost(FocusEvent e) {
                commit();
            }
        });
    }

    /** 数值输入：限定范围，失焦校验。 */
    public Field numeric(float def, float min, float max) {
        numeric = true;
        numMin = min;
        numMax = max;
        lastGood = def;
        setText(ParamFmt.trim(def));
        return this;
    }

    /** 数值单位后缀（只影响绘制，不进入文本）。 */
    public Field unit(String u) {
        unit = u == null ? "" : u;
        return this;
    }

    public float floatValue(float fallback) {
        try {
            return Float.parseFloat(getText().trim());
        } catch (Exception e) {
            return fallback;
        }
    }

    public int intValue(int fallback) {
        return Math.round(floatValue(fallback));
    }

    private void commit() {
        if (!numeric) {
            return;
        }
        String t = getText().trim();
        if (t.isEmpty()) {
            setText(ParamFmt.trim(lastGood));
            return;
        }
        float v;
        try {
            v = Float.parseFloat(t);
        } catch (NumberFormatException e) {
            flash();
            setText(ParamFmt.trim(lastGood));
            return;
        }
        if (v < numMin || v > numMax) {
            flash();
            v = Math.max(numMin, Math.min(numMax, v));
            setText(ParamFmt.trim(v));
        }
        lastGood = v;
        repaint();
    }

    private void flash() {
        invalidFlash = true;
        repaint();
        javax.swing.Timer t = new javax.swing.Timer(520, e -> {
            invalidFlash = false;
            repaint();
            ((javax.swing.Timer) e.getSource()).stop();
        });
        t.setRepeats(false);
        t.start();
    }

    @Override
    protected void paintComponent(Graphics g) {
        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        int w = getWidth(), h = getHeight();

        g2.setColor(isEnabled() ? Theme.SURFACE : Theme.SURFACE_ALT);
        g2.fillRoundRect(0, 0, w - 1, h - 1, Theme.R_MD, Theme.R_MD);
        Color border = invalidFlash ? Theme.DANGER
                : (isFocusOwner() ? Theme.ACCENT : (isEnabled() ? Theme.LINE : Theme.LINE_SOFT));
        g2.setColor(border);
        g2.drawRoundRect(0, 0, w - 1, h - 1, Theme.R_MD, Theme.R_MD);

        String text = getText();
        FontMetrics fm = g2.getFontMetrics(getFont());
        int tx = 9;
        int ty = (h - fm.getHeight()) / 2 + fm.getAscent();

        if ((text == null || text.isEmpty()) && !isFocusOwner() && !placeholder.isEmpty()) {
            g2.setFont(getFont());
            g2.setColor(Theme.INK_MUTE);
            g2.drawString(placeholder, tx, ty);
        } else if (text != null && !text.isEmpty()) {
            g2.setFont(getFont());
            g2.setColor(isEnabled() ? Theme.INK : Theme.INK_MUTE);
            g2.drawString(text, tx, ty);
        }
        if (!unit.isEmpty()) {
            g2.setFont(Theme.F_SMALL);
            g2.setColor(Theme.INK_MUTE);
            int uw = g2.getFontMetrics().stringWidth(unit);
            g2.drawString(unit, w - 9 - uw, ty - 1);
        }

        // 光标自己画（原生绘制在圆角外框下位置会偏）
        if (isFocusOwner() && getCaretPosition() >= 0 && text != null) {
            int cx = tx + fm.stringWidth(text.substring(0, Math.min(getCaretPosition(), text.length())));
            g2.setColor(Theme.ACCENT);
            g2.fillRect(cx, (h - fm.getAscent()) / 2, 1, fm.getAscent());
        }
        g2.dispose();
    }

    /** 数值格式化：整数不带小数点。 */
    public static final class ParamFmt {
        private ParamFmt() {
        }

        public static String trim(float v) {
            if (v == Math.round(v)) {
                return String.valueOf(Math.round(v));
            }
            String s = String.valueOf(v);
            return s.endsWith("0") ? s.substring(0, s.length() - 1) : s;
        }
    }
}
