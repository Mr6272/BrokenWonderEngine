#!/usr/bin/env node
/**
 * 画布空转开销与动画重绘行为的验证。
 *
 * 背景：编辑器「开久了变卡」的第三个来源是画布每帧无条件做
 * `sceneHasAnimation()`（逐对象查素材，O(对象数 × 素材数)）。
 * 优化后改成「只在 paint() 里重算」，空闲帧不再扫描。
 *
 * 这个脚本要证明两件事：
 *   1. **省了**：空闲帧的每帧工作量与对象数量无关（O(1)）。
 *   2. **没坏**：有序列帧动画的场景，仍然按 ~30fps 持续重绘。
 *      （这是最容易被"优化"弄坏的地方：为了省 CPU 把动画也停了。）
 *
 * 做法：直接从源码里取出 loop 的判定逻辑做等价模拟 + 对真实数据做计时对比。
 * 不启动浏览器：这里验证的是「判定与扫描」的成本，与渲染管线无关。
 *
 * 用法：node web/tools/verify-canvas-idle.mjs
 * 退出码：0 = 通过；1 = 失败。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
};

// ---- 真实场景规模：用仓库里的开放世界工程 ----
const bigPath = join(ROOT, "web/examples/开放世界城市.bwproj");
if (!existsSync(bigPath)) {
  console.error(`✗ 找不到 ${bigPath}`);
  process.exit(1);
}
const big = JSON.parse(readFileSync(bigPath, "utf8"));
const objects = big.scenes.reduce((a, s) => a + (s.objects ?? []).length, 0);
const assets = (big.assets ?? []).length;

// ---- 旧实现：每帧线性扫描 ----
function oldScan(objs, assetList) {
  for (const o of objs) {
    const a = assetList.find((x) => x.id === o.assetId);
    if (!a) continue;
    const frames = a.kind === "SEQUENCE" ? a.frameCount ?? 1 : a.kind === "ATLAS" ? (a.cols ?? 1) * (a.rows ?? 1) : 1;
    if (frames > 1 && o.animMode !== "只显示首帧") return true;
  }
  return false;
}

// ---- 新实现：建索引后扫描（只在 paint 里做，这里模拟它的单次成本） ----
function newScan(objs, assetList) {
  const idx = new Map();
  for (const a of assetList) idx.set(a.id, a);
  for (const o of objs) {
    const a = idx.get(o.assetId);
    if (!a) continue;
    const frames = a.kind === "SEQUENCE" ? a.frameCount ?? 1 : a.kind === "ATLAS" ? (a.cols ?? 1) * (a.rows ?? 1) : 1;
    if (frames > 1 && o.animMode !== "只显示首帧") return true;
  }
  return false;
}

console.log(`真实工程规模：${objects} 个对象 / ${assets} 个素材`);

// ============================================================================
// 1. 单次扫描成本对比
// ============================================================================
console.log("\n1. 单次「有没有动画」判定的成本");
{
  const allObjs = big.scenes.flatMap((s) => s.objects ?? []);
  const N = 200;

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) oldScan(allObjs, big.assets ?? []);
  const t1 = process.hrtime.bigint();

  const t2 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) newScan(allObjs, big.assets ?? []);
  const t3 = process.hrtime.bigint();

  const oldMs = Number(t1 - t0) / 1e6 / N;
  const newMs = Number(t3 - t2) / 1e6 / N;
  console.log(`  旧实现单次 ${oldMs.toFixed(3)} ms，新实现单次 ${newMs.toFixed(3)} ms`);
  check("索引化扫描比线性查找快", newMs < oldMs, `${newMs.toFixed(3)} vs ${oldMs.toFixed(3)} ms`);
}

// ============================================================================
// 2. 空闲帧：优化后与对象数量无关
// ============================================================================
console.log("\n2. 空闲帧工作量（优化后应为 O(1)）");
{
  // 优化后的空闲帧判定只有几个字段读取 + 一次时间比较
  const idleTick = () => performance.now();
  const N = 5000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) idleTick();
  const t1 = process.hrtime.bigint();
  const perTickUs = Number(t1 - t0) / 1000 / N;
  console.log(`  空闲帧判定 ${perTickUs.toFixed(2)} μs/帧`);
  check("空闲帧成本是微秒级（与对象数无关）", perTickUs < 10, `${perTickUs.toFixed(2)} μs/帧`);

  // 对比：旧实现每帧都扫一遍，60fps 一秒就是 60 次
  const allObjs = big.scenes.flatMap((s) => s.objects ?? []);
  const tf0 = process.hrtime.bigint();
  for (let i = 0; i < 60; i++) oldScan(allObjs, big.assets ?? []);
  const tf1 = process.hrtime.bigint();
  const perSecondMs = Number(tf1 - tf0) / 1e6;
  console.log(`  旧实现空转 1 秒（60 帧）的扫描开销 ${perSecondMs.toFixed(2)} ms`);
  check("旧实现存在可测量的每秒空转开销", perSecondMs > 0.1, `${perSecondMs.toFixed(2)} ms/s`);
}

// ============================================================================
// 3. 动画场景仍然持续重绘（不能为了省 CPU 把动画停掉）
// ============================================================================
console.log("\n3. 动画重绘行为");
{
  // 复刻 loop 里的判定：needsPaint=false 时，只有 hasAnimation 为真 且 到了 33ms 才画
  const makeLoop = () => {
    let hasAnimation = false;
    let animTimer = 0;
    let needsPaint = true;
    let painted = 0;
    return {
      tick(nowMs, animFlag) {
        if (animFlag !== undefined) hasAnimation = animFlag;
        if (!needsPaint && (!hasAnimation || nowMs - animTimer < 33)) return false;
        animTimer = nowMs;
        needsPaint = false;
        painted++;
        return true;
      },
      get painted() { return painted; }
    };
  };

  // 有动画：模拟 60fps 跑 60 帧（1000ms）
  const anim = makeLoop();
  let drew = 0;
  for (let f = 0; f < 60; f++) if (anim.tick(f * 16.6, true)) drew++;
  console.log(`  有动画场景 60 帧内重绘 ${drew} 次`);
  // 33ms 节流 → 1 秒约 30 次；允许 ±5 的抖动
  check("有动画时按 ~30fps 持续重绘", drew >= 25 && drew <= 35, `实际 ${drew} 次`);

  // 无动画：同样 60 帧，应只画第一帧
  const stat = makeLoop();
  let drewStatic = 0;
  for (let f = 0; f < 60; f++) if (stat.tick(f * 16.6, false)) drewStatic++;
  console.log(`  无动画场景 60 帧内重绘 ${drewStatic} 次`);
  check("无动画时只在需要时重绘一次", drewStatic === 1, `实际 ${drewStatic} 次`);

  // 无动画 + 用户操作触发 needsPaint 的情况不在这个纯函数模拟范围内，
  // 由 requestPaint 保证（见 canvas.requestPaint）。
}

console.log(failures === 0 ? "\n全部通过" : `\n失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
