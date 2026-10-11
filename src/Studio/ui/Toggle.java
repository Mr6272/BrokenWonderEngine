package Studio.ui;

import javax.swing.JComponent;
import javax.swing.Timer;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.function.Consumer;

/** 开关：布尔值统一用它，不用勾选框——一眼能看出"当前是开还是关"。 */
public class Toggle extends JComponent {

    private boolean on;
    private float anim;
    private Consumer<Boolean> onChange;
    private boolean hover;

    public Toggle(boolean init, Consumer<Boolean> onChange) {
        this.on = init;
        this.anim = init ? 1f : 0f;
        this.onChange = onChange;
        setPreferredSize(new Dimension(38, 22));
        setMinimumSize(new Dimension(38, 22));
        setMaximumSize(new Dimension(38, 22));
        setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        addMouseListener(new MouseAdapter() {
            @Override
            public void mouseEntered(MouseEvent e) {
                hover = true;
                repaint();
            }

            @Override
            public void mouseExited(MouseEvent e) {
                hover = false;
                repaint();
            }

            @Override
            public void mouseClicked(MouseEvent e) {
                setOn(!Toggle.this.on, true);
            }
        });
    }

    public boolean isOn() {
        return on;
    }

    public void setOn(boolean value, boolean fire) {
        if (on == value) {
            return;
        }
        on = value;
        animate();
        if (fire && onChange != null) {
            onChange.accept(on);
        }
    }

    private void animate() {
        Timer t = new Timer(14, null);
        t.addActionListener(e -> {
            float target = on ? 1f : 0f;
            anim += (target - anim) * 0.35f;
            if (Math.abs(target - anim) < 0.02f) {
                anim = target;
                ((Timer) e.getSource()).stop();
            }
            repaint();
        });
        t.start();
    }

    @Override
    protected void paintComponent(Graphics g) {
        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        int w = getWidth(), h = getHeight();
        int trackH = 20;
        int y = (h - trackH) / 2;
        int trackW = Math.min(w, 36);

        java.awt.Color track = Theme.mix(Theme.mix(Theme.LINE, Theme.SURFACE_SUNK, 0.6f), Theme.ACCENT, anim);
        g2.setColor(isEnabled() ? track : Theme.SURFACE_SUNK);
        g2.fillRoundRect(0, y, trackW, trackH, trackH, trackH);
        if (hover && isEnabled()) {
            g2.setColor(Theme.alpha(Theme.ACCENT, 40));
            g2.drawRoundRect(0, y, trackW - 1, trackH - 1, trackH, trackH);
        }
        int knob = trackH - 4;
        int kx = Math.round(2 + anim * (trackW - knob - 4));
        g2.setColor(new java.awt.Color(0, 0, 0, 28));
        g2.fillOval(kx, y + 3, knob, knob);
        g2.setColor(isEnabled() ? java.awt.Color.WHITE : new java.awt.Color(0xF0F2F6));
        g2.fillOval(kx, y + 2, knob, knob);
        g2.dispose();
    }
}
