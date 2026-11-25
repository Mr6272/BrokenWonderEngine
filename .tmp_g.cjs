const fs=require("fs");
const s=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
s.forEach((l,i)=>{ if(/\/api\/package/.test(l)) console.log((i+1)+"| "+l.trim()); });
