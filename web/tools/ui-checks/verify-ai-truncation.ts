/**
 * `done.extra → 提示条` 判定的单测（纯函数，不碰 DOM）。
 *
 * 为什么必须断言：
 *   · 用户报的是「AI 跑两下就寄了，没给我交付任何东西」。主进程修了预算/截断，
 *     渲染侧若**不显示**或**显示错**，用户看到的还是「半截话 + 沉默」——
 *     等于没修。而判定错的方式很隐蔽（字段名差个字母、字符串 "true"、
 *     `用了 3/undefined 轮`），截图里都"看起来有条提示"。
 *   · `extra` 是宿主发来的、可能缺省的数据。任何组合都**不能抛异常、不能出空条**：
 *     抛异常会打死整个面板，空条就是用户截图里那几条「极淡的空白横线」。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-ai-truncation.ts \\
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/ai-truncation.mjs
 *   node .tmp_ui/ai-truncation.mjs
 */
import { answerNotices, type AnswerNotice } from "../../src/panels/aiAnswerNotice.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const FULL_BUDGET = {
  roundsUsed: 8,
  roundsMax: 8,
  callsUsed: 12,
  callsMax: 12,
  budgetExhausted: true,
  elapsedMs: 41500
};

/** 不抛异常地调一次（抛了直接记 FAIL，而不是让脚本崩掉）。 */
function call(extra: unknown): { ok: true; list: AnswerNotice[] } | { ok: false; err: string } {
  try {
    return { ok: true, list: answerNotices(extra) };
  } catch (e) {
    return { ok: false, err: (e as Error)?.message ?? String(e) };
  }
}

/** 通用断言：不抛 + 条数 + 每条都不是空条。 */
function expectNotices(name: string, extra: unknown, count: number): AnswerNotice[] {
  const r = call(extra);
  if (!r.ok) {
    check(`${name}：不抛异常`, false, r.err);
    return [];
  }
  check(`${name}：不抛异常`, true);
  check(`${name}：${count} 条`, r.list.length === count, `实际 ${r.list.length} 条`);
  for (const [i, n] of r.list.entries()) {
    // 空条 = 硬约束违反（渲染出空白的警告条，比不渲染更糟）
    check(`${name}：第 ${i + 1} 条标题非空`, typeof n.title === "string" && n.title.trim().length > 0, n.title);
    check(`${name}：第 ${i + 1} 条正文非空`, typeof n.detail === "string" && n.detail.trim().length > 0, n.detail);
    check(`${name}：第 ${i + 1} 条是警告视觉`, n.tone === "warn", n.tone);
    check(`${name}：第 ${i + 1} 条 kind 合法`, n.kind === "budget" || n.kind === "truncated", n.kind);
    // 拼接错误最典型的表现就是文案里出现原始 JS 值
    check(
      `${name}：第 ${i + 1} 条不含 undefined/NaN/null`,
      !/undefined|NaN|null/.test(n.detail),
      n.detail
    );
  }
  return r.list;
}

console.log("== 没有字段：完全静默 ==");
{
  expectNotices("空对象", {}, 0);
  expectNotices("extra 缺省（老宿主只发 done.base 字段）", { provider: "deepseek", rounds: 3 }, 0);
  expectNotices("toolBudget 未耗尽", { toolBudget: { ...FULL_BUDGET, budgetExhausted: false } }, 0);
  expectNotices("toolBudget 存在但无 budgetExhausted", { toolBudget: { roundsUsed: 3, roundsMax: 8 } }, 0);
  expectNotices("truncated=false 不显示", { truncated: false }, 0);
}

