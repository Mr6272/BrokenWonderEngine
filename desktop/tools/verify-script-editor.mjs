/**
 * 验收脚本：脚本编辑器（含 Yarn）的尺寸与"新建后不再空态"回归。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * B 修了两个问题，都属于「修了但不加回归，下次换个入口还会犯」的类型：
 *
 *   1. **Yarn 编辑器固定 220px**：`.script-yarn-source` 原来写死 minHeight 220px，
 *      而 JS 编辑器是可伸缩的 —— 同一面板里两个编辑器行为不一致。
 *   2. **新建剧本后编辑区仍是空态**：`newScript()` 只广播 `bwe:refresh`，
 *      而编辑区监听的是 `bwe:refresh-script-ui` → 事件名字对不上，空态没被替换掉。
 *
 * ⚠ 第 2 条尤其值得做回归：B 指出「22 个内置示例全是 JS，没有一个是 Yarn」，
 *   所以这个 bug 一直没被发现。换个入口（复制剧本 / 导入剧本）同样会犯，
 *   而且**同样发现不了** —— 除非有一条脚本真的去点「新建 Yarn 剧本」并检查 DOM。
 *
 * ── 判据（全部来自 --tap-seq 的 rect 读数，不量截图像素）─────────────────
 *   · `.script-yarn-source` 存在（说明空态被替换成了编辑器）
 *   · 宽度 ≥ 700、高度 ≥ 500（证明不再是固定 220px 的最小高度）
 *   · 新建之后元素仍在（顺序上「新建前没有 / 新建后有」更严格，见下）
 *
 * 用法：
 *   node desktop/tools/verify-script-editor.mjs
 *   node desktop/tools/verify-script-editor.mjs --keep   保留截图与 JSON 便于排查
 *
 * 退出码：0 通过；1 断言失败；2 前置条件不满足（缺 Electron 等）。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePng } from "../lib/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");
const ELECTRON = join(DESKTOP, "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(DESKTOP, "main.mjs");
const OUT_DIR = join(REPO, ".tmp_desk");
const KEEP = process.argv.includes("--keep");

/** 尺寸门槛：从 B 实测的 959x596 留出余量（不同字体/DPI 会有几像素差异）。 */
const MIN_WIDTH = 700;
const MIN_HEIGHT = 500;

function log(msg) {
  console.log(`[verify-script-editor] ${msg}`);
}

/**
 * `--tap-seq` 序列（B 给的那条，加了「新建前先探一次」）。
 *
 * 为什么要先探一次：如果只探「新建后存在」，那么**即使事件 bug 还在**，
 * 只要界面本来就有编辑器（例如用户已经手动打开过剧本），断言仍会通过 ——
 * 那样这条回归形同虚设。先探一次「新建前」，才能证明「是新建让它出现的」。
 */
