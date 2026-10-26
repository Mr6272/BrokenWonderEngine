/**
 * 吸血鬼幸存者示例的端到端校验。
 *
 *   node web/tools/verify-vampire.mjs [--seconds 24] [--dt 0.05] [--shot]
 *
 * 做四件事：
 *   1. 把示例工程里的 5 段 JS 用 TypeScript 降级到 ES5（有语法错就 FAIL）；
 *   2. 编译 Java 运行时（排除 GameLauncher）；
 *   3. 用导出器把工程写成 Build（跳过 jpackage）；
 *   4. 起无窗口驱动器 headless 跑若干秒（真 TopDownRuntime + 真脚本，反射调 update），
 *      断言：刷怪、开火、击杀、升级、接触掉血、无 [脚本错误]。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { writeQuickBuild } = await import("./package-bwe.mjs");

const REPO = resolve(process.cwd());
const WEB = join(REPO, "web");
const LIB = join(REPO, "lib");
const TMP = join(REPO, ".tmp_rel8", "verify-vamp");
const CLASSES = join(TMP, "classes");
const PROJECT = join(WEB, "examples", "吸血鬼幸存者.bwproj");
const BUILD_ROOT = join(TMP, "build");

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const SECONDS = Number(arg("--seconds", "24"));
const DT = Number(arg("--dt", "0.05"));

const rows = [];
let log = "";
const logFile = join(BUILD_ROOT, "Build", "bwe.log");
function add(section, name, pass, detail = "") {
  rows.push({ section, name, pass, detail });
  const mark = pass ? "✓" : "✗";
  console.log(`  ${mark} ${name}${detail ? "  [" + detail + "]" : ""}`);
}
function section(title) {
  console.log(`\n[${title}]`);
}

// ---------------------------------------------------------------- 1) 脚本降级
section("1) 脚本 TS→ES5");
const project = JSON.parse(readFileSync(PROJECT, "utf8"));
const jsNames = Object.entries(project.scripts)
  .filter(([, s]) => (s.lang ?? "yarn") === "js")
  .map(([k]) => k);
add("scripts", `找到 ${jsNames.length} 段 JS 脚本`, jsNames.length >= 4, jsNames.join(","));

const es5 = new Map();
for (const name of jsNames) {
  const src = project.scripts[name].source;
  const out = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.None, isolatedModules: false },
    reportDiagnostics: true
  });
  // 只看「源文件里的诊断」：transpileModule 还会顺手报选项级提示（例如 isolatedModules），那不是脚本错误
  const errors = (out.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error && d.file
  );
  add("scripts", `${name}.js 降级`, errors.length === 0,
    errors.length ? ts.flattenDiagnosticMessageText(errors[0].messageText, " ") : "ok");
  es5.set(name, out.outputText);
  const bad = [/=>/.test(out.outputText), /\bclass\s/.test(out.outputText), /\blet\s/.test(out.outputText)];
  add("scripts", `${name}.js 产物是 ES5`, !bad.some(Boolean), "no arrow/class/let");
}

// ---------------------------------------------------------------- 2) 编译运行时
section("2) 编译运行时");
rmSync(CLASSES, { recursive: true, force: true });
mkdirSync(CLASSES, { recursive: true });
const runtimeDir = join(REPO, "src", "Studio", "runtime");
const javaFiles = readdirSync(runtimeDir)
  .filter((f) => f.endsWith(".java") && f !== "GameLauncher.java")
  .map((f) => join(runtimeDir, f));

// 无窗口驱动器：反射调 TopDownRuntime.update(dt)，并把按键写进 keys[]
const driverSrc = String.raw`
package Studio.runtime;

import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/** 无窗口驱动器：真运行时 + 真脚本，反射调 update(dt)，模拟按住方向键。 */
public final class VampRun {
    public static void main(String[] args) throws Exception {
        File boot = new File(args[0]).getAbsoluteFile();
        float seconds = args.length > 1 ? Float.parseFloat(args[1]) : 24f;
        float dt = args.length > 2 ? Float.parseFloat(args[2]) : 0.05f;
        TopDownRuntime rt = new TopDownRuntime(boot);
        ScriptEngine engine = rt.scripts;
        if (engine == null) {
            System.out.println("VAMP fatal: 没有脚本引擎");
            return;
        }
        Method update = ScriptEngine.class.getDeclaredMethod("update", float.class);
        update.setAccessible(true);
        Field keysField = TopDownRuntime.class.getDeclaredField("keys");
        keysField.setAccessible(true);
        boolean[] keys = (boolean[]) keysField.get(rt);
        int frames = Math.max(1, Math.round(seconds / dt));
        double maxMs = 0;
        double sumMs = 0;
        for (int i = 0; i < frames; i++) {
            // 前 10 秒站着不动（让怪追上来说明「不能站着不动」），之后绕圈走位
            boolean idle = i < Math.round(10f / dt);
            if (idle) {
                keys[87] = false; keys[65] = false; keys[83] = false; keys[68] = false;
            } else {
                int phase = ((i - Math.round(10f / dt)) / Math.max(1, Math.round(2f / dt))) % 4;
                keys[87] = phase == 0;            // W
                keys[68] = phase == 1;            // D
                keys[83] = phase == 2;            // S
                keys[65] = phase == 3;            // A
            }
            long t0 = System.nanoTime();
            update.invoke(engine, dt);
            double ms = (System.nanoTime() - t0) / 1e6;
            sumMs += ms;
            if (ms > maxMs) maxMs = ms;
        }
        System.out.printf("VAMP frames=%d avg=%.2fms max=%.2fms%n", frames, sumMs / frames, maxMs);
        System.out.println("VAMP done");
    }
}
`;
const driverPath = join(TMP, "VampRun.java");
mkdirSync(TMP, { recursive: true });
writeFileSync(driverPath, driverSrc, "utf8");

try {
  execFileSync("javac", [
    "--release", "8", "-encoding", "UTF-8", "-Xlint:-options",
    "-cp", join(LIB, "*"),
    "-d", CLASSES,
    ...javaFiles,
    driverPath
  ], { stdio: "pipe" });
  add("build", `javac ${javaFiles.length} 个运行时文件 + 驱动器`, true);
} catch (e) {
  add("build", "javac 编译", false, String(e.stderr ?? e.message).split("\n").slice(0, 3).join(" / "));
  finish();
}

// ---------------------------------------------------------------- 3) 导出 Build
section("3) 导出 Build");
rmSync(BUILD_ROOT, { recursive: true, force: true });
mkdirSync(BUILD_ROOT, { recursive: true });
let bootFile = join(BUILD_ROOT, "Build", "boot.json");
try {
  // 第 2 个参数传 null：让导出器自己收集工程里的 data URL 素材（传 [] 会被当成「没有素材」）
  // 第 3 个参数是输出根目录，导出器会在它下面建 Build/
  const build = await writeQuickBuild(project, null, BUILD_ROOT, () => {});
  for (const w of build.warnings ?? []) console.log(`    ⚠ ${w}`);
  add("export", "写 Build/boot.json", existsSync(bootFile), bootFile.split("Build")[1] ?? "");
  const boot = JSON.parse(readFileSync(bootFile, "utf8"));
  const jsScripts = (boot.scripts ?? []).filter((s) => s.lang === "js");
  add("export", "boot.json 里 JS 脚本带 file", jsScripts.length === jsNames.length && jsScripts.every((s) => s.file));
  const scriptDir = join(BUILD_ROOT, "Build", "scripts");
  const files = existsSync(scriptDir) ? readdirSync(scriptDir) : [];
  add("export", "Build/scripts 下生成了 ES5 文件", files.length >= jsNames.length, files.join(","));
} catch (e) {
  add("export", "导出 Build", false, String(e.message).split("\n")[0]);
  finish();
}

// ---------------------------------------------------------------- 4) headless 跑
section(`4) headless 跑 ${SECONDS}s（真运行时 + 真脚本）`);
const cp = [CLASSES, join(LIB, "*")].join(delimiter);
const run = spawnSync("java", ["-Dstdout.encoding=UTF-8", "-cp", cp, "Studio.runtime.VampRun", bootFile, String(SECONDS), String(DT)], {
  encoding: "utf8",
  cwd: REPO,
  timeout: 180000
});
const out = (run.stdout ?? "") + (run.stderr ?? "");
log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";

add("run", "运行时跑完", out.includes("VAMP done"), (out.match(/VAMP frames=[^\n]+/) ?? [""])[0]);

const has = (t) => log.includes(t);
const count = (re) => (log.match(re) ?? []).length;
add("run", "场景脚本启动", has("[吸血鬼] 开始"), "");
add("run", "玩家脚本就绪", has("[吸血鬼] player ready"), "");
add("run", "刷怪（出现波次/精英日志）", count(/\[吸血鬼\] (精英出现|第 \d+ 波)/g) >= 1,
  `waves=${count(/\[吸血鬼\] 第 \d+ 波/g)}`);
add("run", "自动开火击杀（击杀日志）", count(/\[吸血鬼\] 击杀 \d+/g) >= 1,
  `kills-log=${count(/\[吸血鬼\] 击杀 \d+/g)}`);
add("run", "升级并选择强化", count(/\[吸血鬼\] 升级/g) >= 1 && count(/\[吸血鬼\] 选择强化/g) >= 1,
  `levelup=${count(/\[吸血鬼\] 升级/g)} pick=${count(/\[吸血鬼\] 选择强化/g)}`);
add("run", "玩家受到接触伤害（首次受击）", count(/\[吸血鬼\] 首次受击/g) >= 1,
  `hpMarks=${count(/\[吸血鬼\] 首次受击/g)}`);
add("run", "无 [脚本错误]", !has("[脚本错误]"), `errors=${count(/\[脚本错误\]/g)}`);
add("run", "无 250ms 慢脚本告警", !has("执行过慢"), "");

const frameLine = (out.match(/VAMP frames=\d+ avg=[\d.]+ms max=[\d.]+ms/) ?? [""])[0];
const avg = Number((frameLine.match(/avg=([\d.]+)/) ?? [])[1] ?? "0");
add("run", `单帧平均耗时 < 8ms`, avg > 0 && avg < 8, frameLine);

finish();

function finish() {
  const pass = rows.filter((r) => r.pass).length;
  const fail = rows.length - pass;
  console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
  const report = [
    "# 吸血鬼幸存者示例 · 端到端校验",
    "",
    `- 工程：\`web/examples/吸血鬼幸存者.bwproj\``,
    `- 命令：\`node web/tools/verify-vampire.mjs --seconds ${SECONDS}\``,
    `- 结果：PASS ${pass} / FAIL ${fail}`,
    "",
    "| 段 | 检查 | 结果 | 说明 |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.section} | ${r.name} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "\\|")} |`)
  ].join("\n");
  writeFileSync(join(REPO, ".tmp_rel8", "report-vampire.md"), report + "\n", "utf8");
  console.log(`报告: .tmp_rel8/report-vampire.md`);
  if (fail > 0 && log) {
    const errs = log.split("\n").filter((l) => l.includes("[脚本错误]")).slice(0, 5);
    if (errs.length) console.log("脚本错误示例:\n" + errs.join("\n"));
  }
  process.exit(fail > 0 ? 1 : 0);
}
