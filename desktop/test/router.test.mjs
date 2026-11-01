/**
 * 单测：本地零 token 路由（router.mjs）。
 *
 * 要证明的事：
 *   1. 短问题 / 轻量问题走 flash（省钱）；
 *   2. 复杂问题（重构、排查、多文件）走 pro（少来回）；
 *   3. 路由**纯本地**：不发任何网络请求，也不 import 网络模块；
 *   4. 返回的 reason 能让人看懂为什么这么选（界面上要显示）。
 *
 * 用法：node desktop/test/router.test.mjs
 */

import assert from "node:assert/strict";
import { routeModel, KEYWORDS, ROUTER_VERSION } from "../lib/ai/router.mjs";

let pass = 0;
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const req = (text, extra = {}) => ({
  requestId: "r1",
  messages: [{ role: "user", text }],
  intent: extra.intent ?? "chat",
  ...(extra.context ? { context: extra.context } : {})
});

const route = (text, extra = {}, opts = {}) => routeModel(req(text, extra), opts);

test("打招呼走 flash", () => {
  const r = route("你好");
  assert.equal(r.model, "flash");
  assert.equal(r.localOnly, true);
  assert.ok(r.reason.length > 0, "reason 必须非空（界面上要显示为什么这么选）");
});

test("短问题走 flash", () => {
  const r = route("这个字段叫什么？");
  assert.equal(r.model, "flash");
});

test("复杂任务关键词（中文）走 pro", () => {
  for (const text of ["帮我重构这段脚本", "为什么我的角色会掉帧", "排查一下崩溃的原因", "分析这个工程的性能"]) {
    const r = route(text);
    assert.equal(r.model, "pro", `${text} 应走 pro，实际 ${r.model}（${r.reason}）`);
    assert.ok(r.reason.includes("命中复杂任务关键词"), r.reason);
  }
});

test("复杂任务关键词（英文）走 pro", () => {
  for (const text of ["refactor this script", "why does the game crash", "profile the performance"]) {
    const r = route(text);
    assert.equal(r.model, "pro", `${text} 应走 pro`);
  }
});

test("长输入兜底走 pro", () => {
  const text = "把这个场景里的对象挨个看一遍再告诉我应该怎么整理".repeat(20); // >480 字，无 pro 关键词
  const r = route(text);
  assert.equal(r.model, "pro");
  assert.ok(r.reason.includes("超过"), r.reason);
});

test("很短且不含关键词走 flash", () => {
  const r = route("嗯");
  assert.equal(r.model, "flash");
  assert.ok(r.reason.includes("短问题"), r.reason);
});

test("intent 优先于关键词", () => {
  assert.equal(route("你好", { intent: "explain-error" }).model, "pro");
  assert.equal(route("你好", { intent: "edit-script" }).model, "pro");
  assert.equal(route("你好", { intent: "scene-review" }).model, "pro");
  assert.equal(route("你好", { intent: "chat" }).model, "flash");
});

test("上下文有脚本错误 → pro", () => {
  const r = route("看看这个", { context: { diagnostics: { errors: 2, firstError: "world.js:42 TypeError" } } });
  assert.equal(r.model, "pro");
  assert.ok(r.reason.includes("脚本错误"), r.reason);
});

test("当前脚本很长 → pro（要通读）", () => {
  const r = route("这样写对吗", { context: { activeScript: { name: "world.js", lang: "js", code: "x".repeat(2000) } } });
  assert.equal(r.model, "pro");
  assert.ok(r.reason.includes("字符"), r.reason);
});

test("手动锁定优先于一切", () => {
  assert.equal(route("帮我重构整个工程", {}, { manualModel: "flash" }).model, "flash");
  assert.equal(route("你好", {}, { manualModel: "pro" }).model, "pro");
  assert.ok(routeModel(req("你好"), { manualModel: "pro", autoRoute: false }).reason.includes("手动锁定"));
});

test("纯本地：往返一万次也不慢、无网络", () => {
  const t0 = Date.now();
  for (let i = 0; i < 10000; i++) route("帮我分析一下这个场景的性能问题");
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `一万次路由耗时 ${ms}ms，超过 3s 说明不是纯本地计算`);
});

test("reason 永远非空、localOnly 永远 true", () => {
  for (const text of ["", "a", "重构", "你好", "x".repeat(600)]) {
    const r = route(text);
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason.length > 0);
    assert.equal(r.localOnly, true);
    assert.ok(["flash", "pro"].includes(r.model));
  }
});

test("关键词表完整（中英双语都有关键词）", () => {
  const hasCjk = (arr) => arr.some((k) => /[\u4e00-\u9fff]/.test(k));
  assert.ok(hasCjk(KEYWORDS.pro), "pro 关键词应有中文");
  assert.ok(KEYWORDS.pro.some((k) => /^[a-z ]+$/.test(k)), "pro 关键词应有英文");
  assert.ok(hasCjk(KEYWORDS.flash), "flash 关键词应有中文");
  assert.equal(typeof ROUTER_VERSION, "string");
});

for (const c of cases) {
  try {
    c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    console.error(`  ✗ ${c.name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nrouter.test: ${pass}/${cases.length} 通过 · ${ROUTER_VERSION}`);
if (pass !== cases.length) process.exit(1);
