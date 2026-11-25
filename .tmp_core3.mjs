import { readFileSync } from "node:fs";
const buf = readFileSync("src/Studio/runtime/Minesweeper.java");
let s; try { s = new TextDecoder("utf-8",{fatal:true}).decode(buf); } catch { s = new TextDecoder("gbk").decode(buf); }
const L = s.split(/\r?\n/);
const out = [];
L.forEach((l, i) => {
  const t = l.trim();
  if (/^\*|^\/\*\*|^\/\//.test(t)) return;
  if (i >= 640 && i <= 790) out.push((i+1) + "| " + l.replace(/\s+$/, ""));
});
console.log(out.join("\n"));
