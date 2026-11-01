package Studio.runtime;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 车辆命名空间 {@code bwe.vehicle}（契约 {@code docs/api/vehicle.md}；任务书 §18）。
 *
 * <h3>层归属</h3>
 * 这是<b>L3 通用游戏模块</b>：车辆运动本身不是"某个游戏专属"（任何开放世界都有车），
 * 但具体手感（加速曲线、转向半径）是游戏数值 → 由 {@code boot.json} 的数据表驱动，
 * 引擎只实现"加速/制动/转向/沿路网行驶/驾驶员/上下车"这些通用骨架。
 *
 * <h3>关键设计：车辆用路网，不用瓦片 A*</h3>
 * 任务书 §18："车辆移动与行人导航应使用不同的导航配置"。实现上：
 * <ul>
 *   <li>车辆持有 {@code route}（来自 {@link ScriptRoad#findRoute}），沿节点逐个跟随；</li>
 *   <li>到路口时方向插值转向（不是瞬移朝向）；</li>
 *   <li>速度由油门/制动 + 路段限速共同决定。</li>
 * </ul>
 *
 * <h3>生命周期</h3>
 * <ul>
 *   <li>{@code spawn} 建实体 → {@code enter} 绑定驾驶员 → {@code drive} 沿路 → </li>
 *   <li>{@code exit} 驾驶员离开（车辆留下，可再被劫） → {@code destroy} 实体销毁</li>
 *   <li>车辆被销毁时若仍有驾驶员 → 先派发 {@code exit} 再销毁（否则驾驶员卡在车里）</li>
 * </ul>
 */
final class ScriptVehicle {

    static ScriptVehicle LAST;

    private final ScriptApi api;
    private final ScriptEngine engine;
    private final TopDownRuntime host;
    private final Scriptable scope;
    private final ScriptJs.Flex ns;

    /**
     * Actor → 车辆状态。
     *
     * <p>用 {@link LinkedHashMap}（插入序）而不是 IdentityHashMap：后者遍历顺序随对象哈希变化，
     * 多车同帧更新顺序不确定 → 回放/测试不可复现。Actor 未重写 equals/hashCode，语义等同按引用。</p>
     */
    private final Map<Actor, Veh> vehicles =
            new LinkedHashMap<Actor, Veh>();
    /** 驾驶员 → 车辆（反向索引，用于 {@code vehicleOf}）。 */
    private final Map<Actor, Actor> driving =
            new IdentityHashMap<Actor, Actor>();

    /** 事件订阅：crash / hijack / enter / exit。 */
    private final Map<String, List<Holder>> handlers = new LinkedHashMap<String, List<Holder>>();

    private long nextId = 1;

    private static final class Holder {
        final Function fn;
        final ScriptEngine.ScriptDef def;

        Holder(Function fn, ScriptEngine.ScriptDef def) {
            this.fn = fn;
            this.def = def;
        }
    }

    /** 一辆车的运行状态。 */
    static final class Veh {
        final long id;
        Actor actor;
        Actor driver;
        /** 车辆类型：car / taxi / police（数据驱动，引擎不写死含义）。 */
        String kind = "car";
        /** 当前速度（px/s，沿 heading 方向）。 */
        float speed;
        /** 车头朝向（弧度）。 */
        float heading;
        /** 油门 / 制动（0..1）。 */
        float throttle;
        float brake;
        /** 转向输入（-1..1），沿路网时自动算。 */
        float steer;
        /** 当前路径（路网节点坐标）与下标。 */
        List<float[]> route;
        int routeIndex;
        /** 目标速度上限（由限速决定）。 */
        float speedLimit = 260f;
        /** 损伤 0..1。 */
        float damage;
        /** 是否沿路网自动驾驶。 */
        boolean autoDrive;
        /** 到达回调。 */
        Function onArrive;
        ScriptEngine.ScriptDef onArriveDef;
        /** 每帧是否可推动（被玩家驾驶时 true）。 */
        boolean controllable = true;
        /** 驻车：下车 / stop / 到站后置位，目标速度 0 且不倒车；throttle/steer/followRoad/enter 解除。 */
        boolean parked;
        /** setSpeed 锁定：本帧以 lockSpeed 行驶（不经过加减速），下一帧恢复正常。 */
        boolean speedLocked;
        float lockSpeed;
        /** 当前所在路段限速（自动驾驶时由路线点给出；0 = 未知）。 */
        float edgeLimit;
        /** 路线节点 id 与中心坐标、停止线距离（离节点中心多远停车，≈横穿道路半宽）。 */
        String[] nodeIds;
        float[] nodeX;
        float[] nodeY;
        float[] nodeStop;
        /** 驶入该节点的方向（单位向量；起点节点为 0,0）。 */
        float[] nodeDirX;
        float[] nodeDirY;
        /** 路点累计路程：cum[j] = 从建路线时车的位置沿路线到第 j 个路点的距离。 */
        float[] cum;
        /** 下一个尚未通过的节点序号（nodeIds 下标；-1 = 无）。 */
        int nextNodeSlot = -1;
        /** 最近一次到站的节点 id（路线结束后 of().prevNode 用）。 */
        String lastNodeId = "";
        /** 建路线时车的位置（第 0 个路点的"上一个点"，用于过面判定）。 */
        float routeStartX;
        float routeStartY;
        /** 自上次切换路点以来累计转过的角度（弧度）；超过 270° 视为够不着该点 → 跳过，杜绝原地打转。 */
        float turnAccum;

        Veh(long id, Actor actor) {
            this.id = id;
            this.actor = actor;
        }
    }

    private ScriptVehicle(ScriptApi api) {
        this.api = api;
        this.engine = api.engineRef();
        this.host = api.hostRef();
        this.ns = (ScriptJs.Flex) api.newObj();
        this.scope = ns.getParentScope();
    }

    static void install(ScriptApi api) {
        ScriptVehicle v = new ScriptVehicle(api);
        v.build();
        api.attach("vehicle", v.ns);
        api.engineRef().addPhaseHook(ScriptEngine.PHASE_EVENTS, v.tickHook);
        LAST = v;
    }

    private final ScriptEngine.PhaseHook tickHook = new ScriptEngine.PhaseHook() {
        @Override
        public void tick(float dt) {
            ScriptVehicle.this.tickVehicles(dt);
        }
    };

    // ---------------- 命名空间 ----------------

    private void build() {
        // spawn(opts) → Entity（**必须包成 JS Entity**）
        //
        // ⚠ 第一版直接 `return spawnVehicle(...)`，返回的是 Java 的 Actor 而不是 JS 包装对象，
        // 于是脚本里 `e.x` / `e.hpMax` / `bwe.vehicle.followRoad(e, ...)` 全部拿不到东西
        // （Rhino 不认 Actor 的字段），车辆"生成了但永远不动" —— soak 实测 moved=0/4。
        api.addMethod(ns, "spawn", (cx, thisObj, args) -> {
            Actor a = spawnVehicle(ScriptJs.arg(args, 0));
            return a == null ? null : api.entity(a);
        });

        // of(e) → {id, kind, speed, heading, driver, damage, autoDrive, routeIndex, routeLength} | null
        api.addMethod(ns, "of", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            return v == null ? null : vehObj(v);
        });

        // isVehicle(e) → bool
        api.addMethod(ns, "isVehicle", (cx, thisObj, args) ->
                Boolean.valueOf(vehicles.containsKey(api.actorOf(ScriptJs.arg(args, 0)))));

        // driver(e) → Entity | null
        api.addMethod(ns, "driver", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            return v == null || v.driver == null ? null : api.entity(v.driver);
        });

        // vehicleOf(e) → 该实体正在驾驶的车 | null
        api.addMethod(ns, "vehicleOf", (cx, thisObj, args) -> {
            Actor car = driving.get(api.actorOf(ScriptJs.arg(args, 0)));
            return car == null ? null : api.entity(car);
        });

        // enter(driver, vehicle, opts) → bool
        api.addMethod(ns, "enter", (cx, thisObj, args) -> {
            Actor driver = api.actorOf(ScriptJs.arg(args, 0));
            Actor car = api.actorOf(ScriptJs.arg(args, 1));
            return Boolean.valueOf(enterVehicle(driver, car));
        });

        // exit(driver, opts) → bool（下车，车留下）
        api.addMethod(ns, "exit", (cx, thisObj, args) -> {
            Actor driver = api.actorOf(ScriptJs.arg(args, 0));
            return Boolean.valueOf(exitVehicle(driver));
        });

        // hijack(hijacker, vehicle) → bool（劫车：原驾驶员被踢出并派发 hijack）
        api.addMethod(ns, "hijack", (cx, thisObj, args) -> {
            Actor who = api.actorOf(ScriptJs.arg(args, 0));
            Actor car = api.actorOf(ScriptJs.arg(args, 1));
            return Boolean.valueOf(hijack(who, car));
        });

        // throttle(e, v) / brake(e, v) / steer(e, v)
        api.addMethod(ns, "throttle", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            if (v == null) {
                return Boolean.FALSE;
            }
            v.throttle = clamp01(ScriptJs.fnum(ScriptJs.arg(args, 1), 1f));
            v.parked = false;
            return Boolean.TRUE;
        });
        api.addMethod(ns, "brake", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            if (v == null) {
                return Boolean.FALSE;
            }
            v.brake = clamp01(ScriptJs.fnum(ScriptJs.arg(args, 1), 1f));
            return Boolean.TRUE;
        });
        api.addMethod(ns, "steer", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            if (v == null) {
                return Boolean.FALSE;
            }
            v.steer = Math.max(-1f, Math.min(1f, ScriptJs.fnum(ScriptJs.arg(args, 1), 0f)));
            if (v.steer != 0f) {
                v.parked = false;
            }
            return Boolean.TRUE;
        });

        // setSpeed(e, v) → bool：本帧速度直接设为 v（px/s，负 = 倒车），不经过加减速；下一帧恢复正常物理。
        // 典型用途：setSpeed(car, 0) 瞬停（撞墙/剧情），或出场时给初速度。
        api.addMethod(ns, "setSpeed", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            if (v == null) {
                return Boolean.FALSE;
            }
            float s = ScriptJs.fnum(ScriptJs.arg(args, 1), 0f);
            if (Float.isNaN(s) || Float.isInfinite(s)) {
                return Boolean.FALSE;
            }
            v.speed = s;
            v.lockSpeed = s;
            v.speedLocked = true;
            return Boolean.TRUE;
        });

        // speed(e) → px/s
        api.addMethod(ns, "speed", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            return Double.valueOf(v == null ? 0d : v.speed);
        });

        // heading(e) → 度（0 = 朝右，顺时针为正，与 rotation 同一套）
        api.addMethod(ns, "heading", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            return Double.valueOf(v == null ? 0d : Math.toDegrees(v.heading));
        });

        // damage(e, n) → 0..1
        api.addMethod(ns, "damage", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            if (v == null) {
                return Double.valueOf(0d);
            }
            Object n = ScriptJs.arg(args, 1);
            if (ScriptJs.isMissing(n)) {
                return Double.valueOf(v.damage);
            }
            v.damage = clamp01(v.damage + ScriptJs.fnum(n, 0f));
            return Double.valueOf(v.damage);
        });

        // followRoad(e, opts) → bool（沿路网自动驾驶到某节点）
        api.addMethod(ns, "followRoad", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            if (v == null) {
                return Boolean.FALSE;
            }
            Object target = ScriptJs.arg(args, 1);
            String toId = "";
            if (target instanceof String) {
                toId = (String) target;
            } else {
                Object id = ScriptJs.get(target, "id");
                if (id instanceof String) {
                    toId = (String) id;
                } else {
                    Object tx = ScriptJs.get(target, "x");
                    if (!ScriptJs.isMissing(tx)) {
                        ScriptRoad road = ScriptRoad.LAST;
                        if (road != null) {
                            float px = ScriptJs.fnum(tx, 0f);
                            float py = ScriptJs.fnum(ScriptJs.get(target, "y"), 0f);
                            toId = road.nearestId(px, py);
                        }
                    }
                }
            }
            if (!buildRoute(v, toId)) {
                return Boolean.FALSE;
            }
            v.autoDrive = true;
            v.parked = false;
            v.throttle = 0f;
            v.brake = 0f;
            v.steer = 0f;
            // 到达回调（一次性；不传则清掉旧回调，避免上一条路线的回调被误触发）
            Function f = ScriptJs.fnArg(ScriptJs.get(ScriptJs.arg(args, 2), "onArrive"));
            v.onArrive = f;
            v.onArriveDef = f == null ? null : engine.def(engine.currentScriptName());
            return Boolean.TRUE;
        });

        // stop(e) —— 停车：取消自动驾驶与路线、油门/制动归零并驻车（平滑减速到 0，不倒车）
        api.addMethod(ns, "stop", (cx, thisObj, args) -> {
            Veh v = vehicles.get(api.actorOf(ScriptJs.arg(args, 0)));
            if (v == null) {
                return Boolean.FALSE;
            }
            v.throttle = 0f;
            v.brake = 0f;
            v.steer = 0f;
            v.autoDrive = false;
            v.route = null;
            v.nextNodeSlot = -1;
            v.parked = true;
            return Boolean.TRUE;
        });

        // count()
        api.addMethod(ns, "count", (cx, thisObj, args) -> Integer.valueOf(vehicles.size()));

        // on(evt, fn) / off(fn)
        api.addMethod(ns, "on", (cx, thisObj, args) -> {
            String evt = ScriptJs.str(ScriptJs.arg(args, 0), "");
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 1));
            if (f == null || !isKnownEvent(evt)) {
                return null;
            }
            List<Holder> list = handlers.get(evt);
            if (list == null) {
                list = new ArrayList<Holder>();
                handlers.put(evt, list);
            }
            list.add(new Holder(f, engine.def(engine.currentScriptName())));
            return f;
        });
        api.addMethod(ns, "off", (cx, thisObj, args) -> {
            Function f = ScriptJs.fnArg(ScriptJs.arg(args, 0));
            if (f == null) {
                return Boolean.FALSE;
            }
            for (List<Holder> list : handlers.values()) {
                for (int i = list.size() - 1; i >= 0; i--) {
                    if (list.get(i).fn == f) {
                        list.remove(i);
                        return Boolean.TRUE;
                    }
                }
            }
            return Boolean.FALSE;
        });
    }

    private static boolean isKnownEvent(String evt) {
        return "crash".equals(evt) || "hijack".equals(evt)
                || "enter".equals(evt) || "exit".equals(evt) || "arrive".equals(evt);
    }

    // ---------------- 造车 / 上下车 ----------------

    private Actor spawnVehicle(Object opts) {
        Object kind = ScriptJs.get(opts, "kind");
        String k = ScriptJs.str(kind, "car");
        Object x = ScriptJs.get(opts, "x");
        Object y = ScriptJs.get(opts, "y");
        float px = ScriptJs.fnum(x, 0f);
        float py = ScriptJs.fnum(y, 0f);
        Actor a = api.spawnActor(opts);
        if (a == null) {
            return null;
        }
        Veh v = new Veh(nextId++, a);
        v.kind = k;
        v.speedLimit = ScriptJs.fnum(ScriptJs.get(opts, "speedLimit"), 260f);
        Object h = ScriptJs.get(opts, "heading");
        v.heading = ScriptJs.isMissing(h) ? 0f : (float) Math.toRadians(ScriptJs.fnum(h, 0f));
        vehicles.put(a, v);
        return a;
    }

    private void tickVehicles(float dt) {
        if (vehicles.isEmpty()) {
            return;
        }
        List<Actor> gone = new ArrayList<Actor>();
        for (Map.Entry<Actor, Veh> e : vehicles.entrySet()) {
            Actor a = e.getKey();
            Veh v = e.getValue();
            if (a == null || a.dead) {
                gone.add(a);
                continue;
            }
            // 被销毁前若还有驾驶员，先派发 exit（否则驾驶员卡在僵尸车里）
            updateVehicle(v, dt);
        }
        for (int i = 0; i < gone.size(); i++) {
            Actor a = gone.get(i);
            Veh v = vehicles.remove(a);
            if (v != null && v.driver != null) {
                driving.remove(v.driver);
                fire("exit", v, v.driver);
            }
        }
    }

    /**
     * 单车一帧的推进。
     *
     * <p>模型刻意简单（街机式），因为任务书 §18 要的是"能开、能转、能撞、能上下车"，
     * 不是车辆物理仿真：
     * <pre>
     *   目标速度 = throttle × speedLimit − brake × speedLimit
     *   速度向目标速度线性逼近（accel = 320 px/s²）
     *   自动驾驶时：朝下一个路网节点修正 heading（转向受最大转向速率限制）
     *   位置 += heading 方向 × 速度 × dt
     * </pre>
     */
    private void updateVehicle(Veh v, float dt) {
        Actor a = v.actor;
        if (v.autoDrive && v.route != null) {
            autoStep(v, dt);
        } else {
            v.autoDrive = false;
            manualStep(v, dt);
        }
        // setSpeed 只锁一帧：本帧按 lockSpeed 走（覆盖本帧加减速结果），下一帧恢复正常加减速
        if (v.speedLocked) {
            v.speed = v.lockSpeed;
            v.speedLocked = false;
        }

        if (Math.abs(v.speed) > 0.01f) {
            float dx = (float) Math.cos(v.heading) * v.speed * dt;
            float dy = (float) Math.sin(v.heading) * v.speed * dt;
            a.x += dx;
            a.y += dy;
            a.o.rotation = (float) Math.toDegrees(v.heading);
            // 地图边界夹取（车辆不能飞出世界）
            float margin = Math.max(8f, Math.min(a.o.halfW, a.o.halfH));
            a.x = Math.max(margin, Math.min(host.mapWidth() - margin, a.x));
            a.y = Math.max(margin, Math.min(host.mapHeight() - margin, a.y));
        }
        // 驾驶员跟随车辆（视觉上人坐在车里）
        if (v.driver != null && !v.driver.dead) {
            v.driver.x = a.x;
            v.driver.y = a.y;
        }
        // 高速撞击损伤（简化：速度 > 限速 1.2 倍时累计损伤）
        if (Math.abs(v.speed) > v.speedLimit * 1.2f && v.damage < 1f) {
            v.damage = clamp01(v.damage + 0.25f * dt);
        }
    }

    // ---------------- 手感参数（px/s、px/s²）----------------
    /** 手动油门加速度。 */
    private static final float ACCEL = 260f;
    /** 手动制动减速度（brake=1 时）。 */
    private static final float BRAKE_DECEL = 600f;
    /** 松油门滑行阻力。 */
    private static final float COAST_DRAG = 140f;
    /** 驻车（下车 / stop / 到站）减速度。 */
    private static final float PARK_DECEL = 500f;
    /** 倒车：最高 = speedLimit × 0.3，加速度。 */
    private static final float REVERSE_FRAC = 0.3f;
    private static final float REVERSE_ACCEL = 200f;
    /** 手动转向：满速率 135°/s，|v| ≥ 80 px/s 时达到，0 速时不能转。 */
    private static final float STEER_RATE = (float) Math.toRadians(135f);
    private static final float STEER_FULL_SPEED = 80f;
    /** 自动驾驶：加速 / 常规减速 / 急刹（brake ≥ 0.99）/ 规划减速度（弯前、到站的提前量按它算）。 */
    private static final float AUTO_ACCEL = 200f;
    private static final float AUTO_DECEL = 450f;
    private static final float HARD_BRAKE = 700f;
    private static final float PLAN_DECEL = 260f;
    /** 自动驾驶最大转向角速度与最小转弯半径（角速度上限 = min(150°/s, |v| / 18px)）。 */
    private static final float AUTO_MAX_YAW = (float) Math.toRadians(150f);
    private static final float AUTO_MIN_RADIUS = 18f;
    /** 比例转向增益（1/s）。 */
    private static final float AUTO_GAIN = 5f;

    // 路点 float[] 布局
    private static final int P_X = 0;
    private static final int P_Y = 1;
    /** 通向该点的路段限速。 */
    private static final int P_LIMIT = 2;
    /** 建议通过速度（弯道 / 终点 = 0）。 */
    private static final int P_ADV = 3;
    /** 到达该点时的行进方向（过面判定用）。 */
    private static final int P_DX = 4;
    private static final int P_DY = 5;
    /** ≥0：通过该点即视为通过了路线第 k 个节点。 */
    private static final int P_NODE = 6;
    private static final int P_SIZE = 7;

    private static float approach(float cur, float target, float maxStep) {
        if (cur < target) {
            return Math.min(target, cur + maxStep);
        }
        return Math.max(target, cur - maxStep);
    }

    /**
     * 手动驾驶一帧（无路线时）。
     * <ul>
     *   <li>驻车：以 {@link #PARK_DECEL} 减到 0，不倒车；</li>
     *   <li>brake&gt;0：前进中制动；速度 ≤ 0.5 且有驾驶员 → 倒车（最高 speedLimit×0.3）；无驾驶员只刹停；</li>
     *   <li>throttle&gt;0：加速到 throttle×speedLimit；</li>
     *   <li>都没有：滑行阻力减到 0。</li>
     * </ul>
     * 转向速率 = 135°/s × min(1, |v|/80)，倒车时方向取反。
     */
    private void manualStep(Veh v, float dt) {
        float limit = Math.max(1f, v.speedLimit);
        float s = v.speed;
        if (v.parked) {
            s = approach(s, 0f, PARK_DECEL * dt);
        } else if (v.brake > 0f) {
            boolean canReverse = v.driver != null && !v.driver.dead;
            if (s > 0.5f || !canReverse) {
                s = approach(s, 0f, BRAKE_DECEL * Math.max(0.3f, v.brake) * dt);
            } else {
                float rev = -v.brake * limit * REVERSE_FRAC;
                s = approach(s, rev, (s > rev ? REVERSE_ACCEL : BRAKE_DECEL) * dt);
            }
        } else if (v.throttle > 0f) {
            float tgt = v.throttle * limit;
            float rate = s < 0f ? BRAKE_DECEL : (s < tgt ? ACCEL : COAST_DRAG * 2f);
            s = approach(s, tgt, rate * dt);
        } else {
            s = approach(s, 0f, COAST_DRAG * dt);
        }
        v.speed = s;
        if (v.steer != 0f && Math.abs(s) > 0.01f) {
            float rate = STEER_RATE * Math.min(1f, Math.abs(s) / STEER_FULL_SPEED);
            v.heading += v.steer * rate * (s >= 0f ? 1f : -1f) * dt;
        }
    }

    /**
     * 自动驾驶一帧：过点判定 → 目标速度（限速 / 弯前减速 / 到站刹停曲线 × (1−brake)）→ 追踪式比例转向。
     */
    private void autoStep(Veh v, float dt) {
        Actor a = v.actor;
        List<float[]> r = v.route;
        // 1) 过点：到达半径 max(16, |v|·0.25)，或已越过该点的法平面（dot(wp−car, dir) < 0）
        while (v.routeIndex < r.size()) {
            float[] p = r.get(v.routeIndex);
            float dx = p[P_X] - a.x;
            float dy = p[P_Y] - a.y;
            float d = (float) Math.sqrt(dx * dx + dy * dy);
            boolean last = v.routeIndex == r.size() - 1;
            float radius = last ? 8f : Math.max(16f, Math.abs(v.speed) * 0.25f);
            boolean passed = dx * p[P_DX] + dy * p[P_DY] < 0f;
            // 兜底：绕着一个点转了 270° 还没到 → 视为够不着，跳过（绝不原地打转）
            boolean stuck = v.turnAccum > (float) (Math.PI * 1.5);
            if (d < radius || passed || stuck) {
                int node = (int) p[P_NODE];
                if (node >= 0) {
                    v.lastNodeId = v.nodeIds[node];
                    v.nextNodeSlot = node + 1 < v.nodeIds.length ? node + 1 : -1;
                }
                v.routeIndex++;
                v.turnAccum = 0f;
                continue;
            }
            break;
        }
        if (v.routeIndex >= r.size()) {
            finishRoute(v);
            return;
        }

        // 2) 目标速度
        int idx = v.routeIndex;
        float[] cur = r.get(idx);
        float limit = Math.min(v.speedLimit, cur[P_LIMIT]);
        v.edgeLimit = cur[P_LIMIT];
        float cdx = cur[P_X] - a.x;
        float cdy = cur[P_Y] - a.y;
        float d0 = (float) Math.sqrt(cdx * cdx + cdy * cdy);
        float target = limit;
        float base = v.cum[idx];
        for (int j = idx; j < r.size(); j++) {
            float dj = d0 + (v.cum[j] - base);
            if (dj > 700f) {
                break;
            }
            float adv = Math.min(r.get(j)[P_ADV], v.speedLimit);
            float allow = (float) Math.sqrt(adv * adv + 2f * PLAN_DECEL * Math.max(0f, dj - 4f));
            if (allow < target) {
                target = allow;
            }
        }

        // 3) 追踪点：沿路线折线前视 L = max(28, |v|·0.35)
        float look = Math.max(28f, Math.abs(v.speed) * 0.35f);
        float px = a.x;
        float py = a.y;
        float rem = look;
        float ax = cur[P_X];
        float ay = cur[P_Y];
        for (int j = idx; j < r.size(); j++) {
            float[] q = r.get(j);
            float sx = q[P_X] - px;
            float sy = q[P_Y] - py;
            float sl = (float) Math.sqrt(sx * sx + sy * sy);
            if (sl >= rem && sl > 1e-4f) {
                ax = px + sx * rem / sl;
                ay = py + sy * rem / sl;
                break;
            }
            rem -= sl;
            px = q[P_X];
            py = q[P_Y];
            ax = px;
            ay = py;
        }
        float err = normalizeAngle((float) Math.atan2(ay - a.y, ax - a.x) - v.heading);
        if (Math.abs(err) > (float) Math.toRadians(60f)) {
            // 车头偏得很大（刚生成朝向不对 / 被撞歪）：先慢下来再转，转弯半径小
            target = Math.min(target, 0.35f * limit);
        }
        boolean hard = v.brake >= 0.99f;
        if (hard) {
            target = 0f;
        } else if (v.brake > 0f) {
            target *= (1f - v.brake);
        }
        float s = v.speed;
        float rate = s < target ? AUTO_ACCEL : (hard ? HARD_BRAKE : AUTO_DECEL);
        s = approach(s, target, rate * dt);
        v.speed = s;

        // 4) 比例转向（有上限，0 速不转）
        float cap = Math.min(AUTO_MAX_YAW, Math.abs(s) / AUTO_MIN_RADIUS);
        float w = Math.max(-cap, Math.min(cap, AUTO_GAIN * err));
        v.heading += w * dt;
        v.turnAccum += Math.abs(w * dt);
    }

    /** 路线走完：驻车（平滑刹停）、派发 arrive、调用一次性的 onArrive。 */
    private void finishRoute(Veh v) {
        if (v.nodeIds != null && v.nodeIds.length > 0) {
            v.lastNodeId = v.nodeIds[v.nodeIds.length - 1];
        }
        v.autoDrive = false;
        v.route = null;
        v.nextNodeSlot = -1;
        v.parked = true;
        v.throttle = 0f;
        v.steer = 0f;
        Function f = v.onArrive;
        v.onArrive = null;
        v.onArriveDef = null;
        fire("arrive", v, v.driver);
        if (f != null) {
            invokeArrive(v, f);
        }
    }

    // ---------------- 路线几何（右侧车道 + 路口弧线）----------------

    private GameData.RtRoadNetwork geoNet;
    private final Map<String, GameData.RtRoadNode> geoNodes = new HashMap<String, GameData.RtRoadNode>();
    private final Map<String, List<GameData.RtRoadEdge>> geoIncident =
            new HashMap<String, List<GameData.RtRoadEdge>>();
    private final Map<String, GameData.RtRoadEdge> geoDirected = new HashMap<String, GameData.RtRoadEdge>();

    private static String edgeKey(String a, String b) {
        return a + "\u0001" + b;
    }

    /** 从 {@code host.scene.road} 建几何索引（每个场景一次）。 */
    private boolean ensureGeo() {
        GameData.RtScene sc = host.scene;
        GameData.RtRoadNetwork net = sc == null ? null : sc.road;
        if (net != geoNet) {
            geoNet = net;
            geoNodes.clear();
            geoIncident.clear();
            geoDirected.clear();
            if (net != null) {
                for (int i = 0; i < net.nodes.size(); i++) {
                    GameData.RtRoadNode nd = net.nodes.get(i);
                    if (nd.id != null && !nd.id.isEmpty()) {
                        geoNodes.put(nd.id, nd);
                    }
                }
                for (int i = 0; i < net.edges.size(); i++) {
                    GameData.RtRoadEdge e = net.edges.get(i);
                    if (!geoNodes.containsKey(e.from) || !geoNodes.containsKey(e.to)) {
                        continue;
                    }
                    incident(e.from).add(e);
                    if (!e.to.equals(e.from)) {
                        incident(e.to).add(e);
                    }
                    geoDirected.put(edgeKey(e.from, e.to), e);
                    if (!e.oneway) {
                        geoDirected.putIfAbsent(edgeKey(e.to, e.from), e);
                    }
                }
            }
        }
        return !geoNodes.isEmpty();
    }

    private List<GameData.RtRoadEdge> incident(String id) {
        List<GameData.RtRoadEdge> l = geoIncident.get(id);
        if (l == null) {
            l = new ArrayList<GameData.RtRoadEdge>();
            geoIncident.put(id, l);
        }
        return l;
    }

    private static float segDist(float x, float y, float ax, float ay, float bx, float by) {
        float dx = bx - ax;
        float dy = by - ay;
        float l2 = dx * dx + dy * dy;
        float t = l2 < 1e-6f ? 0f : ((x - ax) * dx + (y - ay) * dy) / l2;
        t = t < 0f ? 0f : (t > 1f ? 1f : t);
        float qx = ax + dx * t - x;
        float qy = ay + dy * t - y;
        return (float) Math.sqrt(qx * qx + qy * qy);
    }

    private float edgeWidth(GameData.RtRoadEdge e) {
        return e == null ? 48f : Math.max(8f, e.width);
    }

    private float edgeLimit(GameData.RtRoadEdge e) {
        return e == null ? 240f : Math.max(1f, e.speedLimit);
    }

    /** 点是否在节点 id 周围任一路段的路面内（留 margin）。 */
    private boolean insideRoadAt(String id, float x, float y, float margin) {
        List<GameData.RtRoadEdge> list = geoIncident.get(id);
        if (list == null) {
            return true;
        }
        for (int i = 0; i < list.size(); i++) {
            GameData.RtRoadEdge e = list.get(i);
            GameData.RtRoadNode a = geoNodes.get(e.from);
            GameData.RtRoadNode b = geoNodes.get(e.to);
            if (segDist(x, y, a.x, a.y, b.x, b.y) <= edgeWidth(e) * 0.5f - margin) {
                return true;
            }
        }
        return false;
    }

    /** 停止线距离：横穿道路的半宽（不含驶入路段本身）；死路端点给个小值。 */
    private float stopDistance(String nodeId, GameData.RtRoadEdge in, float inLen) {
        float w = 0f;
        List<GameData.RtRoadEdge> list = geoIncident.get(nodeId);
        if (list != null) {
            for (int i = 0; i < list.size(); i++) {
                GameData.RtRoadEdge e = list.get(i);
                if (e != in) {
                    w = Math.max(w, edgeWidth(e));
                }
            }
        }
        float d = w > 0f ? w * 0.5f : 16f;
        return Math.max(0f, Math.min(d, inLen * 0.45f));
    }

    private static float[] pt(float x, float y, float limit, float adv, float dx, float dy, int node) {
        float[] p = new float[P_SIZE];
        p[P_X] = x;
        p[P_Y] = y;
        p[P_LIMIT] = limit;
        p[P_ADV] = adv;
        float l = (float) Math.sqrt(dx * dx + dy * dy);
        p[P_DX] = l < 1e-6f ? 0f : dx / l;
        p[P_DY] = l < 1e-6f ? 0f : dy / l;
        p[P_NODE] = node;
        return p;
    }

    /**
     * 建路线：节点序列 → 右侧车道点 + 路口弧线采样点。
     *
     * <p>起点：车离所有节点 &gt; 12px（在路段中间）时取车所在路段<b>车头方向</b>的端点出发，
     * 路线 = [车后节点, 车前节点, …, 目标]（车后节点只用来确定第一段方向，不开回去）；
     * 否则从最近节点出发。终点停在目标节点的停止线（离节点中心 ≈ 横穿道路半宽）上。</p>
     */
    private boolean buildRoute(Veh v, String toId) {
        ScriptRoad road = ScriptRoad.LAST;
        if (road == null || !road.hasData() || toId == null || toId.isEmpty() || !ensureGeo()
                || !geoNodes.containsKey(toId)) {
            return false;
        }
        float cx = v.actor.x;
        float cy = v.actor.y;
        GameData.RtRoadNode nearest = geoNodes.get(road.nearestId(cx, cy));
        if (nearest == null) {
            return false;
        }
        List<String> nodes = new ArrayList<String>();
        boolean midEdge = false;
        float ndx = nearest.x - cx;
        float ndy = nearest.y - cy;
        if (ndx * ndx + ndy * ndy > 12f * 12f) {
            GameData.RtRoadEdge best = null;
            float bestD = Float.MAX_VALUE;
            for (int i = 0; i < geoNet.edges.size(); i++) {
                GameData.RtRoadEdge e = geoNet.edges.get(i);
                GameData.RtRoadNode ea = geoNodes.get(e.from);
                GameData.RtRoadNode eb = geoNodes.get(e.to);
                if (ea == null || eb == null || ea == eb) {
                    continue;
                }
                float d = segDist(cx, cy, ea.x, ea.y, eb.x, eb.y);
                // 路口附近多条路段距离相近时，优先和车头方向平行的那条
                float exl = Math.max(1e-3f, (float) Math.hypot(eb.x - ea.x, eb.y - ea.y));
                float align = Math.abs(((eb.x - ea.x) * (float) Math.cos(v.heading)
                        + (eb.y - ea.y) * (float) Math.sin(v.heading)) / exl);
                d += (1f - align) * 12f;
                if (d < bestD) {
                    bestD = d;
                    best = e;
                }
            }
            if (best != null && bestD <= edgeWidth(best)) {
                GameData.RtRoadNode ea = geoNodes.get(best.from);
                GameData.RtRoadNode eb = geoNodes.get(best.to);
                float hx = (float) Math.cos(v.heading);
                float hy = (float) Math.sin(v.heading);
                boolean towardTo = (eb.x - ea.x) * hx + (eb.y - ea.y) * hy >= 0f;
                String ahead = towardTo ? best.to : best.from;
                String behind = towardTo ? best.from : best.to;
                List<String> ids = road.findRoute(ahead, toId);
                if (ids.isEmpty()) {
                    return false;
                }
                nodes.add(behind);
                nodes.addAll(ids);
                midEdge = true;
            }
        }
        if (!midEdge) {
            List<String> ids = road.findRoute(nearest.id, toId);
            if (ids.isEmpty()) {
                return false;
            }
            nodes.addAll(ids);
        }

        int n = nodes.size();
        String[] nid = new String[n];
        float[] nx = new float[n];
        float[] ny = new float[n];
        float[] nstop = new float[n];
        float[] ndirX = new float[n];
        float[] ndirY = new float[n];
        for (int i = 0; i < n; i++) {
            GameData.RtRoadNode nd = geoNodes.get(nodes.get(i));
            if (nd == null) {
                return false;
            }
            nid[i] = nd.id;
            nx[i] = nd.x;
            ny[i] = nd.y;
        }
        List<float[]> pts = new ArrayList<float[]>();
        for (int i = 0; i < n; i++) {
            if (i == 0) {
                if (midEdge || n == 1) {
                    continue;
                }
                // 从节点上出发：先到出口车道点
                GameData.RtRoadEdge out = geoDirected.get(edgeKey(nid[0], nid[1]));
                float ox = nx[1] - nx[0];
                float oy = ny[1] - ny[0];
                float ol = Math.max(1e-3f, (float) Math.sqrt(ox * ox + oy * oy));
                ox /= ol;
                oy /= ol;
                float off = edgeWidth(out) * 0.25f;
                // 从节点中心并入右车道：并线距离越长转角越小（48px 侧移 / 160px ≈ 17°）
                float s0 = Math.min(160f, ol * 0.4f);
                pts.add(pt(nx[0] + ox * s0 - oy * off, ny[0] + oy * s0 + ox * off,
                        edgeLimit(out), edgeLimit(out), ox, oy, -1));
                continue;
            }
            GameData.RtRoadEdge in = geoDirected.get(edgeKey(nid[i - 1], nid[i]));
            float ix = nx[i] - nx[i - 1];
            float iy = ny[i] - ny[i - 1];
            float il = Math.max(1e-3f, (float) Math.sqrt(ix * ix + iy * iy));
            ix /= il;
            iy /= il;
            ndirX[i] = ix;
            ndirY[i] = iy;
            float wIn = edgeWidth(in);
            float limIn = edgeLimit(in);
            float offIn = wIn * 0.25f;
            nstop[i] = stopDistance(nid[i], in, il);
            if (i == n - 1) {
                // 终点：停在停止线上（右侧车道）
                float sd = nstop[i];
                pts.add(pt(nx[i] - ix * sd - iy * offIn, ny[i] - iy * sd + ix * offIn,
                        limIn, 0f, ix, iy, i));
                break;
            }
            GameData.RtRoadEdge out = geoDirected.get(edgeKey(nid[i], nid[i + 1]));
            float ox = nx[i + 1] - nx[i];
            float oy = ny[i + 1] - ny[i];
            float ol = Math.max(1e-3f, (float) Math.sqrt(ox * ox + oy * oy));
            ox /= ol;
            oy /= ol;
            addJunction(pts, i, nid[i], nx[i], ny[i], ix, iy, il, wIn, limIn, ox, oy, ol,
                    edgeWidth(out), edgeLimit(out));
        }

        v.route = pts;
        v.routeIndex = 0;
        v.turnAccum = 0f;
        v.nodeIds = nid;
        v.nodeX = nx;
        v.nodeY = ny;
        v.nodeStop = nstop;
        v.nodeDirX = ndirX;
        v.nodeDirY = ndirY;
        v.nextNodeSlot = n > 1 ? 1 : -1;
        v.lastNodeId = nid[0];
        v.routeStartX = cx;
        v.routeStartY = cy;
        float[] cum = new float[pts.size()];
        float qx = cx;
        float qy = cy;
        float acc = 0f;
        for (int j = 0; j < pts.size(); j++) {
            float[] p = pts.get(j);
            float dx = p[P_X] - qx;
            float dy = p[P_Y] - qy;
            acc += (float) Math.sqrt(dx * dx + dy * dy);
            cum[j] = acc;
            qx = p[P_X];
            qy = p[P_Y];
        }
        v.cum = cum;
        return true;
    }

    /**
     * 中间节点的路口轨迹（不开到节点中心、不掉头）：
     * <ul>
     *   <li>近直行（&lt;10°）：一个车道点；</li>
     *   <li>掉头（&gt;150°，只在路线本身要求时）：绕节点的半圆；</li>
     *   <li>其他：入口车道线与出口车道线的交点 C 为控制点的二次贝塞尔，切线长 t 从
     *       min(96, 两侧路段长 40%) 起按 0.85 缩小，直到整条弧都在路面内（留 8px）。</li>
     * </ul>
     * 转角 &gt; 30° 时建议速度降到限速的 35%~50%（同时不超过 √(400·R)）。
     */
    private void addJunction(List<float[]> pts, int slot, String id, float nX, float nY,
                             float ix, float iy, float il, float wIn, float limIn,
                             float ox, float oy, float ol, float wOut, float limOut) {
        float offIn = wIn * 0.25f;
        float offOut = wOut * 0.25f;
        float rinX = -iy;
        float rinY = ix;
        float routX = -oy;
        float routY = ox;
        float cos = Math.max(-1f, Math.min(1f, ix * ox + iy * oy));
        float cross = ix * oy - iy * ox;
        float angle = (float) Math.acos(cos);
        float lim = Math.min(limIn, limOut);
        if (angle < (float) Math.toRadians(10f)) {
            float off = (offIn + offOut) * 0.5f;
            float rx = (rinX + routX) * 0.5f;
            float ry = (rinY + routY) * 0.5f;
            pts.add(pt(nX + rx * off, nY + ry * off, lim, lim, ix, iy, slot));
            return;
        }
        if (angle > (float) Math.toRadians(150f)) {
            float off = Math.max(offIn, 12f);
            float adv = Math.min(0.3f * lim, Math.max(35f, (float) Math.sqrt(400f * off)));
            for (int k = 0; k <= 6; k++) {
                double phi = Math.PI * k / 6.0;
                float c = (float) Math.cos(phi);
                float s = (float) Math.sin(phi);
                float x = nX + rinX * off * c + ix * off * s;
                float y = nY + rinY * off * c + iy * off * s;
                // 切线方向
                float dx = -rinX * s + ix * c;
                float dy = -rinY * s + iy * c;
                pts.add(pt(x, y, lim, adv, dx, dy, k == 6 ? slot : -1));
            }
            return;
        }
        // 两条车道线：P + din·a 与 Q + dout·b 的交点
        float pX = nX + rinX * offIn;
        float pY = nY + rinY * offIn;
        float qX = nX + routX * offOut;
        float qY = nY + routY * offOut;
        float a = ((qX - pX) * oy - (qY - pY) * ox) / cross;
        float cX = pX + ix * a;
        float cY = pY + iy * a;
        float t = Math.max(10f, Math.min(96f, Math.min(il * 0.4f, ol * 0.4f)));
        float[] sx = new float[7];
        float[] sy = new float[7];
        while (true) {
            float eX = cX - ix * t;
            float eY = cY - iy * t;
            float xX = cX + ox * t;
            float xY = cY + oy * t;
            boolean ok = true;
            for (int k = 0; k <= 6; k++) {
                float u = k / 6f;
                float w0 = (1f - u) * (1f - u);
                float w1 = 2f * (1f - u) * u;
                float w2 = u * u;
                sx[k] = w0 * eX + w1 * cX + w2 * xX;
                sy[k] = w0 * eY + w1 * cY + w2 * xY;
                if (ok && !insideRoadAt(id, sx[k], sy[k], 8f)) {
                    ok = false;
                }
            }
            if (ok || t <= 10f) {
                break;
            }
            t = Math.max(10f, t * 0.85f);
        }
        float adv = lim;
        if (angle > (float) Math.toRadians(30f)) {
            float f = Math.min(1f, (angle - (float) Math.toRadians(30f)) / (float) Math.toRadians(60f));
            float k = 0.5f - 0.15f * f;
            adv = Math.min(k * lim, Math.max(45f, (float) Math.sqrt(400f * 0.707f * t)));
        }
        float eX = cX - ix * t;
        float eY = cY - iy * t;
        float xX = cX + ox * t;
        float xY = cY + oy * t;
        for (int k = 0; k <= 6; k++) {
            float u = k / 6f;
            // 贝塞尔切线 B'(u) = 2(1−u)(C−E) + 2u(X−C)
            float dx = 2f * (1f - u) * (cX - eX) + 2f * u * (xX - cX);
            float dy = 2f * (1f - u) * (cY - eY) + 2f * u * (xY - cY);
            pts.add(pt(sx[k], sy[k], k == 0 ? limIn : lim, adv, dx, dy, k == 6 ? slot : -1));
        }
    }

    private void invokeArrive(Veh v, Function fn) {
        try {
            Context cx = Context.getCurrentContext();
            if (cx == null) {
                return;
            }
            ScriptJs.Flex payload = (ScriptJs.Flex) api.newObj();
            ScriptJs.put(payload, "vehicle", api.entity(v.actor));
            ScriptJs.put(payload, "driver", v.driver == null ? null : api.entity(v.driver));
            fn.call(cx, scope, scope, new Object[]{payload});
        } catch (Throwable t) {
            host.scriptLog("[车辆] onArrive 异常: " + t);
        }
    }

    private static float normalizeAngle(float a) {
        while (a > Math.PI) {
            a -= (float) (Math.PI * 2);
        }
        while (a < -Math.PI) {
            a += (float) (Math.PI * 2);
        }
        return a;
    }

    boolean enterVehicle(Actor driver, Actor car) {
        Veh v = vehicles.get(car);
        if (v == null || driver == null || driver.dead) {
            return false;
        }
        // 已经被别人开着：先把他踢出来（避免一人卡两车）
        if (v.driver != null && v.driver != driver) {
            driving.remove(v.driver);
            fire("exit", v, v.driver);
        }
        // 一人只能开一辆：若他正开着别的车，先从那辆车上解绑
        Actor prevCar = driving.get(driver);
        if (prevCar != null && prevCar != car) {
            Veh pv = vehicles.get(prevCar);
            if (pv != null && pv.driver == driver) {
                pv.driver = null;
                pv.parked = true;
            }
        }
        v.driver = driver;
        driving.put(driver, car);
        // 不改 autoDrive / 路线 / 可见性：NPC 上车后可继续沿路行驶；玩家劫车走 hijack()
        v.throttle = 0f;
        v.brake = 0f;
        v.parked = false;
        fire("enter", v, driver);
        return true;
    }

    /** 车左侧（垂直车头方向，距离 halfH+12）放置下车的人。 */
    private static void placeLeft(Actor who, Actor car, Veh v) {
        float d = car.o.halfH + 12f;
        who.x = car.x + (float) Math.sin(v.heading) * d;
        who.y = car.y - (float) Math.cos(v.heading) * d;
    }

    boolean exitVehicle(Actor driver) {
        if (driver == null) {
            return false;
        }
        Actor car = driving.remove(driver);
        if (car == null) {
            return false;
        }
        Veh v = vehicles.get(car);
        if (v == null) {
            return false;
        }
        v.driver = null;
        v.throttle = 0f;
        v.brake = 0f;
        v.steer = 0f;
        v.autoDrive = false;
        v.route = null;
        v.nextNodeSlot = -1;
        v.parked = true;
        // 下车位置：车左侧（驾驶座一侧），垂直于车头，距离 halfH+12
        placeLeft(driver, car, v);
        fire("exit", v, driver);
        return true;
    }

    boolean hijack(Actor hijacker, Actor car) {
        Veh v = vehicles.get(car);
        if (v == null || hijacker == null) {
            return false;
        }
        Actor old = v.driver;
        if (old != null && old != hijacker) {
            driving.remove(old);
            // 原驾驶员被拽到车左侧（之后 enterVehicle 照旧再派发一次 exit，事件序列与旧版一致）并派发 hijack（游戏逻辑据此决定"受害者逃跑/报警"）
            placeLeft(old, car, v);
            fire("hijack", v, old);
        }
        // 劫车 = 接管：取消自动驾驶与路线、油门归零，再上车
        v.autoDrive = false;
        v.route = null;
        v.nextNodeSlot = -1;
        v.onArrive = null;
        v.onArriveDef = null;
        v.throttle = 0f;
        v.steer = 0f;
        return enterVehicle(hijacker, car);
    }

    // ---------------- 事件 ----------------

    private void fire(String evt, Veh v, Actor who) {
        List<Holder> list = handlers.get(evt);
        if (list == null || list.isEmpty()) {
            return;
        }
        try {
            Context cx = Context.getCurrentContext();
            if (cx == null) {
                return;
            }
            ScriptJs.Flex payload = (ScriptJs.Flex) api.newObj();
            ScriptJs.put(payload, "event", evt);
            ScriptJs.put(payload, "vehicle", api.entity(v.actor));
            ScriptJs.put(payload, "actor", who == null ? null : api.entity(who));
            ScriptJs.put(payload, "kind", v.kind);
            for (int i = 0; i < list.size(); i++) {
                Holder h = list.get(i);
                try {
                    h.fn.call(cx, scope, scope, new Object[]{payload});
                } catch (Throwable t) {
                    host.scriptLog("[车辆] " + evt + " 回调异常: " + t);
                }
            }
        } catch (Throwable t) {
            host.scriptLog("[车辆] 事件派发异常: " + t);
        }
    }

    private Scriptable vehObj(Veh v) {
        ScriptJs.Flex o = (ScriptJs.Flex) api.newObj();
        ScriptJs.put(o, "id", Double.valueOf(v.id));
        ScriptJs.put(o, "kind", v.kind);
        ScriptJs.put(o, "speed", Double.valueOf(v.speed));
        ScriptJs.put(o, "speedLimit", Double.valueOf(v.speedLimit));
        ScriptJs.put(o, "heading", Double.valueOf(Math.toDegrees(v.heading)));
        ScriptJs.put(o, "damage", Double.valueOf(v.damage));
        ScriptJs.put(o, "driver", v.driver == null ? null : api.entity(v.driver));
        ScriptJs.put(o, "autoDrive", Boolean.valueOf(v.autoDrive));
        ScriptJs.put(o, "routeIndex", Double.valueOf(v.routeIndex));
        ScriptJs.put(o, "routeLength", Double.valueOf(v.route == null ? 0 : v.route.size()));
        String next = "";
        String prev = v.lastNodeId == null ? "" : v.lastNodeId;
        double nextDist = -1d;
        boolean inJunction = false;
        if (v.route != null && v.nodeIds != null && v.nextNodeSlot >= 0 && v.nextNodeSlot < v.nodeIds.length) {
            int k = v.nextNodeSlot;
            next = v.nodeIds[k];
            if (k > 0) {
                prev = v.nodeIds[k - 1];
            }
            float dx = v.nodeX[k] - v.actor.x;
            float dy = v.nodeY[k] - v.actor.y;
            nextDist = Math.sqrt(dx * dx + dy * dy);
            // 进入路口 = 已越过该节点的停止线（沿驶入方向的投影距离 < 停止线距离）
            float along = dx * v.nodeDirX[k] + dy * v.nodeDirY[k];
            inJunction = (v.nodeDirX[k] != 0f || v.nodeDirY[k] != 0f) && along < v.nodeStop[k] - 2f;
        }
        ScriptJs.put(o, "nextNode", next);
        ScriptJs.put(o, "prevNode", prev);
        ScriptJs.put(o, "nextNodeDist", Double.valueOf(nextDist));
        ScriptJs.put(o, "inJunction", Boolean.valueOf(inJunction));
        ScriptJs.put(o, "parked", Boolean.valueOf(v.parked));
        ScriptJs.put(o, "brake", Double.valueOf(v.brake));
        ScriptJs.put(o, "throttle", Double.valueOf(v.throttle));
        return o;
    }

    private static float clamp01(float v) {
        return v < 0f ? 0f : (v > 1f ? 1f : v);
    }

    /** 车辆数（{@link ScriptDebug#stats()} 用）。 */
    int countValue() {
        return vehicles.size();
    }

    /** 场景卸载：清状态（车辆属于场景）。 */
    void clearSceneState() {
        vehicles.clear();
        driving.clear();
        handlers.clear();
        nextId = 1;
        geoNet = null;
        geoNodes.clear();
        geoIncident.clear();
        geoDirected.clear();
    }
}
