const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(L.slice(608,700).map((l,i)=>(609+i)+"| "+l).join("\n"));
