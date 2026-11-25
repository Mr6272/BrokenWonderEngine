const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(L.slice(779,880).map((l,i)=>(780+i)+"| "+l).join("\n"));
