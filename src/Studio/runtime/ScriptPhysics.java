package Studio.runtime;

import org.jbox2d.callbacks.ContactImpulse;
import org.jbox2d.callbacks.ContactListener;
import org.jbox2d.callbacks.QueryCallback;
import org.jbox2d.callbacks.RayCastCallback;
import org.jbox2d.collision.AABB;
import org.jbox2d.collision.Manifold;
import org.jbox2d.collision.shapes.CircleShape;
import org.jbox2d.collision.shapes.PolygonShape;
import org.jbox2d.common.Vec2;
import org.jbox2d.dynamics.Body;
import org.jbox2d.dynamics.BodyDef;
import org.jbox2d.dynamics.BodyType;
import org.jbox2d.dynamics.Fixture;
import org.jbox2d.dynamics.FixtureDef;
import org.jbox2d.dynamics.contacts.Contact;
import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 涌现式模拟基底之二：<b>物理桥接</b>（契约见 {@code docs/scripting-api.md} §2.11.5）。
 *
 * <p>用项目已有的 {@code lib/jbox2d-library-2.1.2.jar}，给实体加刚体，让「推箱子 / 把油桶抛出去 / 坍塌堆叠」
 * 这类玩法由物理自然发生，而不是脚本假位移。
 *
 * <p>对外命名空间 {@code bwe.physics}：
 * <pre>
 *   bwe.physics.enable() / gravity(gy) / debug(bool)
 *   bwe.physics.body(e, {type, shape, radius, halfW, halfH, density, friction, restitution, sensor})
 *   bwe.physics.remove(e)
 *   bwe.physics.applyImpulse(e, ix, iy) / velocity(e) / setVelocity(e, vx, vy)
 *   bwe.physics.throwAt(e, tx, ty, speed)
 *   bwe.physics.raycast(x1, y1, x2, y2) -> {hit, x, y, entity}
 *   bwe.physics.queryPoint(x, y) / queryAABB(x, y, w, h) -> Entity[]
 *   bwe.physics.on("collision", fn)  // fn({a, b, impulse, sensor})
 * </pre>
 *
 * <p>实现要点：
 * <ul>
 *   <li>默认关闭（{@code enable()} 之后才有开销）；固定步长 1/60，帧内可多次步进；</li>
 *   <li>tilemap 的实体格自动建静态 box（复用 {@code tilemap.solid}），避免穿墙；</li>
 *   <li>dynamic 实体的物理位置每帧写回 {@code Actor.x/y}（脚本读 Entity.x 拿到的是真位置），
 *       并且要能被脚本 {@code setPos} 反向同步（teleport 时重置刚体）；</li>
 *   <li>碰撞回调只对注册过的实体派发，且要在 update 线程里安全调用 JS；</li>
 *   <li>与现有「脚本/模块直接改位置」的移动方式共存：没建刚体的实体完全不受影响。</li>
 * </ul>
 *
 * <p><b>单位</b>：对外一律用像素（位置、半径、速度 px/s、重力 px/s²、冲量 px·kg/s），
 * 内部 jbox2d 用米（{@code PX_PER_M = 32}，即 1 格 = 1 米），避免 Box2D 在「像素量级坐标 +
 * 米量级容差」下的抖动。这样 32×32 像素、density=1 的箱子质量正好 1kg，
 * {@code applyImpulse(e, 400, 0)} 约等于 400px/s 的初速度，脚本作者不用换算。
 *
 * <p><b>本文件由「物理」负责人独占</b>；其它两个子系统不修改本文件。
 */
final class ScriptPhysics {

    // ---------------- 常量 ----------------

    /** 内部 1 米 = 32 像素（= 默认格子大小）。 */
    private static final float PX_PER_M = 32f;
    private static final float M_PER_PX = 1f / PX_PER_M;

    /** 固定物理步长（与帧率解耦）。 */
    private static final float FIXED_DT = 1f / 60f;
    private static final int VELOCITY_ITERATIONS = 8;
    private static final int POSITION_ITERATIONS = 3;
    /** 一帧最多步进次数（1/60 × 6 = 0.1s，与 ScriptEngine 的 dt 上限一致）。 */
    private static final int MAX_STEPS = 6;
    /** 累积器上限，防止卡顿后螺旋追帧。 */
    private static final float MAX_ACCUM = 0.25f;

    /** 判定「脚本改了位置」的阈值（像素）。 */
    private static final float SCRIPT_MOVE_EPS = 0.05f;
    /** 瓦片阻挡变动扫描间隔（秒）。 */
    private static final float TILE_SCAN_INTERVAL = 0.25f;
    /** 回收失效 Actor 刚体的间隔（秒）。 */
    private static final float CLEANUP_INTERVAL = 0.5f;
    /** 单帧最多派发多少个碰撞回调（防止大量接触点把 JS 拍死）。 */
    private static final int MAX_EVENTS_PER_FRAME = 64;

    /** 瓦片静态刚体的 userData 标记（碰撞回调里 b = null 表示「墙」）。 */
    private static final Object TILE_MARK = new Object();

    /** 形状最小半边长/半径（米），防止退化形状让 jbox2d 断言失败。 */
    private static final float MIN_HALF_M = 0.02f;

