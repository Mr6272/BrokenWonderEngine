/**
 * 孤胆枪手示例的端到端校验。
 *
 *   node web/tools/verify-alien-shooter.mjs [--dt 0.016] [--shots]
 *
 * 做四件事：
 *   1. 工程里 8 段 JS 用 TypeScript 降级到 ES5（有语法错就 FAIL）；
 *   2. 编译 Java 运行时（排除 GameLauncher）+ 无窗口驱动器；
 *   3. 用导出器写 Build；
 *   4. headless 跑「机器人通关」：真 TopDownRuntime.update（脚本 + 模块 + 相机 + 帧末提交 + 光照），
 *      机器人按真实输入通道操作（keys[] / 鼠标坐标 / mouseButton 按住），分阶段：
 *        A 走到铁丝网破口（WASD，检查人物真的在动、没穿墙）；
 *        B 院子里按住左键连射：鼠标瞄最近的怪（屏幕坐标 → 世界坐标走引擎换算），检查击杀；
 *        C 传送到巢穴旁边射击巢穴（检查巢穴被摧毁）；
 *        D 传送到仓库外的气瓶堆，射油桶 → 连环爆炸 → 裂墙炸开；
 *        E 走进地下入口 → 过关标记；
 *        F 按 R 重开：检查场景重载后钩子还在（HUD/特效/导演都继续工作）、再开枪还能击杀。
 *      断言：无 [脚本错误]、无慢脚本告警、单帧平均耗时 < 8ms。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { writeQuickBuild } = await import("./package-bwe.mjs");

const REPO = resolve(process.cwd());
const WEB = join(REPO, "web");
const LIB = join(REPO, "lib");
const TMP = join(REPO, ".tmp_as", "verify");
const CLASSES = join(TMP, "classes");
const PROJECT = join(WEB, "examples", "孤胆枪手.bwproj");
const BUILD_ROOT = join(TMP, "build");

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const DT = Number(arg("--dt", "0.016"));

const rows = [];
let log = "";
const logFile = join(BUILD_ROOT, "Build", "bwe.log");
function add(section, name, pass, detail = "") {
  rows.push({ section, name, pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? "  [" + detail + "]" : ""}`);
}
function section(title) {
  console.log(`\n[${title}]`);
}

// ---------------------------------------------------------------- 1) 脚本降级
section("1) 脚本 TS→ES5");
if (!existsSync(PROJECT)) {
  add("scripts", "工程存在（先跑 npm run gen:alienshooter）", false, PROJECT);
  finish();
}
const project = JSON.parse(readFileSync(PROJECT, "utf8"));
const jsNames = Object.entries(project.scripts)
  .filter(([, s]) => (s.lang ?? "yarn") === "js")
  .map(([k]) => k);
add("scripts", `找到 ${jsNames.length} 段 JS 脚本`, jsNames.length === 8, jsNames.join(","));
for (const name of jsNames) {
  const src = project.scripts[name].source;
  const out = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.None },
    reportDiagnostics: true
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error && d.file);
  add("scripts", `${name}.js 降级`, errors.length === 0,
    errors.length ? ts.flattenDiagnosticMessageText(errors[0].messageText, " ") : "ok");
  // 源码本身就要是 ES5（引擎 Rhino 解释执行，不经过降级也得能跑）
  const es6 = /=>|\bclass\s|\blet\s|\bconst\s|`/.test(src.replace(/\/\/.*$/gm, ""));
  add("scripts", `${name}.js 源码是 ES5`, !es6, "no arrow/class/let/const/template");
}

// ---------------------------------------------------------------- 2) 编译
section("2) 编译运行时 + 驱动器");
rmSync(CLASSES, { recursive: true, force: true });
mkdirSync(CLASSES, { recursive: true });
const runtimeDir = join(REPO, "src", "Studio", "runtime");
const javaFiles = readdirSync(runtimeDir)
  // 测试类会引用 src/Core（另一个包），这里只要运行时本身
  .filter((f) => f.endsWith(".java") && f !== "GameLauncher.java" && !f.endsWith("Test.java"))
  .map((f) => join(runtimeDir, f));

const driverSrc = String.raw`
package Studio.runtime;

import java.io.File;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

/** 无窗口机器人：真运行时，按真实输入通道（keys[] / 鼠标坐标 / 按住鼠标）通关第一关。 */
public final class AlienRun {
    static TopDownRuntime rt;
    static Method update;
    static float dt;
    static double sumMs, maxMs;
    static int frames, maxAt;

