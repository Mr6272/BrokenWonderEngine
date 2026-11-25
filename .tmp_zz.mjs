import { readFileSync } from "node:fs";
const S = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8");
const L = S.split(/\r?\n/);
const ns = new Map();
for (const m of S.matchAll(/bwe\.(\w+)(?:\.(\w+))?/g)) { const k = m[1] + (m[2] ? "." + m[2] : ""); ns.set(k, (ns.get(k) || 0) + 1); }
console.log("=== bwe.* \u7528\u91cf ===");
for (const [k, v] of [...ns].sort((a,b)=>b[1]-a[1])) console.log(String(v).padStart(4) + "  " + k);
console.log("\n=== \u662f\u5426\u811a\u672c\u81ea\u5df1\u753b\u68cb\u76d8\uff08\u627e draw \u8c03\u7528\u4e0a\u4e0b\u6587\uff09===");
let n = 0;
L.forEach((l, i) => { if (/bwe\.draw\./.test(l) && n++ < 8) console.log((i+1)+"| "+l.trim().slice(0,150)); });
console.log("\n=== mine.set \u8c03\u7528 ===");
L.forEach((l, i) => { if (/bwe\.mine\.set/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,300)); });
