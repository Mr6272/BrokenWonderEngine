import { readFileSync } from "node:fs";
const L = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
const ns = new Map();
for (const m of L.join("\n").matchAll(/bwe\.(\w+)(?:\.(\w+))?/g)) {
  const k = m[1] + (m[2] ? "." + m[2] : "");
  ns.set(k, (ns.get(k) || 0) + 1);
}
console.log("=== bwe.* \u4f7f\u7528\u7edf\u8ba1 ===");
for (const [k, v] of [...ns].sort((a,b)=>b[1]-a[1])) console.log(String(v).padStart(4) + "  " + k);
console.log("\n=== fitCamera \u9644\u8fd1 ===");
const i = L.findIndex((l) => /function fitCamera/.test(l));
console.log(L.slice(i, i + 26).map((l, k) => (i + 1 + k) + "| " + l.slice(0, 150)).join("\n"));
