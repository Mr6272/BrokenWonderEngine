const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(1994,2060).map((l,i)=>(1995+i)+"| "+l).join("\n"));
