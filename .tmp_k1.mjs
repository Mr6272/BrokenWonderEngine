import { readFileSync } from "node:fs";
const S = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
console.log("=== 400-470 ===");
console.log(S.slice(399, 470).map((l,k)=>(400+k)+"| "+l.slice(0,160)).join("\n"));
