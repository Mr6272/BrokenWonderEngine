const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log("### 1-40");
console.log(L.slice(0,40).map((l,i)=>(1+i)+"| "+l).join("\n"));
console.log("### 1405-1440");
console.log(L.slice(1404,1440).map((l,i)=>(1405+i)+"| "+l).join("\n"));
