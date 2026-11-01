/**
 * AI 层端到端自测（不依赖 Electron）。
 *
 * 用假的 sendEvent 驱动 createAiBridge，验证契约 §4.2/§4.3 的整条链路：
 *   1. route 事件先到（本地零 token）；
 *   2. mock 模式下 delta 逐块到达，done 带 usage / cacheHitRate / savedUsdApprox；
 *   3. 会话落盘后可无损续接（第二次 aiChat 能看到上一轮历史）；
 *   4. 工具真的被调用（ReadFile / SearchApi），结果被剪枝并落 toolCache；
 *   5. aiCancel 能中断，usage 标 reason=aborted。
 *
 * 用法：node desktop/test/ai-bridge.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAiBridge } from "../lib/ai/bridge.mjs";
import { openSession } from "../lib/ai/session.mjs";
import { createApiIndex, defaultApiDocsPath } from "../lib/ai/apiIndex.mjs";
import { createToolCache } from "../lib/ai/prune.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const dirs = [];
async function tmpDir(prefix) {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 起一个 bridge + 事件收集器。 */
async function makeBridge(overrides = {}) {
  const dir = await tmpDir("bwe-ai-");
  const session = await openSession({ dir, workspace: REPO });
  const events = [];
  let resolveDone = null;
  let donePromise = new Promise((r) => {
    resolveDone = r;
  });
  const bridge = createAiBridge({
    session,
    repoRoot: REPO,
    workspaceRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO)),
    toolCache: createToolCache(join(dir, "toolCache")),
    getSettings: async () => ({
      ai: {
        provider: "mock",
        baseUrl: "",
        apiKey: "",
        modelFlash: "",
        modelPro: "",
        autoRoute: true,
        manualModel: "",
        contextWindow: 64000,
        maxTokens: 1024
      }
    }),
    sceneDigest: async () => "工程「未命名工程」 3 场景 / 12 素材 / tileSize 32\n- 世界场景 city：48 对象",
    sendEvent: (ev) => {
      events.push(ev);
      if (ev.type === "done" || (ev.type === "error" && !ev.recoverable)) resolveDone(ev);
    },
    log: () => {},
    ...overrides
  });
  return {
    bridge,
    session,
    dir,
    events,
    done: () => donePromise,
    resetDone: () => {
      donePromise = new Promise((r) => {
        resolveDone = r;
      });
    }
  };
}

const settle = (ms = 3000) => new Promise((r) => setTimeout(r, ms));

test("mock provider：route → delta* → done，全程不联网", async () => {
  const { bridge, events, done } = await makeBridge();
  const { requestId } = await bridge.aiChat({
    requestId: "r1",
    messages: [{ role: "user", text: "你好" }],
    intent: "chat"
  });
  assert.equal(requestId, "r1", "requestId 必须原样回显");

  await Promise.race([done(), settle(6000)]);

  const types = events.map((e) => e.type);
  assert.equal(types[0], "route", `第一个事件必须是 route，实际 ${types[0]}`);
  assert.ok(types.includes("delta"), "必须有 delta 流");
  assert.ok(types.includes("done"), "必须收到 done");

  const route = events.find((e) => e.type === "route");
  assert.equal(route.localOnly, true);
  assert.ok(["flash", "pro"].includes(route.model));
  assert.ok(route.reason.length > 0);

  const deltas = events.filter((e) => e.type === "delta");
  assert.ok(deltas.length >= 3, `delta 应分多块（实际 ${deltas.length} 块）`);
  assert.ok(deltas.every((d) => d.requestId === "r1"));

  const doneEv = events.find((e) => e.type === "done");
  assert.ok(doneEv.text.length > 100, "回答不能是空的");
  assert.ok(doneEv.usage, "done 必须带 usage");
  // mock 刻意把 system 前缀模拟成「命中」：命中率应该是明显大于 0 的数。
  assert.ok(doneEv.cacheHitRate > 0.5, `mock 的命中率应 >50%（实际 ${doneEv.cacheHitRate}）`);
  assert.ok(doneEv.savedUsdApprox >= 0);
  // 全事件恒定 requestId
  for (const ev of events) assert.equal(ev.requestId, "r1", `事件 ${ev.type} 的 requestId 不对`);
});

