import { readFileSync, writeFileSync } from "node:fs";
const M = readFileSync("src/Studio/runtime/Minesweeper.java", "utf8").split(/\r?\n/);
writeFileSync(".tmp_ms.txt", M.map((l, i) => (i + 1) + "| " + l.replace(/\s+$/, "")).join("\n"), "utf8");
// 方法索引
M.forEach((l, i) => { if (/^\s{4}[A-Za-z][\w<>\[\], ]*\s+\w+\s*\([^;]*\{\s*$/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,140)); });
