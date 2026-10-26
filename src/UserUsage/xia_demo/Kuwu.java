package UserUsage.xia_demo;

import Core.GameRenderer;
import Core.Vector2;
import Framework.*;
import TypeStructure.Sprite;
import TypeStructure.SpriteWrapMode;

public class Kuwu extends GameObject {

    public float Speed;
    public TransformAbility transform;
    Sprite sprRun;
    Renderer2DAbility renderer;
    public float Dir;
    Xia Owner;
    boolean isdest;


    public Kuwu(Xia Owner, float Dir)
    {
        super();
        this.Owner = Owner;
        this.Dir = Dir;
        renderer = new Renderer2DAbility();
        sprRun = new Sprite(SpriteWrapMode.Clamp, "Art/Weapon", "苦无");
        renderer.Frame = 60;
        renderer.SpriteObj = sprRun;
        renderer.order = 0f;
        AddAbility(renderer);
        transform = ((TransformAbility)Abilitys.get(0));

        if (Dir == 2)
        {
            transform.position = new Vector2(Owner.transform.position.x + 12f, Owner.transform.position.y);
        }
        else if (Dir == -2)
        {
            transform.position = new Vector2(Owner.transform.position.x - 12f, Owner.transform.position.y);
        }
        else if (Dir == 1)
        {
            transform.position = new Vector2(Owner.transform.position.x, Owner.transform.position.y + 12);
        }
        else if (Dir == -1)
        {
            transform.position = new Vector2(Owner.transform.position.x, Owner.transform.position.y - 12);
        }
        transform.scale = new Vector2(20f, 20f);
        BoxColliderAbility BCA = new BoxColliderAbility();
        BCA.halfWidth = 20f / 4;
        BCA.halfHeight = 20f / 4;
        AddAbility(BCA);
    }

    @Override
    public void OnCollision(GameObject other) {
        super.OnCollision(other);
        if (other.tag.TagName.equals("player") || isdest) return;
        isdest = true;
        Owner.kuwu = null;
        for (int i = 0; i < Abilitys.size(); i++)
        {
            if (Abilitys.get(i) instanceof BoxColliderAbility)
            {
                Abilitys.get(i).OnRemove();
                break;
            }
        }
        GameRenderer.RecycleTex(renderer.SpriteObj.texture, this);
    }

    @Override
    public void Update() {
        super.Update();
        if(!isEnabled)
            return;
        if (Dir == 2)
        {
            Move(300f * GameRenderer.deltaTime, 0, -90);
        }
        else if (Dir == -2)
        {
            Move(300f * -GameRenderer.deltaTime, 0, 90);
        }
        else if (Dir == 1)
        {
            Move(0, 300f * GameRenderer.deltaTime, 0);
        }
        else if (Dir == -1)
        {
            Move(0, 300f * -GameRenderer.deltaTime, -180);
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
