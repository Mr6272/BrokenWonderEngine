const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const s=L.findIndex(l=>/^export async function packageWeb/.test(l));
const e=L.findIndex((l,i)=>i>s && /^export /.test(l));
console.log("S",s+1,"E",e+1);
for(let i=s;i<e;i++) console.log((i+1)+"| "+ascii(L[i]));
