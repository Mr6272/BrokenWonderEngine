package Tool;

import java.util.HashMap;
import java.util.Map;

public class KeyManager {

    // 当前帧按键状态
    private final Map<Integer, Boolean> currentKeyStates;
    // 上一帧按键状态
    private final Map<Integer, Boolean> previousKeyStates;

    public KeyManager() {
        currentKeyStates = new HashMap<>();
        previousKeyStates = new HashMap<>();
    }

    /**
     * 每帧开始调用：把当前状态复制给上一帧，便于本帧做边沿检测。
     * 兼容旧名 update。
     */
    public void update() {
        beginFrame();
    }

    public void beginFrame() {
        previousKeyStates.clear();
        previousKeyStates.putAll(currentKeyStates);
    }

    /**
     * KeyListener.keyPressed 里调用。
     */
    public void keyPressed(int keyCode) {
        currentKeyStates.put(keyCode, true);
    }

    /**
     * KeyListener.keyReleased 里调用。
     */
    public void keyReleased(int keyCode) {
        currentKeyStates.put(keyCode, false);
    }

    /**
     * 这一帧是否按着（持续）
     */
    public boolean isKeyHeld(int keyCode) {
        return currentKeyStates.getOrDefault(keyCode, false);
    }

    /**
     * 这一帧“刚按下”的瞬间（上一帧没按，这一帧按了）
     */
    public boolean isKeyDown(int keyCode) {
        boolean cur = currentKeyStates.getOrDefault(keyCode, false);
        boolean pre = previousKeyStates.getOrDefault(keyCode, false);
        return cur && !pre;
    }

    /**
     * 这一帧“刚松开”的瞬间（上一帧按着，这一帧没按）
     */
    public boolean isKeyUp(int keyCode) {
        boolean cur = currentKeyStates.getOrDefault(keyCode, false);
        boolean pre = previousKeyStates.getOrDefault(keyCode, false);
        return !cur && pre;
    }
}
