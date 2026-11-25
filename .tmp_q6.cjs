const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
for(let i=859;i<Math.min(960,L.length);i++) console.log((i+1)+"| "+A(L[i]));
