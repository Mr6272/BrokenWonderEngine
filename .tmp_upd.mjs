import { readFileSync } from "node:fs";
const L = readFileSync("web/.build/packages/web_test_1/out/Build/scripts/minesweeper.js", "utf8").split(/\r?\n/);
console.log("=== onUpdate \u533a\u57df ===");
const i = L.findIndex((l) => /function onUpdate/.test(l));
console.log("at " + (i + 1));
console.log(L.slice(i, i + 75).map((l, k) => (i + 1 + k) + "| " + l.slice(0, 165)).join("\n"));
