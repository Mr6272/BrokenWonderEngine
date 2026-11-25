import { readFileSync } from "node:fs";
const A = readFileSync("web/src/webplayer/api.ts", "utf8").split(/\r?\n/);
console.log("=== 136-232 ===");
console.log(A.slice(135, 232).map((l,k)=>(136+k)+"| "+l.slice(0,168)).join("\n"));
