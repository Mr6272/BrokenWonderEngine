const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/zipPath|zipName|Compress|archive/i.test(l)) console.log((i+1)+"| "+ascii(l).trim().slice(0,140)); });
console.log("--- exports ---");
L.forEach((l,i)=>{ if(/^export /.test(l)) console.log((i+1)+"| "+ascii(l).trim().slice(0,140)); });
