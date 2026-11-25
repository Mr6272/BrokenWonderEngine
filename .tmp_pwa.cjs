const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(2004,2090).map((l,i)=>(2005+i)+"| "+l).join("\n"));
