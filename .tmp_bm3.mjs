import { readFileSync } from "node:fs";
const L = readFileSync("src/Studio/runtime/ScriptApi.java", "utf8").split(/\r?\n/);
const i = L.findIndex((l) => /private void buildMine\(\)/.test(l));
console.log("buildMine() at " + (i + 1));
console.log(L.slice(i, i + 90).map((l, k) => (i + 1 + k) + "| " + l.slice(0, 180)).join("\n"));
