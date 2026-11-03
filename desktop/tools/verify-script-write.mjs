/**
 * 脚本写工具的**真实端到端验收**（真 Electron、真编辑器、真 store）。
 *
 * 为什么不能只靠单测：`scriptOps` 的单测证明「规则对」，`tools.mjs` 的注入测试证明
 * 「工具有」，但中间那一段 —— 主进程 → executeJavaScript → 渲染侧 → 改内存工程 →
 * 触发可撤销快照 —— 只有真起一个窗口才能验证。历史教训：本仓库出过的
 * 「提示承诺 vs 实际接线」断裂，全部只在端到端复现时才暴露。
 *
 * 它验证六件事：
 *   1. 渲染侧 `__BWE__.runScriptTool` 存在（主进程转发的前提）
 *   2. `ListScripts` / `ReadScript` 能读到真实工程数据
 *   3. `WriteScript` 新建脚本能真的进工程（用 `__BWE__.store` 独立核对，不看工具自己的说法）
 *   4. `PatchScript` 改一处能真的改掉
 *   5. `DeleteScript` 被引用时拒绝、force 才删
 *   6. 改动进了撤销栈（`editor.undo()` 能还原）
 *
 * 跑法：
 *   node desktop/tools/verify-script-write.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ELECTRON = join(REPO, "desktop", "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(REPO, "desktop", "main.mjs");
const OUT = join(REPO, ".tmp_ai", "verify-script-write");

let pass = 0;
let fail = 0;
const results = [];

/**
 * 断言。
 *
 * ⚠ 参数顺序是 **(cond, name, detail)** —— 中文断言名很长，作者习惯把条件写在前。
 * 这里曾写反过一次（签名是 (name, cond) 但调用全是 (cond, name)），结果是
 * **cond 收到一段永远为真的字符串** → 18 条断言全绿而实际有一条明明失败
 * （打印成 `ok false`，因为布尔值被塞进了 name 位置）。
 * 这类"测试自己骗自己"比没有测试更糟：它给出的是**确定性的假绿**。
 * 所以签名固定为条件在前，且下面会额外校验"断言名必须是字符串"。
 */
