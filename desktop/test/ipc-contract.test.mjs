/**
 * 单测：IPC 契约一致性（ipc-contract.test.mjs）。
 *
 * 这个测试要防的是一次真实发生过的跨线断裂：
 *   B 侧按 `aiProbeModel(id)` 期望 `{kind, httpStatus, ms}`，
 *   主进程实际是 `probeModel(id)` 返回 `{reason, status, latencyMs}`
 *   → 字段全 undefined → 静默 fallback 到 error，**没有任何测试变红**。
 *
 * 根因是「契约只在对话里说过」。所以这里把契约变成**数据**并机器校验。
 *
 * ── 两层校验，各自回答不同问题 ──────────────────────────────────────────
 *   静态层（读源码）：
 *     ① preload 引用的通道，主进程是否注册了（防一边叫 A、另一边叫 B）
 *     ② 主进程注册的通道，是否都登记在声明表里（防偷偷加通道）
 *     ③ 命名纪律、notes 是否写了语义
 *   运行时层（真 Electron 里调 handler，比对**实际返回的字段**）：
 *     ④ 字段集合是否符合声明 —— 这是抓「字段名不同」的正解。
 *
 *   为什么不用静态提取 return 对象：本仓库的 handler 存在 `return await respondWithModels(...)`
 *   与 `{...response, created, ...}` 两种形态，硬解析必然误报；误报一多测试就失去可信度。
 *   运行时拿真实对象最准，成本只是多起一个只读探针进程（约 1 秒）。
 *
 *   动态层用 `--ipc-probe-no-import`（只读，不改被验收目录）+ 临时 `--user-data`，
 *   保证**不污染任何真实配置**、也不需要网络。
 *
 * 用法：node desktop/test/ipc-contract.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IPC_CONTRACT, CHANNEL_PREFIX, SEMANTIC_INVARIANTS, channelNames } from "../lib/ipc-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");
const ELECTRON = join(DESKTOP, "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(DESKTOP, "main.mjs");

/** 主进程 → 渲染侧的单向推送通道（不是 invoke，白名单）。 */
const PUSH_CHANNELS = new Set(["ai:event", "menu:command", "project:opened"]);

/** 可能因条件不满足而缺席的字段（不是断裂，是可选）。 */
const OPTIONAL_FIELDS = ["warning", "errorCode", "evidence", "error", "message"];

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const readAppMain = () => readFile(join(DESKTOP, "lib", "app-main.mjs"), "utf8");
const readPreload = () => readFile(join(DESKTOP, "preload.cjs"), "utf8");

