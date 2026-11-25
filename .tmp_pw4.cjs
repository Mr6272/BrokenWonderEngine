const fs=require("fs");
const L=fs.readFileSync("web/tools/package-bwe.mjs","utf8").split(/\r?\n/);
console.log(L.slice(2123,2174).map((l,i)=>(2124+i)+"| "+l).join("\n"));
