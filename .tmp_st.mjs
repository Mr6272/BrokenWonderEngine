import { readFileSync } from "node:fs";
const L = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
const show = (a,b) => console.log(L.slice(a-1,b).map((l,k)=>(a+k)+"| "+l.slice(0,165)).join("\n"));
console.log("=== 190-250 ===");
show(190, 250);
console.log("\n=== 330-350 ===");
show(330, 350);
console.log("\n=== 405-470 ===");
show(405, 470);
