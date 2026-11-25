import { readFileSync, writeFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); try { return new TextDecoder("utf-8",{fatal:true}).decode(b); } catch { return new TextDecoder("gbk").decode(b); } };
const L = rd("src/Studio/runtime/Minesweeper.java").split(/\r?\n/);
const want = ["void reset(", "void placeMines(", "boolean click(", "boolean reveal(", "void openRegion(", "void toggleFlag(", "void checkWin(", "void update(", "void chord("];
const out = [];
for (const w of want) {
  const i = L.findIndex((l) => l.includes(w));
  if (i < 0) { out.push("### " + w + " NOT FOUND"); continue; }
  // 找结束（下一行 4 空格 + 修饰符）
  let j = i + 1;
  while (j < L.length && !/^    (public|private|protected|static|void|boolean|int|final|@)/.test(L[j])) j++;
  out.push("### " + w.trim() + " @" + (i+1) + "-" + j);
  for (let k = i; k < j; k++) {
    const t = L[k].trim();
    if (/^\*|^\/\*\*|^\/\//.test(t)) continue;
    out.push(L[k].replace(/\s+$/, ""));
  }
  out.push("");
}
writeFileSync(".tmp_rules_final.txt", out.join("\n"), "utf8");
console.log("lines:", out.length);
