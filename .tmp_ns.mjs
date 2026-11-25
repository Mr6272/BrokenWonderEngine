import { readFileSync } from "node:fs";
const sc = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8");
const ns = new Map();
for (const m of sc.matchAll(/bwe\.(\w+)(?:\.(\w+))?/g)) {
  const k = m[1] + (m[2] ? "." + m[2] : "");
  ns.set(k, (ns.get(k) || 0) + 1);
}
const rows = [...ns.entries()].sort((a, b) => b[1] - a[1]);
console.log("=== \u811a\u672c\u7528\u5230\u7684 bwe.* (" + rows.length + " \u4e2a\u540d\u5b57) ===");
for (const [k, v] of rows) console.log(String(v).padStart(4) + "  " + k);
