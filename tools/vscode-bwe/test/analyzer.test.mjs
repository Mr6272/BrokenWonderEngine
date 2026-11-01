#!/usr/bin/env node
/**
 * 规则检查器测试（纯 node，不需要 vscode）。
 *
 * 两组用例：
 *   1. 命中：每条规则至少一个「应该报」的片段；
 *   2. 不命中：注释 / 字符串里的宿主 API、对象属性名、正常 BWE 写法都不能误报；
 *      另外跑仓库里 6 个真实示例工程的全部 lang=js 脚本，要求 **0 诊断**（防误报的回归基线）。
 *
 * 输出 PASS / FAIL，退出码 0 / 1。
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(EXT_ROOT, "..", "..");
const nodeRequire = createRequire(import.meta.url);

const analyzer = nodeRequire(join(EXT_ROOT, "lib", "analyzer.js"));
const apiIndex = nodeRequire(join(EXT_ROOT, "lib", "apiIndex.js"));

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` —— ${extra}` : ""}`);
    console.log(`FAIL  ${name}${extra ? ` —— ${extra}` : ""}`);
  }
}

function analyze(src) {
  return analyzer.analyze(src, { index: apiIndex });
}

function ruleSet(src) {
  return new Set(analyze(src).diagnostics.map((d) => d.rule));
}

function messages(src) {
  return analyze(src).diagnostics.map((d) => `${d.rule}@${d.line}:${d.col} ${d.message}`);
}

// ============================================================================
// 1. 命中用例
// ============================================================================

ok(
  "E001 import 静态导入被报为 error",
  ruleSet('import x from "y";\n').has("E001") &&
    analyze('import x from "y";\n').diagnostics.every((d) => d.severity === "error" || d.rule !== "E001"),
  messages('import x from "y";\n').join(" | ")
);

ok("E001 import() 动态导入被报", ruleSet("var m = import('x');\n").has("E001"));

ok("E002 require 被报为 error", ruleSet('var fs = require("fs");\n').has("E002"));

ok("E003 export default 被报", ruleSet("export default function () {}\n").has("E003"));

ok("E003 module.exports 被报", ruleSet("module.exports = {};\n").has("E003"));

ok("E004 document 被报", ruleSet("document.body.innerHTML = '';\n").has("E004"));

ok("E004 window 被报", ruleSet("var w = window.innerWidth;\n").has("E004"));

ok("E004 localStorage 被报", ruleSet("localStorage.setItem('a', 'b');\n").has("E004"));

ok("E004 fetch 被报", ruleSet("fetch('http://x');\n").has("E004"));

ok("E004 XMLHttpRequest 被报", ruleSet("new XMLHttpRequest();\n").has("E004"));

ok("E005 setTimeout 被报为 warning", ruleSet("setTimeout(function () {}, 100);\n").has("E005"));

ok("E005 setInterval 被报", ruleSet("setInterval(function () {}, 100);\n").has("E005"));

ok("E006 onSceneStart 里的 ctx.self 被报为 error", ruleSet("function onSceneStart(ctx) {\n  ctx.self.x = 1;\n}\n").has("E006"));

ok("E006 onSceneEnd 里的 ctx.self 被报", ruleSet("function onSceneEnd(ctx) {\n  var e = ctx.self;\n  e.destroy();\n}\n").has("E006"));

ok("W001 console.log 被报为 warning", ruleSet("console.log('hi');\n").has("W001"));

ok("W002 拼错的成员给出候选", /是不是想写 bwe\.world/.test(messages("bwe.wrold.find(1);\n").join()), messages("bwe.wrold.find(1);\n").join(" | "));

ok("W003 eval 被报", ruleSet("eval('1+1');\n").has("W003"));

// 行号/列号正确性：第一行第一个字符
{
  const d = analyze("document.title = 'x';\n").diagnostics[0];
  ok("诊断行号列为 1:1", d && d.line === 1 && d.col === 1, JSON.stringify(d));
}
{
  const d = analyze("var a = 1;\nvar b = 2;\n  document.title = 'x';\n").diagnostics[0];
  ok("诊断定位到第 3 行第 3 列", d && d.line === 3 && d.col === 3, JSON.stringify(d));
}

// ============================================================================
// 2. 不命中用例（防误报）
// ============================================================================

ok("注释里的 import 不报", ruleSet("// import x from 'y'; /* require('fs') */\nvar a = 1;\n").size === 0, messages("// import x from 'y'; /* require('fs') */\n").join(" | "));

ok("字符串里的 document 不报", ruleSet('var s = "document.title";\nvar t = \'setTimeout\';\n').size === 0, messages('var s = "document.title";\n').join(" | "));

ok("对象属性名 setTimeout 不报", ruleSet("var o = { setTimeout: 1 };\no.setTimeout(2);\n").size === 0, messages("var o = { setTimeout: 1 };\n").join(" | "));

ok("普通 BWE 脚本 0 诊断", ruleSet(sampleGoodScript()).size === 0, messages(sampleGoodScript()).join(" | "));

ok("onSceneStart 里用 bwe.world.find 不报 E006", ruleSet('function onSceneStart(ctx) {\n  bwe.world.find("玩家");\n}\n').size === 0, messages('function onSceneStart(ctx) {\n  bwe.world.find("玩家");\n}\n').join(" | "));

ok("对象脚本里的 ctx.self 不报 E006", ruleSet("function onUpdate(ctx, dt) {\n  var e = ctx.self;\n  e.x += 1;\n}\n").size === 0, messages("function onUpdate(ctx, dt) {\n  var e = ctx.self;\n  e.x += 1;\n}\n").join(" | "));

