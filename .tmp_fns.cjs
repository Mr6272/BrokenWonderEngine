const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/^export |^  (async )?function |^function |^  [a-zA-Z]+\(|=> \{/.test(l) && /function|export/.test(l)) console.log((i+1)+"| "+ascii(l).trim().slice(0,140)); });
console.log("TOTAL",L.length);
