import { readFileSync } from "node:fs";
const L = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
const pick = [];
L.forEach((l,i)=>{ if(/bwe\.mine\.(state|set|reset)/.test(l)) pick.push(i); });
const seen = new Set();
for (const i of pick) { const a = Math.max(0,i-4), b = Math.min(L.length,i+6); const k = a+"-"+b; if (seen.has(k)) continue; seen.add(k);
  console.log("--- @" + (i+1) + " ---");
  for (let x=a;x<b;x++) console.log((x+1)+"| "+L[x].slice(0,170));
}
