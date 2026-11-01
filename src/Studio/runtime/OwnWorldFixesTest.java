package Studio.runtime;

import java.awt.event.KeyEvent;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * 开放世界模板「5 个用户报告问题」的回归测试（真引擎、真按键、真几何）。
 *
 * <p>这不是断言清单，是<b>行为验收</b>：每一项都能在改动前 FAIL、改动后 PASS。
 *
 * 1. 碰撞：玩家撞不穿停在原地的车
 * 2. 攻击：鼠标左键（Mouse0）能攻击（原来 bwe.actions 完全忽略鼠标键）
 * 3. 卡房子：被击退不会被打进墙里
 * 4. 室内消失：身体完全离开楼之后室内才消失
 * 5. 房子不上马路：没有建筑压道路
 */
public final class OwnWorldFixesTest {
    private static final float DT = 1f / 60f;
    private static TopDownRuntime rt;
    private static ScriptEngine eng;
    private static final List<String[]> R = new ArrayList<String[]>();
    private static int fail = 0;

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        // 不传参数时按「先找刚构建出来的，再找仓库里已有的」顺序兜底，
        // 这样 `bwe.ps1 test-all`（不给参数）也能直接跑。
        String bootPath = args.length > 0 ? args[0] : findBoot();
        try {
            rt = new TopDownRuntime(new File(bootPath));
            eng = rt.scripts;
            step(2);
            step(180);
            t1_attackByMouse();
            t1b_attackBySpace();
            t2_carCollision();
            t3_knockbackNoWallClip();
            t4_interiorAfterBodyExit();
            t5_buildingsOffRoad();
            t6_solidProps();
            t7_carAngleStuck();
        } catch (Throwable t) {
            check("跑起来没崩", false, t.toString());
            t.printStackTrace();
        }
        System.out.println("========== OwnWorldFixesTest（开放世界 5 个问题回归） ==========");
        for (String[] r : R) {
            System.out.println((("true".equals(r[1]) ? "PASS  " : "FAIL  ")) + r[0]
                    + (r[2].isEmpty() ? "" : "   [" + r[2] + "]"));
        }
        System.out.println("共 " + R.size() + " 项，失败 " + fail);
        System.exit(fail == 0 ? 0 : 1);
    }

    /** 找一个可用的 Build/boot.json（优先刚产出的 openworld-e2e）。 */
    private static String findBoot() {
        String[] cands = {
                ".tmp_rel8/openworld-e2e/Build/boot.json",
                "web/.build/quickrun/Build/boot.json",
                ".tmp_rel8/final/Build/boot.json",
                ".tmp_rel8/openworld/Build/boot.json",
        };
        for (String c : cands) {
            if (new File(c).isFile()) {
                return c;
            }
        }
        return cands[0];
    }

    private static void step(int n) {
        for (int i = 0; i < n; i++) {
            eng.update(DT);
        }
    }

    private static void hold(int key, boolean down) {
        rt.keys[key] = down;
    }

    private static String js(String script, String expr) {
        String r = eng.evalForTest(script, expr);
        return r == null ? "null" : r;
    }

    private static void check(String name, boolean ok, String detail) {
        R.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
        if (!ok) {
            fail++;
        }
    }

    // ---------------- 1. 鼠标左键攻击 ----------------
    private static void t1_attackByMouse() {
        String setup = js("player", ""
                + "(function(){"
                + " var npcs=bwe.world.findAll({tag:'civilian'});"
                + " var t=null; for(var i=0;i<npcs.length;i++){if(npcs[i].alive){t=npcs[i];break;}}"
                + " if(!t) return 'none';"
                + " G.__t=t; G.attackCd=0; G.defending=false;"
                + " G.player.x=t.x-20; G.player.y=t.y;"
                + " G.__hp0=t.hp;"
                + " return 'ok';"
                + "})()");
        if (!setup.equals("ok")) {
            check("1a 鼠标攻击：找到目标", false, setup);
            return;
        }
        // ★ 观测方式：pressed() 只在 update 内部为 true（帧末会被 fill(false) 清掉），
        // 所以不能"点完再去读 pressed"。直接看攻击的副作用：NPC 掉血。
        //
        // ⚠ 目标必须每帧重新贴住：脚本每帧会 syncLevel / 收敛位置，隔几帧才读会
        // 发现玩家和 NPC 已经不在射程内（这就是上一版测试假失败的原因）。
        eng.pointerDown(480, 270, false, 480, 270);
        eng.update(DT);
        double hp0 = Double.parseDouble(js("player", "String(G.__hp0)"));
        double hp1 = Double.parseDouble(js("player", "String(G.__t.hp)"));
        check("1a 鼠标左键能攻击（NPC 掉血）", hp1 < hp0, "hp " + hp0 + " -> " + hp1);
        // 表现层：挥击弧必须真的入队（否则玩家按了键屏幕上什么都没有，
        // 主观上仍然是"没有攻击"）。
        String fx = js("player", ""
                + "(function(){"
                + " var n=0;"
                + " if(typeof FX!=='undefined'){n=FX.flaps.length+FX.sparks.length;}"
                + " return String(n);"
                + "})()");
        check("1a2 攻击有可见反馈（挥击弧/火花）", !"0".equals(fx), "fxCount=" + fx);
    }

    // ---------------- 1b. 空格攻击（回归：别把键盘弄坏） ----------------
    //
    // ⚠ 这一项**不能**靠"打中 NPC 看掉血"来判：NPC 被打之后会逃跑，位置每帧都在漂，
    // 测试就变成时不时超出射程的抛硬币（实测 5 次跑有 2 次假失败）。
    //
    // 所以判据换成确定性的两件事：
    //   a) 空格能触发攻击 —— 攻击冷却从 0 被打上（说明 doAttack 真的执行了）；
    //   b) 玩家没有攻击的产出的实体/副作用不依赖目标是否存在（空挥也会进冷却）。
    private static void t1b_attackBySpace() {
        String setup = js("player", ""
                + "(function(){"
                + " G.attackCd=0; G.defending=false; G.dead=false; G.car=null; G.taxi=null;"
                + " G.level=0; G.bld=''; G.indoor=false;"
                + " try{bwe.spatial.leave(G.player);}catch(eL){}"
                + " return 'ok';"
                + "})()");
        if (!setup.equals("ok")) {
            check("1b 空格攻击：状态复位", false, setup);
            return;
        }
        // 按住空格跑一帧：pressed 是边沿信号，只在按下那一帧为 true
        hold(KeyEvent.VK_SPACE, true);
        eng.update(DT);
        hold(KeyEvent.VK_SPACE, false);
        double cd = Double.parseDouble(js("player", "String(G.attackCd)"));
        check("1b 空格能触发攻击（键盘路径没坏）", cd > 0, "attackCd=" + cd);

        // 再确认挥击弧入队（空挥也要有，玩家才看得见）
        String fx = js("player", ""
                + "(function(){"
                + " var n=0;"
                + " if(typeof FX!=='undefined'){n=FX.flaps.length+FX.sparks.length;}"
                + " return String(n);"
                + "})()");
        check("1b2 空格攻击也有可见反馈", !"0".equals(fx), "fxCount=" + fx);
    }

    // ---------------- 2. 撞不穿停着的车 ----------------
    private static void t2_carCollision() {
        String setup = js("player", ""
                + "(function(){"
                + " var cars=bwe.world.findAll({tag:'vehicle'});"
                + " var car=null;"
                + " for(var i=0;i<cars.length;i++){"
                + "  var c=cars[i]; if(!c.alive||c.visible===false) continue;"
                + "  var d=bwe.vehicle.driver(c); if(d&&d!==G.player) continue;"
                + "  car=c; break;}"
                + " if(!car) return 'nocar';"
                + " G.__car=car;"
                + " G.level=0; G.car=null; G.taxi=null; G.bld=''; G.indoor=false;"
                + " try{bwe.spatial.leave(G.player);}catch(eL){}"
                + " var sz=car.size||{w:64,h:32};"
                + " var hd=bwe.vehicle.heading(car)*Math.PI/180;"
                + " G.player.x=car.x-Math.cos(hd)*(sz.w/2+90);"
                + " G.player.y=car.y-Math.sin(hd)*(sz.w/2+90);"
                + " bwe.vehicle.stop(car);"
                + " G.__vclist=(typeof VC!=='undefined'?VC.list.length:-1);"
                + " return 'ok';"
                + "})()");
        if (!setup.equals("ok")) {
            check("2 车辆碰撞：找到可测车", false, setup);
            return;
        }
        js("player", ""
                + "(function(){"
                + " var car=G.__car, sz=car.size||{w:64,h:32};"
                + " for(var f=0;f<400;f++){"
                + "  var dx=car.x-G.player.x, dy=car.y-G.player.y;"
                + "  var d=Math.sqrt(dx*dx+dy*dy);"
                + "  if(d<1) break;"
                + "  var r=resolveMove(G.player.x,G.player.y,dx/d*3.2,dy/d*3.2,0);"
                + "  if(Math.abs(r.x-G.player.x)<0.001&&Math.abs(r.y-G.player.y)<0.001) break;"
                + "  G.player.x=r.x; G.player.y=r.y;"
                + " }"
                + " return 'ok';"
                + "})()");
        String res = js("player", ""
                + "(function(){"
                + " var car=G.__car, sz=car.size||{w:64,h:32};"
                + " var dx=G.player.x-car.x, dy=G.player.y-car.y;"
                + " var insideBody=Math.abs(dx)<sz.w/2&&Math.abs(dy)<sz.h/2;"
                + " return JSON.stringify({dx:Math.round(dx),insideBody:insideBody,sz:sz,"
                + "  vcList:(typeof VC!=='undefined'?VC.list.length:-1),level:G.level,car:G.car?'y':'n'});"
                + "})()");
        boolean inside = res.contains("\"insideBody\":true");
        check("2 走向停着的车：身体进不到车里面", !inside, res);
    }

    // ---------------- 3. 击退不把人打进墙里 ----------------
    private static void t3_knockbackNoWallClip() {
        String setup = js("player", ""
                + "(function(){"
                + " var b=null; for(var i=0;i<CITY.buildings.length;i++){var c=CITY.buildings[i];"
                + "  if(c.outer[2]>=96&&c.outer[3]>=96){b=c;break;}}"
                + " if(!b) return 'nobuilding';"
                + " var o=b.inner;"
                + " G.player.x=o[0]+12; G.player.y=o[1]+o[3]/2;"
                + " try{bwe.spatial.enter(b.id+'_r0', G.player);}catch(e){}"
                + " var npcs=bwe.world.findAll({tag:'civilian'});"
                + " var e=null; for(var i=0;i<npcs.length;i++){if(npcs[i].alive){e=npcs[i];break;}}"
                + " if(!e) return 'nonpc';"
                + " e.x=G.player.x+34; e.y=G.player.y;"
                + " G.__atk=e; G.__b=b;"
                + " return 'ok';"
                + "})()");
        if (!setup.equals("ok")) {
            check("3 击退：找到测试楼与攻击者", false, setup);
            return;
        }
        js("player", "G.__kbFrom=[Math.round(G.player.x),Math.round(G.player.y)].join(',');'ok'");
        js("player", "bwe.combat.hit({from:G.__atk,to:G.player,amount:7,knockback:60})");
        step(2);
        String res = js("player", ""
                + "(function(){"
                + " var x=G.player.x,y=G.player.y+8;"
                + " var inWall=false;"
                + " for(var k=0;k<CITY.walls.length;k++){var w=CITY.walls[k];"
                + "  if(w[4]!==-1&&w[4]!==0) continue;"
                + "  if(x+6>w[0]&&x-6<w[0]+w[2]&&y+4>w[1]&&y-4<w[1]+w[3]){inWall=true;break;}}"
                + " var o=G.__b.inner;"
                + " var insideInner=G.player.x>o[0]&&G.player.x<o[0]+o[2]&&G.player.y>o[1]&&G.player.y<o[1]+o[3];"
                + " return JSON.stringify({inWall:inWall,insideInner:insideInner,"
                + "  x:Math.round(G.player.x),y:Math.round(G.player.y),inner:o});"
                + "})()");
        boolean inWall = res.contains("\"inWall\":true");
        check("3 被击退后身体不在墙里", !inWall, res);
        String moved = js("player", ""
                + "(function(){"
                + " var a=G.__kbFrom.split(','), bx=Math.round(G.player.x), by=Math.round(G.player.y);"
                + " var d=Math.sqrt((bx-a[0])*(bx-a[0])+(by-a[1])*(by-a[1]));"
                + " return String(Math.round(d));"
                + "})()");
        check("3b 击退确实推动了（不是原地不动）", !"0".equals(moved), "moved=" + moved);
    }

    // ---------------- 4. 室内物件等人完全离开才消失 ----------------
    private static void t4_interiorAfterBodyExit() {
        String setup = js("player", ""
                + "(function(){"
                + " var b=null; for(var i=0;i<CITY.buildings.length;i++){var c=CITY.buildings[i];"
                + "  if(c.outer[2]>=96&&c.outer[3]>=96&&c.doors.length){b=c;break;}}"
                + " if(!b) return 'nobuilding';"
                + " G.__b4=b;"
                + " var d=b.doors[0];"
                + " G.__scan=[];"
                + " var o=b.inner;"
                + " var dirx=d.outside.x>o[0]+o[2]?1:(d.outside.x<o[0]?-1:0);"
                + " var diry=d.outside.y>o[1]+o[3]?1:(d.outside.y<o[1]?-1:0);"
                + " for(var t=0;t<=160;t+=2){"
                + "  G.player.x=d.inside.x+dirx*t; G.player.y=d.inside.y+diry*t;"
                + "  G.visKey='';"
                + "  try{syncLevel();}catch(e){}"
                + "  var list=bwe.world.findAll({tag:'interior'});"
                + "  var vis=0; for(var i2=0;i2<list.length;i2++){var tg=list[i2].tags?Array.from(list[i2].tags):[];"
                + "   if(tg.indexOf(b.id)>=0&&list[i2].visible)vis++;}"
                + "  var bodyIn=bodyTouches(b,G.player.x,G.player.y,0);"
                + "  G.__scan.push({t:t,vis:vis,bodyIn:bodyIn,"
                + "   bx0:Math.round(G.player.x-6),bx1:Math.round(G.player.x+6),innerR:o[0]+o[2]});"
                + " }"
                + " return 'ok';"
                + "})()");
        if (!setup.equals("ok")) {
            check("4 室内消失：准备扫描", false, setup);
            return;
        }
        String res = js("player", ""
                + "(function(){"
                + " var s=G.__scan, bad=null;"
                + " for(var i=0;i<s.length;i++){"
                + "  if(s[i].bodyIn&&s[i].vis===0&&!bad) bad=s[i];"
                + "  if(!s[i].bodyIn&&s[i].vis>0){}"
                + " }"
                + " return JSON.stringify({vbWhileBodyIn:bad,badCount:bad?1:0});"
                + "})()");
        boolean ok = res.contains("\"badCount\":0");
        check("4 身体还在楼里时室内不会消失", ok, res);
    }

    // ---------------- 5. 建筑不上马路 ----------------
    private static void t5_buildingsOffRoad() {
        String res = js("player", ""
                + "(function(){"
                + " var T=CITY.tile, bad=[];"
                + " var rw={avenue:6*T,b2:3*T,alley:2*T};"
                + " var ww={avenue:2*T,b2:1*T,alley:0};"
                + " for(var i=0;i<CITY.buildings.length;i++){"
                + "  var o=CITY.buildings[i].outer;"
                + " }"
                + " var asphalt=bwe.world.findAll({tag:'asphalt'});"
                + " for(var i=0;i<CITY.buildings.length;i++){"
                + "  var b=CITY.buildings[i], o2=b.outer;"
                + "  var cx=o2[0]+o2[2]/2, cy=o2[1]+o2[3]/2;"
                + "  var hit=false;"
                + "  for(var k=0;k<asphalt.length;k++){var a=asphalt[k],sz=a.size||{w:32,h:32};"
                + "   if(Math.abs(a.x-cx)<(sz.w/2+o2[2]/2)&&Math.abs(a.y-cy)<(sz.h/2+o2[3]/2)){"
                + "    if(o2[0]<a.x+sz.w/2&&o2[0]+o2[2]>a.x-sz.w/2&&o2[1]<a.y+sz.h/2&&o2[1]+o2[3]>a.y-sz.h/2){hit=true;break;}}}"
                + "  if(hit) bad.push(b.id+':'+b.name);"
                + " }"
                + " return JSON.stringify({bad:bad});"
                + "})()");
        check("5 没有建筑压在沥青路面上", res.contains("\"bad\":[]"), res);
    }

    // ---------------- 6. 道具真的有碰撞 ----------------
    private static void t6_solidProps() {
        String res = js("player", ""
                + "(function(){"
                + " var tree=bwe.world.findAll({tag:'tree'});"
                + " var light=bwe.world.findAll({tag:'trafficlight'});"
                + " var tested=0, blocked=0;"
                + " var list=tree.concat(light);"
                + " for(var i=0;i<list.length&&tested<12;i++){"
                + "  var e=list[i]; if(!e.alive||e.visible===false) continue;"
                + "  var sz=e.size||{w:32,h:32};"
                + "  G.player.x=e.x; G.player.y=e.y-sz.h/2-70;"
                + "  bwe.spatial.leave(G.player);"
                + "  if(G.player.y<20) continue;"
                + "  tested++;"
                + "  var startY=G.player.y;"
                + "  for(var f=0;f<70;f++){"
                + "   var r=resolveMove(G.player.x,G.player.y,0,3.2,0);"
                + "   if(Math.abs(r.y-G.player.y)<0.001) break;"
                + "   G.player.y=r.y;"
                + "  }"
                + "  var overlap=Math.abs(G.player.x-e.x)<sz.w/2&&Math.abs(G.player.y+8-e.y)<sz.h/2;"
                + "  G.player.x=e.x; G.player.y=startY;"
                + "  if(overlap) blocked++;"
                + " }"
                + " return JSON.stringify({tested:tested,passedThrough:blocked});"
                + "})()");
        check("6 树/交通灯有碰撞（走不进去）", res.contains("\"passedThrough\":0"), res);
    }

    // ---------------- 7. 车以一定角度撞楼后不能被卡死 ----------------
    //
    // 复现条件必须精确，否则测不到问题：
    //   - 直接把车摆在建筑西侧、车头朝建筑（20°~75° 的斜角）
    //   - 按住 W 撞上去 3 秒
    //   - 再按住 W+A 想转开 5 秒
    // 旧实现在 30/45/60° 上位置完全不动（movedTotal=0、sp=0）→ 永久卡死。
    // 判据用「位移」而不是「有没有撞墙」：撞墙是正常的，动不了才是 bug。
    private static void t7_carAngleStuck() {
        int stuckAngles = 0;
        StringBuilder detail = new StringBuilder();
        for (int deg : new int[]{20, 30, 45, 60, 75}) {
            String setup = js("player", ""
                    + "(function(){"
                    + " var b=null; for(var i=0;i<CITY.buildings.length;i++){var c=CITY.buildings[i];"
                    + "  if(c.outer[2]>=96&&c.outer[3]>=96){b=c;break;}}"
                    + " if(!b) return 'nobuilding';"
                    + " if(G.__car){G.__car.destroy();}"
                    + " G.car=null; G.taxi=null; G.dead=false; G.level=0; G.bld=''; G.indoor=false;"
                    + " G.player.visible=true;"
                    + " try{bwe.spatial.leave(G.player);}catch(eL){}"
                    + " var o=b.outer;"
                    + " var car=bwe.vehicle.spawn({kind:'car',x:o[0]-90,y:o[1]+o[3]/2,"
                    + "  heading:" + deg + ",rotation:" + deg + ",asset:'vehicle-car',name:'测试车',"
                    + "  tags:['vehicle','car'],z:2,layer:3,halfW:32,halfH:16,speedLimit:260});"
                    + " if(!car) return 'nocar';"
                    + " if(!bwe.vehicle.enter(G.player,car)){car.destroy();return 'noenter';}"
                    + " G.car=car; G.__car=car; G.__x0=car.x; G.__y0=car.y;"
                    + " G.lastCarX=car.x; G.lastCarY=car.y;"
                    // ⚠ 必须初始化 lastCar：旧实现的撞墙回退用的是 G.lastCarX/Y，
                    // 默认值 (0,0) 会把车瞬移到世界原点 —— 位移看起来很大，测试就
                    // 假通过了（这就是上一版第 7 项在旧代码上也能 PASS 的原因）。
                    + " "
                    + " G.player.visible=false;"
                    + " G.attackCd=0; G.defending=false;"
                    + " return 'ok';"
                    + "})()");
            if (!setup.equals("ok")) {
                check("7 车辆角度卡死：角度 " + deg + "° 准备", false, setup);
                continue;
            }
            // 撞上去
            hold(KeyEvent.VK_W, true);
            step(180);
            // ★ 基准点必须是「撞墙后」的位置。
            //
            // 之前用初始位置当基准是错的：撞墙之前开过去的那段位移就有几十~上百 px，
            // 早把 ≥30px 的阈值撑满了 —— 于是「撞墙后一动不动」也能假通过
            // （旧实现在 30/45/60° 上正是位置完全不变）。
            js("player", "G.__hx=G.__car.x; G.__hy=G.__car.y;'ok'");
            // 再想转开
            hold(KeyEvent.VK_A, true);
            step(300);
            hold(KeyEvent.VK_W, false);
            hold(KeyEvent.VK_A, false);
            String moved = js("player", ""
                    + "(function(){"
                    + " var c=G.__car;"
                    + " if(!c||!c.alive) return '-1';"
                    + " var d=Math.sqrt((c.x-G.__hx)*(c.x-G.__hx)+(c.y-G.__hy)*(c.y-G.__hy));"
                    + " return String(Math.round(d));"
                    + "})()");
            double md;
            try {
                md = Double.parseDouble(moved);
            } catch (NumberFormatException e) {
                md = -1;
            }
            if (md < 0) {
                check("7 车辆角度卡死：角度 " + deg + "° 车辆存活", false, "moved=" + moved);
                continue;
            }
            detail.append(deg).append("° moved=").append((int) md).append("; ");
            if (md < 30) {
                stuckAngles++;
            }
            // 清理
            js("player", "if(G.__car){G.__car.destroy();}G.car=null;G.player.visible=true;'x'");
            step(20);
        }
        check("7 车以各角度（20/30/45/60/75°）撞楼后都还能开走（8 秒内位移 ≥ 30px）",
                stuckAngles == 0, "卡住角度数=" + stuckAngles + (detail.length() > 0 ? " " + detail : ""));
    }
}
