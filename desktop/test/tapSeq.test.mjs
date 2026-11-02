/**
 * 单测：`--tap-seq` 的解析器（parseTapSeq）。
 *
 * 为什么单独测解析：语法错了的表现是**静默少执行一步**（例如某段被当未知类型丢弃），
 * 而 B 拿到的是「三组宽度只有两组」这种不完整证据 —— 比直接报错更难发现。
 * 执行部分要真窗口，放在 verify 脚本里；解析部分是纯函数，这里全量覆盖。
 *
 * 用法：node desktop/test/tapSeq.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTapSeq } from "../lib/tapSeq.mjs";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const types = (r) => r.steps.map((s) => s.type);

// ---------------------------------------------------------------------------
// 基础语法
// ---------------------------------------------------------------------------

test("三种段都能解析（click / probe / wait）", () => {
  const r = parseTapSeq("click:[data-x]; probe:.sidebar,.panel; wait:200");
  assert.deepEqual(types(r), ["click", "probe", "wait"]);
  assert.equal(r.steps[0].selector, "[data-x]");
  assert.deepEqual(r.steps[1].selectors, [".sidebar", ".panel"]);
  assert.equal(r.steps[2].waitMs, 200);
  assert.equal(r.errors.length, 0, `不该有错误：${r.errors.join("; ")}`);
});

test("空串 / 只有空白 → 零步骤零错误", () => {
  assert.deepEqual(parseTapSeq("").steps, []);
  assert.deepEqual(parseTapSeq("   ").steps, []);
  assert.deepEqual(parseTapSeq(null).steps, []);
  assert.deepEqual(parseTapSeq(undefined).steps, []);
});

test("多余分号 / 段首尾空白被忽略（手打容易多打一个）", () => {
  const r = parseTapSeq(" ; click:.a ;; probe:.b ; ");
  assert.deepEqual(types(r), ["click", "probe"]);
  assert.equal(r.errors.length, 0);
});

test("类型大小写不敏感", () => {
  const r = parseTapSeq("CLICK:.a; Probe:.b; WAIT:100");
  assert.deepEqual(types(r), ["click", "probe", "wait"]);
});

// ---------------------------------------------------------------------------
// click 的选项
// ---------------------------------------------------------------------------

test("click 默认等待 250ms（折叠动画需要时间落定）", () => {
  const r = parseTapSeq("click:.a");
  assert.equal(r.steps[0].waitMs, 250);
});

test("click 可用 |waitMs 覆盖默认等待", () => {
  const r = parseTapSeq("click:.a|800; probe:.a");
  assert.equal(r.steps[0].selector, ".a", "选择器不该把 |800 吃进去");
  assert.equal(r.steps[0].waitMs, 800);
});

test("click 的等待上限被夹住（防止手滑写 99999 卡死）", () => {
  const r = parseTapSeq("click:.a|999999");
  assert.equal(r.steps[0].waitMs, 5000, "应被夹到 5000ms");
});

test("click 选择器里含冒号也不误解（如 :nth-child）", () => {
  const r = parseTapSeq("click:.tab:nth-child(2); probe:.tab:nth-child(2)");
  assert.equal(r.steps[0].selector, ".tab:nth-child(2)", "第一个冒号后应整体作为选择器");
  assert.deepEqual(r.steps[1].selectors, [".tab:nth-child(2)"]);
});

// ---------------------------------------------------------------------------
// 错误处理（宁可报出来，也不要静默少执行）
// ---------------------------------------------------------------------------

test("缺少冒号的段报错（而不是静默忽略）", () => {
  const r = parseTapSeq("click:.a; garbage; probe:.b");
  assert.deepEqual(types(r), ["click", "probe"], "合法段仍应解析");
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes("garbage"), r.errors[0]);
});

test("未知类型报错并列出合法类型", () => {
  const r = parseTapSeq("click:.a; tap:.b");
  assert.deepEqual(types(r), ["click"]);
  assert.ok(r.errors[0].includes("unknown") || r.errors[0].includes("未知"), r.errors[0]);
  assert.ok(r.errors[0].includes("click") && r.errors[0].includes("probe") && r.errors[0].includes("wait"), "错误里应列出合法类型");
});

test("click 缺选择器报错", () => {
  const r = parseTapSeq("click:; probe:.a");
  assert.deepEqual(types(r), ["probe"]);
  assert.ok(r.errors[0].includes("缺少选择器"), r.errors[0]);
});

test("probe 缺选择器报错", () => {
  const r = parseTapSeq("probe:; click:.a");
  assert.deepEqual(types(r), ["click"]);
  assert.ok(r.errors[0].includes("缺少选择器"), r.errors[0]);
});

test("wait 参数非数字报错", () => {
  const r = parseTapSeq("wait:abc");
  assert.deepEqual(types(r), []);
  assert.ok(r.errors[0].includes("毫秒"), r.errors[0]);
});

test("wait 为负数报错", () => {
  const r = parseTapSeq("wait:-5");
  assert.deepEqual(types(r), []);
  assert.ok(r.errors.length > 0);
});

// ---------------------------------------------------------------------------
// 真实场景（B 的折叠 bug 验收用例）
// ---------------------------------------------------------------------------

test("折叠 bug 的真实序列被正确解析（B 会用的那条命令）", () => {
  const raw =
    "click:[data-sidebar-collapse]; probe:.sidebar,.panel; wait:200; click:[data-sidebar-toggle]; probe:.sidebar,.panel";
  const r = parseTapSeq(raw);
  assert.equal(r.steps.length, 5, `应有 5 步，实际 ${r.steps.length}`);
  assert.deepEqual(types(r), ["click", "probe", "wait", "click", "probe"]);
  assert.equal(r.errors.length, 0);
  // 两个 probe 段必须都探 .sidebar 与 .panel —— 这是能对比"折叠前/后"的前提
  for (const idx of [1, 4]) {
    assert.deepEqual(r.steps[idx].selectors, [".sidebar", ".panel"], `第 ${idx} 步 probe 的选择器不对`);
  }
});

test("脚本编辑器高度取证序列（P1）被正确解析", () => {
  const raw = 'click:[data-tab="script"]; wait:300; probe:.editor-area,.js-code,.panel';
  const r = parseTapSeq(raw);
  assert.deepEqual(types(r), ["click", "wait", "probe"]);
  assert.equal(r.steps[0].selector, '[data-tab="script"]', "带引号的选择器应完整保留");
  assert.deepEqual(r.steps[2].selectors, [".editor-area", ".js-code", ".panel"]);
  assert.equal(r.errors.length, 0);
});

// ---------------------------------------------------------------------------
// probe 步骤的注入脚本（曾经整段坏掉，而 16 项单测全绿 —— 又一个「测试绿但功能坏」）
// ---------------------------------------------------------------------------

test("probe 注入模板里不能有裸反引号注释（会提前闭合外层模板）", () => {
  // 真实故障：probe 的注入代码是一个模板字符串，而我在里面写了带反引号的注释
  //（形如：后缀 `*` 表示…）。第一个反引号把模板提前闭合，后面的内容被当成乘法，
  // 最终 probeCode 求值成 NaN（len=3）→ executeJavaScript 收到数字 →
  // "data argument must be of type string" → **所有 probe 步骤全失败**。
  //
  // ⚠ 检查范围**只限模板内部**（从 `const probeCode = ` 到闭合的 `})()`(反引号)）。
  //   模板外面的代码用反引号完全正常（那才是模板字符串的合法语法）。
  const src = readFileSync(new URL("../lib/tapSeq.mjs", import.meta.url), "utf8");
  const tplStart = src.indexOf("const probeCode = \u0060");
  assert.ok(tplStart >= 0, "找不到 probeCode 模板");
  const tplEnd = src.indexOf("\u0060;", tplStart);
  assert.ok(tplEnd > tplStart, "找不到模板闭合位置");
  const inner = src.slice(tplStart + "const probeCode = \u0060".length, tplEnd);

  const offenders = inner
    .split("\n")
    .filter((l) => l.trim().startsWith("//") && l.includes("\u0060"));
  assert.equal(
    offenders.length,
    0,
    `probe 注入模板（内部）的注释里不能出现反引号（会提前闭合模板）：\n${offenders.join("\n")}`
  );
});

test("probe 注入脚本必须 return 数组，且显式校验返回值类型", () => {
  const src = readFileSync(new URL("../lib/tapSeq.mjs", import.meta.url), "utf8");
  const tplStart = src.indexOf("const probeCode = \u0060");
  const tplEnd = src.indexOf("\u0060;", tplStart);
  const inner = src.slice(tplStart, tplEnd);

  // 注入脚本必须以 return 结束（否则 executeJavaScript 得到 undefined）
  assert.ok(
    /return\s+\$\{JSON\.stringify\(step\.selectors\)\}\.map\(/.test(inner)
      || inner.includes("return results"),
    "注入脚本必须 return 结果数组（否则 executeJavaScript 返回 undefined）"
  );

  // 宿主侧必须有数组校验
  const hostStart = src.indexOf("const results = await window.webContents.executeJavaScript");
  const hostBlock = src.slice(hostStart, src.indexOf("\n        for (", hostStart));
  assert.ok(hostBlock.includes("Array.isArray(results)"), "必须显式检查返回值是数组");
  assert.ok(
    hostBlock.includes("探测返回值不是数组"),
    "非数组时要抛可读错误（含实际类型），而不是让 for-of 报 is not iterable"
  );
});

test("probe 模板内的正则转义正确（\\s 在模板里需写两个反斜杠）", () => {
  // 模板字符串会吃掉一层转义：源码里写 \\s+，渲染侧才是 \s+。
  // 写成一个反斜杠的话，渲染侧得到的是"真实空白"，正则语义完全变掉。
  const src = readFileSync(new URL("../lib/tapSeq.mjs", import.meta.url), "utf8");
  const start = src.indexOf('if (step.type === "probe") {');
  const block = src.slice(start, src.indexOf("\n      continue;", start));

  const tidyLines = block.split("\n").filter((l) => l.includes("replace("));
  assert.ok(tidyLines.length >= 1, "注入脚本里应有 tidy 的正则替换");
  for (const l of tidyLines) {
    const idx = l.indexOf("replace(");
    const seg = l.slice(idx, idx + 20);
    const backslashes = seg.split("\u005c").length - 1;
    assert.ok(
      backslashes >= 2,
      `模板内正则需要至少 2 个反斜杠（渲染侧才是 \\s+），实际 ${backslashes} 个：${l.trim()}`
    );
  }
});

for (const c of cases) {
  try {
    c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    console.error(`  ✗ ${c.name}\n    ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

console.log(`\ntapSeq.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
