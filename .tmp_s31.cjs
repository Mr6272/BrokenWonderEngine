const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(2059,2140).map((l,i)=>(2060+i)+"| "+l).join("\n"));
