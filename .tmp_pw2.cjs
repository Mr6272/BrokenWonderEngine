const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(2094,2160).map((l,i)=>(2095+i)+"| "+l).join("\n"));
