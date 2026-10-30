package Core;

import Framework.GameObject;

/**
 * 碰撞事件载荷（架构 §4.3 事件契约）。旧核心侧 enter / stay / exit 的统一表示。
 *
 * <p>契约（与 {@code docs/open-world-architecture.md} §4.3 一致）：
 * <table>
 *   <tr><th>kind</th><th>时机</th><th>次数</th></tr>
 *   <tr><td>ENTER</td><td>上一 tick 无接触、本 tick 有</td><td>每对一次</td></tr>
 *   <tr><td>STAY</td><td>连续两 tick 都有接触</td><td>每 tick 一次</td></tr>
 *   <tr><td>EXIT</td><td>上一 tick 有、本 tick 无</td><td>每对一次</td></tr>
 * </table>
 *
 * <p>传感器（sensor）与实体的区分由 {@link #isSensor()} 表达：sensor 与 sensor 相交 →
 * 双方都收 trigger 事件；sensor vs solid → sensor 方收 trigger，solid 方收 collision。
 */
public final class CollisionEvent {

    public enum Kind {
        ENTER, STAY, EXIT
    }

    /** 收到事件的宿主（"self"）。 */
    public final GameObject self;
    /** 对方。 */
    public final GameObject other;
    public final Kind kind;
    /** 本对接触是否涉及传感器（任一方 sensor 即为 true）。 */
    public final boolean sensor;
    /** 法线 / 接触点：旧核心的 O(n²) 配对不产生接触流形，保留为 null（契约允许）。 */
    public final float[] normal;
    public final float[] point;

    public CollisionEvent(GameObject self, GameObject other, Kind kind, boolean sensor,
                          float[] normal, float[] point) {
        this.self = self;
        this.other = other;
        this.kind = kind;
        this.sensor = sensor;
        this.normal = normal;
        this.point = point;
    }

    public boolean isEnter() {
        return kind == Kind.ENTER;
    }

    public boolean isStay() {
        return kind == Kind.STAY;
    }

    public boolean isExit() {
        return kind == Kind.EXIT;
    }

    public boolean isSensor() {
        return sensor;
    }

    /** 事件名：sensor 与实体用不同前缀，方便脚本/总线按名订阅。 */
    public String eventName() {
        switch (kind) {
            case ENTER:
                return sensor ? "triggerEnter" : "collisionEnter";
            case STAY:
                return sensor ? "triggerStay" : "collisionStay";
            case EXIT:
                return sensor ? "triggerExit" : "collisionExit";
            default:
                return "collision";
        }
    }

    @Override
    public String toString() {
        return "CollisionEvent(" + kind + ", sensor=" + sensor
                + ", self=" + self + ", other=" + other + ")";
    }
}
