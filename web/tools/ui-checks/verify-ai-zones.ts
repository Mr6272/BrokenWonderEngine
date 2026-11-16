/**
 * AI 流分区与 Agent 行为摘要的单测（纯函数）。
 *
 * 为什么必须单独断言这两件事：
 *   · `zoneFor()` 决定一条内容落在「Agent 行为区」还是「聊天区」。
 *     写错不会崩，只会让人**在聊天区里找工具调用**、或者在行为区里找自己的问题 ——
 *     界面上"东西都在"，只是放错了楼层；截图肉眼很难分辨谁对谁错。
 *   · `summarizeAgent()` 决定 Agent 头部那个「N 步 / 失败 N / 状态徽标」。
 *     失败数算成 0 的后果最严重：用户以为这一轮干净跑完了。
 *
 * 跑法：
 *   npm run verify:ai-zones
 */
import { zoneFor, summarizeAgent, type AiStreamKind } from "../../src/panels/aiZones.ts";

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

console.log("== zoneFor：谁去聊天区，谁去行为区 ==");
{
  const chat: AiStreamKind[] = ["user", "assistant"];
  const agent: AiStreamKind[] = ["system", "tool", "thinking", "notice", "note", "error", "diff"];
  for (const k of chat) check(`zoneFor(${k}) === thread`, zoneFor(k) === "thread", `实际 ${zoneFor(k)}`);
  for (const k of agent) check(`zoneFor(${k}) === agent`, zoneFor(k) === "agent", `实际 ${zoneFor(k)}`);
  check(
    "两个宿主都被覆盖到（不存在「只进不出」的分类）",
    new Set([...chat, ...agent].map((k) => zoneFor(k))).size === 2
  );
}

console.log("== summarizeAgent：步骤数 / 失败数 / 状态 ==");
{
  const empty = summarizeAgent([]);
  check("空列表 → 0 步", empty.steps === 0, JSON.stringify(empty));
  check("空列表 → 状态 idle", empty.state === "idle", JSON.stringify(empty));

  const three = summarizeAgent([
    { kind: "tool", ok: true },
    { kind: "tool", ok: true },
    { kind: "tool", ok: true }
  ]);
  check("3 个成功工具 → 3 步 / 0 失败", three.steps === 3 && three.failed === 0, JSON.stringify(three));
  check("3 个成功工具 → 状态 done", three.state === "done", JSON.stringify(three));

  const oneFailed = summarizeAgent([
    { kind: "tool", ok: true },
    { kind: "tool", ok: false },
    { kind: "tool", ok: true }
  ]);
  check("含一条失败 → failed=1（不许漏数）", oneFailed.failed === 1, JSON.stringify(oneFailed));
  check("含一条失败 → 状态 failed（要盖过 done）", oneFailed.state === "failed", JSON.stringify(oneFailed));

  const pending = summarizeAgent([{ kind: "tool", ok: true }, { kind: "tool" }]);
  check("末块未回执（无 ok）→ 状态 running", pending.state === "running", JSON.stringify(pending));

  const thinking = summarizeAgent([{ kind: "thinking" }]);
  check("只有思考块 → 也是 running（用户要知道它还在动）", thinking.state === "running", JSON.stringify(thinking));
  check("思考块不算工具步数", thinking.steps === 0, JSON.stringify(thinking));

  const busy = summarizeAgent([{ kind: "tool", ok: true }], { busy: true });
  check("busy 覆盖 done → running", busy.state === "running", JSON.stringify(busy));
}

console.log(`\n[verify-ai-zones] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
