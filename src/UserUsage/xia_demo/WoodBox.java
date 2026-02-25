package UserUsage.xia_demo;

import Core.*;
import Framework.BoxColliderAbility;
import Framework.GameObject;
import Framework.Renderer2DAbility;
import Framework.TransformAbility;
import TypeStructure.Sprite;
import TypeStructure.SpriteWrapMode;

public class WoodBox extends GameObject {
    public float Speed;
    public TransformAbility transform;
    Sprite sprRun;
    public Renderer2DAbility renderer;
    boolean isMoving;


    public WoodBox()
    {
        super();
        renderer = new Renderer2DAbility();
        sprRun = new Sprite(SpriteWrapMode.Clamp, "Art/Box", "木头箱子");
        renderer.Frame = 60;
        renderer.SpriteObj = sprRun;
        renderer.OnAdded(this);
        renderer.order = 0.5f;
        super.Abilitys.add(renderer);
        transform = ((TransformAbility)Abilitys.get(0));
        transform.position = new Vector2(100f, 200f);
        transform.scale = new Vector2(60f, 60f);
        BoxColliderAbility BCA = new BoxColliderAbility();
        BCA.halfWidth = 60f / 4 - 3;
        BCA.halfHeight = 60f / 4 - 3;
        BCA.OnAdded(this);
        super.Abilitys.add(BCA);
    }
}
