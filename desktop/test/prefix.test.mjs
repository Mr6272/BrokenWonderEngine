/**
 * 单测：稳定前缀（prefix.mjs）。
 *
 * 契约 §4.3 第 2 条是**硬性约束**：同一 PROMPT_VERSION 下，system prompt 两次调用必须
 * 字节完全一致。这条不满足，DeepSeek 的前缀缓存直接失效 —— 每轮都在为同样的
 * 4~5K token 付全价。所以单独拉一个测试断言 `===`（不是「看起来一样」，是字符串相等）。
 *
 * 另测三件事：
 *   - 块顺序与数量固定（缓存前缀是「从头开始匹配」的，块顺序变了等于换了开头）；
 *   - 禁止出现易变内容（时间戳、年份、会话 id、绝对路径这类一定会变的东西）；
 *   - 序列化后字节一致（JSON.stringify 的键顺序也要稳定，否则发出去的字节不同）。
 *
 * 用法：node desktop/test/prefix.test.mjs
 */

import assert from "node:assert/strict";
import { buildSystemPrompt, PROMPT_VERSION, systemBlock } from "../lib/ai/prefix.mjs";

let pass = 0;
const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}

test("两次调用字节完全一致", () => {
  const a = buildSystemPrompt();
  const b = buildSystemPrompt();
  assert.equal(a, b, "同一版本下两次 buildSystemPrompt() 必须 ===（否则前缀缓存失效）");
});

test("序列化后字节一致", () => {
  const a = JSON.stringify({ role: "system", content: buildSystemPrompt() });
  const b = JSON.stringify({ role: "system", content: buildSystemPrompt() });
  assert.equal(a, b, "JSON 序列化后也必须一致（包括键顺序）");
});

test("包含四个常量块且顺序固定", () => {
  const prompt = buildSystemPrompt();
  // 身份块必须在最前：前缀匹配是从第一个字节开始的。
  assert.ok(prompt.startsWith("你是 BWE Studio 内置的工程助手"), "身份块必须是开头");
  const identity = prompt.indexOf("你是 BWE Studio 内置的工程助手");
  const repo = prompt.indexOf("仓库结构（BrokenWonderEngine）");
  const api = prompt.indexOf("BWE 脚本 API 摘要");
  const rules = prompt.indexOf("工作规则：");
  assert.ok(identity < repo && repo < api && api < rules, "块顺序：身份 → 仓库 → API → 规则");
  assert.equal(systemBlock().version, PROMPT_VERSION);
});

test("不含易变内容", () => {
  const prompt = buildSystemPrompt();
  // 时间戳 / 年份 / 会话 id / 绝对路径 / token 计数：任何一项出现都意味着缓存必失效。
  const forbidden = [
    /\b20\d\d[-/年]\d/, // 日期
    /\b20\d\d\b/, // 年份
    /session_|sessionId|会话 id:/i,
    /[A-Za-z]:\\/, // Windows 绝对路径
    /\b\d+\s*token\b/i, // 具体 token 数
    /requestId/i,
    /\b\d{10,}\b/ // 时间戳/长数字（hash、epoch）
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(prompt), `system prompt 不应包含易变内容：${re}`);
  }
});

test("长度在合理区间（省 token 的前提）", () => {
  const prompt = buildSystemPrompt();
  // 常量块太短等于没给信息；太长每轮都在为它付费。
  assert.ok(prompt.length > 1200, `system prompt 太短（${prompt.length}），身份/结构/规则没讲清`);
  assert.ok(prompt.length < 6000, `system prompt 太长（${prompt.length} 字符），每轮都要为它付钱`);
});

test("不含 271 条 API 明细（工具按需查）", () => {
  const prompt = buildSystemPrompt();
  // 契约 §4.3 第 3 条：API 文档不进 system prompt，改成 SearchApi 按需取。
  assert.ok(!prompt.includes("bwe.world.find"), "不应把具体 API 条目写进前缀（会撑爆前缀成本）");
  assert.ok(prompt.includes("SearchApi"), "应告诉模型用 SearchApi 查 API");
});

test("PROMPT_VERSION 是常量字符串", () => {
  assert.equal(typeof PROMPT_VERSION, "string");
  assert.ok(PROMPT_VERSION.length > 0);
  // 版本号本身不能带日期（否则升级一次就变一次，历史会话的 system 块永远对不上）。
  assert.ok(!/\d{4}/.test(PROMPT_VERSION), "PROMPT_VERSION 不应包含年份");
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

console.log(`\nprefix.test: ${pass}/${cases.length} 通过 · PROMPT_VERSION=${PROMPT_VERSION} · ${buildSystemPrompt().length} 字符`);
if (pass !== cases.length) process.exit(1);
