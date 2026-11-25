import { readFileSync } from "node:fs";
const S = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8");
const L = S.split(/\r?\n/);
console.log("=== \u5305\u542b cell/flags/grid \u7684\u884c ===");
L.forEach((l,i)=>{ if(/\bcells\b|\.flags\b|bwe\.mine|revealed|\.open\b/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });
