const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(L.slice(833,900).map((l,i)=>(834+i)+"| "+l).join("\n"));
