/**
 * 拖动画笔单测。
 *
 * 为什么必须断言：
 *   **工具栏提示写着"按住拖动画一条"，但 onDown 里 brush 放完一块就把 mode 设成
 *   none，onMove 根本没有 brush 分支。** 用户按下拖动时，画布落到 default 分支去
 *   执行框选，表面看起来"画笔不好用"，实际是"画笔从来没画过第二条"。
 *   这类缺陷截图看不出来（一格里确实有块），只有把指针序列跑一遍才能钉住。
 *
 *   第二个必须钉的点：拖动如果每落一块就 onCommit，一条 50 格的笔画会往撤销栈里
 *   压 50 个快照，用户按一次撤销只退一格。所以拖动期间必须 silent，
 *   松手时统一记一条。
 *
 * 跑法：
 *   node node_modules/esbuild/bin/esbuild web/tools/ui-checks/verify-brush-stroke.ts \
 *     --bundle --platform=node --format=esm --outfile=.tmp_ui/verify-brush.mjs
 *   node .tmp_ui/verify-brush.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const src = readFileSync(join(process.cwd(), "web/src/app/canvas.ts"), "utf8");

console.log("== 1. brush 进入拖动模式（而不是放一块就退出）==");
check(
  "brush 按下后设置 mode = brush",
  /store\.tool === "brush"[\s\S]{0,400}?this\.mode = "brush"/.test(src),
  "onDown 里没有把 mode 设成 brush，拖动不会继续铺"
);
check(
  "brush 按下不再直接把 mode 设成 none",
  !/store\.tool === "brush"[\s\S]{0,300}?this\.mode = "none"/.test(src),
  "brush 分支仍在放完一块后退出，拖动无效"
);

console.log("== 2. onMove 有 brush 分支，且走 silent 落子 ==");
check(
  "onMove 处理 brush 模式",
  /this\.mode === "brush"/.test(src),
  "onMove 里没有 brush 分支，拖动落到框选"
);
check(
  "brush 落子走 paintStrokeTo（内部 silent 落子）",
  /this\.mode === "brush"[\s\S]{0,200}?this\.paintStrokeTo\(world\)/.test(src),
  "拖动落子没有走笔画路径"
);
check(
  "paintStrokeTo 的每一笔都 silent",
  (src.match(/this\.placeAt\([^)]*false, true\)/g) ?? []).length >= 2,
  "笔画内部存在非静默落子，会逐格压撤销栈"
);

console.log("== 3. placeAt 支持静默，静默时不记撤销 ==");
check("placeAt 有 silent 参数", /private placeAt\(world: Point2, keepTool: boolean, silent = false\)/.test(src));
check(
  "silent 时跳过 onCommit",
  /if \(!silent\) this\.cb\.onCommit\?\.\("铺设地块"\)/.test(src),
  "静默落子仍然提交撤销，一条笔画会刷出几十条历史"
);

console.log("== 4. 拖动擦除同样成笔 ==");
check(
  "erase 按下后设置 mode = erase",
  /store\.tool === "erase"[\s\S]{0,600}?this\.mode = "erase"/.test(src),
  "擦除仍是一次性，拖不过去"
);
check("onMove 处理 erase 模式", /this\.mode === "erase"/.test(src), "拖动擦除无效");

console.log("== 5. 松手统一提交一条撤销 ==");
check(
  "onUp 收口 brush/erase 并记一条",
  /case "brush":\s*\n\s*case "erase":[\s\S]{0,400}?this\.cb\.onCommit\?\./.test(src),
  "松手没有提交，本轮笔画不进撤销栈，等于画完就丢"
);
check(
  "只在真的画过时才提交",
  /if \(this\.brushPainted\)/.test(src),
  "空点击也会记撤销，撤销栈会被噪声塞满"
);
check("松手后复位 brushPainted", /this\.brushPainted = false;/.test(src));

console.log("== 6. Mode 类型包含新状态（否则 tsc 会挂）==");
check(/type Mode = [^;]*"brush"/.test(src), "Mode 缺 brush");
check(/type Mode = [^;]*"erase"/.test(src), "Mode 缺 erase");

console.log("== 7. 快速拖动补齐格间路径（防虚线）==");
check(
  "onMove 的 brush 走 paintStrokeTo 而不是单点落子",
  /this\.mode === "brush"[\s\S]{0,160}?this\.paintStrokeTo\(world\)/.test(src),
  "仍按采样点落子，快速拖动会画成虚线"
);
check("存在 paintStrokeTo 实现", /private paintStrokeTo\(world: Point2\): void/.test(src));
check("用 Bresenham 补齐格间", /err = dx - dy/.test(src), "没有格间插值");
check(
  "按下时复位上一格",
  /this\.brushLastCell = null;[\s\S]{0,90}?this\.paintStrokeTo\(this\.pressWorld\)/.test(src),
  "没有复位 brushLastCell，第二笔会从上笔终点连一条线过去"
);
check(
  "松手复位上一格",
  /this\.brushPainted = false;\s*\n\s*this\.brushLastCell = null;/.test(src),
  "松手没复位，跨笔画会粘连"
);

// Bresenham 行为单元测试：复制同一算法，验证其数学性质
function bres(from: { gx: number; gy: number }, to: { gx: number; gy: number }) {
  const cells: { gx: number; gy: number }[] = [];
  let x0 = from.gx;
  let y0 = from.gy;
  const dx = Math.abs(to.gx - x0);
  const dy = Math.abs(to.gy - y0);
  const sx = x0 < to.gx ? 1 : -1;
  const sy = y0 < to.gy ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    cells.push({ gx: x0, gy: y0 });
    if (x0 === to.gx && y0 === to.gy) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
  return cells;
}

/**
 * 相邻判定用 Chebyshev 距离（8 邻域）：格子在边上或角上挨着都算相邻。
 * 对角笔画本来就该是角相邻——强迫 4 邻域会把一条直线画成鼓包，
 * Aseprite 和 Tiled 的直线笔都是这个行为。这里断言的是"没有跳格"，
 * 不是"必须边走"。
 */
function contiguous(cells: { gx: number; gy: number }[]): boolean {
  return cells.every((c, i) => {
    if (i === 0) return true;
    const dx = Math.abs(c.gx - cells[i - 1].gx);
    const dy = Math.abs(c.gy - cells[i - 1].gy);
    return dx <= 1 && dy <= 1 && dx + dy > 0;
  });
}

const hCells = bres({ gx: 0, gy: 0 }, { gx: 9, gy: 0 });
check("水平 10 格得到 10 个格", hCells.length === 10, `实际 ${hCells.length}`);
check("水平路径逐格相连（无跳格）", contiguous(hCells), "路径出现跨格跳跃，会画成虚线");

const dCells = bres({ gx: 0, gy: 0 }, { gx: 5, gy: 5 });
check("对角 5,5 得到 6 个格", dCells.length === 6, `实际 ${dCells.length}`);
check("对角路径每步相邻", contiguous(dCells));

const fastCells = bres({ gx: 3, gy: 3 }, { gx: 3, gy: 40 });
check("一次跳过 37 格时补齐全部中间格", fastCells.length === 38, `实际 ${fastCells.length}`);
check(
  "路径覆盖终点",
  fastCells[fastCells.length - 1].gx === 3 && fastCells[fastCells.length - 1].gy === 40
);
check("原地不动只落一格", bres({ gx: 7, gy: 7 }, { gx: 7, gy: 7 }).length === 1);


console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
