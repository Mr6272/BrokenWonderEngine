package UserUsage.xia_demo;

import Framework.GameObject;
import Framework.Renderer2DAbility;
import Framework.TransformAbility;
import TypeStructure.Sprite;
import TypeStructure.SpriteWrapMode;

public class room1outside extends GameObject {

    public float Speed;
    public TransformAbility transform;
    Sprite sprRun;
    Renderer2DAbility renderer;


    public room1outside()
    {
        super();
        renderer = new Renderer2DAbility();
        sprRun = new Sprite(SpriteWrapMode.Clamp, "Art/Building", "房子类型1外墙");
        renderer.Frame = 60;
        renderer.SpriteObj = sprRun;
        renderer.OnAdded(this);
        super.Abilitys.add(renderer);
        transform = ((TransformAbility)Abilitys.get(0));
    }
}
