const fs=require("fs");
const L=(f)=>fs.readFileSync(f,"utf8").split(/\r?\n/);
L("web/tools/api-core.mjs").forEach((l,i)=>{ if(/download|package-bwe|zipPath|binary:/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,180)); });
