const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
for(let i=705;i<Math.min(802,L.length);i++) console.log((i+1)+"| "+A(L[i]));
