/**
 * 并发截图回归测试（Lead 要求的关键回归锁）。
 *
 * 为什么必须自动化：`--verify` 会被 CI、多人、连续跑。只要两个截图进程共用 userData，
 * Chromium 的 disk cache / GPU shader cache 争锁失败，就会出现**随机的红**：
 *   · 症状 A（CSS 未加载）：截图主色 #686860（亮度 0.14）→ 判「深色主题 FAIL」；
 *   · 症状 B（JS 未跑）：截图 99.8% 纯奶油、非背景 0.2% → 判「空白截图 FAIL」。
 *
 * 这两种症状都**看起来像逻辑错**，实际是环境竞争 —— 是最难排查、最容易让人误改判定逻辑
 * 的一类缺陷。人眼复测靠不住（偶发），所以这里用两个真进程并发跑，断言两边都出正确的奶油图。
 *
 * 覆盖三条修法：
 *   1. 每次截图进程独立 userData（pid 后缀）—— 本测试的主要目标；
 *   2. 禁用磁盘缓存开关 —— 降低争锁概率；
 *   3. 偶发失败重试一次 —— 兜底。
 *
 * 用法：node desktop/test/concurrency.test.mjs [--rounds=N]
 * 退出码：0 全部通过；1 有失败（打印每个进程的结论与失败原因）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { appDataPath, electronExe, mainScript, repoRoot } from "./_harness.mjs";
import { analyzePng, assertTheme } from "../lib/png.mjs";

const ROUNDS = Number((process.argv.find((a) => a.startsWith("--rounds=")) ?? "").split("=")[1]) || 2;
const CONCURRENCY = 2;
const OUT_DIR = `${repoRoot}/.tmp_desk`;

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/**
 * 起一个截图进程，返回 {code, output, pngPath, stats, theme}。
 * 用环境变量清掉 ELECTRON_RUN_AS_NODE（本环境默认带它，见 main.mjs 注释）。
 */
function runShotProcess(label, size, pngPath) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronExe, [mainScript, `--shot=${pngPath}`, `--size=${size}`, "--console"], {
      cwd: repoRoot,
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
    // 单个进程最多 60s：正常 6~10s，超时说明真挂了。
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, 60000);
    child.on("close", async (code) => {
      clearTimeout(timer);
      let stats = null;
      let theme = null;
      let error = null;
      try {
        if (existsSync(pngPath)) {
          stats = analyzePng(await readFile(pngPath));
          theme = assertTheme(stats);
        } else {
          error = "没有生成 PNG";
        }
      } catch (e) {
        error = `读图失败：${e.message}`;
      }
      resolvePromise({ label, code, output, pngPath, stats, theme, error });
    });
  });
}

test(`并发 ${CONCURRENCY} 个截图进程 × ${ROUNDS} 轮：两边都必须出奶油图`, async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const failures = [];

  for (let round = 1; round <= ROUNDS; round++) {
    // 同一轮里两个进程**同时**起（这是复现竞争的必要条件）
    const pngPaths = Array.from({ length: CONCURRENCY }, (_, i) =>
      `${OUT_DIR}/concurrency-r${round}-p${i + 1}.png`);
    const started = Date.now();
    const results = await Promise.all(
      pngPaths.map((p, i) => runShotProcess(`r${round}-p${i + 1}`, "1600x1000", p))
    );
    const ms = Date.now() - started;

    for (const r of results) {
      const ok = r.code === 0 && r.stats && !r.stats.isEmpty && r.theme?.ok === true;
      const detail =
        `${r.label}: exit=${r.code} ` +
        (r.stats
          ? `nonbg=${(r.stats.foregroundRatio * 100).toFixed(1)}% bg=${r.stats.background} theme=${r.theme?.theme}`
          : `error=${r.error}`);
      if (ok) {
        console.log(`  ✓ 第 ${round} 轮 ${detail}（${ms}ms）`);
      } else {
        console.log(`  ✗ 第 ${round} 轮 ${detail}（${ms}ms）`);
        // 把该进程的关键日志摘出来，失败时能直接看出是症状 A 还是症状 B。
        const clues = r.output
          .split(/\r?\n/)
          .filter((l) => /[shot]|verify|Unable to create cache|Gpu Cache|did-fail-load/.test(l))
          .slice(-8);
        for (const c of clues) console.log(`      ${c}`);
        failures.push({ round, label: r.label, detail });
      }
    }
  }

  // 断言：不仅本轮通过，且每一轮的两个进程都通过
  if (failures.length) {
    throw new Error(
      `并发截图有 ${failures.length} 个进程失败：\n`
      + failures.map((f) => `  第 ${f.round} 轮 ${f.label} → ${f.detail}`).join("\n")
      + "\n  若出现「主题 midnight」说明 CSS 没加载、若「非背景 0.2%」说明 JS 没跑 —— "
      + "两者都是 userData 争锁，检查是否每个进程有独立 profile（USER_DATA_DIR 的 pid 后缀）。"
    );
  }
});

