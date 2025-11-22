package Core.Physics.Collider;

import Core.GameSekai;

import org.jbox2d.collision.shapes.PolygonShape;
import org.jbox2d.dynamics.Body;
import org.jbox2d.dynamics.BodyDef;
import org.jbox2d.dynamics.BodyType;
import org.jbox2d.dynamics.FixtureDef;

public class BoxCollider2D {
    public Body body;

    /**
     * 创建矩形 Body
     * @param x 中心 x 坐标
     * @param y 中心 y 坐标
     * @param halfWidth 半宽
     * @param halfHeight 半高
     * @param type Body 类型：静态、动态、kinematic
     * @param density 密度（动态刚体时有用）
     * @param userData 可以塞 GameObject 或 BoxColliderAbility 自己，方便之后识别
     */
    public void create(float x, float y, float halfWidth, float halfHeight,
                       BodyType type, float density, boolean isSensor, Object userData) {

        BodyDef bd = new BodyDef();
        bd.type = type;
        bd.position.set(x, y);

        body = GameSekai.colliderWorld.world.createBody(bd);

        PolygonShape box = new PolygonShape();
        box.setAsBox(halfWidth, halfHeight); // 半宽半高

        FixtureDef fd = new FixtureDef();
        fd.shape = box;
        fd.density = density;
        fd.friction = 0.3f;
        fd.restitution = 0.0f;

        fd.isSensor = isSensor;
        fixture = body.createFixture(fd);

        // 用来反查：从 body 回到你的 Ability 或 GameObject
        body.setUserData(userData);
    }

    public org.jbox2d.dynamics.Fixture fixture;
}
