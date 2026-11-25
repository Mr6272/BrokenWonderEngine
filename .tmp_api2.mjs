import { readFileSync } from "node:fs";
const L = readFileSync("web/src/webplayer/api.ts", "utf8").split(/\r?\n/);
console.log(L.slice(78, 160).map((l, k) => (79 + k) + "| " + l.slice(0, 160)).join("\n"));
console.log("\n=== 366-402 ===");
console.log(L.slice(365, 402).map((l, k) => (366 + k) + "| " + l.slice(0, 160)).join("\n"));
