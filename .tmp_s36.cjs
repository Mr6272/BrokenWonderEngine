const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(1395,1435).map((l,i)=>(1396+i)+"| "+l).join("\n"));
console.log("=== 1..30 ===");
console.log(L.slice(0,30).map((l,i)=>(1+i)+"| "+l).join("\n"));
