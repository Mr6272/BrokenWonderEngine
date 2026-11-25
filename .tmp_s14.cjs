const fs=require("fs");
const lines=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
lines.forEach((l,i)=>{ if(/zip|Zip|archiver|Compress/i.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });
