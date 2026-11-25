import { readFileSync } from "node:fs";
const s = readFileSync("web/src/webplayer/player.ts", "utf8").split(/\r?\n/);
const i = s.findIndex((l) => /loadAssets|assets\.map|createImage/.test(l));
console.log(s.slice(Math.max(0,i-8), i+45).map((l,k)=>(Math.max(0,i-8)+1+k)+"| "+l).join("\n"));
