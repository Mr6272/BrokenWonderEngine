const fs=require("fs");
const a=process.argv[2]|0,b=process.argv[3]|0;
const L=fs.readFileSync(process.argv[4]||"web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
for(let i=a-1;i<Math.min(b,L.length);i++) console.log((i+1)+"| "+L[i].replace(/[^\x09\x0a\x20-\x7E]/g,"."));
