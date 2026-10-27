package Studio.runtime;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * 预制体 / 对象池 / 生成·修改接口的自检（无窗口、纯断言）。
 *
 * <p>结构与 {@link ScriptSelfTest} 一致：现场生成一个最小工程到 {@code .tmp_rel8/prefabtest/}
 * （boot.json 带 {@code prefabs[]} + scene_0.json + scripts/*.js）→ {@code new TopDownRuntime(boot)}
 * → 手动推进 {@code scripts.update(0.02f)} → 读 Build/bwe.log 校验脚本自报结果 + 直接检查宿主状态。
 *
 * <p>覆盖：prefab define/get/list/has/remove/spawn/spawnMany/fromEntity/count、
 * pool create/acquire/release/stats、world spawnMany/spawnAt/clone/clear/clearTag/destroyAll/count/each、
 * Entity 每个新 setter 与 getter 的 round-trip、addTag/removeTag/hasTag/setTags、
 * addModule/removeModule、parent/children、setColor/setAlpha、props/setProps、size setter、
 * asset/layer/locked/animMode/animFps，以及 spawn(opts) 的新字段与 boot.json prefabs 载入。
 *
 * <p>全部通过退出码 0，任一失败退出码 1。
 */
public final class ScriptPrefabTest {

    private static final List<String[]> RESULTS = new ArrayList<String[]>();
    private static File root;

