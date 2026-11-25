import { readFileSync, writeFileSync } from "node:fs";
const p = "web/tools/verify-mine-rules.mjs";
let s = readFileSync(p, "utf8");
const a = s.indexOf("// ---------- 8.");
const b = s.indexOf("// ---------- 9.");
if (a < 0 || b < 0) { console.error("anchor miss"); process.exit(1); }
const repl = `// ---------- 8. winCondition = flag all（恰好标全雷才胜） ----------
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

`;
writeFileSync(p, s.slice(0, a) + repl + s.slice(b), "utf8");
console.log("patched");
