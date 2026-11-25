import { readFileSync } from "node:fs";
const S = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8");
const L = S.split(/\r?\n/);
L.forEach((l, i) => { if (/bwe\.mine/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,170)); });
const idx = [];
L.forEach((l,i)=>{ if(/bwe\.mine/.test(l)) idx.push(i); });
if (idx.length) {
  console.log("\n=== \u4e0a\u4e0b\u6587 1 ===");
  const a = Math.max(0, idx[0]-25), b = Math.min(L.length, idx[0]+25);
  console.log(L.slice(a,b).map((l,k)=>(a+1+k)+"| "+l.slice(0,160)).join("\n"));
}