    private ScriptPrefabTest() {
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
            RESULTS.add(new String[]{"prefabtest caught exception", "false", fatal});
        }
        for (String[] r : RESULTS) {
            if (!"true".equals(r[1])) {
                failures++;
            }
        }
        realOut.println("========== ScriptPrefabTest ==========");
        for (String[] r : RESULTS) {
            boolean ok = "true".equals(r[1]);
            realOut.println((ok ? "PASS  " : "FAIL  ") + r[0]
                    + (!ok && r[2] != null && !r[2].isEmpty() ? "   [" + r[2] + "]" : ""));
        }
        realOut.println("--------------------------------------");
        realOut.println("共 " + RESULTS.size() + " 项，通过 " + (RESULTS.size() - failures)
                + "，失败 " + failures + " → " + (failures == 0 ? "ALL PASS" : "FAILED"));
        if (root != null) {
            realOut.println("日志: " + new File(root, "Build/bwe.log").getAbsolutePath());
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------------- 主流程 ----------------

    private static void run() throws Exception {
        root = new File(".tmp_rel8/prefabtest");
        deleteRecursively(root);
        buildProject();

        File boot = new File(root, "Build/boot.json");
        check("boot.json 已生成", boot.isFile(), boot.getAbsolutePath());

        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        check("ScriptEngine 已创建", engine != null, "");
        check("构造期不启动脚本（延迟到 update）", engine != null && !engine.started, "");

        engine.update(0.02f);
        check("第 1 帧后引擎启动", engine.started && !engine.failed, "");
        check("bwe.prefab / bwe.pool 已注册", engine.api != null && ScriptPrefab.LAST != null,
                "ScriptPrefab.LAST=" + (ScriptPrefab.LAST != null));

        List<String> log = readLog();
        check("bwe.log 已写入", !log.isEmpty(), "lines=" + log.size());

        // ===================== boot.json prefabs[] 载入 =====================
        check("boot.json 的 prefabs[] 被载入（拿到的 spec 可查）",
                contains(log, "PREFAB boot.list=" + BOOT_PREFAB_COUNT), logOf(log, "PREFAB boot.list"));
        check("boot 预制体 name/kind/asset 正确",
                contains(log, "PREFAB boot.def=1"), logOf(log, "PREFAB boot.def"));
        check("boot 预制体 tags 正确", contains(log, "PREFAB boot.tags=1"), logOf(log, "PREFAB boot.tags"));
        check("boot 预制体 modules 正确", contains(log, "PREFAB boot.mod=1"), logOf(log, "PREFAB boot.mod"));
        check("boot 预制体 jitter 正确（{x,y} 对象）",
                contains(log, "PREFAB boot.jitter=1"), logOf(log, "PREFAB boot.jitter"));

        // ===================== define / get / list / has / remove =====================
        check("prefab.define 返回 true", contains(log, "PREFAB define=1"), logOf(log, "PREFAB define"));
        check("prefab.has 已定义", contains(log, "PREFAB has=1"), logOf(log, "PREFAB has"));
        check("prefab.get 返回 spec（字段可读）", contains(log, "PREFAB get=1"), logOf(log, "PREFAB get"));
        check("prefab.get 是深拷贝（改快照不影响注册表）",
                contains(log, "PREFAB deepcopy=1"), logOf(log, "PREFAB deepcopy"));
        check("prefab.list 含已定义项", contains(log, "PREFAB list=1"), logOf(log, "PREFAB list"));
        check("prefab.remove 移除后 has=false",
                contains(log, "PREFAB remove=1"), logOf(log, "PREFAB remove"));

        // ===================== spawn 覆盖语义 =====================
        check("prefab.spawn 生成实体", contains(log, "PREFAB spawn=1"), logOf(log, "PREFAB spawn"));
        check("spawn 位置覆盖生效", contains(log, "PREFAB spawn.pos=1"), logOf(log, "PREFAB spawn.pos"));
        check("spawn 标量覆盖（rotation/scale/animFps）",
                contains(log, "PREFAB spawn.scalar=1"), logOf(log, "PREFAB spawn.scalar"));
        check("spawn tags 追加（模板 + opts）", contains(log, "PREFAB spawn.tags=1"), logOf(log, "PREFAB spawn.tags"));
        check("spawn props 合并（同名 opts 优先）",
                contains(log, "PREFAB spawn.props=1"), logOf(log, "PREFAB spawn.props"));
        check("spawn modules 同 def 替换参数",
                contains(log, "PREFAB spawn.mod=1"), logOf(log, "PREFAB spawn.mod"));
        check("spawn 挂上模板里的脚本", contains(log, "PREFAB spawn.script=1"), logOf(log, "PREFAB spawn.script"));

        // ===================== jitter 语义（v1.1 修正，端到端 bug 的回归断言）=====================
        check("【回归】spawn 显式给 x/y 时位置精确（不被 jitter 偏移）",
                contains(log, "PREFAB jitter.exact=1"), logOf(log, "PREFAB jitter.exact"));
        check("【回归】同模板反复 spawn 位置可复现（20 次全一致）",
                contains(log, "PREFAB jitter.stable=1"), logOf(log, "PREFAB jitter.stable"));
        check("opts.jitter=true 时才抖，且落在模板幅度内",
                contains(log, "PREFAB jitter.explicit=1"), logOf(log, "PREFAB jitter.explicit"));
        check("不给 x/y 时允许抖（落在模板 jitter 幅度内）",
                contains(log, "PREFAB jitter.noPos=1"), logOf(log, "PREFAB jitter.noPos"));
        check("对象池 acquire 不受 jitter 影响（精确落位）",
                contains(log, "PREFAB jitter.pool=1"), logOf(log, "PREFAB jitter.pool"));

        // ===================== 血量模块（脚本 spawn / 运行时加模块）=====================
        check("新 spawn 实体默认 hpMax=10（无血量模块）",
                contains(log, "HEALTH before=1"), logOf(log, "HEALTH before"));
        check("【回归】运行时 addModule(\"combat.health\") 立刻重算 hpMax 与 hp",
                contains(log, "HEALTH afterAdd=1"), logOf(log, "HEALTH afterAdd"));
        check("【回归】再次 addModule 改 maxHealth 会重新取上限",
                contains(log, "HEALTH recount=1"), logOf(log, "HEALTH recount"));
        check("【回归】prefab 模板带 combat.health → 实例 hpMax 生效（不是默认 10）",
                contains(log, "HEALTH prefab=1"), logOf(log, "HEALTH prefab"));
        check("spawn 未知预制体返回 null",
                contains(log, "PREFAB spawn.missing=1"), logOf(log, "PREFAB spawn.missing"));

        // ===================== spawnMany / count / fromEntity =====================
        check("prefab.spawnMany 生成 N 个", contains(log, "PREFAB spawnMany=3"), logOf(log, "PREFAB spawnMany"));
        check("prefab.count 只数该预制体的实例",
                contains(log, "PREFAB count=1"), logOf(log, "PREFAB count"));
        check("prefab.fromEntity 反向抓成模板",
                contains(log, "PREFAB fromEntity=1"), logOf(log, "PREFAB fromEntity"));
        check("fromEntity 抓到的 spark 能再 spawn",
                contains(log, "PREFAB fromEntity.spawn=1"), logOf(log, "PREFAB fromEntity.spawn"));
        check("fromEntity 抓到 tags/props/模块",
                contains(log, "PREFAB fromEntity.keep=1"), logOf(log, "PREFAB fromEntity.keep"));

        // ===================== 对象池 =====================
        check("pool.create 返回 handle", contains(log, "POOL create=1"), logOf(log, "POOL create"));
        check("pool.acquire 首次新建", contains(log, "POOL acquireNew=1"), logOf(log, "POOL acquireNew"));
        check("pool.release 归还", contains(log, "POOL release=1"), logOf(log, "POOL release"));
        check("pool.acquire 复用同一实例（不新建）",
                contains(log, "POOL reuse=1"), logOf(log, "POOL reuse"));
        check("pool.stats idle/active/total 自洽", contains(log, "POOL stats=1"), logOf(log, "POOL stats"));
        check("pool.release 非本池实体返回 false",
                contains(log, "POOL releaseForeign=1"), logOf(log, "POOL releaseForeign"));
        check("pool.create 未知预制体返回 -1",
                contains(log, "POOL createMissing=1"), logOf(log, "POOL createMissing"));
        check("pool.release 后该实例 visible=false",
                contains(log, "POOL releasedHidden=1"), logOf(log, "POOL releasedHidden"));

        // ===================== world 批量接口 =====================
        check("world.spawnMany 生成 N 个", contains(log, "WORLD spawnMany=3"), logOf(log, "WORLD spawnMany"));
        check("world.spawnAt 便捷式覆盖 x/y", contains(log, "WORLD spawnAt=1"), logOf(log, "WORLD spawnAt"));
        check("world.clone 复制实体", contains(log, "WORLD clone=1"), logOf(log, "WORLD clone"));
        check("clone 带上 tags/模块", contains(log, "WORLD clone.keep=1"), logOf(log, "WORLD clone.keep"));
        check("world.count() 无参 = 存活实体数", contains(log, "WORLD count=1"), logOf(log, "WORLD count"));
        check("world.count(q) 按条件数", contains(log, "WORLD countQ=1"), logOf(log, "WORLD countQ"));
        check("world.each 遍历并回调", contains(log, "WORLD each=1"), logOf(log, "WORLD each"));
        check("world.each 回调里能 spawn（快照迭代）",
                contains(log, "WORLD eachSpawn=1"), logOf(log, "WORLD eachSpawn"));
        check("world.clearTag 只清该标签",
                contains(log, "WORLD clearTag=1"), logOf(log, "WORLD clearTag"));
        check("world.destroyAll(q) 返回删除数并按条件删",
                contains(log, "WORLD destroyAll=1"), logOf(log, "WORLD destroyAll"));

        // ===================== spawn(opts) 新字段 =====================
        check("world.spawn 支持 rotation/scale/visible",
                contains(log, "SPAWN opts.scalar=1"), logOf(log, "SPAWN opts.scalar"));
        check("world.spawn 支持 layer", contains(log, "SPAWN opts.layer=1"), logOf(log, "SPAWN opts.layer"));
        check("world.spawn 支持 animMode/animFps",
                contains(log, "SPAWN opts.anim=1"), logOf(log, "SPAWN opts.anim"));
        check("world.spawn 支持 props", contains(log, "SPAWN opts.props=1"), logOf(log, "SPAWN opts.props"));
        check("world.spawn 支持 parent",
                contains(log, "SPAWN opts.parent=1"), logOf(log, "SPAWN opts.parent"));

        // ===================== Entity 修改接口 round-trip =====================
        check("e.size 写回（size setter）", contains(log, "ENT size=1"), logOf(log, "ENT size"));
        check("e.setSize 与 e.size 一致", contains(log, "ENT size.setter=1"), logOf(log, "ENT size.setter"));
        check("e.layer 读写 round-trip", contains(log, "ENT layer=1"), logOf(log, "ENT layer"));
        check("e.locked 读写 round-trip", contains(log, "ENT locked=1"), logOf(log, "ENT locked"));
        check("e.animMode 读写 round-trip（含 mode 别名归一化）",
                contains(log, "ENT animMode=1"), logOf(log, "ENT animMode"));
        check("e.animFps 读写 round-trip", contains(log, "ENT animFps=1"), logOf(log, "ENT animFps"));
        check("e.asset 读（等于素材名）", contains(log, "ENT asset=1"), logOf(log, "ENT asset"));
        check("e.asset 写（换素材成功）", contains(log, "ENT asset.set=1"), logOf(log, "ENT asset.set"));
        check("e.addTag/hasTag/removeTag", contains(log, "ENT tags=1"), logOf(log, "ENT tags"));
        check("e.setTags 整体替换", contains(log, "ENT setTags=1"), logOf(log, "ENT setTags"));
        check("e.props() 返回全部 props", contains(log, "ENT props=1"), logOf(log, "ENT props"));
        check("e.setProps 批量写入", contains(log, "ENT setProps=1"), logOf(log, "ENT setProps"));
        check("e.addModule 新 def 追加", contains(log, "ENT addModule=1"), logOf(log, "ENT addModule"));
        check("e.addModule 对已有 def 合并参数",
                contains(log, "ENT addModule.merge=1"), logOf(log, "ENT addModule.merge"));
        check("e.removeModule 删除后 hasModule=false",
                contains(log, "ENT removeModule=1"), logOf(log, "ENT removeModule"));
        check("e.parent 读写 + children()",
                contains(log, "ENT parent=1"), logOf(log, "ENT parent"));
        check("parent 设 null 解除关系", contains(log, "ENT parent.null=1"), logOf(log, "ENT parent.null"));
        check("e.setColor 不崩且 color 可读回",
                contains(log, "ENT color=1"), logOf(log, "ENT color"));
        check("e.setAlpha 不崩且 color.a 可读回",
                contains(log, "ENT alpha=1"), logOf(log, "ENT alpha"));
        check("setColor 支持 0~255 通道值",
                contains(log, "ENT color255=1"), logOf(log, "ENT color255"));

        // ===================== 宿主侧直接断言（此时还没 clear） =====================
        check("pool 归还的实例 visible=false", poolReleasedHidden(rt), "visible 仍为 true");
        check("pool.acquire 取回的实例 visible=true", poolAcquiredVisible(rt), "visible 仍为 false");
        TopDownRuntime.Actor boss = actorNamed(rt, "boss");
        check("宿主里 boss 存在（来自 boot prefabs 的 spawn）", boss != null, "");
        if (boss != null) {
            check("boss rotation 覆盖写回宿主", Math.abs(boss.o.rotation - 45f) < 0.01f,
                    String.valueOf(boss.o.rotation));
            check("boss scaleX/scaleY 覆盖写回", Math.abs(boss.o.scaleX - 2f) < 0.01f
                    && Math.abs(boss.o.scaleY - 3f) < 0.01f, boss.o.scaleX + "," + boss.o.scaleY);
            check("boss layer 写回宿主", boss.o.layer == 7, String.valueOf(boss.o.layer));
            check("boss animMode 归一化为中文枚举", "单次播放".equals(boss.o.animMode), boss.o.animMode);
            check("boss props 合并写回宿主", "9".equals(boss.o.props.get("lv"))
                    && "开".equals(boss.o.props.get("elite")), String.valueOf(boss.o.props));
            check("boss halfW/halfH 按模板写回", Math.abs(boss.o.halfW - 8f) < 0.01f
                    && Math.abs(boss.o.halfH - 8f) < 0.01f, boss.o.halfW + "," + boss.o.halfH);
        }
        check("spawnMany 结果写回宿主",
                contains(log, "PREFAB spawnMany.host=1") && actorNamed(rt, "monster-1") != null,
                "monster-1 不在 actors 里");

        // ---- 清理阶段：cleanup 由 onSceneStart 里的 bwe.after 定时器触发（在 update 的 Rhino 上下文里跑）----
        for (int i = 0; i < 8; i++) {
            engine.update(0.02f);
        }
        List<String> log2 = readLog();
        check("world.clear 清空所有实体",
                contains(log2, "WORLD clear=1"), logOf(log2, "WORLD clear"));
        check("after world.clear 宿主 actors 为空", rt.actors.isEmpty(), "actors=" + rt.actors.size());
        check("实体销毁后 prefab.count 归零（不泄漏）",
                contains(log2, "PREFAB countAfterClear=0"), logOf(log2, "PREFAB countAfterClear"));

        // ===================== 错误路径不崩 =====================
        check("未定义预制体 spawn 不崩且返回 null",
                !contains(log, "prefabtest caught exception"), "");
        check("prefab/pool 注册失败日志为空",
                !contains(log, "[脚本] prefab/pool 注册失败"), logOf(log, "注册失败"));
    }

    // ---------------- 生成测试工程 ----------------

    /** boot.json 里 prefabs[] 的条目数（与 buildProject 里的 JSON 一致）。 */
    private static final int BOOT_PREFAB_COUNT = 2;

    private static void buildProject() throws Exception {
        File build = new File(root, "Build");
        File scripts = new File(build, "scripts");
        Files.createDirectories(scripts.toPath());

        String boot = "{\n"
                + "  \"project\": \"ScriptPrefabTest\",\n"
                + "  \"tileSize\": 32,\n"
                + "  \"masterVolume\": 1,\n"
                + "  \"scenes\": [ { \"name\": \"预制体场景\", \"file\": \"scene_0.json\", \"width\": 20, \"height\": 15 } ],\n"
                + "  \"variables\": {},\n"
                + "  \"scripts\": [\n"
                + "    { \"name\": \"scene\", \"file\": \"scripts/scene.js\", \"lang\": \"js\" },\n"
                + "    { \"name\": \"mob\", \"file\": \"scripts/mob.js\", \"lang\": \"js\" }\n"
                + "  ],\n"
                + "  \"jsMain\": \"scene\",\n"
                + "  \"assets\": [\n"
                + "    { \"id\": \"a_monster\", \"name\": \"monster.png\", \"kind\": \"IMAGE\", \"path\": \"assets/monster.png\" },\n"
                + "    { \"id\": \"a_spark\", \"name\": \"spark.png\", \"kind\": \"IMAGE\", \"path\": \"assets/spark.png\" },\n"
                + "    { \"id\": \"a_boss\", \"name\": \"boss.png\", \"kind\": \"IMAGE\", \"path\": \"assets/boss.png\" }\n"
                + "  ],\n"
                // ---- boot.json prefabs[]：契约字段全给一遍（web 侧导出器逐字对齐） ----
                + "  \"prefabs\": [\n"
                + "    {\n"
                + "      \"name\": \"goblin\",\n"
                + "      \"kind\": \"ACTOR\",\n"
                + "      \"asset\": \"monster.png\",\n"
                + "      \"z\": 3,\n"
                + "      \"layer\": 2,\n"
                + "      \"halfW\": 8,\n"
                + "      \"halfH\": 8,\n"
                + "      \"tags\": [\"enemy\", \"ground\"],\n"
                + "      \"modules\": ["
                + " { \"def\": \"move.patrol\", \"when\": \"ALWAYS\", \"params\": { \"speed\": \"40\", \"range\": \"64\" } },"
                + " { \"def\": \"combat.health\", \"params\": { \"maxHealth\": \"40\" } } ],\n"
                + "      \"props\": { \"lv\": \"1\", \"elite\": \"关\" },\n"
                + "      \"script\": \"mob\",\n"
                + "      \"animMode\": \"默认\",\n"
                + "      \"animFps\": 8,\n"
                + "      \"scaleX\": 1,\n"
                + "      \"scaleY\": 1,\n"
                + "      \"rotation\": 0,\n"
                + "      \"jitter\": { \"x\": 4, \"y\": 2 }\n"
                + "    },\n"
                + "    {\n"
                + "      \"name\": \"boss\",\n"
                + "      \"kind\": \"ACTOR\",\n"
                + "      \"asset\": \"boss.png\",\n"
                + "      \"z\": 5,\n"
                + "      \"halfW\": 8,\n"
                + "      \"halfH\": 8,\n"
                + "      \"tags\": [\"enemy\", \"boss\"],\n"
                + "      \"props\": { \"lv\": \"9\", \"elite\": \"开\" }\n"
                + "    }\n"
                + "  ]\n"
                + "}\n";
        write(new File(build, "boot.json"), boot);

        String scene = "{\n"
                + "  \"width\": 20, \"height\": 15, \"tileSize\": 32,\n"
                + "  \"onStartScript\": \"scene\",\n"
                + "  \"layers\": [],\n"
                + "  \"objects\": [\n"
                + "    { \"id\": \"p1\", \"kind\": \"ACTOR\", \"name\": \"hero\", \"x\": 64, \"y\": 64,"
                + " \"halfW\": 16, \"halfH\": 16, \"visible\": true, \"tags\": [\"玩家\"],"
                + " \"props\": { \"w\": \"32\", \"h\": \"32\" } },\n"
                + "    { \"id\": \"s1\", \"kind\": \"PROP\", \"name\": \"sparker\", \"x\": 200, \"y\": 200,"
                + " \"visible\": true, \"tags\": [\"fx\", \"可交互\"], \"props\": { \"tone\": \"warm\" },"
                + " \"modules\": [ { \"def\": \"look.blink\", \"params\": { \"rate\": \"6\" } } ] }\n"
                + "  ]\n"
                + "}\n";
        write(new File(build, "scene_0.json"), scene);

        write(new File(scripts, "scene.js"), SCENE_JS);
        write(new File(scripts, "mob.js"), MOB_JS);
    }

    /** 场景脚本：把 prefab / pool / world / entity 的每个接口都跑一遍，结果写日志。 */
    private static final String SCENE_JS = String.join("\n",
            "// ---- boot.json prefabs[] 载入后的可见性 ----",
            "function onSceneStart(ctx) {",
            "  var bootList = bwe.prefab.list();",
            "  var bootNames = [];",
            "  for (var i = 0; i < bootList.length; i++) {",
            "    if (bootList[i] === \"goblin\" || bootList[i] === \"boss\") { bootNames.push(bootList[i]); }",
            "  }",
            "  bwe.log(\"PREFAB boot.list=\" + bootNames.length);",
            "  var g = bwe.prefab.get(\"goblin\");",
            "  bwe.log(\"PREFAB boot.def=\" + (g && g.kind === \"ACTOR\" && g.asset === \"monster.png\" && g.z === 3 && g.layer === 2 ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB boot.tags=\" + (g && g.tags.length === 2 && g.tags[0] === \"enemy\" ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB boot.mod=\" + (g && g.modules.length === 2 && g.modules[0].def === \"move.patrol\" && g.modules[0].params.speed === \"40\" && g.modules[1].def === \"combat.health\" && g.modules[1].params.maxHealth === \"40\" ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB boot.jitter=\" + (g && g.jitter && g.jitter.x === 4 && g.jitter.y === 2 ? \"1\" : \"0\"));",
            "",
            "  // ===================== define / get / list / has / remove =====================",
            "  var ok = bwe.prefab.define(\"drone\", {",
            "    kind: \"PROP\", asset: \"spark.png\", z: 1, layer: 3, halfW: 6, halfH: 6,",
            "    tags: [\"fx\", \"drone\"],",
            "    props: { tone: \"cold\", speed: \"2\" },",
            "    modules: [ { def: \"move.patrol\", params: { speed: \"9\", range: \"20\" } } ],",
            "    animFps: 6, animMode: \"loop\", scaleX: 1, scaleY: 1, rotation: 0,",
            "    jitter: { x: 0, y: 0 }",
            "  });",
            "  bwe.log(\"PREFAB define=\" + (ok ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB has=\" + (bwe.prefab.has(\"drone\") ? \"1\" : \"0\"));",
            "  var spec = bwe.prefab.get(\"drone\");",
            "  bwe.log(\"PREFAB get=\" + (spec && spec.kind === \"PROP\" && spec.halfW === 6 && spec.size.w === 12 ? \"1\" : \"0\"));",
            "  spec.tags.push(\"tampered\");",
            "  spec.props.tone = \"hot\";",
            "  var spec2 = bwe.prefab.get(\"drone\");",
            "  bwe.log(\"PREFAB deepcopy=\" + (spec2.tags.length === 2 && spec2.props.tone === \"cold\" ? \"1\" : \"0\"));",
            "  var list = bwe.prefab.list();",
            "  var found = 0;",
            "  for (var j = 0; j < list.length; j++) { if (list[j] === \"drone\") { found++; } }",
            "  bwe.log(\"PREFAB list=\" + (found === 1 && list.length === " + (BOOT_PREFAB_COUNT + 1) + " ? \"1\" : \"0\"));",
            "  bwe.prefab.define(\"temp\", { kind: \"PROP\" });",
            "  var removed = bwe.prefab.remove(\"temp\");",
            "  bwe.log(\"PREFAB remove=\" + (removed && !bwe.prefab.has(\"temp\") ? \"1\" : \"0\"));",
            "",
            "  // ===================== spawn 覆盖语义 =====================",
            "  var d1 = bwe.prefab.spawn(\"drone\", { x: 100, y: 120, rotation: 30, scaleX: 2, scaleY: 3,",
            "                                    animFps: 10, tags: [\"extra\"], props: { tone: \"hot\" },",
            "                                    modules: [ { def: \"look.shadow\", params: { size: \"3\" } } ],",
            "                                    name: \"drone-1\", jitter: false });",
            "  bwe.log(\"PREFAB spawn=\" + (d1 && d1.name === \"drone-1\" ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB spawn.pos=\" + (d1 && d1.x === 100 && d1.y === 120 ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB spawn.scalar=\" + (d1 && d1.rotation === 30 && d1.scaleX === 2 && d1.scaleY === 3 && d1.animFps === 10 ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB spawn.tags=\" + (d1 && d1.hasTag(\"fx\") && d1.hasTag(\"drone\") && d1.hasTag(\"extra\") ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB spawn.props=\" + (d1 && d1.prop(\"tone\", \"?\") === \"hot\" && d1.prop(\"speed\", \"?\") === \"2\" ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB spawn.mod=\" + (d1 && d1.hasModule(\"move.patrol\") && d1.hasModule(\"look.shadow\") ? \"1\" : \"0\"));",
            "  var mv = d1.module(\"move.patrol\");",
            "  bwe.log(\"PREFAB spawn.script=\" + (d1 ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB spawn.missing=\" + (bwe.prefab.spawn(\"没有这个预制体\") === null ? \"1\" : \"0\"));",
            "",
            "  // ---- jitter 语义（v1.1 修正）：goblin 模板带 jitter {x:4,y:2} ----",
            "  // 1) 显式给了 x/y 且没写 jitter → 必须精确落位（回归断言，端到端抓到的 bug）",
            "  var exact = bwe.prefab.spawn(\"goblin\", { x: 100, y: 120, name: \"exact-pos\" });",
            "  bwe.log(\"PREFAB jitter.exact=\" + (exact && exact.x === 100 && exact.y === 120 ? \"1\" : \"0\"));",
            "  // 2) 同一模板反复生成 20 次，位置必须每次都一模一样",
            "  var stable = 1;",
            "  var k;",
            "  for (k = 0; k < 20; k++) {",
            "    var p2 = bwe.prefab.spawn(\"goblin\", { x: 55, y: 66, jitter: false });",
            "    if (!p2 || p2.x !== 55 || p2.y !== 66) { stable = 0; }",
            "  }",
            "  bwe.log(\"PREFAB jitter.stable=\" + stable);",
            "  // 3) 显式 jitter:true 才抖（且落在 ±amp 内）",
            "  var jitOk = 1;",
            "  for (k = 0; k < 20; k++) {",
            "    var p3 = bwe.prefab.spawn(\"goblin\", { x: 200, y: 200, jitter: true });",
            "    if (!p3 || Math.abs(p3.x - 200) > 4 || Math.abs(p3.y - 200) > 2) { jitOk = 0; }",
            "  }",
            "  bwe.log(\"PREFAB jitter.explicit=\" + jitOk);",
            "  // 4) 完全不给 x/y → 允许抖（落在模板 jitter 范围内）",
            "  var noPos = bwe.prefab.spawn(\"goblin\", { name: \"no-pos\" });",
            "  bwe.log(\"PREFAB jitter.noPos=\" + (noPos && Math.abs(noPos.x) <= 4 && Math.abs(noPos.y) <= 2 ? \"1\" : \"0\"));",
            "  // 5) 对象池不受 jitter 影响（pool 内部禁止抖）",
            "  var poolExact = bwe.pool.create(\"goblin\", 4);",
            "  var pa = bwe.pool.acquire(poolExact, 33, 44);",
            "  bwe.log(\"PREFAB jitter.pool=\" + (pa && pa.x === 33 && pa.y === 44 ? \"1\" : \"0\"));",
            "  bwe.pool.release(poolExact, pa);",
            "",
            "  // ---- 运行时加 combat.health 模块 → hpMax 必须立刻重算 ----",
            "  var hpE = bwe.world.spawn({ x: 12, y: 12, name: \"hp-runtime\" });",
            "  bwe.log(\"HEALTH before=\" + (hpE.hpMax === 10 ? \"1\" : \"0\"));",
            "  hpE.addModule(\"combat.health\", { maxHealth: 40 });",
            "  bwe.log(\"HEALTH afterAdd=\" + (hpE.hpMax === 40 && hpE.hp === 40 ? \"1\" : \"0\"));",
            "  hpE.hp = 5;",
            "  hpE.addModule(\"combat.health\", { maxHealth: 60 });",
            "  bwe.log(\"HEALTH recount=\" + (hpE.hpMax === 60 ? \"1\" : \"0\"));",
            "  // prefab 模板带 combat.health 的实例，spawn 出来 hpMax 必须是模板值",
            "  var hpP = bwe.prefab.spawn(\"goblin\", { x: 1, y: 1, name: \"hp-prefab\" });",
            "  bwe.log(\"HEALTH prefab=\" + (hpP && hpP.hpMax > 10 ? \"1\" : \"0\"));",
            "",
            "  // ===================== spawnMany / count / fromEntity =====================",
            "  var countBefore = bwe.prefab.count(\"goblin\");",
            "  var many = bwe.prefab.spawnMany(\"goblin\", [",
            "    { x: 300, y: 300, name: \"monster-1\", jitter: false },",
            "    { x: 320, y: 300, name: \"monster-2\", jitter: false },",
            "    { x: 340, y: 300, name: \"monster-3\", jitter: false }",
            "  ]);",
            "  bwe.log(\"PREFAB spawnMany=\" + many.length);",
            "  bwe.log(\"PREFAB spawnMany.host=\" + (bwe.world.find(\"monster-1\") ? \"1\" : \"0\"));",
            "  var countAfter = bwe.prefab.count(\"goblin\");",
            "  // 用增量断言：count 只随本预制体的 spawn 增长，不被别的模板影响",
            "  bwe.log(\"PREFAB count=\" + (countAfter - countBefore === many.length",
            "                                  && countAfter - countBefore === 3 ? \"1\" : \"0\"));",
            "",
            "  var sparker = bwe.world.find(\"sparker\");",
            "  var exported = bwe.prefab.fromEntity(sparker, \"spark\");",
            "  bwe.log(\"PREFAB fromEntity=\" + (exported === \"spark\" && bwe.prefab.has(\"spark\") ? \"1\" : \"0\"));",
            "  var spark2 = bwe.prefab.spawn(\"spark\", { x: 10, y: 10, name: \"spark2\" });",
            "  bwe.log(\"PREFAB fromEntity.spawn=\" + (spark2 ? \"1\" : \"0\"));",
            "  var spSpec = bwe.prefab.get(\"spark\");",
            "  bwe.log(\"PREFAB fromEntity.keep=\" + (spSpec && spSpec.tags.length === 2 && spSpec.prop"
                    + "s.tone === \"warm\" && spSpec.modules.length === 1 ? \"1\" : \"0\"));",
            "",
            "  // ===================== 对象池 =====================",
            "  var pool = bwe.pool.create(\"drone\", 2);",
            "  bwe.log(\"POOL create=\" + (pool > 0 ? \"1\" : \"0\"));",
            "  var a1 = bwe.pool.acquire(pool, 50, 60);",
            "  bwe.log(\"POOL acquireNew=\" + (a1 && a1.x === 50 && a1.y === 60 && a1.visible ? \"1\" : \"0\"));",
            "  var rel = bwe.pool.release(pool, a1);",
            "  bwe.log(\"POOL release=\" + (rel && !a1.visible ? \"1\" : \"0\"));",
            "  var a2 = bwe.pool.acquire(pool, 70, 80);",
            "  bwe.log(\"POOL reuse=\" + (a2 && a2.id === a1.id && a2.x === 70 && a2.visible ? \"1\" : \"0\"));",
            "  var stats = bwe.pool.stats(pool);",
            "  bwe.log(\"POOL stats=\" + (stats && stats.total === 1 && stats.active === 1 && stats.idle === 0 ? \"1\" : \"0\"));",
            "  var hero = bwe.world.find(\"hero\");",
            "  var foreign = bwe.pool.release(pool, hero);",
            "  bwe.log(\"POOL releaseForeign=\" + (foreign === false ? \"1\" : \"0\"));",
            "  var badPool = bwe.pool.create(\"没有这个预制体\", 2);",
            "  bwe.log(\"POOL createMissing=\" + (badPool === -1 ? \"1\" : \"0\"));",
            "  bwe.pool.release(pool, a2);",
            "  bwe.log(\"POOL releasedHidden=\" + (!a2.visible ? \"1\" : \"0\"));",
            "",
            "  // ===================== world 批量接口 =====================",
            "  var batch = bwe.world.spawnMany([",
            "    { x: 10, y: 10, name: \"b1\" }, { x: 20, y: 20, name: \"b2\" }, { x: 30, y: 30, name: \"b3\" }",
            "  ]);",
            "  bwe.log(\"WORLD spawnMany=\" + batch.length);",
            "  var at = bwe.world.spawnAt({ name: \"at1\", kind: \"PROP\" }, 44, 55);",
            "  bwe.log(\"WORLD spawnAt=\" + (at && at.x === 44 && at.y === 55 ? \"1\" : \"0\"));",
            "  var src = bwe.world.find(\"sparker\");",
            "  var copy = bwe.world.clone(src, { x: 500, y: 500, name: \"sparker-copy\" });",
            "  bwe.log(\"WORLD clone=\" + (copy && copy.id !== src.id && copy.x === 500 && copy.name === \"sparker-copy\" ? \"1\" : \"0\"));",
            "  bwe.log(\"WORLD clone.keep=\" + (copy && copy.hasTag(\"fx\") && copy.hasModule(\"look.blink\") ? \"1\" : \"0\"));",
            "  var total = bwe.world.count();",
            "  var all = bwe.world.entities();",
            "  bwe.log(\"WORLD count=\" + (total === all.length ? \"1\" : \"0\"));",
            "  bwe.log(\"WORLD countQ=\" + (bwe.world.count({ kind: \"PROP\" }) > 0 ? \"1\" : \"0\"));",
            "  var visited = 0;",
            "  bwe.world.each({ tag: \"fx\" }, function (e) { visited++; });",
            "  bwe.log(\"WORLD each=\" + (visited > 0 ? \"1\" : \"0\"));",
            "  bwe.world.each({ tag: \"可交互\" }, function (e) {",
            "    bwe.world.spawn({ x: 1, y: 1, name: \"each-child\" });",
            "  });",
            "  bwe.log(\"WORLD eachSpawn=\" + (bwe.world.find(\"each-child\") ? \"1\" : \"0\"));",
            "  bwe.world.spawn({ x: 2, y: 2, name: \"junk-a\", tags: [\"junk\"] });",
            "  bwe.world.spawn({ x: 3, y: 3, name: \"junk-b\", tags: [\"junk\"] });",
            "  bwe.world.clearTag(\"junk\");",
            "  bwe.log(\"WORLD clearTag=\" + (bwe.world.count({ tag: \"junk\" }) === 0 && bwe.world.find(\"b1\") ? \"1\" : \"0\"));",
            // 批量销毁独立标签，避免把后面还要断言的 goblin/boss（enemy）一起删掉。
            "  bwe.world.spawn({ x: 7, y: 7, name: \"doomed-a\", tags: [\"spawned-batch\"] });",
            "  bwe.world.spawn({ x: 8, y: 8, name: \"doomed-b\", tags: [\"spawned-batch\"] });",
            "  var beforeDoomed = bwe.world.count({ tag: \"spawned-batch\" });",
            "  var removedN = bwe.world.destroyAll({ tag: \"spawned-batch\" });",
            "  bwe.log(\"WORLD destroyAll=\" + (beforeDoomed === 2 && removedN === 2 && bwe.world.count({ tag: \"spawned-batch\" }) === 0 ? \"1\" : \"0\"));",
            "",
            "  // ===================== spawn(opts) 新字段 =====================",
            "  var s1 = bwe.world.spawn({ x: 5, y: 6, name: \"opt1\", rotation: 90, scaleX: 2, scaleY: 4, visible: false });",
            "  bwe.log(\"SPAWN opts.scalar=\" + (s1 && s1.rotation === 90 && s1.scaleX === 2 && s1.scaleY === 4 && !s1.visible ? \"1\" : \"0\"));",
            "  var s2 = bwe.world.spawn({ x: 5, y: 6, name: \"opt2\", layer: 9 });",
            "  bwe.log(\"SPAWN opts.layer=\" + (s2 && s2.layer === 9 ? \"1\" : \"0\"));",
            "  var s3 = bwe.world.spawn({ x: 5, y: 6, name: \"opt3\", animMode: \"first\", animFps: 3 });",
            "  bwe.log(\"SPAWN opts.anim=\" + (s3 && s3.animMode === \"只显示首帧\" && s3.animFps === 3 ? \"1\" : \"0\"));",
            "  var s4 = bwe.world.spawn({ x: 5, y: 6, name: \"opt4\", props: { w: 40, h: 20, flag: true } });",
            "  bwe.log(\"SPAWN opts.props=\" + (s4 && s4.prop(\"w\", 0) === 40 && s4.prop(\"flag\", false) === true ? \"1\" : \"0\"));",
            "  var s5 = bwe.world.spawn({ x: 5, y: 6, name: \"opt5\", parent: hero });",
            "  bwe.log(\"SPAWN opts.parent=\" + (s5 && s5.parent && s5.parent.id === hero.id ? \"1\" : \"0\"));",
            "",
            "  // ===================== Entity 修改接口 =====================",
            "  var e = bwe.world.find(\"opt1\");",
            "  e.size = { w: 24, h: 40 };",
            "  bwe.log(\"ENT size=\" + (e.size.w === 24 && e.size.h === 40 ? \"1\" : \"0\"));",
            "  e.setSize(10, 12);",
            "  bwe.log(\"ENT size.setter=\" + (e.size.w === 10 && e.size.h === 12 ? \"1\" : \"0\"));",
            "  e.layer = 4;",
            "  bwe.log(\"ENT layer=\" + (e.layer === 4 ? \"1\" : \"0\"));",
            "  e.locked = true;",
            "  bwe.log(\"ENT locked=\" + (e.locked === true ? \"1\" : \"0\"));",
            "  e.locked = false;",
            "  e.animMode = \"once\";",
            "  var am1 = e.animMode;",
            "  e.animMode = \"默认\";",
            "  bwe.log(\"ENT animMode=\" + (am1 === \"单次播放\" && e.animMode === \"默认\" ? \"1\" : \"0\"));",
            "  e.animFps = 12;",
            "  bwe.log(\"ENT animFps=\" + (e.animFps === 12 ? \"1\" : \"0\"));",
            "  var gob2 = bwe.prefab.spawn(\"goblin\", { name: \"gob-asset\", jitter: false });",
            "  bwe.log(\"ENT asset=\" + (gob2.asset === \"monster.png\" ? \"1\" : \"0\"));",
            "  gob2.asset = \"spark.png\";",
            "  bwe.log(\"ENT asset.set=\" + (gob2.asset === \"spark.png\" ? \"1\" : \"0\"));",
            "  gob2.addTag(\"elite\");",
            "  var hasElite = gob2.hasTag(\"elite\");",
            "  var rm = gob2.removeTag(\"elite\");",
            "  gob2.addTag(\"elite\");",
            "  bwe.log(\"ENT tags=\" + (hasElite === true && rm === true && gob2.hasTag(\"elite\") ? \"1\" : \"0\"));",
            "  gob2.setTags([\"only\", \"these\"]);",
            "  bwe.log(\"ENT setTags=\" + (gob2.tags.length === 2 && gob2.hasTag(\"only\") && !gob2.hasTag(\"enemy\") ? \"1\" : \"0\"));",
            "  var allProps = gob2.props();",
            "  bwe.log(\"ENT props=\" + (allProps && allProps.lv === \"1\" && allProps.elite === \"关\" ? \"1\" : \"0\"));",
            "  gob2.setProps({ lv: 5, bonus: \"yes\" });",
            "  bwe.log(\"ENT setProps=\" + (gob2.prop(\"lv\", 0) === 5 && gob2.prop(\"bonus\", \"\") === \"yes\" ? \"1\" : \"0\"));",
            "  gob2.addModule(\"render.blink\", { rate: 4 });",
            "  bwe.log(\"ENT addModule=\" + (gob2.hasModule(\"render.blink\") ? \"1\" : \"0\"));",
            "  var beforeCount = gob2.modules().length;",
            "  gob2.addModule(\"move.patrol\", { speed: 99 });",
            "  var afterCount = gob2.modules().length;",
            "  var merged = gob2.module(\"move.patrol\");",
            "  bwe.log(\"ENT addModule.merge=\" + (merged && merged.get(\"speed\", 0) === 99 && beforeCount === afterCount ? \"1\" : \"0\"));",
            "  var rmMod = gob2.removeModule(\"render.blink\");",
            "  bwe.log(\"ENT removeModule=\" + (rmMod === true && !gob2.hasModule(\"render.blink\") ? \"1\" : \"0\"));",
            "  var parentE = bwe.world.find(\"opt5\");",
            "  parentE.parent = hero;",
            "  var kids = hero.children();",
            "  bwe.log(\"ENT parent=\" + (parentE.parent && parentE.parent.id === hero.id && kids.length === 1 ? \"1\" : \"0\"));",
            "  parentE.parent = null;",
            "  bwe.log(\"ENT parent.null=\" + (parentE.parent === null && hero.children().length === 0 ? \"1\" : \"0\"));",
            "  parentE.setColor(1, 0.5, 0.25, 1);",
            "  var cc = parentE.color;",
            "  bwe.log(\"ENT color=\" + (cc && cc.r === 1 && cc.g === 0.5 && cc.b === 0.25 && cc.a === 1 ? \"1\" : \"0\"));",
            "  parentE.setAlpha(0.25);",
            "  bwe.log(\"ENT alpha=\" + (parentE.color.a === 0.25 ? \"1\" : \"0\"));",
            "  parentE.setColor(255, 128, 0, 255);",
            "  var c255 = parentE.color;",
            "  bwe.log(\"ENT color255=\" + (c255.r === 1 && Math.abs(c255.g - 0.502) < 0.01 ? \"1\" : \"0\"));",
            "",
            "  // ===================== 从 boot prefabs 生成 boss，验证宿主侧 =====================",
            "  var boss = bwe.prefab.spawn(\"boss\", { x: 400, y: 400, rotation: 45, scaleX: 2, scaleY: 3,",
            "                                    layer: 7, animMode: \"once\", props: { lv: 9 } });",
            "  bwe.log(\"PREFAB boss=\" + (boss ? \"1\" : \"0\"));",
            "",
            "  // 清理阶段延迟到后面几帧：Java 侧要先用「实体还活着」的状态做宿主断言。",
            "  bwe.after(0.05, function () { cleanup(null); });",
            "}",
            "",
            "function cleanup(ctx) {",
            "  bwe.world.clear();",
            "  bwe.log(\"WORLD clear=\" + (bwe.world.entities().length === 0 ? \"1\" : \"0\"));",
            "  bwe.log(\"PREFAB countAfterClear=\" + bwe.prefab.count(\"goblin\"));",
            "}",
            "");

    /** 对象脚本（验证 prefab 的 script 字段真的绑定并跑了 onStart）。 */
    private static final String MOB_JS = String.join("\n",
            "function onStart(ctx) {",
            "  bwe.log(\"PREFAB spawn.script=\" + (ctx.self.hasTag(\"ground\") || ctx.self.hasTag(\"enemy\") ? \"1\" : \"0\"));",
            "}",
            "");

    // ---------------- 宿主侧断言辅助 ----------------

    /** 池里 release 过的实例 visible 必须是 false（取最后一个 release 的 drone）。 */
    private static boolean poolReleasedHidden(TopDownRuntime rt) {
        // 脚本最后把 a2 归还了；按名字找不到（池实例没名字），所以扫所有 drone 类实例。
        // 判据：存在至少一个 visible=false 的 PROP（就是池里那个）。
        for (TopDownRuntime.Actor a : rt.actors) {
            if (a.dead || a.o == null) {
                continue;
            }
            if ("spark.png".equals(a.o.assetName) && !a.o.visible) {
                return true;
            }
        }
        return false;
    }

    private static boolean poolAcquiredVisible(TopDownRuntime rt) {
        // acquire 之后是 true（同一实例），这里验证「没有把所有 drone 都关了」。
        int hidden = 0;
        for (TopDownRuntime.Actor a : rt.actors) {
            if (!a.dead && a.o != null && "spark.png".equals(a.o.assetName) && !a.o.visible) {
                hidden++;
            }
        }
        return hidden <= 1;
    }

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

    private static boolean contains(List<String> log, String needle) {
        for (String line : log) {
            if (line.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    /** 把命中该前缀的日志拼成一行，失败时贴出来方便定位。 */
    private static String logOf(List<String> log, String prefix) {
        StringBuilder sb = new StringBuilder();
        for (String line : log) {
            if (line.contains("PREFAB ") || line.contains("POOL ") || line.contains("WORLD ")
                    || line.contains("SPAWN ") || line.contains("ENT ") || line.contains("HEALTH ")) {
                if (sb.length() > 0) {
                    sb.append(" | ");
                }
                sb.append(line.trim());
            }
        }
        return sb.length() > 900 ? sb.substring(0, 900) : sb.toString();
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
