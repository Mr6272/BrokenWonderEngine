import { readFileSync } from "node:fs";
const A = readFileSync("web/src/webplayer/api.ts", "utf8").split(/\r?\n/);
console.log("=== 300-452 ===");
console.log(A.slice(299, 452).map((l,k)=>(300+k)+"| "+l.slice(0,168)).join("\n"));
