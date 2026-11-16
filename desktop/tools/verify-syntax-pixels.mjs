#!/usr/bin/env node
/**
 * 语法着色的**像素级**验收：截一张图，在「已知被染色的词」的矩形里采样，
 * 看屏幕上真的出现了对应的颜色。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * `getComputedStyle(el).color` 只能证明「CSS 算出来是那个色」，
 * 证明不了「屏幕上真的画出来了」。两者之间还隔着：
 *   · 元素被 `visibility:hidden` / `opacity:0` / 被别的东西盖住；
 *   · 父级 `color` 被覆盖（`.js-hl mark { color: inherit }` 那类规则）；
 *   · 整层被 `overflow:hidden` 裁掉（覆盖层原点错位 40px 时就是这样）。
 * 这些在 computed style 里全是"对"的，只有看像素才能发现。
 *
 * 做法：探针先返回「每个类别第一个可见词的屏幕矩形 + 它的 computed color」，
 * 截图后在这些矩形内统计「与该颜色接近」的像素数。占比够高就说明字真的画出来了。
 *
 * 跑法：
 *   node desktop/tools/verify-syntax-pixels.mjs
 * 退出码：0 通过；1 断言失败；2 前置条件不满足。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "../lib/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ELECTRON = join(REPO, "desktop", "vendor", "electron", process.platform === "win32" ? "electron.exe" : "electron");
const MAIN = join(REPO, "desktop", "main.mjs");
const PROBE = join(HERE, "probes", "syntax-pixels.probe.js");
const OUT = join(REPO, ".tmp_jseditor", "pixel-verify");

let pass = 0;
let fail = 0;

function check(cond, name, detail) {
  const okFlag = cond === true;
  if (okFlag) {
    pass++;
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** "rgb(1, 2, 3)" → [1,2,3] */
function parseRgb(css) {
  const m = /rgba?\(([^)]+)\)/.exec(String(css ?? ""));
  if (!m) return null;
  const parts = m[1].split(",").map((s) => Number(s.trim()));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [Math.round(parts[0]), Math.round(parts[1]), Math.round(parts[2])];
}

function main() {
  if (!existsSync(ELECTRON)) {
    console.error(`[verify-syntax-pixels] 缺少 Electron：${ELECTRON}`);
    return 2;
  }
  if (!existsSync(PROBE)) {
    console.error(`[verify-syntax-pixels] 缺少探针：${PROBE}`);
    return 2;
  }
  mkdirSync(OUT, { recursive: true });
  const stamp = Date.now().toString(36);
  const shot = join(OUT, `shot-${stamp}.png`);
  const jsonPath = join(OUT, `rects-${stamp}.json`);

  const args = [
    MAIN,
    // ⚠ 用 --e2e-shot 而不是 --shot：--shot 与 --e2e-script 同时给时，
    // e2e 执行完就 app.exit()，截图那条路径根本走不到（第一版就是这么拿到 0 字节的）。
    // --e2e-shot 是专为"脚本跑完再截图"加的开关。
    `--e2e-shot=${shot}`,
    "--size=1600x1000",
    `--user-data=${join(OUT, `ud-${stamp}`)}`,
    `--e2e-script=${PROBE}`,
    `--e2e-out=${jsonPath}`,
    "--console"
  ];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  return new Promise((resolvePromise) => {
    const child = spawn(ELECTRON, args, { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      let rects = null;
      try {
        rects = JSON.parse(readFileSync(jsonPath, "utf8"));
      } catch {
        /* 下面断言会红 */
      }
      check(code === 0, `Electron 正常退出（exit=${code}）`);
      check(Boolean(rects), "拿到了采样矩形 JSON");
      if (!rects) {
        console.log(output.slice(-1500));
        console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==`);
        resolvePromise(1);
        return;
      }
      check(existsSync(shot), `截到了图（${shot}）`);
      if (!existsSync(shot)) {
        resolvePromise(1);
        return;
      }

      const img = decodePng(readFileSync(shot));
      // decodePng 返回的是 { width, height, channels, rgba } —— 字段名是 **rgba** 不是 data。
      // 写错字段名时 `data[i]` 会静默得到 undefined，然后在 Buffer 越界处才炸，
      // 报错行指向 px() 而不是"字段名错了"，很容易误判成解码失败。
      const { width, height, rgba } = img;
      const px = (x, y) => {
        const i = (y * width + x) * 4;
        return [rgba[i], rgba[i + 1], rgba[i + 2]];
      };
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

      /**
       * 在一个矩形里统计「接近目标色」的像素占比。
       *
       * 阈值 60（RGB 欧氏距离）：抗锯齿会让字的边缘像素与底色混合，
       * 但字芯那几个像素是纯色。60 足够滤掉底色，又不会因为 ClearType 的
       * 亚像素渲染把合格的字判成不合格。
       */
      const hitRatio = (r, target) => {
        let hit = 0;
        let total = 0;
        const x0 = Math.max(0, r.x);
        const y0 = Math.max(0, r.y);
        const x1 = Math.min(width - 1, r.x + r.w);
        const y1 = Math.min(height - 1, r.y + r.h);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            total++;
            if (dist(px(x, y), target) <= 60) hit++;
          }
        }
        return { ratio: total ? hit / total : 0, hit, total };
      };

      const picks = rects.picks ?? [];
      const measured = [];
      for (const p of picks) {
        if (!p || !p.text || !p.color) {
          measured.push({ cls: p?.cls, skipped: "没有可见的样例词" });
          continue;
        }
        const target = parseRgb(p.color);
        if (!target) {
          measured.push({ cls: p.cls, skipped: `颜色解析失败 ${p.color}` });
          continue;
        }
        const r = hitRatio(p, target);
        measured.push({ cls: p.cls, text: p.text, color: p.color, ...r });
      }

      const sampled = measured.filter((m) => !m.skipped);
      // 探针注入的样例把六类都放在同一屏，所以这里要求**六类全采到**。
      // 少一个就说明"那一类没渲染出来"，而不是"素材里没有" —— 这也是注入样例的目的。
      check(
        sampled.length === 6,
        "★ 六类全部采到可见样例（注入的样例文本保证同屏可见）",
        `${sampled.length}/6：${sampled.map((m) => m.cls).join(",")}`
      );

      // 每一类：命中比例 ≥ 3%（字只占矩形很小一部分，3% 已经是"字真的画出来了"）
      for (const m of sampled) {
        check(
          m.ratio >= 0.03,
          `★ 屏幕上真的有 ${m.cls} 的彩色像素（${m.text}）`,
          `${(m.ratio * 100).toFixed(1)}% 命中 / ${m.total} 像素，目标 ${m.color}`
        );
      }

      // 跨类别：采到的颜色必须彼此不同（防止"全染成同一个色"）
      const distinct = new Set(sampled.map((m) => m.color));
      check(
        distinct.size === sampled.length,
        "★ 采到的各类别颜色彼此不同",
        `${distinct.size} 种 / ${sampled.length} 类`
      );

      console.log(`\n  采样明细：`);
      for (const m of measured) {
        if (m.skipped) {
          console.log(`    ${m.cls}: 跳过（${m.skipped}）`);
        } else {
          console.log(`    ${m.cls}: ${(m.ratio * 100).toFixed(1)}% · ${m.text} · ${m.color}`);
        }
      }
      console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==`);
      console.log(`  截图：${shot}`);
      resolvePromise(fail === 0 ? 0 : 1);
    });
  });
}

main().then((code) => {
  process.exitCode = code;
});
