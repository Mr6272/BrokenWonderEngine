const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(L.slice(934,1010).map((l,i)=>(935+i)+"| "+l).join("\n"));