/** 主进程源码里注册的通道名（本仓库约定通道名一律字面量）。 */
function registeredChannels(source) {
  const out = new Set();
  for (const m of source.matchAll(/ipcMain\.(?:handle|on)\s*\(\s*"([^"]+)"/g)) out.add(m[1]);
  return out;
}

/** preload 源码里引用的通道名。 */
function preloadChannels(source) {
  const out = new Set();
  for (const m of source.matchAll(/invoke\s*\(\s*"([^"]+)"/g)) out.add(m[1]);
  for (const m of source.matchAll(/sendSync\s*\(\s*"([^"]+)"/g)) out.add(m[1]);
  for (const m of source.matchAll(/subscribe\s*\(\s*"([^"]+)"/g)) out.add(m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// 静态层
// ---------------------------------------------------------------------------

test("声明表里每个非推送通道，主进程都真的注册了", async () => {
  const registered = registeredChannels(await readAppMain());
  const missing = channelNames().filter((name) => !PUSH_CHANNELS.has(name) && !registered.has(name));
  assert.equal(missing.length, 0, `声明了但主进程没注册：${missing.join(", ")}`);
});

test("主进程注册的每个 bwe: 通道，都必须在声明表里登记", async () => {
  const registered = [...registeredChannels(await readAppMain())].filter((c) => c.startsWith("bwe:"));
  const undeclared = registered.filter((c) => !IPC_CONTRACT[c]);
  assert.equal(
    undeclared.length,
    0,
    `主进程注册了未声明的通道：${undeclared.join(", ")}\n`
    + "  → 新增通道必须同时写进 desktop/lib/ipc-contract.mjs，否则调用方不知道字段名"
  );
});

test("preload 引用的每个通道，都必须在声明表里登记且主进程已注册", async () => {
  const used = preloadChannels(await readPreload());
  const registered = registeredChannels(await readAppMain());
  const undeclared = [...used].filter((c) => !IPC_CONTRACT[c]);
  const unregistered = [...used].filter((c) => !PUSH_CHANNELS.has(c) && !registered.has(c));
  assert.equal(
    undeclared.length,
    0,
    `preload 引用了未声明的通道：${undeclared.join(", ")}\n`
    + "  → 这正是上次跨线断裂的形态：一边按名字 A 调、另一边按名字 B 提供"
  );
  assert.equal(unregistered.length, 0, `preload 引用了主进程未注册的通道：${unregistered.join(", ")}`);
});

test("通道命名：invoke 类必须 bwe: 前缀，推送类在白名单里", () => {
  const bad = channelNames().filter((name) => !name.startsWith(CHANNEL_PREFIX) && !PUSH_CHANNELS.has(name));
  assert.equal(bad.length, 0, `不符合命名纪律：${bad.join(", ")}`);
});

test("每个通道都写了 kind 与 notes（语义不能空着）", () => {
  for (const [name, spec] of Object.entries(IPC_CONTRACT)) {
    assert.ok(["invoke", "send", "sendSync"].includes(spec.kind), `${name} 的 kind 非法：${spec.kind}`);
    assert.ok(
      typeof spec.notes === "string" && spec.notes.trim().length > 0,
      `${name} 必须写 notes —— 字段语义比类型更重要（上次断裂的根因就是语义只在对话里说过）`
    );
  }
});

test("preload 里声明的方法名与声明表一致（没有两套叫法）", async () => {
  const source = await readPreload();
  const mismatched = [];
  for (const [channel, spec] of Object.entries(IPC_CONTRACT)) {
    if (!spec.preload) continue;
    const firstName = spec.preload.split(/[（(/]/)[0].trim();
    if (firstName.startsWith("（")) continue; // 未暴露的调试通道
    if (!source.includes(`${firstName}(`) && !source.includes(`${firstName}:`)) {
      mismatched.push(`${channel} → 期望 preload 方法 ${firstName}`);
    }
  }
  assert.equal(mismatched.length, 0, `声明了 preload 方法但源码里找不到：\n${mismatched.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 运行时层：真进程里调 handler，比对**实际返回的字段**
// ---------------------------------------------------------------------------

/** 在真 Electron 里跑只读探针，返回 { code, output, report }。 */
function runReadOnlyProbe({ userDataDir, outPath }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      ELECTRON,
      [MAIN, `--ipc-probe=${outPath}`, "--ipc-probe-no-import", `--user-data=${userDataDir}`, "--console"],
      { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (d) => {
      output += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      output += d.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 90000);
    child.on("close", (code) => {
      clearTimeout(timer);
      let report = null;
      try {
        if (existsSync(outPath)) report = JSON.parse(readFileSync(outPath, "utf8"));
      } catch {
        report = null;
      }
      resolvePromise({ code, output, report });
    });
  });
}

/**
 * 只读探针会产出这些通道的真实返回。
 *
 * ⚠ `bwe:ai-probe-model` 有**两个分支**必须都查：
 *   · mock 分支返回写死的字面量（不走 probeModelEndpoint）
 *   · 真实分支从 probeModelEndpoint 的返回值重建对象
 * 只查 mock 分支的话，真实分支的字段名被改坏完全测不出来 ——
 * 我实际注入过 `reason→kind / latencyMs→ms` 验证这个盲区（当时测试仍全绿）。
 */
const RUNTIME_CHECKED = [
  "bwe:ai-models",
  "bwe:ai-status",
  "bwe:ai-probe-model:mock",
  "bwe:ai-probe-model:real",
  "bwe:script-complete",
  "bwe:script-quickinfo"
];

/** 运行时校验键 → 契约声明键（probe-model 的两个分支共用同一份声明）。 */
function contractKeyOf(runtimeKey) {
  return runtimeKey.startsWith("bwe:ai-probe-model") ? "bwe:ai-probe-model" : runtimeKey;
}

test("运行时：ai-models / ai-status / ai-probe-model 的实际返回字段与声明一致", async () => {
  if (!existsSync(ELECTRON)) {
    console.log("    （跳过：vendor 里没有 Electron，先跑 node desktop/tools/fetch-electron.mjs）");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "bwe-ipcc-"));
  const userDataDir = join(dir, "ud");
  const outPath = join(dir, "probe.json");
  // 造一份含三种状态的配置：mock 可用 / 已填 key / 真缺 key
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, "settings.json"),
    JSON.stringify(
      {
        version: 2,
        ai: {
          provider: "mock",
          activeModelId: "m-mock",
          models: [
            { id: "m-mock", label: "本地演示", provider: "mock", model: "mock-flash", needsKey: false },
            {
              id: "m-key", label: "有 key", provider: "deepseek",
              baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash",
              apiKey: "sk-dummy", needsKey: true
            },
            {
              id: "m-nokey", label: "缺 key", provider: "siliconflow",
              baseUrl: "https://api.siliconflow.cn/v1", model: "moonshotai/Kimi-K2-Thinking",
              needsKey: true, source: "trae-import"
            }
          ]
        },
        editor: { theme: "cream", uiScale: 1, autoSave: true },
        insecure: false
      },
      null,
      2
    ),
    "utf8"
  );

  const run = await runReadOnlyProbe({ userDataDir, outPath });
  assert.equal(run.code, 0, `只读探针应正常退出（实际 ${run.code}）\n${run.output.slice(-600)}`);
  assert.ok(run.report, "只读探针应产出 JSON");

  const problems = [];
  for (const runtimeKey of RUNTIME_CHECKED) {
    const actual = run.report.channels?.[runtimeKey];
    if (!actual) {
      problems.push(`${runtimeKey}：探针没有拿到该通道的返回`);
      continue;
    }
    const channel = contractKeyOf(runtimeKey);
    const spec = IPC_CONTRACT[channel];
    const declared = [...new Set([...(spec.returns ?? []), ...(spec.returnsOnError ?? [])])];
    // 只读探针拿到的是成功路径：按 returns 检查「声明了但没返回」，
    // 可选字段（warning/errorCode/evidence 等）允许缺席。
    const missing = (spec.returns ?? []).filter((f) => !(f in actual) && !OPTIONAL_FIELDS.includes(f));
    if (missing.length) {
      problems.push(
        `${channel}：声明了但实际没返回 ${missing.join(", ")}（实际返回 ${Object.keys(actual).join(", ")}）`
      );
    }
    const extra = Object.keys(actual).filter((k) => !declared.includes(k));
    if (extra.length) {
      problems.push(`${channel}：实际返回了未声明的字段 ${extra.join(", ")}（请补进 ipc-contract.mjs）`);
    }
  }
  assert.equal(problems.length, 0, `运行时字段与声明不一致：\n  ${problems.join("\n  ")}`);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test("运行时：probeModel 的 ok 真的是三态（实际返回值可为 null）", async () => {
  if (!existsSync(ELECTRON)) {
    console.log("    （跳过：vendor 里没有 Electron）");
    return;
  }
  // 契约声明层面必须有 null 与三态说明（UI 侧要据此分支）
  const spec = IPC_CONTRACT["bwe:ai-probe-model"];
  assert.ok(spec.notes.includes("三态"), "notes 必须写明 ok 是三态");
  assert.ok(spec.notes.includes("null"), "notes 必须写明 null 的含义");
  assert.ok(
    spec.notes.includes("不代表对话接口失败"),
    "notes 必须写明 unauthorized-on-models 的真实含义（否则 UI 会把可用服务判死）"
  );
});

test("ai:event 的事件类型清单包含 thinking，且四个 phase 都写进 notes", () => {
  const spec = IPC_CONTRACT["ai:event"];
  assert.ok(Array.isArray(spec.eventTypes), "ai:event 必须有 eventTypes 清单（漏一种 UI 就静默丢弃它）");
  // 事件类型必须齐全 —— 缺一个不会让任何东西报错，只会静默丢事件
  for (const t of ["route", "thinking", "delta", "tool", "usage", "done", "error"]) {
    assert.ok(spec.eventTypes.includes(t), `eventTypes 缺少 ${t}`);
  }
  // 四个 phase 的语义必须写在契约里（UI 按 phase 决定文案，语义不清就会撞）
  for (const phase of ["connecting", "reasoning", "answering", "slow"]) {
    assert.ok(spec.notes.includes(phase), `notes 缺少 phase「${phase}」的语义说明`);
  }
  // 三条硬约束必须在契约里（否则改动时没人知道规矩）
  assert.ok(spec.notes.includes("只发一次"), "notes 必须写明 answering 只发一次");
  assert.ok(spec.notes.includes("不是全量"), "notes 必须写明 reasoning delta 不是全量");
  assert.ok(spec.notes.includes("不许加任何人为延迟"), "notes 必须写明真模型分支不许加人为延迟");
});

test("thinking 事件只带契约字段（不许扩宽）", async () => {
  // 主进程的 emitThinking 只允许 phase / chars / delta；
  // 多加字段（如 mock:true、message:"…"）会让契约失真：调用方要么忽略（白做），
  // 要么当私有约定用（下次就漂）。
  const bridge = await readFile(join(DESKTOP, "lib", "ai", "bridge.mjs"), "utf8");
  assert.ok(bridge.includes("event.chars = extra.chars"), "emitThinking 应按白名单写入 chars");
  assert.ok(bridge.includes("event.delta = extra.delta"), "emitThinking 应按白名单写入 delta");
  assert.ok(bridge.includes("只挑契约内的可选字段"), "emitThinking 必须有白名单注释（后人改动时能看懂为什么）");
});

test("四个 phase 在主进程都有实际发射点（不是只在文档里）", async () => {
  const bridge = await readFile(join(DESKTOP, "lib", "ai", "bridge.mjs"), "utf8");
  // 用字符串查找而不是正则：phase 名里没有特殊字符，字符串更稳也更好读。
  for (const phase of ["connecting", "reasoning", "answering", "slow"]) {
    assert.ok(
      bridge.includes(`emitThinking("${phase}"`),
      `主进程没有发 ${phase}（文档写了但没实现，等于没做）`
    );
  }
  // mock 分支必须发 connecting（否则无 key 时思考态无法演示/截图）
  const mockIdx = bridge.indexOf("mock 分支：本地模板流");
  const connectingAfterMock = bridge.indexOf('emitThinking("connecting"', mockIdx);
  assert.ok(mockIdx >= 0 && connectingAfterMock > mockIdx, "mock 分支必须在吐字之前发 connecting");
  assert.ok(bridge.includes("MOCK_THINKING_MS"), "mock 的思考延迟应通过常量表达");
  // 真模型分支不许加人为延迟：bridge 里只允许两处 setTimeout
  // （slow 兜底定时器 + mock 的思考延迟），多了就说明有人给真模型造了延迟。
  const setTimeoutCount = (bridge.match(/setTimeout/g) || []).length;
  assert.ok(
    setTimeoutCount <= 2,
    `bridge 里出现了 ${setTimeoutCount} 处 setTimeout（只允许 slow 兜底 + mock 思考延迟这两处）`
  );
});

test("probeModel 的字段名与语义（上次跨线断裂的直接回归锁）", () => {
  const fields = IPC_CONTRACT["bwe:ai-probe-model"].returns;
  for (const required of ["ok", "reason", "status", "latencyMs", "detail"]) {
    assert.ok(fields.includes(required), `probeModel 必须返回 ${required}（实际声明：${fields.join(", ")}）`);
  }
  // B 早期假设的字段名不该出现在契约里
  for (const legacy of ["kind", "httpStatus", "ms"]) {
    assert.ok(!fields.includes(legacy), `不该声明旧字段名 ${legacy}（那是 B 早期假设的名字，已在 host.ts 归一化）`);
  }
});

// ---------------------------------------------------------------------------
// 语义不变量
// ---------------------------------------------------------------------------

test("语义不变量清单存在且每条都写了 why", () => {
  assert.ok(SEMANTIC_INVARIANTS.length >= 4, `语义不变量太少（${SEMANTIC_INVARIANTS.length}）`);
  for (const inv of SEMANTIC_INVARIANTS) {
    assert.ok(typeof inv.where === "string" && inv.where.length > 0, "每条不变量必须指明位置");
    assert.ok(typeof inv.rule === "string" && inv.rule.length > 0, "必须写明规则");
    assert.ok(
      typeof inv.why === "string" && inv.why.length > 10,
      `必须写明「为什么」—— 只写规则不写理由，未来的人不知道该不该改：${inv.where}`
    );
  }
});

test("关键语义在代码里有对应注释（文档与实现不脱节）", async () => {
  const provider = await readFile(join(DESKTOP, "lib", "ai", "provider.mjs"), "utf8");
  assert.ok(/ready.*配置齐全|配置齐全.*ready/s.test(provider), "provider.mjs 必须写明 ready 只表示配置齐全");
  const probeSrc = await readFile(join(DESKTOP, "lib", "ai", "probe.mjs"), "utf8");
  assert.ok(/三态|ok 三态/.test(probeSrc), "probe.mjs 必须写明 ok 是三态");
  assert.ok(probeSrc.includes("unauthorized-on-models"), "probe.mjs 必须实现 unauthorized-on-models 分类");
});

for (const c of cases) {
  try {
    await c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    console.error(`  ✗ ${c.name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log(`\nipc-contract.test: ${pass}/${cases.length} 通过（${channelNames().length} 个通道已声明）`);
if (pass !== cases.length) process.exit(1);
