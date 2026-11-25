import { readFileSync } from "node:fs";
const L = readFileSync("src/Studio/runtime/ScriptApi.java", "utf8").split(/\r?\n/);
const i = L.findIndex((l) => l.includes('"mine"'));
console.log("mine at line " + (i + 1));
console.log(L.slice(i - 4, i + 110).map((l, k) => (i - 3 + k) + "| " + l.slice(0, 175)).join("\n"));
