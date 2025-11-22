package UserUsage.xia_demo;

import AbstractLayer.MainWindow;
import Core.Vector2;
import Framework.BoxColliderAbility;
import Framework.GameObject;
import Framework.Renderer2DAbility;
import Framework.TransformAbility;
import Tool.KeyManager;
import TypeStructure.Sprite;
import TypeStructure.SpriteWrapMode;

public class Floor extends GameObject {
    public TransformAbility transform;
    Sprite sprRun;
    Renderer2DAbility renderer;

    public Floor()
    {
        super();
        renderer = new Renderer2DAbility();
        sprRun = new Sprite(SpriteWrapMode.Clamp, "Art/Ground", "ground");
        renderer.Frame = 60;
        renderer.SpriteObj = sprRun;
        renderer.OnAdded(this);
        renderer.order = -0.9f;
        super.Abilitys.add(renderer);
        transform = ((TransformAbility)Abilitys.get(0));
        transform.position = new Vector2(500f, 500f);
        transform.scale = new Vector2(60f, 60f);
    }
}
