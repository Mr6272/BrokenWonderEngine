const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(L.slice(899,960).map((l,i)=>(900+i)+"| "+l).join("\n"));
