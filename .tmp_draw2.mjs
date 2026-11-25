import { readFileSync } from "node:fs";
const s = readFileSync("web/src/webplayer/api.ts", "utf8");
const L = s.split(/\r?\n/);
console.log("TOTAL LINES", L.length);
L.forEach((l, i) => {
  if (/^\s{2,6}(draw|circle|rect|text|measureText|world|input|camera|audio|time|Entity|mine|textinput)\b\s*[:(]/.test(l) || /^\s*\/\/\s*[-=]{2,}/.test(l) || /^\s*none\(|^\s*stub\(|Name:/.test(l))
    console.log((i + 1) + "| " + l.slice(0, 150));
});
