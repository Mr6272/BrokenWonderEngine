import { readFileSync } from "node:fs";
const A = readFileSync("web/src/webplayer/api.ts", "utf8").split(/\r?\n/);
console.log("=== 330-445 ===");
console.log(A.slice(329, 445).map((l, k) => (330 + k) + "| " + l.slice(0, 155)).join("\n"));
