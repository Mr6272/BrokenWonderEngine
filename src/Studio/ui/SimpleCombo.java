package Studio.ui;

import javax.swing.BorderFactory;
import javax.swing.DefaultListCellRenderer;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JList;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Font;
import java.util.List;

/**
 * 下拉选择。用于"从固定几项里挑一个"，避免用户手敲字符串拼错。
 * 中文一律走 String 值，枚举请先转成中文再放进来（渲染层不做隐式翻译，避免出现两套名字）。
 */
public class SimpleCombo<T> extends JComboBox<T> {

    public SimpleCombo(T[] items) {
        super(new java.util.Vector<>(java.util.Arrays.asList(items)));
        init();
    }

    public SimpleCombo(List<T> items) {
        super(new java.util.Vector<>(items));
        init();
    }

    private void init() {
        setFont(Theme.F_BODY);
        setBorder(BorderFactory.createEmptyBorder(2, 4, 2, 2));
        setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        setMaximumRowCount(14);
        setRenderer(new DefaultListCellRenderer() {
            @Override
            public Component getListCellRendererComponent(JList<?> list, Object value, int index,
                                                          boolean selected, boolean focus) {
                JComponent c = (JComponent) super.getListCellRendererComponent(
                        list, value == null ? "（未选）" : value.toString(), index, selected, focus);
                c.setFont(Theme.F_BODY);
                c.setBorder(BorderFactory.createEmptyBorder(4, 8, 4, 8));
                if (index < 0) {
                    c.setBackground(Theme.SURFACE);
                    c.setOpaque(false);
                }
                return c;
            }
        });
    }

    @Override
    public Dimension getPreferredSize() {
        Dimension d = super.getPreferredSize();
        return new Dimension(Math.max(d.width, 84), Math.max(d.height, 30));
    }

    @Override
    public Dimension getMaximumSize() {
        return new Dimension(Integer.MAX_VALUE, getPreferredSize().height);
    }

    /** 用对象比较选中项（字符串内容相等即算选中），避免不同实例互不相等的老坑。 */
    public void select(T target) {
        if (target == null) {
            return;
        }
        for (int i = 0; i < getItemCount(); i++) {
            T it = getItemAt(i);
            if (it == target || (it != null && it.toString().equals(target.toString()))) {
                setSelectedIndex(i);
                return;
            }
        }
    }

    public String selectedText() {
        Object o = getSelectedItem();
        return o == null ? "" : o.toString();
    }

    public Font font() {
        return Theme.F_BODY;
    }
}
