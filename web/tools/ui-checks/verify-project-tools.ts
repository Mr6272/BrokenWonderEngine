
/**
 * 端到端：模型的一次工具调用 → tools.mjs 的运行器 → scriptRunner → 真工程里的改动。
 *
 * 前面 verify-project-ops 验的是 projectOps 本身。这条验的是**接线**：
 * 名字有没有接上、派发有没有走到、错误有没有如实回传。
 * 两者都必须存在 —— projectOps 再正确，接不上模型就是一个没人调用的模块。
 */
import assert from "node:assert/strict";
import { createProject } from "../../../web/src/core/model.ts";
import { runProjectTool } from "../../../web/src/core/projectOps.ts";
import { createToolRunner, PROJECT_TOOLS, TOOL_NAMES } from "../../../desktop/lib/ai/tools.mjs";

let pass = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); pass += 1; };
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); pass += 1; };

/**
 * 渲染侧执行器的**真实逻辑**：直接调 editor.runScriptTool 用的那个纯函数。
 * 不写替身 —— 替身只能证明我自己写的替身是对的。
 */
function makeHost(project: any) {
  let current: any = project;
  const calls: string[] = [];
  const scriptRunner = async (name: string, args: any) => {
    calls.push(name);
    const out = runProjectTool(name, args, current);
    if (out.kind === "applied") current = out.project;
    if (out.kind === "rejected") return { error: out.error, text: out.text, meta: out.meta };
    return { text: out.text, meta: out.meta };
  };
  return { scriptRunner, get: () => current, calls };
}

const host = makeHost(createProject());
const runner = createToolRunner({ repoRoot: process.cwd(), scriptRunner: host.scriptRunner });

// 1. 名字真的进了目录，且模型看得见
ok(TOOL_NAMES.includes("ProjectDigest"), "ProjectDigest 必须在 TOOL_NAMES 里");
ok(TOOL_NAMES.includes("ApplyProjectOps"), "ApplyProjectOps 必须在 TOOL_NAMES 里");
eq(PROJECT_TOOLS, ["ProjectDigest", "ApplyProjectOps"], "PROJECT_TOOLS 清单");
const names = runner.definitions.map((d: any) => d.function.name);
ok(names.includes("ApplyProjectOps"), "定义里必须有 ApplyProjectOps，否则模型根本不会调用它");
const def = runner.definitions.find((d: any) => d.function.name === "ApplyProjectOps");
ok(def.function.parameters.required.includes("ops"), "schema 必须要求 ops");

// 2. 真实走一遍：读摘要 → 按摘要里的名字搭关卡 → 再读摘要确认
const digest1 = await runner.run({ name: "ProjectDigest", arguments: {} });
ok(!digest1.error, "ProjectDigest 不该报错");
ok(digest1.text.includes("== 场景 =="), "摘要必须包含场景清单");
ok(digest1.text.includes("== 可用模块"), "摘要必须列出可用模块，否则模型只能瞎编 defId");

const sceneName = host.get().scenes[0].name;
const applied = await runner.run({
  name: "ApplyProjectOps",
  arguments: {
    ops: [
      { op: "createScene", scene: { name: "关卡-1", widthTiles: 20, heightTiles: 16 } },
      { op: "addObjects", sceneName: "关卡-1", objects: [
        { name: "守卫A", kind: "ACTOR", x: 2, y: 2 },
        { name: "守卫B", kind: "ACTOR", x: 6, y: 2 },
      ]},
    ],
  },
});
ok(!applied.error, `改造不应失败：${applied.error}`);
ok(applied.text.includes("已应用"), "必须回报应用了几处改动");

const after = host.get();
const lvl = after.scenes.find((s: any) => s.name === "关卡-1");
ok(!!lvl, "工程里必须真的多出一个「关卡-1」");
eq(lvl.objects.length, 2, "「关卡-1」里必须真的有两个对象");
ok(host.calls.includes("ApplyProjectOps"), "执行器必须真的被调到");

// 3. 非法操作必须整批拒，且工程不变 —— 顺着接线验一遍
const before = JSON.stringify(host.get());
const bad = await runner.run({
  name: "ApplyProjectOps",
  arguments: { ops: [
    { op: "addObjects", sceneName: "关卡-1", objects: [{ name: "好的", kind: "ACTOR", x: 1, y: 1 }] },
    { op: "addObjects", sceneName: "关卡-1", objects: [{ name: "坏的", kind: "NOT_A_KIND", x: 1, y: 1 }] },
  ]},
});
ok(!!bad.error, "非法批次必须报错");
ok(bad.text.includes("工程未改动"), "必须明说工程没动，不能让模型以为部分成功");
eq(JSON.stringify(host.get()), before, "整批被拒后工程必须逐字节不变");

// 4. 参数形状不对，也要在门口挡住
const shape = await runner.run({ name: "ApplyProjectOps", arguments: { ops: "not-an-array" } });
ok(!!shape.error, "ops 不是数组必须报错");

// 5. 未接线时必须明说，而不是假装成功
const bare = createToolRunner({ repoRoot: process.cwd() });
const unwired = await bare.run({ name: "ApplyProjectOps", arguments: { ops: [] } });
ok(!!unwired.error, "没有渲染侧执行器时必须报错");
ok(unwired.text.includes("未接线"), "必须明说未接线，不能让模型以为改好了");

console.log(`PASS   ${pass} 项断言全部通过`);
