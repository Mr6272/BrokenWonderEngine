import { readFileSync } from "node:fs";
const sc = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8");
const lines = sc.split(/\r?\n/);
const hits = [];
lines.forEach((l, i) => { if (/bwe\.mine/.test(l)) hits.push((i+1) + "| " + l.trim().slice(0, 190)); });
console.log("=== bwe.mine \u7528\u6cd5 (" + hits.length + " \u5904) ===");
console.log(hits.join("\n"));

const d = readFileSync("web/src/js/bwe.d.ts", "utf8").split(/\r?\n/);
const grab = (re, n) => { const i = d.findIndex((l) => re.test(l)); return i < 0 ? "NOT FOUND " + re : d.slice(Math.max(0,i-2), i+n).map((l,k)=>(i-1+k)+"| "+l).join("\n"); };
console.log("\n=== d.ts mine ===");
console.log(grab(/namespace mine|mine:/, 40));
