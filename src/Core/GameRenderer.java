package Core;

import Framework.GameObject;
import Tool.TextureCache;
import UI.UIManager;
import AbstractLayer.MainWindow;

import javax.media.opengl.GL;
import javax.media.opengl.GL2;
import javax.media.opengl.GLAutoDrawable;
import javax.media.opengl.GLEventListener;

public class GameRenderer implements GLEventListener {
    private static GL2 glu;
    public static GameSekai sekai;
    /** FPSAnimator 目标帧率 */
    public static float Frame = 60;
    /** 上一帧真实耗时（秒），供逻辑 / UI / 协程 / 动画使用；已钳制防止卡顿后跳变 */
    public static float deltaTime = 1f / 60f;
    /** 世界视图尺寸（reshape 中按窗口计算），相机偏移与可见性剔除与 glOrtho 保持一致 */
    public static float viewWorldW = 480f;
    public static float viewWorldH = 270f;
    public static GameObject Camera;

    private long lastFrameNanos = System.nanoTime();

    public GameRenderer()
    {
        sekai = new GameSekai();
    }

    @Override
    public void init(GLAutoDrawable glAutoDrawable) {
        final GL2 gl = glAutoDrawable.getGL().getGL2();
        gl.glShadeModel(GL2.GL_SMOOTH);
        // 设置背景颜色为深灰色（降低亮度，避免灰蒙蒙的效果）
        gl.glClearColor(0.2f, 0.2f, 0.2f, 1.0f);
        gl.glClearDepth(1.0f);
        gl.glHint(GL2.GL_PERSPECTIVE_CORRECTION_HINT, GL2.GL_NICEST);
        gl.glEnable(GL2.GL_TEXTURE_2D);
    }

    @Override
    public void dispose(GLAutoDrawable glAutoDrawable) {
    }

    @Override
    public void display(GLAutoDrawable glAutoDrawable) {
        // 测量真实帧耗时，钳制到 [0.0001, 0.1] 秒，防止卡顿/恢复瞬间逻辑跳变
        long now = System.nanoTime();
        float rawDt = (now - lastFrameNanos) / 1_000_000_000f;
        lastFrameNanos = now;
        deltaTime = Math.max(0.0001f, Math.min(rawDt, 0.1f));

        GL2 gl = glAutoDrawable.getGL().getGL2();
        glu = gl;
        UIManager uiManager = UIManager.getInstance();
        uiManager.beginFrame(glAutoDrawable);
        gl.glEnable(GL2.GL_BLEND);
        gl.glBlendFunc(GL2.GL_SRC_ALPHA, GL2.GL_ONE_MINUS_SRC_ALPHA);
        gl.glEnable(GL2.GL_ALPHA_TEST);
        gl.glAlphaFunc(GL.GL_GREATER, 0.3f);
        gl.glLoadIdentity();
        gl.glClear(GL2.GL_COLOR_BUFFER_BIT | GL2.GL_DEPTH_BUFFER_BIT);
        gl.glLoadIdentity(); // Reset The View
        gl.glMatrixMode(GL2.GL_MODELVIEW);
        gl.glLoadIdentity();
        if (Camera != null)
            gl.glTranslatef(-Camera.transform.position.x + viewWorldW * 0.5f,
                    -Camera.transform.position.y + viewWorldH * 0.5f, -5f);

        if(!GameSekai.GameObjects.isEmpty()){
            sekai.Update();
            sekai.Draw(glAutoDrawable);
        }
        uiManager.update();
        uiManager.render(glAutoDrawable);
        uiManager.endFrame();
        // Snapshot key states at end of frame so next frame can detect edges
        MainWindow.keyManager.beginFrame();
    }

    @Override
    public void reshape(GLAutoDrawable glAutoDrawable, int i, int i1, int width, int height) {
        GL2 gl = glAutoDrawable.getGL().getGL2();
        float h = (float) width / (float) height;
        gl.glViewport(0, 0, width, height);
        gl.glMatrixMode(GL2.GL_PROJECTION);
        gl.glLoadIdentity();
        gl.glOrtho(0, width * 0.3f, 0, height * 0.3f, -100.0, 100.0);
        gl.glMatrixMode(GL2.GL_MODELVIEW);
        gl.glLoadIdentity();
        viewWorldW = width * 0.3f;
        viewWorldH = height * 0.3f;
    }

    /** 释放一张纹理（引用计数归零才真正删除显存）。 */
    public static void DeleteTexture(int tex) {
        TextureCache.release(glu, tex);
    }

    // 释放（显存）并移除对象
    public static void RecycleTex(int[] tex, GameObject gameObject) {
        if (tex != null) {
            for (int t : tex) {
                TextureCache.release(glu, t);
            }
        }
        GameSekai.GameObjects.remove(gameObject);
    }

    // 释放（显存）并移除对象
    public static void RecycleTex(int tex, GameObject gameObject) {
        TextureCache.release(glu, tex);
        GameSekai.GameObjects.remove(gameObject);
        gameObject.isEnabled = false;
    }

    public static boolean isVisible(GameObject obj) {
        if (Camera == null)
            return true;
        float halfW = obj.transform.scale.x  * 0.5f;
        float halfH = obj.transform.scale.y * 0.5f;

        float left   = obj.transform.position.x - halfW;
        float right  = obj.transform.position.x + halfW;
        float bottom = obj.transform.position.y - halfH;
        float top    = obj.transform.position.y + halfH;

        // 剔除视锥与 glOrtho 保持一致
        float camLeft   = Camera.transform.position.x - viewWorldW * 0.5f;
        float camRight  = Camera.transform.position.x + viewWorldW * 0.5f;
        float camBottom = Camera.transform.position.y - viewWorldH * 0.5f;
        float camTop    = Camera.transform.position.y + viewWorldH * 0.5f;

        // 轴对齐 AABB 相交判断
        return !(right  < camLeft  ||
                left   > camRight ||
                top    < camBottom||
                bottom > camTop);
    }

}
