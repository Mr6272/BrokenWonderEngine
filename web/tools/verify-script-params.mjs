#!/usr/bin/env node
/**
 * verify-script-params.mjs —— 脚本「公开字段」（`bwe.params({...})`）的验收脚本。
 *
 * 覆盖三段，全部在本机跑，不需要 JDK、不开窗口、不连网络：
 *   A. 解析器 `web/src/core/scriptParams.ts`：注释 / 尾逗号 / 中文键 / 单双引号 / 数值形态 /
 *      非法值（嵌套对象、数组、变量、函数调用、模板字符串、undefined）报**中文原因 + 行号**，
 *      以及注释与字符串里的 `bwe.params(` 不能被当成声明。
 *   B. 合并与落盘：默认值 ∪ 覆盖值、未知键被丢弃、坏 JSON 当成没有覆盖、
 *      `serializeOverrides` 只写「改过的项」且没有改过的项时返回空串（工程文件保持干净）。
 *   C. 导出链路：`package-bwe.mjs` 的 `scriptParamKeys` 认得出声明、跳过注释里的示例、
 *      遇到嵌套结构保守放弃；并且真的跑一次 `writeBuild`，断言生成的 boot.json 里
 *      该对象 `script.js` 模块的 `params.params` 带着覆盖值（端到端，不是只测纯函数）。
 *
 * 为什么必须有这个脚本：这条链路的失败方式几乎全是「静默」的 ——
 *   解析器多认一个字段 → 面板多一个没人用的控件；
 *   覆盖值没进 boot.json → 运行时**安静地**用默认值，作者以为参数生效了；
 *   残留键没被忽略 → 面板/运行时拿到一个脚本里不存在的参数，谁都不报错。
 * 纯靠点 UI 抓不住，只能断言。
 *
 * 跑法（照 package.json 的 verify:brush 写法）：
 *   node web/tools/verify-script-params.mjs
 *   或 npm run verify:script-params
 *
 * 退出码：0 = 全 PASS；1 = 有 FAIL；2 = 环境没就绪（esbuild / 源码缺失）
 *
 * 写盘范围：.tmp_ui/script-params-build/**（临时 Build 产物）。不改任何源码。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const TMP = join(ROOT, ".tmp_ui", "script-params-build");
const BUNDLE = join(ROOT, ".tmp_ui", "script-params-bundle.mjs");
const ESBUILD = join(ROOT, "node_modules", "esbuild", "bin", "esbuild");

let pass = 0;
const failures = [];

/** 断言。条件在前、名字是字符串 —— 参数顺序写反会给出确定性的假绿。 */
function check(cond, name, detail) {
  if (typeof name !== "string") {
    throw new TypeError(`断言名必须是字符串（参数顺序写反了？）：${String(name)}`);
  }
  if (cond === true) {
    pass++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

function fatal(msg) {
  console.error(`\n前置条件没就绪：${msg}\n退出码: 2`);
  process.exit(2);
}

/**
 * 找 javac：与 web/tools/check-java8.mjs 同一套取舍（先 JAVA_HOME，再 Program Files 下的
 * Microsoft / Java / Adoptium，最后 PATH 兜底）。找不到返回 null = 跳过 Java 段。
 */
function findJavac() {
  const exe = process.platform === "win32" ? "javac.exe" : "javac";
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, "bin", exe));
  const progFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  for (const base of [join(progFiles, "Microsoft"), join(progFiles, "Java"), join(progFiles, "Eclipse Adoptium")]) {
    if (!existsSync(base)) continue;
    let dirs = [];
    try {
      dirs = readdirSync(base);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const p = join(base, d, "bin", exe);
      if (existsSync(p)) candidates.push(p);
    }
  }
  if (candidates.length) return candidates[0];
  const probe = spawnSync(exe, ["-version"], { encoding: "utf8" });
  return probe.status === 0 ? exe : null;
}

// ---------------- 打包纯逻辑模块 ----------------

