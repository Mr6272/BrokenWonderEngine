const fs=require("fs");
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
B.forEach((l,i)=>{ if(/^export |^function |^async function |api\/package-bwe|platform/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });
console.log("TOTAL",B.length);
