/**
 * 批量提示条的数量语义单测。
 *
 * 为什么必须断言：`keyUndecryptableCount` 决定要不要出现一条**阻断级**提示。
 * 数错会两种方向都出问题：
 *   · 该出现却不出现 → 用户不知道 key 坏了，功能不可用却毫无解释；
 *   · 不该出现却出现 → 每次都弹一条红条，变成噪音，用户会习惯性忽略（狼来了）。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-keybroken-count.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/verify-kbcount.mjs
 *   node .tmp_ui/verify-kbcount.mjs
 */
import { countKeyBroken } from "../../src/panels/aiModelState.ts";

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
    provider: "openai-compatible",
    baseUrl: "https://x",
    model: "m",
    ready: !broken,
    needsKey: true,
    needsKeyMissing: false,
    hasApiKey: !broken,
    keyUndecryptable: broken,
    source: "manual"
  }) as unknown as Parameters<typeof countKeyBroken>[0][number];

console.log("== 数量语义（决定提示条出不出）==");
{
  check("全好 → 0（提示条不出现）", countKeyBroken([mk("a", false), mk("b", false)]) === 0);
  check("1 个坏 → 1", countKeyBroken([mk("a", false), mk("b", true)]) === 1);
  check("2 个坏 → 2（触发列表形态）", countKeyBroken([mk("a", true), mk("b", true)]) === 2);
  check("全坏 → 全部", countKeyBroken([mk("a", true), mk("b", true), mk("c", true)]) === 3);
  check("空清单 → 0", countKeyBroken([]) === 0);
}

console.log("== 不能把「没填过」算进来 ==");
{
  // needsKeyMissing（真没填）不该计入"需要重新粘贴"的数量 ——
  // 两者的下一步动作不同（一个去填、一个重新粘贴），合并会误导。
  const neverFilled = {
    id: "n",
    label: "n",
    provider: "openai-compatible",
    baseUrl: "https://x",
    model: "m",
    ready: false,
    needsKey: true,
    needsKeyMissing: true,
    hasApiKey: false,
    source: "manual"
  } as unknown as Parameters<typeof countKeyBroken>[0][number];
  check("needsKeyMissing 不计入 key-broken", countKeyBroken([neverFilled]) === 0);
  check(
    "混合时只数 keyUndecryptable",
    countKeyBroken([neverFilled, mk("a", true), mk("b", false)]) === 1,
    String(countKeyBroken([neverFilled, mk("a", true), mk("b", false)]))
  );
}

console.log("== 边界 ==");
{
  // keyUndecryptable 为 undefined / 非 true 时都不算
  const undef = { ...mk("u", false), keyUndecryptable: undefined } as unknown as Parameters<typeof countKeyBroken>[0][number];
  check("undefined 不算", countKeyBroken([undef]) === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
