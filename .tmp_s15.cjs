const fs=require("fs");
const lines=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(lines.slice(1398,1440).map((l,i)=>(1399+i)+"| "+l).join("\n"));
console.log("=== run() ===");
lines.forEach((l,i)=>{ if(/^function run\(|^async function run\(/.test(l)) console.log((i+1)+"| "+l); });
