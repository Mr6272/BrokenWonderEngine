const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
L.forEach((l,i)=>{ if(/zip|Zip|Compress|tar\.|archiver/i.test(l)) console.log((i+1)+"| "+l.trim().slice(0,160)); });
console.log("=== imports ===");
console.log(L.slice(0,26).map((l,i)=>(1+i)+"| "+l).join("\n"));
