// Java 8 兼容性闸门：模拟打包链路（web/tools/serve.mjs 与 package-bwe.mjs）的 javac 参数，
// 用 `--release 8` 编译 src/Studio/runtime/*.java（排除 GameLauncher.java）。
//
// 为什么需要它：打包/预览链路用 `--release 8`，而日常自检大多直接用 JDK 25 编译。
// 只要有任何一处用了 Java 9+ 的 API（例如 `PrintStream(OutputStream, boolean, Charset)`
// 是 Java 10+ 才有），**用户点「预览」或「打包」就会直接失败**，而本地自检全绿 —— 这个
// 盲区真实发生过：ScriptPerfTest 用了 Charset 重载，导致 javac 退出码 1。
//
// 用法：node web/tools/check-java8.mjs        （失败退出码 1）
//       node web/tools/check-java8.mjs --quiet
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RUNTIME_SRC = join(ROOT, "src", "Studio", "runtime");
const LIB = join(ROOT, "lib");
const OUT = join(ROOT, ".tmp_rel8", "java8-check");

const quiet = process.argv.includes("--quiet");

/** 与打包链路一致地挑 JDK：优先 JDK 17~25（JOGL 2.1 在 26 上崩，也不支持 --release 8 组合的期望）。 */
function findJavac() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, "bin", "javac"));
  const progFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  for (const base of [join(progFiles, "Microsoft"), join(progFiles, "Java"), join(progFiles, "Eclipse Adoptium")]) {
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base)) {
      const exe = join(base, dir, "bin", process.platform === "win32" ? "javac.exe" : "javac");
      if (existsSync(exe)) candidates.push(exe);
    }
  }
  candidates.push("javac"); // PATH 兜底
  return candidates[0] || "javac";
}

function run(exe, args) {
  return new Promise((resolvePromise) => {
    const p = spawn(exe, args, { cwd: ROOT, windowsHide: true, shell: false });
    let out = "";
    let err = "";
    p.stdout?.on("data", (d) => (out += d.toString("utf8")));
    p.stderr?.on("data", (d) => (err += d.toString("utf8")));
    p.on("error", (e) => resolvePromise({ code: -1, out, err: String(e) }));
    p.on("close", (code) => resolvePromise({ code, out, err }));
  });
}

const javac = findJavac();
if (!existsSync(RUNTIME_SRC)) {
  console.error(`找不到运行时源码目录：${RUNTIME_SRC}`);
  process.exit(2);
}

// 与 packaging 完全相同的源文件选择规则
const sources = readdirSync(RUNTIME_SRC)
  .filter((f) => f.endsWith(".java") && f !== "GameLauncher.java" && !f.endsWith("Test.java"))
  .map((f) => join(RUNTIME_SRC, f));

if (sources.length === 0) {
  console.error("运行时源码为空");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const started = Date.now();
const r = await run(javac, [
  "--release", "8",
  "-encoding", "UTF-8",
  "-Xlint:-options",
  "-cp", join(LIB, "*"),
  "-d", OUT,
  ...sources
]);
const ms = Date.now() - started;

if (r.code === 0) {
  if (!quiet) {
    console.log(`✅ Java 8 兼容：${sources.length} 个源文件编译通过（${ms}ms）`);
    console.log(`   编译器：${javac}`);
    console.log(`   与打包链路同参数：--release 8 -encoding UTF-8 -cp "lib/*" -d <tmp>`);
  }
  process.exit(0);
}

console.error("❌ Java 8 兼容性失败 —— 打包/预览链路会直接报错（用户点「预览」「打包」会失败）");
console.error(`   编译器：${javac}`);
console.error(`   参数：--release 8 -encoding UTF-8 -Xlint:-options -cp "lib/*" -d ${OUT}`);
console.error("");
const text = (r.out + r.err).trim();
if (text) {
  for (const line of text.split(/\r?\n/)) console.error("   " + line);
} else {
  console.error("   （javac 无输出，退出码 " + r.code + "）");
}
console.error("");
console.error("   常见原因：用了 Java 9+ 才有的 API / 语法。例如");
console.error("     - PrintStream(OutputStream, boolean, Charset)      → Java 10+，改用 String 重载");
console.error("     - List.of(...) / Map.of(...) / Set.of(...)         → Java 9+");
console.error("     - var / 文本块 \"\"\" / 箭头函数式 switch           → Java 10+/13+/14+");
process.exit(1);
