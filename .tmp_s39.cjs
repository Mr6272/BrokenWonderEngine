const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(L.slice(879,936).map((l,i)=>(880+i)+"| "+l).join("\n"));
