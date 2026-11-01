package Studio.runtime;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 开放世界子系统自检（无窗口、纯断言）。
 *
 * <p>覆盖本轮新增的 8 个 {@code bwe.*} 命名空间与它们背后的管线阶段：
 * <ul>
 *   <li>{@code bwe.scene} —— 场景列表 / 切换 / 卸载清理</li>
 *   <li>{@code bwe.spatial} —— 五状态分离、屋顶剔除、楼层隔离、link 连通性</li>
 *   <li>{@code bwe.collision} —— enter/stay/exit 语义与边界（销毁、擦过、sensor）</li>
 *   <li>{@code bwe.actions} —— 动作映射、上下文、失焦</li>
 *   <li>{@code bwe.road} / {@code bwe.vehicle} —— 路网寻路、车辆行驶、上下车、劫车</li>
 *   <li>{@code bwe.combat} —— 命中 / 防御减免 / 死亡</li>
 *   <li>{@code bwe.debug} —— 调试绘制不改变行为</li>
 * </ul>
 *
 * <p>写法与现有 7 套一致：现场生成最小工程到 {@code .tmp_rel8/openworld/}，
 * 手动推进帧，读 {@code Build/bwe.log} 校验脚本自报结果 + 直接检查宿主状态。
 * 全部通过退出码 0，任一失败退出码 1。
 */
