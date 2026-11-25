const fs=require("fs");
const ascii=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const A=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
A.forEach((l,i)=>{ if(/^import|^const .*require|package-bwe/.test(l)) console.log((i+1)+"| "+ascii(l).trim().slice(0,160)); });
