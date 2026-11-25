const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
B.forEach((l,i)=>{ if(/^export |^function |^async function |^  (async )?function |openBwePackager|startJob|postJson|apiFetch|platform:/.test(l)) console.log((i+1)+"| "+ascii(l).trim().slice(0,140)); });
console.log("TOTAL",B.length);
