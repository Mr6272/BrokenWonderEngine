package Studio.runtime;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 车辆驾驶自检（无窗口、纯断言）：自动驾驶不打转 / 靠右车道 / 不出路面 / 到站停车，
 * 手动驾驶转向手感 / 倒车 / 滑行 / setSpeed，上下车与劫车的语义。
 *
 * <p>路网（y 向下，heading 0 = 东，90 = 南）：
 * <pre>
 *            N(800,100)
 *              |  街道 96
 *   A(200,400)--B(800,400)--C(1500,400)     大道 192（A–B–C）
 *              |  街道 96
 *            S(800,900)--E(1500,900)        S 为 L 形弯
 * </pre>
 * A→E 的路线 = A→B（直行）→ B 右转 → S 左转 → E，路线本身需要 180° 的转角。</p>
 */
public final class VehicleDrivingTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;
    private static ScriptEngine eng;

    /** 测试路网几何：{ax, ay, bx, by, width}。 */
    private static final float[][] EDGES = {
            {200, 400, 800, 400, 192},
            {800, 400, 1500, 400, 192},
            {800, 100, 800, 400, 96},
            {800, 400, 800, 900, 96},
            {800, 900, 1500, 900, 96},
    };

    private VehicleDrivingTest() {
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        int failures = 0;
        String fatal = null;
        try {
            run();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace();
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"vehicledriving caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        System.out.println("========== VehicleDrivingTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            System.out.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        System.out.println("------------------------------------");
        System.out.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }

    private static String js(String expr) {
        String r = eng.evalForTest("main", expr);
        return r == null ? "null" : r;
    }

    private static double num(String expr) {
        try {
            return Double.parseDouble(js(expr));
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    private static final float DT = 1f / 60f;

    private static void step(int frames) {
        for (int i = 0; i < frames; i++) {
            eng.update(DT);
        }
    }

    /** 车辆快照：x, y, heading(度), speed, autoDrive, nextNode, inJunction, parked。 */
    private static final class Snap {
        double x;
        double y;
        double h;
        double v;
        boolean auto;
        String next;
        boolean inJ;
        boolean parked;
    }

    private static Snap snap(String car) {
        String r = js("(function(c){var i=bwe.vehicle.of(c);return c.x+'|'+c.y+'|'+i.heading+'|'+i.speed+'|'"
                + "+i.autoDrive+'|'+i.nextNode+'|'+i.inJunction+'|'+i.parked;})(" + car + ")");
        String[] p = r.split("\\|", -1);
        Snap s = new Snap();
        if (p.length < 8) {
            s.x = s.y = s.h = s.v = Double.NaN;
            s.next = r;
            return s;
        }
        s.x = Double.parseDouble(p[0]);
        s.y = Double.parseDouble(p[1]);
        s.h = Double.parseDouble(p[2]);
        s.v = Double.parseDouble(p[3]);
        s.auto = "true".equals(p[4]);
        s.next = p[5];
        s.inJ = "true".equals(p[6]);
        s.parked = "true".equals(p[7]);
        return s;
    }

    private static double segDist(double x, double y, float[] e) {
        double dx = e[2] - e[0];
        double dy = e[3] - e[1];
        double l2 = dx * dx + dy * dy;
        double t = ((x - e[0]) * dx + (y - e[1]) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        double qx = e[0] + dx * t - x;
        double qy = e[1] + dy * t - y;
        return Math.sqrt(qx * qx + qy * qy);
    }

    /** 车中心超出路面的距离（≤0 = 在某条路的路面内）。 */
    private static double outside(double x, double y) {
        double best = Double.MAX_VALUE;
        for (float[] e : EDGES) {
            best = Math.min(best, segDist(x, y, e) - e[4] * 0.5);
        }
        return best;
    }

    private static double angDiff(double a, double b) {
        double d = a - b;
        while (d > 180) {
            d -= 360;
        }
        while (d < -180) {
            d += 360;
        }
        return d;
    }

    private static String f1(double v) {
        return String.valueOf(Math.round(v * 10) / 10.0);
    }

    // ---------------- 场景 ----------------

    private static void run() throws Exception {
        root = new File(".tmp_rel8/vehicledriving").getAbsoluteFile();
        deleteRecursively(root);
        buildProject();
        File boot = new File(root, "Build/boot.json");
        TopDownRuntime rt = new TopDownRuntime(boot);
        eng = rt.scripts;
        eng.update(0.02f);
        check("脚本引擎已启动", eng.started && !eng.failed, "");
        check("路网已加载", "true".equals(js("bwe.road.hasData()")), js("bwe.road.nodeCount()"));

        scenarioAutoDrive();
        scenarioMidEdgeStart();
        scenarioTwins();
        scenarioManual();
        scenarioHijack();
    }

    /** A → E：直行 + 路口右转 + L 弯左转；途中 brake(1) 停住再松开。 */
    private static void scenarioAutoDrive() {
        String ok = js("W.car = spawnAt(200, 400, 0); bwe.vehicle.followRoad(W.car, 'E', {onArrive:function(){W.cb++;}})");
        check("自动：followRoad(A→E) 返回 true", "true".equals(ok), ok);
        Snap prev = snap("W.car");
        double totalTurn = 0;
        double maxOut = -1e9;
        String maxOutAt = "";
        double latAB = 0;
        int nAB = 0;
        double latABmin = 1e9;
        double latBS = 0;
        int nBS = 0;
        double latBSmin = 1e9;
        double latSE = 0;
        int nSE = 0;
        double latSEmin = 1e9;
        double arriveT = -1;
        boolean sawJunction = false;
        Set<String> nextSeq = new LinkedHashSet<String>();
        double brakeSpeed = -1;
        boolean brakeAuto = false;
        double brakeMoved = -1;
        double bx0 = 0;
        double by0 = 0;
        int frames = 0;
        for (; frames < 60 * 40; frames++) {
            double t = frames * DT;
            if (frames == 90) {
                js("bwe.vehicle.brake(W.car, 1)");
            }
            if (frames == 150) {
                Snap s = snap("W.car");
                bx0 = s.x;
                by0 = s.y;
            }
            if (frames == 180) {
                Snap s = snap("W.car");
                brakeSpeed = s.v;
                brakeAuto = s.auto;
                brakeMoved = Math.hypot(s.x - bx0, s.y - by0);
                js("bwe.vehicle.brake(W.car, 0)");
            }
            eng.update(DT);
            Snap s = snap("W.car");
            totalTurn += Math.abs(angDiff(s.h, prev.h));
            double o = outside(s.x, s.y);
            if (o > maxOut) {
                maxOut = o;
                maxOutAt = "(" + f1(s.x) + "," + f1(s.y) + ")";
            }
            if (s.inJ) {
                sawJunction = true;
            }
            if (s.next != null && !s.next.isEmpty()) {
                nextSeq.add(s.next);
            }
            // 右侧车道：右法向 = (−dy, dx)
            if (s.x > 420 && s.x < 640 && Math.abs(s.y - 400) < 96) {
                double lat = s.y - 400;
                latAB += lat;
                nAB++;
                latABmin = Math.min(latABmin, lat);
            }
            if (s.y > 520 && s.y < 780 && Math.abs(s.x - 800) < 48) {
                double lat = -(s.x - 800);
                latBS += lat;
                nBS++;
                latBSmin = Math.min(latBSmin, lat);
            }
            if (s.x > 950 && s.x < 1350 && Math.abs(s.y - 900) < 48) {
                double lat = s.y - 900;
                latSE += lat;
                nSE++;
                latSEmin = Math.min(latSEmin, lat);
            }
            prev = s;
            if (arriveT < 0 && num("W.arrived") > 0) {
                arriveT = t + DT;
                break;
            }
        }
        check("自动：brake(1) 期间停住且保持自动驾驶", brakeSpeed >= 0 && brakeSpeed < 1 && brakeAuto && brakeMoved < 1,
                "speed=" + f1(brakeSpeed) + " auto=" + brakeAuto + " moved=" + f1(brakeMoved));
        check("自动：30 秒内到达终点（arrive 事件）", arriveT > 0 && arriveT < 30, "t=" + f1(arriveT) + "s");
        check("自动：onArrive 回调被调用一次", num("W.cb") == 1, "cb=" + js("W.cb"));
        check("自动：累计转角 ≈ 路线所需（150°..250°，路线 180° + 起点并入车道）", totalTurn >= 150 && totalTurn <= 250,
                "turn=" + f1(totalTurn) + "°");
        check("自动：全程车中心在路面内", maxOut <= 0, "maxOut=" + f1(maxOut) + " at " + maxOutAt);
        check("自动：A→B 大道靠右（偏移 ≈ +48）", nAB > 10 && latABmin > 0 && Math.abs(latAB / nAB - 48) < 10,
                "n=" + nAB + " avg=" + f1(nAB == 0 ? 0 : latAB / nAB) + " min=" + f1(latABmin));
        check("自动：B→S 街道靠右（偏移 ≈ +24）", nBS > 10 && latBSmin > 0 && Math.abs(latBS / nBS - 24) < 8,
                "n=" + nBS + " avg=" + f1(nBS == 0 ? 0 : latBS / nBS) + " min=" + f1(latBSmin));
        check("自动：S→E 街道靠右（偏移 ≈ +24）", nSE > 10 && latSEmin > 0 && Math.abs(latSE / nSE - 24) < 8,
                "n=" + nSE + " avg=" + f1(nSE == 0 ? 0 : latSE / nSE) + " min=" + f1(latSEmin));
        check("自动：of().nextNode 依次经过 B、S、E", nextSeq.toString().contains("B, S, E"), nextSeq.toString());
        check("自动：of().inJunction 在路口内为 true", sawJunction, "");
        step(60);
        Snap end = snap("W.car");
        check("自动：到站后平滑停在 E 的停止线（右车道）", Math.hypot(end.x - 1484, end.y - 924) < 24 && Math.abs(end.v) < 0.5,
                "pos=(" + f1(end.x) + "," + f1(end.y) + ") v=" + f1(end.v));
        check("自动：到站后 autoDrive=false 且驻车", !end.auto && end.parked, "auto=" + end.auto + " parked=" + end.parked);
        String again = js("bwe.vehicle.followRoad(W.car, 'E')");
        check("自动：已在终点再 followRoad 同一点不报错", "true".equals(again) || "false".equals(again), again);
    }

    /** 车在 C→B 路段中间朝西：从车头方向的 B 出发，不掉头。 */
    private static void scenarioMidEdgeStart() {
        step(30);
        String ok = js("W.mid = spawnAt(1150, 352, 180); W.midDone = 0;"
                + " bwe.vehicle.followRoad(W.mid, 'E', {onArrive:function(){ W.midDone++; }})");
        check("中段起步：followRoad 返回 true", "true".equals(ok), ok);
        Snap s0 = snap("W.mid");
        check("中段起步：nextNode = B（车头方向的端点）", "B".equals(s0.next), "next=" + s0.next);
        Snap prev = s0;
        double totalTurn = 0;
        double maxOut = -1e9;
        boolean wentEast = false;
        double t = -1;
        for (int i = 0; i < 60 * 40; i++) {
            eng.update(DT);
            Snap s = snap("W.mid");
            totalTurn += Math.abs(angDiff(s.h, prev.h));
            maxOut = Math.max(maxOut, outside(s.x, s.y));
            if (s.x > prev.x + 0.5 && s.y < 450) {
                wentEast = true;
            }
            prev = s;
            if (num("W.midDone") > 0) {
                t = (i + 1) * DT;
                break;
            }
        }
        check("中段起步：不掉头（在 B 之前从不向东开）", !wentEast, "");
        check("中段起步：累计转角 ≤ 250°（路线需要 180°）", totalTurn <= 250, "turn=" + f1(totalTurn) + "°");
        check("中段起步：全程在路面内", maxOut <= 0, "maxOut=" + f1(maxOut));
        check("中段起步：30 秒内到达", t > 0 && t < 30, "t=" + f1(t) + "s");
    }

    /** 两辆同起点同路线的车轨迹逐帧一致（无随机、无遍历顺序依赖）。 */
    private static void scenarioTwins() {
        js("W.t1 = spawnAt(200, 400, 0); W.t2 = spawnAt(200, 400, 0);"
                + " bwe.vehicle.followRoad(W.t1, 'N'); bwe.vehicle.followRoad(W.t2, 'N')");
        double maxDiff = 0;
        for (int i = 0; i < 60 * 8; i++) {
            eng.update(DT);
            Snap a = snap("W.t1");
            Snap b = snap("W.t2");
            maxDiff = Math.max(maxDiff, Math.hypot(a.x - b.x, a.y - b.y) + Math.abs(a.h - b.h));
        }
        Snap a = snap("W.t1");
        check("确定性：同输入两车轨迹完全一致", maxDiff == 0, "maxDiff=" + maxDiff);
        check("确定性：A→N 左转后到达 N 附近", Math.hypot(a.x - 776, a.y - 100) < 80 || Math.abs(a.y - 148) < 40,
                "pos=(" + f1(a.x) + "," + f1(a.y) + ")");
    }

    private static void scenarioManual() {
        js("W.m = spawnAt(960, 1100, 0); W.P = bwe.world.find('玩家');");
        check("手动：玩家上车", "true".equals(js("bwe.vehicle.enter(W.P, W.m)")), "");
        Snap s0 = snap("W.m");
        for (int i = 0; i < 30; i++) {
            js("bwe.vehicle.steer(W.m, 1)");
            eng.update(DT);
        }
        Snap s1 = snap("W.m");
        check("手动：0 速时打方向不转", Math.abs(s1.h - s0.h) < 0.01, "dh=" + f1(s1.h - s0.h));

        js("bwe.vehicle.setSpeed(W.m, 240)");
        double h0 = s1.h;
        double vmin = 1e9;
        for (int i = 0; i < 60; i++) {
            js("bwe.vehicle.throttle(W.m, 1); bwe.vehicle.steer(W.m, 1)");
            eng.update(DT);
            vmin = Math.min(vmin, snap("W.m").v);
        }
        Snap s2 = snap("W.m");
        double turned = s2.h - h0;
        check("手动：240px/s 满油满舵 1 秒转 ≥ 90°（≤150°）", turned >= 90 && turned <= 150,
                "turn=" + f1(turned) + "° vmin=" + f1(vmin));
        check("手动：右舵 = 顺时针（heading 增大）", turned > 0, "");

        js("bwe.vehicle.throttle(W.m, 0); bwe.vehicle.steer(W.m, 0)");
        step(60);
        Snap s3 = snap("W.m");
        check("手动：松油门滑行减速（1 秒约 −140）", s3.v > 60 && s3.v < 140, "v=" + f1(s3.v));

        for (int i = 0; i < 90; i++) {
            js("bwe.vehicle.brake(W.m, 1)");
            eng.update(DT);
        }
        Snap s4 = snap("W.m");
        check("手动：S 先刹停再倒车，倒车极速 = 30% 限速", s4.v <= -60 && s4.v >= -72.5, "v=" + f1(s4.v));
        double h4 = s4.h;
        for (int i = 0; i < 30; i++) {
            js("bwe.vehicle.brake(W.m, 1); bwe.vehicle.steer(W.m, 1)");
            eng.update(DT);
        }
        Snap s5 = snap("W.m");
        check("手动：倒车时转向反向", s5.h - h4 < -10, "dh=" + f1(s5.h - h4));

        js("bwe.vehicle.brake(W.m, 0); bwe.vehicle.steer(W.m, 0); bwe.vehicle.setSpeed(W.m, 150)");
        Snap a = snap("W.m");
        eng.update(DT);
        Snap b = snap("W.m");
        double moved = Math.hypot(b.x - a.x, b.y - a.y);
        check("setSpeed：锁定帧按设定速度移动（150/60 = 2.5px）", Math.abs(moved - 2.5) < 0.05 && b.v == 150,
                "moved=" + moved + " v=" + b.v);
        eng.update(DT);
        Snap c = snap("W.m");
        check("setSpeed：下一帧恢复正常物理（滑行减速）", c.v < 150 && c.v > 140, "v=" + f1(c.v));
        js("bwe.vehicle.setSpeed(W.m, 0)");
        Snap d0 = snap("W.m");
        eng.update(DT);
        Snap d1 = snap("W.m");
        check("setSpeed(0)：瞬停", Math.hypot(d1.x - d0.x, d1.y - d0.y) < 1e-6 && d1.v == 0, "v=" + d1.v);
        check("setSpeed：非车辆返回 false", "false".equals(js("bwe.vehicle.setSpeed(W.P, 10)")), "");

        String ex = js("(function(){ bwe.vehicle.exit(W.P); var c=W.m, p=W.P, h=bwe.vehicle.heading(c)*Math.PI/180;"
                + " var dx=p.x-c.x, dy=p.y-c.y; return (dx*Math.sin(h)-dy*Math.cos(h))+'|'+(dx*Math.cos(h)+dy*Math.sin(h));})()");
        String[] parts = ex.split("\\|");
        double left = parts.length == 2 ? Double.parseDouble(parts[0]) : Double.NaN;
        double fwd = parts.length == 2 ? Double.parseDouble(parts[1]) : Double.NaN;
        check("下车：人在车左侧 halfH+12 = 28px", Math.abs(left - 28) < 0.5 && Math.abs(fwd) < 0.5,
                "left=" + f1(left) + " fwd=" + f1(fwd));
        check("下车：车驻车", snap("W.m").parked, "");
        for (int i = 0; i < 30; i++) {
            js("bwe.vehicle.brake(W.m, 1)");
            eng.update(DT);
        }
        check("下车：无人车踩刹车不倒车", snap("W.m").v >= 0, "v=" + f1(snap("W.m").v));
    }

    private static void scenarioHijack() {
        js("W.h = spawnAt(200, 400, 0); bwe.vehicle.followRoad(W.h, 'C');"
                + " W.npc = bwe.world.spawn({x:200,y:400,name:'司机',kind:'ACTOR',halfW:10,halfH:10,tags:['npc']});"
                + " W.ev = [];");
        check("劫车：NPC 上车", "true".equals(js("bwe.vehicle.enter(W.npc, W.h)")), "");
        check("enter：不改变自动驾驶与路线", "true".equals(js("bwe.vehicle.of(W.h).autoDrive && bwe.vehicle.of(W.h).routeLength > 0")), "");
        step(60);
        Snap s = snap("W.h");
        check("enter：NPC 驾驶时继续沿路行驶", s.auto && s.v > 50, "v=" + f1(s.v));
        String r = js("bwe.vehicle.hijack(W.P, W.h)");
        check("劫车：hijack 返回 true", "true".equals(r), r);
        String info = js("(function(){var i=bwe.vehicle.of(W.h);return i.autoDrive+'|'+i.routeLength+'|'+i.throttle+'|'"
                + "+(bwe.vehicle.driver(W.h)===W.P)+'|'+W.ev.join(',');})()");
        check("劫车：取消自动驾驶与路线、油门归零、玩家为驾驶员", info.startsWith("false|0|0|true"), info);
        check("劫车：派发 hijack 事件", info.contains("hijack"), info);
        String side = js("(function(){var c=W.h,p=W.npc,h=bwe.vehicle.heading(c)*Math.PI/180;"
                + "return (p.x-c.x)*Math.sin(h)-(p.y-c.y)*Math.cos(h);})()");
        double left = Double.NaN;
        try {
            left = Double.parseDouble(side);
        } catch (NumberFormatException ignored) {
            // 断言里会报
        }
        check("劫车：原驾驶员被拽到车左侧 28px", Math.abs(left - 28) < 0.5, "left=" + side);
        js("bwe.vehicle.exit(W.P)");
    }

    // ---------------- 工程搭建 ----------------

    private static void buildProject() throws Exception {
        File build = new File(root, "Build");
        build.mkdirs();
        String boot = "{\n"
                + "  \"project\": \"vehicle-driving-test\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 0.8,\n"
                + "  \"scenes\": [ { \"name\": \"城\", \"file\": \"scene_0.json\", \"width\": 60, \"height\": 40 } ],\n"
                + "  \"scripts\": [ { \"name\": \"main\", \"file\": \"scripts/main.js\", \"lang\": \"js\" } ],\n"
                + "  \"assets\": []\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);
        String s0 = "{\n"
                + "  \"width\": 60, \"height\": 40, \"tileSize\": 32,\n"
                + "  \"onStartScript\": \"main\",\n"
                + "  \"objects\": [\n"
                + "    { \"id\":\"p1\", \"kind\":\"ACTOR\", \"name\":\"玩家\", \"x\":100, \"y\":1200, \"halfW\":12, \"halfH\":12, \"tags\":[\"玩家\",\"player\"] }\n"
                + "  ],\n"
                + "  \"roadNetwork\": {\n"
                + "    \"nodes\": [\n"
                + "      { \"id\":\"A\", \"x\":200, \"y\":400, \"kind\":\"waypoint\" },\n"
                + "      { \"id\":\"B\", \"x\":800, \"y\":400, \"kind\":\"intersection\" },\n"
                + "      { \"id\":\"C\", \"x\":1500, \"y\":400, \"kind\":\"waypoint\" },\n"
                + "      { \"id\":\"N\", \"x\":800, \"y\":100, \"kind\":\"waypoint\" },\n"
                + "      { \"id\":\"S\", \"x\":800, \"y\":900, \"kind\":\"waypoint\" },\n"
                + "      { \"id\":\"E\", \"x\":1500, \"y\":900, \"kind\":\"waypoint\" }\n"
                + "    ],\n"
                + "    \"edges\": [\n"
                + "      { \"from\":\"A\", \"to\":\"B\", \"width\":192, \"speedLimit\":240 },\n"
                + "      { \"from\":\"B\", \"to\":\"C\", \"width\":192, \"speedLimit\":240 },\n"
                + "      { \"from\":\"N\", \"to\":\"B\", \"width\":96, \"speedLimit\":180 },\n"
                + "      { \"from\":\"B\", \"to\":\"S\", \"width\":96, \"speedLimit\":180 },\n"
                + "      { \"from\":\"S\", \"to\":\"E\", \"width\":96, \"speedLimit\":180 }\n"
                + "    ]\n"
                + "  }\n"
                + "}\n";
        write(new File(build, "scene_0.json"), s0);
        String main = "var W = {arrived:0, cb:0, ev:[]};\n"
                + "function spawnAt(x, y, h) {\n"
                + "  return bwe.vehicle.spawn({x:x, y:y, name:'测试车', kind:'car', halfW:32, halfH:16,\n"
                + "    tags:['vehicle'], speedLimit:240, heading:h});\n"
                + "}\n"
                + "function onSceneStart(ctx) {\n"
                + "  bwe.vehicle.on('arrive', function(e){ W.arrived++; });\n"
                + "  bwe.vehicle.on('hijack', function(e){ W.ev.push('hijack'); });\n"
                + "  bwe.vehicle.on('enter', function(e){ W.ev.push('enter'); });\n"
                + "  bwe.vehicle.on('exit', function(e){ W.ev.push('exit'); });\n"
                + "}\n";
        write(new File(build, "scripts/main.js"), main);
    }

    private static void write(File f, String text) throws Exception {
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) {
            return;
        }
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) {
                deleteRecursively(k);
            }
        }
        f.delete();
    }
}
