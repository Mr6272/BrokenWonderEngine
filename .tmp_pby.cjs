const fs=require("fs");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/platform|uploadedAssets|gatherAssets|JSON\.stringify|downloadArtifact\(|jobs\/|apiFetch\(/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });
