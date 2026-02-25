package UserUsage.xia_demo;

import AbstractLayer.MainWindow;
import Core.GameRenderer;
import Core.GameSekai;
import Core.SceneManagement;
import Core.Vector2;
import Framework.*;
import Tool.Log;
import TypeStructure.Sprite;
import TypeStructure.SpriteWrapMode;
import TypeStructure.Tag;
import UI.UIButton;
import UI.UIManager;
import UI.UITweens;
import UI.UITween.Ease;

import com.jogamp.newt.event.KeyEvent;

public class Xia extends GameObject {

    public int faceDir;
    public TransformAbility transform;
    Sprite sprRun;
    Sprite sprIdle;
    Sprite sprThrow;
    public Renderer2DAbility renderer;
    BoxColliderAbility boxCollider;
    float ThrowTimer;
    boolean isThrowing = false;
    Kuwu kuwu;
    public SunAttack Sun;
    private boolean isRunning = false;

    public Xia()
    {
        super();
        tag = new Tag("player");
        faceDir = -1;
        renderer = new Renderer2DAbility();
        sprRun = new Sprite(SpriteWrapMode.Clamp, "Art/大侠", "大侠跑步", 15);
        sprIdle = new Sprite(SpriteWrapMode.Clamp, "Art/大侠", "大侠待机", 250);
        sprThrow = new Sprite(SpriteWrapMode.Clamp, "Art/大侠", "大侠投掷", 66);
        renderer.Frame = 60;
        renderer.order = -0.5f;
        renderer.SpriteObj = sprRun;
        renderer.OnAdded(this);
        super.Abilitys.add(renderer);
        transform = ((TransformAbility)Abilitys.get(0));
        transform.position = new Vector2(50, 100);
        transform.scale = new Vector2(40f, 40f);
        BoxColliderAbility BCA = new BoxColliderAbility();
        BCA.halfHeight = 40f / 4;
        BCA.halfWidth = 40f / 4;
        super.Abilitys.add(BCA);
        BCA.OnAdded( this);
        boxCollider = BCA;
        
        UIButton btn = new UIButton("Button", "start", 100, 100, 100, 100);
        btn.setOnClick(() -> {
            UITweens.moveTo(btn, 200, 200, 0.5f, Ease.EaseInOut,() -> {
                UITweens.moveTo(btn, 100, 100, 0.5f, Ease.EaseInOut, null);
            });
        });
        UIManager.getInstance().addElement(btn);
    }

    @Override
    public void Update() {
        super.Update();
        
        if (isThrowing)
        {
            ThrowTimer += 1f;
            if (ThrowTimer >= 95 / 2 && kuwu != null)
                kuwu.isEnabled = true;
            if (ThrowTimer >= 66*2)
            {
                if (kuwu != null)
                {
                    GameRenderer.RecycleTex(kuwu.renderer.SpriteObj.texture, kuwu);
                    kuwu = null;
                }
                ThrowTimer = 0;
                isThrowing = false;
                renderer.SpriteObj = sprIdle;
                renderer.ResetIndex();
            }
            return;
        }
        if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_F) && !isThrowing)
        {
            if (renderer.SpriteObj != sprThrow)
            {
                kuwu = new Kuwu(this, faceDir);
                isThrowing = true;
                kuwu.isEnabled = false;
                renderer.SpriteObj = sprThrow;
                renderer.ResetIndex();
            }
        }
        else if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_Q) && !isThrowing && renderer.SpriteObj == sprIdle)
        {
            if (Sun == null)
            {
                Sun = new SunAttack(this, faceDir);
            }
        }
        else if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_M))
        {
            Log.d(GameSekai.GameObjects.size() + " - game objects");
            Map map = new Map("Data/level_02.json");
            gameWindow.scene.genMap();
            SceneManagement.Reduce(map);
            Log.d(GameSekai.GameObjects.size() + " - game objects");
        }

        else if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_W))
        {
            isRunning = true;
            faceDir = 1;
            Move(0, 120f * 1 / GameRenderer.Frame, 180);
//            transform.position.y += 60f * 1 / GameRenderer.Frame;
//            transform.rotation = 180f;

            if (renderer.SpriteObj != sprRun)
            {
                renderer.SpriteObj = sprRun;
                renderer.ResetIndex();
            }
        }
        else if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_S))
        {
            isRunning = true;
            faceDir = -1;
            Move(0, 120f * -1 / GameRenderer.Frame, 0);

            if (renderer.SpriteObj != sprRun)
            {
                renderer.SpriteObj = sprRun;
                renderer.ResetIndex();
            }
        }
        else if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_D))
        {
            isRunning = true;
            faceDir = 2;
            Move(120f * 1 / GameRenderer.Frame, 0, 90f);

            if (renderer.SpriteObj != sprRun)
            {
                renderer.SpriteObj = sprRun;
                renderer.ResetIndex();
            }
        }
        else if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_A))
        {
            isRunning = true;
            faceDir = -2;
            Move(120f * -1 / GameRenderer.Frame, 0, -90);

            if (renderer.SpriteObj != sprRun)
            {
                renderer.SpriteObj = sprRun;
                renderer.ResetIndex();
            }
        }
        else if (renderer.SpriteObj != sprIdle)
        {
            isRunning = false;
            renderer.SpriteObj = sprIdle;
            renderer.ResetIndex();
        }
    }

    public void Move(float xspeed, float yspeed, float angle)
    {
        //boxCollider.collider2D.body.setTransform(new Vec2(transform.position.x + xspeed, transform.position.y + yspeed), angle);
        transform.position.y += yspeed;
        transform.position.x += xspeed;
        transform.rotation = angle;
    }
}
