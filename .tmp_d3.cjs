const fs=require("fs");
const L=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/^export |^function |^async function |^  (async )?function |apiFetch\(|platform|downloadArtifact/.test(l)) console.log((i+1)+"| "+l.replace(/[^\x20-\x7E]/g,".").trim().slice(0,150)); });
console.log("TOTAL",L.length);
