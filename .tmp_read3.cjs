const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
for(let i=419;i<560;i++) console.log((i+1)+"| "+A(B[i]));
