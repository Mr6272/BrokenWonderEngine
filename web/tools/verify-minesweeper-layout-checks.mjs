#!/usr/bin/env node
/**
 * 扫雷布局自检的**变异测试**：故意把脚本改坏，确认 verify-minesweeper-ui.mjs 真的会红。
 *
 * <p>为什么需要它：布局与安全不变量一旦被写成「永远为真」，绿色就成了假安全 ——
 * 而这正是竖屏功能缺失能潜伏这么久的原因。这里逐条注入最小回归，
 * 断言对应的检查项确实报错；漏检 = 检查项本身有 bug。
 *
 * <p>⚠ 注入前先确认「这个改动真的会改变结果」。本项目实测踩过 3 条**等价变异**
 * （改了源码但输出完全不变，等于测了空气）：
 *   · 把 zoom 上限从 1 抬到 1.6 —— 格子尺寸按可用区反算，bandW/bw 恒 ≥1，算出来还是 1；
 *   · 按钮列左移 —— 数值框宽度由按钮位置倒推，左移只会让框变窄，不会重叠；
 *   · 只抬高可读下限 —— 地图上限那道闸会把它钳回去（那正是钳制在正常工作）。
 * 第三条说明：**有些回归必须组合多处才成立**，所以锚点支持「若干对」。
 *
 * <p>实现：verify-minesweeper-ui.mjs 支持 BWE_MS_MUTANT 环境变量，
 * 用它替换工程里的脚本文本（不碰磁盘上的工程文件）。
 *
 * 用法：node web/tools/verify-minesweeper-layout-checks.mjs
 * 退出码：0 = 每条注入的回归都被抓到；1 = 有漏检或锚点失效。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const HARNESS = join(ROOT, "web", "tools", "verify-minesweeper-ui.mjs");
const PROJECT = join(ROOT, "web", "examples", "扫雷-竖屏.bwproj");

const BASE_SRC = JSON.parse(readFileSync(PROJECT, "utf8")).scripts.minesweeper.source;

/**
 * [说明, 锚点对数组, 期望 harness 报出的失败关键词]
 *
 * <p>锚点必须逐字存在于当前脚本里；找不到就判定为「这条变异已失效」并报错，
 * 而不是默默跳过 —— 默默跳过会让人以为测过了。
 */
