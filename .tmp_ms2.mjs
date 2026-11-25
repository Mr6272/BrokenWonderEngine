import { readFileSync } from "node:fs";
const M = readFileSync("src/Studio/runtime/Minesweeper.java", "utf8").split(/\r?\n/);
console.log(M.slice(192, 300).map((l, i) => (193 + i) + "| " + l.replace(/\s+$/, "").slice(0, 175)).join("\n"));
