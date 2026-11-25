import { readFileSync, writeFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const L = rd("src/Studio/runtime/Minesweeper.java").split(/\r?\n/);
const out = [];
const names = ["reveal(", "chordStandard(", "autoActionAt("];
for (const n of names) {
  let i = -1;
  for (let k = 0; k < L.length; k++) if (new RegExp("^\\s{4}(void|boolean|int|float)\\s+\\w*" + n.replace("(", "\\(")).test(L[k])) { i = k; break; }
  if (i < 0) { out.push("### " + n + " NOT FOUND"); continue; }
  let j = i + 1;
  while (j < L.length && !/^    (public|private|protected|static|void|boolean|int|float|final|@)/.test(L[j])) j++;
  out.push("### " + n + " @" + (i+1) + "-" + j);
  for (let k = i; k < j; k++) { const t = L[k].trim(); if (/^\*|^\/\*\*|^\/\//.test(t)) continue; out.push(L[k].replace(/\s+$/, "")); }
  out.push("");
}
writeFileSync(".tmp_reveal.txt", out.join("\n"), "utf8");
console.log(out.join("\n"));
