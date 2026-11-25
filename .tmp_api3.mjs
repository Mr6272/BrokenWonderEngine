import { readFileSync } from "node:fs";
const L = readFileSync("web/src/webplayer/api.ts", "utf8").split(/\r?\n/);
console.log("=== api.ts 160-272 ===");
console.log(L.slice(159, 272).map((l, k) => (160 + k) + "| " + l.slice(0, 165)).join("\n"));
