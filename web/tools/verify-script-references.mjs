#!/usr/bin/env node
/**
 * verify-script-references.mjs —— 跨脚本「查找引用 / 跳转定义」的验收脚本。
 *
 * 覆盖（全部在本机跑，不需要 Java、不需要开窗口、不需要网络）：
 *   1. 跨脚本引用：player.js 定义 function helper，game.js 调两次 → 3 条命中（1 定义 + 2 调用）
 *   2. 跳转定义：game.js 里的 bwe.world.find → __bwe_dts__ 的声明行；用户函数 → 定义它的那份脚本
 *   3. 生命周期同名不串味：两个脚本都写 onStart 时，引用里必须能看到「两条都是定义」
 *   4. 垃圾输入：空 files / 不存在的 active / 负数或越界 offset / 语法烂掉的源码 → 不抛异常
 *   5. 缓存：同一份 files 第二次调用明显快于第一次；改一行后仍能查到（增量更新没丢数据）
 *   6. 现有单文件 API 未退化：diagnostics / complete / quickInfo 各一条断言
 *   8. 端点层：直接调 api-core.handle()，验证 200/400 与返回字段名（前端按这些名字调用）
 *
 * 为什么要有这个脚本：跨脚本查询依赖「把多份脚本塞进同一个 TypeScript program」这个技巧，
 * 它对文件命名、版本号、lib 处理都很敏感；任何一个细节错了都表现为「查不到但不报错」，
 * 靠人点 UI 是抓不住的。这里用真实语言服务跑一遍，把它钉住。
 *
 * 用法：
 *   node web/tools/verify-script-references.mjs
 *   node web/tools/verify-script-references.mjs --verbose   # 打印每条断言的明细
 *
 * 退出码：0 = 全 PASS；1 = 有 FAIL；2 = 环境没就绪（找不到 typescript / bwe.d.ts）
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const PROJECT_ROOT = path.resolve(WEB_ROOT, "..");

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

// ---------------- 结果收集（与 verify-scripting.mjs 同一套表格风格）----------------

const rows = [];
let setupError = null;

function add(step, title, ok, detail = "") {
  rows.push({ step, title, status: ok ? "PASS" : "FAIL", detail: String(detail ?? "") });
  if (VERBOSE) log(`  ${ok ? "✔" : "✘"} ${title}${detail ? `（${detail}）` : ""}`);
  return ok;
}

function fatal(step, title, detail = "") {
  rows.push({ step, title, status: "FAIL", detail: String(detail ?? "") });
  setupError = setupError || `${title}${detail ? "：" + detail : ""}`;
  return false;
}

function log(msg = "") {
  process.stdout.write(msg + "\n");
}

function group(step) {
  const list = rows.filter((r) => r.step === step);
  return {
    step,
    total: list.length,
    pass: list.filter((r) => r.status === "PASS").length,
    fail: list.filter((r) => r.status === "FAIL").length,
    status: list.length === 0 ? "SKIP" : list.some((r) => r.status === "FAIL") ? "FAIL" : "PASS"
  };
}

// ---------------- 夹具 ----------------

/** 跨脚本夹具：helper 定义在 player.js，game.js 调两次。 */
const FILES = {
  "player.js": [
    "// 玩家脚本：定义 helper，供别的脚本调用",
    "function helper(a) {",
    "  return a + 1;",
    "}",
    "var hp = 10;",
    ""
  ].join("\n"),
  "game.js": [
    "function onStart(ctx) {",
    "  helper(1);",
    "  bwe.world.find(\"npc\");",
    "}",
    "function tick() {",
    "  helper(2);",
    "}",
    ""
  ].join("\n")
};

/** 在 `needle` 里第 occurrence 次出现处 + inner 的位置，用作「光标落在符号上」。 */
function offsetOf(source, needle, inner = 1, occurrence = 1) {
  let idx = -1;
  for (let n = 0; n < occurrence; n++) {
    idx = source.indexOf(needle, idx + 1);
    if (idx < 0) throw new Error(`源码里找不到「${needle}」第 ${occurrence} 次`);
  }
  return idx + inner;
}

