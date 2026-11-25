const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const A=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log("##### api-core 860-975");
for(let i=859;i<Math.min(975,A.length);i++) console.log((i+1)+"| "+ascii(A[i]));
