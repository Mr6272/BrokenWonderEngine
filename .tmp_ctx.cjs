const fs=require("fs");
const A=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log("### api-core 1-45");
console.log(A.slice(0,45).map((l,i)=>(1+i)+"| "+l).join("\n"));
const B=fs.readFileSync("web/src/app/packageBwe.ts","utf8").split(/\r?\n/);
console.log("### packageBwe.ts exports / api refs");
B.forEach((l,i)=>{ if(/^export |api\/package-bwe|platform:|function downloadArtifact/.test(l)) console.log((i+1)+"| "+l.trim().slice(0,150)); });
