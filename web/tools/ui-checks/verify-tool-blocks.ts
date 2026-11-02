/**
 * 工具块合并与用量文案的单测。
 *
 * 为什么必须断言：
 *   · `upsertToolBlock` 合并错 → **每次工具调用显示两个块**（用户截图里就是这个现象）；
 *   · 按 `name` 合并而不是 `callId` → 两个同名工具的耗时/错误**串到另一条**上。
 *     这两类都是"看起来有内容、实际是错的"，截图很难分辨。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-tool-blocks.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/verify-tools.mjs
 *   node .tmp_ui/verify-tools.mjs
 */
import { upsertToolBlock } from "../../src/panels/aiPanel.ts";

interface B {
  name: string;
  detail: string;
  callId?: string;
  ms?: number;
  ok?: boolean;
  error?: string;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("== upsertToolBlock（数据层合并）==");
{
  // 一次调用 = start 一条 + end 一条，必须合并成 **1 条**
  const list: B[] = [];
  upsertToolBlock(list, { name: "SceneDigest", detail: "调用 SceneDigest(mapSize)", callId: "c1" });
  upsertToolBlock(list, {
    name: "SceneDigest",
    detail: "32 行 / 1.2K 字符",
    callId: "c1",
    ok: false,
    ms: 812,
    error: "工具执行失败：未注入摘要"
  });
  check("start + end 合并成 1 条", list.length === 1, `实际 ${list.length} 条`);
  check("合并后带上了成败", list[0].ok === false);
  check("合并后带上了耗时", list[0].ms === 812);
  check("合并后 detail 是结束事件的（更具体）", list[0].detail === "32 行 / 1.2K 字符");
  check("错误原文保留", list[0].error === "工具执行失败：未注入摘要");
}
{
  // 用户实际场景：两个同名工具连续调用，必须各占一条、互不覆盖
  const list: B[] = [];
  upsertToolBlock(list, { name: "SceneDigest", detail: "调用A", callId: "a" });
  upsertToolBlock(list, { name: "SceneDigest", detail: "调用B", callId: "b" });
  check("同名但 callId 不同 → 2 条（不错误合并）", list.length === 2, `${list.length}`);
  // 再各自结束
  upsertToolBlock(list, { name: "SceneDigest", detail: "结果A", callId: "a", ms: 100, ok: true });
  upsertToolBlock(list, { name: "SceneDigest", detail: "结果B", callId: "b", ms: 200, ok: false });
  check("结束后仍是 2 条", list.length === 2);
  check("A 的耗时没被 B 覆盖", list[0].ms === 100, `A.ms=${list[0].ms}`);
  check("B 的耗时没被 A 覆盖", list[1].ms === 200, `B.ms=${list[1].ms}`);
  check("A 成功 / B 失败（成败不串）", list[0].ok === true && list[1].ok === false);
}
{
  // 没有 callId（老契约）：同一 name 会被更新成一条 —— 这是**已知退化**，
  // 但绝不能变成两条（那会让老契约下每次调用都重复显示）
  const list: B[] = [];
  upsertToolBlock(list, { name: "Echo", detail: "调用 Echo(x)" });
  upsertToolBlock(list, { name: "Echo", detail: "结果" });
  check("无 callId 时同 name 合并成 1 条（已知退化，但好过重复）", list.length === 1, `${list.length}`);
}
{
  // 三条不同工具互不影响
  const list: B[] = [];
  upsertToolBlock(list, { name: "A", detail: "a", callId: "1" });
  upsertToolBlock(list, { name: "B", detail: "b", callId: "2" });
  upsertToolBlock(list, { name: "C", detail: "c", callId: "3" });
  check("不同工具各自成条", list.length === 3);
  // 更新中间那条
  upsertToolBlock(list, { name: "B", detail: "b2", callId: "2", ok: true });
  check("更新中间条目不影响数量", list.length === 3);
  check("更新命中的是正确那条", list[1].detail === "b2");
  check("其它两条不变", list[0].detail === "a" && list[2].detail === "c");
}
{
  // ok 缺省 = 未知，必须保持 undefined（不能变成 false/true）
  const list: B[] = [];
  upsertToolBlock(list, { name: "X", detail: "d", callId: "z" });
  check("ok 缺省保持 undefined（不猜成败）", list[0].ok === undefined, `ok=${String(list[0].ok)}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
