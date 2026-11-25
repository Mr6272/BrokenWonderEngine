const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(1413,1434).map((l,i)=>(1414+i)+"| "+l).join("\n"));
console.log("########## packageWeb 2005-2147 ##########");
console.log(L.slice(2004,2147).map((l,i)=>(2005+i)+"| "+l).join("\n"));
