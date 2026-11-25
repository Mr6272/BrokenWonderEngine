import { readFileSync } from "node:fs";
const P = readFileSync("web/src/webplayer/player.ts", "utf8").split(/\r?\n/);
const i = P.findIndex((l) => /loadAssets|for \(const a of|assets/.test(l));
console.log("=== player.ts 55-100 ===");
console.log(P.slice(54, 100).map((l, k) => (55 + k) + "| " + l.slice(0, 155)).join("\n"));
