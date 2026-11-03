/**
 * 项目知识库的**真实端到端验收**（真 Electron、真 bridge、真磁盘）。
 *
 * 单测证明了规则对（隔离/要点提取/坏行容错），但证明不了**接线**：
 *   主进程 knowledge → bridge persistRoundKnowledge → 渲染侧 context.project
 *   这条链路只要有一环没接上，表现就是「功能看起来存在、但每轮什么也没记」——
 *   不报错、不弹窗，用户永远发现不了。
 *
 * 本脚本验证七件事（每一条都是能独立失效的环节）：
 *   1. 知识库根被真的创建出来了（opts.knowledge 接上了）
 *   2. **跑完一轮对话后，rounds.jsonl 真的多了一条**（沉淀真的发生）
 *   3. 那条记录属于**当前工程**（context.project 真的传到主进程了）
 *   4. 记录里含结构化要点（不是空记录 —— 空记录等于没沉淀）
 *   5. **换一个工程后，记忆写到另一个目录**（项目隔离的核心）
 *   6. 前一个工程的目录**没有被后一个工程写入**（不会串）
 *   7. 面板用的 IPC 通道能读到这些数据（界面上真的看得见）
 *
 * 跑法：node desktop/tools/verify-knowledge.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ELECTRON = join(REPO, "desktop", "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(REPO, "desktop", "main.mjs");
const OUT = join(REPO, ".tmp_ai", "verify-knowledge");

let pass = 0;
let fail = 0;
function check(cond, name, detail) {
  if (typeof name !== "string") throw new TypeError(`断言名必须是字符串（参数顺序写反了？）：${String(name)}`);
  const okFlag = cond === true;
  if (okFlag) {
    pass++;
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * 端到端「对话清单」。
 *
 * ⚠ 这不是渲染侧脚本，而是交给**主进程**的 JSON（`--e2e-script` + `--e2e-main-ai`）：
 * AI bridge 在主进程里，验证「每轮沉淀」必须真的走 aiChat → run() → 第 6.5 步。
 * 在渲染侧硬造一条转发通路，测到的就不是用户真实走的那条链路了。
 *
 * 设计要点：四轮覆盖四种身份形态
 *   A1/A2 同名同路径（验证"每轮都沉淀"、且落在同一分片）
 *   B1    同名**不同路径**（验证"同名工程记忆不串"—— 这是本功能最容易做错的地方）
 *   C1    无磁盘路径（示例/未保存工程，验证退化成"按名字归档"仍可用）
 */
const ROUNDS_PLAN = {
  rounds: [
    {
      requestId: "kb-a-1",
      text: "把玩家的速度改快一点，用 PatchScript 改 player 脚本。",
      intent: "chat",
      project: { name: "知识库测试A", file: "D:/kbA/知识库测试A.bwproj" }
    },
    {
      requestId: "kb-a-2",
      text: "再检查一下碰撞体挂在哪个节点上。",
      intent: "chat",
      project: { name: "知识库测试A", file: "D:\\kbA\\知识库测试A.bwproj" } // 同路径不同写法：应仍是同一分片
    },
    {
      requestId: "kb-b-1",
      text: "这个工程的敌人巡逻逻辑有问题。",
      intent: "chat",
      project: { name: "知识库测试A", file: "E:/kbB/知识库测试A.bwproj" } // 同名不同路径
    },
    {
      requestId: "kb-c-1",
      text: "示例工程里没有磁盘路径，看看能不能记住。",
      intent: "chat",
      project: { name: "示例工程C" } // 无路径
    }
  ]
};

function runElectron({ userDataDir, e2eScript, e2eOut }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      ELECTRON,
      [
        MAIN,
        `--user-data=${userDataDir}`,
        `--e2e-script=${e2eScript}`,
        `--e2e-out=${e2eOut}`,
        "--e2e-main-ai",
        "--console"
      ],
      { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString("utf8")));
    child.stderr.on("data", (d) => (output += d.toString("utf8")));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 180000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