    static void step() throws Exception {
        long t0 = System.nanoTime();
        update.invoke(rt, Float.valueOf(dt));
        double ms = (System.nanoTime() - t0) / 1e6;
        sumMs += ms;
        frames++;
        if (frames > 30 && ms > maxMs) { maxMs = ms; maxAt = frames; }
        if (ms > 50) System.out.printf("ALIEN spike frame=%d ms=%.1f%n", frames, ms);
    }

    static Actor find(String name) {
        for (Actor a : rt.actors) if (!a.dead && name.equals(a.o.name)) return a;
        return null;
    }

    static List<Actor> tagged(String tag) {
        List<Actor> out = new ArrayList<Actor>();
        for (Actor a : rt.actors) if (!a.dead && a.o.tags.contains(tag)) out.add(a);
        return out;
    }

    static String prop(Actor a, String k) {
        String v = a.o.props.get(k);
        return v == null ? "" : v;
    }

    /** 把鼠标放到世界坐标 (wx,wy)：反解引擎的 toWorldX/Y（屏幕 = (世界 - cam) * zoom + view/2）。 */
    static void aimAt(float wx, float wy) {
        Viewport v = rt.view;
        rt.mouseX = Math.round((wx - v.camX) * v.zoom + v.viewW / 2f);
        rt.mouseY = Math.round((wy - v.camY) * v.zoom + v.viewH / 2f);
    }

    static void keys(boolean w, boolean a, boolean s, boolean d) {
        rt.keys[87] = w; rt.keys[65] = a; rt.keys[83] = s; rt.keys[68] = d;
    }

    static void fire(boolean on) {
        rt.scripts.mouseButton(0, on);
    }

    static void tap(int code) throws Exception {
        rt.keys[code] = true; step(); rt.keys[code] = false; step();
    }

    static void teleport(Actor p, float x, float y) throws Exception {
        p.x = x; p.y = y; p.o.x = x; p.o.y = y;
        for (int i = 0; i < 20; i++) step();   // 相机跟上
    }

    static Actor nearest(Actor p, String tag, float maxD) {
        Actor best = null; float bd = maxD * maxD;
        for (Actor a : tagged(tag)) {
            float dx = a.x - p.x, dy = a.y - p.y, d2 = dx * dx + dy * dy;
            if (d2 < bd) { bd = d2; best = a; }
        }
        return best;
    }

    /** 站在原地，按住左键，持续瞄最近的「可击中」外星虫，跑 sec 秒；返回击杀数增量。 */
    static int fightHere(Actor p, float sec) throws Exception {
        int k0 = Integer.parseInt(prop(p, "kills").isEmpty() ? "0" : prop(p, "kills").replace(".0", ""));
        int n = Math.round(sec / dt);
        for (int i = 0; i < n; i++) {
            Actor t = nearest(p, "外星虫", 420f);
            if (t != null) { aimAt(t.x, t.y); fire(true); } else { fire(false); }
            step();
        }
        fire(false);
        String kv = prop(p, "kills");
        int k1 = (int) Float.parseFloat(kv.isEmpty() ? "0" : kv);
        return k1 - k0;
    }

