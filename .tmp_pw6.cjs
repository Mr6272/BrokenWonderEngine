const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
for(let i=2096;i<2146;i++) console.log((i+1)+"| "+A(L[i]));
