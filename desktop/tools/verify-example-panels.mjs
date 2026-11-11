/**
 * 内置示例「载入后面板不崩」的端到端验收（真 Electron、真编辑器、真 store）。
 *
 * 为什么接口层断言不够：
 *   `verify-example-fields.mjs` 证明 buildExample() 产出的字段齐全，
 *   但它证明不了「点开预制体面板真的不崩」。这个 bug 的真实表现是
 *   侧栏只剩十几个字（不是白屏、不弹错误框），只有真窗口里跑才能看见。
 *
 * ⚠ 第一版测试的教训（留在这里防复发）：
 *   它循环 7 个示例，但每次都只点 `[data-load-js-demo="1"]` 那个隐藏按钮 ——
 *   而那个按钮只载入 topdown-js。于是 7 行断言测的是**同一个工程**，
 *   全部「通过」，但完全没有覆盖另外 6 个。确定性假绿比没有测试更糟。
 *   现在改为走**命令面板**（打开 → 输入示例名 → 点中那条命令），
 *   这是用户的真实路径，也逐项验证「工程真的换了」。
 *
 * 验证五件事：
 *   1. 7 个内置示例都能经命令面板载入（且工程名确实变了）
 *   2. 每个示例载入后 prefabs / packs 都是数组
 *   3. 预制体面板渲染出内容（不是十几个字的残骸）
 *   4. 全程没有 "Cannot read properties of undefined (reading 'length')"
 *   5. 每个示例的工程名与预期一致（防止「载入了但载错」）
 *
 * 跑法：
 *   node desktop/tools/verify-example-panels.mjs
 *   npm run verify:example-panels
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ELECTRON = join(REPO, "desktop", "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(REPO, "desktop", "main.mjs");
const OUT = join(REPO, ".tmp_ui", "verify-example-panels");

let pass = 0;
let fail = 0;
const failures = [];

/** 断言。条件在前，名字必须是字符串（参数写反 = 确定性假绿）。 */
function check(cond, name, detail) {
  if (typeof name !== "string") {
    throw new TypeError(`断言名必须是字符串（参数顺序写反了？）：${String(name)}`);
  }
  if (cond === true) {
    pass++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 期望的工程名：用来证明「真的换了这个工程」，而不是停在上一个。 */
const EXPECT = [
  { id: "minesweeper", title: "扫雷示例", name: "扫雷示例" },
  { id: "dressup", title: "换装示例", name: "换装示例" },
  { id: "topdown-js", title: "俯视角 JS 示例", name: "俯视角JS示例" },
  { id: "emergence", title: "涌现沙盘示例", name: "涌现沙盘" },
  { id: "vampire", title: "吸血鬼幸存者", name: "吸血鬼幸存者" },
  { id: "lighting", title: "2D 光照示例", name: "2D 光照示例" },
  { id: "alien-shooter", title: "孤胆枪手", name: "孤胆枪手" }
];

const E2E_SCRIPT = `(async () => {
  const out = { examples: [], errors: [], paletteWorks: false };
  const W = window;
  W.addEventListener("error", (e) => out.errors.push(String((e && e.message) || e)));
  const origError = console.error;
  console.error = (...a) => { out.errors.push(a.map(String).join(" ").slice(0, 200)); origError.apply(console, a); };

  const store = W.__BWE__.store;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CASES = ${JSON.stringify(EXPECT)};

  async function runViaPalette(keyword) {
    const trigger = document.querySelector('[data-command-palette-trigger="1"]');
    if (!trigger) return { ok: false, why: "没有命令面板按钮" };
    trigger.click();
    await sleep(180);

    const input = document.querySelector('[data-cp-input="1"]');
    if (!input) return { ok: false, why: "命令面板没弹出" };

    input.value = keyword;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(180);

    const items = Array.from(document.querySelectorAll(".cp-item"));
    if (!items.length) return { ok: false, why: "没有匹配项:" + keyword };
    const first = items[0];
    const label = (first.textContent || "").trim();
    first.click();
    await sleep(950);
    return { ok: true, picked: label.slice(0, 40) };
  }

  for (const c of CASES) {
    const row = { id: c.id, expectName: c.name };
    try {
      const r = await runViaPalette(c.title);
      row.palette = r;
      if (r.ok) out.paletteWorks = true;

      const p = store.project;
      row.projectName = (p && p.name) || null;
      row.prefabsType = Array.isArray(p && p.prefabs) ? "array" : typeof (p && p.prefabs);
      row.packsType = Array.isArray(p && p.packs) ? "array" : typeof (p && p.packs);

      const act = document.querySelector('[data-activity="prefabs"]');
      if (act) act.click();
      await sleep(520);
      const host = document.querySelector(".sidebar-body") || document.querySelector(".sidebar");
      const text = ((host && host.textContent) || "").trim();
      row.panelTextLen = text.length;
      row.panelSample = text.slice(0, 60);
      row.panelCrashed = text.length < 40;
    } catch (e) {
      row.error = String((e && e.message) || e);
    }
    out.examples.push(row);
  }

  out.typeErrors = out.errors.filter((s) => /Cannot read properties of undefined|TypeError/.test(s));
  return out;
})()`;

function runElectron({ userDataDir, probeScript, probeOut }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      ELECTRON,
      [MAIN, `--user-data=${userDataDir}`, `--e2e-script=${probeScript}`, `--e2e-out=${probeOut}`, "--console"],
      { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString("utf8")));
    child.stderr.on("data", (d) => (output += d.toString("utf8")));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, 180000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

async function main() {
  if (!existsSync(ELECTRON)) {
    console.error(`[verify-example-panels] 缺少 Electron：${ELECTRON}\n  先运行 node desktop/tools/fetch-electron.mjs`);
    return 2;
  }
  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const userDataDir = join(OUT, `ud-${stamp}`);
  const probeScript = join(OUT, `probe-${stamp}.txt`);
  const probeOut = join(OUT, `out-${stamp}.json`);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(probeScript, E2E_SCRIPT, "utf8");

  console.log("== 内置示例载入后的面板状态（真 Electron / 真 store / 命令面板路径）==");
  const { code, output } = await runElectron({ userDataDir, probeScript, probeOut });
  check(code === 0, `Electron 正常退出（exit=${code}）`);

  if (!existsSync(probeOut)) {
    check(false, "生成了端到端结果 JSON");
    console.log(output.slice(-2000));
    return summarize();
  }

  let data;
  try {
    data = JSON.parse(readFileSync(probeOut, "utf8"));
  } catch (e) {
    check(false, "结果 JSON 可解析", String(e));
    return summarize();
  }

  const rows = Array.isArray(data.examples) ? data.examples : [];
  check(data.paletteWorks === true, "命令面板可用（用户真实载入路径）");
  check(rows.length === EXPECT.length, `检查了全部 ${EXPECT.length} 个内置示例`, `实际 ${rows.length}`);

  for (const row of rows) {
    // 关键断言：工程名必须真的换成这个示例，否则下面几条都在测同一个工程
    check(
      row.projectName === row.expectName,
      `示例 ${row.id} 真的载入了（工程名 = ${row.expectName}）`,
      `实际 ${row.projectName}`
    );
    check(row.prefabsType === "array", `示例 ${row.id} 的 prefabs 是数组`, `→ ${row.prefabsType}`);
    check(row.packsType === "array", `示例 ${row.id} 的 packs 是数组`, `→ ${row.packsType}`);
    check(!row.panelCrashed, `示例 ${row.id} 的预制体面板正常渲染`, `${row.panelTextLen} 字`);
  }

  const typeErrors = Array.isArray(data.typeErrors) ? data.typeErrors : [];
  check(typeErrors.length === 0, "没有 TypeError（undefined.length）", typeErrors.length ? typeErrors[0] : "无");

  if (fail > 0) {
    console.log("\n--- 原始结果（截断） ---");
    console.log(JSON.stringify(data, null, 2).slice(0, 2500));
  }
  return summarize();
}

function summarize() {
  console.log("\n------------------------------------");
  if (fail === 0) {
    console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 0 → ALL PASS`);
    return 0;
  }
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail} → FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  return 1;
}

process.exitCode = await main();
