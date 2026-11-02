/**
 * Key 失效两份统计源的交叉校验单测。
 *
 * 为什么必须断言：`count` 与「逐条 flag」是两个独立源，漂移会表现为
 * 「红条说 1 个，点进去却是 2 个」—— 正是我们反复踩的「同一件事多个统计源」的病。
 * 这类错误截图看不出来（两种都可能"看起来正常"）。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-keybroken-reconcile.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/verify-kbrec.mjs
 *   node .tmp_ui/verify-kbrec.mjs
 */
import { reconcileKeyBroken } from "../../src/panels/keyBrokenReconcile.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("== 一致（常见情况）==");
{
  const r = reconcileKeyBroken(1, 1, [{ scope: "model", id: "kimi" }]);
  check("全部一致 → consistent", r.consistent === true);
  check("全部一致 → 无警告", r.warning === null);
  check("显示 1", r.shown === 1);
}
{
  // 没有 key 坏：全 0
  const r = reconcileKeyBroken(0, 0, []);
  check("全 0 也一致", r.consistent === true && r.shown === 0, JSON.stringify(r));
}
{
  // entries 缺省（老版本主进程）→ 不做它的校验，只用 count
  const r = reconcileKeyBroken(2, 2, undefined);
  check("entries 缺省时仍能判一致", r.consistent === true, JSON.stringify(r));
}

console.log("== 不一致：count 与 entries 打架 ==");
{
  const r = reconcileKeyBroken(2, 1, [
    { scope: "model", id: "a" },
    { scope: "model", id: "b" }
  ]);
  check("不一致被检出", r.consistent === false);
  check("警告里点出 count 与 entries 的差异", r.warning?.includes("count 说 1") === true, r.warning ?? "");
  // 显示必须用逐条数出来的（红条说几条，列表就得能点到几条）
  check("显示用逐条数（2），不是 count（1）", r.shown === 2, String(r.shown));
}

console.log("== 不一致：逐条与 count 打架 ==");
{
  const r = reconcileKeyBroken(2, 1, undefined);
  check("逐条 2 / count 1 → 不一致", r.consistent === false);
  check("警告说明逐条与 count 的差异", r.warning?.includes("逐条标记了 2") === true, r.warning ?? "");
  check("显示 2（更精确）", r.shown === 2);
}
{
  // count 说 2 但逐条只数到 1（比如字段没同步）
  const r = reconcileKeyBroken(1, 2, undefined);
  check("count 多报 → 不一致", r.consistent === false);
  check("显示 1（以逐条为准）", r.shown === 1, String(r.shown));
}

console.log("== 边界 ==");
{
  // 全 undefined → 视为 0，一致
  const r = reconcileKeyBroken(0, undefined, undefined);
  check("全缺省当 0，一致且不崩", r.consistent === true && r.shown === 0);
}
{
  // 负数 / NaN 都要被夹到 0
  const r = reconcileKeyBroken(Number.NaN, -1, undefined);
  check("NaN 与负数被夹到 0", r.shown === 0 && r.consistent === true, JSON.stringify(r));
}
{
  // entries 不是数组（主进程返回怪值）不崩
  const r = reconcileKeyBroken(1, 1, null as unknown as undefined);
  check("entries 为 null 不崩", r.shown === 1 && r.consistent === true, JSON.stringify(r));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
