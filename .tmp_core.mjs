import { readFileSync } from "node:fs";
const buf = readFileSync("src/Studio/runtime/Minesweeper.java");
let s; try { s = new TextDecoder("utf-8",{fatal:true}).decode(buf); } catch { s = new TextDecoder("gbk").decode(buf); }
const L = s.split(/\r?\n/);
// 只打代码行，去掉注释行以压缩体积
const out = [];
L.forEach((l, i) => {
  const t = l.trim();
  if (/^\*|^\/\*\*|^\/\//.test(t)) return;
  if (i >= 185 && i <= 470) out.push((i+1) + "| " + l.replace(/\s+$/, ""));
});
console.log(out.join("\n"));
