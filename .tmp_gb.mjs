import { readFileSync, writeFileSync } from "node:fs";
const out = [];
const G = readFileSync("src/Studio/runtime/GridBoard.java", "utf8").split(/\r?\n/);
out.push("========== GridBoard.java (" + G.length + ") ==========");
out.push(G.map((l, i) => (i + 1) + "| " + l.replace(/\s+$/, "")).join("\n"));
writeFileSync(".tmp_gridboard.txt", out.join("\n"), "utf8");
console.log("wrote .tmp_gridboard.txt lines=" + G.length);