const MUTANTS = [
  // ---------- 可读性 ----------
  ["格子被压到 8px（只能靠放大凑，像素画会糊）",
    [["cell = Math.max(CELL_MIN, Math.min(CELL_MAX, cell));",
      "cell = Math.max(8, Math.min(8, cell));"]],
    "靠放大凑可读"],
  ["用放大代替可读格子（像素画发糊）",
    [["if (cell * z < CELL_READABLE) { z = CELL_READABLE / cell; }",
      "if (cell * z < CELL_READABLE) { z = Math.min(4, (CELL_READABLE / cell) * 1.6); }"]],
    "靠放大凑可读"],
  ["抬高可读下限 + 拆掉地图上限 → 棋盘超出地图（边缘拖不到）",
    [["if (cell < CELL_READABLE) { cell = CELL_READABLE; }", "if (cell < 40) { cell = 40; }"],
     ["var byBoard = Math.floor(BOARD_MAX / Math.max(rows, cols));", "var byBoard = 9999;"]],
    "棋盘大于地图"],

  // ---------- 触摸目标 ----------
  ["步进器行高缩回旧版 → 触摸目标过小",
    [["var rowH = Math.round(Math.max(40, Math.min(52, 44 * s)));",
      "var rowH = Math.round(Math.max(16, Math.min(20, 44 * s)));"]],
    "触摸目标过小"],

  // ---------- 遮挡 / 重叠 ----------
  ["顶带不留状态行高度 → 文字压到可见棋盘",
    [["var topH = 2 + titleH + 4 + (labelH + 6) + ledH + 4 + (msgH + 6) + 6 + safeTop;",
      "var topH = 2 + titleH + 4 + (labelH + 6) + ledH;"]],
    "HUD 文字压住棋盘"],
  ["+ 键压进数值框 → 控件重叠",
    [["  var plusX = fieldX + fieldW + 6;", "  var plusX = fieldX + fieldW - 20;"]],
    "控件重叠"],

  // ---------- 64×64 的安全不变量（最要命）----------
  // 大棋盘必然伸到 HUD 底下；少了界面区登记，点「新游戏」会顺带翻开底下的格子（可能直接踩雷）。
  ["撤销底带界面区登记 → 点按钮误翻格子",
    [['blockBand("hudBottom", 0, H - L.botH, W, L.botH);', "void 0;"]],
    "没登记界面区"],
  ["界面区只登记一半 → 底带仍误翻格子",
    [['blockBand("hudBottom", 0, H - L.botH, W, L.botH);',
      'blockBand("hudBottom", 0, H - L.botH, W, L.botH / 2);']],
    "没登记界面区"],
  ["撤销顶带界面区登记 → 点笑脸误翻格子",
    [['blockBand("hudTop", 0, 0, W, L.topH);', "void 0;"]],
    "没登记界面区"],

  // ---------- 大棋盘平移（64×64 一屏只露约 46 行，拖不动 = 18 行永远点不到 = 无法通关）----------
  ["拆掉键盘平移 → 边缘格子永远点不到",
    [["  handlePan(dt, L);", "  void 0;"]],
    "装不下整盘却平移不了"],
  ["平移不做视野钳制 → 拖出棋盘一片空白",
    [["    camX = Math.max(bx - bw / 2 + halfW, Math.min(bx + bw / 2 - halfW, camX));",
      "    camX = camX;"]],
    "平移没能停在棋盘右下角"],
  ["clampCam 误返回数组 → setPos 静默失效",
    [["  return { x: camX, y: camY };", "  return [camX, camY];"]],
    "camera.setPos 收到非数字参数"],

  // ---------- 横竖屏功能对等 ----------
  ["藏掉帮助按钮 → 功能不对等",
    [['if (button(hb, cfg("labelHelp", "帮助"), bfs, MS.help ? "#cfe0ff" : null, "help")) {',
      'if (false) {']],
    "缺「帮助」"],
  ["删掉状态行 → 缺操作提示",
    [["text(statusLine(S), W / 2, msgY, L.fs, TEXT_DARK, \"center\");", "void 0;"]],
    "缺状态行"],
  ["删掉读数行 → 缺雷/旗/规格",
    [['text(readout, pad + 2, tipY, tipFs(L), TEXT_DARK, "left");', "void 0;"]],
    "缺雷/旗/规格读数"],
  ["删掉输入框登记 → 手机无法直接键入",
    [["syncInputField(it.id, fieldX, boxY, fieldW, fieldH, it.value, it.min, it.max, W);", "void 0;"]],
    "输入框不全"],
];

const results = [];
for (const [desc, pairs, expect] of MUTANTS) {
  let mutated = BASE_SRC;
  let missing = null;
  for (const [anchor, replacement] of pairs) {
    if (!mutated.includes(anchor)) { missing = anchor; break; }
    mutated = mutated.replace(anchor, replacement);
  }
  if (missing) {
    results.push({ desc, ok: false, why: `锚点已不存在，这条变异需要更新：${missing.slice(0, 48)}…` });
    continue;
  }
  const r = spawnSync(process.execPath, [HARNESS], {
    encoding: "utf8", cwd: ROOT, env: { ...process.env, BWE_MS_MUTANT: mutated },
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const hit = out.includes(expect);
  results.push({
    desc, ok: hit,
    why: hit ? "" : `注入后没有出现「${expect}」（harness 退出码=${r.status}）`,
  });
}

let bad = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✅ 抓到回归 · ${r.desc}`);
  else { bad++; console.log(`  ❌ 漏检 · ${r.desc} — ${r.why}`); }
}
console.log(`\n注入 ${MUTANTS.length} 条回归，抓到 ${results.length - bad} 条`);
if (bad) console.log("⚠ 有不变量失效：verify-minesweeper-ui.mjs 的绿色不可信，先修检查项。");
else console.log("✅ 检查项有效：改坏布局/安全一定会红");
process.exit(bad ? 1 : 0);