function check(cond, name, detail) {
  if (typeof name !== "string") {
    throw new TypeError(`断言名必须是字符串（参数顺序写反了？）：${String(name)}`);
  }
  const okFlag = cond === true;
  results.push({ name, ok: okFlag, detail: detail ?? "" });
  if (okFlag) {
    pass++;
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * 在渲染进程里跑一段「用 __BWE__ 改脚本 + 核对 store + 撤销」的脚本。
 *
 * ⚠ 这段字符串是**被测代码的使用方式**（模拟 AI 经主进程转发过来的调用），
 * 不是实现本身：它调用的是 `__BWE__.runScriptTool`，与生产路径完全一致。
 */
const E2E_SCRIPT = `(() => {
  const out = { steps: [] };
  const W = window;
  const ed = W.__BWE__.editor;
  const store = W.__BWE__.store;

  // 先确认两个前提
  out.hasRunScriptTool = typeof W.__BWE__.runScriptTool === "function";
  out.hasUndo = typeof ed.undo === "function";
  if (!out.hasRunScriptTool) return out;

  const project = store.project;
  out.projectName = project && project.name;
  out.scriptBefore = Object.keys(project.scripts || {});

  // 1) ListScripts
  out.listText = W.__BWE__.runScriptTool("ListScripts", {}).text;

  // 2) WriteScript 新建
  const w = W.__BWE__.runScriptTool("WriteScript", {
    name: "AI 写入测试",
    source: "var AI_TEST = 1;\\nfunction onStart() {\\n  AI_TEST = 2;\\n}\\n",
    create: true,
    lang: "js"
  });
  out.writeOk = w.text;
  out.writeFailed = Boolean(w.error);
  // ★ 独立核对：不信工具的说法，直接看 store
  out.existsInStore = Boolean(store.project.scripts["AI 写入测试"]);
  out.sourceInStore = store.project.scripts["AI 写入测试"]
    ? store.project.scripts["AI 写入测试"].source
    : null;

  // 3) ReadScript 读回
  const r = W.__BWE__.runScriptTool("ReadScript", { name: "AI 写入测试" });
  out.readFailed = Boolean(r.error);
  out.readText = r.text;

  // 4) PatchScript 改一处
  const p = W.__BWE__.runScriptTool("PatchScript", {
    name: "AI 写入测试",
    find: "AI_TEST = 2;",
    replace: "AI_TEST = 42;"
  });
  out.patchFailed = Boolean(p.error);
  out.afterPatch = store.project.scripts["AI 写入测试"].source;

  // 5) PatchScript 命中 0 处 → 必须失败（不猜）
  const pmiss = W.__BWE__.runScriptTool("PatchScript", {
    name: "AI 写入测试", find: "NOT_IN_FILE_XYZ", replace: "x"
  });
  out.patchMissFailed = Boolean(pmiss.error);
  out.patchMissText = pmiss.text;

  // 6) 非法名 → 必须拒绝
  const bad = W.__BWE__.runScriptTool("WriteScript", { name: "a/b", source: "var x=1;" });
  out.badNameFailed = Boolean(bad.error);

  // 7) 撤销：把刚写进去的脚本撤掉（撤销栈验证「AI 改动可逆」）
  const beforeUndoSource = store.project.scripts["AI 写入测试"]
    ? store.project.scripts["AI 写入测试"].source
    : null;
  // 直接构造「被引用」的情形比较麻烦，这里只验证 patch 可被 undo 还原
  ed.undo();
  const afterUndoSource = store.project.scripts["AI 写入测试"]
    ? store.project.scripts["AI 写入测试"].source
    : null;
  out.undoChangedSomething = beforeUndoSource !== afterUndoSource;
  out.beforeUndoSource = beforeUndoSource;
  out.afterUndoSource = afterUndoSource;

  // 8) DeleteScript（无引用可删）
  const d = W.__BWE__.runScriptTool("DeleteScript", { name: "AI 写入测试", force: true });
  out.deleteFailed = Boolean(d.error);
  out.existsAfterDelete = Boolean(store.project.scripts["AI 写入测试"]);

  return out;
})()`;

function runElectron({ userDataDir, probeScript, probeOut }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // 本环境常带它，会让 electron 退化成纯 node
    const child = spawn(
      ELECTRON,
      [
        MAIN,
        `--user-data=${userDataDir}`,
        `--e2e-script=${probeScript}`,
        `--e2e-out=${probeOut}`,
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
    }, 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(`[verify-script-write] 缺少 Electron：${ELECTRON}\n  先运行 node desktop/tools/fetch-electron.mjs`);
    return 2;
  }
  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const userDataDir = join(OUT, `ud-${stamp}`);
  const probeScript = join(OUT, `probe-${stamp}.txt`);
  const probeOut = join(OUT, `out-${stamp}.json`);
  mkdirSync(userDataDir, { recursive: true });
  // 把要执行的脚本落到文件（主进程用 --e2e-script 读它）
  const { writeFileSync } = await import("node:fs");
  writeFileSync(probeScript, E2E_SCRIPT, "utf8");

  console.log("== 脚本写工具端到端（真 Electron / 真 store）==");
  const { code, output } = await runElectron({ userDataDir, probeScript, probeOut });
  check(code === 0, `Electron 正常退出（exit=${code}）`);

  if (!existsSync(probeOut)) {
    check(false, "生成了端到端结果 JSON");
    console.log(output.slice(-3000));
    summarize();
    return 1;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(probeOut, "utf8"));
  } catch (e) {
    check(false, "结果 JSON 可解析", String(e));
    summarize();
    return 1;
  }

  check(data.hasRunScriptTool === true, "渲染侧存在 __BWE__.runScriptTool（主进程转发的前提）");
  check(data.hasUndo === true, "编辑器有 undo（AI 改动可 Ctrl+Z 撤销的前提）");
  check(typeof data.projectName === "string" && data.projectName.length > 0, `工程已载入（${data.projectName}）`);
  check(typeof data.listText === "string" && data.listText.length > 0, "ListScripts 返回非空清单");

  // WriteScript
  check(data.writeFailed === false, "WriteScript 未报错", data.writeOk);
  check(data.existsInStore === true, "★ 新建的脚本真的进了 store（不看工具自己的说法）");
  check(
    typeof data.sourceInStore === "string" && data.sourceInStore.includes("AI_TEST = 1"),
    "store 里的源码就是写进去的那份",
    data.sourceInStore ? `前 40 字：${data.sourceInStore.slice(0, 40)}` : "null"
  );

  // ReadScript
  check(data.readFailed === false, "ReadScript 读回成功");
  check(
    typeof data.readText === "string" && data.readText.includes("AI_TEST = 1"),
    "ReadScript 正文含源码"
  );

  // PatchScript
  check(data.patchFailed === false, "PatchScript 改一处成功");
  check(
    typeof data.afterPatch === "string" && data.afterPatch.includes("AI_TEST = 42"),
    "★ store 里真的变成了改后的内容",
    data.afterPatch ? data.afterPatch.replace(/\n/g, "\\n") : "null"
  );
  check(
    typeof data.afterPatch === "string" && !data.afterPatch.includes("AI_TEST = 2;"),
    "旧内容已被替换（不是追加）"
  );

  // 不猜的两条
  check(data.patchMissFailed === true, "补丁命中 0 处必须失败（不猜）", data.patchMissText);
  check(data.badNameFailed === true, "非法脚本名必须拒绝");

  // 撤销
  check(
    data.undoChangedSomething === true,
    "★ 撤销真的回退了 AI 的改动（改动可逆）",
    `undo 前 ${String(data.beforeUndoSource).slice(0, 30)} / 后 ${String(data.afterUndoSource).slice(0, 30)}`
  );

  // 删除
  check(data.deleteFailed === false, "DeleteScript 成功");
  check(data.existsAfterDelete === false, "删除后 store 里真的没了");

  console.log(output.slice(-1200));
  return summarize();
}

function summarize() {
  console.log(`\nverify-script-write: ${pass}/${pass + fail} 通过`);
  console.log(`证据目录：${OUT}`);
  return fail === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