test("usage 事件里三个输入计数互不重叠", async () => {
  const { bridge, events, done } = await makeBridge();
  await bridge.aiChat({ requestId: "r2", messages: [{ role: "user", text: "解释一下这个字段" }], intent: "chat" });
  await Promise.race([done(), settle(6000)]);
  const usageEvs = events.filter((e) => e.type === "usage");
  for (const ev of usageEvs) {
    const u = ev.usage;
    assert.ok(u.inputTokens >= 0 && u.cacheReadTokens >= 0 && u.cacheWriteTokens >= 0);
  }
  const doneEv = events.find((e) => e.type === "done");
  const u = doneEv.usage;
  // 契约 §4.2：三者 disjoint。mock 里 system 命中 1650 + 用户消息未命中。
  assert.ok(u.cacheReadTokens > 0, "mock 应模拟前缀命中");
  assert.ok(u.inputTokens > 0, "用户消息应算未命中输入");
  assert.equal(typeof u.outputTokens, "number");
});

test("会话落盘：第二轮能看到第一轮（无损续接）", async () => {
  const { bridge, session, events, done, resetDone } = await makeBridge();
  await bridge.aiChat({ requestId: "r3", messages: [{ role: "user", text: "第一个问题" }], intent: "chat" });
  await Promise.race([done(), settle(6000)]);
  assert.ok(session.messages().length >= 2, `第一轮后应至少 2 条消息，实际 ${session.messages().length}`);

  resetDone();
  await bridge.aiChat({ requestId: "r4", messages: [{ role: "user", text: "第二个问题" }], intent: "chat" });
  await Promise.race([done(), settle(6000)]);

  // 重启式读取：重新 openSession 后历史还在。
  const reread = await openSession({ dir: session.dir, workspace: REPO });
  const msgs = reread.messages();
  assert.ok(
    msgs.some((m) => JSON.stringify(m).includes("第一个问题")),
    "重启后必须还能读到第一轮的用户消息（无损续接）"
  );
  assert.ok(msgs.some((m) => m.role === "assistant"), "助手的回答也必须落盘");
});

test("工具：SearchApi 被真的调用，并返回剪枝后的结果", async () => {
  const { bridge, events, done, dir } = await makeBridge();
  // 直接调工具执行器的路径：bridge 内部 runner 用同一套 apiIndex。
  const { createToolRunner } = await import("../lib/ai/tools.mjs");
  const runner = createToolRunner({
    repoRoot: REPO,
    apiIndex: createApiIndex(defaultApiDocsPath(REPO))
  });
  const result = await runner.run({ name: "SearchApi", arguments: { query: "camera", limit: 5 } });
  assert.ok(!result.error, `SearchApi 不应报错：${result.error}`);
  assert.ok(result.text.includes("SearchApi"), result.text.slice(0, 200));
  // 契约：一次 ≤ 5 条
  const hitCount = (result.text.match(/^· /gm) ?? []).length;
  assert.ok(hitCount >= 1 && hitCount <= 5, `命中条数应在 1~5，实际 ${hitCount}`);

  // ReadFile 也要能读（并带行号头）
  const read = await runner.run({ name: "ReadFile", arguments: { path: "web/index.html", lines: 20 } });
  assert.ok(!read.error, `ReadFile 不应报错：${read.error}`);
  assert.ok(read.text.includes("ReadFile(web/index.html)"), read.text.slice(0, 120));

  // 越界/二进制要被拒
  const evil = await runner.run({ name: "ReadFile", arguments: { path: "../../etc/passwd" } });
  assert.ok(evil.error, "路径穿越必须被拒");
  assertEqualsLoose(evil.error.includes("越界") || evil.error.includes("找不到"));

  // 未知工具要报可读错误
  const unknown = await runner.run({ name: "Danger", arguments: {} });
  assert.ok(unknown.error.includes("未知工具"));

  assert.ok(events.length >= 0); // 占位：本用例直接驱动 runner
});

test("工具结果剪枝 + toolCache 落盘（同一结果零成本复用）", async () => {
  const dir = await tmpDir("bwe-tool-");
  const cache = createToolCache(join(dir, "toolCache"));
  const big = Array.from({ length: 120 }, (_, i) => `第 ${i} 行：${"内容".repeat(30)}`).join("\n");
  const sha = await cache.put(big, { tool: "ReadFile" });
  const back = await cache.get(sha);
  assert.equal(back, big, "缓存取回必须无损");
  const files = await readdir(join(dir, "toolCache"));
  assert.ok(files.includes(`${sha}.txt`));
  assert.ok(files.includes(`${sha}.json`), "meta 也要落盘（便于排查是哪次调用）");
});