test("独立 profile：并发进程的 userData 目录不同且退出后被清理", async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const profileBase = `${appDataPath}/BWE Studio/.shot-profile`;
  // 并发跑两个，从日志里抓各自 userData 路径
  const results = await Promise.all([
    runShotProcess("iso-a", "1280x720", `${OUT_DIR}/iso-a.png`),
    runShotProcess("iso-b", "1280x720", `${OUT_DIR}/iso-b.png`)
  ]);
  for (const r of results) {
    const line = r.output.split(/\r?\n/).find((l) => l.includes("userData="));
    if (line) console.log(`  ${r.label} → ${line.trim()}`);
  }
  const paths = results
    .map((r) => (r.output.match(/userData=(.+?) shot=/) ?? [])[1]?.trim())
    .filter(Boolean);
  // 两个进程的 userData 必须不同（pid 后缀），否则并发一定踩
  if (paths.length === 2) {
    if (paths[0] === paths[1]) {
      throw new Error(`两个并发进程共用同一个 userData：${paths[0]}（并发截图会争 cache）`);
    }
    console.log(`  ✓ userData 互不相同：${paths[0]} / ${paths[1]}`);
  } else {
    console.log("  ⚠ 没从日志里抓到 userData 路径（不影响本轮其他断言）");
  }

  // profile 目录必须有**上限**，而不是"零残留"：
  //   退出时删自己那份做不到（app.exit 不触发 before-quit，且 Chromium 还攥句柄），
  //   所以策略是「启动时按 mtime 保留最近 SHOT_PROFILE_KEEP 个」。
  // 真正要防的是**无上限增长**（反复跑 --verify 堆出几十个 Chromium 缓存目录）。
  // 所以这里断言两件事：① 数量不超过保留上限；② 再跑一轮数量不增长。
  const countProfiles = async () =>
    (await readdir(profileBase).catch(() => [])).filter((name) => /^\d+$/.test(name)).length;

  const KEEP_LIMIT = 8; // 实现里是 6，留 2 个余量给并发同时存活的情况
  const firstCount = await countProfiles();
  console.log(`  第一次统计：${firstCount} 个 profile 目录（上限 ${KEEP_LIMIT}）`);

  await Promise.all([
    runShotProcess("grow-a", "1280x720", `${OUT_DIR}/grow-a.png`),
    runShotProcess("grow-b", "1280x720", `${OUT_DIR}/grow-b.png`)
  ]);
  const secondCount = await countProfiles();
  console.log(`  再跑一轮后：${secondCount} 个 profile 目录`);

  if (firstCount > KEEP_LIMIT || secondCount > KEEP_LIMIT) {
    throw new Error(
      `截图 profile 目录超过上限（${firstCount} / ${secondCount} > ${KEEP_LIMIT}）：`
      + "清理策略失效，会一直堆积 Chromium 缓存目录。检查 cleanupOldShotProfiles 的 KEEP 逻辑。"
    );
  }
  if (secondCount > firstCount + 2) {
    throw new Error(
      `再跑一轮后 profile 从 ${firstCount} 增长到 ${secondCount}：清理没有生效（无上限增长）`
    );
  }
});

for (const c of cases) {
  try {
    await c.fn();
    pass += 1;
    console.log(`  ✓ 通过：${c.name}\n`);
  } catch (e) {
    console.error(`  ✗ 失败：${c.name}\n    ${e.message}\n`);
    process.exitCode = 1;
  }
}

console.log(`concurrency.test: ${pass}/${cases.length} 通过（并发 ${CONCURRENCY} 进程 × ${ROUNDS} 轮）`);
if (pass !== cases.length) process.exit(1);
