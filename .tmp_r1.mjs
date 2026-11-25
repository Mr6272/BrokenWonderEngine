import { readFileSync } from "node:fs";
const A = readFileSync("web/src/webplayer/api.ts", "utf8").split(/\r?\n/);
console.log("TOTAL " + A.length);
console.log("=== PlayerContext / 主入口 60-135 ===");
console.log(A.slice(59, 135).map((l,k)=>(60+k)+"| "+l.slice(0,165)).join("\n"));
