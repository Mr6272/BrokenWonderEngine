const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(L.slice(613,700).map((l,i)=>(614+i)+"| "+l).join("\n"));
