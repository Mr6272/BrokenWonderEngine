import { readFileSync } from "node:fs";
const L = readFileSync("web/src/webplayer/api.ts", "utf8").split(/\r?\n/);
console.log("=== api.ts 96-135 (PlayerContext) ===");
console.log(L.slice(95, 135).map((l, k) => (96 + k) + "| " + l.slice(0, 150)).join("\n"));
console.log("\n=== api.ts 224-300 (draw) ===");
console.log(L.slice(223, 300).map((l, k) => (224 + k) + "| " + l.slice(0, 150)).join("\n"));
console.log("\n=== api.ts 360-400 (unimpl) ===");
console.log(L.slice(359, 400).map((l, k) => (360 + k) + "| " + l.slice(0, 150)).join("\n"));
