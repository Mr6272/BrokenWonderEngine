const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(2139,2175).map((l,i)=>(2140+i)+"| "+l).join("\n"));
console.log("TOTAL LINES", L.length);
