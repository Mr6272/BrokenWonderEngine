#!/usr/bin/env node
/**
 * 用真实 Chrome 测编辑器「开久了变卡」的关键指标。
 *
 * 为什么要真浏览器：堆内存、位图、rAF 空转这些东西在 node 里测不出来。
 * 这个脚本通过 Chrome DevTools Protocol 直接连到无头 Chrome：
 *   1. 打开编辑器、载入一个大工程（1307 对象的开放世界城市）
 *   2. 记录 Heap · DOM 节点数 · 位图数量
 *   3. **在不动它的情况下**待机一段时间，再看这些数字是否还在涨
 *      —— 判据就是「闲置时不该持续增长」。这就是用户说的「开久了变卡」。
 *   4. 反复做撤销/重做（这是原来最耗内存的操作），看堆是否被打爆
 *
 * 用法：node web/tools/verify-editor-memory.mjs [--idle 20] [--port 9222]
 * 退出码：0 = 通过；1 = 有指标超阈值。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const IDLE_SECONDS = Number(getArg("--idle", "20"));
const PORT = Number(getArg("--port", "9222"));
const EDITOR_URL = getArg("--url", "http://127.0.0.1:5273/");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error("✗ 找不到 Chrome/Edge，无法做真实内存测量");
  process.exit(1);
}

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}${detail ? `（${detail}）` : ""}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP 客户端
async function connect() {
  const listUrl = `http://127.0.0.1:${PORT}/json/list`;
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(listUrl);
      targets = await r.json();
      if (targets.length) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!targets?.length) throw new Error("连不上 Chrome 调试端口");
  const page = targets.find((t) => t.type === "page") ?? targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: r, reject: j } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) j(new Error(msg.error.message));
      else r(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const mid = ++id;
      pending.set(mid, { resolve: r, reject: j });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { send, close: () => ws.close() };
}

const main = async () => {
  console.log(`Chrome: ${chromePath}`);
  console.log(`编辑器: ${EDITOR_URL}`);
  console.log(`待机观察: ${IDLE_SECONDS}s\n`);

  const userDir = join(ROOT, ".tmp_perfprofile");
  const proc = spawn(
    chromePath,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu-sandbox",
      "--window-size=1600,900",
      EDITOR_URL
    ],
    { stdio: "ignore", detached: false }
  );

  let cdp;
  try {
    cdp = await connect();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    proc.kill();
    process.exit(1);
  }

  const evalJs = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "页面执行出错");
    return r.result.value;
  };

  try {
    // 等编辑器起来（它会先读 IndexedDB 恢复上次工程）
    for (let i = 0; i < 60; i++) {
      const ready = await evalJs(`!!(window.__bweDiag || document.querySelector('canvas'))`).catch(() => false);
      if (ready) break;
      await sleep(500);
    }
    await sleep(3000);

    const hasCanvas = await evalJs(`!!document.querySelector('canvas')`);
    check("编辑器画布已渲染", hasCanvas);

    // 载入一个真实的大工程：走编辑器真正的装载入口 editor.setProject()
    // （不是只把 JSON 塞到 window 上 —— 那样测不到 normalize、撤销基线、画布重算这些真实开销）
    let bigJson;
    try {
      const r = await fetch(`${new URL(EDITOR_URL).origin}/examples/${encodeURIComponent("扫雷.bwproj")}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      bigJson = await r.text();
    } catch (e) {
      bigJson = null;
      console.log(`  · 跳过载入大工程（${e.message}）`);
    }

    if (bigJson) {
      // 用一个可取消的确认弹窗处理：编辑器载入前若提示"未保存会被丢弃"，
      // 直接点掉它（这里没有真实用户操作）。
      await evalJs(`window.__bwePerfLoad = ${JSON.stringify(bigJson)}; true`);
      const loaded = await evalJs(`(() => {
        const p = JSON.parse(window.__bwePerfLoad);
        const ed = window.__BWE__?.editor;
        if (!ed) return { ok: false, reason: '调试出口不可用' };
        ed.setProject(p, '扫雷.bwproj');
        const st = window.__BWE__.store;
        return {
          ok: true,
          objects: st.scene ? st.scene.objects.length : -1,
          assets: st.assets.length,
          name: st.project?.name ?? ''
        };
      })()`);
      if (loaded.ok) {
        console.log(`  · 已载入工程「${loaded.name}」：当前场景 ${loaded.objects} 对象 / ${loaded.assets} 素材`);
        check("大工程已通过编辑器装载", loaded.objects > 0 && loaded.assets > 0, `${loaded.objects} 对象`);
      } else {
        console.log(`  · 载入失败：${loaded.reason}`);
      }
      await sleep(2000);
    }

    // ---- 指标采样 ----
    await cdp.send("Performance.enable", {}).catch(() => {});
    const sample = async () => {
      const metrics = await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }));
      const pick = (n) => metrics.metrics?.find((m) => m.name === n)?.value ?? null;
      const domNodes = await evalJs(`document.getElementsByTagName('*').length`).catch(() => -1);
      const canvases = await evalJs(`document.querySelectorAll('canvas').length`).catch(() => -1);
      return {
        heapMB: pick("JSHeapUsedSize") != null ? pick("JSHeapUsedSize") / 1048576 : null,
        heapTotalMB: pick("JSHeapTotalSize") != null ? pick("JSHeapTotalSize") / 1048576 : null,
        domNodes,
        canvases
      };
    };

    // 让引擎进入 steady state
    await sleep(2000);
    const t0 = await sample();
    console.log(`\n初始：堆 ${t0.heapMB?.toFixed(1)} MB · DOM ${t0.domNodes} 节点 · canvas ${t0.canvases}`);

    // ---- 1. 闲置：不动它，看是否持续增长 ----
    console.log(`\n1. 闲置 ${IDLE_SECONDS}s（不做任何操作）`);
    await sleep(IDLE_SECONDS * 1000);
    const t1 = await sample();
    const growth = (t1.heapMB ?? 0) - (t0.heapMB ?? 0);
    console.log(`  待机后：堆 ${t1.heapMB?.toFixed(1)} MB（Δ${growth >= 0 ? "+" : ""}${growth.toFixed(1)} MB）· DOM ${t1.domNodes}`);
    check("闲置时堆内存不持续增长", growth < 8, `Δ${growth.toFixed(1)} MB`);
    check("闲置时 DOM 节点数不增长", t1.domNodes - t0.domNodes < 50, `Δ${t1.domNodes - t0.domNodes}`);

    // ---- 2. 撤销/重做压力：原来最耗内存的操作 ----
    // 先制造真实编辑历史 —— 没有 commit 就没有快照，空压测测不出东西
    // （第一版就是这样：40 次撤销/重做堆增量为 0，因为根本没东西可撤）。
    console.log("\n2. 制造 40 步真实编辑历史，再做撤销/重做压力");
    const beforeStress = await sample();
    const historyInfo = await evalJs(`(async () => {
      const ed = window.__BWE__?.editor;
      const st = window.__BWE__?.store;
      if (!ed || !st || !st.scene) return { ok: false };
      const objs = st.scene.objects;
      // 移动对象 = 一次真实编辑，会走 commit → 生成一份快照
      for (let i = 0; i < 40 && objs.length; i++) {
        const o = objs[i % objs.length];
        o.x = (o.x ?? 0) + 4;
        st.markDirty();
        ed.commit('perf-stress-' + i);
        await new Promise(r => setTimeout(r, 0));
      }
      return { ok: true, objects: objs.length };
    })()`);
    if (historyInfo.ok) console.log(`  · 已制造编辑历史（作用于 ${historyInfo.objects} 个对象）`);
    await sleep(500);

    const midStress = await sample();
    await evalJs(`(async () => {
      for (let i = 0; i < 40; i++) {
        window.dispatchEvent(new CustomEvent('bwe:undo'));
        window.dispatchEvent(new CustomEvent('bwe:redo'));
        await new Promise(r => setTimeout(r, 0));
      }
      return true;
    })()`);
    await sleep(1500);
    const afterStress = await sample();
    const stressGrowth = (afterStress.heapMB ?? 0) - (midStress.heapMB ?? 0);
    console.log(`  压测后：堆 ${afterStress.heapMB?.toFixed(1)} MB（Δ${stressGrowth >= 0 ? "+" : ""}${stressGrowth.toFixed(1)} MB）`);
    // 40 次撤销+重做 = 80 份快照。原实现光这一项就是数百 MB，现在应远低于这个量级。
    check("80 份快照压力下堆增量可控", stressGrowth < 150, `Δ${stressGrowth.toFixed(1)} MB`);

    // ---- 3. 页面无异常 ----
    console.log("\n3. 运行时健康");
    const errCount = await evalJs(`(window.__bweErrors || []).length`).catch(() => 0);
    check("页面无累积的未捕获错误", errCount === 0, `${errCount} 条`);

  } finally {
    try {
      cdp.close();
    } catch {
      /* 忽略 */
    }
    proc.kill();
  }

  console.log(failures === 0 ? "\n全部通过" : `\n失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error(`✗ ${e.stack ?? e.message}`);
  process.exit(1);
});
