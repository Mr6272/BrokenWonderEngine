const fs=require("fs");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/^export |^function |^async function |platform|downloadArtifact|apkPath|zipName|outDir|variant/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,170)); });
