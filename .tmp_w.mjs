import { readFileSync, writeFileSync } from "node:fs";
const s = readFileSync("web/src/webplayer/api.ts", "utf8");
writeFileSync(".tmp_api_full.txt", s.split(/\r?\n/).map((l,i)=>(i+1)+"| "+l).join("\n"), "utf8");
console.log("lines:", s.split(/\r?\n/).length);
