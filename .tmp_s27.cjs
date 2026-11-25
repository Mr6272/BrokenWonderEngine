const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(1413,1434).map((l,i)=>(1414+i)+"| "+l).join("\n"));
console.log("=== imports head ===");
console.log(L.slice(0,30).map((l,i)=>(1+i)+"| "+l).join("\n"));