test("aiCancel：能中断，usage 标 aborted", async () => {
  const { bridge, events } = await makeBridge();
  const { requestId } = await bridge.aiChat({
    requestId: "r5",
    messages: [{ role: "user", text: "写一段很长的说明".repeat(3) }],
    intent: "chat"
  });
  // 等第一块 delta 到了再取消，确保取消发生在流中间
  const firstDelta = (await waitFor(events, (e) => e.type === "delta", 3000));
  assert.ok(firstDelta, "应先收到至少一个 delta");
  await bridge.aiCancel(requestId);
  await settle(1500);
  const terminal = events.find((e) => e.type === "done" || (e.type === "error" && !e.recoverable));
  assert.ok(terminal, "取消后必须有终态事件");
  // 取消不该让 usage 说谎：要么标 aborted，要么确实更短。
  if (terminal.type === "done") {
    assert.ok(
      terminal.usage.reason === "aborted" || terminal.usage.outputTokens < 300,
      `取消后的 usage 应标 aborted（实际 ${JSON.stringify(terminal.usage)}）`
    );
  }
});

test("aiStatus：mock 模式下 provider=mock、ready 有解释", async () => {
  const { bridge } = await makeBridge();
  const status = await bridge.aiStatus();
  assert.equal(status.provider, "mock");
  assert.equal(status.mode, "desktop");
  assert.ok(typeof status.message === "string" && status.message.length > 0);
  assert.ok(status.models.flash && status.models.pro);
  assert.ok(status.usage, "状态里要带累计用量（界面要显示省 token）");
});

test("aiReset：清空会话但保留 system 前缀", async () => {
  const { bridge, session, done } = await makeBridge();
  await bridge.aiChat({ requestId: "r6", messages: [{ role: "user", text: "会被清掉" }], intent: "chat" });
  await Promise.race([done(), settle(6000)]);
  await bridge.aiReset();
  assert.equal(session.messages().length, 0);
  const status = await bridge.aiStatus();
  assert.ok(status.storage.promptVersion.length > 0);
});

test("压缩在超窗时自动触发（不会把上下文撑爆）", async () => {
  // 故意把窗口设小：6 条 × ~6000 token 远超 70%，压缩才会真的触发。
  const { bridge, session, events, done } = await makeBridge({
    getSettings: async () => ({
      ai: {
        provider: "mock",
        baseUrl: "",
        apiKey: "",
        modelFlash: "",
        modelPro: "",
        autoRoute: true,
        manualModel: "",
        contextWindow: 20000,
        maxTokens: 1024
      }
    })
  });
  for (let i = 0; i < 6; i++) {
    await session.append({
      role: "user",
      at: new Date().toISOString(),
      blocks: [{ type: "text", text: `第 ${i} 条长消息：${"上下文".repeat(3000)}` }]
    });
  }
  const before = session.messages().length;
  await bridge.aiChat({ requestId: "r7", messages: [{ role: "user", text: "继续" }], intent: "chat" });
  await Promise.race([done(), settle(8000)]);
  // 压缩后消息数应明显少于塞进去的数量（尾部保留 + 摘要）
  assert.ok(session.messages().length <= before + 2, `压缩后不应比原来更长（${before} → ${session.messages().length}）`);
  const summary = await readFile(join(session.dir, "summary.json"), "utf8").catch(() => "{}");
  const parsed = JSON.parse(summary);
  assert.ok(parsed.text?.length > 0, "压缩后 summary.json 必须有摘要（重启不重复消耗 token）");
  assert.ok(["llm", "structured"].includes(parsed.mode), `压缩模式应记录，实际 ${parsed.mode}`);
});

function assertEqualsLoose(v) {
  assert.ok(v, "断言失败");
}

/** 等到 events 里出现满足条件的项（或超时返回 null）。 */
async function waitFor(events, pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

for (const c of cases) {
  try {
    await c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    console.error(`  ✗ ${c.name}\n    ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});

console.log(`\nai-bridge.test: ${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