/** 读一个目录下所有 rounds.jsonl 里的记录（按目录分片）。 */
function readAllRoundFiles(knowledgeRoot) {
  if (!existsSync(knowledgeRoot)) return [];
  const out = [];
  for (const e of readdirSync(knowledgeRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = join(knowledgeRoot, e.name, "rounds.jsonl");
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    const records = [];
    for (const l of lines) {
      try {
        records.push(JSON.parse(l));
      } catch {
        // 坏行跳过（与实现一致）
      }
    }
    out.push({ key: e.name, records, file });
  }
  return out;
}

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(`[verify-knowledge] 缺少 Electron：${ELECTRON}\n  先运行 node desktop/tools/fetch-electron.mjs`);
    return 2;
  }
  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const userDataDir = await mkdtemp(join(tmpdir(), "bwe-kb-e2e-"));
  const scriptFile = join(OUT, `probe-${stamp}.txt`);
  const outFile = join(OUT, `out-${stamp}.json`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(scriptFile, JSON.stringify(ROUNDS_PLAN, null, 2), "utf8");

  console.log("== 项目知识库端到端（真 Electron / 真磁盘）==");
  const { code, output } = await runElectron({ userDataDir, e2eScript: scriptFile, e2eOut: outFile });
  check(code === 0, `进程正常退出（exit=${code}）`);

  const knowledgeRoot = join(userDataDir, "knowledge");
  check(existsSync(knowledgeRoot), "知识库根目录被创建（opts.knowledge 真的接上了）", knowledgeRoot);

  // ---- 检查磁盘上的沉淀结果 ----
  const all = readAllRoundFiles(knowledgeRoot);
  const total = all.reduce((n, d) => n + d.records.length, 0);
  check(total >= 4, `四轮对话至少沉淀 4 条记录（每轮一条），实际 ${total}`, `目录 ${all.length} 个`);
  check(all.length >= 3, `至少 3 个项目分片（A / A-不同路径 / C），实际 ${all.length}`, all.map((d) => d.key).join(" | "));

  // 每个工程各自记到了对应的诉求
  const byKey = new Map(all.map((d) => [d.key, d.records]));
  console.log("  [目录] " + all.map((d) => `${d.key}=${d.records.length}条`).join(" · "));

  check(
    all.some((d) => d.records.some((r) => JSON.stringify(r).includes("把玩家的速度改快一点"))),
    "★ 记录里含第 1 轮的诉求（沉淀真的拿到了对话内容）"
  );
  // 「同一工程的两轮落在同一分片」——必须验证**那个分片里有 2 条**，
  // 不能只说"某处有 1 条"（那种写法无论实现好坏都会绿，等于没测）。
  const aShard = all.filter((d) =>
    d.records.some((r) => (r.points ?? []).join("\n").includes("速度改快"))
  );
  check(
    aShard.length === 1,
    `★ 工程 A 的所有轮次都在**同一个**分片（实际分片数 ${aShard.length}）`
  );
  check(
    (aShard[0]?.records.length ?? 0) === 2,
    `★ 该分片里应有 2 轮（A1+A2），实际 ${aShard[0]?.records.length ?? 0}`
  );

  // ---- 项目隔离（最重要）----
  const aKeys = all.filter((d) => d.records.some((r) => JSON.stringify(r).includes("改快一点"))).map((d) => d.key);
  const bKeys = all.filter((d) => d.records.some((r) => JSON.stringify(r).includes("敌人巡逻"))).map((d) => d.key);
  const cKeys = all.filter((d) => d.records.some((r) => JSON.stringify(r).includes("示例工程里没有磁盘路径"))).map((d) => d.key);

  check(aKeys.length === 1, `工程 A 的记忆只落在一个目录（实际 ${aKeys.length} 个：${aKeys.join(",")}）`);
  check(bKeys.length === 1, `工程 B（同名不同路径）的记忆只落在一个目录（实际 ${bKeys.length} 个）`);
  check(cKeys.length === 1, `工程 C（无路径）的记忆只落在一个目录（实际 ${cKeys.length} 个）`);
  check(
    aKeys[0] !== bKeys[0],
    "★★ 同名不同路径的两个工程 → **不同目录**（记忆绝不串）",
    `A=${aKeys[0]} vs B=${bKeys[0]}`
  );
  check(
    cKeys[0] !== aKeys[0] && cKeys[0] !== bKeys[0],
    "无路径工程也是独立目录",
    `C=${cKeys[0]}`
  );
  // 交叉污染检查：A 的目录里不能出现 B 的诉求，反之亦然
  const aRecords = byKey.get(aKeys[0]) ?? [];
  const bRecords = byKey.get(bKeys[0]) ?? [];
  check(!aRecords.some((r) => JSON.stringify(r).includes("敌人巡逻")), "★ A 的目录里没有 B 的内容（没有串记忆）");
  check(!bRecords.some((r) => JSON.stringify(r).includes("改快一点")), "★ B 的目录里没有 A 的内容（没有串记忆）");

  // ---- 要点质量 ----
  const anyRecord = all.flatMap((d) => d.records).find((r) => (r.points ?? []).length > 0);
  check(Boolean(anyRecord), "沉淀记录里含**结构化要点**（不是空记录）", anyRecord ? `${anyRecord.points.length} 条` : "");
  if (anyRecord) {
    check(
      anyRecord.points.some((p) => p.startsWith("诉求：")),
      "要点里含「诉求：」（这一轮做了什么被记下来了）",
      anyRecord.points[0]
    );
    check(
      typeof anyRecord.summary === "string" && anyRecord.summary.length > 0,
      "每条记录都有一句话概括（列表页要用）",
      anyRecord.summary
    );
    check(Boolean(anyRecord.project?.name), "记录里带工程身份快照（可追溯）", anyRecord.project?.name);
  }

  // digest.md 也要生成（用户能直接打开看）
  const digests = all.map((d) => join(knowledgeRoot, d.key, "digest.md")).filter((f) => existsSync(f));
  check(digests.length >= 1, `digest.md 已生成（人可读版）`, `${digests.length} 份`);

  // ---- IPC 面板通道 ----
  if (existsSync(outFile)) {
    const data = JSON.parse(readFileSync(outFile, "utf8"));
    const list = data.knowledge?.list ?? [];
    check(Array.isArray(list), "knowledgeList 返回项目列表（面板能列出来）", `根：${data.knowledge?.root ?? "?"}`);
    check(list.length >= 3, `knowledgeList 列出 ≥3 个项目，实际 ${list.length}`, list.map((p) => `${p.name}#${p.key.split("-").pop()}`).join(" · "));
    check(Boolean(data.knowledge?.root), "knowledgeList 返回知识库根路径（用户能打开文件夹）");
    const failed = (data.steps ?? []).filter((s) => !s.ok);
    check(
      failed.length === 0,
      `四轮对话全部正常完成（失败 ${failed.length}）`,
      failed.map((f) => f.tag + ":" + f.error).join(" | ")
    );
    // 列表里的计数必须与磁盘一致（否则面板显示的数字是假的）
    const listCount = list.reduce((n, p) => n + (Number(p.roundCount) || 0), 0);
    check(
      listCount === total,
      `列表里的 roundCount 合计 == 磁盘上的记录数（${listCount} == ${total}）`
    );
  } else {
    check(false, "生成端到端结果 JSON");
    console.log(output.slice(-2500));
  }

  console.log(`\n证据目录：${OUT}\nuserData：${userDataDir}`);
  return summarise();
}

function summarise() {
  console.log(`\nverify-knowledge: ${pass}/${pass + fail} 通过`);
  return fail === 0 ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
