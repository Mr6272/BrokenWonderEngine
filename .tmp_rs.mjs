import { readFileSync } from "node:fs";
const R = readFileSync("web/src/webplayer/renderer.ts", "utf8").split(/\r?\n/);
console.log("TOTAL " + R.length);
R.forEach((l, i) => { if (/^\s{2}(export |public )?[a-zA-Z]+\(|^export (class|interface|function|type)/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,130)); });
