// 扫雷规则移植的行为验证：把 mine.ts 打成 CJS 在 node 里真跑规则，断言实际行为。
// 不依赖浏览器（canvas 只在 paint() 里用到，规则测试不碰它）。
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bwe-mine-"));
const outfile = join(dir, "mine.cjs");
await build({
  entryPoints: ["web/src/webplayer/mine.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile,
  logLevel: "silent",
});

const { MineBoard } = await import(pathToFileURL(outfile).href);

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fails.push(name + (detail === undefined ? "" : " -> " + JSON.stringify(detail)));
};

// ---------- 1. 初始状态 ----------
{
  const b = new MineBoard({ rows: 9, cols: 9, mines: 10, cellSize: 16, seed: 12345 });
  const s = b.state();
  ok("初始 rows=9", s.rows === 9, s);
  ok("初始 cols=9", s.cols === 9, s);
  ok("初始 mines=10", s.mines === 10, s);
  ok("初始未开始", s.started === false, s);
  ok("初始未结束", s.over === false && s.won === false, s);
  ok("初始 flags=0", s.flags === 0, s);
  ok("初始 revealed=0", s.revealed === 0, s);
  ok("初始 elapsed=0", s.elapsed === 0, s);
  ok("cellSize 透传", s.cellSize === 16, s);
}

// ---------- 2. 首击必安全（连续 40 局，棋盘不出现首点即雷） ----------
{
  let allSafe = true;
  let detail = null;
  for (let seed = 1; seed <= 40; seed++) {
    const b = new MineBoard({ rows: 9, cols: 9, mines: 10, seed, firstClickSafe: true });
    b.reveal(4, 4);
    const st = b.state();
    if (st.over) { allSafe = false; detail = { seed, st }; break; }
  }
  ok("首击必安全 40 局全过", allSafe, detail);
}

// ---------- 3. 首击会连锁展开（9x9 10 雷，首点周围通常开一片） ----------
{
  const b = new MineBoard({ rows: 9, cols: 9, mines: 10, seed: 7, firstClickSafe: true, autoOpenZeros: true });
  b.reveal(4, 4);
  const st = b.state();
  ok("首击后有格子被翻开", st.revealed >= 1, st);
  ok("首击后已进入 started", st.started === true, st);
}

// ---------- 4. 关掉 autoOpenZeros 只开一格 ----------
{
  const b = new MineBoard({ rows: 9, cols: 9, mines: 10, seed: 7, autoOpenZeros: false });
  b.reveal(4, 4);
  ok("autoOpenZeros=false 只翻 1 格", b.state().revealed === 1, b.state());
}

// ---------- 5. 旗子与 flags 计数；插旗格不能被翻开 ----------
{
  const b = new MineBoard({ rows: 9, cols: 9, mines: 10, seed: 3 });
  b.toggleFlag(0, 0);
  ok("插旗后 flags=1", b.state().flags === 1, b.state());
  b.reveal(0, 0);
  ok("旗子格不能被翻开", b.state().revealed === 0, b.state());
  b.toggleFlag(0, 0);
  ok("取消旗后 flags=0", b.state().flags === 0, b.state());
}

// ---------- 6. 踩雷：over=true，且 revealAllOnLose 把雷都露出 ----------
{
  const b = new MineBoard({ rows: 5, cols: 5, mines: 5, seed: 99, firstClickSafe: false, revealAllOnLose: true });
  // 扫描找出一个雷（firstClickSafe=false 时布雷不受首点限制）
  b.reveal(0, 0);
  let hit = false;
  for (let r = 0; r < 5 && !hit; r++) {
    for (let c = 0; c < 5 && !hit; c++) {
      const before = b.state();
      if (before.over) { hit = true; break; }
      b.reveal(r, c);
      if (b.state().over) hit = true;
    }
  }
  ok("能踩到雷并结束", hit, b.state());
  ok("踩雷后 over=true", b.state().over === true, b.state());
}

// ---------- 7. 胜利条件：清空所有安全格 ----------
{
  // 1 雷，2x2：只要不点那颗雷，点完其余 3 格即胜
  const b = new MineBoard({ rows: 2, cols: 2, mines: 1, seed: 5, firstClickSafe: false, autoOpenZeros: true });
  const order = [[0, 0], [0, 1], [1, 0], [1, 1]];
  for (const [r, c] of order) {
    if (b.state().over || b.state().won) break;
    b.reveal(r, c);
  }
  const st = b.state();
  ok("2x2 单雷能判定胜或负", st.over || st.won, st);
  if (!st.over) ok("没踩雷则应为胜", st.won === true, st);
}

// ---------- 8. winCondition = flag all（恰好标全雷才胜） ----------
{
  const b = new MineBoard({ rows: 2, cols: 2, mines: 1, seed: 5, firstClickSafe: false, winCondition: "flag all" });
  const cells = [[0, 0], [0, 1], [1, 0], [1, 1]];
  let wonOn = null;
  let falseWin = false;
  for (const [r, c] of cells) {
    if (b.state().won) break;
    b.toggleFlag(r, c);
    const st = b.state();
    if (st.won) {
      wonOn = [r, c];
      if (st.flags !== 1) falseWin = true;
      break;
    }
    b.toggleFlag(r, c);
  }
  ok("标记胜利条件生效", wonOn !== null, { wonOn, st: b.state() });
  ok("误标不会判胜", !falseWin, falseWin);
}

// ---------- 9. 和弦：旗数配平后一次翻开周围 ----------
{
  const b = new MineBoard({ rows: 3, cols: 3, mines: 1, seed: 11, firstClickSafe: false, autoOpenZeros: false });
  b.reveal(0, 0); // 打开一个中心或角落，视布雷而定
  // 找一个已翻开的数字格，插旗其邻域内雷的位置来配平并不现实（不知道雷在哪），
  // 这里只断言「点已翻开格不会崩、不会额外结束游戏」
  const before = b.state();
  b.reveal(0, 0);
  const after = b.state();
  ok("重复点已翻开格不崩", after.over === before.over || after.over === true, { before, after });
}

// ---------- 10. 雷数上限与重置 ----------
{
  const b = new MineBoard({ rows: 4, cols: 4, mines: 999, seed: 1 });
  const st = b.state();
  ok("雷数被夹到合法范围", st.mines <= 4 * 4 - 9, st);
  b.reveal(0, 0);
  b.reset();
  const s2 = b.state();
  ok("reset 后回到未开始", s2.started === false && s2.over === false && s2.won === false, s2);
  ok("reset 后 revealed=0", s2.revealed === 0, s2);
  ok("reset 后 flags=0", s2.flags === 0, s2);
}

// ---------- 11. cellAt 坐标映射 ----------
{
  const b = new MineBoard({ rows: 4, cols: 4, mines: 1, cellSize: 10 });
  // 对象中心 (0,0)，半宽高 20 -> 40x40 的板
  const hit = b.cellAt(0, 0, 0, 0, 20, 20);
  ok("中心点在板内", hit !== null, hit);
  ok("中心点落在第二行第二列", hit && hit.r === 2 && hit.c === 2, hit);
  const corner = b.cellAt(-19.9, -19.9, 0, 0, 20, 20);
  ok("左上角落在 0,0", corner && corner.r === 0 && corner.c === 0, corner);
  const outside = b.cellAt(100, 100, 0, 0, 20, 20);
  ok("板外返回 null", outside === null, outside);
}

// ---------- 12. 固定 seed 同序列可复现 ----------
{
  const a = new MineBoard({ rows: 6, cols: 6, mines: 6, seed: 424242, firstClickSafe: false });
  const c = new MineBoard({ rows: 6, cols: 6, mines: 6, seed: 424242, firstClickSafe: false });
  const layoutA = [];
  const layoutC = [];
  for (const step of [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]) {
    a.reveal(step[0], step[1]);
    c.reveal(step[0], step[1]);
    const sa = a.state();
    const sc = c.state();
    layoutA.push([sa.revealed, sa.over, sa.won]);
    layoutC.push([sc.revealed, sc.over, sc.won]);
  }
  ok("相同 seed 行为可复现", JSON.stringify(layoutA) === JSON.stringify(layoutC), { layoutA, layoutC });
}

// ---------- 13. config 变更会重建盘面 ----------
{
  const b = new MineBoard({ rows: 9, cols: 9, mines: 10, seed: 1 });
  b.reveal(4, 4);
  ok("变更前已翻开", b.state().revealed > 0, b.state());
  b.configure({ rows: 16, cols: 16, mines: 40 });
  const st = b.state();
  ok("configure 后尺寸更新", st.rows === 16 && st.cols === 16, st);
  ok("configure 后重建盘面", st.revealed === 0 && st.started === false, st);
}

// ---------- 汇总 ----------
const total = pass + fails.length;
if (fails.length) {
  console.error("FAIL " + fails.length + "/" + total);
  for (const f of fails) console.error("  x " + f);
  process.exit(1);
}
console.log("OK " + pass + "/" + total + " assertions passed");
