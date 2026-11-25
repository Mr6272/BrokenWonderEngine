import { readFileSync } from "node:fs";
const L = readFileSync("web/src/webplayer/api.ts", "utf8").split(/\r?\n/);
const i = L.findIndex((l) => /draw:\s*\{|const draw\s*=|function makeDraw/.test(l));
console.log("draw at " + (i + 1));
console.log(L.slice(i - 3, i + 95).map((l, k) => (i - 2 + k) + "| " + l.slice(0, 150)).join("\n"));
