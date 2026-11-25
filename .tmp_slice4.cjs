const fs=require("fs");
const lines=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log("--- 1..40 ---");
console.log(lines.slice(0,40).map((l,i)=>(1+i)+"| "+l).join("\n"));
console.log("--- 1405..1435 ---");
console.log(lines.slice(1404,1435).map((l,i)=>(1405+i)+"| "+l).join("\n"));
