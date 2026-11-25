import { readFileSync, writeFileSync } from "node:fs";
const M = readFileSync("src/Studio/runtime/Minesweeper.java", "utf8").split(/\r?\n/);
// 打印 1-195 (字段 + 构造 + reset/placeMines)
console.log(M.slice(0, 195).map((l, i) => (i + 1) + "| " + l.replace(/\s+$/, "")).join("\n"));