console.log("== 只有 budget ==");
{
  const list = expectNotices("完整 budget", { toolBudget: FULL_BUDGET }, 1);
  check("kind = budget", list[0]?.kind === "budget", String(list[0]?.kind));
  check("标题含「工具预算用完」", (list[0]?.title ?? "").includes("工具预算用完"), list[0]?.title);
  // 用户最需要看到的具体用量：8/8 轮、12/12 次
  check("detail 含轮次 8/8", (list[0]?.detail ?? "").includes("8/8"), list[0]?.detail);
  check("detail 含调用 12/12", (list[0]?.detail ?? "").includes("12/12"), list[0]?.detail);
  // 必须说清「不是没答，是答案不带更多工具证据」——这是用户困惑的核心
  check("detail 说明已基于已有信息作答", (list[0]?.detail ?? "").includes("已基于已有信息作答"), list[0]?.detail);
}

console.log("== 只有 truncated ==");
{
  const list = expectNotices("truncated=true", { truncated: true }, 1);
  check("kind = truncated", list[0]?.kind === "truncated", String(list[0]?.kind));
  check("标题含「max_tokens 截断」", (list[0]?.title ?? "").includes("max_tokens 截断"), list[0]?.title);
  // 必须给可操作下一步，而不是只说「被截断了」
  check("detail 指向「最大输出 token」设置", (list[0]?.detail ?? "").includes("最大输出 token"), list[0]?.detail);
  check("detail 提到换模型", (list[0]?.detail ?? "").includes("换输出上限更高的模型"), list[0]?.detail);
  // autoContinued 缺省时不能出现 undefined/NaN
  check("缺 autoContinued 时文案仍是完整的", !/undefined|NaN|null/.test(list[0]?.detail ?? ""), list[0]?.detail);
}
{
  // 主进程语义：truncated=true = 已续写 N 次仍被截断（N 来自 autoContinued）
  const list = expectNotices("autoContinued=2", { truncated: true, autoContinued: 2 }, 1);
  check("detail 写出续写次数 2", (list[0]?.detail ?? "").includes("已自动续写 2 次"), list[0]?.detail);
  // 易误解点：用户会以为「重试就好」，文案必须说明续写已经试过了
  check("detail 说明续写后仍不完整", (list[0]?.detail ?? "").includes("仍不完整"), list[0]?.detail);
}
{
  // autoContinued 类型不对/为 0：退回泛化说法，不能拼出「续写 0 次」或 undefined
  const list = expectNotices("autoContinued=\"2\"", { truncated: true, autoContinued: "2" }, 1);
  check("字符串 autoContinued 不进文案", !(list[0]?.detail ?? "").includes("2 次"), list[0]?.detail);
  const list0 = expectNotices("autoContinued=0", { truncated: true, autoContinued: 0 }, 1);
  check("autoContinued=0 用泛化说法", !(list0[0]?.detail ?? "").includes("续写 0 次"), list0[0]?.detail);
}

console.log("== 两者同时成立：顺序固定（truncated 在前）==");
{
  const list = expectNotices("truncated + budget", { truncated: true, toolBudget: FULL_BUDGET }, 2);
  check("第 1 条是 truncated（更根本的原因）", list[0]?.kind === "truncated", String(list[0]?.kind));
  check("第 2 条是 budget", list[1]?.kind === "budget", String(list[1]?.kind));
  // 顺序错 = 错误归因（让人以为「查得太多才没说」）
  check("不是 budget 在前", list.map((n) => n.kind).join(",") === "truncated,budget", list.map((n) => n.kind).join(","));
}