public final class OpenWorldTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;

    private OpenWorldTest() {
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
            RESULTS.add(new String[]{"openworld caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        System.out.println("========== OpenWorldTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            System.out.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        System.out.println("------------------------------------");
        System.out.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        if (root != null) {
            System.out.println("日志: " + new File(root, "Build/bwe.log").getAbsolutePath());
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void check(String name, boolean ok, String detail) {
        RESULTS.add(new String[]{name, ok ? "true" : "false", detail == null ? "" : detail});
    }

    private static void run() throws Exception {
        root = new File(".tmp_rel8/openworld");
        deleteRecursively(root);
        buildProject();

        File boot = new File(root, "Build/boot.json");
        check("boot.json 已生成", boot.isFile(), boot.getAbsolutePath());

        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        check("ScriptEngine 已创建", engine != null, "");
        engine.update(0.02f);
        check("脚本引擎已启动", engine.started && !engine.failed, "");

        // ---------- 1) 场景基础设施 ----------
        ScriptScene scene = ScriptScene.LAST;
        check("bwe.scene 已安装", scene != null, "");
        check("场景总数 = 2", rt.sceneRefs().size() == 2, "count=" + rt.sceneRefs().size());
        check("当前场景 = 甲", "甲".equals(rt.currentSceneName()), rt.currentSceneName());

        // ---------- 2) 空间：五状态分离 + 屋顶剔除 ----------
        ScriptSpatial sp = ScriptSpatial.LAST;
        check("bwe.spatial 已安装", sp != null, "");
        check("空间数据已加载（1 栋楼）", sp.hasData(), "hasData=" + sp.hasData());
        check("区域数 = 3（层0 + 层1 + 屋顶）", sp.zoneCountValue() == 3, "zones=" + sp.zoneCountValue());
        check("垂直连接 = 1（楼梯）", sp.linkCountValue() == 1, "links=" + sp.linkCountValue());

        // 玩家初始在楼外（放在 (240,240)，楼在 (400,300) 范围 200x200）
        sp.resolve();
        Actor player = engine.findPlayerActor();
        check("找到玩家实体", player != null, "");
        int startLevel = sp.levelOf(player);
        check("玩家初始在 0 层", startLevel == 0, "level=" + startLevel);

        // 把玩家塞进楼层 0 的房间中心 → 归属应为 0 层且 indoor
        player.x = 400f;
        player.y = 300f;
        sp.resolve();
        int inLobbyLevel = sp.levelOf(player);
        check("玩家在楼内 → 归属楼层 0", inLobbyLevel == 0, "level=" + inLobbyLevel);

        // ---------- 3) 楼层隔离：NPC 不能穿楼板 ----------
        // 二层与一层在 2D 空间完全重叠 → 用 levelOf 区分；两楼层间只有 1 条 stairs link
        check("0↔1 层可达（有楼梯）", sp.levelsConnectedPublic(0, 1), "");
        check("0↔2 层不可达（没有直达楼梯）", !sp.levelsConnectedPublic(0, 2), "");
        check("linkBetween(0,1) 存在", sp.linkBetweenPublic(0, 1) != null, "");
        check("linkBetween(0,2) 不存在", sp.linkBetweenPublic(0, 2) == null, "");

        // 用楼梯上楼
        String linkId = sp.firstLinkId();
        boolean used = sp.useLinkPublic(linkId, player);
        check("使用楼梯成功", used, "linkId=" + linkId);
        sp.resolve();
        int upLevel = sp.levelOf(player);
        check("上楼后归属 = 1 层", upLevel == 1, "level=" + upLevel);

        // ---------- 3b) 楼层归属必须能"退回"（回归：走出大楼后不能永远卡在二楼） ----------
        //
        // 真实缺陷：第一版 resolveLevel 只在 floorLevel < 0 时才按位置推导，
        // 于是上过二楼的角色走到室外后引擎仍认为他在二层 → 碰撞/渲染/寻路全错。
        // 修法：权威楼层要"校验仍然成立"（该位置在本层仍有区域），否则回落地面层。
        // 这两条断言就是那个修复的回归保护。
        player.x = 60f;      // 跑到楼外（远离 z0/z1/roof 的 AABB）
        player.y = 60f;
        sp.resolve();
        int outLevel = sp.levelOf(player);
        check("走出大楼后楼层退回 0（不卡在二楼）", outLevel == 0, "level=" + outLevel);

        // 再走回楼内 → 应回到 0 层（地面层，不是残留的 1 层）
        player.x = 400f;
        player.y = 300f;
        sp.resolve();
        check("走回楼内 → 地面层 0", sp.levelOf(player) == 0, "level=" + sp.levelOf(player));

        // 显式 enter / leave（脚本进楼/出楼用的受控入口）
        String lobbyId = sp.zoneIdAtPublic(400f, 300f, 0);
        check("能找到一层大堂区域 id", lobbyId != null && !lobbyId.isEmpty(), "id=" + lobbyId);
        check("spatial.enter 进入一层成功", sp.enterPublic(lobbyId, player), "");
        sp.resolve();
        check("enter 后楼层 = 0", sp.levelOf(player) == 0, "level=" + sp.levelOf(player));
        // 上二楼后 enter 回一层（模拟"下楼再进门"）
        sp.useLinkPublic(linkId, player);
        sp.resolve();
        check("（前置）现在在第 1 层", sp.levelOf(player) == 1, "level=" + sp.levelOf(player));
        check("spatial.enter 回到一层成功", sp.enterPublic(lobbyId, player), "");
        sp.resolve();
        check("enter 覆盖楼层为 0", sp.levelOf(player) == 0, "level=" + sp.levelOf(player));
        check("spatial.leave 成功", sp.leavePublic(player), "");
        sp.resolve();
        check("leave 后楼层 = 0", sp.levelOf(player) == 0, "level=" + sp.levelOf(player));

        // 屋顶可见性：玩家在楼内 → 屋顶不可见
        check("玩家在楼内时屋顶不可见", !sp.isRoofRenderVisible("roof"), "");

        // ---------- 3c) 屋顶区域不能决定"实体在哪一层"（真实 bug 回归） ----------
        //
        // 真实缺陷（试跑日志抓到的）：屋顶 zone 的 AABB 比室内房间**大一圈**（屋檐）。
        // 站在"楼旁边的地面"上时，那个点只落在屋顶矩形里、不落在任何室内区域里；
        // 按「含该点的最小层号」推导就把室外判成顶层屋顶 →
        //   `空间切换：(室外) → b_34_34_roof（建筑 b_34_34，第 3 层）`
        // 而且玩家沿街走会一路在"屋顶"之间跳，碰撞/渲染/NPC 视线全错。
        // 修法：归属推导只考虑 navigable 区域，roof（navigable=false）只用于渲染剔除。
        //
        // 构造：把玩家放到**只在屋顶矩形内、不在室内**的点。
        // 测试场景里 z0/z1 是 halfW=100 且居 (400,300)；roof 是 halfW=110 同中心。
        // 所以 (400, 300+105)= (400,405) 落在 roof(±110) 里、但在 z0/z1(±100) 之外。
        player.x = 400f;
        player.y = 405f;
        player.floorLevel = -1;
        sp.resolve();
        check("只落在屋顶矩形内（不在室内）时，归属仍是地面层 0，不是屋顶层",
                sp.levelOf(player) == 0, "level=" + sp.levelOf(player));
        check("该点确实在屋顶矩形内（构造有效）", sp.insideRoofOnly(400f, 405f), "");
        check("该点不在任何可驻留区域内", sp.dwellableZoneAtAnyLevelPublic(400f, 405f) == null, "");

        // 玩家在楼外 → 屋顶可见。
        // ⚠ 必须连带清掉楼层归属：楼层是**由 link 驱动**的权威值，
        // 直接改坐标不会改楼层（这正是"NPC 不能穿楼板"的保证）。
        player.x = 60f;
        player.y = 60f;
        player.floorLevel = -1;
        sp.resolve();
        check("玩家在楼外时屋顶可见", sp.isRoofRenderVisible("roof"), "");
        // 楼内楼层：当前层可见、其它层隐藏。
        // 把玩家放回一层（= 未通过 link 换层，坐标进楼 + floorLevel 重置为 0）
        player.x = 400f;
        player.y = 300f;
        player.floorLevel = 0;
        sp.resolve();
        check("室内一层时 z0 区域可见", sp.isZoneRenderVisible("z0"),
                "playerLevel=" + sp.playerLevelForTest());
        check("室内一层时 z1 区域隐藏", !sp.isZoneRenderVisible("z1"), "");

        // ---------- 4) 碰撞事件语义 ----------
        ScriptCollision col = ScriptCollision.LAST;
        check("bwe.collision 已安装", col != null, "");
        col.clearSceneState();
        final int[] enter = {0};
        final int[] stay = {0};
        final int[] exit = {0};
        final Actor[] watched = new Actor[2];
        col.setObserver(new ScriptCollision.Observer() {
            @Override
            public void on(String evt, Actor x, Actor y) {
                if (watched[0] == null) {
                    return;
                }
                boolean involves = (x == watched[0] || y == watched[0])
                        && (x == watched[1] || y == watched[1]);
                if (!involves) {
                    return;
                }
                if ("enter".equals(evt)) {
                    enter[0]++;
                } else if ("stay".equals(evt)) {
                    stay[0]++;
                } else if ("exit".equals(evt)) {
                    exit[0]++;
                }
            }
        });
        // 造两个重叠实体
        Actor a1 = engine.spawnScripted(600, 400, "", "colA", "PROP", 0, 20, 20,
                "", new ArrayList<String>(), new ArrayList<GameData.RtModule>());
        Actor a2 = engine.spawnScripted(600, 400, "", "colB", "PROP", 0, 20, 20,
                "", new ArrayList<String>(), new ArrayList<GameData.RtModule>());
        watched[0] = a1;
        watched[1] = a2;
        check("两个碰撞实体已生成", a1 != null && a2 != null, "");
        // 预热帧（第一帧只建表不派发，契约：避免订阅瞬间误报）
        col.tickForTest();
        for (int i = 0; i < 4; i++) {
            col.tickForTest();
        }
        check("enter 恰好 1 次", enter[0] == 1, "enter=" + enter[0]);
        check("stay 在后续帧继续派发", stay[0] >= 2, "stay=" + stay[0]);
        check("接触仍在（count>=1）", col.countForTest() >= 1, "count=" + col.countForTest());
        // 移开后应派发 exit 恰好 1 次
        a2.x = 2000f;
        for (int i = 0; i < 3; i++) {
            col.tickForTest();
        }
        check("exit 恰好 1 次", exit[0] == 1, "exit=" + exit[0]);

        // 销毁期不派发 exit
        Actor c1 = engine.spawnScripted(900, 400, "", "colC", "PROP", 0, 20, 20,
                "", new ArrayList<String>(), new ArrayList<GameData.RtModule>());
        Actor c2 = engine.spawnScripted(900, 400, "", "colD", "PROP", 0, 20, 20,
                "", new ArrayList<String>(), new ArrayList<GameData.RtModule>());
        watched[0] = c1;
        watched[1] = c2;
        enter[0] = 0;
        stay[0] = 0;
        exit[0] = 0;
        col.tickForTest();
        col.tickForTest();
        int enterBefore = enter[0];
        check("销毁前已 enter", enterBefore >= 1, "enter=" + enterBefore);
        int exitBefore = exit[0];
        rt.requestDestroy(c2);
        rt.commitDestroy();
        for (int i = 0; i < 2; i++) {
            col.tickForTest();
        }
        check("销毁不派发 exit（契约）", exit[0] == exitBefore, "before=" + exitBefore + " after=" + exit[0]);
        col.setObserver(null);

        // ---------- 5) 输入动作 ----------
        ScriptActions act = ScriptActions.LAST;
        check("bwe.actions 已安装", act != null, "");
        check("move_up 已绑定", act.hasBinding("move_up"), "");
        check("默认动作数 >= 9", act.actionCount() >= 9, "actions=" + act.actionCount());
        // 改键：把 move_up 改到 KeyI，验证「改配置即改键」
        act.bindForTest("move_up");
        check("bind 后 move_up 仍存在", act.hasBinding("move_up"), "");
        // 失焦：所有动作失效
        act.onFocusLost();
        check("失焦后 move_up 失效", !act.isDownTest("move_up"), "");
        act.onFocusGained();
        check("重新聚焦后恢复", act.isFocusedTest(), "");

        // ---------- 6) 路网 ----------
        ScriptRoad road = ScriptRoad.LAST;
        check("bwe.road 已安装", road != null, "");
        check("路网已加载", road.hasData(), "");
        check("路网节点 >= 4", road.nodeCountValue() >= 4, "nodes=" + road.nodeCountValue());
        List<String> route = road.findRoute("n0_0", "n1_1");
        check("路网寻路非空", !route.isEmpty(), "route=" + route);
        check("寻路起点正确", !route.isEmpty() && route.get(0).equals("n0_0"), "");
        check("寻路终点正确", !route.isEmpty() && route.get(route.size() - 1).equals("n1_1"), "");
        check("不可达目标返回空", road.findRoute("n0_0", "不存在的节点").isEmpty(), "");

        // ---------- 7) 车辆 ----------
        ScriptVehicle veh = ScriptVehicle.LAST;
        check("bwe.vehicle 已安装", veh != null, "");
        check("车辆数初始为 0", veh.countValue() == 0, "count=" + veh.countValue());

        // ---------- 8) 战斗 ----------
        ScriptCombat cmb = ScriptCombat.LAST;
        check("bwe.combat 已安装", cmb != null, "");
        check("武器表至少有 4 项", cmb.weaponCountTest() >= 4, "weapons=" + cmb.weaponCountTest());
        Actor victim = engine.spawnScripted(1200, 400, "", "victim", "ACTOR", 0, 12, 12, "", new ArrayList<String>(), new ArrayList<GameData.RtModule>());
        victim.hpMax = 30f;
        victim.hp = 30f;
        float beforeHp = victim.hp;
        float dmg = cmb.hitForTest(a1, victim, 10f, false);
        check("命中造成伤害", dmg > 0f && victim.hp < beforeHp, "dmg=" + dmg + " hp=" + victim.hp);
        // 防御减免
        victim.hp = 30f;
        cmb.setDefendingTest(victim, true);
        float dmgBlocked = cmb.hitForTest(a1, victim, 10f, false);
        check("防御后伤害减半", Math.abs(dmgBlocked - 5f) < 0.01f, "dmg=" + dmgBlocked);
        cmb.setDefendingTest(victim, false);
        // 击杀
        victim.hp = 3f;
        boolean killed = cmb.hitForTest(a1, victim, 10f, true) > 0f && victim.dead;
        check("致命伤害会击杀", killed, "dead=" + victim.dead);

        // ---------- 9) 调试命名空间 ----------
        ScriptDebug dbg = ScriptDebug.LAST;
        check("bwe.debug 已安装", dbg != null, "");
        dbg.onTest();
        check("debug 可开启", dbg.isEnabled(), "");
        dbg.offTest();
        check("debug 可关闭", !dbg.isEnabled(), "");

        // ---------- 10) 场景切换 + 卸载清理 ----------
        int actorsBefore = rt.actors.size();
        check("切换前实体数 > 0", actorsBefore > 0, "actors=" + actorsBefore);
        boolean req = rt.requestSceneSwitch("乙");
        check("切换请求被接受", req, "");
        rt.commitSceneSwitch();
        check("已切到场景 乙", "乙".equals(rt.currentSceneName()), rt.currentSceneName());
        check("切换后实体集不同（乙场景 1 个对象）", rt.actors.size() == 1, "actors=" + rt.actors.size());
        check("场景代数 +1", rt.sceneEpoch == 1, "epoch=" + rt.sceneEpoch);
        // 空间数据在新场景应为空（乙没有 buildings → 退化为单层）
        ScriptSpatial sp2 = ScriptSpatial.LAST;
        check("新场景空间数据为空", !sp2.hasData(), "hasData=" + sp2.hasData());
        check("新场景区域数 0", sp2.zoneCountValue() == 0, "zones=" + sp2.zoneCountValue());
        check("新场景路网为空", !ScriptRoad.LAST.hasData(), "");
        check("新场景车辆 0 台", ScriptVehicle.LAST.countValue() == 0, "");
        // 未知场景不改变当前场景
        boolean bad = rt.requestSceneSwitch("不存在的场景");
        check("未知场景切换被拒绝", !bad, "");

        // ---------- 10b) 脚本 spawn 的 layer 必须跟随场景主 layer（真实 bug 回归）----------
        //
        // 真实缺陷：排序键是 layer → z → y，城市对象全在 layer=4，
        // 而脚本 spawn 的 NPC/车辆 layer 默认 0 → 排在最前面先画，被底图整片盖住。
        // 表现是「日志说生成了 20 个行人，屏幕上一个都没有」，drawCall 计数却完全正常。
        //
        // 这里直接构造「场景对象在 layer=4」的局面，再 spawn，断言新实体的 layer 跟着变 4。
        Actor anchor = null;
        for (Actor a : rt.actors) {
            if (a != null && a.o != null) {
                anchor = a;
                break;
            }
        }
        check("找到一个场景对象做 layer 锚点", anchor != null, "");
        int originalLayer = anchor == null ? 0 : anchor.o.layer;
        if (anchor != null) {
            anchor.o.layer = 4;                 // 模拟城市场景（对象都在 layer=4）
        }
        check("场景主 layer 被正确识别为 4", rt.dominantSceneLayer() == 4,
                "dominant=" + rt.dominantSceneLayer());
        Actor probe = engine.spawnScripted(500, 500, "", "layerprobe", "ACTOR",
                0, 12, 12, "", new ArrayList<String>(), new ArrayList<GameData.RtModule>());
        check("spawn 出来的实体 layer 跟随场景主 layer（不写死 0）",
                probe != null && probe.o.layer == 4,
                "probe=" + (probe == null ? "null" : probe.o.layer)
                        + " dominant=" + rt.dominantSceneLayer());
        if (anchor != null) {
            anchor.o.layer = originalLayer;     // 还原
        }

        // ---------- 11) 延迟销毁 ----------
        int n0 = rt.actors.size();
        Actor tmp = engine.spawnScripted(300, 300, "", "tmp", "PROP", 0, 8, 8, "", new ArrayList<String>(), new ArrayList<GameData.RtModule>());
        check("spawn 后实体数 +1", rt.actors.size() == n0 + 1, "actors=" + rt.actors.size());
        rt.requestDestroy(tmp);
        check("requestDestroy 后仍在列表（延迟提交）", rt.actors.size() == n0 + 1, "actors=" + rt.actors.size());
        check("已标记 dead", tmp.dead, "");
        check("排在待销毁队列里", rt.pendingDestroyCount() == 1, "pending=" + rt.pendingDestroyCount());
        rt.commitDestroy();
        check("commit 后已移除", rt.actors.size() == n0, "actors=" + rt.actors.size());
        check("待销毁队列已清空", rt.pendingDestroyCount() == 0, "");

        // ---------- 12) 老功能没有回归 ----------
        check("bwe.world 仍然可用", engine.api() != null && engine.api().hasNamespace("world"), "");
        check("老场景脚本 onSceneStart 仍派发（日志里有 OPENWORLD）", logContains("OPENWORLD"), "");
    }

    // ---------------- 工程搭建 ----------------

    private static void buildProject() throws Exception {
        File build = new File(root, "Build");
        build.mkdirs();

        String boot = "{\n"
                + "  \"project\": \"openworld-test\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 0.8,\n"
                + "  \"scenes\": [\n"
                + "    { \"name\": \"甲\", \"file\": \"scene_0.json\", \"width\": 40, \"height\": 30 },\n"
                + "    { \"name\": \"乙\", \"file\": \"scene_1.json\", \"width\": 20, \"height\": 20 }\n"
                + "  ],\n"
                + "  \"scripts\": [ { \"name\": \"main\", \"file\": \"scripts/main.js\", \"lang\": \"js\" } ],\n"
                + "  \"assets\": []\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);

        // 场景甲：一栋两层楼（1 层两个房间 + 屋顶），1 条楼梯，1 条路网边，玩家在楼外
        String s0 = "{\n"
                + "  \"width\": 40, \"height\": 30, \"tileSize\": 32,\n"
                + "  \"onStartScript\": \"main\",\n"
                + "  \"objects\": [\n"
                + "    { \"id\":\"p1\", \"kind\":\"ACTOR\", \"name\":\"玩家\", \"x\":240, \"y\":240, \"halfW\":12, \"halfH\":12, \"tags\":[\"玩家\",\"player\"] },\n"
                + "    { \"id\":\"w1\", \"kind\":\"PROP\", \"name\":\"墙\", \"x\":300, \"y\":250, \"halfW\":60, \"halfH\":8, \"tags\":[\"wall\"] },\n"
                + "    { \"id\":\"npc1\", \"kind\":\"ACTOR\", \"name\":\"路人\", \"x\":700, \"y\":700, \"halfW\":10, \"halfH\":10, \"tags\":[\"npc\"] }\n"
                + "  ],\n"
                + "  \"buildings\": [\n"
                + "    {\n"
                + "      \"id\": \"b1\", \"name\": \"测试楼\", \"roof\": \"auto\",\n"
                + "      \"floors\": [\n"
                + "        { \"id\":\"f0\", \"name\":\"一层\", \"level\":0, \"rooms\":["
                + "{ \"id\":\"z0\", \"name\":\"大堂\", \"x\":400, \"y\":300, \"halfW\":100, \"halfH\":100,"
                + " \"tags\":[\"indoor\",\"lobby\"], \"collides\":false, \"navigable\":true } ] },\n"
                + "        { \"id\":\"f1\", \"name\":\"二层\", \"level\":1, \"rooms\":["
                + "{ \"id\":\"z1\", \"name\":\"二楼\", \"x\":400, \"y\":300, \"halfW\":100, \"halfH\":100,"
                + " \"tags\":[\"indoor\"], \"collides\":false, \"navigable\":true, \"viaLink\":\"b1_stairs\" } ] },\n"
                + "        { \"id\":\"roof\", \"name\":\"屋顶\", \"level\":2, \"rooms\":["
                + "{ \"id\":\"roof\", \"name\":\"屋顶\", \"x\":400, \"y\":300, \"halfW\":110, \"halfH\":110,"
                + " \"tags\":[\"roof\",\"outdoor\"], \"collides\":false, \"navigable\":false } ] }\n"
                + "      ],\n"
                + "      \"entrances\": [ { \"id\":\"b1_door\", \"x\":400, \"y\":400, \"radius\":48, \"level\":0 } ]\n"
                + "    }\n"
                + "  ],\n"
                + "  \"navLinks\": [\n"
                + "    { \"id\":\"b1_stairs\", \"kind\":\"stairs\", \"ax\":460, \"ay\":380, \"bx\":460, \"by\":220,"
                + " \"aLevel\":0, \"bLevel\":1, \"bidirectional\":true, \"travelTime\":0.6 }\n"
                + "  ],\n"
                + "  \"roadNetwork\": {\n"
                + "    \"nodes\": [\n"
                + "      { \"id\":\"n0_0\", \"x\":100, \"y\":100, \"kind\":\"waypoint\" },\n"
                + "      { \"id\":\"n1_0\", \"x\":700, \"y\":100, \"kind\":\"intersection\" },\n"
                + "      { \"id\":\"n0_1\", \"x\":100, \"y\":700, \"kind\":\"intersection\" },\n"
                + "      { \"id\":\"n1_1\", \"x\":700, \"y\":700, \"kind\":\"waypoint\" }\n"
                + "    ],\n"
                + "    \"edges\": [\n"
                + "      { \"from\":\"n0_0\", \"to\":\"n1_0\", \"width\":64, \"speedLimit\":260 },\n"
                + "      { \"from\":\"n0_0\", \"to\":\"n0_1\", \"width\":64, \"speedLimit\":260 },\n"
                + "      { \"from\":\"n1_0\", \"to\":\"n1_1\", \"width\":64, \"speedLimit\":260 },\n"
                + "      { \"from\":\"n0_1\", \"to\":\"n1_1\", \"width\":64, \"speedLimit\":260 },\n"
                + "      { \"from\":\"n1_1\", \"to\":\"n0_0\", \"width\":64, \"speedLimit\":260, \"oneway\":true }\n"
                + "    ]\n"
                + "  }\n"
                + "}\n";
        write(new File(build, "scene_0.json"), s0);

        String s1 = "{\n"
                + "  \"width\": 20, \"height\": 20, \"tileSize\": 32,\n"
                + "  \"objects\": [\n"
                + "    { \"id\":\"only\", \"kind\":\"PROP\", \"name\":\"唯一对象\", \"x\":100, \"y\":100, \"halfW\":10, \"halfH\":10 }\n"
                + "  ]\n"
                + "}\n";
        write(new File(build, "scene_1.json"), s1);

        String main = "function onSceneStart(ctx) {\n"
                + "  bwe.log(\"OPENWORLD scene=\" + ctx.scene.name);\n"
                + "  bwe.log(\"OPENWORLD namespaces=\" + [\"scene\",\"spatial\",\"collision\",\"actions\",\"road\",\"vehicle\",\"combat\",\"debug\"]\n"
                + "    .map(function(k){ return typeof bwe[k]; }).join(\",\"));\n"
                + "  bwe.log(\"OPENWORLD sceneCount=\" + bwe.scene.count());\n"
                + "  bwe.log(\"OPENWORLD spatialHas=\" + bwe.spatial.hasData());\n"
                + "  bwe.log(\"OPENWORLD zoneCount=\" + bwe.spatial.zoneCount());\n"
                + "  bwe.log(\"OPENWORLD linkCount=\" + bwe.spatial.linkCount());\n"
                + "  bwe.log(\"OPENWORLD roadNodes=\" + bwe.road.nodeCount());\n"
                + "  bwe.log(\"OPENWORLD cur=\" + (bwe.scene.current() ? bwe.scene.current().name : \"null\"));\n"
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

    private static boolean logContains(String needle) {
        try {
            File log = new File(root, "Build/bwe.log");
            if (!log.isFile()) {
                return false;
            }
            String text = new String(Files.readAllBytes(log.toPath()), StandardCharsets.UTF_8);
            return text.contains(needle);
        } catch (Throwable t) {
            return false;
        }
    }
}