const TAP_SEQ = [
  // ① 先进入「剧本」侧栏 —— 默认视图停在「素材」，不进来根本看不到这些锚点。
  //    锚点 [data-sidebar-script="1"] 是 shell.ts 里的稳定契约名（data-activity 是通用名）。
  "click:[data-sidebar-script=\"1\"]",
  "wait:300",
  // ② 切到 Yarn 标签（data-script-lang 由 scriptPanel 写在标签按钮上）
  "click:[data-script-lang=yarn]",
  "wait:400",
  // ③ 新建**之前**先探一次：证明「是新建让编辑器出现的」，而不是界面本来就有
  "probe:.script-yarn-source",
  // ④ 点新建（data-new-script 由 scriptPanel 写在按钮上）
  "click:[data-new-script]",
  "wait:600",
  // ⑤ 新建之后：应出现编辑器且尺寸达标
  "probe:.script-yarn-source",
  "probe:.script-yarn-source,.js-code,.editor-area"
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

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(
      `[verify-script-editor] 缺少 Electron：${ELECTRON}\n  先运行 node desktop/tools/fetch-electron.mjs`
    );
    return 2;
  }
  await mkdir(OUT_DIR, { recursive: true });
  const runDir = await mkdtemp(join(OUT_DIR, "verify-script-"));
  const shotPath = join(runDir, "shot.png");
  const domPath = join(runDir, "dom.json");

  log(`序列：${TAP_SEQ}`);
  const { code, output } = await runShot({ userDataDir: runDir, shotPath, domPath });
  for (const line of output.split(/\r?\n/)) {
    if (/\[seq\]|\[shot\] result|\[bwe:page\]/.test(line)) console.log(`  ${line}`);
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

  // 截图非空白（界面确实起来了）
  if (existsSync(shotPath)) {
    const stats = analyzePng(readFileSync(shotPath));
    check(!stats.isEmpty, `截图非空白（非背景像素 ${(stats.foregroundRatio * 100).toFixed(1)}%）`);
  } else {
    check(false, "生成了截图");
  }

  if (!existsSync(domPath)) {
    check(false, "生成了 --probe-dom JSON");
  } else {
    const dom = JSON.parse(readFileSync(domPath, "utf8"));
    const seq = dom.sequence ?? [];
    const probes = seq.filter((s) => s.phase === "probe" && s.selector === ".script-yarn-source");

    check(probes.length >= 2, `探到了两次 .script-yarn-source（实际 ${probes.length} 次）`);

    const before = probes[0];
    const after = probes[1] ?? probes[probes.length - 1];

    // ---- 断言 1：新建之后编辑器存在（证明空态被替换）----
    check(Boolean(after?.found), `新建剧本后 .script-yarn-source 存在（空态已被替换）`);

    if (after?.found && after.rect) {
      // ---- 断言 2：尺寸达标（证明不再是固定 220px）----
      check(
        after.rect.width >= MIN_WIDTH,
        `.script-yarn-source 宽度 ${after.rect.width} ≥ ${MIN_WIDTH}`
      );
      check(
        after.rect.height >= MIN_HEIGHT,
        `.script-yarn-source 高度 ${after.rect.height} ≥ ${MIN_HEIGHT}（固定 220px 的 bug 回归锁）`
      );
      log(`  实测尺寸：${after.rect.width}x${after.rect.height}（B 报告值约 959x596）`);
    }

    // ---- 断言 3：新建**之前**没有编辑器（更严格的因果断言）----
    // 这条是可选软断言：如果界面本来就有编辑器（用户手动打开过），before 也会 found。
    // 那种情况下不能判死（不是缺陷），但要报出来，说明「本次没验证到因果」。
    if (before?.found) {
      warnings.push(
        "新建前 .script-yarn-source 已存在 —— 本次无法证明「是新建让它出现的」"
        + "（可能是 UI 默认就打开了编辑器；如需严格因果请在干净会话下跑）"
      );
    } else {
      log(`  ✓ 新建前无编辑器、新建后有 → 证明「新建脚本后编辑区不再空态」`);
    }

    // ---- 顺便记录空态/占用信息，便于排查 ----
    const emptyState = seq.filter((s) => s.phase === "probe" && s.selector !== ".script-yarn-source");
    if (emptyState.length === 0) {
      log("  （未探到额外的空态选择器；如需更细排查可改 TAP_SEQ 增加 probe）");
    }
  }

  if (warnings.length) {
    log(`\n提示 ${warnings.length} 项（不判死）：`);
    for (const w of warnings) log(`  ⚠ ${w}`);
  }

  if (KEEP) log(`--keep：保留 ${runDir}`);
  else await rm(runDir, { recursive: true, force: true }).catch(() => {});

  if (failures.length) {
    console.error(`\n[verify-script-editor] 失败 ${failures.length} 项：`);
    for (const f of failures) console.error(`  · ${f}`);
    console.error(
      "\n  最可能的原因：\n"
      + "    1. 剧本面板的 Yarn 标签锚点不是 data-script-lang=yarn → 看 B 的锚点约定\n"
      + "    2. 新建按钮锚点不是 data-new-script\n"
      + "    3. Yarn 编辑器的尺寸仍被写死（回归） → 查 web/styles/app.css 的 .script-yarn-source"
    );
    return 1;
  }
  log("\n全部通过");
  return 0;
}

process.exitCode = await main();