console.log("== budget 但 roundsMax 缺失：降级文案、不抛、不出 undefined ==");
{
  const list = expectNotices("只有 roundsUsed", { toolBudget: { roundsUsed: 3, budgetExhausted: true } }, 1);
  check("仍然显示 1 条（不静默丢掉真正的原因）", list.length === 1);
  check("降级文案不含 3/undefined", !(list[0]?.detail ?? "").includes("3/undefined"), list[0]?.detail);
  check("降级文案含「已基于已有信息作答」", (list[0]?.detail ?? "").includes("已基于已有信息作答"), list[0]?.detail);

  const list2 = expectNotices("roundsMax 类型不对（字符串）", {
    toolBudget: { roundsUsed: 3, roundsMax: "8", callsUsed: 2, callsMax: 5, budgetExhausted: true }
  }, 1);
  check("字符串 roundsMax 不参与拼接", !(list2[0]?.detail ?? "").includes("3/8"), list2[0]?.detail);
  // 另一半（calls）合法时仍应展示，不能因为一处坏掉就全丢
  check("合法的 calls 计数仍然展示", (list2[0]?.detail ?? "").includes("2/5"), list2[0]?.detail);

  const list3 = expectNotices("roundsMax 为 null", {
    toolBudget: { roundsUsed: 3, roundsMax: null, budgetExhausted: true }
  }, 1);
  check("null 不参与拼接", !(list3[0]?.detail ?? "").includes("undefined"), list3[0]?.detail);
  check("缺 max 时不出「3/」这种半截计量", !(list3[0]?.detail ?? "").includes("3/"), list3[0]?.detail);

  // 完全没有计数：仍要说清结论，不能变成空条
  const list4 = expectNotices("只有 budgetExhausted", { toolBudget: { budgetExhausted: true } }, 1);
  check("无计数时也有泛化文案", (list4[0]?.detail ?? "").includes("已达上限"), list4[0]?.detail);
}

console.log("== extra 本身不可用：绝不抛、绝不渲染空条 ==");
{
  expectNotices("extra = null", null, 0);
  expectNotices("extra = undefined", undefined, 0);
  expectNotices("extra = 字符串", "toolBudget", 0);
  expectNotices("extra = 数字", 42, 0);
  expectNotices("extra = 布尔 true", true, 0);
  // `typeof [] === "object"` 的陷阱：数组不能被当成对象读出字段
  expectNotices("extra = 数组", [], 0);
  expectNotices("extra = 带值的数组", [{ truncated: true }], 0);
  expectNotices("extra = 函数", () => ({ truncated: true }), 0);
}

console.log("== 字段类型不对：严格 === true 才算数 ==");
{
  // 字符串 "true" / 数字 1 都不算 —— 猜成 true 会凭空造出一个警告条
  expectNotices("truncated = \"true\" 字符串", { truncated: "true" }, 0);
  expectNotices("truncated = 1", { truncated: 1 }, 0);
  expectNotices("truncated = null", { truncated: null }, 0);
  expectNotices("toolBudget = null", { toolBudget: null }, 0);
  expectNotices("toolBudget = 字符串", { toolBudget: "exhausted" }, 0);
  expectNotices("toolBudget = 数组", { toolBudget: [FULL_BUDGET] }, 0);
  expectNotices("budgetExhausted = \"true\" 字符串", { toolBudget: { ...FULL_BUDGET, budgetExhausted: "true" } }, 0);
  expectNotices("budgetExhausted = 1", { toolBudget: { ...FULL_BUDGET, budgetExhausted: 1 } }, 0);
  expectNotices("budgetExhausted = null", { toolBudget: { ...FULL_BUDGET, budgetExhausted: null } }, 0);
}

console.log("== 兼容主进程未来/过去的额外字段（不该影响判定）==");
{
  const list = expectNotices("未知字段共存", {
    provider: "deepseek",
    model: "deepseek-chat",
    rounds: 8,
    toolCalls: [{ name: "SceneDigest" }],
    promptVersion: 3,
    toolBudget: FULL_BUDGET,
    truncated: true,
    somethingNew: { a: 1 }
  }, 2);
  check("未知字段不产生多余条", list.length === 2, String(list.length));
}

console.log("== 纯函数：同一输入两次调用结果一致（无隐藏状态）==");
{
  const a = answerNotices({ truncated: true, toolBudget: FULL_BUDGET });
  const b = answerNotices({ truncated: true, toolBudget: FULL_BUDGET });
  check("两次调用条数相同", a.length === b.length);
  check("两次调用文案相同", a.every((n, i) => n.title === b[i].title && n.detail === b[i].detail));
  // 返回的是新对象/新数组，调用方改动不会污染下一次
  a[0].title = "改掉";
  check("改动返回值不影响下一次调用", answerNotices({ truncated: true })[0].title.includes("max_tokens"));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