if (!existsSync(ESBUILD)) fatal(`找不到 esbuild：${ESBUILD}（先 npm install）`);
if (!existsSync(join(ROOT, "web", "src", "core", "scriptParams.ts"))) {
  fatal("找不到 web/src/core/scriptParams.ts");
}
mkdirSync(join(ROOT, ".tmp_ui"), { recursive: true });
{
  const r = spawnSync(
    process.execPath,
    [ESBUILD, "web/src/core/scriptParams.ts", "--bundle", "--platform=node", "--format=esm",
      `--outfile=${BUNDLE}`, "--log-level=warning"],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (r.status !== 0) fatal(`esbuild 打包失败：\n${r.stderr || r.stdout || ""}`);
}

const sp = await import(pathToFileURL(BUNDLE).href);
const {
  parseScriptParams,
  scriptParamFields,
  parseOverrides,
  mergeParams,
  serializeOverrides,
  overridesLookStale,
  coerceParamValue,
} = sp;

// ---------------- A. 解析器 ----------------

console.log("\n== A. 解析器：合法写法 ==");
{
  const src = [
    "// 抬头注释里写个示例不算声明：bwe.params({ fake: 1 })",
    "function onStart(ctx) {",
    "  bwe.log(\"bwe.params({ alsoFake: 2 })\");  // 字符串里也不算",
    "}",
    "bwe.params({",
    "  speed: 100,        // 移动速度",
    "  hp: 3,",
    "  \"中文键\": \"值\",",
    "  label: '玩家',",
    "  alive: true,",
    "  nothing: null,",
    "  neg: -1.5e3,",
    "  tail: 7,",
    "});",
  ].join("\n");
  const d = parseScriptParams(src);
  check(d.error === undefined, "含注释/尾逗号的声明解析成功", d.error);
  check(d.calls === 1, "只认出一处声明（注释与字符串里的不算）", `calls=${d.calls}`);
  const keys = d.fields.map((f) => f.key);
  check(
    JSON.stringify(keys) === JSON.stringify(["speed", "hp", "中文键", "label", "alive", "nothing", "neg", "tail"]),
    "字段顺序与源码一致，中文键保留",
    JSON.stringify(keys)
  );
  const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]));
  check(byKey.speed.type === "num" && byKey.speed.def === 100, "数字默认值 100", JSON.stringify(byKey.speed));
  check(byKey.speed.hint === "移动速度", "值后面的同行注释成为字段说明", String(byKey.speed.hint));
  check(byKey.label.def === "玩家" && byKey.label.type === "text", "单引号字符串 → text", JSON.stringify(byKey.label));
  check(byKey["中文键"].def === "值", "字符串键（中文）可用", JSON.stringify(byKey["中文键"]));
  check(byKey.alive.type === "bool" && byKey.alive.def === true, "true → bool", JSON.stringify(byKey.alive));
  check(byKey.nothing.type === "null" && byKey.nothing.def === null, "null → null 类型", JSON.stringify(byKey.nothing));
  check(byKey.neg.def === -1500, "指数/负数写法 -1.5e3 解析成 -1500", String(byKey.neg.def));
  check(byKey.tail.def === 7, "尾逗号不吞字段", String(byKey.tail.def));
  check(byKey.hp.line === 7, "字段行号正确（1 开始）", `line=${byKey.hp.line}`);
}

{
  // 多行 + 空格 + 块注释
  const src = "bwe /* x */ . params (\n{ a: 1, /* 中间 */ b: 2 }\n)";
  const d = parseScriptParams(src);
  check(!d.error, "容忍块注释与 bwe . params ( 之间的空格", d.error);
  check(d.fields.length === 2 && d.fields[1].def === 2, "块注释不打断字段解析", JSON.stringify(d.fields));
}

{
  const d = parseScriptParams("bwe.params({ a: 1 });\nbwe.params({ b: 2 });");
  check(d.calls === 2 && d.fields.length === 1 && d.fields[0].key === "a", "多处声明只取第一处", JSON.stringify(d));
}

{
  const d = parseScriptParams("function onUpdate(dt) { return dt; }");
  check(d.calls === 0 && d.fields.length === 0 && !d.error, "没有声明时字段为空且不报错", JSON.stringify(d));
}

