import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git|\.tmp/.test(e.name)) walk(p, out); }
    else if (e.name.endsWith(".java")) out.push(p);
  }
  return out;
}
const files = walk("src");
const hits = [];
for (const f of files) {
  const s = readFileSync(f, "utf8");
  if (/minesweeper/.test(s) && !/Minesweeper\.java$/.test(f)) {
    s.split(/\r?\n/).forEach((l, i) => {
      if (/minesweeper\s*[.;=)]|Minesweeper\s+\w|new Minesweeper|\.paint|\.render|\.click|\.reveal|\.flag/.test(l))
        hits.push(f.replace(/\\/g, "/") + ":" + (i + 1) + "  " + l.trim().slice(0, 140));
    });
  }
}
console.log(hits.slice(0, 60).join("\n"));
console.log("\ntotal", hits.length);
