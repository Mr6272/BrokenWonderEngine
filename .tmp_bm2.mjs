import { readFileSync } from "node:fs";
const L = readFileSync("src/Studio/runtime/ScriptApi.java", "utf8").split(/\r?\n/);
const i = L.findIndex((l) => /buildMine|mineState|\"mine\"/.test(l));
console.log("first hit at " + (i + 1));
console.log(L.slice(i - 2, i + 120).map((l, k) => (i - 1 + k) + "| " + l.slice(0, 180)).join("\n"));
