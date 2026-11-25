const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/zipPath|zipName|sizeBytes|function zip|Compress|adm-zip|yazl|archiver/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,170)); });
