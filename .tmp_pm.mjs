import { readFileSync } from "node:fs";
const M = readFileSync("src/Studio/runtime/Minesweeper.java", "utf8").split(/\r?\n/);
const a = M.findIndex((l) => /void placeMines\s*\(/.test(l));
const b = M.findIndex((l) => /void openRegion\s*\(/.test(l));
console.log("placeMines@" + (a+1) + " openRegion@" + (b+1));
console.log(M.slice(a, a + 70).map((l, i) => (a + 1 + i) + "| " + l.replace(/\s+$/, "").slice(0, 170)).join("\n"));
console.log("\n--- openRegion ---");
console.log(M.slice(b, b + 55).map((l, i) => (b + 1 + i) + "| " + l.replace(/\s+$/, "").slice(0, 170)).join("\n"));
