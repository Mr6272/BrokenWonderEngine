/**
 * 模型状态判定单测（含 `key-broken`）。
 *
 * 为什么必须断言：
 *   **`needsKeyMissing`（没填过）与 `keyUndecryptable`（填过但解不开）混淆，
 *   是用户实际踩过的坑。** 混淆的后果不是"显示不准"，是**用户会以为是自己忘了填**，
 *   于是反复去设置页重填，而真正的原因是客户端解密失败。
 *   这类错误截图看不出来（两种状态都是"不能用"），只有断言能钉住。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-model-state.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/verify-model.mjs
 *   node .tmp_ui/verify-model.mjs
 */
import {
  modelStateOf,
  modelStateSuffix,
  isNeedsKey,
  needsReKey,
  countNeedsKey,
  countKeyBroken,
  canUseNow
} from "../../src/panels/aiModelState.ts";

type E = Parameters<typeof modelStateOf>[0];

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const base = {
  id: "m1",
  label: "kimi-k3",
  provider: "openai-compatible",
  baseUrl: "https://api.moonshot.cn/v1",
  model: "kimi-k3",
  ready: true,
  needsKey: true,
  needsKeyMissing: false,
  hasApiKey: true,
  source: "manual"
} as unknown as E;

const broken = { ...base, keyUndecryptable: true, ready: false, hasApiKey: false } as unknown as E;
const neverFilled = { ...base, needsKeyMissing: true, hasApiKey: false } as unknown as E;
const incompleteEntry = { ...base, ready: false, reason: "缺少模型名" } as unknown as E;
const mockEntry = { ...base, provider: "mock" } as unknown as E;

console.log("== key-broken（填过但解不开）==");
{
  const st = modelStateOf(broken, false);
  check("kind = key-broken", st.kind === "key-broken", st.kind);
  check("chip 用 danger 色（不是 warn）", st.cls === "danger", st.cls);
  check("文案含「Key 失效」", st.short.includes("Key 失效"), st.short);
  // 最关键的措辞：必须让用户知道"不是你忘了填"
  check("tooltip 说明是解密失败", st.why.includes("解不开"), st.why);
  check("tooltip 说明不是用户忘填", st.why.includes("不是你忘了填"), st.why);
  check("tooltip 说明要重新粘贴", st.why.includes("重新粘贴"), st.why);
  check("needsReKey 标记为 true", st.needsReKey === true);
}
{
  // key-broken **不算** needs-key（两种提示语不同，弹的框文案也不同）
  check("isNeedsKey(key-broken) = false", isNeedsKey(broken) === false);
  check("needsReKey(key-broken) = true", needsReKey(broken) === true);
}

console.log("== needs-key（真没填）==");
{
  const st = modelStateOf(neverFilled, false);
  check("kind = needs-key", st.kind === "needs-key", st.kind);
  check("用 warn 色（不是 danger）", st.cls === "warn", st.cls);
  check("不含「失效」字样", !st.short.includes("失效"), st.short);
  check("isNeedsKey = true", isNeedsKey(neverFilled) === true);
  check("needsReKey = false", needsReKey(neverFilled) === false);
}

console.log("== 优先级：解密失败优先于「配置不全」 ==");
{
  // 真实场景里 ready 也会是 false。若按 ready 先判，就会说成"配置不全"，
  // 掩盖真正的根因（解密失败）。
  const both = { ...broken, ready: false, reason: "API Key 无法解密" } as unknown as E;
  const st = modelStateOf(both, false);
  check("ready:false + 解密失败 → 仍是 key-broken", st.kind === "key-broken", st.kind);
}

console.log("== 其它状态不受影响 ==");
{
  const st = modelStateOf(base, false);
  check("正常配置 → configured", st.kind === "configured", st.kind);
  check("configured 不说「可用」", !st.short.includes("可用"), st.short);
  check("canUseNow = true", canUseNow(base) === true);
}
{
  const st = modelStateOf(incompleteEntry, false);
  check("配置不全 → incomplete", st.kind === "incomplete", st.kind);
}
{
  const st = modelStateOf(mockEntry, true);
  check("mock → 本地演示", st.kind === "mock", st.kind);
}
{
  // mock 参数为 true 时，即使条目是 broken 也显示 mock（网页版场景）
  const st = modelStateOf(broken, true);
  check("mock 模式下优先显示本地演示", st.kind === "mock", st.kind);
}

console.log("== 下拉后缀 ==");
{
  const s = modelStateSuffix(broken);
  check("key-broken 后缀说「需重新粘贴」", s.includes("重新粘贴"), s);
  check("needs-key 后缀说「需要填」", modelStateSuffix(neverFilled).includes("需要填"));
  check("正常条目无后缀", modelStateSuffix(base) === "", modelStateSuffix(base));
}

console.log("== 计数：两类必须分开统计 ==");
{
  const list = [broken, neverFilled, base];
  check("countNeedsKey 只数 needs-key", countNeedsKey(list) === 1, String(countNeedsKey(list)));
  check("countKeyBroken 只数 key-broken", countKeyBroken(list) === 1, String(countKeyBroken(list)));
  // 如果混成一个数字，用户会以为"所有都要重填"，也看不出是客户端故障
  check("两类的和 != 总数（证明没合并）", countNeedsKey(list) + countKeyBroken(list) === 2);
}
{
  check("空清单计数为 0", countNeedsKey([]) === 0 && countKeyBroken([]) === 0);
}

console.log("== 边界 ==");
{
  const st = modelStateOf(null, false);
  check("entry=null 不崩且回 mock", st.kind === "mock", st.kind);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
