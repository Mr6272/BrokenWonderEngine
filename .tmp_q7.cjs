const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const api=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log("### api-core 1-40");
for(let i=0;i<40;i++) console.log((i+1)+"| "+A(api[i]));
const p=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log("### pkg zip matches");
p.forEach((l,i)=>{ if(/zip/i.test(l)) console.log((i+1)+"| "+A(l).trim().slice(0,130)); });
