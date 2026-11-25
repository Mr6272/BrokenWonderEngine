const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/^export |^async function |^function /.test(l)) console.log((i+1)+"| "+l.trim().slice(0,140)); });
console.log("TOTAL",L.length);
