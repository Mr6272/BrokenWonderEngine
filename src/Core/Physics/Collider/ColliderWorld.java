package Core.Physics.Collider;

import Core.Vector2;
import org.jbox2d.common.Vec2;
import org.jbox2d.dynamics.World;

public class ColliderWorld {
    public World world;
    public ColliderWorld(Vector2 gravity) {
        Vec2 gravityVec = new Vec2(gravity.x, gravity.y);
        world = new World(gravityVec, false);
    }
    /**
     * 步进世界一帧
     * @param timeStep 时间步长，比如 1/60f
     * @param velIters 速度迭代次数（一般 6~8）
     * @param posIters 位置迭代次数（一般 2~3）
     */
    public void step(float timeStep, int velIters, int posIters) {
        world.step(timeStep, velIters, posIters);
    }
}