    // ---------------- 性能观测（测试/报告用；同包可读） ----------------

    /** 上一次 tick 里 {@code World.step} 的总耗时（纳秒）。 */
    static long lastStepNanos;
    /** 上一次 tick 的总耗时（含同步/步进/写回，纳秒）。 */
    static long lastTickNanos;
    /** 当前登记的实体刚体数。 */
    static int lastBodyCount;
    /** 当前瓦片静态刚体数。 */
    static int lastTileBodyCount;
    /** 上一次 tick 实际步进的次数。 */
    static int lastStepCount;

    // ---------------- 状态 ----------------

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final TopDownRuntime host;
    private final ScriptWorld grid;
    private final Scriptable scope;
    private final ScriptJs.Flex ns;

    private boolean enabled;
    private boolean debugDraw;
    private float gravityPx;
    private float accum;
    private float tileScanTimer = TILE_SCAN_INTERVAL;
    private float cleanupTimer;

    private org.jbox2d.dynamics.World phys;

    private final Map<TopDownRuntime.Actor, BodyState> bodies =
            new IdentityHashMap<TopDownRuntime.Actor, BodyState>();
    private final List<Body> tileBodies = new ArrayList<Body>();
    private boolean[] tileSolid;
    private boolean tilesBuilt;
    private int tileCols;
    private int tileRows;
    private float tileSize;

    private final List<Function> collisionHandlers = new ArrayList<Function>();
    /** beginContact → 等 postSolve 补冲量（同一 step 内）。 */
    private final Map<Contact, Pending> pending = new IdentityHashMap<Contact, Pending>();
    /** 本帧待派发（step 结束后统一调 JS，避免在 step 里改世界）。 */
    private final List<Pending> queue = new ArrayList<Pending>();
    private boolean droppedEventsWarned;
    private final Set<String> warned = new HashSet<String>();

    /** 复用的向量，避免每帧分配。 */
    private final Vec2 tmpA = new Vec2();
    private final Vec2 tmpB = new Vec2();
    private final Vec2 tmpC = new Vec2();

    private final ContactListener contactSink = new ContactListener() {
        @Override
        public void beginContact(Contact contact) {
            Fixture fa = contact.getFixtureA();
            Fixture fb = contact.getFixtureB();
            TopDownRuntime.Actor a = actorOf(fa);
            TopDownRuntime.Actor b = actorOf(fb);
            if (a == null && b == null) {
                return; // 瓦片 vs 瓦片：不关心
            }
            boolean sensor = fa.isSensor() || fb.isSensor();
            Pending p = new Pending(a, b, sensor);
            if (sensor) {
                // 传感器不参与求解，没有 postSolve —— 直接排队（impulse 恒为 0）。
                enqueue(p);
            } else {
                pending.put(contact, p);
            }
        }

        @Override
        public void endContact(Contact contact) {
            pending.remove(contact);
        }

        @Override
        public void preSolve(Contact contact, Manifold oldManifold) {
            // 不需要：冲量在 postSolve 里读。
        }

        @Override
        public void postSolve(Contact contact, ContactImpulse impulse) {
            Pending p = pending.remove(contact);
            if (p == null) {
                return;
            }
            int points = contact.getManifold().pointCount;
            float sum = 0f;
            for (int i = 0; i < points && i < impulse.normalImpulses.length; i++) {
                sum += Math.abs(impulse.normalImpulses[i]);
            }
            p.impulse = sum;
            enqueue(p);
        }
    };

    private ScriptPhysics(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.host = api.hostRef();
        this.grid = engine.world;
        this.ns = (ScriptJs.Flex) api.newObj();
        this.scope = ns.getParentScope();
        this.tileSize = grid == null ? 32f : grid.tile;
    }

    // ---------------- 注册 ----------------

    /** 注册 {@code bwe.physics} 并挂上物理步进。 */
    static void install(ScriptApi api) {
        ScriptPhysics p = new ScriptPhysics(api);
        p.buildNamespace();
        api.attach("physics", p.ns);
        api.engineRef().addSimHook(p.simHook);
        // 供测试/诊断：记录最近一次安装的实例（同一 JVM 只会有一个脚本引擎）。
        LAST = p;
    }

    /** 最近一次安装的实例（没有则 null）。诊断/自检用。 */
    static ScriptPhysics LAST;

    /** SimHook：每帧在 update 线程里跑（ScriptEngine.tick 调用）。 */
    private final ScriptEngine.SimHook simHook = new ScriptEngine.SimHook() {
        @Override
        public void tick(float dt) {
            stepFrame(dt);
        }
    };

