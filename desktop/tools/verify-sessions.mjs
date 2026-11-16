/**
 * 验收脚本：会话列表 UI（可复跑）。
 *
 * ── 为什么必须做成脚本 ──────────────────────────────────────────────────
 * 会话数据原本只在 `.shot-profile/<pid>` 里累积，每次运行 pid 都不同，
 * 于是「验证会话 UI」这件事**依赖上一次运行恰好留下过会话**：
 * 换台机器、换个人、清一次 profile，验证方法就失效。
 *
 * **不可复跑的验收等于没有验收** —— 所以本脚本的核心不是"点几下看看"，
 * 而是**自己造一份确定的预置数据**：两个会话、标题/条数/时间都写死，
 * 跑完临时目录即删。任何人任何机器跑一次都得到同样结论。
 *
 * ── 预置数据（脚本内生成，不依赖任何历史残留）──────────────────────────
 *   会话 A：title「重构玩家移动逻辑」，2 条消息，updatedAt 较旧
 *   会话 B：title「排查掉帧问题」，    4 条消息，updatedAt 较新
 *   active = B（列表按 updatedAt 降序，"刚才那个"在最上）
 *
 * ── 断言（每一条都能证伪一个具体缺陷）───────────────────────────────────
 *   1. 列表里**正好 2 个**会话 —— 多一个说明读了残留；少一个说明预置没生效
 *   2. 顺序是「排查掉帧问题」在上、「重构玩家移动逻辑」在下（按 updatedAt 降序）
 *   3. 副标题含正确条数（`4 条` / `2 条`）—— 证明 messageCount 真的透到了 UI
 *   4. 点**非 active** 的 A 后，对话区渲染出 A 的消息
 *      （点 active 会话不会有任何变化，那样的断言等于没测）
 *
 * 退出码：0 通过 / 1 断言失败 / 2 前置条件不满足（缺 Electron 等）。
 *
 * 用法：
 *   node desktop/tools/verify-sessions.mjs
 *   node desktop/tools/verify-sessions.mjs --keep    保留截图与 JSON 便于排查
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePng } from "../lib/png.mjs";
import { workspaceHash } from "../lib/ai/session.mjs";
import { CONVERSATIONS_DIR, INDEX_FILE } from "../lib/ai/conversations.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");
const ELECTRON = join(DESKTOP, "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(DESKTOP, "main.mjs");
const OUT_DIR = join(REPO, ".tmp_desk");
const KEEP = process.argv.includes("--keep");

const log = (m) => console.log(`[verify-sessions] ${m}`);

// ---------------------------------------------------------------------------
// 预置数据（写死，保证每次跑结论相同）
// ---------------------------------------------------------------------------

/** A：较旧的会话，2 条消息。 */
const SESSION_A = {
  id: "c_verifyA_000001",
  title: "重构玩家移动逻辑",
  // 用固定时间而不是 Date.now()：让断言可复现，也避免排序受"跑的时刻"影响
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-02T09:00:00.000Z",
  messages: [
    { role: "user", text: "帮我重构一下玩家移动的逻辑", at: "2026-01-02T08:59:00.000Z" },
    { role: "assistant", text: "建议拆出 MoveController，把输入与位移解耦。", at: "2026-01-02T09:00:00.000Z" }
  ]
};

/** B：较新的会话，4 条消息（列表里应排在最上、显示「4 条」）。 */
const SESSION_B = {
  id: "c_verifyB_000002",
  title: "排查掉帧问题",
  createdAt: "2026-01-03T10:00:00.000Z",
  updatedAt: "2026-01-04T11:00:00.000Z",
  messages: [
    { role: "user", text: "为什么跑起来掉帧", at: "2026-01-04T10:50:00.000Z" },
    { role: "assistant", text: "先看每帧的渲染耗时与物理 tick 是否超预算。", at: "2026-01-04T10:55:00.000Z" },
    { role: "user", text: "渲染耗时看起来正常", at: "2026-01-04T10:58:00.000Z" },
    { role: "assistant", text: "那再看场景图重建次数，可能是每帧都在重建。", at: "2026-01-04T11:00:00.000Z" }
  ]
};

/** 把一条预置消息转成 session.mjs 落盘的格式。 */
function toMessage(m, index) {
  return {
    id: `m_verify${index}`,
    role: m.role,
    at: m.at,
    blocks: [{ type: "text", text: m.text }]
  };
}

