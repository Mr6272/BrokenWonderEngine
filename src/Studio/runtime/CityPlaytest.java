package Studio.runtime;

import java.awt.event.KeyEvent;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 开放世界城市「真实引擎」试玩自检（无窗口）。
 *
 * <p>和 OpenWorldSoakTest 的区别：那个测试现场拼一个小场景；这个测试直接加载
 * {@code gen-city.ts → package-bwe.mjs} 打包出来的<b>真实城市</b>（Build/boot.json），
 * 往 {@code rt.keys[]} 注入按键、逐帧推进，用 {@link ScriptEngine#evalForTest} 读脚本状态，
 * 断言用户关心的玩法：墙不能穿、只能从门进、进楼屋顶消失、楼梯 E 换层、上层出不去、
 * E 劫车 / 驾驶 / E 下车、交通车不打转、NPC 逛街。
 *
 * <p>用法：{@code .\tools\bwe.ps1 run Studio.runtime.CityPlaytest <Build/boot.json>}
 */
public final class CityPlaytest {
    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static final float DT = 1f / 60f;
    private static TopDownRuntime rt;
    private static ScriptEngine eng;

    private CityPlaytest() {
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        String bootPath = args.length > 0 ? args[0] : ".tmp_rel8/openworld-e2e/Build/boot.json";
        String fatal = null;
        try {
            run(new File(bootPath));
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace();
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"playtest caught exception", "false", fatal});
        }
        int failures = 0;
        System.out.println("========== CityPlaytest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            if (!ok) {
                failures++;
            }
            System.out.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        System.out.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }

    // ---------------- 驱动 ----------------

    private static void step(int frames) {
        for (int i = 0; i < frames; i++) {
            eng.update(DT);
        }
    }

    private static void hold(int key, boolean down) {
        rt.keys[key] = down;
    }

    /** 按住若干键走 frames 帧，然后松开。 */
    private static void holdFor(int[] keys, int frames) {
        for (int k : keys) {
            hold(k, true);
        }
        step(frames);
        for (int k : keys) {
            hold(k, false);
        }
        step(1);
    }

    /** 点按一个键（按下 2 帧再松开 2 帧，保证脚本看到 pressed 边沿）。 */
    private static void tap(int key) {
        hold(key, true);
        step(2);
        hold(key, false);
        step(2);
    }

    private static String js(String script, String expr) {
        String r = eng.evalForTest(script, expr);
        return r == null ? "null" : r;
    }

    private static double num(String script, String expr) {
        String r = js(script, expr);
        try {
            return Double.parseDouble(r);
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    private static boolean bool(String script, String expr) {
        return "true".equals(js(script, expr));
    }

    /** 玩家脚本名（打包后可能是 "player" 或 "player.js"）。 */
    private static final String P = "player";
    private static final String W = "world";

    // ---------------- 场景 ----------------

    private static void run(File boot) throws Exception {
        if (!boot.isFile()) {
            check("boot.json 存在", false, boot.getAbsolutePath());
            return;
        }
        rt = new TopDownRuntime(boot);
        eng = rt.scripts;
        step(2);
        check("脚本已启动且未失败", eng.started && !eng.failed, "");
        String cityOk = js(P, "typeof CITY === 'object' && CITY.walls && CITY.walls.length > 0");
        check("player.js 能读到注入的 CITY", "true".equals(cityOk), cityOk);
        if (!"true".equals(cityOk)) {
            return;
        }
        // 预热 3 秒：人口生成、交通开起来
        step(180);

        // 外部提供的场景脚本（JS，跑在 player 作用域）：返回 JSON 报告。
        // 每一步的 setup（把玩家放到指定位置）在 JS 里做，按键在 Java 里注入。
        String sceneSpec = System.getProperty("playtest.scenario", "");
        if (!sceneSpec.isEmpty()) {
            String src = new String(Files.readAllBytes(new File(sceneSpec).toPath()), StandardCharsets.UTF_8);
            js(P, src);
        }

        scenarioWalls();
        scenarioBuilding();
        scenarioVehicle();
        scenarioTraffic();
        scenarioNpcs();
        scenarioLogs(boot);
    }

    private static String pxy() {
        return js(P, "Math.round(G.player.x)+','+Math.round(G.player.y)+' lv='+bwe.spatial.levelOf(G.player)");
    }

    /**
     * 墙：把玩家放到某栋楼外墙（非门洞段）外侧 20px，朝墙走 2 秒，断言没进楼。
     */
    private static void scenarioWalls() {
        // 选一栋 0 层建筑，取 outer 的北墙中点（避开门：如果门在北边就改用其他边）。
        String setup = js(P, ""
                + "(function(){"
                + " var b=null; for(var i=0;i<CITY.buildings.length;i++){var c=CITY.buildings[i];"
                + "  if(c.outer[2]>=96&&c.outer[3]>=96){b=c;break;}}"
                + " if(!b) return 'nobuilding';"
                + " var sides=['N','S','W','E']; var side=null;"
                + " for(var s=0;s<4;s++){var hasDoor=false;for(var d=0;d<b.doors.length;d++){if(b.doors[d].side===sides[s])hasDoor=true;}"
                + "  if(!hasDoor){side=sides[s];break;}}"
                + " if(!side) side='N';"
                + " var o=b.outer, x=o[0]+o[2]/2, y=o[1]+o[3]/2;"
                + " if(side==='N') y=o[1]-24; if(side==='S') y=o[1]+o[3]+16; if(side==='W') x=o[0]-20; if(side==='E') x=o[0]+o[2]+20;"
                + " G.player.x=x; G.player.y=y; bwe.spatial.leave(G.player);"
                + " return side+'|'+b.id+'|'+o.join(',');"
                + "})()");
        check("墙测：找到测试建筑", setup.indexOf('|') > 0, setup);
        if (setup.indexOf('|') < 0) {
            return;
        }
        String side = setup.substring(0, 1);
        int key = "N".equals(side) ? KeyEvent.VK_S : "S".equals(side) ? KeyEvent.VK_W
                : "W".equals(side) ? KeyEvent.VK_D : KeyEvent.VK_A;
        String bid = setup.split("\\|")[1];
        holdFor(new int[]{key}, 150);
        boolean inside = bool(P, "(function(){var b=null;for(var i=0;i<CITY.buildings.length;i++)if(CITY.buildings[i].id==='" + bid
                + "')b=CITY.buildings[i];var o=b.inner,x=G.player.x,y=G.player.y+8;"
                + "return x>o[0]&&x<o[0]+o[2]&&y>o[1]&&y<o[1]+o[3];})()");
        check("墙测：朝无门的墙走 2.5 秒，没有穿进室内", !inside, "side=" + side + " pos=" + pxy());
    }

    /**
     * 楼：门外站位 → 朝门内走 → 进入室内（屋顶隐藏）→ 走到上楼梯 → E → 2 楼 →
     * 四个方向各走 6 秒仍在楼内 → 下楼梯 E → 1 楼 → 走出门 → 室外（屋顶显示）。
     */
    private static void scenarioBuilding() {
        String setup = js(P, ""
                + "(function(){"
                + " for(var i=0;i<CITY.buildings.length;i++){var b=CITY.buildings[i];"
                + "  if(b.floors&&(typeof b.floors==='number'?b.floors>=2:b.floors.length>=2)&&b.doors.length>0&&b.stairs&&b.stairs.length>0){"
                + "   var d=b.doors[0]; G.player.x=d.outside.x; G.player.y=d.outside.y; bwe.spatial.leave(G.player);"
                + "   G.__pt={b:b,d:d}; return b.id+'|'+d.side+'|'+b.floors; }}"
                + " return 'none';"
                + "})()");
        check("楼测：找到 ≥2 层且有门有楼梯的建筑", setup.indexOf('|') > 0, setup);
        if (setup.indexOf('|') < 0) {
            return;
        }
        String[] parts = setup.split("\\|");
        String bid = parts[0];
        String side = parts[1];
        step(5);
        boolean roofBefore = roofVisible(bid);
        check("楼测：站在门外时屋顶可见", roofBefore, "bid=" + bid);
        // 门在 N 边 → 门内在南（向 S 走）
        int inKey = "N".equals(side) ? KeyEvent.VK_S : "S".equals(side) ? KeyEvent.VK_W
                : "W".equals(side) ? KeyEvent.VK_D : KeyEvent.VK_A;
        // 先对齐门中心，再朝门内走，最多 3 秒
        holdFor(new int[]{inKey}, 100);
        step(5);
        boolean indoor = bool(P, "!!(bwe.spatial.current()&&bwe.spatial.current().indoor&&bwe.spatial.current().buildingId==='" + bid + "')");
        check("楼测：从门走进去 → 引擎判定在室内", indoor, pxy() + " cur=" + js(P, "JSON.stringify(bwe.spatial.current())"));
        check("楼测：进入后屋顶隐藏", !roofVisible(bid), "");

        // 传送到 0 层上楼梯前方（寻路走过去不是本测试重点，楼梯交互才是）
        String up = js(P, "(function(){var b=G.__pt.b;for(var i=0;i<b.stairs.length;i++){var s=b.stairs[i];"
                + "if(s.level===0&&s.kind==='up'){G.player.x=s.x;G.player.y=s.y+20;return s.link;}}return 'none';})()");
        step(3);
        tap(KeyEvent.VK_E);
        step(40);
        double lv = num(P, "bwe.spatial.levelOf(G.player)");
        check("楼测：在上楼梯旁按 E → 到 2 楼（level 1）", lv == 1.0, "link=" + up + " " + pxy());
        check("楼测：2 楼时屋顶仍隐藏", !roofVisible(bid), "");
        boolean lv1Visible = bool(P, "(function(){var a=bwe.world.findAll({tag:'lv1'});var n=0,v=0;"
                + "for(var i=0;i<a.length;i++){if(a[i].hasTag('" + bid + "')){n++;if(a[i].visible)v++;}}return n===0||v===n;})()");
        check("楼测：2 楼的楼板/家具已显示", lv1Visible, "");

        int[] dirs = {KeyEvent.VK_W, KeyEvent.VK_S, KeyEvent.VK_A, KeyEvent.VK_D};
        boolean escaped = false;
        String where = "";
        for (int d : dirs) {
            holdFor(new int[]{d, KeyEvent.VK_SHIFT}, 360);
            boolean in = bool(P, "(function(){var o=G.__pt.b.inner,x=G.player.x,y=G.player.y+8;"
                    + "return x>=o[0]-1&&x<=o[0]+o[2]+1&&y>=o[1]-1&&y<=o[1]+o[3]+1&&bwe.spatial.levelOf(G.player)===1;})()");
            if (!in) {
                escaped = true;
                where = KeyEvent.getKeyText(d) + " " + pxy();
                break;
            }
        }
        check("楼测：2 楼往四个方向各跑 6 秒都离不开建筑", !escaped, where);
        // 斜向冲门洞位置（上层门洞应被补墙封死）
        js(P, "(function(){var d=G.__pt.d;G.player.x=d.inside.x;G.player.y=d.inside.y;})()");
        holdFor(new int[]{"N".equals(side) ? KeyEvent.VK_W : "S".equals(side) ? KeyEvent.VK_S
                : "W".equals(side) ? KeyEvent.VK_A : KeyEvent.VK_D}, 240);
        boolean stillIn = bool(P, "bwe.spatial.levelOf(G.player)===1&&!!bwe.spatial.current()&&bwe.spatial.current().indoor");
        check("楼测：2 楼朝门洞方向走也出不去", stillIn, pxy());

        // 下楼
        js(P, "(function(){var b=G.__pt.b;for(var i=0;i<b.stairs.length;i++){var s=b.stairs[i];"
                + "if(s.level===1&&s.kind==='down'){G.player.x=s.x;G.player.y=s.y+20;return;}}})()");
        step(3);
        tap(KeyEvent.VK_E);
        step(40);
        check("楼测：在下楼梯旁按 E → 回到 1 楼（level 0）", num(P, "bwe.spatial.levelOf(G.player)") == 0.0, pxy());
        // 走出门
        js(P, "(function(){var d=G.__pt.d;G.player.x=d.inside.x;G.player.y=d.inside.y;})()");
        int outKey = "N".equals(side) ? KeyEvent.VK_W : "S".equals(side) ? KeyEvent.VK_S
                : "W".equals(side) ? KeyEvent.VK_A : KeyEvent.VK_D;
        holdFor(new int[]{outKey}, 120);
        step(5);
        boolean outdoor = bool(P, "!(bwe.spatial.current()&&bwe.spatial.current().indoor)");
        check("楼测：1 楼从门走出去 → 室外", outdoor, pxy());
        check("楼测：出门后屋顶恢复", roofVisible(bid), "");
    }

    private static boolean roofVisible(String bid) {
        int total = 0;
        int hidden = 0;
        ScriptSpatial sp = ScriptSpatial.LAST;
        for (Actor a : rt.actors) {
            if (a.o == null || a.o.tags == null) {
                continue;
            }
            if (a.o.tags.contains("roof") && a.o.tags.contains(bid)) {
                total++;
                if (sp != null && sp.isActorHidden(a)) {
                    hidden++;
                }
            }
        }
        return total > 0 && hidden == 0;
    }

    /**
     * 车：找一辆有司机的交通车，玩家放到车旁，E → 劫车；W 2 秒车动、A 转向；E → 下车且不在墙里。
     */
    private static void scenarioVehicle() {
        String setup = js(P, ""
                + "(function(){"
                + " var cars=bwe.world.findAll({tag:'vehicle'}); var best=null;"
                + " for(var i=0;i<cars.length;i++){var c=cars[i]; if(!c.alive) continue; var d=bwe.vehicle.driver(c);"
                + "  if(d&&d!==G.player){best=c;break;}}"
                + " if(!best) return 'none:'+cars.length;"
                + " bwe.spatial.leave(G.player);"
                + " var h=bwe.vehicle.heading(best)*Math.PI/180;"
                + " G.player.x=best.x-Math.sin(h)*30; G.player.y=best.y+Math.cos(h)*30;"
                + " G.__car=best; return 'ok:'+Math.round(best.x)+','+Math.round(best.y);"
                + "})()");
        check("车测：找到有司机的交通车", setup.startsWith("ok"), setup);
        if (!setup.startsWith("ok")) {
            return;
        }
        // 车可能已开走：每帧把玩家贴着车，直到按下 E
        js(P, "(function(){var c=G.__car;bwe.vehicle.brake(c,1);})()");
        step(2);
        js(P, "(function(){var c=G.__car;var h=bwe.vehicle.heading(c)*Math.PI/180;"
                + "G.player.x=c.x-Math.sin(h)*30;G.player.y=c.y+Math.cos(h)*30;})()");
        tap(KeyEvent.VK_E);
        step(10);
        boolean driving = bool(P, "bwe.vehicle.vehicleOf(G.player)===G.__car");
        check("车测：E → 劫车成功，玩家在驾驶这辆车", driving, js(P, "String(bwe.vehicle.vehicleOf(G.player))"));
        check("车测：驾驶时玩家精灵隐藏", bool(P, "G.player.visible===false"), "");
        if (!driving) {
            return;
        }
        double x0 = num(P, "G.__car.x");
        double y0 = num(P, "G.__car.y");
        double h0 = num(P, "bwe.vehicle.heading(G.__car)");
        holdFor(new int[]{KeyEvent.VK_W}, 90);
        double moved = Math.hypot(num(P, "G.__car.x") - x0, num(P, "G.__car.y") - y0);
        check("车测：W 1.5 秒车开动（位移 > 60px）", moved > 60, "moved=" + Math.round(moved));
        double h1 = num(P, "bwe.vehicle.heading(G.__car)");
        holdFor(new int[]{KeyEvent.VK_W, KeyEvent.VK_D}, 45);
        double h2 = num(P, "bwe.vehicle.heading(G.__car)");
        double turned = Math.abs(angDiff(h2, h1));
        check("车测：W+D 0.75 秒车头转向 > 30°", turned > 30, "turn=" + Math.round(turned) + " h0=" + Math.round(h0));
        holdFor(new int[]{KeyEvent.VK_S}, 120);
        tap(KeyEvent.VK_E);
        step(10);
        boolean walking = bool(P, "!bwe.vehicle.vehicleOf(G.player)&&G.player.visible!==false");
        check("车测：再按 E → 下车，玩家可见", walking, "");
        boolean inWall = bool(P, "(function(){var x=G.player.x,y=G.player.y+8;for(var i=0;i<CITY.walls.length;i++){var w=CITY.walls[i];"
                + "if((w[4]===-1||w[4]===0)&&x+6>w[0]&&x-6<w[0]+w[2]&&y+4>w[1]&&y-4<w[1]+w[3])return true;}return false;})()");
        check("车测：下车点不在墙里", !inWall, pxy());
        double cx0 = num(P, "G.__car.x");
        step(120);
        double carDrift = Math.abs(num(P, "G.__car.x") - cx0);
        check("车测：下车后车停在原地（2 秒漂移 < 30px）", carDrift < 30, "drift=" + Math.round(carDrift));
    }

    private static double angDiff(double a, double b) {
        double d = (a - b) % 360.0;
        if (d > 180) {
            d -= 360;
        }
        if (d < -180) {
            d += 360;
        }
        return d;
    }

    /**
     * 交通：跟踪所有自动驾驶车 20 秒，统计「累计转角 / 位移」，打转的车转角巨大而位移很小。
     */
    private static void scenarioTraffic() {
        List<Actor> cars = new ArrayList<Actor>();
        for (Actor a : rt.actors) {
            if (a.o != null && a.o.tags.contains("vehicle") && !a.dead) {
                cars.add(a);
            }
        }
        int n = cars.size();
        check("交通：场上有 ≥ 6 辆车", n >= 6, "cars=" + n);
        float[] lastRot = new float[n];
        float[] sx = new float[n];
        float[] sy = new float[n];
        double[] totalTurn = new double[n];
        double[] path = new double[n];
        float[] px = new float[n];
        float[] py = new float[n];
        for (int i = 0; i < n; i++) {
            lastRot[i] = cars.get(i).o.rotation;
            sx[i] = px[i] = cars.get(i).x;
            sy[i] = py[i] = cars.get(i).y;
        }
        int frames = 1200;
        for (int f = 0; f < frames; f++) {
            step(1);
            for (int i = 0; i < n; i++) {
                Actor c = cars.get(i);
                totalTurn[i] += Math.abs(angDiff(c.o.rotation, lastRot[i]));
                lastRot[i] = c.o.rotation;
                path[i] += Math.hypot(c.x - px[i], c.y - py[i]);
                px[i] = c.x;
                py[i] = c.y;
            }
        }
        int circling = 0;
        int moving = 0;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) {
            // 正常城市驾驶：每 100px 路程转角 ≤ 约 45°（一个路口 90° 至少要几百 px 路程）
            double turnPer100 = path[i] < 1 ? 0 : totalTurn[i] / (path[i] / 100.0);
            if (path[i] > 200) {
                moving++;
            }
            if (totalTurn[i] > 720 || (path[i] > 100 && turnPer100 > 60)) {
                circling++;
                if (sb.length() < 300) {
                    sb.append("#").append(i).append(" turn=").append(Math.round(totalTurn[i]))
                            .append(" path=").append(Math.round(path[i])).append("; ");
                }
            }
        }
        check("交通：20 秒内没有车在打转（累计转角 ≤ 720° 且每 100px ≤ 60°）", circling == 0,
                "circling=" + circling + "/" + n + " " + sb);
        check("交通：至少一半的车在行驶（20 秒路程 > 200px）", moving * 2 >= n, "moving=" + moving + "/" + n);
    }

    /**
     * NPC：读 world.js 的统计（POI 到达次数、重选目标次数），再跑 40 秒。
     */
    private static void scenarioNpcs() {
        int civ0 = countTag("civilian");
        check("NPC：场上有 ≥ 15 个行人", civ0 >= 15, "civilians=" + civ0);
        String stats0 = js(W, "JSON.stringify(W.stats||{})");
        step(2400);
        String stats1 = js(W, "JSON.stringify(W.stats||{})");
        check("NPC：40 秒统计（参考）", true, stats0 + " → " + stats1);
        String wander = js(W, ""
                + "(function(){"
                + " if(typeof CITY==='undefined') return 'nocity';"
                + " var walls=CITY.walls, a=bwe.world.findAll({tag:'civilian'}), bad=0, n=0;"
                + " for(var i=0;i<a.length;i++){var e=a[i]; if(!e.alive||e.visible===false) continue; n++;"
                + "  var x=e.x,y=e.y+8;"
                + "  for(var k=0;k<walls.length;k++){var w=walls[k]; if(w[4]!==-1&&w[4]!==0) continue;"
                + "   if(x+5>w[0]&&x-5<w[0]+w[2]&&y+3>w[1]&&y-3<w[1]+w[3]){bad++;break;}}}"
                + " return n+'|'+bad;"
                + "})()");
        String[] wp = wander.split("\\|");
        int inWalls = wp.length == 2 ? Integer.parseInt(wp[1]) : -1;
        check("NPC：没有行人卡在墙里", inWalls == 0, wander);
        // 在马路中央（非人行横道）上的行人比例：逛街应基本走人行道
        String onRoad = js(W, ""
                + "(function(){"
                + " var a=bwe.world.findAll({tag:'civilian'}), n=0, road=0;"
                + " var edges=bwe.road.edges(), nodes={}; var ns=bwe.road.nodes(); for(var i=0;i<ns.length;i++) nodes[ns[i].id]=ns[i];"
                + " for(var i=0;i<a.length;i++){var e=a[i]; if(!e.alive||e.visible===false) continue; n++;"
                + "  for(var k=0;k<edges.length;k++){var ed=edges[k], p=nodes[ed.from], q=nodes[ed.to]; if(!p||!q) continue;"
                + "   var hw=(ed.width||48)/2-6;"
                + "   var minx=Math.min(p.x,q.x)-hw, maxx=Math.max(p.x,q.x)+hw, miny=Math.min(p.y,q.y)-hw, maxy=Math.max(p.y,q.y)+hw;"
                + "   var nearNode=Math.min(Math.abs(e.x-p.x)+Math.abs(e.y-p.y),Math.abs(e.x-q.x)+Math.abs(e.y-q.y))<(ed.width||48);"
                + "   if(!nearNode&&e.x>minx&&e.x<maxx&&e.y>miny&&e.y<maxy){road++;break;}}}"
                + " return n+'|'+road;"
                + "})()");
        String[] rp = onRoad.split("\\|");
        int nOn = rp.length == 2 ? Integer.parseInt(rp[0]) : 0;
        int nRoad = rp.length == 2 ? Integer.parseInt(rp[1]) : 999;
        check("NPC：≤ 10% 的行人站在路段中间（其余在人行道/路口/店里）", nOn > 0 && nRoad * 10 <= nOn,
                "onRoadMidblock=" + nRoad + "/" + nOn);
    }

    private static int countTag(String tag) {
        int n = 0;
        for (Actor a : rt.actors) {
            if (a.o != null && a.o.tags.contains(tag) && !a.dead) {
                n++;
            }
        }
        return n;
    }

    private static void scenarioLogs(File boot) throws Exception {
        File log = new File(boot.getParentFile(), "bwe.log");
        String text = log.isFile() ? new String(Files.readAllBytes(log.toPath()), StandardCharsets.UTF_8) : "";
        int errs = 0;
        String first = "";
        int idx = 0;
        while ((idx = text.indexOf("[脚本错误]", idx)) >= 0) {
            if (errs == 0) {
                int end = text.indexOf('\n', idx);
                first = text.substring(idx, end < 0 ? text.length() : Math.min(end, idx + 300));
            }
            errs++;
            idx++;
        }
        check("日志：没有脚本错误", errs == 0, errs + " " + first);
        check("日志：没有 update/draw 异常", !text.contains("update 异常") && !text.contains("draw 异常"), "");
    }
}
