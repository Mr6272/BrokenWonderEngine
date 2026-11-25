const fs=require("fs");
const A=(s)=>s.replace(/[^\x09\x0a\x20-\x7E]/g,".");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/startBtn|start\(|button\(|row\.appendChild|consoleBox|PackJob|result:|zipName|exeName/.test(l)) console.log((i+1)+"| "+A(l).trim().slice(0,150)); });