/** 往 userData 里写一份确定的会话存储（模拟"这个人以前聊过这两段"）。 */
async function seedConversations(userDataDir) {
  const sessionRoot = join(userDataDir, "sessions", workspaceHash(REPO));
  const convRoot = join(sessionRoot, CONVERSATIONS_DIR);
  await mkdir(convRoot, { recursive: true });

  for (const sess of [SESSION_A, SESSION_B]) {
    const convDir = join(convRoot, sess.id);
    await mkdir(convDir, { recursive: true });
    await writeFile(
      join(convDir, "history.json"),
      JSON.stringify(
        {
          version: 1,
          promptVersion: "",
          createdAt: sess.createdAt,
          messages: sess.messages.map(toMessage)
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(convDir, "summary.json"),
      JSON.stringify({ text: "", coveredMessages: 0, usage: null, updatedAt: null }, null, 2),
      "utf8"
    );
  }

  // index.json：sessions 顺序即为 UI 渲染依据之一，但**排序断言要看 updatedAt 降序**，
  // 所以这里故意按"较旧在前"写，让"UI 是否真的按 updatedAt 降序"成为被验证的行为，
  // 而不是靠 index 顺序碰巧对上（否则这条断言就测不出排序逻辑）。
  await writeFile(
    join(sessionRoot, INDEX_FILE),
    JSON.stringify(
      {
        version: 1,
        active: SESSION_B.id,
        sessions: [
          {
            id: SESSION_A.id,
            title: SESSION_A.title,
            createdAt: SESSION_A.createdAt,
            updatedAt: SESSION_A.updatedAt,
            messageCount: SESSION_A.messages.length,
            modelId: ""
          },
          {
            id: SESSION_B.id,
            title: SESSION_B.title,
            createdAt: SESSION_B.createdAt,
            updatedAt: SESSION_B.updatedAt,
            messageCount: SESSION_B.messages.length,
            modelId: ""
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  return { sessionRoot };
}

/**
 * `--tap-seq` 序列。
 *
 * 点的是**非 active** 的 A —— 只有切到非当前会话，才能证明"切换真的换了内容"。
 */
const TAP_SEQ = [
  // ① 打开 AI 面板 = 进入 AI 界面（二轮起 AI 是独立工作面，不是右侧窄栏）
  "click:[data-panel-tab=ai]",
  // ② 等历史栏把会话列表拉回来。
  //    二轮把会话历史从浮层升级成**左侧常驻栏**，所以这里不再需要点 [data-ai-sessions]：
  //    点了反而会去点一个 page 布局下不存在的按钮。等它异步 load 完即可。
  "wait:900",
  // ③ 读列表：行 / 标题 / 副标题都读**全部**匹配项（`*`），顺序可断言
  "probe:.ai-session-row*,.ai-session-title*,.ai-session-sub*",
  // ④ 点 A 那一行（用 A 的 id 精确点，不靠"第几个"这种位置假设）
  `click:[data-ai-session-pick="${SESSION_A.id}"]`,
  "wait:600",
  // ⑤ 读切换后的对话区：容器 + 消息节点
  "probe:.ai-thread,.ai-msg*"
].join("; ");

function runShot({ userDataDir, shotPath, domPath }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      ELECTRON,
      [
        MAIN,
        `--shot=${shotPath}`,
        "--size=1600x1000",
        `--user-data=${userDataDir}`,
        `--probe-dom=${domPath}`,
        `--tap-seq=${TAP_SEQ}`,
        "--console"
      ],
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
    }, 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(
      `[verify-sessions] 缺少 Electron：${ELECTRON}\n  先运行 node desktop/tools/fetch-electron.mjs`
    );
    return 2;
  }
  await mkdir(OUT_DIR, { recursive: true });
  const runDir = await mkdtemp(join(OUT_DIR, "verify-sessions-"));
  const shotPath = join(runDir, "shot.png");
  const domPath = join(runDir, "dom.json");
  const userDataDir = join(runDir, "ud");

  await seedConversations(userDataDir);
  log(`预置数据 → ${userDataDir}`);
  log(`   A「${SESSION_A.title}」${SESSION_A.messages.length} 条 · updatedAt ${SESSION_A.updatedAt}`);
  log(`   B「${SESSION_B.title}」${SESSION_B.messages.length} 条 · updatedAt ${SESSION_B.updatedAt}`);
  log(`   active = B · index 顺序故意是 A 在前（让「按 updatedAt 降序」成为被测行为）`);

  const { code, output } = await runShot({ userDataDir, shotPath, domPath });
  for (const line of output.split(/\r?\n/)) {
    if (/\[seq\]|\[bwe:page\]/.test(line)) console.log(`  ${line}`);
  }

  const failures = [];
  const warnings = [];
  const check = (cond, msg) => {
    if (cond) log(`  ✓ ${msg}`);
    else {
      log(`  ✗ ${msg}`);
      failures.push(msg);
    }
  };

  check(code === 0, `截图进程正常退出（实际 exit=${code}）`);

  if (existsSync(shotPath)) {
    const stats = analyzePng(readFileSync(shotPath));
    check(!stats.isEmpty, `截图非空白（非背景像素 ${(stats.foregroundRatio * 100).toFixed(1)}%）`);
  } else {
    check(false, "生成了截图");
  }

  if (!existsSync(domPath)) {
    check(false, "生成了 --probe-dom JSON");
    return finish(runDir, failures, warnings);
  }

  const dom = JSON.parse(readFileSync(domPath, "utf8"));
  const seq = dom.sequence ?? [];
  /** 取某选择器用 `*` 探到的全部记录（按 index 排序）。 */
  const probeAll = (sel) => seq
    .filter((x) => x.phase === "probe" && x.selector === sel && x.found)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  // ---- 断言 1：正好 2 个会话（不是靠残留、也不是预置没生效）----
  const rows = probeAll(".ai-session-row");
  check(
    rows.length === 2,
    `列表里正好 2 个会话（实际 ${rows.length} 个）—— 多一个说明读了历史残留，少一个说明预置没生效`
  );

  // ---- 断言 2：顺序按 updatedAt 降序（B 在前、A 在后）----
  const titles = probeAll(".ai-session-title");
  check(titles.length === 2, `读到 2 个标题（实际 ${titles.length}）`);
  if (titles.length === 2) {
    check(
      titles[0].text.includes("排查掉帧问题"),
      `第 1 行（"刚才那个"）是「排查掉帧问题」（实际「${titles[0].text}」）`
    );
    check(
      titles[1].text.includes("重构玩家移动逻辑"),
      `第 2 行是「重构玩家移动逻辑」（实际「${titles[1].text}」）`
    );
  }

  // ---- 断言 3：副标题带正确条数（证明 messageCount 真的透到了 UI）----
  const subs = probeAll(".ai-session-sub");
  check(subs.length === 2, `读到 2 个副标题（实际 ${subs.length}）`);
  if (subs.length === 2) {
    // 副标题格式见 sessionSubtitle：`${messageCount} 条` 或 `${messageCount} 条 · 相对时间`
    check(subs[0].text.includes("4 条"), `第 1 行副标题含「4 条」（B 有 4 条消息，实际「${subs[0].text}」）`);
    check(subs[1].text.includes("2 条"), `第 2 行副标题含「2 条」（A 有 2 条消息，实际「${subs[1].text}」）`);
  }

  // ---- 断言 4：点非 active 的 A 后，对话区渲染出 A 的消息 ----
  const threads = seq.filter((x) => x.phase === "probe" && x.selector === ".ai-thread" && x.found);
  const threadText = threads.map((t) => t.text ?? "").join(" ");
  const msgs = probeAll(".ai-msg");
  check(msgs.length >= 2, `对话区有消息节点（A 有 2 条消息，实际 ${msgs.length} 个节点）`);

  const msgText = msgs.map((m) => m.text ?? "").join(" ");
  check(
    msgText.includes("重构一下玩家移动")
      || msgText.includes("MoveController")
      || threadText.includes("重构一下玩家移动"),
    `切换后显示 A 的消息（消息节点：${msgText.slice(0, 120) || "空"}；容器：${threadText.slice(0, 80) || "空"}）`
  );
  check(
    !msgText.includes("掉帧") && !threadText.includes("掉帧"),
    "对话区已切换（不再显示 B 的消息，说明内容被替换而不是追加）"
  );

  return finish(runDir, failures, warnings);
}

async function finish(runDir, failures, warnings) {
  if (KEEP) log(`--keep：保留 ${runDir}`);
  else await rm(runDir, { recursive: true, force: true }).catch(() => {});

  if (warnings.length) {
    log(`\n提示 ${warnings.length} 项（不判死）：`);
    for (const w of warnings) log(`  ⚠ ${w}`);
  }
  if (failures.length) {
    console.error(`\n[verify-sessions] 失败 ${failures.length} 项：`);
    for (const f of failures) console.error(`  · ${f}`);
    console.error(
      "\n  最可能的原因：\n"
      + "    1. 历史栏没渲染或没自动加载（data-ai-history / .ai-history-list .ai-session-row）→ 看 aiSessions.ts 的 renderSessionSidebar\n"
      + "    2. 会话行锚点不是 [data-ai-session-pick=<id>] / 行类名不是 .ai-session-row\n"
      + "    3. 列表未按 updatedAt 降序（主进程应发毫秒数字，见 toEpochMs）\n"
      + "    4. 副标题格式不是「N 条 · 时间」（见 sessionSubtitle）\n"
      + "    5. 切换后消息没渲染（看 aiPanel.ts 的 replaceThreadFromMessages）"
    );
    return 1;
  }
  log("\n全部通过");
  return 0;
}

process.exitCode = await main();
