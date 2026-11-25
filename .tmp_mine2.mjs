import { readFileSync } from "node:fs";
const d = readFileSync("web/src/js/bwe.d.ts", "utf8").split(/\r?\n/);
for (const name of ["MineConfig", "MineState"]) {
  const i = d.findIndex((l) => new RegExp("(interface|type) " + name + "\\b").test(l));
  console.log("=== " + name + " @" + i + " ===");
  if (i >= 0) console.log(d.slice(i, i + 40).map((l, k) => (i + 1 + k) + "| " + l).join("\n"));
}
// 脚本里实际用到的字段
const sc = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8");
const st = new Set();
for (const m of sc.matchAll(/(?:\bst|\bs0|S)\.(\w+)/g)) st.add(m[1]);
console.log("\n\u811a\u672c\u8bfb\u5199\u7684 state \u5b57\u6bb5: " + [...st].sort().join(", "));
const m2 = sc.match(/bwe\.mine\.set\(\{[\s\S]{0,320}?\}\)/);
console.log("\nset() \u53c2\u6570\u793a\u4f8b:\n" + (m2 ? m2[0] : "none"));
