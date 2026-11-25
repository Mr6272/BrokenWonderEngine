const fs=require("fs");
const L=fs.readFileSync("web/tools/api-core.mjs","utf8").split(/\r?\n/);
console.log(L.slice(700,935).map((l,i)=>(701+i)+"| "+l).join("\n"));
