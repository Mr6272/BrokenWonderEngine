package Framework;

import Core.CollisionSystem;
import Core.GameSekai;
import Core.Physics.Collider.BoxCollider2D;
import org.jbox2d.common.Vec2;
import org.jbox2d.dynamics.Body;
import org.jbox2d.dynamics.BodyType;
import org.jbox2d.dynamics.contacts.ContactEdge;

public class BoxColliderAbility implements IAbility, ICollider {

    public boolean isFrozen;
    private GameObject gameObject;
    private TransformAbility transform;

    public float offsetX = 0;
    public float offsetY = 0;
    public float halfWidth = 0.5f;
    public float halfHeight = 0.5f;

    // 刚体类型/密度，方便从外部配置
    public BodyType bodyType = BodyType.DYNAMIC;
    public float density = 1.0f;
    public boolean isTrigger = false;

    // 关联 jbox2d 封装
    public BoxCollider2D collider2D = new BoxCollider2D();

    private boolean isActive = true;

    /** 缺陷 e：OnRemove 幂等标记——保证物理体只销毁一次、只注销一次。 */
    private boolean released = false;

    @Override
    public void OnAdded(GameObject go) {
        this.gameObject = go;

        for (IAbility ability : go.Abilitys) {
            if (ability instanceof TransformAbility) {
                transform = (TransformAbility) ability;
                break;
            }
        }

        if (transform == null) {
            // 不再"print 后 return"把半初始化能力留在列表里（审计 §2.1 第 3 行）：
            // 抛出让 GameObject.TryAddAbility 回滚，能力不会残留在 Abilitys 中。
            throw new IllegalStateException("BoxColliderAbility: 找不到 TransformAbility，拒绝半初始化");
        }

        float startX = transform.position.x + offsetX;
        float startY = transform.position.y + offsetY;

        collider2D.create(
                startX,
                startY,
                halfWidth,
                halfHeight,
                bodyType,
                density,
                isTrigger,
                this
        );

        // 注册到自己的碰撞系统
        CollisionSystem.get().register(this);
        if (collider2D.body != null) {
            collider2D.body.setActive(true);
        }
    }

    @Override
    public void OnInit() {}

    @Override
    public void SetEnable(boolean value) {
        isActive = value;
    }

    @Override
    public boolean GetEnable() {
        return isActive;
    }

    // 逻辑阶段：Transform -> Body
    public void syncTransformToBody() {
        if (collider2D.body == null || transform == null) return;

        float tx = transform.position.x + offsetX;
        float ty = transform.position.y + offsetY;
        float angleRad = (float) Math.toRadians(transform.rotation);

        collider2D.body.setTransform(new Vec2(tx, ty), angleRad);
    }

    public void syncBodyToTransform() {
        if (collider2D.body == null || transform == null || isFrozen) return;

        Vec2 pos = collider2D.body.getPosition();
        float angle = collider2D.body.getAngle();

        transform.position.x = pos.x - offsetX;
        transform.position.y = pos.y - offsetY;
        transform.rotation = (float) Math.toDegrees(angle);
    }

    @Override
    public void OnUpdate() {
    }

    @Override
    public void OnRemove() {
        // 缺陷 e：OnRemove 幂等。重复移除 / 重复销毁不得重复注销、不得二次 destroyBody
        if (released) {
            return;
        }
        released = true;

        CollisionSystem.get().unregister(this);

        if (collider2D.body != null) {
            GameSekai.colliderWorld.world.destroyBody(collider2D.body);
            collider2D.body = null;
        }
        collider2D.fixture = null;
    }

    /** 缺陷 b：统一宿主访问入口。 */
    @Override
    public GameObject getHost() {
        return gameObject;
    }

    @Override
    public boolean overlaps(ICollider other) {
        if (!(other instanceof BoxColliderAbility)) return false;
        BoxColliderAbility box = (BoxColliderAbility) other;
        if (!isActive || !box.isActive) return false;
        if (collider2D.body == null || box.collider2D.body == null) return false;

        Body a = collider2D.body;
        Body b = box.collider2D.body;

        for (ContactEdge ce = a.getContactList(); ce != null; ce = ce.next) {
            if (ce.other == b && ce.contact.isTouching()) {
                return true;
            }
        }
        return false;
    }

    public GameObject getGameObject() {
        return gameObject;
    }

    public void setTrigger(boolean trigger) {
        isTrigger = trigger;
        if (collider2D != null && collider2D.fixture != null) {
            collider2D.fixture.setSensor(trigger);
        }
    }
}
