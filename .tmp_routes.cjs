const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/\/api\/package-bwe/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,200)); });
console.log("TOTAL",L.length);
