#!/usr/bin/env node
/**
 * 撤销快照去重的正确性与内存收益验证。
 *
 * 要证明两件事：
 *   1. **正确性**：任意工程（含内联 base64 素材、超长脚本、中文、看起来像占位的文本）
 *      经 序列化 → 反序列化 后与原文完全一致 —— 逐字节比较，不靠"看起来对"。
 *   2. **收益**：80 步撤销历史的常驻内存显著下降
 *      （原来每份快照都带一份完整 base64，内容各不相同、无法共享）。
 *
 * 实现方式：用项目自带的 esbuild 把 `web/src/core/snapshot.ts` 编译成 mjs 再 import，
 * 测的就是**编辑器真正运行的那份代码**，而不是为测试重写一份。
 *
 * 用法：node web/tools/verify-snapshot-pool.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const srcPath = join(ROOT, "web/src/core/snapshot.ts");
if (!existsSync(srcPath)) {
  console.error(`✗ 找不到 ${srcPath}`);
  process.exit(1);
}

const outDir = join(ROOT, "web/.build");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "snapshot-pool.test.mjs");
buildSync({
  entryPoints: [srcPath],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent"
});

const { SnapshotPool } = await import(`file://${outFile}`);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

// ============================================================================
// 1. 正确性：往返一致
// ============================================================================
console.log("正确性 · 往返一致");

const bigScript = "function onStart() {\n  // 中文注释 ✓\n  bwe.log('你好');\n}".repeat(400);

const samples = [
  {
    label: "内联 base64 素材（真实工程同款）",
    value: () => JSON.parse(readFileSync(join(ROOT, "web/examples/扫雷.bwproj"), "utf8"))
  },
  {
    label: "超长脚本 + 中文 + CRLF",
    value: () => ({ scripts: { main: bigScript }, note: "含 CRLF\r\n文本" })
  },
  { label: "边界：999 字符（不该进池）", value: () => ({ s: "x".repeat(999) }) },
  { label: "边界：1024 字符（刚好进池）", value: () => ({ s: "x".repeat(1024) }) },
  {
    label: "同一大串出现多次（应只存一份）",
    value: () => {
      const big = "A".repeat(4096);
      return { a: big, b: big, c: big, list: [big, big] };
    }
  },
  { label: "看起来像占位的普通文本", value: () => ({ s: "\u0001bwe:blob:999999" }) },
  { label: "数组 / null / 布尔", value: () => ({ arr: [1, 2, { x: "y".repeat(2000) }], n: null, b: true }) },
  { label: "空对象", value: () => ({}) }
];

for (const s of samples) {
  const pool = new SnapshotPool();
  const original = s.value();
  const json = pool.stringify(original);
  const back = pool.parse(json);
  const same = JSON.stringify(back) === JSON.stringify(original);
  check(s.label, same, same ? "" : "往返后内容不一致");
}

// ============================================================================
// 2. 收益：80 步历史的内存占用
// ============================================================================
console.log("\n收益 · 80 步撤销历史的常驻内存");

const realProject = JSON.parse(readFileSync(join(ROOT, "web/examples/扫雷.bwproj"), "utf8"));

const before = [];
const m0 = process.memoryUsage().heapUsed;
for (let i = 0; i < 80; i++) {
  const copy = JSON.parse(JSON.stringify(realProject));
  copy.__step = i; // 模拟每步都有不同改动
  before.push(JSON.stringify(copy));
}
const m1 = process.memoryUsage().heapUsed;

const pool = new SnapshotPool();
const after = [];
for (let i = 0; i < 80; i++) {
  const copy = JSON.parse(JSON.stringify(realProject));
  copy.__step = i;
  after.push(pool.stringify(copy));
}
const m2 = process.memoryUsage().heapUsed;

const beforeMB = (m1 - m0) / 1048576;
const afterMB = (m2 - m1) / 1048576;
const avgBefore = Math.round(before.reduce((a, b) => a + b.length, 0) / 80);
const avgAfter = Math.round(after.reduce((a, b) => a + b.length, 0) / 80);

console.log(`  旧实现堆增量：${beforeMB.toFixed(1)} MB（每份快照 ${avgBefore} 字符）`);
console.log(`  新实现堆增量：${afterMB.toFixed(1)} MB（每份快照 ${avgAfter} 字符）`);
console.log(`  池内去重后只存 ${pool.stats().entries} 条大字符串 / ${(pool.stats().chars / 1048576).toFixed(1)} MB`);

check("新实现明显更省内存", afterMB < beforeMB * 0.5, `实际 ${afterMB.toFixed(1)} vs ${beforeMB.toFixed(1)} MB`);
check("同一份大素材在池里只存一次", pool.stats().entries <= 12, `实际 ${pool.stats().entries} 条`);
check("快照平均长度下降一个数量级", avgAfter < avgBefore * 0.1, `实际 ${avgAfter} vs ${avgBefore}`);

// ============================================================================
// 3. 健壮性：池满与越界占位
// ============================================================================
console.log("\n健壮性 · 池满与越界占位");
{
  const p = new SnapshotPool();
  let overflowed = false;
  // 池上限 64M 字符，单个串 40M 字符；每次内容必须**不同**，
  // 否则会被去重命中而根本不走到容量检查（这正是第一版用例的错误：
  // 三次都传同一个字符串，于是"池满"永远测不出来）。
  for (let i = 0; i < 3; i++) {
    p.stringify({ s: String.fromCharCode(65 + i).repeat(40 * 1048576) }, () => { overflowed = true; });
  }
  check("池满会通知调用方", overflowed);

  const back = p.parse(p.stringify({ s: "ok" }));
  check("池重置后仍能正常往返小数据", JSON.stringify(back) === JSON.stringify({ s: "ok" }));

  const bad = p.parse(JSON.stringify({ s: "\u0001bwe:blob:123456" }));
  check("越界占位原样返回，不吃真实文本", bad.s === "\u0001bwe:blob:123456");
}

console.log(failures === 0 ? "\n全部通过" : `\n失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