    private void buildNamespace() {
        api.addMethod(ns, "enable", (cx, thisObj, args) -> {
            enable();
            return Boolean.TRUE;
        });
        api.addMethod(ns, "enabled", (cx, thisObj, args) -> Boolean.valueOf(enabled));
        api.addMethod(ns, "gravity", (cx, thisObj, args) -> {
            if (args == null || args.length == 0 || ScriptJs.isMissing(ScriptJs.arg(args, 0))) {
                return Double.valueOf(gravityPx);
            }
            gravity(ScriptJs.fnum(ScriptJs.arg(args, 0), gravityPx));
            return Double.valueOf(gravityPx);
        });
        api.addMethod(ns, "debug", (cx, thisObj, args) -> {
            if (args == null || args.length == 0 || ScriptJs.isMissing(ScriptJs.arg(args, 0))) {
                return Boolean.valueOf(debugDraw);
            }
            debugDraw = ScriptJs.bool(ScriptJs.arg(args, 0), debugDraw);
            return Boolean.valueOf(debugDraw);
        });
        api.addMethod(ns, "body", (cx, thisObj, args) -> body(api.actorOf(ScriptJs.arg(args, 0)),
                argObj(ScriptJs.arg(args, 1))));
        api.addMethod(ns, "remove", (cx, thisObj, args) -> Boolean.valueOf(remove(
                api.actorOf(ScriptJs.arg(args, 0)))));
        api.addMethod(ns, "applyImpulse", (cx, thisObj, args) -> Boolean.valueOf(applyImpulse(
                api.actorOf(ScriptJs.arg(args, 0)),
                ScriptJs.fnum(ScriptJs.arg(args, 1), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 2), 0f))));
        api.addMethod(ns, "velocity", (cx, thisObj, args) -> velocity(
                api.actorOf(ScriptJs.arg(args, 0))));
        api.addMethod(ns, "setVelocity", (cx, thisObj, args) -> Boolean.valueOf(setVelocity(
                api.actorOf(ScriptJs.arg(args, 0)),
                ScriptJs.fnum(ScriptJs.arg(args, 1), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 2), 0f))));
        api.addMethod(ns, "throwAt", (cx, thisObj, args) -> Boolean.valueOf(throwAt(
                api.actorOf(ScriptJs.arg(args, 0)),
                ScriptJs.fnum(ScriptJs.arg(args, 1), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 2), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 3), 0f))));
        api.addMethod(ns, "raycast", (cx, thisObj, args) -> raycast(
                ScriptJs.fnum(ScriptJs.arg(args, 0), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 1), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 2), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 3), 0f)));
        api.addMethod(ns, "queryPoint", (cx, thisObj, args) -> queryPoint(
                ScriptJs.fnum(ScriptJs.arg(args, 0), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 1), 0f)));
        api.addMethod(ns, "queryAABB", (cx, thisObj, args) -> queryAABB(
                ScriptJs.fnum(ScriptJs.arg(args, 0), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 1), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 2), 0f),
                ScriptJs.fnum(ScriptJs.arg(args, 3), 0f)));
        api.addMethod(ns, "on", (cx, thisObj, args) -> on(
                ScriptJs.str(ScriptJs.arg(args, 0), ""),
                ScriptJs.fnArg(ScriptJs.arg(args, 1))));
        api.addMethod(ns, "bodyCount", (cx, thisObj, args) -> Integer.valueOf(bodies.size()));
        api.addMethod(ns, "tileBodyCount", (cx, thisObj, args) -> Integer.valueOf(tileBodies.size()));
    }

    // ---------------- 开关 / 世界 ----------------

    private void enable() {
        if (phys != null) {
            enabled = true;
            return;
        }
        phys = new org.jbox2d.dynamics.World(new Vec2(0f, gravityPx * M_PER_PX), true);
        // 连续碰撞：throwAt 高速抛出时不穿墙。
        phys.setContinuousPhysics(true);
        phys.setWarmStarting(true);
        phys.setContactListener(contactSink);
        tileCols = grid == null ? 0 : grid.cols;
        tileRows = grid == null ? 0 : grid.rows;
        tileSolid = new boolean[Math.max(0, tileCols * tileRows)];
        rebuildTiles(true);
        enabled = true;
        log("[物理] 已启用（固定步长 1/60，重力 " + gravityPx + "px/s²，瓦片墙 "
                + tileBodies.size() + " 块）");
    }

    private void gravity(float gy) {
        gravityPx = gy;
        if (phys != null) {
            phys.setGravity(new Vec2(0f, gravityPx * M_PER_PX));
        }
    }

    // ---------------- 每帧 ----------------

    private void stepFrame(float rawDt) {
        if (!enabled || phys == null) {
            return;
        }
        long t0 = System.nanoTime();
        float dt = rawDt;
        if (dt < 0f) {
            dt = 0f;
        }
        if (dt > MAX_ACCUM) {
            dt = MAX_ACCUM;
        }

        syncScriptMoves();

        tileScanTimer += dt;
        if (tileScanTimer >= TILE_SCAN_INTERVAL) {
            tileScanTimer = 0f;
            rebuildTiles(false);
        }
        cleanupTimer += dt;
        if (cleanupTimer >= CLEANUP_INTERVAL) {
            cleanupTimer = 0f;
            dropDeadBodies();
        }

        accum += dt;
        if (accum > MAX_ACCUM) {
            accum = MAX_ACCUM;
        }
        int steps = 0;
        long stepNanos = 0L;
        while (accum >= FIXED_DT && steps < MAX_STEPS) {
            long s0 = System.nanoTime();
            try {
                phys.step(FIXED_DT, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
            } finally {
                stepNanos += System.nanoTime() - s0;
            }
            accum -= FIXED_DT;
            steps++;
        }
        if (accum >= FIXED_DT) {
            accum = 0f; // 追不上就丢弃，不越积越多
        }

        writeBack();

        if (debugDraw) {
            recordDebugDraw();
        }

        // 碰撞回调：step 全部结束、位置写回之后再调 JS（回调里可以安全 create/destroy 刚体）。
        flushCollisionEvents();

        lastStepNanos = stepNanos;
        lastStepCount = steps;
        lastBodyCount = bodies.size();
        lastTileBodyCount = tileBodies.size();
        lastTickNanos = System.nanoTime() - t0;
    }

    // ---------------- 刚体管理 ----------------

    private Object body(TopDownRuntime.Actor actor, ScriptableObject opts) {
        if (actor == null) {
            warnOnce("body.actor", "[物理] body(e, opts)：e 不是实体（先用 bwe.world.find/spawn 拿 Entity）");
            return null;
        }
        if (!enabled || phys == null) {
            warnOnce("body.off", "[物理] body(e, opts) 之前要先 call bwe.physics.enable()（默认关闭）");
            return null;
        }
        BodyState old = bodies.get(actor);
        if (old != null) {
            destroyBody(old);
        }

        String typeName = opts == null ? "dynamic"
                : ScriptJs.str(ScriptJs.get(opts, "type"), "dynamic").toLowerCase();
        BodyType type = BodyType.DYNAMIC;
        if ("static".equals(typeName)) {
            type = BodyType.STATIC;
        } else if ("kinematic".equals(typeName)) {
            type = BodyType.KINEMATIC;
        }

        String shapeName = opts == null ? "box"
                : ScriptJs.str(ScriptJs.get(opts, "shape"), "box").toLowerCase();
        boolean circle = "circle".equals(shapeName);

        float fullW = host.drawWidth(actor);
        float fullH = host.drawHeight(actor);
        if (fullW <= 0f) {
            fullW = 32f;
        }
        if (fullH <= 0f) {
            fullH = 32f;
        }
        float radiusPx = opts == null ? Math.max(2f, Math.min(fullW, fullH) * 0.5f)
                : ScriptJs.fnum(ScriptJs.get(opts, "radius"), Math.max(2f, Math.min(fullW, fullH) * 0.5f));
        float halfWPx = opts == null ? fullW * 0.5f
                : ScriptJs.fnum(ScriptJs.get(opts, "halfW"), fullW * 0.5f);
        float halfHPx = opts == null ? fullH * 0.5f
                : ScriptJs.fnum(ScriptJs.get(opts, "halfH"), fullH * 0.5f);
        radiusPx = Math.max(1f, radiusPx);
        halfWPx = Math.max(1f, halfWPx);
        halfHPx = Math.max(1f, halfHPx);

        float density = opts == null ? 1f : ScriptJs.fnum(ScriptJs.get(opts, "density"), 1f);
        float friction = opts == null ? 0.4f : ScriptJs.fnum(ScriptJs.get(opts, "friction"), 0.4f);
        float restitution = opts == null ? 0.1f : ScriptJs.fnum(ScriptJs.get(opts, "restitution"), 0.1f);
        boolean sensor = opts != null && ScriptJs.bool(ScriptJs.get(opts, "sensor"), false);
        float damping = opts == null ? 0f : ScriptJs.fnum(ScriptJs.get(opts, "damping"), 0f);
        boolean fixedRotation = opts == null || ScriptJs.bool(ScriptJs.get(opts, "fixedRotation"), true);
        boolean bullet = opts != null && ScriptJs.bool(ScriptJs.get(opts, "bullet"), false);
        if (density <= 0f) {
            density = 0.001f;
        }
        restitution = clamp(restitution, 0f, 1f);
        friction = Math.max(0f, friction);
        damping = Math.max(0f, damping);

        BodyDef bd = new BodyDef();
        bd.type = type;
        bd.position.set(actor.x * M_PER_PX, actor.y * M_PER_PX);
        bd.fixedRotation = fixedRotation;
        bd.allowSleep = true;
        bd.bullet = bullet;
        bd.linearDamping = damping;
        Body body = phys.createBody(bd);

        FixtureDef fd = new FixtureDef();
        if (circle) {
            CircleShape cs = new CircleShape();
            cs.m_radius = Math.max(MIN_HALF_M, radiusPx * M_PER_PX);
            fd.shape = cs;
        } else {
            PolygonShape ps = new PolygonShape();
            ps.setAsBox(Math.max(MIN_HALF_M, halfWPx * M_PER_PX),
                    Math.max(MIN_HALF_M, halfHPx * M_PER_PX));
            fd.shape = ps;
        }
        fd.density = density;
        fd.friction = friction;
        fd.restitution = restitution;
        fd.isSensor = sensor;
        body.createFixture(fd);

        BodyState bs = new BodyState(actor, body, type, circle, radiusPx, halfWPx, halfHPx, sensor);
        bs.lastX = actor.x;
        bs.lastY = actor.y;
        body.setUserData(bs);
        bodies.put(actor, bs);
        if (type == BodyType.STATIC) {
            body.setAwake(false);
        }
        return api.entityOf(actor);
    }

    private boolean remove(TopDownRuntime.Actor actor) {
        BodyState bs = actor == null ? null : bodies.get(actor);
        if (bs == null) {
            return false;
        }
        destroyBody(bs);
        return true;
    }

    private void destroyBody(BodyState bs) {
        bodies.remove(bs.actor);
        bs.body.setUserData(null);
        try {
            if (phys != null) {
                phys.destroyBody(bs.body);
            }
        } catch (Throwable t) {
            log("[物理] 销毁刚体失败: " + t);
        }
    }

    private void dropDeadBodies() {
        if (bodies.isEmpty()) {
            return;
        }
        Set<TopDownRuntime.Actor> alive = deadSet();
        Iterator<Map.Entry<TopDownRuntime.Actor, BodyState>> it = bodies.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<TopDownRuntime.Actor, BodyState> e = it.next();
            TopDownRuntime.Actor a = e.getKey();
            if (a == null || a.o == null || a.dead || !alive.contains(a)) {
                BodyState bs = e.getValue();
                try {
                    if (phys != null) {
                        phys.destroyBody(bs.body);
                    }
                } catch (Throwable ignored) {
                }
                it.remove();
            }
        }
    }

    private Set<TopDownRuntime.Actor> deadSet() {
        Set<TopDownRuntime.Actor> set = java.util.Collections.newSetFromMap(
                new IdentityHashMap<TopDownRuntime.Actor, Boolean>());
        for (TopDownRuntime.Actor a : host.actors) {
            set.add(a);
        }
        return set;
    }

    // ---------------- 每帧同步 ----------------

    /**
     * 脚本 / 其它模块改了 {@code Actor.x/y} → 视为 teleport：重置刚体到该位置并清零速度，
     * 避免「物理写回」和「脚本写位置」互相拉锯。脚本用 setVelocity/applyImpulse 才走物理。
     */
    private void syncScriptMoves() {
        if (bodies.isEmpty()) {
            return;
        }
        for (BodyState bs : bodies.values()) {
            TopDownRuntime.Actor a = bs.actor;
            float dx = a.x - bs.lastX;
            float dy = a.y - bs.lastY;
            if (Math.abs(dx) <= SCRIPT_MOVE_EPS && Math.abs(dy) <= SCRIPT_MOVE_EPS) {
                continue;
            }
            tmpA.set(a.x * M_PER_PX, a.y * M_PER_PX);
            bs.body.setTransform(tmpA, bs.body.getAngle());
            if (bs.type != BodyType.STATIC) {
                bs.body.setLinearVelocity(tmpB.set(0f, 0f));
                bs.body.setAngularVelocity(0f);
                bs.body.setAwake(true);
            }
            bs.lastX = a.x;
            bs.lastY = a.y;
        }
    }

    /** 物理位置写回 Actor（dynamic / kinematic 才会动）。 */
    private void writeBack() {
        if (bodies.isEmpty()) {
            return;
        }
        for (BodyState bs : bodies.values()) {
            if (bs.type == BodyType.STATIC) {
                continue;
            }
            Vec2 p = bs.body.getPosition();
            float px = p.x * PX_PER_M;
            float py = p.y * PX_PER_M;
            if (Math.abs(px - bs.lastX) <= 0.0005f && Math.abs(py - bs.lastY) <= 0.0005f) {
                continue;
            }
            TopDownRuntime.Actor a = bs.actor;
            a.x = px;
            a.y = py;
            a.baseX = px;
            a.baseY = py;
            bs.lastX = px;
            bs.lastY = py;
        }
    }

    // ---------------- 瓦片静态墙 ----------------

    /** 扫描 tilemap 的阻挡格；有变动就整体重建静态墙（燃烧改地形后自动同步）。 */
    private void rebuildTiles(boolean force) {
        if (phys == null || grid == null || tileSolid == null) {
            return;
        }
        tileSize = grid.tile;
        boolean changed = force || !tilesBuilt;
        for (int cy = 0; cy < tileRows; cy++) {
            for (int cx = 0; cx < tileCols; cx++) {
                boolean solid = grid.solidCell(cx, cy);
                int idx = cy * tileCols + cx;
                if (tileSolid[idx] != solid) {
                    tileSolid[idx] = solid;
                    changed = true;
                }
            }
        }
        if (!changed) {
            return;
        }
        tilesBuilt = true;
        for (Body b : tileBodies) {
            try {
                phys.destroyBody(b);
            } catch (Throwable ignored) {
            }
        }
        tileBodies.clear();
        // 同一行相邻的阻挡格合并成一整块墙（刚体数量少，step 更快）。
        for (int cy = 0; cy < tileRows; cy++) {
            int cx = 0;
            while (cx < tileCols) {
                if (!tileSolid[cy * tileCols + cx]) {
                    cx++;
                    continue;
                }
                int start = cx;
                while (cx + 1 < tileCols && tileSolid[cy * tileCols + cx + 1]) {
                    cx++;
                }
                int end = cx;
                float centerX = (start + end + 1) * 0.5f * tileSize;
                float centerY = (cy + 0.5f) * tileSize;
                float halfW = (end - start + 1) * 0.5f * tileSize;
                tileBodies.add(createWallBox(centerX, centerY, halfW, tileSize * 0.5f));
                cx++;
            }
        }
        // 地图外算墙（与 ScriptWorld.solidCell 一致），防止箱子飞出地图后永不停止。
        float mapW = tileCols * tileSize;
        float mapH = tileRows * tileSize;
        tileBodies.add(createWallBox(mapW * 0.5f, -tileSize * 0.5f, mapW * 0.5f + tileSize, tileSize * 0.5f));
        tileBodies.add(createWallBox(mapW * 0.5f, mapH + tileSize * 0.5f, mapW * 0.5f + tileSize, tileSize * 0.5f));
        tileBodies.add(createWallBox(-tileSize * 0.5f, mapH * 0.5f, tileSize * 0.5f, mapH * 0.5f));
        tileBodies.add(createWallBox(mapW + tileSize * 0.5f, mapH * 0.5f, tileSize * 0.5f, mapH * 0.5f));
    }

    private Body createWallBox(float centerX, float centerY, float halfW, float halfH) {
        BodyDef bd = new BodyDef();
        bd.type = BodyType.STATIC;
        bd.position.set(centerX * M_PER_PX, centerY * M_PER_PX);
        Body body = phys.createBody(bd);
        PolygonShape ps = new PolygonShape();
        ps.setAsBox(Math.max(MIN_HALF_M, halfW * M_PER_PX), Math.max(MIN_HALF_M, halfH * M_PER_PX));
        FixtureDef fd = new FixtureDef();
        fd.shape = ps;
        fd.density = 0f;
        fd.friction = 0.5f;
        fd.restitution = 0f;
        body.createFixture(fd);
        body.setUserData(TILE_MARK);
        return body;
    }

    private static TopDownRuntime.Actor actorOf(Fixture f) {
        if (f == null) {
            return null;
        }
        Body b = f.getBody();
        Object ud = b == null ? null : b.getUserData();
        return ud instanceof BodyState ? ((BodyState) ud).actor : null;
    }

    // ---------------- 力 / 速度 ----------------

    private boolean applyImpulse(TopDownRuntime.Actor actor, float ix, float iy) {
        BodyState bs = actor == null ? null : bodies.get(actor);
        if (bs == null || bs.type != BodyType.DYNAMIC) {
            return false;
        }
        bs.body.setAwake(true);
        tmpA.set(ix * M_PER_PX, iy * M_PER_PX);
        bs.body.applyLinearImpulse(tmpA, bs.body.getWorldCenter());
        return true;
    }

    private Scriptable velocity(TopDownRuntime.Actor actor) {
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        BodyState bs = actor == null ? null : bodies.get(actor);
        if (bs != null) {
            Vec2 v = bs.body.getLinearVelocity();
            o.values.put("vx", Double.valueOf(v.x * PX_PER_M));
            o.values.put("vy", Double.valueOf(v.y * PX_PER_M));
        } else {
            o.values.put("vx", Double.valueOf(0.0));
            o.values.put("vy", Double.valueOf(0.0));
        }
        return o;
    }

    private boolean setVelocity(TopDownRuntime.Actor actor, float vx, float vy) {
        BodyState bs = actor == null ? null : bodies.get(actor);
        if (bs == null) {
            return false;
        }
        bs.body.setAwake(true);
        bs.body.setLinearVelocity(tmpA.set(vx * M_PER_PX, vy * M_PER_PX));
        return true;
    }

    /**
     * 朝目标抛：无重力时按「直线 + 指定速度」；有重力时按抛物线解算（力度按距离自适应），
     * 这样俯视角和侧视角两套关卡都能用同一个 API。
     */
    private boolean throwAt(TopDownRuntime.Actor actor, float tx, float ty, float speed) {
        BodyState bs = actor == null ? null : bodies.get(actor);
        if (bs == null) {
            return false;
        }
        float dx = tx - actor.x;
        float dy = ty - actor.y;
        float dist = (float) Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.0001f) {
            return false;
        }
        float sp = speed;
        if (sp <= 0f) {
            sp = clamp(dist * 1.6f, 60f, 1600f);
        }
        float vx;
        float vy;
        if (Math.abs(gravityPx) < 1f) {
            vx = dx / dist * sp;
            vy = dy / dist * sp;
        } else {
            float t = clamp(dist / sp, 0.18f, 2.5f);
            vx = dx / t;
            vy = (dy - 0.5f * gravityPx * t * t) / t;
        }
        bs.body.setAwake(true);
        bs.body.setLinearVelocity(tmpA.set(vx * M_PER_PX, vy * M_PER_PX));
        return true;
    }

    // ---------------- 查询 ----------------

    private final class RayHit implements RayCastCallback {
        float fraction = 1f;
        float x;
        float y;
        float nx;
        float ny = -1f;
        TopDownRuntime.Actor actor;
        boolean sensor;
        boolean any;

        @Override
        public float reportFixture(Fixture fixture, Vec2 point, Vec2 normal, float fr) {
            if (fr <= fraction) {
                fraction = fr;
                x = point.x * PX_PER_M;
                y = point.y * PX_PER_M;
                nx = normal.x;
                ny = normal.y;
                actor = actorOf(fixture);
                sensor = fixture.isSensor();
                any = true;
            }
            return fr;
        }
    }

    private Scriptable raycast(float x1, float y1, float x2, float y2) {
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        o.values.put("hit", Boolean.FALSE);
        o.values.put("x", Double.valueOf(x2));
        o.values.put("y", Double.valueOf(y2));
        o.values.put("entity", null);
        if (!enabled || phys == null) {
            return o;
        }
        RayHit hit = new RayHit();
        try {
            phys.raycast(hit, tmpA.set(x1 * M_PER_PX, y1 * M_PER_PX),
                    tmpB.set(x2 * M_PER_PX, y2 * M_PER_PX));
        } catch (Throwable t) {
            log("[物理] raycast 失败: " + t);
            return o;
        }
        if (hit.any) {
            o.values.put("hit", Boolean.TRUE);
            o.values.put("x", Double.valueOf(hit.x));
            o.values.put("y", Double.valueOf(hit.y));
            o.values.put("entity", hit.actor == null ? null : api.entityOf(hit.actor));
            o.values.put("nx", Double.valueOf(hit.nx));
            o.values.put("ny", Double.valueOf(hit.ny));
            o.values.put("fraction", Double.valueOf(hit.fraction));
            o.values.put("sensor", Boolean.valueOf(hit.sensor));
        }
        return o;
    }

    private final class QueryCollector implements QueryCallback {
        final List<TopDownRuntime.Actor> out = new ArrayList<TopDownRuntime.Actor>();
        final Map<TopDownRuntime.Actor, Boolean> seen =
                new IdentityHashMap<TopDownRuntime.Actor, Boolean>();
        float pointX;
        float pointY;
        boolean pointOnly;

        @Override
        public boolean reportFixture(Fixture fixture) {
            TopDownRuntime.Actor a = actorOf(fixture);
            if (a == null) {
                return true;
            }
            if (pointOnly && !fixture.testPoint(tmpC.set(pointX * M_PER_PX, pointY * M_PER_PX))) {
                return true;
            }
            if (seen.put(a, Boolean.TRUE) == null) {
                out.add(a);
            }
            return true;
        }
    }

    private Scriptable queryPoint(float x, float y) {
        if (!enabled || phys == null) {
            return entityArray(new ArrayList<TopDownRuntime.Actor>());
        }
        QueryCollector qc = new QueryCollector();
        qc.pointOnly = true;
        qc.pointX = x;
        qc.pointY = y;
        AABB box = new AABB(new Vec2(x * M_PER_PX - 0.001f, y * M_PER_PX - 0.001f),
                new Vec2(x * M_PER_PX + 0.001f, y * M_PER_PX + 0.001f));
        try {
            phys.queryAABB(qc, box);
        } catch (Throwable t) {
            log("[物理] queryPoint 失败: " + t);
        }
        return entityArray(qc.out);
    }

    private Scriptable queryAABB(float x, float y, float w, float h) {
        if (!enabled || phys == null) {
            return entityArray(new ArrayList<TopDownRuntime.Actor>());
        }
        float minX = Math.min(x, x + w);
        float minY = Math.min(y, y + h);
        float maxX = Math.max(x, x + w);
        float maxY = Math.max(y, y + h);
        QueryCollector qc = new QueryCollector();
        AABB box = new AABB(new Vec2(minX * M_PER_PX, minY * M_PER_PX),
                new Vec2(maxX * M_PER_PX, maxY * M_PER_PX));
        try {
            phys.queryAABB(qc, box);
        } catch (Throwable t) {
            log("[物理] queryAABB 失败: " + t);
        }
        return entityArray(qc.out);
    }

    private Scriptable entityArray(List<TopDownRuntime.Actor> list) {
        Context cx = Context.getCurrentContext();
        if (cx == null) {
            return api.newObj();
        }
        Object[] values = new Object[list.size()];
        for (int i = 0; i < list.size(); i++) {
            values[i] = api.entityOf(list.get(i));
        }
        return cx.newArray(scope, values);
    }

    // ---------------- 碰撞事件 ----------------

    private Object on(String event, Function fn) {
        if (fn == null) {
            return null;
        }
        if (!"collision".equalsIgnoreCase(event)) {
            warnOnce("on." + event, "[物理] 未知事件「" + event + "」，只支持 \"collision\"");
            return null;
        }
        collisionHandlers.add(fn);
        final Function target = fn;
        // 返回取消订阅的句柄：var off = bwe.physics.on(...); off();
        return api.newFn("offCollision", (cx, thisObj, args) -> {
            collisionHandlers.remove(target);
            return null;
        });
    }

    private void enqueue(Pending p) {
        if (queue.size() >= MAX_EVENTS_PER_FRAME) {
            if (!droppedEventsWarned) {
                droppedEventsWarned = true;
                log("[物理] 单帧碰撞事件超过 " + MAX_EVENTS_PER_FRAME + " 条，多余的被丢弃（检查穿透/堆叠）");
            }
            return;
        }
        queue.add(p);
    }

    private void flushCollisionEvents() {
        if (queue.isEmpty()) {
            return;
        }
        if (!collisionHandlers.isEmpty()) {
            // 快照：回调里可能 off() 取消订阅，遍历快照避免并发问题。
            Object[] handlers = collisionHandlers.toArray();
            for (int i = 0; i < queue.size(); i++) {
                Pending p = queue.get(i);
                TopDownRuntime.Actor a = p.a;
                TopDownRuntime.Actor b = p.b;
                if (a != null && (a.o == null || a.dead)) {
                    a = null;
                }
                if (b != null && (b.o == null || b.dead)) {
                    b = null;
                }
                if (a == null && b == null) {
                    continue;
                }
                ScriptJs.Flex ev = (ScriptJs.Flex) api.newObj();
                ev.values.put("a", a == null ? null : api.entityOf(a));
                ev.values.put("b", b == null ? null : api.entityOf(b));
                ev.values.put("impulse", Double.valueOf(p.impulse));
                ev.values.put("sensor", Boolean.valueOf(p.sensor));
                for (int h = 0; h < handlers.length; h++) {
                    Function fn = (Function) handlers[h];
                    try {
                        engine.callValue(fn, new Object[]{ev});
                    } catch (Throwable t) {
                        logError("[物理] collision 回调异常: " + t);
                    }
                }
            }
        }
        queue.clear();
    }

    // ---------------- 调试绘制 ----------------

    private void recordDebugDraw() {
        if (engine.render == null || engine.drawCmds == null) {
            return;
        }
        for (BodyState bs : bodies.values()) {
            String color = bs.type == BodyType.STATIC ? "#94a3b8"
                    : bs.type == BodyType.KINEMATIC ? "#facc15" : "#4ade80";
            recordShape(bs, color);
        }
        for (Body b : tileBodies) {
            Object ud = b.getUserData();
            if (ud == TILE_MARK) {
                recordWallOutline(b);
            }
        }
    }

    private void recordShape(BodyState bs, String color) {
        Vec2 p = bs.body.getPosition();
        float cx = p.x * PX_PER_M;
        float cy = p.y * PX_PER_M;
        if (bs.circle) {
            ScriptRender.Cmd cmd = engine.render.circle(cx, cy, bs.radiusPx, null, color, 0.85f, 1f);
            cmd.world = true;
            engine.drawCmds.add(cmd);
        } else {
            ScriptRender.Cmd cmd = engine.render.rect(cx - bs.halfWPx, cy - bs.halfHPx,
                    bs.halfWPx * 2f, bs.halfHPx * 2f, null, color, 0.85f, 0, 1f);
            cmd.world = true;
            engine.drawCmds.add(cmd);
        }
    }

    private void recordWallOutline(Body b) {
        Fixture f = b.getFixtureList();
        if (f == null) {
            return;
        }
        AABB aabb = f.getAABB();
        float x = aabb.lowerBound.x * PX_PER_M;
        float y = aabb.lowerBound.y * PX_PER_M;
        float w = (aabb.upperBound.x - aabb.lowerBound.x) * PX_PER_M;
        float h = (aabb.upperBound.y - aabb.lowerBound.y) * PX_PER_M;
        ScriptRender.Cmd cmd = engine.render.rect(x, y, w, h, null, "#64748b", 0.5f, 0, 1f);
        cmd.world = true;
        engine.drawCmds.add(cmd);
    }

    /** 当前登记的实体刚体数（诊断/自检用）。 */
    int bodyCount() {
        return bodies.size();
    }

    // ---------------- 小工具 ----------------

    private static ScriptableObject argObj(Object v) {
        if (v instanceof ScriptableObject) {
            return (ScriptableObject) v;
        }
        return null;
    }

    private static float clamp(float v, float min, float max) {
        return v < min ? min : (v > max ? max : v);
    }

    private void log(String msg) {
        try {
            engine.log(msg);
        } catch (Throwable ignored) {
        }
    }

    private void logError(String msg) {
        try {
            engine.logError(msg);
        } catch (Throwable ignored) {
        }
    }

    private void warnOnce(String key, String msg) {
        if (warned.add(key)) {
            log(msg);
        }
    }

    // ---------------- 数据结构 ----------------

    private static final class BodyState {
        final TopDownRuntime.Actor actor;
        final Body body;
        final BodyType type;
        final boolean circle;
        final float radiusPx;
        final float halfWPx;
        final float halfHPx;
        final boolean sensor;
        float lastX;
        float lastY;

        BodyState(TopDownRuntime.Actor actor, Body body, BodyType type, boolean circle,
                  float radiusPx, float halfWPx, float halfHPx, boolean sensor) {
            this.actor = actor;
            this.body = body;
            this.type = type;
            this.circle = circle;
            this.radiusPx = radiusPx;
            this.halfWPx = halfWPx;
            this.halfHPx = halfHPx;
            this.sensor = sensor;
        }
    }

    private static final class Pending {
        final TopDownRuntime.Actor a;
        final TopDownRuntime.Actor b;
        final boolean sensor;
        float impulse;

        Pending(TopDownRuntime.Actor a, TopDownRuntime.Actor b, boolean sensor) {
            this.a = a;
            this.b = b;
            this.sensor = sensor;
        }
    }
}
