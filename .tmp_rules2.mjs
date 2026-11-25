import { readFileSync } from "node:fs";
const buf = readFileSync("src/Studio/runtime/Minesweeper.java");
// 尝试 UTF-8，失败则按 GBK
let s;
try { s = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { s = new TextDecoder("gbk").decode(buf); }
const L = s.split(/\r?\n/);
const grab = (re, n) => { const i = L.findIndex((l) => re.test(l)); return i < 0 ? "NF " + re : L.slice(i, i + n).map((l, k) => (i + 1 + k) + "| " + l.replace(/\s+$/, "")).join("\n"); };
console.log(grab(/void reveal\(int idx\)/, 42));
console.log("\n===== openRegion =====");
console.log(grab(/void openRegion\(int start\)/, 12));
console.log("\n===== placeMines =====");
console.log(grab(/void placeMines\(int safeIdx\)/, 54));
console.log("\n===== checkWin =====");
console.log(grab(/void checkWin\(\)/, 16));
console.log("\n===== toggleFlag =====");
console.log(grab(/void toggleFlag\(int idx\)/, 14));
