const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(2089,2165).map((l,i)=>(2090+i)+"| "+l).join("\n"));
console.log("TOTAL", L.length);
