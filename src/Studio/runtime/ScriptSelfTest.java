package Studio.runtime;

import java.awt.event.KeyEvent;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 脚本引擎自检（无窗口、纯断言，契约 §2 Phase 1 + §4 错误格式）。
 *
 * <p>流程：现场生成一个最小工程到 {@code .tmp_rel8/selftest/}（boot.json + scene_0.json +
 * scripts/*.js）→ {@code new TopDownRuntime(boot)} → 手动推进 12 帧 {@code scripts.update(0.02f)}
 * → {@code scripts.draw(null)} → 读 Build/bwe.log 校验脚本自报的 API 结果 + 直接检查宿主状态。
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class ScriptSelfTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;

    private ScriptSelfTest() {
    }

    public static void main(String[] args) {
        System.setProperty("java.awt.headless", "true");
        PrintStream realOut = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true));
        int failures = 0;
        String fatal = null;
        try {
            run();
        } catch (Throwable t) {
            fatal = t.toString();
            t.printStackTrace(realOut);
        } finally {
            System.setOut(realOut);
        }
        if (fatal != null) {
            RESULTS.add(new String[]{"selftest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptSelfTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("------------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        if (root != null) {
            realOut.println("日志: " + new File(root, "Build/bwe.log").getAbsolutePath());
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- 主流程 ----------------

    private static void run() throws Exception {
        root = new File(".tmp_rel8/selftest");
        deleteRecursively(root);
        buildProject();

        File boot = new File(root, "Build/boot.json");
        check("boot.json 已生成", boot.isFile(), boot.getAbsolutePath());

        // 构造运行时：此时不应创建任何 Rhino 对象（构造在主线程，update 在 GL 线程）。
        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        check("ScriptEngine 已创建", engine != null, "");
        check("构造期不启动脚本（延迟到 update）", engine != null && !engine.started, "");

        // 第 1 帧：初始化 + sceneStart + onStart + onSceneStart
        engine.update(0.02f);
        check("第 1 帧后引擎启动", engine.started && !engine.failed, "");
        check("绘制指令已录制", engine.debugDrawCount() > 0, "count=" + engine.debugDrawCount());

        // gl == null：必须安全跳过（不崩、不清空绘制列表）
        boolean drawOk = true;
        String drawErr = "";
        try {
            engine.draw(null);
            engine.draw(null);
        } catch (Throwable t) {
            drawOk = false;
            drawErr = t.toString();
        }
        check("draw(null) 安全跳过", drawOk, drawErr);

        // 键盘边沿：第 2 帧按下 D，第 3 帧抬起
        for (int i = 2; i <= 12; i++) {
            if (i == 2) {
                rt.keys[KeyEvent.VK_D] = true;
            }
            if (i == 3) {
                rt.keys[KeyEvent.VK_D] = false;
            }
            if (i == 5) {
                // 点 crate（世界坐标 160,96）→ 全局 click 钩子拿到实体
                engine.pointerDown(160, 96, false, 700, 400);
            }
            if (i == 6) {
                engine.keyDown(KeyEvent.VK_SPACE);
            }
            if (i == 7) {
                rt.keys[KeyEvent.VK_E] = true; // 交互触发键
            }
            if (i == 8) {
                rt.keys[KeyEvent.VK_E] = false;
            }
            engine.update(0.02f);
        }

        List<String> log = readLog();
        check("bwe.log 已写入", !log.isEmpty(), "lines=" + log.size());

        // ------------- 契约 §2.1 world -------------
        expectLog("world.mapSize（640x480）", log, "SELFTEST world.mapSize=640x480");
        expectLog("world.tileSize", log, "SELFTEST world.tileSize=32");
        expectLog("world.scene.name", log, "SELFTEST world.scene=自检场景");
        expectLog("world.find(名字)", log, "SELFTEST scene.findPlayer=1");
        expectLog("world.findAll({tag})", log, "SELFTEST world.findAllTag=1");
        expectLog("world.findAll({kind})", log, "SELFTEST world.findAllKind=1");
        expectLog("world.entities()", log, "SELFTEST world.entities=1");
        expectLog("world.spawn", log, "SELFTEST world.spawn=1");
        expectLog("world.spawn 坐标", log, "SELFTEST world.spawnPos=96,128");
        expectLog("world.spawn tags", log, "SELFTEST world.spawnTag=1");
        expectLog("world.destroy", log, "SELFTEST world.destroy=1");
        expectLog("world.spawn({script}) 绑定脚本并派发 onStart", log, "SELFTEST world.spawnScript=1");
        expectLog("world.destroy 派发 onDestroy", log, "SELFTEST player.onDestroy=temp");
        expectLog("bwe.call 跨脚本调用", log, "SELFTEST call=7");
        expectLog("bwe.scripts.call 等价", log, "SELFTEST scripts.call=7");
        expectLog("Promise 微任务在帧内排空", log, "SELFTEST promise.then=1");
        expectLog("world 事件总线 emit/on", log, "SELFTEST world.event=7");
        TopDownRuntime.Actor spawned = actorNamed(rt, "spawned");
        check("spawn 后宿主里确有该实体", spawned != null && !spawned.dead, "");
        check("spawn 的 tags 写回宿主", spawned != null && spawned.o.tags.contains("enemy"), "");
        check("spawn 坐标写回宿主", spawned != null && Math.abs(spawned.x - 96f) < 0.01f
                && Math.abs(spawned.y - 128f) < 0.01f, spawned == null ? "" : spawned.x + "," + spawned.y);
        check("destroy 后宿主里已移除", actorNamed(rt, "victim") == null, "");

        // ------------- 契约 §2.2 Entity -------------
        expectLog("Entity.pos", log, "SELFTEST ent.pos=160,96");
        expectLog("Entity.size（兜底 tileSize）", log, "SELFTEST ent.size=32x32");
        expectLog("Entity.setSize", log, "SELFTEST ent.size2=48x64");
        expectLog("Entity.visible=false 生效", log, "SELFTEST ent.invisible=false");
        expectLog("Entity.alive", log, "SELFTEST ent.alive=true");
        expectLog("Entity.tags.has/includes", log, "SELFTEST ent.tags=11");
        expectLog("Entity.prop/setProp", log, "SELFTEST prop.w=48");
        expectLog("Entity.damage/heal", log, "SELFTEST ent.damage=1");
        expectLog("Entity.heal 回满", log, "SELFTEST ent.heal=1");
        expectLog("Entity.distanceTo", log, "SELFTEST ent.dist=1");
        expectLog("Entity 事件 on/damage 不崩", log, "SELFTEST ent.on=1");
        TopDownRuntime.Actor crate = actorNamed(rt, "crate");
        check("宿主里 crate 存在", crate != null, "");
        if (crate != null) {
            check("crate setSize 写回 halfW/halfH", Math.abs(crate.o.halfW - 24f) < 0.01f
                    && Math.abs(crate.o.halfH - 32f) < 0.01f, crate.o.halfW + "," + crate.o.halfH);
            check("按 mapping-contract §2 算出的绘制尺寸 48x64",
                    Math.abs(rt.drawWidth(crate) - 48f) < 0.01f
                            && Math.abs(rt.drawHeight(crate) - 64f) < 0.01f,
                    rt.drawWidth(crate) + "x" + rt.drawHeight(crate));
            check("crate visible 恢复 true", crate.o.visible, "");
            check("setProp 写回 props", "48".equals(crate.o.props.get("w"))
                    && "64".equals(crate.o.props.get("h")), String.valueOf(crate.o.props));
            GameData.RtModule hp = rt.data.module(crate.o, "combat.health", "fight.hp");
            check("module.set 写回模块参数", hp != null && "55".equals(hp.params.get("maxHealth")),
                    hp == null ? "module 缺失" : String.valueOf(hp.params));
        }

        // ------------- 契约 §2.3 input -------------
        expectLog("input.down 第 1 帧（未按）", log, "SELFTEST input.down1=0");
        expectLog("input.down 第 2 帧（按下）", log, "SELFTEST input.down2=1");
        expectLog("input.pressed 边沿", log, "SELFTEST input.pressed2=1");
        expectLog("input.released 边沿", log, "SELFTEST input.released3=1");
        expectLog("input.axis 归一化", log, "SELFTEST input.axis2=1");
        expectLog("input.mouse 对象", log, "SELFTEST input.mouse=1");
        check("按住 D 时宿主 keys[] 与脚本一致（已回弹）", !rt.keys[KeyEvent.VK_D], "");
        expectLog("全局 click 钩子命中实体", log, "SELFTEST global.click=crate");
        expectLog("对象 onKey 派发", log, "SELFTEST player.onKey=Space");

        // ------------- 契约 §2.4 camera -------------
        expectLog("camera.worldToScreen（相机中心→屏幕中心）", log, "SELFTEST cam.screen=640,360");
        expectLog("camera.pos", log, "SELFTEST cam.pos=120,100");
        expectLog("camera.zoom", log, "SELFTEST cam.zoom=2");
        expectLog("camera.screenToWorld", log, "SELFTEST cam.world=120,100");
        check("相机写回宿主 view", rt.scriptCameraControl
                        && Math.abs(rt.view.camX - 120f) < 0.01f
                        && Math.abs(rt.view.camY - 100f) < 0.01f
                        && Math.abs(rt.view.zoom - 2f) < 0.01f,
                rt.view.describe());

        // ------------- 契约 §2.5 time -------------
        expectLog("time.after 触发", log, "SELFTEST time.after=1");
        expectLog("time.every 触发并可 cancel", log, "SELFTEST time.every=2");
        expectLog("time.frame 单调递增（12 帧 onUpdate）", log, "SELFTEST player.update=12");

        // ------------- 契约 §2.6 draw -------------
        expectLog("draw.text/rect/bar/line/circle/sprite/world 均不崩", log, "SELFTEST draw.recorded=1");
        expectLog("draw.measureText", log, "SELFTEST draw.measure=1");

        // ------------- 契约 §2.7 audio -------------
        expectLog("audio 缺素材返回 -1 且不崩", log, "SELFTEST audio.missing=1");

        // ------------- 契约 §2.8 save -------------
        expectLog("save.write 落盘", log, "SELFTEST save.write=1");
        expectLog("save.clear", log, "SELFTEST save.cleared=1");
        expectLog("save.read 读回", log, "SELFTEST save.read=1");
        expectLog("save 数值读回", log, "SELFTEST save.score=42");
        expectLog("save 中文读回", log, "SELFTEST save.name=自检");
        expectLog("save 数组读回", log, "SELFTEST save.list=3");
        expectLog("save 嵌套对象读回", log, "SELFTEST save.obj=深");
        expectLog("save.exists", log, "SELFTEST save.exists=1");
        expectLog("save.flush", log, "SELFTEST save.flush=1");
        expectLog("save.delete(slot)", log, "SELFTEST save.delete=1");
        File saveFile = new File(root, "saves/auto.json");
        check("存档文件在 <Build 父目录>/saves/auto.json", saveFile.isFile(), saveFile.getAbsolutePath());
        if (saveFile.isFile()) {
            String json = new String(Files.readAllBytes(saveFile.toPath()), StandardCharsets.UTF_8);
            check("存档 JSON 含 score=42", json.contains("42"), json.replace("\n", " "));
        }

        // ------------- 契约 §2.9 grid / tilemap / nav / interact / spawner -------------
        expectLog("grid.toCell", log, "SELFTEST grid.cell=10,0");
        expectLog("grid.toWorld（格子中心）", log, "SELFTEST grid.world=112,144");
        expectLog("grid.cellSize", log, "SELFTEST tilemap.cellSize=32");
        expectLog("tilemap.get（TILE 对象自动建图）", log, "SELFTEST tilemap.get=1");
        expectLog("tilemap.solid", log, "SELFTEST tilemap.solid=1");
        expectLog("tilemap.blocked（x/y 为左上角）", log, "SELFTEST tilemap.blocked=1");
        expectLog("tilemap.raycast 命中墙", log, "SELFTEST tilemap.raycast=1");
        expectLog("nav.lineOfSight 通路", log, "SELFTEST nav.los=1");
        expectLog("nav.lineOfSight 隔墙", log, "SELFTEST nav.losWall=0");
        expectLog("nav.find 绕过墙", log, "SELFTEST nav.find=1");
        expectLog("nav.find 终点=目标点", log, "SELFTEST nav.end=500,48");
        expectLog("nav.follow 跟随路径并触发 onArrive", log, "SELFTEST nav.arrive=1");
        expectLog("entity.attach 返回句柄", log, "SELFTEST attach=1");
        expectLog("实体 click 事件（e.on）", log, "SELFTEST entity.click=1");
        expectLog("interact.nearest", log, "SELFTEST interact.nearest=1");
        expectLog("interact.onTrigger 按键触发", log, "SELFTEST interact.trigger=1");
        expectLog("spawner 按 interval 刷怪", log, "SELFTEST spawner.spawn=2");
        check("spawner 生成物进了宿主 actors", rt.actors.size() >= 20, "actors=" + rt.actors.size());

        // ------------- §4 错误格式 & 去重 -------------
        String badLine = firstLineContaining(log, "[脚本错误] bad:");
        check("错误格式 [脚本错误] name:line: msg", badLine != null
                        && badLine.matches("(?s).*\\[脚本错误\\] bad:\\d+: .+"),
                badLine == null ? "未找到" : badLine);
        int badCount = countContaining(log, "[脚本错误] bad:");
        check("同一脚本同一行只报一次（onUpdate 抛 11 次）", badCount == 1, "count=" + badCount);
        check("语法错误被捕获且格式正确", countContaining(log, "[脚本错误] syntax:") >= 1,
                firstLineContaining(log, "[脚本错误] syntax:"));
        check("语法错误后其它脚本继续执行", contains(log, "SELFTEST scene.start=1"), "");
        check("单帧 >250ms 告警（slow.js）", countContaining(log, "slow 单帧执行超过 250ms") == 1,
                String.valueOf(countContaining(log, "slow 单帧执行超过 250ms")));
        check("游戏未因脚本错误中断（后续帧仍在跑）", contains(log, "SELFTEST player.update=12"), "");

        // ------------- 生命周期 -------------
        expectLog("脚本顶层代码在 sceneStart 执行", log, "SELFTEST top.main=1");
        expectLog("jsMain.onSceneStart", log, "SELFTEST jsMain.onSceneStart=1");
        expectLog("场景 onStartScript.onSceneStart", log, "SELFTEST scene.start=1");
        expectLog("对象脚本 onStart", log, "SELFTEST player.start=player");
        expectLog("ctx 结构", log, "SELFTEST player.ctx=1");
        expectLog("ctx.dt 是数字", log, "SELFTEST player.dtType=number");

        // ------------- 时间/帧 -------------
        check("time.now 累计 ≈ 0.24s", Math.abs(engine.time - 0.24) < 0.02, "time=" + engine.time);
        check("frame 计数 = 12", engine.frame == 12, "frame=" + engine.frame);
    }

    // ---------------- 生成测试工程 ----------------

    private static void buildProject() throws Exception {
        File build = new File(root, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());

        String boot = "{\n"
                + "  \"project\": \"ScriptSelfTest\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 1,\n"
                + "  \"scenes\": [ { \"name\": \"自检场景\", \"file\": \"scene_0.json\", \"width\": 20, \"height\": 15 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [\n"
                + "    { \"name\": \"main\", \"file\": \"scripts/main.js\", \"lang\": \"js\" },\n"
                + "    { \"name\": \"scene\", \"file\": \"scripts/scene.js\", \"lang\": \"js\" },\n"
                + "    { \"name\": \"player\", \"file\": \"scripts/player.js\", \"lang\": \"js\" },\n"
                + "    { \"name\": \"bad\", \"file\": \"scripts/bad.js\", \"lang\": \"js\" },\n"
                + "    { \"name\": \"slow\", \"file\": \"scripts/slow.js\", \"lang\": \"js\" },\n"
                + "    { \"name\": \"syntax\", \"source\": \"function broken( {\\n  return 1;\\n}\\n\", \"lang\": \"js\" },\n"
                + "    { \"name\": \"yarnOnly\", \"source\": \"<<start>>\\n\", \"lang\": \"yarn\" }\n"
                + "  ],\n"
                + "  \"jsMain\": \"main\"\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);

        StringBuilder scene = new StringBuilder();
        scene.append("{\n");
        scene.append("  \"width\": 20, \"height\": 15, \"tileSize\": 32,\n");
        scene.append("  \"onStartScript\": \"scene\",\n");
        scene.append("  \"layers\": [],\n");
        scene.append("  \"objects\": [\n");
        scene.append("    { \"id\": \"p1\", \"kind\": \"ACTOR\", \"name\": \"player\", \"x\": 64, \"y\": 64,")
                .append(" \"halfW\": 16, \"halfH\": 16, \"visible\": true, \"tags\": [\"玩家\", \"Player\"],")
                .append(" \"modules\": [ { \"def\": \"script.js\", \"params\": { \"script\": \"player\" } } ] },\n");
        scene.append("    { \"id\": \"c1\", \"kind\": \"PROP\", \"name\": \"crate\", \"x\": 160, \"y\": 96,")
                .append(" \"visible\": true, \"tags\": [\"enemy\", \"可交互\"],")
                .append(" \"modules\": [ { \"def\": \"combat.health\", \"params\": { \"maxHealth\": \"30\" } } ] },\n");
        scene.append("    { \"id\": \"b1\", \"kind\": \"PROP\", \"name\": \"badprop\", \"x\": 200, \"y\": 200,")
                .append(" \"visible\": true, \"modules\": [ { \"def\": \"script.js\", \"params\": { \"script\": \"bad\" } } ] },\n");
        scene.append("    { \"id\": \"s1\", \"kind\": \"PROP\", \"name\": \"slowprop\", \"x\": 240, \"y\": 200,")
                .append(" \"visible\": true, \"modules\": [ { \"def\": \"script.js\", \"params\": { \"script\": \"slow\" } } ] }");
        // 墙：cx=10 的竖条，rows 0..12（rows 13/14 留缺口，nav 要能绕过去）
        for (int row = 0; row <= 12; row++) {
            scene.append(",\n    { \"id\": \"w").append(row).append("\", \"kind\": \"TILE\", \"name\": \"wall")
                    .append(row).append("\", \"x\": ").append((10 + 0.5) * 32).append(", \"y\": ")
                    .append((row + 0.5) * 32).append(", \"visible\": true }");
        }
        scene.append("\n  ]\n}\n");
        write(new File(build, "scene_0.json"), scene.toString());

        write(new File(scripts, "main.js"), String.join("\n",
                "bwe.log(\"SELFTEST top.main=1\");",
                "function ping() { return 7; }",
                "function onSceneStart(ctx) {",
                "  bwe.log(\"SELFTEST jsMain.onSceneStart=1\");",
                "  bwe.log(\"SELFTEST jsMain.ctx=\" + (ctx && ctx.world && ctx.time ? \"1\" : \"0\"));",
                "}",
                ""));

        write(new File(scripts, "scene.js"), SCENE_JS);
        write(new File(scripts, "player.js"), PLAYER_JS);
        write(new File(scripts, "bad.js"), String.join("\n",
                "function onStart(ctx) {",
                "  bwe.log(\"SELFTEST bad.onStart=1\");",
                "}",
                "function onUpdate(ctx, dt) {",
                "  throw new Error(\"boom\");",
                "}",
                ""));
        write(new File(scripts, "slow.js"), String.join("\n",
                "function onStart(ctx) {",
                "  var t = Date.now();",
                "  while (Date.now() - t < 300) { }",
                "  bwe.log(\"SELFTEST slow.done=1\");",
                "}",
                ""));
    }

    private static final String SCENE_JS = String.join("\n",
            "function onSceneStart(ctx) {",
            "  bwe.log(\"SELFTEST scene.start=1\");",
            "  var p = bwe.world.find(\"player\");",
            "  bwe.log(\"SELFTEST scene.findPlayer=\" + (p ? \"1\" : \"0\"));",
            "  var ms = bwe.world.mapSize();",
            "  bwe.log(\"SELFTEST world.mapSize=\" + ms.w + \"x\" + ms.h);",
            "  bwe.log(\"SELFTEST world.tileSize=\" + bwe.world.tileSize());",
            "  bwe.log(\"SELFTEST world.scene=\" + bwe.world.scene.name);",
            "  var enemies = bwe.world.findAll({ tag: \"enemy\" });",
            "  bwe.log(\"SELFTEST world.findAllTag=\" + enemies.length);",
            "  var actors = bwe.world.findAll({ kind: \"ACTOR\" });",
            "  bwe.log(\"SELFTEST world.findAllKind=\" + actors.length);",
            "  bwe.log(\"SELFTEST world.entities=\" + (bwe.world.entities().length > 0 ? \"1\" : \"0\"));",
            "",
            "  var sp = bwe.world.spawn({ x: 96, y: 128, name: \"spawned\", kind: \"PROP\",",
            "                             tags: [\"enemy\"], halfW: 8, halfH: 8 });",
            "  bwe.log(\"SELFTEST world.spawn=\" + (sp && sp.name === \"spawned\" ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST world.spawnPos=\" + sp.x + \",\" + sp.y);",
            "  bwe.log(\"SELFTEST world.spawnTag=\" + (sp.tags.has(\"enemy\") ? \"1\" : \"0\"));",
            "  var victim = bwe.world.spawn({ x: 128, y: 128, name: \"victim\" });",
            "  bwe.world.destroy(victim);",
            "  bwe.log(\"SELFTEST world.destroy=\" + (bwe.world.find(\"victim\") === null ? \"1\" : \"0\"));",
            "  var temp = bwe.world.spawn({ x: 300, y: 300, name: \"temp\", script: \"player\" });",
            "  bwe.log(\"SELFTEST world.spawnScript=\" + (temp ? \"1\" : \"0\"));",
            "  bwe.world.destroy(temp);",
            "",
            "  var c = bwe.world.find(\"crate\");",
            "  bwe.log(\"SELFTEST ent.pos=\" + c.x + \",\" + c.y);",
            "  bwe.log(\"SELFTEST ent.size=\" + c.size.w + \"x\" + c.size.h);",
            "  c.setSize(48, 64);",
            "  bwe.log(\"SELFTEST ent.size2=\" + c.size.w + \"x\" + c.size.h);",
            "  c.visible = false;",
            "  bwe.log(\"SELFTEST ent.invisible=\" + c.visible);",
            "  c.visible = true;",
            "  bwe.log(\"SELFTEST ent.alive=\" + c.alive);",
            "  bwe.log(\"SELFTEST ent.tags=\" + (c.tags.has(\"enemy\") ? \"1\" : \"0\") + (c.tags.includes(\"可交互\") ? \"1\" : \"0\"));",
            "  c.setProp(\"w\", \"48\");",
            "  c.setProp(\"h\", \"64\");",
            "  bwe.log(\"SELFTEST prop.w=\" + c.prop(\"w\", \"0\"));",
            "  var hp = c.module(\"combat.health\");",
            "  bwe.log(\"SELFTEST module.has=\" + (c.hasModule(\"combat.health\") ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST module.max=\" + hp.get(\"maxHealth\", 0));",
            "  hp.set(\"maxHealth\", \"55\");",
            "  bwe.log(\"SELFTEST module.max2=\" + hp.get(\"maxHealth\", 0));",
            "  hp.enabled = false;",
            "  bwe.log(\"SELFTEST module.off=\" + (c.hasModule(\"combat.health\") ? \"1\" : \"0\"));",
            "  hp.enabled = true;",
            "  bwe.log(\"SELFTEST module.on=\" + (c.hasModule(\"combat.health\") ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST module.list=\" + c.modules().length);",
            "  c.on(\"damage\", function (amount) {",
            "    bwe.log(\"SELFTEST ent.on=\" + (amount > 0 ? \"1\" : \"0\"));",
            "  });",
            "  c.on(\"click\", function () {",
            "    bwe.log(\"SELFTEST entity.click=1\");",
            "  });",
            "  var handle = p.attach({ asset: \"无\", dx: 0, dy: -20 });",
            "  bwe.log(\"SELFTEST attach=\" + (handle && handle.id ? \"1\" : \"0\"));",
            "  if (handle) { handle.remove(); }",
            "  c.damage(5);",
            "  bwe.log(\"SELFTEST ent.damage=\" + (c.hp < c.hpMax ? \"1\" : \"0\"));",
            "  c.heal(100);",
            "  bwe.log(\"SELFTEST ent.heal=\" + (c.hp === c.hpMax ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST ent.dist=\" + (c.distanceTo(p) > 0 ? \"1\" : \"0\"));",
            "",
            "  bwe.camera.setPos(120, 100);",
            "  bwe.camera.setZoom(2);",
            "  var sc = bwe.camera.worldToScreen(120, 100);",
            "  bwe.log(\"SELFTEST cam.screen=\" + Math.round(sc.x) + \",\" + Math.round(sc.y));",
            "  var cp = bwe.camera.pos;",
            "  bwe.log(\"SELFTEST cam.pos=\" + Math.round(cp.x) + \",\" + Math.round(cp.y));",
            "  bwe.log(\"SELFTEST cam.zoom=\" + bwe.camera.zoom);",
            "  var wp = bwe.camera.screenToWorld(640, 360);",
            "  bwe.log(\"SELFTEST cam.world=\" + Math.round(wp.x) + \",\" + Math.round(wp.y));",
            "",
            "  var cell = bwe.grid.toCell(336, 16);",
            "  bwe.log(\"SELFTEST grid.cell=\" + cell.cx + \",\" + cell.cy);",
            "  var wc = bwe.grid.toWorld(3, 4);",
            "  bwe.log(\"SELFTEST grid.world=\" + wc.x + \",\" + wc.y);",
            "  bwe.log(\"SELFTEST tilemap.cellSize=\" + bwe.grid.cellSize);",
            "  bwe.log(\"SELFTEST tilemap.get=\" + bwe.tilemap.get(10, 3));",
            "  bwe.log(\"SELFTEST tilemap.solid=\" + (bwe.tilemap.solid(10, 3) ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST tilemap.blocked=\" + (bwe.tilemap.blocked(320, 0, 32, 64) ? \"1\" : \"0\"));",
            "  var ray = bwe.tilemap.raycast(100, 48, 500, 48);",
            "  bwe.log(\"SELFTEST tilemap.raycast=\" + (ray.hit ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST nav.los=\" + (bwe.nav.lineOfSight({ x: 48, y: 48 }, { x: 200, y: 48 }) ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST nav.losWall=\" + (bwe.nav.lineOfSight({ x: 200, y: 48 }, { x: 500, y: 48 }) ? \"1\" : \"0\"));",
            "  var path = bwe.nav.find({ x: 100, y: 48 }, { x: 500, y: 48 }, {});",
            "  bwe.log(\"SELFTEST nav.find=\" + (path.length > 1 ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST nav.end=\" + Math.round(path[path.length - 1].x) + \",\" + Math.round(path[path.length - 1].y));",
            "  var follower = bwe.world.spawn({ x: 100, y: 48, name: \"follower\" });",
            "  bwe.nav.follow(follower, path, { speed: 4000, arrive: 4, onArrive: function (e) {",
            "    bwe.log(\"SELFTEST nav.arrive=1\");",
            "  } });",
            "",
            "  var near = bwe.interact.nearest(p, { radius: 200, tag: \"可交互\" });",
            "  bwe.log(\"SELFTEST interact.nearest=\" + (near ? \"1\" : \"0\"));",
            "  bwe.interact.prompt(\"按 E 交互\");",
            "  bwe.interact.setKey(\"KeyE\");",
            "  bwe.interact.onTrigger(function (target, who) {",
            "    bwe.log(\"SELFTEST interact.trigger=\" + (target ? \"1\" : \"0\"));",
            "  });",
            "",
            "  bwe.after(0.03, function () { bwe.log(\"SELFTEST time.after=1\"); });",
            "  var n = 0;",
            "  var id = bwe.every(0.03, function () {",
            "    n++;",
            "    if (n >= 2) { bwe.cancel(id); bwe.log(\"SELFTEST time.every=\" + n); }",
            "  });",
            "",
            "  bwe.log(\"SELFTEST util=\" + bwe.clamp(5, 0, 3) + \",\" + bwe.lerp(0, 10, 0.5) + \",\" + bwe.randomInt(2, 2) + \",\" + bwe.has(\"player\"));",
            "  bwe.log(\"SELFTEST call=\" + bwe.call(\"main\", \"ping\"));",
            "  bwe.log(\"SELFTEST scripts.call=\" + bwe.scripts.call(\"main\", \"ping\"));",
            "  Promise.resolve(0).then(function () { bwe.log(\"SELFTEST promise.then=1\"); });",
            "  bwe.world.on(\"ping\", function (payload) { bwe.log(\"SELFTEST world.event=\" + payload.n); });",
            "  bwe.world.emit(\"ping\", { n: 7 });",
            "",
            "  var spawnedCount = 0;",
            "  bwe.spawner.create({",
            "    count: 1, interval: 0.05, max: 2, area: { x: 0, y: 0, w: 64, h: 64 },",
            "    onSpawn: function (e) { spawnedCount++; bwe.log(\"SELFTEST spawner.spawn=\" + spawnedCount); }",
            "  });",
            "",
            "  bwe.save.set(\"score\", 42);",
            "  bwe.save.set(\"name\", \"自检\");",
            "  bwe.save.set(\"list\", [1, 2, 3]);",
            "  bwe.save.set(\"obj\", { a: 1, b: { c: \"深\" } });",
            "  bwe.log(\"SELFTEST save.write=\" + (bwe.save.write(\"auto\") ? \"1\" : \"0\"));",
            "  bwe.save.clear();",
            "  bwe.log(\"SELFTEST save.cleared=\" + (bwe.save.get(\"score\", -1) === -1 ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST save.read=\" + (bwe.save.read(\"auto\") ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST save.score=\" + bwe.save.get(\"score\", -1));",
            "  bwe.log(\"SELFTEST save.name=\" + bwe.save.get(\"name\", \"\"));",
            "  bwe.log(\"SELFTEST save.list=\" + bwe.save.get(\"list\", []).length);",
            "  bwe.log(\"SELFTEST save.obj=\" + bwe.save.get(\"obj\", {}).b.c);",
            "  bwe.log(\"SELFTEST save.exists=\" + (bwe.save.exists(\"auto\") ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST save.flush=\" + (bwe.save.flush() ? \"1\" : \"0\"));",
            "  bwe.save.write(\"slot2\");",
            "  bwe.log(\"SELFTEST save.delete=\" + (bwe.save.delete(\"slot2\") && !bwe.save.exists(\"slot2\") ? \"1\" : \"0\"));",
            "",
            "  bwe.log(\"SELFTEST audio.missing=\" + (bwe.audio.play(\"没有这个音频\") < 0 ? \"1\" : \"0\"));",
            "",
            "  bwe.on(\"click\", function (info) {",
            "    bwe.log(\"SELFTEST global.click=\" + (info.entity ? info.entity.name : \"none\"));",
            "  });",
            "}",
            "");

    private static final String PLAYER_JS = String.join("\n",
            "function onStart(ctx) {",
            "  bwe.log(\"SELFTEST player.start=\" + ctx.self.name);",
            "  bwe.log(\"SELFTEST player.ctx=\" + (ctx.self && ctx.world && ctx.time && ctx.camera && ctx.input && ctx.save ? \"1\" : \"0\"));",
            "  bwe.log(\"SELFTEST player.dtType=\" + (typeof ctx.dt));",
            "}",
            "function onUpdate(ctx, dt) {",
            "  var f = bwe.time.frame;",
            "  if (f === 1) {",
            "    bwe.log(\"SELFTEST input.down1=\" + (bwe.input.down(\"KeyD\") ? \"1\" : \"0\"));",
            "    bwe.log(\"SELFTEST input.pressed1=\" + (bwe.input.pressed(\"KeyD\") ? \"1\" : \"0\"));",
            "    bwe.log(\"SELFTEST input.axis1=\" + bwe.input.axis().x);",
            "    bwe.log(\"SELFTEST draw.measure=\" + (bwe.draw.measureText(\"abc\", 16).w > 0 ? \"1\" : \"0\"));",
            "    bwe.draw.text(10, 20, \"HUD 自检\");",
            "    bwe.draw.rect(10, 30, 100, 12, { fill: \"#ff0000\" });",
            "    bwe.draw.bar(10, 50, 100, 8, 0.5, { bg: \"#222222\", fg: \"#00ff00\" });",
            "    bwe.draw.line(0, 0, 100, 100, { color: \"#ffffff\" });",
            "    bwe.draw.circle(50, 50, 10, { fill: \"#0000ff\" });",
            "    bwe.draw.sprite(\"无\", 10, 10, { w: 8, h: 8 });",
            "    bwe.draw.world(function () { bwe.draw.rect(0, 0, 32, 32, { fill: \"#ffffff\" }); });",
            "    bwe.log(\"SELFTEST draw.recorded=1\");",
            "  }",
            "  if (f === 2) {",
            "    bwe.log(\"SELFTEST input.down2=\" + (bwe.input.down(\"KeyD\") ? \"1\" : \"0\"));",
            "    bwe.log(\"SELFTEST input.pressed2=\" + (bwe.input.pressed(\"KeyD\") ? \"1\" : \"0\"));",
            "    bwe.log(\"SELFTEST input.axis2=\" + bwe.input.axis().x);",
            "  }",
            "  if (f === 3) {",
            "    bwe.log(\"SELFTEST input.down3=\" + (bwe.input.down(\"KeyD\") ? \"1\" : \"0\"));",
            "    bwe.log(\"SELFTEST input.released3=\" + (bwe.input.released(\"KeyD\") ? \"1\" : \"0\"));",
            "  }",
            "  if (f === 4) {",
            "    bwe.log(\"SELFTEST input.mouse=\" + (typeof bwe.input.mouse.x === \"number\" ? \"1\" : \"0\"));",
            "  }",
            "  bwe.log(\"SELFTEST player.update=\" + f);",
            "}",
            "function onKey(ctx, key) {",
            "  bwe.log(\"SELFTEST player.onKey=\" + key);",
            "}",
            "function onDestroy(ctx) {",
            "  bwe.log(\"SELFTEST player.onDestroy=\" + ctx.self.name);",
            "}",
            "");

    // ---------------- 文件工具 ----------------

    private static void write(File f, String content) throws Exception {
        if (f.getParentFile() != null) {
            Files.createDirectories(f.getParentFile().toPath());
        }
        Files.write(f.toPath(), content.getBytes(StandardCharsets.UTF_8));
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) {
            return;
        }
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) {
                deleteRecursively(c);
            }
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    // ---------------- 断言 ----------------

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }

    private static void expectLog(String name, List<String> log, String needle) {
        expectLog(name, log, needle, true);
    }

    private static void expectLog(String name, List<String> log, String needle, boolean enabled) {
        if (!enabled) {
            return;
        }
        check(name, contains(log, needle), "未找到: " + needle);
    }

    private static boolean contains(List<String> log, String needle) {
        for (String line : log) {
            if (line.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    private static int countContaining(List<String> log, String needle) {
        int n = 0;
        for (String line : log) {
            if (line.contains(needle)) {
                n++;
            }
        }
        return n;
    }

    private static String firstLineContaining(List<String> log, String needle) {
        for (String line : log) {
            if (line.contains(needle)) {
                return line;
            }
        }
        return null;
    }

    private static List<String> readLog() throws Exception {
        List<String> out = new ArrayList<String>();
        File log = new File(root, "Build/bwe.log");
        if (!log.isFile()) {
            return out;
        }
        for (String line : Files.readAllLines(log.toPath(), StandardCharsets.UTF_8)) {
            out.add(line);
        }
        return out;
    }

    private static TopDownRuntime.Actor actorNamed(TopDownRuntime rt, String name) {
        for (TopDownRuntime.Actor a : rt.actors) {
            if (a.o != null && name.equals(a.o.name)) {
                return a;
            }
        }
        return null;
    }
}