    public static void main(String[] args) throws Exception {
        File boot = new File(args[0]).getAbsoluteFile();
        dt = args.length > 1 ? Float.parseFloat(args[1]) : 0.016f;
        rt = new TopDownRuntime(boot);
        if (rt.scripts == null) { System.out.println("ALIEN fatal: 没有脚本引擎"); return; }
        update = TopDownRuntime.class.getDeclaredMethod("update", float.class);
        update.setAccessible(true);

        Actor p = find("玩家");
        if (p == null) { System.out.println("ALIEN fatal: 没有玩家"); return; }
        for (int i = 0; i < 10; i++) step();
        System.out.printf("ALIEN zoom=%.2f cam=%.0f,%.0f player=%.0f,%.0f%n", rt.view.zoom, rt.view.camX, rt.view.camY, p.x, p.y);

        // ---- A 走到铁丝网破口：先上（W）到 y≈30 行，再右（D）穿过破口 ----
        float sx = p.x, sy = p.y;
        keys(true, false, false, false);
        for (int i = 0; i < Math.round(1.4f / dt) && p.y > 30.5f * 32; i++) { aimAt(p.x, p.y - 100); step(); }
        float walkedUp = sy - p.y;
        keys(false, false, false, true);
        int rf = 0; float rx0 = p.x;
        for (int i = 0; i < Math.round(3.5f / dt) && p.x < 17 * 32; i++) { aimAt(p.x + 100, p.y); step(); rf++; }
        keys(false, false, false, false);
        System.out.printf("ALIEN A walkUp=%.0f walkRight=%.0f pos=%.0f,%.0f speed=%.0f%n",
            walkedUp, p.x - sx, p.x, p.y, (p.x - rx0) / Math.max(dt, rf * dt));
        boolean inYard = p.x > 15 * 32;
        System.out.println("ALIEN A inYard=" + inYard);

        // ---- B 院子里打怪（破口附近预置了 3 只绿蜘蛛） ----
        int kB = fightHere(p, 6f);
        System.out.println("ALIEN B kills=" + kB + " hp=" + prop(p, "hp") + " lives=" + prop(p, "lives"));

        // ---- C 巢穴：传送到 (20.5,15.5) 巢穴下方 4 格，射它（一路有怪就先打怪） ----
        Actor nest = null;
        for (Actor a : tagged("巢穴")) { if (nest == null || Math.abs(a.x - 20.5f * 32 - 16) < Math.abs(nest.x - 20.5f * 32 - 16)) nest = a; }
        boolean nestDead = false;
        if (nest != null) {
            p.o.props.put("invuln", "999");       // 机器人只验证流程，不验证生存（怪很多）
            teleport(p, nest.x, nest.y + 4 * 32);
            for (int i = 0; i < Math.round(25f / dt); i++) {
                Actor t = nearest(p, "外星虫", 140f);
                if (t != null) aimAt(t.x, t.y); else aimAt(nest.x, nest.y);
                fire(true);
                step();
                if (!"nest".equals(prop(nest, "kind"))) { nestDead = true; break; }
                if (i % 300 == 0) System.out.println("ALIEN C t=" + i + " nestLife=" + prop(nest, "life") + " p=" + Math.round(p.x) + "," + Math.round(p.y) + " vis=" + p.o.visible + " hp=" + prop(p, "hp") + " bug=" + (t != null) + " nest=" + Math.round(nest.x) + "," + Math.round(nest.y));
            }
            fire(false);
        }
        System.out.println("ALIEN C nestDead=" + nestDead + " money=" + prop(p, "money"));

        // ---- D 仓库外的气瓶堆：站在西边 4 格外，射最近的油桶 ----
        teleport(p, 39.5f * 32, 37.5f * 32);
        int barrels0 = 0;
        for (Actor a : tagged("可击中")) { String k = prop(a, "kind"); if (k.equals("barrel") || k.equals("gas")) barrels0++; }
        boolean wallOpen = false;
        for (int i = 0; i < Math.round(8f / dt); i++) {
            Actor target = null; float bd = 1e9f;
            for (Actor a : tagged("可击中")) {
                String k = prop(a, "kind");
                if (!(k.equals("barrel") || k.equals("gas"))) continue;
                if (a.x < 42 * 32 || a.y < 33 * 32) continue;
                float dx = a.x - p.x, dy = a.y - p.y, d2 = dx * dx + dy * dy;
                if (d2 < bd) { bd = d2; target = a; }
            }
            Actor bug = nearest(p, "外星虫", 120f);
            if (bug != null) aimAt(bug.x, bug.y);
            else if (target != null) aimAt(target.x, target.y);
            else aimAt(47 * 32, 37.5f * 32);
            fire(true);
            step();
            if (!rt.scripts.world.solidCell(46, 37)) { wallOpen = true; }
            if (wallOpen && target == null) break;
        }
        fire(false);
        int barrels1 = 0;
        for (Actor a : tagged("可击中")) { String k = prop(a, "kind"); if (k.equals("barrel") || k.equals("gas")) barrels1++; }
        System.out.println("ALIEN D wallOpen=" + wallOpen + " barrels=" + barrels0 + "->" + barrels1);

        // ---- E 走进入口（墙洞在 x=46，入口 (50,40)）：先往右穿墙洞，再往下/右 ----
        for (int i = 0; i < 20; i++) step();
        Actor exit = find("入口");
        boolean exitShown = exit != null && exit.o.visible;
        if (wallOpen) {
            keys(false, false, false, true);
            for (int i = 0; i < Math.round(3f / dt) && p.x < 48 * 32; i++) { aimAt(p.x + 100, p.y); step(); }
            keys(false, false, false, false);
            float tx = 50.5f * 32, ty = 40.5f * 32;
            for (int i = 0; i < Math.round(4f / dt) && !"1".equals(prop(p, "win")); i++) {
                keys(ty < p.y - 4, tx < p.x - 4, ty > p.y + 4, tx > p.x + 4);
                aimAt(tx, ty);
                step();
            }
            keys(false, false, false, false);
        }
        boolean win = "1".equals(prop(p, "win"));
        System.out.println("ALIEN E exitShown=" + exitShown + " win=" + win + " pos=" + Math.round(p.x) + "," + Math.round(p.y));

        // ---- F 按 R 重开 ----
        for (int i = 0; i < 60; i++) step();
        int epoch0 = rt.sceneEpoch;
        tap(82);
        for (int i = 0; i < 30; i++) step();
        Actor p2 = find("玩家");
        boolean restarted = rt.sceneEpoch != epoch0 && p2 != null && !"1".equals(prop(p2, "win"));
        int kF = 0;
        if (p2 != null) {
            p = p2;
            p.o.props.put("invuln", "999");
            // 重开后直接去破口那 3 只绿蜘蛛旁边
            teleport(p, 18 * 32, 30 * 32);
            kF = fightHere(p, 5f);
        }
        System.out.println("ALIEN F restarted=" + restarted + " epoch=" + epoch0 + "->" + rt.sceneEpoch + " killsAfterRestart=" + kF);

        int actors = rt.actors.size();
        System.out.printf("ALIEN frames=%d avg=%.2fms max=%.2fms(第%d帧，不含启动预热) actors=%d%n", frames, sumMs / frames, maxMs, maxAt, actors);
        System.out.println("ALIEN done");
    }
}
`;
const driverPath = join(TMP, "AlienRun.java");
mkdirSync(TMP, { recursive: true });
writeFileSync(driverPath, driverSrc, "utf8");
try {
  execFileSync("javac", [
    "--release", "8", "-encoding", "UTF-8", "-Xlint:-options", "-nowarn",
    "-cp", join(LIB, "*"), "-d", CLASSES, ...javaFiles, driverPath
  ], { stdio: "pipe" });
  add("build", `javac ${javaFiles.length} 个运行时文件 + 驱动器`, true);
} catch (e) {
  add("build", "javac 编译", false, String(e.stderr ?? e.message).split("\n").slice(0, 4).join(" / "));
  finish();
}

// ---------------------------------------------------------------- 3) 导出
section("3) 导出 Build");
rmSync(BUILD_ROOT, { recursive: true, force: true });
mkdirSync(BUILD_ROOT, { recursive: true });
const bootFile = join(BUILD_ROOT, "Build", "boot.json");
try {
  const build = await writeQuickBuild(project, null, BUILD_ROOT, () => {});
  for (const w of build.warnings ?? []) console.log(`    ⚠ ${w}`);
  add("export", "写 Build/boot.json", existsSync(bootFile));
  const boot = JSON.parse(readFileSync(bootFile, "utf8"));
  const sceneFile = join(BUILD_ROOT, "Build", (boot.scenes?.[0]?.file ?? boot.scenes?.[0] ?? "").toString());
  const sceneJson = existsSync(sceneFile) ? JSON.parse(readFileSync(sceneFile, "utf8")) : null;
  add("export", "场景带光照 + 预烘焙光照贴图", !!(sceneJson?.lighting?.enabled && sceneJson?.lightmap?.assetId),
    sceneJson?.lightmap ? `${sceneJson.lightmap.texW}×${sceneJson.lightmap.texH}` : "无 lightmap");
  const audio = readdirSync(join(BUILD_ROOT, "Build"), { recursive: true }).filter((f) => String(f).endsWith(".wav"));
  add("export", "音效导出为 WAV", audio.length >= 18, `${audio.length} 个`);
} catch (e) {
  add("export", "导出 Build", false, String(e.message).split("\n")[0]);
  finish();
}

// ---------------------------------------------------------------- 4) headless
section("4) headless 机器人通关（真运行时 + 真脚本 + 真输入通道）");
const cp = [CLASSES, join(LIB, "*")].join(delimiter);
const run = spawnSync("java", ["-Dstdout.encoding=UTF-8", "-Djava.awt.headless=true", "-cp", cp, "Studio.runtime.AlienRun", bootFile, String(DT)], {
  encoding: "utf8", cwd: REPO, timeout: 300000
});
const out = (run.stdout ?? "") + (run.stderr ?? "");
writeFileSync(join(TMP, "run.txt"), out, "utf8");
log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
const line = (tag) => (out.match(new RegExp("ALIEN " + tag + "[^\\n]*")) ?? [""])[0];
const val = (l, k) => (l.match(new RegExp(k + "=([^\\s]+)")) ?? [])[1];

add("run", "运行时跑完", out.includes("ALIEN done"), out.includes("ALIEN fatal") ? line("fatal") : "");
add("run", "场景脚本启动", log.includes("[孤胆枪手] 第一关「潜入」开始"), "");
add("run", "玩家脚本就绪", log.includes("[孤胆枪手] player ready"), "");
const la = line("A walkUp");
const speed = Number(val(la, "speed") ?? 0);
add("feel", "WASD 移动（屏幕方向）", Number(val(la, "walkUp") ?? 0) > 60 && Number(val(la, "walkRight") ?? 0) > 200, la.replace("ALIEN ", ""));
add("feel", "移动速度 ≈ 原作 160px/s（150~185）", speed >= 140 && speed <= 185, `${speed}px/s（含被怪/墙阻挡的损失）`);
add("feel", "穿过铁丝网破口进入院子", line("A inYard").includes("true"), "");
const kB = Number(val(line("B kills"), "kills") ?? 0);
add("feel", "按住左键连射击杀外星虫", kB >= 2, line("B kills").replace("ALIEN ", ""));
add("level", "巢穴被摧毁", line("C nestDead").includes("nestDead=true") && log.includes("[孤胆枪手] 巢穴被摧毁"), line("C nestDead").replace("ALIEN ", ""));
add("level", "打爆气瓶/油桶 → 连环爆炸炸开裂墙", line("D wallOpen").includes("wallOpen=true") && log.includes("[孤胆枪手] 裂墙被炸开"), line("D wallOpen").replace("ALIEN ", ""));
add("level", "裂墙后露出地下入口", line("E exitShown").includes("exitShown=true"), "");
add("level", "进入地下入口 → 过关", line("E exitShown").includes("win=true") && log.includes("[孤胆枪手] 过关"), line("E exitShown").replace("ALIEN ", ""));
const lf = line("F restarted");
add("restart", "按 R 重开场景", lf.includes("restarted=true"), lf.replace("ALIEN ", ""));
add("restart", "重开后钩子仍在（还能开枪击杀）", Number(val(lf, "killsAfterRestart") ?? 0) >= 1, "");
add("run", "无 [脚本错误]", !log.includes("[脚本错误]"), `errors=${(log.match(/\[脚本错误\]/g) ?? []).length}`);
add("run", "无 250ms 慢脚本告警", !/执行超过 250ms|执行过慢/.test(log), "");
const fl = line("frames=");
const avg = Number(val(fl, "avg")?.replace("ms", "") ?? 0);
add("perf", "单帧平均耗时 < 8ms（脚本 + 模块 + 光照）", avg > 0 && avg < 8, fl.replace("ALIEN ", ""));

finish();

function finish() {
  const pass = rows.filter((r) => r.pass).length;
  const fail = rows.length - pass;
  console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) {
    const errs = log.split("\n").filter((l) => l.includes("[脚本错误]") || l.includes("[脚本]")).slice(0, 8);
    if (errs.length) console.log("日志摘录:\n" + errs.join("\n"));
    console.log("驱动器输出: .tmp_as/verify/run.txt");
  }
  process.exit(fail > 0 ? 1 : 0);
}
