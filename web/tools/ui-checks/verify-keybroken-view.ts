/**
 * Key 失效提示条**决策逻辑**单测。
 *
 * 参数化改造的核心收益就在这个文件：`renderKeyBrokenHint` 原来自己读全局
 * `modelsState`，所以「还没 `await loadModels` 就被调用」只能在运行时发现，
 * 且表现为"静默渲染成空"。抽出 `keyBrokenViewOf(models, status)` 后，
 * **不用起 Electron** 就能喂数组断言输出。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-keybroken-view.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/verify-kbview.mjs
 *   node .tmp_ui/verify-kbview.mjs
 */
import { keyBrokenViewOf } from "../../src/panels/keyBrokenView.ts";

type E = Parameters<typeof keyBrokenViewOf>[0][number];
type S = Parameters<typeof keyBrokenViewOf>[1];

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const mk = (id: string, broken: boolean) =>
  ({
    id,
    label: id,
    provider: "openai-compatible" as const,
    baseUrl: "https://x",
    model: "m",
    ready: !broken,
    needsKey: true,
    needsKeyMissing: false,
    hasApiKey: !broken,
    keyUndecryptable: broken,
    source: "manual" as const
  }) as unknown as E;

const status = (count: number, entries?: { scope: "top-level" | "model"; id?: string }[]) =>
  ({ mode: "desktop", ready: false, keyUndecryptableCount: count, keyUndecryptableEntries: entries } as unknown as S);

console.log("== 1 个：单条 + 去重填，不展开列表 ==");
{
  const v = keyBrokenViewOf([mk("a", true), mk("b", false)], status(1, [{ scope: "model", id: "a" }]));
  check("count = 1", v.count === 1, String(v.count));
  check("按钮文案「去重填」", v.buttonLabel === "去重填", v.buttonLabel);
  check("不展开列表（避免为最常见情况造两层导航）", v.showList === false);
  check("列表仍给出那一条（供 rekeyAll 定位）", v.brokenEntries.length === 1);
  check("标题含数量与动作", v.title.includes("1 个模型") && v.title.includes("重新粘贴"), v.title);
}

console.log("== 2 个：展开列表 ==");
{
  const v = keyBrokenViewOf(
    [mk("a", true), mk("b", true), mk("c", false)],
    status(2, [{ scope: "model", id: "a" }, { scope: "model", id: "b" }])
  );
  check("count = 2", v.count === 2);
  check("按钮文案「查看并重填」", v.buttonLabel === "查看并重填", v.buttonLabel);
  check("展开列表", v.showList === true);
  check("列表只含失效的（不含正常那条）", v.brokenEntries.length === 2 && !v.brokenEntries.some((m) => m.id === "c"));
}

console.log("== 0 个：整条不显示 ==");
{
  const v = keyBrokenViewOf([mk("a", false)], status(0, []));
  check("count = 0（UI 据此 display:none）", v.count === 0, String(v.count));
  check("无列表", v.showList === false);
  check("无警告", v.warning === null);
}

console.log("== 关键回归：空数组（未 await loadModels 时的形态）==");
{
  // 这正是原来 bug 的形态：modelsState 为 null → 传进来的只能是 []
  // 决策层必须如实返回 0（而不是假装有数据），从而让上层能察觉。
  const v = keyBrokenViewOf([], status(2, [{ scope: "model", id: "a" }, { scope: "model", id: "b" }]));
  check("空数组 → count 0（不是 2）", v.count === 0, String(v.count));
  // 而且必须**报出不一致**：count 说 2、逐条说 0 —— 这正是应被看见的信号
  check("空数组时 report 不一致", v.warning !== null, String(v.warning));
  check("警告里点出 count 与逐条差异", v.warning?.includes("逐条标记了 0") === true, v.warning ?? "");
}

console.log("== 统计源不一致 ==");
{
  const v = keyBrokenViewOf([mk("a", true)], status(2, [{ scope: "model", id: "a" }]));
  check("显示用逐条数（1），不用 count（2）", v.count === 1, String(v.count));
  check("不一致被报出", v.warning !== null);
}
{
  // 一致时不该报
  const v = keyBrokenViewOf([mk("a", true), mk("b", true)], status(2, [
    { scope: "model", id: "a" },
    { scope: "model", id: "b" }
  ]));
  check("三方一致 → 无警告", v.warning === null, String(v.warning));
}

console.log("== status 缺省 ==");
{
  const v = keyBrokenViewOf([mk("a", true)], null);
  check("status=null 仍按逐条渲染", v.count === 1, String(v.count));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
