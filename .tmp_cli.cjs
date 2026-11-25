const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(1931,2005).map((l,i)=>(1932+i)+"| "+l).join("\n"));
