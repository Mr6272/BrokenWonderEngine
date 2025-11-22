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

    // 相对 GameObject 中心的偏移和半宽/半高（用来创�?Box2D 形状�?
    public float offsetX = 0;
    public float offsetY = 0;
    public float halfWidth = 0.5f;
    public float halfHeight = 0.5f;

    // 刚体类型/密度，方便从外部配置
    public BodyType bodyType = BodyType.DYNAMIC;
    public float density = 1.0f;
    public boolean isTrigger = false;

    // 关联�?jbox2d 封装
    public BoxCollider2D collider2D = new BoxCollider2D();

    private int abilityIndex = 0;
    private boolean isActive = true;

    @Override
    public void SetIndex(int index) {
        abilityIndex = index;
    }

    @Override
    public int GetIndex() {
        return abilityIndex;
    }

    @Override
    public void OnAdded(GameObject go) {
        this.gameObject = go;

        // �?TransformAbility
        for (IAbility ability : go.Abilitys) {
            if (ability instanceof TransformAbility) {
                transform = (TransformAbility) ability;
                break;
            }
        }

        if (transform == null) {
            System.err.println("BoxColliderAbility: 找不�?TransformAbility");
            return;
        }

        // 用当�?Transform 的位置创建一�?Box2D body
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
                this // userData������� ability �Լ������� gameObject ����
        );

        // 注册到自己的碰撞系统（如果你还需要自己的 CollisionSystem�?
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

    // �?逻辑阶段：Transform -> Body
    public void syncTransformToBody() {
        if (collider2D.body == null || transform == null) return;

        float tx = transform.position.x + offsetX;
        float ty = transform.position.y + offsetY;
        float angleRad = (float) Math.toRadians(transform.rotation);

        collider2D.body.setTransform(new Vec2(tx, ty), angleRad);
    }

    // �?物理解算后：Body -> Transform
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
        // 不在这里同步了，�?GameSekai 控制调用时机
    }

    @Override
    public void OnRemove() {
        CollisionSystem.get().unregister(this);

        if (collider2D.body != null) {
            GameSekai.colliderWorld.world.destroyBody(collider2D.body);
            collider2D.body = null;
        }
    }

    // ============ ICollider：用 Box2D 的接触信息替代手�?AABB ============

    @Override
    public boolean overlaps(ICollider other) {
        if (!(other instanceof BoxColliderAbility)) return false;
        BoxColliderAbility box = (BoxColliderAbility) other;
        if (!isActive || !box.isActive) return false;
        if (collider2D.body == null || box.collider2D.body == null) return false;

        Body a = collider2D.body;
        Body b = box.collider2D.body;

        // �?Box2D �?contactEdge 来判断是否接�?
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


