import { readFileSync } from "node:fs";
const L = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
const i = L.findIndex((l) => /function onUpdate/.test(l));
const j = L.findIndex((l) => /function onSceneStart/.test(l));
console.log("onSceneStart@" + (j+1) + " onUpdate@" + (i+1) + " total=" + L.length);
console.log("=== onUpdate ===");
console.log(L.slice(i, i + 60).map((l, k) => (i + 1 + k) + "| " + l.slice(0, 160)).join("\n"));
