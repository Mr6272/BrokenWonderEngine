package UI;

import java.awt.event.MouseEvent;
import java.awt.event.MouseListener;
import java.awt.event.MouseMotionListener;
import java.awt.event.MouseWheelEvent;
import java.awt.event.MouseWheelListener;

/**
 * Centralised mouse tracker for screen-space UI.
 * Stores raw component coordinates and exposes per-frame transitions.
 */
public class UIMouse implements MouseListener, MouseMotionListener, MouseWheelListener {
    private static final UIMouse INSTANCE = new UIMouse();

    private int viewportWidth = 1;
    private int viewportHeight = 1;

    private int rawX;
    private int rawY;
    private boolean leftDown;
    private boolean previousLeftDown;
    private int accumulatedWheel;
    private int frameWheel;

    private UIMouse() {
    }

    public static UIMouse get() {
        return INSTANCE;
    }

    public void setViewport(int width, int height) {
        viewportWidth = Math.max(1, width);
        viewportHeight = Math.max(1, height);
    }

    /**
     * Snapshot wheel delta for this frame without touching button state.
     * Call once at the start of a frame.
     */
    public void beginFrame() {
        frameWheel = accumulatedWheel;
        accumulatedWheel = 0;
    }

    /**
     * Commit the frame so the next frame can detect edges correctly.
     */
    public void endFrame() {
        previousLeftDown = leftDown;
        frameWheel = 0;
    }

    private void updatePosition(MouseEvent e) {
        rawX = e.getX();
        rawY = e.getY();
    }

    public float getX() {
        return rawX;
    }

    /**
     * Converts the component's top-left origin to a bottom-left origin for UI rendering.
     */
    public float getY() {
        return viewportHeight - rawY;
    }

    public boolean isLeftDown() {
        return leftDown;
    }

    public boolean isLeftPressed() {
        return leftDown && !previousLeftDown;
    }

    public boolean isLeftReleased() {
        return !leftDown && previousLeftDown;
    }

    public int getScrollDelta() {
        return frameWheel;
    }

    @Override
    public void mouseClicked(MouseEvent e) {
        updatePosition(e);
    }

    @Override
    public void mousePressed(MouseEvent e) {
        updatePosition(e);
        if (e.getButton() == MouseEvent.BUTTON1) {
            leftDown = true;
        }
    }

    @Override
    public void mouseReleased(MouseEvent e) {
        updatePosition(e);
        if (e.getButton() == MouseEvent.BUTTON1) {
            leftDown = false;
        }
    }

    @Override
    public void mouseEntered(MouseEvent e) {
        updatePosition(e);
    }

    @Override
    public void mouseExited(MouseEvent e) {
        updatePosition(e);
    }

    @Override
    public void mouseDragged(MouseEvent e) {
        updatePosition(e);
    }

    @Override
    public void mouseMoved(MouseEvent e) {
        updatePosition(e);
    }

    @Override
    public void mouseWheelMoved(MouseWheelEvent e) {
        accumulatedWheel += e.getWheelRotation();
    }
}
