import { readFileSync } from "node:fs";
const R = readFileSync("web/src/webplayer/renderer.ts", "utf8").split(/\r?\n/);
console.log(R.slice(175, 300).map((l,k)=>(176+k)+"| "+l).join("\n"));
