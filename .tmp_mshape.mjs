import { readFileSync } from "node:fs";
const L = readFileSync("src/Studio/runtime/Minesweeper.java", "utf8").split(/\r?\n/);
console.log("TOTAL", L.length);
L.forEach((l, i) => { if (/^\s{4}(public|private|protected|static)?\s*[\w<>\[\], ]+\s+\w+\s*\([^;]*$|^\s{4}(final|static final)\s/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,140)); });
