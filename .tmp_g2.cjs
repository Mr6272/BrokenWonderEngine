const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
const hits=[];
L.forEach((l,i)=>{ if(/package-bwe/.test(l)) hits.push((i+1)+"| "+A(l).trim().slice(0,110)); });
process.stdout.write(hits.join("\n"));
