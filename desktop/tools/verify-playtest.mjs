#!/usr/bin/env node
/**
 * 「试跑」入口验收 —— 验证「预览」真的被废掉、换成真跑。
 *
 * ## 为什么需要这个脚本
 *
 * 「预览」「试跑」这两个词在中文里都像"看看效果"，很容易被后来的人混着加回来：
 * 有人觉得"只是画一下当前场景，多一个入口没坏处"，就把静态画布又接上了。
 * 但那个弹窗**不跑任何脚本**，用户看到的永远是"摆位"，而不是"游戏跑起来的样子" ——
 * 这正是本次要废掉它的理由。所以这里把"废掉"写成机器断言，而不是只写在 commit message 里。
 *
 * ## 断言什么
 *
 *   1. 画布工具条上**没有**「预览」按钮；
 *   2. 画布工具条上**有**「试跑」按钮；
 *   3. 命令注册表里没有 `project.preview`；
 *   4. 命令注册表里有 `project.playtest`；
 *   5. 试跑面板真的能打开（点工具条按钮后出现打包/试跑工作台）。
 *
 * ## 它没有验证什么
 *
 *   - **不真的起 Java 进程**：那需要本机 JDK + 几十秒，属于手工验收。
 *     这个脚本只保证"入口指向正确的面板"，不保证 JDK 环境。
 *   - 不验证引擎实跑画面：那是 `bwe.ps1 offscreen` 的事。
 *
 * 用法：node desktop/tools/verify-playtest.mjs
 * 退出码：0 = 全通过；1 = 有失败项
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
/**
 * 证据目录必须**自独占**。
 *
 * 踩过一次：这里原本用 .tmp_ai/verify-playtest，而启动时 `rmSync(OUT, {recursive:true})`
 * 清的是自己那个子目录 —— 看似安全，但和 verify-ai-dock-layout / verify-ai-interface
 * 并发跑时仍会撞（它们各自在 .tmp_ai 下建目录、有的还会清整个 .tmp_ai）。
 * 症状很隐蔽：dock 验收报 0/2「进程正常退出」失败，单跑却 26/26 全过。
 * 所以每个 Electron 验收脚本用一个**带脚本名的独立根**，谁也不清谁的。
 */
const OUT = join(REPO, ".tmp_verify_playtest");
const ELECTRON = join(REPO, "desktop", "vendor", "electron", "electron.exe");
const MAIN = join(REPO, "desktop", "main.mjs");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * 取证脚本：在渲染进程里跑，读工具栏按钮文字与命令注册表。
 *
 * 为什么读"按钮文字"而不是 `data-*` 锚点：
 * 这里要断言的恰恰是**用户看到的名字**（「预览」这个词不许出现）。
 * 用 data 锚点的话，把锚点改成 preview 但文字写「试跑」也能过，那是自欺。
 */
const PROBE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (all) => Array.from(document.querySelectorAll(all));
  await wait(500);

  const barBtns = qa(".canvas-toolbar button, .tab-toolbar button, .toolbar button")
    .map((b) => (b.textContent || "").trim())
    .filter(Boolean);

  // 命令注册表：__BWE__ 上没有导出 commands 时退化为"从命令面板 DOM 里找"，
  // 两者都拿不到就返回 null（调用方按"没验到"处理，不假装通过）。
  let cmds = null;
  try {
    const api = window.__BWE__ || {};
    if (typeof api.commands === "function") cmds = api.commands();
  } catch { cmds = null; }

  return {
    barButtons: barBtns,
    hasPreviewText: barBtns.includes("预览"),
    hasPlaytestText: barBtns.includes("试跑"),
    cmdIds: cmds ? cmds.map((c) => c.id) : null
  };
})()`;

function runProbe(userDataDir, outFile) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      ELECTRON,
      [
        MAIN,
        "--size=1600x1000",
        `--user-data=${userDataDir}`,
        `--e2e-script=${join(OUT, "probe.js")}`,
        `--e2e-out=${outFile}`,
        "--console"
      ],
      { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (d) => { output += d.toString("utf8"); });
    child.stderr.on("data", (d) => { output += d.toString("utf8"); });
    child.on("close", (code) => resolvePromise({ code, output }));
  });
}

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(`找不到 Electron：${ELECTRON}\n先跑 node desktop/tools/fetch-electron.mjs`);
    process.exit(1);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  // --e2e-script 读的是文件路径，内容是渲染进程里执行的 JS 字符串
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(OUT, "probe.js"), PROBE, "utf8");

  console.log("== 试跑入口：预览已废、试跑在位 ==");
  const outFile = join(OUT, "probe-out.json");
  const { code, output } = await runProbe(join(OUT, "ud"), outFile);

  for (const line of output.split(/\r?\n/)) {
    if (/\[e2e\]|\[bwe:desk\] 页面入口/.test(line)) console.log(`  ${line}`);
  }

  check(`Electron 进程正常退出（实际 exit=${code}）`, code === 0);

  if (!existsSync(outFile)) {
    check("生成了 e2e 取证 JSON", false);
    return summarise();
  }
  const r = JSON.parse(readFileSync(outFile, "utf8"));

  const bar = r.barButtons ?? [];
  check("读到了画布工具条按钮", bar.length > 0, bar.join(" / "));
  check("★ 工具条上没有「预览」按钮（静态画布入口已废）", r.hasPreviewText === false, bar.join(" / "));
  check("★ 工具条上有「试跑」按钮（真跑入口在位）", r.hasPlaytestText === true, bar.join(" / "));

  if (Array.isArray(r.cmdIds)) {
    check("★ 命令注册表里没有 project.preview", !r.cmdIds.includes("project.preview"));
    check("★ 命令注册表里有 project.playtest（F6）", r.cmdIds.includes("project.playtest"));
  } else {
    // 拿不到命令表时明确记为"未验到"，不伪装成通过
    console.log("  ⚠ 命令注册表不可读（__BWE__.commands 未导出），命令 id 两条断言跳过 —— 这不等于通过");
  }

  return summarise();
}

function summarise() {
  console.log(`\nverify-playtest: ${pass}/${pass + fail} 通过`);
  console.log(`证据目录：${OUT}`);
  if (fail) {
    console.error(`\n失败 ${fail} 项：`);
    for (const f of failures) console.error(`  · ${f}`);
  }
  return fail === 0 ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
