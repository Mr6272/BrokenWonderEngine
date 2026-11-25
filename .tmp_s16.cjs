const fs=require("fs");
const s=fs.readFileSync("web/tools/package-bwe.mjs","utf8");
const i=s.indexOf("export async function packageWeb");
const rest=s.slice(i);
const j=rest.indexOf("\nexport ",10);
const fn= j>0? rest.slice(0,j) : rest;
console.log("FN LEN",fn.length);
console.log(fn.slice(1900));