// ---------------- 主流程 ----------------

async function main() {
  log("跨脚本「查找引用 / 跳转定义」验收");
  log(`  仓库: ${PROJECT_ROOT}`);

  let lang;
  try {
    const mod = await import("./script-language.mjs");
    lang = await mod.createScriptLanguageFromDisk({ webRoot: WEB_ROOT });
  } catch (e) {
    fatal("env", "语言服务能装配起来（typescript + bwe.d.ts）", e?.message || String(e));
    return finish();
  }
  add("env", "语言服务能装配起来（typescript + bwe.d.ts）", true);
  add("env", "bwe.d.ts 已加载（hasTypes）", lang.hasTypes === true, `hasTypes=${lang.hasTypes}`);
  if (!lang.hasTypes) fatal("env", "bwe.d.ts 缺失", "没有声明文件就查不到 bwe.* 的定义，后面的断言会误报");

  // ---- 1) 跨脚本引用 ----
  {
    const step = "refs";
    const off = offsetOf(FILES["game.js"], "helper(1)", 2);
    const r = lang.references(FILES, "game.js", off);
    add(step, "references 返回 ok", r.ok === true, r.error ?? "");
    add(step, "跨脚本命中 3 条（1 定义 + 2 调用）", r.refs?.length === 3, `实际 ${r.refs?.length}：${summarize(r.refs)}`);
    const defs = (r.refs ?? []).filter((x) => x.isDefinition);
    add(step, "其中恰好 1 条 isDefinition=true", defs.length === 1, `实际 ${defs.length}`);
    add(
      step,
      "定义那条落在 player.js:2",
      defs[0]?.name === "player.js" && defs[0]?.line === 2,
      defs[0] ? `${defs[0].name}:${defs[0].line}:${defs[0].col}` : "(没有定义行)"
    );
    add(
      step,
      "调用那两条落在 game.js:2 / game.js:6",
      (r.refs ?? [])
        .filter((x) => !x.isDefinition)
        .map((x) => `${x.name}:${x.line}`)
        .join(",") === "game.js:2,game.js:6",
      summarize(r.refs)
    );
    add(step, "每条都有 name/line/col/text 四个字段", (r.refs ?? []).every((x) => typeof x.name === "string" && typeof x.line === "number" && typeof x.col === "number" && typeof x.text === "string" && typeof x.isDefinition === "boolean"));
    add(step, "line/col 从 1 开始（没有 0）", (r.refs ?? []).every((x) => x.line >= 1 && x.col >= 1), summarize(r.refs));
    add(step, "text 是某一行 trim 后的内容（无换行）", (r.refs ?? []).every((x) => !/[\r\n]/.test(x.text) && x.text === x.text.trim()));
    add(
      step,
      "排序按脚本名再按行号",
      isSorted(r.refs ?? []),
      (r.refs ?? []).map((x) => `${x.name}:${x.line}`).join(" → ")
    );
  }

  // ---- 2) 跳转定义 ----
  {
    const step = "def";
    const findOff = offsetOf(FILES["game.js"], "find(\"npc\")", 1);
    const d = lang.definition(FILES, "game.js", findOff);
    add(step, "definition 返回 ok", d.ok === true, d.error ?? "");
    add(step, "bwe.world.find 命中 __bwe_dts__", (d.defs ?? []).some((x) => x.name === "__bwe_dts__"), summarizeDefs(d.defs));
    const decl = (d.defs ?? []).find((x) => x.name === "__bwe_dts__");
    add(step, "声明行 text 里带 find(", Boolean(decl?.text?.includes("find(")), decl?.text ?? "");
    add(step, "声明行号在 bwe.d.ts 里是有效行（≥1）", (decl?.line ?? 0) >= 1, `line=${decl?.line}`);

    // 用户自己定义的函数：要跳到 player.js，不能跳成 __bwe_dts__
    const helperOff = offsetOf(FILES["game.js"], "helper(1)", 2);
    const dh = lang.definition(FILES, "game.js", helperOff);
    add(step, "用户函数 helper → player.js:2", (dh.defs ?? []).some((x) => x.name === "player.js" && x.line === 2), summarizeDefs(dh.defs));
    add(step, "用户函数的定义不会被标成 __bwe_dts__", !(dh.defs ?? []).some((x) => x.name === "__bwe_dts__"), summarizeDefs(dh.defs));
    add(step, "defs 里没有 isDefinition/ok 之外的额外字段依赖", (dh.defs ?? []).every((x) => typeof x.name === "string" && typeof x.line === "number" && typeof x.col === "number" && typeof x.text === "string"));
  }

  // ---- 3) 生命周期同名不串味 ----
  {
    const step = "lifecycle";
    const two = {
      "a.js": "function onStart(ctx) {\n  bwe.log(\"a\");\n}\n",
      "b.js": "function onStart(ctx) {\n  bwe.log(\"b\");\n}\n"
    };
    const r = lang.references(two, "a.js", offsetOf(two["a.js"], "onStart", 1));
    add(step, "两个脚本都写 onStart 时能查到两条定义", (r.refs ?? []).filter((x) => x.isDefinition).length >= 2, summarize(r.refs));
    add(step, "两条定义分属 a.js 与 b.js", new Set((r.refs ?? []).filter((x) => x.isDefinition).map((x) => x.name)).size === 2, summarize(r.refs));
  }

  // ---- 4) 垃圾输入不炸 ----
  {
    const step = "garbage";
    const cases = [
      ["空 files", () => lang.references({}, "game.js", 0)],
      ["files 是 null", () => lang.references(null, "game.js", 0)],
      ["files 是数组", () => lang.references([], "game.js", 0)],
      ["active 不存在", () => lang.references(FILES, "nope.js", 0)],
      ["offset 是负数", () => lang.references(FILES, "game.js", -5)],
      ["offset 是 NaN", () => lang.references(FILES, "game.js", Number.NaN)],
      ["offset 越界（远超文件长度）", () => lang.references(FILES, "game.js", 999999)],
      ["语法烂掉的源码", () => lang.references({ "bad.js": "function ( { [[[ \u0000 .. , )))\n", "ok.js": "var a = 1;\n" }, "bad.js", 3)],
      ["空源码", () => lang.references({ "empty.js": "" }, "empty.js", 0)],
      ["definition 空 files", () => lang.definition({}, "game.js", 0)],
      ["definition active 不存在", () => lang.definition(FILES, "nope.js", 0)],
      ["definition 越界 offset", () => lang.definition(FILES, "game.js", 999999)],
      ["definition 语法烂掉", () => lang.definition({ "bad.js": "function ( { [[[ \u0000\n" }, "bad.js", 2)]
    ];
    for (const [title, fn] of cases) {
      let result;
      let threw = null;
      try {
        result = fn();
      } catch (e) {
        threw = e?.message || String(e);
      }
      const shaped =
        threw === null &&
        result &&
        typeof result.ok === "boolean" &&
        (result.ok ? true : Array.isArray(result.refs) || Array.isArray(result.defs));
      add(step, `${title} 不抛异常且返回契约形状`, shaped, threw ? `抛出：${threw}` : JSON.stringify(result).slice(0, 90));
    }
    // 越界必须是「空结果」而不是错误：编辑器在文件刚被替换时就是这种状态
    const over = lang.references(FILES, "game.js", 999999);
    add(step, "越界 offset 是空结果（ok:true + refs:[]），不报错", over.ok === true && over.refs.length === 0, JSON.stringify(over));
    // 非法参数必须是 error 字符串，前端才能把原因显示出来
    const bad = lang.references(FILES, "nope.js", 0);
    add(step, "非法 active 带可读 error", bad.ok === false && typeof bad.error === "string" && bad.error.length > 0, bad.error ?? "");
  }

  // ---- 5) 缓存 / 增量 ----
  {
    const step = "perf";
    // 用一份稍大的集合测：10 个脚本才足够看出「建 program」与「查一次」的量级差
    const big = {};
    for (let i = 0; i < 10; i++) {
      big[`s${i}.js`] = `function helper${i}(a) {\n  return a + ${i};\n}\nfunction tick${i}() {\n  helper${i}(1);\n  helper${i}(2);\n}\n`;
    }
    const off = offsetOf(big["s0.js"], "helper0(1)", 2);

    const t1 = process.hrtime.bigint();
    const r1 = lang.references(big, "s0.js", off);
    const ms1 = Number(process.hrtime.bigint() - t1) / 1e6;

    const t2 = process.hrtime.bigint();
    const r2 = lang.references(big, "s0.js", off);
    const ms2 = Number(process.hrtime.bigint() - t2) / 1e6;

    log(`  首次 ${ms1.toFixed(1)}ms / 缓存命中 ${ms2.toFixed(2)}ms`);
    add(step, "第一次查询能查到 3 条", r1.refs?.length === 3, `实际 ${r1.refs?.length}`);
    add(step, "第二次查询结果与第一次一致", JSON.stringify(r1.refs) === JSON.stringify(r2.refs));
    add(step, "第二次明显快于第一次（缓存生效）", ms2 < ms1, `${ms1.toFixed(1)}ms → ${ms2.toFixed(2)}ms`);
    add(step, "缓存命中在 10ms 以内", ms2 < 10, `${ms2.toFixed(2)}ms`);
    add(step, "缓存命中不慢于首次的 1/3", ms2 < ms1 / 3, `${ms1.toFixed(1)}ms → ${ms2.toFixed(2)}ms`);

    // 增量：改一个文件后，跨脚本引用仍然正确（说明版本号确实推进了，没吃到旧 program）
    const edited = { ...big, "s1.js": big["s1.js"] + "// 新加一行注释\n" };
    const r3 = lang.references(edited, "s0.js", off);
    add(step, "改一个文件后仍返回 3 条（增量更新没丢内容）", r3.refs?.length === 3, `实际 ${r3.refs?.length}`);

    // 换成完全不同的文件集合：不能把上一份的脚本残留进来
    const switched = lang.references({ "x.js": "function q() {}\n", "y.js": "function r() {\n  q();\n}\n" }, "y.js", offsetOf("function r() {\n  q();\n}\n", "q()", 1));
    add(step, "整体换文件集合后只剩新集合的命中（旧脚本不残留）", switched.ok === true && switched.refs.every((x) => x.name === "y.js" || x.name === "x.js"), summarize(switched.refs));
  }

  // ---- 6) 脚本名安全化 ----
  {
    const step = "names";
    // 脚本名是用户起的：中文、空格、斜杠、点、与声明文件同名，都得能查且不串。
    const weird = {
      "玩家 控制.js": "function jumpHigh(a) {\n  return a;\n}\n",
      "a/b.js": "function helperSlash() {\n  return 1;\n}\n",
      "../逃逸.js": "function helperEscape() {\n  return 2;\n}\n",
      "bwe.d": "function helperClash() {\n  return 3;\n}\n"
    };
    const r1 = lang.references(weird, "玩家 控制.js", offsetOf(weird["玩家 控制.js"], "jumpHigh", 2));
    add(step, "中文+空格的脚本名能查到自己的定义", r1.ok === true && r1.refs.some((x) => x.isDefinition && x.name === "玩家 控制.js"), summarize(r1.refs));
    add(step, "跨脚本名字原样回填（不是虚拟文件名）", r1.refs.every((x) => Object.prototype.hasOwnProperty.call(weird, x.name)), summarize(r1.refs));

    const r2 = lang.references(weird, "bwe.d", offsetOf(weird["bwe.d"], "helperClash", 2));
    add(step, "脚本名与 bwe.d.ts 撞名时仍能查到自己的定义", r2.ok === true && r2.refs.some((x) => x.name === "bwe.d"), summarize(r2.refs));

    // 撞名脚本不能把 bwe.d.ts 顶掉：bwe.world.find 的定义仍然要能解析
    const useSrc = "function onStart(ctx) {\n  bwe.world.find(\"npc\");\n}\n";
    const r3 = lang.definition({ ...weird, "use.js": useSrc }, "use.js", offsetOf(useSrc, "find(", 1));
    add(step, "撞名脚本存在时 bwe.* 声明仍然可用（没被顶掉）", r3.ok === true && r3.defs.some((x) => x.name === "__bwe_dts__"), summarizeDefs(r3.defs));

    // 斜杠/点点不能逃出虚拟根、也不能互相覆盖
    const r4 = lang.references(weird, "a/b.js", offsetOf(weird["a/b.js"], "helperSlash", 2));
    add(step, "带斜杠的脚本名能查到自己的定义", r4.ok === true && r4.refs.some((x) => x.name === "a/b.js" && x.isDefinition), summarize(r4.refs));
    const r5 = lang.references(weird, "../逃逸.js", offsetOf(weird["../逃逸.js"], "helperEscape", 2));
    add(step, "带 ../ 的脚本名能查到自己的定义", r5.ok === true && r5.refs.some((x) => x.name === "../逃逸.js" && x.isDefinition), summarize(r5.refs));
    add(step, "斜杠与点点脚本没有互相覆盖（各自命中各自的符号）", r4.refs.every((x) => x.text.includes("helperSlash")) && r5.refs.every((x) => x.text.includes("helperEscape")), `${summarize(r4.refs)} / ${summarize(r5.refs)}`);
  }

  // ---- 7) 单文件 API 未退化 ----
  {
    const step = "single";
    const diag = lang.diagnostics("var x = ;\n");
    add(step, "diagnostics 仍能报语法错", diag.diagnostics.some((d) => d.severity === "error"), JSON.stringify(diag.diagnostics.slice(0, 2)));
    add(step, "diagnostics 行号仍是 1 开始", diag.diagnostics[0]?.line === 1, JSON.stringify(diag.diagnostics[0] ?? null));

    const comp = lang.complete("var a = [];\na.", "var a = [];\na.".length);
    add(step, "complete 仍能给出数组成员补全", comp.entries.some((e) => e.name === "push"), `${comp.entries.length} 条`);

    const q = lang.quickInfo("var m = Math.max(1, 2);", "var m = Math.max(1, 2);".indexOf("max") + 1);
    add(step, "quickInfo 仍能给出 Math.max 的类型", Boolean(q?.display?.includes("Math")), q?.display ?? "(null)");
  }

  // ---- 8) 端点层（api-core）----
  {
    const step = "api";
    const { createApiCore } = await import("./api-core.mjs");
    const core = createApiCore({ webRoot: WEB_ROOT, projectRoot: PROJECT_ROOT, onLog: () => {} });

    const off = offsetOf(FILES["game.js"], "helper(1)", 2);
    const body = JSON.stringify({ files: FILES, active: "game.js", offset: off });

    const refs = await core.handle({ path: "/api/script-references", method: "POST", body });
    add(step, "POST /api/script-references 返回 200", refs.status === 200, `status=${refs.status}`);
    add(step, "端点是直接返回 references() 结果（ok + refs）", refs.json?.ok === true && Array.isArray(refs.json?.refs), JSON.stringify(refs.json).slice(0, 120));
    add(step, "端点返回 3 条命中", refs.json?.refs?.length === 3, `实际 ${refs.json?.refs?.length}`);

    const defOff = offsetOf(FILES["game.js"], "find(\"npc\")", 1);
    const defBody = JSON.stringify({ files: FILES, active: "game.js", offset: defOff });
    const def = await core.handle({ path: "/api/script-definition", method: "POST", body: defBody });
    add(step, "POST /api/script-definition 返回 200", def.status === 200, `status=${def.status}`);
    add(step, "endpoint 定义字段形状正确（ok + defs）", def.json?.ok === true && Array.isArray(def.json?.defs), JSON.stringify(def.json).slice(0, 120));
    add(step, "bwe.world.find 端点返回 __bwe_dts__", def.json?.defs?.some((x) => x.name === "__bwe_dts__"), summarizeDefs(def.json?.defs));

    // 参数校验 → 400（不能 500，也不能悄悄返回 200 + 空数组把配置错误藏起来）
    const badCases = [
      ["files 为空对象", { files: {}, active: "game.js", offset: 0 }],
      ["files 缺失", { active: "game.js", offset: 0 }],
      ["active 不在 files 里", { files: FILES, active: "nope.js", offset: 0 }],
      ["offset 为负", { files: FILES, active: "game.js", offset: -1 }],
      ["offset 不是数字", { files: FILES, active: "game.js", offset: "abc" }],
      ["源码不是字符串", { files: { "a.js": 42 }, active: "a.js", offset: 0 }]
    ];
    for (const [title, payload] of badCases) {
      for (const p of ["/api/script-references", "/api/script-definition"]) {
        const rr = await core.handle({ path: p, method: "POST", body: JSON.stringify(payload) });
        const key = p.endsWith("references") ? "refs" : "defs";
        add(
          step,
          `${p.replace("/api/script-", "")}：${title} → 400 + ok:false`,
          rr.status === 400 && rr.json?.ok === false && Array.isArray(rr.json?.[key]) && typeof rr.json?.error === "string",
          `status=${rr.status} ${JSON.stringify(rr.json).slice(0, 100)}`
        );
      }
    }

    // GET 不该被当成 POST 端点（路由按 method 匹配）
    const getRefs = await core.handle({ path: "/api/script-references", method: "GET" });
    add(step, "GET /api/script-references 不被当成 POST 端点", getRefs.status === 404, `status=${getRefs.status}`);

    // 桌面版走的是 direct 调用（core.scriptReferences），形状必须与 HTTP 一致
    add(step, "core.scriptReferences 直接调用与 HTTP 结果一致", JSON.stringify(await core.scriptReferences(JSON.parse(body))) === JSON.stringify(refs.json), "");
  }

  return finish();
}

