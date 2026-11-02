/**
 * 会话切换器的纯逻辑单测。
 *
 * 为什么这些必须断言而不是截图：
 *   · 相对时间算错 → 「3 分钟前」显示成「3 天前」，截图看不出对错（图里只有文字）；
 *   · 排序错 → 用户找"刚才那个对话"要往下翻；
 *   · `abortedNotice` 不返回 → 回答莫名消失且没有解释（**截图完全看不出来**）。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-sessions.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/verify-sessions.mjs
 *   node .tmp_ui/verify-sessions.mjs
 */
import {
  relativeTime,
  sortSessions,
  sessionSubtitle,
  abortedNotice
} from "../../src/panels/aiSessions.ts";

const NOW = Date.UTC(2026, 10, 2, 1, 0, 0); // 固定"现在"，避免用真实时间导致 flaky
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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

function mk(id: string, updatedAt: number, messageCount = 2, title = id) {
  return { id, title, createdAt: updatedAt, updatedAt, messageCount };
}

console.log("== 相对时间 relativeTime（输入是毫秒时间戳）==");
{
  check("30 秒前 → 刚刚", relativeTime(NOW - 30_000, NOW) === "刚刚");
  check("5 分钟前", relativeTime(NOW - 5 * MIN, NOW) === "5 分钟前");
  check("59 分钟前仍按分钟", relativeTime(NOW - 59 * MIN, NOW) === "59 分钟前");
  check("2 小时前", relativeTime(NOW - 2 * HOUR, NOW) === "2 小时前");
  check("3 天前", relativeTime(NOW - 3 * DAY, NOW) === "3 天前");
  // 超过 7 天退回日期
  const old = relativeTime(NOW - 30 * DAY, NOW);
  check("30 天前 → 日期格式", /^\d{4}-\d{2}-\d{2}$/.test(old), old);
}
{
  // 关键防御：门面用 Number() 转时间，若上游换成 ISO 字符串会得到 NaN
  check("NaN → 空串（不显示 NaN 分钟前）", relativeTime(Number.NaN, NOW) === "");
  check("0 → 空串", relativeTime(0, NOW) === "");
  check("未来时间 → 刚刚（时钟漂移兜底）", relativeTime(NOW + HOUR, NOW) === "刚刚");
}

console.log("== 排序 sortSessions ==");
{
  const list = [mk("old", NOW - 3 * DAY), mk("new", NOW - 1 * MIN), mk("mid", NOW - 2 * HOUR)];
  const s = sortSessions(list).map((x) => x.id);
  check("最近更新的在前", s[0] === "new" && s[1] === "mid" && s[2] === "old", s.join(","));
}
{
  // 同时间戳必须稳定（否则每次重画顺序会跳，看着像列表在抖）
  const a = mk("aaa", NOW), b = mk("bbb", NOW);
  const s1 = sortSessions([a, b]).map((x) => x.id).join(",");
  const s2 = sortSessions([b, a]).map((x) => x.id).join(",");
  check("同时间戳排序稳定（按 id 兜底）", s1 === s2 && s1 === "aaa,bbb", `${s1} vs ${s2}`);
}
{
  check("不改动入参数组", (() => {
    const orig = [mk("a", 1), mk("b", 2)];
    const copy = orig.map((x) => x.id).join(",");
    sortSessions(orig);
    return orig.map((x) => x.id).join(",") === copy;
  })());
}

console.log("== 副标题 sessionSubtitle ==");
{
  check("有条数有相对时间", sessionSubtitle(mk("a", NOW - 5 * MIN, 2), NOW) === "2 条 · 5 分钟前");
  check("0 条 → 还没聊过", sessionSubtitle(mk("a", NOW - 5 * MIN, 0), NOW) === "还没聊过 · 5 分钟前");
  check("时间戳异常 → 只显示条数", sessionSubtitle(mk("a", Number.NaN, 3), NOW) === "3 条");
}

console.log("== 中断提示 abortedNotice ==");
{
  check("aborted=0 → 不提示", abortedNotice(0, "switch") === null);
  check("aborted=undefined → 不提示", abortedNotice(undefined, "new") === null);
  check("aborted=NaN → 不提示", abortedNotice(Number.NaN, "delete") === null);
  check(
    "切换时中断 2 个",
    abortedNotice(2, "switch") === "切换会话时已中断 2 个正在生成的回答",
    String(abortedNotice(2, "switch"))
  );
  check("新建时措辞不同", abortedNotice(1, "new") === "新建会话时已中断 1 个正在生成的回答");
  check("删除时措辞不同", abortedNotice(3, "delete") === "删除会话时已中断 3 个正在生成的回答");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
