package UserUsage.xia_demo;

import Core.GameRenderer;
import Core.Vector2;
import Framework.BoxColliderAbility;
import Framework.GameObject;
import Framework.Renderer2DAbility;
import Framework.TransformAbility;
import TypeStructure.Sprite;
import TypeStructure.SpriteWrapMode;

public class SunAttack extends GameObject {

    public float Speed;
    public TransformAbility transform;
    Sprite sprRun;
    Renderer2DAbility renderer;
    Xia Owner;
    float timer;

    public SunAttack(Xia Owner, int Dir) {
        super();
        this.Owner = Owner;
        renderer = new Renderer2DAbility();
        sprRun = new Sprite(SpriteWrapMode.Clamp, "Art/日冕", "日冕", 61);
        renderer.Frame = 60;
        renderer.SpriteObj = sprRun;
        renderer.order = 0.5f;
        AddAbility(renderer);
        transform = ((TransformAbility) Abilitys.get(0));
        transform.scale = new Vector2(100f, 100f);
        BoxColliderAbility BCA = new BoxColliderAbility();
        BCA.halfWidth = 100f / 4;
        BCA.halfHeight = 100f / 4;
        BCA.isTrigger = true;
        AddAbility(BCA);

        if (Dir == 2) {
            transform.position = new Vector2(Owner.transform.position.x + 35, Owner.transform.position.y);
        } else if (Dir == -2) {
            transform.position = new Vector2(Owner.transform.position.x - 35, Owner.transform.position.y);
        } else if (Dir == 1) {
            transform.position = new Vector2(Owner.transform.position.x, Owner.transform.position.y + 35);
        } else if (Dir == -1) {
            transform.position = new Vector2(Owner.transform.position.x, Owner.transform.position.y - 35);
        }
    }

    @Override
    public void OnCollision(GameObject other) {
        super.OnCollision(other);
        if (other.tag.TagName.equals("player")) {
            return;
        }
        // Owner.Sun = null;
        // for (int i = 0; i < Abilitys.size(); i++) {
        //     if (Abilitys.get(i) instanceof BoxColliderAbility) {
        //         Abilitys.get(i).OnRemove();
        //         break;
        //     }
        // }
        // GameRenderer.RecycleTex(renderer.SpriteObj.texture, this);
    }

    @Override
    public void Update() {
        super.Update();
        if (!isEnabled) {
            return;
        }
        timer += GameRenderer.deltaTime; // 秒
        if (timer >= 1.8f) {
            Owner.Sun = null;
            for (int i = 0; i < Abilitys.size(); i++) {
                if (Abilitys.get(i) instanceof BoxColliderAbility) {
                    Abilitys.get(i).OnRemove();
                    break;
                }
            }
            GameRenderer.RecycleTex(renderer.SpriteObj.texture, this);
        }
    }
}
