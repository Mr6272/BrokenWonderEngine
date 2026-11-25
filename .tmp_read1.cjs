const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const P=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
const z=P.findIndex(l=>/function zipApp/.test(l));
console.log("### zipApp at", z+1);
for(let i=z-6;i<z+34;i++) console.log((i+1)+"| "+A(P[i]));
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log("### packageBwe.ts 60-180");
for(let i=59;i<180;i++) console.log((i+1)+"| "+A(B[i]));
