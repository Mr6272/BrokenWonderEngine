const fs=require("fs");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/^export |platform|downloadArtifact|apkPath|zipName|api\/package-bwe|fetch\(/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,170)); });
console.log("TOTAL",L.length);
