const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(1975,2062).map((l,i)=>(1976+i)+"| "+l).join("\n"));
