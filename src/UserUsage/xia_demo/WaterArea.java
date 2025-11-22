package UserUsage.xia_demo;

import org.jbox2d.collision.shapes.PolygonShape;
import org.jbox2d.common.Vec2;
import org.jbox2d.dynamics.*;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * 顶视海水区域（JBox2D 2.1.2）
 * - 用一个 sensor 矩形表示水域
 * - 通过 ContactListener 维护“在水里”的刚体列表
 * - 每帧 update 时对刚体施加水阻 / 水流力
 */
public class WaterArea {

    private final World world;

    // 水域矩形（世界坐标，Box2D 单位）
    public final float left;
    public final float right;
    public final float bottom;
    public final float top;

    // 水流相关参数
    public Vec2 flowVelocity = new Vec2(0.0f, 0.0f); // 水流方向和速度
    public float linearDragK = 3.0f;   // 线性阻力系数
    public float angularDragK = 2.0f;  // 角阻力系数
    public float flowForceK = 5.0f;    // 水流推力系数

    private Body waterBody;
    private Fixture waterFixture;

    // 当前在水中的刚体
    private final Set<Body> bodiesInWater = new HashSet<Body>();

    public WaterArea(World world,
                     float left, float right,
                     float bottom, float top) {
        this.world = world;
        this.left = left;
        this.right = right;
        this.bottom = bottom;
        this.top = top;

        createSensorBody();
    }

    private void createSensorBody() {
        BodyDef bd = new BodyDef();
        bd.type = BodyType.STATIC;
        bd.position.set(0, 0); // 用局部坐标直接摆，所以这里可以是 (0,0)
        waterBody = world.createBody(bd);

        float cx = (left + right) * 0.25f;
        float cy = (bottom + top) * 0.25f;
        float hx = (right - left) * 0.25f;
        float hy = (top - bottom) * 0.25f;

        PolygonShape shape = new PolygonShape();
        shape.setAsBox(hx, hy, new Vec2(cx, cy), 0);

        FixtureDef fd = new FixtureDef();
        fd.shape = shape;
        fd.density = 0;
        fd.isSensor = true;  // ★ 关键：不产生碰撞，只做检测

        waterFixture = waterBody.createFixture(fd);
        // 可以用用户数据标记一下，这样 ContactListener 好判断
        waterFixture.setUserData(this);
    }

    public Fixture getWaterFixture() {
        return waterFixture;
    }

    public boolean isWaterFixture(Fixture f) {
        return f == waterFixture;
    }

    // 记录刚体原本的 damping，离开水时恢复
    private final Map<Body, Float> oldLinearDamping = new HashMap<>();
    private final Map<Body, Float> oldAngularDamping = new HashMap<>();

    // 水里的 damping
    public float inWaterLinearDamping = 5.0f;
    public float inWaterAngularDamping = 3.0f;

    public void onBodyEnter(Body body) {
        if (body.getType() != BodyType.DYNAMIC) return;

        if (bodiesInWater.add(body)) {
            // 第一次进水，记住原始阻尼
            oldLinearDamping.put(body, body.getLinearDamping());
            oldAngularDamping.put(body, body.getAngularDamping());

            body.setLinearDamping(inWaterLinearDamping);
            body.setAngularDamping(inWaterAngularDamping);

            System.out.println("Enter water: " + body);
        }
    }

    public void onBodyLeave(Body body) {
        if (bodiesInWater.remove(body)) {
            Float lin = oldLinearDamping.remove(body);
            Float ang = oldAngularDamping.remove(body);

            if (lin != null) body.setLinearDamping(lin);
            if (ang != null) body.setAngularDamping(ang);

            System.out.println("Leave water: " + body);
        }
    }

    /**
     * 每帧在 World.step 之前调用，给在水里的刚体施加阻力 / 水流
     */
    public void update(float dt) {
        for (Body body : bodiesInWater) {
            Vec2 v = body.getLinearVelocity();
            float mass = body.getMass();

            // 1. 阻力：朝速度反方向
            // F_drag = -k * v * mass
            Vec2 drag = v.mul(-linearDragK * mass);

            // 2. 水流：使速度逼近 flowVelocity
            Vec2 rel = v.sub(flowVelocity); // 相对水流的速度
            Vec2 flowForce = rel.mul(-flowForceK * mass); // 越偏离流速，拉回越大

            // 合力
            Vec2 force = drag.add(flowForce);
            body.applyForce(force, body.getTransform().position);

            // 3. 角阻尼：让旋转在水里变钝
            float w = body.getAngularVelocity();
            float torque = -angularDragK * w * mass;
            body.applyTorque(torque);
        }
    }
}
