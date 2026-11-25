const fs=require("fs");
const lines=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
lines.forEach((l,i)=>{ if(/^(export )?(async )?function|^export const|^export class|^\/\/ ----------/.test(l.trim())) console.log((i+1)+"| "+l.trim()); });