ok("bwe.textinput.validate / refreshHints / hint 不误报（Java 已实现、d.ts 尚未收录）", ruleSet('bwe.textinput.validate("rows");\nbwe.textinput.refreshHints();\nbwe.textinput.hint("rows");\n').size === 0, messages('bwe.textinput.validate("rows");\n').join(" | "));

ok("未知命名空间（非拼错）不报 W002", ruleSet("bwe.zzzwhatever.foo();\n").size === 0, messages("bwe.zzzwhatever.foo();\n").join(" | "));

// ============================================================================
// 3. 真实示例脚本回归（0 误报）
// ============================================================================

const EXAMPLES = join(REPO_ROOT, "web", "examples");
let checkedScripts = 0;
let totalDiags = 0;
const offenders = [];

if (existsSync(EXAMPLES)) {
  for (const file of readdirSync(EXAMPLES)) {
    if (!file.endsWith(".bwproj")) continue;
    let project;
    try {
      project = JSON.parse(readFileSync(join(EXAMPLES, file), "utf8"));
    } catch {
      continue;
    }
    for (const [name, entry] of Object.entries(project.scripts || {})) {
      if ((entry && entry.lang ? entry.lang : "yarn") !== "js") continue;
      const source = String((entry && entry.source) || "");
      if (!source.trim()) continue;
      checkedScripts += 1;
      const diags = analyze(source).diagnostics;
      totalDiags += diags.length;
      const lines = source.split("\n").length;
      if (!diags.length) {
        console.log(`       · ${file}/${name}（${lines} 行）：0 诊断`);
      } else {
        offenders.push(`${file}/${name}: ${diags.map((d) => `${d.rule}@${d.line}`).join(", ")}`);
        console.log(`       · ${file}/${name}（${lines} 行）：${diags.length} 条 → ${diags.map((d) => `${d.rule}@${d.line}`).join(", ")}`);
      }
    }
  }
}

ok(
  `真实示例脚本 ${checkedScripts} 个全部 0 诊断（不误报正常代码）`,
  checkedScripts > 0 && totalDiags === 0,
  offenders.join(" ; ")
);

// ============================================================================
// 3b. 手工验证用 fixtures（VS Code 里打开这两个文件就能看到诊断/看不到诊断）
// ============================================================================

{
  const fixtures = join(HERE, "fixtures");
  const good = join(fixtures, "demo-good.js");
  const bad = join(fixtures, "demo-bad.js");
  ok("fixtures/demo-good.js 存在", existsSync(good), good);
  ok("fixtures/demo-bad.js 存在", existsSync(bad), bad);
  if (existsSync(good)) {
    const diags = analyze(readFileSync(good, "utf8")).diagnostics;
    ok("fixtures/demo-good.js 0 诊断（打开 VS Code 应看不到任何波浪线）", diags.length === 0, diags.map((d) => `${d.rule}@${d.line}`).join(","));
  }
  if (existsSync(bad)) {
    const diags = analyze(readFileSync(bad, "utf8")).diagnostics;
    const rules = diags.map((d) => d.rule);
    ok(
      "fixtures/demo-bad.js 命中 6 条（E001/E005/E004/W001/W002/E006）",
      ["E001", "E005", "E004", "W001", "W002", "E006"].every((r) => rules.includes(r)) && diags.length === 6,
      rules.join(",")
    );
  }
}

// ============================================================================
// 4. 规则清单完整性（README / 测试共用一份）
// ============================================================================

const catalog = analyzer.ruleCatalog();
const codes = catalog.map((r) => r.code);
ok("规则清单条数与 RULES 一致（9 条）", codes.length === Object.keys(analyzer.RULES).length && codes.length >= 9, codes.join(","));
ok("每条规则都有 severity 与 message", catalog.every((r) => (r.severity === "error" || r.severity === "warning") && r.message));
ok(
  "规则清单覆盖任务要求的全部检查项（import/require/export/宿主对象/定时器/onSceneStart.ctx.self）",
  ["E001", "E002", "E003", "E004", "E005", "E006"].every((c) => codes.includes(c)),
  codes.join(",")
);

// ============================================================================

function sampleGoodScript() {
  return [
    "// 一个典型的 BWE 对象脚本（正常写法，不应有任何诊断）",
    "var STATE = { ready: false, frame: 0 };",
    "",
    "function onStart(ctx) {",
    '  STATE.ready = true;',
    '  bwe.log("[脚本] ready");',
    '  bwe.camera.follow(ctx.self, { smooth: 0.18 });',
    "}",
    "",
    "function onUpdate(ctx, dt) {",
    "  if (!STATE.ready || !ctx.self) return;",
    "  STATE.frame += 1;",
    '  if (bwe.input.pressed("Space")) {',
    "    bwe.after(0.2, function () {",
    '      bwe.world.spawn({ x: ctx.self.x, y: ctx.self.y, asset: "a.png" });',
    "    });",
    "  }",
    '  bwe.draw.text(16, 16, "FPS", { size: 12 });',
    "}",
    "",
    "function onSceneStart(ctx) {",
    '  var player = bwe.world.find({ tag: "玩家" });',
    '  bwe.every(1, function () { bwe.time.frame; });',
    "}",
    "",
  ].join("\n");
}

// ============================================================================
console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✅ analyzer 测试全绿");
process.exit(0);
