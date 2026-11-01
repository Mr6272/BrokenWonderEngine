/**
 * 验收脚本：模型切换功能**真的可用**的机器可验证证据。
 *
 * 为什么需要这个脚本（而单测不够）：
 *   单测证明了「数据层正确」（清单、按 id 解析、key 加密），但证明不了
 *   **「真实 settings 里的模型清单，真的渲染到了编辑器的下拉框里」**。
 *   这条链要穿过：settings.json → 主进程 IPC → preload → 渲染侧 → DOM。
 *   任何一环断了，截图看起来都"正常"（面板还在，只是下拉框是空的）。
 *
 * 做法（真实闭环，不是注入假数据）：
 *   1. 造一个临时目录，写一份**真实的 settings.json**（含 mock + 需填 key + 已就绪 三条模型）；
 *   2. 用 `--user-data=<该目录>` 真实启动编辑器（非隔离模式，读的就是这份配置）；
 *   3. `--tap` 打开 AI 面板，`--probe-dom` 读下拉框里的 option 数量与文本；
 *   4. 断言：option 数 = 3、needsKey 那条的文本含「key」提示、已就绪那条存在。
 *
 * 为什么用 `--user-data` 而不是 pid 隔离目录：
 *   隔离目录里 settings 永远是空的，那样测的就不是"真实配置"而是"空配置"——
 *   正是 Lead 指出的「绕过而不是覆盖」。
 *
 * 退出码：0 通过；1 断言失败；2 前置条件不满足（vendor 缺失 / 截图机制本身失败）。
 *
 * 用法：
 *   node desktop/tools/verify-models.mjs
 *   node desktop/tools/verify-models.mjs --keep    # 保留临时目录便于排查
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePng, assertTheme } from "../lib/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");
const ELECTRON = join(DESKTOP, "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(DESKTOP, "main.mjs");
const OUT_DIR = join(REPO, ".tmp_desk");

const KEEP = process.argv.includes("--keep");

function log(msg) {
  console.log(`[verify-models] ${msg}`);
}

/**
 * 造一份真实的 settings.json。
 *
 * 三条模型刻意覆盖三种状态，因为 UI 要能区分它们：
 *   · local-demo   → mock，ready:true（不需要 key，永远可用）
 *   · ds-ready     → 有 key（这里用一个假 key，只为验证"填了 key 显示为就绪"这条 UI 逻辑；
 *                    它不会真发请求，截图不消耗额度）
 *   · sf-needs-key → 无 key、needsKey，应显示为"需要填 key"
 */
