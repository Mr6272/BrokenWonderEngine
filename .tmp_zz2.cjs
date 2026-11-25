const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/zip|Zip|tar|Compress|archive/i.test(l)) console.log((i+1)+"| "+A(l).trim()); });
