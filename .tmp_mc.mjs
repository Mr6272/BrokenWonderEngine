import { readFileSync, writeFileSync } from "node:fs";
const out = [];
// 1) ScriptApi 里 mine.state 的 JS 对象构造
const A = readFileSync("src/Studio/runtime/ScriptApi.java", "utf8").split(/\r?\n/);
const a = A.findIndex((l) => /buildMine\(\)/.test(l));
out.push("=== ScriptApi buildMine @" + (a+1) + " ===");
out.push(A.slice(a, a + 95).map((l, k) => (a + 1 + k) + "| " + l.slice(0, 175)).join("\n"));
// 2) Minesweeper 的公开方法与绘制入口
const M = readFileSync("src/Studio/runtime/Minesweeper.java", "utf8").split(/\r?\n/);
out.push("\n=== Minesweeper \u65b9\u6cd5\u6e05\u5355 ===");
M.forEach((l, i) => { if (/^\s{4}(public|private|static|protected)[\w\s<>\[\],.]*\s+\w+\s*\(/.test(l)) out.push((i+1) + "| " + l.trim().slice(0, 150)); });
writeFileSync(".tmp_mine_contract.txt", out.join("\n"), "utf8");
console.log(out.join("\n"));
