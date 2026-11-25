const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(L.slice(600,700).map((l,i)=>(601+i)+"| "+l).join("\n"));
