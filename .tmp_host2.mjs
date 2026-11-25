import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
function walk(d, out=[]) { for (const e of readdirSync(d,{withFileTypes:true})) { const p = join(d,e.name); if (e.isDirectory()) { if(!/node_modules|\.git|\.tmp/.test(e.name)) walk(p,out);} else if (e.name.endsWith(".java")) out.push(p);} return out; }
const files = walk("src");
for (const f of files) {
  const buf = readFileSync(f);
  let s; try { s = new TextDecoder("utf-8",{fatal:true}).decode(buf); } catch { s = new TextDecoder("gbk").decode(buf); }
  if (!/new Minesweeper\(|minesweeper\.click|minesweeper\.draw|host\.minesweeper\s*=/.test(s)) continue;
  console.log("### " + f.replace(/\\/g,"/"));
  s.split(/\r?\n/).forEach((l,i)=>{ if(/new Minesweeper\(|minesweeper\.click|minesweeper\.draw|host\.minesweeper\s*=|\.minesweeper\.update|module\.minesweeper|game\.minesweeper/.test(l)) console.log("  "+(i+1)+"| "+l.trim().slice(0,150)); });
}
