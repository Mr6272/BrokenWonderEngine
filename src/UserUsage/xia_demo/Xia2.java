package UserUsage.xia_demo;

import AbstractLayer.MainWindow;
import Core.GameRenderer;
import Core.Vector2;
import Framework.*;
import TypeStructure.Sprite;
import TypeStructure.SpriteAtlas;
import TypeStructure.SpriteWrapMode;
import java.awt.event.KeyEvent;

public class Xia2 extends GameObject {

    public int faceDir;
    public TransformAbility transform;
    Sprite sprRun;
    Sprite sprIdle;
    Sprite sprThrow;
    Renderer2DAbility renderer;
    BoxColliderAbility boxCollider;
    float ThrowTimer;
    boolean isThrowing = false;
    Kuwu kuwu;

    public Xia2()
    {
        super();
        faceDir = -1;
        renderer = new Renderer2DAbility();
        sprRun = new Sprite(SpriteWrapMode.Clamp, new SpriteAtlas("Art/大侠/精灵图集/sprite4.png", 4, 83, 250, 250 + 14, 128));
        sprIdle = new Sprite(SpriteWrapMode.Clamp, new SpriteAtlas("Art/大侠/精灵图集/sprite4.png", 4, 83, 0, 249, 128));
        sprThrow = new Sprite(SpriteWrapMode.Clamp, new SpriteAtlas("Art/大侠/精灵图集/sprite4.png", 4, 83, 250 + 15, 331, 128));
        renderer.Frame = 60;
        renderer.order = -0.5f;
        renderer.SpriteObj = sprIdle;
        AddAbility(renderer);
        transform = ((TransformAbility)Abilitys.get(0));
        transform.position = new Vector2(50, 100);
        transform.scale = new Vector2(40f, 40f);
        BoxColliderAbility BCA = new BoxColliderAbility();
        BCA.halfHeight = 40f / 4;
        BCA.halfWidth = 40f / 4;
        AddAbility(BCA);
        boxCollider = BCA;
    }

    @Override
    public void Update() {
        super.Update();
        if (isThrowing)
        {
            ThrowTimer += GameRenderer.deltaTime; // 秒
            if (ThrowTimer >= 45f / 60f) // 原 45 帧 @60fps = 0.75s
                kuwu.isEnabled = true;
            if (ThrowTimer >= 132f / 60f) // 原 132 帧 @60fps = 2.2s
            {
                GameRenderer.RecycleTex(kuwu.renderer.SpriteObj.texture, kuwu);
                kuwu = null;
                renderer.ResetIndex();
                ThrowTimer = 0;
                isThrowing = false;
                renderer.SpriteObj = sprIdle;
            }
            return;
        }
        if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_F) && !isThrowing)
        {
            if (renderer.SpriteObj != sprThrow)
            {
                isThrowing = true;
                kuwu.isEnabled = false;
                renderer.ResetIndex();
                renderer.SpriteObj = sprThrow;
            }
        }
        else if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_W))
        {
            faceDir = 1;
            Move(0, 120f * GameRenderer.deltaTime, 180);
//            transform.position.y += 60f * 1 / GameRenderer.Frame;
//            transform.rotation = 180f;

            if (renderer.SpriteObj.Atlas != sprRun.Atlas)
            {
                renderer.ResetIndex();
                renderer.SpriteObj = sprRun;
            }
        }
        else if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_S))
        {
            faceDir = -1;
            Move(0, 120f * -GameRenderer.deltaTime, 0);

            if (renderer.SpriteObj.Atlas != sprRun.Atlas)
            {
                renderer.ResetIndex();
                renderer.SpriteObj = sprRun;
            }
        }
        else if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_D))
        {
            faceDir = 2;
            Move(120f * GameRenderer.deltaTime, 0, 90f);

            if (renderer.SpriteObj.Atlas != sprRun.Atlas)
            {
                renderer.ResetIndex();
                renderer.SpriteObj = sprRun;
            }
        }
        else if (MainWindow.keyManager.isKeyHeld(KeyEvent.VK_A))
        {
            faceDir = -2;
            Move(120f * -GameRenderer.deltaTime, 0, -90);

            if (renderer.SpriteObj.Atlas != sprRun.Atlas)
            {
                renderer.ResetIndex();
                renderer.SpriteObj = sprRun;
            }
        }
        else if (renderer.SpriteObj != null && renderer.SpriteObj.Atlas != sprIdle.Atlas)
        {
            renderer.ResetIndex();
            renderer.SpriteObj = sprIdle;
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