// ---------------- 小工具 ----------------

function summarize(refs) {
  return (refs ?? []).map((x) => `${x.name}:${x.line}:${x.col}${x.isDefinition ? "[DEF]" : ""}`).join(" ") || "(空)";
}

function summarizeDefs(defs) {
  return (defs ?? []).map((x) => `${x.name}:${x.line}:${x.col}`).join(" ") || "(空)";
}

function isSorted(refs) {
  const cmp = (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN") || a.line - b.line || a.col - b.col;
  for (let i = 1; i < refs.length; i++) if (cmp(refs[i - 1], refs[i]) > 0) return false;
  return true;
}

function printTable() {
  log("");
  const steps = [...new Set(rows.map((r) => r.step))];
  for (const step of steps) {
    const g = group(step);
    log(`[${g.status}] ${step}  ${g.pass}/${g.total}`);
    for (const r of rows.filter((x) => x.step === step)) {
      log(`   ${r.status === "PASS" ? "✔" : "✘"} ${r.title}${r.status === "PASS" ? "" : `  ← ${r.detail}`}`);
    }
  }
}

function finish() {
  printTable();
  const fail = rows.filter((r) => r.status === "FAIL").length;
  log("");
  if (setupError) {
    log(`前置依赖没就绪：${setupError}`);
    log("退出码: 2");
    process.exit(2);
  }
  log(`合计: ${rows.filter((r) => r.status === "PASS").length}/${rows.length} PASS，${fail} FAIL`);
  log(`退出码: ${fail > 0 ? 1 : 0}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(2);
});
