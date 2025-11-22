package Core;

import Framework.GameObject;
import UI.UIManager;

import javax.media.opengl.GL;
import javax.media.opengl.GL2;
import javax.media.opengl.GLAutoDrawable;
import javax.media.opengl.GLEventListener;

public class GameRenderer implements GLEventListener {
    private static GL2 glu;
    public static GameSekai sekai;
    public static float Frame = 60;
    private float DeltaTimer;
    public static GameObject Camera;
    
    public GameRenderer()
    {
        sekai = new GameSekai();
    }
    @Override
    public void init(GLAutoDrawable glAutoDrawable) {
        //TODO 列表正序循环的时候，删除列表内元素会报严重BUG，尽可能倒序。
        final GL2 gl = glAutoDrawable.getGL().getGL2();
        gl.glShadeModel(GL2.GL_SMOOTH);
        // 设置背景颜色为深灰色（降低亮度，避免灰蒙蒙的效果）
        gl.glClearColor(0.7f, 0.7f, 0.7f, 1.0f);
        gl.glClearDepth(1.0f);
        gl.glHint(GL2.GL_PERSPECTIVE_CORRECTION_HINT, GL2.GL_NICEST);
        gl.glEnable(GL2.GL_TEXTURE_2D);
    }

    @Override
    public void dispose(GLAutoDrawable glAutoDrawable) {
    }

    @Override
    public void display(GLAutoDrawable glAutoDrawable) {
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
            gl.glTranslatef(-Camera.transform.position.x + 234f, -Camera.transform.position.y + 140f, -5f);

        if(!GameSekai.GameObjects.isEmpty()){
            sekai.Update();
            sekai.Draw(glAutoDrawable);
        }
        uiManager.update();
        uiManager.render(glAutoDrawable);
        uiManager.endFrame();
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
    }

    // 释放（显存）
    public static void RecycleTex(int[] tex, GameObject gameObject) {
        glu.glDeleteTextures(1, tex, 0);
        GameSekai.GameObjects.remove(gameObject);
    }

    // 释放（显存）
    public static void RecycleTex(int tex, GameObject gameObject) {
        glu.glDeleteTextures(1, new int[] {tex}, 0);
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

        float camLeft   = Camera.transform.position.x - 700 * 0.5f;
        float camRight  = Camera.transform.position.x + 700 * 0.5f;
        float camBottom = Camera.transform.position.y - 400 * 0.5f;
        float camTop    = Camera.transform.position.y + 400 * 0.5f;

        // 轴对齐 AABB 相交判断
        return !(right  < camLeft  ||
                left   > camRight ||
                top    < camBottom||
                bottom > camTop);
    }

}
