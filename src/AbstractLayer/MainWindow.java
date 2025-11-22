package AbstractLayer;

import Core.GameRenderer;
import Tool.KeyManager;
import UI.UIMouse;
import com.jogamp.opengl.util.FPSAnimator;

import javax.media.opengl.GLCapabilities;
import javax.media.opengl.GLProfile;
import javax.media.opengl.awt.GLCanvas;
import javax.swing.*;
import java.awt.*;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;

public class MainWindow extends JFrame
{
    public static int wd = 1600;
    public static int ht = 900;
    public static MapGen scene;
    public static KeyManager keyManager = new KeyManager();
    static GameRenderer gameRenderer;

    public static void main(String[] args) {
        gameRenderer = new GameRenderer();
        // 2. 配置 OpenGL
        GLProfile profile = GLProfile.get(GLProfile.GL2);
        GLCapabilities capabilities = new GLCapabilities(profile);

        // 3. 创建 GLCanvas，相当于 Testbed 里的 JoglPanel
        GLCanvas glcanvas = new GLCanvas(capabilities);
        glcanvas.setPreferredSize(new Dimension(wd, ht));
        glcanvas.setFocusable(true);      // 让它能拿键盘焦点
        glcanvas.requestFocusInWindow();  // 尝试获取焦点

        // 4. �?GLEventListener（你�?GameRenderer�?
        glcanvas.addGLEventListener(gameRenderer);

        // 5. 键盘监听挂在 glcanvas �?
        glcanvas.addKeyListener(new KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                keyManager.keyPressed(e.getKeyCode());
            }

            @Override
            public void keyReleased(KeyEvent e) {
                keyManager.keyReleased(e.getKeyCode());
            }
        });
        glcanvas.addMouseListener(UIMouse.get());
        glcanvas.addMouseMotionListener(UIMouse.get());
        glcanvas.addMouseWheelListener(UIMouse.get());
        
        // 6. JFrame 布局，参�?jbox2d Testbed 的写�?
        JFrame frame = new JFrame("BWE");
        frame.setDefaultCloseOperation(WindowConstants.EXIT_ON_CLOSE);
        frame.setLayout(new BorderLayout());
        frame.add(glcanvas, BorderLayout.CENTER);
        frame.pack();                       // �?glcanvas �?preferredSize
        frame.setLocationRelativeTo(null);  // 居中显示
        frame.setVisible(true);
        frame.setResizable(false);
        // 再抢一次焦点，确保键盘事件稳定
        glcanvas.requestFocusInWindow();

        // 7. 启动 FPSAnimator（驱�?GameRenderer.display�?
        FPSAnimator animator = new FPSAnimator(glcanvas, (int) GameRenderer.Frame, true);
        animator.start();

        //**//
        scene.genMap();
    }
}
