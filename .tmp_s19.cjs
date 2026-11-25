const fs=require("fs");
const L=(f)=>fs.readFileSync(f,"utf8").split(/\r?\n/);
console.log("=== api-core imports ===");
L("web/tools/api-core.mjs").forEach((l,i)=>{ if(/^import|require\(/.test(l)) console.log((i+1)+"| "+l); });
console.log("=== packageBwe.ts structure ===");
L("web/src/app/packageBwe.ts").forEach((l,i)=>{ if(/^(export )?(async )?function |^export const |^export class |platform|downloadArtifact|apkPath|outDir/.test(l.trim())) console.log((i+1)+"| "+l.trim().slice(0,160)); });