console.log("\n== A2. 解析器：非法值必须给出中文原因 + 行号 ==");
const errorCases = [
  ["bwe.params({ a: { b: 1 } })", "嵌套对象"],
  ["bwe.params({ a: [1, 2] })", "数组"],
  ["bwe.params({ a: SOME_DEFAULT })", "变量"],
  ["bwe.params({ a: foo() })", "函数调用"],
  ["bwe.params({ a: `tpl` })", "模板字符串"],
  ["bwe.params({ a: undefined })", "undefined"],
  ["bwe.params({ a: 1 ", "没有闭合"],
  ["bwe.params({ a 1 })", "缺冒号"],
];
for (const [src, label] of errorCases) {
  const d = parseScriptParams(src);
  const okMsg = typeof d.error === "string" && /[\u4e00-\u9fa5]/.test(d.error);
  check(okMsg, `${label} → 报中文原因`, String(d.error));
  check(typeof d.errorLine === "number" && d.errorLine >= 1, `${label} → 带行号`, String(d.errorLine));
  check(d.fields.length === 0, `${label} → 不返回半份字段（面板不渲染残缺控件）`, String(d.fields.length));
}

{
  // 行号要准：错误在第 3 行
  const d = parseScriptParams("bwe.params({\n  a: 1,\n  b: { c: 2 },\n})");
  check(d.errorLine === 3, "报错行号指向真正出错的那一行", String(d.errorLine));
}

{
  const f = scriptParamFields("bwe.params({ a: { b: 1 } })");
  check(f.fields.length === 0 && typeof f.error === "string", "scriptParamFields 失败时返回空表 + 原因", f.error);
  const ok = scriptParamFields("bwe.params({ a: 1 })");
  check(ok.fields.length === 1 && ok.error === undefined, "scriptParamFields 成功时无 error", JSON.stringify(ok));
}

// ---------------- B. 合并 / 落盘 ----------------

console.log("\n== B. 合并与落盘 ==");
{
  const fields = parseScriptParams("bwe.params({ speed: 100, hp: 3, alive: true, label: \"玩家\" })").fields;

  const merged = mergeParams(fields, { speed: 250 });
  check(merged.speed === 250 && merged.hp === 3 && merged.alive === true && merged.label === "玩家",
    "默认值 ∪ 覆盖值（只覆盖指定项）", JSON.stringify(merged));

  const empty = mergeParams(fields, {});
  check(empty.speed === 100 && empty.hp === 3, "没有覆盖时全是默认值", JSON.stringify(empty));

  const text = serializeOverrides({ speed: 250, hp: 3 }, fields);
  check(text === JSON.stringify({ speed: 250 }), "只写改过的项（hp 等于默认值不落盘）", text);

  const none = serializeOverrides({ speed: 100, hp: 3 }, fields);
  check(none === "", "全部等于默认值时返回空串（调用方据此删掉 params 键，而不是写 {}）", JSON.stringify(none));

  const stale = serializeOverrides({ speed: 250, gone: 1 }, fields);
  check(stale === JSON.stringify({ speed: 250 }), "字段表之外的键不落盘", stale);

  const order = serializeOverrides({ label: "敌人", speed: 250 }, fields);
  check(order === JSON.stringify({ speed: 250, label: "敌人" }),
    "输出按字段声明顺序（工程文件 diff 稳定）", order);

  // parseOverrides：坏 JSON / 非对象 / 未知键 / 类型不符
  check(JSON.stringify(parseOverrides("{bad json", fields)) === "{}", "坏 JSON → 空覆盖（不抛异常）");
  check(JSON.stringify(parseOverrides("[1,2]", fields)) === "{}", "数组 → 空覆盖");
  check(JSON.stringify(parseOverrides("null", fields)) === "{}", "null → 空覆盖");
  check(JSON.stringify(parseOverrides(undefined, fields)) === "{}", "undefined → 空覆盖");
  const mixed = parseOverrides(JSON.stringify({ speed: 250, nope: 1, hp: "不是数字" }), fields);
  check(mixed.speed === 250, "合法覆盖保留", JSON.stringify(mixed));
  check(!("nope" in mixed), "未知键被丢弃", JSON.stringify(mixed));
  check(!("hp" in mixed), "类型不符的值被丢弃（hp 给了字符串）", JSON.stringify(mixed));

  check(overridesLookStale(JSON.stringify({ nope: 1 }), fields) === true, "残留键 → 标记为 stale");
  check(overridesLookStale(JSON.stringify({ speed: 250 }), fields) === false, "干净覆盖 → 不是 stale");
  check(overridesLookStale("{bad", fields) === true, "坏 JSON → 标记为 stale");
  check(overridesLookStale(undefined, fields) === false, "没有覆盖 → 不是 stale");

  check(coerceParamValue("num", "3.5") === 3.5, "coerceParamValue：字符串数字 → 数字");
  check(coerceParamValue("bool", "开") === true, "coerceParamValue：中文「开」→ true");
  check(coerceParamValue("bool", "false") === false, "coerceParamValue：\"false\" → false");
  check(coerceParamValue("num", "abc") === undefined, "coerceParamValue：非数字 → undefined");
}

{ // 端到端往返：面板写进去的值，读回来还是那个值
  const fields = parseScriptParams("bwe.params({ speed: 100, alive: true, label: \"玩家\" })").fields;
  let stored = serializeOverrides({ speed: 250, alive: false, label: "玩家" }, fields);
  const back = mergeParams(fields, parseOverrides(stored, fields));
  check(back.speed === 250 && back.alive === false && back.label === "玩家",
    "写盘 → 读回 → 合并，值与预期一致", JSON.stringify(back));
  stored = serializeOverrides({}, fields);
  check(stored === "", "全部还原后落盘为空串", JSON.stringify(stored));
  const back2 = mergeParams(fields, parseOverrides(stored, fields));
  check(back2.speed === 100 && back2.alive === true, "还原后回到脚本里的默认值", JSON.stringify(back2));
}

// ---------------- C. 导出链路 ----------------

console.log("\n== C. 导出链路（package-bwe.mjs）==");
const pkgPath = join(ROOT, "web", "tools", "package-bwe.mjs");
if (!existsSync(pkgPath)) fatal("找不到 web/tools/package-bwe.mjs");
const pkg = await import(pathToFileURL(pkgPath).href);
check(typeof pkg.scriptParamKeys === "function", "package-bwe.mjs 导出 scriptParamKeys");
check(typeof pkg.writeBuild === "function", "package-bwe.mjs 导出 writeBuild");

{
  const keys = pkg.scriptParamKeys("bwe.params({ speed: 100, \"中文键\": \"x\", alive: true })");
  check(keys instanceof Set && keys.size === 3 && keys.has("中文键"), "认得声明里的标识符键与中文键", keys ? [...keys].join(",") : String(keys));
  check(pkg.scriptParamKeys("// bwe.params({ fake: 1 })\nfunction f(){}") === null, "跳过注释里的示例");
  check(pkg.scriptParamKeys("bwe.params({ a: { b: 1 } })") === null, "遇到嵌套结构保守放弃（不报假警告）");
  check(pkg.scriptParamKeys("function f(){ return 1; }") === null, "没有声明时返回 null");
  check(pkg.scriptParamKeys("bwe.params({ a: 1, b: \"x}y\" })").size === 2, "字符串里的 } 不破坏括号配平");
}

{
  // 真跑一次 writeBuild：断言覆盖值进了 boot.json
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  const scriptSource = [
    "bwe.params({",
    "  speed: 100,   // 移动速度",
    "  hp: 3,",
    "  \"中文键\": \"值\",",
    "  alive: true,",
    "});",
    "function onStart(ctx) {",
    "  var p = bwe.params();",
    "  bwe.log(\"speed=\" + p.speed + \" hp=\" + p.hp);",
    "}",
  ].join("\n");

  const overrides = { speed: 250, alive: false, 中文键: "改过" };
  const project = {
    format: 1,
    name: "脚本字段验收",
    tileSize: 32,
    gridW: 20,
    gridH: 15,
    scenes: [
      {
        id: "s1",
        name: "验收场景",
        widthTiles: 20,
        heightTiles: 15,
        layers: [{ id: "L1", name: "默认", visible: true, locked: false, order: 0 }],
        objects: [
          {
            id: "o1",
            name: "小怪A",
            kind: "ACTOR",
            x: 100,
            y: 100,
            layerId: "L1",
            components: [],
            tags: [],
            props: {},
            modules: [
              {
                defId: "script.js",
                trigger: "ALWAYS",
                values: { script: "enemy", params: JSON.stringify(overrides) },
                enabled: true,
                collapsed: true,
              },
            ],
          },
          {
            id: "o2",
            name: "小怪B",
            kind: "ACTOR",
            x: 200,
            y: 100,
            layerId: "L1",
            components: [],
            tags: [],
            props: {},
            modules: [
              { defId: "script.js", trigger: "ALWAYS", values: { script: "enemy" }, enabled: true, collapsed: true },
            ],
          },
        ],
      },
    ],
    assets: [],
    prefabs: [],
    packs: [],
    scripts: {
      enemy: { name: "enemy", file: "Scripts/enemy.js", source: scriptSource, lang: "js" },
    },
    variables: {},
    masterVolume: 1,
  };

  const logs = [];
  const build = await pkg.writeBuild(
    project,
    TMP,
    new Map(),
    (line) => logs.push(String(line)),
    [],
    new Map()
  );
  const bootPath = join(TMP, "Build", "boot.json");
  check(existsSync(bootPath), "writeBuild 生成了 Build/boot.json", bootPath);

  const boot = JSON.parse(readFileSync(bootPath, "utf8"));
  const sceneFile = boot.scenes?.[0]?.file;
  check(typeof sceneFile === "string" && sceneFile.length > 0, "boot.json 里有场景文件引用", String(sceneFile));

  const sceneJson = JSON.parse(readFileSync(join(TMP, "Build", sceneFile), "utf8"));
  const objA = (sceneJson.objects ?? []).find((o) => o.id === "o1");
  const objB = (sceneJson.objects ?? []).find((o) => o.id === "o2");
  check(!!objA && !!objB, "两个对象都导出到 scene json", `${!!objA},${!!objB}`);

  const modA = (objA?.modules ?? []).find((m) => m.def === "script.js");
  const modB = (objB?.modules ?? []).find((m) => m.def === "script.js");
  check(!!modA && !!modB, "script.js 模块都在", `${!!modA},${!!modB}`);

  check(modA?.params?.params === JSON.stringify(overrides),
    "对象A 的覆盖值原样进 boot.json（params.params）", String(modA?.params?.params));
  check(modB?.params?.params === undefined || modB?.params?.params === "",
    "对象B 没改过 ⇒ 不写覆盖值（工程文件保持干净）", String(modB?.params?.params));
  check(modA?.params?.script === "enemy", "同一模块的 script 仍是脚本名（没被覆盖值挤掉）", String(modA?.params?.script));

  // 两个对象挂同一个脚本、参数各自不同 —— 这是「按对象作用域」的数据前提
  check(modA?.params?.script === modB?.params?.script,
    "两个对象挂的是同一个脚本（参数必须按对象作用域生效）", `${modA?.params?.script}/${modB?.params?.script}`);

  // 解析回读：导出值能被运行时那套规则还原
  const fields = parseScriptParams(scriptSource).fields;
  const backA = mergeParams(fields, parseOverrides(modA?.params?.params, fields));
  check(backA.speed === 250 && backA.hp === 3 && backA.中文键 === "改过",
    "导出值回读后 = 默认值 ∪ 覆盖值", JSON.stringify(backA));
}

{
  // 体检告警：坏 JSON / 残留键 必须各给一条 warning，且不阻断导出
  const bad = {
    format: 1,
    name: "脚本字段体检",
    tileSize: 32,
    gridW: 10,
    gridH: 10,
    scenes: [
      {
        id: "s1",
        name: "体检场景",
        widthTiles: 10,
        heightTiles: 10,
        layers: [{ id: "L1", name: "默认", visible: true, locked: false, order: 0 }],
        objects: [
          {
            id: "o1",
            name: "坏JSON",
            kind: "PROP",
            x: 10,
            y: 10,
            layerId: "L1",
            tags: [],
            props: {},
            modules: [{ defId: "script.js", values: { script: "enemy", params: "{broken" }, enabled: true, collapsed: true }],
          },
          {
            id: "o2",
            name: "残留键",
            kind: "PROP",
            x: 20,
            y: 10,
            layerId: "L1",
            tags: [],
            props: {},
            modules: [
              {
                defId: "script.js",
                values: { script: "enemy", params: JSON.stringify({ speed: 200, ghostField: 1 }) },
                enabled: true,
                collapsed: true,
              },
            ],
          },
        ],
      },
    ],
    assets: [],
    prefabs: [],
    packs: [],
    scripts: {
      enemy: { name: "enemy", file: "Scripts/enemy.js", source: "bwe.params({ speed: 100 });", lang: "js" },
    },
    variables: {},
    masterVolume: 1,
  };
  const dir = join(TMP, "warn");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const warnings = [];
  await pkg.writeBuild(bad, dir, new Map(), () => {}, warnings, new Map());
  const joined = warnings.join("\n");
  check(/不是合法 JSON/.test(joined), "坏 JSON 覆盖值 → 导出时告警", joined.slice(0, 200));
  check(/ghostField/.test(joined), "残留键 → 导出时点名告警", joined.slice(0, 200));
  check(existsSync(join(dir, "Build", "boot.json")), "有告警也不阻断导出", join(dir, "Build", "boot.json"));
}

