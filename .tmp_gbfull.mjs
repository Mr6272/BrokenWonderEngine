import { readFileSync } from "node:fs";
const G = readFileSync("src/Studio/runtime/GridBoard.java", "utf8").split(/\r?\n/);
console.log(G.map((l, i) => (i + 1) + "| " + l.replace(/\s+$/, "")).join("\n"));
