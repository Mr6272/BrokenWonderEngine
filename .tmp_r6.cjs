const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(L.slice(894,965).map((l,i)=>(895+i)+"| "+l).join("\n"));