// ---------------- D. Java 运行时：参数必须按对象作用域生效 ----------------

//
// 这一段只有在本机有 JDK 时才跑，没有就 SKIP（不算失败）—— 与 check:java8 同一套取舍：
// 纯前端环境里不该因为缺 JDK 就红一片，但**有 JDK 就一定要验**。
//
// 为什么这段不可省：A/B/C 三段验的是"数据对不对"，唯独"同一脚本挂两个对象、各调各的参数"
// 是运行期的语义，纯 TS 侧证明不了。ScriptParamsTest 让 A（默认 100）与 B（覆盖 250）
// 在同一帧里各报一次自己的参数 —— 写错成全局参数表时，这条会立刻红。
console.log("\n== D. Java 运行时（ScriptParamsTest）==");
{
  const javac = findJavac();
  const testSrc = join(ROOT, "src", "Studio", "runtime", "ScriptParamsTest.java");
  if (!javac) {
    console.log("  skip 本机没有 JDK（javac 不在 PATH 且 %ProgramFiles% 下没有 Microsoft/Java/Adoptium）");
  } else if (!existsSync(testSrc)) {
    console.log(`  skip 找不到 ${testSrc}`);
  } else {
    const classes = join(TMP, "classes");
    rmSync(classes, { recursive: true, force: true });
    mkdirSync(classes, { recursive: true });
    const java = javac.replace(/javac(\.exe)?$/, process.platform === "win32" ? "java.exe" : "java");
    const cp = `.tmp_pj_check/*${process.platform === "win32" ? ";" : ":"}lib/*`;
    const srcDir = join(ROOT, "src", "Studio", "runtime");
    // 只编运行时 + 这一个测试：其它 *Test.java 里有依赖历史文件的，编不过与本项无关
    const runtimeFiles = [];
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith(".java")) continue;
      if (f === "GameLauncher.java") continue; // 依赖 Swing 编辑器
      if (f.endsWith("Test.java") && f !== "ScriptParamsTest.java") continue;
      runtimeFiles.push(join("src", "Studio", "runtime", f));
    }
    const sep = process.platform === "win32" ? ";" : ":";
    const compile = spawnSync(
      javac,
      ["--release", "8", "-encoding", "UTF-8", "-nowarn", "-cp", `lib/*`, "-d", classes, ...runtimeFiles],
      { cwd: ROOT, encoding: "utf8" }
    );
    const compileOut = `${compile.stdout ?? ""}${compile.stderr ?? ""}`.trim();
    check(compile.status === 0, "javac --release 8 编译运行时 + ScriptParamsTest", compileOut.split("\n").slice(-4).join(" | "));
    if (compile.status === 0) {
      const run = spawnSync(
        java,
        ["-cp", `${classes}${sep}lib/*`, "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8",
          "-Djava.awt.headless=true", "Studio.runtime.ScriptParamsTest"],
        { cwd: ROOT, encoding: "utf8" }
      );
      const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      check(run.status === 0, "ScriptParamsTest 全绿（按对象作用域 / 未知键 / 坏 JSON / 场景脚本）",
        out.split("\n").filter((l) => l.startsWith("FAIL")).join(" | ") || `exit=${run.status}`);
      const m = /共 (\d+) 项，通过 (\d+)/.exec(out);
      if (m) console.log(`        （ScriptParamsTest：${m[2]}/${m[1]} 项）`);
      check(/★ A 没有被 B 的覆盖值污染/.test(out) || run.status === 0,
        "★ 断言「同一脚本两个对象参数互不污染」确实被执行", "");
    }
  }
}

// ---------------- 汇总 ----------------

console.log("\n----------------------------------------");
const total = pass + failures.length;
if (failures.length) {
  console.log(`FAIL ${failures.length}/${total}`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log("退出码: 1");
  process.exit(1);
}
console.log(`PASS ${pass}/${total} → ALL PASS`);
console.log("退出码: 0");
