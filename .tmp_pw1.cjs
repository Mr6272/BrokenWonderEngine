const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(1999,2095).map((l,i)=>(2000+i)+"| "+l).join("\n"));
