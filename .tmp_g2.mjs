import { readFileSync } from "node:fs";
const A = readFileSync("web/src/webplayer/api.ts", "utf8").split(/\r?\n/);
const i = A.findIndex((l) => /audio/i.test(l));
console.log("audio first at " + (i+1));
console.log(A.slice(Math.max(0,i-10), i+45).map((l,k)=>(Math.max(0,i-10)+1+k)+"| "+l.slice(0,150)).join("\n"));
