import { readFileSync } from "node:fs";
const p = "web/src/webplayer/api.ts";
const s = readFileSync(p, "utf8");
const L = s.split(/\r?\n/);
console.log("lines:", L.length);
L.forEach((l, i) => {
  if (/^\s{0,2}(export |const |function |\/\/ ---|  [a-zA-Z]+: \{|  [a-zA-Z]+\(|NOT_IMPL|unimpl)/.test(l)) console.log((i+1)+"| "+l.slice(0,130));
});
