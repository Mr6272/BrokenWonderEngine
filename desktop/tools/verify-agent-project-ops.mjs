#!/usr/bin/env node
/**
 * 「AI 能改工程里任意东西」的**真实端到端验收**（真 Electron / 真 store / 真撤销栈）。
 *
 * ── 为什么必须有这一层 ──────────────────────────────────────────────
 * `verify-project-ops-ext` 证明"规则对"（263 条纯函数断言），但它证明不了**接线**：
 *   主进程 → executeJavaScript → `__BWE__.runScriptTool` → `runProjectTool`
 *   → `applyAiProject` → `store.replaceProjectData` → 画布/面板重画 → 撤销栈
 * 本仓库历史上最反复的缺陷形态就是「工具描述承诺了能力、某条路径下根本没接线」，
 * 而它只在端到端里现形，表现是「AI 说改好了，界面没变」。
 *
 * 本次就靠它抓到两个纯函数测试**永远抓不到**的真 bug：
 *   ① `resetHistoryIfProjectReplaced` 把 AI 的每一步改动都立刻清出撤销栈
 *      → 「AI 改完了，Ctrl+Z 什么也没发生」（而且是静默的）；
 *   ② `dryRun` 在 schema 里声明了很久，整条链路没有一处读过它
 *      → 模型以为在试探，改动真的落地了。
 *
 * 跑法：
 *   node desktop/tools/verify-agent-project-ops.mjs
 * 退出码：0 通过；1 断言失败；2 前置条件不满足。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ELECTRON = join(REPO, "desktop", "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(REPO, "desktop", "main.mjs");
const PROBE = join(HERE, "probes", "agent-project-ops.probe.js");
const OUT = join(REPO, ".tmp_jseditor", "agent-ops");

let pass = 0;
let fail = 0;

function check(cond, name, detail) {
  if (typeof name !== "string") throw new TypeError(`断言名必须是字符串：${String(name)}`);
  const okFlag = cond === true;
  if (okFlag) {
    pass++;
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function runElectron({ userDataDir, probeOut }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      ELECTRON,
      [MAIN, "--size=1600x1000", `--user-data=${userDataDir}`, `--e2e-script=${PROBE}`, `--e2e-out=${probeOut}`, "--console"],
      { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString("utf8")));
    child.stderr.on("data", (d) => (output += d.toString("utf8")));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 超时兜底 */
      }
    }, 180000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(`[verify-agent-project-ops] 缺少 Electron：${ELECTRON}`);
    return 2;
  }
  if (!existsSync(PROBE)) {
    console.error(`[verify-agent-project-ops] 缺少探针：${PROBE}`);
    return 2;
  }
  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const userDataDir = join(OUT, `ud-${stamp}`);
  const probeOut = join(OUT, `out-${stamp}.json`);

  console.log("== AI 改工程端到端（真 Electron / 真 store / 真撤销栈）==");
  const { code, output } = await runElectron({ userDataDir, probeOut });
  check(code === 0, `Electron 正常退出（exit=${code}）`);
  if (!existsSync(probeOut)) {
    check(false, "生成了端到端结果 JSON");
    console.log(output.slice(-2000));
    return finish();
  }
  let d;
  try {
    d = JSON.parse(readFileSync(probeOut, "utf8"));
  } catch (e) {
    check(false, "结果 JSON 可解析", String(e));
    return finish();
  }

  // ---- ① 接线前提 ----
  check(d.hasBridge === true, "渲染侧有 __BWE__");
  check(d.hasRunTool === true, "★ __BWE__.runScriptTool 存在（主进程转发的前提）");
  check(d.hasEditor === true, "编辑器实例存在");
  check(typeof d.projectName === "string" && d.projectName.length > 0, `工程已载入（${d.projectName}）`);

  // ---- ② digest 能读，且新字段可见 ----
  check(d.digestOk === true, "★ ProjectDigest 读得到真实工程");
  const has = d.digestHas ?? {};
  for (const [key, label] of [
    ["tileSize", "tileSize"],
    ["masterVolume", "工程音量"],
    ["orientation", "打包方向"],
    ["layersVisible", "图层可见性"],
    ["sceneScript", "场景脚本"],
    ["packs", "规则包"],
    ["animMode", "动画参数"],
  ]) {
    check(has[key] === true, `digest 文本里能看到「${label}」（看不见就改不动）`);
  }

  // ---- ③ updateProject 真的落到 store ----
  check(d.apply1Error === null, "ApplyProjectOps 改工程级字段未报错", String(d.apply1Text ?? "").slice(0, 120));
  check(d.storeName === "端到端改名", "★ store 里的工程名真的变了（独立核对，不看工具自己的说法）", String(d.storeName));
  check(d.storeTileSize === 48, "★ store 里的 tileSize 真的变了", String(d.storeTileSize));
  check(d.storeVolume === 0.5, "★ store 里的 masterVolume 真的变了", String(d.storeVolume));
  check(d.storeOrientation === "portrait", "★ store 里的 orientation 真的变了", String(d.storeOrientation));
  check(d.projectRefChanged === true, "换的是新工程引用（事务性要求）");

  // ---- ④ 场景级 + 对象级 ----
  check(d.sceneWidth === 44 && d.sceneHeight === 33, "★ 场景尺寸真的改了（原来只能在建场景时设）", `${d.sceneWidth}x${d.sceneHeight}`);
  check(d.sceneOriginX === 5, "★ 场景 originX 真的改了", String(d.sceneOriginX));
  check((d.objCountAfter ?? 0) === (d.objCountBefore ?? 0) + 1, "★ 对象真的加进去了", `${d.objCountBefore} → ${d.objCountAfter}`);
  check(d.newObjAnim?.animMode === "loop" && d.newObjAnim?.animFps === 6, "★ 新对象能一次带全动画参数（原来根本设不了）", JSON.stringify(d.newObjAnim));
  check(d.sceneNameUnchanged === true, "没让改的字段保持原值");

  // ---- ⑤ 撤销（本次抓到的真 bug 的回归锁）----
  check(d.hasUndo === true, "编辑器有 undo");
  check((d.undoStackDepth ?? 0) >= 2, "★ AI 的改动真的进了撤销栈（深度 ≥ 2）", `depth=${d.undoStackDepth}`);
  check(d.undoRevertedScene === true, "★ 撤销一步退回了场景改动", JSON.stringify(d.undoOnce));
  check(d.undoWorked === true, "★ 再撤一步退回了工程名 —— 多步撤销可用", `undoTwiceName=${d.undoTwiceName}`);
  check(d.multiStepUndo === true, "★ 能一路撤到最初状态（回归锁：曾经每次 AI 改完栈就被清空）", `now=${d.undoTwiceName} 最初=${d.beforeName}`);

  // ---- ⑥ dryRun ----
  check(d.dryRunSaysTrial === true, "★ dryRun 返回「试运行」口径的文本", String(d.dryRunText ?? "").slice(0, 100));
  check(d.dryRunChangedStore === false, "★ dryRun 时工程一字节不变（回归锁：曾经声明了但没人实现）");
  check(d.dryRunName !== "试运行不该落地的名字", "dryRun 的名字没有被写进工程", String(d.dryRunName));

  // ---- ⑦ 整批事务 ----
  check(d.badRejected === true, "★ 非法批次被整批拒绝", String(d.badText ?? "").slice(0, 120));
  check(d.badBatchUnchanged === true, "★ 被拒时工程一字节不变（同批次的合法项也没落地）");
  check(d.lastSceneRejected === true, "★ 删除最后一个场景被拒（删空保护）", String(d.lastSceneText ?? "").slice(0, 100));

  return finish();
}

function finish() {
  console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==`);
  return fail === 0 ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
});