async function writeSettings(dir) {
  const settings = {
    version: 2,
    ai: {
      provider: "mock",
      baseUrl: "",
      apiKey: "",
      modelFlash: "",
      modelPro: "",
      autoRoute: true,
      manualModel: "",
      activeModelId: "local-demo",
      models: [
        {
          id: "local-demo",
          label: "本地演示（mock）",
          provider: "mock",
          baseUrl: "",
          model: "mock-flash",
          contextWindow: 128000,
          maxTokens: 4096,
          needsKey: false,
          source: "manual",
          notes: "验收用：无需 key"
        },
        {
          id: "ds-ready",
          label: "DeepSeek 官方 Flash",
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          // 明文 key：这个脚本是"造配置"的一方，模拟用户已经在界面里填过。
          // 主进程读取时会保留明文（首次迁移场景允许），落盘加密发生在界面写入时；
          // 这里只关心 UI 是否把它显示为"已就绪"。
          apiKey: "sk-acceptance-dummy-key",
          contextWindow: 128000,
          maxTokens: 4096,
          needsKey: true,
          source: "manual",
          notes: "验收用：已有 key"
        },
        {
          id: "sf-needs-key",
          label: "moonshotai/Kimi-K2-Thinking",
          provider: "siliconflow",
          baseUrl: "https://api.siliconflow.cn/v1",
          model: "moonshotai/Kimi-K2-Thinking",
          contextWindow: 128000,
          maxTokens: 4096,
          needsKey: true,
          source: "trae-import",
          notes: "从 Trae 导入；API Key 需手动填写"
        }
      ]
    },
    editor: { theme: "cream", uiScale: 1, autoSave: true },
    insecure: false
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
  return settings;
}

/**
 * 只跑 --ipc-probe（不开窗口 / 不截图），用于读 ai-models 的**字段**而不是 DOM 文本。
 *
 * 为什么不复用 runShot：那条路要开窗口、跑渲染，慢且引入无关变量；
 * 字段语义是纯主进程数据，直接问主进程最干净。
 */
function runIpcProbeOnly({ userDataDir, outPath }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // ⚠ 带 --ipc-probe-no-import：只读模式。
    // 不带的话探针会执行 Trae 导入并写入 settings，把被验收的目录从 3 条模型变成 5 条 ——
    // 验收数据被自己污染，断言「有 3 条」就会失败（实际踩到过）。
    const child = spawn(
      ELECTRON,
      [MAIN, `--ipc-probe=${outPath}`, "--ipc-probe-no-import", `--user-data=${userDataDir}`, "--console"],
      {
      cwd: REPO,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
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

/** 跑一次截图（带 --user-data / --tap / --probe-dom）。 */
function runShot({ userDataDir, shotPath, domPath, size = "1600x1000" }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // 本环境常带这个，会让 electron 退化成纯 node
    const args = [
      MAIN,
      `--shot=${shotPath}`,
      `--size=${size}`,
      `--user-data=${userDataDir}`,
      "--tap=[data-panel-tab=ai]",
      `--probe-dom=${domPath}`,
      "--console"
    ];
    const child = spawn(ELECTRON, args, {
      cwd: REPO,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
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

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(
      `[verify-models] 缺少 Electron：${ELECTRON}\n  先运行 node desktop/tools/fetch-electron.mjs（离线重建 vendor）`
    );
    return 2;
  }
  await mkdir(OUT_DIR, { recursive: true });

  // 临时 userData：放在 .tmp_desk 下（受 gitignore 保护），便于 --keep 时排查。
  //
  // ⚠ 所有产物路径都带 mkdtemp 的唯一后缀，**不用固定文件名**：
  //   实测过一次「verify-models 与 package.mjs --verify 同时跑」导致截图/PDF 互相覆盖
  //   （两者都写 .tmp_desk 下的固定文件名），表现为「上次全绿、这次突然失败」的假红。
  //   验收脚本经常被并发跑（CI 多任务、人工边跑边看），固定路径必然互踩。
  const runDir = await mkdtemp(join(OUT_DIR, "verify-models-"));
  const userDataDir = runDir;
  const shotPath = join(runDir, "shot.png");
  const domPath = join(runDir, "dom.json");
  await rm(shotPath, { force: true });
  await rm(domPath, { force: true });

  log(`临时 userData：${userDataDir}`);
  const settings = await writeSettings(userDataDir);
  log(`已写入 settings.json：${settings.ai.models.length} 条模型`);

  const { code, output } = await runShot({ userDataDir, shotPath, domPath });
  // 把关键行转出来，失败时用户能直接看到原因
  for (const line of output.split(/\r?\n/)) {
    if (/\[bwe:desk\]|\[tap\]|\[dom\]|\[shot\]|\[probe\]|\[bwe:page\]/.test(line)) console.log(`  ${line}`);
  }

  const failures = [];
  const warnings = [];
  /**
   * 软断言：不判死，但必须显式报出来（避免被"全绿"掩盖跨线未完成）。
   * 为什么软硬分开：本脚本验证的是「主进程 → 数据」这条链（A 线归我）；
   * 文案归 B 线，B 未接好时不该让 A 线的验收变红，但也不能假装没问题。
   */
  const warn = (message) => {
    log(`  ⚠ ${message}`);
    warnings.push(message);
  };
  let checksRun = 0;
  const check = (cond, message) => {
    checksRun += 1;
    if (cond) log(`  ✓ ${message}`);
    else {
      log(`  ✗ ${message}`);
      failures.push(message);
    }
  };

  // ---- 断言 1：进程正常退出（截图机制本身没坏）----
  check(code === 0, `截图进程正常退出（实际 exit=${code}）`);

  // ---- 断言 2：截图不是空白、主题是奶油（UI 真的起来了）----
  if (!existsSync(shotPath)) {
    check(false, "生成了截图文件");
  } else {
    const stats = analyzePng(readFileSync(shotPath));
    const theme = assertTheme(stats);
    check(!stats.isEmpty, `截图非空白（非背景像素 ${(stats.foregroundRatio * 100).toFixed(1)}%）`);
    check(theme.ok, `主题为奶油（主色 ${stats.background}）`);
  }

  // ---- 断言 3：读到了真实 settings（不是空配置）----
  check(
    output.includes("来自 --user-data，非隔离模式"),
    "启动日志确认使用了 --user-data（非隔离模式）"
  );

  // ---- 断言 4：DOM 探针真的读到了模型下拉框 ----
  if (!existsSync(domPath)) {
    check(false, "生成了 DOM 探针 JSON");
  } else {
    const dom = JSON.parse(readFileSync(domPath, "utf8"));
    check(dom.aiPanelPresent === true, `AI 面板存在（tap 生效）`);
    check(dom.modelSelectFound === true, `找到模型下拉框（来源：${dom.modelSelect?.source ?? "?"}）`);
    check(
      dom.modelSelect?.optionCount === settings.ai.models.length,
      `下拉框有 ${settings.ai.models.length} 条模型（实际 ${dom.modelSelect?.optionCount ?? 0}）`
    );

    const optionTexts = (dom.modelSelect?.options ?? []).map((o) => `${o.value}|${o.text}`);
    const optionByValue = new Map((dom.modelSelect?.options ?? []).map((o) => [o.value, o.text]));

    // 需求里最关键的一条：**真的缺 key** 的条目必须显示「需要填 key」这类提示。
    const needsKeyEntry = settings.ai.models.find((m) => m.id === "sf-needs-key");
    const needsKeyText = optionByValue.get("sf-needs-key") ?? "";
    check(
      needsKeyEntry && /key|密钥|需填|未配置/i.test(needsKeyText),
      `真的缺 key 的条目带了提示（实际文本：${needsKeyText}）`
    );

    // 反向断言（抓 UI 语义误报）：**已经有 key 的条目不该被标成「需要填 key」**。
    // 这条对应一个真实缺陷：`needsKey` 表示"供应商类型是否需要 key"，
    // 若 UI 直接拿它判断，会把已填 key 的 deepseek 也标成"需要填 key"。
    // 主进程已提供语义正确的 `needsKeyMissing`，UI 改用它即可。
    //
    // 注意：这里做成**软断言**（记 warning 不判死），原因：
    //   本脚本验证的是「主进程 → 数据」这条链（它归 A 线），
    //   UI 文案归 B 线。B 未接好时不该让 A 线的验收脚本变红 ——
    //   但必须把它显式报出来，否则这个缺陷会被"全绿"掩盖。
    const readyEntryText = optionByValue.get("ds-ready") ?? "";
    const uiMislabeled = /需要填 key|需填密钥/i.test(readyEntryText);
    if (uiMislabeled) {
      warn(
        `UI 把已有 key 的条目误标成「需要填 key」（文本：${readyEntryText}）`
        + " → B 线应改用主进程返回的 needsKeyMissing 字段判断"
      );
    } else {
      log(`  ✓ 已有 key 的条目未被误标为「需要填 key」`);
    }

    // 已就绪的条目应当出现在列表里（至少 mock 那条）
    const hasMock = optionTexts.some((t) => t.includes("mock") || t.includes("本地"));
    check(hasMock, "「本地演示」条目出现在下拉框里");
  }

  // ---- 断言 5：**字段语义**（不只验 UI 文本）----
  //
  // 为什么必须有这一条：上一轮抓到的 bug 是「已填 key 的模型被标成需要填 key」。
  // 如果只验 UI 文本，那么把 needsKeyMissing 与 hasApiKey **两个字段接反**、
  // 或者两者都恒为 true（UI 恰好都显示"需要填"）时，文本可能照样"看起来对"。
  // 所以这里直接读主进程返回的字段，验它们的**组合是否符合语义**。
  //
  // 数据源用 ai-models（走 --ipc-probe 一次性取），而不是 DOM 文本 ——
  // DOM 是下游消费者，用它反推上游字段会在中间多一层无法诊断的模糊。
  const modelsProbePath = join(runDir, "ipc.json");
  await rm(modelsProbePath, { force: true });
  const ipc = await runIpcProbeOnly({ userDataDir, outPath: modelsProbePath });
  check(ipc.code === 0, `ai-models 探测进程正常退出（实际 exit=${ipc.code}）`);

  if (!existsSync(modelsProbePath)) {
    check(false, "生成了 ai-models 字段探测 JSON");
  } else {
    const report = JSON.parse(readFileSync(modelsProbePath, "utf8"));
    const listed = report.channels?.["bwe:ai-models"];
    check(listed?.ok === true, "ai-models 通道返回 ok");
    const byId = new Map((listed?.models ?? []).map((m) => [m.id, m]));
    check(byId.size === settings.ai.models.length, `ai-models 返回 ${settings.ai.models.length} 条（实际 ${byId.size}）`);

    // 逐条验「字段组合是否符合语义」：
    //   · 已填 key（ds-ready）：hasApiKey=true 且 needsKeyMissing=false 且 ready=true
    //   · 真缺 key（sf-needs-key）：hasApiKey=false 且 needsKeyMissing=true 且 ready=false
    //   · mock：needsKey=false 且 needsKeyMissing=false 且 ready=true
    const expect = [
      { id: "ds-ready", hasApiKey: true, needsKeyMissing: false, ready: true, why: "已填 key" },
      { id: "sf-needs-key", hasApiKey: false, needsKeyMissing: true, ready: false, why: "真缺 key" },
      { id: "local-demo", hasApiKey: false, needsKeyMissing: false, ready: true, why: "mock 不需要 key" }
    ];
    for (const e of expect) {
      const actual = byId.get(e.id);
      if (!actual) {
        check(false, `ai-models 里存在 ${e.id}（${e.why}）`);
        continue;
      }
      const ok =
        actual.hasApiKey === e.hasApiKey
        && actual.needsKeyMissing === e.needsKeyMissing
        && actual.ready === e.ready;
      check(
        ok,
        `${e.id}（${e.why}）：hasApiKey=${actual.hasApiKey} needsKeyMissing=${actual.needsKeyMissing} `
        + `ready=${actual.ready}（期望 ${e.hasApiKey}/${e.needsKeyMissing}/${e.ready}）`
      );
    }

    // 语义关系不变量：needsKeyMissing 必须等价于 (needsKey && !hasApiKey)。
    // 这条是"两个字段接反"的直接防线 —— 比逐条比对更根本。
    for (const m of listed?.models ?? []) {
      const derived = Boolean(m.needsKey) && !m.hasApiKey;
      check(
        Boolean(m.needsKeyMissing) === derived,
        `${m.id} 的 needsKeyMissing(=${m.needsKeyMissing}) 与 (needsKey && !hasApiKey)(=${derived}) 一致`
      );
    }

    // `ready` 的语义边界：它只表示"配置齐全"，不表示连通性 —— 所以有 key 的条目才是 ready。
    // 断言"没有 key 的条目绝不 ready"，防止有人把 ready 改成"总是 true"来"修好"UI 提示。
    for (const m of listed?.models ?? []) {
      if (m.needsKey && !m.hasApiKey) {
        check(m.ready === false, `${m.id} 没有 key 时不得 ready（防止把 ready 恒置 true）`);
      }
    }
  }

  // ---- 收尾 ----
  if (KEEP) {
    log(`--keep：保留临时目录 ${runDir}（截图与 DOM 探针也在这里）`);
  } else {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    log("已清理临时目录");
  }

  if (warnings.length) {
    console.log(`\n[verify-models] 提示 ${warnings.length} 项（不判死，但需要 B 线处理）：`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }

  if (failures.length) {
    console.error(`[verify-models] 失败 ${failures.length} 项：`);
    for (const f of failures) console.error(`  · ${f}`);
    console.error(
      "\n  最可能的原因（按概率排）：\n"
      + "    1. UI 侧还没把模型清单接进下拉框（B 线未完成）→ 检查 ai-panel 里有没有 select\n"
      + "    2. 下拉框没有可识别的锚点 → 建议 B 加 data-model-select 属性\n"
      + "    3. --user-data 的 settings 没被读到 → 看启动日志里的 userData 路径"
    );
    return 1;
  }
  log(
    `\n全部通过（${checksRun} 项断言${warnings.length ? `，另有 ${warnings.length} 项提示需 B 线处理` : ""}）`
  );
  return 0;
}

process.exitCode = await main();
